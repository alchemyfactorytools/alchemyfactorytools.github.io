// Golden test suite (DESIGN.md §4) — pinned cauldron-formula behaviors for
// dataset v41 / game 0.5.0.4471. Every value here was verified against the
// compiler's exact arithmetic; if a game patch changes cauldronCost/Target
// values these tests are EXPECTED to fail and must be re-pinned deliberately.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileCauldron, resolveTriple, cauldronStats, validateCuratedRows } = require('../src/cauldron');
const db = require('../data/alchemy_db.v41.json');

const compiled = compileCauldron(db);
const triple = (...names) => resolveTriple(db, names, compiled);

test('dataset header is the expected version', () => {
  assert.equal(db.gameVersion, '0.5.0.4471');
  assert.equal(db.version, 41);
});

test('enumeration size: 135 eligible inputs → C(137,3) = 419,220 triples', () => {
  assert.equal(compiled.inputs.length, 135);
  assert.equal(compiled.targets.length, 47);
  assert.equal(compiled.count, 419220);
});

test('Gelatinous Gridlock ×3 → Impure Copper Powder (T=150, d=30, margin 12 over Turquoise)', () => {
  const r = triple('Gelatinous Gridlock', 'Gelatinous Gridlock', 'Gelatinous Gridlock');
  assert.equal(r.output, 'Impure Copper Powder');
  assert.equal(r.T, 150);
  assert.equal(r.ratio, 0.5);
  assert.equal(r.distance, 30);
  assert.equal(r.runnerUp, 'Turquoise');
  assert.equal(r.margin, 12);
  assert.equal(r.exactTie, false);
});

test('Flax Seeds ×3 → Impure Copper Powder (T=172.5, d=7.5)', () => {
  const r = triple('Flax Seeds', 'Flax Seeds', 'Flax Seeds');
  assert.equal(r.output, 'Impure Copper Powder');
  assert.equal(r.T, 172.5);
  assert.equal(r.distance, 7.5);
});

test('Quartz Ore + Flax Seeds + Limestone → Copper Powder (T=348, d=2)', () => {
  const r = triple('Quartz Ore', 'Flax Seeds', 'Limestone');
  assert.equal(r.output, 'Copper Powder');
  assert.equal(r.T, 348);
  assert.equal(r.distance, 2);
});

test('exact tie: Sage Seeds + Flax Seeds + Rock Salt, T=325 → Copper Powder (id 608) over Black Powder (id 614)', () => {
  const r = triple('Sage Seeds', 'Flax Seeds', 'Rock Salt');
  assert.equal(r.T, 325);
  assert.equal(r.exactTie, true);
  assert.equal(r.output, 'Copper Powder');
  assert.equal(r.runnerUp, 'Black Powder');
  assert.ok(db.items['Copper Powder'].id < db.items['Black Powder'].id);
});

test('exact tie: Plank + Coke Powder + Bronze Ingot, T=325 → Copper Powder (same tie, different inputs)', () => {
  const r = triple('Plank', 'Coke Powder', 'Bronze Ingot');
  assert.equal(r.T, 325);
  assert.equal(r.exactTie, true);
  assert.equal(r.output, 'Copper Powder');
});

test('exact tie: Plank + Charcoal Powder + Quicklime Powder, T=10.5 → Iron Sand (id 303) over Quicklime (id 401)', () => {
  const r = triple('Plank', 'Charcoal Powder', 'Quicklime Powder');
  assert.equal(r.T, 10.5);
  assert.equal(r.distance, 4.5);
  assert.equal(r.exactTie, true);
  assert.equal(r.output, 'Iron Sand');
  assert.equal(r.runnerUp, 'Quicklime');
});

test('exact tie: Flax crops ×3, T=3 → Stone (id 201) over Charcoal (id 403)', () => {
  const r = triple('Flax', 'Flax', 'Flax');
  assert.equal(r.T, 3);
  assert.equal(r.exactTie, true);
  assert.equal(r.output, 'Stone');
  assert.equal(r.runnerUp, 'Charcoal');
});

test('seeds vs crops carry different cauldronCosts (Flax Seeds 115 ≠ Flax 2)', () => {
  assert.equal(db.items['Flax Seeds'].cauldronCost, 115);
  assert.equal(db.items['Flax'].cauldronCost, 2);
});

test('fragile margin: Copper Bearing + Quicklime Powder + Copper Coin → ICP by 0.3533… over Turquoise', () => {
  const r = triple('Copper Bearing', 'Quicklime Powder', 'Copper Coin');
  assert.equal(r.output, 'Impure Copper Powder');
  assert.equal(r.exactTie, false);
  assert.ok(Math.abs(r.margin - 0.3533333334) < 1e-9, `margin ${r.margin}`);
  assert.equal(r.runnerUp, 'Turquoise');
});

test('piecewise time/heat interpolation (game code rounds to 1 decimal)', () => {
  assert.deepEqual(cauldronStats(180), { time: 6.5, heat: 36 });
  assert.deepEqual(cauldronStats(200000), { time: 30.9, heat: 3131.3 });
  assert.deepEqual(cauldronStats(1), { time: 3, heat: 1 });
  assert.deepEqual(cauldronStats(1000000), { time: 60, heat: 10000 });
  assert.deepEqual(cauldronStats(5000000), { time: 60, heat: 10000 });
});

test('curated-row validation: Ruby row contradicts the formula (computes to Perfect Diamond); others consistent', () => {
  const results = validateCuratedRows(db, compiled);
  const ruby = results.find((r) => r.recipe === 'Ruby');
  assert.equal(ruby.status, 'CONTRADICTION');
  assert.equal(ruby.formulaOutput, 'Perfect Diamond');
  for (const r of results.filter((x) => x.recipe !== 'Ruby')) {
    assert.equal(r.status, 'consistent', `${r.recipe}: ${JSON.stringify(r)}`);
  }
});

test('all cauldronMulti are 1 (the nearest-neighbor argmin depends on this)', () => {
  for (const t of compiled.targets) assert.equal(t.multi, 1);
});

test('exact-tie census is stable (1103 ties, 93679 self-consuming across 419220 triples)', () => {
  let ties = 0;
  let selfC = 0;
  for (let i = 0; i < compiled.count; i++) {
    if (compiled.flags[i] & 1) ties++;
    if (compiled.flags[i] & 2) selfC++;
  }
  assert.equal(ties, 1103);
  assert.equal(selfC, 93679);
});
