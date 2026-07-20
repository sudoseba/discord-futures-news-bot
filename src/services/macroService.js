const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const axios = require('axios');
const config = require('../config');
const Cache = require('../utils/cache');
const { finnhubLimiter } = require('../utils/rateLimiter');
const withFallback = require('../utils/withFallback');

const cache = new Cache(120_000); // 2 min TTL for macro data
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// ─── Institutional Reference Symbols ──────────────────────────────────────
const MACRO_SYMBOLS = {
    DXY: { yahoo: 'DX-Y.NYB', name: 'US Dollar Index', emoji: '💵' },
    TNX: { yahoo: '^TNX', name: '10Y Treasury Yield', emoji: '🏛️' },
    VIX: { yahoo: '^VIX', name: 'CBOE Volatility Index', emoji: '😱' },
};

/**
 * Fetch a single macro instrument quote from Yahoo Finance.
 */
async function fetchMacroQuote(key) {
    const info = MACRO_SYMBOLS[key];
    if (!info) return null;

    try {
        const result = await yahooFinance.quote(info.yahoo);
        if (!result || !result.regularMarketPrice) return null;

        return {
            name: info.name,
            emoji: info.emoji,
            price: result.regularMarketPrice,
            change: result.regularMarketChange,
            changePercent: result.regularMarketChangePercent,
        };
    } catch (err) {
        console.error(`[Macro] Failed to fetch ${key}:`, err.message);
        return null;
    }
}

/**
 * Fetch all three institutional keys (DXY, 10Y, VIX).
 * @returns {Promise<{dxy: object|null, tnx: object|null, vix: object|null}>}
 */
async function fetchInstitutionalKeys() {
    // Per-instrument fallback so a transient Yahoo blip serves last-good instead
    // of blanking all three (macro has no alternate free provider today).
    const [dxy, tnx, vix] = await Promise.all([macroKey('DXY'), macroKey('TNX'), macroKey('VIX')]);
    return { dxy, tnx, vix };
}

function macroKey(key) {
    return withFallback({
        cache,
        key: `macro:${key}`,
        ttl: 120_000,
        providers: [{ name: 'yahoo-macro', run: () => fetchMacroQuote(key) }],
    });
}

/**
 * Generate correlation notes based on macro data and the asset being analyzed.
 */
function generateCorrelationNotes(macro, symbol) {
    const notes = [];

    if (macro.vix) {
        if (macro.vix.price > 30) {
            notes.push('🚨 VIX above 30 — extreme fear, expect violent swings');
        } else if (macro.vix.price > 25) {
            notes.push('⚠️ VIX elevated — risk-off regime, widen stops');
        } else if (macro.vix.price < 15) {
            notes.push('😴 VIX sub-15 — complacency, watch for vol expansion');
        }
    }

    if (macro.dxy && macro.tnx) {
        const dxyUp = (macro.dxy.changePercent || 0) > 0.1;
        const dxyDown = (macro.dxy.changePercent || 0) < -0.1;
        const yieldsUp = (macro.tnx.changePercent || 0) > 0.5;
        const yieldsDown = (macro.tnx.changePercent || 0) < -0.5;

        // Gold / metals inverse correlation with DXY
        if (symbol.includes('XAU') || symbol.includes('XAG')) {
            if (dxyDown) notes.push('💵 DXY weakening — tailwind for metals');
            if (dxyUp) notes.push('💵 DXY strengthening — headwind for metals');
            if (yieldsUp) notes.push('🏛️ Real yields rising — pressure on non-yielding assets');
        }

        // Oil correlations
        if (symbol.includes('WTICO') || symbol.includes('BRENT')) {
            if (dxyUp) notes.push('💵 Strong dollar weighing on commodities');
            if (dxyDown) notes.push('💵 Weak dollar supporting commodity prices');
        }

        // Crypto correlations
        if (symbol.includes('BTC') || symbol.includes('ETH')) {
            if (macro.vix && macro.vix.price > 25) {
                notes.push('😱 High VIX — crypto typically sells off in risk-off');
            }
            if (yieldsUp) notes.push('🏛️ Rising yields competing with risk assets');
        }

        // Forex correlations
        if (symbol.includes('EUR_USD') || symbol.includes('GBP_USD')) {
            if (dxyUp) notes.push('💵 DXY bid — direct headwind for this pair');
            if (dxyDown) notes.push('💵 DXY offered — supportive for this pair');
        }
    }

    return notes.length > 0 ? notes : ['No notable macro correlations at this time'];
}

