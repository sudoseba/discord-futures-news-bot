'use strict';
/**
 * Periodic pump: while clients are connected, poll the bot's health and detect
 * new rows in the bot DB (anomalies, LLM outputs) by id cursor, then push them
 * out over the hub. Cheap when nobody's watching (early-returns on 0 clients).
 */
const hub = require('./hub');
const health = require('../services/health');
const stats = require('../services/stats');
const { botAvailable } = require('../db');
const log = require('../logger').child('pump');

let timer = null;
const cursors = { anomaly: 0, llm: 0, inited: false };

async function tick() {
  try {
    if (hub.clientCount() === 0) return;

    const h = await health.getHealth();
    hub.broadcast({ type: 'health', ts: Date.now(), ok: h.ok, status: h.status, data: h.data, botDb: botAvailable() });

    if (!botAvailable()) return;

    // First pass with clients present: set cursors to "now" so we don't replay history.
    if (!cursors.inited) {
      cursors.anomaly = stats.maxAnomalyId();
      cursors.llm = stats.maxLlmId();
      cursors.inited = true;
      return;
    }

    const newAnomalies = stats.anomaliesSince(cursors.anomaly);
    if (newAnomalies.length) {
      cursors.anomaly = newAnomalies[newAnomalies.length - 1].id;
      for (const item of newAnomalies) hub.broadcast({ type: 'anomaly', item });
      log.info({ count: newAnomalies.length }, 'pushed new anomalies');
    }

    const newLlm = stats.llmSince(cursors.llm);
    if (newLlm.length) {
      cursors.llm = newLlm[newLlm.length - 1].id;
      for (const item of newLlm) hub.broadcast({ type: 'ai', item });
    }
  } catch (err) {
    log.error({ err: err.message }, 'pump tick failed');
  }
}

function start(intervalMs = 4000) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick };
