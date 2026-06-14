# Handoff — Alchemy Factory optimizer + visualization

Working notes for picking this back up. Covers current state, the architecture, and
the in-progress **nursery-aware tiling** work that's next.

## What this is
A production-line optimizer + interactive web visualization for the Steam game
**Alchemy Factory** (appid 3669570, game v0.5.0.4471, DB v41). Pre-enumerated
cauldron columns + flow-balance LP/MILP solved with HiGHS (WASM), rendered as an
assembly-line graph with per-production-line grouping, tiling blueprints, and (new)
2D vertical nesting.

- **Run:** `node server.js` → http://localhost:8347.
- **Tests:** `node --test 'test/**/*.test.js'` → **58 passing**.
- **Data:** `data/alchemy_db.v41.json` (~146 items, machines, recipes), `data/skills.json`, `data/machine_tiers.json`.
- **Datamined ground truth:** `raw/starfi5h/*`, `raw/joejoes/*`, `raw/moldy530/*` — community
  reverse-engineered calculators. Our `src/cauldron.js` matches starfi5h exactly. When in
  doubt about a game mechanic, these are more authoritative than any web source.

## ⚠️ Server / asset discipline (read FIRST — caused real confusion)
- **Claude owns the running server**, not the user. After ANY change to `server.js` or
  `src/*.js` used by `/api/*`, **restart it**: `pkill -f "[n]ode server.js"; sleep 1;
  nohup node server.js 8347 > /tmp/alchfact-server.log 2>&1 &`. The user reloading the page
  does NOT pick up `src`/server changes — only `web/*` static files reload.
- **Build-stamp system** to catch stale assets: `web/app.js` has `BUILD_STAMP`, `server.js`
  has `SERVER_STAMP` (keep them equal; bump on every change). `/api/version` returns the
  server stamp. The sidebar **"Copy settings (for debugging)"** button copies
  `{clientStamp, serverStamp, location, request}` — when a user reports a bug, have them
  paste it; mismatched stamps = stale browser/server. This already caught several
  "it's still broken" reports that were just stale code.
- **layout sync rule:** `src/layout*.js` ↔ `web/layout*.js` are hand-maintained copies.
  After editing `src/layout2.js` run `cp src/layout2.js web/layout2.js` (same for layout3).
  Layout/app/css are `web/` files (reload, no restart). Model/normalize/server need restart.

## File map
| File | Role |
|---|---|
| `src/cauldron.js` | compiles ~419k cauldron triples, exact BigInt arithmetic; `cauldronStats(target)` → piecewise craft time `[3,6,12,24,60]s` & heat |
| `src/normalize.js` | `buildProcessTable` — recipe/cauldron/belt/burn/**fertilize**/sale/spend/mint columns; belt fenced to `belt::X`, byproduct sell to `byprod::Y`; cauldron columns carry `chainInputs` (count of inputs that are themselves cauldron outputs) |
| `src/cost-floor.js` | `makeItemCopperFloor(db)` — cheapest copper per item (Bellman-Ford) |
| `src/model.js` | `Model`, `optimize` (column generation, 2-pass byproduct cap), **`optimizeWithinTolerance`** (the "Optimize for" engine — see below), `buildLpString` (+ `costCap`/`loadCap`/`objMode`), `capitalPerRun` (capital + buildability + **nursery-plot** charge), `minMachines` |
| `src/tiers.js` | effective unlock tiers |
| `src/flowgraph.js` | `buildFlowGraph` (nodes/edges/summary, nursery plot counts, fuel/cash wiring), `validateGraph`, `toDot`, `toMermaid` |
| `src/layout.js` | **CLASSIC** engine (`AlchLayout`) — fallback, untouched |
| `src/layout2.js` | **2D lane** engine (`AlchLayout2`) — tidy-tree within lanes, fuel/fert as boxes, crossing-reduction lane ordering, demand drop |
| `src/layout3.js` | **2D-NESTED** engine (`AlchLayout3`) — layout2 + **vertical nesting** (wide shared producer spans its below-it consumers). Active dev surface. |
| `server.js` | port 8347; `/api/solve`, `/api/version`, `/api/dot`, `/api/mermaid`, static |
| `web/app.js`, `web/index.html`, `web/style.css` | browser UI + SVG renderer + **`splitBaseGoods`** (per-line replication, browser-only) |
| `web/layout*.js` | UMD copies of `src/layout*.js` (globals `AlchLayout`/`AlchLayout2`/`AlchLayout3`) |

