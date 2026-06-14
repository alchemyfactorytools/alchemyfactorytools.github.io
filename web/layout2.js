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
  else root.AlchLayout2 = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Longest path from sources, cycles broken by DFS back-edge removal.
  function asapRanks(graph) {
    const adj = new Map();
    const ids = [];
    for (const n of graph.nodes) { adj.set(n.id, []); ids.push(n.id); }
    // Fuel/fertilizer (heat/nutrient) edges are a SUPPORTING resource flow, not the
    // main material spine — a furnace's fuel or a nursery's fertilizer is produced
    // deep in the graph and fed BACK to a machine near the top. Letting them drive the
    // longest-path rank strands the real producer of the target shallow (e.g. the Black
    // Powder cauldron eating from fertilized nurseries gets ranked ABOVE them, leaving a
    // monster edge down to the target). Exclude them from ranking entirely: machines
    // rank by their material inputs, and the fuel/fert distribution falls out as the
    // back-edges that draw as feedback loops.
    const isSupport = (e) => e.heat || e.nutrient;
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
    // line roots = tree-children of the producer of each demanded item, busiest
    // first (rate order, inherited from treeKids) so ties go to the larger line.
    const lineRoots = [];
    const lineRootSet = new Set();
    for (const d of graph.nodes.filter((n) => n.type === 'demand')) {
      for (const prod of treeKids.get(d.id)) for (const inp of treeKids.get(prod)) {
        if (!lineRootSet.has(inp) && !excluded(inp)) { lineRootSet.add(inp); lineRoots.push(inp); }
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
    // Utility sources are nodes that feed heat (fuel) or nutrient (fertilizer) to a
    // machine — i.e. have an outgoing heat/nutrient edge — and aren't the belt
    // (which is its own band). Their upstream production chain becomes the Fuel /
    // Fertilizer line. Fertilizer takes priority when a node feeds both.
    // A node that directly produces a DEMANDED item is the main-spine final producer
    // and must never be pulled into a util (fuel/fert) line — even when the target is
    // itself a fuel/fertilizer (e.g. Black Powder, which a furnace burns), so the
    // cauldron making it ALSO has an outgoing heat edge. Without this it gets seeded
    // into util:fuel, pinned to the top band, and strands a monster edge to the target.
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
    for (const c of clusters) {
      const out = lineOutput(c.members);
      c.outItem = out ? out.item : null;
      c.outRate = out ? out.rate : null;
      // liquids are piped (effectively uncapped → cap 0 = no floor), solids ride a belt.
      const cap = c.outItem && liquidSet.has(c.outItem) ? 0 : beltSpeed;
      c.tile = blueprint(c.members, nodeById, c.outRate, cap);
    }
    return { clusterOf, clusters };
  }

  // Tileable blueprint for a line: the integer-machine cell you stamp out, and how
  // many copies. With backpressure (machines idle when downstream buffers fill),
  // inputs/fuel/fert are still drawn only at the demand rate, so we can freely round
  // machine counts UP into a clean cell — the extra machines just idle (build cost,
  // not input cost). We pick the K (copies) giving the FINEST reusable cell whose
  // over-build ("idle") stays low; cell_p = round(load_p / K), where load is the
  // continuous machine demand (node.tileLoad). NURSERIES are folded in too (tileLoad =
  // fractional plot count), so each tile is self-contained and K is driven by the most-
  // constrained producer — including the nursery (a fractional plot rounds up to a whole
  // plot per tile, which is physically honest). A tile's OUTPUT is also capped at one
  // transport line (belt for solids, pipe for liquids): a tile producing more than
  // transportCap/min can't be drained (backpressure throttles it), so K has a floor of
  // ceil(outRate / transportCap) — better two 150/min tiles than one 300/min tile a 240
  // belt can't empty. Always returns a cell.
  function blueprint(members, nodeById, outRate, transportCap) {
    // timed machines keep the (per-copy-rounded) machineCount × utilization load so
    // existing tiles are unchanged; nurseries (utilization == null) use the continuous
    // tileLoad (fractional plot count) so they fold in without disturbing the rest.
    const loadOf = (n) => (n.machineCount && n.utilization != null ? n.machineCount * n.utilization
      : (n.tileLoad != null ? n.tileLoad : null));
    const loads = members.map((m) => nodeById.get(m))
      .filter((n) => n && n.machine && loadOf(n) != null)
      .map((n) => ({ label: n.label, machine: n.machine, load: loadOf(n) }));
    if (loads.length < 2) return null;
    // transport floor: each tile's output must fit on one belt/pipe (one drain). Raises K
    // even when the machine loads alone would prefer a single coarse tile.
    const kCap = transportCap > 0 && outRate > 0 ? Math.ceil(outRate / transportCap - 1e-6) : 1;
    const maxK = Math.min(200, Math.max(1, Math.round(Math.max(...loads.map((l) => l.load))), kCap));
    const cands = [];
    for (let K = 1; K <= maxK; K++) {
      let over = 0, total = 0, ok = true;
      const cell = loads.map((l) => {
        const count = Math.max(1, Math.round(l.load / K));
        const have = K * count;
        if (have < l.load - 1e-6) ok = false; // under-provisioned → would throttle output
        over += have - l.load; total += have;
        return { label: l.label, machine: l.machine, count };
      });
      if (!ok || !total) continue;
      cands.push({ K, cell, idle: over / total, total });
    }
    if (!cands.length) return null;
    // honour the transport floor when any candidate satisfies it; otherwise fall back.
    const capOk = cands.filter((c) => c.K >= kCap);
    const pool = capOk.length ? capOk : cands;
    const clean = pool.filter((c) => c.idle <= 0.15);
    return clean.length ? clean.sort((a, b) => b.K - a.K)[0] : pool.sort((a, b) => a.idle - b.idle)[0];
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
      // edges (the fertilizer/fuel the line makes feeding its own nurseries/machines).
      // Those run "backwards" up the line, so counting them shoved the line's OUTPUT
      // (e.g. Fertile Catalyst) into the middle. Dropping them puts the output at the
      // bottom of the box and the feedback draws as a loop.
      for (const e of graph.edges) {
        if (mset.has(e.from) && mset.has(e.to) && e.from !== e.to && !e.nutrient && !e.heat && !back.has(e.from + '\t' + e.to)) {
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
      for (const arr of childrenOf.values()) arr.sort((a, b) => (colIdx.get(a) ?? 0) - (colIdx.get(b) ?? 0));
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

    // lane width = widest slot used in that lane (+1, rounded up since slots are real).
    const laneWidth = new Array(laneCount).fill(0);
    for (const [id, s] of slotOf) laneWidth[lane(id)] = Math.max(laneWidth[lane(id)], Math.ceil(s) + 1);
    for (const c of cols) {
      if (!c) continue;
      const cnt = new Array(laneCount).fill(0);
      for (const n of c) cnt[lane(n.id)]++;
      for (let l = 0; l < laneCount; l++) laneWidth[l] = Math.max(laneWidth[l], cnt[l]);
    }
    const laneOffset = new Array(laneCount).fill(0);
    for (let l = 1; l < laneCount; l++) laneOffset[l] = laneOffset[l - 1] + laneWidth[l - 1] * crossStep + (laneWidth[l - 1] ? LANE_GAP : 0);
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
    const pos = new Map();
    cols.forEach((c, r) => {
      if (!c) return;
      const seenInLane = new Array(laneCount).fill(0);
      for (const n of c) {
        const l = lane(n.id);
        // use the barycenter slot if we computed one; else fall back to packed order
        const slot = slotOf.has(n.id) ? slotOf.get(n.id) : seenInLane[l]++;
        // Drop the final target an extra row below its producers so the many lines that
        // converge on it have vertical room to fan in without piling onto each other.
        const demandDrop = n.type === 'demand' ? flowStep : 0;
        const flow = (r + (utilNodeSet.has(n.id) ? 0 : spineDrop)) * flowStep + headerOffset + demandDrop;
        const cross = laneOffset[l] + slot * crossStep;
        if (orientation === 'TB') pos.set(n.id, { x: cross, y: flow, w: NODE_W, h: NODE_H });
        else pos.set(n.id, { x: flow, y: cross, w: NODE_W, h: NODE_H });
      }
    });

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
      const rowCount = new Map();
      for (const id of pos.keys()) { const r = rank.get(id); rowCount.set(r, (rowCount.get(r) || 0) + 1); }
      const demandIds = new Set(graph.nodes.filter((n) => n.type === 'demand').map((n) => n.id));
      const finalProducers = new Set();
      for (const e of graph.edges) if (demandIds.has(e.to) && !beltSet.has(e.from)) finalProducers.add(e.from);
      // shallowest first: centre the final producer (on its product inputs) before
      // the demand centres on the producer.
      const toCenter = [...new Set([...demandIds, ...finalProducers])].sort((a, b) => rank.get(a) - rank.get(b));
      for (const id of toCenter) {
        const p = pos.get(id);
        if (!p || (rowCount.get(rank.get(id)) || 0) > 1) continue; // not alone in its row → keep banded (no overlap)
        const ins = graph.edges.filter((e) => e.to === id && pos.get(e.from)).map((e) => pos.get(e.from));
        if (!ins.length) continue;
        const c = ins.reduce((s, q) => s + crossCtr(q), 0) / ins.length;
        if (orientation === 'TB') p.x = c - NODE_W / 2; else p.y = c - NODE_H / 2;
      }
    }

    // edge anchor points (border to border). Multiple edges sharing a node face are
    // SPREAD across it (fanned), ordered by the other endpoint's cross position, so a
    // node's several inputs/outputs don't all stack on its centre — a cauldron pulling
    // Chamomile + Powder + Linen now shows three distinct fan-in points.
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
      // Tiled lines get a taller header: line 1 = name, line 2 = the tiling blueprint.
      // outItem/outRate (the dominant product leaving the box) come from assignClusters —
      // the header divides outRate by K to show each tile's output rate.
      const headH = extra && extra.tile ? 32 : 14;
      clusterBoxes.push({ x: x0 - PAD, y: y0 - PAD - headH, w: (x1 - x0) + 2 * PAD, h: (y1 - y0) + 2 * PAD + headH, headH, ...extra });
    };
    for (const c of laneClusters) boxOf(c.members, { label: c.label, key: c.id, tile: c.tile, outItem: c.outItem, outRate: c.outRate });
    for (const c of utilLines) boxOf(c.members, { label: c.label, util: true, key: c.id, tile: c.tile, outItem: c.outItem, outRate: c.outRate });
    // the spanning belt band — full cross-extent of the lines, one node deep
    if (beltNodes.length) {
      let crossExtent = 0;
      for (const p of pos.values()) crossExtent = Math.max(crossExtent, (orientation === 'TB' ? p.x + NODE_W : p.y + NODE_H));
      if (orientation === 'TB') clusterBoxes.push({ label: 'Main belt', belt: true, x: -PAD, y: -PAD - 14, w: crossExtent + 2 * PAD, h: NODE_H + 2 * PAD + 14 });
      else clusterBoxes.push({ label: 'Main belt', belt: true, x: -PAD, y: -PAD - 14, w: NODE_W + 2 * PAD, h: crossExtent + 2 * PAD + 14 });
    }

    // Trunk routing for fuel/fertilizer distribution: instead of one edge from a
    // source (the belt / a fuel-or-fert recipe) to EACH consuming machine, draw one
    // aggregated edge from the source to the consuming LINE's box boundary. Collapses
    // the fan-out spaghetti into a few labelled trunks. The per-machine bands still
    // show each machine's exact draw. Edges to unboxed/own-line consumers stay
    // individual (tracked in trunkedEdges so the renderer doesn't double-draw).
    const boxByKey = new Map();
    for (const b of clusterBoxes) if (b.key != null) boxByKey.set(b.key, b);
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
      const key = cluster.clusterOf.get(e.to);
      if (key == null || !boxByKey.has(key) || cluster.clusterOf.get(e.from) === key) continue;
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

    // normalize: shift everything non-negative so the belt band's label (and any
    // top-row line label) isn't clipped by renderers that translate by a fixed margin
    let minX = Infinity, minY = Infinity;
    for (const p of pos.values()) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    for (const b of clusterBoxes) { minX = Math.min(minX, b.x); minY = Math.min(minY, b.y); }
    const dx = Number.isFinite(minX) && minX < 0 ? -minX : 0;
    const dy = Number.isFinite(minY) && minY < 0 ? -minY : 0;
    if (dx || dy) {
      for (const p of pos.values()) { p.x += dx; p.y += dy; }
      for (const b of clusterBoxes) { b.x += dx; b.y += dy; }
      for (const e of edges.values()) { e.start.x += dx; e.start.y += dy; e.end.x += dx; e.end.y += dy; }
      for (const t of trunks) { t.start.x += dx; t.start.y += dy; t.end.x += dx; t.end.y += dy; }
    }

    let width = 0;
    let height = 0;
    for (const p of pos.values()) { width = Math.max(width, p.x + NODE_W); height = Math.max(height, p.y + NODE_H); }

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

    return { pos, edges, recycle, clusters: clusterBoxes, trunks, trunkedEdges, width, height, orientation, nodeW: NODE_W, nodeH: NODE_H };
  }

  // Smooth cubic link between a start and end anchor (horizontal tangents in LR,
  // vertical in TB), so long cross-column edges read as clean curves.
  function edgePath(e, orientation) {
    if (!e) return '';
    const { start: s, end: t } = e;
    if (orientation === 'TB') {
      const dy = (t.y - s.y) * 0.5;
      return `M${s.x},${s.y} C${s.x},${s.y + dy} ${t.x},${t.y - dy} ${t.x},${t.y}`;
    }
    const dx = (t.x - s.x) * 0.5;
    return `M${s.x},${s.y} C${s.x + dx},${s.y} ${t.x - dx},${t.y} ${t.x},${t.y}`;
  }

  function edgeMid(e) {
    if (!e) return { x: 0, y: 0 };
    return { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 };
  }

  return { layout, edgePath, edgeMid, asapRanks, recycleEdges, assignClusters };
}));
