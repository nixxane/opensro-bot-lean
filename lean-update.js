// Check trusted repository metadata; never execute downloaded update code.
const Updates = {
  latest: null, busy: false, started: false,
  // Is version a newer x.y.z than base (VERSION by default)? Anything that is not a version is never newer.
  newer(version, base = VERSION) {
    const valid = v => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) && v.split('.').map(Number).every(Number.isSafeInteger);
    if (!valid(version) || !valid(base)) return false;
    const current = base.split('.').map(Number), candidate = version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (candidate[i] !== current[i]) return candidate[i] > current[i];
    }
    return false;
  },
  async check() {
    if (this.busy) return;
    this.busy = true;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 15000);
    try {
      const options = { signal: abort.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
      const response = await W.fetch('https://api.github.com/repos/duan78/opensro-bot-lean/commits/main', options);
      if (!response.ok) return;
      const { sha } = await response.json();
      if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) return;
      const base = 'https://raw.githubusercontent.com/duan78/opensro-bot-lean/' + sha + '/bot.lean.';
      const metadata = await W.fetch(base + 'meta.js', options);
      if (!metadata.ok) return;
      const match = (await metadata.text()).match(/^\/\/ @version\s+(\d+\.\d+\.\d+)\s*$/m);
      if (match && this.newer(match[1])) {
        const version = match[1], known = this.latest?.version === version ? this.latest.title : '';
        this.latest = { version, url: base + 'user.js', title: known || await this.headline(sha, version, options) };
      } else if (match) this.latest = null;
    } catch {
      // Offline, rate limits and blocked requests are silent; try next interval.
    } finally {
      clearTimeout(timer); this.busy = false; this.render();
    }
  },
  // The headline of the new version's patch notes (notes/<version>.md at the same commit), so a player sees why
  // to update. Shown as plain text only; a missing or odd file just leaves the plain Update button.
  async headline(sha, version, options) {
    try {
      const response = await W.fetch('https://raw.githubusercontent.com/duan78/opensro-bot-lean/' + sha + '/notes/' + version + '.md', options);
      if (!response.ok) return '';
      const title = String(await response.text()).slice(0, 8192).match(/^# (.+)$/m)?.[1] || '';
      // Control and line-separator characters are dropped: the headline is one line of plain text.
      const plain = [...title].filter(c => { const n = c.codePointAt(0); return n >= 32 && (n < 127 || n >= 160) && n !== 8232 && n !== 8233; });
      return plain.join('').trim().slice(0, 120);
    } catch {
      return '';
    }
  },
  render() {
    if (!UI.updateButton) return;
    const latest = this.latest;
    UI.updateButton.hidden = !latest;
    UI.updateButton.textContent = latest ? 'Update ' + latest.version : 'Update';
    UI.updateButton.title = (latest?.title ? latest.version + ': ' + latest.title + ' · ' : '') + 'Open Tampermonkey to install, then reload the game when ready.';
    if (!UI.updateNote) return;
    UI.updateNote.hidden = !latest?.title;
    UI.updateNote.textContent = latest?.title ? 'Update ' + latest.version + ' available: ' + latest.title : '';
  },
  open() {
    if (this.latest) W.open(this.latest.url, '_blank', 'noopener,noreferrer');
  },
  // The built-in notes (newest first) of the versions after `seen`, up to this one. Without a usable `seen`
  // (an install older than the once-per-version notice), only this version's notes.
  notesSince(seen) {
    const known = typeof seen === 'string' && /^\d+\.\d+\.\d+$/.test(seen);
    return RELEASE_NOTES.filter(n => !this.newer(n.version) && (known ? this.newer(n.version, seen) : n.version === VERSION));
  },
  // Once per installed version: a new install is welcomed, an update opens its patch notes beside the panel.
  announce() {
    const seen = Store.get('seenVersion', null);
    if (seen === VERSION) return false;
    Store.set('seenVersion', VERSION);
    if (!seen && !Store.get('profile:default', null)) {
      UI.toast('Welcome! Updates, suggestions and bug reports are on Discord: use the Discord button at the top of the panel.', 'info', 12000);
      return true;
    }
    const notes = this.notesSince(seen);
    const title = notes.length > 1 && seen ? 'What changed since ' + seen : 'What’s new in ' + VERSION;
    if (!notes.length || !UI.showNotes(notes, title)) UI.toast(`Updated to ${VERSION}. Patch notes are on Discord: use the Discord button at the top of the panel.`, 'info', 12000);
    return true;
  },
  start() {
    if (this.started) return;
    this.started = true;
    setTimeout(() => this.announce(), 5000);
    void this.check();
    setInterval(() => { void this.check(); }, 15 * 60 * 1000);
  },
};
