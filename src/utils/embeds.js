const { EmbedBuilder } = require('discord.js');
const { getSentimentEmoji } = require('../services/newsService');

const COLORS = {
    news: 0x1DA1F2,      // Twitter blue
    bullish: 0x00C853,   // Green
    bearish: 0xFF1744,   // Red
    neutral: 0x78909C,   // Blue grey
    watchlist: 0xFFC107, // Amber
    alert: 0xFF6D00,     // Orange
};

const CATEGORY_EMOJI = {
    oil: '🛢️',
    metals: '🥇',
    crypto: '₿',
    forex: '💱',
    general: '📰',
};

/**
 * Build rich news embed(s) with impact tags, source tiers, price ticker, and synthesis.
 * Returns an array of EmbedBuilder (may be 1 or 2 embeds to handle Discord's 4096-char limit).
 *
 * @param {Array} headlines - Filtered, scored articles
 * @param {string} category
 * @param {string|null} tldr - LLM briefing
 * @param {object} headlineTldrs - { 'headline': 'why it matters' }
 * @param {object} tickers - { 'SYMBOL': { name, emoji, quote } }
 * @param {number} totalCollected - How many were collected before filtering
 * @param {string|null} synthesis - Cross-headline synthesis sentence from LLM
 * @returns {EmbedBuilder|EmbedBuilder[]}
 */
function buildNewsEmbed(headlines, category = 'all', tldr = null, headlineTldrs = {}, tickers = {}, totalCollected = 0, synthesis = null) {
    const emoji = category === 'all' ? '📰' : (CATEGORY_EMOJI[category] || '📰');
    const catLabel = category === 'all' ? 'All Markets' : category.charAt(0).toUpperCase() + category.slice(1);
    const title = `${emoji} ${catLabel} News`;

    const footerText = `${totalCollected > 0 ? `${headlines.length} of ${totalCollected} headlines • ` : ''}Reuters · AP · MarketWatch · Investing.com + more`;

    // Build price ticker strip
    let tickerStrip = '';
    const tickerEntries = Object.values(tickers).filter(t => t?.quote?.current);
    if (tickerEntries.length > 0) {
        tickerStrip = tickerEntries.map(t => {
            const pct = (t.quote.changePercent || 0).toFixed(2);
            const dir = t.quote.changePercent >= 0 ? '▲' : '▼';
            return `**${t.emoji} ${t.name}** $${t.quote.current.toFixed(t.quote.current > 100 ? 2 : 4)} ${dir}${Math.abs(pct)}%`;
        }).join(' · ');
        tickerStrip = `┌─ ${tickerStrip} ─┐\n\n`;
    }

    if (headlines.length === 0) {
        return new EmbedBuilder()
            .setTitle(title).setColor(COLORS.news).setTimestamp()
            .setFooter({ text: footerText })
            .setDescription(`${tickerStrip}No relevant news found at this time. Try again later.`);
    }

    // Format each headline
    function formatHeadline(h, i) {
        // Impact tag — prefer LLM override, fall back to score-based
        const impact = h.llmImpact || (h.impactScore >= 8 ? 'high' : h.impactScore >= 5 ? 'medium' : 'low');
        const impactEmoji = impact === 'high' ? '🔥' : impact === 'medium' ? '📋' : '💤';

        // Source tier
        const tierStars = h.tier === 1 ? '★★★' : h.tier === 2 ? '★★' : '★';
        const time = h.timestamp ? `<t:${h.timestamp}:R>` : '';

        // Why it matters (LLM TLDR > article summary)
        let mini = '';
        if (headlineTldrs[h.headline]) {
            mini = `\n> *${headlineTldrs[h.headline]}*`;
        } else if (h.summary) {
            const cleaned = h.summary.replace(/\n/g, ' ').trim();
            if (cleaned.length > 0) {
                mini = `\n> *${cleaned.length > 110 ? cleaned.substring(0, 107) + '...' : cleaned}*`;
            }
        }

        const catEmoji = CATEGORY_EMOJI[h.category] || '';
        return `${impactEmoji} **${i + 1}.** [${h.headline}](${h.url})${mini}\n${catEmoji} ${tierStars} *${h.source}* ${time}`;
    }

    // Build description content
    const sections = [];

    // Price ticker
    if (tickerStrip) sections.push(tickerStrip.trimEnd());

    // AI briefing
    if (tldr) {
        const quotedTldr = tldr.split('\n').map(l => `> ${l}`).join('\n');
        sections.push(`🧠 **AI Market Brief:**\n${quotedTldr}`);
    }

    // Cross-headline synthesis callout
    if (synthesis) {
        sections.push(`⚡ **Synthesis:** *${synthesis}*`);
    }

    if (tldr || synthesis || tickerStrip) sections.push('───────────────────');

    // Impact legend (only if AI was used)
    if (Object.keys(headlineTldrs).length > 0) {
        sections.push('🔥 High Impact · 📋 Medium · 💤 Low · ★★★ Wire service');
    }

    // Format all headlines
    const formattedLines = headlines.map((h, i) => formatHeadline(h, i));

    // Smart pagination: split into 2 embeds if content exceeds 4000 chars
    const headerContent = sections.join('\n\n');
    const allHeadlinesContent = formattedLines.join('\n\n');

    const totalLength = headerContent.length + allHeadlinesContent.length;

    if (totalLength <= 3900) {
        // Fits in one embed
        const description = [headerContent, allHeadlinesContent].filter(Boolean).join('\n\n');
        return new EmbedBuilder()
            .setTitle(title).setColor(COLORS.news).setTimestamp()
            .setFooter({ text: footerText })
            .setDescription(description.substring(0, 4096));
    }

    // Split into two embeds
    const splitPoint = Math.ceil(formattedLines.length / 2);
    const page1Lines = formattedLines.slice(0, splitPoint);
    const page2Lines = formattedLines.slice(splitPoint);

    const embed1 = new EmbedBuilder()
        .setTitle(title).setColor(COLORS.news).setTimestamp()
        .setFooter({ text: `Page 1/2 · ${footerText}` })
        .setDescription([headerContent, page1Lines.join('\n\n')].filter(Boolean).join('\n\n').substring(0, 4096));

    const embed2 = new EmbedBuilder()
        .setColor(COLORS.news)
        .setFooter({ text: `Page 2/2 · ${footerText}` })
        .setDescription(page2Lines.join('\n\n').substring(0, 4096));

    return [embed1, embed2];
}

