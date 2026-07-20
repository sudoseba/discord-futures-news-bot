'use strict';
/**
 * Configuration loader + validator for the web dashboard.
 *
 * Precedence: web/.env  >  repo-root/.env  >  built-in defaults.
 * (dotenv never overwrites an already-set process.env var, so loading
 * web/.env first gives it priority, then the bot's .env fills the gaps —
 * that's how CLIENT_ID / CLIENT_SECRET / GUILD_ID are inherited.)
 *
 * Fails fast with a clear message on misconfiguration.
 */
const path = require('path');
const crypto = require('crypto');

const WEB_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(WEB_DIR, '..');

// Load web/.env first (priority), then the bot's .env (fallback).
require('dotenv').config({ path: path.join(WEB_DIR, '.env') });
require('dotenv').config({ path: path.join(REPO_DIR, '.env') });

const warnings = [];

const str = (name, def = undefined) => {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
};
const int = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
};
const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
};
const list = (name) =>
  (str(name, '') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// ─── Core ─────────────────────────────────────────────────────────────────
const nodeEnv = str('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

const port = int('WEB_PORT', 8080);
const host = str('WEB_HOST', '0.0.0.0');
const publicUrl = (str('WEB_PUBLIC_URL', `http://localhost:${port}`) || '').replace(/\/+$/, '');

// ─── Session secret ───────────────────────────────────────────────────────
let sessionSecret = str('SESSION_SECRET');
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(48).toString('base64url');
  warnings.push(
    'SESSION_SECRET is not set — generated an EPHEMERAL secret. All sessions ' +
      'will be invalidated on restart. Set one with `npm run secret` for production.',
  );
} else if (sessionSecret.length < 16) {
  warnings.push('SESSION_SECRET is short (<16 chars) — use a long random value (`npm run secret`).');
}

// ─── Discord OAuth2 ───────────────────────────────────────────────────────
const discord = {
  clientId: str('DISCORD_CLIENT_ID'),
  clientSecret: str('DISCORD_CLIENT_SECRET'),
  guildId: str('DISCORD_GUILD_ID'),
  redirectUri: str('OAUTH_REDIRECT_URI') || `${publicUrl}/auth/callback`,
  scopes: ['identify', 'guilds.members.read'],
};

const authConfigured = Boolean(discord.clientId && discord.clientSecret);
if (!authConfigured) {
  warnings.push(
    'Discord OAuth is NOT configured (need DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET, ' +
      'inherited from ../.env or set here). Login will be disabled until you set them.',
  );
}
if (authConfigured && !discord.guildId) {
  warnings.push('DISCORD_GUILD_ID is not set — guild membership cannot be verified.');
}

// ─── Access control ───────────────────────────────────────────────────────
const access = {
  requireGuildMembership: bool('REQUIRE_GUILD_MEMBERSHIP', true),
  adminUserIds: list('ADMIN_USER_IDS'),
  adminRoleId: str('ADMIN_ROLE_ID'),
};
if (access.adminUserIds.length === 0 && !access.adminRoleId) {
  warnings.push(
    'No admins configured (ADMIN_USER_IDS / ADMIN_ROLE_ID empty) — admin-only ' +
      'views (config, API tests, logs) will be inaccessible to everyone.',
  );
}

// ─── Bot integration ──────────────────────────────────────────────────────
const botHealthzPort = int('HEALTHZ_PORT', 3000); // inherited from bot .env
const bot = {
  healthzUrl: str('BOT_HEALTHZ_URL', `http://127.0.0.1:${botHealthzPort}/healthz`),
  dbPath: str('BOT_DB_PATH', path.join(REPO_DIR, 'data', 'bot.db')),
};
const webDbPath = str('WEBDASH_DB_PATH', path.join(REPO_DIR, 'data', 'webdash.db'));

// ─── Logging ──────────────────────────────────────────────────────────────
const logging = {
  level: str('LOG_LEVEL', 'info'),
  pretty: bool('LOG_PRETTY', !isProd),
};

// Cookies: secure only when the public URL is https (so http-over-Tailnet works).
const cookieSecure = publicUrl.startsWith('https://');

// Local-preview auth bypass. Double-gated: ignored entirely in production.
const devAuth = !isProd && bool('DEV_AUTH', false);
if (devAuth) {
  warnings.push(
    'DEV_AUTH is ON — /auth/dev grants a mock ADMIN session without Discord. ' +
      'For local preview only; it is force-disabled when NODE_ENV=production.',
  );
}

module.exports = {
  nodeEnv,
  isProd,
  port,
  host,
  publicUrl,
  sessionSecret,
  cookieSecure,
  discord,
  authConfigured,
  devAuth,
  access,
  bot,
  webDbPath,
  logging,
  paths: { WEB_DIR, REPO_DIR },
  warnings,
  /** A log-safe view with secrets redacted. */
  redactedSummary() {
    return {
      nodeEnv,
      listen: `${host}:${port}`,
      publicUrl,
      redirectUri: discord.redirectUri,
      authConfigured,
      devAuth,
      guildId: discord.guildId || null,
      requireGuildMembership: access.requireGuildMembership,
      admins: { userIds: access.adminUserIds.length, roleId: Boolean(access.adminRoleId) },
      botHealthzUrl: bot.healthzUrl,
      botDbPath: bot.dbPath,
      webDbPath,
      logLevel: logging.level,
      cookieSecure,
    };
  },
};
