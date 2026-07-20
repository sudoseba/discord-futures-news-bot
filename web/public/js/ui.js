// Small DOM + formatting helpers. Anything derived from server data goes through
// text nodes (never innerHTML) so it can't inject markup.

export function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v; // callers pass only trusted/static strings
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

export function clear(node) { node.replaceChildren(); }

export function fmtNum(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString();
}

export function fmtPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function fmtDuration(sec) {
  if (sec == null) return '—';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

export function relTime(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function severityKind(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'critical' || s === 'high' || s === 'crit') return 'crit';
  if (s === 'medium' || s === 'warn') return 'medium';
  if (s === 'info') return 'info';
  return 'low';
}

export function badge(kind, text) {
  return el('span', { class: `badge ${kind}` }, text);
}

export function dot(kind, pulse) {
  return el('span', { class: `dot ${kind || ''} ${pulse ? 'pulse' : ''}` });
}

export function card(titleText, ...body) {
  const c = el('div', { class: 'card card-pad' });
  if (titleText) c.append(el('div', { class: 'card-title' }, titleText));
  c.append(...body);
  return c;
}

export function stat(label, value, sub, accent) {
  return el('div', { class: 'card stat' },
    el('div', { class: 's-label' }, label),
    el('div', { class: 's-value', style: accent ? `color:${accent}` : null }, value),
    sub ? el('div', { class: 's-sub' }, sub) : null,
  );
}

export function table(headers, rows) {
  const thead = el('tr', {}, ...headers.map((h) => el('th', {}, h)));
  const body = rows.map((cells) => el('tr', {}, ...cells.map((c) => (c && c.nodeType ? el('td', {}, c) : el('td', {}, c)))));
  return el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' }, el('thead', {}, thead), el('tbody', {}, ...body)));
}

export function empty(msg) { return el('div', { class: 'empty' }, msg); }

export function spinner() { return el('div', { class: 'empty' }, el('span', { class: 'loading' }), ' loading…'); }

// Numeric sparkline → inline SVG (values are numbers only, so innerHTML is safe).
export function sparkline(values, { w = 120, h = 30, color = '#5b8cff' } = {}) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  const wrap = el('div', { class: 'spark' });
  if (nums.length < 2) { wrap.append(el('span', { class: 'muted', text: '—' })); return wrap; }
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const step = w / (nums.length - 1);
  const pts = nums.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(' ');
  wrap.innerHTML =
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<polyline points="${pts}" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  return wrap;
}
