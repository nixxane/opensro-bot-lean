// Team relay bus: a private WebSocket channel between this bot and the player's other characters.
// Presence only: every character that knows the room key joins the same room on a relay the player
// operates, and each sees the others' name, hunting state and level. The bus is an independent
// service: it runs with hunting stopped, survives world transitions, and a relay that is off or
// unreachable changes nothing about the bot's own behaviour.
const TEAM_BEAT_MS = 5000;      // presence cadence; the relay drops a client silent for 30 s
const TEAM_PEER_TTL_MS = 15000; // a peer whose beat stops is forgotten, not kept half-alive
const TEAM_BACKOFF_MS = [5000, 10000, 20000, 60000]; // reconnect delay per consecutive failure
const Team = {
  socket: null, state: 'off', message: 'Team relay off.', peers: new Map(), name: '',
  attempts: 0, retryAt: -Infinity, sentAt: -Infinity, cfgKey: null,
  cfg() { return Settings.profile.team; },
  reset() {
    this.close();
    this.peers.clear();
    this.attempts = 0; this.retryAt = -Infinity; this.sentAt = -Infinity;
    const on = !!this.cfg().enabled;
    this.state = on ? 'connecting' : 'off';
    this.message = on ? 'Connecting to the team relay…' : 'Team relay off.';
  },
  close() {
    const s = this.socket;
    this.socket = null;
    if (s) { s.onopen = s.onclose = s.onmessage = s.onerror = null; try { s.close(); } catch {} }
  },
  payload() {
    return { hunting: !!Hunt.running, alive: World.inWorld() && !World.isDead(),
      mode: String(Controller.mode || 'idle'), level: World.gp?.progression?.level ?? null };
  },
  send(msg) {
    if (this.socket?.readyState !== 1) return false;
    try { this.socket.send(JSON.stringify(msg)); return true; } catch { return false; }
  },
  connect(url) {
    let s = null;
    try { s = new W.WebSocket(url); } catch (e) {
      this.scheduleRetry('Relay address refused: ' + (e?.message || e).slice?.(0, 100));
      return;
    }
    this.socket = s;
    this.state = 'connecting';
    this.message = 'Connecting to the team relay…';
    s.onopen = () => {
      if (this.socket !== s) return;
      this.sentAt = now();
      this.send({ v: 1, type: 'hello', token: String(this.cfg().token || ''), name: this.name, state: this.payload() });
    };
    s.onmessage = e => { if (this.socket === s) this.receive(e?.data); };
    // The browser always fires close after an error, so retries are owned by close alone.
    s.onerror = () => {};
    s.onclose = () => { if (this.socket === s) { this.socket = null; this.scheduleRetry(); } };
  },
  scheduleRetry(note = '') {
    const delay = TEAM_BACKOFF_MS[Math.min(this.attempts, TEAM_BACKOFF_MS.length - 1)];
    this.attempts++;
    this.retryAt = now() + delay;
    this.state = 'retrying';
    this.message = (note || 'Relay connection lost') + '; retrying in ' + Math.round(delay / 1000) + ' s.';
    if (this.attempts <= 2) Log.warn('Team relay: ' + this.message);
  },
  receive(text) {
    let msg = null;
    try { msg = JSON.parse(String(text)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'welcome':
        // The room accepted us: only now are we really online, and only now does the backoff
        // reset — an open socket whose hello the relay keeps rejecting must not retry every 5 s.
        this.attempts = 0;
        this.state = 'online';
        this.message = 'Connected as ' + this.name + '.';
        this.peers = new Map((Array.isArray(msg.peers) ? msg.peers : [])
          .filter(p => p?.name && p.name !== this.name)
          .map(p => [p.name, { state: p.state || {}, at: now() }]));
        UI.toast('Team relay connected.', 'info', 3000);
        break;
      case 'peer':
        if (msg.name && msg.name !== this.name) this.peers.set(msg.name, { state: msg.state || {}, at: now() });
        break;
      case 'join':
        if (msg.name && msg.name !== this.name && !this.peers.has(msg.name)) {
          this.peers.set(msg.name, { state: {}, at: now() });
          UI.toast(msg.name + ' joined the team relay.', 'info', 3000);
        }
        break;
      case 'leave':
        if (msg.name && this.peers.delete(msg.name)) UI.toast(msg.name + ' left the team relay.', 'info', 3000);
        break;
      case 'error': {
        const note = 'Relay: ' + String(msg.message || 'error').slice(0, 120);
        Log.warn('Team relay: ' + note);
        this.close();
        this.scheduleRetry(note);
        break;
      }
    }
  },
  tick() {
    const c = this.cfg();
    const key = !!c.enabled + '|' + c.url + '|' + c.token;
    if (key !== this.cfgKey) { this.cfgKey = key; this.reset(); }
    const t = now();
    for (const [name, peer] of this.peers) if (t - peer.at > TEAM_PEER_TTL_MS) this.peers.delete(name);
    if (!c.enabled) return;
    const url = String(c.url || '').trim();
    // The game page is HTTPS: a remote relay must use wss. Plain ws survives only to localhost,
    // exactly the sockets the browser itself still allows, so local tests work as documented.
    const local = /^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(url);
    if (!/^wss:\/\//i.test(url) && !local) { this.state = 'off'; this.message = 'The relay address must start with wss://.'; return; }
    if (typeof W.WebSocket !== 'function') { this.state = 'off'; this.message = 'This browser has no WebSocket.'; return; }
    const name = String(World.charName || World.gp?.social?.localName || '');
    if (!name) { this.state = 'waiting'; this.message = 'Waiting for the character name…'; return; }
    this.name = name;
    if (!this.socket && t >= this.retryAt) this.connect(url);
    if (this.socket?.readyState === 1 && t - this.sentAt >= TEAM_BEAT_MS) {
      if (this.send({ type: 'beat', name: this.name, state: this.payload() })) this.sentAt = t;
    }
  },
  status() {
    if (!this.cfg().enabled) return 'Team relay off.';
    if (this.state === 'online') return 'Connected as ' + this.name + '; ' + this.peers.size + (this.peers.size === 1 ? ' peer' : ' peers') + ' in the room.';
    return this.message;
  },
  // The diagnostics line: same information, without the character name (reports omit names).
  diag() {
    if (!this.cfg().enabled) return '';
    if (this.state === 'online') return 'online, ' + this.peers.size + (this.peers.size === 1 ? ' peer' : ' peers') + ' in the room';
    return this.message;
  },
  peerRows() {
    const t = now();
    return [...this.peers.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, peer]) => {
      const s = peer.state || {};
      const what = s.hunting ? 'hunting' : s.alive === false ? 'dead' : s.mode || 'idle';
      return name + ' · ' + what + (Number.isInteger(s.level) ? ' · level ' + s.level : '') + ' · ' + Math.max(0, Math.round((t - peer.at) / 1000)) + ' s ago';
    });
  },
};
