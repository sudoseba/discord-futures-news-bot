/**
 * Signal Scorecard
 *
 * Records every alert at fire-time (price snapshot), then a periodic resolver
 * fetches forward prices at 1h, 4h, and 24h offsets and computes the PnL the
 * alert would have produced if a trader had taken the implied direction.
 *
 * This turns a vanity "alerts fired" feed into a measurable signal-quality
 * track record. Surfaced via /scorecard and a weekly summary post.
 */
const { getDb } = require('./database');
const { fetchQuote } = require('./marketDataService');
const log = require('../utils/logger').child('scorecard');
const { pctChange } = require('../utils/numHelpers');

const HORIZONS = [
    { col: 'price_1h', pnlCol: 'pnl_1h_pct', ms: 1 * 60 * 60 * 1000 },
    { col: 'price_4h', pnlCol: 'pnl_4h_pct', ms: 4 * 60 * 60 * 1000 },
    { col: 'price_24h', pnlCol: 'pnl_24h_pct', ms: 24 * 60 * 60 * 1000 },
];

const stmts = {};
function s(name, sql) {
    if (!stmts[name]) stmts[name] = getDb().prepare(sql);
    return stmts[name];
}

/**
 * Capture an alert at the moment it fires.
 *
 * @param {object} signal
 * @param {string} signal.signalType   - 'divergence' | 'price_spike' | 'level_break' | ...
 * @param {'bullish'|'bearish'} signal.direction
 * @param {string} signal.symbol
 * @param {number} signal.capturedPrice
 * @param {object} [signal.snapshot]    - Arbitrary JSON-serialisable context
 * @returns {number|null} insert id
 */
function captureSignal({ signalType, direction, symbol, capturedPrice, snapshot }) {
    if (!Number.isFinite(capturedPrice) || capturedPrice <= 0) return null;
    if (!signalType || !direction) return null;
    try {
        const result = s('insert', `INSERT INTO signal_replay
              (signal_type, direction, symbol, snapshot_json, captured_price, captured_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
            .run(signalType, direction, symbol || null,
                 snapshot ? JSON.stringify(snapshot) : null,
                 capturedPrice, Date.now());
        log.debug({ id: result.lastInsertRowid, signalType, direction, symbol, capturedPrice }, 'signal captured');
        return result.lastInsertRowid;
    } catch (err) {
        log.warn({ err: err.message, signalType, symbol }, 'capture failed');
        return null;
    }
}

/**
 * Resolve any rows whose horizon has elapsed. Pulls a fresh quote for each
 * symbol and writes the forward price and computed PnL into the row.
 */
async function resolvePending(maxBatch = 30) {
    const now = Date.now();
    let resolved = 0;
    let touched = 0;

    for (const h of HORIZONS) {
        let pending;
        try {
            pending = s(`pending_${h.col}`, `SELECT id, symbol, captured_price, captured_at, direction
                                              FROM signal_replay
                                              WHERE ${h.col} IS NULL
                                                AND captured_at + ? <= ?
                                              LIMIT ?`)
                .all(h.ms, now, maxBatch);
        } catch (err) {
            log.warn({ err: err.message, horizon: h.col }, 'pending query failed');
            continue;
        }
        if (pending.length === 0) continue;

        // Batch quotes by symbol so we don't double-fetch
        const symbolPrice = new Map();
        for (const row of pending) {
            if (!row.symbol) continue;
            if (!symbolPrice.has(row.symbol)) {
                try {
                    const q = await fetchQuote(row.symbol);
                    if (q?.current) symbolPrice.set(row.symbol, q.current);
                } catch (err) {
                    log.debug({ err: err.message, symbol: row.symbol }, 'forward quote failed');
                }
            }
            const fwd = symbolPrice.get(row.symbol);
            if (!Number.isFinite(fwd)) continue;
            const rawPct = pctChange(row.captured_price, fwd);
            if (rawPct == null) continue;
            // Bearish signals "win" when price drops, so flip the sign for PnL accounting.
            const pnl = row.direction === 'bearish' ? -rawPct : rawPct;
            try {
                s(`update_${h.col}`, `UPDATE signal_replay
                    SET ${h.col} = ?, ${h.pnlCol} = ?
                    WHERE id = ?`)
                    .run(fwd, +pnl.toFixed(4), row.id);
                touched++;
            } catch (err) {
                log.warn({ err: err.message, id: row.id }, 'horizon update failed');
            }
        }
        resolved += pending.length;
    }

    // Mark fully-resolved rows once all three horizons are filled
    try {
        const r = s('mark_resolved', `UPDATE signal_replay
            SET resolved_at = ?
            WHERE resolved_at IS NULL
              AND price_1h IS NOT NULL
              AND price_4h IS NOT NULL
              AND price_24h IS NOT NULL`)
            .run(now);
        if (r.changes > 0) log.info({ marked: r.changes }, 'signals fully resolved');
    } catch (err) {
        log.warn({ err: err.message }, 'resolved marker update failed');
    }

    if (touched > 0) log.info({ scanned: resolved, touched }, 'scorecard resolve tick');
    return touched;
}

/**
 * Aggregate win-rate and average PnL by signal type over the last N days.
 */
function summary({ daysBack = 30, signalType = null } = {}) {
    const since = Date.now() - daysBack * 86400_000;
    const where = signalType ? `WHERE signal_type = ? AND captured_at >= ?` : `WHERE captured_at >= ?`;
    const params = signalType ? [signalType, since] : [since];
    const rows = getDb().prepare(`
        SELECT
            signal_type,
            direction,
            COUNT(*) as total,
            SUM(CASE WHEN pnl_1h_pct  IS NOT NULL THEN 1 ELSE 0 END) as resolved_1h,
            SUM(CASE WHEN pnl_4h_pct  IS NOT NULL THEN 1 ELSE 0 END) as resolved_4h,
            SUM(CASE WHEN pnl_24h_pct IS NOT NULL THEN 1 ELSE 0 END) as resolved_24h,
            SUM(CASE WHEN pnl_1h_pct  > 0 THEN 1 ELSE 0 END) as win_1h,
            SUM(CASE WHEN pnl_4h_pct  > 0 THEN 1 ELSE 0 END) as win_4h,
            SUM(CASE WHEN pnl_24h_pct > 0 THEN 1 ELSE 0 END) as win_24h,
            AVG(pnl_1h_pct)  as avg_1h,
            AVG(pnl_4h_pct)  as avg_4h,
            AVG(pnl_24h_pct) as avg_24h
        FROM signal_replay
        ${where}
        GROUP BY signal_type, direction
        ORDER BY signal_type, direction
    `).all(...params);
    return rows;
}

module.exports = { captureSignal, resolvePending, summary, HORIZONS };
