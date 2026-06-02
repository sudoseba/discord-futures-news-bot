const http = require('http');
const log = require('../utils/logger').child('healthz');
const cronManager = require('../utils/cronManager');
const { getDb } = require('../services/database');

let server = null;
const state = {
    startedAt: Date.now(),
    discordReady: false,
    lastBriefingAt: null,
    lastRecapAt: null,
    lastScanAt: null,
    lastBreakingAt: null,
    lastLevelBreakAt: null,
};

function markReady() { state.discordReady = true; }
function markJob(key) { state[key] = Date.now(); }

function snapshot() {
    let dbOk = false;
    try {
        const row = getDb().prepare('SELECT 1 as ok').get();
        dbOk = row?.ok === 1;
    } catch { dbOk = false; }
    return {
        status: state.discordReady && dbOk ? 'ok' : 'degraded',
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
        discordReady: state.discordReady,
        dbOk,
        cronJobs: cronManager.list(),
        lastBriefingAt: state.lastBriefingAt,
        lastRecapAt: state.lastRecapAt,
        lastScanAt: state.lastScanAt,
        lastBreakingAt: state.lastBreakingAt,
        lastLevelBreakAt: state.lastLevelBreakAt,
        memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        pid: process.pid,
        version: require('../../package.json').version,
    };
}

function start() {
    if (process.env.HEALTHZ_ENABLED === 'false') {
        log.info('healthz disabled by env');
        return null;
    }
    const port = parseInt(process.env.HEALTHZ_PORT, 10) || 3000;

    server = http.createServer((req, res) => {
        if (req.url === '/healthz' || req.url === '/') {
            const snap = snapshot();
            res.writeHead(snap.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
            res.end(JSON.stringify(snap, null, 2));
            return;
        }
        if (req.url === '/ready') {
            const ready = state.discordReady;
            res.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
            res.end(ready ? 'ready' : 'not ready');
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });

    server.on('error', (err) => log.error({ err: err.message }, 'healthz server error'));
    server.listen(port, () => log.info({ port }, 'healthz server listening'));
    return server;
}

async function stop() {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
    log.info('healthz server stopped');
}

module.exports = { start, stop, markReady, markJob, snapshot };
