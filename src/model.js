// LP/MILP model builder and column-generation solve loop (DESIGN.md §3.3).
//
// Variables are process activations x_p ≥ 0 in runs/min. Rows:
//   item balance:  Σ produces − Σ consumes ≥ demand  (free disposal = byproduct reuse)
//   HEAT:          Σ heat_p · x_p ≥ 0
//   NUTRIENT:      Σ nutrient_p · x_p ≥ 0
//   capacity_m:    Σ timeSec_p · x_p ≤ count_m × 60 × speedMult   (bounds amplifying loops)
//
// Objectives: 'cost' (min purchase copper for a demand vector; byproduct sale revenue
// included only when byproducts.mode === 'sell') or 'profit' (max revenue − cost).
//
// The cauldron block is handled by column generation: a restricted master holds
// explicit columns + seeds, then all eligible triples are rescanned against the
// duals after every solve and negative-reduced-cost columns are admitted. The
// rescan touches every triple, so LP-level exactness does not depend on seeding.

'use strict';

let highsPromise = null;
function getHighs() {
  if (!highsPromise) highsPromise = require('highs')();
  return highsPromise;
}

const EPS = 1e-7;

const { makeItemCopperFloor } = require('./cost-floor');

class Model {
  constructor(processTable, db) {
    this.pt = processTable;
    this.db = db;
    // Real item rows, plus virtual rows (byprod::/belt::) that fence supply into a
    // single role — see normalize.js. They get ordinary balance rows in the LP.
    this.itemNames = [...Object.keys(db.items), ...(processTable.virtualItems || [])];
    this.itemIndex = new Map(this.itemNames.map((n, i) => [n, i]));
    // machines used by any column with timeSec > 0 get capacity rows
    this.machineNames = [...new Set(
      processTable.processes.filter((p) => p.machine && p.timeSec > 0).map((p) => p.machine)
    )];
    if (processTable.cauldron && !this.machineNames.includes('Cauldron')) this.machineNames.push('Cauldron');
    this.machineIndex = new Map(this.machineNames.map((n, i) => [n, i]));

    // Amortized machine build (capital) cost. Without this the LP treats a route
    // needing 44 expensive Cauldrons as equal to one needing 2 cheap Table Saws —
    // and in the free-loop regime it picks the absurd one. Each machine's build
    // cost is valued in copper and charged per machine-second, amortized over a
    // configurable operating horizon (capital.amortizeMinutes).
    const cap = processTable.config.capital || {};
    this.capitalWeight = cap.enabled === false ? 0 : 1 / (cap.amortizeMinutes || 60);
    // Buildability weight: a flat copper-equivalent cost per machine, UNIFORM across
    // machine types. Penalizes machine SPRAWL in the objective, so the optimizer
    // only takes a cheaper-copper route (farm + cauldron) if its machine savings
    // justify it — and otherwise buys/takes the compact route. 0 = pure min-copper.
    this.buildabilityWeight = processTable.config.buildability || 0;
    // Cauldron-chain weight: extra per-machine-equivalent penalty for a cauldron each
    // time one of its inputs is itself a cauldron output (column.chainInputs), to
    // discourage cauldron→cauldron chains. 0 = no penalty; server scales it to the
    // build's own cost via the buildability probe, like buildabilityWeight.
    this.cauldronChainWeight = (processTable.config.cauldron && processTable.config.cauldron.chainWeight) || 0;
    this.buildCopper = {};
    if (this.capitalWeight > 0) {
      const floor = makeItemCopperFloor(db);
      for (const [name, m] of Object.entries(db.machines)) {
        let g = 0;
        for (const [item, q] of Object.entries(m.buildCost || {})) {
          const f = floor(item);
          if (isFinite(f)) g += q * f;
        }
        this.buildCopper[name] = g;
      }
    }
  }

