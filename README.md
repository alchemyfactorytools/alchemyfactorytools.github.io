# Alchemy Factory — production dataset & optimizer

Dataset **and working production-line optimizer** for **Alchemy Factory** (Steam appid `3669570`),
current as of **game version 0.5.0.4471 / patch v0.5.4467 (June 2026)**.

Dataset assembled 2026-06-12 from a verified deep-research pass (24 confirmed claims, 19 sources,
3-vote adversarial verification per claim). Optimizer architecture chosen via a multi-agent design
debate — see `DESIGN.md`.

## Visual planner (web UI)

```bash
npm install
npm run serve                             # → http://localhost:8347
```

Pick an output item and rate, optionally restrict the **allowed external inputs**
(the feedstock + coins you're willing to feed the factory — leave empty to allow
anything), set cauldron/byproduct/skill knobs, and hit **Solve**. You get an
interactive left-to-right factory graph: each machine node shows its integer count,
utilization, and runs/min; edges are labeled with the item and flow rate; HEAT and
NUTRIENT appear as resource hubs; surplus byproducts get explicit discard nodes;
and cauldron routes riding fragile/tie margins or face-value coin mints are badged.
Pan with drag, zoom with the wheel, **Fit** to reframe, toggle **⇄ Horizontal / ⇅
Vertical** layout (vertical fits deep builds on screen better), or **Copy Graphviz
DOT** to export. The graph is solved server-side by the same LP, so the browser
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
npm test                                  # 36 tests: cauldron golden + Mars regressions + graph/layout

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
columns, **and all 419,220 cauldron triples** via column generation with a full-rescan exactness
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

