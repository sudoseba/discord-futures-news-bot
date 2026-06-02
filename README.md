# 🚀 Futures News & Analysis Discord Bot

A Discord bot for futures traders that fuses **live news**, **technical analysis**, **anomaly detection**, and a **backtested signal-quality scorecard** — so you can see whether the alerts actually edge out random, not just how many fired.

```
┌─ /pulse · /news · /analysis · /levels · /calendar · /recap · /scorecard ─┐
│   /anomaly subscribe · /snooze · /help                                    │
└── + auto-posted: morning briefing, EOD recap, breaking wire, level breaks,┘
    MTF divergence, funding flips, event interpretations, weekly COT
```

---

## ✨ What's in here

| Surface | What it does |
|---|---|
| `/news [category] [breaking] [raw]` | Multi-source news (RSS + Finnhub + NewsAPI + Benzinga), AI-curated, impact scored |
| `/pulse` | Live dashboard: prices, RSI tags, DXY/10Y/VIX, Fear & Greed, funding rates |
| `/analysis <symbol>` | RSI + MACD + divergence + risk metrics + macro context + AI War Room verdict |
| `/levels <symbol>` | 5-method S/R detection (swing, pivot, fib, SMA, range) + weekly confluence + AI annotations |
| `/calendar` | 2-week economic calendar — Forex Factory + Finnhub merged |
| `/recap [voice]` | Plain-English EOD recap + optional Deepgram TTS audio |
| `/scorecard [days] [signal]` | **Win rate of past alerts at 1h / 4h / 24h forward** |
| `/anomaly subscribe \| status \| unsubscribe` | DM alert opt-in (7 alert types, fine-grained) |
| `/snooze [duration]` | Temporarily mute anomaly DMs |
| `/help` | The full command index |

**Auto-posts (no command required):**

- ☀️ **Morning briefing** — AI-curated headlines, weekdays 8 AM ET
- 📋 **End-of-day recap** — plain-English market wrap, weekdays 4:30 PM ET
- 🔴 **Breaking news** — top tier-1 wires, every 5 min
- 📐 **Level breaks** — when price crosses a key support/resistance
- 📈 **MTF divergences** — daily + weekly RSI confluence only
- ⚡ **Funding flips** — when crypto perp funding flips sign
- 📢 **Event outcomes** — LLM interpretation of CPI/NFP/FOMC actuals
- 📊 **Weekly COT** — Friday CFTC commercial-vs-spec positioning

---

## 🛠️ Setup

### 1. Get the keys (all free)

