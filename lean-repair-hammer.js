// Repair hammer: one use repairs all the equipment the character wears. Wear is Town.wear(): the most worn
// repairable equipped item against its own maximum. Success needs that wear to improve, not the dispatch.
const RepairHammer = {
  pending: null, attempts: 0, nextAt: 0, message: 'Repair hammer off.',
  reset() { this.pending = null; this.attempts = 0; this.nextAt = 0; this.message = 'Waiting for automation.'; },
  cfg() { return Settings.profile.potion.repairHammer; },
  // Known by its codename, or by its name when the catalogue is not loaded yet.
  hammer() {
    if (!Items.filesLoaded && !Items.filesMissing) Items.ready().catch(() => {});
    return World.items().find(i => (i.quantity ?? 1) > 0 &&
      (/REPAIR_HAMMER/i.test(i.codename || Items.data.get(i.refObjId)?.code || '') || /repair hammer/i.test(i.name || Items.data.get(i.refObjId)?.name || '')));
  },
  tick() {
    const c = this.cfg();
    if (Town.trip) { this.message = 'Waiting for town services to finish.'; return false; }
    if (!c.on) { this.message = 'Repair hammer off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character in the world.'; return false; }
    const worn = Town.wear();
    if (this.pending && (!worn || worn.pct > this.pending.pct)) {
      this.pending = null; this.attempts = 0; this.nextAt = 0;
      Log.info('Repair hammer used: equipment repaired.');
    }
    if (!worn || worn.pct >= c.pct) { this.message = worn ? `Gear durability fine (lowest ${Math.floor(worn.pct)}%).` : 'No worn repairable gear.'; return false; }
    if (!(Hunt.running || WalkBack.active)) { this.message = 'Waiting for hunting.'; return false; }
    const blocked = World.gp.inventoryPending ? 'Waiting for the inventory transaction to finish.' :
      World.gp.returnScroll ? 'Waiting for return-scroll travel.' :
      Resurrect.holdUntil > now() ? 'Waiting for the resurrection cast to finish.' :
      World.isSitting() ? 'Waiting for the character to stand.' :
      World.local()?.mountedOn ? 'Waiting for the character to dismount.' :
      Restock.activeShop() || World.gp.storage ? 'Waiting for the shop or storage to close.' :
      Restock.recording ? 'Waiting for route recording to finish.' :
      now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000 ? 'Waiting for the manual-control pause.' : '';
    if (blocked) { this.message = blocked; return false; }
    if (this.pending) {
      if (now() - this.pending.at < 8000) { this.message = 'Waiting for the repair to show on the gear.'; return false; }
      this.pending = null; this.nextAt = now() + 30000 * this.attempts;
      this.message = 'Repair was not confirmed. Backing off before retrying.';
      Log.warn(this.message);
    }
    if (this.attempts >= 3) { this.message = 'Repair not confirmed after 3 attempts. Check the game and toggle this option to retry.'; return false; }
    if (now() < this.nextAt) return false;
    const item = this.hammer();
    if (!item) { this.message = `${worn.name} at ${Math.floor(worn.pct)}%, but no repair hammer in your bag.`; return false; }
    if (!Cmd.itemUse(item.slot)) { this.message = 'Waiting for item-use availability (potions have priority).'; return false; }
    this.attempts++; this.pending = { at: now(), pct: worn.pct };
    this.message = `${worn.name} at ${Math.floor(worn.pct)}%: repair hammer used, waiting for the repair.`;
    return true;
  },
};
