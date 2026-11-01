// Auto Quest. The game's own quest markers route every step: a marker names the quest (refId), the
// NPC (gid, region and position) and its state (1 offered, 2 in progress, 3 ready to report). The
// journal the server maintains (gp.quests) tells kinds and counts: a contents node with kind 0 has
// reached its count, and u10 is the quest's kind byte, where 2 opens the reward window. NPC talks
// run through the game's conversation state (gp.npcConversation): a kind-4 dialogue lists the quest
// rows, the chosen row's confirmation is a kind-3 Yes/No, and every answer comes back as a kind-1
// symbol line. A ready kind-2 quest is rewarded with the quest window's own quest-reward command
// without walking; every other quest is accepted and turned in at its NPC. Which dialogue row
// belongs to which quest is learned, not looked up: a row symbol carries the quest codename token
// (QNO_...), and the first acceptance binds that token to the refId the journal gains. Monster
// kills that advance a quest are learned the same way, and those monsters are hunted first while
// the quest is active.
const QUEST_REACH = 25;          // the game talks to an NPC within this reach
const QUEST_FIND = 300;          // the marker's NPC stands within this of its marker position
const QUEST_STEP_MS = 15000;     // selecting, the menu, a row choice and its confirmation
const QUEST_SETTLE_MS = 2500;    // after Yes: the journal may trail the answer line a little
const QUEST_REWARD_BACKOFF_MS = 60000;
const QUEST_REWARD_TRIES = 2;    // after this many refusals the reward waits for its NPC instead
const QUEST_VISIT_BACKOFF_MS = 600000;  // a failed NPC visit is not tried again for this long
const QUEST_WALK_MS = 300000;    // the walk to the NPC owns its own caps; this is only the ceiling
const QUEST_LEARN_MS = 8000;     // a kill within this of a journal advance names a quest target
const QUEST_SKIP_MS = 600000;    // a dialogue row that answered with a plain line is left alone this long

// The marker wire row is [u32 refId][u8 flags][u8 state][u16 region][i16 x][i16 y][i16 z][u32 npcGid];
// the client decode hands us the bytes, so the position is reassembled here.
function questMarkerPose(m) {
  if (!Array.isArray(m?.tail6) || !Number.isInteger(m.word)) return null;
  const point = i => { const v = (m.tail6[i] | 0) | ((m.tail6[i + 1] | 0) << 8); return v >= 0x8000 ? v - 0x10000 : v; };
  return { regionId: m.word, x: point(0), y: point(2), z: point(4) };
}
// An SN_TALK line carries the codename plus a line suffix (quest QNO_..._1, line _01); a title row
// (SN_CON_...) has no suffix. The same symbol always yields the same token, so binding and
// matching stay consistent.
function questToken(symbol) {
  const s = String(symbol || ''), hit = /QNO_[A-Z0-9_]+/.exec(s);
  if (!hit) return '';
  return s.startsWith('SN_TALK_') ? hit[0].replace(/_[0-9]{1,2}$/, '') : hit[0];
}

