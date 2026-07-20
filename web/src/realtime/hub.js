'use strict';
/**
 * WebSocket hub. Authenticates the upgrade with the same signed session cookie
 * as the REST API, keeps a client registry, heartbeats them, and broadcasts
 * server-pushed events. Clients are read-only (they never drive state).
 */
const { WebSocketServer } = require('ws');
const sessions = require('../auth/sessions');
const log = require('../logger').child('ws');

let wss = null;
const clients = new Set();

function init(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const sess = sessions.getSessionFromCookieHeader(req.headers.cookie);
    if (!sess) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = { id: sess.userId, isAdmin: sess.isAdmin };
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => { /* clients are read-only; ignore inbound */ });
    ws.on('close', () => { clients.delete(ws); log.debug({ clients: clients.size }, 'ws closed'); });
    ws.on('error', () => { clients.delete(ws); });
    log.debug({ clients: clients.size, user: ws.user.id }, 'ws connected');
    sendTo(ws, { type: 'hello', ts: Date.now() });
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) { ws.terminate(); clients.delete(ws); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  return wss;
}

function sendTo(ws, obj) {
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

/** Broadcast to all clients (optional predicate, e.g. admins only). */
function broadcast(obj, filter = null) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (filter && !filter(ws)) continue;
    try { if (ws.readyState === ws.OPEN) ws.send(data); } catch { /* ignore */ }
  }
}

function clientCount() { return clients.size; }

function close() {
  try { wss?.close(); } catch { /* ignore */ }
  for (const ws of clients) { try { ws.terminate(); } catch { /* ignore */ } }
  clients.clear();
}

module.exports = { init, broadcast, clientCount, close };
