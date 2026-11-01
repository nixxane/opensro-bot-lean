// Map page: the game's own minimap tiles on a canvas, with the hunting area, monsters, party and players.
// Outdoors only: positions become absolute units (region x * 1920 + x, region z * 1920 + z; Z grows north, drawn up).
// One minimap tile (minimap/<rx>x<rz>, 256 px) covers one 1920-unit region. Dungeons have no tiles here yet.
// The live game ships tiles as .texture (NTX1: DXT-compressed, decoded here); older builds as .png.
// It only reads game state; the one setting it changes is the hunting spot, and only when the player asks.
const MAP_ART = '/assets/images/Media_extracted/';
// Monster class colours, as the game's own map window draws them.
const MAP_CLASS_COLOR = { normal: '#e0e0e0', champion: '#7fb8ff', giant: '#ffd65a', party: '#ff9b4a', elite: '#c78bff', unique: '#ff5a5a', titan: '#ff3dd0' };
const LeanMap = {
  upp: 5, // world units per screen pixel (10 units = 1 m)
  view: null, follow: true, picked: null, canvas: null, info: null, timer: 0,
  tiles: new Map(), signs: new Map(),
  space(p) {
    const rid = Number(p?.regionId ?? p?.region);
    if (!isNum(rid) || !isNum(p.x) || !isNum(p.z) || rid & DUNGEON) return null;
    return { X: (rid & 255) * SECTOR + p.x, Z: (rid >>> 8) * SECTOR + p.z };
  },
  local(X, Z) {
    const rx = Math.floor(X / SECTOR), rz = Math.floor(Z / SECTOR);
    if (rx < 0 || rx > 255 || rz < 0 || rz > 127) return null;
    return { regionId: (rz << 8) | rx, x: X - rx * SECTOR, z: Z - rz * SECTOR };
  },
  // A tile or sign image, loaded once from the game's packs. Missing tiles (open sea) are remembered quietly.
  image(cache, path) {
    const hit = cache.get(path);
    if (hit) return hit.img;
    const entry = { img: null }; cache.set(path, entry);
    const load = cache === this.tiles ? this.tile(path) : Icons.request(path).then(blob => createImageBitmap(blob));
    load.then(img => { entry.img = img; this.dirty = true; }, e => {
      entry.missing = true;
      if (!/not found in the game packs/i.test(e?.message || '') && e?.message !== this.lastTileError) { this.lastTileError = e?.message; Log.warn('Map tile ' + path + ': ' + e?.message); }
    });
    if (cache === this.tiles && cache.size > 80) for (const [key, value] of cache) { if (cache.size <= 60) break; if (key !== path) { value.img?.close?.(); cache.delete(key); } }
    return null;
  },
  // A tile: the .texture the live game publishes, else the .png of older builds. Resolves to a drawable or null.
  async tile(path) {
    try { return await this.ntxImage(new Uint8Array(await (await Icons.request(path + '.texture')).arrayBuffer())); }
    catch (e) { if (!/not found in the game packs/i.test(e.message)) throw e; }
    const blob = await Icons.request(path + '.png');
    return createImageBitmap(blob);
  },
  // NTX1 header (20 bytes, little endian): magic, width, height, format (21 = BGRA, DXT1/3/5 four-cc), mip count;
  // then the mips, largest first. Only the first mip is drawn. Same layout as the game client's native textures.
  ntxImage(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || v.getUint32(0, true) !== 0x3158544e) throw Error('not a native texture');
    const w = v.getUint32(4, true), h = v.getUint32(8, true), code = v.getUint32(12, true);
    if (!w || !h || w > 2048 || h > 2048) throw Error('bad texture size');
    const out = new ImageData(w, h), px = out.data, blocks = { 0x31545844: 8, 0x33545844: 16, 0x35545844: 16 }[code];
    if (code === 21) {
      if (bytes.length < 20 + w * h * 4) throw Error('truncated texture');
      for (let i = 0; i < w * h * 4; i += 4) { px[i] = bytes[20 + i + 2]; px[i + 1] = bytes[20 + i + 1]; px[i + 2] = bytes[20 + i]; px[i + 3] = bytes[20 + i + 3]; }
      return createImageBitmap(out);
    }
    if (!blocks) throw Error('unsupported texture format');
    const cols = Math.ceil(w / 4), rows = Math.ceil(h / 4);
    if (bytes.length < 20 + cols * rows * blocks) throw Error('truncated texture');
    const pal = new Uint8Array(16);
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const at = 20 + (by * cols + bx) * blocks, color = at + (blocks === 16 ? 8 : 0);
      const c0 = v.getUint16(color, true), c1 = v.getUint16(color + 2, true), three = blocks === 8 && c0 <= c1;
      for (let k = 0; k < 2; k++) {
        const c = k ? c1 : c0, r = c >> 11, g = (c >> 5) & 63, b = c & 31;
        pal[k * 4] = (r << 3) | (r >> 2); pal[k * 4 + 1] = (g << 2) | (g >> 4); pal[k * 4 + 2] = (b << 3) | (b >> 2); pal[k * 4 + 3] = 255;
      }
      for (let ch = 0; ch < 3; ch++) {
        const a = pal[ch], b = pal[4 + ch];
        pal[8 + ch] = Math.floor(three ? (a + b) / 2 : (2 * a + b) / 3);
        pal[12 + ch] = three ? 0 : Math.floor((a + 2 * b) / 3);
      }
      pal[11] = 255; pal[15] = three ? 0 : 255;
      const sel = v.getUint32(color + 4, true);
      for (let p = 0; p < 16; p++) {
        const x = bx * 4 + (p & 3), y = by * 4 + (p >> 2);
        if (x >= w || y >= h) continue;
        const s = ((sel >>> (p * 2)) & 3) * 4, o = (y * w + x) * 4;
        px[o] = pal[s]; px[o + 1] = pal[s + 1]; px[o + 2] = pal[s + 2]; px[o + 3] = pal[s + 3];
        if (code === 0x33545844) px[o + 3] = ((bytes[at + (p >> 1)] >>> ((p & 1) * 4)) & 15) * 17;
        else if (code === 0x35545844) px[o + 3] = this.dxt5Alpha(bytes, at, p);
      }
    }
    return createImageBitmap(out);
  },
  dxt5Alpha(bytes, at, p) {
    const a0 = bytes[at], a1 = bytes[at + 1], bit = p * 3, byte = at + 2 + (bit >> 3);
    const s = ((bytes[byte] | ((bytes[byte + 1] ?? 0) << 8)) >>> (bit & 7)) & 7;
    if (s === 0) return a0;
    if (s === 1) return a1;
    if (a0 > a1) return Math.floor(((8 - s) * a0 + (s - 1) * a1) / 7);
    if (s === 6) return 0;
    if (s === 7) return 255;
    return Math.floor(((6 - s) * a0 + (s - 1) * a1) / 5);
  },
  sign(name) { return this.image(this.signs, MAP_ART + 'interface/minimap/mm_sign_' + name + '.png'); },
  draw(parent) {
    const box = UI.group('Map');
    box.classList.add('map-box');
    const stage = el('div', null, 'map-stage');
    this.canvas = el('canvas'); this.canvas.setAttribute('aria-label', 'Map of the hunting area');
    const zoomIn = UI.button('+', () => this.zoom(1 / 1.5)), zoomOut = UI.button('−', () => this.zoom(1.5));
    zoomIn.setAttribute('aria-label', 'Zoom in'); zoomOut.setAttribute('aria-label', 'Zoom out');
    this.followButton = UI.button('Follow me', () => { this.follow = true; this.view = null; this.dirty = true; });
    const tools = el('div', null, 'map-tools'); tools.append(zoomIn, zoomOut, this.followButton);
    this.coords = el('div', '', 'map-coords');
    stage.append(this.canvas, tools, this.coords);
    this.info = el('p', '', 'muted');
    this.pickRow = UI.row(UI.button('Make this the hunting spot', () => this.setCentre()), UI.button('Clear mark', () => { this.picked = null; this.dirty = true; this.render(); }));
    box.append(stage, this.info, this.pickRow);
    const H = () => Settings.profile.hunt;
    const saved = H().center && this.space(H().center) ? displayCoords(H().center) : null;
    this.spotX = el('input'); this.spotY = el('input');
    for (const [input, key] of [[this.spotX, 'x'], [this.spotY, 'y']]) {
      input.type = 'number'; input.step = '1'; input.value = saved ? saved[key] : '';
    }
    this.coordinateText = el('input'); this.coordinateText.type = 'text'; this.coordinateText.readOnly = true;
    this.coordinateText.placeholder = 'Get position';
    const spotHeader = el('div', null, 'map-spot-header');
    spotHeader.append(UI.button('Set actual position', () => {
      if (World.inWorld() && Hunt.setCenter()) { UI.toast('Hunting spot saved.'); this.dirty = true; }
    }));
    const spotFields = el('div', null, 'map-spot-fields');
    spotFields.append(UI.field('X', this.spotX), UI.field('Y', this.spotY), UI.button('Set spot', () => this.setCoordinates()));
    const current = el('div', null, 'map-current-position');
    current.append(UI.field('Current', this.coordinateText), UI.button('Get position', () => this.getCoordinates()), UI.button('Copy', () => { void this.copyCoordinates(); }));
    const coordinates = el('div', null, 'map-position');
    coordinates.append(spotHeader, spotFields, el('p', 'Outdoor X / Y coordinates in metres.', 'muted'), current);
    const spots = el('div', null, 'level-spots'), spotLevel = el('input');
    spotLevel.type = 'number'; spotLevel.min = '1'; spotLevel.max = '150'; spotLevel.step = '1';
    const drawSpots = () => {
      spots.textContent = '';
      for (const s of LevelSpot.list()) {
        const c = this.space(s.center) ? displayCoords(s.center) : null;
        spots.append(UI.row(el('span', 'From level ' + s.level + (c ? ': ' + c.x + ', ' + c.y : '')), UI.button('Remove', () => { LevelSpot.remove(s.level); drawSpots(); })));
      }
    };
    drawSpots();
    const levelSpots = UI.group('Spot by level',
      UI.check('Switch the hunting spot by level', () => Settings.profile.hunt.levelSpots.on, v => { Settings.profile.hunt.levelSpots.on = v; }),
      el('p', 'Set the hunting spot above, enter the level it is for, and press Save. The highest saved level at or below yours is used; the bot walks there when you level into a new one.', 'muted'),
      UI.row(UI.field('From level', spotLevel), UI.button('Save current spot', () => {
        const error = LevelSpot.add(Number(spotLevel.value));
        if (error) UI.toast(error, 'warn'); else { drawSpots(); UI.toast('Level spot saved.'); }
      })),
      spots);
    const area = UI.group('Hunting area',
      coordinates,
      UI.number('Hunt radius (m)', () => H().radius / 10, v => { H().radius = v * 10; this.dirty = true; }, 5, 200),
      UI.number('Chase distance (m)', () => H().chase / 10, v => { H().chase = v * 10; this.dirty = true; }, 10, 300));
    const legend = UI.group('Legend');
    for (const [name, label] of [['character', 'You'], ['party', 'Party member'], ['otherplayer', 'Other player'], ['monster', 'Monster'], ['unique', 'Unique'], ['npc', 'NPC'], ['animal', 'Pet']]) {
      const row = el('div', null, 'map-legend'), mark = el('i'); mark.dataset.sign = name;
      row.append(mark, el('span', label)); legend.append(row);
    }
    legend.append(el('p', 'Yellow circle: hunt radius. Dashed ring: chase distance. Click the map to mark a point, drag to move it, use + and − to zoom.', 'muted'));
    parent.append(box, area, levelSpots, legend);
    for (const mark of legend.querySelectorAll('i[data-sign]')) this.paintSign(mark, mark.dataset.sign);
    this.bind(); this.dirty = true; this.render();
    clearInterval(this.timer); this.timer = setInterval(() => this.tick(), 200);
  },
  paintSign(node, name) {
    Icons.url(MAP_ART + 'interface/minimap/mm_sign_' + name + '.png').then(url => { if (url && node.isConnected) node.style.backgroundImage = `url("${url}")`; });
  },
  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, view: this.view && { ...this.view }, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      const at = this.toWorld(e);
      const local = at && this.local(at.X, at.Z), shown = local && displayCoords(local);
      this.coords.textContent = shown ? `X ${shown.x} · Y ${shown.y}` : '';
      const d = this.drag;
      if (!d || !d.view) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) { this.follow = false; this.view = { X: d.view.X - dx * this.upp, Z: d.view.Z + dy * this.upp }; this.dirty = true; }
    });
    const up = e => {
      const d = this.drag; this.drag = null;
      if (!d || d.moved || e.type === 'pointercancel') return;
      const at = this.toWorld(e), local = at && this.local(at.X, at.Z);
      if (local) { this.picked = local; this.dirty = true; this.render(); }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.25 : 0.8); }, { passive: false });
  },
  toWorld(e) {
    if (!this.view) return null;
    const r = this.canvas.getBoundingClientRect();
    return { X: this.view.X + (e.clientX - r.left - r.width / 2) * this.upp, Z: this.view.Z - (e.clientY - r.top - r.height / 2) * this.upp };
  },
  zoom(f) { this.upp = clamp(this.upp * f, 1.5, 30); this.dirty = true; },
  getCoordinates() {
    const pose = World.inWorld() ? World.pose() : null;
    if (!this.space(pose)) { UI.toast('Current outdoor coordinates unavailable.', 'warn'); return null; }
    const coords = displayCoords(pose);
    this.spotX.value = coords.x; this.spotY.value = coords.y;
    const text = `X ${coords.x}, Y ${coords.y}`;
    this.coordinateText.value = text;
    return text;
  },
  async copyCoordinates() {
    const text = this.getCoordinates();
    if (!text) return;
    const input = this.coordinateText;
    try {
      await W.navigator.clipboard.writeText(text);
      UI.toast('Current coordinates copied.');
    } catch (_) {
      input.focus(); input.select();
      UI.toast('Clipboard unavailable. Copy the selected coordinates.', 'warn');
    }
  },
  setCoordinates() {
    const x = this.spotX.value.trim(), y = this.spotY.value.trim();
    const X = Number(x), Y = Number(y);
    const point = x && y && Number.isInteger(X) && Number.isInteger(Y) && this.local((X + 135 * 192) * 10, (Y + 92 * 192) * 10);
    if (!point) { UI.toast('Enter valid outdoor X / Y coordinates (whole metres).', 'warn'); return false; }
    if (!World.inWorld() || !this.space(World.pose())) { UI.toast('Enter the outdoor world to set a hunting spot.', 'warn'); return false; }
    this.picked = point;
    this.setCentre();
    return true;
  },
  setCentre() {
    const pt = this.picked, pose = World.pose();
    if (!pt || !World.inWorld()) return;
    // The height of a map point is unknown; the character's current height is used, as the game's own map does.
    Settings.profile.hunt.center = { regionId: pt.regionId, x: Math.round(pt.x), y: Number(pose?.y) || 0, z: Math.round(pt.z) };
    Settings.saveProfile(); bus.emit('center');
    this.picked = null; this.dirty = true;
    UI.toast('Hunting spot set on the map.'); this.render();
  },
  tick() {
    if (!this.canvas?.isConnected) { clearInterval(this.timer); this.timer = 0; return; }
    if (UI.minimised || document.hidden) return;
    this.dirty = true;
    // One message per distinct error, so a drawing problem shows in the log instead of failing silently every 200 ms.
    try { this.render(); } catch (e) { if (e.message !== this.lastError) { this.lastError = e.message; Log.warn('Map: ' + e.message); } }
  },
  render() {
    const c = this.canvas;
    if (!c?.isConnected || !this.dirty) return;
    this.dirty = false;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const ratio = W.devicePixelRatio || 1;
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(h * ratio); }
    const ctx = c.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = '#0b0d0a'; ctx.fillRect(0, 0, w, h);
    const pose = World.inWorld() ? World.pose() : null, me = this.space(pose);
    this.followButton.disabled = this.follow && !!me;
    this.pickRow.hidden = !this.picked;
    if (!pose) { this.note(ctx, w, h, 'Waiting for the game…'); this.info.textContent = ''; return; }
    if (!me) { this.note(ctx, w, h, 'There is no map for dungeons yet.'); this.info.textContent = ''; return; }
    if (this.follow || !this.view) this.view = { X: me.X, Z: me.Z };
    const upp = this.upp, v = this.view;
    const sx = X => w / 2 + (X - v.X) / upp, sy = Z => h / 2 - (Z - v.Z) / upp;
    // Minimap tiles under the visible box.
    const x0 = v.X - w / 2 * upp, x1 = v.X + w / 2 * upp, z0 = v.Z - h / 2 * upp, z1 = v.Z + h / 2 * upp;
    for (let rx = Math.max(0, Math.floor(x0 / SECTOR)); rx <= Math.min(255, Math.floor(x1 / SECTOR)); rx++)
      for (let rz = Math.max(0, Math.floor(z0 / SECTOR)); rz <= Math.min(127, Math.floor(z1 / SECTOR)); rz++) {
        const img = this.image(this.tiles, `${MAP_ART}minimap/${rx}x${rz}`);
        if (!img) continue;
        const l = Math.floor(sx(rx * SECTOR)), t = Math.floor(sy((rz + 1) * SECTOR));
        ctx.drawImage(img, l, t, Math.ceil(sx((rx + 1) * SECTOR)) - l, Math.ceil(sy(rz * SECTOR)) - t);
      }
    // Hunting area: radius (filled) and chase distance (dashed).
    const H = Settings.profile.hunt, centre = this.space(H.center);
    if (centre) {
      const cx = sx(centre.X), cy = sy(centre.Z);
      ctx.save();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(255,214,90,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, (Number(H.chase) || 0) / upp, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,214,90,.12)'; ctx.strokeStyle = 'rgba(255,214,90,.95)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, (Number(H.radius) || 0) / upp, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd65a'; ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
      ctx.restore();
    }
    // Entities in view. Party members are drawn from the party list too, so ones out of sight still show.
    const social = World.gp?.social, party = new Set((social?.members || []).map(m => m?.name).filter(Boolean));
    const target = World.gp?.target, local = World.localGid(), drawn = new Set();
    const put = (name, x, y, size, fallback) => {
      const img = this.sign(name);
      if (img) ctx.drawImage(img, Math.round(x - size / 2), Math.round(y - size / 2), size, size);
      else { ctx.fillStyle = fallback; ctx.beginPath(); ctx.arc(x, y, size / 3, 0, Math.PI * 2); ctx.fill(); }
    };
    let monsters = 0, players = 0;
    for (const e of World.ents.values()) {
      if (!e || e.gid === local || e.kind === 'local-player') continue;
      const s = this.space(e);
      if (!s) continue;
      const x = sx(s.X), y = sy(s.Z);
      if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
      if (e.kind === 'monster') {
        if (!World.isAlive(e)) continue;
        monsters++;
        const cls = monsterClass(e);
        if (e.rarity === 3) put('unique', x, y, 13, MAP_CLASS_COLOR.unique);
        else if (cls === 'normal') put('monster', x, y, 8, MAP_CLASS_COLOR.normal);
        else { ctx.fillStyle = MAP_CLASS_COLOR[cls] || '#fff'; ctx.beginPath(); ctx.arc(x, y, cls === 'champion' ? 3.5 : 4.5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke(); }
      } else if (e.kind === 'player') {
        players++;
        const member = party.has(e.name); if (member) drawn.add(e.name);
        put(member ? 'party' : 'otherplayer', x, y, 9, member ? '#5aff7a' : '#5ab4ff');
        if (upp <= 4 && e.name) this.label(ctx, e.name, x + 7, y - 4, member ? '#9dff9d' : '#cfe8ff');
      } else if (e.kind === 'npc') put('npc', x, y, 9, '#f0f0a0');
      else if (e.kind === 'cos') put('animal', x, y, 9, '#c8a2ff');
      else continue;
      if (e.gid === target) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.stroke(); }
    }
    for (const m of social?.members || []) {
      if (!m || m.id === social.self || drawn.has(m.name) || m.name === social.localName) continue;
      const s = this.space(m);
      if (!s) continue;
      put('party', clamp(sx(s.X), 6, w - 6), clamp(sy(s.Z), 6, h - 6), 9, '#5aff7a');
    }
    // A marked point (click), then you on top. Heading 0 = east, counter-clockwise; the sign points east.
    if (this.picked) {
      const s = this.space(this.picked), x = sx(s.X), y = sy(s.Z);
      ctx.strokeStyle = '#6fc1ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 11, y); ctx.lineTo(x + 11, y); ctx.moveTo(x, y - 11); ctx.lineTo(x, y + 11); ctx.stroke();
    }
    const mx = clamp(sx(me.X), 8, w - 8), my = clamp(sy(me.Z), 8, h - 8), img = this.sign('character');
    ctx.save(); ctx.translate(mx, my); ctx.rotate(-((Number(pose.angle) || 0) / 65535) * Math.PI * 2);
    if (img) ctx.drawImage(img, -8, -8, 16, 16); else { ctx.fillStyle = '#fff'; ctx.fillRect(-4, -4, 8, 8); }
    ctx.restore();
    // Scale bar.
    const metres = [10, 20, 50, 100, 200, 500].find(m => m * 10 / upp >= 60) || 500, bar = metres * 10 / upp;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(w - bar - 18, h - 22, bar + 12, 16);
    ctx.fillStyle = '#efdaa4'; ctx.fillRect(w - bar - 12, h - 12, bar, 2); this.label(ctx, metres + ' m', w - bar - 12, h - 15, '#efdaa4');
    const shown = displayCoords(pose), distance = H.center ? dist2D(pose, H.center) : Infinity;
    const pick = this.picked && displayCoords(this.picked);
    this.info.textContent = `You: X ${shown.x} · Y ${shown.y}. Hunting spot: ${Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : H.center ? 'another region' : 'not saved'}. In view: ${monsters} monsters, ${players} players.`
      + (pick ? ` Marked point: X ${pick.x} · Y ${pick.y}.` : '');
  },
  label(ctx, text, x, y, color) {
    ctx.font = '11px Arial'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  },
  note(ctx, w, h, text) {
    ctx.font = '12px Arial'; ctx.textAlign = 'center'; ctx.fillStyle = '#a09b8c'; ctx.fillText(text, w / 2, h / 2); ctx.textAlign = 'start';
  },
};
