/*
NIX live worker: the live hub (live/hub.js) on your own Cloudflare account.

One Worker serves the dashboard (dashboard/, a static asset) and takes the bots' reports; one Durable Object, LiveRoom,
keeps each character's latest report and the hub's code. One shared code per deployment, no accounts. Nothing here talks
to NIX or anyone else. This folder is self-contained on purpose: the "Deploy to Cloudflare" button copies only it.

The code: the first visit to / shows a setup page whose button (a POST) makes the code and stores it in the room. The
optional Worker secret LIVE_CODE, when set, wins over the stored code; that is also how a lost link is recovered.

Routes (same contract as live/hub.js, plus /setup):
  OPTIONS *            204 with CORS, answered before any code check (the browser sends no X-Code with a preflight)
  POST /report         X-Code. Body = one snapshot, at most 16 KB. 204.
  GET  /state          X-Code. { now, reports: [latest report per character] }
  GET  /pair/<code>    The code is in the path. The "ready" page: pair button, QR code for the phone. 404 on a wrong code.
  GET  /               The dashboard, or the setup page while no code exists.
  POST /setup          Creates the code once (303 to /pair/<code>). 409 when a code exists.
Wrong code 401, no code yet 503, unknown route 404, too large 413, rate limited 429 with Retry-After, bad secret 500.

Free plan budget (100k requests/day): one bot reporting every 10 s is 8.6k, one open dashboard polling every 10 s is
8.6k. The room writes storage at most once a minute per character, unless the visible state changes (100k writes/day).
*/
import { CODE_PATTERN, PAGE_CSP, alreadySetupPage, readyPage, setupPage, wrongLinkPage } from './pages.mjs';

const MAX_REPORT_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 40;
const MAX_CHARACTERS = 50; // a code holder cannot grow the room without bound
const FORGET_MS = 24 * 3600 * 1000; // a renamed or deleted character stops reporting; its card goes after a day
const PERSIST_MS = 60 * 1000; // storage rows are billed, so an unchanged character is written at most this often
const GC_MS = 24 * 3600 * 1000; // one alarm a day, never one per report
const RETRY_AFTER_SECONDS = 60;
const CODE_BYTES = 18; // 144 bits, 24 characters of base64url
const CODE_KEY = 'code';
const HTML = { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP };
const TEXT = { 'Content-Type': 'text/plain; charset=utf-8' };

