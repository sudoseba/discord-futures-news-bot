/**
 * Scheduler — wires every cron job through cronManager (timezone-aware,
 * re-entry-safe, recorded for graceful shutdown). Every post goes through
 * discordSend so retriable failures land in the dead-letter queue instead of
 * being silently lost.
 *
 * Jobs:
 *   morning_briefing       — AI news briefing weekdays 8am ET
 *   daily_recap            — EOD recap weekdays 4:30pm ET
 *   anomaly_scan           — every 15min, scans macro/quotes/funding
 *   breaking_news          — every 5min, top tier-1 wires
 *   level_break            — every 5min, price vs LLM levels
 *   mtf_divergence         — every 30min, D+W RSI divergence confluence
 *   funding_flip           — every 30min, funding-rate sign flips
 *   event_outcome          — every 10min, interprets new event actuals
 *   cot_friday             — Friday 4:30pm ET, weekly CFTC report
 *   scorecard_resolve      — every 30min, resolves pending signal replays
 *   deadletter_drain       — every 1min, retries failed Discord posts
 *   cooldown_purge         — every 1h, drops expired DB cooldowns
 */
const crypto = require('crypto');

const config = require('./config');
const log = require('./utils/logger').child('scheduler');
const cronManager = require('./utils/cronManager');
const healthz = require('./server/healthz');
const { sendToChannel } = require('./utils/discordSend');

const { fetchMarketNews } = require('./services/newsService');
const { fetchQuote, fetchAllQuotes } = require('./services/marketDataService');
const { fetchInstitutionalKeys, fetchEconomicCalendar } = require('./services/macroService');
const { fetchFearGreedIndex, fetchFundingRates } = require('./services/sentimentService');
const { summarizeNews, generateDailyRecap } = require('./services/llmService');
const memory = require('./services/memoryService');
const { runScan } = require('./services/anomalyScanner');
const { getDb } = require('./services/database');
const levelBreaks = require('./services/levelBreakService');
const mtfDivergence = require('./services/mtfDivergenceService');
const fundingFlip = require('./services/fundingFlipService');
const cotReport = require('./services/cotReportService');
const eventOutcome = require('./services/eventOutcomeService');
const scorecard = require('./services/scorecardService');
const cooldownStore = require('./services/cooldownStore');
const deadLetter = require('./services/deadLetterService');

const {
    buildNewsEmbed, buildRecapEmbed,
    buildLevelBreakEmbed, buildMtfDivergenceEmbed,
    buildFundingFlipEmbed, buildCotEmbed,
    buildEventOutcomeEmbed,
} = require('./utils/embeds');

function getCategoryChannelId(category) {
    const map = {
        metals: process.env.CHANNEL_METALS,
        oil:    process.env.CHANNEL_OIL,
        crypto: process.env.CHANNEL_CRYPTO,
        forex:  process.env.CHANNEL_FOREX,
    };
    return map[category] || config.autoPostChannelId;
}

/**
 * Check/mark a headline as posted using a hash of the FULL headline (the
 * previous implementation only hashed the first 200 chars, which collided on
 * long headlines sharing a prefix). Fails closed: if the DB check throws, we
 * skip the post so an outage can't spam the channel.
 */
function markHeadlinePostedIfNew(headline, channelId) {
    const hash = crypto.createHash('sha256').update(headline).digest('hex');
    try {
        const db = getDb();
        const exists = db.prepare('SELECT 1 FROM posted_content WHERE content_hash = ?').get(hash);
        if (exists) return false;
        db.prepare('INSERT OR IGNORE INTO posted_content (content_type, content_hash, channel_id) VALUES (?, ?, ?)')
            .run('breaking_news', hash, channelId || '');
        return true;
    } catch (err) {
        log.warn({ err: err.message }, 'headline dedup DB check failed; skipping post');
        return false;
    }
}