  // Per-run non-material cost (copper): amortized machine build cost (capital) plus a
  // uniform buildability penalty per machine. Continuous machine count ≈
  // timeSec·rate / (60·speedMult); this is its per-run share.
  capitalPerRun(p) {
    // Fertilizer columns imply NURSERY PLOTS the LP otherwise can't see: a fertility-
    // limited nursery needs plots ≈ nutrient / (60·maxFertility). Without this, nurseries
    // (timeSec=0) cost zero capital, so the optimizer floods cheap LOW-fertility fert
    // (Basic Fertilizer, maxFert 12) into a thousands-of-nurseries sprawl instead of using
    // high-fertility Growth Potion (2160). Charge each fertilizer for the plots + the
    // buildability/per-machine penalty those plots carry, so fertilizer QUALITY matters.
    if (p.kind === 'fertilize' && p.nutrient > 0 && p.maxFertility > 0) {
      const plots = p.nutrient / (60 * p.maxFertility);
      const nurseryBuild = (this.buildCopper.Nursery || 0) * this.capitalWeight; // 0 if capital off
      return plots * (this.buildabilityWeight + nurseryBuild); // per-plot machine + build cost
    }
    if (!p.machine || !(p.timeSec > 0)) return 0;
    const perMachine = p.timeSec / (60 * this.pt.params.speedMult);
    let v = this.buildabilityWeight * perMachine;
    if (this.cauldronChainWeight && p.chainInputs) v += this.cauldronChainWeight * p.chainInputs * perMachine;
    if (!this.capitalWeight) return v;
    const bg = this.buildCopper[p.machine] || 0;
    return v + perMachine * bg * this.capitalWeight;
  }

  machineCapacity(machine) {
    const m = this.pt.config.machines;
    const count = m.counts[machine] ?? m.defaultCount;
    return count * 60 * this.pt.params.speedMult;
  }

  // Which explicit columns participate, given the objective.
  //
  // Two kinds of sale column:
  //   generic (consumes the real item)  — manufacture-and-sell; only meaningful
  //     when maximizing profit. Disabled in cost mode (it's the arbitrage vector:
  //     mint coins → cauldron a gem → sell it for "profit" against the demand).
  //   byproduct (flags.byproduct, consumes a byprod:: row) — credits genuine
  //     co-products at sell value in cost-min, bounded by real co-production.
  activeExplicit(objective) {
    const sellMode = this.pt.config.byproducts.mode === 'sell';
    return this.pt.processes.filter((p) => {
      if (p.kind !== 'sale') return true;
      if (p.flags && p.flags.byproduct) return sellMode; // byproduct credit: sell mode only
      return objective === 'profit'; // generic manufacture-and-sell: profit objective only
    });
  }
}

// ---------- LP string writer (CPLEX LP format for highs-js) ----------

// ACTIVATION_EPS: a tiny per-machine-second cost added in the optional "polish"
// solve. When capital pricing is off, every all-intermediate process is net-zero,
// so the LP is degenerate and the solver may return optima that spin useless
// side-loops (extra Copper → Copper Coin → cauldron → Clay → Clay Powder, all
// discarded). Re-solving the converged column set with this floor selects the
// minimal-machine-second optimum, dropping that floating production. It's far
// below any real cost so it only breaks exact ties.
const ACTIVATION_EPS = 1e-5;

