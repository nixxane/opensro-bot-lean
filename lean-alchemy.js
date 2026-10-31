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
// Enhancement attempts one run may make. A run also stops at the target, or when the elixirs, powder or stones run out.
const ALCHEMY_MAX_ATTEMPTS = 9999;
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
  // The first attribute below its wanted value that has a bag stone of the item's degree. Attributes without one are
  // passed over (`skipped`), so the others are still done; with none left to fuse, `missing` names the stones that ran out.
  nextAttr(item, cfg = this.cfg()) {
    const degree = this.degree(item), skipped = [];
    for (const a of this.attributes(this.kind(item))) {
      const target = this.attrTarget(a.name, cfg);
      if (!target || this.attrValue(item, a.index) >= target) continue;
      const ref = ALCHEMY_DATA.attrStones[a.name] + degree - 1;
      const stone = World.items().find(i => i.refObjId === ref && (i.typeFlags & 0xfffe) === 0x15ec && i.quantity > 0 && i.slot >= 13);
      if (stone) return { attr: a, item: stone, skipped };
      skipped.push(a.name);
    }
    if (!skipped.length) return null;
    const names = skipped.map(name => ATTRIBUTE_LABEL[name]);
    return { missing: `No ${names.length > 1 ? names.slice(0, -1).join(', ') + ' or ' + names.at(-1) : names[0]} stone of degree ${degree} in the bag.`, skipped };
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
  // The game takes an Astral charge only while the weapon has more Immortal charges than Astral ones (refusal 0x24),
  // so an Immortal stone goes first when needed, even below Immortal's own plus or with Immortal not ticked.
  nextStone(item, cfg = this.cfg(), plus = Infinity) {
    const degree = this.degree(item);
    const bagStone = kind => World.items().find(i => i.refObjId === STONES[kind].base + degree - 1 && (i.typeFlags & 0xfffe) === 0x3dec && i.quantity > 0 && i.slot >= 13);
    for (const kind of this.wanted(cfg).filter(k => plus >= this.from(k, cfg))) {
      const want = this.keep(kind, cfg), have = this.attributeCount(item, STONES[kind].option);
      if (have >= want) continue;
      const immortal = this.attributeCount(item, STONES.immortal.option);
      if (kind === 'astral' && immortal <= have) {
        const stone = bagStone('immortal');
        return stone ? { kind: 'immortal', item: stone, count: immortal, forAstral: true } : { missing: 'immortal', forAstral: true };
      }
      const stone = bagStone(kind);
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
    if (!Number.isInteger(c.target) || c.target < 1 || c.target > 250 || !Number.isInteger(c.limit) || c.limit < 1 || c.limit > ALCHEMY_MAX_ATTEMPTS) return reject(`Set target + from 1 to 250 and attempts from 1 to ${ALCHEMY_MAX_ATTEMPTS}.`);
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
      stonesUsed: { luck: 0, steady: 0, immortal: 0, astral: 0 }, nextAt: now(), opening: null, skipped: [] };
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
      for (const name of next.skipped.filter(name => !(r.skipped ||= []).includes(name))) {
        r.skipped.push(name);
        this.note(`No ${ATTRIBUTE_LABEL[name]} stone of degree ${this.degree(item)} in the bag; going on with ${ATTRIBUTE_LABEL[next.attr.name]}.`);
      }
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
    if (need?.missing) return this.stop(`No ${STONES[need.missing].label} stone of degree ${this.degree(item)} in the bag` + (need.forAstral ? '; each Astral charge needs an Immortal charge first.' : '.'));
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
        this.message = `Fusing a ${STONES[need.kind].label} stone${need.forAstral ? ' (the next Astral charge needs it)' : ''}: waiting for the server result.`;
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
      UI.number('Maximum attempts', () => c().limit, n => c().limit = n, 1, ALCHEMY_MAX_ATTEMPTS),
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
      el('p', 'Each stone adds a charge to the item, up to 6. Tick Use for the stones you want. Before every attempt at or above the plus you set, if the item has fewer charges than you asked to keep, one is fused automatically from a stone of the item\'s degree in your bag. Luck adds 5% to the chance, Steady stops the durability damage and Immortal stops the destruction when an enhancement fails from +5, and Astral keeps +4 instead of resetting to 0. Each Astral charge needs an Immortal charge, so an Immortal stone is fused first when the weapon needs one, even with Immortal not ticked. A fusion can fail and use up the stone. Stops if a stone is missing, the game refuses, or when it reaches the fusion limit above (off by default). Fuse stones now ignores the plus and only fills the charges.', 'muted'));
    UI.pane.append(stones);
    const attrs = UI.group('Item attributes (stat percentages)');
    UI.attrRows = el('div'); UI.attrNote = el('p', '', 'muted'); attrs.append(UI.attrRows, UI.attrNote);
    attrs.append(UI.number('Stop after this many attribute stones', () => c().attr.limit, n => c().attr.limit = n, 1, 1000),
      UI.row(UI.button('Fuse attribute stones', () => this.startAttributes()), UI.button('Stop', () => this.stop())),
      el('p', 'Pick the lowest percentage you want for each stat of the item selected above, then start. The bot fuses attribute stones of the item\'s degree until every picked stat reaches its target, working down the list. A stat whose stones run out, or that has none in the bag, is passed over and the next one is done; it stops when no picked stat below its target has stones left. Every successful fusion rolls the stat again, so it can also come out lower, and it can re-roll another stat of the item. The chance is 50% per stone before bonuses, and the higher steps get rare fast: 80% and 100% can take hundreds of stones. The item\'s own limit may stop it ever reaching the higher steps, so set a stone limit.', 'muted'));
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
