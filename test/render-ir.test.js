'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { solveComposerBody } = require('../src/composer-solve');
const { graphToIR } = require('../src/tile-ir');
const { layoutIR } = require('../web/render-ir');
const db = require('../data/alchemy_db.v41.json');

const CONFIG = {
  cauldron: { enabled: true, inputPool: 'easy' }, byproducts: { mode: 'reuse' },
  machines: { defaultCount: 1000 }, skills: { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 },
  solver: 'composer', selfFuel: true, selfFert: true, steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 3, maxTier: 5,
};
const ir = (targets) => graphToIR(solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: CONFIG }, db).graph);

test('layoutIR places every node, no NaN, within canvas', () => {
  const g = ir([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);
  const L = layoutIR(g);
  const all = [...g.tiles.map((t) => t.id), ...g.ports.map((p) => p.id)];
  for (const id of all) {
    const p = L.pos.get(id);
    assert.ok(p, `node ${id} positioned`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `node ${id} finite pos`);
    assert.ok(p.x >= 0 && p.y >= 0, `node ${id} non-negative`);
    assert.ok(p.x <= L.width + 1 && p.y <= L.height + 1, `node ${id} within canvas`);
  }
  assert.ok(L.width > 0 && L.height > 0);
});

test('layoutIR emits one hull per solver group', () => {
  const g = ir([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);
  const L = layoutIR(g);
  const groups = new Set([...g.tiles.map((t) => t.group), ...g.ports.map((p) => p.group)]);
  const hulls = new Set(L.groups.map((h) => h.key));
  assert.deepEqual(hulls, groups);
});

test('layoutIR is deterministic (same IR -> same positions)', () => {
  const g = ir([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
  const a = layoutIR(g), b = layoutIR(g);
  for (const [id, p] of a.pos) assert.deepEqual(b.pos.get(id), p);
});
