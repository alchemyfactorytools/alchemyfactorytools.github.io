// Tile-composer canonical-pick suite (TILE-COMPOSER.md). Pins the deterministic recipe
// the build+operating-cost DP chooses per item, so metric-weight changes can't silently
// regress the picks. The headline Phase-2 case is Clay → Cauldron: cauldron triples are
// not in db.recipes, so the composer must pull them from the shared eligibility helper.
//
// Cross-checks (maxTier 6, Coke Powder fuel / Growth Potion fert on the belt):
//   Sand  → Grinder{Stone}            (clean route; the high-multiplier Rock-Salt route
//                                       that dumps 100 Salt/100 Sand is deterred by CO_W)
//   Salt  → Stone Crusher{Rock Salt}  (stays — it dumps only CHEAP Sand, floor 4)
//   Glass → Kiln{Sand}, Brick → Kiln{Clay}, Plank → Table Saw{Logs}
//   Clay  → Cauldron{Logs, Coke Powder}   ← Phase-2 goal (was a deep Assembler chain)

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeComposer } = require('../src/composer');
const { resolveConfig } = require('../src/config');
const db = require('../data/alchemy_db.v41.json');

const composer = (overrides) => makeComposer(db, resolveConfig({
  maxTier: 6,
  canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' },
  ...overrides,
}));

// Describe a pick as "Machine{inputs}" for readable assertions.
const desc = (pick) => {
  if (!pick) return 'UNMAKEABLE';
  if (pick.source === 'belt' || pick.source === 'buy') return pick.source;
  const ins = Object.entries(pick.recipe.inputs).map(([k, v]) => `${k}:${v}`).sort().join(',');
  return `${pick.recipe.machine}{${ins}}`;
};

test('canonical picks: clean material routes, cauldron only where it wins', () => {
  const comp = composer();
  assert.equal(desc(comp.canonicalPick('Sand')), 'Grinder{Stone:1}');
  assert.equal(desc(comp.canonicalPick('Salt')), 'Stone Crusher{Rock Salt:1}');
  assert.equal(desc(comp.canonicalPick('Glass')), 'Kiln{Sand:6}');
  assert.equal(desc(comp.canonicalPick('Brick')), 'Kiln{Clay:1}');
  assert.equal(desc(comp.canonicalPick('Plank')), 'Table Saw{Logs:1}');
  // Belt fuel/fert is a UTILITY supply — free as fuel/fert, but not as bulk material. So the
  // canonical fuel costs its real production (buy-ore→refine) when treated as a craftable item.
  assert.equal(comp.canonicalPick('Coke Powder').source, 'recipe');
});

test('Phase 2: Clay resolves to a Cauldron triple (not in db.recipes), not the deep Assembler chain', () => {
  const comp = composer();
  const clay = comp.canonicalPick('Clay');
  assert.equal(clay.source, 'cauldron');
  assert.equal(clay.recipe.machine, 'Cauldron');
  assert.equal(typeof clay.tripleIndex, 'number');
  assert.equal(clay.recipe.outputs.Clay, 1);            // cauldron crafts one primary, no co-product
  assert.equal(Object.values(clay.recipe.inputs).reduce((a, b) => a + b, 0), 3); // exactly 3 cauldron inputs
  assert.ok(clay.recipe.baseTime > 0);                  // craft time from cauldronStats
});

test('cauldron disabled → Clay falls back to a real db recipe (no triples available)', () => {
  const comp = composer({ cauldron: { enabled: false } });
  const clay = comp.canonicalPick('Clay');
  assert.ok(clay && clay.source === 'recipe', 'expected a recipe pick when cauldron is off');
});

test('the fixpoint solver is context-free: shared-instance picks match fresh instances', () => {
  // The recipe DAG has cycles (cauldron outputs are also inputs); a recursive memo poisoned
  // sequential queries (Brick → "unmakeable", Sand inflated). The relaxation must not.
  const items = ['Clay', 'Sand', 'Salt', 'Glass', 'Brick', 'Plank'];
  const shared = composer();
  for (const item of items) {
    const fresh = composer();
    assert.equal(desc(shared.canonicalPick(item)), desc(fresh.canonicalPick(item)), `pick mismatch for ${item}`);
    assert.equal(shared.tileCost(item), fresh.tileCost(item), `cost mismatch for ${item}`);
  }
});

