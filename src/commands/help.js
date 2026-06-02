const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { COLORS } = require('../utils/embeds');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show all available bot commands and how to use them'),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('📖 Futures News Bot — Commands')
            .setColor(COLORS.watchlist)
            .setDescription('Here\'s everything this bot can do. All commands are slash commands — just type `/` to get started.')
            .setTimestamp()
            .setFooter({ text: 'Futures News & Analysis Bot • Use /help anytime' });

        embed.addFields(
            {
                name: '📰 /news [category] [ai]',
                value: [
                    'Get the latest futures market headlines.',
                    '• `category` — filter by: `Oil & Energy`, `Metals`, `Crypto`, `Forex`, or `All Markets`',
                    '• `ai: true` — use AI to curate the best headlines and generate a briefing (uses API credits)',
                ].join('\n'),
                inline: false,
            },
            {
                name: '⚡ /pulse',
                value: 'Live snapshot of all watched assets — price, % change, RSI indicator, macro keys (DXY, 10Y yield, VIX), and the Crypto Fear & Greed index.',
                inline: false,
            },
            {
                name: '🎯 /analysis [symbol]',
                value: [
                    'Full technical breakdown + AI verdict for one asset.',
                    'Includes RSI, MACD, trend, divergence, risk metrics, correlation signals, and upcoming catalysts.',
                    '• `symbol` — pick from the watchlist (Gold, Bitcoin, EUR/USD, Crude Oil, etc.)',
                ].join('\n'),
                inline: false,
            },
            {
                name: '📐 /levels [symbol]',
                value: [
                    'AI-identified key support and resistance levels for an asset.',
                    'Shows where the market is likely to react — useful before entering a trade.',
                    '• `symbol` — same options as /analysis',
                ].join('\n'),
                inline: false,
            },
            {
                name: '📅 /calendar',
                value: 'Upcoming economic events for the next 2 weeks. Color-coded by impact: 🚨 High, 🟡 Medium, ⚪ Low. Shows estimated vs. actual values when available.',
                inline: false,
            },
            {
                name: '📋 /recap [voice]',
                value: [
                    'Plain-English AI summary of today\'s market session.',
                    'Covers movers, the macro picture, crowd sentiment, and what to watch tomorrow.',
                    '• `voice: true` — attach an MP3 audio file of the recap (default: on)',
                ].join('\n'),
                inline: false,
            },
            {
                name: '🔔 /anomaly subscribe [category]',
                value: [
                    'Sign up to get **real-time DM alerts** when the scanner detects a market anomaly.',
                    '• `category` — which type of alerts you want:',
                    '  `All Alerts` · `Price Spikes` · `VIX Surges` · `DXY Breakouts`',
                    '  `Yield Spikes` · `Fear & Greed Shifts` · `Extreme Funding` · `Multi-Asset Sweeps`',
                ].join('\n'),
                inline: false,
            },
            {
                name: '🔕 /anomaly unsubscribe',
                value: 'Stop receiving anomaly DMs.',
                inline: false,
            },
            {
                name: '📊 /anomaly status',
                value: 'Check whether you\'re subscribed and which alert type you\'re signed up for.',
                inline: false,
            },
            {
                name: '🎯 /scorecard [days] [signal]',
                value: [
                    'Win rate of past alerts at 1h / 4h / 24h forward.',
                    'Measures real signal quality — not just how many alerts fired.',
                    '• `days` — lookback window (default 30)',
                    '• `signal` — filter to one signal type (divergence, level break, etc.)',
                ].join('\n'),
                inline: false,
            },
            {
                name: '🔕 /snooze [duration]',
                value: 'Temporarily mute anomaly DMs for yourself (1h, 4h, 12h, 24h, 7d, or off).',
                inline: false,
            },
            {
                name: '⚡ Auto-posts (no command required)',
                value: [
                    '☀️ **Morning briefing** — weekdays 8 AM ET',
                    '📋 **End-of-day recap** — weekdays 4:30 PM ET',
                    '🔴 **Breaking news** — top tier-1 wires every 5 min',
                    '📐 **Level breaks** — when price crosses key support/resistance',
                    '📈 **MTF divergences** — daily + weekly RSI confluence',
                    '⚡ **Funding flips** — when crypto funding flips sign',
                    '📢 **Event outcomes** — LLM interpretation of CPI/NFP/FOMC actuals',
                    '📊 **Weekly COT** — Friday CFTC commercial positioning',
                ].join('\n'),
                inline: false,
            },
        );

        await interaction.reply({ embeds: [embed] });
    },
};
