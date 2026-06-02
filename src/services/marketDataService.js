const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const config = require('../config');
const Cache = require('../utils/cache');
const { finnhubLimiter } = require('../utils/rateLimiter');

const cache = new Cache(60_000); // 1 min TTL for market data
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const BINANCE_BASE = 'https://api.binance.us/api/v3'; // US endpoint to avoid geo-block
const STOOQ_BASE = 'https://stooq.com/q/d/l/';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

// ─── Yahoo Finance symbols for each watchlist item ────────────────────────
const YAHOO_SYMBOLS = {
    'OANDA:WTICO_USD': 'CL=F',       // WTI Crude Oil Futures
    'OANDA:BRENT_USD': 'BZ=F',       // Brent Crude Futures
    'OANDA:NATGAS_USD': 'NG=F',       // Natural Gas Futures
    'OANDA:XAU_USD': 'GC=F',       // Gold Futures
    'OANDA:XAG_USD': 'SI=F',       // Silver Futures
    'OANDA:XCU_USD': 'HG=F',       // Copper Futures
    'BINANCE:BTCUSDT': 'BTC-USD',    // Bitcoin
    'BINANCE:ETHUSDT': 'ETH-USD',    // Ethereum
    'OANDA:EUR_USD': 'EURUSD=X',   // EUR/USD
    'OANDA:GBP_USD': 'GBPUSD=X',   // GBP/USD
    'OANDA:USD_JPY': 'JPY=X',      // USD/JPY
};

// Stooq symbols (free CSV API, no key — the most reliable free futures source)
const STOOQ_SYMBOLS = {
    'OANDA:WTICO_USD': 'CL.F',   // WTI Crude futures
    'OANDA:BRENT_USD': 'LCO.F',  // Brent Crude futures (ICE)
    'OANDA:NATGAS_USD': 'NG.F',  // Natural Gas futures
    'OANDA:XAU_USD': 'GC.F',     // Gold futures (COMEX)
    'OANDA:XAG_USD': 'SI.F',     // Silver futures
    'OANDA:XCU_USD': 'HG.F',     // Copper futures
    'OANDA:EUR_USD': 'EURUSD',   // EUR/USD spot
    'OANDA:GBP_USD': 'GBPUSD',   // GBP/USD spot
    'OANDA:USD_JPY': 'USDJPY',   // USD/JPY spot
};

// CoinGecko IDs (free API, no key — great for crypto OHLCV)
const COINGECKO_IDS = {
    'BINANCE:BTCUSDT': 'bitcoin',
    'BINANCE:ETHUSDT': 'ethereum',
};

// Alpha Vantage forex pairs (key exists — used for weekly candle validation)
const ALPHA_VANTAGE_FOREX = {
    'OANDA:EUR_USD': { from: 'EUR', to: 'USD' },
    'OANDA:GBP_USD': { from: 'GBP', to: 'USD' },
    'OANDA:USD_JPY': { from: 'USD', to: 'JPY' },
};

// Alpha Vantage crypto IDs
const ALPHA_VANTAGE_CRYPTO = {
    'BINANCE:BTCUSDT': 'BTC',
    'BINANCE:ETHUSDT': 'ETH',
};

// Binance symbol mappings (no API key needed)
const BINANCE_SYMBOLS = {
    'BINANCE:BTCUSDT': 'BTCUSDT',
    'BINANCE:ETHUSDT': 'ETHUSDT',
};

// ─── Source 1: Yahoo Finance (no key, daily) ──────────────────────────────

