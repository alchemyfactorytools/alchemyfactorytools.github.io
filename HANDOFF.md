# Handoff — Alchemy Factory optimizer + visualization

Working notes for picking this back up. The **active work** is a new **tile-composer**
(`TILE-COMPOSER.md` + `src/composer.js`) — a deterministic "Simplest" solver meant to
replace bending the LP into a tile-builder. **Phases 1 (recipe DP) and 2 (cauldron triples)
are done + unit-tested** (`test/composer.test.js`), and the metric was redesigned into a
**build/op two-axis fixpoint** (see below). Still **not wired in** — the LP is the only live
solver. Next: **Phase 3 (composition)** — expand a canonical pick into a sized tile tree.

## What this is
A production-line optimizer + interactive web visualization for the Steam game
**Alchemy Factory** (appid 3669570, game v0.5.0.4471, DB v41). Pre-enumerated cauldron
columns + flow-balance LP/MILP solved with HiGHS (WASM), rendered as an assembly-line graph
with per-line grouping, full-belt tiling blueprints, and 2D nested layout.

- **Run:** `node server.js 8347` → http://localhost:8347.
- **Tests:** `node --test 'test/**/*.test.js'` → **58 passing**.
- **Data:** `data/alchemy_db.v41.json` (~146 items, machines, recipes), `data/skills.json`, `data/machine_tiers.json`.
- **Datamined ground truth:** `raw/starfi5h/*`, `raw/joejoes/*`, `raw/moldy530/*` — community
  reverse-engineered calculators; more authoritative than web sources. `src/cauldron.js`
  matches starfi5h exactly.
- **Current stamp:** `composer-phase2-build-op-split-2026-06-14z`. Recent commits:
  `f4ce328` (HANDOFF rewrite), `29e5f8b` (composer Phase 1).

## ⚠️ Server / asset discipline (read FIRST — caused real confusion)
- **Claude owns the running server.** After ANY change to `server.js` or `src/*.js` used by
  `/api/*`, **restart it**: `pkill -f "[n]ode server.js"; sleep 1; nohup node server.js 8347 >
  /tmp/alchfact-server.log 2>&1 &`. The user reloading does NOT pick up `src`/server changes —
  only `web/*` static files reload.