// The auth is a header, never a cookie, so any origin may call. The game page at opensro.online is the one that does.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Code',
  'Access-Control-Max-Age': '600',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Expose-Headers': 'Retry-After',
};
const PAGE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function reply(status, body, headers = {}) {
  const json = body !== null && typeof body === 'object';
  return new Response(status === 204 ? null : json ? JSON.stringify(body) : body ?? null, {
    status,
    headers: { ...PAGE, ...CORS, ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
}

// Compared as SHA-256 digests so the time taken does not depend on how much of the code was right, or on its length.
async function sameCode(given, wanted) {
  const digest = async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text ?? ''))));
  const [a, b] = await Promise.all([digest(given), digest(wanted)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/*
================
secretCode

The LIVE_CODE secret, if the owner set one: { code } when usable, { bad: true } when set but not 16 to 64 letters,
numbers, - or _ (the pair link and the bot would refuse it), {} when not set. An empty value counts as not set.
================
*/
function secretCode(env) {
  const value = env.LIVE_CODE;
  if (value === undefined || value === null || value === '') return {};
  return typeof value === 'string' && CODE_PATTERN.test(value) ? { code: value } : { bad: true };
}

const badSecret = () => reply(500, 'The LIVE_CODE secret must be 16 to 64 letters, numbers, - or _. Fix it in Cloudflare (Workers, your worker, Settings, Variables and secrets), or delete it to use the code made by the setup page.', TEXT);
const html = (status, page, headers = {}) => reply(status, page, { ...HTML, ...headers });
const room = env => env.LIVE.get(env.LIVE.idFromName('room')); // one code per deployment, so one room

async function storedCode(env) {
  const answer = await room(env).fetch('https://room/code');
  return (await answer.json()).code;
}

// Reads at most MAX_REPORT_BYTES. A lying Content-Length is caught by the first check, a missing one by the count.
async function readReport(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_REPORT_BYTES) return { status: 413 };
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPORT_BYTES) { await reader.cancel(); return { status: 413 }; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let report;
  try { report = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { status: 400 }; }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { status: 400 };
  if (typeof report.name !== 'string' || !report.name || report.name.length > MAX_NAME_LENGTH) return { status: 400 };
  return { report };
}

/*
================
limited

True when this client is over the per-IP budget. Before any code check, so guessing codes is limited too. A deployment
without the LIVE_IP_LIMIT binding (the Deploy button does not create one) is not limited.
================
*/
async function limited(request, env) {
  if (typeof env.LIVE_IP_LIMIT?.limit !== 'function') return false;
  const key = request.headers.get('CF-Connecting-IP') || 'unknown';
  return !(await env.LIVE_IP_LIMIT.limit({ key })).success;
}

/*
================
setup

POST /setup. Creates the code once. A form posted from another site is refused.
================
*/
async function setup(request, env, url, secret) {
  // Browsers say where a request came from in Sec-Fetch-Site, which stays right behind a proxy or a dev server that
  // rewrites the host; Origin is the fallback for a browser that does not send it.
  const site = request.headers.get('Sec-Fetch-Site'), origin = request.headers.get('Origin');
  if (site ? site !== 'same-origin' && site !== 'none' : origin && origin !== url.origin) return reply(403, null);
  if (await limited(request, env)) return reply(429, null, { 'Retry-After': String(RETRY_AFTER_SECONDS) });
  if (secret.code) return html(409, alreadySetupPage());
  const answer = await room(env).fetch('https://room/claim', { method: 'POST' });
  if (answer.status !== 201) return html(409, alreadySetupPage());
  const { code } = await answer.json();
  return reply(303, null, { Location: '/pair/' + code }); // a reload shows the page again instead of posting twice
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return reply(204, null);
    const url = new URL(request.url);
    const isHome = request.method === 'GET' && url.pathname === '/';
    const isSetup = request.method === 'POST' && url.pathname === '/setup';
    const pair = request.method === 'GET' ? url.pathname.match(/^\/pair\/([^/]+)$/) : null;
    const isReport = request.method === 'POST' && url.pathname === '/report';
    const isState = request.method === 'GET' && url.pathname === '/state';
    if (!isHome && !isSetup && !isReport && !isState && !pair) return reply(404, null);

    const secret = secretCode(env);
    if (secret.bad) return badSecret();
    if (isSetup) return setup(request, env, url, secret);

    if (isHome) {
      // The dashboard once a code exists, the setup page before. (The assets binding runs after this code for "/".)
      if (!secret.code && !(await storedCode(env))) return html(200, setupPage());
      return env.ASSETS ? env.ASSETS.fetch(request) : reply(404, null);
    }
    if (pair) {
      const wanted = secret.code || (await storedCode(env));
      if (!wanted || !(await sameCode(pair[1], wanted))) return html(404, wrongLinkPage());
      return html(200, readyPage(url.origin, wanted));
    }

    if (await limited(request, env)) return reply(429, null, { 'Retry-After': String(RETRY_AFTER_SECONDS) });
    const given = request.headers.get('X-Code');
    // With the secret the Worker checks the code itself; with the stored code the room does, so a report is one
    // Durable Object request, not two (the free plan counts them).
    if (secret.code && !(await sameCode(given, secret.code))) return reply(401, null);
    const headers = secret.code ? {} : { 'X-Code': given ?? '' };

    if (isState) {
      const answer = await room(env).fetch('https://room/state', { headers });
      return answer.status === 200 ? reply(200, await answer.json()) : roomRefusal(answer.status);
    }
    const read = await readReport(request);
    if (read.status) return reply(read.status, null);
    const answer = await room(env).fetch('https://room/report', { method: 'POST', body: JSON.stringify(read.report), headers });
    return answer.status === 204 ? reply(204, null) : roomRefusal(answer.status);
  },
};

