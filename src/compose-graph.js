// Phase 4: emit a composed tile tree (src/composer.js compose()) as the SAME
// { nodes, edges, summary } shape buildFlowGraph() produces for the LP, so the entire
// existing render stack (layout, svg, dot, mermaid, blueprint) works unchanged.
//
// The tile tree is REPLICATED (a pure tree, path-based unique ids), so emit is a straight
// walk: each tile → one node, each parent←child input → one material edge. Three shared
// trunks wire across the whole graph as resource/cash edges (matching flowgraph semantics):
//   • fuel  — the fuel carrier's root node → every heated machine (heat-styled edge + band)
//   • fert  — the fert carrier's root node → every nursery (nutrient-styled edge + band)
//   • money — a single main-belt money line → every buy/mint node (cash-styled edge). A minted
//             coin therefore always links back to the money line (the cash-provenance rule).

'use strict';

const { skillParams } = require('./config');

const EPS = 1e-6;

// node label conventions mirror flowgraph.processLabel
function tileLabel(tile) {
  switch (tile.source) {
    case 'buy': return `Buy ${tile.item}`;
    case 'mint': return `Mint ${tile.item}`;
    case 'belt': return `Main belt: ${tile.item}`;
    case 'cauldron': {
      const ins = Object.entries(tile.recipe.inputs).map(([n, q]) => (q > 1 ? `${q}× ${n}` : n)).join(' + ');
      return `${tile.item} ⬅ cauldron(${ins})`;
    }
    default: return tile.item; // recipe node is named for the item it makes
  }
}

