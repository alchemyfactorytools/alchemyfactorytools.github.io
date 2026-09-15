# Alchemy Factory — production dataset & optimizer

Dataset **and working production-line optimizer** for **Alchemy Factory** (Steam appid `3669570`),
current as of **game version 1.0.4950 (1.0 release 2026-09-08, hotfix 2026-09-11)**.

Dataset refreshed 2026-09-12 from starfi5h DB v55 and the official 1.0 patch notes. The June 2026
dataset was assembled from a verified deep-research pass (24 confirmed claims, 19 sources, 3-vote
adversarial verification per claim). Optimizer architecture chosen via a multi-agent design
debate — see `DESIGN.md` (the 1.0 addendum in §4 lists what the release changed).

## Visual planner (web UI)

```bash
npm install
npm run serve                             # → http://localhost:8347
```

Pick an output item and rate (per minute, per second, machine count, **full belts** of net
output at your Logistics level, or a dispatch quota), choose a **build priority** (how much
copper per item one extra machine stage is worth: Simplest 750, Balanced 100, Cheapest 2;
dispatch mode always runs Cheapest), optionally restrict the **allowed external inputs**
(the feedstock + coins you're willing to feed the factory — leave empty to allow
anything), set cauldron/byproduct/skill knobs, and hit **Solve**. You get an
interactive left-to-right factory graph: each machine node shows its integer count,
utilization, and runs/min; edges are labeled with the item and flow rate; HEAT and
NUTRIENT appear as resource hubs; surplus byproducts get explicit discard nodes;
and cauldron routes riding fragile/tie margins or face-value coin mints are badged.
Pan with drag, zoom with the wheel, **Fit** to reframe, toggle **⇄ Horizontal / ⇅
Vertical** layout (vertical fits deep builds on screen better), or **Copy Graphviz
DOT** to export. The address bar mirrors the sidebar as a short query string
(non-default values only, e.g. `?v=55&o=basic_fertilizer&t=4&r=30`; codec in
`web/share.js`), **Copy link** puts it on the clipboard, and opening a link or
returning to a saved session solves immediately. The graph is solved server-side by the same LP, so the browser
needs no WASM.

The layout (`src/layout.js`, shared by the UI and the SVG exporter) uses **dagre**
(`@dagrejs/dagre`) for proper layered graph drawing — virtual nodes for long edges,
crossing minimization, and routed edge paths — so even dense graphs with shared
intermediates read as a clean dependency flow chart. A spanning-tree pass marks
non-primary edges (an intermediate feeding several lines, or a byproduct fed back)
as dashed "recycle" links. dagre runs in the browser (`web/dagre.js`) and in Node
for the SVG export.

## Optimizer quick start (CLI)

```bash
npm install
npm test                                  # 106 tests: cauldron golden + Mars regressions + graph/layout/composer

# min-cost plan for an item (route tree, external inputs, binding capacity)
node src/cli.js cost Mars --rate 0.1 --pool buyables --no-self-fert

# export a standalone SVG of the factory graph (opens in any browser, no server)
node src/cli.js svg Mars --rate 0.1 --pool buyables --no-self-fert --out mars.svg
node src/cli.js svg Mars --rate 0.1 --pool buyables --vertical --out mars_tall.svg  # top-to-bottom

# restrict to a specific set of purchasable inputs via a config file
node src/cli.js cost "Bronze Ingot" --rate 20 --config inputs.json
#   inputs.json: {"buy":{"allow":["Logs","Gelatinous Gridlock","Copper Coin"]}}

# resolve a single cauldron triple
node src/cli.js triple "Gelatinous Gridlock" "Gelatinous Gridlock" "Gelatinous Gridlock"

# max gold/min for a machine budget; integer machine counts for a target
node src/cli.js profit --machines 5
node src/cli.js machines "Healing Potion" --rate 30
```

