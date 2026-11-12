// Discord session reports: one webhook message every few minutes with the current session totals.
// The address is a bearer secret, so it lives in this browser's storage (not the profile) and is never
// shared, backed up or logged. Only the panel's test button sends at once; a failed report waits for the
// next interval, and a refused webhook switches the feature off instead of retrying forever.
const REPORT_WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{5,}\/[\w-]{20,}$/;
const REPORT_COLORS = { Hunting: 0x2ecc71, Stopped: 0xf1c40f, Dead: 0xe74c3c, 'Out of game': 0x95a5a6 };
const Reporter = {
  sending: false, nextAt: 0, lastAt: 0, lastError: '', holdUntil: 0,
  // A hand-edited or corrupted storage value must never become a POST target.
  webhook() {
    const url = String(Store.get('sessionWebhook', '') || '');
    return REPORT_WEBHOOK.test(url) ? url : '';
  },
  setWebhook(value) {
    const url = String(value ?? '').trim();
    if (!url) { Store.remove('sessionWebhook'); return true; }
    if (!REPORT_WEBHOOK.test(url)) return false;
    return Store.set('sessionWebhook', url);
  },
  enabled() { return Settings.profile.sessionReport.on === true && !!this.webhook() && typeof W.fetch === 'function'; },
  // Clamped again here: an edited profile must never post more often than once a minute.
  intervalMs() {
    const minutes = Number(Settings.profile.sessionReport.minutes);
    return clamp(Number.isFinite(minutes) ? Math.round(minutes) : 3, 1, 60) * 60000;
  },
  state() {
    if (!World.inWorld()) return 'Out of game';
    if (World.isDead()) return 'Dead';
    return Hunt.running ? 'Hunting' : 'Stopped';
  },
  text(value) { return String(value ?? '').slice(0, 1024); },
  message() {
    const d = Stats.display(), s = Stats.session, level = World.gp?.progression?.level;
    const fields = [
      ['Session', this.state()],
      ['Character', (World.charName || 'No character') + (Number.isInteger(level) ? ' · level ' + level : '')],
      ['Hunting time', d.time],
      ['XP gained', d.xp],
      ['XP / hour', d.rate],
      ['Net gold', d.gold],
      ['Confirmed kills', d.kills],
      ['Deaths', d.deaths],
      ['Potions used', d.potions],
      ['Items picked up', d.items],
      ['SoX found', d.sox],
      ['Star / Moon / Sun', s.star + ' / ' + s.moon + ' / ' + s.sun],
    ].map(([name, value]) => ({ name, value: this.text(value), inline: true })).filter(field => field.value);
    return { username: 'nixxane bot', allowed_mentions: { parse: [] },
      embeds: [{ title: this.text((World.charName || 'No character') + ' — session report').slice(0, 256), color: REPORT_COLORS[this.state()] ?? REPORT_COLORS.Stopped,
        timestamp: new Date().toISOString(), fields: fields.slice(0, 25),
        footer: { text: this.text('nixxane bot ' + VERSION + ' · every ' + this.intervalMs() / 60000 + ' min') } }] };
  },
  clock(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  },
  ago(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return 'less than a minute ago';
    return seconds < 3600 ? Math.floor(seconds / 60) + ' min ago' : Math.floor(seconds / 3600) + ' h ago';
  },
  // Cheap enough for the panel: called by update() every 500 ms.
  status() {
    if (Settings.profile.sessionReport.on !== true) return this.lastError ? 'Off: ' + this.lastError + '.' : 'Off.';
    if (typeof W.fetch !== 'function') return 'This browser cannot send reports.';
    if (!this.webhook()) return 'No webhook saved.';
    if (this.sending) return 'Sending…';
    const next = !this.nextAt ? 'Waiting to send.' : this.nextAt > now() ? 'Next in ' + this.clock(this.nextAt - now()) + '.' : 'Next report due.';
    if (this.lastError) return 'Last report failed: ' + this.lastError + '. ' + (this.nextAt > now() ? 'Next try in ' + this.clock(this.nextAt - now()) + '.' : 'Retrying shortly.');
    if (!this.lastAt) return 'No report sent yet. ' + next;
    return 'Last report ' + this.ago(now() - this.lastAt) + '. ' + next;
  },
  // The panel's timer. Enabling arms one full interval; lowering the interval takes effect on the next tick.
  // A rate-limit hold always wins over the interval, and a disable does not throw it away.
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
  async send(manual) {
    const base = this.webhook();
    if (!base) { if (manual) UI.toast('Save a Discord webhook address first.', 'warn'); return false; }
    if (this.sending) { if (manual) UI.toast('A session report is already being sent.', 'info', 3000); return false; }
    if (typeof W.fetch !== 'function') { if (manual) UI.toast('This browser cannot send Discord reports.', 'warn'); return false; }
    const url = base + (base.includes('?') ? '&' : '?') + 'wait=true';
    this.sending = true;
    let timer;
    try {
      const controller = new (W.AbortController || AbortController)();
      timer = setTimeout(() => controller.abort(), 20000);
      const response = await W.fetch(url, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.message()), signal: controller.signal });
      if (response.ok) {
        this.lastAt = now(); this.lastError = ''; this.holdUntil = 0; this.nextAt = now() + this.intervalMs();
        if (manual) UI.toast('Test report sent to Discord.');
        return true;
      }
      if (response.status === 429) {
        let seconds = NaN;
        try { seconds = Number((await response.json())?.retry_after); } catch {}
        if (!Number.isFinite(seconds) || seconds <= 0) seconds = Number(response.headers?.get?.('Retry-After'));
        const wait = clamp(Number.isFinite(seconds) && seconds > 0 ? seconds : 60, 1, 900);
        this.lastError = 'Discord asked to wait ' + Math.ceil(wait) + ' s';
        this.holdUntil = now() + wait * 1000;
        this.nextAt = this.holdUntil;
        if (manual) UI.toast('Discord asked the bot to wait before the next report.', 'info', 4000);
        return false;
      }
      if (response.status >= 400 && response.status < 500) {
        // 401/403/404 mean the address itself is gone; 400 and the rest mean Discord refused this report.
        // Retrying any of them on the interval would repeat the refusal forever.
        const reason = [401, 403, 404].includes(response.status) ? 'Discord refused the webhook' : 'Discord refused the report';
        Settings.profile.sessionReport.on = false;
        Settings.saveProfile();
        this.lastError = reason;
        this.nextAt = 0;
        UI.toast('Discord reports stopped: ' + reason + '. Check the address.', 'warn');
        Activity.emit({ category: 'session', code: 'session-report-rejected', level: 'warn', text: 'Discord reports stopped: ' + reason + '.' });
        return false;
      }
      return this.failed('Discord answered ' + response.status, manual);
    } catch {
      return this.failed('No answer from Discord', manual);
    } finally {
      clearTimeout(timer);
      this.sending = false;
    }
  },
  // Short reasons only: never the address, the token or a response body.
  failed(reason, manual) {
    this.lastError = reason;
    this.nextAt = Math.max(now() + this.intervalMs(), this.holdUntil);
    Activity.emit({ category: 'session', code: 'session-report-failed', level: 'warn', text: 'Discord session report failed: ' + reason + '.' });
    if (manual) UI.toast('Discord report failed: ' + reason + '.', 'warn');
    return false;
  },
  // A world reset clears the schedule and the error; a rate-limit hold expires on its own.
  reset() { this.nextAt = 0; this.lastError = ''; },
};
bus.on('reset', () => Reporter.reset());
