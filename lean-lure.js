// Lure: a tank pulls monsters to the party instead of hunting. It walks to each saved pull point in turn, taunts the
// nearest monster there, walks back to the hunting spot and holds a few seconds so the damage dealers take over,
// then goes to the next point. On the way back with monsters it stops every few metres so they keep up. It never attacks. The area taunt is cast whenever it is ready and a monster is near,
// except while holding at the spot. No stuck handling yet: a point without a walkable route stops hunting.
const LURE_ARRIVAL = 30;      // 3 m
const LURE_TAUNT_MS = 10000;  // give up on a pull point's target after this long and walk back
const Lure = {
  phase: 'back', index: -1, holdUntil: 0, phaseAt: 0, target: 0, pulled: false, sentAt: -Infinity, travel: null, message: 'Lure off.',
  legFrom: null, pauseUntil: 0, halted: false, hurry: false, pulls: 0,
  cfg() { return Settings.profile.lure; },
  on() { return !!this.cfg().enabled && this.cfg().points.length > 0; },
  // Every start begins at the hunting spot, with no hold since nothing was pulled yet; the next point is then A.
  reset() { this.enter('back'); this.index = -1; this.pulled = false; this.pulls = 0; },
  enter(phase) { this.phase = phase; this.phaseAt = now(); this.target = 0; this.travel = null; this.sentAt = -Infinity; this.legFrom = null; this.pauseUntil = 0; this.hurry = false; },
  addPoint() {
    const p = World.pose();
    if (!World.inWorld() || !p) return UI.toast('Enter the game first.', 'warn');
    if (this.cfg().points.length >= 26) return UI.toast('Up to 26 pull points (A to Z).', 'warn');
    this.cfg().points.push({ regionId: p.regionId, x: p.x, y: p.y, z: p.z });
    this.reset(); Settings.saveProfile(); UI.draw();
  },
  removePoint(i) { this.cfg().points.splice(i, 1); this.reset(); Settings.saveProfile(); UI.draw(); },
  skill(entry) { return entry?.group ? World.bestOfGroup(entry.group, entry.id) || entry.id : 0; },
  ready(id) { return !!id && !Combat.blocked(id) && Cmd.canCast(id) && Combat.mpOk(id, World.me()); },
  // The living monster closest to `from` within the search radius.
  nearest(from) {
    const radius = (Number(this.cfg().radius) || 15) * 10;
    let best = null, bestD = Infinity;
    for (const e of World.ents.values()) {
      if (!isAttackableMob(e)) continue;
      const d = dist2D(from, e);
      if (d <= radius && d < bestD) { best = e; bestD = d; }
    }
    return best;
  },
  // Living monsters already inside the training area (the hunting spot's radius): the ones pulled earlier, still being fought.
  atSpot() {
    const home = Settings.profile.hunt.center, radius = Settings.profile.hunt.radius;
    if (!home) return 0;
    let n = 0;
    for (const e of World.ents.values()) if (isAttackableMob(e) && dist2D(home, e) <= radius) n++;
    return n;
  },
  // One step towards `destination`; true once there.
  walk(destination, arrival = LURE_ARRIVAL) {
    if (dist2D(World.pose(), destination) <= arrival) return true;
    const move = Navigation.next(this, destination, false, arrival);
    if (move.error && !move.waiting) { this.message = 'Lure: ' + move.error; Hunt.stop(this.message); return false; }
    if (move.waiting) { this.message = move.error || 'Waiting for the route.'; return false; }
    if (now() - this.sentAt >= 900 && Cmd.move(move.point)) this.sentAt = now();
    return false;
  },
  areaTaunt() {
    const id = this.skill(this.cfg().area);
    if (this.phase === 'hold' || !this.ready(id) || !this.nearest(World.pose())) return false;
    if (!Combat.cast(id, 0)) return false;
    if (this.phase !== 'back') this.pulled = true;
    return true;
  },
  // Strangers within 30 m of the character; party members and the character itself never count.
  playersNear() {
    const pose = World.pose();
    if (!pose) return 0;
    const party = new Set((World.gp?.social?.members || []).map(m => m?.name));
    let n = 0;
    for (const e of World.ents.values())
      if (e.kind === 'player' && e.gid !== World.localGid() && !party.has(e.name) && dist2D(pose, e) <= 300) n++;
    return n;
  },
  tick() {
    const c = this.cfg(), home = Settings.profile.hunt.center, point = c.points[this.index];
    Hunt.state = 'lure';
    if (!home) { this.message = 'Lure: save a hunting spot first.'; return Hunt.stop(this.message); }
    // Pulling monsters onto strangers is what gets a lure reported: with the switches on it stops when other
    // players come within 30 m, and after a chosen number of completed pulls.
    if (c.stopOnPlayers > 0) {
      const strangers = this.playersNear();
      if (strangers >= c.stopOnPlayers) {
        this.message = strangers + ' players within 30 m; lure stopped.';
        Log.info('Lure: ' + this.message);
        return Hunt.stop('Lure: ' + this.message);
      }
    }
    if (c.stopAfter > 0 && this.pulls >= c.stopAfter) {
      this.message = c.stopAfter + ' pulls done; lure stopped.';
      return Hunt.stop('Lure: ' + this.message);
    }
    if (!point && (this.phase === 'out' || this.phase === 'taunt')) this.reset();
    if (World.isCasting() || now() - Combat.lastCastAt < (Settings.profile.macro.castGapMs ?? 250)) return;
    if (this.areaTaunt()) return;
    if (this.phase !== 'back' && this.phase !== 'hold' && World.me().hpPct < c.returnHpPct) {
      this.enter('back'); this.hurry = true; this.message = 'Low HP: back to the party.'; Log.info('Lure: ' + this.message);
    }
    if (this.phase === 'out' && c.stopAt > 0 && this.atSpot() >= c.stopAt) {
      this.message = 'Enough monsters at the spot (' + this.atSpot() + '); waiting before the next pull.';
      if (!this.halted && Cmd.move(World.pose())) this.halted = true;
      return;
    }
    if (this.phase === 'out') {
      this.halted = false;
      this.message = 'Walking to pull point ' + String.fromCharCode(65 + this.index) + '.';
      if (this.walk(point)) this.enter('taunt');
      return;
    }
    if (this.phase === 'taunt') return this.taunt(point);
    if (this.phase === 'back') {
      this.message = this.hurry ? 'Low HP: back to the party.' : 'Bringing monsters back to the party.';
      if (this.pause(home)) return;
      if (!this.walk(home)) return;
      if (!this.pulled) return this.next();
      this.enter('hold'); this.holdUntil = now() + (Number(c.holdS) || 0) * 1000;
    }
    if (this.phase === 'hold') {
      this.message = 'Holding while the party takes over.';
      if (now() >= this.holdUntil) this.next();
    }
  },
  // Bringing monsters back: stand still for a few seconds after every stretch so they keep up. Not when hurrying back on low HP.
  pause(home) {
    const c = this.cfg(), every = (Number(c.pauseEveryM) || 0) * 10, p = World.pose();
    if (!this.pulled || this.hurry || every <= 0 || !(Number(c.pauseS) > 0) || !p) return false;
    if (now() < this.pauseUntil) {
      this.message = 'Waiting for the monsters to follow.';
      if (!this.halted && Cmd.move(p)) this.halted = true;
      return true;
    }
    if (!this.legFrom) this.legFrom = { ...p };
    if (dist2D(p, home) <= LURE_ARRIVAL || dist2D(p, this.legFrom) < every) return false;
    this.legFrom = { ...p }; this.pauseUntil = now() + Number(c.pauseS) * 1000; this.halted = false;
    return this.pause(home);
  },
  next() { if (this.pulled) this.pulls++; this.index = (this.index + 1) % this.cfg().points.length; this.pulled = false; this.enter('out'); },
  // Pick the monster nearest the point, select it, get into range and cast the single-target taunt on it.
  taunt(point) {
    const id = this.skill(this.cfg().taunt);
    if (!id || now() - this.phaseAt > LURE_TAUNT_MS) { this.enter('back'); return; }
    let e = World.ents.get(this.target);
    if (!e || !isAttackableMob(e)) {
      e = this.nearest(point);
      if (!e) { this.message = 'No monster at this pull point.'; this.enter('back'); return; }
      this.target = e.gid; this.travel = null;
    }
    this.message = 'Taunting ' + (e.name || 'a monster') + '.';
    const range = Math.max(10, (World.skill(id)?.range || 150) - 5);
    if (dist2D(World.pose(), e) > range) { this.walk(e, range); return; }
    if (!Cmd.select(e.gid) || World.gp.target !== e.gid || World.gp.targetPending || !this.ready(id)) return;
    if (Combat.cast(id, e.gid)) { this.pulled = true; this.enter('back'); }
  },
  status() {
    const c = this.cfg();
    if (!c.enabled) return 'Lure off.';
    if (!c.points.length) return 'Add at least one pull point.';
    if (!this.skill(c.taunt) && !this.skill(c.area)) return 'Choose a taunt skill.';
    return Hunt.running ? this.message : 'Start the bot to lure.';
  },
  draw(host) {
    const c = () => this.cfg(), letter = i => String.fromCharCode(65 + i);
    const pick = key => v => { const id = Number(v); c()[key] = { id, group: id ? World.skill(id)?.group ?? id : 0 }; };
    const options = buff => () => [[0, 'None'], ...UI.learnedSkills(buff).map(s => [s.id, s.name || '#' + s.id])];
    const box = UI.group('Lure',
      UI.check('Lure instead of hunting', () => c().enabled, v => { c().enabled = v; this.reset(); }),
      el('p', 'For a tank. Walks to each pull point in turn, taunts the nearest monster, brings it back to the hunting spot, pausing on the way so the monsters keep up (0 m = no pauses; none when coming back on low HP), and holds while the party takes over. Never attacks. The area taunt goes out whenever it is ready and a monster is near, except while holding.', 'muted'),
      UI.select('Single-target taunt', options(false), () => this.skill(c().taunt) || 0, pick('taunt')),
      UI.select('Area taunt', options(true), () => this.skill(c().area) || 0, pick('area')),
      UI.number('Hold at the spot (s)', () => c().holdS, v => c().holdS = v, 0, 30),
      UI.number('On the way back, pause every (m)', () => c().pauseEveryM, v => c().pauseEveryM = v, 0, 50),
      UI.number('Pause length (s)', () => c().pauseS, v => c().pauseS = v, 0, 30),
      UI.number('Search radius at a point (m)', () => c().radius, v => c().radius = v, 3, 50),
      UI.number('Stop pulling at this many monsters in the training area (0 = off)', () => c().stopAt, v => c().stopAt = v, 0, 50),
      UI.number('Stop when this many other players are within 30 m (0 = off)', () => c().stopOnPlayers, v => c().stopOnPlayers = v, 0, 8),
      UI.number('Stop after this many completed pulls (0 = off)', () => c().stopAfter, v => c().stopAfter = v, 0, 999),
      UI.number('Back to the party below HP (%)', () => c().returnHpPct, v => c().returnHpPct = v, 0, 95),
      UI.button('Add pull point here', () => this.addPoint()));
    const center = Settings.profile.hunt.center;
    c().points.forEach((p, i) => {
      const d = center ? dist2D(center, p) : NaN;
      box.append(UI.row(el('span', 'Point ' + letter(i) + ': ' + (Number.isFinite(d) ? Math.round(d / 10) + ' m from the spot' : 'another region')),
        UI.button('Remove point ' + letter(i), () => this.removePoint(i))));
    });
    if (!center) box.append(el('p', 'Save a hunting spot first: the lure brings monsters back there.', 'muted'));
    this.note = el('p', this.status(), 'muted'); box.append(this.note); host.append(box);
  },
};
