const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { chromium } = require(path.join(process.argv[2], 'playwright'));
const script = fs.readFileSync(__dirname + '/bot.lean.user.js', 'utf8');
const skin = JSON.parse(script.match(/const LEAN_SKIN = (\{[^\n]+\});/)[1]);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const images = ['ic_attack', 'ic_recovery', 'ic_autoget', 'ic_sit'].map((key, i) => {
  const raw = Buffer.from(skin[key].split(',')[1], 'base64'), compressed = zlib.gzipSync(raw);
  return { raw, compressed, path: `/assets/images/Media_extracted/icon/skill/test/skill${i}.png`, transport: `/assets/test-icons/skill${i}.png.gz` };
});
// The minimised window's icon (the game's own auto-attack action icon).
{ // Distinct bytes (trailing data after IEND), so the loader does not share it with skill0.
  const raw = Buffer.concat([images[0].raw, Buffer.from('orb')]);
  images.push({ raw, compressed: zlib.gzipSync(raw), path: '/assets/images/Media_extracted/icon/action/icon_cha_auto_attack.png', transport: '/assets/test-icons/orb.png.gz' });
}
// The Map page: the minimap tile under the test character (region 1 = 1x0), the map button and the minimap signs.
for (const name of ['icon/action/cos_cmd_inventory', 'icon/item/etc/mall_return_scroll', 'icon/item/etc/mall_warehouse_ticket', 'icon/item/etc/all_potion_03', 'icon/item/etc/mall_repair_hammer', 'icon/item/etc/mall_reverse_return_scroll', 'interface/minimap/mm_map_button', ...['character', 'party', 'otherplayer', 'monster', 'unique', 'npc', 'animal'].map(s => 'interface/minimap/mm_sign_' + s)]) {
  const raw = Buffer.concat([images[1].raw, Buffer.from('map-' + name)]);
  images.push({ raw, compressed: zlib.gzipSync(raw), path: `/assets/images/Media_extracted/${name}.png`, transport: `/assets/test-icons/${name.replace(/\//g, '-')}.png.gz` });
}
// The wide window's page icons (also the game's action icons), each with distinct bytes.
for (const name of ['autoget', 'recovery', 'alchemy', 'shop', 'helper', 'party', 'camp']) {
  const raw = Buffer.concat([images[0].raw, Buffer.from('nav-' + name)]);
  images.push({ raw, compressed: zlib.gzipSync(raw), path: `/assets/images/Media_extracted/icon/action/icon_cha_${name}.png`, transport: `/assets/test-icons/nav-${name}.png.gz` });
}
let offset = 0;
const manifest = { groups: [], assets: images.map((image, i) => {
  const row = { path: image.path, packPath: '/assets/test-icons/icons.pack', offset, length: image.raw.length, sha256: sha(image.raw), mime: 'image/png' };
  offset += image.raw.length;
  // The fourth image deliberately exercises the pack Range fallback.
  if (i !== 3) row.transport = { path: image.transport, sha256: sha(image.compressed) };
  return row;
}) };
const skillRow = Array(79).fill('0');
Object.assign(skillRow, { 0:'3404',1:'334',2:'13',3:'1',18:'skill\\test\\skill3.ddj',19:'SN_THUNDER',24:'0',78:'0' });
const jsonFixtures = {
  '/assets/data/levelData.json': {1:{expRequired:'118'},2:{expRequired:'470'}},
  '/assets/data/skillData.json': { rows:[skillRow.join('\t')] },
  '/assets/text/textdataname.en.json': { entries: { SN_THUNDER:'Thunderdragon force', SN_ITEM_CH_SWORD_09_A:'Test Sword', SN_ITEM_CH_SWORD_09_C_RARE_HONOR:'Honor Sword' } },
  '/assets/char/roster.json': { dress: { equipment: {
    10:{code:'ITEM_CH_SWORD_09_A',slot:6,bodies:{CH_M:{}}},11:{code:'ITEM_CH_SWORD_09_C_RARE_HONOR',slot:6,bodies:{CH_M:{}}},
    12:{code:'ITEM_CH_SWORD_09_A',slot:6,bodies:{CH_W:{}}}
  } }, models: { 123:{refObjId:123,codename:'CHAR_CH_MAN_TEST'} } },
  '/assets/data/missionPresentation.json': { itemsByRefObjId: {
    10:{codename:'ITEM_CH_SWORD_09_A',iconDdjPath:'icon/skill/test/skill0.ddj'},11:{codename:'ITEM_CH_SWORD_09_C_RARE_HONOR',iconDdjPath:'icon/skill/test/skill2.ddj'}
  } },
  '/assets/npc/manifest.json': { models:{} },
};
for (let n=0;n<55;n++) {
  const id=200+n,code='ITEM_MALL_AVATAR_M_PAID_'+n;
  jsonFixtures['/assets/char/roster.json'].dress.equipment[id]={code,avatarSlot:n%4,bodies:{CH_M:{}}};
  jsonFixtures['/assets/data/missionPresentation.json'].itemsByRefObjId[id]={codename:code,iconDdjPath:'icon/skill/test/skill0.ddj'};
  jsonFixtures['/assets/text/textdataname.en.json'].entries['SN_'+code]='Paid skin '+n;
}
const jsonAssets = Object.entries(jsonFixtures).map(([p, value], i) => {
  const raw = Buffer.from(JSON.stringify(value)), compressed = zlib.gzipSync(raw), transport = `/assets/test-data/${i}.json.gz`;
  manifest.assets.push({path:p,packPath:'/unused.pack',offset:0,length:raw.length,sha256:sha(raw),mime:'application/json',transport:{path:transport,sha256:sha(compressed)}});
  return {transport,compressed};
});
const header = Buffer.alloc(12); header.write('SROPACK1'); header.writeUInt32LE(2, 8);
const pack = Buffer.concat([header, Buffer.from('{}'), ...images.map(i => i.raw)]);
// Live-format minimap tile for region 1 (1x0): an 8x8 NTX1 DXT1 texture, all red (colour 0 = 0xF800, every selector 0),
// inside an SROPACK2 pack whose member is stored gzip-compressed.
const ntx = Buffer.alloc(20 + 4 * 8);
ntx.write('NTX1', 0); ntx.writeUInt32LE(8, 4); ntx.writeUInt32LE(8, 8); ntx.write('DXT1', 12); ntx.writeUInt32LE(1, 16);
for (let b = 0; b < 4; b++) { ntx.writeUInt16LE(0xf800, 20 + b * 8); ntx.writeUInt16LE(0x001f, 22 + b * 8); }
const ntxStored = zlib.gzipSync(ntx), header2 = Buffer.alloc(12); header2.write('SROPACK2'); header2.writeUInt32LE(2, 8);
const pack2 = Buffer.concat([header2, Buffer.from('{}'), ntxStored]);
manifest.assets.push({ path: '/assets/images/Media_extracted/minimap/1x0.texture', packPath: '/assets/test-icons/minimap.pack', offset: 0,
  length: ntx.length, sha256: sha(ntx), mime: 'application/octet-stream', stored: { length: ntxStored.length, encoding: 'gzip' } });
