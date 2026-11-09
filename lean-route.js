// Long-range route graph from converted navigation data (lean-navdata-index.js).
// It selects the corridor only. Every step is still walked with Navigation over
// the game's own collision window, which remains the authority for doors,
// objects and the final approach. No route is a normal result: the caller then
// falls back to the leg chaining in WalkBack.
const ROUTE_PAD = 800;        // internal units outside an area's bounds still snap
const ROUTE_SNAP = 900;       // farthest start/end snap to a graph node
const ROUTE_REACH_SNAP = 3000; // the same for reach(): a hunting spot can sit in open ground far from the corridors
const ROUTE_SPACING = 150;    // thinned waypoint spacing
const ROUTE_SEGMENT = 450;    // never skip a longer gap, so local A* stays cheap
const ROUTE_VISITED = 150000;

const Route = {
  areas: typeof NAVDATA_AREAS !== 'undefined' ? NAVDATA_AREAS : [],
  base: typeof NAVDATA_BASE !== 'undefined' ? NAVDATA_BASE : '',
  cache: new Map(), loading: new Map(), dbp: null, loader: null, message: '',
  // Edges the game's collision does not walk (lean-route-check.js), per area, for this session: 'from>to' both ways.
  banned: new Map(),
  setAreas(list) { this.areas = Array.isArray(list) ? list : []; this.cache.clear(); this.loading.clear(); this.banned.clear(); this.message = ''; },
  bans(name) { if (!this.banned.has(name)) this.banned.set(name, new Set()); return this.banned.get(name); },
  ban(name, a, b) { this.bans(name).add(a + '>' + b).add(b + '>' + a); },
  setLoader(fn) { this.loader = typeof fn === 'function' ? fn : null; },
  absolute(p) {
    return p ? { x: (p.regionId & 255) * SECTOR + p.x, z: (p.regionId >>> 8) * SECTOR + p.z } : null;
  },
  areaFor(point) {
    const at = this.absolute(point);
    if (!at) return null;
    let best = null, inside = false;
    for (const area of this.areas) {
      if (area.dungeon || !(area.nodes > 0)) continue;
      if (at.x < area.minX - ROUTE_PAD || at.x > area.maxX + ROUTE_PAD ||
          at.z < area.minZ - ROUTE_PAD || at.z > area.maxZ + ROUTE_PAD) continue;
      const within = at.x >= area.minX && at.x <= area.maxX && at.z >= area.minZ && at.z <= area.maxZ;
      if (!best || within && !inside || within === inside && area.nodes > best.nodes) { best = area; inside = within; }
    }
    return best;
  },
  // Prefer one area that covers both ends; picking independently can select
  // overlapping areas A and B for the two ends when A alone covers both.
  commonArea(from, to) {
    const a = this.absolute(from), b = this.absolute(to);
    if (!a || !b) return null;
    const covers = (area, p) => p.x >= area.minX - ROUTE_PAD && p.x <= area.maxX + ROUTE_PAD &&
      p.z >= area.minZ - ROUTE_PAD && p.z <= area.maxZ + ROUTE_PAD;
    let best = null;
    for (const area of this.areas) {
      if (area.dungeon || !(area.nodes > 0) || !covers(area, a) || !covers(area, b)) continue;
      if (!best || area.nodes > best.nodes) best = area;
    }
    return best;
  },
  async ensure(from, to) {
    const area = this.commonArea(from, to);
    if (!area) { this.message = 'No route data covers both the character and the hunting spot.'; return false; }
    try {
      await this.load(area.name);
      return this.cache.has(area.name);
    } catch (e) {
      this.message = e?.message || 'Route data unavailable.';
      return false;
    }
  },
  load(name) {
    if (this.cache.has(name)) return Promise.resolve(this.cache.get(name));
    if (this.loading.has(name)) return this.loading.get(name);
    const meta = this.areas.find(a => a.name === name);
    if (!meta) return Promise.reject(Error('Unknown route area.'));
    const job = (async () => {
      const key = name + ':' + (meta.rev || VERSION), cached = await this.cached(key);
      let buffer = cached;
      if (!buffer) {
        buffer = await this.fetch(meta);
        if (buffer) this.put(key, buffer);
      }
      if (!buffer) throw Error('Route data unavailable.');
      let area;
      try { area = this.decode(buffer, meta); }
      catch (e) { await this.drop(key); throw e; }
      this.cache.set(name, area);
      return area;
    })();
    this.loading.set(name, job);
    job.then(() => this.loading.delete(name), () => this.loading.delete(name));
    return job;
  },
  fetch(meta) {
    if (this.loader) return Promise.resolve(this.loader(meta.name));
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const url = this.base + meta.file + '?v=' + (meta.rev || VERSION);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 12000) : 0;
    return fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller?.signal })
      .then(response => response.ok ? response.arrayBuffer() : null)
      .catch(() => null)
      .finally(() => { if (timer) clearTimeout(timer); });
  },
  db() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(Error('No route cache.'));
      let request;
      try { request = indexedDB.open('nixxane-navdata', 1); } catch (e) { return reject(e); }
      request.onupgradeneeded = () => { try { request.result.createObjectStore('areas'); } catch {} };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || Error('No route cache.'));
    });
    this.dbp.catch(() => {});
    return this.dbp;
  },
  async cached(key) {
    try {
      const db = await this.db();
      return await new Promise((resolve, reject) => {
        const request = db.transaction('areas', 'readonly').objectStore('areas').get(key);
        request.onsuccess = () => resolve(request.result instanceof ArrayBuffer ? request.result : null);
        request.onerror = () => reject(request.error);
      });
    } catch { return null; }
  },
  async put(key, buffer) {
    try {
      const db = await this.db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('areas', 'readwrite');
        tx.objectStore('areas').put(buffer, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {}
  },
  async drop(key) {
    try {
      const db = await this.db();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('areas', 'readwrite');
        tx.objectStore('areas').delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {}
  },
  decode(buffer, meta = null) {
    if (ArrayBuffer.isView(buffer)) buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    else if (!(buffer instanceof ArrayBuffer)) buffer = buffer?.buffer || buffer;
    if (!buffer || buffer.byteLength < 24) throw Error('Route data is too short.');
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== 'NVL1' || view.getUint8(4) !== 1) throw Error('Unsupported route data.');
    const flags = view.getUint8(5), originX = view.getInt32(8, true), originZ = view.getInt32(12, true);
    const count = view.getUint32(16, true), arcs = view.getUint32(20, true);
    const nodesAt = 24, offsetsAt = nodesAt + count * 6, arcsAt = offsetsAt + (count + 1) * 4;
    if (count < 1 || arcsAt + arcs * 2 !== buffer.byteLength) throw Error('Route data size mismatch.');
    const x = new Int32Array(count), z = new Int32Array(count), y = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = originX + view.getInt16(nodesAt + i * 6, true) * 10;
      z[i] = originZ + view.getInt16(nodesAt + i * 6 + 2, true) * 10;
      y[i] = view.getInt16(nodesAt + i * 6 + 4, true);
    }
    const offsets = new Uint32Array(count + 1);
    for (let i = 0; i <= count; i++) offsets[i] = view.getUint32(offsetsAt + i * 4, true);
    if (offsets[0] !== 0 || offsets[count] !== arcs) throw Error('Route data offsets are invalid.');
    for (let i = 0; i < count; i++) if (offsets[i] > offsets[i + 1]) throw Error('Route data offsets are invalid.');
    const neighbours = new Uint16Array(arcs);
    for (let i = 0; i < arcs; i++) {
      const value = view.getUint16(arcsAt + i * 2, true);
      if (value >= count) throw Error('Route data neighbour out of range.');
      neighbours[i] = value;
    }
    return { name: meta?.name || '', file: meta?.file || '', count, x, z, y, offsets, neighbours, dungeon: !!(flags & 1) };
  },
  // One route area, as a typed-array graph. Cross-area travel is deliberately
  // left to the leg fallback: separate route areas can touch in their bounding
  // boxes without sharing walkable nodes.
  graph(area) {
    const count = area.count;
    return { count, x: area.x, z: area.z, y: area.y, offsets: area.offsets, neighbours: area.neighbours };
  },
  nearest(graph, x, z, radius = ROUTE_SNAP) {
    let best = -1, score = radius * radius;
    for (let i = 0; i < graph.count; i++) {
      const dx = graph.x[i] - x, dz = graph.z[i] - z, d = dx * dx + dz * dz;
      if (d < score) { score = d; best = i; }
    }
    return best < 0 ? null : { node: best, distance: Math.sqrt(score) };
  },
  astar(graph, start, goal, banned = null) {
    const count = graph.count, score = new Float64Array(count).fill(Infinity), came = new Int32Array(count).fill(-1);
    const closed = new Uint8Array(count), heap = [];
    const h = i => Math.hypot(graph.x[i] - graph.x[goal], graph.z[i] - graph.z[goal]);
    const push = (node, f) => {
      heap.push({ node, f });
      let i = heap.length - 1;
      while (i) {
        const parent = (i - 1) >> 1;
        if (heap[parent].f <= heap[i].f) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = i * 2 + 1, right = left + 1;
          let next = i;
          if (left < heap.length && heap[left].f < heap[next].f) next = left;
          if (right < heap.length && heap[right].f < heap[next].f) next = right;
          if (next === i) break;
          [heap[i], heap[next]] = [heap[next], heap[i]];
          i = next;
        }
      }
      return top.node;
    };
    score[start] = 0;
    push(start, h(start));
    let visited = 0;
    while (heap.length && visited < ROUTE_VISITED) {
      const node = pop();
      if (closed[node]) continue;
      closed[node] = 1;
      visited++;
      if (node === goal) {
        const path = [];
        for (let at = goal; at >= 0; at = came[at]) path.push(at);
        path.reverse();
        return path;
      }
      for (let k = graph.offsets[node]; k < graph.offsets[node + 1]; k++) {
        const next = graph.neighbours[k];
        if (closed[next] || banned?.has(node + '>' + next)) continue;
        const step = Math.hypot(graph.x[next] - graph.x[node], graph.z[next] - graph.z[node]) +
          Math.min(Math.abs(graph.y[next] - graph.y[node]), 200) * .25;
        const value = score[node] + step;
        if (value < score[next]) { score[next] = value; came[next] = node; push(next, value + h(next)); }
      }
    }
    return null;
  },
  // Walking distance through a loaded route area from one point to any other point in it: a function of the other point
  // that gives the distance, Infinity when no path joins them (or the point has no route node near it although the area's
  // box holds it: then it lies across a river or a cliff from this area's walkable ground), or null when the point is
  // outside the area's box. One Dijkstra over the area per call. Travel weighs a walk against a ferry with it: an area's
  // box can hold both banks of a river, joined only the long way round or not at all.
  // meta defaults to from's own area. null when from itself has no route node near it or the area is not loaded.
  reach(from, meta = this.areaFor(from)) {
    const area = meta && this.cache.get(meta.name), here = this.absolute(from);
    if (!area || !here) return null;
    const graph = this.graph(area), start = this.nearest(graph, here.x, here.z, ROUTE_REACH_SNAP);
    if (!start) return null;
    const banned = this.banned.get(meta.name), dist = new Float64Array(graph.count).fill(Infinity), heap = [];
    const push = (d, node) => {
      heap.push([d, node]);
      for (let i = heap.length - 1; i;) { const up = (i - 1) >> 1; if (heap[up][0] <= heap[i][0]) break; [heap[up], heap[i]] = [heap[i], heap[up]]; i = up; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
        }
      }
      return top;
    };
    dist[start.node] = 0; push(0, start.node);
    while (heap.length) {
      const [d, node] = pop();
      if (d > dist[node]) continue;
      for (let k = graph.offsets[node]; k < graph.offsets[node + 1]; k++) {
        const next = graph.neighbours[k];
        if (banned?.has(node + '>' + next)) continue;
        const value = d + Math.hypot(graph.x[next] - graph.x[node], graph.z[next] - graph.z[node]);
        if (value < dist[next]) { dist[next] = value; push(value, next); }
      }
    }
    const covers = p => p.x >= meta.minX - ROUTE_PAD && p.x <= meta.maxX + ROUTE_PAD && p.z >= meta.minZ - ROUTE_PAD && p.z <= meta.maxZ + ROUTE_PAD;
    return to => {
      const there = this.absolute(to);
      if (!there || !covers(there)) return null;
      const end = this.nearest(graph, there.x, there.z, ROUTE_REACH_SNAP);
      return end ? dist[end.node] + start.distance + end.distance : Infinity;
    };
  },
  pose(x, z, y) {
    const rx = Math.floor(x / SECTOR), rz = Math.floor(z / SECTOR);
    if (rx < 0 || rx > 255 || rz < 0 || rz > 127) return null;
    return { regionId: (rz << 8) | rx, x: x - rx * SECTOR, y, z: z - rz * SECTOR };
  },
  thin(graph, path, y) {
    const points = [], length = { value: 0 };
    let last = 0;
    const add = position => {
      const index = path[position];
      const point = this.pose(graph.x[index], graph.z[index], y);
      if (point) points.push(point);
      last = position;
    };
    if (path.length) add(0);
    for (let i = 1; i < path.length - 1; i++) {
      const a = path[last], b = path[i], c = path[i + 1];
      const straight = Math.hypot(graph.x[c] - graph.x[a], graph.z[c] - graph.z[a]);
      const turn = Math.abs(Math.atan2(graph.z[c] - graph.z[b], graph.x[c] - graph.x[b]) -
        Math.atan2(graph.z[b] - graph.z[a], graph.x[b] - graph.x[a]));
      if (straight >= ROUTE_SPACING && (straight >= ROUTE_SEGMENT || turn > .35)) add(i);
    }
    if (path.length > 1) add(path.length - 1);
    for (let i = 1; i < points.length; i++) length.value += dist2D(points[i - 1], points[i]);
    return { points, length: length.value };
  },
  // The corridor, checked against the game's collision first where the asset worker is known (lean-route-check.js).
  // An edge it cannot walk is banned, so the plan below already goes around it.
  async checked(from, to) {
    if (!await this.ensure(from, to)) return null;
    const meta = this.commonArea(from, to), area = meta && this.cache.get(meta.name);
    let checked = false;
    if (area && RouteCheck.available()) {
      const graph = this.graph(area), here = this.absolute(from), there = this.absolute(to);
      const start = this.nearest(graph, here.x, here.z), end = this.nearest(graph, there.x, there.z);
      if (start && end && start.node !== end.node) checked = await RouteCheck.verify(meta.name, graph, start.node, end.node) !== null;
    }
    const plan = this.plan(from, to);
    if (!plan && checked) this.message = 'No corridor in the route data walks on the game map.';
    return plan;
  },
  // null means "use the leg fallback"; it is not an error.
  plan(from, to) {
    this.message = '';
    if (!from || !to || ((from.regionId | to.regionId) & DUNGEON)) return null;
    const a = this.commonArea(from, to);
    if (!a) { this.message = 'No route data covers both the character and the hunting spot.'; return null; }
    const first = this.cache.get(a.name);
    if (!first) return null;
    const graph = this.graph(first);
    const here = this.absolute(from), there = this.absolute(to);
    const start = this.nearest(graph, here.x, here.z), end = this.nearest(graph, there.x, there.z);
    if (!start || !end) { this.message = 'No route node near the character or the hunting spot.'; return null; }
    if (start.node === end.node) return null;
    const path = this.astar(graph, start.node, end.node, this.banned.get(a.name));
    if (!path) { this.message = 'No walkable path in the route data.'; return null; }
    const thinned = this.thin(graph, path, from.y);
    if (!thinned.points.length) return null;
    return { source: 'navdata', area: a.name, points: thinned.points, length: thinned.length,
      nodes: path.length, snap: Math.max(start.distance, end.distance) };
  },
};
