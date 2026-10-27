// Repair missing learned metadata lazily; never add an unlearned skill to the character.
const Learned = {
  pending: null, retryAt: 0, english: new Map(), loaded: false,
  // Official English names (textdataname) replace whatever code or name the catalog carries.
  localize() {
    for (const [id, name] of this.english) { const s = World.catalog.get(id); if (s && s.name !== name) s.name = name; }
  },
  rows() {
    return (World.gp?.skills || []).map(id => World.skill(id) || { id, group: id, name: 'Skill #' + id, missing: true });
  },
  async repair() {
    if (this.pending || now() < this.retryAt || (this.loaded && !this.rows().some(s => s.missing))) return;
    this.retryAt = now() + 30000;
    this.pending = (async () => {
      const [data, names] = await Promise.all([Icons.request('/assets/data/skillData.json', 'json'), Icons.request('/assets/text/textdataname.en.json', 'json')]);
      const learned = new Set(World.gp?.skills || []), additions = [];
      for (const row of data.rows || []) {
        const m = row.split('\t'), id = Number(m[0]), en = names.entries?.[m[19]];
        if (en) this.english.set(id, en);
        if (!learned.has(id) || World.skill(id)) continue;
        // These are the projected columns published by buildSkillDataAsset.mjs.
        const group = Number(m[1]), sibling = World.groups.get(group)?.[0];
        additions.push({ id, group, level: Number(m[2]), active: Number(m[3]) !== 0,
          name: names.entries?.[m[19]] || 'Skill #' + id, icon: m[18], mp: Number(m[24]) || 0,
          targetRequired: m[78] === undefined ? !!sibling?.targetRequired : Number(m[78]) !== 0,
          cooldownMs: sibling?.cooldownMs || 0 });
      }
      this.loaded = true;
      if (additions.length) World.rebuildCatalog([...World.catalog.values(), ...additions]);
      else { this.localize(); bus.emit('catalog'); }
    })().catch(e => Log.warn('Learned skill metadata: ' + e.message)).finally(() => { this.pending = null; });
    return this.pending;
  },
};
{
  const rebuild = World.rebuildCatalog;
  World.rebuildCatalog = function (list) { rebuild.call(this, list); Learned.localize(); };
}
