# Web Dashboard — Design & Implementation Plan

> **Status:** DRAFT / proposal — no code written yet.
> **Owner:** @sebaa___
> **Created:** 2026-07-19
> **Applies to:** `discord-futures-news-bot` v2.0.0
> **Scope of this document:** the full plan for a live, Discord-login-gated web dashboard that mirrors and *expands* every bot feature into a richer browser experience. This is a planning artifact only — implementation is deliberately deferred until the open decisions in §21 are resolved.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Personas & Access Tiers](#3-personas--access-tiers)
4. [Scope: MVP → Full](#4-scope-mvp--full)
5. [High-Level Architecture](#5-high-level-architecture)
6. [Authentication & Authorization (Discord OAuth2)](#6-authentication--authorization-discord-oauth2)
7. [Backend API Design](#7-backend-api-design)
8. [Frontend Design](#8-frontend-design)
9. [Feature-by-Feature Web Views](#9-feature-by-feature-web-views)
10. [Real-Time & Live Data](#10-real-time--live-data)
11. [Data Model Additions](#11-data-model-additions)
12. [Security & Privacy](#12-security--privacy)
13. [Observability & Operations](#13-observability--operations)
14. [Deployment & Hosting](#14-deployment--hosting)
15. [Proposed Project Structure](#15-proposed-project-structure)
16. [Tech Stack Summary & Rationale](#16-tech-stack-summary--rationale)
17. [Phased Roadmap](#17-phased-roadmap)
18. [Testing Strategy](#18-testing-strategy)
19. [Risks & Mitigations](#19-risks--mitigations)
20. [Cost Estimate](#20-cost-estimate)
21. [Open Questions / Decisions Needed](#21-open-questions--decisions-needed)
22. [Appendices](#22-appendices)

---

## 1. Executive Summary

Today the bot is **Discord-only**: users interact through 10 slash commands and receive cron-driven alerts posted to a channel. All the intelligence (AI briefings, technical analysis, anomaly detection, signal scorecards, market memory) is squeezed into Discord embeds — which is exactly why `/news` recently hit Discord's 6000-char embed cap and failed to render.

This plan introduces a **companion web dashboard**: a login-gated single-page web app where the same data and features live in a full-screen, interactive, real-time interface. Users authenticate **with their Discord account**; the app confirms whether they are a member of the bot's server, greets them by their Discord identity, and unlocks the feature set appropriate to their role.

The dashboard is not a rewrite of the bot — it is a **second front-end on the same brain**. The bot process remains the single source of truth (it owns the SQLite database and the Discord connection); the web app is a new presentation + interaction layer bolted onto it via an HTTP/WebSocket API.

**Headline capabilities:**

- 🔐 **"Login with Discord"** → shows your avatar/username, tells you if you're in the server, and gates access by membership + role.
- 📊 **Expanded feature views** — every command (`/news`, `/analysis`, `/levels`, `/pulse`, `/anomaly`, `/calendar`, `/recap`, `/scorecard`, `/snooze`) reimagined with charts, tables, filters, and detail panels no Discord embed could hold.
- ⚡ **Live** — WebSocket-pushed price ticks, a unified real-time alert feed, and live health status.
- 🕹️ **Interactive** — trigger an on-demand analysis or recap, tune your watchlist and notification preferences, replay signal history.
- 🛠️ **Web admin** — a browser version of the existing `AdminPanel.ps1` (API health, config, bot control, logs) gated to admins.

---

## 2. Goals & Non-Goals

### 2.1 Goals

| # | Goal | Success signal |
|---|------|----------------|
| G1 | Discord-based login with identity + membership awareness | User sees their avatar/name; non-members are cleanly gated |
| G2 | Every bot feature available in an expanded web view | All 10 commands have a corresponding page with richer UX |
| G3 | Real-time, "live" feel | Alerts appear on the dashboard the instant a cron job fires; prices tick without refresh |
| G4 | Zero disruption to the existing bot | Bot keeps working in Discord exactly as before; dashboard is additive |
| G5 | Single source of truth | No data duplication; the dashboard reads/writes the same SQLite DB via the bot process |
| G6 | Secure by default | No secrets in the browser; RBAC enforced server-side; auditable actions |
| G7 | Operable by one person | One-command local run; simple, documented deploy path |

### 2.2 Non-Goals (for v1)

- ❌ Replacing Discord as the primary notification channel (Discord stays authoritative).
- ❌ Multi-tenant / multi-server SaaS (single guild only for v1).
- ❌ A public, unauthenticated marketing site (landing page is minimal; app is gated).
- ❌ Real brokerage integration / order execution (this is analysis, not trading).
- ❌ Mobile native apps (responsive web / PWA only).
- ❌ Rewriting the bot's services in another language/framework.

---

## 3. Personas & Access Tiers

Access is determined **after** Discord login by checking membership and roles in the configured guild (`DISCORD_GUILD_ID`). Membership/roles are resolved authoritatively via the **bot's own discord.js client** (the bot is already in the server), not solely from the user's OAuth token.

| Tier | Who | What they can do |
|------|-----|------------------|
| **Guest** | Not logged in | See landing page + "Login with Discord" only |
| **Authenticated (non-member)** | Logged in, but **not** in the server | See "You're not in the server" gate with an invite link; profile visible; no feature data |
| **Member** | In the server, standard role | Full **read** access to all feature views; manage own preferences/watchlist; trigger low-cost personal actions |
| **Contributor** *(optional)* | Member with an elevated role | Everything Member can, plus trigger actions that **post to the Discord channel** (e.g. push a recap) |
| **Admin / Owner** | Guild owner or configured admin IDs / role | Everything, plus **web admin panel**: API health tests, config editing, bot start/stop/restart, log viewer, audit log |

**Admin identification options (to be decided in §21):**
- `ADMIN_DISCORD_IDS` env allowlist (explicit, simplest), and/or
- a specific guild role name (e.g. `Dashboard Admin`), and/or
- guild owner is always admin.

---

## 4. Scope: MVP → Full

Delivering in thin vertical slices keeps the project shippable at every step.

### 4.1 MVP (proof it works end-to-end)
- Discord OAuth login + membership gate + session.
- App shell (nav, header with user avatar, theme).
- **Market Pulse** page (read-only) — proves DB read + live data path.
- Health/status widget (reuses existing `/healthz`).

### 4.2 v1 (the useful product)
- All read-only feature views: News, Analysis, Levels, Anomaly, Calendar, Recap archive, Scorecard.
- Real-time alert feed + live prices (WebSocket).
- User preferences + watchlist management.
- On-demand actions (regenerate recap, run analysis).

### 4.3 v1.5+ (nice-to-have)
- Web admin panel (mirror of `AdminPanel.ps1`).
- Browser push notifications / PWA install.
- Market-memory / AI-narrative explorer.
- Shareable read-only report links.

---

## 5. High-Level Architecture

### 5.1 The single most important constraint

The bot uses **`better-sqlite3`**, which is **synchronous and single-process**. Two separate Node processes cannot both safely open the same DB file for writes. Additionally, the **discord.js client** (needed to check guild membership/roles and to post messages) lives inside the bot process.

➡️ **Therefore the recommended architecture is: the bot process is the single owner of the database + the Discord client + all services, and it *also* hosts the web API and WebSocket server.** The browser front-end is a static SPA served from the same origin. This gives us:
- one writer to SQLite (no cross-process locking headaches),
- direct, in-process access to discord.js for auth/membership and posting,
- same-origin cookies (no CORS), and
- one thing to deploy.

The existing `src/server/healthz.js` (a bare `http` server on port 3000) is the seed we grow the API from.

### 5.2 Component diagram

```
                          Browser (SPA: React + Vite)
                          │  cookies (httpOnly session)
                          │  HTTPS + WSS
                          ▼
        ┌──────────────────────────────────────────────────────┐
        │                 BOT PROCESS (Node.js)                 │
        │                                                       │
        │   ┌───────────────┐        ┌────────────────────┐    │
        │   │  Web layer     │        │  discord.js client │    │
        │   │  (Fastify)     │◄──────►│  (Guilds, Messages)│    │
        │   │  - REST API    │        └────────────────────┘    │
        │   │  - WebSocket   │                 ▲                 │
        │   │  - static SPA  │                 │ post / fetch    │
        │   │  - OAuth       │                 │ member          │
        │   └──────┬─────────┘                 │                 │
        │          │ calls                     │                 │
        │          ▼                           │                 │
        │   ┌──────────────────────────────────┴───────────┐    │
        │   │  Existing services (unchanged)               │    │
        │   │  news / llm / marketData / macro / sentiment │    │
        │   │  technicalAnalysis / scorecard / anomaly ... │    │
        │   └──────┬───────────────────────────────────────┘    │
        │          │                                            │
        │   ┌──────▼─────────┐     ┌────────────────────────┐   │
        │   │ better-sqlite3 │     │  Internal Event Bus     │   │
        │   │  data/bot.db   │     │  (EventEmitter) ───────►│──►│ WS fan-out
        │   └────────────────┘     └────────────────────────┘   │
        │          ▲                                            │
        │   ┌──────┴─────────┐                                  │
        │   │ node-cron jobs │  (also emit to the event bus)    │
        │   └────────────────┘                                  │
        └──────────────────────────────────────────────────────┘
                          │
                          ▼
        External APIs: Discord, NewsAPI, Benzinga, Finnhub,
        Cerebras, Deepgram, Alpha Vantage, Yahoo, Stooq,
        CoinGecko, Alternative.me
```

### 5.3 Why not a separate Next.js server / separate DB reader?

| Option | Verdict | Reason |
|--------|---------|--------|
| **A. Embed API in bot process, serve static SPA** ✅ **Recommended** | Chosen | One DB writer, in-process Discord access, simplest deploy, same-origin auth |
| B. Separate web server reading same SQLite file | Rejected for v1 | `better-sqlite3` single-process; would need WAL + an IPC channel to trigger Discord actions; more moving parts |
| C. Next.js full-stack (SSR) as the API too | Possible alt | Nice DX, but reintroduces a second process that still needs to reach discord.js + the single DB owner; adds complexity for little v1 benefit |
| D. Message queue between web + bot | Overkill | Warranted only at multi-instance scale, which is a non-goal |

> If SSR/SEO ever matters (it shouldn't for a gated app), option C can be revisited. For a login-gated internal tool, a same-origin SPA is the pragmatic choice.

---

## 6. Authentication & Authorization (Discord OAuth2)

### 6.1 Discord application setup (one-time)
- Reuse the existing app (`DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` already in `.env`).
- Add **OAuth2 redirect URIs**: `http://localhost:3000/api/auth/callback` (dev) and `https://<domain>/api/auth/callback` (prod).
- Scopes requested: **`identify`** (username, avatar, id) + **`guilds`** (list of the user's servers). Optionally **`guilds.members.read`** if we want roles straight from OAuth — but we can instead resolve roles via the bot client (preferred, §6.4).

### 6.2 Login flow (authorization code grant)

```
1. User clicks "Login with Discord"
       → GET /api/auth/login
       → server generates `state` (CSRF nonce), stores it, 302 to
         https://discord.com/api/oauth2/authorize?client_id=…&scope=identify%20guilds&state=…&redirect_uri=…

2. User approves on Discord
       → Discord 302 back to /api/auth/callback?code=…&state=…

3. Server validates `state`, exchanges `code` for tokens
       → POST https://discord.com/api/oauth2/token
       → gets access_token (+ refresh_token)

4. Server fetches identity
       → GET /users/@me            (id, username, global_name, avatar)
       → GET /users/@me/guilds     (does it include DISCORD_GUILD_ID?)

5. Server resolves membership + roles AUTHORITATIVELY via the bot client
       → guild.members.fetch(userId)  → roles, nickname, joinedAt
         (bot is already in the guild, so this is the source of truth)

6. Server upserts the user, creates a server-side session,
   sets an httpOnly + Secure + SameSite=Lax session cookie,
   then 302 to the SPA (/app).
```

### 6.3 Sessions
- **Server-side sessions** stored in SQLite (`web_sessions` table, §11): `session_id` (random 256-bit) → `discord_id`, `expires_at`, `created_ip`, `user_agent`.
- Cookie: `httpOnly`, `Secure` (prod), `SameSite=Lax`, sliding expiry (e.g. 7 days), server-side revocation supported (logout / "sign out everywhere").
- Rationale over JWT-in-cookie: instant revocation, easy membership re-check, no token-in-JS.

### 6.4 Membership & role gating
- On each authenticated request (or cached per session for a short TTL, e.g. 5–10 min), the server confirms the user is still in `DISCORD_GUILD_ID` and reads their roles via the bot client.
- Tier is derived (Guest/Non-member/Member/Contributor/Admin) and attached to the request context.
- Endpoints/pages are protected by a middleware that requires a minimum tier.
- Membership changes (user leaves server, loses a role) take effect within the cache TTL.

### 6.5 What the user sees about themselves
- Avatar (`https://cdn.discordapp.com/avatars/{id}/{hash}.png`), username / global name, discriminator-less handle.
- **"In server: ✅ / ❌"** badge with server name + their roles + join date.
- Session info (last login, current sessions) with a logout / revoke-all control.

---

## 7. Backend API Design

### 7.1 Framework
**Fastify** (recommended) — fast, first-class plugins for cookies/sessions/websocket/static/rate-limit, schema-based validation. Alternative: **Express** (more familiar, larger ecosystem, slightly more boilerplate). Either runs inside the bot process alongside discord.js.

**Plugins:** `@fastify/cookie`, `@fastify/session` (or custom SQLite store), `@fastify/websocket`, `@fastify/static` (serve the built SPA), `@fastify/rate-limit`, `@fastify/helmet` (security headers), `@fastify/cors` (dev only).

### 7.2 Conventions
- Base path `/api`. JSON in/out. Errors as `{ error: { code, message } }`.
- All feature endpoints require ≥ Member tier unless noted.
- Read endpoints are cacheable; expensive/generative endpoints are rate-limited per user.
- The SPA is served for all non-`/api` routes (SPA fallback to `index.html`).

### 7.3 Endpoint catalog (illustrative)

**Auth & identity**
| Method | Path | Tier | Purpose |
|--------|------|------|---------|
| GET | `/api/auth/login` | Guest | Start OAuth |
| GET | `/api/auth/callback` | Guest | OAuth callback |
| POST | `/api/auth/logout` | Auth | End current session |
| POST | `/api/auth/logout-all` | Auth | Revoke all sessions |
| GET | `/api/me` | Auth | Profile + membership + roles + tier |

**Feature data (read)**
| Method | Path | Maps to | Notes |
|--------|------|---------|-------|
| GET | `/api/news?category=&breaking=&q=&page=` | `/news`, `news_articles` | Filter, search, paginate; impact + tier badges |
| GET | `/api/news/briefing?category=` | `llmService.summarizeNews` | Cached AI briefing (respects `llmCache`) |
| GET | `/api/pulse` | `/pulse` | Watchlist quotes + macro (DXY/10Y/VIX) + F&G + funding |
| GET | `/api/analysis/:symbol` | `/analysis` | TA + risk + macro + War Room verdict |
| GET | `/api/levels/:symbol` | `/levels` | S/R zones, Fib grid, decision zone, AI notes |
| GET | `/api/anomaly?range=` | `/anomaly`, `anomaly_events` | Scan history + live status |
| GET | `/api/calendar` | `/calendar`, `economic_events` | Upcoming events + countdowns |
| GET | `/api/recap/latest` / `/api/recap/history` | `/recap`, `llm_outputs` | Recap archive + audio URL |
| GET | `/api/scorecard` | `/scorecard`, `signal_replay` | Win rate, resolved vs pending, series |
| GET | `/api/candles/:symbol?tf=` | `marketDataService` | OHLCV for charts (daily/weekly) |
| GET | `/api/memory?type=` | `llm_outputs`, `correlation_log` | AI narrative / memory explorer |

**Feature actions (write / trigger)** — Contributor+ where they post to Discord
| Method | Path | Tier | Purpose |
|--------|------|------|---------|
| POST | `/api/actions/recap/regenerate` | Member (self) / Contributor (post) | Force a fresh recap; optionally post to channel |
| POST | `/api/actions/analysis/run` | Member | On-demand analysis for a symbol |
| POST | `/api/actions/tts` | Member | Generate recap audio (Deepgram, quota-guarded) |
| PUT | `/api/prefs` | Member | Watchlist, categories, notif settings (`user_prefs`) |
| POST | `/api/snooze` | Member | Snooze alerts (maps to `/snooze`) |

**Admin** (Admin tier)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/health` | Run server-side API tests (Discord/NewsAPI/Cerebras/…) — reuses `AdminPanel.ps1` logic in JS |
| GET/PUT | `/api/admin/config` | Read/patch `.env`-backed settings (secrets never returned in full — masked) |
| POST | `/api/admin/bot/{start,stop,restart}` | Process control (guarded) |
| GET | `/api/admin/logs?tail=` | Recent log lines |
| GET | `/api/admin/audit` | Audit log of dashboard actions |

**Real-time**
| Protocol | Path | Purpose |
|----------|------|---------|
| WS | `/api/stream` | Subscribe to channels: `prices`, `alerts`, `health` |

### 7.4 Internal event bus (the key to "live")
Introduce a lightweight in-process `EventEmitter` (`src/events/bus.js`). Cron jobs and services that currently only post to Discord (breaking news, level breaks, funding flips, anomaly scans, MTF divergence, scorecard resolution) **also** emit typed events (`alert:breaking_news`, `alert:level_break`, …). A WS hub subscribes and fans events out to connected dashboard clients in real time. **Discord posting is unchanged** — the dashboard is an additional consumer, not a replacement.

---

## 8. Frontend Design

### 8.1 Stack
- **React 18 + Vite + TypeScript** — fast dev, static build served by Fastify.
- **Routing:** React Router.
- **Server state:** TanStack Query (caching, refetch, background sync) over the REST API.
- **Real-time:** a small WS client feeding into the query cache / a store (Zustand) for live channels.
- **UI kit:** Tailwind CSS + a component layer (shadcn/ui or Mantine) for accessible primitives.
- **Charts:** **TradingView `lightweight-charts`** for price candles + S/R levels; **Recharts** for indicators, scorecard bars, gauges.
- **Icons:** lucide-react. **Dates:** day.js.

### 8.2 Sitemap / routes

```
/                      Landing + "Login with Discord"          (Guest)
/app                   Overview / home dashboard                (Member)
/app/news              News Hub                                 (Member)
/app/pulse             Market Pulse                             (Member)
/app/analysis/:sym     Analysis Workbench                       (Member)
/app/levels/:sym       Levels & Zones                           (Member)
/app/anomaly           Anomaly Monitor                          (Member)
/app/calendar          Economic Calendar                        (Member)
/app/recap             Recap Archive (+ audio)                  (Member)
/app/scorecard         Signal Scorecard                         (Member)
/app/alerts            Live Alert Feed                          (Member)
/app/settings          Preferences / Watchlist / Sessions       (Member)
/app/admin             Admin: health / config / bot / logs      (Admin)
/gate                  "Not in the server" screen               (Non-member)
```

### 8.3 Design system
- **Theme:** dark-first (traders like dark), with light mode; theme-aware and persisted.
- **Layout:** left nav rail (icons + labels), top bar (server name, user avatar/menu, live-status dot, global symbol search), main content area with responsive grid.
- **Density:** information-dense but scannable — cards, tables with sticky headers, tabs, drawers for detail.
- **Color semantics:** green/red for up/down, tiered impact badges (🔥 High / 📋 Medium / 💤 Low), source-tier stars (★★★/★★/★).
- **Empty/'degraded' states:** first-class. When Cerebras is down or a feed is dead, show a clear banner ("AI briefing unavailable — showing raw headlines") instead of an error — matching the bot's graceful fallbacks.
- **Accessibility:** keyboard nav, ARIA on interactive components, sufficient contrast in both themes.

### 8.4 Cross-cutting components
Global symbol search • Live-status indicator (green/amber/red from `/healthz`) • Toast notifications for new alerts • Skeleton loaders • Error boundaries • "Powered by" data-source attributions (Cerebras/Yahoo/etc.).

---

## 9. Feature-by-Feature Web Views

Each existing command becomes a full page. "Expanded" = what the web can show that a Discord embed cannot.

### 9.1 News Hub (`/news`)
- Filterable, **searchable** feed: category tabs (Oil / Metals / Crypto / Forex / All), breaking toggle, source-tier filter, full-text search over `news_articles`.
- **AI Briefing panel** (from `llmService`) rendered as readable prose — no 6000-char cap (this directly solves the current `/news` embed-overflow bug).
- Per-article **detail drawer**: summary, source tier, impact score, sentiment, timestamp, outbound link.
- **Historical archive** — browse days back (the bot already persists to `news_articles`).
- Live "breaking" ticker fed by the `alert:breaking_news` event.

### 9.2 Market Pulse (`/pulse`)
- All 11 watchlist assets in a **heatmap / grid** with % change, sparkline, and category grouping.
- **Institutional keys** row: DXY, 10Y yield, VIX with directional coloring.
- **Fear & Greed gauge** (Alternative.me) + crypto **funding-rate** table.
- Auto-refresh via WS `prices` channel.

### 9.3 Analysis Workbench (`/analysis/:symbol`)
- Interactive **candlestick chart** (lightweight-charts) with SMA-20/50, RSI(14), MACD panels.
- **Divergence** call-outs marked on the chart.
- **Risk metrics**: ATR, expected 1-day move, volatility regime.
- **Macro context** + correlation notes.
- **War Room Verdict** (AI) panel; a "Run fresh analysis" button (rate-limited).

### 9.4 Levels & Zones (`/levels/:symbol`)
- Chart with algorithmically-detected **support/resistance zones** drawn as bands + **Fibonacci grid** overlay.
- **Decision zone** highlighted; AI ≤12-word notes per level.
- Bias badge (Bullish/Bearish/Neutral). Prices are algorithmic (no hallucination), matching current design.

### 9.5 Anomaly Monitor (`/anomaly`)
- Live scan status + **timeline** of `anomaly_events` (price spikes, VIX surges, DXY breakouts, yield spikes, funding extremes, correlation sweeps).
- Threshold reference (from `config.anomaly`); severity coloring; drill-down per event.

### 9.6 Economic Calendar (`/calendar`)
- Upcoming `economic_events` as a timeline/agenda with impact flags and live countdowns; filter by impact/currency.

### 9.7 Recap Archive (`/recap`)
- Latest recap rendered nicely; **archive** of past recaps from `llm_outputs`.
- **Audio player** for Deepgram TTS recaps; "Regenerate" (+ optional "Post to Discord" for Contributors).

### 9.8 Signal Scorecard (`/scorecard`)
- **Win-rate** and signal-quality analytics from `signal_replay`: resolved vs pending, by signal type/direction, over time.
- Charts: cumulative accuracy, per-type breakdown, recent resolutions table.

### 9.9 Preferences (`/settings`)
- Watchlist customization, category subscriptions, notification preferences (`user_prefs`), snooze controls, theme, and **active sessions** management.

### 9.10 Live Alert Feed (`/alerts`)
- One unified, real-time stream of every cron-driven alert type, with filters and "jump to related page" links. This is the "mission control" view Discord can't offer.

### 9.11 Admin (`/admin`) — Admin tier
- **API Health**: server-side re-implementation of `AdminPanel.ps1`'s test logic (Discord, NewsAPI, Benzinga, Finnhub, Cerebras, Deepgram, Alpha Vantage, Yahoo, Stooq, CoinGecko, Alternative.me) with live pass/fail + latency.
- **Config**: edit `.env`-backed settings (secrets masked; write-only reveal); validation.
- **Bot control**: start/stop/restart + `/healthz` snapshot + **log tail**.
- **Audit log** of dashboard-initiated actions.

> The web admin panel and the existing `AdminPanel.ps1` are complementary: the PS1 works even when the bot/web is down (out-of-band); the web panel is convenient when everything is up.

---

## 10. Real-Time & Live Data

| Channel | Source | Cadence | Transport |
|---------|--------|---------|-----------|
| `prices` | `marketDataService` poller | e.g. every 15–30s (market-hours aware) | WS push |
| `alerts` | Internal event bus (cron jobs) | Event-driven (instant) | WS push |
| `health` | `/healthz` snapshot | every 10–30s | WS push or client poll |

- **Backpressure & fan-out:** a single server-side poller shared across all clients (never one fetch per client). Clients subscribe to channels they need.
- **Reconnect:** client auto-reconnects with backoff; on reconnect it refetches REST snapshots to resync, then resumes the stream.
- **Fallback:** if WS is blocked (some corp networks), degrade to SSE or interval polling.
- **Cost control:** live prices reuse existing caches; no new external-API load beyond the shared poller.

---

## 11. Data Model Additions

The dashboard adds a small number of tables to the **existing** `data/bot.db`. Existing tables (unchanged, read by the API): `market_snapshots`, `news_articles`, `macro_snapshots`, `sentiment_readings`, `llm_outputs`, `economic_events`, `correlation_log`, `posted_content`, `anomaly_scans`, `anomaly_events`, `anomaly_subscribers`, `cooldowns`, `pending_posts`, `user_prefs`, `signal_replay`, `level_break_state`, `funding_flip_state`, (+ COT / event-outcome / MTF / dead-letter state), `schema_version`.

**New tables (proposed):**

| Table | Purpose | Key columns (sketch) |
|-------|---------|----------------------|
| `web_users` | Dashboard identities | `discord_id` PK, `username`, `global_name`, `avatar_hash`, `is_member`, `roles_json`, `first_login`, `last_login` |
| `web_sessions` | Server-side sessions | `session_id` PK, `discord_id`, `expires_at`, `created_ip`, `user_agent`, `revoked` |
| `web_oauth_state` | CSRF nonces for OAuth | `state` PK, `created_at`, `redirect_after` (short TTL) |
| `web_audit_log` | Who did what | `id`, `discord_id`, `action`, `target`, `meta_json`, `ip`, `ts` |
| `web_push_subs` *(later)* | Browser push endpoints | `id`, `discord_id`, `endpoint`, `keys_json` |

- The existing `user_prefs` table is reused for watchlist/notification preferences (keyed by Discord user id), so bot and dashboard share preferences.
- All new tables go through the existing migration mechanism (`schema_version`) — additive, no destructive changes.
- **DB mode:** enable **WAL** (if not already) for better read concurrency while the bot writes.

---

## 12. Security & Privacy

### 12.1 Threat model highlights & controls
| Threat | Control |
|--------|---------|
| Secret leakage to browser | **Never** send API keys/tokens to the client. All external-API calls + tests run server-side. Admin config returns secrets **masked**. |
| Session theft | `httpOnly` + `Secure` + `SameSite=Lax` cookies; server-side revocation; short sliding expiry; rotate on privilege change. |
| CSRF | OAuth `state` nonce; `SameSite` cookies; CSRF token on state-changing POSTs. |
| Unauthorized feature/admin access | Tier middleware on every endpoint; membership/roles re-verified via bot client with short cache TTL. |
| Abuse of expensive actions (LLM/TTS/Discord posts) | Per-user rate limits; reuse `llmCache`; Deepgram quota guard; Contributor+ gate for channel posts. |
| Over-posting to Discord from web | Explicit confirm + audit log + cooldowns (reuse `cooldowns` table). |
| Injection / XSS | Parameterized SQL (better-sqlite3 prepared statements — already the pattern); React auto-escaping; `helmet` CSP. |
| Brute force / scraping | `@fastify/rate-limit`; auth required for all data endpoints. |
| Transport | HTTPS/WSS enforced in prod (HSTS). |

### 12.2 Privacy
- Store the minimum Discord profile needed (id, name, avatar hash, membership, roles). Do **not** store OAuth refresh tokens unless a concrete need arises; if stored, encrypt at rest.
- Provide logout + "revoke all sessions" + a way to delete stored profile data.
- Document data retention (sessions expire; audit log retention window).

### 12.3 Secrets handling
- Keys stay in `.env` (server-side), same as today. The web admin edits `.env` server-side (mirroring `AdminPanel.ps1`) — values are never round-tripped to the browser in cleartext.

---

## 13. Observability & Operations

- **Logging:** reuse **pino** (already in the bot). Add a web child logger (`log.child('web')`) with request logging (method, path, tier, latency, user id) — omit secrets/PII beyond user id.
- **Health:** extend the existing `/healthz` snapshot to also report web-layer status (active WS clients, session count). The dashboard's status dot reads this.
- **Metrics (optional):** counts of logins, active sessions, WS connections, action invocations, API-test outcomes — surfaced on the admin page.
- **Errors:** server error boundary → structured logs; client error boundary → optional client error reporting endpoint.
- **Audit:** every write/trigger/admin action recorded in `web_audit_log`.

---

## 14. Deployment & Hosting

### 14.1 The realities here
- Dev machine is **Windows 11**; `better-sqlite3` is a native module (compiles per platform/Node version) — moving to Linux means a rebuild, not a copy.
- For a truly "live" dashboard reachable from anywhere, we need HTTPS + a stable address.

### 14.2 Options matrix
| Option | How | Pros | Cons |
|--------|-----|------|------|
| **A. Same Windows box + Cloudflare Tunnel** ✅ easiest to go live | Run bot+web locally; `cloudflared` exposes `https://dash.<domain>` with no port-forwarding | Free TLS, no firewall changes, keeps your existing setup | Box must stay on; home uptime |
| B. Windows box + Caddy/nginx reverse proxy + port forward | Local reverse proxy terminates TLS | Full control | Exposes home IP; router config; cert management |
| C. VPS (Ubuntu) + PM2/systemd + Caddy | Deploy repo to a small VPS | Always-on, clean prod | Rebuild native modes; migrate DB; ~$5–10/mo |
| D. Docker container (on box or VPS) | Containerize bot+web | Reproducible | Native module build in image; volume for `bot.db` |

**Recommended path:** start with **A (Cloudflare Tunnel on the current machine)** for the fastest route to a real HTTPS login (Discord OAuth needs HTTPS in prod), then graduate to **C/D** if you want always-on independence from your PC.

### 14.3 Process management
- Keep bot + web as **one process** (per §5). Manage with **PM2** (cross-platform, auto-restart, log rotation) or a Windows Service wrapper (e.g. NSSM). The existing `AdminPanel.ps1` start/stop remains useful for local control.

### 14.4 Environments & config
- Add web-specific env: `WEB_ENABLED`, `WEB_PORT` (or reuse `HEALTHZ_PORT`), `WEB_PUBLIC_URL`, `SESSION_SECRET`, `OAUTH_REDIRECT_URI`, `ADMIN_DISCORD_IDS`.
- Separate dev vs prod OAuth redirect URIs registered in the Discord app.
- Document all new vars in `.env.example` (and expose them in `AdminPanel.ps1`'s schema).

### 14.5 CI/CD (optional)
- The repo already parks a CI template in `docs/ci-template`. Extend it: lint + typecheck + unit/integration + a build of the SPA; deploy step for the chosen host.

---

## 15. Proposed Project Structure

Additive to the current `src/` layout — nothing existing is moved in v1.

```
src/
  index.js                 # bootstraps bot + (new) web layer
  web/                     # NEW — the web layer
    server.js              #   Fastify app, plugin registration, SPA static + fallback
    auth/
      oauth.js             #   Discord OAuth login/callback/token exchange
      session.js           #   session store (SQLite) + cookie handling
      guard.js             #   tier middleware (Member/Contributor/Admin)
    routes/
      me.js  news.js  pulse.js  analysis.js  levels.js  anomaly.js
      calendar.js  recap.js  scorecard.js  candles.js  prefs.js
      actions.js  admin.js
    ws/
      hub.js               #   WebSocket fan-out, channel subscriptions
    services-adapter.js    #   thin read-models bridging existing services → API DTOs
  events/
    bus.js                 # NEW — internal EventEmitter used by cron/services + WS
  services/                # UNCHANGED existing services
  ...
web/                       # NEW — front-end SPA (separate build)
  index.html
  src/
    main.tsx  App.tsx  router.tsx
    api/                   #   typed API client + TanStack Query hooks
    ws/                    #   WS client + live stores (Zustand)
    components/            #   design-system + shared widgets
    pages/                 #   one folder per route (News, Pulse, Analysis, …)
    theme/                 #   Tailwind config, tokens, dark/light
  vite.config.ts
  package.json             #   (or a workspace within the root package.json)
docs/
  WEB_DASHBOARD_PLAN.md    # this document
```

Build step: `web/` compiles to static assets that Fastify serves via `@fastify/static`, with an SPA fallback to `index.html`.

---

## 16. Tech Stack Summary & Rationale

| Layer | Choice | Why | Alternatives |
|-------|--------|-----|--------------|
| Runtime | Node.js ≥20 (bot already on v24) | Reuse everything | — |
| Web server | **Fastify** | Fast, plugin-rich, schema validation, runs in-process | Express, Hapi |
| Auth | Discord OAuth2 + server-side sessions | Native "login with Discord"; instant revocation | JWT cookies, Auth.js |
| DB | **existing better-sqlite3** (`bot.db`) + WAL | Single source of truth; no new datastore | Postgres (overkill for one guild) |
| Real-time | WebSocket (`@fastify/websocket`) + internal event bus | Instant alerts; shared poller | SSE, polling |
| Front-end | **React + Vite + TypeScript** | Fast SPA, huge ecosystem, static hostable | Next.js (SSR), SvelteKit |
| Server state | TanStack Query | Caching/refetch/sync | SWR, RTK Query |
| Styling/UI | Tailwind + shadcn/ui (or Mantine) | Fast, accessible, themeable | MUI, Chakra |
| Charts | lightweight-charts + Recharts | Purpose-built candles + flexible stats | ECharts, D3 |
| Process mgmt | PM2 (or NSSM on Windows) | Auto-restart, logs | systemd (Linux) |
| Public access | Cloudflare Tunnel (start) → VPS/Docker (later) | Free HTTPS, no port-forward | nginx + certbot |

> **TypeScript note:** the bot is currently CommonJS JS. The **new** `web/` front-end should be TS. The backend web layer can be JS (to match the bot) or TS via `ts-node`/build. Decision in §21.

---

## 17. Phased Roadmap

Each phase is independently shippable. Estimates are rough (solo dev, part-time) and exclude the decision-making in §21.

### Phase 0 — Foundations & decisions *(~0.5 wk)*
- Resolve §21 open questions (hosting, TS, who gets access, can members post to Discord).
- Register OAuth redirect URIs; add web env vars to `.env` + `.env.example` + `AdminPanel.ps1`.
- Add the internal **event bus** and WAL mode (no user-visible change yet).
- **Deliverable:** decisions doc + env scaffolding + green build.

### Phase 1 — Auth & app shell *(~1 wk)*
- Fastify inside the bot process; serve a placeholder SPA.
- Discord OAuth login → session → `/api/me`; membership/role resolution via bot client.
- App shell: nav, header with avatar, membership badge, theme; the **non-member gate**.
- **Deliverable:** you can log in with Discord and see who you are + whether you're in the server. *(This alone satisfies the core of the request.)*

### Phase 2 — Read-only dashboards *(~2 wks)*
- Market Pulse, News Hub (fixes the embed-overflow pain), Analysis, Levels, Calendar, Recap archive, Scorecard, Anomaly — all reading existing DB/services.
- Charts wired up (candles, indicators, gauges).
- **Deliverable:** the whole feature set is viewable in the browser.

### Phase 3 — Real-time *(~1 wk)*
- WS hub + `prices`/`alerts`/`health` channels; cron jobs emit to the bus.
- Live Alert Feed page; live status dot; toast on new alerts.
- **Deliverable:** the dashboard feels "live."

### Phase 4 — Interactivity *(~1 wk)*
- Preferences/watchlist (`user_prefs`), snooze, on-demand analysis, regenerate recap, TTS (quota-guarded), optional post-to-Discord (Contributor+), all audited + rate-limited.
- **Deliverable:** users can *do* things, not just watch.

### Phase 5 — Web admin *(~1 wk)*
- Port `AdminPanel.ps1` logic to server-side: API health tests, config editor (masked secrets), bot control, log tail, audit view.
- **Deliverable:** manage the bot from the browser (Admin tier).

### Phase 6 — Hardening & deploy *(~1 wk)*
- Rate limits, CSP/helmet, session revocation, error/empty states, accessibility pass.
- Cloudflare Tunnel → public HTTPS; PM2/service; runbook update.
- **Deliverable:** a secured, publicly reachable, always-restartable dashboard.

### Phase 7 — Polish *(ongoing)*
- Mobile/PWA, browser push, memory/AI-narrative explorer, shareable read-only links, metrics.

> **Fastest path to the headline feature** (login + "see your user + are you in the server") = **Phase 0 + Phase 1**.

---

## 18. Testing Strategy

| Level | Tooling | Covers |
|-------|---------|--------|
| Unit | **Vitest** (already in the repo) | New read-models, auth helpers, tier logic, event bus |
| Integration | Vitest + Fastify `inject()` | API endpoints w/ auth fixtures, membership gating, rate limits |
| Component | React Testing Library | Key widgets (feed, charts wrappers, forms) |
| E2E | Playwright | OAuth login happy-path (mocked Discord), gating, a feature view, an action |
| Contract | JSON schema on endpoints | Request/response shape stability |
| Manual/UAT | Checklist per phase | Real Discord login, real data, degraded-state behavior |

- Reuse the existing 48-test Vitest suite; add web suites alongside.
- Provide fixtures/mocks for Discord OAuth + guild membership so tests don't hit Discord.

---

## 19. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | `better-sqlite3` cross-process contention | Med | High | Single process owns DB (chosen architecture) + WAL |
| R2 | Web crash affects the bot (shared process) | Med | High | Robust error handling in web layer; isolate via try/catch + circuit-breaking; PM2 auto-restart; keep option open to split later |
| R3 | Secrets leaking to the browser | Low | Critical | Server-side-only key use; masked config; code review checklist |
| R4 | Discord OAuth/API rate limits on membership checks | Med | Med | Cache membership per session (TTL); resolve via bot client, not per-request OAuth |
| R5 | Web-triggered LLM/TTS/Discord spam & cost | Med | Med | Per-user rate limits; `llmCache`; Deepgram quota guard; cooldowns; audit |
| R6 | Cerebras currently returns empty (known bug) | High (now) | Med | Dashboard degrades gracefully (raw headlines banner); fix Cerebras separately |
| R7 | Home-hosting uptime for a "live" site | Med | Med | Cloudflare Tunnel now; VPS/Docker later |
| R8 | Native-module rebuild when moving to Linux/Docker | Med | Low | Documented build step; pin Node version; CI build |
| R9 | Scope creep (this is a big plan) | High | Med | Ship Phase-by-Phase; MVP first; non-goals enforced |
| R10 | Session/cookie misconfig over tunnel/proxy | Med | Med | Set `trust proxy`, correct cookie domain/secure flags; test behind the tunnel early |

---

## 20. Cost Estimate

| Item | Cost |
|------|------|
| Cloudflare Tunnel + a domain | ~$0 tunnel + ~$10/yr domain (or free subdomain) |
| Optional VPS (always-on) | ~$5–10/mo |
| External APIs | Reuses existing keys; dashboard adds no new paid API (respects caches). Deepgram TTS still on its free 60-min/mo tier — guarded. |
| LLM (Cerebras) | Free tier today; web triggers are rate-limited + cached |
| Dev time | ~7–9 part-time weeks for Phases 0–6 (see §17); MVP (login + identity) in ~1–1.5 weeks |

---

## 21. Open Questions / Decisions Needed

These steer the build; please weigh in before Phase 0 → 1.

1. **Audience & reach** — Just you, or every member of the server? Public internet or LAN/VPN-only?
2. **Hosting** — Start on the current Windows PC via Cloudflare Tunnel (recommended), or go straight to a VPS/Docker?
3. **Can members trigger Discord posts from the web?** (Read-only for members, posting for a "Contributor" role? Or nobody posts from the web in v1?)
4. **Admin identification** — allowlist of Discord IDs (`ADMIN_DISCORD_IDS`), a specific guild role, guild-owner-only, or a mix?
5. **TypeScript** — TS for the whole web layer (front + back), or JS backend (match the bot) + TS front-end only?
6. **Front-end framework** — SPA served by the bot (recommended) vs Next.js SSR?
7. **Same process vs split later** — comfortable running web inside the bot process for v1 (recommended), knowing we can split at scale?
8. **Domain** — do you have one, or use a free Cloudflare subdomain?
9. **Scope of v1** — ship the full read-only feature set (Phase 2) before real-time (Phase 3), or interleave?
10. **Design direction** — dark-first "trading terminal" aesthetic (recommended), or something lighter/brand-specific?

---

## 22. Appendices

### 22.1 Mapping: existing bot → dashboard
| Bot command | Service(s) | Dashboard page | Key existing tables |
|-------------|-----------|----------------|---------------------|
| `/news` | `newsService`, `llmService` | News Hub | `news_articles`, `llm_outputs` |
| `/pulse` | `marketDataService`, `macroService`, `sentimentService` | Market Pulse | `market_snapshots`, `macro_snapshots`, `sentiment_readings` |
| `/analysis` | `technicalAnalysisService`, `llmService`, `macroService` | Analysis Workbench | `market_snapshots`, `correlation_log`, `llm_outputs` |
| `/levels` | `technicalAnalysisService`, `llmService` | Levels & Zones | `market_snapshots`, `llm_outputs` |
| `/anomaly` | `anomalyScanner` | Anomaly Monitor | `anomaly_scans`, `anomaly_events`, `anomaly_subscribers` |
| `/calendar` | `macroService` / calendar source | Economic Calendar | `economic_events` |
| `/recap` | `llmService`, `ttsService` | Recap Archive | `llm_outputs` |
| `/scorecard` | `scorecardService` | Signal Scorecard | `signal_replay` |
| `/snooze` | cooldown/prefs | Settings | `cooldowns`, `user_prefs` |
| (cron) breaking/level/funding/mtf/anomaly | respective services | Live Alert Feed | `posted_content`, `*_state` tables |

### 22.2 Cron jobs that will also feed the live feed
`morning_briefing`, `daily_recap`, `anomaly_scan`, `breaking_news`, `level_break`, `mtf_divergence`, `funding_flip`, `event_outcome`, `cot_friday`, `scorecard_resolve`, `deadletter_drain`, `cooldown_purge`.

### 22.3 External APIs (reused, server-side only)
Discord, NewsAPI.org, Benzinga, Finnhub *(key currently 401 — fix separately)*, Cerebras *(returning empty — fix separately)*, Deepgram TTS, Alpha Vantage, Yahoo Finance, Stooq, CoinGecko, Alternative.me. (Massive.com is declared but unused — do **not** wire it into the dashboard.)

### 22.4 Relationship to `AdminPanel.ps1`
The PowerShell admin panel remains the **out-of-band** control surface (works when the web/bot is down). The **web admin page** (Phase 5) re-implements its API-test/config/bot-control/log logic in-process for convenience. Keep both; they serve different failure modes.

### 22.5 Glossary
- **Tier** — a user's permission level derived from Discord membership + roles.
- **Event bus** — in-process `EventEmitter` that lets cron jobs/services notify the WS layer.
- **Read-model** — a thin adapter shaping existing service/DB data into an API DTO.
- **SPA fallback** — serving `index.html` for any non-API route so client-side routing works.

---

*End of plan. Nothing here is implemented yet — this document is the blueprint to review and approve. Next step: answer §21, then execute Phase 0 → Phase 1 to land "Login with Discord + identity + membership."*
