/**
 * Anomaly Detection Scanner
 *
 * Runs every 15 minutes, fetches all watchlist quotes + macro + sentiment,
 * compares against the previous scan, and fires alerts to Discord when
 * anomalies are detected.
 *
 * STALENESS PROTECTION: If the bot was offline and the last scan is >30 min old,
 * the first scan after restart is treated as a new baseline — no false alerts.
 *
 * All scan data and detected anomalies are persisted to the database for
 * historical analysis and LLM context injection.
 *
 * API Budget: ~17 requests per scan to FREE/keyless APIs only.
 *   - Yahoo Finance for quotes (no key)
 *   - Alternative.me for Fear & Greed (free)
 *   - Binance for funding rates (public)
 *
 * No Finnhub, no NewsAPI, no LLM calls.
 */

const config = require('../config');
const { fetchQuote } = require('./marketDataService');
const { fetchInstitutionalKeys } = require('./macroService');
const { fetchFearGreedIndex, fetchFundingRates } = require('./sentimentService');
const db = require('./database');
const memory = require('./memoryService');
const cooldownStore = require('./cooldownStore');
const log = require('../utils/logger').child('scanner');
const { pctChange } = require('../utils/numHelpers');

// ─── State ──────────────────────────────────────────────────────────────────
let lastScan = null;               // Previous scan snapshot

const COOLDOWN_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MAX_BASELINE_AGE_MS = 30 * 60 * 1000; // 30 minutes — older = stale

// ─── Thresholds (configurable via config.anomaly) ───────────────────────────
function getThresholds() {
    const t = config.anomaly || {};
    return {
        priceSpike: t.priceSpike ?? 2.0,    // % move to trigger
        vixSurge: t.vixSurge ?? 8.0,    // % move in VIX
        vixAbsolute: t.vixAbsolute ?? 25,     // VIX level cross
        dxyBreakout: t.dxyBreakout ?? 0.5,    // % move in DXY
        yieldSpike: t.yieldSpike ?? 3.0,    // % move in 10Y
        fearGreedShift: t.fearGreedShift ?? 10,     // point shift
        fundingExtreme: t.fundingExtreme ?? 0.0005, // 0.05% funding rate
        correlationSweep: t.correlationSweep ?? 1.5,    // % threshold for sweep
        correlationCount: t.correlationCount ?? 3,      // min assets moving together
    };
}

// ─── Cooldown helpers ───────────────────────────────────────────────────────
// Backed by SQLite so cooldowns survive a restart — otherwise a deploy at the
// wrong moment would let a just-fired anomaly re-fire immediately.
function isOnCooldown(key) {
    return cooldownStore.isOnCooldown(`anomaly:${key}`);
}

function setCooldown(key) {
    cooldownStore.setCooldown(`anomaly:${key}`, COOLDOWN_MS);
}

// ─── Load baseline from DB on startup ───────────────────────────────────────
/**
 * Try to load the last scan from the database.
 * Returns 'fresh' if baseline is recent enough to compare against,
 * 'stale' if it exists but is too old (needs re-baseline),
 * or 'none' if no scan exists at all.
 */
function loadBaseline() {
    try {
        const saved = db.getLastScanData();
        if (!saved) return 'none';

        // SQLite datetime('now') already returns UTC in 'YYYY-MM-DD HH:MM:SS'
        // format. Normalise to ISO so Date.parse works portably (Windows ≠ Linux).
        const isoLike = saved.recordedAt.includes('T')
            ? saved.recordedAt + (saved.recordedAt.endsWith('Z') ? '' : 'Z')
            : saved.recordedAt.replace(' ', 'T') + 'Z';
        const scanTime = Date.parse(isoLike);
        if (!Number.isFinite(scanTime)) {
            log.warn({ recordedAt: saved.recordedAt }, 'baseline timestamp unparseable; treating as none');
            return 'none';
        }
        const ageMs = Date.now() - scanTime;
        const ageMinutes = Math.round(ageMs / 60_000);

        if (ageMs <= MAX_BASELINE_AGE_MS) {
            lastScan = saved.data;
            log.info({ ageMinutes }, 'baseline restored from DB');
            return 'fresh';
        }
        log.info({ ageMinutes, maxMinutes: MAX_BASELINE_AGE_MS / 60_000 }, 'baseline stale; will re-baseline');
        return 'stale';
    } catch (err) {
        log.warn({ err: err.message }, 'could not restore baseline from DB');
        return 'none';
    }
}

