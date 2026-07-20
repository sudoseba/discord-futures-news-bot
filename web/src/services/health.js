'use strict';
/** Proxies the bot's /healthz endpoint with a short cache. */
const config = require('../config');

let cache = { at: 0, ok: false, status: 0, data: null, error: null };
const TTL_MS = 2000;

async function getHealth(force = false) {
  const now = Date.now();
  if (!force && now - cache.at < TTL_MS) return cache;

  const url = config.bot.healthzUrl;
  const ctrl = new AbortController();
  // 9s: longer than the bot DB's 5s busy_timeout, so a healthz query that waits
  // on a lock (bot mid-write) doesn't get read as "bot down".
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    cache = { at: now, ok: res.ok, status: res.status, data, error: null, url };
  } catch (err) {
    const code = err.cause?.code || err.code;
    const msg = err.name === 'AbortError' ? `timed out after 9s (${url})`
      : code === 'ECONNREFUSED' ? `connection refused — nothing listening at ${url}`
        : code ? `${code} → ${url}`
          : `${err.message} → ${url}`;
    cache = { at: now, ok: false, status: 0, data: null, error: msg, url };
  } finally {
    clearTimeout(t);
  }
  return cache;
}

module.exports = { getHealth };
