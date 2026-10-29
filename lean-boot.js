function toggleBot() {
  if (Alchemy.run || Alchemy.pending || Stall.run || Hunt.running || Town.trip || WalkBack.active || Travel.active || Restock.trip || Resurrect.trip || Controller.resumeAfterRevive) stopAll();
  else if (Restock.recording) UI.toast('Finish or cancel route recording before starting the bot.', 'warn');
  else Hunt.start();
}

function boot() {
  if (Setup.isNew()) UI.current = 'Setup';
  UI.mount(); Stats.init(); Updates.start(); Diagnostics.start();
  const unlockSound = e => {
    if (e.isTrusted && (Settings.profile.hunt.pickup.petFullSound || Settings.profile.hunt.pickup.soxSound)) Sound.unlock();
  };
  W.addEventListener('pointerdown', unlockSound, true);
  W.addEventListener('keydown', unlockSound, true);
  // The game listens globally and prevents bound keys even when a shadow-DOM
  // field owns focus. Stop propagation early, but retain native editing defaults.
  const protectEditing = e => {
    const path = e.composedPath(), target = path[0];
    const copyingLog = (e.ctrlKey || e.metaKey) && e.code === 'KeyC' && UI.selectedActivityText();
    if (copyingLog || path.includes(UI.root?.host) && (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || ''))) {
      e.stopImmediatePropagation();
    }
  };
  for (const type of ['keydown', 'keypress', 'keyup']) W.addEventListener(type, protectEditing, true);
  W.addEventListener('copy', e => {
    const text = UI.selectedActivityText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  // Scrolling the panel must not also zoom or move the game camera underneath it.
  W.addEventListener('wheel', e => { if (e.composedPath().includes(UI.root?.host)) e.stopImmediatePropagation(); }, { capture: true, passive: true });
  Combat.init(); Loot.init(); Alchemy.init(); BuffGear.init(); Stall.init();
  bus.on('character', name => {
    const key = name ? 'profile:' + name : 'profile:default';
    if (key !== Settings.profileKey) { Town.lastScrollPoint = null; Town.deathPoint = null; stopAll(); Settings.useCharacter(name); }
  });
  bus.on('profile', () => { PetPotion.reset(); AutoMastery.reset(); StatPoints.reset(); Trace.reset(); BuffGear.reset(); Team.reset(); Town.lastScrollPoint = null; Town.deathPoint = null; SpeedScroll.reset(); RepairHammer.reset(); Party.reset(); Resurrect.reset(); stopAll(); Restock.cancelRecording(); Loot.reset(); Wardrobe.applyNow(); UI.draw(); });
  bus.on('phase', phase => {
    if (phase !== 'world') {
      BuffGear.interrupt('World transition interrupted buff swaps.', true);
      Party.reset();
      SpeedScroll.reset();
      RepairHammer.reset();
      Resurrect.reset();
      if (Town.phase(phase) || Travel.phase(phase)) { Loot.reset(); return; }
      const revival = phase === 'entering-world' && Hunt.running && (Town.autoRevive() || Hunt.cfg().onDeath === 'revive') && (Hunt.state === 'dead' || Hunt.revived);
      stopAll(); Restock.cancelRecording(); Loot.reset();
      Controller.resumeAfterRevive = revival;
    }
  });
  bus.on('failure', () => { BuffGear.interrupt('Connection failed during buff swaps.'); stopAll(); Restock.cancelRecording(); UI.toast('Game connection failed; bot stopped.', 'warn'); });
  bus.on('reset', () => {
    BuffGear.interrupt('World reset interrupted buff swaps.', true);
    if (Town.trip) {
      if (['recall-wait', 'reverse-wait'].includes(Town.trip.phase)) Town.trip.transition = true;
      else Town.fail('Unexpected world reset during town service.');
    }
    SpeedScroll.reset(); RepairHammer.reset(); Party.reset(); Resurrect.reset(); Loot.reset(); Navigation.scene = null; Wardrobe.inv = Wardrobe.baseInv = Wardrobe.av = Wardrobe.baseAv = null; Wardrobe.body = '';
  });
  bus.on('attached', ({ late }) => { if (late) UI.toast('Attached after the game started. Reload for complete character data.', 'warn'); });
  bus.on('potion-empty', kind => UI.toast('Out of ' + kind.toUpperCase() + ' potions.', 'warn'));
  W.addEventListener('keydown', e => {
    if (!e.isTrusted || e.repeat || e.isComposing) return;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || '')) return;
    if (e.code === 'F8') { e.preventDefault(); e.stopImmediatePropagation(); toggleBot(); }
    else if (e.code === 'F6') { e.preventDefault(); e.stopImmediatePropagation(); UI.toggleMinimised(); }
    else if (e.code === 'F7') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.shiftKey) UI.toggleVisibility();
      else if (UI.minimised) UI.minimise(false);
      else UI.body.hidden = !UI.body.hidden;
    }
  }, true);
  Ticker.start(() => Controller.tick(), 100);
  setInterval(() => { Wardrobe.tick(); UI.update(); }, 500);
  W.SROLean = { version: VERSION, stats: Stats, updates: Updates, diagnostics: Diagnostics, reports: Reports, alchemy: Alchemy, buffGear: BuffGear, world: World, settings: Settings, hunt: Hunt, loot: Loot, speedScroll: SpeedScroll, repairHammer: RepairHammer, resurrect: Resurrect, stall: Stall, team: Team,
    restock: Restock, town: Town, walkBack: WalkBack, travel: Travel, antiStuck: AntiStuck, chase: Chase, trap: Trap, autoMastery: AutoMastery, statPoints: StatPoints, share: ProfileShare, trace: Trace, setup: Setup, reconnect: Reconnect, petPotion: PetPotion, navigation: Navigation, route: Route, wardrobe: Wardrobe, wardrobeData: WdData, learned: Learned, controller: Controller, ui: UI, activity: Activity, map: LeanMap, render: RenderControl, support: Support, items: ItemRules, stop: stopAll, log: Log };
  Log.info('NIX ready. F8 starts/stops; F7 folds; F6 or the × minimises and restores; Shift+F7 hides/shows the window.');
}

installWorkerHook();
if (document.documentElement) boot();
else document.addEventListener('DOMContentLoaded', boot, { once: true });
