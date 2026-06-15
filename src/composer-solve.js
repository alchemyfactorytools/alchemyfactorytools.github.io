'use strict';
// Browser-safe composer solve core. Imports ONLY the deterministic tile-composer chain —
// never model.js/highs — so it can be bundled for the static site without dragging the WASM
// LP solver into the browser. Both server.js (via solve.js) and the browser bundle call
// composerSolve here; the LP router lives in solve.js, which additionally pulls in model.js.

const { resolveConfig } = require('./config');
const { canonicalCarriers } = require('./utilities');
const { makeComposer } = require('./composer');
const { composeGraph } = require('./compose-graph');

// Item catalog for the picker: names, buy/sell, cauldron eligibility, mintability, and the
// optional Dispatch Portal contract (per-item daily caps) that backs the "× dispatch portals"
// target: rate = portals × dailyMaxBase × (1+0.25·Negotiation) / dayLen.
function itemCatalog(db, contracts = {}) {
  return Object.entries(db.items).map(([name, item]) => ({
    name,
    category: item.category,
    buyPrice: item.buyPrice ?? null,
    sellPrice: item.sellPrice ?? null,
    cauldronTarget: item.cauldronTarget ?? null,
    cauldronEligible: item.cauldronCost !== undefined && !item.liquid,
    mintable: ['Copper Coin', 'Silver Coin', 'Gold Coin'].includes(name),
    dispatch: contracts[name] || null,
  }));
}

// Tile-composer ("Simplest") solve — no LP. Deterministic canonical picks → sized replicated tile
// tree → renderable graph. Returns the same response envelope the LP path does.
function composerSolve(item, rate, rateMode, cfg, db) {
  const { fuelItem, fertItem } = canonicalCarriers(db, cfg);
  cfg.canonical = { fuelItem, fertItem };
  // Central steam (cfg.steam.enabled) is handled inside the composer: it forces the FUEL trunk's
  // belt cap to Infinity so the fuel production trunk/furnaces/self-fuel loops collapse and heat is
  // drawn from a central steam source, WITHOUT touching the fert trunk — important because the
  // canonical fuel and fert carrier can be the same item (e.g. Panacea Potion is both).
  const comp = makeComposer(db, cfg);
  if (!Number.isFinite(comp.tileCost(item))) {
    return {
      status: 'Infeasible',
      probe: { detail: `the tile composer can't make "${item}" at tier ${cfg.maxTier ?? '∞'} with these inputs (no canonical recipe reaches buy/belt/grow leaves)` },
      warnings: [],
    };
  }
  // "× output machines" mode: N final-product machines, not a rate. compose at 1/min reveals the
  // machine-equivalents (or plots) one unit/min needs (the target tile's tileLoad), so N machines ⇒
  // rate = N / load.
  let effectiveRate = rate;
  let machineTarget = null;
  if (rateMode === 'machines') {
    const load = comp.compose(item, 1).tree.tileLoad;
    if (load && load > 0) { effectiveRate = rate / load; machineTarget = Math.round(rate); }
  }
  const composed = comp.compose(item, effectiveRate);
  const graph = composeGraph(composed, db, cfg);
  const copperPerMin = composed.summary.copperPerMin;
  return {
    status: 'Optimal',
    copperPerMin,                                  // total money-line spend (incl. fuel/fert trunks)
    copperPerItem: copperPerMin / effectiveRate,
    effectiveRate,
    machineTarget,
    cgRounds: 0,                                    // not an LP — no column-generation rounds
    graph,
    explainText: composerExplain(composed, fuelItem, fertItem),
    warnings: graph.summary.warnings || [],         // belt rate-cap shortfalls (fuel/fert/coins)
  };
}

function composerExplain(composed, fuelItem, fertItem) {
  const s = composed.summary;
  const lines = [
    `Tile composer (Simplest) — ${s.target} @ ${s.ratePerMin}/min, replicated tiles.`,
    `Operating ${Math.round(s.operatingCopperPerMin)} c/min (${Math.round(s.operatingCopperPerMin / s.ratePerMin)} c/item); money line ${Math.round(s.copperPerMin)} c/min total external spend.`,
    `Fuel carrier ${fuelItem || '—'}, fert carrier ${fertItem || '—'} (shared trunks; machine build cost not amortized).`,
    `Machines: ${Object.entries(s.machineTotals).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${c}× ${m}`).join(', ')}.`,
  ];
  if (Object.keys(s.mintedCoins).length) {
    lines.push(`Minted coins → belt money line: ${Object.entries(s.mintedCoins).map(([c, r]) => `${r}/min ${c}`).join(', ')}.`);
  }
  if (s.coproductFeeds && s.coproductFeeds.length) {
    lines.push(`Reused co-products (fewer dedicated tiles): ${s.coproductFeeds.map((f) => `${Math.round(f.rate)}/min ${f.item}`).join(', ')}.`);
  }
  return lines.join('\n');
}

// Body-level wrapper used by the browser (and re-used by solve.js): validate → resolveConfig →
// composerSolve. On bad input it returns {status:'Error', error} rather than throwing, so the
// in-browser caller can surface the message exactly like the old server JSON error did.
function solveComposerBody(body, db) {
  const { item, rate = 1, rateMode = 'rate', config = {} } = body || {};
  if (!item || !db.items[item]) return { status: 'Error', error: `unknown item "${item}"` };
  if (!(rate > 0)) return { status: 'Error', error: 'rate must be > 0' };
  const cfg = resolveConfig(config);
  return composerSolve(item, rate, rateMode, cfg, db);
}

module.exports = { itemCatalog, composerSolve, composerExplain, solveComposerBody };
