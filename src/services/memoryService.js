/**
 * Memory Service — The intelligence layer between the database and the LLM.
 *
 * This service retrieves, compresses, and formats historical data into context
 * blocks that can be injected into LLM prompts. It transforms raw DB rows into
 * narratives and data summaries the model can reason over.
 *
 * Think of it as the bot's "long-term memory" — it remembers what happened
 * yesterday, last week, and last month, and can surface relevant context
 * when the LLM needs it.
 */

const db = require('./database');

// ─── Context Builders ───────────────────────────────────────────────────────

/**
 * Build a historical price context block for a specific symbol.
 * Used by /analysis and /levels to give the LLM price history awareness.
 *
 * @param {string} symbol - Watchlist symbol key
 * @param {string} name - Human-readable name
 * @param {number} daysBack - How many days to look back
 * @returns {string|null} Formatted context block or null if no data
 */
function buildPriceContext(symbol, name, daysBack = 7) {
    const summary = db.getMarketSummary(symbol, daysBack);
    if (!summary || summary.length === 0) return null;

    const lines = [`HISTORICAL PRICE DATA for ${name} (last ${summary.length} sessions):`];

    // Calculate overall trend
    const firstPrice = summary[0].close_price || summary[0].avg_price;
    const lastPrice = summary[summary.length - 1].close_price || summary[summary.length - 1].avg_price;
    const periodChange = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice * 100).toFixed(2) : '0.00';
    const trendDir = parseFloat(periodChange) >= 0 ? '▲' : '▼';

    lines.push(`  ${daysBack}-Day Change: ${trendDir} ${periodChange}%`);
    lines.push(`  Range: $${Math.min(...summary.map(s => s.day_low || s.avg_price)).toFixed(2)} — $${Math.max(...summary.map(s => s.day_high || s.avg_price)).toFixed(2)}`);
    lines.push('');

    // Daily breakdown (compact)
    for (const day of summary) {
        const price = (day.close_price || day.avg_price)?.toFixed(2) || 'N/A';
        const change = day.avg_change_pct != null ? `(${day.avg_change_pct >= 0 ? '+' : ''}${day.avg_change_pct.toFixed(2)}%)` : '';
        lines.push(`  ${day.day}: $${price} ${change}`);
    }

    return lines.join('\n');
}

/**
 * Build a macro environment context block with trend data.
 * Shows how DXY, 10Y, and VIX have moved over the period.
 *
 * @param {number} daysBack
 * @returns {string|null}
 */
function buildMacroContext(daysBack = 7) {
    const instruments = ['DXY', 'TNX', 'VIX'];
    const sections = [];

    for (const instr of instruments) {
        const readings = db.getRecentMacro(instr, daysBack * 2);
        if (readings.length === 0) continue;

        const latest = readings[0];
        const oldest = readings[readings.length - 1];
        const periodChange = oldest.price > 0
            ? ((latest.price - oldest.price) / oldest.price * 100).toFixed(2)
            : '0.00';
        const dir = parseFloat(periodChange) >= 0 ? '▲' : '▼';

        sections.push(`  ${instr}: ${latest.price?.toFixed(2)} (${dir} ${periodChange}% over ${readings.length} readings)`);
    }

    if (sections.length === 0) return null;

    return `MACRO ENVIRONMENT TREND (${daysBack}-day):\n${sections.join('\n')}`;
}

/**
 * Build a sentiment trend context block.
 * Shows Fear & Greed trajectory and funding rate patterns.
 *
 * @param {number} daysBack
 * @returns {string|null}
 */
