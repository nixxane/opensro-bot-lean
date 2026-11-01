"""Build the bot-only userscript from reviewed core code and small lean modules."""
from pathlib import Path
import re
import runpy
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from english_only import english_only, leftovers

base = Path(__file__).resolve().parent
runpy.run_path(str(base / 'build-wardrobe.py'))
original_path = base / 'vendor' / 'bot.js'
if not original_path.exists():
    original_path = base / 'bot.js'
original = original_path.read_text(encoding='utf-8-sig')

def section(start, end):
    assert original.count(start) == 1, start
    return original[original.index(start):original.index(end, original.index(start))].rstrip()

utils = section('const now =', '// ---------------------------------------------------------------------------\n// Settings:')
utils = utils.replace("prefix: 'sroAsistan:v7:'", "prefix: 'sroBotLean:v1:'")
geometry = section('const SECTOR =', '// ---------------------------------------------------------------------------\n// Worker hook.')
hook = section('const Hook =', '// ---------------------------------------------------------------------------\n// Display rewriters:')
# The game's asset worker builds any region's collision; route checks ask it for regions ahead (lean-route-check.js).
assert hook.count("  simUrl: '',\n") == 1 and hook.count("        if (name === 'sro-simulation') {\n") == 1
hook = hook.replace("  simUrl: '',\n", "  simUrl: '',\n  assetUrl: '',\n")
hook = hook.replace("        if (name === 'sro-simulation') {\n", "        if (name === 'sro-assets') Hook.assetUrl = String(url);\n        if (name === 'sro-simulation') {\n")
# Wardrobe rewrites only renderer copies; the mirror retains real items.
hook = hook.replace("          if (!(Hook.probe.passSelect && inner && inner.kind === 'select')) return undefined;", "          return undefined;")
world = section('const TRANSIENT_PHASES =', '// ---------------------------------------------------------------------------\n// Probe:')
display = section('const Display =', '// ---------------------------------------------------------------------------\n// World mirror:')
commands = section('const MIN_GAP =', '// ---------------------------------------------------------------------------\n// Assets.')
# Remove chat, GM actions, and companion item targeting from the compact command layer.
a = commands.index('  // opts (optional):')
b = commands.index('  action(id)', a)
commands = commands[:a] + '''  itemUse(slot) {
    const gp = World.gp;
    const item = gp?.inventory?.find(i => i.slot === slot);
    if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget(item.typeFlags)) return false;
    return this.raw({ kind: 'item-use', slot }, 'Use: ' + (item.name || item.refObjId));
  },

''' + commands[b:]
a = commands.index('  // The game update removed')
b = commands.index('  rebirth(choice)', a)
commands = commands[:a] + commands[b:]
commands = commands.replace("  chat: 1200,\n  'gm-command': 600,\n", '')
commands = commands.replace('    Log.cmd(text);', '    Log.command(command, text);')
commands = commands.replace('return now() - (this.last[kind] || 0) >= gap;', 'return now() - (this.last[kind] ?? -Infinity) >= gap;')
# A corpse-targeted row (DeadBody bit 128) may press on a dead target: the worker
# replaces the press gid with the selection intent the caster just set.
commands = commands.replace('if (!e || !World.isAlive(e)) return false;', 'if (!e || !World.isAlive(e) && !(info?.targets & 128)) return false;')
ticker = section('const Ticker =', '// ---- Potion ')
potion = section('const Potion =', '// Same rule as the client').replace("Stats.count('potions');", 'Stats.potion(item);')
combat = section('const Combat =', '// ---- Assist:')
combat = combat.replace('return Assets.skillMeta.get(id) || null;', 'return World.skill(id) || null;')
combat = combat.replace('return !m || !m.mp || m.mp <= me.mp;', 'return !m || (m.mp ?? 0) + Math.trunc(me.maxMp * (m.mpPercent ?? 0) / 100) <= me.mp;')
# Cleric blessings (Holy Spell, Body Blessing...) need a target but accept the caster: keep them up on yourself.
buff_old = "      if (info && info.targetRequired) continue;\n"
assert combat.count(buff_old) == 1
combat = combat.replace(buff_old, "      if (info && info.targetRequired && !(info.targets & 1)) continue;\n")
buff_cast_old = "      if (this.cast(id, 0)) {\n        this.buffCastAt.set(b.group, now());"
assert combat.count(buff_cast_old) == 1
combat = combat.replace(buff_cast_old, "      if (this.cast(id, info?.targetRequired ? World.localGid() : 0)) {\n        this.buffCastAt.set(b.group, now());")
# A normal attack replaces skills silently in the original loop. Record why each rotation skill was
# skipped so the panel and bug reports can say so, and stop false "silent rejection" blocks: a skill is only
# judged rejected after a newer game snapshot arrived and the cooldown still did not start.
fight_old = """      for (const entry of this.rotation(cls)) {
        const id = this.resolve(entry);
        if (!id || this.blocked(id) || !Cmd.canCast(id) || !this.mpOk(id, me)) continue;
        if (M.imbueBeforeAttack && this.imbue()) return;
        if (this.cast(id, target.gid)) return;
      }
    }"""