// ─── Economic Calendar ────────────────────────────────────────────────────

// High-impact event keywords (fallback for Finnhub which doesn't provide impact)
const HIGH_IMPACT_KEYWORDS = [
    'CPI', 'Consumer Price', 'Non-Farm', 'Nonfarm', 'NFP', 'FOMC',
    'Federal Reserve', 'Interest Rate', 'GDP', 'PCE', 'PPI',
    'Unemployment', 'Retail Sales', 'ISM', 'Jackson Hole', 'Powell',
    'ECB', 'BOE', 'BOJ', 'Payrolls', 'Core PPI', 'Core PCE',
    'Trump Speaks', 'President Trump',
];

/**
 * Fetch Forex Factory calendar (this week).
 * Source: nfs.faireconomy.media — Forex Factory's public JSON feed.
 * Has proper High/Medium/Low impact ratings.
 * Rate limit: 2 requests per 5 minutes per IP.
 * @param {string} countryFilter - Country code to filter (default 'USD')
 * @returns {Promise<Array>}
 */
async function fetchForexFactoryCalendar(countryFilter = 'USD') {
    try {
        const { data } = await axios.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
            timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FuturesBot/1.0)' },
        });

        if (!Array.isArray(data) || data.length === 0) return [];

        const now = new Date();

        // Single ET formatter — handles DST correctly (UTC-5 in winter, UTC-4 in summer).
        // Reused across all events to avoid re-allocating the Intl object.
        const etDate = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York',
            year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const etTime = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/New_York',
            hour: '2-digit', minute: '2-digit', hour12: false,
        });

        return data
            .filter(e => e.country === countryFilter)
            .map(e => {
                const eventTime = new Date(e.date);
                if (Number.isNaN(eventTime.getTime())) return null;

                // 'YYYY-MM-DD' from en-CA locale, and 'HH:mm' from en-GB.
                const dateStr = etDate.format(eventTime); // already YYYY-MM-DD
                const timeStr = etTime.format(eventTime);

                // Calculate countdown
                const diffMs = eventTime - now;
                let countdown = '';
                if (diffMs > 0) {
                    const totalMins = Math.floor(diffMs / 60000);
                    const d = Math.floor(totalMins / 1440);
                    const h = Math.floor((totalMins % 1440) / 60);
                    const m = totalMins % 60;
                    if (d > 0) countdown = `in ${d}d ${h}h`;
                    else if (h > 0) countdown = `in ${h}h ${m}m`;
                    else countdown = `in ${m}m`;
                } else {
                    countdown = 'Released';
                }

                // FF provides impact directly: "High", "Medium", "Low", "Holiday"
                const ffImpact = (e.impact || '').toLowerCase();
                let impact = 'low';
                if (ffImpact === 'high') impact = 'high';
                else if (ffImpact === 'medium') impact = 'medium';
                else if (ffImpact === 'holiday') impact = 'holiday';

                return {
                    event: e.title,
                    date: dateStr,
                    time: timeStr,
                    impact,
                    countdown,
                    forecast: e.forecast || null,
                    previous: e.previous || null,
                    source: 'FF',
                };
            })
            .filter(e => e && e.countdown !== 'Released');
    } catch (err) {
        console.error('[Macro] Forex Factory calendar fetch failed:', err.message);
        return [];
    }
}

/**
 * Fetch Finnhub economic calendar for extended range (week 2+).
 * @param {number} days
 * @returns {Promise<Array>}
 */
