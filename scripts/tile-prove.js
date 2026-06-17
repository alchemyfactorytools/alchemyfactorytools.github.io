#!/usr/bin/env node
'use strict';
// Canonical-tile PROOF. Tests the thesis catalog-wide and stress-tests the hard cases:
//   P1. Skill-invariance     — a tile's recipe picks don't change with skill levels.
//   P2. Context-invariance   — a tile's picks don't change with what it's paired with, nor with
//                              byproduct policy (trash vs reuse).
//   P3. Joint products       — items from multi-output recipes (the ICP/CP "Mars" case) keep a
//                              stable tile even when both joint outputs are demanded + reused.
//   P4. Nesting              — a complex tile decomposes into the SAME sub-tiles you'd get by
//                              building each intermediate standalone (→ endgame tiles = nested tiles).
//
// Canonicality is judged on the tile's RECIPE PICK-SET (the set of {machine, output-item} recipe
// choices). Machine COUNTS are deliberately ignored: given the picks, counts are fixed by recipe
// stoichiometry × time and just scale with demand/skills (see scripts/tile-spike.js). So a stable
// pick-set ⇒ a tile that renders the same every time.
//
// Run: node scripts/tile-prove.js

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { solveComposerBody } = require(path.join(ROOT, 'src/composer-solve'));
const db = require(path.join(ROOT, 'data/alchemy_db.v41.json'));

const ZERO = { factory: 0, logistics: 0, alchemy: 0, fuel: 0, fertilizer: 0 };
const cfg = (skills, byproducts) => ({
  cauldron: { enabled: true, inputPool: 'easy' }, byproducts: { mode: byproducts },
  machines: { defaultCount: 1000 }, skills, solver: 'composer',
  selfFuel: true, selfFert: true, steam: { enabled: false, mode: 'free' },
  belt: [{ item: 'Silver Coin', rate: 60 }, { item: 'Coke Powder', rate: 60 }], capital: { enabled: true },
  buildabilityFraction: 0, cauldronChainFraction: 0, costTolerance: 0, farmWeight: 0, maxTier: 5,
});
function solve(targets, skills = ZERO, byproducts = 'trash') {
  try {
    return solveComposerBody({ item: targets[0].item, rate: targets[0].rate, rateMode: targets[0].rateMode || 'rate', targets, config: cfg(skills, byproducts) }, db);
  } catch (e) { return { status: 'Error', error: e.message }; }
}
const ok = (o) => o && o.status === 'Optimal' && o.graph;

// root id of item X's tile = shortest-id process node whose label is X
function rootOf(out, item) {
  const rs = out.graph.nodes.filter((n) => n.label === item && n.machine && n.machineCount);
  if (!rs.length) return null;
  rs.sort((a, b) => a.id.length - b.id.length);
  return rs[0].id;
}
// pick-set of the subtree rooted at `prefix` (recipe choices: machine\tlabel)
function pickSetAt(out, prefix) {
  const inTile = (id) => id === prefix || id.startsWith(prefix + '>');
  const s = new Set();
  for (const n of out.graph.nodes) if (inTile(n.id) && n.machine && n.machineCount) s.add(n.machine + '\t' + n.label);
  return s;
}
function pickSet(out, item) { const r = rootOf(out, item); return r ? pickSetAt(out, r) : null; }
const eqSet = (a, b) => a && b && a.size === b.size && [...a].every((x) => b.has(x));
const fmtSet = (s) => (s ? [...s].map((x) => x.replace('\t', ':')).sort().join(', ') : '∅');
const diffSet = (a, b) => ({ added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) });

// feasible producible items at the base context
const allItems = [...new Set(db.recipes.map((r) => Object.keys(r.outputs || {})).flat())];
const feasible = [];
const baseTopo = new Map();
for (const item of allItems) {
  const o = solve([{ item, rate: 60, rateMode: 'rate' }]);
  if (ok(o)) { const ps = pickSet(o, item); if (ps) { feasible.push(item); baseTopo.set(item, ps); } }
}
console.log(`feasible items (easy pool, trash, maxTier 5): ${feasible.length}\n`);

// ---------- P1. Skill-invariance ----------
console.log('## P1. Skill-invariance of recipe picks');
const skillSets = [
  ['1:1 L8', { factory: 8, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }],
  ['2:1 f4/l8', { factory: 4, logistics: 8, alchemy: 0, fuel: 0, fertilizer: 0 }],
  ['all 8', { factory: 8, logistics: 8, alchemy: 8, fuel: 8, fertilizer: 8 }],
];
let p1viol = 0;
for (const item of feasible) {
  for (const [name, sk] of skillSets) {
    const o = solve([{ item, rate: 60, rateMode: 'rate' }], sk);
    const ps = ok(o) ? pickSet(o, item) : null;
    if (!eqSet(baseTopo.get(item), ps)) {
      p1viol++; const d = ps ? diffSet(baseTopo.get(item), ps) : { added: ['<infeasible>'], removed: [] };
      console.log(`  CHANGE ${item} @ ${name}: +[${d.added.map((x) => x.replace('\t', ':')).join(', ')}] -[${d.removed.map((x) => x.replace('\t', ':')).join(', ')}]`);
    }
  }
}
console.log(`  ${p1viol === 0 ? 'PASS' : 'FAIL'} — ${p1viol} pick changes across ${feasible.length} items × ${skillSets.length} skill regimes\n`);

