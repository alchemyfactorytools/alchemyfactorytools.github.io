// Rail design explorer: factory plan → candidate track topologies → auto-sized fleets → scores.
//
// A plan lists modules (with a floor), flows between them (item, items/min, stock|freight), and
// geometry params. Each TEMPLATE turns the plan into a src/rail.js scenario; sizeFleets() then
// adds wagons to the worst-starved fleet until every consumer is fed (or the cap is hit), and
// score() summarises wagons, track, stations, starvation and utilisation so layouts compare.
//
// Templates:
//   single-loop   one loop through every floor in order (ramps inline); every wagon visits everything
//   trunk-zones   ground trunk loop + one loop per upper floor, joined by Transfer Stations
//   shuttles      one dedicated loop per flow (point to point, no sharing)
// Fleets:
//   shared        one Launch Station per loop; loaders/unloaders address packs by CARGO
//   perFlow       one Launch Station per flow on each loop it uses; addressed by TAG
// (loaders never top up, so a shared fleet with partial-load loaders can starve downstream
//  loaders — the explorer makes that visible instead of hiding it.)

'use strict';

const { simulate } = require('./rail');

const DEFAULT_GEOMETRY = { stationSpacing: 10, rampLength: 30, loopSlack: 20 };

function flowsOf(plan) {
  return plan.flows.map((f, i) => ({ id: f.id || `${f.item}:${f.from}>${f.to}`.replace(/\s+/g, '_'), ...f, idx: i }));
}
const modFloor = (plan, id) => { const m = plan.modules.find((x) => x.id === id); if (!m) throw new Error(`plan: unknown module ${id}`); return m.floor || 0; };

// Build one loop: a ring of nodes with `spacing` between consecutive stations. `pieces` is an
// ordered list of { node, station? }. Returns edges and a helper to look up nodes.
function ring(prefix, pieces, geo, edges) {
  const nodes = pieces.map((p, i) => `${prefix}:${i}:${p.key}`);
  for (let i = 0; i < nodes.length; i++) {
    const next = nodes[(i + 1) % nodes.length];
    const len = i === nodes.length - 1 ? geo.stationSpacing + geo.loopSlack : geo.stationSpacing;
    edges.push({ from: nodes[i], to: next, length: len, ramp: !!pieces[i].rampAfter });
  }
  return nodes;
}

// Stations for a flow given the loop's fleet policy. `loopTag` is the shared fleet's tag.
function flowStations(f, fleet, loopTag, nodes, wagons) {
  const st = [];
  const tag = fleet === 'perFlow' ? f.id : loopTag;
  const loaderFilter = { tag: { value: tag } };
  const unloaderFilter = fleet === 'perFlow' ? { tag: { value: tag } } : { tag: { value: tag }, cargo: { items: [f.item], mode: 'or' } };
  if (fleet === 'perFlow') st.push({ id: `launch.${f.id}@${loopTag}`, type: 'launch', node: nodes.launch, wagons: wagons[`launch.${f.id}@${loopTag}`] || 1, tag });
  st.push({ id: `load.${f.id}@${loopTag}`, type: 'loader', node: nodes.load, item: f.item, ratePerMin: f.ratePerMin, fullLoadsOnly: f.kind !== 'stock', filter: loaderFilter });
  st.push({ id: `unload.${f.id}@${loopTag}`, type: 'unloader', node: nodes.unload, consumePerMin: f.ratePerMin, chestCap: f.chestCap || 600, filter: unloaderFilter });
  return st;
}

