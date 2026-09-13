#!/usr/bin/env node
// Validates data/alchemy_db.json: header pin, referential integrity, and the schema
// rules the optimizer relies on (see README "Canonical schema").
// Run: node scripts/validate.js

const fs = require('fs');
const path = require('path');

const EXPECTED_GAME_VERSION = '1.0.4950';
const db = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'alchemy_db.json'), 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };
const ok = (msg) => console.log('ok  :', msg);

// 1. Header
if (db.gameVersion !== EXPECTED_GAME_VERSION) fail(`unexpected gameVersion ${db.gameVersion} (expected ${EXPECTED_GAME_VERSION}; re-pin here + test/golden.test.js after a refresh)`);
else ok(`gameVersion ${db.gameVersion} (DB v${db.version}, ${db.date})`);
console.log(`     ${Object.keys(db.items).length} items, ${Object.keys(db.machines).length} machines, ${db.recipes.length} recipes`);

// 2. Referential integrity
const before = failures;
for (const r of db.recipes) {
  for (const k of [...Object.keys(r.inputs || {}), ...Object.keys(r.outputs || {})]) {
    if (!db.items[k]) fail(`recipe ${r.id}: unknown item "${k}"`);
  }
  if (!db.machines[r.machine]) fail(`recipe ${r.id}: unknown machine "${r.machine}"`);
}
for (const [name, m] of Object.entries(db.machines)) {
  for (const k of Object.keys(m.buildCost || {})) {
    if (!db.items[k]) fail(`machine ${name}: unknown buildCost item "${k}"`);
  }
}
if (failures === before) ok('referential integrity (recipes->items, recipes->machines, machine buildCosts)');

// 3. Tiers on every item and machine (src/tiers.js reads them directly)
const noItemTier = Object.entries(db.items).filter(([, i]) => i.tier === undefined).map(([n]) => n);
const noMachTier = Object.entries(db.machines).filter(([, m]) => m.tier === undefined).map(([n]) => n);
if (noItemTier.length) fail(`items without tier: ${noItemTier.join(', ')}`);
if (noMachTier.length) fail(`machines without tier: ${noMachTier.join(', ')}`);
if (!noItemTier.length && !noMachTier.length) ok('every item and machine carries a tier');

// 4. Heat model: heating devices draw no base heat; heatCost -1 machines carry the draw per recipe
const generators = Object.entries(db.machines).filter(([, m]) => m.isGenerator);
const selfDraw = generators.filter(([, m]) => m.heatSelf).map(([n]) => n);
if (selfDraw.length) fail(`heating devices with base heat draw (removed in 1.0): ${selfDraw.join(', ')}`);
else ok(`${generators.length} heating devices, none with base heat draw`);
const recipeHeat = db.recipes.filter((r) => db.machines[r.machine]?.heatCost === -1 && r.heatCost === undefined);
if (recipeHeat.length) fail(`recipes on heatCost -1 machines without recipe heatCost: ${recipeHeat.map((r) => r.id).join(', ')}`);
else ok('every recipe on a heatCost -1 machine carries its own heatCost');
const heated = Object.entries(db.machines).filter(([, m]) => m.heatCost !== undefined && !m.slotsRequired && !/Cauldron|Steam Boiler/.test(m.heatCost === -1 ? '' : ''))
  .filter(([n, m]) => m.heatCost > 0 && !m.slotsRequired).map(([n]) => n);
if (heated.length) fail(`heated machines without slotsRequired: ${heated.join(', ')}`);
else ok('every machine with a positive heat draw declares slotsRequired');

// 5. Every recipe outside nutrient-driven growers has a baseTime
const growers = new Set(Object.entries(db.machines).filter(([, m]) => m.fertility).map(([n]) => n));
const noTime = db.recipes.filter((r) => r.baseTime === undefined && !growers.has(r.machine));
if (noTime.length) fail(`recipes missing baseTime outside growers: ${noTime.map((r) => r.id).join(', ')}`);
else ok('all recipes outside nutrient-driven growers have baseTime');

// 6. Catalyst charge items present
const charges = { 'Unstable Catalyst': 180, 'Fertile Catalyst': 240, 'Resonant Catalyst': 1500, 'Eternal Catalyst': 99999 };
for (const [n, c] of Object.entries(charges)) {
  if (db.items[n]?.charges !== c) fail(`catalyst ${n}: expected charges ${c}, got ${db.items[n]?.charges}`);
}
ok('catalyst charge values match engine constants (180/240/1500/99999)');

// 7. Zero-input rows the normalizer must skip are only where expected
const freeRows = db.recipes.filter((r) => !Object.keys(r.inputs || {}).length && !r.nutrientCost && !r.customInputSlot && !/Portal|Steam Boiler/.test(r.machine));
if (freeRows.length) fail(`unexpected zero-input recipes: ${freeRows.map((r) => r.id).join(', ')}`);
else ok('zero-input recipes are only portal rows, growers, the Steam Boiler, or custom-slot');

console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
