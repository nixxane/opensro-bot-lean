"""Builds lean-leveling-data.js: hunting spots by monster level, and the gear each town's NPCs sell.

Usage: python gen-leveling.py <server textdata folder> [output file]
Reads characterdata_*.txt, npcpos.txt, itemdata_*.txt and the shop tables (refshopgroup, refmappingshopgroup,
refmappingshopwithtab, refshoptab, refshopgoods, refscrapofpackageitem), all UTF-16.

Spots: every outdoor spawn point of an ordinary monster (characterdata MonsterType 0, a MOB_ codename) is put on a
grid; each cell gathers the points within SPOT_RADIUS of its centre. A cell is kept when it holds at least SPOT_MIN
points whose levels sit within SPOT_SPREAD of each other; then, strongest first, a kept cell hides any weaker cell of
about the same level within SPOT_GAP. Positions are region-local, as the game sends them.

Gear: per town (KT Hotan, CH Jangan, WC Donwhang, EU Constantinople, CA Samarkand), every ordinary weapon, shield,
armour piece and accessory its smith, armour and accessory merchants sell, with the item's type ids, country, sex
and required level. The bot buys from the live shop offers; this table only says what is worth a trip.
"""
import glob
import json
import math
import sys
from pathlib import Path

folder = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name('lean-leveling-data.js')

SPOT_CELL = 250        # grid step, game units (10 units = 1 m)
SPOT_RADIUS = 500      # points counted around a cell centre
SPOT_MIN = 3           # spawn points needed for a spot
SPOT_SPREAD = 4        # most levels apart inside one spot
SPOT_GAP = 900         # a stronger spot of about the same level hides weaker ones this close
SPARSE_RADIUS = 900    # second pass, for thinly spread monsters
SPARSE_MIN = 2
MAX_LEVEL = 120

def rows(pattern):
    for path in sorted(glob.glob(str(folder / pattern))):
        for line in open(path, encoding='utf-16', errors='ignore'):
            yield line.rstrip('\r\n').split('\t')

def num(text, default=None):
    try:
        return int(text)
    except (TypeError, ValueError):
        try:
            return int(float(text))
        except (TypeError, ValueError):
            return default

def world(region, x, z):
    return ((region & 255) - 135) * 1920 + x, ((region >> 8) - 92) * 1920 + z

def local(wx, wz):
    rx, rz = math.floor(wx / 1920), math.floor(wz / 1920)
    return ((rz + 92) << 8) | (rx + 135), wx - rx * 1920, wz - rz * 1920

# ---- spots
monsters, npc_codes = {}, {}
for c in rows('characterdata_*.txt'):
    if len(c) < 86 or c[0] != '1' or not c[1].isdigit():
        continue
    npc_codes[c[2]] = int(c[1])
    level = num(c[57], 0)
    if not c[2].startswith('MOB_') or num(c[15], -1) != 0 or not 1 <= level <= MAX_LEVEL:
        continue
    if any(tag in c[2] for tag in ('_EVENT', '_QUEST', '_TQ_', '_GHOST_EVENT', '_SD_', '_INS_')):
        continue
    monsters[int(c[1])] = level

points = []
for c in rows('npcpos.txt'):
    if len(c) < 5:
        continue
    ref, region = num(c[0]), num(c[1])
    if ref not in monsters or region is None or region < 0 or region & 0x8000:
        continue
    x, y, z = float(c[2]), float(c[3]), float(c[4])
    wx, wz = world(region, x, z)
    points.append((wx, wz, y, monsters[ref]))

grid = {}
for p in points:
    grid.setdefault((math.floor(p[0] / SPOT_CELL), math.floor(p[1] / SPOT_CELL)), []).append(p)

