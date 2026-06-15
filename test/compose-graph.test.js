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

test('always best-for-tier carrier; ample belt supply covers the whole trunk (no production)', () => {
  // Carrier is ALWAYS best-for-tier (here Growth Potion @ t6), NOT overridden by what's belted. A
  // belt rate that exceeds demand covers the whole fert trunk → all belt, no production sub-trunk.
  const { canonicalCarriers } = require('../src/utilities');
  const beltCfg = resolveConfig({ maxTier: 6, cauldron: { enabled: true, inputPool: 'growables' }, belt: [{ item: 'Silver Coin' }, { item: 'Growth Potion', rate: 60 }], canonical: {} });
  const carriers = canonicalCarriers(db, beltCfg);
  assert.equal(carriers.fertItem, 'Growth Potion', 'fert carrier is the best-for-tier item');
  beltCfg.canonical = carriers;
  const composed = makeComposer(db, beltCfg).compose('Clay', 30);
  assert.ok(composed.fert.beltRate > 0 && composed.fert.prodRate < 1e-6 && !composed.fert.prodTile, 'belt covers the whole trunk');
  const g = composeGraph(composed, db, beltCfg);
  const money = g.nodes.find((n) => n.id === 'money:belt');
  assert.ok(money && money.kind === 'belt' && !money.badges.includes('ASSUMPTION'), 'belt coins back the money line');
  const fertEdge = g.edges.find((e) => e.nutrient);
  assert.ok(fertEdge && g.nodes.find((n) => n.id === fertEdge.from).kind === 'belt', 'nurseries draw fert from the belt node');
});

test('belt rate cap is enforced: belt supplies up to its rate, the build composes the rest', () => {
  // Belt only 2/min Growth Potion against a fert-hungry demand. Belt covers 2/min, the composer
  // builds a production sub-trunk for the excess, warns, and nurseries draw from BOTH sources.
  const beltCfg = resolveConfig({ maxTier: 6, cauldron: { enabled: true, inputPool: 'growables' }, belt: [{ item: 'Growth Potion', rate: 2 }], canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } });
  const composed = makeComposer(db, beltCfg).compose('Clay', 300);
  assert.ok(composed.fert.beltRate <= 2 + 1e-6 && composed.fert.prodRate > 1, 'belt capped at 2/min, excess produced');
  assert.ok(composed.summary.warnings.some((w) => /Belt Growth Potion supplies/.test(w)), 'shortfall is warned');
  const g = composeGraph(composed, db, beltCfg);
  const srcKinds = new Set(g.edges.filter((e) => e.nutrient).map((e) => g.nodes.find((n) => n.id === e.from).kind));
  assert.ok(srcKinds.has('belt') && srcKinds.has('recipe'), 'fert flows from both the belt and the production trunk');
  assert.equal(g.summary.validation.length, 0);
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

test('Phase 7: co-product feed wires source → consumer and conserves material', () => {
  const reuseCfg = resolveConfig({ maxTier: 6, byproducts: { mode: 'reuse' }, canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } });
  const g = composeGraph(makeComposer(db, reuseCfg).compose('Saturn', 1), db, reuseCfg);
  assert.equal(g.summary.validation.length, 0);
  const coEdges = g.edges.filter((e) => e.coproduct && e.item === 'Sand');
  assert.ok(coEdges.length >= 1, 'a Sand co-product edge is wired to a consumer');
  for (const e of coEdges) {
    assert.ok(new Set(g.nodes.map((n) => n.id)).has(e.to), 'co-feed target is a real node');
  }
  // The consumer (Glass tile) gets its full Sand: dedicated production + co-feed = recipe demand.
  const glass = g.nodes.find((n) => n.id === 'Saturn>Glass');
  const sandIn = g.edges.filter((e) => e.to === glass.id && e.item === 'Sand').reduce((a, e) => a + e.ratePerMin, 0);
  assert.ok(Math.abs(sandIn - 3600) < 1, `Glass receives all 3600 Sand (got ${sandIn})`);
  // Conservation: every co-fed unit traces to a real co-product. Sources can over-produce (the fert
  // trunk's Brine→Salt also throws off Sand), in which case the genuine surplus is trashed — but the
  // total fed never exceeds the total co-product routed off all sources (fed + trashed).
  const sandFed = g.edges.filter((e) => e.item === 'Sand' && e.coproduct).reduce((a, e) => a + e.ratePerMin, 0);
  const sandRouted = g.edges.filter((e) => e.item === 'Sand' && (e.coproduct || /^trash:/.test(e.to))).reduce((a, e) => a + e.ratePerMin, 0);
  assert.ok(sandFed <= sandRouted + 1e-6, 'co-fed Sand never exceeds the co-product supply');
});

test('Phase 7: trash mode still reuses within-tile, then trashes the unclaimed surplus', () => {
  const trashCfg = resolveConfig({ maxTier: 6, byproducts: { mode: 'trash' }, canonical: { fuelItem: 'Coke Powder', fertItem: 'Growth Potion' } });
  const g = composeGraph(makeComposer(db, trashCfg).compose('Saturn', 1), db, trashCfg);
  // Within-tile co-product reuse is always on, even in trash mode: the Sand thrown off making Saturn's
  // Salt feeds its Glass demand, so co-feed edges appear here too. byproducts.mode governs only the
  // UNCLAIMED surplus — Saturn over-produces Sand, so the leftover beyond the reused amount is still
  // trashed. (Older behaviour, now retired: trash mode trashed ALL co-products and drew no feed edges.)
  assert.ok(g.edges.filter((e) => e.coproduct).length > 0, 'within-tile co-feed edges appear in trash mode');
  assert.ok(g.nodes.some((n) => n.type === 'surplus' && /Sand/.test(n.label)), 'the unclaimed surplus Sand is still trashed');
  assert.equal(g.summary.validation.length, 0);
});
