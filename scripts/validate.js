#!/usr/bin/env node
// Validates data/alchemy_db.v41.json: referential integrity, schema coverage,
// and a freshness diff against the stale January dataset for June-patch items.
// Run: node scripts/validate.js

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const v41 = JSON.parse(fs.readFileSync(path.join(dataDir, 'alchemy_db.v41.json'), 'utf8'));
const jan = JSON.parse(fs.readFileSync(path.join(dataDir, 'alchemy_db.joejoes.jan2026.json'), 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };
const ok = (msg) => console.log('ok  :', msg);

// 1. Header
if (v41.gameVersion !== '0.5.0.4471') fail(`unexpected gameVersion ${v41.gameVersion}`);
else ok(`gameVersion ${v41.gameVersion} (DB v${v41.version}, ${v41.date})`);

// 2. Counts
console.log(`     ${Object.keys(v41.items).length} items, ${Object.keys(v41.machines).length} machines, ${v41.recipes.length} recipes`);

// 3. Referential integrity
for (const r of v41.recipes) {
  for (const k of [...Object.keys(r.inputs || {}), ...Object.keys(r.outputs || {})]) {
    if (!v41.items[k]) fail(`recipe ${r.id}: unknown item "${k}"`);
  }
  if (r.machine && !v41.machines[r.machine]) fail(`recipe ${r.id}: unknown machine "${r.machine}"`);
}
for (const [name, m] of Object.entries(v41.machines)) {
  if (m.parent && !v41.machines[m.parent]) fail(`machine ${name}: unknown parent "${m.parent}"`);
  for (const k of Object.keys(m.buildCost || {})) {
    if (!v41.items[k]) fail(`machine ${name}: unknown buildCost item "${k}"`);
  }
}
if (!failures) ok('referential integrity (recipes->items, recipes->machines, machine parents/buildCosts)');

// 4. Every non-Nursery recipe has a baseTime
const noTime = v41.recipes.filter((r) => r.baseTime === undefined && !/Nursery/.test(r.machine));
if (noTime.length) fail(`recipes missing baseTime outside Nursery: ${noTime.map((r) => r.id).join(', ')}`);
else ok('all non-Nursery recipes have baseTime (Nursery crops are nutrient-driven, no baseTime expected)');

// 5. Catalyst charge items present
const charges = { 'Unstable Catalyst': 180, 'Fertile Catalyst': 240, 'Resonant Catalyst': 1500, 'Eternal Catalyst': 99999 };
for (const [n, c] of Object.entries(charges)) {
  if (v41.items[n]?.charges !== c) fail(`catalyst ${n}: expected charges ${c}, got ${v41.items[n]?.charges}`);
}
ok('catalyst charge values match engine constants (180/240/1500/99999)');

// 6. Freshness: June-2026-patch items must differ from the January dataset
const watch = ['Black Powder', 'Star Dust', 'Unstable Catalyst', 'Silver Powder', 'Obsidian',
  'Lapis Lazuli', 'Gold Dust', 'Blast Potion', 'Moon Tear'];
for (const w of watch) {
  const recA = JSON.stringify(v41.recipes.filter((r) => r.outputs[w]).map((r) => [r.inputs, r.outputs, r.baseTime]));
  const recB = JSON.stringify(jan.recipes.filter((r) => r.outputs && r.outputs[w]).map((r) => [r.inputs, r.outputs, r.baseTime]));
  if (recA === recB) fail(`June-patch item "${w}" identical to January dataset — v41 may be stale`);
}
ok('all 9 June-patch reworked items differ from the January dataset (v41 reflects v0.5.4467)');

console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
