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
const { cauldronEligibility } = require('./cauldron');

// Simplicity weights (copper-equivalent units). Deliberately MINIMAL to start (per user):
// only DEPTH, WIDTH, input/material cost, and a co-product-waste penalty. NO machine
// build-cost or farm penalty yet — a 3-nursery Cauldron tile is fine; depth+width already
// keep deep/wide chains in check. Add machine weighting later only if a case demands it.
const DEPTH_W = 1500; // per recipe stage — penalizes deep chains
const WIDTH_W = 250;  // per extra distinct input — penalizes wide fan-in (more belts)
const BUY_LEAF = 40;  // buying is a simple leaf (structurally) …
const OP_W_DEFAULT = 2; // … but buying is also an ongoing copper DRAIN. OP_W prices a purchased
                      // input's per-unit-of-output cost (buyPrice·qty/prim) and — because the input
                      // sum below is qty/prim-weighted — that drain propagates up the tree by
                      // stoichiometry (Glass=Kiln{Sand:6} carries 6× Sand's whole cost, incl. its
                      // bought raw). Blends operating cost into the build metric so a build-cheap
                      // tile that buys 2 Logs (400c) per output no longer reads as ~free. Tunable
                      // via cfg.composer.opW (0 = build-only, ignore material price).
const CO_W = 30;      // co-product waste: dumping a valued co-product (Rock Salt's Salt when you
                      // only want Sand) is penalized by floor(co)·(coQty/prim), so clean recipes
                      // win. floor() separates valuable waste (Salt 54) from cheap (Sand 4); the
                      // weight had to rise from 10→30 once inputs became qty/prim-weighted, because
                      // a high-multiplier route (1 Rock Salt → 100 Sand + 100 Salt) otherwise makes
                      // the bought input look ~free per unit and the dumped Salt too cheap to deter.
                      // Tunable via cfg.composer.coW.

