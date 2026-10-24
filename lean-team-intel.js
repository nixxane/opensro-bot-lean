// Team intel: the live shared world. Each character publishes a small digest of what it sees —
// interesting monsters (champion and up, party mobs, uniques), other players, and the combat edges
// observed from every cast in view (who attacks what, with how much damage) — and merges the digests
// of its room peers. Entries are keyed by the server's entity gid, which is identical across clients;
// they carry their source and a short TTL, and the local view always wins over a shared one.
// Shards: entries from implausible regions (not own or adjacent) are kept out of the merge, so two
// characters on different divisions never smear each other's maps.
const INTEL_PUBLISH_MS = 2500;
const INTEL_MONSTER_TTL_MS = 15000;
const INTEL_PLAYER_TTL_MS = 20000;
const INTEL_EDGE_TTL_MS = 8000; // matches the bot's own "another player's target" window
const TeamIntel = {
  world: new Map(), // gid -> {kind, gid, name, cls, level, hpPct, regionId, x, z, unique, src, at}
  edges: new Map(), // target gid -> {caster, casterName, target, dmg, at}
  sentAt: -Infinity,
  share() { return Settings.profile.team?.share || {}; },
  reset() { this.world.clear(); this.edges.clear(); this.sentAt = -Infinity; },
  // A monster worth reporting: champion and up, party mobs; normals are everywhere and worth little.
  interesting(e) {
    if (e?.kind !== 'monster' || !World.isAlive(e)) return false;
    return e.rarity === 3 || e.rarity === 1 || e.rarity === 4 || e.rarity === 5 || e.rarity === 6 || e.rarityAuxIcon === 1;
  },
  regionOk(regionId) {
    const pose = World.pose();
    if (!pose || !Number.isInteger(regionId)) return true; // nothing to compare against: accept
    const dx = Math.abs((regionId & 255) - (pose.regionId & 255)), dz = Math.abs((regionId >>> 8) - (pose.regionId >>> 8));
    return dx <= 1 && dz <= 1;
  },
  row(e, kind) {
    return { kind, gid: e.gid, name: e.name || null, cls: kind === 'monster' ? monsterClass(e) : null,
      level: e.level ?? null, hpPct: World.hpPctOf(e) ?? null, unique: kind === 'monster' && e.rarity === 3,
      regionId: e.regionId, x: Math.round(e.x), z: Math.round(e.z) };
  },
  // What this character sees right now, capped so a busy area cannot flood the room.
  snapshot() {
    const monsters = [], players = [];
    for (const e of World.ents.values()) {
      if (!e?.gid) continue;
      if (this.interesting(e)) { if (monsters.length < 40) monsters.push(this.row(e, 'monster')); }
      else if (e.kind === 'player' && e.name && e.gid !== World.localGid() && players.length < 30) players.push(this.row(e, 'player'));
    }
    const t = now();
    const edges = [...this.edges.values()].sort((a, b) => b.at - a.at).slice(0, 12)
      .map(x => ({ c: x.caster, cn: x.casterName, t: x.target, d: Math.min(0xffffff, Math.round(x.dmg)), age: Math.max(0, Math.round(t - x.at)) }));
    return { monsters, players, edges };
  },
  publish(payload, scope) {
    return Team.send({ type: 'msg', scope, payload: { kind: 'intel', payload } });
  },
  tick() {
    const t = now();
    for (const [gid, row] of this.world) if (t - row.at > (row.kind === 'player' ? INTEL_PLAYER_TTL_MS : INTEL_MONSTER_TTL_MS)) this.world.delete(gid);
    for (const [gid, edge] of this.edges) if (t - edge.at > INTEL_EDGE_TTL_MS) this.edges.delete(gid);
    if (!Team.online() || t - this.sentAt < INTEL_PUBLISH_MS) return;
    const snap = this.snapshot();
    this.publish(snap, 'room');
    const share = this.share();
    if (share?.public) {
      const open = { monsters: share.monsters ? snap.monsters : [], players: share.players ? snap.players : [], edges: [] };
      if (open.monsters.length || open.players.length) this.publish(open, 'public');
    }
    this.sentAt = t;
  },
  merge(from, payload) {
    const t = now();
    for (const list of [payload?.monsters, payload?.players]) {
      for (const row of Array.isArray(list) ? list : []) {
        if (!row || !Number.isInteger(row.gid) || !this.regionOk(row.regionId)) continue;
        const known = this.world.get(row.gid);
        if (known && known.src === 'me') continue; // own eyes are fresher than any report
        if (known && known.at > t - 1000) continue;
        this.world.set(row.gid, { kind: row.cls ? 'monster' : 'player',
          gid: row.gid, name: row.name, cls: row.cls, level: row.level ?? null, hpPct: row.hpPct ?? null,
          unique: !!row.unique, regionId: row.regionId, x: row.x, z: row.z, src: from, at: t });
        TeamKnowledge.saw(row, from);
      }
    }
    for (const edge of Array.isArray(payload?.edges) ? payload.edges : []) {
      if (!edge || !Number.isInteger(edge.t) || !Number.isInteger(edge.c)) continue;
      const known = this.edges.get(edge.t);
      if (known && t - (known.at || t) < 1000) continue;
      this.edges.set(edge.t, { caster: edge.c, casterName: String(edge.cn || ''), target: edge.t, dmg: edge.d || 0, at: t - (edge.age || 0) });
    }
  },
  // Every cast in view, ours and everyone else's, feeds the combat edges. A cast aimed at the local
  // player from a player outside the party is also a hostility datum for the knowledge base.
  onCast(cast) {
    if (!cast || !Number.isInteger(cast.caster) || !cast.target) return;
    const caster = World.ents.get(cast.caster);
    const owner = caster?.kind === 'cos' ? World.ents.get(caster.ownerGid) : caster;
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target).filter(Number.isInteger)]);
    let dmg = 0, fatal = false;
    for (const r of cast.results || []) for (const i of r?.impacts || []) { dmg += i?.damage || 0; fatal ||= !!i?.fatal; }
    const t = now();
    for (const gid of targets) {
      const e = World.ents.get(gid);
      if (e?.kind !== 'monster') continue;
      const edge = this.edges.get(gid);
      if (edge && edge.caster !== cast.caster && t - edge.at < 1500) continue; // keep the main attacker
      this.edges.set(gid, { caster: cast.caster, casterName: owner?.name || '', target: gid, dmg: (edge?.caster === cast.caster ? edge.dmg : 0) + dmg, at: t });
      if (e.rarity === 3 && fatal) TeamKnowledge.killed(e, owner?.name || 'someone');
    }
    if (owner?.kind === 'player' && targets.has(World.localGid())) {
      const social = World.gp?.social;
      const member = Array.isArray(social?.members) && social.members.some(m => m?.name === owner.name);
      if (!member && owner.name !== social?.localName) TeamKnowledge.hostile(owner);
    }
  },
  rows() { const t = now(); return [...this.world.values()].filter(r => t - r.at <= (r.kind === 'player' ? INTEL_PLAYER_TTL_MS : INTEL_MONSTER_TTL_MS)); },
};
bus.on('cast', cast => TeamIntel.onCast(cast));
Team.on('msg', m => {
  const payload = m?.payload;
  if (payload?.kind === 'intel') TeamIntel.merge(m.from, payload.payload);
  else if (payload?.kind === 'event') { TeamKnowledge.event(m.from, payload.event); TeamArbiter.event(m.from, payload.event); }
});