async function fetchFinnhubCalendar(days = 14) {
    try {
        await finnhubLimiter.waitForToken();

        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + days);

        const from = now.toISOString().split('T')[0];
        const to = endDate.toISOString().split('T')[0];

        const { data } = await axios.get(`${FINNHUB_BASE}/calendar/economic`, {
            params: { from, to, token: config.finnhubKey },
        });

        if (!data?.economicCalendar?.length) return [];

        const events = data.economicCalendar
            .filter(e => e.country === 'US')
            .map(e => {
                const isHighImpact = HIGH_IMPACT_KEYWORDS.some(kw =>
                    (e.event || '').toUpperCase().includes(kw.toUpperCase())
                );

                const eventDateStr = e.date || from;

                let countdown = '';
                if (e.time && e.date) {
                    const eventTime = new Date(`${e.date}T${e.time}:00Z`);
                    const diffMs = eventTime - now;
                    if (diffMs > 0) {
                        const totalMins = Math.floor(diffMs / 60000);
                        const d = Math.floor(totalMins / 1440);
                        const h = Math.floor((totalMins % 1440) / 60);
                        const m = totalMins % 60;
                        if (d > 0) countdown = `in ${d}d ${h}h`;
                        else if (h > 0) countdown = `in ${h}h ${m}m`;
                        else countdown = `in ${m}m`;
                    } else {
                        countdown = 'Released';
                    }
                } else if (e.date) {
                    const eventDay = new Date(e.date);
                    const diffDays = Math.ceil((eventDay - now) / 86400000);
                    if (diffDays === 0) countdown = 'Today';
                    else if (diffDays === 1) countdown = 'Tomorrow';
                    else countdown = `in ${diffDays} days`;
                }

                return {
                    event: e.event,
                    date: eventDateStr,
                    time: e.time || 'TBD',
                    impact: isHighImpact ? 'high' : 'low',
                    countdown,
                    estimate: e.estimate,
                    actual: e.actual,
                    prev: e.prev,
                    source: 'FH',
                };
            })
            .filter(e => e.countdown !== 'Released');

        return events;
    } catch (err) {
        console.error('[Macro] Finnhub calendar fetch failed:', err.message);
        return [];
    }
}

/**
 * Fetch economic calendar — short version for inline use (/analysis, /pulse).
 * Uses Forex Factory for this week, limits to top 5 events.
 */
async function fetchEconomicCalendar() {
    return cache.getOrFetch('macro:economic_calendar:short', async () => {
        let events = await fetchForexFactoryCalendar();

        // If FF failed, fall back to Finnhub
        if (events.length === 0) {
            events = await fetchFinnhubCalendar(1);
        }

        // Sort: high impact first, then medium, then low, then by time
        const impactOrder = { high: 0, medium: 1, low: 2, holiday: 3 };
        events.sort((a, b) => {
            const ia = impactOrder[a.impact] ?? 2;
            const ib = impactOrder[b.impact] ?? 2;
            if (ia !== ib) return ia - ib;
            return (a.date + a.time).localeCompare(b.date + b.time);
        });

        return events.slice(0, 5);
    });
}

/**
 * Fetch full 2-week economic calendar for /calendar command.
 * Merges Forex Factory (this week, accurate impact) with Finnhub (next week, keyword-based impact).
 * Deduplicates by event name + date.
 */
async function fetchFullCalendar() {
    return cache.getOrFetch('macro:economic_calendar:full', async () => {
        // Fetch both sources in parallel
        const [ffEvents, fhEvents] = await Promise.all([
            fetchForexFactoryCalendar(),
            fetchFinnhubCalendar(14),
        ]);

        console.log(`[Calendar] Forex Factory: ${ffEvents.length} events, Finnhub: ${fhEvents.length} events`);

        // Build a dedup set from FF events (they have better data)
        const seen = new Set();
        const merged = [];

        // FF events take priority (better impact ratings)
        for (const e of ffEvents) {
            const key = `${e.date}:${e.event.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            seen.add(key);
            merged.push(e);
        }

        // Add Finnhub events that aren't already covered by FF
        for (const e of fhEvents) {
            const key = `${e.date}:${e.event.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(e);
            }
        }

        // Sort by date, then impact, then time
        const impactOrder = { high: 0, medium: 1, low: 2, holiday: 3 };
        merged.sort((a, b) => {
            const dateCompare = (a.date || '').localeCompare(b.date || '');
            if (dateCompare !== 0) return dateCompare;
            const ia = impactOrder[a.impact] ?? 2;
            const ib = impactOrder[b.impact] ?? 2;
            if (ia !== ib) return ia - ib;
            return (a.time || '').localeCompare(b.time || '');
        });

        return merged.slice(0, 40);
    });
}

/**
 * Fetch CFTC Commitment of Traders (COT) data for a given instrument.
 * Uses the CFTC's public OData API — no API key required.
 * Returns the latest report showing commercial (hedger) net positioning.
 *
 * Commodity codes for key instruments:
 *   Gold:       088691 (COMEX)
 *   Silver:     084691 (COMEX)
 *   Copper:     085692 (COMEX)
 *   Crude Oil:  067651 (NYMEX WTI)
 *   Nat Gas:    023651 (NYMEX)
 *
 * @param {string} cotCode - CFTC commodity code
 * @param {string} name - Human-readable name for logging
 * @returns {Promise<object|null>} COT data including net commercial position
 */