function buildSentimentContext(daysBack = 7) {
    const fgTrend = db.getSentimentTrend('fear_greed', daysBack);
    const btcFunding = db.getSentimentTrend('funding_BTCUSDT', daysBack);
    const ethFunding = db.getSentimentTrend('funding_ETHUSDT', daysBack);

    const lines = [];

    if (fgTrend.length > 0) {
        const latest = fgTrend[fgTrend.length - 1];
        const oldest = fgTrend[0];
        const direction = latest.value > oldest.value ? 'improving' : latest.value < oldest.value ? 'deteriorating' : 'stable';
        const avg = (fgTrend.reduce((s, r) => s + r.value, 0) / fgTrend.length).toFixed(0);

        lines.push(`Fear & Greed: ${latest.value}/100 (${latest.label}) — ${direction} over ${fgTrend.length} readings`);
        lines.push(`  ${daysBack}-day average: ${avg}/100`);
        lines.push(`  Range: ${Math.min(...fgTrend.map(r => r.value))} — ${Math.max(...fgTrend.map(r => r.value))}`);
    }

    if (btcFunding.length > 0) {
        const latest = btcFunding[btcFunding.length - 1];
        const avg = (btcFunding.reduce((s, r) => s + r.value, 0) / btcFunding.length);
        const avgPct = (avg * 100).toFixed(4);
        lines.push(`BTC Funding Rate: ${(latest.value * 100).toFixed(4)}% (avg: ${avgPct}%)`);
    }

    if (ethFunding.length > 0) {
        const latest = ethFunding[ethFunding.length - 1];
        const avg = (ethFunding.reduce((s, r) => s + r.value, 0) / ethFunding.length);
        const avgPct = (avg * 100).toFixed(4);
        lines.push(`ETH Funding Rate: ${(latest.value * 100).toFixed(4)}% (avg: ${avgPct}%)`);
    }

    if (lines.length === 0) return null;

    return `SENTIMENT TREND (${daysBack}-day):\n  ${lines.join('\n  ')}`;
}

/**
 * Build a news context block — summarizes recent article themes.
 * Avoids sending full headlines to save tokens; uses counts and categories.
 *
 * @param {string|null} category
 * @param {number} daysBack
 * @returns {string|null}
 */
function buildNewsContext(category = null, daysBack = 3) {
    const summary = db.getNewsSummary(daysBack);
    if (!summary || summary.length === 0) return null;

    const lines = [`NEWS FLOW (last ${daysBack} days):`];

    for (const row of summary) {
        const sentimentLabel = row.avg_sentiment != null
            ? (row.avg_sentiment > 0.3 ? 'bullish' : row.avg_sentiment < -0.3 ? 'bearish' : 'mixed')
            : 'unscored';
        lines.push(`  ${row.category}: ${row.article_count} articles (${row.curated_count} curated, tone: ${sentimentLabel})`);
    }

    // Also grab the most recent curated headlines (top 5)
    const recentCurated = db.getRecentArticles(category, 5, daysBack)
        .filter(a => a.is_curated);

    if (recentCurated.length > 0) {
        lines.push('  Recent curated headlines:');
        for (const a of recentCurated) {
            lines.push(`    • "${a.headline}" (${a.source})`);
        }
    }

    return lines.join('\n');
}

/**
 * Build an economic events context block — past actuals + upcoming events.
 *
 * @returns {string|null}
 */
