// The trade workstation: a persistent chart panel + command terminal, with live
// market rails (sentiment gauge, watchlist heatmap, movers).
import { getJSON, postJSON } from './api.js';
import { el, card, table, badge, empty, spinner, fmtNum, relTime } from './ui.js';
import { candleChart, gauge } from './charts.js';

const QUICK = [
  ['pulse', 'Pulse'], ['macro', 'Macro'], ['news', 'News'],
  ['brief', 'AI Brief'], ['calendar', 'Calendar'], ['help', 'Help'],
];
const DEFAULT_SYMBOL = 'gold';

export function workstation() {
  const timers = [];
  const st = { history: [], hidx: -1, names: [], chartSymbol: null };

  // ── chart panel ──
  const chartHead = el('div', { class: 'cp-head' }, el('span', { class: 'muted' }, 'chart'));
  const symBar = el('div', { class: 'sym-bar' });
  const chartBody = el('div', { class: 'cp-body' }, spinner());
  const chartPanel = el('div', { class: 'card chart-panel' }, chartHead, symBar, chartBody);

  // ── terminal ──
  const logEl = el('div', { class: 'term-log' });
  const input = el('input', {
    class: 'term-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
    placeholder: 'chart gold · quote btc · analyze cl · verdict gold · ai <question> · help',
  });
  const hint = el('div', { class: 'term-hint' }, 'loading…');
  const terminal = el('div', { class: 'card term' },
    el('div', { class: 'term-head' },
      el('span', { class: 'term-dot-r' }), el('span', { class: 'term-title' }, 'console'),
      el('div', { class: 'term-quick' }, ...QUICK.map(([cmd, label]) => el('button', { class: 'chip term-chip', onclick: () => run(cmd) }, label))),
    ),
    logEl,
    el('div', { class: 'term-inputrow' }, el('span', { class: 'term-caret' }, '›'), input),
    hint,
  );

  // ── rails ──
  const gaugeHost = el('div', { class: 'gauge-host' }, spinner());
  const heatHost = el('div', {}, spinner());
  const moversHost = el('div', {}, spinner());
  const strip = el('div', { class: 'ws-strip' }, spinner());

  const ticker = el('div', { class: 'ticker' }, el('div', { class: 'ticker-track' }, el('span', { class: 'muted' }, 'loading headlines…')));

  const root = el('div', { class: 'ws' },
    strip,
    el('div', { class: 'ws-grid' },
      el('div', { class: 'ws-col-main' }, chartPanel, terminal),
      el('div', { class: 'ws-col-rail' },
        panel('Sentiment', gaugeHost),
        panel('Watchlist', heatHost),
        panel('Movers', moversHost),
      ),
    ),
    ticker,
  );

  // ── input handlers ──
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const v = input.value; input.value = ''; run(v); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); histNav(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); histNav(1); }
    else if (e.key === 'Tab') { e.preventDefault(); autocomplete(); }
  });
  function histNav(dir) {
    if (!st.history.length) return;
    st.hidx = Math.max(0, Math.min(st.history.length, st.hidx + dir));
    input.value = st.history[st.hidx] || '';
    queueMicrotask(() => input.setSelectionRange(input.value.length, input.value.length));
  }
  function autocomplete() {
    const cur = input.value.trim().toLowerCase();
    if (!cur) return;
    const m = st.names.filter((n) => n.startsWith(cur));
    if (m.length === 1) input.value = m[0] + ' ';
    else if (m.length > 1) printLine(el('span', { class: 'muted' }, m.join('  ')));
  }

  async function run(line) {
    line = String(line || '').trim();
    if (!line) return;
    st.history.push(line); st.hidx = st.history.length;
    if (line === 'clear' || line === 'cls') { logEl.replaceChildren(); return; }
    const out = el('div', { class: 'term-out' }, spinner());
    logEl.append(el('div', { class: 'term-entry' },
      el('div', { class: 'term-cmd' }, el('span', { class: 'term-caret' }, '›'), el('span', {}, line)), out));
    scroll();
    try {
      const res = await postJSON('/api/console', { line });
      if (res.ok && res.type === 'chart') { renderChartInto(res.data); out.replaceChildren(chartInline(res.data)); }
      else out.replaceChildren(renderResult(res));
    } catch (e) {
      out.replaceChildren(el('div', { class: 'term-err' }, e.message || 'request failed'));
    }
    scroll(); input.focus();
  }
  function printLine(node) { logEl.append(el('div', { class: 'term-entry' }, node)); scroll(); }
  function scroll() { logEl.scrollTop = logEl.scrollHeight; }

  // ── chart panel control ──
  async function loadChart(symbol, weekly = false) {
    chartBody.replaceChildren(spinner());
    try {
      const d = await getJSON(`/api/chart?symbol=${encodeURIComponent(symbol)}${weekly ? '&weekly=1' : ''}`);
      if (d.ok === false) throw new Error(d.error || 'chart failed');
      renderChartInto(d);
    } catch (e) {
      chartHead.replaceChildren(el('span', { class: 'muted' }, 'chart'));
      chartBody.replaceChildren(el('div', { class: 'term-err' }, e.message));
    }
  }
  function renderChartInto(d) {
    st.chartSymbol = d.symbol;
    chartHead.replaceChildren(...chartHeadNodes(d));
    chartBody.replaceChildren(candleChart(d.candles, { levels: d.levels }));
    markActive();
    try { localStorage.setItem('ws-sym', d.symbol); localStorage.setItem('ws-tf', d.timeframe || 'D'); } catch { /* ignore */ }
  }
  function markActive() {
    for (const b of symBar.querySelectorAll('.sym-chip')) b.classList.toggle('on', b.getAttribute('data-sym') === st.chartSymbol);
  }
  function chartHeadNodes(d) {
    const q = d.quote || {};
    const tf = (label, wk) => el('button', { class: 'chip tf' + ((wk ? 'W' : 'D') === d.timeframe ? ' on' : ''), onclick: () => loadChart(d.symbol, wk) }, label);
    return [
      el('div', { class: 'cp-title' },
        el('span', { class: 'cp-name' }, `${d.meta?.emoji || ''} ${d.meta?.name || d.symbol}`),
        el('span', { class: 'cp-price' }, price(q.current)),
        el('span', { class: 'cp-chg ' + chgClass(q.changePercent) }, pct(q.changePercent)),
      ),
      el('div', { class: 'cp-actions' }, tf('1D', false), tf('1W', true),
        el('button', { class: 'chip', onclick: () => run('analyze ' + skey(d.symbol)) }, 'Analyze'),
        el('button', { class: 'chip', onclick: () => run('verdict ' + skey(d.symbol)) }, 'Verdict')),
    ];
  }

  // ── boot ──
  getJSON('/api/console/commands').then((cat) => {
    st.names = cat.commands.flatMap((c) => [c.name, ...(c.aliases || [])]);
    hint.replaceChildren(
      el('span', {}, `${cat.commands.length} commands · Tab completes · ↑↓ history · `),
      cat.bridge.ai ? badge('ok', 'AI ready') : badge('warn', 'AI off'),
    );
    printLine(el('span', { class: 'muted' }, 'Type '), el('span', { class: 'kbd' }, 'help'), el('span', { class: 'muted' }, ' — try '), el('span', { class: 'kbd' }, 'chart gold'), el('span', { class: 'muted' }, ' or '), el('span', { class: 'kbd' }, 'verdict btc'));
  }).catch(() => { hint.textContent = 'command list unavailable'; });

  // symbol bar
  getJSON('/api/symbols').then(({ symbols }) => {
    symBar.replaceChildren(...(symbols || []).map((s) => el('button', { class: 'sym-chip', 'data-sym': s.key, title: s.name, onclick: () => loadChart(s.key) }, `${s.emoji || ''} ${skey(s.key)}`)));
    markActive();
  }).catch(() => symBar.remove());

  let savedSym = DEFAULT_SYMBOL, savedTf = false;
  try { savedSym = localStorage.getItem('ws-sym') || DEFAULT_SYMBOL; savedTf = localStorage.getItem('ws-tf') === 'W'; } catch { /* ignore */ }
  loadChart(savedSym, savedTf);

  refreshTop(); refreshBoard(); refreshTicker();
  timers.push(setInterval(refreshTop, 20000));
  timers.push(setInterval(refreshBoard, 30000));
  timers.push(setInterval(refreshTicker, 90000));

  // "/" focuses the console (unless already typing somewhere)
  const keyHandler = (e) => {
    if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); input.focus(); }
  };
  document.addEventListener('keydown', keyHandler);
  setTimeout(() => input.focus(), 60);

  async function refreshTicker() {
    try {
      const { items } = await getJSON('/api/market/news');
      const track = ticker.querySelector('.ticker-track');
      if (!items || !items.length) { track.replaceChildren(el('span', { class: 'muted' }, 'no headlines')); return; }
      const make = () => items.map((n) => el('span', { class: 'ticker-item' },
        el('span', { class: 'ticker-cat' }, (n.category || 'news')),
        n.url ? el('a', { href: n.url, target: '_blank', rel: 'noopener' }, n.headline) : el('span', {}, n.headline)));
      track.replaceChildren(...make(), ...make()); // duplicate for seamless loop
    } catch { /* ignore */ }
  }

  async function refreshTop() {
    try {
      const s = await getJSON('/api/market/snapshot');
      strip.replaceChildren(...stripTiles(s));
      gaugeHost.replaceChildren(s.fearGreed ? gauge(s.fearGreed.value, { label: s.fearGreed.label }) : empty('n/a'));
    } catch { strip.replaceChildren(el('span', { class: 'muted' }, 'market strip unavailable')); }
  }
  async function refreshBoard() {
    try {
      const { items } = await getJSON('/api/market/quotes');
      const q = items.filter((i) => i.quote);
      heatHost.replaceChildren(heatmap(q, loadChart));
      moversHost.replaceChildren(moversList(q));
    } catch { heatHost.replaceChildren(empty('unavailable')); }
  }

  return {
    el: root,
    dispose() {
      timers.forEach(clearInterval);
      document.removeEventListener('keydown', keyHandler);
    },
  };
}

