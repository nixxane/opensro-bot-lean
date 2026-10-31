// Read-only Item Mall probe. Opens the mall catalogue with the game's own mall-open command — nothing is bought —
// and prints the account balance and every offer with its live address and packageId, so real prices and item ids
// can be captured before anything automated is built on top of them. mall-buy is deliberately absent from this
// module, and nothing runs by itself: both functions are called by hand from the console.
const MallProbe = {
  open() {
    if (!World.inWorld()) return 'Enter the game first.';
    if (World.gp.inventoryPending) return 'An inventory transaction is pending; try again in a moment.';
    return Cmd.raw({ kind: 'mall-open' }, 'Item mall: open catalogue (read-only)')
      ? 'Catalogue requested; read it with SROLean.mall.dump() a few seconds later.' : 'The command was not sent.';
  },
  state() { return World.gp.itemMall ?? null; },
  // dump('potion') lists only offers whose name contains the text (case-insensitive); dump() lists everything.
  // Returns the balances and prints one console row per offer: name, price, purchase limit, address, package, items.
  dump(filter = '') {
    const s = this.state();
    if (!s) return 'No catalogue yet: call SROLean.mall.open() first, then dump() a few seconds later.';
    const f = String(filter).toLowerCase();
    const rows = (s.offers || []).filter(o => !f || (o.name || '').toLowerCase().includes(f)).map(o => ({
      name: o.name, silk: o.silk, giftSilk: o.giftSilk, maxQty: o.purchaseLimit,
      address: o.group + '/' + o.shop + '/' + o.tab + '/' + o.slot, packageId: o.packageId, items: (o.itemIds || []).join(',')
    }));
    console.table(rows);
    return { silk: s.silk, giftSilk: s.giftSilk, points: s.points, offers: (s.offers || []).length, shown: rows.length,
      pending: s.pending, revision: s.revision, error: s.error ?? null };
  },
};
