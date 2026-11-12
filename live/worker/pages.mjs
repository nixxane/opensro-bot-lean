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
[hidden]{display:none!important}
ol.plain{list-style:decimal;padding-left:20px}
ol.plain>li{counter-increment:none;padding:0;margin:0 0 8px}
ol.plain>li::before{content:none}
code{font:13px ui-monospace,Menlo,Consolas,monospace}
.warn .btn{margin-left:6px}
`;


// One copy routine for every page: select the field or use the clipboard, and say "Copied" for two seconds.
const COPY_SCRIPT = 'function nixCopy(b,text){var done=function(){var t=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=t},2000)};'
  + 'var old=function(){try{var i=document.createElement("textarea");i.value=text;document.body.appendChild(i);i.select();document.execCommand("copy");i.remove();done()}catch(e){}};'
  + 'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,old)}else{old()}}';

function shell(title, body, script = '') {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>' + htmlEscape(title) + '</title>'
    + '<style>' + STYLE + '</style></head><body><main><p class="brand">NIX live</p>' + body + '</main>'
    + (script ? '<script>' + COPY_SCRIPT + script + '</script>' : '') + '</body></html>';
}

/*
================
takeoverSteps

How to take a hub back, or to get a new link after losing the old one: set the LIVE_CODE secret in Cloudflare. The page
makes a random code in the browser (crypto.getRandomValues; it never leaves the page) so nobody has to invent one, and
shows the address to open afterwards. The script half is TAKEOVER_SCRIPT; a page that shows the steps passes it to shell().
================
*/
function takeoverSteps(origin) {
  return '<ol class="plain"><li>In Cloudflare open <strong>Workers &amp; Pages</strong>, then <strong>nix-live</strong>, then <strong>Settings</strong>, then <strong>Variables and secrets</strong>.</li>'
    + '<li>Press <strong>Add</strong>, choose type <strong>Secret</strong>, name it <code>LIVE_CODE</code> and paste this as the value:'
    + '<div class="row"><input class="link" id="newcode" readonly aria-label="A ready-made code" value="(your browser makes a code here)"><button class="btn small" id="newcopy" type="button" hidden>Copy</button></div></li>'
    + '<li>Save and deploy, then open <a id="newpair" href="#">' + htmlEscape(origin) + '/pair/&lt;that code&gt;</a> and press Pair in NIX again.</li></ol>';
}
const TAKEOVER_SCRIPT = '(function(){var i=document.getElementById("newcode"),c=document.getElementById("newcopy"),a=document.getElementById("newpair");if(!i||!window.crypto)return;'
  + 'var b=crypto.getRandomValues(new Uint8Array(18)),s="";for(var k=0;k<b.length;k++)s+=String.fromCharCode(b[k]);'
  + 'var code=btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_");i.value=code;c.hidden=false;c.onclick=function(){nixCopy(c,code)};'
  + 'a.href=location.origin+"/pair/"+code;a.textContent=location.origin+"/pair/"+code;})();';
export const TAKEOVER_TEXT = 'Take it back: in Cloudflare open Workers & Pages, nix-live, Settings, Variables and secrets, press Add, choose Secret, name it LIVE_CODE and give it any 16 to 64 letters, numbers, - or _. Then open this hub\'s address followed by /pair/ and that code, and press Pair in NIX again.';

/*
================
setupPage

First run, before any code exists. Nothing is created by showing this page: the button is a POST, so a link preview or a
crawler that only fetches addresses cannot claim the hub. The button turns off on the first press so a double click does
not post twice.
================
*/
export function setupPage() {
  return shell('NIX live setup', '<h1>Your NIX live hub is running.</h1>'
    + '<p>Create your private link. It opens your dashboard on your phone and pairs your bot with this hub.</p>'
    + '<form method="post" action="/setup" class="card"><button class="btn" type="submit">Create my private link</button>'
    + '<p class="dim" style="margin:12px 0 0">Do this once, now. Whoever presses it first owns this hub, so do it right after deploying.</p></form>',
  'document.forms[0].addEventListener("submit",function(){var b=this.querySelector("button");setTimeout(function(){b.disabled=true;b.textContent="Creating\\u2026"},0)});');
}

/*
================
readyPage

The page after the code exists, also served later at /pair/<code>. Pairing happens on the computer where the game runs;
the QR code (the dashboard link, <hub>/#<code>) is for the phone. A phone that opens this page is told to open it on the
PC instead, with a button that copies this page's address.
================
*/
export function readyPage(origin, code) {
  const pair = pairLink(origin, code), dashboard = dashboardLink(origin, code);
  return shell('Your NIX hub is ready', '<h1>Your hub is ready</h1><p class="dim">Hub: ' + htmlEscape(origin) + '</p>'
    + '<div class="warn" id="phone" hidden>Pairing happens on your PC. Open this page there too: <button class="btn small" id="phonecopy" type="button">Copy link</button></div>'
    + '<div class="card"><ol>'
    + '<li><h2>On the computer where you play, pair NIX</h2><a class="btn" href="' + htmlEscape(pair) + '">Pair NIX in this browser</a>'
    + '<p class="dim">Opens the game. NIX asks you to confirm: press <strong>Pair</strong> in its window. Use the browser where NIX is installed.</p></li>'
    + '<li><h2>Open the dashboard on your phone</h2><div class="qr">' + qrSvg(dashboard, 'QR code for your phone dashboard') + '</div>'
    + '<div class="row"><input class="link" id="link" readonly value="' + htmlEscape(dashboard) + '" aria-label="Phone dashboard link">'
    + '<button class="btn small" id="copy" type="button" hidden>Copy</button></div>'
    + '<p class="dim">Scan the code with your phone camera, or copy the link and send it to yourself. Your characters appear within about 10 seconds of entering the game.</p></li>'
    + '<li><h2>Keep it private</h2><p class="dim" style="margin:0">Bookmark this page to find the links again. Opening it in a private window keeps its address out of your history.</p></li>'
    + '</ol></div>'
    + '<p class="warn"><strong>Anyone with these links can watch your stats.</strong> Do not share this page, the link or the QR code.</p>',
  '(function(){var b=document.getElementById("copy"),i=document.getElementById("link");if(b&&i){b.hidden=false;b.onclick=function(){nixCopy(b,i.value)}}'
  + 'var p=document.getElementById("phone"),pc=document.getElementById("phonecopy");'
  + 'if(p&&pc&&((window.matchMedia&&matchMedia("(pointer:coarse)").matches)||innerWidth<600)){p.hidden=false;pc.onclick=function(){nixCopy(pc,location.href)}}})();');
}

/*
================
alreadySetupPage

A second press of Create, or Create on a hub whose code comes from the LIVE_CODE secret. Calm wording first (most of the
time the person pressed twice), then how to take the hub back in case somebody else pressed first.
================
*/
export function alreadySetupPage(origin) {
  return shell('NIX live is already created', '<h1>Already created</h1>'
    + '<p>If you pressed twice, go back to the page that opened, or use your saved link.</p>'
    + '<div class="card"><h2 style="margin-top:0;font-size:17px">Not you, or lost your link?</h2>'
    + '<p class="dim" style="margin-top:0">If you didn\'t press Create yourself, someone else may have. Take it back:</p>' + takeoverSteps(origin) + '</div>', TAKEOVER_SCRIPT);
}

// Shown for /pair/<wrong code> in a browser: the status is 404, the words are for a person.
export function wrongLinkPage(origin, claimed = true) {
  if (!claimed) {
    return shell('NIX live is not set up', '<h1>This hub has no private link yet</h1><p>Open the hub\'s address and press <strong>Create my private link</strong>. <a href="/">Go to the hub</a>.</p>');
  }
  return shell('Link not recognised', '<h1>That link is not right</h1>'
    + '<p>Open the link from your hub\'s setup page exactly as it was shown.</p>'
    + '<div class="card"><h2 style="margin-top:0;font-size:17px">Lost it?</h2>' + takeoverSteps(origin) + '</div>', TAKEOVER_SCRIPT);
}
