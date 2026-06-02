const { SlashCommandBuilder } = require('discord.js');
const { fetchFullCalendar } = require('../services/macroService');
const { buildCalendarEmbed } = require('../utils/embeds');
const memory = require('../services/memoryService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('calendar')
        .setDescription('Economic calendar — 2 weeks of upcoming market-moving events'),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const calendar = await fetchFullCalendar();
            const embed = buildCalendarEmbed(calendar);
            await interaction.editReply({ embeds: [embed] });

            // Persist events for historical tracking
            memory.persistCalendarEvents(calendar);
        } catch (error) {
            console.error('Calendar command error:', error);
            await interaction.editReply({
                content: '❌ Failed to fetch economic calendar. Please try again later.',
            });
        }
    },
};
