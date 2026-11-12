// Run: node worker.test.mjs
// The router and the room with a fake environment. worker.runtime.test.mjs runs the same code in workerd.
import assert from 'node:assert/strict';
import worker, { LiveRoom } from './worker.mjs';
import { deployedUrl, links, newCode } from './setup.mjs';

const CODE = 'test-code-0123456789abcdef';
const HUB = 'https://nix-live.example.workers.dev';

// A Durable Object context kept in a Map. The row counters are what the free plan bills, so the tests watch them.
function fakeContext() {
  const rows = new Map(), counts = { put: 0, delete: 0, setAlarm: 0 };
  let alarm = null, ready = Promise.resolve();
  return {
    rows, counts, get alarm() { return alarm; },
    blockConcurrencyWhile: fn => { ready = fn(); return ready; },
    get ready() { return ready; },
    storage: {
      async list({ prefix }) { return new Map([...rows].filter(([k]) => k.startsWith(prefix))); },
      async put(k, v) { counts.put++; rows.set(k, structuredClone(v)); },
      async delete(k) { counts.delete++; rows.delete(k); },
      async getAlarm() { return alarm; },
      async setAlarm(at) { counts.setAlarm++; alarm = at; },
    },
  };
}

function setup(over = {}) {
  const ctx = fakeContext();
  const room = new LiveRoom(ctx);
  let roomCalls = 0, limited = false;
  const env = {
    LIVE_CODE: CODE,
    LIVE: { idFromName: name => name, get: () => ({ fetch: (...args) => { roomCalls++; return room.fetch(new Request(...args)); } }) },
    LIVE_IP_LIMIT: { limit: async () => ({ success: !limited }) },
    ...over,
  };
  return { ctx, room, env, calls: () => roomCalls, limit: on => { limited = on; } };
}

const call = (env, pathname, init = {}) => worker.fetch(new Request(HUB + pathname, init), env);
const post = (env, body, headers = { 'X-Code': CODE }) => call(env, '/report', { method: 'POST', headers, body });
const authed = extra => ({ 'X-Code': CODE, ...extra });
const state = async env => (await call(env, '/state', { headers: { 'X-Code': CODE } })).json();
const snap = (over = {}) => JSON.stringify({ name: 'Tester', level: 42, state: 'fight', running: true, inWorld: true, dead: false, ...over });

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