// ---- template: single loop through all floors ----
function singleLoop(plan, fleet, wagons) {
  const geo = { ...DEFAULT_GEOMETRY, ...(plan.geometry || {}) };
  const flows = flowsOf(plan);
  const floors = [...new Set(plan.modules.map((m) => m.floor || 0))].sort((a, b) => a - b);
  const pieces = [];
  const loopTag = 'main';
  if (fleet === 'shared') pieces.push({ key: 'launch' });
  for (const fl of floors) {
    for (const f of flows) {
      if (fleet === 'perFlow' && modFloor(plan, f.from) === fl) pieces.push({ key: `launch.${f.id}` });
      if (modFloor(plan, f.from) === fl) pieces.push({ key: `load.${f.id}` });
      if (modFloor(plan, f.to) === fl) pieces.push({ key: `unload.${f.id}` });
    }
    pieces[pieces.length - 1].rampAfter = fl !== floors[floors.length - 1];
  }
  const edges = [];
  const nodes = ring('L', pieces, geo, edges);
  // the closing edge descends the whole tower
  edges[edges.length - 1].ramp = floors.length > 1;
  edges[edges.length - 1].length = geo.stationSpacing + geo.rampLength * (floors.length - 1);
  for (const e of edges) if (e.ramp && e !== edges[edges.length - 1]) e.length = geo.rampLength;
  const at = (key) => nodes[pieces.findIndex((p) => p.key === key)];
  const stations = [];
  if (fleet === 'shared') stations.push({ id: `launch.${loopTag}`, type: 'launch', node: at('launch'), wagons: wagons[`launch.${loopTag}`] || 1, tag: loopTag });
  for (const f of flows) stations.push(...flowStations(f, fleet, loopTag, { launch: at(`launch.${f.id}`), load: at(`load.${f.id}`), unload: at(`unload.${f.id}`) }, wagons));
  return { edges, stations, template: 'single-loop', fleet };
}

// ---- template: ground trunk + one loop per upper floor, transfer stations between ----
function trunkZones(plan, fleet, wagons) {
  const geo = { ...DEFAULT_GEOMETRY, ...(plan.geometry || {}) };
  const flows = flowsOf(plan);
  const floors = [...new Set(plan.modules.map((m) => m.floor || 0))].sort((a, b) => a - b);
  const edges = [];
  const stations = [];
  // per loop: pieces then nodes
  const loops = new Map(); // floor → { tag, pieces }
  const pushPiece = (fl, key) => { if (!loops.has(fl)) loops.set(fl, { tag: fl === 0 ? 'trunk' : `f${fl}`, pieces: [] }); loops.get(fl).pieces.push({ key }); };
  for (const fl of floors) if (fleet === 'shared') pushPiece(fl, 'launch');
  for (const f of flows) {
    const a = modFloor(plan, f.from), b = modFloor(plan, f.to);
    if (a === b) { // local: same loop
      if (fleet === 'perFlow') pushPiece(a, `launch.${f.id}`);
      pushPiece(a, `load.${f.id}`); pushPiece(a, `unload.${f.id}`);
    } else {
      // origin loop: launch? + load + transfer-in (to trunk) ; trunk: transfer-out (from origin) … transfer-in (to dest); dest loop: transfer-out + unload
      const hops = [];
      if (a !== 0) hops.push([a, 0]);
      if (b !== 0) hops.push([0, b]);
      if (a === 0 && b === 0) hops.length = 0;
      if (fleet === 'perFlow') { pushPiece(a, `launch.${f.id}`); if (a !== 0 && b !== 0) pushPiece(0, `launch.${f.id}`); if (b !== a) pushPiece(b, `launch.${f.id}`); }
      pushPiece(a, `load.${f.id}`);
      for (const [x, y] of hops) { pushPiece(x, `xin.${f.id}.${x}>${y}`); pushPiece(y, `xout.${f.id}.${x}>${y}`); }
      pushPiece(b, `unload.${f.id}`);
    }
  }
  const nodeOf = new Map();
  for (const [fl, L] of loops) {
    const nodes = ring(`F${fl}`, L.pieces, geo, edges);
    L.pieces.forEach((p, i) => nodeOf.set(`${fl}|${p.key}`, nodes[i]));
    if (fleet === 'shared') stations.push({ id: `launch.${L.tag}`, type: 'launch', node: nodeOf.get(`${fl}|launch`), wagons: wagons[`launch.${L.tag}`] || 1, tag: L.tag });
  }
  const tagOn = (fl, f) => (fleet === 'perFlow' ? f.id : loops.get(fl).tag);
  for (const f of flows) {
    const a = modFloor(plan, f.from), b = modFloor(plan, f.to);
    const path = a === b ? [a] : [a, ...(a !== 0 && b !== 0 ? [0] : []), b];
    if (fleet === 'perFlow') for (const fl of path) stations.push({ id: `launch.${f.id}@${loops.get(fl).tag}`, type: 'launch', node: nodeOf.get(`${fl}|launch.${f.id}`), wagons: wagons[`launch.${f.id}@${loops.get(fl).tag}`] || 1, tag: f.id });
    const filt = (fl) => (fleet === 'perFlow' ? { tag: { value: f.id } } : { tag: { value: tagOn(fl, f) }, cargo: { items: [f.item], mode: 'or' } });
    stations.push({ id: `load.${f.id}`, type: 'loader', node: nodeOf.get(`${a}|load.${f.id}`), item: f.item, ratePerMin: f.ratePerMin, fullLoadsOnly: f.kind !== 'stock', filter: { tag: { value: tagOn(a, f) } } });
    for (let i = 0; i + 1 < path.length; i++) {
      const x = path[i], y = path[i + 1];
      stations.push({ id: `xfer.${f.id}.${x}>${y}`, type: 'transfer', inNode: nodeOf.get(`${x}|xin.${f.id}.${x}>${y}`), outNode: nodeOf.get(`${y}|xout.${f.id}.${x}>${y}`), inFilter: filt(x), outFilter: { tag: { value: tagOn(y, f) } } });
    }
    stations.push({ id: `unload.${f.id}`, type: 'unloader', node: nodeOf.get(`${b}|unload.${f.id}`), consumePerMin: f.ratePerMin, chestCap: f.chestCap || 600, filter: filt(b) });
  }
  return { edges, stations, template: 'trunk-zones', fleet };
}

