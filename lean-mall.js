// Read-only Item Mall probe. Opens the mall catalogue with the game's own mall-open command — nothing is bought —
// and prints the account balance and every offer with its live address and packageId, so real prices and item ids
// can be captured before anything automated is built on top of them. mall-buy is deliberately absent from this
// object, and nothing runs by itself: both functions are called by hand from the console.
const MallProbe = {
  open() {
    if (!World.inWorld()) return 'Enter the game first.';
    if (World.gp.inventoryPending) return 'An inventory transaction is pending; try again in a moment.';
    return Cmd.raw({ kind: 'mall-open' }, 'Item mall: open catalogue (read-only)')
      ? 'Catalogue requested; read it with SROLean.mall.dump() a few seconds later.' : 'The command was not sent.';
  },
  state() { return World.gp?.itemMall ?? null; },
  // dump('potion') lists only offers whose name contains the text (case-insensitive); dump() lists everything.
  // Returns the balances and prints one console row per offer: name, price, purchase limit, address, package, items.
  dump(filter = '') {
    const s = this.state();
    if (!s) return 'No catalogue yet: call SROLean.mall.open() first, then dump() a few seconds later.';
    const f = String(filter).toLowerCase();
    const rows = (s.offers || []).filter(o => !f || (o.name || '').toLowerCase().includes(f)).map(o => ({
      name: o.name, silk: o.silk, giftSilk: o.giftSilk, maxQty: o.purchaseLimit,
      address: o.group + '/' + o.shop + '/' + o.tab + '/' + o.slot, packageId: o.packageId, items: (o.itemIds || []).join(',')
    }));
    console.table(rows);
    return { silk: s.silk, giftSilk: s.giftSilk, points: s.points, offers: (s.offers || []).length, shown: rows.length,
      pending: s.pending, revision: s.revision, error: s.error ?? null };
  },
};
// The Item Mall buyer. The mall wallet is account-wide and burn-only, so every purchase is bounded by a per-bot-run
// silk budget (mall.on + budgetSilk > 0), one order is in flight at a time, and one unit is bought per order: the
// delivered amount is measured from the inventory, so an unknown package size just means another order next tick.
// The game client poisons its mall state when a purchase is not confirmed within 10 s ("reconnect to resynchronize"),
// so an unconfirmed order blocks all mall buying until the world is left — never resend. A refused order (balance,
// full bag) backs that item off for a minute instead. The merchant town trips stay the primary supply: this never
// blocks hunting, it just tops up mid-fight between targets.
const MALL_HP_REF = 5912;   // HP SuperSet 5 bag (the X-Large stack the merchant route cannot sell)
const MALL_BUY_GAP_MS = 2000, MALL_REFUSE_BACKOFF_MS = 60000, MALL_TIMEOUT_MS = 9500, MALL_CALM_MS = 1500, MALL_PROBE_MS = 10000;
const MallBuyer = {
  pending: null, spentSilk: 0, openedAt: -Infinity, lastAt: -Infinity, poison: false, refused: new Map(), goals: new Map(),
  busyAt: -Infinity, probeAt: -Infinity, probeRevision: null, message: 'Item mall off.',
  cfg() { return Settings.profile.mall; },
  on() { return !!this.cfg().on && (Number(this.cfg().budgetSilk) || 0) > 0; },
  state() { return World.gp?.itemMall ?? null; },
  silk() { return Number(this.state()?.silk ?? 0); },
  count(ref) { return World.items().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  reset() { this.pending = null; this.spentSilk = 0; this.openedAt = -Infinity; this.lastAt = -Infinity; this.refused.clear(); this.goals.clear(); this.message = 'Item mall off.'; },
  unpoison() { this.poison = false; this.probeRevision = null; },
  // The live offer whose package contains this item. Never a remembered address: the server stale-checks packageId.
  offerFor(ref) { return (this.state()?.offers || []).find(o => (o.itemIds || []).includes(ref) && (o.silk || 0) > 0) || null; },
  // What may be bought right now, in priority order. HP/MP count the whole potion stock, mall bags included.
  buyers() {
    const c = this.cfg(), out = [];
    if (c.hp?.on) out.push({ label: 'HP potion bag', ref: MALL_HP_REF, low: c.hp.low, target: c.hp.target, count: () => Potion.count('hp') });
    if (c.mp?.on) out.push({ label: 'MP potion bag', ref: 5913, low: c.mp.low, target: c.mp.target, count: () => Potion.count('mp') });
    if (c.damageInc?.on) out.push({ label: '20% damage scroll pack', ref: 3767, low: c.damageInc.low, target: c.damageInc.target, count: () => this.count(3767) });
    if (c.damageAbs?.on) out.push({ label: '20% resistance scroll pack', ref: 3768, low: c.damageAbs.low, target: c.damageAbs.target, count: () => this.count(3768) });
    if (c.reverse?.on) out.push({ label: 'Reverse Return Scroll pack', ref: 3795, low: c.reverse.low, target: c.reverse.target, count: () => this.count(3795) });
    return out;
  },
  tick() {
    if (!World.inWorld() || World.isDead() || !Hunt.running || Town.trip || Restock.trip || Restock.activeShop() || World.gp?.inventoryPending || World.gp?.storage) { this.busyAt = now(); return false; }
    if (this.poison) {
      // An unconfirmed order may simply never have reached the server: the worker refuses gameplay mall
      // commands while an inventory transaction is open and answers nothing. A read-only catalogue open
      // is the safe probe — only a responsive mall moves its revision, so a change proves the session is
      // usable again (and a genuinely poisoned client stays silent, keeping the block).
      const s = this.state();
      if (now() - this.probeAt >= MALL_PROBE_MS && Cmd.spaced('mall-open')) {
        if (s && this.probeRevision == null) this.probeRevision = s.revision;
        if (Cmd.raw({ kind: 'mall-open' }, 'Item mall: reopen the catalogue (health probe)')) this.probeAt = now();
      }
      if (s && this.probeRevision != null && s.revision !== this.probeRevision) {
        this.poison = false; this.probeRevision = null; this.lastAt = now() - MALL_BUY_GAP_MS;
        this.message = 'Item mall responsive again; buying resumes.';
        Log.info('Item mall: ' + this.message);
      } else {
        this.message = 'Item mall buying is blocked after an unconfirmed order; probing the catalogue.';
        return false;
      }
    }
    if (!this.on()) return false;
    // Let an item-use that has not published its inventory transaction yet clear first: the worker
    // silently refuses a mall order that lands inside one (seen live: the scroll buff's use).
    if (now() - this.busyAt < MALL_CALM_MS) return false;
    const p = this.pending;
    if (p) {
      const s = this.state(), count = p.countFn();
      // A refusal bumps the revision exactly like a delivery does, with the error set — so the error decides
      // which one it was. An error left over from an earlier refusal does not: its revision is already behind.
      if (s && !s.pending && s.revision > p.revision) {
        if (s.error) {
          this.refused.set(p.ref, now() + MALL_REFUSE_BACKOFF_MS);
          this.pending = null;
          this.message = 'Item mall refused ' + p.label + ' (' + s.error + ').';
          UI.toast(this.message, 'warn', 6000);
          return false;
        }
        this.spentSilk += p.silk;
        this.pending = null;
        this.message = p.label + ' delivered; ' + Math.max(0, count - p.before) + ' received.';
        Log.info('Item mall: ' + this.message);
        return false;
      }
      if (count > p.before) { this.spentSilk += p.silk; this.pending = null; this.message = p.label + ' delivered.'; return false; }
      if (now() - p.at > MALL_TIMEOUT_MS) {
        this.pending = null; this.poison = true;
        this.message = 'Item mall purchase unconfirmed; mall buying blocked until you re-enter the game.';
        Log.warn('Item mall: ' + this.message);
        UI.toast(this.message, 'warn', 8000);
        return false;
      }
      this.message = p.label + ' ordered; waiting for delivery.';
      return false;
    }
    if (!this.state()) {
      if (now() - this.openedAt < 3000) return false;
      if (Cmd.spaced('mall-open') && Cmd.raw({ kind: 'mall-open' }, 'Item mall: open catalogue')) {
        this.openedAt = now();
        this.message = 'Item mall catalogue requested.';
      }
      return false;
    }
    if (this.state().pending) return false; // the game's own basket has an order out; leave it alone
    if (now() - this.lastAt < MALL_BUY_GAP_MS) return false;
    for (const b of this.buyers()) {
      if ((this.refused.get(b.ref) ?? 0) > now()) continue;
      const count = b.count();
      // Crossing the low mark arms a refill all the way to the target, like the merchant restock's low/target pair.
      if (count < b.low) this.goals.set(b.ref, b.target);
      if (count >= (this.goals.get(b.ref) ?? 0)) continue;
      const offer = this.offerFor(b.ref);
      if (!offer) { this.message = 'No Item mall offer for ' + b.label + ' right now.'; continue; }
      const price = Number(offer.silk) || 0;
      if (price <= 0) continue;
      // The client refuses to even send an order the wallet cannot honour in its other currencies, and the
      // game would read that as an unconfirmed purchase: skip such offers here.
      if ((Number(offer.giftSilk) || 0) > (Number(this.state()?.giftSilk) || 0)) { this.message = 'Not enough gift silk for ' + b.label + '.'; continue; }
      const budget = Number(this.cfg().budgetSilk) || 0;
      if (this.spentSilk + price > budget || price > this.silk()) {
        this.message = 'The silk budget or balance stops ' + b.label + '.';
        continue;
      }
      // Delivery lands in the bag: a free slot is needed unless the same stack has room.
      const stack = World.items().find(i => i.refObjId === b.ref);
      if (!stack && World.freeBagSlots() < 1) { this.message = 'No free bag slot for ' + b.label + '.'; continue; }
      const request = { group: offer.group, shop: offer.shop, tab: offer.tab, slot: offer.slot, quantity: 1, points: 0, packageId: offer.packageId };
      if (Cmd.spaced('mall-buy') && Cmd.raw({ kind: 'mall-buy', request }, 'Item mall: ' + b.label)) {
        this.pending = { label: b.label, ref: b.ref, silk: price, before: count, countFn: b.count, revision: this.state().revision, at: now() };
        this.lastAt = now();
        this.message = b.label + ' ordered; waiting for delivery.';
        return true;
      }
    }
    return false;
  },
};

// The silk budget is per bot run: a restart gives a fresh one, but a poisoned mall state survives it (the game
// client itself refuses mall commands until the world is re-entered).
bus.on('hunt', running => { if (running) { const poison = MallBuyer.poison; MallBuyer.reset(); MallBuyer.poison = poison; } });
