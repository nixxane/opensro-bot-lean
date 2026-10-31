// Keep the Item Mall's 20% battle scrolls active while the bot works: item 3767 -> skill 3109 (damage increase),
// item 3768 -> skill 3110 (damage resistance) — both 30 minutes. Only bag stock is used here; buying more is the
// Item Mall buyer's business. Like the speed scroll: never infer consumption from a local dispatch, one request at
// a time, and the same blocked-while-travelling guards.
const ScrollBuff = {
  pending: null, attempts: 0, nextAt: 0, message: 'Battle scrolls off.',
  kinds: {
    damageInc: { item: 3767, skill: 3109, label: '20% damage increase' },
    damageAbs: { item: 3768, skill: 3110, label: '20% damage resistance' },
  },
  reset() { this.pending = null; this.attempts = 0; this.nextAt = 0; this.message = 'Waiting for automation.'; },
  active(k) { return World.buffRemaining(this.kinds[k].skill) > 0; },
  enabled() { const c = Settings.profile.scroll; return Object.keys(this.kinds).filter(k => c[k]); },
  tick() {
    const wanted = this.enabled();
    if (!wanted.length) { this.message = 'Battle scrolls off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character in the world.'; return false; }
    if (!Hunt.running) { this.message = 'Start the bot to keep the scrolls active.'; return false; }
    const missing = wanted.filter(k => !this.active(k));
    if (!missing.length) { this.pending = null; this.attempts = 0; this.message = 'Battle scrolls active.'; return false; }
    if (Town.trip) { this.message = 'Waiting for town services to finish.'; return false; }
    const blocked = World.gp.inventoryPending ? 'Waiting for the inventory transaction to finish.' :
      World.gp.returnScroll ? 'Waiting for return-scroll travel.' :
      World.isSitting() ? 'Waiting for the character to stand.' :
      World.local()?.mountedOn ? 'Waiting for the character to dismount.' :
      Restock.activeShop() || World.gp.storage ? 'Waiting for the shop or storage to close.' :
      now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ? 'Waiting for the manual-control pause.' : '';
    if (blocked) { this.message = blocked; return false; }
    if (this.pending) {
      // Only the kind that was sent owns this window: another scroll may still be missing.
      if (this.active(this.pending.kind)) { this.pending = null; this.attempts = 0; }
      else if (now() - this.pending.at < 8000) { this.message = 'Waiting for the scroll buff.'; return false; }
      else {
        this.pending = null; this.nextAt = now() + 30000 * this.attempts;
        this.message = 'The scroll buff was not confirmed. Backing off before retrying.';
        Log.warn(this.message);
      }
    }
    if (this.attempts >= 3) { this.message = 'Battle scroll not confirmed after 3 attempts. Check the game and toggle the option to retry.'; return false; }
    if (now() < this.nextAt) return false;
    for (const k of missing) {
      const def = this.kinds[k];
      const item = World.items().find(i => i.refObjId === def.item && (i.quantity ?? 1) > 0);
      if (!item) { this.message = 'No ' + def.label + ' scroll in your bag.'; continue; }
      if (!Cmd.itemUse(item.slot)) { this.message = 'Waiting for item-use availability (potions have priority).'; return false; }
      this.attempts++; this.pending = { kind: k, at: now() };
      this.message = def.label + ' scroll requested; waiting for its buff.';
      return true;
    }
    return false;
  },
};
