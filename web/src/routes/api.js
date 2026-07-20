'use strict';
/** JSON API. `/api/me` is open; everything else requires a session; a few are admin-only. */
const express = require('express');
const config = require('../config');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { testLimiter, consoleLimiter } = require('../middleware/security');
const { avatarUrl } = require('../auth/discord');
const { botAvailable } = require('../db');
const health = require('../services/health');
const stats = require('../services/stats');
const activity = require('../services/activity');
const apiTests = require('../services/apiTests');
const configView = require('../services/configView');
const bridge = require('../services/botBridge');
const consoleSvc = require('../services/console');

const router = express.Router();

// Who am I? (SPA calls this on load; safe when unauthenticated.)
router.get('/me', (req, res) => {
  if (!req.user) return res.json({ authenticated: false, authConfigured: config.authConfigured, devAuth: config.devAuth, authMethods: { discord: config.discordLoginEnabled, password: config.passwordAuthEnabled } });
  res.json({ authenticated: true, authConfigured: config.authConfigured, user: publicUser(req.user) });
});

// Live bot health (any logged-in user).
router.get('/health', requireAuth, async (req, res) => {
  const h = await health.getHealth(req.query.force === '1');
  res.json({ ok: h.ok, status: h.status, error: h.error, data: h.data, botDb: botAvailable(), fetchedAt: h.at });
});

router.get('/overview', requireAuth, (_req, res) => res.json(stats.getOverview()));
router.get('/activity', requireAuth, (req, res) =>
  res.json({ items: activity.getActivity(clampInt(req.query.limit, 40, 1, 100)) }),
);
router.get('/anomalies', requireAuth, (req, res) =>
  res.json({
    items: stats.getRecentAnomalies(clampInt(req.query.limit, 50, 1, 200)),
    breakdown: stats.getAnomalyBreakdown(clampInt(req.query.days, 7, 1, 90)),
  }),
);
router.get('/scorecard', requireAuth, (req, res) =>
  res.json({ rows: stats.getScorecard(clampInt(req.query.days, 30, 1, 365)) }),
);
router.get('/scans', requireAuth, (req, res) =>
  res.json({ items: stats.getScanHistory(clampInt(req.query.limit, 30, 1, 100)) }),
);

// ─── workstation: command console ───────────────────────────────────────────
router.get('/console/commands', requireAuth, (_req, res) => res.json(consoleSvc.catalog()));
router.post('/console', requireAuth, consoleLimiter, async (req, res) => {
  const line = typeof req.body?.line === 'string' ? req.body.line : '';
  if (line.length > 500) return res.status(400).json({ ok: false, type: 'error', data: 'command too long' });
  res.json(await consoleSvc.dispatch(line));
});

router.get('/chart', requireAuth, async (req, res) => {
  try {
    const data = await bridge.chartData(req.query.symbol, { weekly: req.query.weekly === '1' });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ─── workstation: live market rails ─────────────────────────────────────────
router.get('/market/snapshot', requireAuth, async (_req, res) => {
  const [macro, fearGreed, funding] = await Promise.all([
    safe(() => bridge.macro()), safe(() => bridge.fearGreed()), safe(() => bridge.funding()),
  ]);
  res.json({ available: bridge.available, ai: bridge.aiAvailable(), macro, fearGreed, funding, ts: Date.now() });
});
router.get('/market/quotes', requireAuth, async (_req, res) => {
  let items = [];
  try {
    const q = await bridge.allQuotes();
    items = Object.entries(q).map(([symbol, v]) => ({ symbol, name: v.name, emoji: v.emoji, category: v.category, quote: v.quote || null }));
  } catch { /* bridge unavailable */ }
  res.json({ available: bridge.available, items, ts: Date.now() });
});
router.get('/symbols', requireAuth, (_req, res) => {
  let list = [];
  try { list = bridge.symbols(); } catch { /* unavailable */ }
  res.json({ available: bridge.available, symbols: list });
});
router.get('/market/news', requireAuth, async (_req, res) => {
  let items = [];
  try {
    const arr = await bridge.news('all', false);
    items = (arr || []).slice(0, 24).map((n) => ({ headline: n.headline, source: n.source, url: n.url, category: n.category, tier: n.tier, timestamp: n.timestamp }));
  } catch { /* unavailable */ }
  res.json({ available: bridge.available, items, ts: Date.now() });
});

// ─── admin only ─────────────────────────────────────────────────────────────
router.get('/config', requireAdmin, (_req, res) => res.json(configView.getConfig()));
router.get('/audit', requireAdmin, (req, res) =>
  res.json({ items: configView.getAudit(clampInt(req.query.limit, 50, 1, 200)) }),
);
router.get('/apis', requireAdmin, (_req, res) => res.json({ catalog: apiTests.listCatalog() }));
router.get('/providers', requireAdmin, (_req, res) => res.json({ providers: bridge.providerHealth() }));
router.post('/apis/:id/test', requireAdmin, testLimiter, async (req, res) => {
  if (!apiTests.CATALOG.find((a) => a.id === req.params.id)) return res.status(404).json({ error: 'unknown api' });
  res.json(await apiTests.runTest(req.params.id));
});

function publicUser(u) {
  return {
    id: u.userId,
    username: u.username,
    globalName: u.globalName,
    avatar: avatarUrl(u.userId, u.avatar),
    isAdmin: u.isAdmin,
    isMember: u.isMember,
  };
}
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
async function safe(fn) { try { return await fn(); } catch { return null; } }

module.exports = router;
