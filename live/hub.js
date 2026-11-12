// NIX live hub. Run on the machine the bots run on:  node hub.js
// Bots report to it over localhost or HTTPS; it serves the dashboard and each character's latest report. No dependencies.
// It listens on localhost only. If cloudflared is installed it also opens a free Cloudflare quick tunnel and prints a phone link.
// The bot's built-in Live dashboard needs an HTTPS address: set PUBLIC_URL to a named tunnel's address, or pair with the
// quick tunnel's (testing only: it changes on every start). worker/ is the same contract hosted on the user's own Cloudflare.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4173;
const file = name => path.join(__dirname, name);

// The private code is made once and kept, so the phone link and the installed reporter survive restarts.
let CODE = '';
try { CODE = fs.readFileSync(file('.code'), 'utf8').trim(); } catch {}
if (!CODE) { CODE = crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(file('.code'), CODE + '\n', { mode: 0o600 }); }
const allowed = given => {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const last = new Map(); // character name -> latest report
const FORGET_MS = 24 * 3600 * 1000; // a renamed or deleted character stops reporting; its card goes after a day
const MAX_REPORT_BYTES = 16 * 1024; // a real snapshot is about 3 KB; anything near this is not one

// The address the bot should pair with: PUBLIC_URL (a named tunnel), else the quick tunnel once it is known, else this machine.
// The bot only accepts https://host[:port] with no path, so a trailing slash is dropped here.
let publicOrigin = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '') || 'http://127.0.0.1:' + PORT;
const pairLink = () => 'https://opensro.online/play#nixlive=' + Buffer.from(publicOrigin).toString('base64url') + ':' + CODE;
const htmlEscape = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

// The auth is a header, never a cookie, so any origin may call: the game page at opensro.online is the one that does.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Code',
  'Access-Control-Max-Age': '600',
  'Access-Control-Allow-Private-Network': 'true',
};

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://hub'); } catch { return res.writeHead(400).end(); } // e.g. "GET http://[ HTTP/1.1"
  const page = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  // The browser asks before every cross-origin POST with a header, and sends no X-Code with that question.
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { ...page, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file('worker/dashboard/index.html')));
  }
  // The reporter, ready to install with the code filled in. The code sits in the path so the address still ends in
  // .user.js, which is what makes Tampermonkey offer to install it.
  const install = url.pathname.match(/^\/install\/([^/]+)\/reporter\.user\.js$/);
  if (req.method === 'GET' && install && allowed(install[1])) {
    res.writeHead(200, { ...page, 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(file('reporter.user.js'), 'utf8').replace('__CODE__', CODE).replace('__PORT__', PORT));
  }
  // One button that opens the game with this hub's address and code ready to confirm in the bot's panel.
  const pair = url.pathname.match(/^\/pair\/([^/]+)$/);
  if (req.method === 'GET' && pair) {
    if (!allowed(pair[1])) return res.writeHead(404, CORS).end();
    res.writeHead(200, { ...page, ...CORS, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pair NIX</title>'
      + '<body style="font:16px system-ui;max-width:30em;margin:2em auto;padding:0 1em"><h1>Pair NIX with this hub</h1>'
      + '<p>Open the game with this hub address filled in. NIX will ask you to confirm before it saves anything.</p>'
      + '<p><a href="' + htmlEscape(pairLink()) + '" style="display:inline-block;padding:.7em 1.2em;background:#2ecc71;color:#000;border-radius:8px;text-decoration:none">Open the game and pair</a></p>'
      + '<p>Hub: ' + htmlEscape(publicOrigin) + '</p></body>');
  }
  if (!allowed(req.headers['x-code'])) return res.writeHead(401, CORS).end();

  // The dashboard polls this. A pushed stream would be nicer, but Cloudflare quick tunnels buffer streams until they close.
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { ...page, ...CORS, 'Content-Type': 'application/json' });
    for (const [name, report] of last) if (Date.now() - report.at > FORGET_MS) last.delete(name);
    // "now" travels with the reports so the dashboard measures their age on the hub's clock, not the phone's.
    return res.end(JSON.stringify({ now: Date.now(), reports: [...last.values()] }));
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '', tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_REPORT_BYTES) { tooBig = true; res.writeHead(413, { ...CORS, Connection: 'close' }).end(); }
    });
    return req.on('end', () => {
      if (tooBig) return;
      let report;
      try { report = JSON.parse(body); } catch {}
      if (!report || typeof report.name !== 'string' || !report.name || report.name.length > 40) return res.writeHead(400, CORS).end();
      report.at = Date.now();
      last.set(report.name, report);
      res.writeHead(204, CORS).end();
    });
  }
  res.writeHead(404, CORS).end();
}

// Requests are handled before the code check and can arrive through the tunnel, so none of them may stop the hub.
http.createServer((req, res) => {
  try { handle(req, res); } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
}).on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use: the hub is probably already running in another window.' : e);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + PORT;
  console.log('NIX live hub running. Keep this window open; Ctrl-C stops it.\n  Dashboard:        ' + base + '/#' + CODE + '\n  Install reporter: ' + base + '/install/' + CODE + '/reporter.user.js\n  Pair link:        ' + publicOrigin + '/pair/' + CODE + (process.env.PUBLIC_URL ? '' : '  (the bot needs an https address: set PUBLIC_URL)'));
  if (process.env.TUNNEL !== 'off') tunnel();
});

// Phone access. A quick tunnel needs no account, but its address is new on every start, so the link is printed each time.
function tunnel() {
  const t = require('node:child_process').spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'ignore', 'pipe'] });
  let linked = false;
  t.on('error', () => console.log('  Phone link:       not available, cloudflared is not installed (see README.md)'));
  t.on('exit', () => { if (linked) console.log('The tunnel stopped. Restart the hub to get a new phone link.'); });
  require('node:readline').createInterface({ input: t.stderr }).on('line', line => {
    const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (url && !linked) {
      linked = true;
      if (!process.env.PUBLIC_URL) publicOrigin = url[0];
      inDns(url[0].slice(8)).then(() => console.log('  Phone link:       ' + url[0] + '/#' + CODE + '\n  Pair link:        ' + url[0] + '/pair/' + CODE + '  (testing only: the address changes on every start)'));
    }
    else if (/\bERR\b/.test(line)) console.log(line);
  });
  process.on('exit', () => t.kill());
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());
}

// A tunnel's address reaches DNS a few seconds after cloudflared prints it. A phone or router that looks it up sooner
// remembers "no such site" for minutes, so the link is held back until it resolves (or 30 s pass). The question goes
// straight to 1.1.1.1 so this machine's own resolver is not the one left remembering the miss.
async function inDns(host) {
  const dns = new (require('node:dns').promises.Resolver)();
  dns.setServers(['1.1.1.1']);
  for (let i = 0; i < 30; i++) {
    try { await dns.resolve4(host); return; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}
