// View builders. Each returns { el, live? } where `live(evt)` patches the DOM
// from a WebSocket event. All server-derived strings go through text nodes.
import { getJSON, postJSON } from './api.js';
import {
  el, card, stat, table, badge, dot, empty, sparkline,
  fmtNum, fmtPct, fmtDuration, relTime, severityKind,
} from './ui.js';

const FEED_ICONS = { anomaly: '⚠️', ai: '🧠', delivery: '📮', signal: '📈' };
function feedIcon(type) { return FEED_ICONS[type] || '•'; }

function feedItem(item) {
  return el('div', { class: 'feed-item', 'data-key': item.key || '' },
    el('div', { class: 'feed-ico' }, feedIcon(item.type)),
    el('div', {},
      el('div', { class: 'feed-title' }, item.title || '—'),
      item.detail ? el('div', { class: 'feed-detail' }, item.detail) : null,
    ),
    el('div', { class: 'feed-time', title: item.ts ? new Date(item.ts).toLocaleString() : '' }, relTime(item.ts)),
  );
}

function healthEmoji(status, ok) {
  if (!ok) return '🔴';
  return status === 'ok' ? '🟢' : '🟡';
}

// ── Overview ────────────────────────────────────────────────────────────────
async function overview() {
  const [health, ov, act] = await Promise.all([
    getJSON('/api/health'),
    getJSON('/api/overview'),
    getJSON('/api/activity?limit=12'),
  ]);

  const refs = {};
  const root = el('div', {});

  if (!health.ok) {
    root.append(el('div', { class: 'banner crit' },
      'The bot is not responding on its health endpoint — it may be stopped. ',
      health.error ? `(${health.error})` : ''));
  } else if (!health.botDb) {
    root.append(el('div', { class: 'banner' }, 'Bot database not found yet — stats will populate once the bot has run.'));
  }

  // Health hero
  const d = health.data || {};
  const heroItems = [
    ['Status', el('span', {}, badge(d.status === 'ok' ? 'ok' : 'warn', d.status || (health.ok ? '—' : 'down')))],
    ['Uptime', fmtDuration(d.uptimeSec), 'uptime'],
    ['Discord', d.discordReady ? badge('ok', 'ready') : badge('warn', 'connecting'), 'discord'],
    ['Database', d.dbOk ? badge('ok', 'ok') : badge('crit', 'error'), 'db'],
    ['Memory', d.memoryRssMb != null ? `${d.memoryRssMb} MB` : '—', 'mem'],
    ['Cron jobs', d.cronJobs ? [].concat(d.cronJobs).length : 0, 'cron'],
    ['Version', d.version || '—'],
  ];
  const heroGrid = el('div', { class: 'hero-grid' });
  refs.hero = {};
  for (const [label, value, key] of heroItems) {
    const v = el('div', { class: 'h-v' }, value);
    if (key) refs.hero[key] = v;
    heroGrid.append(el('div', { class: 'hero-item' }, el('div', { class: 'h-l' }, label), v));
  }
  refs.heroBadge = el('div', { class: 'hero-badge' }, healthEmoji(d.status, health.ok));
  root.append(el('div', { class: 'card hero section' }, refs.heroBadge, heroGrid));

  // Stat grid
  const o = ov.available ? ov : {};
  const statGrid = el('div', { class: 'grid grid-stats section' });
  const cards = [
    ['DM subscribers', o.subscribers, null],
    ['Anomalies · 24h', o.anomalies24h, `${fmtNum(o.anomalies7d)} in 7d`],
    ['AI outputs · 24h', o.llm24h, null],
    ['News · 24h', o.articles24h, null],
    ['Snapshots · 24h', o.snapshots24h, null],
    ['Pending posts', o.pendingPosts, o.pendingPosts ? 'in dead-letter queue' : 'queue clear'],
    ['Unresolved signals', o.unresolvedSignals, 'awaiting scorecard'],
    ['Last scan', o.lastScan ? relTime(o.lastScan.at) : '—', o.lastScan ? `${o.lastScan.detected} detected` : null],
  ];
  refs.stats = {};
  for (const [label, value, sub] of cards) {
    const node = stat(label, value == null ? '—' : (typeof value === 'number' ? fmtNum(value) : value), sub);
    refs.stats[label] = node.querySelector('.s-value');
    statGrid.append(node);
  }
  root.append(statGrid);

  // Recent activity
  const feed = el('div', { class: 'feed' });
  if (act.items.length === 0) feed.append(empty('No recent activity.'));
  else act.items.forEach((it) => feed.append(feedItem(it)));
  refs.feed = feed;
  root.append(card('Recent activity', feed));

  return {
    el: root,
    live(evt) {
      if (evt.type === 'health') {
        const hd = evt.data || {};
        refs.heroBadge.textContent = healthEmoji(hd.status, evt.ok);
        if (refs.hero.uptime) refs.hero.uptime.textContent = fmtDuration(hd.uptimeSec);
        if (refs.hero.mem) refs.hero.mem.textContent = hd.memoryRssMb != null ? `${hd.memoryRssMb} MB` : '—';
      } else if (evt.type === 'anomaly' && evt.item) {
        prependFeed(refs.feed, feedItem({
          key: `anomaly:${evt.item.id}`, type: 'anomaly', severity: evt.item.severity,
          title: evt.item.title, detail: String(evt.item.type || '').replace(/_/g, ' '), ts: evt.item.ts,
        }));
        bump(refs.stats['Anomalies · 24h']);
      } else if (evt.type === 'ai' && evt.item) {
        prependFeed(refs.feed, feedItem({
          key: `llm:${evt.item.id}`, type: 'ai', severity: 'info',
          title: `${cap(evt.item.outputType)}${evt.item.symbol ? ' · ' + evt.item.symbol : ''} generated`,
          detail: evt.item.model || 'llm', ts: evt.item.ts,
        }));
        bump(refs.stats['AI outputs · 24h']);
      }
    },
  };
}

