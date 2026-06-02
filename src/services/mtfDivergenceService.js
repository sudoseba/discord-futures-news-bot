/**
 * Multi-Timeframe Divergence Detector
 *
 * Runs RSI-divergence detection on Daily and Weekly candles concurrently.
 * Emits an alert only when both timeframes show the same direction divergence
 * (or weekly alone for high-conviction setups). Dramatically reduces the
 * false-positive rate vs. single-timeframe divergence alerts.
 */
const config = require('../config');
const { fetchCandles, fetchWeeklyCandles, fetchQuote } = require('./marketDataService');
const { analyze } = require('./technicalAnalysisService');
const cooldownStore = require('./cooldownStore');
const scorecard = require('./scorecardService');
const log = require('../utils/logger').child('mtf-div');

const COOLDOWN_MS = 24 * 60 * 60_000; // 24h per (symbol, direction)
const MIN_DAILY_STRENGTH = 4;
const MIN_WEEKLY_STRENGTH = 3;

async function analyseSymbol(symbol, meta) {
    const [daily, weekly, quote] = await Promise.all([
        fetchCandles(symbol, 'D', 90).catch(() => null),
        fetchWeeklyCandles(symbol, 52).catch(() => null),
        fetchQuote(symbol).catch(() => null),
    ]);

    if (!daily?.close?.length || !weekly?.close?.length) return null;
    if (!quote?.current) return null;

    const daily_ta = analyze(daily);
    const weekly_ta = analyze(weekly);

    const d = daily_ta.divergence;
    const w = weekly_ta.divergence;
    if (d.type === 'none' && w.type === 'none') return null;

    // Confluence: same direction on both timeframes (highest conviction)
    if (d.type !== 'none' && w.type !== 'none' && d.type === w.type
        && d.strength >= MIN_DAILY_STRENGTH && w.strength >= MIN_WEEKLY_STRENGTH) {
        return {
            symbol, meta, direction: d.type,
            tier: 'confluence',
            daily: d, weekly: w,
            quote,
        };
    }
    // Weekly-only is still high-conviction
    if (w.type !== 'none' && w.strength >= MIN_WEEKLY_STRENGTH + 1) {
        return {
            symbol, meta, direction: w.type,
            tier: 'weekly',
            daily: d, weekly: w,
            quote,
        };
    }
    return null;
}

async function runCycle() {
    const events = [];
    for (const [symbol, meta] of Object.entries(config.watchlist)) {
        try {
            const ev = await analyseSymbol(symbol, meta);
            if (!ev) continue;
            const key = `mtf_div:${symbol}:${ev.direction}:${ev.tier}`;
            if (cooldownStore.isOnCooldown(key)) continue;
            cooldownStore.setCooldown(key, COOLDOWN_MS);

            scorecard.captureSignal({
                signalType: 'divergence',
                direction: ev.direction,
                symbol,
                capturedPrice: ev.quote.current,
                snapshot: {
                    tier: ev.tier,
                    dailyStrength: ev.daily.strength,
                    weeklyStrength: ev.weekly.strength,
                },
            });

            events.push(ev);
        } catch (err) {
            log.warn({ symbol, err: err.message }, 'analyseSymbol failed');
        }
    }
    if (events.length > 0) log.info({ count: events.length }, 'MTF divergences detected');
    return events;
}

module.exports = { runCycle, analyseSymbol };
