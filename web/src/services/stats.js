'use strict';
/** Aggregate read-only queries over the bot's SQLite DB. */
const { botAll, botGet, botAvailable } = require('../db');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Headline counters for the dashboard home. */
function getOverview() {
  if (!botAvailable()) return { available: false };

  const one = (sql, ...p) => num(botGet(sql, ...p)?.n);
  const nowMs = Date.now();

  const lastScan = botGet(
    `SELECT recorded_at, anomalies_detected, anomalies_posted
       FROM anomaly_scans ORDER BY recorded_at DESC LIMIT 1`,
  );

  return {
    available: true,
    subscribers: one(`SELECT COUNT(*) n FROM anomaly_subscribers WHERE active = 1`),
    pendingPosts: one(`SELECT COUNT(*) n FROM pending_posts`),
    anomalies24h: one(`SELECT COUNT(*) n FROM anomaly_events WHERE recorded_at >= datetime('now','-1 day')`),
    anomalies7d: one(`SELECT COUNT(*) n FROM anomaly_events WHERE recorded_at >= datetime('now','-7 days')`),
    articles24h: one(`SELECT COUNT(*) n FROM news_articles WHERE recorded_at >= datetime('now','-1 day')`),
    llm24h: one(`SELECT COUNT(*) n FROM llm_outputs WHERE recorded_at >= datetime('now','-1 day')`),
    snapshots24h: one(`SELECT COUNT(*) n FROM market_snapshots WHERE recorded_at >= datetime('now','-1 day')`),
    unresolvedSignals: one(`SELECT COUNT(*) n FROM signal_replay WHERE resolved_at IS NULL`),
    lastScan: lastScan
      ? { at: sqlTs(lastScan.recorded_at), detected: lastScan.anomalies_detected, posted: lastScan.anomalies_posted }
      : null,
    generatedAt: nowMs,
  };
}

/** Anomaly counts grouped by type + severity over a window. */
function getAnomalyBreakdown(days = 7) {
  return botAll(
    `SELECT anomaly_type, severity, COUNT(*) AS count, SUM(was_posted) AS posted, MAX(recorded_at) AS last_seen
       FROM anomaly_events
      WHERE recorded_at >= datetime('now','-' || ? || ' days')
      GROUP BY anomaly_type, severity
      ORDER BY count DESC`,
    days,
  ).map((r) => ({ ...r, last_seen: sqlTs(r.last_seen) }));
}

/** Signal-replay scorecard aggregated by signal type + direction. */
function getScorecard(days = 30) {
  const since = Date.now() - days * 86400_000;
  const rows = botAll(
    `SELECT signal_type, direction,
            COUNT(*) AS total,
            SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
            AVG(pnl_1h_pct)  AS avg_1h,
            AVG(pnl_4h_pct)  AS avg_4h,
            AVG(pnl_24h_pct) AS avg_24h,
            SUM(CASE WHEN pnl_24h_pct > 0 THEN 1 ELSE 0 END)          AS wins_24h,
            SUM(CASE WHEN pnl_24h_pct IS NOT NULL THEN 1 ELSE 0 END)  AS graded_24h
       FROM signal_replay
      WHERE captured_at >= ?
      GROUP BY signal_type, direction
      ORDER BY total DESC`,
    since,
  );
  return rows.map((r) => ({
    signalType: r.signal_type,
    direction: r.direction,
    total: r.total,
    resolved: r.resolved,
    avg1h: round(r.avg_1h),
    avg4h: round(r.avg_4h),
    avg24h: round(r.avg_24h),
    winRate24h: r.graded_24h ? Math.round((r.wins_24h / r.graded_24h) * 100) : null,
    graded24h: r.graded_24h,
  }));
}

/** Recent anomaly events (for the anomalies view). */
function getRecentAnomalies(limit = 50) {
  return botAll(
    `SELECT id, anomaly_type, severity, title, description, was_posted, recorded_at
       FROM anomaly_events ORDER BY id DESC LIMIT ?`,
    limit,
  ).map((r) => ({
    id: r.id,
    type: r.anomaly_type,
    severity: r.severity,
    title: r.title,
    description: r.description,
    posted: !!r.was_posted,
    ts: sqlTs(r.recorded_at),
  }));
}

/** Recent anomaly scan cadence (for a sparkline / health view). */
function getScanHistory(limit = 30) {
  return botAll(
    `SELECT id, anomalies_detected, anomalies_posted, recorded_at
       FROM anomaly_scans ORDER BY id DESC LIMIT ?`,
    limit,
  ).map((r) => ({ id: r.id, detected: r.anomalies_detected, posted: r.anomalies_posted, ts: sqlTs(r.recorded_at) })).reverse();
}

// ─── cursors for the realtime pump ──────────────────────────────────────────
function maxAnomalyId() { return num(botGet(`SELECT MAX(id) n FROM anomaly_events`)?.n); }
function anomaliesSince(id) {
  return botAll(
    `SELECT id, anomaly_type, severity, title, description, recorded_at
       FROM anomaly_events WHERE id > ? ORDER BY id ASC LIMIT 50`,
    id,
  ).map((r) => ({ id: r.id, type: r.anomaly_type, severity: r.severity, title: r.title, description: r.description, ts: sqlTs(r.recorded_at) }));
}
function maxLlmId() { return num(botGet(`SELECT MAX(id) n FROM llm_outputs`)?.n); }
function llmSince(id) {
  return botAll(
    `SELECT id, output_type, symbol, model, recorded_at
       FROM llm_outputs WHERE id > ? ORDER BY id ASC LIMIT 50`,
    id,
  ).map((r) => ({ id: r.id, outputType: r.output_type, symbol: r.symbol, model: r.model, ts: sqlTs(r.recorded_at) }));
}

// ─── helpers ────────────────────────────────────────────────────────────────
function sqlTs(s) {
  if (!s) return null;
  const ms = Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
}
function round(v) { return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }

module.exports = {
  getOverview,
  getAnomalyBreakdown,
  getScorecard,
  getRecentAnomalies,
  getScanHistory,
  maxAnomalyId,
  anomaliesSince,
  maxLlmId,
  llmSince,
  sqlTs,
};
