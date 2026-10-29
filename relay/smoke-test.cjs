// One-shot check of the presence relay: hello/welcome, join notice and beat forwarding.
// Against a local temporary instance:   node smoke-test.cjs
// Against a deployed relay:             WS_URL=wss://your-relay node smoke-test.cjs
const WebSocket = require('ws');
const { spawn } = require('child_process');
const WS_URL = process.env.WS_URL || null;
const srv = WS_URL ? null : spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: process.env.PORT || '4799' }, stdio: ['ignore', 'pipe', 'pipe'] });
setTimeout(() => {
  const a = new WebSocket(WS_URL || 'ws://127.0.0.1:' + (process.env.PORT || '4799'));
  const b = new WebSocket(WS_URL || 'ws://127.0.0.1:' + (process.env.PORT || '4799'));
  const got = [];
  const check = () => {
    const okHello = got.find(m => m.type === 'welcome' && m.you === 'A');
    const okJoin = got.find(m => m.type === 'join' && m.name === 'B') || got.find(m => m.type === 'peer' && m.name === 'B');
    const okBeat = got.find(m => m.type === 'peer' && m.name === 'B' && m.state && m.state.hunting === true);
    console.log('welcome:', !!okHello, 'join:', !!okJoin, 'beat-forward:', !!okBeat);
    if (srv) srv.kill();
    process.exit(okHello && okJoin && okBeat ? 0 : 1);
  };
  a.on('message', d => got.push(JSON.parse(d)));
  a.on('open', () => a.send(JSON.stringify({ v: 1, type: 'hello', token: 'k1', name: 'A', state: {} })));
  b.on('open', () => {
    b.send(JSON.stringify({ v: 1, type: 'hello', token: 'k1', name: 'B', state: {} }));
    setTimeout(() => b.send(JSON.stringify({ type: 'beat', name: 'B', state: { hunting: true } })), 600);
  });
  setTimeout(check, 3500);
}, 1200);
