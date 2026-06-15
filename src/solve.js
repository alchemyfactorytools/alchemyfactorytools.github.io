'use strict';
// Unified solve entry: routes to the deterministic tile composer or the flow-balance LP.
// This is the SERVER/CLI entry — it imports model.js (and therefore highs/WASM) for the LP
// path. The browser bundle must NOT import this file; it imports composer-solve.js directly
// so the WASM solver stays out of the static build. Both share composerSolve, so the
// composer path is byte-identical across server and browser.

const { resolveConfig } = require('./config');
const { buildProcessTable } = require('./normalize');
const { Model, optimize, optimizeWithinTolerance, probeInfeasibility } = require('./model');
const { buildFlowGraph } = require('./flowgraph');
const { canonicalUtilities } = require('./utilities');
const { explain } = require('./explain');
const { composerSolve, itemCatalog } = require('./composer-solve');

async function solve(body, db) {
  const { item, rate = 1, rateMode = 'rate', config = {} } = body;
  if (!db.items[item]) throw Object.assign(new Error(`unknown item "${item}"`), { status: 400 });
  if (!(rate > 0)) throw Object.assign(new Error('rate must be > 0'), { status: 400 });
  const cfg = resolveConfig(config);
  // "Simplest" solver: the deterministic tile composer, not the LP. Picks one canonical recipe per
  // item and composes a replicated, self-contained tile tree (fuel/fert/coins as shared trunks).
  // Same {summary, graph} response shape as the LP path, so the renderer is unchanged.
  if (config.solver === 'composer') return composerSolve(item, rate, rateMode, cfg, db);
  cfg.buildability = 0; // scaled below, relative to THIS build's own cost (see the probe)
  // Canonical fuel/fert tiles: pre-pick the carrier (Coke Powder, Growth Potion @ t6) and
  // its simplest clean chain, then lock the build to it (default on; canonicalUtilities=false
  // to disable). Done before the main table so the lock is baked into the columns.
  if (config.canonicalUtilities !== false) {
    const canon = await canonicalUtilities(db, cfg, { buildProcessTable, Model, optimizeWithinTolerance });
    // exemptItem: never let the lock forbid producing the very item we're solving for
    if (canon) {
      cfg.canonical = { ...canon, exemptItem: item };
      // Forbid cauldron-producing the fuel chain so the main build can't shortcut it (the
      // refine tile is recipe-based). The target itself is exempt (you can still build it).
      const block = (canon.forbidCauldronItems || []).filter((n) => n !== item);
      if (block.length) cfg.cauldron = { ...cfg.cauldron, forbidFor: [...(cfg.cauldron.forbidFor || []), ...block] };
    }
  }
  const pt = buildProcessTable(db, cfg);
  const model = new Model(pt, db);

  // "output machines" mode: the user gives N final-product machines, not a rate. A
  // probe solve at 1/min reveals how many output machines 1/min needs (its continuous
  // load), so N full machines ⇒ rate = N / load. Cleans the output machine count.
  let effectiveRate = rate;
  let machineTarget = null;
  if (rateMode === 'machines') {
    const probe = await optimize(model, { demand: { [item]: 1 }, objective: 'cost' });
    if (probe.status === 'Optimal') {
      const speedMult = model.pt.params.speedMult;
      let outLoad = 0;
      for (const f of probe.flows) {
        const q = f.process.produces?.[item];
        if (q && f.process.timeSec > 0) outLoad += (f.rate * f.process.timeSec) / (60 * speedMult);
      }
      if (outLoad > 0) { effectiveRate = rate / outLoad; machineTarget = Math.round(rate); }
    }
  }

  const demand = { [item]: effectiveRate };
  // "Optimize for" (the dropdown) and the explicit override BOTH express ONE idea:
  // how much copper PER ITEM you'll waste to get a simpler (fewer-machine) build.
  //   • dropdown  → buildabilityFraction = a fraction of the build's OWN cheapest
  //     per-item cost (scales across a 1c nail and a 280k Mars).
  //   • override  → costTolerance = an absolute copper/item figure; wins when set.
  // Both feed the two-phase min-cost-then-min-machines solve. The old soft per-machine
  // penalty is gone — it couldn't express an indifference band, so "Simplest" never
  // overcame a large copper gap (e.g. free-herb cauldron vs buy-ore).
  const overrideTol = config.costTolerance || 0;          // absolute copper/item
  const wasteFraction = config.buildabilityFraction || 0; // dropdown → fraction of per-item cost
  // Cauldron-chain penalty: extra weight per cauldron→cauldron input, scaled to the
  // build's own cost (each link costs `chainFrac` average-machine-costs). Needs a probe.
  const chainFrac = config.cauldronChainFraction || 0;
  if (chainFrac > 0) {
    const probe = await optimize(model, { demand, objective: 'cost' });
    if (probe.status === 'Optimal') {
      const sm = model.pt.params.speedMult;
      let m0 = 0;
      for (const f of probe.flows) if (f.process.machine && f.process.timeSec > 0) m0 += (f.rate * f.process.timeSec) / (60 * sm);
      if (m0 > 0 && probe.objective > 0) model.cauldronChainWeight = chainFrac * (probe.objective / m0);
    }
  }
  const result = (overrideTol > 0 || wasteFraction > 0)
    ? await optimizeWithinTolerance(model, { demand, objective: 'cost', tolerancePerItem: overrideTol, toleranceFraction: overrideTol > 0 ? 0 : wasteFraction })
    : await optimize(model, { demand, objective: 'cost' });
  if (result.status === 'Infeasible') {
    const probe = await probeInfeasibility(model, demand, 'cost');
    return { status: 'Infeasible', probe, warnings: pt.warnings };
  }
  if (result.status !== 'Optimal') return { status: result.status, warnings: pt.warnings };
  const graph = buildFlowGraph(result, model, demand);
  return {
    status: 'Optimal',
    copperPerMin: result.objective,
    copperPerItem: result.objective / effectiveRate,
    effectiveRate,
    machineTarget,
    cgRounds: result.rounds,
    graph,
    explainText: explain(result, demand),
    warnings: pt.warnings,
  };
}

module.exports = { solve, itemCatalog };
