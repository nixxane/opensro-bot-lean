// Checks a navdata corridor (lean-route.js) against the game's own collision before it is walked.
// The converted navdata is another map's: here a slope it climbs can be a cliff (Hotan to the Karakoram
// aircraft dock climbs out of the crater where the rim is a wall). The game's asset worker builds the collision
// of any region on request, as it does for the region you stand in, and the game's clipper (lean-clipper.js)
// walks each corridor edge: a straight line first, else a small lattice search. An edge it cannot walk is left
// out of the area's graph (Route.ban) and the corridor is planned again, until every edge walks or none is left.
// The asset worker's address is seen when the game starts it (the worker hook) or, when the userscript ran too late
// for that, read from the page's own bootstrap module, which names it. Without it or the clipper the corridor is
// walked unchecked, as before, and the log says so.
const CHECK_CELL = 40;          // lattice cell, and the longest step checked in one clip
const CHECK_REACH = 60;         // an edge walks when its far end is reached within this
const CHECK_NODES = 1500;       // lattice search budget for an edge the straight line does not walk
const CHECK_AROUND = 400;       // the search stays this close to the edge: a longer way round is the graph's to find
const CHECK_SLICE_MS = 6;       // search time per slice; the game draws between slices
const CHECK_SLICE_IDLE_MS = 14;  // while the character only waits for this check, standing still: longer slices, a faster check
const CHECK_ROUNDS = 60;        // corridors tried before giving up
const CHECK_MS = 150000;        // whole check
const CHECK_REGIONS = 6;        // regions kept in memory
const CHECK_LOAD_MS = 30000;

