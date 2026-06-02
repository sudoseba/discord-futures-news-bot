/**
 * Deepgram Text-to-Speech Service
 *
 * Converts text to MP3 audio using the Deepgram TTS API.
 * Returns a Buffer that can be attached directly to a Discord message.
 *
 * Docs: https://developers.deepgram.com/docs/text-to-speech
 * Model: aura-2-thalia-en (natural, clear, US English)
 *
 * Free tier: 60 min/month. A full daily recap is ~3-5 minutes.
 */

const axios = require('axios');
const config = require('../config');

const DEEPGRAM_TTS_URL = 'https://api.deepgram.com/v1/speak';
const TTS_MODEL = 'aura-2-thalia-en';

/**
 * Convert text to MP3 audio via Deepgram TTS.
 * @param {string} text - The text to speak (recap content)
 * @returns {Promise<Buffer|null>} - MP3 audio buffer, or null on failure/no key
 */
async function synthesizeRecap(text) {
    if (!config.deepgramTtsKey) {
        console.log('[TTS] No DEEPGRAM_TTS_KEY set — skipping audio generation.');
        return null;
    }

    if (!text || text.trim().length === 0) {
        return null;
    }

    // Trim to 3000 chars to stay well within API limits. Do not append a literal
    // "..." — that would be vocalised as "dot dot dot" in the audio.
    const trimmed = text.length > 3000 ? text.substring(0, 3000) : text;

    try {
        console.log(`[TTS] Generating audio for recap (~${trimmed.length} chars)...`);

        const response = await axios.post(
            `${DEEPGRAM_TTS_URL}?model=${TTS_MODEL}`,
            { text: trimmed },
            {
                headers: {
                    'Authorization': `Token ${config.deepgramTtsKey}`,
                    'Content-Type': 'application/json',
                },
                responseType: 'arraybuffer',  // we want binary audio
                timeout: 30_000,
            }
        );

        const buffer = Buffer.from(response.data);
        console.log(`[TTS] Audio generated: ${(buffer.length / 1024).toFixed(1)} KB`);
        return buffer;

    } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data ? Buffer.from(err.response.data).toString() : err.message;
        console.error(`[TTS] Deepgram API error (HTTP ${status}):`, msg);
        return null;
    }
}

module.exports = { synthesizeRecap };
