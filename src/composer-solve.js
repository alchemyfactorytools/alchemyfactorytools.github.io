'use strict';
// Browser-safe composer solve core. Imports ONLY the deterministic tile-composer chain —
// never model.js/highs — so it can be bundled for the static site without dragging the WASM
// LP solver into the browser. Both server.js (via solve.js) and the browser bundle call
// composerSolve here; the LP router lives in solve.js, which additionally pulls in model.js.

const { resolveConfig } = require('./config');
const { canonicalCarriers } = require('./utilities');
const { makeComposer } = require('./composer');
const { composeGraph } = require('./compose-graph');
const { tiers } = require('./tiers');

// Item catalog for the picker: names, buy/sell, cauldron eligibility, mintability, and the
// optional Dispatch Portal contract (per-item daily caps) that backs the "× dispatch portals"
// target: rate = portals × dailyMaxBase × (1+0.25·Negotiation) / dayLen.
// Raw feedstock categories: bought/mined inputs (ores, logs, limestone; seeds). They ARE outputs of
// mining/extraction recipes, so a "produced" test alone won't drop them — gate the output picker by
// category. Currency is minted, never a build target.
const RAW_TARGET_CATEGORIES = new Set(['Raw Materials', 'Seeds']);

function itemCatalog(db, contracts = {}) {
  const T = tiers(db);
  const producedSet = new Set();
  for (const r of Object.values(db.recipes)) for (const o of Object.keys(r.outputs || {})) producedSet.add(o);
  return Object.entries(db.items).map(([name, item]) => {
    const craftable = producedSet.has(name) || (item.cauldronCost !== undefined && !item.liquid);
    return {
      name,
      category: item.category,
      buyPrice: item.buyPrice ?? null,
      sellPrice: item.sellPrice ?? null,
      cauldronTarget: item.cauldronTarget ?? null,
      cauldronEligible: item.cauldronCost !== undefined && !item.liquid,
      mintable: ['Copper Coin', 'Silver Coin', 'Gold Coin'].includes(name),
      tier: T.effective(name),                          // effective unlock tier (gates the output picker)
      produced: craftable,                              // output of a recipe / cauldron craft
      // a sensible build TARGET: craftable AND not raw feedstock/currency (those you buy/mint, not build)
      targetable: craftable && !RAW_TARGET_CATEGORIES.has(item.category) && item.category !== 'Currency',
      dispatch: contracts[name] || null,
    };
  });
}

// Tile-composer ("Simplest") solve — no LP. Deterministic canonical picks → sized replicated tile
// FOREST → renderable graph. Accepts one OR many targets (`targets` = [{ item, rate, rateMode }]) and
// returns the same response envelope the LP path does. Multiple targets share the fuel/fert/money
// trunks + co-product surplus, but each gets its own replicated tile tree (no merged intermediates).
function composerSolve(targets, cfg, db) {
  const { fuelItem, fertItem } = canonicalCarriers(db, cfg);
  cfg.canonical = { fuelItem, fertItem };
  // Central steam (cfg.steam.enabled) is handled inside the composer: it forces the FUEL trunk's
  // belt cap to Infinity so the fuel production trunk/furnaces/self-fuel loops collapse and heat is
  // drawn from a central steam source, WITHOUT touching the fert trunk — important because the
  // canonical fuel and fert carrier can be the same item (e.g. Panacea Potion is both).
  const comp = makeComposer(db, cfg);
  for (const t of targets) {
    if (!Number.isFinite(comp.tileCost(t.item))) {
      return {
        status: 'Infeasible',
        probe: { detail: `the tile composer can't make "${t.item}" at tier ${cfg.maxTier ?? '∞'} with these inputs (no canonical recipe reaches buy/belt/grow leaves)` },
        warnings: [],
      };
    }
  }
  // "× output machines" mode is resolved PER TARGET: compose that item alone at 1/min to read its tile
  // load (machine-equivalents or plots for 1 unit/min), so N machines ⇒ rate = N / load.
  const resolved = [];
  for (const t of targets) {
    let rate = t.rate, machines = null;
    if (t.rateMode === 'machines') {
      const load = comp.compose([{ item: t.item, rate: 1 }]).tree.tileLoad;
      if (load && load > 0) { rate = t.rate / load; machines = Math.round(t.rate); }
    }
    resolved.push({ item: t.item, rate, machines });
  }
  // Merge a duplicated output (same item listed twice) by summing the resolved /min rate — the forest
  // keys replicated tile ids by item name, so one root per distinct item.
  const byItem = new Map();
  for (const r of resolved) {
    const e = byItem.get(r.item);
    if (e) { e.rate += r.rate; if (r.machines != null) e.machines = (e.machines || 0) + r.machines; }
    else byItem.set(r.item, { ...r });
  }
  const merged = [...byItem.values()];

  const composed = comp.compose(merged.map((t) => ({ item: t.item, rate: t.rate })));
  const graph = composeGraph(composed, db, cfg);
  const copperPerMin = composed.summary.copperPerMin;
  const totalRate = merged.reduce((s, t) => s + t.rate, 0);
  return {
    status: 'Optimal',
    copperPerMin,                                  // total money-line spend (incl. fuel/fert trunks)
    copperPerItem: totalRate > 0 ? copperPerMin / totalRate : 0, // spend ÷ total output/min across targets
    effectiveRate: totalRate,
    targets: merged.map((t) => ({ item: t.item, rate: t.rate, machines: t.machines ?? null })),
    machineTarget: merged.length === 1 ? (merged[0].machines ?? null) : null, // back-compat (single target)
    cgRounds: 0,                                    // not an LP — no column-generation rounds
    graph,
    explainText: composerExplain(composed, fuelItem, fertItem),
    warnings: graph.summary.warnings || [],         // belt rate-cap shortfalls (fuel/fert/coins)
  };
}

function composerExplain(composed, fuelItem, fertItem) {
  const s = composed.summary;
  const tgts = (s.targets && s.targets.length ? s.targets : [{ item: s.target, ratePerMin: s.ratePerMin }]);
  const totalRate = tgts.reduce((a, t) => a + t.ratePerMin, 0) || 1;
  const lines = [
    `Tile composer (Simplest) — ${tgts.map((t) => `${t.item} @ ${t.ratePerMin}/min`).join(' + ')}, replicated tiles.`,
    `Operating ${Math.round(s.operatingCopperPerMin)} c/min (${Math.round(s.operatingCopperPerMin / totalRate)} c/item); money line ${Math.round(s.copperPerMin)} c/min total external spend.`,
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
  const { item, rate = 1, rateMode = 'rate', config = {}, targets } = body || {};
  // Accept body.targets[] (multi-target) or the legacy single { item, rate, rateMode }.
  const list = (Array.isArray(targets) && targets.length)
    ? targets.map((t) => ({ item: t.item, rate: t.rate ?? 1, rateMode: t.rateMode || 'rate' }))
    : [{ item, rate, rateMode }];
  for (const t of list) {
    if (!t.item || !db.items[t.item]) return { status: 'Error', error: `unknown item "${t.item}"` };
    if (!(t.rate > 0)) return { status: 'Error', error: `rate must be > 0${list.length > 1 ? ` (for ${t.item})` : ''}` };
  }
  const cfg = resolveConfig(config);
  return composerSolve(list, cfg, db);
}

module.exports = { itemCatalog, composerSolve, composerExplain, solveComposerBody };