// ── Activity ────────────────────────────────────────────────────────────────
async function activity() {
  const { items } = await getJSON('/api/activity?limit=80');
  const feed = el('div', { class: 'feed' });
  if (items.length === 0) feed.append(empty('No recent activity.'));
  else items.forEach((it) => feed.append(feedItem(it)));
  const root = card('Live activity feed', feed);
  return {
    el: root,
    live(evt) {
      if (evt.type === 'anomaly' && evt.item) {
        prependFeed(feed, feedItem({ key: `anomaly:${evt.item.id}`, type: 'anomaly', severity: evt.item.severity, title: evt.item.title, detail: String(evt.item.type || '').replace(/_/g, ' '), ts: evt.item.ts }), 80);
      } else if (evt.type === 'ai' && evt.item) {
        prependFeed(feed, feedItem({ key: `llm:${evt.item.id}`, type: 'ai', severity: 'info', title: `${cap(evt.item.outputType)}${evt.item.symbol ? ' · ' + evt.item.symbol : ''} generated`, detail: evt.item.model || 'llm', ts: evt.item.ts }), 80);
      }
    },
  };
}

// ── Anomalies ───────────────────────────────────────────────────────────────
async function anomalies() {
  const data = await getJSON('/api/anomalies?limit=80&days=7');
  const root = el('div', {});

  const breakdownRows = data.breakdown.map((b) => [
    el('span', { class: 'mono' }, String(b.anomaly_type).replace(/_/g, ' ')),
    badge(severityKind(b.severity), b.severity),
    el('span', { class: 'num' }, fmtNum(b.count)),
    el('span', { class: 'num muted' }, fmtNum(b.posted)),
    el('span', { class: 'muted' }, relTime(b.last_seen)),
  ]);
  root.append(el('div', { class: 'section' },
    card('Breakdown · last 7 days',
      breakdownRows.length ? table(['Type', 'Severity', 'Count', 'Posted', 'Last seen'], breakdownRows) : empty('No anomalies in the last 7 days.'),
    ),
  ));

  const rows = data.items.map((a) => [
    badge(severityKind(a.severity), a.severity),
    el('span', {}, a.title),
    el('span', { class: 'mono muted' }, String(a.type).replace(/_/g, ' ')),
    a.posted ? badge('ok', 'posted') : badge('low', 'held'),
    el('span', { class: 'muted', title: a.ts ? new Date(a.ts).toLocaleString() : '' }, relTime(a.ts)),
  ]);
  root.append(card('Recent anomalies',
    rows.length ? table(['Severity', 'Title', 'Type', 'Posted', 'When'], rows) : empty('No anomalies recorded yet.'),
  ));

  return { el: root };
}

