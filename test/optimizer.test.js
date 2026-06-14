// Optimizer regression suite: the Mars canonical scenarios (DESIGN.md §4) plus
// config-override and byproduct-policy behaviors.
//
// Numeric pins are from THIS solver, cross-checked against DESIGN.md's
// hand-traced estimates where available (Scenario A: 160,037 vs DESIGN ~161,800,
// within 1.1% — the residual is heat-accounting detail the hand trace skipped).

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProcessTable } = require('../src/normalize');
const { resolveConfig } = require('../src/config');
const { Model, optimize, minMachines } = require('../src/model');
const db = require('../data/alchemy_db.v41.json');

const solve = (cfgOverrides, opts) => {
  const pt = buildProcessTable(db, resolveConfig(cfgOverrides));
  return optimize(new Model(pt, db), opts);
};

const MARS = { demand: { Mars: 0.1 } };

test('Scenario A: buyables-only, no farming — INFEASIBLE without cauldron', async () => {
  const r = await solve({ cauldron: { enabled: false }, selfFert: false }, MARS);
  assert.equal(r.status, 'Infeasible');
});

test('Scenario A: cauldron unlocks Mars; GG×3→ICP route active; ~160k/Mars uncapacitated', async () => {
  // capital off isolates the material cost (DESIGN's ~161.8k hand trace → 160,037 here)
  const rMat = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 }, capital: { enabled: false } },
    MARS,
  );
  assert.ok(Math.abs(rMat.objective / 0.1 - 160037) < 100, `material per-Mars ${rMat.objective / 0.1}`);
  // with capital on (default) the cauldron shortcut still wins; cost is modestly higher
  const r = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 } },
    MARS,
  );
  assert.equal(r.status, 'Optimal');
  const perMars = r.objective / 0.1;
  assert.ok(perMars > 160037 && perMars < 167000, `per-Mars w/ capital ${perMars}`);
  const gg = r.flows.find((f) => f.process.kind === 'cauldron' && f.process.consumes['Gelatinous Gridlock'] === 3);
  assert.ok(gg, 'GG×3 cauldron shortcut must survive capital pricing');
  assert.equal(Object.keys(gg.process.produces)[0], 'Impure Copper Powder');
});

test('Scenario B: farming available — MIXED basis (Athanor recipe AND GG cauldron both active)', async () => {
  const r = await solve({ cauldron: { enabled: true, inputPool: 'buyables' } }, MARS);
  assert.equal(r.status, 'Optimal');
  const athanor = r.flows.find((f) => f.process.id === 'recipe:Copper Powder');
  const gg = r.flows.find((f) => f.process.kind === 'cauldron' && f.process.consumes['Gelatinous Gridlock'] === 3);
  assert.ok(athanor && athanor.rate > 1, 'Athanor CP+ICP joint recipe active');
  assert.ok(gg && gg.rate > 1, 'GG cauldron marginal ICP supply active');
  // the joint-product credit makes B strictly cheaper than A
  const a = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false },
    MARS,
  );
  assert.ok(r.objective < a.objective, `B (${r.objective}) should beat A (${a.objective})`);
});

test('Scenario C: unrestricted crafted-input triples — materially self-sustaining (cost ≈ 0), bounded LP', async () => {
  // capital off isolates material cost — the loop regime drives it to ~0
  const r = await solve({ machines: { defaultCount: 50 }, capital: { enabled: false } }, MARS);
  assert.equal(r.status, 'Optimal');
  assert.ok(r.objective < 1, `loop regime should drive material cost to ~0, got ${r.objective}`);
  // with capital on (default), the loop's machines cost real gold, so it's no
  // longer free — this is what stops the optimizer building absurd machine counts
  const rc = await solve({ machines: { defaultCount: 50 } }, MARS);
  assert.ok(rc.objective > r.objective, 'capital pricing makes the loop cost more than material alone');
});

