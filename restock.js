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
    return cat === 1 ? 'hp' : cat === 2 ? 'mp' : cat === 3 ? 'vigor' : cat === 9 ? 'hgp' : cat === 4 ? 'kit' : o.refObjId === 58 && ItemType.isCure(item?.typeFlags ?? 0) ? 'cure' : o.refObjId === 3795 ? 'reverse' : '';
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
    this.unbuyable.clear();
    Settings.saveProfile();
    this.tell('Route and hunt centre saved. Choose potions and quantities, then enable auto buying.');
  },
  // Fixed retail Special Universal Pill (small): strongest universal cure, ref 58.
  // Pet supplies need a chosen item, and one the recorded merchant turned out not to sell must not re-trigger
  // trips for the rest of the session (re-record the merchant to retry); a profile switch clears that memory.
  unbuyable: new Set(),
  supplies() {
    const c = this.cfg();
    return ['hp', 'mp', 'vigor', 'cure', 'hgp', 'kit', 'reverse']
      .filter(k => c[k].on && !this.unbuyable.has(c[k].refObjId) && ((k === 'hgp' || k === 'kit') ? c[k].refObjId > 0 : true))
      .map(k => ({ kind: k, ...c[k], ...(k === 'cure' ? { refObjId: 58 } : {}) }));
  },
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
    if (distance < t.best - 3) { t.best = distance; t.progressAt = now(); }
    if (now() - t.progressAt > 20000) return this.fail('Movement blocked for 20 seconds. Check the recorded path.');
    if (World.isSitting()) {
      if (now() - t.movedAt > 2500 && Cmd.action(1000)) t.movedAt = now();
      return false;
    }
    // A recorded step is walked straight unless the character is stuck; then collision routing goes round the spot.
    if (Navigation.watch(t, World.pose(), t.movedAt, dest) === 'giveup') return this.fail('Blocked on the way to the merchant; I could not walk around the obstacle.');
    const step = Navigation.next(t, dest, true);
    if (now() - t.movedAt > 900 && Cmd.move(step.point || dest)) t.movedAt = now();
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
      t.skipped ||= [];
      const s = t.supplies.find(i => !t.skipped.includes(i.refObjId) && this.count(i.refObjId) < i.target);
      if (!s) {
        if (Cmd.raw({ kind: 'npc-close' }, 'Auto buy: close merchant')) {
          t.phase = 'return'; t.index = 1; t.best = Infinity; t.progressAt = now(); t.movedAt = 0;
          this.message = 'Returning to hunting spot';
        }
        return true;
      }
      const offer = shop.offers.find(o => o.refObjId === s.refObjId && this.offerKind(o) === s.kind);
      // Pet supplies are a convenience here: a merchant without them must not stop the potion refill.
      if (!offer && (s.kind === 'hgp' || s.kind === 'kit' || s.kind === 'reverse')) { t.skipped.push(s.refObjId); this.unbuyable.add(s.refObjId); this.tell('This merchant does not sell ' + (s.kind === 'hgp' ? 'HGP recovery potions' : s.kind === 'kit' ? 'pet recovery kits' : 'Reverse Return Scrolls') + '; skipped them for this session.'); return true; }
      if (!offer) { this.fail(s.kind === 'cure' ? 'Special Universal Pill (small) is unavailable at this merchant.' : 'Selected potion is unavailable at this merchant.'); return true; }
      const before = this.count(s.refObjId);
      const stackRoom = World.items().filter(i => i.refObjId === s.refObjId).reduce((n, i) => n + Math.max(0, offer.maxStack - (i.quantity ?? 1)), 0);
      let quantity = Math.min(s.target - before, offer.purchaseLimit ?? offer.maxStack, 65535, stackRoom + World.freeBagSlots() * offer.maxStack);
      if (quantity < 1) { this.fail('Inventory full; make room for potions.'); return true; }
      const gold = gp.progression?.gold;
      if (gold === undefined) { this.fail('Not enough gold for the potion refill.'); return true; }
      // Short on gold: buy what the gold covers and go back, instead of stopping in the shop.
      const price = toBigInt(offer.price), have = toBigInt(gold);
      if (price > 0n && price * BigInt(quantity) > have) quantity = Number(have / price);
      if (quantity < 1) {
        if (before > 0) { t.skipped.push(s.refObjId); return true; }
        this.fail('Not enough gold for the potion refill.'); return true;
      }
      if (Cmd.raw({ kind: 'shop-buy', tab: offer.tab, slot: offer.slot, quantity }, `Auto buy: ${offer.name} x${quantity}`)) t.pending = { ref: s.refObjId, before, quantity, at: now() };
      return true;
    }
    return true;
  },
  build() {
    const c = () => this.cfg();
    const status = h('div', { class: 'dim small-text' });
    const rows = ['hp', 'mp'].map(kind => h('div', { class: 'row wrap' },
      check(kind.toUpperCase(), () => c()[kind].on, v => c()[kind].on = v),
      selectBox(() => [[0, 'Choose potion'], ...c().offers.filter(o => o.kind === kind).map(o => [o.refObjId, o.name])], () => c()[kind].refObjId, v => c()[kind].refObjId = v),
      h('span', { text: 'Low ≤' }), numInput(() => c()[kind].low, v => c()[kind].low = v, { min: 0, max: 9999, width: 50 }),
      h('span', { text: 'Refill to' }), numInput(() => c()[kind].target, v => c()[kind].target = v, { min: 1, max: 10000, width: 55 })
    ));
    status.refresh = () => { status.textContent = this.recording ? 'Recording route: ' + this.draft.route.length : `${c().vendor?.name || 'No merchant saved'} · ${c().route.length} ${'waypoints'} · ${this.message}`; };
    Bind.all.add(status);
    status.refresh();
    return box('Auto buy potions and return to hunting',
      check('Auto buy while hunting', () => c().enabled, v => c().enabled = v),
      h('div', { class: 'row wrap' }, button('Record route from merchant', () => this.beginRecording()), button('Finish route (hunting spot)', () => this.finishRecording()), button('Cancel recording', () => this.cancelRecording())),
      ...rows, status,
      h('div', { class: 'dim small-text', text: 'Open the potion shop → record route → close shop → walk to the hunting spot → finish route. Buys when the selected potion count runs low, then returns and resumes hunting. Walking routes only; no teleports.' })
    );
  },
};