- **Build-stamp system:** `web/app.js` `BUILD_STAMP` == `server.js` `SERVER_STAMP` (bump both
  on every change). `/api/version` returns the server stamp. The sidebar **"Copy settings"**
  button emits `{clientStamp, serverStamp, location, request}` — when a user reports a bug,
  have them paste it; mismatched stamps = stale browser/server (this caught several "still
  broken" reports).
- **Verification harness pattern:** the browser pipeline (`splitBaseGoods` + `AlchLayout3`)
  is exercised in Node by extracting `splitBaseGoods` from `web/app.js` via `new Function`
  and loading `web/layout3.js` as a UMD module, then hitting `/api/solve`. Used all session
  to check dangling edges / layout crashes / cross-line leaks across all 90 optimal items.
- **layout sync rule:** `src/layout*.js` ↔ `web/layout*.js` are hand-maintained copies. After
  editing `src/layout2.js`, `cp src/layout2.js web/layout2.js` (same for layout3).

---

## ⭐ ACTIVE WORK — the tile-composer

### Why (the arc of this session)
The whole session was the user pushing the LP toward tile-like behavior: self-contained
lines, buy-raw over farming, simplest-to-build, canonical fuel/fert, replication, no farm.
Each LP objective patch fixed one case and exposed another (free Gloom-Fungus loops, 2400/min
Plank trash, minted coins). Root cause: **the LP is a global cost optimizer; the user wants a
tile composer.** Different machines. Decision: build a **separate deterministic solver** for
the **"Simplest"** mode; keep the LP for Cheapest/Balanced.

### Design — `TILE-COMPOSER.md` (read it)
Resolved decisions:
- **Replicated by default** (separate Sand tile per consumer); share/compose is a toggle, and
  pairs with future cross-tile byproduct recycling (Rock-Salt Sand co-product feeding tiles).
- **Co-product avoidance in v1** (DP penalizes dead co-products; leftovers shown as trash).
- **Solver toggle** (composer ⟷ LP), like the layout-engine toggle — not side-by-side.
- **Metric = `build + OP_W·op + CO_W·waste`, build & op tracked SEPARATELY** (see below). The
  original single-scalar metric was replaced this session — see TILE-COMPOSER.md "IMPLEMENTED MODEL".

### Phases 1 + 2 — DONE — `src/composer.js`, `test/composer.test.js`
`makeComposer(db, cfg)` → `{ tileCost, buildCost, opCost, canonicalPick, beltItems, utilityCarriers,
buyable }`. A **fixpoint relaxation** (NOT the recursive memo originally planned — the recipe DAG is
cyclic; positive weights ⇒ optimal tiles acyclic ⇒ least fixpoint is correct, context-free, ~75ms).

**Two-axis metric, each per unit of output:**
- **`build`** = `DEPTH_W·stages + WIDTH_W·(distinct−1)`, summed down the chain. **Qty-INDEPENDENT**
  (fan-out free).
- **`op`** = copper/unit, propagated by `qty/prim`. `opCost·rate` = copper/min.
- `score = build + OP_W·op + CO_W·Σ_co (coQty/prim)·floor(co)`. Weights (`composer.js`, all
  overridable via `cfg.composer.{depthW,widthW,opW,coW}`): `DEPTH_W 1500, WIDTH_W 250, BUY_LEAF 40,
  OP_W 2, CO_W 30`.

**Key model rules (this session):**
- **Currency = copper-equivalent**: minted coins cost `sellPrice` (Copper 1, Silver 1000, Gold 100k),
  build `BUY_LEAF`; free zero-input `Bank Portal` mint excluded from producers.
- **Belt fuel/fert ≠ free material**: utility-only (`utilityCarriers`, not `beltItems`); as a
  material input the carrier costs real production (Coke Powder pays buy-ore→refine). LP's `BELT::X`
  rule.
- **Nursery fertilizer on the op axis**: `(nutrientCost/prim)·fertOpPerNutrient`,
  `fertOpPerNutrient = op(fertCarrier)/nutrientValue` from a fert-free pass-1 (two-pass solve; breaks
  the fert-from-grown-crop circularity). Growth Potion ≈ 0.056c/nutrient.
- **Cauldron triples**: via shared `cauldronEligibility(db,cfg)` in `cauldron.js` (same mask the LP
  uses — `normalize.js` migrated onto it, no drift). 3-in/1-out; build sums distinct inputs, op by
  multiplicity.

**Verified picks** (`maxTier 6`, Coke Powder fuel / Growth Potion fert): Sand → Grinder{Stone};
Salt → Stone Crusher{Rock Salt} (dumps only cheap Sand); Glass → Kiln{Sand} (op = 6×Sand); Brick →
Kiln{Clay}; Plank → Table Saw{Logs}; **Clay → Cauldron{Redcurrant×3}** — the self-contained grown
cauldron, chosen by correct economics (grown op is cheap, no purchase drain), not depth-hacking.
98/146 items makeable.

### Remaining phases (not started)
3. **Composition** — `compose(target, rate)`: expand the canonical pick top-down into a tile tree,
   multiplying rates, computing machineCount (or nursery plots) per tile, per-min op = `opCost·rate`,
   bottoming out at buy/belt/mint. Replicated by default. Co-products → trash/surplus.
4. **Graph emit** — convert the tile tree to the `{nodes, edges, summary}` shape `buildFlowGraph`
   returns, so the existing renderer + full-belt `blueprint()` are reused.
5. **Solver toggle** — composer vs LP in the UI; server routes "Simplest" → composer, others → LP.
6. **v2** — cross-tile co-product feeds in `reuse` mode (+ share/compose mode).

Open tuning: `OP_W` is now safe to raise (op is clean copper) if operating cost should weigh harder
in picks; Clay picks single-herb `Redcurrant×3` (simpler than a 3-herb mix — confirm if desired).

---

## The LP solver (still the live path) — this session's changes

### Pipeline (`server.js` `solveRequest`)
1. **Canonical fuel/fert tiles** (`src/utilities.js` `canonicalUtilities`, default on,
   `config.canonicalUtilities:false` to disable) — pre-picks the fuel carrier (max heat/copper
   → Coke Powder @ t6) and fert carrier (max maxFertility → Growth Potion), builds the SIMPLEST
   self-contained chain for each (fuel with `noFert` → bought-ore refine: Buy Coal Ore → Coal →
   Coke → Coke Powder), and **locks the build to it**: restrict self burn→fuelItem /
   fertilize→fertItem; forbid non-canonical recipe + cauldron producers of the fuel chain's
   items (`forbidRecipeIds`, `forbidCauldronItems`). The demanded item is always exempt.
   Memoized by environment (tier/skills/cauldron/buy/byproduct), not target.
2. `buildProcessTable(db, cfg)` → columns; `model = new Model(pt, db)`.
3. rateMode `'machines'`: probe at 1/min → effectiveRate.
4. cauldron-chain penalty (`config.cauldronChainFraction`).
5. **"Optimize for"** = `buildabilityFraction` (dropdown) or `costTolerance` (override). Either
   > 0 → `optimizeWithinTolerance`, else plain `optimize`.

### `optimizeWithinTolerance` — now **BUILD-COST based** (was route-count)
Lexicographic, but "Simplest" now minimizes **how hard the factory is to BUILD**, not route
count (route-count loved the 191-cauldron farm because a cauldron is one versatile route):
1. `base = optimize` → cheapest cost C* + columns. `costCap = C* + tol·Σdemand`.
2. **Phase 2a** (`buildRouteMip` objMode `'routes'`): minimize **Σ capitalPerRun·x (build cost)
   + small Σy (route width) + waste** s.t. cost ≤ costCap. A bank of cheap Stone Crushers
   (build 12) beats a few Bronze-Bar Cauldrons (2880), so the farm/fert-line sprawl is gone.
3. **Phase 2b** (objMode `'cost'`): cheapest-material build among the simplest ones; the cap is
   now the **build+width score** (`scap`), not route count. Big-M for `timeSec=0` nurseries is
   a finite 1e9 (Infinity voids the link → free uncounted nursery, a real bug).
4. **Waste penalty** in the route objective: `wasteValue(p)·wasteWeight` (default 1e-4) —
   prices surplus + trashed co-products so it won't over-produce one co-product to harvest
   another. NOTE: too weak vs build cost in some cases (Saturn still trashes Rock-Salt Sand,
   and a build-cheap Gloom-Fungus route trashed 2400 Plank — part of why we're moving to the
   composer).

### `capitalPerRun` + `farmWeight`
- Capital = buildability + amortized machine build cost (`capitalWeight` 1/60) + nursery-plot
  charge (`plots = nutrient/(60·maxFertility)`; this is why high-maxFertility Growth Potion
  beats Basic Fert).
- **`farmWeight`** (UI "Farm penalty" select, default 4× i.e. value 3): build-cost markup
  `×(1+farmWeight)` on **Nursery + Cauldron** (`Model.farmMachines`), so even build-cheap
  cauldron shortcuts lose to buy-raw. NB the composer deliberately does NOT use this (the user
  found it over-penalizes cauldrons there).

### Other LP fixes this session
- **explain.js cost bug** — purchases are `consumes[copper::cash]`, `process.copperCost` is 0;
  explain now prices from copper consumption (was showing "0.0 c/min" + false "self-sustaining").
- **Simplest dropdown** relabeled "easiest to build"; cap was 1000000 → 1000 (now build-cost
  based anyway). New **Farm penalty** control (None/Light 2×/Default 4×/Heavy 9×).
- **Trashed-byproduct display** — `normalize.js` keeps `flags.trashed` quantities; `flowgraph`
  emits dashed-red `trash:` sink nodes (`<item> → trash · N/min wasted`), skipping main-line
  belt items. (`web/style.css` `.node.trash`, `web/app.js` subText.)

## The LAYOUT pipeline (`web/app.js` `renderGraph`) — unchanged this session except replication
- **`splitBaseGoods(graph)`** (browser-only, `2d`/`2dn` modes) was **generalized to full
  per-line replication**: ANY node whose transitive material output reaches ≥2 lines is
  replicated into a private per-line copy with its whole upstream cone (Sand chain replicates
  into each of Salt/Brick/Glass), sized by `lineFrac` (real per-line output share). Fuel/fert
  util lines are NOT replicated (they trunk). Verified: 0 dangling edges, 0 layout crashes, no
  disallowed cross-line leaks across all 90 optimal items (only residual cross-line edges are
  fuel-grade items like Coke Powder, which count as belt inputs).
- Engines: `classic` (fallback) / `2d` (AlchLayout2) / `2dn` (AlchLayout3, active). layout3 =
  layout2 + vertical nesting. Full-belt tiling in `blueprint()`: a tile outputs one full belt
  (`beltSpeed`), K = ceil(outRate/beltSpeed); liquids (piped) are uncapped.

## Gotchas
- Nurseries & purchase/mint/fertilize/burn columns are `timeSec=0` → escape any `timeSec>0`
  gate (machine load, capital, route-MIP big-M). Each such gate needs an explicit branch.
- Cauldron columns are CG-generated in `model.js` (not in `normalize`/`db.recipes`); forbidding
  them needs `cfg.cauldron.forbidFor` (the `outputForbidden` mask), NOT a recipe-id denylist —
  this is exactly why the canonical-fuel cauldron lock needed `forbidCauldronItems`, and why the
  composer must integrate `compileCauldron` to see cauldron recipes.
- Restart the server after src/server edits. #1 cause of "still broken" confusion.

## Known open items / discussion threads
- **Stage 2 sub-tile boxes** (render a replicated sub-assembly like Sand as a distinct box
  above its consumer) — designed for the LP layout, never built; the composer makes it moot
  (tiles ARE the boxes).
- **Waste penalty too weak vs build cost** in the LP (2400 Plank / Rock-Salt Sand trash) — the
  composer's co-product penalty solves this structurally; not worth more LP tuning.
- **trash vs reuse** — Saturn in `trash` mode dumps the Rock-Salt Sand co-product; `reuse`
  would feed it to Glass (and is the v2 cross-tile-feed case for the composer).
