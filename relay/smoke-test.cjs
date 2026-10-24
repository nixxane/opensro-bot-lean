// One-shot protocol check for the team relay: hello/welcome, beat forwarding, the room key-value
// round trip and public-scoped events. Against a local temporary instance:
//   node smoke-test.cjs
// Against a deployed relay (Node or the Cloudflare Worker):
//   WS_URL=wss://your-relay/ws node smoke-test.cjs
const WebSocket = require('ws');
const { spawn } = require('child_process');
const WS_URL = process.env.WS_URL || null;
const srv = WS_URL ? null : spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: process.env.PORT || '4799', DATA_FILE: './smoke-data.json' }, stdio: ['ignore', 'pipe', 'pipe'] });
const base = WS_URL || 'ws://127.0.0.1:' + (process.env.PORT || '4799');
const address = base + (base.includes('?') ? '&' : '?') + 'key=k1';
setTimeout(() => {
  const a = new WebSocket(address);
  const b = new WebSocket(address);
  const got = [];
  const check = () => {
    const okHello = got.find(m => m.type === 'welcome' && m.you === 'A');
    const okJoin = got.find(m => m.type === 'peer' && m.name === 'B');
    const okKv = got.find(m => m.type === 'kv-value' && m.value && m.value.uniques && m.value.uniques.Tiger);
    const okPub = got.find(m => m.type === 'msg' && m.from === 'A' && m.payload.kind === 'event');
    console.log('welcome:', !!okHello, 'beat-forward:', !!okJoin, 'kv-roundtrip:', !!okKv, 'public-event:', !!okPub);
    if (srv) srv.kill();
    process.exit(okHello && okJoin && okKv && okPub ? 0 : 1);
  };
  a.on('message', d => got.push(JSON.parse(d)));
  a.on('open', () => {
    a.send(JSON.stringify({ v: 1, type: 'hello', token: 'k1', name: 'A', state: {} }));
    setTimeout(() => {
      a.send(JSON.stringify({ type: 'kv-put', key: 'knowledge', scope: 'room',
        value: { uniques: { Tiger: { name: 'Tiger', at: Date.now(), appearAt: Date.now() } }, players: {}, drops: {}, gold: 0 } }));
      a.send(JSON.stringify({ type: 'msg', scope: 'public', payload: { kind: 'event', event: { kind: 'unique', name: 'Tiger', state: 'appear' } } }));
    }, 300);
  });
  b.on('open', () => {
    b.send(JSON.stringify({ v: 1, type: 'hello', token: 'k1', name: 'B', state: { hunting: true } }));
    setTimeout(() => b.send(JSON.stringify({ type: 'beat', name: 'B', state: { hunting: true } })), 600);
    setTimeout(() => b.send(JSON.stringify({ type: 'kv-get', key: 'knowledge', scope: 'room' })), 700);
  });
  b.on('message', d => got.push(JSON.parse(d)));
  setTimeout(check, 4000);
}, 1500);
