# Tile-Composer — design

A second solver for the **"Simplest"** mode. The LP stays the engine for *Cheapest /
Balanced* (global copper minimization). "Simplest" switches to **deterministic tile
composition**: pick one canonical way to make each item, then compose the target out of
tiles, recursively, down to bought raws and main-belt inputs.

This is the natural endpoint of everything this session has pushed toward — self-contained,
buy-raw, simplest-to-build, droppable, composable blueprints — and it retires the
degeneracy whack-a-mole (free Gloom-Fungus loops, 2400/min Plank trash, minted coins) that
comes from bending a cost-optimizer into a tile-builder.

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

1. **Canonical-recipe DP** (`tileCost` / `canonicalRecipe`) over the recipe DAG, with
   build-cost + farm-penalty + buy-raw-leaf + belt-input leaves. Unit-test the picks (Sand →
   Buy Limestone → grind; Coke Powder → buy-ore refine; Clay → whichever non-cauldron route
   exists, else cauldron).
2. **Composition** (`compose`) → tile tree with rates + machine counts. Bottom out at
   buy/belt. Handle nurseries (plots) for the rare farmed tile.
3. **Graph emit** → `{nodes, edges, summary}`; wire the renderer.
4. **Full-belt tiling** per tile (reuse `blueprint`).
5. **Mode switch** in the server/UI (Simplest → composer).
6. **v2:** co-product feeds in reuse mode (Q1/Q2 below).

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
