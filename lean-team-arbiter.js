// Team arbiter: the decisions that make a group of characters act like a team instead of five solo
// bots in the same field. Assist focuses your target chooser on the monster a teammate is fighting
// (party members' hits never mark a monster, and by default any other player's hits do — so team
// etiquette between unpartied characters is already the bot's no-KS rule; assist is the other half).
// Town sync makes the room recall together. Resurrection claims stop the dead member reviving
// itself while a peer walks over. Spot claims warn when two characters start on top of each other.
// The room's console (served by the relay) can stop everyone or call a group town trip. Every rule
// is local and advisory: each bot still acts only through its own command layer.
const TeamArbiter = {
  resClaimAt: -Infinity, resClaimBy: '', townFollowAt: -Infinity, spotWarnAt: -Infinity, converge: null,
  cfg() { return Settings.profile.team; },
  reset() { this.resClaimAt = -Infinity; this.townFollowAt = -Infinity; },
  // ---- assist: fight what a teammate fights ----
  assistTarget(current) {
    try {
      if (current || !this.cfg().assist || !Team.online()) return null;
      const social = World.gp?.social, t = now();
      const isParty = n => Array.isArray(social?.members) && social.members.some(m => m?.name === n);
      let best = null;
      for (const edge of TeamIntel.edges.values()) {
        const name = edge.casterName;
        if (!name || name === World.charName || t - edge.at > INTEL_EDGE_TTL_MS) continue;
        if (!Team.peers.has(name) && !isParty(name)) continue;
        const e = World.ents.get(edge.target);
        if (!e || !isAttackableMob(e) || Hunt.banned(Hunt.ban, e.gid)) continue;
        if (!best || edge.at > best.edge.at) best = { edge, e };
      }
      if (best) Log.info('Team assist: joining ' + best.edge.casterName + "'s fight.");
      return best?.e || null;
    } catch { return null; }
  },
  // ---- room events ----
  event(from, ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'town' && ev.who !== World.charName && this.cfg().townSync) {
      if (Hunt.running && !Town.trip && now() - this.townFollowAt > 60000) {
        this.townFollowAt = now();
        UI.toast(from + ' went to town; starting the town trip too.', 'info', 5000);
        try { Town.begin(); } catch (e) { Log.error('Team town sync: ' + (e?.message || e)); }
      }
    } else if (ev.kind === 'res-claim' && ev.target === World.charName) {
      this.resClaimAt = now(); this.resClaimBy = from;
      UI.toast(from + ' is coming to resurrect you.', 'info', 5000);
    } else if (ev.kind === 'unique') this.uniqueEvent(ev);
    else if (ev.kind === 'cmd') this.command(ev);
  },
  // ---- unique converge (opt-in): hunt at the unique's position until it dies or 20 minutes pass ----
  uniqueEvent(ev) {
    if (ev.state === 'dead') {
      if (this.converge?.name === ev.name) this.restoreSpot(ev.name + ' is dead; back to the saved hunting spot.');
      return;
    }
    if (ev.state !== 'appear' || !this.cfg().converge || this.converge) return;
    const pos = ev.pos || TeamKnowledge.uniques.get(ev.name)?.pos;
    if (!pos || !Number.isInteger(pos.regionId)) return;
    const H = Settings.profile.hunt;
    if (!Hunt.running || !H.center || Town.trip || !World.inWorld() || World.isDead()) return;
    this.converge = { name: ev.name, prev: { ...H.center }, at: now() };
    H.center = { regionId: pos.regionId, x: Math.round(pos.x), y: H.center.y || 0, z: Math.round(pos.z) };
    Settings.saveProfile(); bus.emit('center');
    UI.toast('Going to ' + ev.name + "'s position; the saved spot comes back after.", 'warn', 6000);
  },
  restoreSpot(message) {
    const c = this.converge;
    if (!c) return;
    this.converge = null;
    Settings.profile.hunt.center = c.prev;
    Settings.saveProfile(); bus.emit('center');
    if (message) UI.toast(message, 'info', 5000);
  },
  tick() {
    if (this.converge && now() - this.converge.at > 20 * 60000) this.restoreSpot('Unique hunt timed out; back to the saved hunting spot.');
  },
  command(ev) {
    const action = String(ev.action || '');
    if (action === 'stop') { stopAll(); UI.toast('Team console: everyone stops.', 'warn', 5000); }
    else if (action === 'town') {
      if (Hunt.running && !Town.trip) { try { Town.begin(); } catch (e) { Log.error('Team console town: ' + (e?.message || e)); } }
    }
  },
  resIncoming() { return now() - this.resClaimAt < 45000; },
  // Warn once a minute when a hunting teammate sits on our spot; picking another spot stays ours.
  spotCheck() {
    try {
      const pose = World.pose(), center = Settings.profile.hunt.center;
      const me = center && pose ? center : pose;
      if (!me || now() - this.spotWarnAt < 60000) return;
      for (const [name, peer] of Team.peers) {
        const pos = peer.state?.pos;
        if (!peer.state?.hunting || !pos || !Number.isInteger(pos.regionId)) continue;
        const d = regionDelta(me, pos);
        if (d && Math.hypot(...d) < 400) {
          this.spotWarnAt = now();
          UI.toast(name + ' is hunting about ' + Math.round(Math.hypot(...d) / 10) + ' m from your spot.', 'warn', 6000);
          return;
        }
      }
    } catch {}
  },
  // ---- unique converge (manual): move the saved spot to a tracked unique's last position ----
  huntAtUnique(name) {
    const record = TeamKnowledge.uniques.get(name), pose = World.pose();
    if (!record?.pos || !Number.isInteger(record.pos.regionId)) { UI.toast('No position is known for ' + name + ' yet.', 'warn'); return false; }
    this.converge = null; // a manual move cancels any automatic converge so its restore cannot clobber it
    Settings.profile.hunt.center = { regionId: record.pos.regionId, x: Math.round(record.pos.x), y: Number(pose?.y) || 0, z: Math.round(record.pos.z) };
    Settings.saveProfile(); bus.emit('center');
    UI.toast('Hunting spot moved to ' + name + "'s last known position.");
    return true;
  },
};
// Assist slots into the target line between the engaged target and the chooser.
Hunt.teamTarget = function (current) { return TeamArbiter.assistTarget(current); };
// Announce town trips so the room can recall together; the revival trip stays private.
{
  const teamTownBegin = Town.begin;
  Town.begin = function (revival = false) {
    const out = teamTownBegin.call(this, revival);
    if (out !== false && !revival && Team.online()) Team.emit({ kind: 'town', who: World.charName });
    return out;
  };
}
// A resurrection approach tells the dead member to wait for it, up to a minute.
{
  const teamResTick = Resurrect.tick;
  Resurrect.tick = function (...args) {
    const before = this.trip ? this.trip.name : null;
    const out = teamResTick.apply(this, args);
    const name = this.trip && this.trip.phase === 'approach' ? this.trip.name : null;
    if (name && name !== before && Team.online()) Team.emit({ kind: 'res-claim', target: name });
    return out;
  };
  const teamReviveDelay = Party.reviveDelay;
  Party.reviveDelay = function () { return TeamArbiter.resIncoming() ? 60000 : teamReviveDelay.call(this); };
  const teamWaitNote = Party.waitNote;
  Party.waitNote = function () {
    if (TeamArbiter.resIncoming()) return 'waiting up to 60 s; ' + TeamArbiter.resClaimBy + ' is coming to resurrect you.';
    return teamWaitNote.call(this);
  };
}
// Spot claims: check the room's beats once, right after hunting starts.
{
  const teamHuntStart = Hunt.start;
  Hunt.start = function (...args) {
    const out = teamHuntStart.apply(this, args);
    if (this.running) TeamArbiter.spotCheck();
    return out;
  };
}
