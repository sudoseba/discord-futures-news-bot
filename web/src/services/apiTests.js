'use strict';
/**
 * API connectivity tests (admin-only). Mirrors the terminal admin panel's
 * checks. Reads keys from process.env (the bot's .env is loaded by config).
 * Uses Node 20 global fetch with per-call timeouts.
 */
const log = require('../logger').child('api-tests');

const CATALOG = [
  { id: 'discord', name: 'Discord (bot token)', kind: 'key' },
  { id: 'newsapi', name: 'NewsAPI.org', kind: 'key' },
  { id: 'benzinga', name: 'Benzinga', kind: 'key' },
  { id: 'finnhub', name: 'Finnhub', kind: 'key' },
  { id: 'cerebras', name: 'Cerebras (AI / LLM)', kind: 'key' },
  { id: 'deepgram', name: 'Deepgram TTS', kind: 'key' },
  { id: 'alphavantage', name: 'Alpha Vantage', kind: 'key' },
  { id: 'yahoo', name: 'Yahoo Finance (no key)', kind: 'free' },
  { id: 'coingecko', name: 'CoinGecko (no key)', kind: 'free' },
  { id: 'altme', name: 'Alternative.me F&G (no key)', kind: 'free' },
];

function listCatalog() {
  return CATALOG.map(({ id, name, kind }) => ({ id, name, kind }));
}

async function http(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 8000);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, code: res.status, text, json };
  } catch (err) {
    return { ok: false, code: 0, text: '', json: null, err: err.message };
  } finally {
    clearTimeout(t);
  }
}

async function runTest(id) {
  const env = process.env;
  const t0 = Date.now();
  let ok = false;
  let msg = '';
  try {
    switch (id) {
      case 'discord': {
        if (!env.DISCORD_TOKEN) { msg = 'No token set'; break; }
        const r = await http('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` } });
        if (r.ok) { ok = true; msg = `OK - ${r.json?.username} (id ${r.json?.id})`; } else msg = err(r);
        break;
      }
      case 'newsapi': {
        if (!env.NEWS_API_KEY) { msg = 'No key set'; break; }
        const r = await http(`https://newsapi.org/v2/top-headlines?category=business&country=us&pageSize=1&apiKey=${env.NEWS_API_KEY}`);
        if (r.ok && r.json?.status === 'ok') { ok = true; msg = `OK - ${r.json.totalResults} results`; } else msg = r.json?.message || err(r);
        break;
      }
      case 'benzinga': {
        if (!env.BENZINGA_API_KEY) { msg = 'No key set'; break; }
        const r = await http(`https://api.benzinga.com/api/v2/news?token=${env.BENZINGA_API_KEY}&pageSize=1`);
        if (r.ok) { ok = true; msg = 'OK - endpoint responded (200)'; } else msg = err(r);
        break;
      }
      case 'finnhub': {
        if (!env.FINNHUB_API_KEY) { msg = 'No key set'; break; }
        const r = await http(`https://finnhub.io/api/v1/quote?symbol=AAPL&token=${env.FINNHUB_API_KEY}`);
        if (r.ok && r.json?.c) { ok = true; msg = `OK - AAPL $${r.json.c}`; }
        else if (r.ok) msg = '200 but empty payload - key likely invalid/plan-limited';
        else msg = err(r);
        break;
      }
      case 'cerebras': {
        if (!env.CEREBRAS_API_KEY) { msg = 'No key set'; break; }
        const model = env.CEREBRAS_MODEL || 'gpt-oss-120b';
        const r = await http('https://api.cerebras.ai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }], max_tokens: 10, temperature: 0 }),
          timeoutMs: 20000,
        });
        const content = r.json?.choices?.[0]?.message?.content;
        if (r.ok && content) { ok = true; msg = `OK (${model}) - replied: '${content}'`; }
        else if (r.ok) msg = `200 but EMPTY content. Check model '${model}' / quota.`;
        else msg = err(r);
        break;
      }
      case 'deepgram': {
        if (!env.DEEPGRAM_TTS_API_KEY) { msg = 'No key set'; break; }
        const r = await http('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${env.DEEPGRAM_TTS_API_KEY}` } });
        if (r.ok) { ok = true; msg = 'OK - key valid'; } else msg = err(r);
        break;
      }
      case 'alphavantage': {
        if (!env.ALPHA_VANTAGE_API_KEY) { msg = 'No key set'; break; }
        const r = await http(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${env.ALPHA_VANTAGE_API_KEY}`);
        const price = r.json?.['Global Quote']?.['05. price'];
        if (r.ok && price) { ok = true; msg = `OK - IBM $${price}`; }
        else if (r.json?.Note) msg = `Rate-limited: ${r.json.Note}`;
        else if (r.json?.Information) msg = String(r.json.Information);
        else msg = err(r);
        break;
      }
      case 'yahoo': {
        const r = await http('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d');
        const pr = r.json?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (r.ok) { ok = true; msg = pr ? `OK - AAPL $${pr}` : 'OK (200)'; } else msg = err(r);
        break;
      }
      case 'coingecko': {
        const r = await http('https://api.coingecko.com/api/v3/ping');
        if (r.ok) { ok = true; msg = 'OK - ping'; } else msg = err(r);
        break;
      }
      case 'altme': {
        const r = await http('https://api.alternative.me/fng/?limit=1');
        const d = r.json?.data?.[0];
        if (r.ok && d) { ok = true; msg = `OK - Fear&Greed ${d.value} (${d.value_classification})`; } else msg = err(r);
        break;
      }
      default:
        msg = 'Unknown test';
    }
  } catch (e) {
    msg = `Test error: ${e.message}`;
  }
  const result = { id, ok, msg, ms: Date.now() - t0 };
  log.info(result, `api-test ${id} → ${ok ? 'OK' : 'FAIL'}`);
  return result;
}

function err(r) {
  let m = '';
  if (r.json) m = r.json.message || (r.json.error && (r.json.error.message || r.json.error)) || '';
  if (!m) m = r.err || '';
  return r.code > 0 ? `HTTP ${r.code} - ${m}` : m || 'request failed';
}

module.exports = { listCatalog, runTest, CATALOG };
