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
    if (ItemRules.guarded(item)) return false; // the chosen primary / secondary gear stays put
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
    if (item.tooltip?.fields?.canSell === 0 || ItemRules.guarded(item)) return false;
    // Pet summon scrolls and flutes (TID1 3, TID2 2): the pet itself. The merchant buys every one of them, and players
    // keep other pets' scrolls in the pickup pet, so they are never sold, not even with a Sell rule.
    if (!Number.isInteger(item.typeFlags) || (item.typeFlags & 124) === 76) return false;
    const act = ItemRules.get(item.refObjId)?.act;
    if (act) return act === 'sell';
    return this.disposable(item) && !this.kept.includes(Loot.category(item.typeFlags));
  },
  // From the bag, never what the trip itself needs, the weapon chosen for alchemy or a saved buff set's gear.
  // The bag holds the player's own things, not just drops: without a Sell rule only ordinary Chinese / European
  // weapons, armour, shields and accessories are sold. Pet summon scrolls, avatars, devil spirits, job suits,
  // fortress weapons, item mall and event items, tablets, powders and anything with an unknown codename stay.
  sellableBag(item) {
    if (this.needed(item) || Alchemy.selected && Alchemy.selected.slot === item.slot) return false;
    const key = BuffGear.key(item);
    if (BuffGear.cfg().buffSets.some(s => s.weapon === key || s.shield === key)) return false;
    if (!this.sellable(item)) return false;
    return ItemRules.get(item.refObjId)?.act === 'sell' || this.plainGear(item);
  },
  // Ordinary race gear: equipment of TID3 1-6 or 9-12 (garments to accessories; 7 is job suits, 13 avatars and
  // devil spirits) with an ITEM_CH_ / ITEM_EU_ codename.
  // The codename comes from the item catalogue; until it has loaded nothing is sold from the bag.
  plainGear(item) {
    Loot.ensureCatalogue();
    const tf = item.typeFlags, code = item.codename || Items.data?.get(item.refObjId)?.code || '';
    return Number.isInteger(tf) && ItemType.isEquipment(tf) && [1, 2, 3, 4, 5, 6, 9, 10, 11, 12].includes((tf >>> 7) & 15) &&
      /^ITEM_(CH|EU)_/.test(code);
  },
  // Whether a trip could empty any of the pet's slots (sell or store something). A pet full of protected items would
  // otherwise send the bot to town again and again for nothing.
  petClearable(pet) { return pet.rec.inventory.some(i => this.sellable(i) || this.eligible(i)); },
  autoRevive() { return this.cfg().enabled && this.cfg().revive; },
  reason() {
    const c = this.cfg(), pet = Loot.pet();
    if (World.freeBagSlots() <= 1) return 'character bag nearly full';
    if (c.petFull && pet && pet.rec.status - pet.rec.inventory.length <= c.petFree && this.petClearable(pet)) return 'pickup pet nearly full';
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
  // Already standing in a known town (all four services in range): no return scroll is needed or wanted.
  inTown(revival = false) { return !revival && !!World.pose() && !!this.detect(World.pose()); },
  validate(revival = false) {
    const c = this.cfg(), supplies = this.supplies();
    const missing = [['arrival', 'arrival point'], ['vendor', 'potion merchant'], ['smith', 'repair merchant'], ['gate', 'world statue / teleport'], ...(c.petFull ? [['storage', 'warehouse']] : [])].filter(([key]) => !c[key]).map(([, label]) => label);
    if (missing.length) return 'Save missing town services: ' + missing.join(', ') + '.';
    if (!supplies.length || supplies.some(s => !s.refObjId || !Number.isInteger(s.low) || !Number.isInteger(s.target) || s.low < 0 || s.target <= s.low || s.target > 10000)) return 'Choose potions and valid low-stock/refill quantities.';
    if ((!revival && !this.inTown() && !this.scroll(0x09ec)) || !this.scroll(0x19ec)) return revival ? 'Carry a reverse return scroll for revival return.' : 'Carry a return scroll and a reverse return scroll before hunting.';
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
    // Bag selling reads codenames from the item catalogue: start loading it now, well before the merchant.
    if (this.trip.sellFirst) Loot.ensureCatalogue();
    // Stop the worker's repeating attack/movement as well as the bot's next tick.
    // Pending inventory work still settles before item-use is admitted below.
    this.trip.haltSent = Cmd.move(World.pose());
    this.trip.haltAt = now();
    this.trip.haltAttempts = this.trip.haltSent ? 1 : 0;
    // Started in town: skip the return scroll and go straight to the services.
    if (this.inTown(revival)) { this.arrived(); return; }
    if (revival) this.enter('revive-arrival');
    else this.message = 'Using return scroll; recall must be bound to your town.';
  },
  arrived() {
    const t = this.trip, full = World.freeBagSlots() < 1;
    t.scrollAttempts = 0; t.scrollRequest = null;
    // With bag selling on, the trip sells first, so a full bag can still make room for refills.
    if (full && !t.sellFirst) return this.fail('Returned to town; free a character bag slot for storage and refills.');
    t.order = this.order(full);
    this.enter('walk-' + t.order[0]);
  },
  // The services in visiting order. Potions come before repair and selling, unless bag selling is on, which sells and
  // repairs first so a full bag has room to buy. A full bag also sells before the warehouse: pet loot reaches the
  // warehouse through a free bag slot.
  order(full) {
    const sellFirst = this.trip?.sellFirst;
    const order = !sellFirst ? ['storage', 'vendor', 'smith', 'gate'] : full ? ['smith', 'storage', 'vendor', 'gate'] : ['storage', 'smith', 'vendor', 'gate'];
    return this.cfg().storage ? order : order.filter(role => role !== 'storage');
  },
  // The service to walk to after closing a window.
  closeNext(phase) {
    const order = this.trip?.order || this.order(false), role = phase.replace(/^close-/, '');
    return 'walk-' + (order[order.indexOf(role) + 1] || 'gate');
  },
  enter(phase) {
    const t = this.trip;
    t.phase = phase; t.at = now(); t.sent = false; t.pending = null; t.transition = false;
    t.travel = null; t.lastPose = null; t.progressAt = now(); t.movedAt = -Infinity; t.retryAt = 0; t.stall = null; t.avoid = [];
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
    if (!World.isSitting() && Navigation.watch(t, pose, t.movedAt, t.travel?.route[t.travel.index] || dest) === 'giveup') {
      // The warehouse is optional: a blocked walk to it skips the deposit so the potions, repairs and the way back still happen.
      if (t.phase === 'walk-storage') {
        this.enter(this.closeNext('close-storage'));
        this.message = 'Warehouse skipped: blocked on the way, I could not walk around the obstacle.';
        UI.toast(this.message, 'warn', 6000);
        return false;
      }
      this.fail('Blocked on the way to the ' + this.role(t.phase) + '; I could not walk around the obstacle.');
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
      // Protected items may still fill the pet; the trip carries on and goes back to hunting rather than stopping in town.
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
    t.buySkipped ||= [];
    let s = t.supplies.find(s => !t.buySkipped.includes(s.refObjId) && Restock.count(s.refObjId) < s.target);
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
    let quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, room + Math.max(0, World.freeBagSlots() - 1) * offer.maxStack);
    if (quantity < 1) return this.fail('Not enough bag space for refill and a spare transfer slot.');
    if (gp.progression?.gold === undefined) return this.fail('Not enough gold for potion refill.');
    // Short on gold: buy what the gold covers and carry on, instead of ending the trip in the shop.
    const price = toBigInt(offer.price), gold = toBigInt(gp.progression.gold);
    if (price > 0n && price * BigInt(quantity) > gold) quantity = Number(gold / price);
    if (quantity < 1) {
      if (before > 0) { t.buySkipped.push(s.refObjId); this.message = 'Not enough gold to top up ' + s.kind + '; buying what is left.'; UI.toast(this.message, 'warn', 6000); return; }
      return this.fail('Not enough gold for potion refill.');
    }
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
