const pino = require('pino');

const level = process.env.LOG_LEVEL || 'info';
const pretty = process.env.LOG_PRETTY === 'true' || process.env.NODE_ENV !== 'production';

const baseOpts = {
    level,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level: (label) => ({ level: label }),
    },
    redact: {
        paths: [
            'token', 'discord_token', 'DISCORD_TOKEN',
            'finnhub_key', 'FINNHUB_API_KEY',
            'alpha_vantage_key', 'ALPHA_VANTAGE_API_KEY',
            'cerebras_api_key', 'CEREBRAS_API_KEY',
            '*.token', '*.apiKey', '*.api_key', '*.Authorization',
            'headers.authorization', 'headers.Authorization',
        ],
        censor: '[redacted]',
    },
};

const transport = pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
        },
    })
    : undefined;

const root = transport ? pino(baseOpts, transport) : pino(baseOpts);

// Capture pino's native child method BEFORE we monkey-patch it on the exported
// object — otherwise our wrapper would recurse forever into itself.
const nativeChild = root.child.bind(root);

/**
 * Return a logger child bound to a component name.
 * Usage: const log = require('./utils/logger').child('scheduler');
 *        log.info({ event: 'briefing_posted', count: 5 }, 'Posted briefing');
 */
function child(component, extra = {}) {
    return nativeChild({ component, ...extra });
}

module.exports = root;
module.exports.child = child;
