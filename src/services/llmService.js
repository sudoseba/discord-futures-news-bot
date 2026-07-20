const Cerebras = require('@cerebras/cerebras_cloud_sdk');
const GroqSDK = require('groq-sdk');
const Groq = GroqSDK.Groq || GroqSDK.default || GroqSDK;
const config = require('../config');
const memory = require('./memoryService');
const Cache = require('../utils/cache');
const { recordSuccess, recordFailure } = require('../utils/circuitBreaker');

// ─── LLM Output Cache ───────────────────────────────────────────────────────
// Deduplicates AI generation so two users asking the same thing within the
// TTL window get the same response instantly — zero extra LLM calls.
// Keys: 'briefing:<category>', 'verdict:<symbol>', 'recap', 'levels:<name>'
const llmCache = new Cache(config.llmCacheTtl);

let cerebrasClient = null;
let groqClient = null;
let llmClient = null;

function rawCerebras() {
    if (!cerebrasClient && config.cerebrasApiKey) cerebrasClient = new Cerebras({ apiKey: config.cerebrasApiKey });
    return cerebrasClient;
}
function rawGroq() {
    if (!groqClient && config.groqApiKey) groqClient = new Groq({ apiKey: config.groqApiKey });
    return groqClient;
}

/**
 * OpenAI-compatible client with Cerebras→Groq failover. Presents the same
 * `.chat.completions.create(params)` interface the callers already use, so every
 * generation function transparently gains a second LLM provider — including on
 * the "200 but empty content" case that used to silently fail.
 */
function getClient() {
    if (!config.cerebrasApiKey && !config.groqApiKey) return null;
    if (!llmClient) llmClient = { chat: { completions: { create: createWithFailover } } };
    return llmClient;
}

async function createWithFailover(params) {
    const cerebras = rawCerebras();
    if (cerebras) {
        try {
            const completion = await cerebras.chat.completions.create(params);
            if (completion?.choices?.[0]?.message?.content) { recordSuccess('cerebras-llm'); return completion; }
            recordFailure('cerebras-llm', 'empty content');
            console.warn('[LLM] Cerebras returned empty content — failing over to Groq');
        } catch (err) {
            recordFailure('cerebras-llm', err.message);
            console.warn(`[LLM] Cerebras error (${err.message}) — failing over to Groq`);
        }
    }
    const groq = rawGroq();
    if (groq) {
        try {
            const completion = await groq.chat.completions.create({ ...params, model: config.groqModel });
            recordSuccess('groq-llm');
            return completion;
        } catch (err) {
            recordFailure('groq-llm', err.message);
            console.error(`[LLM] Groq failover also failed: ${err.message}`);
        }
    }
    // Nothing worked — return an empty completion so callers take their degrade path.
    return { choices: [{ message: { content: '' } }] };
}

/**
 * Use Cerebras LLM to filter out slop headlines and generate a TLDR summary.
 * Results are cached per-category for `llmCacheTtl` ms to avoid duplicate
 * generation when multiple users run /news or the morning briefing fires.
 * @param {Array<{headline: string, summary: string, source: string, url: string}>} headlines
 * @param {string} category
 * @returns {Promise<{tldr: string, curatedHeadlines: string[]}>}
 */
