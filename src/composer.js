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
const { skillParams, STEAM_EFFICIENCY } = require('./config');
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
// PROFIT MODE (cfg.composer.profit): minimise true OPERATING cost instead of build difficulty — for
// continuous "always running" targets (e.g. dispatch quotas) where material drain, not layout, is
// the cost. OP_W jumps to PROFIT_OP_W (op dominates build) AND the fuel/fert utilities get charged on
// the op axis (see solve()), so the metric's min-op equals true min-COST and won't over-farm "free"
// belted fert. Off by default → ordinary build-first picks are byte-identical.
const PROFIT_OP_W = 1000;

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
    // recirc[k] = the amount of an item a recipe both consumes AND produces, i.e. the
    // portion that loops back into the SAME machine and never leaves it. Netting hides
    // it (it cancels out of inputs/outputs), so a user who knows the raw recipe sees an
    // output with no destination. We carry it so the tile can flag "↻ N recirculated".
    const recirc = {};
    for (const k of Object.keys(outputs)) {
      if (inputs[k] == null) continue;
      const loop = Math.min(inputs[k], outputs[k]);
      if (loop > 0) recirc[k] = loop;
      const net = outputs[k] - inputs[k];
      delete inputs[k]; delete outputs[k];
      if (net > 0) outputs[k] = net;
      else if (net < 0) inputs[k] = -net;
    }
    return { inputs, outputs, recirc };
  };

  // recipes producing each item (tier-gated), with their primary/co outputs
  const producersOf = new Map();
  for (const [id, r] of Object.entries(db.recipes)) {
    if (!tierOk(r.id != null ? (db.items[r.id] ? r.id : id) : id)) { /* gate by outputs below */ }
    const { inputs, outputs, recirc } = netRecipe(r);
    // skip currency mints (Bank Portal: copper → coin, zero inputs) — currency is valued at its
    // copper-equivalent (sellPrice) as a leaf, not crafted ~free via a depth stage. (Nurseries
    // are also zero-input but produce herbs, not currency, so they stay.)
    if (Object.keys(outputs).every((o) => db.items[o] && db.items[o].category === 'Currency')) continue;
    // gate: skip recipes whose machine or any input/output is above tier. The machine check is
    // load-bearing for grown crops — herbs (Sage t3, Flax t2) carry an explicit item tier BELOW
    // the Nursery (t4) that grows them, and tiers.js never overrides an explicit tier, so gating
    // by output tier alone lets a sub-tier Nursery through. (The Cauldron is gated the same way
    // at cauldronOn below.)
    if (maxTier != null && r.machine && T.machineTier(r.machine) > maxTier) continue;
    if (Object.keys(outputs).some((o) => !tierOk(o))) continue;
    if (Object.keys(inputs).some((i) => !tierOk(i))) continue;
    for (const out of Object.keys(outputs)) {
      if (!producersOf.has(out)) producersOf.set(out, []);
      producersOf.get(out).push({ id, ...r, inputs, outputs, recirc }); // netted I/O overrides raw
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
  const profitMode = !!cc.profit; // minimise true op cost + charge fuel/fert utilities (see solve())
  // Central steam: heat comes from a centrally-plumbed steam supply, so the FUEL trunk is fully
  // supplied (cap Infinity → no produced fuel trunk/furnaces/self-fuel) and the heat charge is
  // either free or the fuel value ÷ STEAM_EFFICIENCY. Affects fuel only; fert is untouched.
  const steamOn = !!(cfg.steam && cfg.steam.enabled);
  const steamCost = steamOn && cfg.steam.mode === 'cost';
  const depthW = cc.depthW != null ? cc.depthW : DEPTH_W;
  const widthW = cc.widthW != null ? cc.widthW : WIDTH_W;
  const OP_W = cc.opW != null ? cc.opW : (profitMode ? PROFIT_OP_W : OP_W_DEFAULT);
  const coW = cc.coW != null ? cc.coW : CO_W;
  const cParams = skillParams(cfg.skills); // heat/speed multipliers, for the profit-mode fuel charge
  const fuelItemC = (cfg.canonical && cfg.canonical.fuelItem) || null;
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
    // Value a utility carrier per its consumed unit: in PROFIT MODE a BELTED carrier is charged its
    // sell value (the profit stat's basis — what you forgo by burning/fertilising with it), a PRODUCED
    // carrier its pass-1 production cost. Outside profit mode fert keeps the old production-cost charge
    // and fuel stays free, so picks don't move.
    const carrierOpValue = (item) => {
      const prodOp = pass1.op.get(item);
      if (profitMode && beltCapFor(item) > 0) return db.items[item] && db.items[item].sellPrice || 0;
      return prodOp;
    };
    // Nutrient pricing (per-crop, throughput-aware). A grown crop is NEVER free — it costs the
    // nutrient consumed to grow it, priced at the cost-per-nutrient of the fertilizer you'd actually
    // use for THAT crop. You fertilise each crop with the CHEAPEST fertilizer that still grows it at
    // full belt speed: the nursery's grow rate is min(60·maxFertility/nutrientCost, beltSpeed), so a
    // fert sustains full speed iff maxFertility ≥ nutrientCost·beltSpeed/60. Below that the plot is
    // fert-throttled to a crawl (Chamomile on Basic Fert = 1/min vs 60/min on Growth Potion), so a
    // cheaper-but-weaker fert isn't a real option; a stronger one (Panacea on a low-tier crop) is
    // needless. This mirrors the game's tier design — the sustaining fert unlocks at ~the crop's tier
    // (Chamomile t6 ↔ Growth Potion t6). Each fert's own cost-per-nutrient is circular (it contains
    // grown crops), so solve the coupled FIXPOINT at a STABLE op weight (OP_W_DEFAULT, NOT the profit
    // metric's OP_W) so profit-mode op-minimisation can't route a carrier through a degenerate
    // "grow everything for free" path and collapse the price to 0. Bought-raw inputs (Growth Potion's
    // clay←Logs, brine←Rock Salt) anchor every fert above zero, so the fixpoint is positive and finite.
    const fertList = Object.entries(db.items)
      .filter(([n, it]) => it.nutrientValue > 0 && it.maxFertility > 0 && tierOk(n))
      .map(([n, it]) => ({ item: n, nv: it.nutrientValue, mf: it.maxFertility }));
    const strongest = fertList.reduce((a, f) => (!a || f.mf > a.mf ? f : a), null); // best-effort if none sustain
    const cpnOf = (f, s) => {
      if (profitMode && beltCapFor(f.item) > 0) return ((db.items[f.item] && db.items[f.item].sellPrice) || 0) / f.nv; // belted → forgone sale
      const op = s.op.get(f.item);
      return (isFinite(op) && op > 0) ? op / f.nv : Infinity;
    };
    // copper per nutrient for a crop needing `nc`: cheapest fert that sustains it at full belt speed.
    const rateFn = (cpn) => (nc) => {
      if (!(nc > 0) || !fertList.length) return 0;
      const need = (nc * cParams.beltSpeed) / 60; // maxFertility required for full belt speed
      let best = Infinity;
      for (const f of fertList) if (f.mf >= need) { const c = cpn.get(f.item); if (c < best) best = c; }
      if (isFinite(best)) return best;
      const sc = strongest ? cpn.get(strongest.item) : 0; // none sustain → strongest available (throttled)
      return isFinite(sc) ? sc : 0;
    };
    let cpn = new Map(fertList.map((f) => [f.item, 0]));
    for (let i = 0; i < 16 && fertList.length; i++) {
      const s = relax(items, rateFn(cpn), 0, OP_W_DEFAULT);
      const next = new Map(); let changed = false;
      for (const f of fertList) {
        const v = cpnOf(f, s); const vv = isFinite(v) ? v : 0;
        next.set(f.item, vv);
        if (Math.abs(vv - cpn.get(f.item)) > 1e-9 * (1 + vv)) changed = true;
      }
      cpn = next;
      if (!changed) break;
    }
    const fertOpPerNutrient = rateFn(cpn); // FUNCTION: a crop's nutrientCost → copper/nutrient
    let fuelOpPerHeat = 0;
    if (profitMode && fuelItemC && db.items[fuelItemC]) {
      const heatPerCarrier = (db.items[fuelItemC].heat || 0) * cParams.fuelMult;
      const fval = carrierOpValue(fuelItemC);
      if (heatPerCarrier > 0 && isFinite(fval) && fval > 0) fuelOpPerHeat = fval / heatPerCarrier;
      // Central steam changes the per-heat charge the metric sees so picks don't avoid heat that
      // is free (or over-pay for it): free → 0 (heat is free), cost → inflated by the steam loss.
      if (steamOn) fuelOpPerHeat = steamCost ? fuelOpPerHeat / STEAM_EFFICIENCY : 0;
      // per-run heat for every non-cauldron recipe (static: machine + baseTime + speed), charged below
      if (fuelOpPerHeat > 0) for (const arr of producersOf.values()) for (const r of arr) {
        if (r._heatPerRun == null) r._heatPerRun = r.machine ? machineHeatPerRun(db.machines[r.machine], db.machines, r.baseTime || 0, cParams.speedMult) : 0;
      }
    }
    solved = (fertList.length || fuelOpPerHeat > 0) ? relax(items, fertOpPerNutrient, fuelOpPerHeat) : pass1;
    return solved;
  }

  // One min-score fixpoint relaxation tracking build & op separately. fertOpPerNutrient prices
  // a nursery's nutrient draw on the op axis (0 disables it, for pass 1).
  function relax(items, fertOpPerNutrient, fuelOpPerHeat = 0, opW = OP_W) {
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
      if (lf) { build.set(it, lf.build); op.set(it, lf.op); score.set(it, lf.build + opW * lf.op); pick.set(it, { source: lf.source }); }
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
        let bestS = lf ? lf.build + opW * lf.op : Infinity;
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
          if (r.nutrientCost) oSum += (r.nutrientCost / prim) * (typeof fertOpPerNutrient === 'function' ? fertOpPerNutrient(r.nutrientCost) : fertOpPerNutrient); // fertilizer drain (per-crop rate)
          if (fuelOpPerHeat && r._heatPerRun) oSum += (r._heatPerRun / prim) * fuelOpPerHeat; // fuel/heat drain
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
          const s = b + opW * oSum + coW * coWaste;
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
              if (fuelOpPerHeat) oSum += cauldron.compiled.targets[cauldron.compiled.outIdx[t]].heat * fuelOpPerHeat; // cauldron craft heat
              const b = depthW + widthW * (distinct - 1) + bSum;
              const s = b + opW * oSum;
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

  // "Carrier as material" merge. The rule "belt fuel/fert ≠ free material" stops a BELTED carrier
  // from free-riding as a bulk ingredient. But when a recipe eats the carrier as material (Steel
  // Ingot's Athanor eats Coke Powder as carbon) AND the carrier is PRODUCED in-build (no belt supply,
  // beltCap 0), the dedicated carrier line already pays full production — so route the material draw
  // to THAT line instead of rebuilding the same chain inside every consumer tile. One consolidated
  // Coke Powder line feeds both fuel and material, rather than a fuel line plus a duplicate inline
  // chain. Guard on beltCap 0: a belted carrier (e.g. Growth Potion @60) still must NOT merge.
  const mergeMaterialInto = (it) => {
    // Under central steam the fuel trunk is steam-supplied (no production line), so there's no
    // produced fuel line to merge material into — the material must be produced inline at real
    // cost (steam delivers heat, not atoms). So fuel never merges when steamOn.
    if (it === fuelItem && fuelHeatPerUnit > 0 && beltCapFor(fuelItem) === 0 && !steamOn) return true;
    if (it === fertCarrier && fertNutrientPerUnit > 0 && beltCapFor(fertCarrier) === 0) return true;
    return false;
  };

  // Build the sized subtree for `item` at `rate` items/min, accumulating utility/money draws into
  // `acc`. Replicated: each call returns a fresh subtree. `path` makes node ids unique across
  // replicas; `seen` guards the (provably-acyclic, but defensively bounded) recursion.
  //
  // Cross-tile co-product feeds (Phase 7 / reuse mode): `coBudget` is a SHARED, mutable Map of
  // item → unclaimed co-product supply (a global pool, drained greedily in walk order). Before
  // building dedicated production of an input, a consumer DRAWS from this pool — `min(avail, need)`
  // — so a co-product (e.g. the Sand thrown off by Rock-Salt → Salt) offsets the demand it would
  // otherwise build a private farm for (the Sand for Glass). The claimed draw is pushed to `coFeeds`
  // (`{ item, rate, consumerId }`) so compose-graph can wire the source tile → this consumer. Pass
  // coBudget = null to disable feeds (trash mode, and the unit/trunk probes, which don't participate).
  function buildTree(item, rate, path, seen, acc, coBudget = null, coFeeds = null, allowMerge = true) {
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
      let needRate = qty * runsPerMin;
      // Reuse mode: cover part of this input from the shared co-product pool before building it.
      // Only for items genuinely co-produced elsewhere (in coBudget) and not free belt leaves
      // (a belt arrival is already free, so co-feeding it saves nothing).
      if (coBudget && !beltItems.has(inItem)) {
        const avail = coBudget.get(inItem) || 0;
        if (avail > 1e-9) {
          const take = Math.min(avail, needRate);
          coBudget.set(inItem, avail - take);
          needRate -= take;
          if (coFeeds && take > 1e-9) coFeeds.push({ item: inItem, rate: take, consumerId: id });
        }
      }
      // Carrier-as-material merge: a produced fuel/fert carrier eaten as an ingredient is sourced from
      // its dedicated trunk (recorded here, sized into the trunk in compose()), not rebuilt inline.
      if (allowMerge && needRate > 1e-9 && mergeMaterialInto(inItem)) {
        acc.carrierMaterial[inItem] = (acc.carrierMaterial[inItem] || 0) + needRate;
        acc.carrierMaterialFeeds.push({ item: inItem, rate: needRate, consumerId: id });
        continue;
      }
      if (needRate > 1e-9) inputs.push(buildTree(inItem, needRate, `${path}>${inItem}`, seen2, acc, coBudget, coFeeds, allowMerge));
    }
    const byproducts = {}; // co-products other than the primary → offered to the shared coSupply pool (Phase 7)
    for (const [out, q] of Object.entries(r.outputs || {})) {
      if (out === item) continue;
      byproducts[out] = q * yieldMult * runsPerMin;
    }
    // Items the recipe loops back into itself (raw in ∩ out). Net inputs already account
    // for them, so they need no upstream supply — but surface the rate so the tile can
    // show "↻ N/min recirculated" instead of leaving the raw co-output looking orphaned.
    const recirc = [];
    for (const [out, q] of Object.entries(r.recirc || {})) {
      if (q * runsPerMin > 1e-9) recirc.push({ item: out, ratePerMin: q * runsPerMin });
    }
    return {
      id, item, source: pick.source, machine, recipe: r,
      ratePerMin: rate, runsPerMin, machineCount, tileLoad, nurseryNote,
      heatPerMin, fuelPerMin, nutrientPerMin, fertPerMin,
      byproducts, recirc, inputs,
    };
  }

  // Gross co-product supply per item across a tree (the pool available to feed cross-tile demand).
  // Gross = the byproduct a tile makes regardless of whether it's later claimed — claiming offsets
  // the CONSUMER's dedicated production, never the source's output, so this stays the true supply.
  function measureCoSupply(tile, into) {
    for (const [b, r] of Object.entries(tile.byproducts || {})) into.set(b, (into.get(b) || 0) + r);
    for (const c of tile.inputs || []) measureCoSupply(c, into);
    return into;
  }
  const freshAcc = () => ({ heatPerMin: 0, nutrientPerMin: 0, copperPerMin: 0, mintedCoins: {}, carrierMaterial: {}, carrierMaterialFeeds: [] });
  const aggregateFeeds = (coFeeds) => {
    const m = new Map();
    for (const f of coFeeds) m.set(f.item, (m.get(f.item) || 0) + f.rate);
    return [...m].map(([item, rate]) => ({ item, rate }));
  };
  const mapsClose = (a, b) => {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (Math.abs((b.get(k) || 0) - v) > 1e-6) return false;
    return true;
  };

  // Sum machine counts across a tree (for the summary / total buildables).
  function tallyMachines(tile, into) {
    if (tile.machine && tile.machineCount) into[tile.machine] = (into[tile.machine] || 0) + tile.machineCount;
    for (const c of tile.inputs || []) tallyMachines(c, into);
    return into;
  }

  // Heated machines slot into a parent furnace (the heat generator / "heating device"): a Stone
  // Furnace has `slots`; a Crucible needs slotsRequired 3, a Kiln 6. Sum the slots each furnace
  // type must host so compose() can count the PHYSICAL furnaces = ceil(slotsUsed / slots). Furnaces
  // are shared across heated machine types (one Stone Furnace can hold a Kiln + a Crucible).
  function tallyFurnaceSlots(tile, into) {
    const m = tile.machine && tile.machineCount ? machines[tile.machine] : null;
    if (m && m.parent && m.slotsRequired && machines[m.parent] && machines[m.parent].slots) {
      into[m.parent] = (into[m.parent] || 0) + tile.machineCount * m.slotsRequired;
    }
    for (const c of tile.inputs || []) tallyFurnaceSlots(c, into);
    return into;
  }

  // compose(target, rate) → { tree, fuel, fert, totals, summary }. Builds the replicated material
  // tree, then sizes the three shared trunks. Fuel/fert/money draws are LINEAR in rate (pre-ceil),
  // and the fuel/fert carriers THEMSELVES draw heat/nutrient (a Growth-Potion fert tile is heated;
  // a fuel tile may be too) — a small coupled fixpoint. We solve it on the scalar draw rates using
  // each trunk's unit draw (its draw per 1 carrier/min), then build the final trunks once at the
  // resolved rates. Money has no such feedback (buying doesn't cost heat), so it's a plain sum.
  function compose(targetsArg, rateArg) {
    solve();
    // Accept compose('Item', rate) [back-compat] OR compose([{ item, rate }, …]) [target forest].
    const targets = typeof targetsArg === 'string' ? [{ item: targetsArg, rate: rateArg }] : targetsArg.slice();
    const single = targets.length === 1;

    // Trunk unit draws + belt caps (independent of the main tree) — computed up front because the
    // self-fueling-line collapse must know GROSS before building anything.
    const trunkUnit = (carrier) => {
      if (!carrier) return null;
      const a = { heatPerMin: 0, nutrientPerMin: 0, copperPerMin: 0, mintedCoins: {}, carrierMaterial: {}, carrierMaterialFeeds: [] };
      buildTree(carrier, 1, `${carrier}#unit`, new Set(), a, null, null, false);
      return { h: a.heatPerMin, n: a.nutrientPerMin };
    };
    const uFuel = fuelHeatPerUnit > 0 ? trunkUnit(fuelItem) : null;
    const uFert = fertNutrientPerUnit > 0 ? trunkUnit(fertCarrier) : null;
    const fuelCap = steamOn && fuelItem ? Infinity : (fuelItem ? beltCapFor(fuelItem) : 0);
    const fertCap = fertCarrier ? beltCapFor(fertCarrier) : 0;
    // Self-fueling line: when the TARGET *is* the fuel carrier, one over-producing line feeds its own
    // heated machines — no separate fuel trunk (the target line and the trunk would otherwise be two
    // copies of the same item). kf = fuel burned per carrier unit produced (uFuel.h/fuelHeatPerUnit);
    // GROSS = rate/(1-kf), NET out = rate, self-fuel = GROSS-rate looped back to its own furnaces.
    // kf<1 ⇒ the carrier nets positive fuel (else it can't self-sustain → fall back to the normal path).
    // Skipped under central steam or a belt cap, where the heat is sourced elsewhere. This collapse is
    // a SINGLE-target affair — producing the fuel carrier alongside other targets is rejected upstream
    // (composerSolve), so a multi-target forest never self-fuels.
    const kf = uFuel && fuelHeatPerUnit > 0 ? uFuel.h / fuelHeatPerUnit : 0;
    let selfFuelLine = !!(single && fuelItem && targets[0].item === fuelItem && !steamOn && !(fuelCap > 0) && kf > 1e-9 && kf < 1 - 1e-9);
    // Self-ferting line: the fert mirror of the above. When the TARGET *is* the fert carrier and that
    // carrier is grown from fertilized crops (kg = nutrient drawn per carrier unit / nutrient it
    // provides, uFert.n/fertNutrientPerUnit), one over-producing line fertilizes its own nurseries —
    // no separate fert trunk. No steam analogue for fert, so no steam gate. 0<kg<1 ⇒ self-sustaining.
    const kg = uFert && fertNutrientPerUnit > 0 ? uFert.n / fertNutrientPerUnit : 0;
    let selfFertLine = !!(single && fertCarrier && targets[0].item === fertCarrier && !(fertCap > 0) && kg > 1e-9 && kg < 1 - 1e-9);
    // A carrier that is BOTH fuel and fert (e.g. Panacea Potion) loops BOTH heat AND nutrient back into
    // itself, so GROSS = rate/(1-kf-kg) covers both draws at once. That only sustains if kf+kg<1; if the
    // two self-draws together exceed one unit, no single line can feed both — fall back to normal trunks.
    if (selfFuelLine && selfFertLine && kf + kg >= 1 - 1e-9) { selfFuelLine = false; selfFertLine = false; }
    const kSelf = (selfFuelLine ? kf : 0) + (selfFertLine ? kg : 0);
    const rateOf = (t) => (kSelf > 1e-9 ? t.rate / (1 - kSelf) : t.rate); // gross build rate per target
    const rate = single ? targets[0].rate : null;        // NET rate — back-compat scalar for summary/fuel
    const grossRate = single ? rateOf(targets[0]) : null; // back-compat scalar (== rate unless self-fueling)

    // Carrier-as-target (multi-target): a target that IS the fuel/fert carrier gets NO separate tree —
    // its net output demand (Df / Dg) folds into the shared trunk, which already over-produces for the
    // whole build's heat/nutrient + its own self-heat. That one trunk line then feeds BOTH the heated
    // machines AND this target's demand sink (wired in compose-graph). Folds only when the carrier is
    // produced from scratch (cap 0), not steam-supplied, and can self-sustain (fuel 0<kf<1, fert 0<kg<1);
    // otherwise it stays an ordinary tree. SINGLE-target carrier keeps the self-feed collapse (grossRate).
    let Df = 0, Dg = 0;
    const carrierTargets = new Set();
    if (!single) for (const t of targets) {
      if (fuelItem && t.item === fuelItem && !steamOn && fuelCap === 0 && kf > 1e-9 && kf < 1 - 1e-9) { Df += t.rate; carrierTargets.add(t.item); }
      else if (fertCarrier && t.item === fertCarrier && fertCap === 0 && kg > 1e-9 && kg < 1 - 1e-9) { Dg += t.rate; carrierTargets.add(t.item); }
    }
    const buildTargets = carrierTargets.size ? targets.filter((t) => !carrierTargets.has(t.item)) : targets;

    // Phase 7 — co-product reuse. A co-product offsets dedicated production of the same item ANYWHERE
    // in the build: the Sand thrown off making Saturn's Salt covers part of the Sand for its Glass; the
    // Charcoal Coke co-produces re-grinds into the Charcoal Powder Coke itself eats; the Plank a Gloom-
    // Fungus line throws off feeds another target's Plank demand instead of buying Logs. Recycling what
    // a line already makes is free and must never be trashed when ANOTHER line wants it — be it a
    // sibling target tree OR a fuel/fert trunk. byproducts.mode governs only the UNCLAIMED surplus.
    //
    // The pool is GLOBAL across the whole forest AND the fuel/fert trunks, so it can't be one forward
    // pass: a trunk's co-supply (e.g. the Plank off the fert carrier's Gloom-Fungus line) must reach a
    // target tree built earlier, and a target's co-supply must reach the trunks built later. So the
    // entire build (forest → trunk sizing → trunk prodTiles) runs inside an outer fixpoint over
    // `coSupply` — the gross co-product supply of everything built last round. Each round drains a
    // fresh copy as lines claim from it (greedy, walk order) then re-measures the gross supply; claims
    // only ever shrink dedicated production, so it settles in a couple of rounds (bounded + early-exit).
    let coSupply = new Map();
    let trees, tree, acc, coFeeds, heatMain, nutrientMain, Mf, Mg, F, G, fuel, fert, warnings;
    let prevSupply = null;
    for (let outer = 0; outer < 8; outer++) {
      acc = freshAcc();
      coFeeds = []; // { item, rate, consumerId } — claimed cross-line co-product draws (graph wiring)
      warnings = [];
      const coBudget = new Map(coSupply); // drained as the forest + trunks claim from the shared pool
      // Forest: each target → its own replicated subtree, ALL sharing one acc (heat / nutrient / money /
      // carrier-material draws sum across the whole build) and ONE drained coBudget / coFeeds pool — so a
      // co-product thrown off by ANY line (a target tree, or via coSupply a fuel/fert trunk) offsets any
      // other line's demand. The shared fuel/fert/money trunks below are sized from the combined acc.
      trees = buildTargets.map((t) => ({ item: t.item, rate: t.rate, tree: buildTree(t.item, rateOf(t), t.item, new Set(), acc, coBudget, coFeeds) }));
      tree = trees.length ? trees[0].tree : null; // back-compat alias (single-target == the one root)
      heatMain = acc.heatPerMin; nutrientMain = acc.nutrientPerMin;
      // Carrier-as-material demand merged out of the inline tree (Mf/Mg). It's PRODUCED (the merge only
      // fires when beltCap 0), so it adds to the dedicated trunk's output AND draws self-heat/nutrient
      // there — folded into the fixpoint below, sized into the trunk via splitTrunk(F+Mf), and the
      // unit/trunk builds (which produce the carrier itself) pass allowMerge=false so they never merge.
      Mf = (fuelItem && acc.carrierMaterial[fuelItem]) || 0;
      Mg = (fertCarrier && acc.carrierMaterial[fertCarrier]) || 0;

      // Belt rate caps: belt supplies up to its rate (free utility), the build PRODUCES the rest.
      // Only the PRODUCED part (Pf, Pg) burns fuel / draws fert (the belt supply doesn't), so just the
      // produced part feeds back in the fixpoint. cap = Infinity (belted, no rate) ⇒ all belt, no
      // feedback; cap = 0 (not belted) ⇒ all produced, full feedback.
      // Central steam fully supplies the fuel trunk (cap Infinity) → produced part Pf = 0, so no fuel
      // production line / furnaces / self-fuel loops; heat is drawn from the central steam source.
      F = 0; G = 0;
      for (let i = 0; i < 24; i++) {
        const Pf = Math.max(0, F - fuelCap), Pg = Math.max(0, G - fertCap);
        // (Pf + Mf): the produced carrier the trunk makes is the fuel excess PLUS the merged material,
        // and BOTH portions draw self-heat/nutrient (same coke chain), so both feed the fixpoint.
        // (Pf + Mf + Df): the produced fuel carrier covers heat-excess + material + any folded net-output
        // demand, and ALL of it self-heats/-nutrients. Same for the fert carrier (Pg + Mg + Dg).
        const totalHeat = heatMain + (uFuel ? (Pf + Mf + Df) * uFuel.h : 0) + (uFert ? (Pg + Mg + Dg) * uFert.h : 0);
        const totalNutrient = nutrientMain + (uFuel ? (Pf + Mf + Df) * uFuel.n : 0) + (uFert ? (Pg + Mg + Dg) * uFert.n : 0);
        const nF = fuelHeatPerUnit > 0 ? totalHeat / fuelHeatPerUnit : 0;
        const nG = fertNutrientPerUnit > 0 ? totalNutrient / fertNutrientPerUnit : 0;
        if (Math.abs(nF - F) < 1e-9 && Math.abs(nG - G) < 1e-9) { F = nF; G = nG; break; }
        F = nF; G = nG;
      }

      // Split each carrier into a belt-supplied portion (capped) and a produced sub-trunk (the excess).
      // The prodTile is built ONCE against the shared coBudget — within-trunk reuse (the fuel line's Coke
      // re-grinding its Charcoal) now flows through coSupply, the same global pool, so a trunk co-product
      // can feed a target tree (and vice versa) instead of being trashed behind a trunk-local fixpoint.
      const splitTrunk = (item, total, cap, tag) => {
        if (!(total > 1e-9)) return null;
        const beltRateUsed = Math.min(total, cap);
        const prodRate = Math.max(0, total - cap);
        const prodTile = prodRate > 1e-9 ? buildTree(item, prodRate, `${item}#${tag}`, new Set(), acc, coBudget, coFeeds, false) : null;
        if (isFinite(cap) && cap > 0 && prodRate > 1e-9) {
          warnings.push(`Belt ${item} supplies ${cap.toFixed(1)}/min; this build needs ${total.toFixed(1)}/min ${tag} — composing the extra ${prodRate.toFixed(1)}/min.`);
        }
        return { item, rate: total, beltRate: beltRateUsed, prodRate, prodTile };
      };
      // total trunk = fuel/fert demand + the merged carrier-as-material demand (Mf/Mg, all produced).
      // Self-fueling line: the target line IS the fuel source (built at GROSS above), so there is no
      // separate fuel trunk — point the trunk at the target tree itself; compose-graph then wires the
      // heat edges as a self-loop (line output → its own furnaces). The NET belt output is `rate`.
      fuel = selfFuelLine
        ? { item: fuelItem, rate: grossRate, beltRate: 0, prodRate: grossRate, prodTile: tree, selfFuelLine: true, netRate: rate, selfFuel: grossRate - rate }
        : splitTrunk(fuelItem, F + Mf + Df, fuelCap, 'fuel');
      // Self-ferting line (target IS the fert carrier): mirror of the fuel self-loop — the target line is
      // built at GROSS above, so there is no separate fert trunk; point it at the target tree itself and
      // compose-graph wires the nutrient edges as a self-loop (line output → its own nurseries).
      fert = selfFertLine
        ? { item: fertCarrier, rate: grossRate, beltRate: 0, prodRate: grossRate, prodTile: tree, selfFertLine: true, netRate: rate, selfFert: grossRate - rate }
        : splitTrunk(fertCarrier, G + Mg + Dg, fertCap, 'fert');

      // Re-measure the gross co-supply built this round (forest trees + the non-self trunk prodTiles)
      // and feed it back. A trunk prodTile that IS a target root (self-fuel/fert line) is already
      // counted in the forest walk, so skip it. Converged once the supply map stops changing.
      const builtRoots = new Set(trees.map((t) => t.tree));
      const measured = new Map();
      for (const t of trees) measureCoSupply(t.tree, measured);
      if (fuel && fuel.prodTile && !builtRoots.has(fuel.prodTile)) measureCoSupply(fuel.prodTile, measured);
      if (fert && fert.prodTile && !builtRoots.has(fert.prodTile)) measureCoSupply(fert.prodTile, measured);
      if (prevSupply && mapsClose(measured, prevSupply)) break;
      prevSupply = measured; coSupply = measured;
    }

    const treeSet = new Set(trees.map((t) => t.tree)); // roots already tallied (a self-fuel trunk reuses one)
    const machineTotals = {};
    for (const t of trees) tallyMachines(t.tree, machineTotals);
    // Skip a trunk's prodTile when it IS a target root (self-fueling line) — else we'd double-count
    // the single line's machines.
    if (fuel && fuel.prodTile && !treeSet.has(fuel.prodTile)) tallyMachines(fuel.prodTile, machineTotals);
    if (fert && fert.prodTile && !treeSet.has(fert.prodTile)) tallyMachines(fert.prodTile, machineTotals);
    // Heating devices: count the parent furnaces that host the heated machines (slot-packed),
    // so the build shows e.g. "2× Stone Furnace" behind the 4 Crucibles. The leftover slots in
    // the last (partial) furnace are the source of the "awkward count" — they still get built.
    // Furnaces are infrastructure, NOT production machines, so they stay in their own `furnaces`
    // tally and are deliberately kept OUT of machineTotals (the production-machine summary).
    const furnaceSlots = {};
    for (const t of trees) tallyFurnaceSlots(t.tree, furnaceSlots);
    if (fuel && fuel.prodTile && !treeSet.has(fuel.prodTile)) tallyFurnaceSlots(fuel.prodTile, furnaceSlots);
    if (fert && fert.prodTile && !treeSet.has(fert.prodTile)) tallyFurnaceSlots(fert.prodTile, furnaceSlots);
    const furnaces = {};
    for (const [fname, used] of Object.entries(furnaceSlots)) {
      const fc = Math.ceil(used / machines[fname].slots - 1e-9);
      if (fc > 0) furnaces[fname] = fc;
    }

    const totals = { heatPerMin: heatMain, nutrientPerMin: nutrientMain, fuelPerMin: F, fertPerMin: G, copperPerMin: acc.copperPerMin, mintedCoins: acc.mintedCoins };
    // Folded carrier targets (Df/Dg) have no tree — their demand sinks are fed from the trunk root.
    const trunkDemands = [];
    if (Df > 1e-9 && fuelItem) trunkDemands.push({ item: fuelItem, rate: Df, trunk: 'fuel' });
    if (Dg > 1e-9 && fertCarrier) trunkDemands.push({ item: fertCarrier, rate: Dg, trunk: 'fert' });
    const summary = {
      target: targets[0].item, ratePerMin: targets[0].rate, // back-compat: first target (single-target unchanged)
      targets: targets.map((t) => ({ item: t.item, ratePerMin: t.rate })), // every target, incl. folded carriers
      operatingCopperPerMin: targets.reduce((s, t) => s + opCostOf(t.item) * t.rate, 0), // Σ opCost × rate
      copperPerMin: acc.copperPerMin,                  // total copper drawn from the money line
      machineTotals,
      furnaces,                                        // { "Stone Furnace": 2 } — heating devices hosting the heated machines
      fuelItem, fertItem: fertCarrier,
      fuelPerMin: F, fertPerMin: G,
      mintedCoins: acc.mintedCoins,                    // coins/min minted → must link to the belt money line
      coproductFeeds: aggregateFeeds(coFeeds),         // [{ item, rate }] co-product reused across tiles
      warnings,
    };
    return { tree, trees, fuel, fert, totals, coFeeds, carrierMaterial: acc.carrierMaterialFeeds, trunkDemands, summary };
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