function buildCalendarContext() {
    const pastEvents = db.getPastEvents(7, 'high');
    const upcomingEvents = db.getUpcomingEvents(7, 'high');

    const lines = [];

    if (pastEvents.length > 0) {
        lines.push('RECENT HIGH-IMPACT DATA RELEASES:');
        for (const e of pastEvents.slice(0, 5)) {
            const actual = e.actual ? `Actual: ${e.actual}` : 'No actual yet';
            const vs = e.forecast ? `vs Est: ${e.forecast}` : '';
            const prev = e.previous ? `Prev: ${e.previous}` : '';
            lines.push(`  ${e.event_name} (${e.event_date}): ${actual} ${vs} ${prev}`.trim());
        }
    }

    if (upcomingEvents.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('UPCOMING HIGH-IMPACT EVENTS:');
        for (const e of upcomingEvents.slice(0, 5)) {
            const est = e.forecast ? `Est: ${e.forecast}` : '';
            const prev = e.previous ? `Prev: ${e.previous}` : '';
            lines.push(`  ${e.event_name} — ${e.event_date} ${e.event_time || ''} ${est} ${prev}`.trim());
        }
    }

    return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Build a previous analysis context block for a specific symbol.
 * Shows the LLM what it said last time so it can track conviction shifts.
 *
 * @param {string} symbol
 * @returns {string|null}
 */
function buildPreviousVerdictContext(symbol) {
    const last = db.getLastVerdict(symbol);
    if (!last) return null;

    return `YOUR PREVIOUS VERDICT (${last.recorded_at}):\n${last.content}\n\nNote: Compare your current analysis with the above. If your view has changed, explicitly state what shifted and why.`;
}

/**
 * Build a correlation history context for a symbol.
 *
 * @param {string} symbol
 * @param {number} limit
 * @returns {string|null}
 */
function buildCorrelationContext(symbol, limit = 10) {
    const history = db.getCorrelationHistory(symbol, limit);
    if (!history || history.length === 0) return null;

    const lines = [`CORRELATION HISTORY for ${symbol} (last ${history.length} observations):`];

    for (const row of history) {
        const parts = [];
        if (row.dxy_change_pct != null) parts.push(`DXY: ${row.dxy_change_pct >= 0 ? '+' : ''}${row.dxy_change_pct.toFixed(2)}%`);
        if (row.vix_price != null) parts.push(`VIX: ${row.vix_price.toFixed(1)}`);
        if (row.symbol_change_pct != null) parts.push(`${symbol}: ${row.symbol_change_pct >= 0 ? '+' : ''}${row.symbol_change_pct.toFixed(2)}%`);
        lines.push(`  ${row.recorded_at}: ${parts.join(' | ')}`);
    }

    return lines.join('\n');
}

/**
 * Build an anomaly history context block.
 * Tells the LLM about recent scanner-detected anomalies so it can
 * reference them in verdicts, briefings, and recaps.
 *
 * @param {number} daysBack
 * @returns {string|null}
 */
function buildAnomalyContext(daysBack = 3) {
    const stats = db.getAnomalyStats(daysBack);
    const recent = db.getRecentAnomalies(daysBack, 15);

    if ((!stats || stats.length === 0) && (!recent || recent.length === 0)) return null;

    const lines = [`ANOMALY SCANNER HISTORY (last ${daysBack} days):`];

    // Summary stats
    if (stats.length > 0) {
        lines.push('  Detection summary:');
        for (const s of stats) {
            lines.push(`    ${s.anomaly_type} (${s.severity}): ${s.count}x detected, ${s.posted_count}x alerted, last seen ${s.last_seen}`);
        }
    }

    // Recent HIGH-severity events (most useful for the AI)
    const highSev = recent.filter(a => a.severity === 'HIGH');
    if (highSev.length > 0) {
        lines.push('  Recent HIGH-severity anomalies:');
        for (const a of highSev.slice(0, 8)) {
            lines.push(`    [${a.recorded_at}] ${a.title}`);
            if (a.description) lines.push(`      ${a.description}`);
        }
    }

    // Recent MEDIUM-severity events (condensed)
    const medSev = recent.filter(a => a.severity === 'MEDIUM');
    if (medSev.length > 0) {
        lines.push(`  Recent MEDIUM-severity anomalies: ${medSev.length} events`);
        for (const a of medSev.slice(0, 5)) {
            lines.push(`    [${a.recorded_at}] ${a.title}`);
        }
    }

    return lines.join('\n');
}

// ─── Composite Context Assembler ────────────────────────────────────────────

/**
 * Assemble a full context payload for the LLM.
 * Selects which memory blocks to include based on the use case.
 *
 * @param {'briefing'|'recap'|'verdict'|'levels'} useCase
 * @param {object} options - { symbol, name, category, daysBack }
 * @returns {string} Complete memory context block
 */
function assembleContext(useCase, options = {}) {
    const { symbol, name, category, daysBack = 7 } = options;
    const blocks = [];

    switch (useCase) {
        case 'verdict':
        case 'levels':
            // Symbol-specific analysis — need price history, macro, correlations, previous verdict
            if (symbol && name) {
                const priceCtx = buildPriceContext(symbol, name, daysBack);
                if (priceCtx) blocks.push(priceCtx);
            }
            const macroCtx1 = buildMacroContext(daysBack);
            if (macroCtx1) blocks.push(macroCtx1);

            if (symbol) {
                const corrCtx = buildCorrelationContext(symbol);
                if (corrCtx) blocks.push(corrCtx);
            }

            if (useCase === 'verdict' && symbol) {
                const prevVerdict = buildPreviousVerdictContext(symbol);
                if (prevVerdict) blocks.push(prevVerdict);

                // Symbol-specific anomalies
                const symAnomalies = db.getAnomaliesBySymbol(symbol, 7, 10);
                if (symAnomalies.length > 0) {
                    const aLines = [`RECENT ANOMALIES for ${symbol}:`];
                    for (const a of symAnomalies) {
                        aLines.push(`  [${a.recorded_at}] ${a.title}`);
                    }
                    blocks.push(aLines.join('\n'));
                }
            }

            const calCtx1 = buildCalendarContext();
            if (calCtx1) blocks.push(calCtx1);

            // General anomaly context
            const anomCtx1 = buildAnomalyContext(3);
            if (anomCtx1) blocks.push(anomCtx1);
            break;

        case 'briefing':
            // Morning briefing — need news flow, macro trend, sentiment, calendar
            const newsCtx = buildNewsContext(category, 3);
            if (newsCtx) blocks.push(newsCtx);

            const macroCtx2 = buildMacroContext(3);
            if (macroCtx2) blocks.push(macroCtx2);

            const sentCtx1 = buildSentimentContext(3);
            if (sentCtx1) blocks.push(sentCtx1);

            const calCtx2 = buildCalendarContext();
            if (calCtx2) blocks.push(calCtx2);

            const anomCtx2 = buildAnomalyContext(1);
            if (anomCtx2) blocks.push(anomCtx2);
            break;

        case 'recap':
            // End-of-day recap — full picture
            const macroCtx3 = buildMacroContext(daysBack);
            if (macroCtx3) blocks.push(macroCtx3);

            const sentCtx2 = buildSentimentContext(daysBack);
            if (sentCtx2) blocks.push(sentCtx2);

            const newsCtx2 = buildNewsContext(null, 1);
            if (newsCtx2) blocks.push(newsCtx2);

            const calCtx3 = buildCalendarContext();
            if (calCtx3) blocks.push(calCtx3);

            // Anomaly history for recap — broader window
            const anomCtx3 = buildAnomalyContext(7);
            if (anomCtx3) blocks.push(anomCtx3);

            // Get last recap for comparison
            const lastRecaps = db.getRecentLlmOutputs('recap', null, 1);
            if (lastRecaps.length > 0) {
                blocks.push(`YESTERDAY'S RECAP (${lastRecaps[0].recorded_at}):\n${lastRecaps[0].content.substring(0, 500)}...\n\nNote: Reference yesterday's recap if the narrative has evolved.`);
            }
            break;

        default:
            break;
    }

    if (blocks.length === 0) return '';

    return '\n━━━ HISTORICAL MEMORY (from database) ━━━\n\n' + blocks.join('\n\n') + '\n\n━━━ END MEMORY ━━━\n';
}

// ─── Data Persistence Helpers ───────────────────────────────────────────────

/**
 * Persist a full market pulse snapshot — stores quotes, macro, and sentiment.
 * Called after every /pulse, /recap, and scheduled briefing.
 *
 * @param {object} allQuotes - Watchlist quotes keyed by symbol
 * @param {object} macro - { dxy, tnx, vix }
 * @param {object|null} fearGreed - Fear & Greed data
 * @param {Array|null} fundingRates - Binance funding rates
 */
function persistMarketPulse(allQuotes, macro, fearGreed, fundingRates) {
    try {
        // Store individual quotes
        if (allQuotes) {
            for (const [symbol, data] of Object.entries(allQuotes)) {
                if (data.quote) {
                    db.insertMarketSnapshot(symbol, data.name, data.quote);
                }
            }
        }

        // Store macro readings
        if (macro) {
            db.insertMacroSnapshotsBatch(macro);
        }

        // Store sentiment
        if (fearGreed) {
            db.insertSentimentReading('fear_greed', fearGreed.value, fearGreed.label);
        }

        if (fundingRates && Array.isArray(fundingRates)) {
            for (const fr of fundingRates) {
                db.insertSentimentReading(
                    `funding_${fr.symbol}`,
                    fr.rate,
                    fr.ratePercent,
                    { fundingTime: fr.fundingTime }
                );
            }
        }
    } catch (err) {
        console.error('[Memory] Failed to persist market pulse:', err.message);
    }
}

/**
 * Persist news articles and track which ones were curated by the LLM.
 *
 * @param {Array} headlines - Raw headlines from the news service
 * @param {Array} curatedHeadlines - Headlines that survived LLM filtering
 * @param {string} category
 */
function persistNews(headlines, curatedHeadlines = [], category = 'all') {
    try {
        const articles = headlines.map(h => ({
            headline: h.headline,
            summary: h.summary,
            source: h.source,
            url: h.url,
            category: h.category || category,
            publishedAt: h.timestamp || null,
        }));

        const inserted = db.insertArticlesBatch(articles);

        if (curatedHeadlines.length > 0) {
            db.markArticlesCurated(curatedHeadlines);
        }

        if (inserted > 0) {
            console.log(`[Memory] Persisted ${inserted} new articles (${curatedHeadlines.length} curated)`);
        }
    } catch (err) {
        console.error('[Memory] Failed to persist news:', err.message);
    }
}

/**
 * Persist economic calendar events.
 */
function persistCalendarEvents(events) {
    try {
        if (events && events.length > 0) {
            db.upsertEconomicEventsBatch(events);
        }
    } catch (err) {
        console.error('[Memory] Failed to persist calendar events:', err.message);
    }
}

/**
 * Persist an LLM output and return it.
 */
function persistLlmOutput(type, symbol, category, content, inputSummary = null, model = null) {
    try {
        db.insertLlmOutput(type, symbol, category, content, inputSummary, model);
    } catch (err) {
        console.error('[Memory] Failed to persist LLM output:', err.message);
    }
}

/**
 * Persist correlation data for a symbol alongside current macro state.
 */
function persistCorrelation(symbol, macro, quote) {
    try {
        if (quote && macro) {
            db.insertCorrelation(
                symbol,
                macro,
                quote.current || null,
                quote.changePercent || null
            );
        }
    } catch (err) {
        console.error('[Memory] Failed to persist correlation:', err.message);
    }
}

/**
 * Persist a full scan result — scan snapshot, anomaly events, and market data.
 * Called by the anomaly scanner after every cycle.
 *
 * @param {object} scanData - { quotes, macro, fearGreed, fundingRates }
 * @param {Array} allAnomalies - All detected anomalies
 * @param {Array} postedAnomalies - Anomalies that were actually posted (not cooled down)
 */
function persistScanResult(scanData, allAnomalies = [], postedAnomalies = []) {
    try {
        // 1. Store scan cycle
        const scanId = db.insertAnomalyScan(
            scanData,
            allAnomalies.length,
            postedAnomalies.length
        );

        // 2. Store all anomaly events
        if (allAnomalies.length > 0) {
            const postedKeys = postedAnomalies.map(a => a.key);
            db.insertAnomalyEventsBatch(scanId, allAnomalies, postedKeys);
        }

        // 3. Also persist the market data for continuous 15-min resolution
        persistMarketPulse(
            scanData.quotes,
            scanData.macro,
            scanData.fearGreed,
            scanData.fundingRates
        );

        console.log(`[Memory] Scan persisted: scan #${scanId}, ${allAnomalies.length} anomalies (${postedAnomalies.length} posted)`);
    } catch (err) {
        console.error('[Memory] Failed to persist scan result:', err.message);
    }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    // Context builders (for LLM prompts)
    buildPriceContext,
    buildMacroContext,
    buildSentimentContext,
    buildNewsContext,
    buildCalendarContext,
    buildPreviousVerdictContext,
    buildCorrelationContext,
    buildAnomalyContext,
    assembleContext,

    // Persistence helpers (for services)
    persistMarketPulse,
    persistNews,
    persistCalendarEvents,
    persistLlmOutput,
    persistCorrelation,
    persistScanResult,
};
