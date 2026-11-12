// Run: node hub.test.cjs   (starts a hub on a spare port with the tunnel off)
const assert = require('node:assert'), net = require('node:net'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 41730, base = 'http://127.0.0.1:' + PORT;
const hub = spawn(process.execPath, [path.join(__dirname, 'hub.js')], { env: { ...process.env, PORT: String(PORT), TUNNEL: 'off', PUBLIC_URL: 'https://hub.example.com/' }, stdio: ['ignore', 'pipe', 'inherit'] });
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

  assert.equal((await fetch(base + '/state')).status, 401);
  assert.equal((await fetch(base + '/state', { headers: { 'X-Code': 'wrong' } })).status, 401);

  // Preflight: no code is sent with it, and the game page (another origin) needs these headers to be allowed through.
  const preflight = await fetch(base + '/report', { method: 'OPTIONS', headers: { Origin: 'https://opensro.online', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-code' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type, X-Code');
  assert.equal(preflight.headers.get('access-control-max-age'), '600');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.equal((await fetch(base + '/state', { method: 'OPTIONS' })).status, 204);
  assert.equal((await fetch(base + '/pair/x', { method: 'OPTIONS' })).status, 204);
  // Refusals carry the headers too, or the page could not read the status and tell "wrong code" from "unreachable".
  assert.equal((await fetch(base + '/state')).headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(base + '/nothing', { headers: auth })).status, 404);

  // Pairing: the page names the configured public origin and the code, and a wrong code learns nothing.
  assert.equal((await fetch(base + '/pair/wrong')).status, 404);
  const pairPage = await fetch(base + '/pair/' + auth['X-Code']);
  assert.equal(pairPage.status, 200);
  assert.match(pairPage.headers.get('content-type'), /text\/html/);
  const link = (await pairPage.text()).match(/href="(https:\/\/opensro\.online\/play#nixlive=[^"]+)"/)[1];
  const [encoded, pairedCode] = link.split('#nixlive=')[1].split(':');
  assert.equal(Buffer.from(encoded, 'base64url').toString(), 'https://hub.example.com'); // trailing slash dropped
  assert.equal(pairedCode, auth['X-Code']);
  assert.equal((await post('garbage')).status, 400);
  assert.equal((await post(JSON.stringify({ name: 'Big', pad: 'x'.repeat(17000) }))).status, 413);
  assert.equal((await post(JSON.stringify({ name: 'Tester', at: 1, level: 7 }))).status, 204);
  assert.equal((await post(JSON.stringify({ name: 'Tester', level: 8 }))).status, 204);

  const state = await (await fetch(base + '/state', { headers: auth })).json();
  assert.equal(state.reports.length, 1); // the same character is replaced, not added
  assert.equal(state.reports[0].level, 8);
  assert.ok(Math.abs(state.now - state.reports[0].at) < 5000); // stamped with hub time, and the hub's "now" sent alongside
  console.log('ok');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => hub.kill());