async function fetchCandlesYahoo(symbol, days = 90) {
    const yahooSymbol = YAHOO_SYMBOLS[symbol];
    if (!yahooSymbol) return null;

    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const result = await yahooFinance.chart(yahooSymbol, {
            period1: startDate,
            period2: endDate,
            interval: '1d',
        });

        if (!result?.quotes || result.quotes.length === 0) return null;

        const quotes = result.quotes.filter(q => q.close != null);

        return {
            open: quotes.map(q => q.open),
            high: quotes.map(q => q.high),
            low: quotes.map(q => q.low),
            close: quotes.map(q => q.close),
            volume: quotes.map(q => q.volume || 0),
            timestamp: quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000)),
        };
    } catch (err) {
        console.error(`[Yahoo] Candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

async function fetchQuoteYahoo(symbol) {
    const yahooSymbol = YAHOO_SYMBOLS[symbol];
    if (!yahooSymbol) return null;

    try {
        const result = await yahooFinance.quote(yahooSymbol);
        if (!result || !result.regularMarketPrice) return null;

        return {
            current: result.regularMarketPrice,
            high: result.regularMarketDayHigh,
            low: result.regularMarketDayLow,
            open: result.regularMarketOpen,
            prevClose: result.regularMarketPreviousClose,
            change: result.regularMarketChange,
            changePercent: result.regularMarketChangePercent,
        };
    } catch (err) {
        console.error(`[Yahoo] Quote fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

/** Fetch WEEKLY candles from Yahoo (1y lookback for weekly confluence) */
async function fetchWeeklyCandlesYahoo(symbol, weeks = 52) {
    const yahooSymbol = YAHOO_SYMBOLS[symbol];
    if (!yahooSymbol) return null;

    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - weeks * 7);

        const result = await yahooFinance.chart(yahooSymbol, {
            period1: startDate,
            period2: endDate,
            interval: '1wk',
        });

        if (!result?.quotes || result.quotes.length === 0) return null;
        const quotes = result.quotes.filter(q => q.close != null);

        return {
            open: quotes.map(q => q.open),
            high: quotes.map(q => q.high),
            low: quotes.map(q => q.low),
            close: quotes.map(q => q.close),
            volume: quotes.map(q => q.volume || 0),
            timestamp: quotes.map(q => Math.floor(new Date(q.date).getTime() / 1000)),
        };
    } catch (err) {
        console.error(`[Yahoo] Weekly candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Source 2: Stooq.com (no key, free, best for futures CSV) ─────────────

/**
 * Fetch OHLCV from Stooq.com — free daily CSV, no API key required.
 * Covers futures (GC.F, CL.F, NG.F, etc.) and forex.
 */
async function fetchCandlesStooq(symbol, days = 90) {
    const stooqSymbol = STOOQ_SYMBOLS[symbol];
    if (!stooqSymbol) return null;

    try {
        const to = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0].replace(/-/g, '');

        const { data } = await axios.get(STOOQ_BASE, {
            params: { s: stooqSymbol.toLowerCase(), i: 'd', d1: from, d2: to },
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/1.0)' },
            timeout: 10_000,
            responseType: 'text',
        });

        if (!data || data.includes('No data') || data.length < 50) return null;

        const lines = data.trim().split('\n').slice(1); // Skip header
        if (lines.length === 0) return null;

        const open = [], high = [], low = [], close = [], volume = [], timestamp = [];

        for (const line of lines) {
            const [date, o, h, l, c, v] = line.split(',');
            if (!date || !c || c.trim() === '') continue;
            const ts = Math.floor(new Date(date.trim()).getTime() / 1000);
            if (isNaN(ts)) continue;
            open.push(parseFloat(o));
            high.push(parseFloat(h));
            low.push(parseFloat(l));
            close.push(parseFloat(c));
            volume.push(v ? parseFloat(v) : 0);
            timestamp.push(ts);
        }

        if (close.length < 10) return null;

        console.log(`[Stooq] ✅ ${symbol} (${stooqSymbol}): ${close.length} candles`);
        return { open, high, low, close, volume, timestamp };
    } catch (err) {
        console.error(`[Stooq] Candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

/** Fetch WEEKLY candles from Stooq (&i=w) */
async function fetchWeeklyCandlesStooq(symbol, weeks = 52) {
    const stooqSymbol = STOOQ_SYMBOLS[symbol];
    if (!stooqSymbol) return null;

    try {
        const to = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const from = new Date(Date.now() - weeks * 7 * 86400000).toISOString().split('T')[0].replace(/-/g, '');

        const { data } = await axios.get(STOOQ_BASE, {
            params: { s: stooqSymbol.toLowerCase(), i: 'w', d1: from, d2: to },
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/1.0)' },
            timeout: 10_000,
            responseType: 'text',
        });

        if (!data || data.includes('No data') || data.length < 50) return null;
        const lines = data.trim().split('\n').slice(1);
        if (lines.length === 0) return null;

        const open = [], high = [], low = [], close = [], volume = [], timestamp = [];
        for (const line of lines) {
            const [date, o, h, l, c, v] = line.split(',');
            if (!date || !c || c.trim() === '') continue;
            const ts = Math.floor(new Date(date.trim()).getTime() / 1000);
            if (isNaN(ts)) continue;
            open.push(parseFloat(o));
            high.push(parseFloat(h));
            low.push(parseFloat(l));
            close.push(parseFloat(c));
            volume.push(v ? parseFloat(v) : 0);
            timestamp.push(ts);
        }

        if (close.length < 10) return null;
        return { open, high, low, close, volume, timestamp };
    } catch (err) {
        console.error(`[Stooq] Weekly candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Source 3: CoinGecko (no key, free, crypto OHLCV) ─────────────────────

/**
 * Fetch OHLCV candles from CoinGecko (free, no API key).
 * Granularity: daily for >90 days, hourly for <90 days.
 */
async function fetchCandlesCoinGecko(symbol, days = 90) {
    const geckoId = COINGECKO_IDS[symbol];
    if (!geckoId) return null;

    try {
        // /coins/{id}/ohlc returns [timestamp, open, high, low, close]
        const { data } = await axios.get(`${COINGECKO_BASE}/coins/${geckoId}/ohlc`, {
            params: { vs_currency: 'usd', days: Math.min(days, 365) },
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/1.0)',
            },
            timeout: 12_000,
        });

        if (!Array.isArray(data) || data.length === 0) return null;

        const open = [], high = [], low = [], close = [], volume = [], timestamp = [];
        for (const [ts, o, h, l, c] of data) {
            timestamp.push(Math.floor(ts / 1000));
            open.push(o);
            high.push(h);
            low.push(l);
            close.push(c);
            volume.push(0); // OHLC endpoint doesn't include volume
        }

        // Also fetch volume from market_chart
        try {
            const { data: mc } = await axios.get(`${COINGECKO_BASE}/coins/${geckoId}/market_chart`, {
                params: { vs_currency: 'usd', days: Math.min(days, 365), interval: 'daily' },
                timeout: 10_000,
            });
            if (mc?.total_volumes) {
                mc.total_volumes.slice(-volume.length).forEach((v, i) => {
                    volume[i] = v[1] || 0;
                });
            }
        } catch { /* volume is optional */ }

        console.log(`[CoinGecko] ✅ ${symbol} (${geckoId}): ${close.length} candles`);
        return { open, high, low, close, volume, timestamp };
    } catch (err) {
        console.error(`[CoinGecko] Candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Source 4: Binance (no key, crypto only) ──────────────────────────────

async function fetchCandlesBinance(symbol, days = 90) {
    const binanceSymbol = BINANCE_SYMBOLS[symbol];
    if (!binanceSymbol) return null;

    try {
        const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
            params: {
                symbol: binanceSymbol,
                interval: '1d',
                limit: Math.min(days, 1000),
            },
        });

        if (!Array.isArray(data) || data.length === 0) return null;

        return {
            open: data.map(k => parseFloat(k[1])),
            high: data.map(k => parseFloat(k[2])),
            low: data.map(k => parseFloat(k[3])),
            close: data.map(k => parseFloat(k[4])),
            volume: data.map(k => parseFloat(k[5])),
            timestamp: data.map(k => Math.floor(k[0] / 1000)),
        };
    } catch (err) {
        console.error(`[Binance] Candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Source 5: Alpha Vantage weekly (key exists, for forex/crypto weekly) ─

/**
 * Fetch WEEKLY candles from Alpha Vantage — used to build weekly confluence levels.
 * Covers forex (FX_WEEKLY) and crypto (DIGITAL_CURRENCY_WEEKLY).
 */
async function fetchWeeklyCandlesAlphaVantage(symbol) {
    if (!config.alphaVantageKey) return null;

    try {
        // Forex pair
        if (ALPHA_VANTAGE_FOREX[symbol]) {
            const { from, to } = ALPHA_VANTAGE_FOREX[symbol];
            const { data } = await axios.get(ALPHA_VANTAGE_BASE, {
                params: {
                    function: 'FX_WEEKLY',
                    from_symbol: from,
                    to_symbol: to,
                    apikey: config.alphaVantageKey,
                },
                timeout: 12_000,
            });

            const series = data['Weekly Time Series FX'];
            if (!series) return null;

            const entries = Object.entries(series)
                .sort(([a], [b]) => new Date(a) - new Date(b))
                .slice(-52); // Last year

            return {
                open: entries.map(([, v]) => parseFloat(v['1. open'])),
                high: entries.map(([, v]) => parseFloat(v['2. high'])),
                low: entries.map(([, v]) => parseFloat(v['3. low'])),
                close: entries.map(([, v]) => parseFloat(v['4. close'])),
                volume: entries.map(() => 0),
                timestamp: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
            };
        }

        // Crypto
        if (ALPHA_VANTAGE_CRYPTO[symbol]) {
            const cryptoSymbol = ALPHA_VANTAGE_CRYPTO[symbol];
            const { data } = await axios.get(ALPHA_VANTAGE_BASE, {
                params: {
                    function: 'DIGITAL_CURRENCY_WEEKLY',
                    symbol: cryptoSymbol,
                    market: 'USD',
                    apikey: config.alphaVantageKey,
                },
                timeout: 12_000,
            });

            const series = data['Time Series (Digital Currency Weekly)'];
            if (!series) return null;

            const entries = Object.entries(series)
                .sort(([a], [b]) => new Date(a) - new Date(b))
                .slice(-52);

            return {
                open: entries.map(([, v]) => parseFloat(v['1a. open (USD)'])),
                high: entries.map(([, v]) => parseFloat(v['2a. high (USD)'])),
                low: entries.map(([, v]) => parseFloat(v['3a. low (USD)'])),
                close: entries.map(([, v]) => parseFloat(v['4a. close (USD)'])),
                volume: entries.map(([, v]) => parseFloat(v['5. volume'] || 0)),
                timestamp: entries.map(([d]) => Math.floor(new Date(d).getTime() / 1000)),
            };
        }

        return null;
    } catch (err) {
        console.error(`[AlphaVantage] Weekly candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Source 6: Finnhub (legacy fallback) ──────────────────────────────────

function getFinnhubCandleEndpoint(symbol) {
    if (symbol.startsWith('OANDA:')) return '/forex/candle';
    if (symbol.startsWith('BINANCE:')) return '/crypto/candle';
    return '/stock/candle';
}

async function fetchCandlesFinnhub(symbol, days = 90) {
    try {
        await finnhubLimiter.waitForToken();
        const to = Math.floor(Date.now() / 1000);
        const from = to - (days * 24 * 60 * 60);
        const endpoint = getFinnhubCandleEndpoint(symbol);

        const { data } = await axios.get(`${FINNHUB_BASE}${endpoint}`, {
            params: { symbol, resolution: 'D', from, to, token: config.finnhubKey },
        });

        if (data.s === 'no_data' || !data.c) return null;

        return {
            open: data.o,
            high: data.h,
            low: data.l,
            close: data.c,
            volume: data.v,
            timestamp: data.t,
        };
    } catch (err) {
        console.error(`[Finnhub] Candle fetch failed for ${symbol}:`, err.message);
        return null;
    }
}

// ─── Multi-Source Daily Candle Aggregator ─────────────────────────────────

/**
 * Fetch daily OHLCV candles with multi-source fallback chain:
 *   1. Yahoo Finance (primary — no key, covers everything)
 *   2. Stooq (free, great for futures/forex — often more accurate than Yahoo for futures)
 *   3. CoinGecko (crypto only, no key)
 *   4. Binance (crypto only, no key)
 *   5. Finnhub (rate-limited fallback)
 */
async function fetchCandles(symbol, resolution = 'D', days = 90) {
    return cache.getOrFetch(`candles:${symbol}:${resolution}:${days}`, async () => {
        // Yahoo first — broadest coverage
        let candles = await fetchCandlesYahoo(symbol, days);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} candles → Yahoo Finance`);
            return candles;
        }

        // Stooq — best for futures when Yahoo is flaky
        candles = await fetchCandlesStooq(symbol, days);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} candles → Stooq`);
            return candles;
        }

        // CoinGecko — crypto OHLCV with volume
        candles = await fetchCandlesCoinGecko(symbol, days);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} candles → CoinGecko`);
            return candles;
        }

        // Binance — crypto, no key
        candles = await fetchCandlesBinance(symbol, days);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} candles → Binance`);
            return candles;
        }

        // Finnhub last resort
        candles = await fetchCandlesFinnhub(symbol, days);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} candles → Finnhub`);
            return candles;
        }

        console.warn(`[Data] ❌ No candle data for ${symbol} from any source`);
        return null;
    });
}

// ─── Multi-Source Weekly Candle Aggregator ────────────────────────────────

/**
 * Fetch WEEKLY candles for multi-timeframe level confluence.
 * A level confirmed on weekly AND daily is rated Major.
 * Chain: Yahoo 1wk → Stooq weekly → AlphaVantage weekly
 */
async function fetchWeeklyCandles(symbol, weeks = 52) {
    return cache.getOrFetch(`candles:${symbol}:W:${weeks}`, async () => {
        let candles = await fetchWeeklyCandlesYahoo(symbol, weeks);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} weekly candles → Yahoo`);
            return candles;
        }

        candles = await fetchWeeklyCandlesStooq(symbol, weeks);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} weekly candles → Stooq`);
            return candles;
        }

        candles = await fetchWeeklyCandlesAlphaVantage(symbol);
        if (candles) {
            console.log(`[Data] ✅ ${symbol} weekly candles → Alpha Vantage`);
            return candles;
        }

        return null;
    }, 300_000); // 5 min cache for weekly data
}

/**
 * Fetch current quote with multi-source fallback.
 */
async function fetchQuote(symbol) {
    return cache.getOrFetch(`quote:${symbol}`, async () => {
        // Try Yahoo first
        let quote = await fetchQuoteYahoo(symbol);
        if (quote) return quote;

        // Try Finnhub as fallback
        try {
            await finnhubLimiter.waitForToken();
            const { data } = await axios.get(`${FINNHUB_BASE}/quote`, {
                params: { symbol, token: config.finnhubKey },
            });
            if (data && data.c !== 0) {
                return {
                    current: data.c,
                    high: data.h,
                    low: data.l,
                    open: data.o,
                    prevClose: data.pc,
                    change: data.d,
                    changePercent: data.dp,
                };
            }
        } catch (err) {
            console.error(`[Finnhub] Quote fetch failed for ${symbol}:`, err.message);
        }

        return null;
    }, 30_000);
}

/**
 * Fetch quotes for all watchlist symbols.
 */
async function fetchAllQuotes() {
    const results = {};
    for (const [symbol, meta] of Object.entries(config.watchlist)) {
        try {
            const quote = await fetchQuote(symbol);
            results[symbol] = { ...meta, quote };
        } catch (err) {
            console.error(`Failed to fetch quote for ${symbol}:`, err.message);
            results[symbol] = { ...meta, quote: null };
        }
    }
    return results;
}

module.exports = { fetchCandles, fetchWeeklyCandles, fetchQuote, fetchAllQuotes };

