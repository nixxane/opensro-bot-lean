// Run: node worker.runtime.test.mjs
// The real worker and the real Durable Object in workerd (Miniflare). Nothing leaves this machine and no Cloudflare
// account is involved. Only fake codes and synthetic reports are used.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const CODE = 'runtime-code-0123456789';
const HUB = 'https://nix-live.example.workers.dev';
const here = fileURLToPath(new URL('.', import.meta.url));
const dashboard = fileURLToPath(new URL('./dashboard', import.meta.url));

// The Worker as Cloudflare runs it: bundled by wrangler (this is what pulls in the QR package), config read from wrangler.jsonc.
const outdir = fileURLToPath(new URL('./.wrangler/bundle', import.meta.url));
const built = spawnSync(process.execPath, [fileURLToPath(new URL('./node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'deploy', '--dry-run', '--outdir', outdir], { cwd: here, encoding: 'utf8' });
assert.equal(built.status, 0, 'wrangler deploy --dry-run failed: ' + built.stdout + built.stderr);
const source = fs.readFileSync(outdir + '/worker.js', 'utf8');

const common = {
  // The newest date this workerd supports; wrangler.jsonc names a later one, which wrangler dev lowers the same way.
  modules: true, compatibilityDate: '2026-10-13', script: source,
  durableObjects: { LIVE: { className: 'LiveRoom', useSQLite: true } },
};
const start = (bindings, extra = {}) => new Miniflare(convertV4MiniflareOptions({ ...common, bindings, ...extra }));
const send = (mf, pathname, init = {}) => mf.dispatchFetch(HUB + pathname, init);
const snap = (over = {}) => JSON.stringify({ name: 'Tester', level: 42, state: 'fight', running: true, inWorld: true, dead: false, stats: { kills: '12' }, ...over });

const mf = start({ LIVE_CODE: CODE }, { ratelimits: { LIVE_IP_LIMIT: { namespace_id: '1', simple: { limit: 6, period: 60 } } } });
// What wrangler sets up for assets.run_worker_first: ["/"] in wrangler.jsonc: the Worker answers "/" before the assets do.
const assets = { directory: dashboard, binding: 'ASSETS', routerConfig: { has_user_worker: true }, run_worker_first: ['/'] };
const fresh = start({}, { assets }); // no secret, no stored code: a deployment straight from the button (and no rate limit binding)
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

  // Pairing with a wrong code is a readable 404 page.
  response = await send(mf, '/pair/not-the-code');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/html/);

  // First run, in workerd with the real assets binding: the setup page, no claim by looking, one claim by POST.
  response = await send(fresh, '/');
  assert.equal(response.status, 200);
  let text = await response.text();
  assert.match(text, /Your NIX live hub is running\./);
  assert.doesNotMatch(text, /<title>[^<]*NIX live<\/title>[\s\S]*id="bots"/, 'not the dashboard');
  assert.equal((await send(fresh, '/')).status, 200);
  assert.equal((await send(fresh, '/state', { headers: { 'X-Code': CODE } })).status, 503);
  assert.equal((await send(fresh, '/report', { method: 'OPTIONS' })).status, 204);
  assert.match(await (await send(fresh, '/')).text(), /Create my private link/, 'looking did not claim');

  response = await send(fresh, '/setup', { method: 'POST', redirect: 'manual' });
  assert.equal(response.status, 303);
  const readyPath = response.headers.get('location');
  const claimed = readyPath.slice('/pair/'.length);
  assert.match(claimed, /^[A-Za-z0-9_-]{24}$/);
  assert.equal((await send(fresh, '/setup', { method: 'POST', redirect: 'manual' })).status, 409);

  response = await send(fresh, readyPath);
  assert.equal(response.status, 200);
  text = await response.text();
  assert.match(text, /<svg [^>]*viewBox=/);
  const pairHref = text.match(/href="(https:\/\/opensro\.online\/play#nixlive=[^"]+)"/)[1];
  assert.equal(Buffer.from(pairHref.split('#nixlive=')[1].split(':')[0], 'base64url').toString(), HUB);
  assert.equal(pairHref.split(':').pop(), claimed);
  assert.equal((await send(fresh, '/pair/' + claimed + 'x')).status, 404);

  // The claimed code runs the whole protocol through the real Durable Object, and survives for the next request.
  response = await send(fresh, '/report', { method: 'POST', headers: { 'X-Code': claimed }, body: snap() });
  assert.equal(response.status, 204);
  assert.equal((await send(fresh, '/report', { method: 'POST', headers: { 'X-Code': CODE }, body: snap() })).status, 401);
  response = await send(fresh, '/state', { headers: { 'X-Code': claimed } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reports.length, 1);
  assert.equal((await send(fresh, '/state', { headers: { 'X-Code': 'wrong' } })).status, 401);
  assert.equal((await send(fresh, '/state')).headers.get('access-control-allow-origin'), '*');

  // Once claimed, / is the dashboard from ./dashboard (the assets binding, reached through the Worker).
  response = await send(fresh, '/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), fs.readFileSync(dashboard + '/index.html', 'utf8'));

  // Rate limit: the budget is 6 a minute, and 7 requests have been counted above, so this one is refused.
  let limited = null;
  for (let i = 0; i < 10 && !limited; i++) {
    const r = await send(mf, '/state', { headers: { 'X-Code': CODE } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the rate limit never answered 429');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(limited.headers.get('access-control-allow-origin'), '*');

  // The LIVE_CODE secret on a deployment that already made a code overrides it. Same storage would be needed, so this
  // starts from a clean one: the secret works from the first request and the setup press says "already set up".
  const withSecret = start({ LIVE_CODE: CODE }, { assets });
  try {
    response = await send(withSecret, '/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>[^<]*NIX/i, 'the dashboard, never the setup page');
    assert.equal((await send(withSecret, '/state', { headers: { 'X-Code': CODE } })).status, 200); // a path that is not an asset still reaches the worker
    assert.equal((await send(withSecret, '/setup', { method: 'POST', redirect: 'manual' })).status, 409);
    assert.equal((await send(withSecret, '/pair/' + CODE)).status, 200);
  } finally { await withSecret.dispose(); }

  console.log('ok');
} finally { await mf.dispose(); await fresh.dispose(); }
