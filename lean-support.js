// Party support: heal and buff party members with the player's own skills.
// Party members come from the party list (social.members); HP is exact for members in view (vitals) and in tenths
// otherwise (status & 15, as the game's party window draws it). Buffs a member already has are read from the
// effects the game shows on each player (gameplay.attachedEffects, keyed by gid and skill). Only members in view
// and within the support range are cast on; this never walks. One cast per tick, after potions and before hunting.
// Skill target bits (server SkillUiTarget): self 1, monster 4, ally 16, party 32, corpse 128.
const SUPPORT_TARGET_FRIEND = 16 | 32;
const SUPPORT_CONFIRM_MS = 6000;  // a buff cast that shows no effect on the member by then is a miss
const SUPPORT_BACKOFF_MS = 60000; // after two misses in a row that buff on that member waits a minute
const Support = {
  holdUntil: 0, sent: new Map(), misses: new Map(), message: 'Party support off.',
  cfg() { return Settings.profile.party.support; },
  reset() { this.holdUntil = 0; this.sent.clear(); this.misses.clear(); },
  // Skills that can be cast on another party member (heals and most buffs), best learned level per group.
  friendlySkills() {
    const best = new Map();
    for (const s of Learned.rows()) {
      if (s.missing || s.active === false || s.groundTarget || !s.targetRequired || !((s.targets ?? 0) & SUPPORT_TARGET_FRIEND)) continue;
      const group = s.group ?? s.id, previous = best.get(group);
      if (!previous || (s.level ?? 0) > (previous.level ?? 0)) best.set(group, s);
    }
    return [...best.values()];
  },
  // Skills without a target (area heals, party-wide buffs such as dances), for the group heal.
  areaSkills() { return UI.learnedSkills(true); },
  skillOf(entry) { return entry?.group ? World.bestOfGroup(entry.group, entry.id) || entry.id : 0; },
  // The local player first (for "heal myself too"), then every party member, with what is known about each.
  members() {
    const social = World.gp?.social, pose = World.pose(), range = (Number(this.cfg().range) || 30) * 10, local = World.localGid();
    const out = [];
    const me = World.me();
    out.push({ self: true, name: World.charName, gid: local, entity: World.local(), hpPct: me.hpPct, mpPct: me.mpPct, alive: !World.isDead(), inRange: true, distance: 0 });
    for (const m of social?.members || []) {
      if (!m?.name || m.name === social.localName || m.id === social.self) continue;
      const e = [...World.ents.values()].find(x => x && x.kind === 'player' && x.name === m.name);
      const exact = e ? World.hpPctOf(e) : null, distance = e ? dist2D(pose, e) : Infinity;
      out.push({ self: false, name: m.name, level: m.level, gid: e?.gid || 0, entity: e || null, distance,
        hpPct: exact ?? Math.min(10, m.status & 15) * 10, mpPct: Math.min(10, m.status >>> 4) * 10,
        alive: (m.status & 15) !== 0 && e?.appearanceState?.[0] !== 2, inRange: !!e && distance <= range });
    }
    return out;
  },
  // Whether a member shows an effect of this skill's group, with more than refreshMs left when the game says.
  has(gid, id, refreshMs = 3000) {
    const group = World.skill(id)?.group, t = World.simNow();
    for (const ef of World.gp?.attachedEffects || []) {
      if (!ef || ef.gid !== gid || !(ef.skill === id || group !== undefined && World.skill(ef.skill)?.group === group)) continue;
      if (Number.isFinite(ef.remainingMs) && Number.isFinite(ef.receivedAtMs) && t != null && ef.remainingMs - (t - ef.receivedAtMs) <= refreshMs) continue;
      return true;
    }
    return false;
  },
  ready(id) {
    return id && !Combat.blocked?.(id) && Cmd.canCast(id) && Combat.mpOk(id, World.me());
  },
  // Select the member and cast at them; a skill without a target is simply cast.
  cast(id, member, why) {
    const s = World.skill(id), t = now();
    if (s?.targetRequired && member && !member.self) {
      if (!Cmd.select(member.gid) || !Combat.cast(id, member.gid)) return false;
    } else if (!Combat.cast(id, s?.targetRequired ? World.localGid() : 0)) return false;
    this.holdUntil = t + Math.max(800, s?.actionMs || 1000) + 300;
    this.message = why;
    Log.info('Party support: ' + why);
    return true;
  },
  tick() {
    const c = this.cfg();
    if (!c.enabled) { this.message = 'Party support off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character.'; return false; }
    if (!Hunt.running && !c.whileStopped) { this.message = 'Waiting for hunting to start (or tick Also while hunting is stopped).'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return false;
    if (now() < this.holdUntil) return true;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending || World.gp.targetPending ||
      now() - Combat.lastCastAt < Settings.profile.macro.castGapMs) return false;
    const members = this.members(), party = members.filter(m => !m.self);
    if (!party.length && !c.heal.self && !c.buffs.length) { this.message = 'Not in a party.'; return false; }
    const living = members.filter(m => m.alive && m.inRange && (!m.self || c.heal.self));
    // 1. Group heal when enough members are low.
    const groupId = this.skillOf(c.group);
    if (groupId && this.ready(groupId)) {
      const low = living.filter(m => m.hpPct < c.group.pct);
      if (low.length >= c.group.count) return this.cast(groupId, low.sort((a, b) => a.hpPct - b.hpPct)[0], `group heal (${low.length} below ${c.group.pct}%)`);
    }
    // 2. Heal the lowest member below the threshold.
    const healId = this.skillOf(c.heal);
    if (healId && this.ready(healId)) {
      const low = living.filter(m => m.hpPct < c.heal.pct).sort((a, b) => a.hpPct - b.hpPct)[0];
      if (low) return this.cast(healId, low, `heal ${low.self ? 'myself' : low.name} (${Math.round(low.hpPct)}%)`);
    }
    // 3. Buffs a member does not have yet. A cast that never shows on the member counts as a miss.
    const t = now();
    for (const b of c.buffs) {
      const id = this.skillOf(b);
      if (!id || !this.ready(id)) continue;
      const only = splitList(b.only || '');
      // The caster comes last: friendly buffs such as Body Deity and Soul Deity can be cast on oneself too.
      for (const m of [...party, ...members.filter(x => x.self)]) {
        if (!m.alive || !m.inRange || only.length && !only.includes(String(m.name || '').toLowerCase())) continue;
        const key = m.name + ':' + b.group, sent = this.sent.get(key), miss = this.misses.get(key) || { n: 0, until: 0 };
        if (this.has(m.gid, id)) { this.misses.delete(key); this.sent.delete(key); continue; }
        if (t < miss.until) continue;
        if (sent && t - sent < SUPPORT_CONFIRM_MS) continue;
        if (sent) {
          miss.n++; this.sent.delete(key);
          if (miss.n >= 2) { miss.n = 0; miss.until = t + SUPPORT_BACKOFF_MS; Log.warn(`Party support: ${World.skillName(id)} did not show on ${m.name}; trying again in a minute.`); }
          this.misses.set(key, miss);
          if (t < miss.until) continue;
        }
        if (this.cast(id, m, `${World.skillName(id)} on ${m.name}`)) { this.sent.set(key, t); return true; }
        return false;
      }
    }
    this.message = party.some(m => m.alive && !m.inRange) ? 'Some party members are out of view or out of range.' : 'Party is healed and buffed.';
    return false;
  },
};
