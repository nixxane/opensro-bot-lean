/*
pages.mjs - the small HTML pages of the Worker: first-run setup, "your hub is ready", and the plain "not found"

Plain strings, no framework. Each page is self-contained (one inline style, at most one inline script) and follows the
phone's light or dark setting. The dashboard itself is dashboard/index.html and is not made here. Every value that
reaches a page is escaped; the code is also checked against CODE_PATTERN before the Worker uses it.
*/
import { qrSvg } from './qr.mjs';

export const GAME_URL = 'https://opensro.online/play';
export const CODE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Inline style and script only, no network: a page that shows the private code must not be able to send it anywhere.
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const htmlEscape = text => String(text).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const pairLink = (origin, code) => GAME_URL + '#nixlive=' + toBase64Url(origin) + ':' + code;
export const dashboardLink = (origin, code) => origin + '/#' + code;

const STYLE = `
:root{color-scheme:light dark;--bg:#f4f6f8;--card:#fff;--line:#d7dde4;--text:#161b22;--dim:#5b6675;--ok:#2f9e6a;--okText:#fff;--warn:#fff4d6;--warnLine:#e0b550}
@media(prefers-color-scheme:dark){:root{--bg:#0f1216;--card:#181d24;--line:#27303b;--text:#e8ecf1;--dim:#8a96a6;--ok:#3fb97a;--okText:#04130b;--warn:#2b2412;--warnLine:#8a6d1f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:20px 16px 40px}
h1{margin:0 0 4px;font-size:22px}
.brand{margin:0 0 14px;color:var(--dim);font-size:13px;letter-spacing:.06em;text-transform:uppercase}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
.dim{color:var(--dim);font-size:14px}
ol{margin:0;padding:0;list-style:none;counter-reset:s}
ol>li{counter-increment:s;position:relative;padding:0 0 0 38px;margin:0 0 18px}
ol>li:last-child{margin-bottom:0}
ol>li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:var(--ok);color:var(--okText);font-weight:700;text-align:center;line-height:28px}
ol h2{margin:2px 0 6px;font-size:17px}
.btn{display:block;width:100%;padding:14px 18px;border:0;border-radius:10px;background:var(--ok);color:var(--okText);font:600 17px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}
.btn:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #4a8fe0;outline-offset:2px}
.btn.small{display:inline-block;width:auto;padding:8px 14px;font-size:15px}
.qr{display:block;width:min(100%,260px);margin:10px auto}
.qr svg{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
.row{display:flex;gap:8px;align-items:stretch}
input.link{flex:1;min-width:0;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:14px ui-monospace,Menlo,Consolas,monospace}
.warn{background:var(--warn);border:1px solid var(--warnLine);border-radius:10px;padding:10px 12px;font-size:14px}
a{color:inherit}
`;

function shell(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>' + htmlEscape(title) + '</title>'
    + '<style>' + STYLE + '</style></head><body><main><p class="brand">NIX live</p>' + body + '</main></body></html>';
}

/*
================
setupPage

First run, before any code exists. Nothing is created by showing this page: the button is a POST, so a link preview or a
crawler that only fetches addresses cannot claim the hub.
================
*/
export function setupPage() {
  return shell('NIX live setup', '<h1>Your NIX live hub is running.</h1>'
    + '<p>Create your private link. It opens your dashboard on your phone and pairs your bot with this hub.</p>'
    + '<form method="post" action="/setup" class="card"><button class="btn" type="submit">Create my private link</button>'
    + '<p class="dim" style="margin:12px 0 0">Do this once, now. Whoever presses it first owns this hub, so do it right after deploying.</p></form>');
}

/*
================
readyPage

The page after the code exists, also served later at /pair/<code>. Three steps: pair the bot in this browser, scan the
QR code on the phone, keep the links private. The QR code holds the dashboard link (<hub>/#<code>).
================
*/
export function readyPage(origin, code) {
  const pair = pairLink(origin, code), dashboard = dashboardLink(origin, code);
  return shell('Your NIX hub is ready', '<h1>Your hub is ready</h1><p class="dim">Hub: ' + htmlEscape(origin) + '</p>'
    + '<div class="card"><ol>'
    + '<li><h2>Pair NIX in this browser</h2><a class="btn" href="' + htmlEscape(pair) + '">Pair NIX in this browser</a>'
    + '<p class="dim">Opens the game. NIX asks you to confirm: press <strong>Pair</strong> in its window. Do this in the browser where you play.</p></li>'
    + '<li><h2>Open the dashboard on your phone</h2><div class="qr">' + qrSvg(dashboard, 'QR code for your phone dashboard') + '</div>'
    + '<div class="row"><input class="link" id="link" readonly value="' + htmlEscape(dashboard) + '" aria-label="Phone dashboard link">'
    + '<button class="btn small" id="copy" type="button" hidden>Copy</button></div>'
    + '<p class="dim">Scan the code with your phone camera, or copy the link and send it to yourself. Your characters appear within about 10 seconds of entering the game.</p></li>'
    + '<li><h2>Keep it private</h2><p class="dim" style="margin:0">Bookmark this page to find the links again.</p></li>'
    + '</ol></div>'
    + '<p class="warn"><strong>Anyone with these links can watch your stats.</strong> Do not share this page, the link or the QR code.</p>'
    + '<script>(function(){var b=document.getElementById("copy"),i=document.getElementById("link");if(!b||!i)return;b.hidden=false;'
    + 'b.onclick=function(){i.select();var done=function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},2000)};'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(i.value).then(done,function(){try{document.execCommand("copy");done()}catch(e){}})}'
    + 'else{try{document.execCommand("copy");done()}catch(e){}}};})();</script>');
}

// A second press of Create, or Create on a hub whose code comes from the LIVE_CODE secret.
export function alreadySetupPage() {
  return shell('NIX live is already set up', '<h1>This hub is already set up</h1>'
    + '<p>Its private link was created earlier. Open the page you saved then, or the dashboard link on your phone.</p>'
    + '<div class="card"><h2 style="margin-top:0;font-size:17px">Lost your link?</h2>'
    + '<p class="dim" style="margin:0">In Cloudflare open <strong>Workers &amp; Pages</strong>, your worker, then <strong>Settings</strong> and <strong>Variables and secrets</strong>. '
    + 'Add a secret named <code>LIVE_CODE</code> with any 16 to 64 letters, numbers, <code>-</code> or <code>_</code>. '
    + 'Then open this address followed by <code>/pair/</code> and that code to pair NIX again, or followed by <code>/#</code> and that code on your phone.</p></div>');
}

// Shown for /pair/<wrong code> in a browser: the status is 404, the words are for a person.
export function wrongLinkPage() {
  return shell('Link not recognised', '<h1>That link is not right</h1>'
    + '<p>Open the link from your hub\'s setup page exactly as it was shown. <a href="/">Go to the hub</a>.</p>');
}