async function summarizeNews(headlines, category = 'all') {
    const client = getClient();

    if (!client || headlines.length === 0) {
        return {
            tldr: null,
            curatedHeadlines: headlines.map(h => h.headline),
        };
    }

    // Cache key includes model version so a model upgrade invalidates stale outputs
    const cacheKey = `briefing:${config.cerebrasModel}:${category}`;
    if (config.llmCacheTtl > 0) {
        const cached = llmCache.get(cacheKey);
        if (cached) {
            console.log(`[LLM] Cache HIT for briefing:${category} — reusing generated briefing`);
            // Still persist any new articles even on cache hit
            memory.persistNews(headlines, cached.curatedHeadlines, category);
            return cached;
        }
    }

    // Build headlines block — include source tier info
    const headlinesBlock = headlines.slice(0, 30).map((h, i) =>
        `${i + 1}. [${h.tier === 1 ? '★★★' : h.tier === 2 ? '★★' : '★'}] "${h.headline}" — ${h.source}\n   ${(h.summary || '').substring(0, 120)}`
    ).join('\n');

    const categoryContext = category === 'all'
        ? 'oil, gold, metals, crypto, and forex futures'
        : `${category} futures`;

    const memoryContext = memory.assembleContext('briefing', { category });

    const prompt = `ROLE: You are a Senior Macro Strategist for a high-frequency futures desk. Zero tolerance for noise. Your job: extract Alpha.

CONTEXT: Focus is ${categoryContext}. Briefing the desk now.
${memoryContext}
━━ STEP 1: FILTER ━━
Discard headlines that fail ANY of:
• No supply/demand, regulatory, central bank, or geopolitical impact
• Retail noise: "How to trade X", round number hits, influencer takes, generic recaps
• Single-stock earnings/analyst ratings unless it's macro-scale (S&P, entire sector)
• Duplicates — keep the version with the most specific data point
• Backward-looking recaps with no forward implication

━━ STEP 2: BRIEFING ━━
Write 2-3 tight paragraphs:
• Para 1: Dominant narrative + key catalysts + positioning implication
• Para 2: Cross-asset context (rates, DXY, risk-on/off, correlations, divergences)
• Para 3: Specific levels, upcoming catalysts, or session event risk (omit if nothing material)

If memory available, reference evolving narratives (e.g. "Gold bid 3 consecutive sessions").
Sharp. Direct. No filler. Numbers when available.

━━ STEP 3: SYNTHESIS ━━
If 2+ headlines point the same direction, write ONE punchy synthesis sentence (≤20 words): e.g. "Three separate data points confirm USD softening — tailwind for commodities today."

━━ HEADLINES ━━
${headlinesBlock}

━━ OUTPUT ━━
Return ONLY valid JSON, no markdown, no code fences:
{"tldr": "2-3 paragraph briefing. Use \\n\\n between paragraphs.", "synthesis": "One synthesis sentence or null", "keep": [{"n": 1, "why": "≤10-word reason this matters", "impact": "high"}, {"n": 3, "why": "≤10-word reason", "impact": "medium"}]}

impact values: "high" (moves markets today), "medium" (context/positioning), "low" (background noise that still passed filter). Keep 4-10 headlines max. Be ruthless.`;

    try {
        const completion = await client.chat.completions.create({
            model: config.cerebrasModel,
            messages: [
                { role: 'system', content: 'You are a Senior Macro Strategist. Output only valid JSON. No markdown, no code fences, no commentary.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.2,
            max_tokens: 1200,
        });

        const response = completion.choices[0]?.message?.content;
        if (!response) throw new Error('Empty LLM response');

        // Strip markdown code fences if present
        const rawJson = response.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
        const parsed = JSON.parse(rawJson);

        const keepEntries = (parsed.keep || []);
        const headlineTldrs = {};   // headline text → AI-generated TLDR
        const headlineImpact = {};  // headline text → 'high'|'medium'|'low'

        const keptIndices = keepEntries.map(entry => {
            if (typeof entry === 'number') return entry - 1;
            if (typeof entry === 'object' && entry.n != null) {
                const idx = entry.n - 1;
                if (idx >= 0 && idx < headlines.length) {
                    if (entry.why) headlineTldrs[headlines[idx].headline] = entry.why;
                    if (entry.impact) headlineImpact[headlines[idx].headline] = entry.impact;
                }
                return idx;
            }
            return -1;
        });

        const curatedHeadlines = keptIndices
            .filter(i => i >= 0 && i < headlines.length)
            .map(i => headlines[i].headline);

        const result = {
            tldr: parsed.tldr || null,
            synthesis: parsed.synthesis || null,
            curatedHeadlines: curatedHeadlines.length > 0 ? curatedHeadlines : headlines.slice(0, 8).map(h => h.headline),
            headlineTldrs,
            headlineImpact,  // NEW: { 'Headline text': 'high'|'medium'|'low' }
        };

        // Persist: store the briefing and news articles
        if (result.tldr) {
            memory.persistLlmOutput('briefing', null, category, result.tldr, `${headlines.length} headlines, ${result.curatedHeadlines.length} curated`, config.cerebrasModel);
        }
        memory.persistNews(headlines, result.curatedHeadlines, category);

        // Cache the result for deduplication
        if (config.llmCacheTtl > 0) {
            llmCache.set(cacheKey, result);
            console.log(`[LLM] Cache SET for briefing:${category} (TTL: ${config.llmCacheTtl / 60000}min)`);
        }

        return result;
    } catch (error) {
        console.error('[LLM] Summarization failed, falling back to raw headlines:', error.message);
        // Still persist the raw headlines even on LLM failure
        memory.persistNews(headlines, [], category);
        const fallback = {
            tldr: null,
            synthesis: null,
            curatedHeadlines: headlines.map(h => h.headline),
            headlineTldrs: {},
            headlineImpact: {},
            _fallback: true,
        };
        // Cache the fallback briefly (60s) so a transient LLM outage doesn't
        // cause every caller in the next minute to re-hit the broken endpoint.
        if (config.llmCacheTtl > 0) llmCache.set(cacheKey, fallback, 60_000);
        return fallback;
    }
}

/**
 * Generate an AI "War Room Verdict" for the /analysis command.
 * Synthesizes TA, macro correlations, risk metrics, and calendar into a directional brief.
 * Results are cached per-symbol for `llmCacheTtl` ms.
 *
 * @param {string} symbolName - Human-readable name (e.g., "Gold")
 * @param {object} analysis - Technical analysis results
 * @param {object} macro - { dxy, tnx, vix } institutional keys
 * @param {string[]} correlationNotes - Generated correlation notes
 * @param {object} riskMetrics - ATR, expected move, vol regime
 * @param {Array} calendar - Upcoming economic events
 * @param {string|null} symbol - Watchlist key, used for cache & memory
 * @returns {Promise<string|null>} The verdict text or null on failure
 */
async function generateWarRoomVerdict(symbolName, analysis, macro, correlationNotes, riskMetrics, calendar, symbol = null) {
    const client = getClient();
    if (!client) return null;

    // Cache key includes model so model upgrades invalidate old verdicts
    const cacheKey = `verdict:${config.cerebrasModel}:${symbol || symbolName}`;
    if (config.llmCacheTtl > 0) {
        const cached = llmCache.get(cacheKey);
        if (cached) {
            console.log(`[LLM] Cache HIT for verdict:${symbol || symbolName} — reusing generated verdict`);
            return cached;
        }
    }

    // Build the data packet for the LLM
    const dataBlock = [];

    // Technical Analysis
    dataBlock.push(`TECHNICAL ANALYSIS for ${symbolName}:`);
    if (analysis.rsi) dataBlock.push(`  RSI(14): ${analysis.rsi} — ${analysis.rsiSignal}`);
    if (analysis.macd) dataBlock.push(`  MACD: ${analysis.macdSignal} (histogram: ${analysis.macd.histogram})`);
    dataBlock.push(`  Trend: ${analysis.trendSignal}`);
    if (analysis.divergence?.type !== 'none') {
        dataBlock.push(`  ⚠️ DIVERGENCE: ${analysis.divergence.type.toUpperCase()} — ${analysis.divergence.details}`);
    }

    // Risk Metrics
    if (riskMetrics) {
        dataBlock.push(`\nRISK METRICS:`);
        dataBlock.push(`  ATR(14): ${riskMetrics.atr} (avg: ${riskMetrics.atrAvg})`);
        dataBlock.push(`  Expected 1-Day Move: ±${riskMetrics.expectedMove} (${riskMetrics.expectedMovePercent}%)`);
        dataBlock.push(`  Volatility Regime: ${riskMetrics.regime}`);
    }

    // Macro Context
    dataBlock.push(`\nINSTITUTIONAL KEYS:`);
    if (macro?.dxy) dataBlock.push(`  DXY: ${macro.dxy.price} (${macro.dxy.changePercent >= 0 ? '+' : ''}${macro.dxy.changePercent?.toFixed(2)}%)`);
    if (macro?.tnx) dataBlock.push(`  10Y Yield: ${macro.tnx.price}% (${macro.tnx.changePercent >= 0 ? '+' : ''}${macro.tnx.changePercent?.toFixed(2)}%)`);
    if (macro?.vix) dataBlock.push(`  VIX: ${macro.vix.price} (${macro.vix.changePercent >= 0 ? '+' : ''}${macro.vix.changePercent?.toFixed(2)}%)`);

    // Correlation Notes
    if (correlationNotes?.length > 0) {
        dataBlock.push(`\nCORRELATION SIGNALS:`);
        correlationNotes.forEach(n => dataBlock.push(`  ${n}`));
    }

    // Economic Calendar
    if (calendar?.length > 0) {
        dataBlock.push(`\nUPCOMING EVENTS:`);
        calendar.forEach(e => {
            const impact = e.impact === 'high' ? '🚨 HIGH IMPACT' : '⚪';
            dataBlock.push(`  ${impact} ${e.event} — ${e.countdown}`);
        });
    }

    // Inject historical memory
    const memoryContext = memory.assembleContext('verdict', { symbol, name: symbolName });

    const prompt = `ROLE: You are a Senior Macro Strategist delivering a War Room verdict for the desk.

CONTEXT: You are briefing the team on ${symbolName}. Below is all available data.
${memoryContext}
━━━ DATA PACKET ━━━

${dataBlock.join('\n')}

━━━ YOUR VERDICT ━━━

Write a 2-3 paragraph War Room Verdict:

Paragraph 1: Directional bias — is this a buy, sell, or sit-on-hands situation? What's the conviction level? Reference the specific TA signals that support your view.

Paragraph 2: Macro context — how do the institutional keys (DXY, yields, VIX) affect this asset right now? Any cross-asset signals reinforcing or contradicting the TA?

Paragraph 3 (if warranted): Risk management — given the volatility regime and any upcoming events, what should position sizing and stop placement look like? Any event risk that could invalidate the thesis?

IMPORTANT: If historical memory is available above, reference it. For example: "My previous verdict was bullish, and that thesis has played out / been invalidated because..." or "DXY has been strengthening for 5 consecutive sessions, which historically has pressured this asset."

Be sharp, direct, and specific. Reference actual numbers from the data. No fluff. Write like a PM is about to size a position based on this, but dont use overly complicated vocabulary.`;

    try {
        const completion = await client.chat.completions.create({
            model: config.cerebrasModel,
            messages: [
                { role: 'system', content: 'You are a Senior Macro Strategist. Be concise and actionable. No markdown formatting — plain text only, use \\n\\n between paragraphs.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
            max_tokens: 800,
        });

        const response = completion.choices[0]?.message?.content;

        // Persist the verdict for future context
        if (response) {
            memory.persistLlmOutput('verdict', symbol, null, response, `TA + macro for ${symbolName}`, config.cerebrasModel);
            // Also persist the correlation snapshot
            if (macro) {
                memory.persistCorrelation(symbol, macro, { current: analysis.smaShort, changePercent: null });
            }
            // Cache for deduplication
            if (config.llmCacheTtl > 0) {
                llmCache.set(cacheKey, response);
                console.log(`[LLM] Cache SET for verdict:${symbol || symbolName} (TTL: ${config.llmCacheTtl / 60000}min)`);
            }
        }

        return response || null;
    } catch (error) {
        console.error('[LLM] War Room Verdict generation failed:', error.message);
        return null;
    }
}

/**
 * Generate an AI daily market recap.
 * Results are cached for `llmCacheTtl` ms — if two users run /recap within
 * the window, the second one gets the same briefing instantly.
 * @param {object} allQuotes - All watchlist quotes with change data
 * @param {object} macro - Institutional keys (DXY, 10Y, VIX)
 * @param {object} fearGreed - Fear & Greed Index data
 * @param {Array} fundingRates - Crypto funding rates
 * @param {Array} calendar - Economic events
 * @returns {Promise<string|null>}
 */
async function generateDailyRecap(allQuotes, macro, fearGreed, fundingRates, calendar) {
    const client = getClient();
    if (!client) return null;

    // Cache key includes model so model upgrades invalidate old recaps
    const cacheKey = `recap:${config.cerebrasModel}`;
    if (config.llmCacheTtl > 0) {
        const cached = llmCache.get(cacheKey);
        if (cached) {
            console.log('[LLM] Cache HIT for recap — reusing generated recap');
            // Still persist market data even on cache hit
            memory.persistMarketPulse(allQuotes, macro, fearGreed, fundingRates);
            return cached;
        }
    }

    const dataBlock = [];

    // Market Movers
    dataBlock.push('━━━ TODAY\'S MOVERS ━━━');
    for (const [symbol, data] of Object.entries(allQuotes)) {
        if (data.quote && data.quote.current) {
            const q = data.quote;
            const pct = (q.changePercent || 0).toFixed(2);
            const dir = parseFloat(pct) >= 0 ? '▲' : '▼';
            dataBlock.push(`${data.emoji} ${data.name}: $${q.current.toFixed(2)} ${dir} ${pct}%`);
        }
    }

    // Macro
    dataBlock.push('\n━━━ MACRO ENVIRONMENT ━━━');
    if (macro?.dxy) dataBlock.push(`DXY: ${macro.dxy.price?.toFixed(2)} (${(macro.dxy.changePercent || 0) >= 0 ? '+' : ''}${(macro.dxy.changePercent || 0).toFixed(2)}%)`);
    if (macro?.tnx) dataBlock.push(`10Y Yield: ${macro.tnx.price?.toFixed(2)}% (${(macro.tnx.changePercent || 0) >= 0 ? '+' : ''}${(macro.tnx.changePercent || 0).toFixed(2)}%)`);
    if (macro?.vix) dataBlock.push(`VIX: ${macro.vix.price?.toFixed(2)} (${(macro.vix.changePercent || 0) >= 0 ? '+' : ''}${(macro.vix.changePercent || 0).toFixed(2)}%)`);

    // Sentiment
    dataBlock.push('\n━━━ SENTIMENT ━━━');
    if (fearGreed) dataBlock.push(`Crypto Fear & Greed: ${fearGreed.value}/100 — ${fearGreed.label}`);
    if (fundingRates?.length > 0) {
        fundingRates.forEach(fr => {
            dataBlock.push(`${fr.symbol} Funding Rate: ${fr.ratePercent}`);
        });
    }

    // Calendar
    if (calendar?.length > 0) {
        dataBlock.push('\n━━━ UPCOMING EVENTS ━━━');
        calendar.forEach(e => {
            const impact = e.impact === 'high' ? '[HIGH IMPACT]' : '';
            dataBlock.push(`${impact} ${e.event} — ${e.countdown}`);
        });
    }

    // Inject historical memory for trend comparison
    const memoryContext = memory.assembleContext('recap');

    const prompt = `ROLE: You are an experienced trader recapping the day for your Discord trading group. You're smart but you talk like a real person — no finance-school jargon, no overly complex words. Just clear, direct, conversational English that anyone can follow.
${memoryContext}
━━━ TODAY'S MARKET DATA ━━━

${dataBlock.join('\n')}

━━━ YOUR RECAP ━━━

Write a 3-4 paragraph recap in plain, everyday English:

Paragraph 1: "What happened today?" — Lead with the biggest movers. Talk like you're texting a friend. Use specific prices and percentages, but keep the tone casual and direct. No need for phrases like "risk-off regime" — just say "people got scared and sold."

Paragraph 2: "The bigger picture" — What's the dollar doing? Are interest rates moving? Is the fear index high or low? Explain what that means in plain terms — for example, "When DXY goes up, commodities usually take a hit" instead of "DXY strength creates headwinds for USD-denominated assets."

Paragraph 3: "What the crowd is doing" — What does the Crypto Fear & Greed number tell us about mood? Are traders piling long or short (funding rates)? If everyone's leaning one way hard, that's usually a warning sign.

Paragraph 4: "What to watch tomorrow" — Key price levels or events coming up. Be specific. Give the group something to look for — no vague stuff like "watch for volatility."

IMPORTANT: Keep it simple and readable. If you find yourself writing a word that sounds like it belongs in a Bloomberg article, replace it with a simpler version. Use historical memory above to mention trends over multiple days if available.`;

    try {
        const completion = await client.chat.completions.create({
            model: config.cerebrasModel,
            messages: [
                { role: 'system', content: 'You are a trader writing a daily recap for your Discord trading group. Write in plain, conversational English — no jargon, no complex vocab. Use \\n\\n between paragraphs. No markdown, just plain text.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.4,
            max_tokens: 1200,
        });

        const response = completion.choices[0]?.message?.content || null;

        // Persist the recap and market data
        if (response) {
            memory.persistLlmOutput('recap', null, null, response, `${Object.keys(allQuotes).length} symbols + macro + sentiment`, config.cerebrasModel);
            // Cache for deduplication
            if (config.llmCacheTtl > 0) {
                llmCache.set(cacheKey, response);
                console.log(`[LLM] Cache SET for recap (TTL: ${config.llmCacheTtl / 60000}min)`);
            }
        }
        memory.persistMarketPulse(allQuotes, macro, fearGreed, fundingRates);

        return response;
    } catch (error) {
        console.error('[LLM] Daily recap generation failed:', error.message);
        return null;
    }
}

/**
 * Annotate algorithmically-detected support/resistance levels with LLM context.
 * The LLM receives pre-computed real price levels from detectLevels() and ONLY:
 *   - Writes a short reason why each level matters NOW (given TA + macro context)
 *   - Returns a directional bias and a decision zone
 *   - Writes a 2-3 sentence overall read
 *
 * The LLM CANNOT invent price levels — they are all pre-computed from real candle data.
 * This eliminates hallucination and guarantees every level shown is real.
 *
 * @param {string} name - Asset display name
 * @param {object} candles - OHLCV candle arrays
 * @param {object} quote - Current quote data
 * @param {object} analysis - TA results
 * @param {object} detectedLevels - Output of detectLevels() from technicalAnalysisService
 * @returns {Promise<object|null>}
 */
async function generateLevels(name, candles, quote, analysis, detectedLevels) {
    const client = getClient();

    // ── If no LLM available, return raw algorithmic levels directly ───────────
    if (!client || !detectedLevels) {
        if (!detectedLevels) return null;
        // Return the raw levels with generic notes — no LLM needed
        return {
            resistances: detectedLevels.resistances.slice(0, 3),
            supports: detectedLevels.supports.slice(0, 3),
            pivot: detectedLevels.pivot,
            decisionZone: buildDecisionZone(detectedLevels, quote?.current),
            bias: analysis?.rsi > 50 ? 'Bullish' : analysis?.rsi < 50 ? 'Bearish' : 'Neutral',
            analysis: `Price at $${(quote?.current || detectedLevels.currentPrice).toFixed(2)}. Key pivot: $${detectedLevels.pivot.toFixed(2)} (${(quote?.current || detectedLevels.currentPrice) > detectedLevels.pivot ? 'above' : 'below'}).`,
        };
    }

    // Cache key includes model so model upgrades invalidate old levels
    const cacheKey = `levels:${config.cerebrasModel}:${name}`;
    if (config.llmCacheTtl > 0) {
        const cached = llmCache.get(cacheKey);
        if (cached) {
            console.log(`[LLM] Cache HIT for levels:${name} — reusing`);
            return cached;
        }
    }

    const currentPrice = quote?.current || detectedLevels.currentPrice;

    // Build the resistance/support block with real prices
    const resLines = detectedLevels.resistances.slice(0, 4).map((r, i) =>
        `RES${i + 1}: $${r.price.toFixed(2)} [${r.label}] — detected by: ${r.methods.join(', ')}`
    ).join('\n');

    const supLines = detectedLevels.supports.slice(0, 4).map((s, i) =>
        `SUP${i + 1}: $${s.price.toFixed(2)} [${s.label}] — detected by: ${s.methods.join(', ')}`
    ).join('\n');

    const fibBlock = [
        `90d High: $${detectedLevels.fibLevels.rangeHigh.toFixed(2)}`,
        `Fib 23.6%: $${detectedLevels.fibLevels.fib236.toFixed(2)}`,
        `Fib 38.2%: $${detectedLevels.fibLevels.fib382.toFixed(2)}`,
        `Fib 50.0%: $${detectedLevels.fibLevels.fib500.toFixed(2)}`,
        `Fib 61.8%: $${detectedLevels.fibLevels.fib618.toFixed(2)}`,
        `90d Low:  $${detectedLevels.fibLevels.rangeLow.toFixed(2)}`,
    ].join('\n');

    const memoryContext = memory.assembleContext('levels', { symbol: name, name });

    const prompt = `ASSET: ${name}
CURRENT PRICE: $${currentPrice.toFixed(2)}
PIVOT POINT: $${detectedLevels.pivot.toFixed(2)}
SMA-20: $${detectedLevels.smaDynamic.sma20.toFixed(2)}${detectedLevels.smaDynamic.sma50 ? ` | SMA-50: $${detectedLevels.smaDynamic.sma50.toFixed(2)}` : ''}
RSI(14): ${analysis?.rsi || 'N/A'} — ${analysis?.rsiSignal || 'N/A'}
MACD: ${analysis?.macdSignal || 'N/A'}
Trend: ${analysis?.trendSignal || 'N/A'}
${memoryContext}
━━━ ALGORITHMICALLY DETECTED LEVELS (DO NOT CHANGE THESE PRICES) ━━━

RESISTANCE ZONE:
${resLines}

SUPPORT ZONE:
${supLines}

FIBONACCI GRID:
${fibBlock}

━━━ YOUR JOB ━━━

The prices above are FIXED — they come from real price data. Do NOT change or invent new prices.

Your job is to:
1. For each resistance and support level listed above, write a ≤12-word reason why it matters NOW given the RSI, MACD, trend, and price position.
2. Identify the most important decision zone (tight range where a break in either direction sets the next move)
3. Write a 2-sentence overall market read for ${name}
4. Give a bias: Bullish, Bearish, or Neutral

Respond ONLY with valid JSON, no markdown, no code fences:
{
  "resistanceNotes": {"RES1": "reason ≤12 words", "RES2": "...", "RES3": "...", "RES4": "..."},
  "supportNotes": {"SUP1": "reason ≤12 words", "SUP2": "...", "SUP3": "...", "SUP4": "..."},
  "decisionZone": {"low": <number from support list>, "high": <number from resistance list>, "note": "≤15 words on what a break means"},
  "bias": "Bullish|Bearish|Neutral",
  "analysis": "2 sentences. Reference specific prices. Plain language."
}`;

    try {
        const completion = await client.chat.completions.create({
            model: config.cerebrasModel,
            messages: [
                { role: 'system', content: 'You are a technical analyst. Output ONLY valid JSON. Do not invent or change any price numbers. All prices come from the user.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.15,
            max_tokens: 800,
        });

        const raw = completion.choices[0]?.message?.content;
        if (!raw) throw new Error('Empty LLM response');

        const parsed = JSON.parse(raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());

        // Merge LLM annotations back onto the algorithmic levels
        const resistances = detectedLevels.resistances.slice(0, 4).map((r, i) => ({
            ...r,
            note: parsed.resistanceNotes?.[`RES${i + 1}`] || r.note,
        }));
        const supports = detectedLevels.supports.slice(0, 4).map((s, i) => ({
            ...s,
            note: parsed.supportNotes?.[`SUP${i + 1}`] || s.note,
        }));

        const result = {
            resistances,
            supports,
            pivot: detectedLevels.pivot,
            decisionZone: parsed.decisionZone || buildDecisionZone(detectedLevels, currentPrice),
            bias: parsed.bias || 'Neutral',
            analysis: parsed.analysis || null,
        };

        // Persist and cache
        memory.persistLlmOutput('levels', name, null, JSON.stringify(result), `price $${currentPrice.toFixed(2)}`, config.cerebrasModel);
        if (config.llmCacheTtl > 0) {
            llmCache.set(cacheKey, result);
            console.log(`[LLM] Cache SET for levels:${name}`);
        }

        return result;
    } catch (error) {
        console.error('[LLM] Levels annotation failed, returning raw algorithmic levels:', error.message);

        // Graceful fallback: return algorithmic levels without LLM notes
        return {
            resistances: detectedLevels.resistances.slice(0, 3),
            supports: detectedLevels.supports.slice(0, 3),
            pivot: detectedLevels.pivot,
            decisionZone: buildDecisionZone(detectedLevels, currentPrice),
            bias: analysis?.rsi > 55 ? 'Bullish' : analysis?.rsi < 45 ? 'Bearish' : 'Neutral',
            analysis: `Price at $${currentPrice.toFixed(2)}, pivot at $${detectedLevels.pivot.toFixed(2)}.`,
        };
    }
}

/** Build a decision zone from nearest support/resistance without LLM */
function buildDecisionZone(detectedLevels, currentPrice) {
    const nearRes = detectedLevels.resistances[0]?.price;
    const nearSup = detectedLevels.supports[0]?.price;
    if (!nearRes || !nearSup) return null;
    return {
        low: nearSup,
        high: nearRes,
        note: `Break above $${nearRes.toFixed(2)} or below $${nearSup.toFixed(2)} sets direction`,
    };
}

module.exports = { summarizeNews, generateWarRoomVerdict, generateDailyRecap, generateLevels };
