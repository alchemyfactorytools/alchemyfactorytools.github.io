// Recipe rows the planner can use.
//
// Since DB v50 the dataset also carries rows that describe portals and UI
// conveniences, not production. Each would be a free item if fed to the LP or
// the composer, so every consumer of db.recipes goes through this filter:
//   Purchasing Portal rows ({} → item): purchases are priced from items.buyPrice.
//   Bank Portal exchanges (50 Copper ⇄ 0.05 Silver): coins already interchange
//     at face value; the zero-input mints stay (normalize.js turns them into mint
//     columns, the composer values them as leaves).
//   Custom-slot rows (any item → Oblivion Essence): no fixed inputs.
// Rows without an `inputs` key (Steam Boiler) are returned with an empty map.

'use strict';

function isProductionRecipe(r) {
  if (r.machine === 'Purchasing Portal') return false;
  if (r.customInputSlot) return false;
  if (r.machine === 'Bank Portal' && Object.keys(r.inputs || {}).length) return false;
  return true;
}

let cache = null; // { db, rows }
function productionRecipes(db) {
  if (!cache || cache.db !== db) {
    cache = { db, rows: db.recipes.filter(isProductionRecipe).map((r) => (r.inputs ? r : { ...r, inputs: {} })) };
  }
  return cache.rows;
}

module.exports = { isProductionRecipe, productionRecipes };
