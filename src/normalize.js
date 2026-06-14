// Process-table normalizer (DESIGN.md §3.1).
//
// Compiles the raw DB + config into the column set the LP is built from:
//   recipe / catalystVariant / purchase / sale / burn / fertilize / mint columns
// plus a compact handle to the 419k cauldron triples (materialized on demand
// by the column-generation loop — never expanded into objects up front).
//
// Each explicit process column:
//   { id, kind, machine?, timeSec, consumes: {item: qty}, produces: {item: qty},
//     heat,      // net HEAT row contribution per run (+ produces, − consumes)
//     nutrient,  // net NUTRIENT row contribution per run
//     copperCost, copperRevenue,  // objective coefficients per run
//     primary?,  // primary output item (recipes)
//     flags: { ... provenance/quarantine/fragility } }

'use strict';

const { cauldronEligibility } = require('./cauldron');
const { skillParams } = require('./config');
const { tiers } = require('./tiers');

// Virtual-item prefixes. These name LP rows that don't exist as real items — used
// to fence off supply so it can only be used in a specific role:
//   BYPROD::Y  — a co-product output, sellable or reuse-convertible but NOT
//                manufacturable as a primary (kills the sell-mode arbitrage where
//                the LP minted coins → cauldroned gems → sold them for profit).
//   BELT::X    — a main-belt supply unit, consumable only as fuel/fertilizer/cash,
//                never as recipe material (a fuel belt shouldn't feed bulk inputs).
const BYPROD = 'byprod::';
const BELT = 'belt::';
const COPPER = 'copper::cash'; // virtual currency row, denominated in copper (1 silver = 1000, 1 gold = 100000)
const VIRT_EPS = 1e-9; // microscopic cost on virtual-conversion columns to break LP degeneracy
const stripVirtual = (name) => name.replace(/^(?:byprod|belt)::/, '');

const YIELD_MULT_MACHINES = new Set(['Extractor', 'Thermal Extractor', 'Alembic', 'Advanced Alembic']);
const CATALYSTS = {
  unstable: { item: 'Unstable Catalyst', charges: 180 },
  fertile: { item: 'Fertile Catalyst', charges: 240 },
  resonant: { item: 'Resonant Catalyst', charges: 1500 },
  eternal: { item: 'Eternal Catalyst', charges: 99999 },
};

// Primary output: exact id match, else id with a _Suffix stripped, else single
// output, else first output key (flagged ambiguous).
function primaryOutput(recipe) {
  const outs = Object.keys(recipe.outputs || {});
  if (outs.includes(recipe.id)) return { primary: recipe.id, ambiguous: false };
  const stripped = recipe.id.replace(/_[^_]*$/, '');
  if (outs.includes(stripped)) return { primary: stripped, ambiguous: false };
  if (outs.length === 1) return { primary: outs[0], ambiguous: false };
  return { primary: outs[0], ambiguous: true };
}

// Same-item netting: Steel Ingot consumes 4 Iron Ingot, produces 3 → net consume 1.
function netSameItems(consumes, produces) {
  for (const item of Object.keys(produces)) {
    if (consumes[item] === undefined) continue;
    const net = produces[item] - consumes[item];
    delete produces[item];
    delete consumes[item];
    if (net > 0) produces[item] = net;
    else if (net < 0) consumes[item] = -net;
  }
}

// Heat consumed per run by a heated machine: own draw is speed-invariant per
// batch (heatCost × baseTime); the shared furnace overhead burns in real time,
// so it scales down with speedMult (starfi5h engine semantics).
function machineHeatPerRun(machine, machines, baseTime, speedMultVal) {
  if (!machine || machine.heatCost === undefined || machine.heatCost <= 0) return 0;
  let heat = machine.heatCost * baseTime;
  const parent = machine.parent ? machines[machine.parent] : null;
  if (parent && parent.heatSelf && parent.slots) {
    heat += parent.heatSelf * (machine.slotsRequired / parent.slots) * (baseTime / speedMultVal);
  }
  return heat;
}

