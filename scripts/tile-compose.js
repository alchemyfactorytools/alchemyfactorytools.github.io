#!/usr/bin/env node
'use strict';
// Canonical-tile COMPOSITION prototype (flows -> tiles -> DAG).
//
// Pipeline being prototyped:
//   1. flows   — use the existing composer for quantities (correct; LP-baked later).
//   2. tiles   — re-express the solved build as a DAG of CANONICAL unit-tiles: one tile per
//                produced item, each tile = that item's standalone canonical recipe step.
//   3. stamp   — a build needs ceil(total production of item / one tile's output) identical tiles.
//   4. belts   — inter-item flows (material / fuel / fert / cash) become belts between tiles.
//
// Demonstrates the three properties the redesign promises:
//   * IDENTITY  — an item's tile is byte-identical regardless of what build it's in.
//   * STAMP     — a build is N copies of identical tiles, not one re-sized chain.
//   * NESTING   — the build is a DAG of per-item tiles (endgame tile = many small tiles).
// Boundary policy (simple-first): leaves with no recipe are BOUGHT; everything else NESTS.
//
// Run: node scripts/tile-compose.js

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { solveComposerBody } = require(path.join(ROOT, 'src/composer-solve'));
const db = require(path.join(ROOT, 'data/alchemy_db.v41.json'));

const REF = { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 }; // 1:1 L0 reference
const cfg = () => ({
  cauldron: { enabled: true, inputPool: 'easy' }, byproducts: { mode: 'trash' },
  machines: { defaultCount: 1000 }, skills: REF, solver: 'composer',
  selfFuel: true, selfFert: true, steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 0, maxTier: 5,
});
const solve = (targets) => solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: cfg() }, db);
const ok = (o) => o && o.status === 'Optimal' && o.graph;
const kind = (e) => (e.heat ? 'fuel' : e.nutrient ? 'fert' : e.cash ? 'cash' : 'mat');

// ---- the canonical UNIT tile for an item: its standalone recipe step at the 1:1 L0 reference ----
const unitCache = new Map();
function unitTile(item) {
  if (unitCache.has(item)) return unitCache.get(item);
  const o = solve([{ item, rate: 60, rateMode: 'rate' }]);
  let tile = null;
  if (ok(o)) {
    const prods = o.graph.nodes.filter((n) => n.label === item && n.machine && n.machineCount);
    if (prods.length) {
      const machine = prods[0].machine;
      const count = prods.reduce((s, n) => s + n.machineCount, 0);
      const gross = prods.reduce((s, n) => s + (n.ratePerMin || 0), 0);
      // direct inputs this recipe step consumes (per the standalone unit), by kind
      const ids = new Set(prods.map((n) => n.id));
      const inputs = new Map(); // `${kind}\t${item}` -> rate
      for (const e of o.graph.edges) if (ids.has(e.to)) { const k = `${kind(e)}\t${e.item}`; inputs.set(k, (inputs.get(k) || 0) + (e.ratePerMin || 0)); }
      tile = { item, machine, count, gross, inputs };
    }
  }
  unitCache.set(item, tile);
  return tile;
}
const tileSig = (t) => (t ? `${t.count}× ${t.machine} → ${t.item} @ ${t.gross.toFixed(1)}/min` : '∅(bought/leaf)');

// ---- compose a build into a stamped tile-DAG ----
function composeBuild(targets) {
  const o = solve(targets);
  if (!ok(o)) return { error: o.status };
  // per-item gross production in THIS build, and the inter-item belts
  const byId = new Map(o.graph.nodes.map((n) => [n.id, n]));
  const grossOf = new Map();   // item -> total gross/min produced in this build
  const actualMach = new Map(); // item -> machine count the composer actually used
  for (const n of o.graph.nodes) if (n.machine && n.machineCount) {
    grossOf.set(n.label, (grossOf.get(n.label) || 0) + (n.ratePerMin || 0));
    actualMach.set(n.label, (actualMach.get(n.label) || 0) + n.machineCount);
  }
  const belts = new Map(); // `${fromItem}\t${toItem}\t${kind}\t${item}` -> rate
  for (const e of o.graph.edges) {
    const from = (byId.get(e.from) || {}).label, to = (byId.get(e.to) || {}).label;
    if (!from || !to || from === to) continue;
    const key = `${from}\t${to}\t${kind(e)}\t${e.item}`;
    belts.set(key, (belts.get(key) || 0) + (e.ratePerMin || 0));
  }
  // stamp counts from the canonical unit tiles
  const tiles = [];
  for (const [item, gross] of [...grossOf].sort((a, b) => b[1] - a[1])) {
    const unit = unitTile(item);
    if (!unit) { tiles.push({ item, bought: false, unit: null, n: 0, gross }); continue; }
    const n = Math.max(1, Math.ceil(gross / unit.gross - 1e-9));
    tiles.push({ item, unit, n, gross, stampMach: n * unit.count, actualMach: actualMach.get(item) || 0 });
  }
  return { o, tiles, belts, grossOf };
}

// ---------- demo ----------
function renderBuild(name, targets) {
  console.log(`\n# Build: ${name}  [${targets.map((t) => `${t.item}@${t.rate}${t.rateMode === 'machines' ? 'm' : ''}`).join(' + ')}]`);
  const b = composeBuild(targets);
  if (b.error) { console.log('  solve failed:', b.error); return b; }
  console.log('  TILES (stamp × canonical unit):');
  for (const t of b.tiles) {
    if (!t.unit) { console.log(`    (raw) ${t.item} — bought ${t.gross.toFixed(1)}/min`); continue; }
    const over = t.stampMach - t.actualMach;
    console.log(`    ${String(t.n).padStart(2)}× [${tileSig(t.unit)}]  build needs ${t.gross.toFixed(1)}/min  →  ${t.stampMach} machines (exact-fit ${t.actualMach}${over > 0 ? `, +${over} from whole-tile stamping` : ''})`);
  }
  console.log('  BELTS (inter-tile):');
  for (const [k, rate] of [...b.belts].sort((a, b2) => b2[1] - a[1]).slice(0, 12)) {
    const [from, to, kd, item] = k.split('\t');
    console.log(`    ${from} →${kd === 'mat' ? '' : '[' + kd + ']'} ${to}: ${item} ${rate.toFixed(1)}/min`);
  }
  return b;
}

console.log('Canonical unit tile for a few items (1:1 L0 reference):');
for (const it of ['Advanced Fertilizer', 'Quicklime', 'Gloom Fungus', 'Bandage']) console.log(`  ${it}: ${tileSig(unitTile(it))}`);

const standalone = renderBuild('Advanced Fertilizer only', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }]);
const paired = renderBuild('Advanced Fertilizer + Bandage', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]);

// ---------- IDENTITY proof: AdvFert's tile is the same object in both builds ----------
console.log('\n# IDENTITY — is the Advanced Fertilizer tile the same in both builds?');
const af = (b) => (b.tiles || []).find((t) => t.item === 'Advanced Fertilizer');
const a = af(standalone), p = af(paired);
console.log(`  standalone unit: ${tileSig(a.unit)}   (stamped ${a.n}×)`);
console.log(`  paired     unit: ${tileSig(p.unit)}   (stamped ${p.n}×)`);
console.log(`  TILE IDENTICAL? ${tileSig(a.unit) === tileSig(p.unit)}  — stamp count differs (${a.n} vs ${p.n}) because Bandage also draws Advanced Fertilizer as fert.`);
