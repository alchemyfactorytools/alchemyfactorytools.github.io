'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compileAdvancedCauldron, resolvePair, advancedCauldronEligibility } = require('../src/cauldron');
const { buildProcessTable } = require('../src/normalize');
const { resolveConfig } = require('../src/config');
const { Model, optimize } = require('../src/model');
const { makeComposer } = require('../src/composer');
const db = require('../data/alchemy_db.json');

const c2 = compileAdvancedCauldron(db);
const pair = (a, b) => resolvePair(db, [a, b], c2);

test('pair space: 138 eligible inputs → 9,591 unordered pairs, same targets as the triple pot', () => {
  assert.equal(c2.inputs.length, 138);
  assert.equal(c2.count, 9591);
  assert.equal(c2.targets.length, 47);
});

test('same item → the next target above its cost (player-reported ladder)', () => {
  assert.equal(pair('Gentian', 'Gentian').output, 'Malachite');          // 400 → 427
  assert.equal(pair('Flax', 'Flax').output, 'Stone');                    // 2 → 4
  assert.equal(pair('Redcurrant', 'Redcurrant').output, 'Iron Sand');    // 12 → 15
  assert.equal(pair('Silver Ingot', 'Silver Ingot').output, 'Obsidian');
  assert.equal(pair('World Tree Core', 'World Tree Core').output, 'Sapphire');
  assert.equal(pair('Gentian', 'Gentian').mode, 'same');
});

test('different items → nearest target below the higher input at |cA − cB|', () => {
  assert.equal(pair('Gentian Nectar', 'Gentian').output, 'Clay');        // 420 − 400 = 20
  assert.equal(pair('Gentian', 'Gentian Powder').output, 'Coke');        // 430 − 400 = 30
  assert.equal(pair('Flax', 'Flax Fiber').output, 'Plank');              // 2.5 − 2 = 0.5
  assert.equal(pair('World Tree Core', 'Flax').output, 'Ruby');          // 250000 − 2 → nearest below WTC
  assert.equal(pair('Gentian Nectar', 'Gentian').T, 20);
  // the higher input itself is never the answer
  const r = pair('Ruby', 'Flax');
  assert.notEqual(r.output, 'Ruby');
});

test('time and heat come from the output target, as for triples', () => {
  const r = pair('World Tree Core', 'Flax');
  assert.equal(r.time, 30.9);
  assert.equal(r.heat, 3131.3);
});

test('eligibility honours the input pool, forbidFor and tier locks', () => {
  const cfg = resolveConfig({ cauldron: { enabled: true, inputPool: { allow: ['World Tree Core', 'Flax'] } } });
  const e = advancedCauldronEligibility(db, cfg, { compiled: c2, buildOutputIndex: true });
  assert.equal(e.eligibleCount, 3); // WTC+WTC, WTC+Flax, Flax+Flax
  assert.ok(e.byOutput.get('Ruby'));
  const eF = advancedCauldronEligibility(db, resolveConfig({ cauldron: { enabled: true, inputPool: { allow: ['World Tree Core', 'Flax'] }, forbidFor: ['Ruby'] } }), { compiled: c2 });
  assert.equal(eF.eligibleCount, 2);
  const eL = advancedCauldronEligibility(db, cfg, { compiled: c2, locked: (n) => n === 'World Tree Core' });
  assert.equal(eL.eligibleCount, 1);
});

test('LP: no advanced columns below tier 8; at tier 9 Ruby comes from World Tree Core + Flax when that is the only route', async () => {
  const pt7 = buildProcessTable(db, resolveConfig({ maxTier: 7, cauldron: { enabled: true, inputPool: 'unrestricted' } }));
  assert.equal(pt7.advancedCount, 0);
  const cfg = resolveConfig({ maxTier: 9, cauldron: { enabled: true, inputPool: { allow: ['World Tree Core', 'Flax'] }, forbidFor: [] }, machines: { defaultCount: 1000 } });
  const pt = buildProcessTable(db, cfg);
  assert.equal(pt.advancedCount, 3);
  const r = await optimize(new Model(pt, db), { demand: { Ruby: 1 } });
  assert.equal(r.status, 'Optimal');
  const adv = r.flows.find((f) => f.process.machine === 'Advanced Cauldron' && f.process.produces.Ruby);
  assert.ok(adv, 'Ruby via the Advanced Cauldron');
  assert.deepEqual(adv.process.consumes, { 'World Tree Core': 1, Flax: 1 });
  assert.ok(Math.abs(adv.rate - 1) < 1e-6);
});

test('composer: picks an Advanced Cauldron pair when it is the cheapest route, and never below tier 8', () => {
  const pick = (tier) => makeComposer(db, resolveConfig({ maxTier: tier, cauldron: { enabled: true, inputPool: { allow: ['World Tree Core', 'Flax'] } }, composer: { priority: 'balanced' }, canonical: { fuelItem: 'Black Powder', fertItem: 'Growth Potion' } })).canonicalPick('Ruby');
  const p9 = pick(9);
  assert.ok(p9 && p9.recipe && p9.recipe.machine === 'Advanced Cauldron', JSON.stringify(p9));
  assert.deepEqual(p9.recipe.inputs, { 'World Tree Core': 1, Flax: 1 });
  assert.equal(p9.recipe.baseTime, 30.9);
  assert.equal(pick(7), null, 'no advanced pot at tier 7 (and no other route with this pool)');
});

test('capital: the Advanced Cauldron is not free (coins seeded at face value in the cost floor)', () => {
  const pt = buildProcessTable(db, resolveConfig({ machines: { defaultCount: 1000 } }));
  const m = new Model(pt, db);
  assert.ok(m.buildCopper['Advanced Cauldron'] > m.buildCopper.Cauldron, `${m.buildCopper['Advanced Cauldron']} vs ${m.buildCopper.Cauldron}`);
});