function buildLpString({ model, columns, demand, objective, integers, activationFloor, objMode, costCap, loadCap }) {
  const { itemIndex, machineIndex } = model;
  const nItems = model.itemNames.length;
  const HEAT_ROW = nItems;
  const NUTRIENT_ROW = nItems + 1;
  const CAP_BASE = nItems + 2;
  const nRows = CAP_BASE + model.machineNames.length;
  const capPerMin = 60 * model.pt.params.speedMult;

  // rows as arrays of "coef varName" terms
  const rowTerms = Array.from({ length: nRows }, () => []);
  const objTerms = [];      // cost objective (also reused as the cost-cap row when costCap set)
  const loadTerms = [];     // continuous machine-load objective (for objMode === 'machineLoad')
  const bounds = []; // belt rate caps: "x_i <= rate"

  columns.forEach((p, ci) => {
    const v = `x${ci}`;
    if (p.maxRate !== undefined && p.maxRate !== null && isFinite(p.maxRate)) {
      bounds.push(` ${v} <= ${p.maxRate}`);
    }
    const coef = new Map();
    for (const [item, qty] of Object.entries(p.produces)) {
      coef.set(itemIndex.get(item), (coef.get(itemIndex.get(item)) ?? 0) + qty);
    }
    for (const [item, qty] of Object.entries(p.consumes)) {
      coef.set(itemIndex.get(item), (coef.get(itemIndex.get(item)) ?? 0) - qty);
    }
    for (const [row, c] of coef) {
      if (c !== 0) rowTerms[row].push(`${c > 0 ? '+' : '-'} ${Math.abs(c)} ${v}`);
    }
    if (p.heat) rowTerms[HEAT_ROW].push(`${p.heat > 0 ? '+' : '-'} ${Math.abs(p.heat)} ${v}`);
    if (p.nutrient) rowTerms[NUTRIENT_ROW].push(`${p.nutrient > 0 ? '+' : '-'} ${Math.abs(p.nutrient)} ${v}`);
    if (p.machine && p.timeSec > 0 && machineIndex.has(p.machine)) {
      rowTerms[CAP_BASE + machineIndex.get(p.machine)].push(`+ ${p.timeSec} ${v}`);
      loadTerms.push(`+ ${p.timeSec / capPerMin} ${v}`);
    }
    let net = (p.copperCost ?? 0) - (p.copperRevenue ?? 0) + model.capitalPerRun(p);
    if (activationFloor && p.machine && p.timeSec > 0) net += p.timeSec * ACTIVATION_EPS;
    if (Math.abs(net) > 1e-12) objTerms.push(`${net > 0 ? '+' : '-'} ${Math.abs(net)} ${v}`);
  });

  const costExpr = objTerms.length
    ? objTerms.map((t) => (objective === 'profit' ? (t.startsWith('+') ? '-' + t.slice(1) : '+' + t.slice(1)) : t)).join(' ')
    : '0 x0';
  const lines = [];
  // objMode 'machineLoad' minimizes total continuous machine count instead of cost —
  // used by the cost-tolerance pass to pick the SIMPLEST build within a copper budget.
  if (objMode === 'machineLoad') {
    lines.push('Minimize');
    lines.push(` obj: ${loadTerms.join(' ') || '0 x0'}`);
  } else {
    lines.push(objective === 'profit' ? 'Maximize' : 'Minimize');
    lines.push(` obj: ${costExpr}`);
  }
  lines.push('Subject To');
  // cost-cap row: total cost ≤ budget (the min cost plus the user's per-item tolerance)
  if (costCap !== undefined && costCap !== null && objTerms.length) {
    lines.push(` ccap: ${objTerms.join(' ')} <= ${costCap}`);
  }
  // load-cap row: total machine count ≤ a fixed simplest level — lets a second pass
  // minimize cost AMONG equally-simple builds (lexicographic: machines then cost).
  if (loadCap !== undefined && loadCap !== null && loadTerms.length) {
    lines.push(` lcap: ${loadTerms.join(' ')} <= ${loadCap}`);
  }
  for (let r = 0; r < nRows; r++) {
    const isCap = r >= CAP_BASE;
    let rhs;
    let sense;
    if (isCap) {
      sense = '<=';
      rhs = model.machineCapacity(model.machineNames[r - CAP_BASE]);
    } else if (r === HEAT_ROW || r === NUTRIENT_ROW) {
      sense = '>=';
      rhs = 0;
    } else {
      sense = '>=';
      rhs = demand[model.itemNames[r]] ?? 0;
    }
    if (rowTerms[r].length === 0) {
      // an empty ≥ row with positive demand is unsatisfiable; empty ≤/zero rows are vacuous
      if (sense === '>=' && rhs > 0) return { infeasibleRow: model.itemNames[r] };
      continue;
    }
    lines.push(` r${r}: ${rowTerms[r].join(' ')} ${sense} ${rhs}`);
  }
  if (bounds.length) {
    lines.push('Bounds');
    for (const b of bounds) lines.push(b);
  }
  if (integers && integers.length) {
    lines.push('General');
    lines.push(' ' + integers.join(' '));
  }
  lines.push('End');
  return { lp: lines.join('\n'), nRows, CAP_BASE, HEAT_ROW, NUTRIENT_ROW };
}