function panel(title, host) { return el('div', { class: 'card card-pad' }, el('div', { class: 'card-title' }, title), host); }
function chartInline(d) {
  return el('div', {}, el('div', { class: 'muted', style: 'margin-bottom:6px' }, `${d.meta?.name || d.symbol} · ${d.timeframe}`), candleChart(d.candles, { levels: d.levels, height: 280 }));
}

// ── rails renderers ──────────────────────────────────────────────────────────
function stripTiles(s) {
  const tiles = [];
  const m = s.macro || {};
  for (const [k, label] of [['dxy', 'DXY'], ['tnx', 'US 10Y'], ['vix', 'VIX']]) {
    const v = m[k];
    if (v) tiles.push(stripTile(label, price(v.price), v.changePercent));
  }
  (s.funding || []).slice(0, 2).forEach((f) => tiles.push(stripTile(`${f.symbol} fund`, `${fnum(f.ratePercent ?? f.rate * 100, 4)}%`, f.rate)));
  if (!tiles.length) tiles.push(el('span', { class: 'muted' }, 'market data unavailable'));
  return tiles;
}
function stripTile(label, value, chg) {
  return el('div', { class: 'strip-tile' },
    el('div', { class: 'strip-label' }, label),
    el('div', { class: 'strip-val' }, value, chg != null ? el('span', { class: 'strip-chg ' + chgClass(chg) }, pct(chg)) : null),
  );
}
function heatmap(items, onPick) {
  const wrap = el('div', { class: 'heat' });
  for (const i of items) {
    const chg = i.quote.changePercent || 0;
    const t = Math.max(-3, Math.min(3, chg)) / 3;
    const bg = t >= 0 ? `rgba(63,185,80,${(0.08 + 0.30 * t).toFixed(3)})` : `rgba(248,81,73,${(0.08 + 0.30 * -t).toFixed(3)})`;
    wrap.append(el('div', { class: 'heat-tile', style: `background:${bg}`, title: i.name, onclick: () => onPick(i.symbol) },
      el('div', { class: 'heat-sym' }, sname(i)),
      el('div', { class: 'heat-px num' }, price(i.quote.current)),
      el('div', { class: 'heat-chg num ' + chgClass(chg) }, pct(chg)),
    ));
  }
  return wrap;
}
function moversList(items) {
  const rows = items.slice().sort((a, b) => Math.abs(b.quote.changePercent || 0) - Math.abs(a.quote.changePercent || 0)).slice(0, 6);
  return table(['Symbol', 'Last', 'Chg'], rows.map((r) => [
    el('span', {}, sname(r)), el('span', { class: 'num' }, price(r.quote.current)), el('span', { class: 'num ' + chgClass(r.quote.changePercent) }, pct(r.quote.changePercent)),
  ]));
}

