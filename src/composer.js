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
const { skillParams } = require('./config');
const { machineHeatPerRun } = require('./normalize');

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
  // Belt supply, with per-item rates (null = unlimited). The chosen fuel/fert CARRIERS are excluded
  // from the free-material belt leaves: a belted carrier is supplied to its TRUNK as a rate cap (see
  // compose()), not consumed as free bulk material — so its production route stays computable for
  // the part of demand the belt can't cover. Non-carrier belt items (coins, etc.) remain free leaves.
  const beltRate = new Map((cfg.belt || []).map((b) => (typeof b === 'string' ? [b, null] : [b.item, b.rate == null ? null : Number(b.rate)])));
  const utilityCarriers = new Set();
  if (cfg.canonical) {
    if (cfg.canonical.fuelItem) utilityCarriers.add(cfg.canonical.fuelItem);
    if (cfg.canonical.fertItem) utilityCarriers.add(cfg.canonical.fertItem);
  }
  const beltItems = new Set([...beltRate.keys()].filter((n) => !utilityCarriers.has(n)));
  // Belt rate cap for a carrier: Infinity if belted with no rate, the rate if belted-with-rate, or 0
  // if not belted at all (→ the whole trunk is produced). null rate ⇒ unlimited belt.
  const beltCapFor = (item) => (beltRate.has(item) ? (beltRate.get(item) == null ? Infinity : beltRate.get(item)) : 0);

  const buyable = (name) => db.items[name] && db.items[name].buyPrice !== undefined && cfg.buy !== false;

  // Net out items that a recipe BOTH consumes and produces (e.g. Steel Ingot's Athanor eats 4 Iron
  // Ingot and returns 3 → net consumes 1). Same as normalize.js netSameItems: without it the DP
  // double-charges (4 Iron Ingot of op AND a false 3-Iron-Ingot co-product-waste penalty) and
  // composition over-sizes the upstream tile 4× while "trashing" the recirculated 90/min. We net at
  // the source so both the metric and compose() see the true net inputs/outputs (and a recipe that
  // nets to zero of an item is no longer registered as a producer of it).
  const netRecipe = (r) => {
    const inputs = { ...(r.inputs || {}) };
    const outputs = { ...(r.outputs || {}) };
    for (const k of Object.keys(outputs)) {
      if (inputs[k] == null) continue;
      const net = outputs[k] - inputs[k];
      delete inputs[k]; delete outputs[k];
      if (net > 0) outputs[k] = net;
      else if (net < 0) inputs[k] = -net;
    }
    return { inputs, outputs };
  };

  // recipes producing each item (tier-gated), with their primary/co outputs
  const producersOf = new Map();
  for (const [id, r] of Object.entries(db.recipes)) {
    if (!tierOk(r.id != null ? (db.items[r.id] ? r.id : id) : id)) { /* gate by outputs below */ }
    const { inputs, outputs } = netRecipe(r);
    // skip currency mints (Bank Portal: copper → coin, zero inputs) — currency is valued at its
    // copper-equivalent (sellPrice) as a leaf, not crafted ~free via a depth stage. (Nurseries
    // are also zero-input but produce herbs, not currency, so they stay.)
    if (Object.keys(outputs).every((o) => db.items[o] && db.items[o].category === 'Currency')) continue;
    // gate: skip recipes whose machine or any input/output is above tier
    if (Object.keys(outputs).some((o) => !tierOk(o))) continue;
    if (Object.keys(inputs).some((i) => !tierOk(i))) continue;
    for (const out of Object.keys(outputs)) {
      if (!producersOf.has(out)) producersOf.set(out, []);
      producersOf.get(out).push({ id, ...r, inputs, outputs }); // netted I/O overrides raw
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
                    baseHeat: cauldron.compiled.targets[cauldron.compiled.outIdx[t]].heat, // per-craft heat draw (Phase 3 sizing)
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

  // ===== Phase 3: composition — expand a canonical pick into a sized tile tree =====
  // Replicated by default (Q1): a shared intermediate gets a private subtree per consumer, so a
  // tile tree is a pure tree (no node dedup). Three things are NOT in the material tree — they are
  // shared TRUNKS the whole build draws from: the canonical FUEL tile (heat), the canonical FERT
  // tile (nutrient), and the MAIN-BELT MONEY line (copper for buys + coin mints). Fuel/fert/money
  // draws are computed per tile and aggregated; the trunks are then composed once at the total rate.
  const params = skillParams(cfg.skills);
  const { speedMult, beltSpeed, fuelMult, fertMult, alchemyMult } = params;
  const machines = db.machines;
  // alchemy machines multiply their output (alchemyMult; Thermal Extractor ×3) — sizing must use
  // the REAL produced qty per run or machine counts overcount. (The selection metric ignores this;
  // it only affects sizing, not which recipe is canonical.)
  const YIELD_MULT_MACHINES = new Set(['Extractor', 'Thermal Extractor', 'Alembic', 'Advanced Alembic']);
  const yieldMultFor = (m) => (YIELD_MULT_MACHINES.has(m) ? alchemyMult * (m === 'Thermal Extractor' ? 3 : 1) : 1);
  // Fuel trunk: heat per unit of the canonical fuel = item.heat × fuelMult (normalize.js burn col).
  const fuelItem = (cfg.canonical && cfg.canonical.fuelItem) || null;
  const fuelHeatPerUnit = fuelItem && db.items[fuelItem] ? (db.items[fuelItem].heat || 0) * fuelMult : 0;
  // Fert trunk: nutrient per unit of the canonical fert = nutrientValue × fertMult; plots are sized
  // by the carrier's maxFertility (same formula as flowgraph.js nurseryPlots).
  const fertCarrier = fertItem; // canonical fert carrier (defined above for the op axis)
  const fertNutrientPerUnit = fertCarrier && db.items[fertCarrier] ? (db.items[fertCarrier].nutrientValue || 0) * fertMult : 0;
  const fertMaxFertility = fertCarrier && db.items[fertCarrier] ? (db.items[fertCarrier].maxFertility || 0) : 0;
  const COINS = new Set(['Copper Coin', 'Silver Coin', 'Gold Coin']);
  const opCostOf = (it) => { if (beltItems.has(it)) return 0; const s = solve(); return s.op.has(it) ? s.op.get(it) : Infinity; };

  // Build the sized subtree for `item` at `rate` items/min, accumulating utility/money draws into
  // `acc`. Replicated: each call returns a fresh subtree. `path` makes node ids unique across
  // replicas; `seen` guards the (provably-acyclic, but defensively bounded) recursion.
  function buildTree(item, rate, path, seen, acc) {
    const id = path;
    if (beltItems.has(item)) return { id, item, source: 'belt', ratePerMin: rate, inputs: [] };
    const pick = solve().pick.get(item);
    if (!pick) return { id, item, source: 'unmakeable', ratePerMin: rate, inputs: [] };
    // Leaves: bought raw, minted coin, or belt arrival. A buy/mint leaf DRAWS COPPER from the main
    // belt money line — never free. A minted coin specifically must link back to that money line
    // (per the cash-provenance rule), so we tag it with the coin item for the Phase-4 wiring.
    if (pick.source === 'buy' || pick.source === 'mint' || pick.source === 'belt') {
      const it = db.items[item];
      let copperPerMin = 0, coinItem = null;
      if (pick.source === 'buy') copperPerMin = (it.buyPrice || 0) * rate;
      else if (pick.source === 'mint') { copperPerMin = (it.sellPrice || 0) * rate; coinItem = COINS.has(item) ? item : null; }
      if (copperPerMin > 0) {
        acc.copperPerMin += copperPerMin;
        if (coinItem) acc.mintedCoins[coinItem] = (acc.mintedCoins[coinItem] || 0) + rate; // coins/min minted → belt money line
      }
      return { id, item, source: pick.source, ratePerMin: rate, copperPerMin, coinItem, fromMoneyLine: copperPerMin > 0, inputs: [] };
    }

    // recipe / cauldron: size the machine, draw heat/nutrient, recurse on (replicated) inputs.
    const r = pick.recipe;
    const machine = r.machine;
    const yieldMult = yieldMultFor(machine);
    const prim = (r.outputs[item] || 1) * yieldMult;
    const runsPerMin = rate / prim;
    const baseTime = r.baseTime || 0;

    let machineCount = null, tileLoad = null, nurseryNote = null;
    if (NURSERY.has(machine)) {
      const nutrientCost = r.nutrientCost || 0;
      const fertilityRate = nutrientCost > 0 && fertMaxFertility ? (60 * fertMaxFertility) / nutrientCost : Infinity;
      const perPlot = Math.min(fertilityRate, beltSpeed);
      if (isFinite(perPlot) && perPlot > 0) {
        tileLoad = rate / perPlot;
        machineCount = Math.ceil(tileLoad - 1e-9);
        nurseryNote = `${perPlot.toFixed(1)}/plot, limited by ${fertilityRate < beltSpeed ? 'fertilizer' : 'belt speed'}`;
      }
    } else if (machine && baseTime > 0) {
      tileLoad = (runsPerMin * baseTime) / (60 * speedMult);
      machineCount = Math.ceil(tileLoad - 1e-9);
    }

    // Heat draw: recipe machines via machineHeatPerRun; cauldron crafts carry per-craft baseHeat.
    const heatPerRun = pick.source === 'cauldron' ? (r.baseHeat || 0) : machineHeatPerRun(machines[machine], machines, baseTime, speedMult);
    const heatPerMin = heatPerRun * runsPerMin;
    const nutrientPerMin = (r.nutrientCost || 0) * runsPerMin;
    acc.heatPerMin += heatPerMin;
    acc.nutrientPerMin += nutrientPerMin;
    const fuelPerMin = fuelHeatPerUnit > 0 ? heatPerMin / fuelHeatPerUnit : 0;
    const fertPerMin = fertNutrientPerUnit > 0 ? nutrientPerMin / fertNutrientPerUnit : 0;

    const seen2 = new Set(seen); seen2.add(item);
    const inputs = [];
    for (const [inItem, qty] of Object.entries(r.inputs || {})) {
      if (seen2.has(inItem)) continue; // defensive: optimal picks are acyclic, but never loop
      inputs.push(buildTree(inItem, qty * runsPerMin, `${path}>${inItem}`, seen2, acc));
    }
    const byproducts = {}; // co-products other than the primary → trash/surplus (v1: no cross-tile feed)
    for (const [out, q] of Object.entries(r.outputs || {})) {
      if (out === item) continue;
      byproducts[out] = q * yieldMult * runsPerMin;
    }
    return {
      id, item, source: pick.source, machine, recipe: r,
      ratePerMin: rate, runsPerMin, machineCount, tileLoad, nurseryNote,
      heatPerMin, fuelPerMin, nutrientPerMin, fertPerMin,
      byproducts, inputs,
    };
  }

  // Sum machine counts across a tree (for the summary / total buildables).
  function tallyMachines(tile, into) {
    if (tile.machine && tile.machineCount) into[tile.machine] = (into[tile.machine] || 0) + tile.machineCount;
    for (const c of tile.inputs || []) tallyMachines(c, into);
    return into;
  }

  // compose(target, rate) → { tree, fuel, fert, totals, summary }. Builds the replicated material
  // tree, then sizes the three shared trunks. Fuel/fert/money draws are LINEAR in rate (pre-ceil),
  // and the fuel/fert carriers THEMSELVES draw heat/nutrient (a Growth-Potion fert tile is heated;
  // a fuel tile may be too) — a small coupled fixpoint. We solve it on the scalar draw rates using
  // each trunk's unit draw (its draw per 1 carrier/min), then build the final trunks once at the
  // resolved rates. Money has no such feedback (buying doesn't cost heat), so it's a plain sum.
  function compose(target, rate) {
    solve();
    const acc = { heatPerMin: 0, nutrientPerMin: 0, copperPerMin: 0, mintedCoins: {} };
    const tree = buildTree(target, rate, target, new Set(), acc);
    const heatMain = acc.heatPerMin, nutrientMain = acc.nutrientPerMin;

    // unit draws: build each trunk at 1 carrier/min to read how much heat/nutrient it itself needs.
    const trunkUnit = (carrier) => {
      if (!carrier) return null;
      const a = { heatPerMin: 0, nutrientPerMin: 0, copperPerMin: 0, mintedCoins: {} };
      buildTree(carrier, 1, `${carrier}#unit`, new Set(), a);
      return { h: a.heatPerMin, n: a.nutrientPerMin };
    };
    const uFuel = fuelHeatPerUnit > 0 ? trunkUnit(fuelItem) : null;
    const uFert = fertNutrientPerUnit > 0 ? trunkUnit(fertCarrier) : null;

    // Belt rate caps: belt supplies up to its rate (free utility), the build PRODUCES the rest.
    // Only the PRODUCED part (Pf, Pg) burns fuel / draws fert (the belt supply doesn't), so just the
    // produced part feeds back in the fixpoint. cap = Infinity (belted, no rate) ⇒ all belt, no
    // feedback; cap = 0 (not belted) ⇒ all produced, full feedback.
    const fuelCap = fuelItem ? beltCapFor(fuelItem) : 0;
    const fertCap = fertCarrier ? beltCapFor(fertCarrier) : 0;
    let F = 0, G = 0;
    for (let i = 0; i < 24; i++) {
      const Pf = Math.max(0, F - fuelCap), Pg = Math.max(0, G - fertCap);
      const totalHeat = heatMain + (uFuel ? Pf * uFuel.h : 0) + (uFert ? Pg * uFert.h : 0);
      const totalNutrient = nutrientMain + (uFuel ? Pf * uFuel.n : 0) + (uFert ? Pg * uFert.n : 0);
      const nF = fuelHeatPerUnit > 0 ? totalHeat / fuelHeatPerUnit : 0;
      const nG = fertNutrientPerUnit > 0 ? totalNutrient / fertNutrientPerUnit : 0;
      if (Math.abs(nF - F) < 1e-9 && Math.abs(nG - G) < 1e-9) { F = nF; G = nG; break; }
      F = nF; G = nG;
    }

    // Split each carrier into a belt-supplied portion (capped) and a produced sub-trunk (the excess).
    const warnings = [];
    const splitTrunk = (item, total, cap, tag) => {
      if (!(total > 1e-9)) return null;
      const beltRateUsed = Math.min(total, cap);
      const prodRate = Math.max(0, total - cap);
      const prodTile = prodRate > 1e-9 ? buildTree(item, prodRate, `${item}#${tag}`, new Set(), acc) : null;
      if (isFinite(cap) && cap > 0 && prodRate > 1e-9) {
        warnings.push(`Belt ${item} supplies ${cap.toFixed(1)}/min; this build needs ${total.toFixed(1)}/min ${tag} — composing the extra ${prodRate.toFixed(1)}/min.`);
      }
      return { item, rate: total, beltRate: beltRateUsed, prodRate, prodTile };
    };
    const fuel = splitTrunk(fuelItem, F, fuelCap, 'fuel');
    const fert = splitTrunk(fertCarrier, G, fertCap, 'fert');

    const machineTotals = {};
    tallyMachines(tree, machineTotals);
    if (fuel && fuel.prodTile) tallyMachines(fuel.prodTile, machineTotals);
    if (fert && fert.prodTile) tallyMachines(fert.prodTile, machineTotals);

    const totals = { heatPerMin: heatMain, nutrientPerMin: nutrientMain, fuelPerMin: F, fertPerMin: G, copperPerMin: acc.copperPerMin, mintedCoins: acc.mintedCoins };
    const summary = {
      target, ratePerMin: rate,
      operatingCopperPerMin: opCostOf(target) * rate, // opCost × rate — the per-min material drain
      copperPerMin: acc.copperPerMin,                  // total copper drawn from the money line
      machineTotals,
      fuelItem, fertItem: fertCarrier,
      fuelPerMin: F, fertPerMin: G,
      mintedCoins: acc.mintedCoins,                    // coins/min minted → must link to the belt money line
      warnings,
    };
    return { tree, fuel, fert, totals, summary };
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
    compose,
    beltItems,
    utilityCarriers,
    buyable,
  };
}

module.exports = { makeComposer, DEPTH_W, WIDTH_W, BUY_LEAF, OP_W_DEFAULT, CO_W };
