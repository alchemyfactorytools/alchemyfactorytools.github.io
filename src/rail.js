// Wagon rail simulator (game 1.0 Wagon System).
//
// A fixed-tick discrete simulation of tracks, wagons and the five station kinds, with the
// filter semantics of the in-game panels. Use it to size loops, wagon counts, buffers and
// "full loads only" before laying track. Rates come from the composer or are given directly.
//
// Semantics encoded (measured in-game 2026-09-14 unless marked assumed):
//   - a wagon carries ONE pack of ≤ packSize (100) items of one kind;
//   - a Launch Station owns its wagons (only its own dock there), stamps tag + color, and
//     releases one wagon per launchCycleSec (assumed: continuous release while a wagon is docked);
//   - a Loader packs its belt input into ≤ loaderPacks packs and loads EMPTY passing wagons that
//     match its filter (no top-up); fullLoadsOnly waits for a 100-item pack, else ships what it has;
//   - an Unloader takes the pack off a matching wagon into a chest drained at consumePerMin;
//     a full chest lets the wagon pass (skip);
//   - a Transfer Station is an unloader on one loop feeding a loader on another;
//   - a Sorter sends matching wagons down `branch`, others straight on, and WAITS if the chosen
//     segment is full (assumed);
//   - dwell is dwellSec per pack moved; segments hold floor(length / wagonLength) wagons, no
//     overtaking; ramps multiply speed by rampSpeedFactor. Wagon speed is a placeholder until measured.
//
// Filters: { cargo: { items, mode: 'and'|'or', not }, color: { colors, mode, not }, tag: { value, not } }.
// Enabled sections must all pass. Tag match is exact, or prefix when params.tagMatch === 'prefix'.

'use strict';

const DEFAULT_PARAMS = {
  wagonSpeed: 4,        // track units per second — PLACEHOLDER, measure in-game
  rampSpeedFactor: 0.5, // ASSUMED slope penalty
  wagonLength: 2,       // track units a wagon occupies (spacing)
  launchCycleSec: 10,   // measured: one wagon per 10 s per Launch Station
  dwellSec: 2,          // measured: a second or two per pack on/off
  packSize: 100,        // measured: 100 items per wagon
  loaderPacks: 4,       // measured: a loader holds up to 4 packs
  transferPacks: 4,     // assumed: same buffer as a loader
  tagMatch: 'exact',    // 'exact' | 'prefix' — unverified in-game, test once
  tick: 0.25,           // seconds per simulation step
  warmupMin: 10,        // starvation/blocked stats ignore this priming period (first laps, empty chests)
};

function matchFilter(filter, wagon, params) {
  if (!filter) return true;
  const { cargo, color, tag } = filter;
  if (cargo && cargo.items) {
    const has = (it) => wagon.cargo && wagon.cargo.item === it && wagon.cargo.qty > 0;
    let ok = cargo.mode === 'and' ? cargo.items.every(has) : cargo.items.some(has);
    if (cargo.not) ok = !ok;
    if (!ok) return false;
  }
  if (color && color.colors) {
    let ok = color.colors.includes(wagon.color);
    if (color.not) ok = !ok;
    if (!ok) return false;
  }
  if (tag && tag.value != null) {
    const v = String(tag.value);
    let ok = params.tagMatch === 'prefix' ? String(wagon.tag || '').startsWith(v) : wagon.tag === v;
    if (tag.not) ok = !ok;
    if (!ok) return false;
  }
  return true;
}