It is a flow-balance LP (HiGHS) over machine recipes, catalyst variants, buy/sell/burn/fertilize
columns, **and all 447,580 cauldron triples** via column generation with a full-rescan exactness
backstop (DESIGN.md §3). Heat, nutrients, and per-machine capacity are explicit resources, so
self-fuel/self-fert/matter-duplication loops are priced correctly and bounded by machine counts.

Key knobs (CLI flags or `--config file.json`, see `src/config.js` for the full schema):

- **Cauldron overrides**: `--forbid-cauldron "Item,..."` (never via cauldron),
  `--force-cauldron "Item,..."` (only via cauldron), `--no-cauldron`,
  `--pool buyables` / `--pool-allow` / `--pool-deny` (input pool restriction).
- **Byproducts**: `--byproducts reuse|trash|sell` globally, `--byproduct-trash "Item,..."`
  per item. `reuse` credits byproducts to downstream demand (free disposal of excess);
  `trash` deletes non-primary outputs entirely; `sell` also lets byproduct sales offset cost.
- **Anchoring**: `--no-self-fuel` / `--no-self-fert` (fuel/fertilizer must be bought),
  `--machines N` / `--machine-count "Cauldron=10"` (capacity), `--skills "factory=4,alchemy=2"`.

Verified behaviors (see `test/optimizer.test.js`): under a buyables-only economy Mars costs
~74.8k g of material through the Advanced Athanor Copper Powder recipe, and the optimum **mixes**
its fertile (CP+ICP pair) and unstable (ICP only) catalyst variants to match the 200:150 demand
ratio; with Seed Plots locked the June design trace still holds (infeasible without the cauldron,
~158k g with the GG×3 shortcut); with unrestricted crafted-input triples the economy is materially
self-sustaining (cost → 0, the loop regime) and stays bounded by capacity rows. Solves run in
tens to hundreds of ms.

## Game state (September 2026)

- **1.0 released 2026-09-08**; hotfixes v1.0.4917 through **v1.0.4950** (2026-09-11) carry no
  production data changes. Upstream DB v55 (2026-09-12) is the 1.0 dataset.
- **What 1.0 changed for the model:** base heat cost removed from all heating devices (machines
  draw heat only while running); Linseed Oil output and every consumer scaled by the same factor;
  Obsidian's byproduct is Marble (Volcanic Ash now comes from an Enhanced Grinder recipe); Brew
  Barrel beverages; Miniature World Tree; Steam as a virtual item with a Steam Boiler recipe;
  Clockwork Bird no longer salable; higher sell prices on Crown, Luna, Sol, Pocket Watch.
- **What changed upstream between June and 1.0** (fixes to the June dataset, not game patches):
  Obsidian inputs (Crude → Shattered Crystal), Advanced Athanor heat moved to per-recipe draw, four
  commodity Advanced Athanor recipes (Coke, Steel Ingot, Copper Powder, Salt), Seed Plot recipes
  (1 seed → 120..200 herbs, time-driven, no speed multiplier), Bronze Ingot cauldronCost halved,
  explicit `tier` on every item and machine, Mercury and Luna on the Advanced Shaper.
- The **Wagon System** (rail logistics) shipped in 1.0. It is not in the upstream dataset and not
  modeled here; the tile composer's belt-cap layer is conveyor-only.
- v0.5.4467 (June 2026) remains the pre-1.0 watershed: it reworked Unstable Catalyst, Black Powder,
  Star Dust, the gem Advanced Athanor recipes, Blast Potion and Moon Tear, and made the Cauldron
  deterministic.

## Layout