/**
 * Build a War Room analysis embed.
 * @param {string} symbol
 * @param {string} name
 * @param {object} analysis
 * @param {object} quote
 * @param {object} extras - { macro, correlationNotes, calendar, verdict }
 * @returns {EmbedBuilder}
 */
function buildAnalysisEmbed(symbol, name, analysis, quote, extras = {}) {
    const { macro, correlationNotes, calendar, verdict, cot } = extras;

    const isBullish = analysis.rsi && analysis.rsi < 50;
    const color = analysis.divergence?.type === 'bullish' ? COLORS.bullish
        : analysis.divergence?.type === 'bearish' ? COLORS.bearish
            : isBullish ? COLORS.bullish : COLORS.neutral;

    const embed = new EmbedBuilder()
        .setTitle(`🎯 War Room: ${name}`)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: `${symbol} • Powered by Groq AI + Yahoo Finance` });

    // ─── AI War Room Verdict ──────────────────────────────────────
    if (verdict) {
        const quotedVerdict = verdict.split('\n').map(line => `> ${line}`).join('\n');
        embed.setDescription(`🧠 **AI Verdict:**\n${quotedVerdict}\n\n───────────────────`);
    }

    // ─── Price ────────────────────────────────────────────────────
    if (quote) {
        const changeEmoji = (quote.changePercent || 0) >= 0 ? '🟢' : '🔴';
        embed.addFields({
            name: '💰 Price',
            value: `**$${quote.current?.toFixed(2)}** ${changeEmoji} ${(quote.changePercent || 0).toFixed(2)}%\nH: $${(quote.high || 0).toFixed(2)} | L: $${(quote.low || 0).toFixed(2)}`,
            inline: true,
        });
    }

    // ─── RSI ──────────────────────────────────────────────────────
    if (analysis.rsi !== null) {
        const rsiBar = buildProgressBar(analysis.rsi, 100);
        embed.addFields({
            name: `📈 RSI (${analysis.rsi})`,
            value: `${rsiBar}\n${analysis.rsiSignal}`,
            inline: true,
        });
    }

    // ─── MACD ─────────────────────────────────────────────────────
    if (analysis.macd) {
        const histEmoji = analysis.macd.histogram > 0 ? '🟢' : '🔴';
        embed.addFields({
            name: `${histEmoji} MACD`,
            value: `Hist: ${analysis.macd.histogram}\n${analysis.macdSignal}`,
            inline: true,
        });
    }

    // ─── Moving Averages ──────────────────────────────────────────
    if (analysis.smaShort || analysis.smaLong) {
        embed.addFields({
            name: '〰️ Trend',
            value: `SMA20: ${analysis.smaShort || 'N/A'}\nSMA50: ${analysis.smaLong || 'N/A'}\n${analysis.trendSignal}`,
            inline: true,
        });
    }

    // ─── Volume ───────────────────────────────────────────────────
    if (analysis.volume) {
        const v = analysis.volume;
        embed.addFields({
            name: '🔊 Volume',
            value: `${v.label}${v.ratio ? ` (${v.ratio}× 20d avg)` : ''}\nTrend: ${v.trend}`,
            inline: true,
        });
    }

    // ─── Divergence ───────────────────────────────────────────────
    if (analysis.divergence && analysis.divergence.type !== 'none') {
        const divEmoji = analysis.divergence.type === 'bullish' ? '🟢' : '🔴';
        const strengthBar = analysis.divergence.strength > 0
            ? `\nStrength: ${'█'.repeat(analysis.divergence.strength)}${'░'.repeat(10 - analysis.divergence.strength)} (${analysis.divergence.strength}/10)`
            : '';
        embed.addFields({
            name: `${divEmoji} Divergence`,
            value: `**${analysis.divergence.type.toUpperCase()}**\n${analysis.divergence.details}${strengthBar}`,
            inline: false,
        });
    }

    // ─── Institutional Keys (DXY, 10Y, VIX) ──────────────────────
    if (macro && (macro.dxy || macro.tnx || macro.vix)) {
        const lines = [];
        if (macro.dxy) {
            const e = (macro.dxy.changePercent || 0) >= 0 ? '🟢' : '🔴';
            lines.push(`💵 DXY: **${macro.dxy.price?.toFixed(2)}** ${e} ${(macro.dxy.changePercent || 0).toFixed(2)}%`);
        }
        if (macro.tnx) {
            const e = (macro.tnx.changePercent || 0) >= 0 ? '🟢' : '🔴';
            lines.push(`🏛️ 10Y: **${macro.tnx.price?.toFixed(2)}%** ${e} ${(macro.tnx.changePercent || 0).toFixed(2)}%`);
        }
        if (macro.vix) {
            const vixEmoji = macro.vix.price > 25 ? '😱' : macro.vix.price > 18 ? '😰' : '😎';
            const e = (macro.vix.changePercent || 0) >= 0 ? '🟢' : '🔴';
            lines.push(`${vixEmoji} VIX: **${macro.vix.price?.toFixed(2)}** ${e} ${(macro.vix.changePercent || 0).toFixed(2)}%`);
        }
        embed.addFields({
            name: '🏛️ INSTITUTIONAL KEYS',
            value: lines.join('\n'),
            inline: false,
        });
    }

    // ─── Risk Metrics (ATR, Expected Move, Vol Regime) ────────────
    if (analysis.riskMetrics) {
        const rm = analysis.riskMetrics;
        embed.addFields({
            name: '⚡ RISK METRICS',
            value: `ATR(14): **${rm.atr}** pts (avg: ${rm.atrAvg})\nExpected Move: **±$${rm.expectedMove}** (${rm.expectedMovePercent}%)\nRegime: ${rm.regimeEmoji} **${rm.regime}** Volatility`,
            inline: false,
        });
    }

    // ─── COT Positioning (Commitment of Traders) ─────────────────
    if (cot) {
        const fmt = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString());
        const wk = Number.isFinite(Number(cot.commercialChange)) ? ` (${cot.commercialChange >= 0 ? '+' : ''}${fmt(cot.commercialChange)} wk)` : '';
        embed.addFields({
            name: '🏦 COT POSITIONING',
            value: `${cot.sentimentEmoji || ''} **${cot.sentiment || '—'}**\nCommercials: ${fmt(cot.commercialNet)} net${wk}\nLarge specs: ${fmt(cot.speculatorNet)} net${cot.reportDate ? `\n_report ${cot.reportDate}_` : ''}`,
            inline: false,
        });
    }

    // ─── Correlation Signals ──────────────────────────────────────
    if (correlationNotes && correlationNotes.length > 0) {
        embed.addFields({
            name: '🔗 CORRELATION SIGNALS',
            value: correlationNotes.join('\n'),
            inline: false,
        });
    }

    // ─── Economic Calendar ────────────────────────────────────────
    if (calendar && calendar.length > 0) {
        const calendarLines = calendar.map(e => {
            const icon = e.impact === 'high' ? '🚨' : '⚪';
            return `${icon} **${e.event}** — ${e.countdown}`;
        });
        embed.addFields({
            name: '📅 NEXT CATALYST',
            value: calendarLines.join('\n') || 'No major events today',
            inline: false,
        });
    }

    return embed;
}

