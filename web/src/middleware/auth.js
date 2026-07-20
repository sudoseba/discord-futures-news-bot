'use strict';
/** Auth middleware: attach the session to each request, and gate routes. */
const sessions = require('../auth/sessions');

/** Populates req.user (or null) from the signed session cookie. */
function attachUser(req, _res, next) {
  try {
    req.user = sessions.getSessionFromCookieHeader(req.headers.cookie);
  } catch {
    req.user = null;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  if (!req.user.isAdmin) return res.status(403).json({ error: 'forbidden', detail: 'admin only' });
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin };
