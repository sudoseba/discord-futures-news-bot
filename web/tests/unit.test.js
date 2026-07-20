'use strict';
// Pure-logic unit tests (node --test). Uses a throwaway webdash DB so it never
// touches real data. Requires deps to be installed (better-sqlite3 etc.).
const os = require('os');
const path = require('path');

process.env.SESSION_SECRET = 'unit-test-secret-000000000000000000';
process.env.WEBDASH_DB_PATH = path.join(os.tmpdir(), `webdash-test-${process.pid}.db`);
process.env.LOG_LEVEL = 'silent';
process.env.BOT_DB_PATH = path.join(os.tmpdir(), `nonexistent-bot-${process.pid}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { avatarUrl } = require('../src/auth/discord');
const { sqlTs } = require('../src/services/stats');
const sessions = require('../src/auth/sessions');

test('avatarUrl falls back to a default avatar (0-5) when no hash', () => {
  assert.match(avatarUrl('80351110224678912', null), /embed\/avatars\/[0-5]\.png$/);
});

test('avatarUrl builds a CDN url from a hash', () => {
  assert.strictEqual(avatarUrl('123', 'abc'), 'https://cdn.discordapp.com/avatars/123/abc.png?size=64');
});

test('avatarUrl serves gif for animated (a_) hashes', () => {
  assert.match(avatarUrl('1', 'a_deadbeef'), /a_deadbeef\.gif/);
});

test('sqlTs parses sqlite datetime() output as UTC', () => {
  const ms = sqlTs('2026-07-19 12:00:00');
  assert.strictEqual(new Date(ms).toISOString(), '2026-07-19T12:00:00.000Z');
});

test('sqlTs is null-safe', () => {
  assert.strictEqual(sqlTs(null), null);
  assert.strictEqual(sqlTs(''), null);
});

test('a created session round-trips through its signed cookie', () => {
  const { cookie } = sessions.createSession({ id: '42', username: 'tester', roles: [], isMember: true, isAdmin: false });
  const s = sessions.getSessionFromCookieHeader(`${sessions.COOKIE_NAME}=${cookie}`);
  assert.ok(s, 'session should resolve');
  assert.strictEqual(s.userId, '42');
  assert.strictEqual(s.isMember, true);
});

test('a tampered cookie signature is rejected', () => {
  const { cookie } = sessions.createSession({ id: '99', roles: [] });
  const flipped = cookie.slice(0, -2) + (cookie.slice(-2) === 'aa' ? 'bb' : 'aa');
  const s = sessions.getSessionFromCookieHeader(`${sessions.COOKIE_NAME}=${flipped}`);
  assert.strictEqual(s, null);
});

test('oauth state can be consumed exactly once', () => {
  const state = sessions.createState('/somewhere');
  assert.strictEqual(sessions.consumeState(state), '/somewhere');
  assert.strictEqual(sessions.consumeState(state), null); // already consumed
});
