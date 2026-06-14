# Alchemy Factory Production Optimizer — Final Design Recommendation

**Status:** Final synthesis of the four-proposal design debate (June 2026, game v0.5.0.4471, dataset `data/alchemy_db.v41.json`).
**Audience:** the engineer implementing this (repo owner).
**All quantitative claims below were verified against the live dataset:** 146 items, 36 machines, 168 recipes, 11 liquid-flagged items, 47 cauldron-target items, 18 buyables, 46 sellables, 135 cauldron-eligible inputs → C(137,3) = **419,220** triples, all `cauldronMulti = 1`, 6 baseTime-less Nursery rows, 16 multi-output recipes.

---

## 1. Decision: Flow-balance MILP over the fully pre-enumerated cauldron column space (HiGHS), with a column-generation restricted master for interactivity and a route-trace explanation layer

The chosen architecture is the **Pre-enumerated cauldron-column MILP**, amended in four load-bearing ways by ideas from the losing proposals:

1. **Capacity rows ship in week 1, not week 2.** The MILP proposal's own risk register proved its M1 (no capacity rows) returns cost-0 garbage once crafted-input cauldron loops open. The first shipped number must already be bounded by machine-seconds.
2. **The interactive default is the hybrid's restricted master + dual-rescan column generation**, not the full 420k-column block. The full block is the canonical batch/CI solver; the browser path runs ~1–2k columns with a ~2 ms full-419k pricing rescan as the exactness backstop.
3. **A flow→route-tree explanation layer is a first-class deliverable**, stolen from the recursive engine. An LP whose answer cannot be rendered as "this node chose cauldron A+B+C because 35 < 844" is not a player tool.
4. **Anchoring modes are first-class UX**, also from the recursive engine: input-pool restriction, self-fuel/self-fert toggles, and an explicit regime-switch explainer when material cost collapses toward zero ("this configuration is materially self-sustaining; the binding constraint is machines/slots").

### Why this resolves the judge split

The three judges disagreed:

| Judge | 1st | 2nd | 3rd | 4th |
|---|---|---|---|---|
| Correctness | **MILP (8.5)** | Hybrid (7) | Recursive (5) | Hypergraph (4.5) |
| Pragmatism | **Recursive (8)** | Hybrid (6.5) | MILP (6) | Hypergraph (4.5) |
| Scale/UX | **Hybrid (8)** | MILP (7) | Recursive (5.5) | Hypergraph (4) |

Resolution logic:

- **Correctness has to be the foundation because this dataset is adversarial.** Every per-node fixpoint engine in the debate published verified-wrong numbers: the recursive engine's flagship Mars trace misreported its own cauldron sum (claimed T≈349.5; actual T=325, an *exact tie* won only by the lower-id rule) and rode two more unflagged exact ties; the hypergraph's headline rejection exhibit was a self-consuming triple (Gold Dust in → Gold Dust out, which cannot win by construction); and the two fixpoint engines disagreed by **12.8×** (586.67 vs 7,522.95) on the *same* Gold Dust route purely from byproduct-attribution policy. Joint products (16 multi-output recipes, including the Athanor CP+ICP pair that Mars demands in 200:150 ratio) and gain>1 loops (fertilizer 36→144 nutrients; the verified copper-duplication cauldron cycle) are not edge cases here — they sit directly under the headline scenarios. Only steady-state flow balance prices them exactly, and capacity rows are the only principled (non-fictional-wage) answer to amplifying loops.
- **Pragmatism's verdict for the recursive engine is really a verdict for three *features*** — the route trace, anchoring-mode UX, and fast time-to-first-answer — not for per-node min as the solver semantics. We absorb all three as layers on the LP. Time-to-first-answer is addressed by re-sequencing milestones (the cauldron compiler + a correct small LP ships in week 1); the trace and anchoring UX are scoped deliverables (M2), not afterthoughts. What we refuse to absorb is the part pragmatism discounted anyway: mode-dependent answers with no principled selector (Mars = 23,474 / 27,984 / 48,438 across the recursive engine's own modes) and attribution policies that are different wrong answers.
- **Scale/UX's verdict for the hybrid is really a verdict for the restricted-master interactive mode** — which the MILP proposal already contained as its column-generation mode. We adopt it as the *default* interactive path. What we drop is the hybrid's wage-priced stage-1 fixpoint as a source of published numbers: its P_time knob moved the headline Mars answer 4.8× (98,991 → 20,648) despite "the LP never uses it," and it required maintaining two pricing engines that must agree across every game patch (the cauldron was reworked 10 days before this debate). A small value-iteration pricer survives only as (a) a warm-start heuristic for the restricted master and (b) raw material for the explanation layer — it never appears in a user-facing cost.
- The hypergraph DP was last for all three judges; its surviving contributions (same-item netting, λ-sweep frontier, inverted index, the Knuth-superiority disclaimer, dropping curated cauldron rows) are absorbed below.

