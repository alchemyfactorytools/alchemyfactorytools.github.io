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

  const pt0 = buildProcessTable(db, cfg);
  const isRecipe = (p) => p.kind === 'recipe' || p.kind === 'cauldron' || p.kind === 'catalystVariant';

  // Build the simplest tile for the first candidate that's producible — fewest routes
  // (route MIP, big tolerance), so it buys raw ore rather than building a farm. Returns the
  // chosen item, the canonical recipe columns, and every item those recipes PRODUCE (the
  // chain's items — Coal, Coke, Coke Powder — which the main build will lock to this chain).
  const buildTile = async (candidates, baseCfg) => {
    for (const item of candidates) {
      const pt = buildProcessTable(db, baseCfg);
      const model = new Model(pt, db);
      model.wasteWeight = 0.01; // tight: the canonical chain must be clean
      let r;
      try { r = await optimizeWithinTolerance(model, { demand: { [item]: 1 }, toleranceFraction: 1000 }); } catch (e) { continue; }
      if (!r || r.status !== 'Optimal' || !r.flows || !r.flows.length) continue;
      const recipes = r.flows.filter((f) => isRecipe(f.process));
      const recipeIds = new Set(recipes.map((f) => f.process.id));
      const items = new Set(recipes.flatMap((f) => Object.keys(f.process.produces || {})).filter((o) => db.items[o]));
      return { item, recipeIds, items };
    }
    return null;
  };

  // FUEL tile: built with NO fertilizer (noFert) — fuel must not depend on fert, so it can't
  // farm; that forces a bought-ore refine chain (Buy Coal Ore → Coal → Coke → Coke Powder), a
  // clean droppable blueprint. FERT tile: built normally — it MAY burn fuel, and its farm
  // chain is inherent. Both may buy raws (coins are fine). Fall back to allowing fert for fuel
  // only if it's otherwise impossible (then we don't lock the chain).
  const fuelCfg = { ...cfg, noFert: true };
  let fuel = await buildTile(fuels, fuelCfg);
  const lockFuel = !!fuel; // fert-free fuel found ⇒ the main build can lock the whole chain
  if (!fuel) fuel = await buildTile(fuels, cfg);
  const fert = await buildTile(ferts, cfg);
  if (!fuel && !fert) return null;

  // Lock the fuel chain: every item the canonical tile produces (Coal, Coke, Coke Powder —
  // even those that double as recipe ingredients) may ONLY be made by the canonical recipes.
  // Forbid every other RECIPE producer and (the same items) cauldron production, so the main
  // build makes Coke Powder via the bought-ore refine chain, never a cauldron-farm.
  const lockItems = lockFuel && fuel ? fuel.items : new Set();
  const forbidRecipeIds = new Set();
  for (const p of pt0.processes) {
    if (!isRecipe(p) || fuel.recipeIds.has(p.id)) continue;
    if (Object.keys(p.produces).some((o) => lockItems.has(o))) forbidRecipeIds.add(p.id);
  }
  const forbidCauldronItems = [...lockItems];

  return {
    fuelItem: fuel ? fuel.item : null,
    fertItem: fert ? fert.item : null,
    forbidRecipeIds,
    forbidCauldronItems,
  };
}

// LP-free carrier pick for the tile composer: the top tier-ok fuel (max heat / copper-floor) and
// fert (max maxFertility) candidate — the SAME heuristic as the canonical-utilities presolve above,
// minus the route MIP (the composer builds the chain to the carrier itself, so it only needs the
// carrier ITEM, not a locked chain). Cheap + synchronous, so the composer path never touches the LP.
function canonicalCarriers(db, cfg) {
  const T = tiers(db);
  const tierOk = (n) => cfg.maxTier == null || T.effective(n) <= cfg.maxTier;
  const floor = makeItemCopperFloor(db);
  const top = (entries, score) => entries.map(([n, it]) => [n, score(n, it)]).sort((a, b) => b[1] - a[1]).map(([n]) => n)[0] || null;
  const fuelItem = top(
    Object.entries(db.items).filter(([n, it]) => it.heat > 0 && tierOk(n)),
    (n, it) => (isFinite(floor(n)) && floor(n) > 0 ? it.heat / floor(n) : 0));
  const fertItem = top(
    Object.entries(db.items).filter(([n, it]) => it.nutrientValue > 0 && it.maxFertility > 0 && tierOk(n)),
    (n, it) => it.maxFertility);
  // A user-supplied belt fuel/fert OVERRIDES the heuristic: if you put a fuel (or fertilizer) on the
  // main belt, THAT is the carrier — the build draws it off the belt instead of composing a
  // production trunk for it. (Belt items are free leaves in the DP, so the trunk collapses to a
  // single belt node automatically.)
  const beltList = (cfg.belt || []).map((b) => (typeof b === 'string' ? b : b.item));
  const beltFuel = beltList.find((n) => db.items[n] && db.items[n].heat > 0);
  const beltFert = beltList.find((n) => db.items[n] && db.items[n].nutrientValue > 0);
  return { fuelItem: beltFuel || fuelItem, fertItem: beltFert || fertItem };
}

module.exports = { canonicalUtilities, canonicalCarriers };
