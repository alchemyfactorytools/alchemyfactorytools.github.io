// Flow-graph + buy-allowlist regressions.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildProcessTable } = require('../src/normalize');
const { resolveConfig } = require('../src/config');
const { Model, optimize } = require('../src/model');
const { buildFlowGraph, toDot } = require('../src/flowgraph');
const db = require('../data/alchemy_db.v41.json');

const setup = async (cfgOverrides, demand) => {
  const pt = buildProcessTable(db, resolveConfig(cfgOverrides));
  const model = new Model(pt, db);
  const result = await optimize(model, { demand });
  return { model, result };
};

const MARS_CFG = { cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 } };
const MARS = { Mars: 0.1 };

test('flow graph: well-formed nodes/edges with machine counts and a demand sink', async () => {
  const { model, result } = await setup(MARS_CFG, MARS);
  const g = buildFlowGraph(result, model, MARS);

  const ids = new Set(g.nodes.map((n) => n.id));
  assert.equal(ids.size, g.nodes.length, 'node ids unique');
  for (const e of g.edges) {
    assert.ok(ids.has(e.from), `edge from ${e.from} exists`);
    assert.ok(ids.has(e.to), `edge to ${e.to} exists`);
    assert.ok(e.ratePerMin > 0);
  }
  assert.ok(ids.has('demand:Mars'));
  // demand inflow matches the requested rate
  const inflow = g.edges.filter((e) => e.to === 'demand:Mars').reduce((s, e) => s + e.ratePerMin, 0);
  assert.ok(Math.abs(inflow - 0.1) < 1e-6, `demand inflow ${inflow}`);
  // every producing process node has an integer machine count when machine-bound
  for (const n of g.nodes.filter((x) => x.type === 'process' && x.machine && x.kind !== 'sale')) {
    if (n.machineCount !== null) {
      assert.ok(Number.isInteger(n.machineCount) && n.machineCount >= 1, `${n.id} count ${n.machineCount}`);
      assert.ok(n.utilization > 0 && n.utilization <= 1 + 1e-9, `${n.id} util ${n.utilization}`);
    }
  }
  // the GG cauldron node is present and badge-free (margin 12 is not fragile)
  const gg = g.nodes.find((n) => n.kind === 'cauldron' && n.label.includes('Gelatinous Gridlock'));
  assert.ok(gg, 'GG cauldron node present');
  assert.equal(gg.machineCount >= 1, true);
  // summary aggregates
  assert.ok(g.summary.copperPerMin > 0);
  assert.ok(g.summary.externals.some((e) => e.item === 'Gelatinous Gridlock'));
  assert.ok(Object.keys(g.summary.machineTotals).length > 3);
});

test('flow graph: no HEAT box; heated machines carry a per-machine fuel band', async () => {
  const { model, result } = await setup(MARS_CFG, MARS);
  const g = buildFlowGraph(result, model, MARS);
  // heat is shown per-machine, not as a pooled HEAT node
  assert.equal(g.nodes.find((n) => n.id === 'resource:HEAT'), undefined, 'no HEAT box');
  const heated = g.nodes.filter((n) => n.heatPerMin > 0);
  assert.ok(heated.length > 0, 'some machines consume heat');
  for (const n of heated) {
    assert.ok(n.fuelItem && n.fuelPerMin > 0, `${n.id} shows fuel/min`);
  }
});

test('buy allowlist: restricting external inputs changes feasibility and is reported', async () => {
  // Mars from ONLY Logs + Gelatinous Gridlock + coins: impossible (no iron source)
  const restricted = await setup(
    { ...MARS_CFG, buy: { allow: ['Logs', 'Gelatinous Gridlock', 'Copper Coin'] } },
    MARS,
  );
  assert.equal(restricted.result.status, 'Infeasible');
  // Bronze Ingot from only GG + Logs + coins: feasible (cauldron ICP → crucible)
  const bronze = await setup(
    { ...MARS_CFG, buy: { allow: ['Logs', 'Gelatinous Gridlock', 'Copper Coin'] } },
    { 'Bronze Ingot': 10 },
  );
  assert.equal(bronze.result.status, 'Optimal');
  const g = buildFlowGraph(bronze.result, bronze.model, { 'Bronze Ingot': 10 });
  for (const e of g.summary.externals) {
    assert.ok(['Logs', 'Gelatinous Gridlock', 'Copper Coin'].includes(e.item),
      `external ${e.item} must be in the allowlist`);
  }
});