// ── result renderers (by type) ───────────────────────────────────────────────
function renderResult(res) {
  if (!res || res.ok === false) return el('div', { class: 'term-err' }, (res && res.data) || 'error');
  const d = res.data;
  switch (res.type) {
    case 'text': return el('div', { class: 'term-text' }, d || '');
    case 'help': return renderHelp(d);
    case 'symbols': return renderSymbols(d);
    case 'quote': return renderQuote(d);
    case 'quotes': return quoteTable(d);
    case 'macro': return renderMacro(d);
    case 'fear': return renderFear(d);
    case 'funding': return renderFunding(d);
    case 'news': return renderNews(d);
    case 'calendar': return renderCalendar(d);
    case 'cot': return renderCot(d);
    case 'analysis': return renderAnalysis(d);
    case 'levels': return renderLevels(d);
    case 'pulse': return renderPulse(d);
    case 'verdict': return renderVerdict(d);
    case 'brief': return renderBrief(d);
    case 'ai': return renderAI(d);
    case 'chart': return chartInline(d);
    case 'clear': return el('span', {});
    default: return el('pre', { class: 'json-block' }, JSON.stringify(d, null, 2));
  }
}
function renderHelp(cmds) {
  const groups = {};
  for (const c of cmds) (groups[c.group] = groups[c.group] || []).push(c);
  const wrap = el('div', { class: 'help-grid' });
  for (const g of Object.keys(groups)) {
    wrap.append(el('div', { class: 'help-group' }, el('div', { class: 'help-group-title' }, g),
      ...groups[g].map((c) => el('div', { class: 'help-row' },
        el('span', { class: 'help-usage mono' }, c.usage), el('span', { class: 'help-desc muted' }, c.desc), c.ai ? badge('info', 'AI') : null))));
  }
  return wrap;
}
function renderSymbols(list) {
  return el('div', { class: 'chip-row' }, ...list.map((s) => el('button', { class: 'chip', onclick: () => fill(`chart ${s.key.split(':').pop()}`) }, `${s.emoji || ''} ${s.name}`)));
}
function renderQuote(d) {
  const q = d.quote;
  if (!q) return el('div', { class: 'term-err' }, 'no quote available');
  return el('div', { class: 'quote-card' },
    el('div', { class: 'quote-name' }, `${d.meta?.emoji || ''} ${d.meta?.name || d.symbol}`),
    el('div', { class: 'quote-price' }, price(q.current), el('span', { class: 'quote-chg ' + chgClass(q.changePercent) }, ` ${signed(q.change)} (${pct(q.changePercent)})`)),
    el('div', { class: 'quote-ohlc muted' }, `O ${price(q.open)}  H ${price(q.high)}  L ${price(q.low)}  prev ${price(q.prevClose)}`),
  );
}
function quoteTable(rows) {
  const trs = (rows || []).filter((r) => r.quote).map((r) => [el('span', {}, `${r.emoji || ''} ${r.name}`), el('span', { class: 'num' }, price(r.quote.current)), el('span', { class: 'num ' + chgClass(r.quote.changePercent) }, pct(r.quote.changePercent)), el('span', { class: 'muted' }, r.category)]);
  return trs.length ? table(['Symbol', 'Last', 'Chg', 'Class'], trs) : empty('no data');
}
function renderMacro(m) {
  return el('div', { class: 'tile-row' }, ...[['dxy', 'US Dollar (DXY)'], ['tnx', 'US 10Y Yield'], ['vix', 'VIX']].map(([k, label]) => {
    const v = m[k];
    return el('div', { class: 'tile' }, el('div', { class: 'tile-label' }, label), v ? el('div', {}, el('span', { class: 'tile-val' }, price(v.price)), el('span', { class: 'tile-chg ' + chgClass(v.changePercent) }, ' ' + pct(v.changePercent))) : el('span', { class: 'muted' }, 'n/a'));
  }));
}
function renderFear(f) {
  if (!f) return empty('no data');
  return el('div', { class: 'fear-card' }, gauge(f.value, { label: f.label }));
}
function renderFunding(list) {
  const rows = (list || []).map((f) => [el('span', {}, f.symbol), el('span', { class: 'num ' + chgClass(f.rate) }, `${fnum(f.ratePercent ?? f.rate * 100, 4)}%`)]);
  return rows.length ? table(['Perp', 'Funding'], rows) : empty('no funding data (Binance may be geo-blocked)');
}
function renderNews(list) {
  if (!list || !list.length) return empty('no headlines');
  return el('div', { class: 'news-list' }, ...list.slice(0, 15).map((n) => el('div', { class: 'news-row' },
    el('div', {}, n.url ? el('a', { href: n.url, target: '_blank', rel: 'noopener', class: 'news-head' }, n.headline) : el('span', { class: 'news-head' }, n.headline),
      el('div', { class: 'news-meta muted' }, `${n.source || ''} · ${n.category || ''}${n.timestamp ? ' · ' + relTime(toMs(n.timestamp)) : ''}`)),
    n.tier === 1 ? badge('ok', 'T1') : n.tier === 2 ? badge('info', 'T2') : null)));
}
function renderCalendar(list) {
  if (!list || !list.length) return empty('no events');
  return table(['When', 'Event', 'Impact', 'Fcst/Prev'], list.slice(0, 20).map((e) => [el('span', { class: 'muted' }, `${e.date || ''} ${e.time || ''}`), el('span', {}, e.event), badge(sev(e.impact), e.impact || '—'), el('span', { class: 'muted' }, `f:${e.forecast ?? '—'} p:${e.previous ?? '—'}`)]));
}
function renderCot(list) {
  if (!list || !list.length) return empty('no COT data');
  return table(['Market', 'Sentiment', 'Comm net', 'Spec net'], list.map((c) => [el('span', {}, `${c.meta?.emoji || ''} ${c.name || c.symbol}`), el('span', {}, `${c.sentimentEmoji || ''} ${c.sentiment || '—'}`), el('span', { class: 'num' }, fmtNum(c.commercialNet)), el('span', { class: 'num' }, fmtNum(c.speculatorNet))]));
}
function renderAnalysis(d) {
  const a = d.analysis || {}, r = a.riskMetrics || {};
  const rows = [
    ['RSI', `${a.rsi ?? '—'} ${a.rsiSignal || ''}`],
    ['Trend', a.trendSignal || '—'],
    ['MACD', a.macd ? `${round(a.macd.value)} / sig ${round(a.macd.signal)} / hist ${round(a.macd.histogram)} ${a.macdSignal || ''}` : '—'],
    ['Divergence', a.divergence?.type ? `${a.divergence.type} (${a.divergence.strength || ''})` : 'none'],
    ['Volatility', r.regime ? `${r.regimeEmoji || ''} ${r.regime} · exp move ${r.expectedMovePercent ?? '—'}%` : '—'],
  ];
  if (a.volume) rows.push(['Volume', `${a.volume.label}${a.volume.ratio ? ' · ' + a.volume.ratio + '× 20d avg' : ''} · ${a.volume.trend}`]);
  if (d.cot) rows.push(['COT positioning', `${d.cot.sentimentEmoji || ''} ${d.cot.sentiment || '—'} · comm ${fmtNum(d.cot.commercialNet)} · spec ${fmtNum(d.cot.speculatorNet)}`]);
  return el('div', {}, el('div', { class: 'quote-name' }, `${d.meta?.emoji || ''} ${d.meta?.name || d.symbol}`, d.quote ? el('span', { class: 'muted', style: 'font-weight:400;margin-left:8px' }, price(d.quote.current) + ' ' + pct(d.quote.changePercent)) : null),
    table(['Metric', 'Value'], rows.map(([k, v]) => [el('span', { class: 'muted' }, k), el('span', {}, v)])),
    d.levels ? levelsBlock('Key levels', d.levels) : null);
}
function renderLevels(d) {
  return el('div', {}, el('div', { class: 'quote-name' }, `${d.meta?.emoji || ''} ${d.meta?.name || d.symbol}`), d.daily ? levelsBlock('Daily', d.daily) : empty('no daily levels'), d.weekly ? levelsBlock('Weekly', d.weekly) : null);
}
function levelsBlock(title, lv) {
  const line = (arr, cls) => (arr || []).slice(0, 5).map((l) => el('span', { class: `lvl ${cls}` }, `${price(l.price)}${l.label ? ' ' + l.label : ''}`));
  return el('div', { class: 'levels-block' }, el('div', { class: 'card-title', style: 'margin:10px 0 6px' }, title),
    el('div', { class: 'lvl-row' }, el('span', { class: 'muted lvl-tag' }, 'R'), ...line(lv.resistances, 'res')),
    el('div', { class: 'lvl-row' }, el('span', { class: 'muted lvl-tag' }, 'P'), el('span', { class: 'lvl piv' }, price(lv.pivot))),
    el('div', { class: 'lvl-row' }, el('span', { class: 'muted lvl-tag' }, 'S'), ...line(lv.supports, 'sup')));
}
function renderPulse(d) {
  return el('div', {}, renderMacro(d.macro || {}), el('div', { style: 'margin:12px 0' }, d.fear ? renderFear(d.fear) : null), el('div', { class: 'card-title', style: 'margin:8px 0 6px' }, 'Top movers'), quoteTable(d.movers || []));
}
function renderVerdict(d) {
  const text = typeof d.verdict === 'string' ? d.verdict : JSON.stringify(d.verdict, null, 2);
  return el('div', { class: 'ai-card' }, el('div', { class: 'ai-head' }, badge('info', 'AI VERDICT'), el('span', { class: 'quote-name' }, d.name || d.symbol), copyBtn(text)), aiText(text));
}
function renderBrief(d) {
  return el('div', { class: 'ai-card' }, el('div', { class: 'ai-head' }, badge('info', 'AI BRIEF'), el('span', { class: 'muted' }, `${d.category} · ${d.count} headlines`), d.tldr ? copyBtn(d.tldr) : null),
    d.tldr ? aiText(d.tldr) : el('div', { class: 'muted' }, 'No summary available.'),
    d.curated?.length ? el('ul', { class: 'brief-list' }, ...d.curated.slice(0, 10).map((h) => el('li', {}, h))) : null);
}
function renderAI(d) {
  return el('div', { class: 'ai-card' }, el('div', { class: 'ai-head' }, badge('info', 'AI'), copyBtn(d.answer || '')), aiText(d.answer || '')); }