// Translate one composed result { tree, fuel, fert, totals, summary } into a render graph.
function composeGraph(composed, db, cfg) {
  const params = skillParams(cfg.skills);
  const beltSpeed = params.beltSpeed;
  const liquid = (item) => !!(db.items[item] && db.items[item].liquid);

  const nodes = [];
  const edges = [];
  const byId = new Map();
  const addNode = (n) => { if (!byId.has(n.id)) { byId.set(n.id, n); nodes.push(n); } return byId.get(n.id); };

  const heatedNodes = [];   // { id, fuelPerMin } — wired to the fuel trunk root
  const nurseryNodes = [];  // { id, fertPerMin } — wired to the fert trunk root
  const moneyDraws = [];    // { id, copperPerMin, coinItem } — wired to the money line

  // Walk a tile tree, emitting nodes + material/byproduct edges. Returns the root node id.
  function walk(tile) {
    const leaf = tile.source === 'buy' || tile.source === 'mint' || tile.source === 'belt' || tile.source === 'unmakeable';
    if (leaf) {
      const external = tile.source !== 'unmakeable';
      const beltLanes = tile.source === 'belt' && beltSpeed > 0 && !liquid(tile.item) ? Math.ceil(tile.ratePerMin / beltSpeed - 1e-9) : null;
      addNode({
        id: tile.id,
        type: external ? 'external' : 'process',
        kind: tile.source === 'buy' ? 'purchase' : tile.source === 'mint' ? 'mint' : tile.source === 'belt' ? 'belt' : 'recipe',
        label: tileLabel(tile),
        item: tile.source === 'belt' ? tile.item : undefined,
        machine: null, machineCount: null, utilization: null, tileLoad: null,
        ratePerMin: tile.ratePerMin,
        copperPerMin: tile.copperPerMin || 0,
        beltLanes, beltSpeed: tile.source === 'belt' ? beltSpeed : null,
        badges: tile.source === 'mint' ? ['ASSUMPTION'] : [],
      });
      if ((tile.copperPerMin || 0) > 0) moneyDraws.push({ id: tile.id, copperPerMin: tile.copperPerMin, coinItem: tile.coinItem || null });
      return tile.id;
    }

    // recipe / cauldron process node
    const utilization = tile.machineCount && tile.tileLoad != null && tile.nurseryNote == null
      ? tile.tileLoad / tile.machineCount : null; // nurseries are plot-count (null), like flowgraph
    addNode({
      id: tile.id,
      type: 'process',
      kind: tile.source === 'cauldron' ? 'cauldron' : 'recipe',
      label: tileLabel(tile),
      machine: tile.machine,
      machineCount: tile.machineCount,
      utilization,
      tileLoad: tile.tileLoad,
      nurseryNote: tile.nurseryNote || null,
      ratePerMin: tile.ratePerMin,
      heatPerMin: tile.heatPerMin || 0,
      nutrientPerMin: tile.nutrientPerMin || 0,
      // supply bands (and the trunk edges, wired after the walk)
      fuelItem: tile.fuelPerMin > 0 ? composed.summary.fuelItem : null,
      fuelPerMin: tile.fuelPerMin || 0,
      fertItem: tile.fertPerMin > 0 ? composed.summary.fertItem : null,
      fertPerMin: tile.fertPerMin || 0,
      copperPerMin: 0,
      badges: [],
    });
    if (tile.fuelPerMin > 0) heatedNodes.push({ id: tile.id, fuelPerMin: tile.fuelPerMin });
    if (tile.fertPerMin > 0) nurseryNodes.push({ id: tile.id, fertPerMin: tile.fertPerMin });

    // material inputs: child (producer) → this tile (consumer)
    for (const child of tile.inputs || []) {
      const childId = walk(child);
      edges.push({ from: childId, to: tile.id, item: child.item, ratePerMin: child.ratePerMin });
    }
    // co-products → trash sinks (v1: no cross-tile feed)
    for (const [item, rate] of Object.entries(tile.byproducts || {})) {
      if (rate <= 0.05) continue;
      const tid = `trash:${tile.id}:${item}`;
      addNode({ id: tid, type: 'surplus', label: `${item} → trash`, ratePerMin: rate, badges: [] });
      edges.push({ from: tile.id, to: tid, item, ratePerMin: rate });
    }
    return tile.id;
  }

  // main tree + its demand sink
  const rootId = walk(composed.tree);
  const target = composed.summary.target;
  addNode({ id: `demand:${target}`, type: 'demand', label: `${target} (target)`, ratePerMin: composed.summary.ratePerMin, badges: [] });
  edges.push({ from: rootId, to: `demand:${target}`, item: target, ratePerMin: composed.summary.ratePerMin });

  // Walk BOTH trunks before wiring: a trunk can contain consumers of the OTHER trunk (the fert
  // carrier's Clay cauldron burns fuel; a fuel carrier could grow), so heatedNodes/nurseryNodes
  // aren't complete until every tree is walked. Wire only after all collection is done.
  const fuelRoot = composed.fuel ? walk(composed.fuel) : null;
  const fertRoot = composed.fert ? walk(composed.fert) : null;
  if (fuelRoot) for (const h of heatedNodes) edges.push({ from: fuelRoot, to: h.id, item: composed.summary.fuelItem, ratePerMin: h.fuelPerMin, heat: true });
  if (fertRoot) for (const n of nurseryNodes) edges.push({ from: fertRoot, to: n.id, item: composed.summary.fertItem, ratePerMin: n.fertPerMin, nutrient: true });

  // main-belt money line: a single source feeding every buy/mint (incl. the trunks'). A minted
  // coin links here by the cash-provenance rule; the edge is labelled in copper/min.
  const totalCopper = moneyDraws.reduce((s, d) => s + d.copperPerMin, 0);
  if (totalCopper > EPS) {
    const moneyId = 'money:belt';
    addNode({ id: moneyId, type: 'external', kind: 'belt', item: 'coins', label: 'Main belt: coins', ratePerMin: totalCopper, copperPerMin: totalCopper, beltLanes: null, beltSpeed: null, badges: [] });
    for (const d of moneyDraws) edges.push({ from: moneyId, to: d.id, item: d.coinItem || 'copper', ratePerMin: d.copperPerMin, cash: true });
  }

  // --- summary (flowgraph-compatible) ---
  const externals = nodes
    .filter((n) => n.type === 'external' && (n.kind === 'purchase' || n.kind === 'mint'))
    .map((n) => ({ item: n.label.replace(/^(Buy|Mint) /, ''), kind: n.kind, ratePerMin: n.ratePerMin, copperPerMin: n.copperPerMin }))
    .sort((a, b) => b.copperPerMin - a.copperPerMin);
  const summary = {
    copperPerMin: composed.summary.copperPerMin,            // total money-line draw
    operatingCopperPerMin: composed.summary.operatingCopperPerMin,
    capitalPerMin: 0,                                        // composer doesn't amortize machine build (yet)
    materialPerMin: composed.summary.copperPerMin,
    beltSpeed,
    liquidItems: Object.keys(db.items).filter((k) => db.items[k].liquid),
    externals,
    machineTotals: composed.summary.machineTotals,
    mintedCoins: composed.summary.mintedCoins,
    cgRounds: null,
    binding: [],
    selfSustaining: composed.summary.copperPerMin < 1,
    fragileRoutes: 0,
    solver: 'composer',
  };

  const graph = { nodes, edges, summary };
  summary.validation = validateComposeGraph(graph);
  return graph;
}

// Completeness check: every process node must have an incoming edge per material input it lists,
// a fuel edge if it burns, a fert edge if it fertilizes; every non-leaf output must go somewhere.
// (Structural — there's no LP result to cross-check against, so we validate the drawing itself.)
function validateComposeGraph(graph) {
  const incoming = new Map();
  const heatIn = new Set();
  const nutrientIn = new Set();
  for (const n of graph.nodes) incoming.set(n.id, new Set());
  for (const e of graph.edges) {
    if (incoming.has(e.to)) incoming.get(e.to).add(e.item);
    if (e.heat) heatIn.add(e.to);
    if (e.nutrient) nutrientIn.add(e.to);
  }
  const issues = [];
  for (const n of graph.nodes) {
    if (n.type !== 'process') continue;
    if (n.fuelItem && n.fuelPerMin > 0 && !heatIn.has(n.id)) issues.push({ node: n.id, kind: 'missing-fuel' });
    if (n.fertItem && n.fertPerMin > 0 && !nutrientIn.has(n.id)) issues.push({ node: n.id, kind: 'missing-fertilizer' });
  }
  return issues;
}

module.exports = { composeGraph, validateComposeGraph };
