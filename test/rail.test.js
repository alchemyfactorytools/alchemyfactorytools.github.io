'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { simulate, matchFilter, DEFAULT_PARAMS } = require('../src/rail');

const loop = (extraStations, edgesLen = 20) => ({
  edges: [{ from: 'A', to: 'B', length: edgesLen }, { from: 'B', to: 'C', length: edgesLen }, { from: 'C', to: 'A', length: edgesLen }],
  stations: [{ id: 'launch', type: 'launch', node: 'A', wagons: 2, tag: 'x' }, ...extraStations],
});

test('filters: cargo and/or/not, color, tag exact vs prefix', () => {
  const w = { cargo: { item: 'Flax', qty: 100 }, color: 'red', tag: 'farm.sage' };
  assert.equal(matchFilter({ cargo: { items: ['Flax'], mode: 'or' } }, w, DEFAULT_PARAMS), true);
  assert.equal(matchFilter({ cargo: { items: ['Flax', 'Sage'], mode: 'and' } }, w, DEFAULT_PARAMS), false);
  assert.equal(matchFilter({ cargo: { items: ['Sage'], mode: 'or', not: true } }, w, DEFAULT_PARAMS), true);
  assert.equal(matchFilter({ color: { colors: ['red', 'blue'] } }, w, DEFAULT_PARAMS), true);
  assert.equal(matchFilter({ color: { colors: ['blue'] } }, w, DEFAULT_PARAMS), false);
  assert.equal(matchFilter({ tag: { value: 'farm' } }, w, DEFAULT_PARAMS), false);
  assert.equal(matchFilter({ tag: { value: 'farm' } }, w, { ...DEFAULT_PARAMS, tagMatch: 'prefix' }), true);
  assert.equal(matchFilter({ tag: { value: 'farm.sage', not: true }, color: { colors: ['red'] } }, w, DEFAULT_PARAMS), false);
});

test('a single route delivers min(production, demand) with no starvation once primed', () => {
  const rep = simulate(loop([
    { id: 'ld', type: 'loader', node: 'B', item: 'Flax', ratePerMin: 60, fullLoadsOnly: true, filter: { tag: { value: 'x' } } },
    { id: 'ul', type: 'unloader', node: 'C', consumePerMin: 60, chestCap: 1000, filter: { tag: { value: 'x' } } },
  ]), { minutes: 120 });
  const ul = rep.stations.ul, ld = rep.stations.ld;
  assert.ok(ul.deliveredPerMin > 55 && ul.deliveredPerMin <= 60, `delivered ${ul.deliveredPerMin}/min`);
  assert.ok(ul.starvedPct < 5, `starved ${ul.starvedPct}% (priming only)`);
  assert.equal(ld.blockedPct, 0, 'loader never backs up its belt');
});

test('full loads only: a low-rate loader ships late; partial loads keep the consumer fed', () => {
  const mk = (full) => simulate(loop([
    { id: 'ld', type: 'loader', node: 'B', item: 'Growth Potion', ratePerMin: 5, fullLoadsOnly: full, filter: { tag: { value: 'x' } } },
    { id: 'ul', type: 'unloader', node: 'C', consumePerMin: 5, chestCap: 1000, filter: { tag: { value: 'x' } } },
  ]), { minutes: 60 });
  const full = mk(true), part = mk(false);
  assert.ok(full.stations.ul.starvedPct > part.stations.ul.starvedPct + 10, `full ${full.stations.ul.starvedPct}% vs partial ${part.stations.ul.starvedPct}%`);
  assert.ok(part.stations.ld.packs > full.stations.ld.packs, 'partial loads ship more, smaller packs');
});

test('a full chest makes the unloader skip and the wagon keep circulating loaded', () => {
  const rep = simulate(loop([
    { id: 'ld', type: 'loader', node: 'B', item: 'Flax', ratePerMin: 120, fullLoadsOnly: true, filter: { tag: { value: 'x' } } },
    { id: 'ul', type: 'unloader', node: 'C', consumePerMin: 10, chestCap: 150, filter: { tag: { value: 'x' } } },
  ]), { minutes: 60 });
  assert.ok(rep.stations.ul.skipped > 0, 'skips happen');
  assert.ok(rep.stations.ul.chestMax <= 150);
  assert.ok(rep.stations.ld.blockedPct > 50, 'over-supply backs the loader belt up');
});

test('sorter: only tagged wagons take the branch; others go straight', () => {
  const sc = {
    edges: [{ from: 'A', to: 'S', length: 10 }, { from: 'S', to: 'X', length: 10 }, { from: 'X', to: 'E', length: 10 }, { from: 'S', to: 'E', length: 10 }, { from: 'E', to: 'A', length: 10 }, { from: 'E', to: 'A2', length: 10 }, { from: 'A2', to: 'A', length: 5 }],
    stations: [
      { id: 'l1', type: 'launch', node: 'A', wagons: 1, tag: 'up' },
      { id: 'l2', type: 'launch', node: 'A2', wagons: 1, tag: 'flat' },
      { id: 'sort', type: 'sorter', node: 'S', branch: 'X', filter: { tag: { value: 'up' } } },
    ],
  };
  // E has two out-edges; give it a sorter too so 'flat' wagons reach A2 and dock
  sc.stations.push({ id: 'sortE', type: 'sorter', node: 'E', branch: 'A2', filter: { tag: { value: 'flat' } } });
  const rep = simulate(sc, { minutes: 20 });
  assert.ok(rep.stations.sort.branched > 0 && rep.stations.sort.passed > 0);
  assert.equal(rep.stations.l1.returns > 0 && rep.stations.l2.returns > 0, true, 'both wagons keep docking at their own launch');
});

test('transfer station moves packs between two loops', () => {
  const sc = {
    edges: [{ from: 'A', to: 'B', length: 10 }, { from: 'B', to: 'T', length: 10 }, { from: 'T', to: 'A', length: 10 },
      { from: 'P', to: 'Q', length: 10 }, { from: 'Q', to: 'U', length: 10 }, { from: 'U', to: 'P', length: 10 }],
    stations: [
      { id: 'l1', type: 'launch', node: 'A', wagons: 2, tag: 'trunk' },
      { id: 'ld', type: 'loader', node: 'B', item: 'Flax', ratePerMin: 60, fullLoadsOnly: true, filter: { tag: { value: 'trunk' } } },
      { id: 'x', type: 'transfer', inNode: 'T', outNode: 'Q', inFilter: { cargo: { items: ['Flax'], mode: 'or' } }, outFilter: { tag: { value: 'local' } } },
      { id: 'l2', type: 'launch', node: 'P', wagons: 2, tag: 'local' },
      { id: 'ul', type: 'unloader', node: 'U', consumePerMin: 60, chestCap: 1000, filter: { tag: { value: 'local' } } },
    ],
  };
  const rep = simulate(sc, { minutes: 90 });
  assert.ok(rep.stations.x.packsIn > 20 && rep.stations.x.packsOut > 20, JSON.stringify(rep.stations.x));
  assert.ok(rep.stations.ul.deliveredPerMin > 50, `delivered ${rep.stations.ul.deliveredPerMin}`);
});

test('the shipped trunk-tower scenario runs and every consumer is fed', () => {
  const sc = JSON.parse(fs.readFileSync(__dirname + '/../scenarios/rail/trunk-tower.json', 'utf8'));
  const rep = simulate(sc, { minutes: 60 });
  for (const [id, s] of Object.entries(rep.stations)) if (s.type === 'unloader') assert.ok(s.starvedPct < 10, `${id} starved ${s.starvedPct}%`);
});