// ─── Anomaly Detection (pure logic) ─────────────────────────────────────────

/**
 * Compare current scan data to previous scan and return anomalies.
 * @param {object} current - { quotes, macro, fearGreed, fundingRates }
 * @param {object} previous - same shape, from last scan
 * @returns {Array<{type, severity, key, title, description, fields}>}
 */
function detectAnomalies(current, previous) {
    const anomalies = [];
    const T = getThresholds();

    // ── Rule 1: Price Spikes ────────────────────────────────────────────
    for (const [symbol, data] of Object.entries(current.quotes)) {
        const curPrice = data.quote?.current;
        const prevPrice = previous.quotes?.[symbol]?.quote?.current;
        const change = pctChange(prevPrice, curPrice);
        if (change == null) continue;
        if (Math.abs(change) >= T.priceSpike) {
            const dir = change > 0 ? '📈' : '📉';
            anomalies.push({
                type: 'price_spike',
                severity: 'HIGH',
                key: `price_spike:${symbol}`,
                symbol,
                direction: change > 0 ? 'bullish' : 'bearish',
                pctChange: +change.toFixed(2),
                capturedPrice: curPrice,
                title: `${dir} ${data.name || symbol} — ${change > 0 ? '+' : ''}${change.toFixed(2)}%`,
                description: `Price moved from $${prevPrice.toFixed(2)} to $${curPrice.toFixed(2)} in ~15 minutes.`,
                fields: [
                    { name: 'Asset', value: data.name || symbol, inline: true },
                    { name: 'Price', value: `$${curPrice.toFixed(2)}`, inline: true },
                    { name: 'Change', value: `${change > 0 ? '+' : ''}${change.toFixed(2)}%`, inline: true },
                ],
            });
        }
    }

    // ── Rule 2: VIX Surge ───────────────────────────────────────────────
    const curVix = current.macro?.vix?.price;
    const prevVix = previous.macro?.vix?.price;
    const vixPct = pctChange(prevVix, curVix);
    if (vixPct != null) {
        if (Math.abs(vixPct) >= T.vixSurge) {
            anomalies.push({
                type: 'vix_surge',
                severity: 'HIGH',
                key: 'vix_surge',
                title: `🚨 VIX ${vixPct > 0 ? 'SURGE' : 'COLLAPSE'} — ${vixPct > 0 ? '+' : ''}${vixPct.toFixed(1)}%`,
                description: `VIX moved from ${prevVix.toFixed(2)} to ${curVix.toFixed(2)}. ${curVix > T.vixAbsolute ? 'Now above ' + T.vixAbsolute + ' — elevated fear.' : ''}`,
                fields: [
                    { name: 'VIX', value: curVix.toFixed(2), inline: true },
                    { name: 'Change', value: `${vixPct > 0 ? '+' : ''}${vixPct.toFixed(1)}%`, inline: true },
                    { name: 'Regime', value: curVix > 25 ? 'High Vol' : curVix > 18 ? 'Elevated' : 'Low Vol', inline: true },
                ],
            });
        }
        // VIX crossing above absolute threshold
        if (curVix >= T.vixAbsolute && prevVix < T.vixAbsolute) {
            anomalies.push({
                type: 'vix_cross',
                severity: 'HIGH',
                key: 'vix_cross_above',
                title: `🚨 VIX Crossed Above ${T.vixAbsolute}`,
                description: `VIX is now at ${curVix.toFixed(2)}, crossing the ${T.vixAbsolute} fear threshold.`,
                fields: [
                    { name: 'VIX', value: curVix.toFixed(2), inline: true },
                    { name: 'Previous', value: prevVix.toFixed(2), inline: true },
                ],
            });
        }
    }

    // ── Rule 3: DXY Breakout ────────────────────────────────────────────
    const curDxy = current.macro?.dxy?.price;
    const prevDxy = previous.macro?.dxy?.price;
    const dxyPct = pctChange(prevDxy, curDxy);
    if (dxyPct != null) {
        if (Math.abs(dxyPct) >= T.dxyBreakout) {
            const dir = dxyPct > 0 ? '💪' : '📉';
            anomalies.push({
                type: 'dxy_breakout',
                severity: 'MEDIUM',
                key: 'dxy_breakout',
                title: `${dir} DXY ${dxyPct > 0 ? 'Strength' : 'Weakness'} — ${dxyPct > 0 ? '+' : ''}${dxyPct.toFixed(3)}%`,
                description: `Dollar index moved from ${prevDxy.toFixed(3)} to ${curDxy.toFixed(3)}. This impacts commodities and forex.`,
                fields: [
                    { name: 'DXY', value: curDxy.toFixed(3), inline: true },
                    { name: 'Change', value: `${dxyPct > 0 ? '+' : ''}${dxyPct.toFixed(3)}%`, inline: true },
                ],
            });
        }
    }

    // ── Rule 4: 10Y Yield Spike ─────────────────────────────────────────
    const curTnx = current.macro?.tnx?.price;
    const prevTnx = previous.macro?.tnx?.price;
    const tnxPct = pctChange(prevTnx, curTnx);
    if (tnxPct != null) {
        if (Math.abs(tnxPct) >= T.yieldSpike) {
            anomalies.push({
                type: 'yield_spike',
                severity: 'MEDIUM',
                key: 'yield_spike',
                title: `📊 10Y Yield ${tnxPct > 0 ? 'Spike' : 'Drop'} — ${tnxPct > 0 ? '+' : ''}${tnxPct.toFixed(2)}%`,
                description: `10-Year Treasury yield moved from ${prevTnx.toFixed(3)}% to ${curTnx.toFixed(3)}%.`,
                fields: [
                    { name: 'Yield', value: `${curTnx.toFixed(3)}%`, inline: true },
                    { name: 'Change', value: `${tnxPct > 0 ? '+' : ''}${tnxPct.toFixed(2)}%`, inline: true },
                ],
            });
        }
    }

    // ── Rule 5: Fear & Greed Shift ──────────────────────────────────────
    const curFG = current.fearGreed?.value;
    const prevFG = previous.fearGreed?.value;
    if (curFG != null && prevFG != null) {
        const fgShift = curFG - prevFG;
        if (Math.abs(fgShift) >= T.fearGreedShift) {
            const getZone = v => v <= 20 ? 'Extreme Fear' : v <= 40 ? 'Fear' : v <= 60 ? 'Neutral' : v <= 80 ? 'Greed' : 'Extreme Greed';
            const curZone = getZone(curFG);
            const prevZone = getZone(prevFG);
            const zoneChanged = curZone !== prevZone;

            anomalies.push({
                type: 'fear_greed_shift',
                severity: 'MEDIUM',
                key: 'fear_greed_shift',
                title: `${curFG > prevFG ? '😏' : '😰'} Fear & Greed: ${prevFG} → ${curFG}`,
                description: zoneChanged
                    ? `Sentiment shifted from "${prevZone}" to "${curZone}" — ${Math.abs(fgShift)} point move.`
                    : `${Math.abs(fgShift)}-point move within "${curZone}" zone.`,
                fields: [
                    { name: 'Current', value: `${curFG}/100 (${curZone})`, inline: true },
                    { name: 'Previous', value: `${prevFG}/100 (${prevZone})`, inline: true },
                    { name: 'Shift', value: `${fgShift > 0 ? '+' : ''}${fgShift}`, inline: true },
                ],
            });
        }
    }

    // ── Rule 6: Funding Rate Extremes ───────────────────────────────────
    if (current.fundingRates?.length > 0) {
        for (const fr of current.fundingRates) {
            if (Math.abs(fr.rate) >= T.fundingExtreme) {
                const dir = fr.rate > 0 ? 'Longs paying heavy' : 'Shorts paying heavy';
                const risk = fr.rate > 0 ? 'long squeeze risk' : 'short squeeze risk';

                anomalies.push({
                    type: 'funding_extreme',
                    severity: 'MEDIUM',
                    key: `funding_extreme:${fr.symbol}`,
                    title: `⚠️ ${fr.symbol} Extreme Funding — ${fr.ratePercent}`,
                    description: `${dir} — ${risk}. Crowded positioning detected.`,
                    fields: [
                        { name: 'Symbol', value: fr.symbol, inline: true },
                        { name: 'Rate', value: fr.ratePercent, inline: true },
                        { name: 'Signal', value: risk, inline: true },
                    ],
                });
            }
        }
    }

    // ── Rule 7: Multi-Asset Correlation Sweep ───────────────────────────
    const bigMovers = [];
    for (const [symbol, data] of Object.entries(current.quotes)) {
        const curPrice = data.quote?.current;
        const prevPrice = previous.quotes?.[symbol]?.quote?.current;
        const change = pctChange(prevPrice, curPrice);
        if (change == null) continue;
        if (Math.abs(change) >= T.correlationSweep) {
            bigMovers.push({ symbol, name: data.name || symbol, pctChange: change });
        }
    }

    if (bigMovers.length >= T.correlationCount) {
        const allUp = bigMovers.every(m => m.pctChange > 0);
        const allDown = bigMovers.every(m => m.pctChange < 0);

        if (allUp || allDown) {
            const direction = allUp ? 'RISK-ON' : 'RISK-OFF';
            const emoji = allUp ? '🟢' : '🔴';
            const moverList = bigMovers.map(m =>
                `${m.name}: ${m.pctChange > 0 ? '+' : ''}${m.pctChange.toFixed(2)}%`
            ).join('\n');

            anomalies.push({
                type: 'correlation_sweep',
                severity: 'HIGH',
                key: `correlation_sweep:${direction}`,
                title: `${emoji} ${direction} SWEEP — ${bigMovers.length} assets moving together`,
                description: `Multiple assets are moving ${allUp ? 'up' : 'down'} simultaneously, signaling a broad ${direction.toLowerCase()} move.`,
                fields: [
                    { name: 'Movers', value: moverList, inline: false },
                    { name: 'Direction', value: direction, inline: true },
                    { name: 'Count', value: `${bigMovers.length} assets`, inline: true },
                ],
            });
        }
    }

    return anomalies;
}