// ---------- column generation ----------

// Seed: per cauldron output, the K cheapest triples under a static price proxy.
function seedCauldronColumns(model, K = 8) {
  const c = model.pt.cauldron;
  if (!c) return [];
  const { compiled, mask } = c;
  const { inputs, targets, triA, triB, triC, outIdx, count } = compiled;
  const proxy = inputs.map((it) => it.buyPrice ?? it.cost * 2 + 100);
  const best = targets.map(() => []); // arrays of {t, cost}
  for (let t = 0; t < count; t++) {
    if (!mask[t]) continue;
    const cost = proxy[triA[t]] + proxy[triB[t]] + proxy[triC[t]];
    const o = outIdx[t];
    const arr = best[o];
    if (arr.length < K) {
      arr.push({ t, cost });
      if (arr.length === K) arr.sort((a, b) => a.cost - b.cost);
    } else if (cost < arr[K - 1].cost) {
      arr[K - 1] = { t, cost };
      arr.sort((a, b) => a.cost - b.cost);
    }
  }
  return best.flat().map(({ t }) => c.materialize(t));
}

// Rescan ALL eligible, not-yet-admitted triples against duals; return the
// maxAdmit most-negative-reduced-cost indexes. `admitted` MUST be filtered here,
// before the cap — otherwise already-admitted columns (which stay most-negative)
// fill every slot, the caller's post-filter empties them, and CG falsely
// converges while thousands of genuinely-beneficial columns (lower-magnitude but
// still negative, e.g. a cheap Salt route) are never admitted.
function rescanCauldron(model, duals, capDualCauldron, admitted, maxAdmit = 500) {
  const c = model.pt.cauldron;
  if (!c) return [];
  const { compiled, mask } = c;
  const { inputs, targets, triA, triB, triC, outIdx, count } = compiled;
  const { itemIndex } = model;
  const inputDual = inputs.map((it) => duals.items[itemIndex.get(it.name)]);
  const outDual = targets.map((t) => duals.items[itemIndex.get(t.name)]);
  const outHeatTime = targets.map((t) => duals.heat * -t.heat + capDualCauldron * t.time);
  // a cauldron column's true objective coefficient is its amortized capital cost
  // (time-dependent). Omitting it makes columns whose dual value is below ~capital
  // look attractive forever, so CG never converges.
  const capW = model.capitalWeight || 0;
  const cauldronBuild = model.buildCopper ? (model.buildCopper.Cauldron || 0) : 0;
  const denom = 60 * model.pt.params.speedMult;
  const objCoef = targets.map((t) => (capW ? (t.time * cauldronBuild * capW) / denom : 0));
  const found = [];
  for (let t = 0; t < count; t++) {
    if (!mask[t]) continue;
    if (admitted && admitted.has(t)) continue;
    // reduced cost = c_j − y'A = capital − (y_out − Σ y_in + y_heat·(−heat) + y_cap·time)
    const ya = outDual[outIdx[t]] - inputDual[triA[t]] - inputDual[triB[t]] - inputDual[triC[t]] + outHeatTime[outIdx[t]];
    const rc = objCoef[outIdx[t]] - ya;
    if (rc < -EPS) found.push({ t, rc });
  }
  found.sort((a, b) => a.rc - b.rc);
  return found.slice(0, maxAdmit).map(({ t }) => t);
}

async function solveLp(lpString, options = {}) {
  const highs = await getHighs();
  return highs.solve(lpString, options);
}