function simulate(scenario, opts = {}) {
  const P = { ...DEFAULT_PARAMS, ...(scenario.params || {}), ...(opts.params || {}) };
  const minutes = opts.minutes ?? scenario.minutes ?? 60;
  const dt = P.tick;
  const steps = Math.round((minutes * 60) / dt);

  // --- graph ---
  const edges = scenario.edges.map((e, i) => ({ id: i, from: e.from, to: e.to, length: e.length, ramp: !!e.ramp, wagons: [] }));
  const outOf = new Map();
  for (const e of edges) { if (!outOf.has(e.from)) outOf.set(e.from, []); outOf.get(e.from).push(e); }
  const edgeTo = (from, to) => (outOf.get(from) || []).find((e) => e.to === to);
  const capacity = (e) => Math.max(1, Math.floor(e.length / P.wagonLength));

  // --- stations ---
  const byNode = new Map(); // node → station (one station per node; transfer uses two nodes)
  const stations = [];
  for (const s of scenario.stations) {
    const st = { ...s, stats: {} };
    stations.push(st);
    if (s.type === 'transfer') {
      byNode.set(s.inNode, { ...st, role: 'transferIn' });
      byNode.set(s.outNode, { ...st, role: 'transferOut' });
      st.packs = [];
    } else byNode.set(s.node, st);
    if (s.type === 'loader') { st.packs = []; st.partial = 0; st.stats = { loaded: 0, packs: 0, blockedSec: 0, itemsIn: 0 }; }
    if (s.type === 'unloader') { st.chest = 0; st.stats = { delivered: 0, packs: 0, starvedSec: 0, skipped: 0, chestMax: 0 }; }
    if (s.type === 'transfer') { st.stats = { packsIn: 0, packsOut: 0, skipped: 0 }; }
    if (s.type === 'sorter') { st.stats = { branched: 0, passed: 0, waitSec: 0 }; }
    if (s.type === 'launch') { st.docked = []; st.sinceLaunch = P.launchCycleSec; st.stats = { launches: 0, returns: 0 }; }
  }
  // stations that share a node with a transfer (loader/unloader semantics reused)
  const transferStation = (st) => stations.find((x) => x.id === st.id);

  // --- wagons ---
  const wagons = [];
  for (const st of stations.filter((s) => s.type === 'launch')) {
    for (let i = 0; i < (st.wagons || 1); i++) {
      const w = { id: `${st.id}#${i}`, home: st.id, tag: st.tag ?? null, color: st.color ?? null, cargo: null, edge: null, pos: 0, wait: 0, loadedSec: 0, trips: 0, lapStart: 0, laps: [] };
      wagons.push(w);
      st.docked.push(w);
    }
  }

  const items = (w) => (w.cargo ? w.cargo.qty : 0);
  let t = 0;

  // enter an edge if there's room; wagons are appended in order (no overtaking)
  const tryEnter = (w, e) => {
    if (e.wagons.length >= capacity(e)) return false;
    const last = e.wagons[e.wagons.length - 1];
    if (last && last.pos < P.wagonLength) return false;
    e.wagons.push(w); w.edge = e; w.pos = 0; return true;
  };

  // node handling when a wagon reaches the end of its edge. Returns the edge to enter, or null to hold.
  function atNode(w, node) {
    const st = byNode.get(node);
    const outs = outOf.get(node) || [];
    if (!st) return outs[0] || null;
    if (w.wait > 0) { w.wait -= dt; return null; }
    if (st.type === 'launch') {
      if (w.home === st.id) { // dock: leave the track
        w.edge.wagons.shift(); w.edge = null; st.docked.push(w); st.stats.returns++;
        if (w.lapStart != null) w.laps.push(t - w.lapStart);
        return 'docked';
      }
      return outs[0] || null;
    }
    if (st.type === 'loader' && !w.cargo && matchFilter(st.filter, w, P)) {
      const pack = takePack(st);
      if (pack) { w.cargo = pack; w.wait = P.dwellSec; st.stats.loaded += pack.qty; st.stats.packs++; w.trips++; return null; }
    }
    if (st.type === 'unloader' && w.cargo && matchFilter(st.filter, w, P)) {
      if (st.chest + w.cargo.qty <= (st.chest_cap ?? st.chestCap ?? Infinity)) {
        st.chest += w.cargo.qty; st.stats.delivered += w.cargo.qty; st.stats.packs++; st.stats.chestMax = Math.max(st.stats.chestMax, st.chest);
        w.cargo = null; w.wait = P.dwellSec; return null;
      }
      st.stats.skipped++;
    }
    if (st.role === 'transferIn' && w.cargo && matchFilter(st.inFilter, w, P)) {
      const T = transferStation(st);
      if (T.packs.length < P.transferPacks) { T.packs.push(w.cargo); w.cargo = null; w.wait = P.dwellSec; T.stats.packsIn++; return null; }
      T.stats.skipped++;
    }
    if (st.role === 'transferOut' && !w.cargo && matchFilter(st.outFilter, w, P)) {
      const T = transferStation(st);
      if (T.packs.length) { w.cargo = T.packs.shift(); w.wait = P.dwellSec; T.stats.packsOut++; w.trips++; return null; }
    }
    if (st.type === 'sorter') {
      const branch = edgeTo(node, st.branch);
      const straight = outs.find((e) => e !== branch) || branch;
      const chosen = matchFilter(st.filter, w, P) ? branch : straight;
      if (chosen === branch) st.stats.branched++; else st.stats.passed++;
      return chosen;
    }
    return outs[0] || null;
  }

  function takePack(st) {
    if (st.packs.length) return st.packs.shift();
    if (!st.fullLoadsOnly && st.partial >= 1) { const qty = Math.floor(st.partial); st.partial -= qty; return { item: st.item, qty }; }
    return null;
  }

  for (let step = 0; step < steps; step++, t += dt) {
    // production into loaders; consumption out of unloader chests
    for (const st of stations) {
      if (st.type === 'loader') {
        const full = st.packs.length >= P.loaderPacks;
        if (full) { if (t >= P.warmupMin * 60) st.stats.blockedSec += dt; }
        else {
          st.partial += (st.ratePerMin / 60) * dt; st.stats.itemsIn += (st.ratePerMin / 60) * dt;
          while (st.partial >= P.packSize && st.packs.length < P.loaderPacks) { st.packs.push({ item: st.item, qty: P.packSize }); st.partial -= P.packSize; }
        }
      }
      if (st.type === 'unloader') {
        const want = (st.consumePerMin / 60) * dt;
        if (st.chest >= want) st.chest -= want; else { st.chest = 0; if (t >= P.warmupMin * 60) st.stats.starvedSec += dt; }
      }
      if (st.type === 'launch') {
        st.sinceLaunch += dt;
        if (st.docked.length && st.sinceLaunch >= P.launchCycleSec) {
          const e = (outOf.get(st.node) || [])[0];
          const w = st.docked[0];
          if (e && tryEnter(w, e)) { st.docked.shift(); st.sinceLaunch = 0; st.stats.launches++; w.lapStart = t; }
        }
      }
    }
    // move wagons, edge by edge, front wagon first so followers see updated positions
    for (const e of edges) {
      const speed = P.wagonSpeed * (e.ramp ? P.rampSpeedFactor : 1);
      for (let i = 0; i < e.wagons.length; i++) {
        const w = e.wagons[i];
        if (w.cargo) w.loadedSec += dt;
        const ahead = i > 0 ? e.wagons[i - 1].pos - P.wagonLength : Infinity;
        if (w.pos >= e.length) {
          // at the node: station logic, then try to enter the next edge
          const next = atNode(w, e.to);
          if (next === 'docked') { i--; continue; }
          if (next && tryEnter(w, next)) { e.wagons.splice(i, 1); i--; }
          else if (next) { const st = byNode.get(e.to); if (st && st.type === 'sorter') st.stats.waitSec += dt; }
          continue;
        }
        w.pos = Math.min(e.length, ahead, w.pos + speed * dt);
      }
    }
  }

  // --- report ---
  const rep = { minutes, params: P, stations: {}, wagons: {}, loops: {} };
  for (const st of stations) {
    const s = { type: st.type, ...st.stats };
    const measured = Math.max(1, minutes - Math.min(P.warmupMin, minutes)) * 60; // seconds after warm-up
    if (st.type === 'loader') { s.shippedPerMin = +(st.stats.loaded / minutes).toFixed(2); s.inputPerMin = st.ratePerMin; s.bufferedNow = st.packs.length * P.packSize + Math.floor(st.partial); s.blockedPct = +((st.stats.blockedSec / measured) * 100).toFixed(1); }
    if (st.type === 'unloader') { s.deliveredPerMin = +(st.stats.delivered / minutes).toFixed(2); s.demandPerMin = st.consumePerMin; s.starvedPct = +((st.stats.starvedSec / measured) * 100).toFixed(1); s.chestNow = Math.round(st.chest); }
    if (st.type === 'launch') { s.docked = st.docked.length; s.wagons = st.wagons; }
    rep.stations[st.id] = s;
  }
  for (const w of wagons) {
    const laps = w.laps;
    rep.wagons[w.id] = { trips: w.trips, loadedPct: +((w.loadedSec / (minutes * 60)) * 100).toFixed(1), laps: laps.length, avgLapSec: laps.length ? +(laps.reduce((a, b) => a + b, 0) / laps.length).toFixed(1) : null, state: w.edge ? (w.cargo ? 'loaded' : 'empty') : 'docked' };
  }
  return rep;
}