function startScheduler(client) {
    const channelId = config.autoPostChannelId;

    // ── Morning Briefing ────────────────────────────────────────────────────
    cronManager.schedule('morning_briefing', config.briefingCron, async () => {
        if (!channelId) return log.warn('no auto-post channel');
        const headlines = await fetchMarketNews('all');
        const llmResult = await summarizeNews(headlines, 'all');
        const curated = llmResult?.curatedHeadlines?.length > 0
            ? headlines.filter(h => new Set(llmResult.curatedHeadlines).has(h.headline))
            : headlines.slice(0, 10);
        const embeds = buildNewsEmbed(curated, 'all',
            llmResult?.tldr, llmResult?.headlineTldrs || {}, {},
            headlines.length, llmResult?.synthesis || null);
        await sendToChannel(client, channelId, {
            content: '☀️ **Good morning! Here\'s your AI-curated market briefing:**',
            embeds: Array.isArray(embeds) ? embeds : [embeds],
        });
        healthz.markJob('lastBriefingAt');
    });

    // ── Daily Recap ─────────────────────────────────────────────────────────
    cronManager.schedule('daily_recap', config.recapCron, async () => {
        if (!channelId) return log.warn('no auto-post channel');
        const [macro, calendar, fearGreed, fundingRates] = await Promise.all([
            fetchInstitutionalKeys().catch(() => null),
            fetchEconomicCalendar().catch(() => []),
            fetchFearGreedIndex().catch(() => null),
            fetchFundingRates().catch(() => []),
        ]);
        const allQuotes = await fetchAllQuotes();
        const recap = await generateDailyRecap(allQuotes, macro, fearGreed, fundingRates, calendar);
        const embed = buildRecapEmbed(allQuotes, { macro, fearGreed, fundingRates, calendar, recap });
        await sendToChannel(client, channelId, {
            content: '📋 **End-of-Day Market Recap:**',
            embeds: [embed],
        });
        memory.persistCalendarEvents(calendar);
        healthz.markJob('lastRecapAt');
    });

    // ── Anomaly Scanner ─────────────────────────────────────────────────────
    cronManager.schedule('anomaly_scan', config.anomalyScanCron, async () => {
        await runScan(client);
        healthz.markJob('lastScanAt');
    });
    // Re-baseline shortly after boot so the first cron tick has a comparison snapshot.
    setTimeout(() => runScan(client).catch(err => log.warn({ err: err.message }, 'initial scan failed')), 30_000);

    // ── Breaking News ───────────────────────────────────────────────────────
    cronManager.schedule('breaking_news', process.env.BREAKING_NEWS_CRON || '*/5 * * * *', async () => {
        if (!channelId) return;
        const breaking = await fetchMarketNews('all', true);
        if (breaking.length === 0) return;
        const newStories = breaking.filter(h => markHeadlinePostedIfNew(h.headline, channelId));
        if (newStories.length === 0) return;
        log.info({ count: newStories.length }, 'new breaking stories to post');
        for (const story of newStories.slice(0, 3)) {
            const tierLabel = story.tier === 1 ? '★★★ Wire' : '★★';
            const embed = buildNewsEmbed([story], 'all', null, {}, {}, 1, null);
            const single = Array.isArray(embed) ? embed[0] : embed;
            await sendToChannel(client, channelId, {
                content: `🔴 **BREAKING** · ${tierLabel} · ${story.source}`,
                embeds: [single],
            });
            await new Promise(r => setTimeout(r, 1500));
        }
        healthz.markJob('lastBreakingAt');
    });

    // ── Level Break Detector ───────────────────────────────────────────────
    cronManager.schedule('level_break', process.env.LEVEL_BREAK_CRON || '*/5 * * * *', async () => {
        if (!channelId) return;
        const events = await levelBreaks.runCycle();
        for (const ev of events.slice(0, 5)) {
            const targetCh = getCategoryChannelId(ev.meta.category);
            const embed = buildLevelBreakEmbed(ev);
            await sendToChannel(client, targetCh, { embeds: [embed] });
            await new Promise(r => setTimeout(r, 750));
        }
        healthz.markJob('lastLevelBreakAt');
    });

    // ── MTF Divergence Detector ────────────────────────────────────────────
    cronManager.schedule('mtf_divergence', '*/30 * * * *', async () => {
        if (!channelId) return;
        const events = await mtfDivergence.runCycle();
        for (const ev of events) {
            const targetCh = getCategoryChannelId(ev.meta.category);
            await sendToChannel(client, targetCh, { embeds: [buildMtfDivergenceEmbed(ev)] });
        }
    });

    // ── Funding Flip Detector ──────────────────────────────────────────────
    cronManager.schedule('funding_flip', '*/30 * * * *', async () => {
        if (!channelId) return;
        const events = await fundingFlip.runCycle();
        for (const ev of events) {
            const targetCh = getCategoryChannelId('crypto');
            await sendToChannel(client, targetCh, { embeds: [buildFundingFlipEmbed(ev)] });
        }
    });

    // ── Event Outcome Interpreter ──────────────────────────────────────────
    cronManager.schedule('event_outcome', process.env.EVENT_OUTCOME_CRON || '*/10 * * * *', async () => {
        if (!channelId) return;
        const events = await eventOutcome.runCycle();
        for (const ev of events) {
            await sendToChannel(client, channelId, { embeds: [buildEventOutcomeEmbed(ev)] });
        }
    });

    // ── Weekly CFTC COT Report (Friday afternoon ET) ───────────────────────
    cronManager.schedule('cot_friday', process.env.COT_FRIDAY_CRON || '30 16 * * 5', async () => {
        if (!channelId) return;
        const reports = await cotReport.maybeBuildWeekly();
        if (!reports) return;
        await sendToChannel(client, channelId, {
            content: '📊 **Weekly Commitment of Traders — released**',
            embeds: [buildCotEmbed(reports)],
        });
    });

    // ── Scorecard resolver ─────────────────────────────────────────────────
    cronManager.schedule('scorecard_resolve', process.env.SCORECARD_RESOLVE_CRON || '*/30 * * * *', async () => {
        await scorecard.resolvePending(50);
    });

    // ── Dead-letter drainer ────────────────────────────────────────────────
    cronManager.schedule('deadletter_drain', process.env.DEADLETTER_DRAIN_CRON || '*/1 * * * *', async () => {
        await deadLetter.drain(async (chId, payload) => {
            // Direct send path — do NOT re-enqueue from inside the drainer, the
            // queue's bookkeeping is what handles retries.
            await sendToChannel(client, chId, payload, { enqueueOnFail: false });
        });
    });

    // ── Cooldown purge ─────────────────────────────────────────────────────
    cronManager.schedule('cooldown_purge', '0 * * * *', async () => {
        cooldownStore.clearExpired();
    });
}

module.exports = { startScheduler };