| Service | Required? | Link |
|---|---|---|
| **Discord bot** | yes | [Developer Portal](https://discord.com/developers/applications) |
| **Finnhub** | yes | [finnhub.io](https://finnhub.io/) — news + candles |
| **Alpha Vantage** | yes | [alphavantage.co](https://www.alphavantage.co/support/#api-key) — backup TA + forex |
| **Cerebras** | optional | [cloud.cerebras.ai](https://cloud.cerebras.ai/) — LLM (briefings, verdicts, recaps) |
| **NewsAPI** | optional | [newsapi.org](https://newsapi.org/) — extra news source |
| **Benzinga** | optional | [api.benzinga.com](https://api.benzinga.com/) — extra news source |
| **Deepgram** | optional | [deepgram.com](https://deepgram.com/) — recap audio (60 min/mo free) |

### 2. Install & run

```bash
git clone git@github.com:sudoseba/discord-futures-news-bot.git
cd discord-futures-news-bot
npm install
cp .env.example .env       # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID, AUTO_POST_CHANNEL_ID
npm run deploy             # one-time: register slash commands with Discord
npm start                  # run the bot
```

Visit `http://localhost:3000/healthz` to verify it's alive.

### 3. Docker

```bash
docker compose up -d
docker compose logs -f bot
```

### 4. Tests

```bash
npm test         # 48 vitest tests
```

---

## 🧠 What makes this bot different

1. **Signal scorecard.** Every alert gets captured at fire-time; a resolver cron computes the 1h / 4h / 24h forward return. `/scorecard` shows you the actual win rate. *Most bots just count alerts. This one measures whether the alerts work.*

2. **MTF divergence confluence.** Single-timeframe divergence is noisy. This bot only alerts when daily + weekly agree (or weekly is high-strength on its own).

3. **Levels the LLM can't hallucinate.** Algorithmic detection runs first — swing highs, pivots, fibonacci, SMAs. The LLM only writes annotations on the fixed prices.

4. **Weekly CFTC COT automation.** Every Friday: commercial-vs-spec net positioning for futures-eligible watchlist symbols.

5. **Funding-rate flip detection.** Sign flips often precede reversals. Most bots show the current rate; this one watches for the transition.

6. **Event outcome LLM interpretation.** When CPI/NFP/FOMC publishes the actual, the bot drops a 60-word interp tailored to DXY/Gold/Crude/BTC.

7. **Robust operations.** Persistent cooldowns, dead-letter post queue, automated daily DB backup, structured logging, healthz endpoint, multi-source data fallback, per-host rate limiters with retry/backoff, 48 vitest tests.

---

## 📁 Project structure

```
src/
├── index.js                  # entry — loads commands, starts scheduler + healthz
├── config.js                 # env loader, watchlist, thresholds
├── scheduler.js              # every cron job in one file
├── deploy-commands.js        # one-time slash command registration
├── commands/                 # one file per slash command
├── services/                 # business logic + I/O
│   ├── database.js           # SQLite migrations + queries
│   ├── newsService.js
│   ├── marketDataService.js  # Yahoo → Stooq → CoinGecko → Binance → Finnhub
│   ├── technicalAnalysisService.js
│   ├── macroService.js       # DXY/10Y/VIX + FF/Finnhub calendar + CFTC COT
│   ├── sentimentService.js
│   ├── anomalyScanner.js
│   ├── llmService.js         # Cerebras (briefing, recap, verdict, levels)
│   ├── memoryService.js      # DB rows → LLM context blocks
│   ├── ttsService.js         # Deepgram
│   ├── cooldownStore.js      # persistent cooldowns
│   ├── deadLetterService.js  # failed-post retry queue
│   ├── scorecardService.js   # signal replay → win rate
│   ├── levelBreakService.js
│   ├── mtfDivergenceService.js
│   ├── fundingFlipService.js
│   ├── cotReportService.js
│   └── eventOutcomeService.js
├── utils/
│   ├── logger.js             # pino structured logging
│   ├── httpClient.js         # axios + retry + per-host limiter
│   ├── cronManager.js        # timezone-aware + re-entry-safe + shutdown-aware
│   ├── discordSend.js        # post-or-deadletter
│   ├── safeEmbed.js          # truncation + total-char enforcement
│   ├── numHelpers.js         # pctChange (null on 0/NaN)
│   ├── cache.js              # TTL + LRU + stampede protection
│   ├── sparkline.js          # ASCII sparklines
│   ├── embeds.js             # all embed builders
│   └── rateLimiter.js        # legacy (kept for compat; new code uses httpClient)
├── server/
│   └── healthz.js            # GET /healthz JSON snapshot

tests/                          # vitest
docs/                           # ARCHITECTURE, PROJECT_SCOPE, RUNBOOK
AGENTS.md                       # notes for AI coding assistants
CONTRIBUTING.md                 # PR conventions
CHANGELOG.md                    # version history
data/                           # SQLite + WAL + backups (gitignored)
```

---

## ⚙️ Customizing

### Add/remove watchlist symbols

Edit `watchlist` in `src/config.js`. Symbol format follows Finnhub conventions (`OANDA:XAU_USD`, `BINANCE:BTCUSDT`).

### Change schedules

Override any of the cron env vars in `.env`:
```
BRIEFING_CRON=0 8 * * 1-5
RECAP_CRON=30 16 * * 1-5
ANOMALY_SCAN_CRON=*/15 * * * *
SCHEDULE_TIMEZONE=America/New_York
```

### Tune anomaly thresholds

`config.anomaly.*` in `src/config.js` — price spike %, VIX surge %, F&G shift points, etc.

### Add a new alert type

See `AGENTS.md` → "Common workflows → Add a new auto-posted alert".

---

## 📜 License

MIT