const Quest = {
  trip: null, resuming: false, idle: '', noPoseAt: -Infinity, message: '', progressSeq: 0, kills: [], rewardSent: null, abandonSent: null,
  refused: new Map(),      // refId -> { count, at }: refused quest-reward commands
  visitFail: new Map(),    // refId -> at: a failed NPC visit waits this quest out
  rows: new Map(),         // dialogue row symbol -> skip-until timestamp
  cfg() { return Settings.profile.quest; },
  on() { return !!this.cfg().on; },
  markers() { return World.gp?.questMarkers || []; },
  marker(refId) { return this.markers().find(m => m.refId === refId) || null; },
  journal() { return World.gp?.quests || []; },
  record(refId) { return this.journal().find(r => r.refId === refId) || null; },
  completed(refId) { return (World.gp?.completedQuests || []).includes(refId); },
  token(refId) {
    const learned = this.cfg().learned || {};
    return Object.keys(learned).find(t => learned[t] === refId) || '';
  },
  label(p) { return this.token(p.refId) || 'quest #' + p.refId; },
  // Codename include/exclude patterns, like the hunt name lists but case-sensitive: QNO_ tokens are
  // codenames, not display names. An unknown quest is wanted: without a learned token there is
  // nothing to match against.
  wanted(refId) {
    const c = this.cfg(), token = this.token(refId);
    if (!token) return true;
    const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
    const inc = list(c.include), exc = list(c.exclude);
    if (inc.length && !inc.some(s => token.includes(s))) return false;
    if (exc.some(s => token.includes(s))) return false;
    return true;
  },
  blocked() {
    if (Town.trip) return 'a town trip is running';
    if (Restock.trip || Restock.recording || Restock.activeShop()) return 'shopping is running';
    if (World.gp?.storage) return 'the storage is open';
    if (Stall.run || Trade.run) return 'a town session is running';
    if (Alchemy.run || Alchemy.pending) return 'alchemy is running';
    if (BuffGear.run || BuffGear.recovery) return 'a buff gear swap is running';
    if (WalkBack.active || Travel.active) return 'a walk is running';
    if (Resurrect.trip) return 'a resurrect trip is running';
    if (World.gp?.inventoryPending) return 'the inventory is busy';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'manual control is recent';
    return '';
  },
  // Report an active quest before accepting a new one, and the quest window's own reward command
  // before a walk. Delivery and talk quests report at their NPC even without a counter.
  plan() {
    this.why = '';
    const skip = this.cfg().skip || [];
    const cooled = refId => { const at = this.visitFail.get(refId); return at === undefined || now() - at >= QUEST_VISIT_BACKOFF_MS; };
    for (const r of this.journal()) {
      if (skip.includes(r.refId) || this.completed(r.refId) || !this.wanted(r.refId)) continue;
      const marker = this.marker(r.refId);
      if (r.contents?.[0]?.kind !== 0 && marker?.valueA !== 3) continue;
      const refusals = this.refused.get(r.refId);
      if (r.u10 === 2 && (refusals?.count || 0) < QUEST_REWARD_TRIES) return { intent: 'reward', refId: r.refId, record: r, marker };
      const npc = cooled(r.refId) ? this.npcRoute(marker) : null;
      if (npc) return { intent: 'report', refId: r.refId, marker, npc };
    }
    const open = this.journal().filter(r => !skip.includes(r.refId) && !this.completed(r.refId)).length;
    if (!this.cfg().accept) { this.why = open ? open + ' quest(s) in progress; hunting for kills.' : 'Nothing to do: accepting new quests is off.'; return null; }
    let offered = 0, filtered = 0, unrouted = 0;
    for (const m of this.markers()) {
      // A repeatable quest offers again after completion (the server's marker is the authority on
      // what can be accepted now), so only an active journal row or your lists keep a quest out.
      if (m.valueA !== 1 || this.record(m.refId) || skip.includes(m.refId)) continue;
      offered++;
      if (!this.wanted(m.refId) || !cooled(m.refId)) { filtered++; continue; }
      const npc = this.npcRoute(m);
      if (npc) return { intent: 'accept', refId: m.refId, marker: m, npc };
      unrouted++;
    }
    const n = this.markers().length;
    this.why = open ? open + ' quest(s) in progress; hunting for kills.' :
      !n ? 'The game shows no quest markers (no quest NPC known yet).' :
      !offered ? 'No NPC offers a quest right now (' + n + ' marker' + (n === 1 ? '' : 's') + ', none open).' :
      unrouted ? unrouted + ' offered quest(s) have an NPC in another region or no position; only the current region is walked to.' :
      filtered + ' offered quest(s) are excluded by your lists or waiting after a failed visit.';
    return null;
  },
  // Same-region NPCs only: an adjacent region's marker position is a world-grid planar distance
  // away, and v1 leaves cross-region quest routes to a later travel plan.
  npcRoute(marker) {
    const pose = marker && questMarkerPose(marker), here = World.pose();
    if (marker && !pose && now() - this.noPoseAt > 60000) { this.noPoseAt = now(); Log.warn('Quest: the marker of quest #' + marker.refId + ' has no position; it cannot be routed.'); }
    if (!pose || !here || pose.regionId !== here.regionId) return null;
    return { gid: marker.flags & 2 ? marker.optional : 0, pose };
  },
  // Observation runs every tick beside hunting: journal watching, the direct reward command, and
  // starting NPC trips when nothing else owns the character.
  // The player's own Abandon button: one command, answered by the journal. Manual, never retried
  // by the bot itself.
  abandon(refId) {
    if (this.trip || this.abandonSent || World.gp?.questPending || !this.record(refId)) return;
    if (!Cmd.spaced('quest-abandon') || !Cmd.raw({ kind: 'quest-abandon', refId }, 'Quest: abandon ' + this.label({ refId }))) return;
    this.abandonSent = { refId, at: now(), revision: World.gp?.revision ?? 0 };
    Log.info('Quest: abandoning ' + this.label({ refId }) + '.');
  },
  observe() {
    if (!this.on()) { this.idle = ''; return; }
    if (this.trip) return;
    if (!World.inWorld() || World.isDead()) { this.idle = 'Waiting for the game world.'; return; }
    if (this.abandonSent && now() - this.abandonSent.at > 10000) this.abandonSent = null;
    // A reward whose answer never came counts as a refusal: after two the NPC route takes over,
    // so a wedged transaction (the worker's single quest slot never clearing) cannot stall the
    // quest forever.
    if (this.rewardSent && now() - this.rewardSent.at > 10000) {
      const refId = this.rewardSent.refId;
      this.rewardSent = null;
      this.refused.set(refId, { count: (this.refused.get(refId)?.count || 0) + 1, at: now() });
      Log.warn('Quest: the reward of ' + this.label({ refId }) + ' was never answered; ' +
        ((this.refused.get(refId)?.count || 0) >= QUEST_REWARD_TRIES ? 'waiting for its NPC instead.' : 'trying again in a minute.'));
    }
    const p = this.plan();
    if (!p) { this.note(this.why); return; }
    if (p.intent === 'reward') { this.note('Claiming the reward of ' + this.label(p) + '.'); this.sendReward(p); return; }
    const busy = this.blocked();
    if (busy) { this.note('Waiting to visit ' + this.label(p) + ': ' + busy + '.'); return; }
    this.begin(p);
  },
  // The quest window's own reward command needs no NPC: one send, then the journal answers. Only
  // one reward is outstanding at a time, and a refusal is never retried at once.
  sendReward(p) {
    if (this.rewardSent) return;
    const back = this.refused.get(p.refId);
    if (back && now() - back.at < QUEST_REWARD_BACKOFF_MS) return;
    if (World.gp?.questPending) return;
    if (!Cmd.spaced('quest-reward') || !Cmd.raw({ kind: 'quest-reward', refId: p.refId }, 'Quest: claim the reward of ' + this.label(p))) return;
    this.rewardSent = { refId: p.refId, at: now(), revision: World.gp?.revision ?? 0 };
    this.message = 'Quest: claiming the reward of ' + this.label(p) + '.';
    Log.info(this.message);
  },
  // Journal watching on every gameplay push: settle the direct reward, and learn which monsters
  // advance which quest from the journal's own sequenced progress events.
  watch(gp) {
    if (this.abandonSent && gp) {
      const refId = this.abandonSent.refId;
      if (!gp.quests?.some(r => r.refId === refId)) {
        this.abandonSent = null;
        this.visitFail.delete(refId); this.refused.delete(refId);
        this.message = 'Quest: ' + this.label({ refId }) + ' abandoned.';
        Log.info(this.message); UI.toast(this.message, 'info', 4000);
      } else if ((gp.revision ?? 0) > this.abandonSent.revision && !gp.questPending && now() - this.abandonSent.at > 1500) {
        // The transaction was released without a journal change: the game refused the abandon.
        this.abandonSent = null;
        Log.warn('Quest: the game refused to abandon ' + this.label({ refId }) + '.');
      }
    }
    if (this.rewardSent && gp) {
      const refId = this.rewardSent.refId;
      const stillThere = (gp.quests || []).some(r => r.refId === refId);
      if (gp.questPending === refId) this.rewardSent.seenPending = true;
      if (!stillThere || (gp.completedQuests || []).includes(refId)) {
        this.refused.delete(refId);
        this.rewardSent = null;
        this.message = 'Quest: ' + this.label({ refId }) + ' completed.';
        Log.info(this.message); UI.toast(this.message, 'info', 4000);
      } else if ((gp.revision ?? 0) > this.rewardSent.revision && !gp.questPending &&
          (this.rewardSent.seenPending || now() - this.rewardSent.at > 4000)) {
        // The pending transaction was released without a journal change: the server refused. The
        // seen-pending gate keeps a slow push from being misread as the refusal.
        const back = this.refused.get(refId);
        this.refused.set(refId, { count: (back?.count || 0) + 1, at: now() });
        this.rewardSent = null;
        this.message = 'Quest: the reward of ' + this.label({ refId }) + ' was refused' +
          ((this.refused.get(refId)?.count || 0) >= QUEST_REWARD_TRIES ? '; waiting for its NPC instead.' : '; trying again in a minute.');
        Log.warn(this.message);
      }
    }
    for (const e of gp?.questProgress || []) {
      if (!Number.isInteger(e.sequence) || e.sequence <= this.progressSeq) continue;
      this.progressSeq = e.sequence;
      const before = e.before?.objectiveValues?.[0] ?? 0, after = e.after?.objectiveValues?.[0] ?? 0;
      if (after <= before) continue;
      // Kills only advance a counter while hunting; a collection can also grow from a pickup, but
      // the refObjIds learned that way are still what the quest wants more of.
      const recent = this.kills.filter(k => now() - k.at <= QUEST_LEARN_MS).map(k => k.ref);
      if (!recent.length) continue;
      const targets = new Set([...((this.cfg().targets || {})[e.refId] || []), ...recent]);
      this.cfg().targets = { ...(this.cfg().targets || {}), [e.refId]: [...targets].slice(0, 8) };
      Settings.saveProfile();
      Log.info('Quest: learned ' + [...targets].length + ' monster type(s) that advance ' + this.label({ refId: e.refId }) + '.');
    }
  },
  // The monster types that advance an active, unskipped quest; the hunt prefers them (lean-controller.js).
  preferred() {
    const out = new Set(), skip = this.cfg().skip || [];
    for (const r of this.journal()) {
      if (skip.includes(r.refId) || this.completed(r.refId)) continue;
      for (const ref of (this.cfg().targets || {})[r.refId] || []) out.add(ref);
    }
    return out;
  },
  npcEntity(t) {
    if (t.npc?.gid) { const e = World.ents.get(t.npc.gid); if (e?.kind === 'npc') return e; }
    const pose = t.npc?.pose;
    if (!pose) return null;
    let best = null;
    for (const e of World.ents.values())
      if (e.kind === 'npc' && dist2D(e, pose) <= QUEST_FIND && (!best || dist2D(e, pose) < dist2D(best, pose))) best = e;
    return best;
  },
  begin(p) {
    const pose = World.pose();
    if (!pose || !p.npc?.pose || !Number.isFinite(dist2D(pose, p.npc.pose))) { this.message = 'Quest stopped: the quest NPC could not be reached from here.'; Log.warn(this.message); return; }
    const wasHunting = Hunt.running;
    if (wasHunting) Hunt.stop('visiting a quest NPC');
    // The visit's policy snapshot: learned tokens and kill targets fill themselves during the
    // visit, so only what you set belongs here.
    const cfg = this.cfg(), cfgKey = JSON.stringify([cfg.on, cfg.accept, cfg.include, cfg.exclude, cfg.skip]);
    this.trip = { ...p, phase: 'walk', at: now(), manualAt: Manual.lastAt, wasHunting, cfgKey,
      talked: false, revision: 0, rowSymbol: '', yes: false };
    this.message = 'Quest: ' + (p.intent === 'accept' ? 'accepting ' : 'turning in ') + this.label(p) + ' at the NPC.';
    Log.info(this.message);
    const t = this.trip;
    if (dist2D(pose, p.npc.pose) <= QUEST_REACH) { t.phase = 'select'; return; }
    if (!WalkBack.startTo(p.npc.pose, { label: 'the quest NPC', stop: QUEST_REACH,
      onDone: () => { if (Quest.trip === t && t.phase === 'walk') { t.phase = 'select'; t.at = now(); } },
      onFail: reason => { if (Quest.trip === t) Quest.fail(reason || 'the walk to the quest NPC gave up'); } })) this.fail('the walk to the quest NPC did not start');
  },
  tick() {
    const t = this.trip;
    if (!t) return;
    const gp = World.gp;
    if (!this.on() || t.cfgKey !== JSON.stringify([this.cfg().on, this.cfg().accept, this.cfg().include, this.cfg().exclude, this.cfg().skip])) return this.fail('settings changed during the quest');
    if (!World.inWorld()) return;
    if (World.isDead()) return this.fail('the character died');
    if (Manual.lastAt !== t.manualAt) return this.fail('manual control');
    if (t.phase === 'walk') {
      // Our own walk is driven by WalkBack (its caps fail through onFail); this ceiling only ends
      // a walk whose WalkBack was silently replaced by another start.
      if (WalkBack.active) WalkBack.tick();
      else if (now() - t.at > 3000) this.fail('the walk to the quest NPC was replaced');
      if (now() - t.at > QUEST_WALK_MS) this.fail('the walk to the quest NPC took too long');
      return;
    }
    if (gp.inventoryPending) return;
    if (t.phase !== 'close' && now() - t.at > QUEST_STEP_MS) return this.fail('the quest NPC did not answer in time');
    if (t.phase === 'select') {
      const npc = this.npcEntity(t);
      if (!npc) return;                                   // the NPC spawns near its marker; the step timeout fails the trip
      if (gp.targetPending) return;
      if (gp.target !== npc.gid) { if (Cmd.spaced('select')) Cmd.select(npc.gid); return; }
      if (t.intent === 'accept' && this.markers().length && !this.marker(t.refId)) return this.fail('the quest is no longer offered');
      if (!(gp.targetCapabilities & 2)) return this.fail('the NPC cannot be talked to');
      t.phase = 'talk'; t.at = now(); t.talked = false; t.seenRevision = gp.npcConversation?.dialogueRevision || 0;
      return;
    }
    if (t.phase === 'talk') {
      const conv = gp.npcConversation;
      if (conv?.phase === 'ready' && conv.dialogue) {
        if (conv.dialogue.kind === 4) { t.phase = 'choose'; t.at = now(); return; }
        // A plain line already handled (an informational row) is asked past; a fresh one means
        // this NPC answers talks without a quest menu.
        if (conv.dialogueRevision !== (t.seenRevision || 0)) return this.fail('the NPC showed no quest menu');
      }
      // npc-talk is valid from the menu and from a closed-out answer line alike.
      if ((conv?.phase === 'menu' || conv?.phase === 'ready') && conv.gid === gp.target && !t.talked && now() - t.at > 1200 &&
          Cmd.raw({ kind: 'npc-talk' }, 'Quest: talk to the NPC')) t.talked = true;
      return;
    }
    if (t.phase === 'choose') {
      const conv = gp.npcConversation, dialogue = conv?.phase === 'ready' ? conv.dialogue : null;
      if (dialogue?.kind !== 4) return;                   // still waiting for the menu (a retry talk)
      const row = this.row(t, dialogue);
      if (!row) return this.fail('could not tell which dialogue row is the quest');
      if (Cmd.spaced('npc-choice') && Cmd.raw({ kind: 'npc-choice', choice: row.choice }, 'Quest: choose the quest row')) {
        t.phase = 'confirm'; t.at = now(); t.revision = conv.dialogueRevision; t.rowSymbol = row.symbol; t.yes = false;
      }
      return;
    }
    if (t.phase === 'confirm') {
      const conv = gp.npcConversation, revision = conv?.dialogueRevision ?? t.revision;
      if (!t.yes) {
        if (conv?.phase === 'ready' && revision > t.revision) {
          if (conv.dialogue?.kind === 3) {
            if (Cmd.spaced('npc-choice') && Cmd.raw({ kind: 'npc-choice', choice: 2 }, 'Quest: confirm')) { t.yes = true; t.at = now(); }
          } else {
            // The row answered with a plain line: an informational row or an NPC service. Leave
            // that row alone for a while and ask for the menu again.
            this.rows.set(t.rowSymbol, now() + QUEST_SKIP_MS);
            Log.info('Quest: the dialogue row answered with a plain line; trying the next row.');
            t.phase = 'talk'; t.at = now(); t.talked = false; t.seenRevision = conv.dialogueRevision;
          }
        }
        return;
      }
      const record = this.record(t.refId), settled = conv?.phase === 'ready' && revision > t.revision + 1;
      if (t.intent === 'accept' && record) return this.finish(t, true);
      if (t.intent === 'report' && (!record || this.completed(t.refId))) return this.finish(t, true);
      if (settled && now() - t.at > QUEST_SETTLE_MS) return this.fail('the NPC refused the quest');
      return;
    }
    if (t.phase === 'close') {
      if (!t.closed && Cmd.raw({ kind: 'npc-close' }, 'Quest: close the dialogue')) t.closed = true;
      if (t.closed || now() - t.at > 3000) { this.trip = null; if (t.wasHunting && this.on() && World.inWorld()) this.resumeHunt(); }
      return;
    }
  },
  // The dialogue row for this quest. The learned token's row is exact. Without a binding only an
  // unclaimed row may be taken - a lone unknown row is most plausibly this quest's own - and a
  // turn-in additionally refuses to guess between several, because Yes on the wrong row acts on
  // whatever quest that row belongs to.
  row(t, dialogue) {
    const rows = (dialogue.options || []).filter(o => /QNO_/.test(o.symbol) && (this.rows.get(o.symbol) || 0) < now());
    if (!rows.length) return null;
    const token = this.token(t.refId), learned = this.cfg().learned || {};
    // Exact token equality: a substring match would let QNO_X_1 take QNO_X_12's row.
    const mine = token ? rows.find(o => questToken(o.symbol) === token) : null;
    if (mine) return mine;
    const unbound = rows.filter(o => { const ot = questToken(o.symbol); return !ot || learned[ot] === undefined || learned[ot] === t.refId; });
    if (!unbound.length) return null;
    return t.intent === 'report' && unbound.length > 1 ? null : unbound[0];
  },
  finish(t) {
    if (t.rowSymbol) {
      const token = questToken(t.rowSymbol);
      if (token) { this.cfg().learned = { ...(this.cfg().learned || {}), [token]: t.refId }; Settings.saveProfile(); }
    }
    this.refused.delete(t.refId);
    this.visitFail.delete(t.refId);
    this.message = 'Quest: ' + (t.intent === 'accept' ? 'accepted ' : '') + this.label(t) + (t.intent === 'report' ? ' completed.' : '.');
    Log.info(this.message); UI.toast(this.message, 'info', 4000);
    t.phase = 'close'; t.at = now(); t.closed = false;
  },
  fail(reason) {
    const t = this.trip;
    if (!t) return;
    this.trip = null;
    WalkBack.cancel('', false);
    this.visitFail.set(t.refId, now());
    if (World.gp?.npcConversation && World.gp.npcConversation.phase !== 'closed') Cmd.raw({ kind: 'npc-close' }, 'Quest: close the dialogue');
    this.message = 'Quest stopped: ' + reason + '.';
    Log.warn(this.message); UI.toast(this.message, 'warn', 6000);
    // Hunting restarts even dead: the controller's death lane then runs the configured revive.
    if (t.wasHunting && this.on() && reason !== 'manual control' && World.inWorld()) this.resumeHunt();
  },
  // Restarting the hunt after a visit is the same bot run: the mall silk budget must survive it.
  resumeHunt() { this.resuming = true; try { Hunt.start(); } finally { this.resuming = false; } },
  cancel() { this.trip = null; this.rewardSent = null; this.abandonSent = null; },
  reset() { this.cancel(); this.kills = []; this.refused.clear(); this.visitFail.clear(); this.rows.clear(); this.progressSeq = 0; this.message = ''; this.idle = ''; },
  // What the bot is waiting for while no visit runs; logged when it changes so a silent Start can be read.
  note(text) { if (text !== this.idle) { this.idle = text; if (text) Log.info('Quest: ' + text); } },
  status() { return this.trip ? this.message : this.on() ? this.idle : ''; },
  // The live journal for the panel: what is active, at which count, and what the bot is doing.
  listing() {
    return this.journal().filter(r => !this.completed(r.refId)).map(r => {
      const node = r.contents?.[0], marker = this.marker(r.refId);
      const targets = new Set((this.cfg().targets || {})[r.refId] || []);
      // A hint, not a rule: learned monsters nobody has spawned near are usually hunted elsewhere.
      const around = !targets.size || !Hunt.running || [...World.ents.values()].some(e => targets.has(e.refObjId));
      return { refId: r.refId, token: this.token(r.refId), progress: node?.objectiveValues?.[0] ?? null,
        done: node?.kind === 0 || marker?.valueA === 3, around, skipped: (this.cfg().skip || []).includes(r.refId) };
    });
  },
};
bus.on('gameplay', gp => Quest.watch(gp));
// A monster that despawns after our hunt engaged it is a kill to correlate with journal progress;
// monsters other players finished never touched by us are noise, not quest targets.
bus.on('despawn', e => {
  if (e?.kind !== 'monster' || !e.refObjId || !Quest.on()) return;
  if ((World.simNow() ?? 0) - (World.hitByUs.get(e.gid) ?? -Infinity) >= QUEST_LEARN_MS) return;
  Quest.kills.push({ ref: e.refObjId, at: now() });
  if (Quest.kills.length > 12) Quest.kills.shift();
});
bus.on('game-error', text => {
  const t = Quest.trip;
  if (t && ['talk', 'choose', 'confirm'].includes(t.phase)) Quest.fail(String(text || 'the game refused the quest dialogue'));
});
