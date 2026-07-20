#!/usr/bin/env node
/*
 * Discord News Bot — Admin Panel (Debian / headless / SSH)
 * ------------------------------------------------------------------
 * A terminal equivalent of AdminPanel.ps1 for Linux boxes (Raspberry
 * Pi, VPS, etc.) that have no desktop. Works fine over a plain SSH
 * session. Uses only Node's built-in modules — no npm install needed
 * (the bot already ships Node >= 20).
 *
 * Two ways to use it:
 *
 *   Interactive menu (default):
 *       node admin-panel.js
 *       npm run admin
 *
 *   Scriptable one-shot subcommands (great for SSH / cron):
 *       node admin-panel.js status
 *       node admin-panel.js health
 *       node admin-panel.js start | stop | restart
 *       node admin-panel.js logs [--follow]
 *       node admin-panel.js test <api> | test-all
 *       node admin-panel.js deploy
 *       node admin-panel.js get <KEY>
 *       node admin-panel.js set <KEY> <VALUE>
 *
 * Bot process control prefers a systemd service (see deploy/) and
 * falls back to a plain background node process if no unit is
 * installed — so it works before and after you set up systemd.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

// ─── Paths ────────────────────────────────────────────────────────
const PROJECT_DIR = __dirname;
const ENV_PATH = path.join(PROJECT_DIR, '.env');
const LOG_DIR = path.join(PROJECT_DIR, 'logs');
const OUT_LOG = path.join(LOG_DIR, 'bot.out.log');
const ERR_LOG = path.join(LOG_DIR, 'bot.err.log');
const PID_FILE = path.join(PROJECT_DIR, '.adminpanel-bot.pid');
const SERVICE = process.env.BOT_SERVICE || 'discord-news-bot';
const WEB_SERVICE = process.env.WEB_SERVICE || 'discord-web-dashboard';
const WEB_DIR = path.join(PROJECT_DIR, 'web');
const WEB_PID_FILE = path.join(PROJECT_DIR, '.adminpanel-web.pid');
const WEB_OUT_LOG = path.join(LOG_DIR, 'web.out.log');
const WEB_ERR_LOG = path.join(LOG_DIR, 'web.err.log');

let VERSION = '2.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8')).version;
} catch { /* keep default */ }

// ─── Colors ───────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const green = (s) => paint('32', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);
const headerClr = (s) => paint('1;36', s);