function formatReport(rep) {
  const out = [`rail sim: ${rep.minutes} min (stats after ${rep.params.warmupMin} min warm-up), wagon speed ${rep.params.wagonSpeed} u/s (placeholder), tick ${rep.params.tick}s`];
  out.push('stations:');
  for (const [id, s] of Object.entries(rep.stations)) {
    if (s.type === 'loader') out.push(`  ${id.padEnd(14)} loader    in ${String(s.inputPerMin).padStart(6)}/min  shipped ${String(s.shippedPerMin).padStart(7)}/min  packs ${String(s.packs).padStart(4)}  blocked ${s.blockedPct}%  buffered ${s.bufferedNow}`);
    else if (s.type === 'unloader') out.push(`  ${id.padEnd(14)} unloader  need ${String(s.demandPerMin).padStart(5)}/min  got ${String(s.deliveredPerMin).padStart(7)}/min  packs ${String(s.packs).padStart(4)}  starved ${s.starvedPct}%  skipped ${s.skipped}  chest max ${s.chestMax}`);
    else if (s.type === 'launch') out.push(`  ${id.padEnd(14)} launch    wagons ${s.wagons}  launches ${s.launches}  returns ${s.returns}  docked now ${s.docked}`);
    else if (s.type === 'sorter') out.push(`  ${id.padEnd(14)} sorter    branched ${s.branched}  passed ${s.passed}  waited ${s.waitSec.toFixed(0)}s`);
    else if (s.type === 'transfer') out.push(`  ${id.padEnd(14)} transfer  packs in ${s.packsIn}  out ${s.packsOut}  skipped ${s.skipped}`);
  }
  out.push('wagons:');
  for (const [id, w] of Object.entries(rep.wagons)) out.push(`  ${id.padEnd(14)} trips ${String(w.trips).padStart(4)}  loaded ${String(w.loadedPct).padStart(5)}%  laps ${w.laps}  avg lap ${w.avgLapSec ?? '-'}s  now ${w.state}`);
  return out.join('\n');
}

module.exports = { simulate, formatReport, matchFilter, DEFAULT_PARAMS };
