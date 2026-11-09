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
const MALL_REVERSE_REF = 3795; // ITEM_MALL_REVERSE_RETURN_SCROLL: Item mall only, never sold for gold
const MALL_TOWN_REVERSE_MS = 30000; // how long a town trip waits for a mall reverse scroll before walking back
const MALL_BUY_GAP_MS = 2000, MALL_REFUSE_BACKOFF_MS = 60000, MALL_TIMEOUT_MS = 9500, MALL_CALM_MS = 1500, MALL_PROBE_MS = 10000;
const MallBuyer = {
  pending: null, spentSilk: 0, openedAt: -Infinity, lastAt: -Infinity, poison: false, refused: new Map(), goals: new Map(),
  busyAt: -Infinity, probeAt: -Infinity, probeRevision: null, skipped: '', message: 'Item mall off.',
  cfg() { return Settings.profile.mall; },
  budget() { return Number(this.cfg().budgetSilk) || 0; },
  // The Reverse Return Scroll switch is its own opt-in (the only place it can be bought: no merchant sells it for
  // gold), so it buys even with the general "Buy from the Item mall" switch off. Both share the silk budget.
  on() { return this.budget() > 0 && (!!this.cfg().on || !!this.cfg().reverse?.on); },
  // Why reverse scrolls cannot be bought right now, or '' when they can be ordered.
  reverseBlocked() {
    const c = this.cfg();
    if (!c.reverse?.on) return 'Reverse Return Scroll buying is off.';
    if (this.budget() <= 0) return 'Set an Item mall silk budget to buy Reverse Return Scrolls.';
    if (this.poison) return 'Item mall buying is blocked after an unconfirmed order.';
    if ((this.refused.get(MALL_REVERSE_REF) ?? 0) > now()) return 'The Item mall refused the last Reverse Return Scroll order.';
    return '';
  },
  reverseBuyer(target) {
    const c = this.cfg().reverse, low = Math.max(0, Number(c.low) || 0);
    return { label: 'Reverse Return Scroll', ref: MALL_REVERSE_REF, low, target: target ?? Math.max(low + 1, Number(c.target) || 0), count: () => this.count(MALL_REVERSE_REF) };
  },
  state() { return World.gp?.itemMall ?? null; },
  silk() { return Number(this.state()?.silk ?? 0); },
  count(ref) { return World.items().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  // The budget is per bot run, so a world transition or profile change keeps what was spent; only newRun() clears it.
  // An order still in flight counts as spent: it may well have been delivered.
  reset() { if (this.pending) this.spentSilk += this.pending.silk; this.pending = null; this.openedAt = -Infinity; this.lastAt = -Infinity; this.refused.clear(); this.goals.clear(); this.message = 'Item mall off.'; },
  newRun() { this.spentSilk = 0; },
  unpoison() { this.poison = false; this.probeRevision = null; },
  // The live offer for this item. Never a remembered address: the server stale-checks packageId. The same item can
  // be listed more than once (its own tab, a "hot" tab, a bundle with other items): prefer a package of only this
  // item, then the cheapest.
  offerFor(ref) {
    const offers = (this.state()?.offers || []).filter(o => (o.itemIds || []).includes(ref) && (o.silk || 0) > 0);
    const only = o => (o.itemIds || []).every(id => id === ref) ? 0 : 1;
    return offers.sort((a, b) => only(a) - only(b) || a.silk - b.silk)[0] || null;
  },
  // What may be bought right now, in priority order. HP/MP count the whole potion stock, mall bags included.
  buyers() {
    const c = this.cfg(), out = [];
    if (c.on) this.generalBuyers(c, out);
    // Zero-setup leveling walks back and never uses reverse scrolls, so do not spend silk on them.
    if (c.reverse?.on && !Leveling.cfg().on) out.push(this.reverseBuyer());
    return out;
  },
  generalBuyers(c, out) {
    if (c.hp?.on) out.push({ label: 'HP potion bag', ref: MALL_HP_REF, low: c.hp.low, target: c.hp.target, count: () => Potion.count('hp') });
    if (c.mp?.on) out.push({ label: 'MP potion bag', ref: 5913, low: c.mp.low, target: c.mp.target, count: () => Potion.count('mp') });
    if (c.damageInc?.on) out.push({ label: '20% damage scroll pack', ref: 3767, low: c.damageInc.low, target: c.damageInc.target, count: () => this.count(3767) });
    if (c.damageAbs?.on) out.push({ label: '20% resistance scroll pack', ref: 3768, low: c.damageAbs.low, target: c.damageAbs.target, count: () => this.count(3768) });
    return out;
  },
  tick() {
    // Only inventory activity arms the calm window: a town trip must not, or its own mall reverse purchase
    // (townReverse) would wait forever.
    if (World.gp?.inventoryPending || World.gp?.storage || Restock.activeShop()) { this.busyAt = now(); return false; }
    if (!World.inWorld() || World.isDead() || !Hunt.running || Town.trip || Restock.trip) return false;
    return this.drive(this.buyers());
  },
  // Town trip, after the services and before the way back: buy one Reverse Return Scroll so the trip reverses
  // instead of walking. The hunting top-up refills to the target later. Returns 'wait' while an order can still
  // arrive, 'done' once one is in the bag, or the reason it cannot be bought (the trip then walks back).
  townReverse(since) {
    const have = () => this.count(MALL_REVERSE_REF) > 0;
    if (have() && !this.pending) return 'done';
    const blocked = this.reverseBlocked();
    if (blocked) return have() ? 'done' : blocked;
    if (now() - since > MALL_TOWN_REVERSE_MS && !this.pending) return 'The Item mall did not deliver a Reverse Return Scroll in time.';
    if (!World.inWorld() || World.isDead() || Restock.activeShop() || World.gp?.inventoryPending || World.gp?.storage || World.isCasting()) { this.busyAt = now(); return 'wait'; }
    const b = this.reverseBuyer(1);
    this.goals.set(b.ref, Math.max(1, this.goals.get(b.ref) ?? 0));
    this.drive([b]);
    // A pass that skipped the only buyer for a hard reason (no offer, budget, wallet, bag) will not change by waiting.
    if (have()) return 'done';
    return !this.pending && this.skipped ? this.skipped : 'wait';
  },
  drive(buyers) {
    this.skipped = '';
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
        this.spentSilk += p.silk; this.pending = null; this.poison = true; // unconfirmed is not unpaid
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
    for (const b of buyers) {
      if ((this.refused.get(b.ref) ?? 0) > now()) continue;
      const count = b.count();
      // Reaching the low mark (the panel's "low stock ≤") arms a refill all the way to the target, like the
      // merchant restock's low/target pair.
      if (count <= b.low) this.goals.set(b.ref, b.target);
      if (count >= (this.goals.get(b.ref) ?? 0)) continue;
      const offer = this.offerFor(b.ref);
      if (!offer) { this.message = this.skipped = 'No Item mall offer for ' + b.label + ' right now.'; continue; }
      const price = Number(offer.silk) || 0;
      if (price <= 0) continue;
      // The client refuses to even send an order the wallet cannot honour in its other currencies, and the
      // game would read that as an unconfirmed purchase: skip such offers here.
      if ((Number(offer.giftSilk) || 0) > (Number(this.state()?.giftSilk) || 0)) { this.message = this.skipped = 'Not enough gift silk for ' + b.label + '.'; continue; }
      if (this.spentSilk + price > this.budget() || price > this.silk()) {
        this.message = this.skipped = (price > this.silk() ? 'Not enough silk for ' : 'The silk budget for this run is used up: no more ') + b.label + '.';
        continue;
      }
      // Delivery lands in the bag: a free slot is needed unless the same stack has room.
      const stack = World.items().find(i => i.refObjId === b.ref);
      if (!stack && World.freeBagSlots() < 1) { this.message = this.skipped = 'No free bag slot for ' + b.label + '.'; continue; }
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
bus.on('hunt', running => { if (running) { const poison = MallBuyer.poison; MallBuyer.reset(); if (!Quest.resuming) MallBuyer.newRun(); MallBuyer.poison = poison; } });
