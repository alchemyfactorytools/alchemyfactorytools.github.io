'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { explore, sizeFleets, TEMPLATES } = require('../src/rail-plan');
const { simulate } = require('../src/rail');

const plan = JSON.parse(fs.readFileSync(__dirname + '/../scenarios/rail/plan-tier6.json', 'utf8'));

test('every template builds a scenario whose nodes and stations resolve', () => {
  for (const [name, build] of Object.entries(TEMPLATES)) {
    for (const fleet of ['shared', 'perFlow']) {
      const sc = build(plan, fleet, {});
      const nodes = new Set(sc.edges.flatMap((e) => [e.from, e.to]));
      for (const s of sc.stations) {
        for (const n of [s.node, s.inNode, s.outNode].filter(Boolean)) assert.ok(nodes.has(n), `${name}/${fleet}: station ${s.id} on unknown node ${n}`);
      }
      // every node has exactly one out-edge (no sorters in these templates)
      const outs = {};
      for (const e of sc.edges) outs[e.from] = (outs[e.from] || 0) + 1;
      for (const n of nodes) assert.equal(outs[n], 1, `${name}/${fleet}: node ${n} has ${outs[n]} out-edges`);
      const rep = simulate(sc, { minutes: 5 });
      assert.ok(Object.keys(rep.stations).length === sc.stations.length);
    }
  }
});

test('fleet sizing grows wagons until consumers are fed; trunk-zones/shared feeds the plan with few wagons', () => {
  const { report, wagons } = sizeFleets(plan, 'trunk-zones', 'shared', { minutes: 60 });
  const unl = Object.values(report.stations).filter((s) => s.type === 'unloader');
  assert.ok(unl.every((s) => s.starvedPct <= 8), JSON.stringify(unl.map((s) => s.starvedPct)));
  const total = Object.values(wagons).reduce((a, b) => a + b, 0);
  assert.ok(total <= 8, `trunk-zones/shared should need few wagons at these rates, got ${total}`);
});

test('single-loop with a shared fleet starves: partial-load loaders take every empty wagon (no top-up)', () => {
  const { report } = sizeFleets(plan, 'single-loop', 'shared', { minutes: 60, maxWagons: 6 });
  const unl = Object.values(report.stations).filter((s) => s.type === 'unloader');
  assert.ok(unl.some((s) => s.starvedPct > 50), 'some consumer is starved regardless of fleet size');
});

test('explore returns one scored row per combo with the comparison fields', () => {
  const rows = explore(plan, { minutes: 30, combos: [['shuttles', 'perFlow'], ['trunk-zones', 'perFlow']] });
  assert.equal(rows.length, 2);
  for (const r of rows) for (const k of ['wagons', 'track', 'stations', 'fedPct', 'worstStarvedPct', 'avgLoadedPct', 'maxLapSec']) assert.ok(k in r, k);
});
