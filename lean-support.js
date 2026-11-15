// Party support: heal and buff party members with the player's own skills.
// Party members come from the party list (social.members); HP is exact for members in view (vitals) and in tenths
// otherwise (status & 15, as the game's party window draws it). Buffs a member already has are read from the
// effects the game shows on each player (gameplay.attachedEffects, keyed by gid and skill). Only members in view
// and within the support range are cast on; this never walks. One cast per tick, after potions and before hunting.
// Skill target bits (server SkillUiTarget): self 1, monster 4, ally 16, party 32, corpse 128.
const SUPPORT_TARGET_FRIEND = 16 | 32;
const SUPPORT_CONFIRM_MS = 6000;  // a buff cast that shows no effect on the member by then is a miss
const SUPPORT_BACKOFF_MS = 60000; // after two misses in a row that buff on that member waits a minute
const SUPPORT_WEAPON_BACKOFF_MS = 10 * 60000; // a buff that ends when the weapon changes back waits ten minutes
const SUPPORT_OVERLAP_MS = 30 * 60000; // a member whose buffs do not stack with ours waits for them to change, at most this
const SUPPORT_OVERLAP_KEY = /^UIIT_(STT_)?SKILL_USE_FAIL_OVERLAP(_COUNT)?$/;
const SUPPORT_EARLY_MS = 60000; // during a weapon change, buffs with less than this left are renewed too
const SUPPORT_BATCH = 10;       // most party buff casts added to one weapon change
const Support = {
  holdUntil: 0, sent: new Map(), misses: new Map(), overlaps: new Map(), early: new Set(), unblock: new Set(), lastBuff: null, message: 'Party support off.',
  cfg() { return Settings.profile.party.support; },
  reset() { this.holdUntil = 0; this.sent.clear(); this.misses.clear(); this.overlaps.clear(); this.early.clear(); this.unblock.clear(); this.lastBuff = null; },
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
  // Heals and buffs go to several members, so a refusal for one member (out of reach, a buff it cannot take) must not
  // hold the skill back from the others. Combat.blocked also counts whoever is selected, which is that member after a
  // refusal; here only the skill-wide block counts, and each member's own block is checked with blockedFor.
  castable(id) {
    return id && !this.blockedFor(id, 0) && Cmd.canCast(id) && Combat.mpOk(id, World.me());
  },
  blockedFor(id, gid) {
    const until = key => Combat.stuck?.get(key)?.until || 0, t = now();
    return t < until(id) || !!gid && t < until(Combat.failureKey(id, gid));
  },
  // Skills of the effects a member shows, other than this buff's own group.
  effects(gid, group) {
    return [...new Set((World.gp?.attachedEffects || []).filter(ef => ef && ef.gid === gid && World.skill(ef.skill)?.group !== group).map(ef => ef.skill))];
  },
  // The game refused this buff for this member because of an effect it already has ("cannot overlap", such as
  // Earth Fire Protection or Might Guard of Ice against a European defence buff). The member is skipped until one of
  // the effects it had then ends, so the other members are not held up.
  overlapped(m, b) {
    const key = m.name + ':' + b.group, o = this.overlaps.get(key);
    if (!o) return false;
    const current = new Set(this.effects(m.gid, b.group));
    if (now() < o.until && o.effects.every(id => current.has(id))) return true;
    this.overlaps.delete(key);
    return false;
  },
  // The notice names no skill, so it belongs to the party buff only while that buff is still the last thing cast.
  // Combat also counts the refusal against the member (Combat.fail); that block is lifted on the next tick so it
  // does not hold the skill back from self buffs and the rotation while the member stays selected. Without a known
  // effect to wait for (none visible), the member is tried again after a minute.
  notice(n) {
    const last = this.lastBuff;
    if (!last || now() - last.at > 2000 || !SUPPORT_OVERLAP_KEY.test(String(n?.key || ''))) return;
    this.lastBuff = null;
    if (Combat.lastCastId !== last.id || Combat.lastCastGid !== last.gid) return;
    const key = last.name + ':' + last.group, effects = this.effects(last.gid, last.group);
    // Still wearing this buff: an early renewal the game does not take. Wait until it has run out, then cast it again.
    if (this.has(last.gid, last.id, 0)) {
      this.early.add(key); this.sent.delete(key); this.unblock.add(Combat.failureKey(last.id, last.gid));
      Log.info(`Party support: ${last.name} still has ${World.skillName(last.id)}; renewing it once it runs out.`);
      return;
    }
    this.overlaps.set(key, { effects, until: now() + (effects.length ? SUPPORT_OVERLAP_MS : SUPPORT_BACKOFF_MS), combatKey: Combat.failureKey(last.id, last.gid) });
    this.sent.delete(key); this.misses.delete(key);
    Log.info(`Party support: ${last.name} has a buff that ${World.skillName(last.id)} does not stack with; skipping ${last.name} until it ends.`);
  },
  release() {
    for (const o of this.overlaps.values()) if (o.combatKey) { Combat.stuck?.delete(o.combatKey); o.combatKey = null; }
    for (const key of this.unblock) Combat.stuck?.delete(key);
    this.unblock.clear();
  },
  // Whether a party buff is still wanted on this member and castable: alive, in range and without it (or, when renewed
  // early during a weapon change, with less than earlyMs left).
  wants(b, name, earlyMs = 3000) {
    const m = this.members().find(x => x.name === name), id = this.skillOf(b);
    return !!(this.cfg().enabled && this.castable(id) && m && m.alive && m.inRange && !this.blockedFor(id, m.gid) && !this.has(m.gid, id, earlyMs) && !this.overlapped(m, b));
  },
  // The party buffs to cast now on each member, the caster last: a member without the buff, or with less than earlyMs
  // of it left. Casts waiting for confirmation, backoffs, refused members and blocked targets are left to the tick.
  dueBuffs(earlyMs) {
    const c = this.cfg(), t = now(), out = [];
    if (!c.enabled) return out;
    const members = this.members(), order = [...members.filter(m => !m.self), ...members.filter(m => m.self)];
    for (const b of c.buffs) {
      const id = this.skillOf(b);
      if (!id || !this.castable(id)) continue;
      const only = splitList(b.only || '');
      for (const m of order) {
        if (!m.alive || !m.inRange || only.length && !only.includes(String(m.name || '').toLowerCase())) continue;
        const key = m.name + ':' + b.group;
        if (this.sent.has(key) || this.early.has(key) && this.has(m.gid, id, 0) || t < (this.misses.get(key)?.until || 0)) continue;
        if (this.has(m.gid, id, earlyMs) || this.overlapped(m, b) || this.blockedFor(id, m.gid)) continue;
        out.push({ b, id, m, key });
      }
    }
    return out;
  },
  // One party buff on one member, as a weapon change casts it.
  // refused(): why the cast just sent will not land (a buff that does not stack, or any other refusal the game counted
  // against this member), so the weapon change moves on to the next one.
  entry(b, id, m, key, earlyMs = 3000) {
    return { party: true, id, key, due: () => this.wants(b, m.name, earlyMs), cast: () => this.castBuff(b, m.name), shows: () => this.shows(b, m.name), ended: () => this.ended(b, m.name),
      refused: () => this.overlaps.has(key) ? `${m.name} has a buff that ${World.skillName(id)} does not stack with.`
        : this.early.has(key) || this.blockedFor(id, m.gid) ? `${World.skillName(id)} did not go out on ${m.name}.` : '' };
  },
  // Party buffs that need this gear, for a weapon change that happens anyway: the due ones and the ones running out
  // within a minute, so the next change does not come a minute later. At most SUPPORT_BATCH of them.
  entriesFor(set, have = []) {
    const out = [];
    for (const { b, id, m, key } of this.dueBuffs(SUPPORT_EARLY_MS)) {
      if (out.length + have.length >= SUPPORT_BATCH || have.some(e => e.key === key) || out.some(e => e.key === key)) continue;
      const gear = BuffGear.forParty(b, id);
      if (gear && typeof gear !== 'string' && BuffGear.same(gear, set)) out.push(this.entry(b, id, m, key, SUPPORT_EARLY_MS));
    }
    return out;
  },
  // Cast a party buff at the member by name (called by a weapon swap once the gear is on).
  castBuff(b, name) {
    const m = this.members().find(x => x.name === name), id = this.skillOf(b);
    if (!m || !this.castable(id) || this.blockedFor(id, m.gid) || !this.cast(id, m, `${World.skillName(id)} on ${m.name}`)) return false;
    this.sent.set(m.name + ':' + b.group, now());
    this.early.delete(m.name + ':' + b.group);
    this.lastBuff = { id, group: b.group, name: m.name, gid: m.gid, at: now() };
    return true;
  },
  // Whether the member shows the buff at all, and what to do when it ended with the swapped weapon.
  shows(b, name) { const m = this.members().find(x => x.name === name); return !!m && this.has(m.gid, this.skillOf(b), 0); },
  ended(b, name) {
    this.misses.set(name + ':' + b.group, { n: 0, until: now() + SUPPORT_WEAPON_BACKOFF_MS });
    Log.warn(`Party support: ${World.skillName(this.skillOf(b))} on ${name} ended when the weapon changed back; trying again in ten minutes.`);
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
    this.release();
    if (!c.enabled) { this.message = 'Party support off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.message = 'Waiting for a living character.'; return false; }
    if (!Hunt.running && !c.whileStopped) { this.message = 'Waiting for hunting to start (or tick Also while hunting is stopped).'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return false;
    if (now() < this.holdUntil) return true;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending || World.gp.targetPending ||
      now() - Combat.lastCastAt < Settings.profile.macro.castGapMs) return false;
    const members = this.members(), party = members.filter(m => !m.self);
    if (!party.length && !c.heal.self && !c.mpHeal.self && !c.buffs.length) { this.message = 'Not in a party.'; return false; }
    const living = members.filter(m => m.alive && m.inRange && (!m.self || c.heal.self));
    const mpLiving = members.filter(m => m.alive && m.inRange && (!m.self || c.mpHeal.self));
    // 1. Group heal when enough members are low.
    const groupId = this.skillOf(c.group);
    if (groupId && this.castable(groupId)) {
      const low = living.filter(m => m.hpPct < c.group.pct), target = low.filter(m => !this.blockedFor(groupId, m.gid)).sort((a, b) => a.hpPct - b.hpPct)[0];
      if (low.length >= c.group.count && target) return this.cast(groupId, target, `group heal (${low.length} below ${c.group.pct}%)`);
    }
    // 2. Heal the lowest member below the threshold.
    const healId = this.skillOf(c.heal);
    if (healId && this.castable(healId)) {
      const low = living.filter(m => m.hpPct < c.heal.pct && !this.blockedFor(healId, m.gid)).sort((a, b) => a.hpPct - b.hpPct)[0];
      if (low) return this.cast(healId, low, `heal ${low.self ? 'myself' : low.name} (${Math.round(low.hpPct)}%)`);
    }
    // 3. Group MP restore when enough members are low.
    const mpGroupId = this.skillOf(c.mpGroup);
    if (mpGroupId && this.castable(mpGroupId)) {
      const low = mpLiving.filter(m => m.mpPct < c.mpGroup.pct), target = low.filter(m => !this.blockedFor(mpGroupId, m.gid)).sort((a, b) => a.mpPct - b.mpPct)[0];
      if (low.length >= c.mpGroup.count && target) return this.cast(mpGroupId, target, `group MP heal (${low.length} below ${c.mpGroup.pct}%)`);
    }
    // 4. Restore the lowest member's MP below the threshold.
    const mpHealId = this.skillOf(c.mpHeal);
    if (mpHealId && this.castable(mpHealId)) {
      const low = mpLiving.filter(m => m.mpPct < c.mpHeal.pct && !this.blockedFor(mpHealId, m.gid)).sort((a, b) => a.mpPct - b.mpPct)[0];
      if (low) return this.cast(mpHealId, low, `restore MP ${low.self ? 'myself' : low.name} (${Math.round(low.mpPct)}%)`);
    }
    // 5. Buffs a member does not have yet. A cast that never shows on the member counts as a miss. A buff that needs
    // other gear (the weapon its skill needs, or the gear chosen for it) is cast in a weapon swap that comes back after.
    const t = now();
    let note = '';
    const skipped = new Set();
    for (const b of c.buffs) {
      const id = this.skillOf(b);
      if (!id || !this.castable(id)) continue;
      const only = splitList(b.only || '');
      // The caster comes last: friendly buffs such as Body Deity and Soul Deity can be cast on oneself too.
      for (const m of [...party, ...members.filter(x => x.self)]) {
        if (!m.alive || !m.inRange || only.length && !only.includes(String(m.name || '').toLowerCase())) continue;
        const key = m.name + ':' + b.group, sent = this.sent.get(key), miss = this.misses.get(key) || { n: 0, until: 0 };
        if (this.has(m.gid, id)) { this.misses.delete(key); this.sent.delete(key); this.overlaps.delete(key); continue; }
        // A renewal the game refused while the buff was on: not again until it has run out.
        if (this.early.has(key)) { if (this.has(m.gid, id, 0)) continue; this.early.delete(key); }
        if (this.overlapped(m, b)) { skipped.add(m.name); continue; }
        if (this.blockedFor(id, m.gid) || t < miss.until) continue;
        if (sent && t - sent < SUPPORT_CONFIRM_MS) continue;
        if (sent) {
          miss.n++; this.sent.delete(key);
          if (miss.n >= 2) { miss.n = 0; miss.until = t + SUPPORT_BACKOFF_MS; Log.warn(`Party support: ${World.skillName(id)} did not show on ${m.name}; trying again in a minute.`); }
          this.misses.set(key, miss);
          if (t < miss.until) continue;
        }
        const gear = BuffGear.forParty(b, id);
        if (typeof gear === 'string') { note = gear; break; }
        if (gear) {
          if (BuffGear.startParty(gear, this.entry(b, id, m, key))) { this.message = `${World.skillName(id)} on ${m.name}: changing weapons.`; return true; }
          // Not now (fighting, a window open): the other buffs, which need no swap, still go out.
          note = BuffGear.waiting || `${World.skillName(id)} on ${m.name}: waiting to change weapons.`;
          break;
        }
        if (this.cast(id, m, `${World.skillName(id)} on ${m.name}`)) {
          this.sent.set(key, t); this.early.delete(key);
          this.lastBuff = { id, group: b.group, name: m.name, gid: m.gid, at: t };
          return true;
        }
        return false;
      }
    }
    const done = party.some(m => m.alive && !m.inRange) ? 'Some party members are out of view or out of range.' : 'Party is healed and buffed.';
    this.message = (note || done) + (skipped.size ? ` Skipped (a buff that does not stack): ${[...skipped].join(', ')}.` : '');
    return false;
  },
};
bus.on('notice', n => Support.notice(n));
