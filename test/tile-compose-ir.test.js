'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveComposerBody } = require('../src/composer-solve');
const { composeTilesIR } = require('../src/tile-compose-ir');
const { beltSpeed } = require('../src/config');
const db = require('../data/alchemy_db.v41.json');

// ---- config builder (mirrors test/tile-ir.test.js) ----
const ZERO = { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 };
function cfg(o = {}) {
  return {
    cauldron: { enabled: true, inputPool: o.pool || 'easy' },
    byproducts: { mode: o.byproducts || 'trash' },
    machines: { defaultCount: 1000 },
    skills: o.skills || ZERO,
    solver: 'composer', selfFuel: o.selfFuel !== false, selfFert: o.selfFert !== false,
    steam: { enabled: false, mode: 'free' },
    belt: o.belt || [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }],
    capital: { enabled: true },
    buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: o.farmWeight || 0, maxTier: o.maxTier || 5,
  };
}
function buildIR(targets, o = {}) {
  const config = cfg(o);
  const solve = (body) => solveComposerBody(body, db);
  const t0 = targets[0];
  const out = solve({ item: t0.item, rate: t0.rate || 60, rateMode: t0.rateMode || 'rate', targets, config });
  if (out.status !== 'Optimal') return { status: out.status };
  const ir = composeTilesIR(out.graph, { solve, config, mode: o.mode || 'hybrid', isLiquid });
  return { status: 'Optimal', graph: out.graph, ir, BELT: beltSpeed(config.skills.logistics) };
}
const isLiquid = (item) => !!(db.items[item] && db.items[item].liquid);

// ---- helpers ----
const itemOf = (label) => String(label || '').split(' ⬅ ')[0]; // cauldron labels read "Item ⬅ cauldron(...)"
const grossByItem = (graph) => { const g = {}; for (const n of graph.nodes) if (n.machine && n.machineCount) { const it = itemOf(n.label); g[it] = (g[it] || 0) + (n.ratePerMin || 0); } return g; };
// distinct unit signature for an item: the SET of {count×machine@out} (stamp COUNT scales with demand, so excluded)
const unitSet = (ir, item) => [...new Set(ir.tiles.filter((t) => t.item === item).map((t) => `${t.count}×${t.machine}@${t.out.toFixed(3)}`))].sort().join(' | ');
// machine PICK set for an item: just the distinct machine names (skill-invariant per Gramaton P1)
const pickSet = (ir, item) => [...new Set(ir.tiles.filter((t) => t.item === item).map((t) => t.machine))].sort().join(' | ');

