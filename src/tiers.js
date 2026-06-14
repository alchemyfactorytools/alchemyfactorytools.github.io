// Effective unlock tiers.
//
// The dataset stamps an explicit `tier` only on raw resources / seeds / herbs
// (27 items). Crafted items have none, so this derives an EFFECTIVE tier for
// every item: the lowest tier at which it can first be produced through normal
// (machine) recipes, where a recipe unlocks at max(its machine's tier, its
// input items' effective tiers). Computed as a minimax fixpoint.
//
// Deliberately EXCLUDES the Bank Portal mint (mints coins from nothing, which
// would otherwise leak a tier-0 path to Silver/Gold Coin and collapse the tiers
// of everything made from coins) and the Cauldron (a tier-6 universal converter
// whose outputs should keep their real machine-recipe tier — you shouldn't be
// able to cauldron-make a tier-8 item at tier 6).
//
// Machine tiers come from data/machine_tiers.json (sourced from the JoeJoes
// dataset; structural and unaffected by the June recipe patch).

'use strict';

const machineTierData = require('../data/machine_tiers.json');
const MACHINE_TIER = machineTierData.tiers;

let cache = null; // { db, effective: Map, cauldronTier }

function computeEffectiveTiers(db) {
  const tier = new Map();
  for (const [name, item] of Object.entries(db.items)) {
    tier.set(name, item.tier !== undefined ? item.tier : Infinity);
  }
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const r of db.recipes) {
      if (r.machine === 'Bank Portal' || /Cauldron/.test(r.machine)) continue;
      let req = MACHINE_TIER[r.machine] ?? 0;
      let ok = true;
      for (const inp of Object.keys(r.inputs)) {
        const t = tier.get(inp);
        if (t === Infinity) { ok = false; break; }
        if (t > req) req = t;
      }
      if (!ok) continue;
      for (const out of Object.keys(r.outputs)) {
        // never override an item's own explicit raw tier
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
    machineTier: (name) => MACHINE_TIER[name] ?? 0,
    cauldronTier: MACHINE_TIER.Cauldron ?? 6,
    map: cache.effective,
  };
}

module.exports = { tiers, MACHINE_TIER };
