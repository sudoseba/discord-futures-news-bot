// Minimal hash router. Routes: { '/path': { title, render } } where render()
// returns { el, live?, dispose? }. Keeps the current view so the app can forward
// live events, and disposes it (clearing timers/sockets) before switching.
import { el, spinner } from './ui.js';

export function createRouter(routes, onNavigate) {
  let current = null;

  async function render() {
    if (current && current.dispose) { try { current.dispose(); } catch { /* ignore */ } }
    current = null;

    const path = location.hash.replace(/^#/, '') || '/';
    const route = routes[path] || routes['/'];
    onNavigate(path, route);
    const view = document.getElementById('view');
    view.replaceChildren(spinner());
    try {
      const result = await route.render();
      view.replaceChildren(result.el || result);
      current = result && (result.live || result.dispose) ? result : null;
    } catch (e) {
      view.replaceChildren(el('div', { class: 'banner crit' }, `Failed to load: ${e.message || e}`));
    }
  }

  window.addEventListener('hashchange', render);
  return {
    render,
    live(evt) { try { current && current.live && current.live(evt); } catch { /* ignore */ } },
  };
}
