"""Builds lean-builds-data.js: which skills each mastery has, which of them must never be used, and the build presets.

Usage: python gen-builds.py <server textdata folder> [output file]
Reads skilldata_*.txt and textdataname.txt (UTF-16).

BUILD_SKILLS says what exists: per skill family (the group codename without SKILL_ and without its last letter, so
CH_SPEAR_PIERCE) the mastery, the mastery level it opens at, its kind and, when it must not be used, why.
BUILD_BLOCKED_GROUPS lists the skill groups (skilldata column 2, the number the game sends) that leveling never uses.
The kind and the block come from the skill's parameters, never from its name:
  pw        a wall (Crystal Wall, Fire Wall): while it stands the caster is rooted in its casting pose
  onff      a standing aura that pays MP every pulse
  tele/tel2/tel3  teleport or dash
  hide / trap / msch  hides, lays a trap, or turns the character into something else
  att       an attack; dura / defp / dru / hste ... without att a timed buff; heal a heal
A resurrection is only for a party member, so it is blocked too (its codename is the only marker there is).
BUILDS is the curated part: what to raise, learn and use for each preset. The generator checks every family in it
exists, is not blocked and has the right kind.
"""
import glob
import json
import re
import struct
import sys
from pathlib import Path

folder = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name('lean-builds-data.js')

MASTERIES = [257, 258, 259, 273, 274, 275, 276, 513, 514, 515, 516, 517, 518]
BLOCK_TAGS = {
    'pw': 'roots the character',
    'onff': 'standing aura that drains MP',
    'tele': 'teleports', 'tel2': 'teleports', 'tel3': 'dashes',
    'hide': 'hides the character', 'trap': 'sets a trap', 'msch': 'changes the character',
}
BUFF_TAGS = {'dura', 'defp', 'dru', 'hste', 'odar', 'ru', 'hr', 'dcmp', 'hpi', 'br'}
IMBUE = re.compile(r'GIGONGTA|POISON\w*_BLADE')


def tag(n):
    try:
        b = struct.pack('>I', n & 0xFFFFFFFF).lstrip(b'\0')
    except (struct.error, ValueError):
        return None
    return b.decode('ascii') if b and all(32 <= x < 127 for x in b) else None


def family(code):
    return re.sub(r'_[A-Z]$', '', code[len('SKILL_'):] if code.startswith('SKILL_') else code)


skills = {}      # group codename -> info
for path in sorted(glob.glob(str(folder / 'skilldata_*.txt'))):
    for line in open(path, encoding='utf-16', errors='ignore'):
        c = line.rstrip('\r\n').split('\t')
        if len(c) < 72 or c[0] != '1' or not c[1].isdigit() or c[7] != '1' or not c[34].isdigit() or int(c[34]) not in MASTERIES:
            continue
        group = c[5]
        tags = {t for t in (tag(int(x)) for x in c[69:] if x.lstrip('-').isdigit()) if t}
        skills.setdefault(group, {'id': int(c[2]), 'mastery': int(c[34]), 'level': int(c[36] or 0), 'tags': tags})

BLOCKED_GROUPS = {}
BUILD_SKILLS = {}
for code, s in sorted(skills.items()):
    fam, tags = family(code), s['tags']
    why = next((BLOCK_TAGS[t] for t in BLOCK_TAGS if t in tags), '')
    if 'RESURRECTION' in code:
        why = 'resurrects a party member'
    parts = fam.split('_')
    passive = 'PASSIVE' in parts or (parts[0] == 'EU' and len(parts) > 2 and parts[2].endswith('P'))
    if IMBUE.search(code):
        kind = 'imbue'
    elif 'att' in tags:
        kind = 'attack'
    elif passive and 'dura' not in tags:
        kind = 'passive'
    elif 'heal' in tags:
        kind = 'heal'
    elif BUFF_TAGS & tags and 'dura' in tags:
        kind = 'buff'
    else:
        kind = 'other'
    if why:
        BLOCKED_GROUPS[s['id']] = why
        kind = 'blocked'
    old = BUILD_SKILLS.get(fam)
    entry = [s['mastery'], s['level'], kind, why]
    if old is None or s['level'] < old[1]:
        BUILD_SKILLS[fam] = entry if not old or not old[3] else [entry[0], entry[1], entry[2], entry[3] or old[3]]
    elif why and not old[3]:
        old[3] = why

