# Architecture

```
                              ┌────────────────────────────────────────┐
                              │            Discord Gateway              │
                              └────────────────┬───────────────────────┘
                                               │ slash commands / DMs
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                              src/index.js                                      │
│   - loads commands/*.js   - starts scheduler   - starts /healthz HTTP         │
└───────────────┬─────────────────────────────────────────┬─────────────────────┘
                │                                         │
                ▼                                         ▼
┌──────────────────────────────┐         ┌──────────────────────────────────┐
│      Commands (per request)  │         │   scheduler.js (cronManager)     │
│   /news /pulse /analysis     │         │   morning_briefing               │
│   /levels /calendar /recap   │         │   daily_recap                    │
│   /anomaly /scorecard /snooze│         │   anomaly_scan (15m)             │
│   /help                      │         │   breaking_news (5m)             │
└──────────┬───────────────────┘         │   level_break (5m)               │
           │                              │   mtf_divergence (30m)           │
           │                              │   funding_flip (30m)             │
           │                              │   event_outcome (10m)            │
           │                              │   cot_friday (Fri 16:30 ET)      │
           │                              │   scorecard_resolve (30m)        │
           │                              │   deadletter_drain (1m)          │
           │                              │   cooldown_purge (1h)            │
           │                              └──────┬──────────────────────────┘
           │                                     │
           ▼                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Services Layer                                  │
│                                                                              │
│   marketDataService   ─ multi-source candle/quote fallback                   │
│   newsService         ─ RSS+Finnhub+NewsAPI+Benzinga, fuzzy dedup            │
│   technicalAnalysis   ─ RSI/MACD/SMA/ATR + divergence + level detection      │
│   macroService        ─ DXY/10Y/VIX + FF/Finnhub calendar + CFTC COT         │
│   sentimentService    ─ F&G index + Binance funding rates                    │
│   anomalyScanner      ─ 7 rules, persistent cooldowns, snooze-aware DMs      │
│   levelBreakService   ─ price-vs-level transition detection                  │
│   mtfDivergenceService─ D+W RSI divergence confluence                        │
│   fundingFlipService  ─ funding-rate sign flip detection                     │
│   cotReportService    ─ weekly CFTC commercial-net summary                   │
│   eventOutcomeService ─ post-release LLM interpretation                      │
│   scorecardService    ─ signal replay (1h/4h/24h forward returns)            │
│   llmService          ─ Cerebras prompts (briefing, recap, verdict, levels)  │
│   memoryService       ─ assembles DB rows → LLM context blocks               │
│   ttsService          ─ Deepgram TTS for recap audio                         │
│   cooldownStore       ─ persistent cooldowns (SQLite-backed)                 │
│   deadLetterService   ─ failed-post retry queue                              │
└──────────┬───────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Persistence (SQLite, WAL)                        │
│                                                                               │
│   v1: market_snapshots · news_articles · macro_snapshots ·                    │
│       sentiment_readings · llm_outputs · economic_events                      │
│   v2: correlation_log · posted_content                                        │
│   v3: anomaly_scans · anomaly_events                                          │
│   v4: anomaly_subscribers                                                     │
│   v5: cooldowns · pending_posts · user_prefs   ← new                          │
│   v6: signal_replay · level_break_state · funding_flip_state ← new            │
└───────────────────────────────────────────────────────────────────────────────┘

           ▲                                                  ▲
           │                                                  │
┌──────────┴───────────┐                            ┌─────────┴───────────┐
│  utils/httpClient    │                            │   utils/cronManager │
│  per-host limiters   │                            │   tz + re-entry-safe │
│  axios-retry         │                            └──────────────────────┘
└──────────────────────┘
┌──────────────────────┐
│   utils/discordSend  │   sendToChannel → channels.fetch → ch.send
│   on retriable fail  │              ↳ deadLetter.enqueue
└──────────────────────┘
┌──────────────────────┐
│   utils/safeEmbed    │   truncate · safeFields · enforceTotalLimit (6000 cap)
└──────────────────────┘
┌──────────────────────┐
│   utils/numHelpers   │   pctChange (null on 0/NaN) · safeDiv · clamp
└──────────────────────┘
┌──────────────────────┐
│   utils/logger       │   pino (structured) · LOG_LEVEL + LOG_PRETTY
└──────────────────────┘
┌──────────────────────┐
│   server/healthz     │   GET /healthz → json snapshot of cron + DB + uptime
└──────────────────────┘
```

## Key design decisions

**1. SQLite WAL + busy_timeout 5s.** Single-writer, many-reader. Briefing cron writes while a `/pulse` command reads — WAL handles this; the timeout prevents `SQLITE_BUSY` blowups.

**2. Cooldowns persist.** A deploy mid-scan must NOT cause a just-fired anomaly to re-fire. State lives in `cooldowns` table, not `Map`.

**3. Every Discord post is dead-letterable.** `sendToChannel(client, channelId, payload)` catches Discord 5xx / network errors and parks the payload in `pending_posts`. The `deadletter_drain` cron retries with exponential backoff (1m → 2m → 4m → 8m → 16m, then drop).

**4. Cron timezone is explicit.** Every job declares `America/New_York`. The host's timezone is irrelevant. Comment-versus-behaviour drift was a pre-v2 footgun.

**5. Cron re-entry suppression.** If a previous tick is still in flight (e.g. anomaly scan takes >15 min during an API outage), the new tick is skipped, not overlapped.

**6. LLM never invents prices.** `/levels` runs `detectLevels()` first (algorithmic — swing highs, pivots, fibs, SMAs). The LLM only writes *notes* on those fixed prices. Cache key includes `cerebrasModel` so a model upgrade invalidates stale annotations.

**7. Signal scorecard is built-in, not a plugin.** Every alert that fires calls `scorecard.captureSignal(...)`. The `scorecard_resolve` cron later pulls forward quotes and computes PnL. `/scorecard` surfaces the rolling win rate.

**8. Multi-source fallback for candles.** `Yahoo → Stooq → CoinGecko → Binance → Finnhub`. Yahoo flakes regularly. Stooq is the best free futures CSV source. Crypto has two backups beyond Yahoo.

**9. Healthz over telemetry.** The bot exposes `GET /healthz` returning a JSON snapshot: uptime, last run of each cron job, DB ok, RSS memory. Cheaper than wiring Prometheus for a trading-group bot.

**10. Single process, single SQLite file.** No microservices, no Redis. The hot path is ~17 HTTP calls per scan + a handful of SQLite writes. Modern hardware eats this for breakfast.

## Module dependency rule

`commands/` and `scheduler.js` may import `services/` and `utils/`.
`services/` may import `services/`, `utils/`, and `config.js`.
`utils/` may import `utils/` and `config.js`.
`utils/` MUST NOT import `services/` (except `cooldownStore`, `deadLetter` — they're storage-backed utilities themselves).

## Where to add a new alert type

1. Create `src/services/myNewSignalService.js` that returns event objects from a `runCycle()` function.
2. Inside `runCycle()`, call `cooldownStore.setCooldown(key, ttl)` and `scorecard.captureSignal({...})` for each new event.
3. Add an embed builder to `src/utils/embeds.js`.
4. Register a cron in `src/scheduler.js` via `cronManager.schedule('my_signal', cronExpr, async () => {...})`.
5. Post events through `sendToChannel(...)` so failures land in the dead-letter queue.
