'use strict';
/**
 * Thin, dependency-free Discord OAuth2 client (authorization-code flow).
 * Uses Node 20's global fetch. Every call has a hard timeout.
 *
 * Scopes requested: identify, guilds.members.read
 *   → lets us read the user's identity and their roles in our guild without
 *     needing the bot token.
 */
const config = require('../config');
const log = require('../logger').child('discord-oauth');

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 8000;

async function apiFetch(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Build the URL we redirect the user to in order to log in. */
function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.discord.redirectUri,
    response_type: 'code',
    scope: config.discord.scopes.join(' '),
    state,
    prompt: 'none',
  });
  return `${API}/oauth2/authorize?${p.toString()}`;
}

/** Exchange an authorization code for an access token. */
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri,
  });
  const res = await apiFetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log.warn({ status: res.status, body: text.slice(0, 200) }, 'token exchange failed');
    throw new Error(`token exchange failed (HTTP ${res.status})`);
  }
  return res.json(); // { access_token, token_type, expires_in, scope, ... }
}

/** GET /users/@me — the logged-in user's identity. */
async function fetchCurrentUser(accessToken) {
  const res = await apiFetch(`${API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`fetch user failed (HTTP ${res.status})`);
  return res.json(); // { id, username, global_name, avatar, ... }
}

/**
 * GET /users/@me/guilds/{guild}/member — the user's membership + roles in our
 * guild. Returns null if they are not a member (HTTP 404).
 */
async function fetchGuildMember(accessToken, guildId) {
  const res = await apiFetch(`${API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch guild member failed (HTTP ${res.status})`);
  return res.json(); // { roles: [...], nick, joined_at, user, ... }
}

/** Build the CDN URL for a user's avatar (or a default). */
function avatarUrl(userId, avatarHash) {
  if (!avatarHash) {
    let idx = 0;
    try { idx = Number((BigInt(userId) >> 22n) % 6n); } catch { idx = 0; } // local users have non-numeric ids
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=64`;
}

module.exports = { authorizeUrl, exchangeCode, fetchCurrentUser, fetchGuildMember, avatarUrl };
