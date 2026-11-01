// Hunting spot by level. The profile keeps a list of spots, each used from a character level on; the highest one at or
// below the character's level is the hunting spot. When the level crosses into a new spot, the hunting spot switches
// and the bot walks there. Off by default; it only acts while the bot is hunting and nothing else owns the character.
const LevelSpot = {
  nextAt: 0, message: '',
  // Session state: a no-XP move can put hunting on a spot above the character's level gate; the level rule alone
  // must not pull it back while the character is still below that gate. Kept per character, never saved.
  heldLevel: 0, heldFor: '',
  cfg() { return Settings.profile.hunt.levelSpots; },
  list() { return (this.cfg().list || []).filter(s => Number.isInteger(s?.level) && s.center).sort((a, b) => a.level - b.level); },
  // The spot that applies at this level, or null below the lowest one.
  spotFor(level) { return this.list().filter(s => s.level <= level).pop() || null; },
  heldSpot() { return this.heldLevel && this.heldFor === World.charName ? this.list().find(s => s.level === this.heldLevel) || null : null; },
  same(a, b) { return !!a && !!b && a.regionId === b.regionId && a.x === b.x && a.z === b.z; },
  // The town "no XP" action can ask for the next spot above the applied one. Returns false when the list has no
  // higher entry left, so the caller falls back to its normal behaviour.
  advanceOnNoXp() {
    const level = World.gp?.progression?.level;
    if (!Number.isInteger(level)) return false;
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
    if (!this.cfg().on || now() < this.nextAt) return false;
    this.nextAt = now() + 3000;
    const level = World.gp?.progression?.level;
    if (!World.inWorld() || World.isDead() || !Hunt.running || !Number.isInteger(level)) return false;
    if (Town.trip || Restock.trip || WalkBack.active || Travel.active || Quest.trip || Resurrect.trip || Controller.resumeAfterRevive) return false;
    const spot = this.heldSpot() || this.spotFor(level), H = Hunt.cfg();
    if (!spot || this.same(spot.center, H.center)) return false;
    H.center = { ...spot.center };
    Settings.saveProfile(); bus.emit('center');
    this.message = 'Level ' + level + ': moved the hunting spot to the one from level ' + spot.level + '.';
    Log.info('Level spot: ' + this.message); UI.toast(this.message, 'info', 5000);
    const pose = World.pose();
    if (pose && dist2D(pose, H.center) > Math.max(H.radius, 100)) WalkBack.start(true);
    return true;
  },
};
