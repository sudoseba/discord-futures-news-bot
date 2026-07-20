'use strict';
/**
 * Server-side sessions with an HMAC-signed cookie.
 *
 * The cookie carries `<sid>.<hmac(sid)>`; the session row lives in webdash.db so
 * it can be revoked and audited. The signature prevents a client from forging a
 * session id. Sessions expire and are swept periodically.
 */
const crypto = require('crypto');
const cookie = require('cookie');
const { webDb } = require('../db');
const config = require('../config');
const log = require('../logger').child('sessions');

const COOKIE_NAME = 'dnb_sess';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── prepared statements ────────────────────────────────────────────────────
const q = {
  insert: webDb.prepare(`
    INSERT INTO sessions (sid, user_id, username, global_name, avatar, is_member, is_admin,
                          roles_json, created_at, last_seen_at, expires_at, ip, user_agent)
    VALUES (@sid, @user_id, @username, @global_name, @avatar, @is_member, @is_admin,
            @roles_json, @created_at, @last_seen_at, @expires_at, @ip, @user_agent)`),
  get: webDb.prepare('SELECT * FROM sessions WHERE sid = ?'),
  touch: webDb.prepare('UPDATE sessions SET last_seen_at = ? WHERE sid = ?'),
  del: webDb.prepare('DELETE FROM sessions WHERE sid = ?'),
  sweep: webDb.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  insState: webDb.prepare('INSERT INTO oauth_states (state, created_at, redirect_to) VALUES (?, ?, ?)'),
  getState: webDb.prepare('SELECT * FROM oauth_states WHERE state = ?'),
  delState: webDb.prepare('DELETE FROM oauth_states WHERE state = ?'),
  sweepState: webDb.prepare('DELETE FROM oauth_states WHERE created_at < ?'),
  audit: webDb.prepare('INSERT INTO audit_log (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)'),
};

// ─── signing ────────────────────────────────────────────────────────────────
function sign(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
}
function signedValue(sid) {
  return `${sid}.${sign(sid)}`;
}
function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  const sid = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = sign(sid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return sid;
}

// ─── audit ──────────────────────────────────────────────────────────────────
function audit(action, { userId = null, username = null, detail = null, ip = null } = {}) {
  try {
    q.audit.run(Date.now(), userId, username, action, detail, ip);
  } catch (err) {
    log.error({ err: err.message, action }, 'audit write failed');
  }
}

// ─── OAuth state (CSRF) ─────────────────────────────────────────────────────
function createState(redirectTo = '/') {
  const state = crypto.randomBytes(24).toString('base64url');
  q.insState.run(state, Date.now(), redirectTo);
  return state;
}
function consumeState(state) {
  const row = q.getState.get(state);
  if (row) q.delState.run(state);
  if (!row) return null;
  if (Date.now() - row.created_at > STATE_TTL_MS) return null;
  return row.redirect_to || '/';
}

// ─── sessions ───────────────────────────────────────────────────────────────
function createSession(user, { ip, userAgent } = {}) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q.insert.run({
    sid,
    user_id: user.id,
    username: user.username || null,
    global_name: user.globalName || null,
    avatar: user.avatar || null,
    is_member: user.isMember ? 1 : 0,
    is_admin: user.isAdmin ? 1 : 0,
    roles_json: JSON.stringify(user.roles || []),
    created_at: now,
    last_seen_at: now,
    expires_at: now + SESSION_TTL_MS,
    ip: ip || null,
    user_agent: userAgent || null,
  });
  return { sid, cookie: signedValue(sid), expiresAt: now + SESSION_TTL_MS };
}

function getSessionFromCookieHeader(cookieHeader) {
  const parsed = cookie.parse(cookieHeader || '');
  const signed = parsed[COOKIE_NAME];
  if (!signed) return null;
  const sid = unsign(signed);
  if (!sid) return null;
  const row = q.get.get(sid);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    q.del.run(sid);
    return null;
  }
  // Throttle last_seen writes to at most once a minute.
  if (Date.now() - row.last_seen_at > 60_000) q.touch.run(Date.now(), sid);
  return {
    sid: row.sid,
    userId: row.user_id,
    username: row.username,
    globalName: row.global_name,
    avatar: row.avatar,
    isMember: !!row.is_member,
    isAdmin: !!row.is_admin,
    roles: safeParse(row.roles_json, []),
  };
}

function destroySession(sid) {
  if (sid) q.del.run(sid);
}

// ─── cookie helpers ─────────────────────────────────────────────────────────
function buildSetCookie(value, maxAgeMs) {
  return cookie.serialize(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}
function buildClearCookie() {
  return cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: 0,
  });
}

// ─── periodic sweep ─────────────────────────────────────────────────────────
function sweep() {
  try {
    const s = q.sweep.run(Date.now()).changes;
    const st = q.sweepState.run(Date.now() - STATE_TTL_MS).changes;
    if (s || st) log.debug({ sessions: s, states: st }, 'swept expired');
  } catch (err) {
    log.error({ err: err.message }, 'sweep failed');
  }
}

function safeParse(json, def) {
  try { return JSON.parse(json); } catch { return def; }
}

module.exports = {
  COOKIE_NAME,
  createSession,
  getSessionFromCookieHeader,
  destroySession,
  buildSetCookie,
  buildClearCookie,
  createState,
  consumeState,
  audit,
  sweep,
  SESSION_TTL_MS,
};
