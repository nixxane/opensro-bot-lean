// Always-on reconnect. When the connection to the game is lost (a server restart, a network drop) the bot waits for the
// game's own retries, then re-enters the world with the login the page already holds, as the Enter button would.
// By default it never stores credentials: if the login itself is gone it says so and waits for you (AutoLogin below
// is the opt-in exception, which logs in again with the login the player last typed on this page). Hunting that was
// running resumes once the character is back at the hunting spot. Choosing logout, disconnect, exit or restart yourself
// cancels everything, and so does logging in or entering a character by hand.
// When the game itself fails to load ("Unable to finish loading") the page is reloaded after a short wait. The character
// and whether hunting was running are kept in localStorage across the reload; the game restores the login from its own
// session cookie, then the same reconnect steps below enter the world and resume hunting. Each reload in a row waits twice
// as long as the one before (up to 30 minutes, plus a small random delay); after 12 hours of reloads it gives up.
// Opt-in auto-login, off by default. While it is on, the next login the player sends from the game's own login screen
// (ID, password, server) is remembered in this site's localStorage, unencrypted, and used only by Reconnect when a
// lost connection ends on the signed-out screen (a server restart that dropped the login). The script runs with
// @grant none, so there is no safer store; the setting says so. Turning it off forgets the login. Nothing here
// reaches the log, diagnostics, reports or shared profiles.
const AutoLogin = {
  KEY: 'sroLean:login', FIRST_WAIT_MS: 10000, LOGIN_REFUSALS: 3, DELAYS: [30000, 60000, 120000, 300000],
  load() { try { return JSON.parse(window.localStorage.getItem(this.KEY)) || {}; } catch { return {}; } },
  enabled() { return this.load().enabled === true; },
  setEnabled(on) {
    try {
      if (on) window.localStorage.setItem(this.KEY, JSON.stringify({ ...this.load(), enabled: true }));
      else window.localStorage.removeItem(this.KEY);
    } catch {}
  },
  saved() {
    const d = this.load(), text = v => typeof v === 'string' && v.length > 0;
    return d.enabled === true && text(d.id) && text(d.password) && text(d.serverId) && text(d.apiBase) ? d : null;
  },
  // A login the player sent: remember it while the setting is on. Our own logins go through Hook.post and never pass here.
  capture(command) {
    if (command?.kind !== 'login' || !this.enabled()) return;
    const { apiBase, id, password, serverId, divisionId } = command;
    if (![apiBase, id, password, serverId].every(v => typeof v === 'string' && v)) return;
    try { window.localStorage.setItem(this.KEY, JSON.stringify({ enabled: true, apiBase, id, password, serverId, ...(typeof divisionId === 'string' && divisionId ? { divisionId } : {}) })); } catch {}
  },
  status() {
    if (!this.enabled()) return 'Off.';
    const s = this.saved();
    return s ? 'Saved: account ' + s.id + ' on server ' + s.serverId + '.' : 'Nothing saved yet: log out and log in once on the game\'s login screen while this is on.';
  },
};
Hook.observers.push(command => AutoLogin.capture(command));

