'use strict';
/** Proxies the bot's /healthz endpoint with a short cache. */
const config = require('../config');

let cache = { at: 0, ok: false, status: 0, data: null, error: null };
const TTL_MS = 2000;

async function getHealth(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < TTL_MS) return cache;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(config.bot.healthzUrl, { signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    cache = { at: now, ok: res.ok, status: res.status, data, error: null };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timed out — bot not responding' : err.message;
    cache = { at: now, ok: false, status: 0, data: null, error: msg };
  } finally {
    clearTimeout(t);
  }
  return cache;
}

module.exports = { getHealth };
