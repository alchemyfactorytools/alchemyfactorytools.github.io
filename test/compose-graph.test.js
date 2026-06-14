// Phase 4: composeGraph() emits the composed tile tree as the buildFlowGraph {nodes,edges,summary}
// shape so the existing renderer/layout/blueprint work unchanged. These pin the structural
// contract: every node id unique, every edge endpoint real, target reaches its demand sink, and
// the three shared trunks (fuel/fert/money) wire to every consumer — including the cash-provenance
// rule that a minted coin links back to the main-belt money line.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeComposer } = require('../src/composer');
const { composeGraph } = require('../src/compose-graph');
const { resolveConfig } = require('../src/config');
const db = require('../data/alchemy_db.v41.json');

const cfg = resolveConfig({ maxTier: 6, canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } });
const comp = makeComposer(db, cfg);
const graphOf = (item, rate) => composeGraph(comp.compose(item, rate), db, cfg);
const nodeOf = (g, id) => g.nodes.find((n) => n.id === id);

test('Phase 4: graph is structurally sound (unique ids, real endpoints, target → demand)', () => {
  const g = graphOf('Glass', 60);
  const ids = g.nodes.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'node ids unique');
  const idset = new Set(ids);
  for (const e of g.edges) {
    assert.ok(idset.has(e.from), `edge.from ${e.from} is a real node`);
    assert.ok(idset.has(e.to), `edge.to ${e.to} is a real node`);
  }
  const demand = nodeOf(g, 'demand:Glass');
  assert.ok(demand && demand.type === 'demand');
  assert.ok(g.edges.some((e) => e.to === 'demand:Glass' && e.item === 'Glass'), 'target wired to its demand sink');
  assert.equal(g.summary.validation.length, 0);
  assert.equal(g.summary.solver, 'composer');
});

test('Phase 4: heated machines get a fuel edge + band from the fuel trunk', () => {
  const g = graphOf('Glass', 60);
  const kiln = g.nodes.find((n) => n.machine === 'Kiln');
  assert.ok(kiln.fuelItem === 'Coke Powder' && kiln.fuelPerMin > 0, 'Kiln carries a fuel band');
  const fuelEdge = g.edges.find((e) => e.heat && e.to === kiln.id);
  assert.ok(fuelEdge && fuelEdge.item === 'Coke Powder', 'a heat edge feeds the Kiln from the fuel trunk');
});

test('Phase 4: nurseries get a fert edge; a heated machine INSIDE the fert trunk still gets fuel', () => {
  // Growth Potion (the fert carrier) grows its own herbs and its Clay sub-cauldron burns fuel —
  // the trunk-ordering must wire fuel to consumers discovered while walking the fert trunk.
  const g = graphOf('Growth Potion', 20);
  assert.equal(g.summary.validation.length, 0, 'no missing-fuel/fert issues anywhere');
  const nursery = g.nodes.find((n) => n.machine === 'Nursery');
  assert.ok(g.edges.some((e) => e.nutrient && e.to === nursery.id), 'a nutrient edge feeds the Nursery');
  const fertCauldron = g.nodes.find((n) => n.id.startsWith('Growth Potion#fert') && n.kind === 'cauldron' && n.fuelPerMin > 0);
  assert.ok(fertCauldron, 'the fert trunk has a heated cauldron');
  assert.ok(g.edges.some((e) => e.heat && e.to === fertCauldron.id), 'that in-trunk cauldron still gets a fuel edge');
});

test('Phase 4: a minted coin links back to the main-belt money line (cash edge)', () => {
  const g = graphOf('Black Powder', 20);
  const money = nodeOf(g, 'money:belt');
  assert.ok(money && money.type === 'external', 'a main-belt money line node exists');
  const mint = g.nodes.find((n) => n.kind === 'mint');
  assert.ok(mint, 'Black Powder mints a coin');
  const cashEdge = g.edges.find((e) => e.cash && e.from === 'money:belt' && e.to === mint.id);
  assert.ok(cashEdge, 'the mint is wired to the money line');
  assert.equal(g.summary.mintedCoins['Copper Coin'], 20);
});

test('belt fuel/fert is drawn off the belt (no built trunk); belt coins back the money line', () => {
  // Belt a fertilizer (Growth Potion) and a coin (Silver Coin). The fert carrier must become the
  // belted item, its trunk collapses to a single belt node, and the money line is backed by the
  // belt coin (no "minted — assumption" flag, no coins from thin air).
  const beltCfg = resolveConfig({ maxTier: 6, cauldron: { enabled: true, inputPool: 'growables' }, belt: [{ item: 'Silver Coin' }, { item: 'Growth Potion', rate: 60 }], canonical: {} });
  const { canonicalCarriers } = require('../src/utilities');
  const carriers = canonicalCarriers(db, beltCfg);
  assert.equal(carriers.fertItem, 'Growth Potion', 'belted fertilizer overrides the heuristic carrier');
  beltCfg.canonical = carriers;
  const c2 = makeComposer(db, beltCfg);
  const composed = c2.compose('Clay', 30);
  assert.equal(composed.fert.source, 'belt', 'fert trunk is a belt supply, not a built production tree');
  const g = composeGraph(composed, db, beltCfg);
  const money = g.nodes.find((n) => n.id === 'money:belt');
  assert.ok(money && money.kind === 'belt' && !money.badges.includes('ASSUMPTION'), 'belt coins back the money line');
  const fertEdge = g.edges.find((e) => e.nutrient);
  assert.ok(fertEdge && g.nodes.find((n) => n.id === fertEdge.from).kind === 'belt', 'nurseries draw fert from the belt node');
});

test('without belt coins the money line is an explicit minted assumption (not free)', () => {
  const g = graphOf('Black Powder', 20); // no belt; mints Copper Coin
  const money = g.nodes.find((n) => n.id === 'money:belt');
  assert.ok(money && money.kind === 'cash' && money.badges.includes('ASSUMPTION'), 'minted money is flagged, never silent/free');
});

test('Phase 4: co-products render as trash sinks, not dangling outputs', () => {
  // Use a co-producing recipe route by disabling cauldron so a real db recipe with a co-product wins.
  const c2 = makeComposer(db, resolveConfig({ maxTier: 6, composer: { coW: 0 }, canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } }));
  const g = composeGraph(c2.compose('Sand', 60), db, cfg);
  const trash = g.nodes.filter((n) => n.type === 'surplus');
  if (trash.length) for (const t of trash) assert.ok(g.edges.some((e) => e.to === t.id), 'trash sink has an incoming edge');
  assert.equal(g.summary.validation.length, 0);
});
