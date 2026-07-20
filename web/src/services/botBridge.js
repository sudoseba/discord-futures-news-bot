'use strict';
/**
 * Bridge to the bot's own engines.
 *
 * The dashboard reuses the bot's services *in-process* — market data, macro,
 * sentiment, news, technical analysis, COT and the Cerebras LLM. Node resolves
 * those services' own dependencies (axios, yahoo-finance2, technicalindicators,
 * the Cerebras SDK …) from the repo-root node_modules, so nothing is duplicated.
 *
 * Two things make this safe to run as a separate process with no bot DB:
 *   1. Every data service we use is DB-free (verified) — pure network/compute.
 *   2. llmService only touches the DB via memoryService.assembleContext (a read)
 *      and memory.persist*() (writes). We shim those to be no-ops, so the LLM
 *      runs on live data only, no database required.
 *
 * If the bot source or its node_modules aren't present, the bridge degrades to
 * `available: false` and every call throws a clear error — the dashboard itself
 * keeps running.
 */
const path = require('path');
const log = require('../logger').child('bridge');

const BOT_ROOT = path.join(__dirname, '..', '..', '..'); // repo root
const BOT_SRC = path.join(BOT_ROOT, 'src');

const state = { available: false, error: null, aiSdk: false };
const svc = {};
let botConfig = null;
let CerebrasSDK = null;
let botBreaker = null;

try {
  botConfig = require(path.join(BOT_SRC, 'config'));

  // Shim memoryService so llmService needs no database.
  const memory = require(path.join(BOT_SRC, 'services', 'memoryService'));
  memory.assembleContext = () => ''; // returns a prompt string; '' = no memory block
  for (const k of Object.keys(memory)) {
    if (k.startsWith('persist') && typeof memory[k] === 'function') memory[k] = () => {};
  }

  svc.market = require(path.join(BOT_SRC, 'services', 'marketDataService'));
  svc.macro = require(path.join(BOT_SRC, 'services', 'macroService'));
  svc.sentiment = require(path.join(BOT_SRC, 'services', 'sentimentService'));
  svc.news = require(path.join(BOT_SRC, 'services', 'newsService'));
  svc.ta = require(path.join(BOT_SRC, 'services', 'technicalAnalysisService'));
  svc.cot = require(path.join(BOT_SRC, 'services', 'cotReportService'));
  svc.llm = require(path.join(BOT_SRC, 'services', 'llmService'));
  try { botBreaker = require(path.join(BOT_SRC, 'utils', 'circuitBreaker')); } catch { /* older bot */ }

  try {
    CerebrasSDK = require(require.resolve('@cerebras/cerebras_cloud_sdk', { paths: [BOT_ROOT] }));
    state.aiSdk = true;
  } catch (e) {
    log.warn({ err: e.message }, 'Cerebras SDK not resolvable — freeform AI chat disabled');
  }

  state.available = true;
  log.info({ aiSdk: state.aiSdk, aiKey: Boolean(botConfig.cerebrasApiKey) }, 'bot engine bridge ready');
} catch (e) {
  state.error = e.message;
  log.error({ err: e.message }, 'bot engine bridge unavailable (bot source / node_modules missing at repo root)');
}

function ensure() {
  if (!state.available) throw new Error(`bot engines unavailable: ${state.error || 'not loaded'}`);
}
function aiAvailable() {
  return Boolean(state.available && state.aiSdk && botConfig && botConfig.cerebrasApiKey);
}

/** Circuit-breaker / provider health snapshot (populated as bridge calls run). */
function providerHealth() {
  try { return botBreaker ? botBreaker.snapshot() : []; } catch { return []; }
}

