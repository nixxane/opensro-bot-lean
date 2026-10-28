const AUTO_START_SETTLE_MS = 5000;
const AUTO_START_NAV_MS = 20000;
const AUTO_START_GIVE_UP_MS = 120000;
const AutoStart = {
  armed: true, entry: null, message: '',
  on() { return !!Settings.profile.hunt.autoStart; },
  pending() { return !!this.entry && this.on(); },
  status() {
    if (!this.on()) return 'Off.';
    return this.message || 'Waits for the next time this character enters the game.';
  },
  cancel(reason = '') {
    if (!this.entry) return;
    this.entry = null;
    if (reason) { this.message = reason; Log.info(reason); }
  },
  waiting(entry) {
    const gp = World.gp;
    if (!World.local() || !Array.isArray(gp?.inventory) || gp.inventoryPending) return 'waiting for the character to load.';
    const left = AUTO_START_SETTLE_MS - (now() - entry.at);
    if (left > 0) return 'starting in ' + Math.ceil(left / 1000) + ' s.';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'waiting for the manual-control pause.';
    const pose = World.pose();
    if (!Navigation.scene && pose && !(pose.regionId & DUNGEON) && now() - entry.at < AUTO_START_NAV_MS) return 'waiting for collision data.';
    return '';
  },
  tick() {
    if (!World.inWorld()) return;
    if (this.armed) { this.armed = false; this.entry = { at: now() }; }
    const entry = this.entry;
    if (!entry) return;
    if (Reconnect.active()) return this.cancel('Auto-start skipped: reconnect is bringing the bot back.');
    if (Hunt.running || Town.trip || WalkBack.active || Trade.run || Alchemy.run || Alchemy.pending || Restock.recording) return this.cancel();
    if (now() - entry.at > AUTO_START_GIVE_UP_MS) return this.cancel('Auto-start gave up: the game did not settle within 2 minutes.');
    if (World.charName && Settings.profileKey !== 'profile:' + World.charName) { this.message = 'Auto-start: waiting for the character settings.'; return; }
    if (!this.on()) { this.entry = null; return; }
    if (!Hunt.cfg().center) {
      this.cancel('Auto-start: no hunting spot is saved. Set one in Combat → Hunt area (Training place in the Classic window).');
      return UI.toast(this.message, 'warn', 6000);
    }
    const wait = this.waiting(entry);
    if (wait) {
      this.message = 'Auto-start: ' + wait;
      return;
    }
    this.entry = null;
    if (World.isDead()) {
      if (!Town.autoRevive() && Hunt.cfg().onDeath === 'stop') {
        this.message = 'Auto-start: the character is dead and On death is set to Stop, so the bot was not started.';
        Log.info(this.message); UI.toast(this.message, 'warn', 6000);
        return;
      }
      Hunt.start();
      this.message = Hunt.running ? 'Auto-start: started. The character is dead, so it revives and returns first.' : 'Auto-start: the bot could not start.';
      Log.info(this.message);
      return;
    }
    Controller.resumeHunting('Auto-start');
    this.message = Town.trip ? 'Auto-start: in town. Doing town services, then back to the hunting spot.'
      : WalkBack.active ? 'Auto-start: walking to the hunting spot.'
      : Hunt.running ? 'Auto-start: hunting started at the hunting spot.'
      : 'Auto-start: the bot could not start. ' + (Town.message.startsWith('Town cycle stopped:') ? Town.message : 'Check the log.');
    Log.info(this.message);
  },
};
bus.on('phase', (phase, previous, left) => { if (left) { AutoStart.armed = true; AutoStart.entry = null; } });
