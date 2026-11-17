// Outdoor routing over the collision product already admitted by the game.
// A 20-unit A* grid respects blocked terrain, object walls and linked portals.
// Every route is then checked with the game's own clipper, and planned with it
// where the flat grid is wrong (lean-clip-route.js).
// Native movement remains the final authority for height and collision response.
const STALL_MS = 2500;      // standing still this long while moves are sent counts as a stall
const STALL_TRIES = 4;      // sidesteps tried at one spot before the walk gives up
const AVOID_AHEAD = 36;     // the suspected obstacle sits this far ahead of the stalled character
const AVOID_RADIUS = 28;    // and is kept out of the next route by this much
const AVOID_MS = 45000;
const FLAT_NODES_WITH_CLIPPER = 2500;  // flat A* budget when the clipper can take over
const Navigation = {
  scene: null, revision: 0, error: '', avoidNow: null, missingSince: 0, missingAt: 0,
  bytes(value, size) {
    const raw = atob(value), out = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (out.length !== size) throw Error('Invalid navigation grid');
    return out;
  },
  capture(command) {
    const c = command?.command || command;
    if (c?.kind !== 'navigation') return;
    try { this.install(c.bundle); } catch (e) { this.scene = null; this.error = e.message; ClipRoute.reset(); Log.warn('Walk-back navigation: ' + e.message); }
  },
  install(product) {
    if (!product?.complete || (product.regionId & DUNGEON)) throw Error('Outdoor collision data required');
    const nav = product.navmesh;
    if (nav?.tileSize !== 20 || nav.regionSize !== SECTOR || nav.tilesPerAxis !== 96) throw Error('Unsupported collision data');
    const scene = { regionId: product.regionId, grids: new Map(), walls: new Map() };
    for (const row of nav.regions || []) {
      if (Math.abs(row.dx) > 1 || Math.abs(row.dz) > 1) throw Error('Invalid collision coverage');
      scene.grids.set(row.dx + ',' + row.dz, { blocked: this.bytes(row.blockedTiles, 9216),
        cells: new DataView(this.bytes(row.tileCellIds, 36864).buffer), count: row.cells.count });
    }
    const add = wall => {
      const minX = Math.floor((Math.min(wall[0], wall[2]) - 2) / 80), maxX = Math.floor((Math.max(wall[0], wall[2]) + 2) / 80);
      const minZ = Math.floor((Math.min(wall[1], wall[3]) - 2) / 80), maxZ = Math.floor((Math.max(wall[1], wall[3]) + 2) / 80);
      if ((maxX - minX + 1) * (maxZ - minZ + 1) > 10000) throw Error('Oversized collision wall');
      for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
        const key = x + ',' + z;
        if (!scene.walls.has(key)) scene.walls.set(key, []);
        scene.walls.get(key).push(wall);
      }
    };
    for (const p of product.objects || []) {
      const m = p.mesh;
      if (!m || m.passThrough) continue;
      if (p.terrainCells && !p.terrainCells.length) continue;
      const linked = new Set((p.links || []).map(l => l.edge));
      const vertex = id => {
        const x = m.vertices[id * 3], z = m.vertices[id * 3 + 2], c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        return [c * x - s * z + p.x, s * x + c * z + p.z];
      };
      for (let i = 0; i < m.edges.length; i += 6) {
        const outline = m.edges[i + 5] === 0, flags = m.edges[i + 4];
        // Native terrain contact ignores open outlines, terrain-owned surface
        // borders (0x10) and internal edges of terrain-indexed placements.
        if (outline && flags === 0) continue;
        if (p.terrainCells && (!outline || (flags & 0x10))) continue;
        if (outline && (flags & 8) && linked.has(i / 6)) continue;
        if (!outline && !(flags & 3)) continue;
        const wall = [...vertex(m.edges[i]), ...vertex(m.edges[i + 1])];
        // Flags 1/2 block one approach side only. Preserve source-cell winding
        // so an allowed exit from a town object is not turned into an enclosure.
        if (!(flags & 8) && (flags & 3) !== 3 && (flags & 3) && m.cells) {
          const ids = Array.from(m.cells.slice(m.edges[i + 2] * 3, m.edges[i + 2] * 3 + 3));
          if (ids.length === 3) {
            const points = ids.map(vertex);
            wall.push(flags, points.reduce((n, p) => n + p[0], 0) / 3, points.reduce((n, p) => n + p[1], 0) / 3);
          }
        }
        add(wall);
      }
    }
    this.scene = scene; this.error = ''; this.revision++; this.missingSince = 0;
    ClipRoute.install(product);
  },
  local(p) {
    const d = regionDelta({ regionId: this.scene.regionId, x: 0, z: 0 }, p);
    return d && { x: d[0], z: d[1] };
  },
  pose(p, y) {
    const sx = Math.floor(p.x / SECTOR), sz = Math.floor(p.z / SECTOR);
    return { regionId: ((this.scene.regionId & 255) + sx) | (((this.scene.regionId >>> 8) + sz) << 8),
      x: p.x - sx * SECTOR, z: p.z - sz * SECTOR, y };
  },
  open(x, z) {
    const sx = Math.floor(x / SECTOR), sz = Math.floor(z / SECTOR), grid = this.scene.grids.get(sx + ',' + sz);
    if (!grid) return false;
    if (this.avoidNow) for (const a of this.avoidNow) if (Math.hypot(x - a.x, z - a.z) < a.r) return false;
    const tx = Math.floor((x - sx * SECTOR) / 20), tz = Math.floor((z - sz * SECTOR) / 20), i = tz * 96 + tx;
    return !grid.blocked[i] && grid.cells.getUint32(i * 4, true) < grid.count;
  },
  nearSegment(p, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z, n = dx * dx + dz * dz;
    const t = n ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / n, 0, 1) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
  },
  clear(a, b, departing = false) {
    const length = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.max(1, Math.ceil(length / 8));
    let reachedOpen = this.open(a.x, a.z);
    for (let i = 1; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * i / steps, z = a.z + (b.z - a.z) * i / steps;
      if (!this.covered(x, z)) return false;
      if (this.open(x, z)) reachedOpen = true;
      else if (!departing || reachedOpen) return false;
    }
    if (!reachedOpen) return false;
    const minX = Math.floor((Math.min(a.x, b.x) - 2) / 80), maxX = Math.floor((Math.max(a.x, b.x) + 2) / 80);
    const minZ = Math.floor((Math.min(a.z, b.z) - 2) / 80), maxZ = Math.floor((Math.max(a.z, b.z) + 2) / 80);
    const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    const seen = new Set();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) for (const w of this.scene.walls.get(x + ',' + z) || []) {
      if (seen.has(w)) continue; seen.add(w);
      const c = { x: w[0], z: w[1] }, d = { x: w[2], z: w[3] };
      if (w.length > 4) {
        const side = cross(c, d, { x: w[5], z: w[6] }), approach = cross(c, d, a) || -cross(c, d, b);
        if (Math.abs(side) > 1e-9 && !(approach * side > 0 ? w[4] & 2 : w[4] & 1)) continue;
      }
      const intersects = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
      if (intersects || Math.min(this.nearSegment(a, c, d), this.nearSegment(b, c, d), this.nearSegment(c, a, b), this.nearSegment(d, a, b)) < 2) return false;
    }
    return true;
  },
  plan(from, to, arrivalRadius = 0, options = {}) {
    if (!this.scene || (from.regionId | to.regionId) & DUNGEON) return null;
    const start = this.local(from), goal = this.local(to);
    // Spots a stalled walk bumped into are kept out of the route, but never the start itself.
    const avoid = (options.avoid || []).map(a => ({ ...this.local(a), r: a.r })).filter(a => Number.isFinite(a.x) && start && Math.hypot(a.x - start.x, a.z - start.z) >= a.r);
    // The clipper is already searching this way between frames: no flat search again.
    if (options.clip !== false && ClipRoute.ready && Number.isFinite(from.y) && ClipRoute.busy(from, to, arrivalRadius, avoid)) {
      return ClipRoute.plan(from, to, arrivalRadius, avoid);
    }
    this.avoidNow = avoid.length ? avoid : null;
    // With the clipper behind it, the flat search stays short: a way it does not find
    // quickly is searched by the clipper, in slices, instead of in one long freeze.
    const clipping = options.clip !== false && ClipRoute.ready && Number.isFinite(from.y);
    const flat = clipping ? { ...options, maxNodes: Math.min(options.maxNodes ?? Infinity, FLAT_NODES_WITH_CLIPPER) } : options;
    let route;
    try { route = this.planLocal(from, to, start, goal, arrivalRadius, flat); } finally { this.avoidNow = null; }
    // The clipper checks the flat route and plans where the flat grid is wrong. A flat
    // route it stops is never walked: it would run into a wall. Callers that plan often
    // (pursuit, detour candidates) keep the flat grid alone: options.clip false.
    if (options.clip === false || !ClipRoute.ready || !Number.isFinite(from.y) || !goal || !this.covered(goal.x, goal.z)) return route;
    if (route?.length && ClipRoute.walks(from, route)) return route;
    return ClipRoute.plan(from, to, arrivalRadius, avoid);
  },
  planLocal(from, to, start, goal, arrivalRadius, options) {
    if (!start || !goal || !this.open(start.x, start.z)) return null;
    if (Math.hypot(goal.x - start.x, goal.z - start.z) < 1800 && this.clear(start, goal)) return [to];
    const key = p => p.x + ',' + p.z, center = p => ({ x: p.x * 20 + 10, z: p.z * 20 + 10 });
    const h = p => Math.hypot(center(p).x - goal.x, center(p).z - goal.z) / 20;
    const first = { x: Math.floor(start.x / 20), z: Math.floor(start.z / 20), g: 0, parent: null };
    first.f = h(first); const scores = new Map([[key(first), 0]]), closed = new Set(), heap = [];
    const push = p => { heap.push(p); let i = heap.length - 1; while (i) { const parent = (i - 1) >> 1; if (heap[parent].f <= p.f) break; heap[i] = heap[parent]; i = parent; } heap[i] = p; };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { let i = 0; while (i * 2 + 1 < heap.length) { let c = i * 2 + 1; if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++; if (last.f <= heap[c].f) break; heap[i] = heap[c]; i = c; } heap[i] = last; }
      return top;
    };
    push(first); let best = first, reached = false;
    let visited = 0;
    for (; heap.length && visited < (options.maxNodes ?? 60000); visited++) {
      const p = pop(), k = key(p); if (closed.has(k)) continue; closed.add(k);
      if (h(p) < h(best)) best = p;
      const a = p === first ? start : center(p);
      if (Math.hypot(a.x - goal.x, a.z - goal.z) <= arrivalRadius) { best = p; reached = true; break; }
      if (h(p) < 2 && this.clear(a, goal)) { best = p; reached = true; break; }
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
        const q = { x: p.x + dx, z: p.z + dz, g: p.g + Math.hypot(dx, dz), parent: p }, b = center(q), qk = key(q);
        if (closed.has(qk) || q.g >= (scores.get(qk) ?? Infinity) || !this.clear(a, b)) continue;
        if (dx && dz && (!this.open(a.x + dx * 20, a.z) || !this.open(a.x, a.z + dz * 20))) continue;
        q.f = q.g + h(q); scores.set(qk, q.g); push(q);
      }
    }
    if (options.result) { options.result.limited = !reached && heap.length > 0; options.result.visited = visited; }
    const goalCovered = this.scene.grids.has(Math.floor(goal.x / SECTOR) + ',' + Math.floor(goal.z / SECTOR));
    if (!reached && (goalCovered || h(first) - h(best) < 2)) return [];
    const path = []; for (let p = best; p && p !== first; p = p.parent) path.push(center(p)); path.reverse();
    if (reached && (!arrivalRadius || Math.hypot(center(best).x - goal.x, center(best).z - goal.z) > arrivalRadius)) path.push(goal);
    // Smooth only segments whose terrain and object collision checks both pass.
    const result = []; let anchor = start;
    for (let i = 0; i < path.length;) {
      let j = i; while (j + 1 < path.length && Math.hypot(path[j + 1].x - anchor.x, path[j + 1].z - anchor.z) < (options.maxChord ?? 600) && this.clear(anchor, path[j + 1])) j++;
      result.push(this.pose(path[j], from.y)); anchor = path[j]; i = j + 1;
    }
    return result;
  },
  // The game publishes collision data only for the 3x3 regions around the
  // character, so a long walk is planned in short legs. A point on the straight
  // line towards the goal is kept inside the loaded window; walking to it
  // crosses a region border, which makes the game publish the next window.
  legPoint(from, to, length) {
    if (!this.scene) return null;
    const delta = regionDelta(from, to), start = this.local(from);
    const total = delta ? Math.hypot(delta[0], delta[1]) : Infinity;
    if (!start || !Number.isFinite(total) || total <= 0) return null;
    for (let reach = Math.min(length, total); reach >= 100; reach *= 0.5) {
      const local = { x: start.x + delta[0] / total * reach, z: start.z + delta[1] / total * reach };
      if (this.covered(local.x, local.z)) return this.pose(local, from.y);
    }
    return null;
  },
  // Nearest walkable grid tile around a blocked leg end, searched outwards.
  snap(point, radius = 240) {
    if (!this.scene) return null;
    const p = this.local(point);
    if (!p) return null;
    if (this.open(p.x, p.z)) return { ...point };
    for (let r = 20; r <= radius; r += 20) {
      const steps = Math.max(8, Math.ceil(2 * Math.PI * r / 20));
      for (let i = 0; i < steps; i++) {
        const angle = i * 2 * Math.PI / steps;
        const x = p.x + Math.cos(angle) * r, z = p.z + Math.sin(angle) * r;
        if (this.open(x, z)) return this.pose({ x, z }, point.y);
      }
    }
    return null;
  },
  // A blocked leg end is replaced by a snapped or slightly turned leg of the same
  // approximate length, so the next leg can continue towards the goal. Only a
  // route that really reaches the candidate is accepted.
  detour(from, goal, length, options = {}) {
    if (!this.scene) return null;
    const start = this.local(from), delta = regionDelta(from, goal);
    const total = delta ? Math.hypot(delta[0], delta[1]) : Infinity;
    if (!start || !Number.isFinite(total) || total <= 0) return null;
    const reach = Math.min(length, total), base = Math.atan2(delta[1], delta[0]);
    const point = angle => {
      const local = { x: start.x + Math.cos(angle) * reach, z: start.z + Math.sin(angle) * reach };
      return this.covered(local.x, local.z) ? this.pose(local, from.y) : null;
    };
    const candidates = [], straight = point(base);
    const snapped = straight && this.snap(straight, options.radius ?? 240);
    if (snapped) candidates.push(snapped);
    if (reach > 200) {
      const local = { x: start.x + Math.cos(base) * reach * .5, z: start.z + Math.sin(base) * reach * .5 };
      if (this.covered(local.x, local.z)) candidates.push(this.pose(local, from.y));
    }
    for (const turn of [.5, -.5, 1, -1, 1.5, -1.5]) {
      const turned = point(base + turn);
      if (turned) candidates.push(turned);
    }
    for (const candidate of candidates) {
      const route = this.plan(from, candidate, 0, { maxNodes: options.maxNodes ?? 20000, clip: false });
      if (route?.length && dist2D(route[route.length - 1], candidate) <= 15) return candidate;
    }
    return null;
  },
  // Stall watchdog shared by every walker that sends plain moves (WalkBack, Town, Restock). When the character has
  // not moved for a few seconds although moves were sent, the spot just ahead is remembered on the owner as
  // blocked, so next() routes around it; after a few tries at one place it reports 'giveup'. Returns '', 'recover'
  // or 'giveup'. Only normal moves are ever sent; nothing here moves the character.
  watch(owner, pose, sentAt, toward) {
    const t = now();
    let w = owner.stall;
    if (!w || t - w.seen > 1500) w = owner.stall = { pose: { ...pose }, at: t, seen: t, tries: 0, origin: null };
    w.seen = t;
    const moved = dist2D(w.pose, pose);
    if (!Number.isFinite(moved) || moved > 3) {
      if (w.origin && !(dist2D(w.origin, pose) < 100)) { w.tries = 0; w.origin = null; owner.avoid = []; }
      w.pose = { ...pose }; w.at = t;
      return '';
    }
    if (t - w.at < STALL_MS || sentAt < w.at) return '';
    w.at = t;
    if (w.tries >= STALL_TRIES) { w.tries = 0; w.origin = null; owner.avoid = []; return 'giveup'; }
    w.tries++; w.origin = w.origin || { ...pose };
    const delta = toward && regionDelta(pose, toward), length = delta ? Math.hypot(delta[0], delta[1]) : 0;
    if (length > 0) {
      const spot = { regionId: pose.regionId, x: pose.x + delta[0] / length * AVOID_AHEAD, z: pose.z + delta[1] / length * AVOID_AHEAD, r: AVOID_RADIUS, until: t + AVOID_MS };
      owner.avoid = [...(owner.avoid || []).filter(a => a.until > t), spot];
    }
    owner.travel = null;
    return 'recover';
  },
  stepOut(pose) {
    if (this.pointStatus(pose) !== 'blocked') return null;
    const strict = this.escapeCandidates(pose)[0];
    if (strict) return strict;
    const p = this.local(pose);
    for (let r = 20; r <= 160; r += 20) for (let i = 0; i < 16; i++) {
      const ux = Math.cos(i * Math.PI / 8), uz = Math.sin(i * Math.PI / 8);
      const to = this.pose({ x: p.x + ux * r, z: p.z + uz * r }, pose.y), ahead = { x: p.x + ux * 5, z: p.z + uz * 5 };
      if (this.pointStatus(to) === 'open' && !this.crosses(p, ahead) && this.clear(ahead, this.local(to), true)) return to;
    }
    return null;
  },
  crosses(a, b) {
    const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    for (let x = Math.floor((Math.min(a.x, b.x) - 2) / 80); x <= Math.floor((Math.max(a.x, b.x) + 2) / 80); x++)
      for (let z = Math.floor((Math.min(a.z, b.z) - 2) / 80); z <= Math.floor((Math.max(a.z, b.z) + 2) / 80); z++)
        for (const w of this.scene.walls.get(x + ',' + z) || []) {
          const c = { x: w[0], z: w[1] }, d = { x: w[2], z: w[3] };
          if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
        }
    return false;
  },
  // near: the destination only gives a direction (a walk-back leg end); reaching within
  // arrivalRadius of it is the plan, not a fallback.
  next(owner, destination, recorded = false, arrivalRadius = 0, near = false) {
    const pose = World.pose(), previous = owner.travel;
    if (!this.scene || (pose.regionId & DUNGEON)) {
      // A walker needs outdoor collision that is not there: Reconnect.watchCollision() reloads if it never comes.
      if (!this.scene && pose && !(pose.regionId & DUNGEON) && !recorded) { this.missingSince = this.missingSince || now(); this.missingAt = now(); }
      return recorded ? { point: destination } : { waiting: true, error: this.error || 'Waiting for game collision data. Reload the game if attached late, or record a walking route.' };
    }
    if (!previous || previous.revision !== this.revision || dist2D(previous.destination, destination) > 1 || previous.index >= previous.route.length) {
      const avoid = (owner.avoid || []).filter(a => a.until > now());
      const attempt = options => {
        if (near) return this.plan(pose, destination, arrivalRadius, options);
        let route = this.plan(pose, destination, 0, options);
        if (route && route !== CLIP_PENDING && !route.length && arrivalRadius > 0) route = this.plan(pose, destination, arrivalRadius, options);
        return route;
      };
      let route = attempt({ avoid });
      // The clipper is still searching, between frames: wait for it.
      if (route === CLIP_PENDING) return { waiting: true, planning: true, error: 'Finding a way through the game collision.' };
      // Avoided spots are only a hint: if they leave no route, walk the plain one rather than nothing.
      if (avoid.length && !route?.length) {
        route = attempt({});
        if (route === CLIP_PENDING) return { waiting: true, planning: true, error: 'Finding a way through the game collision.' };
      }
      if (!route?.length) {
        const out = this.stepOut(pose);
        if (out) { owner.travel = null; return { point: out, stepOut: true }; }
      }
      if (!route) return { waiting: true, error: 'Waiting for collision coverage at the current position.' };
      if (!route.length) return { error: 'No walkable route found through the loaded collision map.' };
      owner.travel = { destination: { ...destination }, route, index: 0, revision: this.revision };
    }
    const travel = owner.travel;
    while (travel.index < travel.route.length && dist2D(pose, travel.route[travel.index]) <= 7) travel.index++;
    return travel.index < travel.route.length ? { point: travel.route[travel.index] } : { waiting: true };
  },
};
Hook.observers.push(command => Navigation.capture(command));