async function fetchCftcCot(cotCode, name) {
    try {
        const { data } = await axios.get(
            'https://publicreporting.cftc.gov/api/odata/v1/CommitmentsOfTradersLegacy',
            {
                params: {
                    $filter: `CFTC_Commodity_Code eq '${cotCode}'`,
                    $orderby: 'Report_Date_as_MM_DD_YYYY desc',
                    $top: 2,
                    $format: 'json',
                },
                headers: { 'Accept': 'application/json' },
                timeout: 15_000,
            }
        );

        const reports = data?.value;
        if (!Array.isArray(reports) || reports.length === 0) return null;

        const latest = reports[0];
        const prev = reports[1] || null;

        // Commercial traders = hedgers (the smart money for commodities)
        const commLong = parseInt(latest.Comm_Positions_Long_All || 0);
        const commShort = parseInt(latest.Comm_Positions_Short_All || 0);
        const commNet = commLong - commShort;

        const prevCommLong = prev ? parseInt(prev.Comm_Positions_Long_All || 0) : commLong;
        const prevCommShort = prev ? parseInt(prev.Comm_Positions_Short_All || 0) : commShort;
        const prevNet = prevCommLong - prevCommShort;
        const weekChange = commNet - prevNet;

        // Non-commercial (large speculators / funds)
        const specLong = parseInt(latest.NonComm_Positions_Long_All || 0);
        const specShort = parseInt(latest.NonComm_Positions_Short_All || 0);
        const specNet = specLong - specShort;

        const reportDate = latest.Report_Date_as_MM_DD_YYYY;

        // Interpret bias
        let biasSentiment = 'Neutral';
        let sentimentEmoji = '➡️';
        if (specNet > 0 && weekChange < -1000) {
            biasSentiment = 'Bearish (specs long, commercials reducing longs)';
            sentimentEmoji = '📉';
        } else if (specNet > 50000) {
            biasSentiment = 'Spec Crowded Long — risk of reversal';
            sentimentEmoji = '⚠️';
        } else if (specNet < -50000) {
            biasSentiment = 'Spec Crowded Short — contrarian bullish';
            sentimentEmoji = '⚠️';
        } else if (weekChange > 5000) {
            biasSentiment = 'Commercials adding longs — bullish signal';
            sentimentEmoji = '📈';
        } else if (weekChange < -5000) {
            biasSentiment = 'Commercials reducing longs — cautious';
            sentimentEmoji = '📉';
        }

        return {
            name,
            reportDate,
            commercialNet: commNet,
            commercialChange: weekChange,
            speculatorNet: specNet,
            sentiment: biasSentiment,
            sentimentEmoji,
        };
    } catch (err) {
        console.error(`[CFTC] COT fetch failed for ${name} (${cotCode}):`, err.message);
        return null;
    }
}

// Cached COT fetcher for Gold (most commonly used with /levels)
const CFTC_CODES = {
    'OANDA:XAU_USD': { code: '088691', name: 'Gold' },
    'OANDA:XAG_USD': { code: '084691', name: 'Silver' },
    'OANDA:XCU_USD': { code: '085692', name: 'Copper' },
    'OANDA:WTICO_USD': { code: '067651', name: 'Crude Oil' },
    'OANDA:NATGAS_USD': { code: '023651', name: 'Natural Gas' },
    'BINANCE:BTCUSDT': null, // No CFTC data for crypto
    'BINANCE:ETHUSDT': null,
};

/**
 * Fetch CFTC COT data for a watchlist symbol.
 * Cached for 6 hours since COT is released weekly on Fridays.
 * @param {string} symbol - watchlist symbol key
 */
async function fetchCotForSymbol(symbol) {
    const entry = CFTC_CODES[symbol];
    if (!entry) return null;

    return cache.getOrFetch(`cftc:cot:${symbol}`, async () => {
        return fetchCftcCot(entry.code, entry.name);
    }, 6 * 60 * 60 * 1000); // 6 hour cache
}

module.exports = {
    fetchInstitutionalKeys,
    generateCorrelationNotes,
    fetchEconomicCalendar,
    fetchFullCalendar,
    fetchCotForSymbol,
    CFTC_CODES,
    MACRO_SYMBOLS,
};
