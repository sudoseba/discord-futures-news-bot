#!/usr/bin/env node
'use strict';
/**
 * Web dashboard entry point. Boots the HTTP + WebSocket server, starts the live
 * pump and the session sweeper, and shuts down cleanly on SIGTERM/SIGINT.
 */
const http = require('http');
const config = require('./config');
const log = require('./logger');
const { createApp } = require('./app');
const hub = require('./realtime/hub');
const pump = require('./realtime/pump');
const sessions = require('./auth/sessions');
const db = require('./db');

log.info(config.redactedSummary(), 'starting Discord News Bot — Web Dashboard');
for (const w of config.warnings) log.warn(w);

const app = createApp();
const server = http.createServer(app);
hub.init(server);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.fatal({ port: config.port }, `port ${config.port} already in use — is another dashboard running?`);
    process.exit(1);
  }
  log.fatal({ err: err.message }, 'server error');
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log.info({ listen: `${config.host}:${config.port}` }, `dashboard listening → ${config.publicUrl}`);
  pump.start(4000);
});

const sweepTimer = setInterval(() => sessions.sweep(), 10 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

// ─── graceful shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  pump.stop();
  hub.close();
  clearInterval(sweepTimer);
  server.close(() => {
    db.closeAll();
    log.info('shutdown complete');
    process.exit(0);
  });
  const force = setTimeout(() => { log.warn('forced exit after timeout'); process.exit(1); }, 8000);
  if (force.unref) force.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) =>
  log.error({ err: reason?.message || String(reason) }, 'unhandledRejection'),
);
process.on('uncaughtException', (err) => {
  log.fatal({ err: err.message, stack: err.stack }, 'uncaughtException');
  shutdown('uncaughtException');
});
