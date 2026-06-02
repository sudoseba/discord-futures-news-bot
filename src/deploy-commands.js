const { REST, Routes } = require('discord.js');
const config = require('./config');
const fs = require('fs');
const path = require('path');

async function deployCommands() {
    // Load all command files
    const commands = [];
    const commandsPath = path.join(__dirname, 'commands');
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

    for (const file of commandFiles) {
        try {
            const command = require(path.join(commandsPath, file));
            if (command.data) {
                commands.push(command.data.toJSON());
                console.log(`✅ Loaded command: /${command.data.name}`);
            } else {
                console.warn(`⚠️  ${file} has no .data export — skipping`);
            }
        } catch (err) {
            console.error(`❌ ${file} failed to load:`, err.message);
        }
    }

    // Deploy to Discord
    const rest = new REST({ version: '10' }).setToken(config.token);

    try {
        console.log(`\n🔄 Registering ${commands.length} slash commands...`);

        if (config.guildId) {
            // Guild-specific (instant, for development)
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, config.guildId),
                { body: commands },
            );
            console.log(`✅ Commands registered for guild: ${config.guildId}`);
        } else {
            // Global (can take up to 1 hour to propagate)
            await rest.put(
                Routes.applicationCommands(config.clientId),
                { body: commands },
            );
            console.log('✅ Commands registered globally (may take up to 1 hour).');
        }

        console.log('🎉 Done!\n');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
}

deployCommands();
