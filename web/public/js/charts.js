// Self-contained SVG charts (no libraries). Elements are class-tagged so CSS
// (and therefore the active theme) controls all colors.
import { el } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtDate(ts) {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function sma(arr, period) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/**
 * Candlestick chart: candles + volume + SMA20/50 + level lines + RSI subpanel,
 * with an interactive crosshair and an OHLC tooltip on hover.
 */
export function candleChart(candles, opts = {}) {
  const W = 900;
  const H = opts.height || 420;
  const maxBars = opts.maxBars || 130;
  const mR = 58, mL = 6, mT = 10, mB = 20, gap = 10, rsiH = opts.rsi === false ? 0 : 62;
  const priceH = H - mT - mB - (rsiH ? gap + rsiH : 0);
  const priceBottom = mT + priceH;
  const rsiTop = priceBottom + gap;
  const volH = Math.min(46, priceH * 0.28);

  const n0 = candles.close.length;
  const start = Math.max(0, n0 - maxBars);
  const O = candles.open.slice(start), Hi = candles.high.slice(start), Lo = candles.low.slice(start),
    C = candles.close.slice(start), V = (candles.volume || []).slice(start), T = (candles.timestamp || []).slice(start);
  const n = C.length;
  if (n < 2) return el('div', { class: 'muted' }, 'not enough data to chart');

  let pMin = Infinity, pMax = -Infinity;
  for (let i = 0; i < n; i++) { if (Lo[i] < pMin) pMin = Lo[i]; if (Hi[i] > pMax) pMax = Hi[i]; }
  const pad = (pMax - pMin) * 0.06 || 1; pMin -= pad; pMax += pad;
  const vMax = Math.max(1, ...V.map((x) => x || 0));

  const plotW = W - mR - mL;
  const x = (i) => mL + (i + 0.5) * (plotW / n);
  const y = (p) => mT + (1 - (p - pMin) / (pMax - pMin)) * priceH;
  const yVol = (v) => priceBottom - (v / vMax) * volH;
  const cw = Math.max(1, (plotW / n) * 0.62);
  const P = [];

  for (let i = 0; i <= 5; i++) {
    const p = pMin + (i / 5) * (pMax - pMin);
    const yy = y(p).toFixed(1);
    P.push(`<line class="chart-grid" x1="${mL}" y1="${yy}" x2="${W - mR}" y2="${yy}"/>`);
    P.push(`<text class="chart-txt" x="${W - mR + 5}" y="${(+yy + 3).toFixed(1)}">${fmtPrice(p)}</text>`);
  }
  for (let i = 0; i < n; i++) {
    const up = C[i] >= O[i];
    P.push(`<rect class="vol-${up ? 'up' : 'dn'}" x="${(x(i) - cw / 2).toFixed(1)}" y="${yVol(V[i] || 0).toFixed(1)}" width="${cw.toFixed(1)}" height="${(priceBottom - yVol(V[i] || 0)).toFixed(1)}"/>`);
  }
  for (let i = 0; i < n; i++) {
    const cls = C[i] >= O[i] ? 'up' : 'dn';
    P.push(`<line class="wick-${cls}" x1="${x(i).toFixed(1)}" y1="${y(Hi[i]).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(Lo[i]).toFixed(1)}"/>`);
    const yo = y(O[i]), yc = y(C[i]);
    P.push(`<rect class="cndl-${cls}" x="${(x(i) - cw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${cw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}"/>`);
  }
  for (const [period, cls] of [[20, 'sma20'], [50, 'sma50']]) {
    if (n > period) {
      const s = sma(C, period);
      let pts = '';
      for (let i = 0; i < n; i++) if (s[i] != null) pts += `${x(i).toFixed(1)},${y(s[i]).toFixed(1)} `;
      if (pts) P.push(`<polyline class="${cls}" points="${pts.trim()}"/>`);
    }
  }
  if (opts.levels) {
    const lv = opts.levels;
    const draw = (arr, cls) => (arr || []).slice(0, 4).forEach((l) => { if (l.price >= pMin && l.price <= pMax) P.push(`<line class="lvl-line ${cls}" x1="${mL}" y1="${y(l.price).toFixed(1)}" x2="${W - mR}" y2="${y(l.price).toFixed(1)}"/>`); });
    draw(lv.resistances, 'res'); draw(lv.supports, 'sup');
    if (lv.pivot >= pMin && lv.pivot <= pMax) P.push(`<line class="lvl-line piv" x1="${mL}" y1="${y(lv.pivot).toFixed(1)}" x2="${W - mR}" y2="${y(lv.pivot).toFixed(1)}"/>`);
  }
  // last price tag
  const last = C[n - 1], upLast = last >= O[n - 1], ly = y(last);
  P.push(`<rect class="last-tag ${upLast ? 'up' : 'dn'}" x="${W - mR + 1}" y="${(ly - 9).toFixed(1)}" width="${mR - 2}" height="18" rx="3"/>`);
  P.push(`<text class="last-tag-txt" x="${W - mR + 5}" y="${(ly + 4).toFixed(1)}">${fmtPrice(last)}</text>`);
  for (const i of [0, Math.floor(n / 2), n - 1]) if (T[i]) P.push(`<text class="chart-txt" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtDate(T[i])}</text>`);

  // RSI subpanel
  let rsiArr = null;
  if (rsiH) {
    rsiArr = rsi(C, 14);
    const yR = (v) => rsiTop + (1 - v / 100) * rsiH;
    P.push(`<rect class="rsi-bg" x="${mL}" y="${rsiTop}" width="${plotW}" height="${rsiH}"/>`);
    for (const g of [30, 50, 70]) {
      P.push(`<line class="rsi-guide ${g === 50 ? 'mid' : ''}" x1="${mL}" y1="${yR(g).toFixed(1)}" x2="${W - mR}" y2="${yR(g).toFixed(1)}"/>`);
      P.push(`<text class="chart-txt" x="${W - mR + 5}" y="${(yR(g) + 3).toFixed(1)}">${g}</text>`);
    }
    let rp = '';
    for (let i = 0; i < n; i++) if (rsiArr[i] != null) rp += `${x(i).toFixed(1)},${yR(rsiArr[i]).toFixed(1)} `;
    if (rp) P.push(`<polyline class="rsi-line" points="${rp.trim()}"/>`);
    P.push(`<text class="chart-txt rsi-label" x="${mL + 2}" y="${rsiTop + 12}">RSI 14</text>`);
  }

  // crosshair (updated by JS)
  P.push(`<line class="cx-v" x1="0" y1="${mT}" x2="0" y2="${priceBottom}" style="display:none"/>`);
  P.push(`<line class="cx-h" x1="${mL}" y1="0" x2="${W - mR}" y2="0" style="display:none"/>`);
  P.push(`<rect class="cx-tag" x="${W - mR + 1}" y="0" width="${mR - 2}" height="16" rx="3" style="display:none"/>`);
  P.push(`<text class="cx-tag-txt" x="${W - mR + 5}" y="0" style="display:none"></text>`);

  const wrap = el('div', { class: 'chart-wrap' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="candle-svg">${P.join('')}</svg>`;
  const svg = wrap.querySelector('svg');
  const tip = el('div', { class: 'chart-tip' });
  tip.style.display = 'none';
  wrap.append(tip);

  const cxv = svg.querySelector('.cx-v'), cxh = svg.querySelector('.cx-h'), cxt = svg.querySelector('.cx-tag'), cxtx = svg.querySelector('.cx-tag-txt');
  function move(ev) {
    const r = svg.getBoundingClientRect();
    const vbX = ((ev.clientX - r.left) / r.width) * W;
    const vbY = ((ev.clientY - r.top) / r.height) * H;
    let i = Math.round((vbX - mL) / (plotW / n) - 0.5);
    i = Math.max(0, Math.min(n - 1, i));
    const cxX = x(i);
    for (const e of [cxv]) { e.setAttribute('x1', cxX); e.setAttribute('x2', cxX); e.style.display = ''; }
    if (vbY >= mT && vbY <= priceBottom) {
      const price = pMin + (1 - (vbY - mT) / priceH) * (pMax - pMin);
      cxh.setAttribute('y1', vbY); cxh.setAttribute('y2', vbY); cxh.style.display = '';
      cxt.setAttribute('y', (vbY - 8)); cxt.style.display = '';
      cxtx.setAttribute('y', (vbY + 3)); cxtx.textContent = fmtPrice(price); cxtx.style.display = '';
    } else { cxh.style.display = 'none'; cxt.style.display = 'none'; cxtx.style.display = 'none'; }
    const chg = ((C[i] - O[i]) / O[i]) * 100;
    tip.innerHTML = `<b>${fmtDate(T[i])}</b>  O ${fmtPrice(O[i])}  H ${fmtPrice(Hi[i])}  L ${fmtPrice(Lo[i])}  <span class="${C[i] >= O[i] ? 'pos-txt' : 'neg-txt'}">C ${fmtPrice(C[i])} (${chg > 0 ? '+' : ''}${chg.toFixed(2)}%)</span>${rsiArr && rsiArr[i] != null ? '  RSI ' + rsiArr[i].toFixed(0) : ''}`;
    tip.style.display = '';
    const left = Math.min(ev.clientX - r.left + 12, r.width - 260);
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = '6px';
  }
  function leave() { for (const e of [cxv, cxh, cxt, cxtx]) e.style.display = 'none'; tip.style.display = 'none'; }
  wrap.addEventListener('mousemove', move);
  wrap.addEventListener('mouseleave', leave);
  return wrap;
}

/** 180° arc gauge (e.g. Fear & Greed 0-100). Colors by zone. */
export function gauge(value, opts = {}) {
  const { min = 0, max = 100, label = '' } = opts;
  const W = 200, H = 118, cx = 100, cy = 104, r = 84;
  const f = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const zone = value <= 25 ? 'crit' : value <= 45 ? 'warn' : value <= 55 ? 'neu' : value <= 75 ? 'good' : 'great';
  const wrap = el('div', { class: 'gauge-wrap' });
  wrap.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="gauge-svg">` +
    `<path class="gauge-track" d="${arcPath(cx, cy, r, 180, 0)}"/>` +
    `<path class="gauge-val z-${zone}" d="${arcPath(cx, cy, r, 180, 180 - 180 * f)}"/>` +
    `<text class="gauge-num z-${zone}" x="${cx}" y="${cy - 14}" text-anchor="middle">${value}</text>` +
    `<text class="gauge-lbl" x="${cx}" y="${cy + 6}" text-anchor="middle">${escapeText(label)}</text></svg>`;
  return wrap;
}
function arcPath(cx, cy, r, s, e) {
  const a = polar(cx, cy, r, s), b = polar(cx, cy, r, e);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} A ${r} ${r} 0 ${Math.abs(e - s) > 180 ? 1 : 0} ${e < s ? 1 : 0} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}
function polar(cx, cy, r, deg) { const a = (deg * Math.PI) / 180; return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) }; }

/** Small filled area sparkline. */
export function areaSpark(values, { w = 120, h = 34 } = {}) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  const wrap = el('div', { class: 'spark' });
  if (nums.length < 2) { wrap.append(el('span', { class: 'muted' }, '—')); return wrap; }
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1, step = w / (nums.length - 1);
  const up = nums[nums.length - 1] >= nums[0];
  let pts = '';
  nums.forEach((v, i) => { pts += `${(i * step).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)} `; });
  wrap.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="spark-svg ${up ? 'up' : 'dn'}"><polygon class="spark-area" points="${pts}${w},${h} 0,${h}"/><polyline class="spark-line" points="${pts.trim()}"/></svg>`;
  return wrap;
}

function escapeText(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
