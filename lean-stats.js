// Page-local hunting session. No persistence, uploads or gameplay commands.
const Stats = {
  values: { loot: 0, casts: 0, potions: 0, deaths: 0 },
  session: { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0, star: 0, moon: 0, sun: 0 },
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
    this.session = { ms: 0, xp: 0n, gold: 0n, kills: 0, deaths: 0, potions: 0, items: 0, sox: 0, star: 0, moon: 0, sun: 0 };
    this.lastAt = now(); this.active = false; this.baseline = null; this.startedAt = null;
    this.dead = World.isDead(); this.pendingXP = []; this.xpPartial = this.xpKnown = this.goldKnown = false;
    this.potions = []; this.potionTotals.clear();
    this.sample(); this.render();
  },
  huntStart() { this.startedAt ??= Date.now(); this.sample(); this.loadLevels(); Loot.ensureCatalogue(); },
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
    const name = a.name || Items.name(a.ref), label = ['Star', 'Moon', 'Sun'][tier - 1];
    this.session.sox++; this.session[label.toLowerCase()]++;
    const P = Hunt.cfg().pickup;
    // The notice and sound can be kept for the rarer tiers only (e.g. Sun only); every pickup still counts.
    if (!P.soxSound || tier < 1 + ['star', 'moon', 'sun'].indexOf(P.soxSoundFrom)) return;
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
      kills: this.number(s.kills), deaths: this.number(s.deaths), potions: this.number(s.potions), items: this.number(s.items), sox: this.number(s.sox),
      star: this.number(s.star), moon: this.number(s.moon), sun: this.number(s.sun) };
  },
  draw(parent) {
    const box = UI.group('Session stats'); this.fields = {};
    for (const [key, label] of [['state','Session'],['time','Hunting time'],['xp','XP gained'],['rate','XP / hour'],['gold','Net gold'],['kills','Confirmed kills'],['deaths','Deaths'],['potions','Potions used'],['items','Items picked up'],['sox','SoX found'],['sun','Seal of Sun'],['moon','Seal of Moon'],['star','Seal of Star']]) {
      const value = el('span'); value.setAttribute('aria-label', label); this.fields[key] = value;
      const row = el('div', null, 'field'); row.append(el('span', label), value); box.append(row);
    }
    box.append(UI.button('Reset session', () => this.reset()),
      el('p', 'Local to this page; pauses while hunting is stopped or disconnected. Reset or reload clears totals. Town trips count while hunting stays enabled. Gold includes purchases and repairs. Kills require your or your pet’s fatal result; item counts use confirmed bot pickups; SoX found counts confirmed pickups of Star, Moon and Sun gear, with each seal counted below it. HP, MP, vigor and cure uses require inventory confirmation. XP/hour appears after 30 seconds; partial means a level transition or missing data is unresolved.', 'muted'));
    parent.append(box); this.render();
  },
  render() {
    if (!UI.is('Settings')) return;
    const data = this.display();
    for (const [key, value] of Object.entries(data)) if (this.fields[key]) this.fields[key].textContent = value;
  },
};