# ---- presets. weapon: item TID4 list (CH 2 sword, 3 blade, 4 spear, 5 glaive, 6 bow; EU 7 sword, 8 two-hand sword, 9 axe,
# 10 warlock wand, 11 staff, 12 crossbow, 13 dagger, 14 harp, 15 cleric wand). race 0 Chinese, 1 European.
# masteries are raised in this order. rotation / buffs / imbue name skill families; learn adds skills that are only
# learned (heals, passives of the masteries are always learned).
SWORD = ['CH_SWORD_SMASH', 'CH_SWORD_GEOMGI', 'CH_SWORD_KNOCKDOWN', 'CH_SWORD_DOWNATTACK', 'CH_SWORD_SPECIAL']
SPEAR = ['CH_SPEAR_ROUNDAREA', 'CH_SPEAR_FRONTAREA', 'CH_SPEAR_STUN', 'CH_SPEAR_PIERCE']
BUILDS = [
    dict(key='glaive', label='Glaive nuker', race=0, weapon=[5], shield=False, masteries=[258, 275, 274], rotation=SPEAR,
         buffs=['CH_FIRE_GONGUP', 'CH_FIRE_GANGGI', 'CH_LIGHTNING_GWANTONG', 'CH_SPEAR_SPIN'], imbue='CH_FIRE_GIGONGTA',
         about='Heuksal, Fire, Lightning. Glaive area hits, Fire buffs, fire imbue. Strength.'),
    dict(key='spear', label='Spear fighter', race=0, weapon=[4], shield=False, masteries=[258, 274, 275], rotation=SPEAR,
         buffs=['CH_LIGHTNING_GWANTONG', 'CH_FIRE_GONGUP', 'CH_FIRE_GANGGI', 'CH_SPEAR_SPIN'], imbue='CH_LIGHTNING_GIGONGTA',
         about='Heuksal, Lightning, Fire. Spear hits, Lightning and Fire buffs, lightning imbue. Strength.'),
    dict(key='blade', label='Blade tank', race=0, weapon=[3], shield=True, masteries=[257, 276, 273], rotation=SWORD,
         buffs=['CH_SWORD_SHIELD', 'CH_COLD_SHIELD', 'CH_COLD_GANGGI'], imbue='CH_COLD_GIGONGTA',
         about='Bicheon with blade and shield, Force, Cold. Tough, with shield buffs and a cold imbue. Strength.'),
    dict(key='sword', label='Sword fighter', race=0, weapon=[2], shield=True, masteries=[257, 275, 274], rotation=SWORD,
         buffs=['CH_SWORD_SHIELD', 'CH_FIRE_GONGUP', 'CH_FIRE_GANGGI', 'CH_FIRE_SHIELD', 'CH_LIGHTNING_GWANTONG'], imbue='CH_FIRE_GIGONGTA',
         about='Bicheon with sword and shield, Fire, Lightning. More damage than the tank. Strength.'),
    dict(key='bow', label='Bow nuker', race=0, weapon=[6], shield=False, masteries=[259, 275, 274],
         rotation=['CH_BOW_AREA', 'CH_BOW_PIERCE', 'CH_BOW_POWER', 'CH_BOW_CRITICAL', 'CH_BOW_SPECIAL'],
         buffs=['CH_FIRE_GONGUP', 'CH_FIRE_GANGGI', 'CH_LIGHTNING_GWANTONG'], imbue='CH_FIRE_GIGONGTA',
         about='Pacheon, Fire, Lightning. Bow shots from range, Fire buffs, fire imbue. Strength.'),
    dict(key='force', label='Force support', race=0, weapon=[2], shield=True, masteries=[276, 273, 257], rotation=SWORD[:3],
         buffs=['CH_COLD_SHIELD', 'CH_COLD_GANGGI'], imbue='CH_COLD_GIGONGTA',
         learn=['CH_WATER_HEAL', 'CH_WATER_CUREAREA', 'CH_WATER_CURE', 'CH_WATER_SELFHEAL'],
         about='Force, Cold, Bicheon with sword and shield. Learns the heals and cures for a party; fights with a sword.'),
    dict(key='wizard', label='Wizard', race=1, weapon=[11], shield=False, masteries=[514, 518],
         rotation=['EU_WIZARD_FIREA_SPRAY', 'EU_WIZARD_FIREA_POINT', 'EU_WIZARD_COLDA_AREA', 'EU_WIZARD_COLDA_POINT'],
         buffs=['EU_WIZARD_MENTALA_DAMAGEUP', 'EU_CLERIC_BLESSA_INT', 'EU_CLERIC_BLESSA_MAGICAL'], imbue='',
         about='Wizard and Cleric. Fire and Cold spells, Cleric blessings. Intelligence.'),
    dict(key='warlock', label='Warlock', race=1, weapon=[10], shield=False, masteries=[516, 518],
         rotation=['EU_WARLOCK_DOTA_BURN', 'EU_WARLOCK_DOTA_POISON', 'EU_WARLOCK_DOTA_BLOODING', 'EU_WARLOCK_DOTA_DISEASE', 'EU_WARLOCK_BLOODA_POINT'],
         buffs=['EU_CLERIC_BLESSA_INT', 'EU_CLERIC_BLESSA_MAGICAL'], imbue='',
         about='Warlock and Cleric. Damage over time spells, Cleric blessings. Intelligence.'),
    dict(key='warrior', label='Warrior', race=1, weapon=[7], shield=True, masteries=[513, 518],
         rotation=['EU_WARRIOR_ONEHANDA_PIERCE', 'EU_WARRIOR_ONEHANDA_SHIELD', 'EU_WARRIOR_ONEHANDA_STRIKE', 'EU_WARRIOR_ONEHANDA_CRITICAL'],
         buffs=['EU_WARRIOR_FRENZYA_DAMAGE', 'EU_WARRIOR_FRENZYA_HEALTH', 'EU_WARRIOR_GUARDA_PHYSICAL', 'EU_WARRIOR_GUARDA_MAGIC', 'EU_CLERIC_BLESSA_STR'], imbue='',
         about='Warrior with one-hand sword and shield, Cleric. Tough, with Cleric blessings. Strength.'),
    dict(key='rogue', label='Rogue', race=1, weapon=[13], shield=False, masteries=[515, 518],
         rotation=['EU_ROG_DAGGERA_CHAIN', 'EU_ROG_DAGGERA_WOUND', 'EU_ROG_DAGGERA_SCREW', 'EU_ROG_DAGGERA_SLASH'],
         buffs=['EU_ROG_DAGGERA_SPEED', 'EU_CLERIC_BLESSA_STR'], imbue='EU_ROG_POISONA_BLADE',
         about='Rogue with dagger, Cleric. Quick dagger hits, poison blade. Strength.'),
    dict(key='cleric', label='Cleric', race=1, weapon=[15], shield=False, masteries=[518, 514],
         rotation=['EU_CLERIC_BATTLEA_SACRIFICE', 'EU_CLERIC_BATTLEA_CROSS'],
         buffs=['EU_CLERIC_BLESSA_INT', 'EU_CLERIC_BLESSA_MAGICAL'], imbue='', learn=['EU_CLERIC_HEALA_TARGET'],
         about='Cleric and Wizard. Learns the heals; fights with holy attacks. Intelligence.'),
    dict(key='bard', label='Bard', race=1, weapon=[14], shield=False, masteries=[517, 518],
         rotation=['EU_BARD_BATTLAA_EXPLOSION', 'EU_BARD_BATTLAA_DAMAGE'],
         buffs=['EU_BARD_SPEEDUPA_MSPEED', 'EU_CLERIC_BLESSA_INT'], imbue='',
         about='Bard and Cleric. Music attacks, speed buff. Intelligence.'),
]

