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
const ITEM_BALANCE_CONFIRM_MS = 5000;
const ITEM_GEAR_SLOTS = ['primaryWeapon', 'secondaryWeapon', 'shield'];
const ItemRules = {
  infos: new Map(), dropping: null, dropBan: new Map(), message: '', balancing: null, balanceBan: new Map(), gearSlots: {}, gearOwner: '',
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
  // The primary and secondary weapon and the shield picked under Combat, as BuffGear item keys. Identical copies share a
  // key, so every copy is protected. Protected gear is never sold, stored, dropped or moved to the pet, whatever its rule.
  gearKeys() { const g = this.cfg().gear || {}; return ITEM_GEAR_SLOTS.map(k => g[k]).filter(Boolean); },
  guarded(item) { const keys = this.gearKeys(); return !!item && keys.length > 0 && keys.includes(BuffGear.key(item)); },
  // Weapons or shields the character can choose from: worn first, then the bag. Identical copies are listed once.
  gearChoices(shield) {
    const list = BuffGear.items().filter(i => shield ? BuffGear.shield(i) : BuffGear.weapon(i))
      .sort((a, b) => (a.slot > 7) - (b.slot > 7) || a.slot - b.slot);
    return list.filter((i, n) => list.findIndex(j => BuffGear.key(j) === BuffGear.key(i)) === n);
  },
  // Select rows for one gear choice. The chosen item stays listed while it is not carried (warehouse, pet, trade).
  gearOptions(slot) {
    const equipped = World.gp?.equipmentSlotCount || 13, chosen = this.cfg().gear?.[slot];
    const rows = this.gearChoices(slot === 'shield').map(i => [BuffGear.key(i),
      `${Items.name(i.refObjId)}${i.plus ? ' +' + i.plus : ''} (${i.slot < equipped ? 'worn' : 'bag ' + (i.slot - equipped + 1)})`]);
    if (chosen && !rows.some(([key]) => key === chosen)) rows.push([chosen, this.gearName(chosen) + ' (not in your bag)']);
    return [['', 'None'], ...rows];
  },
  gearRef(key) { try { return JSON.parse(key)[0]; } catch { return 0; } },
  gearName(key) {
    try { const [ref, , plus] = JSON.parse(key); return Items.name(ref) + (plus ? ' +' + plus : ''); } catch { return 'Unknown item'; }
  },
  setGear(slot, key) {
    if (!ITEM_GEAR_SLOTS.includes(slot)) return;
    (this.cfg().gear ||= {})[slot] = key || null;
    delete this.gearSlots[slot];
    if (key) BuffGear.bad.delete(key); // picked again: the game may take it now (a level up)
    Settings.saveProfile();
  },
  // Chosen gear is followed by its slot: wearing it keeps its key, and when alchemy changes its plus or stones the item
  // in the same slot with the same item number takes the choice (and its protection) over.
  trackGear() {
    const g = this.cfg().gear, gp = World.gp, owner = Settings.profileKey + '|' + World.charName;
    if (owner !== this.gearOwner) { this.gearOwner = owner; this.gearSlots = {}; }
    if (!g || !gp || gp.inventoryPending || !World.inWorld()) return;
    const items = BuffGear.items();
    for (const slot of ITEM_GEAR_SLOTS) {
      const key = g[slot];
      if (!key) continue;
      const found = items.find(i => BuffGear.key(i) === key);
      if (found) { this.gearSlots[slot] = found.slot; continue; }
      const was = items.find(i => i.slot === this.gearSlots[slot]);
      // An empty slot means the item left (destroyed, stored, traded): forget the slot, so a later drop there is not adopted.
      if (!was) { delete this.gearSlots[slot]; continue; }
      if (was.refObjId !== this.gearRef(key) || this.gearKeys().includes(BuffGear.key(was))) continue;
      g[slot] = BuffGear.key(was);
      Settings.saveProfile();
      Log.info('Chosen gear changed (' + this.gearName(key) + ' is now ' + this.gearName(g[slot]) + '); still protected.');
    }
  },
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
  // Every catalogue item that passes the filters, in id order. f: { query, group, race, gender, degrees: Set, kind, sox ('any', '1', '2', '3'), custom, nearby }.
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
      if (f.sox && (f.sox === 'any' ? !i.sox : String(i.sox) !== f.sox)) continue;
      if (f.kind && i.kind !== f.kind && i.material !== f.kind) continue;
      if (query && !i.name.toLowerCase().includes(query) && !i.code.toLowerCase().includes(query) && String(id) !== query) continue;
      out.push(i);
    }
    return out.sort((a, b) => a.id - b.id);
  },
  // Feed the catalogue from what the character actually sees: worn and bagged items, the pet's bag, warehouse rows,
  // merchant offers and ground drops all arrive with their name (and most with icon and tooltip key) straight from
  // the server. On the live site this is the only catalogue source; wherever the files load, the two agree.
  wireNextAt: 0,
  learnWorld() {
    if (now() < this.wireNextAt) return;
    this.wireNextAt = now() + 3000;
    const gp = World.gp;
    if (!gp) return;
    const seen = [];
    if (Array.isArray(gp.inventory)) seen.push(...gp.inventory);
    for (const rec of gp.cosRecords || []) if (Array.isArray(rec.inventory)) seen.push(...rec.inventory);
    if (Array.isArray(gp.storage?.items)) seen.push(...gp.storage.items);
    if (Array.isArray(gp.shop?.offers)) seen.push(...gp.shop.offers);
    for (const e of World.ents.values()) if (e.kind === 'ground-item') seen.push(e);
    if (Items.wireLearn(seen)) this.infos.clear();
  },
  // Keep free slots even between the bag and the pickup pet by moving items that have a Sell or Store rule to the side with
  // more room, one at a time, while hunting and outside town service and open windows. Needs two free slots on the side
  // that receives, so loot keeps flowing. Protected gear, supplies the trip needs and worn gear never move.
  balanceTick() {
    const gp = World.gp, pet = Loot.pet();
    if (!this.cfg().balance || !pet || !Hunt.running || Town.trip || !World.inWorld() || World.isDead() || !gp || gp.inventoryPending || gp.storage || gp.exchange?.open || Restock.activeShop()) return false;
    const t = now(), b = this.balancing, equipped = gp.equipmentSlotCount || 13;
    if (b) {
      const moved = (b.toPet ? Loot.items(pet) : World.items()).some(i => i.slot === b.destination && i.refObjId === b.ref);
      if (moved) { this.balancing = null; Log.info('Moved ' + Items.name(b.ref) + (b.toPet ? ' to the pet' : ' to the bag') + ' (balance).'); }
      else if (t - b.at < ITEM_BALANCE_CONFIRM_MS) return false;
      else { this.balancing = null; this.balanceBan.set(b.key, t + 30000); this.message = Items.name(b.ref) + ' was not moved; trying again in 30 s.'; Log.warn(this.message); }
    }
    const petInv = pet.rec.inventory || [], petFree = pet.rec.status - petInv.length, bagFree = World.freeBagSlots();
    const toPet = bagFree - petFree <= -2 && petFree >= 2, toBag = petFree - bagFree <= -2 && bagFree >= 2;
    if (!toPet && !toBag) return false;
    const key = i => (toPet ? 0 : pet.rec.gid) + ':' + i.slot + ':' + i.refObjId;
    const movable = i => ['store', 'sell'].includes(this.get(i.refObjId)?.act) && !this.guarded(i) && !(toPet && (Town.needed(i) || Alchemy.selected && Alchemy.selected.slot === i.slot)) &&
      (this.balanceBan.get(key(i)) || 0) <= t;
    const item = (toPet ? World.items().filter(i => i.slot >= equipped) : petInv).find(movable);
    if (!item) return false;
    const destination = toPet ? Town.free(petInv, 0, pet.rec.status) : Town.free(gp.inventory, equipped, gp.inventorySlotCount);
    if (destination === null) return false;
    const command = { kind: 'cos-transfer', gid: pet.rec.gid, toCos: toPet, source: item.slot, destination };
    if (!Cmd.spaced(command.kind) || !Cmd.raw(command, 'Balance: move ' + Items.name(item.refObjId))) return false;
    this.balancing = { key: key(item), toPet, ref: item.refObjId, destination, at: t };
    return true;
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
      if (this.get(item.refObjId)?.act !== 'drop' || this.guarded(item)) continue;
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

// The wire catalogue starts with what earlier sessions saw and grows with every gameplay batch.
Items.wireLoad();
bus.on('gameplay', () => ItemRules.learnWorld());
