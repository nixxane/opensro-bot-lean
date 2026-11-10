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
// worn piece is at most +LEVEL_GEAR_MAX_PLUS and nothing protects it (a Seal piece is replaced too: a level 1 Seal
// necklace is far weaker than the town's level 16 one; it goes to the bag, never sold); an empty
// armour or accessory socket is filled. Purchases happen on any town trip, in the shop, one confirmed transaction at a
// time; the new piece is worn at once and the old one sold back there. A plan the town can pay for starts a trip by
// itself, once per plan.
const LEVEL_SPOT_REACH_M = 5000, LEVEL_SPOT_BELOW = 5, LEVEL_SPOT_ABOVE = 2, LEVEL_SPOT_KEEP = 2, LEVEL_GEAR_MAX_PLUS = 3, LEVEL_GEAR_CHECK_MS = 20000, LEVEL_SPOT_WALK_FAILS = 5, LEVEL_TIER_GAP = 3, LEVEL_MOVE_CHECK_MS = 10000, LEVEL_MOVE_STEP_MS = 15000, LEVEL_MOVE_RETRY_MS = 600000;
// Equipment sockets by TID4 (OpenSRO inventory/slots.go, native sub_594980): armour parts and accessories.
// The mastery each weapon type trains (TID4 of the weapon; OpenSRO masteries 257-276 Chinese, 513-518 European), and the
// European masteries that fight with Intelligence.
const LEVEL_WEAPON_MASTERY = { 2: 257, 3: 257, 4: 258, 5: 258, 6: 259, 7: 513, 8: 513, 9: 513, 10: 516, 11: 514, 12: 515, 13: 515, 14: 517, 15: 518 };
const LEVEL_INT_MASTERIES = [514, 516, 517, 518], LEVEL_SKILL_CHECK_MS = 5000;
// Raised after the weapon's mastery on every character that has them (Cold, Lightning, Fire; a mastery the character does
// not have is skipped by Auto mastery), and the pattern of a weapon imbue skill (the same one the imbue picker offers first).
const LEVEL_ELEMENT_MASTERIES = [273, 274, 275], LEVEL_IMBUE_SKILL = /GIGONGTA|POISON\w*_BLADE|MALL_PET_SKILL/;
// A skill's family: its codename without SN_SKILL_ and the tier letter (CH_SPEAR_PIERCE for PIERCE_A, _B, _C).
const levelFamily = s => String(s?.nameSymbol || '').replace(/^SN_SKILL_/, '').replace(/_[A-Z]$/, '');
const LEVEL_PART = { 1: 'helmet', 2: 'shoulders', 3: 'chest', 4: 'legs', 5: 'gloves', 6: 'boots', '1a': 'necklace', '2a': 'earrings', '3a': 'ring' };
const LEVEL_ARMOUR_SOCKET = { 1: 0, 2: 2, 3: 1, 4: 4, 5: 3, 6: 5 }, LEVEL_ACCESSORY_SOCKETS = { 1: [9], 2: [10], 3: [11, 12] };
const Leveling = {
  // The generated tables, as properties so a test can lay its own over them.
  spots: LEVEL_SPOTS, gear: LEVEL_GEAR, shopsData: LEVEL_SHOPS,
  // Builds (gen-builds.py): the presets, and the skill groups leveling never uses (walls and the like).
  builds: BUILDS, blockedGroups: BUILD_BLOCKED_GROUPS, warned: new Set(), familyCache: null,
  skillAt: 0,
  current: null, walkFails: 0, move: null, moveAt: 0, moveFailed: new Set(), moveFailedAt: new Map(), movedFrom: new Set(), skipped: new Set(), tried: new Set(), refused: new Set(), checkAt: 0, due_: '', index: null, message: '',
  cfg() { return Settings.profile.leveling; },
  spotsOn() { const c = this.cfg(); return !!(c.on && c.spots); },
  gearOn() { const c = this.cfg(); return !!(c.on && c.gear); },
  reset() { this.current = null; this.walkFails = 0; this.skipped.clear(); this.tried.clear(); this.refused.clear(); this.due_ = ''; this.checkAt = 0; },

  // ---- spots
  key(s) { return s[0] + ':' + s[1] + ':' + s[3]; },
  home() { return Town.cfg().arrival || World.pose(); },
  // The spot for this level, or null when the data has none in reach. The spot in use is kept while the best choice is
  // at most LEVEL_SPOT_KEEP levels above it, so the bot does not walk across the map for every level.
  // The town a place belongs to: the town whose return-scroll arrival point is nearest (null in a dungeon or another world).
  townOf(p) {
    let best = null, bestD = Infinity;
    for (const t of Town.towns) { const d = t.arrival ? dist2D(p, t.arrival) : Infinity; if (d < bestD) { best = t; bestD = d; } }
    return best;
  },
  spot(level) {
    const home = this.home();
    if (!home || !Number.isInteger(level)) return null;
    // Reach: no distance limit where the game's route data covers both the town and the spot (one connected area: the
    // walk is long but it is a walk, and the score already weighs a level far above distance). Without route data for it,
    // up to LEVEL_SPOT_REACH_M, so a spot on another continent is never picked. Few towns have a spot at every level
    // within 400 m (Jangan's level 5 one is 407 m away, its level 8 one 903 m).
    const far = LEVEL_SPOT_REACH_M * 10, routes = Route.areas?.length > 0;
    // Spots around the town of the return point come first: a spot nearer another town (live: Donwhang's level 18-23
    // spots picked from Jangan) means every death and town trip lands in the wrong town and walks across the map. The
    // move to the next town takes over there; another town's spots are used only when this one has none near the level.
    const homeTown = this.townOf(home)?.key, own = { best: null, fallback: null, above: null }, other = { best: null, fallback: null, above: null };
    this.owners ||= new Map();
    for (const s of this.spots) {
      if (s[4] > level + LEVEL_SPOT_ABOVE || this.skipped.has(this.key(s))) continue;
      const center = { regionId: s[0], x: s[1], y: s[2], z: s[3] }, d = dist2D(home, center);
      if (!(d <= far) && !(Number.isFinite(d) && routes && Route.commonArea(home, center))) continue;
      const key = this.key(s);
      if (!this.owners.has(key)) this.owners.set(key, this.townOf(center)?.key ?? null);
      const owner = this.owners.get(key), g = !homeTown || !owner || owner === homeTown ? own : other;
      // Another town's spot is only for a character that can move there (and so make it the return point first).
      if (g === other && !this.moveOpen(owner)) continue;
      // above: when nothing at or below the level is in reach (a new character), the nearest few levels up.
      const pick = { level: s[4], center, key, auto: true, townKey: owner, score: s[4] * 400 + Math.min(s[7], 12) * 40 - d / 30 };
      if (s[4] > level) { pick.score = -s[4] * 400 + Math.min(s[7], 12) * 40 - d / 30; if (!g.above || pick.score > g.above.score) g.above = pick; continue; }
      if (s[4] < level - LEVEL_SPOT_BELOW) { if (!g.fallback || pick.score > g.fallback.score) g.fallback = pick; continue; }
      if (!g.best || pick.score > g.best.score) g.best = pick;
    }
    // Far under the level is worse than far from town: another town's spot at the level beats this town's leftovers.
    const best = own.best || own.above || other.best || own.fallback || other.above || other.fallback;
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
  // A worn piece the plan may replace: low plus, known level, and nothing the player protects. Seal (SOX) and other rare
  // pieces count too: live, a Seal blade or necklace kept the character in level 1 gear for good. The level check in
  // plan() keeps one as good as the town's; a replaced one stays in the bag (shop() never sells it).
  replaceable(item) {
    if (Equip.protected(item) || (item.plus ?? 0) > LEVEL_GEAR_MAX_PLUS) return false;
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
      } else if (!this.replaceable(item)) notes?.push(label + ': kept (enhanced above +' + LEVEL_GEAR_MAX_PLUS + ' or protected)');
      else wants.push({ row: r, socket, role: r[1] });
    };
    const weapon = worn.get(6), build = this.build();
    // A build with another weapon type: buy its weapon (any level the town sells, never over enhanced or protected gear).
    if (build && weapon && !build.weapon.includes(this.tids(weapon)[1])) {
      const r = best(6, build.weapon[0]);
      if (!r) notes?.push('weapon: the town sells no ' + build.label + ' weapon at your level');
      else if (!this.replaceable(weapon)) notes?.push('weapon: kept (enhanced above +' + LEVEL_GEAR_MAX_PLUS + ' or protected)');
      else wants.push({ row: r, socket: 6, role: r[1] });
    } else if (weapon) consider(6, 6, this.tids(weapon)[1], false, 'weapon');
    const second = worn.get(7);
    if (second && ItemType.isEquipment(second.typeFlags) && this.tids(second)[0] === 4) consider(7, 4, this.tids(second)[1], false, 'shield');
    else if (build?.shield && !second && weapon) {
      const r = rows.filter(r => r[2] === 4).sort((a, b) => b[6] - a[6] || b[7] - a[7])[0];
      if (r) wants.push({ row: r, socket: 7, role: r[1], fill: true });
    }
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
  // A tier of town gear unlocks over a few levels (Jangan: weapon and boots at 8, the helmet at 11, the chest at 13). A trip
  // for gear alone waits until the last piece of the tier is open, so one trip buys the whole set; any trip that happens
  // anyway (a death, potions, repairs) still buys what is open already.
  unlocking(level) {
    const town = this.town(), { country, sex } = this.who();
    const levels = [...new Set((this.gear[town?.key] || []).filter(r => (r[4] === country || r[4] === 3) && (r[5] === 2 || r[5] === sex)).map(r => r[6]))].sort((a, b) => a - b);
    const next = levels.findIndex(l => l > level);
    // The next unlock belongs to this tier when it follows the last open one closely (tiers are LEVEL_TIER_GAP+ apart).
    return next > 0 && levels[next] - levels[next - 1] < LEVEL_TIER_GAP;
  },
  due() {
    if (!this.gearOn() || Town.trip) return '';
    if (now() < this.checkAt) return this.due_;
    this.checkAt = now() + LEVEL_GEAR_CHECK_MS;
    const plan = this.plan().filter(w => !w.fill), key = World.charName + '|' + plan.map(w => w.socket + ':' + w.row[0]).join(','), level = World.gp.progression.level;
    this.due_ = plan.length && !this.tried.has(key) && !this.unlocking(level) ? 'better gear to buy (level ' + level + ')' : '';
    return this.due_;
  },
  // Town.begin: the plan this trip carries, and where the armour and accessory merchants stand.
  begin(t) {
    t.gear = [];
    // The move to the next town rides on this trip: at its end the bot goes there instead of back to the spot. Revival
    // trips too: a start in town (live: recalled to Jangan by hand, then started) and a trip after a death both run as
    // one, and both already stand in the old town.
    const c = this.cfg(), next = c.on && c.move && !this.move ? this.nextTown(World.gp?.progression?.level) : null;
    t.move = next?.key || '';
    if (next) Log.info('Leveling: after the services this trip goes on to ' + next.name + ' and makes it the return point.');
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
    if (this.move) return this.message;
    const level = World.gp?.progression?.level, cur = this.current;
    const spot = this.spotsOn() ? (cur ? 'Hunting at the level ' + cur.level + ' spot.' : 'No spot picked yet.') : 'Spots: your own.';
    return spot + ' ' + (this.gearOn() ? (this.message || (Number.isInteger(level) ? 'Gear: checked at level ' + level + '.' : '')) : 'Gear buying off.');
  },
  // ---- moving town
  // When the home town sells nothing above what the character wears and another town's next tier is open (Jangan's gear
  // ends at level 21, Donwhang's next tier opens at 24), the character moves there. The move is a town trip: the return
  // scroll takes it home (Jangan) and the services run there as usual; instead of the walk back, it takes the world
  // statue's teleport (or the ferry, whichever Travel finds cheaper) to the new town, opens that town's statue and makes
  // it the return point (the statue's own menu, gameplay recall-appoint: the game drops the request unless the menu is
  // open; confirmed by the game's notice). Then the town is set up, a first trip there buys its potions and gear, and the
  // bot walks to a spot of the new town. A move that fails is not tried again this session; a death on the way only puts
  // it off until after the revive.
  nextTown(level) {
    const home = this.town();
    if (!home || !Number.isInteger(level)) return null;
    const { country, sex } = this.who();
    if (country === null) return null;
    const mine = r => (r[4] === country || r[4] === 3) && (r[5] === 2 || r[5] === sex);
    const homeMax = Math.max(0, ...(this.gear[home.key] || []).filter(mine).map(r => r[6]));
    let pick = null;
    for (const [key, rows] of Object.entries(this.gear)) {
      const town = Town.towns.find(t => t.key === key);
      if (key === home.key || !this.moveOpen(key) || !town?.services?.gate) continue;
      const start = Math.min(...rows.filter(r => mine(r) && r[6] > homeMax && r[6] <= level).map(r => r[6]));
      if (Number.isFinite(start) && (!pick || start < pick.start)) pick = { town, start };
    }
    return pick?.town || null;
  },
  // A move to this town may be started: the switch is on, the town has a world statue, an earlier move there did not fail
  // (until the retry time) and it is not a town this session already moved away from.
  moveOpen(key) {
    const c = this.cfg(), town = Town.towns.find(t => t.key === key);
    if (!c.on || !c.move || !town?.services?.gate || this.movedFrom.has(key)) return false;
    if (this.moveFailed.has(key)) {
      if (now() - (this.moveFailedAt.get(key) ?? -Infinity) < LEVEL_MOVE_RETRY_MS) return false;
      this.moveFailed.delete(key); this.moveFailedAt.delete(key);
    }
    return true;
  },
  // A hunting spot of another town than the return point's: the character moves there (return point first) instead of
  // only walking or teleporting to it (live: hunted in Donwhang with the return point still in Jangan).
  foreign(spot) {
    const home = this.townOf(this.home())?.key;
    return !!(spot?.townKey && home && spot.townKey !== home);
  },
  // The town trip reason (Town.reason): the next town is open. Checked every LEVEL_MOVE_CHECK_MS while hunting.
  moveDue() {
    const c = this.cfg();
    if (!c.on || !c.move || this.move || Town.trip) return '';
    if (now() < this.moveAt) return this.moveDue_ || '';
    this.moveAt = now() + LEVEL_MOVE_CHECK_MS;
    const town = this.nextTown(World.gp?.progression?.level);
    this.moveDue_ = town ? 'moving to ' + town.name + ' (its gear is next for your level)' : '';
    return this.moveDue_;
  },
  moveTick() { if (this.move) this.moveStep(this.move); },
  // Town.leave, in the home town after the services: on to the new town's world statue (with its teleport), instead of
  // the walk back to the hunting spot. False when there is nothing to move to any more.
  startMove(key) {
    const town = Town.towns.find(t => t.key === key), home = this.townOf(this.home());
    if (this.move || Town.trip || !town?.services?.gate || !this.moveOpen(key) || !World.inWorld() || World.isDead()) return false;
    const s = town.services.gate, stand = Town.standPoint(s, town.arrival);
    if (home?.key) this.movedFrom.add(home.key);
    this.move = { key: town.key, home: home?.key, name: town.name, phase: 'walk', at: now(), tries: 0, character: World.charName,
      gate: { ...stand.point, refObjId: s.refObjId, npc: { regionId: s.regionId, x: s.x, y: s.y, z: s.z } } };
    this.moveDue_ = '';
    this.message = 'Moving to ' + town.name + ': its merchants sell the next gear for your level.';
    Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 8000);
    if (Hunt.running) Hunt.stop();
    const started = WalkBack.startTo(this.move.gate, { label: 'the ' + town.name + ' world statue', stop: 60,
      onDone: () => { if (this.move) { this.move.phase = 'select'; this.move.at = now(); } },
      onFail: reason => this.moveFail(reason) });
    // A walk that does not start fails the move, which walks back to the spot itself.
    if (!started && this.move) this.moveFail('the walk did not start');
    return true;
  },
  // At the new town's statue: select it, open its menu (npc-talk), then recall-appoint. The game's client drops the
  // appoint unless that menu is open on the selected statue and it offers the return point (capability 0x40), so a sent
  // request proves nothing: only the game's REBIRTH_POINT_APPOINT notice does.
  moveStep(m) {
    if (m.character !== World.charName) { this.move = null; return; }
    if (m.phase === 'walk' || !World.inWorld()) return;
    if (World.isDead()) return this.moveFail('the character died');
    const gp = World.gp, retry = why => {
      if (++m.tries >= 3) return this.moveFail(why);
      if (gp.npcConversation?.phase) Cmd.raw({ kind: 'npc-close' }, 'Leveling: close the statue menu');
      m.phase = 'select'; m.at = now();
    };
    if (m.phase === 'select') {
      if (now() - m.at > LEVEL_MOVE_STEP_MS) return this.moveFail('the ' + m.name + ' world statue could not be selected');
      const statue = [...World.ents.values()].find(e => Town.serviceEntity('gate', e) && e.refObjId === m.gate.refObjId && dist2D(e, m.gate.npc) < 300);
      if (!statue || gp.targetPending || gp.inventoryPending) return;
      if (gp.target !== statue.gid) { if (Cmd.spaced('select')) Cmd.select(statue.gid); return; }
      if (!((gp.targetCapabilities ?? 0) & 0x40)) return this.moveFail('the ' + m.name + ' world statue offers no return point');
      m.gid = statue.gid; m.phase = 'menu'; m.at = now(); m.talked = false;
      return;
    }
    if (m.phase === 'menu') {
      if (gp.target !== m.gid) return retry('the statue selection changed');
      if (!(gp.npcConversation?.phase === 'menu' && gp.npcConversation.gid === m.gid)) {
        if (!m.talked && now() - m.at > 1000 && Cmd.raw({ kind: 'npc-talk' }, 'Leveling: open the statue menu')) m.talked = true;
        if (now() - m.at > LEVEL_MOVE_STEP_MS) retry('the statue menu did not open');
        return;
      }
      if (Cmd.raw({ kind: 'recall-appoint', gid: m.gid }, 'Leveling: make ' + m.name + ' the return point')) { m.phase = 'appoint'; m.at = now(); m.appointed = false; }
      return;
    }
    if (m.phase === 'appoint') {
      if (m.appointed) {
        if (gp.npcConversation?.phase) Cmd.raw({ kind: 'npc-close' }, 'Leveling: close the statue menu');
        return this.moveDone(m);
      }
      if (now() - m.at >= LEVEL_MOVE_STEP_MS) retry('the world statue did not set the return point');
    }
  },
  notice(n) { if (this.move?.phase === 'appoint' && /REBIRTH_POINT_APPOINT/.test(String(n?.key || ''))) this.move.appointed = true; },
  moveDone(m) {
    this.move = null;
    const done = Town.autoSetup(true, m.key);
    if (!done) return this.moveFail('the town services could not be set up', m);
    Town.lastScrollPoint = null; Town.deathPoint = null;
    this.reset();
    this.message = 'Moved to ' + m.name + ': it is the return point now, and the bot hunts and shops there.';
    Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 8000);
    let spot = this.spotsOn() ? this.spot(World.gp?.progression?.level) : null; const H = Hunt.cfg();
    if (spot && this.foreign(spot)) spot = null;
    if (spot) { H.center = { ...spot.center }; Settings.saveProfile(); bus.emit('center'); }
    // A first trip right here: the new town's potions and gear, then the walk to its spot. Without what a trip needs
    // (potions chosen, gold), straight to the spot.
    if (!Town.validate()) {
      Hunt.running = true;
      Town.begin();
      if (Town.trip) { Town.trip.why = Town.lastTrip.why = 'first visit to ' + m.name; return; }
      if (!Hunt.running) return;
    }
    WalkBack.start(true);
  },
  // A death on the way: hunting takes over (revive, back to the old spot) and the move is tried again later. Anything
  // else: this town is left alone for the session and hunting goes on where it was.
  moveFail(reason, m = this.move) {
    if (!m) return;
    if (m.home) this.movedFrom.delete(m.home);
    this.move = null; this.moveAt = now() + LEVEL_MOVE_CHECK_MS;
    const died = World.isDead();
    if (!died) { this.moveFailed.add(m.key); this.moveFailedAt.set(m.key, now()); }
    this.message = 'Move to ' + m.name + ' stopped: ' + reason + (died ? '; it is tried again after the revive.' : '; the return point is unchanged, it is tried again in ' + Math.round(LEVEL_MOVE_RETRY_MS / 60000) + ' minutes.');
    Log.warn('Leveling: ' + this.message); UI.toast(this.message, 'warn', 8000);
    if (WalkBack.active?.onDone) WalkBack.cancel('', true);
    if (died) Hunt.start(); else if (World.inWorld()) WalkBack.start(true);
  },
  skillsOn() { const c = this.cfg(); return !!(c.on && c.skills); },
  // ---- skills
  // Once per character, in the world: the weapon's mastery is raised with the level and every skill of it learned
  // (Auto mastery, scope "masteries"), and stat points go to Strength, or to Intelligence for a caster (a European
  // caster weapon, or more Intelligence than Strength already). Only what is not set up yet is changed.
  prepare() {
    const c = this.cfg(), gp = World.gp, weapon = (gp?.inventory || []).find(i => i.slot === 6), build = this.build();
    // prepared names the character it was done for: settings copied to another character set that one up again.
    if (!this.skillsOn() || !World.charName || c.prepared === World.charName || !World.inWorld() || (!weapon && !build) || !gp.progression) return false;
    const mastery = build ? build.masteries[0] : LEVEL_WEAPON_MASTERY[this.tids(weapon)[1]];
    if (!mastery) return false;
    const M = Settings.profile.mastery, S = Settings.profile.statPoints, stats = gp.progression.stats || {}, done = [];
    // A chosen build sets the masteries in its order and learns only its own skills (scope "build").
    if (build) { M.enabled = true; M.ids = [...build.masteries]; M.gap = 0; done.push(build.masteries.map(id => AutoMastery.name(id)).join(', ') + ' for the ' + build.label + ' build'); }
    else if (!M.enabled || !M.ids.length) { M.enabled = true; M.ids = [mastery]; M.gap = 0; done.push(AutoMastery.name(mastery) + ' mastery'); }
    const scope = build ? 'build' : 'masteries';
    if (!M.skills || M.scope !== scope) { M.skills = true; M.scope = scope; done.push('its skills'); }
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
    if (this.build()) return false;
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
    const build = this.build();
    if (build) return this.buildImbue(build, M, c, done);
    const skill = UI.learnedSkills(true).find(s => LEVEL_IMBUE_SKILL.test(s.nameSymbol || '') && !done.has(s.group ?? s.id));
    if (!skill) return false;
    done.add(skill.group ?? skill.id); c.imbued = [...done];
    if (!M.imbue) { M.imbue = { id: skill.id, group: skill.group ?? skill.id }; this.message = 'Imbue in use: ' + World.skillName(skill.id) + '.'; Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 5000); }
    Settings.saveProfile();
    return true;
  },
  // A build uses one imbue: its own family, the highest tier learned. A higher tier replaces the lower one of the same family.
  buildImbue(build, M, c, done) {
    if (!build.imbue) return false;
    const groups = this.familyGroups().get(build.imbue) || [];
    const skill = UI.learnedSkills(true).filter(s => groups.includes(s.group ?? s.id) && !done.has(s.group ?? s.id)).sort((a, b) => (b.group ?? b.id) - (a.group ?? a.id))[0];
    if (!skill) return false;
    const group = skill.group ?? skill.id;
    done.add(group); c.imbued = [...done];
    if (!M.imbue || groups.includes(M.imbue.group) && M.imbue.group < group) {
      M.imbue = { id: skill.id, group };
      this.message = 'Imbue in use: ' + World.skillName(skill.id) + '.'; Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 5000);
    }
    Settings.saveProfile();
    return true;
  },
  // A pickup pet collects the drops (gold and gear included) instead of the character running for them, once per character
  // and only while pickup still has the plain default (everything by the character): a choice the player made is kept, and
  // switching back by hand stays.
  petTick() {
    const c = this.cfg(), P = Hunt.cfg().pickup;
    if (!World.charName || c.pet === World.charName || !Loot.pet()) return false;
    c.pet = World.charName;
    if (P.collector === 'pet' || Object.keys(P.by || {}).length) { Settings.saveProfile(); return false; }
    P.collector = 'pet';
    this.message = 'Your pickup pet now collects the drops, gold and gear included.';
    Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 6000);
    Settings.saveProfile();
    return true;
  },
  // ---- builds
  // The chosen build, or null for Auto (an unknown key is Auto too).
  build() { const key = this.cfg().build; return key && key !== 'auto' ? this.builds.find(b => b.key === key) || null : null; },
  fits(b) { const { country } = this.who(); return country === null || country === undefined || b.race === country; },
  about() { const b = this.build(); return b ? b.about : 'Uses the weapon you wear: its mastery, then Cold, Lightning and Fire. Skills that root or block the character are never used.'; },
  // Skill families -> the groups the game has for them (lowest tier first), without the blocked ones.
  familyGroups() {
    const w = World.groups;
    if (this.familyCache?.src === w && this.familyCache.size === w.size) return this.familyCache.map;
    const map = new Map();
    for (const [group, rows] of w) {
      const f = levelFamily(rows[0]);
      if (!f || this.blockedGroups[group]) continue;
      if (!map.has(f)) map.set(f, []);
      map.get(f).push(group);
    }
    for (const list of map.values()) list.sort((a, b) => a - b);
    this.familyCache = { src: w, size: w.size, map };
    return map;
  },
  // Every group the build raises and learns, in order: rotation, buffs, imbue, extra learns, then the passives of its masteries.
  buildGroups() {
    const b = this.build();
    if (!b) return [];
    const fg = this.familyGroups(), out = [], seen = new Set();
    const add = f => { for (const g of fg.get(f) || []) if (!seen.has(g)) { seen.add(g); out.push(g); } };
    [...b.rotation, ...b.buffs, b.imbue, ...(b.learn || [])].filter(Boolean).forEach(add);
    for (const [f, e] of Object.entries(BUILD_SKILLS)) if (e[2] === 'passive' && b.masteries.includes(e[0])) add(f);
    return out;
  },
  setBuild(key) {
    const c = this.cfg();
    c.build = key === 'auto' || this.builds.some(b => b.key === key) ? key : 'auto';
    c.prepared = ''; c.elements = ''; c.added = []; c.imbued = []; this.skillAt = 0;
    AutoMastery.reset(); Settings.saveProfile();
  },
  // Skills leveling added on its own that root the character (Crystal Wall, Fire Wall) come out of the rotation and the
  // buffs. One the player added by hand stays, with one line in the log.
  dropBlocked() {
    const c = this.cfg(), M = Settings.profile.macro, added = new Set(c.added || []), names = [];
    for (const list of [M.rotations.normal, M.buffs]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const group = list[i].group ?? list[i].id, why = this.blockedGroups[group];
        if (!why) continue;
        if (added.has(group)) { names.push(World.skillName(list[i].id)); list.splice(i, 1); }
        else if (!this.warned.has(group)) { this.warned.add(group); Log.warn('Leveling: ' + World.skillName(list[i].id) + ' (added by you) ' + why + '; it stays in your list.'); }
      }
    }
    if (!names.length) return;
    Settings.saveProfile();
    this.message = 'Taken out: ' + names.join(', ') + ' (they keep the character from moving).';
    Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 6000);
  },
  // Newly learned attack skills join the normal rotation, newly learned self buffs the buffs, each group once: a skill
  // the player takes out stays out. Only skills of the chosen masteries, never a blocked one. With a build only the
  // build's own skills, placed in the build's order; a higher tier of a skill replaces the lower one.
  skillTick() {
    if (!this.skillsOn() || now() < this.skillAt) return;
    this.skillAt = now() + LEVEL_SKILL_CHECK_MS;
    this.prepare();
    this.dropBlocked();
    if (!World.inWorld() || !World.groups.size) return;
    if (World.charName && this.cfg().elements !== World.charName && this.cfg().prepared === World.charName && this.addElements(Settings.profile.mastery)) { AutoMastery.reset(); Settings.saveProfile(); }
    this.imbueTick();
    this.petTick();
    const c = this.cfg(), M = Settings.profile.macro, build = this.build(), mine = new Set(AutoMastery.masteryGroups()), added = new Set(c.added || []), names = [];
    const fg = build ? this.familyGroups() : null, learned = new Set(Learned.rows().map(s => s.group ?? s.id));
    const rank = fams => { const r = new Map(); fams.forEach((f, i) => (fg.get(f) || []).forEach(g => r.set(g, i))); return r; };
    const take = (s, list, extra, ranks) => {
      const group = s.group ?? s.id;
      if (this.blockedGroups[group] || added.has(group)) return;
      if (build) {
        if (!ranks.has(group)) return;
        const tiers = fg.get(levelFamily(s)) || [], at = tiers.indexOf(group);
        if (tiers.slice(at + 1).some(g => learned.has(g))) { added.add(group); return; }
        // The lower tiers this one replaces: only those leveling put there itself.
        for (const g of tiers.slice(0, at)) { const i = list.findIndex(e => (e.group ?? e.id) === g); if (i >= 0 && added.has(g)) list.splice(i, 1); }
      } else if (!mine.has(group)) return;
      added.add(group);
      if (list.some(e => (e.group ?? e.id) === group)) return;
      const entry = { id: s.id, group, ...extra };
      const place = build ? list.findIndex(e => ranks.has(e.group ?? e.id) && ranks.get(e.group ?? e.id) > ranks.get(group)) : -1;
      if (place >= 0) list.splice(place, 0, entry); else list.push(entry);
      names.push(World.skillName(s.id));
    };
    const attackRanks = build ? rank(build.rotation) : null, buffRanks = build ? rank(build.buffs) : null;
    for (const s of UI.learnedSkills(false)) take(s, M.rotations.normal, {}, attackRanks);
    for (const s of UI.learnedSkills(true)) take(s, M.buffs, { enabled: true, mode: 'hunt', refreshS: 3 }, buffRanks);
    if (added.size === (c.added || []).length) return;
    c.added = [...added]; Settings.saveProfile();
    if (names.length) { this.message = 'New skills in use: ' + names.join(', ') + '.'; Log.info('Leveling: ' + this.message); UI.toast(this.message, 'info', 5000); }
  },
  // Turning it on sets the pieces it relies on: "no XP" moves to another spot, and the town for the trips.
  enable(on) {
    const c = this.cfg(), T = Town.cfg();
    c.on = on;
    if (on) {
      c.prepared = ''; c.elements = ''; c.imbued = []; c.pet = ''; this.skillAt = 0; this.moveFailed.clear(); this.moveFailedAt.clear(); this.movedFrom.clear();
      T.noXp = { ...T.noXp, on: true, action: 'nextSpot' };
      if (!T.enabled && World.inWorld()) Setup.setupTown();
    }
    this.reset(); Settings.saveProfile(); UI.draw();
    UI.toast(on ? 'Zero-setup leveling on: the bot picks spots for your level and buys better NPC gear on town trips.' : 'Zero-setup leveling off.', 'info', 6000);
  },
  draw() {
    const c = () => this.cfg(), status = el('p', this.status(), 'muted'), about = el('p', this.about(), 'muted');
    UI.refreshers.push(() => { status.textContent = this.status(); about.textContent = this.about(); });
    return UI.group('Zero-setup leveling',
      el('p', 'For levelling a character with no setup: the bot picks a hunting spot for your level from the game data, moves on as you level, and buys the next tier of weapon, armour and accessories from the town merchants on its town trips. Gear above +' + LEVEL_GEAR_MAX_PLUS + ' or protected gear is never replaced; Seal gear is replaced when the town sells a higher level, but kept in the bag, never sold. It can also raise your weapon\'s mastery, learn its skills, put new attack skills and buffs to use and spend stat points (Strength, or Intelligence for a caster); what you already set up there is kept.', 'muted'),
      UI.check('Level up by itself', () => c().on, v => this.enable(v)),
      UI.check('Pick hunting spots for my level', () => c().spots, v => { c().spots = v; this.reset(); }),
      UI.check('Buy better gear from the town merchants', () => c().gear, v => { c().gear = v; }),
      UI.check('Also buy earrings, necklaces and rings', () => c().accessories, v => { c().accessories = v; }),
      UI.check('Sell the replaced piece back', () => c().sellOld, v => { c().sellOld = v; }),
      UI.check('Move to the next town when this one has no better gear (Jangan, then Donwhang, then Hotan)', () => c().move, v => { c().move = v; this.moveFailed.clear(); this.moveFailedAt.clear(); this.movedFrom.clear(); }),
      UI.check('Raise my weapon mastery, learn its skills and use them', () => c().skills, v => { c().skills = v; c().prepared = ''; c().elements = ''; c().imbued = []; this.skillAt = 0; }),
      UI.select('Character build', () => [['auto', 'Auto (from my weapon)'], ...this.builds.filter(b => this.fits(b) || b.key === c().build).map(b => [b.key, b.label])], () => this.build()?.key || 'auto', v => this.setBuild(v)),
      about,
      UI.number('Always keep this much gold', () => c().reserve, v => { c().reserve = v; }, 0, 100000000, 1000),
      status);
  },
};
bus.on('notice', n => Leveling.notice(n));