// On infeasibility, probe whether machine capacity is the cause: re-solve with
// capacity ×100 and report per-machine counts actually needed.
async function probeInfeasibility(model, demand, objective) {
  const relaxed = new Model(model.pt, model.db);
  const m = model.pt.config.machines;
  relaxed.machineCapacity = (machine) => (m.counts[machine] ?? m.defaultCount) * 100 * 60 * relaxed.pt.params.speedMult;
  const r = await optimize(relaxed, { demand, objective });
  if (r.status !== 'Optimal') {
    return { cause: 'structural', detail: 'infeasible even with 100x machine capacity — a required item has no available production route under this config' };
  }
  const usage = {};
  for (const f of r.flows) {
    if (f.process.machine && f.process.timeSec > 0) {
      usage[f.process.machine] = (usage[f.process.machine] ?? 0) + f.process.timeSec * f.rate;
    }
  }
  const needed = Object.entries(usage)
    .map(([machine, secPerMin]) => ({
      machine,
      needed: Math.ceil(secPerMin / (60 * model.pt.params.speedMult)),
      configured: m.counts[machine] ?? m.defaultCount,
    }))
    .filter((u) => u.needed > u.configured);
  return { cause: 'capacity', detail: 'machine capacity too low', needed };
}

// Main entry: solve a demand vector under an objective with CG.
// Returns { status, objective, columns, flows, duals, iterations, binding }.
// Two-pass byproduct-sale cap (cost objective, sell policy). Free cash sources —
// notably belt coins — otherwise let the optimizer run EXTRA processes purely to
// harvest sellable co-products (buy cheap inputs with free belt coins, over-run gem
// cauldrons, sell the gems), driving "cost" negative. The fix measures honest
// co-production from a TRUE-COST baseline — pass 1 disables both byproduct SALES (no
// incentive to overproduce) AND free belt-coin cash (no free inputs to distort the
// route) — then pass 2 re-solves with the real config but each salebp column capped
// at that honest amount. So byproducts are credited only as the incidental bonus
// they'd genuinely be when making the demand at true cost; belt coins still cut
// purchase cost in pass 2, but can't unlock a gem side-business. No sale-policy
// byproducts (or non-cost objective) ⇒ single pass, no extra solve.
async function optimize(model, opts = {}) {
  const { objective = 'cost' } = opts;
  const salebp = model.pt.processes.filter((p) => p.kind === 'sale' && p.flags && p.flags.byproduct);
  if (objective !== 'cost' || salebp.length === 0) return optimizeOnce(model, opts);

  const cashCols = model.pt.processes.filter((p) => p.kind === 'spend'); // belt coin → copper cash
  const savedSale = salebp.map((p) => p.maxRate);
  const savedCash = cashCols.map((p) => p.maxRate);
  try {
    salebp.forEach((p) => { p.maxRate = 0; }); // pass 1: sales OFF
    cashCols.forEach((p) => { p.maxRate = 0; }); // pass 1: free belt-coin cash OFF (true cost)
    const pass1 = await optimizeOnce(model, opts);
    const coprod = new Map(); // byprod::X → honest co-production rate
    // If the no-coin baseline is infeasible (a build that genuinely needs coins),
    // leave coprod empty → sales capped at 0 (no byproduct credit, still arbitrage-
    // safe) while pass 2 turns coins back on so the build is feasible.
    if (pass1.status === 'Optimal') {
      for (const f of pass1.flows) {
        for (const [item, q] of Object.entries(f.process.produces)) {
          if (item.startsWith('byprod::')) coprod.set(item, (coprod.get(item) || 0) + q * f.rate);
        }
      }
    }
    salebp.forEach((p) => { p.maxRate = coprod.get(Object.keys(p.consumes)[0]) || 0; }); // pass 2: sales capped
    cashCols.forEach((p, i) => { p.maxRate = savedCash[i]; }); // pass 2: belt-coin cash back on
    return await optimizeOnce(model, opts);
  } finally {
    salebp.forEach((p, i) => { p.maxRate = savedSale[i]; });
    cashCols.forEach((p, i) => { p.maxRate = savedCash[i]; });
  }
}