/**
 * Build a Market Pulse dashboard embed.
 * @param {object} symbolData - All watchlist symbols with quotes + miniAnalysis
 * @param {object} extras - { macro, calendar, fearGreed, fundingRates }
 * @returns {EmbedBuilder}
 */
function buildPulseEmbed(symbolData, extras = {}) {
    const { macro, calendar, fearGreed, fundingRates } = extras;

    const embed = new EmbedBuilder()
        .setTitle('⚡ MARKET PULSE')
        .setColor(COLORS.watchlist)
        .setTimestamp()
        .setFooter({ text: 'Powered by Yahoo Finance + Groq AI' });

    // ─── Macro Regime Bar ─────────────────────────────────────────
    const headerLines = [];

    if (macro) {
        const regimeParts = [];
        if (macro.vix) {
            const vixEmoji = macro.vix.price > 25 ? '😱' : macro.vix.price > 18 ? '😰' : '😎';
            regimeParts.push(`VIX: ${macro.vix.price?.toFixed(1)} ${vixEmoji}`);
        }
        if (macro.dxy) {
            const e = (macro.dxy.changePercent || 0) >= 0 ? '🟢' : '🔴';
            regimeParts.push(`DXY: ${macro.dxy.price?.toFixed(1)} ${e}`);
        }
        if (macro.tnx) {
            const e = (macro.tnx.changePercent || 0) >= 0 ? '🟢' : '🔴';
            regimeParts.push(`10Y: ${macro.tnx.price?.toFixed(2)}% ${e}`);
        }
        if (regimeParts.length > 0) {
            headerLines.push(`🏛️ ${regimeParts.join(' │ ')}`);
        }
    }

    if (fearGreed) {
        const { getFearGreedEmoji, buildFearGreedBar } = require('../services/sentimentService');
        const fgEmoji = getFearGreedEmoji(fearGreed.value);
        const fgBar = buildFearGreedBar(fearGreed.value);
        headerLines.push(`${fgEmoji} Fear & Greed: **${fearGreed.value}/100** — ${fearGreed.label}\n${fgBar}`);
    }

    if (headerLines.length > 0) {
        embed.setDescription(headerLines.join('\n\n'));
    }

    // ─── Group symbols by category ────────────────────────────────
    const categories = { oil: [], metals: [], crypto: [], forex: [] };

    for (const [symbol, data] of Object.entries(symbolData)) {
        const cat = data.category || 'general';
        if (!categories[cat]) categories[cat] = [];

        const q = data.quote;
        let line;
        if (q && q.current) {
            const changeEmoji = (q.changePercent || 0) >= 0 ? '🟢' : '🔴';
            const pct = (q.changePercent || 0).toFixed(2);

            // Mini RSI indicator
            let rsiTag = '';
            if (data.miniAnalysis?.rsi) {
                const rsi = data.miniAnalysis.rsi;
                if (rsi > 70) rsiTag = ' ⚠️ OB';
                else if (rsi > 60) rsiTag = ' ↑';
                else if (rsi < 30) rsiTag = ' ⚠️ OS';
                else if (rsi < 40) rsiTag = ' ↓';
                else rsiTag = ' →';
            }

            line = `${data.emoji} **${data.name}**: $${q.current.toFixed(2)} ${changeEmoji} ${pct}%${rsiTag}`;
        } else {
            line = `${data.emoji} **${data.name}**: *awaiting data*`;
        }
        categories[cat].push(line);
    }

    // Category labels
    const catLabels = {
        oil: '🛢️ Energy',
        metals: '🥇 Metals',
        crypto: '₿ Crypto',
        forex: '💱 Forex',
    };

    for (const [cat, lines] of Object.entries(categories)) {
        if (lines.length > 0) {
            embed.addFields({
                name: catLabels[cat] || cat,
                value: lines.join('\n'),
                inline: true,
            });
        }
    }

    // ─── Funding Rates (crypto section extra) ─────────────────────
    if (fundingRates && fundingRates.length > 0) {
        const { interpretFundingRate } = require('../services/sentimentService');
        const frLines = fundingRates.map(fr => {
            const label = fr.symbol === 'BTCUSDT' ? '₿ BTC' : 'Ξ ETH';
            return `${label}: **${fr.ratePercent}** — ${interpretFundingRate(fr.rate)}`;
        });
        embed.addFields({
            name: '📊 Funding Rates',
            value: frLines.join('\n'),
            inline: false,
        });
    }

    // ─── Next Event (compact) ─────────────────────────────────────
    if (calendar && calendar.length > 0) {
        const nextEvent = calendar[0]; // Highest priority event
        const icon = nextEvent.impact === 'high' ? '🚨' : '📅';
        embed.addFields({
            name: `${icon} Next Catalyst`,
            value: `**${nextEvent.event}** — ${nextEvent.countdown}`,
            inline: false,
        });
    }

    return embed;
}