function copyBtn(text) {
  const b = el('button', { class: 'chip copy-btn', title: 'Copy to clipboard' }, 'Copy');
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = '✓ Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200); }
    catch { b.textContent = 'Ctrl+C'; }
  });
  return b;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function aiText(text) { const w = el('div', { class: 'ai-text' }); String(text || '').split(/\n{2,}/).forEach((p) => w.append(el('p', {}, p.trim()))); return w; }
function fill(v) { const i = document.querySelector('.term-input'); if (i) { i.value = v; i.focus(); } }
function sname(i) { const n = i.name || i.symbol; return n.length > 13 ? n.slice(0, 12) + '…' : n; }
function skey(sym) { return String(sym).split(':').pop(); }
function price(v) { if (v == null || !Number.isFinite(Number(v))) return '—'; const n = Number(v); const dp = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 1 ? 2 : 4; return n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }); }
function fnum(v, dp) { return v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(dp); }
function pct(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`; }
function signed(v) { return v == null || !Number.isFinite(Number(v)) ? '' : `${Number(v) > 0 ? '+' : ''}${price(v)}`; }
function round(v) { return v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v) * 100) / 100; }
function chgClass(v) { return v > 0 ? 'pos-txt' : v < 0 ? 'neg-txt' : ''; }
function sev(imp) { const s = String(imp || '').toLowerCase(); return s === 'high' ? 'crit' : s === 'medium' ? 'medium' : 'low'; }
function toMs(ts) { if (!ts) return null; const n = Number(ts); if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n; const p = Date.parse(ts); return Number.isFinite(p) ? p : null; }
