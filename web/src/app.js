'use strict';
/** Assembles the Express application (middleware order matters). */
const path = require('path');
const express = require('express');
const config = require('./config');
const requestLogger = require('./middleware/requestLogger');
const security = require('./middleware/security');
const { attachUser } = require('./middleware/auth');
const { notFound, errorHandler, PUBLIC_DIR } = require('./middleware/errors');
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');

function createApp() {
  const app = express();
  app.set('trust proxy', true); // req.ip is correct behind `tailscale serve` / a proxy
  app.disable('x-powered-by');

  app.use(security.headers);
  app.use(requestLogger);
  app.use(express.json({ limit: '64kb' }));
  app.use(attachUser);

  // Liveness for the dashboard process itself (no auth).
  app.get('/livez', (_req, res) => res.json({ ok: true, service: 'web', ts: Date.now() }));

  app.use('/auth', authRoutes);
  app.use('/api', security.apiLimiter, apiRoutes);

  // Login landing page (served directly so it works even if the SPA fails).
  app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));

  // Static assets.
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: config.isProd ? '1h' : 0 }));

  // SPA fallback (serves index.html for unknown non-API GETs) + errors.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