test('capital off: no degenerate floating production (activation-floor polish drops useless loops)', async () => {
  // With capital off, all-intermediate processes are net-zero, so the LP is
  // degenerate and used to return optima spinning useless side-loops (e.g. extra
  // Copper → Copper Coin → cauldron → Clay → Clay Powder, all discarded). The
  // polish solve must select the minimal-machine-second optimum, dropping them.
  const r = await solve(
    { belt: [{ item: 'Coke Powder' }], machines: { defaultCount: 1000 }, capital: { enabled: false } },
    MARS,
  );
  assert.equal(r.status, 'Optimal');
  const prod = {}, cons = {};
  for (const f of r.flows) {
    for (const [k, v] of Object.entries(f.process.produces || {})) prod[k] = (prod[k] || 0) + v * f.rate;
    for (const [k, v] of Object.entries(f.process.consumes || {})) cons[k] = (cons[k] || 0) + v * f.rate;
  }
  // Clay Powder is never needed for Mars — the dead-end loop that fabricated it
  // (Copper → Copper Coin → cauldron → Clay → Clay Powder → discard) must be gone.
  assert.ok((prod['Clay Powder'] || 0) < 1e-6, `no fabricated Clay Powder, got ${prod['Clay Powder']}`);
  // No large discarded dead-ends: every item is either consumed or a small joint
  // byproduct (the Athanor Copper/Impure-Copper co-product surplus is legitimate).
  for (const it of Object.keys(prod)) {
    if (it === 'Mars') continue;
    const surplus = (prod[it] || 0) - (cons[it] || 0);
    assert.ok(surplus < 5, `${it} surplus ${surplus.toFixed(2)} looks like a fabricated dead-end loop`);
  }
});

test('capital: planks come from logs (Table Saw), not a cauldron — build cost dominates', async () => {
  // the canonical bug: in the free-loop regime a cauldron-plank route is 0 material
  // gold, so without capital pricing the optimizer picks dozens of expensive cauldrons
  const noCap = await solve({ machines: { defaultCount: 1000 }, capital: { enabled: false } }, { demand: { Plank: 1200 } });
  const cauldronPlank = noCap.flows.find((f) => f.process.kind === 'cauldron' && f.process.produces['Plank']);
  assert.ok(cauldronPlank, 'without capital, the free cauldron-plank route is chosen');

  const withCap = await solve({ machines: { defaultCount: 1000 } }, { demand: { Plank: 1200 } });
  const tableSaw = withCap.flows.find((f) => f.process.machine === 'Table Saw' && f.process.produces['Plank']);
  const cauldron = withCap.flows.find((f) => f.process.kind === 'cauldron' && f.process.produces['Plank']);
  assert.ok(tableSaw, 'with capital, planks come from the Table Saw (logs)');
  assert.equal(cauldron, undefined, 'no cauldron should make planks once build cost is priced');
});

test('capital: a Cauldron is valued far above a Table Saw (build-cost ordering)', () => {
  const pt = buildProcessTable(db, resolveConfig({ machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  assert.ok(model.buildCopper['Cauldron'] > 100 * model.buildCopper['Table Saw'],
    `Cauldron (${model.buildCopper['Cauldron']}) should cost ≫ Table Saw (${model.buildCopper['Table Saw']})`);
});

test('override: forbid-cauldron for ICP removes the shortcut and forces the Athanor route', async () => {
  const base = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 } },
    MARS,
  );
  const forbidden = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables', forbidFor: ['Impure Copper Powder'] }, selfFert: false, machines: { defaultCount: 1000 } },
    MARS,
  );
  // without farming the Athanor route needs Soap Powder (crops) — Scenario A becomes infeasible again
  assert.equal(forbidden.status, 'Infeasible');
  assert.equal(base.status, 'Optimal');
  // with farming, forbidding ICP-via-cauldron forces all ICP through the Athanor recipe
  const withFarming = await solve(
    { cauldron: { enabled: true, inputPool: 'buyables', forbidFor: ['Impure Copper Powder'] }, machines: { defaultCount: 1000 } },
    MARS,
  );
  assert.equal(withFarming.status, 'Optimal');
  const cauldronICP = withFarming.flows.find(
    (f) => f.process.kind === 'cauldron' && f.process.produces['Impure Copper Powder'],
  );
  assert.equal(cauldronICP, undefined, 'no cauldron column may produce forbidden ICP');
});