// Build a MIP over the converged columns that activates a binary y_p for every machine
// column actually used (x_p ≤ M_p·y_p). Minimizing Σy_p gives the build with the FEWEST
// distinct production steps — a single clean route, never a cost-driven SPLIT (two routes
// for one item). objMode 'routes' minimizes Σy_p; 'cost' minimizes copper with Σy_p ≤
// routeCap (the lexicographic 2nd pass: cheapest build among the fewest-route ones).
function buildRouteMip({ model, columns, demand, costCap, objMode, routeCap }) {
  // activationFloor charges a tiny per-machine-second cost so the cost pass never runs a
  // pointless free machine route — e.g. burning the free belt Growth Potion through 39
  // nurseries to grow Redcurrant that's immediately discarded (cost-neutral, so otherwise
  // an allowed degenerate optimum). It drops such floating production to zero.
  const built = buildLpString({ model, columns, demand, objective: 'cost', costCap, activationFloor: objMode === 'cost' });
  if (built.infeasibleRow) return { infeasibleRow: built.infeasibleRow };
  const lines = built.lp.split('\n');
  const costExpr = (lines[1] || '').replace(/^\s*obj:\s*/, '');
  const stIdx = lines.indexOf('Subject To');
  const endIdx = lines.indexOf('End');
  const boundsIdx = lines.indexOf('Bounds');
  const genIdx = lines.indexOf('General');
  const rowsEnd = boundsIdx >= 0 ? boundsIdx : (genIdx >= 0 ? genIdx : endIdx);
  const constraintRows = lines.slice(stIdx + 1, rowsEnd);
  const existingBounds = boundsIdx >= 0 ? lines.slice(boundsIdx + 1, genIdx >= 0 ? genIdx : endIdx) : [];
  const bins = [];
  const links = [];
  columns.forEach((p, ci) => {
    if (!p.machine) return;
    // Bind EVERY machine column, including Nurseries (timeSec=0, grown continuously) —
    // they're still a distinct production line. timeSec>0 ⇒ big-M is the machine's max
    // runs; timeSec=0 ⇒ a large finite cap (Infinity would void the link and let a
    // nursery run free, uncounted, e.g. 55k Flax/min into the discard).
    const M = p.timeSec > 0 ? model.machineCapacity(p.machine) / p.timeSec : 1e9;
    const y = `y${ci}`;
    bins.push(y);
    links.push(` k${ci}: x${ci} - ${M} ${y} <= 0`);
  });
  const routeExpr = bins.map((y) => `+ 1 ${y}`).join(' ') || '0 x0';
  const obj = objMode === 'cost' ? costExpr : routeExpr;
  const extraRows = [...links];
  if (objMode === 'cost' && routeCap != null) extraRows.push(` rcap: ${routeExpr} <= ${routeCap}`);
  const body = [
    'Minimize', ` obj: ${obj}`,
    'Subject To', ...constraintRows, ...extraRows,
    'Bounds', ...existingBounds, ...bins.map((y) => ` 0 <= ${y} <= 1`),
    'General', ' ' + bins.join(' '),
    'End',
  ];
  return { lp: body.join('\n'), nBins: bins.length };
}

