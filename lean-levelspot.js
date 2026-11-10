// Hunting spot by level. The profile keeps a list of spots, each used from a character level on; the highest one at or
// below the character's level is the hunting spot. When the level crosses into a new spot, the hunting spot switches
// and the bot walks there. Off by default; it only acts while the bot is hunting and nothing else owns the character.
const LevelSpot = {
  nextAt: 0, message: '', retry: false,
  // Session state: a no-XP move can put hunting on a spot above the character's level gate; the level rule alone
  // must not pull it back while the character is still below that gate. Kept per character, never saved.
  heldLevel: 0, heldFor: '',
  cfg() { return Settings.profile.hunt.levelSpots; },
  list() { return (this.cfg().list || []).filter(s => Number.isInteger(s?.level) && s.center).sort((a, b) => a.level - b.level); },
  // The spot that applies at this level, or null below the lowest one.
  // Zero-setup leveling replaces the saved list with spots picked from the game data (lean-leveling.js).
  spotFor(level) { return Leveling.spotsOn() ? Leveling.spot(level) : this.list().filter(s => s.level <= level).pop() || null; },
  // The hold ends the moment the character reaches the held spot's level: from there the level rule alone
  // picks the spot, so it moves on to a higher entry instead of staying pinned until a reload.
  heldSpot() {
    if (!this.heldLevel || this.heldFor !== World.charName) return null;
    const level = World.gp?.progression?.level;
    if (Number.isInteger(level) && level >= this.heldLevel) { this.heldLevel = 0; return null; }
    return this.list().find(s => s.level === this.heldLevel) || null;
  },
  same(a, b) { return !!a && !!b && a.regionId === b.regionId && a.x === b.x && a.z === b.z; },
  // The town "no XP" action can ask for the next spot above the applied one. Returns false when the list has no
  // higher entry left, so the caller falls back to its normal behaviour.
  advanceOnNoXp() {
    const level = World.gp?.progression?.level;
    if (!Number.isInteger(level)) return false;
    if (Leveling.spotsOn()) {
      const next = Leveling.advance(level);
      if (!next) return false;
      // Another town's spot: move there first (return point), the spot is picked again on arrival.
      if (Leveling.foreign(next) && Leveling.startMove(next.townKey)) return true;
      if (Leveling.foreign(next)) return false;
      const H = Hunt.cfg();
      H.center = { ...next.center };
      Settings.saveProfile(); bus.emit('center');
      this.message = 'No XP: hunting moved to another level ' + next.level + ' spot.';
      Log.info('Level spot: ' + this.message); UI.toast(this.message, 'info', 5000);
      const pose = World.pose();
      if (pose && dist2D(pose, H.center) > Math.max(H.radius, 100)) WalkBack.start(true);
      return true;
    }
    const current = this.heldSpot() || this.spotFor(level);
    const next = this.list().find(s => s.level > (current?.level ?? 0));
    if (!next) return false;
    this.heldLevel = next.level; this.heldFor = World.charName;
    const H = Hunt.cfg();
    H.center = { ...next.center };
    Settings.saveProfile(); bus.emit('center');
    this.message = 'No XP: hunting moved to the spot from level ' + next.level + '.';
    Log.info('Level spot: ' + this.message); UI.toast(this.message, 'info', 5000);
    const pose = World.pose();
    if (pose && dist2D(pose, H.center) > Math.max(H.radius, 100)) WalkBack.start(true);
    return true;
  },
  // The walk to the spot zero-setup leveling picked failed: skip that spot; the next tick picks another one.
  // At most LEVEL_SPOT_WALK_FAILS in a row: past that the trouble is not the spot (stuck in town, say), and walking
  // to spot after spot would only wander the map.
  skipCurrent() {
    const cur = Leveling.current;
    if (!cur) return;
    Leveling.skipped.add(cur.key); Leveling.current = null;
    if (++Leveling.walkFails > LEVEL_SPOT_WALK_FAILS) { Log.warn('Leveling: could not walk to ' + LEVEL_SPOT_WALK_FAILS + ' spots in a row; not trying more.'); return; }
    this.retry = true; this.nextAt = 0;
    Log.info('Leveling: could not walk to the level ' + cur.level + ' spot; trying another.');
  },
  // Add (or replace the entry of) a level with the current hunting spot.
  add(level) {
    const center = Settings.profile.hunt.center;
    if (!Number.isInteger(level) || level < 1 || level > 150) return 'Enter a level from 1 to 150.';
    if (!center) return 'Set a hunting spot first.';
    const list = this.cfg().list.filter(s => s.level !== level);
    list.push({ level, center: { ...center } });
    this.cfg().list = list.sort((a, b) => a.level - b.level);
    Settings.saveProfile();
    return '';
  },
  remove(level) { this.cfg().list = this.cfg().list.filter(s => s.level !== level); Settings.saveProfile(); },
  tick() {
    if (!(this.cfg().on || Leveling.spotsOn()) || now() < this.nextAt) return false;
    this.nextAt = now() + 3000;
    const level = World.gp?.progression?.level;
    // With zero-setup spots, a walk back to an old spot (one saved by hand, say) is turned to the spot for the level
    // at once, instead of first walking to the old one.
    const walking = Leveling.spotsOn() && WalkBack.active?.resume && !Travel.active, retry = this.retry && Leveling.spotsOn();
    if (!World.inWorld() || World.isDead() || !(Hunt.running || walking || retry) || !Number.isInteger(level)) return false;
    if (Town.trip || Restock.trip || WalkBack.active && !walking || Travel.active || Quest.trip || Resurrect.trip || Controller.resumeAfterRevive) return false;
    this.retry = false;
    const spot = (Leveling.spotsOn() ? null : this.heldSpot()) || this.spotFor(level), H = Hunt.cfg();
    if (!spot || this.same(spot.center, H.center)) return false;
    // A spot around another town: the character moves there and makes it the return point, then hunts (lean-leveling.js).
    if (Leveling.spotsOn() && Leveling.foreign(spot)) {
      if (Leveling.startMove(spot.townKey)) return true;
      return false;
    }
    H.center = { ...spot.center };
    Settings.saveProfile(); bus.emit('center');
    this.message = spot.auto ? 'Level ' + level + ': hunting moved to a level ' + spot.level + ' spot.' : 'Level ' + level + ': moved the hunting spot to the one from level ' + spot.level + '.';
    Log.info('Level spot: ' + this.message); UI.toast(this.message, 'info', 5000);
    const pose = World.pose();
    if (walking || retry || pose && dist2D(pose, H.center) > Math.max(H.radius, 100)) WalkBack.start(true);
    return true;
  },
};
