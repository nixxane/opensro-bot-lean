// Sharing settings. A share code or file holds only what differs from the defaults and nothing personal: positions,
// town and merchant points, walking routes, buff weapon sets, the chosen weapons and shield, and the wardrobe stay out. Importing never runs
// anything: the text is parsed as data, every field is checked against the defaults, and a preview lists the changes
// before anything is applied. The previous settings are kept so one press undoes an import.
const SHARE = { apps: ['nixxane-bot', 'sro-bot-lean'], format: 1, maxChars: 300000, maxNodes: 20000, plain: 'nixxane0:', packed: 'nixxane1:' };
const ProfileShare = {
  pending: null, code: '', message: '', note: null, view: null, box: null,
  isMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); },
  clone(v) { return JSON.parse(JSON.stringify(v)); },
  // The fields that mean nothing on another character; an import keeps the importer's own.
  // The team relay's room key is access control, so it is personal too: a share code must
  // never publish it, and an import must never connect the importer to someone else's relay.
  personal(p) {
    const r = p.potion.restock, t = r.town;
    return this.clone({ center: p.hunt.center, vendor: r.vendor, route: r.route, offers: r.offers,
      town: { arrival: t.arrival, storage: t.storage, vendor: t.vendor, smith: t.smith, gate: t.gate }, buffSets: p.macro.buffSets, gear: p.items.gear, wardrobe: p.wardrobe, follow: p.trace.name, pullPoints: p.lure.points, team: p.team });
  },
  restore(p, own) {
    const r = p.potion.restock, t = r.town;
    p.hunt.center = own.center; r.vendor = own.vendor; r.route = own.route; r.offers = own.offers;
    Object.assign(t, own.town); p.macro.buffSets = own.buffSets; p.items.gear = own.gear; p.wardrobe = own.wardrobe; p.trace.name = own.follow; p.lure.points = own.pullPoints; p.team = own.team;
    // A buff assigned to a weapon set means nothing without the sets; one assigned to the primary or secondary weapon or
    // the shield uses the importer's own.
    for (const b of p.macro.buffs) if (b && !BUFF_GEAR_KINDS.includes(b.gearSet) && !p.macro.buffSets.some(s => s.id === Number(b.gearSet))) b.gearSet = 0;
    return p;
  },
  strip(p) {
    const q = this.clone(p), d = this.clone(DEFAULT_PROFILE);
    this.restore(q, this.personal(d));
    return q;
  },
  // Only what differs from the defaults, so a code stays short and a default is never "shared".
  diff(value, base) {
    if (Array.isArray(base) || !this.isMap(base)) return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
    const out = {};
    for (const k of Object.keys(value || {})) {
      const d = this.diff(value[k], k in base ? base[k] : undefined);
      if (d !== undefined) out[k] = d;
    }
    return Object.keys(out).length ? out : undefined;
  },
  // Untrusted text: no prototype keys, bounded depth and size.
  safe(value, depth = 0, count = { n: 0 }) {
    if (++count.n > SHARE.maxNodes || depth > 12) return false;
    if (Array.isArray(value)) return value.every(v => this.safe(v, depth + 1, count));
    if (!value || typeof value !== 'object') return true;
    return Object.keys(value).every(k => !['__proto__', 'constructor', 'prototype'].includes(k) && this.safe(value[k], depth + 1, count));
  },
  // Every field takes the default's type; unknown fields are dropped, except in the settings that are maps by design
  // (item rules, per-kind collectors, attribute targets).
  conform(base, value) {
    if (Array.isArray(base)) return Array.isArray(value) && value.length <= 500 ? this.clone(value) : this.clone(base);
    if (base === null) return value === null || this.isMap(value) || ['number', 'boolean', 'string'].includes(typeof value) ? this.clone(value ?? null) : null;
    if (this.isMap(base)) {
      const source = this.isMap(value) ? value : {}, out = {};
      if (!Object.keys(base).length) {
        for (const k of Object.keys(source).slice(0, 5000)) if (/^[\w.:-]{1,64}$/.test(k) && source[k] !== undefined) out[k] = this.clone(source[k]);
        return out;
      }
      for (const k of Object.keys(base)) out[k] = this.conform(base[k], source[k]);
      return out;
    }
    if (typeof base === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : base;
    if (typeof base === 'string') return typeof value === 'string' ? value.slice(0, 500) : base;
    return typeof value === typeof base ? value : base;
  },
  // The settings an import would leave you with: the shared ones, plus your own positions and wardrobe.
  build(imported) {
    const own = this.personal(Settings.profile);
    return this.restore(botProfile(this.conform(DEFAULT_PROFILE, imported)), own);
  },
  // Starter settings: changes laid over the current settings (arrays are replaced, everything else you have stays).
  overlay(settings) { return botProfile(deepMerge(this.clone(Settings.profile), settings)); },
  text(share = true) {
    const profile = this.diff(share ? this.strip(Settings.profile) : Settings.profile, DEFAULT_PROFILE) || {};
    return JSON.stringify({ app: SHARE.apps[0], format: SHARE.format, version: VERSION, profile }, null, share ? 0 : 2);
  },
  // Text <-> bytes <-> base64 without relying on browser-only helpers.
  bytes(text) { return Uint8Array.from(unescape(encodeURIComponent(text)), c => c.charCodeAt(0)); },
  string(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096)); return decodeURIComponent(escape(s)); },
  toBase64(bytes) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += a[n >> 18 & 63] + a[n >> 12 & 63] + (i + 1 < bytes.length ? a[n >> 6 & 63] : '') + (i + 2 < bytes.length ? a[n & 63] : '');
    }
    return out;
  },
  fromBase64(text) {
    const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', out = [];
    const clean = text.replace(/[\s=]/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (/[^A-Za-z0-9_-]/.test(clean) || clean.length % 4 === 1) throw Error('The share code is damaged.');
    for (let i = 0; i < clean.length; i += 4) {
      const n = [0, 1, 2, 3].map(j => i + j < clean.length ? a.indexOf(clean[i + j]) : 0).reduce((x, v) => (x << 6) | v, 0);
      out.push(n >> 16 & 255); if (i + 2 < clean.length) out.push(n >> 8 & 255); if (i + 3 < clean.length) out.push(n & 255);
    }
    return Uint8Array.from(out);
  },
  async pipe(bytes, stream) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader(), parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > SHARE.maxChars) { reader.cancel(); throw Error('The share code is too large.'); }
      parts.push(value);
    }
    const out = new Uint8Array(size); let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  },
  async encode(json) {
    try {
      if (typeof CompressionStream === 'function') return SHARE.packed + this.toBase64(await this.pipe(this.bytes(json), new CompressionStream('deflate-raw')));
    } catch {}
    return SHARE.plain + this.toBase64(this.bytes(json));
  },
  async decode(input) {
    const text = String(input || '').trim();
    if (!text) throw Error('Paste a share code or choose a settings file first.');
    if (text.length > SHARE.maxChars) throw Error('That is too large to be a settings share.');
    if (text.startsWith(SHARE.packed)) {
      if (typeof DecompressionStream !== 'function') throw Error('This browser cannot open compressed share codes.');
      return this.string(await this.pipe(this.fromBase64(text.slice(SHARE.packed.length)), new DecompressionStream('deflate-raw')));
    }
    if (text.startsWith(SHARE.plain)) return this.string(this.fromBase64(text.slice(SHARE.plain.length)));
    return text;
  },
  async parse(input) {
    let data;
    try { data = JSON.parse(await this.decode(input)); } catch (e) { throw Error(/share|paste|large|browser/i.test(e.message) ? e.message : 'That is not a nixxane bot settings share.'); }
    if (!this.isMap(data) || !SHARE.apps.includes(data.app) || !this.isMap(data.profile)) throw Error('That is not a nixxane bot settings share.');
    if (!this.safe(data.profile)) throw Error('That settings share contains values that are not allowed.');
    return data.profile;
  },
  // path -> value for every setting, so two profiles can be compared one setting at a time.
  flat(value, path = '', out = new Map()) {
    if (this.isMap(value)) { for (const k of Object.keys(value)) this.flat(value[k], path ? path + '.' + k : k, out); if (!Object.keys(value).length && path) out.set(path, '{}'); }
    else out.set(path, JSON.stringify(value));
    return out;
  },
  changes(current, next) {
    const a = this.flat(current), b = this.flat(next), rows = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) rows.push({ path: k, from: a.get(k) ?? '(not set)', to: b.get(k) ?? '(not set)' });
    return rows;
  },
  show(v) { const s = String(v); return s.length > 50 ? s.slice(0, 47) + '…' : s; },
  async preview(input) {
    const imported = await this.parse(input), next = this.build(imported), rows = this.changes(Settings.profile, next);
    return { imported, next, rows };
  },
  backupKey() { return 'backup:' + Settings.profileKey; },
  hasBackup() { return !!Store.get(this.backupKey(), null)?.profile; },
  apply() {
    const p = this.pending;
    if (!p) return false;
    if (Hunt.running) { UI.toast('Stop hunting before importing settings.', 'warn'); return false; }
    const next = p.preset ? this.overlay(p.preset) : this.build(p.imported);
    Store.set(this.backupKey(), { at: Date.now(), profile: this.clone(Settings.profile) });
    stopAll();
    Settings.profile = next; Settings.saveProfile();
    this.pending = null; this.message = `Imported ${p.rows.length} setting${p.rows.length === 1 ? '' : 's'}. Your previous settings are kept: press Undo last import to go back.`;
    bus.emit('profile'); UI.toast(this.message); return true;
  },
  undo() {
    const backup = Store.get(this.backupKey(), null);
    if (!backup?.profile) { UI.toast('There is no import to undo.', 'warn'); return false; }
    if (Hunt.running) { UI.toast('Stop hunting before undoing an import.', 'warn'); return false; }
    stopAll();
    Settings.profile = botProfile(backup.profile); Settings.saveProfile();
    Store.set(this.backupKey(), null); this.pending = null; this.message = 'Your settings from before the import are back.';
    bus.emit('profile'); UI.toast(this.message); return true;
  },
  summary(rows) {
    if (!rows.length) return 'These settings match what you have now; nothing would change.';
    const groups = {};
    for (const r of rows) { const g = r.path.split('.')[0]; groups[g] = (groups[g] || 0) + 1; }
    return `${rows.length} setting${rows.length === 1 ? '' : 's'} would change (${Object.entries(groups).map(([g, n]) => g + ' ' + n).join(', ')}). Your positions, town points, routes, buff weapon sets and wardrobe stay as they are.`;
  },
  draw(parent) {
    const box = UI.group('Share and import settings');
    const area = el('textarea'); area.rows = 4; area.placeholder = 'Paste a share code or the contents of a settings file here';
    const out = el('textarea'); out.rows = 3; out.readOnly = true; out.hidden = true; out.setAttribute('aria-label', 'Your share code');
    const file = el('input'); file.type = 'file'; file.accept = '.json,application/json,text/plain'; file.hidden = true;
    const status = el('p', this.message, 'muted'), changes = el('pre'); changes.hidden = true;
    const apply = UI.button('Apply import', () => { if (this.apply()) UI.draw(); }), cancel = UI.button('Cancel', () => { this.pending = null; changes.hidden = apply.hidden = cancel.hidden = true; status.textContent = ''; });
    apply.hidden = cancel.hidden = true;
    const say = text => { this.message = text; status.textContent = text; };
    file.addEventListener('change', () => {
      const f = file.files?.[0]; if (!f) return;
      if (f.size > SHARE.maxChars) return say('That file is too large to be a settings share.');
      const reader = new FileReader();
      reader.onload = () => { area.value = String(reader.result || ''); say('File loaded. Press Preview import.'); };
      reader.onerror = () => say('The file could not be read.');
      reader.readAsText(f);
    });
    const copy = async () => {
      out.value = await this.encode(this.text(true)); out.hidden = false; out.select();
      try { await W.navigator.clipboard.writeText(out.value); say('Share code copied. It holds only your settings, not your positions or town points.'); }
      catch { say('Select the code above and copy it. It holds only your settings, not your positions or town points.'); }
    };
    box.append(el('p', 'Share your settings with others, or load settings someone shared. A share holds only what you changed from the defaults: never your positions, town points, routes, buff weapon sets or wardrobe. An import shows what it would change first, never touches those, and can be undone.', 'muted'),
      UI.row(UI.button('Copy share code', () => { void copy(); }), UI.button('Save share file', () => {
        const url = URL.createObjectURL(new Blob([this.text(true)], { type: 'application/json' }));
        const link = el('a'); link.href = url; link.download = 'nixxane-bot-share.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })), out, area,
      UI.row(UI.button('Open file…', () => file.click()), UI.button('Preview import', async () => {
        try {
          const p = await this.preview(area.value); this.pending = p;
          changes.textContent = p.rows.slice(0, 60).map(r => `${r.path}: ${this.show(r.from)} → ${this.show(r.to)}`).join('\n') + (p.rows.length > 60 ? `\n… and ${p.rows.length - 60} more` : '');
          changes.hidden = !p.rows.length; apply.hidden = cancel.hidden = !p.rows.length; say(this.summary(p.rows));
        } catch (e) { this.pending = null; changes.hidden = apply.hidden = cancel.hidden = true; say(e.message); }
      })), file, status, changes, UI.row(apply, cancel),
      UI.button('Undo last import', () => { if (this.undo()) UI.draw(); }));
    this.note = status; parent.append(box);
  },
};
