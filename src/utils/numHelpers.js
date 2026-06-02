/**
 * Numeric helpers — guarded math so divide-by-zero, NaN, and missing values
 * never propagate `Infinity` or `NaN` into embeds or LLM prompts.
 */

/**
 * Percent change from prev → cur. Returns null if either value is missing or
 * if prev is non-finite or zero. Callers should treat null as "no comparison".
 */
function pctChange(prev, cur) {
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return null;
    if (prev === 0) return null;
    return ((cur - prev) / prev) * 100;
}

/**
 * Safe division. Returns `fallback` (default 0) if denominator is zero or
 * either operand is non-finite.
 */
function safeDiv(num, denom, fallback = 0) {
    if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return fallback;
    return num / denom;
}

/**
 * Clamp value into [min, max].
 */
function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

/**
 * Format a percent value with sign and fixed digits, or '—' if null/NaN.
 */
function formatPct(v, digits = 2) {
    if (!Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(digits)}%`;
}

/**
 * Round to N decimal places, returning a Number (not a string).
 */
function round(v, digits = 2) {
    if (!Number.isFinite(v)) return null;
    const factor = 10 ** digits;
    return Math.round(v * factor) / factor;
}

/**
 * Compute a percentile rank of `value` within a sorted ascending `series`.
 * Returns 0..1.
 */
function percentile(series, value) {
    if (!series || series.length === 0) return null;
    const sorted = [...series].sort((a, b) => a - b);
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo / sorted.length;
}

module.exports = { pctChange, safeDiv, clamp, formatPct, round, percentile };
