# Tile-Composer — design

A second solver for the **"Simplest"** mode. The LP stays the engine for *Cheapest /
Balanced* (global copper minimization). "Simplest" switches to **deterministic tile
composition**: pick one canonical way to make each item, then compose the target out of
tiles, recursively, down to bought raws and main-belt inputs.

This is the natural endpoint of everything this session has pushed toward — self-contained,
buy-raw, simplest-to-build, droppable, composable blueprints — and it retires the
degeneracy whack-a-mole (free Gloom-Fungus loops, 2400/min Plank trash, minted coins) that
comes from bending a cost-optimizer into a tile-builder.

---

## ⭐ IMPLEMENTED MODEL (as built — supersedes the exploratory metric prose below)

`makeComposer(db, cfg)` → `{ tileCost, buildCost, opCost, canonicalPick, beltItems, utilityCarriers, buyable }`.
Phases **1 (canonical-recipe DP) and 2 (cauldron triples) are done and unit-tested**
(`test/composer.test.js`); not yet wired to the server. The picker is a **fixpoint relaxation**,
not the recursive memo originally sketched here (the recipe DAG has cycles — cauldron outputs are
also inputs — and a memo poisons across queries; positive weights mean optimal tiles are acyclic,
so the least fixpoint computed by relaxation is correct, context-free, ~75ms).

**The metric tracks TWO independent quantities per item, each per UNIT OF OUTPUT** — this replaced
the original single `tileCost` once we found the single scalar conflated structure with cost (a
Growth Potion's value blew up to ~165k because `Brine:80` × a depth stage; its real per-potion
copper is ~584):

