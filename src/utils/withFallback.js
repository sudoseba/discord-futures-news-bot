/**
 * Ordered-fallback runner with caching, cache-last-good, stampede protection,
 * and per-provider circuit breaking.
 *
 *   withFallback({ cache, key, ttl, providers })
 *
 * - Serves a fresh cached value if present (never caches null → no negative
 *   caching, which used to freeze an outage for the whole TTL).
 * - Tries each provider in order, skipping ones whose breaker is open.
 * - First provider returning a "valid" value wins → cached + remembered as
 *   last-good.
 * - If EVERY provider fails, returns the last-good value (stale) instead of
 *   null, so a transient outage of the only source doesn't blank the feature.
 * - Concurrent callers for the same key share one in-flight run (stampede).
 *
 * providers: [{ name, run: async () => data | null }]
 */
const breaker = require('./circuitBreaker');

const pending = new Map();
const lastGood = new Map(); // key -> { data, at }
const LAST_GOOD_MAX = 500;

function defaultValidate(data) {
  if (data == null) return false;
  if (Array.isArray(data) && data.length === 0) return false;
  return true;
}

function rememberGood(key, data) {
  if (lastGood.size >= LAST_GOOD_MAX && !lastGood.has(key)) {
    const oldest = lastGood.keys().next().value;
    if (oldest !== undefined) lastGood.delete(oldest);
  }
  lastGood.set(key, { data, at: Date.now() });
}

async function withFallback({ cache, key, ttl, providers, validate = defaultValidate, allowStale = true }) {
  if (cache) {
    const fresh = cache.get(key);
    if (fresh != null) return fresh;
  }
  if (pending.has(key)) return pending.get(key);

  const run = (async () => {
    try {
      for (const provider of providers) {
        if (!provider || typeof provider.run !== 'function') continue;
        if (breaker.isOpen(provider.name)) continue;
        try {
          const data = await provider.run();
          if (validate(data)) {
            breaker.recordSuccess(provider.name);
            if (cache) cache.set(key, data, ttl);
            rememberGood(key, data);
            return data;
          }
          breaker.recordFailure(provider.name, 'empty/invalid response');
        } catch (err) {
          breaker.recordFailure(provider.name, err.message);
        }
      }
      // Everything failed — serve stale last-good if we have it.
      if (allowStale) {
        const lg = lastGood.get(key);
        if (lg) {
          console.warn(`[Fallback] ${key}: all providers failed — serving last-good from ${Math.round((Date.now() - lg.at) / 1000)}s ago`);
          return lg.data;
        }
      }
      return null;
    } finally {
      pending.delete(key);
    }
  })();

  pending.set(key, run);
  return run;
}

/** For diagnostics: how many keys have a remembered last-good value. */
function lastGoodSize() { return lastGood.size; }

module.exports = withFallback;
module.exports.breaker = breaker;
module.exports.lastGoodSize = lastGoodSize;
