// Run: node worker.runtime.test.mjs
// The real worker and the real Durable Object in workerd (Miniflare). Nothing leaves this machine and no Cloudflare
// account is involved. Only fake codes and synthetic reports are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const CODE = 'runtime-code-0123456789';
const HUB = 'https://nix-live.example.workers.dev';
const source = fs.readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
const dashboard = fileURLToPath(new URL('../dashboard', import.meta.url));

const common = {
  modules: true, compatibilityDate: '2026-10-11', script: source,
  durableObjects: { LIVE: { className: 'LiveRoom', useSQLite: true } },
};
const start = (bindings, extra = {}) => new Miniflare(convertV4MiniflareOptions({ ...common, bindings, ...extra }));
const send = (mf, pathname, init = {}) => mf.dispatchFetch(HUB + pathname, init);
const snap = (over = {}) => JSON.stringify({ name: 'Tester', level: 42, state: 'fight', running: true, inWorld: true, dead: false, stats: { kills: '12' }, ...over });

const mf = start({ LIVE_CODE: CODE }, { ratelimits: { LIVE_IP_LIMIT: { namespace_id: '1', simple: { limit: 6, period: 60 } } } });
const bare = start({}); // no secret
try {
  // Preflight needs no code.
  let response = await send(mf, '/report', { method: 'OPTIONS', headers: { Origin: 'https://opensro.online', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, X-Code');

  // Wrong code.
  response = await send(mf, '/state', { headers: { 'X-Code': 'wrong' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');

  // A report, then the state, through the real Durable Object.
  response = await send(mf, '/report', { method: 'POST', headers: { 'X-Code': CODE, 'Content-Type': 'application/json' }, body: snap() });
  assert.equal(response.status, 204);
  response = await send(mf, '/report', { method: 'POST', headers: { 'X-Code': CODE }, body: snap({ level: 43 }) });
  assert.equal(response.status, 204);
  response = await send(mf, '/state', { headers: { 'X-Code': CODE } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reports.length, 1); // replaced, not added
  assert.equal(body.reports[0].level, 43);
  assert.equal(body.reports[0].stats.kills, '12');
  assert.ok(Math.abs(body.now - body.reports[0].at) < 10000);

  // Oversize and malformed.
  response = await send(mf, '/report', { method: 'POST', headers: { 'X-Code': CODE }, body: snap({ pad: 'x'.repeat(17000) }) });
  assert.equal(response.status, 413);
  response = await send(mf, '/report', { method: 'POST', headers: { 'X-Code': CODE }, body: 'garbage' });
  assert.equal(response.status, 400);

  // Pairing.
  response = await send(mf, '/pair/' + CODE);
  assert.equal(response.status, 200);
  const link = (await response.text()).match(/href="(https:\/\/opensro\.online\/play#nixlive=[^"]+)"/)[1];
  const [encoded, code] = link.split('#nixlive=')[1].split(':');
  assert.equal(Buffer.from(encoded, 'base64url').toString(), HUB);
  assert.equal(code, CODE);
  assert.equal((await send(mf, '/pair/not-the-code')).status, 404);

  // Missing secret: nothing is served, but the preflight still answers.
  assert.equal((await send(bare, '/state', { headers: { 'X-Code': CODE } })).status, 500);
  assert.equal((await send(bare, '/pair/' + CODE)).status, 500);
  assert.equal((await send(bare, '/report', { method: 'OPTIONS' })).status, 204);

  // Rate limit: the budget is 6 a minute, and 7 requests have been counted above, so this one is refused.
  let limited = null;
  for (let i = 0; i < 10 && !limited; i++) {
    const r = await send(mf, '/state', { headers: { 'X-Code': CODE } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the rate limit never answered 429');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.headers.get('access-control-allow-origin'), '*');

  // The dashboard: the assets binding serves live/dashboard/index.html (has_user_worker is what wrangler sets when the config has a main script).
  const withAssets = start({ LIVE_CODE: CODE }, { assets: { directory: dashboard, binding: 'ASSETS', routerConfig: { has_user_worker: true } } });
  try {
    response = await send(withAssets, '/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>[^<]*NIX/i);
    response = await send(withAssets, '/state', { headers: { 'X-Code': CODE } });
    assert.equal(response.status, 200); // a path that is not an asset still reaches the worker
  } finally { await withAssets.dispose(); }

  console.log('ok');
} finally { await mf.dispose(); await bare.dispose(); }
