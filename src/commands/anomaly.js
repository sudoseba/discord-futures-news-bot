const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../services/database');

// Human-readable display names for each alert type
const CATEGORY_LABELS = {
    all: '🌐 All Alerts',
    price_spike: '📈 Price Spikes',
    vix_surge: '😱 VIX Surges',
    dxy_breakout: '💵 DXY Breakouts',
    yield_spike: '🏛️ Yield Spikes',
    fear_greed_shift: '😰 Fear & Greed Shifts',
    funding_extreme: '⚡ Extreme Funding Rates',
    correlation_sweep: '🔗 Multi-Asset Sweeps',
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('anomaly')
        .setDescription('Manage your anomaly alert DM subscription')
        .addSubcommand(sub =>
            sub
                .setName('subscribe')
                .setDescription('Sign up to receive real-time market anomaly alerts via DM')
                .addStringOption(opt =>
                    opt
                        .setName('category')
                        .setDescription('Which type of alerts to receive (default: all)')
                        .setRequired(false)
                        .addChoices(
                            { name: '🌐 All Alerts', value: 'all' },
                            { name: '📈 Price Spikes (2%+ in 15 min)', value: 'price_spike' },
                            { name: '😱 VIX Surges / Collapse', value: 'vix_surge' },
                            { name: '💵 DXY Breakouts', value: 'dxy_breakout' },
                            { name: '🏛️ Treasury Yield Spikes', value: 'yield_spike' },
                            { name: '😰 Fear & Greed Shifts', value: 'fear_greed_shift' },
                            { name: '⚡ Extreme Crypto Funding', value: 'funding_extreme' },
                            { name: '🔗 Multi-Asset Sweep (Risk-On/Off)', value: 'correlation_sweep' },
                        )
                )
        )
        .addSubcommand(sub =>
            sub
                .setName('unsubscribe')
                .setDescription('Stop receiving anomaly alert DMs')
        )
        .addSubcommand(sub =>
            sub
                .setName('status')
                .setDescription('Check your current anomaly alert subscription')
        ),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;

        if (sub === 'subscribe') {
            const category = interaction.options.getString('category') || 'all';
            const label = CATEGORY_LABELS[category] || category;

            try {
                db.setAnomalySubscriber(userId, true, category);
                await interaction.editReply({
                    content: [
                        `✅ **You're signed up for anomaly alerts!**`,
                        ``,
                        `📬 Alerts will be sent to your DMs when the scanner detects something.`,
                        `📊 Alert type: **${label}**`,
                        ``,
                        `> The scanner runs every 15 minutes. You'll get a DM whenever a fresh anomaly is detected.`,
                        ``,
                        `Use \`/anomaly unsubscribe\` to stop at any time.`,
                    ].join('\n'),
                });
            } catch (err) {
                console.error('[Anomaly Cmd] Subscribe error:', err);
                await interaction.editReply({ content: '❌ Failed to subscribe. Please try again.' });
            }

        } else if (sub === 'unsubscribe') {
            try {
                db.setAnomalySubscriber(userId, false);
                await interaction.editReply({
                    content: [
                        `🔕 **You've been unsubscribed from anomaly alerts.**`,
                        ``,
                        `You won't receive any more anomaly DMs.`,
                        `Use \`/anomaly subscribe\` to opt back in anytime.`,
                    ].join('\n'),
                });
            } catch (err) {
                console.error('[Anomaly Cmd] Unsubscribe error:', err);
                await interaction.editReply({ content: '❌ Failed to unsubscribe. Please try again.' });
            }

        } else if (sub === 'status') {
            try {
                const subscribers = db.getAnomalySubscribers();
                const mine = subscribers.find(s => s.user_id === userId);

                if (mine) {
                    const label = CATEGORY_LABELS[mine.categories] || mine.categories;
                    await interaction.editReply({
                        content: [
                            `📊 **Your anomaly subscription is active.**`,
                            ``,
                            `Alert type: **${label}**`,
                            ``,
                            `Use \`/anomaly unsubscribe\` to cancel, or \`/anomaly subscribe\` to change the type.`,
                        ].join('\n'),
                    });
                } else {
                    await interaction.editReply({
                        content: [
                            `🔕 **You are not subscribed to anomaly alerts.**`,
                            ``,
                            `Use \`/anomaly subscribe\` to start receiving real-time DM alerts!`,
                        ].join('\n'),
                    });
                }
            } catch (err) {
                console.error('[Anomaly Cmd] Status error:', err);
                await interaction.editReply({ content: '❌ Could not check your subscription status.' });
            }
        }
    },
};
