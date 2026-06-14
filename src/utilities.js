// Canonical fuel / fertilizer "tiles".
//
// Fuel and fertilizer are utilities every build needs but the joint optimizer handles
// worst: left free it picks whatever byproduct fuel is locally cheapest and re-derives a
// production chain per build — often a wasteful one (e.g. Coke via Charcoal Powder, which
// dumps Charcoal). Instead we pre-pick ONE canonical carrier per tier and build the
// SIMPLEST self-contained chain to make it, then lock the main build to that chain.
//
//   fuel item = max heat / copper-floor  → cost-dense, readily available (Coke Powder @ t6)
//   fert item = max maxFertility         → fewest nursery plots when used (Growth Potion @ t6)
//
// "Simplest" tile = the fewest-route build to make 1/min of the item (route MIP, big
// tolerance) — it buys raw inputs rather than farming them when that's shorter, giving a
// clean droppable blueprint (Buy Coal Ore → Coal → Coke → Coke Powder).

'use strict';

const { tiers } = require('./tiers');
const { makeItemCopperFloor } = require('./cost-floor');

// The canonical tiles depend only on the build's ENVIRONMENT (tier, skills, cauldron pool,
// self-fuel/fert, buy/byproduct policy) — not the target item or rate — so memoize them.
// A user retargeting the same factory config hits the cache and skips the pre-solve.
const _cache = new Map();
function envKey(cfg) {
  return JSON.stringify([
    cfg.maxTier, cfg.skills, cfg.cauldron, cfg.selfFuel, cfg.selfFert, cfg.buy, cfg.byproducts,
  ]);
}

async function canonicalUtilities(db, cfg, deps) {
  const key = envKey(cfg);
  if (_cache.has(key)) return _cache.get(key);
  const result = await computeCanonicalUtilities(db, cfg, deps);
  _cache.set(key, result);
  return result;
}

async function computeCanonicalUtilities(db, cfg, deps) {
  const { buildProcessTable, Model, optimizeWithinTolerance } = deps;
  const T = tiers(db);
  const tierOk = (n) => cfg.maxTier == null || T.effective(n) <= cfg.maxTier;
  const floor = makeItemCopperFloor(db);

  // candidate carriers, best first
  const fuels = Object.entries(db.items)
    .filter(([n, it]) => it.heat > 0 && tierOk(n))
    .map(([n, it]) => [n, isFinite(floor(n)) && floor(n) > 0 ? it.heat / floor(n) : 0])
    .sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const ferts = Object.entries(db.items)
    .filter(([n, it]) => it.nutrientValue > 0 && it.maxFertility > 0 && tierOk(n))
    .map(([n, it]) => [n, it.maxFertility])
    .sort((a, b) => b[1] - a[1]).map(([n]) => n);

  // Build the simplest tile for the first candidate that's producible. Returns the chosen
  // item plus the set of RECIPE columns (by id) that make it — the canonical chain.
  const buildTile = async (candidates, sink) => {
    for (const item of candidates) {
      const pt = buildProcessTable(db, cfg);
      const model = new Model(pt, db);
      model.wasteWeight = 0.01; // tight: the canonical chain must be clean
      let r;
      try { r = await optimizeWithinTolerance(model, { demand: { [item]: 1 }, toleranceFraction: 1000 }); } catch (e) { continue; }
      if (!r || r.status !== 'Optimal' || !r.flows || !r.flows.length) continue;
      const recipeIds = new Set(
        r.flows
          .filter((f) => ['recipe', 'catalystVariant', 'cauldron'].includes(f.process.kind))
          .map((f) => f.process.id)
      );
      return { item, recipeIds };
    }
    return null;
  };

  const fuel = await buildTile(fuels);
  const fert = await buildTile(ferts);
  if (!fuel && !fert) return null;

  // Recipes to FORBID in the main build: any non-canonical producer of a UTILITY-EXCLUSIVE
  // item (one consumed only by burning/fertilizing, transitively). Locking these to the
  // canonical chain kills wasteful alternates (the Charcoal→Coke route) without touching
  // items that also feed real products. Computed over a fresh, unrestricted table.
  const pt = buildProcessTable(db, cfg);
  const consumersOf = new Map();
  for (const p of pt.processes) {
    for (const it of Object.keys(p.consumes || {})) {
      if (!consumersOf.has(it)) consumersOf.set(it, []);
      consumersOf.get(it).push(p);
    }
  }
  // Only the FUEL chain is locked: fuel-exclusive items (consumed solely by burning) have a
  // single clean carrier (Coke Powder) whose alternates we want gone. Fertilizer is left to
  // the carrier restriction alone — its chain is an inherent farm loop we can't shorten, and
  // forbidding fert producers breaks builds that TARGET a fertilizer.
  const isSink = (p) => p.kind === 'burn';
  const isRecipe = (p) => p.kind === 'recipe' || p.kind === 'cauldron' || p.kind === 'catalystVariant';
  const exclusive = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [item, consumers] of consumersOf) {
      if (exclusive.has(item) || !db.items[item]) continue;
      const ok = consumers.length > 0 && consumers.every(
        (p) => isSink(p) || (isRecipe(p) && Object.keys(p.produces).some((o) => exclusive.has(o)))
      );
      if (ok) { exclusive.add(item); changed = true; }
    }
  }
  const canonical = new Set([...(fuel ? fuel.recipeIds : []), ...(fert ? fert.recipeIds : [])]);
  const forbidRecipeIds = new Set();
  for (const p of pt.processes) {
    if (!isRecipe(p) || canonical.has(p.id)) continue;
    if (Object.keys(p.produces).some((o) => exclusive.has(o))) forbidRecipeIds.add(p.id);
  }

  return {
    fuelItem: fuel ? fuel.item : null,
    fertItem: fert ? fert.item : null,
    forbidRecipeIds,
  };
}

module.exports = { canonicalUtilities };