fight_new = """      for (const entry of this.rotation(cls)) {
        const id = this.resolve(entry);
        const why = !id ? 'unlearned' : this.blocked(id) ? 'blocked' : !Cmd.canCast(id) ? 'cooldown' : !this.mpOk(id, me) ? 'mp' : '';
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        if (M.imbueBeforeAttack && this.imbue()) return;
        if (this.cast(id, target.gid)) return;
        skipped.refused = (skipped.refused || 0) + 1;
      }
    } else skipped.lowMp = 1;"""
assert fight_old in combat
combat = combat.replace(fight_old, fight_new)
combat = combat.replace("    const lowMp = M.minMpPct && me.mpPct < M.minMpPct;\n", "    const lowMp = M.minMpPct && me.mpPct < M.minMpPct;\n    const skipped = {};\n", 1)
attack_old = "      if (Cmd.attack(target.gid)) this.lastAttackAt = now();"
assert attack_old in combat
combat = combat.replace(attack_old, """      if (M.imbueBeforeAttack && this.imbue()) return;
      if (Cmd.attack(target.gid)) {
        this.lastAttackAt = now();
        this.noteFallback(skipped, this.rotation(cls).length);
      }""")
silent_old = "    if (id === this.lastCastId && now() - this.lastCastAt < 1500 && World.cooldownLeft(id) <= 0 && !World.isCasting()) {"
assert silent_old in combat
combat = combat.replace(silent_old, "    if (id === this.lastCastId && now() - this.lastCastAt < 1500 && now() - this.lastCastAt > 700 && gid === this.lastCastGid && this.rejectionReady(id, gid) && World.gp !== this.lastCastState && World.cooldownLeft(id) <= 0 && !World.isCasting()) {")
send_old = "    this.lastCastId = id;\n    this.lastCastAt = now();"
assert send_old in combat
combat = combat.replace(send_old, "    this.lastCastId = id;\n    this.lastCastAt = now();\n    this.lastCastState = World.gp;\n    this.lastCastGid = gid;")
# Attack failures belong to the selected entity. A skill send also asks the
# native client to approach; no cooldown while outside reach is not a rejection.
combat = combat.replace("  blocked(id) {", """  failureKey(id, gid = 0) {
    return gid ? `${id}:${gid}` : id;
  },

  rejectionReady(id, gid) {
    if (!gid) return true;
    const skill = World.skill(id), target = World.ents.get(gid);
    return !!target && skill?.range > 0 && dist2D(World.pose(), target) <= skill.range &&
      World.gp.target === gid && !World.gp.targetPending && !World.gp.inventoryPending && !World.gp.pendingMoves;
  },

  blocked(id) {""")
combat = combat.replace("    const s = this.stuck.get(id);", """    const global = this.stuck.get(id);
    if (global && now() < global.until) return true;
    const s = this.stuck.get(this.failureKey(id, World.gp?.target));""", 1)
