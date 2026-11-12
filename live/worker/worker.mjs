/*
NIX live worker: the live hub (live/hub.js) on your own Cloudflare account.

One Worker serves the dashboard (live/dashboard, as a static asset) and takes the bots' reports; one Durable Object,
LiveRoom, keeps each character's latest report. One shared code per deployment, kept as the Worker secret LIVE_CODE:
there are no accounts. Nothing here talks to NIX or anyone else.

Routes (same contract as live/hub.js):
  OPTIONS *            204 with CORS, answered before any code check (the browser sends no X-Code with a preflight)
  POST /report         X-Code. Body = one snapshot, at most 16 KB. 204.
  GET  /state          X-Code. { now, reports: [latest report per character] }
  GET  /pair/<code>    The code is in the path. One button to the game with this address filled in. 404 on a wrong code.
  GET  /               The dashboard (served by the assets binding before this code runs).
Wrong code 401, unknown route 404, too large 413, rate limited 429 with Retry-After, secret missing 500.

Free plan budget (100k requests/day): one bot reporting every 10 s is 8.6k, one open dashboard polling every 10 s is
8.6k. The room writes storage at most once a minute per character, unless the visible state changes (100k writes/day).
*/

const MAX_REPORT_BYTES = 16 * 1024;
const MIN_CODE_LENGTH = 16;
const MAX_NAME_LENGTH = 40;
const MAX_CHARACTERS = 50; // a code holder cannot grow the room without bound
const FORGET_MS = 24 * 3600 * 1000; // a renamed or deleted character stops reporting; its card goes after a day
const PERSIST_MS = 60 * 1000; // storage rows are billed, so an unchanged character is written at most this often
const GC_MS = 24 * 3600 * 1000; // one alarm a day, never one per report
const RETRY_AFTER_SECONDS = 60;
const GAME_URL = 'https://opensro.online/play';

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

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const htmlEscape = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

function pairPage(origin, code) {
  const link = GAME_URL + '#nixlive=' + toBase64Url(origin) + ':' + code;
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pair NIX</title>'
    + '<body style="font:16px system-ui;max-width:30em;margin:2em auto;padding:0 1em"><h1>Pair NIX with this hub</h1>'
    + '<p>Open the game with this hub address filled in. NIX will ask you to confirm before it saves anything.</p>'
    + '<p><a href="' + htmlEscape(link) + '" style="display:inline-block;padding:.7em 1.2em;background:#2ecc71;color:#000;border-radius:8px;text-decoration:none">Open the game and pair</a></p>'
    + '<p>Hub: ' + htmlEscape(origin) + '</p></body>';
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return reply(204, null);
    const url = new URL(request.url);
    const pair = request.method === 'GET' ? url.pathname.match(/^\/pair\/([^/]+)$/) : null;
    const isReport = request.method === 'POST' && url.pathname === '/report';
    const isState = request.method === 'GET' && url.pathname === '/state';
    if (!isReport && !isState && !pair) {
      // The dashboard normally never gets here (assets answer first); this covers a deployment without the binding.
      if (request.method === 'GET' && url.pathname === '/' && env.ASSETS) return env.ASSETS.fetch(request);
      return reply(404, null);
    }
    const wanted = env.LIVE_CODE;
    if (typeof wanted !== 'string' || wanted.length < MIN_CODE_LENGTH) {
      return reply(500, 'The LIVE_CODE secret is missing or too short. Run "npm run setup" in live/worker.', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (pair) {
      if (!(await sameCode(pair[1], wanted))) return reply(404, null);
      return reply(200, pairPage(url.origin, wanted), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    // Before the code check, so guessing codes is limited too. A deployment without the binding is not limited.
    if (typeof env.LIVE_IP_LIMIT?.limit === 'function') {
      const key = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.LIVE_IP_LIMIT.limit({ key })).success) return reply(429, null, { 'Retry-After': String(RETRY_AFTER_SECONDS) });
    }
    if (!(await sameCode(request.headers.get('X-Code'), wanted))) return reply(401, null);

    const room = env.LIVE.get(env.LIVE.idFromName('room')); // one code per deployment, so one room
    if (isState) {
      const answer = await room.fetch('https://room/state');
      return reply(200, await answer.json());
    }
    const read = await readReport(request);
    if (read.status) return reply(read.status, null);
    const answer = await room.fetch('https://room/report', { method: 'POST', body: JSON.stringify(read.report) });
    return reply(answer.status, null);
  },
};

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
    ctx.blockConcurrencyWhile(async () => {
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
