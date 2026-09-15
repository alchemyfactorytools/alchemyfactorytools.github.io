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

// ---- template: trunk loop + zone loops, transfer stations between ----
// Every module lives in a zone loop; a floor is split round-robin into plan.loopsPerFloor zones
// (default 1). The trunk carries only inter-zone traffic. A shared fleet can have several Launch
// Stations per loop (plan.launchesPerLoop), which lifts the 6-wagons-per-minute release cap.
function trunkZones(plan, fleet, wagons) {
  const geo = { ...DEFAULT_GEOMETRY, ...(plan.geometry || {}) };
  const K = Math.max(1, plan.loopsPerFloor || 1);
  const L = Math.max(1, plan.launchesPerLoop || 1);
  const flows = flowsOf(plan);
  const zoneOf = new Map(); // module id → zone key
  const byFloor = new Map();
  for (const m of plan.modules) { const fl = m.floor || 0; if (!byFloor.has(fl)) byFloor.set(fl, []); byFloor.get(fl).push(m.id); }
  for (const [fl, ids] of byFloor) ids.sort().forEach((id, i) => zoneOf.set(id, `z${fl}.${i % K}`));
  const edges = [];
  const stations = [];
  const loops = new Map(); // zone key → { tag, pieces }
  const loop = (z) => { if (!loops.has(z)) loops.set(z, { tag: z, pieces: [] }); return loops.get(z); };
  const pushPiece = (z, key) => loop(z).pieces.push({ key });
  loop('trunk');
  for (const f of flows) {
    const a = zoneOf.get(f.from), b = zoneOf.get(f.to);
    if (!a || !b) throw new Error(`plan: flow ${f.id} references an unknown module`);
    const path = a === b ? [a] : [a, 'trunk', b];
    if (fleet === 'perFlow') for (const z of path) pushPiece(z, `launch.${f.id}`);
    pushPiece(a, `load.${f.id}`);
    for (let i = 0; i + 1 < path.length; i++) { pushPiece(path[i], `xin.${f.id}.${i}`); pushPiece(path[i + 1], `xout.${f.id}.${i}`); }
    pushPiece(b, `unload.${f.id}`);
  }
  // shared fleets: L launch stations spread evenly around each loop
  if (fleet === 'shared') for (const [, Lp] of loops) {
    const n = Lp.pieces.length || 1;
    for (let i = 0; i < L; i++) Lp.pieces.splice(Math.min(Lp.pieces.length, Math.floor((i * n) / L) + i), 0, { key: `launch#${i}` });
  }
  const nodeOf = new Map();
  for (const [z, Lp] of loops) {
    if (!Lp.pieces.length) continue;
    const nodes = ring(z, Lp.pieces, geo, edges);
    Lp.pieces.forEach((p, i) => nodeOf.set(`${z}|${p.key}`, nodes[i]));
    if (fleet === 'shared') for (let i = 0; i < L; i++) stations.push({ id: `launch.${z}#${i}`, type: 'launch', node: nodeOf.get(`${z}|launch#${i}`), wagons: wagons[`launch.${z}#${i}`] || 1, tag: z });
  }
  const tagOn = (z, f) => (fleet === 'perFlow' ? f.id : z);
  for (const f of flows) {
    const a = zoneOf.get(f.from), b = zoneOf.get(f.to);
    const path = a === b ? [a] : [a, 'trunk', b];
    if (fleet === 'perFlow') for (const z of path) stations.push({ id: `launch.${f.id}@${z}`, type: 'launch', node: nodeOf.get(`${z}|launch.${f.id}`), wagons: wagons[`launch.${f.id}@${z}`] || 1, tag: f.id });
    const filt = (z) => (fleet === 'perFlow' ? { tag: { value: f.id } } : { tag: { value: z }, cargo: { items: [f.item], mode: 'or' } });
    stations.push({ id: `load.${f.id}`, type: 'loader', node: nodeOf.get(`${a}|load.${f.id}`), item: f.item, ratePerMin: f.ratePerMin, fullLoadsOnly: f.kind !== 'stock', filter: { tag: { value: tagOn(a, f) } } });
    for (let i = 0; i + 1 < path.length; i++) {
      stations.push({ id: `xfer.${f.id}.${i}`, type: 'transfer', inNode: nodeOf.get(`${path[i]}|xin.${f.id}.${i}`), outNode: nodeOf.get(`${path[i + 1]}|xout.${f.id}.${i}`), inFilter: filt(path[i]), outFilter: { tag: { value: tagOn(path[i + 1], f) } } });
    }
    stations.push({ id: `unload.${f.id}`, type: 'unloader', node: nodeOf.get(`${b}|unload.${f.id}`), consumePerMin: f.ratePerMin, chestCap: f.chestCap || 600, filter: filt(b) });
  }
  return { edges, stations, template: 'trunk-zones', fleet, loopsPerFloor: K, launchesPerLoop: L, zones: loops.size };
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

// ---- template: hub loops ----
// Each flow joins the loop of its busier endpoint (more flows touching it; ties go to the
// consumer). A hub's loop visits every counterparty module in floor order (ramps between floors)
// and returns to the hub. Fleets are per flow, so loaders never compete. Track is counted per
// loop; `sharedTrack` estimates what overlapping loops would share if laid on common rails.
function hubLoops(plan, fleet, wagons) {
  const geo = { ...DEFAULT_GEOMETRY, ...(plan.geometry || {}) };
  const flows = flowsOf(plan);
  const degree = new Map();
  for (const f of flows) { degree.set(f.from, (degree.get(f.from) || 0) + 1); degree.set(f.to, (degree.get(f.to) || 0) + 1); }
  const hubOf = (f) => ((degree.get(f.from) || 0) > (degree.get(f.to) || 0) ? f.from : f.to);
  const byHub = new Map();
  for (const f of flows) { const h = hubOf(f); if (!byHub.has(h)) byHub.set(h, []); byHub.get(h).push(f); }
  const edges = [], stations = [], loops = [];
  const legs = new Set();
  for (const [hub, hf] of byHub) {
    const hubFloor = modFloor(plan, hub);
    // counterparties in floor order, then id; each contributes its loader (if it produces) and its unloader (if it consumes)
    const others = [...new Set(hf.map((f) => (f.from === hub ? f.to : f.from)))].sort((a, b) => modFloor(plan, a) - modFloor(plan, b) || a.localeCompare(b));
    const pieces = [];
    const stops = [{ module: hub, keys: [] }, ...others.map((m) => ({ module: m, keys: [] }))];
    // hub side: launch + loader for flows the hub PRODUCES, unloader for flows it consumes
    for (const f of hf) {
      if (f.from === hub) stops[0].keys.push(`launch.${f.id}`, `load.${f.id}`);
    }
    for (const s of stops.slice(1)) for (const f of hf) {
      if (f.from === s.module) s.keys.push(`launch.${f.id}`, `load.${f.id}`);
      if (f.to === s.module) s.keys.push(`unload.${f.id}`);
    }
    // unloaders at the hub go LAST so a wagon loaded anywhere on the loop reaches them before docking
    for (const f of hf) if (f.to === hub) stops.push({ module: hub, keys: [`unload.${f.id}`] });
    let prevFloor = hubFloor;
    for (const s of stops) {
      const fl = modFloor(plan, s.module);
      for (const k of s.keys) pieces.push({ key: k, module: s.module });
      if (pieces.length && fl !== prevFloor) pieces[pieces.length - s.keys.length - 1 >= 0 ? pieces.length - s.keys.length - 1 : 0].rampAfter = Math.abs(fl - prevFloor);
      prevFloor = fl;
    }
    if (!pieces.length) continue;
    const nodes = ring(`H.${hub}`, pieces, geo, edges);
    // ramps: the closing edge climbs/descends back to the hub floor
    const ringEdges = edges.slice(-pieces.length);
    pieces.forEach((p, i) => { if (p.rampAfter) { ringEdges[i].ramp = true; ringEdges[i].length = geo.rampLength * p.rampAfter; } });
    const lastFloor = modFloor(plan, pieces[pieces.length - 1].module);
    if (lastFloor !== hubFloor) { ringEdges[ringEdges.length - 1].ramp = true; ringEdges[ringEdges.length - 1].length = geo.rampLength * Math.abs(lastFloor - hubFloor); }
    const at = (key) => nodes[pieces.findIndex((p) => p.key === key)];
    for (const f of hf) {
      stations.push({ id: `launch.${f.id}`, type: 'launch', node: at(`launch.${f.id}`), wagons: wagons[`launch.${f.id}`] || 1, tag: f.id });
      stations.push({ id: `load.${f.id}`, type: 'loader', node: at(`load.${f.id}`), item: f.item, ratePerMin: f.ratePerMin, fullLoadsOnly: f.kind !== 'stock', filter: { tag: { value: f.id } } });
      stations.push({ id: `unload.${f.id}`, type: 'unloader', node: at(`unload.${f.id}`), consumePerMin: f.ratePerMin, chestCap: f.chestCap || 600, filter: { tag: { value: f.id } } });
    }
    for (let i = 0; i < stops.length; i++) { const a = stops[i].module, b = stops[(i + 1) % stops.length].module; if (a !== b) legs.add([a, b].sort().join('|')); }
    loops.push({ hub, floor: hubFloor, flows: hf.map((f) => f.id), stops: stops.map((s) => s.module), track: ringEdges.reduce((a, e) => a + e.length, 0) });
  }
  return { edges, stations, template: 'hub-loops', fleet: 'perFlow', zones: loops.length, loops, sharedTrack: legs.size * (geo.stationSpacing * 3) };
}

// Human-readable build sheet for a sized hub-loops scenario.
function buildSheet(scenario, wagons) {
  if (!scenario.loops) return '(build sheet only for hub-loops)';
  const out = [];
  for (const L of scenario.loops) {
    const stops = L.stops.filter((m, i, a) => i === 0 || m !== a[i - 1]);
    out.push(`loop @ ${L.hub} (floor ${L.floor}), track ${L.track}, stops: ${stops.join(' → ')} → back`);
    for (const fid of L.flows) {
      const ld = scenario.stations.find((s) => s.id === `load.${fid}`);
      const ul = scenario.stations.find((s) => s.id === `unload.${fid}`);
      const w = wagons[`launch.${fid}`] || 1;
      out.push(`    ${fid.padEnd(44)} ${String(ld.ratePerMin).padStart(7)}/min  ${ld.fullLoadsOnly ? 'full ' : 'partial'} loads  wagons ${w}`);
    }
  }
  return out.join('\n');
}

const TEMPLATES = { 'single-loop': singleLoop, 'trunk-zones': trunkZones, shuttles, 'hub-loops': hubLoops };

// Grow fleets until no unloader starves more than `maxStarvedPct`, or a launch hits `maxWagons`.
function sizeFleets(plan, template, fleet, opts = {}) {
  const { minutes = 90, maxStarvedPct = 8, maxWagons = 12, params = {} } = opts;
  const maxRounds = opts.maxRounds || 40 + 8 * flowsOf(plan).length; // enough to size every fleet in a big plan
  const wagons = {};
  const partialFlips = new Set(); // freight flows switched to partial loads because full packs arrived too late
  let scenario, rep, rounds = 0;
  for (;;) {
    const p2 = partialFlips.size ? { ...plan, flows: flowsOf(plan).map((f) => (partialFlips.has(f.id) ? { ...f, kind: 'stock' } : f)) } : plan;
    scenario = TEMPLATES[template](p2, fleet, wagons);
    rep = simulate({ ...scenario, params: { ...(plan.params || {}), ...params } }, { minutes });
    const starved = Object.entries(rep.stations).filter(([, s]) => s.type === 'unloader' && s.starvedPct > maxStarvedPct).sort((x, y) => y[1].starvedPct - x[1].starvedPct);
    if (!starved.length || rounds++ > maxRounds) break;
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
    template: scenario.template, fleet: scenario.fleet, loops: scenario.zones || 1, launchesPerLoop: scenario.launchesPerLoop || 1,
    sharedTrack: scenario.sharedTrack ?? null,
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
  const combos = opts.combos || [['single-loop', 'perFlow'], ['hub-loops', 'perFlow'], ['trunk-zones', 'shared', { loopsPerFloor: 2 }], ['trunk-zones', 'perFlow', { loopsPerFloor: 2 }], ['shuttles', 'perFlow']];
  const out = [];
  for (const [template, fleet, variant] of combos) {
    const sized = sizeFleets({ ...plan, ...(variant || {}) }, template, fleet, opts);
    out.push({ ...score(sized.scenario, sized.report), wagonsByLaunch: sized.wagons, partialFlips: sized.partialFlips, scenario: sized.scenario, report: sized.report });
  }
  return out;
}

module.exports = { explore, sizeFleets, score, buildSheet, TEMPLATES, flowsOf };