const server = http.createServer((req, res) => {
  if (req.url === '/assets/packs/manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(manifest)); return; }
  const image = [...images,...jsonAssets].find(i => i.transport === req.url);
  if (image) { res.setHeader('Content-Type', 'application/octet-stream'); res.end(image.compressed); return; }
  if (req.url === '/assets/test-icons/minimap.pack') {
    const range = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (range) { const a = Number(range[1]), b = Number(range[2]); res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${pack2.length}` }); res.end(pack2.subarray(a, b + 1)); }
    else res.end(pack2);
    return;
  }
  if (req.url === '/assets/test-icons/icons.pack') {
    const range = req.headers.range?.match(/bytes=(\d+)-(\d+)/);
    if (range) { const a = Number(range[1]), b = Number(range[2]); res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${pack.length}` }); res.end(pack.subarray(a, b + 1)); }
    else res.end(pack);
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><head><title>Lean bot UI test</title></head><body style="background:#0d1420;color:#77869b;font:18px system-ui;margin:28px"><h1>Bot interface test</h1><p>Simulated game state; no game server connected.</p></body></html>');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(__dirname + '/browser-test-profile', { recursive: true });
  const testProfile = fs.mkdtempSync(__dirname + '/browser-test-profile/run-');
  const browser = await chromium.launchPersistentContext(testProfile, { executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true, acceptDownloads: true, viewport: { width: 1200, height: 1000 } });
  try {
    const page = await browser.newPage();
    const updateSha = 'b'.repeat(40);
    await page.route('https://api.github.com/repos/nixxane/opensro-bot-lean/commits/main', route => route.fulfill({ json: { sha: updateSha } }));
    await page.route('https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + updateSha + '/bot.lean.meta.js', route => route.fulfill({ body: '// @version      9.0.0\n' }));
    await page.route('https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + updateSha + '/notes/9.0.0.md', route => route.fulfill({ body: '# Faster <b>looting</b>\n- item\n' }));
    const errors = [], assets = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/assets/')) assets.push(request.url()); });
    // The once-per-version patch notes open 5 s after a load, over whatever the test is doing; mark this version seen.
    // (Their selection and window are covered by the integration tests.)
    const version = script.match(/const VERSION = '([\d.]+)';/)[1];
    await page.addInitScript(v => localStorage.setItem('sroBotLean:v1:seenVersion', JSON.stringify(v)), version);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: script });
    await page.getByText(/^NIX 1\./).waitFor();
    const updateButton = page.getByRole('button', { name: 'Update 9.0.0', exact: true });
    await updateButton.waitFor();
    // The new version's headline is shown as text, so a player sees why to update before installing.
    await page.getByText('Update 9.0.0 available: Faster <b>looting</b>', { exact: true }).waitFor();
    assert.match(await updateButton.getAttribute('title'), /^9\.0\.0: Faster <b>looting<\/b> · Open Tampermonkey/);
    await page.evaluate(() => { window.open = (...args) => { window.updateOpened = args; }; });
    await updateButton.click();
    assert.deepEqual(await page.evaluate(() => window.updateOpened), ['https://raw.githubusercontent.com/nixxane/opensro-bot-lean/' + updateSha + '/bot.lean.user.js', '_blank', 'noopener,noreferrer']);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedDiagnostics = text; } } });
    });
    await page.evaluate(() => SROLean.diagnostics.copy());
    const reportCopy = JSON.parse(await page.evaluate(() => window.copiedDiagnostics));
    assert.equal(reportCopy.app, 'nixxane bot');
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('blocked'); }; });
    await page.evaluate(() => SROLean.diagnostics.copy());
    const reportField = page.getByRole('textbox', { name: 'Bug report diagnostics', exact: true });
    await reportField.waitFor();
    assert.equal(JSON.parse(await reportField.inputValue()).app, 'nixxane bot');
    assert.equal(await reportField.evaluate(node => node.readOnly && node.selectionEnd === node.value.length), true);
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    await page.evaluate(() => {
      const code = `onmessage = e => { if(e.data.kind === 'fixture') postMessage(e.data.message); else if(e.data.kind === 'session') postMessage({ kind: 'observed-command', command: e.data.command.command }); };`;
      window.testCommands = [];
      window.testSim = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { name: 'sro-simulation' });
      testSim.addEventListener('message', e => { if (e.data.kind === 'observed-command') testCommands.push(e.data.command); });
      testSim.postMessage({ kind: 'fixture', message: { kind: 'session', state: { phase: 'world', character: 'TestHero' } } });
      testSim.postMessage({ kind: 'fixture', message: { kind: 'world', batch: { events: [
        { kind: 'spawn', entity: { gid: 1, kind: 'local-player', refObjId:123, regionId: 1, x: 100, y: 0, z: 100, appearanceState: [0], movementMode: 0 } },
        { kind: 'gameplay', state: { localGid: 1, target: 0, targetPending: false, inventoryPending: false, pendingMoves: 0,
          pose: { regionId: 1, x: 100, y: 0, z: 100 }, progression: { gold: '5000', stats: { maxHp: 100, maxMp: 100 } },
          inventory: [{slot:6,refObjId:10,typeFlags:(2<<11)|(6<<7)|44,plus:0}], inventorySlotCount: 30, equipmentSlotCount: 13, skills: [5, 6, 7, 8, 9], vitals: [],
          skillCatalog: [
            { id: 5, group: 5, name: 'Test attack', icon: 'skill\\test\\skill0.ddj', level: 1, targetRequired: true, targets: 4, mp: 5, cooldownMs: 1000 },
            { id: 6, group: 6, name: 'Test buff', icon: 'skill\\test\\skill1.ddj', level: 1, targetRequired: false, mp: 5, cooldownMs: 1000 },
            { id: 7, group: 7, name: 'Second attack', icon: 'skill\\test\\skill2.ddj', level: 2, targetRequired: true, targets: 4, mp: 20, cooldownMs: 5000 },
            { id: 8, group: 8, name: 'Weapon imbue', icon: 'skill\\test\\skill3.ddj', level: 3, targetRequired: false, mp: 10, cooldownMs: 2000 },
            { id: 9, group: 9, name: 'Test heal', icon: 'skill\\test\\skill1.ddj', level: 1, targetRequired: true, targets: 1 | 16 | 32, mp: 8, cooldownMs: 1000 },
          ] } },
      ] } } });
    });
    await page.waitForFunction(() => window.SROLean?.world.inWorld());
    // A character that was never set up opens on the Setup page, whose checklist names what is missing and fixes the hunting spot in one click.
    await page.getByText('Ready to hunt?').waitFor();
    assert.match(await page.locator('#sro-bot-lean').evaluate(host => host.shadowRoot.querySelector('.sx-score').textContent), /\d of \d ready/);
    await page.getByRole('button', { name: 'Set here', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.center.x), 100);
    await page.getByText('Saved, roaming up to').waitFor();
    await page.getByRole('button', { name: 'Safe AFK', exact: true }).click();
    await page.getByText(/Safe AFK: \d+ settings? would change/).waitFor();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.playerAlert.enabled), false);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.playerAlert.enabled), true);
    await page.getByRole('button', { name: 'Undo last change', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.playerAlert.enabled), false);
    await page.getByRole('button', { name: 'Combat', exact: true }).click();
    await page.getByRole('button', { name: 'Hunt area', exact: true }).click();
    await page.getByRole('button', { name: 'Set hunting spot here', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.center.x), 100);
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: 'Add Test attack', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.macro.rotations.normal[0].id), 5);
    // A share code is compressed with the browser's own stream and opens again to the same settings, without the hunting spot.
    const shared = await page.evaluate(async () => {
      const share = SROLean.share, code = await share.encode(share.text(true)), profile = await share.parse(code);
      return { prefix: code.slice(0, 9), hasRotation: !!profile.macro.rotations.normal.length, hasSpot: JSON.stringify(profile).includes('regionId') };
    });
    assert.deepEqual(shared, { prefix: 'nixxane1:', hasRotation: true, hasSpot: false });
    await page.getByRole('button', { name: 'Add Second attack', exact: true }).click();
    await page.getByRole('button', { name: 'Move up Second attack', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => SROLean.settings.profile.macro.rotations.normal.map(s => s.id)), [7, 5]);
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.slot')].every(s => s.dataset.iconLoaded === 'true'));
    await page.getByRole('button', { name: 'Unselect Test attack', exact: true }).hover();
    assert.equal(await page.locator('.skill-tip').isVisible(), true);
    assert.match(await page.locator('.skill-tip').innerText(), /Test attack/);
    await page.getByLabel('Search attack skills', { exact: true }).fill('second');
    assert.equal(await page.getByRole('button', { name: 'Unselect Test attack', exact: true }).isVisible(), false);
    await page.getByLabel('Search attack skills', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Buffs & imbue', exact: true }).click();
    await page.getByRole('button', { name: 'Add Test buff', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.macro.buffs[0].id), 6);
    await page.getByRole('button', { name: 'Use imbue Weapon imbue', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.macro.imbue.id), 8);
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.slot')].every(s => s.dataset.iconLoaded === 'true'));

    // Save two actual equipped setups and assign buffs through the rendered UI.
    await page.getByLabel('New buff set name',{exact:true}).fill('Cleric');
    await page.getByRole('button',{name:'Save equipped buff set',exact:true}).click();
    await page.evaluate(()=>{const item=SROLean.world.gp.inventory.find(i=>i.slot===6);item.slot=13;SROLean.world.gp.inventory.push({...item,slot:6,refObjId:11});});
    await page.getByLabel('New buff set name',{exact:true}).fill('Bard');
    await page.getByRole('button',{name:'Save equipped buff set',exact:true}).click();
    assert.equal(await page.evaluate(()=>SROLean.settings.profile.macro.buffSets.length),2);
    await page.getByLabel('Swap weapons for buffs',{exact:true}).check();
    await page.getByLabel('Gear for Test buff',{exact:true}).selectOption('2');
    assert.equal(await page.evaluate(()=>SROLean.settings.profile.macro.buffs[0].gearSet),2);
    assert.equal(await page.evaluate(()=>SROLean.settings.profile.macro.buffSwap),true);
    await page.locator('.pane').screenshot({path:__dirname+'/lean-buff-gear-preview.png'});
    await page.getByRole('button',{name:'Remove Bard',exact:true}).click();
    assert.equal(await page.evaluate(()=>SROLean.settings.profile.macro.buffs[0].gearSet),0);
    await page.getByRole('button',{name:'Remove Cleric',exact:true}).click();
    await page.getByLabel('Swap weapons for buffs',{exact:true}).uncheck();
    await page.evaluate(()=>{SROLean.world.gp.inventory=SROLean.world.gp.inventory.filter(i=>i.refObjId!==11);SROLean.world.gp.inventory.find(i=>i.refObjId===10).slot=6;});
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    assert.equal(await page.getByLabel('Session',{exact:true}).textContent(),'Paused');
    await page.evaluate(()=>{
      window.statsOriginalProgression=SROLean.world.gp.progression;
      SROLean.world.gp.progression={...SROLean.world.gp.progression,level:1,experience:'100',gold:'5000'};
      SROLean.stats.reset();
    });
    await page.getByRole('button',{name:'Start / stop · F8',exact:true}).click();
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.evaluate(()=>{
      SROLean.stats.lastAt=performance.now()-60000;
      SROLean.world.applyGameplay({...SROLean.world.gp,progression:{...SROLean.world.gp.progression,experience:'150',gold:'4800'}});
      SROLean.stats.render();
    });
    assert.equal(await page.getByLabel('Session',{exact:true}).textContent(),'Tracking');
    assert.equal(await page.getByLabel('XP gained',{exact:true}).textContent(),'50');
    assert.equal(await page.getByLabel('Net gold',{exact:true}).textContent(),'-200');
    assert.match(await page.getByLabel('Hunting time',{exact:true}).textContent(),/^00:01:0\d$/);
    assert.match(await page.getByLabel('XP / hour',{exact:true}).textContent(),/^[\d,]+$/);
    await page.getByRole('group',{name:'Session stats',exact:true}).screenshot({path:__dirname+'/lean-session-stats-preview.png'});
    await page.getByRole('button',{name:'Reset session',exact:true}).click();
    assert.equal(await page.getByLabel('XP gained',{exact:true}).textContent(),'0');
    assert.equal(await page.getByLabel('Net gold',{exact:true}).textContent(),'0');
    await page.getByRole('button',{name:'Start / stop · F8',exact:true}).click();
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.evaluate(()=>{SROLean.world.gp.progression=window.statsOriginalProgression;SROLean.stats.reset();});
    assert.equal(await page.getByLabel('Session',{exact:true}).textContent(),'Paused');
    await page.getByRole('button', { name: 'Party', exact: true }).click();
    assert.equal(await page.getByLabel('Maximum res distance from hunt spot (m)', { exact: true }).inputValue(), '30');
    await page.getByLabel('Maximum res distance from hunt spot (m)', { exact: true }).fill('40');
    await page.getByLabel('Maximum res distance from hunt spot (m)', { exact: true }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.party.resRadius), 400);
    // The town cycle and its triggers live on the Town page; with the cycle on, Supplies hides walking-route restock.
    await page.getByRole('button', { name: 'Town', exact: true }).click();
    const townToggle = page.getByLabel('Use return scroll → town services → back to the hunting spot', { exact: true });
    assert.equal(await townToggle.isChecked(), false);
    await townToggle.check(); assert.equal(await page.evaluate(() => SROLean.town.cfg().enabled), true);
    await page.getByRole('button', { name: 'Supplies', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Record from merchant', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('Auto buy while hunting', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Town', exact: true }).click();
    await townToggle.uncheck();
    await page.getByRole('button', { name: 'Supplies', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Record from merchant', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Town', exact: true }).click();
    // The new triggers: broken weapon on by default, the others off with their own numbers.
    assert.equal(await page.getByLabel('Weapon is broken', { exact: true }).isChecked(), true);
    await page.getByLabel('Gear is worn', { exact: true }).check();
    await page.getByLabel('Gear durability below (%)', { exact: true }).fill('25');
    await page.getByLabel('Gear durability below (%)', { exact: true }).dispatchEvent('change');
    await page.getByLabel('No XP for a while', { exact: true }).check();
    await page.getByLabel('No XP for (minutes)', { exact: true }).fill('7');
    await page.getByLabel('No XP for (minutes)', { exact: true }).dispatchEvent('change');
    await page.getByLabel('On a timer', { exact: true }).check();
    await page.getByLabel('Every (minutes)', { exact: true }).fill('90');
    await page.getByLabel('Every (minutes)', { exact: true }).dispatchEvent('change');
    assert.deepEqual(await page.evaluate(() => { const c = SROLean.town.cfg(); return [c.broken, c.wear, c.noXp, c.every]; }),
      [true, { on: true, pct: 25 }, { on: true, minutes: 7, action: 'town' }, { on: true, minutes: 90 }]);
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.trip-flow .skill-icon[data-icon-loaded=true]').length === 5);
    assert.match(await page.locator('.trip-flow').innerText(), /Return scroll[\s\S]*Way back/);
    await page.locator('.pane').screenshot({ path: __dirname + '/lean-town-page.png' });
    for (const label of ['Gear is worn', 'No XP for a while', 'On a timer']) await page.getByLabel(label, { exact: true }).uncheck();
    const reviveToggle = page.getByLabel('Revive in town and go back to the hunting spot', { exact: true });
    assert.equal(await reviveToggle.isChecked(), true);
    await reviveToggle.uncheck(); assert.equal(await page.evaluate(() => SROLean.town.cfg().revive), false);
    await reviveToggle.check(); assert.equal(await page.evaluate(() => SROLean.town.cfg().revive), true);
    await page.getByRole('button', { name: 'Supplies', exact: true }).click();
    // The Item mall group has its own HP/MP refill boxes; these are the merchant restock ones.
    const restock = page.getByRole('group', { name: 'Potion restock' });
    assert.equal(await restock.getByLabel('HP refill to', { exact: true }).inputValue(), '100');
    assert.equal(await restock.getByLabel('MP refill to', { exact: true }).inputValue(), '300');
    await restock.getByLabel('MP refill to', { exact: true }).fill('1000');
    await restock.getByLabel('MP refill to', { exact: true }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.potion.restock.mp.target), 1000);
    await restock.getByLabel('MP refill to', { exact: true }).fill('300');
    await restock.getByLabel('MP refill to', { exact: true }).dispatchEvent('change');
    const pillToggle = page.getByLabel('Buy abnormal pills (best)', { exact: true });
    assert.equal(await pillToggle.isChecked(), false);
    await pillToggle.check();
    await page.getByLabel('Pills low stock ≤', { exact: true }).fill('15');
    await page.getByLabel('Pills low stock ≤', { exact: true }).dispatchEvent('change');
    await page.getByLabel('Pills refill to', { exact: true }).fill('100');
    await page.getByLabel('Pills refill to', { exact: true }).dispatchEvent('change');
    assert.deepEqual(await page.evaluate(() => {
      const c = SROLean.settings.profile.potion.restock.cure;
      return { on: c.on, low: c.low, target: c.target, refObjId: c.refObjId };
    }), { on: true, low: 15, target: 100, refObjId: 58 });
    await pillToggle.uncheck();
    await page.getByRole('button', { name: 'Town', exact: true }).click();
    const arrivalTolerance = page.getByLabel('Town arrival tolerance (m)', { exact: true });
    assert.equal(await arrivalTolerance.inputValue(), '50');
    await arrivalTolerance.fill('80'); await arrivalTolerance.dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.town.cfg().arrivalRadius), 800);
    await page.getByRole('button', { name: 'Save arrival point', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.town.cfg().arrival.x), 100);
    await page.getByLabel('Pet free slots ≤', { exact: true }).fill('2');
    await page.getByLabel('Pet free slots ≤', { exact: true }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.town.cfg().petFree), 2);
    await page.getByLabel('Keep in pet (names)', { exact: true }).fill('favorite, quest');
    await page.getByLabel('Keep in pet (names)', { exact: true }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.town.cfg().keep), 'favorite, quest');
    assert.equal(await page.getByLabel('Store pet: Elixirs', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Pet loot: store elixirs, and Star / Moon / Sun gear', { exact: false }).count(), 1);
    await page.getByRole('button', { name: 'Supplies', exact: true }).click();
    assert.equal(await page.getByLabel('Use beginner +100% speed scroll automatically', { exact: true }).isChecked(), false);
    await page.getByLabel('Use beginner +100% speed scroll automatically', { exact: true }).check();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.potion.speedScroll), true);
    await page.getByLabel('Use beginner +100% speed scroll automatically', { exact: true }).uncheck();
    // Party page: heal and buff the party, the live member list, then the party options that moved here from Settings.
    await page.getByRole('button', { name: 'Party', exact: true }).click();
    assert.equal(await page.getByLabel('Buff and heal party members', { exact: true }).isChecked(), false);
    await page.getByLabel('Buff and heal party members', { exact: true }).check();
    await page.getByLabel('Heal skill', { exact: true }).selectOption({ label: 'Test heal' });
    await page.getByLabel('Heal below (%)', { exact: true }).fill('70');
    await page.getByLabel('Heal below (%)', { exact: true }).dispatchEvent('change');
    await page.getByRole('button', { name: 'Add Test heal', exact: true }).click();
    await page.getByLabel('Only these members: Test heal', { exact: true }).fill('Mate');
    await page.getByLabel('Only these members: Test heal', { exact: true }).dispatchEvent('change');
    assert.deepEqual(await page.evaluate(() => JSON.parse(JSON.stringify(SROLean.settings.profile.party.support))), {
      enabled: true, whileStopped: false, range: 30, heal: { id: 9, group: 9, pct: 70, self: false }, group: { id: 0, group: 0, pct: 60, count: 2 },
      buffs: [{ id: 9, group: 9, only: 'Mate' }] });
    assert.equal(await page.getByText('Not in a party.', { exact: true }).isVisible(), true);
    await page.evaluate(() => {
      SROLean.world.gp.social = { localName: 'TestHero', self: 10, leader: 10, options: 1, members: [{ id: 10, name: 'TestHero', status: 0xaa }, { id: 11, name: 'Mate', level: 31, status: 0x76 }] };
      SROLean.world.ents.set(70, { gid: 70, kind: 'player', name: 'Mate', regionId: 1, x: 150, y: 0, z: 100, appearanceState: [0] });
    });
    await page.waitForFunction(() => /Mate[\s\S]*Lv 31/.test(document.getElementById('sro-bot-lean').shadowRoot.querySelector('.members').textContent));
    assert.equal(await page.locator('.member .pbar.hp i').evaluate(e => e.style.width), '60%', 'party HP from the status byte');
    assert.equal(await page.locator('.member-buffs .skill-icon.off').count(), 1, 'the assigned buff is shown as missing');
    await page.locator('.pane').screenshot({ path: __dirname + '/lean-party-page.png' });
    await page.evaluate(() => { SROLean.world.ents.delete(70); SROLean.world.gp.social = { members: [] }; SROLean.settings.profile.party.support.enabled = false; });
    assert.equal(await page.getByLabel('Auto-accept party-matching joins', { exact: true }).isChecked(), false);
    await page.getByLabel('Auto-accept party-matching joins', { exact: true }).check();
    await page.evaluate(() => {
      SROLean.world.simOffset = 0;
      testSim.postMessage({ kind: 'fixture', message: { kind: 'world', batch: { events: [{ kind: 'gameplay', state: {
        ...SROLean.world.gp,
        social: { self: 10, leader: 10, options: 1, members: [{ id: 10 }] },
        partyMatching: { own: { id: 5, type: 1 }, request: { a: 40, b: 50, expires: performance.now() + 10000, member: { name: 'TestApplicant' } } }
      } }] } } });
    });
    await page.waitForFunction(() => testCommands.some(c => c.kind === 'party-match-answer'));
    assert.deepEqual(await page.evaluate(() => testCommands.filter(c => c.kind === 'party-match-answer')), [{ kind: 'party-match-answer', a: 40, b: 50, answer: 1 }]);
    await page.getByLabel('Auto-accept party-matching joins', { exact: true }).uncheck();
    await page.evaluate(() => {
      SROLean.world.gp.partyMatching = { own: null, pending: null, request: null };
      SROLean.world.gp.social = { self: 0, leader: 0, options: 0, members: [] };
      SROLean.world.gp.progression.level = 30;
    });
    // Model the game's global keyboard handlers, including preventDefault on bound keys.
    await page.evaluate(() => {
      window.gameKeyEvents = [];
      window.gameKeyTrap = event => {
        window.gameKeyEvents.push(event.type + ':' + event.code);
        if (event.type === 'keydown' && /^[a-z0-9 ]$/i.test(event.key)) event.preventDefault();
      };
      for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, window.gameKeyTrap, true);
    });
    const partyTitle = page.getByLabel('Party listing title', { exact: true });
    await partyTitle.fill(''); await partyTitle.pressSequentially('Browser recruitment 123');
    assert.equal(await partyTitle.inputValue(), 'Browser recruitment 123');
    await partyTitle.press('Control+A'); await partyTitle.press('Backspace');
    await partyTitle.pressSequentially('Browser recruitment');
    await partyTitle.press('F8'); await partyTitle.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.gameKeyEvents), []);
    await partyTitle.press('Tab');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.party.title), 'Browser recruitment');
    await page.evaluate(() => {
      const outside = document.createElement('input'); outside.id = 'outside-input'; document.body.append(outside); outside.focus();
    });
    await page.keyboard.press('z');
    assert.equal(await page.evaluate(() => window.gameKeyEvents.includes('keydown:KeyZ')), true);
    await page.evaluate(() => {
      for (const type of ['keydown', 'keypress', 'keyup']) window.removeEventListener(type, window.gameKeyTrap, true);
      document.getElementById('outside-input').remove();
    });
    await page.getByLabel('Party listing title', { exact: true }).fill('Browser recruitment');
    await page.getByLabel('Party listing title', { exact: true }).dispatchEvent('change');
    await page.getByLabel('Auto-recruit', { exact: true }).check();
    await page.waitForFunction(() => testCommands.some(c => c.kind === 'party-match-register'));
    assert.deepEqual(await page.evaluate(() => testCommands.filter(c => c.kind === 'party-match-register')), [{ kind: 'party-match-register', registration: { party: 0, type: 3, purpose: 0, min: 1, max: 90, title: 'Browser recruitment' } }]);
    await page.getByLabel('Auto-recruit', { exact: true }).uncheck();
    await page.evaluate(() => { SROLean.world.gp.partyMatching = null; });
    for (const tab of ['Loot', 'Supplies', 'Party', 'Settings', 'Combat']) await page.getByRole('button', { name: tab, exact: true }).click();
    await page.getByRole('button', { name: 'Hunt area', exact: true }).click();
    await page.getByLabel('Hunt radius (m)', { exact: true }).fill('55');
    await page.getByLabel('Hunt radius (m)', { exact: true }).dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.radius), 550);
    await page.getByRole('button', { name: 'Start / stop · F8', exact: true }).click();
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    assert.equal(await page.evaluate(() => SROLean.hunt.running), true);
    await page.keyboard.press('F8');
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    assert.equal(await page.evaluate(() => SROLean.hunt.running), false);
    try { await page.waitForFunction(() => testCommands.some(c => c.kind === 'move'), { timeout: 3000 }); }
    catch (e) { console.error(await page.evaluate(() => ({ commands: testCommands, log: SROLean.log.lines.slice(-8), pose: SROLean.world.pose(), time: performance.now() }))); throw e; }
    await page.evaluate(() => { SROLean.world.gp.pose.x = 400; });
    await page.getByRole('button', { name: 'Return & hunt', exact: true }).click();
    await page.waitForFunction(() => window.SROLean.walkBack.active !== null);
    await page.getByRole('button', { name: 'Stop all', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.walkBack.active), null);
    await page.keyboard.press('F7');
    assert.equal(await page.getByRole('button', { name: 'Stop all', exact: true }).isVisible(), false);
    await page.keyboard.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), false);
    await page.keyboard.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Stop all', exact: true }).isVisible(), false);
    await page.keyboard.press('F7');
    await page.getByRole('button', { name: 'Start / stop · F8', exact: true }).click();
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.keyboard.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), false);
    assert.equal(await page.evaluate(() => SROLean.hunt.running), true);
    await page.keyboard.press('Shift+F7');
    await page.keyboard.press('F8');
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.getByLabel('Hunt radius (m)', { exact: true }).focus();
    await page.keyboard.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), true);
    await page.getByLabel('Hunt radius (m)', { exact: true }).evaluate(e => e.blur());
    // The × minimises to a small draggable icon; the bot keeps running and the icon shows its state.
    const orb = page.getByRole('button', { name: 'Show bot window', exact: true });
    await page.getByRole('button', { name: 'Minimise bot window', exact: true }).click();
    assert.equal(await orb.isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Stop all', exact: true }).isVisible(), false);
    assert.ok((await page.locator('#sro-bot-lean').boundingBox()).width <= 44);
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.orb img')?.complete);
    assert.equal(await orb.getAttribute('data-state'), 'stop');
    await page.keyboard.press('F8');
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.orb').dataset.state === 'ok');
    assert.equal(await page.evaluate(() => SROLean.hunt.running), true);
    await page.evaluate(() => SROLean.ui.toast('Out of HP potions.', 'warn'));
    assert.equal(await orb.evaluate(e => e.classList.contains('alert')), true);
    await orb.hover();
    assert.match(await orb.innerText(), /Out of HP potions/);
    await page.screenshot({ path: __dirname + '/lean-minimised-desktop.png' });
    const orbStart = await orb.boundingBox();
    await page.mouse.move(orbStart.x + 20, orbStart.y + 20); await page.mouse.down();
    await page.mouse.move(orbStart.x + 20 - 300, orbStart.y + 20 + 200, { steps: 6 }); await page.mouse.up();
    const orbEnd = await orb.boundingBox();
    assert.ok(Math.abs(orbEnd.x - (orbStart.x - 300)) < 3 && Math.abs(orbEnd.y - (orbStart.y + 200)) < 3);
    assert.equal(await orb.isVisible(), true, 'a drag does not reopen the window');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui'))), { minimised: true, orb: { x: Math.round(orbEnd.x), y: Math.round(orbEnd.y) } });
    await orb.click();
    assert.equal(await page.getByRole('button', { name: 'Stop all', exact: true }).isVisible(), true);
    assert.equal(await orb.isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).minimised), false);
    await page.getByRole('button', { name: 'Minimise bot window', exact: true }).click();
    assert.ok(Math.abs((await orb.boundingBox()).x - orbEnd.x) < 3, 'the icon returns to where it was dragged');
    await page.keyboard.press('Shift+F7');
    assert.equal(await page.locator('#sro-bot-lean').isVisible(), false);
    await page.keyboard.press('Shift+F7');
    assert.equal(await orb.isVisible(), true);
    await page.keyboard.press('F7');
    assert.equal(await page.getByRole('button', { name: 'Stop all', exact: true }).isVisible(), true);
    await page.keyboard.press('F8');
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    assert.equal(await page.evaluate(() => SROLean.hunt.running), false);
    // The panel's own spot is remembered too: drag it by the title, then a reload (re-mount) puts it back there.
    const title = page.locator('#sro-bot-lean header').first(), panelStart = await page.locator('#sro-bot-lean').boundingBox();
    const tb = await title.boundingBox();
    // Grab the empty end of the header row: the title's start is the clickable version number.
    const grab = tb.x + tb.width - 60;
    await page.mouse.move(grab, tb.y + 10); await page.mouse.down();
    await page.mouse.move(grab - 250, tb.y + 10 + 40, { steps: 6 }); await page.mouse.up();
    const panelMoved = await page.locator('#sro-bot-lean').boundingBox();
    assert.ok(Math.abs(panelMoved.x - (panelStart.x - 250)) < 3 && Math.abs(panelMoved.y - (panelStart.y + 40)) < 3);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).panel), { x: Math.round(panelMoved.x), y: Math.round(panelMoved.y) });
    await page.getByRole('button', { name: 'Minimise bot window', exact: true }).click();
    await orb.click();
    const panelBack = await page.locator('#sro-bot-lean').boundingBox();
    assert.ok(Math.abs(panelBack.x - panelMoved.x) < 3 && Math.abs(panelBack.y - panelMoved.y) < 3, 'restoring returns the panel to its spot');
    await page.evaluate(() => { const h = document.getElementById('sro-bot-lean'); h.style.left = h.style.top = h.style.right = ''; SROLean.ui.restorePanel(); });
    const panelReloaded = await page.locator('#sro-bot-lean').boundingBox();
    assert.ok(Math.abs(panelReloaded.x - panelMoved.x) < 3 && Math.abs(panelReloaded.y - panelMoved.y) < 3, 'a reload puts the panel back');
    await page.evaluate(() => { localStorage.setItem('sroLean:ui', JSON.stringify({ panel: { x: 99999, y: 99999 } })); SROLean.ui.restorePanel(); });
    const clamped = await page.locator('#sro-bot-lean').boundingBox();
    assert.ok(clamped.x + clamped.width <= 1201 && clamped.y >= 0 && clamped.x >= 0, 'an off-screen saved spot is pulled back on screen');
    await page.evaluate(() => localStorage.removeItem('sroLean:ui'));
    await page.evaluate(() => SROLean.ui.restorePanel());
    // Wide window: same pages, plus status strip, page icons, session sidebar and activity log; the choice is remembered.
    const host = page.locator('#sro-bot-lean');
    const compactWidth = (await host.boundingBox()).width;
    await page.getByRole('button', { name: 'Wide', exact: true }).click();
    assert.ok((await host.boundingBox()).width > 900, 'wide window is about 1000 px');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).wide), true);
    assert.equal(await page.getByLabel('Activity', { exact: true }).isVisible(), true);
    assert.equal(await page.locator('.status').isVisible(), false, 'the strip replaces the text status');
    // Wide pages are dealt into two stacks, so a short box never leaves a gap under it.
    await page.getByRole('button', { name: 'Party', exact: true }).click();
    const stacks = await page.evaluate(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.pane-cols > .pane-col')].map(c => ({ boxes: c.children.length, height: c.offsetHeight })));
    assert.equal(stacks.length, 2); assert.ok(stacks.every(s => s.boxes >= 1), 'both columns hold boxes');
    // The stacks are the most even split the box heights allow (one very tall box can leave an unavoidable difference).
    const boxHeights = await page.evaluate(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.pane-cols > .pane-col > *')].map(b => b.offsetHeight + 8));
    let bestDiff = Infinity;
    for (let mask = 0; mask < 1 << boxHeights.length; mask++) bestDiff = Math.min(bestDiff, Math.abs(boxHeights.reduce((d, h, i) => d + (mask & (1 << i) ? -h : h), 0)));
    assert.ok(Math.abs(stacks[0].height - stacks[1].height) <= bestDiff + 16, 'the two columns end as evenly as the boxes allow: ' + JSON.stringify(stacks));
    assert.equal(await page.locator('.strip strong').first().innerText(), await page.evaluate(() => SROLean.world.charName));
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('nav button')].every(b => b.dataset.iconLoaded === 'true'));
    assert.match(await page.getByLabel('Supplies: HP potions', { exact: true }).innerText(), /^[\d,]+$/);
    assert.match(await page.getByLabel('Session: Hunting time', { exact: true }).innerText(), /^\d\d:\d\d:\d\d$/);
    await page.evaluate(() => SROLean.log.info('Wide log line'));
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.log').textContent.includes('Wide log line'));
    // The same page switching and settings work in the wide window.
    await page.getByRole('button', { name: 'Loot', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Loot', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Start / stop · F8', exact: true }).click();
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.state').dataset.state === 'ok');
    assert.equal(await page.locator('.state strong').innerText(), 'Hunting');
    await page.screenshot({ path: __dirname + '/lean-wide-desktop.png' });
    await page.getByRole('button', { name: 'Combat', exact: true }).click();
    await page.screenshot({ path: __dirname + '/lean-wide-combat.png' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.screenshot({ path: __dirname + '/lean-wide-settings.png' });
    for (const name of ['Supplies', 'Alchemy', 'Wardrobe']) {
      await page.getByRole('button', { name, exact: true }).click();
      await page.screenshot({ path: __dirname + `/lean-wide-${name.toLowerCase()}.png` });
    }
    await page.keyboard.press('F8');
    await page.evaluate(() => { if (SROLean.ui.sessionBox) SROLean.ui.sessionBox.hidden = true; });
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.state').dataset.state === 'stop');
    // A narrow screen always gets the compact window, even with wide chosen.
    await page.setViewportSize({ width: 800, height: 1000 });
    assert.ok((await host.boundingBox()).width < 500);
    assert.equal(await page.getByLabel('Activity', { exact: true }).isVisible(), false);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    assert.equal(Math.round((await host.boundingBox()).width), Math.round(compactWidth));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).wide), false);
    // Classic window: an SBot-style frame and tab order; the same settings as the compact pages; remembered; compact on narrow screens.
    await page.getByRole('button', { name: 'Classic', exact: true }).click();
    assert.equal(Math.round((await host.boundingBox()).width), 840, 'the classic window is 840 px wide');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).classic), true);
    const classicTabs = await page.evaluate(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('nav button')].map(b => b.textContent));
    assert.deepEqual(classicTabs, ['Settings', 'Skills', 'Items/Storage', 'Training place', 'Party/Autores', 'Player buffing', 'Quest', 'Auto alchemy', 'Stall', 'Extra', 'Map', 'Auto trade', 'Wardrobe', 'Setup']);
    for (const name of ['Start / stop · F8', 'Return & hunt', 'Stop all', 'Start training', 'Stop training', 'Save settings', 'Hide client']) {
      assert.equal(await page.getByRole('button', { name, exact: true }).isVisible(), true, name + ' is in the classic frame');
    }
    assert.equal(await page.locator('.menubar').isVisible(), true);
    assert.equal(await page.locator('.status').isVisible(), false, 'the header status replaces the text status');
    assert.equal(await page.locator('.logbox').isVisible(), false);
    assert.equal(await page.getByLabel('Status: Hunting spot', { exact: true }).isVisible(), true);
    assert.match(await page.getByLabel('Session: Kills', { exact: true }).innerText(), /^[\d,]+$/);
    const frameBoxes = () => page.evaluate(() => ['.menubar', '.strip', '.controls', 'nav', '.pane', '.side'].map(selector => {
      const r = document.getElementById('sro-bot-lean').shadowRoot.querySelector(selector).getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }));
    const frameAtStart = await frameBoxes();
    for (const name of classicTabs) {
      await page.locator('nav').getByRole('button', { name, exact: true }).click();
      assert.equal(await page.locator('nav').getByRole('button', { name, exact: true }).getAttribute('aria-selected'), 'true');
      const text = await page.evaluate(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('.pane').innerText.trim());
      assert.ok(text.length > 20, 'the ' + name + ' tab has content');
      assert.deepEqual(await frameBoxes(), frameAtStart, 'the frame does not move on the ' + name + ' tab');
      if (['Settings', 'Skills', 'Training place', 'Party/Autores', 'Extra'].includes(name)) await page.screenshot({ path: __dirname + '/lean-classic-' + name.toLowerCase().replace(/[^a-z]+/g, '-') + '.png' });
    }
    // Headings use SBot's wording, and the pane scrolls on its own while the frame stays.
    await page.locator('nav').getByRole('button', { name: 'Settings', exact: true }).click();
    for (const heading of ['Autopotion settings', 'Buy settings', 'Back town settings', 'Pick settings', 'Attack preferences', 'Berserk settings']) {
      assert.equal(await page.locator('legend', { hasText: heading }).count() > 0, true, heading);
    }
    assert.ok(await page.evaluate(() => { const p = document.getElementById('sro-bot-lean').shadowRoot.querySelector('.pane'); p.scrollTop = 400; return p.scrollTop > 0 && p.scrollHeight > p.clientHeight; }), 'the pane scrolls');
    assert.deepEqual(await frameBoxes(), frameAtStart, 'scrolling the pane does not move the frame');
    // The pop-out windows follow the classic look too.
    await page.getByRole('button', { name: 'Session log', exact: true }).click();
    await page.screenshot({ path: __dirname + '/lean-classic-session.png' });
    await page.getByRole('button', { name: 'Close current session', exact: true }).click();
    await page.evaluate(() => { SROLean.ui.sessionBox?.remove(); SROLean.ui.sessionBox = null; });
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Patch notes', exact: true }).click();
    await page.screenshot({ path: __dirname + '/lean-classic-notes.png' });
    await page.getByRole('button', { name: 'Close patch notes', exact: true }).click();
    await page.evaluate(() => { SROLean.ui.notesBox?.remove(); SROLean.ui.notesBox = null; });
    // One source of truth: a setting changed in the classic window is the same setting in the compact pages.
    const hpBefore = await page.evaluate(() => SROLean.settings.profile.potion.hp.on);
    await page.getByLabel('Use HP', { exact: true }).setChecked(!hpBefore);
    assert.equal(await page.evaluate(() => SROLean.settings.profile.potion.hp.on), !hpBefore);
    // Menus open the existing dialogs and pages.
    await page.getByRole('button', { name: 'Lists', exact: true }).click();
    await page.getByRole('button', { name: 'Item rules', exact: true }).click();
    assert.equal(await page.locator('nav').getByRole('button', { name: 'Items/Storage', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.menu').count(), 0, 'a menu closes after a choice');
    // Remembered across a re-mount; a narrow screen always gets the compact window.
    await page.setViewportSize({ width: 800, height: 1000 });
    assert.ok((await host.boundingBox()).width < 500);
    assert.ok((await page.evaluate(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('nav button')].map(b => b.textContent))).includes('Combat'));
    await page.setViewportSize({ width: 1200, height: 1000 });
    assert.equal(Math.round((await host.boundingBox()).width), 840);
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    assert.equal(Math.round((await host.boundingBox()).width), Math.round(compactWidth));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroLean:ui')).classic), false);
    await page.getByRole('button', { name: 'Supplies', exact: true }).click();
    assert.equal(await page.getByLabel('Use HP', { exact: true }).isChecked(), !hpBefore, 'the compact page shows the setting changed in classic');
    await page.getByLabel('Use HP', { exact: true }).setChecked(hpBefore);
    // Items page: the catalogue with a rule per item, set by row buttons, the right-click menu and bulk buttons.
    await page.getByRole('button', { name: 'Items', exact: true }).click();
    const itemSummary = page.locator('.item-table').locator('xpath=..').locator('p.muted').first();
    await page.waitForFunction(() => /items shown/.test(document.getElementById('sro-bot-lean').shadowRoot.querySelector('.item-table')?.parentElement.textContent || ''));
    assert.match(await itemSummary.innerText(), /^57 items shown · 0 with a rule\.$/);
    await page.getByLabel('Find an item', { exact: true }).fill('test sword');
    assert.match(await itemSummary.innerText(), /^1 items shown/);
    await page.getByRole('button', { name: 'Store Test Sword', exact: true }).click();
    await page.getByRole('button', { name: 'Pick Test Sword', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => SROLean.settings.profile.items.rules[10]), { act: 'store', pick: 'yes' });
    assert.equal(await page.getByRole('button', { name: 'Store Test Sword', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.locator('.item-row[data-id="10"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Drop', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => SROLean.settings.profile.items.rules[10]), { act: 'drop' }, 'drop replaces pick: never picked up again');
    await page.getByLabel('Find an item', { exact: true }).fill('');
    await page.getByLabel('Item group', { exact: true }).selectOption('mall');
    assert.match(await itemSummary.innerText(), /^55 items shown/);
    const bulkSell = page.getByRole('button', { name: 'All shown: Sell', exact: true });
    await bulkSell.click(); assert.equal(await bulkSell.innerText(), 'Sell 55?', 'asks for a second click');
    assert.equal(await page.evaluate(() => Object.keys(SROLean.settings.profile.items.rules).length), 1);
    await bulkSell.click(); assert.equal(await page.evaluate(() => Object.keys(SROLean.settings.profile.items.rules).length), 56);
    await page.getByLabel('Item group', { exact: true }).selectOption('all');
    await page.getByLabel('Only items with a rule', { exact: true }).check();
    assert.match(await itemSummary.innerText(), /^56 items shown · 56 with a rule\.$/);
    await page.locator('.pane').screenshot({ path: __dirname + '/lean-items-page.png' });
    const bulkClear = page.getByRole('button', { name: 'All shown: Clear', exact: true });
    await bulkClear.click(); await bulkClear.click();
    assert.equal(await page.evaluate(() => Object.keys(SROLean.settings.profile.items.rules).length), 0);
    await page.getByLabel('Only items with a rule', { exact: true }).uncheck();
    // Map page: minimap tile, entities in view, marking a point and making it the hunting spot, zoom and follow.
    await page.evaluate(() => testSim.postMessage({ kind: 'fixture', message: { kind: 'world', batch: { events: [
      { kind: 'spawn', entity: { gid: 50, kind: 'monster', name: 'Map mob', regionId: 1, x: 260, y: 0, z: 160, appearanceState: [0], rarity: 0 } },
      { kind: 'spawn', entity: { gid: 51, kind: 'monster', name: 'Map unique', regionId: 1, x: 40, y: 0, z: 220, appearanceState: [0], rarity: 3 } },
      { kind: 'spawn', entity: { gid: 52, kind: 'player', name: 'Stranger', regionId: 1, x: 150, y: 0, z: 40, appearanceState: [0] } },
    ] } } }));
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const mapInfo = page.locator('.map-box p.muted').first();
    await page.waitForFunction(() => /In view: 2 monsters, 1 players/.test(document.getElementById('sro-bot-lean').shadowRoot.querySelector('.map-box p.muted').textContent));
    assert.match(await mapInfo.innerText(), /^You: X -?\d+ · Y -?\d+\. Hunting spot: \d+ m away/);
    // The tile under the character comes from the SROPACK2 pack (gzip-stored NTX1) and is painted: the canvas is red there.
    await page.waitForFunction(() => {
      const c = document.getElementById('sro-bot-lean').shadowRoot.querySelector('.map-stage canvas'), r = window.devicePixelRatio || 1;
      const [red, green] = c.getContext('2d').getImageData(Math.round((c.clientWidth / 2 + 30) * r), Math.round((c.clientHeight / 2 - 30) * r), 1, 1).data;
      return red > 150 && green < 100;
    });
    assert.ok(assets.some(u => u.endsWith('/assets/test-icons/minimap.pack')), 'the tile was read from the version 2 pack');
    await page.waitForFunction(() => document.getElementById('sro-bot-lean').shadowRoot.querySelector('nav button').dataset.iconLoaded === 'true');
    assert.equal(await page.getByRole('button', { name: 'Make this the hunting spot', exact: true }).isVisible(), false);
    const canvasBox = await page.getByLabel('Map of the hunting area', { exact: true }).boundingBox();
    const upp = await page.evaluate(() => SROLean.map.upp), pose = await page.evaluate(() => SROLean.world.pose());
    // 40 px right and 30 px up of the centre (the character) is 40 * upp units east and 30 * upp units north.
    await page.mouse.click(canvasBox.x + canvasBox.width / 2 + 40, canvasBox.y + canvasBox.height / 2 - 30);
    await page.getByRole('button', { name: 'Make this the hunting spot', exact: true }).click();
    const newCentre = await page.evaluate(() => SROLean.settings.profile.hunt.center);
    assert.equal(newCentre.regionId, 1);
    assert.ok(Math.abs(newCentre.x - (pose.x + 40 * upp)) <= upp && Math.abs(newCentre.z - (pose.z + 30 * upp)) <= upp, JSON.stringify(newCentre));
    assert.equal(await page.getByRole('button', { name: 'Make this the hunting spot', exact: true }).isVisible(), false);
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.ok(await page.evaluate(() => SROLean.map.upp) < upp);
    assert.equal(await page.getByRole('button', { name: 'Follow me', exact: true }).isDisabled(), true);
    await page.mouse.move(canvasBox.x + 100, canvasBox.y + 100); await page.mouse.down();
    await page.mouse.move(canvasBox.x + 160, canvasBox.y + 140, { steps: 4 }); await page.mouse.up();
    assert.equal(await page.evaluate(() => SROLean.map.follow), false, 'dragging the map stops following');
    assert.equal(await page.getByRole('button', { name: 'Make this the hunting spot', exact: true }).isVisible(), false, 'a drag does not mark a point');
    await page.getByRole('button', { name: 'Follow me', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.map.follow), true);
    await page.locator('.map-box').screenshot({ path: __dirname + '/lean-map-compact.png' });
    await page.getByRole('button', { name: 'Wide', exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: __dirname + '/lean-wide-map.png' });
    await page.getByRole('button', { name: 'Compact', exact: true }).click();
    await page.evaluate(() => testSim.postMessage({ kind: 'fixture', message: { kind: 'world', batch: { events: [50, 51, 52].map(gid => ({ kind: 'despawn', gid })) } } }));
    await page.evaluate(() => { SROLean.settings.profile.hunt.center = { regionId: 1, x: 100, y: 0, z: 100 }; SROLean.settings.saveProfile(); });
    await page.getByRole('button', { name: 'Combat', exact: true }).click();
    await page.getByRole('button', { name: 'Skills', exact: true }).click();
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.slot')].every(s => s.dataset.iconLoaded === 'true'));
    await page.screenshot({ path: __dirname + '/lean-skills-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Buffs & imbue', exact: true }).click();
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.slot')].every(s => s.dataset.iconLoaded === 'true'));
    await page.screenshot({ path: __dirname + '/lean-buffs-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Loot', exact: true }).click();
    await page.evaluate(() => {
      window.petChimeNotes = [];
      const original = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function (...args) {
        const oscillator = original.apply(this, args), start = oscillator.start;
        oscillator.start = function (...times) {
          window.petChimeNotes.push({ frequency: this.frequency.value, state: this.context.state });
          return start.apply(this, times);
        };
        return oscillator;
      };
    });
    assert.equal(await page.getByLabel('Chime when pet bag is full', { exact: true }).isChecked(), true);
    await page.getByRole('button', { name: 'Test pet chime', exact: true }).click();
    await page.waitForFunction(() => window.petChimeNotes.length === 3);
    assert.equal(await page.evaluate(() => window.petChimeNotes.every(n => n.state === 'running')), true);
    await page.getByLabel('Chime when pet bag is full', { exact: true }).uncheck();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.pickup.petFullSound), false);
    await page.getByLabel('Chime when pet bag is full', { exact: true }).check();
    await page.getByLabel('Default collector', { exact:true }).selectOption('pet');
    await page.getByRole('button', { name: 'Elixirs only', exact: true }).click();
    assert.equal(await page.getByLabel('Default collector', { exact:true }).inputValue(), 'pet');
    assert.equal(await page.getByLabel('Elixirs', { exact:true }).inputValue(), 'pet');
    assert.equal(await page.getByLabel('Gold', { exact:true }).inputValue(), 'off');
    await page.getByLabel('Potions and cure pills', { exact:true }).selectOption('character');
    assert.equal(await page.evaluate(() => JSON.stringify([SROLean.settings.profile.hunt.pickup.potions, SROLean.settings.profile.hunt.pickup.by.potions])), '[true,"character"]');
    await page.getByLabel('Potions and cure pills', { exact:true }).selectOption('off');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.hunt.pickup.potions), false);
    await page.getByLabel('Default collector', { exact:true }).selectOption('character');
    await page.getByLabel('Always include names',{exact:true}).fill('potion');
    await page.getByLabel('Always include names',{exact:true}).dispatchEvent('change');
    await page.getByRole('button',{name:'Elixirs only',exact:true}).click();
    assert.equal((await page.getByLabel('Elixirs',{exact:true}).inputValue()) !== 'off',true);
    for(const label of ['Gold','Potions and cure pills','Equipment','Lucky powders','Magic stones (stored in the warehouse)','Attribute stones (stored in the warehouse)','Other alchemy items','Other items']) assert.equal((await page.getByLabel(label,{exact:true}).inputValue()) !== 'off',false);
    assert.equal(await page.getByLabel('Always include names',{exact:true}).inputValue(),'');
    await page.getByRole('button',{name:'Elixirs + gold',exact:true}).click();
    assert.equal((await page.getByLabel('Gold',{exact:true}).inputValue()) !== 'off',true);
    await page.getByRole('button',{name:'All items',exact:true}).click();
    assert.equal((await page.getByLabel('Lucky powders',{exact:true}).inputValue()) !== 'off',true);
    await page.screenshot({ path: __dirname + '/lean-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => {
      const r = document.getElementById('sro-bot-lean').getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }), true);
    await page.screenshot({ path: __dirname + '/lean-mobile.png', fullPage: true });
    await page.evaluate(() => SROLean.diagnostics.copy());
    await page.getByRole('textbox', { name: 'Bug report diagnostics', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close report', exact: true }).click();
    assert.deepEqual(errors, []);
    assert.equal(assets.filter(url => url.includes('/assets/packs/manifest.json')).length, 1);
    for (const image of images.slice(0, 3)) assert.equal(assets.filter(url => url.endsWith(image.transport)).length, 1);
    assert.equal(assets.filter(url => url.endsWith('/assets/test-icons/icons.pack')).length, 2); // header + image bytes
    assert.equal(assets.some(url => /skillData|missionPresentation|roster|npc\/manifest/.test(url)), false);
    await page.setViewportSize({ width:1200,height:1000 });
    await page.evaluate(() => { SROLean.world.gp.skills.push(3404); });
    await page.getByRole('button', { name:'Combat',exact:true }).click();
    await page.getByRole('button', { name:'Buffs & imbue',exact:true }).click();
    await page.getByRole('button', { name:'Use imbue Thunderdragon force',exact:true }).click();
    assert.equal(await page.evaluate(() => SROLean.settings.profile.macro.imbue.id),3404);
    assert.match(await page.locator('fieldset').filter({has:page.locator('legend', {hasText:'Weapon imbue'})}).innerText(),/Lv 13/);
    // Redrawing the same view keeps the scroll position; switching view starts at the top.
    await page.evaluate(() => { const pane = document.querySelector('#sro-bot-lean').shadowRoot.querySelector('.pane'); pane.style.maxHeight = '150px'; pane.scrollTop = 90; });
    const paneTop = () => page.evaluate(() => document.querySelector('#sro-bot-lean').shadowRoot.querySelector('.pane').scrollTop);
    assert.ok(await paneTop() > 0);
    await page.getByRole('button', { name:'No imbue',exact:true }).click();
    assert.ok(await paneTop() > 0);
    await page.getByRole('button', { name:'Skills',exact:true }).click();
    assert.equal(await paneTop(), 0);
    await page.getByRole('button', {name:'Wardrobe',exact:true}).click();
    await page.getByRole('button', {name:'Wear Honor Sword',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Wear Test Sword',exact:true}).count(),1);
    await page.getByRole('button', {name:'Wear Honor Sword',exact:true}).click();
    await page.waitForFunction(() => SROLean.wardrobe.inv.some(it => it.refObjId === 11));
    assert.equal(await page.evaluate(() => SROLean.world.gp.inventory[0].refObjId),10);
    await page.getByLabel('Weapon / shield glow (+)',{exact:true}).fill('9');
    await page.getByLabel('Weapon / shield glow (+)',{exact:true}).dispatchEvent('change');
    await page.waitForFunction(() => SROLean.wardrobe.inv[0].plus === 9);
    await page.getByLabel('Outfit name',{exact:true}).fill('Honor glow');
    await page.getByRole('button',{name:'Save outfit',exact:true}).click();
    await page.getByRole('button',{name:'Real look',exact:true}).click();
    await page.waitForFunction(() => SROLean.wardrobe.inv[0].refObjId === 10);
    await page.getByLabel('Outfit',{exact:true}).selectOption('Honor glow');
    await page.getByRole('button',{name:'Wear outfit',exact:true}).click();
    await page.waitForFunction(() => SROLean.wardrobe.inv[0].refObjId === 11);
    await page.getByLabel('Search wardrobe',{exact:true}).fill('honor');
    assert.equal(await page.getByRole('button',{name:'Wear Test Sword',exact:true}).count(),0);
    await page.getByLabel('Search wardrobe',{exact:true}).fill('');
    await page.waitForFunction(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.wardrobe-item .slot')].every(s => s.dataset.iconLoaded === 'true'));
    assert.equal(await page.evaluate(() => [...document.getElementById('sro-bot-lean').shadowRoot.querySelectorAll('.wardrobe-item')].every(b => {const box=b.getBoundingClientRect(),icon=b.querySelector('img').getBoundingClientRect();return icon.left>=box.left&&icon.right<=box.right&&icon.top>=box.top&&icon.bottom<=box.bottom;})),true);
    await page.screenshot({path:__dirname+'/lean-wardrobe-desktop.png',fullPage:true});
    await page.getByRole('button',{name:'Avatars / paid skins',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:/^Wear Paid skin /}).count(),48);
    assert.equal(await page.getByLabel('Degree',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Next skins',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:/^Wear Paid skin /}).count(),7);
    await page.getByRole('button',{name:'Wear Paid skin 54',exact:true}).click();
    await page.waitForFunction(() => SROLean.wardrobe.av.some(a=>a.refObjId===254));
    assert.equal(await page.evaluate(() => SROLean.world.local().avatars?.length||0),0);
    assert.equal(await page.evaluate(() => SROLean.settings.profile.wardrobe.av[2].ref),254);
    await page.getByLabel('Appearance slot',{exact:true}).selectOption('a1');
    assert.equal(await page.getByRole('button',{name:/^Wear Paid skin /}).count(),14);
    await page.getByLabel('Search wardrobe',{exact:true}).fill('Paid skin 1');
    await page.getByRole('button',{name:'Wear Paid skin 1',exact:true}).click();
    await page.waitForFunction(() => SROLean.wardrobe.av.some(a=>a.refObjId===201));
    await page.getByRole('button',{name:'Avatars / paid skins',exact:true}).click();
    assert.equal(await page.getByLabel('Search wardrobe',{exact:true}).inputValue(),'');
    await page.screenshot({path:__dirname+'/lean-paid-skins-desktop.png',fullPage:true});
    await page.evaluate(() => {
      const base64 = n => btoa(String.fromCharCode(...new Uint8Array(n)));
      testSim.postMessage({kind:'session',command:{kind:'gameplay',command:{kind:'navigation',regionId:1,bundle:{regionId:1,complete:true,
        navmesh:{regionSize:1920,tileSize:20,tilesPerAxis:96,regions:[{dx:0,dz:0,cells:{count:1},blockedTiles:base64(9216),tileCellIds:base64(36864)}]},
        objects:[{x:0,y:0,z:0,yaw:0,mesh:{vertices:[200,0,0,200,0,300],edges:[0,1,0,65535,3,0]}}]}}}});
      testCommands.length=0;
    });
    await page.getByRole('button',{name:'Return & hunt',exact:true}).click();
    await page.waitForFunction(() => testCommands.some(c => c.kind==='move' && c.destination.z>100));
    await page.getByRole('button',{name:'Stop all',exact:true}).click();
    await page.evaluate(() => {
      const w = SROLean.world;
      w.applyGameplay({ ...w.gp, pendingMoves: 0, returnScroll: null, storage: null, shop: null,
        alchemy: { visible: true, pending: false, mode: 'reinforce', flags: 0, error: null, slot: null },
        inventory: [
          { slot: 13, refObjId: 10, typeFlags: 44 | (6 << 7), plus: 0, durability: 100, variance: '123', magic: [], quantity: 1, name: 'Test Sword', icon: 'skill/test/skill0.ddj', tooltip: { fields: { itemClass: 25 } } },
          { slot: 14, refObjId: 3679, typeFlags: 0x0d6c, quantity: 3, name: 'Weapon elixir' },
          { slot: 15, refObjId: 3691, typeFlags: 0x156c, quantity: 3, name: 'Lucky powder degree 9' }
        ] });
      testCommands.length = 0;
    });
    await page.getByRole('button', { name: 'Alchemy', exact: true }).click();
    await page.getByLabel('Item', { exact: true }).selectOption('13');
    await page.getByLabel('Target +', { exact: true }).fill('1');
    await page.getByLabel('Target +', { exact: true }).dispatchEvent('change');
    await page.getByLabel('Maximum attempts', { exact: true }).fill('2');
    await page.getByLabel('Maximum attempts', { exact: true }).dispatchEvent('change');
    await page.getByLabel('Use lucky powder of matching degree', { exact: true }).check();
    await page.getByRole('button', { name: 'Start alchemy', exact: true }).click();
    await page.waitForFunction(() => testCommands.some(c => c.kind === 'alchemy-start'));
    assert.deepEqual(await page.evaluate(() => testCommands.find(c => c.kind === 'alchemy-start')), { kind: 'alchemy-start', mode: 'reinforce', slots: [13, 14, 15] });
    await page.evaluate(() => {
      const w = SROLean.world, gp = w.gp;
      w.applyGameplay({ ...gp, inventory: gp.inventory.map(i => i.slot === 13 ? { ...i, plus: 1 } : { ...i, quantity: 2 }),
        alchemy: { visible: true, pending: false, mode: 'reinforce', flags: 0x10, error: null, slot: 13 } });
    });
    await page.getByText(/Target reached: \+1\./).first().waitFor();
    await page.waitForFunction(() => testCommands.some(c => c.kind === 'alchemy-close'));
    assert.equal(await page.evaluate(() => SROLean.alchemy.result.elixirs), 1);
    assert.equal(await page.evaluate(() => SROLean.alchemy.result.powders), 1);
    assert.equal(await page.evaluate(() => testCommands.filter(c => c.kind === 'alchemy-start').length), 1);
    await page.screenshot({ path: __dirname + '/lean-alchemy-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => { const r = document.querySelector('#sro-bot-lean').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), true);
    await page.screenshot({ path: __dirname + '/lean-alchemy-mobile.png', fullPage: true });

    // The session view is opened by an actual successful Start, and closing it leaves hunting enabled.
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => {
      SROLean.stop(); SROLean.ui.minimise(false); SROLean.ui.body.hidden = false;
      SROLean.settings.profile.hunt.stopInvFull = false;
      SROLean.settings.profile.hunt.stopNoHpPotion = false;
      SROLean.settings.profile.potion.restock.town.enabled = false;
      SROLean.ui.current = 'Supplies'; SROLean.ui.draw();
    });
    const delay = page.getByLabel('Potion delay (ms)', { exact: true });
    await delay.fill('1234'); await delay.dispatchEvent('change');
    assert.equal(await page.evaluate(() => SROLean.settings.profile.potion.delayMs), 1234);
    await delay.fill('-1'); await delay.dispatchEvent('change');
    assert.equal(await delay.inputValue(), '1234');
    await delay.fill('1.5'); await delay.dispatchEvent('change');
    assert.equal(await delay.inputValue(), '1234');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('sroBotLean:v1:' + SROLean.settings.profileKey)).potion.delayMs), 1234);
    await page.getByRole('button', { name: 'Start / stop · F8', exact: true }).click();
    const session = page.locator('.session-window');
    assert.equal(await page.evaluate(() => SROLean.hunt.running), true);
    assert.equal(await session.count(), 0, 'starting does not open the session window by itself');
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await session.waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: '▼ Show logs', exact: true }).getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: '▼ Show logs', exact: true }).click();
    const history = page.getByLabel('Session activity', { exact: true });
    await page.evaluate(() => { for (let i = 0; i < 450; i++) SROLean.log.info('Session line ' + i); SROLean.ui.updateSession(); });
    assert.equal(await history.locator('li').count(), 400);
    assert.equal(await history.evaluate(node => node.scrollHeight > node.clientHeight), true);
    await history.evaluate(node => { node.scrollTop = Math.floor(node.scrollHeight / 2); });
    const anchorBefore = await history.evaluate(node => {
      const row = [...node.children].find(row => row.offsetTop + row.offsetHeight >= node.scrollTop);
      return { text: row.textContent, offset: row.offsetTop - node.scrollTop };
    });
    await page.evaluate(() => { SROLean.log.info('new line while browsing'); SROLean.ui.updateSession(); });
    assert.equal(await history.evaluate((node, anchor) => {
      const row = [...node.children].find(row => row.textContent === anchor.text);
      return row && Math.abs(row.offsetTop - node.scrollTop - anchor.offset) <= 1;
    }, anchorBefore), true);
    await page.screenshot({ path: __dirname + '/lean-session-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await session.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391 && bounds.y >= 0 && bounds.y + bounds.height <= 845);
    await page.screenshot({ path: __dirname + '/lean-session-mobile.png' });
    await session.getByRole('button', { name: 'Close current session', exact: true }).click();
    assert.equal(await page.evaluate(() => SROLean.hunt.running), true);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settingsHistory = page.getByLabel('Settings activity', { exact: true });
    await page.evaluate(() => SROLean.ui.updateSession());
    assert.equal(await page.locator('.body > .waiting, .body > .feedback, .logbox').count(), 3, 'the status lines, the feedback line and the wide activity box stay on the main panel');
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    await session.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => {
      SROLean.ui.updateSession();
      return SROLean.ui.logs.textContent === SROLean.ui.sessionLog.textContent;
    }), true);
    assert.equal(await page.locator('.session-window').count(), 1);
    await page.keyboard.press('F8');
    assert.equal(await page.evaluate(() => SROLean.hunt.running), false);
    assert.equal(await session.isVisible(), true);
    await session.getByRole('button', { name: 'Close current session', exact: true }).click();
    // Pop out from Settings opens the window with the log expanded, and it stays when the panel is minimised.
    await page.getByRole('button', { name: 'Pop out session totals and log', exact: true }).click();
    await session.waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: '▲ Hide logs', exact: true }).getAttribute('aria-expanded'), 'true');
    await page.evaluate(() => SROLean.ui.minimise(true));
    assert.equal(await session.isVisible(), true, 'the popped-out window stays when the panel is minimised');
    await page.evaluate(() => SROLean.ui.minimise(false));
    await session.getByRole('button', { name: 'Close current session', exact: true }).click();
    await page.setViewportSize({ width: 1200, height: 1000 });
    const activityPanel = page.getByRole('group', { name: 'Recent activity', exact: true });
    const searchActivity = page.getByLabel('Settings log search', { exact: true });
    await searchActivity.fill('Session line 300');
    assert.equal(await settingsHistory.locator('li').count(), 1);
    await page.getByLabel('Settings log category', { exact: true }).selectOption('potion');
    assert.equal(await settingsHistory.locator('li').count(), 0);
    await searchActivity.fill('');
    await page.getByLabel('Settings log category', { exact: true }).selectOption('all');
    await page.getByLabel('Settings pause or resume log', { exact: true }).click();
    const pausedHistory = await settingsHistory.textContent();
    await page.evaluate(() => { SROLean.log.info('Pause test event'); SROLean.ui.updateSession(); });
    assert.equal(await settingsHistory.textContent(), pausedHistory);
    await page.getByLabel('Settings pause or resume log', { exact: true }).click();
    await settingsHistory.getByText(/Pause test event/).waitFor();
    await page.getByLabel('Settings detailed capture (10 minutes)', { exact: true }).check();
    await page.evaluate(() => { SROLean.log.command({ kind: 'move' }, 'SecretHero diagnostic command'); SROLean.ui.updateSession(); });
    await page.getByLabel('Settings log severity', { exact: true }).selectOption('cmd');
    assert.equal(await settingsHistory.locator('li').count(), 1);
    assert.match(await settingsHistory.innerText(), /Requesting movement\./);
    assert.doesNotMatch(await settingsHistory.innerText(), /SecretHero|\[cmd\]|requested:/);
    await activityPanel.getByRole('button', { name: 'Export preview', exact: true }).click();
    const activityPreview = page.getByLabel('Activity export preview', { exact: true });
    assert.doesNotMatch(await activityPreview.inputValue(), /SecretHero/);
    await page.getByLabel('Include raw local messages', { exact: true }).check();
    assert.match(await activityPreview.inputValue(), /SecretHero/);
    const downloadedActivity = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download preview', exact: true }).click();
    assert.equal((await downloadedActivity).suggestedFilename(), 'bot-activity.json');
    await page.getByRole('button', { name: 'Close activity export', exact: true }).click();
    await page.getByLabel('Settings detailed capture (10 minutes)', { exact: true }).uncheck();
    await page.getByLabel('Settings log severity', { exact: true }).selectOption('all');
    const totalsBeforeClear = await page.evaluate(() => JSON.stringify(SROLean.stats.display()));
    await activityPanel.getByRole('button', { name: 'Clear history', exact: true }).click();
    assert.ok(await settingsHistory.locator('li').count() > 0);
    await activityPanel.getByRole('button', { name: 'Confirm clear (5 s)', exact: true }).click();
    assert.equal(await settingsHistory.locator('li').count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(SROLean.stats.display())), totalsBeforeClear);
    // Copy from a shadow-DOM log must replace old clipboard contents even with game shortcuts present.
    await browser.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      delete navigator.clipboard;
      window.clipboardBeforeLogTest = await navigator.clipboard.readText();
      await navigator.clipboard.writeText('// ==UserScript== old clipboard');
      window.gameCopyKeys = 0;
      window.gameCopyHandler = event => {
        if (event.ctrlKey && event.code === 'KeyC') { window.gameCopyKeys++; event.preventDefault(); }
      };
      window.addEventListener('keydown', window.gameCopyHandler);
      SROLean.log.info('Copy this log sentence.'); SROLean.ui.updateSession();
      const log = SROLean.ui.logs, range = document.createRange();
      log.focus(); range.selectNodeContents(log.querySelector('li span'));
      const selection = SROLean.ui.root.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      SROLean.log.info('New activity while text is selected.'); SROLean.ui.updateSession();
      if (SROLean.ui.selectedActivityText() !== 'Copy this log sentence.') throw Error('Log refresh replaced selected text');
    });
    await page.keyboard.press('Control+c');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Copy this log sentence.');
    assert.equal(await page.evaluate(() => window.gameCopyKeys), 0);
    await page.evaluate(async () => {
      SROLean.ui.root.getSelection().removeAllRanges();
      window.removeEventListener('keydown', window.gameCopyHandler);
      await navigator.clipboard.writeText(window.clipboardBeforeLogTest);
      delete window.clipboardBeforeLogTest;
    });
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) SROLean.activity.refusal('Cast rejected: 5');
      SROLean.ui.updateSession();
    });
    const notReady = settingsHistory.locator('li').filter({ hasText: 'Skill not ready yet.' });
    assert.equal(await notReady.count(), 1);
    assert.equal(await notReady.locator('.activity-repeat').innerText(), '×5');
    assert.doesNotMatch(await notReady.innerText(), /Warning:|couldn’t complete the request/);
    await activityPanel.getByRole('button', { name: 'Export preview', exact: true }).click();
    const refusalExport = JSON.parse(await activityPreview.inputValue()).events.find(entry => entry.code === 'cast-not-ready');
    assert.equal(refusalExport.failure.source, 'cast');
    assert.match(refusalExport.failure.explanation, /cooling down.*recovering/);
    assert.equal(refusalExport.repeatCount, 5);
    await page.getByRole('button', { name: 'Close activity export', exact: true }).click();
    assert.deepEqual(errors,[]);
    // All reporting traffic is intercepted; capture uses a synthetic canvas, never the user's screen.
    await page.setViewportSize({width:1200,height:1000});
    let reportRequests = [], reportStatus = 200;
    await page.route('https://nixbot.nixxane.workers.dev/report', async route => {
      reportRequests.push(route.request().postDataBuffer().toString());
      await route.fulfill({status:reportStatus,headers:{'Access-Control-Allow-Origin':'*','Retry-After':'60','Access-Control-Expose-Headers':'Retry-After'},json:reportStatus===200?{ok:true}:{error:'rate limited'}});
    });
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    if (await page.locator('.patch-notes header .fold').isVisible()) await page.locator('.patch-notes header .fold').click();
    await page.getByRole('button',{name:'Send bug report',exact:true}).click();
    const preview = page.getByRole('textbox',{name:'Report preview',exact:true});
    await preview.waitFor(); assert.equal(reportRequests.length,0);
    // The report is its own floating window: fixed on screen, inside the viewport, draggable, closed from its header.
    const dialog = () => page.evaluate(() => { const root = document.querySelector('#sro-bot-lean').shadowRoot, d = root.querySelector('.report-preview'), r = d.getBoundingClientRect();
      return { fixed: getComputedStyle(d).position === 'fixed', hidden: d.hidden, left: r.left, top: r.top, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1, inPanel: !!root.querySelector('.panel .dialog, .body .dialog') }; });
    const before = await dialog(); assert.deepEqual([before.fixed, before.hidden, before.inside, before.inPanel], [true, false, true, false]);
    const titleBox = await page.locator('#sro-bot-lean').locator('css=.report-preview header').boundingBox();
    await page.mouse.move(titleBox.x + 60, titleBox.y + 15); await page.mouse.down(); await page.mouse.move(titleBox.x + 120, titleBox.y + 55, { steps: 4 }); await page.mouse.up();
    const moved = await dialog(); assert.ok(moved.left > before.left + 30 && moved.top > before.top + 20);
    await page.getByRole('button',{name:'Close bug report',exact:true}).click();
    assert.equal((await dialog()).hidden, true);
    await page.getByRole('button',{name:'Send bug report',exact:true}).click();
    assert.equal((await dialog()).hidden, false); await preview.waitFor();
    assert.equal(JSON.parse(await preview.inputValue()).app,'nixxane bot');
    await page.getByRole('textbox',{name:'What happened? (optional)',exact:true}).fill('Movement stopped after alchemy.');
    assert.equal(JSON.parse(await preview.inputValue()).description,'Movement stopped after alchemy.');
    await page.evaluate(() => {
      const canvas=document.createElement('canvas'); canvas.width=3000;canvas.height=1600;
      const ctx=canvas.getContext('2d');
      const paint=()=>{ctx.fillStyle='#15304b';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='white';ctx.font='60px sans-serif';ctx.fillText('Synthetic screenshot preview',80,180);}; paint();
      window.reportCaptureCalls=0;
      Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getDisplayMedia:async options=>{
        if(options.audio!==false) throw Error('audio must be off');
        reportCaptureCalls++; window.reportTestStream=canvas.captureStream(10);
        window.reportPaintTimer=setInterval(paint,30); return reportTestStream;
      }}});
    });
    assert.equal(await page.evaluate(()=>reportCaptureCalls),0);
    await page.getByRole('button',{name:'Add screenshot (optional)',exact:true}).click();
    const imagePreview=page.getByAltText('Screenshot preview',{exact:true}); await imagePreview.waitFor();
    await page.waitForFunction(()=>SROLean.reports.capturing===false);
    assert.equal(await page.evaluate(()=>reportTestStream.getTracks().every(t=>t.readyState==='ended')),true);
    await page.evaluate(()=>clearInterval(reportPaintTimer));
    assert.equal(await imagePreview.evaluate(img=>img.naturalWidth),1280);
    assert.equal(reportRequests.length,0);
    await page.screenshot({path:__dirname+'/lean-report-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>{const r=document.querySelector('#sro-bot-lean').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),true);
    await page.getByRole('button',{name:'Send to developer',exact:true}).scrollIntoViewIfNeeded();
    const sendBounds=await page.getByRole('button',{name:'Send to developer',exact:true}).boundingBox();
    assert.ok(sendBounds.x>=0&&sendBounds.x+sendBounds.width<=390&&sendBounds.y+sendBounds.height<=844);
    await page.screenshot({path:__dirname+'/lean-report-mobile.png',fullPage:true});
    // The once-per-version patch notes open 5 s after a load and, being newer, sit above the report; close them.
    const notesClose = page.locator('.patch-notes header .fold');
    if (await notesClose.isVisible()) await notesClose.click();
    await page.getByRole('button',{name:'Remove screenshot',exact:true}).click(); await imagePreview.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Send to developer',exact:true}).click();
    await page.getByText('Report sent to the developer’s Discord. Thank you.',{exact:true}).waitFor();
    assert.equal(reportRequests.length,1); assert.ok(!reportRequests[0].includes('name="screenshot"'));
    assert.ok(reportRequests[0].includes('Movement stopped after alchemy.'));
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await preview.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Send bug report',exact:true}).click();
    // Capture again to exercise the actual browser-generated JPEG multipart upload.
    await page.getByRole('button',{name:'Add screenshot (optional)',exact:true}).click();
    await imagePreview.waitFor(); await page.waitForFunction(()=>!SROLean.reports.capturing);
    await page.evaluate(()=>clearInterval(reportPaintTimer));
    assert.equal(await page.evaluate(()=>reportTestStream.getTracks().every(t=>t.readyState==='ended')),true);
    await page.getByRole('button',{name:'Send to developer',exact:true}).click();
    await page.getByText('Report sent to the developer’s Discord. Thank you.',{exact:true}).waitFor();
    assert.equal(reportRequests.length,2); assert.ok(reportRequests[1].includes('name="screenshot"; filename="screenshot.jpg"'));
    assert.ok(reportRequests[1].includes('Content-Type: image/jpeg'));
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Send bug report',exact:true}).click(); reportStatus=429;
    await page.getByRole('button',{name:'Send to developer',exact:true}).click();
    await page.getByText('Too many reports. Wait before trying again.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/^Wait \d+s$/}).isDisabled(),true); assert.equal(reportRequests.length,3);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.getByRole('button',{name:'Send bug report',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:/^Wait \d+s$/}).isDisabled(),true);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    assert.deepEqual(errors,[]);
    console.log('PASS browser boot, collision routing, skills and missing Thunderdragon metadata; wardrobe honor and paid avatar skins, all-slot browsing, pagination, slot mapping, search, glow, presets and real-inventory isolation; controls and desktop/mobile bounds; manual reports, synthetic screenshot preview/cleanup/upload and rate limits; zero page errors.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
