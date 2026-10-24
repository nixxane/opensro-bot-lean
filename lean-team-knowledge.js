// Team knowledge: the persistent, shared memory of the room. The unique tracker turns the game's
// own division-wide announcements (UIIT_MSG_APPEAR/DEAD notices, already on the bot's bus) plus
// first-hand sightings into spawn history with respawn windows (the timer restarts at death; 3-6 h
// per unique). The player database keys on names with deterministic gids, remembers hostility (a
// player outside the party casting at us) and last positions. Drop counters come from the loot bus.
// Everything is kept in the room's key-value store on the relay (last writer merges), so a late
// joiner hydrates from what the room already knows. Wall-clock times (Date.now) because records
// outlive sessions; nothing personal about the local character leaves the room.
const KNOWLEDGE_SYNC_MS = 30000;
const KNOWLEDGE_MAX_PLAYERS = 200, KNOWLEDGE_MAX_DROPS = 300;
// Respawn hours per unique, from the game's own tables; unknown names take the 6 h default.
const UNIQUE_HOURS = { tiger: 6, cerberus: 6, ivy: 6, isyutaru: 6, uruchi: 3, yarkan: 6, shaitan: 6, medusa: 4, jupiter: 4, bonlord: 6, tahomet: 6 };
const TeamKnowledge = {
  uniques: new Map(), // name -> {name, appearAt, deadAt, pos, src, at}
  players: new Map(), // name -> {gid, level, regionId, x, z, hostile, hits, at}
  drops: new Map(),   // item name -> count
  gold: 0, dirty: false, syncedAt: -Infinity, hostileAt: new Map(),
  share() { return Settings.profile.team?.share || {}; },
  reset() { this.dirty = true; }, // records stay; the relay is the memory, a reset only re-syncs
  hoursFor(name) {
    const text = String(name || '').toLowerCase();
    for (const [word, hours] of Object.entries(UNIQUE_HOURS)) if (text.includes(word)) return hours;
    return 6;
  },
  // ---- unique tracker ----
  onNotice(n) {
    const m = String(n?.key || '').match(/^UIIT_MSG_(APPEAR|DEAD|ANYONE_DEAD)_([A-Z_]+)$/);
    if (!m) return;
    const args = Array.isArray(n.args) ? n.args.map(a => String(a ?? '').trim()) : [];
    if (m[2] === 'UNIC' && !args[0]) return;
    const name = m[2] === 'UNIC' ? args[0] : m[2].split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
    if (m[1] === 'APPEAR') this.appear(name, null, 'announcement');
    else this.dead(name);
  },
  appear(name, pos, src) {
    const record = this.uniques.get(name) || { name, at: 0 };
    record.appearAt = Date.now(); record.deadAt = null; record.at = record.appearAt;
    record.src = src || 'sighting'; if (pos) record.pos = pos;
    this.uniques.set(name, record);
    this.dirty = true;
    UI.toast(name + ' appeared' + (pos ? '' : ' (somewhere on this server)'), 'warn', 6000);
    if (Settings.profile.hunt.pickup.soxSound) Sound.play('unique');
    this.announce({ kind: 'unique', name, state: 'appear', pos: pos || record.pos || null });
    TeamArbiter.event('local', { kind: 'unique', name, state: 'appear', pos: pos || record.pos || null });
  },
  dead(name, pos) {
    const record = this.uniques.get(name) || { name, at: 0 };
    record.deadAt = Date.now(); record.at = record.deadAt; if (pos) record.pos = pos;
    this.uniques.set(name, record);
    this.dirty = true;
    UI.toast(name + ' is dead; respawn window ' + this.hoursFor(name) + ' h.', 'info', 6000);
    this.announce({ kind: 'unique', name, state: 'dead', pos: pos || record.pos || null });
    TeamArbiter.event('local', { kind: 'unique', name, state: 'dead', pos: pos || record.pos || null });
  },
  killed(e, killer) {
    if (e?.kind === 'monster' && e.rarity === 3 && e.name) this.dead(e.name, { regionId: e.regionId, x: Math.round(e.x), z: Math.round(e.z) });
  },
  announce(event) {
    if (!Team.online()) return;
    Team.emit(event, 'room');
    if (this.share().public && this.share().uniques) Team.emit(event, 'public');
  },
  // ---- player database ----
  saw(row, src) {
    if (!row?.name || row.cls) return;
    const t = Date.now(), known = this.players.get(row.name) || { hostile: 0, hits: 0, at: 0 };
    if (t - known.at < 20000) return; // sightings are dense; one record per 20 s is plenty
    this.players.set(row.name, { gid: row.gid, level: row.level ?? known.level ?? null,
      regionId: row.regionId, x: row.x, z: row.z, hostile: known.hostile, hits: known.hits, at: t });
    this.dirty = true;
  },
  hostile(owner) {
    if (!owner?.name) return;
    const t = Date.now();
    if (t - (this.hostileAt.get(owner.name) || 0) < 10000) return;
    this.hostileAt.set(owner.name, t);
    const known = this.players.get(owner.name) || { hostile: 0, hits: 0, at: t, gid: owner.gid, level: owner.level ?? null, regionId: owner.regionId, x: owner.x, z: owner.z };
    known.hostile++; known.hits++; known.at = t;
    this.players.set(owner.name, known);
    this.dirty = true;
    Log.warn('Team: ' + owner.name + ' attacked you; recorded as hostile.');
  },
  // ---- drop log ----
  onLoot(e) {
    if (e?.kind === 'item' && e.name) {
      this.drops.set(e.name, (this.drops.get(e.name) || 0) + (e.count || 1));
      if (this.drops.size > KNOWLEDGE_MAX_DROPS) [...this.drops.entries()].sort((a, b) => b[1] - a[1]).slice(KNOWLEDGE_MAX_DROPS).forEach(([k]) => this.drops.delete(k));
      this.dirty = true;
    } else if (e?.kind === 'gold' && e.gold) { this.gold += Number(e.gold) || 0; this.dirty = true; }
  },
  // ---- room events from peers ----
  event(from, ev) {
    if (ev?.kind === 'unique') {
      if (ev.state === 'appear') {
        const record = this.uniques.get(ev.name) || { name: ev.name, at: 0 };
        // Only the announcement or a fresher sighting updates the clock.
        if (!record.appearAt || Date.now() - record.appearAt > 60000) {
          record.appearAt = Date.now(); record.deadAt = null; record.at = record.appearAt; record.src = from;
          if (ev.pos) record.pos = ev.pos;
          this.uniques.set(ev.name, record); this.dirty = true;
          UI.toast(ev.name + ' spotted by ' + from + '.', 'warn', 6000);
          if (Settings.profile.hunt.pickup.soxSound) Sound.play('unique');
        }
      } else if (ev.state === 'dead') {
        // A remote death is recorded quietly: re-announcing it would echo between clients forever.
        const record = this.uniques.get(ev.name) || { name: ev.name, at: 0 };
        record.deadAt = Date.now(); record.at = record.deadAt; if (ev.pos) record.pos = ev.pos;
        this.uniques.set(ev.name, record); this.dirty = true;
        UI.toast(ev.name + ' is dead (' + from + '); respawn window ' + this.hoursFor(ev.name) + ' h.', 'info', 6000);
      }
    } else if (ev?.kind === 'hostile' && ev.name) {
      const known = this.players.get(ev.name) || { hostile: 0, hits: 0, at: Date.now() };
      known.hostile++; known.at = Date.now();
      this.players.set(ev.name, known); this.dirty = true;
    }
  },
  // ---- relay key-value sync ----
  doc() {
    return { uniques: Object.fromEntries(this.uniques), players: Object.fromEntries([...this.players.entries()].slice(-KNOWLEDGE_MAX_PLAYERS)),
      drops: Object.fromEntries(this.drops), gold: this.gold };
  },
  hydrate(value) {
    if (!value || typeof value !== 'object') return;
    const mergeRow = (map, key, row) => {
      if (!row || typeof row !== 'object') return;
      const known = map.get(key);
      if (!known || (row.at || 0) > (known.at || 0)) map.set(key, row);
    };
    for (const [key, row] of Object.entries(value.uniques || {})) mergeRow(this.uniques, key, row);
    for (const [key, row] of Object.entries(value.players || {})) mergeRow(this.players, key, row);
    for (const [key, count] of Object.entries(value.drops || {})) if (Number.isFinite(count)) this.drops.set(key, Math.max(this.drops.get(key) || 0, count));
    if (Number.isFinite(value.gold)) this.gold = Math.max(this.gold, value.gold);
    // Local changes that were still waiting for their own put stay waiting: a peer's store
    // write must never cancel a sync this client owes the room.
  },
  tick() {
    if (!Team.online()) return;
    const t = Date.now();
    if (this.dirty && t - this.syncedAt > KNOWLEDGE_SYNC_MS) {
      if (Team.send({ type: 'kv-put', key: 'knowledge', scope: 'room', value: this.doc() })) {
        this.dirty = false; this.syncedAt = t;
        if (this.share().public && this.share().uniques) Team.send({ type: 'kv-put', key: 'knowledge', scope: 'public', value: this.doc() });
      }
    } else if (!this.dirty) this.syncedAt = t; // a fresh sync keeps the next change prompt
  },
  // One line per unique for the Team page: state and, when waiting, the predicted window.
  uniqueRows() {
    const t = Date.now();
    return [...this.uniques.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).map(r => {
      if (r.deadAt) {
        const next = r.deadAt + this.hoursFor(r.name) * 3600000;
        return r.name + ' · died ' + Math.round((t - r.deadAt) / 60000) + ' min ago · window in ' + (next > t ? Math.round((next - t) / 60000) + ' min' : 'now (+' + Math.round((t - next) / 60000) + ' min)');
      }
      if (r.appearAt) return r.name + ' · appeared ' + Math.round((t - r.appearAt) / 60000) + ' min ago · alive or unfound';
      return r.name + ' · no sighting yet';
    });
  },
  playerRows() {
    const t = Date.now();
    return [...this.players.values()].sort((a, b) => (b.hostile - a.hostile) || (b.at - a.at)).slice(0, 12)
      .map(p => (p.hostile ? '⚠ ' : '') + p.name + (Number.isFinite(p.level) ? ' · level ' + p.level : '') + ' · seen ' + Math.round((t - (p.at || t)) / 60000) + ' min ago' + (p.hostile ? ' · hostile ×' + p.hostile : ''));
  },
  dropRows() {
    return [...this.drops.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => name + ' ×' + n).concat(this.gold ? ['Gold ' + this.gold] : []);
  },
};
bus.on('notice', n => TeamKnowledge.onNotice(n));
bus.on('loot', e => TeamKnowledge.onLoot(e));
Team.on('welcome', () => {
  if (!Team.online()) return;
  Team.send({ type: 'kv-get', key: 'knowledge', scope: 'room' });
  if (Settings.profile.team?.share?.public && Settings.profile.team.share.uniques) Team.send({ type: 'kv-get', key: 'knowledge', scope: 'public' });
});
Team.on('kv-value', m => TeamKnowledge.hydrate(m?.value));