test('build vs op are separate axes: op (copper/unit) is qty-scaled, build (layout) is not', () => {
  const comp = composer();
  // Glass = Kiln{Sand:6}: the QUANTITY (6) propagates on the OPERATING axis only — op(Glass) is
  // exactly 6× op(Sand) (the copper of 6 Sand) — while build (layout) does NOT multiply by 6.
  assert.equal(comp.opCost('Glass'), 6 * comp.opCost('Sand'));
  assert.ok(comp.buildCost('Glass') < 2 * comp.buildCost('Sand'), 'build must not scale with input quantity');
  // The fert carrier is build-heavy but its OPERATING cost (raws to brew one) is far smaller —
  // this separation is what lets nurseries be charged fert on the op axis without a build blowup.
  assert.ok(comp.opCost('Growth Potion') < comp.buildCost('Growth Potion'));
});

test('co-product waste (CO_W) deters dumping value; drop it and the wasteful route wins', () => {
  // Sand's clean Grinder{Stone} beats Stone Crusher{Rock Salt} (which dumps 100 Salt/100 Sand)
  // only because CO_W prices the dumped Salt. Zero it out and the shallow wasteful route wins.
  assert.equal(desc(composer().canonicalPick('Sand')), 'Grinder{Stone:1}');
  const noWaste = composer({ composer: { coW: 0 } });
  assert.equal(desc(noWaste.canonicalPick('Sand')), 'Stone Crusher{Rock Salt:1}');
});

// ---- Phase 3: composition (compose → sized tile tree) ----

const kid = (tile, item) => (tile.inputs || []).find((c) => c.item === item);
const collectIds = (tile, acc = []) => { acc.push(tile.id); (tile.inputs || []).forEach((c) => collectIds(c, acc)); return acc; };

test('Phase 3: compose sizes the tile tree by rate (Glass @60/min)', () => {
  const comp = composer();
  const r = comp.compose('Glass', 60);
  // Glass = Kiln{Sand:6}: 60/min ⇒ 6 Kilns, needs 360 Sand/min.
  assert.equal(r.tree.item, 'Glass');
  assert.equal(r.tree.source, 'recipe');
  assert.equal(r.tree.machine, 'Kiln');
  assert.equal(r.tree.ratePerMin, 60);
  assert.equal(r.tree.machineCount, 6);
  const sand = kid(r.tree, 'Sand');
  assert.equal(sand.ratePerMin, 360);          // 6 Sand × 60 Glass/min
  assert.equal(sand.machine, 'Grinder');
  const stone = kid(sand, 'Stone');
  assert.equal(stone.ratePerMin, 360);
  const lime = kid(stone, 'Limestone');
  assert.equal(lime.source, 'buy');            // bottoms out at a bought raw
  assert.equal(lime.inputs.length, 0);
  // operating cost = opCost × rate (the per-min material drain), independent of the build's depth.
  assert.equal(r.summary.operatingCopperPerMin, comp.opCost('Glass') * 60);
});

test('Phase 3: rates scale linearly with demand (machine counts via ceil)', () => {
  const comp = composer();
  const a = comp.compose('Glass', 60);
  const b = comp.compose('Glass', 120);
  assert.equal(b.tree.ratePerMin, 2 * a.tree.ratePerMin);
  assert.equal(kid(b.tree, 'Sand').ratePerMin, 2 * kid(a.tree, 'Sand').ratePerMin);
});

test('Phase 3: heated machines draw a shared fuel trunk that covers its own heat (fixpoint)', () => {
  const comp = composer();
  const r = comp.compose('Glass', 60);
  assert.ok(r.fuel, 'a build with heated Kilns must have a fuel trunk');
  assert.equal(r.fuel.item, 'Coke Powder');
  // the trunk supplies at least the main tree's raw fuel need — MORE, since the fuel tile is
  // itself heated (fuel-for-fuel), which the scalar fixpoint folds in.
  const mainFuel = r.tree.fuelPerMin; // the Kiln's own draw
  assert.ok(r.totals.fuelPerMin >= mainFuel, 'trunk must cover the main tree plus its own heat');
  assert.ok(r.totals.fuelPerMin > 0);
});

test('Phase 3: a farmed cauldron build draws a shared fert trunk and sizes nursery plots', () => {
  const comp = composer();
  const r = comp.compose('Clay', 30);
  assert.equal(r.tree.source, 'cauldron');
  assert.equal(r.tree.machine, 'Cauldron');
  const herb = kid(r.tree, 'Redcurrant');
  assert.equal(herb.machine, 'Nursery');
  assert.ok(herb.machineCount >= 1, 'nursery plots sized from the fert carrier maxFertility');
  assert.ok(/plot/.test(herb.nurseryNote || ''));
  assert.ok(r.fert && r.fert.item === 'Growth Potion', 'nurseries draw a Growth Potion fert trunk');
  assert.ok(r.totals.fertPerMin > 0);
});

