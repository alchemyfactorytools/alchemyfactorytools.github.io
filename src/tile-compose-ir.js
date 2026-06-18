'use strict';
// LEVEL-2 IR producer: composeTilesIR — re-expresses a solved build as a DAG of CANONICAL,
// belt-sized, STAMPED tiles, emitting the same { tiles, ports, belts } contract the renderer
// consumes (web/render-ir.js). Where the Level-1 producer (src/tile-ir.js graphToIR) copies the
// composer's per-step counts verbatim, this one makes the TILE the unit:
//
//   - every produced item has a CANONICAL unit-tile (recipe pick is context-free — proven), sized
//     either to one machine or to one belt of output;
//   - the build STAMPS ceil(demand / unitOutput) identical tiles, so a 117/min flow becomes 2 belt
//     tiles, and an item's tile-set is identical across builds;
//   - inter-tile flows become belts, each capped at one belt's throughput.
//
// The canonical unit comes from an injected `solve` (a STANDALONE solve of the item) so the module
// needs no dataset. `config` (skills/pool/byproduct/maxTier) makes the standalone solve match the
// build, and gives beltSpeed via src/config.js.
//
// REGIME: faithful where recipe picks are canonical — proven for maxTier ≤ 5, easy pool (Gramaton
// 01KVA44EJC4SRCTGP5CZ858F3Q): there the standalone unit and the in-build node pick the SAME recipe,
// so stamp counts exactly cover the composer's demand. At higher tiers (cauldron / joint products)
// the standalone and in-build picks can diverge, so coverage drifts (over/under-build); the fix is
// the deferred LP-baked tile library (consistent picks). Until then high-tier output is structurally
// valid (belt-capped, complete, acyclic) but not count-faithful.

const { beltSpeed } = require('./config');

// edge → belt kind (same rule as src/tile-ir.js beltKind, which isn't exported)
const beltKind = (e) => (e.heat ? 'fuel' : e.nutrient ? 'fert' : e.cash ? 'cash' : 'material');

const EPS = 1e-6;
// effective (saturated) machines doing work — utilization for recipes, plot count for nurseries.
const loadOf = (n) => (n.utilization != null ? n.machineCount * n.utilization : (n.tileLoad != null ? n.tileLoad : n.machineCount));
// the produced ITEM behind a node label — cauldron labels read "Item ⬅ cauldron(ins)"; recipes are bare.
const itemOf = (label) => String(label || '').split(' ⬅ ')[0];

// Build a memoized per-item canonical profile from a STANDALONE solve: the saturated single-machine
// output rate plus the per-machine utility draws (fuel/fert/furnace/recirc). Returns null for items
// with no recipe (raws/leaves → bought).
function makeProfiler(solve, config) {
  const cache = new Map();
  return function profile(item) {
    if (cache.has(item)) return cache.get(item);
    let prof = null;
    let out;
    try { out = solve({ item, rate: 60, rateMode: 'rate', targets: [{ item, rate: 60, rateMode: 'rate' }], config }); } catch (e) { out = null; }
    const graph = out && out.status === 'Optimal' && out.graph;
    if (graph) {
      const prods = graph.nodes.filter((n) => itemOf(n.label) === item && n.machine && n.machineCount);
      if (prods.length) {
        const gross = prods.reduce((s, n) => s + (n.ratePerMin || 0), 0);
        const load = prods.reduce((s, n) => s + loadOf(n), 0);
        if (load > EPS && gross > EPS) {
          const sum = (f) => prods.reduce((s, n) => s + (n[f] || 0), 0);
          const recircMap = new Map();
          for (const n of prods) for (const rc of (n.recirc || [])) recircMap.set(rc.item, (recircMap.get(rc.item) || 0) + (rc.ratePerMin || 0));
          const furn = prods.reduce((s, n) => s + (n.furnaces || 0), 0);
          prof = {
            machine: prods[0].machine,
            rate: gross / load,                                   // saturated per-machine output
            fuelItem: prods.find((n) => n.fuelItem) ? prods.find((n) => n.fuelItem).fuelItem : null,
            fuelPerMach: sum('fuelPerMin') / load,
            fertItem: prods.find((n) => n.fertItem) ? prods.find((n) => n.fertItem).fertItem : null,
            fertPerMach: sum('fertPerMin') / load,
            furnaceItem: prods.find((n) => n.furnaceItem) ? prods.find((n) => n.furnaceItem).furnaceItem : null,
            furnacePerMach: furn / load,
            heatPerMach: sum('heatPerMin') / load,
            nutrientPerMach: sum('nutrientPerMin') / load,
            recircPerMach: [...recircMap].map(([it, r]) => ({ item: it, ratePerMach: r / load })),
          };
        }
      }
    }
    cache.set(item, prof);
    return prof;
  };
}

