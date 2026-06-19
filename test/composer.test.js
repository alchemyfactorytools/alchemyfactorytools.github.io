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
  // The contrast: the returned Iron Ingot is recorded as recirculation (3/craft × 30 = 90/min) and
  // netted out of the build, while Coke Powder is genuinely consumed (4/craft, none returned) so it
  // never appears as recirculation. (Coke is the fuel carrier here, so its 120/min material draw is
  // produced by the fuel trunk — the carrier-as-material merge — not as an inline child.)
  const recircOf = (item) => (steel.recirc || []).find((x) => x.item === item);
  assert.equal(recircOf('Iron Ingot') && recircOf('Iron Ingot').ratePerMin, 90, 'Iron Ingot recirculates 3/craft');
  assert.ok(!recircOf('Coke Powder'), 'Coke Powder is genuinely consumed, not recirculated');
});

test('nursery fertilizer is charged on the op axis (a grown crop is never free)', () => {
  const comp = composer();
  // Redcurrant is grown; its op is the nutrient it burns, priced at the cost-per-nutrient of the
  // cheapest fertilizer that sustains it at belt speed (nutrientCost × fert cost/nutrient) > 0.
  assert.ok(comp.opCost('Redcurrant') > 0, 'grown herb should carry a fertilizer operating cost');
  // That price is derived from the fertilizers in the item DB (anchored above zero by their bought
  // raws), NOT from the configured canonical fert CARRIER — so dropping the carrier neither zeroes
  // the cost nor changes it. (Older behaviour, now retired: no carrier → nothing to price → op 0.)
  const noFert = makeComposer(db, resolveConfig({ maxTier: 6, canonical: { fuelItem: 'Coke Powder' } }));
  assert.ok(noFert.opCost('Redcurrant') > 0, 'grown herb op stays positive with no canonical fert carrier');
  assert.equal(noFert.opCost('Redcurrant'), comp.opCost('Redcurrant'), 'nutrient price is carrier-independent');
});

test('Phase 7: within-tile co-product reuse feeds a co-product into matching demand (Saturn Sand), independent of byproducts.mode', () => {
  // Saturn = Shaper{Salt, Brick, Glass}. Its Salt comes from Stone Crusher{Rock Salt} → Salt +
  // Sand co-product, and its Glass needs Sand. Reuse routes that Sand straight into the Glass demand
  // instead of grinding dedicated Sand for it. This reuse is ALWAYS on — decoupled from byproducts.mode
  // (which the composer no longer reads; it now governs only UNCLAIMED surplus). So 'reuse' and 'trash'
  // compose identically here. The reuse pool is GLOBAL — it spans the main tree AND the fuel/fert trunks
  // — so Sand the fert/fuel trunk co-produces is reused too, not just the main Stone Crusher's.
  const reuse = composer({ byproducts: { mode: 'reuse' } }).compose('Saturn', 1);
  const trash = composer({ byproducts: { mode: 'trash' } }).compose('Saturn', 1);

  // The genuine gross Sand co-supply = every Sand byproduct across the forest trees AND the non-self
  // trunk prodTiles. A feed can never exceed it (material is conserved) — the claim is the same code
  // path that drops the consumer's dedicated grinding, so a populated feed IS the farm saving.
  const grossSand = (r) => {
    let v = 0;
    const walk = (t) => { v += (t.byproducts && t.byproducts.Sand) || 0; for (const c of t.inputs || []) walk(c); };
    const roots = new Set(r.trees.map((t) => t.tree));
    for (const t of r.trees) walk(t.tree);
    for (const tr of [r.fuel, r.fert]) if (tr && tr.prodTile && !roots.has(tr.prodTile)) walk(tr.prodTile);
    return v;
  };
  for (const [name, r] of [['reuse', reuse], ['trash', trash]]) {
    const fed = r.summary.coproductFeeds.find((f) => f.item === 'Sand');
    assert.ok(fed && fed.rate > 1, `Sand is fed across tiles in ${name} mode`);
    assert.ok(fed.rate <= grossSand(r) + 1e-6, `feed bounded by genuine co-production (forest + trunks) in ${name} mode`);
  }

  // Always-on reuse ⇒ a fully-claimed co-product composes identically in both modes: same farms, same spend.
  assert.equal(reuse.summary.machineTotals.Grinder, trash.summary.machineTotals.Grinder,
    'within-tile reuse runs in trash mode too → identical Sand grinder count');
  assert.equal(reuse.summary.copperPerMin, trash.summary.copperPerMin,
    'within-tile reuse runs in trash mode too → identical spend');
});

// ---- multi-target: a forest of targets sharing the fuel/fert trunks + co-product surplus ----