/**
 * Build a standalone Economic Calendar embed (2-week view, grouped by day).
 * @param {Array} events
 * @returns {EmbedBuilder}
 */
function buildCalendarEmbed(events) {
    const embed = new EmbedBuilder()
        .setTitle('📅 Economic Calendar — Next 2 Weeks')
        .setColor(COLORS.news)
        .setTimestamp()
        .setFooter({ text: 'Powered by Forex Factory + Finnhub • USD Events' });

    if (!events || events.length === 0) {
        embed.setDescription('No major economic events scheduled in the next 2 weeks. Markets may trade on technicals and sentiment.');
        return embed;
    }

    // Count by impact for header stat
    const highCount = events.filter(e => e.impact === 'high').length;
    const medCount = events.filter(e => e.impact === 'medium').length;

    // Group events by date
    const byDate = {};
    for (const e of events) {
        const dateKey = e.date || 'Unknown';
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(e);
    }

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let description = `🚨 ${highCount} high impact │ 🟡 ${medCount} medium │ ${events.length} total events\n`;
    const today = new Date().toISOString().split('T')[0];

    for (const [dateStr, dayEvents] of Object.entries(byDate)) {
        // Format the date header
        const d = new Date(dateStr + 'T12:00:00Z');
        const dayName = dayNames[d.getUTCDay()];
        const monthName = monthNames[d.getUTCMonth()];
        const dayNum = d.getUTCDate();
        const isToday = dateStr === today;
        const dateLabel = isToday ? `\n📆 **TODAY — ${dayName}, ${monthName} ${dayNum}**` : `\n📆 **${dayName}, ${monthName} ${dayNum}**`;

        description += `${dateLabel}\n`;

        for (const e of dayEvents) {
            // Impact icon: High = 🚨, Medium = 🟡, Low = ⚪
            const icon = e.impact === 'high' ? '🚨' : e.impact === 'medium' ? '🟡' : '⚪';
            const timeStr = e.time !== 'TBD' ? e.time + ' ET' : 'TBD';
            let line = `${icon} **${e.event}** — ${timeStr} (${e.countdown})`;

            // Normalize data fields (FF uses forecast/previous, Finnhub uses estimate/prev/actual)
            const dataParts = [];
            const prev = e.previous || e.prev;
            const est = e.forecast || e.estimate;
            const act = e.actual;
            if (prev !== undefined && prev !== null && prev !== '') dataParts.push(`Prev: ${prev}`);
            if (est !== undefined && est !== null && est !== '') dataParts.push(`Est: ${est}`);
            if (act !== undefined && act !== null && act !== '') dataParts.push(`**Act: ${act}**`);
            if (dataParts.length > 0) line += `\n┗ ${dataParts.join(' │ ')}`;

            description += line + '\n';
        }
    }

    // Discord has a 4096 char limit on description
    if (description.length > 4096) {
        description = description.substring(0, 4090) + '\n…';
    }
    embed.setDescription(description);
    return embed;
}