const RouteCheck = {
  worker: null, queue: Promise.resolve(), regions: new Map(), message: '', locating: null,
  // Edges that walked, per area, for the whole session: the way from town to a spot is checked once, not on every trip.
  good: new Map(),
  bootstrap() { return W.document?.querySelector?.('script[type="module"][src*="/assets/"]')?.src || ''; },
  available() { return typeof NativeClipper !== 'undefined' && (!!Hook.assetUrl || !!this.bootstrap()); },
  locate() {
    if (Hook.assetUrl) return Promise.resolve(Hook.assetUrl);
    this.locating ||= (async () => {
      const src = this.bootstrap();
      if (!src) return '';
      const text = await (await W.fetch(src, { credentials: 'same-origin' })).text();
      const found = text.match(/new\s+Worker\(\s*new\s+URL\(\s*["']([^"']+)["'][^)]*\)\s*,\s*\{[^}]*name\s*:\s*["']sro-assets["']/);
      if (found) Hook.assetUrl = new URL(found[1], src).href;
      return Hook.assetUrl;
    })().catch(() => '').finally(() => { this.locating = null; });
    return this.locating;
  },
  // One region's collision, as the game's asset worker builds it (its 3x3 window), with a clipper installed on it.
  region(regionId) {
    if (this.regions.has(regionId)) {
      const hit = this.regions.get(regionId);
      this.regions.delete(regionId); this.regions.set(regionId, hit);
      return hit;
    }
    const job = this.load(regionId).then(product => {
      if (!product?.complete || product.regionId !== regionId) return null;
      const clipper = NativeClipper.createNavigation();
      clipper.install(product.regionId, product);
      return { regionId, clipper };
    }).catch(() => null);
    this.regions.set(regionId, job);
    while (this.regions.size > CHECK_REGIONS) this.regions.delete(this.regions.keys().next().value);
    return job;
  },
  // One request at a time: the worker's replies carry no request this code could match.
  load(regionId) {
    const job = this.queue.then(() => new Promise((resolve, reject) => {
      const worker = this.worker ||= new (Hook.NativeWorker || W.Worker)(Hook.assetUrl, { type: 'module', name: 'nix-collision' });
      const timer = setTimeout(() => done(null, Error('Region collision timed out.')), CHECK_LOAD_MS);
      const done = (product, error) => {
        clearTimeout(timer); worker.onmessage = null; worker.onerror = null;
        if (error) { worker.terminate(); if (this.worker === worker) this.worker = null; reject(error); } else resolve(product);
      };
      worker.onmessage = e => {
        if (e.data?.kind === 'navigation') done(e.data.product);
        else if (e.data?.kind === 'error') done(null, Error(String(e.data.error)));
      };
      worker.onerror = () => done(null, Error('Region collision worker failed.'));
      const path = '/assets/world/outdoor/regions/region-' + regionId.toString(16).padStart(4, '0') + '.json#' + regionId;
      worker.postMessage({ kind: 'request', id: 1, url: new URL(path, W.location.href).href, decode: 'navigation', limit: 128 << 20 });
    }));
    this.queue = job.catch(() => {});
    return job;
  },
  release() {
    this.regions.clear();
    this.worker?.terminate(); this.worker = null;
  },
  // Every edge of the corridor from start to goal walks, or false when no corridor does; null when the check could
  // not run. Bans stay for the area.
  async verify(area, graph, start, goal) {
    if (!await this.locate()) {
      Log.warn('Route check (beta): the game\'s asset loader was not found, so the route data is walked unchecked.');
      return null;
    }
    const walks = this.good.get(area) || new Set(), deadline = now() + CHECK_MS, before = Route.bans(area).size / 2;
    this.good.set(area, walks);
    let unknown = 0, result = false;
    try {
      for (let round = 0; round < CHECK_ROUNDS && now() < deadline; round++) {
        const path = Route.astar(graph, start, goal, Route.bans(area));
        if (!path) break;
        let blocked = false;
        for (let i = 0; i + 1 < path.length && now() < deadline; i++) {
          const u = path[i], v = path[i + 1];
          if (walks.has(u + '>' + v)) continue;
          this.message = 'checking the route against the game map (' + (i + 1) + '/' + (path.length - 1) + ')';
          const walk = await this.edge(graph, u, v);
          if (walk === false) { Route.ban(area, u, v); blocked = true; break; }
          if (walk === null) unknown++;
          walks.add(u + '>' + v);
        }
        if (!blocked) { result = now() < deadline; break; }
      }
      const left = Route.bans(area).size / 2 - before;
      Log.info('Route check (beta): ' + (result ? 'the corridor walks on the game map' : 'no corridor walks on the game map') +
        (left ? '; ' + left + ' step' + (left === 1 ? '' : 's') + ' left out' : '') + (unknown ? '; ' + unknown + ' without collision data' : '') + '.');
      return result;
    } finally { this.message = ''; this.release(); }
  },
  // true walks, false is blocked, null is unknown (no collision for that region): an unknown edge is walked as before.
  async edge(graph, u, v) {
    const from = Route.pose(graph.x[u], graph.z[u], graph.y[u]), to = Route.pose(graph.x[v], graph.z[v], graph.y[v]);
    if (!from || !to) return null;
    const region = await this.region(from.regionId);
    if (!region) return null;
    const c = region.clipper, origin = from.regionId;
    const rel = p => [((p.regionId & 255) - (origin & 255)) * SECTOR + p.x, ((p.regionId >>> 8 & 127) - (origin >>> 8 & 127)) * SECTOR + p.z];
    const at = (x, z, y) => {
      const rx = Math.floor(x / SECTOR), rz = Math.floor(z / SECTOR);
      return { regionId: ((origin >>> 8 & 127) + rz) << 8 | (origin & 255) + rx, x: x - rx * SECTOR, y, z: z - rz * SECTOR };
    };
    const step = (pose, x, z) => {
      const got = c.clip({ ...pose, angle: 0 }, { ...at(x, z, pose.y), angle: 0 }, { slide: false });
      if (!got) return null;
      const [gx, gz] = rel(got);
      return Math.hypot(gx - x, gz - z) <= 2 ? got : null;
    };
    const start = c.surface(from);
    if (!c.available(start)) return null;
    const [sx, sz] = rel(start), [tx, tz] = rel(to);
    // The straight line, in steps of at most one cell.
    const n = Math.max(1, Math.ceil(Math.hypot(tx - sx, tz - sz) / CHECK_CELL));
    let pose = start;
    for (let i = 1; i <= n && pose; i++) pose = step(pose, sx + (tx - sx) * i / n, sz + (tz - sz) * i / n);
    if (pose) return true;
    // A lattice search around whatever stands in the way, in slices.
    const search = this.search(step, rel, start, tx, tz);
    for (;;) {
      const started = performance.now();
      let result;
      const slice = WalkBack.active?.source === 'planning' ? CHECK_SLICE_IDLE_MS : CHECK_SLICE_MS;
      while ((result = search.next()).done === false && performance.now() - started < slice);
      if (result.done) return result.value;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  },
  *search(step, rel, start, gx, gz) {
    const key = (i, j, y) => i + ',' + j + ',' + Math.round(y / 12), h = (i, j) => Math.hypot(i * CHECK_CELL - gx, j * CHECK_CELL - gz);
    const [sx, sz] = rel(start), mx = (sx + gx) / 2, mz = (sz + gz) / 2;
    const near = (a, b) => Math.hypot(a * CHECK_CELL - mx, b * CHECK_CELL - mz) <= CHECK_AROUND;
    let i0 = Math.round(sx / CHECK_CELL), j0 = Math.round(sz / CHECK_CELL), first = null;
    // A corridor node can stand on a rock edge: join the lattice at any corner around it.
    for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      first = step(start, (i0 + di) * CHECK_CELL, (j0 + dj) * CHECK_CELL);
      if (first) { i0 += di; j0 += dj; break; }
    }
    if (!first) return false;
    const heap = [{ i: i0, j: j0, g: 0, f: h(i0, j0), pose: first }], closed = new Set(), scores = new Map();
    let expanded = 0;
    while (heap.length && expanded < CHECK_NODES) {
      yield;
      let m = 0;
      for (let k = 1; k < heap.length; k++) if (heap[k].f < heap[m].f) m = k;
      const node = heap[m];
      heap[m] = heap[heap.length - 1]; heap.pop();
      const k = key(node.i, node.j, node.pose.y);
      if (closed.has(k)) continue;
      closed.add(k); expanded++;
      if (h(node.i, node.j) <= CHECK_REACH) return true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const a = node.i + di, b = node.j + dj;
        if (!near(a, b)) continue;
        const pose = step(node.pose, a * CHECK_CELL, b * CHECK_CELL);
        if (!pose) continue;
        const kk = key(a, b, pose.y), cost = node.g + CHECK_CELL * Math.hypot(di, dj);
        if (closed.has(kk) || (scores.get(kk) ?? Infinity) <= cost) continue;
        scores.set(kk, cost);
        heap.push({ i: a, j: b, g: cost, f: cost + 1.5 * h(a, b), pose });
      }
    }
    return false;
  },
};