def cluster(radius, minimum):
    """Every grid cell with at least `minimum` spawn points of about one level within `radius` of its centre."""
    reach = math.ceil(radius / SPOT_CELL)
    found = []
    for (gx, gz) in grid:
        cx, cz = (gx + 0.5) * SPOT_CELL, (gz + 0.5) * SPOT_CELL
        near = [p for dx in range(-reach, reach + 1) for dz in range(-reach, reach + 1)
                for p in grid.get((gx + dx, gz + dz), ()) if math.dist((p[0], p[1]), (cx, cz)) <= radius]
        if len(near) < minimum:
            continue
        levels = sorted(p[3] for p in near)
        median = levels[len(levels) // 2]
        near = [p for p in near if abs(p[3] - median) <= SPOT_SPREAD // 2]
        if len(near) < minimum:
            continue
        mx, mz = sum(p[0] for p in near) / len(near), sum(p[1] for p in near) / len(near)
        y = sorted(p[2] for p in near)[len(near) // 2]
        found.append((len(near), median, mx, mz, y, min(p[3] for p in near), max(p[3] for p in near)))
    return sorted(found, key=lambda s: -s[0])


def keep(spots, candidates):
    """Strongest first; a kept spot hides a weaker one of about the same level within SPOT_GAP."""
    for s in candidates:
        if any(abs(s[1] - k[1]) <= SPOT_SPREAD and math.dist((s[2], s[3]), (k[2], k[3])) < SPOT_GAP for k in spots):
            continue
        spots.append(s)


spots = []
keep(spots, cluster(SPOT_RADIUS, SPOT_MIN))
# Thinly spread monsters (the first levels around a town: one or two spawns per hill) never make the first pass;
# a wider, smaller cluster fills those gaps without hiding a dense spot.
keep(spots, cluster(SPARSE_RADIUS, SPARSE_MIN))
spots.sort(key=lambda s: (s[1], -s[0]))
# [regionId, x, y, z, level, lowest level, highest level, spawn points]
spot_rows = []
for count, level, wx, wz, y, lo, hi in spots:
    region, x, z = local(wx, wz)
    spot_rows.append([region, round(x), round(y), round(z), level, lo, hi, count])

# ---- gear
items = {}
for c in rows('itemdata_*.txt'):
    if len(c) < 60 or c[0] != '1' or not c[1].isdigit() or not c[2].startswith('ITEM_'):
        continue
    items[c[2]] = c

def table(name, key, value):
    out = {}
    for c in rows(name):
        if len(c) > max(key, value) and c[0] == '1':
            out.setdefault(c[key], []).append(c[value])
    return out

group_of_npc = {}
for c in rows('refshopgroup.txt'):
    if len(c) > 4 and c[0] == '1':
        group_of_npc[c[4]] = c[3]
stores_of_group = table('refmappingshopgroup.txt', 2, 3)
tabgroups_of_store = table('refmappingshopwithtab.txt', 2, 3)
tabs_of_tabgroup = table('refshoptab.txt', 4, 3)
goods_of_tab = table('refshopgoods.txt', 2, 3)
item_of_package = {k: v[0] for k, v in table('refscrapofpackageitem.txt', 2, 3).items()}

TOWNS = ['KT', 'CH', 'WC', 'EU', 'CA']
ROLES = {'SMITH': 'smith', 'ARMOR': 'armor', 'ACCESSORY': 'accessory'}
gear = {}
for town in TOWNS:
    found = {}
    for npc_key, role in ROLES.items():
        group = group_of_npc.get(f'NPC_{town}_{npc_key}')
        for store in stores_of_group.get(group, []):
            for tabgroup in tabgroups_of_store.get(store, []):
                for tab in tabs_of_tabgroup.get(tabgroup, []):
                    for package in goods_of_tab.get(tab, []):
                        c = items.get(item_of_package.get(package, ''))
                        if not c:
                            continue
                        t1, t2, t3, t4 = (num(c[9 + i], 0) for i in range(4))
                        rarity, req_type, req = num(c[15], 0), num(c[32], -1), num(c[33], 0)
                        # European armour and weapons name their level through a mastery requirement (types 513 and up).
                        if t1 != 3 or t2 != 1 or rarity != 0 or not (req_type == 1 or 513 <= req_type <= 520) or not 1 <= req <= MAX_LEVEL:
                            continue
                        # [refObjId, role, TID3, TID4, country, sex (0 female, 1 male, 2 any), required level, price]
                        found[int(c[1])] = [int(c[1]), role, t3, t4, num(c[14], 3), num(c[58], 2), req, num(c[26], 0)]
    gear[town] = sorted(found.values(), key=lambda r: (r[1], r[2], r[3], r[6]))

# Where the armour and accessory merchants stand, for the town table's optional services.
shops = {}
code_of = {v: k for k, v in npc_codes.items()}
for c in rows('npcpos.txt'):
    if len(c) < 5 or num(c[0]) not in code_of:
        continue
    parts = code_of[num(c[0])].split('_')
    if len(parts) == 3 and parts[0] == 'NPC' and parts[1] in TOWNS and parts[2] in ('ARMOR', 'ACCESSORY'):
        shops.setdefault(parts[1], {}).setdefault(parts[2].lower(), {'refObjId': num(c[0]), 'regionId': num(c[1]),
            'x': round(float(c[2]), 2), 'y': round(float(c[3]), 2), 'z': round(float(c[4]), 2)})

text = ('// Generated by gen-leveling.py from the server data. Do not edit by hand.\n'
        '// LEVEL_SPOTS rows: [regionId, x, y, z, level, lowest level, highest level, spawn points].\n'
        'const LEVEL_SPOTS = ' + json.dumps(spot_rows, separators=(',', ':')) + ';\n'
        '// LEVEL_GEAR[town] rows: [refObjId, shop, TID3, TID4, country, sex, required level, price].\n'
        'const LEVEL_GEAR = ' + json.dumps(gear, separators=(',', ':')) + ';\n'
        '// Armour and accessory merchants per town.\n'
        'const LEVEL_SHOPS = ' + json.dumps(shops, separators=(',', ':')) + ';\n')
out.write_text(text, encoding='utf-8', newline='\n')
print('spots', len(spot_rows), 'from', len(points), 'spawn points;', 'bytes', len(text))
for town in TOWNS:
    roles = {}
    for r in gear[town]:
        roles[r[1]] = roles.get(r[1], 0) + 1
    print(town, roles, 'shops', sorted(shops.get(town, {})))
levels = {}
for r in spot_rows:
    levels[r[4]] = levels.get(r[4], 0) + 1
print('levels without a spot:', [l for l in range(1, 111) if l not in levels])