try {
  // Preflight is answered without a code, even when the secret is not set up yet.
  for (const env of [setup().env, {}]) {
    const response = await call(env, '/report', { method: 'OPTIONS' });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, X-Code');
    assert.equal(response.headers.get('access-control-max-age'), '600');
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  }

  // No secret, or one that is too short: nothing is served.
  for (const LIVE_CODE of [undefined, '', 'short']) {
    const { env } = setup({ LIVE_CODE });
    assert.equal((await post(env, snap())).status, 500);
    assert.equal((await call(env, '/state')).status, 500);
    assert.equal((await call(env, '/pair/short')).status, 500);
    assert.match(await (await call(env, '/state')).text(), /LIVE_CODE/);
  }

  // Wrong or missing code, on every route, with CORS so the page can read the status.
  {
    const { env, calls } = setup();
    for (const headers of [{}, { 'X-Code': 'wrong' }, { 'X-Code': CODE + 'x' }, { 'X-Code': CODE.slice(1) }]) {
      const response = await post(env, snap(), headers);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal((await call(env, '/state', { headers })).status, 401);
    }
    assert.equal(calls(), 0); // the room is never reached without the code
    assert.equal((await call(env, '/nothing', { headers: { 'X-Code': CODE } })).status, 404);
    assert.equal((await call(env, '/report', { headers: { 'X-Code': CODE } })).status, 404); // GET is not a report
    assert.equal((await call(env, '/')).status, 404); // no assets binding in this fake
    assert.equal((await call(env, '/', { method: 'GET' }).then(r => r.headers.get('access-control-allow-origin'))), '*');
  }

  // Report then state: one card per character, replaced not added, stamped with the room's clock.
  {
    const { env } = setup();
    assert.equal((await post(env, snap())).status, 204);
    clock += 1000;
    assert.equal((await post(env, snap({ xpPct: 12.5 }))).status, 204);
    assert.equal((await post(env, snap({ name: 'Other' }))).status, 204);
    const body = await state(env);
    assert.equal(body.now, clock);
    assert.deepEqual(body.reports.map(r => r.name).sort(), ['Other', 'Tester']);
    const tester = body.reports.find(r => r.name === 'Tester');
    assert.equal(tester.xpPct, 12.5);
    assert.equal(tester.at, clock);
    const stateResponse = await call(env, '/state', { headers: { 'X-Code': CODE } });
    assert.equal(stateResponse.headers.get('cache-control'), 'no-store');
  }

  // Validation: size, shape, name.
  {
    const { env } = setup();
    assert.equal((await post(env, 'garbage')).status, 400);
    assert.equal((await post(env, '[]')).status, 400);
    assert.equal((await post(env, '')).status, 400);
    assert.equal((await post(env, JSON.stringify({ level: 1 }))).status, 400);
    assert.equal((await post(env, JSON.stringify({ name: 'x'.repeat(41) }))).status, 400);
    assert.equal((await post(env, JSON.stringify({ name: 7 }))).status, 400);
    const big = snap({ pad: 'x'.repeat(17000) });
    assert.equal((await post(env, big)).status, 413);
    assert.equal((await post(env, big, authed({ 'Content-Length': '10' }))).status, 413); // a header that lies about the size
    assert.equal((await post(env, snap({ pad: 'x'.repeat(15000) }))).status, 204); // a large but legal report
    assert.equal((await state(env)).reports.length, 1);
  }

  // Rate limit: 429 with Retry-After, and the room is not touched.
  {
    const { env, calls, limit } = setup();
    limit(true);
    const response = await post(env, snap());
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal((await call(env, '/state', { headers: { 'X-Code': CODE } })).status, 429);
    assert.equal((await call(env, '/state', { headers: { 'X-Code': 'wrong' } })).status, 429); // guessing is limited too
    assert.equal(calls(), 0);
    limit(false);
    assert.equal((await post(env, snap())).status, 204);
  }

  // Pairing: right code gives the page with this address and code; a wrong one is a plain 404.
  {
    const { env } = setup();
    assert.equal((await call(env, '/pair/wrong')).status, 404);
    assert.equal((await call(env, '/pair/' + CODE + 'x')).status, 404);
    const page = await call(env, '/pair/' + CODE);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const link = (await page.text()).match(/href="(https:\/\/opensro\.online\/play#nixlive=[^"]+)"/)[1];
    const [encoded, code] = link.split('#nixlive=')[1].split(':');
    assert.equal(Buffer.from(encoded, 'base64url').toString(), HUB);
    assert.equal(code, CODE);
  }

  // The dashboard falls back to the assets binding when the worker is asked for it.
  {
    const { env } = setup({ ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    assert.equal(await (await call(env, '/')).text(), '<html>dashboard</html>');
  }

  // Characters that stopped reporting are dropped after 24 h, from memory and from storage.
  {
    const { env, ctx } = setup();
    await post(env, snap());
    clock += 24 * 3600 * 1000 - 1000;
    await post(env, snap({ name: 'Fresh' }));
    assert.equal((await state(env)).reports.length, 2);
    clock += 2000;
    assert.deepEqual((await state(env)).reports.map(r => r.name), ['Fresh']);
    assert.ok(!ctx.rows.has('bot:Tester'));
    assert.ok(ctx.rows.has('bot:Fresh'));
  }

  // Storage writes are billed: an unchanged character is written once a minute, a changed headline at once.
  {
    const { env, ctx } = setup();
    await post(env, snap());
    assert.equal(ctx.counts.put, 1);
    for (let i = 0; i < 5; i++) { clock += 10000; await post(env, snap({ xpPct: i })); }
    assert.equal(ctx.counts.put, 1); // 50 s of reports, no new rows
    clock += 10000;
    await post(env, snap());
    assert.equal(ctx.counts.put, 2); // a minute has passed
    clock += 1000;
    await post(env, snap({ state: 'loot' }));
    assert.equal(ctx.counts.put, 3); // the headline changed
    clock += 1000;
    await post(env, snap({ level: 43, state: 'loot' }));
    assert.equal(ctx.counts.put, 4);
    assert.equal(ctx.counts.setAlarm, 1); // one alarm for the room, never one per report
  }

  // After the object is evicted and rebuilt, storage brings the characters back; the daily alarm drops stale ones.
  {
    const { env, ctx } = setup();
    await post(env, snap());
    await post(env, snap({ name: 'Old' }));
    const revived = new LiveRoom(ctx);
    await ctx.ready;
    assert.deepEqual([...revived.bots.keys()].sort(), ['Old', 'Tester']);
    assert.notEqual(ctx.alarm, null);
    clock += 24 * 3600 * 1000 + 1000;
    await revived.alarm();
    assert.equal(revived.bots.size, 0);
    assert.equal(ctx.rows.size, 0);
    assert.equal(revived.alarmArmed, false); // nothing left to collect, so no alarm is kept
  }

  // A code holder cannot grow the room without bound.
  {
    const { env } = setup();
    for (let i = 0; i < 50; i++) assert.equal((await post(env, snap({ name: 'c' + i }))).status, 204);
    assert.equal((await post(env, snap({ name: 'one-too-many' }))).status, 400);
    assert.equal((await post(env, snap({ name: 'c3', level: 50 }))).status, 204); // an existing character still updates
  }

  // setup.mjs helpers.
  assert.match(newCode(), /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(newCode(), newCode());
  assert.equal(deployedUrl('Uploaded nix-live\nDeployed nix-live triggers\n  https://nix-live.someone.workers.dev\nCurrent Version ID: 1'), 'https://nix-live.someone.workers.dev');
  assert.equal(deployedUrl('no url here'), '');
  assert.deepEqual(links('https://a.workers.dev', 'abc'), { dashboard: 'https://a.workers.dev/#abc', pair: 'https://a.workers.dev/pair/abc' });

  console.log('ok');
} finally { Date.now = realNow; }
