#!/usr/bin/env node
'use strict';
// Canonical-tile spike. Tests the thesis from the redesign discussion:
//   (A) a tile for item X is context-independent — the Advanced Fertilizer tile is the SAME
//       whether solved standalone or as the fertilizer feeding a Bandage build;
//   (B) what skill points actually do to a tile — which parts are invariant (recipe picks /
//       topology) vs which rescale (machine counts, belts, self-loop gross), and the
//       factory/logistics lockstep that keeps a tile's shape stable.
// This is a throwaway probe, not production code. Run: node scripts/tile-spike.js

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { solveComposerBody } = require(path.join(ROOT, 'src/composer-solve'));
const { beltSpeed, speedMult } = require(path.join(ROOT, 'src/config'));
const db = require(path.join(ROOT, 'data/alchemy_db.v41.json'));

const ZERO = { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 };
const baseCfg = (skills, byproducts = 'trash') => ({
  cauldron: { enabled: true, inputPool: 'easy' },
  byproducts: { mode: byproducts },
  machines: { defaultCount: 1000 },
  skills,
  solver: 'composer',
  selfFuel: true, selfFert: true,
  steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }],
  capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 0, maxTier: 5,
});

function solve(targets, skills, byproducts) {
  const body = { item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: baseCfg(skills, byproducts) };
  return solveComposerBody(body, db);
}

// Extract item X's production sub-tile from a solved graph: the top producer of X plus its
// descendants (hierarchical ids: root, or root + '>' + ...). Returns topology + sizing.
function extractTile(out, item) {
  if (!out || out.status !== 'Optimal' || !out.graph) return null;
  const roots = out.graph.nodes.filter((n) => n.label === item && n.machine);
  if (!roots.length) return null;
  roots.sort((a, b) => a.id.length - b.id.length);
  const prefix = roots[0].id;
  const inTile = (id) => id === prefix || id.startsWith(prefix + '>');
  const nodes = out.graph.nodes.filter((n) => inTile(n.id) && n.machine && n.machineCount);
  const rows = nodes.map((n) => ({ machine: n.machine, label: n.label, count: n.machineCount, rate: Math.round((n.ratePerMin || 0) * 10) / 10 }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.machine < b.machine ? -1 : 1));
  return { root: prefix, outRate: roots[0].ratePerMin || 0, rows };
}
const topo = (t) => (t ? t.rows.map((r) => `${r.machine}:${r.label}`).join(' | ') : '∅');
const sizing = (t) => (t ? t.rows.map((r) => `${r.count}×${r.machine.replace(/ .*/, '')}:${r.label}`).join('  ') : '∅');
const totMachines = (t) => (t ? t.rows.reduce((s, r) => s + r.count, 0) : 0);

// ---------- A. Canonical identity ----------
console.log('# A. Canonical identity — Advanced Fertilizer tile: standalone vs as Bandage\'s fert\n');
for (const mode of ['trash', 'reuse']) {
  const alone = extractTile(solve([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }], ZERO, mode), 'Advanced Fertilizer');
  const paired = extractTile(solve([{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }], ZERO, mode), 'Advanced Fertilizer');
  console.log(`byproducts=${mode}`);
  console.log(`  topology identical? ${topo(alone) === topo(paired)}`);
  console.log(`  sizing identical?   ${sizing(alone) === sizing(paired)}`);
  if (sizing(alone) !== sizing(paired)) {
    console.log(`    standalone: ${sizing(alone)}`);
    console.log(`    paired:     ${sizing(paired)}`);
  }
  console.log();
}

// ---------- B. Skill sensitivity ----------
console.log('# B. Skill sensitivity — Advanced Fertilizer tile @ 60/min net (byproducts=trash)\n');
const item = 'Advanced Fertilizer';
const base = extractTile(solve([{ item, rate: 60, rateMode: 'rate' }], ZERO), item);
const baseTopo = topo(base);
const scenarios = [
  ['L0 (all zero)', ZERO],
  ['factory 4 only', { ...ZERO, factory: 4 }],
  ['logistics 4 only', { ...ZERO, logistics: 4 }],
  ['factory+logistics 4', { ...ZERO, factory: 4, logistics: 4 }],
  ['fertilizer 7 only', { ...ZERO, fertilizer: 7 }],
  ['fuel 5 only', { ...ZERO, fuel: 5 }],
  ['alchemy 8 only', { ...ZERO, alchemy: 8 }],
  ['all 4', { factory: 4, logistics: 4, alchemy: 4, fuel: 4, fertilizer: 4 }],
];
console.log('scenario'.padEnd(22) + 'belt  spd   gross  mach  belts  picks  m:beltcap');
for (const [name, sk] of scenarios) {
  const t = extractTile(solve([{ item, rate: 60, rateMode: 'rate' }], sk), item);
  if (!t) { console.log(name.padEnd(22) + 'INFEASIBLE'); continue; }
  const bs = beltSpeed(sk.logistics), sp = speedMult(sk.factory);
  const belts = Math.ceil(60 / bs - 1e-9);            // belts for the NET 60/min deliverable
  const ratio = (totMachines(t) / (bs / 60)).toFixed(1); // machine count normalised to belt capacity
  console.log(
    name.padEnd(22) +
    String(bs).padEnd(6) + sp.toFixed(2).padEnd(6) + String(Math.round(t.outRate)).padEnd(7) +
    String(totMachines(t)).padEnd(6) + String(belts).padEnd(7) +
    (topo(t) === baseTopo ? 'same ' : 'DIFF ').padEnd(7) + ratio
  );
}
console.log('\n(picks=same → recipe topology unchanged; m:beltcap = total machines ÷ (beltSpeed/60),');
console.log(' i.e. machines per belt-equivalent — constant means the tile keeps its shape.)');

// ---------- C. "1 belt of net output" per leveling regime ----------
// Players level 1:1 (factory==logistics) or 2:1 belts-first (logistics==2×factory).
// Size the tile to exactly one belt of NET output (rate = beltSpeed) in each regime and see
// whether the machine layout stays fixed.
console.log('\n# C. Tile sized to ONE belt of net output, per leveling regime\n');
const regimes = [
  ['1:1  L0', { ...ZERO }],
  ['1:1  L4', { ...ZERO, factory: 4, logistics: 4 }],
  ['1:1  L8', { ...ZERO, factory: 8, logistics: 8 }],
  ['2:1  f2/l4', { ...ZERO, factory: 2, logistics: 4 }],
  ['2:1  f4/l8', { ...ZERO, factory: 4, logistics: 8 }],
];
console.log('regime'.padEnd(14) + 'beltrate  machines  layout');
let ref11 = null;
for (const [name, sk] of regimes) {
  const rate = beltSpeed(sk.logistics);
  const t = extractTile(solve([{ item, rate, rateMode: 'rate' }], sk), item);
  if (!t) { console.log(name.padEnd(14) + 'INFEASIBLE'); continue; }
  const sz = sizing(t);
  if (name.startsWith('1:1') && ref11 == null) ref11 = sz;
  const tag = name.startsWith('1:1') ? (sz === ref11 ? ' (= L0 layout)' : ' (DIFFERS from L0)') : '';
  console.log(name.padEnd(14) + String(rate).padEnd(10) + String(totMachines(t)).padEnd(10) + sz + tag);
}
console.log('\n(1:1 regimes should share ONE layout; 2:1-belts-first needs more machines to FILL the faster belt');
console.log(' — so a fixed 1:1 tile under 2:1 leaves belt headroom (safe: machines stay saturated, belts just aren\'t full).)');