## The SOLVE pipeline (`server.js` `solveRequest`)
1. `buildProcessTable(db, cfg)` → columns. `model = new Model(pt, db)`.
2. rateMode `'machines'`: probe at 1/min to convert "N output machines" → effectiveRate.
3. **cauldron-chain penalty** (`config.cauldronChainFraction`): probe min-cost, then
   `model.cauldronChainWeight = frac × (probe.objective / m0)`. Penalizes a cauldron per
   input that is itself a cauldron output (`p.chainInputs`), discouraging cauldron→cauldron.
4. **"Optimize for"** = one idea (how much copper/item you'll waste for a simpler factory),
   two inputs: dropdown `buildabilityFraction` (fraction of the build's own cheapest
   per-item cost) and override `costTolerance` (absolute copper/item; wins). If either > 0
   → `optimizeWithinTolerance`, else plain `optimize`.

### `optimizeWithinTolerance` (model.js) — the core "simplest factory" solve
Lexicographic, **route-count based** (NOT machine-count):
1. `base = optimize` → cheapest cost C* and the converged column set (`base.columns`).
2. budget `costCap = C* + tol × Σdemand` (tol = absolute, or `fraction × perItemMin`).
3. **Phase 2a** (`buildRouteMip` objMode `'routes'`): MILP, a binary per **machine column**
   (`x ≤ M·y`), minimize Σy s.t. cost ≤ costCap → R* (fewest distinct production *lines*).
   **Big-M for `timeSec=0` machines (nurseries!) is a finite 1e9** — Infinity voids the
   link and lets a nursery run free/uncounted (this was a real 55k-Flax bug).
4. **Phase 2b** (objMode `'cost'`, `routeCap = R*+0.5`, `activationFloor`): cheapest build
   among the fewest-route ones. Activation floor zeroes degenerate ghost flows.
5. Repackage flows, drop sub-`flowEps` numerical residue. `objective` = true cost.

**Known limitation (live discussion):** route-count ignores machine *count*, so a 4500-
nursery build looks "lean" (1 nursery line). Mitigated by the nursery-plot capital below,
but see the in-progress section.

### Capital (`capitalPerRun`) — amortization REMOVED
- Amortize-minutes knob is gone; `capitalWeight` defaults to `1/60` (Model uses
  `cap.amortizeMinutes || 60`; UI no longer sends it). "Count machine build cost" checkbox
  stays.
- **Nursery-plot capital (key fix):** nurseries are `timeSec=0` → cost ZERO capital, so the
  LP couldn't see fertilizer *quality* and would flood cheap low-fertility **Basic
  Fertilizer** (maxFert 12) into a thousands-of-nurseries sprawl. Now each `fertilize`
  column is charged for the plots it implies: `plots = nutrient / (60 × maxFertility)`,
  ×(buildability + Nursery build cost × capitalWeight). Low-fertility fert is now correctly
  ~180× more expensive than Growth Potion (maxFert 2160) → optimizer self-selects high
  fertility. Only affects fertilizer columns; non-fert builds unchanged.

## The LAYOUT pipeline (`web/app.js` `renderGraph`)
1. `applyCollapse` (folded lines → group nodes).
2. **`splitBaseGoods(graph)`** (browser-only, runs for `2d`/`2dn` modes). Replicates shared
   **use-proportional** producers into per-line dedicated copies so each line is self-
   contained & tileable: nurseries, **smelters/crushers/saws** (fuel comes off the belt like
   fertilizer, so a buy-raw→furnace→ingot chain IS a base good — the `!heatPerMin` exclusion
   was dropped), main-belt taps, and **purchase nodes** (`Buy X` → one coin-draw+portal per
   line). `groupLines` recurses through purchase→smelter→ingot→product chains so every link
   splits on the SAME line keys (else dangling cash edges → layout crash). Copies scale
   machineCount/heat/fuel/copper by the line's share.
3. `ENGINE = engineFor(layoutMode)` — 3-way toggle `classic | 2d | 2dn` (toolbar ⊞).

### layout2 (AlchLayout2) — 2D lane engine, key transforms (in order)
- `asapRanks`: longest-path ranks; **nutrient/heat edges EXCLUDED from ranking** (fuel/fert
  are support flows fed back up; counting them stranded real producers). They draw as
  feedback loops instead.
- Util (fuel/fert) lines remapped to a top internal sub-rank (excludes nutrient/heat so the
  line's OUTPUT sits at its box bottom).
- realMax/demand computed AFTER the util remap, excluding util members; **demand dropped an
  extra `flowStep`** below its producers for fan-in breathing room.
- Demand producers are NEVER absorbed into a util line (Black Powder is itself fuel → its
  cauldron was wrongly pinned to the fuel band).
- Lane order: products first; **shared & util lines barycenter-placed** at the avg lane they
  feed. Then a **guarded crossing-reduction sweep** reorders product lanes (only accepts a
  reorder that reduces lane-level crossings), then **re-anchors shared/util** to consumers'
  FINAL positions (so a shared cauldron lands BETWEEN its consumers, not stranded right).
- Tidy-tree within each lane (primary-parent spanning forest, parent centers over children's
  span). Fan-in solo nodes centered on parents' barycenter.
- Trunk routing aggregates fuel/fert into one edge per consumer box.

### layout3 (AlchLayout3) — 2D-NESTED (active dev)
Forked from layout2. Adds **vertical nesting**: a SHARED producer entirely above (by rank)
the consumer lines it feeds is **merged into one lane cluster** with them (right after
`assignClusters`, guarded: consumers must be product lines below the producer, fed only from
within the group). The intra-cluster tidy-tree then packs producer-on-top / consumers-tucked-
under-its-columns for free (it prefers high-out-degree producers as primary parents and
centers them over children). Sub-line boxes still drawn per original cluster (`subClusters`).
`boxKeyOf` maps each member → its SUB-line box key so trunking routes to sub-boxes (else the
merged id has no box → fuel spaghettis). Verified: Mars copper cauldron spans Bronze Rivet +
Copper Bearing, ~17% narrower, 0 overlaps, identical to layout2 when no nest opportunity.

## Tiling / blueprint (`blueprint()` in each layout)
`cluster.tile = { K, cell:[{label,machine,count}], idle }`. Header shows two lines:
`<name>` then `⬢ K× tiles · each: <cell>`. Each machine node title is machine-promoted
(`Iron Smelter → Iron Ingot`) and its sub-line shows `count× per tile · total× total`.
Blueprint tiles every node carrying a continuous load: time-cycle machines (timeSec>0:
cauldron/crucible/processor) **and nurseries** (see below). Purchase/mint/belt portals
(timeSec=0, no tileLoad) still stay shared singletons outside the cell.

### Nursery-aware (self-contained) tiling — SHIPPED
Tiles fold in the per-line nursery copies so each tile is self-contained, with K driven by
the **most-constrained** producer (often the nursery: a fractional plot rounds up to a whole
plot per tile). Implementation is generic, not a special-cased formula:
- `src/flowgraph.js` emits **`node.tileLoad`** = the *continuous* machine/plot demand (NOT the
  integer `machineCount` ceil): timed machine → `rate·timeSec/(60·speedMult)`; nursery →
  `rate / perPlot` (fractional plot count). Nurseries also get `utilization = null` (the
  render + blueprint both use `utilization != null` to tell timed machines from plot-count
  nurseries — World Tree Nursery used to leak a stale util%, now fixed).
- `blueprint()` (`src/layout2.js` + `src/layout3.js`) `loadOf(n)`: timed machines keep
  `machineCount × utilization` (existing tiles byte-identical); nurseries use `tileLoad`.
  The existing K-search (`cell = round(load/K)`, accept finest K with idle ≤ 0.15) then
  naturally makes whole-plot tiles — a nursery's fractional plot load caps K so plots tile
  cleanly. This reproduces `cauldronsPerNurseryPlot` for free (the plot:cauldron ratio in a
  cell == that formula, since nursery output rate == cauldron input rate by flow balance).
- `web/app.js` `splitBaseGoods` scales `tileLoad` by the line's share `f` for each per-line
  nursery copy (alongside the existing machineCount/nutrient/fuel scaling).

Verified (post-`splitBaseGoods`, the browser path): `Soap @ 60/min` →
`[Linseed Oil] K=5: 2× Linseed Oil | 1× Flax` (4 Flax plots → 5 whole-plot tiles) and
`[Plant Ash] K=2: 5× Plant Ash | 2× Sage` (3 Sage plots, idle 0.14). At low rate lines
collapse toward one tile (`[Sage Powder] K=1: 2× Sage Powder | 1× Sage`).

Reference math (still true; the generic load-based approach derives it):
```
cauldronsPerNurseryPlot = nurseryOutPerPlot × craftTime / (k × 60 × speedMult)
  nurseryOutPerPlot = min(60 × maxFertility / nutrientCost, beltSpeed)   [items/min/plot]
  craftTime         = piecewise(output cauldronTarget)  [3,6,12,24,60 s]
  k                 = count of this herb in the cauldron triple (1/2/3)
  speedMult         = Factory-skill multiplier
```
Cauldron consumption recap: **3 in → 1 out per craft**; craft time depends ONLY on the
OUTPUT's `cauldronTarget`; inputs/min = `180 × speedMult / time`. One ~100–240/min nursery
feeds ~8–19 cauldrons.

**Known remaining wart:** the fuel/fert **util** mega-clusters and a catch-all `shared:`
cluster still emit a junky one-of-everything tile (idle ≈ 0.9–1.0) — pre-existing (they
tiled all their timed machines into one cell before this change too; nurseries just added a
few crop rows). Real product lines tile correctly. A follow-up could suppress tiles on
util/shared aggregate clusters (or only tile clusters with a single dominant output).

## Other shipped features (context, don't re-derive)
- **Money = explicit copper flow** (renamed from gold). 1 silver = 1000 copper, 1 gold =
  100,000. `copper::cash` virtual row; `buy:X` consumes buyPrice copper; `mint:copper` valve;
  belt coins → `belt::coin` → `spend` → cash (offset purchases, gold dashed edges). Coin
  recipes need the real coin denomination; coins fungible into cash only off the belt
  (manufactured-coin arbitrage fenced). `fmtCu()` shows "2g 80s".
- **Belt = fuel/fert/cash only** (`belt::X` rows; never bulk recipe material).
- **Cauldron input pools:** unrestricted / buyables / buyables+growables / easy (buy/grow/
  1-step) / growables.
- **Two-pass byproduct cap** kills sell-arbitrage (pass1 disables sales+belt-cash to measure
  honest co-production, pass2 caps it).
- **Hover highlight:** material lineage up+down, but fuel/fert edges only **1 hop** (a self-
  feeding fert line otherwise lit up the whole box).
- **Layout3 nesting + amortization removal + nursery capital** are this session's big items.

## Gotchas
- Nurseries & purchase/mint/fertilize columns are `timeSec=0` → escape any `timeSec>0` gate
  (machine load, capital, route-MIP big-M). Every such gate needs an explicit branch (the
  route-MIP big-M, the nursery-plot capital). Watch for this whenever touching the objective.
- `Date.now()`/`Math.random()` unavailable in Workflow scripts (n/a here).
- Most real "lines" are linear chains; 2D work is about placement clarity & nesting, not
  sub-grouping.
- Restart the server after src/server edits (see discipline section). It's the #1 cause of
  "still broken" confusion.