- **`build`** — structural "how hard to lay out": `DEPTH_W` per stage + `WIDTH_W` per extra
  distinct input belt, summed down the chain. **Quantity-INDEPENDENT** (fan-out is free — needing
  6 Sand doesn't make Glass 6× harder to build; you replicate the Sand tile).
- **`op`** — operating cost: copper consumed per unit of output, propagated by stoichiometry
  (`qty/prim`). This is the per-minute drain ÷ rate. `opCost(item) × rate` = copper/min (Phase 3).

`score = build + OP_W·op + CO_W·coWaste` is minimised to pick the canonical recipe. Weights
(`composer.js`, all overridable via `cfg.composer.{depthW,widthW,opW,coW}`): `DEPTH_W 1500,
WIDTH_W 250, BUY_LEAF 40, OP_W 2, CO_W 30`.

Leaves & special handling:
- **Buyable**: `build = BUY_LEAF`, `op = buyPrice`.
- **Currency** (Copper/Silver/Gold Coin): minted at copper-equivalent — `build = BUY_LEAF`,
  `op = sellPrice` (1 / 1000 / 100k). The free zero-input `Bank Portal` mint is excluded from
  producers, so coins aren't free. (Copper is genuinely ~1c, so it can still be a cheap cauldron
  input — that's correct, not the old free-mint degeneracy.)
- **Belt fuel/fert are NOT free material.** A belt carrier is a *utility* supply (fuel/fert only,
  the LP's `BELT::X` rule: "a fuel belt shouldn't feed bulk inputs"); as a recipe/cauldron material
  input it costs its real production (e.g. Coke Powder pays its buy-ore→refine chain). They live in
  `utilityCarriers`, not `beltItems`.
- **Nursery fertilizer is charged on the op axis.** A nursery recipe pays
  `(nutrientCost/prim)·fertOpPerNutrient`, where `fertOpPerNutrient = op(fertCarrier)/nutrientValue`
  is computed once from a fert-free pass-1 (Growth Potion ≈ 0.056c/nutrient) — a two-pass solve, so
  the fert-from-a-grown-crop circularity stays finite. The residual fert-to-grow-fert term (~few %)
  is ignored.
- **Cauldron triples** are pulled from the shared `cauldronEligibility(db, cfg)` mask in
  `cauldron.js` (same mask the LP uses — single source of truth, no drift). A cauldron is a 3-in/1-out
  recipe (qty 1, no co-product): `build` sums DISTINCT inputs (fan-out free), `op` sums by multiplicity.

Verified picks (`maxTier 6`, Coke Powder fuel / Growth Potion fert): Sand → Grinder{Stone}; Salt →
Stone Crusher{Rock Salt} (dumps only cheap Sand); Glass → Kiln{Sand} (op = 6×Sand); Brick →
Kiln{Clay}; Plank → Table Saw{Logs}; **Clay → Cauldron{Redcurrant×3}** — a self-contained grown
cauldron, chosen by correct economics (cheap grown op, no purchase drain), not by depth-hacking.

**Phase 3 (composition) is done and unit-tested.** `compose(target, rate)` → `{ tree, fuel, fert,
totals, summary }`: it expands the canonical pick into a **replicated** sized tile tree (each
consumer gets a private subtree — Q1) and sizes three **shared trunks** the material tree never
expands into:
- **fuel** — heated machines (recipe machines via `machineHeatPerRun`; cauldrons via per-craft
  `baseHeat`) draw the canonical fuel carrier. Heat→fuel = `heat/min ÷ (item.heat·fuelMult)`.
- **fert** — nurseries draw the canonical fert carrier; plots are sized
  `min(60·maxFertility/nutrientCost, beltSpeed)` (same as `flowgraph.js`).
- **money** — every buy/mint leaf draws copper from the **main-belt money line** (never free). A
  minted coin (`Copper/Silver/Gold`, valued at `sellPrice`) is tagged with its coin and tracked in
  `summary.mintedCoins` so Phase-4 graph emit **must wire it back to the belt money line** (the
  cash-provenance rule — minted coins are not free).

Sizing uses real game params from `skillParams(cfg.skills)` (`speedMult`, `beltSpeed`, `fuelMult`,
`fertMult`, `alchemyMult`); alchemy-yield machines (`Extractor`/`Thermal Extractor`/`Alembic`/`Advanced
Alembic`) apply their output multiplier so machine counts don't overcount. Heat/nutrient/money draws
are **linear in rate** (pre-`ceil`); because the fuel/fert carriers are themselves heated/grown, the
trunks form a small coupled feedback — resolved by a scalar fixpoint on the carrier draw rates, then
the trunks are composed once at the resolved rate.

**Fuel is computed but not (yet) charged.** Every heated tile carries `heatPerMin`/`fuelPerMin`
structurally; whether fuel feeds the *selection metric* is a deliberate future gate (it does not
today — fuel stays a free utility in picks). To charge it later, mirror the fert op-axis treatment:
a `fuelOpPerHeat` constant added to `op` in `relax()`. The structural draw is already there, so the
hook is symmetric with fertilizer — no re-architecture needed.

Open: Phase 4 (graph emit `{nodes,edges,summary}` + renderer) not started. `OP_W` is now safe to
raise (op is clean copper) if operating cost should weigh harder in picks.

---

## Why a separate solver (not another LP objective)

The LP finds a *globally optimal* flow vector for a scalar objective. Every "simplicity"
property we want — fewest belts, no farm, buy raws, one clean route per item, no surprise
byproducts — is a *structural* property the LP only approximates through proxy penalties,
and each proxy creates new edge cases. A composer builds structure directly: one recipe per
item, fixed, deterministic. What you see is what you'd build.

Trade-off we accept: the composer is **not cost-minimal**. Each item is made one canonical
way regardless of context (no cross-tile sharing of a cheaper intermediate). The user has
chosen modularity over global optimality at every fork this session; this formalizes it.

## Core data model

A **Tile** makes one output item via one recipe, and names its input tiles:

```
Tile {
  item:      "Sand",
  source:    "recipe" | "buy" | "belt",      // how this item enters
  recipe:    { machine, inputs:{item:qty}, outputs:{item:qty}, baseTime },  // if source==recipe
  inputs:    [ Tile, ... ],                   // canonical tile per recipe input (recursive)
  // sizing (filled during composition for a concrete demand):
  ratePerMin, machineCount, beltsOut, byproducts:{item:rate}, // co-products (trash or feed)
}
```

A **canonical recipe** is chosen per item, once per (tier, skills, cfg), by a cost DP:

```
tileCost(item):                       // "how hard to BUILD a tile that makes this item"
  if item is a main-belt input (the canonical fuel/fert, or a user belt item): 0  (it arrives)
  if item is buyable:                 candidate cost = BUY_COST (cheap leaf — coins are fine)
  for each recipe R producing item:
     candidate cost = buildCost(R.machine)            // Stone Crusher 12 ≪ Cauldron 2880
                    + farmPenalty(R.machine)          // nurseries/cauldrons marked up
                    + Σ_input tileCost(input)         // recurse
  tileCost(item) = min(candidates);  canonicalRecipe(item) = argmin
  memoize
```

This is a shortest-build-path over the recipe DAG. Buy-raw routes are cheap leaves; the
farm (cauldron + nursery chain) is expensive, so it loses unless it's the *only* way. Same
levers we already built (`buildCost`, `farmWeight`) — but applied as a clean per-item
choice instead of a global LP penalty. Cauldron tiles appear only where no buy-raw/grind
route exists (e.g. Clay if it has no non-cauldron recipe).

We already have `buildTile()` in `src/utilities.js` (pre-solves the simplest chain for fuel
/ fert) — the composer generalizes it to **every** item and to a one-step-per-tile tree.

## Composition (top-down)

```
compose(target, rate):
  tile = canonicalRecipe(target)           // the final step
  runsPerMin = rate / tile.recipe.outputs[target]
  tile.machineCount = ceil(runsPerMin * baseTime / (60 * speedMult))   // or nursery plots
  for each input, qty in tile.recipe.inputs:
     childRate = qty * runsPerMin
     tile.inputs.push( compose(input, childRate) )   // recurse; bottoms out at buy/belt
  tile.byproducts = other outputs of the recipe (co-products)
  return tile
```

Cycles (self-consuming chains) are broken by the canonical-recipe DP never choosing a
recipe whose tileCost recursion revisits the item.

## Fuel / fert / cash — main-belt inputs, not material tree

Heat and nutrient are **belt inputs**, never expanded into the material tree:
- Each machine that needs heat draws the **canonical fuel tile** (Coke Powder) off the belt
  — one fuel tile for the whole build, trunked (we already pick + lock this).
- Nutrient only arises if a tile farms; buy-raw tiles have no nurseries, so the common case
  needs no fert at all. Where farming is unavoidable, the **canonical fert tile** (Growth
  Potion) supplies it off the belt.
- Purchases are funded by belt coins / mint (cash), as today.

## Byproducts / co-products

A tile's recipe may co-produce items (Rock Salt → Salt **+ Sand**; Table Saw → Gloom
Fungus **+ Plank**).

- **v1 (deterministic, no surprises):** the canonical-recipe DP **prefers recipes whose
  co-products are zero or are needed elsewhere**, and treats leftover co-products as
  shown-trash/surplus. Crucially, the DP would *not* pick `Rock Salt → Salt + Sand` for Salt
  if a cleaner Salt recipe exists, precisely because the Sand co-product is dead weight — so
  the 2400-Plank-trash class of build never gets chosen.
- **v2 (co-product feeds):** in `reuse` mode, let a co-product satisfy another tile's demand
  (Salt tile's Sand feeds the Glass tile), reducing duplicate production. This is the only
  place the composer needs cross-tile bookkeeping; keep it out of v1.

## Shared vs replicated tiles

The composer produces a tile **tree**. A shared intermediate (Sand feeding Glass + Brick +
Salt) can be:
- **Shared:** one Sand tile, belts out to all consumers (true composition, fewer machines).
- **Replicated:** a private Sand tile per consumer (fully self-contained lines).

Earlier you chose replication for the LP path, but also asked for "a Sand tile above the
Glass tile" — composition naturally renders sub-tiles. **Open question (Q1):** default to
shared tiles (compose) or replicated (self-contained)? Recommendation: **shared**, since the
whole point of composition is reuse; offer replicate as a toggle.

## Output / rendering

The tile tree maps onto the existing graph format (nodes = tiles, edges = belts between
them) so the current renderer + full-belt blueprint logic are reused. Each tile is already
a labelled, tileable box — the "Sand tile above Glass tile" structure falls out for free.

## Integration

- New module `src/composer.js`: `composeTiles(db, cfg, item, rate) → { nodes, edges, summary }`
  in the same shape `buildFlowGraph` returns.
- Server: when the mode is "Simplest", call the composer; otherwise the LP. Cleanest as an
  explicit **solver** choice (the "Optimize for" dropdown: Cheapest/Balanced/Lean → LP,
  Simplest → composer), so they stop sharing one objective.
- Reuse: `tiers.js` (gating), `cost-floor.js` (build cost), the canonical fuel/fert picker,
  `blueprint()` (full-belt tiling), and the renderer.

## Phased build plan

1. **[DONE] Canonical-recipe DP** — now a build/op two-axis fixpoint relaxation (see IMPLEMENTED
   MODEL at top). Unit-tested in `test/composer.test.js`.
2. **[DONE] Cauldron triples → DP** — via shared `cauldronEligibility` mask. Clay resolves to a
   grown cauldron.
3. **[DONE] Composition** (`compose`) → replicated tile tree with rates + machine counts; per-min
   op = `opCost·rate`. Bottoms out at buy/belt/mint; nurseries sized as plots; shared fuel/fert/money
   trunks (fuel/fert via a coupled scalar fixpoint). Minted coins link to the belt money line.
   Unit-tested in `test/composer.test.js`.
4. **Graph emit** → `{nodes, edges, summary}`; wire the renderer. Must wire each mint leaf to the
   main-belt money line (`summary.mintedCoins`).
5. **Full-belt tiling** per tile (reuse `blueprint`).
6. **Mode switch** in the server/UI (Simplest → composer).
7. **v2:** co-product feeds in reuse mode (Q1/Q2 below).

## Decisions (resolved)

- **Q1 — Replicated by default.** A shared intermediate gets a private tile per consumer
  (separate Sand "farm" for Glass and for Brick). `share/compose` is a toggle — and becomes
  especially valuable once **cross-tile byproduct recycling** is on (the Rock-Salt Sand
  co-product replacing some Sand farm tiles).
- **Q2 — Avoid + show leftovers.** The DP prefers recipes with no dead co-product; leftovers
  render as trash/surplus. Cross-tile co-product feeds are v2 (and pair with the share mode).
- **Q3 — Solver toggle.** A composer⟷LP toggle like the layout-engine toggle: a build is
  *either* tile-composed *or* LP-optimized, the user picks. Not side-by-side.
- **Q4 — Keep the penalty knob, and weigh DEPTH+WIDTH (not just build cost).** A Cauldron is
  **wide but shallow** — for Clay it's genuinely simpler than the deep Sand+Charcoal-Powder
  chain, even though the Cauldron machine is expensive. So `tileCost` must penalize chain
  **depth** per stage, so a long chain of cheap machines still loses to one wide shallow
  step where that's the cleaner build.

## Refined `tileCost` (the simplicity metric)

Build-and-tile complexity, balancing machine difficulty, tree shape, and material expense.
Material cost is **relative** — an option is penalized by how much pricier it is than the
cheapest alternative, so expensive raws (Rotten Log / fungus) are used only when forced.

```
tileCost(item):
  if item is a main-belt input (canonical fuel/fert, or a user belt item): 0   // arrives
  candidates = []
  if buyable(item): candidates.push( BUY_LEAF + MAT_W * buyPrice(item) )   // expensive raws cost more
  for each recipe R producing item:
     candidates.push(
        DEPTH_W                              // +1 stage — penalizes deep chains
      + buildCost(R.machine)                 // machine difficulty (Stone Crusher 12, Cauldron 2880)
      + farmPenalty(R.machine)               // nursery/cauldron markup (the knob)
      + WIDTH_W * max(0, #inputs - 1)         // extra input branches = more belts
      + Σ_input tileCost(input) )            // recurse (depth+width fall out of the sum)
  tileCost(item) = min(candidates);  canonicalRecipe(item) = argmin
  memoize; guard cycles (never recurse through an item already on the path)
```

Weights tuned empirically against expected picks:
- **Sand** → Buy Limestone → grind  (shallow + build-cheap)
- **Coke Powder** → buy-ore refine  (the canonical fuel tile)
- **Clay** → Cauldron  (wide+shallow beats the deep Sand+Charcoal-Powder chain — DEPTH_W
  must be large enough vs Cauldron buildCost for this to hold)
- Expensive raws (Rotten Log) only when no cheaper recipe exists (MAT_W relative penalty)
