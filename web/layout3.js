// LAYOUT 3 — forked from layout2 (the lane-based 2D engine). Goal: VERTICAL NESTING.
// A wide shared producer that feeds several narrower lines BELOW it (e.g. a 3-input
// cauldron over Bronze Rivet + Copper Bearing) currently takes its own full-height lane
// beside them; here it should SPAN the columns and let its consumers tuck under its
// sub-columns, reclaiming the empty side lanes. layout2 stays the proven fallback.
//
// Assembly-line layout. Columns = "steps from raw input": a node's column is its
// longest dependency chain from a raw/belt source (ASAP / longest-path-from-
// sources ranking). Raw inputs sit at column 0, each processing step is +1, and
// the output is anchored at the last column — even when that means long edges
// from an early input to a late machine (which is the assembly-line reading the
// user wants). dagre's built-in rankers don't do this (they float sources toward
// their consumers to shorten edges), so the ranking is computed here; we keep our
// own crossing-reduction (barycenter) and curved-link edge routing.
//
// layout(graph, opts) → {
//   pos: Map(id → {x, y, w, h})        // top-left corner
//   edges: Map("from\tto" → {start, end})  // border anchor points
//   recycle: Set("from\tto")           // shared / fed-back edges, for dim styling
//   width, height, orientation
// }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlchLayout3 = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Longest path from sources, cycles broken by DFS back-edge removal.
  function asapRanks(graph) {
    const adj = new Map();
    const ids = [];
    for (const n of graph.nodes) { adj.set(n.id, []); ids.push(n.id); }
    // Fuel/fertilizer (heat/nutrient) AND coin (cash) edges are a SUPPORTING resource
    // flow, not the main material spine — a furnace's fuel or a nursery's fertilizer is
    // produced deep in the graph and fed BACK to a machine near the top, and coins are
    // purchasing power fed INTO the bought-ore nodes, not a material the factory
    // transforms toward the target. Letting any of them drive the longest-path rank
    // distorts it: fuel/fert strand the real producer shallow (e.g. the Black Powder
    // cauldron eating from fertilized nurseries gets ranked ABOVE them, leaving a monster
    // edge to the target), and the coin belt shoves every Buy node down a row — lengthening
    // the whole diagram and leaving farm-grown lines (fed by fert, not coins) floating a
    // row higher than their bought-ore siblings. Exclude them all from ranking: machines
    // rank by their material inputs, and fuel/fert/coin distribution falls out as the
    // back-edges that draw as feedback loops / trunks.
    //
    // CO-PRODUCT reuse edges are the same kind of supporting flow. A co-product re-consumed
    // within the line (Coke's Charcoal re-ground into the Charcoal Powder Coke eats) loops
    // BACK to a shallower step; if it counts toward ranking it forms a cycle and the DFS can
    // break the REAL spine edge instead — inverting the line so the output box (Coke Powder)
    // lands mid-column instead of at the bottom. Exclude co-product edges too: the spine ranks
    // by primary inputs, and the reuse draws as a feedback loop without restructuring anything.
    const isSupport = (e) => e.heat || e.nutrient || e.cash || e.coproduct;
    for (const e of graph.edges) {
      if (e.from === e.to || isSupport(e) || !adj.has(e.from) || !adj.has(e.to)) continue;
      adj.get(e.from).push(e.to);
    }
    // mark back edges (edge to a node currently on the DFS stack)
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(ids.map((id) => [id, WHITE]));
    const back = new Set();
    for (const start of ids) {
      if (color.get(start) !== WHITE) continue;
      const stack = [{ id: start, i: 0 }];
      color.set(start, GRAY);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const nb = adj.get(top.id);
        if (top.i < nb.length) {
          const v = nb[top.i++];
          const c = color.get(v);
          if (c === WHITE) { color.set(v, GRAY); stack.push({ id: v, i: 0 }); }
          else if (c === GRAY) back.add(top.id + '\t' + v);
        } else { color.set(top.id, BLACK); stack.pop(); }
      }
    }
    // longest-path on the forward DAG (Kahn)
    const fadj = new Map(ids.map((id) => [id, []]));
    const indeg = new Map(ids.map((id) => [id, 0]));
    for (const e of graph.edges) {
      if (e.from === e.to || isSupport(e) || back.has(e.from + '\t' + e.to) || !fadj.has(e.from) || !fadj.has(e.to)) continue;
      fadj.get(e.from).push(e.to);
      indeg.set(e.to, indeg.get(e.to) + 1);
    }
    const rank = new Map(ids.map((id) => [id, 0]));
    const q = ids.filter((id) => indeg.get(id) === 0);
    while (q.length) {
      const u = q.shift();
      for (const v of fadj.get(u)) {
        if (rank.get(v) < rank.get(u) + 1) rank.set(v, rank.get(u) + 1);
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) q.push(v);
      }
    }
    return { rank, back };
  }

  // Spanning tree from the output(s): parent[from]=to is the "main line" edge a
  // node was first reached by; every other material edge is a shared/fed-back tap.
  function spanningTree(graph) {
    const childrenOf = new Map();
    const consumers = new Map();
    for (const n of graph.nodes) { childrenOf.set(n.id, []); consumers.set(n.id, 0); }
    for (const e of graph.edges) {
      if (e.from === e.to) continue;
      childrenOf.get(e.to).push({ id: e.from, rate: e.ratePerMin || 0 });
      consumers.set(e.from, consumers.get(e.from) + 1);
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => b.rate - a.rate);
    const parent = new Map();
    const treeKids = new Map();
    for (const n of graph.nodes) treeKids.set(n.id, []);
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const k of childrenOf.get(id)) if (!seen.has(k.id)) { parent.set(k.id, id); treeKids.get(id).push(k.id); visit(k.id); }
    };
    const roots = [
      ...graph.nodes.filter((n) => n.type === 'demand'),
      ...graph.nodes.filter((n) => n.type === 'resource'),
      ...graph.nodes.filter((n) => n.type !== 'demand' && n.type !== 'resource' && consumers.get(n.id) === 0),
    ];
    for (const r of roots) visit(r.id);
    for (const n of graph.nodes) visit(n.id);
    return { parent, treeKids };
  }

  function recycleEdges(graph) {
    const { parent } = spanningTree(graph);
    const recycle = new Set();
    for (const e of graph.edges) {
      if (e.from === e.to) continue;
      if (parent.get(e.from) !== e.to) recycle.add(e.from + '\t' + e.to);
    }
    return recycle;
  }

  // Group nodes into production "lines": one line per direct input of the final
  // product. A node joins the line of its NEAREST line-root, measured in hops down
  // the consumer→producer DAG (multi-source BFS). Spanning-tree ancestry was the
  // old rule, but its depth-first claim let one line absorb the whole graph while
  // sibling final-inputs (e.g. Copper Bearing) were stranded as bare singletons
  // because their own feeder chain had already been swallowed. Nearest-root keeps
  // each final-input's immediate feeders (Copper Ingot, Copper Coin) in its line.
  // Main-belt supply nodes feed many lines at once, so they belong to no single
  // production line — they're laid out as one shared band spanning all lanes.
  const isBelt = (n) => n.type === 'external' && n.kind === 'belt';

  function assignClusters(graph) {
    const { parent, treeKids } = spanningTree(graph);
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const beltSet = new Set(graph.nodes.filter(isBelt).map((n) => n.id));
    // A collapsed line (kind 'group') is ALREADY a self-contained box — exclude it
    // from clustering (like the belt) so the re-cluster doesn't wrap it in a second,
    // same-named container. Otherwise collapsing "Steel Gear line" yields a "Steel
    // Gear line" box that itself contains a "Steel Gear line" group node.
    const groupSet = new Set(graph.nodes.filter((n) => n.kind === 'group').map((n) => n.id));
    const excluded = (id) => beltSet.has(id) || groupSet.has(id);
    // Utility (fuel/fert) sources — nodes with an outgoing heat/nutrient edge that aren't
    // the belt. Detected up-front because a heat/nutrient CARRIER must not be claimed as a
    // product line-root below: a fuel like Charcoal Powder that happens to heat a target's
    // FINAL machine (the Brick kiln burns it, and at higher rate than the Clay it bakes)
    // would otherwise be adopted as that target's busiest tree-child and seeded as its own
    // product line — never getting the Fuel-line (top-band) treatment its fertilizer
    // counterpart gets, since fertilizer only ever feeds deep Nurseries, not a final machine.
    // A node that directly produces a DEMANDED item is exempt: it's the real final producer
    // (even when the target is itself a fuel, e.g. Black Powder), so it stays a product line.
    const demandSet = new Set(graph.nodes.filter((n) => n.type === 'demand').map((n) => n.id));
    const demandProducers = new Set();
    for (const e of graph.edges) if (demandSet.has(e.to)) demandProducers.add(e.from);
    const fuelSources = new Set();
    const fertSources = new Set();
    for (const e of graph.edges) {
      if (demandProducers.has(e.from)) continue;
      if (e.nutrient && !beltSet.has(e.from)) fertSources.add(e.from);
      else if (e.heat && !beltSet.has(e.from)) fuelSources.add(e.from);
    }
    const isUtilSource = (id) => fuelSources.has(id) || fertSources.has(id);
    // line roots = tree-children of the producer of each demanded item, busiest first
    // (rate order, inherited from treeKids) so ties go to the larger line. A util (fuel/
    // fert) carrier among them is skipped — it groups as the Fuel/Fert line (seeded below)
    // rather than being double-claimed as a product line of the target it happens to heat.
    const lineRoots = [];
    const lineRootSet = new Set();
    for (const d of graph.nodes.filter((n) => n.type === 'demand')) {
      for (const prod of treeKids.get(d.id)) for (const inp of treeKids.get(prod)) {
        if (!lineRootSet.has(inp) && !excluded(inp) && !isUtilSource(inp)) { lineRootSet.add(inp); lineRoots.push(inp); }
      }
    }
    if (!lineRoots.length) return { clusterOf: new Map(), clusters: [] };
    // label each line by the item it produces toward the final product
    const itemOfEdge = new Map();
    for (const e of graph.edges) if (lineRootSet.has(e.from) && parent.get(e.from) === e.to) itemOfEdge.set(e.from, e.item);
    // adjacency: consumer → its inputs (producers feeding it)
    const inputsOf = new Map(graph.nodes.map((n) => [n.id, []]));
    for (const e of graph.edges) {
      if (e.from === e.to) continue;
      inputsOf.get(e.to).push(e.from);
    }
    // Seeds for the multi-source nearest-root BFS. Product lines first (so a tie
    // goes to a product), then the UTILITY subsystems — fuel and fertilizer
    // production — each as its own line. Making fertilizer (the Growth-Potion →
    // Fertilize chain) and crafted fuel their own subgraphs reads them as the
    // distinct major components they are, instead of folding them into a product
    // line. Each utility line is multi-seeded (all its sink nodes share one key).
    const FERT = 'util:fertilizer';
    const FUEL = 'util:fuel';
    const labelOf = new Map();
    const seeds = []; // { node, key } in priority order
    for (const r of lineRoots) { seeds.push({ node: r, key: r }); labelOf.set(r, itemOfEdge.get(r) || (nodeById.get(r) || {}).label || r); }
    // Seed the utility subsystems (fuel / fertilizer) detected up-front above. Their
    // upstream production chain becomes the Fuel / Fertilizer line — its own subgraph,
    // pinned to the top band — so each reads as the distinct major component it is.
    // Fertilizer takes priority when a node feeds both.
    for (const n of graph.nodes) {
      if (fertSources.has(n.id)) { seeds.push({ node: n.id, key: FERT }); labelOf.set(FERT, 'Fertilizer'); }
      else if (fuelSources.has(n.id)) { seeds.push({ node: n.id, key: FUEL }); labelOf.set(FUEL, 'Fuel'); }
    }
    // multi-source BFS: each node joins the nearest seed. Shared queue → correct
    // nearest-source labelling; ties go to whichever was enqueued first (products).
    const runBFS = (seedList) => {
      const cof = new Map();
      const queue = [];
      for (const s of seedList) { if (!cof.has(s.node) && !excluded(s.node)) { cof.set(s.node, s.key); queue.push(s.node); } }
      for (let qi = 0; qi < queue.length; qi++) {
        const key = cof.get(queue[qi]);
        for (const inp of inputsOf.get(queue[qi])) {
          // Never let a util (fuel/fert) line swallow a node that directly produces the
          // target. Black Powder is itself a fuel, so its cauldron feeds a burn node;
          // the util BFS would otherwise propagate the fuel key UP into the cauldron,
          // pinning the real final producer to the top fuel band. Keep it unclustered
          // (the normal home for final producers — they sit on the spine by the target).
          if (demandProducers.has(inp) && String(key).startsWith('util:')) continue;
          if (!cof.has(inp) && !excluded(inp)) { cof.set(inp, key); queue.push(inp); }
        }
      }
      return cof;
    };
    let clusterOf = runBFS(seeds);

    // Pass 2 — split out SHARED intermediates. A material producer whose output
    // feeds ≥2 different lines (e.g. Soap → several cauldrons across product lines)
    // is its own sub-assembly, not part of one product line. Group connected shared
    // producers into a component and give each component its own line; their
    // exclusive upstream follows. This de-tangles the cross-line spaghetti.
    const seedNodes = new Set(seeds.map((s) => s.node));
    // a line root's own immediate feeder stays in that line — splitting it out would
    // strand the root as a bare singleton (Bronze Ingot belongs to the Bronze Rivet
    // line even though it also taps a cauldron elsewhere).
    const protectedFeeders = new Set();
    for (const r of lineRoots) for (const inp of inputsOf.get(r) || []) protectedFeeders.add(inp);
    const consumerKeys = new Map();
    for (const e of graph.edges) {
      if (e.heat || e.nutrient || e.from === e.to) continue;
      const tk = clusterOf.get(e.to);
      if (tk == null) continue;
      if (!consumerKeys.has(e.from)) consumerKeys.set(e.from, new Set());
      consumerKeys.get(e.from).add(tk);
    }
    // A line-root feeder normally stays in that line (don't strand the root), but only
    // when it's MOSTLY for that line. If it exports the majority of its output to other
    // lines (e.g. Iron Ingot: 80% goes to Steel/Bronze, 20% to its own nails), it's a
    // shared sub-assembly — leaving it inside one consumer's line makes that line
    // un-tileable (each tile would dump a big surplus of the intermediate mid-line).
    const exportFrac = (nid) => {
      const myKey = clusterOf.get(nid);
      let own = 0, other = 0;
      for (const e of graph.edges) {
        if (e.from !== nid || e.heat || e.nutrient || e.from === e.to) continue;
        const r = e.ratePerMin || 0;
        if (clusterOf.get(e.to) === myKey) own += r; else other += r;
      }
      return own + other > 0 ? other / (own + other) : 0;
    };
    const shared = new Set();
    for (const [nid, keys] of consumerKeys) {
      const stayLocal = protectedFeeders.has(nid) && exportFrac(nid) < 0.5;
      if (keys.size >= 2 && !seedNodes.has(nid) && !excluded(nid) && !stayLocal) shared.add(nid);
    }
    if (shared.size) {
      // connected components among shared producers (linked by a material edge)
      const adj = new Map([...shared].map((n) => [n, []]));
      for (const e of graph.edges) {
        if (e.heat || e.nutrient) continue;
        if (shared.has(e.from) && shared.has(e.to)) { adj.get(e.from).push(e.to); adj.get(e.to).push(e.from); }
      }
      const compOf = new Map();
      let ci = 0;
      for (const s of shared) {
        if (compOf.has(s)) continue;
        const stack = [s]; compOf.set(s, ci);
        while (stack.length) { const u = stack.pop(); for (const v of adj.get(u)) if (!compOf.has(v)) { compOf.set(v, ci); stack.push(v); } }
        ci++;
      }
      // label each component by its most-DOWNSTREAM node — the shared product the
      // sub-assembly exists to make (one not consumed by its own component-mates),
      // breaking ties by throughput. So {Plant Ash → Linseed Oil → Soap} reads as
      // the "Soap" line, not "Plant Ash".
      const consumedWithin = new Set();
      for (const e of graph.edges) {
        if (e.heat || e.nutrient) continue;
        if (shared.has(e.from) && shared.has(e.to) && compOf.get(e.from) === compOf.get(e.to)) consumedWithin.add(e.from);
      }
      const compLabel = new Map();
      const compScore = new Map();
      for (const s of shared) {
        const c = compOf.get(s);
        const score = (consumedWithin.has(s) ? 0 : 1e9) + ((nodeById.get(s) || {}).ratePerMin || 0);
        if (score >= (compScore.get(c) ?? -1)) { compScore.set(c, score); compLabel.set(c, (nodeById.get(s) || {}).label || s); }
      }
      const seeds2 = [...seeds];
      for (const s of shared) {
        const key = 'shared:' + compOf.get(s);
        seeds2.push({ node: s, key });
        labelOf.set(key, compLabel.get(compOf.get(s)));
      }
      clusterOf = runBFS(seeds2);
    }

    // Disposal sinks (surplus / trash) have no line of their own — the BFS above never
    // reaches them (they produce nothing a seed consumes), so they'd fall into the trailing
    // unclustered band on the far side with a feed edge raking the whole canvas. Attach each
    // to its PRODUCER's line (busiest incoming material edge wins) so it draws as a short
    // stub directly under the machine that discards into it. Done after the final BFS so the
    // pass-2 re-run can't drop the assignment.
    for (const n of graph.nodes) {
      if (n.type !== 'surplus') continue;
      let from = null, best = -1;
      for (const e of graph.edges) {
        if (e.to !== n.id || e.heat || e.nutrient || e.cash || e.from === e.to) continue;
        if ((e.ratePerMin || 0) > best) { best = e.ratePerMin || 0; from = e.from; }
      }
      if (from != null && clusterOf.has(from)) clusterOf.set(n.id, clusterOf.get(from));
    }

    const byKey = new Map();
    for (const [nid, key] of clusterOf) {
      if (!byKey.has(key)) byKey.set(key, { id: key, label: labelOf.get(key) || key, members: [] });
      byKey.get(key).members.push(nid);
    }
    const clusters = [...byKey.values()];
    // Each line's DOMINANT product leaving the box (per minute) and one belt's carry rate
    // — blueprint() caps a tile's output at one belt, and the header divides by K to show
    // each tile's rate. Must match the leaving-item logic used to render the header.
    const summary = graph.summary || {};
    const beltSpeed = summary.beltSpeed || 0;
    const liquidSet = new Set(summary.liquidItems || []);
    const lineOutput = (members) => {
      const mset = new Set(members);
      const byItem = new Map();
      for (const e of graph.edges) {
        if (e.heat || e.nutrient || e.cash) continue;
        if (mset.has(e.from) && !mset.has(e.to)) byItem.set(e.item, (byItem.get(e.item) || 0) + (e.ratePerMin || 0));
      }
      let out = null;
      for (const [item, rate] of byItem) if (!out || rate > out.rate) out = { item, rate };
      return out;
    };
    // A FUEL / FERTILIZER utility line emits its product (the carrier) on heat / nutrient edges,
    // which lineOutput excludes — so its material output is null (or a stray boundary edge) and it
    // never belt-tiles or shows a per-tile rate. Derive the line output from those support edges
    // instead: the carrier is the edge's item. The TOTAL output is everything the carrier leaves on,
    // fuel AND material — a produced carrier can also be drawn as a bulk ingredient (Coke Powder into
    // Steel Ingot), so summing only the heat edges undercounts the tile's real per-tile output.
    const utilOutput = (members, kind) => {
      const mset = new Set(members);
      let item = null;
      for (const e of graph.edges) if (e[kind] && mset.has(e.from) && !mset.has(e.to)) { item = e.item; break; }
      if (!item) return null;
      let rate = 0;
      for (const e of graph.edges) if (e.item === item && mset.has(e.from) && !mset.has(e.to)) rate += e.ratePerMin || 0;
      return rate > 0 ? { item, rate } : null;
    };
    for (const c of clusters) {
      const out = String(c.id) === 'util:fuel' ? utilOutput(c.members, 'heat')
        : String(c.id) === 'util:fertilizer' ? utilOutput(c.members, 'nutrient')
        : lineOutput(c.members);
      c.outItem = out ? out.item : null;
      c.outRate = out ? out.rate : null;
      // Terminal output machine(s): the member(s) that emit the line's product across the box
      // boundary (the fuel line's Grinder→Coke Powder; a material line's final machine). Their
      // saturated single-machine throughput defines a tile — a tile is built around whole output
      // machines running at 100%, not the demand-throttled rate.
      const mset = new Set(c.members);
      const termIds = new Set();
      if (c.outItem) for (const e of graph.edges) if (e.item === c.outItem && mset.has(e.from) && !mset.has(e.to)) termIds.add(e.from);
      // liquids are piped (effectively uncapped → cap 0 = no floor), solids ride a belt.
      const cap = c.outItem && liquidSet.has(c.outItem) ? 0 : beltSpeed;
      c.tile = blueprint(c.members, nodeById, c.outRate, cap, termIds);
    }
    return { clusterOf, clusters };
  }

  // Tileable blueprint for a line: the integer-machine cell you stamp out, and how many copies. A
  // tile is a REUSABLE MODULE built around its TERMINAL OUTPUT MACHINE(S) running at 100% — we pack as
  // many whole output machines as one belt can carry, size the feeders to keep them saturated, and
  // stamp K tiles to cover demand. The per-tile output is that SATURATED machine throughput (not the
  // demand-throttled flow): a stamped tile tells you what it CAN make, leaning into buffering — the
  // line backpressures to meet actual demand (machines idle when buffers fill — build cost only, no
  // extra input/fuel). Liquids are piped/uncapped (transportCap 0) → the whole line is ONE tile.
  // NURSERIES fold in via tileLoad (fractional plot count) like any other machine.
  function blueprint(members, nodeById, outRate, transportCap, termIds) {
    // timed machines use machineCount × utilization; nurseries (utilization == null) use
    // the continuous tileLoad (fractional plot count) so they fold in too.
    const loadOf = (n) => (n.machineCount && n.utilization != null ? n.machineCount * n.utilization
      : (n.tileLoad != null ? n.tileLoad : null));
    const loads = members.map((m) => nodeById.get(m))
      .filter((n) => n && n.machine && loadOf(n) != null)
      .map((n) => ({ id: n.id, label: n.label, machine: n.machine, load: loadOf(n), rate: n.ratePerMin || 0 }));
    if (loads.length < 2) return null;
    const mkCell = (K, f) => {
      let over = 0, total = 0;
      const cell = loads.map((l) => {
        const count = Math.max(1, Math.ceil(l.load * f - 1e-6));
        over += K * count - l.load; total += K * count;
        return { label: l.label, machine: l.machine, count };
      });
      return { cell, over, total };
    };
    // Saturated single-machine output of the terminal stage: s = grossRate / machine-load (a node's
    // ratePerMin is its gross production; load is its fractional saturated-machine count at demand).
    const term = loads.filter((l) => termIds && termIds.has(l.id));
    const termLoad = term.reduce((a, l) => a + l.load, 0);
    const termRate = term.reduce((a, l) => a + l.rate, 0);
    const s = termLoad > 1e-9 ? termRate / termLoad : 0;
    if (!(s > 1e-9)) {
      // fallback: terminal machine unidentifiable → the old demand-rate / belt-cap tiling.
      const beltTiles = transportCap > 0 && outRate > transportCap + 1e-6;
      const K = beltTiles ? Math.min(200, Math.ceil(outRate / transportCap - 1e-6)) : 1;
      const { cell, over, total } = mkCell(K, beltTiles ? transportCap / outRate : 1);
      return { K, cell, idle: total ? over / total : 0, total, perTileOut: beltTiles ? transportCap : outRate };
    }
    // whole terminal machines for the whole line, capped to one belt's worth per tile (≥1). K = the
    // fewest tiles that keep each ≤ one belt; then spread the machines EVENLY across those K tiles
    // (ceil(termTotal/K)) rather than filling each to the belt and stranding the last — minimal idle.
    const termTotal = Math.max(1, Math.ceil(termLoad - 1e-6));
    const perBelt = transportCap > 0 ? Math.max(1, Math.floor(transportCap / s + 1e-6)) : Infinity;
    // Cap tiles by the NET output belt count — never split a line into more tiles than its external
    // output needs belts. A self-fueling line's terminal machines run at GROSS (incl. self-fuel that
    // never leaves the line), so termTotal/perBelt over-tiles a line whose deliverable output is ≤ one
    // belt (a Charcoal Powder fuel line: 60 net = 1 belt, but 7 gross Grinders would otherwise → 2 tiles).
    const netBelts = transportCap > 0 ? Math.max(1, Math.ceil(outRate / transportCap - 1e-6)) : Infinity;
    const K = Math.min(200, Math.max(1, Math.ceil(termTotal / perBelt - 1e-6)), netBelts);
    const tTerm = Math.max(1, Math.ceil(termTotal / K - 1e-6));
    // feeders sized so a tile's terminal machines run at 100%: f = terminal machines per tile / total.
    const { cell, total } = mkCell(K, tTerm / termLoad);
    const perTileOut = Math.min(tTerm * s, transportCap > 0 ? transportCap : Infinity);
    // idle = fraction of the tiles' SATURATED terminal capacity that backpressures to meet demand.
    const satCap = K * tTerm * s;
    const idle = satCap > 1e-9 ? Math.max(0, 1 - termRate / satCap) : 0;
    return { K, cell, idle, total, perTileOut };
  }

  function layout(graph, opts) {
    const o = opts || {};
    const NODE_W = o.nodeW || 200, NODE_H = o.nodeH || 60, GAP_FLOW = o.gapFlow || 110, GAP_CROSS = o.gapCross || 22;
    const orientation = o.orientation === 'TB' ? 'TB' : 'LR';
    const { rank, back } = asapRanks(graph);
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const nodeById2 = (id) => nodeMap.get(id) || {};

    // Auxiliary nodes — resource pools, the fertilize/burn suppliers that feed
    // them, and discard/sale sinks — must not push the product past the end. A
    // self-fertilizer/self-fuel loop (e.g. Growth Potion → Fertilize → NUTRIENT)
    // otherwise ranks deeper than the product machine, stranding it mid-graph.
    // Cap auxiliary nodes to the deepest REAL production rank, then anchor the
    // output one column past that.
    const isAux = (n) => n.type === 'resource' || n.type === 'surplus'
      || n.kind === 'fertilize' || n.kind === 'burn' || n.kind === 'sale';

    // production-line clusters → a lane index per cluster so its members stay in a
    // contiguous band across columns (and unclustered nodes go after, by barycenter)
    const cluster = o.clusters === false ? { clusterOf: new Map(), clusters: [] } : assignClusters(graph);

    // VERTICAL NESTING (layout3's reason to exist). A wide SHARED producer that sits
    // entirely above the consumer lines it feeds is merged with them into ONE lane
    // cluster. The intra-cluster tidy-tree then packs the producer spanning the top and
    // the consumers under its columns (it prefers the high-out-degree producer as the
    // primary parent and centres a parent over its children's span) — instead of each
    // taking a full-height lane side by side with empty gaps. Sub-line boxes are still
    // drawn per original cluster, so each stays a labelled, tileable unit.
    if (o.clusters !== false) {
      const { clusterOf, clusters } = cluster;
      const byKey = new Map(clusters.map((c) => [c.id, c]));
      const isSharedId = (id) => String(id).startsWith('shared:');
      const isUtilId = (id) => String(id).startsWith('util:');
      const feeds = new Map(clusters.map((c) => [c.id, new Set()]));
      const fedBy = new Map(clusters.map((c) => [c.id, new Set()]));
      for (const e of graph.edges) {
        if (e.heat || e.nutrient || e.cash) continue;
        const a = clusterOf.get(e.from), b = clusterOf.get(e.to);
        if (a == null || b == null || a === b || !byKey.has(a) || !byKey.has(b)) continue;
        feeds.get(a).add(b); fedBy.get(b).add(a);
      }
      const rankRange = (c) => {
        let lo = Infinity, hi = -Infinity;
        for (const m of c.members) { const r = rank.get(m) ?? 0; if (r < lo) lo = r; if (r > hi) hi = r; }
        return [lo, hi];
      };
      const merges = [];
      const consumed = new Set();
      for (const c of clusters) {
        if (!isSharedId(c.id) || consumed.has(c.id)) continue;
        const cons = [...feeds.get(c.id)].map((k) => byKey.get(k)).filter(Boolean);
        if (!cons.length) continue;
        const [, pHi] = rankRange(c);
        // every consumer must be a product line sitting ENTIRELY below the producer, not
        // already in another group, and fed only by the producer or its fellow consumers
        // (a side feeder from outside would still need its own lane → skip nesting then).
        const groupIds = new Set([c.id, ...cons.map((x) => x.id)]);
        const ok = cons.length && cons.every((cc) => {
          if (isUtilId(cc.id) || isSharedId(cc.id) || consumed.has(cc.id)) return false;
          if (rankRange(cc)[0] <= pHi) return false;
          for (const f of fedBy.get(cc.id)) if (!groupIds.has(f)) return false;
          return true;
        });
        if (!ok) continue;
        const subs = [c, ...cons];
        const members = [].concat(...subs.map((s) => s.members));
        const mc = { id: 'nest:' + c.id, label: cons[0].label, members, tile: null, subClusters: subs };
        merges.push(mc);
        subs.forEach((s) => consumed.add(s.id));
        for (const m of members) clusterOf.set(m, mc.id);
      }
      if (merges.length) cluster.clusters = clusters.filter((c) => !consumed.has(c.id)).concat(merges);
    }
    // Fuel/fertilizer UTILITY lines are drawn as normal 2D cluster boxes — just like
    // any product sub-graph — NOT as 1-D horizontal bands (that fought their real
    // branching and looked broken). To keep them out of the main spine we pin each
    // near the TOP: remap its nodes to the line's INTERNAL sub-rank, so the whole box
    // sits in the top rows just under the belt, and give util lines the first lanes.
    const isUtil = (c) => String(c.id).startsWith('util:');
    const utilMembers = new Set();
    for (const c of cluster.clusters.filter(isUtil)) for (const m of c.members) utilMembers.add(m);
    for (const c of cluster.clusters.filter(isUtil)) {
      const mset = new Set(c.members);
      const indeg = new Map(c.members.map((m) => [m, 0]));
      const adj = new Map(c.members.map((m) => [m, []]));
      // Rank by the PRODUCTION flow only — exclude the nutrient/heat distribution
      // edges (the fertilizer/fuel the line makes feeding its own nurseries/machines)
      // AND co-product reuse edges (Coke's Charcoal re-ground into its own Charcoal
      // Powder). Those run "backwards" up the line, so counting them shoves the line's
      // OUTPUT (e.g. Fertile Catalyst, Coke Powder) into the middle — or, for the
      // co-product loop, deadlocks this Kahn sort and strands the output at sub-rank 0
      // (the TOP). Dropping them puts the output at the bottom and the reuse draws as a loop.
      for (const e of graph.edges) {
        if (mset.has(e.from) && mset.has(e.to) && e.from !== e.to && !e.nutrient && !e.heat && !e.coproduct && !back.has(e.from + '\t' + e.to)) {
          adj.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1);
        }
      }
      const q = c.members.filter((m) => indeg.get(m) === 0);
      const sr = new Map(c.members.map((m) => [m, 0]));
      for (let k = 0; k < q.length; k++) for (const v of adj.get(q[k])) { if (sr.get(v) < sr.get(q[k]) + 1) sr.set(v, sr.get(q[k]) + 1); indeg.set(v, indeg.get(v) - 1); if (indeg.get(v) === 0) q.push(v); }
      for (const m of c.members) rank.set(m, sr.get(m)); // pin the util box to the top rows, output at its bottom
    }

    // Anchor the target at the bottom. Compute the deepest REAL production rank AFTER
    // the util remap (so a self-crafted fuel/fertilizer line, which we just pinned to
    // the top, no longer inflates where the target lands) and EXCLUDING util members
    // and auxiliary sinks. Cap aux (resource/surplus/burn/fertilize/sale) to that
    // depth and place the demand one row past it. We do NOT force the final producer
    // down to meet it: production lines read best linear, with a node's inputs stacked
    // straight above it — a long OUTPUT edge from a shallow producer down to the target
    // is preferable to dragging the producer down and fanning long INPUT edges up to it.
    let realMax = 0;
    for (const n of graph.nodes) {
      if (n.type !== 'demand' && !isAux(n) && !utilMembers.has(n.id)) realMax = Math.max(realMax, rank.get(n.id));
    }
    for (const n of graph.nodes) {
      if (isAux(n) && rank.get(n.id) > realMax) rank.set(n.id, realMax);
      if (n.type === 'demand') rank.set(n.id, realMax + 1);
    }
    // Drop each disposal sink to exactly one row below its producer (assignClusters already put
    // it in the producer's lane), so a trashed co-product sits directly under the machine that
    // makes it instead of being capped to the deepest production row off in a corner.
    for (const n of graph.nodes) {
      if (n.type !== 'surplus') continue;
      let from = null, best = -1;
      for (const e of graph.edges) {
        if (e.to !== n.id || e.heat || e.nutrient || e.cash || e.from === e.to) continue;
        if ((e.ratePerMin || 0) > best) { best = e.ratePerMin || 0; from = e.from; }
      }
      if (from != null && rank.has(from)) rank.set(n.id, rank.get(from) + 1);
    }
    let maxR = 0;
    // re-derive maxR (util remap may have changed the deepest rank)
    maxR = 0; for (const r of rank.values()) if (r > maxR) maxR = r;
    const utilLines = []; // no longer special-cased into bands (kept for the band loop below, now a no-op)
    const utilSet = new Set();
    // Lane order: product lines first (then shared sub-assemblies), each at its array
    // index. Util (fuel/fert) lines are then slotted in at the AVERAGE lane of the lines
    // they FEED — so the fuel box lands centred over its consumers (its output reaches
    // both sides) instead of being shoved to one end. Combined with the high pinning
    // above, the fuel/fert box sits top-and-centred over the spine it powers.
    // Product lines take the first lanes (in array order). Then SHARED sub-assemblies
    // and UTIL (fuel/fert) lines are each slotted at the AVERAGE lane of the lines they
    // FEED — so a shared producer (e.g. the Impure Copper Powder cauldron) sits NEXT TO
    // its consumer instead of being dumped at the far end with an edge raking across the
    // whole diagram. Shared lines are placed before util so util can centre over them too.
    const isShared = (c) => String(c.id).startsWith('shared:');
    const products = cluster.clusters.filter((c) => !isUtil(c) && !isShared(c));
    const sharedC = cluster.clusters.filter((c) => !isUtil(c) && isShared(c));
    const utilC = cluster.clusters.filter(isUtil);
    const hintOf = new Map();
    products.forEach((c, i) => { c.__laneHint = i; for (const m of c.members) hintOf.set(m, i); });
    const baryHint = (clusters) => {
      for (const c of clusters) {
        const mset = new Set(c.members);
        const hints = [];
        for (const e of graph.edges) if (mset.has(e.from) && !mset.has(e.to) && hintOf.has(e.to)) hints.push(hintOf.get(e.to));
        c.__laneHint = hints.length ? hints.reduce((a, b) => a + b, 0) / hints.length : (products.length - 1) / 2;
        for (const m of c.members) hintOf.set(m, c.__laneHint); // expose so later lines can centre over this one
      }
    };
    baryHint(sharedC);
    baryHint(utilC);
    let laneClusters = [...products, ...sharedC, ...utilC].sort((a, b) => a.__laneHint - b.__laneHint);
    // Crossing reduction: order the PRODUCT lanes (the ones still in arbitrary discovery
    // order) by the barycenter of the shared/util producers they consume, while keeping
    // those producers anchored where they were centred. Lines that draw from the same
    // sub-assembly (e.g. Bronze Rivet & Copper Bearing both off the copper/cauldron side)
    // end up adjacent, so their feed edges stop raking across unrelated lines. Greedily
    // accept the new order only if it reduces lane-level edge crossings, so it can never
    // make a layout worse than the discovery order.
    {
      const cof = cluster.clusterOf;
      const laneEdges = []; // [aLaneId, bLaneId] for cross-cluster edges
      for (const e of graph.edges) {
        const a = cof.get(e.from), b = cof.get(e.to);
        if (a != null && b != null && a !== b) laneEdges.push([a, b]);
      }
      const crossingsFor = (orderArr) => {
        const idx = new Map(orderArr.map((c, i) => [c.id, i]));
        const segs = laneEdges.map(([a, b]) => [idx.has(a) ? idx.get(a) : -1, idx.has(b) ? idx.get(b) : -1]).filter(([a, b]) => a >= 0 && b >= 0);
        let x = 0;
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
          const [a1, b1] = segs[i], [a2, b2] = segs[j];
          if ((a1 - a2) * (b1 - b2) < 0) x++; // endpoints interleave ⇒ the two feeds cross
        }
        return x;
      };
      const anchored = new Set([...sharedC, ...utilC].map((c) => c.id));
      const prodAdj = new Map(products.map((c) => [c.id, new Map()]));
      for (const e of graph.edges) {
        const a = cof.get(e.from), b = cof.get(e.to);
        for (const [p, q] of [[a, b], [b, a]]) {
          if (prodAdj.has(p) && q != null && p !== q) prodAdj.get(p).set(q, (prodAdj.get(p).get(q) || 0) + 1);
        }
      }
      let order = laneClusters;
      for (let sweep = 0; sweep < 6; sweep++) {
        const idx = new Map(order.map((c, i) => [c.id, i]));
        const bary = new Map(order.map((c) => [c.id, idx.get(c.id)]));
        for (const c of products) {
          let sw = 0, sum = 0;
          for (const [k, w] of prodAdj.get(c.id)) { sw += w; sum += w * idx.get(k); }
          if (sw > 0) bary.set(c.id, sum / sw);
        }
        const next = order.slice().sort((a, b) => (bary.get(a.id) - bary.get(b.id)) || (idx.get(a.id) - idx.get(b.id)));
        if (crossingsFor(next) < crossingsFor(order)) order = next; else break;
      }
      // Re-anchor shared/util producers to the barycenter of their consumers' FINAL
      // positions — the product reorder above moved the consumers, so a shared box (e.g.
      // the copper cauldron feeding Bronze Rivet + Copper Bearing) was left stranded at
      // its stale slot on the far right instead of tucked BETWEEN the lines it feeds.
      {
        const idx = new Map(order.map((c, i) => [c.id, i]));
        const prodPos = new Map();
        for (const c of order) if (!anchored.has(c.id)) for (const m of c.members) prodPos.set(m, idx.get(c.id));
        for (const c of order) {
          if (!anchored.has(c.id)) { c.__laneHint = idx.get(c.id); continue; }
          const mset = new Set(c.members);
          const hs = [];
          for (const e of graph.edges) if (mset.has(e.from) && !mset.has(e.to) && prodPos.has(e.to)) hs.push(prodPos.get(e.to));
          c.__laneHint = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : idx.get(c.id);
        }
        order = order.slice().sort((a, b) => a.__laneHint - b.__laneHint);
      }
      laneClusters = order;
    }
    // Convergence-aware refinement. The lane-crossing metric above can't see the fan-in
    // to a final producer: all its feeder edges share that one endpoint, so the interleave
    // test never flags them. Yet a SHALLOW feeder line whose output sweeps down to the
    // product passes straight over — and draws behind — a DEEPER sibling line's box (Mars:
    // Copper Bearing's 3-deep output crossed the Steel Gear box). Count those crossings
    // from lane order + terminal depth alone (no positions needed): feeder A's output
    // crosses line B's box when B sits between A and the product's barycentre lane AND B
    // terminates deeper than A (B's box lies in A's downward sweep). When the current order
    // has any, permute the product lanes WITHIN THEIR EXISTING SLOTS (shared/util boxes stay
    // put) for an order that removes them — tie-broken by the lane-edge crossings above. We
    // only adopt a strict convergence improvement, so already-clean graphs never move.
    {
      const cof = cluster.clusterOf;
      const demandIds = new Set(graph.nodes.filter((n) => n.type === 'demand').map((n) => n.id));
      const finalRank = new Map(); // final-producer id → its rank
      for (const e of graph.edges) if (demandIds.has(e.to) && rank.has(e.from)) finalRank.set(e.from, rank.get(e.from));
      const productIds = new Set(products.map((c) => c.id));
      const conv = []; // converging product lines: { id, rank: terminal rank, prod }
      const seenConv = new Set();
      for (const e of graph.edges) {
        if (e.heat || e.nutrient || e.cash) continue;
        const a = cof.get(e.from);
        if (a != null && productIds.has(a) && finalRank.has(e.to) && !seenConv.has(a)) {
          seenConv.add(a); conv.push({ id: a, rank: rank.get(a), prod: e.to });
        }
      }
      const termRank = new Map(products.map((c) => [c.id, rank.get(c.id)]));
      // lane-edge crossings (same interleave metric as above) for tie-breaking
      const laneEdges = [];
      for (const e of graph.edges) { const a = cof.get(e.from), b = cof.get(e.to); if (a != null && b != null && a !== b) laneEdges.push([a, b]); }
      const laneCross = (ord) => {
        const ix = new Map(ord.map((c, i) => [c.id, i]));
        const segs = laneEdges.map(([a, b]) => [ix.has(a) ? ix.get(a) : -1, ix.has(b) ? ix.get(b) : -1]).filter(([a, b]) => a >= 0 && b >= 0);
        let x = 0;
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) x++;
        return x;
      };
      const convCross = (ord) => {
        const ix = new Map(ord.map((c, i) => [c.id, i]));
        const lanesByProd = new Map();
        for (const cv of conv) { if (!lanesByProd.has(cv.prod)) lanesByProd.set(cv.prod, []); lanesByProd.get(cv.prod).push(ix.get(cv.id)); }
        const bar = new Map(); for (const [p, ls] of lanesByProd) bar.set(p, ls.reduce((a, b) => a + b, 0) / ls.length);
        let x = 0;
        for (const cv of conv) {
          const ai = ix.get(cv.id), b = bar.get(cv.prod), R = finalRank.get(cv.prod);
          for (const c2 of products) {
            if (c2.id === cv.id) continue;
            const bi = ix.get(c2.id), rB = termRank.get(c2.id);
            if (bi > Math.min(ai, b) && bi < Math.max(ai, b) && rB > cv.rank && rB < R) x++;
          }
        }
        return x;
      };
      if (conv.length > 1 && products.length <= 7 && convCross(laneClusters) > 0) {
        const slots = []; // positions in laneClusters currently holding a product
        laneClusters.forEach((c, i) => { if (products.includes(c)) slots.push(i); });
        const permute = (arr) => arr.length <= 1 ? [arr.slice()] : arr.flatMap((x, i) => permute(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x, ...p]));
        let best = laneClusters, bestKey = [convCross(laneClusters), laneCross(laneClusters)];
        for (const perm of permute(products)) {
          const cand = laneClusters.slice();
          slots.forEach((pos, j) => { cand[pos] = perm[j]; });
          const key = [convCross(cand), laneCross(cand)];
          if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = cand; bestKey = key; }
        }
        laneClusters = best;
      }
    }
    // Util (fuel/fert) lines that feed a SINGLE production line read cleanest on the OUTSIDE
    // of that line: its trunk then enters from the diagram margin instead of being wedged
    // between two production lines (the baryHint above centres util lines over their
    // consumers, which ties a single-consumer line right next to it — often on the inner
    // side). Only move it when its consumer is the OUTERMOST product on that side, so this is
    // a pure shift to the margin past a line it already abuts — it can't introduce a crossing.
    {
      const cof = cluster.clusterOf;
      const prodIds = new Set(products.map((c) => c.id));
      for (const u of utilC) {
        const mset = new Set(u.members);
        const fed = new Set();
        for (const e of graph.edges) { const b = cof.get(e.to); if (mset.has(e.from) && b != null && b !== u.id && prodIds.has(b)) fed.add(b); }
        if (fed.size !== 1) continue; // multi-consumer util stays centred (its output reaches both sides)
        const target = [...fed][0];
        const prodOrder = laneClusters.filter((c) => prodIds.has(c.id));
        const tIdx = prodOrder.findIndex((c) => c.id === target);
        const side = tIdx === prodOrder.length - 1 ? 'after' : tIdx === 0 ? 'before' : null;
        if (!side) continue; // consumer sits mid-pack → no clean outside, leave centred
        const cur = laneClusters.indexOf(u);
        if (cur < 0) continue;
        laneClusters.splice(cur, 1);
        const tPos = laneClusters.findIndex((c) => c.id === target);
        laneClusters.splice(side === 'after' ? tPos + 1 : tPos, 0, u);
      }
    }
    // Rate-weighted lateral compaction. Everything above orders lanes to minimise the COUNT
    // of edge crossings — a metric that is blind to both flow rate and terminal depth, so it
    // treats a 480/min Coke-Powder feed into a deep Athanor exactly like a 5/min trickle and
    // never sees the long heavy edge that rakes across the whole diagram. baryHint also parks
    // a multi-consumer util line at the UNWEIGHTED centroid of its consumers, even when one
    // consumer dominates the flow. Here we re-order the lanes to minimise total rate-weighted
    // horizontal edge length Σ rate·|laneA − laneB| (cash edges — the belt's money to every
    // buy node — are uniform noise and excluded). This pulls a util line beside its dominant
    // consumer and sits heavy producer/consumer pairs adjacent. Loose (unclustered) endpoints
    // — e.g. the final-assembly target that renders at its feeders' barycentre — are scored at
    // the rate-weighted mean lane of their clustered neighbours, so converging product heads
    // stay compact too. Hard-capped at the current crossing count (never trades a crossing for
    // length) and tie-broken to keep util lines near their centroid (no gratuitous mirror flip).
    // The rate-weighted length is only a PROXY — it cannot see an edge that rakes straight THROUGH
    // a line's box (curved routing + within-lane offsets defeat any lane/rank estimate), so a
    // shorter-length order can still render worse. We therefore only PROPOSE a reorder here and
    // verify it for real at the end of layout(): re-render both orders and keep the proposal only
    // if it STRICTLY reduces edges passing through boxes. __forceLaneOrder is that verify render.
    let laneCandidateIds = null;
    if (o.__forceLaneOrder) {
      const byId = new Map(laneClusters.map((c) => [c.id, c]));
      laneClusters = o.__forceLaneOrder.map((id) => byId.get(id)).filter(Boolean);
    } else if (laneClusters.length > 1 && laneClusters.length <= 8) {
      const cof = cluster.clusterOf;
      const utilIds = new Set(utilC.map((c) => c.id));
      const we = []; // {a,b: cluster id or null; from,to: node id; w: rate}
      const looseNb = new Map(); // loose node id -> [{c: cluster id, w}]
      const laneEdgesAll = [];
      for (const e of graph.edges) {
        const a = cof.get(e.from), b = cof.get(e.to);
        if (a != null && b != null && a !== b) laneEdgesAll.push([a, b]);
        if (e.cash || e.from === e.to || a === b) continue;
        // A util (fuel/fert) line's lateral position should be driven by where it DISTRIBUTES
        // its output, not by what supplies it. A heavy heat/nutrient feed INTO a util line
        // (the Fuel line's Charcoal Powder heating the Fertilizer crucibles, ~142/min) would
        // otherwise dominate this length metric and park the util box beside its supplier
        // instead of centred over its own consumers. Drop edges whose DESTINATION is a util
        // line from the weighted-length term — they still count toward the crossing cap.
        if (utilIds.has(b)) continue;
        // ...and symmetrically, a util line's OUTPUT edges (fert/fuel → the product nurseries it
        // feeds) must not drive the PRODUCT lane order. A shared util line feeding two products has
        // shorter total cross-axis length sitting BETWEEN them, so this metric used to splay the two
        // products to opposite ends with the util wedged in the middle (Bandage 1754 wide; Soap 1166)
        // and a dead bottom-centre. But a util line's real lateral position is set by the 2D
        // compaction below — it slides freely along the cross-axis regardless of its lane index — so
        // its edge lengths are meaningless here. Dropping them lets the metric be driven by product↔
        // product / product↔assembler edges, minimised when the products sit ADJACENT and the
        // compaction then nests the shared util ABOVE both (Bandage → 1069, Soap → 881). They still
        // count toward the crossing cap.
        if (utilIds.has(a)) continue;
        we.push({ a: a == null ? null : a, b: b == null ? null : b, from: e.from, to: e.to, w: e.ratePerMin || 0 });
        if (a == null && b != null) { if (!looseNb.has(e.from)) looseNb.set(e.from, []); looseNb.get(e.from).push({ c: b, w: e.ratePerMin || 0 }); }
        if (b == null && a != null) { if (!looseNb.has(e.to)) looseNb.set(e.to, []); looseNb.get(e.to).push({ c: a, w: e.ratePerMin || 0 }); }
      }
      const crossOf = (ord) => {
        const ix = new Map(ord.map((c, i) => [c.id, i]));
        const segs = laneEdgesAll.map(([a, b]) => [ix.has(a) ? ix.get(a) : -1, ix.has(b) ? ix.get(b) : -1]).filter(([a, b]) => a >= 0 && b >= 0);
        let x = 0;
        for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if ((segs[i][0] - segs[j][0]) * (segs[i][1] - segs[j][1]) < 0) x++;
        return x;
      };
      const wlenOf = (ord) => {
        const ix = new Map(ord.map((c, i) => [c.id, i]));
        const vlane = (id) => { const nb = looseNb.get(id); if (!nb) return null; let sw = 0, sm = 0; for (const { c, w } of nb) { const li = ix.get(c); if (li != null) { sw += w; sm += w * li; } } return sw > 0 ? sm / sw : null; };
        let s = 0;
        for (const e of we) {
          const la = e.a != null ? ix.get(e.a) : vlane(e.from);
          const lb = e.b != null ? ix.get(e.b) : vlane(e.to);
          if (la != null && lb != null) s += e.w * Math.abs(la - lb);
        }
        return s;
      };
      const pre = new Map(laneClusters.map((c, i) => [c.id, i]));
      const disp = (ord, ids) => { let s = 0; ord.forEach((c, i) => { if (!ids || ids.has(c.id)) s += Math.abs(i - pre.get(c.id)); }); return s; };
      const permute = (arr) => arr.length <= 1 ? [arr.slice()] : arr.flatMap((x, i) => permute(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x, ...p]));
      const cap = crossOf(laneClusters); // never exceed the crossing count the passes above achieved
      let best = laneClusters, bestKey = [wlenOf(laneClusters), 0, 0];
      for (const perm of permute(laneClusters)) {
        if (crossOf(perm) > cap) continue;
        const key = [wlenOf(perm), disp(perm, utilIds), disp(perm, null)];
        if (key[0] < bestKey[0] - 1e-6 ||
            (Math.abs(key[0] - bestKey[0]) <= 1e-6 && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          best = perm; bestKey = key;
        }
      }
      if (best !== laneClusters) laneCandidateIds = best.map((c) => c.id); // propose; the verify step adopts it
    }
    const laneOf = new Map();
    laneClusters.forEach((c, i) => { c.lane = i; for (const m of c.members) laneOf.set(m, i); });
    const numLanes = laneClusters.length;
    const lane = (id) => (laneOf.has(id) ? laneOf.get(id) : numLanes); // unclustered after clusters

    // Main-belt supply nodes are pulled out of the per-lane layout and rendered as
    // one shared band spanning every line (they feed many lines, so pinning one to
    // a single line's lane is misleading).
    const beltNodes = graph.nodes.filter(isBelt);
    const beltSet = new Set(beltNodes.map((n) => n.id));

    // columns (belt + utility bands excluded — positioned separately)
    const cols = [];
    for (const n of graph.nodes) {
      if (beltSet.has(n.id) || utilSet.has(n.id)) continue;
      const r = rank.get(n.id);
      (cols[r] || (cols[r] = [])).push(n);
    }
    // initial within-column order: by cluster lane, then busiest first
    for (const c of cols) if (c) c.sort((a, b) => lane(a.id) - lane(b.id) || (a.type === 'resource') - (b.type === 'resource') || (b.ratePerMin || 0) - (a.ratePerMin || 0));

    // barycenter crossing reduction (forward, non-back edges)
    const up = new Map();
    const down = new Map();
    for (const n of graph.nodes) { up.set(n.id, []); down.set(n.id, []); }
    for (const e of graph.edges) {
      if (e.from === e.to || back.has(e.from + '\t' + e.to)) continue;
      if (beltSet.has(e.from) || beltSet.has(e.to) || utilSet.has(e.from) || utilSet.has(e.to)) continue; // belt/utility routed separately
      if (rank.get(e.to) > rank.get(e.from)) { down.get(e.from).push(e.to); up.get(e.to).push(e.from); }
    }
    const idx = new Map();
    const reindex = () => { for (const c of cols) if (c) c.forEach((n, i) => idx.set(n.id, i)); };
    reindex();
    const bary = (n, neigh) => {
      const ns = neigh.get(n.id);
      if (!ns.length) return idx.get(n.id);
      let s = 0;
      for (const m of ns) s += idx.get(m);
      return s / ns.length;
    };
    // barycenter sorts keep cluster lanes contiguous (lane is the primary key)
    for (let pass = 0; pass < 8; pass++) {
      for (let r = 1; r < cols.length; r++) {
        if (!cols[r]) continue;
        const b = new Map(cols[r].map((n) => [n.id, bary(n, up)]));
        cols[r].sort((a, c) => lane(a.id) - lane(c.id) || b.get(a.id) - b.get(c.id));
        reindex();
      }
      for (let r = cols.length - 2; r >= 0; r--) {
        if (!cols[r]) continue;
        const b = new Map(cols[r].map((n) => [n.id, bary(n, down)]));
        cols[r].sort((a, c) => lane(a.id) - lane(c.id) || b.get(a.id) - b.get(c.id));
        reindex();
      }
    }

    // positions — center each column on a common axis. Spacing is orientation-
    // aware: the cross axis must clear the node's extent along that axis (width
    // when columns stack horizontally in TB, height when they stack vertically
    // in LR) or same-column nodes overlap.
    const flowStep = (orientation === 'TB' ? NODE_H : NODE_W) + GAP_FLOW;
    const crossStep = (orientation === 'TB' ? NODE_W : NODE_H) + GAP_CROSS;
    // Each cluster lane gets a fixed cross-axis BAND (plus one band for unclustered
    // nodes), so a line's nodes share an x-strip across all columns and its
    // bounding box can't overlap a neighbour's. Band width = the most nodes that
    // lane ever holds in a single column.
    const LANE_GAP = 46;
    const laneCount = numLanes + 1; // +1 = unclustered band

    // 2D per-line placement (tidy-tree / subtree-width). Compaction heuristics
    // (barycenter, isotonic) MINIMISE edge length, so they collapse a fan-out hub
    // flush-left. The user wants the opposite: a node feeding several branches sits
    // CENTRED OVER them with their subtrees SPREAD apart (image 31 — Chamomile
    // top-centre, empty cell to its left, Powder down-left). That's a Reingold-
    // Tilford tidy tree: pick one primary parent per node (→ a spanning forest),
    // give every node a horizontal interval = the sum of its children's widths
    // (leaf = 1), pack children left→right in that interval, then centre each
    // parent over its children's span. Disjoint intervals ⇒ no node overlap; the
    // remaining (non-primary) edges just draw over the top.
    const slotOf = new Map();
    // Only real production-line clusters get the tidy-tree spread (their fan-out is
    // what the user wants centred). The trailing unclustered band (l === numLanes)
    // is a grab-bag of unrelated nodes — spreading it just scatters them, so it
    // falls through to flush packing (slotOf unset → seenInLane++ below).
    for (let l = 0; l < numLanes; l++) {
      const members = [];
      for (let r = 0; r < cols.length; r++) if (cols[r]) for (const n of cols[r]) if (lane(n.id) === l) members.push(n.id);
      if (!members.length) continue;
      const mset = new Set(members);
      // column index within each rank (preserves the crossing-min order for tie-breaks)
      const colIdx = new Map();
      for (let r = 0; r < cols.length; r++) if (cols[r]) { let i = 0; for (const n of cols[r]) if (lane(n.id) === l) colIdx.set(n.id, i++); }
      // primary parent: among a node's in-lane parents, prefer the IMMEDIATE ones
      // (exactly one rank up), then the HUB (highest out-degree — the node fanning
      // out the most owns the branch), then highest flow on that edge, then closest
      // column. This roots a fan-out's children under the hub so they spread beneath
      // it, instead of stealing one to a side-feeder (which yields parallel columns).
      const outdeg = new Map(members.map((m) => [m, (down.get(m) || []).filter((x) => mset.has(x)).length]));
      const flowW = new Map();
      for (const e of graph.edges) flowW.set(e.from + '\t' + e.to, e.value ?? e.rate ?? e.amount ?? e.ratePerMin ?? 0);
      const lt = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; };
      const parent = new Map();
      const childrenOf = new Map(members.map((m) => [m, []]));
      for (const id of members) {
        let ups = (up.get(id) || []).filter((m) => mset.has(m));
        if (!ups.length) { parent.set(id, null); continue; }
        const immediate = ups.filter((p) => rank.get(p) === rank.get(id) - 1);
        if (immediate.length) ups = immediate;
        let best = null, bestKey = null;
        for (const p of ups) {
          const key = [-outdeg.get(p), -(flowW.get(p + '\t' + id) || 0), Math.abs((colIdx.get(p) ?? 0) - (colIdx.get(id) ?? 0))];
          if (!best || lt(key, bestKey)) { best = p; bestKey = key; }
        }
        parent.set(id, best);
      }
      for (const id of members) { const p = parent.get(id); if (p) childrenOf.get(p).push(id); }
      // Which way does this lane's real output leave? Average the lane index of every
      // cross-lane consumer its members feed. If they sit to the right (exitDir ≥ 0), the
      // output-bearing children belong on the RIGHT (nearest their consumer), so a dead-end
      // disposal sink (a trashed co-product like Salt's Sand → trash) must tuck to the LEFT —
      // and vice-versa. Without this the stub can land between a real output and its consumer,
      // raking the output edge clear across the tile.
      let exitSum = 0, exitN = 0;
      for (const id of members) for (const m of (down.get(id) || [])) { const lm = lane(m); if (lm !== l) { exitSum += lm; exitN++; } }
      const sinksGoLeft = exitN ? (exitSum / exitN - l) >= 0 : true;
      const isSinkId = (id) => { const t = (nodeById2(id) || {}).type; return t === 'surplus' || t === 'trash'; };
      for (const arr of childrenOf.values()) arr.sort((a, b) => {
        const sa = isSinkId(a) ? 1 : 0, sb = isSinkId(b) ? 1 : 0;
        if (sa !== sb) return sinksGoLeft ? (sb - sa) : (sa - sb); // push sinks to the exit-opposite end
        return (colIdx.get(a) ?? 0) - (colIdx.get(b) ?? 0);
      });
      const roots = members.filter((m) => !parent.get(m));
      roots.sort((a, b) => rank.get(a) - rank.get(b) || (colIdx.get(a) ?? 0) - (colIdx.get(b) ?? 0));
      // post-order so a node's children are sized before it (iterative — chains can be deep)
      const postorder = (root) => {
        const stack = [[root, false]], order = [];
        while (stack.length) {
          const [n, done] = stack.pop();
          if (done) { order.push(n); continue; }
          stack.push([n, true]);
          for (const c of childrenOf.get(n)) stack.push([c, false]);
        }
        return order;
      };
      const width = new Map();
      let cursor = 0;
      for (const root of roots) {
        for (const n of postorder(root)) {
          const ch = childrenOf.get(n);
          width.set(n, ch.length ? ch.reduce((s, c) => s + width.get(c), 0) : 1);
        }
        // assign x top-down: each child consumes its width; parent centres on its span
        const place = (n, left) => {
          const ch = childrenOf.get(n);
          if (!ch.length) { slotOf.set(n, left + 0.5); return; }
          let cx = left;
          for (const c of ch) { place(c, cx); cx += width.get(c); }
          slotOf.set(n, (slotOf.get(ch[0]) + slotOf.get(ch[ch.length - 1])) / 2);
        };
        place(root, cursor);
        cursor += width.get(root);
      }
      // Centre fan-IN chains. The tidy-tree pins a node under its single PRIMARY
      // parent, so a cauldron consuming 3 inputs hangs under just one of them (left-
      // pinned). Slide every node that is ALONE in its row to the barycentre of the
      // inputs it actually consumes — top-down so each lands under its (already-moved)
      // parents. Solo rows can't collide (nothing beside them), and multi-node rows
      // keep the tidy-tree's fan-OUT spread untouched.
      const rowCount = new Map();
      for (const id of members) rowCount.set(rank.get(id), (rowCount.get(rank.get(id)) || 0) + 1);
      const ranksAsc = [...new Set(members.map((m) => rank.get(m)))].sort((a, b) => a - b);
      for (const r of ranksAsc) {
        for (const id of members) {
          if (rank.get(id) !== r || rowCount.get(r) !== 1) continue;
          const ps = (up.get(id) || []).filter((m) => mset.has(m));
          if (ps.length) slotOf.set(id, ps.reduce((s, m) => s + slotOf.get(m), 0) / ps.length);
        }
      }
    }

    // Pack lanes by their ACTUAL slot extent, not a zero-based slot grid. The tidy-tree centres
    // leaves at slot k+0.5, so a lane's leftmost node started half a crossStep in, and a lone
    // node rounded up to two columns — together those left a dead ~crossStep band between every
    // tile. Instead: resolve every node's slot (its tidy-tree value, or the packed integer
    // fallback used for unclustered nodes), take each lane's [min,max] slot, and start lane l
    // immediately after lane l-1's real pixel width + LANE_GAP. Node x is then measured from its
    // own lane's leftmost slot — no left lead, no right over-reserve, so gaps == LANE_GAP.
    const slotResolved = new Map();
    for (const c of cols) {
      if (!c) continue;
      const seen = new Array(laneCount).fill(0);
      for (const n of c) slotResolved.set(n.id, slotOf.has(n.id) ? slotOf.get(n.id) : seen[lane(n.id)]++);
    }
    const laneMin = new Array(laneCount).fill(Infinity);
    const laneMax = new Array(laneCount).fill(-Infinity);
    for (const [id, s] of slotResolved) {
      const l = lane(id);
      if (s < laneMin[l]) laneMin[l] = s;
      if (s > laneMax[l]) laneMax[l] = s;
    }
    const laneStart = new Array(laneCount).fill(0);
    for (let l = 1; l < laneCount; l++) {
      const empty = laneMax[l - 1] === -Infinity;
      const spanPx = empty ? 0 : (laneMax[l - 1] - laneMin[l - 1]) * crossStep + NODE_W;
      laneStart[l] = laneStart[l - 1] + spanPx + (empty ? 0 : LANE_GAP);
    }
    // reserve header rows at the start: the belt band, then one row per utility
    // (fuel/fertilizer) band, so the product lines begin below them and their
    // Nurseries sit directly under the utility bands that feed them.
    const beltBand = beltNodes.length ? flowStep : 0;
    const headerOffset = beltBand + utilLines.length * flowStep;
    // The util (fuel/fert) lines are pinned to the top (sub-rank remap). Drop the
    // product/shared spine DOWN past them, so the fuel/fert OUTPUT runs vertically into
    // its consumers rather than straight across the canvas. Taller, but far easier to
    // follow — the util box sits above the lines it feeds.
    const utilNodeSet = new Set();
    let utilSpan = 0;
    for (const c of cluster.clusters.filter(isUtil)) for (const m of c.members) { utilNodeSet.add(m); utilSpan = Math.max(utilSpan, rank.get(m) || 0); }
    const spineDrop = utilNodeSet.size ? utilSpan + 2 : 0;
    // The extra-row drop below only earns its keep when SEVERAL producers converge on the
    // target (they need vertical room to fan in). With a single producer — the usual case,
    // one root tile → target — it just opens a dead gap, so size the drop to the fan-in.
    const demandFanIn = new Map();
    for (const e of graph.edges) {
      if (e.heat || e.nutrient || e.cash || e.from === e.to) continue;
      if ((nodeMap.get(e.to) || {}).type === 'demand') demandFanIn.set(e.to, (demandFanIn.get(e.to) || 0) + 1);
    }
    let didCompact = false; // set by the 2D compaction pass below (after positions are known)
    const pos = new Map();
    cols.forEach((c, r) => {
      if (!c) return;
      for (const n of c) {
        const l = lane(n.id);
        // slot resolved above (tidy-tree barycentre, or packed fallback); measured from the
        // lane's own leftmost slot so each tile sits flush against its neighbour.
        // Drop the final target an extra row below its producers ONLY when >1 line fans into
        // it; a single-producer target sits at normal row spacing (no dead gap).
        const demandDrop = (n.type === 'demand' && (demandFanIn.get(n.id) || 0) > 1) ? flowStep : 0;
        const flow = (r + (utilNodeSet.has(n.id) ? 0 : spineDrop)) * flowStep + headerOffset + demandDrop;
        const cross = laneStart[l] + (slotResolved.get(n.id) - laneMin[l]) * crossStep;
        if (orientation === 'TB') pos.set(n.id, { x: cross, y: flow, w: NODE_W, h: NODE_H });
        else pos.set(n.id, { x: flow, y: cross, w: NODE_W, h: NODE_H });
      }
    });

    // 2D COMPACTION (vertical nesting). A util (fuel/fert) line is pinned to the top, with the
    // product/shared spine dropped `spineDrop` (≥2) rows below it, so a util line never overlaps
    // a product line in flow — it can slide along the cross-axis to share a product's band,
    // reclaiming the dead space a narrow, deep product line leaves above it (the lone target
    // whose Fertilizer line floated off to the side with the first column empty). Slide each
    // util line toward the rate-weighted centre of the consumers it FEEDS — measured from the
    // FINAL positions, so an unclustered consumer (e.g. the target's own producer) is read where
    // it actually renders, not at a stale lane estimate. LEFT-only (never widens) and skylined
    // past any earlier-placed util line it overlaps in flow, processed left-to-right so the
    // skyline can only restore toward the original packing, never past it. It only PROPOSES the
    // move: the verify at the end re-renders flat and keeps it only if it didn't drag more flow
    // across boxes — a column that looks empty can still carry a long belt/money edge down to a
    // deep purchase, and dropping a util box onto that edge is the overlap we must reject.
    if (!o.__noCompact) {
      const caxis = orientation === 'TB' ? 'x' : 'y', faxis = orientation === 'TB' ? 'y' : 'x';
      const cdim = orientation === 'TB' ? NODE_W : NODE_H, fdim = orientation === 'TB' ? NODE_H : NODE_W;
      const utilCs = cluster.clusters.filter(isUtil).map((c) => {
        const mem = (c.members || []).filter((m) => pos.get(m));
        if (!mem.length) return null;
        const ps = mem.map((m) => pos.get(m));
        return { id: c.id, mem, cMin: Math.min(...ps.map((p) => p[caxis])), cMax: Math.max(...ps.map((p) => p[caxis])),
          fMin: Math.min(...ps.map((p) => p[faxis])), fMax: Math.max(...ps.map((p) => p[faxis] + fdim)) };
      }).filter(Boolean).sort((a, b) => a.cMin - b.cMin);
      const memberOf = new Map();
      for (const u of utilCs) for (const m of u.mem) memberOf.set(m, u.id);
      const placed = [];
      for (const u of utilCs) {
        const width = u.cMax - u.cMin + cdim;
        let sw = 0, sc = 0; // rate-weighted centre of the consumers this line feeds
        for (const e of graph.edges) {
          if (e.cash || e.from === e.to || memberOf.get(e.from) !== u.id) continue;
          if (memberOf.get(e.to) === u.id) continue;
          const pt = pos.get(e.to); if (!pt) continue;
          const w = e.ratePerMin || 0; sw += w; sc += w * (pt[caxis] + cdim / 2);
        }
        let left = sw > 0 ? Math.min(u.cMin, Math.max(0, sc / sw - width / 2)) : u.cMin; // left-only
        for (const p of placed) { // clear any earlier-placed util line we overlap in flow
          if (!(u.fMax < p.fMin || p.fMax < u.fMin) && left < p.left + p.width + LANE_GAP && left + width > p.left) {
            left = Math.max(left, p.left + p.width + LANE_GAP);
          }
        }
        const delta = left - u.cMin;
        if (Math.abs(delta) > 1e-6) { didCompact = true; for (const m of u.mem) pos.get(m)[caxis] += delta; }
        placed.push({ left, width, fMin: u.fMin, fMax: u.fMax });
      }
    }

    // utility bands: lay each fuel/fertilizer line as a horizontal strip (in TB) /
    // vertical strip (in LR) just under the belt, members ordered by their internal
    // sub-rank so the line's output ends nearest the product Nurseries below it.
    utilLines.forEach((c, i) => {
      const mset = new Set(c.members);
      const indeg = new Map(c.members.map((m) => [m, 0]));
      const adj = new Map(c.members.map((m) => [m, []]));
      for (const e of graph.edges) {
        if (mset.has(e.from) && mset.has(e.to) && e.from !== e.to && !back.has(e.from + '\t' + e.to)) {
          adj.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1);
        }
      }
      const sr = new Map(c.members.map((m) => [m, 0]));
      const q = c.members.filter((m) => indeg.get(m) === 0);
      for (let k = 0; k < q.length; k++) for (const v of adj.get(q[k])) { if (sr.get(v) < sr.get(q[k]) + 1) sr.set(v, sr.get(q[k]) + 1); indeg.set(v, indeg.get(v) - 1); if (indeg.get(v) === 0) q.push(v); }
      const ordered = [...c.members].sort((a, b) => sr.get(a) - sr.get(b) || ((nodeById2(a).ratePerMin) || 0) - ((nodeById2(b).ratePerMin) || 0));
      const flow = beltBand + i * flowStep;
      ordered.forEach((m, j) => {
        const cross = j * crossStep;
        if (orientation === 'TB') pos.set(m, { x: cross, y: flow, w: NODE_W, h: NODE_H });
        else pos.set(m, { x: flow, y: cross, w: NODE_W, h: NODE_H });
      });
    });

    // belt band: lay the supply nodes across the full cross-extent of the lines, at
    // flow 0 (top in TB / left in LR). Each belt node gravitates to the cross-centre
    // of the consumers it feeds, then they're spread left-to-right to not overlap.
    if (beltNodes.length) {
      const crossOf = (p) => (orientation === 'TB' ? p.x + NODE_W / 2 : p.y + NODE_H / 2);
      let crossExtent = beltNodes.length * crossStep;
      for (const p of pos.values()) crossExtent = Math.max(crossExtent, (orientation === 'TB' ? p.x + NODE_W : p.y + NODE_H));
      const prefer = (b) => {
        const cs = graph.edges.filter((e) => e.from === b.id).map((e) => pos.get(e.to)).filter(Boolean);
        if (!cs.length) return crossExtent / 2;
        let s = 0; for (const p of cs) s += crossOf(p);
        return s / cs.length;
      };
      const ordered = beltNodes.map((b) => ({ b, c: prefer(b) })).sort((a, z) => a.c - z.c);
      let cursor = 0;
      for (const { b, c } of ordered) {
        let cc = Math.max(cursor, c - NODE_W / 2);
        cc = Math.min(cc, Math.max(cursor, crossExtent - NODE_W));
        if (orientation === 'TB') pos.set(b.id, { x: cc, y: 0, w: NODE_W, h: NODE_H });
        else pos.set(b.id, { x: 0, y: cc, w: NODE_W, h: NODE_H });
        cursor = cc + crossStep;
      }
    }

    // Centre the OUTPUT, symmetric to the belt at the start. The final producer and
    // the demand sit at the deepest flow rows; as unclustered nodes they'd drift to
    // the far lane (the target stranded in a corner). When a node is alone in its
    // flow row, pull it to the cross-centre of what feeds it, so the target reads as
    // the natural end of the main line.
    {
      const crossCtr = (p) => (orientation === 'TB' ? p.x + NODE_W / 2 : p.y + NODE_H / 2);
      const demandIds = new Set(graph.nodes.filter((n) => n.type === 'demand').map((n) => n.id));
      const finalProducers = new Set();
      for (const e of graph.edges) if (demandIds.has(e.to) && !beltSet.has(e.from)) finalProducers.add(e.from);
      // shallowest first: centre the final producer (on its product inputs) before
      // the demand centres on the producer.
      const toCenter = [...new Set([...demandIds, ...finalProducers])].sort((a, b) => rank.get(a) - rank.get(b));
      const span = orientation === 'TB' ? NODE_W : NODE_H;
      const lead = (p) => (orientation === 'TB' ? p.x : p.y);
      for (const id of toCenter) {
        const p = pos.get(id);
        if (!p) continue;
        const ins = graph.edges.filter((e) => e.to === id && pos.get(e.from)).map((e) => pos.get(e.from));
        if (!ins.length) continue;
        const c = ins.reduce((s, q) => s + crossCtr(q), 0) / ins.length;
        const newLead = c - span / 2;
        // Centre on the inputs even when the row is shared — only skip if the centred position
        // would actually COLLIDE with a same-row neighbour. "Same row" = same FLOW position, NOT
        // same rank: spineDrop drops the product/demand spine rows below the top-pinned util
        // boxes, so a util line's output node and a deep demand can share a rank yet sit in
        // completely different flow rows. Comparing rank stranded the target whenever a util
        // line's output happened to land at its rank (Linen Rope: the demand collided with
        // Basic Fertilizer#fert sitting two screens above it). Compare actual flow instead.
        const myFlow = orientation === 'TB' ? p.y : p.x;
        let collides = false;
        for (const oid of pos.keys()) {
          if (oid === id) continue;
          const op = pos.get(oid);
          if (Math.abs((orientation === 'TB' ? op.y : op.x) - myFlow) > 1) continue;
          const ol = lead(op);
          if (newLead < ol + span + GAP_CROSS && ol < newLead + span + GAP_CROSS) { collides = true; break; }
        }
        if (collides) continue;
        if (orientation === 'TB') p.x = newLead; else p.y = newLead;
      }
    }

    // Multi-target: pack the demand (target) row as a contiguous group ordered by each
    // target's PRODUCER cross-position, so every target sits beside its own feeder. With a
    // single demand the centre-output pass above already pulls it under its producer; with
    // ≥2 demands that pass centres each independently and BAILS on collision — so the first
    // target claims the centre and the rest are stranded at their flush-packed slots in the
    // far unclustered band, each raking a long output edge clear across the diagram back to
    // a producer on the opposite side. Instead, order the targets by where their feeders sit
    // and sweep them left-to-right, each as close to its feeder as the previous one allows.
    {
      const crossCtr = (p) => (orientation === 'TB' ? p.x + NODE_W / 2 : p.y + NODE_H / 2);
      const span = orientation === 'TB' ? NODE_W : NODE_H;
      const rowsByRank = new Map(); // demand rank -> [{ id, want }]
      for (const n of graph.nodes) {
        if (n.type !== 'demand' || !pos.get(n.id)) continue;
        const ins = graph.edges.filter((e) => e.to === n.id && pos.get(e.from)).map((e) => pos.get(e.from));
        const want = ins.length ? ins.reduce((s, q) => s + crossCtr(q), 0) / ins.length : crossCtr(pos.get(n.id));
        const r = rank.get(n.id);
        if (!rowsByRank.has(r)) rowsByRank.set(r, []);
        rowsByRank.get(r).push({ id: n.id, want });
      }
      for (const group of rowsByRank.values()) {
        if (group.length < 2) continue; // single target: the centre-output pass already placed it
        group.sort((a, b) => a.want - b.want);
        let lead = -Infinity;
        for (const g of group) {
          const wantLead = g.want - span / 2; // desired top-left so the box centres on its feeders
          lead = lead === -Infinity ? wantLead : Math.max(wantLead, lead + crossStep);
          const p = pos.get(g.id);
          if (orientation === 'TB') p.x = lead; else p.y = lead;
        }
      }
    }

    // edge anchor points (border to border). Multiple edges sharing a node face are
    // SPREAD across it (fanned), ordered by the other endpoint's cross position, so a
    // node's several inputs/outputs don't all stack on its centre — a cauldron pulling
    // Chamomile + Powder + Linen now shows three distinct fan-in points.
    //
    // Only edges actually RENDERED as a border-to-border arrow get a fan slot. Fuel/fert/
    // cash edges are drawn as the per-machine BANDS (utilEdges 'off') or aggregated TRUNKS
    // ('trunk', the default) — NOT as face arrows — so counting them here reserved a phantom
    // slot that shoved the real material arrow off-centre. They only draw as face arrows in
    // 'all' mode; elsewhere they're excluded from the fan (their start/end fall back to the
    // face centre, unused). A non-faced edge still gets start/end computed for any mode that
    // does draw it (a non-trunked util edge in 'trunk' mode) — just at centre, not fanned.
    const utilMode = o.utilEdges || 'trunk';
    // A util (fuel/fert/cash) edge draws as a face ARROW only when it ISN'T absorbed into a
    // trunk: mode 'all', or — in 'trunk' mode — an intra-line / unboxed-destination edge the
    // trunking leaves individual (see the trunk predicate below). Those must claim a fan slot
    // like any material edge; otherwise a line's own fuel feedback (the Grinder's Coke Powder
    // routed back up to the Crucible it heats) lands dead-centre on the SAME face as the
    // material edge and the two arrows stack. Mirror the trunk predicate here from the same
    // cluster membership (computed before the box loop, so we can't read boxKeyOf/boxByKey yet).
    const boxKeyOfFan = new Map();
    for (const c of laneClusters) {
      if (c.subClusters) for (const s of c.subClusters) for (const m of s.members) boxKeyOfFan.set(m, s.id);
      else for (const m of c.members) boxKeyOfFan.set(m, c.id);
    }
    for (const c of utilLines) for (const m of c.members) boxKeyOfFan.set(m, c.id);
    const boxedKeysFan = new Set(); // cluster keys that will actually get a box (≥2 positioned members)
    {
      const cnt = new Map();
      for (const [m, key] of boxKeyOfFan) if (pos.get(m)) cnt.set(key, (cnt.get(key) || 0) + 1);
      for (const [key, n] of cnt) if (n >= 2) boxedKeysFan.add(key);
    }
    const isTrunkedUtil = (e) => { const key = boxKeyOfFan.get(e.to); return key != null && boxedKeysFan.has(key) && boxKeyOfFan.get(e.from) !== key; };
    const facedAsArrow = (e) => {
      if (!(e.heat || e.nutrient || e.cash)) return true; // material: always a face arrow
      if (utilMode === 'off') return false;               // util drawn as bands only
      if (utilMode === 'all') return true;                // all util drawn as arrows
      return !isTrunkedUtil(e);                            // trunk mode: faced iff not trunked
    };
    const crossC = (p) => (orientation === 'TB' ? p.x + NODE_W / 2 : p.y + NODE_H / 2);
    const sides = (a, b) => {
      if (orientation === 'TB') { const fwd = b.y >= a.y; return [fwd ? 'B' : 'T', fwd ? 'T' : 'B']; }
      const fwd = b.x >= a.x; return [fwd ? 'R' : 'L', fwd ? 'L' : 'R'];
    };
    const ekey = (e) => e.from + '\t' + e.to;
    const faceEdges = new Map(); // 'nodeId|side' → [{ key, sortVal }]
    const addFace = (nodeId, side, key, sortVal) => {
      const k = nodeId + '|' + side;
      if (!faceEdges.has(k)) faceEdges.set(k, []);
      faceEdges.get(k).push({ key, sortVal });
    };
    const renderable = [];
    for (const e of graph.edges) {
      const a = pos.get(e.from); const b = pos.get(e.to);
      if (!a || !b) continue;
      const [srcSide, dstSide] = sides(a, b);
      renderable.push({ e, a, b, srcSide, dstSide });
      if (!facedAsArrow(e)) continue; // util edge drawn as band/trunk → no fan slot
      addFace(e.from, srcSide, ekey(e), crossC(b));
      addFace(e.to, dstSide, ekey(e), crossC(a));
    }
    const frac = new Map(); // 'nodeId|side|edgeKey' → [0..1] position along the face
    for (const [k, arr] of faceEdges) {
      arr.sort((x, y) => x.sortVal - y.sortVal);
      arr.forEach((it, i) => frac.set(k + '|' + it.key, Math.min(0.85, Math.max(0.15, (i + 1) / (arr.length + 1)))));
    }
    const anchor = (p, side, f) => {
      if (side === 'B') return { x: p.x + f * NODE_W, y: p.y + NODE_H };
      if (side === 'T') return { x: p.x + f * NODE_W, y: p.y };
      if (side === 'R') return { x: p.x + NODE_W, y: p.y + f * NODE_H };
      return { x: p.x, y: p.y + f * NODE_H }; // 'L'
    };
    const edges = new Map();
    for (const { e, a, b, srcSide, dstSide } of renderable) {
      const start = anchor(a, srcSide, frac.get(e.from + '|' + srcSide + '|' + ekey(e)) ?? 0.5);
      const end = anchor(b, dstSide, frac.get(e.to + '|' + dstSide + '|' + ekey(e)) ?? 0.5);
      edges.set(ekey(e), { start, end });
    }

    // cluster bounding boxes (only for lines with ≥2 nodes — single-node lines
    // aren't worth a container) with a little padding for the label
    const PAD = 12;
    const clusterBoxes = [];
    const boxOf = (members, extra) => {
      const ps = members.map((id) => pos.get(id)).filter(Boolean);
      if (ps.length < 2) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of ps) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
      // Tiled lines get a taller header: line 1 = name, line 2 = tile count + per-tile
      // output, line 3 = the cell list (on its own line). outItem/outRate come from
      // assignClusters; the header shows the per-tile output capacity.
      const headH = extra && extra.tile ? 46 : 14;
      // members ride along so the renderer can map a node → its box (hover un-fades the
      // box(es) that hold a highlighted node, so a line's wrapper/header doesn't dim while
      // its own tile is in focus).
      clusterBoxes.push({ x: x0 - PAD, y: y0 - PAD - headH, w: (x1 - x0) + 2 * PAD, h: (y1 - y0) + 2 * PAD + headH, headH, members, ...extra });
    };
    // A nest-merged cluster draws a box per ORIGINAL sub-line (so each stays a labelled,
    // tileable unit) rather than one box around the whole merged stack.
    for (const c of laneClusters) {
      if (c.subClusters) for (const s of c.subClusters) boxOf(s.members, { label: s.label, key: s.id, tile: s.tile, outItem: s.outItem, outRate: s.outRate });
      else boxOf(c.members, { label: c.label, key: c.id, tile: c.tile, outItem: c.outItem, outRate: c.outRate });
    }
    for (const c of utilLines) boxOf(c.members, { label: c.label, util: true, key: c.id, tile: c.tile, outItem: c.outItem, outRate: c.outRate });
    // the spanning belt band — full cross-extent of the lines, one node deep
    if (beltNodes.length) {
      let crossExtent = 0;
      for (const p of pos.values()) crossExtent = Math.max(crossExtent, (orientation === 'TB' ? p.x + NODE_W : p.y + NODE_H));
      const beltMembers = beltNodes.map((n) => n.id);
      if (orientation === 'TB') clusterBoxes.push({ label: 'Main belt', belt: true, members: beltMembers, x: -PAD, y: -PAD - 14, w: crossExtent + 2 * PAD, h: NODE_H + 2 * PAD + 14 });
      else clusterBoxes.push({ label: 'Main belt', belt: true, members: beltMembers, x: -PAD, y: -PAD - 14, w: NODE_W + 2 * PAD, h: crossExtent + 2 * PAD + 14 });
    }

    // Trunk routing for fuel/fertilizer distribution: instead of one edge from a
    // source (the belt / a fuel-or-fert recipe) to EACH consuming machine, draw one
    // aggregated edge from the source to the consuming LINE's box boundary. Collapses
    // the fan-out spaghetti into a few labelled trunks. The per-machine bands still
    // show each machine's exact draw. Edges to unboxed/own-line consumers stay
    // individual (tracked in trunkedEdges so the renderer doesn't double-draw).
    const boxByKey = new Map();
    for (const b of clusterBoxes) if (b.key != null) boxByKey.set(b.key, b);
    // member → the key of the box it's actually RENDERED in. For a nest-merged cluster
    // that's the SUB-line box, not the merged cluster — otherwise fuel/fert trunking
    // (which routes to a box by key) finds no box for the merged id and falls back to
    // one spaghetti edge per machine inside the nested stack.
    const boxKeyOf = new Map();
    for (const c of laneClusters) {
      if (c.subClusters) for (const s of c.subClusters) for (const m of s.members) boxKeyOf.set(m, s.id);
      else for (const m of c.members) boxKeyOf.set(m, c.id);
    }
    for (const c of utilLines) for (const m of c.members) boxKeyOf.set(m, c.id);
    // Port on a rect facing point `s`: pick the side that faces `s`, then slide along
    // it toward s — but clamp to [30%, 70%] of the edge so a trunk never lands on a
    // corner (it reads as a clean drop into the box face, not the tip).
    const along = (v, lo, len) => lo + Math.min(Math.max((v - lo) / (len || 1), 0.3), 0.7) * len;
    const boxPort = (s, r) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const nx = Math.abs(s.x - cx) / (r.w / 2 || 1);
      const ny = Math.abs(s.y - cy) / (r.h / 2 || 1);
      if (ny >= nx) return { x: along(s.x, r.x, r.w), y: s.y < cy ? r.y : r.y + r.h };
      return { x: s.x < cx ? r.x : r.x + r.w, y: along(s.y, r.y, r.h) };
    };
    // A trunk enters the destination box on its FLOW-axis face (top/bottom in TB,
    // left/right in LR) whenever the source sits outside the box on that axis — so
    // fuel/fert dropping from the belt above lands on the top, not a side corner.
    const trunkPort = (s, box) => {
      if (orientation === 'TB') {
        if (s.y < box.y) return { x: along(s.x, box.x, box.w), y: box.y };
        if (s.y > box.y + box.h) return { x: along(s.x, box.x, box.w), y: box.y + box.h };
      } else {
        if (s.x < box.x) return { x: box.x, y: along(s.y, box.y, box.h) };
        if (s.x > box.x + box.w) return { x: box.x + box.w, y: along(s.y, box.y, box.h) };
      }
      return boxPort(s, box);
    };
    const trunkMap = new Map();
    const trunkedEdges = new Set();
    for (const e of graph.edges) {
      if (!(e.heat || e.nutrient || e.cash)) continue; // fuel/fert AND belt-coin (cash) trunk the same way
      const key = boxKeyOf.get(e.to);
      if (key == null || !boxByKey.has(key) || boxKeyOf.get(e.from) === key) continue;
      trunkedEdges.add(e.from + '\t' + e.to);
      const kind = e.heat ? 'fuel' : e.nutrient ? 'fert' : 'cash';
      const k = e.from + '|' + key + '|' + kind;
      let t = trunkMap.get(k);
      if (!t) { t = { from: e.from, toKey: key, heat: !!e.heat, nutrient: !!e.nutrient, cash: !!e.cash, item: e.item, ratePerMin: 0, tos: [] }; trunkMap.set(k, t); }
      t.ratePerMin += e.ratePerMin;
      t.tos.push(e.to);
    }
    const trunks = [];
    for (const t of trunkMap.values()) {
      const a = pos.get(t.from); const box = boxByKey.get(t.toKey);
      if (!a || !box) continue;
      const sRect = { x: a.x, y: a.y, w: NODE_W, h: NODE_H };
      const start = boxPort({ x: box.x + box.w / 2, y: box.y + box.h / 2 }, sRect);
      const end = trunkPort({ x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 }, box);
      trunks.push({ ...t, start, end });
    }

    // Self-feed feedback edges — a self-fuel / self-fert line's carrier OUTPUT looping back to its
    // OWN furnaces / nurseries. These are intra-line support edges, so trunking skips them (above);
    // normally that's right (a line's own fuel feedback is a short 2-3 row hop). But a self-FERT loop
    // feeds nurseries, which are source-leaves at the very top of the flow while the carrier output is
    // the DEEPEST node — so the straight arrow slices the whole line top-to-bottom, crossing every node
    // between. Reroute only those long back-edges (≥ SELF_FEED_BACK node-rows of backward span) as a
    // side rail bulging around the line's box, clear of its central nodes. Short feedback (self-fuel)
    // is left exactly as it was.
    const SELF_FEED_BACK = 4; // node-heights of backward flow before a feedback edge gets rerouted
    {
      let gMinX = Infinity, gMaxX = -Infinity, gMinY = Infinity, gMaxY = -Infinity;
      for (const p of pos.values()) { gMinX = Math.min(gMinX, p.x); gMaxX = Math.max(gMaxX, p.x + NODE_W); gMinY = Math.min(gMinY, p.y); gMaxY = Math.max(gMaxY, p.y + NODE_H); }
      const RAIL_GAP = 28;
      for (const e of graph.edges) {
        if (!(e.heat || e.nutrient)) continue;
        const a = pos.get(e.from), b = pos.get(e.to);
        if (!a || !b) continue;
        const key = boxKeyOf.get(e.to);
        if (key == null || boxKeyOf.get(e.from) !== key) continue; // intra-line only
        const box = boxByKey.get(key); const eo = edges.get(e.from + '\t' + e.to);
        if (!box || !eo) continue;
        if (orientation === 'TB') {
          if (b.y >= a.y - SELF_FEED_BACK * NODE_H) continue; // not a long back-edge
          const left = (box.x - gMinX) >= (gMaxX - (box.x + box.w)); // route on the side with more margin
          eo.start = { x: left ? a.x : a.x + NODE_W, y: a.y + NODE_H / 2 };
          eo.end = { x: left ? b.x : b.x + NODE_W, y: b.y + NODE_H / 2 };
          eo.bulge = left ? box.x - RAIL_GAP : box.x + box.w + RAIL_GAP;
        } else {
          if (b.x >= a.x - SELF_FEED_BACK * NODE_W) continue;
          const top = (box.y - gMinY) >= (gMaxY - (box.y + box.h));
          eo.start = { x: a.x + NODE_W / 2, y: top ? a.y : a.y + NODE_H };
          eo.end = { x: b.x + NODE_W / 2, y: top ? b.y : b.y + NODE_H };
          eo.bulgeY = top ? box.y - RAIL_GAP : box.y + box.h + RAIL_GAP;
        }
      }
    }

    // normalize: shift everything non-negative so the belt band's label (and any
    // top-row line label) isn't clipped by renderers that translate by a fixed margin
    let minX = Infinity, minY = Infinity;
    for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    for (const b of clusterBoxes) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); }
    for (const e of edges.values()) { if (e.bulge != null) minX = Math.min(minX, e.bulge); if (e.bulgeY != null) minY = Math.min(minY, e.bulgeY); }
    const dx = Number.isFinite(minX) && minX < 0 ? -minX : 0;
    const dy = Number.isFinite(minY) && minY < 0 ? -minY : 0;
    if (dx || dy) {
      for (const p of pos.values()) { p.x += dx; p.y += dy; }
      for (const b of clusterBoxes) { b.x += dx; b.y += dy; }
      for (const e of edges.values()) { e.start.x += dx; e.start.y += dy; e.end.x += dx; e.end.y += dy; if (e.bulge != null) e.bulge += dx; if (e.bulgeY != null) e.bulgeY += dy; }
      for (const t of trunks) { t.start.x += dx; t.start.y += dy; t.end.x += dx; t.end.y += dy; }
    }

    let width = 0;
    let height = 0;
    for (const p of pos.values()) { width = Math.max(width, p.x + NODE_W); height = Math.max(height, p.y + NODE_H); }
    // a right/bottom self-feed rail can sit just past the deepest node — keep it inside the canvas
    for (const e of edges.values()) { if (e.bulge != null) width = Math.max(width, e.bulge + 2); if (e.bulgeY != null) height = Math.max(height, e.bulgeY + 2); }

    // Dash only genuine FEEDBACK edges — ones that run backward against the flow
    // (consumer at an earlier column than its producer, e.g. a self-fertilizer loop
    // feeding the farm). A forward edge stays solid even when its producer is shared
    // among several consumers (Soap → two cauldrons is two solid edges, not one
    // solid + one arbitrarily dashed).
    const recycle = new Set();
    for (const e of graph.edges) {
      if (e.from === e.to) continue;
      const rf = rank.get(e.from);
      const rt = rank.get(e.to);
      if (rf != null && rt != null && rt < rf) recycle.add(e.from + '\t' + e.to);
    }

    // Verify metric for the lateral-compaction proposal above: total FLOW of edges whose centre-to-
    // centre segment cuts through a line box that holds NEITHER endpoint (cash is banded, not a
    // raking line, so it's excluded). Weighted by rate because a 480/min trunk slicing across a line
    // is a real eyesore while a 4/min trickle is barely visible — a raw count would call the user's
    // "fuel beside its heavy consumer" order worse (more thin rakes) than the status quo (one fat
    // one). Real rendered box rects + real positions, so it sees what a lane/rank estimate can't.
    const segHitsRect = (ax, ay, bx, by, rx, ry, rw, rh) => {
      const X2 = rx + rw, Y2 = ry + rh;
      if (Math.max(ax, bx) < rx || Math.min(ax, bx) > X2 || Math.max(ay, by) < ry || Math.min(ay, by) > Y2) return false;
      const inside = (x, y) => x >= rx && x <= X2 && y >= ry && y <= Y2;
      if (inside(ax, ay) || inside(bx, by)) return true;
      const si = (x1, y1, x2, y2, x3, y3, x4, y4) => {
        const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3); if (Math.abs(d) < 1e-9) return false;
        const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
        const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
        return t >= 0 && t <= 1 && u >= 0 && u <= 1;
      };
      return si(ax, ay, bx, by, rx, ry, X2, ry) || si(ax, ay, bx, by, X2, ry, X2, Y2) || si(ax, ay, bx, by, X2, Y2, rx, Y2) || si(ax, ay, bx, by, rx, Y2, rx, ry);
    };
    // __boxCross drives the lane-REORDER verify and excludes cash edges (they fan from the belt
    // to every purchase, so counting them would swamp the signal). __boxCrossAll adds cash back
    // in and drives the COMPACTION verify, where a long money edge crossing a slid util box is
    // exactly the overlap we must catch.
    let __boxCross = 0, __boxCrossAll = 0;
    for (const e of graph.edges) {
      if (e.from === e.to) continue;
      const pa = pos.get(e.from), pb = pos.get(e.to); if (!pa || !pb) continue;
      const ax = pa.x + pa.w / 2, ay = pa.y + pa.h / 2, bx = pb.x + pb.w / 2, by = pb.y + pb.h / 2;
      for (const box of clusterBoxes) {
        if (!box.members || box.belt) continue;
        if (box.members.indexOf(e.from) >= 0 || box.members.indexOf(e.to) >= 0) continue;
        if (segHitsRect(ax, ay, bx, by, box.x, box.y, box.w, box.h)) {
          const w = (e.ratePerMin || 0) + 1;
          __boxCrossAll += w;
          if (!e.cash) __boxCross += w;
        }
      }
    }
    let chosen = { pos, edges, recycle, clusters: clusterBoxes, trunks, trunkedEdges, width, height, orientation, nodeW: NODE_W, nodeH: NODE_H, __boxCross, __boxCrossAll };
    if (laneCandidateIds && !o.__forceLaneOrder) {
      const candL = layout(graph, Object.assign({}, o, { __forceLaneOrder: laneCandidateIds }));
      // Adopt the reorder if it cuts more flow across boxes, OR — when it ties on box-rakes — if it
      // renders strictly NARROWER. The narrow-tiebreak is what lands the products-adjacent order
      // above: both the spread and the compact order rake 0 flow through boxes, so a strict-rake
      // test alone would keep the wide spread. Guard the tiebreak with __boxCrossAll (cash-inclusive)
      // so a narrower order whose compaction drops a util box onto a long belt→purchase money edge
      // — invisible to __boxCross but real in __boxCrossAll — is still rejected (Iron Nails T4).
      const cutsLess = candL.__boxCross < chosen.__boxCross - 1e-6;
      const tieNarrower = Math.abs(candL.__boxCross - chosen.__boxCross) <= 1e-6
        && candL.__boxCrossAll <= chosen.__boxCrossAll + 1e-6
        && candL.width < chosen.width - 1e-6;
      if (cutsLess || tieNarrower) chosen = candL;
    }
    // Compaction verify: the vertical-nesting slide can drop a util box onto a long belt/money
    // edge running down its target column (a column that looked empty wasn't). Re-render flat
    // (no compaction) and fall back to it only if the slide dragged STRICTLY more flow across
    // boxes — so a clean slide (its target column truly free) is kept.
    if (didCompact && !o.__noCompact && !o.__forceLaneOrder) {
      const flat = layout(graph, Object.assign({}, o, { __noCompact: true }));
      if (flat.__boxCrossAll < chosen.__boxCrossAll - 1e-6) chosen = flat;
    }
    return chosen;
  }

  // Smooth cubic link between a start and end anchor (horizontal tangents in LR,
  // vertical in TB), so long cross-column edges read as clean curves.
  function edgePath(e, orientation) {
    if (!e) return '';
    const { start: s, end: t } = e;
    if (orientation === 'TB') {
      // Side rail (self-feed feedback): leave/enter horizontally and sweep vertically at the rail x.
      if (e.bulge != null) return `M${s.x},${s.y} C${e.bulge},${s.y} ${e.bulge},${t.y} ${t.x},${t.y}`;
      const dy = (t.y - s.y) * 0.5;
      return `M${s.x},${s.y} C${s.x},${s.y + dy} ${t.x},${t.y - dy} ${t.x},${t.y}`;
    }
    if (e.bulgeY != null) return `M${s.x},${s.y} C${s.x},${e.bulgeY} ${t.x},${e.bulgeY} ${t.x},${t.y}`;
    const dx = (t.x - s.x) * 0.5;
    return `M${s.x},${s.y} C${s.x + dx},${s.y} ${t.x - dx},${t.y} ${t.x},${t.y}`;
  }

  function edgeMid(e) {
    if (!e) return { x: 0, y: 0 };
    if (e.bulge != null) return { x: e.bulge, y: (e.start.y + e.end.y) / 2 };   // label rides the rail
    if (e.bulgeY != null) return { x: (e.start.x + e.end.x) / 2, y: e.bulgeY };
    return { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 };
  }

  return { layout, edgePath, edgeMid, asapRanks, recycleEdges, assignClusters };
}));
