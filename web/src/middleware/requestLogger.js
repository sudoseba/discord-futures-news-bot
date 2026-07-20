'use strict';
/** Per-request structured logging with a short request id + duration. */
const crypto = require('crypto');
const log = require('../logger').child('http');

module.exports = function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  req.id = crypto.randomBytes(5).toString('hex');
  res.setHeader('X-Request-Id', req.id);

  res.on('finish', () => {
    const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 10) / 10;
    const rec = {
      id: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms,
      ip: req.ip,
      user: req.user?.userId || undefined,
    };
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level](rec, `${req.method} ${rec.path} → ${res.statusCode} (${ms}ms)`);
  });

  next();
};
