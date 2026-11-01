function el(tag, text, className = '') {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  node.className = className;
  return node;
}
const UI = {
  root: null, body: null, pane: null, status: null, feedback: null,
  current: 'Combat', combatTab: 'Skills', refreshers: [], lastSkillKey: '',
  toast(message, level = 'info', ms = 5000) {
    Log.add(level, message);
    if (level === 'warn' || level === 'error' || /^SoX found/.test(message)) this.alertOrb(message);
    if (!this.feedback) return;
    this.feedback.textContent = message;
    this.feedback.style.color = level === 'warn' || level === 'error' ? '#ffc67a' : '#b5e5bd';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { if (this.feedback) this.feedback.textContent = ''; }, ms);
  },
  showDiagnostics(text) {
    if (!this.diagnosticBox) {
      this.diagnosticBox = this.group('Bug report', el('p', 'Clipboard unavailable. Select and copy this report, then send it with a description of the problem.', 'muted'));
      this.diagnosticText = el('textarea'); this.diagnosticText.readOnly = true; this.diagnosticText.rows = 8;
      this.diagnosticText.setAttribute('aria-label', 'Bug report diagnostics');
      this.diagnosticBox.append(this.diagnosticText, this.button('Close report', () => { this.diagnosticBox.hidden = true; }));
      this.body.insertBefore(this.diagnosticBox, this.waitNote.nextSibling);
    }
    this.diagnosticBox.hidden = false; this.diagnosticText.value = text;
    this.diagnosticText.focus(); this.diagnosticText.select();
    this.toast('Clipboard unavailable—copy the selected report.');
  },
  showReport() {
    if (!this.reportBox) {
      this.reportText = el('textarea'); this.reportText.readOnly = true; this.reportText.rows = 6;
      this.reportText.setAttribute('aria-label', 'Report preview');
      this.reportDescription = el('textarea'); this.reportDescription.rows = 2; this.reportDescription.maxLength = 1000;
      this.reportDescription.setAttribute('aria-label', 'What happened? (optional)');
      this.reportDescription.addEventListener('input', () => Reports.describe(this.reportDescription.value));
      this.reportCapture = this.button('Add screenshot (optional)', () => { void Reports.capture(); });
      this.reportRemove = this.button('Remove screenshot', () => Reports.removeImage());
      this.reportSend = this.button('Send to developer', () => { void Reports.send(); });
      this.reportClose = this.button('Close', () => Reports.close());
      this.reportImage = el('img'); this.reportImage.alt = 'Screenshot preview'; this.reportImage.className = 'report-image'; this.reportImage.hidden = true;
      this.reportStatus = el('p', '', 'muted'); this.reportStatus.setAttribute('role', 'status');
      this.reportBox = this.windowFrame('Bug report', () => Reports.close(),
        el('p', 'Only Send to developer uploads this preview through Cloudflare to the developer’s Discord. Diagnostics omit names, chat and locations. Your explanation and screenshot may show private details; check them first. Nothing is sent automatically.', 'muted'),
        this.field('What happened? (optional)', this.reportDescription), this.reportText,
        this.row(this.reportCapture, this.reportRemove), this.reportImage, this.reportStatus,
        this.row(this.reportSend, this.reportClose));
      this.reportBox.classList.add('report-preview');
      this.root.append(this.reportBox);
      const width = Math.min(430, innerWidth - 8);
      this.reportBox.style.left = Math.max(4, (innerWidth - width) / 2) + 'px';
      this.reportBox.style.top = Math.max(4, Math.min(80, innerHeight - 320)) + 'px';
    }
    this.reportBox.hidden = false; this.fitWindow(this.reportBox); this.front(this.reportBox);
    this.reportDescription.value = Reports.draft.description;
    this.reportStatus.textContent = Reports.draft.sent ? 'Report already sent. Close this preview to prepare another.' : 'Review the report before sending. Screenshot is optional.';
  },
  // Patch notes beside the panel, newest first. Plain text only; it never pauses the bot. Returns false before mount.
  showNotes(notes = RELEASE_NOTES, title = 'Patch notes') {
    if (!this.root || !notes.length) return false;
    const close = () => { this.notesBox.hidden = true; };
    const releases = notes.map(n => {
      const box = el('div', null, 'release'), list = el('ul');
      list.append(...n.items.map(item => el('li', item)));
      box.append(el('strong', n.version + ' · ' + n.title), list);
      if (n.note) box.append(el('p', n.note, 'muted'));
      return box;
    });
    const site = this.button('All patch notes', () => W.open(NOTES_URL, '_blank', 'noopener,noreferrer'));
    this.notesBox?.remove();
    this.notesBox = this.windowFrame(title, close,
      ...releases, this.row(this.button('Got it', close), site));
    this.notesBox.classList.add('patch-notes');
    this.root.append(this.notesBox);
    // Beside the panel (left if there is room, else right), never over the middle of the game.
    const panel = this.root.host.getBoundingClientRect(), width = Math.min(430, innerWidth - 8);
    this.notesBox.style.left = (panel.left - width - 8 >= 0 ? panel.left - width - 8 : panel.right + 8) + 'px';
    this.notesBox.style.top = Math.max(4, panel.top) + 'px';
    this.fitWindow(this.notesBox); this.front(this.notesBox);
    return true;
  },
  // A draggable in-page window in the panel's skin. Lives in the same shadow root, so typing is protected like the panel.
  windowFrame(title, onClose, ...children) {
    const win = el('section', null, 'panel dialog'), header = el('header');
    const close = this.button('×', onClose); close.className = 'fold'; close.setAttribute('aria-label', 'Close ' + title.toLowerCase());
    header.append(el('strong', title), close);
    const body = el('div', null, 'body dialog-body'); body.append(...children);
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) win.append(el('div', null, 'frame ' + corner));
    win.append(header, body);
    this.dragBy(header, win);
    win.addEventListener('pointerdown', () => this.front(win));
    return win;
  },
  // The window opened or touched last is drawn above the others.
  front(win) { win.style.zIndex = String(10 + (this.zTop = (this.zTop || 0) + 1)); },
  // Keep a floating window fully on screen after a resize or when it is re-shown.
  fitWindow(win) {
    if (!win || win.hidden) return;
    const r = win.getBoundingClientRect();
    win.style.left = clamp(r.left, 0, Math.max(0, innerWidth - r.width)) + 'px';
    win.style.top = clamp(r.top, 0, Math.max(0, innerHeight - r.height)) + 'px';
  },
  dragBy(header, target, onDone) {
    header.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const start = target.getBoundingClientRect(), origin = { x: e.clientX, y: e.clientY };
      header.setPointerCapture(e.pointerId);
      const move = event => {
        target.style.right = 'auto';
        target.style.left = clamp(start.left + event.clientX - origin.x, 0, Math.max(0, innerWidth - start.width)) + 'px';
        target.style.top = clamp(start.top + event.clientY - origin.y, 0, Math.max(0, innerHeight - 34)) + 'px';
      };
      const done = () => { onDone?.(); header.removeEventListener('pointermove', move); header.removeEventListener('pointerup', done); header.removeEventListener('pointercancel', done); };
      header.addEventListener('pointermove', move); header.addEventListener('pointerup', done); header.addEventListener('pointercancel', done);
    });
  },
  button(text, action) {
    const b = el('button', text);
    b.type = 'button';
    b.addEventListener('click', () => { try { action(); } catch (e) { this.toast(e.message, 'warn'); } });
    return b;
  },
  row(...nodes) { const r = el('div', null, 'row'); r.append(...nodes); return r; },
  field(title, input) { const label = el('label', null, 'field'); input.setAttribute('aria-label', title); label.append(el('span', title), input); return label; },
  check(title, get, set) {
    const input = el('input'); input.type = 'checkbox'; input.checked = !!get();
    input.addEventListener('change', () => { set(input.checked); Settings.saveProfile(); });
    this.refreshers.push(() => { if (this.root?.activeElement !== input) input.checked = !!get(); });
    return this.field(title, input);
  },
  number(title, get, set, min, max, step = 1) {
    const input = el('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = get();
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) { input.value = get(); return; }
      const valid = clamp(Math.round(value / step) * step, min, max);
      input.value = valid; set(valid); Settings.saveProfile();
    });
    return this.field(title, input);
  },
  text(title, get, set, placeholder = 'comma-separated names') {
    const input = el('input'); input.type = 'text'; input.value = get(); input.placeholder = placeholder;
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  select(title, options, get, set) {
    const input = el('select');
    const refresh = () => {
      if (this.root?.activeElement === input) return;
      const rows = typeof options === 'function' ? options() : options;
      const signature = JSON.stringify(rows);
      if (input.dataset.options !== signature) {
        input.replaceChildren(...rows.map(([value, text]) => { const o = el('option', text); o.value = value; return o; }));
        input.dataset.options = signature;
      }
      input.value = String(get());
    };
    refresh(); this.refreshers.push(refresh);
    input.addEventListener('change', () => { set(input.value); Settings.saveProfile(); });
    return this.field(title, input);
  },
  group(title, ...children) { const b = el('fieldset'); b.append(el('legend', title), ...children); return b; },
  toggleVisibility() {
    const host = this.root?.host;
    if (host) { host.hidden = !host.hidden; this.fitPanel(); }
  },
  toggleMinimised() {
    const host = this.root?.host;
    if (!host) return;
    if (host.hidden) { host.hidden = false; this.minimise(false); return; }
    this.minimise(!this.minimised);
  },
  mount() {
    const host = el('div'); host.id = 'sro-bot-lean';
    document.documentElement.append(host);
    this.root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = ':host{' + Object.entries(LEAN_SKIN).map(([key, data]) => `--s-${key}:url("${data}");`).join('') + '}\n' + LEAN_CSS + '\n:host([hidden]){display:none!important}';
    const panel = el('section', null, 'panel'), header = el('header');
    const fold = this.button('×', () => this.minimise(true));
    fold.className = 'fold'; fold.setAttribute('aria-label', 'Minimise bot window'); fold.title = 'Minimise · F6 (the bot keeps running)';
    header.title = 'The × or F6 minimises the window to a small icon; F7 folds it; Shift+F7 hides or shows everything.';
    this.updateButton = this.button('Update', () => Updates.open());
    this.updateButton.className = 'update'; this.updateButton.hidden = true;
    // Updates are announced on Discord, so the invite sits next to the version.
    const discord = this.button('Discord', () => {
      W.open(DISCORD_URL, '_blank', 'noopener,noreferrer');
    });
    discord.className = 'discord'; discord.title = 'Updates, suggestions and bug reports';
    const version = this.button(VERSION, () => this.showNotes());
    version.className = 'version'; version.title = 'What’s new: patch notes';
    const name = el('strong', 'NIX '); name.append(version);
    this.layoutButton = this.button('Wide', () => this.classic ? this.setClassic(false) : this.setWide(!this.wide));
    this.layoutButton.className = 'layout'; this.layoutButton.title = 'Switch between the wide and the compact window';
    this.classicButton = this.button('Classic', () => this.setClassic(true));
    this.classicButton.className = 'layout'; this.classicButton.title = 'Switch to the classic window: tabs and layout after SBot';
    header.classList.add('main-header');
    header.append(name, RenderControl.button(), this.layoutButton, this.classicButton, discord, this.updateButton, fold);
    this.body = el('div', null, 'body'); this.status = el('div', 'Waiting for game…', 'status'); this.status.setAttribute('role', 'status');
    this.updateNote = el('div', '', 'update-note'); this.updateNote.hidden = true;
    Updates.render();
    const start = this.button('Start / stop · F8', () => toggleBot());
    // A light in the button's corner: green while hunting, yellow during a town trip, walk back or other bot work.
    this.runLed = el('span', null, 'run-led'); this.runLed.setAttribute('aria-hidden', 'true'); start.prepend(this.runLed);
    const returnHunt = () => { WalkBack.start(true); if (WalkBack.active || Travel.active) RunIntent.set(true); };
    const controls = this.row(start, this.button('Return & hunt', returnHunt), this.button('Stop all', () => userStop()), this.button('Session', () => this.showSession()));
    controls.classList.add('controls');
    this.nav = el('nav'); this.nav.setAttribute('aria-label', 'Bot settings');
    this.buildNav();
    this.pane = el('div', null, 'pane'); this.feedback = el('div', null, 'feedback'); this.feedback.setAttribute('role', 'status');
    this.waitNote = el('div', '', 'waiting'); this.waitNote.setAttribute('role', 'status');
    this.body.append(this.makeMenubar(), this.updateNote, this.makeStrip(), this.status, this.waitNote, controls, this.nav, this.pane, this.makeSide(), this.feedback, this.makeLog());
    for (const corner of ['lu', 'mu', 'ru', 'ls', 'rs', 'ld', 'md', 'rd']) panel.append(el('div', null, 'frame ' + corner));
    panel.append(header, this.body); this.root.append(style, panel, this.makeOrb());
    this.panel = panel;
    this.tip = el('div', null, 'skill-tip'); this.tip.hidden = true; this.root.append(this.tip);
    // The panel's spot is remembered across reloads (global, like the minimised icon's).
    this.dragBy(header, host, () => { if (host.style.left) this.uiPrefs({ panel: { x: host.offsetLeft, y: host.offsetTop } }); this.fitPanel(); });
    W.addEventListener('resize', () => { this.fitPanel(); this.applyClassic(); this.fitWindow(this.reportBox); this.fitWindow(this.notesBox); this.fitWindow(this.sessionBox); this.fitWindow(this.activityExportBox); if (this.minimised) this.placeOrb(host.offsetLeft, host.offsetTop); else if (host.style.left) this.fitWindow(host); });
    this.setWide(!!this.uiPrefs().wide && !this.uiPrefs().classic, false); this.applyClassic();
    this.draw(); this.update();
    this.restorePanel();
    if (this.uiPrefs().minimised) this.minimise(true);
  },
  // Minimised window: a skill-slot sized icon with a status dot. The bot keeps running.
  // Global (not per character) and kept in this page's storage, like the window position.
  uiPrefs(patch) {
    let prefs = {};
    try { prefs = JSON.parse(W.localStorage.getItem('sroLean:ui') || '{}') || {}; } catch {}
    if (patch) { prefs = { ...prefs, ...patch }; try { W.localStorage.setItem('sroLean:ui', JSON.stringify(prefs)); } catch {} }
    return prefs;
  },
  // Like Icons.paint, for an image that is not under icon/ (the map button is interface art).
  paintPath(node, path) {
    Icons.url(path).then(url => {
      if (!url || !node.isConnected) return;
      const image = el('img'); image.alt = ''; image.draggable = false;
      image.addEventListener('load', () => { node.dataset.iconLoaded = 'true'; });
      image.src = url; node.prepend(image);
    });
  },
  // What the bot is doing, for the status strip and the minimised icon: ok (hunting), busy or stop.
  botState() {
    const dead = World.inWorld() && World.isDead(), mode = Controller.mode, error = mode === 'error';
    // Busy comes from the live trips, not from Controller.mode: that label lags a tick behind (it still says
    // "returning" for up to 100 ms after Stop all ended a walk-back).
    const busy = Town.trip ? 'Town trip' : WalkBack.active ? 'Returning' : Reconnect.active() ? 'Reconnecting' : Restock.trip ? 'Shopping'
      : Resurrect.trip ? 'Resurrecting' : BuffGear.run ? 'Buff gear' : Trade.run ? 'Trading' : Alchemy.run || Alchemy.pending ? 'Alchemy' : Stall.run ? 'Stall' : '';
    const label = dead ? 'Dead' : error ? 'Error' : busy || (Hunt.running ? 'Hunting' : 'Stopped');
    // `note` is what only the state can say; the icon falls back to the first wait reason, which the wide window shows below the strip.
    const note = Town.trip ? Town.status() : Travel.active ? Travel.status() : WalkBack.active ? WalkBack.status() : Reconnect.active() && Reconnect.message ? Reconnect.message
      : Restock.recording ? 'Recording route: ' + Restock.draft.route.length + ' points' : '';
    const reason = note || (this.waitNote?.textContent || '').split('\n')[0];
    return { key: dead || error ? 'stop' : busy ? 'busy' : Hunt.running ? 'ok' : 'stop', label, dead, note, reason };
  },
  // Started or stopped, whatever the character is doing: a dead character the bot will revive is still started.
  updateRunLed() {
    if (!this.runLed) return;
    const state = this.botState(), key = state.key === 'busy' ? 'busy' : Hunt.running ? 'ok' : 'stop';
    this.runLed.dataset.state = key;
    this.runLed.parentNode.title = 'Bot ' + (key === 'stop' ? 'stopped' : 'running: ' + state.label);
  },
  // Wide window: status strip on top, page list on the left, session numbers on the right, activity log below.
  // The pages themselves are the same as in the compact window. A global choice, kept with the window position.
  setWide(on, save = true) {
    if (on && this.uiPrefs().classic) { this.uiPrefs({ classic: false }); this.applyClassic(); }
    this.wide = on;
    this.root.host.classList.toggle('wide', on);
    this.layoutButton.textContent = on ? 'Compact' : 'Wide';
    if (save) this.uiPrefs({ wide: on });
    if (on) { Stats.loadLevels(); this.updateWide(); }
    if (save && this.pane) this.draw();
    if (!this.minimised && this.root.host.style.left) this.fitWindow(this.root.host);
  },
  readout(parent, label, group) {
    const value = el('b'); value.setAttribute('aria-label', group + ': ' + label);
    const row = el('div', null, 'readout'); row.append(el('span', label), value); parent.append(row);
    return value;
  },
  makeStrip() {
    const strip = el('div', null, 'strip wide-only');
    this.stripName = el('strong'); this.stripLine = el('span', '', 'muted');
    const who = el('div', null, 'who'); who.append(this.stripName, this.stripLine);
    const bars = el('div', null, 'bars'); this.bars = {};
    for (const [key, label] of [['hp', 'HP'], ['mp', 'MP'], ['xp', 'EXP']]) {
      const fill = el('i'), text = el('span'), track = el('div', null, 'track'); track.append(fill);
      const row = el('div', null, 'gauge ' + key); row.append(el('label', label), track, text); bars.append(row);
      this.bars[key] = { fill, text };
    }
    this.stripState = el('div', null, 'state'); this.stripLabel = el('strong'); this.stripReason = el('span');
    this.stripState.append(el('i', null, 'state-dot'), this.stripLabel, this.stripReason);
    this.cstat = el('div', null, 'cstat classic-only'); this.cstatFields = {};
    for (const [key, label] of [['bot', 'Bot status:'], ['mode', 'Mode:'], ['game', 'Game:'], ['spot', 'Hunting spot:']]) {
      const value = el('b'); value.setAttribute('aria-label', 'Status: ' + label.replace(':', ''));
      const row = el('div'); row.append(el('span', label), value); this.cstat.append(row); this.cstatFields[key] = value;
    }
    strip.append(who, bars, this.stripState, this.cstat);
    return strip;
  },
  makeSide() {
    const side = el('aside', null, 'side wide-only'); this.sideFields = {};
    const session = this.group('Session');
    for (const [key, label] of [['time', 'Hunting time'], ['rate', 'XP / hour'], ['xp', 'XP gained'], ['gold', 'Net gold'], ['kills', 'Kills'], ['deaths', 'Deaths'], ['sox', 'SoX found'], ['items', 'Items picked up'], ['potions', 'Potions used']])
      this.sideFields[key] = this.readout(session, label, 'Session');
    session.append(this.button('Reset session', () => Stats.reset()));
    const supplies = this.group('Supplies');
    for (const [key, label] of [['hp', 'HP potions'], ['mp', 'MP potions'], ['bag', 'Free bag slots'], ['pet', 'Pet bag'], ['spot', 'Hunting spot']])
      this.sideFields[key] = this.readout(supplies, label, 'Supplies');
    side.append(session, supplies);
    const actions = el('div', null, 'side-actions classic-only');
    actions.append(this.button('Save settings', () => { Settings.saveProfile(); this.toast('Settings saved.'); }),
      this.button('Session log', () => this.showSession(true)), this.button('Hide client', () => this.minimise(true)),
      this.button('Start training', () => { if (!Hunt.running) toggleBot(); }), this.button('Stop training', () => { if (Hunt.running) toggleBot(); }));
    side.append(actions);
    return side;
  },
  updateWide() {
    if ((!this.wide && !this.classic) || !this.bars || this.minimised) return;
    const me = World.me(), p = World.gp?.progression || {}, live = World.inWorld();
    const level = p.level, required = Stats.integer(Stats.levels?.[level]?.expRequired), xp = Stats.integer(p.experience);
    const xpPct = required && xp !== null ? Number(xp * 10000n / required) / 100 : null;
    this.stripName.textContent = World.charName || 'No character';
    this.stripLine.textContent = live ? `Level ${level ?? '?'}` : World.phase || 'Waiting for game…';
    const n = v => Math.round(v).toLocaleString('en-US');
    const setBar = (key, pct, text) => {
      this.bars[key].fill.style.width = (live && Number.isFinite(pct) ? clamp(pct, 0, 100) : 0) + '%';
      this.bars[key].text.textContent = live ? text : '—';
    };
    setBar('hp', me.hpPct, `${n(me.hp)} / ${n(me.maxHp)}`);
    setBar('mp', me.mpPct, `${n(me.mp)} / ${n(me.maxMp)}`);
    setBar('xp', xpPct, xpPct === null ? '—' : xpPct.toFixed(2) + ' %');
    const state = this.botState();
    this.stripState.dataset.state = state.key; this.stripLabel.textContent = state.label;
    this.stripReason.textContent = state.note || (Hunt.running ? `Mode: ${Controller.mode}` : 'Press F8 to start');
    if (this.classic) {
      const spot = Settings.profile.hunt.center, away = spot && live ? dist2D(World.pose(), spot) : Infinity;
      this.cstatFields.bot.textContent = state.label;
      this.cstatFields.mode.textContent = Hunt.running ? String(Controller.mode) : 'idle';
      this.cstatFields.game.textContent = live ? 'in game' : World.phase || 'waiting';
      this.cstatFields.spot.textContent = Number.isFinite(away) ? Math.round(away / 10) + ' m away' : spot ? 'another region' : 'not saved';
    }
    const s = Stats.display();
    for (const key of ['time', 'rate', 'xp', 'gold', 'kills', 'deaths', 'sox', 'items', 'potions']) this.sideFields[key].textContent = s[key];
    const pet = live ? Loot.pet() : null, center = Settings.profile.hunt.center, distance = center && live ? dist2D(World.pose(), center) : Infinity;
    this.sideFields.hp.textContent = live ? n(Potion.count('hp')) : '—';
    this.sideFields.mp.textContent = live ? n(Potion.count('mp')) : '—';
    this.sideFields.bag.textContent = live ? String(World.freeBagSlots()) : '—';
    this.sideFields.pet.textContent = pet ? `${pet.rec.inventory.length} / ${pet.rec.status}` : 'none';
    this.sideFields.spot.textContent = Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : center ? 'another region' : 'not saved';

  },
  // The wide window's activity box shows the same shared history as Settings and the session window.
  makeLog() {
    const box = el('div', null, 'logbox wide-only');
    this.logList = this.activityLog('Activity'); this.logList.classList.add('log');
    box.append(el('strong', 'Activity'), this.logList);
    return box;
  },
  makeOrb() {
    const orb = this.orb = el('button', null, 'orb'); orb.type = 'button'; orb.hidden = true;
    orb.setAttribute('aria-label', 'Show bot window');
    this.orbState = el('strong'); this.orbDetail = el('span'); this.orbVitals = el('span', '', 'muted');
    const tip = el('div', null, 'orb-tip'); tip.append(this.orbState, this.orbDetail, this.orbVitals, el('em', 'Click or F6 to open · drag to move'));
    orb.append(el('span', 'nb', 'orb-mark'), el('i', null, 'orb-dot'), tip);
    Icons.paint(orb, 'action\\icon_cha_auto_attack.ddj');
    let drag = null;
    orb.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, left: this.root.host.offsetLeft, top: this.root.host.offsetTop, moved: false };
      orb.setPointerCapture(e.pointerId);
    });
    orb.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) this.placeOrb(drag.left + dx, drag.top + dy);
    });
    const done = () => {
      if (!drag) return;
      if (drag.moved) { this.orbDragged = true; this.uiPrefs({ orb: { x: this.root.host.offsetLeft, y: this.root.host.offsetTop } }); }
      drag = null;
    };
    orb.addEventListener('pointerup', done); orb.addEventListener('pointercancel', done);
    orb.addEventListener('click', () => { if (this.orbDragged) { this.orbDragged = false; return; } this.minimise(false); });
    orb.addEventListener('pointerenter', () => { if (this.orbAlert) setTimeout(() => { this.orbAlert = ''; this.updateOrb(); }, 2500); });
    return orb;
  },
  // Keep the window inside the screen: the pane shrinks (it scrolls); the rows below it never get cut off.
  // The CSS cap covers the default top-right spot; this refines it for wherever the window was moved.
  // Skipped while hidden (Shift+F7): a hidden host reports offsetTop 0, which would loosen the cap.
  fitPanel() {
    const host = this.root?.host;
    if (!host || this.minimised || host.hidden || !W.innerHeight) return;
    host.style.maxHeight = Math.max(300, W.innerHeight - host.offsetTop - 8) + 'px';
  },
  // Put the panel at its saved spot, kept on screen; without one it uses the default top-right position.
  restorePanel() {
    const host = this.root.host, saved = this.uiPrefs().panel;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      host.style.right = 'auto'; host.style.left = saved.x + 'px'; host.style.top = saved.y + 'px'; this.fitPanel(); this.fitWindow(host);
    } else { host.style.left = ''; host.style.top = ''; host.style.right = ''; this.fitPanel(); }
  },
  placeOrb(x, y) {
    const host = this.root.host;
    host.style.right = 'auto';
    host.style.left = clamp(x, 0, Math.max(0, innerWidth - 44)) + 'px';
    host.style.top = clamp(y, 0, Math.max(0, innerHeight - 44)) + 'px';
  },
  minimise(on) {
    const host = this.root?.host;
    if (!host || !!this.minimised === on) return;
    this.minimised = on;
    if (on) {
      const r = host.getBoundingClientRect();
      const saved = this.uiPrefs().orb;
      host.classList.add('min'); this.panel.hidden = true; this.orb.hidden = false;
      if (saved) this.placeOrb(saved.x, saved.y); else this.placeOrb(r.right - 44, r.top + 4);
      if (this.tip) this.tip.hidden = true;
    } else {
      host.classList.remove('min'); this.panel.hidden = false; this.orb.hidden = true; this.orbAlert = '';
      this.restorePanel();
    }
    this.uiPrefs({ minimised: on });
    this.updateOrb();
  },
  // Pulse the icon for something that needs the player while the window is minimised.
  alertOrb(text) {
    if (!this.minimised) return;
    this.orbAlert = text; this.updateOrb();
  },
  updateOrb() {
    if (!this.orb || !this.minimised) return;
    const state = this.botState();
    if (state.dead && !this.orbWasDead && Hunt.running) this.alertOrb('Character died.');
    this.orbWasDead = state.dead;
    this.orb.dataset.state = state.key;
    this.orb.classList.toggle('alert', !!this.orbAlert);
    this.orb.classList.toggle('left', this.root.host.offsetLeft < 280);
    this.orbState.textContent = this.orbAlert ? 'Needs you' : state.label;
    this.orbDetail.textContent = this.orbAlert || state.reason || (Hunt.running ? 'Hunting' : 'Press F8 to start');
    const me = World.me();
    this.orbVitals.textContent = World.inWorld() ? `${World.charName || ''} · HP ${Math.round(me.hpPct)}% · MP ${Math.round(me.mpPct)}%` : '';
  },
  skillOptions() {
    return [[0, 'Choose a learned skill'], ...(World.gp?.skills || []).map(id => World.skill(id)).filter(s => s && !s.groundTarget).map(s => [s.id, s.name || '#' + s.id])];
  },
  skillDetails(id) {
    const s = World.skill(id);
    if (!s) return 'Skill #' + id;
    return `Lv ${s.level ?? '?'} · MP ${s.mp ?? 0}${s.mpPercent ? ' + ' + s.mpPercent + '%' : ''} · CD ${((s.cooldownMs || 0) / 1000).toFixed(1)}s`;
  },
  skillTip(id, event) {
    const s = World.skill(id);
    if (!s || !this.tip) return;
    this.tip.replaceChildren(el('strong', s.name || '#' + id), el('div', this.skillDetails(id)), el('div', s.targetRequired ? 'Target skill' : 'Self skill', 'muted'));
    this.tip.hidden = false;
    const rect = event.currentTarget.getBoundingClientRect();
    this.tip.style.left = clamp(event.clientX || rect.left, 4, Math.max(4, innerWidth - 274)) + 'px';
    this.tip.style.top = clamp((event.clientY || rect.bottom) + 16, 4, Math.max(4, innerHeight - 100)) + 'px';
  },
  skillSlot(id, action, label, selected = false, order = '') {
    const s = World.skill(id);
    const slot = this.button('', action); slot.className = 'slot' + (selected ? ' on' : '');
    slot.dataset.skill = String(id); slot.setAttribute('aria-label', label || World.skillName(id));
    slot.setAttribute('aria-pressed', String(selected));
    slot.title = `${World.skillName(id)}\n${this.skillDetails(id)}`;
    slot.append(el('span', (s?.name || '#' + id).slice(0, 3), 'fallback'), el('span', '', 'cd'), el('span', '', 'seconds'));
    if (order !== '') slot.append(el('span', order, 'order'));
    Icons.paint(slot, s?.icon);
    slot.addEventListener('pointerenter', e => this.skillTip(id, e));
    slot.addEventListener('focus', e => this.skillTip(id, e));
    slot.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    slot.addEventListener('blur', () => { this.tip.hidden = true; });
    return slot;
  },
  learnedSkills(buff) {
    const best = new Map();
    for (const s of Learned.rows()) {
      if (s.missing || s.active === false || s.groundTarget || (buff ? s.targetRequired && !(s.targets & 1) : !s.targetRequired || (s.targets !== undefined && !(s.targets & 4)))) continue;
      const group = s.group ?? s.id, previous = best.get(group);
      if (!previous || (s.level ?? 0) > (previous.level ?? 0)) best.set(group, s);
    }
    return [...best.values()];
  },
  skillList(parent, list, buff = false) {
    const strip = el('div', null, 'grid');
    list.forEach((entry, i) => {
      const id = World.bestOfGroup(entry.group, entry.id) || entry.id;
      strip.append(this.skillSlot(id, () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); }, 'Remove ' + World.skillName(id), true, String(i + 1)));
    });
    parent.append(el('div', buff ? 'Active buffs — click a slot to remove' : 'Attack order — click a slot to remove', 'muted'), strip);
    if (!list.length) parent.append(el('div', buff ? 'No buffs selected. Choose from the icons below.' : 'No skills selected. Choose from the icons below.', 'empty'));
    list.forEach((entry, i) => {
      const id = World.bestOfGroup(entry.group, entry.id) || entry.id;
      const info = el('div', null, 'skill-info'); info.append(el('span', World.skillName(id), 'skill-name'), el('span', this.skillDetails(id), 'skill-detail'));
      const row = el('div', null, 'skill-row');
      const up = this.button('↑', () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; Settings.saveProfile(); this.draw(); } });
      const down = this.button('↓', () => { if (i + 1 < list.length) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; Settings.saveProfile(); this.draw(); } });
      const remove = this.button('×', () => { list.splice(i, 1); Settings.saveProfile(); this.draw(); });
      up.className = down.className = remove.className = 'mini';
      up.setAttribute('aria-label', 'Move up ' + World.skillName(id)); down.setAttribute('aria-label', 'Move down ' + World.skillName(id)); remove.setAttribute('aria-label', 'Delete ' + World.skillName(id));
      row.append(this.skillSlot(id, () => {}, World.skillName(id)), info, up, down, remove); parent.append(row);
      if (buff) parent.append(this.select('Gear for ' + World.skillName(id),
        () => [[0, BuffGear.auto() ? 'Automatic: the weapon the skill needs' : 'Current combat gear'], ['primary', 'Primary weapon'], ['secondary', 'Secondary weapon'],
          ['shield', 'Shield (with a one-handed weapon)'], ...Settings.profile.macro.buffSets.map(s => [s.id, s.name])],
        () => entry.gearSet || 0, value => entry.gearSet = BUFF_GEAR_KINDS.includes(value) ? value : Number(value)));
    });
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find a skill…'; search.setAttribute('aria-label', buff ? 'Search buff skills' : 'Search attack skills');
    const title = el('div', null, 'picker-title'); title.append(el('span', buff ? 'Learned self buffs' : 'Learned attack skills'), search);
    const grid = el('div', null, 'grid'); grid.setAttribute('aria-label', buff ? 'Buff skill icons' : 'Attack skill icons');
    for (const s of this.learnedSkills(buff)) {
      const selected = list.some(entry => entry.group === (s.group ?? s.id));
      const slot = this.skillSlot(s.id, () => {
        const index = list.findIndex(entry => entry.group === (s.group ?? s.id));
        if (index >= 0) list.splice(index, 1);
        else list.push({ id: s.id, group: s.group ?? s.id, ...(buff ? { enabled: true, mode: 'hunt', refreshS: 3 } : {}) });
        Settings.saveProfile(); this.draw();
      }, (selected ? 'Unselect ' : 'Add ') + World.skillName(s.id), selected);
      slot.dataset.search = ((s.name || '') + ' ' + s.level).toLowerCase(); grid.append(slot);
    }
    search.addEventListener('input', () => { for (const slot of grid.children) slot.hidden = !slot.dataset.search.includes(search.value.toLowerCase()); });
    parent.append(title, grid, el('p', 'Hover an icon for its name, level, MP and cooldown. Click to select; gold borders mark selected skills.', 'muted'));
    if (!grid.children.length) parent.append(el('div', 'No matching learned skills yet. Enter the game or reload if attached late.', 'empty'));
  },
  imbuePicker(parent) {
    const current = Settings.profile.macro.imbue;
    const grid = el('div', null, 'grid');
    const selected = current && (World.bestOfGroup(current.group, current.id) || current.id);
    parent.append(el('p', selected ? 'Selected: ' + World.skillName(selected) + ' · ' + this.skillDetails(selected) : 'No weapon imbue selected.', 'muted'));
    parent.append(this.button('No imbue', () => { Settings.profile.macro.imbue = null; Settings.saveProfile(); this.draw(); }));
    // Only weapon imbues and poison coatings, unless the character has none of those (or all skills are asked for).
    const all = this.learnedSkills(true), imbues = all.filter(s => /GIGONGTA|POISON\w*_BLADE|MALL_PET_SKILL/.test(s.nameSymbol || ''));
    const list = imbues.length && !this.allImbues ? imbues : all;
    if (imbues.length) parent.append(this.button(this.allImbues ? 'Show imbues only' : 'Show all self skills', () => { this.allImbues = !this.allImbues; this.draw(); }));
    for (const s of list) grid.append(this.skillSlot(s.id, () => {
      Settings.profile.macro.imbue = { id: s.id, group: s.group ?? s.id };
      Settings.saveProfile(); this.draw();
    }, 'Use imbue ' + World.skillName(s.id), current?.group === (s.group ?? s.id)));
    parent.append(grid, el('p', 'Choose your weapon imbue here (for example Thunderdragon Force). The highest learned level in each group is shown and used automatically.', 'muted'));
  },
  draw() {
    if (!this.pane) return;
    if (this.classic) return this.drawClassic();
    if (this.tip) this.tip.hidden = true;
    this.lastSkillKey = this.skillKey();
    // Rebuilding the pane resets scrolling; keep the position when redrawing the same view.
    const view = [this.current, this.combatTab, this.rotationClass].join('|'), scroll = view === this.drawnView ? this.pane.scrollTop : 0;
    this.drawnView = view;
    this.refreshers = []; this.pane.replaceChildren();
    [...this.nav.children].forEach(b => b.setAttribute('aria-selected', String(b.textContent === this.current)));
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    if (this.current === 'Combat') {
      const subtabs = el('div', null, 'subtabs');
      for (const name of ['Skills', 'Buffs & imbue', 'Hunt area']) {
        const tab = this.button(name, () => { this.combatTab = name; this.draw(); });
        tab.setAttribute('aria-selected', String(name === this.combatTab)); subtabs.append(tab);
      }
      this.pane.append(subtabs);
      if (this.combatTab === 'Hunt area') this.sections('combatHuntArea', 'combatMonsters', 'combatLure', 'combatPet');
      if (this.combatTab === 'Skills') this.sections('combatRotation', 'combatOptions', 'combatBerserk');
      if (this.combatTab === 'Buffs & imbue') this.sections('combatGear', 'combatBuffs', 'combatImbue');
    } else if (this.current === 'Loot') {
      this.sections('lootCollection', 'lootWho', 'lootBalance');
    } else if (this.current === 'Supplies') {
      this.sections('suppliesPotions', 'suppliesRestock', 'suppliesMall');
      this.pane.append(el('p', 'Town trips, what starts them, and arrows and bolts are on the Town page.', 'muted'));
    } else if (this.current === 'Town') {
      this.sections('townTrip', 'townWhen', 'townCycle', 'townAmmo');
    } else if (this.current === 'Quest') {
      this.sections('questAuto', 'questPick', 'questJournal');
    } else if (this.current === 'Party') {
      this.sections('partyMembers', 'partyHeal', 'partyBuffs', 'partyParty', 'partyTrace');
    } else if (this.current === 'Items') {
      this.drawItems();
    } else if (this.current === 'Setup') {
      Setup.draw(this.pane);
    } else if (this.current === 'Map') {
      LeanMap.draw(this.pane);
    } else if (this.current === 'Alchemy') {
      Alchemy.draw();
    } else if (this.current === 'Trade') {
      Trade.draw();
    } else if (this.current === 'Stall') {
      Stall.draw();
    } else if (this.current === 'Wardrobe') {
      LeanWardrobe.draw(this.pane);
    } else {
      this.sections('settingsStats', 'settingsBehaviour', 'settingsObstacles', 'settingsAntiStuck', 'settingsMastery', 'settingsStatPoints', 'settingsProfiles', 'settingsShare', 'settingsReports', 'settingsActivity');
    }
    this.balance();
    this.update();
    this.pane.scrollTop = scroll;
  },
  // ---- Classic layout: an SBot-style frame and tab order (opt-in, screens at least 900 px wide) ----
  // Each tab is a list of the page sections above (title = the heading it gets here); a tab only exists when we have
  // the feature, so there is no Chat, Union Party or Alarms tab yet.
  classicTabs() {
    return [
      { name: 'Settings', icon: 'action\\icon_cha_helper', pages: ['Supplies', 'Loot', 'Town', 'Combat', 'Settings'], sections: [
        ['suppliesPotions', 'Autopotion settings'], ['suppliesRestock', 'Buy settings'], ['suppliesMall', 'Item mall settings'], ['townWhen', 'Back town settings'],
        ['lootCollection', 'Pick settings'], ['lootWho', 'Who picks up what'], ['lootBalance'], ['combatMonsters', 'Attack preferences'],
        ['combatBerserk', 'Berserk settings'], ['settingsBehaviour', 'Attack behaviour / Protection'], ['settingsObstacles'], ['settingsAntiStuck']] },
      { name: 'Skills', icon: 'action\\icon_cha_auto_attack', pages: ['Combat'], sections: [
        ['combatRotation'], ['combatOptions'], ['combatGear'], ['combatBuffs'], ['combatImbue']] },
      { name: 'Items/Storage', icon: 'action\\cos_cmd_inventory', pages: ['Items', 'Town'], draw() {
        this.drawItems(); this.sections('townTrip', 'townCycle', 'townAmmo'); } },
      { name: 'Training place', icon: 'action\\icon_cha_camp', pages: ['Combat', 'Party'], sections: [['combatHuntArea', 'Training place'], ['partyTrace'], ['combatLure'], ['combatPet']] },
      { name: 'Party/Autores', icon: 'action\\icon_cha_party', pages: ['Party'], sections: [
        ['partyMembers', 'Current party'], ['partyParty', 'Party settings'], ['partyHeal']] },
      { name: 'Player buffing', icon: 'action\\icon_cha_party', pages: ['Party'], sections: [['partyBuffs', 'Player buffing']] },
      { name: 'Quest', icon: 'action\\icon_cha_camp', pages: ['Quest'], sections: [['questAuto', 'Auto quest settings'], ['questPick', 'Quests to do'], ['questJournal']] },
      { name: 'Auto alchemy', icon: 'action\\icon_cha_alchemy', pages: ['Alchemy'], draw() { Alchemy.draw(); } },
      { name: 'Stall', icon: 'action\\icon_cha_shop', pages: ['Stall'], draw() { Stall.draw(); } },
      { name: 'Extra', icon: 'action\\icon_cha_helper', pages: ['Settings'], sections: [
        ['settingsStats'], ['settingsMastery'], ['settingsStatPoints'], ['settingsProfiles'], ['settingsShare'], ['settingsReports'], ['settingsActivity']] },
      { name: 'Map', pages: ['Map'], draw() { LeanMap.draw(this.pane); } },
      { name: 'Auto trade', icon: 'action\\icon_cha_shop', pages: ['Trade'], draw() { Trade.draw(); } },
      { name: 'Wardrobe', icon: 'action\\icon_cha_shop', pages: ['Wardrobe'], draw() { LeanWardrobe.draw(this.pane); } },
      { name: 'Setup', icon: 'action\\icon_cha_camp', pages: ['Setup'], draw() { Setup.draw(this.pane); } },
    ];
  },
  // The classic tab that holds a compact page (so Setup and the checklist can open the right place).
  tabFor(page, combatTab) {
    if (page === 'Combat') return combatTab === 'Hunt area' ? 'Training place' : 'Skills';
    return { Loot: 'Settings', Supplies: 'Settings', Town: 'Items/Storage', Quest: 'Quest', Party: 'Party/Autores', Items: 'Items/Storage', Alchemy: 'Auto alchemy', Trade: 'Auto trade', Settings: 'Extra' }[page] || page;
  },
  // Is this compact page (and optional Combat sub-tab) what the window shows right now, in either layout?
  is(page, tab) {
    if (this.classic) return !!this.classicTabs().find(t => t.name === this.ctab)?.pages.includes(page);
    return this.current === page && (!tab || this.combatTab === tab);
  },
  // Open a page (and Combat sub-tab) in whichever layout is active.
  show(page, tab) {
    this.current = page; if (tab) this.combatTab = tab;
    if (this.classic) this.ctab = this.tabFor(page, this.combatTab);
    this.draw();
  },
  setClassic(on) {
    this.uiPrefs(on ? { classic: true, wide: false } : { classic: false });
    if (on) this.setWide(false, false);
    this.applyClassic();
  },
  applyClassic() {
    if (!this.root || !this.nav) return;
    const host = this.root.host, was = !!this.classic, on = !!this.uiPrefs().classic && W.innerWidth >= 900;
    this.classic = on;
    host.classList.toggle('classic', on);
    this.classicButton.hidden = on;
    this.layoutButton.textContent = on || this.wide ? 'Compact' : 'Wide';
    if (on) { host.classList.remove('wide'); this.wide = false; Stats.loadLevels(); if (!was) this.ctab = this.tabFor(this.current, this.combatTab); }
    else if (was && this.uiPrefs().wide) this.setWide(true, false);
    if (on !== was) { this.buildNav(); if (this.pane) this.draw(); }
    if (!this.minimised && host.style.left) this.fitWindow(host);
  },
  buildNav() {
    this.nav.replaceChildren();
    const icons = { Items: 'action\\cos_cmd_inventory', Party: 'action\\icon_cha_party', Combat: 'action\\icon_cha_auto_attack', Loot: 'action\\icon_cha_autoget', Supplies: 'action\\icon_cha_recovery', Town: 'item\\etc\\mall_return_scroll', Quest: 'action\\icon_cha_camp',
      Alchemy: 'action\\icon_cha_alchemy', Trade: 'action\\icon_cha_shop', Wardrobe: 'action\\icon_cha_shop', Stall: 'action\\icon_cha_shop', Settings: 'action\\icon_cha_helper', Setup: 'action\\icon_cha_camp' };
    const entries = this.classic ? this.classicTabs().map(t => ({ name: t.name, icon: t.icon, open: () => { this.ctab = t.name; this.draw(); } }))
      : ['Setup', 'Map', 'Combat', 'Party', 'Loot', 'Items', 'Supplies', 'Town', 'Quest', 'Stall', 'Alchemy', 'Trade', 'Wardrobe', 'Settings'].map(name => ({ name, icon: icons[name], open: () => { this.current = name; this.draw(); } }));
    // Page icons are the game's own action-bar icons; they show only in the wide and classic windows' page lists.
    for (const entry of entries) {
      const tab = this.button(entry.name, entry.open);
      tab.dataset.tab = entry.name;
      if (entry.name === 'Map') this.paintPath(tab, MAP_ART + 'interface/minimap/mm_map_button.png');
      else if (entry.icon) Icons.paint(tab, entry.icon + '.ddj');
      this.nav.append(tab);
    }
  },
  drawClassic() {
    if (this.tip) this.tip.hidden = true;
    this.lastSkillKey = this.skillKey();
    const tabs = this.classicTabs();
    if (!tabs.some(t => t.name === this.ctab)) this.ctab = tabs[0].name;
    const view = ['classic', this.ctab, this.rotationClass].join('|'), scroll = view === this.drawnView ? this.pane.scrollTop : 0;
    this.drawnView = view;
    this.refreshers = []; this.pane.replaceChildren();
    [...this.nav.children].forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === this.ctab)));
    const tab = tabs.find(t => t.name === this.ctab);
    if (tab.draw) tab.draw.call(this);
    else for (const [name, title] of tab.sections) {
      const first = this.pane.children.length;
      this['section_' + name](this.pane);
      const legend = title && this.pane.children[first]?.querySelector?.(':scope > legend');
      if (legend) legend.textContent = title;
    }
    this.update();
    this.pane.scrollTop = scroll;
  },
  exportBackup() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'sro-bot-lean', version: VERSION, profile: Settings.profile }, null, 2)], { type: 'application/json' }));
    const link = el('a'); link.href = url; link.download = 'nixxane-bot-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  // The classic window's menu bar: shortcuts to things that already exist elsewhere in the panel.
  makeMenubar() {
    const bar = el('div', null, 'menubar classic-only');
    const menus = [
      ['Settings', [['Export full backup', () => this.exportBackup()], ['Profiles and sharing', () => this.show('Settings')], ['Send bug report', () => Reports.open()]]],
      ['Lists', [['Item rules', () => this.show('Items')], ['Wardrobe', () => this.show('Wardrobe')], ['Map', () => this.show('Map')]]],
      ['Help', [['Patch notes', () => this.showNotes()], ['Setup checklist', () => this.show('Setup')], ['Session totals and log', () => this.showSession(true)], ['Discord', () => W.open(DISCORD_URL, '_blank', 'noopener,noreferrer')]]],
    ];
    for (const [name, items] of menus) {
      const title = this.button(name, () => this.openMenu(title, items));
      title.className = 'menu-title'; bar.append(title);
    }
    return bar;
  },
  openMenu(anchor, items) {
    this.closeMenu();
    const menu = el('div', null, 'menu');
    for (const [label, action] of items) menu.append(this.button(label, () => { this.closeMenu(); action(); }));
    const bar = anchor.parentElement;
    menu.style.left = anchor.offsetLeft + 'px';
    bar.append(menu);
    this.menu = menu;
    const away = event => { if (!event.composedPath().includes(menu) && event.target !== anchor) this.closeMenu(); };
    this.menuAway = away;
    W.addEventListener('pointerdown', away, true);
  },
  closeMenu() {
    this.menu?.remove(); this.menu = null;
    if (this.menuAway) { W.removeEventListener('pointerdown', this.menuAway, true); this.menuAway = null; }
  },
  // A page is a list of sections; each section appends its own boxes to the given parent, so other layouts can reuse them.
  sections(...names) { for (const name of names) this['section_' + name](this.pane); },
  section_combatHuntArea(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Hunting area',
        this.check('Attack monsters', () => H().attack !== false, v => H().attack = v),
        el('p', 'Turn off for a support character: it never starts a fight, not even with monsters that hit it, and keeps picking up loot, its own buffs and Party support (heals and party buffs) at the hunting spot or beside the member it follows.', 'muted'),
        this.button('Set hunting spot here', () => { if (World.inWorld() && Hunt.setCenter()) this.toast('Hunting spot saved.'); }),
        this.number('Hunt radius (m)', () => H().radius / 10, v => H().radius = v * 10, 5, 200),
        this.number('Chase distance (m)', () => H().chase / 10, v => H().chase = v * 10, 10, 300),
        this.check('Return when idle', () => H().returnToCenter, v => H().returnToCenter = v),
        this.check('Walking back may use teleports and ferries (beta; pays their fee)', () => H().travel !== false, v => H().travel = v),
        el('p', 'Beta: a long walk back is first checked against the game map, and teleports and ferries are used where walking cannot get there. If a route looks wrong, send the log.', 'muted'),
        this.check('Avoid other players’ targets', () => H().avoidKs, v => H().avoidKs = v),
        this.number('Minimum mob level (0 = any)', () => H().levelMin, v => H().levelMin = v, 0, 140),
        this.number('Maximum mob level (0 = any)', () => H().levelMax, v => H().levelMax = v, 0, 140),
        this.text('Only these mobs', () => H().include, v => H().include = v),
        this.text('Skip these mobs', () => H().exclude, v => H().exclude = v)
      ));
  },
  section_combatMonsters(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const classes = this.group('Monster classes');
      for (const key of Object.keys(H().classes)) classes.append(this.check(key === 'titan' ? 'titan (uses Unique rotation)' : key, () => H().classes[key], v => H().classes[key] = v));
      host.append(classes);
  },
  section_combatRotation(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.rotationClass ||= 'normal';
      const classes = el('div', null, 'class-tabs');
      for (const key of CLASS_KEYS) {
        const tab = this.button('', () => { this.rotationClass = key; this.draw(); });
        tab.setAttribute('aria-label', 'Rotation for ' + key); tab.setAttribute('aria-selected', String(key === this.rotationClass));
        const icon = el('i'); icon.style.backgroundImage = `var(--s-tw_${key})`;
        tab.append(icon, el('span', key)); classes.append(tab);
      }
      const rotation = this.group('Attack rotation', classes,
        this.check('Empty classes use Normal rotation', () => M().fallbackToNormal, v => M().fallbackToNormal = v),
        this.check('Use normal attacks', () => M().normalAttack, v => M().normalAttack = v));
      this.skillList(rotation, M().rotations[this.rotationClass]); host.append(rotation);
  },
  section_combatOptions(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Combat options',
        this.number('Skill gap (ms)', () => M().castGapMs, v => M().castGapMs = v, 150, 2000, 50)));
  },
  section_combatBerserk(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Berserk when the gauge is full, on',
        ...[['giant', 'Giants'], ['giantParty', 'Giant party'], ['titan', 'Titans'], ['unique', 'Uniques'], ['elite', 'Elites'], ['party', 'Party monsters'], ['champion', 'Champions'], ['normal', 'Normal monsters']]
          .map(([key, label]) => this.check(label, () => M().berserkClasses[key], v => M().berserkClasses[key] = v))));
  },
  section_combatGear(host) {
    const pick = (title, slot) => this.select(title, () => ItemRules.gearOptions(slot), () => ItemRules.cfg().gear?.[slot] || '', v => ItemRules.setGear(slot, v));
    host.append(this.group('Weapons and shield',
      pick('Primary weapon', 'primaryWeapon'), pick('Secondary weapon', 'secondaryWeapon'), pick('Shield', 'shield'),
      el('p', 'Pick from what you wear or carry. The choice stays when you wear the item and when alchemy changes its plus or stones. Chosen gear is never sold, stored, dropped or moved to the pet, even with an item rule.', 'muted'),
      el('p', 'While hunting, the primary weapon is your combat weapon: it is put back on after buff swaps and reconnects, with the shield when it is one-handed, and with arrows or bolts from your bag for a bow or crossbow. A buff can wear the primary or secondary weapon or the shield (Gear for <skill> below), and automatic swaps try the secondary weapon first.', 'muted')));
  },
  section_combatBuffs(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      BuffGear.draw(host);
      const buffs = this.group('Buffs'); this.skillList(buffs, M().buffs, true);
      host.append(buffs);
  },
  section_combatImbue(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const imbue = this.group('Weapon imbue'); this.imbuePicker(imbue); host.append(imbue);
  },
  section_lootCollection(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const L = () => H().pickup;
      const options = this.group('Collection');
      options.append(this.select('Default collector', [['character', 'Character'], ['pet', 'Pickup pet']], () => L().collector, v => { L().collector = v; Loot.reset(); }));
      options.append(this.check('Chime when pet bag is full', () => L().petFullSound, v => { L().petFullSound = v; Loot.fullAlert = null; }), this.button('Test pet chime', () => Sound.test()),
        this.check('Chime and notice when a SoX item is picked up', () => L().soxSound, v => L().soxSound = v), this.button('Test SoX chime', () => Sound.test('sox')));
      this.petNote = el('p', '', 'muted pet-note'); options.append(this.petNote);
      options.append(this.row(...[['Elixirs only','elixirs'],['Elixirs + gold','elixirs-gold'],['All items','all']].map(([label,mode]) => this.button(label, () => { Loot.preset(mode); this.draw(); }))));
      for (const [key, label] of [['enabled', 'Collect drops'], ['soxOnly', 'Equipment: only SoX (Star / Moon / Sun)'], ['afterKillOnly', 'Character: finish the current fight before picking up']]) options.append(this.check(label, () => L()[key], v => L()[key] = v));
      options.append(this.number('Pickup radius (m)', () => L().radius / 10, v => L().radius = v * 10, 3, 100),
        this.number('Retries after first attempt', () => L().retries, v => L().retries = v, 0, 3),
        this.text('Always include names', () => L().include, v => L().include = v),
        this.text('Exclude names', () => L().exclude, v => L().exclude = v),
        el('p', 'Pets collect during combat regardless of the finish-fight setting, which applies to the character only. Inventory transactions and potion priority can briefly delay pet requests. Equipment: only SoX takes Star, Moon and Sun gear and leaves plain equipment, even when Equipment or an Always include name matches it; other items follow their own switches. It needs the item catalogue, which loads automatically. When several drops are eligible, Star, Moon and Sun gear is collected first (Sun before Moon before Star) whatever the distance; without the catalogue the nearest drop goes first. Presets clear Always include names; exclusions still apply. Other items excludes the separate categories above. Ownership and bag capacity always apply. Failed pickups use a backoff.', 'muted'));
      host.append(options);
  },
  section_lootWho(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const L = () => H().pickup;
      const kinds = this.group('Who picks up what');
      for (const [key, label] of [['gold', 'Gold'], ['potions', 'Potions and cure pills'], ['equipment', 'Equipment'], ['elixirs', 'Elixirs'], ['powders', 'Lucky powders'], ['magicStones', 'Magic stones (stored in the warehouse)'], ['attrStones', 'Attribute stones (stored in the warehouse)'], ['alchemy', 'Other alchemy items'], ['others', 'Other items']])
        kinds.append(this.select(label, [['off', 'Leave on the ground'], ['pet', 'Pickup pet'], ['character', 'Character']],
          () => L()[key] ? Loot.collectorFor(key) : 'off',
          v => { if (v === 'off') L()[key] = false; else { L()[key] = true; (L().by ||= {})[key] = v; } Loot.reset(); }));
      kinds.append(el('p', 'Each kind of drop is either left alone, taken by your pickup pet, or taken by the character. The pet collects while you fight and fills its own bag; the character walks to the item and uses your bag, so give it only the few kinds you want on you (for example potions or pills). The default collector decides for kinds you have not set yourself and for names under Always include.', 'muted'));
      host.append(kinds);
  },
  section_lootBalance(host) {
    host.append(this.group('Bag and pet space',
      this.check('Balance free slots with the pickup pet', () => ItemRules.cfg().balance, v => ItemRules.cfg().balance = v),
      el('p', 'While hunting, items with a Sell or Store rule move to the bag or pet, whichever has more free slots. Supplies and the weapons and shield chosen under Combat never move.', 'muted')));
  },
  section_suppliesPotions(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const pots = this.group('Automatic potion use', this.check('Use potions automatically', () => P().enabled, v => P().enabled = v));
      pots.append(this.potionDelay(), el('p', 'Minimum interval between automatic potion uses. The game’s own item cooldowns still apply.', 'muted'));
      this.speedNote = el('p', '', 'muted');
      pots.append(this.check('Use beginner +100% speed scroll automatically', () => P().speedScroll, v => { P().speedScroll = v; SpeedScroll.reset(); }),
        el('p', 'Uses only the beginner scroll during hunting or travel when no movement-speed buff is active. Works during combat casts; potions have priority. Waits for buff confirmation and stops retrying after three unconfirmed attempts.', 'muted'), this.speedNote);
      pots.append(this.check('Keep a 20% damage scroll active', () => Settings.profile.scroll.damageInc, v => { Settings.profile.scroll.damageInc = v; ScrollBuff.reset(); }),
        this.check('Keep a 20% resistance scroll active', () => Settings.profile.scroll.damageAbs, v => { Settings.profile.scroll.damageAbs = v; ScrollBuff.reset(); }),
        el('p', 'While hunting, uses a 20% damage increase and/or resistance scroll from your bag whenever its 30-minute buff runs out, like the speed scroll above: potions have priority, each use waits for its buff, and it stops retrying after three unconfirmed attempts. Buying more scrolls is set under Item mall below.', 'muted'));
      const R = () => P().repairHammer;
      this.hammerNote = el('p', '', 'muted');
      pots.append(this.check('Use a repair hammer when gear is worn', () => R().on, v => { R().on = v; RepairHammer.reset(); }),
        this.number('Gear durability below (%)', () => R().pct, v => R().pct = v, 1, 99),
        el('p', 'While hunting, when the most worn repairable item you are wearing drops below this share of its maximum durability, uses a repair hammer from the bag; one hammer repairs everything you wear. Waits for the repair to show and stops retrying after three unconfirmed attempts. Keep it above the Town page worn-gear level so the hammer comes first.', 'muted'), this.hammerNote);
      for (const kind of ['hp', 'mp']) pots.append(this.check('Use ' + kind.toUpperCase(), () => P()[kind].on, v => P()[kind].on = v), this.number(kind.toUpperCase() + ' below (%)', () => P()[kind].pct, v => P()[kind].pct = v, 5, 95));
      pots.append(this.check('Use vigor potions', () => P().vigor.on, v => P().vigor.on = v),
        this.number('Vigor when HP below (%)', () => P().vigor.hpPct, v => P().vigor.hpPct = v, 0, 95),
        this.number('Vigor when MP below (%)', () => P().vigor.mpPct, v => P().vigor.mpPct = v, 0, 95),
        this.check('Use cure pills', () => P().cure.on, v => P().cure.on = v),
        this.check('Use recovery kits on my pets', () => P().petHp.on, v => { P().petHp.on = v; PetPotion.reset(); }),
        this.number('Pet HP below (%)', () => P().petHp.pct, v => P().petHp.pct = v, 5, 95),
        this.check('Use HGP recovery potions on my pet', () => P().petHgp.on, v => { P().petHgp.on = v; PetPotion.reset(); }),
        this.number('Pet HGP below (%)', () => P().petHgp.pct, v => P().petHgp.pct = v, 5, 95),
        el('p', 'Pets: when an attack or pickup pet drops below this HP, one recovery kit (the smallest that covers the missing HP) is used on it. When the attack pet\'s HGP (satiety) drops below the second number, one HGP recovery potion is fed to it. Your own potions always go first; each item must be seen consumed before the next. Vigor potions need no setting beyond the two thresholds above; they are used only when the HP and MP potions are not enough.', 'muted'));
      this.petPotionNote = el('p', PetPotion.message, 'muted pet-note'); this.petPotionNote.title = PetPotion.message; pots.append(this.petPotionNote);
      host.append(pots);
  },
  section_suppliesRestock(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const townOn = Town.cfg().enabled;
      const shop = this.group('Potion restock');
      if (townOn) shop.append(el('p', 'The town cycle is on: every trip buys X-Large potions at the saved merchant, so walking-route restock and merchant recording are hidden. Low-stock and refill amounts below still apply.', 'muted'));
      else shop.append(this.check('Auto buy while hunting', () => C().enabled, v => C().enabled = v),
        this.row(this.button('Record from merchant', () => Restock.beginRecording()), this.button('Finish at hunt spot', () => Restock.finishRecording()), this.button('Cancel route', () => Restock.cancelRecording())),
        el('p', 'Open the potion shop, start recording, close the shop, walk to your hunting spot, then finish recording. Do not teleport while recording.', 'muted'));
      for (const kind of ['hp', 'mp']) {
        shop.append(this.check('Buy ' + kind.toUpperCase(), () => C()[kind].on, v => C()[kind].on = v));
        if (!townOn) shop.append(this.select(kind.toUpperCase() + ' potion', () => [[0, 'Record a merchant route first'], ...C().offers.filter(o => o.kind === kind).map(o => [o.refObjId, o.name])], () => C()[kind].refObjId, v => C()[kind].refObjId = Number(v)));
        shop.append(this.number('Low stock ≤', () => C()[kind].low, v => C()[kind].low = v, 0, 9999), this.number(kind.toUpperCase() + ' refill to', () => C()[kind].target, v => C()[kind].target = v, 1, 10000));
      }
      shop.append(this.check('Buy vigor potions', () => C().vigor.on, v => C().vigor.on = v),
        this.select('Vigor potion size', [[18, 'Herb (smallest)'], [19, 'Small'], [20, 'Medium'], [21, 'Large'], [22, 'X-Large']], () => C().vigor.refObjId, v => C().vigor.refObjId = Number(v)),
        this.number('Vigor low stock ≤', () => C().vigor.low, v => C().vigor.low = v, 0, 9999),
        this.number('Vigor refill to', () => C().vigor.target, v => C().vigor.target = v, 1, 10000),
        el('p', 'Vigor potions use the size you pick here on every town trip and walking restock. Pick a size the potion merchant sells, or the trip stops with a message. Using them is set under Automatic potion use.', 'muted'),
        this.check('Buy abnormal pills (best)', () => C().cure.on, v => C().cure.on = v),
        this.number('Pills low stock ≤', () => C().cure.low, v => C().cure.low = v, 0, 9999),
        this.number('Pills refill to', () => C().cure.target, v => C().cure.target = v, 1, 10000),
        el('p', 'Buys only Special Universal Pill (small), the strongest universal cure. No cheaper substitute. Uses the same refill trips as HP/MP. Use cure pills above controls automatic use.', 'muted'),
        this.check('Buy HGP recovery potions', () => C().hgp.on, v => C().hgp.on = v),
        this.select('HGP potion', () => [[0, 'Choose the merchant\'s pet food'], ...C().offers.filter(o => o.kind === 'hgp').map(o => [o.refObjId, o.name])], () => C().hgp.refObjId, v => C().hgp.refObjId = Number(v)),
        this.number('HGP low stock ≤', () => C().hgp.low, v => C().hgp.low = v, 0, 9999),
        this.number('HGP refill to', () => C().hgp.target, v => C().hgp.target = v, 1, 10000),
        el('p', 'Pet food for the attack pet\'s HGP. Pick the pet food the recorded merchant sells; on a refill trip it is bought like the potions, and a merchant without it skips it with a notice. Feeding is set under Automatic potion use.', 'muted'),
        this.check('Buy pet recovery kits', () => C().kit.on, v => C().kit.on = v),
        this.select('Recovery kit', () => [[0, 'Choose the merchant\'s pet kits'], ...C().offers.filter(o => o.kind === 'kit').map(o => [o.refObjId, o.name])], () => C().kit.refObjId, v => C().kit.refObjId = Number(v)),
        this.number('Kits low stock ≤', () => C().kit.low, v => C().kit.low = v, 0, 9999),
        this.number('Kits refill to', () => C().kit.target, v => C().kit.target = v, 1, 10000),
        el('p', 'Pet recovery kits for the attack and pickup pets, bought on the same refill trips as the pet food; a merchant without them skips them with a notice. Using them is set under Automatic potion use.', 'muted'),
        this.check('Buy Reverse Return Scrolls', () => C().reverse.on, v => C().reverse.on = v),
        this.number('Reverse scrolls low stock ≤', () => C().reverse.low, v => C().reverse.low = v, 0, 999),
        this.number('Reverse scrolls refill to', () => C().reverse.target, v => C().reverse.target = v, 1, 9999),
        el('p', 'Refills Reverse Return Scrolls at the recorded merchant with gold; a merchant without them skips it with a notice (the trip can still walk back).', 'muted'));
      shop.append(el('p', 'Refill targets are total potion counts, including what is already in your bag. Used for low-supply, full-bag and revival trips, and walking-route restock when the town cycle is off. Set MP refill to 1000 for 1,000 MP potions. Changes apply to the next trip.', 'muted'));
      host.append(shop);
  },
  section_suppliesMall(host) {
    const M = () => Settings.profile.mall;
    host.append(this.group('Item mall',
      this.check('Buy from the Item mall', () => M().on, v => M().on = v),
      this.number('Silk budget per bot run (0 = never buy)', () => M().budgetSilk, v => M().budgetSilk = v, 0, 100000),
      this.mallNote = el('p', '', 'muted'),
      el('p', 'The mall wallet is shared by every character on the account and nothing refills it in the game, so every purchase is bounded by the budget above and one order is in flight at a time. Orders land straight in the bag while hunting; they never interrupt combat or a town trip, and the merchant stays the primary supply. An unconfirmed order blocks mall buying until you re-enter the game (the game itself demands that resync).', 'muted'),
      this.check('Buy HP potion bags when the total HP stock is low', () => M().hp.on, v => M().hp.on = v),
      this.number('HP low stock ≤', () => M().hp.low, v => M().hp.low = v, 0, 9999),
      this.number('HP refill to', () => M().hp.target, v => M().hp.target = v, 1, 100000),
      this.check('Buy MP potion bags when the total MP stock is low', () => M().mp.on, v => M().mp.on = v),
      this.number('MP low stock ≤', () => M().mp.low, v => M().mp.low = v, 0, 9999),
      this.number('MP refill to', () => M().mp.target, v => M().mp.target = v, 1, 100000),
      this.check('Buy 20% damage scrolls', () => M().damageInc.on, v => M().damageInc.on = v),
      this.number('Damage scrolls low stock ≤', () => M().damageInc.low, v => M().damageInc.low = v, 0, 999),
      this.number('Damage scrolls refill to', () => M().damageInc.target, v => M().damageInc.target = v, 1, 9999),
      this.check('Buy 20% resistance scrolls', () => M().damageAbs.on, v => M().damageAbs.on = v),
      this.number('Resistance scrolls low stock ≤', () => M().damageAbs.low, v => M().damageAbs.low = v, 0, 999),
      this.number('Resistance scrolls refill to', () => M().damageAbs.target, v => M().damageAbs.target = v, 1, 9999),
      this.check('Buy Reverse Return Scrolls here (the merchant with gold stays cheaper)', () => M().reverse.on, v => M().reverse.on = v),
      this.number('Reverse scrolls low stock ≤', () => M().reverse.low, v => M().reverse.low = v, 0, 999),
      this.number('Reverse scrolls refill to', () => M().reverse.target, v => M().reverse.target = v, 1, 9999),
      el('p', 'Merchant first, mall second: keep these low marks BELOW the potion restock marks above and the merchant refills with gold while the mall only steps in when that was not enough. Raise a mark above the merchant one and the mall spends silk first instead — for wallets that can afford it. One bag or pack is bought per order and the delivered amount is measured from the inventory, so an unknown pack size only means another order. Prices come from the live catalogue, never from remembered addresses.', 'muted')),
      el('p', 'Keeping the scrolls active is set under Automatic potion use above; the switches here only refill the stock.', 'muted'));
  },
  section_townTrip(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const town = () => Town.cfg();
      // The trip as the game's own item pictures, with what each step still needs.
      const flow = el('ol', null, 'trip-flow'), count = type => World.items().filter(i => (i.typeFlags & 0xfffc) === type).reduce((n, i) => n + (i.quantity ?? 1), 0);
      for (const [icon, label, detail] of [
        ['mall_return_scroll', 'Return scroll', () => town().arrival ? count(0x09ec) + ' in bag' : 'arrival not saved'],
        ['mall_warehouse_ticket', 'Warehouse', () => town().storage ? 'saved' : 'not saved'],
        ['all_potion_03', 'Potions', () => town().vendor ? 'saved' : 'not saved'],
        ['mall_repair_hammer', 'Repair', () => town().smith ? 'saved' : 'not saved'],
        ['mall_reverse_return_scroll', 'Way back', () => Town.walks() ? 'walks back' : count(0x19ec) ? count(0x19ec) + ' reverse in bag' : 'no reverse: walks back']]) {
        const step = el('li'), slot = el('span', null, 'skill-icon'), note = el('small', detail());
        slot.append(el('span', label[0], 'fallback')); Icons.paint(slot, `item\\etc\\${icon}.ddj`);
        step.append(slot, el('strong', label), note); flow.append(step);
        this.refreshers.push(() => { note.textContent = detail(); note.classList.toggle('missing', /not saved|^0 in bag/.test(note.textContent)); });
      }
      host.append(this.group('The town trip', flow));
  },
  section_townWhen(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const town = () => Town.cfg();
      host.append(this.group('Go to town when…',
        el('p', 'Only while the scroll town cycle below is on. Always: the character bag has one free slot or less. Potions, vigor potions and pills: at the low-stock numbers in Supplies. Arrows and bolts: below.', 'muted'),
        this.check('Return when pickup pet is nearly full', () => town().petFull, v => town().petFull = v),
        this.number('Pet free slots ≤', () => town().petFree, v => town().petFree = v, 0, 10),
        this.check('Weapon is broken', () => town().broken, v => town().broken = v),
        this.check('Gear is worn', () => town().wear.on, v => town().wear.on = v),
        this.number('Gear durability below (%)', () => town().wear.pct, v => town().wear.pct = v, 1, 90),
        this.check('No XP for a while', () => town().noXp.on, v => town().noXp.on = v),
        this.number('No XP for (minutes)', () => town().noXp.minutes, v => town().noXp.minutes = v, 1, 120),
        this.select('When there is no XP', [['town', 'Return to town'], ['nextSpot', 'Move to the next level spot']], () => town().noXp.action, v => town().noXp.action = v),
        this.check('On a timer', () => town().every.on, v => town().every.on = v),
        this.number('Every (minutes)', () => town().every.minutes, v => town().every.minutes = v, 5, 600),
        this.check('Revive in town and go back to the hunting spot', () => town().revive, v => town().revive = v),
        this.check('Revive a dead pet with a Grass of life', () => town().revivePet, v => town().revivePet = v),
        this.select('After death, reverse to', [['recall', 'Last return-scroll location (hunting area)'], ['death', 'Death location']], () => town().deathReturn, v => { town().deathReturn = v; Activity.emit({category:'settings',code:'reverse-choice-changed',text:'Revival reverse destination changed to ' + v + '.',details:{choice:v === 'death' ? 3 : 2}}); }),
        el('p', 'Service trips reverse to their departure point. After death, use the selected destination. A missing game destination stops the trip; it never substitutes another point. Without a reverse scroll, or with Back to the hunting spot set to Walk, the trip walks back to the saved hunting spot instead.', 'muted'),
        el('p', 'Worn gear means the most worn repairable item you are wearing, measured against its own maximum durability; the trip repairs it. A broken weapon (0 durability) has its own switch, on by default. The XP and timer clocks run only while hunting and restart with every trip.', 'muted'),
        el('p', 'A dead pet waits in your bag as its summoner item. With this on, a town trip starts for it and, once in town, uses a Grass of life from your bag to revive it and summons it again before the services. Carry the grass: stable-keepers sell it, the bot does not buy it.', 'muted')));
  },
  section_townCycle(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const town = () => Town.cfg();
      const services = this.group('Scroll town cycle',
        this.check('Use return scroll → town services → back to the hunting spot', () => town().enabled, v => { town().enabled = v; this.draw(); }),
        this.select('Back to the hunting spot', [['reverse', 'Reverse return scroll (walks when none is carried)'], ['walk', 'Walk']], () => town().returnBy, v => { town().returnBy = v; this.draw(); }),
        this.check('Deposit SoX gear in the warehouse (character and pet bags)', () => town().storeSox, v => town().storeSox = v),
        this.check('Sell Star gear too (instead of depositing it)', () => town().sellStar, v => town().sellStar = v),
        this.check('Sell ordinary gear from the character bag too', () => town().sellBag, v => town().sellBag = v),
        this.text('Also deposit gear requiring level', () => town().storeLevels, v => town().storeLevels = v, 'e.g. 85 or 80-90, 100'),
        this.number('Town arrival tolerance (m)', () => town().arrivalRadius / 10, v => town().arrivalRadius = v * 10, 10, 150),
        el('p', 'Bind your recall to Hotan, Jangan, Donwhang, Constantinople or Samarkand in the game. Quickest: pick your town and press Set up this town; the arrival point is where its return scroll always lands, so you do not have to be in town. It fills the arrival point and the four services. To do it by hand instead, save the arrival point where a return scroll places you, then stand near, select and save the warehouse, potion merchant, repair merchant and world statue / teleport. Open the potion shop before saving its merchant. Saves your standing position for each approach. Uses collision-aware walking between services. Overrides the recorded walking restock while enabled.', 'muted'));
      for (const [role, label] of [['arrival', 'Arrival point'], ['storage', 'Warehouse'], ['vendor', 'Potion merchant'], ['smith', 'Repair merchant'], ['gate', 'World statue / teleport']]) services.append(
        this.row(this.button('Save ' + label.toLowerCase(), () => Town.save(role)), el('span', town()[role]?.name || (town()[role] ? 'Saved' : 'Not saved'), 'muted')));
      const townOptions = Town.towns.map(t => [t.key, t.name]);
      this.townPick ||= Town.detect()?.key || townOptions[0][0];
      services.append(this.select('Town', townOptions, () => this.townPick, v => this.townPick = v),
        this.button('Set up this town', () => Town.autoSetup(true, this.townPick)),
        this.button('Auto-set town services', () => Town.autoSetup(false)), this.button('Redo all automatically', () => Town.autoSetup(true)));
      services.append(el('p', 'Pet loot: store elixirs, and Star / Moon / Sun gear when SoX deposit is on (needs the saved warehouse; SoX gear in your own bag goes in too, all other character items stay). Nothing is deposited right after pickup, only on the next town trip. Gear requiring one of the levels you list above (for example 85) is deposited the same way and never sold. SoX gear that is part of a saved buff set, the weapon chosen for alchemy, or matches the Keep names stays in your bag. Sell other unprotected pet items at the saved weapon / repair merchant before repairing. Other seal/rare equipment and equipment with unknown rarity stays in the pet. Ordinary equipment is sold regardless of + or blue options. With Sell Star gear too, Star gear (not Moon or Sun) is sold like ordinary gear instead of deposited (Keep names, buff-set gear, the alchemy weapon and the level list above still protect it). With the switch above, ordinary weapons, armour, shields and accessories in the character bag are sold too; other bag items only with a Sell rule. Never sold from the bag: potions, scrolls, supplies, pet summons, avatars, devil spirits, job suits, item mall items, Keep names, buff-set gear or the alchemy weapon.', 'muted'));
      services.append(this.text('Keep in pet (names)', () => town().keep, v => town().keep = v),
        el('p', 'Town buys X-Large potions using the Buy HP/MP switches, low-stock thresholds and refill counts above. Keep each low-stock threshold below its refill target. Potion selections apply to walking-route restock. Returns when the character bag has at most one free slot. Free at least two slots before hunting again; existing character items stay protected. Revival uses the saved town services without a return scroll in town, then reverses or walks back. Pet loot passes through one reserved character bag slot. Potions, return/reverse scrolls, beginner speed scrolls and matching Keep names are protected. Refills travel scrolls to two where sold for gold; otherwise carry spares. F8 cancels.', 'muted'));
      this.townNote = el('p', Town.status(), 'muted'); services.append(this.townNote); host.append(services);
  },
  section_townAmmo(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const ammo = () => C().ammo;
      host.append(this.group('Arrows and bolts',
        this.check('Buy arrows on town trips', () => ammo().arrow.on, v => ammo().arrow.on = v),
        this.number('Arrows: go to town at or below', () => ammo().arrow.low, v => ammo().arrow.low = v, 0, 9999),
        this.number('Arrows: refill to', () => ammo().arrow.target, v => ammo().arrow.target = v, 1, 10000),
        this.check('Buy bolts on town trips', () => ammo().bolt.on, v => ammo().bolt.on = v),
        this.number('Bolts: go to town at or below', () => ammo().bolt.low, v => ammo().bolt.low = v, 0, 9999),
        this.number('Bolts: refill to', () => ammo().bolt.target, v => ammo().bolt.target = v, 1, 10000),
        el('p', 'Bought at the repair merchant after selling pet loot and before repairing. The count includes the stack in your ammunition slot and any spare stacks in the bag. A trip also starts when the count falls to the low-stock number. If the merchant does not sell it, there is no bag space or not enough gold, that item is skipped and the rest of the trip goes on. Equipping the bought ammunition is up to you.', 'muted')));
  },
  section_questAuto(host) {
    const Q = () => Settings.profile.quest;
    const state = el('p', null, 'muted');
    const show = () => { state.textContent = Q().on ? 'Auto quests are on. ' + (Quest.status() || 'Looking for a quest.') : 'Auto quests are stopped. Press Start quests.'; };
    show(); this.refreshers.push(show);
    host.append(this.group('Auto quests',
      this.row(this.button('Start quests', () => { Q().on = true; Settings.saveProfile(); this.toast('Auto quests started.', 'info', 3000); this.draw(); }),
        this.button('Stop quests', () => { Q().on = false; Settings.saveProfile(); this.toast('Auto quests stopped.', 'info', 3000); this.draw(); })),
      state,
      this.check('Accept quests their NPC offers', () => Q().accept, v => Q().accept = v),
      this.text('Only quests named', () => Q().include, v => Q().include = v, 'comma-separated QNO_ codenames'),
      this.text('Never quests named', () => Q().exclude, v => Q().exclude = v, 'comma-separated QNO_ codenames'),
      el('p', 'The quest markers the game itself sends route the bot: it walks to the quest NPC, takes the quest, hunts the monsters whose kills advance it and turns it in. Quests the reward window can close are rewarded without walking. Which dialogue row is which quest, and which monsters count, are learned while playing.', 'muted')));
  },
  // The quest list, like phBot's: tick the quests to do. The bot takes them lowest level first at the NPC named in
  // each quest's codename. With nothing ticked it falls back to the quests the game's own markers offer.
  section_questPick(host) {
    const Q = () => Settings.profile.quest;
    if (!QuestData.pending) QuestData.ready();
    if (!QuestData.loaded) {
      host.append(this.group('Quests to do', el('p', QuestData.failed ? 'The quest list could not be loaded. Reload the game and try again.' : 'Loading the quest list…', 'muted')));
      return;
    }
    const level = World.gp?.progression?.level ?? 0, find = (this.questFind || '').toLowerCase().trim();
    const set = (refId, on) => { const list = new Set(Q().picked || []); on ? list.add(refId) : list.delete(refId); Q().picked = [...list]; Settings.saveProfile(); };
    const all = QuestData.list().filter(q => (this.questHigh || !level || q.level <= level) && (!find || (q.title + ' ' + q.token).toLowerCase().includes(find)));
    const shown = all.slice(0, 80);
    host.append(this.group('Quests to do',
      this.text('Find a quest', () => this.questFind || '', v => { this.questFind = v; this.draw(); }, 'part of the name'),
      this.check('Show quests above my level', () => !!this.questHigh, v => { this.questHigh = v; this.draw(); }),
      this.row(this.button('Pick all shown', () => { const list = new Set(Q().picked || []); for (const q of shown) list.add(q.refId); Q().picked = [...list]; Settings.saveProfile(); this.draw(); }),
        this.button('Clear picks', () => { Q().picked = []; Settings.saveProfile(); this.draw(); })),
      el('p', (Q().picked || []).length + ' picked. ' + (all.length > shown.length ? 'Showing the first ' + shown.length + ' of ' + all.length + '; use Find to narrow the list.' : all.length + ' shown.'), 'muted'),
      ...shown.map(q => this.check('Lv ' + q.level + ' · ' + (q.title || q.token), () => (Q().picked || []).includes(q.refId), v => set(q.refId, v))),
      el('p', 'Picked quests are done lowest level first: the bot walks to the NPC, takes the quest, hunts what the quest counts and turns it in. Only quests whose NPC the game data names are listed. Quests too far away or above your level wait.', 'muted')));
  },
  section_questJournal(host) {
    const Q = () => Settings.profile.quest;
    const status = el('p', Quest.status() || 'No quest visit running.', 'muted');
    const list = el('div', null, 'members');
    let armedAbandon = 0;
    const render = () => {
      status.textContent = Quest.status() || 'No quest visit running.';
      const rows = Quest.listing();
      if (!rows.length) { list.replaceChildren(el('div', 'No active quests.', 'empty')); return; }
      list.replaceChildren(...rows.map(row => {
        const line = el('div', null, 'member');
        const name = el('div', null, 'member-name');
        name.append(el('strong', row.token || 'quest #' + row.refId),
          el('span', (row.progress !== null ? 'count ' + row.progress : 'no counter') + (row.done ? ' · ready to turn in' : '') +
            (row.around ? '' : ' · targets not around') + (row.skipped ? ' · skipped' : ''), 'muted'));
        const skip = this.button(row.skipped ? 'Unskip' : 'Skip', () => {
          const list = new Set(Q().skip || []);
          list.has(row.refId) ? list.delete(row.refId) : list.add(row.refId);
          Q().skip = [...list]; Settings.saveProfile(); render();
        });
        // Abandon drops all progress: the first click only arms the button for a moment.
        const abandon = this.button(armedAbandon === row.refId ? 'Sure?' : 'Abandon', () => {
          if (armedAbandon !== row.refId) {
            armedAbandon = row.refId; abandon.textContent = 'Sure?';
            setTimeout(() => { if (armedAbandon === row.refId) { armedAbandon = 0; render(); } }, 3000);
            return;
          }
          armedAbandon = 0; Quest.abandon(row.refId); render();
        });
        line.append(name, skip, abandon); return line;
      }));
    };
    render();
    this.refreshers.push(render);
    host.append(this.group('Quest journal', status, list));
  },
  section_partyMembers(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const S = () => Settings.profile.party.support;
      // Live party: HP and MP bars, distance, and which of the assigned buffs each member shows right now.
      const list = el('div', null, 'members'), rows = el('p', '', 'muted');
      const renderMembers = () => {
        const members = Support.members().filter(m => !m.self);
        if (!members.length) { list.replaceChildren(el('div', 'Not in a party.', 'empty')); return; }
        list.replaceChildren(...members.map(m => {
          const row = el('div', null, 'member' + (m.alive ? '' : ' dead'));
          const bars = el('div', null, 'member-bars');
          for (const [key, pct] of [['hp', m.hpPct], ['mp', m.mpPct]]) { const bar = el('div', null, 'pbar ' + key), fill = el('i'); fill.style.width = clamp(pct, 0, 100) + '%'; bar.append(fill); bars.append(bar); }
          const name = el('div', null, 'member-name');
          name.append(el('strong', m.name), el('span', `Lv ${m.level ?? '?'} · ${!m.alive ? 'dead' : !m.entity ? 'out of view' : Math.round(m.distance / 10) + ' m' + (m.inRange ? '' : ' (out of range)')}`, 'muted'));
          const buffs = el('div', null, 'member-buffs');
          for (const b of S().buffs) {
            const id = Support.skillOf(b), only = splitList(b.only || '');
            if (!id || only.length && !only.includes(m.name.toLowerCase())) continue;
            const slot = el('span', null, 'skill-icon' + (m.gid && Support.has(m.gid, id) ? ' on' : ' off')); slot.title = World.skillName(id);
            slot.append(el('span', '·', 'fallback')); Icons.paint(slot, World.skill(id)?.icon); buffs.append(slot);
          }
          row.append(name, bars, buffs); return row;
        }));
        rows.textContent = Support.message;
      };
      renderMembers(); this.refreshers.push(renderMembers);
      host.append(this.group('Party members', list, rows));
  },
  section_partyHeal(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const S = () => Settings.profile.party.support;
      const skillOptions = skills => () => [[0, 'None'], ...skills().map(s => [s.id, s.name || '#' + s.id])];
      const pick = entry => v => { const id = Number(v); entry().id = id; entry().group = id ? World.skill(id)?.group ?? id : 0; };
      host.append(this.group('Heal and buff the party',
        this.check('Buff and heal party members', () => S().enabled, v => { S().enabled = v; Support.reset(); }),
        this.check('Also while hunting is stopped', () => S().whileStopped, v => S().whileStopped = v),
        this.number('Support range (m)', () => S().range, v => S().range = v, 5, 60),
        this.select('Heal skill', skillOptions(() => Support.friendlySkills()), () => Support.skillOf(S().heal) || 0, pick(() => S().heal)),
        this.number('Heal below (%)', () => S().heal.pct, v => S().heal.pct = v, 10, 95),
        this.check('Heal myself too', () => S().heal.self, v => S().heal.self = v),
        this.select('Group heal skill', skillOptions(() => Support.areaSkills()), () => Support.skillOf(S().group) || 0, pick(() => S().group)),
        this.number('Group heal below (%)', () => S().group.pct, v => S().group.pct = v, 10, 95),
        this.number('Group heal when this many are low', () => S().group.count, v => S().group.count = v, 2, 8),
        el('p', 'Casts only on members you can see within the support range; it never walks to them. Order: group heal, then a heal on the lowest member, then missing buffs, one cast at a time. HP is exact for members in view. Your own potions still come first.', 'muted')));
  },
  section_partyBuffs(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
    const S = () => Settings.profile.party.support;
      // Party buffs: skills that can be cast on another member, each with an optional list of who gets it.
      const buffs = this.group('Party buffs'), chosen = () => S().buffs;
      if (!chosen().length) buffs.append(el('div', 'No party buffs chosen. Pick from the icons below.', 'empty'));
      chosen().forEach((b, i) => {
        const id = Support.skillOf(b), info = el('div', null, 'skill-info');
        info.append(el('span', World.skillName(id), 'skill-name'), el('span', this.skillDetails(id), 'skill-detail'));
        const remove = this.button('×', () => { chosen().splice(i, 1); Settings.saveProfile(); this.draw(); });
        remove.className = 'mini'; remove.setAttribute('aria-label', 'Delete party buff ' + World.skillName(id));
        const row = el('div', null, 'skill-row'); row.append(this.skillSlot(id, () => {}, World.skillName(id)), info, remove);
        buffs.append(row, this.text('Only these members: ' + World.skillName(id), () => b.only || '', v => b.only = v, 'everyone (or names, comma-separated)'),
          this.select('Gear for ' + World.skillName(id), [[0, 'Automatic: the weapon the skill needs'], ['primary', 'Primary weapon'], ['secondary', 'Secondary weapon'], ['shield', 'Shield (with a one-handed weapon)']],
            () => b.gear || 0, v => b.gear = BUFF_GEAR_KINDS.includes(v) ? v : 0));
      });
      if (chosen().length) buffs.append(el('p', 'With Swap weapons for buffs on (Combat → Buffs & imbue), a party buff that needs another weapon, or the gear picked for it, is cast after changing weapons; then your primary weapon (or what you wore) comes back. Automatic also needs Wear the weapon each buff needs.', 'muted'));
      const grid = el('div', null, 'grid'); grid.setAttribute('aria-label', 'Party buff skill icons');
      for (const s of Support.friendlySkills()) {
        const group = s.group ?? s.id, selected = chosen().some(b => b.group === group);
        grid.append(this.skillSlot(s.id, () => {
          const index = chosen().findIndex(b => b.group === group);
          if (index >= 0) chosen().splice(index, 1); else chosen().push({ id: s.id, group, only: '' });
          Settings.saveProfile(); this.draw();
        }, (selected ? 'Unselect ' : 'Add ') + World.skillName(s.id), selected));
      }
      buffs.append(el('div', 'Learned skills you can cast on a party member', 'muted'), grid);
      if (!grid.children.length) buffs.append(el('div', 'No learned skill can target a party member.', 'empty'));
      host.append(buffs);
  },
  section_partyParty(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      const party = () => Settings.profile.party;
      this.partyNote = el('p', '', 'muted');
      host.append(this.group('Party',
        this.check('Auto-recruit', () => party().autoRecruit, v => { party().autoRecruit = v; Party.reset(); }),
        this.text('Party listing title', () => party().title, v => party().title = v),
        this.number('Party minimum level', () => party().min, v => party().min = v, 1, 90),
        this.number('Party maximum level', () => party().max, v => party().max = v, 1, 90),
        this.select('Party purpose', [[0, 'Hunting'], [1, 'Quest'], [2, 'Trade'], [3, 'Thief']], () => party().purpose, v => party().purpose = Number(v)),
        this.check('Share EXP in new parties', () => party().expShare, v => party().expShare = v),
        this.check('Share items in new parties', () => party().itemShare, v => party().itemShare = v),
        this.partyNote,
        el('p', 'Auto-recruit registers your saved listing and accepts applicants whenever enabled, even with hunting stopped. Restores missing listings when space opens and retries unconfirmed registrations after fresh idle state, at most once every 30 seconds. Existing listings and party sharing settings are preserved; edits apply to the next new listing. Turning this off leaves the current listing in place.', 'muted'),
        this.check('Auto-accept party-matching joins', () => Settings.profile.party.autoAcceptMatching, v => Settings.profile.party.autoAcceptMatching = v),
        el('p', 'Accepts applications to your own listing while you are the leader or forming a new party. Works while hunting is stopped; turn this switch off to stop accepting. Ordinary invitations are left to you.', 'muted'),
        this.text('Accept only these players (empty: everyone)', () => party().acceptNames, v => party().acceptNames = v, 'names, comma separated'),
        el('p', 'Auto-accept answers only applicants on this list, matched on the exact character name. The list is saved per character. Leave it empty to accept everyone.', 'muted'),
        this.check("Join the party leader's party", () => party().joinMain, v => { party().joinMain = v; Party.reset(); }),
        this.text('Party leader name', () => party().mainName, v => { party().mainName = v; Party.reset(); }, 'exact character name'),
        this.check("Leave someone else's party when the party leader is back", () => party().leaveIfNotLeader, v => { party().leaveIfNotLeader = v; Party.reset(); }),
        el('p', 'For your other accounts. While you are not in a party, the bot accepts a party invitation from that character, or finds their party listing on the party-matching board and applies to it. The main account needs Auto-recruit and Auto-accept party-matching joins ticked. It also rejoins after a disconnect, once the character is back in the game. Leave this off on the main account.', 'muted'),
        el('p', 'With the leave option on, a party led by someone else is left only once the party leader is in view near your hunting spot. If the party leader disconnects, the party the game hands to another member stays together until they are back.', 'muted'),
        this.check('Accept resurrection from party members', () => party().acceptRes, v => party().acceptRes = v),
        el('p', 'When you are dead and a party member casts Rebirth on you, the bot answers Yes. Works during hunting and while stopped; resurrection offers from other players are left to you.', 'muted'),
        this.check('Auto-resurrect party members', () => party().autoRes, v => { party().autoRes = v; Resurrect.reset(); }),
        this.number('Maximum res distance from hunt spot (m)', () => party().resRadius / 10, v => party().resRadius = v * 10, 1, 100),
        el('p', 'Works during hunting and while stopped. Walks into skill range for visible dead members within the maximum radius, casts Rebirth, then returns. During hunting the radius is measured from the saved hunt spot; while stopped it uses your starting position. Collision data is required for walking. Travel stops after 30 seconds or 12 seconds without progress per leg. The member must accept the revival. Travel, shopping and manual control take priority.', 'muted')));
  },
  section_combatLure(host) { Lure.draw(host); },
  section_combatPet(host) {
    const P = () => Settings.profile.pet.attack;
    host.append(this.group('Attack pet',
      this.check('Attack pet assists my targets', () => P().on, v => { P().on = v; PetAttack.reset(); }),
      el('p', 'Every monster the bot engages is also given to the attack pet, with the same order the game\'s pet bar sends. With the call-back on, a pet farther than the radius is first called back to you and sets out from your side, so what chases it comes along — a walking lure. Between targets it stays at your side. The pickup pet is not touched.', 'muted'),
      this.check('Call the pet back before a new target', () => P().recall, v => P().recall = v),
      this.number('Call-back radius (m)', () => P().radius, v => P().radius = v, 3, 50),
      this.number('Wait for the pet for at most (s)', () => P().timeout, v => P().timeout = v, 1, 15),
      this.number('Repeat the attack order every (s)', () => P().resend, v => P().resend = v, 3, 30),
      this.petAttackNote = el('p', PetAttack.status(), 'muted')));
  },
  section_partyTrace(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      Trace.draw(host);
  },
  section_settingsStats(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      Stats.draw(host);
  },
  section_settingsBehaviour(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.autoStartNote = el('p', AutoStart.status(), 'muted'); this.retryNote = el('p', Retry.status(), 'muted');
      host.append(this.group('Behaviour',
        this.check('Start the bot when this character enters the game', () => H().autoStart, v => { H().autoStart = v; this.autoStartNote.textContent = AutoStart.status(); }),
        el('p', 'About 5 seconds after the character is in the game: at the hunting spot it starts hunting; in the town of your saved town services it does them and goes back (needs the scroll town cycle); anywhere else it walks back; dead, it revives first. Only once per entry. Stop, F8 or a reconnect cancel it. If you stopped the bot last time, it stays stopped.', 'muted'),
        this.autoStartNote,
        this.check('Start again when the bot stops by itself', () => H().retry, v => { H().retry = v; this.retryNote.textContent = Retry.status(); }),
        el('p', 'If the bot stops on its own while your last choice was Start (a town trip or walk back that failed, a stop on a world change), it waits 2 minutes, and 2 minutes after your last manual move, then does what Return & hunt does. Stops you chose are final: out of HP potions, bag full, On death: Stop, the stuck and trapped limits, manual control, a stop right after your own action in the game. The same reason again within 30 minutes, or a fourth stop in an hour, leaves it stopped with a warning.', 'muted'),
        this.retryNote,
        ...(Town.autoRevive() ? [el('p', 'On death: the town cycle revives you in town and goes back (Town → Scroll town cycle).', 'muted')]
          : [this.select('On death', [['stop', 'Stop'], ['wait', 'Wait'], ['revive', 'Revive and walk back']], () => H().onDeath, v => H().onDeath = v)]),
        this.check('Rest when low', () => H().sit.enabled, v => { H().sit.enabled = v; this.draw(); }),
        ...(H().sit.enabled ? [
          this.number('Rest below HP (%)', () => H().sit.hpBelow, v => H().sit.hpBelow = v, 0, 95),
          this.number('Rest below MP (%)', () => H().sit.mpBelow, v => H().sit.mpBelow = v, 0, 95),
          this.number('Stand up at (%)', () => H().sit.resumeAt, v => H().sit.resumeAt = v, 30, 100)] : []),
        this.check('Stop when HP potions run out', () => H().stopNoHpPotion, v => H().stopNoHpPotion = v),
        this.check('Stop when bag is full', () => H().stopInvFull, v => H().stopInvFull = v),
        this.number('Manual control pause (s)', () => H().manualPauseS, v => H().manualPauseS = v, 1, 30)));
  },
  section_settingsObstacles(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Obstacles',
        this.check('Walk around obstacles when chasing a mob', () => H().detour.enabled, v => H().detour.enabled = v),
        this.number('Approach progress check interval (ms)', () => H().detour.stallMs, v => H().detour.stallMs = v, 1000, 10000),
        this.check('Detect a character that cannot move', () => H().trap.enabled, v => H().trap.enabled = v),
        this.number('Cannot move for (seconds)', () => H().trap.seconds, v => H().trap.seconds = v, 10, 120),
        this.check('Recall to town if legal escape attempts fail', () => H().trap.recall, v => H().trap.recall = v),
        this.check('Keep detailed escape diagnostics locally', () => H().trap.diagnostics, v => H().trap.diagnostics = v),
        el('p', 'Checks blocked approaches before repeating attacks, follows collision-checked detours and stops/releases unreachable targets. Failed approaches are remembered briefly. Escape retries refused movement and requires fresh, stable arrival plus a second move before hunting resumes. Optional recall needs a configured scroll town cycle and stops in town instead of reversing into the trap. Detailed diagnostics stay local and can include exact positions; both new options are off by default. Unknown collision data cannot authorize an escape.', 'muted')));
  },
  section_settingsAntiStuck(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.stuckNote = el('p', AntiStuck.status(), 'muted');
      host.append(this.group('Anti-stuck',
        this.check('Recover when hunting makes no progress', () => H().antiStuck.enabled, v => H().antiStuck.enabled = v),
        this.number('No progress for (minutes)', () => H().antiStuck.minutes, v => H().antiStuck.minutes = v, 1, 30),
        this.number('Stop after failed recoveries', () => H().antiStuck.maxRecoveries, v => H().antiStuck.maxRecoveries = v, 1, 10),
        this.check('Go to town instead of stopping (needs the town cycle)', () => H().antiStuck.recall, v => H().antiStuck.recall = v),
        this.stuckNote,
        el('p', 'Progress means a confirmed kill, XP, gold, a pickup, or damage to your target. Resting, buffing, looting, shopping and town trips do not count against you. First recovery drops the current target; the next ones walk back to the saved hunting spot; after the last one hunting stops.', 'muted')));
  },
  section_settingsMastery(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      AutoMastery.draw(host);
  },
  section_settingsStatPoints(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      StatPoints.draw(host);
  },
  section_settingsProfiles(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Profiles', el('p', 'Settings are saved separately for each character.', 'muted'),
        this.button('Export full backup (with my positions)', () => this.exportBackup())));
  },
  section_settingsShare(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      ProfileShare.draw(host);
  },
  section_settingsReports(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      host.append(this.group('Bug reports', el('p', 'Preview diagnostics and optionally a screenshot, then send them to the developer. Nothing sends automatically.', 'muted'), this.button('Send bug report', () => Reports.open())));
  },
  section_settingsActivity(host) {
    const H = () => Settings.profile.hunt, M = () => Settings.profile.macro, P = () => Settings.profile.potion, C = () => Restock.cfg();
      this.logs = this.activityLog('Settings activity');
      host.append(this.group('Recent activity', this.button('Pop out session totals and log', () => this.showSession(true)), this.activityPanel(this.logs, 'Settings')));
  },
  // The wide window shows a page as two columns. Plain grid rows leave a gap under every box that is shorter than its
  // neighbour, so the boxes are dealt into two stacks instead: each one goes under the shorter stack, in page order.
  // Wide boxes (the map, the item table, the member list, the trip pictures) and loose notes keep the full width.
  balance() {
    if (!this.wide || !this.pane) return;
    const full = el => el.tagName !== 'FIELDSET' || el.matches('.map-box, :has(.trip-flow), :has(.members), :has(.item-table)');
    const kids = [...this.pane.children], boxes = kids.filter(k => !full(k));
    if (boxes.length < 2 || kids.length === 1) return;
    const heights = new Map(boxes.map(b => [b, b.offsetHeight])), segments = [];
    let run = [];
    for (const k of kids) {
      if (full(k)) { if (run.length) segments.push({ run, before: k }); run = []; } else run.push(k);
    }
    if (run.length) segments.push({ run, before: null });
    for (const { run: group, before } of segments) {
      if (group.length < 2) continue;
      const row = el('div', null, 'pane-cols'), left = el('div', null, 'pane-col'), right = el('div', null, 'pane-col');
      let l = 0, r = 0;
      for (const b of group) { if (l <= r) { left.append(b); l += heights.get(b) + 8; } else { right.append(b); r += heights.get(b) + 8; } }
      row.append(left, right); this.pane.insertBefore(row, before);
    }
  },
  // Items page: every item of the game's catalogue with its rule (sBot's item list). Filters re-render only the table,
  // so typing in the search box keeps its focus. 100 rows per page; bulk buttons apply to everything the filters show.
  itemFilter: { query: '', group: 'all', race: '', gender: '', kind: '', sox: '', degrees: new Set(), custom: false, page: 0 },
  drawItems() {
    if (!Items.data.size) {
      this.pane.append(this.group('Items', el('div', 'Loading the game\u2019s item list…', 'empty')));
      Items.ready().then(() => { if (this.is('Items')) this.draw(); }, () => { if (this.is('Items')) this.toast('The item list could not be loaded; try again in a moment.', 'warn'); });
      return;
    }
    const f = this.itemFilter, refresh = () => { f.page = 0; renderTable(); };
    const choose = (title, options, key) => {
      const input = el('select'); input.setAttribute('aria-label', title);
      input.append(...options.map(([value, text]) => { const o = el('option', text); o.value = value; return o; }));
      input.value = f[key]; input.addEventListener('change', () => { f[key] = input.value; refresh(); });
      const label = el('label', null, 'field'); label.append(el('span', title), input); return label;
    };
    const kinds = ['Head', 'Shoulder', 'Chest', 'Hand', 'Trouser', 'Boot', 'Shield', 'Garment', 'Protector', 'Armor', 'Necklace', 'Earring', 'Ring',
      'Blade', 'Sword', 'Glaive', 'Spear', 'Bow', '1HSword', '2HSword', 'Axe', 'X-Bow', 'Dagger', 'Staff', 'W-Rod', 'C-Rod', 'Harp'];
    const search = el('input'); search.type = 'search'; search.placeholder = 'Find an item (name, code or id)'; search.value = f.query; search.setAttribute('aria-label', 'Find an item');
    search.addEventListener('input', () => { f.query = search.value; refresh(); });
    const degrees = el('div', null, 'degrees');
    for (let d = 1; d <= 12; d++) {
      const box = el('input'); box.type = 'checkbox'; box.checked = f.degrees.has(d); box.setAttribute('aria-label', 'Degree ' + d);
      box.addEventListener('change', () => { box.checked ? f.degrees.add(d) : f.degrees.delete(d); refresh(); });
      const label = el('label'); label.append(box, el('span', String(d))); degrees.append(label);
    }
    const custom = el('input'); custom.type = 'checkbox'; custom.checked = f.custom; custom.setAttribute('aria-label', 'Only items with a rule');
    custom.addEventListener('change', () => { f.custom = custom.checked; refresh(); });
    const customLabel = el('label', null, 'field'); customLabel.append(el('span', 'Only items with a rule'), custom);
    const nearby = el('input'); nearby.type = 'checkbox'; nearby.checked = !!f.nearby; nearby.setAttribute('aria-label', 'Only items on the ground now');
    nearby.addEventListener('change', () => { f.nearby = nearby.checked; refresh(); });
    const nearbyLabel = el('label', null, 'field'); nearbyLabel.append(el('span', 'Only items on the ground now'), nearby);
    const filters = this.group('Filter items',
      choose('Item group', [['all', 'All items'], ['equipment', 'Equipment'], ['weapon', 'Weapons'], ['armour', 'Armour and shields'], ['accessory', 'Accessories'], ['potion', 'Potions'],
        ['pill', 'Pills'], ['alchemy', 'Alchemy'], ['ammo', 'Arrows and bolts'], ['scroll', 'Scrolls'], ['pet', 'Pet items'], ['quest', 'Quest items'], ['mall', 'Item mall'], ['other', 'Other']], 'group'),
      choose('Race', [['', 'Any'], ['CH', 'Chinese'], ['EU', 'European']], 'race'),
      choose('Gender', [['', 'Any'], ['Male', 'Male'], ['Female', 'Female']], 'gender'),
      choose('Type', [['', 'Any'], ...kinds.map(k => [k, k])], 'kind'),
      choose('SoX', [['', 'Any'], ['any', 'Any SoX (_A_, _B_, _C_)'], ['1', 'Star (_A_)'], ['2', 'Moon (_B_)'], ['3', 'Sun (_C_)']], 'sox'),
      el('div', 'Degree', 'muted'), degrees, search, customLabel, nearbyLabel);
    const bulk = el('div', null, 'row bulk'), table = el('div', null, 'item-table'), pager = el('div', null, 'row pager'), summary = el('p', '', 'muted');
    table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Item rules');
    const rules = this.group('Item rules', summary, bulk, table, pager,
      el('p', 'Pick: always takes the item whatever the Loot switches say, never leaves it. A rule is for that exact item (each size or degree is its own item), so tick Only items on the ground now to find what is dropping and set the rule on those. Store puts it in the warehouse on town trips (also from your bag, except potions and scrolls the trip needs). Sell sells it from the pet at the repair merchant; your own bag is never sold. Keep never stores or sells it. Drop throws it away from your bag or the pet while hunting, and it is never picked up again. Right-click a row for the same choices.', 'muted'));
    this.pane.append(filters, rules);
    const set = (ids, change, label) => { ItemRules.set(ids, change); this.toast(`${label}: ${ids.length} item${ids.length === 1 ? '' : 's'}.`); renderTable(); };
    // Bulk buttons ask for a second click when they change more than one item.
    const bulkActions = [['Pick always', { pick: 'yes' }], ['Pick never', { pick: 'no' }], ['Store', { act: 'store' }], ['Sell', { act: 'sell' }], ['Keep', { act: 'keep' }],
      ['Drop', { act: 'drop' }], ['Clear', { pick: null, act: null }]];
    let shown = [], armed = null;
    for (const [label, change] of bulkActions) {
      const button = this.button(label, () => {
        const ids = shown.map(i => i.id);
        if (!ids.length) return;
        if (ids.length > 1 && armed !== label) {
          armed = label; button.textContent = `${label} ${ids.length}?`; button.classList.add('armed');
          setTimeout(() => { if (armed === label) { armed = null; button.textContent = label; button.classList.remove('armed'); } }, 4000);
          return;
        }
        armed = null; button.textContent = label; button.classList.remove('armed'); set(ids, change, label);
      });
      button.setAttribute('aria-label', 'All shown: ' + label); bulk.append(button);
    }
    const menu = (info, x, y) => {
      this.itemMenu?.remove();
      const box = el('div', null, 'item-menu'); box.setAttribute('role', 'menu');
      box.append(el('strong', info.name));
      for (const [label, change] of [['Pick always', { pick: 'yes' }], ['Pick never', { pick: 'no' }], ['Pick by Loot switches', { pick: null }], ['Store', { act: 'store' }], ['Sell', { act: 'sell' }],
        ['Keep', { act: 'keep' }], ['Drop', { act: 'drop' }], ['No action', { act: null }], ['Clear rule', { pick: null, act: null }]]) {
        const item = this.button(label, () => { box.remove(); set([info.id], change, label); }); item.setAttribute('role', 'menuitem'); box.append(item);
      }
      this.root.append(box); this.itemMenu = box;
      box.style.left = clamp(x, 0, innerWidth - 180) + 'px'; box.style.top = clamp(y, 0, innerHeight - box.offsetHeight - 4) + 'px';
      setTimeout(() => this.root.addEventListener('pointerdown', e => { if (!box.contains(e.composedPath()[0])) box.remove(); }, { once: true }), 0);
    };
    const renderTable = () => {
      shown = ItemRules.list(f);
      const pages = Math.max(1, Math.ceil(shown.length / 100)); f.page = clamp(f.page, 0, pages - 1);
      summary.textContent = `${shown.length.toLocaleString('en-US')} items shown · ${ItemRules.count()} with a rule.`;
      const head = el('div', null, 'item-row head'); head.setAttribute('role', 'row');
      for (const text of ['', 'Item', 'Deg', 'Pick', 'Store', 'Sell', 'Keep', 'Drop']) head.append(el('span', text));
      const rows = shown.slice(f.page * 100, f.page * 100 + 100).map(info => {
        const rule = ItemRules.get(info.id) || {}, row = el('div', null, 'item-row' + (rule.pick || rule.act ? ' ruled' : ''));
        row.setAttribute('role', 'row'); row.dataset.id = info.id;
        const slot = el('span', null, 'skill-icon'); slot.append(el('span', '', 'fallback')); if (info.icon) Icons.paint(slot, info.icon);
        const name = el('span', null, 'item-name'); name.append(el('span', info.name));
        if (info.sox) name.append(el('em', ['', 'Star', 'Moon', 'Sun'][info.sox], 'sox'));
        name.title = info.code + ' · #' + info.id;
        const pick = this.button(rule.pick === 'yes' ? 'Yes' : rule.pick === 'no' ? 'No' : '–', () =>
          set([info.id], { pick: rule.pick === 'yes' ? 'no' : rule.pick === 'no' ? null : 'yes' }, 'Pick'));
        pick.className = 'cell'; pick.setAttribute('aria-label', 'Pick ' + info.name);
        row.append(slot, name, el('span', info.degree ? String(info.degree) : ''), pick);
        for (const act of ITEM_ACTIONS) {
          const cell = this.button(rule.act === act ? '●' : '', () => set([info.id], { act: rule.act === act ? null : act }, act[0].toUpperCase() + act.slice(1)));
          cell.className = 'cell' + (rule.act === act ? ' on' : ''); cell.setAttribute('aria-label', act[0].toUpperCase() + act.slice(1) + ' ' + info.name);
          cell.setAttribute('aria-pressed', String(rule.act === act)); row.append(cell);
        }
        row.addEventListener('contextmenu', e => { e.preventDefault(); menu(info, e.clientX, e.clientY); });
        return row;
      });
      table.replaceChildren(head, ...rows);
      if (!rows.length) table.append(el('div', 'No item matches these filters.', 'empty'));
      const prev = this.button('‹ Previous', () => { f.page--; renderTable(); }), next = this.button('Next ›', () => { f.page++; renderTable(); });
      prev.disabled = f.page === 0; next.disabled = f.page >= pages - 1;
      pager.replaceChildren(prev, el('span', `Page ${f.page + 1} of ${pages}`, 'muted'), next);
    };
    renderTable();
  },
  skillKey() {
    return (World.gp?.skills || []).map(id => { const s = World.skill(id); return `${id}:${s?.name}:${s?.icon}:${s?.level}`; }).join('|');
  },
  update() {
    Stats.sample(); Stats.render();
    Alchemy.refresh(); Setup.refresh(); Stall.refresh();
    if (this.is('Combat', 'Buffs & imbue') && BuffGear.note) BuffGear.note.textContent = BuffGear.status();
    Reports.render();
    const diagnosticState = Diagnostics.sample();
    if (this.waitNote) this.waitNote.textContent = this.waitNote.title = Diagnostics.lines(diagnosticState);
    this.updateOrb(); this.updateWide(); this.updateRunLed();
    if (this.townNote) this.townNote.textContent = Town.status();
    if (this.is('Settings') && AutoMastery.note) AutoMastery.note.textContent = AutoMastery.status();
    if (this.is('Settings') && AutoMastery.maxNote) AutoMastery.maxNote.textContent = AutoMastery.maxMessage;
    if (this.is('Settings') && StatPoints.note) StatPoints.note.textContent = StatPoints.status();
    if (this.stuckNote) this.stuckNote.textContent = AntiStuck.status();
    if (this.autoStartNote) this.autoStartNote.textContent = AutoStart.status();
    if (this.retryNote) this.retryNote.textContent = Retry.status();
    if (this.is('Party') && Trace.note) Trace.note.textContent = Trace.status();
    if (Lure.note) Lure.note.textContent = Lure.status();
    if (this.is('Party') && this.partyNote) {
      const notes = [Settings.profile.party.autoRecruit ? Party.message : 'Auto-recruit off.'];
      if (Settings.profile.party.joinMain && Party.joinMessage) notes.push(Party.joinMessage);
      if (Settings.profile.party.autoRes) notes.push(Resurrect.message);
      this.partyNote.textContent = notes.join(' ');
    }
    if (!this.status) return;
    if (this.is('Supplies') && this.petPotionNote) { this.petPotionNote.textContent = this.petPotionNote.title = PetPotion.message; }
    if (this.is('Combat') && this.petAttackNote) { this.petAttackNote.textContent = this.petAttackNote.title = PetAttack.status(); }
    if (this.is('Supplies') && this.mallNote) {
      const m = () => MallBuyer.on()
        ? MallBuyer.message + ' Spent ' + MallBuyer.spentSilk + ' silk this run; wallet ' + (World.gp?.itemMall?.silk ?? '—') + ' silk.'
        : 'Item mall buying off.';
      this.mallNote.textContent = this.mallNote.title = m();
    }
    if (this.is('Supplies') && this.speedNote) this.speedNote.textContent = SpeedScroll.message;
    if (this.is('Supplies') && this.hammerNote) this.hammerNote.textContent = RepairHammer.message;
    if (this.is('Loot') && this.petNote) { const text = Loot.petStatus(); this.petNote.style.visibility = Loot.petMode() ? '' : 'hidden'; this.petNote.textContent = text; this.petNote.title = text; }
    Learned.repair();
    if (this.is('Combat') && this.lastSkillKey !== this.skillKey()) { this.draw(); return; }
    const me = World.me(), center = Settings.profile.hunt.center;
    const distance = center ? dist2D(World.pose(), center) : Infinity;
    this.status.textContent = `${World.charName || 'No character'} · ${World.inWorld() ? Controller.mode : World.phase}\nHP ${Math.round(me.hpPct)}% · MP ${Math.round(me.mpPct)}% · Potions ${Potion.count('hp')}/${Potion.count('mp')} · Pickups ${Stats.values.loot}\nHunting spot: ${Number.isFinite(distance) ? Math.round(distance / 10) + ' m away' : center ? 'another region' : 'not saved'}${Restock.recording ? '\nRecording route: ' + Restock.draft.route.length + ' points' : ''}`;

    this.refreshers.forEach(refresh => refresh());
    for (const slot of this.pane.querySelectorAll('.slot[data-skill]')) {
      const id = Number(slot.dataset.skill), left = World.cooldownLeft(id), total = World.skill(id)?.cooldownMs || 0;
      slot.querySelector('.cd').style.setProperty('--p', total && left > 0 ? Math.min(100, left / total * 100) + '%' : '0%');
      slot.querySelector('.seconds').textContent = left > 0 ? String(Math.ceil(left / 1000)) : '';
    }
    this.updateSession();
  },
};
