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

test('nursery fertilizer is charged on the op axis (free fert → grown herb op is ~0)', () => {
  const comp = composer();
  // Redcurrant is grown; its op is the fertilizer it burns (nutrientCost × fert cost/nutrient) > 0.
  assert.ok(comp.opCost('Redcurrant') > 0, 'grown herb should carry a fertilizer operating cost');
  // With no canonical fert carrier, there is nothing to price the nutrient against → grow op is 0.
  const noFert = makeComposer(db, resolveConfig({ maxTier: 6, canonical: { fuelItem: 'Coke Powder' } }));
  assert.equal(noFert.opCost('Redcurrant'), 0);
});
