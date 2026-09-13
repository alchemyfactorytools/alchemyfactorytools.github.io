// Effective unlock tiers.
//
// Since DB v45 the dataset stamps an explicit `tier` on every item and machine,
// so the effective tier of an item is normally its own stamp. The fixpoint below
// stays as a safety net for any future item that ships without one: it derives
// the lowest tier at which the item can first be produced through machine
// recipes, where a recipe unlocks at max(its machine's tier, its input items'
// effective tiers). An explicit tier is never overridden.
//
// Deliberately EXCLUDES the Bank Portal mint and Purchasing Portal rows (both
// produce from nothing, which would leak a portal-tier path to everything) and
// the Cauldron (a universal converter whose outputs keep their machine-recipe tier).

'use strict';

const { productionRecipes } = require('./recipes');

let cache = null; // { db, effective: Map }

function computeEffectiveTiers(db) {
  const tier = new Map();
  for (const [name, item] of Object.entries(db.items)) {
    tier.set(name, item.tier !== undefined ? item.tier : Infinity);
  }
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const r of productionRecipes(db)) {
      if (/Portal|Cauldron/.test(r.machine)) continue;
      let req = db.machines[r.machine]?.tier ?? 0;
      let ok = true;
      for (const inp of Object.keys(r.inputs || {})) {
        const t = tier.get(inp);
        if (t === Infinity) { ok = false; break; }
        if (t > req) req = t;
      }
      if (!ok) continue;
      for (const out of Object.keys(r.outputs)) {
        if (db.items[out]?.tier !== undefined) continue;
        if (req < tier.get(out)) { tier.set(out, req); changed = true; }
      }
    }
    if (!changed) break;
  }
  return tier;
}

// Returns { effective(name) → tier|Infinity, machineTier(name) → tier, cauldronTier }
function tiers(db) {
  if (!cache || cache.db !== db) {
    cache = { db, effective: computeEffectiveTiers(db) };
  }
  return {
    effective: (name) => cache.effective.get(name) ?? Infinity,
    machineTier: (name) => db.machines[name]?.tier ?? 0,
    cauldronTier: db.machines.Cauldron?.tier ?? 6,
    map: cache.effective,
  };
}

module.exports = { tiers };
