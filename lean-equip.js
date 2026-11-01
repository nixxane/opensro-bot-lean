// Auto-equip, phBot-style but scored on the game's own stat model: on a town trip, a carried equipment piece
// whose real stats beat the worn one in the same slot family is worn there, and the piece it replaces is
// deposited in the warehouse. Stats are computed the way the client tooltip does it: every stat rolls inside a
// [min, max] field pair (the roll is 5 bits of the item's variance bitfield), plus adds its per-plus share, and
// known blues add a bounded nudge on top — so a well-rolled ordinary piece can beat a low-rolled Seal one.
// Weapons are compared on the dominant attack of the worn weapon (a physical build never swaps to a magical
// blade, however good); armour and shields on physical + magical defence; accessories on reinforcement.
// Never touched: the chosen primary/secondary/shield, buff-set gear, the alchemy item, items with a Keep rule,
// pieces with an incomplete tooltip or an unknown level requirement, and anything the game refuses to equip.
const EQUIP_MARGIN = 1.02;
// Blue weights are a judgment call, kept small so real stats dominate the comparison: half a point per build
// stat (STR on a physical weapon, INT on a magical one), a quarter per hit-ratio point, a tenth per raw HP.
const Equip = {
  bad: new Set(), out: new Set(), outOwner: '', message: 'Auto-equip off.',
  reset() { this.bad.clear(); this.out.clear(); this.outOwner = ''; this.message = 'Auto-equip off.'; },
  on() { return !!Settings.profile.items.autoEquip; },
  family(item) { return (item.typeFlags >>> 7) & 15; },
  // The stats an item really carries, or null when its tooltip does not hold them all (never guessed).
  stats(item) {
    const f = item.tooltip?.fields;
    if (!f || item.variance === undefined || item.variance === null) return null;
    let bits; try { bits = BigInt(item.variance); } catch { return null; }
    const roll = i => Number(bits >> BigInt(i * 5) & 31n);
    const real = (lo, hi, i, perPlus) => {
      if (!Number.isFinite(f[lo]) || !Number.isFinite(f[hi]) || !Number.isFinite(f[perPlus])) return null;
      return (f[hi] - f[lo]) * roll(i) / 31 + f[lo] + f[perPlus] * (item.plus ?? 0);
    };
    const tid = this.family(item);
    if (tid === 6) {
      const paMin = real('varianceIntMin240', 'varianceIntMax244', 4, 'varianceFloatPerPlus250');
      const paMax = real('varianceIntMin248', 'varianceIntMax24c', 4, 'varianceFloatPerPlus250');
      const maMin = real('varianceIntMin254', 'varianceIntMax258', 5, 'varianceFloatPerPlus264');
      const maMax = real('varianceIntMin25c', 'varianceIntMax260', 5, 'varianceFloatPerPlus264');
      if (paMin === null || paMax === null || maMin === null || maMax === null) return null;
      return { weapon: true, pa: (paMin + paMax) / 2, ma: (maMin + maMax) / 2 };
    }
    if (tid === 5 || tid === 12) {
      const pr = real('varianceFloatMin1e0', 'varianceFloatMax1e4', 0, 'varianceFloatPerPlus1e8');
      const mr = real('varianceFloatMin200', 'varianceFloatMax204', 1, 'varianceFloatPerPlus208');
      if (pr === null || mr === null) return null;
      return { accessory: true, pr, mr };
    }
    if ([1, 2, 3, 4, 9, 10, 11].includes(tid)) {
      const shield = tid === 4;
      const pd = real('varianceFloatMin1c8', 'varianceFloatMax1cc', shield ? 4 : 3, 'varianceFloatPerPlus1d0');
      const md = real('varianceFloatMin1f4', 'varianceFloatMax1f8', shield ? 5 : 4, 'varianceFloatPerPlus1fc');
      if (pd === null || md === null) return null;
      return { armour: true, pd, md };
    }
    return null;
  },
  // Blues decoded as the client does: paramId in the low 16 bits, amount in the high 32.
  blues(item, phys) {
    let bonus = 0;
    for (const encoded of item.magic || []) {
      let bits; try { bits = BigInt(encoded); } catch { continue; }
      const ref = (item.magicReferences || []).find(r => r.paramId === Number(bits & 65535n));
      if (!ref) continue;
      const amount = Number(bits >> 32n) & 0xffffffff;
      if (ref.optionName === 'MATTR_STR') bonus += amount * (phys === false ? 0 : 0.5);
      else if (ref.optionName === 'MATTR_INT') bonus += amount * (phys === true ? 0 : 0.5);
      else if (ref.optionName === 'MATTR_HR') bonus += amount * 0.25;
      else if (ref.optionName === 'MATTR_HP') bonus += amount * 0.1;
    }
    return bonus;
  },
  score(item, stats, phys) {
    if (stats.weapon) { const attack = phys === undefined ? stats.pa >= stats.ma : phys; return (attack ? stats.pa : stats.ma) + this.blues(item, attack); }
    if (stats.armour) return stats.pd + stats.md + this.blues(item);
    return (stats.pr + stats.mr) * 100 + this.blues(item);
  },
  protected(item) {
    if (ItemRules.guarded(item)) return true;
    const key = BuffGear.key(item);
    if (Settings.profile.macro.buffSets?.some(s => s.weapon === key || s.shield === key)) return true;
    if (Alchemy.selected && Alchemy.item()?.slot === item.slot) return true;
    return ItemRules.get(item.refObjId)?.act === 'keep';
  },
  // The next swap worth making. Rings and earrings have two slots: the weaker worn piece is the target, so a
  // better piece replaces it instead of being compared against the stronger one.
  pick() {
    const gp = World.gp, equipped = gp.equipmentSlotCount || 13, level = gp.progression?.level;
    if (!Number.isInteger(level)) return null;
    const worn = (gp.inventory || []).filter(i => i.slot < equipped && this.stats(i) && !this.protected(i));
    if (!worn.length) return null;
    let best = null;
    for (const item of World.items()) {
      if (item.slot < equipped || !ItemType.isEquipment(item.typeFlags) || (item.durability ?? 1) <= 0) continue;
      if (this.protected(item) || this.bad.has(BuffGear.key(item))) continue;
      const stats = this.stats(item);
      if (!stats) continue;
      const need = Town.requiredLevel(item);
      if (!Number.isInteger(need) || need > level) continue;
      const family = worn.filter(w => this.family(w) === this.family(item));
      if (!family.length) continue;
      let target = null, targetStats = null, targetScore = 0;
      for (const w of family) {
        const ws = this.stats(w), s = this.score(w, ws, stats.weapon ? ws.pa >= ws.ma : undefined);
        if (!target || s < targetScore) { target = w; targetStats = ws; targetScore = s; }
      }
      const score = this.score(item, stats, stats.weapon ? targetStats.pa >= targetStats.ma : undefined);
      if (targetScore <= 0 || score < targetScore * EQUIP_MARGIN) continue;
      if (!best || score - targetScore > best.score - best.targetScore) best = { item, worn: target, score, targetScore };
    }
    return best;
  },
  remember(key) {
    const owner = Settings.profileKey + '|' + World.charName;
    if (owner !== this.outOwner) { this.outOwner = owner; this.out.clear(); }
    this.out.add(key);
  },
  // Replaced pieces are never sold from the bag, even on later trips, until they are stored.
  replaced(item) { return this.outOwner === Settings.profileKey + '|' + World.charName && this.out.has(BuffGear.key(item)); },
  // Runs from Town.store() while the warehouse is open: one swap at a time, each confirmed by the game state
  // before the next. A swap the game refuses (or never confirms) is skipped for the session; nothing here can
  // fail the town trip.
  step(t) {
    if (!this.on() || !World.inWorld()) return false;
    const p = t.pending, gp = World.gp;
    if (p?.kind === 'equip') {
      if (!gp.inventoryPending && gp.inventory?.find(i => i.slot === p.slot)?.refObjId === p.ref) {
        t.pending = null;
        (t.equippedOut ||= []).push(p.oldKey);
        this.remember(p.oldKey);
        this.message = 'Wore ' + (p.name || 'better gear') + '; the replaced piece goes to the warehouse.';
        Log.info('Equip: ' + this.message); UI.toast(this.message, 'info', 4000);
        return true;
      }
      if (gp.error && !gp.inventoryPending && now() - p.at >= 500) { this.bad.add(p.key); t.pending = null; }
      else if (now() - p.at > 15000) { this.bad.add(p.key); t.pending = null; }
      return true;
    }
    const pick = this.pick();
    if (!pick) return false;
    const name = Items.name(pick.item.refObjId);
    if (Cmd.raw({ kind: 'inventory-move', source: pick.item.slot, destination: pick.worn.slot, quantity: 0 }, 'Equip: wear ' + name)) {
      t.pending = { kind: 'equip', slot: pick.worn.slot, ref: pick.item.refObjId, key: BuffGear.key(pick.item), oldKey: BuffGear.key(pick.worn), name, at: now() };
      this.message = 'Wearing ' + name + '.';
    }
    return true;
  },
};
