'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveComposerBody } = require('../src/composer-solve');
const { graphToIR, validateIR, machineTotalsFromIR } = require('../src/tile-ir');
const { layoutIR } = require('../web/render-ir');
const db = require('../data/alchemy_db.v41.json');

// ---- config builder: vary skills, tier, byproducts, cauldron pool, mainline belts ----
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
function solve(item, o, rate = 60) {
  return solveComposerBody({ item, rate, rateMode: 'rate', targets: [{ item, rate, rateMode: 'rate' }], config: cfg(o) }, db);
}

// ---- completeness checker: the "graph is complete" assertion ----
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
const contains = (o, i) => o.x <= i.x + 0.5 && o.y <= i.y + 0.5 && o.x + o.w >= i.x + i.w - 0.5 && o.y + o.h >= i.y + i.h - 0.5;
function checkLayout(ir, L) {
  const errs = [];
  const ids = [...ir.tiles.map((t) => t.id), ...ir.ports.map((p) => p.id)];
  // 1. every node placed, finite, within canvas
  for (const id of ids) {
    const p = L.pos.get(id);
    if (!p) { errs.push(`unplaced ${id}`); continue; }
    if (![p.x, p.y, p.w, p.h].every(Number.isFinite)) { errs.push(`non-finite ${id}`); continue; }
    if (p.x < -1 || p.y < -1 || p.x + p.w > L.width + 1 || p.y + p.h > L.height + 1) errs.push(`outside canvas ${id}`);
  }
  // 2. no two NODE rects overlap
  const rects = ids.map((id) => ({ id, p: L.pos.get(id) })).filter((r) => r.p);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i].p, rects[j].p)) errs.push(`node overlap ${rects[i].id} & ${rects[j].id}`);
  // 3. overlapping group boxes must be nested (one contains the other) — never partial overlap
  for (let i = 0; i < L.boxes.length; i++) for (let j = i + 1; j < L.boxes.length; j++) {
    const a = L.boxes[i], b = L.boxes[j];
    if (overlap(a, b) && !contains(a, b) && !contains(b, a)) errs.push(`improper box overlap ${a.key} & ${b.key}`);
  }
  // 4. a subtree box contains every tile of its subtree
  for (const box of L.boxes) {
    if (box.key == null) continue;
    for (const id of ids) {
      if (id !== box.key && !id.startsWith(box.key + '>')) continue;
      const p = L.pos.get(id);
      if (p && !contains(box, p)) errs.push(`box ${box.key} excludes member ${id}`);
    }
  }
  // 5. every belt endpoint is placed
  for (const b of ir.belts) { if (!L.pos.has(b.from)) errs.push(`belt from unplaced ${b.from}`); if (!L.pos.has(b.to)) errs.push(`belt to unplaced ${b.to}`); }
  // 6. counts faithful to the solve
  if (JSON.stringify(machineTotalsFromIR(ir)) !== JSON.stringify(ir._summaryTotals)) errs.push('machine totals diverge from solver');
  return errs;
}
function buildAndCheck(item, o, rate) {
  const out = solve(item, o, rate);
  if (out.status !== 'Optimal') return { status: out.status };
  const ir = graphToIR(out.graph);
  ir._summaryTotals = out.graph.summary.machineTotals;
  assert.deepEqual(validateIR(ir), [], `validateIR ${item}`);
  const L = layoutIR(ir);
  const errs = checkLayout(ir, L);
  return { status: 'Optimal', ir, L, errs };
}

// ---- 1. completeness across products / graph complexities ----
test('complete layout across products of varying complexity', () => {
  const products = ['Stone', 'Quicklime', 'Plant Ash', 'Basic Fertilizer', 'Advanced Fertilizer', 'Iron Ingot', 'Steel Ingot', 'Bandage'];
  for (const p of products) {
    const r = buildAndCheck(p, { maxTier: 5 });
    if (r.status !== 'Optimal') continue;
    assert.deepEqual(r.errs, [], `${p}: ${r.errs.join('; ')}`);
  }
});