problems = []
for b in BUILDS:
    for role, fams in (('attack', b['rotation']), ('buff', b['buffs']), ('imbue', [b['imbue']] if b['imbue'] else []), ('heal', b.get('learn', []))):
        for f in fams:
            e = BUILD_SKILLS.get(f)
            if not e:
                problems.append(f'{b["key"]}: {f} does not exist')
            elif e[3]:
                problems.append(f'{b["key"]}: {f} is blocked ({e[3]})')
            elif role in ('attack', 'imbue') and e[2] != role or role == 'buff' and e[2] != 'buff':
                problems.append(f'{b["key"]}: {f} is a {e[2]}, listed as {role}')
if problems:
    sys.exit('\n'.join(problems))

lines = ['// Generated by gen-builds.py from the server skill data. Do not edit by hand.',
         '// BUILD_SKILLS: family -> [mastery, mastery level it opens at, kind, why it is blocked]',
         'const BUILD_SKILLS = ' + json.dumps(BUILD_SKILLS, separators=(',', ':'), sort_keys=True) + ';',
         '// BUILD_BLOCKED_GROUPS: skill group -> why leveling never uses it',
         'const BUILD_BLOCKED_GROUPS = ' + json.dumps({str(k): v for k, v in sorted(BLOCKED_GROUPS.items())}, separators=(',', ':')) + ';',
         'const BUILDS = ' + json.dumps(BUILDS, indent=1) + ';', '']
out.write_text('\n'.join(lines), encoding='utf-8', newline='\n')
print(f'{out.name}: {len(BUILD_SKILLS)} skill families, {len(BLOCKED_GROUPS)} blocked groups, {len(BUILDS)} builds')