```
src/
  cauldron.js                    # exact-arithmetic compiler for all 447,580 triples (~35 ms),
                                 #   tie/fragility/self-consuming flags, curated-row validator
  normalize.js                   # DB+config → Process column table (recipes, catalyst variants,
                                 #   buy/sell/burn/fertilize/mint, same-item netting, quarantines)
  config.js                      # config schema/defaults + skill formulas + heating device choice
  heating.js                     # heating-device packing (Stone/Blast Furnace, Steam Heating Pad)
  recipes.js                     # production-recipe filter (drops portal/custom-slot rows)
  tiers.js                       # unlock tiers (explicit on every item/machine since DB v45)
  model.js                       # LP/MILP builder, column-generation loop, min-machines MIP,
                                 #   infeasibility probe (HiGHS)
  explain.js                     # flow vector → route tree, regime detection, fragility warnings
  cli.js                         # cost / profit / machines / triple commands
test/
  golden.test.js                 # 15 pinned cauldron-formula behaviors (DESIGN.md §4)
  optimizer.test.js              # 14 Mars-scenario + override + byproduct regressions
data/
  alchemy_db.json                # CANONICAL: items (157), machines (40), recipes (211)
                                 #   verbatim extract of starfi5h DB v55, gameVersion 1.0.4950
  skills.json                    # 5 upgrade-track formulas (belt/machine speed, alchemy yield,
                                 #   fuel/fertilizer efficiency) — medium confidence, see _meta
  mechanics.json                 # cauldron model, catalyst system, heat/fuel, steam, fertilizer,
                                 #   logistics, economy, throughput formulas
  contracts.json                 # Dispatch Portal contract caps (pre-1.0 values, see _comment)
raw/
  starfi5h/                      # github.com/starfi5h/AlchemyFactoryCalculator @ develop
                                 #   (README, index.html, js/ — sources moved into js/ in Aug 2026;
                                 #    develop is the current branch, main is stale)
  joejoes/                       # github.com/JoeJoesGit/AlchemyFactoryCalculator (Jan 2026)
  moldy530/                      # github.com/moldy530/alchemy-factory-planner data/ + LP engine
                                 #   (Jan 2026; includes a linear-programming planner worth reading;
                                 #    repo has NO LICENSE — reference only)
scripts/
  validate.js                    # integrity + freshness checks (node scripts/validate.js)
```

### Rail simulator (Wagon System)

`src/rail.js` is a fixed-tick simulation of the 1.0 Wagon System: tracks as a graph, wagons
with tag/color/one 100-item pack, and the five station kinds with the in-game filter panels
(cargo AND/OR/NOT, wagon color, wagon tag). Launch Stations own their wagons and release one
per 10 s; Loaders pack a belt into ≤4 packs and load EMPTY matching wagons (no top-up), with
"full loads only"; Unloaders drop a pack into a chest drained at a consumer rate and skip when
full; Transfer Stations bridge loops; Sorters branch by filter and wait when blocked. Wagon
speed is a placeholder until measured. Scenarios are JSON (`scenarios/rail/`):

```bash
node scripts/rail-sim.js scenarios/rail/trunk-tower.json --minutes 60 [--speed 4] [--json]
```

The report gives per-loader shipped rate and belt-blocked time, per-unloader delivered rate and
starvation (after a 10-minute warm-up), sorter waits, transfer buffers, and per-wagon trips,
loaded time and lap time.

**Design explorer.** `src/rail-plan.js` turns a factory *plan* (modules with floors, flows in
items/min tagged stock or freight) into candidate topologies, sizes each fleet until every
consumer is fed, and scores them side by side:

```bash
node scripts/rail-explore.js scenarios/rail/plan-tier6.json            # comparison table
node scripts/rail-explore.js scenarios/rail/plan-tier6.json --detail trunk-zones:shared
node scripts/rail-explore.js scenarios/rail/plan-tier6.json --emit trunk-zones:shared my.json  # then hand-edit + rail-sim
```

Templates: `single-loop` (one loop through every floor), `trunk-zones` (ground trunk + a loop
per floor joined by Transfer Stations), `shuttles` (a dedicated loop per flow). Fleets:
`shared` (one Launch Station per loop, packs addressed by cargo) or `perFlow` (a Launch
Station per flow, addressed by tag). Findings so far: loaders never top up, so a shared fleet
with partial-load loaders starves whoever sits downstream on the loop (single-loop/shared fails
outright); trunk-zones/shared feeds the tier-6 plan with one wagon per loop, and shuttles cost
the most track.

