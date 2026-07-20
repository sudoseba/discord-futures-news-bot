/**
 * Per-provider circuit breaker + health registry (process-global).
 *
 * After N consecutive failures a provider's breaker "opens" and callers skip it
 * for a cooldown window (so a dead/geo-blocked source stops adding latency to
 * every request). It half-opens after the cooldown — the next attempt decides
 * whether it re-closes (success) or re-opens (failure).
 *
 * The health snapshot is surfaced on /healthz and the admin panels.
 */
const THRESHOLD = 3; // consecutive failures before opening
const COOLDOWN_MS = 60_000; // how long the breaker stays open

const registry = new Map(); // name -> stats

function stat(name) {
  let s = registry.get(name);
  if (!s) {
    s = { name, consecutiveFails: 0, openUntil: 0, ok: 0, err: 0, lastOk: null, lastErr: null, lastErrMsg: null };
    registry.set(name, s);
  }
  return s;
}

function isOpen(name) {
  return stat(name).openUntil > Date.now();
}

function recordSuccess(name) {
  const s = stat(name);
  s.consecutiveFails = 0;
  s.openUntil = 0;
  s.ok += 1;
  s.lastOk = Date.now();
}

function recordFailure(name, message) {
  const s = stat(name);
  s.consecutiveFails += 1;
  s.err += 1;
  s.lastErr = Date.now();
  s.lastErrMsg = String(message || 'failure').slice(0, 200);
  if (s.consecutiveFails >= THRESHOLD) s.openUntil = Date.now() + COOLDOWN_MS;
}

/** Log-safe snapshot of all providers seen so far. */
function snapshot() {
  const now = Date.now();
  return [...registry.values()].map((s) => ({
    name: s.name,
    state: s.openUntil > now ? 'open' : s.consecutiveFails > 0 ? 'degraded' : 'closed',
    ok: s.ok,
    err: s.err,
    consecutiveFails: s.consecutiveFails,
    openForMs: s.openUntil > now ? s.openUntil - now : 0,
    lastOkAgoSec: s.lastOk ? Math.round((now - s.lastOk) / 1000) : null,
    lastErrMsg: s.lastErrMsg,
  }));
}

module.exports = { isOpen, recordSuccess, recordFailure, snapshot, THRESHOLD, COOLDOWN_MS };