// Cost-tolerance "Simplest" solve.
//   1. min cost → C* (and the converged column set).
//   2. within budget C* + tolerance×Σdemand, build the FEWEST-route build (a single clean
//      line), then the cheapest among those. Below the per-item tolerance the user is
//      indifferent to copper, so we spend it to simplify — trading a sprawling free-herb
//      cauldron chain for a one-line ore→smelter route when the per-item gap is small.
async function optimizeWithinTolerance(model, opts = {}) {
  // Allowed waste two ways (the override wins): an ABSOLUTE tolerancePerItem (copper/item),
  // or a toleranceFraction of the build's own cheapest per-item cost (so a dropdown preset
  // scales across a 1c nail and a 280k Mars alike). A huge fraction ⇒ effectively unbounded
  // ("Simplest": the globally fewest-route build, cost only a tie-break).
  const { demand = {}, objective = 'cost', tolerancePerItem = 0, toleranceFraction = 0 } = opts;
  const base = await optimize(model, { demand, objective });
  if (base.status !== 'Optimal' || !base.columns) return base;
  const totalDemand = Object.values(demand).reduce((s, v) => s + (v || 0), 0);
  const perItemMin = totalDemand > 0 ? base.objective / totalDemand : 0;
  const tol = tolerancePerItem > 0 ? tolerancePerItem : toleranceFraction * perItemMin;
  if (!(tol > 0)) return base;
  const costCap = base.objective + tol * totalDemand;
  // Phase 2a — fewest distinct routes within the copper budget.
  const a = buildRouteMip({ model, columns: base.columns, demand, costCap, objMode: 'routes' });
  if (a.infeasibleRow) return base;
  const solA = await solveLp(a.lp);
  if (solA.Status !== 'Optimal') return base; // tolerance pass failed → keep the min-cost build
  // Phase 2b — cheapest build among those fewest-route ones (so we don't burn budget for a
  // build no simpler than a cheaper one). Round the route target up by 0.5 for MIP slack.
  const routeCap = Math.round(solA.ObjectiveValue) + 0.5;
  const b = buildRouteMip({ model, columns: base.columns, demand, costCap, objMode: 'cost', routeCap });
  const solB = await solveLp(b.lp);
  const sol = solB.Status === 'Optimal' ? solB : solA;
  // repackage flows; report TRUE cost. Drop negligible flows (numerical residue) relative
  // to the build's scale — a 1e-5/min flow is noise when you're making hundreds per minute.
  const flowEps = Math.max(EPS, totalDemand * 1e-5);
  const flows = [];
  let trueCost = 0;
  base.columns.forEach((p, ci) => {
    const primal = sol.Columns[`x${ci}`]?.Primal ?? 0;
    if (primal > flowEps) {
      flows.push({ process: p, rate: primal });
      trueCost += ((p.copperCost ?? 0) - (p.copperRevenue ?? 0) + model.capitalPerRun(p)) * primal;
    }
  });
  return { ...base, flows, objective: trueCost, simplestWithinTolerance: true, minCost: base.objective };
}