## Optimizer assumptions & open items (DESIGN.md §6)

- **Bank Portal coins are priced at face value** (sellPrice/coin) — an assumption until verified
  in-game; flagged `[ASSUMPTION]` in every plan that mints. Disable with
  `{"quarantine":{"bankPortal":false}}` (the "Allow minting coins" checkbox in the web UI); the
  composer then uses coin-input recipes only when that coin is on the main belt.
- The curated **Ruby cauldron row is excluded** (contradicts the deterministic formula); the other
  three curated rows are replaced by the formula block whenever the cauldron is enabled.
- Nursery **seeds are treated as plot capital** (not per-harvest inputs) and crop growth consumes
  nutrients but no machine-seconds.
- Plans that ride **fragile cauldron margins or exact ties** are flagged in the route tree —
  verify in-game before building; a balance patch can flip them.
- Not yet implemented from DESIGN.md: stacked catalyst columns (co-load unverified), belt-cap
  rows / λ-sweep Pareto frontier (M4), branch-and-price certification of the min-machines MIP.

## Canonical schema (`alchemy_db.json`)

- **items** (name-keyed): `category`, `buyPrice`, `sellPrice`, `wholesalePrice`, `heat` (fuel
  energy), `nutrientCost`/`nutrientValue` (crops/fertilizer), `maxFertility`,
  `cauldronCost`/`cauldronTarget` (47 craftable)/`cauldronMulti`, `tier` (every item), `maxStack`,
  `liquid`, `virtual` (beverages, Steam, Gentian Mixture: never a cauldron input), `baseCost`,
  `paradoxTime`, `exp`, `charges` (catalysts), `id` (in-game id, used for cauldron tie-breaking).
- **machines** (name-keyed): `buildCost` (item map), `heatCost` (per-sec draw while running; `-1`
  = the draw is on each recipe), `slotsRequired` (heated machines), `isGenerator`/`slots`/`heatSelf`
  (heating devices; `heatSelf` is 0 since 1.0), `fertility` (growers), `tier`, footprint `L`/`W`/`H`.
  There is no `parent` link any more: the heating device is a config choice (`src/heating.js`).
- **recipes** (array): `id`, `machine`, `inputs`/`outputs` (item→qty; `inputs` absent on the Steam
  Boiler), `baseTime` (sec; absent on Nursery crops, which are nutrient-driven via `nutrientCost`),
  `heatCost` (per second on Advanced Athanor / Steam Boiler rows, per batch on curated Cauldron
  rows), `ChargeCost` + `unstableOutputs`/`resonantOutputs` (Advanced Athanor catalyst recipes),
  `sharedOutputs`, `buildCost` (seed for crops), `customInputSlot`. The DB also lists Purchasing
  Portal buy rows and Bank Portal coin exchanges as recipes; `src/recipes.js` filters those out.

Key mechanics for the optimizer (full detail in `data/mechanics.json`):

- **Cauldron** (deterministic post-patch): `T = (c1+c2+c3) × ratio` where ratio = 0.5 (3 identical)
  / 0.65 (2 identical) / 1.0 (all different); output = item minimizing `|T − cauldronTarget| ×
  cauldronMulti`, ties to lower item id. Time/heat interpolate piecewise-linearly on the output's
  target: targets [1, 100, 1k, 10k, 1M] → time [3, 6, 12, 24, 60]s, heat [1, 20, 200, 1500, 10000].
- **Catalysts** (Advanced Athanor): consumption = `recipe.ChargeCost / catalyst.charges` per batch.
  Unstable (180 charges) swaps to `unstableOutputs`; Fertile (240) doubles outputs; Resonant (1500)
  swaps to `resonantOutputs` (all products at once); Eternal (99999) zeroes material inputs.