// ---------- P2. Context-invariance: byproduct policy ----------
console.log('## P2. Context-invariance — byproduct policy (trash vs reuse), standalone');
let p2viol = 0;
for (const item of feasible) {
  const o = solve([{ item, rate: 60, rateMode: 'rate' }], ZERO, 'reuse');
  const ps = ok(o) ? pickSet(o, item) : null;
  if (!eqSet(baseTopo.get(item), ps)) {
    p2viol++; const d = ps ? diffSet(baseTopo.get(item), ps) : { added: ['<infeasible>'], removed: [] };
    console.log(`  CHANGE ${item}: +[${d.added.map((x) => x.replace('\t', ':')).join(', ')}] -[${d.removed.map((x) => x.replace('\t', ':')).join(', ')}]`);
  }
}
console.log(`  ${p2viol === 0 ? 'PASS' : 'FAIL'} — ${p2viol} items change picks under reuse mode\n`);

// ---------- P2b. Context-invariance: pairing ----------
console.log('## P2b. Context-invariance — target paired with another target');
const pairs = [
  ['Advanced Fertilizer', [{ item: 'Advanced Fertilizer', rate: 60, rateMode: 'rate' }, { item: 'Bandage', rate: 2, rateMode: 'machines' }]],
  ['Bandage', [{ item: 'Bandage', rate: 2, rateMode: 'machines' }, { item: 'Yeast Powder', rate: 2, rateMode: 'machines' }]],
];
let p2bviol = 0;
for (const [focus, targets] of pairs) {
  for (const mode of ['trash', 'reuse']) {
    const o = solve(targets, ZERO, mode);
    const ps = ok(o) ? pickSet(o, focus) : null;
    const same = eqSet(baseTopo.get(focus), ps);
    if (!same) { p2bviol++; const d = ps ? diffSet(baseTopo.get(focus), ps) : { added: ['<infeasible>'], removed: [] }; console.log(`  CHANGE ${focus} in [${targets.map((t) => t.item).join('+')}] (${mode}): +[${d.added.map((x) => x.replace('\t', ':')).join(', ')}] -[${d.removed.map((x) => x.replace('\t', ':')).join(', ')}]`); }
    else console.log(`  ok ${focus} in [${targets.map((t) => t.item).join('+')}] (${mode})`);
  }
}
console.log(`  ${p2bviol === 0 ? 'PASS' : 'FAIL'} — ${p2bviol} pairing pick changes\n`);

// ---------- P3. Joint products ----------
console.log('## P3. Joint products (multi-output recipes)');
const jointItems = new Set();
for (const r of db.recipes) { const outs = Object.keys(r.outputs || {}); if (outs.length >= 2) for (const o of outs) jointItems.add(o); }
const jointFeasible = feasible.filter((i) => jointItems.has(i));
console.log(`  joint-output items (feasible): ${jointFeasible.length} — ${jointFeasible.slice(0, 12).join(', ')}${jointFeasible.length > 12 ? '…' : ''}`);
let p3viol = 0;
for (const item of jointFeasible) {
  // demand the item; check its picks under trash vs reuse (reuse may cross-feed the co-product)
  const oR = solve([{ item, rate: 60, rateMode: 'rate' }], ZERO, 'reuse');
  const ps = ok(oR) ? pickSet(oR, item) : null;
  if (ps && !eqSet(baseTopo.get(item), ps)) { p3viol++; const d = diffSet(baseTopo.get(item), ps); console.log(`  CHANGE ${item} (reuse): +[${d.added.map((x) => x.replace('\t', ':')).join(', ')}] -[${d.removed.map((x) => x.replace('\t', ':')).join(', ')}]`); }
}
console.log(`  ${p3viol === 0 ? 'PASS' : 'FAIL'} — ${p3viol} joint-product tiles change picks under reuse\n`);

// ---------- P4. Nesting ----------
console.log('## P4. Nesting — does a tile decompose into standalone sub-tiles?');
// For each item X, for every DISTINCT intermediate item Y produced strictly inside X's tile,
// compare Y's sub-subtree pick-set to Y's standalone pick-set.
let nestPairs = 0, nestMatch = 0; const nestMiss = [];
for (const X of feasible) {
  const oX = solve([{ item: X, rate: 60, rateMode: 'rate' }]);
  if (!ok(oX)) continue;
  const rootX = rootOf(oX, X);
  // distinct intermediate items = labels of descendant process nodes (excluding X's own root label)
  const subItems = new Set();
  for (const n of oX.graph.nodes) if (n.machine && n.machineCount && n.id.startsWith(rootX + '>') && n.label !== X) subItems.add(n.label);
  for (const Y of subItems) {
    if (!baseTopo.has(Y)) continue; // Y not independently feasible/standalone-comparable
    // Y's sub-subtree inside X: the shortest descendant id whose label is Y
    const yNodes = oX.graph.nodes.filter((n) => n.label === Y && n.machine && n.id.startsWith(rootX + '>'));
    if (!yNodes.length) continue;
    yNodes.sort((a, b) => a.id.length - b.id.length);
    const ySubInX = pickSetAt(oX, yNodes[0].id);
    nestPairs++;
    if (eqSet(ySubInX, baseTopo.get(Y))) nestMatch++;
    else if (nestMiss.length < 15) nestMiss.push({ X, Y, d: diffSet(baseTopo.get(Y), ySubInX) });
  }
}
console.log(`  sub-tile matches: ${nestMatch}/${nestPairs} (${(100 * nestMatch / Math.max(1, nestPairs)).toFixed(1)}%)`);
for (const m of nestMiss) console.log(`  MISS ${m.Y} inside ${m.X}: +[${m.d.added.map((x) => x.replace('\t', ':')).join(', ')}] -[${m.d.removed.map((x) => x.replace('\t', ':')).join(', ')}]`);
console.log(`  ${nestMatch === nestPairs ? 'PASS — every nested sub-tile equals its standalone tile' : 'PARTIAL — see misses above'}`);