/**
 * Build a Daily Recap embed.
 * @param {object} allQuotes
 * @param {object} extras - { macro, fearGreed, fundingRates, calendar, recap }
 * @returns {EmbedBuilder}
 */
function buildRecapEmbed(allQuotes, extras = {}) {
    const { macro, fearGreed, fundingRates, calendar, recap } = extras;

    const embed = new EmbedBuilder()
        .setTitle('📋 Daily Market Recap')
        .setColor(COLORS.news)
        .setTimestamp()
        .setFooter({ text: 'AI Desk Briefing • Powered by Groq AI' });

    // ─── AI Recap ─────────────────────────────────────────────────
    if (recap) {
        const quotedRecap = recap.split('\n').map(line => `> ${line}`).join('\n');
        embed.setDescription(`🧠 **AI Desk Briefing:**\n${quotedRecap}`);
    } else {
        embed.setDescription('*AI recap unavailable — showing raw data below.*');
    }

    // ─── Market Movers Summary ────────────────────────────────────
    const movers = Object.entries(allQuotes)
        .filter(([, d]) => d.quote?.changePercent != null)
        .sort((a, b) => Math.abs(b[1].quote.changePercent) - Math.abs(a[1].quote.changePercent));

    if (movers.length > 0) {
        const top = movers.slice(0, 6).map(([, d]) => {
            const q = d.quote;
            const e = (q.changePercent || 0) >= 0 ? '🟢' : '🔴';
            return `${d.emoji} ${d.name}: $${q.current.toFixed(2)} ${e} ${(q.changePercent || 0).toFixed(2)}%`;
        });
        embed.addFields({
            name: '📊 Today\'s Movers',
            value: top.join('\n'),
            inline: false,
        });
    }

    // ─── Macro Snapshot ───────────────────────────────────────────
    if (macro) {
        const macroLines = [];
        if (macro.dxy) {
            const e = (macro.dxy.changePercent || 0) >= 0 ? '🟢' : '🔴';
            macroLines.push(`💵 DXY: ${macro.dxy.price?.toFixed(2)} ${e} ${(macro.dxy.changePercent || 0).toFixed(2)}%`);
        }
        if (macro.tnx) {
            const e = (macro.tnx.changePercent || 0) >= 0 ? '🟢' : '🔴';
            macroLines.push(`🏛️ 10Y: ${macro.tnx.price?.toFixed(2)}% ${e} ${(macro.tnx.changePercent || 0).toFixed(2)}%`);
        }
        if (macro.vix) {
            const vixEmoji = macro.vix.price > 25 ? '😱' : macro.vix.price > 18 ? '😰' : '😎';
            const e = (macro.vix.changePercent || 0) >= 0 ? '🟢' : '🔴';
            macroLines.push(`${vixEmoji} VIX: ${macro.vix.price?.toFixed(2)} ${e} ${(macro.vix.changePercent || 0).toFixed(2)}%`);
        }
        if (macroLines.length > 0) {
            embed.addFields({ name: '🏛️ Macro', value: macroLines.join('\n'), inline: true });
        }
    }

    // ─── Sentiment Snapshot ───────────────────────────────────────
    const sentLines = [];
    if (fearGreed) {
        const { getFearGreedEmoji } = require('../services/sentimentService');
        sentLines.push(`${getFearGreedEmoji(fearGreed.value)} F&G: **${fearGreed.value}** — ${fearGreed.label}`);
    }
    if (fundingRates?.length > 0) {
        fundingRates.forEach(fr => {
            const label = fr.symbol === 'BTCUSDT' ? '₿' : 'Ξ';
            sentLines.push(`${label} Funding: **${fr.ratePercent}**`);
        });
    }
    if (sentLines.length > 0) {
        embed.addFields({ name: '🧠 Sentiment', value: sentLines.join('\n'), inline: true });
    }

    return embed;
}

