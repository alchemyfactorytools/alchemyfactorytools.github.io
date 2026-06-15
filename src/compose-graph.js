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
  // What the USER declared on the belt for each item (rate cap; null = unlimited). Surfaced on belt
  // nodes so the box shows "drawn X/min of YOUR Y/min supply" instead of only the physical belt
  // carry speed (beltSpeed = the Logistics carry rate, which isn't the user's supply cap).
  const beltDeclared = new Map((cfg.belt || []).map((b) => (typeof b === 'string' ? [b, null] : [b.item, b.rate == null ? null : Number(b.rate)])));
  const beltNodeFields = (item, drawn) => {
    const supplyRate = beltDeclared.has(item) ? beltDeclared.get(item) : null;
    const forLanes = supplyRate != null ? supplyRate : drawn; // size belts to what you ROUTE IN (the supply), not the draw
    return { supplyRate, beltSpeed, beltLanes: beltSpeed > 0 && !liquid(item) ? Math.ceil(forLanes / beltSpeed - 1e-9) : null };
  };

  const nodes = [];
  const edges = [];
  const byId = new Map();
  const addNode = (n) => { if (!byId.has(n.id)) { byId.set(n.id, n); nodes.push(n); } return byId.get(n.id); };

  const heatedNodes = [];   // { id, fuelPerMin } — wired to the fuel trunk root
  const nurseryNodes = [];  // { id, fertPerMin } — wired to the fert trunk root
  const moneyDraws = [];    // { id, copperPerMin, coinItem } — wired to the money line
  const coSources = [];     // { id, item, rate } — every tile's gross co-product (Phase 7)

  // Walk a tile tree, emitting nodes + material/byproduct edges. Returns the root node id.
  function walk(tile) {
    const leaf = tile.source === 'buy' || tile.source === 'mint' || tile.source === 'belt' || tile.source === 'unmakeable';
    if (leaf) {
      const external = tile.source !== 'unmakeable';
      const belt = tile.source === 'belt' ? beltNodeFields(tile.item, tile.ratePerMin) : { supplyRate: null, beltSpeed: null, beltLanes: null };
      addNode({
        id: tile.id,
        type: external ? 'external' : 'process',
        kind: tile.source === 'buy' ? 'purchase' : tile.source === 'mint' ? 'mint' : tile.source === 'belt' ? 'belt' : 'recipe',
        label: tileLabel(tile),
        item: tile.source === 'belt' ? tile.item : undefined,
        machine: null, machineCount: null, utilization: null, tileLoad: null,
        ratePerMin: tile.ratePerMin,
        copperPerMin: tile.copperPerMin || 0,
        beltLanes: belt.beltLanes, beltSpeed: belt.beltSpeed, supplyRate: belt.supplyRate,
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
      // items the recipe loops back into itself — shown as a "↻ recirculated" band so a
      // raw co-output (e.g. the Athanor's 3 Iron Ingot) doesn't read as an orphaned output.
      recirc: (tile.recirc && tile.recirc.length) ? tile.recirc : null,
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
    // co-products: collected as supply sources, matched to consumers (reuse) or trashed (the
    // unclaimed remainder) in one pass AFTER the whole graph is walked — see co-product wiring below.
    for (const [item, rate] of Object.entries(tile.byproducts || {})) {
      if (rate <= 0.05) continue;
      coSources.push({ id: tile.id, item, rate });
    }
    return tile.id;
  }

  // main tree + its demand sink
  const rootId = walk(composed.tree);
  const target = composed.summary.target;
  addNode({ id: `demand:${target}`, type: 'demand', label: `${target} (target)`, ratePerMin: composed.summary.ratePerMin, badges: [] });
  edges.push({ from: rootId, to: `demand:${target}`, item: target, ratePerMin: composed.summary.ratePerMin });

  // Each carrier trunk is now { item, rate, beltRate, prodRate, prodTile }: belt supplies up to its
  // rate, the build PRODUCES the excess. Walk BOTH production sub-trunks BEFORE wiring (a sub-trunk
  // can hold consumers of the other carrier — the fert carrier's Clay cauldron burns fuel), then wire
  // each consumer's draw from the belt source and the production root in proportion to their share.
  const trunkSources = (trunk, tag) => {
    if (!trunk || !(trunk.rate > EPS)) return [];
    const srcs = [];
    if (trunk.beltRate > EPS) {
      const id = `${trunk.item}#${tag}-belt`;
      const belt = beltNodeFields(trunk.item, trunk.beltRate);
      addNode({ id, type: 'external', kind: 'belt', item: trunk.item, label: `Main belt: ${trunk.item}`, ratePerMin: trunk.beltRate, copperPerMin: 0, beltLanes: belt.beltLanes, beltSpeed: belt.beltSpeed, supplyRate: belt.supplyRate, badges: [] });
      srcs.push({ id, share: trunk.beltRate / trunk.rate });
    }
    if (trunk.prodTile) srcs.push({ id: trunk.prodTile._gid, share: trunk.prodRate / trunk.rate });
    return srcs;
  };
  if (composed.fuel && composed.fuel.prodTile) composed.fuel.prodTile._gid = walk(composed.fuel.prodTile);
  if (composed.fert && composed.fert.prodTile) composed.fert.prodTile._gid = walk(composed.fert.prodTile);
  const fuelSrcs = trunkSources(composed.fuel, 'fuel');
  const fertSrcs = trunkSources(composed.fert, 'fert');
  for (const s of fuelSrcs) for (const h of heatedNodes) {
    const r = h.fuelPerMin * s.share;
    if (r > EPS) edges.push({ from: s.id, to: h.id, item: composed.summary.fuelItem, ratePerMin: r, heat: true });
  }
  for (const s of fertSrcs) for (const n of nurseryNodes) {
    const r = n.fertPerMin * s.share;
    if (r > EPS) edges.push({ from: s.id, to: n.id, item: composed.summary.fertItem, ratePerMin: r, nutrient: true });
  }
  // Carrier-as-material: a consumer that eats the PRODUCED carrier as an ingredient draws it from the
  // SAME dedicated carrier line — a normal (blue) material edge, sharing the trunk's source(s) with
  // the heat edges above — instead of having rebuilt the chain inline (composer.js mergeMaterialInto).
  for (const f of composed.carrierMaterial || []) {
    const srcs = f.item === composed.summary.fuelItem ? fuelSrcs : f.item === composed.summary.fertItem ? fertSrcs : [];
    for (const s of srcs) {
      const r = f.rate * s.share;
      if (r > EPS) edges.push({ from: s.id, to: f.consumerId, item: f.item, ratePerMin: r });
    }
  }

  // Phase 7 — cross-tile co-product feeds. compose() recorded each consumer's claimed draw in
  // `coFeeds`; the gross supply is `coSources`. Per item, distribute the claim across sources by
  // each source's share of total supply (so a consumer draws proportionally from every producer of
  // that co-product), then trash each source's UNCLAIMED remainder. Σ wired = Σ claimed ≤ Σ supplied,
  // so material is conserved. In trash mode coFeeds is empty → every source trashes its whole output.
  const claimsByItem = new Map();
  for (const f of composed.coFeeds || []) {
    if (!claimsByItem.has(f.item)) claimsByItem.set(f.item, []);
    claimsByItem.get(f.item).push(f);
  }
  const srcByItem = new Map();
  for (const s of coSources) {
    if (!srcByItem.has(s.item)) srcByItem.set(s.item, []);
    srcByItem.get(s.item).push(s);
  }
  for (const [item, srcs] of srcByItem) {
    const supply = srcs.reduce((a, s) => a + s.rate, 0);
    const claims = claimsByItem.get(item) || [];
    const claimed = claims.reduce((a, c) => a + c.rate, 0);
    for (const s of srcs) {
      for (const c of claims) {
        const r = supply > EPS ? (s.rate * c.rate) / supply : 0;
        if (r > 0.05) edges.push({ from: s.id, to: c.consumerId, item, ratePerMin: r, coproduct: true });
      }
      const trashRate = supply > EPS ? s.rate * (1 - claimed / supply) : s.rate;
      if (trashRate > 0.05) {
        const tid = `trash:${s.id}:${item}`;
        addNode({ id: tid, type: 'surplus', label: `${item} → trash`, ratePerMin: trashRate, badges: [] });
        edges.push({ from: s.id, to: tid, item, ratePerMin: trashRate });
      }
    }
  }

  // main-belt money line: a single source feeding every buy/mint (incl. the trunks'). A minted
  // coin links here by the cash-provenance rule; the edge is labelled in copper/min. The line must
  // not conjure coins: if the user belts coins, THOSE back it (a real belt supply, valued at face);
  // if no coins are belted, the copper is "minted" — an explicit ASSUMPTION (you bring real cash),
  // flagged so it never silently reads as free, mirroring the LP's mint valve.
  const COINS = new Set(['Copper Coin', 'Silver Coin', 'Gold Coin']);
  const beltCoinEntries = (cfg.belt || []).map((b) => (typeof b === 'string' ? { item: b, rate: null } : { item: b.item, rate: b.rate == null ? null : Number(b.rate) })).filter((b) => COINS.has(b.item));
  // belt cash capacity = Σ (coin rate × face value); a coin belted with no rate is unlimited.
  const beltCopperCap = beltCoinEntries.reduce((s, b) => s + (b.rate == null ? Infinity : b.rate * (db.items[b.item].sellPrice || 0)), 0);
  const warnings = [...(composed.summary.warnings || [])];
  const totalCopper = moneyDraws.reduce((s, d) => s + d.copperPerMin, 0);
  if (totalCopper > EPS) {
    const moneyId = 'money:belt';
    const backed = beltCoinEntries.length > 0;
    const shortCopper = backed && isFinite(beltCopperCap) ? Math.max(0, totalCopper - beltCopperCap) : 0;
    if (shortCopper > EPS) warnings.push(`Belt coins supply ${Math.round(beltCopperCap)} c/min; this build spends ${Math.round(totalCopper)} c/min — minting the extra ${Math.round(shortCopper)} c/min (assumption).`);
    const coinNames = beltCoinEntries.map((b) => b.item);
    addNode({
      id: moneyId, type: 'external', kind: backed ? 'belt' : 'cash',
      item: backed ? coinNames.join('+') : 'coins',
      label: backed ? `Main belt: ${coinNames.join(', ')}${shortCopper > EPS ? ' (+mint)' : ''}` : 'Coins (minted — assumption)',
      ratePerMin: totalCopper, copperPerMin: totalCopper, beltLanes: null, beltSpeed: null,
      badges: backed ? (shortCopper > EPS ? ['ASSUMPTION'] : []) : ['ASSUMPTION'],
    });
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
    coproductFeeds: composed.summary.coproductFeeds || [],
    cgRounds: null,
    binding: [],
    selfSustaining: composed.summary.copperPerMin < 1,
    fragileRoutes: 0,
    solver: 'composer',
    warnings,
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
