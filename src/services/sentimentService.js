const axios = require('axios');
const Cache = require('../utils/cache');
const withFallback = require('../utils/withFallback');
const providers = require('./providers');

const cache = new Cache(300_000); // 5 min TTL for sentiment data

// ─── Crypto Fear & Greed Index (alternative.me — free, no key) ────────────

/**
 * Fetch the Crypto Fear & Greed Index.
 * @returns {Promise<{value: number, label: string, timestamp: number}|null>}
 */
async function fetchFearGreedIndex() {
    return withFallback({
        cache,
        key: 'sentiment:fear_greed',
        ttl: 300_000,
        providers: [{
            name: 'alternativeme',
            run: async () => {
                const { data } = await axios.get('https://api.alternative.me/fng/', { params: { limit: 1 }, timeout: 5000 });
                if (!data?.data?.[0]) return null;
                const entry = data.data[0];
                return { value: parseInt(entry.value), label: entry.value_classification, timestamp: parseInt(entry.timestamp) };
            },
        }],
    });
}

/**
 * Get the emoji for a Fear & Greed value.
 */
function getFearGreedEmoji(value) {
    if (value <= 20) return '😱'; // Extreme Fear
    if (value <= 40) return '😰'; // Fear
    if (value <= 60) return '😐'; // Neutral
    if (value <= 80) return '😏'; // Greed
    return '🤑';                   // Extreme Greed
}

/**
 * Build a visual gauge bar for Fear & Greed.
 */
function buildFearGreedBar(value) {
    const length = 20;
    // Clamp position into [0, length-1] so value=100 doesn't write past the bar.
    const clamped = Math.max(0, Math.min(100, value || 0));
    const position = Math.min(length - 1, Math.round((clamped / 100) * (length - 1)));
    let bar = '';
    for (let i = 0; i < length; i++) {
        if (i === position) bar += '◆';
        else if (i < 5) bar += '░'; // extreme fear zone
        else if (i < 10) bar += '▒'; // fear zone
        else if (i < 15) bar += '▓'; // greed zone
        else bar += '█'; // extreme greed zone
    }
    return `\`${bar}\``;
}

// ─── Binance Funding Rates (free, public, no key) ─────────────────────────

const FUNDING_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

/**
 * Fetch current funding rates from Binance Futures.
 * @returns {Promise<Array<{symbol: string, rate: number, ratePercent: string, nextFunding: number}>>}
 */
async function fetchFundingRates() {
    const results = [];
    for (const symbol of FUNDING_SYMBOLS) {
        const f = await fundingForSymbol(symbol);
        if (f) results.push(f);
    }
    return results;
}

/** Per-symbol funding with a non-Binance fallback (Bybit) + last-good. */
function fundingForSymbol(symbol) {
    return withFallback({
        cache,
        key: `funding:${symbol}`,
        ttl: 300_000,
        providers: [
            { name: 'binance', run: () => binanceFunding('https://fapi.binance.com', symbol) },
            { name: 'binanceus', run: () => binanceFunding('https://fapi.binanceus.com', symbol) },
            { name: 'bybit', run: () => providers.bybitFunding(symbol) },
        ],
    });
}

async function binanceFunding(base, symbol) {
    const { data } = await axios.get(`${base}/fapi/v1/fundingRate`, { params: { symbol, limit: 1 }, timeout: 5000 });
    if (!data?.[0]) return null;
    const rate = parseFloat(data[0].fundingRate);
    if (!Number.isFinite(rate)) return null;
    return { symbol, rate, ratePercent: (rate * 100).toFixed(4) + '%', fundingTime: data[0].fundingTime };
}

/**
 * Interpret a funding rate for display.
 */
function interpretFundingRate(rate) {
    if (rate > 0.001) return '🔴 Longs paying heavy — crowded long, squeeze risk';
    if (rate > 0.0003) return '🟡 Longs paying — mild bullish lean';
    if (rate > -0.0003) return '⚪ Neutral positioning';
    if (rate > -0.001) return '🟡 Shorts paying — mild bearish lean';
    return '🟢 Shorts paying heavy — crowded short, squeeze risk';
}

module.exports = {
    fetchFearGreedIndex,
    getFearGreedEmoji,
    buildFearGreedBar,
    fetchFundingRates,
    interpretFundingRate,
};
