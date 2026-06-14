'use strict';

// Cheapest copper to obtain one unit of each item, via buyPrice or a machine
// recipe's material cost. Computed by iterative relaxation (Bellman-Ford style)
// to a fixpoint, so the result is order-independent — a naive memoized DFS gets
// cycle-poisoned and wildly overestimates depending on traversal order. A rough
// floor (machine recipes only, byproducts treated as bonus). Used to value machine
// build costs AND to value belt supply (what it'd cost you to obtain the item).
function makeItemCopperFloor(db) {
  const cost = new Map();
  for (const [name, item] of Object.entries(db.items)) cost.set(name, item.buyPrice ?? Infinity);
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const r of db.recipes) {
      let c = 0;
      let ok = true;
      for (const [inp, q] of Object.entries(r.inputs)) {
        const f = cost.get(inp);
        if (!isFinite(f)) { ok = false; break; }
        c += q * f;
      }
      if (!ok) continue;
      for (const [out, oq] of Object.entries(r.outputs)) {
        const per = c / oq; // attribute full input cost to each output (conservative)
        if (per < (cost.get(out) ?? Infinity)) { cost.set(out, per); changed = true; }
      }
    }
    if (!changed) break;
  }
  return (item) => cost.get(item) ?? Infinity;
}

module.exports = { makeItemCopperFloor };