// ---- 2. completeness across tiers ----
test('complete layout across tiers', () => {
  for (const maxTier of [3, 5, 7, 9]) {
    for (const p of ['Quicklime', 'Advanced Fertilizer', 'Steel Ingot']) {
      const r = buildAndCheck(p, { maxTier });
      if (r.status !== 'Optimal') continue;
      assert.deepEqual(r.errs, [], `${p}@t${maxTier}: ${r.errs.join('; ')}`);
    }
  }
});

// ---- 3. completeness across skill distributions ----
test('complete layout across skill distributions', () => {
  const skillSets = [
    ZERO,
    { factory: 8, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }, // 1:1
    { factory: 4, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }, // 2:1 belts-first
    { factory: 8, logistics: 8, alchemy: 8, fuel: 8, fertilizer: 8 }, // all
  ];
  for (const skills of skillSets) {
    const r = buildAndCheck('Advanced Fertilizer', { skills, maxTier: 5 });
    assert.equal(r.status, 'Optimal');
    assert.deepEqual(r.errs, [], `skills ${JSON.stringify(skills)}: ${r.errs.join('; ')}`);
  }
});

// ---- 4. completeness across mainline configurations ----
test('complete layout across mainline configurations', () => {
  const mains = [
    { belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], byproducts: 'trash' },
    { belt: [{ item: 'Copper Coin', rate: 60 }, { item: 'Charcoal Powder', rate: 60 }], byproducts: 'trash' },
    { belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], byproducts: 'reuse' },
    { belt: [{ item: 'Silver Coin', rate: 60 }], byproducts: 'reuse', pool: 'all' },
  ];
  for (const m of mains) {
    const r = buildAndCheck('Advanced Fertilizer', { ...m, maxTier: 5 });
    if (r.status !== 'Optimal') continue;
    assert.deepEqual(r.errs, [], `main ${JSON.stringify(m.belt.map((b) => b.item))}/${m.byproducts}: ${r.errs.join('; ')}`);
  }
});

// ---- 5. multi-target completeness (the line-absorption case) ----
test('complete layout for a multi-target build', () => {
  const out = solveComposerBody({ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate', targets: [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }], config: cfg({ byproducts: 'reuse', farmWeight: 3 }) }, db);
  assert.equal(out.status, 'Optimal');
  const ir = graphToIR(out.graph); ir._summaryTotals = out.graph.summary.machineTotals;
  assert.deepEqual(validateIR(ir), []);
  const L = layoutIR(ir);
  assert.deepEqual(checkLayout(ir, L), []);
});

// ---- 6. determinism ----
test('layout is deterministic', () => {
  const out = solve('Advanced Fertilizer', { maxTier: 5 });
  const ir = graphToIR(out.graph);
  const a = layoutIR(ir), b = layoutIR(ir);
  for (const [id, p] of a.pos) assert.deepEqual(b.pos.get(id), p);
});

// ---- 7. Panacea Potion: complete, structured, self-sustaining (over-produces to feed itself) ----
test('Panacea Potion lays out completely and is self-sustaining', () => {
  const r = buildAndCheck('Panacea Potion', { maxTier: 9, byproducts: 'reuse', farmWeight: 0 });
  assert.equal(r.status, 'Optimal', 'Panacea Potion solves at maxTier 9');
  // structured/laid-out properly: full completeness check passes
  assert.deepEqual(r.errs, [], `Panacea layout: ${r.errs.join('; ')}`);
  // designed to be self-sustaining: it over-produces fuel/fert to feed its own upstream — i.e. there
  // are fuel/fert back-edges (a producer feeding something upstream of itself).
  const out = solve('Panacea Potion', { maxTier: 9, byproducts: 'reuse' });
  const byKind = (kind) => out.graph.edges.filter((e) => e[kind]);
  const selfLoops = [...r.L.backEdges].map((k) => { const [from, to] = k.split('\t'); return out.graph.edges.find((e) => e.from === from && e.to === to); }).filter(Boolean);
  const fuelFertLoops = selfLoops.filter((e) => e.heat || e.nutrient);
  assert.ok(fuelFertLoops.length > 0, 'Panacea over-produces fuel/fert to self-sustain (has fuel/fert self-loops)');
  // and it actually produces fuel AND fert internally (not all bought off the mainline belt)
  assert.ok(byKind('heat').length > 0 && byKind('nutrient').length > 0, 'Panacea draws both heat and nutrient');
});
