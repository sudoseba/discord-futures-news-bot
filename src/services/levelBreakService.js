/**
 * Level-Break Detector
 *
 * Periodically checks each watchlist symbol's current price against the most
 * recent set of LLM-annotated support/resistance levels (from /levels output
 * cached in the `llm_outputs` table) and emits an alert when price crosses a
 * level from below→above (resistance break) or above→below (support break).
 *
 * State per (symbol, level_price) is persisted so each transition fires at
 * most once. Crossing the same level multiple times within one cooldown window
 * is suppressed.
 */
const { getDb } = require('./database');
const config = require('../config');
const { fetchQuote } = require('./marketDataService');
const { detectLevels } = require('./technicalAnalysisService');
const { fetchCandles } = require('./marketDataService');
const cooldownStore = require('./cooldownStore');
const scorecard = require('./scorecardService');
const log = require('../utils/logger').child('level-break');

const PROXIMITY_PCT = 0.15;        // Only consider levels within 5% of price
const COOLDOWN_MS = 6 * 60 * 60_000; // 6h per (symbol, levelPrice, direction)

function getState(symbol, level) {
    return getDb().prepare(
        `SELECT last_side FROM level_break_state WHERE symbol = ? AND level_price = ?`
    ).get(symbol, level);
}

function setState(symbol, level, label, side) {
    getDb().prepare(`INSERT INTO level_break_state
          (symbol, level_price, level_label, last_side, last_break_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, level_price) DO UPDATE SET
              last_side = excluded.last_side,
              level_label = excluded.level_label,
              last_break_at = excluded.last_break_at,
              updated_at = excluded.updated_at`)
        .run(symbol, level, label || null, side, Date.now(), Date.now());
}

function loadLevelsFor(symbol, name) {
    // Pull the most recent /levels run for this symbol. The LLM service stores
    // it under output_type='levels', symbol=<name>. Fall back to algorithmic
    // levels when no recent annotated set exists.
    const row = getDb().prepare(`SELECT content, recorded_at FROM llm_outputs
         WHERE output_type = 'levels' AND symbol = ?
         ORDER BY recorded_at DESC LIMIT 1`).get(name);
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.content);
        const recordedAt = Date.parse(row.recorded_at + (row.recorded_at.endsWith('Z') ? '' : 'Z'));
        return { ...parsed, recordedAt };
    } catch {
        return null;
    }
}

async function scanSymbol(symbol, meta) {
    let cached = loadLevelsFor(symbol, meta.name);
    let resistances = cached?.resistances || [];
    let supports = cached?.supports || [];

    // If no cached LLM levels exist, fall back to a fresh algorithmic pass so
    // we still emit alerts on day one before any /levels command has run.
    if (resistances.length === 0 && supports.length === 0) {
        const candles = await fetchCandles(symbol, 'D', 90).catch(() => null);
        if (!candles?.close?.length) return [];
        const algo = detectLevels(candles);
        if (!algo) return [];
        resistances = algo.resistances.slice(0, 3);
        supports = algo.supports.slice(0, 3);
    }

    const quote = await fetchQuote(symbol).catch(() => null);
    if (!quote?.current) return [];
    const price = quote.current;

    const events = [];

    for (const level of resistances) {
        if (!Number.isFinite(level.price)) continue;
        if (Math.abs(price - level.price) / level.price > PROXIMITY_PCT) continue;
        const side = price >= level.price ? 'above' : 'below';
        const last = getState(symbol, level.price);
        const prevSide = last?.last_side;
        setState(symbol, level.price, level.label, side);
        if (prevSide === 'below' && side === 'above') {
            const key = `levelbreak:${symbol}:R:${level.price.toFixed(2)}`;
            if (cooldownStore.isOnCooldown(key)) continue;
            cooldownStore.setCooldown(key, COOLDOWN_MS);
            events.push({
                type: 'resistance_break',
                direction: 'bullish',
                symbol, meta, price,
                level: level.price,
                label: level.label,
                methods: level.methods,
                note: level.note,
            });
        }
    }

    for (const level of supports) {
        if (!Number.isFinite(level.price)) continue;
        if (Math.abs(price - level.price) / level.price > PROXIMITY_PCT) continue;
        const side = price >= level.price ? 'above' : 'below';
        const last = getState(symbol, level.price);
        const prevSide = last?.last_side;
        setState(symbol, level.price, level.label, side);
        if (prevSide === 'above' && side === 'below') {
            const key = `levelbreak:${symbol}:S:${level.price.toFixed(2)}`;
            if (cooldownStore.isOnCooldown(key)) continue;
            cooldownStore.setCooldown(key, COOLDOWN_MS);
            events.push({
                type: 'support_break',
                direction: 'bearish',
                symbol, meta, price,
                level: level.price,
                label: level.label,
                methods: level.methods,
                note: level.note,
            });
        }
    }

    return events;
}

/**
 * Run one detection cycle across the entire watchlist.
 * Returns the collected break events; callers handle posting / DMing.
 */
async function runCycle() {
    const all = [];
    for (const [symbol, meta] of Object.entries(config.watchlist)) {
        try {
            const events = await scanSymbol(symbol, meta);
            all.push(...events);
        } catch (err) {
            log.warn({ symbol, err: err.message }, 'scan failed for symbol');
        }
    }
    // Capture into scorecard so we measure level-break edge over time
    for (const ev of all) {
        scorecard.captureSignal({
            signalType: 'level_break',
            direction: ev.direction,
            symbol: ev.symbol,
            capturedPrice: ev.price,
            snapshot: { level: ev.level, label: ev.label, type: ev.type },
        });
    }
    if (all.length > 0) log.info({ count: all.length }, 'level break events detected');
    return all;
}

module.exports = { runCycle, scanSymbol };