// Build the canonical-recipe picker for a given db + config.
function makeComposer(db, cfg) {
  const T = tiers(db);
  const floor = makeItemCopperFloor(db);
  const maxTier = cfg.maxTier;
  const tierOk = (name) => maxTier == null || T.effective(name) <= maxTier;

  // Items that ARRIVE free on the main belt as MATERIAL — only the user's explicit belt imports.
  // The canonical fuel/fert carriers are deliberately NOT here: a belt fuel/fert is a utility
  // supply, consumable only as fuel/fertilizer, never as bulk recipe material (LP's BELT::X rule —
  // "a fuel belt shouldn't feed bulk inputs"). The composer doesn't model the heat/nutrient draw
  // (so the utility role is effectively free), but as a MATERIAL input the carrier costs its real
  // production (e.g. Coke Powder pays its buy-ore→refine chain), which kills the degeneracy where
  // free belt Coke Powder was a free cauldron filler.
  const beltItems = new Set((cfg.belt || []).map((b) => (typeof b === 'string' ? b : b.item)));
  // The fuel/fert carriers are tracked separately ONLY so composition can attach the utility
  // draw later; they are not free-as-material here.
  const utilityCarriers = new Set();
  if (cfg.canonical) {
    if (cfg.canonical.fuelItem) utilityCarriers.add(cfg.canonical.fuelItem);
    if (cfg.canonical.fertItem) utilityCarriers.add(cfg.canonical.fertItem);
  }

  const buyable = (name) => db.items[name] && db.items[name].buyPrice !== undefined && cfg.buy !== false;

  // recipes producing each item (tier-gated), with their primary/co outputs
  const producersOf = new Map();
  for (const [id, r] of Object.entries(db.recipes)) {
    if (!tierOk(r.id != null ? (db.items[r.id] ? r.id : id) : id)) { /* gate by outputs below */ }
    const outputs = r.outputs || {};
    // skip currency mints (Bank Portal: copper → coin, zero inputs) — currency is valued at its
    // copper-equivalent (sellPrice) as a leaf, not crafted ~free via a depth stage. (Nurseries
    // are also zero-input but produce herbs, not currency, so they stay.)
    if (Object.keys(outputs).every((o) => db.items[o] && db.items[o].category === 'Currency')) continue;
    // gate: skip recipes whose machine or any input/output is above tier
    if (Object.keys(outputs).some((o) => !tierOk(o))) continue;
    if (Object.keys(r.inputs || {}).some((i) => !tierOk(i))) continue;
    for (const out of Object.keys(outputs)) {
      if (!producersOf.has(out)) producersOf.set(out, []);
      producersOf.get(out).push({ id, ...r });
    }
  }

  // Cauldron triples as recipe candidates. They are deterministically generated (not in
  // db.recipes), so we pull them from the shared eligibility helper — the SAME mask the LP
  // uses, keyed by output item. A cauldron craft is 3 inputs → 1 output (qty 1, no
  // co-products), so it scores in the DP exactly like a 3-input recipe: one stage (DEPTH_W),
  // up to 3 distinct inputs (WIDTH_W), plus Σ tileCost(inputs). "Input generation complexity"
  // therefore falls straight out of the existing recursion — no separate ranking pass.
  const cauldronOn = !!(cfg.cauldron && cfg.cauldron.enabled) && (maxTier == null || T.cauldronTier <= maxTier);
  let cauldron = null; // { compiled, byOutput } — built lazily on first cauldron-target lookup
  function ensureCauldron() {
    if (cauldron || !cauldronOn) return cauldron;
    const elig = cauldronEligibility(db, cfg, { locked: (n) => !tierOk(n), buildOutputIndex: true });
    cauldron = { compiled: elig.compiled, byOutput: elig.byOutput };
    return cauldron;
  }

  // tileCost(item) = build+tile complexity of the SIMPLEST tile making `item` (Infinity if
  // unmakeable at this tier). The recipe DAG has cycles — items feed back into their own
  // producers, and cauldron outputs are also cauldron inputs — so a recursive memo is unsound
  // (a value computed while an item is mid-recursion is only valid for that ancestor set, which
  // is what poisoned Brick → "unmakeable" and inflated Sand). But every edge weight is positive,
  // so an optimal tile never contains a cycle (a loop only ADDS cost). The cost vector is thus
  // the least fixpoint of the min-cost AND/OR recurrence, which we get by iterative relaxation:
  // start everyone at Infinity, seed buy/belt leaves, and relax until nothing improves. Costs
  // only decrease, bounded below, so it converges in ≤ depth passes — context-free, cacheable,
  // no blowup. Solved once (lazily), then tileCost/canonicalPick are O(1) lookups.
  const cc = cfg.composer || {};
  const depthW = cc.depthW != null ? cc.depthW : DEPTH_W;
  const widthW = cc.widthW != null ? cc.widthW : WIDTH_W;
  const OP_W = cc.opW != null ? cc.opW : OP_W_DEFAULT;
  const coW = cc.coW != null ? cc.coW : CO_W;
  // The metric tracks TWO independent quantities per item, each PER UNIT OF OUTPUT:
  //  • build — structural "how hard to lay out": DEPTH_W per stage + WIDTH_W per extra distinct
  //            input belt, summed down the chain. QTY-INDEPENDENT (fan-out is free: needing 6 Sand
  //            doesn't make Glass 6× harder to BUILD — you just replicate the Sand tile).
  //  • op    — operating cost: copper consumed per unit of output (buyPrice / minted sellPrice),
  //            propagated by stoichiometry (qty/prim). This is the per-minute drain ÷ rate, so a
  //            Growth Potion's op is the ~365c of raws to brew ONE, NOT its (huge, qty×depth) build.
  // Keeping them apart is what lets us charge fertilizer/fuel on the OPERATING axis without the
  // build's depth×quantity blowup. The canonical pick minimises score = build + OP_W·op + coW·waste.
  const NURSERY = new Set(['Nursery', 'World Tree Nursery']);
  const fertItem = (cfg.canonical && cfg.canonical.fertItem) || null;
  const fertNutrientValue = fertItem && db.items[fertItem] ? db.items[fertItem].nutrientValue : null;

  // leaf (build, op) for an item that enters uncrafted. build is the flat "it's one node"; op is
  // the copper it drains. Currency is minted at its copper-equivalent (sellPrice: Copper 1, Silver
  // 1000, Gold 100k) — like the LP — not crafted free via the zero-input mint (excluded above).
  const leaf = (item) => {
    const it = db.items[item];
    if (!it) return null;
    if (it.category === 'Currency' && it.sellPrice != null) return { build: BUY_LEAF, op: it.sellPrice, source: 'mint' };
    if (buyable(item)) return { build: BUY_LEAF, op: it.buyPrice || 0, source: 'buy' };
    return null;
  };

  let solved = null;
  function solve() {
    if (solved) return solved;
    ensureCauldron();
    const items = Object.keys(db.items);
    // Pass 1 computes op() with farming UN-charged for fertilizer — otherwise grown herbs and the
    // fert carrier (itself brewed from a grown herb) are mutually circular and never bootstrap.
    // Pass 1's op(fertCarrier) then prices fertilizer per nutrient as a constant for pass 2, where
    // each nursery recipe pays (nutrientCost/prim)·fertOpPerNutrient on its OPERATING axis. The
    // residual fert-to-grow-fert term is ignored (a few %); it keeps the system finite and stable.
    const pass1 = relax(items, 0);
    let fertOpPerNutrient = 0;
    if (fertItem && fertNutrientValue) {
      const fop = pass1.op.get(fertItem);
      if (isFinite(fop) && fop > 0) fertOpPerNutrient = fop / fertNutrientValue;
    }
    solved = fertOpPerNutrient > 0 ? relax(items, fertOpPerNutrient) : pass1;
    solved.fertOpPerNutrient = fertOpPerNutrient;
    return solved;
  }

  // One min-score fixpoint relaxation tracking build & op separately. fertOpPerNutrient prices
  // a nursery's nutrient draw on the op axis (0 disables it, for pass 1).
  function relax(items, fertOpPerNutrient) {
    const build = new Map();
    const op = new Map();
    const score = new Map();
    const pick = new Map();
    const gB = (n) => (build.has(n) ? build.get(n) : Infinity);
    const gO = (n) => (op.has(n) ? op.get(n) : Infinity);
    const gS = (n) => (score.has(n) ? score.get(n) : Infinity);

    // seed leaves: belt arrivals (free material), buyables, minted currency
    for (const it of items) {
      if (beltItems.has(it)) { build.set(it, 0); op.set(it, 0); score.set(it, 0); pick.set(it, { source: 'belt' }); continue; }
      const lf = leaf(it);
      if (lf) { build.set(it, lf.build); op.set(it, lf.op); score.set(it, lf.build + OP_W * lf.op); pick.set(it, { source: lf.source }); }
    }

    // cauldron input scratch (refreshed each pass): flat build/op arrays so the hot triple loop
    // avoids re-hashing input names — keeps the ~eligibleCount·passes scan cheap.
    const cIn = cauldron ? cauldron.compiled.inputs : null;
    const inB = cIn ? new Float64Array(cIn.length) : null;
    const inO = cIn ? new Float64Array(cIn.length) : null;

    let changed = true;
    let guard = 0;
    while (changed && guard++ <= items.length) {
      changed = false;
      if (cIn) for (let i = 0; i < cIn.length; i++) { inB[i] = gB(cIn[i].name); inO[i] = gO(cIn[i].name); }
      for (const it of items) {
        if (beltItems.has(it)) continue; // fixed free leaf
        const lf = leaf(it);
        let bestS = lf ? lf.build + OP_W * lf.op : Infinity;
        let bestB = lf ? lf.build : Infinity;
        let bestO = lf ? lf.op : Infinity;
        let bestPick = lf ? { source: lf.source } : null;

        for (const r of producersOf.get(it) || []) {
          const inputs = Object.keys(r.inputs || {});
          const prim = r.outputs[it] || 1;
          let bSum = 0, oSum = 0, ok = true;
          for (const inp of inputs) {
            const bb = gB(inp), oo = gO(inp);
            if (!isFinite(bb) || !isFinite(oo)) { ok = false; break; }
            bSum += bb;                          // build: qty-INDEPENDENT (one sub-tile each, fan-out free)
            oSum += (r.inputs[inp] / prim) * oo;  // op: qty-scaled copper per unit of output
          }
          if (!ok) continue;
          if (r.nutrientCost) oSum += (r.nutrientCost / prim) * fertOpPerNutrient; // fertilizer drain
          // Co-product waste: a recipe making the target AND other items dumps those (trash mode).
          // Penalize by dumped value per unit of target, so Rock Salt → Salt + Sand loses for Sand
          // (dumps valuable Salt) but stays fine for Salt (cheap Sand dumped).
          let coWaste = 0;
          for (const [out, q] of Object.entries(r.outputs || {})) {
            if (out === it) continue;
            const f = floor(out);
            if (isFinite(f)) coWaste += (q / prim) * f;
          }
          const b = depthW + widthW * Math.max(0, inputs.length - 1) + bSum;
          const s = b + OP_W * oSum + coW * coWaste;
          if (s < bestS) { bestS = s; bestB = b; bestO = oSum; bestPick = { source: 'recipe', recipe: r }; }
        }

        // Cauldron triples producing `it` (3 inputs → 1 output, qty 1, no co-product). Triples are
        // i≤j≤k sorted, so equal indices are adjacent. build sums DISTINCT inputs (fan-out free);
        // op sums by multiplicity (qty-scaled, prim=1). Equal-score ties break by the static key
        // (fewer distinct inputs, then cheaper raw cauldronCost, then lower index) for stability.
        if (cauldronOn && cauldron) {
          const tris = cauldron.byOutput.get(it);
          if (tris) {
            const { triA, triB, triC } = cauldron.compiled;
            let bestKey = null;
            for (let n = 0; n < tris.length; n++) {
              const t = tris[n];
              const a = triA[t], b2 = triB[t], k = triC[t];
              const ba = inB[a], bb = inB[b2], bk = inB[k];
              const oa = inO[a], ob = inO[b2], okk = inO[k];
              if (!isFinite(ba) || !isFinite(bb) || !isFinite(bk)) continue;
              const allSame = a === k;
              let distinct, bSum, oSum;
              if (allSame) { distinct = 1; bSum = ba; oSum = 3 * oa; }
              else if (a === b2) { distinct = 2; bSum = ba + bk; oSum = 2 * oa + okk; }
              else if (b2 === k) { distinct = 2; bSum = ba + bb; oSum = oa + 2 * ob; }
              else { distinct = 3; bSum = ba + bb + bk; oSum = oa + ob + okk; }
              const b = depthW + widthW * (distinct - 1) + bSum;
              const s = b + OP_W * oSum;
              const costSum = cIn[a].cost + cIn[b2].cost + cIn[k].cost;
              const isBest = s < bestS
                || (s === bestS && bestPick && bestPick.source === 'cauldron'
                  && (distinct < bestKey[0]
                    || (distinct === bestKey[0] && costSum < bestKey[1])
                    || (distinct === bestKey[0] && costSum === bestKey[1] && t < bestKey[2])));
              if (isBest) {
                bestS = s; bestB = b; bestO = oSum;
                bestKey = [distinct, costSum, t];
                const consumes = {};
                for (const idx of [a, b2, k]) consumes[cIn[idx].name] = (consumes[cIn[idx].name] || 0) + 1;
                bestPick = {
                  source: 'cauldron',
                  tripleIndex: t,
                  recipe: {
                    machine: 'Cauldron',
                    inputs: consumes,
                    outputs: { [it]: 1 },
                    baseTime: cauldron.compiled.targets[cauldron.compiled.outIdx[t]].time,
                  },
                };
              }
            }
          }
        }

        if (bestS < gS(it)) { score.set(it, bestS); build.set(it, bestB); op.set(it, bestO); pick.set(it, bestPick); changed = true; }
      }
    }
    return { build, op, score, pick };
  }

  return {
    // tileCost = the selection metric (build + OP_W·op + waste of the chosen recipe). buildCost /
    // opCost expose the two axes separately (opCost is copper per unit of output → ×rate = per-min).
    tileCost: (item) => { if (beltItems.has(item)) return 0; const s = solve(); return s.score.has(item) ? s.score.get(item) : Infinity; },
    buildCost: (item) => { if (beltItems.has(item)) return 0; const s = solve(); return s.build.has(item) ? s.build.get(item) : Infinity; },
    opCost: (item) => { if (beltItems.has(item)) return 0; const s = solve(); return s.op.has(item) ? s.op.get(item) : Infinity; },
    canonicalPick: (item) => {
      if (beltItems.has(item)) return { source: 'belt' };
      return solve().pick.get(item) || null;
    },
    beltItems,
    utilityCarriers,
    buyable,
  };
}

module.exports = { makeComposer, DEPTH_W, WIDTH_W, BUY_LEAF, OP_W_DEFAULT, CO_W };
