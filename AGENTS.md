# Notes for AI coding agents

_If you are an AI coding assistant (Claude Code, Cursor, Copilot) being asked to extend or modify this codebase, read this first. It will save you and the user time._

## Repo layout — where things live

```
src/
├── index.js                ← entry; loads commands, starts healthz, scheduler
├── config.js               ← env loader, watchlist symbols, thresholds
├── scheduler.js            ← every cron job (one place to look)
├── deploy-commands.js      ← run once to register slash commands with Discord
├── commands/               ← one file per slash command (must export {data, execute})
├── services/               ← business logic + I/O
│   ├── database.js         ← SQLite migrations + prepared statements
│   ├── cooldownStore.js    ← persistent per-key cooldown TTLs (use this, NOT Map)
│   ├── deadLetterService.js← failed Discord post retry queue
│   ├── scorecardService.js ← signal replay → win rate metrics
│   └── ...                 ← marketData, news, technicalAnalysis, macro, etc.
├── utils/
│   ├── logger.js           ← pino — get a child with .child('component')
│   ├── httpClient.js       ← USE THIS for outbound HTTP (timeouts + retries)
│   ├── cronManager.js      ← USE THIS to register cron jobs
│   ├── discordSend.js      ← USE THIS to post to channels (dead-letter aware)
│   ├── safeEmbed.js        ← truncation + total-char enforcement
│   ├── numHelpers.js       ← pctChange, safeDiv — use these, never raw `/`
│   ├── cache.js            ← in-memory TTL cache with stampede protection
│   └── sparkline.js        ← ASCII sparklines
└── server/
    └── healthz.js          ← GET /healthz JSON snapshot

tests/                       ← vitest; one file per module
docs/                        ← architecture, scope, runbook
data/                        ← SQLite + WAL + backups (gitignored)
```

## Do-this / don't-do-this checklist

| Task | ✅ Do | ❌ Don't |
|---|---|---|
| Outbound HTTP | `makeClient({ host: 'yahoo' }).get(url)` | `axios.get(url)` (no timeout, no retry, no rate limit) |
| Schedule a job | `cronManager.schedule('name', expr, async () => {...})` | `cron.schedule(...)` directly (loses timezone + shutdown handling) |
| Post to a channel | `sendToChannel(client, channelId, { embeds: [e] })` | `channel.send(...)` directly (failures vanish) |
| Track a cooldown | `cooldownStore.setCooldown('key', ttlMs)` | `new Map()` (dies on restart) |
| Log | `log.info({ event, count }, 'msg')` with structured fields | `console.log('[Tag] msg ' + count)` |
| Divide | `pctChange(prev, cur)` (returns null on 0/NaN) | `(cur - prev) / prev * 100` (Infinity) |
| Truncate an embed | `safeDescription(text)` + `enforceTotalLimit(embed)` | `text.substring(0, 4096)` (still might bust the 6000 total) |
| Add to embed | use `addFields(safeFields([...]))` | unbounded field name/value strings |
| Ephemeral reply | `{ flags: MessageFlags.Ephemeral }` | `{ ephemeral: true }` (deprecated) |
| Capture an alert | `scorecard.captureSignal({ signalType, direction, symbol, capturedPrice })` | nothing (alert quality stays unmeasurable) |

## Common workflows

### "Add a new slash command"

1. Create `src/commands/<name>.js`. Export `{ data: SlashCommandBuilder, execute(interaction) }`.
2. The bot auto-loads it on startup — no registration needed in `index.js`.
3. Run `npm run deploy` once to push command metadata to Discord.
4. Add a `tests/<name>.test.js` if the command has any logic worth testing.

### "Add a new auto-posted alert"

1. Create `src/services/<feature>Service.js` exporting `runCycle()` returning event objects.
2. Per event: gate on `cooldownStore.isOnCooldown(key)`, set cooldown after firing, call `scorecard.captureSignal(...)` so signal quality is tracked.
3. Add `buildMyEventEmbed(event)` in `src/utils/embeds.js` and export it.
4. Register a cron in `src/scheduler.js`. **Always** post via `sendToChannel(...)`.
5. Add an env var to `.env.example` for the cron expression so users can disable / retune.

### "Modify the DB schema"

1. Append a new entry to the `migrations` array in `src/services/database.js`. Bump the version number.
2. Migrations run idempotently on boot (`if (version > current) exec(sql)`); never edit a past migration in place.
3. If you're adding a hot-path column, add an index in the same migration.
4. Add cleanup rule in `cleanupOldData()` if the table grows unboundedly.

### "Touch a cron expression"

Always read it from `process.env.<NAME>_CRON` with a default. Pass it to `cronManager.schedule(name, expr, fn)` — never to `node-cron` directly.

## Tests

- `npm test` runs everything (vitest). 48 tests at v2; keep that number up, not flat.
- Tests live in `tests/`. Mirror the module name: `src/utils/foo.js` → `tests/foo.test.js`.
- TA math, dedup, retry, cooldown, embed truncation — all testable without network or LLM. Test those.
- Discord and LLM integration: don't write tests against the real service. Mock with `vi.mock(...)` or leave uncovered (call it out in the PR).

## Things you might miss on first read

- **The .env contains real keys on disk for the user.** It is gitignored. Never `cat .env` to the user, never commit it.
- `LLM_CACHE_TTL_MS` defaults to 20min. If you change it, also include the model in the cache key (it already does — see `llmService.js`).
- The `analyze()` function in `technicalAnalysisService.js` accepts EITHER a closes array OR a full candles object. The full object path enables ATR/risk-metrics; the array path doesn't.
- Cron jobs run on `SCHEDULE_TIMEZONE` (default `America/New_York`), NOT the server timezone.
- `cleanupOldData()` runs daily and wraps every delete in a single transaction. If you add a table, add its delete inside the same transaction.

## "Walking the diff" for a code review

Read in this order to ramp up fastest:
1. `docs/PROJECT_SCOPE.md` — what + why
2. `docs/ARCHITECTURE.md` — how it fits together
3. `src/scheduler.js` — every cron job in one file
4. `src/services/database.js` — the migration list shows feature history
5. `tests/` — the contract for the pure modules

## Don't write these without asking the user first

- Anything that adds a paid dependency
- Anything that adds a binary/native dep (canvas, sharp, ffmpeg) — would inflate Docker image
- Anything that requires opening a new outbound port
- A multi-guild schema migration — touches every table
- A breaking change to `commands/<x>.js` data shape — Discord caches command definitions
