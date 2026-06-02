const { SlashCommandBuilder } = require('discord.js');
const config = require('../config');
const { fetchCandles, fetchWeeklyCandles, fetchQuote } = require('../services/marketDataService');
const { analyze, detectLevels } = require('../services/technicalAnalysisService');
const { generateLevels } = require('../services/llmService');
const { buildLevelsEmbed } = require('../utils/embeds');

// Build choices from the watchlist config
const symbolChoices = Object.entries(config.watchlist).map(([symbol, meta]) => ({
    name: `${meta.emoji} ${meta.name}`,
    value: symbol,
}));

/**
 * Merge daily and weekly detected levels.
 * Any level confirmed on BOTH timeframes gets its strength boosted and label upgraded to Major.
 * @param {object} daily - detectLevels() output for D1 candles
 * @param {object|null} weekly - detectLevels() output for W1 candles
 * @returns {object} merged levels with multi-timeframe tags
 */
function mergeTimeframeLevels(daily, weekly) {
    if (!weekly) return daily;

    const TF_TOL_PCT = 0.8; // 0.8% tolerance for cross-timeframe confirmation

    function upgradeIfConfirmed(levels, weeklyLevels, isResistance) {
        return levels.map(level => {
            const confirmed = weeklyLevels.some(wl =>
                Math.abs(wl.price - level.price) / level.price * 100 < TF_TOL_PCT
            );
            if (confirmed) {
                return {
                    ...level,
                    label: 'Major',       // Upgrade to Major
                    strength: level.strength + 3,
                    methods: [...new Set([...level.methods, 'Weekly Confirmed'])],
                    note: level.note, // Keep the daily note; LLM will annotate it
                };
            }
            return level;
        });
    }

    return {
        ...daily,
        resistances: upgradeIfConfirmed(daily.resistances, weekly.resistances, true),
        supports: upgradeIfConfirmed(daily.supports, weekly.supports, false),
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('levels')
        .setDescription('Key support & resistance levels from 5 algorithmic methods + AI annotation')
        .addStringOption(option =>
            option.setName('symbol')
                .setDescription('Pick an asset to analyze')
                .setRequired(true)
                .addChoices(...symbolChoices)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const symbol = interaction.options.getString('symbol');
            const meta = config.watchlist[symbol] || { name: symbol, emoji: '📊' };

            // Fetch daily + weekly candles and current quote in parallel
            const [candles, weeklyCandles, quote] = await Promise.all([
                fetchCandles(symbol, config.analysis.candleResolution, config.analysis.candleDays),
                fetchWeeklyCandles(symbol, 52).catch(() => null), // non-blocking
                fetchQuote(symbol),
            ]);

            if (!candles || !candles.close || candles.close.length < 20) {
                return interaction.editReply({
                    content: `❌ Not enough price data for **${meta.name}**. Need at least 20 daily candles.`,
                });
            }

            // Step 1: TA context (RSI, MACD, divergence)
            const analysisResult = analyze(candles);

            // Step 2: Detect levels algorithmically on both timeframes
            const dailyLevels = detectLevels(candles);
            const weeklyLevels = weeklyCandles ? detectLevels(weeklyCandles) : null;

            if (!dailyLevels || (dailyLevels.resistances.length === 0 && dailyLevels.supports.length === 0)) {
                return interaction.editReply({
                    content: `❌ Could not detect key levels for **${meta.name}**. Not enough price data.`,
                });
            }

            // Step 3: Merge daily + weekly — cross-timeframe confirmation = Major level
            const mergedLevels = mergeTimeframeLevels(dailyLevels, weeklyLevels);
            const tfNote = weeklyLevels
                ? `D1+W1 confluence active (${weeklyLevels.resistances.length + weeklyLevels.supports.length} weekly levels cross-checked)`
                : 'Daily levels only (weekly data unavailable)';
            console.log(`[Levels] ${symbol}: ${tfNote}`);

            // Step 4: LLM annotates real prices — can't invent new ones
            const levels = await generateLevels(meta.name, candles, quote, analysisResult, mergedLevels);

            if (!levels) {
                return interaction.editReply({
                    content: `❌ Failed to annotate levels for **${meta.name}**. Please try again.`,
                });
            }

            const embed = buildLevelsEmbed(symbol, meta.name, quote, levels);
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('Levels command error:', error);
            await interaction.editReply({
                content: '❌ Failed to generate levels. Please try again later.',
            });
        }
    },
};