test('override: force-cauldron for ICP drops the machine route for it', async () => {
  const pt = buildProcessTable(db, resolveConfig({
    cauldron: { enabled: true, inputPool: 'buyables', forceFor: ['Impure Copper Powder'] },
    machines: { defaultCount: 1000 },
  }));
  // the Athanor joint recipe's primary is Copper Powder, so it survives; a recipe
  // whose PRIMARY is ICP would be dropped (none exists in v41 — assert the rule
  // via the normalizer's behavior on primaries)
  assert.ok(pt.processes.find((p) => p.id === 'recipe:Copper Powder'), 'CP-primary joint recipe survives');
  assert.equal(pt.processes.find((p) => p.kind === 'recipe' && p.primary === 'Impure Copper Powder'), undefined);
  const r = await optimize(new Model(pt, db), MARS);
  assert.equal(r.status, 'Optimal');
});

test('override: force-cauldron for a non-cauldron-producible item throws', () => {
  assert.throws(
    () => buildProcessTable(db, resolveConfig({ cauldron: { forceFor: ['Mars'] } })),
    /cannot be cauldron-made/,
  );
});

test('override: forbid + force on the same item is rejected', () => {
  assert.throws(
    () => resolveConfig({ cauldron: { forbidFor: ['Obsidian'], forceFor: ['Obsidian'] } }),
    /both forbidden and forced/,
  );
});

test('byproducts: trash mode is strictly more expensive than reuse (joint-product credit lost)', async () => {
  const base = { cauldron: { enabled: true, inputPool: 'buyables' }, machines: { defaultCount: 1000 } };
  const reuse = await solve(base, MARS);
  const trash = await solve({ ...base, byproducts: { mode: 'trash' } }, MARS);
  assert.equal(reuse.status, 'Optimal');
  assert.equal(trash.status, 'Optimal');
  assert.ok(trash.objective > reuse.objective * 1.05,
    `trash (${trash.objective}) should cost >5% more than reuse (${reuse.objective})`);
});

test('byproducts: per-item trash override removes just that item from recipe outputs', () => {
  const pt = buildProcessTable(db, resolveConfig({
    byproducts: { mode: 'reuse', perItem: { 'Crude Silver Powder': 'trash' } },
  }));
  const silver = pt.processes.find((p) => p.id === 'recipe:Silver Powder');
  assert.equal(silver.produces['Crude Silver Powder'], undefined);
  assert.ok(silver.produces['Silver Powder'] > 0);
  const steel = pt.processes.find((p) => p.id === 'recipe:Steel Ingot');
  assert.ok(steel.consumes['Iron Ingot'] === 1, 'same-item netting unaffected by byproduct policy');
});

test('byproducts: sell mode adds sale columns only for byproduct items in cost mode', async () => {
  const base = { cauldron: { enabled: false }, machines: { defaultCount: 1000 } };
  const reuse = await solve(base, { demand: { 'Silver Powder': 1 } });
  const sellMode = await solve({ ...base, byproducts: { mode: 'sell' } }, { demand: { 'Silver Powder': 1 } });
  assert.equal(reuse.status, 'Optimal');
  assert.equal(sellMode.status, 'Optimal');
  assert.ok(sellMode.objective <= reuse.objective + 1e-6,
    'selling byproducts can only reduce net cost');
});

test('byproducts: sell mode cannot manufacture sellables for profit (no arbitrage)', async () => {
  // Regression: minting near-free coins → cauldroning gems (Emerald) → selling them
  // drove the objective to ~ −160M. Co-products are now fenced to byprod:: rows, so
  // an item made as a PRIMARY (the cauldron's Emerald) can't reach the sale column.
  const base = { belt: [{ item: 'Coke Powder' }], machines: { defaultCount: 1000 } };
  const sell = await solve({ ...base, byproducts: { mode: 'sell' } }, MARS);
  assert.equal(sell.status, 'Optimal');
  assert.ok(sell.objective > 0, `no money-printer — objective ${sell.objective} must stay positive`);
  // every active byproduct sale draws a fenced byprod:: row, never a normal item
  for (const f of sell.flows.filter((x) => x.process.kind === 'sale')) {
    assert.ok(Object.keys(f.process.consumes)[0].startsWith('byprod::'),
      'byproduct sales consume a fenced byprod:: row, not a manufacturable item');
  }
});

