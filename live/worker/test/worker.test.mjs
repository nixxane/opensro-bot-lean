// Run: node worker.test.mjs
// The router and the room with a fake environment. worker.runtime.test.mjs runs the same code in workerd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker, { LiveRoom } from '../worker.mjs';
import jsQR from 'jsqr';
import { deployedUrl, links, newCode } from '../setup.mjs';
import { qrMatrix, qrSvg } from '../qr.mjs';

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
      async get(k) { return rows.has(k) ? structuredClone(rows.get(k)) : undefined; },
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
// Draws the SVG's dark squares into an image and reads it the way a phone camera would.
function decodeQr(svg, scale = 6) {
  const size = Number(svg.match(/viewBox="0 0 (\d+) /)[1]), pixels = size * scale, data = new Uint8ClampedArray(pixels * pixels * 4).fill(255);
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < scale; dx++) {
        const at = ((Number(y) * scale + dy) * pixels + Number(x) * scale + dx) * 4;
        data[at] = data[at + 1] = data[at + 2] = 0;
      }
    }
  }
  return jsQR(data, pixels, pixels)?.data;
}
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

  // A secret that is set but unusable (too short, odd characters, too long) is a mistake worth a clear 500, never a silent fallback.
  for (const LIVE_CODE of ['short', 'has space 0123456789abcdef', 'x'.repeat(65)]) {
    const { env } = setup({ LIVE_CODE });
    assert.equal((await post(env, snap())).status, 500);
    assert.equal((await call(env, '/state')).status, 500);
    assert.equal((await call(env, '/pair/short')).status, 500);
    assert.equal((await call(env, '/')).status, 500);
    assert.equal((await call(env, '/setup', { method: 'POST' })).status, 500);
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
    assert.equal((await call(env, '/')).status, 404); // a code exists, so no setup page; and no assets binding in this fake
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

  // First run: no secret and no stored code. GET / shows the setup page and never claims; reports and state say 503.
  for (const LIVE_CODE of [undefined, '']) {
    const { env, ctx } = setup({ LIVE_CODE, ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    for (let i = 0; i < 3; i++) {
      const page = await call(env, '/');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
      const text = await page.text();
      assert.match(text, /Your NIX live hub is running\./);
      assert.match(text, /<form method="post" action="\/setup"/);
      assert.match(text, /Create my private link/);
      assert.doesNotMatch(text, /dashboard<\/html>/);
    }
    await call(env, '/', { headers: { Accept: 'text/html' } }); // a prefetcher or crawler
    await call(env, '/pair/anything');
    await call(env, '/setup'); // GET on /setup is not a route
    assert.equal(ctx.rows.has('code'), false, 'only a POST claims');
    assert.equal((await call(env, '/state', { headers: { 'X-Code': CODE } })).status, 503);
    assert.match(await (await call(env, '/state', { headers: { 'X-Code': CODE } })).text(), /not set up yet/);
    assert.equal((await post(env, snap())).status, 503);
    assert.equal((await call(env, '/pair/' + CODE)).status, 404);
  }

  // POST /setup claims once and sends the browser to the ready page; the second press is 409 and changes nothing.
  {
    const { env, ctx } = setup({ LIVE_CODE: undefined, ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    const claim = await call(env, '/setup', { method: 'POST' });
    assert.equal(claim.status, 303);
    const target = claim.headers.get('location');
    const stored = ctx.rows.get('code');
    assert.match(stored, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(target, '/pair/' + stored);
    const again = await call(env, '/setup', { method: 'POST' });
    assert.equal(again.status, 409);
    const calm = await again.text();
    assert.match(calm, /Already created/);
    assert.match(calm, /If you pressed twice, go back to the page that opened, or use your saved link\./);
    assert.match(calm, /If you didn't press Create yourself, someone else may have\. Take it back:/);
    assert.match(calm, /Workers &amp; Pages[\s\S]*nix-live[\s\S]*Variables and secrets[\s\S]*Secret[\s\S]*LIVE_CODE[\s\S]*getRandomValues[\s\S]*\/pair\//);
    assert.equal(ctx.rows.get('code'), stored, 'the first code is kept');
    // The claimed code works for the ready page, reports and state; a wrong one does not.
    assert.equal((await call(env, target)).status, 200);
    assert.equal((await call(env, '/pair/' + stored + 'x')).status, 404);
    assert.match((await call(env, '/pair/' + stored + 'x')).headers.get('content-type'), /text\/html/);
    assert.equal((await post(env, snap(), { 'X-Code': stored })).status, 204);
    assert.equal((await post(env, snap(), { 'X-Code': 'wrong' })).status, 401);
    assert.equal((await post(env, snap(), {})).status, 401);
    const asked = await call(env, '/state', { headers: { 'X-Code': stored } });
    assert.equal(asked.status, 200);
    assert.equal((await asked.json()).reports.length, 1);
    const wrong = await call(env, '/state', { headers: { 'X-Code': 'wrong' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('access-control-allow-origin'), '*');
    // Once a code exists, / is the dashboard.
    assert.equal(await (await call(env, '/')).text(), '<html>dashboard</html>');
    // A restart of the room keeps the code.
    const revived = new LiveRoom(ctx);
    await ctx.ready;
    assert.equal(revived.code, stored);
  }

  // Four presses at the same moment still make one code.
  {
    const { env, ctx } = setup({ LIVE_CODE: undefined });
    const results = await Promise.all([1, 2, 3, 4].map(() => call(env, '/setup', { method: 'POST' })));
    assert.deepEqual(results.map(r => r.status).sort(), [303, 409, 409, 409]);
    assert.equal(ctx.counts.put, 1);
  }

  // A form posted from another site is refused and claims nothing; the page's own origin is accepted.
  {
    const { env, ctx } = setup({ LIVE_CODE: undefined });
    assert.equal((await call(env, '/setup', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal(ctx.rows.has('code'), false);
    for (const site of ['cross-site', 'same-site']) assert.equal((await call(env, '/setup', { method: 'POST', headers: { 'Sec-Fetch-Site': site } })).status, 403, site);
    assert.equal(ctx.rows.has('code'), false);
    // Behind a dev server the page's host can differ from the Worker's URL; Sec-Fetch-Site still says same-origin.
    const { env: other, ctx: otherCtx } = setup({ LIVE_CODE: undefined });
    assert.equal((await call(other, '/setup', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'http://127.0.0.1:8799' } })).status, 303);
    assert.ok(otherCtx.rows.has('code'));
    assert.equal((await call(env, '/setup', { method: 'POST', headers: { Origin: HUB } })).status, 303);
  }

  // The setup press is rate limited like everything else when the binding exists.
  {
    const { env, ctx, limit } = setup({ LIVE_CODE: undefined });
    limit(true);
    assert.equal((await call(env, '/setup', { method: 'POST' })).status, 429);
    assert.equal(ctx.rows.has('code'), false);
  }

  // The LIVE_CODE secret overrides a stored code (the recovery path), for pairing, reports and state; Create says "already set up".
  {
    const { env, ctx } = setup({ LIVE_CODE: undefined });
    await call(env, '/setup', { method: 'POST' });
    const stored = ctx.rows.get('code');
    const withSecret = { ...env, LIVE_CODE: CODE };
    assert.equal((await post(withSecret, snap(), { 'X-Code': stored })).status, 401, 'the old code stops working');
    assert.equal((await post(withSecret, snap(), {})).status, 401);
    assert.equal((await post(withSecret, snap(), { 'X-Code': CODE })).status, 204);
    assert.equal((await call(withSecret, '/state', { headers: { 'X-Code': CODE } })).status, 200);
    assert.equal((await call(withSecret, '/pair/' + stored)).status, 404);
    assert.equal((await call(withSecret, '/pair/' + CODE)).status, 200);
    assert.equal((await call(withSecret, '/setup', { method: 'POST' })).status, 409);
    assert.equal(ctx.rows.get('code'), stored, 'removing the secret brings the stored code back');
    assert.equal((await post(env, snap(), { 'X-Code': stored })).status, 204);
  }

  // The ready page: a pair link to the game with this address and code, a QR code (inline <svg>), the link as text, a privacy line.
  {
    const { env } = setup();
    const text = await (await call(env, '/pair/' + CODE)).text();
    assert.match(text, /Pair NIX in this browser/);
    assert.match(text, /<svg [^>]*viewBox="0 0 \d+ \d+"/);
    assert.match(text, /value="https:\/\/nix-live\.example\.workers\.dev\/#test-code-0123456789abcdef"/);
    assert.match(text, /id="copy"/);
    assert.match(text, /Anyone with these links can watch your stats/);
    assert.match(text, /prefers-color-scheme:dark/);
    assert.doesNotMatch(text, /<script[^>]* src=|<link |<img /i, 'nothing is fetched from elsewhere');
    // The QR code decodes to the phone dashboard link.
    assert.equal(decodeQr(text.match(/<svg[\s\S]*?<\/svg>/)[0]), HUB + '/#' + CODE);
  }

  // The encoder: the matrix is square and has the finder patterns; the SVG decodes back to short and long input.
  {
    const matrix = qrMatrix('hello'), n = matrix.length;
    assert.ok(n >= 21 && matrix.every(row => row.length === n));
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
      assert.deepEqual(matrix[r].slice(c, c + 7), Array(7).fill(true), 'finder pattern top edge');
      assert.deepEqual(matrix[r + 3].slice(c + 2, c + 5), [true, true, true], 'finder pattern centre');
    }
    for (const input of ['hello', HUB + '/#' + 'A'.repeat(24), 'https://nix-live.some-very-long-account-name-here.workers.dev/#' + 'a_-'.repeat(21)]) {
      assert.equal(decodeQr(qrSvg(input)), input);
    }
    assert.match(qrSvg('x', 'a "bad" <label>'), /aria-label="a bad label"/);
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

  // The "Deploy to Cloudflare" button copies only this folder: the dashboard lives inside it, no source imports from outside,
  // and no .dev.vars.example (its presence would make the deploy page ask for secrets, which this flow avoids).
  {
    const here = new URL('../', import.meta.url);
    const config = fs.readFileSync(new URL('wrangler.jsonc', here), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const wrangler = JSON.parse(config);
    assert.equal(wrangler.assets.directory, './dashboard');
    assert.deepEqual(wrangler.assets.run_worker_first, ['/']);
    assert.ok(fs.existsSync(new URL('dashboard/index.html', here)));
    assert.equal(wrangler.ratelimits, undefined, 'the button deploy may not support rate limit bindings');
    assert.equal(wrangler.compatibility_date, '2026-10-13', 'the newest date the pinned workerd runs, so wrangler dev starts without flags');
    assert.equal(fs.existsSync(new URL('.dev.vars.example', here)), false);
    for (const file of ['worker.mjs', 'pages.mjs', 'qr.mjs', 'setup.mjs']) {
      const imports = [...fs.readFileSync(new URL(file, here), 'utf8').matchAll(/^import .* from '(\.[^']*)'/gm)].map(m => m[1]);
      for (const target of imports) assert.ok(target.startsWith('./'), file + ' imports ' + target + ' from outside live/worker');
    }
  }

  // Every page a person can open carries the privacy headers: no referrer (the address holds the code), never cached, and a CSP.
  {
    const assets = { fetch: async () => new Response('<html>dashboard</html>', { headers: { 'Cache-Control': 'public, max-age=3600' } }) };
    const unclaimed = setup({ LIVE_CODE: undefined, ASSETS: assets });
    const claimedRoom = setup({ ASSETS: assets });
    const again = setup({ LIVE_CODE: undefined });
    await call(again.env, '/setup', { method: 'POST' });
    const pages = [
      ['unclaimed /', await call(unclaimed.env, '/')],
      ['/pair', await call(claimedRoom.env, '/pair/' + CODE)],
      ['404 page', await call(claimedRoom.env, '/pair/wrong')],
      ['409 page', await call(again.env, '/setup', { method: 'POST' })],
    ];
    assert.deepEqual(pages.map(([, r]) => r.status), [200, 200, 404, 409]);
    for (const [name, page] of pages) {
      assert.equal(page.headers.get('referrer-policy'), 'no-referrer', name);
      assert.equal(page.headers.get('cache-control'), 'no-store', name);
      assert.match(page.headers.get('content-security-policy'), /default-src 'none'/, name);
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff', name);
    }
    // The dashboard from the assets binding: same privacy headers, revalidated rather than stored.
    const dash = await call(claimedRoom.env, '/');
    assert.equal(await dash.text(), '<html>dashboard</html>');
    assert.equal(dash.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(dash.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(dash.headers.get('cache-control'), 'no-cache');
  }

  // HEAD is answered like GET, without a body, for "/" and /pair/...; nothing else answers HEAD.
  {
    const { env } = setup({ ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    const home = await call(env, '/', { method: 'HEAD' });
    assert.equal(home.status, 200);
    assert.equal(await home.text(), '');
    const ready = await call(env, '/pair/' + CODE, { method: 'HEAD' });
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), '');
    assert.match(ready.headers.get('content-type'), /text\/html/);
    assert.equal((await call(env, '/pair/wrong', { method: 'HEAD' })).status, 404);
    assert.equal((await call(env, '/state', { method: 'HEAD', headers: { 'X-Code': CODE } })).status, 404);
    assert.equal((await call(env, '/report', { method: 'HEAD' })).status, 404);
    const fresh = setup({ LIVE_CODE: undefined });
    assert.equal((await call(fresh.env, '/', { method: 'HEAD' })).status, 200);
    assert.equal(fresh.ctx.rows.has('code'), false, 'HEAD never claims');
  }

  // The rate limit also covers /pair (code guessing), when the binding exists.
  {
    const { env, calls, limit } = setup();
    limit(true);
    const refused = await call(env, '/pair/' + CODE);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.equal((await call(env, '/pair/wrong')).status, 429);
    limit(false);
    assert.equal((await call(env, '/pair/' + CODE)).status, 200);
    assert.equal(calls(), 0);
  }

  // Once a stored code has been seen, "/" no longer asks the Durable Object; a secret never does.
  {
    const { env, calls } = setup({ LIVE_CODE: undefined, ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    assert.match(await (await call(env, '/')).text(), /running\./);
    await call(env, '/setup', { method: 'POST' });
    const before = calls();
    assert.equal(await (await call(env, '/')).text(), '<html>dashboard</html>'); // asks once, sees the code
    const asked = calls();
    assert.ok(asked > before);
    await call(env, '/');
    await call(env, '/');
    assert.equal(calls(), asked, 'claimed is remembered');
    const withSecret = setup({ ASSETS: { fetch: async () => new Response('<html>dashboard</html>') } });
    await call(withSecret.env, '/');
    assert.equal(withSecret.calls(), 0, 'LIVE_CODE answers without the room');
  }

  // The ready page: step 1 is on the PC, a phone gets a note to open it there, the copy buttons exist.
  {
    const { env } = setup();
    const text = await (await call(env, '/pair/' + CODE)).text();
    assert.match(text, /On the computer where you play, pair NIX/);
    assert.match(text, /id="phone" hidden>Pairing happens on your PC\. Open this page there too:/);
    assert.match(text, /pointer:coarse/);
    assert.match(text, /id="phonecopy"/);
    assert.match(text, /private window/);
  }

  // The setup button turns itself off on the first press, so a double click posts once.
  {
    const text = await (await call(setup({ LIVE_CODE: undefined }).env, '/')).text();
    assert.match(text, /addEventListener\("submit"[\s\S]*disabled=true/);
  }

  // The wrong-link page offers the takeover steps with a code made in the browser; an unclaimed hub says to press Create instead.
  {
    const { env } = setup();
    const text = await (await call(env, '/pair/wrong')).text();
    assert.match(text, /That link is not right/);
    assert.match(text, /Variables and secrets[\s\S]*LIVE_CODE[\s\S]*getRandomValues/);
    const unclaimed = await (await call(setup({ LIVE_CODE: undefined }).env, '/pair/wrong')).text();
    assert.match(unclaimed, /no private link yet/);
    assert.doesNotMatch(unclaimed, /LIVE_CODE/);
  }

  // The QR code keeps the 4-module quiet zone, and is black on an explicit white square so a dark page cannot invert it.
  {
    const svg = qrSvg('https://nix-live.example.workers.dev/#abc');
    const size = Number(svg.match(/viewBox="0 0 (\d+) /)[1]), modules = qrMatrix('https://nix-live.example.workers.dev/#abc').length;
    assert.equal(size, modules + 8);
    const coords = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(m => [Number(m[1]), Number(m[2])]);
    assert.ok(coords.length > 0);
    for (const [x, y] of coords) assert.ok(x >= 4 && y >= 4 && x <= size - 5 && y <= size - 5, 'a dark module inside the quiet zone');
    assert.match(svg, new RegExp('<rect width="' + size + '" height="' + size + '" fill="#fff"/>'));
    assert.match(svg, /<path fill="#000"/);
    assert.doesNotMatch(svg, /currentColor|var\(/);
  }

  // The dashboard's inline script at least parses (a quote slipped into one of its messages once broke the whole page).
  {
    const page = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
    assert.doesNotThrow(() => new vm.Script(page.match(/<script>([\s\S]*)<\/script>/)[1]));
    // One self-contained file: it makes no request but the same-origin /state poll, and uses no external script, style or font.
    assert.doesNotMatch(page, /<(?:script|link|img|iframe)[^>]*\s(?:src|href)=|@import|url\(\s*['"]?https?:|https?:\/\//i);
    assert.equal((page.match(/fetch\(/g) || []).length, 1);
    assert.match(page, /fetch\('\/state', \{ headers: \{ 'X-Code': code \}/);
  }

  // setup.mjs helpers.
  assert.match(newCode(), /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(newCode(), newCode());
  assert.equal(deployedUrl('Uploaded nix-live\nDeployed nix-live triggers\n  https://nix-live.someone.workers.dev\nCurrent Version ID: 1'), 'https://nix-live.someone.workers.dev');
  assert.equal(deployedUrl('no url here'), '');
  assert.deepEqual(links('https://a.workers.dev', 'abc'), { dashboard: 'https://a.workers.dev/#abc', pair: 'https://a.workers.dev/pair/abc' });

  console.log('ok');
} finally { Date.now = realNow; }
