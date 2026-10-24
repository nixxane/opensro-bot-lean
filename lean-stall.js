// Auto stall: open the character's own street stall in town and sell bag items at prices you set per item
// (like sBot's stall). The worker contract, read from the live client: stall-name enters a local naming phase,
// stall-create {title, greeting} opens the stall (phase 'owner'), stall-add {slot, bagSlot, quantity, price}
// registers an offer while the stall is still closed, stall-open {open, network} opens it for business and can
// list it on the stall network, stall-close tears it down. World.gp.stall is undefined while no stall is open,
// otherwise { phase: 'none'|'naming'|'owner'|'visitor', owner, title, open, offers: [{slot, item, bagSlot,
// quantity, price}], visitors }. A sale shows as the offer disappearing while gold rises; a dispatch is never
// proof, every step waits for its state change and is never resent.
const STALL_MAX_OFFERS = 10;
const STALL_STEP_TIMEOUT_MS = 15000;
const Stall = {
  run: null, pending: null, message: 'Idle. Price items on this page, stand in town and open the stall.',
  started: false,
  cfg() { return Settings.profile.stall; },
  // A price entry is the offer rule for that exact item id; 0 or invalid clears it.
  price(id) { const p = Number(this.cfg().prices?.[id]); return Number.isInteger(p) && p >= 1 && p <= 4294967295 ? p : 0; },
  setPrice(id, price) {
    const prices = this.cfg().prices;
    if (Number.isInteger(price) && price >= 1 && price <= 4294967295) prices[id] = price;
    else delete prices[id];
    Settings.saveProfile();
  },
  stall() { const s = World.gp?.stall; return s && s.phase !== 'none' ? s : null; },
  offers() { return this.stall()?.phase === 'owner' ? this.stall().offers || [] : []; },
  // Bag items with a price that are not already offered or skipped. A price is explicit intent, so the general
  // loot protections do not apply; stackables offer their whole stack, equipment one piece.
  candidates(r = this.run) {
    const offered = new Set(this.offers().map(o => o.bagSlot)), skip = r ? r.skip : new Set();
    return World.items().filter(i => !offered.has(i.slot) && !skip.has(i.slot) && this.price(i.refObjId) > 0);
  },
  // ownStall: the session's own stall is expected mid-run; only a fresh start refuses any open stall.
  blocked(ownStall = false) {
    const gp = World.gp;
    if (!World.inWorld() || !gp || !World.local()) return 'Enter the game world first.';
    if (World.isDead()) return 'Stall stopped: character died.';
    if (Alchemy.run || Alchemy.pending) return 'Stop alchemy and wait for its result first.';
    if (BuffGear.run || BuffGear.recovery) return 'Restore or review combat gear first.';
    if (Hunt.running || Town.trip || WalkBack.active || Restock.trip || Restock.recording || Resurrect.trip || Controller.resumeAfterRevive) return 'Stop hunting, travel and route recording first.';
    if (Loot.active) return 'Stop collection and wait for its inventory transaction first.';
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting) return 'Close shop, storage and trade first.';
    if (!ownStall && gp.stall?.phase && gp.stall.phase !== 'none') return 'Close the open stall first.';
    if (World.isCasting() || gp.pendingMoves) return 'Wait for casts and movement to finish.';
    return '';
  },
  start() {
    if (this.run) return;
    const gp = World.gp, error = this.blocked();
    const reject = text => { this.message = text; UI.toast(text, 'warn'); };
    if (error) return reject(error);
    if (gp.inventoryPending) return reject('Wait for settled inventory state.');
    if (World.isSitting()) return reject('Stand up first.');
    if (!Town.detect()) return reject('Stalls open in town only: stand inside one of the known towns.');
    const c = this.cfg();
    const list = this.candidates();
    if (!list.length) return reject('No priced bag items to offer. Give items a price on this page first.');
    this.run = { phase: 'name', character: World.charName, config: JSON.stringify(c), manualAt: Manual.lastAt,
      skip: new Set(), refusals: 0, sold: 0, earned: 0n, openedAt: 0, lastGold: toBigInt(gp.progression?.gold), offersAt: null };
    this.pending = null;
    this.message = 'Opening the stall.';
    Activity.emit({ category: 'stall', code: 'stall-started', text: 'Stall session started: offering ' + list.length + ' priced item' + (list.length === 1 ? '' : 's') + '.', outcome: 'requested' });
  },
  // Stop the session. A stall this session opened is closed again (only when the observed state still shows it,
  // so a world reset never sends a command the worker would refuse); `quiet` drops it without any command.
  stop(reason = 'Stall session stopped.', quiet = false) {
    const r = this.run; this.run = null; this.pending = null;
    this.message = reason;
    if (!r) return;
    if (r.phase === 'done') return;
    Activity.emit({ category: 'stall', code: 'stall-stopped', level: 'warn', text: reason, outcome: 'cancelled' });
    if (quiet) return;
    const phase = World.gp?.stall?.phase;
    if (phase === 'naming') Cmd.raw({ kind: 'stall-name-cancel' }, 'Stall: cancel naming');
    else if (phase === 'owner' && World.inWorld()) Cmd.raw({ kind: 'stall-close' }, 'Stall: close our stall');
  },
  finish(text, code = 'stall-closed') {
    const r = this.run; this.run = null; this.pending = null;
    this.message = text;
    Activity.emit({ category: 'stall', code, text, outcome: 'summary', details: { sold: r.sold, earned: String(r.earned) } });
  },
  fail(text) { Log.warn('Stall: ' + text); this.stop(text); },
  // The next free stall slot, 1-based; the server keeps its own limit and refuses beyond it.
  freeSlot() {
    const used = new Set(this.offers().map(o => o.slot));
    for (let slot = 1; slot <= STALL_MAX_OFFERS; slot++) if (!used.has(slot)) return slot;
    return 0;
  },
  // A confirmed step observes its state change; on timeout the step is skipped (an offer) or fails the session,
  // and no command is ever resent.
  confirmPending(gp) {
    const p = this.pending;
    if (!p) return true;
    if (now() - p.at > STALL_STEP_TIMEOUT_MS) {
      this.pending = null;
      if (p.kind === 'add') {
        this.run.skip.add(p.bagSlot); this.run.refusals++;
        this.message = 'Stall: one item was not registered; skipping it.';
        return false;
      }
      this.fail('Stall: ' + p.kind + ' was not confirmed after 15 s. No repeat command sent.');
      return false;
    }
    if (gp.inventoryPending || now() - p.at < 500) return false;
    const stall = gp.stall;
    if (p.kind === 'name') { if (stall?.phase === 'naming') { this.pending = null; return true; } return false; }
    if (p.kind === 'create') {
      if (stall?.phase === 'owner' && stall.owner === gp.localGid) { this.pending = null; return true; }
      return false;
    }
    if (p.kind === 'add') {
      if ((stall?.offers || []).some(o => o.bagSlot === p.bagSlot && o.slot === p.slot)) {
        this.pending = null; this.run.refusals = 0;
        Activity.emit({ category: 'stall', code: 'stall-offer', text: 'Stall: ' + p.name + ' registered at ' + p.price.toLocaleString('en-US') + ' gold.', outcome: 'confirmed', details: { refObjId: p.ref, quantity: p.quantity, price: p.price } });
        return true;
      }
      return false;
    }
    if (p.kind === 'open') { if (stall?.open) { this.pending = null; return true; } return false; }
    if (p.kind === 'close') { if (!stall) { this.pending = null; return true; } return false; }
    return false;
  },
  send(kind, command, label, extra = {}) {
    if (!Cmd.spaced(command.kind) || !Cmd.raw(command, 'Stall: ' + label)) return false;
    this.pending = { kind, at: now(), ...extra };
    return true;
  },
  // A sale: an offer disappears while gold rises. Nothing else moves gold while the session owns the character,
  // so an offer vanishing without a gold gain is not claimed as a sale.
  observeSales(r, gp) {
    const stall = gp.stall;
    if (!stall || stall.phase !== 'owner') return;
    const gold = toBigInt(gp.progression?.gold);
    if (r.offersAt === null) { r.offersAt = stall.offers.map(o => ({ ...o })); r.lastGold = gold; return; }
    const before = r.offersAt, after = stall.offers;
    for (const old of before) {
      const kept = after.find(o => o.slot === old.slot);
      const quantity = old.quantity - (kept ? Math.min(kept.quantity, old.quantity) : 0);
      if (quantity <= 0 || gold <= r.lastGold) continue;
      const value = BigInt(old.price) * BigInt(quantity);
      r.sold += quantity; r.earned += value;
      r.saleNoteAt = now();
      this.message = 'Sold ' + quantity + ' × ' + (old.item?.name || Items.name(old.item?.refObjId) || 'item') + ' for ' + value.toLocaleString('en-US') + ' gold.';
      Activity.emit({ category: 'stall', code: 'stall-sale', text: this.message, outcome: 'confirmed',
        details: { refObjId: old.item?.refObjId, quantity, price: old.price, slot: old.slot } });
    }
    r.offersAt = after.map(o => ({ ...o }));
    r.lastGold = gold;
  },
  watchSelling(r, gp) {
    this.observeSales(r, gp);
    const stall = gp.stall;
    if (!stall || stall.phase !== 'owner') return this.finish('The stall closed. Sold ' + r.sold + ' item' + (r.sold === 1 ? '' : 's') + ' for ' + r.earned.toLocaleString('en-US') + ' gold.');
    if (r.phase !== 'selling') return;
    const offers = stall.offers || [];
    // A sale line stays up briefly instead of being stamped over by the rolling status.
    if (!r.saleNoteAt || now() - r.saleNoteAt > 5000)
      this.message = 'Stall open: ' + offers.length + ' offer' + (offers.length === 1 ? '' : 's') + ' left' +
        (stall.visitors?.length ? ', ' + stall.visitors.length + ' browsing' : '') +
        (r.sold ? '; sold ' + r.sold + ' for ' + r.earned.toLocaleString('en-US') + ' gold.' : '.');
    if (!offers.length && this.cfg().closeWhenEmpty) {
      r.phase = 'close';
      if (!r.saleNoteAt || now() - r.saleNoteAt > 5000) this.message = 'Everything sold; closing the stall.';
    }
  },
  tick() {
    const r = this.run, gp = World.gp;
    if (!r) return false;
    if (!World.inWorld()) { this.stop('Stall stopped: left the game world.'); return true; }
    if (!this.confirmPending(gp)) { if (this.run && ['selling', 'close'].includes(this.run.phase)) this.watchSelling(this.run, gp); return true; }
    if (!this.run) return true; // the confirmation itself may have ended the session
    const blocked = this.blocked(true);
    if (blocked || r.character !== World.charName || r.manualAt !== Manual.lastAt || r.config !== JSON.stringify(this.cfg()))
      return this.fail(blocked || 'Stall stopped: settings, character or manual control changed.'), true;
    if (World.isDead()) return this.fail('Stall stopped: character died.'), true;
    const stall = gp.stall;
    if (stall?.phase === 'visitor') return this.fail('Stall stopped: browsing another stall.'), true;
    if (r.phase === 'name') {
      this.message = 'Stall: naming the stall.';
      if (!stall || stall.phase === 'none') this.send('name', { kind: 'stall-name' }, 'begin naming');
      else if (stall.phase === 'naming') r.phase = 'create';
      return true;
    }
    if (r.phase === 'create') {
      this.message = 'Stall: opening the stall.';
      if (stall?.phase === 'owner' && stall.owner === gp.localGid) {
        r.phase = 'add';
        Activity.emit({ category: 'stall', code: 'stall-created', text: 'Stall created: ' + (stall.title || 'unnamed') + '.', outcome: 'confirmed' });
      }
      else if (stall?.phase === 'naming') this.send('create', { kind: 'stall-create', title: this.cfg().title || World.charName || 'Stall', greeting: this.cfg().greeting || '' }, 'create the stall');
      else r.phase = 'name'; // the naming phase was lost; start over
      return true;
    }
    if (r.phase === 'add') {
      if (r.refusals >= 2) { r.phase = 'open'; return true; }
      const item = this.nextCandidate(r), slot = this.freeSlot();
      if (!item || !slot) { r.phase = 'open'; return true; }
      const price = this.price(item.refObjId), quantity = Math.max(1, item.quantity || 1), name = item.name || Items.name(item.refObjId);
      this.message = 'Stall: registering ' + name + '.';
      this.send('add', { kind: 'stall-add', slot, bagSlot: item.slot, quantity, price }, 'offer ' + name,
        { slot, bagSlot: item.slot, quantity, price, ref: item.refObjId, name });
      return true;
    }
    if (r.phase === 'open') {
      if (stall?.open) {
        r.phase = 'selling'; r.openedAt = now(); r.offersAt = null;
        Activity.emit({ category: 'stall', code: 'stall-opened', text: 'Stall open for business with ' + (stall.offers?.length || 0) + ' offer' + ((stall.offers?.length || 0) === 1 ? '' : 's') + '.', outcome: 'confirmed' });
        return true;
      }
      if (!this.offers().length) return this.fail('Stall: nothing could be registered.');
      this.message = 'Stall: opening for business.';
      this.send('open', { kind: 'stall-open', open: true, network: !!this.cfg().network }, 'open for business');
      return true;
    }
    if (r.phase === 'selling') { this.watchSelling(r, gp); return true; }
    if (r.phase === 'close') {
      if (!stall) return this.finish('Stall closed. Sold ' + r.sold + ' item' + (r.sold === 1 ? '' : 's') + ' for ' + r.earned.toLocaleString('en-US') + ' gold.'), true;
      this.message = 'Stall: closing.';
      this.send('close', { kind: 'stall-close' }, 'close the stall');
      return true;
    }
    return true;
  },
  nextCandidate(r) {
    for (const item of this.candidates(r)) {
      if (this.offers().some(o => o.bagSlot === item.slot)) continue;
      return item;
    }
    return null;
  },
  init() {
    if (this.started) return; this.started = true;
    // Any manual native gameplay command can interfere with the stall; our own Cmd.raw bypasses these observers.
    Hook.observers.push(command => { if (command.kind === 'gameplay' && this.run) this.stop('Stall stopped by manual game control.'); });
    bus.on('game-error', text => { if (this.run && /stall|inventory/i.test(String(text))) this.stop('Stall stopped after a game refusal; wait for the state to settle.'); });
    // A world reset clears the stall server-side too; drop the session without sending anything.
    bus.on('reset', () => this.stop('Stall stopped after world reset.', true));
  },
  status() {
    const r = this.run, stall = this.stall();
    if (r) return this.message;
    if (stall?.phase === 'owner') return 'A stall of yours is open in the game; the bot is not managing it.';
    if (stall?.phase === 'visitor') return 'You are browsing another player\'s stall.';
    if (stall?.phase === 'naming') return 'A stall is being named in the game.';
    return this.message;
  },
  draw() {
    const c = () => this.cfg();
    const setup = UI.group('Stall',
      UI.text('Stall name', () => c().title, v => c().title = v, 'defaults to your character name'),
      UI.text('Greeting', () => c().greeting, v => c().greeting = v, 'shown to visitors'),
      UI.check('List the stall on the stall network', () => c().network, v => c().network = v),
      UI.check('Close when everything is sold', () => c().closeWhenEmpty, v => c().closeWhenEmpty = v),
      UI.row(UI.button('Open stall', () => this.start()), UI.button('Stop stall', () => this.stop())),
      el('p', 'Opens your street stall where you stand and offers every priced bag item from this page. Works in town only, while hunting, travel and alchemy are stopped: the stall keeps the character in place. Each offer sells the whole stack at your price. Sold items are confirmed by the offer disappearing and gold arriving; a step the game does not confirm is skipped, never resent. Stop (or F8) closes a stall this page opened.', 'muted'));
    UI.stallNote = el('p', this.status(), 'muted'); setup.append(UI.stallNote);
    UI.pane.append(setup);
    const prices = UI.group('Items and prices');
    const entries = Object.entries(c().prices);
    if (!entries.length) prices.append(el('div', 'No prices set. Add items from your bag below.', 'empty'));
    for (const [id, price] of entries) {
      const item = Number(id), name = Items.name(item) || ('#' + item);
      const inBag = World.items().filter(i => i.refObjId === item).reduce((n, i) => n + (i.quantity ?? 1), 0);
      const remove = UI.button('×', () => { this.setPrice(item, 0); UI.draw(); });
      remove.className = 'mini'; remove.setAttribute('aria-label', 'Stop selling ' + name);
      prices.append(UI.row(
        el('span', name + (inBag ? ' · ' + inBag + ' in bag' : ' · not in bag'), 'item-name'),
        UI.number(name + ' price (gold)', () => price, v => this.setPrice(item, v), 1, 4294967295),
        remove));
    }
    const unnamed = [...new Map(World.items().filter(i => this.price(i.refObjId) === 0 && i.tooltip?.fields?.canSell !== 0).map(i => [i.refObjId, i])).values()];
    if (unnamed.length) prices.append(UI.select('Add a bag item to sell', () => [[0, 'Choose an item'], ...unnamed.map(i => [i.refObjId, (i.name || Items.name(i.refObjId)) + ' ×' + (i.quantity ?? 1)])],
      () => 0, v => { const id = Number(v); if (id) { this.setPrice(id, 100); UI.draw(); } }));
    prices.append(el('p', 'Prices are per exact item and saved with this character, so the same drop sells at the same price on the next stall. A new entry starts at 100 gold; change it to what the item is worth. Items the merchant cannot sell are not offered. Items already in a stall you keep open in the game are left alone.', 'muted'));
    UI.pane.append(prices);
  },
  refresh() {
    if (!UI.is('Stall') || !UI.stallNote) return;
    UI.stallNote.textContent = this.status();
  },
};
