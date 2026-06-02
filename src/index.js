const { Client, GatewayIntentBits, Collection, Events, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const config = require('./config');
const log = require('./utils/logger').child('app');
const { initDatabase, closeDatabase } = require('./services/database');
const { startScheduler } = require('./scheduler');
const cronManager = require('./utils/cronManager');
const healthz = require('./server/healthz');

// ─── Initialize Database (synchronous; fail fast if broken) ─────────────────
initDatabase();

// ─── Healthz HTTP server (independent of Discord — comes up immediately) ────
healthz.start();

// ─── Create Discord Client ──────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ],
});

// ─── Load Commands ──────────────────────────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    try {
        const command = require(path.join(commandsPath, file));
        if (command.data && command.execute) {
            client.commands.set(command.data.name, command);
            log.info({ cmd: command.data.name }, 'command loaded');
        } else {
            log.warn({ file }, 'command file missing data/execute export');
        }
    } catch (err) {
        log.error({ file, err: err.message, stack: err.stack }, 'command failed to load');
    }
}

// ─── Event: Ready ───────────────────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
    log.info({
        user: c.user.tag,
        guilds: c.guilds.cache.size,
        commands: client.commands.size,
    }, 'Discord client ready');

    client.user.setActivity('futures markets 📊', { type: ActivityType.Watching });
    healthz.markReady();
    startScheduler(client);
});

// ─── Event: Slash Command Interaction ───────────────────────────────────────
const { MessageFlags } = require('discord.js');

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) {
        log.warn({ cmd: interaction.commandName }, 'unknown command');
        return;
    }

    log.info({
        cmd: interaction.commandName,
        user: interaction.user.tag,
        channel: interaction.channel?.name ?? 'DM',
    }, 'command invoked');

    const t0 = Date.now();
    try {
        await command.execute(interaction);
        log.info({ cmd: interaction.commandName, durationMs: Date.now() - t0 }, 'command complete');
    } catch (err) {
        log.error({
            cmd: interaction.commandName,
            err: err.message,
            stack: err.stack,
            durationMs: Date.now() - t0,
        }, 'command failed');

        const reply = {
            content: '❌ An error occurred while running this command.',
            flags: MessageFlags.Ephemeral,
        };

        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(reply);
            } else {
                await interaction.reply(reply);
            }
        } catch (replyErr) {
            log.warn({ err: replyErr.message }, 'failed to send error reply');
        }
    }
});

// ─── Error Handling ─────────────────────────────────────────────────────────
client.on(Events.Error, (err) => log.error({ err: err.message, stack: err.stack }, 'discord client error'));
client.on(Events.Warn, (msg) => log.warn({ msg }, 'discord client warn'));

process.on('unhandledRejection', (err) => {
    log.error({ err: err?.message || err, stack: err?.stack }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
    log.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
});

// ─── Login ──────────────────────────────────────────────────────────────────
if (!config.token) {
    log.fatal('DISCORD_TOKEN not set; copy .env.example to .env and configure');
    process.exit(1);
}

client.login(config.token).catch((err) => {
    log.fatal({ err: err.message }, 'discord login failed');
    process.exit(1);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutdown initiated');

    try {
        await cronManager.stopAll();
    } catch (err) { log.warn({ err: err.message }, 'cron stop failed'); }

    try {
        await healthz.stop();
    } catch (err) { log.warn({ err: err.message }, 'healthz stop failed'); }

    try {
        await client.destroy();
    } catch (err) { log.warn({ err: err.message }, 'client destroy failed'); }

    try {
        closeDatabase();
    } catch (err) { log.warn({ err: err.message }, 'db close failed'); }

    log.info('shutdown complete');
    setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
