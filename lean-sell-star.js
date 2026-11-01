// Sell Star from storage: one click takes every Seal of Star piece out of the warehouse and sells it at the saved
// repair merchant, in batches that fit the bag. Not a setting and never automatic: it only runs when the player
// presses the button, and walks to each NPC itself. Uses the Town page's saved warehouse and repair merchant.
// phases: walk-storage -> open-storage -> withdraw -> close-storage -> walk-smith -> open-shop -> sell -> close-shop -> (walk-storage again | done)
// Every step waits for the state it expects (the item in the bag, the item gone from the bag); a dispatch is
// never proof and nothing is resent, so a command the game never answered cannot sell twice.
const SELL_STAR_STEP_MS = 10000;
const SELL_STAR_ITEM_MS = 8000;
const SELL_STAR_KEEP_SLOTS = 2;
const SellStar = {
  run: null, message: 'Idle.',
  // Star equipment the merchant would take. Buff-set gear and Keep names stay, as everywhere else in the bot.
  isStar(item) {
    const tf = item.typeFlags, keep = splitList(Town.cfg().keep), name = (item.name || '').toLowerCase();
    return ItemType.isEquipment(tf) && Items.soxOf(item) === 1 && item.tooltip?.fields?.canSell !== 0 &&
      !ItemRules.guarded(item) && !keep.some(s => name.includes(s));
  },
  inStorage() { const st = World.gp?.storage; return st && st.phase === 'open' && !st.guild ? st.items.filter(i => this.isStar(i)) : []; },
  bag(slot, ref) { return World.items().find(i => i.slot === slot && i.refObjId === ref); },
  blocked() {
    const gp = World.gp, c = Town.cfg();
    if (!World.inWorld() || !gp || !World.local()) return 'Enter the game world first.';
    if (World.isDead()) return 'Character is dead.';
    if (!c.storage || !c.smith) return 'Save the warehouse and the repair merchant first (Town page).';
    if (Alchemy.run || Alchemy.pending || Stall.run || Trade.run || BuffGear.run || BuffGear.recovery) return 'Stop alchemy, stall, trade and gear swaps first.';
    if (Hunt.running || Town.trip || WalkBack.active || Travel.active || Restock.trip || Restock.recording || Resurrect.trip || Quest.trip || Loot.active) return 'Stop hunting, travel and route recording first.';
    if (Restock.activeShop() || gp.storage || gp.exchange?.open || gp.exchange?.requesting || gp.stall?.phase && gp.stall.phase !== 'none') return 'Close shop, storage, trade and stall first.';
    if (World.isCasting() || World.isSitting() || gp.pendingMoves) return 'Stand still and wait for casts and movement to finish.';
    return '';
  },
  start() {
    if (this.run) return;
    const error = this.blocked();
    if (error) { this.message = error; UI.toast(error, 'warn'); return; }
    if (World.gp.inventoryPending) { this.message = 'Wait for settled inventory state.'; UI.toast(this.message, 'warn'); return; }
    this.run = { phase: 'walk-storage', at: now(), sent: false, pending: null, mine: [], sold: 0, round: 0, refused: new Set(), more: false, rev: null };
    this.message = 'Selling Star gear from the warehouse.';
    Log.info('Sell Star: started.');
  },
  stop(text = 'Sell Star stopped.') {
    const r = this.run; this.run = null;
    if (!r) return;
    this.message = text;
    Log.warn(text); UI.toast(text, 'warn', 8000);
    if (World.inWorld() && (World.gp.storage || Restock.activeShop())) Cmd.raw({ kind: 'npc-close' }, 'Sell Star: close NPC');
  },
  enter(phase) {
    const r = this.run;
    r.phase = phase; r.at = now(); r.sent = false; r.pending = null;
    r.travel = null; r.lastPose = null; r.progressAt = now(); r.movedAt = -Infinity; r.retryAt = 0; r.stall = null; r.avoid = [];
  },
  // Walks to the saved standing point of a service, as the town cycle does; true once in service range.
  walk(role) {
    const r = this.run, dest = Town.cfg()[role], pose = World.pose(), what = Town.role('walk-' + role);
    const radius = Math.max(0, Math.min(60, 190 - dist2D(dest, dest.npc || dest)));
    if (dist2D(pose, dest) <= Math.max(12, radius) && dist2D(pose, dest.npc || dest) <= 200) return true;
    if (!Number.isFinite(dist2D(pose, dest))) { this.stop('Sell Star stopped: the ' + what + ' is in another world.'); return false; }
    if (!r.lastPose || dist2D(r.lastPose, pose) > 3) { r.lastPose = { ...pose }; r.progressAt = now(); }
    if (now() < r.retryAt) return false;
    if (now() - r.progressAt > 20000) { this.stop('Sell Star stopped: no way through to the ' + what + ' (no progress for 20 s).'); return false; }
    if (!World.isSitting() && Navigation.watch(r, pose, r.movedAt, r.travel?.route[r.travel.index] || dest) === 'giveup') { this.stop('Sell Star stopped: blocked on the way to the ' + what + '.'); return false; }
    const step = Navigation.next(r, dest, false, radius);
    if (step.waiting || step.error) { r.travel = null; r.retryAt = now() + 3000; this.message = 'Walking to the ' + what + ': waiting for a route.'; return false; }
    this.message = 'Walking to the ' + what + '.';
    if (!step.point || now() - r.movedAt < 1000 || World.gp.inventoryPending) return false;
    if (World.isSitting()) { if (Cmd.action(1000)) r.movedAt = now(); }
    else if (Cmd.move(step.point)) r.movedAt = now();
    return false;
  },
  // Selects the saved NPC and opens its window; true once the window shows.
  open(role, kind) {
    const r = this.run, gp = World.gp, npc = Town.npc(role);
    if (!npc) { this.stop('Cannot see the ' + Town.role('open-' + role) + '. Stand next to it.'); return false; }
    if (gp.targetPending || gp.inventoryPending) return false;
    if (gp.target !== npc.gid) {
      if (r.sent) { this.stop('Sell Star stopped: the NPC selection changed.'); return false; }
      if (Cmd.spaced('select')) Cmd.select(npc.gid);
      return false;
    }
    if (!(gp.targetCapabilities & (role === 'storage' ? 4 : 8))) { this.stop('The saved ' + Town.role('open-' + role) + ' does not offer that service.'); return false; }
    if (!r.sent) {
      r.rev = gp.shopCompletionRevision;
      if (Cmd.raw({ kind, gid: npc.gid }, 'Sell Star: open ' + Town.role('open-' + role))) r.sent = true;
      return false;
    }
    return role === 'storage' ? gp.storage?.phase === 'open' && !gp.storage.guild && gp.storage.npc === npc.gid
      : gp.shop?.npc === npc.gid && gp.shopCompletionRevision !== r.rev;
  },
  close(next) {
    const r = this.run, gp = World.gp;
    if (gp.inventoryPending) return;
    if (!r.sent) { if (Cmd.raw({ kind: 'npc-close' }, 'Sell Star: close NPC')) r.sent = true; return; }
    if (!gp.target && !gp.storage && !Restock.activeShop()) this.enter(next);
  },
  tick() {
    const r = this.run;
    if (!r) return false;
    const gp = World.gp;
    if (!World.inWorld() || !gp || World.isDead()) { this.stop('Sell Star stopped: left the world or died. Withdrawn gear stays in your bag.'); return true; }
    if (r.phase !== 'sell' && r.phase !== 'withdraw' && !r.phase.startsWith('walk-') && now() - r.at > SELL_STAR_STEP_MS) { this.stop('Sell Star timed out in "' + r.phase + '". Gear already withdrawn stays in your bag.'); return true; }
    switch (r.phase) {
      case 'walk-storage':
        if (this.walk('storage')) this.enter('open-storage');
        break;
      case 'open-storage':
        if (this.open('storage', 'storage-open')) { r.round++; this.enter('withdraw'); }
        break;
      case 'withdraw': {
        const st = gp.storage;
        if (!st || st.phase !== 'open' || st.guild) { this.stop('Sell Star stopped: the warehouse closed. Gear already withdrawn stays in your bag.'); break; }
        const p = r.pending;
        if (p) {
          if (gp.inventoryPending && now() - p.at < SELL_STAR_ITEM_MS) break;
          if (!this.bag(p.dest, p.ref)) { this.stop('Sell Star stopped: a withdrawal did not reach the bag.'); break; }
          r.mine.push({ slot: p.dest, ref: p.ref }); r.pending = null; r.at = now();
        }
        if (gp.inventoryPending) break;
        const item = this.inStorage()[0];
        if (!item || World.freeBagSlots() <= SELL_STAR_KEEP_SLOTS) { r.more = !!item; this.enter('close-storage'); break; }
        const dest = Town.free(gp.inventory, gp.equipmentSlotCount || 13, gp.inventorySlotCount);
        if (dest === null) { r.more = true; this.enter('close-storage'); break; }
        if (Cmd.raw({ kind: 'storage-move', move: { type: 3, source: item.slot, destination: dest, quantity: 0, gold: 0 } }, 'Sell Star: withdraw ' + (item.name || item.refObjId)))
          r.pending = { dest, ref: item.refObjId, at: now() };
        break;
      }
      case 'close-storage': this.close(r.mine.length ? 'walk-smith' : 'done'); break;
      case 'walk-smith':
        if (this.walk('smith')) this.enter('open-shop');
        break;
      case 'open-shop':
        if (this.open('smith', 'shop-open')) this.enter('sell');
        break;
      case 'sell': {
        const shop = gp.shop;
        if (!shop || shop.npc !== Town.npc('smith')?.gid || shop.error) { this.stop('Sell Star stopped: the merchant window closed. Unsold gear stays in your bag.'); break; }
        const p = r.pending;
        if (p) {
          if (!this.bag(p.slot, p.ref)) { r.sold++; r.mine = r.mine.filter(m => !(m.slot === p.slot && m.ref === p.ref)); r.pending = null; }
          else if (gp.inventoryPending || now() - p.at < 1500) break;
          else if (now() - p.at > SELL_STAR_ITEM_MS) { r.refused.add(p.slot + ':' + p.ref); r.mine = r.mine.filter(m => !(m.slot === p.slot && m.ref === p.ref)); r.pending = null; }
          else break;
        }
        if (gp.inventoryPending) break;
        const next = r.mine.map(m => this.bag(m.slot, m.ref)).find(Boolean);
        if (!next) { this.enter('close-shop'); break; }
        if (Cmd.raw({ kind: 'shop-sell', slot: next.slot, quantity: next.quantity ?? 1 }, 'Sell Star: sell ' + (next.name || next.refObjId)))
          r.pending = { slot: next.slot, ref: next.refObjId, at: now() };
        break;
      }
      case 'close-shop': this.close(r.more && r.round < 50 && !r.refused.size ? 'walk-storage' : 'done'); break;
      case 'done': {
        const left = r.refused.size, text = 'Sold ' + r.sold + ' Star item' + (r.sold === 1 ? '' : 's') + ' from the warehouse' +
          (left ? '; the merchant refused ' + left + ', which stayed in your bag.' : '.');
        this.run = null; this.message = text; Log.info('Sell Star: ' + text); UI.toast(text);
        break;
      }
    }
    return true;
  },
};
