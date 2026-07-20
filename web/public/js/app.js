// Bootstrap: authenticate, build the shell, wire the router + live WebSocket.
import { getJSON, postJSON } from './api.js';
import { el } from './ui.js';
import { views } from './views.js';
import { workstation } from './workstation.js';
import { createRouter } from './router.js';
import { createWS } from './ws.js';
import { initTheme, themeControl } from './theme.js';

initTheme();

const ALL_VIEWS = { workstation, ...views };

const NAV = [
  { path: '/', label: 'Terminal', icon: '⌘', view: 'workstation' },
  { path: '/overview', label: 'Overview', icon: '▦', view: 'overview' },
  { path: '/activity', label: 'Activity', icon: '⚡', view: 'activity' },
  { path: '/anomalies', label: 'Anomalies', icon: '⚠', view: 'anomalies' },
  { path: '/scorecard', label: 'Scorecard', icon: '✓', view: 'scorecard' },
  { path: '/system', label: 'System', icon: '❤', view: 'system' },
  { path: '/admin', label: 'Admin', icon: '⚙', view: 'admin', admin: true },
];

boot();

async function boot() {
  let me;
  try {
    me = await getJSON('/api/me');
  } catch {
    location.href = '/login';
    return;
  }
  if (!me.authenticated) {
    location.href = '/login';
    return;
  }
  const user = me.user;

  document.getElementById('boot').hidden = true;
  document.getElementById('app').hidden = false;

  buildNav(user);
  buildUserChip(user);
  wireChrome();

  const routes = {};
  for (const n of NAV) {
    if (n.admin && !user.isAdmin) continue;
    routes[n.path] = { title: n.label, render: ALL_VIEWS[n.view] };
  }
  const router = createRouter(routes, onNavigate);

  // Live channel
  createWS(
    (evt) => onLiveEvent(evt, router),
    (status) => setConn(status),
  );

  if (!location.hash) location.hash = '/';
  router.render();
}

function buildNav(user) {
  const nav = document.getElementById('nav');
  nav.replaceChildren();
  for (const n of NAV) {
    if (n.admin && !user.isAdmin) continue;
    nav.append(el('a', { class: 'nav-item', href: `#${n.path}`, 'data-path': n.path },
      el('span', { class: 'nav-ico' }, n.icon),
      el('span', {}, n.label),
    ));
  }
}

function buildUserChip(user) {
  const chip = document.getElementById('userChip');
  chip.replaceChildren(
    el('img', { src: user.avatar, alt: '', width: 28, height: 28 }),
    el('div', {},
      el('div', { class: 'u-name' }, user.globalName || user.username || 'user'),
      el('div', { class: 'u-role' }, user.isAdmin ? 'Admin' : 'Member'),
    ),
  );
}

function wireChrome() {
  // Theme switcher in the topbar (left of the user chip).
  const chip = document.getElementById('userChip');
  chip.parentNode.insertBefore(themeControl(), chip);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await postJSON('/auth/logout'); } catch { /* ignore */ }
    location.href = '/login';
  });
  const sidebar = document.getElementById('sidebar');
  document.getElementById('menuBtn').addEventListener('click', () => sidebar.classList.toggle('open'));
  // Close the mobile drawer when a nav link is tapped.
  document.getElementById('nav').addEventListener('click', () => sidebar.classList.remove('open'));
}

function onNavigate(path, route) {
  document.getElementById('viewTitle').textContent = route.title || 'Dashboard';
  document.title = `${route.title || 'Dashboard'} · News Bot`;
  for (const a of document.querySelectorAll('.nav-item')) {
    a.classList.toggle('active', a.getAttribute('data-path') === path);
  }
}

function onLiveEvent(evt, router) {
  if (evt.type === 'health') {
    updateVersionFoot(evt.data);
  } else if (evt.type === 'anomaly' && evt.item) {
    toast(evt.item.title, String(evt.item.type || '').replace(/_/g, ' '), severityToKind(evt.item.severity));
  }
  router.live(evt);
}

let lastVersion = null;
function updateVersionFoot(data) {
  if (data && data.version && data.version !== lastVersion) {
    lastVersion = data.version;
    document.getElementById('verFoot').textContent = `bot v${data.version}`;
  }
}

// ── connection indicator ─────────────────────────────────────────────────────
function setConn(status) {
  const dot = document.getElementById('connDot');
  const text = document.getElementById('connText');
  const map = {
    live: ['ok pulse', 'live'],
    connecting: ['warn', 'connecting…'],
    offline: ['crit', 'reconnecting…'],
  };
  const [cls, label] = map[status] || ['', status];
  dot.className = `dot ${cls}`;
  text.textContent = label;
}

// ── toasts ───────────────────────────────────────────────────────────────────
function toast(title, body, kind = '') {
  const wrap = document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind}` },
    el('div', { class: 't-title' }, title || 'Alert'),
    body ? el('div', { class: 't-body' }, body) : null,
  );
  wrap.append(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 6000);
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
}
function severityToKind(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'high') return 'crit';
  if (s === 'medium') return 'warn';
  return '';
}
