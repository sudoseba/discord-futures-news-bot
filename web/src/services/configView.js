'use strict';
/** Read-only, redacted view of the bot's configuration + the web audit log. */
const { webDb } = require('../db');
const config = require('../config');

// Mirrors the bot's settable keys (secrets are masked, never returned raw).
const SCHEMA = [
  { key: 'DISCORD_TOKEN', label: 'Bot Token', cat: 'Discord', secret: true },
  { key: 'DISCORD_CLIENT_ID', label: 'Client / App ID', cat: 'Discord' },
  { key: 'DISCORD_GUILD_ID', label: 'Guild (Server) ID', cat: 'Discord' },
  { key: 'AUTO_POST_CHANNEL_ID', label: 'Auto-Post Channel', cat: 'Discord' },
  { key: 'NEWS_API_KEY', label: 'NewsAPI.org Key', cat: 'News APIs', secret: true },
  { key: 'BENZINGA_API_KEY', label: 'Benzinga Key', cat: 'News APIs', secret: true },
  { key: 'FINNHUB_API_KEY', label: 'Finnhub Key', cat: 'News APIs', secret: true },
  { key: 'CEREBRAS_API_KEY', label: 'Cerebras Key', cat: 'AI & Voice', secret: true },
  { key: 'CEREBRAS_MODEL', label: 'Cerebras Model', cat: 'AI & Voice', default: 'gpt-oss-120b' },
  { key: 'DEEPGRAM_TTS_API_KEY', label: 'Deepgram TTS Key', cat: 'AI & Voice', secret: true },
  { key: 'ALPHA_VANTAGE_API_KEY', label: 'Alpha Vantage Key', cat: 'Market Data', secret: true },
  { key: 'SCHEDULE_TIMEZONE', label: 'Timezone', cat: 'Schedules', default: 'America/New_York' },
  { key: 'BRIEFING_CRON', label: 'Morning Briefing', cat: 'Schedules', default: '0 8 * * 1-5' },
  { key: 'RECAP_CRON', label: 'Daily Recap', cat: 'Schedules', default: '30 16 * * 1-5' },
  { key: 'ANOMALY_SCAN_CRON', label: 'Anomaly Scan', cat: 'Schedules', default: '*/15 * * * *' },
  { key: 'LOG_LEVEL', label: 'Log Level', cat: 'Behavior', default: 'info' },
  { key: 'HEALTHZ_PORT', label: 'Health Port', cat: 'Behavior', default: '3000' },
];

function displayValue(s) {
  const raw = process.env[s.key] || '';
  if (s.secret) return raw ? { masked: true, hint: `set (${raw.length} chars)`, set: true } : { masked: true, hint: 'not set', set: false };
  if (raw) return { value: raw, set: true };
  if (s.default) return { value: s.default, isDefault: true, set: false };
  return { value: '', set: false };
}

function getConfig() {
  const byCat = new Map();
  for (const s of SCHEMA) {
    if (!byCat.has(s.cat)) byCat.set(s.cat, []);
    byCat.get(s.cat).push({ key: s.key, label: s.label, secret: !!s.secret, ...displayValue(s) });
  }
  return {
    categories: [...byCat.entries()].map(([name, items]) => ({ name, items })),
    dashboard: config.redactedSummary(),
  };
}

const auditStmt = webDb.prepare('SELECT ts, user_id, username, action, detail, ip FROM audit_log ORDER BY id DESC LIMIT ?');
function getAudit(limit = 50) {
  return auditStmt.all(limit).map((r) => ({
    ts: r.ts,
    userId: r.user_id,
    username: r.username,
    action: r.action,
    detail: r.detail,
    ip: r.ip,
  }));
}

module.exports = { getConfig, getAudit };