function applyByproductPolicy(proc, cfg, warnings, byprodSell) {
  if (!proc.primary) return;
  const { mode, perItem } = cfg.byproducts;
  for (const item of Object.keys(proc.produces)) {
    if (item === proc.primary) continue;
    const policy = perItem[item] ?? mode;
    if (policy === 'trash') {
      // Remember the per-run quantity so the flow graph can surface a "→ trash" stub
      // (waste you must discard), not just silently drop the co-product.
      (proc.flags.trashed ??= {})[item] = proc.produces[item];
      delete proc.produces[item];
    } else if (policy === 'sell') {
      // Route the co-product to a virtual byproduct row. It can then be SOLD
      // (salebp column) or REUSED downstream (reusebp conversion back to the real
      // item) — but a recipe/cauldron making this item as a PRIMARY puts it in the
      // normal row, which the sale column can't reach. That's what stops the
      // optimizer manufacturing sellables for profit.
      const qty = proc.produces[item];
      delete proc.produces[item];
      proc.produces[BYPROD + item] = qty;
      byprodSell.add(item);
    }
    // 'reuse' keeps the coefficient in the normal row (reused downstream / discarded)
  }
}

function buildProcessTable(db, cfg) {
  const params = skillParams(cfg.skills);
  const warnings = [];
  const processes = [];
  const byprodSell = new Set(); // items with a 'sell'-policy co-product anywhere
  const virtualItems = new Set(); // extra LP rows (byprod::/belt::) the model must register
  const items = db.items;
  const machines = db.machines;
  const forceCauldron = new Set(cfg.cauldron.forceFor);
  const forbidCauldron = new Set(cfg.cauldron.forbidFor);
  for (const name of [...forceCauldron, ...forbidCauldron]) {
    if (!items[name]) throw new Error(`cauldron override references unknown item "${name}"`);
  }

  const buyDeny = new Set(typeof cfg.buy === 'object' ? cfg.buy.deny ?? [] : []);
  // buy.allow restricts ALL external inputs (purchases AND coin mints) to a
  // user-supplied set — "here is what I'm willing to feed the factory".
  const buyAllow = typeof cfg.buy === 'object' && cfg.buy.allow ? new Set(cfg.buy.allow) : null;
  const buyEnabled = cfg.buy === true || typeof cfg.buy === 'object';
  const buyAllowed = (name) => buyEnabled && !buyDeny.has(name) && (!buyAllow || buyAllow.has(name));

  // --- unlock-tier gating (effective tiers: see src/tiers.js) ---
  const maxTier = cfg.maxTier;
  const T = tiers(db);
  const locked = (name) => maxTier != null && T.effective(name) > maxTier;
  // Rows exempt from tier-locking: copper::cash is money (always mintable, no item
  // tier), and belt:: rows are EXTERNAL supply the user asserts they already have
  // arriving (coins, fuel, fert) — neither should be gated by what you can craft at
  // your tier. Without this, every purchase (consumes copper::cash) and any belt coin
  // whose effective tier exceeds the cap (Silver/Gold Coin compute to tier 8 because
  // coins trace through the Coin Processor) get dropped, so the belt silently does
  // nothing and the planner falsely forces cauldron/farming routes.
  const lockExempt = (name) => name === COPPER || name.startsWith(BELT);
  const machineLocked = (m) => maxTier != null && m && T.machineTier(m) > maxTier;

  // --- machine recipe columns (incl. curated cauldron rows + catalyst variants) ---
  const curatedMode = cfg.quarantine.curatedCauldronRows;
  const formulaActive = cfg.cauldron.enabled;
  for (const recipe of db.recipes) {
    const machine = machines[recipe.machine];
    const isCurated = (recipe.machine === 'Cauldron' || recipe.machine === 'Advanced Cauldron');

    // skip recipes whose machine isn't unlocked yet (Bank Portal handled below)
    if (machineLocked(recipe.machine) && recipe.machine !== 'Bank Portal') continue;

    if (recipe.machine === 'Bank Portal') {
      if (!cfg.quarantine.bankPortal) continue;
      // {} → 50 coins. Priced at face value (sellPrice/coin) — ASSUMPTION.
      const [coin, qty] = Object.entries(recipe.outputs)[0];
      if (buyAllow && !buyAllow.has(coin)) continue; // mints count as external inputs
      processes.push({
        id: `mint:${coin}`, kind: 'mint', machine: recipe.machine,
        timeSec: recipe.baseTime ?? 1,
        consumes: {}, produces: { [coin]: qty },
        heat: 0, nutrient: 0,
        copperCost: qty * (items[coin].sellPrice ?? 0), copperRevenue: 0,
        primary: coin,
        flags: { provenance: 'bankPortal-faceValue-assumption' },
      });
      continue;
    }

    if (isCurated) {
      const rubyLike = recipe.id === 'Ruby'; // contradicts the formula — never trusted
      const include = !rubyLike && (curatedMode === 'auto' ? !formulaActive : curatedMode === true);
      if (!include) {
        if (rubyLike) warnings.push('curated Ruby cauldron row excluded (contradicts deterministic formula: computes to Perfect Diamond)');
        continue;
      }
    }

    const { primary, ambiguous } = primaryOutput(recipe);
    if (ambiguous) warnings.push(`recipe ${recipe.id}: ambiguous primary output, using "${primary}"`);
    if (forceCauldron.has(primary)) continue; // user: this item comes via cauldron only

    const yieldMult = YIELD_MULT_MACHINES.has(recipe.machine)
      ? params.alchemyMult * (recipe.machine === 'Thermal Extractor' ? 3 : 1)
      : 1;

    const makeBase = () => {
      const consumes = { ...recipe.inputs };
      const produces = {};
      for (const [item, qty] of Object.entries(recipe.outputs)) produces[item] = qty * yieldMult;
      return { consumes, produces };
    };

    const pushRecipeColumn = (idSuffix, consumes, produces, extraFlags) => {
      // Canonical-utility lock: drop non-canonical producers of a utility-exclusive item
      // (fuel/fert chain), so the build uses the pre-solved clean tile, not a wasteful alt.
      // Never forbid producing the DEMANDED item itself (e.g. when the target IS a
      // fertilizer) — that would make the requested build infeasible.
      if (cfg.canonical && cfg.canonical.forbidRecipeIds && cfg.canonical.forbidRecipeIds.has(`recipe:${recipe.id}${idSuffix}`)
        && !(cfg.canonical.exemptItem && produces[cfg.canonical.exemptItem])) return;
      netSameItems(consumes, produces);
      const baseTime = recipe.baseTime ?? 0;
      let heat = -machineHeatPerRun(machine, machines, baseTime, params.speedMult);
      if (machine && machine.heatCost === -1) heat = -(recipe.heatCost ?? 0); // curated cauldron rows
      const proc = {
        id: `recipe:${recipe.id}${idSuffix}`, kind: idSuffix ? 'catalystVariant' : 'recipe',
        machine: recipe.machine, recipeId: recipe.id,
        timeSec: baseTime,
        consumes, produces,
        heat,
        nutrient: -(recipe.nutrientCost ?? 0),
        copperCost: 0, copperRevenue: 0,
        primary,
        flags: { ...extraFlags },
      };
      if (recipe.machine === 'World Tree Nursery' && !cfg.quarantine.worldTreeDual) return;
      applyByproductPolicy(proc, cfg, warnings, byprodSell);
      processes.push(proc);
    };

    const { consumes, produces } = makeBase();
    pushRecipeColumn('', consumes, produces, isCurated ? { provenance: 'curated-cauldron-row' } : {});

    // Catalyst variants (Advanced Athanor recipes with ChargeCost)
    if (cfg.catalysts.enabled && recipe.ChargeCost !== undefined && recipe.machine === 'Advanced Athanor') {
      const variants = [
        ['eternal', () => ({ consumes: {}, produces: makeBase().produces })],
        ['unstable', () => recipe.unstableOutputs && { consumes: { ...recipe.inputs }, produces: { ...recipe.unstableOutputs } }],
        ['resonant', () => recipe.resonantOutputs && { consumes: { ...recipe.inputs }, produces: { ...recipe.resonantOutputs } }],
        ['fertile', () => {
          const b = makeBase();
          for (const k of Object.keys(b.produces)) b.produces[k] *= 2;
          return b;
        }],
      ];
      for (const [cat, build] of variants) {
        const built = build();
        if (!built) continue;
        const { item: catItem, charges } = CATALYSTS[cat];
        built.consumes[catItem] = (built.consumes[catItem] ?? 0) + recipe.ChargeCost / charges;
        pushRecipeColumn(`@${cat}`, built.consumes, built.produces, { catalyst: cat });
      }
      // Stacked combos are behind cfg.catalysts.stacked (in-game co-load unverified).
      if (cfg.catalysts.stacked) warnings.push('stacked catalyst columns not implemented (co-load semantics unverified in-game)');
    }
  }

  // --- copper cash row + purchase / sale columns ---
  // Money is modelled as an explicit copper-denominated flow, not an abstract cost
  // scalar. A purchase consumes `buyPrice` copper at the Purchasing Portal; that
  // copper comes from either belt-supplied coins (free, see belt section) or the
  // mint valve below (the "money you spend" — priced 1 copper of objective per
  // copper produced, so the optimum is identical to the old abstract cost, but now
  // belt coins visibly offset it and the Purchasing Portal draws a real coin edge).
  virtualItems.add(COPPER);
  processes.push({
    id: 'mint:copper', kind: 'cash', timeSec: 0,
    consumes: {}, produces: { [COPPER]: 1 },
    heat: 0, nutrient: 0, copperCost: 1, copperRevenue: 0,
    flags: { provenance: 'copper-valve' },
  });
  for (const [name, item] of Object.entries(items)) {
    if (item.buyPrice !== undefined && buyAllowed(name)) {
      processes.push({
        id: `buy:${name}`, kind: 'purchase', timeSec: 0,
        consumes: { [COPPER]: item.buyPrice }, produces: { [name]: 1 },
        heat: 0, nutrient: 0, copperCost: 0, copperRevenue: 0,
        flags: { buyPrice: item.buyPrice },
      });
    }
    if (cfg.sell && item.sellPrice !== undefined) {
      processes.push({
        id: `sell:${name}`, kind: 'sale', timeSec: 0,
        consumes: { [name]: 1 }, produces: {},
        heat: 0, nutrient: 0, copperCost: 0, copperRevenue: item.sellPrice,
        flags: {},
      });
    }
  }

  // --- burn (fuel→HEAT) and fertilize (item→NUTRIENT) columns ---
  // Crafted/bought fuel & fertilizer. Belt-supplied fuel/fert is handled in the
  // belt section below (it converts a belt:: row, not the real item, so a fuel belt
  // can't also satisfy material demand for that item).
  // Canonical-utility lock: when set, only the chosen carrier may be burned/fertilized
  // for self-supply — so every build's fuel is the same canonical item (belt-supplied
  // fuel/fert is separate, handled below, and is never restricted here).
  const canonFuel = cfg.canonical && cfg.canonical.fuelItem;
  const canonFert = cfg.canonical && cfg.canonical.fertItem;
  for (const [name, item] of Object.entries(items)) {
    const buyable = item.buyPrice !== undefined;
    if (item.heat !== undefined && item.heat > 0 && (cfg.selfFuel || buyable) && (!canonFuel || name === canonFuel)) {
      processes.push({
        id: `burn:${name}`, kind: 'burn', timeSec: 0,
        consumes: { [name]: 1 }, produces: {},
        heat: item.heat * params.fuelMult, nutrient: 0,
        copperCost: 0, copperRevenue: 0, flags: {},
      });
    }
    if (!cfg.noFert && item.nutrientValue !== undefined && item.nutrientValue > 0 && (cfg.selfFert || buyable) && (!canonFert || name === canonFert)) {
      processes.push({
        id: `fert:${name}`, kind: 'fertilize', timeSec: 0,
        consumes: { [name]: 1 }, produces: {},
        heat: 0, nutrient: item.nutrientValue * params.fertMult,
        // carry the fertilizer's maxFertility so the graph can size Nursery plots
        maxFertility: item.maxFertility,
        copperCost: 0, copperRevenue: 0, flags: {},
      });
    }
  }

  // --- main-belt supply: fuel / fertilizer / cash only ---
  // The main belt is for fuel, fertilizer, and coins — not bulk material feedstock
  // (a fuel belt can't supply the 4× Coke Powder a Steel recipe eats; that has to
  // be crafted). So a belt fuel/fert item produces a belt:: row that ONLY the
  // belt-burn / belt-fertilize columns below consume — it can never reach a recipe
  // input. Rate caps bound supply at items/min off the belt.
  //
  // Belt COINS are VALUED, not free: a coin is money worth its face value, so the
  // optimizer keeps weighing what it buys (it won't fund 9-silver Rock Salt into a
  // cauldron just because the coin is "on the belt"). The supply column carries that
  // value once; the spend/deliver conversions then draw it for free.
  //
  // Belt FUEL/FERT stay ~free (BELT_EPS) for now. Valuing them too is sound in
  // principle, but it makes the optimizer chase FREE byproduct fuel — which, with
  // capital off, resurrects the wasteful side-loops the activation-floor polish
  // exists to kill (fabricate-then-discard a product just to harvest a burnable
  // co-product). Fuels are also cheap (Coke ≈ 0.02 copper/heat) and the solver
  // already prefers the cheapest, so the upside is small. Revisit with a proper
  // degeneracy guard if fuel waste ever becomes a real problem.
  const BELT_EPS = 1e-9;
  const BELT_PREF = 1 - 1e-6; // belt a hair cheaper than minting → preferred for display
  const COINS = new Set(['Copper Coin', 'Silver Coin', 'Gold Coin']);
  const beltValue = (name, it, isCoin) => (isCoin ? (it.sellPrice || 0) : BELT_EPS);
  for (const entry of cfg.belt || []) {
    const item = typeof entry === 'string' ? entry : entry.item;
    if (!items[item]) throw new Error(`belt supply references unknown item "${item}"`);
    const it = items[item];
    const rate = typeof entry === 'object' ? entry.rate : undefined;
    const maxRate = (rate !== undefined && rate !== null && rate !== '') ? Number(rate) : undefined;
    const isCoin = COINS.has(item);
    const isFuel = it.heat > 0;
    const isFert = it.nutrientValue > 0;
    if (!isCoin && !isFuel && !isFert) {
      warnings.push(`belt supply "${item}" has no fuel/fertilizer/cash role — ignored (the main belt only carries fuel, fertilizer, or coins; bulk material must be crafted)`);
      continue;
    }
    // supply node: coins → the real item (cash); fuel/fert → a fenced belt:: row
    // All belt roles (fuel / fert / cash) produce a FENCED belt:: row consumed only
    // by the matching conversion below — so belt supply can't leak into recipe
    // material demand, and belt coins can't be confused with manufactured coins.
    const supplyItem = BELT + item;
    virtualItems.add(supplyItem);
    processes.push({
      id: `belt:${item}`, kind: 'belt', item, timeSec: 0,
      consumes: {}, produces: { [supplyItem]: 1 },
      heat: 0, nutrient: 0, copperCost: beltValue(item, it, isCoin) * BELT_PREF, copperRevenue: 0,
      maxRate,
      flags: { provenance: 'belt-supply', maxRate: rate, roles: [isFuel && 'fuel', isFert && 'fert', isCoin && 'cash'].filter(Boolean) },
    });
    if (isCoin) {
      // Belt coins are spendable cash: convert the fenced belt:: row to copper at face
      // value (Purchasing Portals accept any coin denomination, no Bank Portal needed).
      // The coin's value is already charged on the supply column above, so this is a
      // free conversion. Fenced to belt supply on purpose — Coin Processors are wildly
      // profitable (1 Silver Ingot → 5000 copper of coins), so letting manufactured
      // coins become cash would be an infinite-money arbitrage.
      const coinValue = it.sellPrice || 0; // copper value: Copper 1 / Silver 1000 / Gold 100000
      processes.push({
        id: `spend:${item}@belt`, kind: 'spend', timeSec: 0,
        consumes: { [supplyItem]: 1 }, produces: { [COPPER]: coinValue },
        heat: 0, nutrient: 0, copperCost: 0, copperRevenue: 0,
        flags: { coinItem: item, belt: true },
      });
      // …or deliver the belt coin to a recipe that needs that EXACT coin item (e.g.
      // alt Copper Ingot wants Copper Coins). The fenced belt:: row converts to the
      // real coin here; manufactured coins (Coin Processors) produce the real coin
      // directly and can never reach belt::, so they still can't be spent as cash —
      // arbitrage stays blocked while a belt of the matching denomination is used.
      processes.push({
        id: `deliver:${item}@belt`, kind: 'beltCoin', timeSec: 0,
        consumes: { [supplyItem]: 1 }, produces: { [item]: 1 },
        heat: 0, nutrient: 0, copperCost: 0, copperRevenue: 0,
        flags: { coinItem: item, belt: true },
      });
    }
    // belt-fed fuel/fert conversions draw only the fenced belt:: row
    if (isFuel) {
      processes.push({
        id: `burn:${item}@belt`, kind: 'burn', timeSec: 0,
        consumes: { [supplyItem]: 1 }, produces: {},
        heat: it.heat * params.fuelMult, nutrient: 0,
        copperCost: 0, copperRevenue: 0, flags: { fuelItem: item, belt: true },
      });
    }
    if (isFert && !cfg.noFert) {
      processes.push({
        id: `fert:${item}@belt`, kind: 'fertilize', timeSec: 0,
        consumes: { [supplyItem]: 1 }, produces: {},
        heat: 0, nutrient: it.nutrientValue * params.fertMult,
        maxFertility: it.maxFertility,
        copperCost: 0, copperRevenue: 0, flags: { fertItem: item, belt: true },
      });
    }
  }

  // --- byproduct sale / reuse columns (sell-policy co-products) ---
  // Each sell-policy co-product lands in a byprod:: row (see applyByproductPolicy).
  // From there it can be sold at face value, or converted back to the real item to
  // be reused downstream — preserving "sell = like reuse, plus sellable" while
  // making the byproduct sale rate bounded by genuine co-production.
  for (const name of byprodSell) {
    virtualItems.add(BYPROD + name);
    processes.push({
      id: `reusebp:${name}`, kind: 'reuseByproduct', timeSec: 0,
      consumes: { [BYPROD + name]: 1 }, produces: { [name]: 1 },
      heat: 0, nutrient: 0, copperCost: VIRT_EPS, copperRevenue: 0, flags: {},
    });
    if (items[name] && items[name].sellPrice !== undefined) {
      processes.push({
        id: `salebp:${name}`, kind: 'sale', timeSec: 0,
        consumes: { [BYPROD + name]: 1 }, produces: {},
        heat: 0, nutrient: 0, copperCost: 0, copperRevenue: items[name].sellPrice,
        flags: { byproduct: true },
      });
    }
  }

  // --- unlock-tier gating: drop any column touching an above-tier item ---
  // Effective item tiers (src/tiers.js) propagate the raw-resource tiers through
  // machine recipes, so a crafted item like Silver Ingot (tier 8) or Ruby (9) is
  // locked even though it carries no explicit tier. Virtual rows (byprod::/belt::)
  // carry the underlying item's tier, so strip the prefix before the lock check.
  if (maxTier != null) {
    const before = processes.length;
    for (let i = processes.length - 1; i >= 0; i--) {
      const p = processes[i];
      const touches = [...Object.keys(p.consumes || {}), ...Object.keys(p.produces || {})];
      if (touches.some((name) => !lockExempt(name) && locked(stripVirtual(name)))) processes.splice(i, 1);
    }
    const dropped = before - processes.length;
    if (dropped) warnings.push(`tier ${maxTier} lock: dropped ${dropped} columns using above-tier items`);
  }

  // --- cauldron block: compact handle + eligibility mask + on-demand columns ---
  // The Cauldron itself is a tiered machine — locked below its unlock tier.
  let cauldron = null;
  const cauldronUnlocked = !machineLocked('Cauldron');
  if (cfg.cauldron.enabled && !cauldronUnlocked) {
    warnings.push(`cauldron locked at tier ${maxTier} (unlocks at tier ${T.cauldronTier})`);
  }
  if (cfg.cauldron.enabled && cauldronUnlocked) {
    // Eligibility (input pool, tier locks, forbidFor, self-consuming, minMargin) is derived
    // by the shared helper so the composer and the LP can never drift on the rules.
    const { compiled, mask, eligibleCount } = cauldronEligibility(db, cfg, { locked });
    const { inputs, targets, triA, triB, triC, outIdx, margin, flags } = compiled;

    const materialize = (t) => {
      const consumes = {};
      // chainInputs = how many of this cauldron's inputs are themselves cauldron
      // OUTPUTS (items with a cauldronTarget). Feeding one cauldron's output straight
      // into another cauldron is the "cauldron→cauldron" pattern; the optional chain
      // penalty (model.cauldronChainWeight) charges per such input to discourage it.
      let chainInputs = 0;
      for (const idx of [triA[t], triB[t], triC[t]]) {
        const nm = inputs[idx].name;
        consumes[nm] = (consumes[nm] ?? 0) + 1;
        if (items[nm] && items[nm].cauldronTarget != null) chainInputs++;
      }
      const out = targets[outIdx[t]];
      return {
        id: `cauldron:${t}`, kind: 'cauldron', machine: 'Cauldron', tripleIndex: t,
        timeSec: out.time, chainInputs,
        consumes, produces: { [out.name]: 1 },
        heat: -out.heat, nutrient: 0,
        copperCost: 0, copperRevenue: 0,
        primary: out.name,
        flags: {
          fragileMargin: margin[t] < 1 ? margin[t] : undefined,
          exactTie: !!(flags[t] & 1) || undefined,
          selfConsuming: !!(flags[t] & 2) || undefined,
        },
      };
    };

    cauldron = { compiled, mask, eligibleCount, materialize };
  } else if (forceCauldron.size) {
    throw new Error('cauldron.forceFor set but cauldron.enabled is false');
  }

  // forceFor sanity: the item must actually be cauldron-producible
  if (cauldron) {
    for (const name of forceCauldron) {
      if (!cauldron.compiled.targetIndex.has(name)) {
        throw new Error(`cauldron.forceFor: "${name}" has no cauldronTarget — it cannot be cauldron-made`);
      }
    }
  }

  return { processes, cauldron, params, warnings, config: cfg, virtualItems: [...virtualItems] };
}

module.exports = { buildProcessTable, primaryOutput, netSameItems };
