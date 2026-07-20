'use strict';
const path = require('path');
const log = require('../logger').child('http');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** 404: JSON for the API, SPA shell for everything else (client-side router). */
function notFound(req, res) {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(404).json({ error: 'not found' });
  }
  return res.status(200).sendFile(path.join(PUBLIC_DIR, 'index.html'));
}

/** Central error handler — logs with the request id, never leaks internals. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  log.error({ id: req.id, err: err.message, stack: err.stack }, 'unhandled request error');
  if (res.headersSent) return;
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(500).json({ error: 'internal error', id: req.id });
  }
  res.status(500).send('Internal error');
}

module.exports = { notFound, errorHandler, PUBLIC_DIR };
