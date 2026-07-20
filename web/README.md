# Web Dashboard

A **separate, Discord-login-gated web service** that mirrors the bot into a live
browser dashboard. It runs as its own process (its own port, its own systemd
unit) and integrates with the bot by:

- reading the bot's SQLite DB **read-only** (WAL mode → no contention with the bot), and
- proxying the bot's `/healthz` endpoint for live status.

It never writes to the bot's database. Its own state (sessions, audit log) lives
in a separate `data/webdash.db`.

```
┌────────────┐   reads /healthz    ┌──────────────────┐
│  the bot   │◀────────────────────│  web dashboard   │  ← this service
│ (index.js) │   read-only DB      │ (web/src/…)      │
│  owns DB   │◀────────────────────│  express + ws    │
└────────────┘                     └──────────────────┘
                                     ▲  Discord OAuth2 login
                                     │  http/ws over your Tailnet
                                   browser
```

## Features

- **Login with Discord** (OAuth2), gated to members of your guild; admin views
  unlocked by user-id or role.
- **Overview** — live health hero, headline stats, live activity feed.
- **Activity / Anomalies / Scorecard / System** views over the bot's data.
- **Admin** — API connectivity tests, read-only (masked) bot config, access audit log.
- **Live** — WebSocket push for health + new anomalies/AI outputs, with a
  polling-free reconnect.
- Structured logging (pino) throughout, security headers (helmet), rate limits,
  signed session cookies, graceful shutdown.

---

## Prerequisites

- The bot already set up in the parent directory (see `../deploy/README.md`).
- Node.js ≥ 20 and `build-essential python3` (this service compiles its own
  `better-sqlite3`).

## 1 · Register the OAuth redirect in Discord

In the [Discord Developer Portal](https://discord.com/developers/applications) →
your app → **OAuth2** → **Redirects**, add exactly the URL users will reach the
dashboard at, with `/auth/callback`:

```
http://<your-pi-tailscale-name-or-ip>:8080/auth/callback
```

(Whatever you put in `WEB_PUBLIC_URL` + `/auth/callback` must match a registered
redirect verbatim.)

## 2 · Install & configure

```bash
cd web
npm ci --omit=dev            # compiles better-sqlite3 (a few min on a Pi)
cp .env.example .env
npm run secret               # prints a value → paste into SESSION_SECRET in .env
```

Edit `.env` and set at minimum:

- `SESSION_SECRET` — the value from `npm run secret`.
- `WEB_PUBLIC_URL` — e.g. `http://raspberrypi:8080` (matches the redirect above).
- `ADMIN_USER_IDS` — your Discord user id (so you get the Admin views).

`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` and `DISCORD_GUILD_ID` are inherited
from the bot's `../.env` automatically — no need to repeat them.

> **Client secret:** the OAuth flow needs `DISCORD_CLIENT_SECRET`. If it isn't in
> the bot's `.env` yet, add it (Developer Portal → OAuth2 → Client Secret).

## 3 · Run it

Dev / quick check:
```bash
npm start
# → open WEB_PUBLIC_URL in a browser
```

As a service (auto-start on boot, restart on crash):
```bash
bash deploy/install-web-service.sh --start
journalctl -u discord-web-dashboard -f
```

---

## Accessing it over Tailscale

**Simplest (HTTP):** with `WEB_HOST=0.0.0.0`, browse to
`http://<pi-tailscale-ip-or-MagicDNS>:8080`. Set `WEB_PUBLIC_URL` to that URL and
register the matching `/auth/callback` redirect.

**Nicer (HTTPS, no port):** let Tailscale terminate TLS:
```bash
sudo tailscale serve --bg 8080          # serves https://<host>.tailXXXX.ts.net → :8080
```
Then set `WEB_PUBLIC_URL=https://<host>.tailXXXX.ts.net` and register
`https://<host>.tailXXXX.ts.net/auth/callback`. Cookies auto-switch to `Secure`.

## Access control

- `REQUIRE_GUILD_MEMBERSHIP=true` (default) → only members of `DISCORD_GUILD_ID`
  can log in.
- Admins = anyone whose id is in `ADMIN_USER_IDS`, **or** who holds `ADMIN_ROLE_ID`.
  Non-admins can't see the Admin tab or hit admin APIs (`403`).

## Configuration reference

| Var | Default | Notes |
|-----|---------|-------|
| `WEB_PORT` / `WEB_HOST` | `8080` / `0.0.0.0` | listen address |
| `WEB_PUBLIC_URL` | `http://localhost:8080` | drives OAuth redirect + cookie `Secure` |
| `SESSION_SECRET` | *(ephemeral)* | **set this**; signs session cookies |
| `OAUTH_REDIRECT_URI` | `${WEB_PUBLIC_URL}/auth/callback` | must be registered in Discord |
| `REQUIRE_GUILD_MEMBERSHIP` | `true` | gate to guild members |
| `ADMIN_USER_IDS` / `ADMIN_ROLE_ID` | — | who gets admin |
| `BOT_HEALTHZ_URL` | `http://127.0.0.1:${HEALTHZ_PORT}/healthz` | inherited port |
| `BOT_DB_PATH` | `../data/bot.db` | read-only source |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / auto | pino |

Inherited from `../.env`: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
`DISCORD_GUILD_ID`, `HEALTHZ_PORT`.

## Endpoints

- `GET /livez` — dashboard liveness (no auth).
- `GET /login`, `/auth/login`, `/auth/callback`, `/auth/logout` — auth.
- `GET /api/me | /health | /overview | /activity | /anomalies | /scorecard | /scans` — session required.
- `GET /api/config | /audit | /apis`, `POST /api/apis/:id/test` — admin only.
- `GET /ws` — WebSocket (cookie-authenticated).

## Tests

```bash
npm test        # node --test: cookie signing, avatar urls, time parsing, oauth state
```

## Security notes

- Sessions are server-side rows keyed by a random id inside an **HMAC-signed**
  cookie (`httpOnly`, `sameSite=lax`, `Secure` when the public URL is https).
- OAuth uses a one-time `state` (CSV/CSRF) consumed exactly once.
- helmet sets a strict CSP (scripts/styles are same-origin; images allow the
  Discord CDN). Rate limits guard the API and login.
- The bot DB is opened read-only; secrets are redacted in logs and masked in the
  config view.
