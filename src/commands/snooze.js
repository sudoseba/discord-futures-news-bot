const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getDb } = require('../services/database');

const SNOOZE_KEY = 'anomaly_snooze';
const DURATIONS = {
    '1h': 60 * 60_000,
    '4h': 4 * 60 * 60_000,
    '12h': 12 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('snooze')
        .setDescription('Temporarily mute anomaly DMs for yourself')
        .addStringOption(opt =>
            opt.setName('duration')
                .setDescription('How long to snooze')
                .setRequired(true)
                .addChoices(
                    { name: '1 hour', value: '1h' },
                    { name: '4 hours', value: '4h' },
                    { name: '12 hours', value: '12h' },
                    { name: '24 hours', value: '24h' },
                    { name: '7 days', value: '7d' },
                    { name: 'Unsnooze (clear)', value: 'off' },
                )
        ),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const dur = interaction.options.getString('duration');
        const userId = interaction.user.id;
        const now = Date.now();

        try {
            if (dur === 'off') {
                getDb().prepare(`DELETE FROM user_prefs WHERE user_id = ? AND pref_key = ?`).run(userId, SNOOZE_KEY);
                return interaction.editReply({ content: '🔔 Snooze cleared — DM alerts re-enabled.' });
            }
            const ms = DURATIONS[dur];
            if (!ms) return interaction.editReply({ content: '❌ Unknown duration.' });
            const expiresAt = now + ms;
            getDb().prepare(`INSERT INTO user_prefs (user_id, pref_key, pref_value, expires_at, updated_at)
                              VALUES (?, ?, ?, ?, ?)
                              ON CONFLICT(user_id, pref_key) DO UPDATE SET
                                  pref_value = excluded.pref_value,
                                  expires_at = excluded.expires_at,
                                  updated_at = excluded.updated_at`)
                .run(userId, SNOOZE_KEY, dur, expiresAt, now);
            const until = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
            await interaction.editReply({ content: `🔕 Anomaly DMs snoozed for **${dur}** (until ${until}).` });
        } catch (err) {
            console.error('[snooze cmd]', err);
            await interaction.editReply({ content: '❌ Failed to update snooze.' });
        }
    },
};

/** Helper used by the scanner before DMing a subscriber. */
function isSnoozed(userId) {
    try {
        const row = getDb().prepare(`SELECT expires_at FROM user_prefs WHERE user_id = ? AND pref_key = ?`)
            .get(userId, SNOOZE_KEY);
        if (!row) return false;
        if (row.expires_at <= Date.now()) {
            getDb().prepare(`DELETE FROM user_prefs WHERE user_id = ? AND pref_key = ?`).run(userId, SNOOZE_KEY);
            return false;
        }
        return true;
    } catch { return false; }
}

module.exports.isSnoozed = isSnoozed;
