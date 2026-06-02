/**
 * Funding-Rate Flip Detector
 *
 * Funding rate sign flips (negative → positive or vice versa) are a classical
 * positioning-extremes reversal signal: when crowded shorts get paid and
 * suddenly flip to crowded longs paying, the prior trend tends to exhaust.
 *
 * State per symbol is persisted so we only emit on transitions.
 */
const { getDb } = require('./database');
const { fetchFundingRates } = require('./sentimentService');
const cooldownStore = require('./cooldownStore');
const scorecard = require('./scorecardService');
const { fetchQuote } = require('./marketDataService');
const log = require('../utils/logger').child('funding-flip');

const COOLDOWN_MS = 12 * 60 * 60_000; // 12h between flip alerts per symbol
const FLIP_MAGNITUDE = 0.00005;        // ignore micro-flips around zero (< 0.005%)

const SYMBOL_TO_WATCHLIST = {
    BTCUSDT: 'BINANCE:BTCUSDT',
    ETHUSDT: 'BINANCE:ETHUSDT',
};

function getState(symbol) {
    return getDb().prepare(`SELECT last_sign, last_rate, last_flip_at FROM funding_flip_state WHERE symbol = ?`).get(symbol);
}

function setState(symbol, sign, rate, flipped) {
    const now = Date.now();
    getDb().prepare(`INSERT INTO funding_flip_state (symbol, last_sign, last_rate, last_flip_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(symbol) DO UPDATE SET
              last_sign = excluded.last_sign,
              last_rate = excluded.last_rate,
              last_flip_at = COALESCE(excluded.last_flip_at, funding_flip_state.last_flip_at),
              updated_at = excluded.updated_at`)
        .run(symbol, sign, rate, flipped ? now : null, now);
}

function signOf(rate) {
    if (rate > FLIP_MAGNITUDE) return 1;
    if (rate < -FLIP_MAGNITUDE) return -1;
    return 0;
}

async function runCycle() {
    let rates = [];
    try {
        rates = await fetchFundingRates();
    } catch (err) {
        log.warn({ err: err.message }, 'funding fetch failed');
        return [];
    }
    if (!Array.isArray(rates) || rates.length === 0) return [];

    const events = [];

    for (const r of rates) {
        const sign = signOf(r.rate);
        const prev = getState(r.symbol);
        const prevSign = prev?.last_sign ?? sign;
        const flipped = prevSign !== 0 && sign !== 0 && Math.sign(prevSign) !== Math.sign(sign);
        setState(r.symbol, sign, r.rate, flipped);

        if (!flipped) continue;

        const key = `funding_flip:${r.symbol}:${sign > 0 ? 'up' : 'down'}`;
        if (cooldownStore.isOnCooldown(key)) continue;
        cooldownStore.setCooldown(key, COOLDOWN_MS);

        // Bullish for the spot asset when funding flips negative (shorts paying),
        // because crowded shorts often unwind into a squeeze.
        const direction = sign < 0 ? 'bullish' : 'bearish';
        const watchlistSym = SYMBOL_TO_WATCHLIST[r.symbol];
        let capturedPrice = null;
        try {
            if (watchlistSym) {
                const q = await fetchQuote(watchlistSym);
                capturedPrice = q?.current ?? null;
            }
        } catch { /* ignore */ }

        if (capturedPrice) {
            scorecard.captureSignal({
                signalType: 'funding_flip',
                direction,
                symbol: watchlistSym,
                capturedPrice,
                snapshot: { rate: r.rate, prevSign, newSign: sign },
            });
        }

        events.push({
            type: 'funding_flip',
            symbol: r.symbol,
            direction,
            rate: r.rate,
            ratePercent: r.ratePercent,
            prevSign, newSign: sign,
        });
    }

    if (events.length > 0) log.info({ count: events.length }, 'funding flips detected');
    return events;
}

module.exports = { runCycle };
