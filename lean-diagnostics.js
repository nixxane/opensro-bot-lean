// Explicit report fields only: never export raw logs, profiles or game snapshots.
const Diagnostics = {
  history: [], errors: [], stops: [], last: '', started: false,
  number(value) { return Number.isFinite(value) ? value : null; },
  errorCode(message) {
    const text = String(message || '');
    for (const [pattern, code] of [
      [/Stale party join answer/i, 'stale-party-answer'],
      [/party matching.*pending/i, 'party-matching-pending'],
      [/(inventory|transaction).*pending|inventory.*busy/i, 'inventory-busy'],
      [/(bag|inventory).*(full|space|capacity)/i, 'bag-capacity'],
      [/COS ground|cos.pickup|pickup/i, 'pickup-error'],
      [/gold|money/i, 'insufficient-gold-or-payment'],
      [/timeout|timed out/i, 'timeout'],
      [/scroll|return|travel/i, 'travel-error'],
    ]) if (pattern.test(text)) return code;
    return 'unclassified-error';
  },
  // Why the bot stopped by itself, in the bot's own fixed wording (no names or places), newest last. A stopped bot shows only
  // "Bot stopped.", so without this a report cannot say what ended the run.
  noteStop(source, reason) {
    const text = String(reason || '').slice(0, 160);
    this.stops.push({ at: now(), source, reason: text || 'no reason given' });
    if (this.stops.length > 8) this.stops.shift();
  },
  start() {
    if (this.started) return;
    this.started = true;
    bus.on('game-error', text => this.error(text));
    bus.on('log', entry => { if (entry.level === 'error' || entry.level === 'warn') this.error(entry.text); });
  },
  error(text) {
    const code = this.errorCode(text), previous = this.errors[this.errors.length - 1];
    if (previous?.code === code && now() - previous.at < 1000) return;
    this.errors.push({ at: now(), code });
    if (this.errors.length > 12) this.errors.shift();
  },
  party() {
    const c = Settings.profile.party, m = World.gp?.partyMatching, s = World.gp?.social;
    if (!c.autoRecruit && !c.autoAcceptMatching) return 'Party automation off.';
    if (!World.inWorld() || !m || !s || !Array.isArray(s.members)) return 'Party: waiting for game state.';
    if (!m.request) return m.own ? 'Party: waiting for applicants.' : c.autoRecruit ? 'Party: waiting for listing registration.' : 'Party: listing missing.';
    if (s.leader && (!s.self || s.self !== s.leader) || !s.leader && s.members.length) return 'Party join blocked: you are not the leader.';
    const options = Party.options(m, s);
    if (!Number.isInteger(options)) return 'Party join blocked: sharing options unknown.';
    if (s.members.length >= ((options & 1) ? 8 : 4)) return 'Party join blocked: party full.';
    const sim = World.simNow(), r = m.request;
    if (!Number.isFinite(sim) || !Number.isFinite(r.expires)) return 'Party join blocked: clock or deadline unknown.';
    if (sim >= r.expires) return 'Party join blocked: request expired.';
    if (![r.a, r.b].every(id => Number.isInteger(id) && id > 0 && id <= 0xffffffff)) return 'Party join blocked: invalid request.';
    if (Party.answered === `${r.a}:${r.b}:${r.expires}`) return 'Party: acceptance sent; waiting for confirmation.';
    return 'Party: application ready for acceptance.';
  },
  pet() {
    if (!Hunt.cfg().pickup.enabled || !Loot.petMode()) return '';
    if (!Hunt.running) return 'Pet collection paused: bot stopped.';
    const pet = Loot.pet();
    if (!pet) return 'Pet waiting: summon a pickup pet.';
    if (!Number.isInteger(pet.rec.commandMode)) return 'Pet waiting for settings.';
    if (pet.rec.commandMode & 128) return 'Pet waiting for broad auto-grab to turn off.';
    if (World.gp?.inventoryPending) return 'Pet waiting for inventory transaction.';
    if (Loot.pressed()) return 'Pet waiting briefly for potion use.';
    if (Loot.active?.petGid) return Loot.active.retryAt ? 'Pet pickup: retry pending.' : 'Pet pickup: waiting for collection confirmation.';
    if (pet.rec.inventory.length >= pet.rec.status) return 'Pet bag full; only compatible stacks can merge.';
    return 'Pet ready; waiting for eligible drops. ' + this.noLoot();
  },
  // Why nothing is being collected, counted from the drops in view. Counts only, no item names.
  noLoot() {
    const why = { failed: 0, far: 0, area: 0, owner: 0, filter: 0, pet: 0, petFar: 0, full: 0 }, unwanted = {};
    let seen = 0, ready = 0;
    if (!World.pose()) return '';
    for (const e of World.ents.values()) {
      if (e.kind !== 'ground-item') continue;
      seen++;
      const reason = Loot.whyNot(e);
      if (reason) { why[reason]++; if (reason === 'filter') { const k = Loot.filterWhy(e), u = unwanted[k] ||= { n: 0, ids: new Set() }; u.n++; u.ids.add(e.refObjId); } } else ready++;
    }
    if (!seen) return 'No drops in view.';
    const parts = [
      [why.filter, 'not wanted by your Loot settings (' + Object.entries(unwanted).sort((a, b) => b[1].n - a[1].n).map(([k, u]) => `${u.n} ${Loot.filterLabel(k)}` + (u.ids.size <= 3 ? ' #' + [...u.ids].join(' #') : '')).join(', ') + ')'],
      [why.far, 'too far from you (Pickup radius)'],
      [why.area, 'outside the hunting area'],
      [why.owner, 'it belongs to another player'],
      [why.petFar, 'too far from the pet'],
      [why.pet, 'the pet is not ready'],
      [why.full, 'no room in the bag'],
      [why.failed, 'recently failed'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Drops in view: ${seen}, ready to collect: ${ready}.` + (parts.length ? ` Not collected: ${parts.join('; ')}.` : '');
  },
  town() {
    if (!Town.cfg().enabled) return '';
    if (Town.trip) return '';
    if (!Hunt.running) return '';
    const blocked = Town.blocked();
    if (blocked) return 'Town return blocked: ' + blocked + '.';
    const c = Town.cfg();
    if (['arrival', 'vendor', 'smith', ...(Town.walks() ? [] : ['gate']), ...(c.petFull ? ['storage'] : [])].some(role => !c[role])) return 'Town return blocked: save missing service points in Supplies.';
    if (!Town.scroll(0x09ec)) return 'Town return blocked: return scroll missing.';
    if (Town.validate()) return 'Town return blocked: check refill targets, low-stock thresholds and gold.';
    return Town.reason() ? 'Town return: preparing departure.' : '';
  },
  // What the town trip is doing right now, in plain words (no names): the phase text it shows on the panel.
  townDetail() { return Town.trip ? String(Town.message || '').slice(0, 200) : ''; },
  // Why the current or last town trip started, with no item names, and how long ago.
  townReason() {
    const t = Town.trip ? { why: Town.trip.why, at: Town.trip.started } : Town.lastTrip;
    return t ? String(t.why || '').replace(/\s*\(.*\)/, '') + ' (' + Math.round((now() - t.at) / 1000) + ' s ago)' : '';
  },
  // Why no monster is being attacked, counted from the monsters in view with the same checks the hunt uses.
  // Counts only, no names. Short plain sentences, because the panel and bug reports are read by many languages.
  noTarget() {
    const H = Hunt.cfg(), pose = World.pose();
    if (!pose) return '';
    const sim = World.simNow() ?? 0, include = splitList(H.include), exclude = splitList(H.exclude);
    const why = { banned: 0, kind: 0, level: 0, name: 0, far: 0, others: 0 };
    let seen = 0;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e)) continue;
      seen++;
      const name = (e.name || '').toLowerCase(), level = e.level ?? 0;
      if (Hunt.banned(Hunt.ban, e.gid)) why.banned++;
      else if (!Hunt.classAllowed(e)) why.kind++;
      else if (H.levelMin && level < H.levelMin || H.levelMax && level > H.levelMax) why.level++;
      else if (include.length && !include.some(s => name.includes(s)) || exclude.some(s => name.includes(s))) why.name++;
      else if (!Hunt.inArea(e) || dist2D(pose, e) > H.chase) why.far++;
      else if (H.avoidKs && sim - (World.hitByOthers.get(e.gid) ?? -Infinity) < 8000 && sim - (World.hitByUs.get(e.gid) ?? -Infinity) > 8000) why.others++;
    }
    if (!seen) return 'No monsters in view. Move to a place with monsters and press "Set hunting spot here".';
    const parts = [
      [why.kind, 'monster type is switched off (Combat > Hunt area > Monster classes)'],
      [why.level, 'level is outside your minimum or maximum level'],
      [why.name, 'name is not in "Only these mobs" or is in "Skip these mobs"'],
      [why.far, 'too far (Hunt radius or Chase distance)'],
      [why.others, 'another player is fighting it'],
      [why.banned, 'recently given up (blocked or cannot be selected)'],
    ].filter(([n]) => n).map(([n, text]) => `${n}: ${text}`);
    return `Monsters in view: ${seen}. Skipped: ${parts.join('; ') || 'none'}.`;
  },
  main() {
    if (Trap.run) return Trap.message;
    if (Chase.owns()) return Chase.message || 'Checking obstacle approach.';
    if (BuffGear.run) return BuffGear.run.restoring ? 'Buff gear: restoring combat equipment.' : 'Buff gear: swapping or casting.';
    if (BuffGear.recovery) return 'Buff gear: manual equipment review needed. ' + String(BuffGear.message).slice(0, 160);
    if (Alchemy.pending) return Alchemy.run ? 'Alchemy: waiting for the server result.' : 'Alchemy stopped; outstanding result unconfirmed.';
    if (Alchemy.run) return 'Alchemy: preparing the next attempt.';
    if (Reconnect.active() && Reconnect.message && !World.inWorld()) return Reconnect.message;
    if (!World.inWorld()) return 'Waiting for game world.';
    if (World.isDead()) return 'Character dead; waiting for recovery.';
    if (Town.trip) {
      if (Town.trip.phase === 'buy') return Town.trip.supplies.map(s => `Refilling ${s.kind === 'hp' ? 'HP' : s.kind === 'mp' ? 'MP' : 'abnormal pills'}: ${Restock.count(s.refObjId)} / ${s.target}`).join(' · ');
      if (World.gp?.inventoryPending) return 'Town services: waiting for inventory transaction.';
      const phases = { recall: 'stopping combat for recall', 'recall-wait': 'waiting for recall arrival', 'reverse-wait': 'waiting for reverse arrival', 'revive-arrival': 'waiting for town revival', store: 'depositing loot', sell: 'selling pet loot', ammo: 'buying ammunition', repair: 'repairing equipment', reverse: 'opening reverse return', leave: 'starting the walk back' };
      if (/^(walk|open)-/.test(Town.trip.phase) && Town.message) return Town.message;
      return 'Town services: ' + (phases[Town.trip.phase] || 'travelling between or opening services') + '.';
    }
    if (Travel.active && !WalkBack.active) return Travel.status();
    if (WalkBack.active) return WalkBack.status();
    if (Restock.trip || Resurrect.trip) return 'Travelling; waiting to reach the destination.';
    if (!Hunt.running) return AutoStart.pending() ? AutoStart.message || 'Auto-start: waiting.' : Retry.stop && Retry.message ? Retry.message : 'Bot stopped.';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'Hunting paused after manual control.';
    if (Restock.activeShop() || World.gp?.storage) return 'Hunting paused: close shop or storage.';
    if (Hunt.state === 'resting' || Hunt.state === 'standing') return 'Recovering HP / MP.';
    if (Hunt.state === 'player') return 'Hunting paused by nearby-player setting.';
    if (Hunt.state === 'loot') return 'Character collecting; waiting for pickup confirmation.';
    if (Hunt.threatNote && Hunt.threatNote.gid === Hunt.targetGid) return Hunt.threatNote.text;
    if (World.isCasting()) return 'Combat: waiting for the current cast.';
    if (Hunt.state === 'fight' && Combat.fallbackNote()) return 'Combat: normal attack (' + Combat.fallbackNote() + ').';
    if (Hunt.targetGid) return 'Combat: approaching or attacking the target.';
    return 'Hunting: searching for an eligible target. ' + this.noTarget();
  },
  snapshot() {
    const gp = World.gp, c = Settings.profile, pet = Loot.pet(), social = gp?.social, matching = gp?.partyMatching;
    return {
      action: this.main(), partyStatus: this.party(), petStatus: this.pet(), townStatus: this.town(), townDetail: this.townDetail(), townReason: this.townReason(), sellStarStatus: String(SellStar.message || '').slice(0, 200),
      navigationReady: !!Navigation.scene, navigationError: String(Navigation.error || '').slice(0, 80),
      buffGearStatus: BuffGear.cfg().buffSwap ? String(BuffGear.status()).slice(0, 600) : '', buffGearActive: !!BuffGear.run, buffGearRestoring: !!BuffGear.run?.restoring, buffGearMovePending: !!BuffGear.run?.pending, buffGearRecovery: !!BuffGear.recovery,
      alchemyActive: !!Alchemy.run, alchemyPending: !!Alchemy.pending, alchemyAttempts: this.number(Alchemy.result?.attempts),
      alchemyTarget: this.number(Alchemy.run?.cfg.target), alchemySuccesses: this.number(Alchemy.result?.successes),
      alchemyFailures: this.number(Alchemy.result?.failures), alchemyElixirsUsed: this.number(Alchemy.result?.elixirs),
      alchemyPowdersUsed: this.number(Alchemy.result?.powders), alchemyResultFlags: this.number(gp?.alchemy?.flags),
      alchemyError: this.number(gp?.alchemy?.error), alchemyWindowVisible: !!gp?.alchemy?.visible,
      nativeAlchemyPending: !!gp?.alchemy?.pending,
      nativeAlchemyMode: ['reinforce', 'attribute', 'magic', 'compound', 'advanced', 'dissolve'].includes(gp?.alchemy?.mode) ? gp.alchemy.mode : null,
      movementPending: !!gp?.pendingMoves, returnScrollActive: !!gp?.returnScroll,
      running: !!Hunt.running, inWorld: World.inWorld(), dead: World.isDead(),
      inventoryPending: !!gp?.inventoryPending, casting: World.isCasting(),
      curePills: Restock.count(58), freeBagSlots: this.number(World.freeBagSlots()), hpPotions: Potion.count('hp'), mpPotions: Potion.count('mp'),
      petFreeSlots: pet ? this.number(pet.rec.status - pet.rec.inventory.length) : null,
      pickupPending: !!Loot.active, pickupRetry: !!Loot.active?.retryAt, pickupAttempts: this.number(Loot.active?.attempts),
      petSetupAttempts: this.number(Loot.petSetup?.attempts), speedScrollPending: !!SpeedScroll.pending,
      speedScrollAttempts: this.number(SpeedScroll.attempts),
      partyMembers: this.number(social?.members?.length), partyOptions: this.number(social?.options),
      partyLeader: !!social?.self && social.self === social.leader, ownListing: !!matching?.own,
      matchingStateKnown: !!matching, simulationClockKnown: Number.isFinite(World.simNow()),
      matchingPending: ['page', 'join', 'register', 'modify', 'delete'].includes(matching?.pending) ? matching.pending : null,
      matchingResult: this.number(matching?.result), registrationPending: !!Party.registration,
      joinRequest: !!matching?.request, acceptanceSent: !!matching?.request && Party.answered === `${matching.request.a}:${matching.request.b}:${matching.request.expires}`,
      requestRemainingMs: Number.isFinite(World.simNow()) && Number.isFinite(matching?.request?.expires) ? Math.max(0, matching.request.expires - World.simNow()) : null,
      townActive: !!Town.trip,
      townPhase: ['recall', 'recall-wait', 'revive-arrival', 'walk-arrival', 'walk-storage', 'open-storage', 'store', 'close-storage', 'walk-vendor', 'open-vendor', 'buy', 'close-vendor', 'walk-smith', 'open-smith', 'sell', 'repair', 'close-smith', 'walk-gate', 'open-gate', 'reverse', 'reverse-wait', 'leave', 'settle'].includes(Town.trip?.phase) ? Town.trip.phase : null,
      scrollAttempts: this.number(Town.trip?.scrollAttempts), scrollAccepted: !!Town.trip?.scrollRequest?.accepted,
      returnScroll: !!Town.scroll(0x09ec), reverseScroll: !!Town.scroll(0x19ec),
      settings: { autoRecruit: !!c.party.autoRecruit, autoAccept: !!c.party.autoAcceptMatching,
        townCycle: !!Town.cfg().enabled, revive: !!Town.cfg().revive, petFullReturn: !!Town.cfg().petFull,
        walkingRestock: !!Restock.cfg().enabled, buyHP: !!Restock.cfg().hp.on, buyMP: !!Restock.cfg().mp.on,
        hpTarget: this.number(Restock.cfg().hp.target), mpTarget: this.number(Restock.cfg().mp.target),
        buyCure: !!Restock.cfg().cure.on, cureTarget: this.number(Restock.cfg().cure.target), cureLow: this.number(Restock.cfg().cure.low),
        hpLow: this.number(Restock.cfg().hp.low), mpLow: this.number(Restock.cfg().mp.low),
        collectDrops: !!c.hunt.pickup.enabled, petCollector: Loot.petMode(), follow: Settings.profile.trace.enabled ? Trace.code : '', autoStatPoints: Settings.profile.statPoints.enabled ? String(StatPoints.status()).slice(0, 200) : '', autoMastery: AutoMastery.active() ? String(AutoMastery.message).slice(0, 600) : '', trapStage: Trap.stage, trapTile: Trap.stage ? Trap.tile : '', characterCollects: Loot.categories.some(k => c.hunt.pickup[k] && Loot.collectorFor(k) === 'character'), pickupRadius: this.number(c.hunt.pickup.radius / 10),
        finishFight: !!c.hunt.pickup.afterKillOnly, speedScroll: !!c.potion.speedScroll, autoStart: !!c.hunt.autoStart, retry: !!c.hunt.retry }
    };
  },
  sample() {
    try {
      const state = this.snapshot();
      // Deadline countdown alone is not a new state transition.
      const key = JSON.stringify({ ...state, requestRemainingMs: null });
      if (key !== this.last) { this.last = key; this.history.push({ at: now(), state }); }
      if (this.history.length > 30) this.history.shift();
      return state;
    } catch { return { action: 'Waiting for complete game state.' }; }
  },
  lines(state) {
    return [state.action, Settings.profile.party.autoRecruit || Settings.profile.party.autoAcceptMatching ? state.partyStatus : '', state.petStatus,
      state.townStatus].filter(Boolean).join('\n');
  },
  report() {
    const current = this.sample(), relative = entries => entries.map(({ at, ...entry }) => ({ secondsAgo: Math.max(0, Math.round((now() - at) / 1000)), ...entry }));
    return JSON.stringify({ app: 'nixxane bot', version: VERSION,
      privacy: 'Names, chat, account details, locations and raw logs are omitted. Error categories replace original messages.',
      playerStopped: RunIntent.stopped(), current, recentStates: relative(this.history), recentErrors: relative(this.errors), recentStops: relative(this.stops) }, null, 2);
  },
  async copy() {
    const text = this.report();
    try {
      await W.navigator.clipboard.writeText(text);
      UI.toast('Copied—paste this into your bug report.');
    } catch { UI.showDiagnostics(text); }
  },
};
// Every stop the bot makes by itself passes Retry.note (hunting, walk back, travel, world change). A town trip that fails
// before hunting has started again (after a revival) never reaches it, so that one is noted here.
{
  const note = Retry.note, failTown = Town.fail;
  Retry.note = function (reason) { if (reason) Diagnostics.noteStop('stop', reason); return note.apply(this, arguments); };
  Town.fail = function (reason) { const running = Hunt.running; if (!running) Diagnostics.noteStop('town', reason); return failTown.apply(this, arguments); };
}