combat = combat.replace("  fail(id) {", "  fail(id, gid = id === this.lastCastId ? this.lastCastGid : 0) {")
combat = combat.replace("    const s = this.stuck.get(id) || { n: 0, until: 0 };", "    const key = this.failureKey(id, gid);\n    const s = this.stuck.get(key) || { n: 0, until: 0 };")
combat = combat.replace("    this.stuck.set(id, s);", "    this.stuck.set(this.failureKey(id, gid), s);")
combat = combat.replace("      const s = this.stuck.get(id) || { n: 0, until: 0, miss: 0 };", "      const s = this.stuck.get(this.failureKey(id, gid)) || { n: 0, until: 0, miss: 0 };")
combat = combat.replace("      if (c.caster === World.localGid()) this.stuck.delete(c.skill);", """      if (c.caster !== World.localGid()) return;
      this.stuck.delete(c.skill);
      for (const gid of [c.target, ...(c.results || []).map(r => r.target)]) {
        if (gid) this.stuck.delete(this.failureKey(c.skill, gid));
      }""")
combat = combat.replace("    this.lastCastId = id;", """    while (this.stuck.size > 256) this.stuck.delete(this.stuck.keys().next().value);
    this.lastCastId = id;""")
helper_old = "  // One step of fighting the given monster."
assert helper_old in combat
combat = combat.replace(helper_old, """  // Why the last normal attack replaced a skill (counts only: no names), for the panel and bug reports.
  fallback: null,
  noteFallback(skipped, size) {
    this.fallback = { at: now(), skipped: { ...skipped }, size };
    if (now() - (this.fallbackLogAt || 0) > 30000) {
      this.fallbackLogAt = now();
      Log.warn('Normal attack used instead of skills: ' + this.fallbackNote(true));
    }
  },
  fallbackNote(any = false) {
    const f = this.fallback;
    if (!f || !any && now() - f.at > 8000) return '';
    const names = { unlearned: 'not learned', blocked: 'paused after a server rejection', cooldown: 'cooling down', mp: 'not enough MP', refused: 'not sent', lowMp: 'MP below the minimum' };
    const parts = Object.entries(f.skipped).map(([k, n]) => (k === 'lowMp' ? '' : n + ' ') + names[k]);
    return f.size ? parts.join(', ') || 'no usable rotation skill' : 'no skills in the rotation for this monster class';
  },

""" + helper_old)
attackable = section('const isAttackableMob =', '// Automatic potion shopping.')
hunt = section('const Hunt =', '// Independent return command:') if '// Independent return command:' in original else section('const Hunt =', '// Independent return command using')
hunt = hunt.replace('    Assets.skills(this.knownSkillIds());', '')
hunt = hunt[:hunt.index('  lootAllowed(e) {')] + hunt[hunt.index('  playerCheck() {'):]
hunt = hunt[:hunt.index('  tick() {')] + hunt[hunt.index('  currentTarget() {'):]
hunt = hunt.replace("    this.state = 'start';", "    Loot.reset();\n    this.state = 'start';")
hunt = hunt.replace('    this.running = false;', '    Loot.suspend();\n    this.running = false;')
hunt = hunt.replace('if (Restock.trip && World.inWorld() && !World.isDead()) Cmd.move(World.pose());', 'if (World.inWorld() && !World.isDead()) Cmd.move(World.pose());')
restock = (base / 'restock.js').read_text(encoding='utf-8').split('  build() {')[0] + '};'
restock = restock.replace("    if (distance < t.best - 3) { t.best = distance; t.progressAt = now(); }", "    if (!t.lastPose || dist2D(t.lastPose, World.pose()) > 3) { t.lastPose = { ...World.pose() }; t.progressAt = now(); }")
restock = restock.replace("    if (World.isSitting()) {", "    const move = Navigation.next(t, dest, true);\n    if (move.error && !move.waiting) return this.fail(move.error);\n    if (move.waiting) return false;\n    if (World.isSitting()) {")
restock = restock.replace('Cmd.move(dest)', 'Cmd.move(move.point)')
walkback = (base / 'lean-walkback.js').read_text(encoding='utf-8')
# Keep only the original image-pack reader, not its skill/item/wardrobe catalogues.
icon_loader = section('function assetLoaderMain(self)', '\nconst Assets = {')
icon_loader = icon_loader[:icon_loader.index('  // ---- skillData.json')]
icon_loader = icon_loader.replace("const OWN_CACHE = 'sro-asistan-assets-v1';", "const OWN_CACHE = 'sro-lean-icons-v1';")
# The live game publishes SROPACK2 packs: same header layout as SROPACK1, but a member may be stored
# gzip-compressed (asset.stored = { length, encoding: 'gzip' }): it occupies stored.length bytes at its
# offset and decodes to asset.length bytes, which the loader then checks against the SHA-256 as before.
def loader_patch(old, new):
    global icon_loader
    assert icon_loader.count(old) == 1, old
    icon_loader = icon_loader.replace(old, new)