// ---- template: one dedicated loop per flow ----
function shuttles(plan, fleet, wagons) {
  const geo = { ...DEFAULT_GEOMETRY, ...(plan.geometry || {}) };
  const flows = flowsOf(plan);
  const edges = [], stations = [];
  for (const f of flows) {
    const a = modFloor(plan, f.from), b = modFloor(plan, f.to);
    const pieces = [{ key: 'launch' }, { key: 'load', rampAfter: a !== b }, { key: 'unload', rampAfter: a !== b }];
    const nodes = ring(`S.${f.id}`, pieces, geo, edges);
    for (const e of edges.slice(-3)) if (e.ramp) e.length = geo.rampLength * Math.abs(a - b);
    const tag = f.id;
    stations.push({ id: `launch.${f.id}`, type: 'launch', node: nodes[0], wagons: wagons[`launch.${f.id}`] || 1, tag });
    stations.push({ id: `load.${f.id}`, type: 'loader', node: nodes[1], item: f.item, ratePerMin: f.ratePerMin, fullLoadsOnly: f.kind !== 'stock', filter: { tag: { value: tag } } });
    stations.push({ id: `unload.${f.id}`, type: 'unloader', node: nodes[2], consumePerMin: f.ratePerMin, chestCap: f.chestCap || 600, filter: { tag: { value: tag } } });
  }
  return { edges, stations, template: 'shuttles', fleet: 'perFlow' };
}

const TEMPLATES = { 'single-loop': singleLoop, 'trunk-zones': trunkZones, shuttles };

