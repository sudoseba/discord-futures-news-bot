const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const { fetchQuote } = require('../services/marketDataService');
const { fetchInstitutionalKeys, fetchEconomicCalendar } = require('../services/macroService');
const { fetchFearGreedIndex, fetchFundingRates } = require('../services/sentimentService');
const { generateDailyRecap } = require('../services/llmService');
const { buildRecapEmbed } = require('../utils/embeds');
const { synthesizeRecap } = require('../services/ttsService');
const memory = require('../services/memoryService');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recap')
        .setDescription('AI daily market recap — plain English summary of today\'s session')
        .addBooleanOption(opt =>
            opt
                .setName('voice')
                .setDescription('Attach an audio file of the recap (requires Deepgram key)')
                .setRequired(false)
        ),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Voice defaults OFF — only generate audio when the user explicitly opts in
            // (Deepgram free tier is 60min/month; a recap is ~3-5min, so opt-in protects quota).
            const wantVoice = interaction.options.getBoolean('voice') ?? false;

            // Fetch all data in parallel
            const [macro, calendar, fearGreed, fundingRates] = await Promise.all([
                fetchInstitutionalKeys(),
                fetchEconomicCalendar(),
                fetchFearGreedIndex(),
                fetchFundingRates(),
            ]);

            // Fetch all watchlist quotes
            const allQuotes = {};
            const symbols = Object.entries(config.watchlist);

            await Promise.all(
                symbols.map(async ([symbol, meta]) => {
                    try {
                        const quote = await fetchQuote(symbol);
                        allQuotes[symbol] = { ...meta, quote };
                    } catch (err) {
                        allQuotes[symbol] = { ...meta, quote: null };
                    }
                })
            );

            // Generate AI recap (plain English)
            const recap = await generateDailyRecap(allQuotes, macro, fearGreed, fundingRates, calendar);

            const embed = buildRecapEmbed(allQuotes, {
                macro,
                fearGreed,
                fundingRates,
                calendar,
                recap,
            });

            // Generate voice audio if requested and a key is available
            let audioAttachment = null;
            if (wantVoice && recap) {
                const audioBuffer = await synthesizeRecap(recap);
                if (audioBuffer) {
                    audioAttachment = new AttachmentBuilder(audioBuffer, { name: 'recap.mp3', description: 'Daily market recap audio' });
                }
            }

            const replyPayload = { embeds: [embed] };
            if (audioAttachment) {
                replyPayload.files = [audioAttachment];
                replyPayload.content = '🔊 *Audio recap attached — tap to listen!*';
            }

            await interaction.editReply(replyPayload);

            // Persist calendar events for historical tracking
            memory.persistCalendarEvents(calendar);
        } catch (error) {
            console.error('Recap command error:', error);
            await interaction.editReply({
                content: '❌ Failed to generate market recap. Please try again later.',
            });
        }
    },
};
