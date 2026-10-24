// ==UserScript==
// @name         nixxane bot
// @namespace    https://opensro.online/
// @version      1.4.3
// @updateURL    https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.meta.js
// @downloadURL  https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.user.js
// @description  Combat, reliable looting, potions, restocking, walk-back and an optional team relay in one compact panel.
// @author       Adapted from TSK's OpenSRO Assistant
// @license      GPL-2.0-or-later
// @match        https://opensro.online/play*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
'use strict';
const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (W.__SRO_ASISTAN__ || W.__SRO_LEAN__) {
  console.warn('[NIX] Another SRO assistant is active. Disable it and reload to use NIX.');
  return;
}
const VERSION = '1.4.3';
const APP = { version: VERSION };
Object.defineProperty(W, '__SRO_LEAN__', { value: APP });
Object.defineProperty(W, '__SRO_ASISTAN__', { value: APP });
const T = (tr, en) => en ?? tr;


const now = () => performance.now();
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtInt(n) {
  if (!isNum(n)) return '-';
  return Math.round(n).toLocaleString('tr-TR');
}

function fmtBig(v) {
  try {
    return BigInt(v).toLocaleString('tr-TR');
  } catch {
    return String(v ?? '-');
  }
}

function fmtDuration(ms) {
  if (!isNum(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function toBigInt(v) {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
}

function splitList(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function deepMerge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over.slice() : base.slice();
  if (!base || typeof base !== 'object') return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = deepMerge(base[k], over ? over[k] : undefined);
  if (over && typeof over === 'object') {
    for (const k of Object.keys(over)) if (!(k in base)) out[k] = over[k];
  }
  return out;
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

class Emitter {
  constructor() {
    this.map = new Map();
  }
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    const set = this.map.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (e) {
        console.error('[NIX]', ev, e);
      }
    }
  }
}

const bus = new Emitter();

// ---------------------------------------------------------------------------
// Log (kept in memory, shown in the Statistics > Log tab)
// ---------------------------------------------------------------------------

const Log = {
  lines: [],
  add(level, text) {
    const entry = { at: Date.now(), level, text: String(text) };
    this.lines.push(entry);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
    if (level === 'error') console.warn('[NIX]', text);
    bus.emit('log', entry);
  },
  info(t) { this.add('info', t); },
  warn(t) { this.add('warn', t); },
  error(t) { this.add('error', t); },
  cmd(t) { this.add('cmd', t); },
};

// ---------------------------------------------------------------------------
// Persistent storage (localStorage, every access guarded)
// ---------------------------------------------------------------------------

const Store = {
  prefix: 'sroBotLean:v1:',
  get(key, def) {
    try {
      const raw = W.localStorage.getItem(this.prefix + key);
      return raw == null ? def : JSON.parse(raw);
    } catch {
      return def;
    }
  },
  set(key, value) {
    try {
      W.localStorage.setItem(this.prefix + key, JSON.stringify(value));
      return true;
    } catch (e) {
      Log.warn('Could not save settings: ' + e);
      return false;
    }
  },
  remove(key) {
    try {
      W.localStorage.removeItem(this.prefix + key);
    } catch {}
  },
  keys() {
    const out = [];
    try {
      for (let i = 0; i < W.localStorage.length; i++) {
        const k = W.localStorage.key(i);
        if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
      }
    } catch {}
    return out;
  },
};

const DISCORD_URL = 'https://discord.gg/Y5H5ZyfQ7u';
const NOTES_URL = 'https://nixxane.github.io/opensro-bot-lean-site/#patch-notes';
const CLASS_KEYS = ['normal', 'champion', 'giant', 'party', 'elite', 'unique'];
const DEFAULT_PROFILE = {
  items: { rules: {} },
  stall: { title: '', greeting: '', network: true, closeWhenEmpty: true, prices: {} },
  alchemy: { target: 3, limit: 20, elixir: 0, powder: false, use: { luck: false, steady: false, immortal: false, astral: false }, stones: { luck: 1, steady: 1, immortal: 1, astral: 1 }, stoneLimit: 0,
    // The plus from which each helper is used: a failure from +5 up can destroy the item (Steady and Immortal matter from there),
    // Luck and lucky powder help at every plus, and Astral keeps +4 on a failure.
    from: { powder: 0, luck: 0, steady: 5, immortal: 5, astral: 4 },
    // Attribute percentages: the lowest variance value (0 to 31) wanted per NATTR_ name, 0 or missing = leave it alone.
    attr: { targets: {}, limit: 100 } },
  statPoints: { enabled: false, str: 1, int: 0, reserve: 0 },
  trace: { enabled: false, name: '', distance: 12, fight: true },
  mastery: { enabled: false, ids: [], gap: 0, skills: false, scope: 'rotation', reserve: 0, order: 'masteries' },
  party: { autoAcceptMatching: false, autoRecruit: false, joinMain: false, mainName: '', autoRes: false, acceptRes: false, resRadius: 300, title: 'Hunting party', min: 1, max: 90, purpose: 0, expShare: true, itemShare: true,
    support: { enabled: false, whileStopped: false, range: 30, heal: { id: 0, group: 0, pct: 60, self: false }, group: { id: 0, group: 0, pct: 60, count: 2 }, buffs: [] } },
  team: { enabled: false, url: '', token: '', role: 'none', assist: false, townSync: false, converge: false, share: { public: false, monsters: true, players: true, uniques: true } },
  wardrobe: { on: true, phantom: true, realAnim: true, hideAvatars: false,
    eq: {}, av: {}, pet: { atk: 0, pick: 0, mount: 0 }, presets: {}, undo: null },
  macro: {
    rotations: { normal: [], champion: [], giant: [], party: [], elite: [], unique: [] },
    fallbackToNormal: true, normalAttack: true, buffs: [], imbue: null, buffSwap: false, buffSets: [],
    imbueBeforeAttack: true, berserkClasses: { normal: false, champion: false, giant: true, party: false, elite: false, unique: false, titan: false },
    minMpPct: 0, castGapMs: 350,
  },
  potion: {
    enabled: true, speedScroll: false, hp: { on: true, pct: 60 }, mp: { on: true, pct: 40 },
    vigor: { on: true, hpPct: 30, mpPct: 15 }, cure: { on: true }, petHp: { on: false, pct: 50 },
    prefer: { hp: 0, mp: 0, vigor: 0, cure: 0 }, delayMs: 350,
    restock: {
      enabled: false, vendor: null, route: [], offers: [],
      town: { enabled: false, revive: true, deathReturn: 'recall', storeSox: true, sellBag: false, storeLevels: '', petFull: true, petFree: 1, arrivalRadius: 500,
        broken: true, wear: { on: false, pct: 15 }, noXp: { on: false, minutes: 10 }, every: { on: false, minutes: 60 }, arrival: null, storage: null, vendor: null, smith: null, gate: null,
        keep: '', store: { equipment: true, elixirs: true, powders: true, alchemy: true, others: false } },
      hp: { on: true, refObjId: 0, low: 20, target: 100 },
      mp: { on: true, refObjId: 0, low: 20, target: 300 },
      cure: { on: false, refObjId: 58, low: 10, target: 50 },
      vigor: { on: false, refObjId: 22, low: 10, target: 50 },
      ammo: { arrow: { on: false, low: 200, target: 2000 }, bolt: { on: false, low: 200, target: 2000 } },
    },
  },
  hunt: {
    center: null, radius: 400, chase: 700, returnToCenter: true,
    classes: { normal: true, champion: true, giant: true, party: false, elite: false, unique: false, titan: false },
    levelMin: 0, levelMax: 0, include: '', exclude: '', priority: 'attackers', avoidKs: true,
    targetTimeoutS: 25,
    pickup: { enabled: true, soxOnly: false, gold: true, potions: true, equipment: true, elixirs: true, powders: true, magicStones: true, attrStones: true, alchemy: true, others: true,
      collector: 'character', by: {}, petFullSound: true, soxSound: true, include: '', exclude: '', radius: 300, afterKillOnly: true, retries: 2 },
    sit: { enabled: true, hpBelow: 35, mpBelow: 20, resumeAt: 90 },
    antiStuck: { enabled: true, minutes: 3, maxRecoveries: 3 },
    detour: { enabled: true, stallMs: 2500 },
    trap: { enabled: true, seconds: 20, recall: false, diagnostics: false },
    onDeath: 'stop', stopNoHpPotion: false, stopInvFull: false,
    playerAlert: { enabled: false, radius: 250, pause: false }, manualPauseS: 6,
  },
};
// Preserve only bot settings. The original assistant's settings are never changed.
function botProfile(input) {
  const result = deepMerge(DEFAULT_PROFILE, {});
  if (!input || typeof input !== 'object') return result;
  for (const key of ['macro', 'potion', 'hunt', 'wardrobe', 'party', 'team', 'alchemy', 'mastery', 'statPoints', 'trace', 'items', 'stall']) {
    if (!input[key] || typeof input[key] !== 'object') continue;
    for (const field of Object.keys(DEFAULT_PROFILE[key])) {
      if (field in input[key]) result[key][field] = deepMerge(DEFAULT_PROFILE[key][field], input[key][field]);
    }
  }
  // Migrate the old separate town stack targets once. Preserve the active
  // return mode's target; walking-only profiles retain their refill quantities.
  const restock = input.potion?.restock;
  if (restock?.town?.enabled && restock.town.stacks) {
    for (const kind of ['hp', 'mp']) {
      const stacks = restock.town.stacks[kind];
      if (Number.isInteger(stacks) && stacks >= 1 && stacks <= 200) result.potion.restock[kind].target = stacks * 50;
    }
  }
  delete result.potion.restock.town.stacks;
  if (!Number.isInteger(result.potion.delayMs) || result.potion.delayMs < 0 || result.potion.delayMs > 60000) result.potion.delayMs = DEFAULT_PROFILE.potion.delayMs;
  if (!['death', 'recall'].includes(result.potion.restock.town.deathReturn)) result.potion.restock.town.deathReturn = 'recall';
  // New categories inherit the old Other items switch, preserving existing selection.
  const pickup = input.hunt?.pickup;
  for (const key of ['elixirs', 'powders', 'alchemy']) {
    if (pickup && !(key in pickup)) result.hunt.pickup[key] = pickup.others ?? true;
  }
  // The old Berserk dropdown: Off and Whenever full carry over; Champion and above becomes Giants only.
  const mode = input.macro?.berserk;
  if (!input.macro?.berserkClasses && (mode === 'off' || mode === 'always')) {
    for (const key of Object.keys(result.macro.berserkClasses)) result.macro.berserkClasses[key] = mode === 'always';
  }
  // Magic and attribute stones used to sit in the alchemy switch, so they keep its setting.
  for (const key of ['magicStones', 'attrStones']) {
    if (pickup && !(key in pickup)) result.hunt.pickup[key] = pickup.alchemy ?? pickup.others ?? true;
  }
  // Helper stones used to be on when their count was above zero; now each has a switch and a count of at least 1.
  const oldStones = input.alchemy?.stones;
  if (oldStones && !input.alchemy?.use) for (const key of Object.keys(result.alchemy.use)) {
    const n = Number(oldStones[key]) || 0; result.alchemy.use[key] = n > 0; result.alchemy.stones[key] = Math.min(6, Math.max(1, n));
  }
  return result;
}
const Settings = {
  profileKey: 'profile:default',
  profile: botProfile(Store.get('profile:default', null)),
  saveProfile: debounce(() => Store.set(Settings.profileKey, Settings.profile), 250),
  useCharacter(name) {
    const key = name ? 'profile:' + name : 'profile:default';
    if (key === this.profileKey) return;
    Store.set(this.profileKey, this.profile);
    this.profileKey = key;
    this.profile = botProfile(Store.get(key, null));
    bus.emit('profile');
  },
  importOriginal() {
    try {
      const raw = W.localStorage.getItem('sroAsistan:v7:' + this.profileKey)
        || W.localStorage.getItem('sroAsistan:v7:profile:default');
      if (!raw) return UI.toast('No original bot profile was found.', 'warn');
      stopAll();
      this.profile = botProfile(JSON.parse(raw));
      // The improved loot controller defaults to finishing its fight first.
      this.profile.hunt.pickup.afterKillOnly = true;
      this.saveProfile();
      bus.emit('profile');
      UI.toast('Imported combat, potion and hunting settings. Review them before starting.');
    } catch (e) { UI.toast('Could not import profile: ' + e.message, 'warn'); }
  },
};
const Sound = {
  ctx: null,
  unlock() {
    try {
      this.ctx ||= new (W.AudioContext || W.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch {}
  },
  // Only these alerts are audible; existing combat/UI calls stay silent.
  tones: { 'pet-full': { notes: [659.25, 830.61, 987.77], gap: 0.18 }, sox: { notes: [783.99, 987.77, 1174.66, 1567.98], gap: 0.11 }, unique: { notes: [523.25, 659.25, 783.99, 1046.5], gap: 0.12 } },
  play(kind) {
    const tone = this.tones[kind];
    if (!tone) return false;
    try {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return false;
      tone.notes.forEach((frequency, i) => {
        const oscillator = ctx.createOscillator(), gain = ctx.createGain();
        const at = ctx.currentTime + i * tone.gap;
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
        oscillator.connect(gain); gain.connect(ctx.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(at); oscillator.stop(at + 0.6);
      });
      return true;
    } catch { return false; }
  },
  async test(kind = 'pet-full') {
    this.unlock();
    try { if (this.ctx?.state === 'suspended') await this.ctx.resume(); } catch {}
    if (!this.play(kind)) UI.toast('Sound is blocked by the browser. Allow audio for this site and try again.', 'warn');
  },
};


const SECTOR = 1920;
const DUNGEON = 0x8000;

function regionDelta(a, b) {
  if ((a.regionId | b.regionId) & DUNGEON) {
    if (a.regionId !== b.regionId) return null;
    return [b.x - a.x, b.z - a.z];
  }
  return [
    b.x - a.x + ((b.regionId & 255) - (a.regionId & 255)) * SECTOR,
    b.z - a.z + ((b.regionId >>> 8) - (a.regionId >>> 8)) * SECTOR,
  ];
}

function dist2D(a, b) {
  if (!a || !b) return Infinity;
  const d = regionDelta(a, b);
  return d ? Math.hypot(d[0], d[1]) : Infinity;
}

// Same formula as the game's minimap coordinate read-out (X/Y in the HUD).
function displayCoords(p) {
  if (!p) return null;
  // The game leaves the read-out empty in dungeons; local units are shown instead.
  if (p.regionId & DUNGEON) return { x: Math.trunc(p.x / 10), y: Math.trunc(p.z / 10), dungeon: true };
  return {
    x: ((p.regionId & 255) - 135) * 192 + Math.trunc(p.x / 10),
    y: ((p.regionId >>> 8) - 92) * 192 + Math.trunc(p.z / 10),
  };
}

// Monster grade, from the spawn byte (rarity = low nibble, party icon = high nibble).
const RARITY = { 0: 'normal', 1: 'champion', 3: 'unique', 4: 'giant', 5: 'titan', 6: 'elite' };
const RARITY_HP = { normal: 1, champion: 2, unique: 1, giant: 20, titan: 100, elite: 4 };

function monsterClass(e) {
  if (!e) return 'normal';
  if (e.rarityAuxIcon === 1) return 'party';
  return RARITY[e.rarity ?? 0] || 'normal';
}

function rotationKey(cls) {
  return cls === 'titan' ? 'unique' : cls;
}

function effectiveMaxHp(e) {
  if (!e || !isNum(e.maxHp)) return undefined;
  const base = RARITY_HP[RARITY[e.rarity ?? 0] || 'normal'] ?? 1;
  return e.maxHp * base * (e.rarityAuxIcon === 1 ? 10 : 1);
}

// Item type words (typeFlags / tidWord): TID1 = (tf>>2)&7, TID2 = (tf>>5)&3,
// TID3 = (tf>>7)&15, TID4 = tf>>>11.
const ItemType = {
  isPotion: (tf) => (tf & 2046) === 236,
  potionCategory: (tf) => ((tf & 2046) === 236 ? tf >>> 11 : 0), // 1 HP, 2 MP, 3 vigor (4/5/7/9: companion)
  // TID4 7 is the companion cure; the worker makes it target an owned COS (worker ll()).
  isCure: (tf) => (tf & 2046) === 364 && tf >>> 11 !== 7,
  // Extra target an "item-use" needs, mirroring the simulation worker's ll():
  // 'revival' = companion revival scroll (TID3 1 / TID4 6) -> one dead companion's summoner item,
  // 'summoner' = TID3 13 / TID4 12 -> one pickup companion's summoner item,
  // 'companion' = companion potion / cure (TID3 1 & TID4 4,5,7,9 or TID3 2 & TID4 7) -> one living own COS.
  useTarget(tf) {
    if ((tf & 28) !== 12 || ((tf >>> 5) & 3) !== 3) return '';
    const t3 = (tf >>> 7) & 15;
    const t4 = (tf >>> 11) & 31;
    if (t3 === 1 && t4 === 6) return 'revival';
    if (t3 === 13 && t4 === 12) return 'summoner';
    if ((t3 === 1 && [4, 5, 7, 9].includes(t4)) || (t3 === 2 && t4 === 7)) return 'companion';
    return '';
  },
  isReturnScroll: (tf) => !(tf & 2) && (tf & 28) === 12 && (tf & 96) === 96 && (tf & 1920) === 384 && [1, 3].includes(tf >>> 11),
  isGold: (tf) => (tf & 96) === 96 && (tf & 1920) === 640,
  isEquipment: (tf) => (tf & 126) === 44,
  isStackable: (tf) => (tf & 126) === 108,
};

// Abnormal (status) bits as named by the client. Bit 5 (zombie) is excluded from
// curing, matching the client's own auto potion rules.
const ABNORMAL_NAMES = {
  0: 'Freeze', 1: 'Frostbite', 2: 'Shock', 3: 'Burn', 4: 'Poison', 5: 'Zombie', 6: 'Sleep', 7: 'Bind',
  8: 'Slow', 9: 'Fear', 10: 'Dull', 11: 'Bleed', 13: 'Darkness', 14: 'Stun', 15: 'Disease',
  16: 'Confusion', 17: 'Decay', 18: 'Weaken', 19: 'Impotent', 20: 'Division', 21: 'Panic', 22: 'Combustion', 24: 'Hidden',
};
const CURABLE_MASK = ~(1 << 5) >>> 0;

const Hook = {
  sim: null,
  late: false,
  post: null, // native postMessage bound to the simulation worker
  nativePost: null,
  NativeWorker: null,
  simUrl: '',
  observers: [],
  guards: [], // fn(command) -> true swallows one of the game's own commands
  probe: null,
};

function attachSimulation(worker, late) {
  if (Hook.sim) return;
  Hook.sim = worker;
  Hook.late = late;
  const nativePost = Hook.nativePost || W.Worker.prototype.postMessage;
  Hook.post = (msg) => nativePost.call(worker, msg);
  worker.addEventListener('message', onSimulationMessage);
  // Observe the game's own outgoing commands (manual play detection).
  try {
    const own = worker.postMessage;
    worker.postMessage = function (msg, transfer) {
      if (msg && msg.kind === 'session' && msg.command) {
        // Probe mode (see Probe.at): record what the game would send and swallow it.
        if (Hook.probe) {
          Hook.probe.push(msg.command);
          const inner = msg.command.command;
          return undefined;
          for (const g of Hook.guards) {
            try {
              if (g(msg.command)) return undefined;
            } catch {}
          }
        } else {
          for (const g of Hook.guards) {
            try {
              if (g(msg.command)) return undefined;
            } catch {}
          }
          for (const fn of Hook.observers) {
            try { fn(msg.command); } catch {}
          }
        }
      }
      return own.apply(this, arguments);
    };
  } catch (e) {
    Log.warn('Command observer could not be installed: ' + e);
  }
  Log.info(late ? 'The game was already running: attached late (some data arrives on the first change).' : 'Attached to the game worker.');
  bus.emit('attached', { late });
}

function installWorkerHook() {
  const Native = W.Worker;
  if (typeof Native !== 'function' || Native.__sroAsistanHooked) return;
  const nativePost = Native.prototype.postMessage;
  Hook.nativePost = nativePost;
  Hook.NativeWorker = Native;

  class Worker extends Native {
    constructor(url, options) {
      super(url, options);
      try {
        const name = options && options.name;
        if (name === 'sro-simulation') {
          Hook.simUrl = String(url);
          attachSimulation(this, false);
        }
      } catch (e) {
        console.error('[NIX] hook', e);
      }
    }
  }
  Object.defineProperty(Worker, '__sroAsistanHooked', { value: true });
  W.Worker = Worker;

  // Late attach: the simulation worker is the only one that receives these kinds.
  const SIM_KINDS = new Set(['world-ack', 'input', 'session', 'recycle']);
  Native.prototype.postMessage = function (msg) {
    if (!Hook.sim && msg && typeof msg === 'object' && SIM_KINDS.has(msg.kind)) {
      Native.prototype.postMessage = nativePost;
      attachSimulation(this, true);
    }
    return nativePost.apply(this, arguments);
  };
  bus.on('attached', () => {
    if (Native.prototype.postMessage !== nativePost) Native.prototype.postMessage = nativePost;
  });
}

function onSimulationMessage(e) {
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  try {
    if (d.kind === 'snapshot' || (d.buffer instanceof ArrayBuffer && d.buffer.byteLength === 32 && !d.kind)) {
      World.onSnapshot(d.buffer);
    } else if (d.kind === 'world' && d.batch) {
      World.applyBatch(d.batch);
    } else if (d.kind === 'session' && d.state) {
      World.applySession(d.state);
    } else if (d.kind === 'failure') {
      World.failure = String(d.message || 'failure');
      Log.error('The game simulation stopped: ' + World.failure);
      bus.emit('failure', World.failure);
    }
  } catch (err) {
    Log.error('Could not process data: ' + (err && err.message ? err.message : err));
  }
}

const Display = {
  rewriters: [],
  add(name, fn) {
    this.rewriters.push({ name, fn });
  },
  apply(entity) {
    return this.run(this.rewriters, entity);
  },

  // Same for the 'gameplay' event state (the local player's own equipment look comes
  // from gameplay.inventory slots 0..8). The game copies the state shallowly
  // ({...state}), so arrays handed over here stay shared with it: a rewriter may keep
  // a reference to an array it created and change it in place later; the game picks
  // that up on its next frame without waiting for a new event.
  gameplayRewriters: [],
  addGameplay(name, fn) {
    this.gameplayRewriters.push({ name, fn });
  },
  applyGameplay(state) {
    return this.run(this.gameplayRewriters, state);
  },

  run(list, value) {
    let out = value;
    for (const r of list) {
      try {
        const next = r.fn(out, value);
        if (next && typeof next === 'object') out = next;
      } catch (e) {
        Log.warn('Display rewriter error (' + r.name + '): ' + ((e && e.message) || e));
      }
    }
    return out;
  },
};

const TRANSIENT_PHASES = new Set(['entering-world', 'reconnecting', 'connecting']);

const World = {
  session: null,
  phase: 'signed-out',
  failure: null,
  epoch: 0,
  ents: new Map(),
  gp: null,
  catalog: new Map(), // skill id -> catalog entry
  groups: new Map(), // skill group -> [entries sorted by level]
  charName: '',
  simOffset: null,
  berserkGauge: 0,
  hpSeen: new Map(), // gid -> hp from hp-seed / hp-refresh
  attackers: new Map(), // monster gid -> sim ms it last hit us
  hitByOthers: new Map(), // monster gid -> sim ms another player hit it
  hitByUs: new Map(), // monster gid -> sim ms we hit it
  lastSeq: { notice: 0, chat: 0, gm: 0 },
  dirty: { ents: false, gp: false },
  batches: 0,

  onSnapshot(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 16) return;
    const sim = new DataView(buf).getFloat64(8, true);
    if (isNum(sim)) this.simOffset = sim - now();
  },

  simNow() {
    return this.simOffset == null ? null : now() + this.simOffset;
  },

  applySession(state) {
    const prevPhase = this.phase;
    this.session = state;
    this.phase = state.phase || this.phase;
    if (typeof state.character === 'string' && state.character && state.character !== this.charName) {
      this.charName = state.character;
      bus.emit('character', this.charName);
    }
    if (prevPhase !== this.phase) {
      // Teleports and short reconnects pass through these phases and come back to
      // "world"; only other phases mean the player really left the game world.
      if (this.phase === 'world') this.inWorldSession = true;
      const left = !!this.inWorldSession && this.phase !== 'world' && !TRANSIENT_PHASES.has(this.phase);
      if (left) {
        this.inWorldSession = false;
        this.gp = null;
      }
      if (this.phase !== 'world') this.resetWorld();
      bus.emit('phase', this.phase, prevPhase, left);
    }
  },

  resetWorld() {
    this.ents.clear();
    this.hpSeen.clear();
    this.attackers.clear();
    this.hitByOthers.clear();
    this.hitByUs.clear();
    this.dirty.ents = true;
  },

  applyBatch(batch) {
    this.batches++;
    for (const ev of batch.events || []) this.applyEvent(ev);
    if (this.dirty.ents || this.dirty.gp) {
      const flags = { ents: this.dirty.ents, gp: this.dirty.gp };
      this.dirty.ents = this.dirty.gp = false;
      bus.emit('world', flags);
    }
  },

  applyEvent(ev) {
    switch (ev.kind) {
      case 'spawn':
      case 'state':
        if (ev.entity && ev.entity.gid) {
          const real = ev.entity;
          const prev = this.ents.get(real.gid);
          this.ents.set(real.gid, real);
          this.dirty.ents = true;
          // The game gets the display copy; the mirror and every listener keep the real entity.
          if (Display.rewriters.length) ev.entity = Display.apply(real);
          if (ev.kind === 'spawn') bus.emit('spawn', real);
          else if (prev && prev.appearanceState?.[0] !== 2 && real.appearanceState?.[0] === 2) bus.emit('death', real);
        }
        break;
      case 'despawn': {
        const e = this.ents.get(ev.gid);
        this.ents.delete(ev.gid);
        this.hpSeen.delete(ev.gid);
        this.attackers.delete(ev.gid);
        this.hitByOthers.delete(ev.gid);
        this.hitByUs.delete(ev.gid);
        this.dirty.ents = true;
        if (e) bus.emit('despawn', e);
        break;
      }
      case 'reset':
        this.epoch = ev.epoch ?? this.epoch + 1;
        this.resetWorld();
        bus.emit('reset');
        break;
      case 'bootstrap':
        if (ev.value?.character?.name) {
          this.charName = ev.value.character.name;
          bus.emit('character', this.charName);
        }
        break;
      case 'gameplay':
        if (ev.state) {
          this.applyGameplay(ev.state);
          if (Display.gameplayRewriters.length) ev.state = Display.applyGameplay(ev.state);
        }
        break;
      case 'hp-seed':
      case 'hp-refresh':
        if (isNum(ev.hp)) this.hpSeen.set(ev.gid, ev.hp);
        break;
      case 'hp-revive':
        this.hpSeen.delete(ev.gid);
        break;
      case 'orb-gauge':
        if (isNum(ev.value)) {
          this.berserkGauge = ev.value;
          bus.emit('berserk', ev.value);
        }
        break;
      case 'cast-finalize':
        if (ev.cast) this.onCast(ev.cast);
        break;
      case 'level-up':
        if (ev.gid && ev.gid === this.gp?.localGid) bus.emit('levelup');
        break;
      case 'travel':
        bus.emit('travel', ev.travel);
        break;
      default:
        break;
    }
  },

  onCast(cast) {
    const local = this.gp?.localGid;
    const t = this.simNow() ?? now();
    const targets = new Set();
    if (cast.target) targets.add(cast.target);
    for (const r of cast.results || []) if (r && r.target) targets.add(r.target);
    const caster = this.ents.get(cast.caster);
    if (cast.caster === local) {
      for (const gid of targets) this.hitByUs.set(gid, t);
    } else if (caster && caster.kind === 'monster' && local && targets.has(local)) {
      this.attackers.set(cast.caster, t);
    } else if (caster && (caster.kind === 'player' || caster.kind === 'cos')) {
      for (const gid of targets) {
        if (caster.kind === 'cos' && caster.ownerGid === local) continue;
        const target = this.ents.get(gid);
        if (target && target.kind === 'monster') this.hitByOthers.set(gid, t);
      }
    }
    bus.emit('cast', cast);
  },

  applyGameplay(state) {
    const prev = this.gp;
    const merged = {
      ...state,
      skillCatalog: state.skillCatalog ?? prev?.skillCatalog ?? null,
      social: state.social ?? prev?.social,
      shop: 'shop' in state ? state.shop : prev?.shop,
    };
    this.gp = merged;
    this.dirty.gp = true;
    if (state.skillCatalog) this.rebuildCatalog(state.skillCatalog);

    for (const n of merged.notices || []) {
      if (isNum(n.sequence) && n.sequence > this.lastSeq.notice) {
        this.lastSeq.notice = n.sequence;
        if (prev) bus.emit('notice', n);
      }
    }
    for (const line of merged.chat?.lines || []) {
      if (isNum(line.sequence) && line.sequence > this.lastSeq.chat) {
        this.lastSeq.chat = line.sequence;
        if (prev) bus.emit('chat', line);
      }
    }
    for (const r of merged.gmReplies || []) {
      if (isNum(r.sequence) && r.sequence > this.lastSeq.gm) {
        this.lastSeq.gm = r.sequence;
        if (prev) bus.emit('gm-reply', r);
      }
    }
    if (prev && prev.error !== merged.error && merged.error) bus.emit('game-error', merged.error);
    bus.emit('gameplay', merged, prev);
  },

  rebuildCatalog(list) {
    this.catalog.clear();
    this.groups.clear();
    for (const s of list) {
      if (!s || !isNum(s.id)) continue;
      this.catalog.set(s.id, s);
      const g = s.group ?? s.groupId ?? s.id;
      if (!this.groups.has(g)) this.groups.set(g, []);
      this.groups.get(g).push(s);
    }
    for (const arr of this.groups.values()) arr.sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
    bus.emit('catalog');
  },

  // ---- state queries ------------------------------------------------------

  inWorld() {
    return !!(this.gp && this.gp.localGid && this.phase === 'world' && !this.failure);
  },
  localGid() {
    return this.gp?.localGid || 0;
  },
  local() {
    return this.ents.get(this.localGid());
  },
  pose() {
    const p = this.gp?.pose;
    if (p && isNum(p.x)) return p;
    const l = this.local();
    return l ? { regionId: l.regionId, x: l.x, y: l.y, z: l.z, angle: l.heading ?? 0 } : null;
  },
  vitalsOf(gid) {
    return this.gp?.vitals?.find((v) => v.gid === gid);
  },
  me() {
    const v = this.vitalsOf(this.localGid()) || {};
    const stats = this.gp?.progression?.stats || {};
    const maxHp = v.maxHp || stats.maxHp || 0;
    const maxMp = v.maxMp || stats.maxMp || 0;
    const hp = isNum(v.hp) ? v.hp : maxHp;
    const mp = isNum(v.mp) ? v.mp : maxMp;
    return {
      hp, mp, maxHp, maxMp,
      hpPct: maxHp ? (hp / maxHp) * 100 : 100,
      mpPct: maxMp ? (mp / maxMp) * 100 : 100,
      abnormal: (v.abnormal ?? 0) >>> 0,
    };
  },
  isDead() {
    const l = this.local();
    if (l && l.appearanceState?.[0] === 2) return true;
    const v = this.vitalsOf(this.localGid());
    return !!(v && v.hp === 0 && v.maxHp > 0);
  },
  isSitting() {
    return this.local()?.movementMode === 4;
  },
  isAlive(e) {
    return !!e && e.appearanceState?.[0] !== 2 && this.hpOf(e.gid) !== 0;
  },
  hpOf(gid) {
    const v = this.vitalsOf(gid);
    if (v && isNum(v.hp)) return v.hp;
    return this.hpSeen.get(gid);
  },
  hpPctOf(e) {
    const hp = this.hpOf(e.gid);
    const max = this.vitalsOf(e.gid)?.maxHp || effectiveMaxHp(e);
    if (!isNum(hp) || !max) return null;
    return clamp((hp / max) * 100, 0, 100);
  },
  target() {
    const gid = this.gp?.target;
    return gid ? this.ents.get(gid) : null;
  },
  distTo(e) {
    return dist2D(this.pose(), e);
  },
  freeBagSlots() {
    const gp = this.gp;
    if (!gp) return null;
    const total = gp.inventorySlotCount || 0;
    const equip = gp.equipmentSlotCount || 13;
    const used = new Set((gp.inventory || []).filter((i) => i.slot >= equip).map((i) => i.slot));
    return Math.max(0, total - equip - used.size);
  },
  items() {
    const equip = this.gp?.equipmentSlotCount || 13;
    return (this.gp?.inventory || []).filter((i) => i.slot >= equip);
  },

  // ---- skills -------------------------------------------------------------

  skill(id) {
    return this.catalog.get(id);
  },
  learned(id) {
    return !!this.gp?.skills?.includes(id);
  },
  skillName(id) {
    return this.catalog.get(id)?.name || '#' + id;
  },
  // Highest learned level of a skill group (skills are stored by group so that a
  // rotation keeps working after the skill is levelled up).
  bestOfGroup(group, fallbackId) {
    const arr = this.groups.get(group);
    if (arr) {
      for (let i = arr.length - 1; i >= 0; i--) if (this.learned(arr[i].id)) return arr[i].id;
    }
    return fallbackId && this.learned(fallbackId) ? fallbackId : 0;
  },
  cooldownLeft(id) {
    const list = this.gp?.skillCooldowns;
    const t = this.simNow();
    if (!list || !list.length || t == null) return 0;
    const group = this.catalog.get(id)?.cooldownGroup ?? 0;
    let left = 0;
    for (const c of list) {
      if (c.skill === id || (group && c.group === group)) left = Math.max(left, c.startedAtMs + c.durationMs - t);
    }
    return left;
  },
  itemCooldownLeft(category) {
    const list = this.gp?.itemCooldowns;
    const t = this.simNow();
    if (!list || !list.length || t == null) return 0;
    let left = 0;
    for (const c of list) if (c.category === category) left = Math.max(left, c.startedAtMs + c.durationMs - t);
    return left;
  },
  // Own cast that has not produced its result yet.
  isCasting() {
    const local = this.localGid();
    const t = this.simNow();
    for (const c of this.gp?.casts || []) {
      if (c.caster !== local || c.cancelledAtMs !== undefined || c.resultOnly) continue;
      if (t != null && isNum(c.receivedAtMs) && t - c.receivedAtMs > 6000) continue;
      if (!c.results || !c.results.length) return true;
    }
    return false;
  },
  buffRemaining(skillId) {
    const local = this.localGid();
    const group = this.catalog.get(skillId)?.group;
    const t = this.simNow();
    let best = -1;
    const match = (sid) => sid === skillId || (group !== undefined && this.catalog.get(sid)?.group === group);
    for (const b of this.gp?.buffSlots || []) {
      const ef = b.effect;
      if (!ef || b.state === 'departing' || ef.gid !== local || !match(ef.skill)) continue;
      let rem = Infinity;
      if (isNum(ef.remainingMs) && isNum(ef.receivedAtMs) && t != null) rem = ef.remainingMs - (t - ef.receivedAtMs);
      best = Math.max(best, rem);
    }
    if (best < 0) {
      for (const ef of this.gp?.attachedEffects || []) {
        if (ef.gid === local && match(ef.skill)) best = Math.max(best, Infinity);
      }
    }
    return best; // -1 = not active
  },
};

const MIN_GAP = {
  select: 220,
  attack: 700,
  'cos-attack': 700,
  skill: 120,
  pickup: 350,
  move: 550,
  'item-use': 220,
  'action-command': 700,
  berserk: 1500,
  'release-target': 600,
  rebirth: 3000,
};

const Cmd = {
  last: {},
  sent: 0,
  history: [],
  lastError: '',

  ready() {
    return !!Hook.post && World.inWorld();
  },

  spaced(kind) {
    const gap = MIN_GAP[kind] ?? 200;
    return now() - (this.last[kind] ?? -Infinity) >= gap;
  },

  raw(command, label) {
    if (!this.ready()) return false;
    // Same rule as the game's own commands (Hook.guards), e.g. no target on a revealed hidden player.
    const wrapped = { kind: 'gameplay', command };
    for (const g of Hook.guards) {
      try {
        if (g(wrapped)) return false;
      } catch {}
    }
    try {
      Hook.post({ kind: 'session', command: { kind: 'gameplay', command } });
    } catch (e) {
      Log.error('Command could not be sent: ' + e);
      return false;
    }
    this.last[command.kind] = now();
    this.sent++;
    const text = label || command.kind;
    this.history.push({ at: Date.now(), text });
    if (this.history.length > 200) this.history.shift();
    Log.command(command, text);
    bus.emit('command', command);
    return true;
  },

  entity(gid) {
    return gid ? World.ents.get(gid) : undefined;
  },

  select(gid) {
    const gp = World.gp;
    const e = this.entity(gid);
    if (!gp || !e || e.kind === 'ground-item' || gid === gp.localGid) return false;
    if (gp.target === gid) return true;
    if (gp.targetPending || !this.spaced('select')) return false;
    return this.raw({ kind: 'select', gid }, `Select: ${e.name || gid}`);
  },

  attack(gid) {
    const e = this.entity(gid);
    if (!e || e.kind !== 'monster' || !World.isAlive(e) || World.isDead()) return false;
    const kind = World.local()?.mountedOn ? 'cos-attack' : 'attack';
    if (!this.spaced(kind)) return false;
    return this.raw({ kind, gid }, `Attack: ${e.name || gid}`);
  },

  // A skill can be cast when it is learned, not cooling down and (for targeted
  // skills) when the target is the selected or pending-selected entity, because
  // the worker always replaces the gid with its own skill target.
  canCast(id) {
    if (!id || !World.learned(id) || World.isDead()) return false;
    const info = World.skill(id);
    if (info && info.groundTarget) return false;
    return World.cooldownLeft(id) <= 0;
  },

  skill(id, gid) {
    if (!this.canCast(id) || !this.spaced('skill')) return false;
    const info = World.skill(id);
    const cmd = { kind: 'skill', skillId: id };
    if (!info || info.targetRequired) {
      const gp = World.gp;
      const target = gid || gp?.target;
      if (!target) return false;
      const e = this.entity(target);
      if (!e || !World.isAlive(e) && !(info?.targets & 128)) return false;
      cmd.gid = target;
    }
    return this.raw(cmd, `Skill: ${World.skillName(id)}`);
  },

  pickup(gid) {
    const e = this.entity(gid);
    if (!e || e.kind !== 'ground-item' || World.isDead() || !this.spaced('pickup')) return false;
    return this.raw({ kind: 'pickup', gid }, `Pick up: ${e.name || gid}`);
  },

  move(dest) {
    if (!dest || World.isDead() || !this.spaced('move')) return false;
    const gp = World.gp;
    if ((gp?.pendingMoves?.length ?? gp?.pendingMoves ?? 0) > 24) return false;
    const regionId = dest.regionId | 0;
    const x = Math.trunc(dest.x);
    const z = Math.trunc(dest.z);
    const y = Math.trunc(dest.y ?? World.pose()?.y ?? 0);
    if (regionId < 1 || regionId > 65535) return false;
    if (!(regionId & DUNGEON) && (x < 0 || x >= SECTOR || z < 0 || z >= SECTOR)) return false;
    if (Math.abs(y) > 32767 || Math.abs(x) > 32767 || Math.abs(z) > 32767) return false;
    const angle = clamp((dest.angle ?? World.pose()?.angle ?? 0) | 0, 0, 65535);
    return this.raw({ kind: 'move', destination: { regionId, x, y, z, angle } }, 'Move');
  },

  itemUse(slot) {
    const gp = World.gp;
    const item = gp?.inventory?.find(i => i.slot === slot);
    if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget(item.typeFlags)) return false;
    return this.raw({ kind: 'item-use', slot }, 'Use: ' + (item.name || item.refObjId));
  },

  action(id) {
    if (!this.spaced('action-command') || World.isDead()) return false;
    return this.raw({ kind: 'action-command', id }, `Action ${id}`);
  },

  berserk() {
    if (World.berserkGauge < 5 || World.isDead() || !this.spaced('berserk')) return false;
    return this.raw({ kind: 'berserk' }, 'Berserk');
  },

  release() {
    if (!World.gp?.target || World.gp.targetPending || !this.spaced('release-target')) return false;
    return this.raw({ kind: 'release-target' }, 'Release target');
  },

  rebirth(choice) {
    const local = World.local();
    if (!local || local.appearanceState?.[0] !== 2 || !this.spaced('rebirth')) return false;
    return this.raw({ kind: 'rebirth', choice }, choice === 1 ? 'Revive (return point)' : 'Revive');
  },
};

// Detect manual play: when the player clicks to move, attack or select by hand
// the hunt engine yields for a few seconds instead of fighting the player.
// Our own commands use the native postMessage directly, so only the game's
// commands pass through this observer.
const Manual = { lastAt: 0, kind: "" };
Hook.observers.push((command) => {
  if (command.kind !== "gameplay" || !command.command) return;
  const k = command.command.kind;
  if (["ground-move", "move", "select", "attack", "skill", "pickup", "cos-attack"].includes(k)) {
    Manual.lastAt = now();
    Manual.kind = k;
  }
});

const Ticker = {
  worker: null,
  timer: 0,
  start(fn, ms) {
    let ticked = false;
    // Plain timer when the worker cannot start or never ticks (e.g. Blob workers blocked).
    const fallback = (why) => {
      if (this.timer) return;
      try {
        this.worker?.terminate();
      } catch {}
      this.worker = null;
      this.timer = setInterval(fn, ms);
      Log.warn('Timer worker unavailable (' + why + '); switched to the page timer.');
    };
    try {
      const src = 'let t=0;onmessage=e=>{clearInterval(t);t=setInterval(()=>postMessage(0),e.data)}';
      this.worker = new (Hook.NativeWorker || W.Worker)(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { name: 'sro-asistan-ticker' });
      this.worker.onmessage = (e) => {
        ticked = true;
        fn(e);
      };
      this.worker.onerror = (e) => fallback((e && e.message) || 'error');
      this.worker.postMessage(ms);
      setTimeout(() => ticked || fallback('no response'), Math.max(4000, ms * 8));
    } catch (e) {
      fallback(String((e && e.message) || e));
    }
  },
};

const Potion = {
  lastUse: 0,
  lock: {},
  warned: {},

  score(item, kind, me) {
    const f = item.tooltip?.fields || {};
    const hp = (Number(f.itemParam1_29c) || 0) + (me.maxHp * (Number(f.itemParam2_2a0) || 0)) / 100;
    const mp = (Number(f.itemParam3_2a4) || 0) + (me.maxMp * (Number(f.itemParam4_2a8) || 0)) / 100;
    if (kind === 'hp') return hp;
    if (kind === 'mp') return mp;
    return hp + mp;
  },

  candidates(kind) {
    const cat = { hp: 1, mp: 2, vigor: 3 }[kind];
    return World.items().filter((i) => (kind === 'cure' ? ItemType.isCure(i.typeFlags) : ItemType.potionCategory(i.typeFlags) === cat) && (i.quantity ?? 1) > 0);
  },

  pick(kind) {
    const list = this.candidates(kind);
    if (!list.length) return null;
    const pref = Settings.profile.potion.prefer[kind];
    if (pref) {
      const p = list.find((i) => i.refObjId === pref);
      if (p) return p;
    }
    const me = World.me();
    return list.sort((a, b) => this.score(b, kind, me) - this.score(a, kind, me))[0];
  },

  count(kind) {
    return this.candidates(kind).reduce((n, i) => n + (i.quantity ?? 1), 0);
  },

  use(kind) {
    const cat = { hp: 1, mp: 2, vigor: 3, cure: 4 }[kind];
    if ((this.lock[cat] || 0) > now()) return false;
    if (cat <= 3 && World.itemCooldownLeft(cat) > 0) return false;
    const item = this.pick(kind);
    if (!item) {
      if (!this.warned[kind] || now() - this.warned[kind] > 60000) {
        this.warned[kind] = now();
        bus.emit('potion-empty', kind);
      }
      return false;
    }
    if (!Cmd.itemUse(item.slot)) return false;
    this.lastUse = now();
    this.lock[cat] = now() + 900;
    Stats.potion(item);
    return true;
  },

  tick() {
    const P = Settings.profile.potion;
    if (!P.enabled || !World.inWorld() || World.isDead()) return;
    if (now() - this.lastUse < P.delayMs || World.gp.inventoryPending) return;
    const me = World.me();
    if (!me.maxHp) return;
    const zombie = me.abnormal & (1 << 5);
    if (P.hp.on && !zombie && me.hpPct <= P.hp.pct && this.use('hp')) return;
    if (P.mp.on && me.mpPct <= P.mp.pct && this.use('mp')) return;
    if (P.vigor.on && ((!zombie && me.hpPct <= P.vigor.hpPct) || me.mpPct <= P.vigor.mpPct) && this.use('vigor')) return;
    if (P.cure.on && me.abnormal & CURABLE_MASK && !(me.abnormal & (1 << 14))) this.use('cure');
  },
};

const isAttackableMob = (e) =>
  typeof World.isAttackable === 'function'
    ? World.isAttackable(e)
    : !!e && e.kind === 'monster' && World.isAlive(e) && e.appearanceState?.[0] !== 4 && ((e.attackFlags ?? 16) & 16) !== 0;

const Combat = {
  lastCastAt: 0,
  lastAttackAt: 0,
  buffCastAt: new Map(),
  buffSeen: new Set(),
  stuck: new Map(),
  lastCastId: 0,

  init() {
    bus.on('notice', (n) => {
      if (/SKILL_?USE_FAIL/.test(String(n?.key || '')) && this.lastCastId && now() - this.lastCastAt < 2000) this.fail(this.lastCastId);
    });
    bus.on('cast', (c) => {
      if (c.caster !== World.localGid()) return;
      this.stuck.delete(c.skill);
      for (const gid of [c.target, ...(c.results || []).map(r => r.target)]) {
        if (gid) this.stuck.delete(this.failureKey(c.skill, gid));
      }
    });
  },

  // A skill the server keeps rejecting (range, weapon, mount, ...) is skipped
  // for 5/10/20/40 s so the loop moves on to the next entry or normal attack.
  failureKey(id, gid = 0) {
    return gid ? `${id}:${gid}` : id;
  },

  rejectionReady(id, gid) {
    if (!gid) return true;
    const skill = World.skill(id), target = World.ents.get(gid);
    return !!target && skill?.range > 0 && dist2D(World.pose(), target) <= skill.range &&
      World.gp.target === gid && !World.gp.targetPending && !World.gp.inventoryPending && !World.gp.pendingMoves;
  },

  blocked(id) {
    const global = this.stuck.get(id);
    if (global && now() < global.until) return true;
    const s = this.stuck.get(this.failureKey(id, World.gp?.target));
    return !!s && now() < s.until;
  },

  fail(id, gid = id === this.lastCastId ? this.lastCastGid : 0) {
    const key = this.failureKey(id, gid);
    const s = this.stuck.get(key) || { n: 0, until: 0 };
    s.n = Math.min(s.n + 1, 4);
    s.until = now() + 5000 * 2 ** (s.n - 1);
    this.stuck.set(this.failureKey(id, gid), s);
    Log.warn('Skill refused, skipping for ' + (s.until - now()) / 1000 + ' s: ' + World.skillName(id));
  },

  resolve(entry) {
    if (!entry) return 0;
    return World.bestOfGroup(entry.group, entry.id);
  },

  meta(id) {
    return World.skill(id) || null;
  },

  mpOk(id, me) {
    const m = this.meta(id);
    return !m || (m.mp ?? 0) + Math.trunc(me.maxMp * (m.mpPercent ?? 0) / 100) <= me.mp;
  },

  busy() {
    const gap = Settings.profile.macro.castGapMs ?? 250;
    return World.isCasting() || now() - this.lastCastAt < gap || World.gp?.targetPending;
  },

  cast(id, gid, label) {
    // Silent rejection: the last send of this skill started neither a cooldown
    // nor a cast (canCast passed again), so count it as a miss.
    if (id === this.lastCastId && now() - this.lastCastAt < 1500 && now() - this.lastCastAt > 700 && gid === this.lastCastGid && this.rejectionReady(id, gid) && World.gp !== this.lastCastState && World.cooldownLeft(id) <= 0 && !World.isCasting()) {
      const s = this.stuck.get(this.failureKey(id, gid)) || { n: 0, until: 0, miss: 0 };
      s.miss = (s.miss || 0) + 1;
      if (s.miss >= 2) {
        s.miss = 0;
        this.stuck.set(this.failureKey(id, gid), s);
        this.fail(id);
        return false;
      }
      this.stuck.set(this.failureKey(id, gid), s);
    }
    if (!Cmd.skill(id, gid)) return false;
    while (this.stuck.size > 256) this.stuck.delete(this.stuck.keys().next().value);
    this.lastCastId = id;
    this.lastCastAt = now();
    this.lastCastState = World.gp;
    this.lastCastGid = gid;
    Stats.count('casts');
    return true;
  },

  // Keeps configured self buffs up. Returns true when it used the tick.
  buffs(hunting) {
    const M = Settings.profile.macro;
    if (!M.buffs.length || this.busy() || World.isDead()) return false;
    const me = World.me();
    for (const b of M.buffs) {
      if (!b.enabled || (b.mode === 'hunt' && !hunting)) continue;
      const id = this.resolve(b);
      if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, me)) continue;
      const info = World.skill(id);
      if (info && info.targetRequired) continue;
      const rem = World.buffRemaining(id);
      if (rem >= 0) this.buffSeen.add(b.group);
      const refresh = (b.refreshS ?? 3) * 1000;
      if (rem >= 0 && rem > refresh) continue;
      // Long fallback gap only for effects the buff list never exposed.
      const meta = this.meta(id);
      const minGap = rem < 0 && !this.buffSeen.has(b.group) ? Math.max(4000, Math.min((meta?.durationMs || 20000) * 0.85, 600000)) : 1500;
      if (now() - (this.buffCastAt.get(b.group) || 0) < minGap) continue;
      if (this.cast(id, 0)) {
        this.buffCastAt.set(b.group, now());
        return true;
      }
    }
    return false;
  },

  imbue() {
    const M = Settings.profile.macro;
    if (!M.imbue) return false;
    const id = this.resolve(M.imbue);
    if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, World.me())) return false;
    const rem = World.buffRemaining(id);
    if (rem > 400) return false;
    if (rem < 0 && now() - (this.buffCastAt.get('imbue') || 0) < 1200) return false;
    if (this.cast(id, 0)) {
      this.buffCastAt.set('imbue', now());
      return true;
    }
    return false;
  },

  berserk(cls) {
    const mode = Settings.profile.macro.berserk;
    if (mode === 'off' || World.berserkGauge < 5) return false;
    if (World.local()?.appearanceState?.[2] === 1) return false;
    if (mode === 'strong' && !['giant', 'party', 'unique', 'titan', 'elite', 'champion'].includes(cls)) return false;
    return Cmd.berserk();
  },

  rotation(cls) {
    const M = Settings.profile.macro;
    const list = M.rotations[rotationKey(cls)] || [];
    if (!list.length && M.fallbackToNormal) return M.rotations.normal || [];
    return list;
  },

  // Why the last normal attack replaced a skill (counts only: no names), for the panel and bug reports.
  fallback: null,
  noteFallback(skipped, size) {
    this.fallback = { at: now(), skipped: { ...skipped }, size };
    if (now() - (this.fallbackLogAt || 0) > 30000) {
      this.fallbackLogAt = now();
      Log.warn('Normal attack used instead of skills: ' + this.fallbackNote(true));
    }
  },
  fallbackNote(any = false) {
    const f = this.fallback;
    if (!f || !any && now() - f.at > 8000) return '';
    const names = { unlearned: 'not learned', blocked: 'paused after a server rejection', cooldown: 'cooling down', mp: 'not enough MP', refused: 'not sent', lowMp: 'MP below the minimum' };
    const parts = Object.entries(f.skipped).map(([k, n]) => (k === 'lowMp' ? '' : n + ' ') + names[k]);
    return f.size ? parts.join(', ') || 'no usable rotation skill' : 'no skills in the rotation for this monster class';
  },

  // One step of fighting the given monster.
  fight(target) {
    if (!target || this.busy()) return;
    if (World.gp.target !== target.gid) return;
    const M = Settings.profile.macro;
    const me = World.me();
    const cls = monsterClass(target);
    if (this.berserk(cls)) return;
    const lowMp = M.minMpPct && me.mpPct < M.minMpPct;
    const skipped = {};
    if (!lowMp) {
      for (const entry of this.rotation(cls)) {
        const id = this.resolve(entry);
        const why = !id ? 'unlearned' : this.blocked(id) ? 'blocked' : !Cmd.canCast(id) ? 'cooldown' : !this.mpOk(id, me) ? 'mp' : '';
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        if (M.imbueBeforeAttack && this.imbue()) return;
        if (this.cast(id, target.gid)) return;
        skipped.refused = (skipped.refused || 0) + 1;
      }
    } else skipped.lowMp = 1;
    if (!M.normalAttack) return;
    const sim = World.simNow() ?? 0;
    const lastHit = World.hitByUs.get(target.gid) ?? -Infinity;
    if (sim - lastHit > 2200 && now() - this.lastAttackAt > 1600) {
      if (M.imbueBeforeAttack && this.imbue()) return;
      if (Cmd.attack(target.gid)) {
        this.lastAttackAt = now();
        this.noteFallback(skipped, this.rotation(cls).length);
      }
    }
  },
};

// Automatic potion shopping. The recorded walking route is replayed in both directions.
const Restock = {
  recording: false,
  draft: null,
  trip: null,
  message: '',
  cfg() { return Settings.profile.potion.restock; },
  pose() {
    const p = World.pose();
    return p && { regionId: p.regionId, x: p.x, y: p.y, z: p.z };
  },
  count(ref) { return World.items().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  offerKind(o) {
    const rows = o.items || o.previews || [];
    const item = rows.find(i => i.refObjId === o.refObjId);
    const cat = ItemType.potionCategory(item?.typeFlags ?? 0);
    // Only single-item gold offers; package quantities have different purchase semantics.
    if (o.currency !== undefined && o.currency !== 1) return '';
    if (o.contents?.length && (o.contents.length !== 1 || o.contents[0].refObjId !== o.refObjId || o.contents[0].quantity !== 1)) return '';
    return cat === 1 ? 'hp' : cat === 2 ? 'mp' : cat === 3 ? 'vigor' : o.refObjId === 58 && ItemType.isCure(item?.typeFlags ?? 0) ? 'cure' : '';
  },
  activeShop() {
    const gp = World.gp;
    return gp?.shop && gp.target === gp.shop.npc && !gp.targetPending ? gp.shop : null;
  },
  tell(text) { this.message = text; UI.toast(text, 'info', 5000); },
  beginRecording() {
    if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy before recording a route.', 'warn');
    const shop = this.activeShop();
    const npc = World.ents.get(shop?.npc);
    const p = this.pose();
    if (Hunt.running || this.trip) return this.tell('Stop hunting first.');
    if (!World.inWorld() || !npc || npc.kind !== 'npc' || !p || !shop.offers.some(o => this.offerKind(o))) {
      return this.tell('Open a potion merchant shop first.');
    }
    this.draft = { vendor: { refObjId: npc.refObjId, name: npc.name, ...p }, route: [p], offers: shop.offers.filter(o => this.offerKind(o)).map(o => ({ refObjId: o.refObjId, name: o.name, kind: this.offerKind(o) })) };
    this.recording = true;
    this.tell('Close the shop, walk to your hunting spot, then click Finish route. Do not teleport.');
  },
  sample(force = false) {
    if (!this.recording) return;
    if (!World.inWorld() || World.isDead()) return this.cancelRecording();
    const p = this.pose(), route = this.draft.route;
    if (!p) return;
    const d = dist2D(route[route.length - 1], p);
    if (!Number.isFinite(d) || d > 300 || route.length >= 10000) {
      this.cancelRecording();
      return this.tell('Route interrupted; record again by walking without teleporting.');
    }
    if (d >= 40 || force && d > 0) route.push(p);
  },
  cancelRecording() { this.recording = false; this.draft = null; },
  finishRecording() {
    this.sample(true);
    if (!this.recording) return;
    const d = this.draft;
    if (d.route.length < 2 || dist2D(d.route[0], d.route[d.route.length - 1]) < 100) return this.tell('Walk to your hunting spot first.');
    const c = this.cfg();
    c.vendor = d.vendor; c.route = d.route; c.offers = d.offers;
    for (const kind of ['hp', 'mp']) {
      if (!d.offers.some(o => o.kind === kind && o.refObjId === c[kind].refObjId)) c[kind].refObjId = d.offers.find(o => o.kind === kind)?.refObjId || 0;
    }
    Hunt.setCenter();
    this.cancelRecording();
    Settings.saveProfile();
    this.tell('Route and hunt centre saved. Choose potions and quantities, then enable auto buying.');
  },
  // Fixed retail Special Universal Pill (small): strongest universal cure, ref 58.
  supplies() { return ['hp', 'mp', 'vigor', 'cure'].filter(k => this.cfg()[k].on).map(k => ({ kind: k, ...this.cfg()[k], ...(k === 'cure' ? { refObjId: 58 } : {}) })); },
  validate() {
    const c = this.cfg(), s = this.supplies();
    if (!c.vendor || c.route.length < 2) return 'Record a merchant-to-hunt route first.';
    if (!s.length || s.some(i => !i.refObjId || !Number.isInteger(i.low) || !Number.isInteger(i.target) || i.low < 0 || i.target <= i.low || i.target > 10000)) return 'Choose potions and set refill quantities above the low-stock thresholds (maximum 10000).';
    return '';
  },
  fail(reason) {
    this.trip = null;
    this.message = reason;
    Log.warn('Auto buy: ' + reason);
    Hunt.stop('Potion restock: ' + reason);
  },
  begin() {
    const error = this.validate();
    if (error) return this.fail(error);
    const c = this.cfg(), p = this.pose();
    let index = -1, distance = Infinity;
    c.route.forEach((r, i) => { const d = dist2D(p, r); if (d < distance) { distance = d; index = i; } });
    if (index < 0 || distance > 500) return this.fail('Too far from the recorded route. Record a route for this hunting area.');
    const route = c.route.slice(0, index + 1).map(r => ({ ...r }));
    route.push(p);
    this.trip = { phase: 'vendor', route, index: route.length - 2, at: now(), movedAt: 0, best: Infinity, progressAt: now(), manualAt: Manual.lastAt, vendor: { ...c.vendor }, supplies: this.supplies(), pending: null };
    Hunt.targetGid = 0; Hunt.lootGid = 0;
    this.message = 'Walking to potion merchant';
    Log.info(this.message);
  },
  walk() {
    const t = this.trip, dest = t.route[t.index];
    if (!dest) return true;
    const distance = dist2D(World.pose(), dest);
    if (!Number.isFinite(distance)) return this.fail('Route is in another region or dungeon.');
    if (distance <= 12) {
      t.index += t.phase === 'vendor' ? -1 : 1;
      t.best = Infinity; t.progressAt = now();
      return !t.route[t.index];
    }
    if (!t.lastPose || dist2D(t.lastPose, World.pose()) > 3) { t.lastPose = { ...World.pose() }; t.progressAt = now(); }
    if (now() - t.progressAt > 20000) return this.fail('Movement blocked for 20 seconds. Check the recorded path.');
    const move = Navigation.next(t, dest, true);
    if (move.error && !move.waiting) return this.fail(move.error);
    if (move.waiting) return false;
    if (World.isSitting()) {
      if (now() - t.movedAt > 2500 && Cmd.action(1000)) t.movedAt = now();
    } else if (now() - t.movedAt > 900 && Cmd.move(move.point)) t.movedAt = now();
    return false;
  },
  tick() {
    if (this.recording) { Hunt.state = 'manual'; return true; }
    const c = this.cfg();
    if (!this.trip) {
      if (!c.enabled || !World.inWorld() || World.isDead() || this.activeShop() || World.gp?.storage || World.gp?.inventoryPending || now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return false;
      if (!this.supplies().some(i => this.count(i.refObjId) <= i.low)) return false;
      this.begin();
      if (!this.trip) return true;
    }
    const t = this.trip, gp = World.gp;
    Hunt.state = 'restock';
    if (!c.enabled) { this.fail('Auto buying disabled during the trip.'); return true; }
    if (World.isDead()) { this.fail('Character died during restocking.'); return true; }
    if (!World.inWorld()) return true;
    if (Manual.lastAt !== t.manualAt) { this.fail('Manual control interrupted restocking. Start hunting again when ready.'); return true; }
    if (t.phase === 'vendor' || t.phase === 'return') {
      const done = this.walk();
      if (!this.trip || !done) return true;
      if (t.phase === 'return') {
        this.trip = null; Hunt.targetGid = 0; Hunt.lootGid = 0;
        Hunt.state = 'search'; this.message = 'Restocked; hunting resumed.';
        Log.info(this.message); return true;
      }
      t.phase = 'open'; t.at = now(); t.openSent = false;
    }
    if (t.phase === 'open') {
      if (now() - t.at > 15000) { this.fail('Merchant did not open the shop.'); return true; }
      const npc = [...World.ents.values()].filter(e => e.kind === 'npc' && e.refObjId === t.vendor.refObjId && dist2D(e, t.vendor) < 200).sort((a, b) => dist2D(World.pose(), a) - dist2D(World.pose(), b))[0];
      if (!npc) return true;
      if (gp.targetPending) return true;
      if (gp.target !== npc.gid) { Cmd.select(npc.gid); return true; }
      if (!t.openSent && !gp.inventoryPending && Cmd.raw({ kind: 'shop-open', gid: npc.gid }, 'Auto buy: open merchant')) { t.openSent = true; t.revision = gp.shopCompletionRevision; }
      // A cached catalogue must not count as a fresh shop-open acknowledgement.
      if (t.openSent && !gp.inventoryPending && gp.shop?.npc === npc.gid && gp.shopCompletionRevision !== t.revision) { t.phase = 'buy'; t.at = now(); }
      return true;
    }
    if (t.phase === 'buy') {
      const shop = this.activeShop();
      if (!shop || shop.error || gp.error) { this.fail(shop?.error || gp.error || 'Merchant selection changed.'); return true; }
      if (t.pending) {
        if (now() - t.pending.at > 12000) { this.fail('Purchase was not confirmed; no repeat purchase sent.'); return true; }
        if (gp.inventoryPending || now() - t.pending.at < 500) return true;
        if (this.count(t.pending.ref) < t.pending.before + t.pending.quantity) return true;
        t.pending = null;
      }
      if (gp.inventoryPending) return true;
      const s = t.supplies.find(i => this.count(i.refObjId) < i.target);
      if (!s) {
        if (Cmd.raw({ kind: 'npc-close' }, 'Auto buy: close merchant')) {
          t.phase = 'return'; t.index = 1; t.best = Infinity; t.progressAt = now(); t.movedAt = 0;
          this.message = 'Returning to hunting spot';
        }
        return true;
      }
      const offer = shop.offers.find(o => o.refObjId === s.refObjId && this.offerKind(o) === s.kind);
      if (!offer) { this.fail(s.kind === 'cure' ? 'Special Universal Pill (small) is unavailable at this merchant.' : 'Selected potion is unavailable at this merchant.'); return true; }
      const before = this.count(s.refObjId);
      const stackRoom = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
      const quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, stackRoom + World.freeBagSlots() * offer.maxStack);
      if (quantity < 1) { this.fail('Inventory full; make room for potions.'); return true; }
      const gold = gp.progression?.gold;
      if (gold === undefined || toBigInt(offer.price) * BigInt(quantity) > toBigInt(gold)) { this.fail('Not enough gold for the potion refill.'); return true; }
      if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, `Auto buy: ${offer.name} x${quantity}`)) t.pending = { ref: s.refObjId, before, quantity, at: now() };
      return true;
    }
    return true;
  },
};

const Hunt = {
  running: false,
  paused: false,
  state: 'idle',
  targetGid: 0,
  targetSince: 0,
  targetHpMark: null,
  selTries: 0,
  lootGid: 0,
  lootSince: 0,
  lootBan: new Map(),
  ban: new Map(),
  sitToggleAt: 0,
  lastMoveAt: 0,
  deathAt: 0,
  revived: false,
  pauseUntil: 0,
  pauseReason: '',
  playerSeen: new Map(),

  cfg() {
    return Settings.profile.hunt;
  },

  start() {
    WalkBack.cancel();
    if (!World.inWorld()) return UI.toast('Enter the game world first.', 'warn');
    const H = this.cfg();
    if (!H.center) this.setCenter();
    this.running = true;
    this.paused = false;
    Loot.reset();
    this.state = 'start';
    this.targetGid = 0;
    this.selTries = 0;
    this.lootGid = 0;
    this.revived = false;
    this.ban.clear();
    this.lootBan.clear();
    Stats.huntStart();

    UI.toast('Hunting started', 'info', 2500);
    Sound.play('good');
    Log.info('Hunting started.');
    bus.emit('hunt', true);
  },

  stop(reason) {
    if (!this.running) return;
    if (World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    Restock.trip = null;
    Loot.suspend();
    this.running = false;
    this.state = 'idle';
    Stats.huntStop();
    UI.toast(reason ? 'Hunting stopped: ' + reason : 'Hunting stopped', reason ? 'warn' : 'info', 3500);
    Log.info('Hunting stopped' + (reason ? ': ' + reason : '.'));
    bus.emit('hunt', false);
  },

  toggle() {
    if (WalkBack.active) return WalkBack.cancel();
    this.running ? this.stop() : this.start();
  },

  setCenter() {
    const p = World.pose();
    if (!p) return false;
    Settings.profile.hunt.center = { regionId: p.regionId, x: p.x, y: p.y, z: p.z };
    Settings.saveProfile();
    bus.emit('center');
    return true;
  },

  knownSkillIds() {
    return (World.gp?.skills || []).slice();
  },

  banned(map, gid) {
    const until = map.get(gid);
    if (!until) return false;
    if (until < now()) {
      map.delete(gid);
      return false;
    }
    return true;
  },

  inArea(e) {
    const H = this.cfg();
    if (!H.center) return true;
    return dist2D(H.center, e) <= H.radius;
  },

  underAttack(ms = 5000) {
    const sim = World.simNow();
    if (sim == null) return false;
    for (const [gid, at] of World.attackers) {
      if (sim - at > ms) continue;
      const e = World.ents.get(gid);
      if (e && World.isAlive(e)) return true;
    }
    return false;
  },

  classAllowed(e) {
    const cls = monsterClass(e);
    return !!this.cfg().classes[cls];
  },

  chooseTarget() {
    const H = this.cfg();
    const pose = World.pose();
    if (!pose) return null;
    const sim = World.simNow() ?? 0;
    const inc = splitList(H.include);
    const exc = splitList(H.exclude);
    let best = null;
    let bestScore = Infinity;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e) || this.banned(this.ban, e.gid)) continue;
      const attacking = sim - (World.attackers.get(e.gid) ?? -Infinity) < 6000;
      const d = dist2D(pose, e);
      if (!attacking) {
        if (!this.classAllowed(e)) continue;
        if (H.levelMin && (e.level ?? 0) < H.levelMin) continue;
        if (H.levelMax && (e.level ?? 0) > H.levelMax) continue;
        const name = (e.name || '').toLowerCase();
        if (inc.length && !inc.some((s) => name.includes(s))) continue;
        if (exc.some((s) => name.includes(s))) continue;
        if (!this.inArea(e) || d > H.chase) continue;
        if (H.avoidKs && sim - (World.hitByOthers.get(e.gid) ?? -Infinity) < 8000 && sim - (World.hitByUs.get(e.gid) ?? -Infinity) > 8000) continue;
      } else if (d > H.chase * 1.5) continue;
      let score = d;
      if (H.priority === 'attackers' && attacking) score -= 100000;
      if (H.priority === 'lowhp') score = (World.hpPctOf(e) ?? 100) * 20 + d / 10 - (attacking ? 50000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  },

  playerCheck() {
    const A = this.cfg().playerAlert;
    if (!A.enabled) return false;
    const pose = World.pose();
    const party = new Set((World.gp?.social?.members || []).map((m) => m.name));
    let found = null;
    for (const e of World.ents.values()) {
      if (e.kind !== 'player' || party.has(e.name)) continue;
      if (dist2D(pose, e) > A.radius) continue;
      found = e;
      const last = this.playerSeen.get(e.gid) || 0;
      if (now() - last > 60000) {
        this.playerSeen.set(e.gid, now());
        bus.emit('alert', 'player', e);
      }
    }
    return !!(found && A.pause);
  },

  currentTarget() {
    if (!this.targetGid) return null;
    const e = World.ents.get(this.targetGid);
    if (!e || !isAttackableMob(e)) {
      this.targetGid = 0;
      return null;
    }
    // Give up on targets we cannot damage (blocked path, invulnerable, ...).
    const H = this.cfg();
    const hp = World.hpOf(e.gid);
    if (hp !== this.targetHpMark) {
      this.targetHpMark = hp;
      this.targetSince = now();
    } else if (now() - this.targetSince > H.targetTimeoutS * 1000) {
      this.ban.set(e.gid, now() + 60000);
      Log.warn('Target dropped (no damage dealt): ' + (e.name || e.gid));
      this.targetGid = 0;
      return null;
    }
    return e;
  },

  engage(target) {
    if (this.targetGid !== target.gid) {
      this.targetGid = target.gid;
      this.targetSince = now();
      this.targetHpMark = World.hpOf(target.gid);
      this.selTries = 0;
    }
    if (World.gp.target !== target.gid) {
      this.state = 'select';
      if (World.gp.targetPending) return; // wait for the grant/rejection of the last send
      if (this.selTries >= 3) {
        // 3 unconfirmed selects: the server refuses this gid.
        this.ban.set(target.gid, now() + 60000);
        Log.warn('Target could not be selected, dropped: ' + (target.name || target.gid));
        this.targetGid = 0;
        this.selTries = 0;
        return;
      }
      if (Cmd.select(target.gid)) this.selTries++;
      return;
    }
    this.selTries = 0;
    this.state = 'fight';
    Combat.fight(target);
  },

  stateText() {
    const S = {
      restock: 'Restocking / returning to hunt',
      idle: 'Idle',
      start: 'Starting',
      waiting: 'Waiting for game',
      dead: 'Dead',
      manual: 'Manual control',
      player: 'Player nearby (paused)',
      resting: 'Resting',
      standing: 'Standing up',
      buff: 'Buffing',
      loot: 'Looting',
      search: 'Searching',
      return: 'Returning',
      select: 'Selecting',
      fight: 'Fighting',
    };
    return S[this.state] || this.state;
  },
};

// Outdoor routing over the collision product already admitted by the game.
// A 20-unit A* grid respects blocked terrain, object walls and linked portals.
// Native movement remains the final authority for height and collision response.
const Navigation = {
  scene: null, revision: 0, error: '',
  bytes(value, size) {
    const raw = atob(value), out = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (out.length !== size) throw Error('Invalid navigation grid');
    return out;
  },
  capture(command) {
    const c = command?.command || command;
    if (c?.kind !== 'navigation') return;
    try { this.install(c.bundle); } catch (e) { this.scene = null; this.error = e.message; Log.warn('Walk-back navigation: ' + e.message); }
  },
  install(product) {
    if (!product?.complete || (product.regionId & DUNGEON)) throw Error('Outdoor collision data required');
    const nav = product.navmesh;
    if (nav?.tileSize !== 20 || nav.regionSize !== SECTOR || nav.tilesPerAxis !== 96) throw Error('Unsupported collision data');
    const scene = { regionId: product.regionId, grids: new Map(), walls: new Map() };
    for (const row of nav.regions || []) {
      if (Math.abs(row.dx) > 1 || Math.abs(row.dz) > 1) throw Error('Invalid collision coverage');
      scene.grids.set(row.dx + ',' + row.dz, { blocked: this.bytes(row.blockedTiles, 9216),
        cells: new DataView(this.bytes(row.tileCellIds, 36864).buffer), count: row.cells.count });
    }
    const add = wall => {
      const minX = Math.floor((Math.min(wall[0], wall[2]) - 2) / 80), maxX = Math.floor((Math.max(wall[0], wall[2]) + 2) / 80);
      const minZ = Math.floor((Math.min(wall[1], wall[3]) - 2) / 80), maxZ = Math.floor((Math.max(wall[1], wall[3]) + 2) / 80);
      if ((maxX - minX + 1) * (maxZ - minZ + 1) > 10000) throw Error('Oversized collision wall');
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = x + ',' + z;
        if (!scene.walls.has(key)) scene.walls.set(key, []);
        scene.walls.get(key).push(wall);
      }
    };
    for (const p of product.objects || []) {
      const m = p.mesh;
      if (!m || m.passThrough) continue;
      if (p.terrainCells && !p.terrainCells.length) continue;
      const linked = new Set((p.links || []).map(l => l.edge));
      const vertex = id => {
        const x = m.vertices[id * 3], z = m.vertices[id * 3 + 2], c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        return [c * x - s * z + p.x, s * x + c * z + p.z];
      };
      for (let i = 0; i < m.edges.length; i += 6) {
        const outline = m.edges[i + 5] === 0, flags = m.edges[i + 4];
        // Native terrain contact ignores open outlines, terrain-owned surface
        // borders (0x10) and internal edges of terrain-indexed placements.
        if (outline && flags === 0) continue;
        if (p.terrainCells && (!outline || (flags & 0x10))) continue;
        if (outline && (flags & 8) && linked.has(i / 6)) continue;
        if (!outline && !(flags & 3)) continue;
        const wall = [...vertex(m.edges[i]), ...vertex(m.edges[i + 1])];
        // Flags 1/2 block one approach side only. Preserve source-cell winding
        // so an allowed exit from a town object is not turned into an enclosure.
        if (!(flags & 8) && (flags & 3) !== 3 && (flags & 3) && m.cells) {
          const ids = Array.from(m.cells.slice(m.edges[i + 2] * 3, m.edges[i + 2] * 3 + 3));
          if (ids.length === 3) {
            const points = ids.map(vertex);
            wall.push(flags, points.reduce((n, p) => n + p[0], 0) / 3, points.reduce((n, p) => n + p[1], 0) / 3);
          }
        }
        add(wall);
      }
    }
    this.scene = scene; this.error = ''; this.revision++;
  },
  local(p) {
    const d = regionDelta({ regionId: this.scene.regionId, x: 0, z: 0 }, p);
    return d && { x: d[0], z: d[1] };
  },
  pose(p, y) {
    const sx = Math.floor(p.x / SECTOR), sz = Math.floor(p.z / SECTOR);
    return { regionId: ((this.scene.regionId & 255) + sx) | (((this.scene.regionId >>> 8) + sz) << 8),
      x: p.x - sx * SECTOR, z: p.z - sz * SECTOR, y };
  },
  open(x, z) {
    const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR), grid = this.scene.grids.get(sx + ',' + sz);
    if (!grid) return false;
    const tx = Math.floor((x - sx * SECTOR) / 20), tz = Math.floor((z - sz * SECTOR) / 20), i = tz * 96 + tx;
    return !grid.blocked[i] && grid.cells.getUint32(i * 4, true) < grid.count;
  },
  nearSegment(p, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, n = dx * dx + dz * dz;
    const t = n ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / n, 0, 1) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
  },
  clear(a, b, departing = false) {
    const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / 8));
    let reachedOpen = this.open(a.x, a.z);
    for (let i = 1; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, z = a.z + (b.z - a.z) * i / steps;
      if (!this.covered(x, z)) return false;
      if (this.open(x, z)) reachedOpen = true;
      else if (!departing || reachedOpen) return false;
    }
    if (!reachedOpen) return false;
    const minX = Math.floor((Math.min(a.x, b.x) - 2) / 80), maxX = Math.floor((Math.max(a.x, b.x) + 2) / 80);
    const minZ = Math.floor((Math.min(a.z, b.z) - 2) / 80), maxZ = Math.floor((Math.max(a.z, b.z) + 2) / 80);
    const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const seen = new Set();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (const w of this.scene.walls.get(x + ',' + z) || []) {
      if (seen.has(w)) continue; seen.add(w);
      const c = { x: w[0], z: w[1] }, d = { x: w[2], z: w[3] };
      if (w.length > 4) {
        const side = cross(c, d, { x: w[5], z: w[6] }), approach = cross(c, d, a) || -cross(c, d, b);
        if (Math.abs(side) > 1e-9 && !(approach * side > 0 ? w[4] & 2 : w[4] & 1)) continue;
      }
      const intersects = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
      if (intersects || Math.min(this.nearSegment(a, c, d), this.nearSegment(b, c, d), this.nearSegment(c, a, b), this.nearSegment(d, a, b)) < 2) return false;
    }
    return true;
  },
  plan(from, to, arrivalRadius = 0, options = {}) {
    if (!this.scene || (from.regionId | to.regionId) & DUNGEON) return null;
    const start = this.local(from), goal = this.local(to);
    if (!start || !goal || !this.open(start.x, start.z)) return null;
    if (Math.hypot(goal.x - start.x, goal.z - start.z) < 1800 && this.clear(start, goal)) return [to];
    const key = p => p.x + ',' + p.z, center = p => ({ x: p.x * 20 + 10, z: p.z * 20 + 10 });
    const h = p => Math.hypot(center(p).x - goal.x, center(p).z - goal.z) / 20;
    const first = { x: Math.floor(start.x / 20), z: Math.floor(start.z / 20), g: 0, parent: null };
    first.f = h(first); const scores = new Map([[key(first), 0]]), closed = new Set(), heap = [];
    const push = p => { heap.push(p); let i = heap.length - 1; while (i) { const parent = (i - 1) >> 1; if (heap[parent].f <= p.f) break; heap[i] = heap[parent]; i = parent; } heap[i] = p; };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++; if (last.f <= heap[c].f) break; heap[i] = heap[c]; i = c; } heap[i] = last; }
      return top;
    };
    push(first); let best = first, reached = false;
    let visited = 0;
    for (; heap.length && visited < (options.maxNodes ?? 60000); visited++) {
      const p = pop(), k = key(p); if (closed.has(k)) continue; closed.add(k);
      if (h(p) < h(best)) best = p;
      const a = p === first ? start : center(p);
      if (Math.hypot(a.x - goal.x, a.z - goal.z) <= arrivalRadius) { best = p; reached = true; break; }
      if (h(p) < 2 && this.clear(a, goal)) { best = p; reached = true; break; }
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
        const q = { x: p.x + dx, z: p.z + dz, g: p.g + Math.hypot(dx, dz), parent: p }, b = center(q), qk = key(q);
        if (closed.has(qk) || q.g >= (scores.get(qk) ?? Infinity) || !this.clear(a, b)) continue;
        if (dx && dz && (!this.open(a.x + dx * 20, a.z) || !this.open(a.x, a.z + dz * 20))) continue;
        q.f = q.g + h(q); scores.set(qk, q.g); push(q);
      }
    }
    if (options.result) { options.result.limited = !reached && heap.length > 0; options.result.visited = visited; }
    const goalCovered = this.scene.grids.has(Math.floor(goal.x / SECTOR) + ',' + Math.floor(goal.z / SECTOR));
    if (!reached && (goalCovered || h(first) - h(best) < 2)) return [];
    const path = []; for (let p = best; p && p !== first; p = p.parent) path.push(center(p)); path.reverse();
    if (reached && (!arrivalRadius || Math.hypot(center(best).x - goal.x, center(best).z - goal.z) > arrivalRadius)) path.push(goal);
    // Smooth only segments whose terrain and object collision checks both pass.
    const result = []; let anchor = start;
    for (let i = 0; i < path.length;) {
      let j = i; while (j + 1 < path.length && Math.hypot(path[j + 1].x - anchor.x, path[j + 1].z - anchor.z) < (options.maxChord ?? 600) && this.clear(anchor, path[j + 1])) j++;
      result.push(this.pose(path[j], from.y)); anchor = path[j]; i = j + 1;
    }
    return result;
  },
  // The game publishes collision data only for the 3x3 regions around the
  // character, so a long walk is planned in short legs. A point on the straight
  // line towards the goal is kept inside the loaded window; walking to it
  // crosses a region border, which makes the game publish the next window.
  legPoint(from, to, length) {
    if (!this.scene) return null;
    const delta = regionDelta(from, to), start = this.local(from);
    const total = delta ? Math.hypot(delta[0], delta[1]) : Infinity;
    if (!start || !Number.isFinite(total) || total <= 0) return null;
    for (let reach = Math.min(length, total); reach >= 100; reach *= 0.5) {
      const local = { x: start.x + delta[0] / total * reach, z: start.z + delta[1] / total * reach };
      if (this.covered(local.x, local.z)) return this.pose(local, from.y);
    }
    return null;
  },
  // Nearest walkable grid tile around a blocked leg end, searched outwards.
  snap(point, radius = 240) {
    if (!this.scene) return null;
    const p = this.local(point);
    if (!p) return null;
    if (this.open(p.x, p.z)) return { ...point };
    for (let r = 20; r <= radius; r += 20) {
      const steps = Math.max(8, Math.ceil(2 * Math.PI * r / 20));
      for (let i = 0; i < steps; i++) {
        const angle = i * 2 * Math.PI / steps;
        const x = p.x + Math.cos(angle) * r, z = p.z + Math.sin(angle) * r;
        if (this.open(x, z)) return this.pose({ x, z }, point.y);
      }
    }
    return null;
  },
  // A blocked leg end is replaced by a snapped or slightly turned leg of the same
  // approximate length, so the next leg can continue towards the goal. Only a
  // route that really reaches the candidate is accepted.
  detour(from, goal, length, options = {}) {
    if (!this.scene) return null;
    const start = this.local(from), delta = regionDelta(from, goal);
    const total = delta ? Math.hypot(delta[0], delta[1]) : Infinity;
    if (!start || !Number.isFinite(total) || total <= 0) return null;
    const reach = Math.min(length, total), base = Math.atan2(delta[1], delta[0]);
    const point = angle => {
      const local = { x: start.x + Math.cos(angle) * reach, z: start.z + Math.sin(angle) * reach };
      return this.covered(local.x, local.z) ? this.pose(local, from.y) : null;
    };
    const candidates = [], straight = point(base);
    const snapped = straight && this.snap(straight, options.radius ?? 240);
    if (snapped) candidates.push(snapped);
    if (reach > 200) {
      const local = { x: start.x + Math.cos(base) * reach * .5, z: start.z + Math.sin(base) * reach * .5 };
      if (this.covered(local.x, local.z)) candidates.push(this.pose(local, from.y));
    }
    for (const turn of [.5, -.5, 1, -1, 1.5, -1.5]) {
      const turned = point(base + turn);
      if (turned) candidates.push(turned);
    }
    for (const candidate of candidates) {
      const route = this.plan(from, candidate, 0, { maxNodes: options.maxNodes ?? 20000 });
      if (route?.length && dist2D(route[route.length - 1], candidate) <= 15) return candidate;
    }
    return null;
  },
  next(owner, destination, recorded = false, arrivalRadius = 0) {
    const pose = World.pose(), previous = owner.travel;
    if (!this.scene || (pose.regionId & DUNGEON)) {
      return recorded ? { point: destination } : { waiting: true, error: this.error || 'Waiting for game collision data. Reload the game if attached late, or record a walking route.' };
    }
    if (!previous || previous.revision !== this.revision || dist2D(previous.destination, destination) > 1 || previous.index >= previous.route.length) {
      let route = this.plan(pose, destination);
      if (route && !route.length && arrivalRadius > 0) route = this.plan(pose, destination, arrivalRadius);
      if (!route) return { waiting: true, error: 'Waiting for collision coverage at the current position.' };
      if (!route.length) return { error: 'No walkable route found through the loaded collision map.' };
      owner.travel = { destination: { ...destination }, route, index: 0, revision: this.revision };
    }
    const travel = owner.travel;
    while (travel.index < travel.route.length && dist2D(pose, travel.route[travel.index]) <= 7) travel.index++;
    return travel.index < travel.route.length ? { point: travel.route[travel.index] } : { waiting: true };
  },
};
Hook.observers.push(command => Navigation.capture(command));


/*
===========================================================================
lean-pursuit-navigation.js - bounded, explicit pursuit and escape queries

Uses admitted game collision products. A query never changes a player pose;
the native movement command and its observed result remain authoritative.
===========================================================================
*/
const PURSUIT_NAV = { nodes: 6000, chord: 120, step: 60, arrive: 7, candidates: 4 };

/*
================
Navigation.covered
================
*/
Navigation.covered = function( x, z ) {
	return !!this.scene?.grids.has( Math.floor( x / SECTOR ) + "," + Math.floor( z / SECTOR ) );
};

/*
================
Navigation.pointStatus

Terrain openness alone is not object clearance. Closed object interiors still
require a reachable chord; this query deliberately makes no ownership claim.
================
*/
Navigation.pointStatus = function( pose ) {
	if ( !pose || !this.scene || pose.regionId & DUNGEON ) return "unknown";
	const p = this.local( pose );
	if ( !p || !this.covered( p.x, p.z ) ) return "unknown";
	return this.open( p.x, p.z ) && this.clear( p, p ) ? "open" : "blocked";
};

/*
================
Navigation.setClipQuery

Optional synchronous, read-only client adapter. A missing/unknown reply never
authorizes movement. The default implementation uses the existing bundle.
================
*/
Navigation.setClipQuery = function( query = null ) {
	if ( query !== null && typeof query !== "function" ) throw Error( "Invalid clip query" );
	this.clipQuery = query;
};

/*
================
Navigation.segment
================
*/
Navigation.segment = function( from, to, departing = false ) {
	if ( !from || !to || !Number.isFinite( dist2D( from, to ) ) ) return false;
	// This product describes X/Z traversal, not terrain slope. Native movement
	// resolves height; a destination's different Y is not evidence of a wall.
	if ( this.pointStatus( to ) !== "open" ) return false;
	const a = this.local( from ), b = this.local( to );
	if ( !a || !b || !this.clear( a, b, departing ) ) return false;
	if ( !this.clipQuery ) return true;
	try {
		const clipped = this.clipQuery( {
			from: { ...from },
			to: { ...to },
			epoch: World.epoch,
			revision: this.revision
		} );
		return !!clipped && clipped.epoch === World.epoch && clipped.revision === this.revision &&
			Number.isFinite( clipped.pose?.y ) && Math.abs( clipped.pose.y - (to.y ?? 0) ) <= 2 &&
			dist2D( clipped.pose, to ) <= 2;
	} catch {
		return false;
	}
};

/*
================
Navigation.query

The legacy plan/next interface stays intact for town and recorded routes.
Pursuit must distinguish an unavailable map from a proven failed search.
================
*/
Navigation.query = function( from, to, maxNodes = PURSUIT_NAV.nodes ) {
	const start = this.pointStatus( from ), end = this.pointStatus( to );
	if ( start === "unknown" || end === "unknown" ) return { status: "unknown", route: [] };
	if ( start === "blocked" ) return { status: "invalid-start", route: [] };
	if ( this.segment( from, to ) ) return { status: "direct", route: [ to ] };
	const result = {};
	const route = this.plan( from, to, 0, { maxNodes, maxChord: PURSUIT_NAV.chord, result } );
	if ( !route?.length ) {
		return { status: result.limited ? "search-limit" : "unreachable", route: [], visited: result.visited };
	}
	let previous = from;
	for ( const point of route ) {
		if ( !this.segment( previous, point ) ) return { status: "unreachable", route: [], visited: result.visited };
		previous = point;
	}
	return { status: "route", route, visited: result.visited };
};

/*
================
Navigation.attackRoute

Only consider nearby stand-off goals when their final approach is clear.
Walking obstruction is never treated as projectile line-of-sight.
================
*/
Navigation.attackRoute = function( from, target, radius, failed = [] ) {
	const direct = this.query( from, target );
	if ( ![ "route", "unreachable" ].includes( direct.status ) || radius <= PURSUIT_NAV.arrive ) return direct;
	const delta = regionDelta( target, from );
	if ( !delta ) return direct;
	const angle = Math.atan2( delta[1], delta[0] ), local = this.local( target );
	let budget = PURSUIT_NAV.nodes - (direct.visited || 0);
	for ( let i = 0; i < PURSUIT_NAV.candidates && budget > 0; i++ ) {
		const theta = angle + [ 0, Math.PI / 2, -Math.PI / 2, Math.PI ][i];
		const goal = this.pose(
			{ x: local.x + Math.cos( theta ) * radius, z: local.z + Math.sin( theta ) * radius },
			from.y
		);
		if ( failed.some( p => dist2D( p, goal ) < PURSUIT_NAV.step ) || !this.segment( goal, target ) ) continue;
		const route = this.query( from, goal, budget );
		budget -= route.visited || 0;
		// A direct leg to a stand-off goal still needs explicit movement.
		if ( route.status === "route" || route.status === "direct" ) return { ...route, status: "route" };
	}
	return direct;
};

/*
================
Navigation.escapeCandidates

Never cross object walls to get out of a blocked terrain start. Native terrain
departure permits a contiguous blocked prefix, but not reentry or missing data.
================
*/
Navigation.escapeCandidates = function( from ) {
	if ( !this.scene || !from || from.regionId & DUNGEON ) return [];
	const p = this.local( from ), out = [];
	for ( const radius of [ 20, 40, 80, 120 ] ) {
		for ( let i = 0; i < 8; i++ ) {
			const theta = i * Math.PI / 4;
			const to = this.pose(
				{ x: p.x + Math.cos( theta ) * radius, z: p.z + Math.sin( theta ) * radius },
				from.y
			);
			if ( this.segment( from, to, true ) ) out.push( to );
		}
		if ( out.length >= PURSUIT_NAV.candidates ) break;
	}
	return out.sort( ( a, b ) => dist2D( from, a ) - dist2D( from, b ) ).slice( 0, PURSUIT_NAV.candidates );
};


// Generated by tools/convert-navdata.py from third-party navigation data.
// Bounds and sizes only; the route data stays in navdata-lean/ and is loaded on demand.
const NAVDATA_BASE = 'https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/navdata-lean/';
const NAVDATA_AREAS = [
  {"name":"nav01","file":"nav01.bin","minX":299220,"maxX":334820,"minZ":172440,"maxZ":197690,"nodes":14148,"cell":19.2,"dungeon":false,"rev":"3d2e27e249"},
  {"name":"nav02","file":"nav02.bin","minX":274580,"maxX":311140,"minZ":171000,"maxZ":205140,"nodes":15273,"cell":19.2,"dungeon":false,"rev":"fb563acde7"},
  {"name":"nav03","file":"nav03.bin","minX":232360,"maxX":270700,"minZ":162580,"maxZ":203500,"nodes":18467,"cell":22.4,"dungeon":false,"rev":"9b13f42eb5"},
  {"name":"nav04","file":"nav04.bin","minX":170520,"maxX":232120,"minZ":184720,"maxZ":209260,"nodes":16160,"cell":22.4,"dungeon":false,"rev":"f20b0bc36e"},
  {"name":"nav05","file":"nav05.bin","minX":131500,"maxX":157260,"minZ":182700,"maxZ":211190,"nodes":18537,"cell":16.0,"dungeon":false,"rev":"e1455a841a"},
  {"name":"nav06","file":"nav06.bin","minX":200520,"maxX":228040,"minZ":162600,"maxZ":189640,"nodes":18464,"cell":16.0,"dungeon":false,"rev":"46fe3e37ce"},
  {"name":"nav07","file":"nav07.bin","minX":91010,"maxX":108600,"minZ":163960,"maxZ":182390,"nodes":6338,"cell":12.8,"dungeon":false,"rev":"b1957dc25c"},
  {"name":"nav08","file":"nav08.bin","minX":122940,"maxX":147780,"minZ":155580,"maxZ":170820,"nodes":15673,"cell":12.8,"dungeon":false,"rev":"2f45f3b6a0"},
  {"name":"nav09","file":"nav09.bin","minX":109160,"maxX":145270,"minZ":139880,"maxZ":148040,"nodes":8527,"cell":12.8,"dungeon":false,"rev":"a2a8c7e345"},
  {"name":"nav10","file":"nav10.bin","minX":367750,"maxX":377510,"minZ":218750,"maxZ":226350,"nodes":876,"cell":12.8,"dungeon":false,"rev":"6d8b66ff6f"},
  {"name":"nav11","file":"nav11.bin","minX":367750,"maxX":377510,"minZ":232190,"maxZ":239790,"nodes":876,"cell":12.8,"dungeon":false,"rev":"6b01c8f5c4"},
  {"name":"nav12","file":"nav12.bin","minX":342790,"maxX":352550,"minZ":232190,"maxZ":239790,"nodes":876,"cell":12.8,"dungeon":false,"rev":"1283904724"},
  {"name":"nav13","file":"nav13.bin","minX":386830,"maxX":403980,"minZ":163930,"maxZ":191050,"nodes":15332,"cell":12.8,"dungeon":false,"rev":"ad1fe5e8f6"},
  {"name":"nav14","file":"nav14.bin","minX":451530,"maxX":456530,"minZ":236530,"maxZ":241710,"nodes":1105,"cell":12.8,"dungeon":false,"rev":"dd005df03c"},
  {"name":"nav15","file":"nav15.bin","minX":434190,"maxX":444830,"minZ":234890,"maxZ":243150,"nodes":1682,"cell":12.8,"dungeon":false,"rev":"c4e12983eb"},
  {"name":"nav16","file":"nav16.bin","minX":429020,"maxX":446450,"minZ":207170,"maxZ":221970,"nodes":3526,"cell":12.8,"dungeon":false,"rev":"d5270f1a64"},
  {"name":"nav17","file":"nav17.bin","minX":461780,"maxX":479050,"minZ":203940,"maxZ":221090,"nodes":2275,"cell":12.8,"dungeon":false,"rev":"6f32fc4549"},
  {"name":"nav20","file":"nav20.bin","minX":155530,"maxX":184310,"minZ":143170,"maxZ":174710,"nodes":16054,"cell":19.2,"dungeon":true,"rev":"16b253ed59"},
  {"name":"nav22","file":"nav22.bin","minX":151690,"maxX":159350,"minZ":140500,"maxZ":157250,"nodes":4525,"cell":12.8,"dungeon":false,"rev":"dc7baa613d"},
  {"name":"nav30","file":"nav30.bin","minX":130570,"maxX":143970,"minZ":126730,"maxZ":138210,"nodes":7789,"cell":12.8,"dungeon":false,"rev":"f4453bf987"},
  {"name":"nav31","file":"nav31.bin","minX":147830,"maxX":155510,"minZ":128650,"maxZ":136310,"nodes":2723,"cell":12.8,"dungeon":false,"rev":"20df37fe40"},
  {"name":"nav32","file":"nav32.bin","minX":131090,"maxX":140830,"minZ":110090,"maxZ":124410,"nodes":4313,"cell":12.8,"dungeon":false,"rev":"086acfbeab"},
  {"name":"nav33","file":"nav33.bin","minX":172880,"maxX":184240,"minZ":113360,"maxZ":124720,"nodes":6211,"cell":12.8,"dungeon":false,"rev":"5dbb5b0364"},
  {"name":"nav34","file":"nav34.bin","minX":413430,"maxX":415310,"minZ":233470,"maxZ":235330,"nodes":102,"cell":12.8,"dungeon":false,"rev":"a1030fe877"},
  {"name":"nav35","file":"nav35.bin","minX":408650,"maxX":409610,"minZ":233770,"maxZ":235250,"nodes":47,"cell":12.8,"dungeon":false,"rev":"5f966f385f"},
  {"name":"nav36","file":"nav36.bin","minX":418990,"maxX":420290,"minZ":233740,"maxZ":234290,"nodes":22,"cell":12.8,"dungeon":false,"rev":"0f2c34627c"},
  {"name":"nav37","file":"nav37.bin","minX":411250,"maxX":412100,"minZ":222770,"maxZ":223850,"nodes":49,"cell":12.8,"dungeon":false,"rev":"a839e6fd29"},
  {"name":"nav38","file":"nav38.bin","minX":408950,"maxX":409910,"minZ":220710,"maxZ":221940,"nodes":67,"cell":12.8,"dungeon":false,"rev":"91f46b3e18"},
  {"name":"nav39","file":"nav39.bin","minX":412770,"maxX":414470,"minZ":220150,"maxZ":221850,"nodes":110,"cell":12.8,"dungeon":false,"rev":"64bca71a2b"},
  {"name":"nav40","file":"nav40.bin","minX":463690,"maxX":465670,"minZ":239100,"maxZ":240930,"nodes":215,"cell":12.8,"dungeon":false,"rev":"cd9abe36dd"},
  {"name":"nav43","file":"nav43.bin","minX":359050,"maxX":364790,"minZ":180490,"maxZ":184310,"nodes":835,"cell":12.8,"dungeon":false,"rev":"0d7d56fdd2"},
  {"name":"nav44","file":"nav44.bin","minX":414550,"maxX":418730,"minZ":207370,"maxZ":211190,"nodes":870,"cell":12.8,"dungeon":false,"rev":"e77185f116"},
  {"name":"nav45","file":"nav45.bin","minX":405970,"maxX":406870,"minZ":201910,"maxZ":203230,"nodes":60,"cell":12.8,"dungeon":false,"rev":"289473ba5c"},
  {"name":"nav46","file":"nav46.bin","minX":407070,"maxX":407950,"minZ":201910,"maxZ":203220,"nodes":61,"cell":12.8,"dungeon":false,"rev":"77ac3aac1b"},
  {"name":"nav47","file":"nav47.bin","minX":349450,"maxX":351350,"minZ":184330,"maxZ":186230,"nodes":190,"cell":12.8,"dungeon":false,"rev":"250df65a19"},
  {"name":"nav48","file":"nav48.bin","minX":453210,"maxX":454970,"minZ":190170,"maxZ":191890,"nodes":136,"cell":12.8,"dungeon":false,"rev":"fedd6e2992"},
  {"name":"nav49","file":"nav49.bin","minX":461610,"maxX":463260,"minZ":189870,"maxZ":191530,"nodes":134,"cell":12.8,"dungeon":false,"rev":"0b9d9c9694"},
  {"name":"nav50","file":"nav50.bin","minX":471230,"maxX":473410,"minZ":189030,"maxZ":191210,"nodes":265,"cell":12.8,"dungeon":false,"rev":"9701ab5388"},
  {"name":"nav51","file":"nav51.bin","minX":405610,"maxX":406550,"minZ":241990,"maxZ":243330,"nodes":78,"cell":12.8,"dungeon":false,"rev":"48a8dd8641"},
  {"name":"nav52","file":"nav52.bin","minX":413590,"maxX":413950,"minZ":242370,"maxZ":243390,"nodes":17,"cell":12.8,"dungeon":true,"rev":"9435d9683b"},
  {"name":"nav53","file":"nav53.bin","minX":421610,"maxX":423390,"minZ":242270,"maxZ":243510,"nodes":118,"cell":12.8,"dungeon":false,"rev":"cdf9e0ca96"},
  {"name":"nav54","file":"nav54.bin","minX":350090,"maxX":350710,"minZ":170950,"maxZ":171660,"nodes":35,"cell":12.8,"dungeon":false,"rev":"56c7c4d857"},
  {"name":"nav55","file":"nav55.bin","minX":350460,"maxX":350750,"minZ":167550,"maxZ":167850,"nodes":12,"cell":12.8,"dungeon":false,"rev":"ec0632e4a7"},
  {"name":"nav56","file":"nav56.bin","minX":362730,"maxX":365030,"minZ":194190,"maxZ":196450,"nodes":207,"cell":12.8,"dungeon":false,"rev":"a860e57cc5"},
  {"name":"nav57","file":"nav57.bin","minX":368870,"maxX":370450,"minZ":192140,"maxZ":193490,"nodes":91,"cell":12.8,"dungeon":false,"rev":"7e40d45b47"},
  {"name":"nav58","file":"nav58.bin","minX":419330,"maxX":430030,"minZ":180510,"maxZ":191950,"nodes":3779,"cell":12.8,"dungeon":false,"rev":"364fb7598e"},
  {"name":"nav59","file":"nav59.bin","minX":436610,"maxX":447310,"minZ":180510,"maxZ":191950,"nodes":3776,"cell":12.8,"dungeon":false,"rev":"eeb0575d26"},
  {"name":"nav60","file":"nav60.bin","minX":419330,"maxX":430030,"minZ":161310,"maxZ":172750,"nodes":3781,"cell":12.8,"dungeon":false,"rev":"b706eef6e7"},
  {"name":"nav61","file":"nav61.bin","minX":436610,"maxX":447330,"minZ":161310,"maxZ":172770,"nodes":3780,"cell":12.8,"dungeon":false,"rev":"37e8e064f1"},
  {"name":"nav62","file":"nav62.bin","minX":451220,"maxX":476150,"minZ":168970,"maxZ":184290,"nodes":16775,"cell":12.8,"dungeon":false,"rev":"d5d73c6ca3"},
  {"name":"nav64","file":"nav64.bin","minX":436610,"maxX":447310,"minZ":180510,"maxZ":191950,"nodes":3776,"cell":12.8,"dungeon":false,"rev":"eeb0575d26"},
  {"name":"nav65","file":"nav65.bin","minX":419330,"maxX":430030,"minZ":161310,"maxZ":172750,"nodes":3781,"cell":12.8,"dungeon":false,"rev":"b706eef6e7"},
  {"name":"nav66","file":"nav66.bin","minX":436610,"maxX":447330,"minZ":161310,"maxZ":172770,"nodes":3780,"cell":12.8,"dungeon":false,"rev":"37e8e064f1"},
];


// Long-range route graph from converted navigation data (lean-navdata-index.js).
// It selects the corridor only. Every step is still walked with Navigation over
// the game's own collision window, which remains the authority for doors,
// objects and the final approach. No route is a normal result: the caller then
// falls back to the leg chaining in WalkBack.
const ROUTE_PAD = 800;        // internal units outside an area's bounds still snap
const ROUTE_SNAP = 900;       // farthest start/end snap to a graph node
const ROUTE_SPACING = 150;    // thinned waypoint spacing
const ROUTE_SEGMENT = 450;    // never skip a longer gap, so local A* stays cheap
const ROUTE_VISITED = 150000;

const Route = {
  areas: typeof NAVDATA_AREAS !== 'undefined' ? NAVDATA_AREAS : [],
  base: typeof NAVDATA_BASE !== 'undefined' ? NAVDATA_BASE : '',
  cache: new Map(), loading: new Map(), dbp: null, loader: null, message: '',
  setAreas(list) { this.areas = Array.isArray(list) ? list : []; this.cache.clear(); this.loading.clear(); this.message = ''; },
  setLoader(fn) { this.loader = typeof fn === 'function' ? fn : null; },
  absolute(p) {
    return p ? { x: (p.regionId & 255) * SECTOR + p.x, z: (p.regionId >>> 8) * SECTOR + p.z } : null;
  },
  areaFor(point) {
    const at = this.absolute(point);
    if (!at) return null;
    let best = null, inside = false;
    for (const area of this.areas) {
      if (area.dungeon || !(area.nodes > 0)) continue;
      if (at.x < area.minX - ROUTE_PAD || at.x > area.maxX + ROUTE_PAD ||
          at.z < area.minZ - ROUTE_PAD || at.z > area.maxZ + ROUTE_PAD) continue;
      const within = at.x >= area.minX && at.x <= area.maxX && at.z >= area.minZ && at.z <= area.maxZ;
      if (!best || within && !inside || within === inside && area.nodes > best.nodes) { best = area; inside = within; }
    }
    return best;
  },
  // Prefer one area that covers both ends; picking independently can select
  // overlapping areas A and B for the two ends when A alone covers both.
  commonArea(from, to) {
    const a = this.absolute(from), b = this.absolute(to);
    if (!a || !b) return null;
    const covers = (area, p) => p.x >= area.minX - ROUTE_PAD && p.x <= area.maxX + ROUTE_PAD &&
      p.z >= area.minZ - ROUTE_PAD && p.z <= area.maxZ + ROUTE_PAD;
    let best = null;
    for (const area of this.areas) {
      if (area.dungeon || !(area.nodes > 0) || !covers(area, a) || !covers(area, b)) continue;
      if (!best || area.nodes > best.nodes) best = area;
    }
    return best;
  },
  async ensure(from, to) {
    const area = this.commonArea(from, to);
    if (!area) { this.message = 'No route data covers both the character and the hunting spot.'; return false; }
    try {
      await this.load(area.name);
      return this.cache.has(area.name);
    } catch (e) {
      this.message = e?.message || 'Route data unavailable.';
      return false;
    }
  },
  load(name) {
    if (this.cache.has(name)) return Promise.resolve(this.cache.get(name));
    if (this.loading.has(name)) return this.loading.get(name);
    const meta = this.areas.find(a => a.name === name);
    if (!meta) return Promise.reject(Error('Unknown route area.'));
    const job = (async () => {
      const key = name + ':' + (meta.rev || VERSION), cached = await this.cached(key);
      let buffer = cached;
      if (!buffer) {
        buffer = await this.fetch(meta);
        if (buffer) this.put(key, buffer);
      }
      if (!buffer) throw Error('Route data unavailable.');
      let area;
      try { area = this.decode(buffer, meta); }
      catch (e) { await this.drop(key); throw e; }
      this.cache.set(name, area);
      return area;
    })();
    this.loading.set(name, job);
    job.then(() => this.loading.delete(name), () => this.loading.delete(name));
    return job;
  },
  fetch(meta) {
    if (this.loader) return Promise.resolve(this.loader(meta.name));
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const url = this.base + meta.file + '?v=' + (meta.rev || VERSION);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 12000) : 0;
    return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller?.signal })
      .then(response => response.ok ? response.arrayBuffer() : null)
      .catch(() => null)
      .finally(() => { if (timer) clearTimeout(timer); });
  },
  db() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(Error('No route cache.'));
      let request;
      try { request = indexedDB.open('nixxane-navdata', 1); } catch (e) { return reject(e); }
      request.onupgradeneeded = () => { try { request.result.createObjectStore('areas'); } catch {} };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || Error('No route cache.'));
    });
    this.dbp.catch(() => {});
    return this.dbp;
  },
  async cached(key) {
    try {
      const db = await this.db();
      return await new Promise((resolve, reject) => {
        const request = db.transaction('areas', 'readonly').objectStore('areas').get(key);
        request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result : null);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  },
  async put(key, buffer) {
    try {
      const db = await this.db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('areas', 'readwrite');
        tx.objectStore('areas').put(buffer, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {}
  },
  async drop(key) {
    try {
      const db = await this.db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('areas', 'readwrite');
        tx.objectStore('areas').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {}
  },
  decode(buffer, meta = null) {
    if (ArrayBuffer.isView(buffer)) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    else if (!(buffer instanceof ArrayBuffer)) buffer = buffer?.buffer || buffer;
    if (!buffer || buffer.byteLength < 24) throw Error('Route data is too short.');
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'NVL1' || view.getUint8(4) !== 1) throw Error('Unsupported route data.');
    const flags = view.getUint8(5), originX = view.getInt32(8, true), originZ = view.getInt32(12, true);
    const count = view.getUint32(16, true), arcs = view.getUint32(20, true);
    const nodesAt = 24, offsetsAt = nodesAt + count * 6, arcsAt = offsetsAt + (count + 1) * 4;
    if (count < 1 || arcsAt + arcs * 2 !== buffer.byteLength) throw Error('Route data size mismatch.');
    const x = new Int32Array(count), z = new Int32Array(count), y = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = originX + view.getInt16(nodesAt + i * 6, true) * 10;
      z[i] = originZ + view.getInt16(nodesAt + i * 6 + 2, true) * 10;
      y[i] = view.getInt16(nodesAt + i * 6 + 4, true);
    }
    const offsets = new Uint32Array(count + 1);
    for (let i = 0; i <= count; i++) offsets[i] = view.getUint32(offsetsAt + i * 4, true);
    if (offsets[0] !== 0 || offsets[count] !== arcs) throw Error('Route data offsets are invalid.');
    for (let i = 0; i < count; i++) if (offsets[i] > offsets[i + 1]) throw Error('Route data offsets are invalid.');
    const neighbours = new Uint16Array(arcs);
    for (let i = 0; i < arcs; i++) {
      const value = view.getUint16(arcsAt + i * 2, true);
      if (value >= count) throw Error('Route data neighbour out of range.');
      neighbours[i] = value;
    }
    return { name: meta?.name || '', file: meta?.file || '', count, x, z, y, offsets, neighbours, dungeon: !!(flags & 1) };
  },
  // One route area, as a typed-array graph. Cross-area travel is deliberately
  // left to the leg fallback: separate route areas can touch in their bounding
  // boxes without sharing walkable nodes.
  graph(area) {
    const count = area.count;
    return { count, x: area.x, z: area.z, y: area.y, offsets: area.offsets, neighbours: area.neighbours };
  },
  nearest(graph, x, z, radius = ROUTE_SNAP) {
    let best = -1, score = radius * radius;
    for (let i = 0; i < graph.count; i++) {
      const dx = graph.x[i] - x, dz = graph.z[i] - z, d = dx * dx + dz * dz;
      if (d < score) { score = d; best = i; }
    }
    return best < 0 ? null : { node: best, distance: Math.sqrt(score) };
  },
  astar(graph, start, goal) {
    const count = graph.count, score = new Float64Array(count).fill(Infinity), came = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count), heap = [];
    const h = i => Math.hypot(graph.x[i] - graph.x[goal], graph.z[i] - graph.z[goal]);
    const push = (node, f) => {
      heap.push({ node, f });
      let i = heap.length - 1;
      while (i) {
        const parent = (i - 1) >> 1;
        if (heap[parent].f <= heap[i].f) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1, right = left + 1;
          let next = i;
          if (left < heap.length && heap[left].f < heap[next].f) next = left;
          if (right < heap.length && heap[right].f < heap[next].f) next = right;
          if (next === i) break;
          [heap[i], heap[next]] = [heap[next], heap[i]];
          i = next;
        }
      }
      return top.node;
    };
    score[start] = 0;
    push(start, h(start));
    let visited = 0;
    while (heap.length && visited < ROUTE_VISITED) {
      const node = pop();
      if (closed[node]) continue;
      closed[node] = 1;
      visited++;
      if (node === goal) {
        const path = [];
        for (let at = goal; at >= 0; at = came[at]) path.push(at);
        path.reverse();
        return path;
      }
      for (let k = graph.offsets[node]; k < graph.offsets[node + 1]; k++) {
        const next = graph.neighbours[k];
        if (closed[next]) continue;
        const step = Math.hypot(graph.x[next] - graph.x[node], graph.z[next] - graph.z[node]) +
          Math.min(Math.abs(graph.y[next] - graph.y[node]), 200) * .25;
        const value = score[node] + step;
        if (value < score[next]) { score[next] = value; came[next] = node; push(next, value + h(next)); }
      }
    }
    return null;
  },
  pose(x, z, y) {
    const rx = Math.floor(x / SECTOR), rz = Math.floor(z / SECTOR);
    if (rx < 0 || rx > 255 || rz < 0 || rz > 127) return null;
    return { regionId: (rz << 8) | rx, x: x - rx * SECTOR, y, z: z - rz * SECTOR };
  },
  thin(graph, path, y) {
    const points = [], length = { value: 0 };
    let last = 0;
    const add = position => {
      const index = path[position];
      const point = this.pose(graph.x[index], graph.z[index], y);
      if (point) points.push(point);
      last = position;
    };
    if (path.length) add(0);
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[last], b = path[i], c = path[i + 1];
      const straight = Math.hypot(graph.x[c] - graph.x[a], graph.z[c] - graph.z[a]);
      const turn = Math.abs(Math.atan2(graph.z[c] - graph.z[b], graph.x[c] - graph.x[b]) -
        Math.atan2(graph.z[b] - graph.z[a], graph.x[b] - graph.x[a]));
      if (straight >= ROUTE_SPACING && (straight >= ROUTE_SEGMENT || turn > .35)) add(i);
    }
    if (path.length > 1) add(path.length - 1);
    for (let i = 1; i < points.length; i++) length.value += dist2D(points[i - 1], points[i]);
    return { points, length: length.value };
  },
  // null means "use the leg fallback"; it is not an error.
  plan(from, to) {
    this.message = '';
    if (!from || !to || ((from.regionId | to.regionId) & DUNGEON)) return null;
    const a = this.commonArea(from, to);
    if (!a) { this.message = 'No route data covers both the character and the hunting spot.'; return null; }
    const first = this.cache.get(a.name);
    if (!first) return null;
    const graph = this.graph(first);
    const here = this.absolute(from), there = this.absolute(to);
    const start = this.nearest(graph, here.x, here.z), end = this.nearest(graph, there.x, there.z);
    if (!start || !end) { this.message = 'No route node near the character or the hunting spot.'; return null; }
    if (start.node === end.node) return null;
    const path = this.astar(graph, start.node, end.node);
    if (!path) { this.message = 'No walkable path in the route data.'; return null; }
    const thinned = this.thin(graph, path, from.y);
    if (!thinned.points.length) return null;
    return { source: 'navdata', area: a.name, points: thinned.points, length: thinned.length,
      nodes: path.length, snap: Math.max(start.distance, end.distance) };
  },
};


// Independent return command using the saved hunt centre and native movement.
// A long trip first tries the converted route graph (lean-route.js), which
// chooses the corridor across the whole map. Every step is still walked with
// Navigation over the game's own collision window. Without a route the trip is
// walked in short legs: the game publishes collision data only for the 3x3
// regions around the character, so each leg ends across the next region border.
const WALK_LEG = 2400;           // game units; safely inside the 3x3 collision window
const WALK_MAX_LEGS = 60;        // hard safety cap on chained legs for one return
const WALK_MAX_MS = 30 * 60000;  // hard safety cap for the leg fallback
const WALK_NAV_MS = 90 * 60000;  // absolute cap for a navdata route
const WALK_PLAN_MS = 6000;       // wait this long for route data before falling back

const WalkBack = {
  active: null,
  start(resume = false) {
    if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before travelling.', 'warn');
    if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before travelling.', 'warn');
    if (Town.trip) return UI.toast('Stop the town cycle before starting walk-back.', 'warn');
    if (!World.inWorld() || World.isDead()) return UI.toast('Enter the world with a living character first.', 'warn');
    const dest = Settings.profile.hunt.center, pose = World.pose();
    if (!dest || !pose) return UI.toast('Save a hunting spot first using Set here in Hunt → Area.', 'warn');
    if (!Number.isFinite(dist2D(pose, dest))) return UI.toast('Return to the same world or dungeon before walking back.', 'warn');
    if (World.gp?.inventoryPending) return UI.toast('Wait for the inventory transaction to finish.', 'warn');
    Resurrect.cancelTrip('', true); Resurrect.holdUntil = 0;
    const shouldResume = resume || Hunt.running || !!this.active?.resume;
    this.cancel();
    Restock.cancelRecording();
    Restock.trip = null;
    if (Hunt.running) Hunt.stop();
    if (Restock.activeShop() || World.gp?.storage) Cmd.raw({ kind: 'npc-close' }, 'Walk back: close merchant');
    const recorded = Restock.cfg().route;
    let route = [], nearest = -1, best = 500;
    if (recorded.length && dist2D(recorded[recorded.length - 1], dest) <= 500) {
      recorded.forEach((p, i) => { const d = dist2D(pose, p); if (d <= best) { nearest = i; best = d; } });
      if (nearest >= 0) route = recorded.slice(nearest).map(p => ({ ...p }));
    }
    route.push({ ...dest });
    // The direct distance is a lower bound; a recorded route can be longer.
    let distance = 0, previous = pose;
    for (const point of route) { const leg = dist2D(previous, point); distance += Number.isFinite(leg) ? leg : 0; previous = point; }
    distance = Math.max(distance, dist2D(pose, dest) || 0);
    this.active = { destination: { ...dest }, legRoute: route, legRecorded: route.length > 1, distance,
      route: null, recorded: false, source: '', index: 0, resume: shouldResume, totalLegs: Math.max(1, Math.ceil(distance / WALK_LEG)),
      legs: 0, leg: null, legTries: 0, navReplans: 0, routeArea: '', routeLength: 0,
      manualAt: Manual.lastAt, at: now(), progressAt: now(), lastPose: { ...pose }, sentAt: -Infinity, replans: 0, retryAt: 0,
      best: distance, bestAt: now(), maxMs: WALK_MAX_MS, plan: null };
    UI.toast('Walking back to the hunting spot.', 'info', 2500);
    // The route graph is only worth a loading wait where the leg fallback would
    // have to chain (more than one leg), and only outdoors in one route area.
    const routeArea = typeof Route !== 'undefined' ? Route.commonArea(pose, dest) : null;
    const navWorth = distance > WALK_LEG && !!routeArea &&
      !(pose.regionId & DUNGEON) && !(dest.regionId & DUNGEON);
    if (!navWorth) return this.useLegs();
    let planned = null;
    try { planned = Route.plan(pose, dest); } catch { planned = null; }
    if (planned) return this.useNav(planned, pose);
    const a = this.active, token = {};
    a.plan = { at: now(), token };
    a.source = 'planning';
    Log.info('Route: loading navdata for ' + routeArea.name + '.');
    Route.ensure(pose, dest).then(ok => {
      if (this.active !== a || a.plan?.token !== token) return;
      let next = null;
      try { next = ok ? Route.plan(World.pose(), dest) : null; } catch { next = null; }
      if (next) this.useNav(next, World.pose());
      else this.useLegs();
    }, () => {
      if (this.active === a && a.plan?.token === token) this.useLegs();
    });
  },
  cancel(reason = '', halt = true) {
    if (!this.active) return;
    this.active = null;
    if (halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    if (reason) UI.toast(reason, 'warn', 4000);
  },
  // Navdata corridor: its waypoints are short steps for the local collision A*.
  useNav(route, pose) {
    const a = this.active;
    if (!a || !route?.points?.length) return false;
    a.route = [...route.points.map(p => ({ ...p })), { ...a.destination }];
    a.recorded = false;
    a.source = 'navdata';
    a.routeArea = route.area;
    a.routeLength = route.length + (dist2D(route.points[route.points.length - 1], a.destination) || 0);
    a.index = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    a.maxMs = Math.max(WALK_MAX_MS, Math.min(WALK_NAV_MS, a.routeLength / 20 * 1000 * 2));
    a.plan = null;
    Log.info('Route: using navdata (' + route.area + ') with ' + route.points.length + ' waypoints.');
    return true;
  },
  // Leg fallback, including the recorded merchant route and the distance caps.
  useLegs() {
    const a = this.active;
    if (!a || a.source === 'legs') return false;
    const pose = World.pose();
    if (a.distance > WALK_LEG * WALK_MAX_LEGS) {
      this.cancel('The hunting spot is ' + Math.round(a.distance / 10) + ' m away; that is too far to walk safely. Move closer or use a return scroll.');
      return false;
    }
    a.route = a.legRoute; a.recorded = a.legRecorded; a.source = 'legs';
    a.index = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.totalLegs = Math.max(1, Math.ceil(a.distance / WALK_LEG)); a.legs = 0;
    a.maxMs = WALK_MAX_MS; a.plan = null;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    Log.info('Route: no navdata route' + (Route?.message ? ' (' + Route.message + ')' : '') + '; walking in legs.');
    return true;
  },
  // A navdata route that stops making progress is re-planned once or twice from
  // where the character stands, then handed to the leg fallback.
  replan(pose) {
    const a = this.active;
    if (!a || a.source !== 'navdata' || a.navReplans >= 2) return false;
    a.navReplans++;
    let route = null;
    try { route = Route.plan(pose, a.destination); } catch { return false; }
    if (!route?.points?.length) return false;
    a.route = [...route.points.map(p => ({ ...p })), { ...a.destination }];
    a.index = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    Log.info('Route: re-planned from the current position with ' + route.points.length + ' waypoints.');
    return true;
  },
  // Plain progress for the status strip, the compact status line and diagnostics.
  status() {
    const a = this.active;
    if (!a) return '';
    if (a.source === 'planning') return 'Walking to the hunting spot: loading route data.';
    const left = dist2D(World.pose(), a.destination);
    const progress = Number.isFinite(left) && a.distance ? ' · ' + Math.round(left / 10) + ' m left' : '';
    if (a.source === 'navdata') {
      const at = Math.min(a.route.length, a.index + 1);
      return 'Walking to the hunting spot: waypoint ' + at + '/' + a.route.length + progress + '.';
    }
    const leg = Number.isFinite(left) ? Math.max(1, Math.min(a.totalLegs, a.totalLegs - Math.ceil(left / WALK_LEG) + 1)) : 1;
    return (a.totalLegs > 1 ? 'Walking to the hunting spot: leg ' + leg + '/' + a.totalLegs : 'Walking to the hunting spot') + progress + '.';
  },
  // The straight leg end is unreachable. Try a snapped or slightly turned end of
  // the same rough length, rate-limited so a missing collision window can arrive.
  detour(pose, dest) {
    const a = this.active;
    if (!a?.leg) return false;
    if (now() < a.retryAt) return true;
    a.legTries++;
    const target = Navigation.detour(pose, dest, WALK_LEG, { radius: Math.min(480, 120 * a.legTries) });
    if (!target) { a.retryAt = now() + 3000; return true; }
    a.leg = { target, from: { ...pose }, revision: Navigation.revision };
    a.travel = null; a.sentAt = -Infinity;
    Log.info('Walk back: this leg is blocked; trying a nearby route.');
    return true;
  },
  tick() {
    const a = this.active;
    if (!a) return;
    if (!World.inWorld() || World.isDead()) return this.cancel('Walk back interrupted.', false);
    if (Manual.lastAt !== a.manualAt) return this.cancel('Manual control: walk back cancelled.', false);
    if (a.source === 'planning') {
      if (now() - a.plan.at <= WALK_PLAN_MS) return;
      if (!this.useLegs()) return;
    }
    if (!a.route?.length) return;
    const pose = World.pose(), dest = a.route[a.index], distance = dist2D(pose, dest);
    if (!Number.isFinite(distance)) return this.cancel('Cannot walk to the saved hunting spot.');
    if (distance <= 12) {
      a.index++; a.leg = null; a.legTries = 0; a.progressAt = now(); a.lastPose = { ...pose }; a.travel = null;
      if (a.index < a.route.length) return;
      this.active = null;
      UI.toast('Back at the hunting spot.', 'info', 2500);
      if (a.resume) Hunt.start();
      return;
    }
    if (dist2D(a.lastPose, pose) > 3) { a.lastPose = { ...pose }; a.progressAt = now(); a.replans = 0; }
    if (now() - a.progressAt > 20000) {
      if (a.source === 'navdata' && this.replan(pose)) return;
      if (a.source === 'navdata' && this.useLegs()) return;
      return this.cancel(a.legTries ? 'Walk back stopped: no walkable route to the hunting spot.' : 'Walk back stopped: path blocked or travel timed out.');
    }
    if (now() - a.at > a.maxMs) return this.cancel('Walk back stopped: the trip took longer than ' + Math.round(a.maxMs / 60000) + ' minutes.');
    // A detour may walk away from the goal, so also check real progress towards it.
    const left = dist2D(pose, a.destination);
    if (!Number.isFinite(a.best) || left < a.best - 20) { a.best = left; a.bestAt = now(); }
    if (now() - a.bestAt > 300000) return this.cancel('Walk back stopped: no progress towards the hunting spot.');
    if (now() < a.retryAt) return;
    if (now() - a.progressAt > 6000 && a.travel && a.replans < 2) { a.travel = null; a.replans++; a.sentAt = -Infinity; }
    // A newly published window invalidates the leg target; the next leg starts
    // from the position reached, using the new coverage.
    if (a.leg && a.leg.revision !== Navigation.revision) { a.leg = null; a.legTries = 0; a.travel = null; }
    if (a.leg && dist2D(pose, a.leg.target) <= 12) { a.leg = null; a.legTries = 0; a.travel = null; }
    if (a.source === 'legs' && !a.leg && distance > WALK_LEG) {
      if (a.legs >= WALK_MAX_LEGS) return this.cancel('Walk back stopped: the hunting spot needs too many separate legs.');
      const target = Navigation.legPoint(pose, dest, WALK_LEG);
      if (target) {
        a.leg = { target, from: { ...pose }, revision: Navigation.revision };
        a.legs++; a.legTries = 0;
        Log.info('Walk back: leg ' + a.legs + ' of about ' + a.totalLegs + '.');
        Activity.emit({ category: 'movement', code: 'walk-leg', text: 'Walk back leg ' + a.legs + ' of about ' + a.totalLegs + '.', details: { leg: a.legs, legs: a.totalLegs } });
      }
    }
    const move = Navigation.next(a, a.leg ? a.leg.target : dest, a.recorded);
    if (move.error && !move.waiting) {
      if (a.source === 'navdata') {
        if (this.replan(pose)) return;
        if (this.useLegs()) return;
      }
      if (this.detour(pose, dest)) return;
      return this.cancel(move.error);
    }
    if (move.waiting) {
      // The leg can end early at the edge of the loaded window, before the
      // crossing that publishes the next one. Keep the progress made.
      if (!move.error && a.leg && dist2D(a.leg.from, pose) >= 100) {
        a.leg = null; a.legTries = 0; a.travel = null; a.progressAt = now(); a.retryAt = now() + 1000;
        return;
      }
      if (move.error && a.navMessage !== move.error) { a.navMessage = move.error; UI.toast(move.error, 'warn'); }
      if (a.source === 'navdata' && !move.error && dist2D(pose, dest) > 12) {
        if (this.replan(pose)) return;
        if (this.useLegs()) { a.progressAt = now(); return; }
      }
      a.retryAt = now() + 1500;
      return;
    }
    if (World.isSitting()) {
      if (now() - a.sentAt >= 2500 && Cmd.action(1000)) a.sentAt = now();
    } else if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
  },
};


// One pickup intent at a time. Progress, inventory changes and failures own its lifetime.
const Loot = {
  active: null,
  skips: new Map(),
  failureCounts: new Map(),
  petSetup: null,
  fullAlert: null,
  lastFullChimeAt: -Infinity,
  checkPetFull() {
    const P = Hunt.cfg().pickup;
    if (!Hunt.running || !World.inWorld() || World.isDead() || !P.enabled || !this.petMode() || !P.petFullSound) return;
    const pet = this.pet();
    if (!pet || pet.rec.inventory.length < pet.rec.status) { this.fullAlert = null; return; }
    let alert = this.fullAlert;
    if (!alert || alert.gid !== pet.rec.gid) {
      alert = this.fullAlert = { gid: pet.rec.gid, sounded: false };
      UI.toast('Pickup pet bag is full. ' + (Town.cfg().enabled ? 'Town service will take priority over hunting.' : 'Scroll town cycle is off; enable it in Supplies for automatic return.'), 'warn', 6000);
    }
    if (!alert.sounded && now() - this.lastFullChimeAt >= 30000) {
      this.lastFullChimeAt = now();
      alert.sounded = Sound.play('pet-full');
    }
  },
  pet() {
    for (const rec of World.gp?.cosRecords || []) {
      const ent = World.ents.get(rec.gid);
      if (rec.band === 4 && !rec.dead && rec.hp > 0 && rec.status > 0 && Array.isArray(rec.inventory) &&
          ent?.kind === 'cos' && ent.ownerGid === World.localGid() && ent.refObjId === rec.refObjId) return { rec, ent };
    }
    return null;
  },
  // Who collects a kind of drop: its own choice (pickup.by), else the default collector. A pet is in use when it is the
  // default or when any wanted kind is given to it; the character can collect other kinds meanwhile.
  collectorFor(category) { const P = Hunt.cfg().pickup, by = P.by?.[category]; return by === 'pet' || by === 'character' ? by : P.collector === 'pet' ? 'pet' : 'character'; },
  collector(e) { return this.collectorFor(this.category(e.groundItem?.typeFlags ?? e.tidWord ?? 0)); },
  petMode() { const P = Hunt.cfg().pickup; return P.collector === 'pet' || this.categories.some(k => P[k] && P.by?.[k] === 'pet'); },
  preparePet() {
    if (!this.petMode() || !Hunt.cfg().pickup.enabled || World.isDead()) return false;
    const pet = this.pet();
    if (!pet || !Number.isInteger(pet.rec.commandMode)) return false;
    if (!(pet.rec.commandMode & 128)) { this.petSetup = null; return true; }
    // Native auto-grab has only gold/equipment/other categories. Disable it and
    // wait for the live server-confirmed mode before submitting selective requests.
    let setup = this.petSetup;
    if (!setup || setup.gid !== pet.rec.gid) setup = this.petSetup = { gid: pet.rec.gid, attempts: 0, at: -Infinity };
    if (setup.attempts < 3 && now() - setup.at >= 5000 && !World.gp.inventoryPending && Cmd.spaced('cos-behavior') &&
        Cmd.raw({ kind: 'cos-behavior', gid: pet.rec.gid, mode: (pet.rec.commandMode & ~128) >>> 0 }, 'Disable broad pet auto-grab')) {
      setup.attempts++; setup.at = now();
    }
    return false;
  },
  petStatus() {
    const pet = this.pet();
    if (!pet) return 'Summon a pickup pet to collect into its bag.';
    if (!Number.isInteger(pet.rec.commandMode)) return 'Waiting for pet settings.';
    if (pet.rec.commandMode & 128) return this.petSetup?.attempts >= 3 && now() - this.petSetup.at >= 5000
      ? 'Auto-grab was not disabled. Turn it off in the game pet settings, then retry.' : 'Waiting for broad auto-grab to turn off.';
    if (Hunt.running && World.gp.inventoryPending) return 'Pet waiting for pickup / inventory transaction to finish.';
    if (Hunt.running && this.pressed()) return 'Pet waiting briefly for potion use.';
    if (this.active?.petGid === pet.rec.gid) return 'Pet collecting: ' + (this.active.name || this.active.gid) + (this.active.retryAt ? ' (retry pending).' : '.');
    return `Pet ready: ${Math.max(0, pet.rec.status - pet.rec.inventory.length)} empty slots. Collects while hunting; auto-grab stays off when stopped.`;
  },
  items(petGid = 0) { return petGid ? World.gp?.cosRecords?.find(r => r.gid === petGid)?.inventory || [] : World.items(); },
  pickup(gid, petGid = 0) {
    return petGid ? Cmd.spaced('cos-pickup') && Cmd.raw({ kind: 'cos-pickup', gid: petGid, target: gid }, 'Pet pickup') : Cmd.pickup(gid);
  },
  pressed() {
    // Controller runs potions first. Reserve only a short window after an
    // actual send, including the gap before inventoryPending reaches our mirror.
    // A threshold margin can otherwise block the pet indefinitely.
    return Potion.lastUse > 0 && now() - Potion.lastUse < 350;
  },
  categories: ['gold', 'potions', 'equipment', 'elixirs', 'powders', 'magicStones', 'attrStones', 'alchemy', 'others'],
  category(tf) {
    if (ItemType.isGold(tf)) return 'gold';
    if (ItemType.isPotion(tf) || ItemType.isCure(tf)) return 'potions';
    if (ItemType.isEquipment(tf)) return 'equipment';
    // Native alchemy item words: (TID1,TID2,TID3,TID4), also used by reinforce.go.
    const consumable = (tf & 126) === 108, t3 = (tf >>> 7) & 15, t4 = (tf >>> 11) & 31;
    if (consumable && t3 === 10 && t4 === 1) return 'elixirs';
    if (consumable && t3 === 10 && t4 === 2) return 'powders';
    // Magic stones also cover the Astral, Luck, Steady and Immortal stones; tablets stay under other alchemy items.
    if (consumable && t3 === 11 && (t4 === 1 || t4 === 7)) return 'magicStones';
    if (consumable && t3 === 11 && t4 === 2) return 'attrStones';
    if (consumable && (t3 === 10 || t3 === 11)) return 'alchemy';
    return 'others';
  },
  preset(mode) {
    const p = Hunt.cfg().pickup;
    for (const key of this.categories) p[key] = mode === 'all' || key === 'elixirs' || (mode === 'elixirs-gold' && key === 'gold');
    p.enabled = true; p.include = '';
    Settings.saveProfile();
  },
  count(ref, petGid = 0) { return this.items(petGid).filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  bagSignature(e) { const pet = (e ? this.collector(e) === 'pet' : this.petMode()) && this.pet(); return `${pet ? pet.rec.gid : 0}:` + this.items(pet ? pet.rec.gid : 0).map(i => `${i.slot}:${i.refObjId}:${i.quantity ?? 1}`).join('|'); },
  owned(e) {
    const gi = e.groundItem;
    if (!gi) return false;
    const local = World.localGid();
    if (gi.claimantGid !== undefined && gi.claimantGid !== local) return false;
    const party = World.gp?.social?.members || [];
    return gi.ownerJid === undefined || gi.ownerJid === local || party.some(m => m.id === gi.ownerJid);
  },
  soxLoadAt: 0,
  // Unknown until the item catalogue loads, so unconfirmed items are never taken.
  ensureCatalogue() {
    if (Items.data.size || now() < this.soxLoadAt) return;
    this.soxLoadAt = now() + 30000; Items.ready().catch(() => {});
  },
  sox(e) {
    this.ensureCatalogue();
    return Items.data.size ? Items.sox(e.refObjId) : 0;
  },
  allowed(e) {
    if (!e || e.kind !== 'ground-item' || !this.owned(e)) return false;
    const P = Hunt.cfg().pickup, tf = e.groundItem.typeFlags ?? e.tidWord ?? 0;
    const name = (e.name || '').toLowerCase();
    // An item rule decides first: never (or drop) skips it, always skips the category and name filters.
    const rule = ItemRules.get(e.refObjId);
    if (rule && (rule.pick === 'no' || rule.act === 'drop')) return false;
    const gold = ItemType.isGold(tf);
    if (rule?.pick !== 'yes') {
      if (splitList(P.exclude).some(s => name.includes(s))) return false;
      const included = splitList(P.include).some(s => name.includes(s));
      // SoX-only narrows equipment to Star/Moon/Sun gear; every other category keeps its own switch.
      if (P.soxOnly && ItemType.isEquipment(tf)) { if (!this.sox(e)) return false; }
      else if (!included && !P[this.category(tf)]) return false;
    }
    const byPet = this.collector(e) === 'pet', pet = byPet ? this.pet() : null;
    if (byPet && (!pet || !Number.isInteger(pet.rec.commandMode) || (pet.rec.commandMode & 128) || dist2D(pet.ent, e) > 500)) return false;
    if (gold || (pet ? pet.rec.status > pet.rec.inventory.length : World.freeBagSlots() > 0)) return true;
    // Ground drops omit quantity/stack ceiling. Permit an existing stack to merge;
    // a server capacity refusal suppresses this drop until inventory changes.
    if (!ItemType.isStackable(tf)) return false;
    return this.items(pet ? pet.rec.gid : 0).some(i => i.refObjId === e.refObjId &&
      (!i.tooltip?.fields?.maxStack || (i.quantity ?? 1) < i.tooltip.fields.maxStack));
  },
  // The first reason a drop in view is not collected, or '' when it is eligible. Follows choose() and allowed().
  whyNot(e) {
    const H = Hunt.cfg(), P = H.pickup, skip = this.skips.get(e.gid);
    if (skip && (skip.bag !== null ? skip.bag === this.bagSignature(e) : skip.until > now())) return 'failed';
    if (!(dist2D(World.pose(), e) <= P.radius)) return 'far';
    if (H.center && dist2D(H.center, e) > H.radius + P.radius) return 'area';
    if (!this.owned(e)) return 'owner';
    const tf = e.groundItem.typeFlags ?? e.tidWord ?? 0, name = (e.name || '').toLowerCase(), rule = ItemRules.get(e.refObjId);
    if (rule && (rule.pick === 'no' || rule.act === 'drop')) return 'rule';
    const included = splitList(P.include).some(s => name.includes(s));
    const filtered = rule?.pick !== 'yes' && (splitList(P.exclude).some(s => name.includes(s)) ||
      (P.soxOnly && ItemType.isEquipment(tf) ? !this.sox(e) : !included && !P[this.category(tf)]));
    if (filtered) return 'filter';
    if (this.collector(e) === 'pet') {
      const pet = this.pet();
      if (!pet || !Number.isInteger(pet.rec.commandMode) || (pet.rec.commandMode & 128)) return 'pet';
      if (dist2D(pet.ent, e) > 500) return 'petFar';
    }
    return this.allowed(e) ? '' : 'full';
  },
  // Which switch kept a drop out, for the status line: 'name' (excluded name), 'sox' (SoX only) or its item kind.
  filterWhy(e) {
    const P = Hunt.cfg().pickup, tf = e.groundItem.typeFlags ?? e.tidWord ?? 0, name = (e.name || '').toLowerCase();
    if (splitList(P.exclude).some(s => name.includes(s))) return 'name';
    return P.soxOnly && ItemType.isEquipment(tf) ? 'sox' : this.category(tf);
  },
  filterLabel(key) {
    return { name: 'excluded by name', sox: 'not Star/Moon/Sun gear (SoX only)', gold: 'gold', potions: 'potions', equipment: 'equipment', elixirs: 'elixirs',
      powders: 'lucky powders', magicStones: 'magic stones', attrStones: 'attribute stones', alchemy: 'other alchemy items', others: 'other items' }[key] || key;
  },
  skip(e, reason, inventoryBound = false) {
    const n = Math.min(6, (this.failureCounts.get(e.gid) || 0) + 1);
    this.failureCounts.set(e.gid, n);
    this.skips.set(e.gid, { until: now() + Math.min(60000, 5000 * 2 ** (n - 1)), bag: inventoryBound ? this.bagSignature(e) : null });
    Log.warn(`Loot skipped (${e.name || e.gid}): ${reason}`);
    this.active = null;
    Hunt.lootGid = 0;
  },
  // The nearest drop worth taking; `by` ('pet' or 'character') limits it to that collector's drops.
  choose(by = null) {
    const H = Hunt.cfg(), P = H.pickup, pose = World.pose();
    if (!P.enabled || !pose) return null;
    let chosen = null, best = Infinity;
    for (const e of World.ents.values()) {
      if (e.kind !== 'ground-item') continue;
      const skip = this.skips.get(e.gid);
      if (skip) {
        if (skip.bag !== null ? skip.bag === this.bagSignature(e) : skip.until > now()) continue;
        this.skips.delete(e.gid);
      }
      const d = dist2D(pose, e);
      if (!Number.isFinite(d) || d > P.radius || H.center && dist2D(H.center, e) > H.radius + P.radius || !this.allowed(e)) continue;
      const who = this.collector(e);
      if (by && who !== by) continue;
      const travel = dist2D(who === 'pet' ? this.pet()?.ent : pose, e);
      if (travel < best) { chosen = e; best = travel; }
    }
    return chosen;
  },
  begin(e) {
    const byPet = this.collector(e) === 'pet';
    if (!this.allowed(e) || World.gp?.inventoryPending || !byPet && World.isCasting()) return false;
    const petGid = byPet ? this.pet()?.rec.gid : 0;
    if (byPet && (!petGid || this.pressed()) || !this.pickup(e.gid, petGid)) return false;
    const gold = ItemType.isGold(e.groundItem.typeFlags);
    this.active = { gid: e.gid, ref: e.refObjId, name: e.name, gold, petGid,
      before: gold ? toBigInt(World.gp?.progression?.gold) : this.count(e.refObjId, petGid),
      at: now(), progressAt: now(), best: dist2D(petGid ? this.pet().ent : World.pose(), e), attempts: 1,
      retryAt: 0, goneAt: null, failure: '' };
    Hunt.lootGid = e.gid;
    return true;
  },
  gained(a) {
    return a.gold ? toBigInt(World.gp?.progression?.gold) > a.before : this.count(a.ref, a.petGid) > a.before;
  },
  tick() {
    const a = this.active;
    if (!a) return false;
    const e = World.ents.get(a.gid);
    if (!!a.petGid !== (e ? this.collector(e) === 'pet' : !!a.petGid) || a.petGid && this.pet()?.rec.gid !== a.petGid) { this.suspend(); return false; }
    if (!a.petGid) Hunt.state = 'loot';
    if (this.gained(a)) {
      Stats.pickup(a);
      // If inventory updates precede despawn, don't request this same drop again.
      this.skips.set(a.gid, { until: now() + 3000, bag: null });
      this.failureCounts.delete(a.gid);
      this.active = null; Hunt.lootGid = 0;
      return true;
    }
    if (!e) {
      a.goneAt ??= now();
      if (now() - a.goneAt < 1500) return true; // allow a delayed inventory/gold update
      Log.info(`Drop disappeared without a matching inventory gain: ${a.name || a.gid}`);
      this.active = null; Hunt.lootGid = 0;
      return false;
    }
    if (!this.allowed(e) || !Hunt.cfg().pickup.enabled) {
      if (!a.petGid && !Cmd.move(World.pose())) return true;
      this.suspend(); return false;
    }
    const d = dist2D(a.petGid ? this.pet().ent : World.pose(), e);
    if (d < a.best - 2) { a.best = d; a.progressAt = now(); }
    if (World.gp?.inventoryPending) return true;
    if (a.retryAt) {
      if (now() < a.retryAt) return true;
      if (a.petGid && this.pressed()) return true;
      if (this.pickup(a.gid, a.petGid)) {
        a.attempts++; a.retryAt = 0; a.at = now(); a.progressAt = now(); a.best = d; a.failure = '';
      }
      return true;
    }
    // Keep the approach alive while moving; don't expire it after a fixed 4.5 seconds.
    if (!a.failure && now() - a.progressAt < 8000 && now() - a.at < 45000) return true;
    const reason = a.failure || 'no approach/pickup progress';
    const capacity = /full|capacity|(?:not enough|no|out of) (?:free |inventory |bag )?space|envanter.*dolu/i.test(reason);
    if (capacity || a.attempts > Hunt.cfg().pickup.retries) { this.skip(e, reason, capacity); return false; }
    // Movement cancels the outstanding worker pickup intent. Resubmit on a later tick.
    if (a.petGid || Cmd.move(World.pose())) { a.retryAt = now() + 700; a.failure = ''; }
    return true;
  },
  suspend() { this.active = null; Hunt.lootGid = 0; },
  reset() { this.suspend(); this.skips.clear(); this.failureCounts.clear(); this.petSetup = null; this.fullAlert = null; },
  init() {
    bus.on('game-error', message => {
      if (!this.active) return;
      const reason = String(message);
      // The shared error field also contains combat and item-use failures.
      // Only native COS-ground/transaction refusals can fail a pet request;
      // generic inventory refusals are transient, never proof its bag is full.
      if (this.active.petGid && !/^(?:Inventory (?:command unavailable|rejected: \d+)|No owned COS ground authority|Invalid COS ground request|Unmatched COS ground result)$/.test(reason)) return;
      this.active.failure = reason;
    });
    bus.on('despawn', e => {
      this.skips.delete(e.gid); this.failureCounts.delete(e.gid);
    });
  },
};


// Page-local hunting session. No persistence, uploads or gameplay commands.
const Stats = {
  values: { loot: 0, casts: 0, potions: 0, deaths: 0 },
  session: { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0 },
  active: false, lastAt: null, baseline: null, dead: false, character: null, started: false,
  levels: null, loading: null, retryAt: 0, pendingXP: [], xpPartial: false, xpKnown: false, goldKnown: false,
  killed: new Set(), potions: [], potionTotals: new Map(), fields: {},
  integer(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
    if (!['string', 'number', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) return null;
    try { return BigInt(value); } catch { return null; }
  },
  init() {
    if (this.started) return;
    this.started = true;
    bus.on('gameplay', () => this.sample());
    bus.on('cast', c => this.cast(c));
    bus.on('spawn', e => this.killed.delete(e.gid));
    bus.on('death', e => { if (e.gid === World.localGid()) this.sample(); });
    bus.on('phase', () => this.sample());
    bus.on('reset', () => { this.sample(); this.baseline = null; this.killed.clear(); this.potions = []; this.potionTotals.clear(); });
    bus.on('character', name => {
      if (this.character !== name) { this.character = name; this.killed.clear(); this.reset(); }
    });
  },
  reset() {
    this.values = { loot: 0, casts: 0, potions: 0, deaths: 0 };
    this.session = { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0 };
    this.lastAt = now(); this.active = false; this.baseline = null;
    this.dead = World.isDead(); this.pendingXP = []; this.xpPartial = this.xpKnown = this.goldKnown = false;
    this.potions = []; this.potionTotals.clear();
    this.sample(); this.render();
  },
  huntStart() { this.sample(); this.loadLevels(); if (Hunt.cfg().pickup.soxSound) Loot.ensureCatalogue(); },
  huntStop() { this.sample(); },
  count(kind) {
    if (kind in this.values) this.values[kind]++;
  },
  pickup(a) {
    this.count('loot');
    if (Hunt.running && World.inWorld() && !a.gold) this.session.items += Math.max(0, Loot.count(a.ref, a.petGid) - a.before);
    const tier = a.gold || !Hunt.running || !World.inWorld() ? 0 : Items.sox(a.ref);
    if (tier) this.soxFound(a, tier);
  },
  // A confirmed bot pickup of Star/Moon/Sun gear. Unknown items (catalogue not loaded) are not announced.
  soxFound(a, tier) {
    this.session.sox++;
    const name = a.name || Items.name(a.ref), label = ['Star', 'Moon', 'Sun'][tier - 1];
    if (!Hunt.cfg().pickup.soxSound) return;
    UI.toast('SoX found: ' + name + ' (' + label + ')', 'info', 10000);
    Sound.play('sox');
  },
  potion(item) {
    this.count('potions'); this.sample();
    if (!this.active) return;
    if (!this.potionTotals.has(item.refObjId)) this.potionTotals.set(item.refObjId, this.total(item.refObjId));
    this.potions.push({ ref: item.refObjId, at: now() });
    if (this.potions.length > 32) this.potions.shift();
  },
  total(ref) { return (World.gp?.inventory || []).filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  confirmPotions() {
    if (!Array.isArray(World.gp?.inventory)) return;
    this.potions = this.potions.filter(p => now() - p.at <= 15000);
    for (const [ref, before] of this.potionTotals) {
      const current = this.total(ref);
      let consumed = Math.max(0, before - current);
      this.potions = this.potions.filter(p => {
        if (p.ref !== ref || consumed <= 0) return true;
        consumed--; this.session.potions++; return false;
      });
      if (this.potions.some(p => p.ref === ref)) this.potionTotals.set(ref, current);
      else this.potionTotals.delete(ref);
    }
  },
  cast(c) {
    if (!Hunt.running || !World.inWorld()) return;
    const caster = World.ents.get(c.caster);
    if (c.caster !== World.localGid() && !(caster?.kind === 'cos' && caster.ownerGid === World.localGid())) return;
    const targets = (c.results || []).filter(r => (r.impacts || []).some(i => i.fatal)).map(r => r.target);
    if (!(c.results || []).length && c.fatal) targets.push(c.target);
    for (const gid of targets) {
      if (World.ents.get(gid)?.kind !== 'monster' || this.killed.has(gid)) continue;
      this.killed.add(gid); this.session.kills++;
      if (this.killed.size > 1000) this.killed.delete(this.killed.values().next().value);
    }
  },
  xpDelta(a, b) {
    if (a.level === b.level) return b.xp > a.xp ? b.xp - a.xp : 0n;
    if (b.level < a.level) return 0n;
    if (!this.levels) return null;
    let total = b.xp - a.xp;
    for (let level = a.level; level < b.level; level++) {
      const required = this.integer(this.levels[level]?.expRequired);
      if (required === null || required <= 0n) return null;
      total += required;
    }
    return total > 0n ? total : 0n;
  },
  async loadLevels() {
    if (this.levels || this.loading || now() < this.retryAt || !W.location?.origin) return;
    this.retryAt = now() + 30000;
    this.loading = Icons.request('/assets/data/levelData.json', 'json').then(levels => {
      if (!levels || typeof levels !== 'object') throw Error('Invalid level data');
      this.levels = levels;
      for (const [a, b] of this.pendingXP) {
        const delta = this.xpDelta(a, b);
        if (delta === null) this.xpPartial = true; else this.session.xp += delta;
      }
      this.pendingXP = [];
    }).catch(() => {}).finally(() => { this.loading = null; });
    return this.loading;
  },
  sample() {
    const t = now(), live = Hunt.running && World.inWorld();
    if (this.lastAt !== null && this.active) this.session.ms += Math.max(0, t - this.lastAt);
    this.lastAt = t;
    const p = World.gp?.progression, level = p?.level;
    const current = { gid: World.localGid(), epoch: World.epoch, level, xp: this.integer(p?.experience), gold: this.integer(p?.gold) };
    const previous = this.baseline;
    if (this.active && live && previous && current.gid === previous.gid && current.epoch === previous.epoch) {
      if (previous.gold !== null && current.gold !== null) this.session.gold += current.gold - previous.gold;
      if (Number.isInteger(previous.level) && Number.isInteger(level) && previous.xp !== null && current.xp !== null) {
        const delta = this.xpDelta(previous, current);
        if (delta === null) {
          if (this.pendingXP.length < 50) this.pendingXP.push([previous, current]); else this.xpPartial = true;
        } else this.session.xp += delta;
      } else if (this.xpKnown) this.xpPartial = true;
      this.confirmPotions();
    } else { this.potions = []; this.potionTotals.clear(); }
    const dead = World.isDead();
    if (this.active && live && dead && !this.dead) { this.session.deaths++; this.values.deaths++; }
    this.dead = dead;
    this.active = live; this.baseline = live ? current : null;
    if (live) {
      if (current.xp !== null && Number.isInteger(level)) this.xpKnown = true;
      if (current.gold !== null) this.goldKnown = true;
      this.loadLevels();
    }
  },
  number(n) { return n.toLocaleString('en-US'); },
  display() {
    const s = this.session, seconds = Math.floor(s.ms / 1000);
    const time = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
    const partial = this.xpPartial || this.pendingXP.length ? ' (partial)' : '';
    const rate = s.ms >= 30000 ? this.number(s.xp * 3600000n / BigInt(Math.floor(s.ms))) : '—';
    return { state: this.active ? 'Tracking' : 'Paused', time,
      xp: this.xpKnown ? this.number(s.xp) + partial : '—', rate: this.xpKnown ? rate + partial : '—',
      gold: this.goldKnown ? (s.gold > 0n ? '+' : '') + this.number(s.gold) : '—',
      kills: this.number(s.kills), deaths: this.number(s.deaths), potions: this.number(s.potions), items: this.number(s.items), sox: this.number(s.sox) };
  },
  draw(parent) {
    const box = UI.group('Session stats'); this.fields = {};
    for (const [key, label] of [['state','Session'],['time','Hunting time'],['xp','XP gained'],['rate','XP / hour'],['gold','Net gold'],['kills','Confirmed kills'],['deaths','Deaths'],['potions','Potions used'],['items','Items picked up'],['sox','SoX found']]) {
      const value = el('span'); value.setAttribute('aria-label', label); this.fields[key] = value;
      const row = el('div', null, 'field'); row.append(el('span', label), value); box.append(row);
    }
    box.append(UI.button('Reset session', () => this.reset()),
      el('p', 'Local to this page; pauses while hunting is stopped or disconnected. Reset or reload clears totals. Town trips count while hunting stays enabled. Gold includes purchases and repairs. Kills require your or your pet’s fatal result; item counts use confirmed bot pickups; SoX found counts confirmed pickups of Star, Moon and Sun gear. HP, MP, vigor and cure uses require inventory confirmation. XP/hour appears after 30 seconds; partial means a level transition or missing data is unresolved.', 'muted'));
    parent.append(box); this.render();
  },
  render() {
    if (!UI.is('Settings')) return;
    const data = this.display();
    for (const [key, value] of Object.entries(data)) if (this.fields[key]) this.fields[key].textContent = value;
  },
};


// Approve only correlated applications to the local player's matching listing.
const Party = {
  answered: '',
  registration: null,
  lastRegisterAt: -Infinity,
  message: 'Auto-recruit off.',
  joinMessage: '', joinedKey: '', lastPageAt: -Infinity, lastJoinAt: -Infinity, scanDoneAt: -Infinity, wantPage: 1,
  reset() {
    this.answered = ''; this.registration = null; this.lastRegisterAt = -Infinity; this.message = 'Waiting for party state.';
    this.joinMessage = ''; this.joinedKey = ''; this.lastPageAt = this.lastJoinAt = this.scanDoneAt = -Infinity; this.wantPage = 1;
  },
  // Alt accounts: find the main account's party and join it. A party invitation from the main is accepted; otherwise the
  // party-matching board is paged for the main's listing and the bot applies to it (the main's Auto-recruit and
  // Auto-accept answer). Runs only while solo, so it never pulls the character out of another party.
  joinMain() {
    const c = Settings.profile.party, main = String(c.mainName || '').trim().toLowerCase();
    if (!c.joinMain || !main) { this.joinMessage = ''; return; }
    const gp = World.gp, social = gp?.social, matching = gp?.partyMatching, me = String(social?.localName || '').toLowerCase();
    if (!social || !matching || !Array.isArray(social.members)) { this.joinMessage = 'Waiting for party state.'; return; }
    if (me && me === main) { this.joinMessage = 'This is the main account; nothing to join.'; return; }
    const named = m => String(m?.name || '').toLowerCase();
    if (social.members.some(m => named(m) === main)) { this.joinMessage = 'In ' + c.mainName.trim() + "'s party."; this.joinedKey = ''; this.wantPage = 1; return; }
    if (social.members.some(m => m && named(m) !== me)) { this.joinMessage = 'In another party; leave it to join ' + c.mainName.trim() + '.'; return; }
    const inv = social.invitation;
    if (inv && (inv.type === 2 || inv.type === 3) && String(World.ents.get(inv.gid)?.name || '').toLowerCase() === main) {
      const key = inv.type + ':' + inv.gid;
      if (key !== this.joinedKey && Cmd.spaced('social-consent') && Cmd.raw({ kind: 'social-consent', accept: true }, 'Accept party invitation from ' + c.mainName.trim())) this.joinedKey = key;
      this.joinMessage = 'Accepting the invitation from ' + c.mainName.trim() + '.'; return;
    }
    // An application the main never answered (it handles one at a time, so a second alt can be dropped) must not wait
    // forever: after 30 seconds the application is made again.
    const stale = this.lastJoinAt > -Infinity && now() - this.lastJoinAt > 30000;
    if ((matching.pending || matching.joining) && !stale) { this.joinMessage = 'Waiting for the party board…'; return; }
    const level = World.gp?.progression?.level, row = (matching.rows || []).find(r => named(r) === main);
    if (row) {
      const full = row.members >= ((row.type & 1) ? 8 : 4);
      if (full) { this.joinMessage = c.mainName.trim() + "'s party is full."; return; }
      if (Number.isInteger(level) && (level < row.min || level > row.max)) { this.joinMessage = 'Level ' + level + ' is outside ' + c.mainName.trim() + "'s listing (" + row.min + '-' + row.max + ').'; return; }
      if (now() - this.lastJoinAt < 20000 || !Cmd.spaced('party-match-join')) { this.joinMessage = 'Applied to ' + c.mainName.trim() + "'s party; waiting for the answer."; return; }
      if (Cmd.raw({ kind: 'party-match-join', id: row.id }, 'Join ' + c.mainName.trim() + "'s party")) this.lastJoinAt = now();
      this.joinMessage = 'Applying to ' + c.mainName.trim() + "'s party."; return;
    }
    // Not on the page we have: walk the board a page at a time, then rest before scanning again.
    const pages = matching.pages || 0;
    if (this.wantPage > Math.max(pages, 1)) this.wantPage = 1, this.scanDoneAt = now();
    if (now() - this.scanDoneAt < 20000) { this.joinMessage = 'No listing from ' + c.mainName.trim() + ' yet; is Auto-recruit on for that account?'; return; }
    if (now() - this.lastPageAt < 2500 || !Cmd.spaced('party-match-page')) return;
    if (Cmd.raw({ kind: 'party-match-page', page: this.wantPage }, 'Look for ' + c.mainName.trim() + "'s party listing")) { this.lastPageAt = now(); this.wantPage++; }
    this.joinMessage = 'Looking for ' + c.mainName.trim() + "'s party listing…";
  },
  // Party sharing options: the party's own once formed, else the listing's, else the saved new-party choice.
  options(matching, social) {
    const c = Settings.profile.party;
    return social.leader ? social.options : matching.own?.type ?? ((c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0));
  },
  recruit(matching, social) {
    const c = Settings.profile.party;
    if (!c.autoRecruit) { this.message = 'Auto-recruit off.'; return; }
    if (matching.own) {
      this.registration = null;
      this.message = social.leader && social.self !== social.leader ? 'Listing present; only the leader can auto-accept.' : social.members.length >= (((social.leader ? social.options : matching.own.type) & 1) ? 8 : 4) ? 'Party full; waiting for a free slot.' : 'Listing active; accepting applicants when space is available.';
      return;
    }
    if (this.registration) {
      if (now() - this.registration.at < 15000) { this.message = 'Waiting for registration confirmation.'; return; }
      // A local send can be refused before registration starts. Retry only
      // after a newer native snapshot explicitly confirms no listing or request.
      if (World.gp === this.registration.state) { this.message = 'Registration unconfirmed; waiting for fresh party state before retrying.'; return; }
      if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) {
        this.message = 'Waiting for party matching before retrying registration.'; return;
      }
      this.registration = null;
    }
    if (matching.own !== null || matching.pending !== null || matching.request || matching.joining) { this.message = 'Waiting for party matching.'; return; }
    if (social.leader && (!social.self || social.self !== social.leader) || !social.leader && social.members.length) {
      this.message = 'Waiting until you are solo or party leader.'; return;
    }
    const type = social.leader ? social.options : (c.expShare ? 1 : 0) | (c.itemShare ? 2 : 0);
    if (!Number.isInteger(type) || type < 0 || type > 7) { this.message = 'Waiting for party options.'; return; }
    if (social.members.length >= ((type & 1) ? 8 : 4)) { this.message = 'Party full; waiting for a free slot.'; return; }
    if (!social.leader && !(World.gp?.progression?.level >= 5)) { this.message = 'Level 5 is required to form a listing.'; return; }
    const title = String(c.title || '').trim();
    if (!title || title.length > 50 || !Number.isInteger(c.min) || !Number.isInteger(c.max) || c.min < 1 || c.max > 90 || c.min > c.max) {
      this.message = 'Set a title (1-50 characters) and a level range within 1-90.'; return;
    }
    // Match the client party-matching purpose matrix for the equipped job suit.
    const flags = World.gp.inventory?.find(i => i.slot === 8)?.typeFlags ?? 0, suit = flags >>> 11;
    const job = (flags & 0x7fe) === 0x3ac && suit >= 1 && suit <= 3 ? suit : 4;
    const validPurpose = Number.isInteger(c.purpose) && (job === 1 || job === 3 ? c.purpose === 2 : job === 2 ? c.purpose === 3 : c.purpose >= 0 && c.purpose < 2);
    if (!validPurpose) { this.message = 'Listing purpose does not match your equipped job suit.'; return; }
    if (now() - this.lastRegisterAt < 30000 || !Cmd.spaced('party-match-register')) { this.message = 'Waiting before restoring the listing.'; return; }
    const registration = { party: 0, type, purpose: c.purpose, min: c.min, max: c.max, title };
    if (Cmd.raw({ kind: 'party-match-register', registration }, 'Auto-recruit: register party listing')) {
      this.registration = { at: now(), state: World.gp }; this.lastRegisterAt = now();
      this.message = 'Waiting for registration confirmation.';
    }
  },
  // Hunting at the moment of death is remembered, so a resurrection accepted within 15 minutes resumes it whatever the
  // "On death" setting did. A revive the player or the bot does itself never resumes anything.
  huntAtDeath: null, resumeHunt: null, consentAt: -Infinity, aliveSince: 0,
  noteDeath() { if (Hunt.running && !this.huntAtDeath) this.huntAtDeath = { at: now() }; },
  // Another party member who is alive (status & 15 is their health in tenths, 0 when dead) and in view might resurrect us.
  helperNearby() {
    const social = World.gp?.social;
    return !!social?.members?.some(m => m && m.name && m.name !== social.localName && (m.status & 15) !== 0 &&
      [...World.ents.values()].some(e => e.kind === 'player' && e.name === m.name && e.appearanceState?.[0] !== 2));
  },
  helperSeenAt: -Infinity,
  // With Accept resurrection on and a helper at hand, wait longer before the bot revives itself. A helper seen in the
  // last 15 seconds still counts, so a moment out of view or a death far from the party does not cut the wait short.
  helping() {
    if (this.helperNearby()) this.helperSeenAt = now();
    return now() - this.helperSeenAt < 15000;
  },
  reviveDelay() { return Settings.profile.party.acceptRes && this.helping() ? 20000 : 5000; },
  // One plain sentence for the log when the character dies.
  waitNote() {
    if (!Settings.profile.party.acceptRes) return 'reviving in 5 s (Accept resurrection from party members is off).';
    return this.reviveDelay() === 20000 ? 'waiting 20 s for a party member to resurrect before reviving.' : 'no party member in view, reviving in 5 s.';
  },
  // Never revive while an offer is open or an acceptance was just sent.
  resBusy() { return !!World.gp?.social?.resurrection || now() - this.consentAt < 4000; },
  resumeTick() {
    const r = this.resumeHunt;
    if (this.huntAtDeath && now() - this.huntAtDeath.at > 15 * 60000) this.huntAtDeath = null;
    if (!World.inWorld() || World.isDead()) { this.aliveSince = 0; return; }
    if (!this.aliveSince) this.aliveSince = now();
    if (!r) {
      // Alive without an accepted resurrection: the memory belongs to a death that is over.
      if (this.huntAtDeath && now() - this.aliveSince > 10000) this.huntAtDeath = null;
      return;
    }
    if (Hunt.running) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - r.at > 120000) { this.resumeHunt = this.huntAtDeath = null; return; }
    if (now() - this.aliveSince < 2000 || !World.local() || World.gp?.inventoryPending) return;
    this.resumeHunt = this.huntAtDeath = null;
    Controller.resumeHunting('Resurrected');
  },
  // A dead character gets a Yes/No resurrection question from a caster's Rebirth skill. Only party members
  // are answered, and only while dead; other questions (including mutation proposals) are left to the player.
  acceptResurrection() {
    const c = Settings.profile.party, social = World.gp?.social, question = social?.resurrection;
    if (!c.acceptRes || !question || question.mutation || !World.inWorld() || !World.isDead() || !Array.isArray(social.members)) return;
    const caster = World.ents.get(question.gid);
    if (!caster?.name || !social.members.some(m => m?.name === caster.name && m.name !== social.localName)) return;
    if (!Cmd.spaced('resurrection-consent')) return;
    if (Cmd.raw({ kind: 'resurrection-consent', accept: true }, 'Accept resurrection from ' + caster.name)) {
      this.consentAt = now();
      this.resumeHunt = this.huntAtDeath && !Hunt.running && now() - this.huntAtDeath.at < 15 * 60000 ? { at: now() } : null;
      UI.toast('Accepted resurrection from ' + caster.name, 'info', 3000);
    }
  },
  tick() {
    this.acceptResurrection();
    if (World.inWorld() && Settings.profile.party.acceptRes) this.helping();
    const c = Settings.profile.party;
    if (World.inWorld()) this.joinMain(); else this.joinMessage = '';
    if (!World.inWorld() || (!c.autoAcceptMatching && !c.autoRecruit)) return;
    const gp = World.gp, matching = gp?.partyMatching, request = matching?.request, social = gp?.social;
    if (!matching || !social || !Array.isArray(social.members)) return;
    this.recruit(matching, social);
    if (!request) { this.answered = ''; return; }
    if (!social || !Array.isArray(social.members)) return;
    // An owned listing can exist before the first applicant forms the party.
    // The game only routes applications to the listing's owner, and the local listing record can be
    // missing while the server's still exists (it is wiped on world entry and after a party dissolves),
    // so a live application is enough; the leader, capacity and deadline checks below still apply.
    if (social.leader && (!social.self || social.self !== social.leader)) return;
    if (!social.leader && social.members.length) return;
    const options = this.options(matching, social);
    if (!Number.isInteger(options) || social.members.length >= ((options & 1) ? 8 : 4)) return;
    const sim = World.simNow();
    if (!Number.isFinite(sim) || !Number.isFinite(request.expires) || sim >= request.expires) return;
    if (![request.a, request.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return;
    const key = `${request.a}:${request.b}:${request.expires}`;
    if (key === this.answered || !Cmd.spaced('party-match-answer')) return;
    // Same correlation and accept value as the game's matching approval button.
    if (Cmd.raw({ kind: 'party-match-answer', a: request.a, b: request.b, answer: 1 }, 'Auto-accept party-matching application')) {
      this.answered = key;
      UI.toast('Party join acceptance sent: ' + (request.member?.name || 'Applicant'), 'info', 3000);
    }
  },
};
// Hits by party members, and by their pets, do not make a monster "another player's target": hunting together is the
// point of a party, and No-KS would otherwise skip every monster the party is already fighting.
{
  const record = World.onCast;
  World.onCast = function (cast) {
    const social = this.gp?.social, caster = this.ents.get(cast.caster);
    const owner = caster?.kind === 'cos' ? this.ents.get(caster.ownerGid) : caster;
    const name = owner?.name || (caster?.kind === 'cos' ? caster.ownerName : '');
    const member = !!name && Array.isArray(social?.members) && name !== social.localName && social.members.some(m => m?.name === name);
    if (!member) return record.call(this, cast);
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target)].filter(Boolean));
    const before = new Map([...targets].map(gid => [gid, this.hitByOthers.get(gid)]));
    try { return record.call(this, cast); }
    finally { for (const [gid, at] of before) at === undefined ? this.hitByOthers.delete(gid) : this.hitByOthers.set(gid, at); }
  };
}


// Auto-resurrect dead party members with a learned corpse-targeted skill.
// The sim worker replaces a skill press's gid with the newest selection intent
// (core.ts), so the corpse is selected immediately before the press. The server
// proposes the revival, which the dead member answers inside a 30 second window.
// Only in-range corpses are considered when authored range is available.
const Resurrect = {
  sent: {},           // member id -> time of the unanswered proposal
  nextAt: -Infinity,  // earliest next attempt
  holdUntil: 0,
  trip: null,
  windowMs: 31000,    // the server's answer window plus one tick
  message: 'No fallen party member.',
  reset() { this.cancelTrip('', true); this.sent = {}; this.nextAt = -Infinity; this.holdUntil = 0; this.message = 'No fallen party member.'; },
  cancelTrip(message = '', halt = false) {
    if (this.trip && halt && this.trip.phase === 'approach') this.sent[this.trip.member] = now();
    if (this.trip && halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    this.trip = null;
    if (message) { this.message = message; Log.warn(message); }
  },
  returnTrip(message = '') {
    const a = this.trip;
    if (!a) return;
    a.phase = 'return'; a.travel = null; a.at = a.progressAt = now(); a.lastPose = { ...World.pose() }; a.sentAt = -Infinity;
    this.message = message || 'Returning to the hunting spot after resurrection.';
    if (message) Log.info(message);
  },
  travelTick(skill, members) {
    const a = this.trip, pose = World.pose();
    if (!a || !pose) return false;
    const member = members.find(m => m.id === a.member && m.name === a.name);
    const body = World.ents.get(a.gid);
    if (a.phase === 'cast') this.returnTrip();
    if (a.phase === 'approach' && (!member || (member.status & 15) !== 0 || !body || body.name !== a.name || body.appearanceState?.[0] !== 2 ||
        !Number.isFinite(dist2D(a.home, body)) || dist2D(a.home, body) > Settings.profile.party.resRadius)) {
      this.returnTrip('Resurrection target unavailable or outside the configured radius; returning.');
    }
    if (dist2D(a.lastPose, pose) > 3) { a.lastPose = { ...pose }; a.progressAt = now(); }
    if (now() - a.at > 30000 || now() - a.progressAt > 12000) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('Resurrection travel timed out; returning to the hunting spot.');
      } else {
        this.cancelTrip('Resurrection return blocked or timed out.', true);
        if (Hunt.running) Hunt.stop('Resurrection return blocked or timed out.');
        return false;
      }
    }
    const destination = a.phase === 'return' ? a.home : body;
    const distance = dist2D(pose, destination);
    if (a.phase === 'return' && distance <= 12) { this.trip = null; this.message = 'Back at the hunting spot.'; return false; }
    if (a.phase === 'approach' && distance <= Math.max(1, (skill.range || 150) - 5)) return false;
    if (World.isCasting() || World.isSitting()) return true;
    const move = Navigation.next(a, destination);
    if (move.error && !move.waiting) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('No walkable route to the party member; returning.');
      } else {
        this.cancelTrip(move.error, true);
        if (Hunt.running) Hunt.stop(move.error);
      }
      return true;
    }
    if (move.waiting) { this.message = move.error || 'Waiting for resurrection travel.'; return true; }
    if (a.phase === 'approach' && dist2D(a.home, move.point) > Math.max(Settings.profile.party.resRadius, dist2D(a.home, pose) + 1)) {
      this.sent[a.member] = now() + 30000; this.returnTrip('Resurrection detour exceeds the configured radius; returning.'); return true;
    }
    if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
    this.message = a.phase === 'return' ? 'Returning to the hunting spot.' : 'Walking into resurrection range: ' + a.name;
    return true;
  },
  // The highest-tier learned corpse-targeted row: the Rebirth family marks
  // itself with the DeadBody target bit, and later tiers carry the higher
  // mastery requirement.
  skill() {
    let best = null;
    for (const id of World.gp?.skills || []) {
      const s = World.skill(id);
      if (!s || !s.targetRequired || !((s.targets ?? 0) & 128)) continue;
      if (!best || this.rank(s) > this.rank(best)) best = s;
    }
    return best;
  },
  rank(s) {
    const mastery = Math.max(0, ...(s.masteries || []).map(m => m.Level || 0));
    return mastery * 1000 + (s.level ?? 0);
  },
  tick() {
    const c = Settings.profile.party;
    if (!c.autoRes) { this.cancelTrip('', true); this.holdUntil = 0; this.message = 'Auto-resurrect off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.cancelTrip(); this.holdUntil = 0; this.message = 'Waiting for a living character.'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) { this.cancelTrip('Manual control: resurrection travel cancelled.'); this.holdUntil = 0; return false; }
    if (now() < this.holdUntil || this.holdUntil && World.isCasting()) return true;
    this.holdUntil = 0;
    const social = World.gp?.social, members = social?.members;
    if (!Array.isArray(members)) { this.cancelTrip('', true); return false; }
    const party = members.filter(m => m && m.id && m.name && m.name !== social.localName);
    const t = now();
    for (const id of Object.keys(this.sent)) {
      const m = party.find(x => x.id === Number(id));
      if (!m || (m.status & 15) !== 0) delete this.sent[id];
    }
    const offered = party.find(m => this.sent[m.id]);
    this.message = offered ? 'Resurrection offered: ' + offered.name + '; waiting for the answer.' : 'Watching for fallen party members.';
    const skill = this.skill();
    if (!skill) { this.cancelTrip('', true); this.message = 'No learned resurrection skill (Rebirth) was found.'; return; }
    if (this.trip && this.travelTick(skill, party)) return true;
    if (t < this.nextAt || World.gp.targetPending || !Cmd.canCast(skill.id)) return !!this.trip;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending ||
        now() - Combat.lastCastAt < Settings.profile.macro.castGapMs || !Combat.mpOk(skill.id, World.me())) return !!this.trip;
    for (const m of party) {
      if ((m.status & 15) !== 0 || this.sent[m.id] && t - this.sent[m.id] < this.windowMs) continue;
      // The corpse must be in view as an entity to aim the select at.
      const e = [...World.ents.values()].find(x => x && x.kind === 'player' && x.name === m.name);
      if (!e || e.appearanceState?.[0] !== 2) continue;
      if (this.trip && e.gid !== this.trip.gid) continue;
      const distance = dist2D(World.pose(), e);
      const home = this.trip?.home || (Hunt.running && Settings.profile.hunt.center) || World.pose();
      if (!Number.isFinite(distance) || dist2D(home, e) > c.resRadius) continue;
      if (Loot.active && !Loot.active.petGid) {
        if (!Cmd.move(World.pose())) return false;
        Loot.suspend();
      }
      if (distance > Math.max(1, (skill.range || 150) - 5)) {
        if (!this.trip) this.trip = { phase: 'approach', member: m.id, gid: e.gid, name: e.name, home: { ...home },
          at: t, progressAt: t, lastPose: { ...World.pose() }, sentAt: -Infinity };
        return this.travelTick(skill, party);
      }
      if (!Cmd.select(e.gid)) return !!this.trip;
      if (!Cmd.skill(skill.id, e.gid)) return !!this.trip;
      if (this.trip) this.trip.phase = 'cast';
      Combat.lastCastAt = t; Combat.lastCastId = skill.id; Stats.count('casts');
      // Keep combat/loot movement from replacing the approach or cast before
      // the worker has published it. Continue holding any observed cast.
      this.holdUntil = t + Math.max(1000, skill.actionMs || 6000) + 500;
      this.nextAt = t + 700;
      const first = this.sent[m.id] === undefined;
      this.sent[m.id] = t;
      this.message = 'Resurrection offered: ' + m.name + '; waiting for the answer.';
      if (first) UI.toast('Resurrection offered: ' + m.name, 'info', 3000);
      return true;
    }
  },
};


// Native beta starter scroll: item 24198 -> skill 31107 (+100%, one hour).
// Never choose a paid scroll or infer consumption from a local command dispatch.
const SpeedScroll = {
  pending: null, attempts: 0, nextAt: 0, message: 'Speed scroll off.',
  reset() { this.pending = null; this.attempts = 0; this.nextAt = 0; this.message = 'Waiting for automation.'; },
  active() {
    if (World.buffRemaining(31107) > 0 || World.buffRemaining(5411) > 0) return true;
    const effects = [...(World.gp?.buffSlots || []).filter(b => b.state !== 'departing').map(b => b.effect), ...(World.gp?.attachedEffects || [])];
    return effects.some(e => e?.gid === World.localGid() && World.skill(e.skill)?.speedBuff?.active && World.buffRemaining(e.skill) > 0);
  },
  tick() {
    if (Town.trip) { this.message = 'Waiting for town services to finish.'; return false; }
    if (!Settings.profile.potion.speedScroll) { this.message = 'Speed scroll off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character in the world.'; return false; }
    if (this.active()) {
      this.pending = null; this.attempts = 0; this.nextAt = 0;
      this.message = 'Movement-speed buff active.'; return false;
    }
    if (!(Hunt.running || WalkBack.active || Restock.trip || Resurrect.trip)) { this.message = 'Waiting for hunting or travel.'; return false; }
    // Native inventory.use / useSkillItem installs this timed effect without
    // a combat cast. Waiting for World.isCasting() can starve it while hunting.
    const blocked = World.gp.inventoryPending ? 'Waiting for the inventory transaction to finish.' :
      World.gp.returnScroll ? 'Waiting for return-scroll travel.' :
      Resurrect.holdUntil > now() ? 'Waiting for the resurrection cast to finish.' :
      World.isSitting() ? 'Waiting for the character to stand.' :
      World.local()?.mountedOn ? 'Waiting for the character to dismount.' :
      Restock.activeShop() || World.gp.storage ? 'Waiting for the shop or storage to close.' :
      Restock.recording ? 'Waiting for route recording to finish.' :
      now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ? 'Waiting for the manual-control pause.' : '';
    if (blocked) { this.message = blocked; return false; }
    if (this.pending) {
      if (now() - this.pending.at < 8000) { this.message = 'Waiting for speed-buff confirmation.'; return false; }
      this.pending = null; this.nextAt = now() + 30000 * this.attempts;
      this.message = 'Speed buff was not confirmed. Backing off before retrying.';
      Log.warn(this.message);
    }
    if (this.attempts >= 3) { this.message = 'Speed buff not confirmed after 3 attempts. Check the game and toggle this option to retry.'; return false; }
    if (now() < this.nextAt) return false;
    const item = World.items().find(i => i.refObjId === 24198 && (i.quantity ?? 1) > 0);
    if (!item) { this.message = 'No beginner +100% speed scroll in your bag.'; return false; }
    if (!Cmd.itemUse(item.slot)) { this.message = 'Waiting for item-use availability (potions have priority).'; return false; }
    this.attempts++; this.pending = { at: now() };
    this.message = 'Beginner speed scroll requested; waiting for its buff.';
    return true;
  },
};


// Generated by gen-towns.py from the server data. Do not edit by hand.
const TOWN_TABLE = [{"key":"EU","name":"Constantinople","arrival":{"regionId":26959,"x":950.0,"y":84.0,"z":1070.0},"services":{"storage":{"refObjId":7503,"regionId":26959,"x":1348.9,"y":80.0,"z":845.88},"vendor":{"refObjId":7497,"regionId":26959,"x":1338.79,"y":84.09,"z":1400.89},"smith":{"refObjId":7495,"regionId":26959,"x":784.69,"y":83.46,"z":1532.71},"gate":{"refObjId":19074,"regionId":26959,"x":700.0,"y":80.0,"z":886.0}}},{"key":"WC","name":"Donwhang","arrival":{"regionId":26265,"x":957.0,"y":-80.0,"z":1508.0},"services":{"storage":{"refObjId":2058,"regionId":26265,"x":1260.35,"y":-105.81,"z":696.9},"vendor":{"refObjId":2053,"regionId":26265,"x":597.25,"y":-106.46,"z":1134.97},"smith":{"refObjId":2051,"regionId":26265,"x":1197.69,"y":-106.67,"z":1217.7},"gate":{"refObjId":2095,"regionId":26521,"x":962.0,"y":-105.81,"z":8.0}}},{"key":"KT","name":"Hotan","arrival":{"regionId":23687,"x":1138.0,"y":250.0,"z":153.0},"services":{"storage":{"refObjId":2083,"regionId":23687,"x":1134.28,"y":243.75,"z":610.79},"vendor":{"refObjId":2074,"regionId":23687,"x":832.16,"y":243.86,"z":1093.64},"smith":{"refObjId":2072,"regionId":23687,"x":501.58,"y":243.58,"z":766.27},"gate":{"refObjId":2096,"regionId":23687,"x":1131.0,"y":243.75,"z":488.0}}},{"key":"CH","name":"Jangan","arrival":{"regionId":25000,"x":969.0,"y":0.0,"z":1369.0},"services":{"storage":{"refObjId":2014,"regionId":25000,"x":980.35,"y":-32.52,"z":989.19},"vendor":{"refObjId":2005,"regionId":25000,"x":1584.08,"y":0.0,"z":1407.29},"smith":{"refObjId":2003,"regionId":25000,"x":332.73,"y":0.0,"z":1406.7},"gate":{"refObjId":2094,"regionId":25000,"x":1254.0,"y":-32.52,"z":1374.0}}},{"key":"CA","name":"Samarkand","arrival":{"regionId":27244,"x":270.0,"y":180.0,"z":1421.0},"services":{"storage":{"refObjId":7537,"regionId":27244,"x":563.43,"y":180.0,"z":1131.66},"vendor":{"refObjId":7532,"regionId":27243,"x":1426.07,"y":180.0,"z":1851.0},"smith":{"refObjId":7530,"regionId":27499,"x":1762.61,"y":180.0,"z":809.78},"gate":{"refObjId":19075,"regionId":27499,"x":1917.0,"y":180.0,"z":108.0}}}];


// Town service owns the whole recall -> warehouse -> shop -> smith -> reverse trip.
// Native travel-gate type 5 spends the reverse scroll: choice 2 recalls, choice 3 returns to death.
// See OpenSRO action/reversereturn.go, 6FEF10 and 5DA1B0's choice rows.
const TOWN_REVERSE = { recall: 2, death: 3 };
const Town = {
  trip: null, lastScrollPoint: null, deathPoint: null, message: 'Town cycle off.',
  // Clocks for the "no XP for N minutes" and "every N minutes" triggers. They run only while hunting, alive and in
  // the world, and restart when a trip begins or completes, so a long trip never triggers the next one.
  xpKey: '', lastXpAt: 0, cycleFrom: 0,
  history: [], lastTrace: '',
  blocked() {
    if (!this.cfg().enabled) return 'town cycle is off';
    if (!Hunt.running) return 'bot is stopped';
    if (!World.inWorld() || !World.gp || !World.local()) return 'waiting for game world';
    if (World.isDead()) return 'character is dead';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'manual control pause';
    if (WalkBack.active) return 'walk-back is active';
    if (Restock.recording) return 'recording a walking route';
    if (Restock.activeShop() || World.gp.storage) return 'close the open shop or storage';
    return '';
  },
  record(event = 'tick') {
    // Diagnostics must never prevent Stop or hide an engine error.
    try {
      const gp = World.gp, pet = Loot.pet();
      const row = { event, running: Hunt.running, mode: Controller.mode, phase: this.trip?.phase || '',
        trigger: this.reason(), blocked: this.trip ? '' : this.blocked(), message: this.message,
        inventoryPending: !!gp?.inventoryPending, casting: World.isCasting(), returnScroll: !!gp?.returnScroll,
        attempts: this.trip?.scrollAttempts || 0, accepted: !!this.trip?.scrollRequest?.accepted,
        freeBag: World.freeBagSlots(), petFree: pet ? pet.rec.status - pet.rec.inventory.length : null,
        hp: Potion.count('hp'), mp: Potion.count('mp'), error: gp?.error || '' };
      const key = JSON.stringify(row);
      if (key === this.lastTrace) return;
      this.lastTrace = key; this.history.push({ at: Date.now(), ...row });
      if (this.history.length > 120) this.history.shift();
    } catch {}
  },

  // Dispatch is not acknowledgement. Inventory-busy/cooldown refusals can
  // leave the worker without ever starting a scroll. Never resend an accepted
  // or unresolved inventory operation: native replies have no transaction ID.
  sentScroll(scroll, phase) {
    const request = { slot: scroll.slot, ref: scroll.refObjId, quantity: scroll.quantity ?? 1,
      state: World.gp, accepted: false, at: now() };
    this.trip.scrollAttempts = (this.trip.scrollAttempts || 0) + 1;
    this.enter(phase); this.trip.scrollRequest = request;
  },
  checkScroll() {
    const t = this.trip, r = t?.scrollRequest, gp = World.gp;
    if (!r || !gp) return false;
    const item = gp.inventory?.find(i => i.slot === r.slot && i.refObjId === r.ref);
    if (t.transition || gp.returnScroll || Array.isArray(gp.inventory) && (!item || (item.quantity ?? 1) < r.quantity)) r.accepted = true;
    if (r.accepted || now() - r.at < 5000) return false;
    if (/timed out|resynchron/i.test(gp.error || '')) {
      this.fail('Game inventory timed out; reconnect to resynchronize before restarting.'); return true;
    }
    // A new native snapshot must positively report the unchanged scroll and
    // idle inventory, otherwise its outcome is still unknown.
    if (gp === r.state || gp.inventoryPending !== false || !item || (item.quantity ?? 1) !== r.quantity || World.isCasting()) {
      this.message = 'Scroll not confirmed; waiting for fresh, settled game state.'; return true;
    }
    if (t.scrollAttempts >= 3) {
      this.fail('Return request was not accepted after three attempts. ' + (gp.error || 'Check game travel restrictions.')); return true;
    }
    const next = t.phase === 'recall-wait' ? 'recall' : 'reverse';
    this.enter(next); t.scrollRequest = null;
    if (next === 'recall') { t.haltSent = false; t.haltAttempts = 0; t.potionWindowReserved = true; }
    this.message = 'Scroll was not accepted; retrying automatically (' + (t.scrollAttempts + 1) + '/3).';
    return true;
  },
  cfg() { return Restock.cfg().town; },
  // Native X-Large HP/MP IDs 8/15, both authored with 50 potions per stack.
  // Arrows and bolts (item 62 and 10376 on this server) are sold by the weapon merchant, so they are bought there,
  // after selling and before repairing. They count in the bag and in the equipped ammunition slot together.
  ammoSupplies() {
    const a = Restock.cfg().ammo;
    return [['arrow', 62], ['bolt', 10376]].filter(([kind]) => a?.[kind]?.on).map(([kind, refObjId]) => ({ kind, refObjId, low: a[kind].low, target: a[kind].target }));
  },
  ammoCount(ref) { return (World.gp?.inventory || []).filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  supplies() { return Restock.supplies().map(s => ({ ...s, refObjId: s.kind === 'hp' ? 8 : s.kind === 'mp' ? 15 : s.refObjId })); },
  status() {
    if (this.trip) return this.message + (this.trip.why ? ` (reason: ${this.trip.why})` : '');
    if (this.message.startsWith('Town cycle stopped:')) return this.message;
    if (!this.cfg().enabled) return 'Town cycle off. The pet-full chime is an alert; enable the scroll town cycle to return automatically.';
    if (!World.inWorld()) return 'Town cycle: waiting for game world.';
    const blocked = this.blocked();
    if (blocked) return 'Town return: ' + (this.reason() ? this.reason() + '; ' : '') + blocked + '.';
    const error = this.validate();
    return error ? 'Town cycle not ready: ' + error : 'Town cycle ready: waiting for low potions or character/pet bag capacity.';
  },
  scroll(type) { return World.items().find(i => (i.typeFlags & 0xfffc) === type && (i.quantity ?? 1) > 0); },
  free(items, start, end) {
    const used = new Set(items.map(i => i.slot));
    for (let slot = start; slot < end; slot++) if (!used.has(slot)) return slot;
    return null;
  },
  save(role) {
    if (Hunt.running || this.trip || Restock.recording || !World.inWorld()) return UI.toast('Stop hunting and route recording before saving town services.', 'warn');
    const c = this.cfg(), p = World.pose(), gp = World.gp;
    if (!p) return;
    if (role === 'arrival') c.arrival = { ...p };
    else {
      const npc = World.target(), cap = gp.targetCapabilities ?? 0;
      const required = { storage: 4, vendor: 1, smith: 8, gate: 0x80 }[role];
      if (!this.serviceEntity(role, npc) || gp.targetPending || !(cap & required)) return UI.toast(role === 'gate' ? 'Select the world statue / teleport in the game first.' : role === 'smith' ? 'Select a merchant that offers equipment repair in the game first.' : 'Select the appropriate town NPC in the game first.', 'warn');
      if (dist2D(p, npc) > 200) return UI.toast('Stand within 20 m of the NPC before saving its approach point.', 'warn');
      if (!c.arrival || dist2D(p, c.arrival) > 3000) return UI.toast('Save the town arrival point nearby first.', 'warn');
      if (role === 'vendor') {
        const shop = Restock.activeShop();
        if (!shop || shop.npc !== npc.gid) return UI.toast('Open this potion merchant shop before saving it.', 'warn');
        Restock.cfg().offers = shop.offers.filter(o => Restock.offerKind(o)).map(o => ({ refObjId: o.refObjId, name: o.name, kind: Restock.offerKind(o) }));
        for (const kind of ['hp', 'mp']) if (!Restock.cfg().offers.some(o => o.kind === kind && o.refObjId === Restock.cfg()[kind].refObjId)) Restock.cfg()[kind].refObjId = Restock.cfg().offers.find(o => o.kind === kind)?.refObjId || 0;
      }
      // Save the reachable place the user stands, rather than the NPC/model centre.
      c[role] = { ...p, refObjId: npc.refObjId, name: npc.name,
        npc: { regionId: npc.regionId, x: npc.x, y: npc.y, z: npc.z } };
    }
    this.message = 'Town setup updated.';
    Settings.saveProfile(); UI.toast('Saved town ' + role + '.'); UI.draw();
  },
  // Where each town's services stand, from the server data (see gen-towns.py).
  towns: TOWN_TABLE,
  // The known town whose four services all lie within 500 m of the position; the nearest overall wins.
  detect(point = World.pose()) {
    let best = null, bestTotal = Infinity;
    for (const town of this.towns) {
      const distances = Object.values(town.services).map(s => dist2D(point, s));
      if (distances.some(d => !(d <= 5000))) continue;
      const total = distances.reduce((a, b) => a + b, 0);
      if (total < bestTotal) { best = town; bestTotal = total; }
    }
    return best;
  },
  // A spot a few metres from the NPC on the side facing `from`: the NPC's own position is usually blocked. With
  // collision data for the area the spot must be walkable; without it the first choice is used and marked unverified.
  standPoint(npc, from) {
    const toward = regionDelta(npc, from) || [1, 0], base = Math.atan2(toward[1], toward[0]);
    let first = null;
    for (const distance of [40, 60, 80]) for (const turn of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const angle = base + turn, x = npc.x + Math.cos(angle) * distance, z = npc.z + Math.sin(angle) * distance;
      const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR);
      const point = { regionId: ((npc.regionId & 255) + sx) | (((npc.regionId >>> 8) + sz) << 8), x: x - sx * SECTOR, y: npc.y, z: z - sz * SECTOR };
      first ||= point;
      const local = Navigation.scene && Navigation.local(point);
      if (local && Navigation.open(local.x, local.z)) return { point, verified: true };
    }
    return { point: first, verified: false };
  },
  // Fills the arrival point and the four services from the town table. Only empty entries are filled unless
  // `overwrite` is set; an arrival point that belongs to another town replaces everything. A town can be chosen by key:
  // the arrival point is where its return scroll always lands, so it needs no standing in town; without a key the town
  // around the character is used.
  autoSetup(overwrite = false, key = '') {
    if (Hunt.running || this.trip || Restock.recording || !World.inWorld()) { UI.toast('Stop hunting and route recording before setting up the town.', 'warn'); return null; }
    const c = this.cfg(), here = World.pose();
    if (!here) return null;
    const town = key ? this.towns.find(t => t.key === key) : this.detect(here);
    if (!town) {
      this.message = 'Automatic setup: no known town around you. Use a return scroll, then press the button where it puts you.';
      UI.toast(this.message, 'warn', 6000); return null;
    }
    if (!(c.arrival && this.detect(c.arrival)?.key === town.key)) overwrite = true;
    const saved = [];
    if (overwrite || !c.arrival) { c.arrival = { ...(town.arrival || here) }; saved.push('arrival point'); }
    let unverified = 0;
    for (const [role, label] of [['storage', 'warehouse'], ['vendor', 'potion merchant'], ['smith', 'repair merchant'], ['gate', 'world statue']]) {
      if (c[role] && !overwrite) continue;
      const s = town.services[role], stand = this.standPoint(s, c.arrival);
      if (!stand.verified) unverified++;
      c[role] = { ...stand.point, refObjId: s.refObjId, name: town.name + ' ' + label,
        npc: { regionId: s.regionId, x: s.x, y: s.y, z: s.z } };
      saved.push(label);
    }
    this.message = saved.length ? `Automatic setup for ${town.name}: saved ${saved.join(', ')}.` + (unverified ? ' Walkable spots could not be checked without collision data; the first trip will tell.' : '')
      : `Automatic setup for ${town.name}: everything was already saved.`;
    Settings.saveProfile(); UI.toast(this.message, 'info', 6000); UI.draw();
    return { town: town.name, saved, unverified };
  },
  disposable(item) {
    const c = this.cfg(), name = (item.name || '').toLowerCase(), tf = item.typeFlags;
    // Missing type metadata must never turn an item into a disposal candidate; gear marked for deposit is never sold.
    if (!Number.isInteger(tf) || this.depositItem(item) || ItemType.isPotion(tf) || ItemType.isCure(tf) ||
        (tf & 0x7fc) === 0x1ec || item.refObjId === 24198 ||
        Restock.supplies().some(s => s.refObjId === item.refObjId) ||
        splitList(c.keep).some(s => name.includes(s))) return false;
    // Native rarity 2 covers seal tiers. Plus and blue options do not protect
    // ordinary gear; unknown rarity still means keep it rather than guess.
    if (ItemType.isEquipment(tf) && (![0, 1].includes(item.tooltip?.fields?.rarity) ||
        /_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/i.test(item.codename || ''))) return false;
    return true;
  },
  // Deposit-worthy gear: Star/Moon/Sun equipment from the character bag or the pickup pet.
  // "85" or "80-90, 100": the character levels whose gear is deposited. Anything unreadable is ignored.
  levelRanges() {
    return String(this.cfg().storeLevels ?? '').split(/[,;\s]+/).map(part => {
      const m = /^(\d{1,3})(?:-(\d{1,3}))?$/.exec(part);
      return m ? [Math.min(+m[1], +(m[2] ?? m[1])), Math.max(+m[1], +(m[2] ?? m[1]))] : null;
    }).filter(Boolean);
  },
  // Character level an equipment item requires, from its tooltip fields (type 1 = character level), or null.
  requiredLevel(item) {
    const f = item.tooltip?.fields;
    if (!f) return null;
    for (let i = 1; i <= 4; i++) {
      if (f['reqLevelType' + i] !== 1) continue;
      const level = f['requiredLevel' + (i === 1 ? '' : i)];
      return Number.isInteger(level) ? level : null;
    }
    return null;
  },
  // Gear to deposit: Star/Moon/Sun equipment, and equipment requiring a character level you listed. Gear the bot or
  // the player relies on stays put: names in Keep, a saved buff set's weapon or shield, and the weapon picked for
  // alchemy (checked by bag slot, so only for items from the character bag).
  depositItem(item, fromBag = false) {
    const c = this.cfg(), act = ItemRules.get(item.refObjId)?.act;
    // An item rule decides first. Store: any kind of item, except from the bag what the trip itself needs
    // (potions, pills, return/reverse/speed scrolls, the supplies it buys). Sell, keep or drop: never deposited.
    if (act && act !== 'store') return false;
    if (act === 'store') {
      if (fromBag && this.needed(item)) return false;
      const key = BuffGear.key(item);
      if (BuffGear.cfg().buffSets.some(s => s.weapon === key || s.shield === key)) return false;
      return !(fromBag && Alchemy.selected && Alchemy.selected.slot === item.slot);
    }
    if (!Number.isInteger(item.typeFlags) || !ItemType.isEquipment(item.typeFlags)) return false;
    const level = this.requiredLevel(item);
    if (!(c.storeSox && Items.soxOf(item) > 0) && !(level !== null && this.levelRanges().some(([a, b]) => level >= a && level <= b))) return false;
    if (splitList(c.keep).some(s => (item.name || '').toLowerCase().includes(s))) return false;
    const key = BuffGear.key(item);
    if (BuffGear.cfg().buffSets.some(s => s.weapon === key || s.shield === key)) return false;
    return !(fromBag && Alchemy.selected && Alchemy.selected.slot === item.slot);
  },
  // Loot kept in the warehouse instead of being sold. Stones are also deposited from the character bag; elixirs are
  // not, because alchemy takes them from there.
  kept: ['elixirs', 'magicStones', 'attrStones'],
  // Supplies the town trip needs and buys, kept in the bag whatever the rules say.
  needed(item) {
    const tf = item.typeFlags;
    return !Number.isInteger(tf) || ItemType.isPotion(tf) || ItemType.isCure(tf) || (tf & 0x7fc) === 0x1ec || item.refObjId === 24198 ||
      Restock.supplies().some(s => s.refObjId === item.refObjId);
  },
  ruled(item) { const act = ItemRules.get(item.refObjId)?.act; return act && act !== 'store' ? act : ''; },
  stone(item) { return !this.ruled(item) && this.disposable(item) && ['magicStones', 'attrStones'].includes(Loot.category(item.typeFlags)); },
  eligible(item) { return !this.ruled(item) && (this.depositItem(item) || this.disposable(item) && this.kept.includes(Loot.category(item.typeFlags))); },
  // Pet loot, and the character bag when "Sell items from the character bag" is on. A Sell rule sells it; keep, store and drop rules never do.
  sellable(item) {
    // itemdata CanSell 0 (quest and event items): the merchant refuses the sale with inventory code 2.
    if (item.tooltip?.fields?.canSell === 0) return false;
    const act = ItemRules.get(item.refObjId)?.act;
    if (act) return act === 'sell';
    return this.disposable(item) && !this.kept.includes(Loot.category(item.typeFlags));
  },
  // From the bag, never what the trip itself needs, the weapon chosen for alchemy or a saved buff set's gear.
  sellableBag(item) {
    if (this.needed(item) || Alchemy.selected && Alchemy.selected.slot === item.slot) return false;
    const key = BuffGear.key(item);
    if (BuffGear.cfg().buffSets.some(s => s.weapon === key || s.shield === key)) return false;
    return this.sellable(item);
  },
  autoRevive() { return this.cfg().enabled && this.cfg().revive; },
  reason() {
    const c = this.cfg(), pet = Loot.pet();
    if (World.freeBagSlots() <= 1) return 'character bag nearly full';
    if (c.petFull && pet && pet.rec.status - pet.rec.inventory.length <= c.petFree) return 'pickup pet nearly full';
    if (this.supplies().some(s => Restock.count(s.refObjId) <= s.low)) return 'potions running low';
    if (this.ammoSupplies().some(s => this.ammoCount(s.refObjId) <= s.low)) return 'ammunition running low';
    if (c.broken && this.weaponBroken()) return 'weapon broken';
    const worn = c.wear?.on ? this.wear() : null;
    if (worn && worn.pct < c.wear.pct) return `gear durability low (${worn.name} at ${Math.floor(worn.pct)}%)`;
    if (c.noXp?.on && this.lastXpAt && now() - this.lastXpAt >= c.noXp.minutes * 60000) return `no XP for ${c.noXp.minutes} minutes`;
    if (c.every?.on && this.cycleFrom && now() - this.cycleFrom >= c.every.minutes * 60000) return `every ${c.every.minutes} minutes`;
    return '';
  },
  // The equipped weapon (slot 6) at zero durability.
  weaponBroken() {
    const w = (World.gp?.inventory || []).find(i => i.slot === 6);
    return !!w && ItemType.isEquipment(w.typeFlags) && w.durability === 0;
  },
  // The most worn repairable equipped item, as a percentage of its own maximum. Items whose maximum is unknown
  // (no tooltip yet) are left out rather than guessed.
  wear() {
    let low = null;
    const equipped = World.gp?.equipmentSlotCount || 13;
    for (const i of World.gp?.inventory || []) {
      if (i.slot >= equipped || !ItemType.isEquipment(i.typeFlags) || !Number.isFinite(i.durability) || !i.tooltip?.fields?.canRepair) continue;
      const max = this.maximum(i);
      if (!max) continue;
      const pct = i.durability / max * 100;
      if (!low || pct < low.pct) low = { pct, name: i.name || Items.name?.(i.refObjId) || 'gear' };
    }
    return low;
  },
  watch() {
    if (!Hunt.running || !World.inWorld() || World.isDead()) { this.lastXpAt = this.cycleFrom = 0; this.xpKey = ''; return; }
    const p = World.gp?.progression, key = `${p?.level}:${p?.experience}`;
    if (!this.cycleFrom) { this.restartClocks(); this.xpKey = key; return; }
    if (key !== this.xpKey) { this.xpKey = key; this.lastXpAt = now(); }
  },
  restartClocks() { this.lastXpAt = this.cycleFrom = now(); },
  validate(revival = false) {
    const c = this.cfg(), supplies = this.supplies();
    const missing = [['arrival', 'arrival point'], ['vendor', 'potion merchant'], ['smith', 'repair merchant'], ['gate', 'world statue / teleport'], ...(c.petFull ? [['storage', 'warehouse']] : [])].filter(([key]) => !c[key]).map(([, label]) => label);
    if (missing.length) return 'Save missing town services: ' + missing.join(', ') + '.';
    if (!supplies.length || supplies.some(s => !s.refObjId || !Number.isInteger(s.low) || !Number.isInteger(s.target) || s.low < 0 || s.target <= s.low || s.target > 10000)) return 'Choose potions and valid low-stock/refill quantities.';
    if ((!revival && !this.scroll(0x09ec)) || !this.scroll(0x19ec)) return revival ? 'Carry a reverse return scroll for revival return.' : 'Carry a return scroll and a reverse return scroll before hunting.';
    if (toBigInt(World.gp.progression?.gold ?? 0) <= 0n) return 'Carry gold for potions, storage and repairs.';
    return '';
  },
  fail(reason) {
    this.cancel(); this.message = 'Town cycle stopped: ' + reason;
    Hunt.stop(this.message); UI.toast(this.message, 'warn', 8000);
  },
  cancel() {
    if (this.trip && World.inWorld() && World.gp.returnScroll && ['recall-wait', 'reverse-wait'].includes(this.trip.phase)) Cmd.raw({ kind: 'return-cancel' }, 'Town: cancel return cast');
    this.trip = null;
  },
  phase(phase) {
    const t = this.trip;
    if (!t) return false;
    if (phase === 'entering-world' && ['recall-wait', 'reverse-wait'].includes(t.phase) && now() - t.at < 90000) {
      t.transition = true; return true;
    }
    if (phase !== 'world') this.fail('Unexpected travel or disconnect.');
    return false;
  },
  begin(revival = false) {
    const error = this.validate(revival);
    if (error) return this.fail(error);
    // The death spot is used only when it lies inside the hunting area: hunting starts again only from there. A death
    // further away (or an unknown hunting area) reverses to the last return-scroll point instead.
    const H = Hunt.cfg(), deathInArea = !!(this.deathPoint && H.center && dist2D(this.deathPoint, H.center) <= H.radius);
    const reverseChoice = revival && this.cfg().deathReturn === 'death' && deathInArea ? TOWN_REVERSE.death : TOWN_REVERSE.recall;
    if (revival && this.cfg().deathReturn === 'death' && !deathInArea) Log.info('Died outside the hunting area: reversing to the last return-scroll point so hunting can start again.');
    const origin = revival ? (reverseChoice === TOWN_REVERSE.death ? this.deathPoint || Hunt.cfg().center : this.lastScrollPoint || Hunt.cfg().center) : World.pose();
    if (!origin) return this.fail('No saved hunting point for revival return.');
    if (revival) Hunt.running = true;
    Restock.trip = null;
    Resurrect.cancelTrip('', true); Resurrect.holdUntil = 0; Loot.suspend();
    this.restartClocks();
    // Say why, once: the trigger is only visible before departure, and people ask why the bot went to town.
    const why = revival ? 'returning after a death' : this.reason() || 'started by you';
    this.lastTrip = { why, at: now() };
    this.trip = { phase: 'recall', at: now(), started: now(), origin: { ...origin }, revival, reverseChoice, why,
      huntArea: revival && !(reverseChoice === TOWN_REVERSE.death && this.deathPoint) && Hunt.cfg().center ? { center: { ...Hunt.cfg().center }, radius: Hunt.cfg().radius } : null,
      manualAt: Manual.lastAt, character: World.charName, petRef: Loot.pet()?.rec.refObjId,
      config: JSON.stringify(this.cfg()), supplies: this.supplies(), sellFirst: !!this.cfg().sellBag };
    Hunt.targetGid = Hunt.lootGid = 0;
    // Stop the worker's repeating attack/movement as well as the bot's next tick.
    // Pending inventory work still settles before item-use is admitted below.
    this.trip.haltSent = Cmd.move(World.pose());
    this.trip.haltAt = now();
    this.trip.haltAttempts = this.trip.haltSent ? 1 : 0;
    if (revival) this.enter('revive-arrival');
    else this.message = 'Using return scroll; recall must be bound to your town.';
  },
  arrived() {
    this.trip.scrollAttempts = 0; this.trip.scrollRequest = null;
    // With bag selling on, the trip sells first, so a full bag can still make room for refills.
    if (World.freeBagSlots() < 1 && !this.trip.sellFirst) return this.fail('Returned to town; free a character bag slot for storage and refills.');
    if (this.cfg().petFull && this.reason() === 'pickup pet nearly full' && !Loot.pet()?.rec.inventory.some(i => this.disposable(i) || this.eligible(i))) return this.fail('Returned to town; pet is full of protected items. Empty it manually.');
    this.enter(this.cfg().storage ? 'walk-storage' : this.trip.sellFirst ? 'walk-smith' : 'walk-vendor');
  },
  // The merchant to walk to after closing a window: potions come before repair and selling, unless bag selling is on,
  // which sells and repairs first so a full bag has room to buy.
  closeNext(phase) {
    const sellFirst = this.trip?.sellFirst;
    return { 'close-storage': sellFirst ? 'walk-smith' : 'walk-vendor', 'close-smith': sellFirst ? 'walk-vendor' : 'walk-gate', 'close-vendor': sellFirst ? 'walk-gate' : 'walk-smith' }[phase];
  },
  enter(phase) {
    const t = this.trip;
    t.phase = phase; t.at = now(); t.sent = false; t.pending = null; t.transition = false;
    t.travel = null; t.lastPose = null; t.progressAt = now(); t.movedAt = -Infinity; t.retryAt = 0;
    this.message = 'Town cycle: ' + phase;
  },
  // Plain wording for the service being approached (never an NPC name), for messages and bug reports.
  role(phase) { return { storage: 'warehouse', vendor: 'potion merchant', smith: 'repair merchant', gate: 'world statue' }[String(phase).replace(/^(walk|open|close)-/, '')] || 'service point'; },
  walk(dest) {
    const t = this.trip, pose = World.pose();
    // Permit a reachable nearby approach, but always stay in service range.
    const radius = Math.max(0, Math.min(60, 190 - dist2D(dest, dest.npc || dest)));
    if (dist2D(pose, dest) <= Math.max(12, radius) && dist2D(pose, dest.npc || dest) <= 200) return true;
    if (!Number.isFinite(dist2D(pose, dest))) { this.fail('Town service is in another world.'); return false; }
    if (!t.lastPose || dist2D(t.lastPose, pose) > 3) { t.lastPose = { ...pose }; t.progressAt = now(); }
    if (now() < t.retryAt) return false;
    if (now() - t.progressAt > 20000) {
      t.travel = null; t.retryAt = now() + 5000; t.progressAt = now();
      this.message = 'Town movement to the ' + this.role(t.phase) + ': blocked route (no progress for 20 s); retrying.';
      return false;
    }
    const step = Navigation.next(t, dest, false, radius);
    if (step.waiting || step.error) {
      t.travel = null; t.retryAt = now() + 5000; t.progressAt = now();
      this.message = 'Town movement to the ' + this.role(t.phase) + ': waiting; retrying collision route. ' + (step.error || 'Waiting for collision coverage.');
      return false;
    }
    this.message = 'Town cycle: walking to the ' + this.role(t.phase);
    if (!step.point || now() - t.movedAt < 1000 || World.gp.inventoryPending) return false;
    if (World.isSitting()) { if (Cmd.action(1000)) t.movedAt = now(); }
    else if (Cmd.move(step.point)) t.movedAt = now();
    return false;
  },
  serviceEntity(role, entity) { return !!entity && (entity.kind === 'npc' || role === 'gate' && entity.kind === 'teleport'); },
  npc(role) {
    const saved = this.cfg()[role];
    return [...World.ents.values()].find(e => this.serviceEntity(role, e) && e.refObjId === saved.refObjId && dist2D(e, saved.npc || saved) < 100);
  },
  open(role, kind) {
    const t = this.trip, gp = World.gp, npc = this.npc(role);
    if (now() - t.at > 15000) { this.fail('Could not open ' + role + '.'); return false; }
    if (!npc || gp.targetPending || gp.inventoryPending) return false;
    if (gp.target !== npc.gid) {
      if (t.sent) { this.fail('Town NPC selection changed.'); return false; }
      if (Cmd.spaced('select')) Cmd.select(npc.gid);
      return false;
    }
    const caps = { storage: 4, vendor: 1, smith: 8, gate: 0x20000000 };
    if (!(gp.targetCapabilities & caps[role])) { this.fail('Selected NPC does not offer ' + role + '.'); return false; }
    // Selection itself opens the service menu. npc-talk requires the separate
    // Talk capability and is invalid for teleport statues with no dialogue.
    if (role === 'gate') return gp.npcConversation?.phase === 'menu' && gp.npcConversation.gid === npc.gid;
    if (!t.sent) {
      t.revision = gp.shopCompletionRevision;
      if (Cmd.raw({ kind, ...(kind === 'npc-talk' ? {} : { gid: npc.gid }) }, 'Town: open ' + role)) t.sent = true;
      return false;
    }
    if (role === 'storage') return gp.storage?.phase === 'open' && !gp.storage.guild && gp.storage.npc === npc.gid;
    return gp.shop?.npc === npc.gid && gp.shopCompletionRevision !== t.revision;
  },
  close(next) {
    const t = this.trip, gp = World.gp;
    if (gp.inventoryPending) return;
    if (!t.sent) { if (Cmd.raw({ kind: 'npc-close' }, 'Town: close NPC')) t.sent = true; return; }
    if (!gp.target && !gp.storage) this.enter(next);
  },
  pendingDone(check) {
    const t = this.trip, p = t.pending;
    if (!p) return true;
    if (World.gp.inventoryPending || now() - p.at < 500) {
      if (now() - p.at > 15000) this.fail('Inventory transaction timed out. No repeat command sent.');
      return false;
    }
    if (check(p)) {
      Activity.emit({ category: 'town', code: 'inventory-confirmed', text: 'Town ' + t.phase + ': inventory result observed.', outcome: 'confirmed', operationId: Activity.contexts.town?.id, details: { quantity: p.quantity } });
      t.pending = null; return true;
    }
    if (World.gp.error || now() - p.at > 15000) this.fail(World.gp.error || 'Transaction was not confirmed. No repeat command sent.');
    return false;
  },
  store() {
    const t = this.trip, gp = World.gp, st = gp.storage;
    if (!st || st.guild || st.phase !== 'open' || gp.target !== st.npc) return this.fail('Warehouse closed or selection changed.');
    const pet = Loot.pet();
    if (t.petRef && (!pet || pet.rec.refObjId !== t.petRef)) return this.fail('Pickup pet is missing or changed.');
    if (!this.pendingDone(p => {
      if (p.kind === 'pet') return !pet.rec.inventory.some(i => i.slot === p.source && i.refObjId === p.ref) && World.items().some(i => i.slot === p.destination && i.refObjId === p.ref && (i.quantity ?? 1) === p.quantity);
      return !World.items().some(i => i.slot === p.source && i.refObjId === p.ref) && st.items.some(i => i.slot === p.destination && i.refObjId === p.ref && (i.quantity ?? 1) === p.quantity);
    }) || !this.trip || gp.inventoryPending) return;
    const bagItem = t.staged ? World.items().find(i => i.slot === t.staged.slot && i.refObjId === t.staged.ref) : null;
    if (t.staged && !bagItem) return this.fail('Staged pet item changed unexpectedly.');
    // Gear the character picked up is deposited straight from the bag, then pet loot is staged through it.
    const bagSox = bagItem ? null : World.items().find(i => this.depositItem(i, true) || this.stone(i));
    const direct = bagItem || bagSox;
    const item = direct || pet?.rec.inventory.find(i => this.eligible(i));
    if (!item) {
      this.enter('close-storage'); return;
    }
    const destination = this.free(st.items, 0, st.capacity);
    if (destination === null) return this.fail('Storage is full.');
    let command, pending;
    if (direct) {
      command = { kind: 'storage-move', move: { type: 2, source: item.slot, destination, quantity: 0, gold: 0 } };
      pending = { kind: 'store', source: item.slot, destination, ref: item.refObjId, quantity: item.quantity ?? 1 };
    } else {
      const slot = this.free(gp.inventory, gp.equipmentSlotCount || 13, gp.inventorySlotCount);
      if (slot === null) return this.fail('No temporary character bag slot for pet transfer.');
      command = { kind: 'cos-transfer', gid: pet.rec.gid, toCos: false, source: item.slot, destination: slot };
      pending = { kind: 'pet', source: item.slot, destination: slot, ref: item.refObjId, quantity: item.quantity ?? 1 };
    }
    if (Cmd.raw(command, direct ? 'Town: deposit item' : 'Town: move selected pet loot')) {
      t.pending = { ...pending, at: now() };
      t.staged = direct ? null : { slot: pending.destination, ref: pending.ref };
    }
  },
  sell() {
    const t = this.trip, gp = World.gp, pet = Loot.pet();
    if (!Restock.activeShop() || gp.shop.npc !== this.npc('smith')?.gid || gp.shop.error) return this.fail(gp.shop?.error || 'Weapon merchant selection changed.');
    if (t.petRef && (!pet || pet.rec.refObjId !== t.petRef)) return this.fail('Pickup pet is missing or changed.');
    if (t.salePetGid && pet?.rec.gid !== t.salePetGid) return this.fail('Pickup pet changed during selling.');
    // A refused sale leaves the item where it was. Skip it and sell the rest: one item the merchant will not take
    // must not end the trip.
    const p = t.pending;
    if (p && gp.error && !gp.inventoryPending && now() - p.at >= 500 &&
        (p.bag ? World.items() : pet?.rec.inventory || []).some(i => i.slot === p.source && i.refObjId === p.ref)) {
      (t.unsold ||= []).push((p.bag ? 'bag:' : 'pet:') + p.source + ':' + p.ref);
      Activity.emit({ category: 'town', code: 'sale-refused', level: 'warn', text: 'Town sell: merchant refused an item (' + gp.error + '); skipped.', userText: 'The merchant refused one item; it was kept and selling continued.', outcome: 'refused', operationId: Activity.contexts.town?.id });
      t.pending = null;
    }
    if (!this.pendingDone(p => p.bag ? !World.items().some(i => i.slot === p.source && i.refObjId === p.ref) : !pet.rec.inventory.some(i => i.slot === p.source && i.refObjId === p.ref)) || !this.trip || gp.inventoryPending) return;
    const unsold = (where, i) => t.unsold?.includes(where + i.slot + ':' + i.refObjId);
    const petItem = pet?.rec.inventory.find(i => this.sellable(i) && !unsold('pet:', i));
    const bagItem = !petItem && t.sellFirst ? World.items().find(i => this.sellableBag(i) && !unsold('bag:', i)) : null;
    const item = petItem || bagItem;
    if (!item) {
      if (this.cfg().petFull && pet && pet.rec.status - pet.rec.inventory.length <= this.cfg().petFree) return this.fail('Protected pet items still fill the bag.');
      this.enter(this.ammoSupplies().length ? 'ammo' : 'repair'); return;
    }
    const quantity = item.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 65535) return this.fail('Invalid item sale quantity.');
    if (bagItem) {
      if (Cmd.raw({ kind: 'shop-sell', slot: item.slot, quantity }, 'Town: sell bag item at weapon merchant')) t.pending = { bag: true, source: item.slot, ref: item.refObjId, quantity, at: now() };
      return;
    }
    if (Cmd.raw({ kind: 'cos-shop-sell', gid: pet.rec.gid, slot: item.slot, quantity }, 'Town: sell pet loot at weapon merchant')) {
      t.salePetGid = pet.rec.gid;
      t.pending = { source: item.slot, ref: item.refObjId, quantity, at: now() };
    }
  },
  // Tops up arrows and bolts at the weapon merchant. A shortfall here (not sold, no bag room, no gold) is reported and
  // skipped: the rest of the trip still matters.
  ammo() {
    const t = this.trip, gp = World.gp, shop = Restock.activeShop();
    if (!shop || shop.npc !== this.npc('smith')?.gid || shop.error) return this.fail(shop?.error || 'Weapon merchant selection changed.');
    if (!this.pendingDone(p => this.ammoCount(p.ref) >= p.before + p.quantity) || !this.trip || gp.inventoryPending) return;
    t.ammoSkipped ||= [];
    const skip = (s, why) => { t.ammoSkipped.push(s.kind); this.message = `Ammunition: no ${s.kind}s bought, ${why}.`; UI.toast(this.message, 'warn', 6000); };
    const s = this.ammoSupplies().find(s => !t.ammoSkipped.includes(s.kind) && this.ammoCount(s.refObjId) < s.target);
    if (!s) { this.enter('repair'); return; }
    const offer = shop.offers.find(o => o.refObjId === s.refObjId && (o.currency === undefined || o.currency === 1) &&
      (!o.contents?.length || o.contents.length === 1 && o.contents[0].refObjId === o.refObjId && o.contents[0].quantity === 1));
    if (!offer || !(offer.maxStack > 0)) return skip(s, 'this merchant does not sell them');
    const before = this.ammoCount(s.refObjId), room = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
    const quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, room + Math.max(0, World.freeBagSlots() - 1) * offer.maxStack);
    if (quantity < 1) return skip(s, 'there is no bag space');
    if (gp.progression?.gold === undefined || toBigInt(offer.price) * BigInt(quantity) > toBigInt(gp.progression.gold)) return skip(s, 'not enough gold');
    if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, 'Town: refill ' + s.kind + 's')) t.pending = { ref: s.refObjId, before, quantity, at: now() };
  },
  buy() {
    const t = this.trip, gp = World.gp, shop = Restock.activeShop();
    if (!shop || shop.npc !== this.npc('vendor')?.gid || shop.error) return this.fail(shop?.error || 'Potion merchant selection changed.');
    if (!this.pendingDone(p => Restock.count(p.ref) >= p.before + p.quantity) || !this.trip || gp.inventoryPending) return;
    let s = t.supplies.find(s => Restock.count(s.refObjId) < s.target);
    if (!s) {
      // Refill held travel scrolls from gold offers only. Never buy from Item Mall.
      for (const type of [0x09ec, 0x19ec]) {
        const count = World.items().filter(i => (i.typeFlags & 0xfffc) === type).reduce((n, i) => n + (i.quantity ?? 1), 0);
        if (count >= 2) continue;
        const offer = shop.offers.find(o => (o.currency === undefined || o.currency === 1) &&
          (o.items || o.previews || []).some(i => i.refObjId === o.refObjId && (i.typeFlags & 0xfffc) === type) &&
          (!o.contents?.length || o.contents.length === 1 && o.contents[0].refObjId === o.refObjId && o.contents[0].quantity === 1));
        if (offer) { s = { kind: 'scroll', refObjId: offer.refObjId, target: Restock.count(offer.refObjId) + 2 - count }; break; }
        if (!count) return this.fail('Travel scrolls unavailable at this merchant. Carry spares.');
      }
    }
    if (!s) { this.enter('close-vendor'); return; }
    const offer = shop.offers.find(o => o.refObjId === s.refObjId && (s.kind === 'scroll' || Restock.offerKind(o) === s.kind));
    if (!offer || !(offer.maxStack > 0)) return this.fail(s.kind === 'scroll' ? 'Selected scroll is unavailable here.' : s.kind === 'cure' ? 'Special Universal Pill (small) is unavailable here.' : s.kind === 'vigor' ? 'The selected vigor potion size is unavailable here; choose another size in Supplies.' : 'X-Large ' + s.kind.toUpperCase() + ' potion is unavailable here.');
    const before = Restock.count(s.refObjId), room = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
    const quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, room + Math.max(0, World.freeBagSlots() - 1) * offer.maxStack);
    if (quantity < 1) return this.fail('Not enough bag space for refill and a spare transfer slot.');
    if (gp.progression?.gold === undefined || toBigInt(offer.price) * BigInt(quantity) > toBigInt(gp.progression.gold)) return this.fail('Not enough gold for potion refill.');
    if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, 'Town: refill ' + s.kind)) t.pending = { ref: s.refObjId, before, quantity, at: now() };
  },
  maximum(item) {
    const f = item.tooltip?.fields;
    if (!f || !Number.isFinite(f.varianceIntMin1c0) || !Number.isFinite(f.varianceIntMax1c4) || item.variance === undefined) return null;
    const base = Math.trunc((f.varianceIntMax1c4 - f.varianceIntMin1c0) * Number(toBigInt(item.variance) & 31n) / 31 + f.varianceIntMin1c0 + .5);
    if (!base) return 0;
    let pct = 0;
    for (const encoded of item.magic || []) {
      const bits = toBigInt(encoded), r = item.magicReferences?.find(r => r.paramId === Number(bits & 65535n)), amount = Number(bits >> 32n) & 0xffffffff;
      if (!r) continue;
      if (r.optionName === 'MATTR_DUR' && r.paramName.includes('+')) pct += amount;
      if (r.optionName === 'MATTR_DEC_MAXDUR' && r.paramName.includes('-')) pct -= amount;
      if (r.optionName === 'MATTR_NOT_REPARABLE' && r.paramName.includes('-')) pct += r.rangeWords?.[1] ?? 0;
    }
    return Math.max(1, base + Math.trunc(base * pct / 100));
  },
  damaged() {
    const result = [];
    for (const i of World.gp.inventory || []) {
      if (!ItemType.isEquipment(i.typeFlags) || i.durability === undefined) continue;
      if (!i.tooltip?.fields) throw Error('Missing equipment repair metadata.');
      if (!i.tooltip.fields.canRepair) continue;
      const max = this.maximum(i);
      if (max === null) throw Error('Missing equipment maximum durability.');
      if (i.durability < max) result.push({ slot: i.slot, ref: i.refObjId, max });
    }
    return result;
  },
  repair() {
    const t = this.trip, gp = World.gp;
    if (!Restock.activeShop() || gp.shop.npc !== this.npc('smith')?.gid) return this.fail('Smith selection changed.');
    if (!t.sent) {
      const damaged = this.damaged();
      if (!damaged.length) return this.enter('close-smith');
      if (Cmd.raw({ kind: 'shop-repair', mode: 2, slot: 0 }, 'Town: repair equipment')) { t.sent = true; t.repairs = damaged; }
      return;
    }
    if (gp.inventoryPending || now() - t.at < 1000) return;
    if (t.repairs.every(r => gp.inventory.some(i => i.slot === r.slot && i.refObjId === r.ref && i.durability >= r.max))) this.enter('close-smith');
    else if (now() - t.at > 15000) this.fail('Repairs were not confirmed. Check gold and repair restrictions.');
  },
  tick() {
    const c = this.cfg();
    this.watch();
    if (!this.trip) {
      if (this.blocked() || !this.reason()) return false;
      this.begin();
      if (!this.trip) return true;
    }
    const t = this.trip, gp = World.gp;
    if (!c.enabled || !Hunt.running || t.character !== World.charName || t.config !== JSON.stringify(c)) { this.fail('Settings or character changed during the trip.'); return true; }
    if (Manual.lastAt !== t.manualAt) { this.fail('Manual control interrupted the trip.'); return true; }
    // Movement may wait indefinitely for collision coverage. Individual service
    // and transaction phases still enforce their own confirmation timeouts.
    if (['recall-wait', 'reverse-wait', 'revive-arrival'].includes(t.phase) && now() - t.at > 90000) { this.fail('Scroll arrival timed out.'); return true; }
    if (!World.inWorld() || !gp?.pose || !World.local()) return true;
    if (World.isDead()) { this.fail('Character died during town service.'); return true; }
    if (['recall-wait', 'reverse-wait'].includes(t.phase) && this.checkScroll()) return true;
    if (t.phase === 'recall' && now() - t.at > 30000) { this.fail('Combat or inventory did not settle before departure.'); return true; }
    // Stopping combat is part of departure, not a best-effort side effect.
    // The initial move may hit Cmd.move's 550 ms rate limit or pending queue.
    // Retry it before waiting for a cast that the worker otherwise repeats.
    if (t.phase === 'recall' && (!t.haltSent || World.isCasting() && now() - t.haltAt >= 1500 && t.haltAttempts < 3)) {
      if (Cmd.move(World.pose())) { t.haltSent = true; t.haltAt = now(); t.haltAttempts++; }
      this.message = 'Town departure: stopping combat before using the return scroll.';
      return true;
    }
    // Arrival confirmation sends no command, so emergency potions cannot
    // keep the controller trapped in travel after the character has arrived.
    if (!['recall-wait', 'reverse-wait', 'revive-arrival'].includes(t.phase) && now() - Potion.lastUse < 350) return true;
    Hunt.state = 'restock';
    if (t.phase === 'recall') {
      if (World.isCasting() || gp.inventoryPending) {
        this.message = 'Town departure reserved; waiting for combat or inventory to settle.';
        return true;
      }
      if (World.isSitting()) { if (Cmd.spaced('action')) Cmd.action(1000); return true; }
      if (World.local()?.mountedOn) { this.fail('Dismount before starting town service.'); return true; }
      const scroll = this.scroll(0x09ec);
      if (!scroll) { this.fail('Return scroll missing.'); return true; }
      if (Cmd.itemUse(scroll.slot)) this.sentScroll(scroll, 'recall-wait');
    } else if (t.phase === 'revive-arrival') {
      if (!gp.inventoryPending && !gp.returnScroll && dist2D(World.pose(), c.arrival) <= clamp(Number(c.arrivalRadius) || 500, 100, 1500)) this.arrived();
      else this.message = 'Waiting for revival at the saved town arrival area.';
    } else if (['recall-wait', 'reverse-wait'].includes(t.phase)) {
      const radius = t.phase === 'recall-wait' ? clamp(Number(c.arrivalRadius) || 500, 100, 1500) : 300;
      // The scroll always lands on the same spot. If the saved arrival point is not it (saved where you happened to
      // stand, say), adopt the spot the character settled on after a confirmed trip, but only in the saved services' town.
      if (t.phase === 'recall-wait' && t.transition && dist2D(World.pose(), c.arrival) > radius && !gp.inventoryPending && !gp.returnScroll) {
        const here = World.pose(), town = this.detect(here), saved = this.detect(c.vendor || c.storage || c.arrival);
        if (!town || !saved || town.key !== saved.key) t.landed = null;
        else if (!t.landed || dist2D(t.landed.pose, here) > 3) t.landed = { pose: { ...here }, at: now() };
        else if (now() - t.landed.at >= 3000) {
          c.arrival = { ...here }; t.config = JSON.stringify(c); t.landed = null; Settings.saveProfile();
          Log.info('Town arrival point updated to where the return scroll landed.');
        }
      }
      const dest = t.phase === 'recall-wait' ? c.arrival : t.origin;
      const distance = dist2D(World.pose(), dest);
      // After death the game's last scroll point need not equal the saved
      // hunt center (or an older remembered scroll point). Accept the saved
      // hunting area too, but only after confirmed, settled world travel.
      const inHuntArea = t.phase === 'reverse-wait' && t.revival && t.huntArea &&
        dist2D(World.pose(), t.huntArea.center) <= t.huntArea.radius;
      if (t.transition && (distance <= radius || inHuntArea) && !gp.inventoryPending && !gp.returnScroll) {
        if (t.phase === 'recall-wait') { this.lastScrollPoint = { ...t.origin }; this.arrived(); }
        else {
          if (t.reverseChoice !== TOWN_REVERSE.death) this.lastScrollPoint = { ...World.pose() };
          this.trip = null; Hunt.targetGid = Hunt.lootGid = 0; Hunt.state = 'search'; this.restartClocks();
          this.message = 'Town service complete; hunting resumed.'; UI.toast(this.message);
        }
      } else {
        this.message = !t.transition ? (t.scrollRequest?.accepted ? 'Scroll accepted by game; waiting for travel.' : 'Waiting for game to accept the scroll request.') : gp.inventoryPending || gp.returnScroll
          ? 'Waiting for scroll arrival state to settle.'
          : 'Waiting for arrival area: ' + (Number.isFinite(distance) ? Math.round(distance / 10) + ' m from saved point; tolerance ' + Math.round(radius / 10) + ' m.' : 'saved point is in another world.');
      }
    } else if (t.phase.startsWith('walk-')) {
      const role = t.phase.slice(5);
      if (this.walk(c[role]) && this.trip) this.enter('open-' + role);
    } else if (t.phase.startsWith('open-')) {
      const role = t.phase.slice(5), kind = role === 'storage' ? 'storage-open' : role === 'gate' ? 'npc-talk' : 'shop-open';
      if (this.open(role, kind) && this.trip) this.enter({ storage: 'store', vendor: 'buy', smith: 'sell', gate: 'reverse' }[role]);
    } else if (t.phase === 'store') this.store();
    else if (t.phase === 'buy') this.buy();
    else if (t.phase === 'sell') this.sell();
    else if (t.phase === 'ammo') this.ammo();
    else if (t.phase === 'repair') this.repair();
    else if (t.phase.startsWith('close-')) {
      if (now() - t.at > 15000) this.fail('NPC window did not close.');
      else this.close(this.closeNext(t.phase));
    } else if (t.phase === 'reverse') {
      if (t.recovery) {
        this.trip = null;
        Hunt.stop('Recovery town services completed. Check the hunting spot before returning.');
        return true;
      }
      if (gp.inventoryPending || World.isCasting()) return true;
      if (t.supplies.some(s => Restock.count(s.refObjId) < s.target) || this.damaged().length || !t.revival && !this.scroll(0x09ec) || !this.scroll(0x19ec)) { this.fail('Final supply, repair or travel-scroll check failed.'); return true; }
      if (World.freeBagSlots() <= 1) { this.fail('Returned to town; free at least two character bag slots before hunting again.'); return true; }
      const npc = this.npc('gate');
      if (!npc || gp.target !== npc.gid || !(gp.targetCapabilities & 0x20000000)) { this.fail('Reverse-return teleport NPC unavailable.'); return true; }
      const scroll = this.scroll(0x19ec);
      if (Cmd.raw({ kind: 'travel-gate', gid: npc.gid, type: 5, target: t.reverseChoice }, t.reverseChoice === TOWN_REVERSE.death ? 'Town: reverse to death location' : 'Town: reverse to last return-scroll point')) this.sentScroll(scroll, 'reverse-wait');
    }
    return true;
  },
};


// Auto stall: open the character's own street stall in town and sell bag items at prices you set per item
// (like sBot's stall). The worker contract, read from the live client: stall-name enters a local naming phase,
// stall-create {title, greeting} opens the stall (phase 'owner'), stall-add {slot, bagSlot, quantity, price}
// registers an offer while the stall is still closed, stall-open {open, network} opens it for business and can
// list it on the stall network, stall-close tears it down. World.gp.stall is undefined while no stall is open,
// otherwise { phase: 'none'|'naming'|'owner'|'visitor', owner, title, open, offers: [{slot, item, bagSlot,
// quantity, price}], visitors }. A sale shows as the offer disappearing while gold rises; a dispatch is never
// proof, every step waits for its state change and is never resent.
const STALL_MAX_OFFERS = 10;
const STALL_STEP_TIMEOUT_MS = 15000;
const Stall = {
  run: null, pending: null, message: 'Idle. Price items on this page, stand in town and open the stall.',
  started: false,
  cfg() { return Settings.profile.stall; },
  // A price entry is the offer rule for that exact item id; 0 or invalid clears it.
  price(id) { const p = Number(this.cfg().prices?.[id]); return Number.isInteger(p) && p >= 1 && p <= 4294967295 ? p : 0; },
  setPrice(id, price) {
    const prices = this.cfg().prices;
    if (Number.isInteger(price) && price >= 1 && price <= 4294967295) prices[id] = price;
    else delete prices[id];
    Settings.saveProfile();
  },
  stall() { const s = World.gp?.stall; return s && s.phase !== 'none' ? s : null; },
  offers() { return this.stall()?.phase === 'owner' ? this.stall().offers || [] : []; },
  // Bag items with a price that are not already offered or skipped. A price is explicit intent, so the general
  // loot protections do not apply; stackables offer their whole stack, equipment one piece.
  candidates(r = this.run) {
    const offered = new Set(this.offers().map(o => o.bagSlot)), skip = r ? r.skip : new Set();
    return World.items().filter(i => !offered.has(i.slot) && !skip.has(i.slot) && this.price(i.refObjId) > 0);
  },
  // ownStall: the session's own stall is expected mid-run; only a fresh start refuses any open stall.
  blocked(ownStall = false) {
    const gp = World.gp;
    if (!World.inWorld() || !gp || !World.local()) return 'Enter the game world first.';
    if (World.isDead()) return 'Stall stopped: character died.';
    if (Alchemy.run || Alchemy.pending) return 'Stop alchemy and wait for its result first.';
    if (BuffGear.run || BuffGear.recovery) return 'Restore or review combat gear first.';
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || Controller.resumeAfterRevive) return 'Stop hunting, travel and route recording first.';
    if (Loot.active) return 'Stop collection and wait for its inventory transaction first.';
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting) return 'Close shop, storage and trade first.';
    if (!ownStall && gp.stall?.phase && gp.stall.phase !== 'none') return 'Close the open stall first.';
    if (World.isCasting() || gp.pendingMoves) return 'Wait for casts and movement to finish.';
    return '';
  },
  start() {
    if (this.run) return;
    const gp = World.gp, error = this.blocked();
    const reject = text => { this.message = text; UI.toast(text, 'warn'); };
    if (error) return reject(error);
    if (gp.inventoryPending) return reject('Wait for settled inventory state.');
    if (World.isSitting()) return reject('Stand up first.');
    if (!Town.detect()) return reject('Stalls open in town only: stand inside one of the known towns.');
    const c = this.cfg();
    const list = this.candidates();
    if (!list.length) return reject('No priced bag items to offer. Give items a price on this page first.');
    this.run = { phase: 'name', character: World.charName, config: JSON.stringify(c), manualAt: Manual.lastAt,
      skip: new Set(), refusals: 0, sold: 0, earned: 0n, openedAt: 0, lastGold: toBigInt(gp.progression?.gold), offersAt: null };
    this.pending = null;
    this.message = 'Opening the stall.';
    Activity.emit({ category: 'stall', code: 'stall-started', text: 'Stall session started: offering ' + list.length + ' priced item' + (list.length === 1 ? '' : 's') + '.', outcome: 'requested' });
  },
  // Stop the session. A stall this session opened is closed again (only when the observed state still shows it,
  // so a world reset never sends a command the worker would refuse); `quiet` drops it without any command.
  stop(reason = 'Stall session stopped.', quiet = false) {
    const r = this.run; this.run = null; this.pending = null;
    this.message = reason;
    if (!r) return;
    if (r.phase === 'done') return;
    Activity.emit({ category: 'stall', code: 'stall-stopped', level: 'warn', text: reason, outcome: 'cancelled' });
    if (quiet) return;
    const phase = World.gp?.stall?.phase;
    if (phase === 'naming') Cmd.raw({ kind: 'stall-name-cancel' }, 'Stall: cancel naming');
    else if (phase === 'owner' && World.inWorld()) Cmd.raw({ kind: 'stall-close' }, 'Stall: close our stall');
  },
  finish(text, code = 'stall-closed') {
    const r = this.run; this.run = null; this.pending = null;
    this.message = text;
    Activity.emit({ category: 'stall', code, text, outcome: 'summary', details: { sold: r.sold, earned: String(r.earned) } });
  },
  fail(text) { Log.warn('Stall: ' + text); this.stop(text); },
  // The next free stall slot, 1-based; the server keeps its own limit and refuses beyond it.
  freeSlot() {
    const used = new Set(this.offers().map(o => o.slot));
    for (let slot = 1; slot <= STALL_MAX_OFFERS; slot++) if (!used.has(slot)) return slot;
    return 0;
  },
  // A confirmed step observes its state change; on timeout the step is skipped (an offer) or fails the session,
  // and no command is ever resent.
  confirmPending(gp) {
    const p = this.pending;
    if (!p) return true;
    if (now() - p.at > STALL_STEP_TIMEOUT_MS) {
      this.pending = null;
      if (p.kind === 'add') {
        this.run.skip.add(p.bagSlot); this.run.refusals++;
        this.message = 'Stall: one item was not registered; skipping it.';
        return false;
      }
      this.fail('Stall: ' + p.kind + ' was not confirmed after 15 s. No repeat command sent.');
      return false;
    }
    if (gp.inventoryPending || now() - p.at < 500) return false;
    const stall = gp.stall;
    if (p.kind === 'name') { if (stall?.phase === 'naming') { this.pending = null; return true; } return false; }
    if (p.kind === 'create') {
      if (stall?.phase === 'owner' && stall.owner === gp.localGid) { this.pending = null; return true; }
      return false;
    }
    if (p.kind === 'add') {
      if ((stall?.offers || []).some(o => o.bagSlot === p.bagSlot && o.slot === p.slot)) {
        this.pending = null; this.run.refusals = 0;
        Activity.emit({ category: 'stall', code: 'stall-offer', text: 'Stall: ' + p.name + ' registered at ' + p.price.toLocaleString('en-US') + ' gold.', outcome: 'confirmed', details: { refObjId: p.ref, quantity: p.quantity, price: p.price } });
        return true;
      }
      return false;
    }
    if (p.kind === 'open') { if (stall?.open) { this.pending = null; return true; } return false; }
    if (p.kind === 'close') { if (!stall) { this.pending = null; return true; } return false; }
    return false;
  },
  send(kind, command, label, extra = {}) {
    if (!Cmd.spaced(command.kind) || !Cmd.raw(command, 'Stall: ' + label)) return false;
    this.pending = { kind, at: now(), ...extra };
    return true;
  },
  // A sale: an offer disappears while gold rises. Nothing else moves gold while the session owns the character,
  // so an offer vanishing without a gold gain is not claimed as a sale.
  observeSales(r, gp) {
    const stall = gp.stall;
    if (!stall || stall.phase !== 'owner') return;
    const gold = toBigInt(gp.progression?.gold);
    if (r.offersAt === null) { r.offersAt = stall.offers.map(o => ({ ...o })); r.lastGold = gold; return; }
    const before = r.offersAt, after = stall.offers;
    for (const old of before) {
      const kept = after.find(o => o.slot === old.slot);
      const quantity = old.quantity - (kept ? Math.min(kept.quantity, old.quantity) : 0);
      if (quantity <= 0 || gold <= r.lastGold) continue;
      const value = BigInt(old.price) * BigInt(quantity);
      r.sold += quantity; r.earned += value;
      r.saleNoteAt = now();
      this.message = 'Sold ' + quantity + ' × ' + (old.item?.name || Items.name(old.item?.refObjId) || 'item') + ' for ' + value.toLocaleString('en-US') + ' gold.';
      Activity.emit({ category: 'stall', code: 'stall-sale', text: this.message, outcome: 'confirmed',
        details: { refObjId: old.item?.refObjId, quantity, price: old.price, slot: old.slot } });
    }
    r.offersAt = after.map(o => ({ ...o }));
    r.lastGold = gold;
  },
  watchSelling(r, gp) {
    this.observeSales(r, gp);
    const stall = gp.stall;
    if (!stall || stall.phase !== 'owner') return this.finish('The stall closed. Sold ' + r.sold + ' item' + (r.sold === 1 ? '' : 's') + ' for ' + r.earned.toLocaleString('en-US') + ' gold.');
    if (r.phase !== 'selling') return;
    const offers = stall.offers || [];
    // A sale line stays up briefly instead of being stamped over by the rolling status.
    if (!r.saleNoteAt || now() - r.saleNoteAt > 5000)
      this.message = 'Stall open: ' + offers.length + ' offer' + (offers.length === 1 ? '' : 's') + ' left' +
        (stall.visitors?.length ? ', ' + stall.visitors.length + ' browsing' : '') +
        (r.sold ? '; sold ' + r.sold + ' for ' + r.earned.toLocaleString('en-US') + ' gold.' : '.');
    if (!offers.length && this.cfg().closeWhenEmpty) {
      r.phase = 'close';
      if (!r.saleNoteAt || now() - r.saleNoteAt > 5000) this.message = 'Everything sold; closing the stall.';
    }
  },
  tick() {
    const r = this.run, gp = World.gp;
    if (!r) return false;
    if (!World.inWorld()) { this.stop('Stall stopped: left the game world.'); return true; }
    if (!this.confirmPending(gp)) { if (this.run && ['selling', 'close'].includes(this.run.phase)) this.watchSelling(this.run, gp); return true; }
    if (!this.run) return true; // the confirmation itself may have ended the session
    const blocked = this.blocked(true);
    if (blocked || r.character !== World.charName || r.manualAt !== Manual.lastAt || r.config !== JSON.stringify(this.cfg()))
      return this.fail(blocked || 'Stall stopped: settings, character or manual control changed.'), true;
    if (World.isDead()) return this.fail('Stall stopped: character died.'), true;
    const stall = gp.stall;
    if (stall?.phase === 'visitor') return this.fail('Stall stopped: browsing another stall.'), true;
    if (r.phase === 'name') {
      this.message = 'Stall: naming the stall.';
      if (!stall || stall.phase === 'none') this.send('name', { kind: 'stall-name' }, 'begin naming');
      else if (stall.phase === 'naming') r.phase = 'create';
      return true;
    }
    if (r.phase === 'create') {
      this.message = 'Stall: opening the stall.';
      if (stall?.phase === 'owner' && stall.owner === gp.localGid) {
        r.phase = 'add';
        Activity.emit({ category: 'stall', code: 'stall-created', text: 'Stall created: ' + (stall.title || 'unnamed') + '.', outcome: 'confirmed' });
      }
      else if (stall?.phase === 'naming') this.send('create', { kind: 'stall-create', title: this.cfg().title || World.charName || 'Stall', greeting: this.cfg().greeting || '' }, 'create the stall');
      else r.phase = 'name'; // the naming phase was lost; start over
      return true;
    }
    if (r.phase === 'add') {
      if (r.refusals >= 2) { r.phase = 'open'; return true; }
      const item = this.nextCandidate(r), slot = this.freeSlot();
      if (!item || !slot) { r.phase = 'open'; return true; }
      const price = this.price(item.refObjId), quantity = Math.max(1, item.quantity || 1), name = item.name || Items.name(item.refObjId);
      this.message = 'Stall: registering ' + name + '.';
      this.send('add', { kind: 'stall-add', slot, bagSlot: item.slot, quantity, price }, 'offer ' + name,
        { slot, bagSlot: item.slot, quantity, price, ref: item.refObjId, name });
      return true;
    }
    if (r.phase === 'open') {
      if (stall?.open) {
        r.phase = 'selling'; r.openedAt = now(); r.offersAt = null;
        Activity.emit({ category: 'stall', code: 'stall-opened', text: 'Stall open for business with ' + (stall.offers?.length || 0) + ' offer' + ((stall.offers?.length || 0) === 1 ? '' : 's') + '.', outcome: 'confirmed' });
        return true;
      }
      if (!this.offers().length) return this.fail('Stall: nothing could be registered.');
      this.message = 'Stall: opening for business.';
      this.send('open', { kind: 'stall-open', open: true, network: !!this.cfg().network }, 'open for business');
      return true;
    }
    if (r.phase === 'selling') { this.watchSelling(r, gp); return true; }
    if (r.phase === 'close') {
      if (!stall) return this.finish('Stall closed. Sold ' + r.sold + ' item' + (r.sold === 1 ? '' : 's') + ' for ' + r.earned.toLocaleString('en-US') + ' gold.'), true;
      this.message = 'Stall: closing.';
      this.send('close', { kind: 'stall-close' }, 'close the stall');
      return true;
    }
    return true;
  },
  nextCandidate(r) {
    for (const item of this.candidates(r)) {
      if (this.offers().some(o => o.bagSlot === item.slot)) continue;
      return item;
    }
    return null;
  },
  init() {
    if (this.started) return; this.started = true;
    // Any manual native gameplay command can interfere with the stall; our own Cmd.raw bypasses these observers.
    Hook.observers.push(command => { if (command.kind === 'gameplay' && this.run) this.stop('Stall stopped by manual game control.'); });
    bus.on('game-error', text => { if (this.run && /stall|inventory/i.test(String(text))) this.stop('Stall stopped after a game refusal; wait for the state to settle.'); });
    // A world reset clears the stall server-side too; drop the session without sending anything.
    bus.on('reset', () => this.stop('Stall stopped after world reset.', true));
  },
  status() {
    const r = this.run, stall = this.stall();
    if (r) return this.message;
    if (stall?.phase === 'owner') return 'A stall of yours is open in the game; the bot is not managing it.';
    if (stall?.phase === 'visitor') return 'You are browsing another player\'s stall.';
    if (stall?.phase === 'naming') return 'A stall is being named in the game.';
    return this.message;
  },
  draw() {
    const c = () => this.cfg();
    const setup = UI.group('Stall',
      UI.text('Stall name', () => c().title, v => c().title = v, 'defaults to your character name'),
      UI.text('Greeting', () => c().greeting, v => c().greeting = v, 'shown to visitors'),
      UI.check('List the stall on the stall network', () => c().network, v => c().network = v),
      UI.check('Close when everything is sold', () => c().closeWhenEmpty, v => c().closeWhenEmpty = v),
      UI.row(UI.button('Open stall', () => this.start()), UI.button('Stop stall', () => this.stop())),
      el('p', 'Opens your street stall where you stand and offers every priced bag item from this page. Works in town only, while hunting, travel and alchemy are stopped: the stall keeps the character in place. Each offer sells the whole stack at your price. Sold items are confirmed by the offer disappearing and gold arriving; a step the game does not confirm is skipped, never resent. Stop (or F8) closes a stall this page opened.', 'muted'));
    UI.stallNote = el('p', this.status(), 'muted'); setup.append(UI.stallNote);
    UI.pane.append(setup);
    const prices = UI.group('Items and prices');
    const entries = Object.entries(c().prices);
    if (!entries.length) prices.append(el('div', 'No prices set. Add items from your bag below.', 'empty'));
    for (const [id, price] of entries) {
      const item = Number(id), name = Items.name(item) || ('#' + item);
      const inBag = World.items().filter(i => i.refObjId === item).reduce((n, i) => n + (i.quantity ?? 1), 0);
      const remove = UI.button('×', () => { this.setPrice(item, 0); UI.draw(); });
      remove.className = 'mini'; remove.setAttribute('aria-label', 'Stop selling ' + name);
      prices.append(UI.row(
        el('span', name + (inBag ? ' · ' + inBag + ' in bag' : ' · not in bag'), 'item-name'),
        UI.number(name + ' price (gold)', () => price, v => this.setPrice(item, v), 1, 4294967295),
        remove));
    }
    const unnamed = [...new Map(World.items().filter(i => this.price(i.refObjId) === 0 && i.tooltip?.fields?.canSell !== 0).map(i => [i.refObjId, i])).values()];
    if (unnamed.length) prices.append(UI.select('Add a bag item to sell', () => [[0, 'Choose an item'], ...unnamed.map(i => [i.refObjId, (i.name || Items.name(i.refObjId)) + ' ×' + (i.quantity ?? 1)])],
      () => 0, v => { const id = Number(v); if (id) { this.setPrice(id, 100); UI.draw(); } }));
    prices.append(el('p', 'Prices are per exact item and saved with this character, so the same drop sells at the same price on the next stall. A new entry starts at 100 gold; change it to what the item is worth. Items the merchant cannot sell are not offered. Items already in a stall you keep open in the game are left alone.', 'muted'));
    UI.pane.append(prices);
  },
  refresh() {
    if (!UI.is('Stall') || !UI.stallNote) return;
    UI.stallNote.textContent = this.status();
  },
};


// Confirm every native inventory move before casting or restoring combat gear.
const BuffGear = {
  run: null, recovery: null, message: 'Buff weapon swapping off.', skipped: new Map(), waiting: '', started: false,
  cfg() { return Settings.profile.macro; },
  items() { return World.gp?.inventory || []; },
  at(slot) { return this.items().find(i => i.slot === slot) || null; },
  key(i) { return i ? JSON.stringify([i.refObjId, i.typeFlags, i.plus ?? 0, i.variance ?? null, i.magic ?? null]) : null; },
  weapon(i) { return i && (i.typeFlags & 0x7e) === 0x2c && (i.typeFlags >>> 7 & 15) === 6; },
  shield(i) { return i && (i.typeFlags & 0x1e) === 0x0c && (i.typeFlags >>> 7 & 15) === 4; },
  find(key) {
    if (!key) return null;
    const matches = this.items().filter(i => this.key(i) === key);
    return matches.length === 1 ? matches[0] : null;
  },
  setup() { return { weapon: this.key(this.at(6)), shield: this.key(this.at(7)) }; },
  matches(set) { return set.weapon === this.key(this.at(6)) && set.shield === this.key(this.at(7)); },
  signature() { return JSON.stringify([this.cfg().buffSwap, this.cfg().buffSets, this.cfg().buffs]); },
  init() {
    if (this.started) return;
    this.started = true;
    Hook.observers.push(command => {
      if (command.kind === 'gameplay' && command.command?.kind === 'inventory-move' && this.run) this.fail('Manual equipment move interrupted buff swaps.');
    });
    bus.on('cast', c => {
      const p = this.run?.cast;
      if (p && c.caster === World.localGid() && c.skill === p.id && !c.resultOnly && c.cancelledAtMs === undefined) p.accepted = true;
    });
  },
  save(name) {
    if (this.run || this.recovery || Hunt.running || World.gp?.inventoryPending || !World.inWorld()) return UI.toast('Stop hunting and settle gear restoration first.', 'warn');
    const set = this.setup();
    if (!this.weapon(this.at(6)) || this.at(7) && !this.shield(this.at(7))) return UI.toast('Equip a buff weapon and an optional shield first. Remove arrows or bolts from the off-hand slot.', 'warn');
    if (!this.find(set.weapon) || set.shield && !this.find(set.shield)) return UI.toast('Identical gear cannot be distinguished. Keep only one matching copy.', 'warn');
    const sets = this.cfg().buffSets;
    if (sets.length >= 8) return UI.toast('Up to eight buff sets can be saved.', 'warn');
    sets.push({ ...set, id: Math.max(0, ...sets.map(s => Number(s.id) || 0)) + 1, name: String(name || 'Buff set').trim().slice(0, 40) || 'Buff set' });
    Settings.saveProfile(); UI.draw();
  },
  reset() {
    this.run = this.recovery = null; this.skipped.clear();
    this.message = 'Buff gear reset. Check equipped weapons after reconnecting.';
  },
  interrupt(text) {
    if (this.run) this.fail(text);
  },
  fail(text) {
    if (this.run) this.recovery = this.run.home;
    this.run = null;
    if (Hunt.running && World.inWorld() && !World.isDead()) Hunt.stop(text);
    else Hunt.running = false;
    this.message = text + ' Check gear or use Restore combat gear.';
    UI.toast(this.message, 'warn');
  },
  cancel() {
    if (!this.run) return;
    this.run.restoring = true; this.run.queue = []; this.run.cancelled = true;
    this.message = 'Stopping buffs; restoring combat gear.';
  },
  restore() {
    if (this.run || !this.recovery || !World.inWorld() || World.isDead() || World.gp?.inventoryPending || World.isCasting()) return;
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Alchemy.run || Alchemy.pending) return UI.toast('Stop hunting and travel before restoring gear.', 'warn');
    this.run = this.create(this.recovery, []); this.run.restoring = true; this.recovery = null;
  },
  create(home, queue) {
    return { home, queue, restoring: false, pending: null, cast: null, effects: [],
      at: now(), manualAt: Manual.lastAt, character: World.charName, profile: Settings.profile, signature: this.signature() };
  },
  due(b) {
    if (!b.enabled || !b.gearSet) return 0;
    const id = Combat.resolve(b), info = World.skill(id);
    if (!id || !info || info.targetRequired || Combat.blocked(id) || !Cmd.canCast(id) || !Combat.mpOk(id, World.me())) return 0;
    const skip = this.skipped.get(b.group);
    if (skip) { if (skip.signature === this.signature() && now() < skip.until) return 0; this.skipped.delete(b.group); }
    const remaining = World.buffRemaining(id);
    if (remaining > (b.refreshS ?? 3) * 1000) return 0;
    const gap = Math.max(4000, Math.min((info?.durationMs || 20000) * .85, 600000));
    return now() - (Combat.buffCastAt.get(b.group) ?? -Infinity) >= gap ? id : 0;
  },
  begin() {
    if (!this.cfg().buffSwap || this.recovery || !Hunt.running || !World.inWorld() || World.isDead() ||
        Combat.busy() || World.isSitting() || World.local()?.mountedOn || World.gp?.inventoryPending ||
        World.gp?.pendingMoves || World.gp?.returnScroll || now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ||
        Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || now() < Resurrect.holdUntil ||
        Restock.activeShop() || World.gp?.storage || World.gp?.exchange?.open || World.gp?.exchange?.requesting || World.gp?.stall?.phase && World.gp.stall.phase !== 'none' ||
        Alchemy.run || Alchemy.pending || Loot.active && !Loot.active.petGid || Loot.pressed()) return false;
    const queue = [];
    for (const set of this.cfg().buffSets) {
      const buffs = this.cfg().buffs.filter(b => Number(b.gearSet) === set.id).map(b => ({ b, id: this.due(b) })).filter(b => b.id);
      if (buffs.length) queue.push({ set, buffs });
    }
    if (!queue.length) { this.waiting = ''; return false; }
    // A buff is due, so say why the swap cannot start instead of waiting silently.
    const wait = text => { this.waiting = text; return false; };
    const home = this.setup();
    if (!this.weapon(this.at(6))) return wait('Equip your combat weapon before hunting.');
    for (const set of [home, ...queue.map(q => q.set)]) {
      const name = set === home ? 'your combat gear' : 'the saved set "' + set.name + '"';
      if (!this.find(set.weapon)) return wait(`Cannot find ${name}: its weapon is not in your bag or equipped (or two copies look identical). Save the buff set again.`);
      if (!this.weapon(this.find(set.weapon))) return wait(`${name} is not a weapon any more. Save the buff set again.`);
      if (set.shield && (!this.find(set.shield) || set !== home && !this.shield(this.find(set.shield)))) return wait(`Cannot find the shield of ${name} (or two copies look identical). Save the buff set again.`);
    }
    // One free bag slot permits explicit shield removal before two-handed swaps.
    if (World.freeBagSlots() < 1) return wait('Buff swaps need one free bag slot.');
    this.waiting = '';
    if (!Cmd.move(World.pose())) return false;
    Loot.suspend(); Hunt.state = 'buff'; this.run = this.create(home, queue);
    this.message = 'Pausing combat for buff gear.';
    return true;
  },
  move(source, destination) {
    const r = this.run, from = this.key(this.at(source)), to = this.key(this.at(destination));
    if (!from || !Cmd.spaced('inventory-move')) return;
    if (Cmd.raw({ kind: 'inventory-move', source, destination, quantity: 0 }, 'Buff gear: move equipment')) {
      r.pending = { source, destination, from, to, at: now() };
    }
  },
  equip(set) {
    if (this.matches(set)) return true;
    const weapon = this.find(set.weapon), shield = this.find(set.shield);
    if (!weapon || !this.weapon(weapon) || set.shield && (!shield || set !== this.run.home && !this.shield(shield))) { this.fail('Required equipment missing or ambiguous.'); return false; }
    if (this.at(7) && this.key(this.at(7)) !== set.shield) {
      const gp = World.gp;
      let empty = -1;
      for (let slot = gp.equipmentSlotCount || 13; slot < gp.inventorySlotCount; slot++) if (!this.at(slot)) { empty = slot; break; }
      if (empty < 0) { this.fail('No bag space to remove the off-hand item.'); return false; }
      this.move(7, empty); return false;
    }
    if (weapon.slot !== 6) { this.move(weapon.slot, 6); return false; }
    if (shield && shield.slot !== 7) { this.move(shield.slot, 7); return false; }
    return false;
  },
  tick() {
    if (!this.run) return this.begin();
    const r = this.run, gp = World.gp;
    if (r.character !== World.charName || r.profile !== Settings.profile) { this.reset(); return false; }
    if (!World.inWorld() || World.isDead()) { this.interrupt('World change or death interrupted buff swaps.'); return false; }
    if (Manual.lastAt !== r.manualAt) { this.fail('Manual control interrupted buff swaps.'); return true; }
    if (now() - r.at > 120000) { this.fail('Buff gear cycle timed out.'); return true; }
    if (!Hunt.running || r.signature !== this.signature()) this.cancel();
    if (r.pending) {
      const p = r.pending;
      if (!gp.inventoryPending && this.key(this.at(p.destination)) === p.from && this.key(this.at(p.source)) === p.to) r.pending = null;
      else { if (now() - p.at > 15000) this.fail('Equipment move unconfirmed; no retry sent.'); return true; }
    }
    if (r.cast) {
      const p = r.cast, remaining = World.buffRemaining(p.id);
      if (remaining > 0) { p.accepted = true; p.visible = true; }
      if (now() < p.until || World.isCasting()) return true;
      if (!p.accepted) { if (now() - p.at > 10000) { this.skipped.set(p.group, { signature: r.signature, until: now() + 120000, why: 'the cast was not confirmed, trying again in two minutes' }); this.cancel(); this.message = 'Buff cast unconfirmed; restoring combat gear.'; r.cast = null; } return true; }
      r.effects.push(p); r.cast = null;
    }
    if (Combat.busy() || gp.inventoryPending || World.isSitting() || World.local()?.mountedOn || Loot.pressed()) return true;
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting || gp.stall?.phase && gp.stall.phase !== 'none' || gp.returnScroll) { this.fail('Buff swaps interrupted by another game action.'); return true; }
    if (r.restoring || !r.queue.length) {
      this.message = 'Restoring combat gear.';
      if (!this.equip(r.home)) return true;
      if (!r.restoredAt) { r.restoredAt = now(); return true; }
      if (now() - r.restoredAt < 1000) return true;
      for (const p of r.effects) if (p.visible && World.buffRemaining(p.id) <= 0) {
        this.skipped.set(p.group, { signature: r.signature, until: Infinity, why: 'it ended when the weapon changed back, so it stays with your combat weapon until buff settings change' });
        this.message = 'A buff ended after changing weapons; skipped until buff settings change.';
      }
      if (this.message === 'Restoring combat gear.') this.message = 'Combat gear restored.';
      this.run = null; this.recovery = null; return true;
    }
    const q = r.queue[0];
    this.message = 'Equipping ' + q.set.name + ' for buffs.';
    if (!this.equip(q.set)) return true;
    const entry = q.buffs[0];
    if (!entry) { r.queue.shift(); return true; }
    if (!this.due(entry.b)) { q.buffs.shift(); return true; }
    if (Combat.cast(entry.id, 0)) {
      Combat.buffCastAt.set(entry.b.group, now()); q.buffs.shift();
      r.cast = { id: entry.id, group: entry.b.group, at: now(), until: now() + Math.max(1000, World.skill(entry.id)?.actionMs || 6000) + 500, accepted: false, visible: false };
      this.message = 'Casting buff; waiting before changing weapons.';
    }
    return true;
  },
  // The buffs assigned to a saved set that are on, with how long each has left.
  assigned() {
    return this.cfg().buffs.filter(b => b.enabled && Number(b.gearSet) && this.cfg().buffSets.some(s => s.id === Number(b.gearSet))).map(b => {
      const id = Combat.resolve(b);
      return { name: World.skillName(id || b.id), left: id ? World.buffRemaining(id) : 0, learned: !!id && World.learned(id), skip: this.skipped.get(b.group) };
    });
  },
  status() {
    if (this.run || this.recovery) return this.message;
    if (!this.cfg().buffSwap) return 'Buff weapon swapping off.';
    const sets = this.cfg().buffSets, list = this.assigned();
    if (!sets.length) return 'Buff weapon swapping is on, but no buff set is saved yet. Equip the buff weapon and press Save equipped buff set.';
    if (!list.length) return 'Buff weapon swapping is on, but no buff skill is assigned to a set yet. Use Gear for <skill> under your buffs.';
    const lines = [];
    for (const a of list) {
      if (!a.learned) lines.push(`${a.name}: not learned on this character, so it is never cast.`);
      else if (a.skip && a.skip.signature === this.signature() && now() < a.skip.until) lines.push(`${a.name}: skipped because ${a.skip.why}.`);
      else if (a.left > 0) lines.push(`${a.name}: active, ${Math.ceil(a.left / 1000)} s left; the swap happens when it is about to end.`);
      else lines.push(`${a.name}: due now.`);
    }
    return (this.waiting ? this.waiting + '\n' : '') + lines.join('\n');
  },
  draw(parent) {
    const box = UI.group('Buff weapon sets');
    box.append(UI.check('Swap weapons for assigned buffs', () => this.cfg().buffSwap, v => this.cfg().buffSwap = v),
      el('p', 'Equip a buff weapon and optional shield, save the set, then put your combat gear back on. Assign each buff below to its set. Multiple sets run in turn while hunting; original combat gear is restored afterward. Keep one bag slot free. Buffs tied to the removed weapon may end.', 'muted'));
    const name = el('input'); name.type = 'text'; name.maxLength = 40; name.value = 'Buff set ' + (this.cfg().buffSets.length + 1);
    box.append(UI.field('New buff set name', name), UI.button('Save equipped buff set', () => this.save(name.value)));
    for (const set of this.cfg().buffSets) {
      const weapon = this.find(set.weapon), shield = this.find(set.shield);
      box.append(UI.row(el('span', set.name + ': ' + (weapon?.name || (weapon ? 'Weapon +' + (weapon.plus || 0) : 'weapon missing / ambiguous')) + (set.shield ? shield ? ' + shield' : ' + shield missing / ambiguous' : '')),
        UI.button('Remove ' + set.name, () => {
          if (this.run || this.recovery) return UI.toast('Restore combat gear before editing sets.', 'warn');
          this.cfg().buffSets = this.cfg().buffSets.filter(s => s.id !== set.id);
          for (const b of this.cfg().buffs) if (Number(b.gearSet) === set.id) b.gearSet = 0;
          Settings.saveProfile(); UI.draw();
        })));
    }
    box.append(UI.button('Restore combat gear', () => this.restore()), UI.button('Use current gear', () => {
      if (this.run || World.gp?.inventoryPending) return UI.toast('Wait for the current equipment move to settle.', 'warn');
      this.recovery = null; this.message = 'Current gear accepted. Review it before hunting.';
    }));
    this.note = el('p', this.status(), 'muted'); box.append(this.note); parent.append(box);
  },
};
const normalBuffs = Combat.buffs;
Combat.buffs = function (hunting) {
  // Assigned buffs are owned exclusively by the gear cycle, including when off.
  const original = Settings.profile.macro.buffs;
  Settings.profile.macro.buffs = original.filter(b => !b.gearSet);
  try { return normalBuffs.call(this, hunting); }
  finally { Settings.profile.macro.buffs = original; }
};


// Party support: heal and buff party members with the player's own skills.
// Party members come from the party list (social.members); HP is exact for members in view (vitals) and in tenths
// otherwise (status & 15, as the game's party window draws it). Buffs a member already has are read from the
// effects the game shows on each player (gameplay.attachedEffects, keyed by gid and skill). Only members in view
// and within the support range are cast on; this never walks. One cast per tick, after potions and before hunting.
// Skill target bits (server SkillUiTarget): self 1, monster 4, ally 16, party 32, corpse 128.
const SUPPORT_TARGET_FRIEND = 16 | 32;
const SUPPORT_CONFIRM_MS = 6000;  // a buff cast that shows no effect on the member by then is a miss
const SUPPORT_BACKOFF_MS = 60000; // after two misses in a row that buff on that member waits a minute
const Support = {
  holdUntil: 0, sent: new Map(), misses: new Map(), message: 'Party support off.',
  cfg() { return Settings.profile.party.support; },
  reset() { this.holdUntil = 0; this.sent.clear(); this.misses.clear(); },
  // Skills that can be cast on another party member (heals and most buffs), best learned level per group.
  friendlySkills() {
    const best = new Map();
    for (const s of Learned.rows()) {
      if (s.missing || s.active === false || s.groundTarget || !s.targetRequired || !((s.targets ?? 0) & SUPPORT_TARGET_FRIEND)) continue;
      const group = s.group ?? s.id, previous = best.get(group);
      if (!previous || (s.level ?? 0) > (previous.level ?? 0)) best.set(group, s);
    }
    return [...best.values()];
  },
  // Skills without a target (area heals, party-wide buffs such as dances), for the group heal.
  areaSkills() { return UI.learnedSkills(true); },
  skillOf(entry) { return entry?.group ? World.bestOfGroup(entry.group, entry.id) || entry.id : 0; },
  // The local player first (for "heal myself too"), then every party member, with what is known about each.
  members() {
    const social = World.gp?.social, pose = World.pose(), range = (Number(this.cfg().range) || 30) * 10, local = World.localGid();
    const out = [];
    const me = World.me();
    out.push({ self: true, name: World.charName, gid: local, entity: World.local(), hpPct: me.hpPct, mpPct: me.mpPct, alive: !World.isDead(), inRange: true, distance: 0 });
    for (const m of social?.members || []) {
      if (!m?.name || m.name === social.localName || m.id === social.self) continue;
      const e = [...World.ents.values()].find(x => x && x.kind === 'player' && x.name === m.name);
      const exact = e ? World.hpPctOf(e) : null, distance = e ? dist2D(pose, e) : Infinity;
      out.push({ self: false, name: m.name, level: m.level, gid: e?.gid || 0, entity: e || null, distance,
        hpPct: exact ?? Math.min(10, m.status & 15) * 10, mpPct: Math.min(10, m.status >>> 4) * 10,
        alive: (m.status & 15) !== 0 && e?.appearanceState?.[0] !== 2, inRange: !!e && distance <= range });
    }
    return out;
  },
  // Whether a member shows an effect of this skill's group, with more than refreshMs left when the game says.
  has(gid, id, refreshMs = 3000) {
    const group = World.skill(id)?.group, t = World.simNow();
    for (const ef of World.gp?.attachedEffects || []) {
      if (!ef || ef.gid !== gid || !(ef.skill === id || group !== undefined && World.skill(ef.skill)?.group === group)) continue;
      if (Number.isFinite(ef.remainingMs) && Number.isFinite(ef.receivedAtMs) && t != null && ef.remainingMs - (t - ef.receivedAtMs) <= refreshMs) continue;
      return true;
    }
    return false;
  },
  ready(id) {
    return id && !Combat.blocked?.(id) && Cmd.canCast(id) && Combat.mpOk(id, World.me());
  },
  // Select the member and cast at them; a skill without a target is simply cast.
  cast(id, member, why) {
    const s = World.skill(id), t = now();
    if (s?.targetRequired && member && !member.self) {
      if (!Cmd.select(member.gid) || !Combat.cast(id, member.gid)) return false;
    } else if (!Combat.cast(id, s?.targetRequired ? World.localGid() : 0)) return false;
    this.holdUntil = t + Math.max(800, s?.actionMs || 1000) + 300;
    this.message = why;
    Log.info('Party support: ' + why);
    return true;
  },
  tick() {
    const c = this.cfg();
    if (!c.enabled) { this.message = 'Party support off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character.'; return false; }
    if (!Hunt.running && !c.whileStopped) { this.message = 'Waiting for hunting to start (or tick Also while hunting is stopped).'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return false;
    if (now() < this.holdUntil) return true;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending || World.gp.targetPending ||
      now() - Combat.lastCastAt < Settings.profile.macro.castGapMs) return false;
    const members = this.members(), party = members.filter(m => !m.self);
    if (!party.length && !c.heal.self) { this.message = 'Not in a party.'; return false; }
    const living = members.filter(m => m.alive && m.inRange && (!m.self || c.heal.self));
    // 1. Group heal when enough members are low.
    const groupId = this.skillOf(c.group);
    if (groupId && this.ready(groupId)) {
      const low = living.filter(m => m.hpPct < c.group.pct);
      if (low.length >= c.group.count) return this.cast(groupId, low.sort((a, b) => a.hpPct - b.hpPct)[0], `group heal (${low.length} below ${c.group.pct}%)`);
    }
    // 2. Heal the lowest member below the threshold.
    const healId = this.skillOf(c.heal);
    if (healId && this.ready(healId)) {
      const low = living.filter(m => m.hpPct < c.heal.pct).sort((a, b) => a.hpPct - b.hpPct)[0];
      if (low) return this.cast(healId, low, `heal ${low.self ? 'myself' : low.name} (${Math.round(low.hpPct)}%)`);
    }
    // 3. Buffs a member does not have yet. A cast that never shows on the member counts as a miss.
    const t = now();
    for (const b of c.buffs) {
      const id = this.skillOf(b);
      if (!id || !this.ready(id)) continue;
      const only = splitList(b.only || '');
      for (const m of party) {
        if (!m.alive || !m.inRange || only.length && !only.includes(m.name.toLowerCase())) continue;
        const key = m.name + ':' + b.group, sent = this.sent.get(key), miss = this.misses.get(key) || { n: 0, until: 0 };
        if (this.has(m.gid, id)) { this.misses.delete(key); this.sent.delete(key); continue; }
        if (t < miss.until) continue;
        if (sent && t - sent < SUPPORT_CONFIRM_MS) continue;
        if (sent) {
          miss.n++; this.sent.delete(key);
          if (miss.n >= 2) { miss.n = 0; miss.until = t + SUPPORT_BACKOFF_MS; Log.warn(`Party support: ${World.skillName(id)} did not show on ${m.name}; trying again in a minute.`); }
          this.misses.set(key, miss);
          if (t < miss.until) continue;
        }
        if (this.cast(id, m, `${World.skillName(id)} on ${m.name}`)) { this.sent.set(key, t); return true; }
        return false;
      }
    }
    this.message = party.some(m => m.alive && !m.inRange) ? 'Some party members are out of view or out of range.' : 'Party is healed and buffed.';
    return false;
  },
};


// Team relay bus: a private WebSocket channel between this bot and the player's other characters.
// Phase 1 carries presence only: who is connected, hunting, alive, at what level. Every character that
// knows the room key joins the same room on the relay; the relay forwards beats between them and holds
// no game logic. The bus is an independent service: it runs with hunting stopped, survives world
// transitions, and a relay that is off or unreachable changes nothing about the bot's own behaviour.
const TEAM_BEAT_MS = 5000;   // presence cadence; the relay drops a client silent for 30 s
const TEAM_PEER_TTL_MS = 15000; // a peer whose beat stops is forgotten, not kept half-alive
const TEAM_BACKOFF_MS = [5000, 10000, 20000, 60000]; // reconnect delay per consecutive failure
const Team = {
  socket: null, state: 'off', message: 'Team relay off.', peers: new Map(), name: '',
  attempts: 0, retryAt: -Infinity, sentAt: -Infinity, cfgKey: null, handlers: {},
  cfg() { return Settings.profile.team; },
  online() { return this.socket?.readyState === 1; },
  // An event for the room, or for everyone on the relay when the public lane is on for it.
  emit(event, scope = 'room') { return this.send({ type: 'msg', scope, payload: { kind: 'event', event } }); },
  reset() {
    this.close();
    this.peers.clear();
    this.attempts = 0; this.retryAt = -Infinity; this.sentAt = -Infinity;
    const on = !!this.cfg().enabled;
    this.state = on ? 'connecting' : 'off';
    this.message = on ? 'Connecting to the team relay…' : 'Team relay off.';
  },
  close() {
    const s = this.socket;
    this.socket = null;
    if (s) { s.onopen = s.onclose = s.onmessage = s.onerror = null; try { s.close(); } catch {} }
  },
  // Extension point for later phases (shared intel, coordination): subscribe to a message type.
  on(type, fn) { (this.handlers[type] ||= []).push(fn); },
  payload() {
    const pose = World.pose();
    return { hunting: !!Hunt.running, alive: World.inWorld() && !World.isDead(),
      mode: String(Controller.mode || 'idle'), level: World.gp?.progression?.level ?? null,
      role: String(this.cfg().role || 'none'), townTrip: !!Town.trip, hasRes: !!Resurrect.skill(),
      pos: pose ? { regionId: pose.regionId, x: Math.round(pose.x), z: Math.round(pose.z) } : null };
  },
  send(msg) {
    if (this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(msg)); return true; } catch { return false; }
  },
  connect(url, token) {
    // The room key rides in the URL for hosts that route by it (Cloudflare Workers); the Node
    // relay ignores the query, so one address format works everywhere.
    const address = url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(token);
    let s = null;
    try { s = new W.WebSocket(address); } catch (e) {
      this.message = 'Relay address refused: ' + (e?.message || e).slice?.(0, 100);
      this.scheduleRetry();
      return;
    }
    this.socket = s;
    this.state = 'connecting';
    this.message = 'Connecting to the team relay…';
    s.onopen = () => {
      if (this.socket !== s) return;
      this.attempts = 0;
      this.state = 'online';
      this.message = 'Connected as ' + this.name + '.';
      this.sentAt = now();
      this.send({ v: 1, type: 'hello', token, name: this.name, state: this.payload() });
      UI.toast('Team relay connected.', 'info', 3000);
    };
    s.onmessage = e => { if (this.socket === s) this.receive(e?.data); };
    // The browser always fires close after an error, so retries are owned by close alone.
    s.onerror = () => {};
    s.onclose = () => { if (this.socket === s) { this.socket = null; this.scheduleRetry(); } };
  },
  scheduleRetry(note = '') {
    const delay = TEAM_BACKOFF_MS[Math.min(this.attempts, TEAM_BACKOFF_MS.length - 1)];
    this.attempts++;
    this.retryAt = now() + delay;
    this.state = 'retrying';
    this.message = (note || 'Relay connection lost') + '; retrying in ' + Math.round(delay / 1000) + ' s.';
    if (this.attempts <= 2) Log.warn('Team relay: ' + this.message);
  },
  receive(text) {
    let msg = null;
    try { msg = JSON.parse(String(text)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'welcome':
        this.peers = new Map((Array.isArray(msg.peers) ? msg.peers : [])
          .filter(p => p?.name && p.name !== this.name)
          .map(p => [p.name, { state: p.state || {}, at: now() }]));
        break;
      case 'peer':
        if (msg.name && msg.name !== this.name) this.peers.set(msg.name, { state: msg.state || {}, at: now() });
        break;
      case 'join':
        if (msg.name && msg.name !== this.name && !this.peers.has(msg.name)) {
          this.peers.set(msg.name, { state: {}, at: now() });
          UI.toast(msg.name + ' joined the team relay.', 'info', 3000);
        }
        break;
      case 'leave':
        if (msg.name && this.peers.delete(msg.name)) UI.toast(msg.name + ' left the team relay.', 'info', 3000);
        break;
      case 'error': {
        const note = 'Relay: ' + String(msg.message || 'error').slice(0, 120);
        Log.warn('Team relay: ' + note);
        this.close();
        this.scheduleRetry(note);
        break;
      }
    }
    for (const fn of this.handlers[msg.type] || []) {
      try { fn(msg); } catch (e) { Log.error('Team handler error: ' + (e?.message || e)); }
    }
  },
  tick() {
    const c = this.cfg();
    const key = !!c.enabled + '|' + c.url + '|' + c.token;
    if (key !== this.cfgKey) { this.cfgKey = key; this.reset(); }
    const t = now();
    for (const [name, peer] of this.peers) if (t - peer.at > TEAM_PEER_TTL_MS) this.peers.delete(name);
    if (!c.enabled) return;
    const url = String(c.url || '').trim();
    // The game page is HTTPS: a remote relay must use wss, or the browser blocks the socket silently.
    if (!/^wss:\/\//i.test(url)) { this.state = 'off'; this.message = 'The relay address must start with wss://.'; return; }
    if (typeof W.WebSocket !== 'function') { this.state = 'off'; this.message = 'This browser has no WebSocket.'; return; }
    const name = String(World.charName || World.gp?.social?.localName || '');
    if (!name) { this.state = 'waiting'; this.message = 'Waiting for the character name…'; return; }
    this.name = name;
    if (!this.socket && t >= this.retryAt) this.connect(url, String(c.token || ''));
    if (this.socket?.readyState === 1 && t - this.sentAt >= TEAM_BEAT_MS) {
      if (this.send({ type: 'beat', name: this.name, state: this.payload() })) this.sentAt = t;
    }
  },
  status() {
    if (!this.cfg().enabled) return 'Team relay off.';
    if (this.state === 'online') return 'Connected as ' + this.name + '; ' + this.peers.size + (this.peers.size === 1 ? ' peer' : ' peers') + ' in the room.';
    return this.message;
  },
  peerRows() {
    const t = now();
    return [...this.peers.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, peer]) => {
      const s = peer.state || {};
      const what = s.townTrip ? 'in town' : s.hunting ? 'hunting' : s.alive === false ? 'dead' : s.mode || 'idle';
      return name + (s.role && s.role !== 'none' ? ' (' + s.role + ')' : '') + ' · ' + what + (Number.isInteger(s.level) ? ' · level ' + s.level : '') + ' · ' + Math.max(0, Math.round((t - peer.at) / 1000)) + ' s ago';
    });
  },
};


// Team intel: the live shared world. Each character publishes a small digest of what it sees —
// interesting monsters (champion and up, party mobs, uniques), other players, and the combat edges
// observed from every cast in view (who attacks what, with how much damage) — and merges the digests
// of its room peers. Entries are keyed by the server's entity gid, which is identical across clients;
// they carry their source and a short TTL, and the local view always wins over a shared one.
// Shards: entries from implausible regions (not own or adjacent) are kept out of the merge, so two
// characters on different divisions never smear each other's maps.
const INTEL_PUBLISH_MS = 2500;
const INTEL_MONSTER_TTL_MS = 15000;
const INTEL_PLAYER_TTL_MS = 20000;
const INTEL_EDGE_TTL_MS = 8000; // matches the bot's own "another player's target" window
const TeamIntel = {
  world: new Map(), // gid -> {kind, gid, name, cls, level, hpPct, regionId, x, z, unique, src, at}
  edges: new Map(), // target gid -> {caster, casterName, target, dmg, at}
  sentAt: -Infinity,
  share() { return Settings.profile.team?.share || {}; },
  reset() { this.world.clear(); this.edges.clear(); this.sentAt = -Infinity; },
  // A monster worth reporting: champion and up, party mobs; normals are everywhere and worth little.
  interesting(e) {
    if (e?.kind !== 'monster' || !World.isAlive(e)) return false;
    return e.rarity === 3 || e.rarity === 1 || e.rarity === 4 || e.rarity === 5 || e.rarity === 6 || e.rarityAuxIcon === 1;
  },
  regionOk(regionId) {
    const pose = World.pose();
    if (!pose || !Number.isInteger(regionId)) return true; // nothing to compare against: accept
    const dx = Math.abs((regionId & 255) - (pose.regionId & 255)), dz = Math.abs((regionId >>> 8) - (pose.regionId >>> 8));
    return dx <= 1 && dz <= 1;
  },
  row(e, kind) {
    return { kind, gid: e.gid, name: e.name || null, cls: kind === 'monster' ? monsterClass(e) : null,
      level: e.level ?? null, hpPct: World.hpPctOf(e) ?? null, unique: kind === 'monster' && e.rarity === 3,
      regionId: e.regionId, x: Math.round(e.x), z: Math.round(e.z) };
  },
  // What this character sees right now, capped so a busy area cannot flood the room.
  snapshot() {
    const monsters = [], players = [];
    for (const e of World.ents.values()) {
      if (!e?.gid) continue;
      if (this.interesting(e)) { if (monsters.length < 40) monsters.push(this.row(e, 'monster')); }
      else if (e.kind === 'player' && e.name && e.gid !== World.localGid() && players.length < 30) players.push(this.row(e, 'player'));
    }
    const t = now();
    const edges = [...this.edges.values()].sort((a, b) => b.at - a.at).slice(0, 12)
      .map(x => ({ c: x.caster, cn: x.casterName, t: x.target, d: Math.min(0xffffff, Math.round(x.dmg)), age: Math.max(0, Math.round(t - x.at)) }));
    return { monsters, players, edges };
  },
  publish(payload, scope) {
    return Team.send({ type: 'msg', scope, payload: { kind: 'intel', payload } });
  },
  tick() {
    const t = now();
    for (const [gid, row] of this.world) if (t - row.at > (row.kind === 'player' ? INTEL_PLAYER_TTL_MS : INTEL_MONSTER_TTL_MS)) this.world.delete(gid);
    for (const [gid, edge] of this.edges) if (t - edge.at > INTEL_EDGE_TTL_MS) this.edges.delete(gid);
    if (!Team.online() || t - this.sentAt < INTEL_PUBLISH_MS) return;
    const snap = this.snapshot();
    this.publish(snap, 'room');
    const share = this.share();
    if (share?.public) {
      const open = { monsters: share.monsters ? snap.monsters : [], players: share.players ? snap.players : [], edges: [] };
      if (open.monsters.length || open.players.length) this.publish(open, 'public');
    }
    this.sentAt = t;
  },
  merge(from, payload) {
    const t = now();
    for (const list of [payload?.monsters, payload?.players]) {
      for (const row of Array.isArray(list) ? list : []) {
        if (!row || !Number.isInteger(row.gid) || !this.regionOk(row.regionId)) continue;
        const known = this.world.get(row.gid);
        if (known && known.src === 'me') continue; // own eyes are fresher than any report
        if (known && known.at > t - 1000) continue;
        this.world.set(row.gid, { kind: row.cls ? 'monster' : 'player',
          gid: row.gid, name: row.name, cls: row.cls, level: row.level ?? null, hpPct: row.hpPct ?? null,
          unique: !!row.unique, regionId: row.regionId, x: row.x, z: row.z, src: from, at: t });
        TeamKnowledge.saw(row, from);
      }
    }
    for (const edge of Array.isArray(payload?.edges) ? payload.edges : []) {
      if (!edge || !Number.isInteger(edge.t) || !Number.isInteger(edge.c)) continue;
      const known = this.edges.get(edge.t);
      if (known && t - (known.at || t) < 1000) continue;
      this.edges.set(edge.t, { caster: edge.c, casterName: String(edge.cn || ''), target: edge.t, dmg: edge.d || 0, at: t - (edge.age || 0) });
    }
  },
  // Every cast in view, ours and everyone else's, feeds the combat edges. A cast aimed at the local
  // player from a player outside the party is also a hostility datum for the knowledge base.
  onCast(cast) {
    if (!cast || !Number.isInteger(cast.caster) || !cast.target) return;
    const caster = World.ents.get(cast.caster);
    const owner = caster?.kind === 'cos' ? World.ents.get(caster.ownerGid) : caster;
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target).filter(Number.isInteger)]);
    let dmg = 0, fatal = false;
    for (const r of cast.results || []) for (const i of r?.impacts || []) { dmg += i?.damage || 0; fatal ||= !!i?.fatal; }
    const t = now();
    for (const gid of targets) {
      const e = World.ents.get(gid);
      if (e?.kind !== 'monster') continue;
      const edge = this.edges.get(gid);
      if (edge && edge.caster !== cast.caster && t - edge.at < 1500) continue; // keep the main attacker
      this.edges.set(gid, { caster: cast.caster, casterName: owner?.name || '', target: gid, dmg: (edge?.caster === cast.caster ? edge.dmg : 0) + dmg, at: t });
      if (e.rarity === 3 && fatal) TeamKnowledge.killed(e, owner?.name || 'someone');
    }
    if (owner?.kind === 'player' && targets.has(World.localGid())) {
      const social = World.gp?.social;
      const member = Array.isArray(social?.members) && social.members.some(m => m?.name === owner.name);
      if (!member && owner.name !== social?.localName) TeamKnowledge.hostile(owner);
    }
  },
  rows() { const t = now(); return [...this.world.values()].filter(r => t - r.at <= (r.kind === 'player' ? INTEL_PLAYER_TTL_MS : INTEL_MONSTER_TTL_MS)); },
};
bus.on('cast', cast => TeamIntel.onCast(cast));
Team.on('msg', m => {
  const payload = m?.payload;
  if (payload?.kind === 'intel') TeamIntel.merge(m.from, payload.payload);
  else if (payload?.kind === 'event') { TeamKnowledge.event(m.from, payload.event); TeamArbiter.event(m.from, payload.event); }
});


// Team knowledge: the persistent, shared memory of the room. The unique tracker turns the game's
// own division-wide announcements (UIIT_MSG_APPEAR/DEAD notices, already on the bot's bus) plus
// first-hand sightings into spawn history with respawn windows (the timer restarts at death; 3-6 h
// per unique). The player database keys on names with deterministic gids, remembers hostility (a
// player outside the party casting at us) and last positions. Drop counters come from the loot bus.
// Everything is kept in the room's key-value store on the relay (last writer merges), so a late
// joiner hydrates from what the room already knows. Wall-clock times (Date.now) because records
// outlive sessions; nothing personal about the local character leaves the room.
const KNOWLEDGE_SYNC_MS = 30000;
const KNOWLEDGE_MAX_PLAYERS = 200, KNOWLEDGE_MAX_DROPS = 300;
// Respawn hours per unique, from the game's own tables; unknown names take the 6 h default.
const UNIQUE_HOURS = { tiger: 6, cerberus: 6, ivy: 6, isyutaru: 6, uruchi: 3, yarkan: 6, shaitan: 6, medusa: 4, jupiter: 4, bonlord: 6, tahomet: 6 };
const TeamKnowledge = {
  uniques: new Map(), // name -> {name, appearAt, deadAt, pos, src, at}
  players: new Map(), // name -> {gid, level, regionId, x, z, hostile, hits, at}
  drops: new Map(),   // item name -> count
  gold: 0, dirty: false, syncedAt: -Infinity, hostileAt: new Map(),
  share() { return Settings.profile.team?.share || {}; },
  reset() { this.dirty = true; }, // records stay; the relay is the memory, a reset only re-syncs
  hoursFor(name) {
    const text = String(name || '').toLowerCase();
    for (const [word, hours] of Object.entries(UNIQUE_HOURS)) if (text.includes(word)) return hours;
    return 6;
  },
  // ---- unique tracker ----
  onNotice(n) {
    const m = String(n?.key || '').match(/^UIIT_MSG_(APPEAR|DEAD|ANYONE_DEAD)_([A-Z_]+)$/);
    if (!m) return;
    const args = Array.isArray(n.args) ? n.args.map(a => String(a ?? '').trim()) : [];
    if (m[2] === 'UNIC' && !args[0]) return;
    const name = m[2] === 'UNIC' ? args[0] : m[2].split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    if (m[1] === 'APPEAR') this.appear(name, null, 'announcement');
    else this.dead(name);
  },
  appear(name, pos, src) {
    const record = this.uniques.get(name) || { name, at: 0 };
    record.appearAt = Date.now(); record.deadAt = null; record.at = record.appearAt;
    record.src = src || 'sighting'; if (pos) record.pos = pos;
    this.uniques.set(name, record);
    this.dirty = true;
    UI.toast(name + ' appeared' + (pos ? '' : ' (somewhere on this server)'), 'warn', 6000);
    if (Settings.profile.hunt.pickup.soxSound) Sound.play('unique');
    this.announce({ kind: 'unique', name, state: 'appear', pos: pos || record.pos || null });
    TeamArbiter.event('local', { kind: 'unique', name, state: 'appear', pos: pos || record.pos || null });
  },
  dead(name, pos) {
    const record = this.uniques.get(name) || { name, at: 0 };
    record.deadAt = Date.now(); record.at = record.deadAt; if (pos) record.pos = pos;
    this.uniques.set(name, record);
    this.dirty = true;
    UI.toast(name + ' is dead; respawn window ' + this.hoursFor(name) + ' h.', 'info', 6000);
    this.announce({ kind: 'unique', name, state: 'dead', pos: pos || record.pos || null });
    TeamArbiter.event('local', { kind: 'unique', name, state: 'dead', pos: pos || record.pos || null });
  },
  killed(e, killer) {
    if (e?.kind === 'monster' && e.rarity === 3 && e.name) this.dead(e.name, { regionId: e.regionId, x: Math.round(e.x), z: Math.round(e.z) });
  },
  announce(event) {
    if (!Team.online()) return;
    Team.emit(event, 'room');
    if (this.share().public && this.share().uniques) Team.emit(event, 'public');
  },
  // ---- player database ----
  saw(row, src) {
    if (!row?.name || row.cls) return;
    const t = Date.now(), known = this.players.get(row.name) || { hostile: 0, hits: 0, at: 0 };
    if (t - known.at < 20000) return; // sightings are dense; one record per 20 s is plenty
    this.players.set(row.name, { gid: row.gid, level: row.level ?? known.level ?? null,
      regionId: row.regionId, x: row.x, z: row.z, hostile: known.hostile, hits: known.hits, at: t });
    this.dirty = true;
  },
  hostile(owner) {
    if (!owner?.name) return;
    const t = Date.now();
    if (t - (this.hostileAt.get(owner.name) || 0) < 10000) return;
    this.hostileAt.set(owner.name, t);
    const known = this.players.get(owner.name) || { hostile: 0, hits: 0, at: t, gid: owner.gid, level: owner.level ?? null, regionId: owner.regionId, x: owner.x, z: owner.z };
    known.hostile++; known.hits++; known.at = t;
    this.players.set(owner.name, known);
    this.dirty = true;
    Log.warn('Team: ' + owner.name + ' attacked you; recorded as hostile.');
  },
  // ---- drop log ----
  onLoot(e) {
    if (e?.kind === 'item' && e.name) {
      this.drops.set(e.name, (this.drops.get(e.name) || 0) + (e.count || 1));
      if (this.drops.size > KNOWLEDGE_MAX_DROPS) [...this.drops.entries()].sort((a, b) => b[1] - a[1]).slice(KNOWLEDGE_MAX_DROPS).forEach(([k]) => this.drops.delete(k));
      this.dirty = true;
    } else if (e?.kind === 'gold' && e.gold) { this.gold += Number(e.gold) || 0; this.dirty = true; }
  },
  // ---- room events from peers ----
  event(from, ev) {
    if (ev?.kind === 'unique') {
      if (ev.state === 'appear') {
        const record = this.uniques.get(ev.name) || { name: ev.name, at: 0 };
        // Only the announcement or a fresher sighting updates the clock.
        if (!record.appearAt || Date.now() - record.appearAt > 60000) {
          record.appearAt = Date.now(); record.deadAt = null; record.at = record.appearAt; record.src = from;
          if (ev.pos) record.pos = ev.pos;
          this.uniques.set(ev.name, record); this.dirty = true;
          UI.toast(ev.name + ' spotted by ' + from + '.', 'warn', 6000);
          if (Settings.profile.hunt.pickup.soxSound) Sound.play('unique');
        }
      } else if (ev.state === 'dead') {
        // A remote death is recorded quietly: re-announcing it would echo between clients forever.
        const record = this.uniques.get(ev.name) || { name: ev.name, at: 0 };
        record.deadAt = Date.now(); record.at = record.deadAt; if (ev.pos) record.pos = ev.pos;
        this.uniques.set(ev.name, record); this.dirty = true;
        UI.toast(ev.name + ' is dead (' + from + '); respawn window ' + this.hoursFor(ev.name) + ' h.', 'info', 6000);
      }
    } else if (ev?.kind === 'hostile' && ev.name) {
      const known = this.players.get(ev.name) || { hostile: 0, hits: 0, at: Date.now() };
      known.hostile++; known.at = Date.now();
      this.players.set(ev.name, known); this.dirty = true;
    }
  },
  // ---- relay key-value sync ----
  doc() {
    return { uniques: Object.fromEntries(this.uniques), players: Object.fromEntries([...this.players.entries()].slice(-KNOWLEDGE_MAX_PLAYERS)),
      drops: Object.fromEntries(this.drops), gold: this.gold };
  },
  hydrate(value) {
    if (!value || typeof value !== 'object') return;
    const mergeRow = (map, key, row) => {
      if (!row || typeof row !== 'object') return;
      const known = map.get(key);
      if (!known || (row.at || 0) > (known.at || 0)) map.set(key, row);
    };
    for (const [key, row] of Object.entries(value.uniques || {})) mergeRow(this.uniques, key, row);
    for (const [key, row] of Object.entries(value.players || {})) mergeRow(this.players, key, row);
    for (const [key, count] of Object.entries(value.drops || {})) if (Number.isFinite(count)) this.drops.set(key, Math.max(this.drops.get(key) || 0, count));
    if (Number.isFinite(value.gold)) this.gold = Math.max(this.gold, value.gold);
    // Local changes that were still waiting for their own put stay waiting: a peer's store
    // write must never cancel a sync this client owes the room.
  },
  tick() {
    if (!Team.online()) return;
    const t = Date.now();
    if (this.dirty && t - this.syncedAt > KNOWLEDGE_SYNC_MS) {
      if (Team.send({ type: 'kv-put', key: 'knowledge', scope: 'room', value: this.doc() })) {
        this.dirty = false; this.syncedAt = t;
        if (this.share().public && this.share().uniques) Team.send({ type: 'kv-put', key: 'knowledge', scope: 'public', value: this.doc() });
      }
    } else if (!this.dirty) this.syncedAt = t; // a fresh sync keeps the next change prompt
  },
  // One line per unique for the Team page: state and, when waiting, the predicted window.
  uniqueRows() {
    const t = Date.now();
    return [...this.uniques.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).map(r => {
      if (r.deadAt) {
        const next = r.deadAt + this.hoursFor(r.name) * 3600000;
        return r.name + ' · died ' + Math.round((t - r.deadAt) / 60000) + ' min ago · window in ' + (next > t ? Math.round((next - t) / 60000) + ' min' : 'now (+' + Math.round((t - next) / 60000) + ' min)');
      }
      if (r.appearAt) return r.name + ' · appeared ' + Math.round((t - r.appearAt) / 60000) + ' min ago · alive or unfound';
      return r.name + ' · no sighting yet';
    });
  },
  playerRows() {
    const t = Date.now();
    return [...this.players.values()].sort((a, b) => (b.hostile - a.hostile) || (b.at - a.at)).slice(0, 12)
      .map(p => (p.hostile ? '⚠ ' : '') + p.name + (Number.isFinite(p.level) ? ' · level ' + p.level : '') + ' · seen ' + Math.round((t - (p.at || t)) / 60000) + ' min ago' + (p.hostile ? ' · hostile ×' + p.hostile : ''));
  },
  dropRows() {
    return [...this.drops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => name + ' ×' + n).concat(this.gold ? ['Gold ' + this.gold] : []);
  },
};
bus.on('notice', n => TeamKnowledge.onNotice(n));
bus.on('loot', e => TeamKnowledge.onLoot(e));
Team.on('welcome', () => {
  if (!Team.online()) return;
  Team.send({ type: 'kv-get', key: 'knowledge', scope: 'room' });
  if (Settings.profile.team?.share?.public && Settings.profile.team.share.uniques) Team.send({ type: 'kv-get', key: 'knowledge', scope: 'public' });
});
Team.on('kv-value', m => TeamKnowledge.hydrate(m?.value));


// Single owner for movement/combat/pickup. Potion use remains a separate emergency lane.
const startHunting = Hunt.start;
Hunt.start = function (...args) {
  if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before hunting.', 'warn');
  if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before hunting.', 'warn');
  if (Stall.run) return UI.toast('Stop the stall session before hunting.', 'warn');
  if (World.gp?.stall?.phase && World.gp.stall.phase !== 'none') return UI.toast('Close the stall before hunting.', 'warn');
  return startHunting.apply(this, args);
};
Hunt.lootAllowed = e => Loot.allowed(e);
// Kill the small ones first. While fighting a stronger monster, switch to a weaker one that is hitting you, then come
// back: the stronger one is still fighting you, so attackers-first picks it up again. Always on, by design:
//  1. only monsters that hit you in the last few seconds (World.attackers) and are within chase distance;
//  2. only a weaker class than the current target (two giants hitting you is no reason to switch);
//  3. never away from a target below THREAT_FINISH_PCT HP: finish it;
//  4. never during a cast (the caller only asks between skills);
//  5. the weakest attacker first (lowest HP), so each kill removes its damage soonest;
//  6. no flip-flop: the small one becomes the current target and only something weaker still could take its place.
// With no current target the weakest attacker is picked the same way, so the giant is not selected between two kills.
const THREAT_RANK = { normal: 1, champion: 2, elite: 4, party: 10, giant: 20, titan: 100, unique: 200 };
const THREAT_WINDOW_MS = 6000, THREAT_FINISH_PCT = 25;
Hunt.threat = function (current) {
  if (World.isCasting() || !current && this.cfg().priority !== 'attackers') return null;
  const rank = e => THREAT_RANK[monsterClass(e)] ?? 1, hp = e => World.hpPctOf(e) ?? 100;
  if (current && (World.hpPctOf(current) ?? 100) < THREAT_FINISH_PCT) return null;
  const sim = World.simNow() ?? 0, pose = World.pose(), chase = this.cfg().chase, limit = current ? rank(current) : Infinity;
  let best = null;
  for (const e of World.ents.values()) {
    if (e === current || !isAttackableMob(e) || this.banned(this.ban, e.gid) || rank(e) >= limit) continue;
    if (sim - (World.attackers.get(e.gid) ?? -Infinity) >= THREAT_WINDOW_MS || dist2D(pose, e) > chase) continue;
    if (!best || rank(e) < rank(best) || rank(e) === rank(best) && (hp(e) < hp(best) || hp(e) === hp(best) && dist2D(pose, e) < dist2D(pose, best))) best = e;
  }
  if (!best || !current) return best;
  const from = current.name || monsterClass(current), to = best.name || monsterClass(best);
  this.threatNote = { gid: best.gid, text: `Combat: switched to ${to} (hitting you); back to ${from} after.` };
  Log.info(`Switched from ${from} to ${to}, which is hitting you.`);
  return best;
};
Hunt.chooseLoot = () => Loot.choose();
Hunt.tick = function () {
  if (!this.running) return;
  if (!Town.cfg().enabled && Restock.tick()) { Loot.suspend(); return; }
  const H = this.cfg(), gp = World.gp;
  if (!World.inWorld()) { this.state = 'waiting'; return; }
  if (World.isDead()) {
    Loot.suspend();
    this.state = 'dead';
    if (!this.deathAt) { Town.deathPoint = World.pose() ? { ...World.pose() } : null; this.deathAt = now(); Party.noteDeath(); Log.info('Died: ' + Party.waitNote()); }
    if ((Town.autoRevive() || H.onDeath === 'revive') && !this.revived && now() - this.deathAt > Party.reviveDelay() && !Party.resBusy()) {
      if (Cmd.rebirth(1)) this.revived = true;
    } else if (!Town.autoRevive() && H.onDeath === 'stop') this.stop('character died');
    return;
  }
  if (this.deathAt) {
    this.deathAt = 0; this.revived = false; this.targetGid = 0;
    if (H.center && dist2D(World.pose(), H.center) > H.radius) { Controller.returnAfterRevive(); return; }
  }
  if (Restock.activeShop() || gp.storage || now() - Manual.lastAt < H.manualPauseS * 1000) {
    Loot.suspend(); this.state = 'manual'; return;
  }
  if (this.playerCheck()) { Loot.suspend(); this.state = 'player'; return; }
  if (H.stopNoHpPotion && Potion.count('hp') + Potion.count('vigor') === 0) return this.stop('out of HP potions');
  if (H.stopInvFull && World.freeBagSlots() === 0) return this.stop('inventory full');
  Loot.preparePet();
  const attacked = this.underAttack(), current = this.currentTarget();
  // One pickup at a time. A pet's request does not own the character's combat tick; a character pickup owns
  // movement until it is done or an attacker interrupts it. The pet's drops go first, then the character's.
  if (attacked && Loot.active && !Loot.active.petGid) Loot.suspend();
  if (Loot.active) { if (Loot.active.petGid) Loot.tick(); else if (Loot.tick()) return; }
  if (!Loot.active && H.pickup.enabled) {
    if (Loot.petMode()) { const drop = Loot.choose('pet'); if (drop) Loot.begin(drop); }
    if (!Loot.active && !attacked && (!current || !H.pickup.afterKillOnly) && !World.isSitting()) {
      const drop = Loot.choose('character');
      if (drop && Loot.begin(drop)) { this.state = 'loot'; return; }
    }
  }
  const me = World.me();
  if (World.isSitting()) {
    const done = !H.sit.enabled || me.hpPct >= H.sit.resumeAt && me.mpPct >= H.sit.resumeAt;
    this.state = done || attacked ? 'standing' : 'resting';
    if ((done || attacked) && now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    return;
  }
  if (H.sit.enabled && !attacked && !current && (me.hpPct < H.sit.hpBelow || me.mpPct < H.sit.mpBelow)) {
    if (now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    this.state = 'resting'; return;
  }
  if (Combat.buffs(true)) { this.state = 'buff'; return; }
  const target = this.threat(current) || current || this.teamTarget(current) || this.chooseTarget();
  if (target) { this.engage(target); return; }
  this.targetGid = 0; this.state = Loot.active?.petGid ? 'loot' : 'search';
  if (H.returnToCenter && H.center && dist2D(World.pose(), H.center) > Math.max(40, H.radius * 0.5) && now() - this.lastMoveAt > 2500) {
    if (!Number.isFinite(dist2D(World.pose(), H.center))) return this.stop('hunt area is in another region');
    if (Cmd.move(H.center)) this.lastMoveAt = now();
    this.state = 'return';
  }
};

function stopAll() {
  Town.record('stop');
  Alchemy.stop();
  Stall.stop();
  BuffGear.cancel();
  const townActive = !!Town.trip;
  Town.cancel();
  Resurrect.cancelTrip('', true);
  Resurrect.holdUntil = 0;
  Controller.resumeAfterRevive = false;
  const active = townActive || Hunt.running || Restock.trip || WalkBack.active || Loot.active;
  WalkBack.cancel('', false);
  if (Hunt.running) Hunt.stop();
  Restock.trip = null;
  Loot.suspend();
  if (active && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
}

// An imbue's cooldown is as long as the imbue itself, so it can be renewed only once it has (nearly) run out.
// The 1.2 s wait after a send also holds while the old imbue still shows time left: until the answer arrives,
// resending into the server's cooldown only earns refusals that pause the imbue.
const IMBUE_RENEW_MS = 400;
Combat.imbue = function () {
  const M = Settings.profile.macro;
  if (!M.imbue) return false;
  const id = this.resolve(M.imbue);
  if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, World.me())) return false;
  if (World.buffRemaining(id) > IMBUE_RENEW_MS) return false;
  if (now() - (this.buffCastAt.get('imbue') || 0) < 1200) return false;
  if (this.cast(id, 0)) {
    this.buffCastAt.set('imbue', now());
    return true;
  }
  return false;
};
// A skill with a cast time reads the imbue when it releases, not when it is pressed, and the game takes an imbue
// in the middle of another skill's cast (an instant self skill runs beside it). The imbue usually comes back
// mid-cast, so it is cast right away: waiting for the cast to end released that skill without it.
const fightBetweenCasts = Combat.fight;
Combat.fight = function (target) {
  const M = Settings.profile.macro;
  if (target && M.imbueBeforeAttack && World.isCasting() && World.gp.target === target.gid && !World.gp.targetPending &&
    now() - this.lastCastAt >= (M.castGapMs ?? 250) && this.imbue()) return;
  return fightBetweenCasts.call(this, target);
};
// Berserk fires when the gauge is full and the target's class is ticked in Combat options.
Combat.berserk = function (cls) {
  if (!Settings.profile.macro.berserkClasses?.[cls] || World.berserkGauge < 5) return false;
  if (World.local()?.appearanceState?.[2] === 1) return false;
  return Cmd.berserk();
};
const Controller = {
  mode: 'idle', lastErrorAt: -Infinity, resumeAfterRevive: false, guardAt: {},
  // Optional features must never stop hunting: an error in one is logged (at most every 5 s) and skipped.
  guard(name, fn) {
    try { return fn(); } catch (e) {
      if (now() - (this.guardAt[name] ?? -Infinity) > 5000) { this.guardAt[name] = now(); Log.error(name + ' error: ' + (e?.message || e)); }
      return false;
    }
  },
  // Start hunting again after an interruption, but only where that is safe: at the hunting spot it just starts,
  // otherwise it walks back. WalkBack first tries the navdata corridor and falls back to short legs; its own caps
  // refuse a spot that is too far. Returns 'started', 'walking' or 'stopped'.
  resumeHunting(prefix) {
    const H = Hunt.cfg(), pose = World.pose(), distance = H.center && pose ? dist2D(pose, H.center) : Infinity;
    if (Number.isFinite(distance) && distance <= Math.max(H.radius * 1.5, 600)) { UI.toast(prefix + '; resuming hunting.', 'info', 4000); Hunt.start(); return 'started'; }
    if (Number.isFinite(distance)) { UI.toast(prefix + '; walking back to the hunting spot.', 'info', 4000); WalkBack.start(true); return WalkBack.active ? 'walking' : 'stopped'; }
    UI.toast(prefix + ', but not at the hunting spot. Use Return & hunt when ready.', 'warn', 6000);
    return 'stopped';
  },
  returnAfterRevive() {
    this.resumeAfterRevive = false;
    Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
    if (Town.autoRevive()) Town.begin(true);
    else if (Settings.profile.hunt.center) WalkBack.start(true);
    else Hunt.stop('No saved hunting spot for revival return.');
  },
  tick() {
    try {
      this.guard('Reconnect', () => Reconnect.tick());
      this.guard('Team', () => { Team.tick(); TeamIntel.tick(); TeamKnowledge.tick(); TeamArbiter.tick(); });
      Restock.sample();
      Alchemy.tick();
      if (BuffGear.run) {
        if (World.inWorld()) { Party.tick(); Potion.tick(); }
        if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      }
      if (Alchemy.run || Alchemy.pending) { if (World.inWorld()) Party.tick(); this.mode = 'alchemy'; return; }
      if (Stall.run) { if (World.inWorld()) { Party.tick(); Potion.tick(); } Stall.tick(); this.mode = 'stall'; return; }
      if (World.inWorld() && World.isDead() && Hunt.running) {
        Town.cancel(); Resurrect.cancelTrip(); Resurrect.holdUntil = 0;
        Party.acceptResurrection();
        Hunt.tick(); this.mode = Hunt.state; return;
      }
      if (World.inWorld() && !World.isDead() && (this.resumeAfterRevive || Hunt.running && Hunt.deathAt)) {
        if (World.gp?.inventoryPending || !World.local()) { this.mode = 'waiting'; return; }
        if (!this.resumeAfterRevive && Hunt.cfg().center && dist2D(World.pose(), Hunt.cfg().center) <= Hunt.cfg().radius) {
          Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
        } else this.returnAfterRevive();
      }
      if (Town.trip) {
        if (World.inWorld()) Party.tick();
        // Reserve the first settled item-use window for departure. Continuing
        // alternating potions first can perpetually renew the 350 ms hold.
        if (Town.trip.phase !== 'recall' || !Town.trip.potionWindowReserved || World.isCasting() || World.gp?.inventoryPending) Potion.tick();
        Town.trip.potionWindowReserved = true;
        if (Town.tick()) { this.mode = 'town service'; return; }
      }
      if (!World.inWorld()) { this.mode = 'waiting'; return; }
      Party.tick();
      Party.resumeTick();
      AutoMastery.tick();
      StatPoints.tick();
      Potion.tick();
      ItemRules.dropTick();
      Loot.checkPetFull();
      if (Town.tick()) { this.mode = 'town service'; return; }
      if (Trap.tick()) { this.mode = 'escape'; return; }
      if (Chase.tick()) { this.mode = 'obstacle pursuit'; return; }
      if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      if (SpeedScroll.tick()) { this.mode = 'speed scroll'; return; }
      if (!WalkBack.active && !Restock.trip && !Restock.recording && !Controller.resumeAfterRevive &&
          !Restock.activeShop() && !World.gp.storage && Resurrect.tick()) {
        this.mode = 'resurrect'; return;
      }
      if (!WalkBack.active && !Restock.trip && !Restock.recording && !Restock.activeShop() && !World.gp.storage && Support.tick()) {
        this.mode = 'party support'; return;
      }
      if (WalkBack.active) { this.mode = 'returning'; WalkBack.tick(); }
      else if (Restock.recording) this.mode = 'recording';
      else if (Hunt.running) { if (!Trace.tick()) Hunt.tick(); this.mode = Restock.trip ? 'shopping' : Hunt.state; }
      else this.mode = 'idle';
    } catch (e) {
      stopAll();
      if (now() - this.lastErrorAt > 5000) { this.lastErrorAt = now(); Log.error(e.message || String(e)); UI.toast('Bot stopped: ' + e.message, 'warn'); }
      this.mode = 'error';
    } finally {
      Town.record();
      Stats.sample();
    }
  },
};


// Team arbiter: the decisions that make a group of characters act like a team instead of five solo
// bots in the same field. Assist focuses your target chooser on the monster a teammate is fighting
// (party members' hits never mark a monster, and by default any other player's hits do — so team
// etiquette between unpartied characters is already the bot's no-KS rule; assist is the other half).
// Town sync makes the room recall together. Resurrection claims stop the dead member reviving
// itself while a peer walks over. Spot claims warn when two characters start on top of each other.
// The room's console (served by the relay) can stop everyone or call a group town trip. Every rule
// is local and advisory: each bot still acts only through its own command layer.
const TeamArbiter = {
  resClaimAt: -Infinity, resClaimBy: '', townFollowAt: -Infinity, spotWarnAt: -Infinity, converge: null,
  cfg() { return Settings.profile.team; },
  reset() { this.resClaimAt = -Infinity; this.townFollowAt = -Infinity; },
  // ---- assist: fight what a teammate fights ----
  assistTarget(current) {
    try {
      if (current || !this.cfg().assist || !Team.online()) return null;
      const social = World.gp?.social, t = now();
      const isParty = n => Array.isArray(social?.members) && social.members.some(m => m?.name === n);
      let best = null;
      for (const edge of TeamIntel.edges.values()) {
        const name = edge.casterName;
        if (!name || name === World.charName || t - edge.at > INTEL_EDGE_TTL_MS) continue;
        if (!Team.peers.has(name) && !isParty(name)) continue;
        const e = World.ents.get(edge.target);
        if (!e || !isAttackableMob(e) || Hunt.banned(Hunt.ban, e.gid)) continue;
        if (!best || edge.at > best.edge.at) best = { edge, e };
      }
      if (best) Log.info('Team assist: joining ' + best.edge.casterName + "'s fight.");
      return best?.e || null;
    } catch { return null; }
  },
  // ---- room events ----
  event(from, ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'town' && ev.who !== World.charName && this.cfg().townSync) {
      if (Hunt.running && !Town.trip && now() - this.townFollowAt > 60000) {
        this.townFollowAt = now();
        UI.toast(from + ' went to town; starting the town trip too.', 'info', 5000);
        try { Town.begin(); } catch (e) { Log.error('Team town sync: ' + (e?.message || e)); }
      }
    } else if (ev.kind === 'res-claim' && ev.target === World.charName) {
      this.resClaimAt = now(); this.resClaimBy = from;
      UI.toast(from + ' is coming to resurrect you.', 'info', 5000);
    } else if (ev.kind === 'unique') this.uniqueEvent(ev);
    else if (ev.kind === 'cmd') this.command(ev);
  },
  // ---- unique converge (opt-in): hunt at the unique's position until it dies or 20 minutes pass ----
  uniqueEvent(ev) {
    if (ev.state === 'dead') {
      if (this.converge?.name === ev.name) this.restoreSpot(ev.name + ' is dead; back to the saved hunting spot.');
      return;
    }
    if (ev.state !== 'appear' || !this.cfg().converge || this.converge) return;
    const pos = ev.pos || TeamKnowledge.uniques.get(ev.name)?.pos;
    if (!pos || !Number.isInteger(pos.regionId)) return;
    const H = Settings.profile.hunt;
    if (!Hunt.running || !H.center || Town.trip || !World.inWorld() || World.isDead()) return;
    this.converge = { name: ev.name, prev: { ...H.center }, at: now() };
    H.center = { regionId: pos.regionId, x: Math.round(pos.x), y: H.center.y || 0, z: Math.round(pos.z) };
    Settings.saveProfile(); bus.emit('center');
    UI.toast('Going to ' + ev.name + "'s position; the saved spot comes back after.", 'warn', 6000);
  },
  restoreSpot(message) {
    const c = this.converge;
    if (!c) return;
    this.converge = null;
    Settings.profile.hunt.center = c.prev;
    Settings.saveProfile(); bus.emit('center');
    if (message) UI.toast(message, 'info', 5000);
  },
  tick() {
    if (this.converge && now() - this.converge.at > 20 * 60000) this.restoreSpot('Unique hunt timed out; back to the saved hunting spot.');
  },
  command(ev) {
    const action = String(ev.action || '');
    if (action === 'stop') { stopAll(); UI.toast('Team console: everyone stops.', 'warn', 5000); }
    else if (action === 'town') {
      if (Hunt.running && !Town.trip) { try { Town.begin(); } catch (e) { Log.error('Team console town: ' + (e?.message || e)); } }
    }
  },
  resIncoming() { return now() - this.resClaimAt < 45000; },
  // Warn once a minute when a hunting teammate sits on our spot; picking another spot stays ours.
  spotCheck() {
    try {
      const pose = World.pose(), center = Settings.profile.hunt.center;
      const me = center && pose ? center : pose;
      if (!me || now() - this.spotWarnAt < 60000) return;
      for (const [name, peer] of Team.peers) {
        const pos = peer.state?.pos;
        if (!peer.state?.hunting || !pos || !Number.isInteger(pos.regionId)) continue;
        const d = regionDelta(me, pos);
        if (d && Math.hypot(...d) < 400) {
          this.spotWarnAt = now();
          UI.toast(name + ' is hunting about ' + Math.round(Math.hypot(...d) / 10) + ' m from your spot.', 'warn', 6000);
          return;
        }
      }
    } catch {}
  },
  // ---- unique converge (manual): move the saved spot to a tracked unique's last position ----
  huntAtUnique(name) {
    const record = TeamKnowledge.uniques.get(name), pose = World.pose();
    if (!record?.pos || !Number.isInteger(record.pos.regionId)) { UI.toast('No position is known for ' + name + ' yet.', 'warn'); return false; }
    this.converge = null; // a manual move cancels any automatic converge so its restore cannot clobber it
    Settings.profile.hunt.center = { regionId: record.pos.regionId, x: Math.round(record.pos.x), y: Number(pose?.y) || 0, z: Math.round(record.pos.z) };
    Settings.saveProfile(); bus.emit('center');
    UI.toast('Hunting spot moved to ' + name + "'s last known position.");
    return true;
  },
};
// Assist slots into the target line between the engaged target and the chooser.
Hunt.teamTarget = function (current) { return TeamArbiter.assistTarget(current); };
// Announce town trips so the room can recall together; the revival trip stays private.
{
  const teamTownBegin = Town.begin;
  Town.begin = function (revival = false) {
    const out = teamTownBegin.call(this, revival);
    if (out !== false && !revival && Team.online()) Team.emit({ kind: 'town', who: World.charName });
    return out;
  };
}
// A resurrection approach tells the dead member to wait for it, up to a minute.
{
  const teamResTick = Resurrect.tick;
  Resurrect.tick = function (...args) {
    const before = this.trip ? this.trip.name : null;
    const out = teamResTick.apply(this, args);
    const name = this.trip && this.trip.phase === 'approach' ? this.trip.name : null;
    if (name && name !== before && Team.online()) Team.emit({ kind: 'res-claim', target: name });
    return out;
  };
  const teamReviveDelay = Party.reviveDelay;
  Party.reviveDelay = function () { return TeamArbiter.resIncoming() ? 60000 : teamReviveDelay.call(this); };
  const teamWaitNote = Party.waitNote;
  Party.waitNote = function () {
    if (TeamArbiter.resIncoming()) return 'waiting up to 60 s; ' + TeamArbiter.resClaimBy + ' is coming to resurrect you.';
    return teamWaitNote.call(this);
  };
}
// Spot claims: check the room's beats once, right after hunting starts.
{
  const teamHuntStart = Hunt.start;
  Hunt.start = function (...args) {
    const out = teamHuntStart.apply(this, args);
    if (this.running) TeamArbiter.spotCheck();
    return out;
  };
}


// Anti-stuck watchdog. While hunting it watches for confirmed progress (kills, XP, gold,
// pickups, damage dealt to the target). Without progress it first drops the current target,
// then walks back to the saved hunting spot, and finally stops instead of idling forever.
const AntiStuck = {
  idleMs: 0, lastAt: null, signature: '', damage: '', recoveries: 0, recoveringUntil: 0, message: '',
  cfg() { return Settings.profile.hunt.antiStuck; },
  // These states are working normally or deliberately waiting; they do not count as stuck.
  counts: new Set(['search', 'return', 'select', 'fight']),
  reset() { this.idleMs = 0; this.lastAt = null; this.signature = ''; this.damage = ''; this.recoveries = 0; this.recoveringUntil = 0; },
  sign() {
    const s = Stats.session;
    return [s.kills, s.xp, s.gold, s.items].join('|');
  },
  tick() {
    const c = this.cfg();
    if (!c.enabled || !Hunt.running || !World.inWorld()) { this.lastAt = null; return; }
    // Following a party member: waiting for them is not being stuck, and recovery would walk away from them.
    if (Trace.active()) { this.idleMs = 0; this.lastAt = now(); return; }
    const t = now(), gap = this.lastAt === null ? 0 : t - this.lastAt;
    this.lastAt = t;
    // A gap means Hunt.tick did not run (town trip, shopping, walk-back): start counting afresh.
    const signature = this.sign(), damage = Hunt.targetGid ? String(World.hpOf(Hunt.targetGid)) : '';
    if (gap > 1500) { this.idleMs = 0; this.signature = signature; this.damage = damage; return; }
    // Hurting the current target keeps the timer fresh; only confirmed gains clear earlier recoveries.
    if (damage && damage !== this.damage && this.damage) this.idleMs = 0;
    this.damage = damage;
    if (signature !== this.signature) {
      this.signature = signature; this.idleMs = 0; this.recoveries = 0;
      return;
    }
    if (!this.counts.has(Hunt.state)) return;
    this.idleMs += gap;
    if (this.idleMs >= c.minutes * 60000) this.recover();
  },
  recover() {
    const c = this.cfg(), H = Hunt.cfg();
    this.idleMs = 0; this.recoveries++;
    if (this.recoveries > c.maxRecoveries) {
      this.message = 'No progress after ' + c.maxRecoveries + ' recoveries.';
      return Hunt.stop('stuck: no progress after ' + c.maxRecoveries + ' recoveries');
    }
    if (Hunt.targetGid) Hunt.ban.set(Hunt.targetGid, now() + 60000);
    Hunt.targetGid = 0; Hunt.selTries = 0; Loot.suspend();
    Log.warn('Anti-stuck recovery ' + this.recoveries + '/' + c.maxRecoveries + ' after ' + c.minutes + ' min without progress.');
    if (this.recoveries >= 2 && H.center) {
      // WalkBack stops and later restarts hunting; this window keeps the recovery count across both events.
      this.recoveringUntil = now() + 660000;
      WalkBack.start(true);
      if (!WalkBack.active) this.recoveringUntil = 0;
      this.message = 'Recovery ' + this.recoveries + ': walking back to the hunting spot.';
      UI.toast('Stuck: walking back to the hunting spot.', 'warn', 3500);
    } else {
      Cmd.move(World.pose());
      this.message = 'Recovery ' + this.recoveries + ': dropped the current target.';
      UI.toast('Stuck: dropped the current target.', 'warn', 3500);
    }
  },
  status() {
    const c = this.cfg();
    if (!c.enabled) return 'Anti-stuck is off.';
    return (this.message || 'Watching for progress.') + (Hunt.running ? ' No progress for ' + Math.floor(this.idleMs / 1000) + ' s.' : '');
  },
};
const huntTickBeforeAntiStuck = Hunt.tick;
Hunt.tick = function () {
  huntTickBeforeAntiStuck.apply(this, arguments);
  AntiStuck.tick();
};
bus.on('hunt', running => {
  if (now() < AntiStuck.recoveringUntil) { if (running) AntiStuck.recoveringUntil = 0; AntiStuck.lastAt = null; return; }
  AntiStuck.reset();
  if (!running) AntiStuck.message = '';
});


/*
===========================================================================
lean-chase.js - exclusive ownership of blocked combat approaches

Failed routes retain movement until stopped. HP changes and jitter cannot
renew an episode budget; only observed local impacts establish damage.
===========================================================================
*/
const CHASE_LIMIT = {
	send: 900,
	stalled: 3000,
	episode: 15000,
	unknown: 5000,
	verify: 500,
	ban: 60000,
	memory: 15000,
	progress: 8,
	targetMove: 40,
	replans: 2
};
const CHASE_OBSERVE_MS = 8000;

/*
================
Chase
================
*/
const Chase = {
	s: null,
	detour: null,
	message: "",
	detours: 0,
	failures: [],
	hits: new Map(),
	seenHits: new Set(),
	castIds: new WeakMap(),
	nextCastId: 0,
	/*
  ================
  cfg
  ================
  */
	cfg() {
		return Settings.profile.hunt.detour;
	},
	/*
  ================
  reset
  ================
  */
	reset( clear = false ) {
		this.s = this.detour = null;
		if ( clear ) {
			this.failures = [];
			this.hits.clear();
			this.seenHits.clear();
		}
	},
	/*
  ================
  owns
  ================
  */
	owns() {
		return !!this.s && ![ "attack", "observe" ].includes( this.s.phase );
	},
	/*
  ================
  hit
  ================
  */
	hit( gid, since = now() - 8000 ) {
		return (this.hits.get( gid ) ?? -Infinity) >= since;
	},
	/*
  ================
  observe

  Repeated cast publications are not new hits. Party damage cannot cancel a
  detour; a local cast send without positive result impacts proves nothing.
  ================
  */
	observe( cast ) {
		if ( cast.caster !== World.localGid() ) return;
		if ( !this.castIds.has( cast ) ) this.castIds.set( cast, ++this.nextCastId );
		const token = cast.token ?? cast.startedAtMs ?? this.castIds.get( cast );
		for ( const result of cast.results || [] ) {
			for ( const [index, impact] of (result.impacts || []).entries() ) {
				if ( !(impact.damage > 0) ) continue;
				const key = `${token}:${cast.skill}:${result.target}:${impact.stage ?? index}:${impact.damage}`;
				if ( this.seenHits.has( key ) ) continue;
				this.seenHits.add( key );
				this.hits.set( result.target, now() );
			}
		}
		while ( this.seenHits.size > 512 ) this.seenHits.delete( this.seenHits.values().next().value );
		while ( this.hits.size > 256 ) this.hits.delete( this.hits.keys().next().value );
	},
	/*
  ================
  radius

  Unknown weapon reach is not guessed. Authored skills can supply a conservative
  stand-off goal; successful ranged offense is preserved independently.
  ================
  */
	radius( target ) {
		const ranges = Combat.rotation( monsterClass( target ) ).map( e => World.skill( Combat.resolve( e ) ) )
			.filter( s => s?.targetRequired && !s.groundTarget && s.range > 0 ).map( s => s.range );
		return Math.min( 120, ranges.length ? Math.max( 7, Math.min( ...ranges ) - 5 ) : 7 );
	},
	/*
  ================
  canProbe

  Authored range permits one bounded ranged trial, not a new line-of-sight rule.
  ================
  */
	canProbe( target ) {
		const distance = dist2D( World.pose(), target );
		return Combat.rotation( monsterClass( target ) ).some( e => {
			const s = World.skill( Combat.resolve( e ) );
			return s?.targetRequired && !s.groundTarget && s.range >= 60 && s.range >= distance;
		} );
	},
	/*
  ================
  remember
  ================
  */
	remember( target ) {
		this.failures.push( {
			gid: target.gid,
			from: { ...this.s.origin },
			target: { ...target },
			at: now(),
			revision: Navigation.revision,
			epoch: World.epoch
		} );
		if ( this.failures.length > 32 ) this.failures.shift();
	},
	/*
  ================
  repeated

  A short-lived failure describes one approach, never a permanent area ban.
  ================
  */
	repeated( target, from ) {
		this.failures = this.failures.filter( f =>
			now() - f.at < CHASE_LIMIT.memory &&
			f.epoch === World.epoch && f.revision === Navigation.revision
		);
		return this.failures.some( f =>
			f.gid === target.gid && dist2D( f.from, from ) < 40 && dist2D( f.target, target ) < 40
		);
	},
	/*
  ================
  abandon
  ================
  */
	abandon( target, reason ) {
		this.remember( target );
		this.s.phase = "abandon";
		this.s.reason = reason;
		this.s.abandonAt = now();
		this.s.halted = false;
		this.s.released = false;
		this.message = "Blocked target: " + reason + "; stopping its approach.";
		return true;
	},
	/*
  ================
  settle

  A refused or cast-held halt retains ownership rather than resuming attacks.
  ================
  */
	settle() {
		const s = this.s;
		if ( World.isCasting() || World.gp?.targetPending ) return false;
		if ( !s.halted ) {
			if ( Cmd.move( World.pose() ) ) s.halted = true;
			return false;
		}
		return !World.gp?.pendingMoves;
	},
	/*
  ================
  stalled

  A failed simplified query is not proof that native combat cannot proceed.
  Keep ordinary target ownership until fresh state shows no approach or damage.
  ================
  */
	stalled( target ) {
		const s = this.s, t = now(), distance = dist2D( World.pose(), target );
		if ( !s.observation ) s.observation = { at: t, best: distance, state: World.gp };
		const o = s.observation;
		if (
			World.gp.target !== target.gid || World.gp.targetPending || World.isCasting() ||
			World.gp.inventoryPending || this.hit( target.gid, o.at ) || distance < o.best - CHASE_LIMIT.progress
		) {
			o.at = t;
			o.best = distance;
			o.state = World.gp;
		}
		return World.gp !== o.state && t - o.at >= Math.max( CHASE_OBSERVE_MS, this.cfg().stallMs );
	},
	/*
  ================
  observeApproach
  ================
  */
	observeApproach( target ) {
		this.s.phase = "observe";
		this.s.at = now();
		this.detour = null;
		this.stalled( target );
		this.message = "Letting the game approach the selected target; route result is inconclusive.";
		return false;
	},
	/*
  ================
  drive
  ================
  */
	drive( target ) {
		if ( !this.cfg()?.enabled || !Hunt.running || !World.inWorld() || World.isDead() ) {
			this.reset();
			return false;
		}
		const pose = World.pose(), t = now();
		if ( !pose || !Number.isFinite( dist2D( pose, target ) ) ) return false;
		// The admitted bot planner is outdoor-only. Do not disable otherwise valid
		// dungeon combat merely because no outdoor collision scene can cover it.
		if ( pose.regionId & DUNGEON ) {
			this.reset();
			return false;
		}
		let s = this.s;
		if ( !s || s.gid !== target.gid ) {
			s = this.s = {
				gid: target.gid,
				phase: "evaluate",
				at: t,
				origin: { ...pose },
				target: { ...target },
				progressAt: t,
				best: Infinity,
				revision: Navigation.revision,
				epoch: World.epoch,
				replans: 0,
				halted: false,
				route: [],
				index: 0,
				sentAt: -Infinity,
				verifyAt: null
			};
			this.detour = null;
		}
		if ( s.epoch !== World.epoch ) {
			this.reset();
			return true;
		}
		if ( s.phase === "probe" ) {
			if ( s.probeAt !== null && this.hit( target.gid, s.probeAt ) ) {
				s.phase = "attack";
				s.at = t;
				s.checkedAt = t;
				return false;
			}
			// Allow ordinary combat to admit the trial, including preparatory imbues.
			if ( s.probeAt === null && t - s.probeReadyAt < CHASE_LIMIT.unknown ) return false;
			if ( s.probeAt !== null && t - s.probeAt < 2000 ) return true;
			s.phase = "evaluate";
		}
		if ( s.phase === "abandon" ) {
			if ( t - s.abandonAt > CHASE_LIMIT.episode ) {
				Hunt.stop( "Blocked approach could not be stopped safely." );
				return true;
			}
			if ( !this.settle() ) return true;
			if ( World.gp.target === target.gid ) {
				if ( !s.released && Cmd.release() ) {
					s.released = true;
					s.releaseAt = t;
				} else if ( s.released && t - s.releaseAt > CHASE_LIMIT.unknown ) {
					Hunt.stop( "Blocked target release was not confirmed." );
				}
				return true;
			}
			Hunt.ban.set( target.gid, t + CHASE_LIMIT.ban );
			Hunt.targetGid = 0;
			this.message = "Dropped blocked target: " + s.reason;
			Log.warn( this.message );
			this.reset();
			return true;
		}
		if ( s.phase === "attack" && this.hit( target.gid ) && !this.detour ) {
			s.at = t;
			return false;
		}
		const observedStall = s.phase === "observe" && this.stalled( target );
		if ( s.phase === "observe" && !observedStall ) return false;
		if ( t - s.at > CHASE_LIMIT.episode ) return this.abandon( target, "approach timed out" );
		if ( s.phase === "attack" && t - s.checkedAt < this.cfg().stallMs ) return false;
		if ( [ "evaluate", "unknown", "attack", "observe" ].includes( s.phase ) ) {
			const query = Navigation.attackRoute( pose, target, this.radius( target ) );
			s.checkedAt = t;
			if ( query.status === "unknown" ) {
				return this.observeApproach( target );
			}
			if ( query.status === "invalid-start" ) {
				if ( !observedStall ) return this.observeApproach( target );
				if ( !Trap.cfg()?.enabled ) return this.abandon( target, "blocked start; escape recovery is disabled" );
				Trap.request( "Current position is blocked." );
				return true;
			}
			if ( query.status === "direct" ) {
				if ( s.phase === "attack" && World.gp.target === target.gid && !World.isCasting() ) {
					const distance = dist2D( pose, target );
					if ( distance < s.best - CHASE_LIMIT.progress ) {
						s.best = distance;
						s.at = t;
					} else if ( t - s.at >= Math.max( this.cfg().stallMs * 2, CHASE_LIMIT.stalled ) ) {
						return this.abandon( target, "native approach made no progress" );
					}
				}
				s.phase = "attack";
				s.halted = false;
				return false;
			}
			if ( !s.probed && this.canProbe( target ) ) {
				if ( World.gp.target !== target.gid || World.gp.targetPending ) {
					Cmd.select( target.gid );
					return true;
				}
				if ( World.isCasting() ) return true;
				s.probed = true;
				s.probeReadyAt = t;
				s.probeAt = null;
				s.phase = "probe";
				return false;
			}
			if ( query.status !== "route" ) {
				if ( !observedStall || query.status === "search-limit" ) return this.observeApproach( target );
				return this.abandon(
					target,
					"native approach stalled; planner found no route"
				);
			}
			if ( this.repeated( target, pose ) ) return this.abandon( target, "this approach recently failed" );
			s.phase = "route";
			s.route = query.route;
			s.index = 0;
			s.progressAt = t;
			s.best = Infinity;
			s.target = { ...target };
			s.revision = Navigation.revision;
			this.detour = s;
			this.detours++;
			this.message = "Walking around the obstacle before attacking.";
		}
		if ( !this.settle() ) return true;
		if ( World.isSitting() || World.gp?.inventoryPending ) return true;
		if (
			s.revision !== Navigation.revision || dist2D( s.target, target ) > CHASE_LIMIT.targetMove ||
			t - s.progressAt > CHASE_LIMIT.stalled
		) {
			if ( ++s.replans > CHASE_LIMIT.replans ) return this.abandon( target, "detour made no progress" );
			s.phase = "evaluate";
			s.halted = false;
			this.detour = null;
			return true;
		}
		while ( s.index < s.route.length && dist2D( pose, s.route[s.index] ) <= PURSUIT_NAV.arrive ) {
			s.index++;
			s.progressAt = t;
			s.best = Infinity;
		}
		if ( s.index >= s.route.length ) {
			if ( !Navigation.segment( pose, target ) ) {
				return this.abandon( target, "final attack approach is blocked" );
			}
			if ( World.gp === s.verifyState ) return true;
			s.verifyAt ??= t;
			s.verifyState = World.gp;
			if ( t - s.verifyAt < CHASE_LIMIT.verify ) return true;
			s.phase = "attack";
			s.at = t;
			s.checkedAt = t;
			s.halted = false;
			this.detour = null;
			return true;
		}
		const destination = s.route[s.index], distance = dist2D( pose, destination );
		if ( distance < s.best - CHASE_LIMIT.progress ) {
			s.best = distance;
			s.progressAt = t;
		}
		if ( !Navigation.segment( pose, destination ) ) {
			return this.abandon( target, "next waypoint is no longer reachable" );
		}
		if ( t - s.sentAt >= CHASE_LIMIT.send ) {
			const delta = regionDelta( pose, destination ), length = Math.hypot( ...delta );
			const start = Navigation.local( pose ), scale = Math.min( 1, PURSUIT_NAV.step / length );
			const step = Navigation.pose( { x: start.x + delta[0] * scale, z: start.z + delta[1] * scale }, pose.y );
			if ( Navigation.segment( pose, step ) && Cmd.move( step ) ) s.sentAt = t;
		}
		return true;
	},
	/*
  ================
  tick
  ================
  */
	tick() {
		if ( !this.owns() ) return false;
		if (
			!Hunt.running || !World.inWorld() || World.isDead() ||
			now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ||
			Town.trip || WalkBack.active || Restock.trip || Restock.recording || Restock.activeShop() ||
			World.gp?.storage
		) {
			this.reset();
			return false;
		}
		const target = World.ents.get( this.s.gid );
		if ( !isAttackableMob( target ) ) {
			if ( !this.settle() ) return true;
			this.reset();
			return true;
		}
		Hunt.state = "fight";
		Loot.preparePet();
		if ( Loot.active?.petGid ) Loot.tick();
		else if ( !Loot.active && Hunt.cfg().pickup.enabled && Loot.petMode() ) {
			const drop = Loot.choose( "pet" );
			if ( drop ) Loot.begin( drop );
		}
		return this.drive( target );
	}
};

/*
================
engageWithObstaclePursuit
================
*/
const engageBeforeChase = Hunt.engage;
Hunt.engage = function( target ) {
	if ( Chase.drive( target ) ) return;
	return engageBeforeChase.apply( this, arguments );
};
// Cmd emits this event only after local dispatch succeeds. Selection, buffs and
// refused sends cannot consume the probe's damage observation window.
bus.on( "command", command => {
	const s = Chase.s;
	if ( s?.phase !== "probe" || s.probeAt !== null || command.gid !== s.gid ) return;
	if ( command.kind === "attack" || command.kind === "skill" && World.skill( command.skillId )?.targetRequired ) {
		s.probeAt = now();
	}
});
bus.on( "cast", cast => Chase.observe( cast ) );
bus.on( "hunt", () => Chase.reset() );
for ( const event of [ "reset", "profile", "character" ] ) bus.on( event, () => Chase.reset( true ) );
Hook.observers.push( command => {
	if ( command?.kind === "gameplay" ) Chase.reset();
} );


/*
===========================================================================
lean-trap.js - bounded recovery using legal, observed movement

Owns escape admission, reverse breadcrumbs and a second move that confirms
freedom. A local send or a cast timestamp is never proof of escape.
===========================================================================
*/
const TRAP_LIMIT = {
	admission: 5000,
	motion: 6000,
	verify: 500,
	crumbs: 32,
	candidates: 4,
	arrive: 7,
	progress: 8,
	recallCooldown: 300000
};

/*
================
Trap
================
*/
const Trap = {
	crumbs: [],
	idle: null,
	stage: 0,
	at: 0,
	from: null,
	tile: "unknown",
	message: "",
	lastBreadcrumbAt: -Infinity,
	run: null,
	lastRecallAt: -Infinity,
	trace: [],
	/*
  ================
  cfg
  ================
  */
	cfg() {
		return Settings.profile.hunt.trap;
	},
	/*
  ================
  walking
  ================
  */
	walking() {
		return [ "fight", "return", "loot" ].includes( Hunt.state ) && !World.isCasting() && !World.isSitting();
	},
	/*
  ================
  busy
  ================
  */
	busy() {
		return !!(Town.trip || WalkBack.active || Resurrect.trip || Restock.trip || Restock.recording ||
			BuffGear.run || Alchemy.run || World.gp?.storage || Restock.activeShop());
	},
	/*
  ================
  reset
  ================
  */
	reset( clearCrumbs = false ) {
		this.idle = null;
		this.stage = 0;
		this.from = null;
		this.run = null;
		if ( clearCrumbs ) this.crumbs = [];
	},
	/*
  ================
  record

  Local, opt-in diagnostic detail. Ordinary report uploads do not include poses.
  ================
  */
	record( reason ) {
		this.message = reason;
		if ( this.cfg().diagnostics ) {
			this.trace.push( {
				at: now(),
				reason,
				stage: this.stage,
				pose: { ...World.pose() },
				epoch: World.epoch,
				revision: Navigation.revision,
				sent: this.run?.pending?.sentAt ?? null
			} );
			if ( this.trace.length > 64 ) this.trace.shift();
		}
	},
	/*
  ================
  blockedAt
  ================
  */
	blockedAt( pose ) {
		return { open: "no", blocked: "yes", unknown: "unknown" }[Navigation.pointStatus( pose )];
	},
	/*
  ================
  nearestOpen
  ================
  */
	nearestOpen( pose ) {
		return Navigation.escapeCandidates( pose )[0] || null;
	},
	/*
  ================
  stepBack
  ================
  */
	stepBack( pose ) {
		for ( let i = this.crumbs.length - 1; i >= 0; i-- ) {
			const p = this.crumbs[i];
			if (
				p.epoch !== undefined && p.epoch !== World.epoch ||
				p.revision !== undefined && p.revision !== Navigation.revision
			) continue;
			if ( dist2D( pose, p ) >= 8 && dist2D( pose, p ) <= 120 && Navigation.segment( pose, p, true ) ) return p;
		}
		return null;
	},
	/*
  ================
  status
  ================
  */
	status() {
		return this.stage ? this.message : "";
	},
	/*
  ================
  request
  ================
  */
	request( reason ) {
		if ( !this.cfg()?.enabled || this.run ) return;
		const pose = World.pose();
		if ( !pose || !Hunt.running || !World.inWorld() || World.isDead() || this.busy() ) return;
		this.from = { ...pose };
		this.tile = this.blockedAt( pose );
		this.stage = 1;
		this.at = now();
		this.run = {
			epoch: World.epoch,
			revision: Navigation.revision,
			manualAt: Manual.lastAt,
			at: now(),
			phase: "halt",
			pending: null,
			attempted: [],
			retreat: false,
			verified: false,
			gid: Hunt.targetGid || Chase.s?.gid || 0,
			target: Chase.s?.target,
			fresh: null
		};
		Loot.suspend();
		this.record( "Recovering: " + reason );
		Log.warn( this.message );
	},
	/*
  ================
  candidate
  ================
  */
	candidate() {
		const r = this.run, pose = World.pose();
		const crumb = !r.retreat && this.stepBack( pose );
		if ( crumb ) {
			r.retreat = true;
			return crumb;
		}
		this.stage = 2;
		return Navigation.escapeCandidates( pose ).find( p => !r.attempted.some( a => dist2D( a, p ) < 7 ) ) || null;
	},
	/*
  ================
  fail

  Recall is opt-in and delegates to the existing town owner. Hunting is not
  resumed into the same trap without a completed legal trip and approach ban.
  ================
  */
	fail( reason ) {
		const r = this.run;
		if ( r?.gid ) Hunt.ban.set( r.gid, now() + CHASE_LIMIT.ban );
		const recall = this.cfg().recall && now() - this.lastRecallAt >= TRAP_LIMIT.recallCooldown &&
			Town.cfg().enabled && !Town.validate();
		this.record( "Trapped: " + reason );
		Log.warn( this.message );
		Sound.play( "pet-full" );
		this.reset( true );
		Chase.reset();
		if ( recall ) {
			this.lastRecallAt = now();
			Town.begin();
			// A recovery trip ends in town. Automatically reversing would reenter
			// the same blocked origin, so this safety trip never spends a reverse.
			if ( Town.trip ) {
				Town.trip.recovery = true;
				return;
			}
		}
		Hunt.stop( "character cannot move (trapped): " + reason );
	},
	/*
  ================
  free
  ================
  */
	free() {
		const r = this.run;
		if ( r?.gid ) Hunt.ban.set( r.gid, now() + CHASE_LIMIT.ban );
		if ( Chase.s && r?.target ) Chase.remember( r.target );
		Hunt.targetGid = 0;
		this.record( "Free again: two movement steps confirmed." );
		Log.info( this.message );
		Chase.reset();
		this.reset( true );
	},
	/*
  ================
  tick
  ================
  */
	tick() {
		const t = now(), pose = World.pose();
		if ( !this.cfg()?.diagnostics ) this.trace = [];
		if (
			!this.cfg()?.enabled || !Hunt.running || !World.inWorld() || World.isDead() || this.busy() ||
			now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000
		) {
			this.reset();
			return false;
		}
		if ( !pose ) return false;
		if ( pose.regionId & DUNGEON ) {
			this.reset( true );
			return false;
		}
		if ( !this.run ) {
			if (
				Navigation.pointStatus( pose ) === "open" && t - this.lastBreadcrumbAt >= 500 &&
				(!this.crumbs.length || dist2D( this.crumbs.at( -1 ), pose ) >= 8)
			) {
				this.crumbs.push( { ...pose, epoch: World.epoch, revision: Navigation.revision } );
				this.lastBreadcrumbAt = t;
				if ( this.crumbs.length > TRAP_LIMIT.crumbs ) this.crumbs.shift();
			}
			if ( !this.walking() || Chase.hit( Hunt.targetGid ) ) {
				this.idle = null;
				return false;
			}
			if ( !this.idle || dist2D( this.idle.pose, pose ) > TRAP_LIMIT.progress ) {
				this.idle = { pose: { ...pose }, since: t };
			}
			if ( t - this.idle.since < this.cfg().seconds * 1000 ) return false;
			this.request( "no useful movement or confirmed damage." );
		}
		const r = this.run;
		if ( !r ) return false;
		if ( r.epoch !== World.epoch || r.revision !== Navigation.revision || r.manualAt !== Manual.lastAt ) {
			this.reset( true );
			Chase.reset();
			return true;
		}
		if ( t - r.at > 45000 ) {
			this.fail( "escape episode timed out" );
			return true;
		}
		if ( r.phase === "halt" ) {
			if ( !World.isCasting() && !World.gp?.targetPending && Cmd.move( pose ) ) r.phase = "choose";
			return true;
		}
		if ( World.isCasting() || World.isSitting() || World.gp?.inventoryPending || World.gp?.pendingMoves ) {
			return true;
		}
		let p = r.pending;
		if ( p ) {
			const distance = dist2D( pose, p.to );
			// New gameplay state, an actual admitted send and a stable endpoint are
			// required; old snapshots or one correction cannot complete an escape.
			if (
				p.sentAt !== null && World.gp !== p.state && distance <= TRAP_LIMIT.arrive &&
				Navigation.pointStatus( pose ) === "open"
			) {
				if ( p.arrivedAt === null ) {
					p.arrivedAt = t;
					p.arrivedState = World.gp;
					return true;
				}
				if ( World.gp === p.arrivedState || t - p.arrivedAt < TRAP_LIMIT.verify ) return true;
				if ( r.verified ) {
					this.free();
					return true;
				}
				r.verified = true;
				r.pending = null;
				r.phase = "choose";
			} else {
				p.arrivedAt = null;
				if ( p.sentAt === null ) {
					if ( t - p.at > TRAP_LIMIT.admission ) {
						this.fail( "escape movement could not be admitted" );
						return true;
					}
					if ( Navigation.segment( pose, p.to, true ) && Cmd.move( p.to ) ) {
						p.sentAt = t;
						p.state = World.gp;
						this.record( "Escape move sent; waiting for observed arrival." );
					}
					return true;
				}
				if ( t - p.sentAt < TRAP_LIMIT.motion ) return true;
				r.pending = null;
				r.phase = "choose";
				r.verified = false;
				this.record( "Escape did not reach its endpoint; choosing another legal step." );
			}
		}
		if ( r.attempted.length >= TRAP_LIMIT.candidates ) {
			this.fail( "bounded escape attempts failed" );
			return true;
		}
		const to = this.candidate();
		if ( !to ) {
			this.fail( "no legal escape endpoint is reachable" );
			return true;
		}
		r.attempted.push( { ...to } );
		r.pending = { to: { ...to }, at: t, sentAt: null, state: World.gp, arrivedAt: null };
		this.record(
			r.verified ? "Verifying escape with a second movement step." : "Trying a collision-checked escape step."
		);
		return true;
	}
};
bus.on( "hunt", () => Trap.reset( true ) );
for ( const event of [ "reset", "profile", "character" ] ) {
	bus.on( event, () => {
		Trap.reset( true );
		Trap.trace = [];
	} );
}
Hook.observers.push( command => {
	if ( command?.kind === "gameplay" ) Trap.reset( true );
} );


// Always-on reconnect. When the connection to the game is lost (a server restart, a network drop) the bot waits for the
// game's own retries, then re-enters the world with the login the page already holds, as the Enter button would.
// It never types or stores credentials: if the login itself is gone it says so and waits for you. Hunting that was
// running resumes once the character is back at the hunting spot. Choosing logout, disconnect, exit or restart yourself
// cancels everything, and so does logging in or entering a character by hand.
// When the game itself fails to load ("Unable to finish loading") the page is reloaded after a short wait. The character
// and whether hunting was running are kept in localStorage across the reload; the game restores the login from its own
// session cookie, then the same reconnect steps below enter the world and resume hunting. At most 3 reloads per 30 minutes.
const Reconnect = {
  intent: null, attempts: 0, nextAt: 0, waitUntil: 0, backAt: 0, message: '',
  DELAYS: [4000, 10000, 20000, 30000], GIVE_UP_MS: 12 * 3600 * 1000,
  STORE_KEY: 'sro-lean-reload', LOAD_WAIT_MS: 15000, MAX_RELOADS: 3, RELOAD_WINDOW_MS: 30 * 60000, PENDING_MS: 10 * 60000, LOGIN_GRACE_MS: 60000,
  restored: false, failedAt: 0, expiredAt: 0, EXPIRED_WAIT_MS: 30000, snapAt: 0, gaveUp: false, retryAt: 0,
  // What survives a page reload: the last in-world snapshot, the reload times and the one reload waiting to be resumed.
  load() { try { return JSON.parse(window.localStorage.getItem(this.STORE_KEY)) || {}; } catch { return {}; } },
  save(data) { try { window.localStorage.setItem(this.STORE_KEY, JSON.stringify(data)); } catch {} },
  // The game's own loading screen says when it gave up; its label is only changed to this text on a failure.
  loadFailure() {
    if (typeof document === 'undefined') return '';
    const box = document.getElementById('startup-loading');
    if (!box || box.dataset.error !== 'true' || !/Unable to finish loading/.test(box.querySelector('.sro-boot-loading__label')?.textContent || '')) return '';
    return box.querySelector('.sro-boot-loading__detail')?.textContent || 'Unable to finish loading';
  },
  doReload() { window.location.reload(); },
  snapshot() {
    if (!World.inWorld() || !World.charName || now() - this.snapAt < 5000) return;
    this.snapAt = now();
    const data = this.load();
    this.save({ ...data, snap: { character: World.charName, hunting: !!(Hunt.running || Town.trip || WalkBack.active || this.intent?.hunting), at: Date.now() } });
  },
  // Right after a reload: pick the character up again exactly as after a lost connection.
  restore() {
    this.restored = true;
    const data = this.load(), p = data.pending;
    if (!p) return;
    this.save({ ...data, pending: null });
    if (!p.character || Date.now() - p.at > this.PENDING_MS) return;
    this.intent = { character: p.character, hunting: !!p.hunting, since: now(), reloaded: true };
    this.attempts = 1; this.nextAt = now() + 3000; this.backAt = 0;
    this.message = 'The page was reloaded; restoring ' + p.character + '.';
    Log.warn('The game failed to load earlier; page reloaded, restoring ' + p.character + '.');
  },
  // Save what to resume, then reload. Shared by a failed load and an expired session; limited to 3 per 30 minutes.
  reloadPage() {
    const data = this.load(), times = (data.times || []).filter(t => Date.now() - t < this.RELOAD_WINDOW_MS);
    if (times.length >= this.MAX_RELOADS) {
      if (!this.gaveUp) {
        this.gaveUp = true; this.retryAt = Math.min(...times) + this.RELOAD_WINDOW_MS + 1000; this.message = 'Reloaded the page ' + this.MAX_RELOADS + ' times in 30 minutes; not reloading again for now; trying again when the oldest reload is 30 minutes old.';
        Log.warn(this.message); UI.toast(this.message, 'warn', 8000);
      }
      return false;
    }
    const known = this.intent ? { character: this.intent.character, hunting: this.intent.hunting } : data.snap && Date.now() - data.snap.at < this.RELOAD_WINDOW_MS ? data.snap : null;
    this.save({ snap: data.snap, times: [...times, Date.now()], pending: known ? { character: known.character, hunting: !!known.hunting, at: Date.now() } : null });
    this.doReload();
    return true;
  },
  // The reload limit is a pause, not the end: once the oldest reload is 30 minutes old another one is allowed (a server
  // that is down for hours must not leave the bot stuck for the night).
  capped() {
    if (this.gaveUp && Date.now() >= this.retryAt) { this.gaveUp = false; this.failedAt = this.failedAt ? now() : 0; this.expiredAt = this.expiredAt ? now() : 0; }
    return this.gaveUp;
  },
  watchLoad() {
    const text = this.loadFailure();
    if (!text) { this.failedAt = 0; return; }
    if (!this.failedAt) { this.failedAt = now(); this.gaveUp = false; Log.warn('The game failed to load (' + text + '); reloading the page shortly.'); }
    if (this.capped()) return;
    if (now() - this.failedAt < this.LOAD_WAIT_MS) { this.message = 'The game failed to load; reloading the page shortly.'; return; }
    this.reloadPage();
  },

  active() { return !!this.intent; },
  clear(message = '') { this.intent = null; this.attempts = 0; this.nextAt = this.waitUntil = this.backAt = this.expiredAt = 0; this.message = message; },
  // The connection was lost while the bot may have been working: remember what to restore.
  lost() {
    if (!World.charName) return;
    const busy = !!(Hunt.running || Town.trip || WalkBack.active);
    if (!this.intent) { this.intent = { character: World.charName, hunting: busy, since: now() }; this.attempts = 0; this.nextAt = now() + 2000; this.message = 'Connection lost; waiting for the game to reconnect.'; Log.warn('Connection lost; reconnecting automatically.'); }
    else if (busy) this.intent.hunting = true;
    this.backAt = 0;
  },
  // The player took over: never fight their choice.
  manual(kind) {
    if (this.intent && ['logout', 'disconnect', 'exit', 'restart', 'login', 'enter-world'].includes(kind)) this.clear('Automatic reconnect cancelled.');
  },
  send(command) {
    if (!Hook.post) return false;
    try { Hook.post({ kind: 'session', command }); return true; } catch (e) { Log.warn('Reconnect command failed: ' + (e?.message || e)); return false; }
  },
  tick() {
    if (!this.restored) this.restore();
    this.watchLoad();
    this.snapshot();
    const i = this.intent;
    if (!i) return;
    if (now() - i.since > this.GIVE_UP_MS) return this.clear('Gave up reconnecting after 12 hours.');
    if (World.inWorld()) return this.back(i);
    this.backAt = 0;
    const phase = World.phase, error = String(World.session?.error || '');
    if (['connecting', 'entering-world', 'reconnecting'].includes(phase)) { this.message = 'Reconnecting…'; return; }
    if (['signed-out', 'listing-servers', 'loading-roster', 'authenticating'].includes(phase) || /authentication required/i.test(error)) {
      if (i.reloaded && now() - i.since < this.LOGIN_GRACE_MS) { this.message = 'The page was reloaded; waiting for the game to restore your login.'; return; }
      this.message = 'The login is gone (server restart?). Log in and enter your character again; the bot resumes when you are back.';
      return;
    }
    // "Your session ended while the connection was gone": the server dropped the world session (its resume window is 30 s),
    // so resuming can never work. Enter the character afresh; if that does not bring it back, reload the page, which
    // restores the login from the game's session cookie. The window's Confirm button would log out, so it is never pressed.
    // A plain "Disconnected from the server." box has no message to read. When the resume and three fresh entries have all
    // failed the login behind them is stale as well, so it gets the same treatment: enter afresh, then reload the page.
    const expired = phase === 'disconnected' && (/session ended while the connection was gone|could not resume/i.test(String(World.session?.disconnectMessage || '') + ' ' + error) || this.attempts >= 4);
    if (expired) {
      if (!this.expiredAt) { this.expiredAt = now(); Log.warn('The game session is gone (' + (this.attempts >= 4 ? 'reconnect attempts failed' : 'session ended') + '); entering the character again, then reloading the page.'); }
      else if (now() - this.expiredAt > this.EXPIRED_WAIT_MS && !this.capped()) { this.message = 'Still not back; reloading the page.'; if (this.reloadPage()) return; }
    }
    if (now() < this.nextAt || now() < this.waitUntil) return;
    const n = this.attempts++;
    // First the game's own resume, then a fresh entry with the held login.
    const sent = this.send(n === 0 && !expired ? { kind: 'reconnect' } : { kind: 'enter-world', character: i.character });
    this.nextAt = now() + this.DELAYS[Math.min(n, this.DELAYS.length - 1)];
    this.waitUntil = now() + (sent ? 8000 : 0);
    this.message = 'Reconnecting (attempt ' + (n + 1) + ')…';
    if (sent && n === 0) UI.toast('Disconnected from the game; reconnecting automatically.', 'warn', 5000);
  },
  // Back in the world: resume only what was running, and only when that is safe.
  back(i) {
    if (World.charName !== i.character) return this.clear();
    if (!this.backAt) { this.backAt = now(); this.attempts = 0; this.message = 'Back in the game; settling.'; return; }
    if (now() - this.backAt < 3000 || !World.local() || World.gp?.inventoryPending) return;
    // Killed while disconnected: start hunting so its own death handling revives the character and walks it back to the spot.
    if (i.hunting && !Hunt.running && World.isDead() && Hunt.cfg().center) {
      Hunt.start(); this.clear(Hunt.running ? '' : 'Back in the game, but the character is dead; hunting was not resumed.');
      return UI.toast(Hunt.running ? 'Back in the game, but dead; reviving and returning to the hunting spot.' : this.message, 'info', 4000);
    }
    if (!i.hunting || Hunt.running || World.isDead()) {
      this.clear(i.hunting && World.isDead() ? 'Back in the game, but the character is dead; hunting was not resumed.' : 'Back in the game.');
      return UI.toast(this.message, 'info', 4000);
    }
    // Back in town (a death while disconnected respawns there, or the drop came during a town trip) and far from the
    // hunting spot: do the town services and reverse, as after a death, instead of walking.
    const H = Hunt.cfg(), spot = H.center && World.pose() ? dist2D(World.pose(), H.center) : NaN;
    if (Town.autoRevive() && Number.isFinite(spot) && spot > Math.max(H.radius * 1.5, 600) && Town.detect()) {
      UI.toast('Back in the game, in town; doing town services and reversing to the hunting spot.', 'info', 4000);
      Controller.returnAfterRevive();
      return this.clear(Town.trip ? '' : 'Back in the game, but the town cycle could not start: ' + Town.message);
    }
    const outcome = Controller.resumeHunting('Back in the game');
    this.clear(outcome === 'stopped' ? 'Back in the game, but not at the hunting spot. Use Return & hunt when ready.' : '');
  },
};
bus.on('phase', phase => {
  if (['disconnected', 'failed', 'reconnecting'].includes(phase)) Reconnect.lost();
});
Hook.observers.push(command => Reconnect.manual(command?.kind));


// Spends skill points automatically, one confirmed training at a time: first the masteries you tick, then
// the next level of the skills in your rotations, buffs and imbue. It follows the game's own rules: a mastery
// cannot pass the character level or 120 (level 0 is free, otherwise the price is the table cost of its
// current level); a skill must be trainable, be the next level of its group, and meet its mastery,
// prerequisite, STR and INT requirements. A reserve keeps some skill points unspent.
const MASTERY_NAMES = { 257: 'Bicheon', 258: 'Heuksal', 259: 'Pacheon', 273: 'Cold', 274: 'Lightning', 275: 'Fire', 276: 'Force',
  513: 'Warrior', 514: 'Wizard', 515: 'Rogue', 516: 'Warlock', 517: 'Bard', 518: 'Cleric' };
const AutoMastery = {
  pending: null, blocked: new Map(), message: 'Auto mastery off.', lastAt: -Infinity, note: null, turn: 'masteries',
  maxAll: false, maxMessage: '', maxNote: null, total: 0, fast: 0,
  cfg() { return Settings.profile.mastery; },
  active() { const c = this.cfg(); return !!(c.enabled || c.skills || this.maxAll); },
  gap() { const g = Number(this.cfg().gap); return Number.isInteger(g) ? Math.max(0, Math.min(50, g)) : 0; },
  reserve() { const r = Number(this.cfg().reserve); return Number.isInteger(r) ? Math.max(0, r) : 0; },
  name(id) { return MASTERY_NAMES[id] || 'Mastery #' + id; },
  reset() { this.stopMax(); this.pending = null; this.blocked.clear(); this.turn = 'masteries'; this.message = this.active() ? 'Waiting for character data.' : 'Auto mastery off.'; },
  rows() { return (World.gp?.progression?.masteries || []).filter(m => m && Number.isInteger(m.id) && Number.isInteger(m.level)); },
  spare(progression) { return Number.isInteger(progression.skillPoints) ? progression.skillPoints - this.reserve() : -Infinity; },
  // Why a mastery cannot be raised right now, or '' when it can.
  reason(row, progression) {
    if (!Number.isInteger(progression.level)) return 'character level unknown';
    // The game stops a mastery at the character level (or 120); the gap keeps it that many levels below.
    const limit = Math.min(120, progression.level - this.gap());
    if (row.level >= limit) return this.gap() ? 'at your limit (' + limit + ', ' + this.gap() + ' below your level)' : 'at the character level limit';
    if (row.level === 0) return '';
    const cost = Stats.levels?.[row.level]?.masteryTrainSpCost;
    if (!Number.isInteger(cost)) return 'price unknown';
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  // Highest learned level in a skill group, 0 when none.
  groupLevel(group) { return Math.max(0, ...(World.groups.get(group) || []).filter(s => World.learned(s.id)).map(s => s.level ?? 0)); },
  // Skill groups the player already uses, in rotation order: attacks, buffs, imbue.
  wanted() {
    const m = Settings.profile.macro, groups = [], seen = new Set();
    const add = e => { const g = e?.group ?? e?.id; if (Number.isInteger(g) && !seen.has(g)) { seen.add(g); groups.push(g); } };
    for (const key of CLASS_KEYS) (m.rotations[key] || []).forEach(add);
    (m.buffs || []).forEach(add); add(m.imbue);
    // The whole learned skill line: every other skill group the character already has, after the ones it uses.
    if (this.cfg().scope === 'all') for (const g of World.groups.keys()) if (!seen.has(g) && this.groupLevel(g)) { seen.add(g); groups.push(g); }
    return groups;
  },
  skillReason(row, progression) {
    if (!row.trainable) return 'cannot be trained';
    if (World.learned(row.id)) return 'already learned';
    if (row.level !== this.groupLevel(row.group) + 1) return 'train the preceding level first';
    if ((row.masteries || []).some(r => r.ID && !progression.masteries.some(m => m.id === r.ID && m.level >= r.Level))) return 'mastery level too low';
    if ((row.prerequisites || []).some(r => r.ID && this.groupLevel(r.ID) < r.Level)) return 'prerequisite skill missing';
    if ((row.reqStr ?? 0) > (progression.stats?.strength ?? 0)) return 'strength too low';
    if ((row.reqInt ?? 0) > (progression.stats?.intellect ?? 0)) return 'intelligence too low';
    const cost = Number.isInteger(row.spCost) ? row.spCost : Infinity;
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  send(kind, id, label, extra) {
    if (!Cmd.raw({ kind, id }, label)) return false;
    this.pending = { kind, id, at: now(), error: World.gp?.trainingError, ...extra }; this.lastAt = now();
    this.message = label + '.';
    if (this.maxAll) this.maxMessage = 'Max every skill: ' + label + ' (' + this.total + ' done so far).';
    return true;
  },
  masteryStep(progression, skipped) {
    if (!this.cfg().enabled) return false;
    if (!Stats.levels) { Stats.loadLevels(); skipped.push('mastery prices loading'); return false; }
    for (const id of this.cfg().ids) {
      const row = this.rows().find(m => m.id === id);
      if (!row) continue;
      if ((this.blocked.get('m' + id) ?? 0) > now()) { skipped.push(this.name(id) + ': recently refused'); continue; }
      const why = this.reason(row, progression);
      if (why) { skipped.push(this.name(id) + ': ' + why); continue; }
      return this.send('mastery-train', id, 'Raising ' + this.name(id) + ' from ' + row.level, { level: row.level, name: this.name(id) });
    }
    return false;
  },
  skillStep(progression, skipped) {
    if (!this.cfg().skills) return false;
    if (!World.groups.size) { skipped.push('skill catalogue not loaded'); return false; }
    const groups = this.wanted();
    if (!groups.length) { skipped.push(this.cfg().scope === 'all' ? 'no learned skills found' : 'no skills in your attack rotations, buffs or imbue yet'); return false; }
    const quiet = [], name = group => World.skillName(World.bestOfGroup(group, (World.groups.get(group) || [])[0]?.id) || (World.groups.get(group) || [])[0]?.id) || 'Skill ' + group;
    const summary = () => { for (const line of quiet.slice(0, 6)) skipped.push(line); if (quiet.length > 6) skipped.push('and ' + (quiet.length - 6) + ' more skills'); };
    for (const group of groups) {
      const current = this.groupLevel(group);
      if (!current) { quiet.push(name(group) + ': not learned yet'); continue; }
      const row = (World.groups.get(group) || []).find(s => s.level === current + 1);
      if (!row) { quiet.push(name(group) + ': already at its highest level (' + current + ')'); continue; }
      const label = name(group) + ' level ' + row.level;
      if ((this.blocked.get('s' + row.id) ?? 0) > now()) { skipped.push(label + ': recently refused'); continue; }
      const why = this.skillReason(row, progression);
      if (why) { skipped.push(label + ': ' + why); continue; }
      return this.send('skill-train', row.id, 'Learning ' + label, { name: label });
    }
    summary();
    return false;
  },
  tick() {
    const c = this.cfg(), gp = World.gp;
    if (!this.active()) { this.pending = null; this.message = 'Auto mastery off.'; return; }
    const progression = gp?.progression;
    if (!World.inWorld() || World.isDead() || !progression || !Array.isArray(progression.masteries)) { this.message = 'Waiting for a living character.'; return; }
    const p = this.pending;
    if (p) {
      const mastery = p.kind === 'mastery-train', row = mastery ? this.rows().find(m => m.id === p.id) : null;
      if (mastery ? row && row.level > p.level : World.learned(p.id)) {
        this.pending = null; this.blocked.delete((mastery ? 'm' : 's') + p.id); this.turn = this.turn === 'masteries' ? 'skills' : 'masteries';
        if (!mastery) this.total++;
        if (!this.maxAll) UI.toast(mastery ? p.name + ' mastery raised to ' + row.level + '.' : p.name + ' learned.', 'info', 4000);
        this.message = mastery ? p.name + ' raised to ' + row.level + '.' : p.name + ' learned.';
      } else if (now() - p.at > 10000 || (this.maxAll && gp.trainingError !== p.error)) {
        // The server may have refused (for example its total mastery limit). Never resend blindly.
        this.pending = null; this.blocked.set((mastery ? 'm' : 's') + p.id, now() + 60000);
        this.message = p.name + ' was not accepted; trying again in a minute. ' + (gp.trainingError || '');
      } else return;
    }
    if (this.maxAll) return gp.trainingPending ? undefined : this.maxStep(progression);
    if (gp.trainingPending || gp.trainingError) {
      this.message = gp.trainingError || 'Waiting for the previous training to finish.'; return;
    }
    if (now() - this.lastAt < 1500 || !Cmd.spaced('mastery-train') || !Cmd.spaced('skill-train')) return;
    const skipped = [], order = c.order === 'skills' ? ['skills', 'masteries'] : c.order === 'alternate' ? (this.turn === 'skills' ? ['skills', 'masteries'] : ['masteries', 'skills']) : ['masteries', 'skills'];
    for (const step of order) if (step === 'masteries' ? this.masteryStep(progression, skipped) : this.skillStep(progression, skipped)) return;
    // The order setting only matters when both switches are on, so say when the skills one is off.
    if (!c.skills) skipped.push('skills are not raised: "Upgrade my rotation and buff skills automatically" is off');
    this.message = c.enabled && !c.ids.length && !c.skills ? 'Choose which masteries to raise.'
      : 'Nothing to raise (' + (skipped.slice(0, 8).join('; ') + (skipped.length > 8 ? '; and ' + (skipped.length - 8) + ' more' : '') || 'selected masteries not found') + ').';
  },
  // ---- Max every skill: one button, one job. Every skill group gets its next level until nothing more is allowed. ----
  // A mastery is raised only when it is the one thing blocking a skill. The gap and reserve settings do not apply here.
  startMax() {
    if (this.maxAll) return;
    if (!World.inWorld() || World.isDead() || !World.gp?.progression) return UI.toast('Enter the game with a living character first.', 'warn');
    if (!World.groups.size) return UI.toast('The skill catalogue is not loaded yet.', 'warn');
    this.maxAll = true; this.total = 0; this.pending = null; this.blocked.clear();
    this.message = this.maxMessage = 'Max every skill: starting.';
    Stats.loadLevels();
    this.fast = setInterval(() => this.tick(), 10);
  },
  stopMax(text) {
    if (this.fast) { clearInterval(this.fast); this.fast = 0; }
    if (!this.maxAll) return;
    this.maxAll = false; this.pending = null;
    if (text) { this.message = this.maxMessage = text; UI.toast(text, 'info', 8000); Log.info(text); }
  },
  maxStep(progression) {
    if (!Stats.levels) { Stats.loadLevels(); this.message = 'Loading mastery prices.'; return; }
    const rules = Object.create(this, { reserve: { value: () => 0 }, gap: { value: () => 0 } }), left = new Map();
    const add = why => left.set(why, (left.get(why) ?? 0) + 1);
    for (const [group, rows] of World.groups) {
      const row = rows.find(s => s.level === this.groupLevel(group) + 1);
      if (!row?.trainable) continue;
      if ((this.blocked.get('s' + row.id) ?? 0) > now()) { add('refused by the game'); continue; }
      const why = rules.skillReason(row, progression);
      if (!why) { const label = World.skillName(row.id) + ' level ' + row.level; return this.send('skill-train', row.id, 'Learning ' + label, { name: label }); }
      if (!/^mastery/.test(why)) { add(why); continue; }
      const need = (row.masteries || []).find(r => r.ID && !progression.masteries.some(m => m.id === r.ID && m.level >= r.Level));
      const mastery = progression.masteries.find(m => m.id === need?.ID), stop = mastery ? rules.reason(mastery, progression) : 'not available';
      if (mastery && !stop && (this.blocked.get('m' + mastery.id) ?? 0) <= now()) {
        return this.send('mastery-train', mastery.id, 'Raising ' + this.name(mastery.id) + ' from ' + mastery.level, { level: mastery.level, name: this.name(mastery.id) });
      }
      add(this.name(need?.ID) + ' cannot be raised: ' + (stop || 'recently refused'));
    }
    const rest = [...left].map(([why, n]) => n + ' ' + why).join(', ');
    this.stopMax('Max every skill: done, ' + this.total + ' learned or upgraded' + (rest ? '; still blocked: ' + rest : '') + '.');
  },
  status() { return this.message; },
  draw(parent) {
    const box = UI.group('Auto mastery and skills', UI.check('Raise selected masteries automatically', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.pending = null; this.blocked.clear(); }));
    const rows = this.rows();
    if (!rows.length) box.append(el('p', 'Enter the game with a character to choose masteries.', 'muted'));
    for (const row of [...rows].sort((a, b) => a.id - b.id)) {
      box.append(UI.check(this.name(row.id) + ' (Lv ' + row.level + ')', () => this.cfg().ids.includes(row.id), v => {
        const ids = this.cfg().ids.filter(id => id !== row.id);
        if (v) ids.push(row.id);
        this.cfg().ids = ids;
      }));
    }
    box.append(UI.number('Keep this many levels below my level', () => this.cfg().gap, v => this.cfg().gap = v, 0, 50),
      UI.check('Upgrade my rotation and buff skills automatically', () => this.cfg().skills, v => { this.cfg().skills = v; this.pending = null; this.blocked.clear(); }),
      UI.select('Skills to upgrade', [['rotation', 'Only skills in my rotations, buffs and imbue'], ['all', 'All skills I have learned']], () => this.cfg().scope === 'all' ? 'all' : 'rotation', v => { this.cfg().scope = v; this.pending = null; this.blocked.clear(); }),
      UI.number('Keep this many skill points unspent', () => this.cfg().reserve, v => this.cfg().reserve = v, 0, 100000000),
      UI.select('Order when both are ticked', [['masteries', 'Masteries first'], ['skills', 'Skills first'], ['alternate', 'Alternate']], () => this.cfg().order, v => this.cfg().order = v));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'Trains one level at a time and waits for each to be confirmed. Masteries are raised in the order you tick them until they reach your character level (or 120) minus the gap; level 0 is free, otherwise the price is the table cost of the current level. Skills are the next level of the attack, buff and imbue skills you already use, using the game\'s own requirements (mastery level, prerequisite skills, STR and INT, skill points). The reserve is never spent. Works while hunting is stopped and does nothing while you are dead. If the server refuses a level (for example its mastery total limit) the bot waits a minute before trying again. Off by default and saved per character.', 'muted'));
    parent.append(box);
    const max = UI.group('Max every skill', el('p', 'Learns and upgrades every skill, level by level, as fast as the game answers, and raises a mastery only when it is what blocks a skill (up to your character level, or 120). Skill points, strength and intelligence limits still apply, and it tells you what is left.', 'muted'));
    const button = UI.button(this.maxAll ? 'Stop' : 'Max every skill now', () => { if (this.maxAll) this.stopMax('Max every skill: stopped.'); else this.startMax(); button.textContent = this.maxAll ? 'Stop' : 'Max every skill now'; });
    UI.refreshers.push(() => { button.textContent = this.maxAll ? 'Stop' : 'Max every skill now'; });
    this.maxNote = el('p', this.maxMessage, 'muted'); max.append(button, this.maxNote); parent.append(max);
  },
};
// Optional features run behind the controller's guard so a bug in one can never stop hunting.
for (const [name, owner, method] of [['Party', Party, 'tick'], ['Party resurrection', Party, 'acceptResurrection'], ['Party resume', Party, 'resumeTick'], ['Auto mastery', AutoMastery, 'tick'], ['SoX alerts', Stats, 'soxFound']]) {
  const original = owner[method];
  owner[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}


// Spends the character's unspent stat points on Strength and Intelligence, one confirmed point at a time. The game's
// own stat button sends one point per press (the "stat-increase" command); a point is confirmed when the unspent count
// goes down, never because the command was sent. The split is a ratio, kept by counting what the bot itself spent.
const StatPoints = {
  pending: null, blockedUntil: 0, lastAt: -Infinity, spent: { str: 0, int: 0 }, message: 'Auto stat points off.', note: null,
  cfg() { return Settings.profile.statPoints; },
  weight(stat) { const w = Math.floor(Number(this.cfg()[stat])); return Number.isFinite(w) ? Math.min(10, Math.max(0, w)) : 0; },
  reserve() { const r = Math.floor(Number(this.cfg().reserve)); return Number.isFinite(r) ? Math.max(0, r) : 0; },
  reset() { this.pending = null; this.blockedUntil = 0; this.spent = { str: 0, int: 0 }; this.message = this.cfg().enabled ? 'Waiting for character data.' : 'Auto stat points off.'; },
  // The stat furthest behind its share; with equal progress Strength goes first. Null when both weights are zero.
  pick() {
    const s = this.weight('str'), i = this.weight('int');
    if (!s && !i) return null;
    if (!i) return 'str';
    if (!s) return 'int';
    return this.spent.str * i <= this.spent.int * s ? 'str' : 'int';
  },
  tick() {
    const c = this.cfg(), progression = World.gp?.progression;
    if (!c.enabled) { this.pending = null; this.message = 'Auto stat points off.'; return; }
    if (!World.inWorld() || World.isDead() || !progression) { this.message = 'Waiting for a living character.'; return; }
    const points = progression.statPoints;
    if (!Number.isInteger(points)) { this.message = 'Stat points are not known yet.'; return; }
    const p = this.pending;
    if (p) {
      if (points < p.before) {
        this.spent[p.stat]++; this.pending = null;
        this.message = `+1 ${p.stat === 'str' ? 'Strength' : 'Intelligence'} (${points} point${points === 1 ? '' : 's'} left).`;
      } else if (now() - p.at > 5000) {
        // Never resend blindly: the server may have refused (for example at a stat limit).
        this.pending = null; this.blockedUntil = now() + 60000;
        this.message = `The ${p.stat === 'str' ? 'Strength' : 'Intelligence'} point was not accepted; trying again in a minute.`;
      } else return;
    }
    if (now() < this.blockedUntil) return;
    if (!points) { this.message = 'No stat points to spend.'; return; }
    if (points <= this.reserve()) { this.message = `Keeping ${points} stat point${points === 1 ? '' : 's'} unspent (your reserve is ${this.reserve()}).`; return; }
    const stat = this.pick();
    if (!stat) { this.message = 'Set a Strength or Intelligence share above zero.'; return; }
    if (now() - this.lastAt < 500 || !Cmd.spaced('stat-increase')) return;
    if (Cmd.raw({ kind: 'stat-increase', stat }, 'Stat point: +1 ' + (stat === 'str' ? 'Strength' : 'Intelligence'))) {
      this.pending = { stat, before: points, at: now() }; this.lastAt = now();
      this.message = `Adding a ${stat === 'str' ? 'Strength' : 'Intelligence'} point; waiting for the game to confirm.`;
    }
  },
  status() { return this.message; },
  draw(parent) {
    const box = UI.group('Stat points', UI.check('Spend stat points automatically', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.pending = null; this.blockedUntil = 0; }));
    box.append(UI.number('Strength share', () => this.cfg().str, v => this.cfg().str = v, 0, 10),
      UI.number('Intelligence share', () => this.cfg().int, v => this.cfg().int = v, 0, 10),
      UI.number('Keep this many points unspent', () => this.cfg().reserve, v => this.cfg().reserve = v, 0, 65535));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'Spends one point at a time and waits for the game to confirm it. The shares are a ratio: 1 and 0 puts everything into Strength, 0 and 1 everything into Intelligence, 2 and 1 spends two Strength points for every Intelligence point. The ratio counts only points this bot spent since it loaded, so points you added yourself do not change it.', 'muted'));
    parent.append(box);
  },
};
for (const [name, method] of [['Auto stat points', 'tick']]) {
  const original = StatPoints[method];
  StatPoints[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}


// Follow a party member ("trace"). The game tells every party member where the others are (region and position), so the
// bot always knows where the chosen member is. While hunting it keeps within a set distance of them and hunts around
// THEM instead of around the saved hunting spot: the saved spot is only swapped for the member's position while the
// hunting step runs, never stored. Nothing changes unless the switch is on, and a member who is not in the party,
// is in another area, or is too far away leaves the bot hunting at its own spot.
const TRACE_LIMIT = { sendMs: 900, farUnits: 3000 };
const Trace = {
  message: 'Following off.', code: 'off', sentAt: -Infinity, travel: null, walking: false, note: null,
  cfg() { return Settings.profile.trace; },
  active() { return !!this.cfg().enabled && Hunt.running; },
  social() { return World.gp?.social; },
  // The member to follow: the chosen name, or the party leader when no name is chosen. Never yourself.
  member() {
    const social = this.social(), name = String(this.cfg().name || '').trim();
    if (!social || !Array.isArray(social.members)) return null;
    const others = social.members.filter(m => m && m.name && m.name !== social.localName);
    if (name) return others.find(m => m.name === name) || null;
    return others.find(m => m.id === social.leader) || null;
  },
  position(m) { return Number.isInteger(m?.region) && [m.x, m.z].every(Number.isFinite) ? { regionId: m.region, x: m.x, y: Number(m.y) || 0, z: m.z } : null; },
  // A point on the line from the member towards us, `keep` units from the member, so we stop beside them, not on them.
  beside(pos, from, keep) {
    const d = regionDelta(pos, from), length = Math.hypot(...d);
    if (!length || length <= keep) return from;
    const k = keep / length, x = pos.x + d[0] * k, z = pos.z + d[1] * k, sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR);
    return { regionId: ((pos.regionId & 255) + sx) | (((pos.regionId >>> 8) + sz) << 8), x: x - sx * SECTOR, y: pos.y, z: z - sz * SECTOR };
  },
  reset() { this.travel = null; this.walking = false; this.sentAt = -Infinity; this.message = this.cfg().enabled ? 'Waiting for the party.' : 'Following off.'; this.code = this.cfg().enabled ? 'waiting' : 'off'; },
  say(text, code) { this.message = text; this.code = code; return false; },
  // True when this tick belonged to the follower (it walked, or hunted around the member); false leaves the tick to the
  // normal hunting step at the saved spot.
  tick() {
    const c = this.cfg();
    this.walking = false;
    if (!c.enabled) { this.message = 'Following off.'; this.code = 'off'; return false; }
    if (!Hunt.running || !World.inWorld() || World.isDead()) return this.say('Waiting for a living character.', 'waiting');
    const member = this.member();
    if (!member) return this.say(c.name ? `${c.name} is not in your party; hunting at the saved spot.` : 'No party leader to follow (you lead, or you are not in a party); hunting at the saved spot.', 'no-member');
    if (member.status !== undefined && (member.status & 15) === 0) return this.say(`${member.name} is dead; hunting at the saved spot until they are back.`, 'member-dead');
    const pos = this.position(member), me = World.pose();
    if (!pos || !me) return this.say(`${member.name}'s position is not known yet; hunting at the saved spot.`, 'no-position');
    const delta = regionDelta(me, pos);
    if (!delta) return this.say(`${member.name} is in another area; hunting at the saved spot.`, 'other-area');
    const distance = Math.hypot(...delta), keep = Math.max(30, Number(c.distance) * 10 || 120);
    if (distance > TRACE_LIMIT.farUnits) return this.say(`${member.name} is ${Math.round(distance / 10)} m away, too far to follow; hunting at the saved spot.`, 'too-far');
    const attacked = c.fight && Hunt.underAttack() && distance <= keep * 3;
    // Close enough, or fighting something that attacks us: hunt around the member.
    if (distance <= keep || attacked) {
      this.travel = null;
      const H = Hunt.cfg(), real = H.center;
      H.center = { regionId: pos.regionId, x: pos.x, y: pos.y, z: pos.z };
      try { Hunt.tick(); } finally { H.center = real; }
      this.message = `Hunting around ${member.name} (${Math.round(distance / 10)} m away).`; this.code = 'hunting-around';
      return true;
    }
    // Too far: walk to them. Sitting or casting is left to the hunting step.
    if (World.isSitting() || World.isCasting()) return false;
    this.walking = true; Hunt.state = 'follow';
    if (Hunt.targetGid) { Hunt.targetGid = 0; }
    const goal = this.beside(pos, me, Math.max(30, keep * 0.6));
    let point = goal, straight = false;
    if (Navigation.scene && !((me.regionId | goal.regionId) & DUNGEON)) {
      const move = Navigation.next(this, goal, false, Math.max(40, keep * 0.4));
      if (move.point) point = move.point;
      else if (move.error && !move.waiting) straight = true;
    }
    if (now() - this.sentAt >= TRACE_LIMIT.sendMs && Cmd.move(point)) this.sentAt = now();
    this.code = 'walking';
    this.message = `Following ${member.name}: ${Math.round(distance / 10)} m away` + (straight ? '; no walkable route in the collision map, walking straight.' : '.');
    return true;
  },
  status() { return this.message; },
  names() {
    const social = this.social();
    return (Array.isArray(social?.members) ? social.members : []).filter(m => m?.name && m.name !== social.localName).map(m => [m.name, m.name + (m.id === social.leader ? ' (leader)' : '')]);
  },
  draw(parent) {
    const box = UI.group('Follow a party member', UI.check('Follow a party member while hunting', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.reset(); }));
    box.append(UI.select('Follow', () => [['', 'The party leader'], ...this.names(), ...(this.cfg().name && !this.names().some(n => n[0] === this.cfg().name) ? [[this.cfg().name, this.cfg().name + ' (not in the party now)']] : [])], () => this.cfg().name || '', v => { this.cfg().name = v; this.reset(); }),
      UI.number('Stay within (m)', () => this.cfg().distance, v => this.cfg().distance = v, 3, 60),
      UI.check('Fight monsters that attack on the way', () => this.cfg().fight, v => this.cfg().fight = v));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'While hunting the bot stays within this distance of the member and hunts around them, not around your saved hunting spot (that stays saved and is used again when following is off or the member is unavailable). The game tells the party where its members are, so it also follows them across the map, up to 300 m. It does not follow into another area, a dungeon or a teleport. Town trips, resurrection and walk-back still work as before and bring you back to your saved spot.', 'muted'));
    parent.append(box);
  },
};
for (const [name, method] of [['Follow party member', 'tick']]) {
  const original = Trace[method];
  Trace[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}


// Sharing settings. A share code or file holds only what differs from the defaults and nothing personal: positions,
// town and merchant points, walking routes, buff weapon sets and the wardrobe stay out. Importing never runs
// anything: the text is parsed as data, every field is checked against the defaults, and a preview lists the changes
// before anything is applied. The previous settings are kept so one press undoes an import.
const SHARE = { apps: ['nixxane-bot', 'sro-bot-lean'], format: 1, maxChars: 300000, maxNodes: 20000, plain: 'nixxane0:', packed: 'nixxane1:' };
const ProfileShare = {
  pending: null, code: '', message: '', note: null, view: null, box: null,
  isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); },
  clone(v) { return JSON.parse(JSON.stringify(v)); },
  // The fields that mean nothing on another character; an import keeps the importer's own.
  personal(p) {
    const r = p.potion.restock, t = r.town;
    return this.clone({ center: p.hunt.center, vendor: r.vendor, route: r.route, offers: r.offers,
      town: { arrival: t.arrival, storage: t.storage, vendor: t.vendor, smith: t.smith, gate: t.gate }, buffSets: p.macro.buffSets, wardrobe: p.wardrobe, follow: p.trace.name });
  },
  restore(p, own) {
    const r = p.potion.restock, t = r.town;
    p.hunt.center = own.center; r.vendor = own.vendor; r.route = own.route; r.offers = own.offers;
    Object.assign(t, own.town); p.macro.buffSets = own.buffSets; p.wardrobe = own.wardrobe; p.trace.name = own.follow;
    // A buff assigned to a weapon set means nothing without the sets.
    for (const b of p.macro.buffs) if (b && !p.macro.buffSets.some(s => s.id === Number(b.gearSet))) b.gearSet = 0;
    return p;
  },
  strip(p) {
    const q = this.clone(p), d = this.clone(DEFAULT_PROFILE);
    this.restore(q, this.personal(d));
    return q;
  },
  // Only what differs from the defaults, so a code stays short and a default is never "shared".
  diff(value, base) {
    if (Array.isArray(base) || !this.isMap(base)) return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
    const out = {};
    for (const k of Object.keys(value || {})) {
      const d = this.diff(value[k], k in base ? base[k] : undefined);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  },
  // Untrusted text: no prototype keys, bounded depth and size.
  safe(value, depth = 0, count = { n: 0 }) {
    if (++count.n > SHARE.maxNodes || depth > 12) return false;
    if (Array.isArray(value)) return value.every(v => this.safe(v, depth + 1, count));
    if (!value || typeof value !== 'object') return true;
    return Object.keys(value).every(k => !['__proto__', 'constructor', 'prototype'].includes(k) && this.safe(value[k], depth + 1, count));
  },
  // Every field takes the default's type; unknown fields are dropped, except in the settings that are maps by design
  // (item rules, per-kind collectors, attribute targets).
  conform(base, value) {
    if (Array.isArray(base)) return Array.isArray(value) && value.length <= 500 ? this.clone(value) : this.clone(base);
    if (base === null) return value === null || this.isMap(value) || ['number', 'boolean', 'string'].includes(typeof value) ? this.clone(value ?? null) : null;
    if (this.isMap(base)) {
      const source = this.isMap(value) ? value : {}, out = {};
      if (!Object.keys(base).length) {
        for (const k of Object.keys(source).slice(0, 5000)) if (/^[\w.:-]{1,64}$/.test(k) && source[k] !== undefined) out[k] = this.clone(source[k]);
        return out;
      }
      for (const k of Object.keys(base)) out[k] = this.conform(base[k], source[k]);
      return out;
    }
    if (typeof base === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : base;
    if (typeof base === 'string') return typeof value === 'string' ? value.slice(0, 500) : base;
    return typeof value === typeof base ? value : base;
  },
  // The settings an import would leave you with: the shared ones, plus your own positions and wardrobe.
  build(imported) {
    const own = this.personal(Settings.profile);
    return this.restore(botProfile(this.conform(DEFAULT_PROFILE, imported)), own);
  },
  // Starter settings: changes laid over the current settings (arrays are replaced, everything else you have stays).
  overlay(settings) { return botProfile(deepMerge(this.clone(Settings.profile), settings)); },
  text(share = true) {
    const profile = this.diff(share ? this.strip(Settings.profile) : Settings.profile, DEFAULT_PROFILE) || {};
    return JSON.stringify({ app: SHARE.apps[0], format: SHARE.format, version: VERSION, profile }, null, share ? 0 : 2);
  },
  // Text <-> bytes <-> base64 without relying on browser-only helpers.
  bytes(text) { return Uint8Array.from(unescape(encodeURIComponent(text)), c => c.charCodeAt(0)); },
  string(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096)); return decodeURIComponent(escape(s)); },
  toBase64(bytes) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += a[n >> 18 & 63] + a[n >> 12 & 63] + (i + 1 < bytes.length ? a[n >> 6 & 63] : '') + (i + 2 < bytes.length ? a[n & 63] : '');
    }
    return out;
  },
  fromBase64(text) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', out = [];
    const clean = text.replace(/[\s=]/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (/[^A-Za-z0-9_-]/.test(clean) || clean.length % 4 === 1) throw Error('The share code is damaged.');
    for (let i = 0; i < clean.length; i += 4) {
      const n = [0, 1, 2, 3].map(j => i + j < clean.length ? a.indexOf(clean[i + j]) : 0).reduce((x, v) => (x << 6) | v, 0);
      out.push(n >> 16 & 255); if (i + 2 < clean.length) out.push(n >> 8 & 255); if (i + 3 < clean.length) out.push(n & 255);
    }
    return Uint8Array.from(out);
  },
  async pipe(bytes, stream) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SHARE.maxChars) { reader.cancel(); throw Error('The share code is too large.'); }
      parts.push(value);
    }
    const out = new Uint8Array(size); let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  },
  async encode(json) {
    try {
      if (typeof CompressionStream === 'function') return SHARE.packed + this.toBase64(await this.pipe(this.bytes(json), new CompressionStream('deflate-raw')));
    } catch {}
    return SHARE.plain + this.toBase64(this.bytes(json));
  },
  async decode(input) {
    const text = String(input || '').trim();
    if (!text) throw Error('Paste a share code or choose a settings file first.');
    if (text.length > SHARE.maxChars) throw Error('That is too large to be a settings share.');
    if (text.startsWith(SHARE.packed)) {
      if (typeof DecompressionStream !== 'function') throw Error('This browser cannot open compressed share codes.');
      return this.string(await this.pipe(this.fromBase64(text.slice(SHARE.packed.length)), new DecompressionStream('deflate-raw')));
    }
    if (text.startsWith(SHARE.plain)) return this.string(this.fromBase64(text.slice(SHARE.plain.length)));
    return text;
  },
  async parse(input) {
    let data;
    try { data = JSON.parse(await this.decode(input)); } catch (e) { throw Error(/share|paste|large|browser/i.test(e.message) ? e.message : 'That is not a nixxane bot settings share.'); }
    if (!this.isMap(data) || !SHARE.apps.includes(data.app) || !this.isMap(data.profile)) throw Error('That is not a nixxane bot settings share.');
    if (!this.safe(data.profile)) throw Error('That settings share contains values that are not allowed.');
    return data.profile;
  },
  // path -> value for every setting, so two profiles can be compared one setting at a time.
  flat(value, path = '', out = new Map()) {
    if (this.isMap(value)) { for (const k of Object.keys(value)) this.flat(value[k], path ? path + '.' + k : k, out); if (!Object.keys(value).length && path) out.set(path, '{}'); }
    else out.set(path, JSON.stringify(value));
    return out;
  },
  changes(current, next) {
    const a = this.flat(current), b = this.flat(next), rows = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) rows.push({ path: k, from: a.get(k) ?? '(not set)', to: b.get(k) ?? '(not set)' });
    return rows;
  },
  show(v) { const s = String(v); return s.length > 50 ? s.slice(0, 47) + '…' : s; },
  async preview(input) {
    const imported = await this.parse(input), next = this.build(imported), rows = this.changes(Settings.profile, next);
    return { imported, next, rows };
  },
  backupKey() { return 'backup:' + Settings.profileKey; },
  hasBackup() { return !!Store.get(this.backupKey(), null)?.profile; },
  apply() {
    const p = this.pending;
    if (!p) return false;
    if (Hunt.running) { UI.toast('Stop hunting before importing settings.', 'warn'); return false; }
    const next = p.preset ? this.overlay(p.preset) : this.build(p.imported);
    Store.set(this.backupKey(), { at: Date.now(), profile: this.clone(Settings.profile) });
    stopAll();
    Settings.profile = next; Settings.saveProfile();
    this.pending = null; this.message = `Imported ${p.rows.length} setting${p.rows.length === 1 ? '' : 's'}. Your previous settings are kept: press Undo last import to go back.`;
    bus.emit('profile'); UI.toast(this.message); return true;
  },
  undo() {
    const backup = Store.get(this.backupKey(), null);
    if (!backup?.profile) { UI.toast('There is no import to undo.', 'warn'); return false; }
    if (Hunt.running) { UI.toast('Stop hunting before undoing an import.', 'warn'); return false; }
    stopAll();
    Settings.profile = botProfile(backup.profile); Settings.saveProfile();
    Store.set(this.backupKey(), null); this.pending = null; this.message = 'Your settings from before the import are back.';
    bus.emit('profile'); UI.toast(this.message); return true;
  },
  summary(rows) {
    if (!rows.length) return 'These settings match what you have now; nothing would change.';
    const groups = {};
    for (const r of rows) { const g = r.path.split('.')[0]; groups[g] = (groups[g] || 0) + 1; }
    return `${rows.length} setting${rows.length === 1 ? '' : 's'} would change (${Object.entries(groups).map(([g, n]) => g + ' ' + n).join(', ')}). Your positions, town points, routes, buff weapon sets and wardrobe stay as they are.`;
  },
  draw(parent) {
    const box = UI.group('Share and import settings');
    const area = el('textarea'); area.rows = 4; area.placeholder = 'Paste a share code or the contents of a settings file here';
    const out = el('textarea'); out.rows = 3; out.readOnly = true; out.hidden = true; out.setAttribute('aria-label', 'Your share code');
    const file = el('input'); file.type = 'file'; file.accept = '.json,application/json,text/plain'; file.hidden = true;
    const status = el('p', this.message, 'muted'), changes = el('pre'); changes.hidden = true;
    const apply = UI.button('Apply import', () => { if (this.apply()) UI.draw(); }), cancel = UI.button('Cancel', () => { this.pending = null; changes.hidden = apply.hidden = cancel.hidden = true; status.textContent = ''; });
    apply.hidden = cancel.hidden = true;
    const say = text => { this.message = text; status.textContent = text; };
    file.addEventListener('change', () => {
      const f = file.files?.[0]; if (!f) return;
      if (f.size > SHARE.maxChars) return say('That file is too large to be a settings share.');
      const reader = new FileReader();
      reader.onload = () => { area.value = String(reader.result || ''); say('File loaded. Press Preview import.'); };
      reader.onerror = () => say('The file could not be read.');
      reader.readAsText(f);
    });
    const copy = async () => {
      out.value = await this.encode(this.text(true)); out.hidden = false; out.select();
      try { await W.navigator.clipboard.writeText(out.value); say('Share code copied. It holds only your settings, not your positions or town points.'); }
      catch { say('Select the code above and copy it. It holds only your settings, not your positions or town points.'); }
    };
    box.append(el('p', 'Share your settings with others, or load settings someone shared. A share holds only what you changed from the defaults: never your positions, town points, routes, buff weapon sets or wardrobe. An import shows what it would change first, never touches those, and can be undone.', 'muted'),
      UI.row(UI.button('Copy share code', () => { void copy(); }), UI.button('Save share file', () => {
        const url = URL.createObjectURL(new Blob([this.text(true)], { type: 'application/json' }));
        const link = el('a'); link.href = url; link.download = 'nixxane-bot-share.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })), out, area,
      UI.row(UI.button('Open file…', () => file.click()), UI.button('Preview import', async () => {
        try {
          const p = await this.preview(area.value); this.pending = p;
          changes.textContent = p.rows.slice(0, 60).map(r => `${r.path}: ${this.show(r.from)} → ${this.show(r.to)}`).join('\n') + (p.rows.length > 60 ? `\n… and ${p.rows.length - 60} more` : '');
          changes.hidden = !p.rows.length; apply.hidden = cancel.hidden = !p.rows.length; say(this.summary(p.rows));
        } catch (e) { this.pending = null; changes.hidden = apply.hidden = cancel.hidden = true; say(e.message); }
      })), file, status, changes, UI.row(apply, cancel),
      UI.button('Undo last import', () => { if (this.undo()) UI.draw(); }));
    this.note = status; parent.append(box);
  },
};


// The Setup page: a live checklist of what the bot needs before F8 is worth pressing. Every row reads the real state of
// the character and the settings, says in a sentence what is missing, and has one button that fixes it or opens the right
// page. Nothing changes unless a button is pressed. The starter settings are changes laid over the current settings, shown
// first and undoable like an import.
const SETUP_PRESETS = {
  levelup: { name: 'Level up', text: 'Kills normal, champion and giant monsters, picks up gold, gear and elixirs only.',
    settings: { hunt: { radius: 400, classes: { normal: true, champion: true, giant: true, party: false, elite: false, unique: false, titan: false },
      pickup: { enabled: true, gold: true, potions: false, equipment: true, elixirs: true, powders: false, magicStones: false, attrStones: false, alchemy: false, others: false } } } },
  drops: { name: 'Farm drops', text: 'Also fights elite monsters, roams wider and picks up everything.',
    settings: { hunt: { radius: 600, classes: { normal: true, champion: true, giant: true, party: false, elite: true, unique: false, titan: false },
      pickup: { enabled: true, gold: true, potions: true, equipment: true, elixirs: true, powders: true, magicStones: true, attrStones: true, alchemy: true, others: true } } } },
  safe: { name: 'Safe AFK', text: 'Stops on death, a full bag or no potions, warns about other players and rests earlier.',
    settings: { hunt: { onDeath: 'stop', stopNoHpPotion: true, stopInvFull: true, playerAlert: { enabled: true, radius: 250, pause: true },
      sit: { enabled: true, hpBelow: 40, mpBelow: 25, resumeAt: 90 }, antiStuck: { enabled: true, minutes: 3, maxRecoveries: 3 } },
      potion: { hp: { on: true, pct: 65 }, mp: { on: true, pct: 40 } } } },
};
const Setup = {
  box: null, rows: null, score: null, key: '', townPick: '', preview: null, previewNote: null, previewList: null,
  // Skill groups in all attack rotations.
  skills() {
    const seen = new Set();
    for (const key of CLASS_KEYS) for (const e of Settings.profile.macro.rotations[key] || []) seen.add(e.group ?? e.id);
    return seen.size;
  },
  potions() { return World.items().filter(i => ItemType.isPotion(i.typeFlags)).reduce((n, i) => n + (i.quantity || 0), 0); },
  town() { return this.townPick || Town.detect()?.key || Town.towns[0].key; },
  open(page, tab) { UI.show(page, tab); },
  // The checklist. `state` is ok, warn (works but could be better) or bad (the bot cannot do its job yet).
  steps() {
    const p = Settings.profile, H = p.hunt, T = Town.cfg(), inWorld = World.inWorld(), gp = World.gp;
    const weapon = (gp?.inventory || []).find(i => i.slot === 6), out = [];
    out.push(inWorld
      ? { id: 'character', icon: 'action\\icon_cha_helper', state: weapon ? 'ok' : 'warn', title: 'Character found',
          text: `${World.charName || 'Your character'}${Number.isInteger(gp?.progression?.level) ? ' · Lv ' + gp.progression.level : ''}${weapon ? ' · ' + (weapon.name || Items.name(weapon.refObjId)) : ' · no weapon equipped, equip one before hunting'}.` }
      : { id: 'character', icon: 'action\\icon_cha_helper', state: 'bad', title: 'Character', text: 'Enter the game with a character first; everything below reads from it.' });
    out.push(H.center
      ? { id: 'spot', icon: 'item\\etc\\mall_return_scroll', state: 'ok', title: 'Hunting spot', text: `Saved, roaming up to ${Math.round(H.radius / 10)} m around it.`, action: { label: 'Move here', run: () => { if (World.inWorld() && Hunt.setCenter()) UI.toast('Hunting spot saved.'); } } }
      : { id: 'spot', icon: 'item\\etc\\mall_return_scroll', state: 'bad', title: 'Hunting spot', text: 'No spot saved. Stand where you want to hunt, then press the button.', action: { label: 'Set here', run: () => { if (World.inWorld() && Hunt.setCenter()) UI.toast('Hunting spot saved.'); } } });
    const skills = this.skills();
    out.push(skills
      ? { id: 'skills', icon: 'action\\icon_cha_auto_attack', state: 'ok', title: 'Attack skills', text: `${skills} skill${skills === 1 ? '' : 's'} in the rotations.`, action: { label: 'Review', run: () => this.open('Combat', 'Skills') } }
      : { id: 'skills', icon: 'action\\icon_cha_auto_attack', state: p.macro.normalAttack ? 'warn' : 'bad', title: 'Attack skills',
          text: p.macro.normalAttack ? 'No skills picked, so the bot only uses normal attacks. Pick your attack skills.' : 'No skills picked and normal attacks are off, so the bot cannot attack.', action: { label: 'Pick skills', run: () => this.open('Combat', 'Skills') } });
    const potions = this.potions();
    out.push(!p.potion.enabled
      ? { id: 'potions', icon: 'action\\icon_cha_recovery', state: 'warn', title: 'Potions', text: 'Automatic potion use is off.', action: { label: 'Turn on', run: () => { p.potion.enabled = true; Settings.saveProfile(); UI.draw(); } } }
      : { id: 'potions', icon: 'action\\icon_cha_recovery', state: potions ? 'ok' : 'warn', title: 'Potions', text: potions ? `On at ${p.potion.hp.pct}% HP and ${p.potion.mp.pct}% MP, ${potions} in the bag.` : 'On, but there are no potions in the bag.', action: { label: 'Review', run: () => this.open('Supplies') } });
    out.push(H.pickup.enabled
      ? { id: 'pickup', icon: 'action\\icon_cha_autoget', state: 'ok', title: 'What to pick up', text: Loot.categories.filter(k => H.pickup[k]).length + ' of ' + Loot.categories.length + ' kinds of drops are picked up.', action: { label: 'Change', run: () => this.open('Loot') } }
      : { id: 'pickup', icon: 'action\\icon_cha_autoget', state: 'warn', title: 'What to pick up', text: 'Picking up is off, so drops stay on the ground.', action: { label: 'Turn on', run: () => { H.pickup.enabled = true; Settings.saveProfile(); UI.draw(); } } });
    const error = T.enabled ? Town.validate() : '';
    out.push(T.enabled
      ? { id: 'town', icon: 'item\\etc\\mall_return_scroll', state: error ? 'bad' : 'ok', title: 'Town trips', text: error || 'Ready: the bot returns to town to repair and restock, then comes back.', action: { label: error ? 'Fix' : 'Review', run: () => this.open('Town') } }
      : { id: 'town', icon: 'item\\etc\\mall_return_scroll', state: 'warn', title: 'Town trips', text: 'Off. Pick your town below to let the bot repair, restock potions and store loot by itself (needs return and reverse return scrolls).', action: { label: 'Set up town', run: () => this.setupTown() } });
    out.push(Loot.pet()
      ? { id: 'pet', icon: 'action\\icon_cha_helper', state: 'ok', title: 'Pet', text: 'A pet is out. ' + (Loot.petMode() ? 'It collects the drops.' : 'You collect the drops yourself.'), action: { label: 'Change', run: () => this.open('Loot') } }
      : { id: 'pet', icon: 'action\\icon_cha_helper', state: 'warn', title: 'Pet', text: 'No pet is out. A pickup pet collects drops for you (optional).' });
    const alert = H.playerAlert.enabled;
    out.push({ id: 'safety', icon: 'action\\icon_cha_sit', state: H.onDeath === 'stop' || Town.autoRevive() || H.onDeath === 'revive' ? 'ok' : 'warn', title: 'When things go wrong',
      text: `On death: ${Town.autoRevive() ? 'revive in town and return' : H.onDeath === 'revive' ? 'revive where you died' : 'stop'}. Player alert is ${alert ? 'on' : 'off'}.`, action: { label: 'Safe preset', run: () => this.choose('safe') } });
    return out;
  },
  setupTown() {
    const done = Town.autoSetup(true, this.town());
    if (!done) return;
    const T = Town.cfg(), error = Town.validate();
    if (!error) { T.enabled = true; Settings.saveProfile(); UI.toast('Town trips are on for ' + done.town + '.'); }
    else UI.toast(`${done.town} is saved. Still needed before town trips can run: ${error}`, 'warn', 9000);
    UI.draw();
  },
  nextFix() { return this.steps().find(s => s.state === 'bad' && s.action) || this.steps().find(s => s.state === 'warn' && s.action); },
  // Starter settings: laid over the current ones, previewed, applied once, undoable.
  choose(id) {
    const preset = SETUP_PRESETS[id], next = ProfileShare.overlay(preset.settings), rows = ProfileShare.changes(Settings.profile, next);
    this.preview = { id, preset, rows, next }; ProfileShare.pending = { preset: preset.settings, next, rows };
    if (!UI.is('Setup')) this.open('Setup'); else this.drawPreview();
  },
  drawPreview() {
    if (!this.previewNote) return;
    const p = this.preview;
    this.previewNote.textContent = !p ? '' : p.rows.length ? `${p.preset.name}: ${p.rows.length} setting${p.rows.length === 1 ? '' : 's'} would change. Nothing changes until you press Apply.` : `${p.preset.name}: these settings are already what you have.`;
    this.previewList.textContent = p ? p.rows.slice(0, 40).map(r => `${r.path}: ${ProfileShare.show(r.from)} → ${ProfileShare.show(r.to)}`).join('\n') + (p.rows.length > 40 ? `\n… and ${p.rows.length - 40} more` : '') : '';
    this.previewList.hidden = !p || !p.rows.length; this.apply.hidden = this.cancel.hidden = !p || !p.rows.length;
  },
  signature() { return JSON.stringify(this.steps().map(s => [s.id, s.state, s.text])); },
  render() {
    if (!this.rows) return;
    const steps = this.steps(), ok = steps.filter(s => s.state === 'ok').length;
    this.score.textContent = `${ok} of ${steps.length} ready` + (ok === steps.length ? '. Press F8 to start.' : ok >= steps.length - 2 && steps.every(s => s.state !== 'bad') ? '. Good to go; the rest is optional.' : '. Fix the red items first.');
    this.rows.replaceChildren(...steps.map(s => {
      const icon = el('span', '', 'skill-icon sx-ico'); Icons.paint(icon, s.icon);
      const text = el('div', null, 'sx-text'); text.append(el('strong', s.title), el('span', s.text, 'muted'));
      const row = el('div', null, 'sx-row sx-' + s.state); row.append(icon, text);
      if (s.action) row.append(UI.button(s.action.label, () => s.action.run()));
      return row;
    }));
    this.key = this.signature();
  },
  // Rebuilt only when a row's state or text changes, so buttons are not replaced under the pointer.
  refresh() { if (UI.is('Setup') && this.rows && this.signature() !== this.key) this.render(); },
  isNew() { const p = Settings.profile; return !p.hunt.center && !this.skills() && !Store.get('setup:seen', false); },
  draw(parent) {
    this.score = el('p', '', 'sx-score');
    const hero = UI.group('Ready to hunt?', this.score,
      UI.row(UI.button('Fix the next thing', () => { const s = this.nextFix(); if (s) s.action.run(); else UI.toast('Nothing left to fix. Press F8 to start.'); }), UI.button('Re-scan', () => this.render())),
      el('p', 'This page only reads your settings and the game. Each button changes one thing and says what it did.', 'muted'));
    this.rows = el('div', null, 'sx-rows');
    const townBox = UI.select('Town for "Set up town"', Town.towns.map(t => [t.key, t.name]), () => this.town(), v => { this.townPick = v; });
    const list = UI.group('Checklist', this.rows, townBox);
    this.previewNote = el('p', '', 'muted'); this.previewList = el('pre'); this.previewList.hidden = true;
    this.apply = UI.button('Apply', () => { if (ProfileShare.apply()) { this.preview = null; UI.draw(); } });
    this.cancel = UI.button('Cancel', () => { this.preview = null; ProfileShare.pending = null; this.drawPreview(); });
    this.apply.hidden = this.cancel.hidden = true;
    const presets = UI.group('Starter settings', el('p', 'Quick starting points. Each one is laid over your current settings, so your skills, hunting spot and town stay. You see every change first and can undo it.', 'muted'),
      UI.row(...Object.keys(SETUP_PRESETS).map(id => UI.button(SETUP_PRESETS[id].name, () => this.choose(id)))),
      ...Object.values(SETUP_PRESETS).map(s => el('p', s.name + ': ' + s.text, 'muted')),
      this.previewNote, this.previewList, UI.row(this.apply, this.cancel),
      UI.button('Undo last change', () => { if (ProfileShare.undo()) UI.draw(); }),
      el('p', 'Have settings from someone else? Settings → Share and import settings.', 'muted'));
    parent.append(hero, list, presets);
    this.render(); this.drawPreview();
    Store.set('setup:seen', true);
  },
};


// Automatic HP recovery kits for your attack and pickup pets. Kits are companion items (type 3/3/1/4): the game
// needs the pet named in the item-use command, so this sends it explicitly. Player potions always go first, kits
// are never resent until the previous one is seen to be consumed, and a pet that cannot be healed is left alone
// for 30 seconds instead of burning kits.
const PetPotion = {
  maxHp: null, loading: null, retryAt: 0, pending: null, blocked: new Map(), lastAt: -Infinity, message: 'Pet potions off.',
  cfg() { return Settings.profile.potion.petHp; },
  reset() { this.pending = null; this.blocked.clear(); this.lastAt = -Infinity; this.message = this.cfg().on ? 'Waiting for a pet.' : 'Pet potions off.'; },
  kits() { return World.items().filter(i => Number.isInteger(i.typeFlags) && ItemType.potionCategory(i.typeFlags) === 4 && (i.quantity ?? 1) > 0); },
  total(ref) { return this.kits().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  heal(item) { return Number(item.tooltip?.fields?.itemParam1_29c) || 0; },
  // The catalogue gives each pet's maximum HP; the live vitals row is preferred when the game publishes one.
  async load() {
    if (this.maxHp || this.loading || now() < this.retryAt || !W.location?.origin) return;
    this.retryAt = now() + 30000;
    this.loading = Icons.request('/assets/data/cosPresentation.json', 'json').then(data => {
      const rows = data?.rows;
      if (!rows || typeof rows !== 'object') throw Error('Invalid pet catalogue');
      this.maxHp = new Map(Object.entries(rows).filter(([, row]) => Array.isArray(row) && Number.isInteger(row[1]) && row[1] > 0).map(([id, row]) => [Number(id), row[1]]));
    }).catch(() => {}).finally(() => { this.loading = null; });
    return this.loading;
  },
  // Living attack (band 3) and pickup (band 4) pets with their HP as a percentage; unknown maximums are skipped.
  pets() {
    const out = [];
    for (const rec of World.gp?.cosRecords || []) {
      if (!rec || rec.dead || !(rec.hp > 0) || (rec.band !== 3 && rec.band !== 4) || !Number.isInteger(rec.gid) || rec.gid <= 0) continue;
      const vital = World.vitalsOf(rec.gid), max = vital?.maxHp > 0 ? vital.maxHp : this.maxHp?.get(rec.refObjId);
      if (!(max > 0)) continue;
      const hp = vital?.maxHp > 0 && Number.isFinite(vital.hp) ? vital.hp : rec.hp;
      out.push({ gid: rec.gid, hp, max, pct: hp / max * 100 });
    }
    return out;
  },
  // Smallest kit that covers the missing HP, otherwise the biggest one.
  pick(missing) {
    const kits = this.kits().sort((a, b) => this.heal(a) - this.heal(b));
    return kits.find(k => this.heal(k) >= missing) || kits[kits.length - 1] || null;
  },
  tick() {
    const c = this.cfg(), P = Settings.profile.potion;
    if (!c.on || !P.enabled) { this.pending = null; this.message = 'Pet potions off.'; return false; }
    if (!World.inWorld() || World.isDead()) return false;
    this.load();
    const p = this.pending;
    if (p) {
      if (this.total(p.ref) < p.before) {
        Activity.emit({ category: 'potion', code: 'pet-kit-consumed', text: 'Pet recovery kit consumption observed in inventory.', outcome: 'confirmed', details: { quantity: 1 } });
        this.pending = null;
      }
      else if (now() - p.at > 5000) { this.pending = null; this.blocked.set(p.gid, now() + 30000); this.message = 'Pet recovery kit consumption unconfirmed; waiting 30 s.'; }
      else return false;
    }
    if (World.gp.inventoryPending || now() - this.lastAt < 1500 || now() - Potion.lastUse < P.delayMs) return false;
    const known = this.pets(), pets = known.filter(x => (this.blocked.get(x.gid) ?? 0) <= now()).sort((a, b) => a.pct - b.pct);
    if (known.length && !pets.length) return false;
    if (!pets.length) { this.message = World.gp?.cosRecords?.some(r => r && !r.dead && r.hp > 0 && (r.band === 3 || r.band === 4)) ? 'Waiting for pet HP data.' : 'No attack or pickup pet to heal.'; return false; }
    const pet = pets[0];
    if (pet.pct > c.pct) { this.message = 'Pet HP ' + Math.round(pet.pct) + '%; heals at ' + c.pct + '%.'; return false; }
    const kit = this.pick(pet.max - pet.hp);
    if (!kit) { this.message = 'Pet HP low but no pet recovery kits in the bag.'; return false; }
    if (!Cmd.itemUseOnPet(kit.slot, pet.gid)) return false;
    this.pending = { ref: kit.refObjId, before: this.total(kit.refObjId), gid: pet.gid, at: now() }; this.lastAt = now();
    this.message = 'Recovery kit requested for the pet at ' + Math.round(pet.pct) + '% HP; waiting for consumption confirmation.';
    return true;
  },
};
// The game requires the pet in the command; the compact command layer only sends untargeted item uses.
Cmd.itemUseOnPet = function (slot, gid) {
  const gp = World.gp, item = gp?.inventory?.find(i => i.slot === slot);
  if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget((item.typeFlags ?? 0) >>> 0) !== 'companion') return false;
  if (!gp.cosRecords?.some(r => r && r.gid === gid && !r.dead && r.hp > 0)) return false;
  return this.raw({ kind: 'item-use', slot, companionGid: gid }, 'Use on pet: ' + (item.name || item.refObjId));
};
// Player potions keep their priority: the pet kit is only considered when none was used this tick.
const playerPotionTick = Potion.tick;
Potion.tick = function () {
  const before = this.lastUse;
  playerPotionTick.apply(this, arguments);
  if (this.lastUse === before) Controller.guard('Pet potions', () => PetPotion.tick());
};


const LEAN_SKIN = {"f_lu":"data:image/png;base64,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","f_mu":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABECAYAAABJRz1pAAAGMklEQVR4nO1dP6scRwzXLBuYhTPsgQNXuMiBG0NS2F3KGNL4a7gK6dLmO+QT5LulcPEKF3fwHtwUBxukkbSauX1nt+JJ5nnvduc3Cz+ERqM/c2l+PS8Q8mJl/PjbRyjnAnnOAFeAUgqUa4GcM0DBEfVvnmd6fj6f6z2AOgYg8Ge//I0ffvkAp8cT5DETsCAIJxgzQJ2fgAjKkKEcCuRdppfi8/2rfeAf/fKX3v/8ftn/uFdtwuvDwwNM0wSn04m+7/cTnL5e6oQ8WXmqL0GNC/zeLX/p338+hw/wgiUd375bUHnqmoFmYV1LVPC7rCsiqEU8JPDglr+Uc64WgB0DC8o4iD/r8/6+mTDw/vhL81y3gaQh7EigkBNxfWZyM77/Hvjiir+BTIFMdi0w50yfG3PBgvfkpXOedYsR+OKWv3Q4HJYpT3Apl3UkTlw67RkBJgDAUdM4weV6UQ0L/OSWv3T86bjQHpG2BjjgogPwSvebyes964QEHtzyl969PS7laoIF7Exap0Gvox1XTQ5K4MEtfwM+q2uGrCd1PGmJkbrVsC9ZtxmBz2750yVAxWgKjqcJxcT0244tLzPw4Im/dHxz4DjAZCYkV0FcBgB0GBSI9+Xl3f3Au+MvHd8cF3QcbFBhGnlq1h6GyHTty+h+4MEpf2PdDhTdNWDGqD7hG9dGz+h+s+WgMYEvTvkjJ7ANK5ZVe3hy/UMtEo/TSODBLX8UCKJIkokdSAxJHAgrpGHdvcAXt/zVbSBBbOjwNoyoshFXDnx2y186vK4WoNlWfI9whQlK4Itb/igbiEEBShKYuLGNIFHg4M7kgS9u+dN0sM0Zy5pCpmQUL7OGDinlCG0qMvDglr/BmhC6UsEAAo15QWNhU480mdHAwINX/tK8YwswGnMiZUXoV26YDjU3GxUpgS+u+CMLIEB9yDVkalYolmyqTzYmDnxxyR9VBNm1o9cUjSzJ5FYEG3i3/G06gVJbpjVm0lTAlaXV6+w8y8CDR/6oKhg/9PnjG7mzzww8uOVv/POPz3W7YHLLvSmhZzb3zDVneScDAg9O+aOCkHmXgVrFTMkQCpoKbCrENqK+sUCdDKwwDTx45W/8+69PdMOUD6x547bk4K4EHlzylz79/uvy35fz6hxIk+FYW4lJg1h7JvQqX01QHk8AP3BwAQACf3bLX20NMw5C4132dWem3qyRwINX/hIARHfwCxaNBIa8THleAb61r/yWBN4Ff60CaNz4mUm+J9gQePDGH/oA6AjSNfNV7jXfzbibv8AvHvmrySAWm0cmoZTifW0LPLjmT3sDm7RiN3EzxpQa3TwLPHjjL+VxjQPU+vI1e0QTmriyrTvTyhKUwINX/tYzgvpJjdTUImedNk6eCLxf/gY9bVIqS7v1hQoIMcxoTYd4m3jkSODBM38p7/Ii6cJaO3rbeUITlfWZnkkj4wIPXvlrlgDVHpnUSHP61D0JvCv+Ut0r2roxqTBZjxzbekF/QkXgffKnS0BdJ9ZKUjMlX7kFWdaQWm5eJfDglb+hOVKUNYQgxqFAKLcXrAcQ8roS+OKav9YH6IMHZiLbbiStRVsvD7wv/oatCJEGEfhWD1YzgxUmgQfP/I2iNWvToJgRqzlSX85TyhrSxaEDX9zxl+ZdXsQ5EG3S7lFpMZIJrYkhjeODCgMPXvljl0FOnOTBTWcpD7bbx+uthxl4cMnfSA+eWrOhmkMnTLY/QIC/N0NitSnw4JW/RD8bZ3vNe8/S9Jrpd4xB4w8PydjAu+WvNoeafaGkFhsHAzVLVwreU3aFB4EHl/zd1gSaRkMJHFDCSXrRupbjwPvmb7DNApphkkFSaMBOhFgX0iHRtMCDZ/4oF6DhQdGiDdGOE7OHbDJMgXfJXz0jyGSImjyzSLemNPfNSwNf3PE30HKgbcb8Q0S9bBQZksOB2MCDZ/4oF7DWiZkthFlXthoNJA4d+OyaPzEe9X/bPSpbC3OiVFNVKnHlwINn/mogSLRCskWyd2StaUKKIn14MfDgkT/aBtp56rLCxYP478loEIcRJZIkmhZ4v/yRBdDCAd03GvNicseNyEmUtvAg8OCNv6FqC2sT42oYYTUhmk/mX51EkRLkwGfX/P0PdH+SNskqq70AAAAASUVORK5CYII=","f_ru":"data:image/png;base64,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","f_ls":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAACACAYAAAB5sSvuAAAD6ElEQVR4nO1bS44UMQx9jGrhknpRIw0S1+AwnIA9K67DBglxFI4BexbTi5HKi5JAduzE9QGJNc+oJ01XJXm2n5MoiV8tT8uvjx8+4tPnL3j/7i0+ff2G7z++YycTIPFVASwiwCTAhvbAyg3QTSGTtFJkfJ+A+4tiuYmX9ru3OVkd+Lsu1k7IbD9NMx4SwLKcXzrJJFhuizfa4arVsT/RkXfc2kqgVs9KVUBuqWqRrYJq5Qpg1TUAhgUS7JU4hK1ZIgHALKTqz9IIDax2a95f7vu23dLRppVuRfV2DJTJWvA4wHVdO7Bu7oOGguYu71zHB9KeHS2dYnS4q4Fsrm59jFdTWe/XwFubRRzgPM/FKn+woIFzLjY3VovAQB/AJc/MSkYLkUYNBxmfAXjQy+sFnztA58dL+8E1qCDL965EsaxLdJCNdokAsDbNiq1+UaCYcrZ+goPulbCoA7QGJIJkfUkm7MU7Mq5g8GanXNDAJJ95me8FRexfRncLsPZx3qV7k4MSAL3DsODj0yMurRRldYtE1FaXe3Bg8KkHQpKgDEe9bq8fChrQAPmQRN6NRRdDzcl9/q6OAIpGe8cX3OoBEQr458j5bCPEAd4zIhuUM5DUMqMsB2aEGGdu4TZ/r/C5tLFzvdcON1eQycNofYyD00UgZMVi1fpcMPhnpc8Mxa2dt6FUBdy47GOUP5uned+viAdOj+IkuFnzKCfQMVzcLbgk+OtWHu2kUulaD8SYReRC8XVbx/8D8JoDileMdq+iOAneORXFktPWtHdlRmy+7/VjPk/n7vh3nGmK69swc9cRxbdi6urWcN8g9+Cc5ID9L+Nn8qxGcSifg3UHaF8eX7fh5fnKguaenPCzw5xPVctiIBSId7oFVcciYzdCjFkjvTRjbi6W5uaO/fnnM4A3mIsF+5CRBHeO5QBcNdeYxoqlInB6sISS6e5Wf3hk1G3rAh+4sYahbSoKF1cNK5BG7KbnktPUNtaDCfxv60G5DW+kcsf1YAPG9aByPXgSrgcnrgfB9SAiHM4RwvUguB5EpQPXg0fhenDjelCdCtwfNOH+4MT9QXB/ULk/uHF/cC/cH9zCEtwfVO4PgvuDwvNi8LwYPC9Wnhdvh9UCz4tRlk48L5ZmCZ4Xm/C8WHheDJ4XI4OB9weV9wfB+4PK+4Pg/UHw/iB4fxC8PwjeH9x4f/AszCcR5pOA+SQwYT4JmE8ifWwU5pOA+SQuzCcB80mkcYH5JCbML55wKcwnmZhPAuaTIMLhHCHMJwHzSVDpwHySozCfZGM+iToVmE9iwnySifkkYD6JMp9kYz7JXphPsoUlmE+i/2E+yW+Nttse6TuuYgAAAABJRU5ErkJggg==","f_rs":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAACACAYAAAB5sSvuAAADIElEQVR4nO1ZS44TMRQsWkayJRYTiQtwEE7AeVjNmVizmw0H4AhskFhmg2RLWGL0bD/3c6edpAnLKmkm7fhXfr+2Km+e3j/9PfkTYopISBB4oD1hbee1nXICpJ0BuPZn+u04D3+57s5YWeP58zNevr3g08cP+PL1O378/IVFyOmACzLbhTopvw5283GVUD1MIarzr+AUKh/l4GKOg1XKCTeb2u90wwtizrTbYSst0zexdN9HODSPNBNg0QneefiJu3RwmSjW27NE3pA9irZmSja4hKC37E965nUTmWQIlXGzDRRqrd5eY/AqedOnuzh5CjIze6R0vhg4bKjJcdWtDYOFa6J0TxyAqwsHicbiPrGWuLqYWlyqcdk2Kq1b8ZRNPO30TWGTsz0v8i+K5XosmljbJIg51v6zRQn00WaT4BgQ/8Rh9FJP6ocMUgttNxB4/cocoqMfItW+XrrauBslRhDehqG9aODKgmHjIi2wQ5zpc2olx6Lz3RBSondkd4zNgu3wSwngFm9RPrXWCZIumi4zWslms/rmIDUxViuXuddIZiCEMGT+Ihlc3ibFvdXVhVQvK5XeYK17YhAmjm1puuZm8eQ7LXP108UyISI44NyK5PDmaO/TgdCeBd0kkW68PbZIv9V7zYI6WYj2wNaqvjldte4k4PMOOdt3gKRdY9GH6oaEk6SpCeotoX96kxyA72WiJYkkSHChXYuqm4tLteQIyXZrkcm2fMC6d8dq/VrWa+v1ujmGg7p4d8I9JfX/wzuPczwPluR90IsZeB/MvA9OwfugBe+D4H0QvA+u4H0QvA+O4H3QgvpgHuxBfbCD+qCC+mCmPjgF9UEL6oPJmoP6YAX1wUdAfRD8vdjx9+LDoD5oQX0Q1AdBfXAF9UFQHxxBfdCC+mAe7EF9sIP6oIL6YKY+OAX1QQvqg8mag/pgBfXBR0B9ENQHHfXBw6A+aEF9ENQHQX1wBfVBUB8cQX3QgvpgHuxBfbCD+qCC+mCmPjgF9UEL6oPJmoP6YAX1wUdAfRDUBx31wcOgPmhBfRDUB0F9cAX1QVAfxICJPvgKdjFbx2lo7k0AAAAASUVORK5CYII=","f_ld":"data:image/png;base64,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","f_md":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAAAwCAYAAADZ9HK+AAADsUlEQVR4nO1cQaobMQx9E6bgQBcT+Itsu2uv02t8eoTeoPfq7l+jiy5+F4EYGkiRLNmyJ/nQrKqO9CmTGfvJ5fGQZdkz0/F4vEJtBnCR33SdgXzJSHPiR/SbLCGVvqMFHt7423HHS0bOuYDUgQ4g9+xI/tiR9g08PPO3Y5UY9WS6ow5yn1Lie1aRUR31476Bh2f+pmVZrtRAHVQlGjo4XMwJ+xk4k3N1xKrioWqoCXxyyd+kOQCHEKsaO5/IQOwgpdZXBgg83PI3HZ+OHAH4H0lCgeRX5xR+RqA2f/AgRoGBh0v+SgTQTsZs9thURCPQs4xMTnReCTy88rfjBnViskieS1RhaqogHVgHDTy88lcEIE4krTCAXlG1X15nlYGHS/5W5YS6RiQV5RZiWFFWTWTjfeDhjb8WAcR03qiZpK4ZVUF2vrnxHwh8csVfXQZahxpK2pqxB1E7V5QwJBqBd8dfjQAlOSjwUjBsz1U9tpasTgLvmz/ZCxBlcIGgLBPYFGDXnKoum2UGHl7565NAs3tUNxdq6FAVNSfsyIagwMMbfztNEJJmi3beSK3GXAoIps+QYAQeLvmrm0EkCooU3UrSZJldDXnYcw483PJXBGCqQ0VBpVS4KjGOVYPqKPBwyp+UgiU8kHzugXXAi/aTpCPw8MxfWQUYhZQk4Q2wttVdpsB75o9PBN2qKGnW2M0zQzGhcxZ4l/ytSsFq9bSJXjtlDZsOgXfL3/3NILPMSKwYlCtvLLwxcODhib+yChiBt0KKOCwVpLbx2B05Djy88TellK63konO2a12tXvtgYcH/koOIMuCoigJERY8TjmjwgIPr/y1I2EaTrh0aED0204ab4WXwMMbf1OaZQoYHY4hQ8vJlzunTgPvkr9dFx/s2tGCxahyVPeda5/Ae+ZvLmVD2UIcokV1xp3bWyfWAg/X/JlCUB5eHOzVRAPZ0yVrC3xyyF/VgxwX6MuM5v2ydcloHD7wcMhfiwC2XDg6t6oRJa0s8PDI3wSgnQr+GzMbC4H3y9/jAgj7L+zubmDYNiwEsHELAWzcQgAbtxDAxi0EsHELAWzc5od6PlJ8CPw/yd/8/OW5PZRtwvo2qXxMyLaXDw/qS4jmHHrg4ZG/+eX7S/3QQP2y1AzsCfRuj/PvM/KpfF9uvwd+/PyFZVmaivSDA4GHR/6mb18/Ryl4wzZ9+vjhmk/A6+kVh/cHvpI6DsdD/fDgOZ+58+HpUA8c6mtprL/Awyt/0/JU3gsIwybtD2VlHuGFT6RIAAAAAElFTkSuQmCC","f_rd":"data:image/png;base64,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","ib_lu":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACXElEQVR4nJVVMY4bMQycGCq4gIs1cA/IPSP3+MsznM4prkhxwG5hwCwWSDBDUpKTKgKMXWml4XCGor+8fn39/fAHNA7g8nIBGuC7Y31Zse87rBnsbHB3bdv2Dct50fu6rtrL4YejmRmMAEdgFvDt4wZ84L9HY1RGNwIeEen64ypWZFoBYPmseUMQccDhIDEBiiHfDNg/ySzAFISgcO7qDJYGSKAEt3NRAyjCKWGx7640FSCjLbboG0H4I8hDmZCZR0ZtsOa3xgUKf/sZYBS5xuMIs7Z7HCRjCq8MMqiGUncw1xMzegLLVHhQTAiQh8tljdLT8z33NmpVGwqEI/QD7LC+TuAAnXRtw0xN98+9Twqk6zKP1LCzTRCjm2XeQVMmKZxaKYecOwsiWfeSSSDqCMvv1C/jDrxIQwX+j/AEKfbW63AEt4lhTzNqT25a6eZ6KkjKUKkGqD1dAJ47lXM6KOvHoefrGOBKs+qvjJQ8wTgKeyoFgkjoYpVPJZ11OEzzUeS5dupiT6MOhYPxLAPiqsZ6z+CoYNJwLD490+VKsW5Ilyhbls3aCrB8KnHnAOlkB1FZTcaUFFUNDdNNmQtbzgyxdWByWm2r9EW0r371qpTYnS/rJUpHmjy7PAvfO/g9NO3f2G22uvBtwdu3N2z3LYCpV6b4iA4Y7WyqiErTyn1OLwb8kj4b3r+/Y10N16mp9OhcY3P17I0ESpZinX101GHpMYFVm5/nC/VNqQWWDMusNt9mfSgHU5usOrj91QsnoH4B1LFLCxMG9ntuoODTgSrmcYOinNb+9xqF/wfe42YwhNh78gAAAABJRU5ErkJggg==","ib_mu":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAcCAYAAADRJblSAAADF0lEQVR4nOWYTW7jMAyFaUEDKEAXWmThI0wLDNDe/w6dq2RRoAbGQAZ8ImlaTVdDrkZtYseWPjkv/JOWt9e3+7ZvxK3hnWjb6dRaPc5xjz/v4/rmjny91UaRPErmL0R0p/+4FVb0UWutDeVEUd+Pz+0z93H3o3nZ/MoDYVbbMCu0XYCbA/OgveEebG8/XoBxn+2YLIpnXzqJv6zXdcQA8QkGWwf1H1XOTahHjHV9e+sUyZuP0fyFBQBo30ZQkSCjwaaRHFlZBJVxvn3INQCPMfZgYbxc/rJe+x3GJKaxsV141Z1/zWZnZtrErNAfhDAe+iTyF1iAYtVU2H9EyUdNTc5PoA/D4yJ59qWS+AWqSIC0SMnK82SzqtJ4IsDmaMugYF42vyrAoiU9KCJYvY9hiiK/mRx+CfFJ/SUied7nM/hFFUJ1xCopnJs+gK+m9FdwpjT7YCQvm18A4X9WyZWUGKjKVWdSzvyGz43oij+OtsG8bH7BzTZVSFpRtbMvQX1OJ1KIIPCQMy19mEBeNr/AlJz5WL6Fr8jAqQy1aOurNZE6mpfNLzh1fqFqDaXOacUirXu1J5nEUkwsL5u/9N7v5ltTGrHU4aorVdjysA9AZqKBvGT+sq6jELKmKUT9a4qwvvJiLW/iY4cfTrnpH3mnWj+BXy7tclop+c6HIUlAsvpb+zXqvZ8eLpqXza/rup4VdcqiTTlY711+EH3+IboQ0ed3/QJ42fz68uvlS+dj4fBJVC9H9HQbDtDcT6Qmq0vVIF42v77/fjcWkolWWxp1peRUX0RgmfbkkH6w3NQkHchL5i/PP5/vpuCUW3Vz0TYdJ2W/bdG8RH7x0iCaElF/6gbSygk5dn+QU/Wzb5G8ZH4xRWVfjU3ndrudzUpKzNMKjV+6GPEPG81L5hc919SBHVX1M5iQKinF4xSFUX+Lr7lyPYyXzS/qN7aj4pQbBYMrQqSMHPfE5OShEHQAj+Vl8+u4KGpi09DtwWt5CRWP9ZhFXzVJ8as5Iofwai6/cOf12r8WGCqM7Z7IZGPNOVRV0/MpKJqXzP8L+GIR9aQjezsAAAAASUVORK5CYII=","ib_ru":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACl0lEQVR4nJ1VsYrbQBAdmy1GoEKGK+wicAYX54NArkhjyJcH7jeuSRk4FQarMOwWAof3Zma1CqmiO2O0O/vmzZu3483xdHyoqGivMk2TaFIZnlTG35NkEZGSpes7ud2zaMKCiMwih/1BCv7uRVSVy/jeiMhD/uM5v5wrSCmFH0kiG1U1QGSfLRhMyuxrBf+lMmtBjqcj18jQYzf7/f7RJZE8C4PqZgBgfS6UAuuUBYD3iUnPpzPl4t44yRbnAiyeTjt+EAQw7I3TtACT1cD9j18fInOR6WqJyJAgYAktEIxDqGA2XcjcgSp7f4rr9/btjXtbBkTJ0KfXCgQt2fV+cPGWZKGl9kqwy48L95KhRDN0ZQNs4L3VlA1aNVDJ8DbdqC8ZtvohAOUHc7JwpvWZ1+VqjzMdv7dtlmhChlXwHpp551cOcKtpUxW6nAiCsjyzedACwk4stakiSrZGFRmGwc4M0DCMSUCzcDAhmPxldtbaNK8sPkXMtjWvcNEDwzahVQMcuu+gL5LPXuUMwNAiWh0JGhnWjVjezWql2my6F9OwHgp9mm5WbhEX++nfiRN0c1lM6NoclZJMo1XSJjmSqd+gPGfGJVoigFqdaGsDXYzuujY+VLccZiZu1Laq7drVYB8KtSleyWKXxQ1Dbx1A+enwfFjNuerLRj9OdJxIKuM4EsCGiHDNLoVVkS7fLyuLtBpxzjXl4Xn9+rquSEy/z+uNMen953tlMuD6RNfwPuBa+fCIQetq36CbV3X4cpDj89Gb4tl4ONi5Lz+vhddPizJpvmeR3uJh6uh0zpksc8myjdazIidHFrQKf/fMHqKye9otNkKi3hq024GrTfl6U6gHBqgPTTywQjUw/uI3pw6MRccOZ3uVP0Fqj0Adzr5HAAAAAElFTkSuQmCC","ib_ls":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAABACAYAAAAallfsAAACV0lEQVR4nO1XOW4jMRAsDxi0AAVUZv9g/f/HeJ/gYIFhMIA6GGAX1QdJyY42NQkJnOHRR1U3e/jy/uv978fvD9Ra8fb6hrmpKkTkYQwF0EMh1xg/fSyfN276MhGNm/R8Enp2bYACUqaxEyj3fCmcFCjUel/EHS7UFNA69lQwGSChUEWx3erQbtZQGLcV/sOCcMIEUNBpemIPwotwORdTkFlIa87wKP5yHZg6FC7I16n1rfncluBSUE5yMcfNFbqpaVUFQqG7r91986QApf1pg4TAq2P0zG7MJY81FaYRIiiYCOyMP79PBJirYU26LSLmUWsN21OU+aZDg6BgMAS4F4PlZJ+tHc2EbjBWI2yCOuuVQhP0EYtOVOCdMDHQOdcUpbsVC791na4dLpgmVrp3DJbVLHVPtoeNOZn4sM2ZwrAy60JYMF7rYHr7wmbmcEnsHjGs12qC9rbbs9TBOq3fOntTTOU7scnDwHASBnAzeC7l4ta21mPQMyWFT+S4q6O/hwXMBq7bj324I4xdQ9AEl34MpbAjF/LnmF2uI974frvewgg4rsyyUF7mXDZ2M94i4m0TBWMijPCEMm/OMue3PQYZmGnFnGqcHceXHyCdYVocFuW+chPgcxrwbrI2Uy3i9K53IySDX6jENnlmjThMdhMC5if/SVZYfREXZpZFVJB5DezLd6mXzUOFaAkQZyIfH2pKmU7sVVOwagpWTcGqKVg1BT+0pmxe88d3YP9UowIT7jW4f1FMdTm1y/QB+gMxLKsuY931Rlt3PV13PWvrrod118P/1JR/Y/YZdYKbZSwAAAAASUVORK5CYII=","ib_rs":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAABACAYAAAAallfsAAACqUlEQVR4nO1XsYrcMBB9WVzI4EKCC+yW+YPc/X+dJpBfSLlXHFjFgqYwJLynGdl3pEp71mLWlqyZN2/eaPCX5+/PfwDANgM2IE1ANUNOCbYBmLgK2MO0hinpnvNpSTAzXJ+ueHl+wa+fPzBxIqWExBf5M+jZuh1Y7Zt5yQEdJ1+Ev2uGta54rRUTX6yPqgUNeuY9N9Pssu/mRhl35HoGcLtmzGlGXjIunFB4Colhmu7pJEJWBLwyI3Ea5BDaszoF97c7LpwgZ3phc6NBg6OjEzl4dEpiEAjH7WvR/rIUTDLChdQ54mYaouFAwRHohY405u7YzLl15JdOdOeD4ci4wzBy6xkeKgjnpChnOW+toVnTHnEoQ8qyGwdQa+1GA2UkgnxtQNuaHJs7mqdZirgMOcSgcXcSFITTWJcBzFpvtSOTAyF0MY/hCPlyIP8X0oam9TnPmiZCzk8SprLbDXEyR/iuvch2PEeIv19XkFIqgCMvySvlQ9gWovW5EHAIXiAehuLoKGgViFmv1HrYQCxDlwcaopLao3P1LlGbx7N56YdUpKsDV/kpjyyOUB1VLwT0tcmwvq1KzCVKTUkYNbx7jnBDuGGEm/lD6o5LLsr8ZYRE4j/IR5qzHd0Il0iXuWd265VDYfOSbMLzEU3IJc5DjvJUut58TiWaEubi0lmIMMotThWdKL1OwyBD6k5Nx9QoUTe63lcZ470QHrkKGR0zeX+997UQvgUdphItt37a8BLCnPMuGxc178XLo4nsI1fhaGXZkdt1p2GSKEOsji56CjP3rqfwoJnK6CnlWsYpTiB7pXy+noKp9w8b/bj/D2TsKTxwhZBlegh32yn7dr19Wg7r2Zft7Mvp7MsaZ1/mOPtyOvtyPXuKnd967fzWw/mtt53feun/vvX+AoxewymeMkUNAAAAAElFTkSuQmCC","ib_ld":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACl0lEQVR4nF1Vy2rkMBDsMTr0gA8S7CEDe1hDLvmFwP7/TyzkuHsIWAeDGlYwofoh2XGYGdtSt6qqqzu37XV7fvz5oJwzlVyImfWDS0T0lzoRJf/gnq737DG1Vlos1BcSkXShelRNhmdNHsk02N912xsXYnhlSpQ8JYLXDFgWLEJCCBT9YA2HGGj82j5mJjnwUqiK0DJoyTeKp0uABkGeJGdWNJzYDsGhANaJlkvgWLQkllyGpggaKINyh1T2HtdyQQMKllk3mXZXDTOod6G97sTkB4Ce71lioyqGk3CyPytNoD3sHkBRSWy4p7slYYtHLP4G5cx5LujitEZzaWu1Q/djH6TYKx4ME8QNhIE29MIKKN1XS6wVFaGyFmMADQ+4w21EQovyU+RWflucydWLzmsUTA1lb1kRmo5Av+xeHRhTg1Q3t4RunAYOOUaFgdgRRYGWEqK6NcIh2inhSdcS71DdsEq4QfzQvJ6KEsKGtyO7Bp5sdee7aYk0UZA4QH14CjA6TgFahtFPKG3Nzey2wmCJZliiyko1hkGPNjOErbdpfC0WK70xJGTSSlLtAd/YjAY3u0R3CD1yma04WtTWJdrPLZWiSpFUafl8E58y9dMcENSbNNVSE63uV5cpjcZ3cUGl6jiyYCQbAxQz79QZemgVknQuyrdRNTwoZ+9ZYgwGhGF8GU26DGAwmvPQzWqIXHwg/oEAppef6HXTTnXWwUpmn060g1VH3uhf9tHENu/0mEPon/8r+PtJVLxnMUjU5MduWhKmTwwH5/54eVApRe/b/3axAk57OBLd71XY8jZ6OIDdtl/bE/Dff79PA7tl4rAYV4FmjrU25mJoeXt7fXvGBs48qjrb0XQD7X2AbjbCTiyauqTRF/QblaZaaQeLAAAAAElFTkSuQmCC","ib_md":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAMCAYAAADS87vJAAABvklEQVR4nM1WQWrDMBCcGBXW4IJzDPTQQC/Jqfn/oyKoQXsIpMxKa8kuveQkgWOPvJ5xVrMrHy5flycAKBQSBHgA+ijXwjuwOR4iQIwK4UVAHaHG+OiWL2zxQMB4EpJ4DShBuihUKa+IqibKaxMsIhoLnvJzXfPt8GBBTs6b5bzJHsgrm7NJlhWSyVdD0DvfHgcmDYE/nNGt7Wg1yeLrCzCmEV5jmdXJbdYx3w4P/rBlutSI1VAhWm3XkjKGq8Ls+YoIcI939M63x4fzx/lJYE1lN0hAMYqbnexhsdrJzvHAxpqM65jP7N/gwSZcyM41s5Zp67oladNspMTWePzwWBfomG+Pw7qlmJUEInMV9NJrXyCzVMKmDud5Rlxi/3wNDp5F7jUUsgCyMpNUWHLN5XrCmmH5swfnmN75fM5xmKcZ4zgipYTxfTTLjW8Zc3DOH+AqmN12HZYj/aTK0wOfOyJs+XzOcbhers1eWuvJO6nbyId313VlckTuyZqAMFZRTRiJX+XzFXzh/fBIYIqOcvyXDwAOt+/bU5eYbUP78GNqyjVi9Ky7gPyVpflPnT5PxVq5Lp1QY7RG1Dtfi38B9QuURhWwnEMAAAAASUVORK5CYII=","ib_rd":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAYCAYAAAD6S912AAACt0lEQVR4nF1VwWodMQycLD7I8ApeSOH10EOghybHQL+85JpLPyY5BNaQBfvwIGVG8j4nhs0DWxqNpJFyc//7/gMJ6HtHKQW1VpgZ+qXDAMAMlgy4dPQLdI8LHwD6WTLZP/55xNPfJyxy3t1IxgEuw1M57uve0XsHugPxfgRev6+6X08ZSUxMXNyBpE4elax0LgESYK03rGWVfevt+p4MCQHCvw7ijAyG2j2YMkjXNDOyl+i2wCrQWnNgAAvmOo1DUILxLgIO5m13RgSgTce1VFvdsCCcvhZ7HDZCYBEwW/bflOXXqjMbaS8EktPUlAM4WM3p8rRL0ye/NHy9FEthJ4ez5BEgB8WQz5QBWfJjijxMfbUMK4bU9+oAYkmG0fEBcHQQDhzN2/ZNneYpkQUblVTy6KIYxoPOnHoE2vYGwUz17pOdm4VApcPpsRTeO/PxRvGOpjQ06c12D8ZMF41TGDMVFnuc4y2Yz2cIOltGOXOimmoqM4Ksp/U6GeG8vW1XoNAeAcgsB1MwA02MT8cy6B/y+SIR6S3u15IVXHcpJsuAvK4+QZYp7M9bQ0w5rxRsvHHEVHwGILOpgaUUtHdnrhrKaloMY1nQcUzFy+vLVUJK0e351beKnCN9zbJRR87ARuRPG2dqBCeEszxqyiz4++4CZw8SLyrFLekEw2S+miJt1XaPhiQHlBpYEsafFotqSLD5G6nlMurlBZ8boimJOWbafNtqw3KM00g1qM+pqpbsJsEiXWqOoK03b1o0bFErGKXWY9VrPxZTygNke3VNism+ybnXaGTvB/N0vj1fdUdW5npcT+bNYuRvGefbIkGUS/HlS4n9XLWt+T6yTA/3D1ew6VeNidRZw+327POr/ydk83mRPP97lpxu7n7dfZAJtTZo+77wTlM+o+Oq5XiP+2HLmv44/8B/rie0Fv2Pw7wAAAAASUVORK5CYII=","tile_a":"data:image/png;base64,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","btn":"data:image/png;base64,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","btn_f":"data:image/png;base64,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","btn_p":"data:image/png;base64,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","btn_d":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEwAAAAYCAYAAABQiBvKAAADr0lEQVR4nN1ZPdLiMAw131BABx0tx6Cl5Bq0HAOOQMkRuAItHXRQUlKSLul2RwyPeXlITmApdr43kyGxZVmS9WObTkopjUajP+mLqKoq9Xq9bF+O5h3+0fun8uXGFEXR6ZixptNpms/n90YDC4Bv7csZwpATCDQKVVx5vgMew+9lWWblsDaP/ng8pt1ul7r2YcZaLBZvC/UbES3ObDa7/94Nxthut+5gey9ldXIrr6FiUK8BP7T1+/17G3/fbrfn2HfnAMBHeTRFhbWbI43H4ydNV4212WxcRm3DomoZRmx8RVEUNeE/yTc6BovRBKYzOSaTSdrv92kwGNzbfrxBh8OhJmwU654XRsqpsCYYHh6vfD8tDJhD59d5Pd2s73K5uDx/PKXNyyCs9lWOUtqm4atC4x0PG4efCKokGwZ8MIcaCDJE3oZ2y+sezxcPs471et3aCIacV+kYbjMlvDwEnlgwL19GlS/nYZgP75Hs1m9h6KFmMBVMw6If5AHQWWJV188pZO1I7vawRz/2PY2LgrFtcqx6OMbnZON53CqZy1EGzwi8WpFRuV1p+J2FzOUxDTuWg8G8h8PhS3XWCs181OOfBvOMo4I3VZhScgMbNjI+FIgQGV8NyN4AA9qv8bd283zPmBw5PB94eJW65mG6L2JlWPhKqmGU4DVPmAJt8hCHJ+bVX+Vj9Ern7R29UNRxnny1pI/NIbtoLl8MH4pznvK2CTouMi4r4IWDekA0D/P3Cg7z0ohQY7GR3KQfnSOb3NgQrbonPAvcZiOpUK/V0PFoGW0qam5bUwtJVKWmI08beInU27watAAobeSdGj6qpEWORQNyHCKJc1UkG3Kv6ns3GJdvzyCeuyq038sJmodyIaP8ojwZ7c/YS4zX9XqtFQaPNxehaI/oHo2YkRfrpSibyxvc5wmc2xJAcfRrLoy2HTxGD+8oJN58MFDutPFiMBPkdDpl3b8vgnt96u4QXouEd1TRygbBoQTnMXwzDfPhUDQgRCNdjNbmtPO0F5K1syQYLZfLF8tq0u45yR90UelmAyuNVlwGK6ynCTWwgkNM59eFxq/14SypXtb1JsThm6GTVJmr4UgYCMALFHmqzu0tkI5XOfnoxWM53HT7gnY7S3o3NbUquVqt7H4/fYrqgyvtbyC3eE2IqjdfTTNqRyO7A4rugf5n9P7hsrHtfwE1g53P52R/hEQTRh5TyWrqUSK6usnh09tV72bhHZ5NNPC0zoP4q3+zpV+Kqqo6fwE+2gUDVvXHdwAAAABJRU5ErkJggg==","tab_on":"data:image/png;base64,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","tab_off":"data:image/png;base64,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","stab_on":"data:image/png;base64,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","stab_off":"data:image/png;base64,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","chk_on":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABrklEQVR4nIWSIXDiQBSGvzKIxSWOle9c4haJpA4cyMpKKnGHLO7qrq5I6q7yJDK4xCXuIoNLHOt6s8s0pb2j/DM7b3b+ff97+95/JSKvXEBd14Rh6OMbZqHiKdJ03WWz2ZDnuSeapiEIAnq9HlVVobX28RSmKhllW4bb7CjgklerFYfD4VIzLAfCyDZM0pIMReeUdFW/wuNAmAO/84KtBQUfBb4SuYuFKVCmO2Z70IEG9amDcyLLWPiuwBY7BnsYT6eo0NWHjgtS7IiU8i2dirgzCUPmjrANgxJCERaLRTvwrgXiMueXKAqrWNeWbWPR0scAP7yq5S4tqJRiZEy7Md8BwBzNOskwCn7qgDzqM1VvyVCkGesGBsZ4P8Rx/C5Q1zUiwr1VPCZZS7hpe1QlEzc0Efoi/8yr4xSdWXpas2jgJd2d0JbrYo+z0Xg8/u+GOqf2lCjiZg8vyVFklWQkFm5ub30R59DP6LbJ0kckxhjD7PmZP+mO+wYiY/wXHVy3ZwWMGbZVXPz28EAkwnK59PdzuAqC4HU4HFKW5QfCuv3izXYWRVEcBc49cEa5hL/uUZum7RnuPgAAAABJRU5ErkJggg==","chk_off":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA6UlEQVR4nJVTMRKEIAyMDAV20B1lWjrbe4Z/8il+w9In2FpaQmd5N4mDw3Cg3s4ogtlNWEKDiB+4gfcejDE85pD0GscRlmXhhRACaK2hbVvYtg2stTzmmKYJ5nk+BIg8DAPs+35XDDiHoJSBdV15LtKflPWOjOig7/tzTeRBNZFIziFKwblIjUyQ0bgrkZzs3DEnnqQPcj0H4gtqiCd2biEUKrhCrIC34AvNQdlj2UopfmpJJHVYiYyIP8ElEZFWcEWmRCWv5BNyKlIV6Lo3933MQkaR26lhJbAAXYzY2/+i0VpXr/OT4/0CQTBSHoUffnsAAAAASUVORK5CYII=","scr_bar":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR4nGNkYGD4v3dVD0NKUQsDsUCAh4OhpamEwTushIGJgUzAAaWZyDXgB6UGMAwuA35QagAHpQYwDD0D/gx0LPxAN4B08APujYGPBQDocw3/Ovl4qgAAAABJRU5ErkJggg==","scr_btn":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAArklEQVR4nL2TMQ7DIAxFf1AGjhBGRsaMXRmb63Ts2jHHKSNrj5AxY3MLVyYLIRQJUfUNtkCyv21MB4DQQM+GiLBtHsNgg495rwuUNsHH+KfD7eHQ7fGE+T5VKfvXAudXCD6kqtUtpJm/oaSEGXU5AWMvBjnsdA29xwg0ItikE65OoLT5TwUqIyTQSH9SkTJMO6fOmwrM5QRm1Ken2uG7YzDzmxZYsbSBJcJnaqngA2vkOCc5y4XSAAAAAElFTkSuQmCC","scr_btn_f":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAg0lEQVR4nGNkYGD4z0ABYAIR////x4OfI9EIfO9YMdgAFphJ94+XkGTz1CnbEC6gBLDgMhkbUJTkYPAKdsJvAAhk53gxYAOKliUM94/3oIgxMVAImCDUC0oNkKCXCyRwGUA+YMEWVaDQxgQSxBngFeyEEVX4AHW8ALIRXwrEBxgpzc4AR0lABVsQ+3gAAAAASUVORK5CYII=","close":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA/UlEQVR4nJ1TLRuCMBC+8SwQoWlcJGo0GvEnGInapFkx2uRnEDXuLxCJRIxE2nwOPRyDPaBvud1t73sfHAwAQCml0Da1BBvKMu/5MpNwvDwYR/Ju7cOvEMKHhecqTlmDQMwmR/Ee0iRtz9z1tprqcpJcllXPd8y+D8kdovg0GesEwECRX9uBEQEtxb6VruwCcZR8Sn2LEJHidGcVCMNN+xiz4EO06GN8VgWITGZdFrTo2+CYCzJWtj6TgYDQyqHHRKZ29LgJbl4QgXrWRfQ5dALQy151G6kvzFhsIIDrSaAvYPrUrr697HYOVVEUo/1NIZMVMDzgX/WPwLNu2AtrH4cSO3iozAAAAABJRU5ErkJggg==","close_f":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA5klEQVR4nGPg4OBg+E8UeI6Cnx8r/s/AwMDA8v379/85wUoMpAInIwkGAQGG/ywwAS8nQ6I1e2VPZVjXGgRmsyBLGBkpEtR87tx9FD4TugIJyx4wJiSG0wAGhhdgDNMAoSFiSEbiNiAn2ApuEEIzsjjMEhwG1JQEQRVLQBVKgPkgcaJcAAJT1t5DsuUFlI8dMKH6DdnP2LyD1QAJNCGEZoR3EOLogAVdAqYB5mdkQ1DDAW4AAxyAEgksRSInGGxiGAaAkicCwGIAnY/uXQYGlhfHe8AZA5a2SQWMIAKUq8jR/OEDAyMAYHuCrH1ZQH4AAAAASUVORK5CYII=","bar":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAAPElEQVR4nO3QwQkAMAxCUVOykJD9V2vpBJ48xTeAwi8OL4wKgPXgOMe/HEhJJCWRlERSEklJtCBRc2g9eBySA1vt8mGhAAAAAElFTkSuQmCC","bar_l":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAKklEQVR4nGM0NDH8z4AEWEDE+TPn4QJMyLIgMCqACqgRHuBQNzQxhAsAAFOOBMkPiNk6AAAAAElFTkSuQmCC","bar_r":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAKUlEQVR4nGM0NDH8z4AEGBkYGOAChiaGDEwMaIBpVAAFUCM8WEAhjQwADjsD8cufiY8AAAAASUVORK5CYII=","bars":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAARklEQVR4nGM0NDH8z0BDwMjAwEBTC1j+bwpiGNI+YKKl4SAwagFBMBpEBMFoEBEEo0FEEIwG0cAHEcuQrzJZDE0MaWk+AwDWbAlhSoQhDgAAAABJRU5ErkJggg==","bars_l":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAPElEQVR4nGM0NDH8z4AEWEDE+TPnUQVA4P+mIDDNxIAEGP3WoQqAwKgAKkAJD3AwQkMdjsGBbGhiCFcFAEM8Dl716rRpAAAAAElFTkSuQmCC","bars_r":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAYCAYAAADd5VyeAAAAPElEQVR4nGM0NDH8z4AEGBkYGOAChiaGDEz/NwUxgDAMMDH6rUPWwcCEwmMYFWBADw/k4MMayCwgAhkAAMuMDIuVXyKyAAAAAElFTkSuQmCC","tw_normal":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACLElEQVR4nI2SIXTaUBSGv1Q9XOKI48lXlzniiIxsp4IrUxTXuYEqU6Oup6pnaqA6ZNzAgWpRNG6Je3GJGs9lB7qxnTPY9rv7zv9/795zr8URPUReNdMFZQm2DXfzzDrkOzkWDjqXjMYzXBt8dcp1qKr/AjxEXpUagZCKj71z0tKQ5hpdbOi2Gn9ArEPU9cN1FU9ilOezSlPS5IlQOryerKyjHTxeNXf0b1/X1Woao5o+fjvCUwqpXpEbw/qqtfPcRi/ePeBTN6yWeht+rCb9N8iwjX9+wU1/wHw+4ywM0EIy1yXrD1HVdH9BrG04DMOXmQd9GkFAcNbhba9DpoZQJJzVFgSeZDSdcUrJRRSRL2NibX6McNrchbUBP4wY9Hpkqs9txwVH0v9cshEOw+shi0JgRI16dIktwOo2G5V0XfKiRJeAEHTaAb2xYFMajE4RLoSqINMlAqiLAl9K4lXOievUqJmSuisJPXubJ3nW3LfBbAqErDOK6jiiRsOxiTwXTI3ZKsWYDSeDOLEKBJPZAm0EgRQ8ZymLZ82Xvsti5JPrksJsuAwVy0wzTVIrLQzTJLP2e71qqepmnlj3F2ElRcF4ZcjLgoaUmE1JJ/AYL2fcxZnVatSreZZbRw/pXehV0hY86ZIk36BsB8eB9/FfDumnui1VSSGIojbDUFHbLskVjBfJ7ud/Au7miZUUJdPpGFyFsOEp1Ujb3rf9uw6OsFXkNSpdmH19KLx9/w42mQiDjCz/tgAAAABJRU5ErkJggg==","tw_champion":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABdUlEQVR4nHVTIVDDQBDc70QUlzhwjQwuRBUUyNZh6xgkEhR1LaqVDApwsVVQiYMqiIxMHXGJIy7Mfsjn8zQ7k8nf//3e3d69QAdeTv0yzjO53mQFVttU7PLrdRGMlzNMXBee7cDe63e5wdKNhT8olRFt0HV2E23FvwwW/qB03xO5ZmQTzISgz4XXkFm6U3JSpXwwOpZ2mFSExJFjy/8qaJNbusHIvPwarkEBKV6NryxvSNJKXEJQbQqmavaHWF5eIfIK3IZzuXU3mcKP+7h+vG9pw0CCtes1M21GniVzHMJDmE3xsUqRzjMMnT5MX6tObxfqy/lbk7LpK84H+6Xe5/ynkJFYgn3mqMssgZmZvqI29FIYRReRhOwORazP6lnotVJOEqU2BeNFfiTiHs/ZgbhpDhQBNzkkZJd1RpvWKMvIBTD6bGaDUHPwHG8FAldOWJxmGBuC1r1fB27laxIokj88Ac27MM52ZmCCQ/KQfMt191sEfgFIH8CZR4376wAAAABJRU5ErkJggg==","tw_giant":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACFklEQVR4nIWTIVDbYBiGn3ITPy64xBGZudYFF3CZ61AdqkxRGaYCCqYKrnMdikOVqi2uraIoqOrVkaqlqq2iv/t2f7Md3NEen8h/l7zvc//3fl8KrKlGjJhzNoO5hssrCqt0G+vM5dCiFnfQgOvAWZQD3wWcRcgCcLyI/s0e2RgWWpFlUA7eQgqrqDKty/nJN7KJQmuNUjCZQbu3Wr+sqJrT5flaTAvDliXPzy2ZDkOJK0hUYfneaI4qLzfZMA/zoVgy5pZcnB4QFC3csMn+3j7fTxPCSgBzsF34c4fs7lgv7TRiZPrgiTHXI+ShZcl02pJKgEztJ2mqhjQjZPjLl7KPXNcReQrEgAxkY0lxO5wc77Nl2bg7txx8+sr55hD9CLtxwM9Ln3QEtZrPjyvA+oyzc7e0FqplJZNMY20pLKUYZxrbUTjtCkVVoqv7DBjg+AMeU9hUEB9v074d5xlMZhrPgzCw+OhZLLTGtTTFesKNbjMixQ0GuK5FyYWHfpVud4LJTGv4kOSjEWPUek7tUJEkmmw+plLfxHNHJN1tevdjGo2Agy9XpBMKCiS5fzXW8F+qpqVOEwmKyNmRLfU4D+/uGgn9XPNfu7aqZSVPHXtp9L18/mYPVmnfrLKhl0PFQh1ycW7jufA4gqRPwdzqXYDJpJ1o0sElVvE3aQaOrbC3kN7g7Sqv3W3ThjnTzPyP0Hsd2Kv6C+mZBw9YTJk+AAAAAElFTkSuQmCC","tw_party":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACvUlEQVR4nJ2Sy2sTURSHvztJJo+ZpEkfSYxNbWsfKgqtKOILRURRRDe60KUIQkHEv0BB1y504VoXiqJgdSciggurtrqx2pettlWbtEmaV5tMkrmSETpr/cE993LgfJzfORe32y2B/zoutyJF/VGVksUKDBfhRBAG05Az4EAYhpMmpqowmjA53KYwmzYJ+BRuvF5g6PQ6LMC4IdkzcIumeCsOr87ir9+EYnEKvmYckTjplw/Roh1IaeAIRajNT2J8ekHu1T0UgB8rEO7ZRGpuHk9bLxsPHsMwJYWPr1B/T9HS0Y35cxxXeAPV0SFOH9qN8DfVS3HWQ6cOyYkx1ENnmX35AF9vH+mJUSJ9e5m+foY1Dd60ru87+3G29tiAL0um1b6mrGDuP0I+m6f4/CbTz0HRguANINwayBrC34zX64NSyQZE/ArzUzM0NHVRTM6TuzOA8Ojg1lAiHQinC+HREKoPPDot8VaqS3MWQKmH8SUTLRbHn5qyii3pIatIShO0EPLvvBGlPA16CEdz1AaoXoXC3Lc1q0JrhFoVWcxAPoU5PQKFDNJYxSwVKVcNhFBsC2EVGvYeZ+LaKSspi2kowqXHw5SNClJx0KhrZHI58uUKwuWiujBjA1IVqGUSax1cvP8Wv7eR12Nf+PrhPdHNWykX8mRmJolu287lrhjOcIdtYbUCrs37rMT5+0OMjE1w98lTzIpBe2c7y59HcApJbH2EYCRKUBXUckkbUC5DQ+Iz524PMvjwEYlvkwS6uvkx8o7+3j5Cuw4TiMVJ/1pgObHA4nIBWSraFtoD8P39G7ovXGHnyRayqRQ7tnQzGw7Q2hbkqK9KTzxMtr+LTt1Jk0cBr/534PWZBc9dRWaToPpwNEYQUqFW34A0kbkUIhhFlgrWVoTbh1zNI7Qg2We3EKpwSkNW7e/6D3KEdf4AbDUgueYVxywAAAAASUVORK5CYII=","tw_elite":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABqUlEQVR4nH2TLVDDUBCEvzCIgAJHUQQXHFQhqQUFLqBoXHGpAxySOiR1DI4qQLYKUFDFxDWuwRXVqXvMXfJCyAA3k8n72bvb7G0c8ogCDKXo3OKU9//eRwHGjPziqYILzPRV78dPFJg5WVxev9L1nnAmEWftmD/j40hxq+417gyCbcy8vQgnEfT6um019WUsTWkiZ0kSE056BS79BC2QpjGnnVAPn2O48HxaTWWiNCXZ83wauzGnfoar+UAMjtCQShIH+99skwQ67jT7/tmiFnnMGnPXy961JX4qveNjtjZzld0pQbRA/AjDlwcidw/Py5IH8c88qkU4nprg3ZiRGRmOjSEYG/bvf53OfPVAGAzIOq93POgf4i77UAPcKhrmyhur9s6Lo7SZpUXydnKuOlRZOOWDIFhja2OZJBnSPIGBf487G2py9yqbBCs3tMO64t+GeQExknhBQkZlp2HVLu/7DzI/tFCjXs8/IXeYOLEMFrXlsYWEhcXZhoUG4du3w6qjkrX4QnxgceJK1cCKJzNO899A3FidtWDE/+rAUpMCpPMvRbXAX/dfjNzc5H0xqDQAAAAASUVORK5CYII=","tw_unique":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABj0lEQVR4nKVTLXPCQBTcZCqQxYEjMjgkOIKLTB3gcCCpa/sPkIVfkOJAxnVQBEdkZHAgUQzuOvvK3Rwprjtzucu7fV97dw4eoB2Nled3UOSpsRXFAacsccpclx+/Gyk62eRJkMrMMZsA52Nxl4A+JkCR56h7TcQXpaLpp2Kml9cDpvsQfghwfT3lDvfIIZc+d4gvStDdKolcqflSFWeORxxTAbH+mCNIgep6jlorVM91D1m6kT2uabM5Gg6z2AKRGPbHyHeJ9E94XgN+O0SyXBie9nOp9mrWEIMulc5pFOCYVWRM1juxEeQwCYUlXB4VRYpWTbQ6XVFbMg+XQNw3pdLGSgiKSx8JgBuS98T0bDBcYoS9+dX75OpgLiOzhTwBruejCMbNLxQyAlSNDtwjh1zdwhM/vcFGzvmWSFEw6lwWsSgWzOKcsgS9wa9eBvqScKZIHPoO6H+bgzLi/1wkEsuXhP3yZNojT9aEzbHfjjwmnUUH3H6PVf8tliq4th3I1Y/pz/Mk2G/ZxvthCW3wA7aQMlDatplDAAAAAElFTkSuQmCC","ic_attack":"data:image/png;base64,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","ic_recovery":"data:image/png;base64,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","ic_sit":"data:image/png;base64,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","ic_autoget":"data:image/png;base64,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"};
const LEAN_CSS = ":host{position:fixed;right:18px;top:90px;width:450px;z-index:2147483646;font:12px/1.3 Arial,Helvetica,sans-serif;color:#efdaa4;color-scheme:dark;text-shadow:1px 1px #000}\n*{box-sizing:border-box} [hidden]{display:none!important}\n.panel{position:relative;padding-bottom:19px;background:rgba(15,19,17,.96);box-shadow:0 8px 28px #000a}\n.panel:before{content:'';position:absolute;inset:36px 14px 16px;background-image:var(--s-tile_a);opacity:.55;pointer-events:none}\n.frame{position:absolute;pointer-events:none;background-repeat:no-repeat}\n.frame.lu{left:0;top:0;width:40px;height:68px;background-image:var(--s-f_lu)}\n.frame.mu{left:40px;right:40px;top:0;height:68px;background-image:var(--s-f_mu);background-repeat:repeat-x}\n.frame.ru{right:0;top:0;width:40px;height:68px;background-image:var(--s-f_ru)}\n.frame.ls{left:0;top:68px;bottom:48px;width:40px;background-image:var(--s-f_ls);background-repeat:repeat-y}\n.frame.rs{right:0;top:68px;bottom:48px;width:40px;background-image:var(--s-f_rs);background-repeat:repeat-y}\n.frame.ld{left:0;bottom:0;width:40px;height:48px;background-image:var(--s-f_ld)}\n.frame.md{left:40px;right:40px;bottom:0;height:48px;background-image:var(--s-f_md);background-repeat:repeat-x}\n.frame.rd{right:0;bottom:0;width:40px;height:48px;background-image:var(--s-f_rd)}\nheader{position:relative;z-index:1;height:34px;display:flex;align-items:center;justify-content:center;cursor:move;touch-action:none;padding:6px 32px 0;color:#fff}\nheader button.update,header button.discord{height:22px;min-width:0;margin-left:8px;font-size:11px}\nheader strong{font-weight:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\nheader button.version{display:inline;height:auto;min-width:0;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:inherit;text-decoration:underline dotted;text-underline-offset:3px}header button.version:hover{color:#f0d98c}\nheader button.fold{position:absolute;right:10px;top:10px;width:16px;min-width:16px;height:16px;padding:0;border:0;background:var(--s-close);color:transparent;font-size:0}\nheader button.fold:hover{background-image:var(--s-close_f)}\n.body{position:relative;z-index:1;margin:0 15px}\nbutton,input,select{font:12px Arial,Helvetica,sans-serif;color:inherit;text-shadow:inherit;border-radius:0}\nbutton{display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:24px;padding:0 6px;cursor:pointer;white-space:nowrap;background:transparent;color:#fefbd8;border-style:solid;border-width:5px;border-image-source:var(--s-btn);border-image-slice:6 fill;border-image-width:5px;border-image-repeat:stretch;line-height:14px}\nbutton:hover{border-image-source:var(--s-btn_f);color:#fff}button:active{border-image-source:var(--s-btn_p)}button:disabled{border-image-source:var(--s-btn_d);color:#7c786c;cursor:default}\nbutton:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid #ffe08a;outline-offset:1px}\nnav,.row,.subtabs{display:flex;align-items:center;gap:5px;flex-wrap:wrap}\nnav{padding-top:4px;gap:2px}nav button{flex:1;padding:0 5px;font-size:11px}.subtabs{margin:0 0 8px;gap:2px}\nnav button,.subtabs button{height:24px;min-width:56px;padding:0 8px;color:#d8d4c4;border-width:0 6px;border-image-source:var(--s-tab_off);border-image-slice:0 8 fill;border-image-width:0 6px;line-height:23px}\nnav button[aria-selected=true],.subtabs button[aria-selected=true]{color:#fff;border-image-source:var(--s-tab_on)}\n.subtabs button{font-size:11px;min-width:48px;border-image-source:var(--s-stab_off)}\n.subtabs button[aria-selected=true]{border-image-source:var(--s-stab_on)}\n.class-tabs{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:7px}.class-tabs button{font-size:11px;gap:4px;text-transform:capitalize;flex:1;min-width:80px}.class-tabs button[aria-selected=true]{color:#ffe08a}.class-tabs i{display:inline-block;width:16px;height:16px;flex:0 0 16px;background-size:16px 16px}\n.pane,.dialog-body{padding-top:9px;max-height:clamp(220px,calc(100vh - 300px),720px);overflow:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-color:#796a48 #171711}\n.pane::-webkit-scrollbar,.dialog-body::-webkit-scrollbar{width:16px}.pane::-webkit-scrollbar-track,.dialog-body::-webkit-scrollbar-track{background-image:var(--s-scr_bar)}.pane::-webkit-scrollbar-thumb,.dialog-body::-webkit-scrollbar-thumb{background:var(--s-scr_btn) center/16px 100% no-repeat;min-height:16px}.pane::-webkit-scrollbar-thumb:hover,.dialog-body::-webkit-scrollbar-thumb:hover{background-image:var(--s-scr_btn_f)}\nfieldset{position:relative;min-width:0;border:0;margin:0 0 9px;padding:25px 10px 9px;background-color:#282728;background-image:var(--s-ib_lu),var(--s-ib_ru),var(--s-ib_ld),var(--s-ib_rd),var(--s-ib_mu),var(--s-ib_md),var(--s-ib_ls),var(--s-ib_rs);background-position:left top,right top,left bottom,right bottom,left top,left bottom,left top,right top;background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,repeat-x,repeat-x,repeat-y,repeat-y}\nlegend{position:absolute;left:9px;right:9px;top:3px;padding:0;height:13px;line-height:13px;color:#ffd65a;font-weight:bold}\n.field{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0;min-height:18px}.field>span{flex:1}\ninput:not([type=checkbox]),select{height:22px;background:#080907;border:1px solid #5d5034;padding:0 4px;outline:none;min-width:0;color:#efdaa4}\ninput:focus,select:focus{border-color:#c9a85c}.field input[type=number]{width:66px;text-align:right}.field input[type=text]{width:170px}.field select{max-width:220px;min-width:110px}\ninput[type=checkbox]{appearance:none;width:16px;height:16px;flex:0 0 16px;margin:0;border:0;background:var(--s-chk_off) center/16px 16px;cursor:pointer}input[type=checkbox]:checked{background-image:var(--s-chk_on)}\n.status{padding:6px 6px 8px;min-height:3lh;box-sizing:content-box;white-space:pre-line;color:#f4eedc;border-bottom:1px solid #5d503455}\n.controls{padding:6px 0;gap:3px}.controls button:first-child{flex:1}\n.feedback{padding:6px 4px 0;overflow-wrap:anywhere;font-size:11px;min-height:8px}\n.muted{color:#a09b8c;font-size:11px;margin:6px 0}\n.grid{display:flex;flex-wrap:wrap;gap:5px;align-content:flex-start;margin:8px 0}\nbutton.slot,.skill-icon{position:relative;display:inline-block;flex:0 0 34px;width:34px;min-width:34px;height:34px;border:1px solid #4e4532;border-image:none;background:#050505;box-shadow:inset 0 0 0 1px #17140e;padding:0;overflow:hidden;vertical-align:middle}\nbutton.slot:hover{border-image:none;border-color:#d9b765}.slot.on{border-color:#ffe08a;box-shadow:0 0 5px 1px #ffd678a6}\n.slot img,.skill-icon img{position:absolute;inset:0;width:32px;height:32px;image-rendering:auto}\n.fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#b1a17b}.slot[data-icon-loaded=true]>.fallback,.skill-icon[data-icon-loaded=true]>.fallback{display:none}\n.slot .cd{position:absolute;inset:0;background:conic-gradient(#000b var(--p,0%),transparent 0);pointer-events:none}\n.slot .seconds{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:bold;font-size:11px;pointer-events:none}\n.slot .order{position:absolute;left:1px;top:0;color:#ffd65a;font-size:10px;line-height:11px;pointer-events:none}\n.skill-row{display:flex;align-items:center;gap:7px;min-height:42px;padding:4px 5px;margin:3px 0;background-image:var(--s-bar_l),var(--s-bar_r),var(--s-bar);background-position:left,right,center;background-repeat:no-repeat,no-repeat,repeat-x;background-size:4px 100%,4px 100%,auto 100%}\n.skill-row:hover{background-image:var(--s-bars_l),var(--s-bars_r),var(--s-bars)}\n.skill-row .skill-info{flex:1;min-width:0}.skill-name{display:block;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.skill-detail{font-size:10px;color:#d6c794}.skill-row button.mini{min-width:22px;width:22px;padding:0;height:22px}\n.picker-title{display:flex;align-items:center;gap:6px;justify-content:space-between;margin-top:8px}.picker-title input{max-width:170px;width:50%;font-size:11px}\n.skill-tip{position:fixed;z-index:2147483647;max-width:270px;pointer-events:none;padding:9px;background:rgba(8,9,6,.97);border:1px solid #b79b5c;box-shadow:inset 0 0 0 2px #30291c,0 3px 10px #000;font-size:12px;color:#efdaa4;white-space:pre-line;text-shadow:1px 1px #000}\n.skill-tip strong{display:block;color:#fff;margin-bottom:5px}.empty{padding:10px 4px;color:#a09b8c;text-align:center}\npre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:130px;overflow:auto;overscroll-behavior:contain;margin:5px 0}\n.wardrobe-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-bottom:8px}\n.wardrobe-item{min-width:0;height:48px;padding:4px;justify-content:flex-start;gap:6px;text-align:left;font-size:10px;white-space:normal;line-height:12px}\n.wardrobe-item>.slot{flex:0 0 34px}.wardrobe-item>span:last-child{overflow:hidden;max-height:36px;overflow-wrap:anywhere}\n.wardrobe-item[aria-pressed=true]{color:#ffe08a;outline:1px solid #ffe08a;outline-offset:-2px}\n@media(max-width:500px){:host{right:4px;top:70px;width:calc(100vw - 8px)}.body{margin:0 13px}.pane{max-height:clamp(200px,calc(100vh - 280px),720px)}.field input[type=text]{width:150px}.skill-row{gap:4px}.controls{gap:2px}}\n\n.waiting{white-space:pre-line;color:#c8d9ae;margin:4px 0}:host(:not(.wide)) .waiting{min-height:2lh}\ntextarea{width:100%;color:inherit;background:#151916;font:11px monospace}\n\n.dialog{position:fixed;width:min(430px,calc(100vw - 8px));z-index:10}.dialog[hidden]{display:none}.dialog-body{max-height:min(70vh,640px);margin:0 15px}.report-preview .field{display:block}.report-preview .field>span{display:block;margin-bottom:4px}.report-image{display:block;width:100%;height:auto;margin:6px 0;border:1px solid #5d5034}\n.patch-notes .release{margin:2px 0 10px}.patch-notes .release>strong{display:block;color:#f0d98c;font-weight:normal;margin-bottom:4px}.patch-notes ul{margin:0;padding-left:18px}.patch-notes li{margin:3px 0;line-height:1.4}.patch-notes .row{margin-bottom:6px}\n.update-note{color:#f0d98c;font-size:11px;line-height:1.35;margin:2px 0 6px}.update-note[hidden]{display:none}\n:host(.min){width:auto!important}\n.orb{position:relative;display:block;width:40px;min-width:40px;height:40px;padding:2px;border:1px solid #c9a85c;background:#000;box-shadow:0 0 0 1px #000,0 3px 10px #000c;cursor:grab;touch-action:none}\n.orb:hover{border-color:#ffe08a;background:#000}.orb:active{cursor:grabbing}\n.orb img{position:absolute;inset:2px;width:34px;height:34px;pointer-events:none}\n.orb-mark{display:grid;place-items:center;width:100%;height:100%;color:#c9a85c;font-weight:bold}\n.orb-dot{position:absolute;right:-5px;bottom:-5px;width:12px;height:12px;border-radius:50%;border:2px solid #000;background:#d9583e;box-shadow:0 0 6px #d9583e}\n.orb[data-state=ok] .orb-dot{background:#7bd155;box-shadow:0 0 6px #7bd155;animation:orb-blink 1.6s infinite}\n.orb[data-state=busy] .orb-dot{background:#ffd65a;box-shadow:0 0 6px #ffd65a}\n@keyframes orb-blink{50%{opacity:.45}}\n.orb.alert{animation:orb-ring 1s infinite}@keyframes orb-ring{50%{box-shadow:0 0 0 1px #000,0 0 14px 4px #6fc1ff}}\n.orb-tip{position:absolute;right:48px;top:50%;transform:translateY(-50%);display:none;width:max-content;max-width:260px;padding:6px 9px;text-align:left;font-weight:normal;line-height:1.35;background:rgba(11,10,7,.96);border:1px solid #6b5a36;white-space:normal;cursor:default}\n.orb.left .orb-tip{right:auto;left:48px}\n.orb:hover .orb-tip,.orb.alert .orb-tip{display:grid}\n.orb-tip strong{color:#9fe27e}.orb[data-state=stop] .orb-tip strong{color:#f08c74}.orb[data-state=busy] .orb-tip strong{color:#ffd65a}.orb.alert .orb-tip strong{color:#6fc1ff}\n.orb-tip em{font-style:normal;color:#b9a878;font-size:10px;margin-top:2px}\n/* Wide window (opt-in, screens at least 900 px wide). The compact window is unchanged. */\n.wide-only,.classic-only,nav button>img,header button.layout{display:none}\n@media(min-width:900px){\nheader button.layout{display:inline-flex;height:22px;min-width:0;margin-left:8px;font-size:11px}\n:host(.wide){width:min(1000px,calc(100vw - 8px))}\n:host(.wide) .body{display:grid;grid-template-columns:104px minmax(0,1fr) 196px;grid-template-areas:\"note note note\" \"strip strip ctl\" \"nav wait side\" \"nav pane side\" \"nav fb side\" \"log log log\";column-gap:8px;align-items:start}\n:host(.wide) .wide-only{display:block}\n:host(.wide) .status{display:none}\n:host(.wide) .update-note{grid-area:note}\n:host(.wide) .strip{grid-area:strip;display:grid;grid-template-columns:150px minmax(0,1fr) 210px;gap:12px;align-items:center;margin:4px 0 8px;padding:9px 12px;background-color:#282728;background-image:var(--s-ib_lu),var(--s-ib_ru),var(--s-ib_ld),var(--s-ib_rd),var(--s-ib_mu),var(--s-ib_md),var(--s-ib_ls),var(--s-ib_rs);background-position:left top,right top,left bottom,right bottom,left top,left bottom,left top,right top;background-repeat:no-repeat,no-repeat,no-repeat,no-repeat,repeat-x,repeat-x,repeat-y,repeat-y}\n:host(.wide) .who strong{display:block;color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}:host(.wide) .who .muted{display:block;margin:2px 0 0;text-transform:capitalize}\n:host(.wide) .bars{display:grid;gap:3px}:host(.wide) .gauge{display:grid;grid-template-columns:28px minmax(0,1fr) 96px;align-items:center;gap:6px}\n:host(.wide) .gauge label{color:#b9a878;font-size:10px;font-weight:bold}:host(.wide) .gauge span{text-align:right;font-size:11px;color:#fff;font-variant-numeric:tabular-nums}\n:host(.wide) .track{height:10px;background:#050505;border:1px solid #4e4532;padding:1px}:host(.wide) .track i{display:block;height:100%;width:0;transition:width .3s}\n:host(.wide) .gauge.hp i{background:linear-gradient(#ff7a6a,#b01e1a 55%,#6e0f0d)}:host(.wide) .gauge.mp i{background:linear-gradient(#7fb4ff,#2557b8 55%,#16337a)}:host(.wide) .gauge.xp i{background:linear-gradient(#ffe58a,#c99a1e 55%,#7a5a0a)}\n:host(.wide) .state{display:grid;grid-template-columns:10px minmax(0,1fr);column-gap:7px;align-items:center;padding:5px 9px;background:#0a0d0b;border:1px solid #7a3a2c}\n:host(.wide) .state strong{color:#f08c74;font-size:13px}:host(.wide) .state span{grid-column:2;color:#b9a878;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n:host(.wide) .state-dot{width:8px;height:8px;border-radius:50%;background:#d9583e;box-shadow:0 0 6px #d9583e}\n:host(.wide) .state[data-state=ok]{border-color:#4e6b3c}:host(.wide) .state[data-state=ok] strong{color:#9fe27e}:host(.wide) .state[data-state=ok] .state-dot{background:#7bd155;box-shadow:0 0 6px #7bd155;animation:orb-blink 1.6s infinite}\n:host(.wide) .state[data-state=busy]{border-color:#7a6a2c}:host(.wide) .state[data-state=busy] strong{color:#ffd65a}:host(.wide) .state[data-state=busy] .state-dot{background:#ffd65a;box-shadow:0 0 6px #ffd65a}\n:host(.wide) .controls{grid-area:ctl;display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:4px 0 8px;align-self:center}:host(.wide) .controls button:first-child{grid-column:1/-1;height:28px;font-weight:bold;color:#fff}\n:host(.wide) .waiting{grid-area:wait}\n:host(.wide) nav{grid-area:nav;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:3px;padding-top:0}\n:host(.wide) nav button{flex:none;flex-direction:column;gap:3px;height:58px;padding:0;font-size:11px;border:0;border-image:none;background:linear-gradient(#262420,#16150f);box-shadow:inset 0 0 0 1px #4a4130}\n:host(.wide) nav button:hover{color:#fff;box-shadow:inset 0 0 0 1px #8f7a45}\n:host(.wide) nav button[aria-selected=true]{color:#fff;background:linear-gradient(#2a5b74,#183447);box-shadow:inset 0 0 0 1px #5fb6d9,0 0 6px #2d7fa588}\n:host(.wide) nav button>img{display:block;width:28px;height:28px;border:1px solid #5d5034;background:#000}\n:host(.wide) .pane{grid-area:pane;padding-top:0;height:clamp(240px,calc(100vh - 470px),600px);max-height:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:8px;align-content:start;align-items:start}\n:host(.wide) .pane>:not(fieldset){grid-column:1/-1}\n/* A page with one long box (Loot) spreads its rows over both columns. */\n:host(.wide) .pane>fieldset:only-of-type{grid-column:1/-1;columns:2;column-gap:28px}:host(.wide) .pane>fieldset:only-of-type>*{break-inside:avoid}:host(.wide) .pane>fieldset:only-of-type>p.muted{column-span:all}\n:host(.wide) .feedback{grid-area:fb}\n:host(.wide) .side{grid-area:side}:host(.wide) .side fieldset{margin-bottom:8px}:host(.wide) .side button{width:100%;margin-top:6px}\n:host(.wide) .readout{display:flex;justify-content:space-between;gap:6px;margin:4px 0;font-size:11px}:host(.wide) .readout span{color:#b9a878}:host(.wide) .readout b{color:#fff;font-weight:normal;text-align:right;font-variant-numeric:tabular-nums}\n:host(.wide) .logbox{grid-area:log;margin-top:4px;padding:7px 12px 8px;background:#0b0a07cc;border:1px solid #4a4130}:host(.wide) .logbox>strong{color:#ffd65a}\n:host(.wide) .log{list-style:none;margin:4px 0 0;padding:0;height:78px;overflow:auto;overscroll-behavior:contain;font-size:11px;scrollbar-color:#796a48 #171711}\n:host(.wide) .log li{display:flex;gap:8px;padding:1px 0}:host(.wide) .log time{color:#7f7458;font-variant-numeric:tabular-nums;flex:none}:host(.wide) .log li.warn span,:host(.wide) .log li.error span{color:#ffc67a}\n}\n/* Map page */\n.map-stage{position:relative;border:1px solid #6b5a36;box-shadow:0 0 0 2px #0b0a07,0 0 0 3px #4a4130;margin:2px 0 6px}\n.map-stage canvas{display:block;width:100%;height:280px;cursor:crosshair;touch-action:none}\n.map-tools{position:absolute;right:5px;top:5px;display:flex;gap:2px}.map-tools button{min-width:24px;height:22px;padding:0 6px;font-size:12px}\n.map-coords{position:absolute;left:5px;bottom:4px;padding:1px 6px;background:#000a;font-size:11px;pointer-events:none}.map-coords:empty{display:none}\n.map-legend{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:11px}.map-legend i{display:inline-block;width:12px;height:12px;background:center/contain no-repeat}\n@media(min-width:900px){:host(.wide) .pane>.map-box{grid-column:1/-1}:host(.wide) .map-stage canvas{height:340px}}\n/* Town page: the trip as a row of item pictures */\n.trip-flow{list-style:none;display:flex;margin:4px 0 0;padding:0}.trip-flow li{flex:1;display:grid;justify-items:center;gap:2px;position:relative;text-align:center;min-width:0}\n.trip-flow li:not(:last-child):after{content:'';position:absolute;top:17px;left:calc(50% + 21px);right:calc(-50% + 21px);height:2px;background:linear-gradient(90deg,#c9a85c,#5d5034)}\n.trip-flow strong{color:#fff;font-size:11px;font-weight:normal}.trip-flow small{color:#a09b8c;font-size:10px}.trip-flow small.missing{color:#ffc67a}\nnav button{min-width:0;padding:0 3px}\n@media(min-width:900px){:host(.wide) .pane>fieldset:has(.trip-flow){grid-column:1/-1}}\n/* Party page */\n.members{display:grid;gap:3px}\n.member{display:grid;grid-template-columns:minmax(0,1fr) 110px auto;align-items:center;gap:8px;min-height:38px;padding:4px 6px;background-image:var(--s-bar_l),var(--s-bar_r),var(--s-bar);background-position:left,right,center;background-repeat:no-repeat,no-repeat,repeat-x;background-size:4px 100%,4px 100%,auto 100%}\n.member.dead{opacity:.6}.member-name strong{display:block;color:#fff;font-weight:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.member-name .muted{margin:0}\n.member-bars{display:grid;gap:3px}.pbar{height:5px;background:#050505;border:1px solid #3d3626}.pbar i{display:block;height:100%}.pbar.hp i{background:linear-gradient(#ff7a6a,#b01e1a)}.pbar.mp i{background:linear-gradient(#7fb4ff,#2557b8)}\n.member-buffs{display:flex;gap:2px}.member-buffs .skill-icon{width:22px;min-width:22px;height:22px;flex:0 0 22px}.member-buffs .skill-icon img{width:20px;height:20px}.member-buffs .skill-icon.off{filter:grayscale(1) brightness(.5)}\n@media(min-width:900px){:host(.wide) .pane>fieldset:has(.members){grid-column:1/-1}}\n/* Items page */\n.degrees{display:flex;flex-wrap:wrap;gap:4px 8px;margin:4px 0 8px}.degrees label{display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer}\n.bulk{gap:3px;margin:4px 0 6px}.bulk button{min-width:0;font-size:11px;padding:0 6px}.bulk button.armed{color:#ffc67a}\n.item-table{display:grid;border:1px solid #3d3626;max-height:none}\n.item-row{display:grid;grid-template-columns:26px minmax(0,1fr) 26px 34px repeat(5,30px);align-items:center;gap:2px;min-height:28px;padding:1px 3px;border-top:1px solid #2f2a1e}\n.item-row.head{min-height:20px;border-top:0;color:#b9a878;font-size:10px;text-align:center}.item-row.head span:nth-child(2){text-align:left}\n.item-row:not(.head):hover{background:#ffffff0a}.item-row.ruled{background:#2a2414}\n.item-row .skill-icon{width:24px;min-width:24px;height:24px;flex:0 0 24px}.item-row .skill-icon img{width:22px;height:22px}\n.item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff}.item-name em{font-style:normal;color:#6fc1ff;margin-left:5px;font-size:10px}\n.item-row>span:nth-child(3){text-align:center;color:#d6c794}\n.item-row button.cell{min-width:0;width:100%;height:20px;padding:0;font-size:11px;border-width:3px}.item-row button.cell.on{color:#ffd65a}\n.pager{justify-content:space-between;margin-top:6px}\n.item-menu{position:fixed;z-index:30;display:grid;gap:2px;min-width:170px;padding:6px;background:rgba(11,10,7,.97);border:1px solid #6b5a36;box-shadow:0 4px 14px #000}\n.item-menu strong{color:#fff;font-weight:normal;margin:0 2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item-menu button{justify-content:flex-start;height:22px}\n@media(min-width:900px){:host(.wide) .pane>fieldset:has(.item-table){grid-column:1/-1}:host(.wide) .item-row{grid-template-columns:26px minmax(0,1fr) 34px 44px repeat(5,48px)}}\n/* Ten pages: two rows of five tabs in the compact window. The wide window keeps its page list. */\nnav button{flex:1 0 calc(20% - 2px)}\nfieldset>input[type=search]{width:100%;margin:2px 0 6px}\n.sx-score{margin:0 0 6px;color:#fff;font-weight:bold}\n.sx-rows{display:block}.sx-row{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid #3a321c}.sx-row:first-child{border-top:0}\n.sx-text{flex:1;min-width:0}.sx-text strong{display:block;color:#fff}.sx-text .muted{display:block;margin-top:1px}\n.sx-ico{--c:#8a8a8a;overflow:visible}.sx-ico:after{content:'';position:absolute;right:-4px;bottom:-4px;width:11px;height:11px;border-radius:50%;border:1px solid #000;background:var(--c)}\n.sx-ok .sx-ico{--c:#7fd08a}.sx-warn .sx-ico{--c:#f0b64a}.sx-bad .sx-ico{--c:#e8776a}\n.sx-row button{flex:0 0 auto;min-width:64px}\n\n/* Shared activity views own their scrolling inside Settings and the session window. */\n.activity-history{position:relative;height:220px;max-height:30vh;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;margin:6px 0;padding:6px;list-style:none;background:#171711;border:1px solid #5d5034;font-size:11px}\n.activity-history[hidden]{display:none}.activity-history li{display:flex;gap:7px;line-height:1.5}.activity-history time{flex:none;color:#b0a48b}.activity-history span{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.activity-history .warn{color:#ffc67a}.activity-history .error{color:#ff9999}.activity-history .cmd{color:#aba79c}\n.session-window .dialog-body{max-height:calc(100vh - 100px)}:host(.wide) .session-window .body{display:block}.session-window .field{margin:3px 0}.session-window .session-values{padding-bottom:6px}\n.activity-panel[hidden]{display:none}.activity-panel>.row{display:flex;flex-wrap:wrap;gap:4px}.activity-panel select{max-width:160px}.activity-panel input[type=search]{box-sizing:border-box;width:100%;margin:4px 0}.activity-panel .field{white-space:normal}.activity-export .dialog-body{display:block}.activity-export textarea{box-sizing:border-box;width:100%;font:11px monospace}:host(.wide) .activity-export .body{display:block}\n.activity-history,.activity-history *{user-select:text;-webkit-user-select:text}\n:host(.wide) .logbox .activity-history{height:78px;max-height:none;margin:4px 0 0;padding:0;background:none;border:0}\n.activity-history .activity-message{flex:1}.activity-history .activity-repeat{flex:0 0 auto;margin-left:auto;white-space:nowrap;color:#b9a878}\n:host(.wide) .pane>.pane-cols{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:8px;align-items:start}.pane-col{min-width:0}\n/* Classic window (opt-in, screens at least 900 px wide): SBot-style frame and tab order, black with lavender headings. */\n@media(min-width:900px){\n:host(.classic){--c-bg:#000;--c-line:#fff;--c-head:#b9b2ff;--c-text:#fff;--c-dim:#b8b8c0;--c-chip:#2f6cff;--c-field:#000;--c-bar:#fff;\n  width:840px;font:11px/1.25 Arial,Helvetica,sans-serif;color:var(--c-text);text-shadow:none}\n:host(.classic) .classic-only,:host(.classic) .wide-only{display:block}\n:host(.classic) .frame,:host(.classic) .panel:before,:host(.classic) .logbox,:host(.classic) .status,:host(.classic) .update-note:empty{display:none}\n:host(.classic) .panel{padding-bottom:0;background:var(--c-bg);border:1px solid #6d6d78;box-shadow:0 8px 28px #000a}\n:host(.classic) header{height:30px;padding:0 90px 0 8px;background:#fff;color:#000;justify-content:flex-start}\n:host(.classic) header strong{color:#000;font-weight:normal;font-size:12px}\n:host(.classic) header button{height:20px;min-width:0;color:#000;background:#f1f1f1;border:1px solid #9a9aa3;border-image:none;padding:0 7px;font-size:11px}\n:host(.classic) header button.version{background:none;border:0;padding:0;margin:0 0 0 4px;text-decoration:underline dotted}\n:host(.classic) header button.fold{background:none;border:0;width:16px;height:16px;top:7px;right:10px;color:#000;font-size:0;background-image:var(--s-close)}\n:host(.classic) .panel:not(.dialog)>.body{margin:0;padding:0 0 6px;display:grid;grid-template-columns:106px minmax(0,1fr) 140px;column-gap:6px;align-items:start;\n  grid-template-areas:\"menu menu menu\" \"note note note\" \"strip strip strip\" \"ctl ctl ctl\" \"nav wait side\" \"nav pane side\" \"nav fb side\"}\n:host(.classic) .menubar{grid-area:menu;display:flex;gap:2px;position:relative;padding:3px 6px;background:#fff;color:#000;margin-bottom:4px}\n:host(.classic) .menubar button.menu-title{height:20px;min-width:0;padding:0 8px;border:0;border-image:none;background:none;color:#000;font-size:12px}\n:host(.classic) .menubar button.menu-title:hover{background:#d9e8ff}\n:host(.classic) .menu{position:absolute;top:100%;z-index:5;display:flex;flex-direction:column;min-width:190px;background:#fff;border:1px solid #9a9aa3;box-shadow:2px 3px 8px #0008}\n:host(.classic) .menu button{justify-content:flex-start;height:24px;padding:0 12px;border:0;border-image:none;background:none;color:#000;font-size:12px}\n:host(.classic) .menu button:hover{background:#d9e8ff}\n:host(.classic) .update-note{grid-area:note;margin:0 8px 4px}\n:host(.classic) .strip{grid-area:strip;display:grid;grid-template-columns:150px minmax(0,1fr) 250px;gap:12px;align-items:center;margin:0 6px;padding:4px 0 6px;min-height:76px;background:none}\n:host(.classic) .who strong{display:block;color:var(--c-head);font-size:15px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n:host(.classic) .who .muted{display:block;margin:2px 0 0;color:var(--c-dim);text-transform:capitalize}\n:host(.classic) .bars{display:grid;gap:4px}\n:host(.classic) .gauge{display:grid;grid-template-columns:26px minmax(0,1fr);align-items:center;gap:6px;position:relative}\n:host(.classic) .gauge label{color:var(--c-text);font-size:11px}\n:host(.classic) .gauge .track{height:14px;padding:1px;background:#050505;border:1px solid #6d6d78}\n:host(.classic) .gauge .track i{display:block;height:100%;width:0;transition:width .3s}\n:host(.classic) .gauge.hp i{background:#8a1010}:host(.classic) .gauge.mp i{background:#1c2f9a}:host(.classic) .gauge.xp i{background:#157a1c}\n:host(.classic) .gauge span{position:absolute;left:32px;right:0;text-align:center;font-size:10px;line-height:14px;color:#fff;pointer-events:none}\n:host(.classic) .state{display:none}\n:host(.classic) .cstat{display:grid;gap:1px;font-size:11px}\n:host(.classic) .cstat div{display:grid;grid-template-columns:100px minmax(0,1fr)}\n:host(.classic) .cstat span{color:var(--c-head);font-weight:bold;text-align:right;padding-right:8px}\n:host(.classic) .cstat b{font-weight:normal;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n:host(.classic) .controls{grid-area:ctl;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0 6px 8px}\n:host(.classic) .controls button{height:24px;min-width:0;font-weight:normal}\n:host(.classic) .controls button:first-child{grid-column:auto;height:24px;color:#fff}\n:host(.classic) .controls button:nth-child(4){display:none}\n:host(.classic) button{height:22px;min-width:0;padding:0 8px;color:#fff;background:#000;border:1px solid var(--c-line);border-image:none;font-size:11px}\n:host(.classic) button:hover{background:#17173a;border-image:none;color:#fff}\n:host(.classic) button:active{background:#262660;border-image:none}\n:host(.classic) button:disabled{color:#777;border-color:#555;background:#000;border-image:none}\n:host(.classic) nav{grid-area:nav;flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:2px;padding:0 0 0 6px}\n:host(.classic) nav button{flex:none;justify-content:flex-start;gap:6px;height:23px;padding:0 4px;border:0;background:none;color:#fff;font-size:12px;text-align:left}\n:host(.classic) nav button>img{display:block;width:16px;height:16px;border:0;background:none;flex:none}\n:host(.classic) nav button:hover{background:#17173a;box-shadow:none}\n:host(.classic) nav button[aria-selected=true]{background:var(--c-chip);color:#fff;box-shadow:none}\n:host(.classic) .waiting{grid-area:wait;min-height:2lh;margin:0 0 4px;color:var(--c-dim)}\n:host(.classic) .pane{grid-area:pane;display:block;height:min(470px,calc(100vh - 360px));min-height:240px;max-height:none;padding:6px 10px 6px 6px;background:#000;border:1px solid #2a2a33;\n  overflow-y:scroll;overflow-x:hidden;scrollbar-color:#6a6a78 #101014}\n:host(.classic) .pane::-webkit-scrollbar{width:14px}\n:host(.classic) .pane::-webkit-scrollbar-track{background:#101014;background-image:none}\n:host(.classic) .pane::-webkit-scrollbar-thumb{background:#c9c9d2;border:2px solid #101014;background-image:none}\n:host(.classic) fieldset{margin:0 0 16px;padding:0;border:0;background:none;box-shadow:none}\n:host(.classic) legend{position:static;display:block;width:60%;height:auto;margin:2px 0 8px;padding:0 0 3px;color:var(--c-head);font-size:16px;font-style:italic;font-weight:bold;line-height:1.2;border-bottom:1px solid #ddd}\n:host(.classic) .field{justify-content:flex-start;gap:8px;margin:5px 0;min-height:18px}\n:host(.classic) .field>span{flex:0 1 auto}\n:host(.classic) .field:has(input[type=checkbox]){flex-direction:row-reverse;justify-content:flex-end;gap:6px}\n:host(.classic) .field:has(input[type=checkbox])>span{flex:0 1 auto}\n:host(.classic) input:not([type=checkbox]),:host(.classic) select{height:20px;background:var(--c-field);border:1px solid var(--c-line);color:#fff;padding:0 4px}\n:host(.classic) input:focus,:host(.classic) select:focus{border-color:var(--c-head)}\n:host(.classic) input[type=checkbox]{appearance:auto;width:13px;height:13px;flex:0 0 13px;background:none;accent-color:#fff}\n:host(.classic) .muted{color:var(--c-dim);font-size:11px}\n:host(.classic) .row{gap:6px}\n:host(.classic) .subtabs button,:host(.classic) .class-tabs button{border-image:none;border:1px solid var(--c-line);background:#000;color:#fff}\n:host(.classic) .subtabs button[aria-selected=true],:host(.classic) .class-tabs button[aria-selected=true]{background:var(--c-chip)}\n:host(.classic) .feedback{grid-area:fb;padding:4px 2px 0;min-height:18px}\n:host(.classic) .side{grid-area:side;padding-right:6px;display:flex;flex-direction:column;gap:6px;align-self:stretch}\n:host(.classic) .side fieldset{margin:0}\n:host(.classic) .side legend{width:100%;font-size:11px;font-style:normal;margin:0 0 4px;padding-bottom:2px;border-bottom:1px solid #6d6d78}\n:host(.classic) .side button{width:100%;margin-top:0}\n:host(.classic) .side-actions{display:grid;gap:6px;margin-top:4px}\n:host(.classic) .readout{display:flex;justify-content:space-between;gap:6px;margin:1px 0;font-size:11px}\n:host(.classic) .readout span{color:var(--c-text)}\n:host(.classic) .readout b{color:#fff;font-weight:normal;text-align:right;font-variant-numeric:tabular-nums}\n:host(.classic) .dialog-body{margin:0 10px;padding:8px 0;max-height:calc(100vh - 100px)}\n:host(.classic) .dialog .field{justify-content:space-between}\n:host(.classic) .dialog .field:has(input[type=checkbox]){flex-direction:row-reverse;justify-content:flex-end}\n:host(.classic) .dialog textarea{background:#000;color:#fff;border:1px solid #fff}\n:host(.classic) .activity-history{background:#000;border:1px solid #6d6d78}\n:host(.classic) .item-row{grid-template-columns:26px minmax(0,1fr) 34px 44px repeat(5,44px)}\n}\n";

function assetLoaderMain(self) {
  'use strict';
  const OWN_CACHE = 'sro-lean-icons-v1';
  const GAME_CACHE = 'sro-next-verified-v1';
  const GAME_PACK_MAX = 4 << 20; // the game caches whole packs up to this size
  const NET_SLOTS = 6;
  const OWN_CACHE_MAX = 6000; // entries; the oldest half is dropped above this
  let ORIGIN = '';
  let manifestP = null;
  let manifestAt = 0;
  let manifestGen = 0; // bumped on every successful manifest load
  let forcedAt = 0;
  let refreshing = null;
  let manifestInfo = null;
  const heads = new Map(); // packPath -> Promise<data start offset>
  const caches_ = new Map(); // name -> Promise<Cache|null>
  let skillRows = null;
  const stats = {
    requests: 0,
    ok: 0,
    fail: 0,
    ownCache: 0,
    gameCache: 0,
    gamePack: 0,
    transport: 0,
    range: 0,
    retries: 0,
    manifestLoads: 0,
    bytes: 0,
    lastError: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fail(code, message, status) {
    const e = new Error(message);
    e.code = code;
    if (status) e.status = status;
    return e;
  }

  // ---- network ----------------------------------------------------------

  const slots = { n: 0, q: [] };
  async function withSlot(fn) {
    while (slots.n >= NET_SLOTS) await new Promise((r) => slots.q.push(r));
    slots.n++;
    try {
      return await fn();
    } finally {
      slots.n--;
      const next = slots.q.shift();
      if (next) next();
    }
  }

  async function fetchBytes(url, opt) {
    opt = opt || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opt.timeout || 30000);
    try {
      const init = { cache: opt.cache || 'no-cache', credentials: 'same-origin', signal: ctl.signal };
      if (opt.range) init.headers = { Range: 'bytes=' + opt.range[0] + '-' + opt.range[1] };
      const res = await fetch(ORIGIN + url, init);
      if (!(res.ok || res.status === 206)) throw fail('http', url + ' HTTP ' + res.status, res.status);
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (opt.range) {
        if (res.status !== 206) bytes = bytes.subarray(opt.range[0], opt.range[1] + 1);
        if (bytes.length !== opt.range[1] - opt.range[0] + 1) throw fail('format', url + ': short response (' + bytes.length + ' bytes)');
      }
      stats.bytes += bytes.length;
      return bytes;
    } catch (e) {
      if (e && e.code) throw e;
      if (ctl.signal.aborted) throw fail('timeout', 'timeout: ' + url);
      throw fail('network', 'network error: ' + url + ' (' + ((e && e.message) || e) + ')');
    } finally {
      clearTimeout(timer);
    }
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream !== 'function') throw fail('format', 'the browser cannot decompress gzip (DecompressionStream missing)');
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw fail('format', 'gzip could not be decompressed: ' + ((e && e.message) || e));
    }
  }

  async function sha256(bytes) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let s = '';
    for (const b of d) s += b.toString(16).padStart(2, '0');
    return s;
  }

  // ---- Cache Storage ----------------------------------------------------

  function openCache(name) {
    if (!caches_.has(name)) {
      caches_.set(
        name,
        Promise.resolve()
          .then(() => (typeof caches === 'undefined' ? null : name === GAME_CACHE ? caches.has(name).then((ok) => (ok ? caches.open(name) : null)) : caches.open(name)))
          .catch(() => null)
      );
    }
    return caches_.get(name);
  }

  async function cacheGet(name, key) {
    try {
      const c = await openCache(name);
      if (!c) return null;
      const r = await c.match(key);
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  let ownPuts = 0;
  function putOwn(sha, bytes) {
    openCache(OWN_CACHE)
      .then((c) => c && c.put(ORIGIN + '/__sro_asistan__/' + sha, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })))
      .catch(() => {});
    if (++ownPuts === 50) setTimeout(pruneOwn, 20000);
  }

  async function pruneOwn() {
    try {
      const c = await openCache(OWN_CACHE);
      if (!c) return;
      const keys = await c.keys();
      if (keys.length <= OWN_CACHE_MAX) return;
      for (const k of keys.slice(0, keys.length - OWN_CACHE_MAX / 2)) await c.delete(k);
    } catch {}
  }

  // ---- manifest ---------------------------------------------------------

  function manifest(force) {
    if (force || !manifestP) {
      const p = (async () => {
        let last = null;
        for (let i = 0; i < 3; i++) {
          try {
            const bytes = await fetchBytes('/assets/packs/manifest.json', { timeout: 90000 });
            let data;
            try {
              data = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
              throw fail('format', 'manifest JSON could not be read');
            }
            if (!data || !Array.isArray(data.assets)) throw fail('format', 'manifest format not recognised (' + ((data && data.format) || '?') + ')');
            const assets = new Map();
            for (const a of data.assets) if (a && a.path && a.packPath) assets.set(String(a.path).toLowerCase(), a);
            const packs = new Map();
            for (const g of data.groups || []) for (const pk of (g && g.packs) || []) if (pk && pk.path) packs.set(pk.path, pk);
            stats.manifestLoads++;
            manifestGen++;
            manifestAt = Date.now();
            manifestInfo = {
              format: data.format || '',
              generatedAt: data.generatedAt || '',
              deliveryVersion: data.deliveryVersion == null ? '' : String(data.deliveryVersion),
              assets: assets.size,
              packs: packs.size,
            };
            return { assets, packs };
          } catch (e) {
            last = e;
            if (i < 2) await sleep(1500 * (i + 1));
          }
        }
        if (last) last.manifest = true;
        throw last;
      })();
      manifestP = p;
      p.catch(() => {
        if (manifestP === p) manifestP = null;
      });
    }
    return manifestP;
  }

  // Re-read the manifest after a sign that the packs were republished. Concurrent
  // failures share one download, and a forced re-read happens at most every 30 s.
  function refreshManifest(seenGen) {
    if (refreshing) return refreshing;
    if (manifestGen > seenGen || Date.now() - forcedAt < 30000) return manifest();
    forcedAt = Date.now();
    const p = manifest(true);
    refreshing = p;
    const done = () => {
      if (refreshing === p) refreshing = null;
    };
    p.then(done, done);
    return p;
  }

  function packStart(packPath) {
    if (!heads.has(packPath)) {
      const p = fetchBytes(packPath, { range: [0, 11], timeout: 30000 }).then((h) => {
        let magic = '';
        for (let i = 0; i < 8; i++) magic += String.fromCharCode(h[i]);
        if (magic !== 'SROPACK1' && magic !== 'SROPACK2') throw fail('format', 'bad pack identifier: ' + packPath);
        const len = new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(8, true);
        if (len > 16 << 20) throw fail('format', 'bad pack header: ' + packPath);
        return 12 + len;
      });
      p.catch(() => heads.delete(packPath));
      heads.set(packPath, p);
    }
    return heads.get(packPath);
  }

  // ---- one asset --------------------------------------------------------

  async function fromCaches(m, asset) {
    const own = await cacheGet(OWN_CACHE, ORIGIN + '/__sro_asistan__/' + asset.sha256);
    if (own && own.length === asset.length && (await sha256(own)) === asset.sha256) {
      stats.ownCache++;
      return own;
    }
    const game = await cacheGet(GAME_CACHE, ORIGIN + '/assets/.verified/' + asset.sha256);
    if (game && game.length === asset.length && (await sha256(game)) === asset.sha256) {
      stats.gameCache++;
      return game;
    }
    const pk = m.packs.get(asset.packPath);
    if (pk && pk.sha256 && pk.bytes <= GAME_PACK_MAX) {
      const pack = await cacheGet(GAME_CACHE, ORIGIN + '/assets/.verified/' + pk.sha256);
      if (pack && pack.length >= 12) {
        const len = new DataView(pack.buffer, pack.byteOffset, pack.byteLength).getUint32(8, true);
        const start = 12 + len + asset.offset, span = asset.stored ? asset.stored.length : asset.length;
        if (start + span <= pack.length) {
          let b = pack.slice(start, start + span);
          if (asset.stored) b = await gunzip(b);
          if ((await sha256(b)) === asset.sha256) {
            stats.gamePack++;
            return b;
          }
        }
      }
    }
    return null;
  }

  async function fromNetwork(asset) {
    if (asset.transport && asset.transport.path) {
      try {
        const gz = await fetchBytes(asset.transport.path, { timeout: 60000, cache: 'default' });
        if (asset.transport.sha256 && (await sha256(gz)) !== asset.transport.sha256) throw fail('checksum', 'transport file SHA-256 mismatch: ' + asset.path);
        const raw = await gunzip(gz);
        stats.transport++;
        return raw;
      } catch (e) {
        // The transport copy is an optimisation; the pack still has the bytes.
        if (!asset.packPath) throw e;
      }
    }
    const start = (await packStart(asset.packPath)) + asset.offset;
    const span = asset.stored ? asset.stored.length : asset.length;
    const raw = await fetchBytes(asset.packPath, { range: [start, start + span - 1], timeout: 45000 });
    stats.range++;
    if (!asset.stored) return raw;
    if (asset.stored.encoding !== 'gzip') throw fail('format', 'unknown pack member encoding: ' + asset.path);
    return gunzip(raw);
  }

  // tries: {refreshed, waits}: one manifest re-read and up to 3 backoff waits per request.
  async function bytesOf(path, tries) {
    const t = tries || { refreshed: false, waits: 0 };
    if (!tries) stats.requests++;
    let retry = ''; // 'manifest': re-read the manifest first; 'wait': back off
    let error = null;
    let gen = manifestGen;
    try {
      const m = await manifest();
      gen = manifestGen;
      const key = String(path).toLowerCase();
      let asset = m.assets.get(key);
      let gz = false;
      if (!asset && key.endsWith('.json')) {
        asset = m.assets.get(key + '.gz');
        gz = !!asset;
      }
      if (asset) {
        let raw = await fromCaches(m, asset);
        if (!raw) {
          raw = await withSlot(() => fromNetwork(asset));
          if (raw.length !== asset.length) throw fail('format', 'uzunluk tutmuyor: ' + path);
          if ((await sha256(raw)) !== asset.sha256) throw fail('checksum', 'SHA-256 tutmuyor: ' + path);
          putOwn(asset.sha256, raw);
        }
        if (gz || /\.gz$/i.test(asset.path)) raw = await gunzip(raw);
        stats.ok++;
        return { bytes: raw, mime: asset.mime || '' };
      }
      // Possibly a file added by a later deploy: re-read an older manifest once.
      if (!t.refreshed && Date.now() - manifestAt > 120000) retry = 'manifest';
      else throw fail('missing', 'not found in the game packs: ' + path);
    } catch (e) {
      error = e;
      const code = e && e.code;
      const status = e && e.status;
      const stale = code === 'checksum' || code === 'format' || (code === 'http' && (status === 404 || status === 410 || status === 416));
      const transient = code === 'timeout' || code === 'network' || (code === 'http' && status >= 500) || !code;
      if (e && e.manifest) retry = ''; // the manifest download has its own retries
      else if (stale && !t.refreshed) retry = 'manifest';
      else if ((transient || stale) && t.waits < 3) retry = 'wait';
    }
    if (retry) {
      stats.retries++;
      if (retry === 'manifest') {
        t.refreshed = true;
        await refreshManifest(gen).catch(() => {});
      } else {
        await sleep(700 * 2 ** t.waits);
        t.waits++;
      }
      return bytesOf(path, t);
    }
    stats.fail++;
    stats.lastError = String((error && error.message) || error);
    throw error;
  }

  self.onmessage = async e => {
    const msg = e.data || {};
    if (msg.op === 'init') { ORIGIN = String(msg.origin || ''); self.postMessage({ ready: true }); return; }
    try {
      const allowed = ['/assets/data/levelData.json', '/assets/data/cosPresentation.json', '/assets/data/skillData.json', '/assets/text/textdataname.en.json', '/assets/data/missionPresentation.json', '/assets/char/roster.json', '/assets/npc/manifest.json'];
      if (msg.op !== 'blob' && !(msg.op === 'json' && allowed.includes(msg.path))) throw fail('op', 'Unsupported asset request');
      const { bytes, mime } = await bytesOf(msg.path);
      const result = msg.op === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : new Blob([bytes], { type: mime || 'image/png' });
      self.postMessage({ id: msg.id, ok: true, result });
    } catch (e) { self.postMessage({ id: msg.id, ok: false, error: e.message, code: e.code }); }
  };
}

// Lazy, shared image cache using the game's verified packs. No catalogue downloads.
const Icons = {
  port: null, ready: null, forcePage: false, seq: 0,
  pending: new Map(), urls: new Map(), failures: new Map(),
  iconPath(ddj) {
    if (!ddj) return '';
    let path = String(ddj).replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '').replace(/^icon\//, '').replace(/\.ddj$/, '.png');
    if (!path.endsWith('.png') || path.split('/').includes('..') || !/^[a-z0-9_./ -]+$/.test(path)) return '';
    return '/assets/images/Media_extracted/icon/' + path;
  },
  boot() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => {
      let worker = null, url = '', timer = 0, settled = false;
      const finish = port => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.port = port;
        port.post({ op: 'init', origin: W.location.origin });
        resolve(port);
      };
      const page = () => {
        if (settled) return;
        if (worker) worker.terminate();
        if (url) URL.revokeObjectURL(url);
        const host = { postMessage: result => this.reply(result) };
        assetLoaderMain(host);
        finish({ post: msg => host.onmessage({ data: msg }) });
      };
      if (this.forcePage) { page(); return; }
      try {
        url = URL.createObjectURL(new Blob(['(' + assetLoaderMain.toString() + ')(self)'], { type: 'text/javascript' }));
        worker = new (Hook.NativeWorker || W.Worker)(url, { name: 'sro-lean-icons' });
        const port = { post: msg => worker.postMessage(msg) };
        worker.onmessage = e => {
          if (e.data?.ready) { if (!settled) { URL.revokeObjectURL(url); finish(port); } }
          else this.reply(e.data);
        };
        worker.onerror = e => {
          e.preventDefault();
          if (!settled) { page(); return; }
          worker.terminate(); this.forcePage = true; this.ready = null; this.port = null;
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Icon worker stopped')); this.pending.delete(id); }
        };
        timer = setTimeout(page, 8000);
        port.post({ op: 'init', origin: W.location.origin });
      } catch { page(); }
    });
    return this.ready;
  },
  reply(result) {
    if (!result?.id) return;
    const pending = this.pending.get(result.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(result.id);
    result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error || 'Icon unavailable'));
  },
  async request(path, op = 'blob') {
    const port = await this.boot();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Icon request timed out')); }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      port.post({ id, op, path });
    });
  },
  url(path) {
    if (!path) return Promise.resolve('');
    if (this.urls.has(path)) return this.urls.get(path);
    if ((this.failures.get(path) || 0) > now()) return Promise.resolve('');
    const result = this.request(path).then(blob => { this.failures.delete(path); return URL.createObjectURL(blob); }, error => {
      this.urls.delete(path); this.failures.set(path, now() + 30000);
      Log.warn('Skill icon unavailable: ' + path + ' (' + error.message + ')');
      return '';
    });
    this.urls.set(path, result);
    return result;
  },
  paint(node, icon, attempt = 0) {
    const path = this.iconPath(icon);
    node.dataset.iconPath = path;
    if (!path) return;
    this.url(path).then(url => {
      if (node.dataset.iconPath !== path || !node.isConnected) return;
      if (url) {
        const image = document.createElement('img'); image.alt = ''; image.draggable = false;
        image.src = url; image.addEventListener('load', () => { node.dataset.iconLoaded = 'true'; });
        node.prepend(image);
      } else if (attempt < 2) setTimeout(() => { if (node.isConnected) this.paint(node, icon, attempt + 1); }, 31000);
    });
  },
};


// Repair missing learned metadata lazily; never add an unlearned skill to the character.
const Learned = {
  pending: null, retryAt: 0,
  rows() {
    return (World.gp?.skills || []).map(id => World.skill(id) || { id, group: id, name: 'Skill #' + id, missing: true });
  },
  async repair() {
    if (this.pending || now() < this.retryAt || !this.rows().some(s => s.missing)) return;
    this.retryAt = now() + 30000;
    this.pending = (async () => {
      const [data, names] = await Promise.all([Icons.request('/assets/data/skillData.json', 'json'), Icons.request('/assets/text/textdataname.en.json', 'json')]);
      const learned = new Set(World.gp?.skills || []), additions = [];
      for (const row of data.rows || []) {
        const m = row.split('\t'), id = Number(m[0]);
        if (!learned.has(id) || World.skill(id)) continue;
        // These are the projected columns published by buildSkillDataAsset.mjs.
        const group = Number(m[1]), sibling = World.groups.get(group)?.[0];
        additions.push({ id, group, level: Number(m[2]), active: Number(m[3]) !== 0,
          name: names.entries?.[m[19]] || 'Skill #' + id, icon: m[18], mp: Number(m[24]) || 0,
          targetRequired: m[78] === undefined ? !!sibling?.targetRequired : Number(m[78]) !== 0,
          cooldownMs: sibling?.cooldownMs || 0 });
      }
      if (additions.length) World.rebuildCatalog([...World.catalog.values(), ...additions]);
    })().catch(e => Log.warn('Learned skill metadata: ' + e.message)).finally(() => { this.pending = null; });
    return this.pending;
  },
};


const WD_MEDIA = '/assets/images/Media_extracted/';
// Socket art keys (interface/equipment/equip_slot_<key>.png) per equipment slot 0..8
// and per avatar slot 0..3 (hat, dress, attachment, flag).
const WD_EQ_KEYS = ['helm', 'mail', 'shoulderguard', 'gauntlet', 'pants', 'boots', 'weapon', 'shield', 'specialdress'];
const WD_AV_KEYS = ['helm', 'cloth', 'pandernt', 'plag'];
// Socket grid: left column head/chest/legs, middle shoulder/hands/feet (the game's
// equipment pane), right column weapon/shield/job suit.
const WD_EQ_GRID = [0, 2, 6, 1, 3, 7, 4, 5, 8];
const WD_PAGE = 66;

// Codename grammar of every armour, weapon and shield in roster.dress (8439 rows, all
// slot 0..7 rows match except the two fortress weapons): race, sex, class, degree,
// part (HA/CA head, SA shoulder, BA chest, LA legs, AA hands, FA feet), grade, suffix.
const WD_RX = /^ITEM_(CH|EU)_(?:([MW])_(CLOTHES|LIGHT|HEAVY)_(\d\d)_(HA|CA|SA|BA|LA|AA|FA)|(SWORD|BLADE|SPEAR|TBLADE|BOW|DAGGER|TSWORD|AXE|CROSSBOW|DARKSTAFF|TSTAFF|HARP|STAFF|SHIELD)_(\d\d))_([ABC])(?:_(DEF|SUPER|RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?)?$/;
// Weapon tid4 per kind (client tooltip table Zp L5916 and stance table wh L17764).
const WD_WEAPON_T4 = { SWORD: 2, BLADE: 3, SPEAR: 4, TBLADE: 5, BOW: 6, EUSWORD: 7, TSWORD: 8, AXE: 9, DARKSTAFF: 10, TSTAFF: 11, CROSSBOW: 12, DAGGER: 13, HARP: 14, STAFF: 15, FORT: 16 };
const WD_ARMOR_T3 = { CLOTHES: 1, LIGHT: 2, HEAVY: 3 }; // +8 for European armour
const WD_JOB_T4 = { TRADER: 1, THIEF: 2, HUNTER: 3, VOUCHER: 5 };
// Equipment slot -> armour tid4 (inverse of the client rule [0,2,1,4,3,5][tid4-1]).
const WD_SLOT_T4 = [1, 3, 2, 5, 4, 6];
// Weapons a shield is worn with (random outfits keep two-handed weapons shield-free).
const WD_ONE_HAND = new Set(['SWORD', 'BLADE', 'EUSWORD', 'DAGGER', 'DARKSTAFF', 'STAFF']);
// Pick-pet models drawn exactly like another family (cos models get no material
// variant, R7 glow_pets), left out of the list.
const WD_PET_SKIP = new Set(['COS_P_PINKPIG', 'COS_P_SPOT_RABBIT']);

const WdCfg = () => Settings.profile.wardrobe;
const wdInt = (v, lo, hi) => clamp(Math.trunc(Number(v) || 0), lo, hi);
const wdTid3 = (tf) => ((Number(tf) >>> 0) >>> 7) & 15;
const wdTid4 = (tf) => ((Number(tf) >>> 0) >>> 11) & 31;
// Equipment typeFlags: bits 2-3 equipment (12), bit 5 wearable (32), tid3, tid4.
const wdTf = (t4, t3) => ((t4 << 11) | (t3 << 7) | 32 | 12) >>> 0;
const wdIsEquip = (tf) => ((Number(tf) >>> 0) & 126) === 44;
// Skill clip family of a weapon typeFlags: the game plays `${role}-${family}` (As(),
// index L21568) and skips the cast when neither that clip nor the bare role exists.
const WD_ANIM_FAM = { 2: 'sword', 3: 'sword', 4: 'spear', 5: 'spear', 6: 'bow', 12: 'bow', 7: '1hsword', 8: '2hsword', 9: 'axe', 10: '1hstaff', 15: '1hstaff', 11: '2hstaff', 13: 'dagger', 14: 'harp' };
const wdAnimFam = (tf) => WD_ANIM_FAM[wdTid4(tf)] || '';
// Job mode the game derives from inventory slot 8 (ac(), index L4334): 1..3 trader /
// thief / hunter, anything else normal; party matching and its commands follow it.
const wdJobMode = (tf) => ((Number(tf) >>> 0) & 2046) === 940 && wdTid4(tf) >= 1 && wdTid4(tf) <= 3;
// Case folding for search.
const wdFold = (s) => String(s || '').toLowerCase();

function wdSafe(what, fn) {
  try {
    return fn();
  } catch (e) {
    Log.warn('Wardrobe (' + what + '): ' + ((e && e.message) || e));
    return undefined;
  }
}

function wdClone(v) {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return null;
  }
}

function wdItemName(ref) {
  return typeof Items !== 'undefined' && Items.name ? Items.name(ref) : '#' + ref;
}

function wdText(key, fallback) {
  return typeof Items !== 'undefined' && Items.text ? Items.text(key, fallback) || fallback : fallback;
}

// Icon path in the form the game stores for its own items ("item\china\...ddj");
// the catalogue gives "icon/item/...ddj" (the client's Gi() adds the icon/ root).
function wdGameIcon(ref) {
  const ddj = typeof Items !== 'undefined' && Items.iconDdj ? Items.iconDdj(ref) : '';
  return ddj ? String(ddj).replace(/^icon[\\/]/i, '').replace(/\//g, '\\') : '';
}

function wdSlotName(s) {
  const n = typeof Items !== 'undefined' && Items.slotName ? Items.slotName(s) : '';
  return n || ['Head', 'Chest', 'Shoulder', 'Hands', 'Legs', 'Feet', 'Weapon', 'Shield', 'Job suit'][s] || '';
}

function wdAvatarName(s) {
  return ['Hat', 'Dress', 'Attachment', 'Flag'][s] || '';
}

function wdKindName(kind) {
  const k = {
    SWORD: () => 'Sword',
    BLADE: () => 'Blade',
    SPEAR: () => 'Spear',
    TBLADE: () => 'Glaive',
    BOW: () => 'Bow',
    EUSWORD: () => 'One-handed sword',
    TSWORD: () => 'Two-handed sword',
    AXE: () => 'Dual axe',
    DARKSTAFF: () => 'Dark staff',
    TSTAFF: () => 'Two-handed staff',
    CROSSBOW: () => 'Crossbow',
    DAGGER: () => 'Dagger',
    HARP: () => 'Harp',
    STAFF: () => 'Staff',
    FORT: () => 'Fortress weapon',
    SHIELD: () => 'Shield',
  }[kind];
  return k ? k() : kind || '';
}

function wdClassName(cls, race) {
  const eu = race === 'EU';
  if (cls === 'CLOTHES') return eu ? 'Robe' : 'Garment';
  if (cls === 'LIGHT') return eu ? 'Light armour' : 'Protector';
  if (cls === 'HEAVY') return eu ? 'Heavy armour' : 'Armour';
  return '';
}

function wdBodyName(body) {
  return (
    {
      CH_M: () => 'Chinese male',
      CH_W: () => 'Chinese female',
      EU_M: () => 'European male',
      EU_W: () => 'European female',
    }[body] || (() => '—')
  )();
}

function wdSoxName(n) {
  return n ? wdText(['PARAM_RARE_FIRST', 'PARAM_RARE_SECOND', 'PARAM_RARE_THIRD'][n - 1], ['Seal of Star', 'Seal of Moon', 'Seal of Sun'][n - 1]) : '';
}

// +plus glow band (thresholds from the equipment GLB rows, R7 glow_pets).
function wdGlow(plus) {
  const p = Number(plus) || 0;
  if (p >= 9) return { name: 'Blue-green', color: '#6ff0d4' };
  if (p >= 7) return { name: 'Gold', color: '#ffc84a' };
  if (p >= 5) return { name: 'Pink', color: '#ff8ad8' };
  if (p >= 3) return { name: 'White', color: '#ffffff' };
  return { name: 'No glow', color: '#8f8a7a' };
}

// Parsed codename: weapons {race, kind, deg, grade, sox, honor}, armour {race, sex,
// cls, deg, part, ...}, job suits {job, deg}; sox 0 none | 1 Star | 2 Moon | 3 Sun.
function wdParse(code) {
  const c = String(code || '');
  const m = WD_RX.exec(c);
  if (m) {
    const sox = m[9] && /^(RARE|MAGIC|LEGEND|MYTH)$/.test(m[9]) ? 'ABC'.indexOf(m[8]) + 1 : 0;
    const base = { race: m[1], grade: m[8], sox, plain: !m[9] };
    if (m[6]) return { ...base, kind: m[6] === 'SWORD' && m[1] === 'EU' ? 'EUSWORD' : m[6], deg: +m[7] };
    return { ...base, sex: m[2], cls: m[3], deg: +m[4], part: m[5] };
  }
  let f = /^ITEM_FORT_FORTRESS_(HAMMER|AXE)_(\d+)/.exec(c);
  if (f) return { race: '', kind: 'FORT', deg: +f[2] || 0, sox: 0, plain: true };
  f = /_TRADE_(TRADER|THIEF|HUNTER)_(\d+)$/.exec(c);
  if (f) return { job: f[1], deg: +f[2] || 0, sox: 0, plain: true };
  if (/_FRPVP_VOUCHER_[A-E]$/.test(c)) return { job: 'VOUCHER', deg: 0, sox: 0, plain: true };
  const d = /_(\d\d)_/.exec(c);
  return { deg: d ? +d[1] : 0, sox: 0, plain: true };
}

const WdData = {
  rows: null, // [{id, code, slot, av, bodies:Set, glow, ac, m}]
  byId: new Map(),
  bodyByModel: new Map(), // character model refObjId -> body key
  modelName: new Map(), // cos / mount refObjId -> display name
  pets: [], // [{id, code, name, size}]
  mounts: [], // [{id, code, name}]
  petIds: new Set(),
  mountIds: new Set(),
  forBody: new Map(),
  promise: null,
  failedAt: -Infinity,
  error: '',
  texts: null, // merged textdata, for model names
  petsReady: false, // pet list built from a non-empty model list
  petPromise: null,
  petFailedAt: -Infinity,

  ready() {
    return !!this.rows;
  },

  // Loads once; a failure may be retried after 30 s (or right away from the window).
  load(force) {
    if (this.rows) return Promise.resolve(true);
    if (this.promise) return this.promise;
    if (!force && now() - this.failedAt < 30000) return Promise.resolve(false);
    this.error = '';
    this.promise = (async () => {
      const [wd, models, texts] = await Promise.all([
        Assets.wardrobe(),
        Assets.npcModels(),
        Assets.texts(),
        Items.ready(),
      ]);
      if (!wd || !Array.isArray(wd.items)) throw new Error('wardrobe catalogue unavailable');
      this.build(wd, Array.isArray(models) ? models : [], texts || {});
      return true;
    })()
      .catch((e) => {
        this.failedAt = now();
        this.error = String((e && e.message) || e);
        Log.warn('Wardrobe catalogue could not be loaded: ' + this.error);
        return false;
      })
      .finally(() => {
        this.promise = null;
      });
    return this.promise;
  },

  build(wd, models, texts) {
    const rows = [];
    const byId = new Map();
    for (const r of wd.items) {
      if (!Array.isArray(r) || !Number.isInteger(r[0])) continue;
      const slot = Number.isInteger(r[2]) && r[2] >= 0 && r[2] < 9 ? r[2] : -1;
      const av = Number.isInteger(r[3]) && r[3] >= 0 && r[3] < 4 ? r[3] : -1;
      if (slot < 0 && av < 0) continue;
      const row = { id: r[0], code: String(r[1] || ''), slot, av, bodies: new Set(String(r[4] || '').split(',').filter(Boolean)), glow: r[5] ? 1 : 0, ac: r[6] || 0 };
      row.m = wdParse(row.code);
      if (!row.m) continue;
      rows.push(row);
      byId.set(row.id, row);
    }
    const bodyByModel = new Map();
    const modelName = new Map();
    this.texts = texts;
    const mounts = [];
    for (const m of wd.models || []) {
      if (!Array.isArray(m)) continue;
      const mm = /^CHAR_(CH|EU)_(MAN|WOMAN)_/.exec(m[1] || '');
      if (mm) bodyByModel.set(m[0], mm[1] + '_' + (mm[2] === 'MAN' ? 'M' : 'W'));
      if (m[2]) {
        const name = this.nameOf(m[1]);
        mounts.push({ id: m[0], code: m[1], name });
        modelName.set(m[0], name);
      }
    }
    mounts.sort((a, b) => a.name.localeCompare(b.name));
    this.byId = byId;
    this.bodyByModel = bodyByModel;
    this.modelName = modelName;
    this.mounts = mounts;
    this.mountIds = new Set(mounts.map((p) => p.id));
    this.buildPets(models);
    if (!this.petsReady) this.petFailedAt = now();
    this.forBody.clear();
    this.rows = rows;
  },

  nameOf(code) {
    const texts = this.texts || {};
    const fam = code.replace(/_\d+$/, '');
    for (const k of [code, fam, fam + '_01']) if (texts['SN_' + k]) return texts['SN_' + k];
    return fam
      .replace(/^COS_[A-Z]_/, '')
      .toLowerCase()
      .replace(/(^|_)([a-z])/g, (_, s, ch) => (s ? ' ' : '') + ch.toUpperCase());
  },

  // Pets: one entry per family, two growth stages (first and last level model) when
  // the family has several. An empty model list (load failure) stays retryable.
  buildPets(models) {
    const fams = new Map();
    for (const m of models) {
      if (!Array.isArray(m) || m[2] !== 'cos' || !Number.isInteger(m[0])) continue;
      const code = String(m[1] || '');
      this.modelName.set(m[0], this.nameOf(code));
      const fam = code.replace(/_\d+$/, '');
      if (WD_PET_SKIP.has(fam)) continue;
      if (!fams.has(fam)) fams.set(fam, []);
      fams.get(fam).push({ id: m[0], code });
    }
    const pets = [];
    for (const [fam, list] of fams) {
      list.sort((a, b) => a.id - b.id);
      const name = this.nameOf(list[0].code);
      if (list.length === 1) pets.push({ id: list[0].id, code: list[0].code, name, size: '' });
      else {
        pets.push({ id: list[0].id, code: list[0].code, name, size: 'small', fam });
        pets.push({ id: list[list.length - 1].id, code: list[list.length - 1].code, name, size: 'large', fam });
      }
    }
    pets.sort((a, b) => a.name.localeCompare(b.name) || (a.size === 'large') - (b.size === 'large'));
    this.pets = pets;
    this.petIds = new Set(pets.map((p) => p.id));
    this.petsReady = pets.length > 0;
  },

  // Retries the pet model list after a failed load (at most every 30 s unless forced);
  // resolves true when the list was rebuilt.
  loadPets(force) {
    if (!this.rows || this.petsReady) return Promise.resolve(false);
    if (this.petPromise) return this.petPromise;
    if (!force && now() - this.petFailedAt < 30000) return Promise.resolve(false);
    this.petPromise = Promise.resolve(Assets.npcModels())
      .then((models) => {
        if (Array.isArray(models) && models.length) this.buildPets(models);
        if (!this.petsReady) this.petFailedAt = now();
        return this.petsReady;
      })
      .catch(() => {
        this.petFailedAt = now();
        return false;
      })
      .finally(() => {
        this.petPromise = null;
      });
    return this.petPromise;
  },

  rowsFor(body) {
    if (!this.rows || !body) return [];
    let list = this.forBody.get(body);
    if (!list) {
      list = this.rows.filter((r) => r.bodies.has(body));
      this.forBody.set(body, list);
    }
    return list;
  },

  bodyOf(modelRef) {
    return this.bodyByModel.get(modelRef) || '';
  },

  // Learned / formula typeFlags key of a catalogue row.
  classKey(row) {
    if (!row) return '';
    if (row.av >= 0) return 'v' + row.av;
    const m = row.m || {};
    if (row.slot === 6) return 'w:' + (m.kind || '');
    if (row.slot === 7) return 's:' + (m.race || '');
    if (row.slot >= 0 && row.slot < 6) return 'a:' + (m.race || '') + ':' + (m.cls || row.ac) + ':' + row.slot;
    if (row.slot === 8) return 'j:' + (m.job || '');
    return '';
  },

  // typeFlags by the standard layout (R2 / R7 appearance step 3), 0 when unknown.
  formulaTf(row) {
    if (!row) return 0;
    const m = row.m || {};
    if (row.av >= 0) return (((row.av + 1) << 11) | 1708) >>> 0;
    if (row.slot === 6) return WD_WEAPON_T4[m.kind] ? wdTf(WD_WEAPON_T4[m.kind], 6) : 0;
    if (row.slot === 7) return wdTf(m.race === 'EU' ? 2 : 1, 4);
    if (row.slot >= 0 && row.slot < 6) {
      const t3 = (WD_ARMOR_T3[m.cls] || clamp(row.ac || 1, 1, 3)) + (m.race === 'EU' ? 8 : 0);
      return wdTf(WD_SLOT_T4[row.slot], t3);
    }
    if (row.slot === 8) return wdTf(WD_JOB_T4[m.job] || 1, 7);
    return 0;
  },
};

const Wardrobe = {
  win: null,
  cssDone: false,
  // Arrays handed to the game, and the arrays they were built from.
  inv: null,
  baseInv: null,
  av: null,
  baseAv: null,
  body: '', // body key of the local character model
  learned: new Map(), // classKey -> typeFlags seen on real items
  warned: new Set(),
  applyTimer: 0,
  leftTimer: 0,
  learnAt: 0,
  sig: '',
  hsig: '',
  loadReq: false,
  view: { tab: 'items', slot: 'e6', q: '', kind: '', cls: '', deg: 0, rar: '', page: 0 },
  setOpt: { deg: 0, cls: '', sox: 0, weapon: '', shield: false, plus: 0 },
  el: {},

  // ---- state -------------------------------------------------------------------

  cfg() {
    const c = WdCfg();
    if (!c.eq || typeof c.eq !== 'object' || Array.isArray(c.eq)) c.eq = {};
    if (!c.av || typeof c.av !== 'object' || Array.isArray(c.av)) c.av = {};
    if (!c.pet || typeof c.pet !== 'object') c.pet = { atk: 0, pick: 0, mount: 0 };
    if (!c.presets || typeof c.presets !== 'object' || Array.isArray(c.presets)) c.presets = {};
    return c;
  },

  active() {
    return !!(this.cfg().on && WdData.ready() && this.body);
  },

  hasOverrides(c = this.cfg()) {
    return Object.keys(c.eq).length > 0 || Object.keys(c.av).length > 0 || !!(c.pet.atk || c.pet.pick || c.pet.mount) || !!c.hideAvatars;
  },

  outfit() {
    const c = this.cfg();
    return wdClone({ eq: c.eq, av: c.av, pet: c.pet, hideAvatars: !!c.hideAvatars });
  },

  useOutfit(o) {
    const c = this.cfg();
    const x = wdClone(o) || {};
    c.eq = x.eq && typeof x.eq === 'object' ? x.eq : {};
    c.av = x.av && typeof x.av === 'object' ? x.av : {};
    c.pet = { atk: wdInt(x.pet?.atk, 0, 4294967295), pick: wdInt(x.pet?.pick, 0, 4294967295), mount: wdInt(x.pet?.mount, 0, 4294967295) };
    c.hideAvatars = !!x.hideAvatars;
  },

  snapshot() {
    this.cfg().undo = this.outfit();
  },

  petKey() {
    const p = this.cfg().pet;
    return [p.atk || 0, p.pick || 0, p.mount || 0].join();
  },

  // Catalogue row of an equipment override when it may be handed to the game.
  validEq(slot, ref) {
    const row = ref ? WdData.byId.get(Number(ref)) : null;
    return row && row.slot === slot && row.bodies.has(this.body) ? row : null;
  },

  validAv(slot, ref) {
    const row = ref ? WdData.byId.get(Number(ref)) : null;
    return row && row.av === slot && row.bodies.has(this.body) ? row : null;
  },

  // Real item typeFlags win over the formula (and disagreements are logged once).
  tfFor(row) {
    const key = WdData.classKey(row);
    const seen = key ? this.learned.get(key) : undefined;
    return seen !== undefined ? seen : WdData.formulaTf(row);
  },

  learn() {
    if (!WdData.ready()) return;
    const add = (ref, tf) => {
      if (!Number.isInteger(ref) || !isNum(tf)) return;
      const row = WdData.byId.get(ref);
      const key = WdData.classKey(row);
      if (!key || this.learned.has(key)) return;
      const real = (Number(tf) >>> 0) & ~1; // bit 0 marks mall items
      this.learned.set(key, real);
      const f = WdData.formulaTf(row);
      if (f && f !== real && !this.warned.has(key)) {
        this.warned.add(key);
        Log.warn(`Wardrobe: ${row.code} typeFlags ${real}, formula ${f} (using the real value)`);
      }
    };
    const gp = World.gp;
    for (const it of Array.isArray(gp?.inventory) ? gp.inventory : []) if (it) add(it.refObjId, it.typeFlags);
    for (const it of Array.isArray(gp?.avatarInventory) ? gp.avatarInventory : []) if (it) add(it.refObjId, it.typeFlags);
    for (const e of World.ents.values()) {
      if (e && Array.isArray(e.equipment)) for (const q of e.equipment) if (q) add(q.refObjId, q.typeFlags);
      if (e && Array.isArray(e.avatars)) for (const q of e.avatars) if (q) add(q.refObjId, q.typeFlags);
    }
  },

  // ---- what the game is given ---------------------------------------------------

  // slot -> { item } (replace / add) or { hide: true } for the equipment overrides.
  eqPlan(base) {
    const plan = new Map();
    if (!this.active()) return plan;
    const c = this.cfg();
    const realArmor = base.find((it) => it && it.slot >= 0 && it.slot < 6 && [1, 2, 3, 9, 10, 11].includes(wdTid3(it.typeFlags)) && wdIsEquip(it.typeFlags));
    for (let s = 0; s < 9; s++) {
      const o = c.eq[s];
      if (!o || typeof o !== 'object') continue;
      const real = base.find((it) => it && it.slot === s) || null;
      if (o.hide) {
        // A worn job suit stays: dropping it would switch the game to normal mode.
        if (real && !(s === 8 && wdJobMode(real.typeFlags))) plan.set(s, { hide: true });
        continue;
      }
      const row = this.validEq(s, o.ref);
      const plusOv = (s === 6 || s === 7) && o.plus != null && isNum(Number(o.plus)) ? wdInt(o.plus, 0, 255) : null;
      if (!row && plusOv == null) continue;
      if (real) {
        const sameClass = this.groupOf(real.typeFlags) === this.slotGroup(s);
        const realPlus = Number.isInteger(real.plus) && real.plus >= 0 && real.plus <= 255 ? real.plus : 0;
        if (!row) {
          if (sameClass && plusOv !== realPlus) plan.set(s, { item: { ...real, plus: plusOv } });
          continue;
        }
        if (row.id === real.refObjId && plusOv == null) continue;
        if (sameClass) {
          const tf = s === 6 ? this.weaponTf(row, real.typeFlags) : real.typeFlags;
          plan.set(s, { item: { ...real, refObjId: row.id, typeFlags: tf, plus: plusOv ?? realPlus } });
        } else {
          plan.set(s, { item: this.standIn(s, row, plusOv ?? 0, realArmor, real) });
        }
      } else if (row && c.phantom) {
        plan.set(s, { item: this.standIn(s, row, plusOv ?? 0, realArmor, null), add: true });
      }
    }
    return plan;
  },

  // Slot 6 typeFlags of a fake weapon. It picks the stance (wh()) and the skill clip
  // family (As()); with "animations follow the real weapon" on, a fake of another
  // family keeps the real family (no weapon = tid4 0, unarmed), so casts never lose
  // their clips.
  weaponTf(row, realTf) {
    const base = realTf != null ? Number(realTf) >>> 0 : wdTf(0, 6);
    const fake = this.tfFor(row) || 0;
    if (!fake) return base;
    if (!this.cfg().realAnim) return fake;
    return wdAnimFam(fake) === wdAnimFam(base) ? fake : base;
  },

  // Item object for a slot without a real item of the same class: every field the
  // game's inventory UI reads (icon, name, typeFlags, quantity, plus, durability,
  // variance as BigInt string, magic arrays), no tooltip so it is shown by name only.
  standIn(s, row, plus, realArmor, real) {
    let tf = this.tfFor(row);
    // Same armour class as the real armour, so the game does not mark real parts as a
    // mixed set (w_ L2236); the drawn model does not depend on it.
    if (s < 6 && realArmor && tf) tf = wdTf(wdTid4(tf), wdTid3(realArmor.typeFlags));
    // The weapon keeps the real animation family (or unarmed) unless the user opted out.
    if (s === 6) tf = this.weaponTf(row, real && this.groupOf(real.typeFlags) === 'w' ? real.typeFlags : null);
    // A job suit stand-in must read as normal mode (tid4 0) for ac(); the job mode only
    // ever comes from a real suit, whose typeFlags are kept on the other path.
    if (s === 8) tf = wdTf(0, 7);
    if (!tf) tf = s === 7 ? wdTf(1, 4) : wdTf(WD_SLOT_T4[s] || 1, 1);
    return {
      slot: s,
      refObjId: row.id,
      typeFlags: tf,
      plus: wdInt(plus, 0, 255),
      quantity: 1,
      durability: 0,
      variance: real && real.variance ? real.variance : '0',
      magic: real && Array.isArray(real.magic) ? real.magic.slice() : [],
      magicReferences: real && Array.isArray(real.magicReferences) ? real.magicReferences.slice() : [],
      name: wdItemName(row.id),
      icon: wdGameIcon(row.id),
    };
  },

  groupOf(tf) {
    if (!wdIsEquip(tf)) return 'n';
    const t3 = wdTid3(tf);
    return t3 === 6 ? 'w' : t3 === 4 ? 's' : t3 === 7 ? 'j' : [1, 2, 3, 9, 10, 11].includes(t3) ? 'a' : 'x';
  },

  slotGroup(s) {
    return s === 6 ? 'w' : s === 7 ? 's' : s === 8 ? 'j' : 'a';
  },

  buildInv(base) {
    const plan = this.eqPlan(base);
    if (!plan.size) return base.slice();
    const out = [];
    const done = new Set();
    for (const it of base) {
      const s = it && it.slot;
      if (Number.isInteger(s) && s >= 0 && s < 9 && plan.has(s)) {
        done.add(s);
        const p = plan.get(s);
        if (p.item) out.push(p.item);
        continue;
      }
      out.push(it);
    }
    for (const [s, p] of plan) {
      if (done.has(s) || !p.add || !p.item) continue;
      const at = out.findIndex((it) => it && Number.isInteger(it.slot) && it.slot > s);
      if (at < 0) out.push(p.item);
      else out.splice(at, 0, p.item);
    }
    return out;
  },

  avSlotOf(a) {
    const row = WdData.byId.get(a && a.refObjId);
    return row && row.av >= 0 ? row.av : wdTid4(a && a.typeFlags) - 1;
  },

  avTf(s) {
    const seen = this.learned.get('v' + s);
    return seen !== undefined ? seen : (((s + 1) << 11) | 1708) >>> 0;
  },

  buildAv(base) {
    if (!this.active()) return base.slice();
    const c = this.cfg();
    if (c.hideAvatars) return [];
    const over = new Map(); // avatarSlot -> row | null (hidden)
    for (let s = 0; s < 4; s++) {
      const o = c.av[s];
      if (!o || typeof o !== 'object') continue;
      if (o.hide) over.set(s, null);
      else {
        const row = this.validAv(s, o.ref);
        if (row) over.set(s, row);
      }
    }
    if (!over.size) return base.slice();
    const out = base.filter((a) => a && !over.has(this.avSlotOf(a)));
    for (const [s, row] of over) if (row) out.push({ slot: s, refObjId: row.id, typeFlags: this.avTf(s), plus: 0 });
    return out;
  },

  // Gameplay rewriter: always hands the game a copy of the inventory array (kept for
  // in-place updates), with the overrides applied.
  onGameplay(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.inventory)) return undefined;
    const next = this.buildInv(st.inventory);
    this.baseInv = st.inventory;
    this.inv = next;
    return { ...st, inventory: next };
  },

  // Entity rewriter: the local player's avatars (always a copy, kept for in-place
  // updates) and the models of the player's own pet and ridden COS.
  onEntity(e) {
    if (!e || typeof e !== 'object') return undefined;
    if (e.kind === 'local-player') {
      if (WdData.ready()) {
        const b = WdData.bodyOf(e.refObjId);
        if (b !== this.body) {
          this.body = b;
          this.rebuildInv();
        }
      }
      const base = Array.isArray(e.avatars) ? e.avatars : [];
      const next = this.buildAv(base);
      this.baseAv = base;
      this.av = next;
      return { ...e, avatars: next };
    }
    if (e.kind === 'cos') return this.petLook(e);
    return undefined;
  },

  petLook(e) {
    const c = this.cfg();
    if (!c.on || !WdData.ready()) return undefined;
    const lg = World.localGid();
    const t4 = (Number(e.tidWord) >>> 11) & 31;
    const local = World.local();
    let want = 0;
    if (local && local.mountedOn === e.gid && (t4 === 1 || t4 === 2)) want = WdData.mountIds.has(c.pet.mount) ? c.pet.mount : 0;
    else if (lg && e.ownerGid === lg && t4 === 3) want = WdData.petIds.has(c.pet.atk) ? c.pet.atk : 0;
    else if (lg && e.ownerGid === lg && t4 === 4) want = WdData.petIds.has(c.pet.pick) ? c.pet.pick : 0;
    if (!want || want === e.refObjId) return undefined;
    return { ...e, refObjId: want };
  },

  rebuildInv() {
    if (!this.inv || !this.baseInv) return;
    const next = this.buildInv(this.baseInv);
    this.inv.length = 0;
    for (const it of next) this.inv.push(it);
  },

  // Writes the current overrides into the arrays the game holds (next frame).
  applyNow() {
    wdSafe('uygula', () => {
      this.rebuildInv();
      if (this.av && this.baseAv) {
        const next = this.buildAv(this.baseAv);
        this.av.length = 0;
        for (const a of next) this.av.push(a);
      }
    });
  },

  applySoon() {
    if (this.applyTimer) return;
    this.applyTimer = setTimeout(() => {
      this.applyTimer = 0;
      this.applyNow();
    }, 40);
  },

  // pet: true only when the pet / mount look really changed (the toast explains the
  // delay until the animal's next update).
  changed(pet) {
    Settings.saveProfile();
    this.applySoon();
    const out = this.myCos();
    if (pet && (out.p3 || out.p4 || out.pm)) UI.toast('The pet and mount look changes with the animal’s next update (movement).', 'info', 3500);
    if (this.isOpen()) {
      this.renderLeft();
      this.renderHead();
      this.markGrid();
    }
  },

  // ---- actions --------------------------------------------------------------------

  ensureEq(s) {
    const c = this.cfg();
    if (!c.eq[s] || typeof c.eq[s] !== 'object') c.eq[s] = {};
    return c.eq[s];
  },

  tidyEq(s) {
    const c = this.cfg();
    const o = c.eq[s];
    if (o && !o.ref && o.plus == null && !o.hide) delete c.eq[s];
  },

  pick(row) {
    const id = this.view.slot;
    const c = this.cfg();
    if (id[0] === 'e') {
      const s = +id.slice(1);
      const o = this.ensureEq(s);
      if (o.ref === row.id && !o.hide) delete o.ref;
      else {
        o.ref = row.id;
        delete o.hide;
      }
      this.tidyEq(s);
    } else if (id[0] === 'a') {
      const s = +id.slice(1);
      if (c.av[s] && c.av[s].ref === row.id) delete c.av[s];
      else c.av[s] = { ref: row.id };
    }
    this.changed(false);
  },

  setPet(kind, ref) {
    const c = this.cfg();
    const before = c.pet[kind] || 0;
    c.pet[kind] = before === ref ? 0 : ref || 0;
    this.changed(c.pet[kind] !== before);
    if (this.isOpen()) this.renderPane();
  },

  resetSlot(id) {
    const c = this.cfg();
    const pets = this.petKey();
    if (id[0] === 'e') delete c.eq[+id.slice(1)];
    else if (id[0] === 'a') delete c.av[+id.slice(1)];
    else if (id === 'p3') c.pet.atk = 0;
    else if (id === 'p4') c.pet.pick = 0;
    else if (id === 'pm') c.pet.mount = 0;
    this.changed(this.petKey() !== pets);
    if (this.isOpen() && id[0] === 'p' && this.view.slot === id) this.renderPane();
  },

  toggleHide(id) {
    const c = this.cfg();
    if (id[0] === 'e') {
      const s = +id.slice(1);
      const o = this.ensureEq(s);
      const real = this.realEq(s);
      if (o.hide) delete o.hide;
      else if (s === 8 && real && wdJobMode(real.typeFlags)) {
        UI.toast('A worn job suit cannot be hidden: the game reads the job mode from this slot.', 'warn', 4000);
      } else {
        o.hide = true;
        if (s === 6 && real) UI.toast('With the weapon hidden, skill animations and hit effects may not play.', 'warn', 4000);
      }
      this.tidyEq(s);
    } else if (id[0] === 'a') {
      const s = +id.slice(1);
      if (c.av[s] && c.av[s].hide) delete c.av[s];
      else c.av[s] = { hide: true };
    }
    this.changed(false);
  },

  resetAll() {
    if (!this.hasOverrides()) return;
    this.snapshot();
    const pets = this.petKey();
    this.useOutfit({ eq: {}, av: {}, pet: { atk: 0, pick: 0, mount: 0 }, hideAvatars: false });
    this.changed(this.petKey() !== pets);
    UI.toast('Back to the real look ("Undo" restores the previous outfit).', 'info', 3000);
    if (this.isOpen()) this.renderPane();
  },

  undo() {
    const c = this.cfg();
    if (!c.undo) return;
    const cur = this.outfit();
    const pets = this.petKey();
    this.useOutfit(c.undo);
    c.undo = cur;
    this.changed(this.petKey() !== pets);
    if (this.isOpen()) this.renderPane();
  },

  randomize() {
    const rows = WdData.rowsFor(this.body);
    if (!rows.length) return;
    this.snapshot();
    const c = this.cfg();
    const any = (list) => list[Math.floor(Math.random() * list.length)];
    const eq = {};
    for (let s = 0; s < 6; s++) {
      const l = rows.filter((r) => r.slot === s);
      if (l.length) eq[s] = { ref: any(l).id };
    }
    const weapons = rows.filter((r) => r.slot === 6 && r.m.kind && r.m.kind !== 'FORT');
    if (weapons.length) {
      const w = any(weapons);
      eq[6] = { ref: w.id, plus: Math.floor(Math.random() * 13) };
      const shields = rows.filter((r) => r.slot === 7);
      const realShield = this.realEq(7);
      if (WD_ONE_HAND.has(w.m.kind) && shields.length && Math.random() < 0.7) eq[7] = { ref: any(shields).id, plus: Math.floor(Math.random() * 13) };
      // Only a real shield is hidden next to a two-handed weapon; arrows and bolts stay.
      else if (realShield && this.groupOf(realShield.typeFlags) === 's') eq[7] = { hide: true };
    }
    const av = {};
    for (let s = 0; s < 4; s++) {
      const l = rows.filter((r) => r.av === s);
      if (l.length && Math.random() < (s === 1 ? 0.3 : 0.5)) av[s] = { ref: any(l).id };
    }
    c.eq = eq;
    c.av = av;
    c.hideAvatars = false;
    this.changed(false);
    if (this.isOpen()) this.renderPane();
  },

  // Best row of a slot for the set builder: exact SoX grade first, then the plain
  // A-grade item, honour and _DEF/_SUPER variants last.
  bestRow(rows, slot, test) {
    let best = null;
    let score = -1;
    for (const r of rows) {
      if (r.slot !== slot || !test(r)) continue;
      const sc = (r.m.honor ? 0 : 4) + (r.m.plain || r.m.sox ? 2 : 0) + (r.m.grade === 'A' ? 1 : 0);
      if (sc > score || (sc === score && r.id < best.id)) {
        best = r;
        score = sc;
      }
    }
    return best;
  },

  // Puts the chosen set on; armour slots the set has no piece for are cleared so no
  // part of an older outfit stays mixed in. Returns {n, miss}.
  applySet() {
    const o = this.setOpt;
    const rows = WdData.rowsFor(this.body);
    if (!rows.length || !o.deg || !o.cls) return { n: 0, miss: 0 };
    this.snapshot();
    const c = this.cfg();
    const soxOk = (r) => (o.sox ? r.m.sox === o.sox : !r.m.sox);
    let n = 0;
    let miss = 0;
    const parts = [0, 1, 2, 3, 4, 5].map((s) => this.bestRow(rows, s, (x) => x.m.cls === o.cls && x.m.deg === o.deg && soxOk(x)));
    // With no armour piece at all the armour overrides are left alone.
    if (parts.some(Boolean)) {
      parts.forEach((r, s) => {
        if (r) {
          c.eq[s] = { ref: r.id };
          n++;
        } else {
          delete c.eq[s];
          miss++;
        }
      });
    }
    // Weapon / shield of the same degree, or the closest lower degree that exists.
    const near = (slot, test) => {
      for (let d = o.deg; d >= 1; d--) {
        const r = this.bestRow(rows, slot, (x) => x.m.deg === d && test(x) && soxOk(x));
        if (r) return r;
      }
      return null;
    };
    const plus = wdInt(o.plus, 0, 255);
    if (o.weapon) {
      const w = near(6, (x) => x.m.kind === o.weapon);
      if (w) {
        c.eq[6] = { ref: w.id, plus };
        n++;
      }
    }
    if (o.shield) {
      const sh = near(7, () => true);
      if (sh) {
        c.eq[7] = { ref: sh.id, plus };
        n++;
      }
    }
    this.changed(false);
    return { n, miss };
  },

  savePreset(name) {
    const key = String(name || '')
      .trim()
      .slice(0, 32);
    if (!key || /^(__proto__|constructor|prototype)$/.test(key)) return false;
    const c = this.cfg();
    if (!Object.prototype.hasOwnProperty.call(c.presets, key) && Object.keys(c.presets).length >= 40) {
      UI.toast('Up to 40 outfits can be stored.', 'warn', 2500);
      return false;
    }
    c.presets[key] = this.outfit();
    Settings.saveProfile();
    return true;
  },

  loadPreset(name) {
    const presets = this.cfg().presets;
    const p = Object.prototype.hasOwnProperty.call(presets, name) ? presets[name] : null;
    if (!p || typeof p !== 'object') return;
    this.snapshot();
    const pets = this.petKey();
    this.useOutfit(p);
    this.changed(this.petKey() !== pets);
  },

  deletePreset(name) {
    delete this.cfg().presets[name];
    Settings.saveProfile();
  },

  myCos() {
    const out = { p3: null, p4: null, pm: null };
    const lg = World.localGid();
    const local = World.local();
    if (!lg) return out;
    for (const e of World.ents.values()) {
      if (!e || e.kind !== 'cos') continue;
      const t4 = (Number(e.tidWord) >>> 11) & 31;
      if (local && local.mountedOn === e.gid) out.pm = e;
      else if (e.ownerGid === lg && t4 === 3) out.p3 = e;
      else if (e.ownerGid === lg && t4 === 4) out.p4 = e;
    }
    return out;
  },

  realEq(s) {
    const inv = Array.isArray(World.gp?.inventory) ? World.gp.inventory : [];
    return inv.find((it) => it && it.slot === s) || null;
  },

  realAv(s) {
    const l = World.local();
    return (l?.avatars || []).find((a) => a && this.avSlotOf(a) === s) || null;
  },

  isOpen() { return false; },
  ensureData(force = false) { return LeanWardrobe.load(force); },
  tick() {
    if (!WdData.ready()) {
      if (World.inWorld() && this.cfg().on && this.hasOverrides()) this.ensureData();
      return;
    }
    const body = WdData.bodyOf(World.local()?.refObjId);
    if (body && body !== this.body) { this.body = body; this.applyNow(); }
    if (now() - this.learnAt > 2000) { this.learnAt = now(); this.learn(); }
  },
};
Display.addGameplay('wardrobe', st => Wardrobe.onGameplay(st));
Display.add('wardrobe', e => Wardrobe.onEntity(e));


// Original validated appearance core with a compact, lazy catalogue browser.
const Assets = {
  cache: new Map(),
  json(path) {
    if (!this.cache.has(path)) this.cache.set(path, Icons.request(path, 'json').catch(e => { this.cache.delete(path); throw e; }));
    return this.cache.get(path);
  },
  texts() { return this.json('/assets/text/textdataname.en.json').then(r => r.entries || {}); },
  async wardrobe() {
    const r = await this.json('/assets/char/roster.json'), d = r.dress || {}, items = [];
    for (const [id, e] of Object.entries(d.equipment || {})) {
      if (!e || (e.slot == null && e.avatarSlot == null)) continue;
      const bodies = Object.keys(e.bodies || {}).filter(k => e.bodies[k] && typeof e.bodies[k] === 'object');
      if (bodies.length) items.push([Number(id), e.code || '', e.slot ?? -1, e.avatarSlot ?? -1, bodies.join(','), d.specialGlows?.[id] ? 1 : 0, e.armorClass || 0]);
    }
    return { items, models: Object.values(r.models || {}).map(m => [m.refObjId, m.codename || '', m.isMount ? 1 : 0]) };
  },
  async npcModels() {
    const r = await this.json('/assets/npc/manifest.json');
    return Object.values(r.models || {}).filter(v => v?.refObjId != null).map(v => [v.refObjId, v.codename || '', v.kind || '']);
  },
};
const Items = {
  data: new Map(), pending: null,
  ready() {
    if (this.pending) return this.pending;
    this.pending = Promise.all([Assets.json('/assets/data/missionPresentation.json'), Assets.texts()]).then(([r, names]) => {
      for (const [id, v] of Object.entries(r.itemsByRefObjId || {})) {
        if (!v?.codename) continue;
        const code = v.codename, generic = code.replace(/^ITEM_(CH|EU)_[MW]_/, 'ITEM_$1_');
        let name = names['SN_' + code] || names['SN_' + generic], shortened = generic;
        while (!name && shortened.includes('_')) { shortened = shortened.slice(0, shortened.lastIndexOf('_')); name = names['SN_' + shortened]; }
        this.data.set(Number(id), { name: name || code, icon: v.iconDdjPath || '', code });
      }
    }).catch(e => { this.pending = null; throw e; });
    return this.pending;
  },
  name(id) { return this.data.get(id)?.name || WdData.byId.get(id)?.code || '#' + id; },
  iconDdj(id) { return this.data.get(id)?.icon || ''; },
  // 0 none | 1 Star | 2 Moon | 3 Sun, from the codename rule _[ABC]_RARE (also MAGIC/LEGEND/MYTH, HONOR).
  // Real inventory/pet items carry tooltip rarity (2 = seal tiers) and a Star/Moon/Sun class; otherwise use the codename rule.
  soxOf(item) {
    const f = item?.tooltip?.fields;
    if (f && f.rarity !== undefined) {
      if (f.rarity !== 2) return 0;
      if (f.itemClass) return ((f.itemClass - 1) % 3) + 1;
    }
    const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(item?.codename || this.data.get(item?.refObjId)?.code || '');
    return m ? 'ABC'.indexOf(m[1]) + 1 : f?.rarity === 2 ? 1 : 0;
  },
  sox(id) { const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(this.data.get(id)?.code || ''); return m ? 'ABC'.indexOf(m[1]) + 1 : 0; },
};
const LeanWardrobe = {
  slot: 'e6', query: '', degree: 0, rarity: '', page: 0, loading: null, preset: '',
  load(force = false) {
    if (this.loading) return this.loading;
    this.loading = WdData.load(force).then(ok => {
      if (ok) { Wardrobe.body = WdData.bodyOf(World.local()?.refObjId); Wardrobe.learn(); Wardrobe.applyNow(); }
      if (UI.is('Wardrobe')) UI.draw();
      return ok;
    }).finally(() => { this.loading = null; });
    return this.loading;
  },
  change(fn) { fn(); Wardrobe.changed(false); UI.draw(); },
  chooseSlot(slot) {
    this.slot = slot; Wardrobe.view.slot = slot;
    this.query = ''; this.degree = 0; this.rarity = ''; this.page = 0;
    UI.draw();
  },
  rows() {
    const q = wdFold(this.query);
    if (this.slot[0] === 'p') {
      const list = this.slot === 'pm' ? WdData.mounts : WdData.pets;
      return list.filter(r => wdFold(r.name + ' ' + r.code + ' ' + (r.size || '')).includes(q));
    }
    const number = Number(this.slot.slice(1)), equipment = this.slot[0] === 'e';
    return WdData.rowsFor(Wardrobe.body).filter(r => (equipment ? r.slot === number : this.slot === 'a*' ? r.av >= 0 : r.av === number) &&
      (!equipment || ((!this.degree || r.m.deg === this.degree) && (!this.rarity || String(r.m.sox) === this.rarity))) && wdFold(Items.name(r.id) + ' ' + r.code).includes(q));
  },
  draw(parent) {
    const c = Wardrobe.cfg();
    const actions = UI.group('Appearance studio',
      UI.check('Enable wardrobe', () => c.on, v => { c.on = v; Wardrobe.changed(true); }),
      UI.check('Keep real weapon animations', () => c.realAnim, v => { c.realAnim = v; Wardrobe.changed(false); }),
      UI.check('Show skins in empty slots', () => c.phantom, v => { c.phantom = v; Wardrobe.changed(false); }),
      UI.check('Hide avatars', () => c.hideAvatars, v => { c.hideAvatars = v; Wardrobe.changed(false); }),
      UI.row(UI.button('Random outfit', () => this.change(() => Wardrobe.randomize())), UI.button('Real look', () => this.change(() => Wardrobe.resetAll())), UI.button('Undo', () => this.change(() => Wardrobe.undo()))),
      el('p', 'Preview outfits on your character. Looks are visible to you only; equipment stats stay real. Import original settings to restore your previous outfits.', 'muted'));
    parent.append(actions);
    if (!WdData.ready()) {
      const state = el('p', WdData.error ? 'Catalogue could not load: ' + WdData.error : 'Loading wardrobe catalogue…', 'muted');
      parent.append(UI.group('Catalogue', state, UI.button('Retry catalogue', () => this.load(true))));
      if (!WdData.error) this.load();
      return;
    }
    Wardrobe.body = WdData.bodyOf(World.local()?.refObjId);
    if (!Wardrobe.body) { parent.append(el('p', 'Enter the world so the wardrobe can match skins to your character body.', 'muted')); return; }
    const categories = el('div', null, 'subtabs');
    for (const [label, slot] of [['Equipment', 'e6'], ['Avatars / paid skins', 'a*'], ['Pets & mounts', 'p4']]) {
      const button = UI.button(label, () => this.chooseSlot(slot)); button.setAttribute('aria-selected', String(this.slot[0] === slot[0])); categories.append(button);
    }
    parent.append(categories);
    const slots = [...Array.from({ length: 9 }, (_, s) => ['e' + s, wdSlotName(s)]), ['a*', 'All avatar skins'], ...Array.from({ length: 4 }, (_, s) => ['a' + s, 'Avatar ' + wdAvatarName(s)]), ['p3', 'Attack pet'], ['p4', 'Pickup pet'], ['pm', 'Mount']];
    const catalog = UI.group('Skins for ' + Wardrobe.body,
      UI.select('Appearance slot', slots, () => this.slot, v => this.chooseSlot(v)));
    if (this.slot[0] === 'e') catalog.append(
      UI.select('Degree', [[0, 'All'], ...Array.from({ length: 15 }, (_, i) => [i + 1, 'Degree ' + (i + 1)])], () => this.degree, v => { this.degree = Number(v); this.page = 0; UI.draw(); }),
      UI.select('Seal', [['', 'All'], ['0', 'Normal'], ['1', 'Star'], ['2', 'Moon'], ['3', 'Sun']], () => this.rarity, v => { this.rarity = v; this.page = 0; UI.draw(); }));
    if (this.slot[0] === 'a') catalog.append(el('p', 'All compatible avatar looks in the game catalogue, including paid skins, whether owned or not. This is a local appearance preview; it does not buy items or grant ownership.', 'muted'));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search name or skin code'; search.value = this.query; search.setAttribute('aria-label', 'Search wardrobe');
    const results = el('div'), refresh = () => this.results(results);
    search.addEventListener('input', () => { this.query = search.value; this.page = 0; refresh(); });
    const hide = UI.button('Hide slot', () => this.change(() => Wardrobe.toggleHide(this.slot))); hide.disabled = this.slot[0] === 'p' || this.slot === 'a*';
    const reset = UI.button('Reset slot', () => this.change(() => Wardrobe.resetSlot(this.slot))); reset.disabled = this.slot === 'a*';
    catalog.append(UI.field('Search wardrobe', search), UI.row(
      reset, hide));
    if (this.slot === 'e6' || this.slot === 'e7') catalog.append(UI.number('Weapon / shield glow (+)', () => c.eq[Number(this.slot.slice(1))]?.plus ?? 0,
      v => { Wardrobe.ensureEq(Number(this.slot.slice(1))).plus = v; Wardrobe.changed(false); }, 0, 255));
    catalog.append(results); parent.append(catalog); refresh();
    const opt = Wardrobe.setOpt;
    const set = UI.group('Matching set',
      UI.select('Armour', [['CLOTHES', 'Garment / Robe'], ['LIGHT', 'Protector / Light'], ['HEAVY', 'Armour / Heavy']], () => opt.cls || 'CLOTHES', v => opt.cls = v),
      UI.number('Set degree', () => opt.deg || 1, v => opt.deg = v, 1, 15),
      UI.select('Set seal', [[0, 'Normal'], [1, 'Star'], [2, 'Moon'], [3, 'Sun']], () => opt.sox, v => opt.sox = Number(v)),
      UI.select('Matching weapon', [['', 'Keep current'], ...[...new Set(WdData.rowsFor(Wardrobe.body).filter(r => r.slot === 6 && r.m.kind && r.m.kind !== 'FORT').map(r => r.m.kind))].map(kind => [kind, wdKindName(kind)])], () => opt.weapon, v => opt.weapon = v),
      UI.check('Include matching shield', () => opt.shield, v => opt.shield = v),
      UI.number('Set weapon / shield glow (+)', () => opt.plus, v => opt.plus = v, 0, 255),
      UI.button('Wear matching armour', () => this.change(() => { opt.cls ||= 'CLOTHES'; opt.deg ||= 1; const result = Wardrobe.applySet(); if (result) UI.toast('Applied ' + result.n + ' parts; ' + result.miss + ' unavailable.'); })));
    parent.append(set);
    const name = el('input'); name.type = 'text'; name.maxLength = 32; name.placeholder = 'Outfit name'; name.setAttribute('aria-label', 'Outfit name');
    const presets = UI.group('Saved outfits', name,
      UI.button('Save outfit', () => this.change(() => Wardrobe.savePreset(name.value))),
      UI.select('Outfit', () => [['', 'Choose outfit'], ...Object.keys(c.presets).map(k => [k, k])], () => this.preset, v => this.preset = v),
      UI.row(UI.button('Wear outfit', () => this.change(() => Wardrobe.loadPreset(this.preset))), UI.button('Delete outfit', () => this.change(() => Wardrobe.deletePreset(this.preset)))));
    parent.append(presets);
  },
  results(parent) {
    parent.replaceChildren();
    const rows = this.rows(), count = 48, pages = Math.max(1, Math.ceil(rows.length / count));
    this.page = Math.min(this.page, pages - 1);
    parent.append(el('p', rows.length + ' compatible skins · page ' + (this.page + 1) + '/' + pages, 'muted'));
    const grid = el('div', null, 'wardrobe-grid');
    for (const row of rows.slice(this.page * count, (this.page + 1) * count)) {
      const pet = this.slot[0] === 'p', title = pet ? row.name + (row.size ? ' · ' + row.size : '') : Items.name(row.id);
      const targetSlot = this.slot === 'a*' ? 'a' + row.av : this.slot;
      const button = UI.button('', () => this.change(() => { Wardrobe.view.slot = targetSlot; if (pet) Wardrobe.setPet(this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick', row.id); else Wardrobe.pick(row); }));
      button.className = 'wardrobe-item'; button.title = title + '\n' + row.code; button.setAttribute('aria-label', 'Wear ' + title);
      const c = Wardrobe.cfg(), selected = pet ? c.pet[this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick'] : c[targetSlot[0] === 'e' ? 'eq' : 'av'][Number(targetSlot.slice(1))]?.ref;
      button.setAttribute('aria-pressed', String(selected === row.id));
      const icon = el('span', null, 'slot skill-icon'); icon.append(el('span', pet ? 'Pet' : 'Skin', 'fallback')); Icons.paint(icon, Items.iconDdj(row.id));
      button.append(icon, el('span', title + (this.slot === 'a*' ? ' · ' + wdAvatarName(row.av) : ''))); grid.append(button);
    }
    const previous = UI.button('Previous skins', () => { this.page = Math.max(0, this.page - 1); this.results(parent); }), next = UI.button('Next skins', () => { this.page = Math.min(pages - 1, this.page + 1); this.results(parent); });
    previous.disabled = this.page === 0; next.disabled = this.page >= pages - 1;
    parent.append(grid, UI.row(previous, next));
    if (!rows.length) parent.append(el('p', 'No compatible skins match these filters.', 'muted'));
  },
};


// Generated by gen-alchemy.py from the server item data: the authored success chance of every reinforce elixir and lucky powder
// at plus +0..+11 (the +11 value holds above), and the elixir ids of each gear kind. Do not edit by hand.
const ALCHEMY_DATA = {"attrStones":{"NATTR_PA":6895,"NATTR_PASTR":6907,"NATTR_MA":6919,"NATTR_MAINT":6931,"NATTR_CRITICAL":6943,"NATTR_HR":6955,"NATTR_PD":6967,"NATTR_PDSTR":6979,"NATTR_MD":6991,"NATTR_MDINT":7003,"NATTR_ER":7015,"NATTR_BR":7027,"NATTR_PAR":7039,"NATTR_MAR":7051},"elixirs":{"3675":[25,20,15,10,10,10,10,10,10,5,5,5],"3679":[50,40,30,19,17,17,17,17,17,12,12,12],"3676":[25,20,15,10,10,10,10,10,10,5,5,5],"3680":[50,40,30,19,17,17,17,17,17,12,12,12],"3677":[25,20,15,10,10,10,10,10,10,5,5,5],"3681":[50,40,30,19,17,17,17,17,17,12,12,12],"3678":[25,20,15,10,10,10,10,10,10,5,5,5],"3682":[50,40,30,19,17,17,17,17,17,12,12,12]},"powders":{"3683":{"degree":1,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3684":{"degree":2,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3685":{"degree":3,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3686":{"degree":4,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3687":{"degree":5,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3688":{"degree":6,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3689":{"degree":7,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3690":{"degree":8,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3691":{"degree":9,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3692":{"degree":10,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3693":{"degree":11,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3694":{"degree":12,"chances":[50,30,20,8,8,8,8,8,8,8,8,8]},"3695":{"degree":1,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3696":{"degree":2,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3697":{"degree":3,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3698":{"degree":4,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3699":{"degree":5,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3700":{"degree":6,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3701":{"degree":7,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3702":{"degree":8,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3703":{"degree":9,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3704":{"degree":10,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3705":{"degree":11,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]},"3706":{"degree":12,"chances":[50,40,30,20,20,20,20,20,20,10,10,10]}},"kinds":{"weapon":[3675,3679],"shield":[3676,3680],"armor":[3677,3681],"accessory":[3678,3682]}};


// Item enhancement (elixirs, for weapons, shields, armour and accessories) and the Luck / Steady / Immortal / Astral stones. Never resend an unconfirmed
// material-spending request.
// A stone adds 1 to the weapon's attribute count (at most 6): Luck raises the enhancement success chance, Steady
// protects the durability and Immortal the weapon itself when an enhancement fails. Stone items are one per weapon
// degree 1..12, in consecutive ids. The server takes these stones (item type 3,3,11,7) only in the request it calls
// "magic" (mode byte 3). The page's own attribute mode sends byte 2, which the server answers with refusal 0x10 for
// them, so the command here uses mode 'magic'. A fusion can fail: the stone is then used up and the answer is 0x23.
const STONES = {
  luck: { label: 'Luck', option: 'MATTR_LUCK', base: 6871 },
  steady: { label: 'Steady', option: 'MATTR_SOLID', base: 6859 },
  immortal: { label: 'Immortal', option: 'MATTR_ATHANASIA', base: 6847 },
  astral: { label: 'Astral', option: 'MATTR_ASTRAL', base: 6883 },
};
const STONE_MAX = 6;
// The attributes an item's stat percentages come from, in the order the server keeps them (alchemy stones.go
// attributes()): the index is the item's 5-bit variance field. Durability has no stone.
const ATTRIBUTES = {
  weapon: ['NATTR_DUR', 'NATTR_PASTR', 'NATTR_MAINT', 'NATTR_HR', 'NATTR_PA', 'NATTR_MA', 'NATTR_CRITICAL'],
  armor: ['NATTR_DUR', 'NATTR_PDSTR', 'NATTR_MDINT', 'NATTR_PD', 'NATTR_MD', 'NATTR_ER'],
  shield: ['NATTR_DUR', 'NATTR_PDSTR', 'NATTR_MDINT', 'NATTR_BR', 'NATTR_PD', 'NATTR_MD'],
  accessory: ['NATTR_PAR', 'NATTR_MAR'],
};
const ATTRIBUTE_LABEL = {
  NATTR_PASTR: 'Phy. reinforce', NATTR_MAINT: 'Mag. reinforce', NATTR_PDSTR: 'Phy. reinforce', NATTR_MDINT: 'Mag. reinforce', NATTR_HR: 'Attack rating',
  NATTR_PA: 'Phy. attack power', NATTR_MA: 'Mag. attack power', NATTR_CRITICAL: 'Critical', NATTR_PD: 'Phy. defense', NATTR_MD: 'Mag. defense',
  NATTR_ER: 'Parry rate', NATTR_BR: 'Block rate', NATTR_PAR: 'Phy. absorption', NATTR_MAR: 'Mag. absorption',
};
// A fusion rolls a new value in six steps (alchemy stones.go varianceValue). The step is the lowest of four rolls (the
// item's own magic limit caps it), so the value is one of these; each step needs every roll to reach it.
const ATTRIBUTE_STEPS = [[7, 22], [13, 41], [19, 61], [25, 80], [31, 100]];
const STONE_FAILED = 0x23;
const Alchemy = {
  windowOwner: null, selected: null, run: null, pending: null, result: null, message: 'Select an item from your bag to begin.', started: false,
  cfg() { return Settings.profile.alchemy; },
  // The server's enhancement families (alchemy catalog.go category()): weapon, shield, accessory and armor. An elixir is
  // refused (0x09) for any other family.
  kind(i) {
    if (!i || i.slot < 13 || i.slot > 255 || (i.typeFlags & 0x7e) !== 0x2c || !Number.isInteger(i.plus) || i.plus < 0) return '';
    const t = (i.typeFlags >>> 7) & 15;
    return t === 6 ? 'weapon' : t === 4 ? 'shield' : t === 5 || t === 12 ? 'accessory' : [1, 2, 3, 9, 10, 11].includes(t) ? 'armor' : '';
  },
  gear(i) { return !!this.kind(i); },
  degree(i) { const n = i?.tooltip?.fields?.itemClass; return Number.isInteger(n) && n > 0 ? Math.floor((n - 1) / 3) + 1 : 0; },
  // Retail itemdata: weapon recipes 3675/3679 (param1 includes category 6).
  // Powder A 3683..3694 and B 3695..3706 have param1 = degree 1..12.
  // Reinforce elixirs (item data ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_<KIND>_A / _B), per gear kind.
  elixir(i, kind = 'weapon') { return i && !!ALCHEMY_DATA.kinds[kind]?.includes(i.refObjId) && (i.typeFlags & 0xfffe) === 0x0d6c && i.quantity > 0 && i.slot >= 13; },
  powderDegree(i) {
    if (!i || (i.typeFlags & 0xfffe) !== 0x156c || !(i.quantity > 0) || i.slot < 13) return 0;
    return i.refObjId >= 3683 && i.refObjId <= 3694 ? i.refObjId - 3682 : i.refObjId >= 3695 && i.refObjId <= 3706 ? i.refObjId - 3694 : 0;
  },
  fingerprint(i) { return JSON.stringify([i.slot, i.refObjId, i.typeFlags, i.plus, i.durability, i.variance, i.magic]); },
  identity(i) { return JSON.stringify([i.slot, i.refObjId, i.typeFlags, i.variance]); },
  select(slot) {
    if (this.run || this.pending) return UI.toast('Stop alchemy and wait for the pending result before changing weapons.', 'warn');
    const item = World.items().find(i => i.slot === Number(slot));
    this.selected = this.gear(item) ? { slot: item.slot, fingerprint: this.fingerprint(item) } : null;
    this.message = this.selected ? 'Item selected. Set the target and attempt limit.' : 'Select an item from your bag to begin.';
  },
  item() { return World.items().find(i => i.slot === this.selected?.slot); },
  // The count of one attribute (Luck, Steady, Immortal) on a weapon, from its magic options; the option's amount is the count.
  attributeCount(item, option) {
    const refs = item?.magicReferences || [];
    return (item?.magic || []).reduce((n, encoded) => {
      const bits = toBigInt(encoded), ref = refs.find(r => r.paramId === Number(bits & 65535n));
      return ref?.optionName === option ? Math.max(n, Number(bits >> 32n) & 0xffffffff) : n;
    }, 0);
  },
  // Counts are readable only when every magic option has its reference loaded; otherwise they would read as zero.
  attributesKnown(item) {
    const refs = item?.magicReferences || [];
    return (item?.magic || []).every(encoded => refs.some(r => r.paramId === Number(toBigInt(encoded) & 65535n)));
  },
  // Attribute percentages. `index` is the attribute's place in the server's list, which is also its 5-bit slot in the item's variance.
  attributes(kind) { return (ATTRIBUTES[kind] || []).map((name, index) => ({ name, index })).filter(a => ALCHEMY_DATA.attrStones[a.name] && ATTRIBUTE_LABEL[a.name]); },
  attrValue(item, index) { return item?.variance === undefined ? 0 : Number((toBigInt(item.variance) >> BigInt(index * 5)) & 31n); },
  attrValues(item) { return Object.fromEntries(this.attributes(this.kind(item)).map(a => [a.name, this.attrValue(item, a.index)])); },
  attrTarget(name, cfg = this.cfg()) { return Math.min(31, Math.max(0, Math.floor(Number(cfg.attr?.targets?.[name])) || 0)); },
  attrPercent(value) { return Math.floor(value * 100 / 31); },
  // The first attribute below its wanted value, with a bag stone of the item's degree.
  nextAttr(item, cfg = this.cfg()) {
    const degree = this.degree(item);
    for (const a of this.attributes(this.kind(item))) {
      const target = this.attrTarget(a.name, cfg);
      if (!target || this.attrValue(item, a.index) >= target) continue;
      const ref = ALCHEMY_DATA.attrStones[a.name] + degree - 1;
      const stone = World.items().find(i => i.refObjId === ref && (i.typeFlags & 0xfffe) === 0x15ec && i.quantity > 0 && i.slot >= 13);
      return stone ? { attr: a, item: stone } : { missing: `No ${ATTRIBUTE_LABEL[a.name]} stone of degree ${degree} in the bag.` };
    }
    return null;
  },
  // About how many stones one wanted value takes: a fusion works half the time (the stone's own chance, before skill and
  // avatar bonuses) and then the new value reaches step k only when all four rolls do, ((6 - k) / 6)^4, if the item allows it.
  attrExpected(target) {
    const k = ATTRIBUTE_STEPS.findIndex(s => s[0] >= target) + 1;
    return k > 0 ? 1 / (.5 * Math.pow((6 - k) / 6, 4)) : 0;
  },
  // The helpers switched on, and how many charges of each to keep on the item (1 to 6).
  wanted(cfg = this.cfg()) { return Object.keys(STONES).filter(kind => !!cfg.use?.[kind]); },
  keep(kind, cfg = this.cfg()) { return Math.min(STONE_MAX, Math.max(1, Math.floor(Number(cfg.stones?.[kind])) || 1)); },
  // The plus from which a helper is used.
  from(kind, cfg = this.cfg()) { return Math.max(0, Number(cfg.from?.[kind]) || 0); },
  // The next stone to fuse: the first kind still below its wanted count, with a bag stone of the weapon's degree.
  nextStone(item, cfg = this.cfg(), plus = Infinity) {
    const degree = this.degree(item);
    for (const kind of this.wanted(cfg).filter(k => plus >= this.from(k, cfg))) {
      const want = this.keep(kind, cfg), have = this.attributeCount(item, STONES[kind].option);
      if (have >= want) continue;
      const ref = STONES[kind].base + degree - 1;
      const stone = World.items().find(i => i.refObjId === ref && (i.typeFlags & 0xfffe) === 0x3dec && i.quantity > 0 && i.slot >= 13);
      return stone ? { kind, item: stone, count: have } : { missing: kind };
    }
    return null;
  },
  powderWanted(item, cfg = this.cfg()) { return !!cfg.powder && item.plus >= this.from('powder', cfg); },
  materials(item, cfg = this.cfg()) {
    const kind = this.kind(item), degree = this.degree(item);
    const elixir = World.items().find(i => this.elixir(i, kind) && (!cfg.elixir || i.refObjId === cfg.elixir));
    const wantPowder = this.powderWanted(item, cfg);
    const powder = wantPowder ? World.items().find(i => this.powderDegree(i) === degree && degree > 0) : null;
    return { elixir, powder, wantPowder };
  },
  // The server's odds for one attempt (reinforce.go): the elixir's chance at the plus (+11 holds above), plus the powder's
  // and the Luck bonus while the running chance is below 100, clamped to 10..100. Skill and avatar bonuses are not known here.
  chanceAt(plus, elixirRef, powderRef, luck) {
    const e = ALCHEMY_DATA.elixirs[elixirRef]; if (!e) return null;
    const at = Math.min(Math.max(0, plus), 11), p = powderRef && ALCHEMY_DATA.powders[powderRef];
    let c = e[at];
    if (p && c < 100) c += p.chances[at];
    if (luck && c < 100) c += 5;
    return Math.max(10, Math.min(100, c));
  },
  // Expected attempts to climb from plus `from` to `target` when a failure resets to +0 (no Astral), and the chance of
  // getting there without one failure. P[k] is the chance of climbing from +0 to +k in a row.
  expected(from, target, chance) {
    const P = [1]; for (let k = 0; k < target; k++) P[k + 1] = P[k] * chance(k) / 100;
    let all = 0, run = 0; for (let k = 0; k < target; k++) { all += P[k]; if (k >= from) run += P[k]; }
    const q = P[target] / P[from], first = all / P[target];
    return { attempts: run / P[from] + (1 - q) * first, clean: q };
  },
  // What the next attempts would use and how likely they are to work, from the bag and the settings.
  odds(item, cfg = this.cfg()) {
    const kind = this.kind(item); if (!kind) return null;
    const elixir = World.items().find(i => this.elixir(i, kind) && (!cfg.elixir || i.refObjId === cfg.elixir));
    if (!elixir) return null;
    const degree = this.degree(item), powder = cfg.powder && degree > 0 ? World.items().find(i => this.powderDegree(i) === degree) : null;
    const luck = !!cfg.use?.luck;
    const at = plus => this.chanceAt(plus, elixir.refObjId, powder && plus >= this.from('powder', cfg) ? powder.refObjId : 0, luck && plus >= this.from('luck', cfg));
    const target = Math.min(250, Math.max(item.plus + 1, Number(cfg.target) || 0));
    return { now: at(item.plus), plan: item.plus < target ? this.expected(item.plus, target, at) : null, target };
  },
  // The log and statistics shown under the settings: newest last, at most 60 lines.
  log: [],
  note(text) { this.log.push({ at: Date.now(), text }); if (this.log.length > 60) this.log.shift(); },
  blocked() {
    if (BuffGear.run || BuffGear.recovery) return 'Restore or review combat gear before alchemy.';
    const gp = World.gp;
    if (!World.inWorld() || !gp || !World.local()) return 'Enter the game world first.';
    if (World.isDead()) return 'Alchemy stopped: character died.';
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || Controller.resumeAfterRevive) return 'Stop hunting, travel and route recording first.';
    if (Loot.active) return 'Stop collection and wait for its inventory transaction first.';
    if (World.isCasting() || Hunt.underAttack() || gp.returnScroll || gp.pendingMoves) return 'Wait for combat and movement to finish.';
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting || gp.stall?.phase && gp.stall.phase !== 'none') return 'Close shop, storage, trade and stall first.';
    return '';
  },
  start(stonesOnly = false) {
    if (this.run) return;
    if (this.pending) return UI.toast('Previous attempt is unconfirmed. Wait for its result; reload if the game cannot settle it.', 'warn');
    const error = this.blocked(), gp = World.gp, item = this.item(), c = this.cfg();
    const reject = text => { this.message = text; UI.toast(text, 'warn'); };
    if (error) return reject(error);
    if (gp.inventoryPending || !gp.alchemy || gp.alchemy.pending) return reject('Wait for known, settled inventory and alchemy state.');
    if (!this.gear(item) || this.fingerprint(item) !== this.selected?.fingerprint) return reject('Weapon changed or moved. Select it again.');
    const wants = this.wanted(c);
    if (stonesOnly && !wants.length) return reject('Tick at least one stone type first (Use Luck, Steady, Immortal or Astral).');
    if (wants.length && !this.degree(item)) return reject('Weapon degree is unknown; cannot choose matching stones.');
    if (wants.length && !this.attributesKnown(item)) return reject('The weapon\'s attributes are not loaded yet. Try again in a moment.');
    if (!stonesOnly) {
    if (!Number.isInteger(c.target) || c.target < 1 || c.target > 250 || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > 1000) return reject('Set target + from 1 to 250 and attempts from 1 to 1000.');
    if (item.plus >= c.target) return reject('Weapon already meets the target +.');
    const materials = this.materials(item);
    if (!materials.elixir) return reject(`No selected ${this.kind(item)} elixirs in the bag.`);
    if (materials.wantPowder && !this.degree(item)) return reject('Weapon degree is unknown; cannot choose compatible lucky powder.');
    if (materials.wantPowder && !materials.powder) return reject('No lucky powder matching this weapon degree.');
    }
    this.run = { slot: item.slot, identity: this.identity(item), fingerprint: this.fingerprint(item), stonesOnly,
      cfg: { ...c }, config: JSON.stringify(c), manualAt: Manual.lastAt, character: World.charName,
      attempts: 0, successes: 0, failures: 0, destroyed: 0, highest: item.plus, elixirs: 0, powders: 0, stoneAttempts: 0, stoneFailures: 0, stonesUsed: { luck: 0, steady: 0, immortal: 0, astral: 0 }, nextAt: now(), opening: null };
    this.result = this.run; this.message = 'Preparing alchemy.';
    this.note(stonesOnly ? 'Started fusing stones.' : `Started: ${item.name || Items.name(item.refObjId)} +${item.plus} to +${c.target}.`);
  },
  // Fuse attribute stones until every wanted percentage is reached (or the stones or the limit run out).
  startAttributes() {
    if (this.run) return;
    if (this.pending) return UI.toast('Previous attempt is unconfirmed. Wait for its result; reload if the game cannot settle it.', 'warn');
    const error = this.blocked(), gp = World.gp, item = this.item(), c = this.cfg();
    const reject = text => { this.message = text; UI.toast(text, 'warn'); };
    if (error) return reject(error);
    if (gp.inventoryPending || !gp.alchemy || gp.alchemy.pending) return reject('Wait for known, settled inventory and alchemy state.');
    if (!this.gear(item) || this.fingerprint(item) !== this.selected?.fingerprint) return reject('Item changed or moved. Select it again.');
    if (!this.degree(item)) return reject('Item degree is unknown; cannot choose matching stones.');
    if (item.variance === undefined) return reject('The item\'s stats are not loaded yet. Try again in a moment.');
    if (!this.attributes(this.kind(item)).some(a => this.attrTarget(a.name, c))) return reject('Pick at least one attribute percentage to aim for first.');
    if (!this.nextAttr(item, c)) return reject('The item already has every wanted percentage.');
    this.run = { kind: 'attr', slot: item.slot, identity: this.identity(item), shape: JSON.stringify([item.slot, item.refObjId, item.typeFlags]), fingerprint: this.fingerprint(item), stonesOnly: false,
      cfg: JSON.parse(JSON.stringify(c)), config: JSON.stringify(c), manualAt: Manual.lastAt, character: World.charName,
      attempts: 0, successes: 0, failures: 0, destroyed: 0, highest: item.plus, elixirs: 0, powders: 0, stoneAttempts: 0, stoneFailures: 0, attrFused: 0,
      stonesUsed: { luck: 0, steady: 0, immortal: 0, astral: 0 }, nextAt: now(), opening: null };
    this.result = this.run; this.message = 'Preparing attribute stones.';
    this.note(`Started attribute stones on ${item.name || Items.name(item.refObjId)}.`);
  },
  stop(reason = 'Alchemy stopped. An attempt already sent may still finish.') {
    if (this.run) { this.note(reason); this.run = null; this.message = reason; }
    // Close only a session we opened/used, on the same character. Native close
    // does not cancel reinforcement; keep the pending result until confirmed.
    const owner = this.windowOwner; this.windowOwner = null;
    if (owner && owner.character === World.charName && World.inWorld() && ['reinforce', 'magic', 'attribute'].includes(World.gp?.alchemy?.mode))
      Cmd.raw({ kind: 'alchemy-close' }, 'Close alchemy');
  },
  init() {
    if (this.started) return; this.started = true;
    // All manual native gameplay commands can interfere with the selected bag.
    // Our own Cmd.raw bypasses these observers, as with combat/manual pause.
    Hook.observers.push(command => { if (command.kind === 'gameplay' && this.run) this.stop('Alchemy stopped by manual game control.'); });
    bus.on('game-error', text => { if (this.run && /alchemy|inventory process/i.test(String(text))) this.stop('Alchemy stopped after a game refusal; wait for the inventory to settle.'); });
    bus.on('reset', () => { this.windowOwner = null; this.stop('Alchemy stopped after world reset.'); this.pending = null; this.selected = null; });
  },
  observe() {
    const p = this.pending, gp = World.gp, a = gp?.alchemy;
    if (!p || !a || gp === p.state) return;
    if (a.pending) {
      if (a.mode !== (p.mode || (p.stone ? 'magic' : 'reinforce')) || a.slot !== p.run.slot) this.stop('Alchemy state changed unexpectedly. Wait for the outstanding result.');
      return;
    }
    if (a !== p.before && a.error !== null && a.error !== undefined) {
      // A failed stone fusion is answered like a refusal (0x23), but the stone is gone: it is a result, not a stop.
      if (p.stone && a.error === STONE_FAILED) return this.observeStone(p, gp, true);
      this.pending = null; this.stop(p.stone ? this.stoneRefusal(a.error) : 'Alchemy refused by the game (code ' + a.error + ').'); return;
    }
    if (p.stone) return this.observeStone(p, gp);
    const outcome = a.flags & 0x70;
    if (a.mode !== 'reinforce' || a.slot !== p.run.slot || ![0x10, 0x20, 0x40].includes(outcome) || gp.inventoryPending) return;
    // The worker may publish the start and result between our ticks. Require
    // exactly one of each selected reagent consumed, not just a stale flag.
    if (Restock.count(p.elixir.ref) !== p.elixir.before - 1 || p.powder && Restock.count(p.powder.ref) !== p.powder.before - 1) return;
    const item = World.items().find(i => i.slot === p.run.slot);
    if (outcome !== 0x40 && (!this.gear(item) || this.identity(item) !== p.run.identity)) {
      this.stop('Weapon identity changed. Outstanding result requires manual review.'); return;
    }
    if (outcome === 0x40 && item) { this.stop('Unexpected destruction result. Outstanding result requires manual review.'); return; }
    if (outcome === 0x10 && item.plus !== p.plus + 1 || outcome === 0x20 && item.plus > p.plus) {
      this.stop('Unexpected enhancement level. Outstanding result requires manual review.'); return;
    }
    this.pending = null;
    p.run.elixirs++; if (p.powder) p.run.powders++;
    if (outcome === 0x10) p.run.successes++; else p.run.failures++;
    if (outcome === 0x40) p.run.destroyed++;
    this.note(outcome === 0x10 ? `Success: +${p.plus} → +${item.plus}` : outcome === 0x40 ? `Destroyed at +${p.plus}` : `Failed at +${p.plus}: now +${item.plus}`);
    if (item) p.run.highest = Math.max(p.run.highest, item.plus);
    if (outcome === 0x40) { this.selected = null; this.stop('Weapon destroyed; alchemy stopped.'); this.message = 'Weapon destroyed; alchemy stopped.'; return; }
    p.run.fingerprint = this.fingerprint(item); this.selected = { slot: item.slot, fingerprint: p.run.fingerprint };
    p.run.nextAt = now() + 1000;
    if (this.run !== p.run) return;
    this.message = outcome === 0x10 ? 'Success: weapon is now +' + item.plus + '.' : 'Failed attempt: weapon is now +' + item.plus + '.';
    if (item.plus >= p.run.cfg.target) this.stop('Target reached: +' + item.plus + '.');
    else if (p.run.attempts >= p.run.cfg.limit) this.stop('Attempt limit reached.');
  },
  // A stone fusion is confirmed by exactly one stone leaving the bag with the inventory settled, not by a flag alone.
  stoneRefusal(code) {
    const why = { 0x10: 'the game does not accept this stone here', 0x12: 'the slots were not accepted', 6: 'an item or stone was missing',
      7: 'there was no stone', 9: 'this weapon cannot take that attribute', 0x21: 'the stone is not of the weapon\'s degree',
      0x22: 'the weapon is at 6 of that stone or has no free magic option slot', 0x24: 'an Astral stone needs more Immortal charges' }[code];
    return `Stone fusion refused by the game (code ${code}${why ? ': ' + why : ''}).`;
  },
  // An attribute fusion is confirmed the same way: one stone leaves the bag. The item's own percentages change, so only its shape is checked.
  observeAttribute(p, gp, failed = false) {
    if (gp.inventoryPending || Restock.count(p.stone.ref) !== p.stone.before - 1) return;
    const item = World.items().find(i => i.slot === p.run.slot);
    if (!this.gear(item) || JSON.stringify([item.slot, item.refObjId, item.typeFlags]) !== p.run.shape) { this.stop('Item changed. Outstanding result requires manual review.'); return; }
    const label = ATTRIBUTE_LABEL[p.stone.attr], before = p.stone.values, after = this.attrValues(item);
    this.pending = null; p.run.attrFused++; if (failed) p.run.stoneFailures++;
    const shown = n => this.attrPercent(n) + '%', others = Object.keys(after).filter(k => k !== p.stone.attr && after[k] !== before[k]).map(k => `${ATTRIBUTE_LABEL[k]} ${shown(before[k])} → ${shown(after[k])}`);
    this.note(failed ? `${label} stone failed and was used up` : `${label}: ${shown(before[p.stone.attr])} → ${shown(after[p.stone.attr])}` + (others.length ? ` (also changed: ${others.join(', ')})` : ''));
    p.run.fingerprint = this.fingerprint(item); this.selected = { slot: item.slot, fingerprint: p.run.fingerprint };
    p.run.nextAt = now() + 1000;
    if (this.run !== p.run) return;
    this.message = failed ? `The ${label} fusion failed and the stone was used up.` : `${label} is now ${shown(after[p.stone.attr])}.`;
  },
  observeStone(p, gp, failed = false) {
    if (p.stone.kind === 'attr') return this.observeAttribute(p, gp, failed);
    if (gp.inventoryPending || Restock.count(p.stone.ref) !== p.stone.before - 1) return;
    const item = World.items().find(i => i.slot === p.run.slot), label = STONES[p.stone.kind].label;
    if (!this.gear(item) || this.identity(item) !== p.run.identity) { this.stop('Weapon identity changed. Outstanding result requires manual review.'); return; }
    const count = this.attributeCount(item, STONES[p.stone.kind].option);
    this.pending = null; p.run.stonesUsed[p.stone.kind]++; if (failed) p.run.stoneFailures++;
    this.note(failed ? `${label} stone failed and was used up` : `${label} stone fused: ${count} of ${STONE_MAX}`);
    p.run.fingerprint = this.fingerprint(item); this.selected = { slot: item.slot, fingerprint: p.run.fingerprint };
    p.run.nextAt = now() + 1000;
    if (this.run !== p.run) return;
    this.message = failed ? `The ${label} fusion failed and the stone was used up (still ${count}).` : count > p.stone.count ? `${label} is now ${count} of ${STONE_MAX}.` : `A ${label} stone was used but the count did not rise (still ${count}).`;
  },
  tick() {
    this.observe();
    const r = this.run, gp = World.gp;
    if (this.pending && now() - this.pending.at > 15000) this.stop('Result unconfirmed after 15 seconds. No further attempts; wait for settlement or reload.');
    if (!r || this.run !== r) return;
    const blocked = this.blocked();
    if (blocked || r.character !== World.charName || r.manualAt !== Manual.lastAt || r.config !== JSON.stringify(this.cfg())) return this.stop(blocked || 'Alchemy stopped: settings, character or manual control changed.');
    if (this.pending) { this.message = 'Attempt ' + r.attempts + ': waiting for server result.'; return; }
    const item = World.items().find(i => i.slot === r.slot);
    if (!this.gear(item) || this.fingerprint(item) !== r.fingerprint) return this.stop('Weapon changed or moved. Select it again.');
    if (r.kind !== 'attr' && !r.stonesOnly && (r.attempts >= r.cfg.limit || item.plus >= r.cfg.target)) return this.stop('Target or attempt limit reached.');
    if (!gp.alchemy) return this.stop('Alchemy state unavailable.');
    if (gp.inventoryPending || gp.alchemy.pending || Loot.pressed()) { this.message = 'Alchemy waiting for inventory or potion use.'; return; }
    if (!gp.alchemy.visible) {
      if (r.opening !== null) { if (now() - r.opening > 5000) this.stop('Alchemy window did not open.'); return; }
      if (Cmd.spaced('alchemy-open') && Cmd.raw({ kind: 'alchemy-open' }, 'Open alchemy')) {
        r.opening = now(); this.windowOwner = { character: r.character };
      }
      return;
    }
    if (r.opening !== null) r.opening = null;
    if (now() < r.nextAt || !Cmd.spaced('alchemy-start')) return;
    if (r.kind === 'attr') {
      const next = this.nextAttr(item, r.cfg);
      if (!next) return this.stop('Every wanted percentage is reached.');
      if (next.missing) return this.stop(next.missing);
      const cap = Math.max(1, Math.floor(Number(r.cfg.attr?.limit) || 100));
      if (r.stoneAttempts >= cap) return this.stop(`Stopped after ${cap} attribute stones (your limit).`);
      const slots = [item.slot, next.item.slot];
      if (slots.some(slot => !Number.isInteger(slot) || slot < 13 || slot > 255) || new Set(slots).size !== slots.length) return this.stop('Invalid material slots.');
      if (Cmd.raw({ kind: 'alchemy-start', mode: 'attribute', slots }, 'Alchemy: fuse a ' + ATTRIBUTE_LABEL[next.attr.name] + ' stone')) {
        this.windowOwner = { character: r.character };
        r.stoneAttempts++;
        this.pending = { run: r, state: gp, before: gp.alchemy, at: now(), plus: item.plus, mode: 'attribute',
          stone: { kind: 'attr', attr: next.attr.name, ref: next.item.refObjId, before: Restock.count(next.item.refObjId), values: this.attrValues(item) } };
        this.message = `Fusing a ${ATTRIBUTE_LABEL[next.attr.name]} stone: waiting for the server result.`;
      }
      return;
    }
    const need = this.nextStone(item, r.cfg, r.stonesOnly ? Infinity : item.plus);
    if (need?.missing) return this.stop(`No ${STONES[need.missing].label} stone of degree ${this.degree(item)} in the bag.`);
    if (need) {
      const cap = Math.max(0, Math.floor(Number(r.cfg.stoneLimit) || 0));
      if (cap && r.stoneAttempts >= cap) return this.stop(`Stopped after ${cap} stone fusions (your limit).`);
      const slots = [item.slot, need.item.slot];
      if (slots.some(slot => !Number.isInteger(slot) || slot < 13 || slot > 255) || new Set(slots).size !== slots.length) return this.stop('Invalid material slots.');
      if (Cmd.raw({ kind: 'alchemy-start', mode: 'magic', slots }, 'Alchemy: fuse a ' + STONES[need.kind].label + ' stone')) {
        this.windowOwner = { character: r.character };
        r.stoneAttempts++;
        this.pending = { run: r, state: gp, before: gp.alchemy, at: now(), plus: item.plus,
          stone: { kind: need.kind, ref: need.item.refObjId, before: Restock.count(need.item.refObjId), count: need.count } };
        this.message = `Fusing a ${STONES[need.kind].label} stone: waiting for the server result.`;
      }
      return;
    }
    if (r.stonesOnly) return this.stop('The weapon has the wanted stone counts.');
    const { elixir, powder, wantPowder } = this.materials(item, r.cfg);
    if (!elixir || wantPowder && !powder) return this.stop('Selected elixirs or compatible lucky powder ran out.');
    const slots = [item.slot, elixir.slot, ...(powder ? [powder.slot] : [])];
    if (slots.some(slot => !Number.isInteger(slot) || slot < 13 || slot > 255) || new Set(slots).size !== slots.length) return this.stop('Invalid material slots.');
    if (Cmd.raw({ kind: 'alchemy-start', mode: 'reinforce', slots }, 'Alchemy: enhance selected weapon')) {
      this.windowOwner = { character: r.character };
      r.attempts++;
      this.pending = { run: r, state: gp, before: gp.alchemy, at: now(), plus: item.plus,
        elixir: { ref: elixir.refObjId, before: Restock.count(elixir.refObjId) },
        powder: powder ? { ref: powder.refObjId, before: Restock.count(powder.refObjId) } : null };
      this.message = 'Attempt ' + r.attempts + ': waiting for server result.';
    }
  },
  draw() {
    const c = () => this.cfg(), items = () => [[-1, 'Select an item from your bag'], ...World.items().filter(i => this.gear(i)).map(i => [i.slot, (i.name || Items.name(i.refObjId)) + ' +' + i.plus + ' · ' + this.kind(i) + ' · bag slot ' + i.slot])];
    const elixirs = () => {
      const kind = this.kind(this.item()) || 'weapon';
      return [[0, 'Any compatible ' + kind + ' elixir'], ...[...new Map(World.items().filter(i => this.elixir(i, kind)).map(i => [i.refObjId, i.name || Items.name(i.refObjId)])).entries()]];
    };
    const group = UI.group('Item enhancement');
    group.append(UI.select('Item', items, () => this.selected?.slot ?? -1, slot => { this.select(slot); UI.draw(); }),
      UI.number('Target +', () => c().target, n => c().target = n, 1, 250),
      UI.number('Maximum attempts', () => c().limit, n => c().limit = n, 1, 1000),
      UI.select('Elixir', elixirs, () => c().elixir, value => c().elixir = Number(value)),
      UI.check('Use lucky powder of matching degree', () => c().powder, value => c().powder = value),
      UI.number('Lucky powder from +', () => c().from.powder, n => c().from.powder = n, 0, 250),
      UI.row(UI.button('Start alchemy', () => this.start()), UI.button('Stop alchemy', () => this.stop())),
      el('p', 'Works on weapons, shields, armour and accessories in your bag; stop hunting and travel first. Each attempt spends one elixir of the item\'s kind and, when enabled and from the plus you set, one lucky powder of its degree. A failure resets the + to 0 (to +4 with an Astral stone); from +5 a failure can also destroy the item half the time unless it has an Immortal charge, or damage it unless it has a Steady charge. Stop prevents the next attempt; a sent attempt may still finish. Unknown results pause without retrying.', 'muted'));
    UI.alchemyPreview = el('div', '', 'row'); UI.alchemyNote = el('p', '', 'muted'); group.append(UI.alchemyPreview, UI.alchemyNote); UI.pane.append(group);
    const stones = UI.group('Stones that help and protect');
    for (const [kind, s] of Object.entries(STONES)) stones.append(UI.check('Use ' + s.label + ' stones while enhancing', () => c().use[kind], v => c().use[kind] = v),
      UI.number(s.label + ': keep this many charges on the item', () => c().stones[kind], n => c().stones[kind] = n, 1, STONE_MAX),
      UI.number(s.label + ': from +', () => c().from[kind], n => c().from[kind] = n, 0, 250));
    stones.append(UI.number('Stop after this many fusions (0 = no limit)', () => c().stoneLimit, n => c().stoneLimit = n, 0, 1000));
    stones.append(UI.row(UI.button('Fuse stones now', () => this.start(true)), UI.button('Stop', () => this.stop())),
      el('p', 'Each stone adds a charge to the item, up to 6. Tick Use for the stones you want. Before every attempt at or above the plus you set, if the item has fewer charges than you asked to keep, one is fused automatically from a stone of the item\'s degree in your bag. Luck adds 5% to the chance, Steady stops the durability damage and Immortal stops the destruction when an enhancement fails from +5, and Astral keeps +4 instead of resetting to 0 (it needs Immortal charges). A fusion can fail and use up the stone. Stops if a stone is missing, the game refuses, or when it reaches the fusion limit above (off by default). Fuse stones now ignores the plus and only fills the charges.', 'muted'));
    UI.pane.append(stones);
    const attrs = UI.group('Item attributes (stat percentages)');
    UI.attrRows = el('div'); UI.attrNote = el('p', '', 'muted'); attrs.append(UI.attrRows, UI.attrNote);
    attrs.append(UI.number('Stop after this many attribute stones', () => c().attr.limit, n => c().attr.limit = n, 1, 1000),
      UI.row(UI.button('Fuse attribute stones', () => this.startAttributes()), UI.button('Stop', () => this.stop())),
      el('p', 'Pick the lowest percentage you want for each stat of the item selected above, then start. The bot fuses attribute stones of the item\'s degree until every picked stat reaches its target, working down the list. Every successful fusion rolls the stat again, so it can also come out lower, and it can re-roll another stat of the item. The chance is 50% per stone before bonuses, and the higher steps get rare fast: 80% and 100% can take hundreds of stones. The item\'s own limit may stop it ever reaching the higher steps, so set a stone limit.', 'muted'));
    UI.pane.append(attrs);
    const results = UI.group('Results');
    UI.alchemyStats = el('p', '', 'muted'); UI.alchemyLog = el('p', '', 'muted');
    results.append(UI.alchemyStats, UI.alchemyLog, UI.button('Clear results', () => { this.result = null; this.log.length = 0; this.refresh(); }));
    UI.pane.append(results);
    this.drawAttributes();
    this.refresh();
  },
  drawAttributes() {
    const item = this.item(), c = this.cfg();
    if (!UI.attrRows) return;
    UI.attrRows.replaceChildren();
    if (!this.gear(item)) { UI.attrRows.append(el('p', 'Select an item above to choose its percentages.', 'muted')); return; }
    for (const a of this.attributes(this.kind(item))) {
      const options = [[0, 'Leave alone'], ...ATTRIBUTE_STEPS.map(([value, percent]) => [value, `${percent}% or better`])];
      UI.attrRows.append(UI.select(`${ATTRIBUTE_LABEL[a.name]} (now ${this.attrPercent(this.attrValue(item, a.index))}%)`, options, () => this.attrTarget(a.name, c), v => { c.attr.targets[a.name] = Number(v); this.refresh(); }));
    }
  },
  refresh() {
    if (!UI.is('Alchemy') || !UI.alchemyNote) return;
    const item = this.item(), r = this.result, c = this.cfg();
    const fmt = n => !Number.isFinite(n) ? 'a huge number of' : n < 100 ? n.toFixed(n < 10 ? 1 : 0) : n < 1e6 ? Math.round(n).toLocaleString('en-US') : n.toExponential(1);
    const attributes = item && this.gear(item) ? '\nStones on the item: ' + Object.entries(STONES).map(([kind, s]) => {
      const have = this.attributesKnown(item) ? this.attributeCount(item, s.option) : '?', bag = World.items().filter(i => i.refObjId === s.base + this.degree(item) - 1 && i.quantity > 0).reduce((n, i) => n + i.quantity, 0);
      return `${s.label} ${have}/${STONE_MAX} (${bag} in bag)`;
    }).join(' · ') : '';
    const odds = item && this.gear(item) ? this.odds(item, c) : null;
    const chance = odds ? `\nNext attempt at +${item.plus}: ${odds.now}% to succeed.` + (odds.plan ? ` To reach +${odds.target} expect about ${fmt(odds.plan.attempts)} elixirs; the chance of getting there without a single failure is ${(odds.plan.clean * 100).toFixed(odds.plan.clean < .1 ? 2 : 0)}%.` : '') : '';
    const kind = this.kind(item) || 'weapon';
    const used = this.wanted(c).map(k => `${STONES[k].label} from +${this.from(k, c)} (keep ${this.keep(k, c)})`);
    const helpers = '\nStones while enhancing: ' + (used.length ? used.join(' · ') : 'none ticked, so none are fused. Tick Use Luck, Steady, Immortal or Astral below.');
    UI.alchemyNote.textContent = this.message + attributes + chance + helpers +
      `\nElixirs available: ${World.items().filter(i => this.elixir(i, kind) && (!c.elixir || i.refObjId === c.elixir)).reduce((n, i) => n + i.quantity, 0)}` +
      (c.powder ? ` · Matching powder: ${World.items().filter(i => this.powderDegree(i) === this.degree(item) && this.degree(item) > 0).reduce((n, i) => n + i.quantity, 0)}` : '');
    if (UI.alchemyStats) {
      UI.alchemyStats.textContent = r
        ? `Attempts ${r.attempts} · Success ${r.successes} · Failed ${r.failures} · Destroyed ${r.destroyed || 0} · Highest + ${r.highest ?? 0}` + (r.attempts ? ` · Success rate ${Math.round(r.successes / r.attempts * 100)}%` : '') +
          `\nUsed: elixirs ${r.elixirs} · powder ${r.powders} · attribute stones ${r.attrFused || 0} · stones ${Object.entries(STONES).map(([k, s]) => `${s.label} ${r.stonesUsed?.[k] || 0}`).join(' / ')}`
        : 'No results yet.';
      UI.alchemyLog.textContent = this.log.slice(-12).map(l => new Date(l.at).toLocaleTimeString('en-GB') + '  ' + l.text).join('\n');
    }
    // The attribute rows show the item's current percentages, so they are rebuilt when its stats change.
    const attrKey = item ? JSON.stringify([item.slot, item.refObjId, item.variance]) : '';
    if (UI.attrRows && UI.attrRows.dataset.key !== attrKey) { UI.attrRows.dataset.key = attrKey; this.drawAttributes(); }
    if (UI.attrNote) {
      const wanted = item && this.gear(item) ? this.attributes(this.kind(item)).filter(a => this.attrTarget(a.name, c)) : [];
      UI.attrNote.textContent = wanted.length ? 'Aiming for: ' + wanted.map(a => `${ATTRIBUTE_LABEL[a.name]} ${this.attrPercent(this.attrTarget(a.name, c))}%+ (about ${Math.round(this.attrExpected(this.attrTarget(a.name, c)))} stones)`).join(' · ') : '';
    }
    const key = item ? item.refObjId + ':' + item.plus + ':' + item.slot : '';
    if (UI.alchemyPreview.dataset.item !== key) {
      UI.alchemyPreview.dataset.item = key; UI.alchemyPreview.replaceChildren();
      if (this.gear(item)) {
        const icon = el('span', '', 'skill-icon'); Icons.paint(icon, item.icon || Items.iconDdj(item.refObjId));
        UI.alchemyPreview.append(icon, el('span', (item.name || Items.name(item.refObjId)) + ' +' + item.plus + (this.degree(item) ? ' · Degree ' + this.degree(item) : '')));
      }
    }
  },
};


const RELEASE_NOTES = [{"version": "1.4.3", "title": "Relay hosting: the administrator's choice; auto stall", "items": ["The relay can now run in three places with the same protocol: Cloudflare Workers (new edition under relay/cloudflare: Durable Objects, WebSocket hibernation, storage that survives restarts, zero administration), fly.io (the Node relay as-is with a Dockerfile), or your own VPS (systemd unit included).", "The bot now sends the room key in the WebSocket URL (?key=…) for hosts that route by it; the Node relay ignores it, so all three hosts work with one address format.", "relay/smoke-test.cjs can verify a live deployment: WS_URL=wss://your-relay/ws node smoke-test.cjs.", "Auto stall: price items on a new page, stand in town, and the character opens its own street stall, offers them, and runs it; a sale is confirmed by the offer disappearing and gold rising, never by a dispatch. Hunting refuses to start while a stall session runs."], "note": "Both parts are tested in simulation (464 tests). The Workers edition follows the documented Durable Objects patterns but has only been syntax-checked and reviewed, not deployed — run its smoke test after wrangler deploy. Neither has run with real characters."}, {"version": "1.4.2", "title": "Coherence fixes for the team layer", "items": ["A unique's death reported by a teammate is recorded quietly; it used to be re-announced, which echoed between clients forever.", "A teammate's store write no longer cancels the sync this client still owes the room (a pending local sighting could be lost until the next change).", "Moving the hunting spot from the tracker cancels any automatic unique converge, so its later restore cannot overwrite the manual spot.", "Shared live intel is cleared when the character changes; the \"Hunt here\" button still works the same."], "note": "Found by re-reading the code with two clients in mind; tested in simulation, not yet with real characters."}, {"version": "1.4.1", "title": "Team edition rounded out", "items": ["Optional unique converge: when a unique appears and its position is known, a hunting character moves its hunting spot there (toasts say so); the saved spot comes back when the unique dies or after 20 minutes. Off by default.", "The public pool grows a memory: with public sharing on, the unique tracker also reads and writes the relay's public store, so every room keeps the spawn history.", "Bug reports now include a team summary line (shared entities, combat edges, tracked uniques, known players).", "The repository README describes this fork's team edition."], "note": "Still simulation-tested only; no live run with real characters yet."}, {"version": "1.4.0", "title": "Team edition complete (phases 2-6)", "items": ["Live shared world: each character publishes the interesting monsters it sees (champion and up, party mobs, uniques with an HP estimate), the other players in view, and who attacks what (observed from every cast around); the map draws it all as a dimmed team layer, own view always winning.", "Unique tracker: the game's own server-wide announcements plus shared sightings build a history per unique with respawn windows (the timer restarts at death; 3-6 h per unique), toasts, a sound, map pins, and a Hunt here button that moves your hunting spot to the last known position.", "Player knowledge: every player the team sees is remembered with position and level; a player attacking a teammate outside a party is marked hostile (red on the map, flagged in the panel).", "Team drops: the room shares pickup counters.", "Team decisions: assist (fight what a teammate or party member fights), spot claims (a warning when two characters start hunting on top of each other), synchronized town trips (optional; a teammate's town trip starts yours), and resurrection claims (the dead member waits up to 60 s for the peer walking over instead of reviving itself).", "The room key holders always see everything; an optional public pool (per-relay, per-category checkboxes) shares monsters, players and unique events with every room on your relay — never your own position or inventory.", "The reference relay grows a room key-value store (the team's shared memory, persisted across restarts) and a console page (/?key=room key) showing the fleet with Stop everyone and Town trip buttons."], "note": "All of it is tested in simulation and against a local relay only; a live check with real characters is still to do."}, {"version": "1.3.0", "title": "Team relay (phase 1: presence)", "items": ["New Team page: connect several characters through your own WebSocket relay; while it runs, each character sees the others' presence (name, hunting, alive, level) in the panel.", "A reference relay server (rooms by room key, presence forwarding, no game logic) is included under relay/ in the repository.", "Presence is private to one room key; nothing is shared beyond it. The bot never depends on the relay: off or unreachable, everything else works exactly as before."], "note": "Presence, heartbeats and reconnection are tested in simulation only; a live relay check is still to do."}, {"version": "1.2.128", "title": "Town trips no longer stop on an item the merchant won't buy", "items": ["A town trip could stop at the weapon merchant with \"Inventory rejected: 2\". The bot had tried to sell an item the game does not allow merchants to buy (quest and event items, for example), and one refusal ended the whole trip.", "Items the game marks unsellable are now never offered, even with a Sell rule. They stay in the pet or bag.", "If the merchant still refuses an item, the bot keeps it, logs a warning and sells the rest, then carries on with the trip.", "Written from the code and simulated game state; not yet seen on a live server."]}, {"version": "1.2.127", "title": "Bag selling no longer stops on a full bag", "items": ["With **Sell items from the character bag too** on, a town trip with a completely full bag stopped before it ever reached the merchant that sells: at arrival (\"free a character bag slot\"), or at the potion merchant (no room for potions).", "Now, with that switch on, the trip goes to the repair merchant first (sell, ammunition, repair), then the potion merchant, then the world statue. A full bag is emptied before potions are bought. With the switch off, the order is unchanged.", "Written from the code and simulated game state; not yet seen on a live server."]}, {"version": "1.2.126", "title": "Sell from the character bag on town trips", "items": ["New switch in Scroll town cycle: **Sell items from the character bag too**. When on, the town trip sells unprotected items from your own bag at the repair merchant, after the pet loot, by the same rules as pet loot. Off by default.", "Never sold from the bag: potions, scrolls, supplies, Keep names, buff-set gear, the alchemy weapon, and anything with a Store, Keep or Drop rule. A Sell rule always sells.", "Tested in simulation only; not yet confirmed on the live server."]}];

// Check trusted repository metadata; never execute downloaded update code.
const Updates = {
  latest: null, busy: false, started: false,
  // Is version a newer x.y.z than base (VERSION by default)? Anything that is not a version is never newer.
  newer(version, base = VERSION) {
    const valid = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) && v.split('.').map(Number).every(Number.isSafeInteger);
    if (!valid(version) || !valid(base)) return false;
    const current = base.split('.').map(Number), candidate = version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (candidate[i] !== current[i]) return candidate[i] > current[i];
    }
    return false;
  },
  async check() {
    if (this.busy) return;
    this.busy = true;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
    try {
      const options = { signal: abort.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
      const response = await W.fetch('https://api.github.com/repos/nixxane/opensro-bot-lean/commits/main', options);
      if (!response.ok) return;
      const { sha } = await response.json();
      if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return;
      const base = 'https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + sha + '/bot.lean.';
      const metadata = await W.fetch(base + 'meta.js', options);
      if (!metadata.ok) return;
      const match = (await metadata.text()).match(/^\/\/ @version\s+(\d+\.\d+\.\d+)\s*$/m);
      if (match && this.newer(match[1])) {
        const version = match[1], known = this.latest?.version === version ? this.latest.title : '';
        this.latest = { version, url: base + 'user.js', title: known || await this.headline(sha, version, options) };
      } else if (match) this.latest = null;
    } catch {
      // Offline, rate limits and blocked requests are silent; try next interval.
    } finally {
      clearTimeout(timer); this.busy = false; this.render();
    }
  },
  // The headline of the new version's patch notes (notes/<version>.md at the same commit), so a player sees why
  // to update. Shown as plain text only; a missing or odd file just leaves the plain Update button.
  async headline(sha, version, options) {
    try {
      const response = await W.fetch('https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + sha + '/notes/' + version + '.md', options);
      if (!response.ok) return '';
      const title = String(await response.text()).slice(0, 8192).match(/^# (.+)$/m)?.[1] || '';
      // Control and line-separator characters are dropped: the headline is one line of plain text.
      const plain = [...title].filter(c => { const n = c.codePointAt(0); return n >= 32 && (n < 127 || n >= 160) && n !== 8232 && n !== 8233; });
      return plain.join('').trim().slice(0, 120);
    } catch {
      return '';
    }
  },
  render() {
    if (!UI.updateButton) return;
    const latest = this.latest;
    UI.updateButton.hidden = !latest;
    UI.updateButton.textContent = latest ? 'Update ' + latest.version : 'Update';
    UI.updateButton.title = (latest?.title ? latest.version + ': ' + latest.title + ' · ' : '') + 'Open Tampermonkey to install, then reload the game when ready.';
    if (!UI.updateNote) return;
    UI.updateNote.hidden = !latest?.title;
    UI.updateNote.textContent = latest?.title ? 'Update ' + latest.version + ' available: ' + latest.title : '';
  },
  open() {
    if (this.latest) W.open(this.latest.url, '_blank', 'noopener,noreferrer');
  },
  // The built-in notes (newest first) of the versions after `seen`, up to this one. Without a usable `seen`
  // (an install older than the once-per-version notice), only this version's notes.
  notesSince(seen) {
    const known = typeof seen === 'string' && /^\d+\.\d+\.\d+$/.test(seen);
    return RELEASE_NOTES.filter(n => !this.newer(n.version) && (known ? this.newer(n.version, seen) : n.version === VERSION));
  },
  // Once per installed version: a new install is welcomed, an update opens its patch notes beside the panel.
  announce() {
    const seen = Store.get('seenVersion', null);
    if (seen === VERSION) return false;
    Store.set('seenVersion', VERSION);
    if (!seen && !Store.get('profile:default', null)) {
      UI.toast('Welcome! Updates, suggestions and bug reports are on Discord: use the Discord button at the top of the panel.', 'info', 12000);
      return true;
    }
    const notes = this.notesSince(seen);
    const title = notes.length > 1 && seen ? 'What changed since ' + seen : 'What’s new in ' + VERSION;
    if (!notes.length || !UI.showNotes(notes, title)) UI.toast(`Updated to ${VERSION}. Patch notes are on Discord: use the Discord button at the top of the panel.`, 'info', 12000);
    return true;
  },
  start() {
    if (this.started) return;
    this.started = true;
    setTimeout(() => this.announce(), 5000);
    void this.check();
    setInterval(() => { void this.check(); }, 15 * 60 * 1000);
  },
};


// Explicit report fields only: never export raw logs, profiles or game snapshots.
const Diagnostics = {
  history: [], errors: [], last: '', started: false,
  number(value) { return Number.isFinite(value) ? value : null; },
  errorCode(message) {
    const text = String(message || '');
    for (const [pattern, code] of [
      [/Stale party join answer/i, 'stale-party-answer'],
      [/party matching.*pending/i, 'party-matching-pending'],
      [/(inventory|transaction).*pending|inventory.*busy/i, 'inventory-busy'],
      [/(bag|inventory).*(full|space|capacity)/i, 'bag-capacity'],
      [/COS ground|cos.pickup|pickup/i, 'pickup-error'],
      [/gold|money/i, 'insufficient-gold-or-payment'],
      [/timeout|timed out/i, 'timeout'],
      [/scroll|return|travel/i, 'travel-error'],
    ]) if (pattern.test(text)) return code;
    return 'unclassified-error';
  },
  start() {
    if (this.started) return;
    this.started = true;
    bus.on('game-error', text => this.error(text));
    bus.on('log', entry => { if (entry.level === 'error' || entry.level === 'warn') this.error(entry.text); });
  },
  error(text) {
    const code = this.errorCode(text), previous = this.errors[this.errors.length - 1];
    if (previous?.code === code && now() - previous.at < 1000) return;
    this.errors.push({ at: now(), code });
    if (this.errors.length > 12) this.errors.shift();
  },
  party() {
    const c = Settings.profile.party, m = World.gp?.partyMatching, s = World.gp?.social;
    if (!c.autoRecruit && !c.autoAcceptMatching) return 'Party automation off.';
    if (!World.inWorld() || !m || !s || !Array.isArray(s.members)) return 'Party: waiting for game state.';
    if (!m.request) return m.own ? 'Party: waiting for applicants.' : c.autoRecruit ? 'Party: waiting for listing registration.' : 'Party: listing missing.';
    if (s.leader && (!s.self || s.self !== s.leader) || !s.leader && s.members.length) return 'Party join blocked: you are not the leader.';
    const options = Party.options(m, s);
    if (!Number.isInteger(options)) return 'Party join blocked: sharing options unknown.';
    if (s.members.length >= ((options & 1) ? 8 : 4)) return 'Party join blocked: party full.';
    const sim = World.simNow(), r = m.request;
    if (!Number.isFinite(sim) || !Number.isFinite(r.expires)) return 'Party join blocked: clock or deadline unknown.';
    if (sim >= r.expires) return 'Party join blocked: request expired.';
    if (![r.a, r.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return 'Party join blocked: invalid request.';
    if (Party.answered === `${r.a}:${r.b}:${r.expires}`) return 'Party: acceptance sent; waiting for confirmation.';
    return 'Party: application ready for acceptance.';
  },
  pet() {
    if (!Hunt.cfg().pickup.enabled || !Loot.petMode()) return '';
    if (!Hunt.running) return 'Pet collection paused: bot stopped.';
    const pet = Loot.pet();
    if (!pet) return 'Pet waiting: summon a pickup pet.';
    if (!Number.isInteger(pet.rec.commandMode)) return 'Pet waiting for settings.';
    if (pet.rec.commandMode & 128) return 'Pet waiting for broad auto-grab to turn off.';
    if (World.gp?.inventoryPending) return 'Pet waiting for inventory transaction.';
    if (Loot.pressed()) return 'Pet waiting briefly for potion use.';
    if (Loot.active?.petGid) return Loot.active.retryAt ? 'Pet pickup: retry pending.' : 'Pet pickup: waiting for collection confirmation.';
    if (pet.rec.inventory.length >= pet.rec.status) return 'Pet bag full; only compatible stacks can merge.';
    return 'Pet ready; waiting for eligible drops. ' + this.noLoot();
  },
  // Why nothing is being collected, counted from the drops in view. Counts only, no item names.
  noLoot() {
    const why = { failed: 0, far: 0, area: 0, owner: 0, filter: 0, pet: 0, petFar: 0, full: 0 }, unwanted = {};
    let seen = 0, ready = 0;
    if (!World.pose()) return '';
    for (const e of World.ents.values()) {
      if (e.kind !== 'ground-item') continue;
      seen++;
      const reason = Loot.whyNot(e);
      if (reason) { why[reason]++; if (reason === 'filter') { const k = Loot.filterWhy(e), u = unwanted[k] ||= { n: 0, ids: new Set() }; u.n++; u.ids.add(e.refObjId); } } else ready++;
    }
    if (!seen) return 'No drops in view.';
    const parts = [
      [why.filter, 'not wanted by your Loot settings (' + Object.entries(unwanted).sort((a, b) => b[1].n - a[1].n).map(([k, u]) => `${u.n} ${Loot.filterLabel(k)}` + (u.ids.size <= 3 ? ' #' + [...u.ids].join(' #') : '')).join(', ') + ')'],
      [why.far, 'too far from you (Pickup radius)'],
      [why.area, 'outside the hunting area'],
      [why.owner, 'it belongs to another player'],
      [why.petFar, 'too far from the pet'],
      [why.pet, 'the pet is not ready'],
      [why.full, 'no room in the bag'],
      [why.failed, 'recently failed'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Drops in view: ${seen}, ready to collect: ${ready}.` + (parts.length ? ` Not collected: ${parts.join('; ')}.` : '');
  },
  town() {
    if (!Town.cfg().enabled) return '';
    if (Town.trip) return '';
    if (!Hunt.running) return '';
    const blocked = Town.blocked();
    if (blocked) return 'Town return blocked: ' + blocked + '.';
    const c = Town.cfg();
    if (['arrival', 'vendor', 'smith', 'gate', ...(c.petFull ? ['storage'] : [])].some(role => !c[role])) return 'Town return blocked: save missing service points in Supplies.';
    if (!Town.scroll(0x09ec)) return 'Town return blocked: return scroll missing.';
    if (!Town.scroll(0x19ec)) return 'Town return blocked: reverse scroll missing.';
    if (Town.validate()) return 'Town return blocked: check refill targets, low-stock thresholds and gold.';
    return Town.reason() ? 'Town return: preparing departure.' : '';
  },
  // What the town trip is doing right now, in plain words (no names): the phase text it shows on the panel.
  townDetail() { return Town.trip ? String(Town.message || '').slice(0, 200) : ''; },
  // Why the current or last town trip started, with no item names, and how long ago.
  townReason() {
    const t = Town.trip ? { why: Town.trip.why, at: Town.trip.started } : Town.lastTrip;
    return t ? String(t.why || '').replace(/\s*\(.*\)/, '') + ' (' + Math.round((now() - t.at) / 1000) + ' s ago)' : '';
  },
  // Why no monster is being attacked, counted from the monsters in view with the same checks the hunt uses.
  // Counts only, no names. Short plain sentences, because the panel and bug reports are read by many languages.
  noTarget() {
    const H = Hunt.cfg(), pose = World.pose();
    if (!pose) return '';
    const sim = World.simNow() ?? 0, include = splitList(H.include), exclude = splitList(H.exclude);
    const why = { banned: 0, kind: 0, level: 0, name: 0, far: 0, others: 0 };
    let seen = 0;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e)) continue;
      seen++;
      const name = (e.name || '').toLowerCase(), level = e.level ?? 0;
      if (Hunt.banned(Hunt.ban, e.gid)) why.banned++;
      else if (!Hunt.classAllowed(e)) why.kind++;
      else if (H.levelMin && level < H.levelMin || H.levelMax && level > H.levelMax) why.level++;
      else if (include.length && !include.some(s => name.includes(s)) || exclude.some(s => name.includes(s))) why.name++;
      else if (!Hunt.inArea(e) || dist2D(pose, e) > H.chase) why.far++;
      else if (H.avoidKs && sim - (World.hitByOthers.get(e.gid) ?? -Infinity) < 8000 && sim - (World.hitByUs.get(e.gid) ?? -Infinity) > 8000) why.others++;
    }
    if (!seen) return 'No monsters in view. Move to a place with monsters and press "Set hunting spot here".';
    const parts = [
      [why.kind, 'monster type is switched off (Combat > Hunt area > Monster classes)'],
      [why.level, 'level is outside your minimum or maximum level'],
      [why.name, 'name is not in "Only these mobs" or is in "Skip these mobs"'],
      [why.far, 'too far (Hunt radius or Chase distance)'],
      [why.others, 'another player is fighting it'],
      [why.banned, 'recently given up (blocked or cannot be selected)'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Monsters in view: ${seen}. Skipped: ${parts.join('; ') || 'none'}.`;
  },
  main() {
    if (Trap.run) return Trap.message;
    if (Chase.owns()) return Chase.message || 'Checking obstacle approach.';
    if (BuffGear.run) return BuffGear.run.restoring ? 'Buff gear: restoring combat equipment.' : 'Buff gear: swapping or casting.';
    if (BuffGear.recovery) return 'Buff gear: manual equipment review needed.';
    if (Alchemy.pending) return Alchemy.run ? 'Alchemy: waiting for the server result.' : 'Alchemy stopped; outstanding result unconfirmed.';
    if (Alchemy.run) return 'Alchemy: preparing the next attempt.';
    if (Reconnect.active() && Reconnect.message && !World.inWorld()) return Reconnect.message;
    if (!World.inWorld()) return 'Waiting for game world.';
    if (World.isDead()) return 'Character dead; waiting for recovery.';
    if (Town.trip) {
      if (Town.trip.phase === 'buy') return Town.trip.supplies.map(s => `Refilling ${s.kind === 'hp' ? 'HP' : s.kind === 'mp' ? 'MP' : 'abnormal pills'}: ${Restock.count(s.refObjId)} / ${s.target}`).join(' · ');
      if (World.gp?.inventoryPending) return 'Town services: waiting for inventory transaction.';
      const phases = { recall: 'stopping combat for recall', 'recall-wait': 'waiting for recall arrival', 'reverse-wait': 'waiting for reverse arrival', 'revive-arrival': 'waiting for town revival', store: 'depositing loot', sell: 'selling pet loot', ammo: 'buying ammunition', repair: 'repairing equipment', reverse: 'opening reverse return' };
      if (/^(walk|open)-/.test(Town.trip.phase) && Town.message) return Town.message;
      return 'Town services: ' + (phases[Town.trip.phase] || 'travelling between or opening services') + '.';
    }
    if (WalkBack.active) return WalkBack.status();
    if (Restock.trip || Resurrect.trip) return 'Travelling; waiting to reach the destination.';
    if (!Hunt.running) return 'Bot stopped.';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'Hunting paused after manual control.';
    if (Restock.activeShop() || World.gp?.storage) return 'Hunting paused: close shop or storage.';
    if (Hunt.state === 'resting' || Hunt.state === 'standing') return 'Recovering HP / MP.';
    if (Hunt.state === 'player') return 'Hunting paused by nearby-player setting.';
    if (Hunt.state === 'loot') return 'Character collecting; waiting for pickup confirmation.';
    if (Hunt.threatNote && Hunt.threatNote.gid === Hunt.targetGid) return Hunt.threatNote.text;
    if (World.isCasting()) return 'Combat: waiting for the current cast.';
    if (Hunt.state === 'fight' && Combat.fallbackNote()) return 'Combat: normal attack (' + Combat.fallbackNote() + ').';
    if (Hunt.targetGid) return 'Combat: approaching or attacking the target.';
    return 'Hunting: searching for an eligible target. ' + this.noTarget();
  },
  snapshot() {
    const gp = World.gp, c = Settings.profile, pet = Loot.pet(), social = gp?.social, matching = gp?.partyMatching;
    return {
      action: this.main(), partyStatus: this.party(), teamStatus: Settings.profile.team?.enabled ? Team.status() : '',
      teamDetail: Settings.profile.team?.enabled ? TeamIntel.rows().length + ' shared entities, ' + TeamIntel.edges.size + ' combat edges, ' + TeamKnowledge.uniques.size + ' tracked uniques, ' + TeamKnowledge.players.size + ' known players' : '', petStatus: this.pet(), townStatus: this.town(), townDetail: this.townDetail(), townReason: this.townReason(),
      navigationReady: !!Navigation.scene, navigationError: String(Navigation.error || '').slice(0, 80),
      buffGearStatus: BuffGear.cfg().buffSwap ? String(BuffGear.status()).slice(0, 600) : '', buffGearActive: !!BuffGear.run, buffGearRestoring: !!BuffGear.run?.restoring, buffGearMovePending: !!BuffGear.run?.pending, buffGearRecovery: !!BuffGear.recovery,
      alchemyActive: !!Alchemy.run, alchemyPending: !!Alchemy.pending, alchemyAttempts: this.number(Alchemy.result?.attempts),
      alchemyTarget: this.number(Alchemy.run?.cfg.target), alchemySuccesses: this.number(Alchemy.result?.successes),
      alchemyFailures: this.number(Alchemy.result?.failures), alchemyElixirsUsed: this.number(Alchemy.result?.elixirs),
      alchemyPowdersUsed: this.number(Alchemy.result?.powders), alchemyResultFlags: this.number(gp?.alchemy?.flags),
      alchemyError: this.number(gp?.alchemy?.error), alchemyWindowVisible: !!gp?.alchemy?.visible,
      nativeAlchemyPending: !!gp?.alchemy?.pending,
      nativeAlchemyMode: ['reinforce', 'attribute', 'magic', 'compound', 'advanced', 'dissolve'].includes(gp?.alchemy?.mode) ? gp.alchemy.mode : null,
      movementPending: !!gp?.pendingMoves, returnScrollActive: !!gp?.returnScroll,
      running: !!Hunt.running, inWorld: World.inWorld(), dead: World.isDead(),
      inventoryPending: !!gp?.inventoryPending, casting: World.isCasting(),
      curePills: Restock.count(58), freeBagSlots: this.number(World.freeBagSlots()), hpPotions: Potion.count('hp'), mpPotions: Potion.count('mp'),
      petFreeSlots: pet ? this.number(pet.rec.status - pet.rec.inventory.length) : null,
      pickupPending: !!Loot.active, pickupRetry: !!Loot.active?.retryAt, pickupAttempts: this.number(Loot.active?.attempts),
      petSetupAttempts: this.number(Loot.petSetup?.attempts), speedScrollPending: !!SpeedScroll.pending,
      speedScrollAttempts: this.number(SpeedScroll.attempts),
      partyMembers: this.number(social?.members?.length), partyOptions: this.number(social?.options),
      partyLeader: !!social?.self && social.self === social.leader, ownListing: !!matching?.own,
      matchingStateKnown: !!matching, simulationClockKnown: Number.isFinite(World.simNow()),
      matchingPending: ['page', 'join', 'register', 'modify', 'delete'].includes(matching?.pending) ? matching.pending : null,
      matchingResult: this.number(matching?.result), registrationPending: !!Party.registration,
      joinRequest: !!matching?.request, acceptanceSent: !!matching?.request && Party.answered === `${matching.request.a}:${matching.request.b}:${matching.request.expires}`,
      requestRemainingMs: Number.isFinite(World.simNow()) && Number.isFinite(matching?.request?.expires) ? Math.max(0, matching.request.expires - World.simNow()) : null,
      townActive: !!Town.trip,
      townPhase: ['recall', 'recall-wait', 'revive-arrival', 'walk-storage', 'open-storage', 'store', 'close-storage', 'walk-vendor', 'open-vendor', 'buy', 'close-vendor', 'walk-smith', 'open-smith', 'sell', 'repair', 'close-smith', 'walk-gate', 'open-gate', 'reverse', 'reverse-wait'].includes(Town.trip?.phase) ? Town.trip.phase : null,
      scrollAttempts: this.number(Town.trip?.scrollAttempts), scrollAccepted: !!Town.trip?.scrollRequest?.accepted,
      returnScroll: !!Town.scroll(0x09ec), reverseScroll: !!Town.scroll(0x19ec),
      settings: { autoRecruit: !!c.party.autoRecruit, autoAccept: !!c.party.autoAcceptMatching,
        townCycle: !!Town.cfg().enabled, revive: !!Town.cfg().revive, petFullReturn: !!Town.cfg().petFull,
        walkingRestock: !!Restock.cfg().enabled, buyHP: !!Restock.cfg().hp.on, buyMP: !!Restock.cfg().mp.on,
        hpTarget: this.number(Restock.cfg().hp.target), mpTarget: this.number(Restock.cfg().mp.target),
        buyCure: !!Restock.cfg().cure.on, cureTarget: this.number(Restock.cfg().cure.target), cureLow: this.number(Restock.cfg().cure.low),
        hpLow: this.number(Restock.cfg().hp.low), mpLow: this.number(Restock.cfg().mp.low),
        collectDrops: !!c.hunt.pickup.enabled, petCollector: Loot.petMode(), follow: Settings.profile.trace.enabled ? Trace.code : '', autoStatPoints: Settings.profile.statPoints.enabled ? String(StatPoints.status()).slice(0, 200) : '', autoMastery: AutoMastery.active() ? String(AutoMastery.message).slice(0, 600) : '', trapStage: Trap.stage, trapTile: Trap.stage ? Trap.tile : '', characterCollects: Loot.categories.some(k => c.hunt.pickup[k] && Loot.collectorFor(k) === 'character'), pickupRadius: this.number(c.hunt.pickup.radius / 10),
        finishFight: !!c.hunt.pickup.afterKillOnly, speedScroll: !!c.potion.speedScroll }
    };
  },
  sample() {
    try {
      const state = this.snapshot();
      // Deadline countdown alone is not a new state transition.
      const key = JSON.stringify({ ...state, requestRemainingMs: null });
      if (key !== this.last) { this.last = key; this.history.push({ at: now(), state }); }
      if (this.history.length > 30) this.history.shift();
      return state;
    } catch { return { action: 'Waiting for complete game state.' }; }
  },
  lines(state) {
    return [state.action, Settings.profile.party.autoRecruit || Settings.profile.party.autoAcceptMatching ? state.partyStatus : '', state.petStatus,
      state.townStatus].filter(Boolean).join('\n');
  },
  report() {
    const current = this.sample(), relative = entries => entries.map(({ at, ...entry }) => ({ secondsAgo: Math.max(0, Math.round((now() - at) / 1000)), ...entry }));
    return JSON.stringify({ app: 'nixxane bot', version: VERSION,
      privacy: 'Names, chat, account details, locations and raw logs are omitted. Error categories replace original messages.',
      current, recentStates: relative(this.history), recentErrors: relative(this.errors) }, null, 2);
  },
  async copy() {
    const text = this.report();
    try {
      await W.navigator.clipboard.writeText(text);
      UI.toast('Copied—paste this into your bug report.');
    } catch { UI.showDiagnostics(text); }
  },
};


// Manual reports only. No startup requests, saved drafts, or automatic retries.
const Reports = {
  endpoint: 'https://nixbot.nixxane.workers.dev/report',
  draft: null, sending: false, capturing: false, stream: null, cooldownUntil: 0,
  open() {
    if (this.sending || this.capturing) return;
    if (!this.draft) this.draft = { base: JSON.parse(Diagnostics.report()), description: '', image: null, url: '', sent: false };
    UI.showReport();
    this.render();
  },
  text() {
    if (!this.draft) return '';
    return JSON.stringify({ ...this.draft.base, ...(this.draft.description ? { description: this.draft.description } : {}) }, null, 2);
  },
  describe(value) {
    if (!this.draft || this.sending || this.draft.sent) return;
    this.draft.description = String(value).slice(0, 1000);
    this.render();
  },
  notice(text) { if (UI.reportStatus) UI.reportStatus.textContent = text; },
  render() {
    if (!UI.reportBox || !this.draft) return;
    UI.reportText.value = this.text();
    UI.reportDescription.disabled = this.sending || this.draft.sent;
    UI.reportCapture.disabled = this.sending || this.capturing || this.draft.sent;
    UI.reportRemove.disabled = this.sending || this.capturing || !this.draft.image || this.draft.sent;
    UI.reportSend.disabled = this.sending || this.capturing || this.draft.sent || now() < this.cooldownUntil;
    UI.reportSend.textContent = this.sending ? 'Sending…' : this.draft.sent ? 'Report sent' : now() < this.cooldownUntil ? 'Wait ' + Math.ceil((this.cooldownUntil - now()) / 1000) + 's' : 'Send to developer';
    UI.reportClose.disabled = this.sending;
    UI.reportImage.hidden = !this.draft.url;
    if (this.draft.url) UI.reportImage.src = this.draft.url;
    else UI.reportImage.removeAttribute('src');
  },
  removeImage() {
    if (!this.draft || this.sending || this.draft.sent) return;
    if (this.draft.url) URL.revokeObjectURL(this.draft.url);
    this.draft.image = null; this.draft.url = '';
    this.render();
  },
  close() {
    if (this.sending) return;
    if (this.draft?.url) URL.revokeObjectURL(this.draft.url);
    this.draft = null;
    this.stream?.getTracks().forEach(track => track.stop());
    if (UI.reportImage) UI.reportImage.removeAttribute('src');
    if (UI.reportText) UI.reportText.value = '';
    if (UI.reportDescription) UI.reportDescription.value = '';
    if (UI.reportBox) UI.reportBox.hidden = true;
  },
  async frame(stream) {
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    let timer, frameId;
    try {
      const blob = await Promise.race([
        (async () => {
          await video.play();
          if (video.requestVideoFrameCallback) await new Promise(resolve => { frameId = video.requestVideoFrameCallback(resolve); });
          if (!video.videoWidth || !video.videoHeight) throw Error('empty frame');
          const scale = Math.min(1, 1280 / video.videoWidth, 1280 / video.videoHeight);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('capture timeout')), 10000); })
      ]);
      if (!blob || !['image/jpeg', 'image/png'].includes(blob.type) || blob.size > 2 * 1024 * 1024 || !blob.size) throw Error('invalid capture');
      return blob;
    } finally {
      clearTimeout(timer);
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      video.pause(); video.srcObject = null;
    }
  },
  async capture() {
    if (!this.draft || this.sending || this.capturing || this.draft.sent) return;
    if (!W.navigator?.mediaDevices?.getDisplayMedia) { this.notice('Screenshot capture is unavailable in this browser. You can send diagnostics alone.'); return; }
    const draft = this.draft;
    let stream;
    this.capturing = true; this.render();
    this.notice('Choose the game tab or window in the browser picker.');
    try {
      // Invoked directly from a click; every capture asks for fresh browser permission.
      stream = await W.navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
      if (this.draft !== draft) return;
      this.stream = stream;
      const image = await this.frame(stream);
      if (this.draft !== draft) return;
      this.removeImage();
      draft.image = image; draft.url = URL.createObjectURL(image);
      this.notice('Screenshot captured. Review it below; remove it if it shows anything private.');
    } catch {
      if (this.draft === draft) this.notice('Screenshot cancelled or unavailable. Nothing was uploaded; diagnostics can still be sent.');
    } finally {
      stream?.getTracks().forEach(track => track.stop());
      if (this.stream === stream) this.stream = null;
      this.capturing = false; this.render();
    }
  },
  async send() {
    if (!this.draft || this.sending || this.capturing || this.draft.sent || now() < this.cooldownUntil) return;
    const text = this.text();
    if (new Blob([text]).size > 128 * 1024) { this.notice('Report is too large. Remove the screenshot or shorten the explanation.'); return; }
    const body = new FormData(); body.append('report', text);
    if (this.draft.image) body.append('screenshot', this.draft.image, this.draft.image.type === 'image/png' ? 'screenshot.png' : 'screenshot.jpg');
    this.sending = true; this.render(); this.notice('Sending report…');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await W.fetch(this.endpoint, { method: 'POST', body, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 429) {
        const seconds = Number(response.headers.get('Retry-After'));
        this.cooldownUntil = now() + (Number.isFinite(seconds) && seconds > 0 ? clamp(seconds, 1, 3600) : 60) * 1000;
        this.notice('Too many reports. Wait before trying again.');
      } else if (response.ok && (await response.json()).ok === true) {
        this.draft.sent = true;
        if (this.draft.url) URL.revokeObjectURL(this.draft.url);
        this.draft.image = null; this.draft.url = '';
        this.notice('Report sent to the developer’s Discord. Thank you.');
      } else if (response.status === 400 || response.status === 413) {
        this.notice('Report rejected. Remove the screenshot and try again.');
      } else if (response.status === 403 || response.status === 503) {
        this.notice('Reporting is unavailable right now. Try again later.');
      } else {
        this.notice('Delivery could not be confirmed. Check with the developer before sending again.');
      }
    } catch {
      this.notice('Delivery could not be confirmed. Check with the developer before sending again.');
    } finally {
      clearTimeout(timer); this.sending = false; this.render();
    }
  },
};


// Item rules: what to do with each item of the game's catalogue, like sBot's item list.
// A rule is per exact item (refObjId) and per character: pick (always / never) and one action (store in the warehouse,
// sell at the repair merchant, keep, or drop). Rules come first; without one the Loot categories and the town settings
// decide as before. Filters read the item's codename: ITEM_<race>_[<gender>_]<type>_<degree>_..., e.g.
// ITEM_CH_SWORD_09_C_RARE or ITEM_EU_W_LIGHT_05_SA_A. Armour parts follow the equipment slots in roster.json.
const ITEM_ACTIONS = ['store', 'sell', 'keep', 'drop'];
const ITEM_ARMOUR_PART = { CA: 'Head', HA: 'Head', SA: 'Shoulder', BA: 'Chest', AA: 'Hand', LA: 'Trouser', FA: 'Boot' };
const ITEM_ARMOUR_KIND = { CLOTHES: 'Garment', LIGHT: 'Protector', HEAVY: 'Armor' };
const ITEM_WEAPON = { CH: { BLADE: 'Blade', SWORD: 'Sword', TBLADE: 'Glaive', SPEAR: 'Spear', BOW: 'Bow' },
  EU: { SWORD: '1HSword', TSWORD: '2HSword', AXE: 'Axe', CROSSBOW: 'X-Bow', DAGGER: 'Dagger', TSTAFF: 'Staff', DARKSTAFF: 'W-Rod', STAFF: 'C-Rod', HARP: 'Harp' } };
const ITEM_ACCESSORY = { NECKLACE: 'Necklace', EARRING: 'Earring', RING: 'Ring' };
const ITEM_DROP_CONFIRM_MS = 5000;
const ItemRules = {
  infos: new Map(), dropping: null, dropBan: new Map(), message: '',
  cfg() { return Settings.profile.items; },
  get(id) { return this.cfg().rules[id] || null; },
  // change: { pick: 'yes' | 'no' | null, act: 'store' | 'sell' | 'keep' | 'drop' | null }; null clears that part.
  set(ids, change) {
    const rules = this.cfg().rules;
    for (const id of ids) {
      const rule = { ...rules[id] };
      for (const [key, value] of Object.entries(change)) { if (value === null) delete rule[key]; else rule[key] = value; }
      if (rule.act === 'drop') delete rule.pick; // a dropped item is never picked up again
      if (Object.keys(rule).length) rules[id] = rule; else delete rules[id];
    }
    Settings.saveProfile();
  },
  count() { return Object.keys(this.cfg().rules).length; },
  // What the codename says about an item, for the filters and the table. Cached per item.
  info(id) {
    if (this.infos.has(id)) return this.infos.get(id);
    const row = Items.data.get(id), code = row?.code || '', p = code.split('_');
    const race = p[1] === 'CH' || p[1] === 'EU' ? p[1] : '', gendered = race && (p[2] === 'M' || p[2] === 'W');
    const type = race ? p[gendered ? 3 : 2] : '', degree = race ? Number(/_(\d{2})(?:_|$)/.exec(code)?.[1]) || 0 : 0;
    let group = 'other', kind = '';
    if (race && ITEM_ARMOUR_KIND[type]) { group = 'armour'; kind = ITEM_ARMOUR_PART[p[gendered ? 5 : 4]] || ''; }
    else if (race && type === 'SHIELD') { group = 'armour'; kind = 'Shield'; }
    else if (race && ITEM_WEAPON[race][type]) { group = 'weapon'; kind = ITEM_WEAPON[race][type]; }
    else if (race && ITEM_ACCESSORY[type]) { group = 'accessory'; kind = ITEM_ACCESSORY[type]; }
    else if (/^ITEM_ETC_(HP|MP|ALL)_/.test(code)) group = 'potion';
    else if (/^ITEM_ETC_CURE_/.test(code)) group = 'pill';
    else if (/^ITEM_ETC_ARCHEMY_/.test(code)) group = 'alchemy';
    else if (/^ITEM_ETC_AMMO_/.test(code)) group = 'ammo';
    else if (/SCROLL/.test(code)) group = 'scroll';
    else if (/^ITEM_COS_/.test(code)) group = 'pet';
    else if (/^ITEM_Q/.test(code)) group = 'quest';
    else if (/^ITEM_MALL_/.test(code)) group = 'mall';
    const info = { id, name: row?.name || '#' + id, code, icon: row?.icon || '', race, degree, group, kind,
      material: race ? ITEM_ARMOUR_KIND[type] || '' : '', gender: gendered ? (p[2] === 'M' ? 'Male' : 'Female') : '', sox: Items.sox(id) };
    this.infos.set(id, info);
    return info;
  },
  // Every catalogue item that passes the filters, in id order. f: { query, group, race, gender, degrees: Set, kind, custom, nearby }.
  list(f) {
    const query = (f.query || '').toLowerCase().trim(), rules = this.cfg().rules, out = [];
    // Item numbers of the drops in view: the exact items to give a rule, whatever the item is called in the catalogue.
    const ground = f.nearby ? new Set([...World.ents.values()].filter(e => e.kind === 'ground-item').map(e => e.refObjId)) : null;
    for (const id of Items.data.keys()) {
      if (f.custom && !rules[id]) continue;
      if (ground && !ground.has(id)) continue;
      const i = this.info(id);
      if (f.group && f.group !== 'all' && (f.group === 'equipment' ? !['weapon', 'armour', 'accessory'].includes(i.group) : i.group !== f.group)) continue;
      if (f.race && i.race !== f.race) continue;
      if (f.gender && i.gender && i.gender !== f.gender) continue;
      if (f.degrees?.size && !f.degrees.has(i.degree)) continue;
      if (f.kind && i.kind !== f.kind && i.material !== f.kind) continue;
      if (query && !i.name.toLowerCase().includes(query) && !i.code.toLowerCase().includes(query) && String(id) !== query) continue;
      out.push(i);
    }
    return out.sort((a, b) => a.id - b.id);
  },
  // Drop items with a Drop rule from the character bag (never worn gear) or the pickup pet, one at a time, while
  // hunting and outside town service and open windows. A drop counts once the item has left that slot.
  dropTick() {
    const gp = World.gp;
    if (!Hunt.running || Town.trip || !World.inWorld() || World.isDead() || !gp || gp.inventoryPending || gp.storage || gp.exchange?.open || Restock.activeShop()) return false;
    const t = now(), d = this.dropping;
    if (d) {
      const still = (d.pet ? Loot.items(d.pet) : World.items()).some(i => i.slot === d.slot && i.refObjId === d.ref);
      if (!still) { this.dropping = null; Log.info('Dropped ' + Items.name(d.ref) + ' (item rule).'); }
      else if (t - d.at < ITEM_DROP_CONFIRM_MS) return false;
      else { this.dropping = null; this.dropBan.set(d.key, t + 30000); this.message = Items.name(d.ref) + ' was not dropped; trying again in 30 s.'; Log.warn(this.message); }
    }
    if (!this.count()) return false;
    const equipped = gp.equipmentSlotCount || 13, pet = Loot.pet();
    const sources = [[0, World.items().filter(i => i.slot >= equipped)], ...(pet ? [[pet.rec.gid, pet.rec.inventory || []]] : [])];
    for (const [petGid, items] of sources) for (const item of items) {
      if (this.get(item.refObjId)?.act !== 'drop') continue;
      const key = petGid + ':' + item.slot + ':' + item.refObjId;
      if ((this.dropBan.get(key) || 0) > t) continue;
      const command = petGid ? { kind: 'cos-drop', gid: petGid, slot: item.slot } : { kind: 'item-drop', slot: item.slot };
      if (!Cmd.spaced(command.kind) || !Cmd.raw(command, 'Drop ' + Items.name(item.refObjId))) return false;
      this.dropping = { key, pet: petGid, slot: item.slot, ref: item.refObjId, at: t };
      return true;
    }
    return false;
  },
};


// Map page: the game's own minimap tiles on a canvas, with the hunting area, monsters, party and players.
// Outdoors only: positions become absolute units (region x * 1920 + x, region z * 1920 + z; Z grows north, drawn up).
// One minimap tile (minimap/<rx>x<rz>, 256 px) covers one 1920-unit region. Dungeons have no tiles here yet.
// The live game ships tiles as .texture (NTX1: DXT-compressed, decoded here); older builds as .png.
// It only reads game state; the one setting it changes is the hunting spot, and only when the player asks.
const MAP_ART = '/assets/images/Media_extracted/';
// Monster class colours, as the game's own map window draws them.
const MAP_CLASS_COLOR = { normal: '#e0e0e0', champion: '#7fb8ff', giant: '#ffd65a', party: '#ff9b4a', elite: '#c78bff', unique: '#ff5a5a', titan: '#ff3dd0' };
const LeanMap = {
  upp: 5, // world units per screen pixel (10 units = 1 m)
  view: null, follow: true, picked: null, canvas: null, info: null, timer: 0,
  tiles: new Map(), signs: new Map(),
  space(p) {
    const rid = Number(p?.regionId ?? p?.region);
    if (!isNum(rid) || !isNum(p.x) || !isNum(p.z) || rid & DUNGEON) return null;
    return { X: (rid & 255) * SECTOR + p.x, Z: (rid >>> 8) * SECTOR + p.z };
  },
  local(X, Z) {
    const rx = Math.floor(X / SECTOR), rz = Math.floor(Z / SECTOR);
    if (rx < 0 || rx > 255 || rz < 0 || rz > 127) return null;
    return { regionId: (rz << 8) | rx, x: X - rx * SECTOR, z: Z - rz * SECTOR };
  },
  // A tile or sign image, loaded once from the game's packs. Missing tiles (open sea) are remembered quietly.
  image(cache, path) {
    const hit = cache.get(path);
    if (hit) return hit.img;
    const entry = { img: null }; cache.set(path, entry);
    const load = cache === this.tiles ? this.tile(path) : Icons.request(path).then(blob => createImageBitmap(blob));
    load.then(img => { entry.img = img; this.dirty = true; }, e => {
      entry.missing = true;
      if (!/not found in the game packs/i.test(e?.message || '') && e?.message !== this.lastTileError) { this.lastTileError = e?.message; Log.warn('Map tile ' + path + ': ' + e?.message); }
    });
    if (cache === this.tiles && cache.size > 80) for (const [key, value] of cache) { if (cache.size <= 60) break; if (key !== path) { value.img?.close?.(); cache.delete(key); } }
    return null;
  },
  // A tile: the .texture the live game publishes, else the .png of older builds. Resolves to a drawable or null.
  async tile(path) {
    try { return await this.ntxImage(new Uint8Array(await (await Icons.request(path + '.texture')).arrayBuffer())); }
    catch (e) { if (!/not found in the game packs/i.test(e.message)) throw e; }
    const blob = await Icons.request(path + '.png');
    return createImageBitmap(blob);
  },
  // NTX1 header (20 bytes, little endian): magic, width, height, format (21 = BGRA, DXT1/3/5 four-cc), mip count;
  // then the mips, largest first. Only the first mip is drawn. Same layout as the game client's native textures.
  ntxImage(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || v.getUint32(0, true) !== 0x3158544e) throw Error('not a native texture');
    const w = v.getUint32(4, true), h = v.getUint32(8, true), code = v.getUint32(12, true);
    if (!w || !h || w > 2048 || h > 2048) throw Error('bad texture size');
    const out = new ImageData(w, h), px = out.data, blocks = { 0x31545844: 8, 0x33545844: 16, 0x35545844: 16 }[code];
    if (code === 21) {
      if (bytes.length < 20 + w * h * 4) throw Error('truncated texture');
      for (let i = 0; i < w * h * 4; i += 4) { px[i] = bytes[20 + i + 2]; px[i + 1] = bytes[20 + i + 1]; px[i + 2] = bytes[20 + i]; px[i + 3] = bytes[20 + i + 3]; }
      return createImageBitmap(out);
    }
    if (!blocks) throw Error('unsupported texture format');
    const cols = Math.ceil(w / 4), rows = Math.ceil(h / 4);
    if (bytes.length < 20 + cols * rows * blocks) throw Error('truncated texture');
    const pal = new Uint8Array(16);
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const at = 20 + (by * cols + bx) * blocks, color = at + (blocks === 16 ? 8 : 0);
      const c0 = v.getUint16(color, true), c1 = v.getUint16(color + 2, true), three = blocks === 8 && c0 <= c1;
      for (let k = 0; k < 2; k++) {
        const c = k ? c1 : c0, r = c >> 11, g = (c >> 5) & 63, b = c & 31;
        pal[k * 4] = (r << 3) | (r >> 2); pal[k * 4 + 1] = (g << 2) | (g >> 4); pal[k * 4 + 2] = (b << 3) | (b >> 2); pal[k * 4 + 3] = 255;
      }
      for (let ch = 0; ch < 3; ch++) {
        const a = pal[ch], b = pal[4 + ch];
        pal[8 + ch] = Math.floor(three ? (a + b) / 2 : (2 * a + b) / 3);
        pal[12 + ch] = three ? 0 : Math.floor((a + 2 * b) / 3);
      }
      pal[11] = 255; pal[15] = three ? 0 : 255;
      const sel = v.getUint32(color + 4, true);
      for (let p = 0; p < 16; p++) {
        const x = bx * 4 + (p & 3), y = by * 4 + (p >> 2);
        if (x >= w || y >= h) continue;
        const s = ((sel >>> (p * 2)) & 3) * 4, o = (y * w + x) * 4;
        px[o] = pal[s]; px[o + 1] = pal[s + 1]; px[o + 2] = pal[s + 2]; px[o + 3] = pal[s + 3];
        if (code === 0x33545844) px[o + 3] = ((bytes[at + (p >> 1)] >>> ((p & 1) * 4)) & 15) * 17;
        else if (code === 0x35545844) px[o + 3] = this.dxt5Alpha(bytes, at, p);
      }
    }
    return createImageBitmap(out);
  },
  dxt5Alpha(bytes, at, p) {
    const a0 = bytes[at], a1 = bytes[at + 1], bit = p * 3, byte = at + 2 + (bit >> 3);
    const s = ((bytes[byte] | ((bytes[byte + 1] ?? 0) << 8)) >>> (bit & 7)) & 7;
    if (s === 0) return a0;
    if (s === 1) return a1;
    if (a0 > a1) return Math.floor(((8 - s) * a0 + (s - 1) * a1) / 7);
    if (s === 6) return 0;
    if (s === 7) return 255;
    return Math.floor(((6 - s) * a0 + (s - 1) * a1) / 5);
  },
  sign(name) { return this.image(this.signs, MAP_ART + 'interface/minimap/mm_sign_' + name + '.png'); },
  draw(parent) {
    const box = UI.group('Map');
    box.classList.add('map-box');
    const stage = el('div', null, 'map-stage');
    this.canvas = el('canvas'); this.canvas.setAttribute('aria-label', 'Map of the hunting area');
    const zoomIn = UI.button('+', () => this.zoom(1 / 1.5)), zoomOut = UI.button('−', () => this.zoom(1.5));
    zoomIn.setAttribute('aria-label', 'Zoom in'); zoomOut.setAttribute('aria-label', 'Zoom out');
    this.followButton = UI.button('Follow me', () => { this.follow = true; this.view = null; this.dirty = true; });
    const tools = el('div', null, 'map-tools'); tools.append(zoomIn, zoomOut, this.followButton);
    this.coords = el('div', '', 'map-coords');
    stage.append(this.canvas, tools, this.coords);
    this.info = el('p', '', 'muted');
    this.pickRow = UI.row(UI.button('Make this the hunting spot', () => this.setCentre()), UI.button('Clear mark', () => { this.picked = null; this.dirty = true; this.render(); }));
    box.append(stage, this.info, this.pickRow);
    const H = () => Settings.profile.hunt;
    const area = UI.group('Hunting area',
      UI.button('Set hunting spot here', () => { if (World.inWorld() && Hunt.setCenter()) { UI.toast('Hunting spot saved.'); this.dirty = true; } }),
      UI.number('Hunt radius (m)', () => H().radius / 10, v => { H().radius = v * 10; this.dirty = true; }, 5, 200),
      UI.number('Chase distance (m)', () => H().chase / 10, v => { H().chase = v * 10; this.dirty = true; }, 10, 300));
    const legend = UI.group('Legend');
    for (const [name, label] of [['character', 'You'], ['party', 'Party member'], ['otherplayer', 'Other player'], ['monster', 'Monster'], ['unique', 'Unique'], ['npc', 'NPC'], ['animal', 'Pet']]) {
      const row = el('div', null, 'map-legend'), mark = el('i'); mark.dataset.sign = name;
      row.append(mark, el('span', label)); legend.append(row);
    }
    legend.append(el('p', 'Yellow circle: hunt radius. Dashed ring: chase distance. Click the map to mark a point, drag to move it, use + and − to zoom.', 'muted'));
    parent.append(box, area, legend);
    for (const mark of legend.querySelectorAll('i[data-sign]')) this.paintSign(mark, mark.dataset.sign);
    this.bind(); this.dirty = true; this.render();
    clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 200);
  },
  paintSign(node, name) {
    Icons.url(MAP_ART + 'interface/minimap/mm_sign_' + name + '.png').then(url => { if (url && node.isConnected) node.style.backgroundImage = `url("${url}")`; });
  },
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, view: this.view && { ...this.view }, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const at = this.toWorld(e);
      const local = at && this.local(at.X, at.Z), shown = local && displayCoords(local);
      this.coords.textContent = shown ? `X ${shown.x} · Y ${shown.y}` : '';
      const d = this.drag;
      if (!d || !d.view) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) { this.follow = false; this.view = { X: d.view.X - dx * this.upp, Z: d.view.Z + dy * this.upp }; this.dirty = true; }
    });
    const up = e => {
      const d = this.drag; this.drag = null;
      if (!d || d.moved || e.type === 'pointercancel') return;
      const at = this.toWorld(e), local = at && this.local(at.X, at.Z);
      if (local) { this.picked = local; this.dirty = true; this.render(); }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
  },
  toWorld(e) {
    if (!this.view) return null;
    const r = this.canvas.getBoundingClientRect();
    return { X: this.view.X + (e.clientX - r.left - r.width / 2) * this.upp, Z: this.view.Z - (e.clientY - r.top - r.height / 2) * this.upp };
  },
  zoom(f) { this.upp = clamp(this.upp * f, 1.5, 30); this.dirty = true; },
  setCentre() {
    const pt = this.picked, pose = World.pose();
    if (!pt || !World.inWorld()) return;
    // The height of a map point is unknown; the character's current height is used, as the game's own map does.
    Settings.profile.hunt.center = { regionId: pt.regionId, x: Math.round(pt.x), y: Number(pose?.y) || 0, z: Math.round(pt.z) };
    Settings.saveProfile(); bus.emit('center');
    this.picked = null; this.dirty = true;
    UI.toast('Hunting spot set on the map.'); this.render();
  },
  tick() {
    if (!this.canvas?.isConnected) { clearInterval(this.timer); this.timer = 0; return; }
    if (UI.minimised || document.hidden) return;
    this.dirty = true;
    // One message per distinct error, so a drawing problem shows in the log instead of failing silently every 200 ms.
    try { this.render(); } catch (e) { if (e.message !== this.lastError) { this.lastError = e.message; Log.warn('Map: ' + e.message); } }
  },
  render() {
    const c = this.canvas;
    if (!c?.isConnected || !this.dirty) return;
    this.dirty = false;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const ratio = W.devicePixelRatio || 1;
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(h * ratio); }
    const ctx = c.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0b0d0a'; ctx.fillRect(0, 0, w, h);
    const pose = World.inWorld() ? World.pose() : null, me = this.space(pose);
    this.followButton.disabled = this.follow && !!me;
    this.pickRow.hidden = !this.picked;
    if (!pose) { this.note(ctx, w, h, 'Waiting for the game…'); this.info.textContent = ''; return; }
    if (!me) { this.note(ctx, w, h, 'There is no map for dungeons yet.'); this.info.textContent = ''; return; }
    if (this.follow || !this.view) this.view = { X: me.X, Z: me.Z };
    const upp = this.upp, v = this.view;
    const sx = X => w / 2 + (X - v.X) / upp, sy = Z => h / 2 - (Z - v.Z) / upp;
    // Minimap tiles under the visible box.
    const x0 = v.X - w / 2 * upp, x1 = v.X + w / 2 * upp, z0 = v.Z - h / 2 * upp, z1 = v.Z + h / 2 * upp;
    for (let rx = Math.max(0, Math.floor(x0 / SECTOR)); rx <= Math.min(255, Math.floor(x1 / SECTOR)); rx++)
      for (let rz = Math.max(0, Math.floor(z0 / SECTOR)); rz <= Math.min(127, Math.floor(z1 / SECTOR)); rz++) {
        const img = this.image(this.tiles, `${MAP_ART}minimap/${rx}x${rz}`);
        if (!img) continue;
        const l = Math.floor(sx(rx * SECTOR)), t = Math.floor(sy((rz + 1) * SECTOR));
        ctx.drawImage(img, l, t, Math.ceil(sx((rx + 1) * SECTOR)) - l, Math.ceil(sy(rz * SECTOR)) - t);
      }
    // Hunting area: radius (filled) and chase distance (dashed).
    const H = Settings.profile.hunt, centre = this.space(H.center);
    if (centre) {
      const cx = sx(centre.X), cy = sy(centre.Z);
      ctx.save();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,214,90,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, (Number(H.chase) || 0) / upp, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,214,90,.12)'; ctx.strokeStyle = 'rgba(255,214,90,.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, (Number(H.radius) || 0) / upp, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd65a'; ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
      ctx.restore();
    }
    // Entities in view. Party members are drawn from the party list too, so ones out of sight still show.
    const social = World.gp?.social, party = new Set((social?.members || []).map(m => m?.name).filter(Boolean));
    const target = World.gp?.target, local = World.localGid(), drawn = new Set();
    const put = (name, x, y, size, fallback) => {
      const img = this.sign(name);
      if (img) ctx.drawImage(img, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      else { ctx.fillStyle = fallback; ctx.beginPath(); ctx.arc(x, y, size / 3, 0, Math.PI * 2); ctx.fill(); }
    };
    let monsters = 0, players = 0;
    for (const e of World.ents.values()) {
      if (!e || e.gid === local || e.kind === 'local-player') continue;
      const s = this.space(e);
      if (!s) continue;
      const x = sx(s.X), y = sy(s.Z);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      if (e.kind === 'monster') {
        if (!World.isAlive(e)) continue;
        monsters++;
        const cls = monsterClass(e);
        if (e.rarity === 3) put('unique', x, y, 13, MAP_CLASS_COLOR.unique);
        else if (cls === 'normal') put('monster', x, y, 8, MAP_CLASS_COLOR.normal);
        else { ctx.fillStyle = MAP_CLASS_COLOR[cls] || '#fff'; ctx.beginPath(); ctx.arc(x, y, cls === 'champion' ? 3.5 : 4.5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); }
      } else if (e.kind === 'player') {
        players++;
        const member = party.has(e.name); if (member) drawn.add(e.name);
        put(member ? 'party' : 'otherplayer', x, y, 9, member ? '#5aff7a' : '#5ab4ff');
        if (upp <= 4 && e.name) this.label(ctx, e.name, x + 7, y - 4, member ? '#9dff9d' : '#cfe8ff');
      } else if (e.kind === 'npc') put('npc', x, y, 9, '#f0f0a0');
      else if (e.kind === 'cos') put('animal', x, y, 9, '#c8a2ff');
      else continue;
      if (e.gid === target) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
    for (const m of social?.members || []) {
      if (!m || m.id === social.self || drawn.has(m.name) || m.name === social.localName) continue;
      const s = this.space(m);
      if (!s) continue;
      put('party', clamp(sx(s.X), 6, w - 6), clamp(sy(s.Z), 6, h - 6), 9, '#5aff7a');
    }
    // Team intel: entities the room's other characters see, dimmer and without signs; own view wins.
    if (Settings.profile.team?.enabled && typeof TeamIntel !== 'undefined') {
      ctx.save(); ctx.globalAlpha = 0.55;
      for (const row of TeamIntel.rows()) {
        if (World.ents.has(row.gid)) continue;
        const s = this.space({ regionId: row.regionId, x: row.x, z: row.z });
        if (!s) continue;
        const x = sx(s.X), y = sy(s.Z);
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        if (row.kind === 'player') {
          const hostile = typeof TeamKnowledge !== 'undefined' && TeamKnowledge.players.get(row.name)?.hostile;
          ctx.fillStyle = hostile ? MAP_CLASS_COLOR.unique : '#5ab4ff';
          ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
          if (upp <= 4 && row.name) this.label(ctx, row.name + ' (' + row.src + ')', x + 7, y - 4, hostile ? '#ffb0b0' : '#cfe8ff');
        } else {
          ctx.fillStyle = MAP_CLASS_COLOR[row.cls] || MAP_CLASS_COLOR.normal;
          ctx.beginPath(); ctx.arc(x, y, row.unique ? 5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke();
          if (row.unique && row.name) this.label(ctx, row.name + ' (' + row.src + ')', x + 8, y - 4, '#ffb0b0');
        }
      }
      ctx.restore();
      // Unique tracker pins: the last known place of every unique the room has tracked.
      if (typeof TeamKnowledge !== 'undefined') {
        for (const record of TeamKnowledge.uniques.values()) {
          if (!record?.pos || !Number.isInteger(record.pos.regionId)) continue;
          const s = this.space(record.pos);
          if (!s) continue;
          const x = sx(s.X), y = sy(s.Z);
          ctx.strokeStyle = '#ff5a5a'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
          this.label(ctx, record.name, x + 11, y + 3, '#ffb0b0');
        }
      }
    }
    // A marked point (click), then you on top. Heading 0 = east, counter-clockwise; the sign points east.
    if (this.picked) {
      const s = this.space(this.picked), x = sx(s.X), y = sy(s.Z);
      ctx.strokeStyle = '#6fc1ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 11, y); ctx.lineTo(x + 11, y); ctx.moveTo(x, y - 11); ctx.lineTo(x, y + 11); ctx.stroke();
    }
    const mx = clamp(sx(me.X), 8, w - 8), my = clamp(sy(me.Z), 8, h - 8), img = this.sign('character');
    ctx.save(); ctx.translate(mx, my); ctx.rotate(-((Number(pose.angle) || 0) / 65535) * Math.PI * 2);
    if (img) ctx.drawImage(img, -8, -8, 16, 16); else { ctx.fillStyle = '#fff'; ctx.fillRect(-4, -4, 8, 8); }
    ctx.restore();
    // Scale bar.
    const metres = [10, 20, 50, 100, 200, 500].find(m => m * 10 / upp >= 60) || 500, bar = metres * 10 / upp;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w - bar - 18, h - 22, bar + 12, 16);
    ctx.fillStyle = '#efdaa4'; ctx.fillRect(w - bar - 12, h - 12, bar, 2); this.label(ctx, metres + ' m', w - bar - 12, h - 15, '#efdaa4');
    const shown = displayCoords(pose), distance = H.center ? dist2D(pose, H.center) : Infinity;
    const pick = this.picked && displayCoords(this.picked);
    this.info.textContent = `You: X ${shown.x} · Y ${shown.y}. Hunting spot: ${Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : H.center ? 'another region' : 'not saved'}. In view: ${monsters} monsters, ${players} players.`
      + (pick ? ` Marked point: X ${pick.x} · Y ${pick.y}.` : '');
  },
  label(ctx, text, x, y, color) {
    ctx.font = '11px Arial'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  },
  note(ctx, w, h, text) {
    ctx.font = '12px Arial'; ctx.textAlign = 'center'; ctx.fillStyle = '#a09b8c'; ctx.fillText(text, w / 2, h / 2); ctx.textAlign = 'start';
  },
};


function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  node.className = className;
  return node;
}
const UI = {
  root: null, body: null, pane: null, status: null, feedback: null,
  current: 'Combat', combatTab: 'Skills', refreshers: [], lastSkillKey: '',
  toast(message, level = 'info', ms = 5000) {
    Log.add(level, message);
    if (level === 'warn' || level === 'error' || /^SoX found/.test(message)) this.alertOrb(message);
    if (!this.feedback) return;
    this.feedback.textContent = message;
    this.feedback.style.color = level === 'warn' || level === 'error' ? '#ffc67a' : '#b5e5bd';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { if (this.feedback) this.feedback.textContent = ''; }, ms);
  },
  showDiagnostics(text) {
    if (!this.diagnosticBox) {
      this.diagnosticBox = this.group('Bug report', el('p', 'Clipboard unavailable. Select and copy this report, then send it with a description of the problem.', 'muted'));
      this.diagnosticText = el('textarea'); this.diagnosticText.readOnly = true; this.diagnosticText.rows = 8;
      this.diagnosticText.setAttribute('aria-label', 'Bug report diagnostics');
      this.diagnosticBox.append(this.diagnosticText, this.button('Close report', () => { this.diagnosticBox.hidden = true; }));
      this.body.insertBefore(this.diagnosticBox, this.waitNote.nextSibling);
    }
    this.diagnosticBox.hidden = false; this.diagnosticText.value = text;
    this.diagnosticText.focus(); this.diagnosticText.select();
    this.toast('Clipboard unavailable—copy the selected report.');
  },
  showReport() {
    if (!this.reportBox) {
      this.reportText = el('textarea'); this.reportText.readOnly = true; this.reportText.rows = 6;
      this.reportText.setAttribute('aria-label', 'Report preview');
      this.reportDescription = el('textarea'); this.reportDescription.rows = 2; this.reportDescription.maxLength = 1000;
      this.reportDescription.setAttribute('aria-label', 'What happened? (optional)');
      this.reportDescription.addEventListener('input', () => Reports.describe(this.reportDescription.value));
      this.reportCapture = this.button('Add screenshot (optional)', () => { void Reports.capture(); });
      this.reportRemove = this.button('Remove screenshot', () => Reports.removeImage());
      this.reportSend = this.button('Send to developer', () => { void Reports.send(); });
      this.reportClose = this.button('Close', () => Reports.close());
      this.reportImage = el('img'); this.reportImage.alt = 'Screenshot preview'; this.reportImage.className = 'report-image'; this.reportImage.hidden = true;
      this.reportStatus = el('p', '', 'muted'); this.reportStatus.setAttribute('role', 'status');
      this.reportBox = this.windowFrame('Bug report', () => Reports.close(),
        el('p', 'Only Send to developer uploads this preview through Cloudflare to the developer’s Discord. Diagnostics omit names, chat and locations. Your explanation and screenshot may show private details; check them first. Nothing is sent automatically.', 'muted'),
        this.field('What happened? (optional)', this.reportDescription), this.reportText,
        this.row(this.reportCapture, this.reportRemove), this.reportImage, this.reportStatus,
        this.row(this.reportSend, this.reportClose));
      this.reportBox.classList.add('report-preview');
      this.root.append(this.reportBox);
      const width = Math.min(430, innerWidth - 8);
      this.reportBox.style.left = Math.max(4, (innerWidth - width) / 2) + 'px';
      this.reportBox.style.top = Math.max(4, Math.min(80, innerHeight - 320)) + 'px';
    }
    this.reportBox.hidden = false; this.fitWindow(this.reportBox); this.front(this.reportBox);
    this.reportDescription.value = Reports.draft.description;
    this.reportStatus.textContent = Reports.draft.sent ? 'Report already sent. Close this preview to prepare another.' : 'Review the report before sending. Screenshot is optional.';
  },
  // Patch notes beside the panel, newest first. Plain text only; it never pauses the bot. Returns false before mount.
  showNotes(notes = RELEASE_NOTES, title = 'Patch notes') {
    if (!this.root || !notes.length) return false;
    const close = () => { this.notesBox.hidden = true; };
    const releases = notes.map(n => {
      const box = el('div', null, 'release'), list = el('ul');
      list.append(...n.items.map(item => el('li', item)));
      box.append(el('strong', n.version + ' · ' + n.title), list);
      if (n.note) box.append(el('p', n.note, 'muted'));
      return box;
    });
    const site = this.button('All patch notes', () => W.open(NOTES_URL, '_blank', 'noopener,noreferrer'));
    this.notesBox?.remove();
    this.notesBox = this.windowFrame(title, close,
      ...releases, this.row(this.button('Got it', close), site));
    this.notesBox.classList.add('patch-notes');
    this.root.append(this.notesBox);
    // Beside the panel (left if there is room, else right), never over the middle of the game.
    const panel = this.root.host.getBoundingClientRect(), width = Math.min(430, innerWidth - 8);
    this.notesBox.style.left = (panel.left - width - 8 >= 0 ? panel.left - width - 8 : panel.right + 8) + 'px';
    this.notesBox.style.top = Math.max(4, panel.top) + 'px';
    this.fitWindow(this.notesBox); this.front(this.notesBox);
    return true;
  },
  // A draggable in-page window in the panel's skin. Lives in the same shadow root, so typing is protected like the panel.
  windowFrame(title, onClose, ...children) {
    const win = el('section', null, 'panel dialog'), header = el('header');
    const close = this.button('×', onClose); close.className = 'fold'; close.setAttribute('aria-label', 'Close ' + title.toLowerCase());
    header.append(el('strong', title), close);
    const body = el('div', null, 'body dialog-body'); body.append(...children);
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) win.append(el('div', null, 'frame ' + corner));
    win.append(header, body);
    this.dragBy(header, win);
    win.addEventListener('pointerdown', () => this.front(win));
    return win;
  },
  // The window opened or touched last is drawn above the others.
  front(win) { win.style.zIndex = String(10 + (this.zTop = (this.zTop || 0) + 1)); },
  // Keep a floating window fully on screen after a resize or when it is re-shown.
  fitWindow(win) {
    if (!win || win.hidden) return;
    const r = win.getBoundingClientRect();
    win.style.left = clamp(r.left, 0, Math.max(0, innerWidth - r.width)) + 'px';
    win.style.top = clamp(r.top, 0, Math.max(0, innerHeight - r.height)) + 'px';
  },
  dragBy(header, target, onDone) {
    header.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const start = target.getBoundingClientRect(), origin = { x: e.clientX, y: e.clientY };
      header.setPointerCapture(e.pointerId);
      const move = event => {
        target.style.right = 'auto';
        target.style.left = clamp(start.left + event.clientX - origin.x, 0, Math.max(0, innerWidth - start.width)) + 'px';
        target.style.top = clamp(start.top + event.clientY - origin.y, 0, Math.max(0, innerHeight - 34)) + 'px';
      };
      const done = () => { onDone?.(); header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', done); header.removeEventListener('pointercancel', done); };
      header.addEventListener('pointermove', move); header.addEventListener('pointerup', done); header.addEventListener('pointercancel', done);
    });
  },
  button(text, action) {
    const b = el('button', text);
    b.type = 'button';
    b.addEventListener('click', () => { try { action(); } catch (e) { this.toast(e.message, 'warn'); } });
    return b;
  },
  row(...nodes) { const r = el('div', null, 'row'); r.append(...nodes); return r; },
  field(title, input) { const label = el('label', null, 'field'); input.setAttribute('aria-label', title); label.append(el('span', title), input); return label; },
  check(title, get, set) {
    const input = el('input'); input.type = 'checkbox'; input.checked = !!get();
    input.addEventListener('change', () => { set(input.checked); Settings.saveProfile(); });
    this.refreshers.push(() => { if (this.root?.activeElement !== input) input.checked = !!get(); });
    return this.field(title, input);
  },
  number(title, get, set, min, max, step = 1) {
    const input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = get();
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) { input.value = get(); return; }
      const valid = clamp(Math.round(value / step) * step, min, max);
      input.value = valid; set(valid); Settings.saveProfile();
    });
    return this.field(title, input);
  },
  text(title, get, set, placeholder = 'comma-separated names') {
    const input = el('input'); input.type = 'text'; input.value = get(); input.placeholder = placeholder;
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  select(title, options, get, set) {
    const input = el('select');
    const refresh = () => {
      if (this.root?.activeElement === input) return;
      const rows = typeof options === 'function' ? options() : options;
      const signature = JSON.stringify(rows);
      if (input.dataset.options !== signature) {
        input.replaceChildren(...rows.map(([value, text]) => { const o = el('option', text); o.value = value; return o; }));
        input.dataset.options = signature;
      }
      input.value = String(get());
    };
    refresh(); this.refreshers.push(refresh);
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  group(title, ...children) { const b = el('fieldset'); b.append(el('legend', title), ...children); return b; },
  toggleVisibility() {
    const host = this.root?.host;
    if (host) host.hidden = !host.hidden;
  },
  mount() {
    const host = el('div'); host.id = 'sro-bot-lean';
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = ':host{' + Object.entries(LEAN_SKIN).map(([key, data]) => `--s-${key}:url("${data}");`).join('') + '}\n' + LEAN_CSS + '\n:host([hidden]){display:none!important}';
    const panel = el('section', null, 'panel'), header = el('header');
    const fold = this.button('×', () => this.minimise(true));
    fold.className = 'fold'; fold.setAttribute('aria-label', 'Minimise bot window'); fold.title = 'Minimise (the bot keeps running)';
    header.title = 'The × minimises the window to a small icon; F7 folds it; Shift+F7 hides or shows everything.';
    this.updateButton = this.button('Update', () => Updates.open());
    this.updateButton.className = 'update'; this.updateButton.hidden = true;
    // Updates are announced on Discord, so the invite sits next to the version.
    const discord = this.button('Discord', () => {
      W.open(DISCORD_URL, '_blank', 'noopener,noreferrer');
    });
    discord.className = 'discord'; discord.title = 'Updates, suggestions and bug reports';
    const version = this.button(VERSION, () => this.showNotes());
    version.className = 'version'; version.title = 'What’s new: patch notes';
    const name = el('strong', 'NIX '); name.append(version);
    this.layoutButton = this.button('Wide', () => this.classic ? this.setClassic(false) : this.setWide(!this.wide));
    this.layoutButton.className = 'layout'; this.layoutButton.title = 'Switch between the wide and the compact window';
    this.classicButton = this.button('Classic', () => this.setClassic(true));
    this.classicButton.className = 'layout'; this.classicButton.title = 'Switch to the classic window: tabs and layout after SBot';
    header.append(name, this.layoutButton, this.classicButton, discord, this.updateButton, fold);
    this.body = el('div', null, 'body'); this.status = el('div', 'Waiting for game…', 'status'); this.status.setAttribute('role', 'status');
    this.updateNote = el('div', '', 'update-note'); this.updateNote.hidden = true;
    Updates.render();
    const controls = this.row(this.button('Start / stop · F8', () => toggleBot()), this.button('Return & hunt', () => WalkBack.start(true)), this.button('Stop all', () => stopAll()), this.button('Session', () => this.showSession()));
    controls.classList.add('controls');
    this.nav = el('nav'); this.nav.setAttribute('aria-label', 'Bot settings');
    this.buildNav();
    this.pane = el('div', null, 'pane'); this.feedback = el('div', null, 'feedback'); this.feedback.setAttribute('role', 'status');
    this.waitNote = el('div', '', 'waiting'); this.waitNote.setAttribute('role', 'status');
    this.body.append(this.makeMenubar(), this.updateNote, this.makeStrip(), this.status, this.waitNote, controls, this.nav, this.pane, this.makeSide(), this.feedback, this.makeLog());
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) panel.append(el('div', null, 'frame ' + corner));
    panel.append(header, this.body); this.root.append(style, panel, this.makeOrb());
    this.panel = panel;
    this.tip = el('div', null, 'skill-tip'); this.tip.hidden = true; this.root.append(this.tip);
    // The panel's spot is remembered across reloads (global, like the minimised icon's).
    this.dragBy(header, host, () => { if (host.style.left) this.uiPrefs({ panel: { x: host.offsetLeft, y: host.offsetTop } }); });
    W.addEventListener('resize', () => { this.applyClassic(); this.fitWindow(this.reportBox); this.fitWindow(this.notesBox); this.fitWindow(this.sessionBox); this.fitWindow(this.activityExportBox); if (this.minimised) this.placeOrb(host.offsetLeft, host.offsetTop); else if (host.style.left) this.fitWindow(host); });
    this.setWide(!!this.uiPrefs().wide && !this.uiPrefs().classic, false); this.applyClassic();
    this.draw(); this.update();
    this.restorePanel();
    if (this.uiPrefs().minimised) this.minimise(true);
  },
  // Minimised window: a skill-slot sized icon with a status dot. The bot keeps running.
  // Global (not per character) and kept in this page's storage, like the window position.
  uiPrefs(patch) {
    let prefs = {};
    try { prefs = JSON.parse(W.localStorage.getItem('sroLean:ui') || '{}') || {}; } catch {}
    if (patch) { prefs = { ...prefs, ...patch }; try { W.localStorage.setItem('sroLean:ui', JSON.stringify(prefs)); } catch {} }
    return prefs;
  },
  // Like Icons.paint, for an image that is not under icon/ (the map button is interface art).
  paintPath(node, path) {
    Icons.url(path).then(url => {
      if (!url || !node.isConnected) return;
      const image = el('img'); image.alt = ''; image.draggable = false;
      image.addEventListener('load', () => { node.dataset.iconLoaded = 'true'; });
      image.src = url; node.prepend(image);
    });
  },
  // What the bot is doing, for the status strip and the minimised icon: ok (hunting), busy or stop.
  botState() {
    const dead = World.inWorld() && World.isDead(), mode = Controller.mode, error = mode === 'error';
    // Busy comes from the live trips, not from Controller.mode: that label lags a tick behind (it still says
    // "returning" for up to 100 ms after Stop all ended a walk-back).
    const busy = Town.trip ? 'Town trip' : WalkBack.active ? 'Returning' : Reconnect.active() ? 'Reconnecting' : Restock.trip ? 'Shopping'
      : Resurrect.trip ? 'Resurrecting' : BuffGear.run ? 'Buff gear' : Alchemy.run || Alchemy.pending ? 'Alchemy' : Stall.run ? 'Stall' : '';
    const label = dead ? 'Dead' : error ? 'Error' : busy || (Hunt.running ? 'Hunting' : 'Stopped');
    // `note` is what only the state can say; the icon falls back to the first wait reason, which the wide window shows below the strip.
    const note = Town.trip ? Town.status() : WalkBack.active ? WalkBack.status() : Reconnect.active() && Reconnect.message ? Reconnect.message
      : Restock.recording ? 'Recording route: ' + Restock.draft.route.length + ' points' : '';
    const reason = note || (this.waitNote?.textContent || '').split('\n')[0];
    return { key: dead || error ? 'stop' : busy ? 'busy' : Hunt.running ? 'ok' : 'stop', label, dead, note, reason };
  },
  // Wide window: status strip on top, page list on the left, session numbers on the right, activity log below.
  // The pages themselves are the same as in the compact window. A global choice, kept with the window position.
  setWide(on, save = true) {
    if (on && this.uiPrefs().classic) { this.uiPrefs({ classic: false }); this.applyClassic(); }
    this.wide = on;
    this.root.host.classList.toggle('wide', on);
    this.layoutButton.textContent = on ? 'Compact' : 'Wide';
    if (save) this.uiPrefs({ wide: on });
    if (on) { Stats.loadLevels(); this.updateWide(); }
    if (save && this.pane) this.draw();
    if (!this.minimised && this.root.host.style.left) this.fitWindow(this.root.host);
  },
  readout(parent, label, group) {
    const value = el('b'); value.setAttribute('aria-label', group + ': ' + label);
    const row = el('div', null, 'readout'); row.append(el('span', label), value); parent.append(row);
    return value;
  },
  makeStrip() {
    const strip = el('div', null, 'strip wide-only');
    this.stripName = el('strong'); this.stripLine = el('span', '', 'muted');
    const who = el('div', null, 'who'); who.append(this.stripName, this.stripLine);
    const bars = el('div', null, 'bars'); this.bars = {};
    for (const [key, label] of [['hp', 'HP'], ['mp', 'MP'], ['xp', 'EXP']]) {
      const fill = el('i'), text = el('span'), track = el('div', null, 'track'); track.append(fill);
      const row = el('div', null, 'gauge ' + key); row.append(el('label', label), track, text); bars.append(row);
      this.bars[key] = { fill, text };
    }
    this.stripState = el('div', null, 'state'); this.stripLabel = el('strong'); this.stripReason = el('span');
    this.stripState.append(el('i', null, 'state-dot'), this.stripLabel, this.stripReason);
    this.cstat = el('div', null, 'cstat classic-only'); this.cstatFields = {};
    for (const [key, label] of [['bot', 'Bot status:'], ['mode', 'Mode:'], ['game', 'Game:'], ['spot', 'Hunting spot:']]) {
      const value = el('b'); value.setAttribute('aria-label', 'Status: ' + label.replace(':', ''));
      const row = el('div'); row.append(el('span', label), value); this.cstat.append(row); this.cstatFields[key] = value;
    }
    strip.append(who, bars, this.stripState, this.cstat);
    return strip;
  },
  makeSide() {
    const side = el('aside', null, 'side wide-only'); this.sideFields = {};
    const session = this.group('Session');
    for (const [key, label] of [['time', 'Hunting time'], ['rate', 'XP / hour'], ['xp', 'XP gained'], ['gold', 'Net gold'], ['kills', 'Kills'], ['deaths', 'Deaths'], ['sox', 'SoX found'], ['items', 'Items picked up'], ['potions', 'Potions used']])
      this.sideFields[key] = this.readout(session, label, 'Session');
    session.append(this.button('Reset session', () => Stats.reset()));
    const supplies = this.group('Supplies');
    for (const [key, label] of [['hp', 'HP potions'], ['mp', 'MP potions'], ['bag', 'Free bag slots'], ['pet', 'Pet bag'], ['spot', 'Hunting spot']])
      this.sideFields[key] = this.readout(supplies, label, 'Supplies');
    side.append(session, supplies);
    const actions = el('div', null, 'side-actions classic-only');
    actions.append(this.button('Save settings', () => { Settings.saveProfile(); this.toast('Settings saved.'); }),
      this.button('Session log', () => this.showSession(true)), this.button('Hide client', () => this.minimise(true)),
      this.button('Start training', () => { if (!Hunt.running) toggleBot(); }), this.button('Stop training', () => { if (Hunt.running) toggleBot(); }));
    side.append(actions);
    return side;
  },
  updateWide() {
    if ((!this.wide && !this.classic) || !this.bars || this.minimised) return;
    const me = World.me(), p = World.gp?.progression || {}, live = World.inWorld();
    const level = p.level, required = Stats.integer(Stats.levels?.[level]?.expRequired), xp = Stats.integer(p.experience);
    const xpPct = required && xp !== null ? Number(xp * 10000n / required) / 100 : null;
    this.stripName.textContent = World.charName || 'No character';
    this.stripLine.textContent = live ? `Level ${level ?? '?'}` : World.phase || 'Waiting for game…';
    const n = v => Math.round(v).toLocaleString('en-US');
    const setBar = (key, pct, text) => {
      this.bars[key].fill.style.width = (live && Number.isFinite(pct) ? clamp(pct, 0, 100) : 0) + '%';
      this.bars[key].text.textContent = live ? text : '—';
    };
    setBar('hp', me.hpPct, `${n(me.hp)} / ${n(me.maxHp)}`);
    setBar('mp', me.mpPct, `${n(me.mp)} / ${n(me.maxMp)}`);
    setBar('xp', xpPct, xpPct === null ? '—' : xpPct.toFixed(2) + ' %');
    const state = this.botState();
    this.stripState.dataset.state = state.key; this.stripLabel.textContent = state.label;
    this.stripReason.textContent = state.note || (Hunt.running ? `Mode: ${Controller.mode}` : 'Press F8 to start');
    if (this.classic) {
      const spot = Settings.profile.hunt.center, away = spot && live ? dist2D(World.pose(), spot) : Infinity;
      this.cstatFields.bot.textContent = state.label;
      this.cstatFields.mode.textContent = Hunt.running ? String(Controller.mode) : 'idle';
      this.cstatFields.game.textContent = live ? 'in game' : World.phase || 'waiting';
      this.cstatFields.spot.textContent = Number.isFinite(away) ? Math.round(away / 10) + ' m away' : spot ? 'another region' : 'not saved';
    }
    const s = Stats.display();
    for (const key of ['time', 'rate', 'xp', 'gold', 'kills', 'deaths', 'sox', 'items', 'potions']) this.sideFields[key].textContent = s[key];
    const pet = live ? Loot.pet() : null, center = Settings.profile.hunt.center, distance = center && live ? dist2D(World.pose(), center) : Infinity;
    this.sideFields.hp.textContent = live ? n(Potion.count('hp')) : '—';
    this.sideFields.mp.textContent = live ? n(Potion.count('mp')) : '—';
    this.sideFields.bag.textContent = live ? String(World.freeBagSlots()) : '—';
    this.sideFields.pet.textContent = pet ? `${pet.rec.inventory.length} / ${pet.rec.status}` : 'none';
    this.sideFields.spot.textContent = Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : center ? 'another region' : 'not saved';

  },
  // The wide window's activity box shows the same shared history as Settings and the session window.
  makeLog() {
    const box = el('div', null, 'logbox wide-only');
    this.logList = this.activityLog('Activity'); this.logList.classList.add('log');
    box.append(el('strong', 'Activity'), this.logList);
    return box;
  },
  makeOrb() {
    const orb = this.orb = el('button', null, 'orb'); orb.type = 'button'; orb.hidden = true;
    orb.setAttribute('aria-label', 'Show bot window');
    this.orbState = el('strong'); this.orbDetail = el('span'); this.orbVitals = el('span', '', 'muted');
    const tip = el('div', null, 'orb-tip'); tip.append(this.orbState, this.orbDetail, this.orbVitals, el('em', 'Click to open · drag to move'));
    orb.append(el('span', 'nb', 'orb-mark'), el('i', null, 'orb-dot'), tip);
    Icons.paint(orb, 'action\\icon_cha_auto_attack.ddj');
    let drag = null;
    orb.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: this.root.host.offsetLeft, top: this.root.host.offsetTop, moved: false };
      orb.setPointerCapture(e.pointerId);
    });
    orb.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) this.placeOrb(drag.left + dx, drag.top + dy);
    });
    const done = () => {
      if (!drag) return;
      if (drag.moved) { this.orbDragged = true; this.uiPrefs({ orb: { x: this.root.host.offsetLeft, y: this.root.host.offsetTop } }); }
      drag = null;
    };
    orb.addEventListener('pointerup', done); orb.addEventListener('pointercancel', done);
    orb.addEventListener('click', () => { if (this.orbDragged) { this.orbDragged = false; return; } this.minimise(false); });
    orb.addEventListener('pointerenter', () => { if (this.orbAlert) setTimeout(() => { this.orbAlert = ''; this.updateOrb(); }, 2500); });
    return orb;
  },
  // Put the panel at its saved spot, kept on screen; without one it uses the default top-right position.
  restorePanel() {
    const host = this.root.host, saved = this.uiPrefs().panel;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      host.style.right = 'auto'; host.style.left = saved.x + 'px'; host.style.top = saved.y + 'px'; this.fitWindow(host);
    } else { host.style.left = ''; host.style.top = ''; host.style.right = ''; }
  },
  placeOrb(x, y) {
    const host = this.root.host;
    host.style.right = 'auto';
    host.style.left = clamp(x, 0, Math.max(0, innerWidth - 44)) + 'px';
    host.style.top = clamp(y, 0, Math.max(0, innerHeight - 44)) + 'px';
  },
  minimise(on) {
    const host = this.root?.host;
    if (!host || !!this.minimised === on) return;
    this.minimised = on;
    if (on) {
      const r = host.getBoundingClientRect();
      const saved = this.uiPrefs().orb;
      host.classList.add('min'); this.panel.hidden = true; this.orb.hidden = false;
      if (saved) this.placeOrb(saved.x, saved.y); else this.placeOrb(r.right - 44, r.top + 4);
      if (this.tip) this.tip.hidden = true;
    } else {
      host.classList.remove('min'); this.panel.hidden = false; this.orb.hidden = true; this.orbAlert = '';
      this.restorePanel();
    }
    this.uiPrefs({ minimised: on });
    this.updateOrb();
  },
  // Pulse the icon for something that needs the player while the window is minimised.
  alertOrb(text) {
    if (!this.minimised) return;
    this.orbAlert = text; this.updateOrb();
  },
  updateOrb() {
    if (!this.orb || !this.minimised) return;
    const state = this.botState();
    if (state.dead && !this.orbWasDead && Hunt.running) this.alertOrb('Character died.');
    this.orbWasDead = state.dead;
    this.orb.dataset.state = state.key;
    this.orb.classList.toggle('alert', !!this.orbAlert);
    this.orb.classList.toggle('left', this.root.host.offsetLeft < 280);
    this.orbState.textContent = this.orbAlert ? 'Needs you' : state.label;
    this.orbDetail.textContent = this.orbAlert || state.reason || (Hunt.running ? 'Hunting' : 'Press F8 to start');
    const me = World.me();
    this.orbVitals.textContent = World.inWorld() ? `${World.charName || ''} · HP ${Math.round(me.hpPct)}% · MP ${Math.round(me.mpPct)}%` : '';
  },
  skillOptions() {
    return [[0, 'Choose a learned skill'], ...(World.gp?.skills || []).map(id => World.skill(id)).filter(s => s && !s.groundTarget).map(s => [s.id, s.name || '#' + s.id])];
  },
  skillDetails(id) {
    const s = World.skill(id);
    if (!s) return 'Skill #' + id;
    return `Lv ${s.level ?? '?'} · MP ${s.mp ?? 0}${s.mpPercent ? ' + ' + s.mpPercent + '%' : ''} · CD ${((s.cooldownMs || 0) / 1000).toFixed(1)}s`;
  },
  skillTip(id, event) {
    const s = World.skill(id);
    if (!s || !this.tip) return;
    this.tip.replaceChildren(el('strong', s.name || '#' + id), el('div', this.skillDetails(id)), el('div', s.targetRequired ? 'Target skill' : 'Self skill', 'muted'));
    this.tip.hidden = false;
    const rect = event.currentTarget.getBoundingClientRect();
    this.tip.style.left = clamp(event.clientX || rect.left, 4, Math.max(4, innerWidth - 274)) + 'px';
    this.tip.style.top = clamp((event.clientY || rect.bottom) + 16, 4, Math.max(4, innerHeight - 100)) + 'px';
  },
  skillSlot(id, action, label, selected = false, order = '') {
    const s = World.skill(id);
    const slot = this.button('', action); slot.className = 'slot' + (selected ? ' on' : '');
    slot.dataset.skill = String(id); slot.setAttribute('aria-label', label || World.skillName(id));
    slot.setAttribute('aria-pressed', String(selected));
    slot.title = `${World.skillName(id)}\n${this.skillDetails(id)}`;
    slot.append(el('span', (s?.name || '#' + id).slice(0, 3), 'fallback'), el('span', '', 'cd'), el('span', '', 'seconds'));
    if (order !== '') slot.append(el('span', order, 'order'));
    Icons.paint(slot, s?.icon);
    slot.addEventListener('pointerenter', e => this.skillTip(id, e));
    slot.addEventListener('focus', e => this.skillTip(id, e));
    slot.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    slot.addEventListener('blur', () => { this.tip.hidden = true; });
    return slot;
  },
  learnedSkills(buff) {
    const best = new Map();
    for (const s of Learned.rows()) {
      if (s.missing || s.active === false || s.groundTarget || (buff ? s.targetRequired : !s.targetRequired || (s.targets !== undefined && !(s.targets & 4)))) continue;
      const group = s.group ?? s.id, previous = best.get(group);
      if (!previous || (s.level ?? 0) > (previous.level ?? 0)) best.set(group, s);
    }
    return [...best.values()];
  },
  skillList(parent, list, buff = false) {
    const strip = el('div', null, 'grid');
    list.forEach((entry, i) => {
      const id = World.bestOfGroup(entry.group, entry.id) || entry.id;
      strip.append(this.skillSlot(id, () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); }, 'Remove ' + World.skillName(id), true, String(i + 1)));
    });
    parent.append(el('div', buff ? 'Active buffs — click a slot to remove' : 'Attack order — click a slot to remove', 'muted'), strip);
    if (!list.length) parent.append(el('div', buff ? 'No buffs selected. Choose from the icons below.' : 'No skills selected. Choose from the icons below.', 'empty'));
    list.forEach((entry, i) => {
      const id = World.bestOfGroup(entry.group, entry.id) || entry.id;
      const info = el('div', null, 'skill-info'); info.append(el('span', World.skillName(id), 'skill-name'), el('span', this.skillDetails(id), 'skill-detail'));
      const row = el('div', null, 'skill-row');
      const up = this.button('↑', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; Settings.saveProfile(); this.draw(); } });
      const down = this.button('↓', () => { if (i + 1 < list.length) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; Settings.saveProfile(); this.draw(); } });
      const remove = this.button('×', () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); });
      up.className = down.className = remove.className = 'mini';
      up.setAttribute('aria-label', 'Move up ' + World.skillName(id)); down.setAttribute('aria-label', 'Move down ' + World.skillName(id)); remove.setAttribute('aria-label', 'Delete ' + World.skillName(id));
      row.append(this.skillSlot(id, () => {}, World.skillName(id)), info, up, down, remove); parent.append(row);
      if (buff) parent.append(this.select('Gear for ' + World.skillName(id),
        () => [[0, 'Current combat gear'], ...Settings.profile.macro.buffSets.map(s => [s.id, s.name])],
        () => entry.gearSet || 0, value => entry.gearSet = Number(value)));
    });
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find a skill…'; search.setAttribute('aria-label', buff ? 'Search buff skills' : 'Search attack skills');
    const title = el('div', null, 'picker-title'); title.append(el('span', buff ? 'Learned self buffs' : 'Learned attack skills'), search);
    const grid = el('div', null, 'grid'); grid.setAttribute('aria-label', buff ? 'Buff skill icons' : 'Attack skill icons');
    for (const s of this.learnedSkills(buff)) {
      const selected = list.some(entry => entry.group === (s.group ?? s.id));
      const slot = this.skillSlot(s.id, () => {
        const index = list.findIndex(entry => entry.group === (s.group ?? s.id));
        if (index >= 0) list.splice(index, 1);
        else list.push({ id: s.id, group: s.group ?? s.id, ...(buff ? { enabled: true, mode: 'hunt', refreshS: 3 } : {}) });
        Settings.saveProfile(); this.draw();
      }, (selected ? 'Unselect ' : 'Add ') + World.skillName(s.id), selected);
      slot.dataset.search = ((s.name || '') + ' ' + s.level).toLowerCase(); grid.append(slot);
    }
    search.addEventListener('input', () => { for (const slot of grid.children) slot.hidden = !slot.dataset.search.includes(search.value.toLowerCase()); });
    parent.append(title, grid, el('p', 'Hover an icon for its name, level, MP and cooldown. Click to select; gold borders mark selected skills.', 'muted'));
    if (!grid.children.length) parent.append(el('div', 'No matching learned skills yet. Enter the game or reload if attached late.', 'empty'));
  },
  imbuePicker(parent) {
    const current = Settings.profile.macro.imbue;
    const grid = el('div', null, 'grid');
    const selected = current && (World.bestOfGroup(current.group, current.id) || current.id);
    parent.append(el('p', selected ? 'Selected: ' + World.skillName(selected) + ' · ' + this.skillDetails(selected) : 'No weapon imbue selected.', 'muted'));
    parent.append(this.button('No imbue', () => { Settings.profile.macro.imbue = null; Settings.saveProfile(); this.draw(); }));
    for (const s of this.learnedSkills(true)) grid.append(this.skillSlot(s.id, () => {
      Settings.profile.macro.imbue = { id: s.id, group: s.group ?? s.id };
      Settings.saveProfile(); this.draw();
    }, 'Use imbue ' + World.skillName(s.id), current?.group === (s.group ?? s.id)));
    parent.append(grid, el('p', 'Choose your weapon imbue here (for example Thunderdragon Force). The highest learned level in each group is shown and used automatically.', 'muted'));
  },
  draw() {
    if (!this.pane) return;
    if (this.classic) return this.drawClassic();
    if (this.tip) this.tip.hidden = true;
    this.lastSkillKey = this.skillKey();
    // Rebuilding the pane resets scrolling; keep the position when redrawing the same view.
    const view = [this.current, this.combatTab, this.rotationClass].join('|'), scroll = view === this.drawnView ? this.pane.scrollTop : 0;
    this.drawnView = view;
    this.refreshers = []; this.pane.replaceChildren();
    [...this.nav.children].forEach(b => b.setAttribute('aria-selected', String(b.textContent === this.current)));
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    if (this.current === 'Combat') {
      const subtabs = el('div', null, 'subtabs');
      for (const name of ['Skills', 'Buffs & imbue', 'Hunt area']) {
        const tab = this.button(name, () => { this.combatTab = name; this.draw(); });
        tab.setAttribute('aria-selected', String(name === this.combatTab)); subtabs.append(tab);
      }
      this.pane.append(subtabs);
      if (this.combatTab === 'Hunt area') this.sections('combatHuntArea', 'combatMonsters');
      if (this.combatTab === 'Skills') this.sections('combatRotation', 'combatOptions', 'combatBerserk');
      if (this.combatTab === 'Buffs & imbue') this.sections('combatBuffs', 'combatImbue');
    } else if (this.current === 'Loot') {
      this.sections('lootCollection', 'lootWho');
    } else if (this.current === 'Supplies') {
      this.sections('suppliesPotions', 'suppliesRestock');
      this.pane.append(el('p', 'Town trips, what starts them, and arrows and bolts are on the Town page.', 'muted'));
    } else if (this.current === 'Town') {
      this.sections('townTrip', 'townWhen', 'townCycle', 'townAmmo');
    } else if (this.current === 'Party') {
      this.sections('partyMembers', 'partyHeal', 'partyBuffs', 'partyParty', 'partyTrace');
    } else if (this.current === 'Team') {
      this.sections('teamRelay', 'teamWorld');
    } else if (this.current === 'Items') {
      this.drawItems();
    } else if (this.current === 'Stall') {
      Stall.draw();
    } else if (this.current === 'Setup') {
      Setup.draw(this.pane);
    } else if (this.current === 'Map') {
      LeanMap.draw(this.pane);
    } else if (this.current === 'Alchemy') {
      Alchemy.draw();
    } else if (this.current === 'Wardrobe') {
      LeanWardrobe.draw(this.pane);
    } else {
      this.sections('settingsStats', 'settingsBehaviour', 'settingsObstacles', 'settingsAntiStuck', 'settingsMastery', 'settingsStatPoints', 'settingsProfiles', 'settingsShare', 'settingsReports', 'settingsActivity');
    }
    this.balance();
    this.update();
    this.pane.scrollTop = scroll;
  },
  // ---- Classic layout: an SBot-style frame and tab order (opt-in, screens at least 900 px wide) ----
  // Each tab is a list of the page sections above (title = the heading it gets here); a tab only exists when we have
  // the feature, so there is no Chat, Union Party, Quest or Alarms tab yet.
  classicTabs() {
    return [
      { name: 'Settings', icon: 'action\\icon_cha_helper', pages: ['Supplies', 'Loot', 'Town', 'Combat', 'Settings'], sections: [
        ['suppliesPotions', 'Autopotion settings'], ['suppliesRestock', 'Buy settings'], ['townWhen', 'Back town settings'],
        ['lootCollection', 'Pick settings'], ['lootWho', 'Who picks up what'], ['combatMonsters', 'Attack preferences'],
        ['combatBerserk', 'Berserk settings'], ['settingsBehaviour', 'Attack behaviour / Protection'], ['settingsObstacles'], ['settingsAntiStuck']] },
      { name: 'Skills', icon: 'action\\icon_cha_auto_attack', pages: ['Combat'], sections: [
        ['combatRotation'], ['combatOptions'], ['combatBuffs'], ['combatImbue']] },
      { name: 'Items/Storage', icon: 'action\\cos_cmd_inventory', pages: ['Items', 'Town'], draw() {
        this.drawItems(); this.sections('townTrip', 'townCycle', 'townAmmo'); } },
      { name: 'Stall', pages: ['Stall'], draw() { Stall.draw(); } },
      { name: 'Training place', icon: 'action\\icon_cha_camp', pages: ['Combat', 'Party'], sections: [['combatHuntArea', 'Training place'], ['partyTrace']] },
      { name: 'Party/Autores', icon: 'action\\icon_cha_party', pages: ['Party'], sections: [
        ['partyMembers', 'Current party'], ['partyParty', 'Party settings'], ['partyHeal']] },
      { name: 'Player buffing', icon: 'action\\icon_cha_party', pages: ['Party'], sections: [['partyBuffs', 'Player buffing']] },
      { name: 'Team', icon: 'action\\icon_cha_party', pages: ['Team'], sections: [['teamRelay', 'Team relay']] },
      { name: 'Auto alchemy', icon: 'action\\icon_cha_alchemy', pages: ['Alchemy'], draw() { Alchemy.draw(); } },
      { name: 'Extra', icon: 'action\\icon_cha_helper', pages: ['Settings'], sections: [
        ['settingsStats'], ['settingsMastery'], ['settingsStatPoints'], ['settingsProfiles'], ['settingsShare'], ['settingsReports'], ['settingsActivity']] },
      { name: 'Map', pages: ['Map'], draw() { LeanMap.draw(this.pane); } },
      { name: 'Wardrobe', icon: 'action\\icon_cha_shop', pages: ['Wardrobe'], draw() { LeanWardrobe.draw(this.pane); } },
      { name: 'Setup', icon: 'action\\icon_cha_camp', pages: ['Setup'], draw() { Setup.draw(this.pane); } },
    ];
  },
  // The classic tab that holds a compact page (so Setup and the checklist can open the right place).
  tabFor(page, combatTab) {
    if (page === 'Combat') return combatTab === 'Hunt area' ? 'Training place' : 'Skills';
    return { Loot: 'Settings', Supplies: 'Settings', Town: 'Items/Storage', Party: 'Party/Autores', Items: 'Items/Storage', Alchemy: 'Auto alchemy', Settings: 'Extra' }[page] || page;
  },
  // Is this compact page (and optional Combat sub-tab) what the window shows right now, in either layout?
  is(page, tab) {
    if (this.classic) return !!this.classicTabs().find(t => t.name === this.ctab)?.pages.includes(page);
    return this.current === page && (!tab || this.combatTab === tab);
  },
  // Open a page (and Combat sub-tab) in whichever layout is active.
  show(page, tab) {
    this.current = page; if (tab) this.combatTab = tab;
    if (this.classic) this.ctab = this.tabFor(page, this.combatTab);
    this.draw();
  },
  setClassic(on) {
    this.uiPrefs(on ? { classic: true, wide: false } : { classic: false });
    if (on) this.setWide(false, false);
    this.applyClassic();
  },
  applyClassic() {
    if (!this.root || !this.nav) return;
    const host = this.root.host, was = !!this.classic, on = !!this.uiPrefs().classic && W.innerWidth >= 900;
    this.classic = on;
    host.classList.toggle('classic', on);
    this.classicButton.hidden = on;
    this.layoutButton.textContent = on || this.wide ? 'Compact' : 'Wide';
    if (on) { host.classList.remove('wide'); this.wide = false; Stats.loadLevels(); if (!was) this.ctab = this.tabFor(this.current, this.combatTab); }
    else if (was && this.uiPrefs().wide) this.setWide(true, false);
    if (on !== was) { this.buildNav(); if (this.pane) this.draw(); }
    if (!this.minimised && host.style.left) this.fitWindow(host);
  },
  buildNav() {
    this.nav.replaceChildren();
    const icons = { Items: 'action\\cos_cmd_inventory', Party: 'action\\icon_cha_party', Combat: 'action\\icon_cha_auto_attack', Loot: 'action\\icon_cha_autoget', Supplies: 'action\\icon_cha_recovery', Town: 'item\\etc\\mall_return_scroll',
      Alchemy: 'action\\icon_cha_alchemy', Wardrobe: 'action\\icon_cha_shop', Settings: 'action\\icon_cha_helper', Setup: 'action\\icon_cha_camp' };
    const entries = this.classic ? this.classicTabs().map(t => ({ name: t.name, icon: t.icon, open: () => { this.ctab = t.name; this.draw(); } }))
      : ['Setup', 'Map', 'Combat', 'Party', 'Team', 'Loot', 'Items', 'Supplies', 'Town', 'Stall', 'Alchemy', 'Wardrobe', 'Settings'].map(name => ({ name, icon: icons[name], open: () => { this.current = name; this.draw(); } }));
    // Page icons are the game's own action-bar icons; they show only in the wide and classic windows' page lists.
    for (const entry of entries) {
      const tab = this.button(entry.name, entry.open);
      tab.dataset.tab = entry.name;
      if (entry.name === 'Map') this.paintPath(tab, MAP_ART + 'interface/minimap/mm_map_button.png');
      else if (entry.icon) Icons.paint(tab, entry.icon + '.ddj');
      this.nav.append(tab);
    }
  },
  drawClassic() {
    if (this.tip) this.tip.hidden = true;
    this.lastSkillKey = this.skillKey();
    const tabs = this.classicTabs();
    if (!tabs.some(t => t.name === this.ctab)) this.ctab = tabs[0].name;
    const view = ['classic', this.ctab, this.rotationClass].join('|'), scroll = view === this.drawnView ? this.pane.scrollTop : 0;
    this.drawnView = view;
    this.refreshers = []; this.pane.replaceChildren();
    [...this.nav.children].forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === this.ctab)));
    const tab = tabs.find(t => t.name === this.ctab);
    if (tab.draw) tab.draw.call(this);
    else for (const [name, title] of tab.sections) {
      const first = this.pane.children.length;
      this['section_' + name](this.pane);
      const legend = title && this.pane.children[first]?.querySelector?.(':scope > legend');
      if (legend) legend.textContent = title;
    }
    this.update();
    this.pane.scrollTop = scroll;
  },
  exportBackup() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'sro-bot-lean', version: VERSION, profile: Settings.profile }, null, 2)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = 'nixxane-bot-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  // The classic window's menu bar: shortcuts to things that already exist elsewhere in the panel.
  makeMenubar() {
    const bar = el('div', null, 'menubar classic-only');
    const menus = [
      ['Settings', [['Export full backup', () => this.exportBackup()], ['Profiles and sharing', () => this.show('Settings')], ['Send bug report', () => Reports.open()]]],
      ['Lists', [['Item rules', () => this.show('Items')], ['Wardrobe', () => this.show('Wardrobe')], ['Map', () => this.show('Map')]]],
      ['Help', [['Patch notes', () => this.showNotes()], ['Setup checklist', () => this.show('Setup')], ['Session totals and log', () => this.showSession(true)], ['Discord', () => W.open(DISCORD_URL, '_blank', 'noopener,noreferrer')]]],
    ];
    for (const [name, items] of menus) {
      const title = this.button(name, () => this.openMenu(title, items));
      title.className = 'menu-title'; bar.append(title);
    }
    return bar;
  },
  openMenu(anchor, items) {
    this.closeMenu();
    const menu = el('div', null, 'menu');
    for (const [label, action] of items) menu.append(this.button(label, () => { this.closeMenu(); action(); }));
    const bar = anchor.parentElement;
    menu.style.left = anchor.offsetLeft + 'px';
    bar.append(menu);
    this.menu = menu;
    const away = event => { if (!event.composedPath().includes(menu) && event.target !== anchor) this.closeMenu(); };
    this.menuAway = away;
    W.addEventListener('pointerdown', away, true);
  },
  closeMenu() {
    this.menu?.remove(); this.menu = null;
    if (this.menuAway) { W.removeEventListener('pointerdown', this.menuAway, true); this.menuAway = null; }
  },
  // A page is a list of sections; each section appends its own boxes to the given parent, so other layouts can reuse them.
  sections(...names) { for (const name of names) this['section_' + name](this.pane); },
  section_combatHuntArea(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Hunting area',
        this.button('Set hunting spot here', () => { if (World.inWorld() && Hunt.setCenter()) this.toast('Hunting spot saved.'); }),
        this.number('Hunt radius (m)', () => H().radius / 10, v => H().radius = v * 10, 5, 200),
        this.number('Chase distance (m)', () => H().chase / 10, v => H().chase = v * 10, 10, 300),
        this.check('Return when idle', () => H().returnToCenter, v => H().returnToCenter = v),
        this.check('Avoid other players’ targets', () => H().avoidKs, v => H().avoidKs = v),
        this.number('Minimum mob level (0 = any)', () => H().levelMin, v => H().levelMin = v, 0, 140),
        this.number('Maximum mob level (0 = any)', () => H().levelMax, v => H().levelMax = v, 0, 140),
        this.text('Only these mobs', () => H().include, v => H().include = v),
        this.text('Skip these mobs', () => H().exclude, v => H().exclude = v)
      ));
  },
  section_combatMonsters(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const classes = this.group('Monster classes');
      for (const key of Object.keys(H().classes)) classes.append(this.check(key === 'titan' ? 'titan (uses Unique rotation)' : key, () => H().classes[key], v => H().classes[key] = v));
      host.append(classes);
  },
  section_combatRotation(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.rotationClass ||= 'normal';
      const classes = el('div', null, 'class-tabs');
      for (const key of CLASS_KEYS) {
        const tab = this.button('', () => { this.rotationClass = key; this.draw(); });
        tab.setAttribute('aria-label', 'Rotation for ' + key); tab.setAttribute('aria-selected', String(key === this.rotationClass));
        const icon = el('i'); icon.style.backgroundImage = `var(--s-tw_${key})`;
        tab.append(icon, el('span', key)); classes.append(tab);
      }
      const rotation = this.group('Attack rotation', classes,
        this.check('Empty classes use Normal rotation', () => M().fallbackToNormal, v => M().fallbackToNormal = v),
        this.check('Use normal attacks', () => M().normalAttack, v => M().normalAttack = v));
      this.skillList(rotation, M().rotations[this.rotationClass]); host.append(rotation);
  },
  section_combatOptions(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Combat options',
        this.number('Skill gap (ms)', () => M().castGapMs, v => M().castGapMs = v, 150, 2000, 50)));
  },
  section_combatBerserk(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Berserk when the gauge is full, on',
        ...[['giant', 'Giants'], ['titan', 'Titans'], ['unique', 'Uniques'], ['elite', 'Elites'], ['party', 'Party monsters'], ['champion', 'Champions'], ['normal', 'Normal monsters']]
          .map(([key, label]) => this.check(label, () => M().berserkClasses[key], v => M().berserkClasses[key] = v))));
  },
  section_combatBuffs(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      BuffGear.draw(host);
      const buffs = this.group('Buffs'); this.skillList(buffs, M().buffs, true);
      host.append(buffs);
  },
  section_combatImbue(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const imbue = this.group('Weapon imbue'); this.imbuePicker(imbue); host.append(imbue);
  },
  section_lootCollection(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const L = () => H().pickup;
      const options = this.group('Collection');
      options.append(this.select('Default collector', [['character', 'Character'], ['pet', 'Pickup pet']], () => L().collector, v => { L().collector = v; Loot.reset(); }));
      options.append(this.check('Chime when pet bag is full', () => L().petFullSound, v => { L().petFullSound = v; Loot.fullAlert = null; }), this.button('Test pet chime', () => Sound.test()),
        this.check('Chime and notice when a SoX item is picked up', () => L().soxSound, v => L().soxSound = v), this.button('Test SoX chime', () => Sound.test('sox')));
      this.petNote = el('p', '', 'muted'); options.append(this.petNote);
      options.append(this.row(...[['Elixirs only','elixirs'],['Elixirs + gold','elixirs-gold'],['All items','all']].map(([label,mode]) => this.button(label, () => { Loot.preset(mode); this.draw(); }))));
      for (const [key, label] of [['enabled', 'Collect drops'], ['soxOnly', 'Equipment: only SoX (Star / Moon / Sun)'], ['afterKillOnly', 'Character: finish the current fight before picking up']]) options.append(this.check(label, () => L()[key], v => L()[key] = v));
      options.append(this.number('Pickup radius (m)', () => L().radius / 10, v => L().radius = v * 10, 3, 100),
        this.number('Retries after first attempt', () => L().retries, v => L().retries = v, 0, 3),
        this.text('Always include names', () => L().include, v => L().include = v),
        this.text('Exclude names', () => L().exclude, v => L().exclude = v),
        el('p', 'Pets collect during combat regardless of the finish-fight setting, which applies to the character only. Inventory transactions and potion priority can briefly delay pet requests. Equipment: only SoX takes Star, Moon and Sun gear and leaves plain equipment, even when Equipment or an Always include name matches it; other items follow their own switches. It needs the item catalogue, which loads automatically. Presets clear Always include names; exclusions still apply. Other items excludes the separate categories above. Ownership and bag capacity always apply. Failed pickups use a backoff.', 'muted'));
      host.append(options);
  },
  section_lootWho(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const L = () => H().pickup;
      const kinds = this.group('Who picks up what');
      for (const [key, label] of [['gold', 'Gold'], ['potions', 'Potions and cure pills'], ['equipment', 'Equipment'], ['elixirs', 'Elixirs'], ['powders', 'Lucky powders'], ['magicStones', 'Magic stones (stored in the warehouse)'], ['attrStones', 'Attribute stones (stored in the warehouse)'], ['alchemy', 'Other alchemy items'], ['others', 'Other items']])
        kinds.append(this.select(label, [['off', 'Leave on the ground'], ['pet', 'Pickup pet'], ['character', 'Character']],
          () => L()[key] ? Loot.collectorFor(key) : 'off',
          v => { if (v === 'off') L()[key] = false; else { L()[key] = true; (L().by ||= {})[key] = v; } Loot.reset(); }));
      kinds.append(el('p', 'Each kind of drop is either left alone, taken by your pickup pet, or taken by the character. The pet collects while you fight and fills its own bag; the character walks to the item and uses your bag, so give it only the few kinds you want on you (for example potions or pills). The default collector decides for kinds you have not set yourself and for names under Always include.', 'muted'));
      host.append(kinds);
  },
  section_suppliesPotions(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const pots = this.group('Automatic potion use', this.check('Use potions automatically', () => P().enabled, v => P().enabled = v));
      pots.append(this.potionDelay(), el('p', 'Minimum interval between automatic potion uses. The game’s own item cooldowns still apply.', 'muted'));
      this.speedNote = el('p', '', 'muted');
      pots.append(this.check('Use beginner +100% speed scroll automatically', () => P().speedScroll, v => { P().speedScroll = v; SpeedScroll.reset(); }),
        el('p', 'Uses only the beginner scroll during hunting or travel when no movement-speed buff is active. Works during combat casts; potions have priority. Waits for buff confirmation and stops retrying after three unconfirmed attempts.', 'muted'), this.speedNote);
      for (const kind of ['hp', 'mp']) pots.append(this.check('Use ' + kind.toUpperCase(), () => P()[kind].on, v => P()[kind].on = v), this.number(kind.toUpperCase() + ' below (%)', () => P()[kind].pct, v => P()[kind].pct = v, 5, 95));
      pots.append(this.check('Use vigor potions', () => P().vigor.on, v => P().vigor.on = v),
        this.number('Vigor when HP below (%)', () => P().vigor.hpPct, v => P().vigor.hpPct = v, 0, 95),
        this.number('Vigor when MP below (%)', () => P().vigor.mpPct, v => P().vigor.mpPct = v, 0, 95),
        this.check('Use cure pills', () => P().cure.on, v => P().cure.on = v),
        this.check('Use recovery kits on my pets', () => P().petHp.on, v => { P().petHp.on = v; PetPotion.reset(); }),
        this.number('Pet HP below (%)', () => P().petHp.pct, v => P().petHp.pct = v, 5, 95),
        el('p', 'Pets: when an attack or pickup pet drops below this HP, one recovery kit (the smallest that covers the missing HP) is used on it. Your own potions always go first; each kit must be seen consumed before the next. Vigor potions need no setting beyond the two thresholds above; they are used only when the HP and MP potions are not enough.', 'muted'));
      this.petPotionNote = el('p', PetPotion.message, 'muted'); pots.append(this.petPotionNote);
      host.append(pots);
  },
  section_suppliesRestock(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const townOn = Town.cfg().enabled;
      const shop = this.group('Potion restock');
      if (townOn) shop.append(el('p', 'The town cycle is on: every trip buys X-Large potions at the saved merchant, so walking-route restock and merchant recording are hidden. Low-stock and refill amounts below still apply.', 'muted'));
      else shop.append(this.check('Auto buy while hunting', () => C().enabled, v => C().enabled = v),
        this.row(this.button('Record from merchant', () => Restock.beginRecording()), this.button('Finish at hunt spot', () => Restock.finishRecording()), this.button('Cancel route', () => Restock.cancelRecording())),
        el('p', 'Open the potion shop, start recording, close the shop, walk to your hunting spot, then finish recording. Do not teleport while recording.', 'muted'));
      for (const kind of ['hp', 'mp']) {
        shop.append(this.check('Buy ' + kind.toUpperCase(), () => C()[kind].on, v => C()[kind].on = v));
        if (!townOn) shop.append(this.select(kind.toUpperCase() + ' potion', () => [[0, 'Record a merchant route first'], ...C().offers.filter(o => o.kind === kind).map(o => [o.refObjId, o.name])], () => C()[kind].refObjId, v => C()[kind].refObjId = Number(v)));
        shop.append(this.number('Low stock ≤', () => C()[kind].low, v => C()[kind].low = v, 0, 9999), this.number(kind.toUpperCase() + ' refill to', () => C()[kind].target, v => C()[kind].target = v, 1, 10000));
      }
      shop.append(this.check('Buy vigor potions', () => C().vigor.on, v => C().vigor.on = v),
        this.select('Vigor potion size', [[18, 'Herb (smallest)'], [19, 'Small'], [20, 'Medium'], [21, 'Large'], [22, 'X-Large']], () => C().vigor.refObjId, v => C().vigor.refObjId = Number(v)),
        this.number('Vigor low stock ≤', () => C().vigor.low, v => C().vigor.low = v, 0, 9999),
        this.number('Vigor refill to', () => C().vigor.target, v => C().vigor.target = v, 1, 10000),
        el('p', 'Vigor potions use the size you pick here on every town trip and walking restock. Pick a size the potion merchant sells, or the trip stops with a message. Using them is set under Automatic potion use.', 'muted'),
        this.check('Buy abnormal pills (best)', () => C().cure.on, v => C().cure.on = v),
        this.number('Pills low stock ≤', () => C().cure.low, v => C().cure.low = v, 0, 9999),
        this.number('Pills refill to', () => C().cure.target, v => C().cure.target = v, 1, 10000),
        el('p', 'Buys only Special Universal Pill (small), the strongest universal cure. No cheaper substitute. Uses the same refill trips as HP/MP. Use cure pills above controls automatic use.', 'muted'));
      shop.append(el('p', 'Refill targets are total potion counts, including what is already in your bag. Used for low-supply, full-bag and revival trips, and walking-route restock when the town cycle is off. Set MP refill to 1000 for 1,000 MP potions. Changes apply to the next trip.', 'muted'));
      host.append(shop);
  },
  section_townTrip(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const town = () => Town.cfg();
      // The trip as the game's own item pictures, with what each step still needs.
      const flow = el('ol', null, 'trip-flow'), count = type => World.items().filter(i => (i.typeFlags & 0xfffc) === type).reduce((n, i) => n + (i.quantity ?? 1), 0);
      for (const [icon, label, detail] of [
        ['mall_return_scroll', 'Return scroll', () => town().arrival ? count(0x09ec) + ' in bag' : 'arrival not saved'],
        ['mall_warehouse_ticket', 'Warehouse', () => town().storage ? 'saved' : 'not saved'],
        ['all_potion_03', 'Potions', () => town().vendor ? 'saved' : 'not saved'],
        ['mall_repair_hammer', 'Repair', () => town().smith ? 'saved' : 'not saved'],
        ['mall_reverse_return_scroll', 'Reverse', () => count(0x19ec) + ' in bag']]) {
        const step = el('li'), slot = el('span', null, 'skill-icon'), note = el('small', detail());
        slot.append(el('span', label[0], 'fallback')); Icons.paint(slot, `item\\etc\\${icon}.ddj`);
        step.append(slot, el('strong', label), note); flow.append(step);
        this.refreshers.push(() => { note.textContent = detail(); note.classList.toggle('missing', /not saved|^0 in bag/.test(note.textContent)); });
      }
      host.append(this.group('The town trip', flow));
  },
  section_townWhen(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const town = () => Town.cfg();
      host.append(this.group('Go to town when…',
        el('p', 'Only while the scroll town cycle below is on. Always: the character bag has one free slot or less. Potions, vigor potions and pills: at the low-stock numbers in Supplies. Arrows and bolts: below.', 'muted'),
        this.check('Return when pickup pet is nearly full', () => town().petFull, v => town().petFull = v),
        this.number('Pet free slots ≤', () => town().petFree, v => town().petFree = v, 0, 10),
        this.check('Weapon is broken', () => town().broken, v => town().broken = v),
        this.check('Gear is worn', () => town().wear.on, v => town().wear.on = v),
        this.number('Gear durability below (%)', () => town().wear.pct, v => town().wear.pct = v, 1, 90),
        this.check('No XP for a while', () => town().noXp.on, v => town().noXp.on = v),
        this.number('No XP for (minutes)', () => town().noXp.minutes, v => town().noXp.minutes = v, 1, 120),
        this.check('On a timer', () => town().every.on, v => town().every.on = v),
        this.number('Every (minutes)', () => town().every.minutes, v => town().every.minutes = v, 5, 600),
        this.check('Revive in town and use reverse return', () => town().revive, v => town().revive = v),
        this.select('After death, reverse to', [['recall', 'Last return-scroll location (hunting area)'], ['death', 'Death location']], () => town().deathReturn, v => { town().deathReturn = v; Activity.emit({category:'settings',code:'reverse-choice-changed',text:'Revival reverse destination changed to ' + v + '.',details:{choice:v === 'death' ? 3 : 2}}); }),
        el('p', 'Service trips reverse to their departure point. After death, use the selected destination. A missing game destination stops the trip; it never substitutes another point.', 'muted'),
        el('p', 'Worn gear means the most worn repairable item you are wearing, measured against its own maximum durability; the trip repairs it. A broken weapon (0 durability) has its own switch, on by default. The XP and timer clocks run only while hunting and restart with every trip.', 'muted')));
  },
  section_townCycle(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const town = () => Town.cfg();
      const services = this.group('Scroll town cycle',
        this.check('Use return scroll → town services → reverse return', () => town().enabled, v => { town().enabled = v; this.draw(); }),
        this.check('Deposit SoX gear in the warehouse (character and pet bags)', () => town().storeSox, v => town().storeSox = v),
        this.check('Sell items from the character bag too (same rules as pet loot)', () => town().sellBag, v => town().sellBag = v),
        this.text('Also deposit gear requiring level', () => town().storeLevels, v => town().storeLevels = v, 'e.g. 85 or 80-90, 100'),
        this.number('Town arrival tolerance (m)', () => town().arrivalRadius / 10, v => town().arrivalRadius = v * 10, 10, 150),
        el('p', 'Bind your recall to Hotan, Jangan, Donwhang, Constantinople or Samarkand in the game. Quickest: pick your town and press Set up this town; the arrival point is where its return scroll always lands, so you do not have to be in town. It fills the arrival point and the four services. To do it by hand instead, save the arrival point where a return scroll places you, then stand near, select and save the warehouse, potion merchant, repair merchant and world statue / teleport. Open the potion shop before saving its merchant. Saves your standing position for each approach. Uses collision-aware walking between services. Overrides the recorded walking restock while enabled.', 'muted'));
      for (const [role, label] of [['arrival', 'Arrival point'], ['storage', 'Warehouse'], ['vendor', 'Potion merchant'], ['smith', 'Repair merchant'], ['gate', 'World statue / teleport']]) services.append(
        this.row(this.button('Save ' + label.toLowerCase(), () => Town.save(role)), el('span', town()[role]?.name || (town()[role] ? 'Saved' : 'Not saved'), 'muted')));
      const townOptions = Town.towns.map(t => [t.key, t.name]);
      this.townPick ||= Town.detect()?.key || townOptions[0][0];
      services.append(this.select('Town', townOptions, () => this.townPick, v => this.townPick = v),
        this.button('Set up this town', () => Town.autoSetup(true, this.townPick)),
        this.button('Auto-set town services', () => Town.autoSetup(false)), this.button('Redo all automatically', () => Town.autoSetup(true)));
      services.append(el('p', 'Pet loot: store elixirs, and Star / Moon / Sun gear when SoX deposit is on (needs the saved warehouse; SoX gear in your own bag goes in too, all other character items stay). Nothing is deposited right after pickup, only on the next town trip. Gear requiring one of the levels you list above (for example 85) is deposited the same way and never sold. SoX gear that is part of a saved buff set, the weapon chosen for alchemy, or matches the Keep names stays in your bag. Sell other unprotected pet items at the saved weapon / repair merchant before repairing. Other seal/rare equipment and equipment with unknown rarity stays in the pet. Ordinary equipment is sold regardless of + or blue options. Character bag items are sold only with the switch above, by the same rules as pet loot (never potions, scrolls, supplies, Keep names, buff-set gear or the alchemy weapon).', 'muted'));
      services.append(this.text('Keep in pet (names)', () => town().keep, v => town().keep = v),
        el('p', 'Town buys X-Large potions using the Buy HP/MP switches, low-stock thresholds and refill counts above. Keep each low-stock threshold below its refill target. Potion selections apply to walking-route restock. Returns when the character bag has at most one free slot. Free at least two slots before hunting again; existing character items stay protected. Revival uses the saved town services and a reverse scroll, without using a return scroll in town. Pet loot passes through one reserved character bag slot. Potions, return/reverse scrolls, beginner speed scrolls and matching Keep names are protected. Refills travel scrolls to two where sold for gold; otherwise carry spares. F8 cancels.', 'muted'));
      this.townNote = el('p', Town.status(), 'muted'); services.append(this.townNote); host.append(services);
  },
  section_townAmmo(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const ammo = () => C().ammo;
      host.append(this.group('Arrows and bolts',
        this.check('Buy arrows on town trips', () => ammo().arrow.on, v => ammo().arrow.on = v),
        this.number('Arrows: go to town at or below', () => ammo().arrow.low, v => ammo().arrow.low = v, 0, 9999),
        this.number('Arrows: refill to', () => ammo().arrow.target, v => ammo().arrow.target = v, 1, 10000),
        this.check('Buy bolts on town trips', () => ammo().bolt.on, v => ammo().bolt.on = v),
        this.number('Bolts: go to town at or below', () => ammo().bolt.low, v => ammo().bolt.low = v, 0, 9999),
        this.number('Bolts: refill to', () => ammo().bolt.target, v => ammo().bolt.target = v, 1, 10000),
        el('p', 'Bought at the repair merchant after selling pet loot and before repairing. The count includes the stack in your ammunition slot and any spare stacks in the bag. A trip also starts when the count falls to the low-stock number. If the merchant does not sell it, there is no bag space or not enough gold, that item is skipped and the rest of the trip goes on. Equipping the bought ammunition is up to you.', 'muted')));
  },
  section_partyMembers(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const S = () => Settings.profile.party.support;
      // Live party: HP and MP bars, distance, and which of the assigned buffs each member shows right now.
      const list = el('div', null, 'members'), rows = el('p', '', 'muted');
      const renderMembers = () => {
        const members = Support.members().filter(m => !m.self);
        if (!members.length) { list.replaceChildren(el('div', 'Not in a party.', 'empty')); return; }
        list.replaceChildren(...members.map(m => {
          const row = el('div', null, 'member' + (m.alive ? '' : ' dead'));
          const bars = el('div', null, 'member-bars');
          for (const [key, pct] of [['hp', m.hpPct], ['mp', m.mpPct]]) { const bar = el('div', null, 'pbar ' + key), fill = el('i'); fill.style.width = clamp(pct, 0, 100) + '%'; bar.append(fill); bars.append(bar); }
          const name = el('div', null, 'member-name');
          name.append(el('strong', m.name), el('span', `Lv ${m.level ?? '?'} · ${!m.alive ? 'dead' : !m.entity ? 'out of view' : Math.round(m.distance / 10) + ' m' + (m.inRange ? '' : ' (out of range)')}`, 'muted'));
          const buffs = el('div', null, 'member-buffs');
          for (const b of S().buffs) {
            const id = Support.skillOf(b), only = splitList(b.only || '');
            if (!id || only.length && !only.includes(m.name.toLowerCase())) continue;
            const slot = el('span', null, 'skill-icon' + (m.gid && Support.has(m.gid, id) ? ' on' : ' off')); slot.title = World.skillName(id);
            slot.append(el('span', '·', 'fallback')); Icons.paint(slot, World.skill(id)?.icon); buffs.append(slot);
          }
          row.append(name, bars, buffs); return row;
        }));
        rows.textContent = Support.message;
      };
      renderMembers(); this.refreshers.push(renderMembers);
      host.append(this.group('Party members', list, rows));
  },
  section_partyHeal(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const S = () => Settings.profile.party.support;
      const skillOptions = skills => () => [[0, 'None'], ...skills().map(s => [s.id, s.name || '#' + s.id])];
      const pick = entry => v => { const id = Number(v); entry().id = id; entry().group = id ? World.skill(id)?.group ?? id : 0; };
      host.append(this.group('Heal and buff the party',
        this.check('Buff and heal party members', () => S().enabled, v => { S().enabled = v; Support.reset(); }),
        this.check('Also while hunting is stopped', () => S().whileStopped, v => S().whileStopped = v),
        this.number('Support range (m)', () => S().range, v => S().range = v, 5, 60),
        this.select('Heal skill', skillOptions(() => Support.friendlySkills()), () => Support.skillOf(S().heal) || 0, pick(() => S().heal)),
        this.number('Heal below (%)', () => S().heal.pct, v => S().heal.pct = v, 10, 95),
        this.check('Heal myself too', () => S().heal.self, v => S().heal.self = v),
        this.select('Group heal skill', skillOptions(() => Support.areaSkills()), () => Support.skillOf(S().group) || 0, pick(() => S().group)),
        this.number('Group heal below (%)', () => S().group.pct, v => S().group.pct = v, 10, 95),
        this.number('Group heal when this many are low', () => S().group.count, v => S().group.count = v, 2, 8),
        el('p', 'Casts only on members you can see within the support range; it never walks to them. Order: group heal, then a heal on the lowest member, then missing buffs, one cast at a time. HP is exact for members in view. Your own potions still come first.', 'muted')));
  },
  section_partyBuffs(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const S = () => Settings.profile.party.support;
      // Party buffs: skills that can be cast on another member, each with an optional list of who gets it.
      const buffs = this.group('Party buffs'), chosen = () => S().buffs;
      if (!chosen().length) buffs.append(el('div', 'No party buffs chosen. Pick from the icons below.', 'empty'));
      chosen().forEach((b, i) => {
        const id = Support.skillOf(b), info = el('div', null, 'skill-info');
        info.append(el('span', World.skillName(id), 'skill-name'), el('span', this.skillDetails(id), 'skill-detail'));
        const remove = this.button('×', () => { chosen().splice(i, 1); Settings.saveProfile(); this.draw(); });
        remove.className = 'mini'; remove.setAttribute('aria-label', 'Delete party buff ' + World.skillName(id));
        const row = el('div', null, 'skill-row'); row.append(this.skillSlot(id, () => {}, World.skillName(id)), info, remove);
        buffs.append(row, this.text('Only these members: ' + World.skillName(id), () => b.only || '', v => b.only = v, 'everyone (or names, comma-separated)'));
      });
      const grid = el('div', null, 'grid'); grid.setAttribute('aria-label', 'Party buff skill icons');
      for (const s of Support.friendlySkills()) {
        const group = s.group ?? s.id, selected = chosen().some(b => b.group === group);
        grid.append(this.skillSlot(s.id, () => {
          const index = chosen().findIndex(b => b.group === group);
          if (index >= 0) chosen().splice(index, 1); else chosen().push({ id: s.id, group, only: '' });
          Settings.saveProfile(); this.draw();
        }, (selected ? 'Unselect ' : 'Add ') + World.skillName(s.id), selected));
      }
      buffs.append(el('div', 'Learned skills you can cast on a party member', 'muted'), grid);
      if (!grid.children.length) buffs.append(el('div', 'No learned skill can target a party member.', 'empty'));
      host.append(buffs);
  },
  section_partyParty(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const party = () => Settings.profile.party;
      this.partyNote = el('p', '', 'muted');
      host.append(this.group('Party',
        this.check('Auto-recruit', () => party().autoRecruit, v => { party().autoRecruit = v; Party.reset(); }),
        this.text('Party listing title', () => party().title, v => party().title = v),
        this.number('Party minimum level', () => party().min, v => party().min = v, 1, 90),
        this.number('Party maximum level', () => party().max, v => party().max = v, 1, 90),
        this.select('Party purpose', [[0, 'Hunting'], [1, 'Quest'], [2, 'Trade'], [3, 'Thief']], () => party().purpose, v => party().purpose = Number(v)),
        this.check('Share EXP in new parties', () => party().expShare, v => party().expShare = v),
        this.check('Share items in new parties', () => party().itemShare, v => party().itemShare = v),
        this.partyNote,
        el('p', 'Auto-recruit registers your saved listing and accepts applicants whenever enabled, even with hunting stopped. Restores missing listings when space opens and retries unconfirmed registrations after fresh idle state, at most once every 30 seconds. Existing listings and party sharing settings are preserved; edits apply to the next new listing. Turning this off leaves the current listing in place.', 'muted'),
        this.check('Auto-accept party-matching joins', () => Settings.profile.party.autoAcceptMatching, v => Settings.profile.party.autoAcceptMatching = v),
        el('p', 'Accepts applications to your own listing while you are the leader or forming a new party. Works while hunting is stopped; turn this switch off to stop accepting. Ordinary invitations are left to you.', 'muted'),
        this.check("Join the main account's party", () => party().joinMain, v => { party().joinMain = v; Party.reset(); }),
        this.text('Main account character name', () => party().mainName, v => { party().mainName = v; Party.reset(); }, 'exact character name'),
        el('p', 'For your other accounts. While you are not in a party, the bot accepts a party invitation from that character, or finds their party listing on the party-matching board and applies to it. The main account needs Auto-recruit and Auto-accept party-matching joins ticked. It also rejoins after a disconnect, once the character is back in the game. Leave this off on the main account.', 'muted'),
        this.check('Accept resurrection from party members', () => party().acceptRes, v => party().acceptRes = v),
        el('p', 'When you are dead and a party member casts Rebirth on you, the bot answers Yes. Works during hunting and while stopped; resurrection offers from other players are left to you.', 'muted'),
        this.check('Auto-resurrect party members', () => party().autoRes, v => { party().autoRes = v; Resurrect.reset(); }),
        this.number('Maximum res distance from hunt spot (m)', () => party().resRadius / 10, v => party().resRadius = v * 10, 1, 100),
        el('p', 'Works during hunting and while stopped. Walks into skill range for visible dead members within the maximum radius, casts Rebirth, then returns. During hunting the radius is measured from the saved hunt spot; while stopped it uses your starting position. Collision data is required for walking. Travel stops after 30 seconds or 12 seconds without progress per leg. The member must accept the revival. Travel, shopping and manual control take priority.', 'muted')));
  },
  section_partyTrace(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      Trace.draw(host);
  },
  section_teamRelay(host) {
    const team = () => Settings.profile.team;
    this.teamNote = el('p', '', 'muted');
    this.teamPeers = el('div');
    host.append(this.group('Team relay',
      this.check('Connect to a team relay', () => team().enabled, v => { team().enabled = v; Team.reset(); this.draw(); }),
      this.text('Relay address (wss://…)', () => team().url, v => { team().url = v; Team.tick(); }),
      this.text('Room key', () => team().token, v => { team().token = v; Team.tick(); }),
      this.select('This character\'s role', [['none', 'No role'], ['tank', 'Tank'], ['healer', 'Healer'], ['support', 'Support'], ['dps', 'Damage'], ['scout', 'Scout']], () => team().role, v => team().role = v),
      this.check('Assist: fight what a teammate fights', () => team().assist, v => team().assist = v),
      this.check('Recall to town together', () => team().townSync, v => team().townSync = v),
      this.check('Go to a unique that appears (the saved spot comes back)', () => team().converge, v => team().converge = v),
      this.teamNote,
      el('p', 'A private channel between your own characters over a WebSocket relay you control. Characters that enter the same room key see each other\'s presence here; nothing is sent to anyone else, and the bot never depends on it: with the relay off or unreachable everything else works exactly as before. The address must start with wss://. Assist joins the fight a teammate (or party member) is already in; town sync starts your town trip when a teammate starts theirs. The room\'s console page on the relay can stop everyone or call a group town trip.', 'muted')));
    const share = this.group('Sharing');
    share.append(this.check('Also share with every room on this relay', () => team().share.public, v => team().share.public = v),
      this.check('Shared: interesting monsters (champion and up)', () => team().share.monsters, v => team().share.monsters = v),
      this.check('Shared: other players seen', () => team().share.players, v => team().share.players = v),
      this.check('Shared: unique appearances', () => team().share.uniques, v => team().share.uniques = v),
      el('p', 'The room key holders always see everything above. The public pool (every room on your relay) only ever receives what these boxes allow, and never your own position, build or inventory. Unique announcements from the game\'s server are shared as events; your own sightings carry positions.', 'muted'));
    host.append(share);
    const peers = this.group('Connected characters');
    peers.append(this.teamPeers, el('p', 'Each character announces itself every 5 seconds and is dropped from this list after 15 seconds of silence.', 'muted'));
    host.append(peers);
  },
  section_teamWorld(host) {
    this.teamUniques = el('div');
    this.teamPlayers = el('div');
    this.teamDrops = el('div');
    const uniques = this.group('Unique tracker');
    uniques.append(this.teamUniques, el('p', 'Built from the game\'s own server-wide announcements, shared sightings and kills. The respawn timer restarts at death (3-6 h depending on the unique). Hunt here moves your saved hunting spot to the last known position.', 'muted'));
    const players = this.group('Players seen by the team');
    players.append(this.teamPlayers, el('p', 'Every player the team sees, newest first. A player who attacks a teammate outside a party is marked hostile.', 'muted'));
    const drops = this.group('Team drops');
    drops.append(this.teamDrops);
    host.append(uniques, players, drops);
  },
  section_settingsStats(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      Stats.draw(host);
  },
  section_settingsBehaviour(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Behaviour',
        ...(Town.autoRevive() ? [el('p', 'On death: the town cycle revives you in town and reverses back (Town → Scroll town cycle).', 'muted')]
          : [this.select('On death', [['stop', 'Stop'], ['wait', 'Wait'], ['revive', 'Revive and walk back']], () => H().onDeath, v => H().onDeath = v)]),
        this.check('Rest when low', () => H().sit.enabled, v => { H().sit.enabled = v; this.draw(); }),
        ...(H().sit.enabled ? [
          this.number('Rest below HP (%)', () => H().sit.hpBelow, v => H().sit.hpBelow = v, 0, 95),
          this.number('Rest below MP (%)', () => H().sit.mpBelow, v => H().sit.mpBelow = v, 0, 95),
          this.number('Stand up at (%)', () => H().sit.resumeAt, v => H().sit.resumeAt = v, 30, 100)] : []),
        this.check('Stop when HP potions run out', () => H().stopNoHpPotion, v => H().stopNoHpPotion = v),
        this.check('Stop when bag is full', () => H().stopInvFull, v => H().stopInvFull = v),
        this.number('Manual control pause (s)', () => H().manualPauseS, v => H().manualPauseS = v, 1, 30)));
  },
  section_settingsObstacles(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Obstacles',
        this.check('Walk around obstacles when chasing a mob', () => H().detour.enabled, v => H().detour.enabled = v),
        this.number('Approach progress check interval (ms)', () => H().detour.stallMs, v => H().detour.stallMs = v, 1000, 10000),
        this.check('Detect a character that cannot move', () => H().trap.enabled, v => H().trap.enabled = v),
        this.number('Cannot move for (seconds)', () => H().trap.seconds, v => H().trap.seconds = v, 10, 120),
        this.check('Recall to town if legal escape attempts fail', () => H().trap.recall, v => H().trap.recall = v),
        this.check('Keep detailed escape diagnostics locally', () => H().trap.diagnostics, v => H().trap.diagnostics = v),
        el('p', 'Checks blocked approaches before repeating attacks, follows collision-checked detours and stops/releases unreachable targets. Failed approaches are remembered briefly. Escape retries refused movement and requires fresh, stable arrival plus a second move before hunting resumes. Optional recall needs a configured scroll town cycle and stops in town instead of reversing into the trap. Detailed diagnostics stay local and can include exact positions; both new options are off by default. Unknown collision data cannot authorize an escape.', 'muted')));
  },
  section_settingsAntiStuck(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.stuckNote = el('p', AntiStuck.status(), 'muted');
      host.append(this.group('Anti-stuck',
        this.check('Recover when hunting makes no progress', () => H().antiStuck.enabled, v => H().antiStuck.enabled = v),
        this.number('No progress for (minutes)', () => H().antiStuck.minutes, v => H().antiStuck.minutes = v, 1, 30),
        this.number('Stop after failed recoveries', () => H().antiStuck.maxRecoveries, v => H().antiStuck.maxRecoveries = v, 1, 10),
        this.stuckNote,
        el('p', 'Progress means a confirmed kill, XP, gold, a pickup, or damage to your target. Resting, buffing, looting, shopping and town trips do not count against you. First recovery drops the current target; the next ones walk back to the saved hunting spot; after the last one hunting stops.', 'muted')));
  },
  section_settingsMastery(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      AutoMastery.draw(host);
  },
  section_settingsStatPoints(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      StatPoints.draw(host);
  },
  section_settingsProfiles(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Profiles', el('p', 'Settings are saved separately for each character.', 'muted'),
        this.button('Export full backup (with my positions)', () => this.exportBackup())));
  },
  section_settingsShare(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      ProfileShare.draw(host);
  },
  section_settingsReports(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Bug reports', el('p', 'Preview diagnostics and optionally a screenshot, then send them to the developer. Nothing sends automatically.', 'muted'), this.button('Send bug report', () => Reports.open())));
  },
  section_settingsActivity(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.logs = this.activityLog('Settings activity');
      host.append(this.group('Recent activity', this.button('Pop out session totals and log', () => this.showSession(true)), this.activityPanel(this.logs, 'Settings')));
  },
  // The wide window shows a page as two columns. Plain grid rows leave a gap under every box that is shorter than its
  // neighbour, so the boxes are dealt into two stacks instead: each one goes under the shorter stack, in page order.
  // Wide boxes (the map, the item table, the member list, the trip pictures) and loose notes keep the full width.
  balance() {
    if (!this.wide || !this.pane) return;
    const full = el => el.tagName !== 'FIELDSET' || el.matches('.map-box, :has(.trip-flow), :has(.members), :has(.item-table)');
    const kids = [...this.pane.children], boxes = kids.filter(k => !full(k));
    if (boxes.length < 2 || kids.length === 1) return;
    const heights = new Map(boxes.map(b => [b, b.offsetHeight])), segments = [];
    let run = [];
    for (const k of kids) {
      if (full(k)) { if (run.length) segments.push({ run, before: k }); run = []; } else run.push(k);
    }
    if (run.length) segments.push({ run, before: null });
    for (const { run: group, before } of segments) {
      if (group.length < 2) continue;
      const row = el('div', null, 'pane-cols'), left = el('div', null, 'pane-col'), right = el('div', null, 'pane-col');
      let l = 0, r = 0;
      for (const b of group) { if (l <= r) { left.append(b); l += heights.get(b) + 8; } else { right.append(b); r += heights.get(b) + 8; } }
      row.append(left, right); this.pane.insertBefore(row, before);
    }
  },
  // Items page: every item of the game's catalogue with its rule (sBot's item list). Filters re-render only the table,
  // so typing in the search box keeps its focus. 100 rows per page; bulk buttons apply to everything the filters show.
  itemFilter: { query: '', group: 'all', race: '', gender: '', kind: '', degrees: new Set(), custom: false, page: 0 },
  drawItems() {
    if (!Items.data.size) {
      this.pane.append(this.group('Items', el('div', 'Loading the game\u2019s item list…', 'empty')));
      Items.ready().then(() => { if (this.is('Items')) this.draw(); }, () => { if (this.is('Items')) this.toast('The item list could not be loaded; try again in a moment.', 'warn'); });
      return;
    }
    const f = this.itemFilter, refresh = () => { f.page = 0; renderTable(); };
    const choose = (title, options, key) => {
      const input = el('select'); input.setAttribute('aria-label', title);
      input.append(...options.map(([value, text]) => { const o = el('option', text); o.value = value; return o; }));
      input.value = f[key]; input.addEventListener('change', () => { f[key] = input.value; refresh(); });
      const label = el('label', null, 'field'); label.append(el('span', title), input); return label;
    };
    const kinds = ['Head', 'Shoulder', 'Chest', 'Hand', 'Trouser', 'Boot', 'Shield', 'Garment', 'Protector', 'Armor', 'Necklace', 'Earring', 'Ring',
      'Blade', 'Sword', 'Glaive', 'Spear', 'Bow', '1HSword', '2HSword', 'Axe', 'X-Bow', 'Dagger', 'Staff', 'W-Rod', 'C-Rod', 'Harp'];
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find an item (name, code or id)'; search.value = f.query; search.setAttribute('aria-label', 'Find an item');
    search.addEventListener('input', () => { f.query = search.value; refresh(); });
    const degrees = el('div', null, 'degrees');
    for (let d = 1; d <= 12; d++) {
      const box = el('input'); box.type = 'checkbox'; box.checked = f.degrees.has(d); box.setAttribute('aria-label', 'Degree ' + d);
      box.addEventListener('change', () => { box.checked ? f.degrees.add(d) : f.degrees.delete(d); refresh(); });
      const label = el('label'); label.append(box, el('span', String(d))); degrees.append(label);
    }
    const custom = el('input'); custom.type = 'checkbox'; custom.checked = f.custom; custom.setAttribute('aria-label', 'Only items with a rule');
    custom.addEventListener('change', () => { f.custom = custom.checked; refresh(); });
    const customLabel = el('label', null, 'field'); customLabel.append(el('span', 'Only items with a rule'), custom);
    const nearby = el('input'); nearby.type = 'checkbox'; nearby.checked = !!f.nearby; nearby.setAttribute('aria-label', 'Only items on the ground now');
    nearby.addEventListener('change', () => { f.nearby = nearby.checked; refresh(); });
    const nearbyLabel = el('label', null, 'field'); nearbyLabel.append(el('span', 'Only items on the ground now'), nearby);
    const filters = this.group('Choose items',
      choose('Item group', [['all', 'All items'], ['equipment', 'Equipment'], ['weapon', 'Weapons'], ['armour', 'Armour and shields'], ['accessory', 'Accessories'], ['potion', 'Potions'],
        ['pill', 'Pills'], ['alchemy', 'Alchemy'], ['ammo', 'Arrows and bolts'], ['scroll', 'Scrolls'], ['pet', 'Pet items'], ['quest', 'Quest items'], ['mall', 'Item mall'], ['other', 'Other']], 'group'),
      choose('Race', [['', 'Any'], ['CH', 'Chinese'], ['EU', 'European']], 'race'),
      choose('Gender', [['', 'Any'], ['Male', 'Male'], ['Female', 'Female']], 'gender'),
      choose('Type', [['', 'Any'], ...kinds.map(k => [k, k])], 'kind'),
      el('div', 'Degree', 'muted'), degrees, search, customLabel, nearbyLabel);
    const bulk = el('div', null, 'row bulk'), table = el('div', null, 'item-table'), pager = el('div', null, 'row pager'), summary = el('p', '', 'muted');
    table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Item rules');
    const rules = this.group('Item rules', summary, bulk, table, pager,
      el('p', 'Pick: always takes the item whatever the Loot switches say, never leaves it. A rule is for that exact item (each size or degree is its own item), so tick Only items on the ground now to find what is dropping and set the rule on those. Store puts it in the warehouse on town trips (also from your bag, except potions and scrolls the trip needs). Sell sells it from the pet at the repair merchant; your own bag is never sold. Keep never stores or sells it. Drop throws it away from your bag or the pet while hunting, and it is never picked up again. Right-click a row for the same choices.', 'muted'));
    this.pane.append(filters, rules);
    const set = (ids, change, label) => { ItemRules.set(ids, change); this.toast(`${label}: ${ids.length} item${ids.length === 1 ? '' : 's'}.`); renderTable(); };
    // Bulk buttons ask for a second click when they change more than one item.
    const bulkActions = [['Pick always', { pick: 'yes' }], ['Pick never', { pick: 'no' }], ['Store', { act: 'store' }], ['Sell', { act: 'sell' }], ['Keep', { act: 'keep' }],
      ['Drop', { act: 'drop' }], ['Clear', { pick: null, act: null }]];
    let shown = [], armed = null;
    for (const [label, change] of bulkActions) {
      const button = this.button(label, () => {
        const ids = shown.map(i => i.id);
        if (!ids.length) return;
        if (ids.length > 1 && armed !== label) {
          armed = label; button.textContent = `${label} ${ids.length}?`; button.classList.add('armed');
          setTimeout(() => { if (armed === label) { armed = null; button.textContent = label; button.classList.remove('armed'); } }, 4000);
          return;
        }
        armed = null; button.textContent = label; button.classList.remove('armed'); set(ids, change, label);
      });
      button.setAttribute('aria-label', 'All shown: ' + label); bulk.append(button);
    }
    const menu = (info, x, y) => {
      this.itemMenu?.remove();
      const box = el('div', null, 'item-menu'); box.setAttribute('role', 'menu');
      box.append(el('strong', info.name));
      for (const [label, change] of [['Pick always', { pick: 'yes' }], ['Pick never', { pick: 'no' }], ['Pick by Loot switches', { pick: null }], ['Store', { act: 'store' }], ['Sell', { act: 'sell' }],
        ['Keep', { act: 'keep' }], ['Drop', { act: 'drop' }], ['No action', { act: null }], ['Clear rule', { pick: null, act: null }]]) {
        const item = this.button(label, () => { box.remove(); set([info.id], change, label); }); item.setAttribute('role', 'menuitem'); box.append(item);
      }
      this.root.append(box); this.itemMenu = box;
      box.style.left = clamp(x, 0, innerWidth - 180) + 'px'; box.style.top = clamp(y, 0, innerHeight - box.offsetHeight - 4) + 'px';
      setTimeout(() => this.root.addEventListener('pointerdown', e => { if (!box.contains(e.composedPath()[0])) box.remove(); }, { once: true }), 0);
    };
    const renderTable = () => {
      shown = ItemRules.list(f);
      const pages = Math.max(1, Math.ceil(shown.length / 100)); f.page = clamp(f.page, 0, pages - 1);
      summary.textContent = `${shown.length.toLocaleString('en-US')} items shown · ${ItemRules.count()} with a rule.`;
      const head = el('div', null, 'item-row head'); head.setAttribute('role', 'row');
      for (const text of ['', 'Item', 'Deg', 'Pick', 'Store', 'Sell', 'Keep', 'Drop']) head.append(el('span', text));
      const rows = shown.slice(f.page * 100, f.page * 100 + 100).map(info => {
        const rule = ItemRules.get(info.id) || {}, row = el('div', null, 'item-row' + (rule.pick || rule.act ? ' ruled' : ''));
        row.setAttribute('role', 'row'); row.dataset.id = info.id;
        const slot = el('span', null, 'skill-icon'); slot.append(el('span', '', 'fallback')); if (info.icon) Icons.paint(slot, info.icon);
        const name = el('span', null, 'item-name'); name.append(el('span', info.name));
        if (info.sox) name.append(el('em', ['', 'Star', 'Moon', 'Sun'][info.sox], 'sox'));
        name.title = info.code + ' · #' + info.id;
        const pick = this.button(rule.pick === 'yes' ? 'Yes' : rule.pick === 'no' ? 'No' : '–', () =>
          set([info.id], { pick: rule.pick === 'yes' ? 'no' : rule.pick === 'no' ? null : 'yes' }, 'Pick'));
        pick.className = 'cell'; pick.setAttribute('aria-label', 'Pick ' + info.name);
        row.append(slot, name, el('span', info.degree ? String(info.degree) : ''), pick);
        for (const act of ITEM_ACTIONS) {
          const cell = this.button(rule.act === act ? '●' : '', () => set([info.id], { act: rule.act === act ? null : act }, act[0].toUpperCase() + act.slice(1)));
          cell.className = 'cell' + (rule.act === act ? ' on' : ''); cell.setAttribute('aria-label', act[0].toUpperCase() + act.slice(1) + ' ' + info.name);
          cell.setAttribute('aria-pressed', String(rule.act === act)); row.append(cell);
        }
        row.addEventListener('contextmenu', e => { e.preventDefault(); menu(info, e.clientX, e.clientY); });
        return row;
      });
      table.replaceChildren(head, ...rows);
      if (!rows.length) table.append(el('div', 'No item matches these filters.', 'empty'));
      const prev = this.button('‹ Previous', () => { f.page--; renderTable(); }), next = this.button('Next ›', () => { f.page++; renderTable(); });
      prev.disabled = f.page === 0; next.disabled = f.page >= pages - 1;
      pager.replaceChildren(prev, el('span', `Page ${f.page + 1} of ${pages}`, 'muted'), next);
    };
    renderTable();
  },
  skillKey() {
    return (World.gp?.skills || []).map(id => { const s = World.skill(id); return `${id}:${s?.name}:${s?.icon}:${s?.level}`; }).join('|');
  },
  update() {
    Stats.sample(); Stats.render();
    Alchemy.refresh(); Setup.refresh(); Stall.refresh();
    if (this.is('Combat', 'Buffs & imbue') && BuffGear.note) BuffGear.note.textContent = BuffGear.status();
    Reports.render();
    const diagnosticState = Diagnostics.sample();
    if (this.waitNote) this.waitNote.textContent = Diagnostics.lines(diagnosticState);
    this.updateOrb(); this.updateWide();
    if (this.townNote) this.townNote.textContent = Town.status();
    if (this.is('Settings') && AutoMastery.note) AutoMastery.note.textContent = AutoMastery.status();
    if (this.is('Settings') && AutoMastery.maxNote) AutoMastery.maxNote.textContent = AutoMastery.maxMessage;
    if (this.is('Settings') && StatPoints.note) StatPoints.note.textContent = StatPoints.status();
    if (this.stuckNote) this.stuckNote.textContent = AntiStuck.status();
    if (this.is('Party') && Trace.note) Trace.note.textContent = Trace.status();
    if (this.is('Party') && this.partyNote) {
      const notes = [Settings.profile.party.autoRecruit ? Party.message : 'Auto-recruit off.'];
      if (Settings.profile.party.joinMain && Party.joinMessage) notes.push(Party.joinMessage);
      if (Settings.profile.party.autoRes) notes.push(Resurrect.message);
      this.partyNote.textContent = notes.join(' ');
    }
    if (this.is('Team') && this.teamNote) {
      this.teamNote.textContent = Team.status();
      const rows = Team.peerRows();
      this.teamPeers.replaceChildren(...(rows.length ? rows.map(text => el('div', text)) : [el('div', 'No other character in the room yet.', 'muted')]));
      if (this.teamUniques) {
        const uniqueRows = TeamKnowledge.uniqueRows();
        this.teamUniques.replaceChildren(...(uniqueRows.length ? uniqueRows.map((text, i) => {
          const name = [...TeamKnowledge.uniques.values()].sort((a, b) => (b.at || 0) - (a.at || 0))[i]?.name;
          const row = el('div', text);
          if (name) row.append(this.button('Hunt here', () => TeamArbiter.huntAtUnique(name)));
          return row;
        }) : [el('div', 'No unique recorded yet; they appear when the server announces one or someone sees one.', 'muted')]));
      }
      if (this.teamPlayers) {
        const playerRows = TeamKnowledge.playerRows();
        this.teamPlayers.replaceChildren(...(playerRows.length ? playerRows.map(text => el('div', text)) : [el('div', 'No other player seen yet.', 'muted')]));
      }
      if (this.teamDrops) {
        const dropRows = TeamKnowledge.dropRows();
        this.teamDrops.replaceChildren(...(dropRows.length ? dropRows.map(text => el('div', text)) : [el('div', 'Nothing picked up yet.', 'muted')]));
      }
    }
    if (!this.status) return;
    if (this.is('Supplies') && this.petPotionNote) this.petPotionNote.textContent = PetPotion.message;
    if (this.is('Supplies') && this.speedNote) this.speedNote.textContent = SpeedScroll.message;
    if (this.is('Loot') && this.petNote) { this.petNote.hidden = !Loot.petMode(); this.petNote.textContent = Loot.petStatus(); }
    Learned.repair();
    if (this.is('Combat') && this.lastSkillKey !== this.skillKey()) { this.draw(); return; }
    const me = World.me(), center = Settings.profile.hunt.center;
    const distance = center ? dist2D(World.pose(), center) : Infinity;
    this.status.textContent = `${World.charName || 'No character'} · ${World.inWorld() ? Controller.mode : World.phase}\nHP ${Math.round(me.hpPct)}% · MP ${Math.round(me.mpPct)}% · Potions ${Potion.count('hp')}/${Potion.count('mp')} · Pickups ${Stats.values.loot}\nHunting spot: ${Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : center ? 'another region' : 'not saved'}${Restock.recording ? '\nRecording route: ' + Restock.draft.route.length + ' points' : ''}`;

    this.refreshers.forEach(refresh => refresh());
    for (const slot of this.pane.querySelectorAll('.slot[data-skill]')) {
      const id = Number(slot.dataset.skill), left = World.cooldownLeft(id), total = World.skill(id)?.cooldownMs || 0;
      slot.querySelector('.cd').style.setProperty('--p', total && left > 0 ? Math.min(100, left / total * 100) + '%' : '0%');
      slot.querySelector('.seconds').textContent = left > 0 ? String(Math.ceil(left / 1000)) : '';
    }
    this.updateSession();
  },
};


/*
===========================================================================

lean-session.js - session window and shared activity history

Both log views read Log's bounded buffer. Opening a view never resets a
session or takes ownership of gameplay.
===========================================================================
*/
const SESSION_FIELDS = [
	[ "state", "Session" ], [ "time", "Hunting time" ], [ "xp", "XP gained" ],
	[ "rate", "XP / hour" ], [ "gold", "Net gold" ], [ "kills", "Confirmed kills" ],
	[ "deaths", "Deaths" ], [ "potions", "Potions used" ], [ "items", "Items picked up" ], [ "sox", "SoX found" ]
];
const SESSION_LIMIT = { delayMs: 60000, bottomTolerance: 4 };

/*
================
UI.activityLog
================
*/
UI.activityLog = function( label ) {
	const log = el( "ol", null, "activity-history" );
	log.setAttribute( "aria-label", label );
	log.tabIndex = 0;
	return log;
};

/*
================
UI.renderActivity

Keep the first visible entry anchored while the reader browses older lines.
Only readers at the bottom follow new entries.
================
*/
UI.renderActivity = function( log ) {
	if ( !log || !log.isConnected || log.hidden ) return;
	log.refreshControls?.();
	if ( log.paused ) { if (log.activityStatus) log.activityStatus.textContent = 'Paused; new activity continues in history.'; return; }
	if ( this.selectedActivityText?.( log ) ) {
		if ( log.activityStatus ) log.activityStatus.textContent = 'Text selected; new activity continues in history.';
		return;
	}
	const viewKey = Activity.revision + ':' + JSON.stringify(Activity.filters);
	if ( log.viewKey === viewKey && log.rendered ) return;
	log.viewKey = viewKey;
	const follow = !log.rendered || log.scrollTop + log.clientHeight >= log.scrollHeight - SESSION_LIMIT.bottomTolerance;
	const top = log.scrollTop;
	const anchor = Array.from( log.children ).find( row => row.offsetTop + row.offsetHeight >= top );
	const offset = anchor ? anchor.offsetTop - top : 0;
	const rows = Activity.visible().map( entry => {
		const row = el( "li", null, entry.level );
		row.entry = entry;
		row.append( el( "time", new Date( entry.at ).toLocaleTimeString( "en-GB" ) ),
			el( "span", (entry.level === "warn" ? "Warning: " : entry.level === "error" ? "Error: " : "") + Activity.userMessage( entry ), "activity-message" ) );
		if ( entry.repeatCount > 1 ) {
			const repeat = el( "span", "×" + entry.repeatCount, "activity-repeat" );
			repeat.setAttribute( "aria-label", "Reported " + entry.repeatCount + " times" ); row.append( repeat );
		}
		return row;
	} );
	log.replaceChildren( ...rows );
	if (log.activityStatus) log.activityStatus.textContent = rows.length + ' events shown';
	log.rendered = true;
	const retained = anchor && rows.find( row => row.entry === anchor.entry );
	log.scrollTop = follow ? log.scrollHeight : retained ? retained.offsetTop - offset : top;
};

/*
================
UI.showSession
================
*/
UI.showSession = function( expandLogs = false ) {
	if ( !this.root ) return;
	if ( !this.sessionBox ) {
		this.sessionFields = {};
		const stats = el( "div", null, "session-values" );
		for ( const [ key, label ] of SESSION_FIELDS ) {
			const value = el( "span" );
			this.sessionFields[key] = value;
			stats.append( this.field( label, value ) );
			value.setAttribute( "aria-label", "Current session: " + label );
		}
		this.sessionLog = this.activityLog( "Session activity" );
		this.sessionLog.id = "session-activity";
		this.sessionLog.hidden = true;
		this.sessionLogPanel = this.activityPanel(this.sessionLog, "Session");
		this.sessionLogPanel.hidden = true;
		this.sessionArrow = this.button( "▼ Show logs", () => {
			this.sessionLog.hidden = !this.sessionLog.hidden;
			this.sessionLogPanel.hidden = this.sessionLog.hidden;
			this.sessionArrow.textContent = this.sessionLog.hidden ? "▼ Show logs" : "▲ Hide logs";
			this.sessionArrow.setAttribute( "aria-expanded", String( !this.sessionLog.hidden ) );
			this.renderActivity( this.sessionLog );
			this.fitWindow( this.sessionBox );
		} );
		this.sessionArrow.setAttribute( "aria-controls", this.sessionLog.id );
		this.sessionArrow.setAttribute( "aria-expanded", "false" );
		this.sessionBox = this.windowFrame( "Current session", () => { this.sessionBox.hidden = true; },
			stats, this.button( "Reset session totals", () => Stats.reset() ),
			el( "p", "Totals pause while stopped or disconnected. Net gold includes town expenses. Closing this window keeps hunting active.", "muted" ),
			this.sessionArrow, this.sessionLogPanel );
		this.sessionBox.classList.add( "session-window" );
		this.root.append( this.sessionBox );
		this.sessionBox.style.left = Math.max( 4, innerWidth - 450 ) + "px";
		this.sessionBox.style.top = "40px";
	}
	this.sessionBox.hidden = false;
	if ( expandLogs && this.sessionLog.hidden ) this.sessionArrow.click();
	this.updateSession();
	this.fitWindow( this.sessionBox );
	this.front( this.sessionBox );
};

/*
================
UI.updateSession
================
*/
UI.updateSession = function() {
	if ( Activity.captureUntil && now() >= Activity.captureUntil ) {
		Activity.capture( false );
	}
	if ( this.current === "Settings" ) this.renderActivity( this.logs );
	if ( this.logList ) this.renderActivity( this.logList );
	if ( !this.sessionBox || this.sessionBox.hidden ) return;
	const values = Stats.display();
	for ( const [ key, value ] of Object.entries( values ) ) {
		if ( this.sessionFields[key] ) this.sessionFields[key].textContent = value;
	}
	this.renderActivity( this.sessionLog );
};

/*
================
UI.potionDelay

Reject invalid text instead of silently replacing the player's last setting.
================
*/
UI.potionDelay = function() {
	const input = el( "input" );
	input.type = "number";
	input.min = 0;
	input.max = SESSION_LIMIT.delayMs;
	input.step = 1;
	input.value = Settings.profile.potion.delayMs;
	input.addEventListener( "change", () => {
		const value = input.value.trim() === "" ? NaN : Number( input.value );
		if ( !Number.isInteger( value ) || value < 0 || value > SESSION_LIMIT.delayMs ) {
			input.value = Settings.profile.potion.delayMs;
			this.toast( "Potion delay must be a whole number from 0 to 60000 ms.", "warn" );
			return;
		}
		Activity.emit({category:'settings', code:'potion-delay-changed', text:'Potion delay changed from ' + Settings.profile.potion.delayMs + ' to ' + value + ' ms.', details:{delayMs:value}});
		Settings.profile.potion.delayMs = value;
		Settings.saveProfile();
	} );
	return this.field( "Potion delay (ms)", input );
};

/*
================
Session event bindings
================
*/
bus.on( "hunt", () => UI.updateSession() );
bus.on( "character", () => UI.updateSession() );


/*
===========================================================================
lean-logging.js - bounded activity events and local diagnostic capture

Normal activity and command traces have separate retention. Events describe
observed evidence; an operation ID never implies a server transaction ID.
===========================================================================
*/
const ACTIVITY_LIMIT = { normal: 400, commands: 1000, text: 1000, repeatMs: 1000, captureMs: 600000 };
const ACTIVITY_CATEGORIES = [ "session", "combat", "movement", "town", "stall", "potion", "loot", "party", "buff", "alchemy", "reconnect", "settings", "engine", "assets" ];
const ACTIVITY_DETAIL_KEYS = [ "durationMs", "distance", "attempt", "quantity", "hpPct", "mpPct", "delayMs", "choice", "errorCode", "goldChange", "kills", "deaths", "potions", "items", "revision", "visited", "progressAgeMs", "monsterId", "skillId", "attackingPlayer", "leg", "legs" ];
const Activity = {
	commands: [], revision: 0, sequence: 0, session: 0, operation: 0, captureUntil: 0,
	filters: { category: "all", level: "all", search: "", detailed: false },
	contexts: {}, states: new Map(), pendingPotions: new Map(), potionCount: 0, potionSummaryAt: 0,

	/*
	================
	category
	Legacy callers keep working while owners migrate to explicit event codes.
	================
	*/
	category( text ) {
		for ( const [ category, pattern ] of [
			[ "alchemy", /alchemy|fusion|elixir|stone fused|destroyed at/i ],
			[ "reconnect", /reconnect|connection lost|login is gone/i ],
			[ "town", /town|warehouse|merchant|repair|reverse|scroll arrival|ammunition/i ],
			[ "buff", /buff gear|buff set|combat gear|buff swap/i ],
			[ "potion", /potion|recovery kit|pet hp/i ],
			[ "loot", /loot|pickup|drop disappeared|collected|sox found/i ],
			[ "party", /party|resurrect|rebirth/i ],
			[ "movement", /move|walking|walk-back|obstacle|trapped|escape|stuck/i ],
			[ "combat", /attack|target|skill refused|rotation/i ],
			[ "assets", /icon|catalogue|map tile|wardrobe/i ],
			[ "session", /hunting started|hunting stopped|bot ready|died:/i ]
		] ) if ( pattern.test( text ) ) return category;
		return "engine";
	},

	/*
	================
	emit
	Logging must not interrupt gameplay or consume confirmation state.
	================
	*/
	emit( event ) {
		try {
			const text = String( event.text || event.code || "Activity" ).slice( 0, ACTIVITY_LIMIT.text );
			const level = [ "info", "warn", "error", "cmd" ].includes( event.level ) ? event.level : "info";
			const category = ACTIVITY_CATEGORIES.includes( event.category ) ? event.category : this.category( text );
			if ( level === "cmd" && now() >= this.captureUntil ) return null;
			const details = {};
			for ( const key of ACTIVITY_DETAIL_KEYS ) {
				const value = event.details?.[key];
				if ( typeof value === "number" && Number.isFinite( value ) || typeof value === "boolean" ) details[key] = value;
			}
			if ( [ "attackers", "nearest", "lowhp" ].includes( event.details?.selectionPolicy ) ) details.selectionPolicy = event.details.selectionPolicy;
			const entry = { id: ++this.sequence, at: Date.now(), mono: now(), lastAt: Date.now(),
				level, category, code: /^[a-z0-9-]{1,64}$/.test( event.code || "" ) ? event.code : "legacy-message",
				text, outcome: [ "requested", "confirmed", "refused", "unconfirmed", "cancelled", "waiting", "summary" ].includes( event.outcome ) ? event.outcome : null,
				sessionId: this.session, epoch: Number.isSafeInteger( World.epoch ) ? World.epoch : null,
				operationId: Number.isSafeInteger( event.operationId ) ? event.operationId : null, details, repeatCount: 1 };
			entry.userText = event.userText ? String( event.userText ).slice( 0, ACTIVITY_LIMIT.text ) : null;
			if ( event.failure && this.safeFailure ) entry.failure = this.safeFailure( event.failure );
			if ( entry.code === "target-selected" ) {
				const name = World.ents.get( details.monsterId )?.name || "a monster";
				entry.userText = "Targeting " + name + (details.attackingPlayer ? " — it’s attacking you." : ".");
			}
			if ( entry.code === "approach-abandoned" ) {
				entry.userText = "Couldn’t reach " + (World.ents.get( details.monsterId )?.name || "the monster") + "; looking for another target.";
			}
			if ( entry.userText ) entry.userText = entry.userText.slice( 0, ACTIVITY_LIMIT.text );
			const rows = event.diagnosticOnly ? this.refusals : level === "cmd" ? this.commands : Log.lines;
			const previous = rows[rows.length - 1];
			if ( previous && previous.code === entry.code && previous.text === text && previous.level === level &&
				previous.category === category && previous.userText === entry.userText && previous.operationId === entry.operationId && previous.sessionId === entry.sessionId &&
				previous.epoch === entry.epoch && previous.outcome === entry.outcome &&
				JSON.stringify( previous.failure ) === JSON.stringify( entry.failure ) &&
				JSON.stringify( previous.details ) === JSON.stringify( details ) && entry.mono - previous.lastMono < ACTIVITY_LIMIT.repeatMs ) {
				previous.repeatCount++;
				previous.lastAt = entry.at;
				previous.lastMono = entry.mono;
				this.revision++;
				return previous;
			}
			entry.lastMono = entry.mono;
			rows.push( entry );
			const limit = event.diagnosticOnly ? 400 : level === "cmd" ? ACTIVITY_LIMIT.commands : ACTIVITY_LIMIT.normal;
			if ( rows.length > limit ) rows.splice( 0, rows.length - limit );
			this.revision++;
			bus.emit( "log", entry );
			return entry;
		} catch { return null; }
	},

	/*
	================
	begin / end
	================
	*/
	begin( category, text ) {
		const id = ++this.operation;
		this.contexts[category] = { id, at: now(), gold: Stats.integer( World.gp?.progression?.gold ) };
		this.emit( { category, code: "operation-start", text, outcome: "requested", operationId: id } );
		return id;
	},
	end( category, text, outcome = "confirmed" ) {
		const context = this.contexts[category];
		if ( !context ) return;
		const gold = Stats.integer( World.gp?.progression?.gold );
		const change = gold !== null && context.gold !== null ? Number( gold - context.gold ) : undefined;
		this.emit( { category, code: "operation-end", text, outcome, operationId: context.id,
			details: { durationMs: now() - context.at, goldChange: Number.isSafeInteger( change ) ? change : undefined } } );
		delete this.contexts[category];
	},

	/*
	================
	transition
	Only changed states are activity, not every controller tick.
	================
	*/
	transition( category, code, text, outcome = "waiting", details = {} ) {
		const key = category + ":" + code;
		const identity = JSON.stringify( [ text, World.epoch, this.contexts[category]?.id ] );
		if ( this.states.get( key ) === identity ) return;
		this.states.set( key, identity );
		if ( this.states.size > 100 ) this.states.delete( this.states.keys().next().value );
		this.emit( { category, code, text, outcome, details, operationId: this.contexts[category]?.id } );
	},

	/*
	================
	capture / visible / clear
	================
	*/
	capture( enabled ) {
		this.captureUntil = enabled ? now() + ACTIVITY_LIMIT.captureMs : 0;
		this.filters.detailed = enabled;
		this.emit( { category: "settings", code: "capture-changed", text: enabled ? "Detailed command capture enabled for 10 minutes; kept locally." : "Detailed command capture stopped." } );
	},
	visible( exporting = false ) {
		const search = this.filters.search.toLowerCase();
		return [ ...Log.lines, ...(this.filters.detailed ? this.commands : []), ...this.refusals ].sort( ( a, b ) => a.id - b.id ).filter( entry =>
			(exporting && entry.failure) || (this.filters.category === "all" || entry.category === this.filters.category) &&
			(this.filters.level === "all" || entry.level === this.filters.level) &&
			(!search || (this.userMessage( entry ) + " " + entry.text + " " + entry.code).toLowerCase().includes( search )) );
	},
	clear() {
		Log.lines.length = 0;
		this.commands.length = 0;
		this.refusals.length = 0; this.refusalGroups.clear();
		this.revision++;
	},

	/*
	================
	observePotions / flushPotions
	Inventory evidence remains separate from the stats owner's counters.
	================
	*/
	observePotions() {
		if ( !World.inWorld() || World.gp?.inventoryPending ) return;
		for ( const [ ref, pending ] of this.pendingPotions ) {
			if ( pending.epoch !== World.epoch ) { this.pendingPotions.delete( ref ); continue; }
			const total = Stats.total( ref ), used = Math.min( pending.count, Math.max( 0, pending.before - total ) );
			if ( used ) {
				this.potionCount += used;
				this.emit( { category: "potion", level: "cmd", code: "potion-consumed", outcome: "confirmed",
					text: "Potion inventory decrease observed after a use request.", details: { ...pending.details, quantity: used } } );
				pending.count -= used; pending.before = total;
				if ( !pending.count ) this.pendingPotions.delete( ref );
			}
			if ( pending.count && now() - pending.at >= 15000 ) {
				this.emit( { category: "potion", code: "potion-unconfirmed", level: "warn", outcome: "unconfirmed", text: "Potion consumption was not confirmed; a late result is still possible." } );
				this.pendingPotions.delete( ref );
			}
		}
		if ( this.potionCount && now() - this.potionSummaryAt >= 30000 ) this.flushPotions();
	},
	flushPotions() {
		if ( !this.potionCount ) return;
		this.emit( { category: "potion", code: "potion-summary", outcome: "summary", text: this.potionCount + " potion consumptions observed since the previous summary.", details: { quantity: this.potionCount } } );
		this.potionCount = 0; this.potionSummaryAt = now();
	},

	/*
	================
	export
	Standard export excludes names, free text, player identities and locations.
	Monster/skill IDs and selection enums provide non-personal diagnostic context.
	Raw local export is a separate explicit preview choice, never an upload.
	================
	*/
	export( raw = false, format = "json" ) {
		const events = this.visible( true ).map( entry => ( { id: entry.id, at: entry.at, lastAt: entry.lastAt,
			level: entry.level, category: entry.category, code: entry.code, outcome: entry.outcome,
			sessionId: entry.sessionId, epoch: entry.epoch, operationId: entry.operationId,
			repeatCount: entry.repeatCount, details: entry.details, ...(entry.failure ? { failure: entry.failure, failureSamples: entry.failureSamples || [] } : {}), ...(raw ? { text: entry.text, userMessage: this.userMessage( entry ) } : {}) } ) );
		if ( format === "text" ) return events.map( entry => new Date( entry.at ).toISOString() + " [" + entry.level + "] [" + entry.category + "] " +
			(entry.outcome || "event") + " " + entry.code + " ×" + entry.repeatCount + (raw ? ": " + entry.text : "") + " " + JSON.stringify( entry.details ) + (entry.failure ? " " + JSON.stringify( { failure: entry.failure, failureSamples: entry.failureSamples || [] } ) : "") ).join( "\n" );
		return JSON.stringify( { version: VERSION, schema: 3, distanceUnits: "game units (10 per metre)", raw, events }, null, 2 );
	},

	/*
	================
	wrap
	Observe successful function returns without changing their result or errors.
	================
	*/
	wrap( owner, name, observe ) {
		const original = owner[name];
		owner[name] = function( ...args ) {
			const result = original.apply( this, args );
			try { observe.call( this, result, ...args ); } catch {}
			return result;
		};
	}
};

/*
================
Log compatibility and shared events
================
*/
Log.command = function( command, text ) {
	const owner = Town.trip ? "town" : /alchemy/.test( command.kind ) ? "alchemy" :
		/pickup/.test( command.kind ) ? "loot" : command.kind === "item-use" ? "potion" :
		command.kind === "move" || WalkBack.active || Chase.s || Trap.run ? "movement" : "combat";
	return Activity.emit( { level: "cmd", category: owner, code: "command-" + command.kind, text,
		outcome: "requested", operationId: Activity.contexts[owner]?.id } );
};
Log.add = function( level, text ) {
	return Activity.emit( { level, text, outcome: level === "cmd" ? "requested" : null } );
};
bus.on( "game-error", text => {
	Activity.refusal( text );
} );
bus.on( "hunt", running => {
	if ( running ) {
		Activity.session++;
		Activity.emit( { category: "session", code: "session-start", text: "Session " + Activity.session + " started; bot " + VERSION + ".", outcome: "confirmed" } );
	} else {
		Activity.observePotions(); Activity.flushPotions();
		Activity.emit( { category: "session", code: "session-summary", text: "Session paused; totals retained.", outcome: "summary", details: Stats.session } );
	}
} );
bus.on( "character", name => {
	if ( Activity.character === name ) return;
	Activity.character = name;
	Activity.pendingPotions.clear();
	Activity.flushPotions();
	Activity.states.clear();
	Activity.contexts = {};
	Activity.emit( { category: "session", code: "character-boundary", text: "Character loaded; subsequent activity belongs to this character." } );
} );
Activity.wrap( Alchemy, "note", function( result, text ) {
	Activity.emit( { category: "alchemy", code: "alchemy-result", text,
		level: /destroyed/i.test( text ) ? "error" : "info", outcome: /^(Success:|Failed at|Destroyed at)|stone (failed|fused)|→/.test( text ) ? "confirmed" : null } );
} );
Activity.wrap( Town, "begin", function() {
	if ( this.trip ) {
		Activity.begin( "town", "Town trip started: " + this.trip.why + "." );
		Activity.transition( "town", "trip-phase", "Town phase: " + this.trip.phase, "waiting", { choice: this.trip.reverseChoice } );
	}
} );
Activity.wrap( Town, "enter", function( result, phase ) {
	Activity.transition( "town", "trip-phase", "Town phase: " + phase, "waiting", { choice: this.trip?.reverseChoice } );
} );
Activity.wrap( Town, "fail", function( result, reason ) { Activity.end( "town", "Town trip stopped: " + reason, "unconfirmed" ); } );
Activity.wrap( Town, "tick", function() {
	if ( !this.trip && Activity.contexts.town ) Activity.end( "town", this.message,
		/hunting resumed/.test( this.message ) ? "confirmed" : "cancelled" );
} );
Activity.wrap( Town, "checkScroll", function() {
	if ( this.trip?.scrollRequest?.accepted ) Activity.transition( "town", "scroll-accepted", "Travel request accepted; waiting for verified arrival.", "confirmed", { choice: this.trip.reverseChoice } );
} );
Activity.wrap( Town, "arrived", function() {
	if ( this.trip ) Activity.emit( { category: "town", code: "town-arrival", text: "Town arrival verified; beginning services.", outcome: "confirmed", operationId: Activity.contexts.town?.id } );
} );
Activity.wrap( Hunt, "chooseTarget", function( target ) {
	if ( target ) Activity.transition( "combat", "target-selected", "Selected target " + target.gid + " by " + this.cfg().priority + " priority.", "requested", {
		distance: dist2D( World.pose(), target ), monsterId: target.gid, selectionPolicy: this.cfg().priority,
		attackingPlayer: (World.simNow() ?? 0) - (World.attackers.get( target.gid ) ?? -Infinity) < 6000
	} );
} );
Activity.wrap( Chase, "abandon", function( result, target, reason ) {
	Activity.emit( { category: "movement", code: "approach-abandoned", level: "warn", text: "Target " + target.gid + ": " + reason, outcome: "unconfirmed", details: { monsterId: target.gid, revision: Navigation.revision, durationMs: now() - this.s.at } } );
} );
Activity.wrap( Stats, "potion", function( result, item ) {
	const ref = item.refObjId, previous = Activity.pendingPotions.get( ref ), me = World.me();
	if ( Activity.pendingPotions.size >= 16 && !previous ) return;
	Activity.pendingPotions.set( ref, { before: previous?.before ?? Stats.total( ref ), count: (previous?.count || 0) + 1,
		at: now(), epoch: World.epoch, details: { hpPct: me.hpPct, mpPct: me.mpPct, delayMs: Settings.profile.potion.delayMs } } );
} );
bus.on( "gameplay", () => Activity.observePotions() );
bus.on( "reset", () => { Activity.pendingPotions.clear(); Activity.states.clear(); } );
/*
================
Settings activity
================
*/
Activity.settingValues = () => ( {
	potion: !!Settings.profile.potion.enabled,
	town: !!Town.cfg().enabled,
	revival: !!Town.cfg().revive,
	detour: !!Hunt.cfg().detour.enabled,
	trap: !!Hunt.cfg().trap.enabled,
	support: !!Settings.profile.party.support.enabled
} );
Activity.savedSettings = Activity.settingValues();
Activity.wrap( Settings, "saveProfile", function() {
	const current = Activity.settingValues();
	for ( const key of Object.keys( current ) ) if ( current[key] !== Activity.savedSettings[key] ) {
		Activity.emit( { category: "settings", code: "toggle-" + key, text: key + " automation " + (current[key] ? "enabled." : "disabled.") } );
	}
	Activity.savedSettings = current;
} );
bus.on( "profile", () => { Activity.savedSettings = Activity.settingValues(); } );
Activity.wrap( Loot, "gained", function( result, item ) {
	if ( result ) Activity.emit( { category: "loot", code: "pickup-confirmed", text: "Inventory gain observed for pickup " + item.gid + ".", outcome: "confirmed" } );
} );
Activity.wrap( WalkBack, "tick", function() {
	Activity.transition( "movement", "walk-back-state", WalkBack.active ? "Walk-back active; waiting for observed arrival." : "Walk-back inactive." );
} );
bus.on( "cast", cast => {
	if ( cast.caster !== World.localGid() ) return;
	Activity.emit( { category: "combat", level: "cmd", code: "cast-observed", text: "Local skill action observed for skill " + cast.skill + ".", outcome: "confirmed" } );
} );
Activity.wrap( BuffGear, "tick", function() {
	if ( this.run && !Activity.contexts.buff ) Activity.begin( "buff", "Buff equipment cycle started." );
	else if ( !this.run && Activity.contexts.buff ) Activity.end( "buff", this.message, this.message === "Combat gear restored." ? "confirmed" : "unconfirmed" );
} );
Activity.wrap( Diagnostics, "sample", function() {
	Activity.observePotions();
	if ( !Town.trip && Activity.contexts.town ) Activity.end( "town", Town.message,
		/stopped/i.test( Town.message ) ? "unconfirmed" : "cancelled" );
	const messages = [ [ "reconnect", Reconnect.message, !!Reconnect.intent ],
		[ "buff", BuffGear.waiting || BuffGear.message, !!BuffGear.run || !!BuffGear.recovery || !!BuffGear.waiting ],
		[ "potion", PetPotion.message, !!PetPotion.cfg().on ],
		[ "movement", Chase.message, !!Chase.s ], [ "party", Party.message, Settings.profile.party.autoRecruit ] ];
	for ( const [ category, text, active ] of messages ) {
		if ( category === "potion" && /^Pet HP \d+%;/.test( text ) ) continue;
		if ( active && text ) Activity.transition( category, "state-change", text, /unconfirmed/i.test( text ) ? "unconfirmed" : "waiting" );
	}
	if ( Hunt.running && !Hunt.targetGid && now() - (Activity.searchAt ?? -Infinity) >= 10000 ) {
		Activity.searchAt = now();
		Activity.transition( "combat", "target-search", "Searching for target: " + Diagnostics.noTarget() );
	}
} );


/*
===========================================================================
lean-log-messages.js - player-facing activity descriptions

Keep technical messages, codes and evidence unchanged for diagnostic exports.
Capture monster names when events occur so despawns cannot rewrite history.
===========================================================================
*/

/*
================
Activity.userMessage
================
*/
Activity.userMessage = function( entry ) {
	if ( entry.userText ) return entry.userText;
	const messages = {
		"character-boundary": "Character loaded.",
		"session-start": "Hunting session started.",
		"session-summary": "Hunting paused. Session totals are saved until you reset or reload.",
		"town-arrival": "Arrived in town; starting town services.",
		"scroll-accepted": "Return travel has started; waiting to arrive.",
		"inventory-confirmed": "Town supplies or inventory updated.",
		"pickup-confirmed": "Picked up loot.",
		"potion-consumed": "Potion used.",
		"pet-kit-consumed": "Pet recovery kit used.",
		"potion-unconfirmed": "Couldn’t confirm potion use yet. The game may still be processing it.",
		"game-refusal": "The game couldn’t complete the request. See the diagnostic export for details."
	};
	// Capture history must describe its original event, not today's filter state.
	if ( entry.code === "capture-changed" ) return /enabled/.test( entry.text ) ? "Detailed logging enabled for 10 minutes." : "Detailed logging stopped.";
	if ( messages[entry.code] ) return messages[entry.code];
	if ( entry.code === "walk-leg" ) return "Walking to the hunting spot: leg " + entry.details.leg + " of about " + entry.details.legs + ".";
	if ( entry.code === "potion-summary" ) return "Potions used since the last update: " + entry.details.quantity + ".";
	if ( entry.code === "trip-phase" ) {
		const phase = entry.text.replace( /^Town phase: /, "" );
		const phases = {
			recall: "Preparing to return to town.", "recall-wait": "Returning to town…",
			"revive-arrival": "Waiting to revive in town.", "walk-storage": "Walking to the warehouse.",
			"open-storage": "Opening the warehouse.", store: "Depositing loot.", "close-storage": "Finished at the warehouse.",
			"walk-vendor": "Walking to the potion merchant.", "open-vendor": "Opening the potion shop.",
			buy: "Buying supplies.", "close-vendor": "Finished buying supplies.",
			"walk-smith": "Walking to the repair merchant.", "open-smith": "Opening the repair shop.",
			sell: "Selling loot.", ammo: "Buying ammunition.", repair: "Repairing equipment.",
			"close-smith": "Finished at the repair merchant.", "walk-gate": "Walking to the return point.",
			"open-gate": "Opening return travel.", reverse: "Preparing to return to the hunting area.",
			"reverse-wait": "Returning to the hunting area…"
		};
		return phases[phase] || "Continuing town services.";
	}
	if ( entry.level === "cmd" ) {
		if ( entry.code === "command-move" ) return "Requesting movement.";
		if ( entry.code === "cast-observed" ) return "Skill use confirmed by the game.";
		return "Requested: " + entry.text;
	}
	if ( entry.code === "target-search" ) return "Looking for a suitable monster.";
	if ( entry.text === "Walk-back active; waiting for observed arrival." ) return "Walking back to the hunting spot.";
	if ( entry.text === "Walk-back inactive." ) return "Walk-back ended.";
	if ( /^Dropped blocked target:/.test( entry.text ) ) return "Couldn’t reach the monster; looking for another target.";
	if ( /^Letting the game approach/.test( entry.text ) ) return "Moving closer to the monster.";
	return entry.text;
};

/*
================
UI.selectedActivityText

Only handle selections contained in one log. Other page selections keep their
normal browser behavior, including copy from inputs and export previews.
================
*/
UI.selectedActivityText = function( expectedLog = null ) {
	const selection = this.root?.getSelection?.() || W.getSelection?.();
	if ( !selection || !selection.rangeCount || selection.isCollapsed ) return "";
	const range = selection.getRangeAt( 0 );
	const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
	const log = node?.closest?.( ".activity-history" );
	if ( !log || expectedLog && log !== expectedLog || log.getRootNode() !== this.root || !log.contains( range.endContainer ) ) return "";
	return selection.toString();
};


/*
===========================================================================
lean-refusals.js - meaningful refusals without routine cooldown warning spam

Cast refusals carry no request ID. Nearby commands are evidence, never an
assertion that a particular skill caused the refusal. Retention is independent
of optional command capture, so standard exports retain these diagnostics.
===========================================================================
*/
const REFUSAL_LIMIT = { recent: 32, ageMs: 3000, groupMs: 30000, stallMs: 15000, warnMs: 60000 };
const REFUSAL_MEANINGS = {
	"cooldown-or-action-recovery": "The skill is still cooling down or the previous skill action is still recovering. The packet does not distinguish which.",
	"unmapped-error": "The game rejected this request type, but this code has not been decoded here.",
	"unclassified-error": "The client reported an error without a recognized request type and numeric code."
};
Activity.refusals = [];
Activity.refusalGroups = new Map();
Activity.recentCommands = [];
Activity.castProgressAt = now();
Activity.refusalWarningAt = -Infinity;

/*
================
Activity.safeFailure

Only enums, bounded command evidence and numbers enter standard exports.
================
*/
Activity.safeFailure = function( value ) {
	const source = [ "cast", "inventory", "unknown" ].includes( value.source ) ? value.source : "unknown";
	const reason = Object.hasOwn( REFUSAL_MEANINGS, value.reason ) ? value.reason : "unclassified-error";
	const numeric = number => Number.isFinite( number ) ? number : null;
	return { source, reason, explanation: REFUSAL_MEANINGS[reason],
		nativeErrorCode: Number.isInteger( value.nativeErrorCode ) ? value.nativeErrorCode : null,
		correlation: "recent-commands-only-not-a-request-match",
		recentCommands: (value.recentCommands || []).slice( -3 ).map( command => ( {
			kind: [ "skill", "attack", "cos-attack", "item-use", "shop-buy", "shop-sell", "storage-move", "inventory-move", "travel-gate" ].includes( command.kind ) ? command.kind : "other",
			ageMs: numeric( command.ageMs ), skillId: numeric( command.skillId ), monsterId: numeric( command.monsterId ),
			localCooldownMs: numeric( command.localCooldownMs )
		} ) ),
		state: { inventoryPending: !!value.state?.inventoryPending, movementPending: !!value.state?.movementPending,
			targetPending: !!value.state?.targetPending, casting: !!value.state?.casting } };
};

/*
================
Activity.refusal

OpenSRO skilladmit.go and skillcost.go return 0x3005 for cooldown/action
recovery. Client combat.ts exposes its low byte as "Cast rejected: 5".
This meaning applies only to that cast channel, never inventory code 5.
================
*/
Activity.refusal = function( message ) {
	const match = String( message ).match( /^(Cast|Inventory) rejected:\s*(\d+)\s*$/i );
	const source = match ? match[1].toLowerCase() : "unknown";
	const code = match ? Number( match[2] ) : null;
	const routine = source === "cast" && code === 5;
	const reason = routine ? "cooldown-or-action-recovery" : match ? "unmapped-error" : "unclassified-error";
	const recentCommands = this.recentCommands.filter( command => command.epoch === World.epoch && command.session === this.session &&
		now() - command.at <= REFUSAL_LIMIT.ageMs && (source !== "cast" || [ "skill", "attack", "cos-attack" ].includes( command.kind )) ).slice( -3 ).map( command => ( {
		...command, ageMs: now() - command.at, localCooldownMs: command.skillId ? World.cooldownLeft( command.skillId ) : null
	} ) );
	const failure = this.safeFailure( { source, reason, nativeErrorCode: source === "cast" && code !== null ? 0x3000 + code : code,
		recentCommands, state: { inventoryPending: World.gp?.inventoryPending, movementPending: World.gp?.pendingMoves,
			targetPending: World.gp?.targetPending, casting: World.isCasting() } } );
	const commandKey = JSON.stringify( recentCommands.map( command => [ command.kind, command.skillId, command.monsterId ] ) );
	const key = JSON.stringify( [ this.session, World.epoch, source, code, routine ? null : commandKey ] );
	const previous = this.refusalGroups.get( key );
	if ( previous && now() - previous.lastMono < REFUSAL_LIMIT.groupMs && (this.refusals.includes( previous ) || Log.lines.includes( previous )) ) {
		previous.repeatCount++; previous.lastAt = Date.now(); previous.lastMono = now(); previous.failure = failure; this.revision++;
		if ( commandKey !== previous.sampleKey ) {
			previous.failureSamples.push( failure );
			if ( previous.failureSamples.length > 8 ) previous.failureSamples.shift();
			previous.sampleKey = commandKey;
		}
	} else {
		const entry = this.emit( { category: source === "cast" ? "combat" : "engine", code: routine ? "cast-not-ready" : "game-refusal",
			level: routine ? "info" : "warn", outcome: "refused", diagnosticOnly: routine, failure,
			text: "Game reported: " + message,
			userText: routine ? "Skill not ready yet." : source === "inventory" ? "The game refused an inventory action (code " + code + ")." : source === "cast" ? "The game refused a skill action (code " + code + ")." : "The game reported an error; details are available in the export.",
			details: { errorCode: code } } );
		if ( entry ) { entry.failureSamples = [ failure ]; entry.sampleKey = commandKey; this.refusalGroups.set( key, entry ); }
	}
	if ( this.refusalGroups.size > 400 ) this.refusalGroups.delete( this.refusalGroups.keys().next().value );
	if ( routine && previous && Hunt.running && now() - previous.mono >= REFUSAL_LIMIT.stallMs &&
		now() - this.castProgressAt >= REFUSAL_LIMIT.stallMs && now() - this.refusalWarningAt >= REFUSAL_LIMIT.warnMs ) {
		this.refusalWarningAt = now();
		this.emit( { category: "combat", code: "cast-readiness-stalled", level: "warn", outcome: "waiting",
			text: "Repeated cast readiness refusals without a recent observed cast.",
			userText: "Skills have not been ready for a while.", failure } );
	}
};

/*
================
Read-only evidence bindings
================
*/
bus.on( "command", command => {
	Activity.recentCommands.push( { at: now(), epoch: World.epoch, session: Activity.session, kind: command.kind,
		skillId: command.kind === "skill" && Number.isInteger( command.skillId ) ? command.skillId : null,
		monsterId: World.ents.get( command.gid )?.kind === "monster" ? command.gid : null } );
	if ( Activity.recentCommands.length > REFUSAL_LIMIT.recent ) Activity.recentCommands.shift();
} );
bus.on( "cast", cast => { if ( cast.caster === World.localGid() ) Activity.castProgressAt = now(); } );
bus.on( "reset", () => { Activity.recentCommands.length = 0; Activity.refusalGroups.clear(); Activity.castProgressAt = now(); } );
bus.on( "character", () => { Activity.recentCommands.length = 0; Activity.refusalGroups.clear(); Activity.castProgressAt = now(); } );


/*
===========================================================================
lean-log-ui.js - filters, reading controls and explicit local export

Both views share filters while retaining independent scroll/pause state.
Export requires a reviewed preview and never uses the report upload endpoint.
===========================================================================
*/

/*
================
UI.activityPanel
================
*/
UI.activityPanel = function( log, label ) {
	const panel = el( "div", null, "activity-panel" ), controls = el( "div", null, "row" );
	const select = ( name, entries, key ) => {
		const input = el( "select" );
		input.setAttribute( "aria-label", label + " log " + name );
		for ( const [ value, text ] of entries ) {
			const option = el( "option", text ); option.value = value; input.append( option );
		}
		input.value = Activity.filters[key];
		input.addEventListener( "change", () => { Activity.filters[key] = input.value; this.updateSession(); } );
		controls.append( input );
		return input;
	};
	const category = select( "category", [ [ "all", "All categories" ], ...ACTIVITY_CATEGORIES.map( key => [ key, key ] ) ], "category" );
	const level = select( "severity", [ [ "all", "All severities" ], [ "info", "Info" ], [ "warn", "Warnings" ], [ "error", "Errors" ], [ "cmd", "Commands" ] ], "level" );
	const search = el( "input" ); search.type = "search"; search.placeholder = "Search activity";
	search.setAttribute( "aria-label", label + " log search" );
	search.addEventListener( "input", () => { Activity.filters.search = search.value.slice( 0, 200 ); this.updateSession(); } );
	const detailed = el( "input" ); detailed.type = "checkbox";
	detailed.addEventListener( "change", () => { Activity.capture( detailed.checked ); this.updateSession(); } );
	const capture = this.field( label + " detailed capture (10 minutes)", detailed );
	const pause = this.button( "Pause log", () => {
		log.paused = !log.paused;
		pause.textContent = log.paused ? "Resume log" : "Pause log";
		this.renderActivity( log );
	} );
	pause.setAttribute( "aria-label", label + " pause or resume log" );
	const follow = this.button( "Follow latest", () => {
		log.paused = false; pause.textContent = "Pause log"; this.renderActivity( log ); log.scrollTop = log.scrollHeight;
	} );
	const clear = this.button( "Clear history", () => {
		if ( clear.armedUntil > now() ) {
			Activity.clear(); clear.armedUntil = 0; clear.textContent = "Clear history"; this.updateSession();
		} else { clear.armedUntil = now() + 5000; clear.textContent = "Confirm clear (5 s)"; }
	} );
	log.activityStatus = el( "span", "", "muted" );
	log.refreshControls = () => {
		category.value = Activity.filters.category; level.value = Activity.filters.level;
		if ( this.root.activeElement !== search ) search.value = Activity.filters.search;
		detailed.checked = Activity.filters.detailed;
		if ( clear.armedUntil && now() >= clear.armedUntil ) { clear.armedUntil = 0; clear.textContent = "Clear history"; }
	};
	panel.append( controls, search, capture, this.row( pause, follow, clear, this.button( "Export preview", () => this.showActivityExport() ) ), log.activityStatus, log );
	return panel;
};

/*
================
UI.showActivityExport
================
*/
UI.showActivityExport = function() {
	if ( !this.activityExportBox ) {
		const preview = this.activityExportText = el( "textarea" );
		preview.readOnly = true; preview.rows = 10; preview.setAttribute( "aria-label", "Activity export preview" );
		const raw = this.activityExportRaw = el( "input" ); raw.type = "checkbox";
		const format = el( "select" );
		for ( const type of [ "json", "text" ] ) { const option = el( "option", type ); option.value = type; format.append( option ); }
		const refresh = () => { preview.value = Activity.export( raw.checked, format.value ); };
		raw.addEventListener( "change", refresh ); format.addEventListener( "change", refresh );
		const download = this.button( "Download preview", () => {
			const url = URL.createObjectURL( new Blob( [ preview.value ], { type: format.value === "json" ? "application/json" : "text/plain" } ) );
			const link = el( "a" ); link.href = url; link.download = "bot-activity." + (format.value === "json" ? "json" : "txt");
			this.root.append( link ); link.click(); link.remove(); setTimeout( () => URL.revokeObjectURL( url ), 1000 );
		} );
		this.activityExportRefresh = refresh;
		this.activityExportBox = this.windowFrame( "Activity export", () => { this.activityExportBox.hidden = true; },
			el( "p", "Standard export omits message text, names and locations. It includes retained refusal diagnostics even when filters hide them. Raw local export may contain private details. Review before sharing. Nothing is uploaded.", "muted" ),
			this.field( "Include raw local messages", raw ), this.field( "Export format", format ), preview,
			this.row( this.button( "Refresh preview", refresh ), this.button( "Select preview to copy", () => { preview.focus(); preview.select(); } ), download ) );
		this.activityExportBox.classList.add( "activity-export" );
		this.root.append( this.activityExportBox );
		this.activityExportBox.style.left = "10px"; this.activityExportBox.style.top = "40px";
	}
	this.activityExportRaw.checked = false;
	this.activityExportBox.hidden = false; this.activityExportRefresh(); this.fitWindow( this.activityExportBox ); this.front( this.activityExportBox );
};


function toggleBot() {
  if (Alchemy.run || Alchemy.pending || Stall.run || Hunt.running || Town.trip || WalkBack.active || Restock.trip || Resurrect.trip || Controller.resumeAfterRevive) stopAll();
  else if (Restock.recording) UI.toast('Finish or cancel route recording before starting the bot.', 'warn');
  else Hunt.start();
}

function boot() {
  if (Setup.isNew()) UI.current = 'Setup';
  UI.mount(); Stats.init(); Updates.start(); Diagnostics.start();
  const unlockSound = e => {
    if (e.isTrusted && (Settings.profile.hunt.pickup.petFullSound || Settings.profile.hunt.pickup.soxSound)) Sound.unlock();
  };
  W.addEventListener('pointerdown', unlockSound, true);
  W.addEventListener('keydown', unlockSound, true);
  // The game listens globally and prevents bound keys even when a shadow-DOM
  // field owns focus. Stop propagation early, but retain native editing defaults.
  const protectEditing = e => {
    const path = e.composedPath(), target = path[0];
    const copyingLog = (e.ctrlKey || e.metaKey) && e.code === 'KeyC' && UI.selectedActivityText();
    if (copyingLog || path.includes(UI.root?.host) && (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || ''))) {
      e.stopImmediatePropagation();
    }
  };
  for (const type of ['keydown', 'keypress', 'keyup']) W.addEventListener(type, protectEditing, true);
  W.addEventListener('copy', e => {
    const text = UI.selectedActivityText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  // Scrolling the panel must not also zoom or move the game camera underneath it.
  W.addEventListener('wheel', e => { if (e.composedPath().includes(UI.root?.host)) e.stopImmediatePropagation(); }, { capture: true, passive: true });
  Combat.init(); Loot.init(); Alchemy.init(); BuffGear.init(); Stall.init();
  bus.on('character', name => {
    const key = name ? 'profile:' + name : 'profile:default';
    if (key !== Settings.profileKey) { Town.lastScrollPoint = null; Town.deathPoint = null; stopAll(); Settings.useCharacter(name); }
  });
  bus.on('profile', () => { PetPotion.reset(); AutoMastery.reset(); StatPoints.reset(); Trace.reset(); BuffGear.reset(); Team.reset(); TeamIntel.reset(); Town.lastScrollPoint = null; Town.deathPoint = null; SpeedScroll.reset(); Party.reset(); Resurrect.reset(); stopAll(); Restock.cancelRecording(); Loot.reset(); Wardrobe.applyNow(); UI.draw(); });
  bus.on('phase', phase => {
    if (phase !== 'world') {
      BuffGear.interrupt('World transition interrupted buff swaps.');
      Party.reset();
      SpeedScroll.reset();
      Resurrect.reset();
      if (Town.phase(phase)) { Loot.reset(); return; }
      const revival = phase === 'entering-world' && Hunt.running && (Town.autoRevive() || Hunt.cfg().onDeath === 'revive') && (Hunt.state === 'dead' || Hunt.revived);
      stopAll(); Restock.cancelRecording(); Loot.reset();
      Controller.resumeAfterRevive = revival;
    }
  });
  bus.on('failure', () => { BuffGear.interrupt('Connection failed during buff swaps.'); stopAll(); Restock.cancelRecording(); UI.toast('Game connection failed; bot stopped.', 'warn'); });
  bus.on('reset', () => {
    BuffGear.interrupt('World reset interrupted buff swaps.');
    if (Town.trip) {
      if (['recall-wait', 'reverse-wait'].includes(Town.trip.phase)) Town.trip.transition = true;
      else Town.fail('Unexpected world reset during town service.');
    }
    SpeedScroll.reset(); Party.reset(); Resurrect.reset(); Loot.reset(); Navigation.scene = null; Wardrobe.inv = Wardrobe.baseInv = Wardrobe.av = Wardrobe.baseAv = null; Wardrobe.body = '';
  });
  bus.on('attached', ({ late }) => { if (late) UI.toast('Attached after the game started. Reload for complete character data.', 'warn'); });
  bus.on('potion-empty', kind => UI.toast('Out of ' + kind.toUpperCase() + ' potions.', 'warn'));
  W.addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || e.isComposing) return;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return;
    if (e.code === 'F8') { e.preventDefault(); e.stopImmediatePropagation(); toggleBot(); }
    else if (e.code === 'F7') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey) UI.toggleVisibility();
      else if (UI.minimised) UI.minimise(false);
      else UI.body.hidden = !UI.body.hidden;
    }
  }, true);
  Ticker.start(() => Controller.tick(), 100);
  setInterval(() => { Wardrobe.tick(); UI.update(); }, 500);
  W.SROLean = { version: VERSION, stats: Stats, updates: Updates, diagnostics: Diagnostics, reports: Reports, alchemy: Alchemy, buffGear: BuffGear, stall: Stall, world: World, settings: Settings, hunt: Hunt, loot: Loot, speedScroll: SpeedScroll, resurrect: Resurrect, team: Team, teamIntel: TeamIntel, teamKnowledge: TeamKnowledge, teamArbiter: TeamArbiter,
    restock: Restock, town: Town, walkBack: WalkBack, antiStuck: AntiStuck, chase: Chase, trap: Trap, autoMastery: AutoMastery, statPoints: StatPoints, share: ProfileShare, trace: Trace, setup: Setup, reconnect: Reconnect, petPotion: PetPotion, navigation: Navigation, route: Route, wardrobe: Wardrobe, wardrobeData: WdData, learned: Learned, controller: Controller, ui: UI, activity: Activity, map: LeanMap, support: Support, items: ItemRules, stop: stopAll, log: Log };
  Log.info('NIX ready. F8 starts/stops; F7 folds; the × minimises; Shift+F7 hides/shows the window.');
}

installWorkerHook();
if (document.documentElement) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });


})();
