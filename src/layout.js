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
  else root.AlchLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Longest path from sources, cycles broken by DFS back-edge removal.
  function asapRanks(graph) {
    const adj = new Map();
    const ids = [];
    for (const n of graph.nodes) { adj.set(n.id, []); ids.push(n.id); }
    for (const e of graph.edges) {
      if (e.from === e.to || !adj.has(e.from) || !adj.has(e.to)) continue;
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
      if (e.from === e.to || back.has(e.from + '\t' + e.to) || !fadj.has(e.from) || !fadj.has(e.to)) continue;
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
    const fuelSources = new Set();
    const fertSources = new Set();
    for (const e of graph.edges) {
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
    const shared = new Set();
    for (const [nid, keys] of consumerKeys) {
      if (keys.size >= 2 && !seedNodes.has(nid) && !excluded(nid) && !protectedFeeders.has(nid)) shared.add(nid);
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
    for (const c of clusters) c.tile = blueprint(c.members, nodeById);
    return { clusterOf, clusters };
  }

  // Tileable blueprint for a line: the integer-machine cell you stamp out, and how
  // many copies. With backpressure (machines idle when downstream buffers fill),
  // inputs/fuel/fert are still drawn only at the demand rate, so we can freely round
  // machine counts UP into a clean cell — the extra machines just idle (build cost,
  // not input cost). We pick the K (copies) giving the FINEST reusable cell whose
  // over-build ("idle") stays low; cell_p = round(load_p / K), where load is the
  // continuous machine demand (machineCount × utilization). Always returns a cell.
  function blueprint(members, nodeById) {
    const loads = members.map((m) => nodeById.get(m))
      .filter((n) => n && n.machineCount && n.utilization != null && n.machine)
      .map((n) => ({ label: n.label, machine: n.machine, load: n.machineCount * n.utilization }));
    if (loads.length < 2) return null;
    const maxK = Math.min(200, Math.max(1, Math.round(Math.max(...loads.map((l) => l.load)))));
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
    const clean = cands.filter((c) => c.idle <= 0.15);
    return clean.length ? clean.sort((a, b) => b.K - a.K)[0] : cands.sort((a, b) => a.idle - b.idle)[0];
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
    let realMax = 0;
    for (const n of graph.nodes) {
      if (n.type !== 'demand' && !isAux(n)) realMax = Math.max(realMax, rank.get(n.id));
    }
    for (const n of graph.nodes) {
      if (isAux(n) && rank.get(n.id) > realMax) rank.set(n.id, realMax);
      if (n.type === 'demand') rank.set(n.id, realMax + 1);
    }
    let maxR = 0;
    for (const r of rank.values()) if (r > maxR) maxR = r;

    // production-line clusters → a lane index per cluster so its members stay in a
    // contiguous band across columns (and unclustered nodes go after, by barycenter)
    const cluster = o.clusters === false ? { clusterOf: new Map(), clusters: [] } : assignClusters(graph);
    // Fuel/fertilizer UTILITY lines are pulled out of the vertical lanes and laid as
    // HORIZONTAL bands just under the belt (see below), so their output sits right
    // above the Nurseries (rank 0 of the product lines) that consume it. The rest —
    // product lines (the main spine) then shared sub-assemblies — keep their lanes.
    const isUtil = (c) => String(c.id).startsWith('util:');
    const utilLines = cluster.clusters.filter(isUtil);
    const utilSet = new Set();
    for (const c of utilLines) for (const m of c.members) utilSet.add(m);
    const laneClusters = cluster.clusters.filter((c) => !isUtil(c));
    laneClusters.sort((a, b) => (String(a.id).startsWith('shared:') ? 1 : 0) - (String(b.id).startsWith('shared:') ? 1 : 0));
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
    const laneWidth = new Array(laneCount).fill(0);
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
    const pos = new Map();
    cols.forEach((c, r) => {
      if (!c) return;
      const seenInLane = new Array(laneCount).fill(0);
      for (const n of c) {
        const l = lane(n.id);
        const j = seenInLane[l]++;
        const flow = r * flowStep + headerOffset;
        const cross = laneOffset[l] + j * crossStep;
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
      clusterBoxes.push({ x: x0 - PAD, y: y0 - PAD - 14, w: (x1 - x0) + 2 * PAD, h: (y1 - y0) + 2 * PAD + 14, ...extra });
    };
    for (const c of laneClusters) boxOf(c.members, { label: c.label, key: c.id, tile: c.tile });
    for (const c of utilLines) boxOf(c.members, { label: c.label, util: true, key: c.id, tile: c.tile });
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
      if (!(e.heat || e.nutrient)) continue;
      const key = cluster.clusterOf.get(e.to);
      if (key == null || !boxByKey.has(key) || cluster.clusterOf.get(e.from) === key) continue;
      trunkedEdges.add(e.from + '\t' + e.to);
      const kind = e.heat ? 'fuel' : 'fert';
      const k = e.from + '|' + key + '|' + kind;
      let t = trunkMap.get(k);
      if (!t) { t = { from: e.from, toKey: key, heat: !!e.heat, nutrient: !!e.nutrient, item: e.item, ratePerMin: 0, tos: [] }; trunkMap.set(k, t); }
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
