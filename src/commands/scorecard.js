const { SlashCommandBuilder } = require('discord.js');
const scorecard = require('../services/scorecardService');
const { buildScorecardEmbed } = require('../utils/embeds');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('scorecard')
        .setDescription('Signal-quality scorecard — win rate of past alerts at 1h / 4h / 24h')
        .addIntegerOption(opt =>
            opt.setName('days')
                .setDescription('Lookback window in days (default 30)')
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(180)
        )
        .addStringOption(opt =>
            opt.setName('signal')
                .setDescription('Filter to a single signal type')
                .setRequired(false)
                .addChoices(
                    { name: '📈 Divergence',     value: 'divergence' },
                    { name: '⚡ Price spike',     value: 'price_spike' },
                    { name: '📐 Level break',     value: 'level_break' },
                    { name: '😱 VIX surge',       value: 'vix_surge' },
                    { name: '⚡ Funding flip',    value: 'funding_flip' },
                    { name: '🔗 Correlation sweep', value: 'correlation_sweep' },
                )
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const days = interaction.options.getInteger('days') ?? 30;
        const signalType = interaction.options.getString('signal');
        try {
            const rows = scorecard.summary({ daysBack: days, signalType });
            await interaction.editReply({ embeds: [buildScorecardEmbed(rows, days)] });
        } catch (err) {
            console.error('[scorecard cmd]', err);
            await interaction.editReply({ content: '❌ Failed to load scorecard.' });
        }
    },
};
