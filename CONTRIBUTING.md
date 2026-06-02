# Contributing

Thanks for being here. This is a small project but the conventions matter — they keep the bot reliable enough to run unattended.

## Setup (5 minutes)

```bash
git clone git@github.com:sudoseba/discord-futures-news-bot.git
cd discord-futures-news-bot
npm install
cp .env.example .env       # fill in DISCORD_TOKEN at minimum
npm run deploy             # registers slash commands with Discord
npm start                  # runs the bot
npm test                   # 48+ tests, should all pass
```

Open `http://localhost:3000/healthz` to verify the bot is up.

## Branch & commit conventions

- One feature / fix per branch — no kitchen-sink PRs.
- Branch naming: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
- Commits use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One commit = one logical change. Rebase locally before pushing if you've made experimental commits.

## What CI will check (when CI exists)

- `npm test` green
- No `.env` or `data/` committed
- No real API keys in code or `.env.example`
- Lint passes (when ESLint is added)

## Code style — the short version

- **No new helper, no new abstraction unless used 3+ times.** Three similar lines is fine. Premature DRY hurts more than it helps in this codebase.
- **Default to no comments.** Only document the WHY when it's non-obvious — a constraint, a workaround, a surprising invariant. Don't document the WHAT (well-named identifiers).
- **Don't add fallback / error handling for things that can't happen.** Trust internal code. Validate at the system boundary (user input, external APIs) only.
- **Structured logging only.** `log.info({ event, count }, 'msg')` not `console.log('[Tag] event=' + e)`.
- **Use the helpers.** `pctChange` not `(a-b)/b*100`. `sendToChannel` not `channel.send`. `cronManager.schedule` not `cron.schedule`. See `AGENTS.md` for the full table.

## Writing tests

- One test file per module: `src/utils/foo.js` → `tests/foo.test.js`.
- Pure logic (TA math, dedup, retry, cooldown) is fully testable — write tests for those.
- Network and LLM calls — mock with `vi.mock` or skip and call out in the PR description.
- A test should fail loudly when the contract breaks. "Returns truthy" tests aren't useful — assert the actual shape/value.

## When you touch a cron

1. Read the cron expression from `process.env.<NAME>_CRON` with a default.
2. Add the env var to `.env.example` with a short comment.
3. Register the job via `cronManager.schedule(name, expr, fn)`. Never call `cron.schedule` directly — the manager adds timezone, re-entry guard, structured logging, and graceful shutdown.

## When you touch the DB schema

1. Append a new migration object to `src/services/database.js` migrations array. Bump the version.
2. Never edit a past migration; it would skip on machines that already ran the old version.
3. If the new table is hot-path, add an index in the same migration.
4. Update `cleanupOldData()` if the table grows unboundedly.

## When you add a new dependency

- Justify it in the PR. "Why not just inline 20 lines?" is a valid reviewer question.
- Avoid native deps (canvas, sharp, ffmpeg) — they inflate the Docker image significantly.
- Prefer well-maintained, sub-100kb packages.

## Reporting a bug

Open an issue with:

1. What you ran (command or scheduled job)
2. What you expected
3. What happened — include a snippet from the logs (the structured JSON output is gold)
4. Bot version (`package.json` version field) and node version

Avoid pasting `.env` contents. The redaction in `logger.js` is your safety net, not your only line of defence.