test('buy allowlist gates coin mints too', () => {
  const pt = buildProcessTable(db, resolveConfig({ buy: { allow: ['Logs'] } }));
  assert.equal(pt.processes.find((p) => p.kind === 'mint'), undefined);
  const pt2 = buildProcessTable(db, resolveConfig({ buy: { allow: ['Logs', 'Silver Coin'] } }));
  const mints = pt2.processes.filter((p) => p.kind === 'mint').map((p) => p.primary);
  assert.deepEqual(mints, ['Silver Coin']);
});

test('DOT export is syntactically plausible and covers all nodes/edges', async () => {
  const { model, result } = await setup(MARS_CFG, MARS);
  const g = buildFlowGraph(result, model, MARS);
  const dot = toDot(g);
  assert.ok(dot.startsWith('digraph factory {'));
  assert.equal((dot.match(/->/g) || []).length, g.edges.length);
});

const { layout: doLayout } = require('../src/layout');

test('layout (dagre): every node positioned and every edge routed, even on cyclic graphs', async () => {
  // unrestricted Mars has self-fuel/matter loops — the hard cyclic case
  const pt = buildProcessTable(db, resolveConfig({ machines: { defaultCount: 50 } }));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const { pos, edges, recycle } = doLayout(g, { orientation: 'LR' });
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    assert.ok(p && Number.isFinite(p.x) && Number.isFinite(p.y), `node ${n.id} positioned`);
  }
  for (const e of g.edges) {
    if (e.from === e.to) continue;
    const eo = edges.get(e.from + '\t' + e.to);
    assert.ok(eo && eo.start && eo.end, `edge ${e.from}→${e.to} has anchor points`);
  }
  assert.ok(recycle instanceof Set);
});