loader_patch("if (magic !== 'SROPACK1') throw", "if (magic !== 'SROPACK1' && magic !== 'SROPACK2') throw")
loader_patch("""        const start = 12 + len + asset.offset;
        if (start + asset.length <= pack.length) {
          const b = pack.slice(start, start + asset.length);""",
"""        const start = 12 + len + asset.offset, span = asset.stored ? asset.stored.length : asset.length;
        if (start + span <= pack.length) {
          let b = pack.slice(start, start + span);
          if (asset.stored) b = await gunzip(b);""")
loader_patch("""    const raw = await fetchBytes(asset.packPath, { range: [start, start + asset.length - 1], timeout: 45000 });
    stats.range++;
    return raw;""",
"""    const span = asset.stored ? asset.stored.length : asset.length;
    const raw = await fetchBytes(asset.packPath, { range: [start, start + span - 1], timeout: 45000 });
    stats.range++;
    if (!asset.stored) return raw;
    if (asset.stored.encoding !== 'gzip') throw fail('format', 'unknown pack member encoding: ' + asset.path);
    return gunzip(raw);""")
icon_loader += '''  self.onmessage = async e => {
    const msg = e.data || {};
    if (msg.op === 'init') { ORIGIN = String(msg.origin || ''); self.postMessage({ ready: true }); return; }
    try {
      const allowed = ['/assets/data/levelData.json', '/assets/data/cosPresentation.json', '/assets/data/skillData.json', '/assets/text/textdataname.en.json', '/assets/data/missionPresentation.json', '/assets/char/roster.json', '/assets/npc/manifest.json'];
      if (msg.op !== 'blob' && !(msg.op === 'json' && allowed.includes(msg.path))) throw fail('op', 'Unsupported asset request');
      const { bytes, mime } = await bytesOf(msg.path);
      const result = msg.op === 'json' ? JSON.parse(new TextDecoder().decode(bytes)) : new Blob([bytes], { type: mime || 'image/png' });
      self.postMessage({ id: msg.id, ok: true, result });
    } catch (e) { self.postMessage({ id: msg.id, ok: false, error: e.message, code: e.code }); }
  };
}'''
skin_source = section('const SKIN = {', '\nconst SKIN_SIZE =')
skin = __import__('json').loads(skin_source[len('const SKIN = '):].rstrip(';'))
skin_keys = ['f_lu','f_mu','f_ru','f_ls','f_rs','f_ld','f_md','f_rd',
             'ib_lu','ib_mu','ib_ru','ib_ls','ib_rs','ib_ld','ib_md','ib_rd',
             'tile_a','btn','btn_f','btn_p','btn_d','tab_on','tab_off','stab_on','stab_off',
             'chk_on','chk_off','scr_bar','scr_btn','scr_btn_f','close','close_f',
             'bar','bar_l','bar_r','bars','bars_l','bars_r','tw_normal','tw_champion',
             'tw_giant','tw_party','tw_elite','tw_unique','ic_attack','ic_recovery','ic_sit','ic_autoget']
