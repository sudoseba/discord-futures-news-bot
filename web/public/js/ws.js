// Auto-reconnecting WebSocket client. Calls onEvent(msg) and onStatus(state).
export function createWS(onEvent, onStatus) {
  let ws = null;
  let backoff = 1000;
  let closedByUs = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    onStatus('connecting');
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => { backoff = 1000; onStatus('live'); };
    ws.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data)); } catch { /* ignore malformed */ }
    };
    ws.onclose = () => { onStatus('offline'); if (!closedByUs) scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  function scheduleReconnect() {
    backoff = Math.min(Math.round(backoff * 1.6), 15000);
    setTimeout(connect, backoff);
  }

  connect();
  return { close() { closedByUs = true; try { ws && ws.close(); } catch { /* ignore */ } } };
}
