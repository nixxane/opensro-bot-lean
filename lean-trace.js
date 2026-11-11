// Follow a party member ("trace"). The game tells every party member where the others are (region and position), so the
// bot always knows where the chosen member is. While hunting it keeps within a set distance of them and hunts around
// THEM instead of around the saved hunting spot: the saved spot is only swapped for the member's position while the
// hunting step runs, never stored. Nothing changes unless the switch is on, and a member who is not in the party,
// is in another area, or is too far away leaves the bot hunting at its own spot.
const TRACE_LIMIT = { sendMs: 900, farUnits: 3000 };
const Trace = {
  message: 'Following off.', code: 'off', sentAt: -Infinity, travel: null, walking: false, note: null,
  cfg() { return Settings.profile.trace; },
  active() { return !!this.cfg().enabled && Hunt.running; },
  social() { return World.gp?.social; },
  // The member to follow: the chosen name, or the party leader when no name is chosen. Never yourself.
  member() {
    const social = this.social(), name = String(this.cfg().name || '').trim();
    if (!social || !Array.isArray(social.members)) return null;
    const others = social.members.filter(m => m && m.name && m.name !== social.localName);
    if (name) return others.find(m => m.name === name) || null;
    return others.find(m => m.id === social.leader) || null;
  },
  position(m) { return Number.isInteger(m?.region) && [m.x, m.z].every(Number.isFinite) ? { regionId: m.region, x: m.x, y: Number(m.y) || 0, z: m.z } : null; },
  // A point on the line from the member towards us, `keep` units from the member, so we stop beside them, not on them.
  beside(pos, from, keep) {
    const d = regionDelta(pos, from), length = Math.hypot(...d);
    if (!length || length <= keep) return from;
    const k = keep / length, x = pos.x + d[0] * k, z = pos.z + d[1] * k;
    // Caves have no sector grid: coordinates are local to the one region, which must stay as it is.
    if ((pos.regionId | from.regionId) & DUNGEON) return { regionId: pos.regionId, x, y: pos.y, z };
    const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR);
    return { regionId: ((pos.regionId & 255) + sx) | (((pos.regionId >>> 8) + sz) << 8), x: x - sx * SECTOR, y: pos.y, z: z - sz * SECTOR };
  },
  reset() { this.travel = null; this.walking = false; this.sentAt = -Infinity; this.message = this.cfg().enabled ? 'Waiting for the party.' : 'Following off.'; this.code = this.cfg().enabled ? 'waiting' : 'off'; },
  say(text, code) { this.message = text; this.code = code; return false; },
  // True when this tick belonged to the follower (it walked, or hunted around the member); false leaves the tick to the
  // normal hunting step at the saved spot.
  tick() {
    const c = this.cfg();
    this.walking = false;
    if (!c.enabled) { this.message = 'Following off.'; this.code = 'off'; return false; }
    if (!Hunt.running || !World.inWorld() || World.isDead()) return this.say('Waiting for a living character.', 'waiting');
    const member = this.member();
    if (!member) return this.say(c.name ? `${c.name} is not in your party; hunting at the saved spot.` : 'No party leader to follow (you lead, or you are not in a party); hunting at the saved spot.', 'no-member');
    if (member.status !== undefined && (member.status & 15) === 0) return this.say(`${member.name} is dead; hunting at the saved spot until they are back.`, 'member-dead');
    const pos = this.position(member), me = World.pose();
    if (!pos || !me) return this.say(`${member.name}'s position is not known yet; hunting at the saved spot.`, 'no-position');
    const delta = regionDelta(me, pos);
    if (!delta) return this.say(`${member.name} is in another area; hunting at the saved spot.`, 'other-area');
    const distance = Math.hypot(...delta), keep = Math.max(30, Number(c.distance) * 10 || 120);
    if (distance > TRACE_LIMIT.farUnits) return this.say(`${member.name} is ${Math.round(distance / 10)} m away, too far to follow; hunting at the saved spot.`, 'too-far');
    const attacked = c.fight && Hunt.underAttack() && distance <= keep * 3;
    // Close enough, or fighting something that attacks us: hunt around the member.
    if (distance <= keep || attacked) {
      this.travel = null;
      const H = Hunt.cfg(), real = H.center;
      H.center = { regionId: pos.regionId, x: pos.x, y: pos.y, z: pos.z };
      try { Hunt.tick(); } finally { H.center = real; }
      this.message = `Hunting around ${member.name} (${Math.round(distance / 10)} m away).`; this.code = 'hunting-around';
      return true;
    }
    // Too far: walk to them. Sitting or casting is left to the hunting step.
    if (World.isSitting() || World.isCasting()) return false;
    this.walking = true; Hunt.state = 'follow';
    if (Hunt.targetGid) { Hunt.targetGid = 0; }
    const goal = this.beside(pos, me, Math.max(30, keep * 0.6));
    let point = goal, straight = false;
    if (Navigation.scene && !((me.regionId | goal.regionId) & DUNGEON)) {
      const move = Navigation.next(this, goal, false, Math.max(40, keep * 0.4));
      if (move.point) point = move.point;
      else if (move.error && !move.waiting) straight = true;
    }
    if (now() - this.sentAt >= TRACE_LIMIT.sendMs && Cmd.move(point)) this.sentAt = now();
    this.code = 'walking';
    this.message = `Following ${member.name}: ${Math.round(distance / 10)} m away` + (straight ? '; no walkable route in the collision map, walking straight.' : '.');
    return true;
  },
  status() { return this.message; },
  names() {
    const social = this.social();
    return (Array.isArray(social?.members) ? social.members : []).filter(m => m?.name && m.name !== social.localName).map(m => [m.name, m.name + (m.id === social.leader ? ' (leader)' : '')]);
  },
  draw(parent) {
    const box = UI.group('Follow a party member', UI.check('Follow a party member while hunting', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.reset(); }));
    box.append(UI.select('Follow', () => [['', 'The party leader'], ...this.names(), ...(this.cfg().name && !this.names().some(n => n[0] === this.cfg().name) ? [[this.cfg().name, this.cfg().name + ' (not in the party now)']] : [])], () => this.cfg().name || '', v => { this.cfg().name = v; this.reset(); }),
      UI.number('Stay within (m)', () => this.cfg().distance, v => this.cfg().distance = v, 3, 60),
      UI.check('Fight monsters that attack on the way', () => this.cfg().fight, v => this.cfg().fight = v));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'While hunting the bot stays within this distance of the member and hunts around them, not around your saved hunting spot (that stays saved and is used again when following is off or the member is unavailable). The game tells the party where its members are, so it also follows them across the map, up to 300 m. It does not follow into another area, a dungeon or a teleport. Town trips, resurrection and walk-back still work as before and bring you back to your saved spot.', 'muted'));
    parent.append(box);
  },
};
for (const [name, method] of [['Follow party member', 'tick']]) {
  const original = Trace[method];
  Trace[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}
