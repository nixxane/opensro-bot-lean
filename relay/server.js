// Reference team relay for opensro-bot-lean (team presence).
// One room per room key; the relay forwards presence beats between the characters of a room and
// holds no game logic and no storage. A client is dropped after BEAT_TIMEOUT_MS without a beat.
//
// Run: npm install && npm start   (PORT env var, default 4701)
// TLS: the game page is HTTPS, so the browser only accepts wss:// — put this server behind a
// TLS-terminating proxy (Caddy/nginx) or a Cloudflare tunnel; it does not do TLS itself.
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 4701);
const HELLO_TIMEOUT_MS = 10000;  // a connection that never says hello is closed
const BEAT_TIMEOUT_MS = 30000;   // the client beats every 5 s; six missed beats mean it is gone
const SWEEP_MS = 15000;

// roomKey -> Map(name -> { ws, state, at })
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

function broadcast(room, msg, exceptWs) {
  for (const entry of room.values()) {
    if (entry.ws !== exceptWs) send(entry.ws, msg);
  }
}

// Only the socket that owns the entry may take it out: a same-name reconnect closes the old
// socket, and its async close event must not delete the new connection's entry.
function leave(roomKey, room, name, ws) {
  const entry = room.get(name);
  if (!entry || entry.ws !== ws || rooms.get(roomKey) !== room) return;
  room.delete(name);
  if (!room.size) rooms.delete(roomKey);
  else broadcast(room, { type: 'leave', name });
}

function admit(ws, hello) {
  const roomKey = String(hello.token || '');
  const name = String(hello.name || '');
  if (!roomKey || !name || roomKey.length > 200 || name.length > 40) {
    send(ws, { type: 'error', message: 'hello needs a token and a name' });
    ws.close();
    return;
  }
  let room = rooms.get(roomKey);
  if (!room) rooms.set(roomKey, room = new Map());
  // The same character reconnecting replaces its old connection silently.
  const previous = room.get(name);
  if (previous && previous.ws !== ws) {
    try { previous.ws.close(); } catch {}
  }
  room.set(name, { ws, state: hello.state || {}, at: Date.now() });
  const peers = [];
  for (const [peerName, entry] of room) if (peerName !== name) peers.push({ name: peerName, state: entry.state });
  send(ws, { type: 'welcome', you: name, peers });
  broadcast(room, { type: 'join', name }, ws);
  ws.on('message', raw => {
    const entry = room.get(name);
    if (!entry || entry.ws !== ws) return;
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'beat') {
      entry.state = msg.state || {};
      entry.at = Date.now();
      broadcast(room, { type: 'peer', name, state: entry.state }, ws);
    }
  });
  ws.on('close', () => leave(roomKey, room, name, ws));
}

// Bound to localhost by default so a bare start never exposes plaintext room keys on a VPS;
// set HOST=0.0.0.0 only when something in front of it does TLS and access control.
const wss = new WebSocketServer({ host: process.env.HOST || '127.0.0.1', port: PORT });
wss.on('connection', ws => {
  ws.on('error', () => {});
  const helloTimer = setTimeout(() => {
    if (ws.readyState !== ws.OPEN) return;
    send(ws, { type: 'error', message: 'no hello within 10 s' });
    ws.close();
  }, HELLO_TIMEOUT_MS);
  ws.once('message', raw => {
    clearTimeout(helloTimer);
    if (ws.readyState !== ws.OPEN) return;
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch {}
    if (!msg || msg.type !== 'hello' || msg.v !== 1) {
      send(ws, { type: 'error', message: 'first message must be a v1 hello' });
      ws.close();
      return;
    }
    admit(ws, msg);
  });
});

// Drop rooms' silent members; ping everyone else so dead TCP connections surface.
setInterval(() => {
  const cutoff = Date.now() - BEAT_TIMEOUT_MS;
  for (const [roomKey, room] of rooms) {
    for (const [name, entry] of room) {
      if (entry.at < cutoff) leave(roomKey, room, name, entry.ws);
      else entry.ws.ping();
    }
  }
}, SWEEP_MS);

console.log('team relay listening on ' + (process.env.HOST || '127.0.0.1') + ':' + PORT + ' (rooms appear as characters connect)');