test('clustering: every node joins its nearest line root (no stranded singleton lines)', async () => {
  // A final-product input whose feeder chain was greedily claimed by a sibling
  // line used to be left as a bare 1-node cluster ("Copper Bearing alone in the
  // middle"). Nearest-root assignment keeps each input's immediate feeders.
  const { assignClusters } = require('../src/layout');
  const pt = buildProcessTable(db, resolveConfig({ maxTier: 7, machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const cl = assignClusters(g);

  // product lines (real-node roots) keep their immediate feeders rather than being
  // stranded as bare singletons. Each product line root with ≥1 feeder edge in the
  // graph should pull at least that feeder into its own line.
  const inputsOf = new Map(g.nodes.map((n) => [n.id, []]));
  for (const e of g.edges) if (e.from !== e.to) inputsOf.get(e.to).push(e.from);
  for (const c of cl.clusters) {
    if (c.id.startsWith('util:')) continue; // utility lines are multi-seeded
    const feeders = inputsOf.get(c.id) || [];
    if (feeders.length) {
      const pulled = feeders.some((f) => cl.clusterOf.get(f) === c.id);
      assert.ok(c.members.length > 1 || !pulled, `product line ${c.label} should not be a stranded singleton`);
    }
  }

  // Copper Bearing (a Mars input) keeps its immediate feeder Copper Ingot in its line
  const cbRoot = cl.clusterOf.get('recipe:Copper Bearing');
  assert.ok(cbRoot, 'Copper Bearing is clustered');
  if (g.nodes.find((n) => n.id === 'recipe:Copper Ingot')) {
    assert.equal(cl.clusterOf.get('recipe:Copper Ingot'), cbRoot, 'Copper Ingot stays in the Copper Bearing line');
  }
});

test('clustering: fuel/fertilizer production is its own utility line, not mixed into a product line', async () => {
  const { assignClusters } = require('../src/layout');
  const cfg = { maxTier: 6, cauldron: { enabled: true, inputPool: 'unrestricted' }, byproducts: { mode: 'reuse' }, belt: [{ item: 'Coke Powder' }], skills: { factory: 4, logistics: 12, fuel: 2, fertilizer: 5 }, machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const cl = assignClusters(g);
  const fert = cl.clusters.find((c) => c.label === 'Fertilizer');
  assert.ok(fert, 'a dedicated Fertilizer line exists');
  // the Growth-Potion-for-fertilizer chain (the fertilizer source + upstream) lives in it
  const gp = g.nodes.find((n) => n.label === 'Growth Potion');
  assert.ok(gp, 'Growth Potion is produced');
  assert.equal(cl.clusterOf.get(gp.id), fert.id, 'Growth Potion (made for fertilizer) is in the Fertilizer line, not a product line');
});

test('clustering: a shared intermediate (Soap) becomes its own sub-assembly line; products not stranded', async () => {
  const { assignClusters } = require('../src/layout');
  const cfg = { maxTier: 6, cauldron: { enabled: true, inputPool: 'unrestricted' }, byproducts: { mode: 'reuse' }, belt: [{ item: 'Coke Powder' }], skills: { factory: 4, logistics: 12, fuel: 2, fertilizer: 5 }, machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const cl = assignClusters(g);
  // Soap feeds several lines → it lives in a shared:* line, not a product line
  const soap = g.nodes.find((n) => n.label === 'Soap' && n.machine);
  const soapLine = cl.clusterOf.get(soap.id);
  assert.ok(String(soapLine).startsWith('shared:'), `Soap is in its own shared sub-assembly line (got ${soapLine})`);
  // product line roots keep ≥1 feeder — splitting shared intermediates must not strand them
  const roots = ['recipe:Bronze Rivet', 'recipe:Copper Bearing', 'recipe:Iron Nails'];
  for (const r of roots) {
    if (!g.nodes.find((n) => n.id === r)) continue;
    const members = cl.clusters.find((c) => c.id === cl.clusterOf.get(r))?.members || [];
    assert.ok(members.length > 1, `${r} keeps its line (not stranded as a singleton)`);
  }
});

test('layout: fuel/fert distribution routes as trunks (one aggregated edge per line box)', async () => {
  const { layout: doLayout } = require('../src/layout');
  const cfg = { maxTier: 6, cauldron: { enabled: true, inputPool: 'unrestricted' }, byproducts: { mode: 'reuse' }, belt: [{ item: 'Coke Powder' }], skills: { factory: 4, logistics: 12, fuel: 2, fertilizer: 5 }, machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const lo = doLayout(g, { nodeW: 260, nodeH: 84, orientation: 'TB' });
  const indiv = g.edges.filter((e) => e.heat || e.nutrient).length;
  assert.ok(lo.trunks.length > 0, 'trunks are produced');
  assert.ok(lo.trunks.length < indiv, `trunks (${lo.trunks.length}) collapse the individual fuel/fert edges (${indiv})`);
  // each trunk aggregates the rate of the edges it covers
  for (const t of lo.trunks) { assert.ok(t.ratePerMin > 0 && t.start && t.end, 'trunk has rate + anchors'); }
  // trunked edges are exactly the ones a trunk replaces (so the renderer won't double-draw)
  assert.ok(lo.trunkedEdges.size >= lo.trunks.length, 'trunked edges cover the trunks');
});

test('layout: fuel/fertilizer utility lines are horizontal bands above the product lines (TB)', async () => {
  const { layout: doLayout } = require('../src/layout');
  const cfg = { maxTier: 6, cauldron: { enabled: true, inputPool: 'unrestricted' }, byproducts: { mode: 'reuse' }, belt: [{ item: 'Coke Powder' }], skills: { factory: 4, logistics: 12, fuel: 2, fertilizer: 5 }, machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const lo = doLayout(g, { nodeW: 260, nodeH: 84, orientation: 'TB' });
  const fertBox = lo.clusters.find((c) => c.util && c.label === 'Fertilizer');
  assert.ok(fertBox, 'a Fertilizer utility band exists');
  assert.ok(fertBox.w > fertBox.h, `the band is horizontal in TB (${Math.round(fertBox.w)}×${Math.round(fertBox.h)})`);
  // it sits in the header — above the bulk of the product nodes
  const fertBottom = fertBox.y + fertBox.h;
  const productTops = g.nodes.filter((n) => n.type === 'process' && lo.pos.get(n.id)).map((n) => lo.pos.get(n.id).y);
  const median = productTops.sort((a, b) => a - b)[Math.floor(productTops.length / 2)];
  assert.ok(fertBottom <= median, `fertilizer band is near the top, above most product nodes (${Math.round(fertBottom)} ≤ ${Math.round(median)})`);
});

test('belt band: main-belt supply is its own spanning band, not pinned to a line', async () => {
  const { assignClusters, layout: doLayout } = require('../src/layout');
  const pt = buildProcessTable(db, resolveConfig({ maxTier: 7, belt: [{ item: 'Coke Powder' }], machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  const beltNodes = g.nodes.filter((n) => n.type === 'external' && n.kind === 'belt');
  assert.ok(beltNodes.length, 'belt Coke Powder is on the graph');
  // belt nodes belong to no production line
  const cl = assignClusters(g);
  for (const b of beltNodes) assert.ok(!cl.clusterOf.has(b.id), `belt node ${b.id} is not in a line cluster`);
  for (const c of cl.clusters) for (const b of beltNodes) assert.ok(!c.members.includes(b.id), 'belt not a line member');

  for (const orientation of ['TB', 'LR']) {
    const lo = doLayout(g, { nodeW: 260, nodeH: 84, orientation });
    const beltBox = lo.clusters.find((c) => c.belt);
    assert.ok(beltBox, `${orientation}: a Main belt band box exists`);
    // band spans ~the full cross-extent (width in TB, height in LR)
    const span = orientation === 'TB' ? beltBox.w : beltBox.h;
    const full = orientation === 'TB' ? lo.width : lo.height;
    assert.ok(span >= full * 0.8, `${orientation}: belt band spans the lines (${Math.round(span)} of ${Math.round(full)})`);
    // belt sits at the supply end; nothing has negative coordinates after normalize
    for (const p of lo.pos.values()) assert.ok(p.x >= 0 && p.y >= 0, 'no negative coords');
  }
});

test('heat: no burn node — fuel flows belt → machine directly; tiny surplus absorbed; graph validates', async () => {
  // Burning happens AT the machine (shown by its red fuel band), not as a dedicated
  // node. So there must be no burn node; instead the fuel SOURCE (the belt) wires
  // straight to the machines it powers, heat-styled. Sub-fractional rounding
  // surpluses are buffer, not discard nodes. And the graph must fully validate.
  const cfg = { maxTier: 6, cauldron: { enabled: true, inputPool: 'unrestricted' }, byproducts: { mode: 'reuse' }, belt: [{ item: 'Coke Powder' }], skills: { factory: 4, logistics: 12, fuel: 2, fertilizer: 5 }, machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: { Mars: 0.1 } }), model, { Mars: 0.1 });
  assert.equal(g.nodes.filter((n) => n.kind === 'burn').length, 0, 'no burn nodes — burning is shown as a fuel band');
  const beltCoke = g.nodes.find((n) => n.kind === 'belt' && n.label.includes('Coke'));
  const fuelEdges = g.edges.filter((e) => e.from === beltCoke.id && e.heat);
  assert.ok(fuelEdges.length > 0, 'belt fuel wires straight to the machines it powers');
  assert.ok(g.nodes.every((n) => !/::/.test(n.label || '')) && g.edges.every((e) => !/::/.test(e.item || '')), 'no virtual prefixes leak');
  const tinySurplus = g.nodes.filter((n) => n.type === 'surplus' && n.ratePerMin < 0.02);
  assert.equal(tinySurplus.length, 0, `no tiny surplus discard nodes, found ${tinySurplus.map((n) => n.label)}`);
  assert.deepEqual(g.summary.validation, [], `graph validates with no missing/dangling edges: ${JSON.stringify(g.summary.validation)}`);
});

test('validator: catches a node missing an input edge', async () => {
  const { validateGraph } = require('../src/flowgraph');
  const pt = buildProcessTable(db, resolveConfig({ cauldron: { enabled: true, inputPool: 'buyables' }, selfFert: false, machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  const result = await optimize(model, { demand: { Mars: 0.1 } });
  const g = buildFlowGraph(result, model, { Mars: 0.1 });
  assert.deepEqual(validateGraph(g, result, { Mars: 0.1 }), [], 'a clean build has no edge gaps');
  // sabotage: drop an input edge and confirm the validator flags it
  const victim = g.nodes.find((n) => n.type === 'process' && g.edges.some((e) => e.to === n.id));
  const broken = { ...g, edges: g.edges.filter((e) => e.to !== victim.id) };
  const issues = validateGraph(broken, result, { Mars: 0.1 });
  assert.ok(issues.some((i) => i.node === victim.id && i.kind === 'missing-input'), 'flags the node with the removed input edge');
});

test('orientation: TB lays out taller-than-wide, LR wider-than-tall', async () => {
  const pt = buildProcessTable(db, resolveConfig(MARS_CFG));
  const model = new Model(pt, db);
  const g = buildFlowGraph(await optimize(model, { demand: MARS }), model, MARS);
  const lr = doLayout(g, { orientation: 'LR' });
  const tb = doLayout(g, { orientation: 'TB' });
  // the same graph is taller (and narrower) in TB than in LR, and wider in LR than
  // in TB — the sound cross-orientation invariant (absolute aspect depends on how
  // many parallel lines the build splits into).
  assert.ok(tb.height > lr.height, `TB taller than LR (TB ${tb.height} vs LR ${lr.height})`);
  assert.ok(lr.width > tb.width, `LR wider than TB (LR ${lr.width} vs TB ${tb.width})`);
});

test('belt supply: fertilizer from belt provides NUTRIENT without a self-fert loop', async () => {
  const cfg = { cauldron: { enabled: false }, selfFert: false, belt: [{ item: 'Growth Potion', rate: 100000 }], machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const demand = { 'Linseed Oil': 600 };
  const result = await optimize(model, { demand });
  assert.equal(result.status, 'Optimal');
  // the belt Growth Potion source is active and feeds a fertilize column. Belt
  // supply is fenced to a belt:: row (fuel/fert/cash only), so the fertilize column
  // draws belt::Growth Potion — never the real item (which would let it be material).
  const belt = result.flows.find((f) => f.process.kind === 'belt' && f.process.item === 'Growth Potion');
  assert.ok(belt, 'belt Growth Potion source active');
  assert.deepEqual(belt.process.produces, { 'belt::Growth Potion': 1 }, 'belt supplies a fenced belt:: row');
  const fert = result.flows.find((f) => f.process.kind === 'fertilize' && f.process.consumes['belt::Growth Potion']);
  assert.ok(fert, 'belt Growth Potion is fertilized into nutrient');
  // no crafted-from-scratch fertilizer chain (the belt supplies the potion directly)
  const grownPotion = result.flows.find((f) => f.process.id === 'recipe:Growth Potion');
  assert.equal(grownPotion, undefined, 'Growth Potion comes from the belt, not a crafted loop');
});

test('belt supply: BELT_EPS cost prevents degenerate waste recipes (no spurious World Tree Nursery)', async () => {
  const cfg = { cauldron: { enabled: false }, selfFert: false, belt: [{ item: 'Growth Potion', rate: 100000 }], machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const result = await optimize(model, { demand: { 'Linseed Oil': 600 } });
  // World Tree Nursery consumes 5.97M nutrient/run for discarded leaves — must NOT run
  const worldTree = result.flows.find((f) => f.process.machine === 'World Tree Nursery');
  assert.equal(worldTree, undefined, 'no spurious World Tree Nursery activation');
  // belt Growth Potion draw stays small (real solution needs a few/min, not the 100k cap)
  const belt = result.flows.find((f) => f.process.kind === 'belt' && f.process.item === 'Growth Potion');
  assert.ok(belt.rate < 1000, `belt Growth Potion ${belt.rate} should be small, not degenerate`);
});

test('flow graph: fertilizer wires source → consumer directly (no NUTRIENT hub); opt-out suppresses it', async () => {
  const cfg = { cauldron: { enabled: false }, selfFert: false, belt: [{ item: 'Growth Potion', rate: 100000 }], machines: { defaultCount: 1000 } };
  const pt = buildProcessTable(db, resolveConfig(cfg));
  const model = new Model(pt, db);
  const demand = { 'Linseed Oil': 600 };
  // default: fertilizer flows straight from its source (here the belt) to the
  // machines that consume it — no NUTRIENT pool box, no fertilize node.
  const g = buildFlowGraph(await optimize(model, { demand }), model, demand);
  assert.equal(g.nodes.filter((n) => n.resourceKind === 'NUTRIENT').length, 0, 'no NUTRIENT hub node');
  assert.equal(g.nodes.filter((n) => n.kind === 'fertilize').length, 0, 'no fertilize node');
  assert.ok(g.edges.some((e) => e.nutrient), 'fertilizer → consumer nutrient edges drawn');
  assert.ok(g.nodes.some((n) => n.fertItem && n.fertPerMin > 0), 'a nutrient consumer shows a fertilizer band');
  // opt-out suppresses the consumer wiring
  const g2 = buildFlowGraph(await optimize(model, { demand }), model, demand, { resourceConsumerEdges: false });
  assert.equal(g2.edges.filter((e) => e.nutrient).length, 0, 'no nutrient wiring when opted out');
});

test('flow graph: heated machines show a fuel band and the Stone Furnace is counted', async () => {
  const pt = buildProcessTable(db, resolveConfig({ cauldron: { enabled: false }, machines: { defaultCount: 1000 } }));
  const model = new Model(pt, db);
  const demand = { 'Plant Ash': 100 }; // Crucible recipe → needs heat
  const g = buildFlowGraph(await optimize(model, { demand }), model, demand);
  // the Plant Ash Crucible node carries a per-machine fuel band
  const plantAsh = g.nodes.find((n) => n.id === 'recipe:Plant Ash');
  assert.ok(plantAsh.heatPerMin > 0 && plantAsh.fuelItem && plantAsh.fuelPerMin > 0,
    `Plant Ash shows fuel: ${plantAsh.fuelItem} ${plantAsh.fuelPerMin}/min`);
  // Stone Furnaces are still counted in the machine totals (slot occupancy)
  assert.ok(g.summary.machineTotals['Stone Furnace'] >= 1, 'furnaces counted in machine totals');
  // no HEAT box
  assert.equal(g.nodes.find((n) => n.id === 'resource:HEAT'), undefined);
});