test('belt supply: fuel/fert/cash only — a fuel belt cannot supply recipe material', async () => {
  // belt Coke Powder may FUEL machines but must not satisfy the 4× Coke Powder a
  // Steel Ingot recipe eats; that has to be crafted.
  const r = await solve({ belt: [{ item: 'Coke Powder' }], machines: { defaultCount: 1000 } }, MARS);
  assert.equal(r.status, 'Optimal');
  const belt = r.flows.find((f) => f.process.kind === 'belt' && f.process.item === 'Coke Powder');
  assert.deepEqual(belt.process.produces, { 'belt::Coke Powder': 1 }, 'belt supplies a fenced belt:: row');
  const beltBurn = r.flows.find((f) => f.process.id === 'burn:Coke Powder@belt');
  assert.ok(beltBurn && beltBurn.process.consumes['belt::Coke Powder'], 'belt Coke is burned for heat');
  const craftedCoke = r.flows.find((f) => f.process.id === 'recipe:Coke Powder');
  assert.ok(craftedCoke && craftedCoke.rate > 0, 'material Coke Powder is crafted, not pulled off the belt');
  for (const f of r.flows.filter((x) => x.process.kind === 'recipe')) {
    for (const inp of Object.keys(f.process.consumes)) {
      assert.ok(!inp.startsWith('belt::'), `recipe ${f.process.id} must not consume belt:: material`);
    }
  }
});

test('belt supply: a non-fuel/fert/cash item is rejected with a warning', () => {
  const pt = buildProcessTable(db, resolveConfig({ belt: [{ item: 'Iron Ingot' }], machines: { defaultCount: 1000 } }));
  assert.ok(!pt.processes.some((p) => p.kind === 'belt' && p.item === 'Iron Ingot'), 'no belt column for a material item');
  assert.ok(pt.warnings.some((w) => /Iron Ingot.*fuel\/fertilizer\/cash/.test(w)), 'warns the material belt item was ignored');
});

test('self-fuel off restricts burning to buyable fuels', () => {
  const pt = buildProcessTable(db, resolveConfig({ selfFuel: false }));
  for (const p of pt.processes.filter((x) => x.kind === 'burn' && !(x.flags && x.flags.belt))) {
    const item = Object.keys(p.consumes)[0];
    assert.notEqual(db.items[item].buyPrice, undefined, `${item} must be buyable when selfFuel=false`);
  }
});