// ── Scorecard ───────────────────────────────────────────────────────────────
async function scorecard() {
  const { rows } = await getJSON('/api/scorecard?days=30');
  const trs = rows.map((r) => [
    el('span', { class: 'mono' }, String(r.signalType).replace(/_/g, ' ')),
    badge(r.direction === 'bullish' ? 'pos' : 'neg', r.direction),
    el('span', { class: 'num' }, fmtNum(r.total)),
    el('span', { class: 'num muted' }, fmtNum(r.resolved)),
    r.winRate24h == null ? el('span', { class: 'muted' }, '—') : badge(r.winRate24h >= 50 ? 'pos' : 'neg', `${r.winRate24h}%`),
    pnlCell(r.avg1h), pnlCell(r.avg4h), pnlCell(r.avg24h),
  ]);
  const root = card('Signal scorecard · last 30 days',
    el('p', { class: 'dim', style: 'margin-top:-4px' }, 'Replayed outcome of each fired signal — win rate and average P&L at 1h / 4h / 24h.'),
    trs.length ? table(['Signal', 'Dir', 'Fired', 'Resolved', 'Win% 24h', 'Avg 1h', 'Avg 4h', 'Avg 24h'], trs) : empty('No resolved signals yet — the scorecard fills in as alerts fire and get graded.'),
  );
  return { el: root };
}
function pnlCell(v) {
  if (v == null) return el('span', { class: 'muted' }, '—');
  return el('span', { class: `num ${v > 0 ? 'pos-txt' : v < 0 ? 'neg-txt' : ''}` }, fmtPct(v));
}

// ── System ──────────────────────────────────────────────────────────────────
async function system() {
  const [health, scans] = await Promise.all([getJSON('/api/health?force=1'), getJSON('/api/scans?limit=30')]);
  const d = health.data || {};
  const root = el('div', {});

  const detail = el('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(160px,1fr))' });
  const kv = (k, v) => detail.append(el('div', { class: 'hero-item' }, el('div', { class: 'h-l' }, k), el('div', { class: 'h-v' }, v)));
  kv('Status', badge(health.ok ? (d.status === 'ok' ? 'ok' : 'warn') : 'crit', health.ok ? (d.status || 'up') : 'down'));
  kv('Uptime', fmtDuration(d.uptimeSec));
  kv('Discord', d.discordReady ? badge('ok', 'ready') : badge('warn', 'no'));
  kv('DB', d.dbOk ? badge('ok', 'ok') : badge('crit', 'no'));
  kv('Memory', d.memoryRssMb != null ? `${d.memoryRssMb} MB` : '—');
  kv('PID', d.pid != null ? String(d.pid) : '—');
  kv('Version', d.version || '—');
  kv('Bot DB file', health.botDb ? badge('ok', 'connected') : badge('warn', 'missing'));
  root.append(el('div', { class: 'section' }, card('Bot health', detail)));

  const jobs = [].concat(d.cronJobs || []);
  const jobRows = jobs.map((j) => (typeof j === 'string'
    ? [el('span', { class: 'mono' }, j), el('span', { class: 'muted' }, '—')]
    : [el('span', { class: 'mono' }, j.name || j.key || '—'), el('span', { class: 'muted' }, j.running ? badge('ok', 'running') : (j.nextRun || '—'))]));
  root.append(el('div', { class: 'section' }, card(`Scheduled jobs (${jobs.length})`,
    jobRows.length ? table(['Job', 'State / next'], jobRows) : empty('No cron jobs reported.'),
  )));

  const detected = scans.items.map((s) => s.detected);
  root.append(card('Anomaly scan cadence',
    el('div', { class: 'row', style: 'align-items:center;gap:18px' },
      sparkline(detected, { w: 220, h: 40 }),
      el('div', { class: 'dim' }, `${scans.items.length} recent scans · ${fmtNum(detected.reduce((a, b) => a + b, 0))} anomalies detected`),
    ),
  ));
  return { el: root };
}

