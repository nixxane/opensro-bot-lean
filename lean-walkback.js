// Independent return command using the saved hunt centre and native movement.
// A long trip first tries the converted route graph (lean-route.js), which
// chooses the corridor across the whole map. Every step is still walked with
// Navigation over the game's own collision window. Without a route the trip is
// walked in short legs: the game publishes collision data only for the 3x3
// regions around the character, so each leg ends across the next region border.
const WALK_LEG = 2400;           // game units; safely inside the 3x3 collision window
const WALK_LEG_REACH = 240;  // a leg is done within this distance of its end
const WALK_MAX_LEGS = 60;        // hard safety cap on chained legs for one return
const WALK_MAX_MS = 30 * 60000;  // hard safety cap for the leg fallback
const WALK_NAV_MS = 90 * 60000;  // absolute cap for a navdata route
const WALK_PLAN_MS = 6000;       // wait this long for route data before falling back
const WALK_NAV_REACH = 60;       // a navdata waypoint is passed within this: it may stand on a rock edge
const WALK_NAV_SKIPS = 2;        // unreachable navdata waypoints skipped in a row before re-planning

const WalkBack = {
  active: null,
  start(resume = false) {
    if (BuffGear.run || BuffGear.recovery) return UI.toast('Restore or review combat gear before travelling.', 'warn');
    if (Alchemy.run || Alchemy.pending) return UI.toast('Stop alchemy and wait for its result before travelling.', 'warn');
    if (Town.trip) return UI.toast('Stop the town cycle before starting walk-back.', 'warn');
    if (!World.inWorld() || World.isDead()) return UI.toast('Enter the world with a living character first.', 'warn');
    const dest = Settings.profile.hunt.center, pose = World.pose();
    if (!dest || !pose) return UI.toast('Save a hunting spot first using Set here in Hunt → Area.', 'warn');
    if (!Number.isFinite(dist2D(pose, dest))) return UI.toast('Return to the same world or dungeon before walking back.', 'warn');
    if (World.gp?.inventoryPending) return UI.toast('Wait for the inventory transaction to finish.', 'warn');
    Resurrect.cancelTrip('', true); Resurrect.holdUntil = 0;
    const shouldResume = resume || Hunt.running || !!this.active?.resume;
    this.cancel();
    Restock.cancelRecording();
    Restock.trip = null;
    if (Hunt.running) Hunt.stop();
    if (Restock.activeShop() || World.gp?.storage) Cmd.raw({ kind: 'npc-close' }, 'Walk back: close merchant');
    const recorded = Restock.cfg().route;
    let route = [], nearest = -1, best = 500;
    if (recorded.length && dist2D(recorded[recorded.length - 1], dest) <= 500) {
      recorded.forEach((p, i) => { const d = dist2D(pose, p); if (d <= best) { nearest = i; best = d; } });
      if (nearest >= 0) route = recorded.slice(nearest).map(p => ({ ...p }));
    }
    route.push({ ...dest });
    // Across water or between unconnected areas: teleports and ferries (lean-travel.js) take over.
    if (Travel.begin(pose, dest, shouldResume)) return;
    this.launch(dest, route, pose, shouldResume);
  },
  // Walk anywhere, not just to the hunting spot (Trade uses this between towns). The caller owns the safety checks
  // that start() does for hunting; onDone runs on arrival and onFail(reason) when the walk gives up.
  startTo(dest, { label = 'the destination', stop = 12, onDone, onFail } = {}) {
    const pose = World.pose();
    if (!dest || !pose || !World.inWorld() || World.isDead()) return false;
    if (!Number.isFinite(dist2D(pose, dest))) { onFail?.('The destination is in another world or dungeon.'); return false; }
    this.cancel();
    this.launch(dest, [{ ...dest }], pose, false, { label, stop, onDone, onFail });
    return !!this.active;
  },
  launch(dest, route, pose, shouldResume, opts = {}) {
    // The direct distance is a lower bound; a recorded route can be longer.
    let distance = 0, previous = pose;
    for (const point of route) { const leg = dist2D(previous, point); distance += Number.isFinite(leg) ? leg : 0; previous = point; }
    distance = Math.max(distance, dist2D(pose, dest) || 0);
    this.active = { destination: { ...dest }, legRoute: route, legRecorded: route.length > 1, distance,
      label: opts.label || 'the hunting spot', stop: opts.stop || 12, onDone: opts.onDone || null, onFail: opts.onFail || null,
      route: null, recorded: false, source: '', index: 0, resume: shouldResume, totalLegs: Math.max(1, Math.ceil(distance / WALK_LEG)),
      legs: 0, leg: null, legTries: 0, navReplans: 0, routeArea: '', routeLength: 0,
      manualAt: Manual.lastAt, at: now(), progressAt: now(), lastPose: { ...pose }, sentAt: -Infinity, replans: 0, retryAt: 0,
      best: distance, bestAt: now(), maxMs: WALK_MAX_MS, plan: null };
    if (!opts.label) UI.toast('Walking back to the hunting spot.', 'info', 2500);
    // The route graph is only worth a loading wait where the leg fallback would
    // have to chain (more than one leg), and only outdoors in one route area.
    const routeArea = typeof Route !== 'undefined' ? Route.commonArea(pose, dest) : null;
    const navWorth = distance > WALK_LEG && !!routeArea &&
      !(pose.regionId & DUNGEON) && !(dest.regionId & DUNGEON);
    if (!navWorth) return this.useLegs();
    // With the game's asset worker the corridor is checked against the real collision first (lean-route-check.js).
    const check = RouteCheck.available();
    let planned = null;
    if (!check) { try { planned = Route.plan(pose, dest); } catch { planned = null; } }
    if (planned) return this.useNav(planned, pose);
    const a = this.active, token = {};
    a.plan = { at: now(), token, limit: check ? CHECK_MS + 5000 : WALK_PLAN_MS };
    a.source = 'planning';
    Log.info('Route: loading navdata for ' + routeArea.name + (check ? ' and checking it against the game map.' : '.'));
    Route.checked(pose, dest).then(next => {
      if (this.active !== a || a.plan?.token !== token) return;
      if (next) this.useNav(next, World.pose());
      else this.useLegs();
    }, () => {
      if (this.active === a && a.plan?.token === token) this.useLegs();
    });
  },
  cancel(reason = '', halt = true) {
    if (!this.active) return;
    const failed = this.active.onFail;
    this.active = null;
    if (halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    // A caller-owned walk reports its own failures; only a reasoned cancel is a failure, a plain cancel is the caller's.
    if (failed && reason) failed(reason); else if (reason) UI.toast(reason, 'warn', 4000);
  },
  // Navdata corridor: its waypoints are short steps for the local collision A*.
  useNav(route, pose) {
    const a = this.active;
    if (!a || !route?.points?.length) return false;
    a.route = [...route.points.map(p => ({ ...p })), { ...a.destination }];
    a.recorded = false;
    a.source = 'navdata';
    a.routeArea = route.area;
    a.routeLength = route.length + (dist2D(route.points[route.points.length - 1], a.destination) || 0);
    a.index = 0; a.skips = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    a.maxMs = Math.max(WALK_MAX_MS, Math.min(WALK_NAV_MS, a.routeLength / 20 * 1000 * 2));
    a.plan = null;
    Log.info('Route: using navdata (' + route.area + ') with ' + route.points.length + ' waypoints.');
    return true;
  },
  // Leg fallback, including the recorded merchant route and the distance caps.
  useLegs() {
    const a = this.active;
    if (!a || a.source === 'legs') return false;
    const pose = World.pose();
    if (a.distance > WALK_LEG * WALK_MAX_LEGS) {
      this.cancel('The hunting spot is ' + Math.round(a.distance / 10) + ' m away; that is too far to walk safely. Move closer or use a return scroll.');
      return false;
    }
    a.route = a.legRoute; a.recorded = a.legRecorded; a.source = 'legs';
    a.index = 0; a.skips = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.totalLegs = Math.max(1, Math.ceil(a.distance / WALK_LEG)); a.legs = 0;
    a.maxMs = WALK_MAX_MS; a.plan = null;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    Log.info('Route: no navdata route' + (Route?.message ? ' (' + Route.message + ')' : '') + '; walking in legs.');
    return true;
  },
  // A navdata route that stops making progress is re-planned once or twice from
  // where the character stands, then handed to the leg fallback.
  replan(pose) {
    const a = this.active;
    if (!a || a.source !== 'navdata' || a.navReplans >= 2) return false;
    a.navReplans++;
    let route = null;
    try { route = Route.plan(pose, a.destination); } catch { return false; }
    if (!route?.points?.length) return false;
    a.route = [...route.points.map(p => ({ ...p })), { ...a.destination }];
    a.index = 0; a.skips = 0; a.travel = null; a.leg = null; a.legTries = 0;
    a.progressAt = now(); a.lastPose = { ...pose }; a.best = dist2D(pose, a.destination); a.bestAt = now();
    Log.info('Route: re-planned from the current position with ' + route.points.length + ' waypoints.');
    return true;
  },
  // Plain progress for the status strip, the compact status line and diagnostics.
  status() {
    const a = this.active;
    if (!a) return '';
    if (a.source === 'planning') return 'Walking to ' + a.label + ': ' + (RouteCheck.message || 'loading route data') + '.';
    const left = dist2D(World.pose(), a.destination);
    const progress = Number.isFinite(left) && a.distance ? ' · ' + Math.round(left / 10) + ' m left' : '';
    if (a.source === 'navdata') {
      const at = Math.min(a.route.length, a.index + 1);
      return 'Walking to ' + a.label + ': waypoint ' + at + '/' + a.route.length + progress + '.';
    }
    const leg = Number.isFinite(left) ? Math.max(1, Math.min(a.totalLegs, a.totalLegs - Math.ceil(left / WALK_LEG) + 1)) : 1;
    return (a.totalLegs > 1 ? 'Walking to ' + a.label + ': leg ' + leg + '/' + a.totalLegs : 'Walking to ' + a.label) + progress + '.';
  },
  // The straight leg end is unreachable. Try a snapped or slightly turned end of
  // the same rough length, rate-limited so a missing collision window can arrive.
  detour(pose, dest) {
    const a = this.active;
    if (!a?.leg) return false;
    if (now() < a.retryAt) return true;
    a.legTries++;
    const target = Navigation.detour(pose, dest, WALK_LEG, { radius: Math.min(480, 120 * a.legTries) });
    if (!target) { a.retryAt = now() + 3000; return true; }
    a.leg = { target, from: { ...pose }, revision: Navigation.revision };
    a.travel = null; a.sentAt = -Infinity;
    Log.info('Walk back: this leg is blocked; trying a nearby route.');
    return true;
  },
  tick() {
    const a = this.active;
    if (!a) return;
    if (!World.inWorld() || World.isDead()) return this.cancel('Walk back interrupted.', false);
    if (Manual.lastAt !== a.manualAt) return this.cancel('Manual control: walk back cancelled.', false);
    // Self buffs marked "Hunting and walk-back" are kept up while travelling; the walk owns the tick, so no
    // hunting cast happens at the same time and a refused skill only backs itself off.
    Controller.guard('walkBuffs', () => Combat.buffs(false));
    if (a.source === 'planning') {
      if (now() - a.plan.at <= (a.plan.limit || WALK_PLAN_MS)) return;
      if (!this.useLegs()) return;
    }
    if (!a.route?.length) return;
    const pose = World.pose(), dest = a.route[a.index], distance = dist2D(pose, dest);
    if (!Number.isFinite(distance)) return this.cancel('Cannot walk to the saved hunting spot.');
    // Only the last point may use the caller's wider arrival radius; waypoints on the way stay tight.
    const last = a.index >= a.route.length - 1;
    if (distance <= (last ? a.stop : a.source === 'navdata' ? WALK_NAV_REACH : 12)) {
      a.index++; a.skips = 0; a.leg = null; a.legTries = 0; a.progressAt = now(); a.lastPose = { ...pose }; a.travel = null;
      if (a.index < a.route.length) return;
      this.active = null;
      if (a.onDone) return a.onDone();
      UI.toast('Back at the hunting spot.', 'info', 2500);
      if (a.resume) Hunt.start();
      return;
    }
    if (dist2D(a.lastPose, pose) > 3) { a.lastPose = { ...pose }; a.progressAt = now(); a.replans = 0; }
    if (now() - a.progressAt > 20000) {
      if (a.source === 'navdata' && this.replan(pose)) return;
      if (a.source === 'navdata' && this.useLegs()) return;
      return this.cancel(a.legTries ? 'Walk back stopped: no walkable route to the hunting spot.' : 'Walk back stopped: path blocked or travel timed out.');
    }
    if (now() - a.at > a.maxMs) return this.cancel('Walk back stopped: the trip took longer than ' + Math.round(a.maxMs / 60000) + ' minutes.');
    // A detour may walk away from the goal, so also check real progress towards it.
    const left = dist2D(pose, a.destination);
    if (!Number.isFinite(a.best) || left < a.best - 20) { a.best = left; a.bestAt = now(); }
    if (now() - a.bestAt > 300000) return this.cancel('Walk back stopped: no progress towards the hunting spot.');
    if (now() < a.retryAt) return;
    if (now() - a.progressAt > 6000 && a.travel && a.replans < 2) { a.travel = null; a.replans++; a.sentAt = -Infinity; }
    // A newly published window invalidates the leg target; the next leg starts
    // from the position reached, using the new coverage.
    if (a.leg && a.leg.revision !== Navigation.revision) { a.leg = null; a.legTries = 0; a.travel = null; }
    if (a.leg && dist2D(pose, a.leg.target) <= 12) { a.leg = null; a.legTries = 0; a.travel = null; }
    if (a.source === 'legs' && !a.leg && distance > WALK_LEG) {
      if (a.legs >= WALK_MAX_LEGS) return this.cancel('Walk back stopped: the hunting spot needs too many separate legs.');
      const target = Navigation.legPoint(pose, dest, WALK_LEG);
      if (target) {
        a.leg = { target, from: { ...pose }, revision: Navigation.revision };
        a.legs++; a.legTries = 0;
        Log.info('Walk back: leg ' + a.legs + ' of about ' + a.totalLegs + '.');
        Activity.emit({ category: 'movement', code: 'walk-leg', text: 'Walk back leg ' + a.legs + ' of about ' + a.totalLegs + '.', details: { leg: a.legs, legs: a.totalLegs } });
      }
    }
    // Standing against something the collision map does not know: route around the spot, then give up.
    if (!World.isSitting()) {
      const stall = Navigation.watch(a, pose, a.sentAt, a.travel?.route[a.travel.index] || a.leg?.target || dest);
      if (stall === 'recover') Log.info('Walk back: stuck against an obstacle; trying another way round.');
      else if (stall === 'giveup') {
        if (a.source === 'navdata' && (this.replan(pose) || this.useLegs())) return;
        return this.cancel('Walk back stopped: an obstacle blocks the way and I could not walk around it.');
      }
    }
    // A leg end only gives the direction: its neighbourhood will do, which spares
    // searching for a point that may lie on a slope or a rock.
    // The last point may stand on something solid (an NPC): its stop radius is reach enough. A navdata waypoint only
    // gives the way: its neighbourhood will do.
    const waypoint = !last && a.source === 'navdata', reach = waypoint ? WALK_NAV_REACH : last && a.stop > 12 ? a.stop : 0;
    const move = a.leg ? Navigation.next(a, a.leg.target, a.recorded, WALK_LEG_REACH, true) : Navigation.next(a, dest, a.recorded, reach, reach > 0);
    if (move.error && !move.waiting) {
      if (waypoint && (a.skips || 0) < WALK_NAV_SKIPS) {
        a.skips = (a.skips || 0) + 1; a.index++; a.travel = null; a.progressAt = now();
        Log.info('Walk back: a route point is out of reach; going on to the next one.');
        return;
      }
      if (a.source === 'navdata') {
        if (this.replan(pose)) return;
        if (this.useLegs()) return;
      }
      if (this.detour(pose, dest)) return;
      return this.cancel(move.error);
    }
    // The clipper is searching between frames: stand still, without counting it as no progress.
    if (move.planning) { a.progressAt = now(); a.retryAt = now() + 250; return; }
    if (move.waiting) {
      // The leg can end early at the edge of the loaded window, before the
      // crossing that publishes the next one. Keep the progress made.
      if (!move.error && a.leg && dist2D(a.leg.from, pose) >= 100) {
        a.leg = null; a.legTries = 0; a.travel = null; a.progressAt = now(); a.retryAt = now() + 1000;
        return;
      }
      if (move.error && a.navMessage !== move.error) { a.navMessage = move.error; UI.toast(move.error, 'warn'); }
      if (a.source === 'navdata' && !move.error && dist2D(pose, dest) > 12) {
        if (this.replan(pose)) return;
        if (this.useLegs()) { a.progressAt = now(); return; }
      }
      a.retryAt = now() + 1500;
      return;
    }
    if (World.isSitting()) {
      if (now() - a.sentAt >= 2500 && Cmd.action(1000)) a.sentAt = now();
    } else if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
  },
};
