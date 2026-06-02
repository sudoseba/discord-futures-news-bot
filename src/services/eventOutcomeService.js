/**
 * Economic Event Outcome Interpreter
 *
 * After each high-impact economic event, when the `actual` value lands, this
 * service notices the new actual, asks the LLM for a one-paragraph "what it
 * means for DXY / Gold / Crude / BTC" interpretation, and emits an alert.
 *
 * Discovery: it polls the calendar feed (already cached) and compares each
 * known event's stored `actual` against the latest. The first time we see a
 * non-empty actual on an event, that's the trigger.
 */
const { getDb } = require('./database');
const { fetchFullCalendar } = require('./macroService');
const cooldownStore = require('./cooldownStore');
const log = require('../utils/logger').child('event-outcome');

let cerebrasClient = null;
function getLlm() {
    if (!cerebrasClient) {
        const Cerebras = require('@cerebras/cerebras_cloud_sdk');
        const config = require('../config');
        if (!config.cerebrasApiKey) return null;
        cerebrasClient = new Cerebras({ apiKey: config.cerebrasApiKey });
    }
    return cerebrasClient;
}

const COOLDOWN_MS = 6 * 60 * 60_000;

function eventKey(event) {
    return `event_outcome:${event.event_date || event.date}:${(event.event_name || event.event || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

async function generateInterp(event) {
    const llm = getLlm();
    if (!llm) return null;
    const config = require('../config');

    const data = [
        `Event: ${event.event_name || event.event}`,
        `Date: ${event.event_date || event.date} ${event.event_time || event.time || ''}`,
        `Forecast: ${event.forecast || event.estimate || 'n/a'}`,
        `Previous: ${event.previous || event.prev || 'n/a'}`,
        `Actual: ${event.actual}`,
    ].join('\n');

    const prompt = `A US economic data release just printed. Tell our desk what it means.

${data}

Write ONE short paragraph (60-100 words) covering:
- Is this a beat, a miss, or in-line vs. expectations?
- Direction implication for each: DXY, 10Y yield, Gold, Crude, BTC.
- One specific level or follow-on data point to watch.

Plain trader English. No bullet lists. No markdown.`;

    try {
        const completion = await llm.chat.completions.create({
            model: config.cerebrasModel,
            messages: [
                { role: 'system', content: 'You are a sell-side macro desk strategist briefing the floor. Be concise and concrete.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 280,
        });
        return completion.choices[0]?.message?.content?.trim() || null;
    } catch (err) {
        log.warn({ err: err.message, event: event.event_name || event.event }, 'llm interp failed');
        return null;
    }
}

/**
 * Scan upcoming/recent events; emit interps for newly-observed actuals.
 */
async function runCycle() {
    let calendar;
    try {
        calendar = await fetchFullCalendar();
    } catch (err) {
        log.warn({ err: err.message }, 'calendar fetch failed');
        return [];
    }
    if (!Array.isArray(calendar) || calendar.length === 0) return [];

    const dbi = getDb();
    const events = [];

    for (const ev of calendar) {
        const name = ev.event;
        const date = ev.date;
        const impact = ev.impact;
        const actual = ev.actual;
        if (!name || !date || !actual) continue;
        if (impact !== 'high') continue;

        // Has DB seen this actual already?
        const stored = dbi.prepare(`SELECT actual FROM economic_events
             WHERE event_name = ? AND event_date = ?`).get(name, date);
        const alreadyKnown = stored?.actual === actual;
        // Upsert regardless so we don't keep reinterpreting on each tick
        dbi.prepare(`INSERT INTO economic_events
              (event_name, event_date, event_time, impact, forecast, previous, actual, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(event_name, event_date) DO UPDATE SET
                  actual = excluded.actual,
                  forecast = COALESCE(excluded.forecast, economic_events.forecast),
                  previous = COALESCE(excluded.previous, economic_events.previous),
                  event_time = COALESCE(excluded.event_time, economic_events.event_time)`)
            .run(name, date, ev.time || 'TBD', impact, ev.forecast || null, ev.previous || ev.prev || null, actual, ev.source || 'unknown');

        if (alreadyKnown) continue;

        const key = eventKey({ event_name: name, event_date: date });
        if (cooldownStore.isOnCooldown(key)) continue;
        cooldownStore.setCooldown(key, COOLDOWN_MS);

        const interp = await generateInterp({
            event_name: name, event_date: date, event_time: ev.time,
            forecast: ev.forecast, previous: ev.previous || ev.prev, actual,
        });

        events.push({ name, date, time: ev.time, forecast: ev.forecast, previous: ev.previous || ev.prev, actual, interp });
    }

    if (events.length > 0) log.info({ count: events.length }, 'event outcomes interpreted');
    return events;
}

module.exports = { runCycle };
