const cron = require('node-cron');
const log = require('./logger').child('cron');

/**
 * Wrapper around node-cron that:
 *   • Forces every job to declare a timezone so cron expressions in the
 *     codebase are unambiguous, regardless of the host's TZ.
 *   • Stores task refs so they can be cleanly stopped on SIGTERM.
 *   • Wraps the callback in try/catch so one throwing job never tears down
 *     the others, and surfaces failures through the structured logger.
 *   • Suppresses re-entrancy: if a previous tick is still in flight, the new
 *     tick is skipped (logged) instead of running concurrently.
 */
const tasks = new Map();
const inFlight = new Map();

function schedule(name, expression, handler, options = {}) {
    if (!expression) {
        log.warn({ job: name }, 'cron expression is empty; skipping registration');
        return null;
    }
    if (!cron.validate(expression)) {
        log.error({ job: name, expression }, 'invalid cron expression; skipping');
        return null;
    }

    const timezone = options.timezone || process.env.SCHEDULE_TIMEZONE || 'America/New_York';

    const wrapped = async () => {
        if (inFlight.get(name)) {
            log.warn({ job: name }, 'previous tick still running; skipping this tick');
            return;
        }
        inFlight.set(name, true);
        const t0 = Date.now();
        try {
            await handler();
            log.info({ job: name, durationMs: Date.now() - t0 }, 'cron tick complete');
        } catch (err) {
            log.error({ job: name, err: err?.message, stack: err?.stack }, 'cron handler threw');
        } finally {
            inFlight.set(name, false);
        }
    };

    const task = cron.schedule(expression, wrapped, { timezone, scheduled: true });
    tasks.set(name, task);
    log.info({ job: name, expression, timezone }, 'cron scheduled');
    return task;
}

/** Stop every registered task. Used on graceful shutdown. */
async function stopAll() {
    for (const [name, task] of tasks.entries()) {
        try {
            task.stop();
            log.info({ job: name }, 'cron stopped');
        } catch (err) {
            log.warn({ job: name, err: err?.message }, 'failed to stop cron');
        }
    }
    // Wait briefly for any in-flight ticks to wrap up
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && [...inFlight.values()].some(Boolean)) {
        await new Promise(r => setTimeout(r, 100));
    }
    tasks.clear();
    inFlight.clear();
}

function list() {
    return [...tasks.keys()];
}

function isRunning(name) {
    return !!inFlight.get(name);
}

module.exports = { schedule, stopAll, list, isRunning };
