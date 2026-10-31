const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/bot.lean.user.js', 'utf8');
const isolated = source.slice(0, source.lastIndexOf('installWorkerHook();')) +
  'globalThis.bot = {AutoStart, RenderControl, Activity, World, Settings, Updates, Diagnostics, Reports, Alchemy, BuffGear, Icons, Hook, Cmd, Hunt, Loot, Restock, Trade, WalkBack, Navigation, ClipRoute, Route, RouteCheck, Learned, Display, Wardrobe, WdData, LeanWardrobe, Controller, UI, Stats, Combat, Potion, Party, Town, Travel, bus, Manual, Resurrect, Support, ItemRules, SpeedScroll, RepairHammer, Stall, Log, AntiStuck, Chase, Trap, botProfile, ItemRules, Items, AutoMastery, StatPoints, ProfileShare, Setup, Trace, DEFAULT_PROFILE, PetPotion, Reconnect, Reconnect, Lure, stopAll, toggleBot, userStop, RunIntent, Retry, boot, Ticker, Sound, LeanMap};\n})();';
function fixture(document) {
  let time = 100000;
  const storage = new Map(), commands = [], notices = [], intervals = [], timers = [];
  const win = { addEventListener() {}, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } };
  const context = { window: win, document, performance: { now: () => time }, console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, clearInterval() {}, setInterval(fn, ms) { intervals.push({ fn, ms }); }, AbortController, Blob, FormData, URL, Map, Set, Date, ArrayBuffer, DataView, atob };
  vm.createContext(context); vm.runInContext(isolated, context);
  const b = context.bot;
  b.UI.toast = message => notices.push(message);
  b.Hook.post = msg => commands.push(msg.command.command);
  b.World.phase = 'world'; b.World.simOffset = 0;
  b.World.gp = { localGid: 1, target: 0, targetPending: false, inventoryPending: false,
    pose: { regionId: 1, x: 100, y: 0, z: 100 }, progression: { gold: '100000', stats: { maxHp: 100, maxMp: 100 } },
    inventory: [], inventorySlotCount: 30, equipmentSlotCount: 13, skills: [], vitals: [],
    social: { members: [] }, pendingMoves: 0, shopCompletionRevision: 0 };
  b.World.ents.set(1, { gid: 1, kind: 'player', movementMode: 0, appearanceState: [0, 0, 0] });
  b.Settings.profile.hunt.center = { regionId: 1, x: 100, y: 0, z: 100 };
  b.Settings.profile.hunt.sit.enabled = false;
  b.Loot.init();
  b.Navigation.install(navProduct());
  function drop(gid = 20, tf = 2284) {
    const e = { gid, kind: 'ground-item', refObjId: 101, name: 'HP potion', regionId: 1, x: 200, y: 0, z: 100, groundItem: { typeFlags: tf, goldAmount: 0 } };
    b.World.ents.set(gid, e); return e;
  }
  return { ...b, commands, notices, storage, drop, win, intervals, timers, advance: ms => { time += ms; } };
}
let passed = 0;
function renderDocument(prototype = {}) {
  const document = Object.create(prototype), nodes = [];
  document.documentElement = { append(node) { nodes.push(node); } };
  document.createElement = () => {
    const attributes = {}, events = {};
    return { attributes, style: {}, setAttribute(k, v) { attributes[k] = v; },
      addEventListener(k, fn) { events[k] = fn; }, click() { events.click(); },
      remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); } };
  };
  return { document, nodes };
}
test('render button suspends the native drawing path and restores real tab visibility', () => {
  let visibility = 'visible';
  const { document, nodes } = renderDocument({ get visibilityState() { return visibility; } });
  const f = fixture(document), button = f.RenderControl.button();
  assert.equal(button.textContent, 'No Render');
  f.Hunt.running = true;
  button.click();
  assert.equal(document.visibilityState, 'hidden');
  assert.equal(button.textContent, 'Render');
  assert.equal(button.attributes['aria-label'], 'Resume game rendering');
  assert.equal(nodes.length, 1, 'black mask is outside the NIX panel');
  assert.match(nodes[0].style.cssText, /background:#000!important/);
  assert.match(nodes[0].style.cssText, /position:fixed!important;inset:0!important/);
  assert.match(nodes[0].style.cssText, /z-index:2147483645!important/);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(f.Hunt.running, true); assert.equal(f.commands.length, 0);
  petFight(f); f.drop(20, 3436); f.Settings.profile.hunt.pickup.afterKillOnly = false;
  let fights = 0; f.Combat.fight = () => { fights++; };
  f.Controller.tick();
  assert.equal(fights, 1, 'combat still runs with rendering suspended');
  assert.equal(f.commands.some(c => c.kind === 'cos-pickup'), true, 'pet pickup keeps running');
  f.RenderControl.set(false); // Repeated suspension must retain the original descriptor.
  assert.equal(nodes.length, 1, 'duplicate clicks do not add another mask');
  f.stopAll();
  assert.equal(document.visibilityState, 'hidden');
  visibility = 'hidden'; button.click();
  assert.equal(button.textContent, 'No Render');
  assert.equal(button.attributes['aria-label'], 'Suspend game rendering');
  assert.equal(nodes.length, 0, 'resuming removes the black mask');
  assert.equal(Object.hasOwn(document, 'visibilityState'), false);
  assert.equal(document.visibilityState, 'hidden', 'an actual hidden tab stays hidden');
  visibility = 'visible'; assert.equal(document.visibilityState, 'visible');
  assert.equal(button.attributes['aria-pressed'], 'false');
});
test('render toggle restores an existing own descriptor and tolerates unavailable documents', () => {
  const { document, nodes } = renderDocument();
  const descriptor = { configurable: true, enumerable: true, get: () => 'visible', set: undefined };
  Object.defineProperty(document, 'visibilityState', descriptor);
  const f = fixture(document);
  assert.equal(f.RenderControl.set(false), true);
  assert.equal(f.RenderControl.set(true), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(document, 'visibilityState'), descriptor);
  Object.defineProperty(document, 'visibilityState', { configurable: false });
  assert.equal(f.RenderControl.set(false), false);
  assert.equal(f.RenderControl.suspended, false);
  assert.equal(document.visibilityState, 'visible');
  assert.equal(nodes.length, 0, 'a failed toggle leaves no black mask');
  assert.match(f.notices.at(-1), /unavailable/);
  assert.equal(fixture().RenderControl.set(false), false);
});
test('render toggle leaves a later visibility hook intact', () => {
  const { document, nodes } = renderDocument(), f = fixture(document);
  f.RenderControl.set(false);
  const getter = () => 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: getter });
  f.RenderControl.set(true);
  assert.equal(Object.getOwnPropertyDescriptor(document, 'visibilityState').get, getter);
  assert.equal(nodes.length, 0);
});
function pickupPet(f, commandMode = 7) {
  const rec = { gid: 50, refObjId: 500, band: 4, hp: 100, status: 5, inventory: [], commandMode };
  f.World.gp.cosRecords = [rec];
  f.World.ents.set(50, { gid: 50, kind: 'cos', refObjId: 500, ownerGid: 1, regionId: 1, x: 100, y: 0, z: 100 });
  f.Settings.profile.hunt.pickup.collector = 'pet'; f.Loot.preset('elixirs');
  return rec;
}
test('pet disables only native auto-grab bit and waits for server confirmation', () => {
  const f = fixture(), pet = pickupPet(f, 0x1c7), d = f.drop(20, 3436);
  assert.equal(f.Loot.preparePet(), false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'cos-behavior', gid: 50, mode: 0x147 });
  assert.equal(pet.commandMode, 0x1c7); assert.equal(f.Loot.begin(d), false);
  f.advance(1000); f.Loot.preparePet(); assert.equal(f.commands.length, 1);
  pet.commandMode = 0x147; assert.equal(f.Loot.preparePet(), true);
  assert.equal(f.Loot.begin(d), true); assert.equal(f.commands.at(-1).kind, 'cos-pickup');
});
test('pet keeps collecting while the bot is stopped, and the character does not', () => {
  const f = fixture(), pet = pickupPet(f, 0x147); f.drop(20, 3436);
  assert.equal(f.Hunt.running, false);
  f.advance(60000); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'cos-pickup', gid: 50, target: 20 });
  assert.equal(f.Loot.active.petGid, 50);
  const f2 = fixture(); pickupPet(f2, 0x1c7); f2.drop(20, 3436);
  f2.Controller.tick();
  assert.equal(f2.commands.length, 0, 'auto-grab is left alone while stopped');
  const f3 = fixture(); f3.Settings.profile.hunt.pickup.by = { elixirs: 'character' }; f3.Settings.profile.hunt.pickup.collector = 'character'; f3.Loot.preset('elixirs'); f3.drop(20, 3436);
  f3.Controller.tick();
  assert.equal(f3.commands.some(c => c.kind === 'pickup' || c.kind === 'cos-pickup'), false);
});
test('an Items rule to always pick an item works with its kind switched off, and leaves the other items of that kind alone', () => {
  const f = fixture(), P = f.Settings.profile.hunt.pickup;
  f.Loot.preset('elixirs'); P.potions = false;
  const vigor = f.drop(20, 6380); vigor.refObjId = 22; vigor.name = 'Vigor potion'; const trash = f.drop(21, 2284); trash.refObjId = 23; trash.name = 'Small potion';
  assert.equal(f.Loot.allowed(vigor), false, 'no rule yet'); assert.equal(f.Loot.allowed(trash), false);
  f.ItemRules.set([22], { pick: 'yes' });
  assert.equal(f.Loot.allowed(vigor), true, 'the rule picks it up'); assert.equal(f.Loot.allowed(trash), false, 'the rest stay on the ground');
  assert.equal(f.Loot.whyNot(vigor), ''); assert.equal(f.Loot.whyNot(trash), 'filter');
  assert.equal(f.Loot.choose().gid, 20);
});
test('the Items list can show only what is on the ground, so a rule lands on the exact item that drops', () => {
  const f = fixture(); f.Items.data.set(22, { name: 'Vigor Potion', code: 'ITEM_ETC_ALL_POTION_02' }); f.Items.data.set(23, { name: 'Other Potion', code: 'ITEM_ETC_ALL_POTION_03' });
  const drop = f.drop(20, 6380); drop.refObjId = 22;
  assert.deepEqual([...f.ItemRules.list({ nearby: true }).map(i => i.id)], [22]); assert.deepEqual([...f.ItemRules.list({}).map(i => i.id)], [22, 23]);
  f.Loot.preset('elixirs'); f.ItemRules.set([22], { pick: 'yes' });
  assert.equal(f.Loot.allowed(drop), true, 'one rule is enough with the kind switched off');
});
test('the pet and the character each collect their own kinds, one pickup at a time', () => {
  const f = fixture(), pet = pickupPet(f), P = f.Settings.profile.hunt.pickup;
  P.potions = true; P.by = { potions: 'character' };
  const elixir = f.drop(20, 3436), potion = f.drop(22, 2284), other = f.drop(23, 748); other.x = 300;
  assert.equal(f.Loot.collector(elixir), 'pet'); assert.equal(f.Loot.collector(potion), 'character');
  assert.equal(f.Loot.choose('pet').gid, 20); assert.equal(f.Loot.choose('character').gid, 22);
  assert.equal(f.Loot.allowed(potion), true, 'the character needs no pet for its own kinds');
  f.Hunt.start(); f.Hunt.tick();
  assert.equal(f.Loot.active.petGid, 50, 'the pet takes its drop first'); assert.equal(f.commands.at(-1).kind, 'cos-pickup');
  f.Hunt.tick(); assert.equal(f.Loot.active.gid, 20, 'still the pet: one pickup at a time');
  f.World.gp.cosRecords[0].inventory.push({ slot: 0, refObjId: 101, quantity: 1 }); f.World.ents.delete(20);
  f.advance(500); f.Hunt.tick(); f.advance(2000); f.Hunt.tick();
  assert.equal(f.Loot.active?.petGid, 0, 'then the character walks to its own drop'); assert.equal(f.Loot.active.gid, 22);
  assert.equal(f.commands.some(c => c.kind === 'pickup' && c.gid === 22), true);
});
test('character-only kinds keep working when the pet is missing, and pet kinds wait for it', () => {
  const f = fixture(), pet = pickupPet(f), P = f.Settings.profile.hunt.pickup;
  P.potions = true; P.by = { potions: 'character' };
  const elixir = f.drop(20, 3436), potion = f.drop(22, 2284);
  pet.dead = true;
  assert.equal(f.Loot.allowed(elixir), false); assert.equal(f.Loot.allowed(potion), true);
  assert.equal(f.Loot.choose().gid, 22); assert.equal(f.Loot.whyNot(elixir), 'pet');
  P.by = { elixirs: 'character' }; P.collector = 'character';
  assert.equal(f.Loot.petMode(), false, 'no pet duties when nothing is given to it');
  P.by = { elixirs: 'pet' }; assert.equal(f.Loot.petMode(), true, 'one kind given to the pet is enough');
  P.by = { elixirs: 'bogus' }; P.collector = 'character'; assert.equal(f.Loot.collectorFor('elixirs'), 'character', 'unknown values fall back');
});
test('the not-collected line says which kinds are not wanted', () => {
  const f = fixture(), pet = pickupPet(f, 7), P = f.Settings.profile.hunt.pickup; f.Hunt.running = true; f.Loot.preset('elixirs'); P.potions = false;
  f.drop(20, 2284); f.drop(21, 2284); const sword = f.drop(22, 748); P.exclude = 'sword'; sword.name = 'Iron Sword';
  const text = f.Diagnostics.pet();
  assert.match(text, /not wanted by your Loot settings \(2 potions #101, 1 excluded by name #101\)/);
});
test('pet collects only elixirs into its own inventory and confirms its gain', () => {
  const f = fixture(), pet = pickupPet(f), d = f.drop(20, 3436);
  f.drop(21, 5484); f.drop(22, 2284); f.drop(23, 748);
  assert.equal(f.Loot.choose().gid, d.gid); assert.equal(f.Loot.begin(d), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'cos-pickup', gid: 50, target: 20 });
  f.World.gp.inventory.push({ slot: 13, refObjId: 101, quantity: 5 });
  f.Loot.tick(); assert.equal(f.Stats.values.loot, 0);
  pet.inventory.push({ slot: 0, refObjId: 101, quantity: 1 });
  f.Loot.tick(); assert.equal(f.Stats.values.loot, 1); assert.equal(f.Loot.active, null);
  assert.equal(f.commands.some(c => c.kind === 'pickup'), false);
});
test('pet capacity is independent of the player bag and existing stacks merge', () => {
  const f = fixture(), pet = pickupPet(f), d = f.drop(20, 3436);
  f.World.gp.inventorySlotCount = 13; assert.equal(f.Loot.allowed(d), true);
  pet.status = 1; pet.inventory = [{ slot: 0, refObjId: 200, quantity: 1 }]; assert.equal(f.Loot.allowed(d), false);
  pet.inventory[0] = { slot: 0, refObjId: 101, quantity: 1, tooltip: { fields: { maxStack: 100 } } };
  assert.equal(f.Loot.allowed(d), true); pet.inventory[0].quantity = 100; assert.equal(f.Loot.allowed(d), false);
});
test('missing, foreign, dead or distant pet never falls back to character collection', () => {
  const f = fixture(), pet = pickupPet(f), d = f.drop(20, 3436);
  const ent = f.World.ents.get(50);
  ent.ownerGid = 2; assert.equal(f.Loot.begin(d), false);
  ent.ownerGid = 1; pet.dead = true; assert.equal(f.Loot.choose(), null);
  pet.dead = false; ent.x = 900; assert.equal(f.Loot.choose(), null);
  ent.x = 100; f.World.gp.cosRecords = []; assert.equal(f.Loot.begin(d), false);
  assert.equal(f.commands.length, 0);
});
test('pet pickup yields to busy inventory and a freshly sent potion', () => {
  const f = fixture(); pickupPet(f); const d = f.drop(20, 3436);
  f.World.gp.inventoryPending = true; assert.equal(f.Loot.begin(d), false);
  f.World.gp.inventoryPending = false; f.Potion.lastUse = 100000;
  assert.equal(f.Loot.begin(d), false); assert.equal(f.commands.length, 0);
});
test('pet collects promptly above potion thresholds instead of waiting in the ten-percent margin', () => {
  for (const [hp, mp] of [[65, 100], [100, 45]]) {
    const f = fixture(); petFight(f); f.drop(20, 3436);
    f.Settings.profile.hunt.pickup.afterKillOnly = false;
    f.World.gp.vitals = [{ gid: 1, hp, mp, maxHp: 100, maxMp: 100 }];
    let fights = 0; f.Combat.fight = () => { fights++; };
    f.Controller.tick();
    assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 1);
    assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
    assert.equal(fights, 1);
  }
});
test('pet retries are not starved by HP just above the potion threshold', () => {
  const f = fixture(); pickupPet(f); const d = f.drop(20, 3436); f.Hunt.start(); f.Loot.begin(d);
  f.advance(9000); f.Loot.tick();
  f.World.gp.vitals = [{ gid: 1, hp: 65, mp: 100, maxHp: 100, maxMp: 100 }];
  f.advance(800); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 2);
});
test('combat errors do not interrupt or suppress a pending pet pickup', () => {
  for (const error of ['Target is out of range', 'Insufficient MP', 'Not enough inventory space for item use']) {
    const f = fixture(); pickupPet(f); const d = f.drop(20, 3436); f.Hunt.start(); f.Loot.begin(d);
    f.bus.emit('game-error', error); f.Loot.tick();
    assert.ok(f.Loot.active); assert.equal(f.Loot.active.retryAt, 0);
    assert.equal(f.Loot.skips.has(d.gid), false);
  }
});
test('native busy and rejected pickup errors never permanently exclude an unchanged pet bag', () => {
  for (const error of ['Inventory command unavailable', 'Inventory rejected: 3']) {
    const f = fixture(); pickupPet(f); const d = f.drop(20, 3436); f.Hunt.start(); f.Loot.begin(d);
    f.Settings.profile.hunt.pickup.retries = 0;
    f.bus.emit('game-error', error); f.Loot.tick();
    assert.equal(f.Loot.active, null); assert.equal(f.Loot.choose(), null);
    f.advance(6000); assert.equal(f.Loot.choose()?.gid, d.gid);
  }
});
test('pet chooses the nearest eligible drop to itself inside the configured hunting range', () => {
  const f = fixture(); pickupPet(f); f.World.ents.get(50).x = 350;
  const nearPlayer = f.drop(20, 3436); nearPlayer.x = 110;
  const nearPet = f.drop(21, 3436); nearPet.x = 340;
  const outside = f.drop(22, 3436); outside.x = 410;
  assert.equal(f.Loot.choose()?.gid, nearPet.gid);
  nearPet.groundItem.ownerJid = 999; assert.equal(f.Loot.choose()?.gid, nearPlayer.gid);
});
test('pet yields to actual potion dispatch and pending inventory then collects without interrupting combat', () => {
  const f = fixture(); petFight(f); f.drop(20, 3436);
  f.World.gp.inventory.push({ slot: 16, refObjId: 8, typeFlags: 2284, quantity: 50 });
  f.World.gp.vitals = [{ gid: 1, hp: 55, mp: 100, maxHp: 100, maxMp: 100 }];
  let fights = 0; f.Combat.fight = () => { fights++; };
  f.Controller.tick(); assert.equal(f.commands.some(c => c.kind === 'item-use'), true);
  assert.equal(f.commands.some(c => c.kind === 'cos-pickup'), false);
  assert.match(f.Loot.petStatus(), /potion/);
  f.World.gp.inventoryPending = true; f.advance(400); f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'cos-pickup'), false);
  assert.match(f.Loot.petStatus(), /transaction/);
  f.World.gp.inventoryPending = false; f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 1);
  assert.match(f.Loot.petStatus(), /collecting/);
  assert.equal(fights, 3);
});
test('pet configuration retries are bounded and resummoning resets setup', () => {
  const f = fixture(), pet = pickupPet(f, 135);
  for (let i = 0; i < 8; i++) { f.Loot.preparePet(); f.advance(6000); }
  assert.equal(f.commands.length, 3); assert.match(f.Loot.petStatus(), /not disabled/);
  pet.commandMode = 7; assert.equal(f.Loot.preparePet(), true); assert.equal(f.Loot.petSetup, null);
});
test('pet retries retain pet recipient and stopping hands the drop to the idle pet, never the character', () => {
  const f = fixture(); pickupPet(f); const d = f.drop(20, 3436); f.Loot.begin(d);
  f.advance(9000); f.Loot.tick(); f.advance(800); f.Loot.tick();
  assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 2);
  assert.equal(f.commands.some(c => c.kind === 'pickup'), false);
  f.stopAll(); f.advance(1000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 3);
  assert.equal(f.commands.some(c => c.kind === 'pickup'), false);
});
test('hunt controller waits for pet settings, then collects with the pet only', () => {
  const f = fixture(), pet = pickupPet(f, 135); f.drop(20, 3436); f.Hunt.start();
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'cos-behavior');
  assert.equal(f.commands.some(c => c.kind === 'cos-pickup'), false);
  pet.commandMode = 7; f.advance(500); f.Controller.tick();
  assert.equal(f.Controller.mode, 'loot'); assert.equal(f.commands.at(-1).kind, 'cos-pickup');
  assert.equal(f.commands.some(c => c.kind === 'pickup'), false);
});
function navProduct(objects = [], blocked = new Uint8Array(9216)) {
  return { regionId: 1, complete: true, objects,
    navmesh: { regionSize: 1920, tileSize: 20, tilesPerAxis: 96,
      regions: [{ dx: 0, dz: 0, cells: { count: 1 }, blockedTiles: Buffer.from(blocked).toString('base64'), tileCellIds: Buffer.alloc(36864).toString('base64') }] } };
}
// The game publishes collision coverage for the 3x3 regions around the player.
function navWindow(regionId = 1, blocked = new Uint8Array(9216), objects = []) {
  const regions = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
    regions.push({ dx, dz, cells: { count: 1 }, blockedTiles: Buffer.from(blocked).toString('base64'), tileCellIds: Buffer.alloc(36864).toString('base64') });
  return { regionId, complete: true, objects,
    navmesh: { regionSize: 1920, tileSize: 20, tilesPerAxis: 96, regions } };
}
// Synthetic NVL1 route data, matching tools/convert-navdata.py.
function navBinary(nodes, edges, { originX = 0, originZ = 0, flags = 0 } = {}) {
  const count = nodes.length, adjacency = Array.from({ length: count }, () => new Set());
  for (const [a, b] of edges) if (a !== b) { adjacency[a].add(b); adjacency[b].add(a); }
  let arcs = 0; for (const row of adjacency) arcs += row.size;
  const buffer = Buffer.alloc(24 + count * 6 + (count + 1) * 4 + arcs * 2);
  buffer.write('NVL1', 0, 'ascii'); buffer[4] = 1; buffer[5] = flags; buffer.writeUInt16LE(0, 6);
  buffer.writeInt32LE(originX, 8); buffer.writeInt32LE(originZ, 12);
  buffer.writeUInt32LE(count, 16); buffer.writeUInt32LE(arcs, 20);
  nodes.forEach((node, i) => {
    const at = 24 + i * 6;
    buffer.writeInt16LE(Math.round((node.x - originX) / 10), at);
    buffer.writeInt16LE(Math.round((node.z - originZ) / 10), at + 2);
    buffer.writeInt16LE(node.y || 0, at + 4);
  });
  let arc = 0;
  const offsets = [];
  for (const row of adjacency) { offsets.push(arc); arc += row.size; }
  offsets.push(arc);
  const offsetsAt = 24 + count * 6;
  offsets.forEach((value, i) => buffer.writeUInt32LE(value, offsetsAt + i * 4));
  const arcsAt = offsetsAt + (count + 1) * 4;
  adjacency.forEach((row, i) => { let k = 0; for (const value of row) buffer.writeUInt16LE(value, arcsAt + (offsets[i] + k++) * 2); });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
function navArea(name, nodes, buffer, extra = {}) {
  const xs = nodes.map(n => n.x), zs = nodes.map(n => n.z);
  return { name, file: name + '.bin', minX: Math.min(...xs), maxX: Math.max(...xs),
    minZ: Math.min(...zs), maxZ: Math.max(...zs), nodes: nodes.length, cell: 19.2,
    dungeon: false, rev: name, ...extra };
}
function navPose(x, z, y = 0) {
  const rx = Math.floor(x / 1920), rz = Math.floor(z / 1920);
  return { regionId: (rz << 8) | rx, x: x - rx * 1920, y, z: z - rz * 1920 };
}
function navAbs(p) { return { x: (p.regionId & 255) * 1920 + p.x, z: (p.regionId >>> 8) * 1920 + p.z }; }
function navGrid(x0, z0, columns, rows, step = 200, omit = () => false) {
  const nodes = [], index = new Map();
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x = x0 + column * step, z = z0 + row * step;
    if (omit(x, z)) continue;
    index.set(column + ',' + row, nodes.length);
    nodes.push({ x, z, y: 0 });
  }
  const edges = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const here = index.get(column + ',' + row);
    if (here === undefined) continue;
    for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const next = index.get((column + dx) + ',' + (row + dz));
      if (next !== undefined) edges.push([here, next]);
    }
  }
  return { nodes, edges, index };
}
const asyncTests = [];
// An async test is awaited before the total is printed, so a failure inside it can never be lost.
function test(name, fn) {
  const result = fn();
  if (result && typeof result.then === 'function') { asyncTests.push(result.then(() => { passed++; console.log('PASS ' + name); }, error => { console.error('FAIL ' + name); throw error; })); return; }
  passed++; console.log('PASS ' + name);
}
// ---- Auto trade ----
// A simulated game: the merchants answer shop-open, purchases and sales change the transport's bag and the purse.
const TRADE_GOODS_OFFER = { refObjId: 5000, name: 'Silk', tab: 0, slot: 4, price: '100', maxStack: 50, purchaseLimit: 50, previews: [{ refObjId: 5000, typeFlags: 0x46c }] };
const TRADE_POTION_OFFER = { refObjId: 15, name: 'HP potion', tab: 0, slot: 1, price: '10', maxStack: 100, purchaseLimit: 100, previews: [{ refObjId: 15, typeFlags: 2284 }] };
function tradeFixture({ suit = true, vehicle = true, link = true, answer = true } = {}) {
  const f = fixture(), gp = f.World.gp, c = f.Trade.cfg();
  const from = f.Trade.town('CH'), to = f.Trade.town('WC');
  c.from = 'CH'; c.to = 'WC'; c.trips = 1;
  const merchants = [from, to].map((t, i) => {
    const s = t.services.trade, e = { gid: 300 + i, kind: 'npc', name: 'Trade merchant', refObjId: s.refObjId, regionId: s.regionId, x: s.x, y: s.y, z: s.z };
    f.World.ents.set(e.gid, e); return e;
  });
  const s0 = from.services.trade;
  gp.pose = { regionId: s0.regionId, x: s0.x + 30, y: s0.y, z: s0.z };
  f.World.pose = () => gp.pose;
  gp.inventory = suit ? [{ slot: 8, refObjId: 4000, typeFlags: 940 | (1 << 11), name: 'Trader suit' }] : [];
  const rec = { gid: 70, refObjId: 700, band: 2, hp: 100, status: 3, dead: false, inventory: [] };
  if (vehicle) gp.cosRecords = [rec];
  gp.progression.gold = '100000';
  const stats = { buys: [], sells: [], potions: [], follows: 0, bought: 0 };
  const sim = {
    f, gp, rec, stats, merchants,
    // One game step: let the bot act, then answer what it sent.
    step(ms = 600) {
      f.advance(ms);
      f.Trade.tick();
      const sent = f.commands.splice(0);
      for (const cmd of sent) {
        if (cmd.kind === 'select') gp.target = cmd.gid;
        else if (cmd.kind === 'shop-open') {
          gp.shopCompletionRevision++;
          const potion = f.World.ents.get(cmd.gid)?.refObjId !== merchants[0].refObjId && f.World.ents.get(cmd.gid)?.refObjId !== merchants[1].refObjId;
          gp.shop = potion ? { npc: cmd.gid, offers: [TRADE_POTION_OFFER] } : { npc: cmd.gid, cosGid: link ? 70 : 0, offers: [TRADE_GOODS_OFFER] };
        } else if (cmd.kind === 'npc-close') gp.shop = null;
        else if (cmd.kind === 'cos-follow') stats.follows++;
        else if (cmd.kind === 'shop-buy') {
          stats.potions.push(cmd.quantity);
          gp.progression.gold = String(BigInt(gp.progression.gold) - BigInt(cmd.quantity) * 10n);
          const row = gp.inventory.find(i => i.refObjId === 15); if (row) row.quantity += cmd.quantity;
        } else if (cmd.kind === 'cos-shop-buy') {
          stats.bought++;
          if (!answer) continue;
          stats.buys.push(cmd.quantity); gp.progression.gold = String(BigInt(gp.progression.gold) - BigInt(cmd.quantity) * 100n);
          rec.inventory.push({ slot: rec.inventory.length, refObjId: 5000, typeFlags: 0x46c, quantity: cmd.quantity, name: 'Silk' });
        } else if (cmd.kind === 'cos-shop-sell') {
          stats.sells.push(cmd.quantity); gp.progression.gold = String(BigInt(gp.progression.gold) + BigInt(cmd.quantity) * 150n);
          rec.inventory = rec.inventory.filter(i => i.slot !== cmd.slot);
        }
      }
      return sent;
    },
    run(max = 300) { for (let i = 0; i < max && f.Trade.run; i++) sim.step(); },
  };
  // Walking is the route graph's job and has its own tests: arrive at once.
  f.WalkBack.startTo = (dest, opts) => { gp.pose = { regionId: dest.regionId, x: dest.x + 30, y: dest.y, z: dest.z }; opts.onDone?.(); return true; };
  return sim;
}
test('every supported town has a trade merchant in the town table, and the trade settings load with defaults', () => {
  const f = fixture();
  assert.deepEqual([...f.Trade.towns().map(t => t.key)].sort(), ['CA', 'CH', 'EU', 'KT', 'WC']);
  for (const t of f.Trade.towns()) assert.ok(t.services.trade.refObjId > 0 && Number.isFinite(t.services.trade.x), t.key);
  assert.equal(f.Settings.profile.trade.from, 'CH'); assert.equal(f.Settings.profile.trade.trips, 1);
  const g = f.botProfile({ trade: { from: 'KT', to: 'EU', trips: 3, potions: false, extra: 1 } });
  assert.equal(g.trade.from, 'KT'); assert.equal(g.trade.trips, 3); assert.equal(g.trade.potions, false); assert.equal('extra' in g.trade, false);
});
test('auto pot keeps drinking while an auto trade runs, from the Controller loop', () => {
  const t = tradeFixture(), f = t.f;
  t.gp.inventory.push({ slot: 13, refObjId: 101, typeFlags: 2284, quantity: 10, name: 'HP potion' });
  f.World.me = () => ({ maxHp: 100, maxMp: 100, hpPct: 20, mpPct: 100, abnormal: 0 });
  f.Settings.profile.potion.enabled = true; f.Settings.profile.potion.hp.on = true; f.Settings.profile.potion.hp.pct = 50;
  f.Trade.start(); assert.ok(f.Trade.run, f.Trade.message);
  f.advance(2000); f.Controller.tick();
  assert.equal(f.Controller.mode, 'trading');
  assert.ok(f.commands.some(c => c.kind === 'item-use' || c.kind === 'use-item' || /item/.test(c.kind)), 'an HP potion was used: ' + JSON.stringify(f.commands.map(c => c.kind)));
});
test('auto trade buys goods into the transport, delivers them to the other town and sells them all', () => {
  const t = tradeFixture(), f = t.f;
  f.Trade.start(); assert.ok(f.Trade.run, f.Trade.message);
  t.run();
  assert.equal(f.Trade.run, null, f.Trade.message);
  assert.deepEqual([...t.stats.buys], [50, 50, 50], 'one full stack per transport slot');
  assert.deepEqual([...t.stats.sells], [50, 50, 50]);
  assert.equal(t.rec.inventory.length, 0);
  assert.equal(t.stats.follows, 1, 'the transport is told to follow once');
  assert.equal(t.gp.progression.gold, String(100000 + 3 * 50 * 50), 'bought at 100, sold at 150');
  assert.match(f.Trade.message, /finished: 1 delivery/);
  assert.equal(f.Trade.tick(), false, 'idle once finished');
});
test('auto trade with more deliveries buys the second town\'s goods and carries them back', () => {
  const t = tradeFixture(), f = t.f; f.Trade.cfg().trips = 2;
  f.Trade.start(); t.run();
  assert.equal(f.Trade.run, null, f.Trade.message);
  assert.equal(t.stats.buys.length, 6, 'a load in each direction'); assert.equal(t.stats.sells.length, 6);
  assert.match(f.Trade.message, /finished: 2 deliveries/);
});
test('auto trade never starts without the job suit, the towns or a free hand, and summons a missing transport', () => {
  let t = tradeFixture({ suit: false }); t.f.Trade.start(); t.run(5);
  assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /trader job suit/); assert.equal(t.stats.bought, 0);
  t = tradeFixture({ vehicle: false }); t.f.Trade.start(); t.run(5);
  assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /no transport/);
  t = tradeFixture({ vehicle: false }); t.gp.inventory.push({ slot: 14, refObjId: 4100, typeFlags: 4588, codename: 'ITEM_COS_C_HORSE1', name: 'Horse summon' });
  t.f.Trade.start(); const sent = t.step(); assert.ok(t.f.Trade.run, t.f.Trade.message);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ kind: 'item-use', slot: 14 }], 'the scroll is used');
  t.gp.cosRecords = [t.rec]; t.run(); assert.equal(t.f.Trade.run, null, t.f.Trade.message); assert.equal(t.stats.sells.length, 3);
  t = tradeFixture(); t.f.Trade.cfg().to = 'CH'; t.f.Trade.start(); assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /two different towns/);
  t = tradeFixture(); t.f.Hunt.running = true; t.f.Trade.start(); assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /Stop hunting/);
  t = tradeFixture(); t.f.Trade.start(); t.f.Hunt.start(); assert.equal(t.f.Hunt.running, false, 'hunting is refused while trading');
});
test('auto trade stops when the merchant is not linked to the transport, and never repeats an unconfirmed purchase', () => {
  let t = tradeFixture({ link: false }); t.f.Trade.start(); t.run(40);
  assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /not linked to your transport/); assert.equal(t.stats.bought, 0);
  t = tradeFixture({ answer: false }); t.f.Trade.start(); t.run(60);
  assert.equal(t.stats.bought, 1, 'one purchase, never resent'); assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /Goods purchase was not confirmed/);
});
test('auto trade stops on death, manual control and the Stop button, and closes an open merchant', () => {
  let t = tradeFixture(); t.f.Trade.start(); t.step(); t.f.World.isDead = () => true; t.step();
  assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /died/);
  t = tradeFixture(); t.f.Trade.start(); t.step(); t.f.Manual.lastAt = 999999; t.step();
  assert.equal(t.f.Trade.run, null); assert.match(t.f.Trade.message, /manual control/);
  t = tradeFixture(); t.f.Trade.start(); for (let i = 0; i < 6; i++) t.step(); assert.ok(t.gp.shop, 'the merchant is open');
  t.f.Trade.cancel(); assert.equal(t.f.Trade.run, null); assert.ok(t.f.commands.some(c => c.kind === 'npc-close'));
});
test('auto trade takes the Controller turn and reports Trading', () => {
  const t = tradeFixture(), f = t.f; f.Trade.start();
  f.advance(600); f.Controller.tick(); assert.equal(f.Controller.mode, 'trading');
  f.Trade.cancel(); f.advance(600); f.Controller.tick(); assert.notEqual(f.Controller.mode, 'trading');
});
test('auto trade refills potions at the town potion merchant before buying goods', () => {
  const t = tradeFixture(), f = t.f, v = f.Trade.town('CH').services.vendor;
  f.World.ents.set(400, { gid: 400, kind: 'npc', name: 'Potion merchant', refObjId: v.refObjId, regionId: v.regionId, x: v.x, y: v.y, z: v.z });
  const r = f.Restock.cfg(); r.hp.on = true; r.hp.refObjId = 15; r.hp.low = 5; r.hp.target = 100; r.mp.on = false;
  t.gp.inventory.push({ slot: 13, refObjId: 15, typeFlags: 2284, quantity: 10 });
  f.Trade.start(); t.run();
  assert.equal(f.Trade.run, null, f.Trade.message);
  assert.deepEqual([...t.stats.potions], [90], 'topped up from 10 to the 100 target, once, before the goods');
  assert.equal(t.stats.buys.length, 3);
});
test('WalkBack.startTo walks to any point, reports arrival inside the wider radius and failures to the caller', () => {
  const f = fixture(); let done = 0, failed = '';
  const dest = { regionId: 1, x: 1000, y: 0, z: 100 };
  assert.equal(f.WalkBack.startTo(dest, { label: 'the trade merchant', stop: 120, onDone: () => done++, onFail: r => { failed = r; } }), true);
  assert.match(f.WalkBack.status(), /Walking to the trade merchant/);
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'move');
  f.World.gp.pose.x = 850; f.advance(1000); f.WalkBack.tick();
  assert.equal(done, 0, 'still outside the 120 radius');
  f.World.gp.pose.x = 890; f.advance(1000); f.WalkBack.tick();
  assert.equal(done, 1); assert.equal(f.WalkBack.active, null); assert.equal(f.Hunt.running, false, 'arrival never starts hunting');
  f.WalkBack.startTo(dest, { label: 'x', onFail: r => { failed = r; } }); f.Manual.lastAt = 123456; f.WalkBack.tick();
  assert.match(failed, /Manual control/); assert.equal(f.WalkBack.active, null);
  assert.equal(f.WalkBack.startTo({ regionId: 1, x: 1, y: 0, z: 1 }, { onFail: r => { failed = r; } }) !== undefined, true);
});
function mapFixture() {
  const f = fixture(), map = f.LeanMap;
  const input = () => ({ _value: '', get value() { return this._value; }, set value(v) { this._value = String(v); },
    focus() { this.focused = true; }, select() { this.selected = true; } });
  map.spotX = input(); map.spotY = input(); map.coordinateText = input();
  f.World.gp.pose = { regionId: (92 << 8) | 135, x: 125, y: 37, z: 459 };
  return f;
}
test('Map groups coordinate fields and actions in compact rows', () => {
  const nodes = [];
  const document = { createElement(tag) {
    const events = {}, node = { tag, children: [], className: '', value: '', dataset: {},
      classList: { add() {} }, setAttribute() {}, append(...children) { this.children.push(...children); },
      addEventListener(name, fn) { events[name] = fn; }, click() { events.click?.(); }, querySelectorAll() { return []; } };
    nodes.push(node); return node;
  } };
  const f = fixture(document), map = f.LeanMap;
  map.bind = () => {}; map.render = () => {};
  const parent = document.createElement('div');
  map.draw(parent);
  const find = name => nodes.find(n => n.className === name);
  assert.equal(find('map-spot-header').children[0].textContent, 'Set actual position');
  assert.equal(find('map-spot-fields').children.length, 3);
  assert.equal(find('map-spot-fields').children[0].children[1], map.spotX);
  assert.equal(find('map-spot-fields').children[1].children[1], map.spotY);
  assert.equal(find('map-spot-fields').children[2].textContent, 'Set spot');
  assert.deepEqual(find('map-current-position').children.slice(1).map(n => n.textContent), ['Get position', 'Copy']);
  assert.equal(map.coordinateText.readOnly, true);
  map.spotX.value = '0'; map.spotY.value = '0';
  find('map-spot-fields').children[2].click();
  assert.equal(f.Settings.profile.hunt.center.regionId, (92 << 8) | 135);
  let reads = 0, copies = 0;
  map.getCoordinates = () => { reads++; }; map.copyCoordinates = () => { copies++; };
  find('map-current-position').children[1].click(); find('map-current-position').children[2].click();
  assert.equal(reads, 1); assert.equal(copies, 1);
});
test('map coordinates save the displayed X/Y in the correct region and character profile', () => {
  const f = mapFixture(), map = f.LeanMap; let centers = 0;
  f.Settings.useCharacter('MapTester'); f.bus.on('center', () => centers++);
  map.spotX.value = '-193'; map.spotY.value = '192';
  assert.equal(map.setCoordinates(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.Settings.profile.hunt.center)), { regionId: (93 << 8) | 133, x: 1910, y: 37, z: 0 });
  assert.equal(centers, 1); assert.equal(map.picked, null); assert.equal(map.dirty, true);
  f.timers.filter(t => t.ms === 250).forEach(t => t.fn());
  const saved = JSON.parse(f.storage.get('sroBotLean:v1:profile:MapTester'));
  assert.equal(saved.hunt.center.x, 1910); assert.equal(saved.hunt.center.regionId, (93 << 8) | 133);
  assert.equal(f.commands.length, 0, 'saving a spot sends no movement or combat command');
});
test('map coordinates reject empty, fractional, non-finite and out-of-world input without changing a mark or spot', () => {
  const f = mapFixture(), map = f.LeanMap, center = f.Settings.profile.hunt.center;
  const mark = map.picked = { regionId: 1, x: 20, z: 30 };
  let saves = 0; f.Settings.saveProfile = () => saves++;
  for (const [x, y] of [['', '1'], ['1', '  '], ['abc', '2'], ['Infinity', '0'], ['1.5', '0'], ['0', 'NaN'],
    ['-25921', '0'], ['23232', '0'], ['0', '-17665'], ['0', '6912']]) {
    map.spotX.value = x; map.spotY.value = y;
    assert.equal(map.setCoordinates(), false, `${x}, ${y}`);
    assert.equal(f.Settings.profile.hunt.center, center); assert.equal(map.picked, mark);
  }
  assert.equal(saves, 0); assert.equal(f.commands.length, 0);
});
test('map coordinates accept zero and outdoor bounds across sector boundaries', () => {
  for (const [x, y, regionId, localX, localZ] of [[0, 0, (92 << 8) | 135, 0, 0],
    [-25920, -17664, 0, 0, 0], [23231, 6911, (127 << 8) | 255, 1910, 1910]]) {
    const f = mapFixture(), map = f.LeanMap;
    map.spotX.value = x; map.spotY.value = y;
    assert.equal(map.setCoordinates(), true);
    assert.deepEqual(JSON.parse(JSON.stringify(f.Settings.profile.hunt.center)), { regionId, x: localX, y: 37, z: localZ });
    f.World.gp.pose = f.Settings.profile.hunt.center;
    assert.equal(map.getCoordinates(), `X ${x}, Y ${y}`);
  }
});
test('current map coordinates fill the fields without changing the hunting spot', async () => {
  const f = mapFixture(), map = f.LeanMap, center = f.Settings.profile.hunt.center;
  let copied = '';
  f.win.navigator = { clipboard: { writeText: async text => { copied = text; } } };
  assert.equal(map.getCoordinates(), 'X 12, Y 45');
  assert.equal(map.spotX.value, '12'); assert.equal(map.spotY.value, '45'); assert.equal(copied, '');
  f.World.gp.pose.x = 200;
  await map.copyCoordinates();
  assert.equal(copied, 'X 20, Y 45', 'copy fetches a fresh position');
  assert.equal(map.coordinateText.value, copied); assert.match(f.notices.at(-1), /copied/);
  assert.equal(f.Settings.profile.hunt.center, center); assert.equal(f.commands.length, 0);
});
test('map copy offers selected coordinates when the clipboard API is missing or refused', async () => {
  for (const navigator of [undefined, { clipboard: { writeText: async () => { throw Error('denied'); } } }]) {
    const f = mapFixture(); f.win.navigator = navigator;
    await f.LeanMap.copyCoordinates();
    assert.equal(f.LeanMap.coordinateText.value, 'X 12, Y 45');
    assert.equal(f.LeanMap.coordinateText.focused, true); assert.equal(f.LeanMap.coordinateText.selected, true);
    assert.match(f.notices.at(-1), /Clipboard unavailable/);
  }
});
test('map coordinate actions refuse disconnected, missing, partial and dungeon positions', async () => {
  for (const state of ['disconnected', 'missing', 'partial', 'dungeon']) {
    const f = mapFixture(), map = f.LeanMap, center = f.Settings.profile.hunt.center;
    map.spotX.value = '1'; map.spotY.value = '2';
    if (state === 'disconnected') f.World.phase = 'disconnected';
    if (state === 'missing') f.World.gp = null;
    if (state === 'partial') delete f.World.gp.pose.z;
    if (state === 'dungeon') f.World.gp.pose.regionId = 0x8001;
    let copies = 0; f.win.navigator = { clipboard: { writeText: async () => { copies++; } } };
    assert.equal(map.getCoordinates(), null); await map.copyCoordinates();
    assert.equal(map.setCoordinates(), false);
    assert.equal(copies, 0); assert.equal(f.Settings.profile.hunt.center, center);
    assert.equal(map.spotX.value, '1'); assert.equal(map.spotY.value, '2'); assert.equal(f.commands.length, 0);
  }
});
test('filters foreign ownership and permits own/party claims', () => {
  const f = fixture(), d = f.drop(); d.groundItem.ownerJid = 2;
  assert.equal(f.Loot.choose(), null);
  f.World.gp.social.members = [{ id: 2 }]; assert.equal(f.Loot.choose().gid, d.gid);
  d.groundItem.claimantGid = 3; assert.equal(f.Loot.choose(), null);
  d.groundItem.claimantGid = 1; assert.equal(f.Loot.choose().gid, d.gid);
});
test('include cannot bypass exclusion or capacity; existing stack can merge', () => {
  const f = fixture(), d = f.drop(), p = f.Settings.profile.hunt.pickup;
  p.include = 'potion'; p.exclude = 'potion'; assert.equal(f.Loot.allowed(d), false);
  p.exclude = ''; f.World.gp.inventorySlotCount = 13; assert.equal(f.Loot.allowed(d), false);
  f.World.gp.inventory = [{ slot: 13, refObjId: 101, quantity: 10, tooltip: { fields: { maxStack: 100 } } }];
  assert.equal(f.Loot.allowed(d), true);
  f.World.gp.inventory[0].quantity = 100; assert.equal(f.Loot.allowed(d), false);
});
test('approach survives more than 4.5 seconds while making progress', () => {
  const f = fixture(), d = f.drop(); assert.equal(f.Loot.begin(d), true);
  for (let n = 0; n < 3; n++) { f.advance(5000); f.World.gp.pose.x += 20; assert.equal(f.Loot.tick(), true); assert.ok(f.Loot.active); }
  assert.equal(f.commands.filter(c => c.kind === 'pickup').length, 1);
});
test('inventory gain confirms exactly one pickup before despawn', () => {
  const f = fixture(), d = f.drop(); f.Loot.begin(d);
  f.World.gp.inventory = [{ slot: 13, refObjId: 101, quantity: 1 }]; f.Loot.tick();
  assert.equal(f.Stats.values.loot, 1); assert.equal(f.Loot.active, null); assert.equal(f.Loot.choose(), null);
  f.Loot.tick(); assert.equal(f.Stats.values.loot, 1);
});
test('despawn alone never counts as success; delayed gain still confirms', () => {
  const f = fixture(), d = f.drop(); f.Loot.begin(d); f.World.ents.delete(d.gid); f.Loot.tick();
  f.advance(1600); f.Loot.tick(); assert.equal(f.Stats.values.loot, 0); assert.equal(f.Loot.active, null);
  const g = fixture(), other = g.drop(); g.Loot.begin(other); g.World.ents.delete(other.gid); g.Loot.tick();
  g.advance(700); g.World.gp.inventory = [{ slot: 13, refObjId: 101, quantity: 2 }]; g.Loot.tick(); assert.equal(g.Stats.values.loot, 1);
});
test('gold gain confirms pickup', () => {
  const f = fixture(), d = f.drop(20, 748); f.Loot.begin(d); f.World.gp.progression.gold = '100050'; f.Loot.tick(); assert.equal(f.Stats.values.loot, 1);
});
test('bounded retries cancel worker intent then back off', () => {
  const f = fixture(), d = f.drop(); f.Settings.profile.hunt.pickup.retries = 1; f.Loot.begin(d);
  f.advance(9000); f.Loot.tick(); assert.equal(f.commands.at(-1).kind, 'move');
  f.advance(800); f.Loot.tick(); assert.equal(f.commands.filter(c => c.kind === 'pickup').length, 2);
  f.advance(9000); f.Loot.tick(); assert.equal(f.Loot.active, null); assert.equal(f.Loot.choose(), null);
  f.advance(6000); assert.equal(f.Loot.choose().gid, d.gid);
});
test('capacity failures suppress a drop until inventory changes', () => {
  const f = fixture(), d = f.drop(); f.Loot.begin(d); f.bus.emit('game-error', 'Inventory full'); f.Loot.tick();
  f.advance(120000); assert.equal(f.Loot.choose(), null);
  f.World.gp.inventory.push({ slot: 13, refObjId: 201, quantity: 1 }); assert.equal(f.Loot.choose().gid, d.gid);
});
test('drains nearby loot before acquiring a fresh monster', () => {
  const f = fixture(); f.Hunt.start(); f.drop();
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] });
  f.Hunt.tick(); assert.equal(f.commands.at(-1).kind, 'pickup'); assert.equal(f.Hunt.state, 'loot');
});
test('finish-fight setting has effect and attackers interrupt pickups', () => {
  const f = fixture(); f.Hunt.start(); f.drop();
  const mob = { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] };
  f.World.ents.set(30, mob); f.Hunt.targetGid = 30; f.Hunt.targetSince = 100000;
  f.Hunt.tick(); assert.equal(f.commands.at(-1).kind, 'select');
  f.Settings.profile.hunt.pickup.afterKillOnly = false; f.advance(500); f.Hunt.tick(); assert.equal(f.commands.at(-1).kind, 'pickup');
  f.World.attackers.set(30, 100500); f.advance(500); f.Hunt.tick(); assert.equal(f.Loot.active, null); assert.equal(f.commands.at(-1).kind, 'select');
});
// Small ones first: fighting a giant (rarity 4) while weaker monsters hit you.
function giantFight({ giantHp = 100 } = {}) {
  const f = fixture(); f.Hunt.start();
  const mob = (gid, rarity, x, name) => { const e = { gid, kind: 'monster', name, rarity, regionId: 1, x, y: 0, z: 100, attackFlags: 16, appearanceState: [0] }; f.World.ents.set(gid, e); return e; };
  mob(40, 4, 140, 'Giant'); f.World.gp.vitals = [{ gid: 40, hp: giantHp, maxHp: 100 }];
  f.Hunt.targetGid = 40; f.Hunt.targetSince = 100000; f.World.gp.target = 40;
  f.World.attackers.set(40, 100000);
  const hit = gid => f.World.attackers.set(gid, f.World.simNow());
  const selected = () => f.commands.filter(c => c.kind === 'select').map(c => c.gid);
  return { f, mob, hit, selected };
}
test('a weaker monster hitting you is killed before the giant, then the bot goes back to the giant', () => {
  const { f, mob, hit, selected } = giantFight();
  mob(41, 0, 125, 'Small'); hit(41);
  f.Hunt.tick(); assert.deepEqual(selected(), [41], 'switched to the small one');
  assert.equal(f.Hunt.targetGid, 41);
  assert.match(f.Diagnostics.main(), /switched to Small \(hitting you\); back to Giant after/);
  assert.ok(f.Log.lines.some(l => /Switched from Giant to Small/.test(l.text)));
  f.World.gp.target = 41; f.advance(500); hit(40); f.Hunt.tick();
  assert.deepEqual(selected(), [41], 'no flip-flop while the giant keeps hitting');
  f.World.ents.delete(41); f.advance(500); f.Hunt.tick();
  assert.deepEqual(selected(), [41, 40], 'small one dead: back to the giant');
});
test('the small-ones-first switch keeps the giant when it is nearly dead, equal or busy casting', () => {
  let s = giantFight({ giantHp: 20 }); s.mob(41, 0, 125, 'Small'); s.hit(41);
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'giant at 20%: finish it');
  s = giantFight(); s.mob(42, 4, 125, 'Second giant'); s.hit(42);
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'another giant is no reason to switch');
  s = giantFight(); s.mob(41, 0, 125, 'Small'); s.hit(41); s.f.World.isCasting = () => true;
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'never in the middle of a cast');
  s = giantFight(); s.mob(41, 0, 125, 'Small'); s.f.World.ents.set(99, { gid: 99, kind: 'player', name: 'Mate', regionId: 1, x: 130, z: 100 });
  s.f.World.onCast({ caster: 41, target: 99, results: [{ target: 99 }] });
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'a monster hitting a party member does not count');
  s = giantFight(); s.mob(41, 0, 125, 'Small'); s.hit(41); s.f.advance(7000); s.f.World.attackers.set(40, s.f.World.simNow());
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'it stopped hitting you a while ago');
  s = giantFight(); s.mob(41, 0, 900, 'Small'); s.hit(41);
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [], 'outside chase distance');
});
test('the weakest attacker goes first, also when no target is held', () => {
  let s = giantFight(); s.mob(41, 1, 125, 'Champion'); s.mob(43, 0, 135, 'Normal'); s.hit(41); s.hit(43);
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [43], 'the normal before the champion');
  s = giantFight(); s.mob(41, 0, 125, 'Healthy'); s.mob(43, 0, 135, 'Hurt'); s.hit(41); s.hit(43);
  s.f.World.gp.vitals.push({ gid: 41, hp: 80, maxHp: 100 }, { gid: 43, hp: 30, maxHp: 100 });
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [43], 'of two normals, the one closest to dead');
  s = giantFight(); s.f.Hunt.targetGid = 0; s.f.World.gp.target = 0; s.mob(41, 0, 160, 'Small'); s.hit(41);
  s.f.Hunt.tick(); assert.deepEqual(s.selected(), [41], 'with no target, the small attacker before the nearer giant');
});
test('item rules decide pickup before the loot categories', () => {
  const f = fixture(); f.Hunt.start(); const d = f.drop(), P = f.Settings.profile.hunt.pickup;
  assert.equal(f.Loot.allowed(d), true, 'potions are collected by default');
  f.ItemRules.set([101], { pick: 'no' }); assert.equal(f.Loot.allowed(d), false); assert.equal(f.Loot.whyNot(d), 'rule');
  P.potions = false; f.ItemRules.set([101], { pick: 'yes' }); assert.equal(f.Loot.allowed(d), true, 'always: even with Potions off');
  P.exclude = 'hp potion'; assert.equal(f.Loot.allowed(d), true, 'and past the exclude names');
  f.ItemRules.set([101], { act: 'drop' }); assert.equal(f.Loot.allowed(d), false, 'a dropped item is never picked up again');
  assert.deepEqual(JSON.parse(JSON.stringify(f.ItemRules.get(101))), { act: 'drop' }, 'drop clears the pick part');
  f.ItemRules.set([101], { act: null }); assert.equal(f.ItemRules.get(101), null, 'an empty rule is removed');
});
test('item rules decide what the town trip stores and sells', () => {
  const f = townFixture(), elixir = f.pet.inventory[0], other = f.pet.inventory[4], potion = f.World.gp.inventory.find(i => i.refObjId === 15);
  assert.deepEqual([f.Town.eligible(other), f.Town.sellable(other)], [false, true], 'without a rule other loot is sold');
  f.ItemRules.set([other.refObjId], { act: 'store' }); assert.deepEqual([f.Town.eligible(other), f.Town.sellable(other)], [true, false], 'store rule');
  assert.deepEqual([f.Town.eligible(elixir), f.Town.sellable(elixir)], [true, false], 'elixirs are stored by default');
  f.ItemRules.set([elixir.refObjId], { act: 'sell' }); assert.deepEqual([f.Town.eligible(elixir), f.Town.sellable(elixir)], [false, true], 'sell rule');
  f.ItemRules.set([elixir.refObjId], { act: 'keep' }); assert.deepEqual([f.Town.eligible(elixir), f.Town.sellable(elixir)], [false, false], 'keep rule');
  f.ItemRules.set([15], { act: 'store' }); assert.equal(f.Town.depositItem(potion, true), false, 'potions the trip needs stay in the bag');
  f.World.gp.inventory.push({ slot: 20, refObjId: 1003, typeFlags: 108, quantity: 1, name: 'Other item' });
  assert.equal(f.Town.depositItem(f.World.gp.inventory.at(-1), true), true, 'other bag items with a store rule are deposited');
});
test('chosen primary and secondary gear is protected and balance moves rule items between bag and pet', () => {
  const f = townFixture(), gp = f.World.gp, pet = f.pet;
  const spare = { slot: 20, refObjId: 1003, typeFlags: 108, quantity: 1 };
  gp.inventory.push(spare);
  const key = f.BuffGear.key(spare);
  f.ItemRules.set([1003], { act: 'sell' });
  assert.equal(f.Town.sellableBag(spare), true, 'a Sell rule sells it');
  f.ItemRules.setGear('secondaryWeapon', key);
  assert.deepEqual([f.Town.sellableBag(spare), f.Town.sellable(spare), f.Town.depositItem(spare, true)], [false, false, false], 'chosen gear is never sold or stored');
  f.ItemRules.set([1003], { act: 'drop' }); f.ItemRules.dropTick();
  assert.equal(f.commands.some(c => c.kind === 'item-drop' && c.slot === 20), false, 'nor dropped');
  f.ItemRules.set([1003], { act: 'store' }); f.ItemRules.setGear('secondaryWeapon', null);
  // balance: off by default, then moves a rule item toward the side with more room
  pet.status = pet.inventory.length + 10; const n = f.commands.length;
  f.ItemRules.balanceTick(); assert.equal(f.commands.length, n, 'off by default');
  f.ItemRules.cfg().balance = true; f.ItemRules.setGear('secondaryWeapon', key); f.ItemRules.balanceTick();
  assert.equal(f.commands.slice(n).some(c => c.kind === 'cos-transfer'), false, 'chosen gear does not move');
  f.ItemRules.setGear('secondaryWeapon', null);
  const free = f.World.freeBagSlots();
  for (let s = 21; s < gp.inventorySlotCount && f.World.freeBagSlots() > 0; s++) gp.inventory.push({ slot: s, refObjId: 2000 + s, typeFlags: 108, quantity: 1 });
  f.ItemRules.balanceTick();
  const cmd = f.commands.at(-1);
  assert.equal(cmd.kind, 'cos-transfer'); assert.equal(cmd.toCos, true); assert.equal(cmd.source, 20, 'the rule item goes to the roomier pet');
  assert.ok(free >= 0);
});
test('the chosen weapons and shield stay listed when worn, carried elsewhere or changed by alchemy', () => {
  const f = townFixture(), gp = f.World.gp, worn = gp.inventory[0];
  f.Items.name = id => 'Item ' + id;
  const spare = { slot: 20, refObjId: 901, typeFlags: 44 | (6 << 7), plus: 2, quantity: 1 }, copy = { ...spare, slot: 21 };
  gp.inventory.push(spare, copy, { slot: 22, refObjId: 950, typeFlags: 12 | (4 << 7), quantity: 1 });
  const rows = slot => Array.from(f.ItemRules.gearOptions(slot), ([, text]) => text);
  assert.deepEqual(rows('primaryWeapon'), ['None', 'Item 900 (worn)', 'Item 901 +2 (bag 8)'], 'worn gear is listed, identical copies once');
  assert.deepEqual(rows('shield'), ['None', 'Item 950 (bag 10)'], 'shields only');
  const key = f.BuffGear.key(spare);
  f.ItemRules.setGear('secondaryWeapon', key); f.ItemRules.trackGear();
  spare.slot = 6; worn.slot = 20; f.ItemRules.trackGear();
  assert.equal(f.ItemRules.cfg().gear.secondaryWeapon, key, 'wearing it keeps the choice');
  assert.deepEqual(rows('secondaryWeapon'), ['None', 'Item 901 +2 (worn)', 'Item 900 (bag 8)']);
  gp.inventory = gp.inventory.filter(i => i !== copy); spare.plus = 3; f.ItemRules.trackGear();
  assert.equal(f.ItemRules.cfg().gear.secondaryWeapon, f.BuffGear.key(spare), 'a new plus in the same slot keeps the choice');
  assert.equal(f.ItemRules.guarded(spare), true, 'and its protection');
  assert.ok(f.Log.lines.some(l => /Item 901 \+2 is now Item 901 \+3/.test(l.text)));
  gp.inventory = gp.inventory.filter(i => i !== spare); f.ItemRules.trackGear();
  assert.equal(rows('secondaryWeapon').at(-1), 'Item 901 +3 (not in your bag)', 'an item that is not carried stays chosen');
  gp.inventory.push({ slot: 6, refObjId: 902, typeFlags: 44 | (6 << 7), quantity: 1 }); f.ItemRules.trackGear();
  assert.equal(f.ItemRules.cfg().gear.secondaryWeapon, f.BuffGear.key(spare), 'another item in that slot does not take the choice');
  gp.inventory = gp.inventory.filter(i => i.slot !== 6); f.ItemRules.trackGear();
  gp.inventory.push({ ...spare, slot: 6, plus: 0 }); f.ItemRules.trackGear();
  assert.equal(f.ItemRules.cfg().gear.secondaryWeapon, f.BuffGear.key(spare), 'a drop landing in the emptied slot is not adopted');
  f.BuffGear.bad.add(f.BuffGear.key(spare)); f.ItemRules.setGear('secondaryWeapon', f.BuffGear.key(spare));
  assert.equal(f.BuffGear.bad.has(f.BuffGear.key(spare)), false, 'picking it again clears a refusal');
});
test('the stall never offers the weapons and shield chosen under Combat', () => {
  const f = stallFixture(); stallBag(f);
  const sword = { slot: 15, refObjId: 64, typeFlags: 44 | (6 << 7), quantity: 1, tooltip: { fields: { canSell: 1 } } };
  f.World.gp.inventory.push(sword);
  f.Settings.profile.stall.prices = { 62: 150, 64: 9000 };
  assert.deepEqual(Array.from(f.Stall.candidates(), i => i.slot), [13, 15]);
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(sword));
  assert.deepEqual(Array.from(f.Stall.candidates(), i => i.slot), [13], 'a price does not sell the chosen weapon');
});
test('item rules drop from the bag and the pet, one at a time, never worn gear', () => {
  const f = townFixture(), gp = f.World.gp;
  gp.inventory.push({ slot: 20, refObjId: 1003, typeFlags: 108, quantity: 1 });
  f.ItemRules.set([1003, 900], { act: 'drop' });
  f.ItemRules.dropTick(); assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'item-drop', slot: 20 }, 'the bag item; the worn weapon (slot 6) stays');
  const sent = f.commands.length; f.advance(1000); f.ItemRules.dropTick(); assert.equal(f.commands.length, sent, 'waits to see it leave the bag');
  gp.inventory = gp.inventory.filter(i => i.slot !== 20); f.advance(300); f.ItemRules.dropTick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'cos-drop', gid: f.pet.gid, slot: 4 }, 'then the pet item');
  assert.ok(f.Log.lines.some(l => /Dropped .* \(item rule\)/.test(l.text)));
  const n = f.commands.length; f.advance(6000); f.ItemRules.dropTick(); assert.equal(f.commands.length, n, 'not confirmed: backs off');
  assert.match(f.ItemRules.message, /not dropped; trying again in 30 s/);
  f.advance(31000); f.ItemRules.dropTick(); assert.equal(f.commands.at(-1).kind, 'cos-drop', 'and tries again later');
  f.pet.inventory = f.pet.inventory.filter(i => i.slot !== 4); f.Town.begin(); const m = f.commands.length;
  gp.inventory.push({ slot: 21, refObjId: 1003, typeFlags: 108, quantity: 1 }); f.advance(6000); f.ItemRules.dropTick();
  assert.equal(f.commands.slice(m).some(c => c.kind === 'item-drop'), false, 'never during town service');
  f.Town.cancel(); f.Hunt.stop(); f.ItemRules.dropTick(); assert.equal(f.commands.slice(m).some(c => c.kind === 'item-drop'), false, 'nor while stopped');
});
test('item codenames give race, gender, degree, type and the filters', () => {
  const f = fixture();
  for (const [id, code, name] of [[97, 'ITEM_CH_SWORD_09_C', 'Sword 9'], [4040, 'ITEM_CH_SWORD_09_C_RARE', 'Sword 9 (Sun)'], [500, 'ITEM_EU_W_LIGHT_05_SA_A', 'Light shoulder'],
    [501, 'ITEM_EU_TSTAFF_03_A', 'Staff'], [502, 'ITEM_CH_RING_01_A', 'Ring'], [8, 'ITEM_ETC_HP_POTION_04', 'HP potion'], [503, 'ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A_09', 'Elixir']])
    f.Items.data.set(id, { name, code, icon: '' });
  const pick = (k, v) => JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(f.ItemRules.info(k)).filter(([key]) => v.includes(key)))));
  assert.deepEqual(pick(97, ['race', 'degree', 'group', 'kind', 'sox']), { race: 'CH', degree: 9, group: 'weapon', kind: 'Sword', sox: 0 });
  assert.equal(f.ItemRules.info(4040).sox, 3, '_C_RARE is Sun');
  assert.deepEqual(pick(500, ['race', 'gender', 'degree', 'group', 'kind', 'material']), { race: 'EU', gender: 'Female', degree: 5, group: 'armour', kind: 'Shoulder', material: 'Protector' });
  assert.deepEqual(pick(501, ['group', 'kind']), { group: 'weapon', kind: 'Staff' });
  assert.deepEqual([f.ItemRules.info(502).group, f.ItemRules.info(8).group, f.ItemRules.info(503).group], ['accessory', 'potion', 'alchemy']);
  const ids = filter => JSON.parse(JSON.stringify(f.ItemRules.list(filter).map(i => i.id)));
  assert.deepEqual(ids({ group: 'equipment', degrees: new Set([9]) }), [97, 4040]);
  assert.deepEqual(ids({ sox: 'any' }), [4040]); assert.deepEqual(ids({ sox: '3' }), [4040]); assert.deepEqual(ids({ sox: '1' }), []);
  assert.deepEqual(ids({ race: 'EU', kind: 'Protector' }), [500]);
  assert.deepEqual(ids({ query: 'potion' }), [8]);
  f.ItemRules.set([502], { act: 'sell' }); assert.deepEqual(ids({ custom: true }), [502], 'custom: only items with a rule');
});
test('stop and manual control prevent further automation', () => {
  const f = fixture(); f.Hunt.start(); f.drop(); f.Hunt.tick(); f.Hunt.stop();
  assert.equal(f.Loot.active, null); assert.equal(f.commands.at(-1).kind, 'move');
  f.advance(1000); f.Hunt.start(); f.Manual.lastAt = 101000; f.Controller.tick(); assert.equal(f.Controller.mode, 'manual');
});
test('native metadata checks flat and percent MP costs', () => {
  const f = fixture(); f.World.rebuildCatalog([{ id: 5, mp: 10, mpPercent: 20 }]);
  assert.equal(f.Combat.mpOk(5, { mp: 29, maxMp: 100 }), false);
  assert.equal(f.Combat.mpOk(5, { mp: 30, maxMp: 100 }), true);
});
test('skill names use the official English text, also after the catalog is rebuilt', () => {
  const f = fixture(); f.Learned.english.set(7, 'Thunderdragon force');
  f.World.rebuildCatalog([{ id: 7, name: 'SKILL_CH_LIGHTNING_A' }]);
  assert.equal(f.World.skillName(7), 'Thunderdragon force');
});
test('return mode owns movement; arrival can start hunting', () => {
  const f = fixture(); f.Settings.profile.hunt.center.x = 300; f.WalkBack.start(true); f.Controller.tick();
  assert.equal(f.Controller.mode, 'returning'); assert.equal(f.commands.at(-1).kind, 'move');
  f.World.gp.pose.x = 300; f.advance(1000); f.Controller.tick(); assert.equal(f.Hunt.running, true); assert.equal(f.WalkBack.active, null);
});
test('original profile import preserves wardrobe while stripping unrelated modules', () => {
  const f = fixture(); f.Settings.profileKey = 'profile:Tester';
  f.storage.set('sroAsistan:v7:profile:Tester', JSON.stringify({ macro: { castGapMs: 900 }, hunt: { radius: 500 }, wardrobe: { eq: { 6: { ref: 99 } }, large: true }, radar: { on: true } }));
  const before = f.storage.get('sroAsistan:v7:profile:Tester'); f.Settings.importOriginal();
  assert.equal(f.Settings.profile.macro.castGapMs, 900); assert.equal(f.Settings.profile.hunt.radius, 500); assert.equal(f.Settings.profile.wardrobe.eq[6].ref, 99); assert.equal(f.Settings.profile.wardrobe.large, undefined); assert.equal(f.Settings.profile.radar, undefined);
  assert.equal(f.storage.get('sroAsistan:v7:profile:Tester'), before);
});
test('restock round trip uses real lean command layer and awaits purchase settlement', () => {
  const f = fixture(), c = f.Settings.profile.potion.restock;
  const vendor = { gid: 7, refObjId: 99, name: 'Merchant', kind: 'npc', regionId: 1, x: 100, y: 0, z: 100 };
  f.World.ents.set(7, vendor); c.enabled = true; c.vendor = vendor;
  c.route = [{ regionId: 1, x: 100, y: 0, z: 100 }, { regionId: 1, x: 140, y: 0, z: 100 }]; c.hp.refObjId = 101; c.hp.target = 30; c.mp.on = false;
  f.Hunt.start(); f.Hunt.tick(); f.advance(500); f.Hunt.tick();
  f.World.gp.target = 7; f.advance(500); f.Hunt.tick(); assert.equal(f.commands.at(-1).kind, 'shop-open');
  f.World.gp.shop = { npc: 7, offers: [{ tab: 0, slot: 0, refObjId: 101, name: 'HP potion', price: '10', maxStack: 100, previews: [{ refObjId: 101, typeFlags: 2284 }] }] };
  f.World.gp.shopCompletionRevision++; f.advance(500); f.Hunt.tick(); f.advance(500); f.Hunt.tick();
  assert.equal(f.commands.at(-1).kind, 'shop-buy'); assert.equal(f.commands.at(-1).quantity, 30);
  f.World.gp.inventory = [{ slot: 13, refObjId: 101, typeFlags: 2284, quantity: 30 }]; f.advance(600); f.Hunt.tick(); assert.equal(f.commands.at(-1).kind, 'npc-close');
  f.World.gp.target = 0; f.advance(600); f.Hunt.tick(); f.Hunt.tick(); assert.equal(f.Restock.trip, null); assert.equal(f.Hunt.running, true);
});
test('revival travel preserves return intent through same-character bootstrap', () => {
  const f = fixture(); f.UI.mount = () => {}; f.UI.draw = () => {}; f.UI.update = () => {}; f.Ticker.start = () => {};
  f.boot();
  f.Settings.profileKey = 'profile:TestHero'; f.Settings.profile.hunt.onDeath = 'revive';
  f.Hunt.start(); f.Hunt.state = 'dead'; f.Hunt.revived = true;
  f.bus.emit('phase', 'entering-world'); assert.equal(f.Controller.resumeAfterRevive, true);
  f.bus.emit('character', 'TestHero'); assert.equal(f.Controller.resumeAfterRevive, true);
  f.World.gp.pose.x = 300; f.Controller.tick(); assert.equal(f.Controller.resumeAfterRevive, false); assert.ok(f.WalkBack.active);
});
test('collision routing goes around object walls through the actual gap', () => {
  const f = fixture(), wall = { x: 0, y: 0, z: 0, yaw: 0, mesh: {
    vertices: [200,0,0,200,0,300,200,0,380,200,0,1920], edges: [0,1,0,65535,3,0,2,3,0,65535,3,0] } };
  f.Navigation.capture({ kind: 'gameplay', command: { kind: 'navigation', bundle: navProduct([wall]) } });
  const target = { regionId: 1, x: 400, z: 100, y: 0 }, route = f.Navigation.plan(f.World.pose(), target);
  assert.ok(route.length > 1); assert.ok(route.some(p => p.z >= 300 && p.z <= 380));
  let previous = f.Navigation.local(f.World.pose());
  for (const p of route) { const next = f.Navigation.local(p); assert.equal(f.Navigation.clear(previous, next), true); previous = next; }
  assert.equal(route.at(-1).x, 400);
});
test('native open outlines and terrain surface edges do not create false town walls', () => {
  const f = fixture(), from = f.World.pose(), to = { ...from, x: 400 };
  const vertices = [200,0,0,200,0,1920,100,0,100];
  for (const placement of [
    { mesh: { vertices, edges: [0,1,0,65535,0,0] } },
    { terrainCells: [[0,0,1920,1920]], mesh: { vertices, edges: [0,1,0,65535,19,0] } },
    { terrainCells: [[0,0,1920,1920]], mesh: { vertices, edges: [0,1,0,1,3,1] } },
    { terrainCells: [], mesh: { vertices, edges: [0,1,0,65535,3,0] } },
  ]) {
    f.Navigation.install(navProduct([{ x: 0, z: 0, yaw: 0, ...placement }]));
    assert.ok(f.Navigation.plan(from, to).length);
    assert.equal(f.Navigation.clear(f.Navigation.local(from), f.Navigation.local(to)), true);
  }
  f.Navigation.install(navProduct([{ x: 0, z: 0, yaw: 0, terrainCells: [[0,0,1920,1920]], mesh: { vertices, edges: [0,1,0,65535,3,0] } }]));
  assert.equal(f.Navigation.plan(from, to).length, 0, 'Real blocking outlines must remain walls');
});

test('native directional borders allow the permitted side and block the opposite side', () => {
  const f = fixture(), left = f.World.pose(), right = { ...left, x: 400 };
  for (const flag of [1, 2]) {
    const mesh = { vertices: [200,0,0,200,0,1920,100,0,100], cells: [0,1,2], edges: [0,1,0,65535,flag,0] };
    f.Navigation.install(navProduct([{ x: 0, z: 0, yaw: 0, mesh }]));
    assert.equal(f.Navigation.clear(f.Navigation.local(left), f.Navigation.local(right)), flag === 1);
    assert.equal(f.Navigation.clear(f.Navigation.local(right), f.Navigation.local(left)), flag === 2);
  }
});

test('terrain barriers and fully sealed walls cannot be crossed', () => {
  const f = fixture(), blocked = new Uint8Array(9216);
  for (let z = 0; z < 96; z++) blocked[z * 96 + 10] = 1;
  f.Navigation.install(navProduct([], blocked));
  const route = f.Navigation.plan(f.World.pose(), { regionId: 1, x: 400, z: 100, y: 0 });
  assert.ok(route.every(p => p.x < 200));
  const t = { route: [], index: 0 }; f.Navigation.scene = null;
  assert.equal(f.Navigation.next(t, f.Settings.profile.hunt.center).waiting, true);
  assert.deepEqual(f.Navigation.next(t, f.Settings.profile.hunt.center, true).point, f.Settings.profile.hunt.center);
});
test('walk-back follows collision waypoints and permits detours away from the destination', () => {
  const f = fixture(); f.Settings.profile.hunt.center.x = 400;
  f.Navigation.install(navProduct([{ x:0,y:0,z:0,yaw:0,mesh:{ vertices:[200,0,0,200,0,500],edges:[0,1,0,65535,3,0] } }]));
  f.WalkBack.start(); f.Controller.tick();
  assert.ok(f.commands.at(-1).destination.z > 100);
  for (let n = 0; n < 4; n++) { f.World.gp.pose.z += 50; f.advance(7000); f.Controller.tick(); assert.ok(f.WalkBack.active); }
});
test('walk-back chains short legs across regions and starts hunting 10 km away', () => {
  const f = fixture();
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  f.Navigation.install(navWindow(1));
  f.WalkBack.start(true);
  assert.ok(f.WalkBack.active); assert.ok(f.WalkBack.active.totalLegs >= 5);
  assert.match(f.WalkBack.status(), /leg 1\/\d+/);
  let scene = 1, pending = 0, wait = 0;
  for (let n = 0; n < 400 && f.WalkBack.active; n++) {
    f.Controller.tick();
    const move = [...f.commands].reverse().find(c => c.kind === 'move');
    if (move) f.World.gp.pose = { ...move.destination };
    f.advance(800);
    const region = f.World.pose().regionId;
    // The game publishes a new 3x3 window when the player's region changes; the
    // asset/worker round trip takes a few ticks, so the old window is used first.
    if (region !== scene) { pending = region; if (++wait >= 4) { f.Navigation.install(navWindow(pending)); scene = pending; wait = 0; } }
  }
  assert.equal(f.WalkBack.active, null, 'the character arrived');
  assert.equal(f.Hunt.running, true, 'hunting started on arrival');
  assert.equal(f.notices.some(n => /Use Return & hunt when ready/.test(n)), false, 'no manual steps requested');
  assert.ok(f.commands.filter(c => c.kind === 'move').length > 8, 'it walked in several legs');
  const legLog = f.Log.lines.find(e => e.code === 'walk-leg');
  assert.ok(legLog, 'leg progress is logged'); assert.match(f.Activity.userMessage(legLog), /^Walking to the hunting spot: leg \d+ of about \d+\.$/);
});
test('a blocked leg end is walked to its neighbourhood and the walk continues', () => {
  const f = fixture();
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  const blocked = new Uint8Array(9216);
  blocked[5 * 96 + 29] = 1; // the straight leg end, about (2500, 100) from the start
  f.Navigation.install(navWindow(1, blocked));
  f.WalkBack.start(true); f.WalkBack.tick();
  const a = f.WalkBack.active;
  assert.ok(a, 'the walk is not cancelled');
  // A leg end only gives the direction: no replacement end is searched for.
  assert.equal(a.legTries, 0, 'the leg end is kept');
  const end = f.Navigation.local(a.travel.route.at(-1)), target = f.Navigation.local(a.leg.target);
  assert.equal(f.Navigation.open(end.x, end.z), true, 'the route ends on a walkable tile');
  assert.ok(Math.hypot(end.x - target.x, end.z - target.z) <= 240, 'near the leg end');
  assert.equal(f.commands.at(-1).kind, 'move');
});
// The game's clipper stands in as a fake: it walks every move except those its barrier
// stops, so it can disagree with the flat grid both ways (lean-clip-route.js).
function fakeClipper(f, barrier = () => false) {
  const clipper = { clips: 0, install() {}, clip(from, to) { clipper.clips++; return barrier(from, to) ? { ...from } : { ...to, y: from.y }; } };
  f.ClipRoute.clipper = clipper; f.ClipRoute.ready = true; f.ClipRoute.moves = new Map();
  return clipper;
}
const touches = (a, b, x) => Math.min(a.x, b.x) <= x && Math.max(a.x, b.x) >= x && a.x !== b.x;
test('the clipper keeps a flat route it walks', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  const clipper = fakeClipper(f), to = { regionId: 1, x: 900, y: 0, z: 400 };
  assert.equal(JSON.stringify(f.Navigation.plan({ regionId: 1, x: 100, y: 0, z: 100 }, to)), JSON.stringify([to]));
  assert.ok(clipper.clips > 0, 'the route was checked');
});
test('the clipper plans around a wall the flat grid does not know, and never returns the flat route through it', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  const wall = (a, b) => touches(a, b, 1000) && Math.min(a.z, b.z) < 1100;
  fakeClipper(f, wall);
  const from = { regionId: 1, x: 900, y: 0, z: 900 }, route = f.Navigation.plan(from, { regionId: 1, x: 1100, y: 0, z: 900 });
  assert.ok(route.length > 1);
  let p = from;
  for (const q of route) {
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 40));
    for (let i = 1; i <= n; i++) assert.ok(!wall(p, { x: p.x + (q.x - p.x) * i / n, z: p.z + (q.z - p.z) * i / n }), 'no step crosses the wall');
    p = q;
  }
  fakeClipper(f, (a, b) => touches(a, b, 500));
  assert.equal(f.Navigation.plan({ regionId: 1, x: 100, y: 0, z: 100 }, { regionId: 1, x: 900, y: 0, z: 400 }).length, 0, 'a stopped flat route is not walked');
});
test('the clipper walks a floor the flat grid sees as closed', () => {
  const f = fixture(), blocked = new Uint8Array(9216);
  for (let tz = 0; tz < 96; tz++) blocked[tz * 96 + 50] = 1;
  f.Navigation.install(navProduct([], blocked));
  const from = { regionId: 1, x: 800, y: 0, z: 400 }, to = { regionId: 1, x: 1200, y: 0, z: 400 };
  assert.equal(f.Navigation.plan(from, to)?.length ?? 0, 0, 'the flat grid is closed');
  fakeClipper(f, (a, b) => touches(a, b, 1010) && !(a.z >= 520 && a.z <= 600 && b.z >= 520 && b.z <= 600));
  const route = f.Navigation.plan(from, to);
  assert.ok(route.length > 1 && route.every(p => Number.isFinite(p.y)));
});
test('pursuit and detour candidates plan on the flat grid alone, without clipper searches', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  const clipper = fakeClipper(f, (a, b) => touches(a, b, 500));
  const route = f.Navigation.plan({ regionId: 1, x: 100, y: 0, z: 100 }, { regionId: 1, x: 900, y: 0, z: 400 }, 0, { clip: false });
  assert.equal(route.length, 1, 'the flat route, unchecked');
  assert.equal(clipper.clips, 0);
});
test('a long clipper search is answered later, slice by slice, while the walker waits', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  // Each clip takes a millisecond, so a search spans several 5 ms slices.
  const wall = (a, b) => touches(a, b, 1000) && Math.min(a.z, b.z) < 1100;
  const clipper = fakeClipper(f, wall), clip = clipper.clip;
  clipper.clip = (...args) => { f.advance(1); return clip(...args); };
  f.World.gp.pose = { regionId: 1, x: 900, y: 0, z: 900 };
  const owner = {}, goal = { regionId: 1, x: 1100, y: 0, z: 900 };
  const first = f.Navigation.next(owner, goal);
  assert.equal(first.planning, true, 'still searching');
  for (let n = 0; n < 200 && f.timers.length; n++) f.timers.shift().fn();
  const move = f.Navigation.next(owner, goal);
  assert.ok(move.point, 'the route is ready');
  assert.ok(owner.travel.route.length > 1);
});
test('a destination the clipper cannot reach is not searched again at once', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  const clipper = fakeClipper(f, (a, b) => touches(a, b, 500));
  const from = { regionId: 1, x: 100, y: 0, z: 100 }, to = { regionId: 1, x: 900, y: 0, z: 400 };
  assert.equal(f.Navigation.plan(from, to).length, 0);
  const clips = clipper.clips;
  assert.equal(f.Navigation.plan(from, to).length, 0);
  assert.ok(clipper.clips - clips < 20, 'only the flat route was checked again');
  f.advance(31000);
  f.Navigation.plan(from, to);
  assert.ok(clipper.clips - clips > 20, 'searched again after 30 s');
});
test('a search that failed only around avoided spots does not hold back the plain one', () => {
  const f = fixture(); f.Navigation.install(navWindow(1));
  // The clipper's only way across x = 1000 is the gap at z 1000-1080, off the straight line
  // and covered by the avoided spot; it keeps the walker in the home region, so no other
  // region's gap offers a way.
  const wall = (a, b) => a.regionId !== 1 || b.regionId !== 1 || touches(a, b, 1000) && !(Math.min(a.z, b.z) >= 1000 && Math.max(a.z, b.z) <= 1080);
  fakeClipper(f, wall);
  const from = { regionId: 1, x: 900, y: 0, z: 900 }, to = { regionId: 1, x: 1100, y: 0, z: 900 };
  assert.equal(f.Navigation.plan(from, to, 0, { avoid: [{ regionId: 1, x: 1000, y: 0, z: 1040, r: 80 }] }).length, 0, 'no way around the avoided spot');
  const plain = f.Navigation.plan(from, to);
  assert.ok(plain.length > 0, 'the plain search still runs');
});
// An object the collision map does not know about: the character stops against it while moves are sent.
function pillarWorld(f, pillar = { x: 270, z: 100, r: 15 }) {
  return () => {
    const move = [...f.commands].reverse().find(c => c.kind === 'move');
    if (!move) return;
    const pose = f.World.gp.pose, dx = move.destination.x - pose.x, dz = move.destination.z - pose.z, d = Math.hypot(dx, dz);
    if (!d) return;
    const k = Math.min(18, d) / d, next = { ...pose, x: pose.x + dx * k, z: pose.z + dz * k };
    if (Math.hypot(next.x - pillar.x, next.z - pillar.z) >= pillar.r) f.World.gp.pose = next;
  };
}
test('a walk that stops against an unmapped object sidesteps it instead of sitting', () => {
  const f = fixture(), step = pillarWorld(f);
  f.WalkBack.startTo({ regionId: 1, x: 600, y: 0, z: 100 }, { label: 'the test spot', stop: 12 });
  let ticks = 0;
  while (f.WalkBack.active && ticks++ < 120) { f.WalkBack.tick(); step(); f.advance(900); }
  assert.equal(f.WalkBack.active, null, 'the walk ended');
  assert.ok(f.World.gp.pose.x >= 590, 'the character got past the pillar');
});
test('a walk that cannot get past reports a clear message and stops after a bounded number of tries', () => {
  const f = fixture(); let failed = '';
  const step = pillarWorld(f, { x: 270, z: 100, r: 1e5 });
  f.WalkBack.startTo({ regionId: 1, x: 600, y: 0, z: 100 }, { label: 'the test spot', onFail: r => { failed = r; } });
  let ticks = 0;
  while (f.WalkBack.active && ticks++ < 200) { f.WalkBack.tick(); step(); f.advance(900); }
  assert.equal(f.WalkBack.active, null);
  assert.match(failed, /blocked|obstacle/i);
  assert.ok(ticks < 30, 'gave up within about half a minute, not after minutes of standing');
});
test('town and restock walking recover from an unmapped object the same way', () => {
  let f = fixture(), step = pillarWorld(f);
  const dest = { regionId: 1, x: 600, y: 0, z: 100 };
  f.Town.trip = { phase: 'walk-vendor', at: f.Ticker ? 0 : 0, travel: null, lastPose: null, progressAt: 100000, movedAt: -Infinity, retryAt: 0 };
  let ticks = 0, arrived = false;
  while (!arrived && f.Town.trip && ticks++ < 150) { arrived = f.Town.walk(dest); step(); f.advance(900); }
  assert.equal(arrived, true, 'town walk got past the pillar');
  f = fixture(); step = pillarWorld(f);
  f.Restock.trip = { phase: 'vendor', route: [{ regionId: 1, x: 100, y: 0, z: 100 }, dest], index: 1, at: 0, movedAt: 0, best: Infinity, progressAt: 100000, manualAt: f.Manual.lastAt };
  ticks = 0; arrived = false;
  while (!arrived && f.Restock.trip && ticks++ < 150) { arrived = f.Restock.walk(); step(); f.advance(900); }
  assert.ok(f.Restock.trip, 'restock walk was not failed'); assert.equal(arrived, true, 'restock walk got past the pillar');
});
test('resume hunting walks to a far spot instead of asking for manual steps', () => {
  const f = fixture();
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  assert.equal(f.Controller.resumeHunting('After a revive'), 'walking');
  assert.ok(f.WalkBack.active);
  assert.equal(f.notices.some(n => /Use Return & hunt when ready/.test(n)), false);
});
test('walk-back refuses a spot beyond its safety cap and Stop all cancels a chained walk', () => {
  let f = fixture();
  f.Settings.profile.hunt.center = { regionId: 100, x: 500, y: 0, z: 100 };
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active, null); assert.ok(f.notices.some(n => /too far to walk/.test(n)));
  f = fixture();
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  f.Navigation.install(navWindow(1)); f.WalkBack.start(true); f.Controller.tick();
  assert.ok(f.WalkBack.active); f.stopAll(); assert.equal(f.WalkBack.active, null);
});
test('navdata route format decodes nodes, edges and rejects malformed data', () => {
  const f = fixture();
  const nodes = [{ x: 5000, z: 5000, y: 10 }, { x: 5200, z: 5000, y: 12 }, { x: 5000, z: 5200, y: 14 }];
  const buffer = navBinary(nodes, [[0, 1], [1, 2]], { originX: 5000, originZ: 5000, flags: 0 });
  const area = f.Route.decode(buffer, { name: 'synthetic', file: 'synthetic.bin' });
  assert.equal(area.count, 3); assert.equal(area.dungeon, false);
  assert.deepEqual([area.x[0], area.z[0], area.y[0]], [5000, 5000, 10]);
  assert.deepEqual([area.x[2], area.z[2], area.y[2]], [5000, 5200, 14]);
  assert.equal(area.offsets[3], 4); assert.equal(area.neighbours.length, 4);
  assert.throws(() => f.Route.decode(buffer.slice(0, 20)), /short|size/i);
  const bad = Buffer.from(new Uint8Array(buffer)); bad.write('XXXX', 0, 'ascii');
  assert.throws(() => f.Route.decode(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)), /Unsupported/);
});
test('navdata A* goes around a wall instead of straight through it', async () => {
  const f = fixture();
  const grid = navGrid(5000, 5000, 6, 6, 200, (x, z) => x === 5400 && z <= 5600);
  const buffer = navBinary(grid.nodes, grid.edges, { originX: 5000, originZ: 5000 });
  const meta = navArea('wall', grid.nodes, buffer);
  f.Route.setAreas([meta]); f.Route.setLoader(() => buffer);
  const from = navPose(5000, 5000), to = navPose(5800, 5000);
  assert.equal(await f.Route.ensure(from, to), true);
  const route = f.Route.plan(from, to);
  assert.ok(route, f.Route.message);
  assert.ok(route.length > 1200, 'the wall adds distance');
  assert.ok(route.points.some(point => navAbs(point).z >= 5780), 'the route passes the open gap');
  assert.ok(f.Route.plan(navPose(5100, 5100), navPose(5800, 5000)), 'a start near the graph snaps to it');
  assert.equal(f.Route.plan(navPose(9000, 9000), navPose(9500, 9000)), null, 'no area means no route');
  assert.equal(f.Route.plan(navPose(5000, 7000), navPose(5800, 5000)), null, 'an out-of-area start means no route');
});
test('walk-back follows a navdata route and starts hunting on arrival', async () => {
  const f = fixture();
  const grid = navGrid(5000, 5000, 15, 1, 200);
  const buffer = navBinary(grid.nodes, grid.edges, { originX: 5000, originZ: 5000 });
  const meta = navArea('line', grid.nodes, buffer);
  f.Route.setAreas([meta]); f.Route.setLoader(() => buffer);
  const from = navPose(5000, 5000), to = navPose(7700, 5000);
  assert.equal(await f.Route.ensure(from, to), true);
  f.World.gp.pose = { ...from }; f.Settings.profile.hunt.center = { ...to };
  f.Navigation.install(navWindow(from.regionId));
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active.source, 'navdata');
  assert.match(f.WalkBack.status(), /waypoint 1\//);
  let scene = from.regionId;
  for (let n = 0; n < 200 && f.WalkBack.active; n++) {
    f.Controller.tick();
    const move = [...f.commands].reverse().find(c => c.kind === 'move');
    if (move) f.World.gp.pose = { ...move.destination };
    f.advance(800);
    const region = f.World.gp.pose.regionId;
    if (region !== scene) { f.Navigation.install(navWindow(region)); scene = region; }
  }
  assert.equal(f.WalkBack.active, null, 'the character arrived');
  assert.equal(f.Hunt.running, true, 'hunting started on arrival');
  assert.ok(f.Log.lines.some(entry => /using navdata \(line\)/.test(entry.text)), 'the log names the route source');
});
// A clipper stand-in: the game map has a wall at x 5500 below z 5700 that the route data does not know.
function wallClipper() {
  const abs = p => ({ x: (p.regionId & 255) * 1920 + p.x, z: (p.regionId >>> 8 & 127) * 1920 + p.z });
  const blocked = (a, b) => (a.x < 5500) !== (b.x < 5500) && a.z + (b.z - a.z) * (5500 - a.x) / (b.x - a.x) < 5700;
  return { surface: p => ({ ...p }), available: () => true, clip: (from, to) => blocked(abs(from), abs(to)) ? { ...from } : { ...to } };
}
function checkedArea(f, name, columns = 6) {
  const grid = navGrid(5000, 5000, columns, 6, 200);
  const buffer = navBinary(grid.nodes, grid.edges, { originX: 5000, originZ: 5000 });
  f.Route.setAreas([navArea(name, grid.nodes, buffer)]); f.Route.setLoader(() => buffer);
  f.Hook.assetUrl = 'https://opensro.online/assets/entry-test.js';
  return { from: navPose(5000, 5000), to: navPose(5000 + (columns - 1) * 200, 5000) };
}
test('a corridor is checked against the game map: an edge the collision does not walk is banned and walked around', async () => {
  const f = fixture(), { from, to } = checkedArea(f, 'cliff'), clipper = wallClipper();
  f.RouteCheck.region = async regionId => ({ regionId, clipper });
  assert.equal(f.RouteCheck.available(), true);
  const route = await f.Route.checked(from, to);
  assert.ok(route, f.Route.message);
  assert.ok(route.points.some(p => navAbs(p).z >= 5400), 'the corridor crosses where a short way round the wall exists');
  assert.ok(f.Route.bans('cliff').has('2>3') && f.Route.bans('cliff').has('3>2'), 'the edge straight through the wall is banned, both ways, for the session');
  assert.ok(f.Route.plan(from, to).points.some(p => navAbs(p).z >= 5400), 'later plans in the area keep the bans');
  const g = fixture(), ends = checkedArea(g, 'unknown');
  g.RouteCheck.region = async () => null;
  const straight = await g.Route.checked(ends.from, ends.to);
  assert.ok(straight); assert.equal(straight.points.some(p => navAbs(p).z > 5000), false, 'without collision data the corridor is walked as before');
  assert.equal(g.Route.bans('unknown').size, 0);
  const h = fixture(), shut = checkedArea(h, 'shut');
  h.RouteCheck.region = async regionId => ({ regionId, clipper: { surface: p => ({ ...p }), available: () => true, clip: from => ({ ...from }) } });
  assert.equal(await h.Route.checked(shut.from, shut.to), null, 'no corridor walks on the game map');
  assert.match(h.Route.message, /walks on the game map/);
});
test('the asset worker is read from the page bootstrap when the worker hook ran too late; without it the walk is unchecked and says so', async () => {
  const f = fixture(), bootstrap = { querySelector: () => ({ src: 'https://opensro.online/assets/bootstrap-X.js' }) };
  assert.equal(f.RouteCheck.available(), false, 'no hook and no page: unchecked');
  f.win.document = bootstrap;
  f.win.fetch = async () => ({ text: async () => 'a=1;const w=new Worker(new URL("/assets/entry-C_test.js",""+import.meta.url),{type:"module",name:"sro-assets"});' });
  assert.equal(f.RouteCheck.available(), true);
  assert.equal(await f.RouteCheck.locate(), 'https://opensro.online/assets/entry-C_test.js');
  assert.equal(f.Hook.assetUrl, 'https://opensro.online/assets/entry-C_test.js', 'found once for the session');
  const g = fixture();
  g.win.document = bootstrap; g.win.fetch = async () => ({ text: async () => 'no worker here' });
  assert.equal(await g.RouteCheck.locate(), '');
  const graph = { count: 2, x: Int32Array.from([5000, 5200]), z: Int32Array.from([5000, 5000]), y: Int16Array.from([0, 0]) };
  assert.equal(await g.RouteCheck.verify('none', graph, 0, 1), null, 'the check did not run');
  assert.ok(g.Log.lines.some(entry => /asset loader was not found/.test(entry.text)), 'the log says the route is unchecked');
});
test('walk-back waits for the checked corridor, then walks round the wall the route data does not know', async () => {
  const f = fixture(), { from, to } = checkedArea(f, 'checked', 15), clipper = wallClipper();
  f.RouteCheck.region = async regionId => ({ regionId, clipper });
  assert.equal(await f.Route.ensure(from, to), true);
  f.World.gp.pose = { ...from }; f.Settings.profile.hunt.center = { ...to };
  f.Navigation.install(navWindow(from.regionId));
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active.source, 'planning');
  f.advance(7000); f.WalkBack.tick();
  assert.equal(f.WalkBack.active.source, 'planning', 'a running check is not cut short by the plain loading wait');
  for (let n = 0; n < 200 && f.WalkBack.active.source === 'planning'; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.WalkBack.active.source, 'navdata');
  assert.ok(f.WalkBack.active.route.some(p => navAbs(p).z >= 5400), 'the walked corridor goes round the wall');
  assert.ok(f.Log.lines.some(entry => /checking it against the game map/.test(entry.text)));
});
test('walk-back falls back to legs without route data or between different areas', async () => {
  let f = fixture();
  f.Route.setAreas([]);
  f.World.gp.pose = navPose(5000, 5000); f.Settings.profile.hunt.center = navPose(7700, 5000);
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active.source, 'legs'); assert.ok(f.WalkBack.active);
  f = fixture();
  const a = navGrid(5000, 5000, 6, 1, 200), b = navGrid(9000, 5000, 6, 1, 200);
  const ab = navBinary(a.nodes, a.edges, { originX: 5000, originZ: 5000 });
  const bb = navBinary(b.nodes, b.edges, { originX: 9000, originZ: 5000 });
  const ma = navArea('left', a.nodes, ab), mb = navArea('right', b.nodes, bb);
  f.Route.setAreas([ma, mb]); f.Route.setLoader(name => name === 'left' ? ab : bb);
  f.World.gp.pose = navPose(5000, 5000); f.Settings.profile.hunt.center = navPose(9600, 5000);
  assert.equal(await f.Route.ensure(navPose(5000, 5000), navPose(9600, 5000)), false);
  assert.match(f.Route.message, /covers both/);
  const overlap = navGrid(5500, 5000, 6, 1, 200);
  const mc = navArea('overlap', overlap.nodes, navBinary(overlap.nodes, overlap.edges, { originX: 5500, originZ: 5000 }));
  f.Route.setAreas([ma, mc, mb]);
  assert.equal(f.Route.commonArea(navPose(5600, 5000), navPose(5000, 5000)).name, 'left', 'one area covering both ends wins');
  f.WalkBack.start(true);
  for (let n = 0; n < 5; n++) await Promise.resolve();
  assert.ok(f.WalkBack.active); assert.equal(f.WalkBack.active.source, 'legs');
  assert.ok(f.notices.some(n => /Walking back to the hunting spot/.test(n)));
  assert.ok(f.Log.lines.some(entry => /walking in legs/.test(entry.text)), 'the log names the fallback source');
});
test('a stuck navdata route skips two unreachable points, re-plans once, then hands over to the leg fallback', async () => {
  const f = fixture();
  const grid = navGrid(5000, 5000, 15, 1, 200);
  const buffer = navBinary(grid.nodes, grid.edges, { originX: 5000, originZ: 5000 });
  const meta = navArea('stuck', grid.nodes, buffer);
  f.Route.setAreas([meta]); f.Route.setLoader(() => buffer);
  const from = navPose(5000, 5000), to = navPose(7700, 5000);
  await f.Route.ensure(from, to);
  f.World.gp.pose = { ...from }; f.Settings.profile.hunt.center = { ...to };
  f.Navigation.install(navWindow(from.regionId));
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active.source, 'navdata');
  f.Navigation.next = () => ({ error: 'No walkable route found through the loaded collision map.' });
  f.WalkBack.tick();                                // consume the start waypoint
  const index = f.WalkBack.active.index;
  f.advance(1000); f.WalkBack.tick();               // an unreachable waypoint is skipped
  f.advance(1000); f.WalkBack.tick();               // and the next one
  assert.equal(f.WalkBack.active.index, index + 2); assert.equal(f.WalkBack.active.navReplans, 0);
  f.advance(1000); f.WalkBack.tick();               // a third in a row re-plans
  assert.equal(f.WalkBack.active.source, 'navdata'); assert.equal(f.WalkBack.active.navReplans, 1);
  assert.equal(f.WalkBack.active.skips, 0, 'a new corridor may skip again');
  f.Route.plan = () => null;
  f.advance(21000); f.WalkBack.tick();               // the re-planned start is at the current pose
  f.advance(21000); f.WalkBack.tick();               // no progress now, so the leg fallback takes over
  assert.ok(f.WalkBack.active); assert.equal(f.WalkBack.active.source, 'legs', 'the leg fallback takes over');
});
test('Stop all cancels a walk while route data is still loading', () => {
  const f = fixture();
  const grid = navGrid(5000, 5000, 15, 1, 200);
  const buffer = navBinary(grid.nodes, grid.edges, { originX: 5000, originZ: 5000 });
  f.Route.setAreas([navArea('slow', grid.nodes, buffer)]);
  f.Route.setLoader(() => new Promise(() => {}));
  f.World.gp.pose = navPose(5000, 5000); f.Settings.profile.hunt.center = navPose(7700, 5000);
  f.WalkBack.start(true);
  assert.equal(f.WalkBack.active.source, 'planning');
  f.stopAll();
  assert.equal(f.WalkBack.active, null);
});
test('Thunderdragon Force level 13 appears as the highest learned imbue and is cast', () => {
  const f = fixture();
  f.World.rebuildCatalog([{ id:3392,group:334,level:1,name:'Thunderdragon force',targetRequired:false }, { id:3404,group:334,level:13,name:'Thunderdragon force',targetRequired:false,mp:0 }]);
  f.World.gp.skills = [3392,3404];
  assert.equal(f.UI.learnedSkills(true).find(s => s.group === 334).id, 3404);
  f.Settings.profile.macro.imbue = { id:3392,group:334 };
  assert.equal(f.Combat.imbue(), true); assert.equal(f.commands.at(-1).skillId, 3404);
  f.World.gp.skills = [3392]; assert.equal(f.UI.learnedSkills(true)[0].id, 3392);
});
test('wardrobe retains honor skins and validates body and equipment slot', () => {
  const f = fixture();
  f.WdData.build({items:[[10,'ITEM_CH_SWORD_09_A',6,-1,'CH_M',0,0],[11,'ITEM_CH_SWORD_09_C_RARE_HONOR',6,-1,'CH_M',1,0],[12,'ITEM_CH_SWORD_09_A',6,-1,'CH_W',0,0]],models:[[123,'CHAR_CH_MAN_TEST',0]]},[],{});
  f.Wardrobe.body = 'CH_M';
  assert.ok(f.Wardrobe.validEq(6,11)); assert.equal(f.Wardrobe.validEq(6,12), null); assert.equal(f.Wardrobe.validEq(7,11), null);
  f.LeanWardrobe.slot = 'e6'; assert.equal(f.LeanWardrobe.rows().length,2);
});
test('wardrobe appearance changes never alter real inventory or command metadata', () => {
  const f = fixture(), tf = (2 << 11) | (6 << 7) | 44;
  f.WdData.build({items:[[10,'ITEM_CH_SWORD_09_A',6,-1,'CH_M',0,0],[11,'ITEM_CH_SWORD_09_C_RARE_HONOR',6,-1,'CH_M',1,0]],models:[[123,'CHAR_CH_MAN_TEST',0]]},[],{});
  f.Wardrobe.body = 'CH_M'; f.Settings.profile.wardrobe.eq[6] = { ref:11, plus:9 };
  const real = {slot:6,refObjId:10,typeFlags:tf,plus:0};
  const ev = {kind:'gameplay',state:{...f.World.gp,inventory:[real]}}; f.World.applyEvent(ev);
  assert.equal(f.World.gp.inventory[0].refObjId,10); assert.equal(real.refObjId,10);
  assert.equal(ev.state.inventory[0].refObjId,11); assert.equal(ev.state.inventory[0].plus,9);
  f.Settings.profile.wardrobe.on = false; f.Wardrobe.applyNow(); assert.equal(ev.state.inventory[0].refObjId,10);
});
test('all compatible paid avatar skins remain browsable without ownership or equipment filters', () => {
  const f = fixture(), items = [];
  for (let n=0;n<70;n++) items.push([100+n,'ITEM_MALL_AVATAR_M_PREMIUM_'+n,-1,n%4,'CH_M',0,0]);
  items.push([999,'ITEM_MALL_AVATAR_W_PREMIUM',-1,1,'CH_W',0,0]);
  f.WdData.build({items,models:[[123,'CHAR_CH_MAN_TEST',0]]},[],{}); f.Wardrobe.body='CH_M';
  f.LeanWardrobe.slot='a*'; f.LeanWardrobe.degree=13; f.LeanWardrobe.rarity='3';
  assert.equal(f.LeanWardrobe.rows().length,70); assert.equal(f.World.gp.avatarInventory,undefined);
  f.LeanWardrobe.slot='a2'; assert.equal(f.LeanWardrobe.rows().length,17);
  f.Wardrobe.view.slot='a2'; f.Wardrobe.pick(f.LeanWardrobe.rows()[0]);
  assert.equal(f.Wardrobe.buildAv([])[0].refObjId,102); assert.equal(f.commands.length,0);
  assert.equal(f.Wardrobe.validAv(1,999),null);
});
test('elixirs-only preset uses native types, clears include overrides and excludes other drops', () => {
  const f=fixture(),p=f.Settings.profile.hunt.pickup;
  p.include='potion'; f.Loot.preset('elixirs');
  assert.equal(p.include,'');
  const elixir=f.drop(30,3436); elixir.name='Localized reinforcement item';
  assert.equal(f.Loot.allowed(elixir),true);
  for (const tf of [2284,748,3436+2048, (11<<7)|108|(2<<11),44,108]) assert.equal(f.Loot.allowed(f.drop(tf,tf)),false);
  p.others=true; p.elixirs=false; assert.equal(f.Loot.allowed(elixir),false);
  f.Loot.preset('elixirs-gold'); assert.equal(f.Loot.allowed(f.drop(40,748)),true);
  assert.equal(f.Loot.allowed(f.drop(41,2284)),false);
  f.Loot.preset('all'); assert.equal(f.Loot.allowed(f.drop(42,2284)),true);
});
test('elixir filters preserve ownership, exclusions and full-bag stack merging', () => {
  const f=fixture(),d=f.drop(30,3436); f.Loot.preset('elixirs');
  d.groundItem.ownerJid=999; assert.equal(f.Loot.allowed(d),false); delete d.groundItem.ownerJid;
  f.Settings.profile.hunt.pickup.exclude='potion'; assert.equal(f.Loot.allowed(d),false);
  f.Settings.profile.hunt.pickup.exclude=''; f.World.gp.inventorySlotCount=13; assert.equal(f.Loot.allowed(d),false);
  f.World.gp.inventory=[{slot:13,refObjId:101,quantity:2,tooltip:{fields:{maxStack:50}}}]; assert.equal(f.Loot.allowed(d),true);
});
test('new alchemy category switches inherit old Other items preferences', () => {
  const f=fixture(); f.storage.set('sroAsistan:v7:profile:default',JSON.stringify({hunt:{pickup:{others:false}}}));
  f.Settings.importOriginal();
  for(const key of ['elixirs','powders','alchemy']) assert.equal(f.Settings.profile.hunt.pickup[key],false);
});
test('changing loot filters cancels an outstanding pickup before handing back control', () => {
  const f=fixture(); f.Loot.begin(f.drop()); f.Loot.preset('elixirs'); f.advance(1000);
  assert.equal(f.Loot.tick(),false); assert.equal(f.Loot.active,null); assert.equal(f.commands.at(-1).kind,'move');
});
test('idle, manual pause and walk-back do not change pet auto-grab settings', () => {
  const f = fixture(); pickupPet(f, 135);
  f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'cos-behavior'), false);
  f.Hunt.start(); f.Manual.lastAt = 100000; f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'cos-behavior'), false);
  f.Settings.profile.hunt.center.x = 400; f.WalkBack.start(true); f.advance(1000); f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'cos-behavior'), false);
});

test('revival return waits for inventory settlement without losing resume intent', () => {
  const f = fixture(); f.Controller.resumeAfterRevive = true;
  f.World.gp.pose.x = 300; f.World.gp.inventoryPending = true;
  f.Controller.tick(); f.advance(500); f.Controller.tick();
  assert.equal(f.Controller.resumeAfterRevive, true);
  assert.equal(f.WalkBack.active, null); assert.equal(f.notices.length, 0);
  f.World.gp.inventoryPending = false; f.Controller.tick();
  assert.equal(f.Controller.resumeAfterRevive, false);
  assert.equal(f.WalkBack.active.resume, true);
});

test('stop cancels a revival return waiting for inventory settlement', () => {
  const f = fixture(); f.Controller.resumeAfterRevive = true; f.World.gp.inventoryPending = true;
  f.Controller.tick(); f.toggleBot(); f.World.gp.inventoryPending = false; f.Controller.tick();
  assert.equal(f.Controller.resumeAfterRevive, false); assert.equal(f.WalkBack.active, null);
});

test('restarting walk-back preserves hunting on arrival', () => {
  const f = fixture(); f.Settings.profile.hunt.center.x = 400;
  f.Hunt.start(); f.WalkBack.start(); assert.equal(f.WalkBack.active.resume, true);
  f.advance(1000); f.WalkBack.start(); assert.equal(f.WalkBack.active.resume, true);
  f.World.gp.pose.x = 400; f.WalkBack.tick(); assert.equal(f.Hunt.running, true);
});
test('pet full chime alerts once and rearms after space is freed with a cooldown', () => {
  const f = fixture(), pet = pickupPet(f); let sounds = 0;
  f.Sound.play = kind => { if (kind !== 'pet-full') return false; sounds++; return true; };
  f.Hunt.start(); pet.status = 1; pet.inventory = [{ slot: 0, refObjId: 101, quantity: 1 }];
  f.Controller.tick(); f.advance(60000); f.Controller.tick();
  assert.equal(sounds, 1); assert.equal(f.notices.filter(n => /bag is full/.test(n)).length, 1);
  pet.inventory = []; f.Controller.tick(); pet.inventory = [{ slot: 0 }]; f.Controller.tick();
  assert.equal(sounds, 2);
  pet.inventory = []; f.Controller.tick(); pet.inventory = [{ slot: 0 }]; f.Controller.tick();
  assert.equal(sounds, 2); f.advance(30000); f.Controller.tick(); assert.equal(sounds, 3);
});

test('pet full alert respects toggle, collector, stopped and missing pet states', () => {
  const f = fixture(), pet = pickupPet(f); let sounds = 0;
  f.Sound.play = kind => { if (kind !== 'pet-full') return false; sounds++; return true; }; pet.status = 1; pet.inventory = [{ slot: 0 }];
  f.Controller.tick(); assert.equal(sounds, 0); f.Hunt.start();
  f.Settings.profile.hunt.pickup.petFullSound = false; f.Controller.tick(); assert.equal(sounds, 0);
  f.Settings.profile.hunt.pickup.petFullSound = true;
  f.Settings.profile.hunt.pickup.collector = 'character'; f.Controller.tick(); assert.equal(sounds, 0);
  f.Settings.profile.hunt.pickup.collector = 'pet'; pet.dead = true; f.Controller.tick(); assert.equal(sounds, 0);
  pet.dead = false; f.Controller.tick(); assert.equal(sounds, 1);
});

test('blocked audio retries with cooldown and does not repeat full-bag notices', () => {
  const f = fixture(), pet = pickupPet(f); let attempts = 0;
  f.Sound.play = kind => kind === 'pet-full' && ++attempts >= 2; f.Hunt.start(); pet.status = 1; pet.inventory = [{ slot: 0 }];
  f.Controller.tick(); f.advance(1000); f.Controller.tick(); assert.equal(attempts, 1);
  f.advance(30000); f.Controller.tick(); assert.equal(attempts, 2);
  f.advance(60000); f.Controller.tick(); assert.equal(attempts, 2);
  assert.equal(f.notices.filter(n => /bag is full/.test(n)).length, 1);
});

test('pet chime schedules three gentle notes and leaves other bot sounds silent', () => {
  const f = fixture(); let notes = 0;
  assert.equal(f.Sound.play('pet-full'), false);
  f.Sound.ctx = { state: 'running', currentTime: 10, destination: {},
    createOscillator() { notes++; return { frequency: {}, connect() {}, start() {}, stop() {}, disconnect() {} }; },
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; } };
  assert.equal(f.Sound.play('good'), false); assert.equal(notes, 0);
  assert.equal(f.Sound.play('pet-full'), true); assert.equal(notes, 3);
});
function partyApplication(f) {
  f.Settings.profile.party.autoAcceptMatching = true;
  f.World.gp.social = { self: 10, leader: 10, options: 1, members: [{ id: 10 }] };
  f.World.gp.partyMatching = { own: { id: 5, type: 1 }, request: { a: 40, b: 50, expires: 110000, member: { name: 'Applicant' } } };
  return f.World.gp.partyMatching;
}

const jm = v => JSON.parse(JSON.stringify(v));
function joinMainFixture(extra = {}) {
  const f = fixture();
  Object.assign(f.Settings.profile.party, { joinMain: true, mainName: 'MainChar' });
  f.World.gp.social = { localName: 'AltChar', self: 0, leader: 0, options: 0, members: [], invitation: null };
  f.World.gp.partyMatching = { own: null, request: null, pending: null, joining: null, page: 1, pages: 1, rows: [], ...extra };
  return f;
}

test('alt account applies to the main account listing and waits for the answer', () => {
  const f = joinMainFixture({ rows: [{ id: 7, name: 'mainchar', members: 1, type: 1, min: 1, max: 90 }] });
  f.Controller.tick(); assert.deepEqual(jm(f.commands[0]), { kind: 'party-match-join', id: 7 });
  f.advance(5000); f.Controller.tick(); assert.equal(f.commands.length, 1);
});

test('auto-accept answers only applicants on the name list, and everyone when the list is empty', () => {
  let f = fixture(); partyApplication(f);
  f.Settings.profile.party.acceptNames = 'Friend, other'; f.Party.tick();
  assert.equal(f.commands.filter(c => c.kind === 'party-match-answer').length, 0, 'Applicant is not listed');
  f.Settings.profile.party.acceptNames = 'friend,  APPLICANT'; f.Party.tick();
  assert.equal(f.commands.filter(c => c.kind === 'party-match-answer').length, 1, 'listed, case-insensitively');
  f = fixture(); partyApplication(f); f.Settings.profile.party.acceptNames = ''; f.Party.tick();
  assert.equal(f.commands.filter(c => c.kind === 'party-match-answer').length, 1, 'empty list accepts everyone');
});

test('the alt leaves a party led by someone else only when asked to, and keeps the named leader party', () => {
  const f = joinMainFixture(); const party = f.Settings.profile.party;
  const inParty = leaderName => { f.World.gp.social = { localName: 'AltChar', self: 2, leader: 1, options: 1, members: [{ id: 1, name: leaderName }, { id: 2, name: 'AltChar' }], invitation: null }; };
  f.World.ents.set(56, { gid: 56, kind: 'player', name: 'MainChar', ...f.Hunt.cfg().center });
  inParty('Stranger'); f.Party.tick(); assert.equal(f.commands.filter(c => c.kind === 'party-leave').length, 0, 'off by default');
  party.leaveIfNotLeader = true; f.Party.tick();
  assert.equal(f.commands.filter(c => c.kind === 'party-leave').length, 1, 'leader is someone else');
  f.advance(1000); f.Party.tick(); assert.equal(f.commands.filter(c => c.kind === 'party-leave').length, 1, 'not repeated at once');
  const g = joinMainFixture(); g.Settings.profile.party.leaveIfNotLeader = true;
  g.World.gp.social = { localName: 'AltChar', self: 2, leader: 1, options: 1, members: [{ id: 1, name: 'mainchar' }, { id: 2, name: 'AltChar' }], invitation: null };
  g.Party.tick(); assert.equal(g.commands.filter(c => c.kind === 'party-leave').length, 0, 'the named leader, any letter case');
});

test('the party the game hands to another member stays together until the party leader is back at the hunting spot', () => {
  const f = joinMainFixture(); f.Settings.profile.party.leaveIfNotLeader = true;
  f.World.gp.social = { localName: 'AltChar', self: 2, leader: 1, options: 1, members: [{ id: 1, name: 'OtherAlt' }, { id: 2, name: 'AltChar' }], invitation: null };
  const leaves = () => f.commands.filter(c => c.kind === 'party-leave').length, H = f.Hunt.cfg();
  f.Party.tick(); assert.equal(leaves(), 0, 'the main is not in view');
  assert.match(f.Party.joinMessage, /leaving it once MainChar is back/);
  const main = { gid: 56, kind: 'player', name: 'mainchar', regionId: H.center.regionId, x: H.center.x + H.radius + 400, y: 0, z: H.center.z };
  f.World.ents.set(56, main); f.Party.tick(); assert.equal(leaves(), 0, 'in view, but away from the hunting area');
  main.x = H.center.x + H.radius + 200; f.Party.tick(); assert.equal(leaves(), 1, 'back near the hunting area, any letter case');
  const g = joinMainFixture(); g.Settings.profile.party.leaveIfNotLeader = true; g.Hunt.cfg().center = null;
  g.World.gp.social = { localName: 'AltChar', self: 2, leader: 1, options: 1, members: [{ id: 1, name: 'OtherAlt' }, { id: 2, name: 'AltChar' }], invitation: null };
  g.World.ents.set(56, { gid: 56, kind: 'player', name: 'MainChar', regionId: 9, x: 5000, y: 0, z: 5000 });
  g.Party.tick(); assert.equal(g.commands.filter(c => c.kind === 'party-leave').length, 1, 'without a hunting spot, in view is enough');
});

test('the main answers a party application while dead or waiting after a revive', () => {
  for (const state of ['dead', 'revived', 'not-local']) {
    const f = fixture(); partyApplication(f); f.Hunt.start();
    if (state === 'dead') f.World.isDead = () => true;
    else if (state === 'revived') { f.Controller.resumeAfterRevive = true; f.World.gp.inventoryPending = true; }
    else { f.Controller.resumeAfterRevive = true; f.World.local = () => false; }
    f.Controller.tick();
    assert.deepEqual(jm(f.commands.filter(c => c.kind === 'party-match-answer')), [{ kind: 'party-match-answer', a: 40, b: 50, answer: 1 }], state);
  }
});

test('alt account applies again when the main never answered its application', () => {
  const f = joinMainFixture({ rows: [{ id: 7, name: 'MainChar', members: 2, type: 1, min: 1, max: 90 }] });
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.gp.partyMatching = { ...f.World.gp.partyMatching, joining: { id: 7 } };
  f.advance(10000); f.Controller.tick(); assert.equal(f.commands.length, 1, 'still waiting for the answer');
  f.advance(25000); f.Controller.tick(); assert.deepEqual(jm(f.commands[1]), { kind: 'party-match-page', page: 1 }, 'the board is read again first');
  f.advance(500); f.Controller.tick(); assert.deepEqual(jm(f.commands[2]), { kind: 'party-match-join', id: 7 });
});

test('alt account reads the board again before applying again, so it follows a listing the main registered anew', () => {
  const f = joinMainFixture({ rows: [{ id: 7, name: 'MainChar', members: 2, type: 1, min: 1, max: 90 }] });
  f.Controller.tick(); assert.deepEqual(jm(f.commands.at(-1)), { kind: 'party-match-join', id: 7 });
  f.World.gp.partyMatching = { ...f.World.gp.partyMatching, pending: null, joining: { name: 'MainChar' }, result: 2 };
  f.advance(31000); f.Controller.tick();
  assert.deepEqual(jm(f.commands.at(-1)), { kind: 'party-match-page', page: 1 }, 'the old listing number is not used again');
  assert.match(f.Party.joinMessage, /again/);
  f.World.gp.partyMatching = { ...f.World.gp.partyMatching, pending: null, joining: null, result: null, rows: [{ id: 9, name: 'MainChar', members: 2, type: 1, min: 1, max: 90 }] };
  f.advance(500); f.Controller.tick();
  assert.deepEqual(jm(f.commands.at(-1)), { kind: 'party-match-join', id: 9 });
  assert.equal(f.commands.filter(c => c.kind === 'party-match-join' && c.id === 7).length, 1);
});

test('alt account pages the board until it finds the main, then rests', () => {
  const f = joinMainFixture({ pages: 2, rows: [{ id: 3, name: 'Other', members: 1, type: 0, min: 1, max: 90 }] });
  f.Controller.tick(); assert.deepEqual(jm(f.commands[0]), { kind: 'party-match-page', page: 1 });
  f.advance(3000); f.World.gp.partyMatching = { ...f.World.gp.partyMatching, page: 2 };
  f.Controller.tick(); assert.deepEqual(jm(f.commands[1]), { kind: 'party-match-page', page: 2 });
  f.advance(3000); f.World.gp.partyMatching = { ...f.World.gp.partyMatching, page: 2 };
  f.Controller.tick(); assert.equal(f.commands.length, 2); assert.match(f.Party.joinMessage, /No listing/);
});

test('alt account accepts the main invitation only, and never leaves another party', () => {
  const f = joinMainFixture();
  f.World.ents.set(55, { gid: 55, kind: 'player', name: 'Stranger' });
  f.World.gp.social.invitation = { type: 2, gid: 55, options: 1 };
  f.Controller.tick(); assert.ok(!f.commands.some(c => c.kind === 'social-consent'));
  f.World.ents.set(56, { gid: 56, kind: 'player', name: 'MainChar' });
  f.World.gp.social.invitation = { type: 2, gid: 56, options: 1 };
  f.Controller.tick(); assert.deepEqual(jm(f.commands.find(c => c.kind === 'social-consent')), { kind: 'social-consent', accept: true });
  const g = joinMainFixture({ rows: [{ id: 7, name: 'MainChar', members: 1, type: 1, min: 1, max: 90 }] });
  g.World.gp.social.members = [{ id: 1, name: 'AltChar' }, { id: 2, name: 'Friend' }];
  g.Controller.tick(); assert.equal(g.commands.length, 0);
});

test('alt account stays out of the main party when it is full or the level is out of range', () => {
  const f = joinMainFixture({ rows: [{ id: 7, name: 'MainChar', members: 4, type: 0, min: 1, max: 90 }] });
  f.Controller.tick(); assert.equal(f.commands.length, 0); assert.match(f.Party.joinMessage, /full/);
  const g = joinMainFixture({ rows: [{ id: 7, name: 'MainChar', members: 1, type: 0, min: 80, max: 90 }] });
  g.World.gp.progression = { level: 20 }; g.Controller.tick(); assert.equal(g.commands.length, 0); assert.match(g.Party.joinMessage, /outside/);
});

test('party matching is opt-in and accepts once while hunting is stopped', () => {
  const f = fixture(); assert.equal(f.Settings.profile.party.autoAcceptMatching, false);
  partyApplication(f); f.Settings.profile.party.autoAcceptMatching = false;
  f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.Settings.profile.party.autoAcceptMatching = true; f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands[0])), { kind: 'party-match-answer', a: 40, b: 50, answer: 1 });
  f.advance(1000); f.Controller.tick(); assert.equal(f.commands.length, 1); assert.equal(f.Hunt.running, false);
});

test('party matching permits first applicant but never approves for another leader', () => {
  const f = fixture(), m = partyApplication(f);
  f.World.gp.social.leader = 99; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.gp.social = { leader: 0, self: 0, options: 0, members: [] };
  f.Controller.tick(); assert.equal(f.commands[0].answer, 1);
});

test('party matching respects four and eight member capacity', () => {
  for (const [options, capacity] of [[0, 4], [1, 8]]) {
    const f = fixture(); partyApplication(f); f.World.gp.social.options = options;
    f.World.gp.social.members = Array.from({ length: capacity }, (_, id) => ({ id }));
    f.Controller.tick(); assert.equal(f.commands.length, 0);
    f.World.gp.social.members.pop(); f.Controller.tick(); assert.equal(f.commands.length, 1);
  }
});

test('shared EXP accepts successive applicants past four through eight without toggling', () => {
  for (const options of [1, 3, 5, 7]) for (const autoRecruit of [false, true]) {
    const f = fixture(); partyApplication(f);
    Object.assign(f.Settings.profile.party, { autoRecruit, autoAcceptMatching: !autoRecruit });
    let members = [{ id: 10 }];
    const own = { id: 5, type: options };
    for (let size = 1; size <= 8; size++) {
      const request = { a: 40, b: 50 + size, expires: f.World.simNow() + 10000, member: { name: 'Applicant' + size } };
      // Fresh native-style snapshots, including consecutive requests where the
      // bot never observes the intervening request:null acknowledgement.
      f.World.applyGameplay({ ...f.World.gp,
        social: { self: 10, leader: 10, options, members },
        partyMatching: { own, pending: null, request } });
      f.Controller.tick(); f.Controller.tick();
      assert.equal(f.commands.length, Math.min(size, 7), `options=${options}, recruit=${autoRecruit}, members=${size}`);
      if (size < 8) {
        assert.equal(f.commands.at(-1).b, request.b);
        members = [...members, { id: 100 + size }];
      }
      f.advance(500);
    }
    assert.equal(f.commands.every(c => c.kind === 'party-match-answer' && c.answer === 1), true);
  }
});

test('shared EXP resumes accepting after a full party loses a member', () => {
  const f = fixture(); partyApplication(f);
  f.Settings.profile.party.autoAcceptMatching = false; f.Settings.profile.party.autoRecruit = true;
  const social = { self: 10, leader: 10, options: 3, members: Array.from({ length: 8 }, (_, n) => ({ id: 10 + n })) };
  const matching = { ...f.World.gp.partyMatching, own: { id: 5, type: 3 }, pending: null };
  f.World.applyGameplay({ ...f.World.gp, social, partyMatching: matching });
  f.Controller.tick(); assert.equal(f.commands.length, 0);
  assert.match(f.Party.message, /Party full/);
  f.advance(500);
  f.World.applyGameplay({ ...f.World.gp, social: { ...social, members: social.members.slice(0, 7) },
    partyMatching: { ...matching, request: { ...matching.request, b: 99, expires: f.World.simNow() + 10000 } } });
  f.Controller.tick(); assert.equal(f.commands.length, 1); assert.equal(f.commands[0].b, 99);
  assert.match(f.Party.message, /accepting applicants/);
});

test('native party sharing controls capacity even when saved recruitment settings differ', () => {
  for (const options of [0, 1]) {
    const f = fixture(); partyApplication(f);
    Object.assign(f.Settings.profile.party, { autoRecruit: true, expShare: !options });
    f.World.gp.social.options = options;
    f.World.gp.social.members = Array.from({ length: 5 }, (_, n) => ({ id: 10 + n }));
    f.Controller.tick(); assert.equal(f.commands.length, options ? 1 : 0);
  }
});

test('party matching leaves invitations and expired or unclocked requests alone', () => {
  const f = fixture(), m = partyApplication(f), request = m.request;
  m.request = null; f.World.gp.social.invitation = { type: 2, gid: 99 };
  f.Controller.tick(); assert.equal(f.commands.length, 0);
  m.request = request; f.World.simOffset = null; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.simOffset = 0; request.expires = 100000; f.Controller.tick(); assert.equal(f.commands.length, 0);
  request.expires = 110000; f.World.phase = 'login'; f.Controller.tick(); assert.equal(f.commands.length, 0);
});

test('party matching retries failed dispatch and correlates replacement requests', () => {
  const f = fixture(), m = partyApplication(f), raw = f.Cmd.raw;
  f.Cmd.raw = () => false; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.Cmd.raw = raw; f.Controller.tick(); assert.equal(f.commands.length, 1);
  m.request = { ...m.request, b: 51 }; f.advance(300); f.Controller.tick();
  assert.equal(f.commands.length, 2); assert.equal(f.commands[1].b, 51);
  m.request = { ...m.request, b: 52 }; f.Settings.profile.party.autoAcceptMatching = false;
  f.advance(300); f.Controller.tick(); assert.equal(f.commands.length, 2);
});

test('a live application is accepted even when the local listing record is missing', () => {
  // Seen in the field: after the first member joined and left, the server still routed applications to the
  // bot while its own-listing record was empty, so every later application was ignored.
  for (const autoRecruit of [false, true]) {
    const f = fixture(); f.Settings.profile.party.autoAcceptMatching = true; f.Settings.profile.party.autoRecruit = autoRecruit;
    f.Settings.profile.party.expShare = false; f.Settings.profile.party.itemShare = false;
    const solo = { self: 0, leader: 0, options: 0, members: [] };
    const request = { a: 40, b: 50, expires: f.World.simNow() + 10000, member: { name: 'Applicant' } };
    f.World.applyGameplay({ ...f.World.gp, social: solo, partyMatching: { own: null, pending: null, request, result: 2 } });
    f.Controller.tick();
    assert.equal(f.commands.filter(c => c.kind === 'party-match-answer').length, 1, 'autoRecruit=' + autoRecruit);
    assert.equal(f.Diagnostics.party().includes('listing missing'), false);
    // Still refused when someone else leads, the party is full, or the deadline has passed.
    const g = fixture(); g.Settings.profile.party.autoAcceptMatching = true;
    g.World.applyGameplay({ ...g.World.gp, social: { self: 10, leader: 99, options: 1, members: [{ id: 10 }] }, partyMatching: { own: null, pending: null, request } });
    g.Controller.tick(); assert.equal(g.commands.length, 0);
    g.World.applyGameplay({ ...g.World.gp, social: { self: 10, leader: 10, options: 0, members: Array.from({ length: 4 }, (_, n) => ({ id: 10 + n })) }, partyMatching: { own: null, pending: null, request } });
    g.Controller.tick(); assert.equal(g.commands.length, 0);
    g.World.applyGameplay({ ...g.World.gp, social: { self: 10, leader: 10, options: 1, members: [{ id: 10 }] }, partyMatching: { own: null, pending: null, request: { ...request, expires: g.World.simNow() - 1 } } });
    g.Controller.tick(); assert.equal(g.commands.length, 0);
  }
});
test('resurrection offers are accepted only from party members while dead, never mutation offers', () => {
  const setup = (change = {}) => {
    const f = fixture(); f.Settings.profile.party.acceptRes = true; f.World.isDead = () => true;
    f.World.ents.set(77, { gid: 77, kind: 'player', name: 'Healer' }); f.World.ents.set(78, { gid: 78, kind: 'player', name: 'Stranger' });
    f.World.gp.social = { localName: 'Me', self: 10, leader: 10, options: 1, members: [{ id: 10, name: 'Me' }, { id: 11, name: 'Healer' }], resurrection: { gid: 77 }, ...change };
    return f;
  };
  const answers = f => f.commands.filter(c => c.kind === 'resurrection-consent');
  let f = setup(); assert.equal(f.Hunt.running, false); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(answers(f))), [{ kind: 'resurrection-consent', accept: true }], 'answered with hunting stopped');
  f = setup({ resurrection: { gid: 78 } }); f.Controller.tick(); assert.equal(answers(f).length, 0);
  f = setup({ resurrection: { gid: 77, mutation: true } }); f.Controller.tick(); assert.equal(answers(f).length, 0);
  f = setup({ resurrection: { gid: 999 } }); f.Controller.tick(); assert.equal(answers(f).length, 0);
  f = setup(); f.World.isDead = () => false; f.Controller.tick(); assert.equal(answers(f).length, 0);
  f = setup(); f.Settings.profile.party.acceptRes = false; f.Controller.tick(); assert.equal(answers(f).length, 0);
  f = setup(); f.Hunt.start(); f.Controller.tick(); assert.equal(answers(f).length, 1, 'also answered while hunting is stopped by death handling');
});
test('gameplay mirror exposes party matching requests and clears answered requests', () => {
  const f = fixture(), m = partyApplication(f);
  f.World.applyGameplay({ ...f.World.gp, partyMatching: m }); f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { ...m, request: null } });
  f.advance(300); f.Controller.tick(); assert.equal(f.commands.length, 1);
});
function recruiting(f) {
  f.Settings.profile.party.autoRecruit = true;
  f.World.gp.progression.level = 30;
  f.World.gp.social = { self: 0, leader: 0, options: 0, members: [] };
  f.World.gp.partyMatching = { own: null, request: null, pending: null };
  return f.World.gp.partyMatching;
}
test('auto-recruit registers saved settings while hunting is stopped', () => {
  const f = fixture(); assert.equal(f.Settings.profile.party.autoRecruit, false); recruiting(f);
  Object.assign(f.Settings.profile.party, { title: 'My party', min: 20, max: 40, itemShare: false });
  f.Controller.tick(); assert.equal(f.Hunt.running, false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands[0])), { kind: 'party-match-register', registration: { party: 0, type: 1, purpose: 0, min: 20, max: 40, title: 'My party' } });
});
test('auto-recruit preserves existing listings and existing party sharing options', () => {
  const f = fixture(), m = recruiting(f); m.own = { id: 5, type: 0 };
  f.Controller.tick(); assert.equal(f.commands.length, 0);
  m.own = null; f.World.gp.social = { self: 10, leader: 10, options: 6, members: [{ id: 10 }] };
  f.Controller.tick(); assert.equal(f.commands[0].registration.type, 6);
});
test('auto-recruit waits for confirmation without duplicate or blind repeat registrations', () => {
  const f = fixture(), m = recruiting(f); f.Controller.tick();
  f.advance(1000); m.pending = 'register'; f.Controller.tick();
  f.advance(60000); m.pending = null; m.result = 9; f.Controller.tick();
  assert.equal(f.commands.length, 1);
});
test('auto-recruit recovers a refused registration from fresh idle state without toggling', () => {
  const f = fixture(); recruiting(f); f.Controller.tick();
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { ...f.World.gp.partyMatching, pending: 'register' } });
  f.advance(1000); f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { ...f.World.gp.partyMatching, pending: null, result: 9 } });
  f.advance(28900); f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.advance(100); f.Controller.tick(); assert.equal(f.commands.length, 2);
  assert.equal(f.Settings.profile.party.autoRecruit, true); assert.equal(f.Hunt.running, false);
  f.Controller.tick(); assert.equal(f.commands.length, 2);
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { ...f.World.gp.partyMatching, own: { id: 5, type: 1 }, pending: null } });
  f.advance(60000); f.Controller.tick(); assert.equal(f.commands.length, 2);
  assert.equal(f.Party.registration, null);
});
test('auto-recruit retry waits for fresh explicitly idle matching state and preserves pending requests', () => {
  const f = fixture(); recruiting(f); f.Controller.tick(); f.advance(60000);
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  for (const change of [{ pending: 'register' }, { pending: 'page' }, { pending: undefined }, { own: undefined, pending: null },
      { pending: null, request: { a: 1, b: 2 } }, { pending: null, joining: { name: 'Other' } }]) {
    f.World.applyGameplay({ ...f.World.gp, partyMatching: { own: null, pending: null, request: null, ...change } });
    f.Controller.tick(); assert.equal(f.commands.length, 1);
  }
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { own: null, pending: null, request: null } });
  f.Controller.tick(); assert.equal(f.commands.length, 2);
});
test('auto-recruit keeps retrying at thirty-second intervals while enabled and stops when disabled', () => {
  const f = fixture(); recruiting(f); f.Controller.tick();
  for (let attempt = 2; attempt <= 4; attempt++) {
    f.World.applyGameplay({ ...f.World.gp, partyMatching: { own: null, pending: null, request: null, result: 9 } });
    f.advance(30000); f.Controller.tick(); assert.equal(f.commands.length, attempt);
    for (let tick = 0; tick < 10; tick++) f.Controller.tick();
    assert.equal(f.commands.length, attempt);
  }
  f.Settings.profile.party.autoRecruit = false;
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { own: null, pending: null, request: null } });
  f.advance(60000); f.Controller.tick(); assert.equal(f.commands.length, 4);
});
test('auto-recruit revalidates leadership, capacity and settings before retrying registration', () => {
  const f = fixture(); recruiting(f); f.Controller.tick(); f.advance(30000);
  f.World.applyGameplay({ ...f.World.gp, partyMatching: { own: null, pending: null, request: null } });
  f.World.gp.social = { self: 10, leader: 20, options: 1, members: [{ id: 10 }] };
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.gp.social.leader = 10; f.World.gp.social.members = Array(8).fill({ id: 10 });
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.gp.social.members.pop(); f.Settings.profile.party.title = '';
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.Settings.profile.party.title = 'Recovered party'; f.Controller.tick();
  assert.equal(f.commands.length, 2); assert.equal(f.commands[1].registration.title, 'Recovered party');
});
test('auto-recruit restores a confirmed listing after it disappears and space opens', () => {
  const f = fixture(), m = recruiting(f); f.Controller.tick();
  m.own = { id: 5, type: 1 }; f.Controller.tick();
  f.World.gp.social = { self: 10, leader: 10, options: 1, members: Array(8).fill({ id: 10 }) };
  m.own = null; f.advance(31000); f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.gp.social.members.pop(); f.Controller.tick(); assert.equal(f.commands.length, 2);
});
test('auto-recruit accepts matching applicants without requiring the separate accept switch', () => {
  const f = fixture(), m = recruiting(f); m.own = { id: 5, type: 1 };
  m.request = { a: 40, b: 50, expires: 110000, member: { name: 'Applicant' } };
  f.Controller.tick(); assert.equal(f.commands[0].kind, 'party-match-answer');
  f.Settings.profile.party.autoRecruit = false; m.request.b++; f.advance(500); f.Controller.tick(); assert.equal(f.commands.length, 1);
});
test('auto-recruit skips non-leaders, low level, pending matching and invalid listing settings', () => {
  const f = fixture(), m = recruiting(f);
  f.World.gp.social = { self: 10, leader: 20, options: 1, members: [{ id: 10 }] }; f.Controller.tick();
  f.World.gp.social = { self: 0, leader: 0, options: 0, members: [] };
  f.World.gp.progression.level = 4; f.Controller.tick(); f.World.gp.progression.level = 30;
  m.pending = 'join'; f.Controller.tick(); m.pending = null;
  f.Settings.profile.party.title = ''; f.Controller.tick(); f.Settings.profile.party.title = 'Test';
  f.Settings.profile.party.min = 60; f.Settings.profile.party.max = 30; f.Controller.tick();
  assert.equal(f.commands.length, 0);
});
test('auto-recruit validates listing purpose against job suit', () => {
  const f = fixture(); recruiting(f); f.Settings.profile.party.purpose = 2;
  f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.gp.inventory = [{ slot: 8, typeFlags: (1 << 11) | 0x3ac }];
  f.Controller.tick(); assert.equal(f.commands[0].registration.purpose, 2);
});
function resurrection(f) {
  f.Settings.profile.party.autoRes = true;
  f.World.gp.social = { localName: 'Me', self: 10, leader: 10, options: 1, members: [{ id: 10, name: 'Me' }, { id: 11, name: 'Mate', status: 0 }] };
  f.World.gp.skills = [10067];
  f.World.rebuildCatalog([{ id: 10067, group: 638, level: 1, name: 'Rebirth', targetRequired: true, targets: 178, masteries: [{ ID: 518, Level: 10 }] }]);
  f.World.ents.set(50, { gid: 50, kind: 'player', name: 'Mate', regionId: 1, x: 110, y: 0, z: 100, appearanceState: [2, 0, 0] });
  return f.World.gp.social.members[1];
}
function resurrectionTravel() {
  const f = fixture(); resurrection(f); f.Hunt.start();
  Object.assign(f.World.skill(10067), { range: 100, actionMs: 1000 });
  f.World.ents.get(50).x = 350; return f;
}
// Party support: Tank at 40% HP and Mage at 90% (party status low nibble = HP tenths), both in view within 30 m.
function support(f) {
  f.World.gp.social = { localName: 'Me', self: 10, leader: 10, options: 1, members: [{ id: 10, name: 'Me' }, { id: 11, name: 'Tank', status: 0x54 }, { id: 12, name: 'Mage', status: 0x99 }] };
  f.World.gp.skills = [2001, 2002, 2003];
  f.World.rebuildCatalog([
    { id: 2001, group: 900, level: 1, name: 'Heal', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2002, group: 901, level: 1, name: 'Guard', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2003, group: 902, level: 1, name: 'Healing circle', targetRequired: false, targets: 1 },
  ]);
  f.World.ents.set(60, { gid: 60, kind: 'player', name: 'Tank', regionId: 1, x: 150, y: 0, z: 100, appearanceState: [0, 0, 0] });
  f.World.ents.set(61, { gid: 61, kind: 'player', name: 'Mage', regionId: 1, x: 160, y: 0, z: 100, appearanceState: [0, 0, 0] });
  const c = f.Settings.profile.party.support;
  f.Hunt.start(); f.commands.length = 0;
  return c;
}
const casts = f => f.commands.filter(c => c.kind === 'select' || c.kind === 'skill').map(c => c.kind === 'select' ? 'select ' + c.gid : 'skill ' + c.skillId + ' ' + (c.gid ?? 'none'));
test('party support is off by default, then heals the lowest member in range before anything else', () => {
  const f = fixture(), c = support(f);
  assert.equal(c.enabled, false); c.heal = { id: 2001, group: 900, pct: 60, self: false }; c.buffs = [{ id: 2002, group: 901 }];
  f.Controller.tick(); assert.deepEqual(casts(f), [], 'off by default');
  c.enabled = true; f.advance(1000); f.Controller.tick();
  assert.deepEqual(casts(f), ['select 60', 'skill 2001 60'], 'Tank at 40% is healed before any buff');
  assert.equal(f.Controller.mode, 'party support');
  f.World.gp.social.members[1].status = 0x5a; f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 60', 'skill 2002 60'], 'healed: now the buff, Tank first');
  f.World.gp.attachedEffects = [{ gid: 60, skill: 2002, token: 1 }]; f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 61', 'skill 2002 61'], 'Tank has it, Mage is next');
  f.World.gp.attachedEffects.push({ gid: 61, skill: 2002, token: 2 }); f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2002 1'], 'party is buffed: the caster gets it last');
  f.World.gp.attachedEffects.push({ gid: 1, skill: 2002, token: 3 }); f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'everyone is buffed');
  assert.match(f.Support.message, /healed and buffed/);
});
test('party buffs honour the member list, back off after two misses and never walk to members', () => {
  const f = fixture(), c = support(f);
  c.enabled = true; f.World.gp.social.members[1].status = 0x5a; c.buffs = [{ id: 2002, group: 901, only: 'mage' }];
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 61', 'skill 2002 61'], 'only Mage is on the list');
  f.commands.length = 0; f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'waits to see the buff on Mage');
  f.advance(5000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 61', 'skill 2002 61'], 'first miss: tried again');
  f.commands.length = 0; f.advance(7000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'second miss: backs off');
  f.advance(30000); f.Controller.tick(); assert.deepEqual(casts(f), []);
  f.advance(31000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 61', 'skill 2002 61'], 'a minute later it tries again');
  f.commands.length = 0; f.World.ents.get(61).x = 600;
  f.advance(10000); f.Controller.tick(); assert.equal(casts(f).length, 0, 'out of range: nothing cast');
  assert.equal(f.commands.some(c => c.kind === 'move' && c.destination?.x === 600), false, 'and no walking to the member');
});
// Tank wears Earth Fire Protection (3001), which the server says Guard (2002) cannot overlap.
function overlapping() {
  const f = fixture(), c = support(f);
  f.World.rebuildCatalog([
    { id: 2001, group: 900, level: 1, name: 'Heal', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2002, group: 901, level: 1, name: 'Guard', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2003, group: 902, level: 1, name: 'Healing circle', targetRequired: false, targets: 1 },
    { id: 3001, group: 950, level: 1, name: 'Earth Fire Protection', targetRequired: true, targets: 1 | 16 | 32 },
  ]);
  c.enabled = true; f.World.gp.social.members[1].status = 0x5a; c.buffs = [{ id: 2002, group: 901 }];
  f.World.gp.attachedEffects = [{ gid: 60, skill: 3001, token: 9 }];
  f.Combat.init(); // as in the game: the refusal notice also blocks the skill for the selected member
  return { f, c };
}
test('a party buff the game refuses as "cannot overlap" skips that member and still reaches the others', () => {
  const { f } = overlapping();
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 60', 'skill 2002 60'], 'Tank first');
  f.World.gp.target = 60; f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' });
  assert.ok(f.Log.lines.some(l => /Tank has a buff that Guard does not stack with; skipping Tank until it ends/.test(l.text)));
  assert.equal(f.Combat.stuck.has('2002:60'), true, 'Combat counts the refusal against Tank, as in the game');
  f.commands.length = 0; f.advance(2000); f.Controller.tick();
  assert.deepEqual(casts(f), ['select 61', 'skill 2002 61'], 'Tank is still selected, but Mage gets the buff');
  assert.equal(f.Combat.stuck.has('2002:60'), false, 'the refusal no longer blocks Guard for self buffs and the rotation');
  f.World.gp.attachedEffects.push({ gid: 61, skill: 2002, token: 2 }); f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2002 1'], 'then the caster');
  f.World.gp.attachedEffects.push({ gid: 1, skill: 2002, token: 3 }); f.commands.length = 0;
  f.advance(60000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'Tank is skipped while it wears Earth Fire Protection');
  assert.match(f.Support.message, /Skipped \(a buff that does not stack\): Tank/);
  assert.equal(f.Log.lines.some(l => /did not show on Tank/.test(l.text)), false, 'no "did not show" warnings for a refused member');
  f.World.gp.attachedEffects = f.World.gp.attachedEffects.filter(e => e.skill !== 3001);
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2002 60'], 'its protection ended: Tank (still selected) is tried again');
});
test('only an overlap refusal right after a party buff marks the member', () => {
  const { f } = overlapping();
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 60', 'skill 2002 60']);
  f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_WRONGDISTANCE' });
  assert.equal(f.Support.overlaps.size, 0, 'another refusal is not an overlap');
  Object.assign(f.Combat, { lastCastId: 2003, lastCastGid: 0 }); f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' });
  assert.equal(f.Support.overlaps.size, 0, 'another skill was cast after the party buff: the refusal is not ours');
  f.Support.reset(); f.commands.length = 0; f.advance(60000); f.Controller.tick();
  f.advance(3000); f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' });
  assert.equal(f.Support.overlaps.size, 0, 'too late to belong to the party buff');
  f.Support.reset(); f.commands.length = 0; f.advance(60000); f.Controller.tick();
  f.bus.emit('notice', { key: 'UIIT_STT_SKILL_USE_FAIL_OVERLAP_COUNT' });
  assert.equal(f.Support.overlaps.size, 1, 'too many buffs on the member counts as well');
  f.Support.reset(); assert.equal(f.Support.overlaps.size, 0, 'a reset forgets it');
});
test('a member refused without a visible buff to wait for is tried again after a minute', () => {
  const { f } = overlapping();
  f.World.gp.attachedEffects = [];
  f.advance(1000); f.Controller.tick(); f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' });
  f.World.gp.attachedEffects = [{ gid: 61, skill: 2002, token: 2 }, { gid: 1, skill: 2002, token: 3 }]; f.commands.length = 0;
  f.advance(30000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'skipped for now');
  f.advance(31000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 60', 'skill 2002 60'], 'tried again a minute later');
});
test('a heal refused for one member still goes to another low member', () => {
  const f = fixture(), c = support(f);
  c.enabled = true; c.heal = { id: 2001, group: 900, pct: 95, self: false }; f.Combat.init();
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 60', 'skill 2001 60'], 'Tank at 40% first');
  f.World.gp.target = 60; f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_WRONGDISTANCE' });
  f.commands.length = 0; f.advance(2000); f.Controller.tick();
  assert.deepEqual(casts(f), ['select 61', 'skill 2001 61'], 'Tank is blocked for now, Mage at 90% is healed');
});
// Party buff Guard (2002) on Tank only, a worn blade (one-handed) and a harp in the bag.
function partyGear() {
  const f = fixture(), c = support(f), gp = f.World.gp;
  const weapon = (slot, ref, sub) => ({ slot, refObjId: ref, typeFlags: (sub << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 });
  gp.inventory = [weapon(6, 100, 3), weapon(13, 300, 14)];
  Object.assign(f.World.skill(2002), { admit: { weaponKinds: [14, 255] }, actionMs: 1000 });
  f.Settings.profile.macro.buffSwap = true; f.BuffGear.init();
  c.enabled = true; gp.social.members[1].status = 0x5a; c.buffs = [{ id: 2002, group: 901, only: 'tank' }];
  const at = s => gp.inventory.find(i => i.slot === s)?.refObjId, worn = [];
  const cast = f.Combat.cast.bind(f.Combat); f.Combat.cast = (id, ...a) => { worn.push([id, at(6)]); return cast(id, ...a); };
  const drive = () => {
    for (let n = 0; n < 80; n++) {
      f.advance(300); f.Controller.tick();
      const p = f.BuffGear.run?.pending;
      if (p) { const from = gp.inventory.find(i => i.slot === p.source), to = gp.inventory.find(i => i.slot === p.destination); from.slot = p.destination; if (to) to.slot = p.source; }
      if (f.BuffGear.run?.cast && !f.BuffGear.run.cast.accepted) f.bus.emit('cast', { caster: 1, skill: f.BuffGear.run.cast.id });
      if (!f.BuffGear.run) return;
    }
    throw Error('the party buff swap did not finish');
  };
  return { f, c, gp, at, worn, drive };
}
test('a party buff that needs another weapon is cast after a swap, then the weapon comes back', () => {
  const { f, at, worn, drive } = partyGear();
  f.advance(1000); f.Controller.tick();
  assert.ok(f.BuffGear.run?.party, 'the harp swap starts'); assert.match(f.Support.message, /Guard on Tank: changing weapons/);
  drive();
  assert.deepEqual(worn, [[2002, 300]], 'Guard is cast with the harp');
  assert.deepEqual(casts(f), ['select 60', 'skill 2002 60']);
  assert.equal(at(6), 100, 'the blade is back'); assert.equal(f.Hunt.running, true);
  f.World.gp.attachedEffects = [{ gid: 60, skill: 2002, token: 1 }]; f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.equal(f.BuffGear.run, null, 'Tank has it: no more swaps'); assert.deepEqual(casts(f), []);
});
test('a party buff swap ends at once when the member cannot take the buff', () => {
  const { f, gp, at } = partyGear();
  f.advance(1000); f.Controller.tick(); assert.ok(f.BuffGear.run?.party);
  let after = -1;
  for (let n = 0; n < 80 && f.BuffGear.run; n++) {
    f.advance(300); f.Controller.tick();
    const p = f.BuffGear.run?.pending;
    if (p) { const from = gp.inventory.find(i => i.slot === p.source), to = gp.inventory.find(i => i.slot === p.destination); from.slot = p.destination; if (to) to.slot = p.source; }
    if (after >= 0) after++;
    else if (f.BuffGear.run?.cast) { f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' }); after = 0; }
  }
  assert.equal(f.BuffGear.run, null, 'the swap is over');
  assert.ok(after >= 0 && after <= 10, `the gear came back within 3 s of the refusal (took ${after} ticks), not after the 10 s cast wait`);
  assert.equal(at(6), 100, 'the blade is back'); assert.equal(f.Hunt.running, true);
  assert.ok(f.Log.lines.some(l => /Tank has a buff that Guard does not stack with/.test(l.text)));
  f.commands.length = 0; f.advance(5000); f.Controller.tick();
  assert.equal(f.BuffGear.run, null, 'no new swap for Tank'); assert.deepEqual(casts(f), []);
});
test('a party buff can wear the secondary weapon while hunting is stopped, then the primary comes back', () => {
  const { f, c, gp, at, worn, drive } = partyGear();
  gp.inventory.push({ slot: 14, refObjId: 200, typeFlags: (15 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 });
  f.World.skill(2002).admit = null; f.Hunt.running = false; c.whileStopped = true;
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 100)));
  f.ItemRules.setGear('secondaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 200)));
  c.buffs[0].gear = 'secondary';
  f.advance(1000); f.Controller.tick(); drive();
  assert.deepEqual(worn, [[2002, 200]], 'cast with the secondary staff');
  assert.equal(at(6), 100, 'then the primary blade'); assert.equal(f.Hunt.running, false);
});
// Run a weapon change for buffs to its end. Each cast shows on its target unless show(command) says otherwise.
function batch(f, gp, show = () => true) {
  let seen = 0;
  for (let n = 0; n < 500; n++) {
    f.advance(300); f.Controller.tick();
    const p = f.BuffGear.run?.pending;
    if (p) { const from = gp.inventory.find(i => i.slot === p.source), to = gp.inventory.find(i => i.slot === p.destination); from.slot = p.destination; if (to) to.slot = p.source; }
    const skills = f.commands.filter(c => c.kind === 'skill');
    for (; seen < skills.length; seen++) {
      const s = skills[seen];
      if (show(s, n)) gp.attachedEffects = [...(gp.attachedEffects || []), { gid: s.gid || 1, skill: s.skillId, token: 100 + seen }];
    }
    if (!f.BuffGear.run) return;
  }
  throw Error('the weapon change for buffs did not finish');
}
const gearMoves = f => f.commands.filter(c => c.kind === 'inventory-move').length;
test('one weapon change casts a party buff on every member that needs it, then the weapon comes back once', () => {
  const { f, c, gp, at, worn } = partyGear();
  delete c.buffs[0].only;
  f.advance(1000); f.Controller.tick(); assert.ok(f.BuffGear.run?.party);
  batch(f, gp);
  assert.deepEqual(worn, [[2002, 300], [2002, 300], [2002, 300]], 'Tank, Mage and the caster, all with the harp');
  assert.deepEqual(casts(f), ['select 60', 'skill 2002 60', 'select 61', 'skill 2002 61', 'skill 2002 1']);
  assert.equal(gearMoves(f), 2, 'the harp goes on once and the blade comes back once');
  assert.equal(at(6), 100);
  f.commands.length = 0; f.advance(5000); f.Controller.tick();
  assert.equal(f.BuffGear.run, null, 'everyone has it: no second change'); assert.deepEqual(casts(f), []);
});
test('a party buff with less than a minute left is renewed in the same weapon change, a longer one is not', () => {
  for (const [left, renewed] of [[30000, true], [120000, false]]) {
    const { f, c, gp, worn } = partyGear();
    delete c.buffs[0].only;
    const at = f.World.simNow();
    gp.attachedEffects = [{ gid: 61, skill: 2002, token: 7, remainingMs: left, receivedAtMs: at }, { gid: 1, skill: 2002, token: 8, remainingMs: 600000, receivedAtMs: at }];
    f.advance(1000); f.Controller.tick(); batch(f, gp);
    assert.equal(casts(f).includes('skill 2002 61'), renewed, `Mage with ${left / 1000} s left`);
    assert.equal(worn.length, renewed ? 2 : 1); assert.equal(gearMoves(f), 2);
  }
});
test('a member who cannot take the party buff does not end the weapon change for the others', () => {
  const { f, c, gp, worn } = partyGear(); f.Combat.init();
  delete c.buffs[0].only;
  f.advance(1000); f.Controller.tick();
  let refused = false;
  batch(f, gp, s => {
    if (s.gid !== 60 || refused) return true;
    refused = true; f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' }); return false;
  });
  assert.deepEqual(casts(f).filter(x => x.startsWith('skill')), ['skill 2002 60', 'skill 2002 61', 'skill 2002 1'], 'Mage and the caster still get it');
  assert.equal(worn.length, 3); assert.equal(gearMoves(f), 2);
  assert.equal(f.Support.overlaps.has('Tank:901'), true);
});
test('your own buff on the same gear with less than a minute left is cast during a party buff weapon change', () => {
  const { f, gp, worn } = partyGear();
  f.World.rebuildCatalog([
    { id: 2001, group: 900, level: 1, name: 'Heal', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2002, group: 901, level: 1, name: 'Guard', targetRequired: true, targets: 1 | 16 | 32, actionMs: 1000, admit: { weaponKinds: [14, 255] } },
    { id: 2003, group: 902, level: 1, name: 'Healing circle', targetRequired: false, targets: 1 },
    { id: 2004, group: 904, level: 1, name: 'Song', targetRequired: false, targets: 1, actionMs: 1000, durationMs: 600000, admit: { weaponKinds: [14, 255] } },
  ]);
  gp.skills = [2001, 2002, 2003, 2004];
  gp.buffSlots = [{ state: 'active', effect: { gid: 1, skill: 2004, remainingMs: 40000, receivedAtMs: f.World.simNow() } }];
  f.Settings.profile.macro.buffs = [{ id: 2004, group: 904, enabled: true }];
  f.advance(1000); f.Controller.tick(); assert.ok(f.BuffGear.run?.party, 'Guard on Tank starts the change');
  batch(f, gp, s => {
    if (s.skillId === 2004) gp.buffSlots = [{ state: 'active', effect: { gid: 1, skill: 2004, remainingMs: 600000, receivedAtMs: f.World.simNow() } }];
    return true;
  });
  assert.deepEqual(worn, [[2002, 300], [2004, 300]], 'Guard on Tank, then your Song with the same harp');
  assert.equal(gearMoves(f), 2);
});
test('an early renewal the game refuses while the member still wears the buff waits for it to run out', () => {
  const { f, c, gp } = partyGear(); f.Combat.init();
  delete c.buffs[0].only;
  const t0 = f.World.simNow();
  gp.attachedEffects = [{ gid: 61, skill: 2002, token: 7, remainingMs: 30000, receivedAtMs: t0 }, { gid: 1, skill: 2002, token: 8, remainingMs: 600000, receivedAtMs: t0 }];
  f.advance(1000); f.Controller.tick();
  batch(f, gp, s => {
    if (s.gid !== 61) return true;
    f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_OVERLAP' }); return false;
  });
  assert.equal(f.Support.early.has('Mage:901'), true, 'Mage still wears Guard: an early renewal it does not take');
  assert.equal(f.Support.overlaps.has('Mage:901'), false, 'not a buff that does not stack');
  gp.attachedEffects = gp.attachedEffects.filter(e => e.gid !== 60);
  f.commands.length = 0; f.advance(1000); f.Controller.tick(); batch(f, gp);
  assert.deepEqual(casts(f).filter(x => x.startsWith('skill')), ['skill 2002 60'], 'the next change does not try Mage early again');
  assert.equal(f.Combat.stuck.has('2002:61'), false, "Combat's block from the refused renewal is lifted");
  const mage = gp.attachedEffects.find(e => e.gid === 61);
  Object.assign(mage, { remainingMs: 2000, receivedAtMs: f.World.simNow() });
  f.commands.length = 0; f.advance(500); f.Controller.tick();
  assert.equal(f.BuffGear.run, null, 'with 2 s left and still worn, it is not tried again'); assert.deepEqual(casts(f), []);
  gp.attachedEffects = gp.attachedEffects.filter(e => e.gid !== 61);
  f.commands.length = 0; f.advance(1000); f.Controller.tick(); batch(f, gp);
  assert.ok(casts(f).includes('skill 2002 61'), 'once it has run out, Mage gets it again');
  assert.equal(f.Support.early.has('Mage:901'), false);
});
test('a refusal that is not about stacking also moves the weapon change on to the next member at once', () => {
  const { f, c, gp } = partyGear(); f.Combat.init();
  delete c.buffs[0].only;
  f.advance(1000); f.Controller.tick();
  const step = {};
  batch(f, gp, (s, n) => {
    step[s.gid] = n;
    if (s.gid !== 60) return true;
    f.World.gp.target = 60; f.bus.emit('notice', { key: 'UIIT_SKILL_USE_FAIL_WRONGDISTANCE' }); return false;
  });
  assert.ok(step[61] - step[60] < 10, `Mage followed within 3 s of the refusal, not after 10 s (${(step[61] - step[60]) * 0.3} s)`);
  assert.equal(gearMoves(f), 2);
});
test('a long chain of casts that never show stops in time and restores the combat gear normally', () => {
  const { f, c, gp, at } = partyGear();
  delete c.buffs[0].only;
  for (let i = 0; i < 6; i++) {
    gp.social.members.push({ id: 20 + i, name: 'Extra' + i, status: 0x5a });
    f.World.ents.set(70 + i, { gid: 70 + i, kind: 'player', name: 'Extra' + i, regionId: 1, x: 130 + i, y: 0, z: 100, appearanceState: [0, 0, 0] });
  }
  f.advance(1000); f.Controller.tick();
  batch(f, gp, () => false);
  const tried = casts(f).filter(x => x.startsWith('skill')).length;
  assert.ok(tried >= 5 && tried < 9, `some casts, then the time budget (${tried} of 9)`);
  assert.equal(at(6), 100, 'the blade is back'); assert.equal(f.Hunt.running, true, 'hunting goes on');
  assert.equal(f.BuffGear.recovery, null, 'no gear left waiting for a manual restore');
});
test('when hunting stops in the middle, your own queued buffs are dropped and the party buffs still go out', () => {
  const { f, gp, worn } = partyGear();
  f.World.rebuildCatalog([
    { id: 2001, group: 900, level: 1, name: 'Heal', targetRequired: true, targets: 1 | 16 | 32 },
    { id: 2002, group: 901, level: 1, name: 'Guard', targetRequired: true, targets: 1 | 16 | 32, actionMs: 1000, admit: { weaponKinds: [14, 255] } },
    { id: 2003, group: 902, level: 1, name: 'Healing circle', targetRequired: false, targets: 1 },
    { id: 2004, group: 904, level: 1, name: 'Song', targetRequired: false, targets: 1, actionMs: 1000, durationMs: 600000, admit: { weaponKinds: [14, 255] } },
  ]);
  gp.skills = [2001, 2002, 2003, 2004];
  gp.buffSlots = [{ state: 'active', effect: { gid: 1, skill: 2004, remainingMs: 40000, receivedAtMs: f.World.simNow() } }];
  f.Settings.profile.macro.buffs = [{ id: 2004, group: 904, enabled: true }];
  f.Settings.profile.party.support.whileStopped = true;
  f.advance(1000); f.Controller.tick(); assert.ok(f.BuffGear.run?.party);
  f.Hunt.running = false;
  batch(f, gp);
  assert.deepEqual(worn, [[2002, 300]], 'Guard on Tank only: your Song waits for hunting');
  assert.equal(gearMoves(f), 2);
});
test('a party buff that cannot swap now does not hold back the others, and a primary bow keeps its arrows', () => {
  let { f, c, gp, at, worn, drive } = partyGear();
  c.buffs.push({ id: 2001, group: 900, only: 'tank' }); f.BuffGear.blocked = () => true;
  f.advance(1000); f.Controller.tick();
  assert.equal(f.BuffGear.run, null); assert.deepEqual(casts(f), ['select 60', 'skill 2001 60'], 'Heal goes out while Guard waits for its swap');
  ({ f, c, gp, at, worn, drive } = partyGear());
  gp.inventory.push({ slot: 7, refObjId: 500, typeFlags: 108 | (4 << 7) | (1 << 11), quantity: 500 }, { slot: 14, refObjId: 400, typeFlags: (6 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 });
  f.World.skill(2002).admit = null; c.buffs[0].gear = 'primary';
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 400)));
  f.Hunt.running = false; c.whileStopped = true;
  f.advance(1000); f.Controller.tick();
  assert.ok(f.BuffGear.run?.party, 'the bow with its arrows passes the gear checks'); drive();
  assert.deepEqual(worn, [[2002, 400]]); assert.deepEqual([at(6), at(7)], [400, 500]);
});
test('a party buff that ends when the weapon changes back waits ten minutes instead of swapping again', () => {
  const { f, gp, at } = partyGear();
  f.advance(1000); f.Controller.tick();
  for (let n = 0; n < 80 && f.BuffGear.run; n++) {
    f.advance(300); f.Controller.tick();
    const p = f.BuffGear.run?.pending;
    if (p) { const from = gp.inventory.find(i => i.slot === p.source), to = gp.inventory.find(i => i.slot === p.destination); from.slot = p.destination; if (to) to.slot = p.source; }
    if (f.BuffGear.run?.cast) gp.attachedEffects = [{ gid: 60, skill: 2002, token: 1 }];
    if (at(6) === 100) gp.attachedEffects = [];
  }
  assert.equal(f.BuffGear.run, null); assert.equal(at(6), 100);
  assert.ok(f.Support.misses.get('Tank:901').until > f.World.simNow() + 9 * 60000, 'Guard on Tank waits ten minutes');
  assert.ok(f.Log.lines.some(l => /ended when the weapon changed back; trying again in ten minutes/.test(l.text)));
  f.advance(7000); f.Controller.tick(); assert.equal(f.BuffGear.run, null, 'no new swap right away');
});
test('party buffs keep the worn weapon with weapon swapping off, and say when no bag weapon fits', () => {
  let { f, gp, worn } = partyGear();
  f.Settings.profile.macro.buffSwap = false; f.advance(1000); f.Controller.tick();
  assert.equal(f.BuffGear.run, null); assert.deepEqual(worn, [[2002, 100]], 'cast with what is worn, as before');
  ({ f, gp, worn } = partyGear());
  gp.inventory = gp.inventory.filter(i => i.slot !== 13); f.advance(1000); f.Controller.tick();
  assert.equal(f.BuffGear.run, null); assert.deepEqual(worn, []);
  assert.match(f.Support.message, /needs a harp, and none you can use is in your bag/);
});
test('party support group heal, self heal and the stopped switch', () => {
  const f = fixture(), c = support(f);
  c.enabled = true; c.group = { id: 2003, group: 902, pct: 60, count: 2 };
  f.advance(1000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'only Tank is low: one below the count of two');
  f.World.gp.social.members[2].status = 0x93; f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2003 none'], 'two below 60%: the area heal, no target');
  c.group = { id: 0, group: 0, pct: 60, count: 2 }; c.heal = { id: 2001, group: 900, pct: 60, self: true };
  f.World.gp.social.members[1].status = 0x5a; f.World.gp.social.members[2].status = 0x9a;
  f.World.gp.vitals = [{ gid: 1, hp: 30, maxHp: 100, mp: 100, maxMp: 100 }]; f.commands.length = 0;
  f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2001 1'], 'heal myself at 30%');
  f.Hunt.stop(); f.commands.length = 0; f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), [], 'hunting stopped');
  c.whileStopped = true; f.advance(2000); f.Controller.tick(); assert.deepEqual(casts(f), ['skill 2001 1'], 'unless allowed while stopped');
});
test('res travel defaults to 30m, approaches, casts and returns before resuming hunting', () => {
  const f = resurrectionTravel(); assert.equal(f.Settings.profile.party.resRadius, 300);
  f.Controller.tick(); assert.equal(f.Resurrect.trip.phase, 'approach'); assert.equal(f.commands.at(-1).kind, 'move');
  f.advance(1000); f.World.gp.pose.x = 270; f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'skill');
  assert.equal(f.Resurrect.trip.phase, 'cast'); assert.equal(f.Hunt.running, true);
  f.advance(2000); f.Controller.tick(); assert.equal(f.Resurrect.trip.phase, 'return');
  assert.equal(f.commands.at(-1).destination.x, 100);
  f.World.gp.pose.x = 100; f.advance(1000); f.Controller.tick(); assert.equal(f.Resurrect.trip, null); assert.equal(f.Hunt.running, true);
});
test('res radius is anchored to hunt spot and never selects outside it', () => {
  const f = resurrectionTravel(); f.Settings.profile.party.resRadius = 200;
  f.World.gp.pose.x = 340; f.Controller.tick(); assert.equal(f.Resurrect.trip, null);
  assert.equal(f.commands.some(c => c.kind === 'skill' || c.kind === 'select'), false);
  f.World.ents.get(50).x = 250; f.advance(1000); f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'skill');
});
test('res travel uses collision detours and skips blocked bodies with backoff', () => {
  const f = resurrectionTravel(); f.Navigation.plan = () => [];
  f.Controller.tick(); assert.equal(f.Resurrect.trip.phase, 'return');
  f.advance(500); f.Controller.tick(); assert.equal(f.Resurrect.trip, null);
  assert.equal(f.commands.some(c => c.kind === 'skill'), false); assert.ok(f.Resurrect.sent[11] > 100000);
  const g = resurrectionTravel();
  g.Navigation.install(navProduct([{x:0,y:0,z:0,yaw:0,mesh:{vertices:[200,0,0,200,0,200],edges:[0,1,0,65535,3,0]}}]));
  g.Controller.tick(); assert.equal(g.commands.at(-1).kind, 'move'); assert.ok(g.commands.at(-1).destination.z > 100);
});
test('res travel cancels on manual control, stop hotkey and explicit walk-back', () => {
  const f = resurrectionTravel(); f.Controller.tick(); f.Manual.lastAt = 100000;
  f.advance(500); f.Controller.tick(); assert.equal(f.Resurrect.trip, null);
  const g = resurrectionTravel(); g.Hunt.stop(); g.advance(1000); g.Controller.tick(); assert.ok(g.Resurrect.trip);
  g.toggleBot(); assert.equal(g.Resurrect.trip, null); assert.equal(g.Hunt.running, false);
  const h = resurrectionTravel(); h.Controller.tick(); h.advance(1000); h.WalkBack.start(); assert.equal(h.Resurrect.trip, null);
});
test('res travel returns if member revives and does not stall on missing collision coverage', () => {
  const f = resurrectionTravel(); f.Controller.tick(); f.World.gp.pose.x = 180;
  f.World.gp.social.members[1].status = 10; f.World.ents.get(50).appearanceState = [0];
  f.advance(1000); f.Controller.tick(); assert.equal(f.Resurrect.trip.phase, 'return'); assert.equal(f.commands.some(c => c.kind === 'skill'), false);
  const g = resurrectionTravel(); g.Navigation.scene = null; g.Controller.tick(); assert.ok(g.Resurrect.trip);
  g.advance(13000); g.Controller.tick(); assert.equal(g.Resurrect.trip, null);
});
function beginnerScroll(f) {
  f.Settings.profile.potion.speedScroll = true;
  f.World.gp.inventory.push({ slot: 15, refObjId: 24198, typeFlags: 3820, quantity: 2 });
  f.Hunt.start();
}
test('beginner speed scroll is opt-in, uses its exact item and waits for buff confirmation', () => {
  const f = fixture(); assert.equal(f.Settings.profile.potion.speedScroll, false); beginnerScroll(f);
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'item-use'); assert.equal(f.commands.at(-1).slot, 15);
  assert.equal(f.Controller.mode, 'speed scroll'); f.advance(1000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  f.World.gp.buffSlots = [{ state:'active', effect:{gid:1,skill:31107,remainingMs:3600000,receivedAtMs:101000} }];
  f.Controller.tick(); assert.equal(f.SpeedScroll.pending, null); assert.equal(f.SpeedScroll.attempts, 0);
  f.World.gp.buffSlots = []; f.advance(1000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 2);
});
test('speed scroll does not overwrite an existing speed buff or consume paid items', () => {
  const f = fixture(); beginnerScroll(f);
  f.World.gp.attachedEffects = [{gid:1,skill:5411}]; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.gp.attachedEffects = []; f.World.gp.inventory[0].refObjId = 12345; f.advance(1000); f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  f.World.gp.inventory[0].refObjId = 24198; f.World.rebuildCatalog([{id:123,group:123,speedBuff:{active:true}}]);
  f.World.gp.attachedEffects = [{gid:1,skill:123}]; f.Controller.tick(); assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
});
test('speed scroll activates during continuous combat casts after inventory settles', () => {
  const f = fixture(); beginnerScroll(f);
  f.World.gp.casts = [{ caster: 1, receivedAtMs: 100000, results: [] }];
  f.World.gp.inventoryPending = true;
  f.Controller.tick(); assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  f.World.gp.inventoryPending = false;
  f.advance(100); f.Controller.tick();
  assert.equal(f.World.isCasting(), true);
  assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 15).length, 1);
  assert.equal(f.Controller.mode, 'speed scroll');
  f.advance(500); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  f.World.gp.buffSlots = [{ state: 'active', effect: { gid: 1, skill: 31107, remainingMs: 3600000, receivedAtMs: 100600 } }];
  f.Controller.tick(); assert.equal(f.SpeedScroll.pending, null); assert.equal(f.SpeedScroll.attempts, 0);
});
test('emergency potions precede speed scroll without waiting for combat to end', () => {
  const f = fixture(); beginnerScroll(f);
  f.World.gp.casts = [{ caster: 1, receivedAtMs: 100000, results: [] }];
  f.World.gp.inventory.push({ slot: 16, refObjId: 8, typeFlags: 2284, quantity: 50 });
  f.World.gp.vitals = [{ gid: 1, hp: 20, mp: 100, maxHp: 100, maxMp: 100 }];
  f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  assert.equal(f.commands.find(c => c.kind === 'item-use').slot, 16);
  f.advance(300); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 15).length, 1);
  assert.equal(f.World.isCasting(), true);
});
test('speed scroll respects idle, manual, busy inventory, return travel and shop gates', () => {
  for (const change of [f=>f.Hunt.stop(),f=>f.Manual.lastAt=100000,f=>f.World.gp.inventoryPending=true,
    f=>f.World.gp.returnScroll={},f=>f.Restock.activeShop=()=>({})]) {
    const f = fixture(); beginnerScroll(f); change(f); f.commands.length=0; f.Controller.tick();
    assert.equal(f.commands.some(c=>c.kind==='item-use'),false);
  }
});
test('speed scroll explains inventory and potion waits and resumes automatically', () => {
  const f = fixture(); beginnerScroll(f); f.World.gp.inventoryPending = true;
  f.Controller.tick(); assert.match(f.SpeedScroll.message, /inventory transaction/);
  f.World.gp.inventoryPending = false; f.Cmd.last['item-use'] = 100000;
  f.Controller.tick(); assert.match(f.SpeedScroll.message, /potions have priority/);
  assert.equal(f.SpeedScroll.attempts, 0);
  f.advance(300); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 15).length, 1);
});
test('unconfirmed speed activation has bounded backoff even for unlimited starter stacks', () => {
  const f=fixture(); beginnerScroll(f); f.Controller.tick();
  for(let i=0;i<4;i++) { f.advance(9000); f.Controller.tick(); f.advance(90000); f.Controller.tick(); }
  assert.equal(f.commands.filter(c=>c.kind==='item-use').length,3); assert.match(f.SpeedScroll.message,/3 attempts/);
});
test('speed scroll works during return travel and cannot interrupt a resurrection hold', () => {
  const f=fixture(); beginnerScroll(f); f.Hunt.stop(); f.Settings.profile.hunt.center.x=400;
  f.advance(1000); f.WalkBack.start(); f.Controller.tick(); assert.equal(f.commands.at(-1).kind,'item-use');
  const g=fixture(); beginnerScroll(g); g.Resurrect.holdUntil=110000;
  assert.equal(g.SpeedScroll.tick(),false); assert.equal(g.commands.filter(c=>c.kind==='item-use').length,0);
});
function wornWithHammer(f, durability = 4) {
  f.Settings.profile.potion.repairHammer.on = true;
  f.World.gp.inventory.push(
    { slot: 6, refObjId: 900, typeFlags: 44 | (6 << 7), durability, variance: '0', magic: [], tooltip: { fields: { canRepair: 1, varianceIntMin1c0: 10, varianceIntMax1c4: 10 } } },
    { slot: 16, refObjId: 2401, typeFlags: 3820, quantity: 3, codename: 'ITEM_MALL_REPAIR_HAMMER' });
  f.Hunt.start();
}
test('repair hammer is opt-in, used below the durability threshold and confirmed by the repair', () => {
  const f = fixture(); const R = f.Settings.profile.potion.repairHammer; assert.deepEqual([R.on, R.pct], [false, 50]);
  wornWithHammer(f); f.Settings.profile.potion.repairHammer.on = false;
  f.Controller.tick(); assert.equal(f.commands.some(c => c.kind === 'item-use'), false, 'off by default');
  f.Settings.profile.potion.repairHammer.on = true; f.Controller.tick();
  assert.equal(f.commands.at(-1).kind, 'item-use'); assert.equal(f.commands.at(-1).slot, 16);
  assert.equal(f.Controller.mode, 'repair hammer');
  f.advance(1000); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1, 'waits for the repair');
  f.World.gp.inventory.find(i => i.slot === 6).durability = 10; f.Controller.tick();
  assert.equal(f.RepairHammer.pending, null); assert.equal(f.RepairHammer.attempts, 0); assert.match(f.RepairHammer.message, /fine/);
  f.advance(10000); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
});
test('repair hammer waits for real wear, a hammer in the bag and hunting', () => {
  const f = fixture(); wornWithHammer(f, 6); f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false, '60% is above 50%');
  const g = fixture(); wornWithHammer(g); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 16);
  g.Controller.tick(); assert.equal(g.commands.some(c => c.kind === 'item-use'), false); assert.match(g.RepairHammer.message, /no repair hammer/);
  const h = fixture(); wornWithHammer(h); h.Hunt.stop(); h.commands.length = 0; h.Controller.tick();
  assert.equal(h.commands.some(c => c.kind === 'item-use'), false);
  const k = fixture(); wornWithHammer(k); delete k.World.gp.inventory.find(i => i.slot === 6).tooltip; k.Controller.tick();
  assert.equal(k.commands.some(c => c.kind === 'item-use'), false, 'an unknown maximum is not guessed');
});
test('unconfirmed repair hammer use backs off and stops after three attempts', () => {
  const f = fixture(); wornWithHammer(f); f.Controller.tick();
  for (let i = 0; i < 4; i++) { f.advance(9000); f.Controller.tick(); f.advance(90000); f.Controller.tick(); }
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 3); assert.match(f.RepairHammer.message, /3 attempts/);
});
test('a repair hammer or idle pet pickup error is logged without stopping the bot', () => {
  const f = fixture(); wornWithHammer(f); f.RepairHammer.tick = () => { throw Error('boom'); };
  f.Controller.tick(); assert.equal(f.Hunt.running, true); assert.notEqual(f.Controller.mode, 'error');
  const g = fixture(); g.Hunt.stop(); g.Loot.idleTick = () => { throw Error('boom'); };
  g.Controller.tick(); assert.equal(g.Controller.mode, 'idle');
});
test('res travel returns when radius shrinks and stops hunting if return cannot progress', () => {
  const f=resurrectionTravel(); f.Controller.tick(); f.World.gp.pose.x=270;
  f.Settings.profile.party.resRadius=200; f.advance(1000); f.Controller.tick();
  assert.equal(f.Resurrect.trip.phase,'return'); assert.equal(f.commands.some(c=>c.kind==='skill'),false);
  f.advance(31000); f.Controller.tick(); assert.equal(f.Resurrect.trip,null); assert.equal(f.Hunt.running,false);
});
test('resurrection takes priority over hunting until its cast finishes, then hunting resumes', () => {
  const f = fixture(); resurrection(f); f.Hunt.start(); let hunts = 0;
  f.Hunt.tick = () => { hunts++; };
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'skill');
  assert.equal(hunts, 0); assert.equal(f.Controller.mode, 'resurrect'); assert.equal(f.Hunt.running, true);
  f.advance(1000); f.Controller.tick(); assert.equal(hunts, 0);
  f.advance(6000); f.Controller.tick(); assert.equal(hunts, 1);
});
test('auto-res still works under attack and returns to the existing hunting target', () => {
  const f = fixture(); resurrection(f); f.Hunt.start();
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] });
  f.World.attackers.set(30, 100000); f.Hunt.targetGid = 30; f.Hunt.targetSince = 100000; f.World.gp.target = 30;
  f.Controller.tick(); assert.equal(f.commands.at(-1).skillId, 10067); assert.equal(f.Hunt.targetGid, 30);
  f.World.gp.target = 50; f.advance(7000); f.Controller.tick();
  assert.equal(f.commands.at(-1).kind, 'select'); assert.equal(f.commands.at(-1).gid, 30);
});
test('auto-res does not interrupt another cast, empty MP or an inventory transaction', () => {
  for (const change of [f => f.World.isCasting = () => true, f => f.World.gp.inventoryPending = true,
    f => f.World.skill(10067).mp = 101]) {
    const f = fixture(); resurrection(f); change(f); f.Controller.tick(); assert.equal(f.commands.length, 0);
  }
});
test('auto-res yields to shopping and return travel even though it works while idle', () => {
  for (const change of [f => f.Restock.activeShop = () => ({}), f => { f.Restock.recording = true; f.Restock.draft = { route: [{ ...f.World.pose() }] }; },
    f => { f.Settings.profile.hunt.center.x = 400; f.WalkBack.start(); }]) {
    const f = fixture(); resurrection(f); change(f); f.commands.length = 0; f.Controller.tick();
    assert.notEqual(f.Controller.mode, 'error');
    assert.equal(f.commands.some(c => c.kind === 'skill' || c.kind === 'select'), false);
  }
});
test('auto-res holds an observed cast beyond its estimate and walks before an out-of-range cast', () => {
  const f = fixture(); resurrection(f); f.Controller.tick(); f.advance(7000);
  f.World.isCasting = () => true; f.Controller.tick(); assert.equal(f.Controller.mode, 'resurrect');
  const g = fixture(); resurrection(g); g.World.skill(10067).range = 5;
  g.Controller.tick(); assert.equal(g.commands.at(-1).kind, 'move'); assert.equal(g.commands.some(c => c.kind === 'skill'), false);
});
test('auto-resurrect is opt-in and selects the corpse before offering the rebirth', () => {
  const f = fixture(); resurrection(f);
  f.Settings.profile.party.autoRes = false; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.Settings.profile.party.autoRes = true; f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands)), [
    { kind: 'select', gid: 50 },
    { kind: 'skill', skillId: 10067, gid: 50 },
  ]);
  assert.ok(f.notices.some(n => /Resurrection offered: Mate/.test(n)));
  assert.equal(f.Hunt.running, false);
});
test('auto-resurrect offers once per answer window and rearms after the member revives', () => {
  const f = fixture(), mate = resurrection(f);
  f.Controller.tick(); assert.equal(f.commands.length, 2);
  f.advance(2000); f.Controller.tick(); assert.equal(f.commands.length, 2);
  f.advance(30000); f.Controller.tick(); assert.equal(f.commands.length, 4);
  mate.status = 10; f.advance(7000); f.Controller.tick(); assert.equal(f.commands.length, 4);
  mate.status = 0; f.advance(800); f.Controller.tick(); assert.equal(f.commands.length, 6);
});
test('auto-resurrect needs a fallen party member whose corpse is in view', () => {
  const f = fixture(), mate = resurrection(f);
  f.World.ents.delete(50); f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.ents.set(50, { gid: 50, kind: 'player', name: 'Mate', regionId: 1, x: 110, y: 0, z: 100, appearanceState: [0] });
  f.World.hpSeen.set(50, 120); f.Controller.tick(); assert.equal(f.commands.length, 0, 'standing, and the server HP says alive');
  f.World.hpSeen.delete(50); f.World.ents.get(50).appearanceState = [2]; f.advance(31000); f.Controller.tick();
  assert.equal(f.commands.length, 2);
  mate.status = 10; f.advance(7000); f.Controller.tick(); mate.status = 0;
  f.World.ents.get(50).name = 'Stranger'; f.advance(800); f.Controller.tick(); assert.equal(f.commands.length, 2);
  f.World.ents.get(50).name = 'Mate'; f.advance(800); f.Controller.tick(); assert.equal(f.commands.length, 4);
});
test('auto-resurrect offers the rebirth to a member who died out of view and is drawn standing on return', () => {
  const f = fixture(), mate = resurrection(f);
  f.World.ents.get(50).appearanceState = [1, 0, 0];
  f.Controller.tick();
  assert.deepEqual(casts(f), ['select 50', 'skill 10067 50'], 'party list at 0 and no HP that says otherwise: the server decides');
  assert.ok(f.Log.lines.some(l => /Mate is at 0 HP in the party list but shown standing; offering resurrection/.test(l.text)));
  f.advance(2000); f.Controller.tick(); assert.equal(casts(f).length, 2, 'one offer per answer window');
  f.advance(30000); f.Controller.tick(); assert.equal(casts(f).length, 4, 'refused or unanswered: offered again after the window');
  mate.status = 10; f.advance(7000); f.Controller.tick(); assert.equal(casts(f).length, 4, 'revived: nothing more');
});
test('auto-resurrect leaves a standing member alone when the server reports it alive', () => {
  const f = fixture(); resurrection(f);
  f.World.ents.get(50).appearanceState = [1, 0, 0]; f.World.applyEvent({ kind: 'hp-seed', gid: 50, hp: 80 });
  f.Controller.tick(); assert.deepEqual(casts(f), [], 'alive with little HP (0 tenths in the party list): no rebirth');
  f.World.applyEvent({ kind: 'hp-seed', gid: 50, hp: 0 }); f.advance(20000); f.Controller.tick();
  assert.deepEqual(casts(f), [], 'not looked at again for 30 s');
  f.advance(11000); f.Controller.tick(); assert.deepEqual(casts(f), ['select 50', 'skill 10067 50'], 'then the server HP of 0 counts');
});
test('auto-resurrect idles without a learned corpse-targeted skill', () => {
  const f = fixture(); resurrection(f);
  f.World.gp.skills = []; f.Controller.tick(); assert.equal(f.commands.length, 0);
  assert.match(f.Resurrect.message, /No learned/);
  f.World.gp.skills = [10256];
  f.World.rebuildCatalog([{ id: 10256, group: 658, level: 1, name: 'Group Rebirth', targetRequired: false, targets: 0, masteries: [] }]);
  f.Controller.tick(); assert.equal(f.commands.length, 0);
});
test('auto-resurrect prefers the highest-tier corpse-targeted row', () => {
  const f = fixture(); resurrection(f);
  f.World.gp.skills = [10067, 10072];
  f.World.rebuildCatalog([
    { id: 10067, group: 638, level: 1, name: 'Rebirth A', targetRequired: true, targets: 178, masteries: [{ ID: 518, Level: 10 }] },
    { id: 10072, group: 639, level: 1, name: 'Rebirth B', targetRequired: true, targets: 178, masteries: [{ ID: 518, Level: 60 }] },
  ]);
  f.Controller.tick(); assert.equal(f.commands.at(-1).skillId, 10072);
});
test('corpse-targeted rows may press on a corpse; ordinary rows still refuse one', () => {
  const f = fixture(); resurrection(f);
  assert.equal(f.Cmd.skill(10067, 50), true);
  f.advance(300);
  f.World.rebuildCatalog([{ id: 10067, group: 638, level: 1, name: 'Rebirth', targetRequired: true, targets: 6, masteries: [] }]);
  assert.equal(f.Cmd.skill(10067, 50), false);
});
test('auto-resurrect waits for a pending target selection', () => {
  const f = fixture(); resurrection(f);
  f.World.gp.targetPending = 30; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.World.gp.targetPending = 0; f.advance(300); f.Controller.tick(); assert.equal(f.commands.length, 2);
});
test('auto-resurrect yields to fresh manual control', () => {
  const f = fixture(); resurrection(f);
  f.Manual.lastAt = 99000; f.Controller.tick(); assert.equal(f.commands.length, 0);
  f.advance(7000); f.Controller.tick(); assert.equal(f.commands.length, 2);
});
function petFight(f) {
  const pet = pickupPet(f); f.Hunt.start();
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] });
  f.Hunt.targetGid = 30; f.Hunt.targetSince = 100000; f.World.gp.target = 30;
  f.World.attackers.set(30, 100000);
  return pet;
}
function idleFor(f, ms) { for (let t = 0; t < ms; t += 100) { f.advance(100); f.Controller.tick(); } }
test('a support character with Attack monsters off never starts a fight, and is not stopped as stuck', () => {
  const f = fixture(); f.Hunt.start(); let fights = 0;
  f.Combat.fight = () => { fights++; };
  assert.equal(f.Settings.profile.hunt.attack, true, 'attacking is on by default');
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] });
  f.Hunt.targetGid = 30; f.World.gp.target = 30;
  f.Settings.profile.hunt.attack = false;
  idleFor(f, 1000);
  assert.equal(fights, 0, 'no fight, not even with the monster it was fighting');
  assert.equal(f.Hunt.targetGid, 0); assert.equal(f.Hunt.state, 'support only'); assert.equal(f.Controller.mode, 'support only');
  f.World.attackers.set(30, f.World.simNow() ?? 0);
  idleFor(f, 240000);
  assert.equal(fights, 0, 'a monster that hits it is not fought either');
  assert.equal(f.AntiStuck.recoveries, 0, 'no kills is not being stuck'); assert.equal(f.Hunt.running, true);
  assert.equal(f.commands.some(c => c.kind === 'select' && c.gid === 30 || c.kind === 'skill' && c.gid === 30), false);
  f.Settings.profile.hunt.attack = true; f.World.attackers.set(30, f.World.simNow() ?? 0);
  idleFor(f, 500);
  assert.notEqual(f.Hunt.state, 'support only'); assert.equal(f.Hunt.targetGid, 30, 'attacking again once switched back on');
});
test('Attack monsters off also keeps luring from starting fights', () => {
  const f = fixture(); f.Hunt.start(); let lured = 0;
  f.Lure.on = () => true; f.Lure.tick = () => { lured++; };
  f.Settings.profile.hunt.attack = false; idleFor(f, 1000); assert.equal(lured, 0);
  f.Settings.profile.hunt.attack = true; idleFor(f, 300); assert.ok(lured > 0);
});
test('anti-stuck drops the target, then walks back, then stops after the configured recoveries', () => {
  const f = fixture(); f.Hunt.start(); idleFor(f, 1000);
  assert.equal(f.Hunt.state, 'search');
  idleFor(f, 180000); assert.equal(f.AntiStuck.recoveries, 1);
  assert.equal(f.Hunt.running, true); assert.equal(f.WalkBack.active, null);
  idleFor(f, 180000); assert.equal(f.AntiStuck.recoveries, 2); assert.equal(f.Hunt.running, true);
  idleFor(f, 180000); assert.equal(f.AntiStuck.recoveries, 3); assert.equal(f.Hunt.running, true);
  idleFor(f, 180000); assert.equal(f.Hunt.running, false);
  assert.ok(f.notices.some(m => /stuck/.test(m)));
});
test('anti-stuck is cleared by confirmed progress, damage and non-working states', () => {
  const f = fixture(); f.Hunt.start(); idleFor(f, 1000);
  idleFor(f, 150000); f.Stats.session.kills++; idleFor(f, 150000);
  assert.equal(f.AntiStuck.recoveries, 0);
  f.Hunt.tick = () => { f.Hunt.state = 'resting'; }; idleFor(f, 600000);
  assert.equal(f.AntiStuck.recoveries, 0); assert.equal(f.Hunt.running, true);
});
test('anti-stuck can be switched off and does not run while hunting is stopped', () => {
  const f = fixture(); f.Settings.profile.hunt.antiStuck.enabled = false; f.Hunt.start(); idleFor(f, 400000);
  assert.equal(f.AntiStuck.recoveries, 0); f.Settings.profile.hunt.antiStuck.enabled = true; f.Hunt.stop(); idleFor(f, 400000);
  assert.equal(f.AntiStuck.recoveries, 0);
});
test('SoX-only filters equipment to Star, Moon and Sun gear and leaves other categories alone', () => {
  const f = fixture(), P = f.Settings.profile.hunt.pickup;
  const gear = (gid, ref) => { const e = f.drop(gid, 44); e.refObjId = ref; e.name = 'Sword'; return e; };
  const plain = gear(40, 900), star = gear(41, 901), moon = gear(42, 902), sun = gear(43, 903), potion = f.drop(44, 2284);
  const gold = f.drop(45, 0x2d0); gold.groundItem.goldAmount = 50;
  f.Items.data.set(900, { name: 'Plain', icon: '', code: 'ITEM_CH_SWORD_01_A' });
  f.Items.data.set(901, { name: 'Star', icon: '', code: 'ITEM_CH_SWORD_01_A_RARE' });
  f.Items.data.set(902, { name: 'Moon', icon: '', code: 'ITEM_CH_SWORD_01_B_RARE_HONOR' });
  f.Items.data.set(903, { name: 'Sun', icon: '', code: 'ITEM_CH_SWORD_01_C_LEGEND' });
  assert.equal(f.Loot.allowed(plain), true); assert.equal(f.Loot.allowed(potion), true); assert.equal(f.Loot.allowed(gold), true);
  P.soxOnly = true;
  assert.deepEqual([plain, star, moon, sun, potion, gold].map(e => f.Loot.allowed(e)), [false, true, true, true, true, true]);
  assert.deepEqual([star, moon, sun].map(e => f.Items.sox(e.refObjId)), [1, 2, 3]);
  P.include = 'sword'; assert.equal(f.Loot.allowed(plain), false); P.include = '';
  P.potions = false; P.others = false; P.gold = false; assert.equal(f.Loot.allowed(potion), false); assert.equal(f.Loot.allowed(gold), false);
  P.soxOnly = false; assert.equal(f.Loot.allowed(plain), true);
});
test('SoX-only takes nothing until the item catalogue is loaded', () => {
  const f = fixture(), P = f.Settings.profile.hunt.pickup; let loads = 0;
  f.Items.ready = () => { loads++; return Promise.resolve(); };
  const e = f.drop(41, 44); e.refObjId = 901; P.soxOnly = true;
  assert.equal(f.Loot.allowed(e), false); assert.equal(f.Loot.allowed(e), false); assert.equal(loads, 1);
});
test('SoX pickups are counted and announced once; gold, unknown items and stopped hunting are not', () => {
  const f = fixture(); let chimes = [];
  f.Sound.play = kind => { chimes.push(kind); return true; };
  f.Items.data.set(901, { name: 'Star sword', icon: '', code: 'ITEM_CH_SWORD_01_A_RARE' });
  f.Items.data.set(902, { name: 'Plain sword', icon: '', code: 'ITEM_CH_SWORD_01_A' });
  const pick = (ref, gold = false) => f.Stats.pickup({ ref, name: 'Sword', gold, petGid: 0, before: 0 });
  f.Hunt.start(); f.notices.length = 0; chimes = [];
  pick(901); assert.equal(f.Stats.session.sox, 1); assert.deepEqual(chimes, ['sox']);
  assert.ok(f.notices.some(n => /SoX found: Sword \(Star\)/.test(n))); assert.equal(f.Stats.display().sox, '1');
  pick(902); pick(999); pick(901, true); assert.equal(f.Stats.session.sox, 1); assert.equal(chimes.length, 1);
  f.Settings.profile.hunt.pickup.soxSound = false; f.notices.length = 0; pick(901);
  assert.equal(f.Stats.session.sox, 2); assert.equal(chimes.length, 1); assert.equal(f.notices.some(n => /SoX/.test(n)), false);
  f.Settings.profile.hunt.pickup.soxSound = true; f.Hunt.stop(); pick(901); assert.equal(f.Stats.session.sox, 2);
  f.Hunt.start(); f.Stats.reset(); assert.equal(f.Stats.session.sox, 0);
});
test('SoX chime is a distinct audible alert and unknown sounds stay silent', () => {
  const f = fixture(), notes = [];
  f.Sound.ctx = { state: 'running', currentTime: 0, destination: {}, createOscillator: () => ({ frequency: {}, connect() {}, disconnect() {}, start() { notes.push(this.frequency.value); }, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }) };
  assert.equal(f.Sound.play('sox'), true); assert.equal(notes.length, 4);
  assert.equal(f.Sound.play('good'), false); assert.equal(notes.length, 4);
});
function masteryFixture(extra = {}) {
  const f = fixture(), m = f.Settings.profile.mastery;
  m.enabled = true; m.ids = [257, 273];
  f.Stats.levels = { 1: { masteryTrainSpCost: 1 }, 10: { masteryTrainSpCost: 9 }, 11: { masteryTrainSpCost: 10 }, 12: { masteryTrainSpCost: 11 } };
  const progression = { ...f.World.gp.progression, level: 30, skillPoints: 100, masteries: [{ id: 257, level: 10 }, { id: 273, level: 0 }, { id: 274, level: 30 }], ...extra };
  f.World.applyGameplay({ ...f.World.gp, progression });
  return f;
}
const trains = f => f.commands.filter(c => c.kind === 'mastery-train').map(c => c.id);
test('auto mastery raises the first selected mastery one confirmed level at a time', () => {
  const f = masteryFixture();
  f.Controller.tick(); assert.deepEqual(trains(f), [257]);
  f.advance(3000); f.Controller.tick(); assert.deepEqual(trains(f), [257], 'no second request before the first is confirmed');
  f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, skillPoints: 91, masteries: [{ id: 257, level: 11 }, { id: 273, level: 0 }, { id: 274, level: 30 }] } });
  f.advance(2000); f.Controller.tick();
  assert.ok(f.notices.some(n => /raised to 11/.test(n))); assert.deepEqual(trains(f), [257, 257]);
});
test('auto mastery follows the game rules: level cap, skill points, free level 0, selected only', () => {
  let f = masteryFixture({ skillPoints: 5 }); f.Controller.tick(); assert.deepEqual(trains(f), [273], 'level 0 is free; 257 needs 9 points');
  f = masteryFixture(); f.Settings.profile.mastery.ids = [274]; f.Controller.tick(); assert.deepEqual(trains(f), []);
  assert.match(f.AutoMastery.status(), /character level limit/);
  f = masteryFixture(); f.Settings.profile.mastery.ids = []; f.Controller.tick(); assert.deepEqual(trains(f), []);
  f = masteryFixture({ level: 10 }); f.Settings.profile.mastery.ids = [257]; f.Controller.tick(); assert.deepEqual(trains(f), [], 'a mastery cannot pass the character level');
  f = masteryFixture(); f.Stats.levels = { 1: { masteryTrainSpCost: 1 } }; f.Settings.profile.mastery.ids = [257]; f.Controller.tick();
  assert.deepEqual(trains(f), []); assert.match(f.AutoMastery.status(), /price unknown/);
});
test('auto mastery can leave a gap below the character level', () => {
  assert.equal(fixture().Settings.profile.mastery.gap, 0);
  // Level 30 character, mastery 257 at 28: gap 0 allows 29 and 30; gap 2 stops at 28.
  let f = masteryFixture({ masteries: [{ id: 257, level: 28 }, { id: 273, level: 0 }] }); f.Stats.levels = { 28: { masteryTrainSpCost: 5 }, 27: { masteryTrainSpCost: 5 }, 1: { masteryTrainSpCost: 1 } };
  f.Settings.profile.mastery.ids = [257]; f.Controller.tick(); assert.deepEqual(trains(f), [257]);
  f = masteryFixture({ masteries: [{ id: 257, level: 28 }, { id: 273, level: 0 }] }); f.Stats.levels = { 28: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.gap = 2; f.Controller.tick();
  assert.deepEqual(trains(f), []); assert.match(f.AutoMastery.status(), /at your limit \(28, 2 below your level\)/);
  f = masteryFixture({ masteries: [{ id: 257, level: 27 }, { id: 273, level: 0 }] }); f.Stats.levels = { 27: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.gap = 2; f.Controller.tick(); assert.deepEqual(trains(f), [257], 'one level of room remains');
  // The gap moves with the character level and the next selected mastery is used when one is held back.
  f = masteryFixture({ masteries: [{ id: 257, level: 28 }, { id: 273, level: 0 }] }); f.Stats.levels = { 28: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.gap = 2; f.Controller.tick(); assert.deepEqual(trains(f), [273]);
  f = masteryFixture({ level: 100, masteries: [{ id: 257, level: 119 }] }); f.Stats.levels = { 119: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.ids = [257]; f.Controller.tick(); assert.deepEqual(trains(f), [], 'never past 120 or the character level');
  // Bad saved values cannot widen the limit.
  f = masteryFixture({ masteries: [{ id: 257, level: 29 }] }); f.Stats.levels = { 29: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.gap = -5; f.Controller.tick(); assert.deepEqual(trains(f), [257]);
  f = masteryFixture({ masteries: [{ id: 257, level: 29 }] }); f.Stats.levels = { 29: { masteryTrainSpCost: 5 } };
  f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.gap = 'x'; f.Controller.tick(); assert.deepEqual(trains(f), [257]);
});
function statFixture(points = 3, weights = { str: 1, int: 0 }, extra = {}) {
  const f = fixture(), c = f.Settings.profile.statPoints;
  Object.assign(c, { enabled: true, reserve: 0, ...weights, ...extra });
  f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, statPoints: points } });
  f.spend = () => f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, statPoints: f.World.gp.progression.statPoints - 1 } });
  return f;
}
const statSends = f => f.commands.filter(c => c.kind === 'stat-increase').map(c => c.stat);
test('auto stat points spends one point at a time and confirms each by the unspent count going down', () => {
  const f = statFixture(2);
  f.Controller.tick(); assert.deepEqual(statSends(f), ['str']);
  for (let n = 0; n < 6; n++) { f.advance(200); f.Controller.tick(); }
  assert.deepEqual(statSends(f), ['str'], 'nothing more is sent before the game confirms');
  f.spend(); f.advance(600); f.Controller.tick(); assert.deepEqual(statSends(f), ['str', 'str']);
  f.spend(); f.advance(600); f.Controller.tick(); assert.deepEqual(statSends(f), ['str', 'str']); assert.match(f.StatPoints.status(), /No stat points to spend/);
});
test('auto stat points follows the Strength and Intelligence ratio and the reserve', () => {
  const f = statFixture(6, { str: 2, int: 1 });
  const order = [];
  for (let n = 0; n < 6; n++) { f.Controller.tick(); order.push(statSends(f).at(-1)); f.spend(); f.advance(600); f.Controller.tick(); f.advance(600); }
  assert.deepEqual(order, ['str', 'int', 'str', 'str', 'int', 'str']);
  const g = statFixture(5, { str: 0, int: 1 }); g.Controller.tick(); assert.deepEqual(statSends(g), ['int']);
  const h = statFixture(3, { str: 1, int: 0 }, { reserve: 3 }); h.Controller.tick(); assert.deepEqual(statSends(h), []); assert.match(h.StatPoints.status(), /Keeping 3 stat points unspent/);
  const z = statFixture(3, { str: 0, int: 0 }); z.Controller.tick(); assert.deepEqual(statSends(z), []); assert.match(z.StatPoints.status(), /share above zero/);
});
test('the auto stat points settings survive a reload of the saved profile', () => {
  const f = fixture(), saved = JSON.parse(JSON.stringify({ ...f.Settings.profile, statPoints: { enabled: true, str: 0, int: 3, reserve: 4 } }));
  const loaded = f.botProfile(saved);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.statPoints)), { enabled: true, str: 0, int: 3, reserve: 4 });
  assert.deepEqual(JSON.parse(JSON.stringify(f.botProfile({}).statPoints)), { enabled: false, str: 1, int: 0, reserve: 0 });
  for (const key of Object.keys(f.Settings.profile)) assert.ok(key in loaded, key + ' is kept when a profile loads');
  const kept = f.botProfile(saved); for (const key of Object.keys(saved)) assert.deepEqual(JSON.parse(JSON.stringify(kept[key])), saved[key], key + ' round-trips through botProfile');
});
test('auto stat points is off by default, waits for a living character and never resends an unconfirmed point', () => {
  const off = fixture(); off.World.applyGameplay({ ...off.World.gp, progression: { ...off.World.gp.progression, statPoints: 5 } });
  assert.equal(off.Settings.profile.statPoints.enabled, false); off.Controller.tick(); assert.deepEqual(statSends(off), []);
  const f = statFixture(2); f.Controller.tick(); assert.equal(statSends(f).length, 1);
  f.advance(6000); f.Controller.tick(); assert.match(f.StatPoints.status(), /not accepted; trying again in a minute/);
  f.advance(10000); f.Controller.tick(); assert.equal(statSends(f).length, 1, 'blocked for a minute');
  f.advance(60000); f.Controller.tick(); assert.equal(statSends(f).length, 2);
  const unknown = statFixture(0); unknown.World.applyGameplay({ ...unknown.World.gp, progression: { ...unknown.World.gp.progression, statPoints: undefined } });
  unknown.Controller.tick(); assert.deepEqual(statSends(unknown), []); assert.match(unknown.StatPoints.status(), /not known yet/);
});
const plain = v => JSON.parse(JSON.stringify(v));
function shareFixture() {
  const f = fixture(), p = f.Settings.profile;
  p.hunt.center = { regionId: 5, x: 10, y: 0, z: 20 }; p.hunt.radius = 250; p.mastery.enabled = true; p.mastery.ids = [257];
  p.potion.restock.town.arrival = { regionId: 7, x: 1, y: 2, z: 3 }; p.potion.restock.town.vendor = { regionId: 7, x: 4, y: 5, z: 6, name: 'Mine' };
  p.macro.buffSets = [{ id: 1, name: 'Cleric', weapon: 'w', shield: null }]; p.macro.buffs = [{ id: 20, group: 20, gearSet: 1, enabled: true }];
  p.wardrobe.presets = { a: { name: 'secret look' } }; p.statPoints.enabled = true; p.statPoints.int = 2; p.items.rules = { 100: { pick: 'yes' } };
  return f;
}
test('a share holds only what differs from the defaults and nothing personal', () => {
  const f = shareFixture(), data = JSON.parse(f.ProfileShare.text(true));
  assert.equal(data.app, 'nixxane-bot'); const p = data.profile;
  assert.equal(p.hunt.radius, 250); assert.equal(p.mastery.enabled, true); assert.equal(p.statPoints.int, 2); assert.deepEqual(plain(p.items.rules), { 100: { pick: 'yes' } });
  const text = JSON.stringify(p);
  for (const secret of ['regionId', 'Mine', 'Cleric', 'secret look']) assert.equal(text.includes(secret), false, secret + ' stays out of a share');
  assert.equal('potion' in p && 'restock' in p.potion && 'town' in p.potion.restock, false, 'unchanged town settings are not shared');
  assert.equal(p.macro.buffs[0].gearSet, 0, 'a weapon set assignment means nothing without the set');
  assert.ok(JSON.parse(f.ProfileShare.text(false)).profile.hunt.center, 'the full backup keeps the positions');
  const defaults = f.ProfileShare.text(true); assert.ok(defaults.length < 600, 'a share stays short');
});
test('the chosen weapons and shield are personal and the old two shields become one', () => {
  const f = shareFixture(); f.Settings.profile.items.gear.primaryWeapon = 'my-weapon';
  assert.equal(f.ProfileShare.text(true).includes('my-weapon'), false, 'not in a share');
  f.Settings.profile.items.gear.shield = 'my-shield';
  assert.equal(f.ProfileShare.build({ items: { gear: { shield: 'theirs' } } }).items.gear.shield, 'my-shield', 'an import keeps your own');
  assert.deepEqual(plain(f.botProfile({ items: { gear: { primaryWeapon: 'a', primaryShield: null, secondaryShield: 's2' } } }).items.gear),
    { primaryWeapon: 'a', secondaryWeapon: null, shield: 's2' });
  assert.equal(f.botProfile({ items: { gear: { primaryShield: 's1', secondaryShield: 's2' } } }).items.gear.shield, 's1', 'the primary shield first');
  assert.deepEqual(plain(f.botProfile({ items: { gear: { shield: 'x', primaryShield: 's1' } } }).items.gear), { primaryWeapon: null, secondaryWeapon: null, shield: 'x' });
});
test('importing previews the changes, keeps your own positions, applies once and can be undone', async () => {
  const sender = shareFixture(), code = await sender.ProfileShare.encode(sender.ProfileShare.text(true));
  assert.match(code, /^nixxane[01]:/);
  const f = fixture(), p = f.Settings.profile;
  p.hunt.center = { regionId: 99, x: 1, y: 1, z: 1 }; p.potion.restock.town.arrival = { regionId: 99, x: 9, y: 9, z: 9 }; p.macro.buffSets = [{ id: 4, name: 'Mine', weapon: 'k', shield: null }];
  const preview = await f.ProfileShare.preview(code);
  assert.ok(preview.rows.some(r => r.path === 'hunt.radius' && r.to === '250')); assert.equal(preview.rows.some(r => /center|arrival|buffSets|wardrobe/.test(r.path)), false);
  assert.match(f.ProfileShare.summary(preview.rows), /would change/);
  assert.equal(p.hunt.radius, 400, 'nothing changed by a preview');
  f.ProfileShare.pending = preview; assert.equal(f.ProfileShare.apply(), true);
  const now = f.Settings.profile; assert.equal(now.hunt.radius, 250); assert.equal(now.mastery.enabled, true); assert.equal(now.statPoints.int, 2);
  assert.equal(now.hunt.center.regionId, 99, 'your hunting spot is kept'); assert.equal(now.potion.restock.town.arrival.regionId, 99); assert.equal(now.macro.buffSets[0].name, 'Mine');
  assert.equal(f.ProfileShare.hasBackup(), true); assert.equal(f.ProfileShare.undo(), true);
  assert.equal(f.Settings.profile.hunt.radius, 400); assert.equal(f.Settings.profile.mastery.enabled, false); assert.equal(f.ProfileShare.hasBackup(), false);
  f.Hunt.running = true; f.ProfileShare.pending = preview; assert.equal(f.ProfileShare.apply(), false); assert.equal(f.Settings.profile.hunt.radius, 400, 'not while hunting');
});
test('an import is parsed as data: wrong files, prototype keys, wrong types and unknown fields are refused or dropped', async () => {
  const f = fixture(), share = obj => JSON.stringify({ app: 'nixxane-bot', format: 1, profile: obj });
  await assert.rejects(f.ProfileShare.preview(''), /Paste a share code/);
  await assert.rejects(f.ProfileShare.preview('hello'), /not a nixxane bot settings share/);
  await assert.rejects(f.ProfileShare.preview(JSON.stringify({ app: 'other', profile: {} })), /not a nixxane bot settings share/);
  await assert.rejects(f.ProfileShare.preview('{"app":"nixxane-bot","profile":{"hunt":{"__proto__":{"polluted":true}}}}'), /not allowed/);
  await assert.rejects(f.ProfileShare.preview('nixxane0:@@@'), /damaged/);
  await assert.rejects(f.ProfileShare.preview('x'.repeat(300001)), /too large/);
  assert.equal({}.polluted, undefined);
  const odd = await f.ProfileShare.preview(share({ hunt: { radius: 'huge', chase: 650, extra: 1 }, evil: { a: 1 }, potion: { hp: { pct: 'x', on: false } } }));
  assert.equal(odd.next.hunt.radius, 400, 'a wrong type falls back to the default'); assert.equal(odd.next.hunt.chase, 650); assert.equal('extra' in odd.next.hunt, false); assert.equal('evil' in odd.next, false);
  assert.equal(odd.next.potion.hp.pct, 60); assert.equal(odd.next.potion.hp.on, false);
  const old = await f.ProfileShare.preview(JSON.stringify({ app: 'sro-bot-lean', version: '1.2.0', profile: { ...plain(f.Settings.profile), hunt: { ...plain(f.Settings.profile.hunt), radius: 123 } } }));
  assert.equal(old.next.hunt.radius, 123, 'an old full export still imports');
  const unicode = 'Jäger 狩猎 ✓'; assert.equal(f.ProfileShare.string(f.ProfileShare.fromBase64(f.ProfileShare.toBase64(f.ProfileShare.bytes(unicode)))), unicode);
});
test('the setup checklist reads the real state and each row says what is missing', () => {
  const f = fixture(), state = id => f.Setup.steps().find(s => s.id === id);
  f.Settings.profile.hunt.center = null; f.Settings.profile.macro.rotations.normal = [];
  assert.equal(state('spot').state, 'bad'); assert.equal(state('skills').state, 'warn', 'normal attacks still work, so it is a warning');
  f.Settings.profile.macro.normalAttack = false; assert.equal(state('skills').state, 'bad');
  assert.ok(f.Setup.nextFix(), 'something to fix first'); assert.equal(f.Setup.nextFix().state, 'bad');
  f.World.gp.pose = { regionId: 1, x: 100, y: 0, z: 100 }; state('spot').action.run(); assert.equal(state('spot').state, 'ok');
  f.Settings.profile.macro.rotations.normal = [{ id: 5, group: 5 }]; assert.equal(state('skills').state, 'ok'); assert.match(state('skills').text, /1 skill in/);
  f.Settings.profile.potion.enabled = false; assert.equal(state('potions').state, 'warn'); state('potions').action.run(); assert.equal(f.Settings.profile.potion.enabled, true);
  f.Settings.profile.hunt.pickup.enabled = false; assert.equal(state('pickup').state, 'warn'); state('pickup').action.run(); assert.equal(f.Settings.profile.hunt.pickup.enabled, true);
  f.Town.cfg().enabled = true; assert.equal(state('town').state, 'bad'); assert.ok(state('town').text.length > 10, 'the town row says what is missing');
  f.World.gp.inventory = [{ slot: 6, refObjId: 100, typeFlags: 44 | (6 << 7), name: 'Test blade' }];
  assert.match(state('character').text, /Test blade/); f.World.gp.inventory = []; assert.match(state('character').text, /no weapon equipped/);
  assert.ok(f.Setup.steps().every(s => s.title && s.text && ['ok', 'warn', 'bad'].includes(s.state)));
});
test('setup of a chosen town fills the town and only turns town trips on when nothing is missing', () => {
  const f = fixture(); f.Setup.townPick = 'KT';
  f.Setup.setupTown(); assert.equal(f.Town.cfg().vendor.refObjId, 2074); assert.equal(f.Town.cfg().arrival.regionId, 23687);
  assert.equal(f.Town.cfg().enabled, Boolean(!f.Town.validate()), 'town trips are on only when validation passes');
});
test('starter settings are previewed, laid over your settings, applied once and undone', () => {
  const f = fixture(), p = f.Settings.profile;
  p.hunt.center = { regionId: 5, x: 1, y: 0, z: 2 }; p.macro.rotations.normal = [{ id: 5, group: 5 }]; p.hunt.playerAlert.enabled = false;
  f.Setup.choose('safe'); assert.ok(f.Setup.preview.rows.some(r => r.path === 'hunt.playerAlert.enabled' && r.to === 'true'));
  assert.equal(p.hunt.playerAlert.enabled, false, 'a preview changes nothing');
  assert.equal(f.ProfileShare.apply(), true);
  const now = f.Settings.profile; assert.equal(now.hunt.playerAlert.enabled, true); assert.equal(now.hunt.stopInvFull, true);
  assert.equal(now.hunt.center.regionId, 5, 'your hunting spot stays'); assert.equal(now.macro.rotations.normal[0].id, 5, 'your skills stay');
  assert.equal(f.ProfileShare.undo(), true); assert.equal(f.Settings.profile.hunt.playerAlert.enabled, false);
  f.Setup.choose('levelup'); assert.ok(f.Setup.preview.rows.some(r => r.path === 'hunt.pickup.potions')); f.ProfileShare.apply();
  assert.equal(f.Settings.profile.hunt.pickup.potions, false); assert.equal(f.Settings.profile.hunt.classes.giant, true);
  f.Setup.choose('drops'); f.ProfileShare.apply(); assert.equal(f.Settings.profile.hunt.pickup.potions, true); assert.equal(f.Settings.profile.hunt.classes.elite, true);
  f.Setup.choose('drops'); assert.equal(f.Setup.preview.rows.length, 0, 'applying the same preset again changes nothing');
});
test('the setup page opens first only for a character that has never been set up', () => {
  const f = fixture(); f.Settings.profile.hunt.center = null; f.Settings.profile.macro.rotations.normal = [];
  assert.equal(f.Setup.isNew(), true);
  f.Settings.profile.hunt.center = { regionId: 5, x: 1, y: 0, z: 2 }; assert.equal(f.Setup.isNew(), false);
});
function traceFixture(offset = 500, member = {}) {
  const f = fixture(), pose = f.World.gp.pose;
  f.Hunt.running = true; Object.assign(f.Settings.profile.trace, { enabled: true, name: '', distance: 12, fight: true });
  f.Settings.profile.hunt.center = { regionId: pose.regionId, x: pose.x - 5000, y: 0, z: pose.z };
  f.World.gp.social = { localName: 'Hunter', self: 10, leader: 11, options: 1, members: [{ id: 10, name: 'Hunter', status: 0x8a, region: pose.regionId, x: pose.x, y: 0, z: pose.z },
    { id: 11, name: 'Leader', level: 60, status: 0x8a, region: pose.regionId, x: pose.x + offset, y: 0, z: pose.z, ...member }, { id: 12, name: 'Archer', level: 60, status: 0x8a, region: pose.regionId, x: pose.x, y: 0, z: pose.z + 200 }] };
  f.huntedAround = []; f.Hunt.tick = () => { f.huntedAround.push(f.Settings.profile.hunt.center); };
  return f;
}
const moves = f => f.commands.filter(c => c.kind === 'move');
test('following walks to a party member who is too far away and keeps the saved hunting spot', () => {
  const f = traceFixture(500), spot = JSON.stringify(f.Settings.profile.hunt.center), pose = f.World.gp.pose;
  assert.equal(f.Trace.tick(), true); assert.equal(f.huntedAround.length, 0, 'it walks, it does not hunt yet');
  const m = moves(f); assert.equal(m.length, 1); assert.ok(m[0].destination.x > pose.x + 100 && m[0].destination.x < pose.x + 500, 'it heads towards the leader and stops short of them');
  assert.equal(f.Hunt.state, 'follow'); assert.match(f.Trace.status(), /Following Leader: 50 m away/); assert.equal(f.Trace.code, 'walking');
  assert.equal(JSON.stringify(f.Settings.profile.hunt.center), spot, 'the saved spot is never changed');
  f.Trace.tick(); assert.equal(moves(f).length, 1, 'one move per second at most'); f.advance(1000); f.Trace.tick(); assert.equal(moves(f).length, 2);
});
test('following hunts around the member once close, and restores the saved spot afterwards', () => {
  const f = traceFixture(60), spot = JSON.stringify(f.Settings.profile.hunt.center), pose = f.World.gp.pose;
  assert.equal(f.Trace.tick(), true); assert.equal(f.huntedAround.length, 1);
  assert.equal(f.huntedAround[0].x, pose.x + 60, 'hunting happens around the member'); assert.equal(JSON.stringify(f.Settings.profile.hunt.center), spot);
  assert.match(f.Trace.status(), /Hunting around Leader/);
  f.Hunt.tick = () => { throw Error('boom'); }; f.Trace.tick(); assert.equal(JSON.stringify(f.Settings.profile.hunt.center), spot, 'restored even when the hunting step fails');
});
test('following picks the chosen member or the leader and leaves the tick to normal hunting when it cannot follow', () => {
  const off = traceFixture(500); off.Settings.profile.trace.enabled = false; assert.equal(off.Trace.tick(), false); assert.equal(moves(off).length, 0);
  const named = traceFixture(500); named.Settings.profile.trace.name = 'Archer'; named.Trace.tick(); assert.match(named.Trace.status(), /Following Archer: 20 m away/, 'the chosen member, not the leader');
  const gone = traceFixture(500); gone.Settings.profile.trace.name = 'Nobody'; assert.equal(gone.Trace.tick(), false); assert.match(gone.Trace.status(), /Nobody is not in your party/); assert.equal(gone.Trace.code, 'no-member');
  const lead = traceFixture(500); lead.World.gp.social.leader = 10; assert.equal(lead.Trace.tick(), false); assert.match(lead.Trace.status(), /No party leader to follow/);
  const dead = traceFixture(500, { status: 0x80 }); assert.equal(dead.Trace.tick(), false); assert.equal(dead.Trace.code, 'member-dead');
  const far = traceFixture(5000); assert.equal(far.Trace.tick(), false); assert.equal(far.Trace.code, 'too-far'); assert.equal(moves(far).length, 0);
  const blind = traceFixture(500, { region: undefined }); assert.equal(blind.Trace.tick(), false); assert.equal(blind.Trace.code, 'no-position');
  const stopped = traceFixture(500); stopped.Hunt.running = false; assert.equal(stopped.Trace.tick(), false);
  const sitting = traceFixture(500); sitting.World.isSitting = () => true; assert.equal(sitting.Trace.tick(), false); assert.equal(moves(sitting).length, 0);
});
test('following fights what attacks on the way, never wanders while stuck-checking, and stays out of shares', () => {
  const f = traceFixture(500); f.Hunt.underAttack = () => true; assert.equal(f.Trace.tick(), true); assert.equal(f.huntedAround.length, 0, 'too far to fight: it keeps walking');
  const near = traceFixture(300); near.Hunt.underAttack = () => true; near.Trace.tick(); assert.equal(near.huntedAround.length, 1, 'attacked while within three times the distance: it fights');
  near.Settings.profile.trace.fight = false; near.Trace.tick(); assert.equal(near.huntedAround.length, 1, 'with the option off it keeps walking');
  const stuck = traceFixture(60); stuck.AntiStuck.idleMs = 5000; stuck.AntiStuck.tick(); assert.equal(stuck.AntiStuck.idleMs, 0, 'waiting for the leader is not being stuck');
  const share = traceFixture(60); share.Settings.profile.trace.name = 'Leader';
  assert.equal(JSON.parse(share.ProfileShare.text(true)).profile.trace?.name, undefined); assert.equal(share.ProfileShare.text(true).includes('Leader'), false);
  assert.equal(share.Settings.profile.trace.name, 'Leader');
  const loaded = share.botProfile(JSON.parse(JSON.stringify(share.Settings.profile))); assert.equal(loaded.trace.name, 'Leader'); assert.equal(loaded.trace.enabled, true);
});
function skillFixture(extra = {}, learned = [1001]) {
  const f = masteryFixture(extra); f.Settings.profile.mastery.enabled = false; f.Settings.profile.mastery.skills = true;
  const row = (id, level, more = {}) => ({ id, group: 100, level, trainable: true, spCost: 50, masteries: [{ ID: 257, Level: 10 }], prerequisites: [], reqStr: 0, reqInt: 0, ...more });
  f.World.rebuildCatalog([row(1001, 1), row(1002, 2), row(1003, 3, { spCost: 80 }), { id: 2001, group: 200, level: 1, trainable: true, spCost: 10, masteries: [], prerequisites: [], reqStr: 0, reqInt: 0 }]);
  f.World.applyGameplay({ ...f.World.gp, skills: learned });
  f.Settings.profile.macro.rotations.normal = [{ id: 1001, group: 100 }];
  return f;
}
const skillTrains = f => f.commands.filter(c => c.kind === 'skill-train').map(c => c.id);
test('the auto mastery status says why skills are not raised: switch off, nothing in the rotation, not learned, already highest', () => {
  let f = skillFixture(); f.Settings.profile.mastery.enabled = true; f.Settings.profile.mastery.order = 'skills'; f.Settings.profile.mastery.skills = false; f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.gap = 50;
  f.Controller.tick(); assert.deepEqual(skillTrains(f), []);
  assert.match(f.AutoMastery.status(), /skills are not raised: "Upgrade my rotation and buff skills automatically" is off/, 'Skills first alone does nothing');
  f = skillFixture(); f.Settings.profile.macro.rotations.normal = []; f.Controller.tick();
  assert.match(f.AutoMastery.status(), /no skills in your attack rotations, buffs or imbue yet/);
  f = skillFixture({}, []); f.Controller.tick(); assert.match(f.AutoMastery.status(), /Skill 100: not learned yet|: not learned yet/);
  f = skillFixture({}, [1001, 1002, 1003]); f.Controller.tick(); assert.match(f.AutoMastery.status(), /already at its highest level \(3\)/);
});
test('Skills to upgrade can cover every learned skill line, with the ones in use first', () => {
  const learned = [1001, 2001], extra = f => f.World.rebuildCatalog([...f.World.catalog.values(), { id: 2002, group: 200, level: 2, trainable: true, spCost: 10, masteries: [], prerequisites: [], reqStr: 0, reqInt: 0 }]);
  let f = skillFixture({}, learned); extra(f); f.Settings.profile.macro.rotations.normal = [];
  f.Controller.tick(); assert.deepEqual(skillTrains(f), [], 'rotation only: a skill in no list is left alone');
  f = skillFixture({}, [2001]); extra(f); f.Settings.profile.macro.rotations.normal = []; f.Settings.profile.mastery.scope = 'all';
  f.Controller.tick(); assert.deepEqual(skillTrains(f), [2002], 'all learned skills: a line that is in no rotation is raised');
  f = skillFixture({}, learned); extra(f); f.Settings.profile.mastery.scope = 'all';
  f.Controller.tick(); assert.deepEqual(skillTrains(f), [1002], 'the skill in the rotation goes first');
  f.World.applyGameplay({ ...f.World.gp, skills: [1001, 1002, 2001], progression: { ...f.World.gp.progression, skillPoints: 500 } }); f.advance(3000); f.Controller.tick(); f.advance(3000); f.Controller.tick();
  assert.ok(skillTrains(f).includes(1003) || skillTrains(f).includes(2002), 'then the rest');
  assert.equal(skillFixture().Settings.profile.mastery.scope, 'rotation', 'off by default');
});
test('auto skill upper learns the next level of skills in the rotation, one confirmed level at a time', () => {
  const f = skillFixture();
  f.Controller.tick(); assert.deepEqual(skillTrains(f), [1002]);
  f.advance(3000); f.Controller.tick(); assert.deepEqual(skillTrains(f), [1002], 'no second request before the first is confirmed');
  f.World.applyGameplay({ ...f.World.gp, skills: [1001, 1002], progression: { ...f.World.gp.progression, skillPoints: 90 } });
  f.advance(2000); f.Controller.tick();
  assert.ok(f.notices.some(n => /learned/.test(n))); assert.deepEqual(skillTrains(f), [1002, 1003]);
  f.World.applyGameplay({ ...f.World.gp, skills: [1001, 1002, 1003] }); f.advance(2000); f.Controller.tick(); f.advance(2000); f.Controller.tick();
  assert.deepEqual(skillTrains(f), [1002, 1003], 'no further level exists');
  const buffs = skillFixture(); buffs.Settings.profile.macro.rotations.normal = []; buffs.Settings.profile.macro.buffs = [{ id: 1001, group: 100 }];
  buffs.Controller.tick(); assert.deepEqual(skillTrains(buffs), [1002], 'buff skills are upgraded too');
});
test('Max every skill learns every skill group, unlearned ones too, one confirmed level at a time, then says what is left', () => {
  const f = skillFixture({}, []);
  f.Settings.profile.mastery.skills = false; f.Settings.profile.mastery.reserve = 1000; f.Settings.profile.mastery.gap = 25;
  assert.equal(f.AutoMastery.active(), false);
  f.AutoMastery.startMax(); f.Controller.tick();
  assert.equal(f.AutoMastery.active(), true); assert.deepEqual(skillTrains(f), [1001], 'an unlearned skill line starts at level 1; the reserve setting does not apply');
  f.Controller.tick(); assert.deepEqual(skillTrains(f), [1001], 'no second request before the first is confirmed');
  f.World.applyGameplay({ ...f.World.gp, skills: [1001], progression: { ...f.World.gp.progression, skillPoints: 50 } }); f.Controller.tick();
  assert.deepEqual(skillTrains(f), [1001, 1002], 'the next request follows at once, with no spacing delay');
  f.World.applyGameplay({ ...f.World.gp, skills: [1001, 1002], progression: { ...f.World.gp.progression, skillPoints: 0 } }); f.Controller.tick();
  assert.equal(f.AutoMastery.maxAll, false, 'it ends when nothing more is allowed');
  assert.match(f.AutoMastery.maxMessage, /done, 2 learned or upgraded; still blocked: .*needs (80|10) skill points/);
  assert.deepEqual(skillTrains(f), [1001, 1002]);
});
test('Max every skill raises a mastery only when it is what blocks a skill, and ignores the gap and reserve', () => {
  const f = skillFixture({}, []);
  f.Settings.profile.mastery.skills = false; f.Settings.profile.mastery.reserve = 1000; f.Settings.profile.mastery.gap = 25;
  f.World.rebuildCatalog([...f.World.catalog.values()].map(s => s.id === 1001 ? { ...s, masteries: [{ ID: 257, Level: 11 }] } : s));
  f.AutoMastery.startMax(); f.Controller.tick();
  assert.deepEqual(trains(f), [257]); assert.deepEqual(skillTrains(f), [], 'the mastery comes first');
  f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, masteries: [{ id: 257, level: 11 }, { id: 273, level: 0 }, { id: 274, level: 30 }], skillPoints: 90 } }); f.Controller.tick();
  assert.deepEqual(skillTrains(f), [1001], 'then the skill it unlocked');
  f.AutoMastery.stopMax('Max every skill: stopped.'); assert.equal(f.AutoMastery.maxAll, false);
});
test('Max every skill sees a refusal at once, does not repeat it and leaves other skills alone', () => {
  const f = skillFixture({}, []);
  f.Settings.profile.mastery.skills = false;
  f.AutoMastery.startMax(); f.Controller.tick(); assert.deepEqual(skillTrains(f), [1001]);
  f.World.applyGameplay({ ...f.World.gp, trainingError: 'The game refused this' }); f.Controller.tick();
  assert.deepEqual(skillTrains(f), [1001, 2001], 'the refused skill is skipped and the next line goes on');
  f.World.applyGameplay({ ...f.World.gp, skills: [2001], trainingError: 'The game refused this' }); f.Controller.tick();
  assert.deepEqual(skillTrains(f), [1001, 2001], 'the refused skill is not sent again');
  assert.equal(f.AutoMastery.maxAll, false); assert.match(f.AutoMastery.maxMessage, /refused by the game/);
  f.AutoMastery.stopMax();
});
test('auto skill upper follows the game requirements and never trains skills you do not use', () => {
  let f = skillFixture(); f.Settings.profile.macro.rotations.normal = []; f.Controller.tick(); assert.deepEqual(skillTrains(f), [], 'only skills in rotations, buffs or imbue');
  f = skillFixture({ masteries: [{ id: 257, level: 9 }, { id: 273, level: 0 }] }); f.Controller.tick(); assert.deepEqual(skillTrains(f), []); assert.match(f.AutoMastery.status(), /mastery level too low/);
  f = skillFixture({ skillPoints: 49 }); f.Controller.tick(); assert.deepEqual(skillTrains(f), []); assert.match(f.AutoMastery.status(), /needs 50 skill points/);
  f = skillFixture(); f.World.rebuildCatalog([...f.World.catalog.values()].map(s => s.id === 1002 ? { ...s, reqStr: 99 } : s)); f.Controller.tick();
  assert.deepEqual(skillTrains(f), []); assert.match(f.AutoMastery.status(), /strength too low/);
  f = skillFixture(); f.World.rebuildCatalog([...f.World.catalog.values()].map(s => s.id === 1002 ? { ...s, prerequisites: [{ ID: 300, Level: 1 }] } : s)); f.Controller.tick();
  assert.deepEqual(skillTrains(f), []); assert.match(f.AutoMastery.status(), /prerequisite/);
  f = skillFixture(); f.World.rebuildCatalog([...f.World.catalog.values()].map(s => s.id === 1002 ? { ...s, trainable: false } : s)); f.Controller.tick(); assert.deepEqual(skillTrains(f), []);
  f = skillFixture(); f.Settings.profile.mastery.skills = false; f.Controller.tick(); assert.deepEqual(skillTrains(f), []);
});
test('the skill point reserve is never spent on masteries or skills', () => {
  let f = masteryFixture({ skillPoints: 20 }); f.Settings.profile.mastery.ids = [257]; f.Settings.profile.mastery.reserve = 12; f.Controller.tick();
  assert.deepEqual(trains(f), [], '20 points leaves 8 after the reserve, below the price of 9'); assert.match(f.AutoMastery.status(), /beyond the 12 reserve/);
  f.Settings.profile.mastery.reserve = 11; f.advance(2000); f.Controller.tick(); assert.deepEqual(trains(f), [257]);
  f = skillFixture({ skillPoints: 60 }); f.Settings.profile.mastery.reserve = 11; f.Controller.tick(); assert.deepEqual(skillTrains(f), []);
  f.Settings.profile.mastery.reserve = 10; f.advance(2000); f.Controller.tick(); assert.deepEqual(skillTrains(f), [1002]);
  f = skillFixture({ skillPoints: 60 }); f.Settings.profile.mastery.reserve = 'x'; f.Controller.tick(); assert.deepEqual(skillTrains(f), [1002], 'bad saved values mean no reserve');
});
test('spend order: masteries first, skills first, or alternating', () => {
  const both = order => { const f = skillFixture(); f.Settings.profile.mastery.enabled = true; f.Settings.profile.mastery.ids = [273]; f.Settings.profile.mastery.order = order; return f; };
  let f = both('masteries'); f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'mastery-train');
  f = both('skills'); f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'skill-train');
  f = both('alternate'); f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'mastery-train');
  f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, masteries: [{ id: 257, level: 10 }, { id: 273, level: 1 }, { id: 274, level: 30 }] } });
  f.advance(2000); f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'skill-train', 'alternates to skills after a mastery is confirmed');
  assert.equal(fixture().Settings.profile.mastery.skills, false); assert.equal(fixture().Settings.profile.mastery.order, 'masteries');
});
function combatFixture(change = {}) {
  const f = fixture();
  f.World.rebuildCatalog([{ id: 500, group: 50, level: 1, name: 'Slash', targetRequired: true, mp: 5, cooldownGroup: 0 }]);
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 120, z: 100, attackFlags: 16, appearanceState: [0] });
  f.World.applyGameplay({ ...f.World.gp, skills: [500], target: 30, vitals: [{ gid: 1, hp: 100, mp: 100, maxHp: 100, maxMp: 100 }], skillCooldowns: [], ...change });
  f.Settings.profile.macro.rotations.normal = [{ id: 500, group: 50 }];
  f.Settings.profile.macro.imbueBeforeAttack = false;
  return f;
}
const sentKinds = f => f.commands.map(c => c.kind);
test('combat uses the rotation skill when it can, and explains every normal attack that replaces one', () => {
  let f = combatFixture(); f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(sentKinds(f), ['skill']); assert.equal(f.Combat.fallbackNote(), '');
  f = combatFixture({ skillCooldowns: [{ skill: 500, group: 0, startedAtMs: 99900, durationMs: 5000 }] }); f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(sentKinds(f), ['attack']); assert.match(f.Combat.fallbackNote(), /1 cooling down/);
  f = combatFixture({ vitals: [{ gid: 1, hp: 100, mp: 0, maxHp: 100, maxMp: 100 }] }); f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(sentKinds(f), ['attack']); assert.match(f.Combat.fallbackNote(), /1 not enough MP/);
  f = combatFixture(); f.Combat.fail(500); f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(sentKinds(f), ['attack']); assert.match(f.Combat.fallbackNote(), /1 paused after a server rejection/);
  f = combatFixture({ skills: [] }); f.Combat.fight(f.World.ents.get(30)); assert.match(f.Combat.fallbackNote(), /1 not learned/);
  f = combatFixture(); f.Settings.profile.macro.rotations.normal = []; f.Combat.fight(f.World.ents.get(30)); assert.match(f.Combat.fallbackNote(), /no skills in the rotation/);
  f = combatFixture(); f.Settings.profile.macro.minMpPct = 101; f.Combat.fight(f.World.ents.get(30)); assert.match(f.Combat.fallbackNote(), /MP below the minimum/);
  f = combatFixture({ skillCooldowns: [{ skill: 500, group: 0, startedAtMs: 99900, durationMs: 5000 }] }); f.Hunt.state = 'fight'; f.Hunt.running = true;
  f.Combat.fight(f.World.ents.get(30)); assert.match(f.Diagnostics.main(), /Combat: normal attack \(1 cooling down\)/);
  f.advance(9000); assert.equal(f.Combat.fallbackNote(), '', 'the reason expires once skills are used again');
  assert.ok(f.Combat.fallbackNote(true), 'but the log wording stays available');
});
test('approaching a monster outside skill reach does not poison the rotation', () => {
  const f = combatFixture();
  f.World.catalog.get(500).range = 50;
  f.World.ents.get(30).x = 300;
  for (let i = 0; i < 8; i++) {
    f.Combat.fight(f.World.ents.get(30));
    f.advance(800); f.World.applyGameplay({ ...f.World.gp });
  }
  assert.equal(f.Combat.blocked(500), false);
  assert.ok(f.commands.every(c => c.kind === 'skill'));
});

test('a rejected attack on one monster does not pause skills against the next monster', () => {
  const f = combatFixture();
  f.Combat.cast(500, 30); f.Combat.fail(500);
  assert.equal(f.Combat.blocked(500), true);
  f.World.ents.set(31, { ...f.World.ents.get(30), gid: 31 });
  f.World.applyGameplay({ ...f.World.gp, target: 31 }); f.advance(800);
  f.Combat.fight(f.World.ents.get(31));
  assert.equal(f.commands.at(-1).kind, 'skill');
  assert.equal(f.commands.at(-1).gid, 31);
  f.World.applyGameplay({ ...f.World.gp, target: 30 });
  assert.equal(f.Combat.blocked(500), true, 'the failed monster retains its backoff');
});

test('unknown reach and pending movement cannot establish silent attack rejection', () => {
  for (const change of [f => {}, f => { f.World.catalog.get(500).range = 50; f.World.gp.pendingMoves = 1; }]) {
    const f = combatFixture(); change(f);
    for (let i = 0; i < 5; i++) {
      assert.equal(f.Combat.cast(500, 30), true);
      f.advance(800); f.World.applyGameplay({ ...f.World.gp });
    }
    assert.equal(f.Combat.blocked(500), false);
  }
});

test('confirmed local casts clear the matching target failure and preserve self-skill backoff', () => {
  const f = combatFixture(); f.Combat.init();
  f.Combat.cast(500, 30); f.Combat.fail(500);
  f.bus.emit('cast', { caster: 2, skill: 500, target: 30, results: [] });
  assert.equal(f.Combat.blocked(500), true, 'another player cannot confirm our skill');
  f.bus.emit('cast', { caster: 1, skill: 500, results: [{ target: 30, impacts: [] }] });
  assert.equal(f.Combat.blocked(500), false);
  f.advance(800); f.Combat.cast(500, 0); f.Combat.fail(500);
  f.World.applyGameplay({ ...f.World.gp, target: 31 });
  assert.equal(f.Combat.blocked(500), true, 'self-skill failures still apply across targets');
});

test('silent rejection evidence never transfers between monsters', () => {
  const f = combatFixture(); f.World.catalog.get(500).range = 50;
  f.World.ents.set(31, { ...f.World.ents.get(30), gid: 31 });
  f.Combat.cast(500, 30);
  f.advance(800); f.World.applyGameplay({ ...f.World.gp }); f.Combat.cast(500, 30);
  f.advance(800); f.World.applyGameplay({ ...f.World.gp, target: 31 });
  assert.equal(f.Combat.cast(500, 31), true);
  assert.equal(f.Combat.blocked(500), false);
});

test('a skill is not blamed for a slow game snapshot, only for a real rejection', () => {
  const f = combatFixture(), target = f.World.ents.get(30);
  f.World.catalog.get(500).range = 50;
  assert.equal(f.Combat.cast(500, 30), true);
  f.advance(400); f.World.applyGameplay({ ...f.World.gp }); assert.equal(f.Combat.cast(500, 30), true);
  assert.ok(!f.Combat.stuck.get(f.Combat.failureKey(500, 30))?.miss, 'under 700 ms after a send is never a rejection');
  f.advance(1000); assert.equal(f.Combat.cast(500, 30), true);
  assert.ok(!f.Combat.stuck.get(f.Combat.failureKey(500, 30))?.miss, 'without a newer snapshot nothing can be concluded');
  f.advance(800); f.World.applyGameplay({ ...f.World.gp }); assert.equal(f.Combat.cast(500, 30), true);
  assert.equal(f.Combat.stuck.get(f.Combat.failureKey(500, 30))?.miss, 1);
  f.advance(800); f.World.applyGameplay({ ...f.World.gp }); assert.equal(f.Combat.cast(500, 30), false);
  assert.equal(f.Combat.blocked(500), true, 'two real rejections still pause the skill');
});
test('town never deposits SoX gear that a buff set, alchemy or the Keep names rely on', () => {
  const f = townFixture(), gp = f.World.gp;
  const gear = (slot, ref, name) => ({ slot, refObjId: ref, typeFlags: 44 | (6 << 7), quantity: 1, name, magic: [], plus: 0, tooltip: { fields: { rarity: 2, itemClass: 1 } } });
  const buffWeapon = gear(20, 3001, 'Buff staff'), spare = gear(21, 3002, 'Spare sword'), alchemy = gear(22, 3003, 'Alchemy sword'), favorite = gear(23, 3004, 'Favorite blade');
  gp.inventory.push(buffWeapon, spare, alchemy, favorite);
  f.Settings.profile.macro.buffSets = [{ id: 1, name: 'Cleric', weapon: f.BuffGear.key(buffWeapon), shield: null }];
  f.Alchemy.selected = { slot: 22, fingerprint: 'x' };
  assert.deepEqual([buffWeapon, spare, alchemy, favorite].map(i => f.Town.depositItem(i, true)), [false, true, false, false]);
  assert.equal(f.Town.depositItem(alchemy, false), true, 'an alchemy slot number means nothing for pet items');
});
test('an error in an optional feature is logged and skipped instead of stopping the bot', () => {
  const f = fixture(); f.Hunt.start(); f.notices.length = 0;
  f.Settings.profile.mastery.enabled = true; f.Settings.profile.mastery.ids = [257]; f.AutoMastery.rows = () => { throw Error('boom'); };
  f.Stats.levels = {}; f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, level: 30, skillPoints: 5, masteries: [{ id: 257, level: 1 }] } });
  f.Controller.tick(); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.equal(f.notices.some(n => /Bot stopped/.test(n)), false);
  f.Party.tick = f.Party.tick; f.Controller.guard('x', () => { throw Error('again'); });
  assert.equal(f.Controller.guard('y', () => 7), 7);
});
function levelGear(slot, ref, level, more = {}) {
  return { slot, refObjId: ref, typeFlags: 44 | (6 << 7), quantity: 1, name: 'Glaive', magic: [], plus: 0, tooltip: { fields: { rarity: 0, reqLevelType1: 1, requiredLevel: level } }, ...more };
}
test('town deposits gear requiring the listed levels and never sells it', () => {
  const f = townFixture(), c = f.Town.cfg();
  const g85 = levelGear(0, 4001, 85), g84 = levelGear(1, 4002, 84), g90 = levelGear(2, 4003, 90), mastery = levelGear(3, 4004, 85, { tooltip: { fields: { reqLevelType1: 2, requiredLevel: 85 } } });
  assert.deepEqual([g85, g84, g90, mastery].map(i => f.Town.depositItem(i)), [false, false, false, false], 'off until levels are listed');
  c.storeLevels = '85';
  assert.deepEqual([g85, g84, g90, mastery].map(i => f.Town.depositItem(i)), [true, false, false, false]);
  c.storeLevels = '80-84, 90'; assert.deepEqual([g85, g84, g90].map(i => f.Town.depositItem(i)), [false, true, true]);
  c.storeLevels = '90-80'; assert.equal(f.Town.depositItem(g85), true, 'reversed ranges are normalised');
  for (const bad of ['abc', '', '8x', '1000', '85-']) { c.storeLevels = bad; assert.equal(f.Town.depositItem(g85), false, 'ignored: ' + bad); }
  c.storeLevels = '85';
  assert.equal(f.Town.eligible(g85), true); assert.equal(f.Town.sellable(g85), false, 'listed gear is never sold, even if storing is not possible');
  assert.equal(f.Town.sellable(g84), true, 'other ordinary gear is still sold');
  const potion = { slot: 5, refObjId: 15, typeFlags: 4332, quantity: 1, tooltip: { fields: { reqLevelType1: 1, requiredLevel: 85 } } };
  assert.equal(f.Town.depositItem(potion), false, 'only equipment');
  c.keep = 'glaive'; assert.equal(f.Town.depositItem(g85), false, 'Keep names win');
});
test('town trip stores level-listed gear from the bag and the pet, and protects buff and alchemy weapons', () => {
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().storeLevels = '85'; f.Town.cfg().storeSox = false; f.Town.cfg().keep = '';
  const bag = levelGear(20, 5001, 85), keepBuff = levelGear(21, 5002, 85), keepAlchemy = levelGear(22, 5003, 85), plain = levelGear(23, 5004, 60);
  gp.inventory.push(bag, keepBuff, keepAlchemy, plain);
  f.Settings.profile.macro.buffSets = [{ id: 1, name: 'Cleric', weapon: f.BuffGear.key(keepBuff), shield: null }]; f.Alchemy.selected = { slot: 22, fingerprint: 'x' };
  f.pet.inventory = [levelGear(0, 5005, 85), levelGear(1, 5006, 70)];
  f.Town.begin(); f.Town.enter('store'); gp.storage = { npc: 60, phase: 'open', capacity: 30, items: [] }; gp.target = 60;
  const stored = [];
  for (let n = 0; n < 16 && f.Town.trip?.phase === 'store'; n++) {
    f.advance(1000); f.Town.store(); const c = f.commands.at(-1);
    if (c.kind === 'cos-transfer') { const i = f.pet.inventory.find(i => i.slot === c.source); gp.inventory.push({ ...i, slot: c.destination }); f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.source); }
    else if (c.kind === 'storage-move' && f.Town.trip?.pending) { const i = gp.inventory.find(i => i.slot === c.move.source); stored.push(i.refObjId); gp.storage.items.push({ ...i, slot: c.move.destination }); gp.inventory = gp.inventory.filter(i => i.slot !== c.move.source); }
    f.advance(600); f.Town.store();
  }
  assert.deepEqual(stored.sort(), [5001, 5005]);
  assert.ok([5002, 5003, 5004].every(ref => gp.inventory.some(i => i.refObjId === ref)), 'buff, alchemy and ordinary bag gear stay');
  assert.ok(f.pet.inventory.some(i => i.refObjId === 5006), 'other pet gear stays for the selling step');
});
const PET_KIT = 8428; // consumable 3/3/1/4: the companion HP recovery kit
function petPotionFixture(change = {}) {
  const f = fixture(); f.Settings.profile.potion.petHp.on = true;
  f.PetPotion.seenMax.set(50, 1000); // the pet was seen at full HP when summoned: that pins its real maximum
  const kit = (slot, ref, heal, quantity = 5) => ({ slot, refObjId: ref, typeFlags: PET_KIT, quantity, name: 'Recovery kit', tooltip: { fields: { itemParam1_29c: heal } } });
  f.World.applyGameplay({ ...f.World.gp, inventory: [kit(20, 2143, 360), kit(21, 2144, 800), kit(22, 9237, 3000)],
    cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, mp: 0, status: 5, dead: false }], ...change });
  return f;
}
const petUses = f => f.commands.filter(c => c.kind === 'item-use');
test('pet auto potion heals a low attack or pickup pet with the smallest kit that covers the damage', () => {
  assert.equal(fixture().Settings.profile.potion.petHp.on, false);
  const f = petPotionFixture(); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(petUses(f))), [{ kind: 'item-use', slot: 21, companionGid: 50 }], '300/1000 HP is 700 missing: the 800 kit is the smallest that covers it');
  let g = petPotionFixture(); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 900, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g).length, 0, 'above the threshold');
  g = petPotionFixture(); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 10, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g)[0].slot, 22, 'very low HP takes the biggest kit when none covers it exactly');
  g = petPotionFixture(); g.PetPotion.seenMax.set(51, 1000); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 51, refObjId: 500, band: 4, hp: 300, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g)[0].companionGid, 51, 'pickup pets are healed too');
  g = petPotionFixture({ progression: { gold: '100000', level: 100, stats: { maxHp: 100, maxMp: 100, strength: 300 } } });
  g.Controller.tick(); assert.equal(petUses(g)[0].slot, 20, 'the small kit already covers the deficit once its heal is scaled by strength and level like the server does');
});
test('pet auto potion never touches the wrong pets, the player potions or an unconfirmed retry', () => {
  let f = petPotionFixture(); f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 60, refObjId: 500, band: 2, hp: 100, status: 5, dead: false }, { gid: 61, refObjId: 500, band: 3, hp: 100, status: 5, dead: true }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 0, 'transports and dead pets are ignored');
  f = petPotionFixture(); f.Settings.profile.potion.petHp.on = false; f.Controller.tick(); assert.equal(petUses(f).length, 0);
  f = petPotionFixture(); f.Settings.profile.potion.enabled = false; f.Controller.tick(); assert.equal(petUses(f).length, 0, 'the master potion switch also stops pet kits');
  f = petPotionFixture(); f.World.applyGameplay({ ...f.World.gp, inventory: [] }); f.Controller.tick(); assert.equal(petUses(f).length, 0); assert.match(f.PetPotion.message, /no pet recovery kits/);
  f = petPotionFixture({ vitals: [{ gid: 1, hp: 30, mp: 100, maxHp: 100, maxMp: 100 }] }); f.World.applyGameplay({ ...f.World.gp, inventory: [...f.World.gp.inventory, { slot: 30, refObjId: 8, typeFlags: 2284, quantity: 5 }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 1); assert.equal(petUses(f)[0].companionGid, undefined, 'the player potion went first, the pet waits for the next tick');
  f = petPotionFixture(); f.Controller.tick(); assert.equal(petUses(f).length, 1);
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 1, 'no second kit until the first is seen consumed');
  f.advance(4000); f.Controller.tick(); assert.equal(petUses(f).length, 1); assert.match(f.PetPotion.message, /consumption unconfirmed/);
  f.advance(31000); f.Controller.tick(); assert.equal(petUses(f).length, 2, 'retried after the 30 s pause');
  f = petPotionFixture(); f.Controller.tick(); assert.equal(petUses(f).length, 1);
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 21 ? { ...i, quantity: 4 } : i), cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, status: 5, dead: false }] });
  f.advance(2000); f.Controller.tick();
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 2, 'consumption confirms the first and the next kit may follow');
  f = petPotionFixture(); f.PetPotion.seenMax.clear(); f.Controller.tick(); assert.equal(petUses(f).length, 0, 'a first-seen pet measures against itself and stays untouched while full');
  f = petPotionFixture(); assert.equal(f.Cmd.itemUseOnPet(20, 999), false, 'unknown pet'); assert.equal(f.Cmd.itemUseOnPet(99, 50), false, 'unknown item');
  assert.equal(f.Cmd.itemUseOnPet(20, 50), true);
});
test('pet auto potion measures against the learned maximum, never a vitals row', () => {
  let f = petPotionFixture({ vitals: [{ gid: 50, hp: 1000, maxHp: 999999 }] });
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 1000, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 0, 'a full pet stays full even when a vitals row claims a huge maximum');
  assert.match(f.PetPotion.message, /heals at/);
  f = petPotionFixture({ vitals: [{ gid: 50, hp: 100, maxHp: 999999 }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 1, 'the live vitals HP still drives the percentage of the learned maximum');
});
test('a pet first seen wounded and the learned memory across resets and switches', () => {
  // The bot meets the pet mid-fight at 600 of a real 11000: measured against the highest HP seen, and the
  // memory survives an option toggle or reset — it is observation, not a setting.
  const f = petPotionFixture(); f.PetPotion.seenMax.clear();
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 600, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 0, 'its first-seen HP is its scale, so it reads full and waits');
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 250, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 1, 'dropping below the threshold of the seen scale heals');
  f.PetPotion.reset(); f.advance(2000);
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 250, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(f.PetPotion.pets()[0].max, 600, 'a reset keeps the learned maximum');
  assert.equal(petUses(f).length, 2, 'and healing continues at the same scale');
  // Watching runs even with the feature off: summoning a pet while off, then switching on, is correct at once.
  const g = petPotionFixture(); g.PetPotion.seenMax.clear(); g.Settings.profile.potion.petHp.on = false; g.Settings.profile.potion.petHgp.on = false;
  g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 53, refObjId: 500, band: 3, hp: 2000, status: 5, dead: false }] });
  g.Controller.tick();
  assert.equal(g.PetPotion.seenMax.get(53), 2000, 'the high-water mark collects with every switch off');
  g.Settings.profile.potion.petHp.on = true;
  g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 53, refObjId: 500, band: 3, hp: 700, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g).length, 1, 'so switching on later heals against the right maximum');
});
test('the maximum is learned from the observed HP, not the catalogue (live regression)', () => {
  // Live report: the catalogue asset is gone from the server (404) and the game's own asset cache serves a
  // stale copy claiming max 39434 while the pet is really full at 11000. The first read of a summoned pet
  // pins the true maximum instead.
  const f = petPotionFixture(); f.PetPotion.seenMax.set(50, 11000);
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 11000, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 0, 'a full pet is full against its observed maximum, whatever any stale catalogue said');
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 5000, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 1, 'wounded against the observed maximum, the kit goes out');
  f.advance(2000); f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 22 ? { ...i, quantity: 4 } : i), cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 11000, status: 5, dead: false }] });
  f.Controller.tick(); f.advance(2000); f.Controller.tick();
  assert.equal(petUses(f).length, 1, 'healed back to the observed maximum, the kits stop');
  let g = petPotionFixture(); g.PetPotion.seenMax.clear();
  g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 52, refObjId: 500, band: 3, hp: 300, status: 5, dead: false }] });
  g.Controller.tick();
  assert.equal(g.PetPotion.pets()[0].max, 300, 'a first-seen pet measures against its own current HP until a higher value shows');
  g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 52, refObjId: 500, band: 3, hp: 500, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(g.PetPotion.pets()[0].max, 500, 'a later higher HP raises the learned maximum');
});
test('a rested pet is unblocked the moment its HP moves again', () => {
  const f = petPotionFixture();
  const consume = quantity => f.World.applyGameplay({ ...f.World.gp,
    inventory: f.World.gp.inventory.map(i => i.slot === 21 ? { ...i, quantity } : i),
    cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, status: 5, dead: false }] });
  for (let n = 0; n < 3; n++) {
    f.Controller.tick(); consume(4 - n); f.advance(2000);
    f.Controller.tick(); f.advance(2000);
  }
  f.Controller.tick();
  assert.equal(petUses(f).length, 3, 'the flat guard rests the pet');
  assert.ok((f.PetPotion.blocked.get(50) ?? 0) > 0, 'rested');
  // The reading comes back to life (the pet takes damage): the rest lifts at once instead of letting it die.
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 240, status: 5, dead: false }] });
  f.Controller.tick();
  assert.equal(f.PetPotion.blocked.has(50), false, 'a moving HP lifts the rest immediately');
  assert.equal(petUses(f).length, 4, 'and the kits flow again');
});
test('a pet whose HP never rises on confirmed kits is rested, not drained', () => {
  const f = petPotionFixture();
  const events = []; f.Activity.emit = e => events.push(e);
  const consume = quantity => f.World.applyGameplay({ ...f.World.gp,
    inventory: f.World.gp.inventory.map(i => i.slot === 21 ? { ...i, quantity } : i),
    cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, status: 5, dead: false }] });
  for (let n = 0; n < 3; n++) {
    f.Controller.tick(); assert.equal(petUses(f).length, n + 1, 'kit ' + (n + 1) + ' goes out');
    consume(4 - n); f.advance(2000);
    f.Controller.tick(); f.advance(2000);
  }
  f.Controller.tick(); assert.equal(petUses(f).length, 3, 'no fourth kit after three confirmed kits with no HP movement');
  assert.match(f.PetPotion.message, /5 min/);
  assert.ok(events.some(e => e.code === 'pet-kit-flat' && e.details.gid === 50), 'the rest is reported as an activity event');
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 3, 'the five-minute rest holds');
  f.advance(300000); f.Controller.tick(); assert.equal(petUses(f).length, 4, 'after the rest a wrong reading only burns one kit per round');
});
test('a heal that lands a snapshot after the consumption is never counted flat', () => {
  const f = petPotionFixture();
  f.Controller.tick(); assert.equal(petUses(f).length, 1);
  f.advance(1000);
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 21 ? { ...i, quantity: 4 } : i), cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, status: 5, dead: false }] });
  f.Controller.tick();
  assert.equal(f.PetPotion.stale.size, 0, 'the grace window holds the judgement while the HP update is still on its way');
  f.advance(1000);
  f.World.applyGameplay({ ...f.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 1000, status: 5, dead: false }] });
  f.Controller.tick();
  assert.equal(f.PetPotion.stale.size, 0, 'the late heal clears the flat check');
  assert.equal(petUses(f).length, 1, 'and no extra kit was burned');
});
test('kits that raise the pet HP keep flowing without the flat-HP rest', () => {
  const f = petPotionFixture();
  const healTo = (hp, quantity) => f.World.applyGameplay({ ...f.World.gp,
    inventory: f.World.gp.inventory.map(i => i.slot === 21 ? { ...i, quantity } : i),
    cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f).length, 1);
  healTo(500, 4); f.advance(2000);
  f.Controller.tick(); assert.equal(petUses(f).length, 2, 'a partial heal clears the flat counter and the next kit goes out');
  healTo(1000, 3); f.advance(2000);
  f.Controller.tick(); assert.equal(petUses(f).length, 2, 'full HP stops the kits');
});
const PET_FOOD = (9 << 11) | 236; // consumable 3/3/1/9: the companion HGP recovery potion
function petFoodFixture(change = {}) {
  const f = fixture(); f.Settings.profile.potion.petHp.on = false; f.Settings.profile.potion.petHgp.on = true;
  const food = (slot, ref, pct, quantity = 5) => ({ slot, refObjId: ref, typeFlags: PET_FOOD, quantity, name: 'HGP potion', tooltip: { fields: { itemParam1_29c: pct } } });
  f.World.applyGameplay({ ...f.World.gp, inventory: [food(30, 3001, 25), food(31, 3002, 60), food(32, 3003, 90)],
    cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 900, satiety: 2000, status: 5, dead: false }], ...change });
  return f;
}
test('pet auto potion feeds a hungry attack pet with the smallest HGP potion that covers the deficit', () => {
  assert.equal(fixture().Settings.profile.potion.petHgp.on, false);
  const f = petFoodFixture(); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(petUses(f))), [{ kind: 'item-use', slot: 32, companionGid: 50 }], '20% satiety misses 8000: the 90% potion is the smallest that covers it');
  let g = petFoodFixture(); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 900, satiety: 9500, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g).length, 0, 'above the threshold');
  g = petFoodFixture(); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 51, refObjId: 500, band: 4, hp: 900, satiety: 1000, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g).length, 0, 'pickup pets have no HGP gauge and are never fed');
  g = petFoodFixture(); g.World.applyGameplay({ ...g.World.gp, cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 900, status: 5, dead: false }] });
  g.Controller.tick(); assert.equal(petUses(g).length, 0, 'a record without satiety data waits');
});
test('pet HGP feeding confirms consumption, rests when unconfirmed, and yields to recovery kits', () => {
  let f = petFoodFixture(); f.Controller.tick(); assert.equal(petUses(f).length, 1);
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 1, 'no second potion until the first is seen consumed');
  f.advance(4000); f.Controller.tick(); assert.equal(petUses(f).length, 1); assert.match(f.PetPotion.message, /HGP potion consumption unconfirmed/);
  f.advance(31000); f.Controller.tick(); assert.equal(petUses(f).length, 2, 'retried after the 30 s pause');
  f = petFoodFixture(); f.Controller.tick(); assert.equal(petUses(f).length, 1);
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 32 ? { ...i, quantity: 4 } : i), cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 900, satiety: 9500, status: 5, dead: false }] });
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 1, 'a fed pet above the threshold gets no second potion');
  f = petFoodFixture(); f.Settings.profile.potion.petHp.on = true; f.PetPotion.seenMax.set(50, 1000);
  f.World.applyGameplay({ ...f.World.gp, inventory: [...f.World.gp.inventory, { slot: 20, refObjId: 2143, typeFlags: 8428, quantity: 5, tooltip: { fields: { itemParam1_29c: 360 } } }], cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 300, satiety: 2000, status: 5, dead: false }] });
  f.Controller.tick(); assert.equal(petUses(f)[0].slot, 20, 'the recovery kit goes first');
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 20 ? { ...i, quantity: 4 } : i), cosRecords: [{ gid: 50, refObjId: 500, band: 3, hp: 1000, satiety: 2000, status: 5, dead: false }] });
  f.advance(2000); f.Controller.tick(); assert.equal(petUses(f).length, 2); assert.equal(petUses(f)[1].slot, 32, 'then the HGP potion follows');
  f = petFoodFixture(); f.Settings.profile.potion.enabled = false; f.Controller.tick(); assert.equal(petUses(f).length, 0, 'the master potion switch stops feeding too');
});
test('vigor potions are a restock supply with a chosen size, bought on town trips and recognised in shops', () => {
  const f = townFixture(), r = f.Restock.cfg(), c = f.Town;
  assert.equal(fixture().Restock.cfg().vigor.on, false); assert.equal(fixture().Restock.cfg().vigor.refObjId, 22);
  const offer = (ref, tf) => ({ refObjId: ref, name: 'Vigor', tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: ref, typeFlags: tf }] });
  const vigorTf = (3 << 11) | 236;
  assert.equal(f.Restock.offerKind(offer(22, vigorTf)), 'vigor'); assert.equal(f.Restock.offerKind(offer(15, 4332)), 'mp');
  r.vigor.on = true; r.vigor.refObjId = 21; r.vigor.low = 5; r.vigor.target = 40;
  assert.deepEqual(JSON.parse(JSON.stringify(c.supplies().map(s => [s.kind, s.refObjId]))), [['mp', 15], ['vigor', 21]], 'HP/MP keep their fixed X-Large ids; vigor uses the chosen size');
  r.mp.on = false; c.cfg().petFull = false; assert.equal(c.reason(), 'potions running low', 'an empty vigor stock alone triggers a trip'); c.cfg().petFull = true;
  c.begin(); c.enter('buy');
  const gp = f.World.gp; gp.target = 61; gp.targetCapabilities = 1;
  gp.shop = { npc: 61, offers: [offer(15, 4332), offer(21, vigorTf)] }; gp.inventory = gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  c.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'shop-buy', tab: 0, slot: 0, quantity: 40 });
  const g = townFixture(); g.Restock.cfg().vigor.on = true; g.Restock.cfg().vigor.refObjId = 20; g.Restock.cfg().vigor.target = 40;
  g.Town.begin(); g.Town.enter('buy'); g.World.gp.target = 61; g.World.gp.targetCapabilities = 1;
  g.World.gp.shop = { npc: 61, offers: [offer(15, 4332)] }; g.World.gp.inventory = g.World.gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  g.Town.tick(); assert.equal(g.Town.trip, null); assert.match(g.Town.message, /vigor potion size is unavailable/);
});
test('hgp potions are a restock supply bought at the merchant and skipped, not fatal, when not sold', () => {
  const f = townFixture(), r = f.Restock.cfg(), c = f.Town;
  assert.equal(fixture().Restock.cfg().hgp.on, false); assert.equal(fixture().Restock.cfg().hgp.refObjId, 0);
  const offer = (ref, tf) => ({ refObjId: ref, name: 'Pet food', tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: ref, typeFlags: tf }] });
  const hgpTf = (9 << 11) | 236;
  assert.equal(f.Restock.offerKind(offer(3001, hgpTf)), 'hgp', 'companion food is its own shop kind');
  assert.equal(f.Restock.offerKind(offer(2145, (5 << 11) | 236)), '', 'pet MP potions are no shop supply');
  r.hgp.on = true; r.hgp.refObjId = 3001; r.hgp.low = 5; r.hgp.target = 40;
  assert.deepEqual(JSON.parse(JSON.stringify(c.supplies().map(s => [s.kind, s.refObjId]))), [['mp', 15], ['hgp', 3001]], 'the pet food rides the same refill trips');
  c.begin(); c.enter('buy');
  const gp = f.World.gp; gp.target = 61; gp.targetCapabilities = 1;
  gp.shop = { npc: 61, offers: [offer(15, 4332), offer(3001, hgpTf)] }; gp.inventory = gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  c.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'shop-buy', tab: 0, slot: 0, quantity: 40 }, 'the pet food is bought like a potion');
  const g = townFixture(); g.Restock.cfg().hgp.on = true; g.Restock.cfg().hgp.refObjId = 3001; g.Town.cfg().petFull = false;
  g.Town.begin(); g.Town.enter('buy'); g.World.gp.target = 61; g.World.gp.targetCapabilities = 1;
  g.World.gp.shop = { npc: 61, offers: [offer(15, 4332)] }; g.World.gp.inventory = g.World.gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  g.Town.tick(); assert.match(g.Town.message, /does not sell HGP recovery potions/);
  g.Town.tick(); assert.ok(g.Town.trip && g.Town.trip.phase !== 'buy', 'a merchant without pet food skips it and the trip goes on');
  assert.ok(g.Restock.unbuyable.has(3001), 'the merchant is remembered as not selling the pet food');
  assert.ok(!g.Town.supplies().some(s => s.kind === 'hgp'), 'an unsold pet food leaves the refill supplies');
  assert.equal(g.Town.reason(), '', 'and no longer re-triggers town trips for it');
  const h = townFixture(); h.Restock.cfg().hgp.on = true; h.Town.cfg().petFull = false; h.World.gp.inventory = h.World.gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  assert.ok(!h.Town.supplies().some(s => s.kind === 'hgp'), 'an unchosen pet food never rides the trips');
  assert.equal(h.Town.reason(), '', 'and never blocks or triggers restock on its own');
});
test('pet recovery kits are a restock supply bought at the merchant and skipped, not fatal, when not sold', () => {
  const f = townFixture(), r = f.Restock.cfg(), c = f.Town;
  assert.equal(fixture().Restock.cfg().kit.on, false); assert.equal(fixture().Restock.cfg().kit.refObjId, 0);
  const offer = (ref, tf) => ({ refObjId: ref, name: 'Recovery kit', tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: ref, typeFlags: tf }] });
  const kitTf = (4 << 11) | 236;
  assert.equal(f.Restock.offerKind(offer(2143, kitTf)), 'kit', 'companion kits are their own shop kind');
  r.kit.on = true; r.kit.refObjId = 2143; r.kit.low = 5; r.kit.target = 40;
  assert.deepEqual(JSON.parse(JSON.stringify(c.supplies().map(s => [s.kind, s.refObjId]))), [['mp', 15], ['kit', 2143]], 'the kits ride the same refill trips');
  c.begin(); c.enter('buy');
  const gp = f.World.gp; gp.target = 61; gp.targetCapabilities = 1;
  gp.shop = { npc: 61, offers: [offer(15, 4332), offer(2143, kitTf)] }; gp.inventory = gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  c.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'shop-buy', tab: 0, slot: 0, quantity: 40 }, 'the kit is bought like a potion');
  const g = townFixture(); g.Restock.cfg().kit.on = true; g.Restock.cfg().kit.refObjId = 2143;
  g.Town.begin(); g.Town.enter('buy'); g.World.gp.target = 61; g.World.gp.targetCapabilities = 1;
  g.World.gp.shop = { npc: 61, offers: [offer(15, 4332)] }; g.World.gp.inventory = g.World.gp.inventory.map(i => i.refObjId === 15 ? { ...i, quantity: 50 } : i);
  g.Town.tick(); assert.match(g.Town.message, /does not sell pet recovery kits/);
  g.Town.tick(); assert.ok(g.Town.trip && g.Town.trip.phase !== 'buy', 'a merchant without kits skips them and the trip goes on');
});
const GRASS = (6 << 11) | 236; // consumable 3/3/1/6: the companion revival item (Grass of life)
function deadPetFixture() {
  const f = townFixture(), c = f.Town;
  c.cfg().petFull = false; c.cfg().revivePet = true;
  c.detect = () => ({ key: 'KT' });
  f.World.gp.inventory.push({ slot: 16, refObjId: 7001, typeFlags: 2284, quantity: 1, name: 'Wolf collar', summon: { state: 4, refObjId: 600, name: 'Wolf', rentals: [] } },
    { slot: 17, refObjId: 7552, typeFlags: GRASS, quantity: 3, name: 'Grass of life' });
  return f;
}
test('a dead pet starts a town trip and is revived with a Grass of life, then summoned again', () => {
  assert.equal(fixture().Town.cfg().revivePet, false);
  const f = deadPetFixture(), c = f.Town;
  assert.equal(c.reason(), 'a pet is down');
  let g = deadPetFixture(); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.refObjId !== 7552);
  assert.equal(g.Town.reason(), 'potions running low', 'a dead pet without a grass does not start a trip for it');
  g = deadPetFixture(); g.Town.cfg().revivePet = false;
  assert.equal(g.Town.reason(), 'potions running low', 'the pet revival is off by default');
  c.begin(); assert.equal(c.trip.phase, 'pet-revive', 'the revival comes first, before the services');
  c.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'item-use', slot: 17, revivalSlot: 16 }, 'the grass names the dead pet collar');
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 16 ? { ...i, summon: { ...i.summon, state: 3 } } : i.slot === 17 ? { ...i, quantity: 2 } : i) });
  f.advance(2000); c.tick(); f.advance(2000); c.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'item-use', slot: 16 }, 'the collar is used again to summon the pet');
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.map(i => i.slot === 16 ? { ...i, summon: { ...i.summon, state: 2 } } : i), cosRecords: [...f.World.gp.cosRecords, { gid: 71, refObjId: 600, band: 3, hp: 900, status: 5, dead: false }] });
  f.advance(2000); c.tick();
  assert.equal(c.trip.phase, 'walk-storage', 'the services continue once the pet is back');
});
test('an unaccepted Grass of life never stops the town trip and rests the retry', () => {
  const f = deadPetFixture(), c = f.Town;
  c.begin(); assert.equal(c.trip.phase, 'pet-revive');
  c.tick(); assert.equal(f.commands.at(-1).kind, 'item-use');
  f.advance(13000); c.tick();
  assert.equal(c.trip.phase, 'walk-storage', 'the trip continues without the pet');
  assert.match(c.message, /was not accepted/);
  assert.equal(c.reason(), 'potions running low', 'the dead pet does not start another trip at once');
  f.advance(610000); assert.equal(c.reason(), 'a pet is down', 'retried ten minutes later');
});
test('a collar that vanishes while the grass is in flight is not a revival', () => {
  const f = deadPetFixture(), c = f.Town;
  c.begin(); c.tick(); assert.equal(f.commands.at(-1).kind, 'item-use');
  f.World.applyGameplay({ ...f.World.gp, inventory: f.World.gp.inventory.filter(i => i.slot !== 16) });
  f.advance(2000); c.tick();
  assert.equal(c.trip.phase, 'pet-revive', 'a missing collar confirms nothing');
  assert.ok(!f.commands.some(x => x.kind === 'item-use' && x.slot === 16), 'no summon is sent for it');
  f.advance(12000); c.tick();
  assert.equal(c.trip.phase, 'walk-storage', 'the timeout ends the attempt and the trip goes on');
});
function reconnectFixture() {
  const f = fixture(), sent = []; f.World.charName = 'Tester'; f.Hunt.start();
  f.Hook.post = msg => { if (msg.kind === 'session') sent.push(JSON.parse(JSON.stringify(msg.command))); };
  const lose = (phase = 'disconnected') => { f.World.phase = phase; f.bus.emit('phase', phase, 'world', true); f.stopAll(); f.World.gp = null; };
  const back = () => { f.World.phase = 'world'; f.World.gp = { ...fixture().World.gp }; };
  return { f, sent, lose, back };
}
test('the bot reconnects by itself after a server restart: resume first, then a fresh entry, then hunting again', () => {
  const { f, sent, lose } = reconnectFixture();
  lose(); assert.equal(f.Reconnect.active(), true); assert.equal(f.Hunt.running, false);
  f.advance(3000); f.Controller.tick(); assert.deepEqual(sent, [{ kind: 'reconnect' }], 'the game\'s own resume first');
  f.advance(3000); f.Controller.tick(); assert.equal(sent.length, 1, 'waits for the attempt to play out');
  f.advance(9000); f.Controller.tick(); assert.deepEqual(sent.at(-1), { kind: 'enter-world', character: 'Tester' }, 'then a fresh entry with the held login');
  f.advance(8000); f.Controller.tick(); f.advance(11000); f.Controller.tick(); assert.ok(sent.length >= 3);
  assert.ok(f.notices.some(n => /reconnecting automatically/.test(n)));
  assert.match(f.Diagnostics.main(), /Reconnecting/);
});
test('after reconnecting, hunting that was running resumes at the hunting spot, and only then', () => {
  let { f, lose, back } = reconnectFixture();
  lose(); back(); f.advance(100); f.Controller.tick(); assert.equal(f.Hunt.running, false, 'settles for a moment first');
  f.advance(3500); f.Controller.tick(); assert.equal(f.Hunt.running, true); assert.equal(f.Reconnect.active(), false);
  ({ f, lose, back } = reconnectFixture()); f.Hunt.stop(); lose('reconnecting'); back(); f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'a stopped bot is reconnected but not started');
  ({ f, lose, back } = reconnectFixture()); lose(); back(); f.World.gp.pose = { ...f.World.gp.pose, x: 200000 }; f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.equal(f.Reconnect.active(), false);
  ({ f, lose, back } = reconnectFixture()); f.Hunt.cfg().onDeath = 'revive'; lose(); back(); f.World.isDead = () => true; f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.equal(f.Hunt.running, true, 'killed while disconnected: hunting restarts so the death handling revives and returns');
  assert.equal(f.Reconnect.active(), false);
  ({ f, lose, back } = reconnectFixture()); lose('reconnecting'); back(); f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.equal(f.Hunt.running, true, 'a short drop the game recovered from resumes too');
});
test('after reconnecting in town, far from the hunting spot, the bot does town services and reverses instead of walking', () => {
  const { f, lose, back } = reconnectFixture(); let began = null;
  f.Town.autoRevive = () => true; f.Town.detect = () => ({}); f.Town.begin = revival => { began = revival; f.Town.trip = { phase: 'revive-arrival' }; };
  lose(); back(); f.World.gp.pose = { ...f.World.gp.pose, x: 200000 }; f.World.pose = () => f.World.gp.pose;
  f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.equal(began, true, 'revival-style town trip'); assert.equal(f.WalkBack.active, null); assert.equal(f.Reconnect.active(), false);
});
test('hunting from town far from the spot (dead at login, woke in town) does town services and reverses instead of walking', () => {
  const f = fixture(); let began = null, arrived = 0;
  f.Town.cfg().enabled = true; f.Town.detect = () => ({ key: 'KT' });
  f.Town.begin = revival => { began = revival; f.Town.trip = { phase: 'revive-arrival' }; };
  f.Town.arrived = () => { arrived++; };
  f.Settings.profile.hunt.center = { regionId: 1, x: 1500, y: 0, z: 100 };
  f.Hunt.start(); f.commands.length = 0;
  f.Hunt.tick();
  assert.equal(began, true, 'revival-style town trip'); assert.equal(arrived, 1, 'services start from where the character stands');
  assert.equal(f.commands.some(c => c.kind === 'move' && c.destination?.x === 1500), false, 'no straight walk from town to the spot');
  assert.equal(f.WalkBack.active, null);
});
test('far from the spot outside the town, hunting still returns the old way (town cycle untouched)', () => {
  const f = fixture(); let began = null;
  f.Town.cfg().enabled = true; f.Town.detect = () => null;
  f.Town.begin = revival => { began = revival; };
  f.Settings.profile.hunt.center = { regionId: 1, x: 1500, y: 0, z: 100 };
  f.Hunt.start(); f.commands.length = 0;
  f.Hunt.tick();
  assert.equal(began, null, 'no town trip outside town');
  assert.ok(f.commands.some(c => c.kind === 'move' && c.destination?.x === 1500), 'moves back toward the spot as before');
});
test('resume hunting in town with the town cycle on reverses instead of walking; elsewhere it still walks', () => {
  let f = fixture(), began = null;
  f.Town.cfg().enabled = true; f.Town.detect = () => ({ key: 'KT' });
  f.Town.begin = revival => { began = revival; f.Town.trip = { phase: 'buy' }; };
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  assert.equal(f.Controller.resumeHunting('Back in the game'), 'town'); assert.equal(began, true); assert.equal(f.WalkBack.active, null);
  f = fixture(); f.Town.cfg().enabled = false; f.Town.detect = () => ({ key: 'KT' });
  f.Settings.profile.hunt.center = { regionId: 6, x: 500, y: 0, z: 100 };
  assert.equal(f.Controller.resumeHunting('Back in the game'), 'walking', 'town cycle off: walks as before');
});
test('after reconnecting in town away from the scroll landing spot, the services start from where the character stands', () => {
  const town = { key: 'KT' }, setup = f => {
    const c = f.Town.cfg(); c.enabled = true; c.revive = true; c.arrival = { regionId: 1, x: 190000, y: 0, z: 100 };
    for (const [index, role] of ['storage', 'vendor', 'smith', 'gate'].entries()) c[role] = { gid: 60 + index, refObjId: 600 + index, regionId: 1, x: 200100 + index * 40, y: 0, z: 100 };
    const r = f.Restock.cfg(); r.hp.on = false; r.mp.refObjId = 15; r.mp.low = 5; r.mp.target = 50;
    f.World.gp.inventory = [{ slot: 13, refObjId: 200, typeFlags: 0x09ec, quantity: 3 }, { slot: 14, refObjId: 201, typeFlags: 0x19ec, quantity: 2 }, { slot: 15, refObjId: 15, typeFlags: 4332, quantity: 1 }];
  };
  const { f, lose, back } = reconnectFixture(); f.Town.detect = () => town; setup(f);
  lose(); back(); setup(f); f.World.gp.pose = { ...f.World.gp.pose, x: 200000 }; f.World.pose = () => f.World.gp.pose;
  f.advance(4000); f.Controller.tick(); f.advance(4000); f.Controller.tick();
  assert.ok(f.Town.trip, f.Town.message); assert.equal(f.Town.trip.revival, true);
  assert.equal(f.Town.trip.phase, 'walk-storage', 'no waiting at the landing spot 1 km away');
  assert.equal(f.Reconnect.active(), false);
  // In another town none of the saved services are near: no town cycle (it would only time out).
  const g = reconnectFixture(); let n = 0; g.f.Town.detect = () => (n++ % 2 ? { key: 'KT' } : { key: 'DW' }); setup(g.f);
  g.lose(); g.back(); setup(g.f); g.f.World.gp.pose = { ...g.f.World.gp.pose, x: 200000 }; g.f.World.pose = () => g.f.World.gp.pose;
  g.f.advance(4000); g.f.Controller.tick(); g.f.advance(4000); g.f.Controller.tick();
  assert.equal(g.f.Town.trip, null); assert.equal(g.f.Reconnect.active(), false);
});
test('reconnect never fights the player: logout, disconnect, exit or a manual login cancel it; a lost login is reported', () => {
  for (const kind of ['logout', 'disconnect', 'exit', 'restart', 'login', 'enter-world']) {
    const { f, sent, lose } = reconnectFixture(); lose(); f.Hook.observers.forEach(fn => fn({ kind, password: 'secret' }));
    assert.equal(f.Reconnect.active(), false, kind); f.advance(60000); f.Controller.tick(); assert.equal(sent.length, 0, kind);
  }
  const { f, sent, lose } = reconnectFixture(); lose(); f.World.phase = 'signed-out'; f.advance(5000); f.Controller.tick();
  assert.equal(sent.length, 0, 'no credentials, no attempts'); assert.match(f.Reconnect.message, /login is gone/);
  const g = reconnectFixture(); g.lose(); g.f.World.session = { phase: 'disconnected', error: 'Authentication required' }; g.f.advance(5000); g.f.Controller.tick();
  assert.equal(g.sent.length, 0); assert.match(g.f.Reconnect.message, /login is gone/);
  const h = reconnectFixture(); h.lose(); h.f.advance(13 * 3600 * 1000); h.f.Controller.tick(); assert.equal(h.f.Reconnect.active(), false); assert.match(h.f.Reconnect.message, /Gave up/);
  assert.equal(JSON.stringify(h.sent).includes('secret'), false);
});
function deathFixture(onDeath = 'stop') {
  const f = fixture(); f.Settings.profile.party.acceptRes = true; f.Settings.profile.hunt.onDeath = onDeath;
  f.World.ents.set(77, { gid: 77, kind: 'player', name: 'Healer', appearanceState: [0] });
  const social = (extra = {}) => ({ localName: 'Me', self: 10, leader: 10, options: 1, members: [{ id: 10, name: 'Me', status: 0 }, { id: 11, name: 'Healer', status: 10 }], ...extra });
  f.World.gp.social = social(); f.Hunt.start();
  const state = { dead: false }; f.World.isDead = () => state.dead;
  return { f, state, social, die() { state.dead = true; f.World.ents.get(1).appearanceState = [2, 0, 0]; f.Controller.tick(); }, offer() { f.World.gp.social = social({ resurrection: { gid: 77 } }); }, live() { state.dead = false; f.World.ents.get(1).appearanceState = [0, 0, 0]; } };
}
const consents = f => f.commands.filter(c => c.kind === 'resurrection-consent').length;
test('hunting that was on when the character died resumes after an accepted resurrection, whatever On death does', () => {
  for (const mode of ['stop', 'wait', 'revive']) {
    const { f, die, offer, live } = deathFixture(mode); die();
    if (mode === 'stop') assert.equal(f.Hunt.running, false, 'stop mode stops at death as before');
    offer(); f.advance(300); f.Controller.tick(); assert.equal(consents(f), 1, mode);
    f.World.gp.social = { ...f.World.gp.social, resurrection: undefined }; live(); f.advance(300); f.Controller.tick(); f.advance(2500); f.Controller.tick();
    assert.equal(f.Hunt.running, true, mode + ' resumes hunting'); assert.equal(f.Party.resumeHunt, null, mode + ' resume memory consumed');
    assert.equal(f.commands.filter(c => c.kind === 'rebirth').length, 0, mode + ': the bot never revived itself');
  }
});
test('resurrection resume is only for accepted resurrections, expires, and respects where the character is', () => {
  let t = deathFixture('stop'); t.die(); t.live(); t.f.advance(300); t.f.Controller.tick(); t.f.advance(11000); t.f.Controller.tick(); t.f.advance(3000); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false, 'a revive that was not an accepted resurrection resumes nothing'); assert.equal(t.f.Party.huntAtDeath, null);
  t = deathFixture('stop'); t.die(); t.f.advance(16 * 60000); t.offer(); t.f.Controller.tick(); t.live(); t.f.advance(300); t.f.Controller.tick(); t.f.advance(2500); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false, 'after 15 minutes the memory is gone');
  t = deathFixture('stop'); t.f.Hunt.stop(); t.die(); t.offer(); t.f.Controller.tick(); t.live(); t.f.advance(300); t.f.Controller.tick(); t.f.advance(2500); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false, 'a bot that was not hunting stays stopped');
  t = deathFixture('stop'); t.die(); t.offer(); t.f.Controller.tick(); t.live(); t.f.World.gp.pose = { ...t.f.World.gp.pose, x: 100 + 3000 }; t.f.advance(300); t.f.Controller.tick(); t.f.advance(2500); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false); assert.ok(t.f.WalkBack.active, 'a little way off, it walks back to the hunting spot first');
  t = deathFixture('stop'); t.die(); t.offer(); t.f.Controller.tick(); t.live(); t.f.World.gp.pose = { ...t.f.World.gp.pose, regionId: 32769, x: 100 }; t.f.advance(300); t.f.Controller.tick(); t.f.advance(2500); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false); assert.equal(t.f.WalkBack.active, null, 'another world or dungeon stays stopped');
  assert.ok(t.f.notices.some(n => /not at the hunting spot/.test(n)));
  t = deathFixture('stop'); t.die(); t.offer(); t.f.Controller.tick(); t.live(); t.f.World.gp.pose = { ...t.f.World.gp.pose, regionId: 100, x: 100 }; t.f.advance(300); t.f.Controller.tick(); t.f.advance(2500); t.f.Controller.tick();
  assert.equal(t.f.Hunt.running, false); assert.equal(t.f.WalkBack.active, null, 'a spot beyond the safety cap stays stopped');
  assert.ok(t.f.notices.some(n => /too far to walk/.test(n)));
});
test('with Accept resurrection on and a helper in view the bot waits before reviving itself, never during an open offer', () => {
  const rebirths = f => f.commands.filter(c => c.kind === 'rebirth').length;
  let t = deathFixture('revive'); t.die(); t.f.advance(6000); t.f.Controller.tick(); assert.equal(rebirths(t.f), 0, 'helper nearby: still waiting after 6 s');
  t.f.advance(15000); t.f.Controller.tick(); assert.equal(rebirths(t.f), 1, 'then it revives itself');
  t = deathFixture('revive'); t.f.World.ents.delete(77); t.die(); t.f.advance(6000); t.f.Controller.tick(); assert.equal(rebirths(t.f), 1, 'nobody in view: the usual 5 s');
  t = deathFixture('revive'); t.f.Settings.profile.party.acceptRes = false; t.die(); t.f.advance(6000); t.f.Controller.tick(); assert.equal(rebirths(t.f), 1, 'switch off: unchanged');
  t = deathFixture('revive'); t.f.World.ents.set(77, { gid: 77, kind: 'player', name: 'Healer', appearanceState: [2] }); t.die(); t.f.advance(6000); t.f.Controller.tick();
  assert.equal(rebirths(t.f), 1, 'a dead helper cannot resurrect us');
  t = deathFixture('revive'); t.f.Settings.profile.party.acceptRes = false; t.die(); t.offer(); t.f.advance(6000); t.f.Controller.tick(); assert.equal(rebirths(t.f), 0, 'an open resurrection offer is never answered by reviving');
});
test('auto mastery is off by default, ignores dead characters and pending training, and backs off after a refusal', () => {
  assert.equal(fixture().Settings.profile.mastery.enabled, false);
  let f = masteryFixture(); f.Settings.profile.mastery.enabled = false; f.Controller.tick(); assert.deepEqual(trains(f), []);
  f = masteryFixture(); f.World.isDead = () => true; f.Controller.tick(); assert.deepEqual(trains(f), []);
  f = masteryFixture(); f.World.applyGameplay({ ...f.World.gp, trainingPending: true }); f.Controller.tick(); assert.deepEqual(trains(f), []);
  f = masteryFixture(); f.World.applyGameplay({ ...f.World.gp, trainingError: 'Training result is unknown. Reconnect before trying again.' }); f.Controller.tick();
  assert.deepEqual(trains(f), []); assert.match(f.AutoMastery.status(), /Reconnect/);
  f = masteryFixture(); f.Controller.tick(); assert.deepEqual(trains(f), [257]);
  f.advance(11000); f.Controller.tick(); assert.deepEqual(trains(f), [257, 273], 'refused mastery is skipped, the next one is tried');
  f.advance(3000); f.Controller.tick(); assert.deepEqual(trains(f), [257, 273]);
  f.advance(61000); f.World.applyGameplay({ ...f.World.gp, progression: { ...f.World.gp.progression, masteries: [{ id: 257, level: 10 }, { id: 273, level: 1 }, { id: 274, level: 30 }] } });
  f.Controller.tick(); assert.equal(trains(f).at(-1), 257, 'retried after the backoff');
});
test('pet picks up during combat and casting even with finish-fight enabled', () => {
  const f = fixture(); petFight(f); f.drop(20, 3436); let fights = 0;
  f.Combat.fight = () => { fights++; }; f.World.isCasting = () => true;
  assert.equal(f.Settings.profile.hunt.pickup.afterKillOnly, true);
  f.Hunt.tick(); assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 1);
  assert.equal(fights, 1); assert.equal(f.Hunt.state, 'fight'); assert.ok(f.Loot.active);
  f.advance(500); f.Hunt.tick(); assert.equal(fights, 2); assert.ok(f.Loot.active);
  assert.equal(f.commands.some(c => c.kind === 'pickup' || c.kind === 'move'), false);
});
test('pet pickup confirmation and retries do not pause combat or move the player', () => {
  const f = fixture(), pet = petFight(f); f.drop(20, 3436); let fights = 0;
  f.Combat.fight = () => { fights++; }; f.Hunt.tick();
  f.advance(9000); f.Hunt.tick(); f.advance(800); f.Hunt.tick();
  assert.equal(f.commands.filter(c => c.kind === 'cos-pickup').length, 2); assert.equal(fights, 3);
  pet.inventory.push({ slot: 0, refObjId: 101, quantity: 1 }); f.Hunt.tick();
  assert.equal(f.Stats.values.loot, 1); assert.equal(fights, 4);
  assert.equal(f.commands.some(c => c.kind === 'move'), false);
});
test('pet waits for inventory and potion priority without holding up combat', () => {
  const f = fixture(); petFight(f); f.drop(20, 3436); let fights = 0;
  f.Combat.fight = () => { fights++; }; f.World.gp.inventoryPending = true;
  f.Hunt.tick(); assert.equal(fights, 1); assert.equal(f.Loot.active, null);
  f.World.gp.inventoryPending = false; f.Potion.lastUse = 100000;
  f.Hunt.tick(); assert.equal(fights, 2); assert.equal(f.Loot.active, null);
});
function townFixture() {
  const f = fixture(), c = f.Town.cfg(), r = f.Restock.cfg(), gp = f.World.gp;
  c.enabled = true; c.arrival = { regionId: 1, x: 100, y: 0, z: 100 }; c.keep = 'favorite';
  for (const [index, role] of ['storage', 'vendor', 'smith', 'gate'].entries()) {
    const npc = { gid: 60 + index, refObjId: 600 + index, kind: role === 'gate' ? 'teleport' : 'npc', name: role, regionId: 1, x: 130 + index * 40, y: 0, z: 100 };
    c[role] = { ...npc }; f.World.ents.set(npc.gid, npc);
  }
  r.hp.on = false; r.mp.refObjId = 15; r.mp.low = 5; r.mp.target = 50;
  gp.inventory = [
    { slot: 6, refObjId: 900, typeFlags: 44 | (6 << 7), durability: 5, variance: '0', magic: [], tooltip: { fields: { canRepair: 1, varianceIntMin1c0: 10, varianceIntMax1c4: 10 } } },
    { slot: 13, refObjId: 200, typeFlags: 0x09ec, quantity: 3 },
    { slot: 14, refObjId: 201, typeFlags: 0x19ec, quantity: 2 },
    { slot: 15, refObjId: 15, typeFlags: 4332, quantity: 1 },
  ];
  const pet = pickupPet(f);
  pet.inventory = [
    { slot: 0, refObjId: 1000, typeFlags: 3436, quantity: 2, name: 'Elixir' },
    { slot: 1, refObjId: 1001, typeFlags: 5484, quantity: 1, name: 'Powder' },
    { slot: 2, refObjId: 1002, typeFlags: 44 | (6 << 7), quantity: 1, name: 'Favorite sword' },
    { slot: 3, refObjId: 15, typeFlags: 4332, quantity: 5, name: 'MP potion' },
    { slot: 4, refObjId: 1003, typeFlags: 108, quantity: 1, name: 'Other item' },
  ];
  gp.pose.x = 700; f.Settings.profile.hunt.center.x = 700;
  f.Hunt.start();
  // The death-return tests below exercise the death-location choice; the default is covered by its own test.
  c.deathReturn = 'death'; f.Town.deathPoint = { ...f.Settings.profile.hunt.center };
  return { ...f, pet };
}
test('a wrong saved arrival point is replaced by where the return scroll actually lands', () => {
  const f = townFixture(), c = f.Town.cfg(), gp = f.World.gp;
  f.Town.detect = () => ({ key: 'KT' });
  c.arrivalRadius = 500; c.arrival = { ...gp.pose, x: gp.pose.x + 760 };
  f.Town.begin(); const t = f.Town.trip; t.phase = 'recall-wait'; t.at = f.now ? f.now() : t.at; t.transition = true;
  t.scrollRequest = { slot: 13, ref: 200, quantity: 3, state: gp, accepted: true, at: t.at };
  f.World.gp.returnScroll = false; const here = { ...gp.pose };
  assert.equal(f.Town.tick(), true); assert.match(f.Town.message, /Waiting for arrival area: 76 m/);
  f.advance(1500); f.Town.tick(); assert.notDeepEqual(JSON.parse(JSON.stringify(c.arrival)), JSON.parse(JSON.stringify(here)), 'not yet: it must settle first');
  f.advance(1600); f.Town.tick();
  assert.equal(c.arrival.x, here.x); assert.notEqual(f.Town.trip, null, 'the trip carries on after the point is replaced');
  assert.equal(f.Town.trip.phase, 'walk-storage');
  const g = townFixture(); g.Town.detect = () => null; g.Town.cfg().arrival = { ...g.World.gp.pose, x: g.World.gp.pose.x + 760 };
  g.Town.begin(); g.Town.trip.phase = 'recall-wait'; g.Town.trip.transition = true; g.Town.trip.scrollRequest = { slot: 13, ref: 200, quantity: 3, state: g.World.gp, accepted: true, at: 0 };
  g.World.gp.returnScroll = false; g.Town.tick(); g.advance(4000); g.Town.tick();
  assert.equal(g.Town.cfg().arrival.x, g.World.gp.pose.x + 760, 'outside any known town the saved point is left alone');
});
test('a town can be chosen and set up from anywhere, with the arrival point where its return scroll lands', () => {
  const f = fixture(), c = f.Town.cfg();
  f.World.gp.pose = { regionId: 1, x: 100, y: 0, z: 100 };
  assert.equal(f.Town.autoSetup(false, 'KT') && c.arrival.regionId, 23687, 'chosen town is set up although the character is far away');
  assert.deepEqual([c.arrival.x, c.arrival.y, c.arrival.z], [1138, 250, 153], 'Hotan arrival is the recall spawn from the server data');
  assert.equal(c.storage.refObjId, 2083); assert.equal(c.gate.refObjId, 2096); assert.equal(f.Town.validate().includes('Save missing town services'), false);
  const other = f.Town.autoSetup(true, 'CH');
  assert.equal(other.town, 'Jangan'); assert.deepEqual([c.arrival.regionId, c.arrival.x, c.arrival.z], [25000, 969, 1369]); assert.equal(c.vendor.refObjId, 2005);
  for (const town of f.Town.towns) assert.ok(town.arrival && Number.isFinite(town.arrival.x), town.name + ' has an arrival point');
  assert.equal(f.Town.autoSetup(true, 'nowhere'), null);
});
test('automatic town setup detects the town and fills only what is missing', () => {
  const f = fixture(), c = f.Town.cfg(), at = (regionId, x, z) => ({ regionId, x, y: 243, z });
  assert.deepEqual(JSON.parse(JSON.stringify(f.Town.towns.map(t => t.name))), ['Constantinople', 'Donwhang', 'Hotan', 'Jangan', 'Samarkand']);
  f.World.gp.pose = at(23687, 1100, 600);
  assert.equal(f.Town.detect().name, 'Hotan'); assert.equal(f.Town.detect(at(25000, 900, 900)).name, 'Jangan');
  assert.equal(f.Town.detect(at(27244, 900, 400)).name, 'Samarkand', 'a town spread over three regions is recognised');
  assert.equal(f.Town.detect(at(1, 100, 100)), null);
  f.Hunt.running = true; assert.equal(f.Town.autoSetup(), null); assert.equal(c.arrival, null); f.Hunt.running = false;
  const done = f.Town.autoSetup();
  assert.equal(done.town, 'Hotan'); assert.deepEqual(JSON.parse(JSON.stringify(done.saved)), ['arrival point', 'warehouse', 'potion merchant', 'repair merchant', 'world statue']);
  assert.equal(c.arrival.regionId, 23687); assert.equal(c.storage.refObjId, 2083); assert.equal(c.vendor.refObjId, 2074);
  assert.equal(c.smith.refObjId, 2072); assert.equal(c.gate.refObjId, 2096); assert.equal(f.Town.validate().includes('Save missing town services'), false);
  for (const role of ['storage', 'vendor', 'smith', 'gate']) {
    const npc = c[role].npc, spot = c[role];
    const gap = Math.hypot(spot.x - npc.x, spot.z - npc.z); assert.ok(gap >= 39 && gap <= 81, role + ' stands a few metres from the NPC');
    assert.equal(spot.regionId, npc.regionId);
  }
  c.vendor = { ...c.vendor, name: 'Mine' }; c.smith = null;
  assert.deepEqual(JSON.parse(JSON.stringify(f.Town.autoSetup().saved)), ['repair merchant']); assert.equal(c.vendor.name, 'Mine', 'saved services are kept');
  assert.equal(f.Town.autoSetup().saved.length, 0); assert.match(f.Town.message, /already saved/);
  assert.equal(f.Town.autoSetup(true).saved.length, 5); assert.equal(c.vendor.name, 'Hotan potion merchant');
  f.World.gp.pose = at(25000, 900, 900); const other = f.Town.autoSetup();
  assert.equal(other.town, 'Jangan'); assert.equal(other.saved.length, 5, 'an arrival point from another town replaces everything');
  assert.equal(c.arrival.regionId, 25000); assert.equal(c.gate.refObjId, 2094);
  f.World.gp.pose = at(1, 100, 100); const before = JSON.stringify(c); assert.equal(f.Town.autoSetup(), null); assert.equal(JSON.stringify(c), before);
  assert.match(f.Town.message, /no known town around you/);
});
test('town cycle recalls, confirms pet storage and purchases, repairs, reverses and resumes', () => {
  const f = townFixture(), gp = f.World.gp, commands = f.commands;
  f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  const stored = [], sold = [], buys = [], phases = [];
  let handled = 0;
  for (let n = 0; n < 140; n++) {
    f.Controller.tick();
    if (f.Town.trip) phases.push(f.Town.trip.phase);
    while (handled < commands.length) {
      const c = commands[handled++];
      if (c.kind === 'item-use') {
        assert.equal(c.slot, 13); gp.inventory.find(i => i.slot === 13).quantity--;
        f.bus.emit('phase', 'entering-world'); f.bus.emit('reset');
        gp.pose.x = 100; f.Navigation.install(navProduct());
      } else if (c.kind === 'move') gp.pose = { ...c.destination };
      else if (c.kind === 'select') {
        gp.target = c.gid; gp.targetCapabilities = {60:4,61:1,62:9,63:0x20000080}[c.gid];
        if (c.gid === 63) gp.npcConversation = { gid: 63, phase: 'menu' };
      } else if (c.kind === 'storage-open') gp.storage = { npc: c.gid, phase: 'open', capacity: 30, items: [] };
      else if (c.kind === 'cos-transfer') {
        const i = f.pet.inventory.find(i => i.slot === c.source);
        gp.inventory.push({ ...i, slot: c.destination }); f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.source);
      } else if (c.kind === 'storage-move') {
        const i = gp.inventory.find(i => i.slot === c.move.source);
        stored.push(i.refObjId); gp.storage.items.push({ ...i, slot: c.move.destination });
        gp.inventory = gp.inventory.filter(i => i.slot !== c.move.source);
      } else if (c.kind === 'shop-open') {
        gp.shop = { npc: c.gid, offers: [{ refObjId: 15, name: 'MP', tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: 15, typeFlags: 4332 }] }] };
        gp.shopCompletionRevision++;
      } else if (c.kind === 'cos-shop-sell') {
        assert.equal(gp.shop.npc, 62); assert.equal(c.gid, f.pet.gid);
        const item = f.pet.inventory.find(i => i.slot === c.slot);
        assert.equal(c.quantity, item.quantity ?? 1); sold.push(item.refObjId);
        f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.slot);
      } else if (c.kind === 'shop-buy') { buys.push(c.quantity); gp.inventory.find(i => i.refObjId === 15).quantity += c.quantity; }
      else if (c.kind === 'shop-repair') gp.inventory.find(i => i.slot === 6).durability = 10;
      else if (c.kind === 'npc-close') { gp.target = 0; gp.shop = null; gp.storage = null; }
      else if (c.kind === 'npc-talk') gp.npcConversation = { gid: gp.target, phase: 'menu' };
      else if (c.kind === 'travel-gate') {
        assert.equal(c.gid, 63); assert.equal(c.type, 5); assert.equal(c.target, 2);
        f.bus.emit('phase', 'entering-world'); f.bus.emit('reset'); gp.pose.x = 700;
      }
    }
    f.advance(600);
    if (!f.Town.trip && phases.includes('reverse-wait')) break;
  }
  assert.equal(f.Town.trip, null, f.Town.message); assert.equal(f.Hunt.running, true, f.Town.message);
  assert.deepEqual(stored, [1000]); assert.deepEqual(sold, [1001, 1003]); assert.deepEqual(buys, [49]);
  assert.equal(f.pet.inventory.length, 2); assert.equal(gp.inventory.find(i => i.slot === 6).durability, 10);
  assert.equal(commands.filter(c => c.kind === 'item-use').length, 1);
  assert.equal(commands.filter(c => c.kind === 'travel-gate').length, 1);
  assert.match(f.Town.message, /complete/);
});
test('without a reverse scroll the town cycle still runs, skips the statue and walks back to hunt', () => {
  const f = townFixture(), gp = f.World.gp, commands = f.commands;
  gp.inventory = gp.inventory.filter(i => i.slot !== 14);
  f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  const phases = [];
  let handled = 0;
  for (let n = 0; n < 200; n++) {
    f.Controller.tick();
    if (f.Town.trip) phases.push(f.Town.trip.phase);
    while (handled < commands.length) {
      const c = commands[handled++];
      if (c.kind === 'item-use') {
        gp.inventory.find(i => i.slot === 13).quantity--;
        f.bus.emit('phase', 'entering-world'); f.bus.emit('reset');
        gp.pose.x = 100; f.Navigation.install(navProduct());
      } else if (c.kind === 'move') gp.pose = { ...c.destination };
      else if (c.kind === 'select') { gp.target = c.gid; gp.targetCapabilities = {60:4,61:1,62:9,63:0x20000080}[c.gid]; }
      else if (c.kind === 'storage-open') gp.storage = { npc: c.gid, phase: 'open', capacity: 30, items: [] };
      else if (c.kind === 'cos-transfer') {
        const i = f.pet.inventory.find(i => i.slot === c.source);
        gp.inventory.push({ ...i, slot: c.destination }); f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.source);
      } else if (c.kind === 'storage-move') {
        const i = gp.inventory.find(i => i.slot === c.move.source);
        gp.storage.items.push({ ...i, slot: c.move.destination }); gp.inventory = gp.inventory.filter(i => i.slot !== c.move.source);
      } else if (c.kind === 'shop-open') {
        gp.shop = { npc: c.gid, offers: [{ refObjId: 15, name: 'MP', tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: 15, typeFlags: 4332 }] }] };
        gp.shopCompletionRevision++;
      } else if (c.kind === 'cos-shop-sell') f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.slot);
      else if (c.kind === 'shop-buy') gp.inventory.find(i => i.refObjId === 15).quantity += c.quantity;
      else if (c.kind === 'shop-repair') gp.inventory.find(i => i.slot === 6).durability = 10;
      else if (c.kind === 'npc-close') { gp.target = 0; gp.shop = null; gp.storage = null; }
    }
    f.advance(600);
    if (phases.includes('leave') && !f.Town.trip && !f.WalkBack.active) break;
  }
  assert.equal(f.Town.trip, null, f.Town.message);
  assert.ok(phases.includes('leave'), 'the trip ends with the walk back');
  assert.equal(phases.some(p => /gate|reverse/.test(p)), false, 'the world statue is not visited');
  assert.equal(commands.some(c => c.kind === 'travel-gate'), false);
  assert.equal(commands.some(c => c.kind === 'select' && c.gid === 63), false);
  assert.equal(f.WalkBack.active, null, 'the walk reached the hunting spot');
  const center = f.Settings.profile.hunt.center;
  assert.ok(Math.hypot(gp.pose.x - center.x, gp.pose.z - center.z) <= 12, JSON.stringify(gp.pose));
  assert.equal(f.Hunt.running, true, 'hunting resumes on arrival');
});
test('Back to the hunting spot: Walk needs no world statue, never refills or spends reverse scrolls', () => {
  const f = townFixture(), c = f.Town.cfg(), gp = f.World.gp;
  assert.equal(f.botProfile({}).potion.restock.town.returnBy, 'reverse', 'the default keeps the reverse return');
  assert.equal(f.botProfile({ potion: { restock: { town: { returnBy: 'fly' } } } }).potion.restock.town.returnBy, 'reverse');
  assert.equal(f.botProfile({ potion: { restock: { town: { returnBy: 'walk' } } } }).potion.restock.town.returnBy, 'walk');
  c.returnBy = 'walk'; c.gate = null;
  assert.equal(f.Town.validate(), ''); assert.equal(f.Town.reverses(), false, 'a carried reverse scroll is kept, not used');
  assert.deepEqual([...f.Town.order(false)], ['storage', 'vendor', 'smith']);
  assert.equal(f.Town.closeNext('close-smith'), 'leave');
  f.Town.begin(); f.Town.enter('buy'); gp.inventory.find(i => i.refObjId === 15).quantity = 50; gp.target = 61;
  gp.inventory = gp.inventory.filter(i => i.slot !== 14);
  gp.shop = { npc: 61, offers: [{ refObjId: 201, tab: 0, slot: 4, maxStack: 50, price: '50', currency: 1, previews: [{ refObjId: 201, typeFlags: 0x19ec }] }] };
  f.Town.buy(); assert.equal(f.commands.some(cmd => cmd.kind === 'shop-buy'), false, 'no reverse scroll is bought');
  assert.equal(f.Town.trip.phase, 'close-vendor');
});
test('reverse chosen but none carried: the vendor refill is tried, else the trip walks back instead of stopping', () => {
  const f = townFixture(), gp = f.World.gp;
  gp.inventory = gp.inventory.filter(i => i.slot !== 14);
  assert.equal(f.Town.validate(), ''); assert.equal(f.Town.validate(true), '', 'revival no longer needs a reverse scroll');
  assert.equal(f.Town.closeNext('close-smith'), 'leave');
  f.Town.begin(); f.Town.enter('buy'); gp.inventory.find(i => i.refObjId === 15).quantity = 50; gp.target = 61;
  const offer = { refObjId: 201, tab: 0, slot: 4, maxStack: 50, price: '50', currency: 1, previews: [{ refObjId: 201, typeFlags: 0x19ec }] };
  gp.shop = { npc: 61, offers: [offer] }; f.Town.buy();
  assert.equal(f.commands.at(-1).kind, 'shop-buy'); assert.equal(f.commands.at(-1).slot, 4, 'a gold reverse offer is still used');
  gp.inventory.push({ slot: 14, refObjId: 201, typeFlags: 0x19ec, quantity: 2 });
  assert.equal(f.Town.closeNext('close-smith'), 'walk-gate', 'with a bought reverse scroll the trip reverses');
  const g = townFixture(); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 14);
  g.Town.begin(); g.Town.enter('buy'); g.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50; g.World.gp.target = 61;
  g.World.gp.shop = { npc: 61, offers: [] }; g.Town.buy();
  assert.ok(g.Town.trip, g.Town.message); assert.equal(g.Town.trip.phase, 'close-vendor', 'no reverse offer is not an error');
});
test('the walk back leaves only after the final checks and stops clearly when it cannot start', () => {
  const ready = f => {
    const gp = f.World.gp; gp.inventory.find(i => i.refObjId === 15).quantity = 50; gp.inventory.find(i => i.slot === 6).durability = 10;
    gp.inventory = gp.inventory.filter(i => i.slot !== 14); gp.pose.x = 100; f.Town.begin(); f.Town.enter('leave');
  };
  let f = townFixture(); ready(f); f.World.gp.inventory.find(i => i.slot === 6).durability = 5;
  f.Town.tick(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /Final supply, repair/);
  f = townFixture(); ready(f); f.World.gp.inventoryPending = true;
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'leave', 'waits for the inventory to settle');
  f = townFixture(); ready(f); f.Settings.profile.hunt.center = null;
  f.Town.tick(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /No saved hunting spot/);
  f = townFixture(); ready(f); f.World.gp.inventoryPending = false; f.Town.tick();
  assert.equal(f.Town.trip, null); assert.ok(f.WalkBack.active, f.Town.message); assert.equal(f.WalkBack.active.resume, true);
  assert.equal(f.Hunt.running, false, 'hunting waits for the arrival'); assert.match(f.Town.message, /walking back to the hunting spot/);
  assert.ok(f.Town.blocked(), 'no new trip starts during the walk');
});
test('a trapped-character recovery trip stops in town instead of walking back into the trap', () => {
  for (const setup of [f => f.World.gp.inventory = f.World.gp.inventory.filter(i => i.slot !== 14), f => f.Town.cfg().returnBy = 'walk']) {
    const f = townFixture(), gp = f.World.gp; setup(f);
    gp.inventory.find(i => i.refObjId === 15).quantity = 50; gp.inventory.find(i => i.slot === 6).durability = 10; gp.pose.x = 100;
    f.Town.begin(); f.Town.trip.recovery = true;
    assert.equal(f.Town.closeNext('close-smith'), 'leave');
    f.Hunt.running = true; f.Town.enter('leave'); f.Town.tick();
    assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false); assert.equal(f.WalkBack.active, null);
    assert.ok(f.notices.some(n => /Recovery town services completed/.test(n)), f.notices.join(' | '));
  }
});
test('resume hunting in town says it walks back when no reverse scroll is carried', () => {
  const f = townFixture(); f.Hunt.stop(); f.Town.detect = () => ({ key: 'KT' });
  f.World.gp.inventory = f.World.gp.inventory.filter(i => i.slot !== 14);
  f.Settings.profile.hunt.center = { regionId: 1, x: 1500, y: 0, z: 100 }; f.World.gp.pose.x = 60;
  assert.equal(f.Controller.resumeHunting('Back in the game'), 'town');
  assert.ok(f.Town.trip, f.Town.message); assert.ok(f.notices.some(n => /then walking to the hunting spot/.test(n)), f.notices.join(' | '));
});
test('travel plans Hotan to a spot across the western river through the ferry, and walks when it can', () => {
  const f = fixture(), hotan = { regionId: 23687, x: 844, y: 0, z: 1055 }, spot = { regionId: 22388, x: 1130, y: 0, z: 1730 };
  const steps = f.Travel.plan(hotan, spot);
  assert.ok(steps, 'a route exists');
  assert.equal(steps.map(s => s.kind).join(), 'walk,hop,walk');
  const hop = steps[1];
  assert.ok([20, 21].includes(hop.from.id), 'boards a ferry on the Hotan bank (SN_ZONE_25031)');
  assert.ok([22, 23].includes(hop.to.id), 'lands on the western bank (SN_ZONE_25033)');
  assert.equal(hop.fee, 500); assert.equal(steps[0].to, hop.from.pose); assert.deepEqual(steps[2].to, spot);
  f.World.gp.progression.gold = '499';
  assert.equal(f.Travel.plan(hotan, spot), null, 'an unaffordable ferry is never planned');
  f.World.gp.progression.gold = '100000';
  const banned = new Set(['20>22', '20>23', '21>22', '21>23']), detour = f.Travel.plan(hotan, spot, banned);
  assert.ok(detour, 'another crossing further north is found');
  assert.equal(detour.some(s => s.kind === 'hop' && banned.has(s.from.id + '>' + s.to.id)), false, 'refused links stay out');
  assert.ok(detour.filter(s => s.kind === 'hop').length >= 2);
  assert.equal(f.Travel.begin(hotan, { ...hotan, x: 1500 }, false), false, 'a walkable spot stays a plain walk');
  f.Settings.profile.hunt.travel = false; assert.equal(f.Travel.begin(hotan, spot, false), false, 'switched off');
  assert.equal(f.Travel.nodes().get(11).label, 'the Hotan world statue', 'town statues are placed from the town table');
});
function travelFixture() {
  const f = fixture(); f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  const near = { regionId: 1, x: 300, y: 0, z: 100 }, far = { regionId: 5, x: 300, y: 0, z: 100 }, spot = { regionId: 5, x: 900, y: 0, z: 100 };
  f.Travel.places = new Map([[1, { id: 1, refObjId: 900, label: 'the teleporter', pose: near }], [2, { id: 2, refObjId: 901, label: 'the teleporter', pose: far }]]);
  f.Travel.links = () => [[1, 2, 500]];
  f.Travel.walkable = (a, b) => (a.regionId === 5) === (b.regionId === 5);
  f.Route.setAreas([]);
  f.World.ents.set(77, { gid: 77, kind: 'npc', refObjId: 900, regionId: 1, x: 310, y: 0, z: 100 });
  f.Settings.profile.hunt.center = { ...spot };
  return { ...f, near, far, spot };
}
test('travel walks to the teleporter, opens its menu, hops, walks on and resumes hunting', () => {
  const f = travelFixture(), gp = f.World.gp;
  f.WalkBack.start(true);
  assert.ok(f.Travel.active, f.notices.join(' | ')); assert.equal(f.WalkBack.active.label, 'the teleporter');
  gp.pose = { ...f.near }; f.Controller.tick();
  assert.equal(f.WalkBack.active, null); assert.equal(f.Travel.active.phase, 'select');
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'select'); assert.equal(f.commands.at(-1).gid, 77);
  gp.target = 77; gp.targetCapabilities = 0x80; gp.npcConversation = { gid: 77, phase: 'menu' };
  f.advance(1000); f.Controller.tick(); f.Controller.tick();
  const hop = f.commands.find(c => c.kind === 'travel-gate');
  assert.ok(hop, 'the portal request is sent'); assert.equal(hop.gid, 77); assert.equal(hop.type, 2); assert.equal(hop.target, 2);
  f.bus.emit('phase', 'entering-world'); assert.ok(f.Travel.active, 'the load screen is expected');
  f.World.phase = 'world'; gp.pose = { ...f.far }; f.advance(3000); f.Controller.tick();
  assert.ok(f.WalkBack.active, 'walks on from the landing'); assert.equal(f.WalkBack.active.label, 'the hunting spot');
  gp.pose = { ...f.spot }; f.Controller.tick();
  assert.equal(f.Travel.active, null); assert.equal(f.WalkBack.active, null); assert.equal(f.Hunt.running, true);
});
test('a refused or unanswered hop is left out; with no other way the trip stops with the reason', () => {
  let f = travelFixture(), gp = f.World.gp;
  f.WalkBack.start(true); gp.pose = { ...f.near }; f.Controller.tick(); f.Controller.tick();
  gp.target = 77; gp.targetCapabilities = 0x80; gp.npcConversation = { gid: 77, phase: 'menu' };
  f.Controller.tick(); f.Controller.tick(); assert.equal(f.Travel.active.phase, 'arrive');
  f.bus.emit('notice', { sequence: 1, key: 'UIIT_MSG_INTERACTION_FAIL_NOT_ENOUGH_MONEY' }); f.Controller.tick();
  assert.equal(f.Travel.active, null); assert.match(f.Travel.message, /not enough gold/); assert.equal(f.Hunt.running, false);
  f = travelFixture(); gp = f.World.gp;
  f.WalkBack.start(true); gp.pose = { ...f.near }; f.Controller.tick(); f.Controller.tick();
  gp.target = 77; gp.targetCapabilities = 0x80; gp.npcConversation = { gid: 77, phase: 'menu' };
  f.Controller.tick(); f.Controller.tick(); f.advance(16000); f.Controller.tick();
  assert.equal(f.Travel.active, null); assert.match(f.Travel.message, /no answer from the game/);
  f = travelFixture(); gp = f.World.gp;
  f.WalkBack.start(true); gp.pose = { ...f.near }; f.Controller.tick(); f.Controller.tick();
  gp.target = 77; gp.targetCapabilities = 0x01; f.Controller.tick();
  assert.equal(f.Travel.active, null); assert.match(f.Travel.message, /offers no teleport/);
  assert.equal(f.commands.some(c => c.kind === 'travel-gate'), false);
});
test('a world change during a travel walk, manual control or Stop end the trip without a hop', () => {
  let f = travelFixture();
  f.WalkBack.start(true); f.bus.emit('phase', 'entering-world');
  assert.equal(f.Travel.active, null); assert.equal(f.WalkBack.active, null); assert.match(f.Travel.message, /unexpected travel/);
  f = travelFixture(); f.WalkBack.start(true); f.World.gp.pose = { ...f.near }; f.Controller.tick();
  f.Manual.lastAt = 123; f.Controller.tick(); assert.equal(f.Travel.active, null); assert.match(f.Travel.message, /manual control/);
  f = travelFixture(); f.WalkBack.start(true); f.World.gp.pose = { ...f.near }; f.Controller.tick();
  f.toggleBot(); assert.equal(f.Travel.active, null); assert.equal(f.Hunt.running, false);
  f = travelFixture(); f.WalkBack.start(true);
  f.AutoStart.entry = { at: 0 }; f.Settings.profile.hunt.autoStart = true; f.AutoStart.tick();
  assert.equal(f.AutoStart.entry, null, 'auto-start never starts the bot during a trip');
  assert.ok(f.Travel.active);
});
test('abnormal pill restocking uses only the strongest universal pill and preserves existing profiles', () => {
  const f = fixture(), r = f.Restock.cfg();
  assert.equal(r.cure.on, false); assert.equal(r.cure.target, 50);
  f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ potion: { restock: { mp: { target: 1000 } } } }));
  f.Settings.importOriginal();
  assert.equal(f.Restock.cfg().mp.target, 1000); assert.equal(f.Restock.cfg().cure.on, false);
  assert.equal(f.Restock.cfg().cure.target, 50);
  const current = f.Restock.cfg();
  Object.assign(current.cure, { on: true, low: 10, target: 100 });
  Object.assign(current.cure, { on: true, refObjId: 55, low: 10, target: 100 });
  assert.equal(f.Restock.supplies().find(s => s.kind === 'cure').refObjId, 58);
  assert.equal(f.Town.supplies().find(s => s.kind === 'cure').refObjId, 58);
  const offer = refObjId => ({ refObjId, previews: [{ refObjId, typeFlags: 12652 }] });
  assert.equal(f.Restock.offerKind(offer(58)), 'cure');
  for (const ref of [55, 56, 57, 10371]) assert.equal(f.Restock.offerKind(offer(ref)), '');
  assert.equal(f.Restock.offerKind({ ...offer(58), currency: 2 }), '');
  assert.equal(f.Restock.offerKind({ ...offer(58), contents: [{ refObjId: 58, quantity: 10 }] }), '');
});

test('town refills best abnormal pills by exact missing amount and waits for settlement', () => {
  const f = townFixture(), gp = f.World.gp;
  gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  gp.inventory.push({ slot: 20, refObjId: 58, typeFlags: 12652, quantity: 40 });
  Object.assign(f.Restock.cfg().cure, { on: true, low: 10, target: 50 });
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [{ refObjId: 58, tab: 0, slot: 7, maxStack: 50, price: '260', previews: [{ refObjId: 58, typeFlags: 12652 }] }] };
  f.Town.buy(); assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'shop-buy', tab: 0, slot: 7, quantity: 10 });
  f.advance(1000); f.Town.buy(); assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
  gp.inventory.find(i => i.refObjId === 58).quantity = 50; f.Town.buy();
  assert.equal(f.Town.trip.phase, 'close-vendor'); assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
});

test('town refuses cheaper pills and insufficient gold without a substitute purchase', () => {
  for (const cheapOnly of [true, false]) {
    const f = townFixture(), gp = f.World.gp;
    gp.inventory.find(i => i.refObjId === 15).quantity = 50;
    Object.assign(f.Restock.cfg().cure, { on: true, low: 10, target: 50 });
    f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
    const ref = cheapOnly ? 57 : 58;
    gp.shop = { npc: 61, offers: [{ refObjId: ref, tab: 0, slot: 7, maxStack: 50, price: '260', previews: [{ refObjId: ref, typeFlags: 12652 }] }] };
    if (!cheapOnly) gp.progression.gold = '1';
    f.Town.buy(); assert.equal(f.commands.some(c => c.kind === 'shop-buy'), false); assert.equal(f.Town.trip, null);
    assert.match(f.Town.message, cheapOnly ? /Special Universal Pill/ : /gold/);
  }
});

test('walking restock triggers on low best pills and never repeats a partially confirmed purchase', () => {
  const f = fixture(), r = f.Restock.cfg(), gp = f.World.gp;
  r.enabled = true; r.hp.on = r.mp.on = false;
  Object.assign(r.cure, { on: true, low: 10, target: 50 });
  r.vendor = { gid: 7, refObjId: 99, name: 'Merchant', kind: 'npc', regionId: 1, x: 100, y: 0, z: 100 };
  r.route = [{ ...r.vendor }, { ...r.vendor, x: 140 }]; f.World.ents.set(7, r.vendor);
  f.Restock.tick(); assert.ok(f.Restock.trip); assert.equal(f.Restock.trip.supplies[0].refObjId, 58);
  f.Restock.trip.phase = 'buy'; gp.target = 7;
  gp.shop = { npc: 7, offers: [{ refObjId: 58, tab: 0, slot: 7, maxStack: 50, price: '260', previews: [{ refObjId: 58, typeFlags: 12652 }] }] };
  f.Restock.tick(); assert.equal(f.commands.at(-1).quantity, 50);
  gp.inventory = [{ slot: 13, refObjId: 58, typeFlags: 12652, quantity: 1 }];
  f.advance(600); f.Restock.tick(); assert.ok(f.Restock.trip.pending);
  assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
  gp.inventory[0].quantity = 50; f.Restock.tick(); assert.equal(f.Restock.trip.phase, 'return');
  assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
  assert.equal(f.commands.at(-1).kind, 'npc-close');
});

test('best pills participate in low-stock, full-bag and revival town trips with shared targets', () => {
  for (const mode of ['low', 'full', 'revival']) {
    const f = townFixture(), gp = f.World.gp; f.pet.inventory = [];
    gp.inventory.find(i => i.refObjId === 15).quantity = 50;
    Object.assign(f.Restock.cfg().cure, { on: true, low: 10, target: 100 });
    if (mode === 'full') f.World.freeBagSlots = () => 1;
    assert.equal(f.Town.reason(), mode === 'full' ? 'character bag nearly full' : 'potions running low');
    f.Town.begin(mode === 'revival');
    assert.ok(f.Town.trip); const supply = f.Town.trip.supplies.find(s => s.kind === 'cure');
    assert.equal(supply.refObjId, 58); assert.equal(supply.target, 100);
    f.Restock.cfg().cure.target = 200; assert.equal(supply.target, 100);
    assert.equal(f.Town.disposable({ refObjId: 58, typeFlags: 12652 }), false);
  }
});

test('town preflight stops before consuming scrolls when setup, scrolls or gold are missing', () => {
  for (const change of [f => f.Town.cfg().gate = null, f => f.World.gp.inventory = f.World.gp.inventory.filter(i => i.slot !== 13),
      f => f.World.gp.progression.gold = '0']) {
    const f = townFixture(); change(f); f.Town.tick();
    assert.equal(f.Hunt.running, false); assert.equal(f.Town.trip, null);
    assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  }
});
test('town cycle is opt-in, hunting-only and overrides walking restock without recording', () => {
  const f = townFixture(); f.Restock.cfg().enabled = true;
  f.Town.cfg().enabled = false; assert.equal(f.Town.tick(), false);
  f.Town.cfg().enabled = true; f.Hunt.stop(); assert.equal(f.Town.tick(), false);
  f.Hunt.start(); f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.pet.inventory = []; f.Hunt.tick(); assert.equal(f.Restock.trip, null); assert.equal(f.Hunt.running, true);
  f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 5;
  f.Town.tick(); f.advance(600); f.Town.tick(); f.advance(100); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'recall-wait');
});
test('town trip started while already in town never uses a return scroll', () => {
  const f = townFixture(); f.Hunt.start();
  f.Town.detect = () => ({ key: 'town' });
  f.Town.begin();
  assert.ok(f.Town.trip, 'the trip starts');
  assert.ok(f.Town.trip.phase.startsWith('walk-'), 'goes straight to the services');
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  f.Town.cancel();
  f.World.gp.inventory = f.World.gp.inventory.filter(i => i.typeFlags !== 0x09ec);
  f.Town.begin(); assert.ok(f.Town.trip, 'no return scroll needed in town');
});
test('town trip started in town returns to the hunt, not the town', () => {
  const f = townFixture(); f.Hunt.start(); f.Town.detect = () => ({ key: 'town' });
  const hunt = { ...f.Hunt.cfg().center }; f.Town.lastScrollPoint = null;
  f.Town.begin();
  assert.deepEqual({ x: f.Town.trip.origin.x, y: f.Town.trip.origin.y }, { x: hunt.x, y: hunt.y }, 'return target is the hunt point');
  assert.equal(f.Town.trip.inTown, true);
  f.Town.enter('reverse-wait'); f.Town.phase('entering-world'); f.World.gp.pose = { ...f.World.gp.pose, x: hunt.x, y: hunt.y };
  f.Town.tick(); assert.equal(f.Town.trip, null, f.Town.message);
  const g = townFixture(); g.Hunt.start(); g.Town.detect = () => ({ key: 'town' }); g.Town.lastScrollPoint = { ...g.World.pose(), x: 1500 };
  g.Town.begin(); assert.equal(g.Town.trip.origin.x, 1500, 'uses the remembered scroll point');
  g.Hunt.cfg().center = null; g.Town.cancel(); g.Town.lastScrollPoint = null; g.Town.begin();
  assert.equal(g.Town.trip, null); assert.match(g.Town.message, /hunting/);
});
test('pet storage protects supplies, keep names and items with missing metadata', () => {
  const f = townFixture(); f.Town.cfg().store.others = true;
  for (const item of [...f.World.items(), f.pet.inventory[2], f.pet.inventory[3], { name: 'Unknown', refObjId: 123 }]) assert.equal(f.Town.eligible(item), false);
  assert.equal(f.Town.eligible(f.pet.inventory[0]), true);
  assert.equal(f.Town.eligible({ refObjId: 24198, typeFlags: 3820 }), false);
  f.Town.cfg().store.elixirs = false; assert.equal(f.Town.eligible(f.pet.inventory[0]), true, 'Legacy category switches cannot store other items or sell elixirs');
  assert.equal(f.Town.eligible(f.pet.inventory[1]), false);
});
test('the pet status says why drops in view are not collected', () => {
  const f = fixture(); pickupPet(f, 7); f.Hunt.running = true;
  assert.match(f.Diagnostics.pet(), /waiting for eligible drops\. No drops in view/);
  const near = f.drop(40, 3436); near.x = 110; f.Loot.preset('all');
  const far = f.drop(41, 3436); far.x = 5000; f.Settings.profile.hunt.center = null;
  const off = f.drop(42, 2284); off.x = 112; f.Settings.profile.hunt.pickup.potions = false;
  const foreign = f.drop(43, 3436); foreign.x = 114; foreign.groundItem.ownerJid = 999;
  const text = f.Diagnostics.pet();
  assert.match(text, /Drops in view: 4, ready to collect: 1\./); assert.match(text, /1: not wanted by your Loot settings \(1 potions #101\)/);
  assert.match(text, /1: too far from you/); assert.match(text, /1: it belongs to another player/);
  assert.equal(f.Loot.whyNot(near), ''); assert.equal(f.Loot.choose()?.gid, 40, 'whyNot agrees with the drop choose() takes');
  f.Settings.profile.hunt.pickup.finishFight = true; f.Settings.profile.hunt.pickup.afterKillOnly = true;
  assert.equal(f.Loot.whyNot(near), '', 'finish-fight never blocks the pet');
});
test('party members and their pets do not make a monster another player\'s target', () => {
  const f = fixture(); f.World.gp.social = { localName: 'Me', members: [{ id: 5, name: 'Mate' }, { id: 1, name: 'Me' }] };
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Wolf', regionId: 1, x: 120, y: 0, z: 100, attackFlags: 16, appearanceState: [0] });
  f.World.ents.set(5, { gid: 5, kind: 'player', name: 'Mate' }); f.World.ents.set(6, { gid: 6, kind: 'player', name: 'Stranger' });
  f.World.ents.set(7, { gid: 7, kind: 'cos', ownerGid: 5, name: 'Pet' }); f.World.ents.set(8, { gid: 8, kind: 'cos', ownerGid: 6, name: 'Pet' });
  const cast = caster => f.World.onCast({ caster, target: 30, results: [{ target: 30 }] });
  cast(5); assert.equal(f.World.hitByOthers.has(30), false, 'a party member');
  cast(7); assert.equal(f.World.hitByOthers.has(30), false, 'a party member\'s pet');
  cast(6); assert.equal(f.World.hitByOthers.has(30), true, 'a stranger still counts');
  f.World.hitByOthers.clear(); cast(8); assert.equal(f.World.hitByOthers.has(30), true, 'a stranger\'s pet still counts');
  const stamp = f.World.hitByOthers.get(30); f.advance(1000); cast(5); assert.equal(f.World.hitByOthers.get(30), stamp, 'a member does not refresh a stranger\'s mark');
  f.Hunt.running = true; f.Hunt.state = 'search'; f.World.hitByOthers.clear(); cast(5);
  assert.equal(f.Hunt.chooseTarget()?.gid, 30, 'the monster the party is fighting can be chosen');
});
test('the imbue is renewed as it runs out, ahead of skills and normal attacks', () => {
  const setup = (change = {}) => {
    const f = combatFixture();
    f.World.rebuildCatalog([{ id: 500, group: 50, level: 1, name: 'Slash', targetRequired: true, mp: 5, cooldownGroup: 0 },
      { id: 501, group: 51, level: 1, name: 'Imbue', targetRequired: false, mp: 5, cooldownGroup: 0 }]);
    f.World.applyGameplay({ ...f.World.gp, skills: [500, 501], target: 30 });
    f.Settings.profile.macro.imbue = { id: 501, group: 51 }; f.Settings.profile.macro.imbueBeforeAttack = true;
    Object.assign(f.Settings.profile.macro, change); return f;
  };
  const first = f => f.commands.find(c => c.kind === 'skill')?.skillId;
  let f = setup(); f.World.buffRemaining = () => 300; f.Combat.fight(f.World.ents.get(30));
  assert.equal(first(f), 501, 'about to run out, so the imbue goes first');
  f = setup(); f.World.buffRemaining = () => 2500; f.Combat.fight(f.World.ents.get(30)); assert.equal(first(f), 500, 'time left (its cooldown is as long): the attack skill goes first');
  f = setup(); f.World.buffRemaining = () => -1; f.Combat.fight(f.World.ents.get(30)); assert.equal(first(f), 501, 'an expired imbue is cast first');
  f = setup(); f.Settings.profile.macro.rotations.normal = []; f.World.buffRemaining = () => 300; f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(f.commands.map(c => c.kind), ['skill'], 'with no rotation skill the imbue is renewed before a normal attack'); assert.equal(first(f), 501);
  f = setup(); f.Settings.profile.macro.rotations.normal = []; f.World.buffRemaining = () => 9000; f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(f.commands.map(c => c.kind), ['attack']);
  // No answer yet: the game still shows the old timer, so the imbue is not sent again into its cooldown.
  f = setup(); f.World.buffRemaining = () => 300; f.Combat.fight(f.World.ents.get(30));
  const imbues = () => f.commands.filter(c => c.skillId === 501).length;
  f.advance(500); f.World.gp = { ...f.World.gp }; f.Combat.fight(f.World.ents.get(30));
  assert.equal(imbues(), 1, 'an unanswered imbue is not resent while the old one still shows time left');
  assert.equal(f.commands.at(-1).skillId, 500, 'the rotation goes on meanwhile');
  f.advance(1500); f.World.gp = { ...f.World.gp }; f.Combat.fight(f.World.ents.get(30));
  assert.equal(imbues(), 2, 'it is retried once the wait is over');
});
test('an imbue that comes back during another skill\'s cast is used at once, before that skill releases', () => {
  const setup = (rem, sinceCast = 1000) => {
    const f = combatFixture();
    f.World.rebuildCatalog([{ id: 500, group: 50, level: 1, name: 'Slash', targetRequired: true, mp: 5, cooldownGroup: 0 },
      { id: 501, group: 51, level: 1, name: 'Imbue', targetRequired: false, mp: 5, cooldownGroup: 0 }]);
    f.World.applyGameplay({ ...f.World.gp, skills: [500, 501], target: 30,
      casts: [{ caster: 1, skill: 500, receivedAtMs: 100000 - sinceCast }] });
    f.Settings.profile.macro.imbue = { id: 501, group: 51 }; f.Settings.profile.macro.imbueBeforeAttack = true;
    f.Combat.lastCastAt = 100000 - sinceCast; f.World.buffRemaining = () => rem; return f;
  };
  let f = setup(-1); assert.equal(f.World.isCasting(), true); f.Combat.fight(f.World.ents.get(30));
  assert.deepEqual(f.commands.map(c => c.skillId), [501], 'the imbue ran out mid-cast: it is cast without waiting');
  f = setup(300); f.Combat.fight(f.World.ents.get(30)); assert.deepEqual(f.commands.map(c => c.skillId), [501], 'about to run out');
  f = setup(2500); f.Combat.fight(f.World.ents.get(30));
  assert.equal(f.commands.length, 0, 'with time left it waits: a cooldown the game has not shown yet would only earn refusals');
  f = setup(-1, 100); f.Combat.fight(f.World.ents.get(30)); assert.equal(f.commands.length, 0, 'not on top of the skill just sent');
  f = setup(-1); f.Settings.profile.macro.imbueBeforeAttack = false; f.Combat.fight(f.World.ents.get(30)); assert.equal(f.commands.length, 0);
  f = setup(-1); f.Combat.fight(f.World.ents.get(30)); f.advance(500); f.World.gp = { ...f.World.gp }; f.Combat.fight(f.World.ents.get(30));
  assert.equal(f.commands.length, 1, 'no other skill is sent while the cast is still running');
});
test('the Discord invite is real and the update notice shows once per version', () => {
  const f = fixture(), invite = /^https:\/\/discord\.gg\/[\w-]+$/;
  assert.match(source.match(/const DISCORD_URL = '([^']+)'/)?.[1], invite); assert.doesNotMatch(source, /INVITE-CODE/);
  assert.equal(f.Updates.announce(), true); assert.match(f.notices.at(-1), /Welcome/);
  assert.equal(f.Updates.announce(), false); assert.equal(f.notices.length, 1, 'shown once');
  f.storage.set('sroBotLean:v1:seenVersion', JSON.stringify('0.0.1')); assert.equal(f.Updates.announce(), true); assert.match(f.notices.at(-1), /Updated to/);
  f.storage.delete('sroBotLean:v1:seenVersion'); f.storage.set('sroBotLean:v1:profile:default', JSON.stringify({}));
  assert.equal(f.Updates.announce(), true); assert.match(f.notices.at(-1), /Updated to/, 'an existing install is not welcomed as new');
});
test('after an update the patch notes of every version since the last one open once; a new install is welcomed', () => {
  const version = source.match(/const VERSION = '([\d.]+)'/)[1];
  const setup = (seen, profile = true) => {
    const f = fixture(), shown = [];
    f.UI.showNotes = notes => { shown.push(Array.from(notes, n => n.version)); return true; };
    if (seen !== undefined) f.storage.set('sroBotLean:v1:seenVersion', JSON.stringify(seen));
    if (profile) f.storage.set('sroBotLean:v1:profile:default', JSON.stringify({}));
    return { f, shown };
  };
  const notes = vm.runInNewContext(source.match(/const RELEASE_NOTES = (\[[^\n]+\]);/)[1]);
  assert.equal(notes[0].version, version, 'the installed version has built-in notes');
  assert.ok(notes.every(n => n.title && n.items.length && n.items.every(i => typeof i === 'string' && i)), 'every release has a title and items');
  const all = Array.from(notes, n => n.version), [latest, previous] = all;
  assert.ok(previous, 'notes of the previous version are kept too');
  let { f, shown } = setup('0.0.1');
  assert.equal(f.Updates.announce(), true); assert.deepEqual(shown, [all], 'skipped versions are included, newest first');
  assert.equal(f.notices.length, 0, 'no Discord toast when the notes open');
  assert.equal(f.Updates.announce(), false); assert.equal(shown.length, 1, 'once per version');
  ({ f, shown } = setup(previous)); f.Updates.announce(); assert.deepEqual(shown, [[latest]]);
  ({ f, shown } = setup(undefined)); f.Updates.announce(); assert.deepEqual(shown, [[latest]], 'an install without a stored version sees this version only');
  ({ f, shown } = setup('garbage')); f.Updates.announce(); assert.deepEqual(shown, [[latest]]);
  ({ f, shown } = setup(undefined, false)); f.Updates.announce(); assert.deepEqual(shown, []); assert.match(f.notices.at(-1), /Welcome/, 'a new install gets no patch notes');
  ({ f, shown } = setup('9.0.0')); f.Updates.announce(); assert.deepEqual(shown, []); assert.match(f.notices.at(-1), /Updated to/, 'a downgrade has no notes to show');
  assert.equal(f.Updates.newer('1.2.10', '1.2.9'), true); assert.equal(f.Updates.newer('1.2.9', '1.2.10'), false); assert.equal(f.Updates.newer('x', '1.0.0'), false);
});
test('the searching status says why no monster is eligible', () => {
  const f = fixture(), mob = (gid, extra = {}) => f.World.ents.set(gid, { gid, kind: 'monster', name: 'Wolf', level: 40, regionId: 1, x: 120, y: 0, z: 100, attackFlags: 16, appearanceState: [0], ...extra });
  f.Hunt.running = true; f.Hunt.state = 'search';
  assert.match(f.Diagnostics.main(), /searching for an eligible target\. No monsters in view/);
  mob(30, { rarity: 1 }); mob(31, { x: 5000 }); mob(32, { level: 5 });
  f.Settings.profile.hunt.classes.champion = false; f.Settings.profile.hunt.levelMin = 20;
  const text = f.Diagnostics.main();
  assert.match(text, /Monsters in view: 3\./); assert.match(text, /1: level is outside/); assert.match(text, /1: too far/);
  mob(33, { name: 'Boar' }); f.Settings.profile.hunt.exclude = 'boar';
  assert.match(f.Diagnostics.main(), /1: name is not in/);
  f.Hunt.ban.set(32, 1e12); assert.match(f.Diagnostics.main(), /1: recently given up/);
});
test('magic and attribute stones are stored in the warehouse, never sold, and have their own pickup switches', () => {
  const f = townFixture(), magic = { slot: 5, refObjId: 1010, typeFlags: 108 | (11 << 7) | (1 << 11), quantity: 4, name: 'Magic stone' };
  const astral = { slot: 6, refObjId: 1011, typeFlags: 108 | (11 << 7) | (7 << 11), quantity: 1, name: 'Astral stone' };
  const attr = { slot: 7, refObjId: 1012, typeFlags: 108 | (11 << 7) | (2 << 11), quantity: 3, name: 'Attribute stone' };
  const tablet = { slot: 8, refObjId: 1013, typeFlags: 108 | (11 << 7) | (3 << 11), quantity: 1, name: 'Attribute tablet' };
  assert.equal(f.Loot.category(magic.typeFlags), 'magicStones'); assert.equal(f.Loot.category(astral.typeFlags), 'magicStones');
  assert.equal(f.Loot.category(attr.typeFlags), 'attrStones'); assert.equal(f.Loot.category(tablet.typeFlags), 'alchemy');
  for (const stone of [magic, astral, attr]) { assert.equal(f.Town.eligible(stone), true); assert.equal(f.Town.sellable(stone), false); }
  assert.equal(f.Town.eligible(tablet), false); assert.equal(f.Town.sellable(tablet), true);
  f.Town.cfg().keep = 'magic'; assert.equal(f.Town.eligible(magic), false, 'Keep names still protect the stone from every town step');
  f.Town.cfg().keep = 'favorite';
  const g = fixture(); g.Settings.profile.hunt.pickup.magicStones = false; assert.equal(g.Loot.allowed(g.drop(30, magic.typeFlags)), false);
  g.Settings.profile.hunt.pickup.magicStones = true; assert.equal(g.Loot.allowed(g.drop(31, magic.typeFlags)), true);
  g.Settings.profile.hunt.pickup.attrStones = false; assert.equal(g.Loot.allowed(g.drop(32, attr.typeFlags)), false);
  f.Loot.preset('elixirs'); assert.equal(f.Settings.profile.hunt.pickup.magicStones, false); assert.equal(f.Settings.profile.hunt.pickup.attrStones, false);
  assert.equal(f.Town.stone(magic), true); assert.equal(f.Town.stone(f.pet.inventory[0]), false, 'Elixirs stay in the character bag for alchemy');
});
test('stones follow the old alchemy switch and Berserk migrates to Giants only', () => {
  let f = fixture(); f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ hunt: { pickup: { alchemy: false } }, macro: { berserk: 'strong' } }));
  f.Settings.importOriginal();
  assert.equal(f.Settings.profile.hunt.pickup.magicStones, false); assert.equal(f.Settings.profile.hunt.pickup.attrStones, false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.Settings.profile.macro.berserkClasses)), { normal: false, champion: false, giant: true, giantParty: false, party: false, elite: false, unique: false, titan: false });
  f = fixture(); f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ macro: { berserk: 'off' } })); f.Settings.importOriginal();
  assert.equal(Object.values(f.Settings.profile.macro.berserkClasses).some(Boolean), false);
  f = fixture(); f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ macro: { berserk: 'always' } })); f.Settings.importOriginal();
  assert.equal(Object.values(f.Settings.profile.macro.berserkClasses).every(Boolean), true);
  f = fixture(); f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ macro: { berserk: 'always', berserkClasses: { giant: false, titan: true } } })); f.Settings.importOriginal();
  assert.equal(f.Settings.profile.macro.berserkClasses.titan, true); assert.equal(f.Settings.profile.macro.berserkClasses.giant, false, 'Saved class choices win over the legacy dropdown');
});
test('Berserk fires only on ticked classes, with a full gauge', () => {
  const f = fixture(), kinds = () => f.commands.filter(c => c.kind === 'berserk').length;
  f.World.berserkGauge = 5;
  assert.equal(f.Combat.berserk('champion'), false); assert.equal(f.Combat.berserk('normal'), false); assert.equal(kinds(), 0);
  assert.equal(f.Combat.berserk('giant'), true); assert.equal(kinds(), 1);
  f.advance(2000); f.World.berserkGauge = 4; assert.equal(f.Combat.berserk('giant'), false);
  f.World.berserkGauge = 5; f.Settings.profile.macro.berserkClasses.champion = true; assert.equal(f.Combat.berserk('champion'), true);
  f.advance(2000); f.Settings.profile.macro.berserkClasses.giant = false; assert.equal(f.Combat.berserk('giant'), false);
});
test('Berserk on party Giants follows its own switch', () => {
  const f = fixture(), kinds = () => f.commands.filter(c => c.kind === 'berserk').length, B = f.Settings.profile.macro.berserkClasses;
  f.World.berserkGauge = 5;
  f.World.ents.set(70, { gid: 70, rarity: 4, rarityAuxIcon: 1 }); f.World.ents.set(71, { gid: 71, rarity: 0, rarityAuxIcon: 1 });
  B.party = true; f.World.gp.target = 70; assert.equal(f.Combat.berserk('party'), false, 'Party monsters alone does not cover party Giants');
  B.giantParty = true; assert.equal(f.Combat.berserk('party'), true); assert.equal(kinds(), 1);
  f.advance(2000); B.party = false; f.World.gp.target = 71; assert.equal(f.Combat.berserk('party'), false, 'Giant party does not cover other party monsters');
  B.party = true; assert.equal(f.Combat.berserk('party'), true); assert.equal(kinds(), 2);
});
test('saved Berserk choices give party Giants the old Party monsters setting', () => {
  const f = fixture();
  assert.equal(f.botProfile({ macro: { berserkClasses: { giant: true, party: true } } }).macro.berserkClasses.giantParty, true);
  assert.equal(f.botProfile({ macro: { berserkClasses: { giant: true, party: false } } }).macro.berserkClasses.giantParty, false);
  assert.equal(f.botProfile({ macro: { berserkClasses: { party: true, giantParty: false } } }).macro.berserkClasses.giantParty, false, 'A saved Giant party choice wins');
  assert.equal(f.botProfile({}).macro.berserkClasses.giantParty, false);
});
// Lure: points A (30 m east of the spot) and B (20 m north), a single-target taunt and an area taunt.
function lure() {
  const f = fixture();
  f.World.gp.skills = [3001, 3002];
  f.World.rebuildCatalog([
    { id: 3001, group: 950, level: 1, name: 'Taunt', targetRequired: true, targets: 4, range: 150 },
    { id: 3002, group: 951, level: 1, name: 'Howling', targetRequired: false, targets: 1 },
  ]);
  Object.assign(f.Settings.profile.lure, { enabled: true, points: [{ regionId: 1, x: 400, y: 0, z: 100 }, { regionId: 1, x: 100, y: 0, z: 300 }],
    taunt: { id: 3001, group: 950 }, area: { id: 3002, group: 951 }, holdS: 4 });
  const mob = (gid, x, z = 100) => { const e = { gid, kind: 'monster', name: 'Mob ' + gid, rarity: 0, regionId: 1, x, y: 0, z, attackFlags: 16, appearanceState: [0] }; f.World.ents.set(gid, e); return e; };
  const at = (x, z = 100) => { f.World.gp.pose = { regionId: 1, x, y: 0, z }; };
  const step = () => { f.advance(1000); f.Hunt.tick(); };
  const casts = id => f.commands.filter(c => c.kind === 'skill' && c.skillId === id);
  // The game's cooldowns: 5 s for the single-target taunt, 10 s for the area taunt.
  const post = f.Hook.post; f.World.gp.skillCooldowns = [];
  f.Hook.post = msg => { post(msg); const c = msg.command.command; if (c.kind === 'skill') f.World.gp.skillCooldowns.push({ skill: c.skillId, startedAtMs: f.World.simNow(), durationMs: c.skillId === 3001 ? 5000 : 10000 }); };
  f.Hunt.start();
  return { f, mob, at, step, casts };
}
test('the lure walks to a pull point, taunts the nearest monster there and never attacks', () => {
  const { f, mob, at, step, casts } = lure();
  mob(40, 410); mob(41, 520);
  step(); assert.equal(f.Lure.index, 0, 'starts with point A'); step(); assert.equal(f.Hunt.state, 'lure'); assert.equal(f.Lure.phase, 'out');
  assert.equal(f.commands.at(-1).kind, 'move', 'walks towards point A');
  assert.equal(casts(3002).length, 0, 'no area taunt with no monster near');
  at(400); step(); assert.equal(casts(3002).length, 1, 'the area taunt goes out as soon as a monster is near');
  step(); assert.equal(f.Lure.phase, 'taunt');
  step(); assert.deepEqual(f.commands.filter(c => c.kind === 'select').map(c => c.gid), [40], 'the monster nearest the point');
  f.World.gp.target = 40; step();
  assert.equal(casts(3001).length, 1); assert.equal(casts(3001)[0].gid, 40);
  assert.equal(f.Lure.phase, 'back'); assert.equal(f.Lure.pulled, true);
  assert.equal(f.commands.some(c => c.kind === 'attack'), false, 'the lure never attacks');
});
test('the lure waits for the next pull while enough monsters are already in the training area', () => {
  const { f, mob, step } = lure();
  f.Settings.profile.lure.stopAt = 2; mob(50, 110); mob(51, 120);
  step(); step(); step(); assert.equal(f.Lure.phase, 'out');
  assert.match(f.Lure.message, /Enough monsters at the spot \(2\)/);
  const moves = () => f.commands.filter(c => c.kind === 'move').length, before = moves();
  step(); step(); assert.equal(moves(), before, 'does not walk to the pull point');
  f.World.ents.delete(51); step(); step(); step();
  assert.ok(moves() > before, 'one left: the next pull starts');
  const g = lure(); g.f.Settings.profile.lure.stopAt = 0; g.mob(50, 110); g.mob(51, 120); g.step(); g.step(); g.step();
  assert.ok(g.f.commands.some(c => c.kind === 'move'), 'off by default');
});
test('after a pull the lure brings the monsters back, holds without the area taunt, then goes to the next point', () => {
  const { f, mob, at, step, casts } = lure();
  mob(40, 410); step(); at(400); step(); step(); step(); f.World.gp.target = 40; step();
  assert.equal(f.Lure.phase, 'back');
  const area = casts(3002).length;
  at(100); f.World.ents.get(40).x = 110; step();
  assert.equal(f.Lure.phase, 'hold');
  f.World.gp.skillCooldowns = []; // the area taunt is ready and the monster is near
  step(); step(); assert.equal(f.Lure.phase, 'hold', 'holds for the configured 4 s');
  assert.equal(casts(3002).length, area, 'no area taunt while the party takes over');
  assert.equal(f.commands.some(c => c.kind === 'attack'), false);
  step(); step(); assert.equal(f.Lure.phase, 'out'); assert.equal(f.Lure.index, 1);
  f.World.ents.delete(40); step(); const move = f.commands.at(-1);
  assert.equal(move.kind, 'move'); assert.ok(move.destination.z > 100, 'walks towards point B');
});
test('bringing monsters back, the lure stops for 4 s after every 10 m; a 10 s hold by default', () => {
  assert.equal(fixture().Settings.profile.lure.holdS, 10);
  const { f, mob, at, step } = lure();
  f.Settings.profile.lure.area = { id: 0, group: 0 }; // only the single-target taunt, so no cast interrupts the timing
  mob(40, 410); step(); at(400); step(); step(); step(); f.World.gp.target = 40; step();
  assert.equal(f.Lure.phase, 'back');
  step(); assert.equal(f.commands.at(-1).kind, 'move'); assert.ok(f.commands.at(-1).destination.x < 400, 'heads back');
  at(350); step(); assert.notEqual(f.Lure.message, 'Waiting for the monsters to follow.', 'only 5 m so far');
  const moves = f.commands.filter(c => c.kind === 'move').length;
  at(300); step(); assert.equal(f.Lure.message, 'Waiting for the monsters to follow.', '10 m walked: pause');
  assert.deepEqual([f.commands.at(-1).kind, f.commands.at(-1).destination.x], ['move', 300], 'stops where it stands');
  step(); step(); step(); assert.equal(f.commands.filter(c => c.kind === 'move').length, moves + 1, 'stands still during the pause');
  step(); assert.equal(f.Lure.message, 'Bringing monsters back to the party.'); assert.ok(f.commands.at(-1).destination.x < 300, 'walks on after 4 s');
  f.Settings.profile.lure.pauseEveryM = 0; at(150); step(); assert.equal(f.Lure.message, 'Bringing monsters back to the party.', '0 m turns the pauses off');
});
test('a pull point with no monster sends the lure straight back with no hold', () => {
  const { f, at, step } = lure();
  step(); at(400); step(); assert.equal(f.Lure.phase, 'taunt');
  step(); assert.equal(f.Lure.phase, 'back'); assert.equal(f.Lure.pulled, false);
  at(100); step(); assert.equal(f.Lure.phase, 'out', 'nothing pulled, so no hold'); assert.equal(f.Lure.index, 1);
});
test('the lure gives up a pull below the HP threshold and brings the character back', () => {
  const { f, mob, at, step } = lure();
  mob(40, 410); step(); at(300); step(); assert.equal(f.Lure.phase, 'out');
  f.World.me = () => ({ hpPct: 30, mpPct: 100 }); step();
  assert.equal(f.Lure.phase, 'back'); assert.ok(f.commands.at(-1).destination.x < 300, 'walks back to the spot');
});
test('the Lure panel picks the two taunts and adds or removes pull points', () => {
  const nodes = [];
  const document = { createElement(tag) {
    const events = {}, node = { tag, children: [], className: '', value: '', dataset: {}, style: {},
      classList: { add() {} }, setAttribute() {}, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener(name, fn) { events[name] = fn; }, click() { events.click?.(); }, querySelectorAll() { return []; } };
    nodes.push(node); return node;
  } };
  const f = fixture(document); f.UI.draw = () => {};
  f.World.gp.skills = [3001, 3002];
  f.World.rebuildCatalog([{ id: 3001, group: 950, level: 1, name: 'Taunt', targetRequired: true, targets: 4 }, { id: 3002, group: 951, level: 1, name: 'Howling', targetRequired: false, targets: 1 }]);
  f.Lure.draw(document.createElement('div'));
  const text = n => n.textContent ?? '', labels = nodes.map(text);
  for (const label of ['Lure instead of hunting', 'Single-target taunt', 'Area taunt', 'Hold at the spot (s)', 'Add pull point here']) assert.ok(labels.includes(label), label);
  f.World.gp.pose = { regionId: 1, x: 400, y: 0, z: 100 };
  nodes.find(n => n.tag === 'button' && text(n) === 'Add pull point here').click();
  assert.deepEqual(JSON.parse(JSON.stringify(f.Settings.profile.lure.points)), [{ regionId: 1, x: 400, y: 0, z: 100 }]);
  nodes.length = 0; f.Lure.draw(document.createElement('div'));
  assert.ok(nodes.some(n => text(n) === 'Point A: 30 m from the spot'));
  nodes.find(n => n.tag === 'button' && text(n) === 'Remove point A').click();
  assert.equal(f.Settings.profile.lure.points.length, 0);
});
test('the lure needs points and a saved spot, and pull points stay with their character', () => {
  const { f, step } = lure();
  f.Settings.profile.lure.points = []; assert.equal(f.Lure.on(), false, 'no points: hunting as usual');
  f.Settings.profile.lure.points = [{ regionId: 1, x: 400, y: 0, z: 100 }]; f.Settings.profile.hunt.center = null; step();
  assert.equal(f.Hunt.running, false, 'no hunting spot: stops instead of guessing');
  const points = [{ regionId: 1, x: 1, y: 0, z: 2 }];
  assert.deepEqual(JSON.parse(JSON.stringify(f.botProfile({ lure: { points } }).lure.points)), points);
  assert.equal(f.botProfile({}).lure.enabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.ProfileShare.personal(f.Settings.profile).pullPoints)), [{ regionId: 1, x: 400, y: 0, z: 100 }]);
});
test('town cycle does not repeat unconfirmed pet transfers and stops on full storage', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('store');
  f.World.gp.storage = { npc: 60, phase: 'open', capacity: 1, items: [] }; f.World.gp.target = 60;
  f.Town.store(); assert.equal(f.commands.at(-1).kind, 'cos-transfer');
  f.advance(600); f.Town.store(); assert.equal(f.commands.filter(c => c.kind === 'cos-transfer').length, 1);
  f.advance(15000); f.Town.store(); assert.equal(f.Town.trip.phase, 'settle'); assert.equal(f.Hunt.running, true);
  f.Town.tick(); assert.equal(f.commands.filter(c => c.kind === 'cos-transfer').length, 1);
  assert.equal(f.commands.at(-1).kind, 'npc-close');
  const g = townFixture(); g.Town.begin(); g.Town.enter('store');
  g.World.gp.storage = { npc: 60, phase: 'open', capacity: 1, items: [{ slot: 0, refObjId: 999 }] }; g.World.gp.target = 60;
  g.Town.store(); assert.match(g.Town.message, /Storage is full/); assert.equal(g.commands.some(c => c.kind === 'cos-transfer'), false);
});
test('town trips start for a broken weapon, worn gear, no XP and a timer, each with its own switch', () => {
  const f = townFixture(), c = f.Town.cfg(), gp = f.World.gp, weapon = gp.inventory.find(i => i.slot === 6);
  f.pet.inventory = []; gp.inventory.find(i => i.refObjId === 15).quantity = 500;
  gp.progression = { ...(gp.progression || {}), level: 30, experience: '100' };
  assert.equal(f.Town.reason(), '', 'nothing else would start a trip');
  assert.deepEqual([c.broken, c.wear.on, c.noXp.on, c.every.on], [true, false, false, false], 'only the broken weapon is on by default');
  weapon.durability = 0; assert.equal(f.Town.reason(), 'weapon broken');
  c.broken = false; assert.equal(f.Town.reason(), '', 'switched off');
  weapon.durability = 1; c.wear.on = true; c.wear.pct = 15;
  assert.match(f.Town.reason(), /^gear durability low \(.+ at 10%\)$/, '1 of 10 is under 15%');
  weapon.durability = 2; assert.equal(f.Town.reason(), '', '20% is enough');
  weapon.durability = 1; const fields = weapon.tooltip; delete weapon.tooltip;
  assert.equal(f.Town.reason(), '', 'an unknown maximum is not guessed'); weapon.tooltip = fields; weapon.durability = 10;
  gp.inventory.push({ slot: 20, refObjId: 901, typeFlags: 44 | (6 << 7), durability: 0, variance: '0', magic: [], tooltip: weapon.tooltip });
  assert.equal(f.Town.reason(), '', 'gear in the bag is not worn gear');
  c.noXp.on = true; c.noXp.minutes = 10; f.Town.watch();
  f.advance(9 * 60000); f.Town.watch(); assert.equal(f.Town.reason(), '');
  f.advance(60000); f.Town.watch(); assert.equal(f.Town.reason(), 'no XP for 10 minutes');
  gp.progression.experience = '150'; f.Town.watch(); assert.equal(f.Town.reason(), '', 'XP came in');
  c.noXp.on = false; c.every.on = true; c.every.minutes = 60;
  // The timer counts from when hunting started: 10 minutes have already passed above.
  f.advance(40 * 60000); f.Town.watch(); assert.equal(f.Town.reason(), '');
  f.advance(10 * 60000); f.Town.watch(); assert.equal(f.Town.reason(), 'every 60 minutes');
  f.Town.begin(); assert.ok(f.Town.trip, 'the trip starts');
  assert.equal(f.Town.cycleFrom, f.Town.lastXpAt, 'starting the trip restarts both clocks');
  f.Town.cancel(); assert.equal(f.Town.reason(), '', 'so the next one is a full interval away');
  f.Hunt.stop(); f.Town.watch(); assert.deepEqual([f.Town.lastXpAt, f.Town.cycleFrom], [0, 0], 'the clocks only run while hunting');
});
test('a town trip says why it started, in the log, the status line and the diagnostics', () => {
  const f = townFixture(); f.Town.reason = () => 'gear durability low (Iron Sword at 12%)';
  f.Town.begin();
  assert.ok(f.Log.lines.some(l => /Town trip started: gear durability low \(Iron Sword at 12%\)\./.test(l.text)));
  assert.match(f.Town.status(), /\(reason: gear durability low/);
  const text = f.Diagnostics.townReason(); assert.match(text, /^gear durability low \(\d+ s ago\)$/, 'no item names in the report');
  f.Town.trip = null; f.Town.reason = () => ''; f.Town.begin();
  assert.ok(f.Log.lines.some(l => /Town trip started: started by you\./.test(l.text)));
});
test('town trips buy arrows and bolts at the weapon merchant, count the equipped stack and skip what cannot be bought', () => {
  const f = townFixture(), gp = f.World.gp, c = f.Restock.cfg().ammo;
  assert.deepEqual(JSON.parse(JSON.stringify(f.Town.ammoSupplies())), [], 'off by default');
  c.arrow.on = true; c.arrow.low = 100; c.arrow.target = 1000; c.bolt.on = true; c.bolt.low = 100; c.bolt.target = 1200;
  gp.inventory = gp.inventory.filter(i => i.refObjId !== 62 && i.refObjId !== 10376);
  gp.inventory.push({ slot: 7, refObjId: 62, typeFlags: 3, quantity: 150 }); gp.inventory.push({ slot: 20, refObjId: 62, typeFlags: 3, quantity: 40 });
  assert.equal(f.Town.ammoCount(62), 190, 'the equipped stack and the spare stack together');
  f.pet.inventory = []; f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 500;
  assert.equal(f.Town.reason(), 'ammunition running low', 'no bolts at all');
  gp.inventory.push({ slot: 21, refObjId: 10376, typeFlags: 3, quantity: 900 }); gp.inventory.find(i => i.slot === 20).quantity = 90; gp.inventory.find(i => i.slot === 7).quantity = 10;
  assert.equal(f.Town.reason(), 'ammunition running low', 'arrows are down to 100');
  gp.inventory.find(i => i.slot === 7).quantity = 300; assert.equal(f.Town.reason(), '', 'enough of both');
  gp.inventory.find(i => i.slot === 7).quantity = 10;
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.targetCapabilities = 8;
  gp.shop = { npc: 62, offers: [{ refObjId: 62, tab: 2, slot: 0, maxStack: 500, price: '2', previews: [{ refObjId: 62, typeFlags: 3 }] }] };
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'ammo', 'selling is finished, ammunition comes next');
  f.Town.tick(); const buy = f.commands.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(buy)), { kind: 'shop-buy', tab: 2, slot: 0, quantity: 500 }, 'a full stack, limited by the stack size');
  gp.inventory.find(i => i.slot === 20).quantity += 500; f.advance(1000); f.Town.tick();
  assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 2, 'the rest is bought next');
  assert.equal(f.commands.at(-1).quantity, 1000 - 600, 'only what is still missing');
  gp.inventory.find(i => i.slot === 20).quantity += 400; f.advance(1000); f.Town.tick();
  assert.match(f.Town.message, /no bolts bought, this merchant does not sell them/, 'bolts are not on offer: reported, not fatal');
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'repair', 'the trip goes on');
  assert.equal(f.Diagnostics.main().includes('undefined'), false);
});
test('town cycle rejects cached shops and waits for fresh catalogue acknowledgement', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('open-vendor'); gp.target = 61; gp.targetCapabilities = 1; gp.shop = { npc: 61, offers: [] };
  f.Town.tick(); f.advance(1000); f.Town.tick(); assert.equal(f.Town.trip.phase, 'open-vendor');
  assert.equal(f.commands.filter(c => c.kind === 'shop-open').length, 1);
  gp.shopCompletionRevision++; f.Town.tick(); assert.equal(f.Town.trip.phase, 'buy');
});
test('town cycle cancels on manual control, F8, disabled settings and unexpected travel', () => {
  for (const change of [f => { f.Manual.lastAt++; f.Town.tick(); }, f => f.toggleBot(),
      f => { f.Town.cfg().enabled = false; f.Town.tick(); }, f => f.Town.phase('reconnecting')]) {
    const f = townFixture(); f.Town.tick(); change(f);
    assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
  }
});
test('town scroll wait times out while outside world and wrong arrival never starts service', () => {
  const f = townFixture(); f.Town.tick(); f.Town.phase('entering-world');
  f.World.gp.pose.x = 1000; f.Town.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  f.World.phase = 'entering-world'; f.advance(91000); f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /timed out/);
});
test('town movement waits for collision coverage without timing out or blindly crossing obstacles', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('walk-storage'); f.Navigation.scene = null;
  const moves = f.commands.filter(c => c.kind === 'move').length;
  f.Town.tick(); assert.equal(f.commands.filter(c => c.kind === 'move').length, moves);
  f.advance(960000); f.Town.tick(); assert.ok(f.Town.trip); assert.equal(f.Hunt.running, true);
  assert.equal(f.commands.filter(c => c.kind === 'move').length, moves);
  f.Navigation.install(navProduct()); f.advance(6000); f.Town.tick();
  assert.ok(f.commands.filter(c => c.kind === 'move').length > moves);
});
test('a stalled walk to a town service says why, in plain words and without NPC names, on the panel and in reports', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('walk-vendor'); f.Navigation.scene = null; f.Navigation.error = 'Unsupported collision data';
  f.World.gp.pose.x = 5000; f.Town.tick();
  assert.match(f.Town.message, /to the potion merchant: waiting; retrying collision route\. Unsupported collision data/);
  assert.equal(f.Town.message.includes('vendor'), false); assert.equal(f.Town.message.includes('Merchant'), false);
  assert.equal(f.Diagnostics.main(), f.Town.message, 'the panel shows the walking detail instead of a generic line');
  const snap = f.Diagnostics.snapshot();
  assert.equal(snap.townDetail, f.Town.message); assert.equal(snap.navigationReady, false); assert.equal(snap.navigationError, 'Unsupported collision data');
  f.Town.cancel(); assert.equal(f.Diagnostics.snapshot().townDetail, '');
});
test('a warehouse walk that cannot get around an obstacle is skipped, other services still stop the trip', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('walk-storage'); f.World.gp.pose.x = 50;
  f.Navigation.watch = () => 'giveup';
  f.Town.tick();
  assert.ok(f.Town.trip, 'the trip carries on'); assert.equal(f.Town.trip.phase, 'walk-vendor');
  const g = townFixture(); g.Town.begin(); g.Town.enter('walk-vendor'); g.World.gp.pose.x = 50;
  g.Navigation.watch = () => 'giveup';
  g.Town.tick(); assert.equal(g.Town.trip, null); assert.match(g.Town.message, /Blocked on the way to the potion merchant/);
});
test('town movement retries blocked routes at intervals and remains cancellable', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('walk-storage'); f.World.gp.pose.x = 50;
  let plans = 0;
  f.Navigation.next = () => { plans++; return { error: 'No walkable route found.' }; };
  const moves = f.commands.filter(c => c.kind === 'move').length;
  f.Town.tick();
  for (let i = 0; i < 10; i++) { f.advance(100); f.Town.tick(); }
  assert.equal(plans, 1); assert.ok(f.Town.trip); assert.match(f.Town.message, /waiting/);
  assert.equal(f.commands.filter(c => c.kind === 'move').length, moves);
  f.advance(5000); f.Town.tick(); assert.equal(plans, 2);
  f.Navigation.next = () => ({ point: f.Town.cfg().storage });
  f.advance(5000); f.Town.tick();
  assert.equal(f.commands.filter(c => c.kind === 'move').length, moves + 1);
  f.Town.trip.travel = { stale: true };
  f.advance(21000); f.Town.tick();
  assert.equal(f.Town.trip.travel, null); assert.match(f.Town.message, /blocked route/);
  assert.equal(f.commands.filter(c => c.kind === 'move').length, moves + 1);
  f.advance(5000); f.Town.tick();
  assert.equal(f.commands.filter(c => c.kind === 'move').length, moves + 2);
  f.toggleBot(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
});

test('town can use a reachable service approach beside a blocked saved tile without crossing walls', () => {
  const f = townFixture(), blocked = new Uint8Array(9216);
  blocked[5 * 96 + 8] = 1;
  f.Navigation.install(navProduct([], blocked));
  const dest = f.Town.cfg().vendor;
  assert.equal(f.Navigation.plan(f.World.pose(), dest).length, 0);
  f.Town.begin(); f.Town.enter('walk-vendor');
  f.advance(1000);
  const from = f.Navigation.local(f.World.pose());
  f.Town.tick(); const command = f.commands.at(-1);
  assert.equal(command.kind, 'move');
  const end = f.Navigation.local(command.destination);
  assert.equal(f.Navigation.clear(from, end), true);
  assert.ok(Math.hypot(end.x - dest.x, end.z - dest.z) <= 60);
  f.World.gp.pose = { ...command.destination }; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'open-vendor');
});

test('town sells only unprotected non-elixir pet loot and waits for a full sale acknowledgement', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 };
  for (const item of [f.pet.inventory[0], f.pet.inventory[2], f.pet.inventory[3], ...f.World.items(), { refObjId: 999 }])
    assert.equal(f.Town.sellable(item), false);
  assert.equal(f.Town.sellable(f.pet.inventory[1]), true);
  f.pet.inventory[1].quantity = 3;
  f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'cos-shop-sell'); assert.equal(f.commands.at(-1).quantity, 3);
  f.pet.inventory[1].quantity = 1; f.advance(1000); f.Town.tick();
  assert.ok(f.Town.trip.pending); assert.equal(f.commands.filter(c => c.kind === 'cos-shop-sell').length, 1);
  f.advance(15000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'settle'); assert.match(f.Town.message, /not confirmed/);
  f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'npc-close');
  assert.equal(f.commands.filter(c => c.kind === 'cos-shop-sell').length, 1);
  assert.equal(f.commands.some(c => c.kind === 'shop-sell'), false);
});

test('town keeps sealed equipment and unknown rarity while allowing plus and blue gear', () => {
  const f = townFixture(), normal = { refObjId: 1100, typeFlags: 44 | (6 << 7), name: 'Sword', plus: 0, magic: [], tooltip: { fields: { rarity: 0 } } };
  f.Town.cfg().storeSox = false;
  assert.equal(f.Town.sellable(normal), true);
  for (const item of [{ ...normal, plus: 12 }, { ...normal, magic: ['123'] }, { ...normal, plus: undefined, magic: undefined }, { ...normal, tooltip: { fields: { rarity: 1 } } }]) assert.equal(f.Town.sellable(item), true);
  for (const item of [
    ...[1, 2, 3].map(itemClass => ({ ...normal, tooltip: { fields: { rarity: 2, itemClass } } })),
    { ...normal, tooltip: undefined }, { ...normal, tooltip: { fields: {} } },
    { ...normal, codename: 'ITEM_CH_SWORD_01_A_RARE' },
  ]) {
    assert.equal(f.Town.sellable(item), false, JSON.stringify(item));
    assert.equal(f.Town.eligible(item), false);
  }
});

test('town deposits Star, Moon and Sun gear from the character bag and the pet, and nothing else', () => {
  const f = townFixture(), gp = f.World.gp;
  const gear = (slot, ref, tooltip) => ({ slot, refObjId: ref, typeFlags: 44 | (6 << 7), quantity: 1, name: 'Gear', tooltip });
  gp.inventory.push(gear(20, 2001, { fields: { rarity: 2, itemClass: 2 } }), gear(21, 2002, { fields: { rarity: 0 } }), gear(22, 2003, { fields: { rarity: 1 } }));
  f.pet.inventory = [gear(0, 2004, { fields: { rarity: 2, itemClass: 3 } }), gear(1, 2005, { fields: { rarity: 0 } })];
  f.Town.begin(); f.Town.enter('store');
  gp.storage = { npc: 60, phase: 'open', capacity: 30, items: [] }; gp.target = 60;
  const stored = [];
  for (let n = 0; n < 12 && f.Town.trip?.phase === 'store'; n++) {
    f.advance(1000); f.Town.store(); const c = f.commands.at(-1);
    if (c.kind === 'cos-transfer') { const i = f.pet.inventory.find(i => i.slot === c.source); gp.inventory.push({ ...i, slot: c.destination }); f.pet.inventory = f.pet.inventory.filter(i => i.slot !== c.source); }
    else if (c.kind === 'storage-move' && f.Town.trip?.pending) { const i = gp.inventory.find(i => i.slot === c.move.source); stored.push(i.refObjId); gp.storage.items.push({ ...i, slot: c.move.destination }); gp.inventory = gp.inventory.filter(i => i.slot !== c.move.source); }
    f.advance(600); f.Town.store();
  }
  assert.deepEqual(stored.sort(), [2001, 2004]);
  assert.equal(f.Town.trip.phase, 'close-storage');
  assert.ok(gp.inventory.some(i => i.refObjId === 2002) && gp.inventory.some(i => i.refObjId === 2003));
  assert.ok(f.pet.inventory.some(i => i.refObjId === 2005));
});
test('SoX deposit can be switched off, leaving gear where it is', () => {
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().storeSox = false;
  gp.inventory.push({ slot: 20, refObjId: 2001, typeFlags: 44 | (6 << 7), quantity: 1, tooltip: { fields: { rarity: 2, itemClass: 1 } } });
  f.Town.begin(); f.Town.enter('store'); gp.storage = { npc: 60, phase: 'open', capacity: 30, items: [] }; gp.target = 60;
  f.Town.store(); assert.notEqual(f.commands.at(-1).kind, 'storage-move');
  assert.equal(f.Town.eligible(gp.inventory.at(-1)), false);
});
test('town sells ordinary pet equipment while leaving valuable equipment in the pet bag', () => {
  const f = townFixture(), gp = f.World.gp;
  const normal = { slot: 5, refObjId: 1100, typeFlags: 44 | (6 << 7), quantity: 1, plus: 12, magic: ['123'], tooltip: { fields: { rarity: 0 } } };
  const rare = { ...normal, slot: 6, refObjId: 1101, tooltip: { fields: { rarity: 2, itemClass: 3 } } };
  f.pet.status = 20; f.pet.inventory = [rare, normal];
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 };
  f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'cos-shop-sell'); assert.equal(f.commands.at(-1).slot, 5);
  f.pet.inventory = [rare]; f.advance(1000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'repair'); assert.equal(f.pet.inventory[0].refObjId, 1101);
  assert.equal(f.commands.filter(c => c.kind === 'cos-shop-sell').length, 1);
});

test('town never sells items the game marks unsellable, and skips a refused sale instead of ending the trip', () => {
  const f = townFixture(), gp = f.World.gp;
  const ware = (slot, ref, fields) => ({ slot, refObjId: ref, typeFlags: 44 | (6 << 7), quantity: 1, plus: 0, magic: [], tooltip: { fields: { rarity: 0, ...fields } } });
  const quest = ware(4, 1099, { canSell: 0 }), refused = ware(5, 1100, { canSell: 1 }), other = ware(6, 1101, { canSell: 1 });
  f.Town.cfg().storeSox = false;
  assert.equal(f.Town.sellable(quest), false, 'CanSell 0 is never offered');
  f.ItemRules.set([quest.refObjId], { act: 'sell' }); assert.equal(f.Town.sellable(quest), false, 'not even with a Sell rule');
  f.pet.status = 20; f.pet.inventory = [quest, refused, other];
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 };
  f.Town.tick(); assert.equal(f.commands.at(-1).slot, 5);
  gp.error = 'Inventory rejected: 2'; f.advance(1000); f.Town.tick();
  assert.equal(f.Town.trip?.phase, 'sell', 'a refused item does not end the trip');
  assert.equal(f.commands.filter(c => c.kind === 'cos-shop-sell').at(-1).slot, 6, 'the next item is sold');
  gp.error = null; f.pet.inventory = [quest, refused]; f.advance(1000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'repair');
  assert.equal(f.commands.filter(c => c.kind === 'cos-shop-sell').length, 2, 'the refused item is not offered again');
});

function stalledSale() {
  const f = townFixture(), gp = f.World.gp;
  const ware = (slot, ref) => ({ slot, refObjId: ref, typeFlags: 44 | (6 << 7), quantity: 1, plus: 0, magic: [], tooltip: { fields: { rarity: 0 } } });
  f.Town.cfg().storeSox = false;
  f.pet.status = 20; f.pet.inventory = [ware(5, 1100), ware(6, 1101)];
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 };
  f.Town.tick(); assert.equal(f.commands.at(-1).slot, 5);
  gp.inventoryPending = true; f.advance(16000); f.Town.tick();
  return { f, gp, ware };
}
const sales = f => f.commands.filter(c => c.kind === 'cos-shop-sell');
test('a stalled sale is not sent again: the trip waits for the game, closes the shop and sells from what is left', () => {
  const { f, gp, ware } = stalledSale();
  assert.equal(f.Town.trip?.phase, 'settle'); assert.equal(f.Hunt.running, true);
  assert.match(f.Town.message, /timed out.*Nothing is sent again.*repair merchant over/);
  f.advance(30000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'settle'); assert.equal(sales(f).length, 1, 'nothing is sent while the game is busy');
  gp.inventoryPending = false; f.pet.inventory = [ware(6, 1101)]; f.Town.tick();
  assert.equal(f.commands.at(-1).kind, 'npc-close');
  f.Town.tick(); assert.equal(f.commands.filter(c => c.kind === 'npc-close').length, 1, 'the close is sent once');
  gp.target = null; gp.shop = null; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'walk-smith');
  f.Town.walk = () => true; f.Town.tick(); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'open-smith'); assert.equal(f.commands.at(-1).kind, 'select');
  gp.target = 62; gp.targetCapabilities = 9; f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'shop-open');
  gp.shop = { npc: 62 }; gp.shopCompletionRevision++; f.Town.tick(); f.Town.tick();
  assert.deepEqual(sales(f).map(c => c.slot), [5, 6], 'the item the stalled sale took is not offered again');
  f.pet.inventory = []; f.advance(1000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'repair');
});
test('a second stalled transaction in the same trip stops the town cycle', () => {
  const { f, gp } = stalledSale();
  gp.inventoryPending = false; gp.target = null; gp.shop = null; f.Town.tick();
  f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 }; f.Town.tick();
  assert.equal(sales(f).at(-1).slot, 5);
  gp.inventoryPending = true; f.advance(16000); f.Town.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
  assert.match(f.Town.message, /Inventory transaction timed out\. No repeat command sent/);
  assert.equal(sales(f).length, 2);
});
test('a game that never finishes the stalled transaction is reloaded once, with hunting kept for the reconnect', () => {
  const { f, gp } = stalledSale(); let reloads = 0;
  f.Reconnect.doReload = () => { reloads++; };
  f.World.charName = f.Town.trip.character = 'Tester'; f.Reconnect.snapshot();
  assert.equal(f.Town.trip.phase, 'settle');
  f.advance(59000); f.Town.tick(); assert.equal(reloads, 0);
  f.advance(2000); f.Town.tick();
  assert.equal(reloads, 1); assert.equal(f.Town.trip, null);
  assert.equal(JSON.parse(f.storage.get('sro-lean-reload')).pending.hunting, true);
  assert.equal(gp.inventoryPending, true);
  assert.equal(sales(f).length, 1);
  f.Town.begin(); f.Town.enter('settle'); f.Town.trip.resume = 'walk-smith';
  f.advance(61000); f.Town.tick();
  assert.equal(reloads, 1, 'a game that never answers is not reloaded in a loop');
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /again after a reload/);
});
test('a stalled warehouse deposit puts the item first in line when the warehouse is opened again', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('store');
  gp.storage = { npc: 60, phase: 'open', capacity: 5, items: [] }; gp.target = 60;
  f.Town.store(); const move = f.commands.at(-1); assert.equal(move.kind, 'cos-transfer');
  const item = f.pet.inventory.find(i => i.slot === move.source);
  f.pet.inventory = f.pet.inventory.filter(i => i !== item); gp.inventory.push({ ...item, slot: move.destination });
  f.advance(1000); f.Town.store();
  const deposits = () => f.commands.filter(c => c.kind === 'storage-move');
  assert.equal(deposits().length, 1); assert.equal(deposits()[0].move.source, move.destination);
  gp.inventoryPending = true; f.advance(16000); f.Town.store();
  assert.equal(f.Town.trip.phase, 'settle');
  gp.inventoryPending = false; f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'npc-close');
  gp.storage = null; gp.target = null; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'walk-storage');
  f.Town.walk = () => true; f.Town.tick(); f.Town.tick();
  gp.target = 60; gp.targetCapabilities = 4; f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'storage-open');
  gp.storage = { npc: 60, phase: 'open', capacity: 5, items: [] }; f.Town.tick(); f.Town.tick();
  assert.equal(deposits().length, 2); assert.equal(deposits()[1].move.source, move.destination, 'the bag item is deposited, not left in the bag');
});
test('a stalled transaction outside a shop or the warehouse still stops the trip', () => {
  const f = townFixture();
  f.Town.begin(); f.Town.enter('pet-revive'); f.Town.trip.pending = { at: f.Town.trip.at };
  f.World.gp.inventoryPending = true; f.advance(16000);
  f.Town.pendingDone(() => false);
  assert.equal(f.Town.trip, null); assert.match(f.Town.message, /timed out\. No repeat command sent/);
});

test('town sells unprotected character bag items only when the bag switch is on', () => {
  const ware = { slot: 30, refObjId: 1100, typeFlags: 44 | (6 << 7), quantity: 1, name: 'Sword', plus: 0, magic: [], tooltip: { fields: { rarity: 0 } } };
  const run = on => {
    const f = townFixture(), gp = f.World.gp; f.Town.cfg().sellBag = on; f.Items.data.set(1100, { name: 'Sword', code: 'ITEM_CH_SWORD_01_A' }); f.Town.cfg().storeSox = false;
    f.pet.inventory = []; gp.inventory.push({ ...ware });
    f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 };
    return f;
  };
  const off = run(false); off.Town.tick();
  assert.equal(off.commands.some(c => c.kind === 'shop-sell'), false); assert.equal(off.Town.trip.phase, 'repair');
  const f = run(true), gp = f.World.gp, potions = f.World.items().filter(i => f.Town.needed(i)).length;
  f.Town.tick(); const sale = f.commands.at(-1); assert.equal(sale.kind, 'shop-sell'); assert.equal(sale.slot, 30); assert.equal(sale.quantity, 1);
  f.advance(1000); f.Town.tick(); assert.equal(f.commands.filter(c => c.kind === 'shop-sell').length, 1);
  gp.inventory = gp.inventory.filter(i => i.slot !== 30); f.advance(1000); f.Town.tick();
  assert.equal(f.Town.trip.phase, 'repair'); assert.equal(f.commands.filter(c => c.kind === 'shop-sell').length, 1);
  assert.equal(f.World.items().filter(i => f.Town.needed(i)).length, potions);
  const keep = run(true); keep.Town.cfg().keep = 'sword'; keep.Town.tick();
  assert.equal(keep.commands.some(c => c.kind === 'shop-sell'), false);
});

test('with bag selling on, a full bag sells at the repair merchant before potions are bought', () => {
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().sellBag = true; f.Town.cfg().petFull = false; f.Town.cfg().storage = null;
  const equip = gp.equipmentSlotCount || 13, held = f.World.items().length;
  gp.inventorySlotCount = equip + held + 4;
  for (let n = 0; n < 4; n++) gp.inventory.push({ slot: equip + held + n, refObjId: 3000 + n, typeFlags: 108, quantity: 1, name: 'Junk ' + n });
  assert.equal(f.World.freeBagSlots(), 0);
  f.Town.begin(); f.Town.arrived();
  assert.equal(f.Town.trip.phase, 'walk-smith');
  for (const [from, to] of [['close-storage', 'walk-smith'], ['close-smith', 'walk-vendor'], ['close-vendor', 'walk-gate']]) assert.equal(f.Town.closeNext(from), to);
  const off = townFixture(); off.Town.cfg().sellBag = false;
  off.Town.begin(); assert.equal(off.Town.closeNext('close-storage'), 'walk-vendor'); assert.equal(off.Town.closeNext('close-vendor'), 'walk-smith');
  assert.equal(off.Town.trip.sellFirst, false);
});

test('bag selling sells only ordinary race gear: never pet summons, avatars, job suits, mall items or unknown gear', () => {
  // Item types from 1.150 itemdata, all of which the merchant buys (CanSell 1).
  const kinds = [
    { refObjId: 1200, typeFlags: 12 | (2 << 5) | (1 << 7) | (2 << 11), code: 'ITEM_COS_P_RABBIT_SCROLL', name: 'Rabbit summon scroll' },
    { refObjId: 1201, typeFlags: 44 | (13 << 7), code: 'ITEM_MALL_AVATAR_M_HAT', name: 'Avatar hat', tooltip: { fields: { rarity: 0 } } },
    { refObjId: 1202, typeFlags: 44 | (7 << 7), code: 'ITEM_CH_M_TRADE_01', name: 'Trader suit', tooltip: { fields: { rarity: 0 } } },
    { refObjId: 1203, typeFlags: 108 | (13 << 7) | (14 << 11), code: 'ITEM_MALL_PREMIUM_GOLDTIME', name: 'Premium' },
    { refObjId: 1204, typeFlags: 108 | (11 << 7) | (3 << 11), code: 'ITEM_ETC_ARCHEMY_MAGICTABLET_STR_01', name: 'Tablet' },
    { refObjId: 1205, typeFlags: 44 | (6 << 7), code: 'ITEM_FORT_FORTRESS_SWORD', name: 'Fortress sword', tooltip: { fields: { rarity: 0 } } },
    { refObjId: 1206, typeFlags: 44 | (6 << 7), code: '', name: 'Uncatalogued blade', tooltip: { fields: { rarity: 0 } } },
  ];
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().sellBag = true; f.Town.cfg().storeSox = false; f.pet.inventory = [];
  kinds.forEach((k, n) => { if (k.code) f.Items.data.set(k.refObjId, { name: k.name, code: k.code }); gp.inventory.push({ slot: 40 + n, quantity: 1, magic: [], ...k, code: undefined }); });
  for (const item of f.World.items().filter(i => i.slot >= 40)) assert.equal(f.Town.sellableBag(item), false, item.name);
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 }; f.Town.tick();
  assert.equal(f.commands.some(c => c.kind === 'shop-sell'), false); assert.equal(f.Town.trip.phase, 'repair');
  // An explicit Sell rule still sells a non-gear item from the bag; plain race gear needs none.
  f.ItemRules.set([1204], { act: 'sell' }); assert.equal(f.Town.sellableBag(f.World.items().find(i => i.refObjId === 1204)), true);
  f.Items.data.set(1300, { name: 'Bow', code: 'ITEM_CH_BOW_02_B' });
  assert.equal(f.Town.sellableBag({ slot: 60, refObjId: 1300, typeFlags: 44 | (6 << 7), quantity: 1, magic: [], tooltip: { fields: { rarity: 0 } } }), true);
});

test('with bag selling on and a full bag, the trip sells before the warehouse so pet loot has a bag slot to pass through', () => {
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().sellBag = true; f.Town.cfg().petFull = false;
  const equip = gp.equipmentSlotCount || 13, held = f.World.items().length;
  gp.inventorySlotCount = equip + held + 2;
  for (let n = 0; n < 2; n++) gp.inventory.push({ slot: equip + held + n, refObjId: 3100 + n, typeFlags: 44 | (6 << 7), quantity: 1, name: 'Spare ' + n, magic: [], tooltip: { fields: { rarity: 0 } } });
  assert.equal(f.World.freeBagSlots(), 0); assert.ok(f.pet.inventory.some(i => f.Town.eligible(i)), 'the pet holds warehouse loot');
  f.Town.begin(); f.Town.arrived();
  assert.equal(f.Town.trip.phase, 'walk-smith');
  assert.deepEqual([...f.Town.trip.order], ['smith', 'storage', 'vendor', 'gate']);
  for (const [from, to] of [['close-smith', 'walk-storage'], ['close-storage', 'walk-vendor'], ['close-vendor', 'walk-gate']]) assert.equal(f.Town.closeNext(from), to);
  // With room in the bag the warehouse still comes first.
  const g = townFixture(); g.Town.cfg().sellBag = true; g.Town.cfg().petFull = false; g.Town.begin(); g.Town.arrived();
  assert.equal(g.Town.trip.phase, 'walk-storage'); assert.equal(g.Town.closeNext('close-storage'), 'walk-smith'); assert.equal(g.Town.closeNext('close-smith'), 'walk-vendor');
});

test('pet summon scrolls and flutes are never sold, from the pet or the bag, even with a Sell rule', () => {
  const summons = [
    { refObjId: 9000, typeFlags: 12 | (2 << 5) | (1 << 7) | (2 << 11), quantity: 1, name: 'Rabbit summon scroll' },
    { refObjId: 9001, typeFlags: 12 | (2 << 5) | (1 << 7) | (1 << 11), quantity: 1, name: 'Pet flute' },
  ];
  const f = townFixture(), gp = f.World.gp; f.Town.cfg().sellBag = true;
  f.pet.inventory = summons.map((s, n) => ({ slot: n, ...s }));
  summons.forEach((s, n) => { gp.inventory.push({ slot: 40 + n, ...s }); f.Items.data.set(s.refObjId, { name: s.name, code: 'ITEM_COS_P_RABBIT_SCROLL' }); });
  f.Town.begin(); f.Town.enter('sell'); gp.target = 62; gp.shop = { npc: 62 }; f.Town.tick();
  assert.equal(f.commands.some(c => /sell/.test(c.kind)), false, 'nothing offered to the merchant');
  assert.equal(f.Town.trip.phase, 'repair'); assert.equal(f.pet.inventory.length, 2);
  f.ItemRules.set([9000, 9001], { act: 'sell' });
  for (const s of summons) { assert.equal(f.Town.sellable(s), false, s.name); assert.equal(f.Town.sellableBag({ slot: 40, ...s }), false, s.name); }
});

test('Sell Star gear too sells Star instead of depositing it, and leaves Moon and Sun', () => {
  const f = townFixture(); f.Town.cfg().sellBag = true; f.Town.cfg().storeSox = true; f.Town.cfg().keep = '';
  f.Items.data.set(1400, { name: 'Star blade', code: 'ITEM_CH_SWORD_11_A_RARE' });
  const sox = { slot: 60, refObjId: 1400, name: 'Star blade', typeFlags: 44 | (6 << 7), quantity: 1, magic: [], codename: 'ITEM_CH_SWORD_11_A_RARE', tooltip: { fields: { rarity: 2, itemClass: 1 } } };
  assert.deepEqual([f.Town.depositItem(sox), f.Town.sellable(sox), f.Town.sellableBag(sox)], [true, false, false], 'default: SoX is deposited');
  f.Town.cfg().sellStar = true;
  assert.deepEqual([f.Town.depositItem(sox), f.Town.sellable(sox), f.Town.sellableBag(sox)], [false, true, true], 'switch on: SoX is sold');
  const moon = { ...sox, slot: 61, refObjId: 1401, name: 'Moon blade', codename: 'ITEM_CH_SWORD_11_B_RARE', tooltip: { fields: { rarity: 2, itemClass: 2 } } };
  assert.deepEqual([f.Town.depositItem(moon), f.Town.sellable(moon)], [true, false], 'Moon is still deposited');
  f.Town.cfg().keep = 'star blade';
  assert.equal(f.Town.sellable(sox), false, 'Keep names still protect it');
});

test('town refuses selling at the wrong merchant or after the pet is replaced', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('sell');
  f.World.gp.target = 61; f.World.gp.shop = { npc: 61 };
  f.Town.tick(); assert.equal(f.Town.trip, null); assert.equal(f.commands.some(c => c.kind === 'cos-shop-sell'), false);
  const g = townFixture(); g.Town.begin(); g.Town.enter('sell');
  g.World.gp.target = 62; g.World.gp.shop = { npc: 62 }; g.Town.tick();
  g.Town.trip.salePetGid = 999; g.advance(1000); g.Town.tick();
  assert.equal(g.Town.trip, null); assert.match(g.Town.message, /pet changed/);
});

test('town buys X-Large HP and MP even when the saved potion selections are small', () => {
  const f = townFixture(), r = f.Restock.cfg(), gp = f.World.gp;
  r.hp.on = true; r.hp.refObjId = 101; r.hp.low = 5; r.hp.target = 30; r.mp.refObjId = 102;
  f.Restock.cfg().hp.target = 50;
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [101,8,102,15].map((refObjId, slot) => ({ refObjId, slot, tab: 0, maxStack: 100, price: '10', previews: [{ refObjId, typeFlags: slot < 2 ? 2284 : 4332 }] })) };
  f.Town.buy(); assert.equal(f.commands.at(-1).slot, 1); assert.equal(f.commands.at(-1).quantity, 50);
  gp.inventory.push({ slot: 16, refObjId: 8, typeFlags: 2284, quantity: 50 });
  f.advance(1000); f.Town.buy(); assert.equal(f.commands.at(-1).slot, 3); assert.equal(f.commands.at(-1).quantity, 49);
  gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.advance(1000); f.Town.buy(); assert.equal(f.Town.trip.phase, 'close-vendor');
  assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 2);
  assert.equal(f.commands.some(c => c.kind === 'shop-buy' && [0,2].includes(c.slot)), false);
});

test('shared refill defaults are 100 HP and 300 MP and purchases only the missing potions', () => {
  const defaults = fixture().Town.supplies();
  assert.deepEqual(Array.from(defaults, s => s.target), [100, 300]);
  const f = townFixture(), gp = f.World.gp;
  f.Restock.cfg().hp.on = true; Object.assign(f.Restock.cfg().hp, { target: 100 }); f.Restock.cfg().mp.target = 300;
  gp.inventory.push({ slot: 16, refObjId: 8, typeFlags: 2284, quantity: 72 });
  gp.inventory.find(i => i.refObjId === 15).quantity = 275;
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [8,15].map((refObjId, slot) => ({ refObjId, slot, tab: 0, maxStack: 50, price: '10', previews: [{ refObjId, typeFlags: slot ? 4332 : 2284 }] })) };
  f.Town.buy(); assert.equal(f.commands.at(-1).quantity, 28); assert.equal(f.commands.at(-1).slot, 0);
  gp.inventory.find(i => i.refObjId === 8).quantity = 100;
  f.advance(1000); f.Town.buy(); assert.equal(f.commands.at(-1).quantity, 25); assert.equal(f.commands.at(-1).slot, 1);
  gp.inventory.find(i => i.refObjId === 15).quantity = 300;
  f.advance(1000); f.Town.buy(); assert.equal(f.Town.trip.phase, 'close-vendor');
});

test('shared 1000 MP target applies to low supplies, full bags and revival trips', () => {
  for (const reason of ['low', 'full', 'pet', 'revival']) {
    const f = townFixture(), r = f.Restock.cfg(); r.mp.target = 1000; f.Town.cfg().petFull = reason === 'pet';
    if (reason === 'full') {
      f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 250;
      f.World.freeBagSlots = () => 1;
      assert.equal(f.Town.reason(), 'character bag nearly full');
    } else if (reason === 'low') assert.equal(f.Town.reason(), 'potions running low');
    else if (reason === 'pet') assert.equal(f.Town.reason(), 'pickup pet nearly full');
    f.Town.begin(reason === 'revival');
    assert.equal(f.Town.trip.supplies[0].target, 1000);
    assert.equal(f.Restock.supplies()[0].target, 1000);
    // A target is a total: top up 975 to 1000, rather than buy 1000 more.
    f.World.freeBagSlots = () => 25;
    f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 975;
    f.Town.enter('buy'); f.World.gp.target = 61;
    f.World.gp.shop = { npc: 61, offers: [{ refObjId: 15, slot: 0, tab: 0, maxStack: 50, price: '10', previews: [{ refObjId: 15, typeFlags: 4332 }] }] };
    f.Town.buy(); assert.equal(f.commands.at(-1).kind, 'shop-buy'); assert.equal(f.commands.at(-1).quantity, 25);
  }
});

test('legacy town profiles migrate active refill targets once and preserve walking-only targets', () => {
  for (const enabled of [false, true]) {
    const f = fixture();
    f.storage.set('sroAsistan:v7:profile:default', JSON.stringify({ potion: { restock: {
      hp: { target: 400 }, mp: { target: 1000 }, town: { enabled, stacks: { hp: 2, mp: 6 } }
    } } }));
    f.Settings.importOriginal();
    assert.equal(f.Restock.cfg().mp.target, enabled ? 300 : 1000);
    assert.equal(f.Restock.cfg().hp.target, enabled ? 100 : 400);
    assert.equal('stacks' in f.Town.cfg(), false);
    f.Restock.cfg().mp.target = 1000;
    f.storage.set('sroAsistan:v7:profile:default', JSON.stringify(f.Settings.profile));
    f.Settings.importOriginal(); assert.equal(f.Restock.cfg().mp.target, 1000);
  }
});

test('town rejects invalid potion counts and low-stock thresholds at the refill target', () => {
  for (const value of [0, 1.5, 10001, NaN]) {
    const f = townFixture(); f.Restock.cfg().mp.target = value;
    f.Town.begin(); assert.equal(f.Town.trip, null); assert.match(f.Town.message, /low-stock/);
  }
  const f = townFixture(); f.Restock.cfg().mp.low = 50;
  f.Town.begin(); assert.equal(f.Town.trip, null); assert.match(f.Town.message, /low-stock/);
});

test('town falls back to the merchant own MP potion instead of stopping when X-Large is unavailable', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Restock.cfg().mp.refObjId = 102; f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [{ refObjId: 102, tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: 102, typeFlags: 4332 }] }] };
  f.Town.buy(); f.advance(1000); f.Town.buy(); assert.ok(f.Town.trip, f.Town.message);
  assert.equal(f.commands.some(c => c.kind === 'shop-buy' && c.slot === 0), true);
  f.Town.tier = {};
});

test('town purchase requires exact quantity gain and enough gold, without duplicate buys', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [{ refObjId: 15, tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: 15, typeFlags: 4332 }] }] };
  f.Town.buy(); assert.equal(f.commands.at(-1).quantity, 49);
  gp.inventory.find(i => i.refObjId === 15).quantity++; f.advance(1000); f.Town.buy();
  assert.ok(f.Town.trip.pending); assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
  f.advance(15000); f.Town.buy(); assert.equal(f.Town.trip.phase, 'settle');
  f.Town.tick(); assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1, 'an unconfirmed purchase is never sent again');
  const g = townFixture(); g.Town.begin(); g.Town.enter('buy'); g.World.gp.target = 61; g.World.gp.shop = gp.shop; g.World.gp.progression.gold = '1';
  g.Town.buy(); assert.equal(g.commands.some(c => c.kind === 'shop-buy'), false); assert.match(g.Town.message, /gold/);
});
test('town buys what the gold covers and moves on instead of failing in the potion shop', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61; gp.progression.gold = '200';
  gp.shop = { npc: 61, offers: [{ refObjId: 15, tab: 0, slot: 0, maxStack: 100, price: '10', previews: [{ refObjId: 15, typeFlags: 4332 }] }] };
  f.Town.buy(); assert.equal(f.commands.at(-1).quantity, 20);
  gp.inventory.find(i => i.refObjId === 15).quantity += 20; gp.progression.gold = '5'; f.advance(1000); f.Town.buy();
  gp.progression.gold = '5'; f.advance(1000); f.Town.buy();
  assert.ok(f.Town.trip, 'trip continues'); assert.equal(f.commands.filter(c => c.kind === 'shop-buy').length, 1);
  assert.ok(f.Town.trip.buySkipped.includes(15));
});
test('town repairs require restored durability and reverse return requires all final checks', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.begin(); f.Town.enter('repair'); gp.target = 62; gp.shop = { npc: 62 };
  f.Town.repair(); f.advance(1000); f.Town.repair(); assert.equal(f.Town.trip.phase, 'repair');
  assert.equal(f.commands.filter(c => c.kind === 'shop-repair').length, 1);
  f.advance(15000); f.Town.repair(); assert.equal(f.Town.trip, null);
  const g = townFixture(); g.Town.begin(); g.Town.enter('reverse'); g.World.gp.target = 63; g.World.gp.targetCapabilities = 0x20000000;
  g.Town.tick(); assert.equal(g.commands.some(c => c.kind === 'travel-gate'), false); assert.equal(g.Hunt.running, false);
});
test('town service keeps emergency potions active and prevents scroll actions in the same tick', () => {
  const f = townFixture(); f.Town.begin(); f.World.gp.inventory.push({ slot: 20, refObjId: 101, typeFlags: 2284, quantity: 5 });
  f.World.gp.vitals = [{ gid: 1, hp: 10, mp: 100, maxHp: 100, maxMp: 100 }];
  f.Controller.tick(); assert.equal(f.commands.at(-1).kind, 'item-use'); assert.equal(f.commands.at(-1).slot, 20);
  assert.equal(f.Town.trip.phase, 'recall'); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
});
test('town scroll refill uses gold offers, rejects packages and requires a spare return scroll', () => {
  const f = townFixture(), gp = f.World.gp;
  gp.inventory.find(i => i.refObjId === 15).quantity = 50; gp.inventory = gp.inventory.filter(i => i.slot !== 13);
  // A missing return scroll is detected before leaving a shop, rather than returning unprepared.
  gp.inventory.push({ slot: 13, refObjId: 200, typeFlags: 0x09ec, quantity: 1 });
  f.Town.begin(); f.Town.enter('buy'); gp.inventory = gp.inventory.filter(i => i.slot !== 13); gp.target = 61;
  const offer = { refObjId: 200, tab: 0, slot: 3, maxStack: 50, price: '50', currency: 1, previews: [{ refObjId: 200, typeFlags: 0x09ec }] };
  gp.shop = { npc: 61, offers: [offer] }; f.Town.buy(); assert.equal(f.commands.at(-1).quantity, 2); assert.equal(f.commands.at(-1).slot, 3);
  gp.inventory.push({ slot: 13, refObjId: 200, typeFlags: 0x09ec, quantity: 2 }); f.advance(600); f.Town.buy(); assert.equal(f.Town.trip.phase, 'close-vendor');
  const g = townFixture(); g.Town.begin(); g.Town.enter('buy'); g.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 13); g.World.gp.target = 61;
  g.World.gp.shop = { npc: 61, offers: [{ ...offer, contents: [{ refObjId: 200, quantity: 10 }] }] };
  g.Town.buy(); assert.equal(g.commands.some(c => c.kind === 'shop-buy'), false); assert.equal(g.Hunt.running, false);
});
test('F8 requests native cancellation for an active town scroll cast', () => {
  const f = townFixture(); f.Town.tick(); f.World.gp.returnScroll = { name: 'Return', startedAtMs: 100000, durationMs: 20000 };
  f.toggleBot(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
  assert.equal(f.commands.filter(c => c.kind === 'return-cancel').length, 1);
});
test('town setup records reachable approach points and validates the merchant catalogue', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Hunt.stop(); f.UI.draw = () => {}; gp.pose.x = 100;
  gp.target = 61; gp.targetCapabilities = 1;
  const old = f.Town.cfg().vendor; f.Town.save('vendor'); assert.equal(f.Town.cfg().vendor, old);
  gp.shop = { npc: 61, offers: [{ refObjId: 103, previews: [{ refObjId: 103, typeFlags: 4332 }] }] };
  f.Town.save('vendor'); assert.equal(f.Town.cfg().vendor.x, 100); assert.equal(f.Town.cfg().vendor.npc.x, 170);
  assert.equal(f.Restock.cfg().mp.refObjId, 103); assert.equal(f.Town.npc('vendor').gid, 61);
  gp.target = 60; gp.targetCapabilities = 4; gp.pose.x = 1000;
  const warehouse = f.Town.cfg().storage; f.Town.save('storage'); assert.equal(f.Town.cfg().storage, warehouse);
});
test('unexpected world reset cancels service and independent party work continues during town travel', () => {
  const f = townFixture(); f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  let calls = 0; f.Party.tick = () => calls++;
  const g = townFixture(); g.UI.mount = g.UI.draw = g.UI.update = g.Ticker.start = () => {}; g.boot();
  g.Town.begin(); g.Town.enter('walk-storage'); g.bus.emit('reset'); assert.equal(g.Town.trip, null); assert.equal(g.Hunt.running, false);
  f.Town.tick(); f.bus.emit('reset'); assert.ok(f.Town.trip); assert.equal(f.Hunt.running, true);
  f.Controller.tick(); assert.equal(calls, 1);
});
test('full pet latches town departure during combat and pending pickup without starting another fight', () => {
  for (const busy of ['cast', 'inventory']) {
    const f = townFixture(); f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
    let fights = 0; f.Hunt.tick = () => fights++;
    let casting = busy === 'cast'; f.World.isCasting = () => casting;
    f.World.gp.inventoryPending = busy === 'inventory';
    f.Controller.tick();
    assert.ok(f.Town.trip, 'Full pet must own the controller while ' + busy + ' settles');
    assert.equal(fights, 0); assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
    f.Controller.tick(); assert.equal(fights, 0);
    casting = false; f.World.gp.inventoryPending = false; f.advance(600); f.Controller.tick();
    assert.equal(f.Town.trip.phase, 'recall-wait'); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  }
});
test('reserved town departure times out instead of returning to combat or repeating scrolls', () => {
  const f = townFixture(); f.World.gp.inventoryPending = true; f.Controller.tick();
  assert.ok(f.Town.trip); f.advance(31000); f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
  assert.match(f.Town.message, /did not settle/); assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
});
test('town readiness explains disabled automation and missing prerequisites before the pet fills', () => {
  const f = townFixture(); f.Town.cfg().enabled = false; assert.match(f.Town.status(), /chime is an alert/);
  f.Town.cfg().enabled = true; f.Town.cfg().gate = null; assert.match(f.Town.status(), /not ready:.*world statue/);
  f.Town.cfg().gate = { regionId: 1, x: 100, y: 0, z: 100 }; assert.match(f.Town.status(), /ready:/);
});
test('town recognizes the repair service bit and the Hotan teleport statue entity', () => {
  const f = townFixture(), gp = f.World.gp; f.Hunt.stop(); f.UI.draw = () => {}; gp.pose.x = 200;
  gp.target = 62; gp.targetCapabilities = 9; f.Town.cfg().smith = null;
  f.Town.save('smith'); assert.ok(f.Town.cfg().smith, 'Shop + repair merchant must be accepted');
  const statue = f.World.ents.get(63); statue.kind = 'teleport'; gp.target = 63; gp.targetCapabilities = 0x20000080; f.Town.cfg().gate = null;
  f.Town.save('gate'); assert.ok(f.Town.cfg().gate, 'World statue must be accepted');
  assert.equal(f.Town.npc('gate').gid, 63);
  f.Hunt.start(); f.Town.begin(); f.Town.enter('open-smith'); gp.target = 62; gp.targetCapabilities = 9;
  f.Town.tick(); assert.equal(f.commands.at(-1).kind, 'shop-open');
  gp.shop = { npc: 62 }; gp.shopCompletionRevision++; f.Town.tick(); assert.equal(f.Town.trip.phase, 'sell');
  f.Town.enter('open-gate'); gp.target = 63; gp.targetCapabilities = 0x20000080; gp.npcConversation = { gid: 63, phase: 'closed' };
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'open-gate');
  gp.npcConversation = { gid: 63, phase: 'menu' };
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'reverse');
  assert.equal(f.commands.some(c => c.kind === 'npc-talk'), false, 'Statue menu comes from selection, not Talk');
});
test('town rejects special-trade-only merchants as smiths and names only missing services', () => {
  const f = townFixture(), gp = f.World.gp; f.Hunt.stop(); f.UI.draw = () => {}; gp.pose.x = 200;
  gp.target = 62; gp.targetCapabilities = 0x801; f.Town.cfg().smith = null; f.Town.cfg().gate = null;
  f.Town.save('smith'); assert.equal(f.Town.cfg().smith, null);
  assert.equal(f.Town.validate(), 'Save missing town services: repair merchant, world statue / teleport.');
});
test('town recall accepts landing variation around the saved arrival area', () => {
  const f = townFixture(); f.Town.tick(); f.Town.phase('entering-world');
  f.World.gp.pose = { regionId: 1, x: 350, y: 40, z: 180 }; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'walk-storage', 'A nearby landing must start town services');
});
test('town recognizes a native world reset and waits for the fresh local player before services', () => {
  const f = townFixture(); f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot(); f.Town.tick();
  f.World.applyEvent({ kind: 'reset', epoch: 2 }); f.World.gp.pose.x = 350;
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  f.World.applyEvent({ kind: 'spawn', entity: { gid: 1, kind: 'player', regionId: 1, x: 350, y: 0, z: 100, appearanceState: [0], movementMode: 0 } });
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'walk-storage');
});
test('town arrival still needs travel confirmation, settled state and the configured area', () => {
  const f = townFixture(); f.Town.cfg().arrivalRadius = 100; f.Town.tick(); f.World.gp.pose.x = 100;
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'recall-wait'); assert.match(f.Town.message, /accept the scroll request/);
  f.Town.phase('entering-world'); f.World.gp.pose.x = 350; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'recall-wait'); assert.match(f.Town.message, /25 m.*10 m/);
  f.World.gp.pose.x = 100; f.World.gp.returnScroll = {}; f.Town.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  f.World.gp.returnScroll = null; f.Town.tick(); assert.equal(f.Town.trip.phase, 'walk-storage');
});
test('reverse arrival cannot reuse the earlier recall transition', () => {
  const f = townFixture(); f.Town.tick(); f.Town.phase('entering-world'); f.Town.enter('reverse-wait');
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'reverse-wait');
  f.Town.phase('entering-world'); f.Town.tick(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, true);
});



test('alternating potion use cannot starve the return scroll', () => {
  const f = townFixture();
  // Model potion dispatch at every eligible 400 ms controller tick.
  let time = 100000;
  f.Potion.tick = () => { f.Potion.lastUse = time; };
  f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall');
  for (let i = 0; i < 10 && !f.commands.some(c => c.kind === 'item-use'); i++) {
    f.advance(100); time += 100; f.Controller.tick();
  }
  assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 13).length, 1);
  assert.equal(f.Town.trip.phase, 'recall-wait');
});

test('full character bag recalls before requiring space in town', () => {
  const f = townFixture(); f.pet.inventory = [];
  f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.World.gp.inventorySlotCount = 16;
  f.Settings.profile.hunt.stopInvFull = true;
  f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  assert.equal(f.commands.some(c => c.kind === 'item-use'), true);
  f.Town.phase('entering-world'); f.World.gp.pose.x = 100;
  f.advance(1000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /Returned to town; free/);
});

test('a pet full of protected items never sends the bot to town, and never strands it there', () => {
  const f = townFixture(); f.pet.inventory = [f.pet.inventory[2]]; f.pet.status = 1;
  assert.equal(f.Town.petClearable(f.Loot.pet()), false);
  assert.notEqual(f.Town.reason(), 'pickup pet nearly full');
  // A trip for another reason arrives without stopping the hunt because the pet cannot be emptied.
  f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  f.Town.phase('entering-world'); f.World.gp.pose.x = 100;
  f.advance(1000); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.doesNotMatch(f.Town.message, /pet is full/);
});

test('town revival overrides stop default and preserves reverse intent through bootstrap', () => {
  const f = townFixture();
  f.Town.cfg().deathReturn = 'death';
  f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  f.Settings.profileKey = 'profile:TestHero';
  f.World.local().appearanceState[0] = 2;
  f.Controller.tick(); f.advance(5100); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'rebirth' && c.choice === 1).length, 1);
  f.bus.emit('phase', 'entering-world'); f.bus.emit('reset'); f.bus.emit('character', 'TestHero');
  assert.equal(f.Controller.resumeAfterRevive, true);
  f.World.local().appearanceState[0] = 0; f.World.gp.pose.x = 100;
  f.World.gp.inventoryPending = true; f.Controller.tick(); assert.equal(f.Town.trip, null);
  f.World.gp.inventoryPending = false; f.Controller.tick();
  assert.equal(f.Town.trip.phase, 'walk-storage'); assert.equal(f.Town.trip.origin.x, 700);
  assert.equal(f.Hunt.deathAt, 0); assert.equal(f.WalkBack.active, null);
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  f.pet.inventory = [];
  f.Town.enter('reverse'); f.World.gp.target = 63; f.World.gp.targetCapabilities = 0x20000000;
  f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.World.gp.inventory.find(i => i.slot === 6).durability = 10;
  f.advance(1000); f.Controller.tick();
  const reverse = f.commands.find(c => c.kind === 'travel-gate');
  assert.equal(reverse.type, 5); assert.equal(reverse.target, 3);
  f.bus.emit('phase', 'entering-world'); f.bus.emit('reset'); f.World.gp.pose.x = 700;
  f.advance(1000); f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, true);
  f.advance(1000); f.Controller.tick(); assert.equal(f.Town.trip, null);
});

test('after a death the bot reverses to the last return-scroll point unless it chose the death spot and died inside the hunting area', () => {
  const f = townFixture(), H = f.Hunt.cfg();
  assert.equal(f.botProfile({}).potion.restock.town.deathReturn, 'recall', 'the default keeps the bot able to start hunting after the reverse');
  assert.equal(f.botProfile({ potion: { restock: { town: { deathReturn: 'nonsense' } } } }).potion.restock.town.deathReturn, 'recall');
  const choose = (setting, deathAt) => {
    const g = townFixture(); g.Town.cfg().deathReturn = setting; g.Town.deathPoint = deathAt(g.Hunt.cfg().center);
    g.Town.lastScrollPoint = { ...g.Hunt.cfg().center }; g.Town.begin(true); return g.Town.trip ? g.Town.trip.reverseChoice : null;
  };
  const inside = c => ({ ...c, x: c.x + 10 }), outside = c => ({ ...c, x: c.x + 5000 });
  assert.equal(choose('recall', inside), 2); assert.equal(choose('death', inside), 3, 'chosen and inside the hunting area');
  assert.equal(choose('death', outside), 2, 'a death spot outside the hunting area cannot restart hunting, so the scroll point is used');
  assert.equal(choose('death', () => null), 2, 'no known death spot');
});
test('death during departure recovers instead of silently stopping hunting', () => {
  const f = townFixture(); f.Controller.tick();
  f.World.local().appearanceState[0] = 2; f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, true);
  f.advance(5100); f.Controller.tick();
  assert.equal(f.commands.some(c => c.kind === 'rebirth'), true);
  f.World.local().appearanceState[0] = 0; f.World.gp.pose.x = 100;
  f.Controller.tick(); assert.equal(f.Town.trip.phase, 'walk-storage');
  f.stopAll(); f.Controller.tick(); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
});

test('disabling town revival preserves explicit stop on death', () => {
  const f = townFixture(); f.Town.cfg().revive = false;
  f.World.local().appearanceState[0] = 2; f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.equal(f.commands.some(c => c.kind === 'rebirth'), false);
});



test('near-hunt party revival resumes without waiting for town arrival', () => {
  const f = townFixture(); f.pet.inventory = [];
  f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.World.local().appearanceState[0] = 2; f.Controller.tick();
  f.World.local().appearanceState[0] = 0; f.Controller.tick();
  assert.equal(f.Hunt.deathAt, 0); assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, true);
});



test('departure retries a rate-limited stop without needing the bot toggled', () => {
  for (const trigger of ['potions', 'pet']) {
    const f = townFixture();
    if (trigger === 'potions') f.pet.inventory = [];
    else f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
    let fighting = true;
    f.World.isCasting = () => fighting;
    // A hunt move was just dispatched before the inventory update triggers town.
    f.Cmd.move(f.World.pose());
    const post = f.Hook.post;
    f.Hook.post = msg => {
      post(msg);
      if (msg.command.command.kind === 'move') fighting = false;
    };
    f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall');
    for (let n = 0; n < 20; n++) { f.advance(100); f.Controller.tick(); }
    assert.equal(f.Town.trip.phase, 'recall-wait', 'Must recover automatically for ' + trigger);
    assert.equal(f.Hunt.running, true);
    assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 13).length, 1);
  }
});

test('enabled town departure takes ownership from a dormant walking-restock trip', () => {
  const f = townFixture();
  f.Restock.trip = { phase: 'vendor', manualAt: f.Manual.lastAt };
  f.Controller.tick();
  assert.equal(f.Restock.trip, null);
  assert.equal(f.Town.trip.phase, 'recall-wait');
  assert.equal(f.commands.filter(c => c.kind === 'item-use' && c.slot === 13).length, 1);
});


test('departure retries an unobserved stop at bounded intervals then recalls once', () => {
  const f = townFixture(); let fighting = true, stops = 0;
  f.World.isCasting = () => fighting;
  const post = f.Hook.post;
  f.Hook.post = msg => {
    post(msg);
    if (msg.command.command.kind === 'move' && ++stops === 2) fighting = false;
  };
  f.Controller.tick();
  for (let n = 0; n < 14; n++) { f.advance(100); f.Controller.tick(); }
  assert.equal(stops, 1); assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
  f.advance(100); f.Controller.tick(); assert.equal(stops, 2);
  f.advance(100); f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall-wait');
  for (let n = 0; n < 30; n++) { f.advance(100); f.Controller.tick(); }
  assert.equal(stops, 2); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
});

test('a blocked movement queue settles automatically but F8 still cancels departure', () => {
  for (const cancel of [false, true]) {
    const f = townFixture(); f.World.gp.pendingMoves = 25;
    f.Controller.tick(); assert.equal(f.Town.trip.phase, 'recall');
    assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
    if (cancel) f.stopAll();
    f.World.gp.pendingMoves = 0;
    f.advance(600); f.Controller.tick(); f.advance(100); f.Controller.tick();
    if (cancel) { assert.equal(f.Town.trip, null); assert.equal(f.commands.some(c => c.kind === 'item-use'), false); }
    else assert.equal(f.Town.trip.phase, 'recall-wait');
  }
});



test('unaccepted return scroll retries after fresh settled gameplay instead of needing a toggle', () => {
  const f = townFixture(); f.Controller.tick();
  assert.equal(f.Town.trip.phase, 'recall-wait');
  // Native worker rejects before sending when its inventory lane became busy.
  f.World.applyGameplay({ ...f.World.gp, inventoryPending: true, error: 'Inventory is busy' });
  f.advance(6000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  f.World.applyGameplay({ ...f.World.gp, inventoryPending: false });
  f.Controller.tick();
  for (let i = 0; i < 15; i++) { f.advance(100); f.Controller.tick(); }
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 2);
  assert.equal(f.Hunt.running, true);
});


test('scroll acknowledgement prevents retries for active casts, spent stacks and world transitions', () => {
  for (const acceptedBy of ['cast', 'quantity', 'transition', 'last-stack']) {
    const f = townFixture();
    if (acceptedBy === 'last-stack') f.World.gp.inventory.find(i => i.slot === 13).quantity = 1;
    f.Controller.tick();
    const gp = { ...f.World.gp, inventory: f.World.gp.inventory.map(i => ({ ...i })) };
    if (acceptedBy === 'cast') gp.returnScroll = { startedAtMs: 100000, durationMs: 30000 };
    if (acceptedBy === 'quantity') gp.inventory.find(i => i.slot === 13).quantity--;
    if (acceptedBy === 'last-stack') gp.inventory = gp.inventory.filter(i => i.slot !== 13);
    if (acceptedBy === 'transition') f.Town.phase('entering-world');
    f.World.applyGameplay(gp); f.advance(6000); f.Controller.tick();
    assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1, acceptedBy);
    assert.equal(f.Town.trip.scrollRequest.accepted, true, acceptedBy);
  }
});

test('unknown, stale or busy inventory never authorizes a repeated scroll', () => {
  for (const state of ['stale', 'pending', 'missing-pending', 'missing-inventory', 'casting']) {
    const f = townFixture(); f.Controller.tick();
    const gp = { ...f.World.gp };
    if (state === 'pending') gp.inventoryPending = true;
    if (state === 'missing-pending') delete gp.inventoryPending;
    if (state === 'missing-inventory') delete gp.inventory;
    if (state === 'casting') f.World.isCasting = () => true;
    if (state !== 'stale') f.World.applyGameplay(gp);
    f.advance(6000); f.Controller.tick();
    assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1, state);
    assert.equal(f.Town.trip.phase, 'recall-wait', state);
  }
});

test('native inventory timeout stops with resynchronization guidance instead of retrying', () => {
  const f = townFixture(); f.Controller.tick();
  f.World.applyGameplay({ ...f.World.gp, inventoryPending: true, error: 'Inventory transaction timed out; reconnect to resynchronize' });
  f.advance(11000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /reconnect to resynchronize/);
});

test('unaccepted scroll retries are bounded and retain rejection diagnostics', () => {
  const f = townFixture(); f.Controller.tick();
  for (let attempt = 0; attempt < 3; attempt++) {
    f.World.applyGameplay({ ...f.World.gp, inventoryPending: false, error: 'Inventory rejected: 93' });
    f.advance(6000); f.Controller.tick();
    for (let n = 0; n < 12; n++) { f.advance(100); f.Controller.tick(); }
  }
  assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 3);
  assert.equal(f.Hunt.running, false); assert.match(f.Town.message, /three attempts.*Inventory rejected/);
  assert.ok(f.Town.history.some(row => row.attempts === 3));
  f.toggleBot();
  assert.ok(f.Town.history.some(row => row.error === 'Inventory rejected: 93'));
});

test('reverse return also retries unaccepted requests without duplicating accepted scrolls', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('reverse');
  const gp = f.World.gp; gp.target = 63; gp.targetCapabilities = 0x20000000;
  gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  gp.inventory.find(i => i.slot === 6).durability = 10;
  f.Town.tick(); assert.equal(f.Town.trip.phase, 'reverse-wait');
  f.World.applyGameplay({ ...gp }); f.advance(6000); f.Town.tick();
  f.advance(100); f.Town.tick();
  assert.equal(f.commands.filter(c => c.kind === 'travel-gate').length, 2);
  f.World.applyGameplay({ ...f.World.gp, returnScroll: { durationMs: 30000 } });
  f.advance(6000); f.Town.tick();
  assert.equal(f.commands.filter(c => c.kind === 'travel-gate').length, 2);
});

test('F8 cancels an unaccepted scroll retry and status names gating states', () => {
  const f = townFixture(); f.Controller.tick(); f.stopAll();
  f.World.applyGameplay({ ...f.World.gp }); f.advance(6000); f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.commands.filter(c => c.kind === 'item-use').length, 1);
  assert.ok(f.Town.history.some(row => row.event === 'stop' && row.phase === 'recall-wait'));
  f.Town.message = ''; assert.match(f.Town.status(), /bot is stopped/);
  f.Hunt.start(); f.WalkBack.active = {}; assert.match(f.Town.status(), /walk-back is active/);
  f.WalkBack.active = null; f.Manual.lastAt = 100000 + 6000; assert.match(f.Town.status(), /manual control/);
});



test('diagnostic sampling cannot prevent manual stop on an inconsistent snapshot', () => {
  const f = townFixture(); f.Controller.tick();
  f.Town.reason = () => { throw Error('incomplete snapshot'); };
  assert.doesNotThrow(() => f.stopAll());
  assert.equal(f.Hunt.running, false); assert.equal(f.Town.trip, null);
});



test('death reverse landing within the hunt area resumes actual combat away from exact center', () => {
  const f = townFixture(); f.Town.lastScrollPoint = null;
  f.World.gp.pose.x = 100; f.Town.begin(true); f.Town.enter('reverse-wait');
  f.Town.phase('entering-world'); f.World.gp.pose.x = 950;
  f.pet.inventory = []; f.World.gp.inventory.find(i => i.refObjId === 15).quantity = 50;
  f.World.ents.set(30, { gid: 30, kind: 'monster', name: 'Mob', regionId: 1, x: 960, z: 100, attackFlags: 16, appearanceState: [0] });
  f.World.gp.target = 30;
  f.Controller.tick(); assert.equal(f.Town.trip, null, f.Town.message);
  f.advance(1000); f.Controller.tick();
  assert.ok(f.commands.some(c => c.kind === 'attack' && c.gid === 30), 'Hunting must issue an attack after returning');
});

test('potions cannot postpone confirmed reverse arrival and hunting handoff', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('reverse-wait');
  f.Town.phase('entering-world'); f.World.gp.pose.x = 700;
  f.Potion.tick = () => { f.Potion.lastUse = 100000; };
  f.Controller.tick(); assert.equal(f.Town.trip, null, f.Town.message);
});


test('death return accepts the current hunt area even with an older remembered scroll point', () => {
  const f = townFixture(); f.Town.lastScrollPoint = { ...f.World.pose(), x: 1500 };
  f.World.gp.pose.x = 100; f.Town.begin(true); f.Town.enter('reverse-wait');
  f.Town.phase('entering-world'); f.World.gp.pose.x = 950;
  f.Town.tick(); assert.equal(f.Town.trip, null);
  assert.equal(f.Town.lastScrollPoint.x, 1500, 'death return must not overwrite the remembered recall point');
});

test('death arrival still requires settled travel inside the expected destination area', () => {
  for (const blocked of ['no-transition', 'pending', 'scroll', 'no-player', 'outside', 'other-world', 'ordinary-trip']) {
    const f = townFixture(); f.World.gp.pose.x = 100;
    f.Town.begin(blocked !== 'ordinary-trip'); f.Town.enter('reverse-wait');
    if (blocked !== 'no-transition') f.Town.phase('entering-world');
    f.World.gp.pose.x = blocked === 'outside' ? 1500 : 950;
    if (blocked === 'pending') f.World.gp.inventoryPending = true;
    if (blocked === 'scroll') f.World.gp.returnScroll = { durationMs: 30000 };
    if (blocked === 'no-player') f.World.ents.delete(1);
    if (blocked === 'other-world') f.World.gp.pose.regionId = 0x8001;
    f.Town.tick(); assert.ok(f.Town.trip, blocked);
    assert.equal(f.Town.trip.phase, 'reverse-wait', blocked);
  }
});

test('stopping death return before arrival never resumes hunting', () => {
  const f = townFixture(); f.World.gp.pose.x = 100;
  f.Town.begin(true); f.Town.enter('reverse-wait'); f.Town.phase('entering-world');
  f.stopAll(); f.World.gp.pose.x = 950; f.advance(1000); f.Controller.tick();
  assert.equal(f.Town.trip, null); assert.equal(f.Hunt.running, false);
  assert.equal(f.commands.some(c => c.kind === 'attack'), false);
});
function alchemyFixture(powder = false) {
  const f = fixture();
  f.World.gp.alchemy = { visible: true, pending: false, mode: 'reinforce', flags: 0, error: null, slot: null };
  f.World.gp.inventory = [
    { slot: 13, refObjId: 100, typeFlags: 44 | (6 << 7), plus: 0, durability: 100, variance: '123', magic: [], quantity: 1, name: 'Test weapon', tooltip: { fields: { itemClass: 25 } } },
    { slot: 14, refObjId: 3679, typeFlags: 0x0d6c, quantity: 10 },
    { slot: 15, refObjId: 3691, typeFlags: 0x156c, quantity: 10 },
  ];
  Object.assign(f.Settings.profile.alchemy, { target: 3, limit: 20, powder });
  f.Alchemy.select(13);
  f.Alchemy.init();
  function result(flags, plus = 1, extra = {}) {
    const gp = f.World.gp, pending = f.Alchemy.pending;
    const inventory = gp.inventory.map(i => i.slot === 13 ? { ...i, plus } :
      i.slot === 14 || powder && i.slot === 15 ? { ...i, quantity: i.quantity - 1 } : i).filter(i => flags === 0x40 ? i.slot !== 13 : true);
    f.World.applyGameplay({ ...gp, inventory, inventoryPending: false,
      alchemy: { ...gp.alchemy, pending: false, flags, slot: 13, error: null, ...extra } });
    assert.ok(pending);
    f.Controller.tick();
  }
  return { ...f, result };
}

test('alchemy takes up to 9999 enhancement attempts', () => {
  let f = alchemyFixture(); f.Settings.profile.alchemy.limit = 9999; f.Alchemy.start();
  assert.ok(f.Alchemy.run, f.Alchemy.message); assert.equal(f.Alchemy.run.cfg.limit, 9999);
  f = alchemyFixture(); f.Settings.profile.alchemy.limit = 10000; f.Alchemy.start();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /attempts from 1 to 9999/);
});
test('alchemy closes its native window on stop without cancelling a sent reinforcement', () => {
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick();
  f.World.applyGameplay({ ...f.World.gp, alchemy: { ...f.World.gp.alchemy, pending: true, slot: 13 } });
  f.Alchemy.stop();
  assert.equal(f.commands.at(-1).kind, 'alchemy-close');
  assert.ok(f.Alchemy.pending); assert.equal(f.Alchemy.run, null);
  f.Alchemy.stop(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-close').length, 1);
  f.result(0x10, 1); assert.equal(f.Alchemy.pending, null);
  f.advance(2000); f.Controller.tick();
  assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
});

test('alchemy closes after reaching its target and orders close after an unfinished open', () => {
  const f = alchemyFixture(); f.Settings.profile.alchemy.target = 1;
  f.Alchemy.start(); f.Controller.tick(); f.result(0x10, 1);
  assert.equal(f.commands.at(-1).kind, 'alchemy-close');
  const opening = alchemyFixture(); opening.World.gp.alchemy.visible = false;
  opening.Alchemy.start(); opening.Controller.tick(); opening.Alchemy.stop();
  assert.deepEqual(Array.from(opening.commands, c => c.kind), ['alchemy-open', 'alchemy-close']);
  opening.World.applyGameplay({ ...opening.World.gp, alchemy: { ...opening.World.gp.alchemy, visible: false } });
  opening.Controller.tick(); assert.equal(opening.commands.length, 2);
});

test('alchemy cleanup leaves unrelated native processes and a new world untouched', () => {
  const idle = alchemyFixture(); idle.Alchemy.stop(); assert.equal(idle.commands.length, 0);
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick();
  f.World.gp.alchemy.mode = 'compound'; f.Alchemy.stop();
  assert.equal(f.commands.some(c => c.kind === 'alchemy-close'), false);
  const r = alchemyFixture(); r.Alchemy.start(); r.Controller.tick(); r.bus.emit('reset');
  assert.equal(r.commands.some(c => c.kind === 'alchemy-close'), false);
});

test('alchemy sends native reinforcement slots and confirms success and failure before continuing', () => {
  const f = alchemyFixture(true); f.Alchemy.start(); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands[0])), { kind: 'alchemy-start', mode: 'reinforce', slots: [13, 14, 15] });
  for (let n = 0; n < 10; n++) { f.advance(100); f.Controller.tick(); }
  assert.equal(f.commands.length, 1); assert.equal(f.Alchemy.result.elixirs, 0);
  f.result(0x10, 1); assert.equal(f.Alchemy.result.successes, 1); assert.equal(f.Alchemy.result.powders, 1);
  f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.advance(1000); f.Controller.tick(); assert.equal(f.commands.length, 2);
  f.result(0x21, 0); assert.equal(f.Alchemy.result.failures, 1); assert.equal(f.Alchemy.item().plus, 0);
  assert.equal(f.Alchemy.result.elixirs, 2); assert.equal(f.Alchemy.result.powders, 2);
});

function stoneFixture(change = {}) {
  const f = alchemyFixture();
  const refs = [{ paramId: 77, optionName: 'MATTR_LUCK' }, { paramId: 78, optionName: 'MATTR_SOLID' }, { paramId: 79, optionName: 'MATTR_ATHANASIA' }];
  f.World.gp.inventory = f.World.gp.inventory.map(i => i.slot === 13 ? { ...i, magicReferences: refs } : i);
  f.World.gp.inventory.push({ slot: 16, refObjId: 6879, typeFlags: 0x3dec, quantity: 3 }, { slot: 17, refObjId: 6867, typeFlags: 0x3dec, quantity: 3 },
    { slot: 18, refObjId: 6855, typeFlags: 0x3dec, quantity: 3 });
  Object.assign(f.Settings.profile.alchemy.stones, { luck: 2, steady: 0, immortal: 0, astral: 0 }, change);
  { const a = f.Settings.profile.alchemy; for (const k of Object.keys(a.use)) { a.use[k] = (a.stones[k] || 0) > 0; a.stones[k] = Math.max(1, a.stones[k] || 0); } }
  Object.assign(f.Settings.profile.alchemy.from, { powder: 0, luck: 0, steady: 0, immortal: 0, astral: 0 });
  f.Alchemy.select(13);
  const have = { 77: 0, 78: 0, 79: 0 };
  // The game fuses one stone: the bag loses it and the weapon's option count rises.
  f.fused = (slot, param, count) => {
    const gp = f.World.gp; have[param] = count;
    const inventory = gp.inventory.map(i => i.slot === slot ? { ...i, quantity: i.quantity - 1 } : i.slot === 13 ? { ...i, magic: Object.entries(have).filter(([, c]) => c).map(([id, c]) => String((BigInt(c) << 32n) | BigInt(id))) } : i);
    f.World.applyGameplay({ ...gp, inventory, inventoryPending: false, alchemy: { ...gp.alchemy, pending: false, flags: 0x10, slot: 13, error: null } });
    f.Controller.tick();
  };
  return f;
}
test('alchemy fuses the wanted stones one at a time, of the weapon degree, and confirms each by the stone leaving the bag', () => {
  const f = stoneFixture(); assert.equal(f.Alchemy.attributeCount(f.Alchemy.item(), 'MATTR_LUCK'), 0);
  f.Alchemy.start(true); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'alchemy-start', mode: 'magic', slots: [13, 16] });
  for (let n = 0; n < 8; n++) { f.advance(100); f.Controller.tick(); }
  assert.equal(f.commands.length, 1, 'nothing more is sent before the result');
  f.fused(16, 77, 1); assert.match(f.Alchemy.message, /Luck is now 1 of 6/); assert.equal(f.Alchemy.item().plus, 0);
  f.advance(1500); f.Controller.tick(); assert.equal(f.commands.length, 2, 'the second stone follows');
  f.fused(16, 77, 2); f.advance(1500); f.Controller.tick();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /wanted stone counts/); assert.equal(f.commands.filter(c => c.mode === 'reinforce').length, 0, 'fusing only: no elixir is used');
  assert.equal(f.Alchemy.result.stonesUsed.luck, 2); assert.equal(f.commands.at(-1).kind, 'alchemy-close');
});
test('alchemy fuses stones before the elixirs, in order, and stops when a stone is missing', () => {
  const f = stoneFixture({ luck: 1, steady: 1 }); f.Alchemy.start(); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'alchemy-start', mode: 'magic', slots: [13, 16] }, 'luck first');
  f.fused(16, 77, 1); f.advance(1500); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'alchemy-start', mode: 'magic', slots: [13, 17] }, 'then steady');
  f.fused(17, 78, 1); f.advance(1500); f.Controller.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'alchemy-start', mode: 'reinforce', slots: [13, 14] }, 'then the elixirs');
  const g = stoneFixture({ luck: 1, steady: 1 }); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 17);
  g.Alchemy.start(); g.Controller.tick(); g.fused(16, 77, 1); g.advance(1500); g.Controller.tick();
  assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /No Steady stone of degree 9 in the bag/);
  assert.equal(g.commands.filter(c => c.mode === 'reinforce').length, 0);
});
function astralFixture(change, astralStones = 2) {
  const f = stoneFixture(change);
  f.World.gp.inventory = f.World.gp.inventory.map(i => i.slot === 13 ? { ...i, magicReferences: [...i.magicReferences, { paramId: 80, optionName: 'MATTR_ASTRAL' }] } : i);
  f.World.gp.inventory.push({ slot: 19, refObjId: 6891, typeFlags: 0x3dec, quantity: astralStones });
  return f;
}
const stoneSlots = f => f.commands.filter(c => c.mode === 'magic').map(c => c.slots[1]);
test('an Astral charge waits for an Immortal one: Immortal is fused first, even when it is not ticked', () => {
  const f = astralFixture({ luck: 0, astral: 1 });
  f.Alchemy.start(true); f.Controller.tick();
  assert.deepEqual(stoneSlots(f), [18], 'Immortal first');
  assert.match(f.Alchemy.message, /Immortal stone \(the next Astral charge needs it\)/);
  f.fused(18, 79, 1); f.advance(1500); f.Controller.tick();
  assert.deepEqual(stoneSlots(f), [18, 19], 'then Astral');
  f.fused(19, 80, 1); f.advance(1500); f.Controller.tick();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /wanted stone counts/);
  assert.deepEqual(JSON.parse(JSON.stringify(f.Alchemy.result.stonesUsed)), { luck: 0, steady: 0, immortal: 1, astral: 1 });
});
test('Immortal goes before Astral below its own plus, and its missing stone is named', () => {
  const f = astralFixture({ luck: 0, immortal: 1, astral: 2 }); f.Settings.profile.alchemy.from.immortal = 5;
  f.Alchemy.start(); f.Controller.tick();
  assert.deepEqual(stoneSlots(f), [18], 'Astral is due at +0, Immortal from +5: Immortal still goes first');
  f.fused(18, 79, 1); f.advance(1500); f.Controller.tick(); assert.deepEqual(stoneSlots(f), [18, 19]);
  f.fused(19, 80, 1); f.advance(1500); f.Controller.tick();
  assert.deepEqual(stoneSlots(f), [18, 19, 18], 'a second Astral needs a second Immortal');
  const g = astralFixture({ luck: 0, astral: 1 }); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 18);
  g.Alchemy.start(true); g.Controller.tick();
  assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /No Immortal stone of degree 9 in the bag; each Astral charge needs an Immortal charge first/);
  assert.deepEqual(stoneSlots(g), [], 'no Astral is tried without an Immortal charge');
});
function attributeFixture(targets = { NATTR_PA: 19 }, limit = 100) {
  const f = alchemyFixture(); const a = f.Settings.profile.alchemy;
  f.World.gp.inventory = f.World.gp.inventory.map(i => i.slot === 13 ? { ...i, variance: '0' } : i);
  f.World.gp.inventory.push({ slot: 16, refObjId: 6903, typeFlags: 0x15ec, quantity: 5 }, { slot: 17, refObjId: 6915, typeFlags: 0x15ec, quantity: 5 });
  a.attr.targets = { ...targets }; a.attr.limit = limit; f.Alchemy.select(13);
  // The game fuses one stone: the bag loses it and the item's percentages change (variance is five bits per attribute).
  f.fuse = (slot, values, error = null) => {
    const gp = f.World.gp, variance = String(Object.entries(values).reduce((n, [index, v]) => n | BigInt(v) << BigInt(index * 5), 0n));
    const inventory = gp.inventory.map(i => i.slot === slot ? { ...i, quantity: i.quantity - 1 } : i.slot === 13 ? { ...i, variance } : i);
    f.World.applyGameplay({ ...gp, inventory, inventoryPending: false, alchemy: { ...gp.alchemy, pending: false, mode: 'attribute', flags: error === null ? 0x10 : 0, slot: 13, error } });
    f.Controller.tick();
  };
  return f;
}
const sent = f => JSON.parse(JSON.stringify(f.commands.at(-1)));
test('attribute stones: fuses the wanted attribute until its percentage is reached, then stops', () => {
  const f = attributeFixture();
  assert.equal(f.Alchemy.attrValue(f.Alchemy.item(), 4), 0);
  f.Alchemy.startAttributes(); f.Controller.tick();
  assert.deepEqual(sent(f), { kind: 'alchemy-start', mode: 'attribute', slots: [13, 16] }, 'the Phy. attack power stone of the item degree');
  for (let n = 0; n < 8; n++) { f.advance(100); f.Controller.tick(); }
  assert.equal(f.commands.length, 1, 'nothing more is sent before the result');
  f.fuse(16, { 4: 7 }); assert.match(f.Alchemy.message, /Phy\. attack power is now 22%/);
  f.advance(1500); f.Controller.tick(); assert.equal(f.commands.length, 2, 'still below 61%, so another follows');
  f.fuse(16, { 4: 3 }); f.advance(1500); f.Controller.tick(); assert.equal(f.commands.length, 3, 'a lower roll is rolled again');
  f.fuse(16, { 4: 19 }); f.advance(1500); f.Controller.tick();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /wanted percentage is reached/); assert.equal(f.commands.at(-1).kind, 'alchemy-close');
  assert.equal(f.Alchemy.result.attrFused, 3);
});
test('attribute stones: a failed fusion is used up and the loop goes on', () => {
  const f = attributeFixture(); f.Alchemy.startAttributes(); f.Controller.tick();
  f.fuse(16, {}, 0x23); assert.match(f.Alchemy.message, /fusion failed/); assert.equal(f.Alchemy.result.stoneFailures, 1);
  f.advance(1500); f.Controller.tick(); assert.equal(f.commands.length, 2);
});
test('attribute stones: several attributes are worked down the list and a changed other stat is logged', () => {
  const f = attributeFixture({ NATTR_PASTR: 7, NATTR_PA: 13 });
  f.Alchemy.startAttributes(); f.Controller.tick();
  assert.deepEqual(sent(f), { kind: 'alchemy-start', mode: 'attribute', slots: [13, 17] }, 'Phy. reinforce comes before Phy. attack power');
  f.fuse(17, { 1: 7, 4: 25 }); assert.match(f.Alchemy.log.at(-1).text, /Phy\. reinforce: 0% → 22% \(also changed: Phy\. attack power 0% → 80%\)/);
  f.advance(1500); f.Controller.tick(); assert.equal(f.Alchemy.run, null, 'the other stat already reached its target');
});
test('attribute stones: a stat without stones is passed over, the next one is done, and the end names what ran out', () => {
  const f = attributeFixture({ NATTR_PASTR: 7, NATTR_PA: 13 });
  f.World.gp.inventory = f.World.gp.inventory.filter(i => i.slot !== 17);
  f.Alchemy.startAttributes(); f.Controller.tick();
  assert.deepEqual(sent(f), { kind: 'alchemy-start', mode: 'attribute', slots: [13, 16] }, 'no Phy. reinforce stone: Phy. attack power is fused');
  assert.match(f.Alchemy.log.at(-1).text, /No Phy\. reinforce stone of degree 9 in the bag; going on with Phy\. attack power/);
  f.fuse(16, { 4: 13 }); f.advance(1500); f.Controller.tick();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /^No Phy\. reinforce stone of degree 9 in the bag\./);
  assert.equal(f.commands.filter(c => c.mode === 'attribute').length, 1);
});
test('attribute stones: when the stones of one stat run out on the way, the next stat is done', () => {
  const f = attributeFixture({ NATTR_PASTR: 13, NATTR_PA: 13 });
  f.World.gp.inventory = f.World.gp.inventory.map(i => i.slot === 17 ? { ...i, quantity: 1 } : i);
  f.Alchemy.startAttributes(); f.Controller.tick(); assert.deepEqual(sent(f).slots, [13, 17]);
  f.fuse(17, { 1: 7 }); f.advance(1500); f.Controller.tick();
  assert.deepEqual(sent(f).slots, [13, 16], 'Phy. reinforce is out of stones at 22%: Phy. attack power next');
  f.fuse(16, { 1: 7, 4: 13 }); f.advance(1500); f.Controller.tick();
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /No Phy\. reinforce stone/);
  const g = attributeFixture({ NATTR_PASTR: 13, NATTR_PA: 13 }); g.World.gp.inventory = g.World.gp.inventory.filter(i => i.slot !== 16 && i.slot !== 17);
  g.Alchemy.startAttributes(); g.Controller.tick();
  assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /No Phy\. reinforce or Phy\. attack power stone of degree 9 in the bag/);
});
test('attribute stones: need a target, a matching stone and respect the stone limit', () => {
  const none = attributeFixture({}); none.Alchemy.startAttributes(); assert.equal(none.Alchemy.run, null); assert.match(none.Alchemy.message, /at least one attribute/);
  const missing = attributeFixture(); missing.World.gp.inventory = missing.World.gp.inventory.filter(i => i.slot !== 16);
  missing.Alchemy.startAttributes(); missing.Controller.tick(); assert.equal(missing.Alchemy.run, null); assert.match(missing.Alchemy.message, /No Phy\. attack power stone of degree 9/);
  const capped = attributeFixture({ NATTR_PA: 25 }, 1); capped.Alchemy.startAttributes(); capped.Controller.tick(); capped.fuse(16, { 4: 7 }); capped.advance(1500); capped.Controller.tick();
  assert.equal(capped.Alchemy.run, null); assert.match(capped.Alchemy.message, /Stopped after 1 attribute stones/);
  assert.equal(capped.commands.filter(c => c.mode === 'attribute').length, 1);
});
test('attribute stones: the tab lists the item stats and gives a rough stone count', () => {
  const f = attributeFixture();
  assert.deepEqual([...f.Alchemy.attributes('accessory').map(a => a.name)], ['NATTR_PAR', 'NATTR_MAR']);
  assert.equal([...f.Alchemy.attributes('weapon').map(a => a.name)].includes('NATTR_DUR'), false, 'durability has no stone');
  assert.ok(f.Alchemy.attrExpected(7) < f.Alchemy.attrExpected(19) && f.Alchemy.attrExpected(19) < f.Alchemy.attrExpected(31));
  assert.equal(f.Alchemy.attrPercent(31), 100); assert.equal(f.Alchemy.attrPercent(7), 22);
});
test('the stone fusion limit is optional: off by default, and a set limit stops the run', () => {
  const f = stoneFixture(); f.Alchemy.start(true); assert.equal(f.Alchemy.run.cfg.stoneLimit, 0);
  f.Alchemy.run.stoneAttempts = 500; f.advance(1500); f.Controller.tick();
  assert.ok(!/limit/.test(f.Alchemy.message), 'no limit means no stop at any count');
  const g = stoneFixture(); g.Alchemy.cfg().stoneLimit = 3; g.Alchemy.start(true); g.Alchemy.run.stoneAttempts = 3; g.advance(1500); g.Controller.tick();
  assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /Stopped after 3 stone fusions \(your limit\)/);
});
require('./lean.obstacle.test.cjs')({ fixture, combatFixture, navProduct, test });

test('with Accept resurrection on, a living party member in view makes the bot wait 20 s before reviving itself', () => {
  const f = fixture(), P = f.Settings.profile.party;
  P.acceptRes = true; f.World.gp.social = { localName: 'Me', members: [{ id: 2, name: 'Healer', status: 10 }] };
  assert.equal(f.Party.reviveDelay(), 5000, 'nobody in view');
  f.World.ents.set(60, { gid: 60, kind: 'player', name: 'Healer', appearanceState: [0] });
  assert.equal(f.Party.helperNearby(), true, 'alive and in view'); assert.equal(f.Party.reviveDelay(), 20000);
  f.World.social = null; f.World.gp.social.members[0].status = 0; f.World.ents.get(60).appearanceState = [2];
  assert.equal(f.Party.helperNearby(), false, 'a dead helper cannot resurrect'); assert.equal(f.Party.reviveDelay(), 20000, 'seen a moment ago still counts');
  f.advance(16000); assert.equal(f.Party.reviveDelay(), 5000, 'not seen for a while');
  f.World.gp.social.members[0].status = 10; f.World.ents.get(60).appearanceState = [0]; f.World.ents.delete(60); assert.equal(f.Party.reviveDelay(), 5000);
  P.acceptRes = false; f.World.ents.set(60, { gid: 60, kind: 'player', name: 'Healer', appearanceState: [0] }); assert.equal(f.Party.reviveDelay(), 5000, 'the setting is off');
});
test('dying says in the log whether the bot waits for a party resurrection', () => {
  let t = deathFixture('revive'); t.die();
  assert.ok(t.f.Log.lines.some(l => /Died: waiting 20 s for a party member to resurrect before reviving\./.test(l.text)));
  t = deathFixture('revive'); t.f.World.ents.delete(77); t.die();
  assert.ok(t.f.Log.lines.some(l => /Died: no party member in view, reviving in 5 s\./.test(l.text)));
  t = deathFixture('revive'); t.f.Settings.profile.party.acceptRes = false; t.die();
  assert.ok(t.f.Log.lines.some(l => /Died: reviving in 5 s \(Accept resurrection from party members is off\)\./.test(l.text)));
});
test('alchemy works on every gear kind with that kind\'s elixir, and refuses to use another kind\'s', () => {
  const kinds = { weapon: [6, 3675], shield: [4, 3676], armor: [1, 3677], accessory: [5, 3678] };
  for (const [kind, [t3, elixir]] of Object.entries(kinds)) {
    const f = alchemyFixture(); f.World.gp.inventory = [
      { slot: 13, refObjId: 100, typeFlags: 44 | (t3 << 7), plus: 0, durability: 100, variance: '1', magic: [], quantity: 1, name: 'Test', tooltip: { fields: { itemClass: 25 } } },
      { slot: 14, refObjId: elixir, typeFlags: 0x0d6c, quantity: 5 }, { slot: 15, refObjId: 3679 === elixir ? 3680 : 3679, typeFlags: 0x0d6c, quantity: 5 }];
    f.Alchemy.select(13); assert.equal(f.Alchemy.kind(f.Alchemy.item()), kind);
    f.Alchemy.start(); f.Controller.tick();
    assert.deepEqual(JSON.parse(JSON.stringify(f.commands.at(-1))), { kind: 'alchemy-start', mode: 'reinforce', slots: [13, 14] }, kind + ' uses its own elixir');
  }
  const g = alchemyFixture(); g.World.gp.inventory = [{ slot: 13, refObjId: 100, typeFlags: 44 | (1 << 7), plus: 0, durability: 100, variance: '1', magic: [], quantity: 1, tooltip: { fields: { itemClass: 25 } } },
    { slot: 14, refObjId: 3679, typeFlags: 0x0d6c, quantity: 5 }];
  g.Alchemy.select(13); g.Alchemy.start(); assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /No selected armor elixirs in the bag/);
  assert.equal(g.Alchemy.kind({ slot: 20, typeFlags: 44 | (6 << 7) | 1, plus: 0 }), 'weapon'); assert.equal(g.Alchemy.kind({ slot: 20, typeFlags: 0x0d6c, plus: 0 }), '', 'not gear');
});
test('lucky powder and the stones are used only from the plus you set', () => {
  const f = alchemyFixture(true); f.Settings.profile.alchemy.from.powder = 2; f.Settings.profile.alchemy.target = 5;
  f.Alchemy.start(); f.Controller.tick();
  assert.deepEqual([...f.commands.at(-1).slots], [13, 14], 'no powder at +0');
  f.result(0x10, 1); f.advance(1500); f.Controller.tick(); assert.deepEqual([...f.commands.at(-1).slots], [13, 14], 'none at +1');
  f.result(0x10, 2); f.advance(1500); f.Controller.tick(); assert.deepEqual([...f.commands.at(-1).slots], [13, 14, 15], 'powder from +2');
  const g = stoneFixture({ luck: 1, steady: 1, immortal: 1 }); Object.assign(g.Settings.profile.alchemy.from, { luck: 0, steady: 5, immortal: 5 });
  const item = g.Alchemy.item(), cfg = g.Settings.profile.alchemy;
  assert.equal(g.Alchemy.nextStone(item, cfg, 0).kind, 'luck'); assert.equal(g.Alchemy.nextStone(item, cfg, 4).kind, 'luck');
  cfg.use.luck = false; assert.equal(g.Alchemy.nextStone(item, cfg, 4), null, 'steady and immortal wait for +5');
  assert.equal(g.Alchemy.nextStone(item, cfg, 5).kind, 'steady'); assert.equal(g.Alchemy.nextStone(item, cfg, Infinity).kind, 'steady');
});
test('the alchemy odds follow the server rules: powder and Luck add while below 100, clamped, and the expectation is exact', () => {
  const A = alchemyFixture().Alchemy;
  assert.equal(A.chanceAt(0, 3675, 0, false), 25); assert.equal(A.chanceAt(0, 3675, 3683, false), 75, 'powder adds its chance');
  assert.equal(A.chanceAt(0, 3675, 0, true), 30, 'Luck adds 5'); assert.equal(A.chanceAt(0, 3679, 3695, true), 100, 'already at 100: Luck is skipped, the cap holds');
  assert.equal(A.chanceAt(20, 3675, 0, false), 5 < 10 ? 10 : 5, 'never below 10'); assert.equal(A.chanceAt(11, 3679, 0, false), A.chanceAt(30, 3679, 0, false), '+11 holds above');
  assert.equal(A.expected(0, 1, () => 25).attempts, 4); assert.equal(A.expected(0, 1, () => 25).clean, .25);
  assert.equal(A.expected(0, 2, () => 50).attempts, 6); assert.equal(A.expected(1, 2, () => 50).attempts, 4);
  const f = alchemyFixture(); f.Settings.profile.alchemy.target = 5; const o = f.Alchemy.odds(f.Alchemy.item(), f.Settings.profile.alchemy);
  assert.equal(o.now, 50, 'weapon elixir B at +0'); assert.ok(o.plan.attempts > 5 && o.plan.clean > 0 && o.plan.clean < 1);
});
test('alchemy keeps statistics and a log of every attempt and fusion', () => {
  const f = alchemyFixture(); f.Alchemy.log.length = 0; f.Settings.profile.alchemy.target = 6;
  f.Alchemy.start(); f.Controller.tick(); f.result(0x10, 1); f.advance(1500); f.Controller.tick(); f.result(0x20, 0);
  const text = f.Alchemy.log.map(l => l.text).join('\n');
  assert.match(text, /Started: Test weapon \+0 to \+6/); assert.match(text, /Success: \+0 → \+1/); assert.match(text, /Failed at \+1: now \+0/);
  assert.equal(f.Alchemy.result.highest, 1); assert.equal(f.Alchemy.result.successes, 1); assert.equal(f.Alchemy.result.failures, 1);
});
test('the helper stones are fused automatically while enhancing, once their switch is on and the plus is reached', () => {
  const f = stoneFixture({ luck: 0 }); const a = f.Settings.profile.alchemy; a.target = 8; Object.assign(a.from, { luck: 0, steady: 2, immortal: 5, astral: 4 });
  a.use.steady = true; a.use.immortal = true; a.stones.steady = 1; a.stones.immortal = 1;
  f.Alchemy.start(); f.Controller.tick();
  assert.equal(f.commands.at(-1).mode, 'reinforce', 'below +2 nothing is fused first');
  const item = f.Alchemy.item();
  assert.equal(f.Alchemy.nextStone({ ...item, plus: 2 }, a, 2).kind, 'steady'); assert.equal(f.Alchemy.nextStone({ ...item, plus: 5 }, a, 5).kind, 'steady');
  assert.deepEqual([...f.Alchemy.wanted(a)], ['steady', 'immortal']);
  a.use.steady = false; assert.equal(f.Alchemy.nextStone({ ...item, plus: 5 }, a, 5).kind, 'immortal'); a.use.immortal = false; assert.equal(f.Alchemy.nextStone({ ...item, plus: 9 }, a, 9), null, 'nothing ticked, nothing fused');
});
test('an old profile with stone counts keeps those helpers switched on', () => {
  const f = fixture(), old = JSON.parse(JSON.stringify(f.Settings.profile)); delete old.alchemy.use; old.alchemy.stones = { luck: 3, steady: 0, immortal: 2 };
  const p = f.botProfile(old);
  assert.equal(p.alchemy.use.luck, true); assert.equal(p.alchemy.stones.luck, 3); assert.equal(p.alchemy.use.steady, false); assert.equal(p.alchemy.stones.steady, 1); assert.equal(p.alchemy.use.immortal, true); assert.equal(p.alchemy.stones.immortal, 2);
});
test('a failed stone fusion uses the stone up and the run carries on; a refusal explains itself and stops', () => {
  const f = stoneFixture(); f.Alchemy.start(true); f.Controller.tick();
  // 0xb651 answers a failed fusion with error 0x23 and flags 0x80 on slot 0, after the stone left the bag.
  const gp = f.World.gp;
  f.World.applyGameplay({ ...gp, inventory: gp.inventory.map(i => i.slot === 16 ? { ...i, quantity: i.quantity - 1 } : i), inventoryPending: false,
    alchemy: { ...gp.alchemy, pending: false, flags: 0x80, slot: 0, error: 0x23 } });
  f.Controller.tick();
  assert.ok(f.Alchemy.run, 'a failed fusion is not a stop'); assert.equal(f.Alchemy.pending, null);
  assert.match(f.Alchemy.message, /Luck fusion failed and the stone was used up \(still 0\)/); assert.equal(f.Alchemy.result.stoneFailures, 1);
  f.advance(1500); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 2, 'the next stone is sent');
  const g = stoneFixture(); g.Alchemy.start(true); g.Controller.tick();
  g.World.applyGameplay({ ...g.World.gp, alchemy: { ...g.World.gp.alchemy, pending: false, flags: 0, slot: 0, error: 0x21 } }); g.Controller.tick();
  assert.equal(g.Alchemy.run, null); assert.match(g.Alchemy.message, /code 33: the stone is not of the weapon's degree/);
  const h = stoneFixture(); h.Alchemy.start(true); h.Controller.tick();
  h.World.applyGameplay({ ...h.World.gp, alchemy: { ...h.World.gp.alchemy, pending: false, flags: 0, slot: 0, error: 16 } }); h.Controller.tick();
  assert.match(h.Alchemy.message, /code 16: the game does not accept this stone here/);
});
test('alchemy stone setup needs a known degree and readable attributes, a wanted count and settled state', () => {
  let f = stoneFixture({ luck: 0 }); f.Alchemy.start(true); assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /at least one stone type/);
  f = stoneFixture(); f.World.gp.inventory[0].magic = [String((1n << 32n) | 999n)]; f.Alchemy.select(13); f.Alchemy.start(true);
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /attributes are not loaded/); assert.equal(f.commands.length, 0);
  f = stoneFixture(); delete f.World.gp.inventory[0].tooltip; f.Alchemy.select(13); f.Alchemy.start(true); assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /degree is unknown/);
  f = stoneFixture({ luck: 6 }); f.World.gp.inventory[0].magic = [String((6n << 32n) | 77n)]; f.Alchemy.select(13); f.Alchemy.start(true); f.Controller.tick();
  assert.equal(f.commands.length, 0, 'already at the wanted count: nothing to fuse'); assert.equal(f.Alchemy.run, null);
  f = stoneFixture({ luck: 9 }); assert.equal(f.Alchemy.wanted().length, 1); f.Alchemy.start(true); f.Controller.tick(); assert.equal(f.commands.length, 1, 'counts above 6 are capped, not rejected');
});
test('alchemy stops at target or attempt limit instead of spending further materials', () => {
  for (const target of [true, false]) {
    const f = alchemyFixture(); Object.assign(f.Settings.profile.alchemy, target ? { target: 1 } : { target: 5, limit: 1 });
    f.Alchemy.start(); f.Controller.tick(); f.result(target ? 0x10 : 0x20, target ? 1 : 0);
    assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, target ? /Target reached/ : /Attempt limit/);
    f.advance(30000); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
  }
});

test('alchemy requires bag weapons, valid limits, settled state and compatible materials', () => {
  for (const change of [f => { f.World.gp.inventory[0].typeFlags = 44 | (4 << 7); },
    f => { f.World.gp.inventory[0].slot = 6; }, f => { f.World.gp.inventoryPending = true; },
    f => { f.World.gp.alchemy.pending = true; }, f => { f.World.gp.alchemy = undefined; },
    f => { f.World.gp.inventory[1].refObjId = 3678; }, f => { f.Settings.profile.alchemy.target = 0; },
    f => { f.Settings.profile.alchemy.limit = 1.5; }, f => { f.Settings.profile.alchemy.elixir = 3675; },
    f => { f.Settings.profile.alchemy.powder = true; f.World.gp.inventory[2].refObjId = 3683; },
    f => { f.Settings.profile.alchemy.powder = true; delete f.World.gp.inventory[0].tooltip; },
    f => { f.World.gp.stall = { phase: 'owner', mode: 0 }; }, f => { f.Hunt.running = true; }]) {
    const f = alchemyFixture(); change(f); f.Alchemy.start();
    assert.equal(f.Alchemy.run, null); assert.equal(f.commands.length, 0);
  }
});

test('alchemy does not accept stale flags or material consumption alone as a result', () => {
  const f = alchemyFixture(); f.World.gp.alchemy.flags = 0x10; f.World.gp.alchemy.slot = 13;
  f.Alchemy.start(); f.Controller.tick();
  f.World.applyGameplay({ ...f.World.gp, alchemy: { ...f.World.gp.alchemy } });
  f.advance(1000); f.Controller.tick(); assert.ok(f.Alchemy.pending); assert.equal(f.commands.length, 1);
  const items = f.World.gp.inventory.map(i => i.slot === 14 ? { ...i, quantity: 9 } : i);
  f.World.applyGameplay({ ...f.World.gp, inventory: items, alchemy: { ...f.World.gp.alchemy, flags: 0 } });
  f.Controller.tick(); assert.ok(f.Alchemy.pending); assert.equal(f.Alchemy.result.elixirs, 0);
  f.advance(16000); f.Controller.tick(); assert.equal(f.Alchemy.run, null); assert.ok(f.Alchemy.pending);
  assert.match(f.Alchemy.message, /unconfirmed/); f.Alchemy.start(); assert.equal(f.Alchemy.run, null);
  f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
  assert.equal(f.commands.at(-1).kind, 'alchemy-close');
});

test('alchemy waits for pending inventory to settle even after a matching result', () => {
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick();
  const gp = f.World.gp;
  f.World.applyGameplay({ ...gp, inventoryPending: true,
    inventory: gp.inventory.map(i => i.slot === 13 ? { ...i, plus: 1 } : i.slot === 14 ? { ...i, quantity: 9 } : i),
    alchemy: { ...gp.alchemy, pending: false, flags: 0x10, slot: 13 } });
  f.Controller.tick(); assert.ok(f.Alchemy.pending);
  f.World.applyGameplay({ ...f.World.gp, inventoryPending: false }); f.Controller.tick();
  assert.equal(f.Alchemy.pending, null); assert.equal(f.Alchemy.result.successes, 1);
});

test('alchemy observes native rejection and confirmed destruction without retrying', () => {
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick();
  f.World.applyGameplay({ ...f.World.gp, alchemy: { ...f.World.gp.alchemy, pending: false, error: 9, flags: 0, slot: 0 } });
  f.Controller.tick(); assert.equal(f.Alchemy.run, null); assert.equal(f.Alchemy.pending, null); assert.match(f.Alchemy.message, /refused/);
  const d = alchemyFixture(); d.Alchemy.start(); d.Controller.tick(); d.result(0x40);
  assert.equal(d.Alchemy.run, null); assert.equal(d.Alchemy.selected, null); assert.equal(d.Alchemy.pending, null);
  assert.match(d.Alchemy.message, /destroyed/); assert.equal(d.Alchemy.result.elixirs, 1);
});

test('alchemy freezes the selected item and stops on movement, replacement or edits', () => {
  for (const change of [f => { f.World.gp.inventory[0].slot = 16; },
    f => { f.World.gp.inventory[0].variance = '456'; }, f => { f.World.gp.inventory[0].refObjId = 200; },
    f => { f.World.gp.inventory[0].magic = ['1']; }, f => { f.Settings.profile.alchemy.limit++; },
    f => { f.Manual.lastAt = 100001; }, f => { f.World.charName = 'changed'; }]) {
    const f = alchemyFixture(); f.Alchemy.start(); change(f); f.Controller.tick();
    assert.equal(f.Alchemy.run, null); assert.equal(f.commands.length, 0);
  }
});

test('alchemy stop and F8 never repeat a sent attempt, including a late result', () => {
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick(); f.toggleBot();
  assert.equal(f.Hunt.running, false); assert.equal(f.Alchemy.run, null); assert.ok(f.Alchemy.pending);
  f.toggleBot(); assert.equal(f.Hunt.running, false);
  f.result(0x10, 1); assert.equal(f.Alchemy.pending, null); assert.equal(f.Alchemy.run, null);
  f.advance(2000); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
});

test('alchemy stops on native manual commands, death and world reset', () => {
  const f = alchemyFixture(); f.Alchemy.start();
  for (const observer of f.Hook.observers) observer({ kind: 'gameplay', command: { kind: 'inventory-move' } });
  assert.equal(f.Alchemy.run, null); assert.match(f.Alchemy.message, /manual/);
  const d = alchemyFixture(); d.Alchemy.start(); d.World.isDead = () => true; d.Controller.tick(); assert.equal(d.Alchemy.run, null);
  const r = alchemyFixture(); r.Alchemy.start(); r.Controller.tick(); r.bus.emit('reset');
  assert.equal(r.Alchemy.run, null); assert.equal(r.Alchemy.pending, null); assert.equal(r.Alchemy.selected, null);
});

test('alchemy waits for a visible window once and times out without spending', () => {
  const f = alchemyFixture(); f.World.gp.alchemy.visible = false; f.Alchemy.start(); f.Controller.tick();
  assert.equal(f.commands[0].kind, 'alchemy-open');
  f.advance(1000); f.Controller.tick(); assert.equal(f.commands.length, 1);
  f.World.applyGameplay({ ...f.World.gp, alchemy: { ...f.World.gp.alchemy, visible: true } }); f.Controller.tick();
  assert.equal(f.commands.at(-1).kind, 'alchemy-start');
  const t = alchemyFixture(); t.World.gp.alchemy.visible = false; t.Alchemy.start(); t.Controller.tick();
  t.advance(6000); t.Controller.tick(); assert.equal(t.Alchemy.run, null); assert.deepEqual(Array.from(t.commands, c => c.kind), ['alchemy-open', 'alchemy-close']);
});

test('alchemy blocks hunting and travel and stops when supplies run out', () => {
  const f = alchemyFixture(); f.Alchemy.start(); f.Hunt.start(); f.WalkBack.start();
  assert.equal(f.Hunt.running, false); assert.equal(f.WalkBack.active, null);
  f.World.gp.inventory[1].quantity = 0; f.Controller.tick(); assert.equal(f.Alchemy.run, null); assert.equal(f.commands.length, 0);
  const t = alchemyFixture(); t.Alchemy.start(); t.Controller.tick();
  assert.equal(t.Controller.mode, 'alchemy'); assert.equal(t.commands.some(c => c.kind === 'item-use'), false);
});

test('alchemy uses no powder when disabled and rolls over exhausted elixir stacks', () => {
  const f = alchemyFixture(); f.World.gp.inventory[1].quantity = 1;
  f.World.gp.inventory.push({ slot: 16, refObjId: 3679, typeFlags: 0x0d6c, quantity: 5 });
  f.Alchemy.start(); f.Controller.tick();
  assert.deepEqual(Array.from(f.commands[0].slots), [13, 14]);
  f.result(0x10, 1); assert.equal(f.Alchemy.result.powders, 0);
  f.advance(1000); f.Controller.tick(); assert.deepEqual(Array.from(f.commands.at(-1).slots), [13, 16]);
});

test('alchemy rejects mismatched results and unexpected plus changes without another attempt', () => {
  for (const change of [a => { a.slot = 14; }, a => { a.mode = 'magic'; }, a => { a.flags = 0x70; }]) {
    const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick();
    const gp = f.World.gp, a = { ...gp.alchemy, slot: 13, flags: 0x10 }; change(a);
    f.World.applyGameplay({ ...gp, alchemy: a,
      inventory: gp.inventory.map(i => i.slot === 13 ? { ...i, plus: 1 } : i.slot === 14 ? { ...i, quantity: 9 } : i) });
    f.advance(16000); f.Controller.tick(); assert.equal(f.Alchemy.run, null); assert.ok(f.Alchemy.pending); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
  }
  const f = alchemyFixture(); f.Alchemy.start(); f.Controller.tick(); f.result(0x10, 5);
  assert.equal(f.Alchemy.run, null); assert.ok(f.Alchemy.pending); assert.match(f.Alchemy.message, /Unexpected enhancement/);
});

test('alchemy dispatch failure spends no attempt and manual refusal stops a pending run', () => {
  const f = alchemyFixture(), raw = f.Cmd.raw;
  f.Cmd.raw = () => false; f.Alchemy.start(); f.Controller.tick(); assert.equal(f.Alchemy.result.attempts, 0); assert.equal(f.Alchemy.pending, null);
  f.Cmd.raw = raw; f.Controller.tick(); assert.equal(f.Alchemy.result.attempts, 1);
  f.bus.emit('game-error', 'Alchemy operation unavailable'); assert.equal(f.Alchemy.run, null); assert.ok(f.Alchemy.pending);
  f.result(0x10, 1); assert.equal(f.Alchemy.pending, null); f.advance(1000); f.Controller.tick(); assert.equal(f.commands.filter(c => c.kind === 'alchemy-start').length, 1);
});

test('diagnostics distinguish native alchemy windows and pending movement without exporting arbitrary modes', () => {
  const f = alchemyFixture(); f.World.gp.pendingMoves = 2; f.World.gp.returnScroll = {};
  let s = f.Diagnostics.snapshot();
  assert.equal(s.alchemyWindowVisible, true); assert.equal(s.nativeAlchemyPending, false);
  assert.equal(s.nativeAlchemyMode, 'reinforce'); assert.equal(s.movementPending, true); assert.equal(s.returnScrollActive, true);
  f.World.gp.alchemy = { visible: false, pending: true, mode: 'private injected text' };
  s = f.Diagnostics.snapshot(); assert.equal(s.nativeAlchemyMode, null);
  assert.equal(s.nativeAlchemyPending, true); assert.equal(s.alchemyWindowVisible, false);
  assert.equal(JSON.stringify(s).includes('private injected text'), false);
});

test('diagnostics identify party acceptance gates without changing party commands', () => {
  const f = fixture(), m = partyApplication(f);
  f.World.gp.social.members = Array.from({ length: 5 }, (_, n) => ({ id: 10 + n }));
  assert.match(f.Diagnostics.party(), /ready for acceptance/);
  m.own = null; assert.match(f.Diagnostics.party(), /ready for acceptance/);
  m.own = { type: 1 }; f.World.gp.social.leader = 99; assert.match(f.Diagnostics.party(), /not the leader/);
  f.World.gp.social.leader = 10; f.World.gp.social.options = 0; assert.match(f.Diagnostics.party(), /party full/);
  f.World.gp.social.options = 1; m.request.expires = 99999; assert.match(f.Diagnostics.party(), /expired/);
  m.request.expires = 110000; f.Controller.tick(); assert.match(f.Diagnostics.party(), /acceptance sent/);
  const count = f.commands.length; f.Diagnostics.report(); assert.equal(f.commands.length, count);
});

test('diagnostics show real pet transaction and potion waits plus town refill progress', () => {
  const f = fixture(); pickupPet(f); f.Hunt.running = true;
  f.World.gp.inventoryPending = true; assert.match(f.Diagnostics.pet(), /inventory transaction/);
  f.World.gp.inventoryPending = false; f.Potion.lastUse = 100000; assert.match(f.Diagnostics.pet(), /potion use/);
  f.advance(500); assert.match(f.Diagnostics.pet(), /eligible drops/);
  const t = townFixture(); t.Restock.cfg().mp.target = 1000; t.Town.begin(); t.Town.enter('buy');
  t.World.gp.inventory.find(i => i.refObjId === 15).quantity = 650;
  assert.equal(t.Diagnostics.main(), 'Refilling MP: 650 / 1000');
  t.Town.trip = null; t.World.gp.inventory = t.World.gp.inventory.filter(i => i.refObjId !== 201);
  assert.doesNotMatch(t.Diagnostics.town(), /blocked/, 'a missing reverse scroll only means walking back');
  t.World.gp.inventory = t.World.gp.inventory.filter(i => i.refObjId !== 200);
  assert.match(t.Diagnostics.town(), /return scroll missing/);
});

test('diagnostic reports omit names, raw errors, chat, locations and sensitive settings', () => {
  const f = fixture(); partyApplication(f); pickupPet(f);
  const secret = 'PRIVATE_USER_SECRET';
  f.World.charName = secret; f.World.gp.chat = [secret]; f.World.gp.error = secret;
  f.World.gp.partyMatching.request.member.name = secret;
  f.Settings.profile.party.title = secret; f.Settings.profile.hunt.pickup.include = secret;
  f.Town.cfg().keep = secret; f.Town.cfg().vendor = { name: secret, x: 123456789 };
  f.Loot.active = { name: secret, gid: 912345, petGid: 50 };
  f.Diagnostics.start(); f.Diagnostics.start();
  f.bus.emit('game-error', 'Inventory busy: ' + secret);
  f.bus.emit('log', { level: 'warn', text: secret });
  const text = f.Diagnostics.report(), report = JSON.parse(text);
  assert.equal(text.includes(secret), false); assert.equal(text.includes('123456789'), false); assert.equal(text.includes('912345'), false);
  assert.equal(report.current.settings.mpTarget, 300);
  assert.deepEqual(report.recentErrors.map(e => e.code), ['inventory-busy', 'unclassified-error']);
  assert.equal(report.app, 'nixxane bot');
});

test('diagnostic history is bounded, retained across stops and tolerates incomplete state', () => {
  const f = fixture();
  for (let n = 0; n < 50; n++) { f.Settings.profile.potion.restock.mp.target = n; f.advance(1000); f.Diagnostics.sample(); f.Diagnostics.error('error ' + n); }
  assert.equal(f.Diagnostics.history.length, 30); assert.equal(f.Diagnostics.errors.length, 12);
  f.stopAll(); assert.equal(f.Diagnostics.history.length, 30);
  f.World.gp = null; assert.doesNotThrow(() => JSON.parse(f.Diagnostics.report()));
  f.World.simOffset = null; assert.doesNotThrow(() => f.Diagnostics.sample());
});
test('F6 minimises and restores the panel like the ×, and the game never sees the key', () => {
  const f = fixture(), keydown = [], minimised = [];
  f.win.addEventListener = (type, fn) => { if (type === 'keydown') keydown.push(fn); };
  f.UI.mount = f.UI.draw = f.UI.update = f.Ticker.start = () => {}; f.boot();
  f.UI.root = { host: { hidden: false } }; f.UI.body = { hidden: false };
  f.UI.minimise = function (on) { minimised.push(on); this.minimised = on; };
  const press = (code, extra = {}) => {
    const e = { isTrusted: true, repeat: false, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, code,
      composedPath: () => [{ tagName: 'CANVAS' }], preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const fn of keydown) fn(e);
    return e;
  };
  const first = press('F6');
  assert.deepEqual(minimised, [true]); assert.equal(first.prevented, true); assert.equal(first.stopped, true, 'the game never sees F6');
  press('F6'); assert.deepEqual(minimised, [true, false], 'a second F6 brings the panel back');
  press('F6', { repeat: true }); press('F6', { composedPath: () => [{ tagName: 'INPUT' }] });
  assert.deepEqual(minimised, [true, false], 'a held key or typing in a field does nothing');
  f.UI.root.host.hidden = true; press('F6');
  assert.equal(f.UI.root.host.hidden, false, 'a panel hidden with Shift+F7 comes back');
  assert.deepEqual(minimised, [true, false, false]);
  assert.equal(f.Hunt.running, false); assert.equal(f.commands.length, 0, 'F6 never starts or stops the bot');
});
function autoStartFixture(f = fixture()) { f.Settings.profile.hunt.autoStart = true; return f; }
const manualMove = f => f.Hook.observers.forEach(fn => fn({ kind: 'gameplay', command: { kind: 'move' } }));
test('auto-start is off by default; on, it starts hunting at the spot once the game settles, once per entry', () => {
  let f = fixture(); f.Controller.tick(); f.advance(6000); f.Controller.tick();
  assert.equal(f.Settings.profile.hunt.autoStart, false); assert.equal(f.Hunt.running, false, 'off by default');
  f = autoStartFixture(); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'waits for the game to settle'); assert.match(f.Diagnostics.main(), /^Auto-start: starting in \d s\.$/);
  f.advance(5000); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.match(f.AutoStart.message, /hunting started at the hunting spot/);
  f.stopAll(); f.advance(10000); f.Controller.tick(); assert.equal(f.Hunt.running, false, 'a stop holds for this entry');
  f.bus.emit('phase', 'entering-world', 'world', false); f.advance(10000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'a teleport is not a new entry');
  f.World.phase = 'character'; f.bus.emit('phase', 'character', 'world', true); f.Controller.tick(); f.World.phase = 'world';
  f.Controller.tick(); assert.equal(f.Hunt.running, false);
  f.advance(5000); f.Controller.tick(); assert.equal(f.Hunt.running, true, 'entering the game again starts it again');
});
test('auto-start waits out manual control and gives way to the player and to a reconnect', () => {
  let f = autoStartFixture(); f.Controller.tick(); f.advance(4000); manualMove(f);
  f.advance(1500); f.Controller.tick(); assert.equal(f.Hunt.running, false); assert.match(f.AutoStart.message, /manual-control pause/);
  f.advance(6000); f.Controller.tick(); assert.equal(f.Hunt.running, true, 'starts once the manual pause is over');
  f = autoStartFixture(); f.Controller.tick(); f.userStop(); f.advance(10000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.match(f.AutoStart.message, /cancelled/);
  f = autoStartFixture(); f.Controller.tick(); f.toggleBot(); assert.equal(f.Hunt.running, true);
  f.Controller.tick(); assert.equal(f.AutoStart.entry, null, 'started by the player: nothing left to do');
  const r = reconnectFixture(); autoStartFixture(r.f); r.f.Hunt.stop(); r.lose(); r.back();
  for (let i = 0; i < 6; i++) { r.f.advance(4000); r.f.Controller.tick(); }
  assert.equal(r.f.Hunt.running, false, 'the player had stopped the bot; the reconnect owns this entry and does not start it');
  assert.match(r.f.AutoStart.message, /reconnect/);
});
function heroAutoStart() {
  const f = autoStartFixture(), center = f.Hunt.cfg().center;
  f.World.charName = 'Hero'; f.Settings.useCharacter('Hero'); Object.assign(f.Settings.profile.hunt, { autoStart: true, center });
  const enter = () => { f.World.phase = 'character'; f.bus.emit('phase', 'character', 'world', true); f.World.phase = 'world'; f.Controller.tick(); f.advance(5000); f.Controller.tick(); };
  return { f, enter };
}
test('auto-start follows the last Start or Stop the player chose, kept per character across reloads', () => {
  let { f, enter } = heroAutoStart(); f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.equal(f.Hunt.running, true, 'no choice saved yet: it starts as before');
  f.toggleBot(); assert.equal(f.Hunt.running, false);
  assert.equal(JSON.parse(f.storage.get('sroBotLean:v1:run:Hero')).on, false);
  enter(); assert.equal(f.Hunt.running, false, 'the player stopped it: it stays stopped');
  assert.match(f.AutoStart.message, /you stopped the bot last time/);
  f.toggleBot(); assert.equal(f.Hunt.running, true); f.stopAll();
  enter(); assert.equal(f.Hunt.running, true, 'stopped by the bot itself, last chosen Start: it starts again');
  f.userStop(); f.World.charName = 'Other'; f.RunIntent.set(true); f.World.charName = 'Hero';
  enter(); assert.equal(f.Hunt.running, false, 'the choice belongs to the character');
});
test('a stop the bot makes by itself does not cancel an auto-start that is waiting', () => {
  const { f } = heroAutoStart(); f.Controller.tick(); f.advance(2000);
  f.stopAll(); f.bus.emit('phase', 'entering-world', 'world', false); f.Controller.tick();
  assert.ok(f.AutoStart.pending(), 'still waiting for the game to settle');
  f.advance(4000); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.match(f.AutoStart.message, /hunting started/);
});
test('a connection lost while an auto-start waits is resumed after the reconnect', () => {
  const r = reconnectFixture(); autoStartFixture(r.f); r.f.Hunt.stop(); r.f.AutoStart.entry = { at: 0 };
  r.lose(); assert.equal(r.f.Reconnect.intent.hunting, true);
});
test('a stop by the player during a reconnect, or before a reload, is not undone when the character is back', () => {
  const r = reconnectFixture(); r.f.Reconnect.snapAt = 0; r.f.Reconnect.snapshot();
  const snap = () => JSON.parse(r.f.storage.get('sro-lean-reload')).snap;
  assert.equal(snap().hunting, true);
  r.lose(); assert.equal(r.f.Reconnect.intent.hunting, true);
  r.f.userStop(); assert.equal(r.f.Reconnect.intent.hunting, false); assert.equal(snap().hunting, false);
  r.back(); for (let i = 0; i < 6; i++) { r.f.advance(4000); r.f.Controller.tick(); }
  assert.equal(r.f.Hunt.running, false); assert.equal(r.f.Reconnect.active(), false);
});
test('the Start / stop button shows whether the bot is running', () => {
  const f = fixture(), led = f.UI.runLed = { dataset: {}, parentNode: { title: '' } };
  f.UI.updateRunLed(); assert.equal(led.dataset.state, 'stop'); assert.match(led.parentNode.title, /stopped/);
  f.Hunt.start(); f.UI.updateRunLed(); assert.equal(led.dataset.state, 'ok'); assert.match(led.parentNode.title, /running: Hunting/);
  f.World.isDead = () => true; f.UI.updateRunLed(); assert.equal(led.dataset.state, 'ok', 'dead while started: still started');
  f.World.isDead = () => false; f.WalkBack.active = true; f.UI.updateRunLed(); assert.equal(led.dataset.state, 'busy');
  f.WalkBack.active = false; f.Hunt.stop(); f.UI.updateRunLed(); assert.equal(led.dataset.state, 'stop');
});
test('auto-start in the town of the saved services does the town services, then reverses to the hunting spot', () => {
  const f = townFixture(); autoStartFixture(f); f.Hunt.stop();
  f.Town.detect = () => ({ key: 'KT' }); f.Settings.profile.hunt.center = { regionId: 1, x: 1500, y: 0, z: 100 };
  f.World.gp.pose.x = 60; f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.ok(f.Town.trip, f.Town.message); assert.equal(f.Town.trip.revival, true, 'a revival-style trip: no return scroll in town');
  assert.equal(f.Town.trip.phase, 'walk-storage'); assert.equal(f.Hunt.running, true);
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false, 'no return scroll is used');
  assert.match(f.AutoStart.message, /in town\. Doing town services, then back to the hunting spot/);
});
test('auto-start away from the spot outside town walks back; dead it revives first; without a spot it says so', () => {
  let f = autoStartFixture(); f.World.gp.pose.x = 1800; f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.ok(f.WalkBack.active); assert.match(f.AutoStart.message, /walking to the hunting spot/);
  f = autoStartFixture(); f.World.isDead = () => true; f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.match(f.AutoStart.message, /On death is set to Stop/);
  f = autoStartFixture(); f.World.isDead = () => true; f.Hunt.cfg().onDeath = 'revive'; f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.match(f.AutoStart.message, /revives and returns first/);
  f = autoStartFixture(); f.Settings.profile.hunt.center = null; f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.ok(f.notices.some(n => /no hunting spot is saved/.test(n)));
  f = autoStartFixture(); f.World.gp.inventoryPending = true; f.Controller.tick(); f.advance(8000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.match(f.AutoStart.message, /waiting for the character to load/);
  f.World.gp.inventoryPending = false; f.Controller.tick(); assert.equal(f.Hunt.running, true);
  f = fixture(); f.storage.set('sroBotLean:v1:profile:Hero', JSON.stringify({ hunt: { autoStart: true, center: { regionId: 1, x: 100, y: 0, z: 100 } } }));
  f.World.charName = 'Hero'; f.Controller.tick(); f.advance(5000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'the default profile is not read as the character\'s choice');
  assert.match(f.AutoStart.message, /waiting for the character settings/);
  f.Settings.useCharacter('Hero'); f.Controller.tick(); assert.equal(f.Hunt.running, true, 'the character\'s own setting decides');
  f = fixture(); f.World.charName = 'Hero'; f.Controller.tick(); f.advance(121000); f.Controller.tick();
  assert.equal(f.AutoStart.entry, null, 'a profile that never loads still gives up');
  assert.match(f.AutoStart.message, /gave up/);
});
function retryFixture(on = true) {
  const f = fixture(); f.Settings.profile.hunt.retry = on; f.Hunt.start(); f.Controller.tick();
  const stop = reason => { f.Hunt.stop(reason); f.Controller.tick(); };
  return { f, stop };
}
test('the bot starts again 2 minutes after it stopped by itself, only when asked to', () => {
  let { f, stop } = retryFixture(false);
  assert.equal(f.DEFAULT_PROFILE.hunt.retry, false, 'off by default');
  stop('Town cycle stopped: Inventory transaction timed out.'); f.advance(130000); f.Controller.tick();
  assert.equal(f.Hunt.running, false);
  ({ f, stop } = retryFixture());
  stop('Town cycle stopped: Inventory transaction timed out.');
  assert.match(f.Diagnostics.main(), /stopped by itself \(Town cycle stopped: Inventory transaction timed out\.\); starting again in 120 s/);
  f.advance(119000); f.Controller.tick(); assert.equal(f.Hunt.running, false);
  f.advance(2000); f.Controller.tick(); assert.equal(f.Hunt.running, true, 'does what Return & hunt does');
  assert.match(f.Retry.message, /^Started again/);
});
test('a stop the player chose, or the player stopping the bot, is never undone by the retry', () => {
  for (const reason of ['out of HP potions', 'inventory full', 'character died', 'stuck: no progress after 3 recoveries', 'Town cycle stopped: Manual control interrupted the trip.',
    'Town cycle stopped: Character died during town service.', 'Town cycle stopped: No saved hunting point to return to; set the hunting area first.']) {
    const { f, stop } = retryFixture(); stop(reason); f.advance(130000); f.Controller.tick();
    assert.equal(f.Hunt.running, false, reason); assert.match(f.Retry.message, /final/, reason);
  }
  const { f } = retryFixture(); f.World.charName = 'Hero'; f.userStop(); f.Controller.tick(); f.advance(130000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'the player pressed Stop');
});
test('the retry waits for the player to stop moving, and gives up on the same reason twice or a fourth stop in an hour', () => {
  let { f, stop } = retryFixture();
  stop('Walk back stopped: no progress towards the hunting spot.');
  f.advance(100000); manualMove(f); f.advance(100000); f.Controller.tick(); assert.equal(f.Hunt.running, false, 'the player moved 100 s in');
  f.advance(21000); f.Controller.tick(); assert.equal(f.Hunt.running, true, '2 minutes after the last manual move');
  stop('Walk back stopped: no progress towards the hunting spot.'); f.advance(130000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'the same reason again within 30 minutes');
  assert.ok(f.notices.some(n => /stopped again for the same reason/.test(n)));
  ({ f, stop } = retryFixture());
  for (const n of [1, 2, 3]) { stop('Town cycle stopped: reason ' + 'ABC'[n - 1] + '.'); f.advance(121000); f.Controller.tick(); assert.equal(f.Hunt.running, true, 'try ' + n); }
  stop('Town cycle stopped: reason D.'); f.advance(130000); f.Controller.tick();
  assert.equal(f.Hunt.running, false); assert.match(f.Retry.message, /4 times in an hour/);
});
test('a pending retry is dropped by Stop all, a character change or leaving the world', () => {
  for (const how of ['stop', 'character', 'left']) {
    const { f, stop } = retryFixture(); stop('Town cycle stopped: Inventory transaction timed out.'); assert.ok(f.Retry.stop, how);
    if (how === 'stop') { f.World.charName = 'Hero'; f.userStop(); }
    if (how === 'character') f.bus.emit('character', 'Other');
    if (how === 'left') { f.bus.emit('phase', 'character', 'world', true); f.World.phase = 'world'; }
    f.Controller.tick(); f.advance(130000); f.Controller.tick();
    assert.equal(f.Hunt.running, false, how); assert.equal(f.Retry.stop, null, how);
  }
});
test('a stop on a world change is retried, unless the player had just acted in the game', () => {
  const change = f => { f.bus.emit('phase', 'entering-world', 'world', false); f.stopAll(); f.Controller.tick(); };
  let { f } = retryFixture(); change(f);
  assert.equal(f.Retry.stop.reason, 'world change'); f.advance(121000); f.Controller.tick(); assert.equal(f.Hunt.running, true);
  ({ f } = retryFixture()); f.advance(60000);
  f.Hook.observers.forEach(fn => fn({ kind: 'gameplay', command: { kind: 'item-use', slot: 13 } })); f.advance(5000); change(f);
  f.advance(130000); f.Controller.tick();
  assert.equal(f.Hunt.running, false, 'a scroll read by hand: the player moved on'); assert.match(f.Retry.message, /your own action/);
});
test('the retry also follows a walk back that failed after a town trip', () => {
  const f = fixture(); f.Settings.profile.hunt.retry = true; f.World.gp.pose.x = 1800;
  f.WalkBack.start(true); assert.ok(f.WalkBack.active); f.Controller.tick();
  f.WalkBack.cancel('Walk back stopped: path blocked or travel timed out.'); f.Controller.tick();
  assert.match(f.Retry.message, /path blocked or travel timed out\.\); starting again in/);
});
test('a walk that starts on a blocked tile or against a wall steps out to open ground first, never through the wall', () => {
  const wall = { x: 0, y: 0, z: 0, yaw: 0, mesh: { vertices: [200,0,0,200,0,1920], edges: [0,1,0,65535,3,0] } };
  let f = fixture(); f.Navigation.capture({ kind: 'gameplay', command: { kind: 'navigation', bundle: navProduct([wall]) } });
  const owner = {}, goal = { regionId: 1, x: 100, y: 0, z: 100 };
  f.World.gp.pose = { regionId: 1, x: 199, y: 0, z: 100 };
  assert.equal(f.Navigation.pointStatus(f.World.pose()), 'blocked', 'right against the wall');
  assert.equal(f.Navigation.plan(f.World.pose(), goal).length, 0, 'no route from there');
  let step = f.Navigation.next(owner, goal);
  assert.equal(step.stepOut, true); assert.ok(step.point.x < 200, 'steps away from the wall, not through it');
  assert.equal(f.Navigation.pointStatus(step.point), 'open');
  f.World.gp.pose = { ...step.point }; step = f.Navigation.next(owner, goal);
  assert.ok(step.point && !step.stepOut, 'from open ground the normal route takes over');
  f.World.gp.pose = { regionId: 1, x: 201, y: 0, z: 100 };
  assert.ok(f.Navigation.next({}, { ...goal, x: 400 }).point.x > 200, 'the other side steps out on its own side');
  const blocked = new Uint8Array(9216); blocked[5 * 96 + 5] = 1;
  f = fixture(); f.Navigation.install(navProduct([], blocked)); f.World.gp.pose = { regionId: 1, x: 110, y: 0, z: 110 };
  assert.equal(f.Navigation.pointStatus(f.World.pose()), 'blocked', 'standing on a blocked tile');
  step = f.Navigation.next({}, { regionId: 1, x: 500, y: 0, z: 110 });
  assert.equal(step.stepOut, true); assert.equal(f.Navigation.pointStatus(step.point), 'open');
  f.World.gp.pose = { regionId: 1, x: 300, y: 0, z: 300 }; assert.equal(f.Navigation.stepOut(f.World.pose()), null, 'open ground needs no step out');
});
test('auto-start in town on a blocked spot steps out, walks to the warehouse with real routing and opens it', () => {
  const f = townFixture(); autoStartFixture(f); f.Hunt.stop();
  const blocked = new Uint8Array(9216); blocked[5 * 96 + 1] = 1;
  f.Navigation.install(navProduct([], blocked));
  f.Town.detect = () => ({ key: 'KT' }); f.Settings.profile.hunt.center = { regionId: 1, x: 1500, y: 0, z: 100 };
  f.World.gp.pose = { regionId: 1, x: 30, y: 0, z: 110 };
  assert.equal(f.Navigation.pointStatus(f.World.pose()), 'blocked');
  const moves = [];
  for (let n = 0; n < 40 && f.Town.trip?.phase !== 'open-storage'; n++) {
    const sent = f.commands.length; f.advance(1000); f.Controller.tick();
    for (const c of f.commands.slice(sent)) if (c.kind === 'move') { moves.push({ ...c.destination }); f.World.gp.pose = { ...c.destination }; }
  }
  assert.equal(f.Town.trip?.phase, 'open-storage', f.Town.message);
  const steps = moves.filter(m => Math.hypot(m.x - 30, m.z - 110) > 1);
  assert.ok(steps.length >= 2); assert.equal(f.Navigation.pointStatus(steps[0]), 'open', 'the first step leaves the blocked tile');
  assert.ok(Math.hypot(steps[0].x - 30, steps[0].z - 110) <= 40, 'a short step out, not a long blind walk');
  assert.equal(f.commands.some(c => c.kind === 'item-use'), false);
});
test('a town walk that is stuck goes to the town start first, then on to the service, without looping', () => {
  const f = townFixture(); f.Town.begin(); f.Town.enter('walk-storage');
  let stuck = 1; f.Navigation.watch = () => (stuck-- > 0 ? 'giveup' : '');
  f.Town.tick();
  assert.equal(f.Town.trip.phase, 'walk-arrival'); assert.match(f.Town.message, /no way to the warehouse from here; going to the town start first/);
  f.World.gp.pose.x = 100; f.Town.tick(); assert.equal(f.Town.trip.phase, 'walk-storage', 'at the town start it heads for the service again');
  f.World.gp.pose.x = 40; stuck = 1; f.Town.tick();
  assert.equal(f.Town.trip.phase, 'walk-vendor', 'stuck again on the same walk: the old fallback, no second detour');
  const g = townFixture(); g.Town.begin(); g.Town.enter('walk-vendor');
  let plans = 0; g.Navigation.next = () => { plans++; return { error: 'No walkable route found.' }; };
  for (let i = 0; i < 6; i++) { g.advance(100); g.Town.tick(); }
  assert.equal(plans, 3, 'one try via the town start, then the usual timed retries');
  assert.equal(g.Town.trip.phase, 'walk-vendor'); assert.match(g.Town.message, /waiting; retrying collision route/);
  assert.equal(g.Log.lines.filter(l => /going to the town start first/.test(l.text)).length, 1);
});


function buffGearFixture() {
  const f = fixture(), gp = f.World.gp;
  const weapon = (slot, ref, sub = 1) => ({slot, refObjId:ref, typeFlags:(sub<<11)|(6<<7)|44, plus:0, variance:'1', durability:100});
  const shield = (slot, ref) => ({slot,refObjId:ref,typeFlags:(1<<11)|(4<<7)|44,plus:0});
  gp.inventory = [weapon(6,100,8),shield(7,101),weapon(13,200,15),shield(14,201),weapon(15,300,14)];
  gp.skills=[20,30];
  f.World.catalog.set(20,{id:20,group:20,name:'Cleric buff',targetRequired:false,actionMs:1000,durationMs:60000});
  f.World.catalog.set(30,{id:30,group:30,name:'Bard buff',targetRequired:false,actionMs:1000,durationMs:60000});
  const key = slot => f.BuffGear.key(gp.inventory.find(i=>i.slot===slot));
  f.Settings.profile.macro.buffSets=[{id:1,name:'Cleric',weapon:key(13),shield:key(14)},{id:2,name:'Bard',weapon:key(15),shield:null}];
  f.Settings.profile.macro.buffSwap=true;
  f.Settings.profile.macro.buffs=[{id:20,group:20,gearSet:1,enabled:true,mode:'hunt'},{id:30,group:30,gearSet:2,enabled:true,mode:'hunt'}];
  f.Hunt.running=true; f.Settings.profile.hunt.pickup.enabled=false;
  f.BuffGear.init();
  f.confirmMove=()=>{
    const p=f.BuffGear.run.pending, from=gp.inventory.find(i=>i.slot===p.source), to=gp.inventory.find(i=>i.slot===p.destination);
    from.slot=p.destination; if(to)to.slot=p.source;
    gp.inventoryPending=false; f.advance(300);
  };
  f.confirmBuff=id=>{
    gp.buffSlots ||= []; gp.buffSlots.push({state:'active',effect:{gid:1,skill:id,remainingMs:60000,receivedAtMs:f.World.simNow()}});
  };
  f.drive=(max=100)=>{
    for(let n=0;n<max;n++){
      f.BuffGear.tick();
      if(f.BuffGear.run?.pending)f.confirmMove();
      if(f.BuffGear.run?.cast){ f.confirmBuff(f.BuffGear.run.cast.id); f.advance(2000); }
      f.advance(300);
      if(!f.BuffGear.run)return;
    }
    throw Error('Buff gear did not finish');
  };
  return f;
}

test('buff gear runs cleric and bard sets and restores arbitrary combat weapon and shield',()=>{
  const f=buffGearFixture(), home=JSON.stringify(f.BuffGear.setup());
  assert.equal(f.BuffGear.tick(),true); f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);
  assert.deepEqual(f.commands.filter(c=>c.kind==='skill').map(c=>c.skillId),[20,30]);
  assert.ok(f.commands.some(c=>c.kind==='inventory-move'&&c.source===7));
  assert.equal(f.BuffGear.recovery,null); assert.equal(f.Hunt.running,true);
  const count=f.commands.length; f.BuffGear.tick(); assert.equal(f.commands.length,count);
});

test('dying with a buff weapon on puts the combat weapon back after revival and keeps hunting', () => {
  const f = buffGearFixture(), home = JSON.stringify(f.BuffGear.setup());
  assert.equal(f.BuffGear.tick(), true);
  for (let n = 0; n < 20 && JSON.stringify(f.BuffGear.setup()) === home; n++) { f.BuffGear.tick(); if (f.BuffGear.run?.pending) f.confirmMove(); f.advance(300); }
  assert.notEqual(JSON.stringify(f.BuffGear.setup()), home, 'a buff weapon is on');
  f.World.isDead = () => true; f.BuffGear.tick();
  assert.equal(f.BuffGear.run, null); assert.ok(f.BuffGear.recovery); assert.equal(f.Hunt.running, true, 'dying does not stop hunting');
  f.World.isDead = () => false; f.BuffGear.resume();
  assert.ok(f.BuffGear.run?.restoring, 'restoring starts on its own');
  f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()), home); assert.equal(f.BuffGear.recovery, null);
});
test('the pet status notes have a fixed height and are never hidden, so the panel below does not shift', () => {
  const fs = require('fs'), css = fs.readFileSync(__dirname + '/lean-skin.css', 'utf8'), ui = fs.readFileSync(__dirname + '/lean-ui.js', 'utf8');
  assert.match(css, /\.pet-note\{height:[\d.]+em;[^}]*overflow-y:auto/);
  assert.match(ui, /petNote = el\('p', '', 'muted pet-note'\)/); assert.match(ui, /petPotionNote = el\('p', PetPotion\.message, 'muted pet-note'\)/);
  assert.doesNotMatch(ui, /petNote\.hidden/);
});
test('the wait status box keeps one height for short and long text, so the panel below does not shift', () => {
  const fs = require('fs'), css = fs.readFileSync(__dirname + '/lean-skin.css', 'utf8'), ui = fs.readFileSync(__dirname + '/lean-ui.js', 'utf8');
  assert.match(css, /(^|\n)\.waiting\{[^}]*height:\d+lh;[^}]*overflow-y:auto/);
  assert.doesNotMatch(css, /\.waiting\{[^}]*min-height/, 'a minimum height still lets long text grow the box');
  assert.match(ui, /waitNote\.title = /, 'the full text stays readable in the tooltip');
});
test('buff gear says why a due buff is not being swapped in, instead of staying silent', () => {
  const f = buffGearFixture(), gp = f.World.gp;
  gp.inventory = gp.inventory.filter(i => i.slot !== 15);
  assert.equal(f.BuffGear.tick(), false); assert.match(f.BuffGear.status(), /Cannot find the saved set "Bard"/);
  gp.inventory.push({ slot: 15, refObjId: 300, typeFlags: (14 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 }, { slot: 16, refObjId: 300, typeFlags: (14 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 });
  f.BuffGear.tick(); assert.match(f.BuffGear.status(), /Cannot find the saved set "Bard".*identical/s, 'two identical copies cannot be told apart');
  gp.inventory = gp.inventory.filter(i => i.slot !== 16); f.BuffGear.tick(); assert.equal(f.BuffGear.waiting, '', 'the reason clears once it can start'); f.BuffGear.run = null;
  f.Settings.profile.macro.buffSets = [];
  assert.match(f.BuffGear.status(), /no buff set is saved yet/);
  const g = buffGearFixture(); g.Settings.profile.macro.buffs.forEach(b => b.gearSet = 0);
  assert.match(g.BuffGear.status(), /no buff skill is assigned/);
});
test('buff gear status lists each assigned buff, and a cast that was only unconfirmed is tried again', () => {
  const f = buffGearFixture(); f.confirmBuff(20);
  assert.match(f.BuffGear.status(), /Cleric buff: active, \d+ s left/); assert.match(f.BuffGear.status(), /Bard buff: due now/);
  const group = f.Settings.profile.macro.buffs[1].group;
  f.BuffGear.skipped.set(group, { signature: f.BuffGear.signature(), until: f.World.simNow() + 120000, why: 'the cast was not confirmed, trying again in two minutes' });
  assert.match(f.BuffGear.status(), /Bard buff: skipped because the cast was not confirmed/);
  assert.equal(f.BuffGear.due(f.Settings.profile.macro.buffs[1]), 0);
  f.BuffGear.skipped.set(group, { signature: f.BuffGear.signature(), until: 0, why: 'x' });
  assert.ok(f.BuffGear.due(f.Settings.profile.macro.buffs[1]) > 0, 'the skip has expired'); assert.equal(f.BuffGear.skipped.has(group), false);
});
// Skill-driven swapping: the game's own weaponKinds say which weapon a buff needs; no saved set is involved.
function autoGearFixture(){
  const f=buffGearFixture(), gp=f.World.gp;
  f.World.catalog.set(20,{...f.World.catalog.get(20),admit:{weaponKinds:[15,255]}});
  f.World.catalog.set(30,{...f.World.catalog.get(30),admit:{weaponKinds:[14,255]}});
  f.Settings.profile.macro.buffSets=[]; f.Settings.profile.macro.buffAuto=true;
  f.Settings.profile.macro.buffs=[{id:20,group:20,gearSet:0,enabled:true,mode:'hunt'},{id:30,group:30,gearSet:0,enabled:true,mode:'hunt'}];
  return f;
}
test('buff gear wears the weapon each buff needs and restores the combat weapon and shield',()=>{
  const f=autoGearFixture(), gp=f.World.gp, home=JSON.stringify(f.BuffGear.setup());
  assert.equal(f.BuffGear.owns(f.Settings.profile.macro.buffs[0]),true);
  assert.equal(f.BuffGear.tick(),true);
  const casts=[]; const cast=f.Combat.cast.bind(f.Combat); f.Combat.cast=(id,...a)=>{casts.push([id,gp.inventory.find(i=>i.slot===6).refObjId,gp.inventory.find(i=>i.slot===7)?.refObjId]);return cast(id,...a);};
  f.drive();
  assert.deepEqual(casts.map(c=>c[0]),[20,30]);
  assert.deepEqual(casts[0].slice(1),[200,101],'one-handed staff keeps the shield on');
  assert.deepEqual(casts[1].slice(1),[300,undefined],'the harp is worn without the shield');
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);
  assert.equal(f.BuffGear.recovery,null);
});
test('buff gear wears a bag shield (and a one-handed weapon) for a shield buff, then restores the two-handed weapon',()=>{
  const f=autoGearFixture(), gp=f.World.gp, home=JSON.stringify({}) ;
  gp.inventory=gp.inventory.filter(i=>i.slot!==7&&i.slot!==15);
  f.World.catalog.set(20,{...f.World.catalog.get(20),admit:{weaponKinds:[255],reqi:[{shield:true}]}});
  f.Settings.profile.macro.buffs=[f.Settings.profile.macro.buffs[0]];
  const before=JSON.stringify(f.BuffGear.setup());
  assert.equal(f.BuffGear.owns(f.Settings.profile.macro.buffs[0]),true);
  assert.equal(f.BuffGear.tick(),true);
  const casts=[]; const cast=f.Combat.cast.bind(f.Combat); f.Combat.cast=(id,...a)=>{casts.push([id,gp.inventory.find(i=>i.slot===6).refObjId,gp.inventory.find(i=>i.slot===7)?.refObjId]);return cast(id,...a);};
  f.drive();
  assert.deepEqual(casts.map(c=>c[0]),[20]);
  assert.deepEqual(casts[0].slice(1),[200,201]);
  assert.equal(JSON.stringify(f.BuffGear.setup()),before);
});
test('buff gear leaves buffs the worn weapon already satisfies to the normal buff loop',()=>{
  const f=autoGearFixture(), gp=f.World.gp;
  gp.inventory.find(i=>i.slot===6).typeFlags=(15<<11)|(6<<7)|44;
  assert.equal(f.BuffGear.owns(f.Settings.profile.macro.buffs[0]),false);
  assert.equal(f.BuffGear.owns(f.Settings.profile.macro.buffs[1]),true);
  f.Settings.profile.macro.buffAuto=false; assert.equal(f.BuffGear.owns(f.Settings.profile.macro.buffs[1]),false);
});
test('buff gear says when no bag weapon fits a buff and sends nothing',()=>{
  const f=autoGearFixture(), gp=f.World.gp;
  gp.inventory=gp.inventory.filter(i=>i.slot!==15);
  f.Settings.profile.macro.buffs=[f.Settings.profile.macro.buffs[1]];
  const count=f.commands.length;
  assert.equal(f.BuffGear.tick(),false); assert.equal(f.commands.length,count);
  assert.match(f.BuffGear.waiting,/needs a harp, and none you can use is in your bag/);
  assert.match(f.BuffGear.status(),/needs a harp/);
});
test('buff gear takes any copy of identical weapons and skips ones above the character level or broken',()=>{
  const f=autoGearFixture(), gp=f.World.gp;
  gp.inventory.push({...gp.inventory.find(i=>i.slot===15),slot:16});
  f.Settings.profile.macro.buffs=[f.Settings.profile.macro.buffs[1]];
  assert.equal(f.BuffGear.tick(),true,'identical copies do not block the swap');
  f.BuffGear.run=null;
  gp.inventory.find(i=>i.slot===15).durability=0;
  assert.equal(f.BuffGear.pick([14]).slot,16,'a broken weapon is not picked');
  gp.progression={level:10}; for(const i of gp.inventory.filter(i=>i.slot>=13))i.tooltip={fields:{reqLevelType1:1,requiredLevel:50}};
  assert.equal(f.BuffGear.pick([14]),null,'a weapon the character cannot wield is not picked');
});
test('buff gear never picks a weapon the game refused to equip again',()=>{
  const f=autoGearFixture(), gp=f.World.gp;
  f.Settings.profile.macro.buffs=[f.Settings.profile.macro.buffs[0]];
  f.BuffGear.tick(); f.BuffGear.tick();
  assert.ok(f.BuffGear.run.pending,'the move is sent and waits for confirmation');
  for(let n=0;n<60;n++){f.advance(300);f.BuffGear.tick();}
  assert.equal(f.BuffGear.run,null); assert.equal(f.Hunt.running,true);
  assert.ok(f.BuffGear.bad.size===1);
  assert.equal(f.BuffGear.pick([15]),null);
});
test('buff gear carries on when the game refuses a picked weapon, and restores gear',()=>{
  const f=autoGearFixture(), gp=f.World.gp, home=JSON.stringify(f.BuffGear.setup());
  f.Settings.profile.macro.buffs=[f.Settings.profile.macro.buffs[0]];
  f.BuffGear.tick(); f.BuffGear.tick();
  assert.ok(f.BuffGear.run.pending);
  for(let n=0;n<20&&f.BuffGear.run?.pending;n++){f.advance(300);f.BuffGear.tick();}
  assert.equal(f.BuffGear.run?.pending??null,null,'a refused move is dropped without waiting fifteen seconds');
  assert.equal(f.BuffGear.recovery,null); assert.equal(f.Hunt.running,true,'hunting is not stopped');
  assert.equal(f.BuffGear.bad.size,1);
  for(let n=0;n<10&&f.BuffGear.run;n++){f.BuffGear.tick();f.advance(1200);}
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);
  assert.match(f.BuffGear.message,/would not equip/);
});
test('the primary weapon is the combat gear: worn while hunting, with the shield when it is one-handed', () => {
  const f = buffGearFixture(), gp = f.World.gp, at = s => gp.inventory.find(i => i.slot === s)?.refObjId;
  const key = s => f.BuffGear.key(gp.inventory.find(i => i.slot === s));
  f.Settings.profile.macro.buffs = [];
  assert.equal(f.BuffGear.tick(), false, 'without a primary weapon what is worn stays');
  f.ItemRules.setGear('primaryWeapon', key(13)); f.ItemRules.setGear('shield', key(14));
  assert.equal(f.BuffGear.tick(), true, 'something else is worn'); f.drive();
  assert.deepEqual([at(6), at(7)], [200, 201], 'the one-handed primary with the chosen shield');
  assert.equal(f.Hunt.running, true);
  let n = f.commands.length; f.BuffGear.tick(); assert.equal(f.commands.length, n, 'nothing more to wear');
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 300)));
  assert.equal(f.BuffGear.tick(), true); f.drive();
  assert.deepEqual([at(6), at(7)], [300, undefined], 'a two-handed primary goes on without the shield');
  f.Settings.profile.macro.buffSwap = false; f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 100)));
  assert.equal(f.BuffGear.tick(), true, 'also with buff swapping off'); f.drive();
  assert.equal(at(6), 100);
  f.Hunt.running = false; f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 300)));
  n = f.commands.length; assert.equal(f.BuffGear.tick(), false, 'only while hunting'); assert.equal(f.commands.length, n);
});
test('a primary weapon the game refuses is left alone without stopping hunting', () => {
  const f = buffGearFixture(), gp = f.World.gp;
  f.Settings.profile.macro.buffs = []; gp.inventory = gp.inventory.filter(i => i.slot !== 7);
  const harp = f.BuffGear.key(gp.inventory.find(i => i.slot === 15));
  f.ItemRules.setGear('primaryWeapon', harp);
  f.BuffGear.tick(); f.BuffGear.tick();
  assert.equal(f.BuffGear.run.pending.source, 15, 'the primary is sent to the weapon slot');
  for (let n = 0; n < 20 && f.BuffGear.run; n++) { f.advance(300); f.BuffGear.tick(); }
  assert.equal(f.BuffGear.run, null); assert.equal(f.Hunt.running, true, 'hunting goes on');
  assert.match(f.BuffGear.message, /would not equip .*until you pick it again/);
  assert.equal(f.BuffGear.bad.has(harp), true); assert.equal(f.BuffGear.combat(), null, 'what is worn is the combat gear again');
  const n = f.commands.length; f.advance(1000); f.BuffGear.tick(); assert.equal(f.commands.length, n, 'no retry');
});
test('a bow or crossbow primary wears its own arrows or bolts from the bag, never the other kind', () => {
  const f = buffGearFixture(), gp = f.World.gp, at = s => gp.inventory.find(i => i.slot === s)?.refObjId;
  const ammo = (slot, ref, kind, quantity) => ({ slot, refObjId: ref, typeFlags: 108 | (4 << 7) | (kind << 11), quantity });
  f.Settings.profile.macro.buffs = [];
  gp.inventory = gp.inventory.filter(i => ![7, 14, 15].includes(i.slot));
  gp.inventory.push({ slot: 14, refObjId: 400, typeFlags: (12 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 },
    ammo(15, 62, 1, 900), ammo(16, 10376, 2, 40), ammo(17, 10377, 2, 700));
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 400)));
  assert.equal(f.BuffGear.tick(), true); f.drive();
  assert.deepEqual([at(6), at(7)], [400, 10377], 'the crossbow with the biggest bolt stack, not the arrows');
  gp.inventory = gp.inventory.filter(i => i.slot !== 7); f.BuffGear.tick(); f.drive();
  assert.equal(at(7), 10376, 'used up: the next bolts go on');
  gp.inventory = gp.inventory.filter(i => i.slot !== 7); const n = f.commands.length;
  assert.equal(f.BuffGear.tick(), false, 'no bolts left: the crossbow stays as it is'); assert.equal(f.commands.length, n);
  gp.inventory.push({ slot: 18, refObjId: 401, typeFlags: (6 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 }, ammo(7, 10376, 2, 30));
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 401)));
  f.BuffGear.tick(); f.drive();
  assert.deepEqual([at(6), at(7)], [401, 62], 'a bow takes the arrows, and the worn bolts go to the bag');
  assert.ok(gp.inventory.some(i => i.refObjId === 10376 && i.slot >= 13));
});
test('a buff on the secondary cleric rod puts the crossbow and its bolts back after', () => {
  const f = buffGearFixture(), gp = f.World.gp, at = s => gp.inventory.find(i => i.slot === s)?.refObjId;
  gp.inventory = gp.inventory.filter(i => ![6, 7, 14, 15].includes(i.slot));
  gp.inventory.push({ slot: 6, refObjId: 400, typeFlags: (12 << 11) | (6 << 7) | 44, plus: 0, variance: '1', durability: 100 },
    { slot: 7, refObjId: 10376, typeFlags: 108 | (4 << 7) | (2 << 11), quantity: 500 });
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.slot === 6)));
  f.ItemRules.setGear('secondaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.slot === 13)));
  f.Settings.profile.macro.buffs = [{ id: 20, group: 20, gearSet: 'secondary', enabled: true, mode: 'hunt' }];
  const casts = [], cast = f.Combat.cast.bind(f.Combat);
  f.Combat.cast = (id, ...a) => { casts.push([id, at(6), at(7)]); return cast(id, ...a); };
  assert.equal(f.BuffGear.tick(), true); f.drive();
  assert.deepEqual(casts, [[20, 200, undefined]], 'the rod is worn without the bolts');
  assert.deepEqual([at(6), at(7)], [400, 10376], 'then the crossbow and its bolts');
});
test('a chosen shield the game refuses is skipped and the shield worn before goes back on', () => {
  const f = buffGearFixture(), gp = f.World.gp, at = s => gp.inventory.find(i => i.slot === s)?.refObjId;
  const key = s => f.BuffGear.key(gp.inventory.find(i => i.slot === s)), refusedShield = key(14);
  f.Settings.profile.macro.buffs = [];
  f.ItemRules.setGear('primaryWeapon', key(13)); f.ItemRules.setGear('shield', refusedShield);
  f.BuffGear.tick();
  for (let n = 0; n < 60 && f.BuffGear.run; n++) {
    f.BuffGear.tick();
    const p = f.BuffGear.run?.pending;
    if (p && !(p.destination === 7 && p.from === refusedShield)) f.confirmMove(); else f.advance(300);
  }
  assert.equal(f.BuffGear.run, null); assert.equal(f.Hunt.running, true, 'hunting goes on');
  assert.deepEqual([at(6), at(7)], [200, 101], 'the primary with the shield worn before, not an empty off-hand');
  assert.equal(f.BuffGear.bad.has(refusedShield), true); assert.match(f.BuffGear.message, /would not equip/);
  const n = f.commands.length; f.advance(1000); f.BuffGear.tick(); assert.equal(f.commands.length, n, 'settled: nothing more to wear');
});
test('a buff assigned to the secondary weapon or the shield wears it, then the primary comes back', () => {
  const f = buffGearFixture(), gp = f.World.gp, at = s => gp.inventory.find(i => i.slot === s)?.refObjId;
  const key = s => f.BuffGear.key(gp.inventory.find(i => i.slot === s));
  f.ItemRules.setGear('primaryWeapon', key(13)); f.ItemRules.setGear('secondaryWeapon', key(15)); f.ItemRules.setGear('shield', key(14));
  f.Settings.profile.macro.buffs = [{ id: 30, group: 30, gearSet: 'secondary', enabled: true, mode: 'hunt' }];
  const casts = [], cast = f.Combat.cast.bind(f.Combat);
  f.Combat.cast = (id, ...a) => { casts.push([id, at(6), at(7)]); return cast(id, ...a); };
  assert.equal(f.BuffGear.tick(), true); f.drive();
  assert.deepEqual(casts, [[30, 300, undefined]], 'cast with the secondary harp');
  assert.deepEqual([at(6), at(7)], [200, 201], 'then the primary staff and the shield, not what was worn before');
  assert.match(f.BuffGear.status(), /Bard buff: active/);
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 300)));
  f.ItemRules.setGear('secondaryWeapon', f.BuffGear.key(gp.inventory.find(i => i.refObjId === 200)));
  f.drive();
  assert.deepEqual([at(6), at(7)], [300, undefined]);
  f.Settings.profile.macro.buffs = [{ id: 20, group: 20, gearSet: 'shield', enabled: true, mode: 'hunt' }]; casts.length = 0;
  assert.equal(f.BuffGear.tick(), true); f.drive();
  assert.deepEqual(casts, [[20, 200, 201]], 'the shield goes on with the one-handed secondary');
  assert.deepEqual([at(6), at(7)], [300, undefined], 'and comes off with the two-handed primary');
  f.ItemRules.setGear('shield', null); f.Settings.profile.macro.buffs[0].gearSet = 'shield'; f.Combat.buffCastAt.clear(); gp.buffSlots = [];
  assert.equal(f.BuffGear.tick(), false); assert.match(f.BuffGear.waiting, /Choose a shield under Combat/);
});
test('automatic buff swaps try the secondary weapon, then the primary, then the highest plus', () => {
  const f = autoGearFixture(), gp = f.World.gp;
  const harp = gp.inventory.find(i => i.slot === 15), better = { ...harp, slot: 16, plus: 5 }, other = { ...harp, slot: 17, plus: 3 };
  gp.inventory.push(better, other);
  assert.equal(f.BuffGear.pick([14]).slot, 16, 'the highest plus without a choice');
  f.ItemRules.setGear('primaryWeapon', f.BuffGear.key(other)); assert.equal(f.BuffGear.pick([14]).slot, 17, 'the primary');
  f.ItemRules.setGear('secondaryWeapon', f.BuffGear.key(harp)); assert.equal(f.BuffGear.pick([14]).slot, 15, 'the secondary first');
});
test('a share keeps buffs assigned to the primary or secondary weapon or the shield', () => {
  const f = shareFixture(); f.Settings.profile.macro.buffs = [{ id: 20, group: 20, gearSet: 'secondary', enabled: true }];
  assert.equal(JSON.parse(f.ProfileShare.text(true)).profile.macro.buffs[0].gearSet, 'secondary');
});
test('buff gear failure names the move that was not confirmed',()=>{
  const f=buffGearFixture(); f.BuffGear.tick(); f.BuffGear.tick();
  f.World.gp.inventoryPending=true;
  for(let n=0;n<60;n++){f.advance(300);f.BuffGear.tick();}
  assert.match(f.BuffGear.message,/Equipment move unconfirmed \(.*slot \d+ to \d+\)/);
});
test('buff gear waits for actual inventory confirmation and never casts with stale equipment',()=>{
  const f=buffGearFixture(); f.BuffGear.tick(); f.BuffGear.tick();
  const count=f.commands.length; assert.ok(f.BuffGear.run.pending);
  for(let n=0;n<20;n++){f.advance(300);f.BuffGear.tick();}
  assert.equal(f.commands.length,count); assert.equal(f.commands.some(c=>c.kind==='skill'),false);
  f.confirmMove(); f.World.gp.inventoryPending=true;
  f.BuffGear.tick();assert.equal(f.commands.length,count);
  f.World.gp.inventoryPending=false;f.drive();assert.equal(f.BuffGear.run,null);
});

test('buff gear unconfirmed move stops hunting and blocks restart without repeating it',()=>{
  const f=buffGearFixture();f.BuffGear.tick();f.BuffGear.tick();const count=f.commands.filter(c=>c.kind!=='move').length;
  f.advance(15001);f.BuffGear.tick();
  assert.equal(f.Hunt.running,false);assert.ok(f.BuffGear.recovery);assert.equal(f.BuffGear.run,null);
  f.BuffGear.tick();f.Hunt.start();assert.equal(f.Hunt.running,false);assert.equal(f.commands.filter(c=>c.kind!=='move').length,count);
  assert.match(f.BuffGear.message,/unconfirmed/);
});

test('buff gear Stop all settles an in-flight swap and restores without casting',()=>{
  const f=buffGearFixture(), home=JSON.stringify(f.BuffGear.setup());
  f.BuffGear.tick();f.BuffGear.tick();f.stopAll();
  assert.ok(f.BuffGear.run.pending);f.confirmMove();f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);assert.equal(f.commands.some(c=>c.kind==='skill'),false);
  assert.equal(f.Hunt.running,false);
});

test('buff gear waits through buff action hold even before casting state arrives',()=>{
  const f=buffGearFixture();f.BuffGear.tick();
  for(let n=0;n<20&&!f.BuffGear.run.cast;n++) {f.BuffGear.tick();if(f.BuffGear.run.pending)f.confirmMove();f.advance(250);}
  assert.ok(f.BuffGear.run.cast);const count=f.commands.length;
  f.confirmBuff(20);f.advance(500);f.BuffGear.tick();assert.equal(f.commands.length,count);
  f.World.isCasting=()=>true;f.advance(2000);f.BuffGear.tick();assert.equal(f.commands.length,count);
  f.World.isCasting=()=>false;f.drive();assert.equal(f.BuffGear.run,null);
});

test('buff gear missing or ambiguous sets and full bags never move equipment',()=>{
  for(const mode of ['missing','ambiguous','full']){
    const f=buffGearFixture();
    if(mode==='missing')f.World.gp.inventory=f.World.gp.inventory.filter(i=>i.refObjId!==200);
    if(mode==='ambiguous')f.World.gp.inventory.push({...f.World.gp.inventory[2],slot:16});
    if(mode==='full')f.World.freeBagSlots=()=>0;
    assert.equal(f.BuffGear.tick(),false);assert.equal(f.commands.length,0);
  }
});

test('buff gear manual movement stops swaps and requires explicit equipment review',()=>{
  const f=buffGearFixture();f.BuffGear.tick();f.BuffGear.tick();const count=f.commands.filter(c=>c.kind!=='move').length;
  f.Manual.lastAt=100001;f.BuffGear.tick();assert.ok(f.BuffGear.recovery);assert.equal(f.Hunt.running,false);
  assert.equal(f.commands.filter(c=>c.kind!=='move').length,count);
});

test('buff gear manual inventory command is not overwritten by automatic restoration',()=>{
  const f=buffGearFixture();f.BuffGear.tick();
  for(const observer of f.Hook.observers)observer({kind:'gameplay',command:{kind:'inventory-move',source:13,destination:6}});
  assert.equal(f.BuffGear.run,null);assert.ok(f.BuffGear.recovery);assert.equal(f.Hunt.running,false);
});

test('buff gear death and disconnect reset never dispatch gear commands',()=>{
  for(const mode of ['dead','offline']){
    const f=buffGearFixture();f.BuffGear.tick();f.BuffGear.tick();const count=f.commands.length;
    if(mode==='dead')f.World.isDead=()=>true;else f.World.phase='login';
    f.BuffGear.tick();assert.equal(f.BuffGear.run,null);assert.equal(f.commands.length,count);assert.ok(f.BuffGear.recovery);assert.equal(f.Hunt.running,true,'hunting carries on; gear is restored after revival');assert.equal(f.BuffGear.autoRestore,true);
  }
});

test('buff gear disabled mid-cycle restores original equipment before resuming',()=>{
  const f=buffGearFixture(), home=JSON.stringify(f.BuffGear.setup());
  f.BuffGear.tick();f.BuffGear.tick();f.confirmMove();f.Settings.profile.macro.buffSwap=false;
  f.drive();assert.equal(JSON.stringify(f.BuffGear.setup()),home);assert.equal(f.commands.some(c=>c.kind==='skill'),false);
});

test('buff gear controller retains party and potion services but excludes combat travel and alchemy',()=>{
  const f=buffGearFixture();let parties=0,potions=0,fights=0,towns=0;
  f.Party.tick=()=>parties++;f.Potion.tick=()=>potions++;f.Hunt.tick=()=>fights++;f.Town.tick=()=>{towns++;return false;};
  f.Controller.tick();assert.ok(f.BuffGear.run);const townCount=towns;
  f.Controller.tick();assert.equal(fights,0);assert.equal(parties,2);assert.equal(potions,2);assert.equal(towns,townCount);
  f.WalkBack.start();assert.equal(f.WalkBack.active,null);assert.match(f.Alchemy.blocked(),/combat gear/);
});

test('buff gear start gates respect other services, casting, inventory, manual pause and mount',()=>{
  for(const mode of ['town','walk','res','shop','casting','inventory','manual','mount','off']){
    const f=buffGearFixture();
    if(mode==='town')f.Town.trip={};if(mode==='walk')f.WalkBack.active={};if(mode==='res')f.Resurrect.trip={};
    if(mode==='shop')f.Restock.activeShop=()=>true;if(mode==='casting')f.World.isCasting=()=>true;
    if(mode==='inventory')f.World.gp.inventoryPending=true;if(mode==='manual')f.Manual.lastAt=100000;
    if(mode==='mount')f.World.local=()=>({mountedOn:5});if(mode==='off')f.Settings.profile.macro.buffSwap=false;
    assert.equal(f.BuffGear.tick(),false,mode);assert.equal(f.commands.length,0,mode);
  }
});

test('assigned buffs never cast on combat gear when swapping is off; ordinary buffs still work',()=>{
  const f=buffGearFixture();f.Settings.profile.macro.buffSwap=false;
  assert.equal(f.Combat.buffs(true),false);assert.equal(f.commands.length,0);
  f.Settings.profile.macro.buffs[0].gearSet=0;
  assert.equal(f.Combat.buffs(true),true);assert.equal(f.commands.at(-1).skillId,20);
});

test('self-castable target buffs (Holy Spell, Body Blessing) are listed and cast on yourself',()=>{
  const f=buffGearFixture();f.Settings.profile.macro.buffs=[];
  f.World.gp.skills=[40,41];
  f.World.catalog.set(40,{id:40,group:40,name:'Holy Spell',targetRequired:true,targets:1|16|32,actionMs:1000,durationMs:60000});
  f.World.catalog.set(41,{id:41,group:41,name:'Heal',targetRequired:true,targets:16|32,actionMs:1000});
  assert.equal(f.UI.learnedSkills(true).map(s=>s.id).join(),'40');
  f.Settings.profile.macro.buffs=[{id:40,group:40,enabled:true,mode:'hunt'}];
  assert.equal(f.Combat.buffs(true),true);
  assert.equal(f.commands.at(-1).skillId,40);assert.equal(f.commands.at(-1).targetGid ?? f.commands.at(-1).gid ?? f.World.localGid(),f.World.localGid());
});

test('buff gear unconfirmed cast returns home and suppresses repeated failed swaps',()=>{
  const f=buffGearFixture(),home=JSON.stringify(f.BuffGear.setup());f.BuffGear.tick();
  for(let n=0;n<20&&!f.BuffGear.run.cast;n++){f.BuffGear.tick();if(f.BuffGear.run.pending)f.confirmMove();f.advance(300);}
  assert.ok(f.BuffGear.run.cast);f.advance(11000);f.BuffGear.tick();f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);assert.equal(f.BuffGear.skipped.has(20),true);
  assert.equal(f.commands.filter(c=>c.kind==='skill'&&c.skillId===20).length,1);
});

test('buff gear notices effects lost on weapon removal and prevents recast loops',()=>{
  const f=buffGearFixture();f.BuffGear.tick();
  for(let n=0;n<100&&f.BuffGear.run;n++){
    f.BuffGear.tick();
    if(f.BuffGear.run?.pending){f.confirmMove();f.World.gp.buffSlots=[];}
    if(f.BuffGear.run?.cast){f.confirmBuff(f.BuffGear.run.cast.id);f.advance(2000);}
    f.advance(300);
  }
  assert.equal(f.BuffGear.run,null);assert.equal(f.BuffGear.skipped.has(20),true);assert.equal(f.BuffGear.skipped.has(30),true);
  f.advance(100000);const count=f.commands.length;assert.equal(f.BuffGear.tick(),false);assert.equal(f.commands.length,count);
});

test('buff gear restores original bow ammunition as well as shield and empty off-hand setups',()=>{
  for(const mode of ['ammo','empty']){
    const f=buffGearFixture();
    if(mode==='ammo')f.World.gp.inventory.find(i=>i.slot===7).typeFlags=0x66c;
    else f.World.gp.inventory=f.World.gp.inventory.filter(i=>i.slot!==7);
    const home=JSON.stringify(f.BuffGear.setup());f.BuffGear.tick();f.drive();
    assert.equal(JSON.stringify(f.BuffGear.setup()),home);
  }
});


test('buff gear explicit recovery restores home after a settled failed cycle',()=>{
  const f=buffGearFixture(),home=JSON.stringify(f.BuffGear.setup());
  f.BuffGear.tick();f.BuffGear.tick();f.confirmMove();f.BuffGear.fail('Interrupted');
  assert.ok(f.BuffGear.recovery);f.BuffGear.restore();assert.ok(f.BuffGear.run);f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()),home);assert.equal(f.BuffGear.recovery,null);assert.equal(f.Hunt.running,false);
});

test('buff gear reports restoration failure and does not resume combat',()=>{
  const f=buffGearFixture();f.BuffGear.tick();f.BuffGear.tick();f.confirmMove();
  f.Settings.profile.macro.buffSwap=false;f.BuffGear.tick();f.World.gp.inventory=f.World.gp.inventory.filter(i=>i.refObjId!==101);
  f.advance(15001);f.BuffGear.tick();assert.equal(f.Hunt.running,false);assert.ok(f.BuffGear.recovery);assert.match(f.BuffGear.message,/unconfirmed/);
});

test('buff gear resets recovery on character or profile change without touching new gear',()=>{
  for(const mode of ['character','profile']){
    const f=buffGearFixture();f.BuffGear.tick();const count=f.commands.length;
    if(mode==='character')f.World.charName='Other';else f.Settings.profile={...f.Settings.profile};
    f.BuffGear.tick();assert.equal(f.BuffGear.run,null);assert.equal(f.BuffGear.recovery,null);assert.equal(f.commands.length,count);
  }
});


function sessionFixture() {
  const f=fixture();f.Stats.init();
  f.World.gp.progression={...f.World.gp.progression,level:1,experience:'100',gold:'1000'};
  f.Stats.levels={1:{expRequired:'118'},2:{expRequired:'470'},3:{expRequired:'1058'}};
  f.Hunt.running=true;f.Stats.huntStart();return f;
}

test('session stats accumulate hunting time across pauses without including stopped gains',()=>{
  const f=sessionFixture();f.advance(60000);f.Stats.sample();
  assert.equal(f.Stats.session.ms,60000);
  f.Hunt.stop();f.advance(120000);f.World.gp.progression.experience='10000';f.World.gp.progression.gold='20000';f.Stats.sample();
  assert.equal(f.Stats.session.ms,60000);assert.equal(f.Stats.session.xp,0n);assert.equal(f.Stats.session.gold,0n);
  f.Hunt.start();f.advance(30000);f.World.gp.progression.experience='10050';f.Stats.sample();
  assert.equal(f.Stats.session.ms,90000);assert.equal(f.Stats.session.xp,50n);
});

test('session XP gains handle single and multiple level rollovers without counting losses',()=>{
  const f=sessionFixture();
  for(const [level,experience] of [[1,'110'],[2,'20'],[4,'10']]){
    f.World.applyGameplay({...f.World.gp,progression:{...f.World.gp.progression,level,experience}});
  }
  assert.equal(f.Stats.session.xp,1556n);
  f.World.applyGameplay({...f.World.gp,progression:{...f.World.gp.progression,experience:'5'}});
  assert.equal(f.Stats.session.xp,1556n);
  f.World.applyGameplay({...f.World.gp,progression:{...f.World.gp.progression,experience:'15'}});
  assert.equal(f.Stats.session.xp,1566n);
});

test('session stats use exact BigInt XP and signed net gold including supply spending',()=>{
  const f=sessionFixture();f.Stats.reset();
  f.World.gp.progression.gold='9007199254740993000';f.World.gp.progression.experience='9007199254740993000';f.Stats.baseline=null;f.Stats.sample();
  f.World.applyGameplay({...f.World.gp,progression:{...f.World.gp.progression,gold:'9007199254740993900',experience:'9007199254740993123'}});
  f.World.applyGameplay({...f.World.gp,progression:{...f.World.gp.progression,gold:'9007199254740992500'}});
  assert.equal(f.Stats.session.xp,123n);assert.equal(f.Stats.session.gold,-500n);assert.equal(f.Stats.display().gold,'-500');
  assert.equal(f.commands.length,0);
});

test('session XP rate waits thirty seconds and uses active time only',()=>{
  const f=sessionFixture();f.World.gp.progression.experience='200';f.advance(29000);f.Stats.sample();
  assert.equal(f.Stats.display().rate,'—');f.advance(1000);f.Stats.sample();assert.equal(f.Stats.display().rate,'12,000');
  f.Hunt.stop();f.advance(3600000);f.Stats.sample();assert.equal(f.Stats.display().rate,'12,000');assert.equal(f.Stats.display().time,'00:00:30');
});

test('session kills require local or owned pet fatal results and deduplicate multi-hit updates',()=>{
  const f=sessionFixture();
  for(const gid of [10,11,12,13])f.World.ents.set(gid,{gid,kind:'monster'});
  f.World.ents.set(50,{gid:50,kind:'cos',ownerGid:1});f.World.ents.set(51,{gid:51,kind:'cos',ownerGid:2});
  const c={caster:1,target:10,fatal:true,results:[{target:10,impacts:[{fatal:true},{fatal:true}]},{target:11,impacts:[{fatal:true}]}]};
  f.bus.emit('cast',c);f.bus.emit('cast',c);assert.equal(f.Stats.session.kills,2);
  f.bus.emit('cast',{caster:2,target:12,fatal:true});f.bus.emit('cast',{caster:51,target:12,fatal:true});
  f.bus.emit('cast',{caster:1,target:1,fatal:true});assert.equal(f.Stats.session.kills,2);
  f.bus.emit('cast',{caster:50,target:12,fatal:true});assert.equal(f.Stats.session.kills,3);
  f.Stats.reset();f.bus.emit('cast',c);assert.equal(f.Stats.session.kills,0);
  f.bus.emit('spawn',{gid:10});f.bus.emit('cast',{caster:1,target:10,fatal:true});assert.equal(f.Stats.session.kills,1);
  f.Hunt.stop();f.bus.emit('cast',{caster:1,target:13,fatal:true});assert.equal(f.Stats.session.kills,1);
});

test('session deaths count once per alive-to-dead transition and not while stopped',()=>{
  const f=sessionFixture();const local=f.World.local();local.appearanceState=[2,0,0];f.bus.emit('death',local);
  f.Stats.sample();f.Stats.sample();assert.equal(f.Stats.session.deaths,1);
  local.appearanceState=[0,0,0];f.Stats.sample();local.appearanceState=[2,0,0];f.Stats.sample();assert.equal(f.Stats.session.deaths,2);
  f.Hunt.stop();local.appearanceState=[0,0,0];f.Stats.sample();local.appearanceState=[2,0,0];f.Stats.sample();assert.equal(f.Stats.session.deaths,2);
});

test('session potions count inventory-confirmed consumption rather than dispatch or unrelated loss',()=>{
  const f=sessionFixture(),item={slot:13,refObjId:101,typeFlags:2284,quantity:10};f.World.gp.inventory=[item];
  assert.equal(f.Potion.use('hp'),true);assert.equal(f.Stats.session.potions,0);
  f.advance(1000);f.Stats.sample();assert.equal(f.Stats.session.potions,0);
  item.quantity=9;f.Stats.sample();assert.equal(f.Stats.session.potions,1);f.Stats.sample();assert.equal(f.Stats.session.potions,1);
  item.quantity=8;f.Stats.sample();assert.equal(f.Stats.session.potions,1);
});


test('session potion confirmation ignores missing inventory snapshots',()=>{
  const f=sessionFixture(),item={slot:13,refObjId:101,quantity:10};f.World.gp.inventory=[item];f.Stats.potion(item);
  f.World.gp.inventory=undefined;f.Stats.sample();assert.equal(f.Stats.session.potions,0);
  f.World.gp.inventory=[{...item,quantity:9}];f.Stats.sample();assert.equal(f.Stats.session.potions,1);
});

test('session potion confirmations allocate only observed decreases and expire stale sends',()=>{
  const f=sessionFixture(),item={slot:13,refObjId:101,quantity:10};f.World.gp.inventory=[item];
  f.Stats.potion(item);f.Stats.potion(item);item.quantity=9;f.Stats.sample();assert.equal(f.Stats.session.potions,1);
  f.advance(15001);item.quantity=8;f.Stats.sample();assert.equal(f.Stats.session.potions,1);
  f.Hunt.stop();f.Stats.potion(item);item.quantity=7;f.Stats.sample();assert.equal(f.Stats.session.potions,1);
});

test('session pickup units require inventory gain and distinguish gold from items',()=>{
  const f=sessionFixture(),drop=f.drop();f.Loot.begin(drop);f.World.ents.delete(drop.gid);f.Loot.tick();assert.equal(f.Stats.session.items,0);
  f.World.gp.inventory=[{slot:13,refObjId:101,quantity:7}];f.Loot.tick();assert.equal(f.Stats.session.items,7);f.Loot.tick();assert.equal(f.Stats.session.items,7);
  f.advance(500);const gold=f.drop(21,748);assert.equal(f.Loot.begin(gold),true);f.World.gp.progression.gold='1050';f.Loot.tick();assert.equal(f.Stats.session.items,7);assert.equal(f.Stats.values.loot,2);
  const p=sessionFixture();pickupPet(p);const elixir=p.drop(20,3436);p.Loot.begin(elixir);
  p.World.gp.cosRecords[0].inventory.push({slot:0,refObjId:101,quantity:3});p.Loot.tick();assert.equal(p.Stats.session.items,3);
});

test('session reset clears totals while preserving the current tracking state and deduplication',()=>{
  const f=sessionFixture();f.advance(60000);f.World.gp.progression.gold='1050';f.Stats.sample();f.Stats.session.items=5;
  f.Stats.reset();assert.equal(f.Stats.session.ms,0);assert.equal(f.Stats.session.gold,0n);assert.equal(f.Stats.session.items,0);assert.equal(f.Stats.active,true);
  f.advance(1000);f.Stats.sample();assert.equal(f.Stats.session.ms,1000);
  f.Hunt.stop();f.Stats.reset();assert.equal(f.Stats.active,false);assert.equal(f.Stats.session.ms,0);
});

test('session stats rebase after disconnect and world reset without counting bootstrap balances',()=>{
  const f=sessionFixture();f.advance(1000);f.World.phase='login';f.bus.emit('phase','login');f.advance(60000);f.Stats.sample();
  f.World.gp.progression={level:70,experience:'10000000',gold:'90000000'};f.World.phase='world';f.bus.emit('phase','world');
  assert.equal(f.Stats.session.gold,0n);assert.equal(f.Stats.session.xp,0n);assert.equal(f.Stats.session.ms,1000);
  f.World.epoch++;f.World.gp.progression.gold='1';f.Stats.sample();assert.equal(f.Stats.session.gold,0n);
});

test('session stats reset on character change and tolerate missing or invalid progression',()=>{
  const f=sessionFixture();f.Stats.session.kills=5;f.Stats.session.xp=300n;f.bus.emit('character','Other');
  assert.equal(f.Stats.session.kills,0);assert.equal(f.Stats.session.xp,0n);
  f.World.gp.progression={};f.Stats.reset();assert.equal(f.Stats.display().xp,'—');assert.equal(f.Stats.display().gold,'—');
  for(const experience of [null,'oops',-1,1.5,Number.MAX_SAFE_INTEGER+2]){
    f.World.gp.progression={level:1,experience,gold:experience};f.Stats.sample();assert.equal(f.Stats.session.xp,0n);assert.equal(f.Stats.session.gold,0n);
  }
});

test('session XP keeps unresolved level transitions bounded and marked partial',()=>{
  const f=sessionFixture();f.Stats.levels=null;f.World.gp.progression={level:2,experience:'20',gold:'1000'};f.Stats.sample();
  assert.equal(f.Stats.session.xp,0n);assert.match(f.Stats.display().xp,/partial/);assert.equal(f.Stats.pendingXP.length,1);
  f.World.gp.progression={level:3,experience:'30',gold:'1000'};f.Stats.sample();assert.equal(f.Stats.pendingXP.length,2);
  f.Stats.reset();assert.equal(f.Stats.pendingXP.length,0);
});

async function updateTests() {
  async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
  const sha = 'a'.repeat(40), base = 'https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + sha + '/bot.lean.';
  function updater(f, version = '9.9.9') {
    const calls = [];
    f.win.fetch = async (url, options) => {
      calls.push({ url, options });
      return url.includes('api.github.com') ? { ok: true, json: async () => ({ sha }) } :
        { ok: true, text: async () => '// @version      ' + version + '\n' };
    };
    return calls;
  }
  await check('updates compare numeric version components and ignore malformed versions', async () => {
    const f = fixture();
    for (const v of ['9.9.9', '1.3.0', '2.0.0']) assert.equal(f.Updates.newer(v), true);
    for (const v of ['1.2.9', '1.2.36', '1.1.999', 'bad', '1.2.35-beta', '1.2.999999999999999999999']) assert.equal(f.Updates.newer(v), false);
  });
  await check('updates pin metadata and user-initiated installer to the same trusted commit', async () => {
    const f = fixture(), calls = updater(f); f.UI.updateButton = {};
    await f.Updates.check();
    assert.equal(calls.length, 3); assert.equal(calls[1].url, base + 'meta.js');
    assert.equal(calls[2].url, 'https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + sha + '/notes/9.9.9.md', 'the headline comes from the same commit');
    assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(f.UI.updateButton.hidden, false); assert.equal(f.UI.updateButton.textContent, 'Update 9.9.9');
    let opened; f.win.open = (...args) => { opened = args; };
    assert.equal(opened, undefined); f.Updates.open();
    assert.deepEqual(opened, [base + 'user.js', '_blank', 'noopener,noreferrer']);
    assert.equal(f.commands.length, 0); assert.equal(f.Hunt.running, false);
    updater(f, '1.2.34'); await f.Updates.check(); assert.equal(f.Updates.latest, null); assert.equal(f.UI.updateButton.hidden, true);
  });
  await check('an available update shows the headline of its patch notes as one line of plain text', async () => {
    const run = async (notes, ok = true) => {
      const f = fixture(), calls = [];
      f.UI.updateButton = {}; f.UI.updateNote = {};
      f.win.fetch = async url => {
        calls.push(url);
        if (url.includes('api.github.com')) return { ok: true, json: async () => ({ sha }) };
        if (url.endsWith('meta.js')) return { ok: true, text: async () => '// @version      9.9.9' + String.fromCharCode(10) };
        if (notes === null) throw Error('offline');
        return { ok, text: async () => notes };
      };
      await f.Updates.check(); return { f, calls };
    };
    const nl = String.fromCharCode(10);
    let { f, calls } = await run('# Faster looting' + nl + '- item' + nl);
    assert.equal(f.Updates.latest.title, 'Faster looting');
    assert.equal(f.UI.updateNote.hidden, false); assert.equal(f.UI.updateNote.textContent, 'Update 9.9.9 available: Faster looting');
    assert.match(f.UI.updateButton.title, /^9.9.9: Faster looting · Open Tampermonkey/);
    await f.Updates.check(); assert.equal(calls.filter(u => u.includes('/notes/')).length, 1, 'the headline is read once per version');
    const hostile = '# A' + String.fromCharCode(0, 27, 133) + 'B <img src=x onerror=alert(1)> ' + 'x'.repeat(300);
    ({ f } = await run(hostile));
    assert.equal(f.Updates.latest.title.length, 120); assert.ok(f.Updates.latest.title.startsWith('AB <img src=x'), 'control characters dropped, text kept as text');
    ({ f } = await run('# One' + String.fromCharCode(8232) + 'Two')); assert.equal(f.Updates.latest.title, 'One', 'a line separator ends the headline');
    for (const [notes, ok] of [['no title line', true], ['# Gone', false], [null, true]]) {
      ({ f } = await run(notes, ok));
      assert.equal(f.Updates.latest.version, '9.9.9', 'the update is still offered'); assert.equal(f.Updates.latest.title, '');
      assert.equal(f.UI.updateNote.hidden, true); assert.match(f.UI.updateButton.title, /^Open Tampermonkey/);
    }
  });
  await check('offline and invalid update responses never create an install link and release the check lock', async () => {
    for (const response of [null, { ok: false }, { ok: true, json: async () => ({ sha: '../evil' }) }]) {
      const f = fixture(); f.win.fetch = async () => { if (!response) throw Error('offline'); return response; };
      await f.Updates.check(); assert.equal(f.Updates.latest, null); assert.equal(f.Updates.busy, false);
      updater(f); await f.Updates.check(); assert.ok(f.Updates.latest);
      f.win.fetch = async () => { throw Error('offline'); }; await f.Updates.check(); assert.ok(f.Updates.latest);
    }
    const f = fixture(); updater(f, 'javascript:alert(1)'); await f.Updates.check(); assert.equal(f.Updates.latest, null);
  });
  await check('update checks do not overlap and startup schedules one fifteen-minute interval', async () => {
    const f = fixture(); let resolve, calls = 0;
    f.win.fetch = () => { calls++; return new Promise(r => { resolve = r; }); };
    const pending = f.Updates.check(); await f.Updates.check(); assert.equal(calls, 1);
    resolve({ ok: false }); await pending; assert.equal(f.Updates.busy, false);
    let checks = 0; f.Updates.check = async () => { checks++; };
    f.Updates.start(); f.Updates.start(); assert.equal(checks, 1); assert.equal(f.intervals.length, 1);
    assert.equal(f.intervals[0].ms, 900000); f.intervals[0].fn(); assert.equal(checks, 2);
  });
  await check('diagnostics copy only on request and offer selectable fallback when clipboard is blocked', async () => {
    const f = fixture(); let copied = '', fallback = '';
    f.win.navigator = { clipboard: { writeText: async text => { copied = text; } } };
    f.UI.showDiagnostics = text => { fallback = text; };
    assert.equal(copied, ''); await f.Diagnostics.copy(); assert.equal(JSON.parse(copied).app, 'nixxane bot');
    assert.match(f.notices.at(-1), /paste this into your bug report/); assert.equal(fallback, '');
    f.win.navigator.clipboard.writeText = async () => { throw Error('denied'); };
    await f.Diagnostics.copy(); assert.equal(JSON.parse(fallback).app, 'nixxane bot');
    assert.equal(f.commands.length, 0);
  });
  function reporting(f) {
    f.UI.showReport = () => {};
    f.UI.reportStatus = { textContent: '' };
    f.Reports.open();
    return f.Reports;
  }
  await check('report preview freezes redacted diagnostics and sends only on explicit request', async () => {
    const f = fixture(); let calls = [];
    f.World.gp.characterName = 'PRIVATE_NAME';
    f.win.fetch = async (...args) => { calls.push(args); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
    const r = reporting(f), original = r.text();
    assert.equal(calls.length, 0); assert.ok(!original.includes('PRIVATE_NAME'));
    f.World.gp.inventoryPending = true; f.Diagnostics.sample(); assert.equal(r.text(), original);
    r.describe('It stopped after alchemy.');
    const preview = r.text(); await r.send();
    assert.equal(calls.length, 1); const [url, options] = calls[0];
    assert.equal(url, 'https://nixbot.nixxane.workers.dev/report');
    assert.equal(options.body.get('report'), preview); assert.equal(options.body.get('screenshot'), null);
    assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer');
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(preview).description, 'It stopped after alchemy.');
    assert.equal(r.draft.sent, true); await r.send(); assert.equal(calls.length, 1);
    assert.equal(f.commands.length, 0); assert.equal(f.storage.size, 0);
    r.close(); assert.equal(r.draft, null);
  });
  await check('report uploads do not overlap or retry automatically and retain uncertain drafts', async () => {
    const f = fixture(), r = reporting(f); let reject, calls = 0;
    f.win.fetch = () => { calls++; return new Promise((_, no) => { reject = no; }); };
    const pending = r.send(); const before = r.text();
    await r.send(); r.describe('changed'); r.close(); assert.equal(r.text(), before);
    assert.equal(calls, 1); reject(Error('private error')); await pending;
    assert.equal(r.sending, false); assert.equal(r.draft.sent, false);
    assert.match(f.UI.reportStatus.textContent, /could not be confirmed/);
    assert.ok(!f.UI.reportStatus.textContent.includes('private error')); assert.equal(calls, 1);
    f.win.fetch = async (_, o) => { calls++; assert.equal(o.body.get('report'), before); return {ok:true,status:200,json:async()=>({ok:true})}; };
    await r.send(); assert.equal(calls, 2);
  });
  await check('report rate limits persist across preview closes and expire without automatic sending', async () => {
    for (const header of ['60', null, 'garbage']) {
      const f = fixture(), r = reporting(f); let calls = 0;
      f.win.fetch = async () => { calls++; return {status:429,headers:{get:()=>header}}; };
      await r.send(); assert.equal(r.cooldownUntil, 160000); r.close(); r.open();
      await r.send(); f.advance(59999); await r.send(); assert.equal(calls, 1);
      f.advance(1); assert.equal(calls, 1); await r.send(); assert.equal(calls, 2);
    }
  });
  await check('report timeout aborts once and validation/service failures never trigger retries', async () => {
    const f = fixture(), r = reporting(f); let signal, calls = 0;
    f.win.fetch = (_, options) => { calls++; signal = options.signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('timeout')))); };
    const pending = r.send(); const timeout = f.timers.find(t => t.ms === 20000); assert.ok(timeout); timeout.fn(); await pending;
    assert.equal(signal.aborted, true); assert.equal(calls, 1); assert.equal(r.sending, false);
    assert.match(f.UI.reportStatus.textContent, /could not be confirmed/);
    for (const status of [400, 413, 403, 503, 502]) {
      f.win.fetch = async () => ({status,ok:false}); await r.send();
      assert.equal(r.draft.sent, false); assert.equal(r.sending, false);
    }
    f.win.fetch = async () => ({status:200,ok:true,json:async()=>({ok:false})}); await r.send(); assert.equal(r.draft.sent, false);
    r.draft.base.large = 'x'.repeat(128 * 1024); f.win.fetch = () => { throw Error('must not upload'); };
    await r.send(); assert.match(f.UI.reportStatus.textContent, /too large/);
  });
  await check('screenshots require a click, stop every track, and send only the reviewed attachment', async () => {
    const f = fixture(), r = reporting(f); let selected = 0, stopped = 0, uploads = 0;
    const stream = {getTracks:()=>[{stop:()=>stopped++},{stop:()=>stopped++}]};
    f.win.navigator = { mediaDevices: { getDisplayMedia: async options => { selected++; assert.equal(options.audio,false); return stream; } } };
    r.frame = async () => new Blob(['test screenshot'],{type:'image/jpeg'});
    assert.equal(selected,0); await r.capture(); assert.equal(selected,1); assert.equal(stopped,2);
    assert.ok(r.draft.url.startsWith('blob:')); const image = r.draft.image;
    f.win.fetch = async (_, options) => { uploads++; const file=options.body.get('screenshot'); assert.equal(file.name,'screenshot.jpg'); assert.equal(await file.text(),await image.text()); return {ok:true,status:200,json:async()=>({ok:true})}; };
    assert.equal(uploads,0); await r.send(); assert.equal(uploads,1); assert.equal(r.draft.image,null); assert.equal(r.draft.url,'');
    assert.equal(f.commands.length,0);
  });
  await check('cancelled, failed, and closed screenshot captures cannot upload or leave a stream open', async () => {
    const f = fixture(), r = reporting(f); let stopped = 0, resolve;
    f.win.navigator = {mediaDevices:{getDisplayMedia:()=>new Promise(done=>{resolve=done;})}};
    r.frame = async () => { throw Error('capture broke'); };
    let pending = r.capture(); await r.capture(); r.close();
    resolve({getTracks:()=>[{stop:()=>stopped++}]}); await pending;
    assert.equal(stopped,1); assert.equal(r.draft,null); assert.equal(r.capturing,false);
    r.open(); f.win.navigator.mediaDevices.getDisplayMedia=async()=>({getTracks:()=>[{stop:()=>stopped++}]});
    await r.capture(); assert.equal(stopped,2); assert.equal(r.draft.image,null); assert.equal(r.capturing,false);
    f.win.navigator.mediaDevices.getDisplayMedia=async()=>{throw Error('denied');}; await r.capture();
    assert.match(f.UI.reportStatus.textContent,/Nothing was uploaded/);
    delete f.win.navigator.mediaDevices; await r.capture(); assert.match(f.UI.reportStatus.textContent,/unavailable/);
    r.describe('a'.repeat(2000)); assert.equal(r.draft.description.length,1000);
  });

  await check('session level data resolves delayed rollover totals without storage or uploads', async()=>{
    const f=sessionFixture();f.Stats.levels=null;f.win.location={origin:'https://opensro.online'};
    let resolve,requests=0;f.Icons.request=(path,op)=>{assert.equal(path,'/assets/data/levelData.json');assert.equal(op,'json');requests++;return new Promise(done=>resolve=done);};
    f.Stats.loadLevels();f.World.gp.progression={level:2,experience:'20',gold:'1000'};f.Stats.sample();
    assert.equal(requests,1);assert.equal(f.Stats.pendingXP.length,1);
    resolve({1:{expRequired:'118'}});await f.Stats.loading;
    assert.equal(f.Stats.session.xp,38n);assert.equal(f.Stats.pendingXP.length,0);assert.equal(f.Stats.display().xp,'38');
    assert.equal(f.storage.size,0);assert.equal(f.commands.length,0);
  });
  await Promise.all(asyncTests);
  console.log('Total integration tests: ' + passed);
}
require('./lean.session.test.cjs')({ test, fixture, townFixture });
require('./lean.logging.test.cjs')({ test, fixture, townFixture });
updateTests().catch(error => { console.error(error); process.exitCode = 1; });

function reloadFixture() {
  const { f, sent, lose, back } = reconnectFixture(); let reloads = 0, failure = '';
  f.Reconnect.doReload = () => { reloads++; };
  f.Reconnect.jitter = () => 0;
  f.Reconnect.loadFailure = () => failure;
  return { f, sent, lose, back, reloads: () => reloads, fail: text => { failure = text; } };
}
const stored = f => JSON.parse(f.storage.get('sro-lean-reload') || '{}');

test('a game that fails to load is reloaded after a wait, remembering the character and that hunting was on', () => {
  const r = reloadFixture(), f = r.f;
  f.Controller.tick(); assert.equal(stored(f).snap.character, 'Tester'); assert.equal(stored(f).snap.hunting, true);
  r.fail('Renderer failed: Error: Invalid particle graph time'); f.World.phase = 'failed'; f.World.gp = null;
  f.Controller.tick(); f.advance(10000); f.Controller.tick(); assert.equal(r.reloads(), 0, 'gives the game its own time first');
  f.advance(6000); f.Controller.tick(); assert.equal(r.reloads(), 1);
  assert.deepEqual({ ...stored(f).pending, at: 0 }, { character: 'Tester', hunting: true, at: 0 });
});

test('after the reload the character is entered again and hunting resumes', () => {
  const r = reloadFixture(), f = r.f;
  f.storage.set('sro-lean-reload', JSON.stringify({ pending: { character: 'Tester', hunting: true, at: Date.now() }, reloads: { count: 1, first: Date.now(), last: Date.now() } }));
  f.stopAll(); f.World.gp = null; f.World.phase = 'listing-servers'; r.sent.length = 0;
  f.Controller.tick(); assert.equal(f.Reconnect.active(), true); assert.match(f.Reconnect.message, /restore your login/);
  f.advance(4000); f.Controller.tick(); assert.equal(r.sent.length, 0, 'waits while the game restores the login');
  f.World.phase = 'character-select'; f.advance(4000); f.Controller.tick();
  assert.deepEqual(r.sent[0], { kind: 'enter-world', character: 'Tester' }, 'no resume attempt: the page is fresh');
  r.back(); f.advance(100); f.Controller.tick(); f.advance(3500); f.Controller.tick();
  assert.equal(f.Hunt.running, true); assert.equal(f.Reconnect.active(), false); assert.equal(stored(f).pending, null);
  assert.equal(stored(f).reloads, null, 'back in the game: the next reload waits the shortest time again');
});

test('a reload that is not wanted or not allowed never happens', () => {
  const r = reloadFixture(), f = r.f; r.fail('Renderer failed: x'); f.World.phase = 'failed'; f.World.gp = null;
  f.storage.set('sro-lean-reload', JSON.stringify({ reloads: { count: 9, first: Date.now() - 13 * 3600000, last: Date.now() - 60000 } }));
  f.Controller.tick(); f.advance(31 * 60000); f.Controller.tick(); f.advance(60000); f.Controller.tick();
  assert.equal(r.reloads(), 0, 'after 12 hours of reloads it stops'); assert.match(f.Reconnect.message, /over 12 hours without getting back in; not reloading again/);
  const g = reloadFixture(); g.f.storage.set('sro-lean-reload', JSON.stringify({ pending: { character: 'Tester', hunting: true, at: Date.now() - 3600000 } }));
  g.f.stopAll(); g.f.World.gp = null; g.f.World.phase = 'signed-out'; g.f.Controller.tick(); assert.equal(g.f.Reconnect.active(), false, 'a stale reload is not resumed');
  const h = reloadFixture(); h.f.storage.set('sro-lean-reload', JSON.stringify({ pending: { character: 'Tester', hunting: true, at: Date.now() } }));
  h.f.stopAll(); h.f.World.gp = null; h.f.World.phase = 'signed-out'; h.sent.length = 0; h.f.Controller.tick();
  h.f.Hook.observers.forEach(fn => fn({ kind: 'logout' })); assert.equal(h.f.Reconnect.active(), false, 'logging out cancels it');
  h.f.advance(70000); h.f.Controller.tick(); assert.equal(h.sent.length, 0);
});

test('an expired world session skips the futile resume, enters afresh, then reloads the page', () => {
  const r = reloadFixture(), f = r.f; r.sent.length = 0;
  r.lose(); f.World.session = { phase: 'disconnected', error: 'Server could not resume the previous world session', disconnectMessage: 'Your session ended while the connection was gone. Please log in again.' };
  f.advance(3000); f.Controller.tick();
  assert.deepEqual(r.sent[0], { kind: 'enter-world', character: 'Tester' }, 'no resume: it cannot work any more');
  f.advance(10000); f.Controller.tick(); assert.equal(r.reloads(), 0, 'the fresh entry gets its time');
  f.advance(25000); f.Controller.tick(); assert.equal(r.reloads(), 1);
  assert.equal(stored(f).pending.character, 'Tester');
  const g = reloadFixture(); g.lose(); g.f.World.session = { phase: 'disconnected', disconnectMessage: 'Your session ended while the connection was gone.' };
  g.f.storage.set('sro-lean-reload', JSON.stringify({ reloads: { count: 3, first: Date.now(), last: Date.now() } }));
  g.f.advance(3000); g.f.Controller.tick(); g.f.advance(40000); g.f.Controller.tick();
  assert.equal(g.reloads(), 0, 'the fourth reload in a row waits 8 times as long: 4 minutes'); assert.equal(g.f.Reconnect.gaveUp, false);
  g.f.advance(205000); g.f.Controller.tick(); assert.equal(g.reloads(), 1); assert.equal(stored(g.f).reloads.count, 4);
});

test('a plain "Disconnected from the server." that nothing recovers ends in a page reload, and reloads in a row wait longer, never stopping early', () => {
  const r = reloadFixture(), f = r.f; r.sent.length = 0;
  r.lose(); f.World.session = { phase: 'disconnected', disconnectMessage: '' };
  for (let i = 0; i < 40 && r.reloads() === 0; i++) { f.advance(10000); f.Controller.tick(); }
  assert.equal(r.reloads(), 1, 'stuck reconnecting: the page is reloaded to restore the login');
  assert.ok(r.sent.filter(c => c.kind === 'reconnect').length === 1, 'one resume attempt only');
  const g = reloadFixture(); g.lose(); g.f.World.session = { phase: 'disconnected', disconnectMessage: '' };
  g.f.storage.set('sro-lean-reload', JSON.stringify({ reloads: { count: 6, first: Date.now() - 3 * 3600000, last: Date.now() } }));
  for (let i = 0; i < 100; i++) { g.f.advance(10000); g.f.Controller.tick(); }
  assert.equal(g.reloads(), 0, 'the seventh reload in a row waits the longest: 30 minutes'); assert.equal(g.f.Reconnect.gaveUp, false);
  for (let i = 0; i < 200 && g.reloads() === 0; i++) { g.f.advance(10000); g.f.Controller.tick(); }
  assert.equal(g.reloads(), 1, 'a server down for hours is still retried, every 30 minutes');
});
test('reloads in a row wait twice as long each time, up to 30 minutes plus a small random delay, and start over once back in the game', () => {
  const r = reloadFixture(), f = r.f, streak = n => f.storage.set('sro-lean-reload', JSON.stringify(n ? { reloads: { count: n, first: Date.now(), last: Date.now() } } : {}));
  const waits = [];
  for (let n = 0; n < 9; n++) { streak(n); waits.push(f.Reconnect.reloadWait(15000)); }
  assert.deepEqual(waits, [15000, 30000, 60000, 120000, 240000, 480000, 960000, 1800000, 1800000]);
  f.Reconnect.jitter = () => 0.2; assert.equal(f.Reconnect.reloadWait(15000), 2160000, 'the random delay is at most a fifth more'); f.Reconnect.jitter = () => 0;
  streak(0); r.fail('Renderer failed: x'); f.World.phase = 'failed'; f.World.gp = null;
  f.Controller.tick(); f.advance(16000); f.Controller.tick(); assert.equal(r.reloads(), 1); assert.equal(stored(f).reloads.count, 1);
  f.Reconnect.failedAt = 0; f.Controller.tick(); f.advance(20000); f.Controller.tick();
  assert.equal(r.reloads(), 1, 'the second reload in a row waits 30 s'); assert.match(f.Reconnect.message, /reloading the page in 10 s/);
  f.advance(11000); f.Controller.tick(); assert.equal(r.reloads(), 2); assert.equal(stored(f).reloads.count, 2);
  r.fail(''); f.World.phase = 'world'; f.World.gp = { ...fixture().World.gp }; f.advance(6000); f.Controller.tick();
  assert.equal(stored(f).reloads, null, 'back in the game: the count starts over');
  assert.equal(f.Reconnect.waitText(45000), '45 s'); assert.equal(f.Reconnect.waitText(240000), '4 min');
});
test('buff swaps with a full bag still run when no shield has to come off, and say why when one does', () => {
  // Full bag, Bard set: a one-handed weapon swap without any shield change needs no free slot.
  let f = buffGearFixture(), gp = f.World.gp, home = JSON.stringify(f.BuffGear.setup());
  f.Settings.profile.macro.buffs = f.Settings.profile.macro.buffs.filter(b => b.group === 30);
  gp.inventory = gp.inventory.filter(i => i.slot !== 7 && i.slot !== 14); gp.inventorySlotCount = 13 + 2;
  home = JSON.stringify(f.BuffGear.setup()); assert.equal(f.World.freeBagSlots(), 0);
  assert.equal(f.BuffGear.tick(), true, f.BuffGear.waiting); f.drive();
  assert.equal(JSON.stringify(f.BuffGear.setup()), home); assert.equal(f.BuffGear.recovery, null);
  // Full bag with a shield on: it cannot come off, so the swap waits and says so.
  f = buffGearFixture(); f.World.gp.inventorySlotCount = 13 + 3;
  assert.equal(f.BuffGear.tick(), false); assert.match(f.BuffGear.waiting, /free bag slot to take off your shield/);
});

test('town buys the largest potion the merchant sells when X-Large is not offered', () => {
  const f = townFixture(), gp = f.World.gp;
  f.Town.tier = {}; f.Restock.cfg().hp.on = true;
  f.Town.begin(); f.Town.enter('buy'); gp.target = 61;
  gp.shop = { npc: 61, offers: [[101, '5', 2284], [102, '9', 2284], [103, '6', 4332], [104, '7', 4332]].map(([refObjId, price, typeFlags], slot) => ({ refObjId, slot, tab: 0, maxStack: 50, price, previews: [{ refObjId, typeFlags }] })) };
  f.Town.buy(); assert.equal(f.Town.trip?.supplies[0].refObjId, 102, f.Town.message); assert.equal(f.Town.supplies()[0].refObjId, 102);
  f.advance(1000); f.Town.buy(); assert.equal(f.commands.at(-1).kind, 'shop-buy'); assert.equal(f.commands.at(-1).slot, 1);
  f.Town.tier = {};
});
// ---- Auto stall ----
// Drives the stall session the way the game would: each command the bot sends changes World.gp.stall
// like the worker's own reducer does (stall-name → naming, stall-create → owner, stall-add → an offer,
// stall-open → open, stall-close → the state disappears again).
function stallFixture() {
  const f = fixture();
  const town = f.Town.towns[0], spot = town.services.storage;
  f.World.gp.pose = { regionId: spot.regionId, x: spot.x, y: 0, z: spot.z };
  f.Items.data.set(62, { name: 'Lucky Powder', code: 'ITEM_ETC_ARCHEMY_LUCKY_POWDER_08' });
  f.Items.data.set(63, { name: 'Element', code: 'ITEM_ETC_ARCHEMY_ELEMENT_08' });
  f.Stall.init();
  return f;
}
function stallBag(f) {
  f.World.gp.inventory.push({ slot: 13, refObjId: 62, quantity: 20, typeFlags: 0x156c, name: 'Lucky Powder', tooltip: { fields: { canSell: 1 } } });
  f.World.gp.inventory.push({ slot: 14, refObjId: 63, quantity: 4, typeFlags: 0x56c, name: 'Element', tooltip: { fields: { canSell: 1 } } });
}
// Applies the game's answer to the last command; refuse one add bagSlot by simply not answering it.
function stallRespond(f, { ignoreAdd = -1 } = {}) {
  const c = f.commands.at(-1), stall = f.World.gp.stall;
  if (!c || c.__done) return;
  c.__done = true;
  if (c.kind === 'stall-name') f.World.gp.stall = { phase: 'naming', namingSequence: 1, owner: 0, title: '', greeting: '', savedGreeting: '', open: false, mode: 0, networkRegistered: false, offers: [], visitors: [], network: { open: false, rows: [], pages: 0, page: 0, category: 0, buying: null } };
  else if (c.kind === 'stall-create') { stall.phase = 'owner'; stall.owner = f.World.gp.localGid; stall.title = c.title; }
  else if (c.kind === 'stall-add') { if (c.bagSlot !== ignoreAdd) stall.offers.push({ slot: c.slot, bagSlot: c.bagSlot, quantity: c.quantity, price: c.price, item: { refObjId: c.bagSlot === 13 ? 62 : 63, name: c.bagSlot === 13 ? 'Lucky Powder' : 'Element', quantity: c.quantity } }); }
  else if (c.kind === 'stall-open') stall.open = true;
  else if (c.kind === 'stall-close') f.World.gp.stall = undefined;
}
function stallDrive(f, ticks, options) {
  for (let i = 0; i < ticks && f.Stall.run; i++) { f.advance(400); f.Controller.tick(); stallRespond(f, options); }
}
test('the stall refuses to start outside town, while hunting, with nothing priced or with a stall already open', () => {
  const f = stallFixture(); stallBag(f);
  f.World.gp.pose = { regionId: 1, x: 100, y: 0, z: 100 };
  f.Stall.start(); assert.equal(f.Stall.run, null); assert.ok(f.notices.at(-1).includes('town'));
  const spot = f.Town.towns[0].services.storage;
  f.World.gp.pose = { regionId: spot.regionId, x: spot.x, y: 0, z: spot.z };
  f.Stall.start(); assert.equal(f.Stall.run, null); assert.ok(f.notices.at(-1).includes('priced'));
  f.Settings.profile.stall.prices = { 62: 150 };
  f.Hunt.running = true; f.Stall.start(); assert.equal(f.Stall.run, null); assert.ok(f.notices.at(-1).includes('hunting'));
  f.Hunt.running = false;
  f.World.gp.stall = { phase: 'owner', owner: 99, offers: [], visitors: [] };
  f.Stall.start(); assert.equal(f.Stall.run, null); assert.ok(f.notices.at(-1).includes('stall'));
  f.World.gp.stall = undefined;
  f.Stall.start(); assert.ok(f.Stall.run, 'clean state starts the session');
});
test('the stall names, creates, registers each priced stack at its price and opens for business', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.title = 'Powders';
  f.Settings.profile.stall.prices = { 62: 150, 63: 4000 };
  f.Stall.start();
  stallDrive(f, 40);
  assert.equal(f.Stall.run?.phase, 'selling', 'the session is selling; status: ' + f.Stall.message);
  assert.equal(f.World.gp.stall.open, true);
  assert.deepEqual(f.World.gp.stall.offers.map(o => [o.slot, o.bagSlot, o.quantity, o.price]), [[1, 13, 20, 150], [2, 14, 4, 4000]]);
  assert.deepEqual(f.commands.map(c => c.kind), ['stall-name', 'stall-create', 'stall-add', 'stall-add', 'stall-open']);
  assert.equal(f.Stall.message.includes('2 offers'), true, f.Stall.message);
});
test('a sale counts only when the offer disappears and gold rises; the stall then closes when empty', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150 };
  f.World.gp.progression.gold = '100000';
  f.Stall.start(); stallDrive(f, 30);
  assert.equal(f.Stall.run.phase, 'selling');
  // The offer vanishes but no gold arrives: not a confirmed sale.
  f.World.gp.stall.offers = [];
  f.advance(400); f.Controller.tick();
  assert.equal(f.Stall.run.sold, 0, 'no gold gain, no sale claim');
  assert.equal(f.Stall.run.phase, 'close', 'everything gone closes the stall');
  stallDrive(f, 10);
  assert.equal(f.World.gp.stall, undefined);
  assert.equal(f.Stall.run, null);
  assert.ok(f.Stall.message.includes('Sold 0'), f.Stall.message);
});
test('a confirmed sale is reported with its gold value', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150 };
  f.World.gp.progression.gold = '100000';
  f.Stall.start(); stallDrive(f, 30);
  f.World.gp.stall.offers = [];
  f.World.gp.progression.gold = '103000'; // 20 × 150
  f.advance(400); f.Controller.tick(); stallRespond(f);
  assert.equal(f.Stall.run.sold, 20);
  assert.equal(f.Stall.run.earned, 3000n);
  assert.ok(f.Stall.message.includes('Sold 20 × Lucky Powder'), f.Stall.message);
  stallDrive(f, 20);
  assert.equal(f.Stall.run, null);
  assert.ok(f.Stall.message.includes('Sold 20 items for 3,000 gold.'), f.Stall.message);
});
test('a sale whose gold arrives after the offer disappears still counts; an offer with no gold within 30 s does not', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150, 63: 4000 };
  f.World.gp.progression.gold = '100000';
  f.Stall.start(); stallDrive(f, 40);
  assert.equal(f.Stall.run.phase, 'selling');
  // The game reports the sold slot first and the gold on a later update.
  f.World.gp.stall.offers = f.World.gp.stall.offers.filter(o => o.bagSlot !== 13);
  f.advance(400); f.Controller.tick();
  assert.equal(f.Stall.run.sold, 0, 'no gold yet');
  f.World.gp.progression.gold = '103000';
  f.advance(400); f.Controller.tick();
  assert.equal(f.Stall.run.sold, 20, 'the gold a tick later confirms the sale');
  assert.equal(f.Stall.run.earned, 3000n);
  // An offer that vanishes and never brings gold is dropped after 30 s, not claimed by later gold.
  f.World.gp.stall.offers = [];
  f.Settings.profile.stall.closeWhenEmpty = false;
  for (let i = 0; i < 80; i++) { f.advance(400); f.Controller.tick(); }
  f.World.gp.progression.gold = '200000';
  f.advance(400); f.Controller.tick();
  assert.equal(f.Stall.run, null, 'a settings change still ends the session');
});
test('a potion or inventory refusal leaves the stall open; a refused offer skips only that item', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150, 63: 4000 };
  f.Stall.start();
  // The game refuses the first offer outright.
  for (let i = 0; i < 40 && f.Stall.run; i++) {
    f.advance(400); f.Controller.tick();
    const c = f.commands.at(-1);
    if (c?.kind === 'stall-add' && c.bagSlot === 13 && !c.__done) { c.__done = true; f.bus.emit('game-error', 'Item cannot be sold'); }
    else stallRespond(f);
  }
  assert.equal(f.Stall.run?.phase, 'selling', 'status: ' + f.Stall.message);
  assert.deepEqual(f.World.gp.stall.offers.map(o => o.bagSlot), [14], 'the other item is still offered');
  f.bus.emit('game-error', 'Inventory full: cannot use the potion');
  f.advance(400); f.Controller.tick();
  assert.equal(f.Stall.run?.phase, 'selling', 'a potion refusal is not the stall refusal');
  f.bus.emit('game-error', 'Stall operation refused');
  assert.equal(f.Stall.run, null, 'a stall refusal still stops it');
});
test('an unconfirmed stall-add is skipped and never resent; the rest of the stall still opens', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150, 63: 4000 };
  f.Stall.start();
  stallDrive(f, 100, { ignoreAdd: 13 });
  assert.equal(f.Stall.run?.phase, 'selling', 'status: ' + f.Stall.message);
  assert.equal(f.commands.filter(c => c.kind === 'stall-add' && c.bagSlot === 13).length, 1, 'the unanswered add is never resent');
  assert.deepEqual(f.World.gp.stall.offers.map(o => o.bagSlot), [14], 'only the answered item is offered');
});
test('stop all closes a stall this page opened', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150 };
  f.Stall.start(); stallDrive(f, 30);
  assert.equal(f.Stall.run.phase, 'selling');
  f.stopAll();
  assert.equal(f.Stall.run, null);
  assert.equal(f.commands.at(-1).kind, 'stall-close');
});
test('a world reset drops the stall session without sending anything', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150 };
  f.Stall.start(); stallDrive(f, 30);
  const sent = f.commands.length;
  f.bus.emit('reset');
  assert.equal(f.Stall.run, null);
  assert.equal(f.commands.length, sent, 'no close command after the world is gone');
});
test('a price change mid-session stops the stall instead of mixing old offers', () => {
  const f = stallFixture(); stallBag(f);
  f.Settings.profile.stall.prices = { 62: 150 };
  f.Stall.start(); stallDrive(f, 30);
  assert.equal(f.Stall.run.phase, 'selling');
  f.Settings.profile.stall.prices = { 62: 200 };
  f.advance(400); f.Controller.tick(); stallRespond(f);
  assert.equal(f.Stall.run, null);
  assert.equal(f.commands.at(-1).kind, 'stall-close');
});
