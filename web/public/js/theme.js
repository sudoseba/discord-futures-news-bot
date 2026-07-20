// Theme switcher. Each theme overrides CSS custom properties on :root; charts
// and every component read those vars, so they all re-skin instantly.
import { el } from './ui.js';

const THEMES = {
  midnight: {
    '--bg': '#0c0f16', '--bg-elev': '#141a24', '--bg-elev-2': '#1a212d', '--bg-hover': '#202836',
    '--border': '#232c3b', '--border-soft': '#1c2430', '--grad': '#141b2b',
    '--text': '#e7ebf2', '--text-dim': '#9aa5b5', '--muted': '#6b7688',
    '--accent': '#5b8cff', '--ok': '#3fb950', '--crit': '#f85149', '--warn': '#d6a018', '--info': '#58a6ff', '--purple': '#a371f7',
    '--sidebar-bg': '#0a0d14', '--topbar-bg': '#0e121bd9', '--scrollbar': '#2a3342',
  },
  amber: {
    '--bg': '#0a0a08', '--bg-elev': '#14120c', '--bg-elev-2': '#1c1810', '--bg-hover': '#241f14',
    '--border': '#33291a', '--border-soft': '#241d12', '--grad': '#1a1206',
    '--text': '#ffd9a0', '--text-dim': '#c79a5e', '--muted': '#8a6d42',
    '--accent': '#ffab2e', '--ok': '#7bd66a', '--crit': '#ff5f4e', '--warn': '#ffab2e', '--info': '#ffcf6b', '--purple': '#ff9a3d',
    '--sidebar-bg': '#0c0b07', '--topbar-bg': '#100e09d9', '--scrollbar': '#3a2f1c',
  },
  matrix: {
    '--bg': '#050a05', '--bg-elev': '#0a140a', '--bg-elev-2': '#0e1c0e', '--bg-hover': '#123012',
    '--border': '#1c3a1c', '--border-soft': '#142814', '--grad': '#08180a',
    '--text': '#b8f5b8', '--text-dim': '#6fbf6f', '--muted': '#4a854a',
    '--accent': '#39ff88', '--ok': '#39ff88', '--crit': '#ff5555', '--warn': '#e0d040', '--info': '#55ffd0', '--purple': '#7dff7d',
    '--sidebar-bg': '#040804', '--topbar-bg': '#071007d9', '--scrollbar': '#1c3a1c',
  },
  synthwave: {
    '--bg': '#120a1f', '--bg-elev': '#1b1030', '--bg-elev-2': '#241541', '--bg-hover': '#2e1a52',
    '--border': '#3a2565', '--border-soft': '#281745', '--grad': '#2a0f45',
    '--text': '#f2e9ff', '--text-dim': '#b79ee0', '--muted': '#8a6fb0',
    '--accent': '#ff5ea0', '--ok': '#45e0b0', '--crit': '#ff4d6d', '--warn': '#ffcf5e', '--info': '#5ee0ff', '--purple': '#b76eff',
    '--sidebar-bg': '#0e0719', '--topbar-bg': '#160c26d9', '--scrollbar': '#3a2565',
  },
  light: {
    '--bg': '#f4f6fb', '--bg-elev': '#ffffff', '--bg-elev-2': '#eef1f7', '--bg-hover': '#e6ebf3',
    '--border': '#d8dee9', '--border-soft': '#e7ebf3', '--grad': '#e3e9f6',
    '--text': '#1a2130', '--text-dim': '#4a5568', '--muted': '#8a93a6',
    '--accent': '#2f6bff', '--ok': '#1a9c4a', '--crit': '#d64036', '--warn': '#b9820a', '--info': '#2f80d6', '--purple': '#7c4dff',
    '--sidebar-bg': '#eef1f7', '--topbar-bg': '#ffffffd9', '--scrollbar': '#c3ccda',
  },
};
const ORDER = ['midnight', 'amber', 'matrix', 'synthwave', 'light'];
const LABELS = { midnight: 'Midnight', amber: 'Amber', matrix: 'Matrix', synthwave: 'Synthwave', light: 'Light' };
const KEY = 'ws-theme';

function apply(name) {
  const t = THEMES[name] || THEMES.midnight;
  for (const [k, v] of Object.entries(t)) document.documentElement.style.setProperty(k, v);
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(KEY, name); } catch { /* ignore */ }
}

export function initTheme() {
  let saved;
  try { saved = localStorage.getItem(KEY); } catch { saved = null; }
  apply(THEMES[saved] ? saved : 'midnight');
}

export function themeControl() {
  let cur = 'midnight';
  try { cur = localStorage.getItem(KEY) || 'midnight'; } catch { /* ignore */ }
  const sel = el('select', { class: 'theme-select', title: 'Theme' },
    ...ORDER.map((n) => el('option', { value: n, selected: n === cur ? true : null }, LABELS[n])));
  sel.addEventListener('change', () => apply(sel.value));
  return el('div', { class: 'theme-ctl' }, el('span', { class: 'theme-ico' }, '🎨'), sel);
}