/**
 * Build a simple progress bar for RSI display.
 */
function buildProgressBar(value, max, length = 12) {
    const filled = Math.round((value / max) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}

/**
 * Build an AI Levels embed showing support/resistance levels.
 * @param {string} symbol
 * @param {string} name
 * @param {object} quote
 * @param {object} levels - AI-generated levels data
 * @returns {EmbedBuilder}
 */
function buildLevelsEmbed(symbol, name, quote, levels) {
    const biasColor = levels.bias === 'Bullish' ? COLORS.bullish
        : levels.bias === 'Bearish' ? COLORS.bearish
            : COLORS.neutral;

    const biasEmoji = levels.bias === 'Bullish' ? '📈'
        : levels.bias === 'Bearish' ? '📉'
            : '➡️';

    const embed = new EmbedBuilder()
        .setTitle(`📐 Key Levels: ${name}`)
        .setColor(biasColor)
        .setTimestamp()
        .setFooter({ text: `${symbol} • Algorithmic + AI levels • 5 methods: Swing, Pivot, Fib, SMA, Range` });

    // ─── Current Price & Bias ─────────────────────────────────────
    if (quote) {
        const changeEmoji = (quote.changePercent || 0) >= 0 ? '📈' : '📉';
        embed.setDescription(`💰 **Current: $${quote.current?.toFixed(2)}** ${changeEmoji} ${(quote.changePercent || 0).toFixed(2)}%\n${biasEmoji} **Bias: ${levels.bias}**`);
    }

    // ─── Resistances (above price) — sorted furthest to nearest ──
    if (levels.resistances && levels.resistances.length > 0) {
        const sorted = [...levels.resistances].sort((a, b) => b.price - a.price);
        const resLines = sorted.map(r => {
            const tag = r.label === 'Major' ? '🔴' : r.label === 'Strong' ? '🟠' : '🟡';
            const methods = r.methods?.length > 0 ? `\`${r.methods.join(' + ')}\`` : '';
            return `${tag} **$${r.price.toFixed(2)}** [${r.label}] ${methods}\n┗ *${r.note}*`;
        });
        embed.addFields({
            name: '🔺 RESISTANCE',
            value: resLines.join('\n'),
            inline: false,
        });
    }

    // ─── Price Position Marker ────────────────────────────────────
    if (quote) {
        embed.addFields({
            name: '━━━━ YOU ARE HERE ━━━━',
            value: `➤ **$${quote.current?.toFixed(2)}**`,
            inline: false,
        });
    }

    // ─── Supports (below price) — sorted nearest to furthest ─────
    if (levels.supports && levels.supports.length > 0) {
        const sorted = [...levels.supports].sort((a, b) => b.price - a.price);
        const supLines = sorted.map(s => {
            const tag = s.label === 'Major' ? '🟢' : s.label === 'Strong' ? '🔵' : '⚪';
            const methods = s.methods?.length > 0 ? `\`${s.methods.join(' + ')}\`` : '';
            return `${tag} **$${s.price.toFixed(2)}** [${s.label}] ${methods}\n┗ *${s.note}*`;
        });
        embed.addFields({
            name: '🔻 SUPPORT',
            value: supLines.join('\n'),
            inline: false,
        });
    }

    // ─── Decision Zone ────────────────────────────────────────────
    if (levels.decisionZone) {
        const dz = levels.decisionZone;
        embed.addFields({
            name: '⚡ DECISION ZONE',
            value: `**$${typeof dz.low === 'number' ? dz.low.toFixed(2) : dz.low} — $${typeof dz.high === 'number' ? dz.high.toFixed(2) : dz.high}**\n${dz.note}`,
            inline: true,
        });
    }

    // ─── Pivot ────────────────────────────────────────────────────
    if (levels.pivot) {
        embed.addFields({
            name: '🎯 Daily Pivot',
            value: `**$${levels.pivot.toFixed(2)}**`,
            inline: true,
        });
    }

    // ─── AI Read ──────────────────────────────────────────────────
    if (levels.analysis) {
        embed.addFields({
            name: '🧠 Market Read',
            value: `> ${levels.analysis}`,
            inline: false,
        });
    }

    return embed;
}

// ─── Anomaly Alert Embed ────────────────────────────────────────────────────

/**
 * Build an alert embed for the anomaly scanner.
 * @param {object} anomaly - { type, severity, key, title, description, fields }
 * @returns {EmbedBuilder}
 */
function buildAlertEmbed(anomaly) {
    const color = anomaly.severity === 'HIGH' ? 0xFF1744 : COLORS.alert;
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(anomaly.title)
        .setDescription(anomaly.description)
        .setTimestamp()
        .setFooter({ text: `Anomaly Scanner • Severity: ${anomaly.severity}` });

    if (anomaly.fields?.length > 0) {
        anomaly.fields.forEach(f => embed.addFields(f));
    }

    return embed;
}

// ─── Level Break Alert ────────────────────────────────────────────────────────
function buildLevelBreakEmbed(event) {
    const isResistance = event.type === 'resistance_break';
    const color = isResistance ? COLORS.bullish : COLORS.bearish;
    const arrow = isResistance ? '🟢 ▲' : '🔴 ▼';
    const label = isResistance ? 'RESISTANCE BREAK' : 'SUPPORT BREAK';
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${arrow} ${event.meta.emoji} ${event.meta.name} — ${label}`)
        .setDescription(`Price **$${event.price.toFixed(2)}** has ${isResistance ? 'broken above' : 'broken below'} **$${event.level.toFixed(2)}** [${event.label}]`)
        .setTimestamp()
        .setFooter({ text: `Level Break Detector • ${event.symbol}` })
        .addFields(
            { name: 'Price', value: `$${event.price.toFixed(2)}`, inline: true },
            { name: 'Level', value: `$${event.level.toFixed(2)}`, inline: true },
            { name: 'Strength', value: event.label || '—', inline: true },
        );
    if (Array.isArray(event.methods) && event.methods.length > 0) {
        embed.addFields({ name: 'Confluence', value: '`' + event.methods.join(' + ') + '`', inline: false });
    }
    if (event.note) embed.addFields({ name: 'Context', value: `*${event.note}*`, inline: false });
    return embed;
}

// ─── MTF Divergence Alert ─────────────────────────────────────────────────────
function buildMtfDivergenceEmbed(event) {
    const isBullish = event.direction === 'bullish';
    const color = isBullish ? COLORS.bullish : COLORS.bearish;
    const arrow = isBullish ? '🟢 BULLISH' : '🔴 BEARISH';
    const tierLabel = event.tier === 'confluence'
        ? '★★★ D1 + W1 CONFLUENCE'
        : '★★ Weekly-only';
    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(`${arrow} Divergence — ${event.meta.emoji} ${event.meta.name}`)
        .setDescription(`**${tierLabel}** divergence detected on ${event.meta.name}.\nCurrent price: **$${event.quote.current.toFixed(2)}**`)
        .setTimestamp()
        .setFooter({ text: `MTF Divergence • ${event.symbol}` })
        .addFields(
            { name: 'Daily Divergence', value: event.daily?.type !== 'none'
                ? `${event.daily.type.toUpperCase()} (strength ${event.daily.strength}/10)\n*${event.daily.details}*`
                : '— none on daily —', inline: false },
            { name: 'Weekly Divergence', value: event.weekly?.type !== 'none'
                ? `${event.weekly.type.toUpperCase()} (strength ${event.weekly.strength}/10)\n*${event.weekly.details}*`
                : '— none on weekly —', inline: false },
        );
    return embed;
}

// ─── Funding-Rate Flip Alert ──────────────────────────────────────────────────
function buildFundingFlipEmbed(event) {
    const isBullish = event.direction === 'bullish';
    const color = isBullish ? COLORS.bullish : COLORS.bearish;
    const verbAdj = event.newSign > 0 ? 'flipped POSITIVE (longs paying)' : 'flipped NEGATIVE (shorts paying)';
    const implication = isBullish
        ? 'Squeeze risk for shorts → potential bullish reversal.'
        : 'Squeeze risk for longs → potential bearish reversal.';
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`⚡ ${event.symbol} Funding Rate Flip`)
        .setDescription(`Funding rate just ${verbAdj}.\n**Current rate:** ${event.ratePercent}\n\n${implication}`)
        .setTimestamp()
        .setFooter({ text: 'Funding Flip Detector • Binance perp' });
}

// ─── Weekly COT Report ────────────────────────────────────────────────────────
function buildCotEmbed(reports) {
    const embed = new EmbedBuilder()
        .setTitle('📊 Weekly CFTC COT Report')
        .setColor(COLORS.watchlist)
        .setTimestamp()
        .setFooter({ text: 'Commitment of Traders • CFTC public reporting' });

    const lines = [];
    for (const r of reports) {
        const meta = r.meta || {};
        const dir = r.commercialChange >= 0 ? '🟢 +' : '🔴 ';
        lines.push([
            `${meta.emoji || ''} **${meta.name || r.symbol}** — *${r.reportDate}*`,
            `  Commercial net: **${r.commercialNet.toLocaleString()}** (${dir}${r.commercialChange.toLocaleString()} WoW)`,
            `  Speculator net: ${r.speculatorNet.toLocaleString()}`,
            `  ${r.sentimentEmoji} ${r.sentiment}`,
        ].join('\n'));
    }
    embed.setDescription(lines.join('\n\n').slice(0, 4090));
    return embed;
}

// ─── Event Outcome Interpretation ─────────────────────────────────────────────
function buildEventOutcomeEmbed(event) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.alert)
        .setTitle(`📢 ${event.name} — Released`)
        .setTimestamp()
        .setFooter({ text: 'Economic Event Interpreter' })
        .addFields(
            { name: 'Forecast', value: String(event.forecast ?? '—'), inline: true },
            { name: 'Previous', value: String(event.previous ?? '—'), inline: true },
            { name: 'Actual', value: `**${event.actual}**`, inline: true },
        );
    if (event.interp) embed.setDescription(`> ${event.interp.split('\n').join('\n> ')}`);
    return embed;
}

// ─── Signal Scorecard ─────────────────────────────────────────────────────────
function buildScorecardEmbed(rows, days) {
    const embed = new EmbedBuilder()
        .setTitle(`🎯 Signal Scorecard — last ${days}d`)
        .setColor(COLORS.watchlist)
        .setTimestamp()
        .setFooter({ text: 'Win-rate measured at 1h, 4h, 24h forward; bearish PnL signs flipped.' });

    if (!rows || rows.length === 0) {
        embed.setDescription('No resolved signals in the window yet — give it another day.');
        return embed;
    }

    const fmtRate = (wins, total) => total > 0 ? `${Math.round(100 * wins / total)}% (${wins}/${total})` : '—';
    const fmtAvg = (n) => Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

    const lines = [];
    for (const r of rows) {
        lines.push([
            `**${r.signal_type}** — ${r.direction} (${r.total} fired)`,
            `  1h: ${fmtRate(r.win_1h, r.resolved_1h)} · avg ${fmtAvg(r.avg_1h)}`,
            `  4h: ${fmtRate(r.win_4h, r.resolved_4h)} · avg ${fmtAvg(r.avg_4h)}`,
            ` 24h: ${fmtRate(r.win_24h, r.resolved_24h)} · avg ${fmtAvg(r.avg_24h)}`,
        ].join('\n'));
    }
    embed.setDescription(lines.join('\n\n').slice(0, 4090));
    return embed;
}

module.exports = {
    buildNewsEmbed,
    buildAnalysisEmbed,
    buildPulseEmbed,
    buildCalendarEmbed,
    buildRecapEmbed,
    buildLevelsEmbed,
    buildAlertEmbed,
    buildLevelBreakEmbed,
    buildMtfDivergenceEmbed,
    buildFundingFlipEmbed,
    buildCotEmbed,
    buildEventOutcomeEmbed,
    buildScorecardEmbed,
    COLORS,
};