async function optimizeOnce(model, { demand = {}, objective = 'cost', maxRounds = 100 } = {}) {
  for (const item of Object.keys(demand)) {
    if (!model.itemIndex.has(item)) throw new Error(`unknown item "${item}"`);
  }
  const explicit = model.activeExplicit(objective);
  let cauldronCols = seedCauldronColumns(model);
  const admitted = new Set(cauldronCols.map((p) => p.tripleIndex));

  let result = null;
  let rounds = 0;
  let lastLp = null;
  for (; rounds < maxRounds; rounds++) {
    const columns = [...explicit, ...cauldronCols];
    const built = buildLpString({ model, columns, demand, objective });
    if (built.infeasibleRow) {
      return { status: 'Infeasible', reason: `no producing column for demanded item "${built.infeasibleRow}"`, columns, rounds };
    }
    lastLp = built;
    const sol = await solveLp(built.lp);
    if (sol.Status !== 'Optimal') {
      return { status: sol.Status, columns, rounds, sol };
    }

    // extract duals
    const duals = { items: new Float64Array(model.itemNames.length), heat: 0, nutrient: 0, capacity: {} };
    for (const row of Object.values(sol.Rows)) {
      const idx = Number(row.Name.slice(1));
      if (idx < model.itemNames.length) duals.items[idx] = row.Dual ?? 0;
      else if (idx === built.HEAT_ROW) duals.heat = row.Dual ?? 0;
      else if (idx === built.NUTRIENT_ROW) duals.nutrient = row.Dual ?? 0;
      else duals.capacity[model.machineNames[idx - built.CAP_BASE]] = row.Dual ?? 0;
    }

    const newTriples = model.pt.cauldron
      ? rescanCauldron(model, duals, duals.capacity['Cauldron'] ?? 0, admitted)
      : [];
    if (newTriples.length === 0) {
      // converged. When capital pricing is off the LP is degenerate (net-zero
      // intermediates), so the basis we landed on may include useless side-loops.
      // Re-solve the final column set with a tiny per-machine-second activation
      // floor to pick the minimal-machine-second optimum among all optima — this
      // drops the floating production without changing the true (material) cost.
      let polished = sol;
      if (!model.capitalWeight) {
        const pbuilt = buildLpString({ model, columns, demand, objective, activationFloor: true });
        const psol = await solveLp(pbuilt.lp);
        if (psol.Status === 'Optimal') polished = psol;
      }
      // package the result (flows from the polished solve; objective is the true cost)
      const flows = [];
      columns.forEach((p, ci) => {
        const primal = polished.Columns[`x${ci}`]?.Primal ?? 0;
        if (primal > EPS) flows.push({ process: p, rate: primal });
      });
      const binding = [];
      for (const [mname, d] of Object.entries(duals.capacity)) {
        if (Math.abs(d) > EPS) binding.push({ machine: mname, dual: d, capacity: model.machineCapacity(mname) });
      }
      return {
        status: 'Optimal',
        objective: sol.ObjectiveValue,
        flows, duals, binding,
        rounds: rounds + 1,
        columnsInMaster: columns.length,
        admittedCauldron: cauldronCols.length,
        columns, // the converged master set — reused by the cost-tolerance min-machines pass
      };
    }
    for (const t of newTriples) {
      admitted.add(t);
      cauldronCols.push(model.pt.cauldron.materialize(t));
    }
  }
  return { status: 'MaxRoundsExceeded', rounds };
}

// Min-machines MIP over the active columns of a converged cost solve:
// fix the demand, add integer dedication counts n_p ≥ x_p·timeSec/(60·speedMult),
// minimize Σ n_p (slot-weighted if weights provided).
async function minMachines(model, costResult, { demand, slotWeighted = false } = {}) {
  const active = costResult.flows.map((f) => f.process);
  const built = buildLpString({ model, columns: active, demand, objective: 'cost' });
  if (built.infeasibleRow) return { status: 'Infeasible' };
  // augment: integer n_i per active column with machine time
  const lines = built.lp.split('\n');
  const capPerMin = 60 * model.pt.params.speedMult;
  const intVars = [];
  const extra = [];
  active.forEach((p, ci) => {
    if (!p.machine || p.timeSec <= 0) return;
    const slots = slotWeighted ? (model.db.machines[p.machine]?.slotsRequired ?? 1) : 1;
    const n = `n${ci}`;
    intVars.push({ n, slots });
    extra.push(` d${ci}: ${p.timeSec} x${ci} - ${capPerMin} ${n} <= 0`);
  });
  const objLine = ` obj: ${intVars.map(({ n, slots }) => `+ ${slots} ${n}`).join(' ') || '0 x0'}`;
  const stIdx = lines.indexOf('Subject To');
  const endIdx = lines.indexOf('End');
  const body = ['Minimize', objLine, 'Subject To', ...lines.slice(stIdx + 1, endIdx).filter((l) => !l.startsWith('General')), ...extra,
    'General', ' ' + intVars.map(({ n }) => n).join(' '), 'End'];
  const sol = await solveLp(body.join('\n'));
  if (sol.Status !== 'Optimal') return { status: sol.Status };
  const machines = [];
  active.forEach((p, ci) => {
    const n = sol.Columns[`n${ci}`]?.Primal ?? 0;
    if (n > 0.5) machines.push({ process: p.id, machine: p.machine, count: Math.round(n) });
  });
  return { status: 'Optimal', totalMachines: sol.ObjectiveValue, machines };
}

module.exports = { Model, optimize, optimizeWithinTolerance, minMachines, probeInfeasibility, buildLpString, seedCauldronColumns, rescanCauldron, makeItemCopperFloor };
