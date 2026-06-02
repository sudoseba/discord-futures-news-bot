/**
 * Persistent cooldown store backed by SQLite.
 * Survives bot restarts so anomalies / level-breaks / event interpretations
 * are not re-fired immediately after a deploy.
 */
const { getDb } = require('./database');
const log = require('../utils/logger').child('cooldown');

const stmts = {};

function s(name, sql) {
    if (!stmts[name]) stmts[name] = getDb().prepare(sql);
    return stmts[name];
}

function isOnCooldown(key) {
    try {
        const row = s('get', `SELECT expires_at FROM cooldowns WHERE key = ?`).get(key);
        if (!row) return false;
        if (row.expires_at <= Date.now()) {
            s('del', `DELETE FROM cooldowns WHERE key = ?`).run(key);
            return false;
        }
        return true;
    } catch (err) {
        log.warn({ key, err: err.message }, 'cooldown check failed; failing closed');
        return true; // Fail closed — don't spam if DB is broken.
    }
}

function setCooldown(key, ttlMs) {
    try {
        const expiresAt = Date.now() + ttlMs;
        s('set', `INSERT INTO cooldowns (key, expires_at)
                   VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`)
            .run(key, expiresAt);
    } catch (err) {
        log.warn({ key, err: err.message }, 'cooldown set failed');
    }
}

function clearExpired() {
    try {
        const result = s('purge', `DELETE FROM cooldowns WHERE expires_at < ?`).run(Date.now());
        if (result.changes > 0) log.debug({ purged: result.changes }, 'expired cooldowns cleared');
        return result.changes;
    } catch (err) {
        log.warn({ err: err.message }, 'cooldown purge failed');
        return 0;
    }
}

function getAll() {
    try {
        return s('all', `SELECT key, expires_at FROM cooldowns ORDER BY expires_at DESC LIMIT 200`).all();
    } catch { return []; }
}

module.exports = { isOnCooldown, setCooldown, clearExpired, getAll };