const Reconnect = {
  intent: null, attempts: 0, nextAt: 0, waitUntil: 0, backAt: 0, message: '',
  DELAYS: [4000, 10000, 20000, 30000], GIVE_UP_MS: 12 * 3600 * 1000,
  STORE_KEY: 'sro-lean-reload', LOAD_WAIT_MS: 15000, RELOAD_MAX_MS: 30 * 60000, SNAP_MS: 30 * 60000, PENDING_MS: 10 * 60000, LOGIN_GRACE_MS: 60000,
  restored: false, failedAt: 0, failedWait: 0, expiredAt: 0, expiredWait: 0, EXPIRED_WAIT_MS: 30000, pendingAt: 0, pendingWait: 0, PENDING_WAIT_MS: 180000, COLLISION_WAIT_MS: 180000, collisionWait: 0, collisionCount: 0, snapAt: 0, gaveUp: false,
  loginTries: 0, loginRefused: 0, loginNext: 0, loginAnswered: true,
  // What survives a page reload: the last in-world snapshot, the reloads in a row and the one reload waiting to be resumed.
  load() { try { return JSON.parse(window.localStorage.getItem(this.STORE_KEY)) || {}; } catch { return {}; } },
  save(data) { try { window.localStorage.setItem(this.STORE_KEY, JSON.stringify(data)); } catch {} },
  // The game's own loading screen says when it gave up; its label is only changed to this text on a failure.
  loadFailure() {
    if (typeof document === 'undefined') return '';
    const box = document.getElementById('startup-loading');
    if (!box || box.dataset.error !== 'true' || !/Unable to finish loading/.test(box.querySelector('.sro-boot-loading__label')?.textContent || '')) return '';
    return box.querySelector('.sro-boot-loading__detail')?.textContent || 'Unable to finish loading';
  },
  doReload() { window.location.reload(); },
  snapshot() {
    if (!World.inWorld() || !World.charName || now() - this.snapAt < 5000) return;
    this.snapAt = now();
    const data = this.load();
    this.gaveUp = false;
    this.save({ ...data, reloads: null, snap: { character: World.charName, hunting: this.busy() || !!this.intent?.hunting, at: Date.now() } });
  },
  reloadStreak() {
    const r = this.load().reloads;
    return r && Number.isInteger(r.count) && r.count > 0 && Number.isFinite(r.first) && Number.isFinite(r.last) ? r : null;
  },
  jitter() { return Math.random() * 0.2; },
  reloadWait(base) {
    const n = this.reloadStreak()?.count || 0;
    return Math.round(Math.min(base * 2 ** n, this.RELOAD_MAX_MS) * (1 + this.jitter()));
  },
  waitText(ms) { return ms < 90000 ? Math.max(1, Math.ceil(ms / 1000)) + ' s' : Math.round(ms / 60000) + ' min'; },
  // Right after a reload: pick the character up again exactly as after a lost connection.
  restore() {
    this.restored = true;
    const data = this.load(), p = data.pending;
    if (!p) return;
    this.save({ ...data, pending: null });
    if (!p.character || Date.now() - p.at > this.PENDING_MS) return;
    this.intent = { character: p.character, hunting: !!p.hunting, since: now(), reloaded: true };
    this.attempts = 1; this.nextAt = now() + 3000; this.backAt = 0;
    // The message reaches uploaded diagnostics, so it never carries the character's name.
    this.message = 'The page was reloaded; restoring your character.';
    Log.warn('The game failed to load earlier; page reloaded, restoring ' + p.character + '.');
  },
  // Save what to resume, then reload. Shared by a failed load and an expired session; the wait before it grows with
  // every reload in a row (reloadWait), and reloading stops after 12 hours without getting back into the game.
  reloadPage() {
    const data = this.load(), streak = this.reloadStreak();
    if (streak && Date.now() - streak.first > this.GIVE_UP_MS) {
      if (!this.gaveUp) {
        this.gaveUp = true; this.message = 'Reloaded the page ' + streak.count + ' times over 12 hours without getting back in; not reloading again. Reload the page yourself when the server is back.';
        Log.warn(this.message); UI.toast(this.message, 'warn', 8000);
      }
      return false;
    }
    const known = this.intent ? { character: this.intent.character, hunting: this.intent.hunting } : data.snap && Date.now() - data.snap.at < this.SNAP_MS ? data.snap : null;
    this.save({ snap: data.snap, reloads: { count: (streak?.count || 0) + 1, first: streak?.first || Date.now(), last: Date.now() },
      pending: known ? { character: known.character, hunting: !!known.hunting, at: Date.now() } : null });
    this.doReload();
    return true;
  },
  watchLoad() {
    const text = this.loadFailure();
    if (!text) { this.failedAt = 0; return; }
    if (!this.failedAt) {
      this.failedAt = now(); this.failedWait = this.reloadWait(this.LOAD_WAIT_MS);
      Log.warn('The game failed to load (' + text + '); reloading the page in ' + this.waitText(this.failedWait) + '.');
    }
    if (this.gaveUp) return;
    const left = this.failedWait - (now() - this.failedAt);
    if (left > 0) { this.message = 'The game failed to load; reloading the page in ' + this.waitText(left) + '.'; return; }
    this.reloadPage();
  },

  // In the world, a walk (town trip, walk back) that has waited for collision data the whole time: the game sends the
  // region collision once when the character enters the world, and when that send is lost (seen after a reconnect)
  // nothing sends it again, so the walk waits for good. Leaving the world or a stop does not bring it back; a page
  // reload does. Only while the bot is working. Being back in the world clears the normal reload streak, so these
  // reloads keep their own count (NAV_KEY): each one in a row waits twice as long, up to 30 minutes, and the count
  // clears once collision data arrives.
  NAV_KEY: 'sro-lean-reload-nav', MISSING_STALE_MS: 30000, navStored: null,
  watchCollision() {
    const N = Navigation;
    if (N.scene) {
      N.missingSince = 0; this.collisionWait = 0;
      // Clear the count once (navStored: null = not known yet), not on every tick.
      if (this.navStored !== false) { try { window.localStorage.removeItem(this.NAV_KEY); } catch {} this.navStored = false; }
      return;
    }
    // The game did send collision data but the bot could not use it (Navigation.error): a reload sends the same data
    // again, so it would not help. The walker shows the error instead.
    // Walkers ask at their own pace (a town walk retries every 5 s); missingAt older than MISSING_STALE_MS means no
    // walker is waiting any more.
    if (N.error || !N.missingSince || now() - N.missingAt > this.MISSING_STALE_MS || !World.inWorld() || !this.busy()) { N.missingSince = 0; this.collisionWait = 0; return; }
    if (!this.collisionWait) {
      let n = 0; try { n = Number(JSON.parse(window.localStorage.getItem(this.NAV_KEY))?.count) || 0; } catch {}
      this.collisionWait = Math.round(Math.min(this.COLLISION_WAIT_MS * 2 ** n, this.RELOAD_MAX_MS) * (1 + this.jitter()));
      this.collisionCount = n;
    }
    if (now() - N.missingSince < this.collisionWait) return;
    Log.warn('No collision data from the game after ' + this.waitText(now() - N.missingSince) + '; the character cannot walk. Reloading the page.');
    this.message = 'No collision data from the game; reloading the page.';
    N.missingSince = 0; this.collisionWait = 0;
    try { window.localStorage.setItem(this.NAV_KEY, JSON.stringify({ count: this.collisionCount + 1, at: Date.now() })); this.navStored = true; } catch {}
    this.reloadPage();
  },
  active() { return !!this.intent; },
  clear(message = '') { this.intent = null; this.attempts = 0; this.nextAt = this.waitUntil = this.backAt = this.expiredAt = this.pendingAt = 0; this.loginTries = this.loginRefused = this.loginNext = 0; this.loginAnswered = true; this.message = message; },
  // Signed out with auto-login on: log in again with the remembered login. A login the server refused (an answer with a
  // code: wrong password, banned) is tried at most LOGIN_REFUSALS times; a server that does not answer yet (still
  // restarting) is tried again every few minutes until the 12-hour limit. Messages never carry the account.
  autoLogin(phase, refused) {
    const saved = AutoLogin.saved();
    if (!saved) return false;
    // Each login is answered once; the failed phase stays on screen for many ticks.
    if (phase === 'failed' && !this.loginAnswered) { this.loginAnswered = true; if (refused) this.loginRefused++; }
    if (this.loginRefused >= AutoLogin.LOGIN_REFUSALS) {
      this.message = 'The server refused the automatic login ' + this.loginRefused + ' times; log in yourself. The bot resumes when you are back.';
      return true;
    }
    if (phase === 'authenticating') { this.message = 'Logging in again…'; return true; }
    if (!this.loginNext) this.loginNext = now() + AutoLogin.FIRST_WAIT_MS;
    if (now() < this.loginNext) { this.message = 'Signed out; logging in again in ' + this.waitText(this.loginNext - now()) + '.'; return true; }
    const n = this.loginTries++;
    this.loginAnswered = false;
    this.send({ kind: 'login', apiBase: saved.apiBase, id: saved.id, password: saved.password, serverId: saved.serverId, ...(saved.divisionId ? { divisionId: saved.divisionId } : {}) });
    this.loginNext = now() + AutoLogin.DELAYS[Math.min(n, AutoLogin.DELAYS.length - 1)];
    // Next comes the character list: enter the character, never the game's resume.
    this.attempts = Math.max(this.attempts, 1); this.nextAt = now() + 2000; this.waitUntil = 0;
    this.message = 'Logging in again (attempt ' + (n + 1) + ')…';
    Log.warn('Signed out; logging in again automatically (attempt ' + (n + 1) + ').');
    if (n === 0) UI.toast('Signed out by the server; logging in again automatically.', 'warn', 5000);
    return true;
  },
  // The player stopped the bot: a reconnect in progress, or a reload from the saved snapshot, must not bring hunting back.
  forgetHunting() {
    if (this.intent) this.intent.hunting = false;
    const data = this.load();
    if (data.snap?.hunting) this.save({ ...data, snap: { ...data.snap, hunting: false } });
  },
  // Whether the bot is working, or about to: an auto-start waiting for the game to settle counts.
  busy() { return !!(Hunt.running || Town.trip || WalkBack.active || AutoStart.pending()); },
  // The connection was lost while the bot may have been working: remember what to restore.
  lost() {
    if (!World.charName) return;
    const busy = this.busy();
    if (!this.intent) { this.intent = { character: World.charName, hunting: busy, since: now() }; this.attempts = 0; this.nextAt = now() + 2000; this.message = 'Connection lost; waiting for the game to reconnect.'; Log.warn('Connection lost; reconnecting automatically.'); }
    else if (busy) this.intent.hunting = true;
    this.backAt = 0;
  },
  // The player took over: never fight their choice.
  manual(kind) {
    if (this.intent && ['logout', 'disconnect', 'exit', 'restart', 'login', 'enter-world'].includes(kind)) this.clear('Automatic reconnect cancelled.');
  },
  send(command) {
    if (!Hook.post) return false;
    try { Hook.post({ kind: 'session', command }); return true; } catch (e) { Log.warn('Reconnect command failed: ' + (e?.message || e)); return false; }
  },
  tick() {
    if (!this.restored) this.restore();
    this.watchLoad();
    this.watchCollision();
    this.snapshot();
    const i = this.intent;
    if (!i) return;
    if (now() - i.since > this.GIVE_UP_MS) return this.clear('Gave up reconnecting after 12 hours.');
    if (World.inWorld()) return this.back(i);
    this.backAt = 0;
    const phase = World.phase, error = String(World.session?.error || '');
    // A connect or world entry the server never answers leaves the page in one of these phases for good (seen after a
    // stalled transport): no error, no retry. After a while, reload the page like an expired session; reloads in a row
    // wait longer each time (reloadWait).
    if (['connecting', 'entering-world', 'reconnecting'].includes(phase)) {
      if (!this.pendingAt) { this.pendingAt = now(); this.pendingWait = this.reloadWait(this.PENDING_WAIT_MS); }
      else if (now() - this.pendingAt > this.pendingWait && !this.gaveUp) {
        Log.warn('Reconnecting has not finished after ' + this.waitText(now() - this.pendingAt) + '; reloading the page.');
        this.message = 'Reconnecting did not finish; reloading the page.';
        this.pendingAt = 0;
        if (this.reloadPage()) return;
      }
      // Once the 12-hour limit is reached, keep its message: it tells the player to reload by hand.
      if (!this.gaveUp) this.message = 'Reconnecting…';
      return;
    }
    this.pendingAt = 0;
    // A failed phase right after our own login is that login's answer.
    const loginFailed = phase === 'failed' && this.loginTries > 0;
    if (['signed-out', 'listing-servers', 'loading-roster', 'authenticating'].includes(phase) || /authentication required/i.test(error) || loginFailed) {
      if (i.reloaded && now() - i.since < this.LOGIN_GRACE_MS) { this.message = 'The page was reloaded; waiting for the game to restore your login.'; return; }
      if (this.autoLogin(phase, loginFailed && !!World.session?.code)) return;
      this.message = 'The login is gone (server restart?). Log in and enter your character again; the bot resumes when you are back.';
      return;
    }
    // "Your session ended while the connection was gone": the server dropped the world session (its resume window is 30 s),
    // so resuming can never work. Enter the character afresh; if that does not bring it back, reload the page, which
    // restores the login from the game's session cookie. The window's Confirm button would log out, so it is never pressed.
    // A plain "Disconnected from the server." box has no message to read. When the resume and three fresh entries have all
    // failed the login behind them is stale as well, so it gets the same treatment: enter afresh, then reload the page.
    const expired = phase === 'disconnected' && (/session ended while the connection was gone|could not resume/i.test(String(World.session?.disconnectMessage || '') + ' ' + error) || this.attempts >= 4);
    if (expired) {
      if (!this.expiredAt) {
        this.expiredAt = now(); this.expiredWait = this.reloadWait(this.EXPIRED_WAIT_MS);
        Log.warn('The game session is gone (' + (this.attempts >= 4 ? 'reconnect attempts failed' : 'session ended') + '); entering the character again, then reloading the page in ' + this.waitText(this.expiredWait) + '.');
      } else if (now() - this.expiredAt > this.expiredWait && !this.gaveUp) { this.message = 'Still not back; reloading the page.'; if (this.reloadPage()) return; }
    }
    if (now() < this.nextAt || now() < this.waitUntil) return;
    const n = this.attempts++;
    // First the game's own resume, then a fresh entry with the held login.
    const sent = this.send(n === 0 && !expired ? { kind: 'reconnect' } : { kind: 'enter-world', character: i.character });
    this.nextAt = now() + this.DELAYS[Math.min(n, this.DELAYS.length - 1)];
    this.waitUntil = now() + (sent ? 8000 : 0);
    this.message = 'Reconnecting (attempt ' + (n + 1) + ')…';
    if (sent && n === 0) UI.toast('Disconnected from the game; reconnecting automatically.', 'warn', 5000);
  },
  // Back in the world: resume only what was running, and only when that is safe.
  back(i) {
    if (World.charName !== i.character) return this.clear();
    if (!this.backAt) { this.backAt = now(); this.attempts = 0; this.message = 'Back in the game; settling.'; return; }
    if (now() - this.backAt < 3000 || !World.local() || World.gp?.inventoryPending) return;
    // Killed while disconnected: start hunting so its own death handling revives the character and walks it back to the spot.
    if (i.hunting && !Hunt.running && World.isDead() && Hunt.cfg().center) {
      Hunt.start(); this.clear(Hunt.running ? '' : 'Back in the game, but the character is dead; hunting was not resumed.');
      return UI.toast(Hunt.running ? 'Back in the game, but dead; reviving and returning to the hunting spot.' : this.message, 'info', 4000);
    }
    if (!i.hunting || Hunt.running || World.isDead()) {
      this.clear(i.hunting && World.isDead() ? 'Back in the game, but the character is dead; hunting was not resumed.' : 'Back in the game.');
      return UI.toast(this.message, 'info', 4000);
    }
    // Back in the town of the saved services (a death while disconnected respawns there, or the drop came during a
    // town trip) and far from the hunting spot: do the town services first, as after a death, then reverse or walk back.
    // The character may stand anywhere in town, so the services start from here instead of waiting at the scroll's
    // landing spot. Another town has none of the saved services: walk-back handles that.
    const H = Hunt.cfg(), spot = H.center && World.pose() ? dist2D(World.pose(), H.center) : NaN;
    const c = Town.cfg(), here = Town.detect(), home = Town.detect(c.vendor || c.storage || c.arrival || {});
    if (Town.autoRevive() && Number.isFinite(spot) && spot > Math.max(H.radius * 1.5, 600) && here && home && here.key === home.key) {
      UI.toast('Back in the game, in town; doing town services, then ' + (Town.reverses() ? 'reversing' : 'walking') + ' to the hunting spot.', 'info', 4000);
      Controller.returnAfterRevive();
      if (Town.trip?.phase === 'revive-arrival') Town.arrived();
      return this.clear(Town.trip ? '' : 'Back in the game, but the town cycle could not start: ' + Town.message);
    }
    const outcome = Controller.resumeHunting('Back in the game');
    this.clear(outcome === 'stopped' ? 'Back in the game, but not at the hunting spot. Use Return & hunt when ready.' : '');
  },
};
bus.on('phase', phase => {
  if (['disconnected', 'failed', 'reconnecting'].includes(phase)) Reconnect.lost();
});
Hook.observers.push(command => Reconnect.manual(command?.kind));