// The canonical unit-tile for an item at a size mode ('machine' | 'belt'). Bands scale with count.
function unitTile(item, mode, profile, BELT) {
  const p = profile(item);
  if (!p) return null;
  const count = mode === 'belt' ? Math.max(1, Math.ceil(BELT / p.rate - 1e-9)) : 1;
  const out = mode === 'belt' ? Math.min(count * p.rate, BELT) : p.rate;
  const band = (per) => per * count;
  return {
    item, machine: p.machine, count, out,
    fuelItem: p.fuelPerMach > EPS ? p.fuelItem : null, fuelPerMin: band(p.fuelPerMach),
    fertItem: p.fertPerMach > EPS ? p.fertItem : null, fertPerMin: band(p.fertPerMach),
    furnaces: p.furnacePerMach > EPS ? Math.max(1, Math.round(band(p.furnacePerMach))) : null,
    furnaceItem: p.furnacePerMach > EPS ? p.furnaceItem : null,
    heatPerMin: band(p.heatPerMach), nutrientPerMin: band(p.nutrientPerMach),
    recirc: p.recircPerMach.length ? p.recircPerMach.map((r) => ({ item: r.item, ratePerMin: band(r.ratePerMach) })) : null,
    utilization: count * p.rate > EPS ? out / (count * p.rate) : 1,
  };
}

// Stamp list for one item at total demand `gross`: [{ unit, n }]. hybrid = whole belt-tiles for the
// bulk + machine-tiles for the remainder (matches the exact machine count, consolidates belts).
function stampsFor(item, gross, mode, profile, BELT) {
  const belt = unitTile(item, 'belt', profile, BELT);
  const mach = unitTile(item, 'machine', profile, BELT);
  if (!belt || !mach) return null;
  if (mode === 'machine') return [{ unit: mach, n: Math.max(1, Math.ceil(gross / mach.out - 1e-9)) }];
  if (mode === 'belt') return [{ unit: belt, n: Math.max(1, Math.ceil(gross / belt.out - 1e-9)) }];
  const nBelt = Math.floor(gross / belt.out + 1e-9);
  const rem = gross - nBelt * belt.out;
  const out = [];
  if (nBelt > 0) out.push({ unit: belt, n: nBelt });
  if (rem > 1e-4) out.push({ unit: mach, n: Math.max(1, Math.ceil(rem / mach.out - 1e-9)) });
  if (!out.length) out.push({ unit: mach, n: 1 });
  const merged = new Map();
  for (const st of out) { const k = st.unit.machine + '\t' + st.unit.count; if (merged.has(k)) merged.get(k).n += st.n; else merged.set(k, { unit: st.unit, n: st.n }); }
  return [...merged.values()];
}

// Chop a flow of `rate` into ≤ BELT belt-chunks (full belts + a remainder), assigning each chunk to
// a (src stamp, dst stamp) round-robin so the flow fans across the stamps it connects.
function chopBelts(rate, srcIds, dstIds, item, kind, cap, out) {
  const chunks = [];
  let r = rate;
  while (r > cap + EPS) { chunks.push(cap); r -= cap; }
  if (r > EPS) chunks.push(r);
  if (!chunks.length || !srcIds.length || !dstIds.length) return;
  chunks.forEach((c, i) => out.push({ from: srcIds[i % srcIds.length], to: dstIds[i % dstIds.length], item, rate: c, kind }));
}

