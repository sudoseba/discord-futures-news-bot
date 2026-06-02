# Project Scope

_What this project is, what it isn't, and what success looks like._

## One-line pitch

A Discord bot for futures traders that fuses live multi-source market news, technical analysis, anomaly detection, and a **backtested signal-quality scorecard** — so users can see whether the alerts actually edge out random, not just how many fired.

## Target user

A small-to-medium private Discord trading group (1–500 members) focused on **futures, FX, and crypto** — energy, metals, indices, majors, BTC/ETH. Members trade off macro catalysts (CPI/FOMC/NFP), technical levels, and crowd-positioning extremes (VIX, DXY, funding rates, COT).

## In scope

**Information surfaces (slash commands):**
- `/news` — AI-curated market headlines with impact scoring
- `/pulse` — live dashboard: prices, RSI tags, macro keys, F&G
- `/analysis <symbol>` — full TA + macro + AI War Room verdict
- `/levels <symbol>` — algorithmic S/R with LLM annotation
- `/calendar` — 2-week economic calendar (FF + Finnhub merged)
- `/recap` — EOD plain-English recap (optional Deepgram TTS)
- `/scorecard` — win rate of every alert type at 1h/4h/24h forward
- `/anomaly subscribe|status|unsubscribe` — DM alert opt-in
- `/snooze` — temporary DM mute
- `/help` — discoverable command list

**Automated streams (cron):**
- Morning briefing 8 AM ET weekdays
- End-of-day recap 4:30 PM ET weekdays
- Anomaly scanner every 15 min (price spikes, VIX, DXY, yields, F&G, funding, multi-asset sweep)
- Breaking news every 5 min (tier-1 wires only)
- Level-break detector every 5 min
- MTF (D+W) RSI-divergence confluence every 30 min
- Funding-rate sign flip detector every 30 min
- Economic event "actual" LLM interpretation every 10 min
- Weekly CFTC COT report every Friday 4:30 PM ET
- Scorecard resolver (records forward returns at 1h/4h/24h)
- Dead-letter queue drain (retries failed Discord posts)

**Persistence:**
- SQLite (better-sqlite3, WAL mode) with 6 schema versions
- Daily VACUUM INTO backup → `data/backups/` rotated to 7 days
- 60–90 day rolling retention on hot tables

## Out of scope (for now)

- **Trade execution** — this is an information bot, not a broker integration. No orders, no fills.
- **Personalised portfolio tracking** — no per-user positions or PnL.
- **Multi-guild custom watchlists** — schema is single-tenant; would need a `guild_settings` table and refactor of every command. (See Roadmap.)
- **Voice-channel announcement** — TTS service exists but joining a voice channel requires opus/ffmpeg on the host. Skipped to keep deps slim.
- **Web dashboard** — covered by `/healthz` + the upcoming `/scorecard`. A full Next.js dashboard is on the roadmap, not v2.

## Success metrics

| Metric | Target |
|---|---|
| Uptime (via /healthz) | ≥ 99% over 30 days |
| Mean command response time (p50) | ≤ 4 s |
| Briefing cron miss rate | 0 in a 30-day window |
| Test suite | Green on every commit, ≥ 40 tests |
| Signal scorecard 24h win rate | Track and surface — no hard target. The point is to know the number. |
| Cost per month (API + hosting) | ≤ $5 (free-tier APIs + small VPS) |

## Risk register

| Risk | Mitigation |
|---|---|
| Discord token leak | `.env` is gitignored; logger redacts; `.env.example` only |
| Cerebras / Finnhub rate limit | Per-host token-bucket limiters in `utils/httpClient.js` + retry-with-backoff |
| Yahoo Finance flakiness | Multi-source fallback chain (Yahoo → Stooq → CoinGecko → Binance → Finnhub) |
| LLM hallucinated price levels | Levels are algorithmically detected first; LLM only annotates fixed numbers |
| SQLite corruption on power loss | WAL mode + daily VACUUM INTO backups + integrity_check on boot |
| Cron silent failure | cronManager wraps every tick with try/catch + structured log + healthz timestamp |
| Discord 5xx eats an alert | Every send goes through `sendToChannel` → `pending_posts` dead-letter on failure |

## Non-goals & explicit choices

- **No microservices.** Single Node process, single SQLite file. Trading-group scale doesn't need k8s.
- **No ORM.** Hand-written prepared statements. The schema is small enough that an ORM is overhead.
- **No TypeScript.** CJS-only to minimise build tooling. If the codebase grows past ~10k LOC, revisit.
- **Free-tier APIs only.** RSS, Stooq, CoinGecko, Binance public, alternative.me, Forex Factory, CFTC. Optional paid keys (Finnhub Plus, NewsAPI, Benzinga) provide *extra* sources but are not required.
