const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { fetchQuote, fetchCandles } = require('../services/marketDataService');
const { fetchInstitutionalKeys, fetchEconomicCalendar } = require('../services/macroService');
const { fetchFearGreedIndex, getFearGreedEmoji, buildFearGreedBar, fetchFundingRates, interpretFundingRate } = require('../services/sentimentService');
const { analyze } = require('../services/technicalAnalysisService');
const { buildPulseEmbed } = require('../utils/embeds');
const memory = require('../services/memoryService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pulse')
        .setDescription('Market Pulse — one-glance dashboard of all tracked markets'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Fetch everything in parallel
            const [macro, calendar, fearGreed, fundingRates] = await Promise.all([
                fetchInstitutionalKeys(),
                fetchEconomicCalendar(),
                fetchFearGreedIndex(),
                fetchFundingRates(),
            ]);

            // Fetch quotes + mini-analysis for each watchlist symbol
            const symbolData = {};
            const symbols = Object.entries(config.watchlist);

            // Fetch all quotes in parallel
            const quotePromises = symbols.map(async ([symbol, meta]) => {
                try {
                    const [quote, candles] = await Promise.all([
                        fetchQuote(symbol),
                        fetchCandles(symbol, 'D', 60), // 60 days for RSI + SMA
                    ]);

                    let miniAnalysis = null;
                    if (candles && candles.close && candles.close.length >= 20) {
                        const full = analyze(candles);
                        miniAnalysis = {
                            rsi: full.rsi,
                            rsiSignal: full.rsiSignal,
                            trendSignal: full.trendSignal,
                        };
                    }

                    symbolData[symbol] = { ...meta, quote, miniAnalysis };
                } catch (err) {
                    console.error(`[Pulse] Failed to fetch ${symbol}:`, err.message);
                    symbolData[symbol] = { ...meta, quote: null, miniAnalysis: null };
                }
            });

            await Promise.all(quotePromises);

            const embed = buildPulseEmbed(symbolData, {
                macro,
                calendar,
                fearGreed,
                fundingRates,
            });

            await interaction.editReply({ embeds: [embed] });

            // Persist all pulse data to database for historical tracking
            memory.persistMarketPulse(symbolData, macro, fearGreed, fundingRates);
        } catch (error) {
            console.error('Pulse command error:', error);
            await interaction.editReply({
                content: '❌ Failed to fetch market pulse. Please try again later.',
            });
        }
    },
};
