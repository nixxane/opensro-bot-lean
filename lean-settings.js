const DISCORD_URL = 'https://discord.gg/Y5H5ZyfQ7u';
const NOTES_URL = 'https://nixxane.github.io/opensro-bot-lean-site/#patch-notes';
const CLASS_KEYS = ['normal', 'champion', 'giant', 'party', 'elite', 'unique'];
const DEFAULT_PROFILE = {
  items: { rules: {}, balance: false, gear: { primaryWeapon: null, secondaryWeapon: null, shield: null } },
  stall: { title: '', greeting: '', network: true, closeWhenEmpty: true, prices: {} },
  alchemy: { target: 3, limit: 20, elixir: 0, powder: false, use: { luck: false, steady: false, immortal: false, astral: false }, stones: { luck: 1, steady: 1, immortal: 1, astral: 1 }, stoneLimit: 0,
    // The plus from which each helper is used: a failure from +5 up can destroy the item (Steady and Immortal matter from there),
    // Luck and lucky powder help at every plus, and Astral keeps +4 on a failure.
    from: { powder: 0, luck: 0, steady: 5, immortal: 5, astral: 4 },
    // Attribute percentages: the lowest variance value (0 to 31) wanted per NATTR_ name, 0 or missing = leave it alone.
    attr: { targets: {}, limit: 100 } },
  statPoints: { enabled: false, str: 1, int: 0, reserve: 0 },
  // Auto Quest: learned tokens bind a quest codename (QNO_...) to its refId, and learned targets
  // name the monster types whose kills advance each refId. Both fill themselves while playing.
  quest: { on: false, accept: true, include: '', exclude: '', skip: [], learned: {}, targets: {} },
  trade: { from: 'CH', to: 'WC', trips: 1, potions: true, goods: 0 },
  trace: { enabled: false, name: '', distance: 12, fight: true },
  mastery: { enabled: false, ids: [], gap: 0, skills: false, scope: 'rotation', reserve: 0, order: 'masteries' },
  lure: { enabled: false, points: [], taunt: { id: 0, group: 0 }, area: { id: 0, group: 0 }, holdS: 10, pauseEveryM: 10, pauseS: 4, radius: 15, returnHpPct: 50, stopAt: 0 },
  pet: { attack: { on: false, recall: true, radius: 15, timeout: 3, resend: 5 } },
  scroll: { damageInc: false, damageAbs: false },
  mall: { on: false, budgetSilk: 0, hp: { on: false, low: 10, target: 1000 }, mp: { on: false, low: 10, target: 1000 }, damageInc: { on: false, low: 5, target: 20 }, damageAbs: { on: false, low: 5, target: 20 }, reverse: { on: false, low: 10, target: 50 } },
  party: { autoAcceptMatching: false, autoRecruit: false, joinMain: false, mainName: '', leaveIfNotLeader: false, acceptNames: '', autoRes: false, acceptRes: false, resRadius: 300, title: 'Hunting party', min: 1, max: 90, purpose: 0, expShare: true, itemShare: true,
    support: { enabled: false, whileStopped: false, range: 30, heal: { id: 0, group: 0, pct: 60, self: false }, group: { id: 0, group: 0, pct: 60, count: 2 }, buffs: [] } },
  wardrobe: { on: true, phantom: true, realAnim: true, hideAvatars: false,
    eq: {}, av: {}, pet: { atk: 0, pick: 0, mount: 0 }, presets: {}, undo: null },
  macro: {
    rotations: { normal: [], champion: [], giant: [], party: [], elite: [], unique: [] },
    fallbackToNormal: true, normalAttack: true, buffs: [], imbue: null, buffSwap: false, buffAuto: true, buffSets: [],
    imbueBeforeAttack: true, berserkClasses: { normal: false, champion: false, giant: true, giantParty: false, party: false, elite: false, unique: false, titan: false },
    minMpPct: 0, castGapMs: 350,
  },
  potion: {
    enabled: true, speedScroll: false, repairHammer: { on: false, pct: 50 }, hp: { on: true, pct: 60 }, mp: { on: true, pct: 40 },
    vigor: { on: true, hpPct: 30, mpPct: 15 }, cure: { on: true }, petHp: { on: false, pct: 50 }, petHgp: { on: false, pct: 30 },
    prefer: { hp: 0, mp: 0, vigor: 0, cure: 0 }, delayMs: 350,
    restock: {
      enabled: false, vendor: null, route: [], offers: [],
      town: { enabled: false, revive: true, revivePet: false, deathReturn: 'recall', returnBy: 'reverse', storeSox: true, sellStar: false, sellBag: false, storeLevels: '', petFull: true, petFree: 1, arrivalRadius: 500,
        broken: true, wear: { on: false, pct: 15 }, noXp: { on: false, minutes: 10 }, every: { on: false, minutes: 60 }, arrival: null, storage: null, vendor: null, smith: null, gate: null,
        keep: '', store: { equipment: true, elixirs: true, powders: true, alchemy: true, others: false } },
      hp: { on: true, refObjId: 0, low: 20, target: 100 },
      mp: { on: true, refObjId: 0, low: 20, target: 300 },
      cure: { on: false, refObjId: 58, low: 10, target: 50 },
      vigor: { on: false, refObjId: 22, low: 10, target: 50 },
      reverse: { on: false, refObjId: 3795, low: 10, target: 50 },
      hgp: { on: false, refObjId: 0, low: 5, target: 50 },
      kit: { on: false, refObjId: 0, low: 5, target: 50 },
      ammo: { arrow: { on: false, low: 200, target: 2000 }, bolt: { on: false, low: 200, target: 2000 } },
    },
  },
  hunt: {
    levelSpots: { on: false, list: [] },
    center: null, radius: 400, chase: 700, returnToCenter: true, travel: true, attack: true,
    classes: { normal: true, champion: true, giant: true, party: false, elite: false, unique: false, titan: false },
    levelMin: 0, levelMax: 0, include: '', exclude: '', priority: 'attackers', avoidKs: true,
    targetTimeoutS: 25,
    pickup: { enabled: true, soxOnly: false, gold: true, potions: true, equipment: true, elixirs: true, powders: true, magicStones: true, attrStones: true, alchemy: true, others: true,
      collector: 'character', by: {}, petFullSound: true, soxSound: true, include: '', exclude: '', radius: 300, afterKillOnly: true, retries: 2 },
    sit: { enabled: true, hpBelow: 35, mpBelow: 20, resumeAt: 90 },
    antiStuck: { enabled: true, minutes: 3, maxRecoveries: 3 },
    detour: { enabled: true, stallMs: 2500 },
    trap: { enabled: true, seconds: 20, recall: false, diagnostics: false },
    onDeath: 'stop', stopNoHpPotion: false, stopInvFull: false, autoStart: false, retry: false,
    playerAlert: { enabled: false, radius: 250, pause: false }, manualPauseS: 6,
  },
};
// Preserve only bot settings. The original assistant's settings are never changed.
function botProfile(input) {
  const result = deepMerge(DEFAULT_PROFILE, {});
  if (!input || typeof input !== 'object') return result;
  for (const key of ['macro', 'potion', 'hunt', 'lure', 'pet', 'scroll', 'mall', 'wardrobe', 'party', 'alchemy', 'mastery', 'statPoints', 'trace', 'items', 'trade', 'stall', 'quest']) {
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
  if (!['reverse', 'walk'].includes(result.potion.restock.town.returnBy)) result.potion.restock.town.returnBy = 'reverse';
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
  // Party Giants used to follow the Party monsters switch.
  const savedBerserk = input.macro?.berserkClasses;
  if (savedBerserk && typeof savedBerserk === 'object' && !('giantParty' in savedBerserk)) result.macro.berserkClasses.giantParty = savedBerserk.party === true;
  // Magic and attribute stones used to sit in the alchemy switch, so they keep its setting.
  for (const key of ['magicStones', 'attrStones']) {
    if (pickup && !(key in pickup)) result.hunt.pickup[key] = pickup.alchemy ?? pickup.others ?? true;
  }
  // Helper stones used to be on when their count was above zero; now each has a switch and a count of at least 1.
  const oldStones = input.alchemy?.stones;
  if (oldStones && !input.alchemy?.use) for (const key of Object.keys(result.alchemy.use)) {
    const n = Number(oldStones[key]) || 0; result.alchemy.use[key] = n > 0; result.alchemy.stones[key] = Math.min(6, Math.max(1, n));
  }
  // A character wears one shield: the old primary and secondary shield become that one, the primary first.
  const gear = result.items.gear, oldGear = input.items?.gear;
  if (oldGear && typeof oldGear === 'object' && !('shield' in oldGear)) gear.shield = [oldGear.primaryShield, oldGear.secondaryShield].find(k => typeof k === 'string' && k) || null;
  delete gear.primaryShield; delete gear.secondaryShield;
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
  tones: { 'pet-full': { notes: [659.25, 830.61, 987.77], gap: 0.18 }, sox: { notes: [783.99, 987.77, 1174.66, 1567.98], gap: 0.11 } },
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
