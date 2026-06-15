// Optimizer configuration: defaults, merging, and skill-formula evaluation.
// Every knob here corresponds to an anchoring mode or override in DESIGN.md §3.4/§3.7.

'use strict';

const DEFAULT_CONFIG = {
  // Skill levels (formulas from data/skills.json; verified against starfi5h engine)
  skills: { logistics: 0, factory: 0, alchemy: 0, fuel: 0, fertilizer: 0 },

  // Unlock tier: items carry a `tier` (1-9, raw resources/seeds/herbs only). When
  // set, any column that consumes or produces an item above maxTier is dropped —
  // i.e. the recipe space is limited to what you've unlocked. null = no limit.
  maxTier: null,

  cauldron: {
    enabled: true,
    // 'unrestricted' | 'buyables' | { allow: [names] } | { deny: [names] }
    inputPool: 'unrestricted',
    // items that must NOT be produced via cauldron (their cauldron columns are dropped)
    forbidFor: [],
    // items that must ONLY be produced via cauldron (their machine-recipe columns are dropped)
    forceFor: [],
    // self-consuming triples (output ∈ inputs) stay valid LP columns by default;
    // set false to drop them entirely (they can never be explanations either way)
    allowSelfConsuming: true,
    // exclude triples whose winning margin is below this (0 = keep everything,
    // including exact ties — the game resolves them deterministically by item id)
    minMargin: 0,
  },

  // Byproduct handling. A recipe's "primary" output is the one matching its id
  // (suffixes like _Alt/_Thermal/_Dual stripped); everything else is a byproduct.
  // 'reuse': byproducts credit the balance row (used downstream or freely discarded)
  // 'trash': byproducts are deleted from the column — never reusable, never sold
  // 'sell' : like reuse, and byproduct sale revenue offsets cost in min-cost mode
  byproducts: {
    mode: 'reuse',
    perItem: {}, // e.g. { "Crude Silver Powder": "trash" }
  },

  // Anchoring modes: false restricts burn/fertilize columns to BUYABLE items only,
  // so fuel/nutrients cannot be supplied by crafted loops.
  selfFuel: true,
  selfFert: true,

  // Main-belt supply: specific items arriving from elsewhere in your base on the
  // main belt, as free inputs (BELT_EPS copper) optionally capped at a rate/min.
  //   belt: [{ item: "Growth Potion", rate: 100 }, { item: "Logs" }, { item: "Copper Coin", rate: 6000 }]
  // A belt fuel item (has heat) can be burned for HEAT; a belt fertilizer item
  // (has nutrientValue/maxFertility) feeds NUTRIENT and sets crop grow speed.
  // rate omitted = unlimited. This is how you supply coins/fuel/fertilizer/etc.
  // without the optimizer building a sub-factory for them.
  belt: [],

  // Central steam (composer only). When enabled, heat is delivered from centrally-
  // plumbed steam (Steam Boilers → pipes → Heating Pads) rather than per-line fuel:
  // the canonical fuel carrier becomes an unlimited belt utility, so its production
  // trunk, furnaces, and self-fuel loops collapse out of the build and heating machines
  // draw from a single central steam source. Cost modes:
  //   'free' — steam is treated as a free plumbed-in utility (heat contributes 0 cost)
  //   'cost' — charge the fuel steam burns, inflated by the ~40% conversion loss
  //            (per-heat cost ÷ STEAM_EFFICIENCY); see data/mechanics.json "steam".
  steam: { enabled: false, mode: 'free' },

  // Machine capacity (DESIGN: capacity rows from day one; bounds amplifying loops).
  // counts: per-machine override; defaultCount applies to the rest.
  machines: { defaultCount: 50, counts: {} },

  // Machine build (capital) cost in the objective. Each machine's buildCost is
  // valued in copper and charged per machine-second, amortized over amortizeMinutes
  // of operation. This is what stops the optimizer choosing 44 cauldrons over a
  // couple of cheap machines for the same output. Set enabled:false to plan on
  // pure material/throughput cost only.
  capital: { enabled: true, amortizeMinutes: 60 },

  // Buildability weight: a flat copper-equivalent cost per machine added to the
  // objective, so the optimizer trades copper for FEWER machines (easiest to build,
  // not cheapest). 0 = pure min-copper; ~40 cuts machine sprawl a lot for modest copper;
  // high values push toward buying raw ore and the most compact routes.
  buildability: 0,

  // Purchasing/selling
  buy: true,
  sell: true,

  // Catalyst variants on the 5 Advanced Athanor recipes
  catalysts: {
    enabled: true,
    stacked: false, // stacked-catalyst columns need in-game co-load confirmation
  },

  quarantine: {
    // Bank Portal mints coins from nothing in the DB; we price them at face value
    // (sellPrice per coin) — an ASSUMPTION until verified in-game.
    bankPortal: true,
    // The 4 curated machine:"Cauldron" recipe rows. 'auto': excluded while the
    // formula block is active, included when cauldron.enabled === false.
    // The Ruby row is ALWAYS excluded (contradicts the deterministic formula).
    curatedCauldronRows: 'auto',
    worldTreeDual: true, // nutrient-priced in v41, so enabled; flag kept for provenance
  },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function resolveConfig(overrides = {}) {
  const cfg = merge(DEFAULT_CONFIG, overrides);
  const conflict = cfg.cauldron.forbidFor.filter((x) => cfg.cauldron.forceFor.includes(x));
  if (conflict.length) throw new Error(`items both forbidden and forced via cauldron: ${conflict.join(', ')}`);
  return cfg;
}

// Skill formulas (data/skills.json; extracted from starfi5h alchemy_calc_engine.js)
function beltSpeed(lvl) {
  let speed = 60;
  if (lvl > 0) speed += Math.min(lvl, 12) * 15;
  if (lvl > 12) speed += (lvl - 12) * 3;
  return speed;
}

function speedMult(lvl) {
  let mult = 1.0;
  mult += Math.min(lvl, 12) * 0.25;
  if (lvl > 12) mult += (lvl - 12) * 0.05;
  return mult;
}

function alchemyMult(lvl) {
  if (lvl <= 0) return 1.0;
  let percent = 0;
  for (let i = 1; i <= lvl; i++) {
    if (i <= 2) percent += 6;
    else if (i <= 8) percent += 8;
    else percent += 10;
  }
  return 1.0 + percent / 100;
}

const fuelMult = (lvl) => 1 + 0.1 * lvl;
const fertMult = (lvl) => 1 + 0.1 * lvl;

// Central-steam heat-delivery efficiency vs direct furnace burning. Empirical:
// identical charcoal feed yielded 597 product via a furnace vs 360 via a steam pad
// (360/597 ≈ 0.60). So steam needs ~1/0.6 the fuel for the same heat → "at cost"
// mode charges per-heat fuel value ÷ STEAM_EFFICIENCY. See data/mechanics.json "steam".
const STEAM_EFFICIENCY = 0.6;

function skillParams(skills) {
  return {
    beltSpeed: beltSpeed(skills.logistics),
    speedMult: speedMult(skills.factory),
    alchemyMult: alchemyMult(skills.alchemy),
    fuelMult: fuelMult(skills.fuel),
    fertMult: fertMult(skills.fertilizer),
  };
}

module.exports = { DEFAULT_CONFIG, resolveConfig, skillParams, beltSpeed, speedMult, alchemyMult, fuelMult, fertMult, STEAM_EFFICIENCY };
