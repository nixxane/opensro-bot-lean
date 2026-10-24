// Reference team relay for opensro-bot-lean (team mode).
// Rooms by room key: presence beats fan out between the characters of a room; messages with
// scope "public" fan out to every room (the opt-in shared pool); a small key-value store per
// room (plus a public one) persists between restarts for the team knowledge base. A room's
// console page (/?key=<room key>) shows the fleet and can stop everyone or call a group town
// trip. The relay holds no game logic and never sees game credentials.
//
// Run: npm install && npm start   (PORT env var, default 4701; data file DATA_FILE or ./relay-data.json)
// TLS: the game page is HTTPS, so the browser only accepts wss:// — put this server behind a
// TLS-terminating proxy (Caddy/nginx) or a Cloudflare tunnel; it does not do TLS itself.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 4701);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'relay-data.json');
const HELLO_TIMEOUT_MS = 10000;
const BEAT_TIMEOUT_MS = 30000;
const SWEEP_MS = 15000;
const SAVE_DEBOUNCE_MS = 3000;

// roomKey -> Map(name -> { ws, state, at })
const rooms = new Map();
// { rooms: { roomKey: { kv: {} } }, public: { kv: {} } }
let data = { rooms: {}, public: { kv: {} } };
try { data = { rooms: {}, public: { kv: {} }, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
let saveTimer = null;

function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    // Live rooms' kv stays in memory; the file keeps the last written values.
    const out = { public: { kv: data.public.kv }, rooms: {} };
    for (const key of Object.keys(data.rooms)) out.rooms[key] = { kv: data.rooms[key].kv || {} };
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(out)); } catch (e) { console.error('relay data save failed:', e.message); }
  }, SAVE_DEBOUNCE_MS);
}

function kvFor(roomKey, scope) {
  if (scope === 'public') return data.public.kv;
  (data.rooms[roomKey] ||= { kv: {} });
  return data.rooms[roomKey].kv;
}

function roomPeers(room, exceptName) {
  const peers = [];
  for (const [name, entry] of room) if (name !== exceptName) peers.push({ name, state: entry.state });
  return peers;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(msg)); } catch {} }
}

function broadcast(room, msg, exceptWs) {
  for (const entry of room.values()) if (entry.ws !== exceptWs) send(entry.ws, msg);
}

function broadcastAll(msg, exceptWs) {
  for (const room of rooms.values()) broadcast(room, msg, exceptWs);
}

function leave(roomKey, room, name) {
  const entry = room.get(name);
  if (!entry || rooms.get(roomKey) !== room) return;
  room.delete(name);
  if (!room.size) rooms.delete(roomKey);
  else broadcast(room, { type: 'leave', name });
}

function admit(ws, hello) {
  const roomKey = String(hello.token || ''), name = String(hello.name || '');
  if (!roomKey || !name || roomKey.length > 200 || name.length > 40) {
    send(ws, { type: 'error', message: 'hello needs a token and a name' });
    ws.close();
    return;
  }
  let room = rooms.get(roomKey);
  if (!room) rooms.set(roomKey, room = new Map());
  const previous = room.get(name);
  if (previous && previous.ws !== ws) { try { previous.ws.close(); } catch {} }
  room.set(name, { ws, state: hello.state || {}, at: Date.now() });
  send(ws, { type: 'welcome', you: name, peers: roomPeers(room, name) });
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
      return;
    }
    if (msg.type === 'msg') {
      const payload = { type: 'msg', from: name, payload: msg.payload };
      if (msg.scope === 'public') broadcastAll(payload, ws);
      else broadcast(room, payload, ws);
      return;
    }
    if (msg.type === 'kv-put') {
      if (!msg.key || typeof msg.key !== 'string' || msg.key.length > 100) return;
      const kv = kvFor(roomKey, msg.scope);
      const previousValue = kv[msg.key];
      // Last writer per record: a put may carry a partial doc; keep the newer of the two by record.
      kv[msg.key] = mergeDoc(previousValue, msg.value);
      persist();
      broadcast(room, { type: 'kv-value', key: msg.key, value: kv[msg.key], from: name }, ws);
      return;
    }
    if (msg.type === 'kv-get') {
      if (!msg.key || typeof msg.key !== 'string') return;
      send(ws, { type: 'kv-value', key: msg.key, value: kvFor(roomKey, msg.scope)[msg.key] || null });
      return;
    }
  });
  ws.on('close', () => leave(roomKey, room, name));
}

