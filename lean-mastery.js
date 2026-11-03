// Spends skill points automatically, one confirmed training at a time: first the masteries you tick, then
// the next level of the skills in your rotations, buffs and imbue. It follows the game's own rules: a mastery
// cannot pass the character level or 120 (level 0 is free, otherwise the price is the table cost of its
// current level); a skill must be trainable, be the next level of its group, and meet its mastery,
// prerequisite, STR and INT requirements. A reserve keeps some skill points unspent.
const MASTERY_NAMES = { 257: 'Bicheon', 258: 'Heuksal', 259: 'Pacheon', 273: 'Cold', 274: 'Lightning', 275: 'Fire', 276: 'Force',
  513: 'Warrior', 514: 'Wizard', 515: 'Rogue', 516: 'Warlock', 517: 'Bard', 518: 'Cleric' };
const AutoMastery = {
  pending: null, blocked: new Map(), message: 'Auto mastery off.', lastAt: -Infinity, note: null, turn: 'masteries',
  maxAll: false, maxMessage: '', maxNote: null, total: 0, fast: 0,
  cfg() { return Settings.profile.mastery; },
  active() { const c = this.cfg(); return !!(c.enabled || c.skills || this.maxAll); },
  gap() { const g = Number(this.cfg().gap); return Number.isInteger(g) ? Math.max(0, Math.min(50, g)) : 0; },
  reserve() { const r = Number(this.cfg().reserve); return Number.isInteger(r) ? Math.max(0, r) : 0; },
  name(id) { return MASTERY_NAMES[id] || 'Mastery #' + id; },
  reset() { this.stopMax(); this.pending = null; this.blocked.clear(); this.turn = 'masteries'; this.message = this.active() ? 'Waiting for character data.' : 'Auto mastery off.'; },
  rows() { return (World.gp?.progression?.masteries || []).filter(m => m && Number.isInteger(m.id) && Number.isInteger(m.level)); },
  spare(progression) { return Number.isInteger(progression.skillPoints) ? progression.skillPoints - this.reserve() : -Infinity; },
  // Why a mastery cannot be raised right now, or '' when it can.
  reason(row, progression) {
    if (!Number.isInteger(progression.level)) return 'character level unknown';
    // The game stops a mastery at the character level (or 120); the gap keeps it that many levels below.
    const limit = Math.min(120, progression.level - this.gap());
    if (row.level >= limit) return this.gap() ? 'at your limit (' + limit + ', ' + this.gap() + ' below your level)' : 'at the character level limit';
    if (row.level === 0) return '';
    const cost = Stats.levels?.[row.level]?.masteryTrainSpCost;
    if (!Number.isInteger(cost)) return 'price unknown';
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  // Highest learned level in a skill group, 0 when none.
  groupLevel(group) { return Math.max(0, ...(World.groups.get(group) || []).filter(s => World.learned(s.id)).map(s => s.level ?? 0)); },
  // Skill groups the player already uses, in rotation order: attacks, buffs, imbue.
  wanted() {
    const m = Settings.profile.macro, groups = [], seen = new Set();
    const add = e => { const g = e?.group ?? e?.id; if (Number.isInteger(g) && !seen.has(g)) { seen.add(g); groups.push(g); } };
    for (const key of CLASS_KEYS) (m.rotations[key] || []).forEach(add);
    (m.buffs || []).forEach(add); add(m.imbue);
    // The whole learned skill line: every other skill group the character already has, after the ones it uses.
    if (this.cfg().scope === 'all') for (const g of World.groups.keys()) if (!seen.has(g) && this.groupLevel(g)) { seen.add(g); groups.push(g); }
    return groups;
  },
  skillReason(row, progression) {
    if (!row.trainable) return 'cannot be trained';
    if (World.learned(row.id)) return 'already learned';
    if (row.level !== this.groupLevel(row.group) + 1) return 'train the preceding level first';
    if ((row.masteries || []).some(r => r.ID && !progression.masteries.some(m => m.id === r.ID && m.level >= r.Level))) return 'mastery level too low';
    if ((row.prerequisites || []).some(r => r.ID && this.groupLevel(r.ID) < r.Level)) return 'prerequisite skill missing';
    if ((row.reqStr ?? 0) > (progression.stats?.strength ?? 0)) return 'strength too low';
    if ((row.reqInt ?? 0) > (progression.stats?.intellect ?? 0)) return 'intelligence too low';
    const cost = Number.isInteger(row.spCost) ? row.spCost : Infinity;
    return this.spare(progression) < cost ? 'needs ' + cost + ' skill points' + (this.reserve() ? ' beyond the ' + this.reserve() + ' reserve' : '') : '';
  },
  send(kind, id, label, extra) {
    if (!Cmd.raw({ kind, id }, label)) return false;
    this.pending = { kind, id, at: now(), error: World.gp?.trainingError, ...extra }; this.lastAt = now();
    this.message = label + '.';
    if (this.maxAll) this.maxMessage = 'Max every skill: ' + label + ' (' + this.total + ' done so far).';
    return true;
  },
  masteryStep(progression, skipped) {
    if (!this.cfg().enabled) return false;
    if (!Stats.levels) { Stats.loadLevels(); skipped.push('mastery prices loading'); return false; }
    for (const id of this.cfg().ids) {
      const row = this.rows().find(m => m.id === id);
      if (!row) continue;
      if ((this.blocked.get('m' + id) ?? 0) > now()) { skipped.push(this.name(id) + ': recently refused'); continue; }
      const why = this.reason(row, progression);
      if (why) { skipped.push(this.name(id) + ': ' + why); continue; }
      return this.send('mastery-train', id, 'Raising ' + this.name(id) + ' from ' + row.level, { level: row.level, name: this.name(id) });
    }
    return false;
  },
  skillStep(progression, skipped) {
    if (!this.cfg().skills) return false;
    if (!World.groups.size) { skipped.push('skill catalogue not loaded'); return false; }
    const groups = this.wanted();
    if (!groups.length) { skipped.push(this.cfg().scope === 'all' ? 'no learned skills found' : 'no skills in your attack rotations, buffs or imbue yet'); return false; }
    const quiet = [], name = group => World.skillName(World.bestOfGroup(group, (World.groups.get(group) || [])[0]?.id) || (World.groups.get(group) || [])[0]?.id) || 'Skill ' + group;
    const summary = () => { for (const line of quiet.slice(0, 6)) skipped.push(line); if (quiet.length > 6) skipped.push('and ' + (quiet.length - 6) + ' more skills'); };
    for (const group of groups) {
      const current = this.groupLevel(group);
      if (!current) { quiet.push(name(group) + ': not learned yet'); continue; }
      const row = (World.groups.get(group) || []).find(s => s.level === current + 1);
      if (!row) { quiet.push(name(group) + ': already at its highest level (' + current + ')'); continue; }
      const label = name(group) + ' level ' + row.level;
      if ((this.blocked.get('s' + row.id) ?? 0) > now()) { skipped.push(label + ': recently refused'); continue; }
      const why = this.skillReason(row, progression);
      if (why) { skipped.push(label + ': ' + why); continue; }
      return this.send('skill-train', row.id, 'Learning ' + label, { name: label });
    }
    summary();
    return false;
  },
  tick() {
    const c = this.cfg(), gp = World.gp;
    if (!this.active()) { this.pending = null; this.message = 'Auto mastery off.'; return; }
    const progression = gp?.progression;
    if (!World.inWorld() || World.isDead() || !progression || !Array.isArray(progression.masteries)) { this.message = 'Waiting for a living character.'; return; }
    const p = this.pending;
    if (p) {
      const mastery = p.kind === 'mastery-train', row = mastery ? this.rows().find(m => m.id === p.id) : null;
      if (mastery ? row && row.level > p.level : World.learned(p.id)) {
        this.pending = null; this.blocked.delete((mastery ? 'm' : 's') + p.id); this.turn = this.turn === 'masteries' ? 'skills' : 'masteries';
        if (!mastery) this.total++;
        if (!this.maxAll) UI.toast(mastery ? p.name + ' mastery raised to ' + row.level + '.' : p.name + ' learned.', 'info', 4000);
        this.message = mastery ? p.name + ' raised to ' + row.level + '.' : p.name + ' learned.';
      } else if (now() - p.at > 10000 || (this.maxAll && gp.trainingError !== p.error)) {
        // The server may have refused (for example its total mastery limit). Never resend blindly.
        this.pending = null; this.blocked.set((mastery ? 'm' : 's') + p.id, now() + 60000);
        this.message = p.name + ' was not accepted; trying again in a minute. ' + (gp.trainingError || '');
      } else return;
    }
    if (this.maxAll) return gp.trainingPending ? undefined : this.maxStep(progression);
    if (gp.trainingPending || gp.trainingError) {
      this.message = gp.trainingError || 'Waiting for the previous training to finish.'; return;
    }
    if (now() - this.lastAt < 1500 || !Cmd.spaced('mastery-train') || !Cmd.spaced('skill-train')) return;
    const skipped = [], order = c.order === 'skills' ? ['skills', 'masteries'] : c.order === 'alternate' ? (this.turn === 'skills' ? ['skills', 'masteries'] : ['masteries', 'skills']) : ['masteries', 'skills'];
    for (const step of order) if (step === 'masteries' ? this.masteryStep(progression, skipped) : this.skillStep(progression, skipped)) return;
    // The order setting only matters when both switches are on, so say when the skills one is off.
    if (!c.skills) skipped.push('skills are not raised: "Upgrade my rotation and buff skills automatically" is off');
    this.message = c.enabled && !c.ids.length && !c.skills ? 'Choose which masteries to raise.'
      : 'Nothing to raise (' + (skipped.slice(0, 8).join('; ') + (skipped.length > 8 ? '; and ' + (skipped.length - 8) + ' more' : '') || 'selected masteries not found') + ').';
  },
  // ---- Max every skill: one button, one job. Every skill group gets its next level until nothing more is allowed. ----
  // A mastery is raised only when it is the one thing blocking a skill. The gap and reserve settings do not apply here.
  startMax() {
    if (this.maxAll) return;
    if (!World.inWorld() || World.isDead() || !World.gp?.progression) return UI.toast('Enter the game with a living character first.', 'warn');
    if (!World.groups.size) return UI.toast('The skill catalogue is not loaded yet.', 'warn');
    this.maxAll = true; this.total = 0; this.pending = null; this.blocked.clear();
    this.message = this.maxMessage = 'Max every skill: starting.';
    Stats.loadLevels();
    this.fast = setInterval(() => {
      // Leaving the world (death screen, disconnect) must stop the 10 ms loop, not spin it forever.
      if (!World.inWorld()) return this.stopMax('Max every skill stopped: the game world was left.');
      this.tick();
    }, 10);
  },
  stopMax(text) {
    if (this.fast) { clearInterval(this.fast); this.fast = 0; }
    if (!this.maxAll) return;
    this.maxAll = false; this.pending = null;
    if (text) { this.message = this.maxMessage = text; UI.toast(text, 'info', 8000); Log.info(text); }
  },
  maxStep(progression) {
    if (!Stats.levels) { Stats.loadLevels(); this.message = 'Loading mastery prices.'; return; }
    const rules = Object.create(this, { reserve: { value: () => 0 }, gap: { value: () => 0 } }), left = new Map();
    const add = why => left.set(why, (left.get(why) ?? 0) + 1);
    for (const [group, rows] of World.groups) {
      const row = rows.find(s => s.level === this.groupLevel(group) + 1);
      if (!row?.trainable) continue;
      if ((this.blocked.get('s' + row.id) ?? 0) > now()) { add('refused by the game'); continue; }
      const why = rules.skillReason(row, progression);
      if (!why) { const label = World.skillName(row.id) + ' level ' + row.level; return this.send('skill-train', row.id, 'Learning ' + label, { name: label }); }
      if (!/^mastery/.test(why)) { add(why); continue; }
      const need = (row.masteries || []).find(r => r.ID && !progression.masteries.some(m => m.id === r.ID && m.level >= r.Level));
      const mastery = progression.masteries.find(m => m.id === need?.ID), stop = mastery ? rules.reason(mastery, progression) : 'not available';
      if (mastery && !stop && (this.blocked.get('m' + mastery.id) ?? 0) <= now()) {
        return this.send('mastery-train', mastery.id, 'Raising ' + this.name(mastery.id) + ' from ' + mastery.level, { level: mastery.level, name: this.name(mastery.id) });
      }
      add(this.name(need?.ID) + ' cannot be raised: ' + (stop || 'recently refused'));
    }
    const rest = [...left].map(([why, n]) => n + ' ' + why).join(', ');
    this.stopMax('Max every skill: done, ' + this.total + ' learned or upgraded' + (rest ? '; still blocked: ' + rest : '') + '.');
  },
  status() { return this.message; },
  draw(parent) {
    const box = UI.group('Auto mastery and skills', UI.check('Raise selected masteries automatically', () => this.cfg().enabled, v => { this.cfg().enabled = v; this.pending = null; this.blocked.clear(); }));
    const rows = this.rows();
    if (!rows.length) box.append(el('p', 'Enter the game with a character to choose masteries.', 'muted'));
    for (const row of [...rows].sort((a, b) => a.id - b.id)) {
      box.append(UI.check(this.name(row.id) + ' (Lv ' + row.level + ')', () => this.cfg().ids.includes(row.id), v => {
        const ids = this.cfg().ids.filter(id => id !== row.id);
        if (v) ids.push(row.id);
        this.cfg().ids = ids;
      }));
    }
    box.append(UI.number('Keep this many levels below my level', () => this.cfg().gap, v => this.cfg().gap = v, 0, 50),
      UI.check('Upgrade my rotation and buff skills automatically', () => this.cfg().skills, v => { this.cfg().skills = v; this.pending = null; this.blocked.clear(); }),
      UI.select('Skills to upgrade', [['rotation', 'Only skills in my rotations, buffs and imbue'], ['all', 'All skills I have learned']], () => this.cfg().scope === 'all' ? 'all' : 'rotation', v => { this.cfg().scope = v; this.pending = null; this.blocked.clear(); }),
      UI.number('Keep this many skill points unspent', () => this.cfg().reserve, v => this.cfg().reserve = v, 0, 100000000),
      UI.select('Order when both are ticked', [['masteries', 'Masteries first'], ['skills', 'Skills first'], ['alternate', 'Alternate']], () => this.cfg().order, v => this.cfg().order = v));
    this.note = el('p', this.message, 'muted');
    box.append(this.note, el('p', 'Trains one level at a time and waits for each to be confirmed. Masteries are raised in the order you tick them until they reach your character level (or 120) minus the gap; level 0 is free, otherwise the price is the table cost of the current level. Skills are the next level of the attack, buff and imbue skills you already use, using the game\'s own requirements (mastery level, prerequisite skills, STR and INT, skill points). The reserve is never spent. Works while hunting is stopped and does nothing while you are dead. If the server refuses a level (for example its mastery total limit) the bot waits a minute before trying again. Off by default and saved per character.', 'muted'));
    parent.append(box);
    const max = UI.group('Max every skill', el('p', 'Learns and upgrades every skill, level by level, as fast as the game answers, and raises a mastery only when it is what blocks a skill (up to your character level, or 120). Skill points, strength and intelligence limits still apply, and it tells you what is left.', 'muted'));
    const button = UI.button(this.maxAll ? 'Stop' : 'Max every skill now', () => { if (this.maxAll) this.stopMax('Max every skill: stopped.'); else this.startMax(); button.textContent = this.maxAll ? 'Stop' : 'Max every skill now'; });
    UI.refreshers.push(() => { button.textContent = this.maxAll ? 'Stop' : 'Max every skill now'; });
    this.maxNote = el('p', this.maxMessage, 'muted'); max.append(button, this.maxNote); parent.append(max);
  },
};
// Optional features run behind the controller's guard so a bug in one can never stop hunting.
for (const [name, owner, method] of [['Party', Party, 'tick'], ['Party resurrection', Party, 'acceptResurrection'], ['Party resume', Party, 'resumeTick'], ['Auto mastery', AutoMastery, 'tick'], ['SoX alerts', Stats, 'soxFound']]) {
  const original = owner[method];
  owner[method] = function (...args) { return Controller.guard(name, () => original.apply(this, args)); };
}
