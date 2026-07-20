'use strict';
/** Discord OAuth2 login / callback / logout routes. */
const express = require('express');
const config = require('../config');
const log = require('../logger').child('auth');
const discord = require('../auth/discord');
const sessions = require('../auth/sessions');
const access = require('../auth/access');
const localUsers = require('../auth/localUsers');
const { authLimiter, loginLimiter } = require('../middleware/security');

const router = express.Router();

// ─── Local username/password login ──────────────────────────────────────────
router.post('/local', loginLimiter, (req, res) => {
  if (!config.passwordAuthEnabled) return res.status(404).json({ error: 'password login is not enabled' });
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const user = localUsers.verify(username, password);
  if (!user) {
    sessions.audit('login_denied', { username: username.slice(0, 40), detail: 'bad local credentials', ip: req.ip });
    log.warn({ username }, 'local login failed');
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const sess = sessions.createSession(
    { id: user.id, username: user.username, globalName: user.username, avatar: null, isMember: true, isAdmin: user.isAdmin, roles: [] },
    { ip: req.ip, userAgent: req.headers['user-agent'] },
  );
  res.setHeader('Set-Cookie', sessions.buildSetCookie(sess.cookie, sessions.SESSION_TTL_MS));
  sessions.audit('login', { userId: user.id, username: user.username, detail: 'local ' + (user.isAdmin ? 'admin' : 'member'), ip: req.ip });
  log.info({ user: user.id, isAdmin: user.isAdmin }, 'local login ok');
  res.json({ ok: true });
});

// Kick off the OAuth flow.
router.get('/login', authLimiter, (req, res) => {
  if (!config.discordLoginEnabled) {
    return res.redirect('/login?error=disabled');
  }
  const redirectTo = sanitizeRedirect(req.query.redirect);
  const state = sessions.createState(redirectTo);
  res.redirect(discord.authorizeUrl(state));
});

// OAuth redirect target.
router.get('/callback', authLimiter, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    log.warn({ error }, 'oauth denied by user');
    return res.redirect('/login?error=denied');
  }
  if (!code || !state) return res.redirect('/login?error=invalid');

  const redirectTo = sessions.consumeState(String(state));
  if (redirectTo === null) return res.redirect('/login?error=state');

  try {
    const token = await discord.exchangeCode(String(code));
    const me = await discord.fetchCurrentUser(token.access_token);

    let roles = [];
    let isMember = false;
    if (config.discord.guildId) {
      const member = await discord.fetchGuildMember(token.access_token, config.discord.guildId);
      if (member) { isMember = true; roles = member.roles || []; }
    } else {
      isMember = true; // membership can't be verified without a guild id
    }

    if (!access.isAllowed({ isMember })) {
      sessions.audit('login_denied', { userId: me.id, username: me.username, detail: 'not a guild member', ip: req.ip });
      log.warn({ user: me.id, username: me.username }, 'login denied — not a guild member');
      return res.redirect('/login?error=not_member');
    }

    const isAdmin = access.isAdmin(me.id, roles);
    const sess = sessions.createSession(
      { id: me.id, username: me.username, globalName: me.global_name, avatar: me.avatar, isMember, isAdmin, roles },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    res.setHeader('Set-Cookie', sessions.buildSetCookie(sess.cookie, sessions.SESSION_TTL_MS));
    sessions.audit('login', { userId: me.id, username: me.username, detail: isAdmin ? 'admin' : 'member', ip: req.ip });
    log.info({ user: me.id, username: me.username, isAdmin, isMember }, 'login ok');
    res.redirect(redirectTo || '/');
  } catch (e) {
    log.error({ err: e.message }, 'oauth callback failed');
    res.redirect('/login?error=oauth');
  }
});

// Logout (POST from the app; GET for a plain link).
router.post('/logout', (req, res) => {
  if (req.user) {
    sessions.destroySession(req.user.sid);
    sessions.audit('logout', { userId: req.user.userId, username: req.user.username, ip: req.ip });
  }
  res.setHeader('Set-Cookie', sessions.buildClearCookie());
  res.json({ ok: true });
});
router.get('/logout', (req, res) => {
  if (req.user) sessions.destroySession(req.user.sid);
  res.setHeader('Set-Cookie', sessions.buildClearCookie());
  res.redirect('/login');
});

// Local-preview bypass — only mounted when DEV_AUTH is on (never in production).
// Grants a mock admin session so you can tour the UI without Discord/the bot.
if (config.devAuth) {
  router.get('/dev', (req, res) => {
    const sess = sessions.createSession(
      { id: '000000000000000000', username: 'preview', globalName: 'Preview Admin', avatar: null, isMember: true, isAdmin: true, roles: [] },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    res.setHeader('Set-Cookie', sessions.buildSetCookie(sess.cookie, sessions.SESSION_TTL_MS));
    sessions.audit('dev_login', { userId: 'preview', username: 'preview', detail: 'DEV_AUTH', ip: req.ip });
    log.warn({ ip: req.ip }, 'DEV_AUTH login granted (mock admin)');
    res.redirect('/');
  });
}

function sanitizeRedirect(r) {
  if (typeof r !== 'string') return '/';
  if (!r.startsWith('/') || r.startsWith('//')) return '/';
  return r;
}

module.exports = router;