// ===== 1. canonical identity: an item's UNIT-SET is the same regardless of pairing =====
test('canonical identity — AdvFert units identical with and without a paired Bandage target', () => {
  const alone = buildIR([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
  const paired = buildIR([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);
  assert.equal(alone.status, 'Optimal'); assert.equal(paired.status, 'Optimal');
  for (const item of ['Advanced Fertilizer', 'Basic Fertilizer', 'Plant Ash', 'Quicklime']) {
    assert.equal(unitSet(alone.ir, item), unitSet(paired.ir, item), `${item} unit-set differs across pairing`);
  }
});

// ===== 2. canonical identity across skill regimes (Gramaton P1) =====
test('canonical identity — AdvFert units stable across skill distributions', () => {
  const skillSets = [ZERO, { factory: 8, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }, { factory: 4, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }];
  // the recipe PICK is skill-invariant (counts/output scale with skills, so compare machine pick only)
  const picks = skillSets.map((skills) => { const r = buildIR([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }], { skills }); assert.equal(r.status, 'Optimal'); return ['Advanced Fertilizer', 'Plant Ash', 'Quicklime', 'Stone'].map((it) => pickSet(r.ir, it)).join(' ;; '); });
  for (let i = 1; i < picks.length; i++) assert.equal(picks[i], picks[0], `skill regime ${i} changed a recipe pick`);
});

// ===== 3. belt caps — every tile and every material/fuel/fert belt fits one belt =====
test('belt caps — tiles and physical belts never exceed one belt', () => {
  for (const item of ['Advanced Fertilizer', 'Steel Ingot', 'Bandage', 'Quicklime']) {
    const r = buildIR([{ item, rate: 60, rateMode: 'rate' }]);
    if (r.status !== 'Optimal') continue;
    for (const t of r.ir.tiles) if (!isLiquid(t.item)) assert.ok(t.out <= r.BELT + 1e-6, `${item}: tile ${t.id} out ${t.out} > belt ${r.BELT}`);
    for (const b of r.ir.belts) if (b.kind !== 'cash' && !isLiquid(b.item)) assert.ok(b.rate <= r.BELT + 1e-6, `${item}: belt ${b.from}->${b.to} ${b.rate} > belt`);
  }
});

// ===== 4. coverage + machine faithfulness at the PROVEN regime (maxTier 5) =====
test('proven regime — every item covered and machine total matches the composer', () => {
  for (const skills of [ZERO, { factory: 8, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }, { factory: 4, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }]) {
    const r = buildIR([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }], { skills });
    assert.equal(r.status, 'Optimal');
    const gross = grossByItem(r.graph);
    const outByItem = {}; for (const t of r.ir.tiles) outByItem[t.item] = (outByItem[t.item] || 0) + t.out;
    for (const it in gross) assert.ok((outByItem[it] || 0) >= gross[it] - 1e-3, `shortfall on ${it}: ${outByItem[it]} < ${gross[it]}`);
    const compMach = Object.values(r.graph.nodes.filter((n) => n.machine && n.machineCount)).reduce((s, n) => s + n.machineCount, 0);
    const tileMach = r.ir.tiles.reduce((s, t) => s + t.count, 0);
    assert.equal(tileMach, compMach, `machine total ${tileMach} != composer ${compMach} (skills ${JSON.stringify(skills)})`);
  }
});

// ===== 5. structural completeness across products + tiers (no strict counts at high tier) =====
test('structural — every produced item has tiles, no dangling belts, acyclic material flow', () => {
  const cases = [
    ['Advanced Fertilizer', 5], ['Steel Ingot', 5], ['Bandage', 5], ['Quicklime', 7], ['Steel Ingot', 9],
  ];
  for (const [item, maxTier] of cases) {
    const r = buildIR([{ item, rate: 60, rateMode: 'rate' }], { maxTier });
    if (r.status !== 'Optimal') continue;
    const ids = new Set([...r.ir.tiles.map((t) => t.id), ...r.ir.ports.map((p) => p.id)]);
    // every produced item gets at least one tile
    for (const it in grossByItem(r.graph)) assert.ok(r.ir.tiles.some((t) => t.item === it), `${item}@t${maxTier}: no tile for produced ${it}`);
    // no dangling belt endpoints
    for (const b of r.ir.belts) { assert.ok(ids.has(b.from), `${item}@t${maxTier}: dangling from ${b.from}`); assert.ok(ids.has(b.to), `${item}@t${maxTier}: dangling to ${b.to}`); }
    // material flow is acyclic (fuel/fert/cash may loop; material must not)
    const adj = new Map(); for (const t of r.ir.tiles) adj.set(t.id, []);
    for (const b of r.ir.belts) if (b.kind === 'material' && adj.has(b.from) && adj.has(b.to)) adj.get(b.from).push(b.to);
    const WHITE = 0, GREY = 1, BLACK = 2; const color = new Map([...adj.keys()].map((k) => [k, WHITE])); let cyclic = false;
    const visit = (u) => { color.set(u, GREY); for (const v of adj.get(u)) { if (color.get(v) === GREY) { cyclic = true; return; } if (color.get(v) === WHITE) visit(v); } color.set(u, BLACK); };
    for (const k of adj.keys()) if (color.get(k) === WHITE) visit(k);
    assert.ok(!cyclic, `${item}@t${maxTier}: material belts contain a cycle`);
  }
});

// ===== 6. Panacea Potion (high tier) — no crash, structurally valid, belt-capped =====
test('Panacea Potion composes without crashing and stays belt-capped', () => {
  const r = buildIR([{ item: 'Panacea Potion', rate: 6, rateMode: 'rate' }], { maxTier: 9 });
  if (r.status !== 'Optimal') return; // infeasible config is acceptable; the assertion is "no crash"
  assert.ok(r.ir.tiles.length > 0);
  for (const t of r.ir.tiles) if (!isLiquid(t.item)) assert.ok(t.out <= r.BELT + 1e-6, `Panacea tile ${t.id} over belt`);
  for (const b of r.ir.belts) if (b.kind !== 'cash' && !isLiquid(b.item)) assert.ok(b.rate <= r.BELT + 1e-6, 'Panacea belt over cap');
  const ids = new Set([...r.ir.tiles.map((t) => t.id), ...r.ir.ports.map((p) => p.id)]);
  for (const b of r.ir.belts) { assert.ok(ids.has(b.from)); assert.ok(ids.has(b.to)); }
});
