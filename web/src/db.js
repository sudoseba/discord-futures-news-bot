'use strict';
/**
 * Database connections.
 *
 *  - bot.db     : the bot's SQLite database, opened READ-ONLY. The bot is the
 *                 single writer; WAL mode lets us read concurrently without
 *                 blocking it. Opened lazily and retried, so the dashboard can
 *                 start before the bot has created the file.
 *  - webdash.db : our own read/write database for sessions, OAuth state and an
 *                 audit log. We never write to the bot's DB.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const log = require('./logger').child('db');

// ─── webdash.db (read/write, ours) ──────────────────────────────────────────
fs.mkdirSync(path.dirname(config.webDbPath), { recursive: true });

const webDb = new Database(config.webDbPath);
webDb.pragma('journal_mode = WAL');
webDb.pragma('synchronous = NORMAL');
webDb.pragma('busy_timeout = 5000');
webDb.pragma('foreign_keys = ON');

function migrateWebDb() {
  webDb.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid          TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      username     TEXT,
      global_name  TEXT,
      avatar       TEXT,
      is_member    INTEGER DEFAULT 0,
      is_admin     INTEGER DEFAULT 0,
      roles_json   TEXT,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      ip           TEXT,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      redirect_to TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      user_id  TEXT,
      username TEXT,
      action   TEXT NOT NULL,
      detail   TEXT,
      ip       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
  `);
}
migrateWebDb();
log.info({ path: config.webDbPath }, 'webdash DB ready');

// ─── bot.db (read-only, lazy + retrying) ────────────────────────────────────
let _botDb = null;
let _lastTryAt = 0;
const RETRY_MS = 5000;

function botDb() {
  if (_botDb) return _botDb;
  const now = Date.now();
  if (now - _lastTryAt < RETRY_MS) return null;
  _lastTryAt = now;
  try {
    const d = new Database(config.bot.dbPath, { readonly: true, fileMustExist: true });
    d.pragma('busy_timeout = 3000');
    _botDb = d;
    log.info({ path: config.bot.dbPath }, 'opened bot DB (read-only)');
    return _botDb;
  } catch (err) {
    log.warn({ path: config.bot.dbPath, err: err.message }, 'bot DB not available yet (will retry)');
    return null;
  }
}

function botAvailable() {
  return Boolean(botDb());
}

const _stmtCache = new Map();
function botStmt(sql) {
  const d = botDb();
  if (!d) return null;
  let s = _stmtCache.get(sql);
  if (!s) {
    s = d.prepare(sql);
    _stmtCache.set(sql, s);
  }
  return s;
}

/** Safe SELECT-all: returns [] if the DB is unavailable or the query errors. */
function botAll(sql, ...params) {
  try {
    const s = botStmt(sql);
    return s ? s.all(...params) : [];
  } catch (err) {
    log.error({ err: err.message, sql: sql.slice(0, 80) }, 'botAll query failed');
    _resetBotDb();
    return [];
  }
}

/** Safe SELECT-one: returns null if the DB is unavailable or the query errors. */
function botGet(sql, ...params) {
  try {
    const s = botStmt(sql);
    return s ? s.get(...params) : null;
  } catch (err) {
    log.error({ err: err.message, sql: sql.slice(0, 80) }, 'botGet query failed');
    _resetBotDb();
    return null;
  }
}

// If a query blows up (e.g. the DB file was replaced/restored), drop the handle
// so the next call re-opens it.
function _resetBotDb() {
  try { _botDb?.close(); } catch { /* ignore */ }
  _botDb = null;
  _stmtCache.clear();
}

function closeAll() {
  try { webDb.close(); } catch { /* ignore */ }
  _resetBotDb();
  log.info('database connections closed');
}

module.exports = { webDb, botDb, botAvailable, botAll, botGet, closeAll };