// MAIN — buildGraph: the solved build; solve: standalone solver; config: build config; mode: stamp size.
function composeTilesIR(buildGraph, opts) {
  const o = opts || {};
  const mode = o.mode || 'hybrid';
  const config = o.config || {};
  const BELT = beltSpeed((config.skills && config.skills.logistics) || 0) || 60;
  const profile = makeProfiler(o.solve, config);

  const nodeById = new Map(buildGraph.nodes.map((n) => [n.id, n]));
  const isRecipe = (n) => !!(n && n.machine && n.machineCount);

  // 1. gross output per produced item (sum over the replicated recipe nodes sharing an item)
  const grossOf = new Map();
  for (const n of buildGraph.nodes) if (isRecipe(n)) { const it = itemOf(n.label); grossOf.set(it, (grossOf.get(it) || 0) + (n.ratePerMin || 0)); }

  // 2+3. stamp each produced item into IR tiles; index stamps per item for the synthetic id
  const tiles = [];
  const stampIdsOf = new Map(); // item -> [tileId...]  (producer/consumer stamp pool for belt assignment)
  for (const [item, gross] of [...grossOf].sort((a, b) => b[1] - a[1])) {
    const stamps = stampsFor(item, gross, mode, profile, BELT);
    if (!stamps) continue;                 // shouldn't happen (it's a produced item) — guard
    const ids = [];
    let k = 0;
    for (const st of stamps) for (let i = 0; i < st.n; i++) {
      const id = `${item}#${k++}`;
      tiles.push({ id, group: item, ...st.unit, item, out: st.unit.out });
      ids.push(id);
    }
    stampIdsOf.set(item, ids);
  }

  // 4. belts — collapse the replicated tree to a DAG: classify each edge endpoint to a LABEL-level
  //    key (produced item / buy / belt-supply / demand / trash / surplus), aggregate flows by
  //    (srcKey, dstKey, item, kind), then chop each flow into belt-sized lanes across the stamp pools.
  const classify = (graphId) => {
    const n = nodeById.get(graphId);
    if (n && isRecipe(n)) return { key: 'item:' + itemOf(n.label), item: itemOf(n.label) };
    if (!n) return { key: 'node:' + graphId, role: 'node', label: graphId };
    if (n.type === 'demand') return { key: 'demand:' + n.label, role: 'demand', label: n.label };
    if (n.kind === 'belt') return { key: 'belt:' + n.label, role: 'belt', node: n, label: n.label };
    if (n.id === 'money:belt' || /coin/i.test(n.label || '')) return { key: 'money', role: 'belt', node: n, label: n.label || 'Main belt: coins' };
    if (n.kind === 'purchase' || n.kind === 'mint' || n.type === 'external') return { key: 'buy:' + n.label, role: 'resource', node: n, label: n.label };
    if (/^trash:/.test(graphId)) return { key: 'trash:' + n.label, role: 'trash', label: n.label };
    if (/^surplus:/.test(graphId)) return { key: 'surplus:' + n.label, role: 'surplus', label: n.label };
    return { key: 'node:' + graphId, role: n.type || 'node', label: n.label || graphId };
  };

  const ports = [];
  const flows = new Map(); // key -> { src, dst, item, kind, rate }
  const portInfo = new Map(); // portKey -> { class, rate, cost }
  const notePort = (cl, rate) => {
    if (cl.key.startsWith('item:')) return;
    if (!portInfo.has(cl.key)) portInfo.set(cl.key, { cl, rate: 0, cost: 0 });
    const pi = portInfo.get(cl.key); pi.rate += rate; pi.cost += (cl.node && cl.node.copperPerMin) || 0;
  };
  for (const e of buildGraph.edges) {
    if (e.from === e.to) continue;
    const kind = beltKind(e), rate = e.ratePerMin || 0;
    const src = classify(e.from), dst = classify(e.to);
    const fk = `${src.key}\t${dst.key}\t${e.item}\t${kind}`;
    if (!flows.has(fk)) flows.set(fk, { src, dst, item: e.item, kind, rate: 0 });
    flows.get(fk).rate += rate;
    notePort(src, rate); notePort(dst, rate);
  }

  // build ports from the accumulated endpoint info (one per non-item key)
  for (const { cl, rate, cost } of portInfo.values()) {
    const p = { id: cl.key, role: cl.role, item: cl.label, rate };
    if (cl.role === 'belt') { p.line = 'supply'; p.cost = (cl.node && cl.node.copperPerMin) || (cl.key === 'money' ? rate : 0); if (cl.node) { p.supplyRate = cl.node.supplyRate; p.beltLanes = cl.node.beltLanes; p.beltSpeed = cl.node.beltSpeed; } }
    else if (cl.role === 'demand') p.line = cl.label;
    else if (cl.role === 'resource') p.cost = cost;
    ports.push(p);
  }
  const idsFor = (cl) => (cl.key.startsWith('item:') ? (stampIdsOf.get(cl.item) || null) : [cl.key]);

  const belts = [];
  for (const f of flows.values()) {
    const srcIds = idsFor(f.src), dstIds = idsFor(f.dst);
    if (!srcIds || !dstIds || !srcIds.length || !dstIds.length) continue;
    // material/fuel/fert are physical items on 60/min belts → chop to lanes. cash is coins (face
    // value, not item throughput) → one aggregated line, never chopped by belt speed.
    chopBelts(f.rate, srcIds, dstIds, f.item, f.kind, f.kind === 'cash' ? Infinity : BELT, belts);
  }

  return { tiles, ports, belts, meta: { mode, beltSpeed: BELT } };
}

module.exports = { composeTilesIR, makeProfiler, unitTile, stampsFor, loadOf };
