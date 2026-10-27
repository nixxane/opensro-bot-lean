// Confirm every native inventory move before casting or restoring combat gear.
const BuffGear = {
  run: null, recovery: null, autoRestore: false, message: 'Buff weapon swapping off.', skipped: new Map(), waiting: '', started: false, bad: new Set(),
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
  // Identical copies are interchangeable, so a skill-driven (auto) set accepts any copy: the equipped one first, then the lowest slot.
  findAny(key) {
    if (!key) return null;
    const matches = this.items().filter(i => this.key(i) === key).sort((a, b) => (a.slot > 7) - (b.slot > 7) || a.slot - b.slot);
    return matches[0] || null;
  },
  lookup(set, key) { return set.auto ? this.findAny(key) : this.find(key); },
  kind(i) { return i ? i.typeFlags >>> 11 & 31 : 0; },
  KIND_NAMES: { 2: 'sword', 3: 'blade', 4: 'spear', 5: 'glaive', 6: 'bow', 7: 'sword', 8: 'two-handed sword', 9: 'axe', 10: 'dark staff', 11: 'staff', 12: 'crossbow', 13: 'dagger', 14: 'harp', 15: 'staff' },
  kindName(kinds) { return [...new Set(kinds.map(k => this.KIND_NAMES[k] || 'weapon type ' + k))].join(' or '); },
  oneHanded(kind) { return [10, 15, 2, 3, 7, 13].includes(kind); },
  // Weapon types the game says this skill needs (admit.weaponKinds: 255 = any, 1 = bare hands), or null when any weapon works.
  // Skills gated by required items (reqi) are judged by the server on those items instead, so they are left alone.
  need(id) {
    const admit = World.skill(id)?.admit;
    if (!admit || admit.reqi || !Array.isArray(admit.weaponKinds)) return null;
    const kinds = admit.weaponKinds.filter(k => k !== 255 && k !== 1);
    return kinds.length ? kinds : null;
  },
  // The skill needs a weapon type the equipped weapon is not.
  mismatch(id) {
    const kinds = this.need(id), w = this.at(6);
    return kinds && this.weapon(w) ? !kinds.includes(this.kind(w)) : false;
  },
  // The skill needs a shield in the off-hand (fire shield and the like), judged from its required item or its name.
  shieldSkill(id) {
    const info = World.skill(id), admit = info?.admit;
    if (!info) return false;
    return !!(admit?.shield || admit?.reqShield || admit?.reqi && /shield/i.test(JSON.stringify(admit.reqi)) || /_SHIELD_/i.test(String(info.code || info.codename || info.name || '')));
  },
  // A shield skill is due while no shield is worn, or a two-handed weapon is.
  shieldMissing(id) { return this.shieldSkill(id) && !this.shield(this.at(7)); },
  // The bag shield to wear for a shield skill: the primary / secondary shield picked on the Items page first.
  pickShield() {
    const gp = World.gp, list = this.items().filter(i => i.slot >= (gp.equipmentSlotCount || 13) && this.shield(i) && (i.durability ?? 1) > 0 && !this.bad.has(this.key(i)));
    list.sort((a, b) => (ItemRules.guarded(b) ? 1 : 0) - (ItemRules.guarded(a) ? 1 : 0) || (b.plus ?? 0) - (a.plus ?? 0) || a.slot - b.slot);
    return list[0] || null;
  },
  auto() { const c = this.cfg(); return !!(c.buffSwap && c.buffAuto); },
  // Buffs the gear cycle owns for the weapon they need, not the weapon someone assigned.
  owns(b) { return this.auto() && !!b.enabled && !b.gearSet && (this.mismatch(Combat.resolve(b)) || this.shieldMissing(Combat.resolve(b))); },
  // The bag weapon to wear for this skill: the highest plus the character can wield, or why there is none.
  pick(kinds) {
    const gp = World.gp, level = gp?.progression?.level;
    const list = this.items().filter(i => i.slot >= (gp.equipmentSlotCount || 13) && this.weapon(i) && kinds.includes(this.kind(i)) &&
      (i.durability ?? 1) > 0 && !this.bad.has(this.key(i)) && !(level >= 0 && Town.requiredLevel(i) > level));
    // The secondary weapon chosen on the Items page comes first, then the highest plus.
    const chosen = i => ItemRules.guarded(i) ? 1 : 0;
    list.sort((a, b) => chosen(b) - chosen(a) || (b.plus ?? 0) - (a.plus ?? 0) || a.slot - b.slot);
    return list[0] || null;
  },
  setup() { return { weapon: this.key(this.at(6)), shield: this.key(this.at(7)), auto: true }; },
  matches(set) { return set.weapon === this.key(this.at(6)) && set.shield === this.key(this.at(7)); },
  signature() { return JSON.stringify([this.cfg().buffSwap, this.cfg().buffAuto, this.cfg().buffSets, this.cfg().buffs]); },
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
    this.run = this.recovery = null; this.skipped.clear(); this.bad.clear();
    this.message = 'Buff gear reset. Check equipped weapons after reconnecting.';
  },
  // Dying or changing world mid-swap is not a failure: remember the combat gear and put it back on once alive again.
  interrupt(text, soft = false) {
    if (!this.run) return;
    if (!soft) return this.fail(text);
    this.recovery = this.run.home; this.autoRestore = true; this.run = null;
    this.message = text + ' Combat gear is restored once the character is back.';
  },
  fail(text) {
    this.autoRestore = false;
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
  // Called every tick: a swap cut short by death or a world change puts the combat weapon back by itself.
  resume() {
    if (this.autoRestore && this.recovery && !this.run) this.restore(true);
  },
  restore(auto = false) {
    if (this.run || !this.recovery || !World.inWorld() || World.isDead() || World.gp?.inventoryPending || World.isCasting()) return;
    if (!auto && Hunt.running || Town.trip || WalkBack.active || Restock.trip || Alchemy.run || Alchemy.pending) return UI.toast('Stop hunting and travel before restoring gear.', 'warn');
    this.run = this.create(this.recovery, []); this.run.restoring = true; this.recovery = null; this.autoRestore = false;
  },
  create(home, queue) {
    return { home, queue, restoring: false, pending: null, cast: null, effects: [],
      at: now(), manualAt: Manual.lastAt, character: World.charName, profile: Settings.profile, signature: this.signature() };
  },
  due(b, auto) {
    if (!b.enabled || !b.gearSet && !auto) return 0;
    const id = Combat.resolve(b), info = World.skill(id);
    if (!id || !info || info.targetRequired && !(info.targets & 1) || Combat.blocked(id) || !Cmd.canCast(id) || !Combat.mpOk(id, World.me())) return 0;
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
    // Buffs without an assigned set wear whichever bag weapon their skill requires; buffs sharing a weapon share one swap.
    const wait = text => { this.waiting = text; return false; };
    const home = this.setup();
    let note = '';
    if (this.auto()) {
      const byWeapon = new Map();
      for (const b of this.cfg().buffs) {
        if (!this.owns(b)) continue;
        const id = this.due(b, true);
        if (!id) continue;
        const wantShield = this.shieldMissing(id);
        let kinds = this.need(id), weapon;
        if (wantShield) {
          // A shield only goes with a one-handed weapon: keep the worn one if it is, otherwise wear a one-handed bag weapon.
          const worn = this.at(6);
          kinds = kinds ? kinds.filter(k => this.oneHanded(k)) : [];
          weapon = this.weapon(worn) && this.oneHanded(this.kind(worn)) && (!kinds.length || this.need(id)?.includes(this.kind(worn))) ? worn : this.pick(kinds.length ? kinds : [10, 15, 2, 3, 7, 13]);
          if (!this.pickShield()) { note = `${World.skillName(id)} needs a shield, and none you can use is in your bag.`; continue; }
        } else weapon = this.pick(kinds);
        if (!weapon) { note = `${World.skillName(id)} needs a ${this.kindName(kinds)}, and none you can use is in your bag.`; continue; }
        const key = this.key(weapon) + (wantShield ? ':shield' : '');
        if (!byWeapon.has(key)) {
          const shield = wantShield ? this.key(this.pickShield()) : this.oneHanded(this.kind(weapon)) && this.shield(this.at(7)) ? home.shield : null;
          byWeapon.set(key, { set: { id: 'auto:' + key, name: weapon.name || Items.name(weapon.refObjId), auto: true, weapon: this.key(weapon), shield }, buffs: [] });
        }
        byWeapon.get(key).buffs.push({ b, id });
      }
      queue.push(...byWeapon.values());
    }
    if (!queue.length) { this.waiting = note; return false; }
    // A buff is due, so say why the swap cannot start instead of waiting silently.
    if (!this.weapon(this.at(6))) return wait('Equip your combat weapon before hunting.');
    for (const set of [home, ...queue.map(q => q.set)]) {
      const name = set === home ? 'your combat gear' : set.auto ? set.name : 'the saved set "' + set.name + '"';
      if (!this.lookup(set, set.weapon)) return wait(`Cannot find ${name}: its weapon is not in your bag or equipped (or two copies look identical). Save the buff set again.`);
      if (!this.weapon(this.lookup(set, set.weapon))) return wait(`${name} is not a weapon any more. Save the buff set again.`);
      if (set.shield && (!this.lookup(set, set.shield) || set !== home && !this.shield(this.lookup(set, set.shield)))) return wait(`Cannot find the shield of ${name} (or two copies look identical). Save the buff set again.`);
    }
    // A weapon swaps places with its bag copy, so it needs no space. Only taking the off-hand item off (shield, arrows) needs one free bag slot.
    let offhand = this.key(this.at(7)), stash = false;
    for (const set of [...queue.map(q => q.set), home]) { if (offhand && offhand !== set.shield) stash = true; offhand = set.shield; }
    if (stash && World.freeBagSlots() < 1) return wait('Buff swaps need one free bag slot to take off your shield.');
    this.waiting = note;
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
    const weapon = this.lookup(set, set.weapon), shield = this.lookup(set, set.shield);
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
    if (!World.inWorld() || World.isDead()) { this.interrupt('World change or death interrupted buff swaps.', true); return false; }
    if (Manual.lastAt !== r.manualAt) { this.fail('Manual control interrupted buff swaps.'); return true; }
    if (now() - r.at > 120000) { this.fail('Buff gear cycle timed out.'); return true; }
    if (!Hunt.running || r.signature !== this.signature()) this.cancel();
    if (r.pending) {
      const p = r.pending;
      if (!gp.inventoryPending && this.key(this.at(p.destination)) === p.from && this.key(this.at(p.source)) === p.to) r.pending = null;
      else {
        const item = this.at(p.source) || this.at(p.destination), what = item ? item.name || Items.name(item.refObjId) : 'an item';
        // Nothing moved and nothing is pending: the game refused it (level, class). Skip that weapon, put gear back, carry on.
        const refused = !gp.inventoryPending && now() - p.at > 2000 && this.key(this.at(p.source)) === p.from && this.key(this.at(p.destination)) === p.to;
        if (refused && !r.restoring && r.queue[0]?.set.auto && p.destination === 6) {
          this.bad.add(p.from); r.pending = null; r.queue.shift();
          r.refused = `The game would not equip ${what}; another weapon is tried next time.`; this.message = r.refused + ' Restoring combat gear.';
          return true;
        }
        if (now() - p.at > 15000) {
          if (r.queue[0]?.set.auto && p.destination === 6) this.bad.add(p.from);
          this.fail(`Equipment move unconfirmed (${what}, slot ${p.source} to ${p.destination}); no retry sent.`);
        }
        return true;
      }
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
      if (this.message === 'Restoring combat gear.') this.message = (r.refused ? r.refused + ' ' : '') + 'Combat gear restored.';
      this.run = null; this.recovery = null; return true;
    }
    const q = r.queue[0];
    this.message = 'Equipping ' + q.set.name + ' for buffs.';
    if (!this.equip(q.set)) return true;
    const entry = q.buffs[0];
    if (!entry) { r.queue.shift(); return true; }
    if (!this.due(entry.b, q.set.auto)) { q.buffs.shift(); return true; }
    if (Combat.cast(entry.id, World.skill(entry.id)?.targetRequired ? World.localGid() : 0)) {
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
  // Enabled buffs the cycle wears a weapon for on its own, with the bag weapon it would pick.
  autoList() {
    if (!this.auto()) return [];
    return this.cfg().buffs.filter(b => this.owns(b)).map(b => {
      const id = Combat.resolve(b), kinds = this.need(id), w = this.pick(kinds);
      return { name: World.skillName(id), left: World.buffRemaining(id), kinds: this.kindName(kinds), weapon: w && (w.name || Items.name(w.refObjId)), skip: this.skipped.get(b.group) };
    });
  },
  status() {
    if (this.run || this.recovery) return this.message;
    if (!this.cfg().buffSwap) return 'Buff weapon swapping off.';
    const sets = this.cfg().buffSets, list = this.assigned(), auto = this.autoList();
    if (!auto.length && !sets.length) return 'Buff weapon swapping is on, but no buff set is saved yet. Equip the buff weapon and press Save equipped buff set.' + (this.cfg().buffAuto ? ' Buffs that need a different weapon than yours are swapped automatically; none do right now.' : '');
    if (!auto.length && !list.length) return 'Buff weapon swapping is on, but no buff skill is assigned to a set yet. Use Gear for <skill> under your buffs.';
    const lines = [];
    for (const a of auto) {
      if (a.skip && a.skip.signature === this.signature() && now() < a.skip.until) lines.push(`${a.name}: skipped because ${a.skip.why}.`);
      else if (!a.weapon) lines.push(`${a.name}: needs a ${a.kinds}, and none you can use is in your bag.`);
      else if (a.left > 0) lines.push(`${a.name}: active, ${Math.ceil(a.left / 1000)} s left; your ${a.weapon} is worn for it when it is about to end.`);
      else lines.push(`${a.name}: due now; your ${a.weapon} is worn for it.`);
    }
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
    box.append(UI.check('Swap weapons for buffs', () => this.cfg().buffSwap, v => this.cfg().buffSwap = v),
      UI.check('Wear the weapon each buff needs (from your bag)', () => this.cfg().buffAuto, v => this.cfg().buffAuto = v),
      el('p', 'With both on, a buff your weapon cannot cast is cast with a matching weapon from your bag, then your combat weapon and shield come back. Saved sets below are only for buffs you assign to one. Keep one bag slot free. Buffs tied to the removed weapon may end.', 'muted'));
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
  Settings.profile.macro.buffs = original.filter(b => !b.gearSet && !BuffGear.owns(b));
  try { return normalBuffs.call(this, hunting); }
  finally { Settings.profile.macro.buffs = original; }
};