// Knowledge docs merge per record (each row carries its own "at"): newest wins, drops keep the max.
function mergeDoc(previous, next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next === undefined ? previous : next;
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return next;
  const out = { ...previous };
  for (const [key, row] of Object.entries(next)) {
    if (!row || typeof row !== 'object') { out[key] = row; continue; }
    const known = out[key];
    if (known && typeof known === 'object' && (known.at || 0) > (row.at || 0)) continue;
    out[key] = row;
  }
  return out;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (url.pathname === '/state' && req.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    const room = rooms.get(key);
    if (!key || !room) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"unknown room key"}'); return; }
    const peers = [...room.entries()].map(([name, entry]) => ({ name, state: entry.state, at: entry.at }));
    const uniques = Object.entries(kvFor(key, 'room').knowledge?.uniques || {})
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 8)
      .map(([name, r]) => name + (r.deadAt ? ' dead' : ' appeared') + ' ' + Math.round((Date.now() - (r.deadAt || r.appearAt || 0)) / 60000) + ' min ago');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ peers, publicSummary: uniques.length ? 'Uniques: ' + uniques.join(' · ') : '' }));
    return;
  }
  if (url.pathname !== '/') { res.writeHead(404); res.end(); return; }
  const key = url.searchParams.get('key') || '';
  if (req.method === 'POST') {
    if (!key || !rooms.get(key)) { res.writeHead(403); res.end('{"error":"unknown room key"}'); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let action = '';
      try { action = String(JSON.parse(body).action || ''); } catch {}
      if (!['stop', 'town'].includes(action)) { res.writeHead(400); res.end('{"error":"unknown action"}'); return; }
      const room = rooms.get(key);
      broadcast(room, { type: 'msg', from: 'console', payload: { kind: 'event', event: { kind: 'cmd', action } } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  if (!key || !rooms.get(key)) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<pre>Team relay console\n\nAdd ?key=&lt;room key&gt; for a room that has characters connected.</pre>'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Team console</title>
<style>body{font:14px/1.45 system-ui;margin:2rem;color:#e8e2d2;background:#14170f}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}table{border-collapse:collapse;margin-top:1rem}td,th{border:1px solid #3a4030;padding:.3rem .7rem;text-align:left}th{background:#202617}.muted{color:#8f8a76}</style>
<h2>Team console</h2>
<p class="muted">Room with ${rooms.get(key).size} character(s) connected. Every command goes only to this room.</p>
<button onclick="cmd('stop')">Stop everyone</button>
<button onclick="cmd('town')">Town trip for everyone</button>
<table id="peers"><tr><th>Character</th><th>State</th><th>Level</th><th>Role</th><th>Position</th><th>Last beat</th></tr></table>
<p class="muted" id="note"></p>
<script>
const key = new URLSearchParams(location.search).get('key');
function cmd(action) { fetch('/?key=' + encodeURIComponent(key), { method: 'POST', body: JSON.stringify({ action }) }); }
async function refresh() {
  const table = document.getElementById('peers');
  while (table.rows.length > 1) table.deleteRow(1);
  const note = document.getElementById('note');
  note.textContent = 'refreshing…';
  try {
    const state = await (await fetch('/state?key=' + encodeURIComponent(key))).json();
    for (const p of state.peers) {
      const s = p.state || {}, row = table.insertRow();
      row.innerHTML = '<td>' + esc(p.name) + '</td><td>' + (s.hunting ? 'hunting' : s.alive === false ? 'dead' : esc(s.mode || 'idle')) + (s.townTrip ? ' (town)' : '') + '</td><td>' + (s.level ?? '') + '</td><td>' + esc(s.role || 'none') + '</td><td>' + (s.pos ? s.pos.regionId + ' ' + s.pos.x + ',' + s.pos.z : '') + '</td><td>' + Math.round((Date.now() - p.at) / 1000) + ' s ago</td>';
    }
    note.textContent = state.publicSummary || '';
  } catch (e) { note.textContent = 'refresh failed: ' + e; }
}
function esc(s) { return String(s ?? '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
refresh(); setInterval(refresh, 5000);
</script>`);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
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

// The console's data source: one room's presence (guarded by the same key).
server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/state' || req.method !== 'GET') return;
  const key = url.searchParams.get('key') || '';
  const room = rooms.get(key);
  if (!key || !room) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"unknown room key"}'); return; }
  const peers = [...room.entries()].map(([name, entry]) => ({ name, state: entry.state, at: entry.at }));
  const uniques = Object.entries(kvFor(key, 'room').knowledge?.uniques || {})
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 8)
    .map(([name, r]) => name + (r.deadAt ? ' dead' : ' appeared') + ' ' + Math.round((Date.now() - (r.deadAt || r.appearAt || 0)) / 60000) + ' min ago');
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ peers, publicSummary: uniques.length ? 'Uniques: ' + uniques.join(' · ') : '' }));
});

setInterval(() => {
  const cutoff = Date.now() - BEAT_TIMEOUT_MS;
  for (const [roomKey, room] of rooms) {
    for (const [name, entry] of room) {
      if (entry.at < cutoff) leave(roomKey, room, name);
      else entry.ws.ping();
    }
  }
}, SWEEP_MS);

server.listen(PORT, () => console.log('team relay listening on port ' + PORT + ' (console at /?key=<room key>)'));
