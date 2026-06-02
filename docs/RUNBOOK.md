# Runbook

Operational guide for keeping this bot alive in production.

## Daily check (30 seconds)

```bash
curl http://localhost:3000/healthz | jq
```

Look for:
- `status: "ok"`
- `discordReady: true`
- `dbOk: true`
- `lastBriefingAt` recent (within last 24h, weekdays only)
- `lastScanAt` within last 20 min (every 15 + jitter)
- `cronJobs` array contains all expected job names

If `status: "degraded"`, check:
- `discordReady: false` → bot is disconnected; check logs for `unhandled rejection` or `login failed`
- `dbOk: false` → DB file is unreadable; restore from `data/backups/`

## Common incidents

### "Bot stopped posting briefings"

```bash
# Did the cron job tick?
grep '"job":"morning_briefing"' logs/* | tail -5

# Is the briefing channel ID set?
grep AUTO_POST_CHANNEL_ID .env

# Is the bot in the guild that owns that channel?
curl http://localhost:3000/healthz | jq '.discordReady'
```

If logs show "channel unavailable" the bot was kicked / channel deleted. Update `AUTO_POST_CHANNEL_ID`.

### "Anomaly DMs aren't arriving"

1. Check `/anomaly status` from the affected user — confirm subscription.
2. Check user hasn't `/snooze`d themselves.
3. Check logs: `grep '"event":"DM failed"' logs/*` — Discord returns 50007 if recipient has DMs closed.

### "Database integrity check failed on boot"

```bash
# Bot will refuse to start. Restore from the most recent backup.
ls -lt data/backups/ | head -5
cp data/backups/bot-<latest>.db data/bot.db
rm data/bot.db-shm data/bot.db-wal 2>/dev/null
npm start
```

### "Discord rate-limited the bot"

Look for `status: 429` in the dead-letter queue:

```bash
sqlite3 data/bot.db 'SELECT COUNT(*) FROM pending_posts'
sqlite3 data/bot.db 'SELECT channel_id, attempts, last_error FROM pending_posts ORDER BY created_at DESC LIMIT 10'
```

The deadletter cron drains every minute with backoff. If queue > 50 and growing, the channel may be throttled — reduce alert frequency or split into multiple channels.

### "LLM responses are stale / wrong model"

Cache keys include `cerebrasModel`. Bumping `CEREBRAS_MODEL` in `.env` invalidates the cache on next call. If you need to flush manually:

```bash
# Process restart clears the in-memory LLM cache.
docker compose restart bot
```

## Backups

- Automatic: `data/backups/bot-<timestamp>.db` written daily on boot + every 24h. Rotates to 7 days.
- Manual: `npm run backup`.
- Offsite: rsync `data/backups/` to S3 / B2 nightly (cron at OS level — outside the bot).

## Restore from backup

```bash
# Stop the bot
docker compose stop bot

# Replace the db file
cp data/backups/bot-2026-06-01T03-00-00.db data/bot.db
rm data/bot.db-shm data/bot.db-wal 2>/dev/null

# Restart
docker compose start bot

# Verify
curl http://localhost:3000/healthz | jq '.dbOk'
```

## Rotating API keys

```bash
# 1. Generate new key from the provider's dashboard
# 2. Edit .env on the host
# 3. Restart
docker compose restart bot

# 4. Verify the bot can post
# In Discord: /pulse
```

Discord token requires a deploy-commands re-run only if the bot's application ID changed (which only happens if you replaced the whole app, not just the token).

## Scaling notes

This is a single-process bot designed for one Discord guild. If you grow past:

- **~50 commands/min** → CPU is the bottleneck (LLM calls dominate). Add a queue + worker.
- **~5 GB SQLite DB** → consider tightening retention windows or moving to Postgres.
- **~500 anomaly subscribers** → DM throughput is throttled by Discord (5/sec per app). Batch with a small queue.

## Where the logs live

By default pino writes to stdout. If running under Docker:

```bash
docker compose logs -f bot
```

Under systemd:

```bash
journalctl -u discord-bot -f
```

Filter to a single component:

```bash
docker compose logs bot | grep '"component":"scheduler"'
```

## Killing it cleanly

`SIGTERM` triggers `shutdown()` in `src/index.js` which:
1. Stops every cron job (waits up to 5s for in-flight ticks)
2. Stops the healthz HTTP server
3. Disconnects from Discord
4. Closes the SQLite connection (flushes WAL)
5. `process.exit(0)`

Total shutdown should take < 6 seconds. If it hangs longer, `kill -9` is safe — WAL guarantees the DB stays consistent.
