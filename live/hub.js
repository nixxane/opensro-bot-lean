// NIX live hub. Run on the machine the bots run on:  node hub.js
// Bots report to it over localhost; it serves the dashboard and each character's latest report. No dependencies.
// It listens on localhost only. If cloudflared is installed it also opens a free Cloudflare quick tunnel and prints a phone link.
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

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://hub');
  const page = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { ...page, 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(file('dashboard/index.html')));
  }
  // The reporter, ready to install with the code filled in. The code sits in the path so the address still ends in
  // .user.js, which is what makes Tampermonkey offer to install it.
  const install = url.pathname.match(/^\/install\/([^/]+)\/reporter\.user\.js$/);
  if (req.method === 'GET' && install && allowed(install[1])) {
    res.writeHead(200, { ...page, 'Content-Type': 'text/javascript; charset=utf-8' });
    return res.end(fs.readFileSync(file('reporter.user.js'), 'utf8').replace('__CODE__', CODE).replace('__PORT__', PORT));
  }
  if (!allowed(req.headers['x-code'])) return res.writeHead(403).end();

  // The dashboard polls this. A pushed stream would be nicer, but Cloudflare quick tunnels buffer streams until they close.
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { ...page, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...last.values()]));
  }
  if (req.method === 'POST' && url.pathname === '/report') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
    return req.on('end', () => {
      let report;
      try { report = JSON.parse(body); } catch {}
      if (!report || typeof report.name !== 'string' || !report.name || report.name.length > 40) return res.writeHead(400).end();
      report.at = Date.now(); // shortcut: assumes the phone's clock matches this machine's within seconds, send ages instead if "offline" misfires
      last.set(report.name, report);
      res.writeHead(204).end();
    });
  }
  res.writeHead(404).end();
}).on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is in use: the hub is probably already running in another window.' : e);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + PORT;
  console.log('NIX live hub running. Keep this window open; Ctrl-C stops it.\n  Dashboard:        ' + base + '/#' + CODE + '\n  Install reporter: ' + base + '/install/' + CODE + '/reporter.user.js');
  tunnel();
});

// Phone access. A quick tunnel needs no account, but its address is new on every start, so the link is printed each time.
function tunnel() {
  const t = require('node:child_process').spawn('cloudflared', ['tunnel', '--url', 'http://127.0.0.1:' + PORT], { stdio: ['ignore', 'ignore', 'pipe'] });
  let linked = false;
  t.on('error', () => console.log('  Phone link:       not available, cloudflared is not installed (see README.md)'));
  t.on('exit', () => { if (linked) console.log('The tunnel stopped. Restart the hub to get a new phone link.'); });
  require('node:readline').createInterface({ input: t.stderr }).on('line', line => {
    const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (url && !linked) { linked = true; inDns(url[0].slice(8)).then(() => console.log('  Phone link:       ' + url[0] + '/#' + CODE)); }
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
