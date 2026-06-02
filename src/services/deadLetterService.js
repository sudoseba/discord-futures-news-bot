/**
 * Dead-letter post queue.
 *
 * If Discord 5xxs / rate-limits / a webhook is temporarily unavailable,
 * the failed post is parked in `pending_posts` and retried on the
 * deadletter cron with exponential backoff. After MAX_ATTEMPTS the row
 * is marked failed and dropped from the queue.
 */
const { getDb } = require('./database');
const log = require('../utils/logger').child('deadletter');

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000; // 1 min, doubles each retry

const stmts = {};
function s(name, sql) {
    if (!stmts[name]) stmts[name] = getDb().prepare(sql);
    return stmts[name];
}

/**
 * Park a failed post for later retry.
 * payload must already be JSON-serialisable (no Buffers, no functions).
 */
function enqueue(channelId, payload, reason = '') {
    try {
        const now = Date.now();
        s('insert', `INSERT INTO pending_posts
              (channel_id, payload_json, attempts, next_retry_at, last_error, created_at)
              VALUES (?, ?, 0, ?, ?, ?)`)
            .run(channelId, JSON.stringify(payload), now + BASE_BACKOFF_MS, reason, now);
        log.warn({ channelId, reason }, 'post enqueued to dead-letter');
    } catch (err) {
        log.error({ err: err.message }, 'dead-letter enqueue itself failed');
    }
}

function due() {
    try {
        return s('due', `SELECT id, channel_id, payload_json, attempts, last_error
                          FROM pending_posts
                          WHERE next_retry_at <= ?
                          ORDER BY next_retry_at ASC
                          LIMIT 25`).all(Date.now());
    } catch { return []; }
}

function markRetried(id, success, errorMsg) {
    try {
        if (success) {
            s('done', `DELETE FROM pending_posts WHERE id = ?`).run(id);
            log.info({ id }, 'dead-letter delivered');
            return;
        }
        const row = s('row', `SELECT attempts FROM pending_posts WHERE id = ?`).get(id);
        const attempts = (row?.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
            s('giveup', `DELETE FROM pending_posts WHERE id = ?`).run(id);
            log.error({ id, attempts, error: errorMsg }, 'dead-letter giving up after max attempts');
            return;
        }
        const backoff = BASE_BACKOFF_MS * 2 ** attempts;
        s('reschedule', `UPDATE pending_posts
                          SET attempts = ?, next_retry_at = ?, last_error = ?
                          WHERE id = ?`)
            .run(attempts, Date.now() + backoff, errorMsg || 'unknown', id);
    } catch (err) {
        log.error({ id, err: err.message }, 'dead-letter retry bookkeeping failed');
    }
}

function size() {
    try { return s('count', `SELECT COUNT(*) as n FROM pending_posts`).get().n; }
    catch { return 0; }
}

/**
 * Attempt to drain the queue. Caller provides a `sendFn(channelId, payload)`
 * that returns a Promise. We swallow errors (it's the whole point of a DLQ).
 */
async function drain(sendFn) {
    const batch = due();
    if (batch.length === 0) return 0;
    let delivered = 0;
    for (const row of batch) {
        let payload;
        try { payload = JSON.parse(row.payload_json); }
        catch { markRetried(row.id, false, 'payload corrupt'); continue; }
        try {
            await sendFn(row.channel_id, payload);
            markRetried(row.id, true);
            delivered++;
        } catch (err) {
            markRetried(row.id, false, err?.message || String(err));
        }
    }
    if (delivered > 0) log.info({ delivered, batchSize: batch.length }, 'dead-letter batch drained');
    return delivered;
}

module.exports = { enqueue, due, markRetried, size, drain, MAX_ATTEMPTS };
