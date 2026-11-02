// Original validated appearance core with a compact, lazy catalogue browser.
const Assets = {
  cache: new Map(),
  json(path) {
    if (!this.cache.has(path)) this.cache.set(path, Icons.request(path, 'json').catch(e => { this.cache.delete(path); throw e; }));
    return this.cache.get(path);
  },
  texts() { return this.json('/assets/text/textdataname.en.json').then(r => r.entries || {}); },
  async wardrobe() {
    const r = await this.json('/assets/char/roster.json'), d = r.dress || {}, items = [];
    for (const [id, e] of Object.entries(d.equipment || {})) {
      if (!e || (e.slot == null && e.avatarSlot == null)) continue;
      const bodies = Object.keys(e.bodies || {}).filter(k => e.bodies[k] && typeof e.bodies[k] === 'object');
      if (bodies.length) items.push([Number(id), e.code || '', e.slot ?? -1, e.avatarSlot ?? -1, bodies.join(','), d.specialGlows?.[id] ? 1 : 0, e.armorClass || 0]);
    }
    return { items, models: Object.values(r.models || {}).map(m => [m.refObjId, m.codename || '', m.isMount ? 1 : 0]) };
  },
  async npcModels() {
    const r = await this.json('/assets/npc/manifest.json');
    return Object.values(r.models || {}).filter(v => v?.refObjId != null).map(v => [v.refObjId, v.codename || '', v.kind || '']);
  },
};
const Items = {
  data: new Map(), pending: null, filesLoaded: false, filesMissing: false,
  ready() {
    if (this.pending) return this.pending;
    this.pending = Promise.all([Assets.json('/assets/data/missionPresentation.json'), Assets.texts()]).then(([r, names]) => {
      for (const [id, v] of Object.entries(r.itemsByRefObjId || {})) {
        if (!v?.codename) continue;
        const code = v.codename, generic = code.replace(/^ITEM_(CH|EU)_[MW]_/, 'ITEM_$1_');
        let name = names['SN_' + code] || names['SN_' + generic], shortened = generic;
        while (!name && shortened.includes('_')) { shortened = shortened.slice(0, shortened.lastIndexOf('_')); name = names['SN_' + shortened]; }
        this.data.set(Number(id), { name: name || code, icon: v.iconDdjPath || '', code });
      }
      this.filesMissing = false; this.filesLoaded = true; this.wireApply();
    }).catch(e => { this.pending = null; this.filesMissing = true; throw e; });
    return this.pending;
  },
  name(id) { return this.data.get(id)?.name || WdData.byId.get(id)?.code || '#' + id; },
  iconDdj(id) { return this.data.get(id)?.icon || ''; },
  // Server-fed catalogue rows. The live site serves none of the game's data JSONs, so the file catalogue above can
  // stay empty there; every item the wire shows carries its name, icon and tooltip key instead, and the codename
  // follows from that key (SN_ITEM_..._TT_DESC → ITEM_...). Rows seen that way fill the catalogue for rules, names
  // and sox checks, and stay cached across sessions. The server's own values win over file rows.
  wireRows: new Map(), wireLoaded: false,
  wireApply() {
    for (const [id, row] of this.wireRows) {
      if (!row?.name) continue;
      const cur = this.data.get(id);
      if (cur && cur.name === row.name && (cur.code || '') === (row.code || '') && (cur.icon || '') === (row.icon || '')) continue;
      this.data.set(id, { name: row.name, code: row.code || cur?.code || '', icon: row.icon || cur?.icon || '' });
    }
  },
  wireLearn(items) {
    let changed = false;
    for (const it of items || []) {
      if (!it || !isNum(it.refObjId) || typeof it.name !== 'string' || !it.name) continue;
      const key = /^SN_(.+)_TT_DESC$/.exec(it.tooltip?.descriptionSymbol || '');
      // Shop offers carry a name only: a sparse sighting keeps the richer cached fields instead of erasing them.
      const old = this.wireRows.get(it.refObjId);
      const row = { name: it.name, code: key ? key[1] : (old?.code || ''), icon: it.icon || old?.icon || '' };
      if (old && old.name === row.name && old.code === row.code && old.icon === row.icon) continue;
      this.wireRows.set(it.refObjId, row);
      changed = true;
    }
    if (changed) { this.wireApply(); this.wireSave(); }
    return changed;
  },
  wireSave() {
    try {
      const out = {}; let n = 0;
      for (const [id, row] of this.wireRows) { out[id] = row; if (++n >= 4000) break; }
      W.localStorage.setItem('sroLean:wirecat', JSON.stringify(out));
    } catch (e) { /* a full store only slows the cache; nothing is lost */ }
  },
  wireLoad() {
    if (this.wireLoaded) return;
    this.wireLoaded = true;
    try {
      const saved = JSON.parse(W.localStorage.getItem('sroLean:wirecat') || '{}');
      for (const [id, row] of Object.entries(saved)) if (row?.name) this.wireRows.set(Number(id), row);
    } catch (e) {}
    this.wireApply();
  },
  // 0 none | 1 Star | 2 Moon | 3 Sun, from the codename rule _[ABC]_RARE (also MAGIC/LEGEND/MYTH, HONOR).
  // Real inventory/pet items carry tooltip rarity (2 = seal tiers) and a Star/Moon/Sun class; otherwise use the codename rule.
  soxOf(item) {
    const f = item?.tooltip?.fields;
    if (f && f.rarity !== undefined) {
      if (f.rarity !== 2) return 0;
      if (f.itemClass) return ((f.itemClass - 1) % 3) + 1;
    }
    const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(item?.codename || this.data.get(item?.refObjId)?.code || '');
    return m ? 'ABC'.indexOf(m[1]) + 1 : f?.rarity === 2 ? 1 : 0;
  },
  sox(id) { const m = /_([ABC])_(RARE|MAGIC|LEGEND|MYTH)(?:_HONOR)?$/.exec(this.data.get(id)?.code || ''); return m ? 'ABC'.indexOf(m[1]) + 1 : 0; },
};
const LeanWardrobe = {
  slot: 'e6', query: '', degree: 0, rarity: '', page: 0, loading: null, preset: '',
  load(force = false) {
    if (this.loading) return this.loading;
    this.loading = WdData.load(force).then(ok => {
      if (ok) { Wardrobe.body = WdData.bodyOf(World.local()?.refObjId); Wardrobe.learn(); Wardrobe.applyNow(); }
      if (UI.is('Wardrobe')) UI.draw();
      return ok;
    }).finally(() => { this.loading = null; });
    return this.loading;
  },
  change(fn) { fn(); Wardrobe.changed(false); UI.draw(); },
  chooseSlot(slot) {
    this.slot = slot; Wardrobe.view.slot = slot;
    this.query = ''; this.degree = 0; this.rarity = ''; this.page = 0;
    UI.draw();
  },
  rows() {
    const q = wdFold(this.query);
    if (this.slot[0] === 'p') {
      const list = this.slot === 'pm' ? WdData.mounts : WdData.pets;
      return list.filter(r => wdFold(r.name + ' ' + r.code + ' ' + (r.size || '')).includes(q));
    }
    const number = Number(this.slot.slice(1)), equipment = this.slot[0] === 'e';
    return WdData.rowsFor(Wardrobe.body).filter(r => (equipment ? r.slot === number : this.slot === 'a*' ? r.av >= 0 : r.av === number) &&
      (!equipment || ((!this.degree || r.m.deg === this.degree) && (!this.rarity || String(r.m.sox) === this.rarity))) && wdFold(Items.name(r.id) + ' ' + r.code).includes(q));
  },
  draw(parent) {
    const c = Wardrobe.cfg();
    const actions = UI.group('Appearance studio',
      UI.check('Enable wardrobe', () => c.on, v => { c.on = v; Wardrobe.changed(true); }),
      UI.check('Keep real weapon animations', () => c.realAnim, v => { c.realAnim = v; Wardrobe.changed(false); }),
      UI.check('Show skins in empty slots', () => c.phantom, v => { c.phantom = v; Wardrobe.changed(false); }),
      UI.check('Hide avatars', () => c.hideAvatars, v => { c.hideAvatars = v; Wardrobe.changed(false); }),
      UI.row(UI.button('Random outfit', () => this.change(() => Wardrobe.randomize())), UI.button('Real look', () => this.change(() => Wardrobe.resetAll())), UI.button('Undo', () => this.change(() => Wardrobe.undo()))),
      el('p', 'Preview outfits on your character. Looks are visible to you only; equipment stats stay real. Import original settings to restore your previous outfits.', 'muted'));
    parent.append(actions);
    if (!WdData.ready()) {
      const state = el('p', WdData.error ? 'Catalogue could not load: ' + WdData.error : 'Loading wardrobe catalogue…', 'muted');
      parent.append(UI.group('Catalogue', state, UI.button('Retry catalogue', () => this.load(true))));
      if (!WdData.error) this.load();
      return;
    }
    Wardrobe.body = WdData.bodyOf(World.local()?.refObjId);
    if (!Wardrobe.body) { parent.append(el('p', 'Enter the world so the wardrobe can match skins to your character body.', 'muted')); return; }
    const categories = el('div', null, 'subtabs');
    for (const [label, slot] of [['Equipment', 'e6'], ['Avatars / paid skins', 'a*'], ['Pets & mounts', 'p4']]) {
      const button = UI.button(label, () => this.chooseSlot(slot)); button.setAttribute('aria-selected', String(this.slot[0] === slot[0])); categories.append(button);
    }
    parent.append(categories);
    const slots = [...Array.from({ length: 9 }, (_, s) => ['e' + s, wdSlotName(s)]), ['a*', 'All avatar skins'], ...Array.from({ length: 4 }, (_, s) => ['a' + s, 'Avatar ' + wdAvatarName(s)]), ['p3', 'Attack pet'], ['p4', 'Pickup pet'], ['pm', 'Mount']];
    const catalog = UI.group('Skins for ' + Wardrobe.body,
      UI.select('Appearance slot', slots, () => this.slot, v => this.chooseSlot(v)));
    if (this.slot[0] === 'e') catalog.append(
      UI.select('Degree', [[0, 'All'], ...Array.from({ length: 15 }, (_, i) => [i + 1, 'Degree ' + (i + 1)])], () => this.degree, v => { this.degree = Number(v); this.page = 0; UI.draw(); }),
      UI.select('Seal', [['', 'All'], ['0', 'Normal'], ['1', 'Star'], ['2', 'Moon'], ['3', 'Sun']], () => this.rarity, v => { this.rarity = v; this.page = 0; UI.draw(); }));
    if (this.slot[0] === 'a') catalog.append(el('p', 'All compatible avatar looks in the game catalogue, including paid skins, whether owned or not. This is a local appearance preview; it does not buy items or grant ownership.', 'muted'));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search name or skin code'; search.value = this.query; search.setAttribute('aria-label', 'Search wardrobe');
    const results = el('div'), refresh = () => this.results(results);
    search.addEventListener('input', () => { this.query = search.value; this.page = 0; refresh(); });
    const hide = UI.button('Hide slot', () => this.change(() => Wardrobe.toggleHide(this.slot))); hide.disabled = this.slot[0] === 'p' || this.slot === 'a*';
    const reset = UI.button('Reset slot', () => this.change(() => Wardrobe.resetSlot(this.slot))); reset.disabled = this.slot === 'a*';
    catalog.append(UI.field('Search wardrobe', search), UI.row(
      reset, hide));
    if (this.slot === 'e6' || this.slot === 'e7') catalog.append(UI.number('Weapon / shield glow (+)', () => c.eq[Number(this.slot.slice(1))]?.plus ?? 0,
      v => { Wardrobe.ensureEq(Number(this.slot.slice(1))).plus = v; Wardrobe.changed(false); }, 0, 255));
    catalog.append(results); parent.append(catalog); refresh();
    const opt = Wardrobe.setOpt;
    const set = UI.group('Matching set',
      UI.select('Armour', [['CLOTHES', 'Garment / Robe'], ['LIGHT', 'Protector / Light'], ['HEAVY', 'Armour / Heavy']], () => opt.cls || 'CLOTHES', v => opt.cls = v),
      UI.number('Set degree', () => opt.deg || 1, v => opt.deg = v, 1, 15),
      UI.select('Set seal', [[0, 'Normal'], [1, 'Star'], [2, 'Moon'], [3, 'Sun']], () => opt.sox, v => opt.sox = Number(v)),
      UI.select('Matching weapon', [['', 'Keep current'], ...[...new Set(WdData.rowsFor(Wardrobe.body).filter(r => r.slot === 6 && r.m.kind && r.m.kind !== 'FORT').map(r => r.m.kind))].map(kind => [kind, wdKindName(kind)])], () => opt.weapon, v => opt.weapon = v),
      UI.check('Include matching shield', () => opt.shield, v => opt.shield = v),
      UI.number('Set weapon / shield glow (+)', () => opt.plus, v => opt.plus = v, 0, 255),
      UI.button('Wear matching armour', () => this.change(() => { opt.cls ||= 'CLOTHES'; opt.deg ||= 1; const result = Wardrobe.applySet(); if (result) UI.toast('Applied ' + result.n + ' parts; ' + result.miss + ' unavailable.'); })));
    parent.append(set);
    const name = el('input'); name.type = 'text'; name.maxLength = 32; name.placeholder = 'Outfit name'; name.setAttribute('aria-label', 'Outfit name');
    const presets = UI.group('Saved outfits', name,
      UI.button('Save outfit', () => this.change(() => Wardrobe.savePreset(name.value))),
      UI.select('Outfit', () => [['', 'Choose outfit'], ...Object.keys(c.presets).map(k => [k, k])], () => this.preset, v => this.preset = v),
      UI.row(UI.button('Wear outfit', () => this.change(() => Wardrobe.loadPreset(this.preset))), UI.button('Delete outfit', () => this.change(() => Wardrobe.deletePreset(this.preset)))));
    parent.append(presets);
  },
  results(parent) {
    parent.replaceChildren();
    const rows = this.rows(), count = 48, pages = Math.max(1, Math.ceil(rows.length / count));
    this.page = Math.min(this.page, pages - 1);
    parent.append(el('p', rows.length + ' compatible skins · page ' + (this.page + 1) + '/' + pages, 'muted'));
    const grid = el('div', null, 'wardrobe-grid');
    for (const row of rows.slice(this.page * count, (this.page + 1) * count)) {
      const pet = this.slot[0] === 'p', title = pet ? row.name + (row.size ? ' · ' + row.size : '') : Items.name(row.id);
      const targetSlot = this.slot === 'a*' ? 'a' + row.av : this.slot;
      const button = UI.button('', () => this.change(() => { Wardrobe.view.slot = targetSlot; if (pet) Wardrobe.setPet(this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick', row.id); else Wardrobe.pick(row); }));
      button.className = 'wardrobe-item'; button.title = title + '\n' + row.code; button.setAttribute('aria-label', 'Wear ' + title);
      const c = Wardrobe.cfg(), selected = pet ? c.pet[this.slot === 'pm' ? 'mount' : this.slot === 'p3' ? 'atk' : 'pick'] : c[targetSlot[0] === 'e' ? 'eq' : 'av'][Number(targetSlot.slice(1))]?.ref;
      button.setAttribute('aria-pressed', String(selected === row.id));
      const icon = el('span', null, 'slot skill-icon'); icon.append(el('span', pet ? 'Pet' : 'Skin', 'fallback')); Icons.paint(icon, Items.iconDdj(row.id));
      button.append(icon, el('span', title + (this.slot === 'a*' ? ' · ' + wdAvatarName(row.av) : ''))); grid.append(button);
    }
    const previous = UI.button('Previous skins', () => { this.page = Math.max(0, this.page - 1); this.results(parent); }), next = UI.button('Next skins', () => { this.page = Math.min(pages - 1, this.page + 1); this.results(parent); });
    previous.disabled = this.page === 0; next.disabled = this.page >= pages - 1;
    parent.append(grid, UI.row(previous, next));
    if (!rows.length) parent.append(el('p', 'No compatible skins match these filters.', 'muted'));
  },
};
