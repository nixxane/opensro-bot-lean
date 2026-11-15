// Nearby players and who is fighting the local target, for the phone dashboard. Read-only: nothing here sends commands.
// Deliberate simplification: a pet's hit is not named in `attacker` (its owner still appears in `players`); only player
// casts are remembered. Party members are matched by name, the same way Hunt.playerCheck does.
const Nearby = {
  attackers: new Map(), // monster gid -> { name, at } of the last non-party player who hit it
  init() { bus.on('cast', cast => this.observe(cast)); bus.on('reset', () => this.attackers.clear()); },
  // Record a stranger's hit on every monster the cast touched. The character and party members are never named.
  observe(cast) {
    const caster = World.ents.get(cast.caster);
    if (!caster || caster.kind !== 'player' || caster.gid === World.localGid()) return;
    if (new Set((World.gp?.social?.members || []).map(m => m.name)).has(caster.name)) return;
    const at = World.simNow() ?? now();
    const targets = new Set([cast.target, ...(cast.results || []).map(r => r?.target)].filter(Boolean));
    for (const gid of targets) {
      const target = World.ents.get(gid);
      if (target?.kind === 'monster') this.attackers.set(gid, { name: caster.name, at });
    }
  },
  // The same 8 s window the anti-KS `ksAvoids` check uses; entries that old are dropped here.
  attacker() {
    const sim = World.simNow() ?? now(), target = World.target();
    let name = null;
    for (const [gid, hit] of this.attackers) {
      if (sim - hit.at > 8000) this.attackers.delete(gid);
      else if (target && gid === target.gid) name = hit.name;
    }
    return name;
  },
  // Non-party players within the alert radius, nearest five first. The radius applies even while the alert is off.
  snapshot() {
    const pose = World.pose(), radius = Settings.profile.hunt.playerAlert.radius, party = new Set((World.gp?.social?.members || []).map(m => m.name));
    const near = [];
    if (pose) for (const e of World.ents.values()) {
      if (e.kind !== 'player' || e.gid === World.localGid() || party.has(e.name)) continue;
      const d = dist2D(pose, e);
      if (d <= radius) near.push({ e, d });
    }
    near.sort((a, b) => a.d - b.d);
    return { total: near.length, players: near.slice(0, 5).map(({ e, d }) => ({ name: e.name, m: Math.round(d / 10) })), attacker: this.attacker() };
  },
};