test('multi-target: compose([Glass, Brick]) builds a forest; shared fuel trunk is additive, per-tree sizing unchanged', () => {
  const comp = composer();
  const glass = comp.compose('Glass', 60);
  const brick = comp.compose('Brick', 30);
  const both = comp.compose([{ item: 'Glass', rate: 60 }, { item: 'Brick', rate: 30 }]);

  // forest shape: one root per target, in order; summary carries the per-target list
  assert.equal(both.trees.length, 2);
  assert.deepEqual(both.trees.map((t) => t.item), ['Glass', 'Brick']);
  assert.deepEqual(both.summary.targets, [{ item: 'Glass', ratePerMin: 60 }, { item: 'Brick', ratePerMin: 30 }]);

  // Each terminal tile is sized purely by its own output rate, so the per-tree roots match the
  // single-target builds (the forest replicates; it does not merge intermediates).
  assert.equal(both.trees[0].tree.machineCount, glass.tree.machineCount); // Glass Kilns
  assert.equal(both.trees[1].tree.machineCount, brick.tree.machineCount); // Brick Kilns
  // Kilns are per-tree (never shared) ⇒ the union is exactly additive.
  assert.equal(both.summary.machineTotals.Kiln, glass.summary.machineTotals.Kiln + brick.summary.machineTotals.Kiln);

  // The shared fuel trunk is sized to the COMBINED heat. Fuel is linear in heat (incl. the trunk's
  // own self-heat multiplier), so one shared trunk equals the sum of the two separate trunks.
  assert.ok(both.totals.fuelPerMin > glass.totals.fuelPerMin, 'combined trunk exceeds either target alone');
  assert.ok(Math.abs(both.totals.fuelPerMin - (glass.totals.fuelPerMin + brick.totals.fuelPerMin)) < 1e-6,
    'fuel is additive across the forest (linear in combined heat)');

  // Money-line spend is the sum of the two builds MINUS any cross-tile co-product reuse the forest
  // unlocks. Built alone, Brick over-produces Sand (trashed) and Glass grinds dedicated Sand; combined,
  // Brick's Sand surplus feeds Glass's demand, so the forest spends strictly LESS than the sum. The
  // reuse pool spans the whole forest, so building together can only ever help (≤ the separate sum).
  assert.ok(both.summary.coproductFeeds.some((f) => f.item === 'Sand'), 'forest reuses Brick\'s Sand surplus into Glass');
  assert.ok(both.summary.copperPerMin <= glass.summary.copperPerMin + brick.summary.copperPerMin + 1e-6,
    'forest spend never exceeds the sum of the separate builds (cross-tile co-product reuse only helps)');
});

test('multi-target: a single-element array is byte-identical to the scalar call (back-compat)', () => {
  const comp = composer();
  const scalar = comp.compose('Glass', 60);
  const arr = comp.compose([{ item: 'Glass', rate: 60 }]);
  assert.equal(arr.summary.target, 'Glass');           // back-compat scalar summary fields preserved
  assert.equal(arr.summary.ratePerMin, 60);
  assert.equal(arr.trees.length, 1);
  assert.equal(arr.tree, arr.trees[0].tree);           // .tree alias === the one root
  assert.deepEqual(arr.summary.machineTotals, scalar.summary.machineTotals);
  assert.equal(arr.summary.copperPerMin, scalar.summary.copperPerMin);
});

test('multi-target: the fuel carrier as one of several targets folds into the shared trunk (one line, no duplicate)', () => {
  const comp = composer(); // fuelItem Coke Powder
  const glass = comp.compose('Glass', 60);
  const both = comp.compose([{ item: 'Coke Powder', rate: 60 }, { item: 'Glass', rate: 60 }]);
  // The fuel carrier gets NO separate tree — it folds into the fuel trunk; only Glass is a tree.
  assert.deepEqual(both.trees.map((t) => t.item), ['Glass']);
  // …but it's still a declared target (counts for revenue/status) and is wired to its own demand sink.
  assert.deepEqual(both.summary.targets, [{ item: 'Coke Powder', ratePerMin: 60 }, { item: 'Glass', ratePerMin: 60 }]);
  assert.deepEqual(both.trunkDemands, [{ item: 'Coke Powder', rate: 60, trunk: 'fuel' }]);
  // One over-producing line: the trunk covers Glass's furnace heat PLUS the 60/min net output (and its
  // own self-heat), so it exceeds Glass-alone fuel + 60 — not two separate Coke lines.
  assert.ok(both.fuel.prodRate >= glass.totals.fuelPerMin + 60 - 1e-6, 'one trunk covers heat + net carrier output');
});
