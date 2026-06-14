// Tile-composer (TILE-COMPOSER.md) — the "Simplest" solver.
//
// Deterministic alternative to the LP: pick ONE canonical recipe per item by a
// shortest-build-path DP that scores how hard the item is to BUILD and TILE (machine
// difficulty + chain depth + input width + relative material expense), then compose the
// target top-down into a tile tree. No global optimization, no degeneracy.
//
// Phase 1 (this file, so far): the canonical-recipe DP. Composition + graph emit follow.

'use strict';

const { tiers } = require('./tiers');
const { makeItemCopperFloor } = require('./cost-floor');

// Simplicity weights (copper-equivalent units). Deliberately MINIMAL to start (per user):
// only DEPTH, WIDTH, input/material cost, and a co-product-waste penalty. NO machine
// build-cost or farm penalty yet — a 3-nursery Cauldron tile is fine; depth+width already
// keep deep/wide chains in check. Add machine weighting later only if a case demands it.
const DEPTH_W = 1500; // per recipe stage — penalizes deep chains
const WIDTH_W = 250;  // per extra distinct input — penalizes wide fan-in (more belts)
const BUY_LEAF = 40;  // buying is a simple leaf …
const MAT_W = 0.15;   // … but expensive raws cost more (Rotten Log / Rock Salt only if forced)
const CO_W = 10;      // co-product waste: dumping a valued co-product (Rock Salt's Salt when
                      // you only want Sand) is penalized by its floor value, so clean recipes win

// Build the canonical-recipe picker for a given db + config.
function makeComposer(db, cfg) {
  const T = tiers(db);
  const floor = makeItemCopperFloor(db);
  const maxTier = cfg.maxTier;
  const tierOk = (name) => maxTier == null || T.effective(name) <= maxTier;

  // Items that ARRIVE on the main belt (cost 0 to "build"): user belt items + the canonical
  // fuel/fert carriers (passed in via cfg.canonical). Heat/nutrient aren't modelled here —
  // they're belt inputs attached during composition, like the LP.
  const beltItems = new Set((cfg.belt || []).map((b) => (typeof b === 'string' ? b : b.item)));
  if (cfg.canonical) {
    if (cfg.canonical.fuelItem) beltItems.add(cfg.canonical.fuelItem);
    if (cfg.canonical.fertItem) beltItems.add(cfg.canonical.fertItem);
  }

  const buyable = (name) => db.items[name] && db.items[name].buyPrice !== undefined && cfg.buy !== false;

  // recipes producing each item (tier-gated), with their primary/co outputs
  const producersOf = new Map();
  for (const [id, r] of Object.entries(db.recipes)) {
    if (!tierOk(r.id != null ? (db.items[r.id] ? r.id : id) : id)) { /* gate by outputs below */ }
    const outputs = r.outputs || {};
    // gate: skip recipes whose machine or any input/output is above tier
    if (Object.keys(outputs).some((o) => !tierOk(o))) continue;
    if (Object.keys(r.inputs || {}).some((i) => !tierOk(i))) continue;
    for (const out of Object.keys(outputs)) {
      if (!producersOf.has(out)) producersOf.set(out, []);
      producersOf.get(out).push({ id, ...r });
    }
  }

  const memo = new Map();
  const onPath = new Set();
  // tileCost(item): build+tile complexity of the simplest tile making `item`. Infinity if
  // unmakeable at this tier. Also records the chosen recipe (or 'buy'/'belt') in `pick`.
  const pick = new Map();
  function tileCost(item) {
    if (beltItems.has(item)) { pick.set(item, { source: 'belt' }); return 0; }
    if (memo.has(item)) return memo.get(item);
    if (onPath.has(item)) return Infinity; // cycle — this path can't make the item
    onPath.add(item);
    let best = Infinity, bestPick = null;
    if (buyable(item)) {
      const c = BUY_LEAF + MAT_W * (db.items[item].buyPrice || 0);
      if (c < best) { best = c; bestPick = { source: 'buy' }; }
    }
    for (const r of producersOf.get(item) || []) {
      const inputs = Object.keys(r.inputs || {});
      let inSum = 0, ok = true;
      for (const inp of inputs) {
        const ic = tileCost(inp);
        if (!isFinite(ic)) { ok = false; break; }
        inSum += ic; // per-input (width handles count); depth falls out of the recursion
      }
      if (!ok) continue;
      // Co-product waste: a recipe making the target AND other items dumps those (trash mode).
      // Penalize by the dumped value per unit of target, so e.g. Rock Salt → Salt + Sand loses
      // for Sand (it would dump valuable Salt) but stays fine for Salt (cheap Sand dumped).
      const prim = r.outputs[item] || 1;
      let coWaste = 0;
      for (const [out, q] of Object.entries(r.outputs || {})) {
        if (out === item) continue;
        const f = floor(out);
        if (isFinite(f)) coWaste += (q / prim) * f;
      }
      const c = DEPTH_W + WIDTH_W * Math.max(0, inputs.length - 1) + inSum + CO_W * coWaste;
      if (c < best) { best = c; bestPick = { source: 'recipe', recipe: r }; }
    }
    onPath.delete(item);
    memo.set(item, best);
    if (bestPick) pick.set(item, bestPick);
    return best;
  }

  return { tileCost, canonicalPick: (item) => { tileCost(item); return pick.get(item); }, beltItems, buyable };
}

module.exports = { makeComposer, DEPTH_W, WIDTH_W, BUY_LEAF, MAT_W };
