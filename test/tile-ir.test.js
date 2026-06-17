'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveComposerBody } = require('../src/composer-solve');
const { graphToIR, validateIR, machineTotalsFromIR } = require('../src/tile-ir');
const db = require('../data/alchemy_db.v41.json');

const CONFIG = {
  cauldron: { enabled: true, inputPool: 'easy' }, byproducts: { mode: 'reuse' },
  machines: { defaultCount: 1000 }, skills: { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 },
  solver: 'composer', selfFuel: true, selfFert: true, steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 3, maxTier: 5,
};
function solveBuild(targets) {
  return solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: CONFIG }, db);
}
const AF_BANDAGE = [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }];

test('IR validates structurally (integer counts, no dangling belts)', () => {
  const out = solveBuild(AF_BANDAGE);
  assert.equal(out.status, 'Optimal');
  const ir = graphToIR(out.graph);
  assert.deepEqual(validateIR(ir), []);
  assert.ok(ir.tiles.length > 0 && ir.belts.length > 0);
});

test('IR machine counts are faithful to the solver (no re-derivation)', () => {
  // This is the guarantee the current renderer cannot make: the IR carries the solve's counts
  // EXACTLY, so the picture cannot disagree with the flows.
  const out = solveBuild(AF_BANDAGE);
  const ir = graphToIR(out.graph);
  assert.deepEqual(machineTotalsFromIR(ir), out.graph.summary.machineTotals);
});

test('grouping is the composer structure, not a re-clustering — no line absorption', () => {
  // The Advanced Fertilizer + Bandage build is the exact case where the old clusterer absorbed the
  // fert line into the consumer. With IR grouping taken from the node tree-path, that is impossible:
  // every AdvFert-chain tile is in the Advanced Fertilizer group, every Bandage-chain tile in Bandage.
  const out = solveBuild(AF_BANDAGE);
  const ir = graphToIR(out.graph);
  const adv = ir.tiles.filter((t) => t.id.startsWith('Advanced Fertilizer'));
  const ban = ir.tiles.filter((t) => t.id.startsWith('Bandage'));
  assert.ok(adv.length > 0, 'has Advanced Fertilizer tiles');
  assert.ok(ban.length > 0, 'has Bandage tiles');
  assert.ok(adv.every((t) => t.line === 'Advanced Fertilizer'), 'AdvFert chain stays in its own line');
  assert.ok(ban.every((t) => t.line === 'Bandage'), 'Bandage chain stays in its own line');
});

test('single-target build also round-trips faithfully', () => {
  const out = solveBuild([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
  const ir = graphToIR(out.graph);
  assert.deepEqual(validateIR(ir), []);
  assert.deepEqual(machineTotalsFromIR(ir), out.graph.summary.machineTotals);
});

test('IR drops nothing — every graph node and edge is represented', () => {
  for (const targets of [AF_BANDAGE, [{ item: 'Panacea Potion', rate: 60, rateMode: 'rate' }]]) {
    const config = targets[0].item === 'Panacea Potion' ? { ...CONFIG, maxTier: 9 } : CONFIG;
    const out = solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode, targets, config }, db);
    assert.equal(out.status, 'Optimal', targets[0].item);
    const ir = graphToIR(out.graph);
    const irIds = new Set([...ir.tiles.map((t) => t.id), ...ir.ports.map((p) => p.id)]);
    assert.equal(irIds.size, out.graph.nodes.length, `${targets[0].item}: every node represented`);
    for (const n of out.graph.nodes) assert.ok(irIds.has(n.id), `node ${n.id} present`);
    const edgeCount = out.graph.edges.filter((e) => e.from !== e.to).length;
    assert.equal(ir.belts.length, edgeCount, `${targets[0].item}: every edge represented`);
  }
});