// ─── Main Scan Loop ─────────────────────────────────────────────────────────

/**
 * Run one scan cycle: fetch data, detect anomalies, persist everything,
 * then DM all opted-in subscribers.
 * @param {import('discord.js').Client} client - Discord client (for sending DMs)
 */
async function runScan(client) {
    console.log('[Scanner] Starting anomaly scan...');

    try {
        // ── Step 1: Ensure we have a baseline ───────────────────────────
        if (!lastScan) {
            const baselineStatus = loadBaseline();

            if (baselineStatus === 'stale') {
                // Baseline exists but is too old — the bot was off for a while.
                // Prices moved while it was off, so comparing now would be unfair.
                // We MUST re-baseline with fresh data to avoid false alerts.
                console.log('[Scanner] Stale baseline detected — capturing fresh baseline instead of alerting.');
                // Fall through to the fetch below, lastScan is still null
            }
            // 'fresh' → lastScan is already set from loadBaseline()
            // 'none'  → lastScan is still null, will baseline below
        }

        // ── Step 2: Fetch all data in parallel ──────────────────────────
        // Use allSettled so one source failure doesn't abort the entire scan.
        // Each block degrades gracefully to null/[] for downstream null checks.
        const symbols = Object.entries(config.watchlist);
        const quotes = {};

        const macroP = fetchInstitutionalKeys().catch((err) => {
            log.warn({ err: err.message }, 'macro fetch failed; treating as missing');
            return null;
        });
        const fgP = fetchFearGreedIndex().catch((err) => {
            log.warn({ err: err.message }, 'fearGreed fetch failed; treating as missing');
            return null;
        });
        const fundingP = fetchFundingRates().catch((err) => {
            log.warn({ err: err.message }, 'funding fetch failed; treating as empty');
            return [];
        });
        const quotesP = Promise.all(symbols.map(async ([symbol, meta]) => {
            try {
                const quote = await fetchQuote(symbol);
                quotes[symbol] = { ...meta, quote };
            } catch (err) {
                log.debug({ symbol, err: err.message }, 'quote fetch failed; treating as null');
                quotes[symbol] = { ...meta, quote: null };
            }
        }));

        const [macro, fearGreed, fundingRates] = await Promise.all([macroP, fgP, fundingP, quotesP])
            .then((r) => r.slice(0, 3));

        const current = { quotes, macro, fearGreed, fundingRates };

        // ── Step 3: No baseline yet → set it and return (no alerts) ─────
        if (!lastScan) {
            lastScan = current;
            memory.persistScanResult(current, [], []);
            log.info('fresh baseline captured; no alerts this cycle');
            return;
        }

        // ── Step 4: Detect anomalies against valid baseline ─────────────
        const anomalies = detectAnomalies(current, lastScan);

        // Filter out cooled-down alerts
        const fresh = anomalies.filter(a => !isOnCooldown(a.key));

        if (fresh.length > 0) {
            log.info({ fresh: fresh.length, suppressed: anomalies.length - fresh.length }, 'anomalies detected');

            // Capture every fresh anomaly into the scorecard so we can later
            // measure whether each alert type actually edges-out random.
            try {
                const scorecard = require('./scorecardService');
                for (const a of fresh) {
                    if (!a.capturedPrice || !a.symbol || !a.direction) continue;
                    scorecard.captureSignal({
                        signalType: a.type,
                        direction: a.direction,
                        symbol: a.symbol,
                        capturedPrice: a.capturedPrice,
                        snapshot: { pctChange: a.pctChange, severity: a.severity },
                    });
                }
            } catch (e) { log.debug({ err: e.message }, 'scorecard capture skipped'); }

            // ── DM all opted-in subscribers ──────────────────────────────
            if (client) {
                const { buildAlertEmbed } = require('../utils/embeds');
                const subscribers = require('./database').getAnomalySubscribers();

                if (subscribers.length === 0) {
                    log.debug('no subscribers — anomalies detected but no one to DM');
                }

                for (const anomaly of fresh) {
                    const embed = buildAlertEmbed(anomaly);
                    const header = anomaly.severity === 'HIGH'
                        ? '🚨 **ANOMALY ALERT — HIGH PRIORITY**'
                        : '⚠️ **Market Anomaly Detected**';

                    // Send to each subscriber who wants this type. Respect
                    // /snooze user pref — skip without erroring on snoozed users.
                    const { isSnoozed } = require('../commands/snooze');
                    for (const sub of subscribers) {
                        const wantsThis = sub.categories === 'all' || sub.categories.split(',').includes(anomaly.type);
                        if (!wantsThis) continue;
                        if (isSnoozed(sub.user_id)) {
                            log.debug({ userId: sub.user_id }, 'subscriber snoozed; skipping DM');
                            continue;
                        }
                        try {
                            const user = await client.users.fetch(sub.user_id);
                            await user.send({ content: header, embeds: [embed] });
                        } catch (err) {
                            log.warn({ userId: sub.user_id, err: err.message }, 'DM failed');
                        }
                    }

                    setCooldown(anomaly.key);
                }
            } else {
                console.warn('[Scanner] No client available to send DMs.');
                fresh.forEach(a => setCooldown(a.key));
            }
        } else {
            log.info({ cooled: anomalies.length }, 'no anomalies (all on cooldown or none detected)');
        }

        // ── Step 5: Persist everything ──────────────────────────────────
        memory.persistScanResult(current, anomalies, fresh);

        // Update baseline
        lastScan = current;

    } catch (err) {
        log.error({ err: err.message, stack: err.stack }, 'scan failed');
    }
}

module.exports = { runScan, detectAnomalies, loadBaseline };
