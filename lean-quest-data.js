// Quest catalogue from the game's own data files (the live asset packs), like phBot's quest table. questData.json
// lists every quest with its level and text keys (the first column is the quest's refId, the name key
// SN_QNO_<NPC>_<n> carries the QNO_ codename the dialogue rows use), npcpos.json places every NPC by refObjId,
// and the NPC manifest names each refObjId (NPC_<NPC>). A quest's giver is the NPC named in its codename; one that
// does not resolve is left to the game's quest markers. The server's monster spawns are not in the client, so the
// monsters to hunt come from the journal's target list and from kills that advanced a quest.
const QuestData = {
  quests: new Map(),   // refId -> { refId, level, key, token, title, npcCode }
  npcs: new Map(),     // NPC_ codename -> { refObjId, regionId, x, y, z }
  pending: null, loaded: false, failed: false,
  ready() {
    if (this.pending) return this.pending;
    this.pending = Promise.all([Assets.json('/assets/data/questData.json'), Assets.json('/assets/data/npcpos.json'),
      Assets.json('/assets/npc/manifest.json')]).then(([quest, pos, npc]) => {
      const names = quest.textEntries || {};
      const codeOf = new Map(Object.values(npc.models || {}).filter(v => v?.refObjId != null && v.codename).map(v => [v.refObjId, v.codename]));
      for (const row of pos.rows || []) {
        const [ref, region, x, y, z] = String(row).split('\t');
        const code = codeOf.get(Number(ref));
        if (!code || this.npcs.has(code)) continue;
        this.npcs.set(code, { refObjId: Number(ref), regionId: Number(region), x: Number(x), y: Number(y), z: Number(z) });
      }
      for (const row of quest.rows || []) {
        const c = String(row).split('\t'), refId = Number(c[0]), level = Number(c[1]), key = c[2] || '';
        const hit = /^SN_(QNO_(.+?)_\d+)$/.exec(key);
        if (!refId || !hit) continue;
        this.quests.set(refId, { refId, level, key, token: hit[1], title: names[key] || '', npcCode: 'NPC_' + hit[2] });
      }
      this.loaded = true;
      if (UI.is('Quest')) UI.draw();
    }).catch(e => { this.pending = null; this.failed = true; Log.warn('Quest data unavailable: ' + (e?.message || e)); });
    return this.pending;
  },
  quest(refId) { return this.quests.get(refId) || null; },
  token(refId) { return this.quests.get(refId)?.token || ''; },
  // Where the quest's giver stands, or null when the codename names no known NPC.
  giver(refId) {
    const q = this.quests.get(refId), npc = q && this.npcs.get(q.npcCode);
    return npc ? { ...npc } : null;
  },
  // Quests the list offers, lowest level first. Rows without a resolvable giver stay out: they can only be done
  // from the game's own markers.
  list() {
    return [...this.quests.values()].filter(q => this.npcs.has(q.npcCode)).sort((a, b) => a.level - b.level || a.refId - b.refId);
  },
};
