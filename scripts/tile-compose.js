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
// TILE-SIZE MODE:
//   'machine' — one terminal machine + its belt taps. Minimal/modular, ~exact-fit, many small tiles.
//   'belt'    — terminal machines sized to fill one belt. Fewer, denser tiles; over-builds low demand.
//   'hybrid'  — whole belt-tiles for the bulk + machine-tiles for the leftover remainder. "Belt for
//               the high-demand backbone, machine for the low-demand tail" — gets ~exact-fit machine
//               counts AND consolidated belt blueprints. Both unit sizes are canonical, so identity
//               still holds; an item just renders as N belt-tiles + R machine-tiles.
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

// Canonical-unit + stamp logic now lives in src/tile-compose-ir.js (one home, unit-tested). This
// prototype just drives it for human-readable property output. makeProfiler wants a (body)->result
// solver; stampsFor/unitTile take (…, profile, BELT).
const { makeProfiler, unitTile: unitTileFn, stampsFor: stampsForFn } = require(path.join(ROOT, 'src/tile-compose-ir'));
const profile = makeProfiler((body) => solveComposerBody(body, db), cfg());
const unitTile = (item, mode) => unitTileFn(item, mode, profile, BELT);
const stampsFor = (item, gross, mode) => stampsForFn(item, gross, mode, profile, BELT);
const tileSig = (t) => (t ? `${t.count}× ${t.machine} → ${t.item} @ ${t.out.toFixed(1)}/min` : '∅(bought)');

function composeBuild(targets, mode) {
  const o = solve(targets);
  if (!ok(o)) return { error: o.status };
  const grossOf = new Map();
  for (const n of o.graph.nodes) if (n.machine && n.machineCount) grossOf.set(n.label, (grossOf.get(n.label) || 0) + (n.ratePerMin || 0));
  const items = [];
  let totMach = 0, totTiles = 0;
  for (const [item, gross] of [...grossOf].sort((a, b) => b[1] - a[1])) {
    const stamps = stampsFor(item, gross, mode);
    if (!stamps) { items.push({ item, gross, raw: true }); continue; }
    const mach = stamps.reduce((s, st) => s + st.n * st.unit.count, 0);
    totMach += mach; totTiles += stamps.reduce((s, st) => s + st.n, 0);
    items.push({ item, gross, stamps, mach });
  }
  return { items, totMach, totTiles };
}

function render(name, targets) {
  console.log(`\n# Build: ${name}`);
  console.log('  mode'.padEnd(12) + 'tiles   machines');
  for (const mode of ['machine', 'belt', 'hybrid']) {
    const b = composeBuild(targets, mode);
    if (b.error) { console.log(`  [${mode}] solve failed: ${b.error}`); continue; }
    console.log('  ' + mode.padEnd(10) + String(b.totTiles).padEnd(8) + b.totMach);
  }
  // full per-item breakdown for HYBRID (the new mode)
  console.log('  hybrid breakdown:');
  const h = composeBuild(targets, 'hybrid');
  for (const it of h.items) {
    if (it.raw) { console.log(`      (raw) ${it.item}: buy ${it.gross.toFixed(1)}/min`); continue; }
    const parts = it.stamps.map((st) => `${st.n}× [${tileSig(st.unit)}]`).join('  +  ');
    console.log(`      ${it.item} (needs ${it.gross.toFixed(1)}/min → ${it.mach} machines): ${parts}`);
  }
}

console.log(`reference belt = ${BELT}/min\n`);
render('Advanced Fertilizer @60', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
render('Advanced Fertilizer @60 + Bandage @2 machines', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);

// ---- IDENTITY across builds AND modes ----
console.log('\n# IDENTITY — Advanced Fertilizer canonical units (build-independent)');
console.log(`  belt unit:    ${tileSig(unitTile('Advanced Fertilizer', 'belt'))}`);
console.log(`  machine unit: ${tileSig(unitTile('Advanced Fertilizer', 'machine'))}`);
console.log('  hybrid composes from exactly these two units, so identity holds; only the mix/stamp changes.');