- **Throughput**: `outputsPerMin = (60 / (baseTime / speedMult)) × batchYield`; alchemyMult applies
  only to Extractor / Thermal Extractor (×3 extra) / Alembic / Advanced Alembic.
- **Heat per item is speed-invariant** (speedMult cancels), so Factory Efficiency saves time, not fuel.
  Heating devices draw no base heat since 1.0; they only set slot packing (Stone Furnace 9, Blast
  Furnace 42, Steam Heating Pad 9) via `heatingDevice` in the config. Central steam (composer)
  forces the pad.
- **Seed Plot** cycles ignore the speed multiplier (1 seed → 120..200 herbs, no nutrients).

## Sources and currency

| Source | Format | Currency | Role |
|---|---|---|---|
| [starfi5h/AlchemyFactoryCalculator](https://github.com/starfi5h/AlchemyFactoryCalculator) (`develop`, `js/alchemy_db.js`) | JS-wrapped JSON | **DB v55, 2026-09-12, gameVersion 1.0.4950 — current** | Canonical data + mechanics formulas |
| [alchemy-factory-codex.com](https://alchemy-factory-codex.com/) | HTML (scrape-only) | last checked on 0.5.4471 (June 2026) | Human-readable reference, calculators, spot-checks |
| Steam ISteamNews API, appid 3669570 | JSON API | live | Patch-note feed for re-verification (SteamDB blocks bots — don't use it) |
| [JoeJoesGit/AlchemyFactoryCalculator](https://github.com/JoeJoesGit/AlchemyFactoryCalculator) | JS-wrapped JSON | 2026-01-17 — **stale** | Item icons; the January snapshot was dropped from `data/` |
| [moldy530/alchemy-factory-planner](https://github.com/moldy530/alchemy-factory-planner) | clean JSON + TS LP solver | 2026-01-13 — **stale** | Schema reference + LP-planner prior art (no license) |

## Known gaps / open questions

1. **Steam Heating Pad consumption** is not in any dataset: the boiler side is known (6000 heat →
   300 Steam), the pad's Steam per delivered heat is not. `STEAM_EFFICIENCY` (0.6) is a pre-1.0
   community measurement; re-measure on 1.0 before trusting "at cost" steam numbers.
2. **Seed Plot yields** (120..200 herbs per seed) are upstream values and contradict an earlier
   Codex reading of 1 herb per seed; verify in-game.
3. **Skills tree is the weakest dimension** (medium confidence): only the 5 calculator-modeled
   tracks have formulas; 1.0's Shop Recognition bonuses, level caps, and unlock costs are unsourced.
4. **Dispatch contracts** (`data/contracts.json`) were recorded on v0.5.x; 1.0 reworked shop
   upgrades and removed purchase-contract upgrades.
5. The **Wagon System** is not modeled; belt caps in the composer are conveyor-only.
6. Mercury and Luna moved to the Advanced Shaper in the upstream data without a patch-note entry;
   confirm in-game.

## Refreshing the dataset

1. Check for new patches: `curl "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=3669570&count=10"`
2. Re-pull `raw/starfi5h/` (README.md, index.html, `js/*.js`) from the **develop** branch (not main).
3. Re-extract: `node -e "const window={};eval(require('fs').readFileSync('raw/starfi5h/js/alchemy_db.js','utf8'));require('fs').writeFileSync('data/alchemy_db.json',JSON.stringify(window.ALCHEMY_DB,null,2)+'\n')"`
4. Re-pin `EXPECTED_GAME_VERSION` in `scripts/validate.js` and the header test in `test/golden.test.js`, then `node scripts/validate.js` and `npm test`. Cauldron census and Mars pins are expected to move on a balance patch; re-pin them deliberately.
5. Diff the extract against the previous one before trusting it (`git diff --stat data/`), and read the patch notes for mechanics changes the JSON cannot show (heat model, speed exemptions, new machine kinds).