// ─── symbol resolution ──────────────────────────────────────────────────────
const ALIASES = {
  gold: 'XAU', xau: 'XAU', gc: 'XAU',
  silver: 'XAG', xag: 'XAG', si: 'XAG',
  copper: 'XCU', xcu: 'XCU', hg: 'XCU',
  oil: 'WTICO', wti: 'WTICO', cl: 'WTICO', crude: 'WTICO',
  brent: 'BRENT', qm: 'WTICO',
  natgas: 'NATGAS', ng: 'NATGAS', gas: 'NATGAS',
  btc: 'BTC', bitcoin: 'BTC', xbt: 'BTC',
  eth: 'ETH', ethereum: 'ETH',
  eur: 'EUR', eurusd: 'EUR',
  gbp: 'GBP', gbpusd: 'GBP', cable: 'GBP',
  jpy: 'JPY', usdjpy: 'JPY',
};

function watchlist() { return (botConfig && botConfig.watchlist) || {}; }
function meta(key) { return watchlist()[key] || null; }

function resolve(input) {
  if (!input) return null;
  const wl = watchlist();
  const keys = Object.keys(wl);
  const raw = String(input).trim();
  const exact = keys.find((k) => k.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const norm = raw.toLowerCase().replace(/[\s/_-]/g, '');
  const token = ALIASES[norm];
  if (token) {
    const k = keys.find((x) => x.toUpperCase().includes(token));
    if (k) return k;
  }
  const byName = keys.find((k) => String(wl[k].name).toLowerCase().replace(/[\s/]/g, '').includes(norm));
  if (byName) return byName;
  // last resort: strip separators from both sides so "xauusd" matches "OANDA:XAU_USD"
  return keys.find((k) => k.toLowerCase().replace(/[\s/_:-]/g, '').includes(norm)) || null;
}

function symbols() {
  const wl = watchlist();
  return Object.keys(wl).map((k) => ({ key: k, name: wl[k].name, emoji: wl[k].emoji, category: wl[k].category }));
}

// ─── data ───────────────────────────────────────────────────────────────────
async function allQuotes() { ensure(); return svc.market.fetchAllQuotes(); }

async function quote(sym) {
  ensure();
  const key = resolve(sym);
  if (!key) throw notFound(sym);
  return { symbol: key, meta: meta(key), quote: await svc.market.fetchQuote(key) };
}

async function macro() { ensure(); return svc.macro.fetchInstitutionalKeys(); }
async function calendar(full = false) { ensure(); return full ? svc.macro.fetchFullCalendar() : svc.macro.fetchEconomicCalendar(); }
async function cot() { ensure(); return svc.cot.gather(); }
async function fearGreed() { ensure(); return svc.sentiment.fetchFearGreedIndex(); }
async function funding() { ensure(); return svc.sentiment.fetchFundingRates(); }
async function news(category = 'all', breakingOnly = false) { ensure(); return svc.news.fetchMarketNews(category, breakingOnly); }

async function analyze(sym) {
  ensure();
  const key = resolve(sym);
  if (!key) throw notFound(sym);
  const [candles, q, cot] = await Promise.all([
    svc.market.fetchCandles(key, 'D', 90),
    svc.market.fetchQuote(key),
    svc.macro.fetchCotForSymbol(key).catch(() => null),
  ]);
  if (!candles) throw new Error(`no candle data for ${meta(key)?.name || key}`);
  return { symbol: key, meta: meta(key), quote: q, analysis: svc.ta.analyze(candles), levels: svc.ta.detectLevels(candles), cot };
}

async function chartData(sym, opts = {}) {
  ensure();
  const key = resolve(sym);
  if (!key) throw notFound(sym);
  const weekly = !!opts.weekly;
  const days = Math.max(30, Math.min(400, opts.days || 140));
  const [candles, q] = await Promise.all([
    weekly ? svc.market.fetchWeeklyCandles(key, 80) : svc.market.fetchCandles(key, 'D', days),
    svc.market.fetchQuote(key),
  ]);
  if (!candles || !candles.close || candles.close.length < 3) throw new Error(`no candle data for ${meta(key)?.name || key}`);
  return { symbol: key, meta: meta(key), quote: q, timeframe: weekly ? 'W' : 'D', candles, analysis: svc.ta.analyze(candles), levels: svc.ta.detectLevels(candles) };
}

async function levels(sym) {
  ensure();
  const key = resolve(sym);
  if (!key) throw notFound(sym);
  const [daily, weekly, q] = await Promise.all([
    svc.market.fetchCandles(key, 'D', 90),
    svc.market.fetchWeeklyCandles(key, 52),
    svc.market.fetchQuote(key),
  ]);
  return { symbol: key, meta: meta(key), quote: q, daily: daily && svc.ta.detectLevels(daily), weekly: weekly && svc.ta.detectLevels(weekly) };
}

// ─── AI ─────────────────────────────────────────────────────────────────────
let cerebras = null;
function aiClient() {
  if (!aiAvailable()) throw new Error('AI is not configured (need CEREBRAS_API_KEY in the bot .env)');
  if (!cerebras) cerebras = new CerebrasSDK({ apiKey: botConfig.cerebrasApiKey });
  return cerebras;
}

async function chat(prompt, opts = {}) {
  const {
    system = 'You are an elite futures trading-desk analyst. Be sharp, specific and concise. Use concrete numbers and levels. No filler, no disclaimers.',
    maxTokens = 900,
    temperature = 0.4,
  } = opts;
  const completion = await aiClient().chat.completions.create({
    model: botConfig.cerebrasModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: String(prompt) }],
    temperature,
    max_tokens: maxTokens,
  });
  return completion.choices[0]?.message?.content || '';
}