// ─── Setting schema (mirrors AdminPanel.ps1) ──────────────────────
// type: text | secret | bool | choice
const SCHEMA = [
  { key: 'DISCORD_TOKEN',          label: 'Bot Token',          cat: 'Discord',     type: 'secret', hint: 'Discord Developer Portal > Bot > Token' },
  { key: 'DISCORD_CLIENT_ID',      label: 'Client / App ID',    cat: 'Discord',     type: 'text',   hint: 'Application (client) ID' },
  { key: 'DISCORD_CLIENT_SECRET',  label: 'Client Secret',      cat: 'Discord',     type: 'secret', hint: 'OAuth2 client secret' },
  { key: 'DISCORD_GUILD_ID',       label: 'Guild (Server) ID',  cat: 'Discord',     type: 'text',   hint: 'Your Discord server ID' },
  { key: 'AUTO_POST_CHANNEL_ID',   label: 'Auto-Post Channel',  cat: 'Discord',     type: 'text',   hint: 'Channel ID for briefings/recaps/alerts' },

  { key: 'NEWS_API_KEY',           label: 'NewsAPI.org Key',    cat: 'News APIs',   type: 'secret', hint: 'newsapi.org' },
  { key: 'BENZINGA_API_KEY',       label: 'Benzinga Key',       cat: 'News APIs',   type: 'secret', hint: 'api.benzinga.com' },
  { key: 'FINNHUB_API_KEY',        label: 'Finnhub Key',        cat: 'News APIs',   type: 'secret', hint: 'finnhub.io' },

  { key: 'CEREBRAS_API_KEY',       label: 'Cerebras Key',       cat: 'AI & Voice',  type: 'secret', hint: 'cloud.cerebras.ai - the LLM the bot uses' },
  { key: 'CEREBRAS_MODEL',         label: 'Cerebras Model',     cat: 'AI & Voice',  type: 'text',   default: 'gpt-oss-120b', hint: 'Default: gpt-oss-120b' },
  { key: 'DEEPGRAM_TTS_API_KEY',   label: 'Deepgram TTS Key',   cat: 'AI & Voice',  type: 'secret', hint: 'deepgram.com - recap voice audio (opt-in)' },
  { key: 'GROQ_API_KEY',           label: 'Groq Key',           cat: 'AI & Voice',  type: 'secret', hint: 'groq.com - automatic failover for Cerebras' },
  { key: 'GROQ_MODEL',             label: 'Groq Model',         cat: 'AI & Voice',  type: 'text',   default: 'llama-3.3-70b-versatile', hint: 'Groq failover model' },

  { key: 'ALPHA_VANTAGE_API_KEY',  label: 'Alpha Vantage Key',  cat: 'Market Data', type: 'secret', hint: 'alphavantage.co - weekly candle fallback' },
  { key: 'MASSIVE_API_KEY',        label: 'Massive Key',        cat: 'Market Data', type: 'secret', hint: 'massive.com - quotes/candles fallback (real volume + VWAP)' },
  { key: 'TWELVEDATA_API_KEY',     label: 'Twelve Data Key',    cat: 'Market Data', type: 'secret', hint: 'twelvedata.com - FX/metals/crypto/stocks fallback' },
  { key: 'EXCHANGERATE_API_KEY',   label: 'ExchangeRate Key',   cat: 'Market Data', type: 'secret', hint: 'exchangerate-api.com - FX reference rates' },
  { key: 'LUNARCRUSH_API_KEY',     label: 'LunarCrush Key',     cat: 'Market Data', type: 'secret', hint: 'lunarcrush.com - crypto social (needs paid tier)' },

  { key: 'SCHEDULE_TIMEZONE',      label: 'Timezone',           cat: 'Schedules',   type: 'text',   default: 'America/New_York', hint: 'IANA tz, e.g. America/New_York' },
  { key: 'BRIEFING_CRON',          label: 'Morning Briefing',   cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. 0 8 * * 1-5' },
  { key: 'RECAP_CRON',             label: 'Daily Recap',        cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. 30 16 * * 1-5' },
  { key: 'ANOMALY_SCAN_CRON',      label: 'Anomaly Scan',       cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */15 * * * *' },
  { key: 'BREAKING_NEWS_CRON',     label: 'Breaking News',      cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */5 * * * *' },
  { key: 'LEVEL_BREAK_CRON',       label: 'Level Break',        cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */5 * * * *' },
  { key: 'SCORECARD_RESOLVE_CRON', label: 'Scorecard Resolve',  cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */30 * * * *' },
  { key: 'COT_FRIDAY_CRON',        label: 'COT Friday',         cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. 30 16 * * 5' },
  { key: 'EVENT_OUTCOME_CRON',     label: 'Event Outcome',      cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */10 * * * *' },
  { key: 'DEADLETTER_DRAIN_CRON',  label: 'Dead-letter Drain',  cat: 'Schedules',   type: 'text',   hint: 'cron, e.g. */1 * * * *' },

  { key: 'LLM_CACHE_TTL_MS',       label: 'LLM Cache TTL (ms)', cat: 'Behavior',    type: 'text',   hint: 'AI output cache in ms; 0 disables. Default 1200000 (20m)' },
  { key: 'LOG_LEVEL',              label: 'Log Level',          cat: 'Behavior',    type: 'choice', choices: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'], default: 'info' },
  { key: 'LOG_PRETTY',             label: 'Pretty Logs',        cat: 'Behavior',    type: 'bool',   default: 'true', hint: 'Pretty console logs (dev). Off = JSON (prod)' },
  { key: 'HEALTHZ_PORT',           label: 'Health Port',        cat: 'Behavior',    type: 'text',   default: '3000', hint: 'HTTP health endpoint port. Default 3000' },
  { key: 'HEALTHZ_ENABLED',        label: 'Health Endpoint On', cat: 'Behavior',    type: 'bool',   default: 'true' },
];

// ─── APIs for the health tab ──────────────────────────────────────
const APIS = [
  { id: 'discord',      name: 'Discord (bot token)',         kind: 'key' },
  { id: 'newsapi',      name: 'NewsAPI.org',                 kind: 'key' },
  { id: 'benzinga',     name: 'Benzinga',                    kind: 'key' },
  { id: 'finnhub',      name: 'Finnhub',                     kind: 'key' },
  { id: 'cerebras',     name: 'Cerebras (AI / LLM)',         kind: 'key' },
  { id: 'deepgram',     name: 'Deepgram TTS',                kind: 'key' },
  { id: 'alphavantage', name: 'Alpha Vantage',               kind: 'key' },
  { id: 'yahoo',        name: 'Yahoo Finance (no key)',      kind: 'free' },
  { id: 'stooq',        name: 'Stooq (no key)',              kind: 'free' },
  { id: 'coingecko',    name: 'CoinGecko (no key)',          kind: 'free' },
  { id: 'altme',        name: 'Alternative.me F&G (no key)', kind: 'free' },
  { id: 'massive',      name: 'Massive.com',                 kind: 'key' },
  { id: 'twelvedata',   name: 'Twelve Data',                 kind: 'key' },
  { id: 'exchangerate', name: 'ExchangeRate-API',            kind: 'key' },
  { id: 'groq',         name: 'Groq (LLM failover)',         kind: 'key' },
  { id: 'lunarcrush',   name: 'LunarCrush (crypto social)',  kind: 'key' },
  { id: 'bybit',        name: 'Bybit funding (no key)',      kind: 'free' },
];

// ─── .env state ───────────────────────────────────────────────────
function readEnvValues() {
  const h = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t === '' || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx < 1) continue;
      h[t.slice(0, idx).trim()] = t.slice(idx + 1);
    }
  }
  return h;
}

// VALUES holds the RAW file value ('' when absent). Defaults are only
// applied for display/tests via effective(), never written on save —
// so we never pollute .env with defaults the user never set.
let VALUES = loadValues();
function loadValues() {
  const h = readEnvValues();
  const v = {};
  for (const s of SCHEMA) v[s.key] = h[s.key] !== undefined ? h[s.key] : '';
  return v;
}
function effective(key) {
  const s = SCHEMA.find((x) => x.key === key);
  const raw = VALUES[key] != null ? VALUES[key] : '';
  if (raw !== '') return raw;
  return s && s.default != null ? s.default : '';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function saveEnv() {
  let orig = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  if (orig.length && orig[orig.length - 1] === '') orig.pop();

  const handled = {};
  const out = [];
  for (const line of orig) {
    let matched = false;
    for (const s of SCHEMA) {
      const rx = new RegExp('^\\s*#?\\s*' + escapeRegex(s.key) + '\\s*=');
      if (rx.test(line)) {
        const val = VALUES[s.key] != null ? VALUES[s.key] : '';
        if (val === '') {
          if (/^\s*#/.test(line)) out.push(line); // keep commented-out
          else out.push(`${s.key}=`);
        } else {
          out.push(`${s.key}=${val}`);
        }
        handled[s.key] = true;
        matched = true;
        break;
      }
    }
    if (!matched) out.push(line);
  }

  const missing = SCHEMA.filter((s) => !handled[s.key] && (VALUES[s.key] != null ? VALUES[s.key] : '') !== '');
  if (missing.length) {
    out.push('');
    out.push('# --- Added by Admin Panel ---');
    for (const s of missing) out.push(`${s.key}=${VALUES[s.key]}`);
  }

  if (fs.existsSync(ENV_PATH)) fs.copyFileSync(ENV_PATH, ENV_PATH + '.bak');
  fs.writeFileSync(ENV_PATH, out.join('\n') + '\n', 'utf8');
}

// ─── HTTP helper (follows redirects, hard timeout) ────────────────
function httpRequest(opts) {
  return new Promise((resolve) => {
    const { url, method = 'GET', headers = {}, body = null, contentType = null, timeoutMs = 8000, redirects = 3 } = opts;
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, code: 0, body: null, err: 'bad url' }); }
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'User-Agent': 'DiscordNewsBot-AdminPanel' }, headers);
    if (contentType) h['Content-Type'] = contentType;
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(u, { method, headers: h }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(httpRequest(Object.assign({}, opts, { url: next, redirects: redirects - 1 })));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; if (data.length > 2_000_000) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, body: data, err: null }));
    });
    req.on('error', (e) => resolve({ ok: false, code: 0, body: null, err: e.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    if (body != null) req.write(body);
    req.end();
  });
}

function parseJson(body) { try { return JSON.parse(body); } catch { return null; } }

function describeHttpErr(r) {
  let m = '';
  const j = r.body ? parseJson(r.body) : null;
  if (j) {
    if (j.message) m = j.message;
    else if (j.error) m = j.error.message ? j.error.message : String(j.error);
  }
  if (!m) m = r.err || '';
  return r.code > 0 ? `HTTP ${r.code} - ${m}` : m;
}

// ─── Per-API test logic (mirrors AdminPanel.ps1) ──────────────────
async function runApiTest(id) {
  const t0 = Date.now();
  let ok = false;
  let msg = '';
  try {
    switch (id) {
      case 'discord': {
        const tok = effective('DISCORD_TOKEN');
        if (!tok) { msg = 'No token set'; break; }
        const r = await httpRequest({ url: 'https://discord.com/api/v10/users/@me', headers: { Authorization: `Bot ${tok}` } });
        if (r.ok) { const j = parseJson(r.body) || {}; ok = true; msg = `OK - ${j.username} (id ${j.id})`; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'finnhub': {
        const k = effective('FINNHUB_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${k}` });
        if (r.ok) {
          const j = parseJson(r.body) || {};
          if (j.c && j.c !== 0) { ok = true; msg = `OK - AAPL $${j.c}`; }
          else msg = '200 but empty payload - key likely invalid or plan-limited';
        } else msg = describeHttpErr(r);
        break;
      }
      case 'newsapi': {
        const k = effective('NEWS_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://newsapi.org/v2/top-headlines?category=business&country=us&pageSize=1&apiKey=${k}` });
        if (r.ok) { const j = parseJson(r.body) || {}; if (j.status === 'ok') { ok = true; msg = `OK - ${j.totalResults} results available`; } else msg = j.message || 'error'; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'benzinga': {
        const k = effective('BENZINGA_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://api.benzinga.com/api/v2/news?token=${k}&pageSize=1` });
        if (r.ok) { ok = true; msg = 'OK - endpoint responded (200)'; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'cerebras': {
        const k = effective('CEREBRAS_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const model = effective('CEREBRAS_MODEL') || 'gpt-oss-120b';
        // 256 tokens: gpt-oss is a reasoning model — a tiny max_tokens gets fully
        // consumed by reasoning, leaving empty content (finish_reason "length").
        const payload = JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 256, temperature: 0 });
        const r = await httpRequest({ url: 'https://api.cerebras.ai/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${k}` }, body: payload, contentType: 'application/json', timeoutMs: 20000 });
        if (r.ok) {
          const j = parseJson(r.body) || {};
          let content = null;
          try { content = j.choices[0].message.content; } catch { /* empty */ }
          if (content) { ok = true; msg = `OK (${model}) - replied: '${content}'`; }
          else msg = `200 but EMPTY content. Check model name '${model}' / account quota.`;
        } else msg = describeHttpErr(r);
        break;
      }
      case 'deepgram': {
        const k = effective('DEEPGRAM_TTS_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: 'https://api.deepgram.com/v1/projects', headers: { Authorization: `Token ${k}` } });
        if (r.ok) { ok = true; msg = 'OK - key valid (no TTS quota used)'; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'alphavantage': {
        const k = effective('ALPHA_VANTAGE_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${k}` });
        if (r.ok) {
          const j = parseJson(r.body) || {};
          const gq = j['Global Quote'];
          if (gq && gq['05. price']) { ok = true; msg = `OK - IBM $${gq['05. price']}`; }
          else if (j.Note) msg = `Rate-limited: ${j.Note}`;
          else if (j.Information) msg = String(j.Information);
          else if (j['Error Message']) msg = String(j['Error Message']);
          else msg = 'Unexpected response (key may be invalid)';
        } else msg = describeHttpErr(r);
        break;
      }
      case 'yahoo': {
        const r = await httpRequest({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d' });
        if (r.ok) { const j = parseJson(r.body); let pr = null; try { pr = j.chart.result[0].meta.regularMarketPrice; } catch { /* */ } ok = true; msg = pr ? `OK - AAPL $${pr}` : 'OK (200)'; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'stooq': {
        const r = await httpRequest({ url: 'https://stooq.com/q/d/l/?s=aapl.us&i=d' });
        if (r.ok) { if (/^Date/.test(r.body)) { ok = true; msg = 'OK - CSV received'; } else msg = '200 but unexpected body'; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'coingecko': {
        const r = await httpRequest({ url: 'https://api.coingecko.com/api/v3/ping' });
        if (r.ok) { ok = true; msg = 'OK - ping'; } else msg = describeHttpErr(r);
        break;
      }
      case 'altme': {
        const r = await httpRequest({ url: 'https://api.alternative.me/fng/?limit=1' });
        if (r.ok) { const j = parseJson(r.body) || {}; const d = (j.data && j.data[0]) || {}; ok = true; msg = `OK - Fear&Greed ${d.value} (${d.value_classification})`; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'twelvedata': {
        const k = effective('TWELVEDATA_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://api.twelvedata.com/quote?symbol=AAPL&apikey=${k}` });
        const j = parseJson(r.body) || {};
        if (r.ok && j.close) { ok = true; msg = `OK - AAPL $${j.close}`; }
        else msg = j.message || describeHttpErr(r);
        break;
      }
      case 'massive': {
        const k = effective('MASSIVE_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://api.massive.com/v2/aggs/ticker/AAPL/prev?apiKey=${k}` });
        const j = parseJson(r.body) || {};
        if (r.ok && j.status === 'OK' && j.results && j.results[0]) { ok = true; msg = `OK - AAPL prev $${j.results[0].c}`; }
        else msg = j.message || describeHttpErr(r);
        break;
      }
      case 'exchangerate': {
        const k = effective('EXCHANGERATE_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: `https://v6.exchangerate-api.com/v6/${k}/pair/EUR/USD` });
        const j = parseJson(r.body) || {};
        if (r.ok && j.result === 'success') { ok = true; msg = `OK - EUR/USD ${j.conversion_rate}`; }
        else msg = j['error-type'] || describeHttpErr(r);
        break;
      }
      case 'groq': {
        const k = effective('GROQ_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: 'https://api.groq.com/openai/v1/models', headers: { Authorization: `Bearer ${k}` } });
        const j = parseJson(r.body) || {};
        if (r.ok && Array.isArray(j.data)) { ok = true; msg = `OK - ${j.data.length} models available`; }
        else msg = describeHttpErr(r);
        break;
      }
      case 'lunarcrush': {
        const k = effective('LUNARCRUSH_API_KEY');
        if (!k) { msg = 'No key set'; break; }
        const r = await httpRequest({ url: 'https://lunarcrush.com/api4/public/coins/BTC/v1', headers: { Authorization: `Bearer ${k}` } });
        const j = parseJson(r.body) || {};
        if (r.ok && j.data) { ok = true; msg = 'OK - data received'; }
        else msg = j.error || '200 but no data (needs paid tier)';
        break;
      }
      case 'bybit': {
        const r = await httpRequest({ url: 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT' });
        const j = parseJson(r.body) || {};
        if (r.ok && j.retCode === 0) { ok = true; msg = `OK - BTC funding ${j.result?.list?.[0]?.fundingRate}`; }
        else msg = describeHttpErr(r);
        break;
      }
      default: msg = 'No test defined';
    }
  } catch (e) {
    msg = `Test error: ${e.message}`;
  }
  return { ok, msg, ms: Date.now() - t0 };
}

// ─── systemd / process control ────────────────────────────────────
function cmdExists(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  return !r.error;
}
const HAS_SYSTEMD = process.platform === 'linux' && cmdExists('systemctl');
function serviceInstalled() {
  if (!HAS_SYSTEMD) return false;
  const r = spawnSync('systemctl', ['cat', `${SERVICE}.service`], { stdio: 'ignore' });
  return r.status === 0;
}
const SERVICE_MODE = serviceInstalled();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SUDO = isRoot ? [] : ['sudo'];

function sysctl(args, inherit = true) {
  const cmd = [...SUDO, 'systemctl', ...args];
  return spawnSync(cmd[0], cmd.slice(1), { stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* busy-wait fallback */ } }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readPid() {
  try { return parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch { return NaN; }
}
function fallbackAlive() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = readPid();
  return Number.isInteger(pid) && pidAlive(pid);
}

async function healthzCheck() {
  const port = effective('HEALTHZ_PORT') || '3000';
  const r = await httpRequest({ url: `http://127.0.0.1:${port}/healthz`, timeoutMs: 4000 });
  return { port, r, json: r.body ? parseJson(r.body) : null };
}

// ─── Web dashboard (separate systemd service) control ─────────────
function webInstalled() {
  if (!HAS_SYSTEMD) return false;
  return spawnSync('systemctl', ['cat', `${WEB_SERVICE}.service`], { stdio: 'ignore' }).status === 0;
}
function webEnvVal(key, def) {
  try {
    const m = fs.readFileSync(path.join(WEB_DIR, '.env'), 'utf8').match(new RegExp('^\\s*' + key + '\\s*=\\s*(\\S+)', 'm'));
    if (m) return m[1];
  } catch { /* no web/.env */ }
  return def;
}
function webPort() { return webEnvVal('WEB_PORT', '8080'); }
function webPublicUrl() { return webEnvVal('WEB_PUBLIC_URL', `http://localhost:${webPort()}`); }

async function webLivez() {
  const r = await httpRequest({ url: `http://127.0.0.1:${webPort()}/livez`, timeoutMs: 4000 });
  return { ok: r.ok, r };
}

function readWebPid() { try { return parseInt(fs.readFileSync(WEB_PID_FILE, 'utf8').trim(), 10); } catch { return NaN; } }
function webPidAlive() { const pid = readWebPid(); return Number.isInteger(pid) && pidAlive(pid); }

function webStart() {
  if (webInstalled()) { console.log(cyan(`start ${WEB_SERVICE} via systemd...`)); return sysctl(['start', WEB_SERVICE]).status === 0; }
  // fallback: plain background process — no service needed
  if (webPidAlive()) { console.log(yellow('Web dashboard already running (tracked PID).')); return true; }
  if (!fs.existsSync(path.join(WEB_DIR, 'node_modules'))) { console.log(yellow('Web dependencies not installed.')); console.log(dim('  cd web && npm ci --omit=dev')); return false; }
  if (!fs.existsSync(path.join(WEB_DIR, '.env'))) { console.log(yellow('web/.env is missing.')); console.log(dim('  cd web && cp .env.example .env   (then set SESSION_SECRET)')); return false; }
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  const out = fs.openSync(WEB_OUT_LOG, 'a');
  const err = fs.openSync(WEB_ERR_LOG, 'a');
  const child = spawn(process.execPath, ['src/index.js'], { cwd: WEB_DIR, detached: true, stdio: ['ignore', out, err] });
  fs.writeFileSync(WEB_PID_FILE, String(child.pid));
  child.unref();
  console.log(green(`Web dashboard started (PID ${child.pid}) → ${webPublicUrl()}`));
  console.log(dim('  background process (not a boot service) · logs: logs/web.out.log'));
  return true;
}

function webStop() {
  if (webInstalled()) { console.log(cyan(`stop ${WEB_SERVICE} via systemd...`)); return sysctl(['stop', WEB_SERVICE]).status === 0; }
  if (!webPidAlive()) { console.log(yellow('No tracked web dashboard process to stop.')); try { fs.unlinkSync(WEB_PID_FILE); } catch { /* */ } return true; }
  const pid = readWebPid();
  try {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && pidAlive(pid)) sleepSync(200);
    if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
    console.log(green(`Web dashboard stopped (PID ${pid}).`));
  } catch (e) { console.log(red('Stop error: ' + e.message)); }
  try { fs.unlinkSync(WEB_PID_FILE); } catch { /* */ }
  return true;
}

function webControl(action) {
  if (action === 'start') return webStart();
  if (action === 'stop') return webStop();
  if (action === 'restart') { webStop(); sleepSync(600); return webStart(); }
  return false;
}

async function printWebStatus() {
  console.log(bold('\nWeb dashboard status'));
  console.log(dim('─'.repeat(60)));
  if (webInstalled()) {
    const active = (sysctl(['is-active', WEB_SERVICE], false).stdout || '').trim() || 'unknown';
    const enabled = (sysctl(['is-enabled', WEB_SERVICE], false).stdout || '').trim();
    console.log(`  mode        : systemd (${WEB_SERVICE})`);
    console.log(`  active      : ${active === 'active' ? green(active) : red(active)}`);
    console.log(`  boot-enabled: ${enabled === 'enabled' ? green(enabled) : yellow(enabled || 'no')}`);
  } else {
    console.log('  mode        : background process (no service — Start/Stop here)');
    if (webPidAlive()) console.log(`  process     : ${green('RUNNING')} (PID ${readWebPid()})`);
    else console.log(`  process     : ${red('STOPPED')}`);
  }
  const { ok } = await webLivez();
  if (ok) console.log(`  /livez      : ${green('responding')} → ${webPublicUrl()}`);
  else console.log(`  /livez      : ${red('no response')} on http://127.0.0.1:${webPort()}/livez`);
  console.log(dim('  (want it to survive reboots? bash web/deploy/install-web-service.sh --start)'));
  console.log(dim('─'.repeat(60)));
}

function webLogs(lines = 200) {
  if (webInstalled()) {
    console.log(cyan(`Last ${lines} journal lines for ${WEB_SERVICE}:\n`));
    const cmd = [...SUDO, 'journalctl', '-u', WEB_SERVICE, '-n', String(lines), '--no-pager'];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  } else {
    const txt = tailFile(WEB_OUT_LOG, lines);
    if (txt == null) console.log(dim('(no web log yet — start the web dashboard from this panel)'));
    else console.log(txt);
  }
}

// Start ------------------------------------------------------------
function startBot() {
  if (SERVICE_MODE) {
    console.log(cyan(`Starting via systemd (${SERVICE})...`));
    const r = sysctl(['start', SERVICE]);
    return r.status === 0;
  }
  // fallback: background node process
  if (fallbackAlive()) { console.log(yellow('Bot already running (tracked PID).')); return true; }
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log(cyan('No systemd unit installed — starting a background node process.'));
  console.log(dim('  (Install deploy/discord-news-bot.service for auto-start on boot.)'));
  const out = fs.openSync(OUT_LOG, 'a');
  const err = fs.openSync(ERR_LOG, 'a');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', out, err],
  });
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  console.log(green(`Bot started (PID ${child.pid}) → logs/bot.out.log`));
  return true;
}

// Stop -------------------------------------------------------------
function stopBot() {
  if (SERVICE_MODE) {
    console.log(cyan(`Stopping via systemd (${SERVICE})...`));
    const r = sysctl(['stop', SERVICE]);
    return r.status === 0;
  }
  if (!fallbackAlive()) { console.log(yellow('No tracked bot process to stop.')); cleanupPid(); return true; }
  const pid = readPid();
  try {
    process.kill(pid, 'SIGTERM');
    console.log(cyan(`Sent SIGTERM to PID ${pid}; waiting up to 8s for clean shutdown...`));
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && pidAlive(pid)) { sleepSync(250); }
    if (pidAlive(pid)) { process.kill(pid, 'SIGKILL'); console.log(yellow('Still alive — sent SIGKILL.')); }
    console.log(green(`Bot stopped (PID ${pid}).`));
  } catch (e) {
    console.log(red(`Stop error: ${e.message}`));
  }
  cleanupPid();
  return true;
}
function cleanupPid() { try { fs.unlinkSync(PID_FILE); } catch { /* */ } }

// Status -----------------------------------------------------------
async function printStatus() {
  console.log(bold('\nBot status'));
  console.log(dim('─'.repeat(60)));
  if (SERVICE_MODE) {
    const active = sysctl(['is-active', SERVICE], false);
    const state = (active.stdout || '').trim() || 'unknown';
    const enabled = (sysctl(['is-enabled', SERVICE], false).stdout || '').trim();
    console.log(`  mode        : systemd (unit: ${SERVICE})`);
    console.log(`  active      : ${state === 'active' ? green(state) : red(state)}`);
    console.log(`  boot-enabled: ${enabled === 'enabled' ? green(enabled) : yellow(enabled || 'no')}`);
  } else {
    console.log(`  mode        : background process (no systemd unit)`);
    if (fallbackAlive()) console.log(`  process     : ${green('RUNNING')} (PID ${readPid()})`);
    else console.log(`  process     : ${red('STOPPED')}`);
  }
  const { port, r, json } = await healthzCheck();
  if (json) {
    console.log(`  /healthz    : ${json.status === 'ok' ? green(json.status) : yellow(json.status)} (port ${port})`);
    console.log(`  uptime      : ${json.uptimeSec}s   discordReady: ${json.discordReady}   dbOk: ${json.dbOk}`);
    console.log(`  memory      : ${json.memoryRssMb} MB   pid: ${json.pid}   version: ${json.version}`);
    const cron = json.cronJobs ? [].concat(json.cronJobs).length : 0;
    console.log(`  cron jobs   : ${cron}`);
  } else {
    console.log(`  /healthz    : ${red('no response')} on http://127.0.0.1:${port}/healthz ${dim(r.err ? '(' + r.err + ')' : '')}`);
  }
  console.log(dim('─'.repeat(60)));
}

// Deploy commands --------------------------------------------------
function deployCommands() {
  console.log(cyan('Registering slash commands (node src/deploy-commands.js)...\n'));
  const r = spawnSync(process.execPath, ['src/deploy-commands.js'], { cwd: PROJECT_DIR, stdio: 'inherit' });
  if (r.status === 0) console.log(green('\nSlash command registration finished.'));
  else console.log(red(`\ndeploy-commands exited with code ${r.status}.`));
}

// Logs -------------------------------------------------------------
function showLogs(lines = 200) {
  if (SERVICE_MODE) {
    console.log(cyan(`Last ${lines} journal lines for ${SERVICE}:\n`));
    const cmd = [...SUDO, 'journalctl', '-u', SERVICE, '-n', String(lines), '--no-pager'];
    spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  } else {
    const txt = tailFile(OUT_LOG, lines);
    if (txt == null) console.log(dim('(no log file yet — start the bot from this panel to capture logs/bot.out.log)'));
    else console.log(txt);
  }
}
function tailFile(file, n) {
  if (!fs.existsSync(file)) return null;
  const size = fs.statSync(file).size;
  const chunk = Math.min(size, 262144);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(chunk);
  fs.readSync(fd, buf, 0, chunk, size - chunk);
  fs.closeSync(fd);
  return buf.toString('utf8').split(/\r?\n/).slice(-n).join('\n');
}
function followLogs() {
  return new Promise((resolve) => {
    let child;
    if (SERVICE_MODE) {
      const cmd = [...SUDO, 'journalctl', '-u', SERVICE, '-f', '-n', '50', '--no-pager'];
      child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
    } else {
      if (!fs.existsSync(OUT_LOG)) { console.log(dim('(no log file yet)')); return resolve(); }
      child = spawn('tail', ['-n', '50', '-f', OUT_LOG], { stdio: 'inherit' });
    }
    console.log(dim('\n(following — press Ctrl-C to stop and return to the menu)\n'));
    const onInt = () => { try { child.kill('SIGINT'); } catch { /* */ } };
    process.on('SIGINT', onInt);
    child.on('error', (e) => { console.log(red(`follow error: ${e.message}`)); });
    child.on('exit', () => { process.removeListener('SIGINT', onInt); resolve(); });
  });
}

// ─── Interactive TUI ──────────────────────────────────────────────
let rl = null;
let muted = false;
let revealSecrets = false;

function makeRl() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const orig = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (muted) { if (s.includes('\n')) rl.output.write('\n'); return; } orig(s); };
}
function ask(q) { return new Promise((res) => rl.question(q, (a) => res(a))); }
function askHidden(q) {
  return new Promise((res) => {
    rl.question(q, (a) => { muted = false; res(a); });
    muted = true; // prompt already printed by question(); mute keystroke echo
  });
}

function banner() {
  const modeStr = SERVICE_MODE ? `systemd:${SERVICE}` : (HAS_SYSTEMD ? 'background (systemd available, unit not installed)' : 'background process');
  console.log('');
  console.log(headerClr(`  Discord News Bot — Admin Panel  v${VERSION}`));
  console.log(dim(`  Project : ${PROJECT_DIR}`));
  console.log(dim(`  Control : ${modeStr}`));
  console.log('');
}

async function mainMenu() {
  makeRl();
  for (;;) {
    banner();
    console.log(bold('  Main menu'));
    console.log('   1) Settings          view / edit .env');
    console.log('   2) API health        test keys & free sources');
    console.log('   3) Bot control       start / stop / restart / status');
    console.log('   4) Web dashboard     start / stop / restart / status');
    console.log('   5) Check /healthz');
    console.log('   6) Logs');
    console.log('   7) Register slash commands (deploy)');
    console.log('   q) Quit');
    const a = (await ask('\n  > ')).trim().toLowerCase();
    if (a === '1') await settingsMenu();
    else if (a === '2') await healthMenu();
    else if (a === '3') await controlMenu();
    else if (a === '4') await webMenu();
    else if (a === '5') { const { port, json, r } = await healthzCheck(); printHealthz(port, json, r); await ask(dim('\n  (enter to continue) ')); }
    else if (a === '6') await logsMenu();
    else if (a === '7') { deployCommands(); await ask(dim('\n  (enter to continue) ')); }
    else if (a === 'q' || a === 'quit' || a === 'exit') break;
  }
  rl.close();
  console.log('bye 👋');
}

function displayValue(s) {
  const raw = VALUES[s.key] != null ? VALUES[s.key] : '';
  if (s.type === 'secret') {
    if (raw === '') return dim('(not set)');
    return revealSecrets ? raw : dim(`(hidden, ${raw.length} chars)`);
  }
  const eff = effective(s.key);
  if (eff === '') return dim('(empty)');
  let str = eff;
  if (raw === '' && s.default != null) str += dim('  (default)');
  return str;
}

async function settingsMenu() {
  for (;;) {
    console.log('\n' + bold('  Settings') + dim('   (edit values, then Save writes .env with a .bak backup)'));
    console.log(dim('  ' + '─'.repeat(64)));
    let lastCat = '';
    SCHEMA.forEach((s, i) => {
      if (s.cat !== lastCat) { console.log('  ' + cyan(s.cat)); lastCat = s.cat; }
      const num = String(i + 1).padStart(2, ' ');
      console.log(`   ${num}) ${s.label.padEnd(20)} ${displayValue(s)}`);
    });
    console.log(dim('  ' + '─'.repeat(64)));
    console.log(`   s) Save to .env     r) Reload     t) ${revealSecrets ? 'Hide' : 'Reveal'} secrets     b) Back`);
    const a = (await ask('\n  edit # or action > ')).trim().toLowerCase();
    if (a === 'b' || a === '') return;
    if (a === 'r') { VALUES = loadValues(); console.log(green('  Reloaded from .env.')); continue; }
    if (a === 't') { revealSecrets = !revealSecrets; continue; }
    if (a === 's') {
      try { saveEnv(); console.log(green('  Saved to .env (backup: .env.bak). Restart the bot to apply.')); }
      catch (e) { console.log(red('  Save failed: ' + e.message)); }
      continue;
    }
    const idx = parseInt(a, 10) - 1;
    if (Number.isInteger(idx) && SCHEMA[idx]) await editSetting(SCHEMA[idx]);
    else console.log(red('  Not a valid choice.'));
  }
}

async function editSetting(s) {
  console.log('\n  ' + bold(s.label) + (s.hint ? dim('  — ' + s.hint) : ''));
  console.log('  current: ' + displayValue(s));
  if (s.type === 'bool') {
    const v = (await ask('  set true/false (blank = keep) > ')).trim().toLowerCase();
    if (v === 'true' || v === 'false') VALUES[s.key] = v;
    else if (v !== '') console.log(yellow('  expected true or false — unchanged.'));
  } else if (s.type === 'choice') {
    console.log('  choices: ' + s.choices.join(', '));
    const v = (await ask('  new value (blank = keep) > ')).trim();
    if (v === '') return;
    if (s.choices.includes(v)) VALUES[s.key] = v;
    else console.log(yellow('  not one of the choices — unchanged.'));
  } else if (s.type === 'secret') {
    const v = await askHidden('  new value (typing hidden; blank = keep) > ');
    if (v.trim() !== '') { VALUES[s.key] = v.trim(); console.log(green('  set.')); }
  } else {
    const v = await ask('  new value (blank = keep, "-" = clear) > ');
    if (v.trim() === '-') { VALUES[s.key] = ''; console.log(green('  cleared.')); }
    else if (v.trim() !== '') { VALUES[s.key] = v.trim(); console.log(green('  set.')); }
  }
}

async function healthMenu() {
  for (;;) {
    console.log('\n' + bold('  API health') + dim('   (uses values currently in Settings, so you can test before saving)'));
    console.log(dim('  ' + '─'.repeat(64)));
    APIS.forEach((api, i) => {
      const num = String(i + 1).padStart(2, ' ');
      const tag = api.kind === 'note' ? dim(' [not used by bot]') : (api.kind === 'free' ? dim(' [no key]') : '');
      console.log(`   ${num}) ${api.name}${tag}`);
    });
    console.log(dim('  ' + '─'.repeat(64)));
    console.log('   a) Test ALL     #) test one     b) Back');
    const a = (await ask('\n  > ')).trim().toLowerCase();
    if (a === 'b' || a === '') return;
    if (a === 'a') {
      for (const api of APIS) { if (api.kind !== 'note') await printOneTest(api); }
      continue;
    }
    const idx = parseInt(a, 10) - 1;
    if (Number.isInteger(idx) && APIS[idx]) {
      if (APIS[idx].kind === 'note') console.log(dim('  Declared in .env but never referenced by bot code — nothing to test.'));
      else await printOneTest(APIS[idx]);
    } else console.log(red('  Not a valid choice.'));
  }
}
async function printOneTest(api) {
  const tty = process.stdout.isTTY;
  if (tty) process.stdout.write(`   ${api.name.padEnd(30)} ${dim('testing...')}`);
  const res = await runApiTest(api.id);
  const status = res.ok ? green('OK  ') : red('FAIL');
  if (tty) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); }
  console.log(`   ${status}  ${api.name.padEnd(28)} ${res.msg}  ${dim('(' + res.ms + 'ms)')}`);
}

async function controlMenu() {
  for (;;) {
    await printStatus();
    console.log('   1) Start     2) Stop     3) Restart     4) Refresh status     b) Back');
    const a = (await ask('\n  > ')).trim().toLowerCase();
    if (a === 'b' || a === '') return;
    if (a === '1') startBot();
    else if (a === '2') stopBot();
    else if (a === '3') { stopBot(); startBot(); }
    else if (a === '4') { /* loop reprints status */ }
    else console.log(red('  Not a valid choice.'));
  }
}

async function webMenu() {
  for (;;) {
    await printWebStatus();
    console.log('   1) Start     2) Stop     3) Restart     4) Logs     5) Refresh     b) Back');
    const a = (await ask('\n  > ')).trim().toLowerCase();
    if (a === 'b' || a === '') return;
    if (a === '1') webControl('start');
    else if (a === '2') webControl('stop');
    else if (a === '3') webControl('restart');
    else if (a === '4') { webLogs(200); await ask(dim('\n  (enter to continue) ')); }
    else if (a === '5') { /* loop reprints status */ }
    else console.log(red('  Not a valid choice.'));
  }
}

async function logsMenu() {
  console.log('\n' + bold('  Logs'));
  console.log('   1) Show last 200 lines     2) Follow (Ctrl-C to stop)     b) Back');
  const a = (await ask('\n  > ')).trim().toLowerCase();
  if (a === '1') { showLogs(200); await ask(dim('\n  (enter to continue) ')); }
  else if (a === '2') { rl.pause(); await followLogs(); rl.resume(); }
}

function printHealthz(port, json, r) {
  console.log(bold(`\n  /healthz @ 127.0.0.1:${port}`));
  console.log(dim('  ' + '─'.repeat(48)));
  if (!json) { console.log('  ' + red('No response') + (r && r.err ? dim('  ' + r.err) : '')); return; }
  const row = (k, v) => console.log(`  ${k.padEnd(13)}: ${v}`);
  row('status', json.status === 'ok' ? green(json.status) : yellow(json.status));
  row('uptime', json.uptimeSec + ' s');
  row('discordReady', json.discordReady);
  row('dbOk', json.dbOk);
  row('memory', json.memoryRssMb + ' MB');
  row('pid', json.pid);
  row('version', json.version);
  row('cron jobs', json.cronJobs ? [].concat(json.cronJobs).length : 0);
}

// ─── CLI (non-interactive) ────────────────────────────────────────
function usage() {
  console.log(`Discord News Bot — Admin Panel (v${VERSION})

Interactive:
  node admin-panel.js                 open the menu

One-shot subcommands:
  status                              service + /healthz summary
  health                              print /healthz JSON view
  start | stop | restart              control the bot
  web <status|start|stop|restart|logs>  control the web dashboard service
  logs [--follow|-f] [N]              show (or follow) bot logs
  test <api> | test-all              run API connectivity tests
  deploy                              register slash commands
  get <KEY>                           print one .env value
  set <KEY> <VALUE>                   set one .env value (writes .bak)

APIs: ${APIS.filter((a) => a.kind !== 'note').map((a) => a.id).join(', ')}

Env overrides: BOT_SERVICE ("${SERVICE}"), WEB_SERVICE ("${WEB_SERVICE}")`);
}

async function cli(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'status': await printStatus(); break;
    case 'health': { const { port, json, r } = await healthzCheck(); printHealthz(port, json, r); break; }
    case 'start': startBot(); break;
    case 'stop': stopBot(); break;
    case 'restart': stopBot(); startBot(); break;
    case 'logs': {
      const follow = rest.includes('--follow') || rest.includes('-f');
      const n = parseInt(rest.find((x) => /^\d+$/.test(x)), 10) || 200;
      if (follow) await followLogs(); else showLogs(n);
      break;
    }
    case 'test': {
      const id = rest[0];
      const api = APIS.find((a) => a.id === id);
      if (!api) { console.log(red(`Unknown api "${id}". Options: ${APIS.filter((a) => a.kind !== 'note').map((a) => a.id).join(', ')}`)); process.exitCode = 1; break; }
      await printOneTest(api);
      break;
    }
    case 'test-all': for (const api of APIS) { if (api.kind !== 'note') await printOneTest(api); } break;
    case 'deploy': deployCommands(); break;
    case 'get': {
      const key = rest[0];
      if (!key) { console.log(red('usage: get <KEY>')); process.exitCode = 1; break; }
      const s = SCHEMA.find((x) => x.key === key);
      const val = VALUES[key] != null ? VALUES[key] : (readEnvValues()[key] || '');
      if (s && s.type === 'secret' && val) console.log(`${key}=(hidden, ${val.length} chars)`);
      else console.log(`${key}=${val}`);
      break;
    }
    case 'set': {
      const key = rest[0];
      const val = rest.slice(1).join(' ');
      if (!key) { console.log(red('usage: set <KEY> <VALUE>')); process.exitCode = 1; break; }
      if (!SCHEMA.find((x) => x.key === key)) console.log(yellow(`note: ${key} is not a known setting — writing it anyway.`));
      VALUES[key] = val;
      saveEnv();
      console.log(green(`Set ${key} in .env (backup: .env.bak). Restart the bot to apply.`));
      break;
    }
    case 'web': {
      const action = rest[0] || 'status';
      if (action === 'status') await printWebStatus();
      else if (['start', 'stop', 'restart'].includes(action)) webControl(action);
      else if (action === 'logs') {
        if (rest.includes('-f') || rest.includes('--follow')) {
          if (webInstalled()) {
            const cmd = [...SUDO, 'journalctl', '-u', WEB_SERVICE, '-f', '-n', '50', '--no-pager'];
            spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
          } else {
            spawnSync('tail', ['-n', '50', '-f', WEB_OUT_LOG], { stdio: 'inherit' });
          }
        } else webLogs(200);
      } else { console.log(red('usage: web <status|start|stop|restart|logs>')); process.exitCode = 1; }
      break;
    }
    case '-h': case '--help': case 'help': usage(); break;
    default: console.log(red(`Unknown command: ${cmd}\n`)); usage(); process.exitCode = 1;
  }
}

// ─── Entry ────────────────────────────────────────────────────────
(async () => {
  const argv = process.argv.slice(2);
  try {
    if (argv.length === 0) await mainMenu();
    else await cli(argv);
  } catch (e) {
    console.error(red('Fatal: ' + (e && e.stack ? e.stack : e)));
    process.exitCode = 1;
  }
})();