test('min-machines MIP returns integer dedication counts covering the plan', async () => {
  const pt = buildProcessTable(db, resolveConfig({ cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  const demand = { 'Bronze Ingot': 20 };
  const cost = await optimize(model, { demand });
  assert.equal(cost.status, 'Optimal');
  const mm = await minMachines(model, cost, { demand });
  assert.equal(mm.status, 'Optimal');
  assert.ok(mm.totalMachines >= 1);
  for (const m of mm.machines) assert.ok(Number.isInteger(m.count) && m.count > 0);
});

test('skills shift the optimum: factory speed raises capacity; fuel skill cuts fuel spend', async () => {
  const tight = { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 12 } };
  const lvl0 = await solve(tight, MARS);
  const lvl12 = await solve({ ...tight, skills: { factory: 12 } }, MARS);
  // at 12 machines each, level-0 is capacity-infeasible; factory 12 quadruples capacity
  assert.equal(lvl0.status, 'Infeasible');
  assert.equal(lvl12.status, 'Optimal');
});

test('unlock tier: maxTier gates items above the tier (Lavender is tier 7)', async () => {
  // Lavender Essential Oil needs Lavender (tier 7)
  const unlocked = await solve({ maxTier: 7, machines: { defaultCount: 1000 } }, { demand: { 'Lavender Essential Oil': 10 } });
  assert.equal(unlocked.status, 'Optimal');
  const locked = await solve({ maxTier: 6, machines: { defaultCount: 1000 } }, { demand: { 'Lavender Essential Oil': 10 } });
  assert.equal(locked.status, 'Infeasible', 'Lavender (tier 7) locked at maxTier 6');
  // no column may touch a locked item
  const pt = buildProcessTable(db, resolveConfig({ maxTier: 6 }));
  assert.equal(pt.processes.some((p) => p.produces['Lavender'] || p.consumes['Lavender']), false);
  // cauldron triples above tier are gated too
  const ptC = buildProcessTable(db, resolveConfig({ maxTier: 6, cauldron: { enabled: true } }));
  assert.ok(ptC.cauldron.eligibleCount < buildProcessTable(db, resolveConfig({ cauldron: { enabled: true } })).cauldron.eligibleCount,
    'fewer cauldron triples eligible when high-tier inputs are locked');
});

test('unlock tier: null (default) leaves everything available', async () => {
  const all = await solve({ machines: { defaultCount: 1000 } }, { demand: { 'Lavender Essential Oil': 10 } });
  assert.equal(all.status, 'Optimal');
});

test('column generation: finds the cheap cauldron route for Salt (not the pricier Athanor)', async () => {
  // regression for a CG convergence bug: the admission cap was filled by
  // already-admitted columns and reduced cost omitted capital, so the cheap
  // Salt cauldron column (rc ≈ −40) was never admitted and Salt fell back to a
  // ~41 g/unit Athanor route instead of ~5 g/unit via cauldron.
  const r = await solve({ machines: { defaultCount: 1000 } }, { demand: { Salt: 100 } });
  assert.equal(r.status, 'Optimal');
  const perSalt = r.objective / 100;
  assert.ok(perSalt < 10, `Salt should be ~5 g via cauldron, got ${perSalt}`);
  const cauldron = r.flows.find((f) => f.process.kind === 'cauldron' && f.process.produces['Salt']);
  assert.ok(cauldron, 'Salt comes from the (cheaper) cauldron route');
  // forcing the cauldron must not be cheaper than the free optimum — i.e. the
  // default solve already found the cauldron route, not a pricier fallback
  const forced = await solve({ cauldron: { enabled: true, forceFor: ['Salt'] }, machines: { defaultCount: 1000 } }, { demand: { Salt: 100 } });
  assert.ok(Math.abs(forced.objective - r.objective) < r.objective * 0.05,
    `default (${r.objective}) should match forced-cauldron (${forced.objective}) — CG found the optimum`);
});

test('effective tiers: crafted high-tier items are gated (Silver Ingot 8, Ruby 9), not just raws', async () => {
  const { tiers } = require('../src/tiers');
  const T = tiers(db);
  assert.equal(T.effective('Silver Ingot'), 8);
  assert.equal(T.effective('Ruby'), 9);
  assert.equal(T.effective('Crude Gold Dust'), 8);
  assert.ok(T.effective('Iron Ingot') <= 6 && T.effective('Linen') <= 6, 'common items stay low-tier');
  // at tier 6, no above-tier item appears in a Mars plan
  const r = await solve({ maxTier: 6, machines: { defaultCount: 1000 } }, { demand: { Mars: 0.1 } });
  assert.equal(r.status, 'Optimal');
  const banned = new Set(['Silver Ingot', 'Ruby', 'Crude Gold Dust', 'Gold Dust', 'Silver Coin', 'Gold Coin', 'Meteorite']);
  for (const f of r.flows) {
    for (const k of [...Object.keys(f.process.consumes), ...Object.keys(f.process.produces)]) {
      assert.ok(!banned.has(k), `tier-6 plan must not use ${k}`);
    }
  }
  // the cauldron (tier 6) is locked below its tier
  const pt5 = buildProcessTable(db, resolveConfig({ maxTier: 5 }));
  assert.equal(pt5.cauldron, null, 'cauldron locked below tier 6');
});
