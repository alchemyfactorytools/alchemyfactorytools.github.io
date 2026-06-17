#!/usr/bin/env node
'use strict';
// Canonical-tile COMPOSITION prototype (flows -> tiles -> stamped DAG), with a tile-SIZE mode.
//
// Pipeline:
//   1. flows   — use the existing composer for quantities (correct; LP-baked later).
//   2. tiles   — re-express the build as a DAG of canonical unit-tiles, one per produced item.
//   3. stamp   — stamp ceil(build production / one tile's output) identical tiles.
//   4. belts   — inter-item flows (material/fuel/fert/cash) become belts between tiles.
//
// TILE-SIZE MODE (both supported):
//   'machine' — one terminal machine + its belt taps. Minimal/modular, ~exact-fit, many small tiles.
//   'belt'    — terminal machines sized to fill one belt. Fewer, denser tiles; over-builds low demand.
// A tile's output is sized from the SATURATED single-machine rate (recipe throughput × speedMult),
// not the demand-throttled average, so the unit is a true buildable blueprint.
//
// Properties shown: IDENTITY (an item's tile is the same across builds & sizes deterministically),
// STAMP, NESTING (build = DAG of per-item tiles). Boundary policy: leaves with no recipe are BOUGHT.
//
// Run: node scripts/tile-compose.js

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { solveComposerBody } = require(path.join(ROOT, 'src/composer-solve'));
const { beltSpeed } = require(path.join(ROOT, 'src/config'));
const db = require(path.join(ROOT, 'data/alchemy_db.v41.json'));

const REF = { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 }; // 1:1 L0 reference
const BELT = beltSpeed(0); // 60/min at the reference
const cfg = () => ({
  cauldron: { enabled: true, inputPool: 'easy' }, byproducts: { mode: 'trash' },
  machines: { defaultCount: 1000 }, skills: REF, solver: 'composer',
  selfFuel: true, selfFert: true, steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 0, maxTier: 5,
});
const solve = (targets) => solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: cfg() }, db);
const ok = (o) => o && o.status === 'Optimal' && o.graph;
const loadOf = (n) => (n.utilization != null ? n.machineCount * n.utilization : (n.tileLoad != null ? n.tileLoad : n.machineCount));

// saturated single-machine output of an item's terminal step (from its standalone solve)
const perMachCache = new Map();
function perMachine(item) {
  if (perMachCache.has(item)) return perMachCache.get(item);
  const o = solve([{ item, rate: 60, rateMode: 'rate' }]);
  let pm = null, machine = null;
  if (ok(o)) {
    const prods = o.graph.nodes.filter((n) => n.label === item && n.machine && n.machineCount);
    if (prods.length) {
      machine = prods[0].machine;
      const gross = prods.reduce((s, n) => s + (n.ratePerMin || 0), 0);
      const load = prods.reduce((s, n) => s + loadOf(n), 0);
      pm = load > 1e-9 ? gross / load : null;
    }
  }
  const res = pm ? { machine, perMachine: pm } : null;
  perMachCache.set(item, res);
  return res;
}
// the canonical unit tile for an item at a given size mode
function unitTile(item, mode) {
  const pm = perMachine(item);
  if (!pm) return null;
  const count = mode === 'belt' ? Math.max(1, Math.ceil(BELT / pm.perMachine - 1e-9)) : 1;
  const out = mode === 'belt' ? Math.min(count * pm.perMachine, BELT) : pm.perMachine;
  return { item, machine: pm.machine, count, out };
}
const tileSig = (t) => (t ? `${t.count}× ${t.machine} → ${t.item} @ ${t.out.toFixed(1)}/min` : '∅(bought)');

function composeBuild(targets, mode) {
  const o = solve(targets);
  if (!ok(o)) return { error: o.status };
  const grossOf = new Map();
  for (const n of o.graph.nodes) if (n.machine && n.machineCount) grossOf.set(n.label, (grossOf.get(n.label) || 0) + (n.ratePerMin || 0));
  const tiles = [];
  let totMach = 0;
  for (const [item, gross] of [...grossOf].sort((a, b) => b[1] - a[1])) {
    const unit = unitTile(item, mode);
    if (!unit) { tiles.push({ item, unit: null, gross }); continue; }
    const n = Math.max(1, Math.ceil(gross / unit.out - 1e-9));
    const mach = n * unit.count;
    totMach += mach;
    tiles.push({ item, unit, n, gross, mach });
  }
  return { tiles, totMach };
}

function render(name, targets) {
  console.log(`\n# Build: ${name}`);
  for (const mode of ['machine', 'belt']) {
    const b = composeBuild(targets, mode);
    if (b.error) { console.log(`  [${mode}] solve failed: ${b.error}`); continue; }
    const ntiles = b.tiles.filter((t) => t.unit).reduce((s, t) => s + t.n, 0);
    console.log(`  mode=${mode}:  ${ntiles} tiles, ${b.totMach} terminal machines`);
    for (const t of b.tiles) {
      if (!t.unit) { console.log(`      (raw) ${t.item}: buy ${t.gross.toFixed(1)}/min`); continue; }
      console.log(`      ${String(t.n).padStart(3)}× [${tileSig(t.unit)}]   build needs ${t.gross.toFixed(1)}/min → ${t.mach} machines`);
    }
  }
}

console.log(`reference belt = ${BELT}/min\n`);
render('Advanced Fertilizer @60', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
render('Advanced Fertilizer @60 + Bandage @2 machines', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);

// ---- IDENTITY across builds AND modes ----
console.log('\n# IDENTITY — Advanced Fertilizer tile, standalone vs paired, per size mode');
for (const mode of ['machine', 'belt']) {
  const s = unitTile('Advanced Fertilizer', mode); // canonical unit is build-independent by construction
  console.log(`  mode=${mode}: ${tileSig(s)}  — same unit in every build; only the stamp count changes`);
}
