# Deploying on a Raspberry Pi 4 (headless / over SSH)

This is the Debian/Linux counterpart to the Windows `AdminPanel.ps1`.
Everything here is driven from the terminal, so it works fine over a
plain SSH session with no desktop.

Two pieces:

| File | What it does |
|------|--------------|
| `../admin-panel.js` | Terminal admin panel — the SSH equivalent of the WinForms GUI. Edit `.env`, test every API, start/stop/restart the bot, check `/healthz`, tail logs, register slash commands. |
| `discord-news-bot.service` | systemd unit template so the bot runs on boot and restarts on crash. |
| `install-service.sh` | Renders + installs that unit for your paths/user. |

---

## 1. One-time host setup

Raspberry Pi OS (64-bit, Bookworm) or any Debian/Ubuntu. SSH in, then:

```bash
# Node.js 20+ (the bot requires >= 20). NodeSource is the simplest route:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# better-sqlite3 compiles a native addon on ARM — it needs a toolchain:
sudo apt-get install -y build-essential python3 git

node -v   # expect v20.x or newer
```

## 2. Get the code & install deps

```bash
cd ~
git clone <your-repo-url> discord-news-bot
cd discord-news-bot

# Production install (skips dev/test deps). This is where better-sqlite3
# compiles — it takes a few minutes on a Pi 4, which is normal.
npm ci --omit=dev
```

## 3. Configure — using the panel

```bash
cp .env.example .env
node admin-panel.js          # opens the menu
```

In the menu:

1. **Settings** → edit your `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`,
   `DISCORD_GUILD_ID`, `AUTO_POST_CHANNEL_ID`, and any API keys.
   Secret entry is hidden as you type. Press **s** to save (it writes
   `.env` and keeps a `.env.bak`).
2. **API health** → **Test ALL** to confirm each key actually works
   *before* you start the bot.
3. **Register slash commands (deploy)** → registers the `/` commands
   with Discord. Do this once (and again whenever commands change).

Prefer one-liners? Everything the menu does is also a subcommand:

```bash
node admin-panel.js set DISCORD_TOKEN 'xxxxx'
node admin-panel.js set AUTO_POST_CHANNEL_ID 123456789
node admin-panel.js test-all
node admin-panel.js deploy
```

## 4. Run it as a service (survives reboots)

```bash
bash deploy/install-service.sh --start
```

That renders `discord-news-bot.service` for your user + install path,
enables it on boot, and starts it. Verify:

```bash
node admin-panel.js status
# or:
curl -s http://localhost:3000/healthz | jq
journalctl -u discord-news-bot -f
```

Once the service is installed, the panel drives it automatically —
**Bot control → Start/Stop/Restart** call `systemctl` under the hood,
and **Logs** reads the journal. (You'll be asked for your sudo password
for start/stop/restart, unless you run the panel as root.)

---

## Day-to-day (all over SSH)

```bash
node admin-panel.js                 # full interactive menu
node admin-panel.js status          # service + /healthz at a glance
node admin-panel.js restart         # after editing .env
node admin-panel.js logs -f         # follow logs (Ctrl-C to stop)
node admin-panel.js test cerebras   # re-test one API
```

## Notes & gotchas

- **No systemd yet?** The panel still works — before you run the
  installer, *Start* launches the bot as a background process and writes
  output to `logs/bot.out.log`. Installing the service is recommended so
  it comes back after a reboot or crash.
- **Different unit name / user?** Override at install time:
  `SERVICE_NAME=my-bot RUN_USER=pi bash deploy/install-service.sh`, and
  point the panel at it with `BOT_SERVICE=my-bot node admin-panel.js`.
- **Timezone:** the bot schedules off `SCHEDULE_TIMEZONE` in `.env`
  (default `America/New_York`), independent of the Pi's system clock —
  set it in **Settings**.
- **Health port:** defaults to `3000`; change `HEALTHZ_PORT` in Settings
  if it clashes.
- **Prefer Docker?** A `Dockerfile` and `docker-compose.yml` are in the
  repo root; this panel targets a bare-metal Pi install instead.
- **Updating:** `git pull && npm ci --omit=dev && node admin-panel.js restart`.