test('Phase 3: replicated tiles get unique ids (a tile tree is a pure tree, no shared nodes)', () => {
  const comp = composer();
  const ids = collectIds(comp.compose('Glass', 60).tree);
  assert.equal(new Set(ids).size, ids.length, 'every tile id is unique under replication');
});

test('Phase 3: a minted coin links back to the main belt money line', () => {
  const comp = composer();
  // Charcoal’s canonical tree feeds a Copper Coin satisfied by minting (coins valued at sellPrice).
  const r = comp.compose('Charcoal', 10);
  assert.ok(r.summary.mintedCoins['Copper Coin'] > 0, 'minted coins are tracked for money-line wiring');
  assert.equal(r.totals.mintedCoins['Copper Coin'], r.summary.mintedCoins['Copper Coin']);
  // every buy/mint leaf draws copper from the money line, never free
  const findMint = (t) => (t.source === 'mint' ? t : (t.inputs || []).reduce((a, c) => a || findMint(c), null));
  const mint = findMint(r.tree);
  assert.ok(mint && mint.fromMoneyLine === true && mint.copperPerMin > 0 && mint.coinItem === 'Copper Coin');
});

test('Phase 3: same-item recirculation is netted (Steel Ingot returns 3 of its 4 Iron Ingot)', () => {
  // Steel Ingot [Athanor]: in {Iron Ingot:4, Coke Powder:4} → out {Steel Ingot:1, Iron Ingot:3}.
  // Net Iron Ingot consumption is 1/craft. Without netting the composer over-sizes the Iron Ingot
  // tile 4× and dumps the recirculated 3 as false co-product waste.
  const comp = makeComposer(db, resolveConfig({ maxTier: 10, canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } }));
  const r = comp.compose('Steel Gear', 30);          // 30 Steel Gear ⇒ 30 Steel Ingot/min
  const steel = kid(r.tree, 'Steel Ingot');
  const iron = kid(steel, 'Iron Ingot');
  assert.equal(iron.ratePerMin, 30);                 // net 1 Iron Ingot/Steel, NOT 120 (4× raw)
  assert.ok(!('Iron Ingot' in (steel.byproducts || {})), 'recirculated Iron Ingot is netted, not waste');
  // Coke Powder is genuinely consumed (4/craft, none returned) → stays at 120/min.
  assert.equal(kid(steel, 'Coke Powder').ratePerMin, 120);
});

test('nursery fertilizer is charged on the op axis (free fert → grown herb op is ~0)', () => {
  const comp = composer();
  // Redcurrant is grown; its op is the fertilizer it burns (nutrientCost × fert cost/nutrient) > 0.
  assert.ok(comp.opCost('Redcurrant') > 0, 'grown herb should carry a fertilizer operating cost');
  // With no canonical fert carrier, there is nothing to price the nutrient against → grow op is 0.
  const noFert = makeComposer(db, resolveConfig({ maxTier: 6, canonical: { fuelItem: 'Coke Powder' } }));
  assert.equal(noFert.opCost('Redcurrant'), 0);
});

test('Phase 7: reuse mode feeds a co-product into matching demand (Saturn Sand → fewer farms)', () => {
  // Saturn = Shaper{Salt, Brick, Glass}. Its Salt comes from Stone Crusher{Rock Salt} → 100 Salt +
  // 100 Sand co-product, and its Glass needs Sand. Reuse routes that Sand into the Glass demand, so
  // dedicated Sand farms (Grinders) shrink; trash mode builds them all and dumps the co-product.
  const reuse = composer({ byproducts: { mode: 'reuse' } }).compose('Saturn', 1);
  const trash = composer({ byproducts: { mode: 'trash' } }).compose('Saturn', 1);
  assert.ok(reuse.summary.machineTotals.Grinder < trash.summary.machineTotals.Grinder,
    'reuse builds fewer Sand grinders than trash');
  const fed = reuse.summary.coproductFeeds.find((f) => f.item === 'Sand');
  assert.ok(fed && fed.rate > 1, 'Sand is fed across tiles in reuse mode');
  assert.equal(trash.summary.coproductFeeds.length, 0, 'trash mode feeds nothing');
  // Money line drops too: 600/min of Sand no longer needs its bought Stone.
  assert.ok(reuse.summary.copperPerMin < trash.summary.copperPerMin, 'reuse spends less (free co-product)');
  // The co-fed amount never exceeds the gross co-product supply (Stone Crusher makes 600 Sand here).
  assert.ok(fed.rate <= 600 + 1e-6, 'feed bounded by genuine co-production');
});
