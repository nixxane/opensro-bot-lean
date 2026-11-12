// ==UserScript==
// @name         NIX live reporter
// @namespace    nix-live
// @version      1.2.0
// @description  Sends the NIX bot's live stats to the NIX live hub on this machine. Read-only: never sends game commands.
// @match        https://opensro.online/play*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @noframes
// ==/UserScript==

// Install from the hub's "Install reporter" link and both values are filled in for you.
const HUB = 'http://127.0.0.1:__PORT__';
const CODE = '__CODE__';
const EVERY_MS = 5000;

// One snapshot of what the bot exposes on window.SROLean. Returns null until a character is known.
function snapshot(B) {
  const w = B.world, name = w.charName;
  if (!name) return null;
  const p = w.gp?.progression || {}, me = w.me(), pose = w.pose(), pct = gaugePct(w, me);
  const need = B.stats.levels?.[p.level]?.expRequired;
  return {
    name, bot: B.version,
    level: p.level ?? null,
    xpPct: need && p.experience != null ? Math.floor(Number(p.experience) / Number(need) * 1000) / 10 : null,
    hp: Math.round(pct.hp), mp: Math.round(pct.mp),
    inWorld: w.inWorld(), dead: w.isDead(), running: !!B.hunt.running, state: String(B.hunt.state || ''),
    note: String(B.reconnect?.message || '').slice(0, 120),
    pos: pose ? { region: pose.regionId, x: Math.round(pose.x), z: Math.round(pose.z) } : null,
    stats: B.stats.display(),
    log: B.log.lines.filter(feedEntry).slice(-12)
      .map(e => ({ at: e.lastAt || e.at, level: e.level, text: say(B, e).slice(0, 200) + (e.repeatCount > 1 ? ' ×' + e.repeatCount : '') })),
  };
}

// me().hpPct divides by the vitals maximum, which the game leaves stale after a max-HP buff (115 %). Use the first maximum
// that can hold the gauge: vitals row, then the stats packet. Same rule as lean-live.js.
function gaugePct(w, me) {
  const v = w.vitalsOf?.(w.localGid?.()) || {}, stats = w.gp?.progression?.stats || {};
  const one = (cur, pct, ...maxima) => {
    if (!Number.isFinite(cur)) return Math.min(100, Math.max(0, pct));
    const max = maxima.map(Number).find(m => Number.isFinite(m) && m > 0 && m >= cur);
    return max ? Math.min(100, Math.max(0, cur / max * 100)) : (cur > 0 || !maxima.some(Number.isFinite) ? 100 : Math.min(100, Math.max(0, pct)));
  };
  return { hp: one(me.hp, me.hpPct, v.maxHp, stats.maxHp), mp: one(me.mp, me.mpPct, v.maxMp, stats.maxMp) };
}

// The feed shows what the bot did: only these Activity categories, no command traces, panel toasts or the dashboard's own notes.
const FEED = ['session', 'combat', 'movement', 'town', 'stall', 'potion', 'loot', 'party', 'buff', 'alchemy', 'reconnect'];
function feedEntry(e) {
  if (e.level === 'cmd' || e.source === 'toast') return false;
  if (e.category !== undefined && !FEED.includes(e.category)) return false;
  if (/^(live-|session-report-)/.test(String(e.code || ''))) return false;
  return !(e.level === 'info' && QUIET.includes(e.code));
}

// Every new target is logged by the bot; on a phone that buries the events worth seeing, and kills are counted in the stats anyway.
const QUIET = ['target-selected', 'target-search'];
// The bot's own wording for its panel ("Picked up Dagger." instead of "Inventory gain observed for pickup 366883.").
function say(B, e) {
  try { return String(B.activity.userMessage(e)); } catch { return String(e.text); }
}

function send() {
  const B = unsafeWindow.SROLean;
  if (!B) return; // bot not loaded yet
  let snap;
  try { snap = snapshot(B); } catch (e) { console.warn('[NIX live] bot layout changed:', e); return; }
  // Sent by the userscript manager, not the page, so the game site's rules about reaching localhost do not apply.
  if (snap) GM_xmlhttpRequest({ method: 'POST', url: HUB + '/report', headers: { 'Content-Type': 'application/json', 'X-Code': CODE }, data: JSON.stringify(snap) });
}

if (typeof window === 'undefined') module.exports = { snapshot };
else if (CODE.startsWith('__')) console.warn('[NIX live] not configured: install this script from the hub\'s "Install reporter" link.');
else {
  // A worker timer keeps reporting while the game tab is in the background, where page timers are slowed to once a minute.
  try {
    const src = 'setInterval(()=>postMessage(0),' + EVERY_MS + ')';
    new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))).onmessage = send;
  } catch { setInterval(send, EVERY_MS); }
}
