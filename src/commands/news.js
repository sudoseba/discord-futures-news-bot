const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { fetchMarketNews } = require('../services/newsService');
const { summarizeNews } = require('../services/llmService');
const { fetchQuote } = require('../services/marketDataService');
const { buildNewsEmbed } = require('../utils/embeds');

// Price ticker symbols relevant per category
const CATEGORY_TICKERS = {
    oil: ['OANDA:WTICO_USD', 'OANDA:BRENT_USD'],
    metals: ['OANDA:XAU_USD', 'OANDA:XAG_USD'],
    crypto: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'],
    forex: ['OANDA:EUR_USD', 'OANDA:USD_JPY'],
    all: ['OANDA:XAU_USD', 'BINANCE:BTCUSDT', 'OANDA:WTICO_USD'],
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('news')
        .setDescription('AI-curated futures market news with impact scoring and multi-source feeds')
        .addStringOption(option =>
            option
                .setName('category')
                .setDescription('Filter by market category')
                .setRequired(false)
                .addChoices(
                    { name: '🛢️ Oil & Energy', value: 'oil' },
                    { name: '🥇 Metals', value: 'metals' },
                    { name: '₿ Crypto', value: 'crypto' },
                    { name: '💱 Forex', value: 'forex' },
                    { name: '📰 All Markets', value: 'all' },
                )
        )
        .addBooleanOption(option =>
            option
                .setName('breaking')
                .setDescription('Show only breaking news from Tier-1 sources in the last 30 minutes')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName('raw')
                .setDescription('Skip AI briefing — show raw headlines only (faster)')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const category = interaction.options.getString('category') || 'all';
            const breakingOnly = interaction.options.getBoolean('breaking') || false;
            const rawMode = interaction.options.getBoolean('raw') || false;

            // Fetch headlines + relevant price tickers in parallel
            const tickerSymbols = CATEGORY_TICKERS[category] || CATEGORY_TICKERS.all;
            const [headlines, ...quotes] = await Promise.all([
                fetchMarketNews(category, breakingOnly),
                ...tickerSymbols.map(sym => fetchQuote(sym).catch(() => null)),
            ]);

            const tickers = tickerSymbols.reduce((acc, sym, i) => {
                if (quotes[i]) acc[sym] = { ...config.watchlist[sym], quote: quotes[i] };
                return acc;
            }, {});

            if (headlines.length === 0) {
                const msg = breakingOnly
                    ? '📭 No breaking news from Tier-1 sources in the last 30 minutes.'
                    : '📭 No relevant news found at this time. Try again later.';
                return interaction.editReply({ content: msg });
            }

            // AI is always on unless raw mode requested
            let llmResult = null;
            let finalHeadlines = headlines.slice(0, 10);

            if (!rawMode) {
                llmResult = await summarizeNews(headlines, category);

                if (llmResult?.curatedHeadlines?.length > 0) {
                    // Map curated headline texts back to full article objects (preserving tier/score)
                    const curatedSet = new Set(llmResult.curatedHeadlines);
                    const curated = headlines.filter(h => curatedSet.has(h.headline));
                    finalHeadlines = curated.length > 0 ? curated : headlines.slice(0, 10);

                    // Attach LLM impact overrides to articles
                    if (llmResult.headlineImpact) {
                        finalHeadlines = finalHeadlines.map(h => ({
                            ...h,
                            llmImpact: llmResult.headlineImpact[h.headline] || null,
                        }));
                    }
                }
            }

            const embeds = buildNewsEmbed(finalHeadlines, category, llmResult?.tldr || null, llmResult?.headlineTldrs || {}, tickers, headlines.length, llmResult?.synthesis || null);
            await interaction.editReply({ embeds: Array.isArray(embeds) ? embeds : [embeds] });

        } catch (error) {
            console.error('News command error:', error);
            await interaction.editReply({
                content: '❌ Failed to fetch news. Please try again later.',
            });
        }
    },
};
