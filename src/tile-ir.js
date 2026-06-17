'use strict';
// Tile-DAG intermediate representation (IR) — the SINGLE handoff between the solver and the renderer.
//
// The solver owns ALL semantics (which tiles exist, their machine counts, what connects to what).
// The renderer owns ONLY geometry (where to draw). The IR is the contract between them. Once the IR
// is produced, NOTHING downstream re-derives structure — that is the whole point: the picture cannot
// contradict the flows because it is drawn from the flows, not re-inferred from topology.
//
// LEVEL 1 producer (`graphToIR`): preserve the composer's structure VERBATIM. One tile per
// recipe-step node, belts straight from edges, group = the node's tree-path root (the line/target it
// already belongs to). No clustering heuristics, no count re-computation — counts come from the
// composer's node.machineCount unchanged. (Level 2 will swap this producer for the canonical
// stamped-tile composer; the renderer and this contract do not change.)
//
// IR shape:
//   {
//     tiles: [ { id, item, machine, count, out, group } ],   // one per recipe step; count authoritative
//     ports: [ { id, item, role, group } ],                  // non-tile belt ends: buys, demand, waste, belt
//     belts: [ { from, to, item, rate, kind } ]              // kind: material | fuel | fert | cash
//   }

const isProcess = (n) => !!(n.machine && n.machineCount);
const isSupplyBelt = (n) => n.kind === 'belt';

// The LINE (top-level group) a node belongs to — the composer's own grouping, read straight from the
// hierarchical node id ("Advanced Fertilizer#fert>Basic Fertilizer>..." -> "Advanced Fertilizer").
// Supply belts are their own 'supply' band; demand sinks inherit their target's line.
function lineOf(n) {
  if (isSupplyBelt(n)) return 'supply';
  const stripped = String(n.id).replace(/^(trash|surplus|demand|resource):/, '');
  const root = stripped.split('>')[0].replace(/#.*/, '').replace(/:.*$/, '');
  return root || n.label || 'misc';
}

// The material-tree PARENT id of a node, taken from the composer's id structure (the composer builds
// a pure tree; the id encodes the lineage). Buys are tree leaves; trash hangs off its producer.
// Supply belts and demand sinks have no tree parent (placed in their own bands). Returns null at a
// line root. Only returns an id that actually exists, so the renderer can trust the link.
function parentOf(id, idSet) {
  if (/^(trash|surplus):/.test(id)) {
    const body = id.replace(/^(trash|surplus):/, '');
    const p = body.slice(0, body.lastIndexOf(':'));
    return idSet.has(p) ? p : null;
  }
  if (/^(demand|resource):/.test(id)) return null;
  const i = id.lastIndexOf('>');
  if (i < 0) return null;
  const p = id.slice(0, i);
  return idSet.has(p) ? p : null;
}

const beltKind = (e) => (e.heat ? 'fuel' : e.nutrient ? 'fert' : e.cash ? 'cash' : 'material');

// Level-1 producer: composer graph -> IR, structure preserved verbatim. Tiles are recipe steps;
// ports are buys / demand sinks / supply belts / waste. `line` + `parent` carry the composer's tree
// so the renderer can pack it recursively without re-deriving anything.
function graphToIR(graph) {
  const idSet = new Set(graph.nodes.map((n) => n.id));
  const tiles = [];
  const ports = [];
  for (const n of graph.nodes) {
    const common = { id: n.id, item: n.label, line: lineOf(n), parent: parentOf(n.id, idSet) };
    if (isProcess(n)) {
      tiles.push({
        ...common, machine: n.machine, count: n.machineCount, out: n.ratePerMin || 0,
        // display detail carried straight from the solver (no re-derivation) so the renderer can
        // match the original look: utilization, the fuel/furnace/fert bands, and recirculation.
        utilization: n.utilization, fuelItem: n.fuelItem, fuelPerMin: n.fuelPerMin,
        fertItem: n.fertItem, fertPerMin: n.fertPerMin, furnaces: n.furnaces, furnaceItem: n.furnaceItem,
        heatPerMin: n.heatPerMin, nutrientPerMin: n.nutrientPerMin, recirc: n.recirc, badges: n.badges,
      });
    } else {
      ports.push({
        ...common, role: isSupplyBelt(n) ? 'belt' : (n.type || n.kind || 'node'),
        rate: n.ratePerMin || 0, cost: n.copperPerMin, supplyRate: n.supplyRate, beltLanes: n.beltLanes, beltSpeed: n.beltSpeed,
      });
    }
  }
  const belts = [];
  for (const e of graph.edges) {
    if (e.from === e.to) continue;
    belts.push({ from: e.from, to: e.to, item: e.item, rate: e.ratePerMin || 0, kind: beltKind(e) });
  }
  return { tiles, ports, belts };
}

// Structural validator. Returns a list of problem strings (empty = valid). The renderer should be
// able to assume a valid IR; failures here mean the producer (not the renderer) is wrong.
function validateIR(ir) {
  const errs = [];
  if (!ir || !Array.isArray(ir.tiles) || !Array.isArray(ir.belts) || !Array.isArray(ir.ports)) {
    return ['IR missing tiles/ports/belts arrays'];
  }
  const ids = new Set();
  for (const t of ir.tiles) {
    if (ids.has(t.id)) errs.push(`duplicate tile id ${t.id}`);
    ids.add(t.id);
    if (!Number.isInteger(t.count) || t.count < 1) errs.push(`tile ${t.id} has non-integer/zero count ${t.count}`);
  }
  for (const p of ir.ports) { if (ids.has(p.id)) errs.push(`port id collides with tile ${p.id}`); ids.add(p.id); }
  for (const b of ir.belts) {
    if (!ids.has(b.from)) errs.push(`belt references unknown from-node ${b.from}`);
    if (!ids.has(b.to)) errs.push(`belt references unknown to-node ${b.to}`);
    if (!(b.rate >= 0)) errs.push(`belt ${b.from}->${b.to} has bad rate ${b.rate}`);
  }
  return errs;
}

// Faithfulness check: per-machine totals derived from the IR's tiles. Must equal the solver's
// summary.machineTotals exactly — the proof that the IR carries the solve's counts, not a re-guess.
function machineTotalsFromIR(ir) {
  const totals = {};
  for (const t of ir.tiles) totals[t.machine] = (totals[t.machine] || 0) + t.count;
  return totals;
}

module.exports = { graphToIR, validateIR, machineTotalsFromIR, lineOf };
