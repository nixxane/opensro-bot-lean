// Single owner for movement/combat/pickup. Potion use remains a separate emergency lane.
const startHunting = Hunt.start;
Hunt.start = function (...args) {
  if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before hunting.', 'warn');
  if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before hunting.', 'warn');
  if (Stall.run) return UI.toast('Stop the stall session before hunting.', 'warn');
  if (World.gp?.stall?.phase && World.gp.stall.phase !== 'none') return UI.toast('Close the stall before hunting.', 'warn');
  return startHunting.apply(this, args);
};
Hunt.lootAllowed = e => Loot.allowed(e);
// Kill the small ones first. While fighting a stronger monster, switch to a weaker one that is hitting you, then come
// back: the stronger one is still fighting you, so attackers-first picks it up again. Always on, by design:
//  1. only monsters that hit you in the last few seconds (World.attackers) and are within chase distance;
//  2. only a weaker class than the current target (two giants hitting you is no reason to switch);
//  3. never away from a target below THREAT_FINISH_PCT HP: finish it;
//  4. never during a cast (the caller only asks between skills);
//  5. the weakest attacker first (lowest HP), so each kill removes its damage soonest;
//  6. no flip-flop: the small one becomes the current target and only something weaker still could take its place.
// With no current target the weakest attacker is picked the same way, so the giant is not selected between two kills.
const THREAT_RANK = { normal: 1, champion: 2, elite: 4, party: 10, giant: 20, titan: 100, unique: 200 };
const THREAT_WINDOW_MS = 6000, THREAT_FINISH_PCT = 25;
Hunt.threat = function (current) {
  if (World.isCasting() || !current && this.cfg().priority !== 'attackers') return null;
  const rank = e => THREAT_RANK[monsterClass(e)] ?? 1, hp = e => World.hpPctOf(e) ?? 100;
  if (current && (World.hpPctOf(current) ?? 100) < THREAT_FINISH_PCT) return null;
  const sim = World.simNow() ?? 0, pose = World.pose(), chase = this.cfg().chase, limit = current ? rank(current) : Infinity;
  let best = null;
  for (const e of World.ents.values()) {
    if (e === current || !isAttackableMob(e) || this.banned(this.ban, e.gid) || rank(e) >= limit) continue;
    if (sim - (World.attackers.get(e.gid) ?? -Infinity) >= THREAT_WINDOW_MS || dist2D(pose, e) > chase) continue;
    if (!best || rank(e) < rank(best) || rank(e) === rank(best) && (hp(e) < hp(best) || hp(e) === hp(best) && dist2D(pose, e) < dist2D(pose, best))) best = e;
  }
  if (!best || !current) return best;
  const from = current.name || monsterClass(current), to = best.name || monsterClass(best);
  this.threatNote = { gid: best.gid, text: `Combat: switched to ${to} (hitting you); back to ${from} after.` };
  Log.info(`Switched from ${from} to ${to}, which is hitting you.`);
  return best;
};
Hunt.chooseLoot = () => Loot.choose();
Hunt.tick = function () {
  if (!this.running) return;
  if (!Town.cfg().enabled && Restock.tick()) { Loot.suspend(); return; }
  const H = this.cfg(), gp = World.gp;
  if (!World.inWorld()) { this.state = 'waiting'; return; }
  if (World.isDead()) {
    Loot.suspend();
    this.state = 'dead';
    if (!this.deathAt) { Town.deathPoint = World.pose() ? { ...World.pose() } : null; this.deathAt = now(); Party.noteDeath(); Log.info('Died: ' + Party.waitNote()); }
    if ((Town.autoRevive() || H.onDeath === 'revive') && !this.revived && now() - this.deathAt > Party.reviveDelay() && !Party.resBusy()) {
      if (Cmd.rebirth(1)) this.revived = true;
    } else if (!Town.autoRevive() && H.onDeath === 'stop') this.stop('character died');
    return;
  }
  if (this.deathAt) {
    this.deathAt = 0; this.revived = false; this.targetGid = 0;
    if (H.center && dist2D(World.pose(), H.center) > H.radius) { Controller.returnAfterRevive(); return; }
  }
  if (Restock.activeShop() || gp.storage || now() - Manual.lastAt < H.manualPauseS * 1000) {
    Loot.suspend(); this.state = 'manual'; return;
  }
  if (this.playerCheck()) { Loot.suspend(); this.state = 'player'; return; }
  if (H.stopNoHpPotion && Potion.count('hp') + Potion.count('vigor') === 0) return this.stop('out of HP potions');
  if (H.stopInvFull && World.freeBagSlots() === 0) return this.stop('inventory full');
  Loot.preparePet();
  const attacked = this.underAttack(), current = this.currentTarget();
  // One pickup at a time. A pet's request does not own the character's combat tick; a character pickup owns
  // movement until it is done or an attacker interrupts it. The pet's drops go first, then the character's.
  if (attacked && Loot.active && !Loot.active.petGid) Loot.suspend();
  if (Loot.active) { if (Loot.active.petGid) Loot.tick(); else if (Loot.tick()) return; }
  if (!Loot.active && H.pickup.enabled) {
    if (Loot.petMode()) { const drop = Loot.choose('pet'); if (drop) Loot.begin(drop); }
    if (!Loot.active && !attacked && (!current || !H.pickup.afterKillOnly) && !World.isSitting()) {
      const drop = Loot.choose('character');
      if (drop && Loot.begin(drop)) { this.state = 'loot'; return; }
    }
  }
  const me = World.me();
  if (World.isSitting()) {
    const done = !H.sit.enabled || me.hpPct >= H.sit.resumeAt && me.mpPct >= H.sit.resumeAt;
    this.state = done || attacked ? 'standing' : 'resting';
    if ((done || attacked) && now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    return;
  }
  if (H.sit.enabled && !attacked && !current && (me.hpPct < H.sit.hpBelow || me.mpPct < H.sit.mpBelow)) {
    if (now() - this.sitToggleAt > 2500 && Cmd.action(1000)) this.sitToggleAt = now();
    this.state = 'resting'; return;
  }
  if (Combat.buffs(true)) { this.state = 'buff'; return; }
  const target = this.threat(current) || current || this.teamTarget(current) || this.chooseTarget();
  if (target) { this.engage(target); return; }
  this.targetGid = 0; this.state = Loot.active?.petGid ? 'loot' : 'search';
  if (H.returnToCenter && H.center && dist2D(World.pose(), H.center) > Math.max(40, H.radius * 0.5) && now() - this.lastMoveAt > 2500) {
    if (!Number.isFinite(dist2D(World.pose(), H.center))) return this.stop('hunt area is in another region');
    if (Cmd.move(H.center)) this.lastMoveAt = now();
    this.state = 'return';
  }
};

function stopAll() {
  Town.record('stop');
  Alchemy.stop();
  Stall.stop();
  BuffGear.cancel();
  const townActive = !!Town.trip;
  Town.cancel();
  Resurrect.cancelTrip('', true);
  Resurrect.holdUntil = 0;
  Controller.resumeAfterRevive = false;
  const active = townActive || Hunt.running || Restock.trip || WalkBack.active || Loot.active;
  WalkBack.cancel('', false);
  if (Hunt.running) Hunt.stop();
  Restock.trip = null;
  Loot.suspend();
  if (active && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
}

// An imbue's cooldown is as long as the imbue itself, so it can be renewed only once it has (nearly) run out.
// The 1.2 s wait after a send also holds while the old imbue still shows time left: until the answer arrives,
// resending into the server's cooldown only earns refusals that pause the imbue.
const IMBUE_RENEW_MS = 400;
Combat.imbue = function () {
  const M = Settings.profile.macro;
  if (!M.imbue) return false;
  const id = this.resolve(M.imbue);
  if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, World.me())) return false;
  if (World.buffRemaining(id) > IMBUE_RENEW_MS) return false;
  if (now() - (this.buffCastAt.get('imbue') || 0) < 1200) return false;
  if (this.cast(id, 0)) {
    this.buffCastAt.set('imbue', now());
    return true;
  }
  return false;
};
// A skill with a cast time reads the imbue when it releases, not when it is pressed, and the game takes an imbue
// in the middle of another skill's cast (an instant self skill runs beside it). The imbue usually comes back
// mid-cast, so it is cast right away: waiting for the cast to end released that skill without it.
const fightBetweenCasts = Combat.fight;
Combat.fight = function (target) {
  const M = Settings.profile.macro;
  if (target && M.imbueBeforeAttack && World.isCasting() && World.gp.target === target.gid && !World.gp.targetPending &&
    now() - this.lastCastAt >= (M.castGapMs ?? 250) && this.imbue()) return;
  return fightBetweenCasts.call(this, target);
};
// Berserk fires when the gauge is full and the target's class is ticked in Combat options.
Combat.berserk = function (cls) {
  if (!Settings.profile.macro.berserkClasses?.[cls] || World.berserkGauge < 5) return false;
  if (World.local()?.appearanceState?.[2] === 1) return false;
  return Cmd.berserk();
};
const Controller = {
  mode: 'idle', lastErrorAt: -Infinity, resumeAfterRevive: false, guardAt: {},
  // Optional features must never stop hunting: an error in one is logged (at most every 5 s) and skipped.
  guard(name, fn) {
    try { return fn(); } catch (e) {
      if (now() - (this.guardAt[name] ?? -Infinity) > 5000) { this.guardAt[name] = now(); Log.error(name + ' error: ' + (e?.message || e)); }
      return false;
    }
  },
  // Start hunting again after an interruption, but only where that is safe: at the hunting spot it just starts,
  // otherwise it walks back. WalkBack first tries the navdata corridor and falls back to short legs; its own caps
  // refuse a spot that is too far. Returns 'started', 'walking' or 'stopped'.
  resumeHunting(prefix) {
    const H = Hunt.cfg(), pose = World.pose(), distance = H.center && pose ? dist2D(pose, H.center) : Infinity;
    if (Number.isFinite(distance) && distance <= Math.max(H.radius * 1.5, 600)) { UI.toast(prefix + '; resuming hunting.', 'info', 4000); Hunt.start(); return 'started'; }
    if (Number.isFinite(distance)) { UI.toast(prefix + '; walking back to the hunting spot.', 'info', 4000); WalkBack.start(true); return WalkBack.active ? 'walking' : 'stopped'; }
    UI.toast(prefix + ', but not at the hunting spot. Use Return & hunt when ready.', 'warn', 6000);
    return 'stopped';
  },
  returnAfterRevive() {
    this.resumeAfterRevive = false;
    Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
    if (Town.autoRevive()) Town.begin(true);
    else if (Settings.profile.hunt.center) WalkBack.start(true);
    else Hunt.stop('No saved hunting spot for revival return.');
  },
  tick() {
    try {
      this.guard('Reconnect', () => Reconnect.tick());
      this.guard('Team', () => { Team.tick(); TeamIntel.tick(); TeamKnowledge.tick(); TeamArbiter.tick(); });
      Restock.sample();
      Alchemy.tick();
      if (BuffGear.run) {
        if (World.inWorld()) { Party.tick(); Potion.tick(); }
        if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      }
      if (Alchemy.run || Alchemy.pending) { if (World.inWorld()) Party.tick(); this.mode = 'alchemy'; return; }
      if (Stall.run) { if (World.inWorld()) { Party.tick(); Potion.tick(); } Stall.tick(); this.mode = 'stall'; return; }
      if (World.inWorld() && World.isDead() && Hunt.running) {
        Town.cancel(); Resurrect.cancelTrip(); Resurrect.holdUntil = 0;
        Party.acceptResurrection();
        Hunt.tick(); this.mode = Hunt.state; return;
      }
      if (World.inWorld() && !World.isDead() && (this.resumeAfterRevive || Hunt.running && Hunt.deathAt)) {
        if (World.gp?.inventoryPending || !World.local()) { this.mode = 'waiting'; return; }
        if (!this.resumeAfterRevive && Hunt.cfg().center && dist2D(World.pose(), Hunt.cfg().center) <= Hunt.cfg().radius) {
          Hunt.deathAt = 0; Hunt.revived = false; Hunt.targetGid = 0;
        } else this.returnAfterRevive();
      }
      if (Town.trip) {
        if (World.inWorld()) Party.tick();
        // Reserve the first settled item-use window for departure. Continuing
        // alternating potions first can perpetually renew the 350 ms hold.
        if (Town.trip.phase !== 'recall' || !Town.trip.potionWindowReserved || World.isCasting() || World.gp?.inventoryPending) Potion.tick();
        Town.trip.potionWindowReserved = true;
        if (Town.tick()) { this.mode = 'town service'; return; }
      }
      if (!World.inWorld()) { this.mode = 'waiting'; return; }
      Party.tick();
      Party.resumeTick();
      AutoMastery.tick();
      StatPoints.tick();
      Potion.tick();
      ItemRules.dropTick();
      Loot.checkPetFull();
      if (Town.tick()) { this.mode = 'town service'; return; }
      if (Trap.tick()) { this.mode = 'escape'; return; }
      if (Chase.tick()) { this.mode = 'obstacle pursuit'; return; }
      if (BuffGear.tick()) { this.mode = 'buff gear'; return; }
      if (SpeedScroll.tick()) { this.mode = 'speed scroll'; return; }
      if (!WalkBack.active && !Restock.trip && !Restock.recording && !Controller.resumeAfterRevive &&
          !Restock.activeShop() && !World.gp.storage && Resurrect.tick()) {
        this.mode = 'resurrect'; return;
      }
      if (!WalkBack.active && !Restock.trip && !Restock.recording && !Restock.activeShop() && !World.gp.storage && Support.tick()) {
        this.mode = 'party support'; return;
      }
      if (WalkBack.active) { this.mode = 'returning'; WalkBack.tick(); }
      else if (Restock.recording) this.mode = 'recording';
      else if (Hunt.running) { if (!Trace.tick()) Hunt.tick(); this.mode = Restock.trip ? 'shopping' : Hunt.state; }
      else this.mode = 'idle';
    } catch (e) {
      stopAll();
      if (now() - this.lastErrorAt > 5000) { this.lastErrorAt = now(); Log.error(e.message || String(e)); UI.toast('Bot stopped: ' + e.message, 'warn'); }
      this.mode = 'error';
    } finally {
      Town.record();
      Stats.sample();
    }
  },
};