Net: one solver semantics (flow balance), one solver library (HiGHS), one normalized column table, with explanation and anchoring as UI layers — instead of two engines that must agree (hybrid) or an engine whose answers are policy-dependent (recursive, hypergraph).

---

## 2. Absorbed must-steal ideas (provenance noted)

| Idea | From | Where it lands |
|---|---|---|
| Route-tree explanation layer: decompose the LP flow vector into a per-node trace with chosen route, cost, and runner-up | Recursive | M2, first-class deliverable |
| Anchoring modes as first-class UX (buy-fuel / self-fuel / self-fert / input-pool restriction) with a regime-switch explainer when a resource price → 0 | Recursive | M2 |
| Port starfi5h's shipped planner semantics: belt caps (60/min, ×50 currency, ÷sharedOutputs), furnace slot demand via `parent`/`slotsRequired` | Recursive | M4 throughput layer; natural seam for Summer 2026 rails |
| Stacked catalyst-variant expansion at load (~80 columns, eternal→unstable→resonant→fertile order), gated on one in-game co-load confirmation | Recursive | M2 |
| Column-generation dual rescan as the interactive exactness backstop; precomputed triple→output map makes it ~2 ms (verified independently; 94 ms unoptimized upper bound) | Hybrid | M3 interactive mode; also run after every solve and every game patch as a staleness check |
| Plateau finding: never prune cauldron candidates by relative cost band (5% band keeps 31,484 columns; Philosopher's Stone alone 4,918); top-K + rescan is the correct restricted-master scheme | Hybrid | M3 |
| Optimistic finite seeding for bootstrap cycles in any fixpoint pricer (fixes the verified NUTRIENT=∞ blindness in cauldron-off configs) | Hybrid | warm-start pricer only |
| Seeds-vs-crops distinction as a pinned regression (Flax Seeds cc=115 vs Flax crop cc=2; Flax crops ×3 → T=3 is itself an exact tie, Stone id 201 vs Charcoal id 403) | Hybrid | M0 golden tests |
| Quarantine-with-provenance data hygiene: Ruby curated row flagged, Bank Portal and 2-input Type-1 mode behind config flags | Hybrid | M0 normalizer |
| Same-item netting at load (Steel's 4-in/3-out Iron Ingot → net 1; net-≤0 outputs are non-edges) | Hypergraph | M0 normalizer |
| Inverted index item→triples worklist: a single item-price change touches only triples containing it | Hypergraph | M3 incremental rescan |
| λ-sweep presented as an explicit gold-vs-floor-slots Pareto frontier with route-flip crossover points — a *frontier*, never "the cost" | Hypergraph | M4 visualization |
| Screen self-consuming/degenerate triples (output ∈ inputs) out of explanation and accept/reject reporting | Lesson from hypergraph's Gold Dust exhibit | M2 trace layer |
| Fragility flagging with exact-arithmetic argmin and margin metadata (already in the winning proposal; every judge endorsed it) | MILP | M0 compiler |
| Fix machine fungibility: per-(recipe,machine) dedication integers on the *active* column set (post-CG, so the integer count stays small), because in-game machines dedicate to one recipe — per-TYPE time-slicing yields unbuildable lower bounds | Cross-examination of both LP designs | M2 MILP pass |
| Finite-difference warm re-solves (not raw duals) for buy-vs-craft thresholds and skill rankings wherever the optimum is degenerate | MILP's own risk note + judges | M3 advice layer |

---

## 3. Technical design

### 3.1 Data model

A single normalized **Process** (column) table compiled at load from `alchemy_db.v41.json` + `mechanics.json` + `skills.json`:

```ts
interface Process {
  id: string;
  kind: 'recipe' | 'cauldron' | 'catalystVariant' | 'purchase' | 'sale'
      | 'burn' | 'fertilize' | 'mint';
  machine?: string;          // machine type, for capacity row
  timeSec: number;           // machine-seconds consumed per execution
  consumes: Map<ItemId, number>;
  produces: Map<ItemId, number>;
  heatPerRun: number;        // signed contribution to HEAT row
  nutrientDelta: number;     // signed contribution to NUTRIENT row
  flags: { fragileMargin?: number; selfConsuming?: boolean;
           quarantined?: 'bankPortal' | 'rubyRow' | 'type1Mode' | 'worldTreeDual';
           provenance: string };
}
```

**Rows (≈200 total):**
- 146 item balance rows (net production ≥ demand; = 0 for intermediates in min-cost mode).
- `HEAT` pseudo-row: burn columns produce `item.heat × fuelMult`; heated machines consume `machine.heatCost × baseTime` per run (`heatCost = −1` on Cauldrons → per-craft piecewise value); cauldron columns consume the interpolated per-craft heat.
- `NUTRIENT` pseudo-row: fertilize columns produce `item.nutrientValue × fertMult`; the 6 baseTime-less Nursery crop columns consume `nutrientCost`; **seeds are plot capital, not per-harvest inputs** (moldy530's nursery handling; flagged open question, §6).
- ~36 `MACHINESEC_m` capacity rows: every column consumes `timeSec` on its machine's row; capacity = `n_m × 60 × speedMult` per minute, with `n_m` either fixed (current-factory mode) or integer decision variables priced at amortized `buildCost`.
- Optional per-item belt-cap rows.

**Load-time normalizations (all forced by measured data facts):**
- **Same-item netting** (hypergraph): Steel's 4-in/3-out Iron Ingot collapses to net 1; net-≤0 outputs are non-edges for that head.
- Multi-output recipes (16) are columns with multiple positive coefficients — zero special-casing; flow balance nets them exactly (Steel's 3-iron return; Athanor CP+ICP pair; Meteorite Processing's 9 outputs).
- The 4 curated `machine: "Cauldron"` recipe rows are **excluded from route competition** in favor of the formula (hypergraph's call), with the Ruby contradiction kept as a flagged provenance record and a validation alarm (its triple computes to Perfect Diamond, d=1,278, not Ruby, d=67,650).
- Quarantine flags: Bank Portal mints ({} → 50 coins, priced at face value — assumption), World Tree_Dual's 99-leaves-from-nothing row (excluded from unit costs), 2-input Type-1 cauldron mode (feature-flagged pending machine-mapping confirmation).
- Buy columns for the 18 buyables (verified disjoint from craftables — pure sources); sell columns for the 46 sellables. Copper Powder and Impure Copper Powder have **no sellPrice** — load-bearing for Scenario B (§4).
- Skills are pure coefficient parameters: `alchemyMult` scales Extractor/Alembic-family outputs, `fuelMult`/`fertMult` (1 + 0.10×lvl) scale HEAT/NUTRIENT contributions, `speedMult` scales capacity, belt level optionally caps flow rows.

### 3.2 Cauldron recipe compiler (the central requirement)

The cauldron's triple→output map depends **only on static `cauldronCost` values**, so the entire implicit recipe space is compiled once at load:

- **Eligibility:** 135 inputs (146 items minus 11 liquid-flagged; rule from `raw/starfi5h/alchemy_cauldron.js:22-25`).
- **Enumeration:** C(137,3) = **419,220** unordered triples-with-repetition. Measured: full enumeration + 47-target argmin in **17–74 ms** (three independent implementations agree); a dual-pricing rescan with the map precomputed is **~2 ms** (3 adds per triple).
- **Output rule (exact arithmetic):** T = (c1+c2+c3) × ratio, ratio = 0.5 (all identical) / 0.65 (exactly two identical) / 1.0 (all different); output = argmin |T − cauldronTarget| × cauldronMulti over the 47 targets; epsilon 1e-7 then lower-id tiebreak. Implement with **scaled-integer cauldronCosts** — ties are real and load-bearing: Sage Seeds+Flax Seeds+Rock Salt → T=325 exactly equidistant between Copper Powder (id 608) and Black Powder (id 614); Plank+Coke Powder+Bronze Ingot → T=325, same exact tie; Plank+Charcoal Powder+Quicklime Powder → T=10.5, exact d=4.5 tie between Iron Sand (303) and Quicklime (401). Keep `cauldronMulti` in the formula (all currently 1).
- **Cost coefficients:** heat and time piecewise-linear on the *output's* cauldronTarget — targets [1,100,1000,10000,1000000] → time [3,6,12,24,60] s, heat [1,20,200,1500,10000] (verified against the curated Ruby row's 30.9 s / 3131.3 heat at target 200,000).
- **Per-triple column:** ≤6 nonzeros (up to 3 input rows with repeat multiplicities, +1 output row, HEAT, MACHINESEC_Cauldron). Total block ≈ 2.4M nonzeros.
- **No cost-based pruning, ever** (plateau finding: a 5% band keeps 31,484 columns). The full block is data, not search. The *interactive* path restricts which columns are loaded, never which exist.
- **Fragility flags, not pruning:** triples whose winning margin is below epsilon are flagged `fragile` (real case: the copper-dup ICP triple wins over Turquoise by 0.354 cost units) and surfaced in the UI with margin metadata.
- **Self-consuming flag:** triples with output ∈ inputs are marked; they remain valid LP columns (the LP prices them correctly) but are screened from accept/reject reporting and never offered as explanations.
- **Inverted index** item→triples for incremental rescans.
- **Input-pool toggles:** buyables-only (C(22,3) = 1,540 from 20 buyable-eligible inputs; the no-farming scenario), no-crafted-inputs, unrestricted.
- Per-output group sizes (measured): Plank 4, Charcoal 54 … Impure Copper Powder 10,055, Copper Powder 6,245, Ruby 23,624, Philosopher's Stone 44,882. All 47 outputs are themselves eligible inputs — the compiler does nothing special for output→input chaining; the LP's flow balance handles arbitrary depth.

### 3.3 Solver

**HiGHS** everywhere (Apache-licensed; `highspy` native for CLI/batch, `highs-js` WASM in-browser). YALPS (moldy530's) is retired; moldy530's `lp-planner/model-builder.ts` is read for the variable/constraint shape, nursery seed handling, and self-fuel toggles only (unlicensed — re-implement).

Two solve paths over the same model:

1. **Canonical batch path (CLI, CI, regression):** full column block — ~420k columns (168 recipes + 419,220 triples + ~80 catalyst variants + 18 buys + 46 sells + burns/ferts + machine-count integers), ~200 rows, ~2.4M nonzeros. Native HiGHS: low single-digit seconds cold. This is the ground truth every other path is checked against.
2. **Interactive path (browser default):** restricted master with ~1–2k columns (all machine recipes, buys/sells, catalyst variants, plus per-output top-K cauldron columns as warm start) + **column-generation loop**: solve → rescan all 419,220 triples against current duals (~2 ms with the precomputed map) → admit negative-reduced-cost columns → warm-started dual-simplex re-solve. Run the rescan after *every* solve and *every* knob change — at 2 ms it is free, and it eliminates the hybrid's stale-pruned-set failure mode. The rescan also runs after every game-patch data refresh as a staleness check. CG round count and WASM memory must be *benchmarked in M3*, not assumed; server-side solve is the fallback.

**Integer pass (min-machines / floor-slots):** in-game machines dedicate to one recipe, so per-TYPE time-slicing integers give unbuildable lower bounds. The MIP pass adds **per-(recipe,machine) dedication integers over the active column set only** (post-CG, typically tens of integers), objective Σ slotsRequired-weighted machine counts subject to target rate. Acknowledge honestly: CG exactness is certified at the LP level; the MIP over the CG-frozen column set is very-good-but-not-certified (branch-and-price is out of scope). The full-block batch path can verify any suspicious MIP answer.

**Advice layer:** buy-vs-craft thresholds, skill-point ranking, and fuel/fert gold-per-unit come from duals *when the basis is non-degenerate* and from **finite-difference warm re-solves** (~ms each) otherwise — 16 multi-output recipes make degenerate optima the norm, so FD is the default and duals are the fast path.

### 3.4 Loop handling

Steady-state flow balance makes cycles flows, and **capacity rows make amplifying loops bounded decisions** — this is the canonical semantics, replacing every fictional-wage knob (λ, P_time) in the losing proposals:

- **Self-fuel** (Plank→Charcoal in a Crucible burning Charcoal Powder): columns whose net HEAT contribution ≥ 0; the LP finds the equilibrium fuel price 1/32 g/heat (Charcoal Powder beats raw Logs at 1/10) with no bootstrap.
- **Self-fert** (Sage → Plant Ash → Basic Fertilizer, 36→144 nutrients): genuinely amplifying and crop-gated with zero buyable fertilizers — recursive engines return ∞ or 0 on it; flow balance yields equilibrium nutrient price ≈ 0.0509 g (buy-fuel anchor).
- **Cauldron matter loops** (verified copper-duplication: Copper Bearing+Quicklime Powder+Copper Coin → ICP; Bronze Ingot+Bronze Rivet+Copper Coin → CP; net 1 Copper Ingot → 1 Copper Ingot + 2 Bronze Rivets from stone, coins, heat): under material-only costing these drive every reachable cost to exactly 0 (the recursive fixed point measurably collapses economy-wide). With capacity rows + integer cauldron counts the answer becomes "run the loop at N cauldrons," and the cauldron machine-second dual prices exactly what one more cauldron earns.
- **UX:** anchoring toggles (forbid self-fuel/self-fert columns, restrict cauldron input pool) for players who don't want loop-dependent plans, plus the regime-switch explainer when an item's material cost collapses toward 0.
- Within-recipe catalytic loops (Steel's iron return) are removed structurally by same-item netting at load.

### 3.5 Catalyst variants (Advanced Athanor)

Each of the 5 catalyst-bearing recipes (Silver Powder ChargeCost 1500, Gold Dust 10000, Malachite_Alt 72, Lapis Lazuli 3300, Obsidian 840) expands at load into columns per catalyst *stack* (eternal→unstable→resonant→fertile application order from `mechanics.json`, ~80 columns total), each consuming `ChargeCost/charges` catalyst items (Eternal: zeroes material inputs, + ChargeCost/99999 ≈ 0.1 catalyst per batch). Catalysts are ordinary items with their own producing columns — Unstable/Fertile/Resonant are cauldron-producible (verified targets 740 / 3,561.84 / 27,977.44), Eternal is Arcane Processor only — so "catalysts are craftable" is free. **Stacking co-load semantics need one in-game confirmation**; until then stacked columns sit behind a flag and the 20 single-catalyst variants are live.

### 3.6 Objectives

1. **Min cost per unit of target:** target row ≥ rate, minimize purchase gold. Primary mode; the Mars scenarios.
2. **Max gold/min:** maximize Σ sellPrice·sell − Σ buyPrice·buy subject to capacity/slot budget. Capacity rows keep amplifying loops bounded; answer in the loop regime is "run the dup loop at cauldron capacity."
3. **Min machines / floor slots:** MIP with per-(recipe,machine) dedication integers (§3.3). Lexicographic combinations (min machines among min-cost optima) via objective-as-constraint re-solve.
4. **Buy-vs-craft:** buy columns enter the basis exactly when buyPrice ≤ the item's marginal value; reported per item as craft-value vs buyPrice (FD-backed under degeneracy).
5. **Skill-investment ranking:** marginal gold/min of +1 level per track via warm-started FD re-solves.
6. **Fuel/fert choice:** HEAT/NUTRIENT row duals = gold-per-heat / gold-per-nutrient, consistent with everything else the factory does.
7. **λ-sweep frontier (visualization, M4):** machine-time price as an explicit gold-vs-slots Pareto dial with route-flip crossover points — presented as a frontier, never as "the cost."

### 3.7 Explanation layer (first-class, M2)

Decompose the optimal flow vector into a per-node route tree: for each item with positive net demand, attribute flows to producing columns, recurse, and render "chose cauldron [A+B+C] (T=…, margin …) at 35 g because the machine route costs 844 g." Requirements:
- Per-node winning-margin and fragility metadata on every cauldron node.
- Self-consuming triples never appear as explanations.
- Cycles render as explicit loop annotations ("self-sustaining at N cauldrons"), not infinite trees.
- Run-to-run plan stability: on degenerate optimal faces, tie-break basis selection deterministically (e.g., prefer lower-id columns / previously chosen plan) so the UI doesn't flicker between cost-equivalent plans.

---

## 4. Canonical test case: the Mars cauldron shortcut

Mars (id 620, sellPrice 280,000) has **no cauldronTarget** — it cannot be cauldron-made directly. Its only recipe is Shaper {600 Iron Nails, 300 Steel Gear, 600 Bronze Rivet, 300 Copper Bearing} ⇒ upstream demand 200 Impure Copper Powder (cauldronTarget 180) + 150 Copper Powder (target 350), among others. The shortcut lives two levels down, and the formulation finds it without being told where to look. Three regimes, one architecture:

**Scenario A — purchases-only, no farming.** The no-cauldron LP is **INFEASIBLE**: ICP's only machine recipe is Athanor {12 Iron Sand, 12 Soap Powder}, and Soap requires Nursery crops. With the cauldron block, the solver prices Gelatinous Gridlock×3 (buyable @100 g; all-identical ratio 0.5 ⇒ T=150; d=30 beats Turquoise's 42 — verified, and independently confirmed as the cheapest of all C(22,3) buyables-only ICP routes) → ICP at **301.13 g** (300 + 36 heat × 1/32 g/heat from the Plank→Charcoal Powder fuel loop). Bronze Ingot 302.63 → 600 Rivets 60,525. Copper Ingot via Kiln {400 Copper Coin} = 405.63 (the solver compares and beats Refiner 2×ICP at 602.25). 300 Bearings 60,844; 600 Iron Nails 2,738; 300 Steel Gears 37,706 — Steel returns 3 of its 4 Iron Ingots, credited automatically by flow balance (a recursive engine charges +33%). **Total ≈ 161,800 g/Mars, profit ≈ 118,000.** The cauldron *unlocks* Mars where it was otherwise impossible.

**Scenario B — farming available (the joint-product trap).** The Athanor run costs 314.25 g and yields the CP+ICP **pair** (~157 effective each). The naive narrative — "the LP rejects the cauldron entirely" — is wrong, and the correctness judge's correction is now the pinned regression: Mars demands **200 ICP : 150 CP, not 1:1, and Copper Powder has no sellPrice** (verified), so the 50-unit CP excess from 200 Athanor runs is unsalvageable. The true LP optimum **mixes routes**: 150 Athanor runs (47,137.50 g) + 50 ICP via GG×3 (15,056.50 g) = **62,194 g** for the powder block, beating the all-Athanor plan's 62,850 g. Mars total ≈ **103,100 g**. The GG cauldron column has negative reduced cost *at the margin* and enters the basis — joint-product demand-ratio mismatch is exactly what per-node greedy engines cannot represent and what flow balance gets for free. **Regression test: assert the mixed basis, not just the total.**

**Scenario C — unrestricted crafted-input triples (the loop regime).** The verified copper-duplication loop (ICP triple wins by margin 0.354 — flagged fragile) drives marginal material cost ≈ 0; the profit LP is unbounded without capacity rows. With integer cauldron counts the answer is "N cauldrons at full utilization," and the cauldron machine-second dual reports exactly what one more cauldron earns. The UI switches to the self-sustaining explainer.

**Golden test suite (pinned at M0, exact arithmetic):**
- GG×3 → ICP, T=150, d=30 (margin 12 over Turquoise).
- Flax Seeds×3 → ICP, d=7.5.
- Quartz Ore+Flax Seeds+Limestone → CP, d=2.
- Exact ties: Sage Seeds+Flax Seeds+Rock Salt, T=325 → id 608; Plank+Coke Powder+Bronze Ingot, T=325 → id 608; Plank+Charcoal Powder+Quicklime Powder, T=10.5 → Iron Sand id 303; Flax crops×3, T=3 → Stone id 201 over Charcoal id 403.
- Seeds-vs-crops: Flax Seeds cc=115 ≠ Flax crop cc=2.
- Fragile-margin case: Copper Bearing+Quicklime Powder+Copper Coin, T=144.177, ICP d=35.823 vs Turquoise d=36.177.
- Ruby curated-row contradiction alarm (computes to Perfect Diamond).
- Piecewise interp: target 180 → 36 heat/6.53 s; target 200,000 → 3131.3 heat/30.91 s.
- Scenario A infeasibility without cauldron; Scenario B mixed basis (150/50); Scenario C boundedness with capacity rows.

---

## 5. Implementation plan

**M0 — Data foundation (days 1–3).**
Normalizer (v41 + mechanics.json + skills.json → Process table; same-item netting; quarantine flags; catalyst single-variant expansion). Cauldron column compiler: exact-arithmetic enumeration + argmin, fragility/self-consuming flags, per-output groups, inverted index, input-pool toggles. **Golden test suite from §4.** Ships: a verified, diffable compiled-model artifact — the patch-absorption story (re-run compiler + golden tests on every game patch).

**M1 — Correct core LP (week 1).**
HiGHS LP with item + HEAT + NUTRIENT + **machine-capacity rows from day one** (fixed machine counts mode), buy/sell columns, min-cost-per-target objective, buy-vs-craft report. CLI: `cost <item>` with raw flow output. Reproduces Scenarios A and B (including the mixed basis) end to end. *The first shipped number is already trustworthy* — no degenerate week-1 configuration.

**M2 — Explanation, anchoring, MILP (week 2).**
Flow→route-tree decomposition with margins and fragility surfaced (the tooltip artifact). Anchoring-mode toggles + self-sustaining regime explainer. Max-profit objective. Integer machine counts with per-(recipe,machine) dedication; min-machines/slots objective. Stacked catalyst columns behind the co-load flag. Scenario C ships here.

**M3 — Interactive path (week 3).**
Restricted master + ~2 ms dual-rescan column generation, warm starts, inverted-index incremental rescans. **Benchmark CG rounds and highs-js WASM memory on real instances** — these are the asserted-not-measured claims; server-side solve is the contingency. FD-backed advice layer (skill ranking, buy-vs-craft under degeneracy). Slider-grade UI for skills/fuel/toggles.

**M4 — Throughput & product polish (week 4).**
Port starfi5h planner semantics: belt caps, furnace slot demand via parent/slotsRequired, machine placement counts. λ-sweep Pareto frontier visualization with crossover points. Scenario presets. In-game verification tasks: Ruby row, Type-1 mode mapping, Bank Portal exchange, catalyst co-loading, nursery seed/growth-time semantics — each isolated behind the M0 flags.

Total ≈ 4 engineer-weeks; a trustworthy tool exists at end of week 1, the player-facing product at end of week 2.

---

## 6. Open risks and decision-changers

**Risks (mitigated in-design):**
- **Data fidelity — Ruby curated row** contradicts the deterministic formula. Validation alarm ships in M0; gem-tier plans untrusted until in-game verification.
- **Knife-edge argmins** flip silently under balance patches (cauldron reworked 2026-06-02; rails land Summer 2026). Exact arithmetic + fragility flags + golden tests per dataset version are the mitigation; re-run compiler + tests on every patch.
- **WASM memory / CG convergence unmeasured.** The full block may strain highs-js; CG may tail off under dual degeneracy (16 multi-output recipes). M3 benchmarks both; fallbacks: restricted-master-only browser mode (with rescan backstop) or server-side solve.
- **Dual degeneracy** makes raw shadow prices non-unique; FD re-solves are the default advice mechanism, duals the fast path.
- **MIP-over-CG-columns** is not certified optimal (no branch-and-price). The full-block batch path is the audit tool; if min-machines becomes the headline objective, revisit.
- **Unverified game semantics:** Bank Portal mint pricing (face value — assumption), nursery seeds-as-capital and missing growth time (if plots consume seeds per harvest or growth time is real, crop-fed cauldron routes get more expensive — one coefficient each, but published numbers shift), 2-input Type-1 mode machine mapping, catalyst co-loading. All flag-isolated; ~half a day of in-game checks in M4.
- **Plan instability on degenerate faces:** deterministic basis tie-breaking in the trace layer; without it the UI flickers between cost-equivalent plans.
- **Scope guard:** physical layout (splitter ratios, per-parent furnace slot sharing) stays out of the LP — aggregate slot budgets only, or the MILP blows up.

**What would change the decision:**
- **If in-game verification shows cauldron output is *not* a pure function of static cauldronCosts** (hidden state, randomness, special-cased items beyond Ruby): the pre-enumeration premise breaks. Fallback: the recursive engine's simulator-backed discovery sweep becomes the candidate generator feeding the same LP — the architectures compose over the shared Process table.
- **If HiGHS-WASM is unusable in-browser and server-side hosting is unacceptable:** the interactive product collapses to the hybrid's small-master-only mode permanently; the full block remains CI-only. Architecture survives; deployment story changes.
- **If a patch makes the cauldron non-dominant or removes the gain>1 loops:** capacity rows and the loop UX become less load-bearing, and a simpler LP (or even the recursive engine for pure min-cost) would suffice — but the formulation degrades gracefully to that case anyway.
- **If users overwhelmingly want only single-item cost tooltips and never profit/machine planning:** the recursive engine's week-one trace would have been the cheaper product. The M2 trace layer is the hedge; if M3/M4 demand never materializes, stop after M2.

---

## 7. Prior art and licensing

- `raw/moldy530/engine/lp-planner/` (TypeScript, YALPS, pre-cauldron-rework, **unlicensed**): read for the flow-balance skeleton, per-minute rate variables, nursery seed handling, self-fuel toggles. **Re-implement; do not copy.**
- `raw/starfi5h/alchemy_calc_engine.js` + `alchemy_cauldron.js` (current): authoritative for the liquid-exclusion rule, 1e-7 tie epsilon, catalyst application order, belt/slot/byproduct planner semantics (port semantics in M4).
- Solver: HiGHS (Apache-2.0).
