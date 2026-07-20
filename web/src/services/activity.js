'use strict';
/** A unified, human-readable recent-activity feed drawn from several tables. */
const { botAll, botAvailable } = require('../db');
const { sqlTs } = require('./stats');

/**
 * Merge recent anomalies, LLM outputs and delivery failures into one
 * reverse-chronological list.
 */
function getActivity(limit = 40) {
  if (!botAvailable()) return [];
  const items = [];

  for (const r of botAll(
    `SELECT id, anomaly_type, severity, title, recorded_at
       FROM anomaly_events ORDER BY id DESC LIMIT ?`,
    limit,
  )) {
    items.push({
      key: `anomaly:${r.id}`,
      type: 'anomaly',
      severity: r.severity,
      ts: sqlTs(r.recorded_at),
      title: r.title,
      detail: prettyType(r.anomaly_type),
    });
  }

  for (const r of botAll(
    `SELECT id, output_type, symbol, model, recorded_at
       FROM llm_outputs ORDER BY id DESC LIMIT ?`,
    limit,
  )) {
    items.push({
      key: `llm:${r.id}`,
      type: 'ai',
      severity: 'info',
      ts: sqlTs(r.recorded_at),
      title: `${cap(r.output_type)}${r.symbol ? ' · ' + r.symbol : ''} generated`,
      detail: r.model || 'llm',
    });
  }

  for (const r of botAll(
    `SELECT id, channel_id, attempts, last_error, created_at
       FROM pending_posts ORDER BY created_at DESC LIMIT 15`,
  )) {
    items.push({
      key: `pending:${r.id}`,
      type: 'delivery',
      severity: 'warn',
      ts: typeof r.created_at === 'number' ? r.created_at : sqlTs(r.created_at),
      title: `Post retry queued (attempt ${r.attempts})`,
      detail: (r.last_error || 'awaiting retry').slice(0, 120),
    });
  }

  return items
    .filter((i) => i.ts)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

function prettyType(t) {
  return String(t || '').replace(/_/g, ' ');
}
function cap(s) {
  s = String(s || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { getActivity };
