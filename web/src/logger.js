'use strict';
/**
 * Structured logger for the web dashboard (pino).
 *
 * - Pretty, colorized output in dev; single-line JSON in production.
 * - Redacts anything that looks like a secret so tokens never hit the logs.
 * - `logger.child('component')` tags every line with a component name, matching
 *   the bot's logging convention.
 */
const pino = require('pino');
const config = require('./config');

const baseOpts = {
  level: config.logging.level,
  base: { pid: process.pid, service: 'web' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'clientSecret',
      'client_secret',
      'access_token',
      'refresh_token',
      'code',
      'token',
      '*.token',
      '*.secret',
      '*.access_token',
    ],
    censor: '[redacted]',
  },
};

const transport = config.logging.pretty
  ? pino.transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
    })
  : undefined;

const root = transport ? pino(baseOpts, transport) : pino(baseOpts);

const nativeChild = root.child.bind(root);
function child(component, extra = {}) {
  return nativeChild({ component, ...extra });
}

module.exports = root;
module.exports.child = child;
