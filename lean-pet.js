// The attack pet assists the hunter: every monster the bot engages is handed to the attack pet too, with the same
// command the game's own pet bar sends (cos-pet-attack — the server admits an owned living band-3 pet and a monster
// target only, so cos-attack, which is for the mount you ride, is never used). A pet that stayed behind on an old
// monster is first called back (cos-follow) whenever it is farther from the player than the recall radius; it sets
// out to the new target from the player's side, dragging whatever chases it along — a walking lure. Between targets
// the pet is kept at the player's side. Orders repeat every few seconds so a lost or refused one never leaves the
// pet idle. Nothing is commanded while a trip owns the character, and the pickup pet (band 4) is never touched:
// pickup keeps running beside this.
const PET_FOLLOW_MS = 5000; // re-sending the return order more often than this only spams the same intent
const PetAttack = {
  mode: 'idle',       // idle | home (called back first) | attack
  pending: 0,         // the monster we want the pet on; 0 = none
  since: -Infinity,   // when the current job started (bounds the call-back wait)
  lastOrderAt: -Infinity, lastFollowAt: -Infinity, message: 'Pet attack off.',
  cfg() { return Settings.profile.pet.attack; },
  on() { return !!this.cfg().on; },
  reset() { this.mode = 'idle'; this.pending = 0; this.since = now(); this.message = this.on() ? 'Waiting for a target.' : 'Pet attack off.'; },
  // The one living attack pet (band 3) we own; transports (band 2) and the pickup pet (band 4) are not ours to command.
  pet() {
    for (const rec of World.gp?.cosRecords || []) {
      const ent = World.ents.get(rec.gid);
      if (rec.band === 3 && !rec.dead && rec.hp > 0 && ent?.kind === 'cos' && ent.ownerGid === World.localGid() && ent.refObjId === rec.refObjId) return { rec, ent };
    }
    return null;
  },
  follow(pet) { return Cmd.spaced('cos-follow') && Cmd.raw({ kind: 'cos-follow', gid: pet.rec.gid }, 'Pet: return to me'); },
  send(pet, gid) {
    const e = World.ents.get(gid);
    if (!e || !isAttackableMob(e)) return false; // the server admits monster targets only
    return Cmd.spaced('cos-pet-attack') && Cmd.raw({ kind: 'cos-pet-attack', gid, pet: pet.rec.gid }, 'Pet attack: ' + (e.name || gid));
  },
  // Farther than the recall radius from the player (another region counts as far) — worth calling home first.
  far(pet) { const d = dist2D(World.pose(), pet.ent); return !Number.isFinite(d) || d > (Number(this.cfg().radius) || 15) * 10; },
  // A new bot target hands the pet a new job; a job may be replaced while the pet is still on its way home.
  retarget(gid) {
    if (!this.on()) { this.pending = 0; this.mode = 'idle'; return; }
    if (this.pending !== gid) this.lastOrderAt = -Infinity; // a new target may be ordered at once
    this.pending = gid; this.since = now();
    this.mode = this.cfg().recall ? 'home' : 'attack'; // a near pet resolves home in the same tick
  },
  tick() {
    const c = this.cfg();
    if (!this.on()) { this.mode = 'idle'; this.pending = 0; this.message = 'Pet attack off.'; return; }
    if (!World.inWorld() || World.isDead()) { this.mode = 'idle'; this.pending = 0; this.message = 'Pet attack waiting for the game.'; return; }
    const pet = this.pet();
    if (!pet) { this.mode = 'idle'; this.pending = 0; this.message = 'Summon an attack pet to assist.'; return; }
    // A pet that appears mid-fight (summoned, revived, or the switch just turned on) adopts the target the bot
    // is already on instead of waiting for the next one.
    if (!this.pending && Hunt.targetGid) {
      this.pending = Hunt.targetGid; this.since = now(); this.lastOrderAt = -Infinity;
      this.mode = c.recall && this.far(pet) ? 'home' : 'attack';
    }
    const target = this.pending ? World.ents.get(this.pending) : null;
    // Wanted only while the bot still wants it too: a target it released while alive (banned, unreachable) is
    // released with it, instead of the pet soloing it forever.
    const wanted = !!(target && isAttackableMob(target) && Hunt.targetGid === this.pending);
    // The call-back owns the pet until it is back (or the wait gives up); even for a target that died meanwhile,
    // coming home is still where it should be.
    if (this.mode === 'home') {
      if (this.far(pet) && now() - this.since < (Number(c.timeout) || 3) * 1000) {
        this.message = 'Pet returning before the next attack.';
        if (now() - this.lastFollowAt >= PET_FOLLOW_MS && this.follow(pet)) this.lastFollowAt = now();
        return;
      }
      this.mode = wanted ? 'attack' : 'idle';
    }
    if (wanted) {
      this.mode = 'attack';
      if (now() - this.lastOrderAt >= (Number(c.resend) || 5) * 1000 && this.send(pet, this.pending)) {
        this.lastOrderAt = now();
        this.message = 'Pet attacking ' + (target.name || this.pending) + '.';
      }
      return;
    }
    // Between targets the pet stays at the player's side, ready to set out from there.
    this.mode = 'idle'; this.pending = 0;
    this.message = 'Waiting for a target.';
    if (c.recall && this.far(pet) && now() - this.lastFollowAt >= PET_FOLLOW_MS && this.follow(pet)) this.lastFollowAt = now();
  },
  status() {
    if (!this.on()) return 'Pet attack off.';
    if (!World.inWorld()) return 'Pet attack waiting for the game.';
    return Hunt.running ? this.message : 'Start the bot to command the pet.';
  },
};
// engage() re-runs every tick with the same target, so only a real change hands the pet a new job.
// The pet order gets the same per-kind gap as the mount's cos-attack; MIN_GAP lives in vendor/bot.js,
// which is never edited, so the entry is set here at load time (the lean-pet-potion.js Cmd pattern).
MIN_GAP['cos-pet-attack'] = 700;
const petAttackEngage = Hunt.engage;
Hunt.engage = function (target) {
  const before = this.targetGid;
  const out = petAttackEngage.apply(this, arguments);
  if (this.targetGid && this.targetGid !== before) PetAttack.retarget(this.targetGid);
  return out;
};
// The state machine runs after every hunting tick — fights, loot and rests included — but never beside a trip that
// owns the character, and only while hunting: a stopped bot leaves the pet to its owner.
const petAttackHuntTick = Hunt.tick;
Hunt.tick = function () {
  const out = petAttackHuntTick.apply(this, arguments);
  if (this.running && !Town.trip && !Restock.trip && !WalkBack.active && !Resurrect.trip && !Travel.active && !World.gp?.storage) {
    try { PetAttack.tick(); } catch (e) { Log.error('Pet attack: ' + (e?.message || e)); }
  }
  return out;
};
bus.on('hunt', running => { if (!running) PetAttack.reset(); });
for (const event of ['reset', 'profile', 'character']) bus.on(event, () => PetAttack.reset());
