// Live dashboard: the bot posts a small snapshot of itself to the user's own hub every few seconds, so a phone can watch it.
// The hub is live/worker (a Cloudflare Worker on the user's own account) or live/hub.js behind an HTTPS tunnel. The data
// goes nowhere else. The address and code are a secret: they live in this browser's storage (Store key liveChannel), not in
// the profile, and never reach shares, backups, diagnostics, the log or window.SROLean. It is built like lean-reporter.js:
// one request at a time, a failure waits for the next interval, a refusal switches the feature off.
const LIVE_ORIGIN = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::(\d{1,5}))?$/;
const LIVE_CODE = /^[A-Za-z0-9_-]{16,64}$/;
const LIVE_PAIR_PATH = /^\/pair\/([A-Za-z0-9_-]{16,64})\/?$/;
const LIVE_FRAGMENT = /^#nixlive=([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;
const LIVE_LOG_LINES = 12;
// Every new target is logged by the bot; on a phone that buries the events worth seeing, and kills are counted in the stats anyway.
const LIVE_QUIET_CODES = ['target-selected', 'target-search'];
const Live = {
  sending: false, nextAt: 0, lastAt: 0, lastError: '', holdUntil: 0, pending: null, worker: null,
  // ---- the secret: validated when it is written and again when it is read ----
  // A hand-edited or corrupted storage value must never become a POST target.
  validUrl(value) {
    const match = LIVE_ORIGIN.exec(String(value ?? ''));
    return !!match && (match[1] === undefined || Number(match[1]) <= 65535);
  },
  validCode(value) { return LIVE_CODE.test(String(value ?? '')); },
  channel() {
    const saved = Store.get('liveChannel', null);
    if (!saved || typeof saved !== 'object' || !this.validUrl(saved.url) || !this.validCode(saved.code)) return null;
    return { url: saved.url, code: saved.code };
  },
  setChannel(url, code) {
    url = String(url ?? '').trim().replace(/\/+$/, ''); code = String(code ?? '').trim();
    if (!this.validUrl(url) || !this.validCode(code)) return false;
    return Store.set('liveChannel', { url, code });
  },
  clearChannel() { Store.remove('liveChannel'); this.holdUntil = 0; this.nextAt = 0; },
  // What the panel's address field accepts: the hub's pair link (address and code), or just its address.
  parseInput(text) {
    const value = String(text ?? '').trim();
    if (!value) return null;
    if (this.validUrl(value.replace(/\/+$/, ''))) return { url: value.replace(/\/+$/, ''), code: '' };
    try {
      const url = new URL(value), pair = LIVE_PAIR_PATH.exec(url.pathname);
      if (url.protocol !== 'https:' || url.username || url.password || !pair || !this.validUrl(url.origin)) return null;
      return { url: url.origin, code: pair[1] };
    } catch { return null; }
  },
  enabled() { return Settings.profile.live.on === true && !!this.channel() && typeof W.fetch === 'function'; },
  // Clamped again here: an edited profile must never post more often than every 3 seconds.
  intervalMs() {
    const seconds = Number(Settings.profile.live.seconds);
    return clamp(Number.isFinite(seconds) ? Math.round(seconds) : 10, 3, 60) * 1000;
  },
  // ---- what is sent: the same JSON as live/reporter.user.js, read straight from the bot's own modules ----
  say(entry) {
    try { return String(Activity.userMessage(entry)); } catch { return String(entry.text); }
  },
  snapshot() {
    const name = World.charName;
    if (!name) return null;
    const progress = World.gp?.progression || {}, me = World.me(), pose = World.pose();
    const need = Number(Stats.levels?.[progress.level]?.expRequired);
    return {
      name, bot: VERSION,
      level: progress.level ?? null,
      xpPct: need > 0 && progress.experience != null ? Math.floor(Number(progress.experience) / need * 1000) / 10 : null,
      hp: Math.round(me.hpPct), mp: Math.round(me.mpPct),
      inWorld: World.inWorld(), dead: World.isDead(), running: !!Hunt.running, state: String(Hunt.state || ''),
      note: String(Reconnect.message || '').slice(0, 120),
      pos: pose ? { region: pose.regionId, x: Math.round(pose.x), z: Math.round(pose.z) } : null,
      stats: Stats.display(),
      log: Log.lines.filter(e => e.level !== 'cmd' && !(e.level === 'info' && LIVE_QUIET_CODES.includes(e.code))).slice(-LIVE_LOG_LINES)
        .map(e => ({ at: e.lastAt || e.at, level: e.level, text: this.say(e).slice(0, 200) + (e.repeatCount > 1 ? ' ×' + e.repeatCount : '') })),
    };
  },
  // ---- status line for the panel ----
  clock(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  },
  ago(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return seconds + ' s ago';
    return seconds < 3600 ? Math.floor(seconds / 60) + ' min ago' : Math.floor(seconds / 3600) + ' h ago';
  },
  // Cheap enough for the panel: called by update() every 500 ms.
  status() {
    if (Settings.profile.live.on !== true) return this.lastError ? 'Off: ' + this.lastError + '.' : 'Off.';
    if (typeof W.fetch !== 'function') return 'This browser cannot send reports.';
    if (!this.channel()) return 'No hub saved.';
    if (this.sending) return 'Sending…';
    const next = !this.nextAt ? 'Waiting to send.' : this.nextAt > now() ? 'Next in ' + this.clock(this.nextAt - now()) + '.' : 'Next report due.';
    if (this.lastError) return 'Last report failed: ' + this.lastError + '. ' + (this.nextAt > now() ? 'Next try in ' + this.clock(this.nextAt - now()) + '.' : 'Retrying shortly.');
    if (!this.lastAt) return 'No report sent yet. ' + next;
    return 'Last report ' + this.ago(now() - this.lastAt) + '. ' + next;
  },
  // ---- the timer ----
  // Enabling arms one full interval; lowering the interval takes effect on the next tick. A rate-limit hold always wins
  // over the interval, and a disable does not throw it away.
  tick() {
    if (this.sending) return;
    if (!this.enabled()) { this.nextAt = 0; return; }
    if (!this.nextAt) { this.nextAt = Math.max(now() + this.intervalMs(), this.holdUntil); return; }
    if (this.nextAt - now() > this.intervalMs()) this.nextAt = Math.max(now() + this.intervalMs(), this.holdUntil);
    if (now() < this.nextAt) return;
    // Move the next slot before sending, so a failure or a rate limit can never retry early.
    this.nextAt = now() + this.intervalMs();
    void this.send(false).catch(() => {});
  },
  // A background tab slows page timers to about once a minute, which would make the dashboard show the bot as offline.
  // A worker's timer is not slowed. The plain interval in the boot loop still calls tick() if the worker cannot start
  // (a Blob worker blocked by the page, or no Worker at all), and tick() is safe to call from both.
  startTimer() {
    if (this.worker || typeof W.Worker !== 'function') return;
    try {
      const url = URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),1000)'], { type: 'text/javascript' }));
      this.worker = new (Hook.NativeWorker || W.Worker)(url, { name: 'nix-live-timer' });
      this.worker.onmessage = () => this.tick();
      this.worker.onerror = () => { try { this.worker?.terminate(); } catch {} this.worker = null; };
    } catch { this.worker = null; }
  },
  async send(manual) {
    const channel = this.channel();
    if (!channel) { if (manual) UI.toast('Save a hub address and code first.', 'warn'); return false; }
    if (this.sending) { if (manual) UI.toast('A live report is already being sent.', 'info', 3000); return false; }
    if (typeof W.fetch !== 'function') { if (manual) UI.toast('This browser cannot send live reports.', 'warn'); return false; }
    let snapshot;
    try { snapshot = this.snapshot(); } catch { return this.failed('The bot could not read its state', manual); }
    if (!snapshot) { if (manual) UI.toast('No character is in the game yet.', 'info', 4000); return false; }
    this.sending = true;
    let timer;
    try {
      const controller = new (W.AbortController || AbortController)();
      timer = setTimeout(() => controller.abort(), 20000);
      const response = await W.fetch(channel.url + '/report', { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', 'X-Code': channel.code }, body: JSON.stringify(snapshot), signal: controller.signal });
      if (response.ok) {
        this.lastAt = now(); this.lastError = ''; this.holdUntil = 0; this.nextAt = now() + this.intervalMs();
        if (manual) UI.toast('Test report sent to your hub.');
        return true;
      }
      if (response.status === 429) {
        let seconds = Number(response.headers?.get?.('Retry-After'));
        if (!Number.isFinite(seconds) || seconds <= 0) { try { seconds = Number((await response.json())?.retry_after); } catch {} }
        const wait = clamp(Number.isFinite(seconds) && seconds > 0 ? seconds : 60, 1, 900);
        this.lastError = 'Hub asked to wait ' + Math.ceil(wait) + ' s';
        this.holdUntil = now() + wait * 1000;
        this.nextAt = this.holdUntil;
        if (manual) UI.toast('The hub asked the bot to wait before the next report.', 'info', 4000);
        return false;
      }
      if (response.status >= 400 && response.status < 500) {
        // 401/403/404 mean the code or the address is wrong; the rest mean the hub refused this report.
        // Retrying any of them on the interval would repeat the refusal forever.
        const reason = [401, 403, 404].includes(response.status) ? 'Hub refused the code' : 'Hub refused the report';
        Settings.profile.live.on = false;
        Settings.saveProfile();
        this.lastError = reason;
        this.nextAt = 0;
        UI.toast('Live dashboard stopped: ' + reason + '. Check the address and code.', 'warn');
        Activity.emit({ category: 'session', code: 'live-rejected', level: 'warn', text: 'Live dashboard stopped: ' + reason + '.' });
        return false;
      }
      return this.failed('Hub answered ' + response.status, manual);
    } catch {
      // A blocked cross-origin call and an unreachable hub look the same to the page.
      return this.failed('No answer from the hub', manual);
    } finally {
      clearTimeout(timer);
      this.sending = false;
    }
  },
  // Short reasons only: never the address, the code or a response body.
  failed(reason, manual) {
    this.lastError = reason;
    this.nextAt = Math.max(now() + this.intervalMs(), this.holdUntil);
    Activity.emit({ category: 'session', code: 'live-failed', level: 'warn', text: 'Live dashboard report failed: ' + reason + '.' });
    if (manual) UI.toast('Live report failed: ' + reason + '.', 'warn');
    return false;
  },
  // A world reset clears the schedule and the error; a rate-limit hold expires on its own.
  reset() { this.nextAt = 0; this.lastError = ''; },
  // ---- pairing: #nixlive=<base64url(origin)>:<code>, from the hub's pair page ----
  // A link can come from anyone, and a crafted one would point this bot at someone else's hub, so nothing is stored until
  // the player presses Pair. The fragment is removed from the address bar either way.
  begin() {
    let hash = '';
    try { hash = String(W.location?.hash || ''); } catch {}
    if (!hash.startsWith('#nixlive=')) return false;
    this.clearFragment();
    const match = LIVE_FRAGMENT.exec(hash);
    let url = '';
    try {
      const encoded = match ? match[1].replace(/-/g, '+').replace(/_/g, '/') : '';
      url = encoded ? (W.atob || atob)(encoded + '='.repeat((4 - encoded.length % 4) % 4)) : '';
    } catch {}
    if (!match || !this.validUrl(url) || !this.validCode(match[2])) {
      this.pending = null;
      UI.toast('That pairing link is not valid.', 'warn');
      UI.showPairing?.();
      return false;
    }
    this.pending = { url, code: match[2] };
    // The toast reaches the log, which must not carry the hub's address: the confirm row in the panel shows it instead.
    UI.toast('Pair request received: confirm it in the NIX window.', 'info', 8000);
    UI.showPairing?.();
    return true;
  },
  clearFragment() {
    try { W.history?.replaceState?.(null, '', W.location.pathname + W.location.search); } catch {}
  },
  // Pair: save the hub and switch the dashboard on. Cancel: forget the request.
  confirmPairing() {
    const request = this.pending;
    if (!request) return false;
    this.pending = null;
    if (!this.setChannel(request.url, request.code)) { UI.toast('Could not save the hub. Check that this browser allows storage.', 'warn'); UI.showPairing?.(); return false; }
    Settings.profile.live.on = true;
    Settings.saveProfile();
    this.lastError = ''; this.holdUntil = 0; this.nextAt = 0;
    this.tick();
    UI.toast('Paired. Live dashboard is on.');
    UI.showPairing?.();
    return true;
  },
  cancelPairing() { this.pending = null; UI.showPairing?.(); },
};
bus.on('reset', () => Live.reset());