skin = 'const LEAN_SKIN = ' + __import__('json').dumps({k: skin[k] for k in skin_keys}, separators=(',', ':')) + ';'
skin += '\nconst LEAN_CSS = ' + __import__('json').dumps((base / 'lean-skin.css').read_text(encoding='utf-8')) + ';'
header = '''// ==UserScript==
// @name         nixxane bot
// @namespace    https://opensro.online/
// @version      1.2.193
// @updateURL    https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.meta.js
// @downloadURL  https://raw.githubusercontent.com/nixxane/opensro-bot-lean/main/bot.lean.user.js
// @description  Combat, reliable looting, potions, restocking and walk-back in one compact panel.
// @author       Adapted from TSK's OpenSRO Assistant
// @license      GPL-2.0-or-later
// @match        https://opensro.online/play*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @noframes
// ==/UserScript==

(function () {
'use strict';
const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (W.__SRO_ASISTAN__ || W.__SRO_LEAN__) {
  console.warn('[NIX] Another SRO assistant is active. Disable it and reload to use NIX.');
  return;
}
const VERSION = '1.2.193';
const APP = { version: VERSION };
Object.defineProperty(W, '__SRO_LEAN__', { value: APP });
Object.defineProperty(W, '__SRO_ASISTAN__', { value: APP });
const T = (tr, en) => en ?? tr;
'''
# Patch notes shown in the game after an update: notes/<version>.md, a "# title" line, "- " items, optional "> " note.
def release_notes():
    import re, json
    version = re.search(r"const VERSION = '([\d.]+)';", header).group(1)
    key = lambda v: tuple(int(x) for x in v.split('.'))
    releases = []
    for path in (base / 'notes').glob('*.md'):
        assert re.fullmatch(r'\d+\.\d+\.\d+', path.stem), 'notes file name is not a version: ' + path.name
        lines = [line.rstrip() for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
        assert lines and lines[0].startswith('# '), path.name + ' must start with "# title"'
        items = [line[2:] for line in lines[1:] if line.startswith('- ')]
        note = [line[2:] for line in lines[1:] if line.startswith('> ')]
        assert items and len(items) + len(note) == len(lines) - 1, path.name + ': every line after the title starts with "- " or "> "'
        releases.append({'version': path.stem, 'title': lines[0][2:], 'items': items, **({'note': ' '.join(note)} if note else {})})
    releases.sort(key=lambda r: key(r['version']), reverse=True)
    assert releases and releases[0]['version'] == version, 'write notes/' + version + '.md before building'
    return 'const RELEASE_NOTES = ' + json.dumps(releases[:8], ensure_ascii=False) + ';'
parts = [header, utils, (base / 'lean-settings.js').read_text(encoding='utf-8'), geometry,
         hook, display, world, commands, ticker, potion, attackable, combat, restock, hunt,
         (base / 'lean-clipper.js').read_text(encoding='utf-8'),
         (base / 'lean-clip-route.js').read_text(encoding='utf-8'),
         (base / 'lean-navigation.js').read_text(encoding='utf-8'),
         (base / 'lean-pursuit-navigation.js').read_text(encoding='utf-8'),
         (base / 'lean-navdata-index.js').read_text(encoding='utf-8'),
         (base / 'lean-route.js').read_text(encoding='utf-8'),
         (base / 'lean-route-check.js').read_text(encoding='utf-8'), walkback,
         (base / 'lean-loot.js').read_text(encoding='utf-8'),
         (base / 'lean-stats.js').read_text(encoding='utf-8'),
         (base / 'lean-party.js').read_text(encoding='utf-8'),
         (base / 'lean-resurrect.js').read_text(encoding='utf-8'),
         (base / 'lean-speed-scroll.js').read_text(encoding='utf-8'),
         (base / 'lean-repair-hammer.js').read_text(encoding='utf-8'),
         (base / 'lean-scrolls.js').read_text(encoding='utf-8'),
         (base / 'lean-towns-data.js').read_text(encoding='utf-8'),
         (base / 'lean-town.js').read_text(encoding='utf-8'),
         (base / 'lean-quest.js').read_text(encoding='utf-8'),
         (base / 'lean-stall.js').read_text(encoding='utf-8'),
         (base / 'lean-travel-data.js').read_text(encoding='utf-8'),
         (base / 'lean-travel.js').read_text(encoding='utf-8'),
         (base / 'lean-buff-gear.js').read_text(encoding='utf-8'),
         (base / 'lean-support.js').read_text(encoding='utf-8'),
         (base / 'lean-trade.js').read_text(encoding='utf-8'),
         (base / 'lean-lure.js').read_text(encoding='utf-8'),
         (base / 'lean-controller.js').read_text(encoding='utf-8'),
         (base / 'lean-pet.js').read_text(encoding='utf-8'),
         (base / 'lean-mall.js').read_text(encoding='utf-8'),
         (base / 'lean-levelspot.js').read_text(encoding='utf-8'),
         (base / 'lean-antistuck.js').read_text(encoding='utf-8'),
         (base / 'lean-chase.js').read_text(encoding='utf-8'),
         (base / 'lean-trap.js').read_text(encoding='utf-8'),
         (base / 'lean-reconnect.js').read_text(encoding='utf-8'),
         (base / 'lean-autostart.js').read_text(encoding='utf-8'),
         (base / 'lean-mastery.js').read_text(encoding='utf-8'),
         (base / 'lean-statpoints.js').read_text(encoding='utf-8'),
         (base / 'lean-trace.js').read_text(encoding='utf-8'),
         (base / 'lean-share.js').read_text(encoding='utf-8'),
         (base / 'lean-setup.js').read_text(encoding='utf-8'),
         (base / 'lean-pet-potion.js').read_text(encoding='utf-8'),
         skin, icon_loader, (base / 'lean-icons.js').read_text(encoding='utf-8'),
         (base / 'lean-skills.js').read_text(encoding='utf-8'),
         (base / 'lean-wardrobe-core.js').read_text(encoding='utf-8'),
         (base / 'lean-wardrobe.js').read_text(encoding='utf-8'),
         (base / 'lean-alchemy-data.js').read_text(encoding='utf-8'),
         (base / 'lean-alchemy.js').read_text(encoding='utf-8'),
         release_notes(), (base / 'lean-update.js').read_text(encoding='utf-8'),
         (base / 'lean-diagnostics.js').read_text(encoding='utf-8'),
         (base / 'lean-reports.js').read_text(encoding='utf-8'),
         (base / 'lean-items.js').read_text(encoding='utf-8'),
         (base / 'lean-map.js').read_text(encoding='utf-8'),
         (base / 'lean-render.js').read_text(encoding='utf-8'),
         (base / 'lean-ui.js').read_text(encoding='utf-8'),
         (base / 'lean-session.js').read_text(encoding='utf-8'),
         (base / 'lean-logging.js').read_text(encoding='utf-8'),
         (base / 'lean-log-messages.js').read_text(encoding='utf-8'),
         (base / 'lean-refusals.js').read_text(encoding='utf-8'),
         (base / 'lean-log-ui.js').read_text(encoding='utf-8'),
         (base / 'lean-boot.js').read_text(encoding='utf-8'), '})();\n']
output = '\n\n'.join(parts).replace('[SRO Asistan]', '[NIX]')
output = english_only(output)
left = leftovers(output)
assert not left, 'Turkish text left in the bot: ' + repr(left[:5])
(base / 'bot.lean.user.js').write_text(output, encoding='utf-8', newline='\n')
(base / 'bot.lean.meta.js').write_text(header[:header.index('// ==/UserScript==') + len('// ==/UserScript==')] + '\n', encoding='utf-8', newline='\n')
print(f'Built bot.lean.user.js: {len(output.encode("utf-8")):,} bytes, {len(output.splitlines()):,} lines')
