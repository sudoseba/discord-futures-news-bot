/**
 * Additional external data providers used as fallbacks / redundancy.
 * Each returns the SAME shapes the core services use, or null when the source
 * doesn't cover a symbol / isn't configured, so they slot cleanly into the
 * withFallback provider chains.
 *
 *   quote:   { current, high, low, open, prevClose, change, changePercent, volume?, vwap? }
 *   candles: { open[], high[], low[], close[], volume[], timestamp[] }   (timestamp = seconds, oldest-first)
 *   funding: { symbol, rate, ratePercent, fundingTime }
 */
const axios = require('axios');
const config = require('../config');

const TIMEOUT = 8000;
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ─── Twelve Data (FX / metals spot / crypto / stocks) ─────────────────────────
const TD_SYMBOLS = {
  'OANDA:XAU_USD': 'XAU/USD', 'OANDA:XAG_USD': 'XAG/USD',
  'BINANCE:BTCUSDT': 'BTC/USD', 'BINANCE:ETHUSDT': 'ETH/USD',
  'OANDA:EUR_USD': 'EUR/USD', 'OANDA:GBP_USD': 'GBP/USD', 'OANDA:USD_JPY': 'USD/JPY',
};

async function twelveDataQuote(symbol) {
  const sym = TD_SYMBOLS[symbol];
  if (!sym || !config.twelveDataKey) return null;
  const { data } = await axios.get('https://api.twelvedata.com/quote', {
    params: { symbol: sym, apikey: config.twelveDataKey }, timeout: TIMEOUT,
  });
  if (!data || data.code || data.status === 'error' || data.close == null) return null;
  return {
    current: num(data.close), high: num(data.high), low: num(data.low), open: num(data.open),
    prevClose: num(data.previous_close), change: num(data.change), changePercent: num(data.percent_change),
    volume: num(data.volume) || undefined,
  };
}

async function twelveDataSeries(symbol, interval, size) {
  const sym = TD_SYMBOLS[symbol];
  if (!sym || !config.twelveDataKey) return null;
  const { data } = await axios.get('https://api.twelvedata.com/time_series', {
    params: { symbol: sym, interval, outputsize: Math.min(size, 500), apikey: config.twelveDataKey }, timeout: TIMEOUT,
  });
  if (!data || data.code || data.status === 'error' || !Array.isArray(data.values) || data.values.length < 2) return null;
  const rows = data.values.slice().reverse(); // API returns newest-first
  return {
    open: rows.map((r) => num(r.open)),
    high: rows.map((r) => num(r.high)),
    low: rows.map((r) => num(r.low)),
    close: rows.map((r) => num(r.close)),
    volume: rows.map((r) => num(r.volume) || 0),
    timestamp: rows.map((r) => Math.floor(Date.parse(r.datetime.length <= 10 ? r.datetime + 'T00:00:00Z' : r.datetime) / 1000)),
  };
}
const twelveDataCandles = (symbol, days = 90) => twelveDataSeries(symbol, '1day', days + 5);
const twelveDataWeekly = (symbol, weeks = 52) => twelveDataSeries(symbol, '1week', weeks + 2);

// ─── Massive (Polygon-compatible: stocks / FX / crypto / metals, w/ volume) ───
const MASSIVE_SYMBOLS = {
  'OANDA:XAU_USD': 'C:XAUUSD', 'OANDA:XAG_USD': 'C:XAGUSD',
  'BINANCE:BTCUSDT': 'X:BTCUSD', 'BINANCE:ETHUSDT': 'X:ETHUSD',
  'OANDA:EUR_USD': 'C:EURUSD', 'OANDA:GBP_USD': 'C:GBPUSD', 'OANDA:USD_JPY': 'C:USDJPY',
};
const MASSIVE_BASE = 'https://api.massive.com';

async function massiveQuote(symbol) {
  const t = MASSIVE_SYMBOLS[symbol];
  if (!t || !config.massiveApiKey) return null;
  const { data } = await axios.get(`${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(t)}/prev`, {
    params: { apiKey: config.massiveApiKey }, timeout: TIMEOUT,
  });
  const r = data?.results?.[0];
  if (data?.status !== 'OK' || !r || r.c == null) return null;
  const change = r.c - r.o;
  return {
    current: num(r.c), high: num(r.h), low: num(r.l), open: num(r.o), prevClose: num(r.o),
    change: num(change), changePercent: r.o ? num((change / r.o) * 100) : null,
    volume: num(r.v) || undefined, vwap: num(r.vw) || undefined,
  };
}

async function massiveAggs(symbol, timespan, from, to) {
  const t = MASSIVE_SYMBOLS[symbol];
  if (!t || !config.massiveApiKey) return null;
  const { data } = await axios.get(
    `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(t)}/range/1/${timespan}/${ymd(from)}/${ymd(to)}`,
    { params: { adjusted: true, sort: 'asc', limit: 50000, apiKey: config.massiveApiKey }, timeout: TIMEOUT },
  );
  if (data?.status !== 'OK' || !Array.isArray(data.results) || data.results.length < 2) return null;
  const R = data.results;
  return {
    open: R.map((b) => num(b.o)), high: R.map((b) => num(b.h)), low: R.map((b) => num(b.l)),
    close: R.map((b) => num(b.c)), volume: R.map((b) => num(b.v) || 0),
    timestamp: R.map((b) => Math.floor(b.t / 1000)),
  };
}
const massiveCandles = (symbol, days = 90) => massiveAggs(symbol, 'day', daysAgo(days), new Date());
const massiveWeekly = (symbol, weeks = 52) => massiveAggs(symbol, 'week', daysAgo(weeks * 7), new Date());

// ─── ExchangeRate-API (FX spot reference — price only, last resort) ───────────
const ER_PAIRS = {
  'OANDA:EUR_USD': ['EUR', 'USD'], 'OANDA:GBP_USD': ['GBP', 'USD'], 'OANDA:USD_JPY': ['USD', 'JPY'],
};
async function exchangeRateQuote(symbol) {
  const pair = ER_PAIRS[symbol];
  if (!pair || !config.exchangeRateKey) return null;
  const { data } = await axios.get(
    `https://v6.exchangerate-api.com/v6/${config.exchangeRateKey}/pair/${pair[0]}/${pair[1]}`,
    { timeout: TIMEOUT },
  );
  if (data?.result !== 'success' || data.conversion_rate == null) return null;
  return { current: num(data.conversion_rate), high: null, low: null, open: null, prevClose: null, change: null, changePercent: null };
}

// ─── Bybit funding (non-Binance funding source) ───────────────────────────────
async function bybitFunding(binanceSymbol) {
  const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', {
    params: { category: 'linear', symbol: binanceSymbol }, timeout: TIMEOUT,
  });
  const row = data?.result?.list?.[0];
  if (data?.retCode !== 0 || !row || row.fundingRate == null) return null;
  const rate = parseFloat(row.fundingRate);
  if (!Number.isFinite(rate)) return null;
  return { symbol: binanceSymbol, rate, ratePercent: (rate * 100).toFixed(4) + '%', fundingTime: row.nextFundingTime };
}

module.exports = {
  twelveDataQuote, twelveDataCandles, twelveDataWeekly,
  massiveQuote, massiveCandles, massiveWeekly,
  exchangeRateQuote,
  bybitFunding,
  _maps: { TD_SYMBOLS, MASSIVE_SYMBOLS, ER_PAIRS },
};