async function verdict(sym) {
  ensure();
  if (!aiAvailable()) throw new Error('AI is not configured (need CEREBRAS_API_KEY in the bot .env)');
  const key = resolve(sym);
  if (!key) throw notFound(sym);
  const [candles, q, macroData, cal] = await Promise.all([
    svc.market.fetchCandles(key, 'D', 90),
    svc.market.fetchQuote(key),
    svc.macro.fetchInstitutionalKeys(),
    svc.macro.fetchEconomicCalendar(),
  ]);
  if (!candles) throw new Error(`no candle data for ${meta(key)?.name || key}`);
  const analysis = svc.ta.analyze(candles);
  const corr = svc.macro.generateCorrelationNotes(macroData, key);
  const name = meta(key)?.name || key;
  const text = await svc.llm.generateWarRoomVerdict(name, analysis, macroData, corr, analysis.riskMetrics, cal, key);
  return { symbol: key, name, verdict: text, analysis, quote: q, correlationNotes: corr };
}

async function brief(category = 'all') {
  ensure();
  const articles = await svc.news.fetchMarketNews(category, false);
  const summary = await svc.llm.summarizeNews(articles, category);
  let tldr = summary.tldr;
  // Fallback: if the curation step didn't produce a TLDR, ask for a short one so
  // "AI Brief" always says something useful.
  if (!tldr && aiAvailable() && articles.length) {
    const heads = articles.slice(0, 16).map((a, i) => `${i + 1}. ${a.headline}${a.source ? ' — ' + a.source : ''}`).join('\n');
    try {
      tldr = await chat(
        `Give the desk a 2-3 sentence TLDR of what actually matters in these ${category} headlines. Lead with the dominant narrative and its positioning implication.\n\n${heads}`,
        { maxTokens: 240, temperature: 0.3 },
      );
    } catch { /* leave null */ }
  }
  return { category, count: articles.length, tldr, curated: summary.curatedHeadlines || [], articles: articles.slice(0, 12) };
}

function notFound(sym) {
  const names = symbols().map((s) => s.key.split(':').pop()).join(', ');
  return new Error(`unknown symbol "${sym}". Try one of: ${names}`);
}

module.exports = {
  get available() { return state.available; },
  get error() { return state.error; },
  aiAvailable,
  providerHealth,
  resolve,
  symbols,
  watchlist,
  meta,
  allQuotes,
  quote,
  macro,
  calendar,
  cot,
  fearGreed,
  funding,
  news,
  analyze,
  chartData,
  levels,
  verdict,
  brief,
  chat,
};
