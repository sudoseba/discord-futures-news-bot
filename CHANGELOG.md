# Changelog

## [2.0.0] — 2026-06-02

Major hardening + new differentiator features. Built from the ground-up audit in `ANALYSIS.md` (kept locally, not in repo).

### Added — new features

- **Signal Scorecard** (`/scorecard`) — every alert is captured at fire-time; a resolver cron records forward prices at 1h, 4h, 24h and computes win rate per signal type / direction. Turns the bot from "alerts fired" into "alerts that worked".
- **Multi-timeframe RSI divergence detector** — runs daily + weekly RSI divergence and only alerts on confluence (or high-strength weekly-only). Sharply reduces false positives versus single-TF divergence.
- **Level-break detector** — every 5 min checks current price against the most recent LLM-annotated S/R levels per symbol. Emits one-shot transition alerts (with per-level cooldown).
- **Funding-rate sign-flip detector** — alerts when BTC/ETH perp funding flips sign, a classic positioning-extreme reversal signal.
- **Weekly CFTC COT report** — every Friday afternoon ET, pulls commercial vs. speculator positioning for futures-eligible watchlist symbols and posts a single grouped embed.
- **Economic-event outcome interpreter** — when a high-impact event publishes its `actual` value, an LLM writes a 60–100 word "what it means for DXY/Gold/Crude/BTC" interpretation.
- **/snooze command** — temporarily mute anomaly DMs (1h, 4h, 12h, 24h, 7d). Respected by the scanner DM loop.
- **Persistent cooldowns** — every alert type now uses `cooldownStore` (SQLite) instead of in-memory `Map`, so a restart doesn't re-fire just-suppressed alerts.
- **Dead-letter queue** — failed Discord posts (5xx, network) are parked in `pending_posts` and retried with exponential backoff by the `deadletter_drain` cron.
- **Structured logging** — pino with `LOG_LEVEL` and `LOG_PRETTY` env knobs. Token / key fields are redacted.
- **Healthz endpoint** — `GET http://localhost:3000/healthz` returns a JSON snapshot of cron run timestamps, DB ok, uptime, memory.
- **Per-host rate limiters + retry/backoff** — `utils/httpClient.js` exposes per-service axios clients with token-bucket limits and exponential retry on 429/5xx.
- **Safe embed wrapper** — `utils/safeEmbed.js` enforces per-field clamps + the global 6000-char cap. Builders should use this for any user-influenced content.
- **DB integrity check on boot** — runs `PRAGMA integrity_check` and refuses to start if the DB is corrupt.
- **Daily DB backup** — `VACUUM INTO data/backups/bot-<ts>.db`, rotated to 7 days. Manual via `npm run backup`.
- **Vitest test suite** — 48 tests covering TA math, dedup, cache LRU/TTL, retry, cooldown, embed truncation, sparkline, num helpers.
- **Multi-stage Dockerfile + healthcheck** — slimmer runtime image, `/healthz` integrated.
- **Docs** — `docs/ARCHITECTURE.md`, `docs/PROJECT_SCOPE.md`, `docs/RUNBOOK.md`, `AGENTS.md`, `CONTRIBUTING.md`.

### Changed — fixes & refactors

- **Cron now timezone-aware** — every job runs on `SCHEDULE_TIMEZONE` (default `America/New_York`). Previously the comments said "ET" but cron used server time.
- **Cron re-entry suppressed** — if a previous tick is still in flight, the next tick is skipped + logged instead of overlapping.
- **Cron jobs hold task refs** — graceful shutdown stops every job before destroying the Discord client + closing the DB.
- **Forex Factory timezone** — converted via `Intl.DateTimeFormat('America/New_York')` so DST is respected. Previously `getUTCHours() - 5` was wrong half the year.
- **Anomaly scan no longer aborts on a single failing source** — `Promise.allSettled` per source, each degrades to null/[].
- **Anomaly scanner DMs respect /snooze**.
- **TA peak/trough detection uses strict inequality** — flat plateaus no longer register as both peak and trough (which produced phantom divergences).
- **Division-by-zero guards everywhere** — `pctChange()` returns `null`, `clusterLevels()` skips zero centers, `expectedMovePercent` checks finite price.
- **News keyword filter respects word boundaries** for single-word keywords. "oil" no longer matches "toiletries".
- **LLM cache keys include model version** — model upgrade automatically invalidates stale outputs.
- **LLM fallback briefing is cached for 60 s** — a transient LLM outage no longer hammers the broken endpoint on every call.
- **F&G visual bar off-by-one fixed** — `value=100` no longer writes past the buffer.
- **TTS no longer appends "..."** — that would be vocalised as "dot dot dot" in the recap audio.
- **Recap voice defaults OFF** — opt-in only, protects Deepgram's 60-min free quota.
- **Headline dedup hashes the full headline**, not the first 200 chars (which collided on long headlines sharing a prefix).
- **Breaking-news dedup fails closed** — if the DB check throws, the headline is skipped rather than re-posted.
- **`searchArticles` escapes SQL LIKE wildcards** — user query of `___` no longer scans the entire table.
- **DB cleanup runs in a single transaction** — no more 9-statement WAL stalls.
- **Discord channels resolved via REST `fetch`** when not in cache — fixes cold-start where cron fires before gateway populates `channels.cache`.
- **`ephemeral: true` migrated to `flags: MessageFlags.Ephemeral`** — discord.js v14 deprecation.
- **`client.destroy()` is awaited** before `process.exit`.
- **`client.login()` rejections trigger fatal exit** instead of zombie process.
- **`ActivityType.Watching`** replaces magic number `3`.

### Removed

- The legacy `utils/rateLimiter.js` is still exported (used by `newsService`/`marketDataService`/`macroService` for Finnhub limiter compatibility) but is deprecated in favour of `utils/httpClient.js`'s per-host limiters.

### Schema migrations

- **v5** — `cooldowns`, `pending_posts`, `user_prefs`
- **v6** — `signal_replay`, `level_break_state`, `funding_flip_state`

Migrations are idempotent — apply automatically on first boot after upgrade.

### Operational notes

- New env vars in `.env.example`: `SCHEDULE_TIMEZONE`, `BREAKING_NEWS_CRON`, `LEVEL_BREAK_CRON`, `SCORECARD_RESOLVE_CRON`, `COT_FRIDAY_CRON`, `EVENT_OUTCOME_CRON`, `DEADLETTER_DRAIN_CRON`, `LOG_LEVEL`, `LOG_PRETTY`, `HEALTHZ_PORT`, `HEALTHZ_ENABLED`.
- Node 20+ required (set in `engines.node`).
- Docker image now multi-stage; pull `:latest` after upgrade.

## [1.0.0] — 2026-02-22 (legacy)

Initial release. RSS news, Finnhub/Yahoo data, Cerebras-LLM briefings, daily recap, anomaly scanner with in-memory cooldowns.
