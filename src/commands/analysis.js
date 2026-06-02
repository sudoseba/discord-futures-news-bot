const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { fetchCandles, fetchQuote } = require('../services/marketDataService');
const { analyze } = require('../services/technicalAnalysisService');
const { fetchInstitutionalKeys, generateCorrelationNotes, fetchEconomicCalendar } = require('../services/macroService');
const { generateWarRoomVerdict } = require('../services/llmService');
const { buildAnalysisEmbed } = require('../utils/embeds');

// Build symbol choices from watchlist
const symbolChoices = Object.entries(config.watchlist).map(([symbol, meta]) => ({
    name: `${meta.emoji} ${meta.name}`,
    value: symbol,
}));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analysis')
        .setDescription('War Room briefing — full technical + macro analysis')
        .addStringOption(option =>
            option
                .setName('symbol')
                .setDescription('Select a futures instrument')
                .setRequired(true)
                .addChoices(...symbolChoices.slice(0, 25))
        ),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const symbol = interaction.options.getString('symbol');
            const meta = config.watchlist[symbol] || { name: symbol, emoji: '📊' };

            // Fetch everything in parallel
            const [candles, quote, macro, calendar] = await Promise.all([
                fetchCandles(symbol, config.analysis.candleResolution, config.analysis.candleDays),
                fetchQuote(symbol),
                fetchInstitutionalKeys(),
                fetchEconomicCalendar(),
            ]);

            if (!candles || !candles.close || candles.close.length < 50) {
                await interaction.editReply({
                    content: `⚠️ Not enough data available for **${meta.name}**. Need at least 50 candles for analysis.`,
                });
                return;
            }

            // Run technical analysis with full candle data (enables ATR)
            const analysisResult = analyze(candles);

            // Generate correlation notes
            const correlationNotes = generateCorrelationNotes(macro, symbol);

            // Generate AI War Room Verdict (non-blocking — if it fails, embed still works)
            let verdict = null;
            try {
                verdict = await generateWarRoomVerdict(
                    meta.name,
                    analysisResult,
                    macro,
                    correlationNotes,
                    analysisResult.riskMetrics,
                    calendar,
                    symbol
                );
            } catch (err) {
                console.error('[Analysis] AI verdict generation failed:', err.message);
            }

            const embed = buildAnalysisEmbed(symbol, meta.name, analysisResult, quote, {
                macro,
                correlationNotes,
                calendar,
                verdict,
            });

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Analysis command error:', error);
            await interaction.editReply({
                content: '❌ Failed to run analysis. Please try again later.',
            });
        }
    },
};