Verified behaviors (see `test/optimizer.test.js`): Mars is infeasible without the cauldron under
a buyables-only economy and costs ~160k g with it (within 1.1% of DESIGN.md's hand trace); with
farming the optimum **mixes** the Athanor joint recipe with the GG×3 cauldron shortcut; with
unrestricted crafted-input triples the economy is materially self-sustaining (cost → 0, the
loop regime) and stays bounded by capacity rows. Solves run in tens to hundreds of ms.

## Game state (June 2026)

- Early Access on the **v0.5.x** branch. Latest builds: **v0.5.4467** (2026-06-02, major balance
  patch), **0.5.4471** (June 3–4, Black Powder cauldron tweaks), **v0.5.4485** (June 5, hotfix,
  no data changes). 1.0 is scheduled for **Fall 2026**.
- **v0.5.4467 is the dataset watershed.** It reworked recipes for Unstable Catalyst, Black Powder,
  Star Dust, all four Advanced Athanor recipes (Silver Powder, Obsidian, Lapis Lazuli, Gold Dust),
  and downstream Blast Potion and Moon Tear; **doubled Black Powder's sell price and heat value**;
  removed the Cauldron's output-generation multiplier (the Cauldron is now fully deterministic);
  and added the four-catalyst Advanced Athanor system. **Any data sourced before June 2026 is
  wrong for these items** — validated here by diffing against a January snapshot.
- A **Rail Logistics System** (8x transport capacity) is roadmapped for Summer 2026 but has NOT
  shipped — current throughput math excludes it and will need rework when it lands.

## Layout

```
src/
  cauldron.js                    # exact-arithmetic compiler for all 419,220 triples (31 ms),
                                 #   tie/fragility/self-consuming flags, curated-row validator
  normalize.js                   # DB+config → Process column table (recipes, catalyst variants,
                                 #   buy/sell/burn/fertilize/mint, same-item netting, quarantines)
  config.js                      # config schema/defaults + skill formulas
  model.js                       # LP/MILP builder, column-generation loop, min-machines MIP,
                                 #   infeasibility probe (HiGHS)
  explain.js                     # flow vector → route tree, regime detection, fragility warnings
  cli.js                         # cost / profit / machines / triple commands
test/
  golden.test.js                 # 15 pinned cauldron-formula behaviors (DESIGN.md §4)
  optimizer.test.js              # 14 Mars-scenario + override + byproduct regressions
data/
  alchemy_db.v41.json            # CANONICAL: items (146), machines (36), recipes (168)
                                 #   from starfi5h DB v41, gameVersion 0.5.0.4471 (June-current)
  alchemy_db.joejoes.jan2026.json# STALE cross-validation snapshot (Jan 2026, pre-patch)
  skills.json                    # 5 upgrade-track formulas (belt/machine speed, alchemy yield,
                                 #   fuel/fertilizer efficiency) — medium confidence, see _meta
  mechanics.json                 # cauldron model, catalyst system, heat/fuel, fertilizer,
                                 #   logistics, economy, throughput formulas
raw/
  starfi5h/                      # github.com/starfi5h/AlchemyFactoryCalculator @ develop
                                 #   (NOTE: develop is the default/current branch; main is stale)
  joejoes/                       # github.com/JoeJoesGit/AlchemyFactoryCalculator (Jan 2026)
  moldy530/                      # github.com/moldy530/alchemy-factory-planner data/ + LP engine
                                 #   (Jan 2026; includes a linear-programming planner worth reading;
                                 #    repo has NO LICENSE — reference only)
scripts/
  validate.js                    # integrity + freshness checks (node scripts/validate.js)
```

### Optimizer assumptions & open items (DESIGN.md §6)

- **Bank Portal coins are priced at face value** (sellPrice/coin) — an assumption until verified
  in-game; flagged `[ASSUMPTION]` in every plan that mints. Disable with
  `{"quarantine":{"bankPortal":false}}`.
- The curated **Ruby cauldron row is excluded** (contradicts the deterministic formula); the other
  three curated rows are replaced by the formula block whenever the cauldron is enabled.
- Nursery **seeds are treated as plot capital** (not per-harvest inputs) and crop growth consumes
  nutrients but no machine-seconds.
- Plans that ride **fragile cauldron margins or exact ties** are flagged in the route tree —
  verify in-game before building; a balance patch can flip them.
- Not yet implemented from DESIGN.md: stacked catalyst columns (co-load unverified), belt-cap
  rows / λ-sweep Pareto frontier (M4), branch-and-price certification of the min-machines MIP.

## Canonical schema (`alchemy_db.v41.json`)

- **items** (name-keyed): `category`, `buyPrice`, `sellPrice` (46 sellable), `wholesalePrice`,
  `heat` (fuel energy), `nutrientCost`/`nutrientValue` (crops/fertilizer), `maxFertility`,
  `cauldronCost`/`cauldronTarget` (47 craftable)/`cauldronMulti`, `tier`, `maxStack`, `liquid`,
  `charges` (catalysts), `id` (in-game id, used for cauldron tie-breaking).
- **machines** (name-keyed): `buildCost` (item map), `heatCost` (per-sec draw; `-1` on
  Cauldron/Advanced Cauldron = output-dependent), `parent` (attached heat source — NOT an upgrade
  lineage), `slotsRequired`.
- **recipes** (array): `id`, `machine`, `inputs`/`outputs` (item→qty), `baseTime` (sec; absent on
  Nursery crops, which are nutrient-driven via `nutrientCost`), `heatCost` (recipe-level, 4
  recipes), `ChargeCost` + `unstableOutputs`/`resonantOutputs` (Advanced Athanor catalyst
  recipes), `sharedOutputs`, `buildCost` (seed for crops).

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

## Sources and currency

| Source | Format | Currency | Role |
|---|---|---|---|
| [starfi5h/AlchemyFactoryCalculator](https://github.com/starfi5h/AlchemyFactoryCalculator) (`develop`) | JS-wrapped JSON | **DB v41, 2026-06-03, gameVersion 0.5.0.4471 — June-current** | Canonical data + mechanics formulas |
| [alchemy-factory-codex.com](https://alchemy-factory-codex.com/) | HTML (scrape-only) | 0.5.4471, cauldron values updated 2026-06-04 | Human-readable reference, 10 calculators, spot-checks |
| Steam ISteamNews API, appid 3669570 | JSON API | live | Patch-note feed for re-verification (SteamDB blocks bots — don't use it) |
| [JoeJoesGit/AlchemyFactoryCalculator](https://github.com/JoeJoesGit/AlchemyFactoryCalculator) | JS-wrapped JSON | 2026-01-17 — **stale** | Cross-validation baseline, item icons |
| [moldy530/alchemy-factory-planner](https://github.com/moldy530/alchemy-factory-planner) | clean JSON + TS LP solver | 2026-01-13 — **stale** | Schema reference + LP-planner prior art (no license) |

## Known gaps / open questions

1. **Skills tree is the weakest dimension** (medium confidence): only the 5 calculator-modeled
   tracks have formulas; Catapult Speed, Commerce, level caps, and unlock costs are unsourced.
2. The v0.5.4467 **conveyor system refactor's** concrete belt-throughput changes are undocumented;
   the 60 + 15/level belt formula should be spot-verified in-game.
3. Entity counts vary across sources (Codex claims 142 recipes / 151 items / 35 devices vs. v41's
   168/146/36) — counting methodology differs (e.g. crop entries, alt recipes); v41 is treated as
   canonical. A datamine of the actual game files would settle it.
4. starfi5h's v41 has not been line-by-line diffed against the official patch notes, only
   spot-verified on the 9 reworked items.

## Refreshing the dataset

1. Check for new patches: `curl "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=3669570&count=10"`
2. Re-pull `raw/starfi5h/` from the **develop** branch (not main).
3. Re-extract: `node -e "const w={};eval(require('fs').readFileSync('raw/starfi5h/alchemy_db.js','utf8'));require('fs').writeFileSync('data/alchemy_db.v41.json',JSON.stringify(w.ALCHEMY_DB,null,2))"`
4. `node scripts/validate.js`
5. Game is in active Early Access rebalancing — re-verify before relying on prices/recipes.
