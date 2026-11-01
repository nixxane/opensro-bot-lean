// Anti-stuck watchdog. While hunting it watches for confirmed progress (kills, XP, gold,
// pickups, damage dealt to the target). Without progress it first drops the current target,
// then walks back to the saved hunting spot, and finally stops instead of idling forever.
const AntiStuck = {
  idleMs: 0, lastAt: null, signature: '', damage: '', recoveries: 0, recoveringUntil: 0, message: '',
  cfg() { return Settings.profile.hunt.antiStuck; },
  // These states are working normally or deliberately waiting; they do not count as stuck.
  counts: new Set(['search', 'return', 'select', 'fight']),
  reset() { this.idleMs = 0; this.lastAt = null; this.signature = ''; this.damage = ''; this.recoveries = 0; this.recoveringUntil = 0; },
  sign() {
    const s = Stats.session;
    return [s.kills, s.xp, s.gold, s.items].join('|');
  },
  tick() {
    const c = this.cfg();
    if (!c.enabled || !Hunt.running || !World.inWorld()) { this.lastAt = null; return; }
    // Following a party member: waiting for them is not being stuck, and recovery would walk away from them.
    if (Trace.active()) { this.idleMs = 0; this.lastAt = now(); return; }
    const t = now(), gap = this.lastAt === null ? 0 : t - this.lastAt;
    this.lastAt = t;
    // A gap means Hunt.tick did not run (town trip, shopping, walk-back): start counting afresh.
    const signature = this.sign(), damage = Hunt.targetGid ? String(World.hpOf(Hunt.targetGid)) : '';
    if (gap > 1500) { this.idleMs = 0; this.signature = signature; this.damage = damage; return; }
    // Hurting the current target keeps the timer fresh; only confirmed gains clear earlier recoveries.
    if (damage && damage !== this.damage && this.damage) this.idleMs = 0;
    this.damage = damage;
    if (signature !== this.signature) {
      this.signature = signature; this.idleMs = 0; this.recoveries = 0;
      return;
    }
    if (!this.counts.has(Hunt.state)) return;
    this.idleMs += gap;
    if (this.idleMs >= c.minutes * 60000) this.recover();
  },
  recover() {
    const c = this.cfg(), H = Hunt.cfg();
    this.idleMs = 0; this.recoveries++;
    if (this.recoveries > c.maxRecoveries) {
      this.message = 'No progress after ' + c.maxRecoveries + ' recoveries.';
      // Optional last resort: a town trip, as the trap recovery does. It ends in town, because reversing would
      // return to the spot where nothing worked.
      if (c.recall && Town.cfg().enabled) {
        Log.warn(this.message + ' Going to town.');
        Town.begin();
        if (Town.trip) { Town.trip.recovery = true; this.message += ' Went to town.'; return; }
      }
      return Hunt.stop('stuck: no progress after ' + c.maxRecoveries + ' recoveries');
    }
    if (Hunt.targetGid) Hunt.ban.set(Hunt.targetGid, now() + 60000);
    Hunt.targetGid = 0; Hunt.selTries = 0; Loot.suspend();
    Log.warn('Anti-stuck recovery ' + this.recoveries + '/' + c.maxRecoveries + ' after ' + c.minutes + ' min without progress.');
    if (this.recoveries >= 2 && H.center) {
      // WalkBack stops and later restarts hunting; this window keeps the recovery count across both events.
      this.recoveringUntil = now() + 660000;
      WalkBack.start(true);
      if (!WalkBack.active) this.recoveringUntil = 0;
      this.message = 'Recovery ' + this.recoveries + ': walking back to the hunting spot.';
      UI.toast('Stuck: walking back to the hunting spot.', 'warn', 3500);
    } else {
      Cmd.move(World.pose());
      this.message = 'Recovery ' + this.recoveries + ': dropped the current target.';
      UI.toast('Stuck: dropped the current target.', 'warn', 3500);
    }
  },
  status() {
    const c = this.cfg();
    if (!c.enabled) return 'Anti-stuck is off.';
    return (this.message || 'Watching for progress.') + (Hunt.running ? ' No progress for ' + Math.floor(this.idleMs / 1000) + ' s.' : '');
  },
};
const huntTickBeforeAntiStuck = Hunt.tick;
Hunt.tick = function () {
  huntTickBeforeAntiStuck.apply(this, arguments);
  AntiStuck.tick();
};
bus.on('hunt', running => {
  if (now() < AntiStuck.recoveringUntil) { if (running) AntiStuck.recoveringUntil = 0; AntiStuck.lastAt = null; return; }
  AntiStuck.reset();
  if (!running) AntiStuck.message = '';
});