// Grow fleets until no unloader starves more than `maxStarvedPct`, or a launch hits `maxWagons`.
function sizeFleets(plan, template, fleet, opts = {}) {
  const { minutes = 90, maxStarvedPct = 8, maxWagons = 12, params = {} } = opts;
  const wagons = {};
  const partialFlips = new Set(); // freight flows switched to partial loads because full packs arrived too late
  let scenario, rep, rounds = 0;
  for (;;) {
    const p2 = partialFlips.size ? { ...plan, flows: flowsOf(plan).map((f) => (partialFlips.has(f.id) ? { ...f, kind: 'stock' } : f)) } : plan;
    scenario = TEMPLATES[template](p2, fleet, wagons);
    rep = simulate({ ...scenario, params: { ...(plan.params || {}), ...params } }, { minutes });
    const starved = Object.entries(rep.stations).filter(([, s]) => s.type === 'unloader' && s.starvedPct > maxStarvedPct).sort((x, y) => y[1].starvedPct - x[1].starvedPct);
    if (!starved.length || rounds++ > 60) break;
    // grow a fleet on the starved flow's path: the loops of its loader, its transfer hops and its
    // unloader (shared fleets carry loop tags; perFlow fleets carry the flow id on every loop)
    const [uid] = starved[0];
    const flowId = uid.replace(/^unload\./, '').replace(/@.*$/, '');
    // a full-loads freight flow that starves is usually a latency problem (a pack arrives after
    // the chest ran dry), not a fleet problem: switch it to partial loads before adding wagons
    const loader = scenario.stations.find((s) => s.type === 'loader' && (s.id === `load.${flowId}` || s.id.startsWith(`load.${flowId}@`)));
    if (loader && loader.fullLoadsOnly && !partialFlips.has(flowId)) { partialFlips.add(flowId); continue; }
    const onPath = scenario.stations.filter((s) => s.id === `load.${flowId}` || s.id.startsWith(`load.${flowId}@`) || s.id.startsWith(`xfer.${flowId}.`) || s.id === uid);
    const tags = new Set();
    for (const s of onPath) { for (const flt of [s.filter, s.inFilter, s.outFilter]) if (flt && flt.tag) tags.add(flt.tag.value); }
    const launches = scenario.stations.filter((s) => s.type === 'launch' && tags.has(s.tag));
    // grow the smallest fleet on the path first
    const target = launches.sort((x, y) => (wagons[x.id] || 1) - (wagons[y.id] || 1))[0];
    if (!target || (wagons[target.id] || 1) >= maxWagons) break;
    wagons[target.id] = (wagons[target.id] || 1) + 1;
  }
  return { scenario, report: rep, wagons, partialFlips: [...partialFlips] };
}

function score(scenario, rep) {
  const unl = Object.values(rep.stations).filter((s) => s.type === 'unloader');
  const lds = Object.values(rep.stations).filter((s) => s.type === 'loader');
  const wag = Object.values(rep.wagons);
  return {
    template: scenario.template, fleet: scenario.fleet,
    wagons: wag.length,
    track: scenario.edges.reduce((a, e) => a + e.length, 0),
    stations: scenario.stations.length,
    launches: scenario.stations.filter((s) => s.type === 'launch').length,
    transfers: scenario.stations.filter((s) => s.type === 'transfer').length,
    worstStarvedPct: +Math.max(0, ...unl.map((s) => s.starvedPct)).toFixed(1),
    fedPct: +((unl.filter((s) => s.starvedPct <= 8).length / Math.max(1, unl.length)) * 100).toFixed(0),
    blockedLoaders: lds.filter((s) => s.blockedPct > 5).length,
    avgLoadedPct: +(wag.reduce((a, w) => a + w.loadedPct, 0) / Math.max(1, wag.length)).toFixed(1),
    maxLapSec: +Math.max(0, ...wag.map((w) => w.avgLapSec || 0)).toFixed(0),
  };
}

function explore(plan, opts = {}) {
  const combos = opts.combos || [['single-loop', 'shared'], ['single-loop', 'perFlow'], ['trunk-zones', 'shared'], ['trunk-zones', 'perFlow'], ['shuttles', 'perFlow']];
  const out = [];
  for (const [template, fleet] of combos) {
    const sized = sizeFleets(plan, template, fleet, opts);
    out.push({ ...score(sized.scenario, sized.report), wagonsByLaunch: sized.wagons, partialFlips: sized.partialFlips, scenario: sized.scenario, report: sized.report });
  }
  return out;
}

module.exports = { explore, sizeFleets, score, TEMPLATES, flowsOf };
