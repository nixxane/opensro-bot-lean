// Team relay for opensro-bot-lean, Cloudflare Workers edition.
// Same protocol as relay/server.js (hello/welcome/beat/msg/kv), one Durable Object holding every
// room so WebSockets can fan out to each other. Sockets use hibernation (billing follows
// messages, not wall-clock): presence and per-socket identity ride in attachments and tags, the
// room store lives in DO storage (durable across restarts). The bot is unchanged: it connects to
// wss://<worker>/ws?key=<room key> and speaks the same JSON.
//
// Deploy: npm i -g wrangler && wrangler deploy   (see README.md in this folder)
const ROOM_PREFIX = 'r\u0000', PUBLIC_PREFIX = 'p\u0000', KV_KEY = 'knowledge';
const BEAT_STALE_MS = 30000;

function roomTag(key) { return 'room:' + key; }

// Knowledge docs merge per record (each row carries its own "at"): newest wins.
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

function send(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {}
}

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // The sockets of one room, with their hibernated identity (name, state, last beat).
  room(key) {
    const out = [];
    for (const ws of this.state.getWebSockets(roomTag(key))) {
      try { const who = ws.deserializeAttachment(); if (who?.name) out.push({ ws, who }); } catch {}
    }
    return out;
  }

  broadcast(key, msg, except) {
    for (const ws of this.state.getWebSockets(roomTag(key))) if (ws !== except) send(ws, msg);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.upgrade(url);
    if (url.pathname === '/state' && request.method === 'GET') return this.stateJson(url);
    if (url.pathname === '/' && request.method === 'POST') return this.command(request, url);
    if (url.pathname === '/' && request.method === 'GET') return this.console(url);
    return new Response('not found', { status: 404 });
  }

  upgrade(url) {
    const key = url.searchParams.get('key') || '';
    if (!key || key.length > 200) return new Response('missing ?key=<room key>', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server, [roomTag(key)]);
    server.serializeAttachment({ name: '', state: {}, at: 0, key });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(server, raw) {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    let who = null;
    try { who = server.deserializeAttachment(); } catch {}
    if (!who) return;
    if (msg.type === 'hello' && !who.name) {
      const name = String(msg.name || ''), key = String(msg.token || '');
      if (msg.v !== 1 || !name || name.length > 40 || key !== who.key || key.length > 200) {
        send(server, { type: 'error', message: 'hello needs a v1 token matching the URL key and a name' });
        server.close(4000, 'bad hello');
        return;
      }
      // The same character reconnecting closes its old socket quietly.
      for (const { ws, who: other } of this.room(key)) if (other.name === name && ws !== server) { try { ws.close(4001, 'replaced'); } catch {} }
      who.name = name; who.state = msg.state || {}; who.at = Date.now();
      server.serializeAttachment(who);
      send(server, { type: 'welcome', you: name, peers: this.room(key).filter(p => p.who.name !== name).map(p => ({ name: p.who.name, state: p.who.state })) });
      this.broadcast(key, { type: 'join', name }, server);
      return;
    }
    if (!who.name) { server.close(4002, 'hello first'); return; }
    const key = who.key;
    if (msg.type === 'beat') {
      who.state = msg.state || {}; who.at = Date.now();
      server.serializeAttachment(who);
      this.broadcast(key, { type: 'peer', name: who.name, state: who.state }, server);
      return;
    }
    if (msg.type === 'msg') {
      const payload = { type: 'msg', from: who.name, payload: msg.payload };
      if (msg.scope === 'public') {
        for (const ws of this.state.getWebSockets()) if (ws !== server) send(ws, payload);
      } else this.broadcast(key, payload, server);
      return;
    }
    if (msg.type === 'kv-put') {
      if (!msg.key || typeof msg.key !== 'string' || msg.key.length > 100) return;
      const prefix = msg.scope === 'public' ? PUBLIC_PREFIX : ROOM_PREFIX + key + '\u0000';
      const previous = await this.state.storage.get(prefix + msg.key);
      const value = mergeDoc(previous, msg.value);
      await this.state.storage.put(prefix + msg.key, value);
      this.broadcast(key, { type: 'kv-value', key: msg.key, value, from: who.name }, server);
      return;
    }
    if (msg.type === 'kv-get') {
      if (!msg.key || typeof msg.key !== 'string') return;
      const prefix = msg.scope === 'public' ? PUBLIC_PREFIX : ROOM_PREFIX + key + '\u0000';
      send(server, { type: 'kv-value', key: msg.key, value: await this.state.storage.get(prefix + msg.key) || null });
      return;
    }
  }

  async webSocketClose(server) {
    let who = null;
    try { who = server.deserializeAttachment(); } catch {}
    if (who?.name) this.broadcast(who.key, { type: 'leave', name: who.name });
  }

  async webSocketError(server) {
    await this.webSocketClose(server);
  }

  async stateJson(url) {
    const key = url.searchParams.get('key') || '';
    const peers = this.room(key).filter(p => Date.now() - p.who.at < BEAT_STALE_MS * 4)
      .map(p => ({ name: p.who.name, state: p.who.state, at: p.who.at }));
    const knowledge = await this.state.storage.get(ROOM_PREFIX + key + '\u0000' + KV_KEY);
    const uniques = Object.entries(knowledge?.uniques || {})
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 8)
      .map(([name, r]) => name + (r.deadAt ? ' dead' : ' appeared') + ' ' + Math.round((Date.now() - (r.deadAt || r.appearAt || 0)) / 60000) + ' min ago');
    return Response.json({ peers, publicSummary: uniques.length ? 'Uniques: ' + uniques.join(' · ') : '' });
  }

  async command(request, url) {
    const key = url.searchParams.get('key') || '';
    if (!this.room(key).length) return Response.json({ error: 'unknown room key' }, { status: 403 });
    let action = '';
    try { action = String((await request.json()).action || ''); } catch {}
    if (!['stop', 'town'].includes(action)) return Response.json({ error: 'unknown action' }, { status: 400 });
    this.broadcast(key, { type: 'msg', from: 'console', payload: { kind: 'event', event: { kind: 'cmd', action } } });
    return Response.json({ ok: true });
  }

  console(url) {
    const key = url.searchParams.get('key') || '';
    if (!this.room(key).length) return new Response('<pre>Team relay console\n\nAdd ?key=&lt;room key&gt; for a room that has characters connected.</pre>', { headers: { 'content-type': 'text/html' }, status: 403 });
    return new Response(`<!doctype html><meta charset="utf-8"><title>Team console</title>
<style>body{font:14px/1.45 system-ui;margin:2rem;color:#e8e2d2;background:#14170f}button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}table{border-collapse:collapse;margin-top:1rem}td,th{border:1px solid #3a4030;padding:.3rem .7rem;text-align:left}th{background:#202617}.muted{color:#8f8a76}</style>
<h2>Team console</h2>
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
</script>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok');
    const stub = env.RELAY.get(env.RELAY.idFromName('global'));
    return stub.fetch(request);
  },
};
