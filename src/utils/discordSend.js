/**
 * Discord post helper.
 *
 *   1. Resolves a channel by ID via REST (not the gateway cache, which may not
 *      be populated yet on cold start).
 *   2. Attempts the post.
 *   3. On failure (Discord 5xx, network), parks the payload in the dead-letter
 *      queue so the deadletter cron can retry later.
 */
const log = require('./logger').child('discord-send');
const deadLetter = require('../services/deadLetterService');

async function getChannel(client, channelId) {
    if (!client || !channelId) return null;
    const cached = client.channels.cache.get(channelId);
    if (cached) return cached;
    try {
        return await client.channels.fetch(channelId);
    } catch (err) {
        log.warn({ channelId, err: err.message }, 'channel fetch failed');
        return null;
    }
}

function isRetriable(err) {
    const status = err?.status || err?.httpStatus;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    const code = err?.code;
    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

/**
 * Send a message to a channel. On retriable failure, enqueue to the
 * dead-letter for the deadletter cron to drain.
 *
 *   sendToChannel(client, channelId, { content: '...', embeds: [...] })
 *
 * NOTE: payload must be JSON-serialisable when used with dead-letter — it is
 * stored as JSON in SQLite. If you need to attach files, do not rely on the
 * dead-letter path (Buffers don't round-trip).
 */
async function sendToChannel(client, channelId, payload, { enqueueOnFail = true, files } = {}) {
    const ch = await getChannel(client, channelId);
    if (!ch) {
        log.error({ channelId }, 'channel unavailable; cannot send');
        if (enqueueOnFail && !files) deadLetter.enqueue(channelId, payload, 'channel unavailable');
        return null;
    }
    try {
        const msg = files ? await ch.send({ ...payload, files }) : await ch.send(payload);
        return msg;
    } catch (err) {
        log.warn({ channelId, status: err.status, code: err.code, err: err.message }, 'discord send failed');
        if (enqueueOnFail && isRetriable(err) && !files) {
            deadLetter.enqueue(channelId, payload, err.message);
        }
        return null;
    }
}

module.exports = { sendToChannel, getChannel };