// 401: wrong code. 503: no code exists yet, so nothing can be right (the bot retries on a 503 instead of switching off).
function roomRefusal(status) {
  if (status === 503) return reply(503, 'This hub is not set up yet. Open its address in a browser and press Create my private link.', { ...TEXT, 'Retry-After': String(RETRY_AFTER_SECONDS) });
  return reply(status, null);
}

/*
================
LiveRoom

The latest report per character. Memory answers every read; storage only survives the object being evicted, so a
character is written when its visible state changes or once a minute, not on every report. After an eviction the
room can be up to a minute behind, which the dashboard shows as the report's age.
================
*/
export class LiveRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.bots = new Map(); // name -> latest report
    this.persisted = new Map(); // name -> { at, key } of the last storage write
    this.alarmArmed = false;
    this.code = null; // the stored code; null until the setup page has made one
    ctx.blockConcurrencyWhile(async () => {
      this.code = (await ctx.storage.get(CODE_KEY)) ?? null;
      const rows = await ctx.storage.list({ prefix: 'bot:' });
      for (const [key, report] of rows) {
        const name = key.slice(4);
        this.bots.set(name, report);
        this.persisted.set(name, { at: report.at, key: LiveRoom.visible(report) });
      }
      this.alarmArmed = (await ctx.storage.getAlarm()) !== null;
    });
  }

  // What the dashboard shows as the headline. A change here is written at once.
  static visible(report) {
    return [report.level, report.state, report.running, report.inWorld, report.dead].join('|');
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/code') return Response.json({ code: this.code });
    if (path === '/claim' && request.method === 'POST') {
      if (this.code) return new Response(null, { status: 409 }); // the claim is once: storage and memory agree before any await
      this.code = newCode();
      await this.ctx.storage.put(CODE_KEY, this.code);
      return Response.json({ code: this.code }, { status: 201 });
    }
    // The Worker sends X-Code only when the stored code is the one in force; the secret is checked by the Worker.
    const given = request.headers.get('X-Code');
    if (given !== null) {
      if (!this.code) return new Response(null, { status: 503 });
      if (!(await sameCode(given, this.code))) return new Response(null, { status: 401 });
    }
    if (path === '/state') {
      await this.forget();
      // "now" travels with the reports so the dashboard measures their age on this clock, not the phone's.
      return Response.json({ now: Date.now(), reports: [...this.bots.values()] });
    }
    if (path === '/report' && request.method === 'POST') {
      const report = await request.json();
      if (!this.bots.has(report.name) && this.bots.size >= MAX_CHARACTERS) return new Response(null, { status: 400 });
      report.at = Date.now();
      this.bots.set(report.name, report);
      const before = this.persisted.get(report.name), key = LiveRoom.visible(report);
      if (!before || before.key !== key || report.at - before.at >= PERSIST_MS) {
        this.persisted.set(report.name, { at: report.at, key });
        await this.ctx.storage.put('bot:' + report.name, report);
      }
      if (!this.alarmArmed) { this.alarmArmed = true; await this.ctx.storage.setAlarm(Date.now() + GC_MS); }
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }

  // Drops characters that stopped reporting. Called on every read and by the daily alarm.
  async forget() {
    for (const [name, report] of this.bots) {
      if (Date.now() - report.at <= FORGET_MS) continue;
      this.bots.delete(name);
      this.persisted.delete(name);
      await this.ctx.storage.delete('bot:' + name);
    }
  }

  async alarm() {
    await this.forget();
    this.alarmArmed = false;
    if (this.bots.size) { this.alarmArmed = true; await this.ctx.storage.setAlarm(Date.now() + GC_MS); }
  }
}
