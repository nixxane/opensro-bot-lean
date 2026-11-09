// The Setup page: a live checklist of what the bot needs before F8 is worth pressing. Every row reads the real state of
// the character and the settings, says in a sentence what is missing, and has one button that fixes it or opens the right
// page. Nothing changes unless a button is pressed. The starter settings are changes laid over the current settings, shown
// first and undoable like an import.
const SETUP_PRESETS = {
  levelup: { name: 'Level up', text: 'Kills normal, champion and giant monsters, picks up gold, gear and elixirs only.',
    settings: { hunt: { radius: 400, classes: { normal: true, champion: true, giant: true, party: false, elite: false, unique: false, titan: false },
      pickup: { enabled: true, gold: true, potions: false, equipment: true, elixirs: true, powders: false, magicStones: false, attrStones: false, alchemy: false, others: false } } } },
  drops: { name: 'Farm drops', text: 'Also fights elite monsters, roams wider and picks up everything.',
    settings: { hunt: { radius: 600, classes: { normal: true, champion: true, giant: true, party: false, elite: true, unique: false, titan: false },
      pickup: { enabled: true, gold: true, potions: true, equipment: true, elixirs: true, powders: true, magicStones: true, attrStones: true, alchemy: true, others: true } } } },
  safe: { name: 'Safe AFK', text: 'Stops on death, a full bag or no potions, warns about other players and rests earlier.',
    settings: { hunt: { onDeath: 'stop', stopNoHpPotion: true, stopInvFull: true, playerAlert: { enabled: true, radius: 250, pause: true },
      sit: { enabled: true, hpBelow: 40, mpBelow: 25, resumeAt: 90 }, antiStuck: { enabled: true, minutes: 3, maxRecoveries: 3 } },
      potion: { hp: { on: true, pct: 65 }, mp: { on: true, pct: 40 } } } },
};
const Setup = {
  box: null, rows: null, score: null, key: '', townPick: '', preview: null, previewNote: null, previewList: null,
  // Skill groups in all attack rotations.
  skills() {
    const seen = new Set();
    for (const key of CLASS_KEYS) for (const e of Settings.profile.macro.rotations[key] || []) seen.add(e.group ?? e.id);
    return seen.size;
  },
  potions() { return World.items().filter(i => ItemType.isPotion(i.typeFlags)).reduce((n, i) => n + (i.quantity || 0), 0); },
  town() { return this.townPick || Town.detect()?.key || Town.towns[0].key; },
  open(page, tab) { UI.show(page, tab); },
  // The checklist. `state` is ok, warn (works but could be better) or bad (the bot cannot do its job yet).
  steps() {
    const p = Settings.profile, H = p.hunt, T = Town.cfg(), inWorld = World.inWorld(), gp = World.gp;
    const weapon = (gp?.inventory || []).find(i => i.slot === 6), out = [];
    out.push(inWorld
      ? { id: 'character', icon: 'action\\icon_cha_helper', state: weapon ? 'ok' : 'warn', title: 'Character found',
          text: `${World.charName || 'Your character'}${Number.isInteger(gp?.progression?.level) ? ' · Lv ' + gp.progression.level : ''}${weapon ? ' · ' + (weapon.name || Items.name(weapon.refObjId)) : ' · no weapon equipped, equip one before hunting'}.` }
      : { id: 'character', icon: 'action\\icon_cha_helper', state: 'bad', title: 'Character', text: 'Enter the game with a character first; everything below reads from it.' });
    out.push(H.center
      ? { id: 'spot', icon: 'item\\etc\\mall_return_scroll', state: 'ok', title: 'Hunting spot', text: `Saved, roaming up to ${Math.round(H.radius / 10)} m around it.`, action: { label: 'Move here', run: () => { if (World.inWorld() && Hunt.setCenter()) UI.toast('Hunting spot saved.'); } } }
      : { id: 'spot', icon: 'item\\etc\\mall_return_scroll', state: 'bad', title: 'Hunting spot', text: 'No spot saved. Stand where you want to hunt, then press the button.', action: { label: 'Set here', run: () => { if (World.inWorld() && Hunt.setCenter()) UI.toast('Hunting spot saved.'); } } });
    const skills = this.skills();
    out.push(skills
      ? { id: 'skills', icon: 'action\\icon_cha_auto_attack', state: 'ok', title: 'Attack skills', text: `${skills} skill${skills === 1 ? '' : 's'} in the rotations.`, action: { label: 'Review', run: () => this.open('Combat', 'Skills') } }
      : { id: 'skills', icon: 'action\\icon_cha_auto_attack', state: p.macro.normalAttack ? 'warn' : 'bad', title: 'Attack skills',
          text: p.macro.normalAttack ? 'No skills picked, so the bot only uses normal attacks. Pick your attack skills.' : 'No skills picked and normal attacks are off, so the bot cannot attack.', action: { label: 'Pick skills', run: () => this.open('Combat', 'Skills') } });
    const potions = this.potions();
    out.push(!p.potion.enabled
      ? { id: 'potions', icon: 'action\\icon_cha_recovery', state: 'warn', title: 'Potions', text: 'Automatic potion use is off.', action: { label: 'Turn on', run: () => { p.potion.enabled = true; Settings.saveProfile(); UI.draw(); } } }
      : { id: 'potions', icon: 'action\\icon_cha_recovery', state: potions ? 'ok' : 'warn', title: 'Potions', text: potions ? `On at ${p.potion.hp.pct}% HP and ${p.potion.mp.pct}% MP, ${potions} in the bag.` : 'On, but there are no potions in the bag.', action: { label: 'Review', run: () => this.open('Supplies') } });
    out.push(H.pickup.enabled
      ? { id: 'pickup', icon: 'action\\icon_cha_autoget', state: 'ok', title: 'What to pick up', text: Loot.categories.filter(k => H.pickup[k]).length + ' of ' + Loot.categories.length + ' kinds of drops are picked up.', action: { label: 'Change', run: () => this.open('Loot') } }
      : { id: 'pickup', icon: 'action\\icon_cha_autoget', state: 'warn', title: 'What to pick up', text: 'Picking up is off, so drops stay on the ground.', action: { label: 'Turn on', run: () => { H.pickup.enabled = true; Settings.saveProfile(); UI.draw(); } } });
    const error = T.enabled ? Town.validate() : '';
    out.push(T.enabled
      ? { id: 'town', icon: 'item\\etc\\mall_return_scroll', state: error ? 'bad' : 'ok', title: 'Town trips', text: error || 'Ready: the bot returns to town to repair and restock, then comes back.', action: { label: error ? 'Fix' : 'Review', run: () => this.open('Town') } }
      : { id: 'town', icon: 'item\\etc\\mall_return_scroll', state: 'warn', title: 'Town trips', text: 'Off. Pick your town below to let the bot repair, restock potions and store loot by itself (needs return scrolls; reverse return scrolls are optional).', action: { label: 'Set up town', run: () => this.setupTown() } });
    out.push(Loot.pet()
      ? { id: 'pet', icon: 'action\\icon_cha_helper', state: 'ok', title: 'Pet', text: 'A pet is out. ' + (Loot.petMode() ? 'It collects the drops.' : 'You collect the drops yourself.'), action: { label: 'Change', run: () => this.open('Loot') } }
      : { id: 'pet', icon: 'action\\icon_cha_helper', state: 'warn', title: 'Pet', text: 'No pet is out. A pickup pet collects drops for you (optional).' });
    const alert = H.playerAlert.enabled;
    out.push({ id: 'safety', icon: 'action\\icon_cha_sit', state: H.onDeath === 'stop' || Town.autoRevive() || H.onDeath === 'revive' ? 'ok' : 'warn', title: 'When things go wrong',
      text: `On death: ${Town.autoRevive() ? 'revive in town and return' : H.onDeath === 'revive' ? 'revive where you died' : 'stop'}. Player alert is ${alert ? 'on' : 'off'}.`, action: { label: 'Safe preset', run: () => this.choose('safe') } });
    return out;
  },
  setupTown() {
    const done = Town.autoSetup(true, this.town());
    if (!done) return;
    const T = Town.cfg(), error = Town.validate();
    if (!error) { T.enabled = true; Settings.saveProfile(); UI.toast('Town trips are on for ' + done.town + '.'); }
    else UI.toast(`${done.town} is saved. Still needed before town trips can run: ${error}`, 'warn', 9000);
    UI.draw();
  },
  nextFix() { return this.steps().find(s => s.state === 'bad' && s.action) || this.steps().find(s => s.state === 'warn' && s.action); },
  // Starter settings: laid over the current ones, previewed, applied once, undoable.
  choose(id) {
    const preset = SETUP_PRESETS[id], next = ProfileShare.overlay(preset.settings), rows = ProfileShare.changes(Settings.profile, next);
    this.preview = { id, preset, rows, next }; ProfileShare.pending = { preset: preset.settings, next, rows };
    if (!UI.is('Setup')) this.open('Setup'); else this.drawPreview();
  },
  drawPreview() {
    if (!this.previewNote) return;
    const p = this.preview;
    this.previewNote.textContent = !p ? '' : p.rows.length ? `${p.preset.name}: ${p.rows.length} setting${p.rows.length === 1 ? '' : 's'} would change. Nothing changes until you press Apply.` : `${p.preset.name}: these settings are already what you have.`;
    this.previewList.textContent = p ? p.rows.slice(0, 40).map(r => `${r.path}: ${ProfileShare.show(r.from)} → ${ProfileShare.show(r.to)}`).join('\n') + (p.rows.length > 40 ? `\n… and ${p.rows.length - 40} more` : '') : '';
    this.previewList.hidden = !p || !p.rows.length; this.apply.hidden = this.cancel.hidden = !p || !p.rows.length;
  },
  signature() { return JSON.stringify(this.steps().map(s => [s.id, s.state, s.text])); },
  render() {
    if (!this.rows) return;
    const steps = this.steps(), ok = steps.filter(s => s.state === 'ok').length;
    this.score.textContent = `${ok} of ${steps.length} ready` + (ok === steps.length ? '. Press F8 to start.' : ok >= steps.length - 2 && steps.every(s => s.state !== 'bad') ? '. Good to go; the rest is optional.' : '. Fix the red items first.');
    this.rows.replaceChildren(...steps.map(s => {
      const icon = el('span', '', 'skill-icon sx-ico'); Icons.paint(icon, s.icon);
      const text = el('div', null, 'sx-text'); text.append(el('strong', s.title), el('span', s.text, 'muted'));
      const row = el('div', null, 'sx-row sx-' + s.state); row.append(icon, text);
      if (s.action) row.append(UI.button(s.action.label, () => s.action.run()));
      return row;
    }));
    this.key = this.signature();
  },
  // Rebuilt only when a row's state or text changes, so buttons are not replaced under the pointer.
  refresh() { if (UI.is('Setup') && this.rows && this.signature() !== this.key) this.render(); },
  isNew() { const p = Settings.profile; return !p.hunt.center && !this.skills() && !Store.get('setup:seen', false); },
  draw(parent) {
    this.score = el('p', '', 'sx-score');
    const hero = UI.group('Ready to hunt?', this.score,
      UI.row(UI.button('Fix the next thing', () => { const s = this.nextFix(); if (s) s.action.run(); else UI.toast('Nothing left to fix. Press F8 to start.'); }), UI.button('Re-scan', () => this.render())),
      el('p', 'This page only reads your settings and the game. Each button changes one thing and says what it did.', 'muted'));
    this.rows = el('div', null, 'sx-rows');
    const townBox = UI.select('Town for "Set up town"', Town.towns.map(t => [t.key, t.name]), () => this.town(), v => { this.townPick = v; });
    const list = UI.group('Checklist', this.rows, townBox);
    this.previewNote = el('p', '', 'muted'); this.previewList = el('pre'); this.previewList.hidden = true;
    this.apply = UI.button('Apply', () => { if (ProfileShare.apply()) { this.preview = null; UI.draw(); } });
    this.cancel = UI.button('Cancel', () => { this.preview = null; ProfileShare.pending = null; this.drawPreview(); });
    this.apply.hidden = this.cancel.hidden = true;
    const presets = UI.group('Starter settings', el('p', 'Quick starting points. Each one is laid over your current settings, so your skills, hunting spot and town stay. You see every change first and can undo it.', 'muted'),
      UI.row(...Object.keys(SETUP_PRESETS).map(id => UI.button(SETUP_PRESETS[id].name, () => this.choose(id)))),
      ...Object.values(SETUP_PRESETS).map(s => el('p', s.name + ': ' + s.text, 'muted')),
      this.previewNote, this.previewList, UI.row(this.apply, this.cancel),
      UI.button('Undo last change', () => { if (ProfileShare.undo()) UI.draw(); }),
      el('p', 'Have settings from someone else? Settings → Share and import settings.', 'muted'));
    parent.append(hero, Leveling.draw(), list, presets);
    this.render(); this.drawPreview();
    Store.set('setup:seen', true);
  },
};