// ── Admin ───────────────────────────────────────────────────────────────────
async function admin() {
  let cfg, apis, audit, prov;
  try {
    [cfg, apis, audit] = await Promise.all([getJSON('/api/config'), getJSON('/api/apis'), getJSON('/api/audit?limit=40')]);
    prov = await getJSON('/api/providers').catch(() => ({ providers: [] }));
  } catch (e) {
    if (e.status === 403) return { el: el('div', { class: 'banner crit' }, "Admin only — your account isn't configured as an admin.") };
    throw e;
  }
  const root = el('div', {});

  // API tests
  const testWrap = el('div', {});
  apis.catalog.forEach((a) => {
    const result = el('span', { class: 'muted' }, a.kind === 'free' ? 'no key needed' : '');
    const btn = el('button', { class: 'btn btn-sm', onclick: async () => {
      btn.disabled = true; result.replaceChildren(el('span', { class: 'loading' }));
      try {
        const r = await postJSON(`/api/apis/${a.id}/test`);
        result.replaceChildren(badge(r.ok ? 'ok' : 'crit', r.ok ? 'OK' : 'FAIL'), el('span', { class: 'muted', style: 'margin-left:8px' }, `${r.msg} (${r.ms}ms)`));
      } catch (err) {
        result.replaceChildren(badge('crit', 'ERROR'), el('span', { class: 'muted', style: 'margin-left:8px' }, err.message));
      } finally { btn.disabled = false; }
    } }, 'Test');
    testWrap.append(el('div', { class: 'feed-item' },
      el('div', { class: 'feed-ico' }, a.kind === 'free' ? '🌐' : '🔑'),
      el('div', {}, el('div', { class: 'feed-title' }, a.name), el('div', { class: 'feed-detail' }, result)),
      btn,
    ));
  });
  root.append(el('div', { class: 'section' }, card('API connectivity tests', testWrap)));

  // Data provider health (circuit breakers)
  const provRows = (prov?.providers || []).map((p) => [
    el('span', { class: 'mono' }, p.name),
    badge(p.state === 'closed' ? 'ok' : p.state === 'open' ? 'crit' : 'warn', p.state),
    el('span', { class: 'num' }, `${p.ok}/${p.ok + p.err}`),
    el('span', { class: 'muted', title: p.lastErrMsg || '' }, (p.lastErrMsg || '').slice(0, 60)),
  ]);
  root.append(el('div', { class: 'section' }, card('Data provider health (circuit breakers)',
    provRows.length ? table(['Provider', 'State', 'OK/total', 'Last error'], provRows)
      : empty('No provider calls recorded yet — run a command (e.g. quote gold) to populate.'),
  )));

  // Bot config (masked)
  const cfgWrap = el('div', {});
  cfg.categories.forEach((c) => {
    cfgWrap.append(el('div', { class: 'card-title', style: 'margin-top:14px' }, c.name));
    const rows = c.items.map((it) => [
      el('span', {}, it.label),
      it.secret
        ? badge(it.set ? 'ok' : 'low', it.hint)
        : el('span', { class: 'mono' + (it.isDefault ? ' muted' : '') }, (it.value || '—') + (it.isDefault ? '  (default)' : '')),
    ]);
    cfgWrap.append(table(['Setting', 'Value'], rows));
  });
  root.append(el('div', { class: 'section' }, card('Bot configuration (read-only)', cfgWrap)));

  // Audit log
  const arows = audit.items.map((a) => [
    el('span', { class: 'muted', title: new Date(a.ts).toLocaleString() }, relTime(a.ts)),
    el('span', { class: 'mono' }, a.action),
    el('span', {}, a.username || a.userId || '—'),
    el('span', { class: 'muted' }, a.detail || ''),
  ]);
  root.append(card('Access audit log',
    arows.length ? table(['When', 'Action', 'User', 'Detail'], arows) : empty('No audit entries yet.'),
  ));

  return { el: root };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function prependFeed(feed, node, cap = 40) {
  const first = feed.querySelector('.empty');
  if (first) first.remove();
  node.classList.add('flash');
  feed.prepend(node);
  while (feed.children.length > cap) feed.lastElementChild.remove();
}
function bump(valueEl) {
  if (!valueEl) return;
  const n = parseInt(String(valueEl.textContent).replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(n)) valueEl.textContent = fmtNum(n + 1);
}
function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

export const views = { overview, activity, anomalies, scorecard, system, admin };
