// Run: node hub.test.cjs   (starts a hub on a spare port with the tunnel off)
const assert = require('node:assert'), net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 41730, base = 'http://127.0.0.1:' + PORT;
const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], { env: { ...process.env, PORT: String(PORT), TUNNEL: 'off' }, stdio: ['ignore', 'pipe', 'inherit'] });
// fetch() refuses to send a malformed request target, so that one goes over a plain socket.
const raw = text => new Promise(done => {
  let out = '';
  const s = net.connect(PORT, '127.0.0.1', () => s.write(text));
  s.on('data', d => { out += d; }).on('close', () => done(out)).on('error', () => done(out));
  setTimeout(() => s.destroy(), 1000);
});

(async () => {
  await new Promise(ready => hub.stdout.once('data', ready));
  const auth = { 'X-Code': fs.readFileSync(path.join(__dirname, '.code'), 'utf8').trim() };
  const post = body => fetch(base + '/report', { method: 'POST', headers: auth, body });

  // Needs no code and can arrive through the tunnel: it must get 400 and leave the hub running.
  assert.match(await raw('GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'), /^HTTP\/1\.1 400/);
  assert.equal((await fetch(base + '/')).status, 200);

  assert.equal((await fetch(base + '/state')).status, 403);
  assert.equal((await fetch(base + '/state', { headers: { 'X-Code': 'wrong' } })).status, 403);
  assert.equal((await post('garbage')).status, 400);
  assert.equal((await post(JSON.stringify({ name: 'Tester', at: 1, level: 7 }))).status, 204);
  assert.equal((await post(JSON.stringify({ name: 'Tester', level: 8 }))).status, 204);

  const state = await (await fetch(base + '/state', { headers: auth })).json();
  assert.equal(state.reports.length, 1); // the same character is replaced, not added
  assert.equal(state.reports[0].level, 8);
  assert.ok(Math.abs(state.now - state.reports[0].at) < 5000); // stamped with hub time, and the hub's "now" sent alongside
  console.log('ok');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => hub.kill());
