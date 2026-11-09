// Zero-setup leveling: the bot picks its own hunting spot for the character's level and buys the next tier of NPC gear.
//
// Spots come from LEVEL_SPOTS (gen-leveling.py: clusters of ordinary monster spawns with their level). The spot is the
// best one at most LEVEL_SPOT_BELOW levels under the character that the game's route data connects to the town the
// return scroll lands in (or within LEVEL_SPOT_REACH_M without route data): higher level first, then more spawns, then
// nearer. A spot the bot cannot walk to is skipped for the session. LevelSpot applies it like a saved level spot,
// so the walk there, the "no XP" move and the map all work the same way.
//
// Gear comes from LEVEL_GEAR (the town's smith, armour and accessory merchants). A worn piece is replaced only when
// the town sells the same kind (same weapon type, same armour material and part) for a higher required level, the
// worn piece is ordinary (no Seal, no rare codename, at most +LEVEL_GEAR_MAX_PLUS) and nothing protects it; an empty
// armour or accessory socket is filled. Purchases happen on any town trip, in the shop, one confirmed transaction at a
// time; the new piece is worn at once and the old one sold back there. A plan the town can pay for starts a trip by
// itself, once per plan.
const LEVEL_SPOT_REACH_M = 5000, LEVEL_SPOT_BELOW = 5, LEVEL_SPOT_ABOVE = 2, LEVEL_SPOT_KEEP = 2, LEVEL_GEAR_MAX_PLUS = 3, LEVEL_GEAR_CHECK_MS = 20000;
// Equipment sockets by TID4 (OpenSRO inventory/slots.go, native sub_594980): armour parts and accessories.
// The mastery each weapon type trains (TID4 of the weapon; OpenSRO masteries 257-276 Chinese, 513-518 European), and the
// European masteries that fight with Intelligence.
const LEVEL_WEAPON_MASTERY = { 2: 257, 3: 257, 4: 258, 5: 258, 6: 259, 7: 513, 8: 513, 9: 513, 10: 516, 11: 514, 12: 515, 13: 515, 14: 517, 15: 518 };
const LEVEL_INT_MASTERIES = [514, 516, 517, 518], LEVEL_SKILL_CHECK_MS = 5000;
// Raised after the weapon's mastery on every character that has them (Cold, Lightning, Fire; a mastery the character does
// not have is skipped by Auto mastery), and the pattern of a weapon imbue skill (the same one the imbue picker offers first).
const LEVEL_ELEMENT_MASTERIES = [273, 274, 275], LEVEL_IMBUE_SKILL = /GIGONGTA|POISON\w*_BLADE|MALL_PET_SKILL/;
const LEVEL_PART = { 1: 'helmet', 2: 'shoulders', 3: 'chest', 4: 'legs', 5: 'gloves', 6: 'boots', '1a': 'necklace', '2a': 'earrings', '3a': 'ring' };
const LEVEL_ARMOUR_SOCKET = { 1: 0, 2: 2, 3: 1, 4: 4, 5: 3, 6: 5 }, LEVEL_ACCESSORY_SOCKETS = { 1: [9], 2: [10], 3: [11, 12] };
const Leveling = {
  // The generated tables, as properties so a test can lay its own over them.
  spots: LEVEL_SPOTS, gear: LEVEL_GEAR, shopsData: LEVEL_SHOPS,
  skillAt: 0,
  current: null, skipped: new Set(), tried: new Set(), refused: new Set(), checkAt: 0, due_: '', index: null, message: '',
  cfg() { return Settings.profile.leveling; },
  spotsOn() { const c = this.cfg(); return !!(c.on && c.spots); },
  gearOn() { const c = this.cfg(); return !!(c.on && c.gear); },
  reset() { this.current = null; this.skipped.clear(); this.tried.clear(); this.refused.clear(); this.due_ = ''; this.checkAt = 0; },

  // ---- spots
  key(s) { return s[0] + ':' + s[1] + ':' + s[3]; },
  home() { return Town.cfg().arrival || World.pose(); },
  // The spot for this level, or null when the data has none in reach. The spot in use is kept while the best choice is
  // at most LEVEL_SPOT_KEEP levels above it, so the bot does not walk across the map for every level.
  spot(level) {
    const home = this.home();
    if (!home || !Number.isInteger(level)) return null;
    // Reach: no distance limit where the game's route data covers both the town and the spot (one connected area: the
    // walk is long but it is a walk, and the score already weighs a level far above distance). Without route data for it,
    // up to LEVEL_SPOT_REACH_M, so a spot on another continent is never picked. Few towns have a spot at every level
    // within 400 m (Jangan's level 5 one is 407 m away, its level 8 one 903 m).
    const far = LEVEL_SPOT_REACH_M * 10, routes = Route.areas?.length > 0;
    // above: when nothing at or below the level is in reach (a new character), the nearest few levels up.
    let best = null, fallback = null, above = null;
    for (const s of this.spots) {
      if (s[4] > level + LEVEL_SPOT_ABOVE || this.skipped.has(this.key(s))) continue;
      const center = { regionId: s[0], x: s[1], y: s[2], z: s[3] }, d = dist2D(home, center);
      if (!(d <= far) && !(Number.isFinite(d) && routes && Route.commonArea(home, center))) continue;
      const pick = { level: s[4], center, key: this.key(s), auto: true, score: s[4] * 400 + Math.min(s[7], 12) * 40 - d / 30 };
      if (s[4] > level) { pick.score = -s[4] * 400 + Math.min(s[7], 12) * 40 - d / 30; if (!above || pick.score > above.score) above = pick; continue; }
      if (s[4] < level - LEVEL_SPOT_BELOW) { if (!fallback || pick.score > fallback.score) fallback = pick; continue; }
      if (!best || pick.score > best.score) best = pick;
    }
    best ||= above || fallback;
    const cur = this.current, H = Hunt.cfg();
    if (cur && cur.owner === World.charName && !this.skipped.has(cur.key) && cur.level <= level && LevelSpot.same(cur.center, H.center) &&
        (!best || best.level - cur.level <= LEVEL_SPOT_KEEP)) return cur;
    if (best) this.current = { ...best, owner: World.charName };
    return best;
  },
  // "No XP" in auto mode: pass over the spot in use for this session and take the next best one.
  advance(level) {
    const cur = this.current;
    if (cur) this.skipped.add(cur.key);
    this.current = null;
    const next = this.spot(level);
    if (!next || cur && next.key === cur.key) return null;
    return next;
  },

  // ---- gear
  row(ref) {
    if (!this.index) {
      this.index = new Map();
      for (const rows of Object.values(this.gear)) for (const r of rows) this.index.set(r[0], r);
    }
    return this.index.get(ref) || null;
  },
  reqLevel(item) { return Town.requiredLevel(item) ?? this.row(item.refObjId)?.[6] ?? null; },
  tids(item) { const tf = item.typeFlags >>> 0; return [(tf >>> 7) & 15, (tf >>> 11) & 31]; },
  town() { const c = Town.cfg(); return Town.detect(c.vendor || c.smith || c.arrival || World.pose()); },
  // Race and sex: from the character's own model (characterdata CHAR_CH_MAN 1907-1919, CHAR_CH_WOMAN 1920-1932,
  // CHAR_EU_MAN 14717-14729, CHAR_EU_WOMAN 14730-14742), else from what it wears. Starter clothes are in no shop and
  // the live site sends no codenames, so the wear alone can say nothing: a guess bought the other sex's armour.
  model(ref) {
    if (ref >= 1907 && ref <= 1919) return { country: 0, sex: 1 };
    if (ref >= 1920 && ref <= 1932) return { country: 0, sex: 0 };
    if (ref >= 14717 && ref <= 14729) return { country: 1, sex: 1 };
    if (ref >= 14730 && ref <= 14742) return { country: 1, sex: 0 };
    return null;
  },
  who() {
    const own = this.model(World.local()?.refObjId);
    if (own) return own;
    let country = null, sex = null;
    for (const i of (World.gp?.inventory || []).filter(i => i.slot < 13)) {
      const r = this.row(i.refObjId), code = i.codename || Items.data?.get(i.refObjId)?.code || '';
      if (country === null) country = r ? (r[4] === 3 ? null : r[4]) : /^ITEM_CH_/.test(code) ? 0 : /^ITEM_EU_/.test(code) ? 1 : null;
      if (sex === null) sex = r ? (r[5] === 2 ? null : r[5]) : /_M_/.test(code) ? 1 : /_W_/.test(code) ? 0 : null;
    }
    return { country, sex };
  },
  // A worn piece the plan may replace: ordinary, low plus, known level, and nothing the player protects.
  replaceable(item) {
    if (Equip.protected(item) || Items.soxOf(item) > 0 || (item.plus ?? 0) > LEVEL_GEAR_MAX_PLUS) return false;
    if (item.tooltip?.fields?.rarity !== undefined && item.tooltip.fields.rarity !== 0) return false;
    if (/_(RARE|MAGIC|LEGEND|MYTH|HONOR)/i.test(item.codename || Items.data?.get(item.refObjId)?.code || '')) return false;
    return Number.isInteger(this.reqLevel(item));
  },
  // What to buy now: [{ row, socket, role }], best piece per socket, weapon first, within the gold above the reserve.
  plan(notes) {
    const gp = World.gp, level = gp?.progression?.level, town = this.town();
    if (!gp || !Number.isInteger(level) || !town) return [];
    const { country, sex } = this.who();
    if (country === null) return [];
    const rows = (this.gear[town.key] || []).filter(r => (r[4] === country || r[4] === 3) && (r[5] === 2 || r[5] === sex) && r[6] <= level && !this.refused.has(r[0]));
    const worn = new Map((gp.inventory || []).filter(i => i.slot < 13).map(i => [i.slot, i]));
    const best = (tid3, tid4) => rows.filter(r => r[2] === tid3 && r[3] === tid4).sort((a, b) => b[6] - a[6] || b[7] - a[7])[0] || null;
    const wants = [];
    // notes (optional): why a piece is not in the plan, for the trip's log line.
    const consider = (socket, tid3, tid4, fill, label) => {
      const r = best(tid3, tid4), item = worn.get(socket);
      if (!r) { notes?.push(label + ': the town sells none at your level'); return; }
      if (!item) { if (fill) wants.push({ row: r, socket, role: r[1], fill: true }); return; }
      if (item.refObjId === r[0] || !(r[6] > (this.reqLevel(item) ?? Infinity))) {
        notes?.push(label + ': ' + (this.reqLevel(item) === null ? 'its level is unknown, kept' : 'already as good as level ' + r[6] + ' in town'));
      } else if (!this.replaceable(item)) notes?.push(label + ': kept (enhanced, rare, sealed or protected)');
      else wants.push({ row: r, socket, role: r[1] });
    };
    const weapon = worn.get(6);
    if (weapon) consider(6, 6, this.tids(weapon)[1], false, 'weapon');
    const second = worn.get(7);
    if (second && ItemType.isEquipment(second.typeFlags) && this.tids(second)[0] === 4) consider(7, 4, this.tids(second)[1], false, 'shield');
    // Armour: the material most of the worn pieces have; empty parts are filled with it.
    const materials = {};
    for (const s of [0, 1, 2, 3, 4, 5]) { const i = worn.get(s); if (i) { const t3 = this.tids(i)[0]; materials[t3] = (materials[t3] || 0) + 1; } }
    const material = Number(Object.keys(materials).sort((a, b) => materials[b] - materials[a])[0]);
    if (material) for (const [tid4, socket] of Object.entries(LEVEL_ARMOUR_SOCKET)) consider(socket, material, Number(tid4), true, LEVEL_PART[tid4]);
    if (this.cfg().accessories) {
      const tid3 = country === 1 ? 12 : 5;
      for (const [tid4, sockets] of Object.entries(LEVEL_ACCESSORY_SOCKETS)) for (const socket of sockets) consider(socket, tid3, Number(tid4), true, LEVEL_PART[tid4 + 'a']);
    }
    let budget = toBigInt(gp.progression?.gold ?? 0) - BigInt(Math.max(0, Number(this.cfg().reserve) || 0));
    const out = [];
    for (const w of wants) {
      const price = BigInt(Math.max(0, w.row[7]));
      if (price > budget) continue;
      budget -= price; out.push(w);
    }
    return out;
  },
  // A town trip reason when the plan has a real upgrade: a worn piece the town sells a higher tier of. Filling an empty
  // slot is never worth a trip of its own (live: a level 2 character went to town for level 1 rings); it is done on
  // any trip that happens anyway. Each plan starts at most one trip.
  due() {
    if (!this.gearOn() || Town.trip) return '';
    if (now() < this.checkAt) return this.due_;
    this.checkAt = now() + LEVEL_GEAR_CHECK_MS;
    const plan = this.plan().filter(w => !w.fill), key = World.charName + '|' + plan.map(w => w.socket + ':' + w.row[0]).join(',');
    this.due_ = plan.length && !this.tried.has(key) ? 'better gear to buy (level ' + World.gp.progression.level + ')' : '';
    return this.due_;
  },
  // Town.begin: the plan this trip carries, and where the armour and accessory merchants stand.
  begin(t) {
    t.gear = [];
    if (!this.gearOn()) return;
    const notes = [];
    t.gear = this.plan(notes).map(w => ({ ...w }));
    // Why the rest is left alone: one line a report can show.
    if (notes.length) Log.info('Leveling gear, not bought: ' + notes.join('; ') + '.');
    // The same key as due(): the upgrades only, so this plan does not start another trip.
    this.tried.add(World.charName + '|' + t.gear.filter(w => !w.fill).map(w => w.socket + ':' + w.row[0]).join(','));
    this.due_ = ''; this.checkAt = now() + LEVEL_GEAR_CHECK_MS;
    const town = this.town(), shops = this.shopsData[town?.key] || {};
    t.shops = {};
    for (const role of ['armor', 'accessory']) {
      const s = shops[role];
      if (!s || !t.gear.some(w => w.role === role)) continue;
      const stand = Town.standPoint(s, Town.cfg().arrival || s);
      t.shops[role] = { ...stand.point, refObjId: s.refObjId, name: town.name + ' ' + (role === 'armor' ? 'armour merchant' : 'accessory merchant'), npc: { regionId: s.regionId, x: s.x, y: s.y, z: s.z } };
    }
    if (t.gear.length) Log.info('Leveling: this trip buys ' + t.gear.length + ' piece' + (t.gear.length === 1 ? '' : 's') + ' of gear.');
  },
  wants(t, role) { return (t.gear || []).filter(w => w.role === role && !['skip', 'done'].includes(w.state)); },
  bagCount(ref) { return World.items().filter(i => i.refObjId === ref).length; },
  skip(t, w, why) {
    w.state = 'skip'; t.pending = null;
    this.message = 'Gear: ' + Items.name(w.row[0]) + ' not bought, ' + why + '.';
    Log.warn(this.message);
  },
  // The gear phase in an open shop: buy, wear, sell the old piece, one confirmed step at a time. Never resends.
  shop(t) {
    const gp = World.gp, role = t.gearRole, shop = Restock.activeShop(), npc = Town.npc(role);
    if (!shop || !npc || shop.npc !== npc.gid || shop.error) return Town.fail(shop?.error || 'Gear merchant selection changed.');
    const p = t.pending;
    if (p) {
      if (gp.inventoryPending || now() - p.at < 500) { if (now() - p.at > 15000) Town.fail('Gear purchase was not confirmed. Nothing was sent twice.'); return; }
      const w = p.want;
      if (p.kind === 'gear-buy') {
        if (this.bagCount(p.ref) > p.before) {
          const item = World.items().find(i => i.refObjId === p.ref && !p.slots.includes(i.slot));
          w.state = 'bought'; w.bagSlot = item?.slot; t.pending = null;
          Log.info('Leveling: bought ' + Items.name(p.ref) + '.');
        } else if (gp.error) this.skip(t, w, 'the merchant refused (' + gp.error + ')');
        else if (now() - p.at > 15000) Town.fail('Gear purchase was not confirmed. Nothing was sent twice.');
        return;
      }
      if (p.kind === 'gear-wear') {
        if (gp.inventory?.some(i => i.slot === p.socket && i.refObjId === p.ref)) {
          w.state = 'worn'; t.pending = null;
          w.old = p.old ? { slot: p.from, ref: p.old } : null;
          this.message = 'Gear: now wearing ' + Items.name(p.ref) + '.';
          Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 4000);
        } else if (gp.error || now() - p.at > 15000) {
          // The game will not let the character wear it (a mastery requirement, say): never buy it again this session,
          // and sell this one back like a replaced piece.
          this.refused.add(p.ref); w.state = 'worn'; t.pending = null;
          w.old = World.items().some(i => i.slot === p.from && i.refObjId === p.ref) ? { slot: p.from, ref: p.ref } : null;
          Log.warn('Leveling: the game would not let the character wear ' + Items.name(p.ref) + '; selling it back.');
        }
        return;
      }
      if (p.kind === 'gear-sell') {
        if (!World.items().some(i => i.slot === p.slot && i.refObjId === p.ref) || gp.error || now() - p.at > 15000) { w.state = 'done'; t.pending = null; }
        return;
      }
    }
    if (gp.inventoryPending) return;
    for (const w of this.wants(t, role)) {
      if (!w.state) {
        const offer = shop.offers.find(o => o.refObjId === w.row[0] && (o.currency === undefined || o.currency === 1) &&
          (!o.contents?.length || o.contents.length === 1 && o.contents[0].refObjId === o.refObjId));
        if (!offer) { this.skip(t, w, 'this merchant does not sell it'); return; }
        const gold = toBigInt(gp.progression?.gold ?? 0), reserve = BigInt(Math.max(0, Number(this.cfg().reserve) || 0));
        if (toBigInt(offer.price) + reserve > gold) { this.skip(t, w, 'not enough gold'); return; }
        if (World.freeBagSlots() < 1) { this.skip(t, w, 'the bag is full'); return; }
        const slots = World.items().filter(i => i.refObjId === w.row[0]).map(i => i.slot);
        if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity: 1 }, 'Leveling: buy ' + Items.name(w.row[0])))
          t.pending = { kind: 'gear-buy', want: w, ref: w.row[0], before: slots.length, slots, at: now() };
        return;
      }
      if (w.state === 'bought') {
        const item = World.items().find(i => i.slot === w.bagSlot && i.refObjId === w.row[0]);
        if (!item) { w.state = 'done'; return; }
        const old = gp.inventory?.find(i => i.slot === w.socket);
        if (Cmd.raw({ kind: 'inventory-move', source: item.slot, destination: w.socket, quantity: 0 }, 'Leveling: wear ' + Items.name(w.row[0])))
          t.pending = { kind: 'gear-wear', want: w, ref: w.row[0], socket: w.socket, from: item.slot, old: old?.refObjId || 0, at: now() };
        return;
      }
      if (w.state === 'worn') {
        const old = w.old && World.items().find(i => i.slot === w.old.slot && i.refObjId === w.old.ref);
        if (!old || !this.cfg().sellOld || !Town.plainGear(old) || Items.soxOf(old) > 0 || old.tooltip?.fields?.canSell === 0) { w.state = 'done'; continue; }
        if (Cmd.raw({ kind: 'shop-sell', slot: old.slot, quantity: 1 }, 'Leveling: sell the replaced ' + Items.name(old.refObjId)))
          t.pending = { kind: 'gear-sell', want: w, ref: old.refObjId, slot: old.slot, at: now() };
        return;
      }
    }
    Town.enter(role === 'smith' ? (Town.ammoSupplies().length ? 'ammo' : 'repair') : 'close-' + role);
  },
  status() {
    if (!this.cfg().on) return 'Zero-setup leveling is off.';
    const level = World.gp?.progression?.level, cur = this.current;
    const spot = this.spotsOn() ? (cur ? 'Hunting at the level ' + cur.level + ' spot.' : 'No spot picked yet.') : 'Spots: your own.';
    return spot + ' ' + (this.gearOn() ? (this.message || (Number.isInteger(level) ? 'Gear: checked at level ' + level + '.' : '')) : 'Gear buying off.');
  },
  skillsOn() { const c = this.cfg(); return !!(c.on && c.skills); },
  // ---- skills
  // Once per character, in the world: the weapon's mastery is raised with the level and every skill of it learned
  // (Auto mastery, scope "masteries"), and stat points go to Strength, or to Intelligence for a caster (a European
  // caster weapon, or more Intelligence than Strength already). Only what is not set up yet is changed.
  prepare() {
    const c = this.cfg(), gp = World.gp, weapon = (gp?.inventory || []).find(i => i.slot === 6);
    // prepared names the character it was done for: settings copied to another character set that one up again.
    if (!this.skillsOn() || !World.charName || c.prepared === World.charName || !World.inWorld() || !weapon || !gp.progression) return false;
    const mastery = LEVEL_WEAPON_MASTERY[this.tids(weapon)[1]];
    if (!mastery) return false;
    const M = Settings.profile.mastery, S = Settings.profile.statPoints, stats = gp.progression.stats || {}, done = [];
    if (!M.enabled || !M.ids.length) { M.enabled = true; M.ids = [mastery]; M.gap = 0; done.push(AutoMastery.name(mastery) + ' mastery'); }
    if (!M.skills || M.scope !== 'masteries') { M.skills = true; M.scope = 'masteries'; done.push('its skills'); }
    if (!S.enabled) {
      const caster = LEVEL_INT_MASTERIES.includes(mastery) || (stats.intellect ?? 0) > (stats.strength ?? 0);
      Object.assign(S, { enabled: true, str: caster ? 0 : 1, int: caster ? 1 : 0 });
      done.push('stat points to ' + (caster ? 'Intelligence' : 'Strength'));
    }
    c.prepared = World.charName;
    this.addElements(M);
    AutoMastery.reset(); StatPoints.reset(); Settings.saveProfile();
    if (done.length) { this.message = 'Leveling set up: ' + done.join(', ') + '.'; Log.info(this.message); UI.toast(this.message, 'info', 7000); }
    return true;
  },
  // Cold, Lightning and Fire go on the mastery list once per character, behind the weapon's mastery. Only when the list
  // is still just that one mastery (what leveling set up): a list the player chose is left alone. A mastery taken off
  // later stays off.
  addElements(M) {
    const c = this.cfg(), weapon = (World.gp?.inventory || []).find(i => i.slot === 6);
    if (c.elements === World.charName || !M.enabled || !weapon) return false;
    c.elements = World.charName;
    if (M.ids.length !== 1 || M.ids[0] !== LEVEL_WEAPON_MASTERY[this.tids(weapon)[1]]) return false;
    const add = LEVEL_ELEMENT_MASTERIES.filter(id => !M.ids.includes(id));
    if (!add.length) return false;
    M.ids = [...M.ids, ...add];
    return true;
  },
  // The weapon imbue: each learned imbue group is put in the imbue slot once, when the slot is empty. Taking it out
  // again by hand is respected; a newly learned imbue skill group is picked up the same way.
  imbueTick() {
    const M = Settings.profile.macro, c = this.cfg(), done = new Set(c.imbued || []);
    const skill = UI.learnedSkills(true).find(s => LEVEL_IMBUE_SKILL.test(s.nameSymbol || '') && !done.has(s.group ?? s.id));
    if (!skill) return false;
    done.add(skill.group ?? skill.id); c.imbued = [...done];
    if (!M.imbue) { M.imbue = { id: skill.id, group: skill.group ?? skill.id }; this.message = 'Imbue in use: ' + World.skillName(skill.id) + '.'; Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 5000); }
    Settings.saveProfile();
    return true;
  },
  // Newly learned attack skills join the normal rotation, newly learned self buffs the buffs, each group once: a skill
  // the player takes out stays out. Only skills of the chosen masteries.
  skillTick() {
    if (!this.skillsOn() || now() < this.skillAt) return;
    this.skillAt = now() + LEVEL_SKILL_CHECK_MS;
    this.prepare();
    if (!World.inWorld() || !World.groups.size) return;
    if (World.charName && this.cfg().elements !== World.charName && this.cfg().prepared === World.charName && this.addElements(Settings.profile.mastery)) { AutoMastery.reset(); Settings.saveProfile(); }
    this.imbueTick();
    const c = this.cfg(), M = Settings.profile.macro, mine = new Set(AutoMastery.masteryGroups()), added = new Set(c.added || []), names = [];
    const take = (s, list, extra) => {
      const group = s.group ?? s.id;
      if (!mine.has(group) || added.has(group)) return;
      added.add(group);
      if (list.some(e => (e.group ?? e.id) === group)) return;
      list.push({ id: s.id, group, ...extra }); names.push(World.skillName(s.id));
    };
    for (const s of UI.learnedSkills(false)) take(s, M.rotations.normal, {});
    for (const s of UI.learnedSkills(true)) take(s, M.buffs, { enabled: true, mode: 'hunt', refreshS: 3 });
    if (added.size === (c.added || []).length) return;
    c.added = [...added]; Settings.saveProfile();
    if (names.length) { this.message = 'New skills in use: ' + names.join(', ') + '.'; Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 5000); }
  },
  // Turning it on sets the pieces it relies on: "no XP" moves to another spot, and the town for the trips.
  enable(on) {
    const c = this.cfg(), T = Town.cfg();
    c.on = on;
    if (on) {
      c.prepared = ''; c.elements = ''; c.imbued = []; this.skillAt = 0;
      T.noXp = { ...T.noXp, on: true, action: 'nextSpot' };
      if (!T.enabled && World.inWorld()) Setup.setupTown();
    }
    this.reset(); Settings.saveProfile(); UI.draw();
    UI.toast(on ? 'Zero-setup leveling on: the bot picks spots for your level and buys better NPC gear on town trips.' : 'Zero-setup leveling off.', 'info', 6000);
  },
  draw() {
    const c = () => this.cfg(), status = el('p', this.status(), 'muted');
    UI.refreshers.push(() => { status.textContent = this.status(); });
    return UI.group('Zero-setup leveling',
      el('p', 'For levelling a character with no setup: the bot picks a hunting spot for your level from the game data, moves on as you level, and buys the next tier of weapon, armour and accessories from the town merchants on its town trips. Nothing better than ordinary +' + LEVEL_GEAR_MAX_PLUS + ' gear is ever replaced or sold. It can also raise your weapon\'s mastery, learn its skills, put new attack skills and buffs to use and spend stat points (Strength, or Intelligence for a caster); what you already set up there is kept.', 'muted'),
      UI.check('Level up by itself', () => c().on, v => this.enable(v)),
      UI.check('Pick hunting spots for my level', () => c().spots, v => { c().spots = v; this.reset(); }),
      UI.check('Buy better gear from the town merchants', () => c().gear, v => { c().gear = v; }),
      UI.check('Also buy earrings, necklaces and rings', () => c().accessories, v => { c().accessories = v; }),
      UI.check('Sell the replaced piece back', () => c().sellOld, v => { c().sellOld = v; }),
      UI.check('Raise my weapon mastery, learn its skills and use them', () => c().skills, v => { c().skills = v; c().prepared = ''; c().elements = ''; c().imbued = []; this.skillAt = 0; }),
      UI.number('Always keep this much gold', () => c().reserve, v => { c().reserve = v; }, 0, 100000000, 1000),
      status);
  },
};
