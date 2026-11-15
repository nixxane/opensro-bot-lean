// Active hunt-area search: with no monster in view, walk the hunting area in a star sweep
// (north, centre, east, centre, west, centre, south, centre) so spawns beyond the view distance are
// found instead of the bot idling at the centre. Opt-in (Combat > Hunting area > Search the hunting
// area); off by default. It runs only while hunting with a saved spot and no target, and combat, loot
// and party support always take over first. The plain return-to-centre behaviour stays when it is off.
const SEARCH_CARDINALS = [[0, 1], [1, 0], [-1, 0], [0, -1]]; // (dx, dz): north, east, west, south
// A point offset from p in world space, keeping it inside the world. Dungeons use plain local
// coordinates; outdoors a waypoint past a sector edge moves into the neighbouring region.
function searchOffset(p, dx, dz) {
  if (!p) return null;
  if (p.regionId & DUNGEON) return { regionId: p.regionId, x: p.x + dx, z: p.z + dz, y: p.y };
  let X = (p.regionId & 255) * SECTOR + p.x + dx;
  let Z = (p.regionId >>> 8) * SECTOR + p.z + dz;
  X = clamp(X, 0, 255 * SECTOR + SECTOR - 1);
  Z = clamp(Z, 0, 127 * SECTOR + SECTOR - 1);
  const rx = Math.floor(X / SECTOR), rz = Math.floor(Z / SECTOR);
  return { regionId: (rz << 8) | rx, x: X - rx * SECTOR, z: Z - rz * SECTOR, y: p.y };
}
const Search = {
  step: 0,        // 0..7: N, C, E, C, W, C, S, C
  waypoint: null, // the current destination, cached once per step
  reset() { this.step = 0; this.waypoint = null; },
  on(H) { return !!H.search?.enabled && H.attack !== false && !!H.center; },
  // How close is "arrived": large enough not to chase a rounding error, small enough to actually
  // cover the edges, and never larger than a fifth of the hunt radius.
  arrival(H) { return Math.max(40, Math.min(300, H.radius * 0.2)); },
  range(H) { return H.radius * clamp(H.search?.range ?? 90, 20, 100) / 100; },
  dest(H) {
    if (!H.center) return null;
    const out = this.step % 2 === 0, [dx, dz] = SEARCH_CARDINALS[this.step >> 1];
    const d = out ? this.range(H) : 0;
    return searchOffset(H.center, dx * d, dz * d);
  },
  // Called from Hunt.tick when there is no target. Moves toward the current sweep waypoint, or hands
  // back to the plain return-to-centre behaviour when the sweep is off.
  tick(hunt) {
    const H = hunt.cfg(), pose = World.pose(), center = H.center;
    if (!pose || !center) return;
    const dC = dist2D(pose, center);
    let dest = null;
    if (this.on(H)) {
      if (!this.waypoint) this.waypoint = this.dest(H);
      const wp = this.waypoint;
      if (!wp) return;
      if (dist2D(pose, wp) <= this.arrival(H)) {
        // Reached a sweep leg: real movement progress, so the anti-stuck watchdog starts afresh.
        AntiStuck.idleMs = 0;
        this.step = (this.step + 1) % 8;
        this.waypoint = this.dest(H);
        return;
      }
      dest = wp;
    } else if (H.returnToCenter && dC > Math.max(40, H.radius * 0.5)) {
      dest = center;
    }
    if (!dest) return;
    // A character far outside the hunting area (dead at login, woke in town): the town cycle's own
    // trip (services, then reverse or walk) returns it instead of a blind walk across the map.
    if (dC > Math.max(H.radius * 1.5, 600) && Controller.townReturn()) return;
    if (!Number.isFinite(dC)) return hunt.stop('hunt area is in another region');
    if (Cmd.move(dest)) hunt.lastMoveAt = now();
    if (!this.on(H)) hunt.state = 'return'; // the sweep keeps the caller's 'search' state
  },
};
