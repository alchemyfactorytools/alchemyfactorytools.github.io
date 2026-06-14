// Flow-graph builder: converts a converged optimize() result into a renderable
// factory graph — process nodes with integer machine counts, external-input and
// demand nodes, HEAT/NUTRIENT resource hubs, and item-flow edges attributed
// pro-rata from producers to consumers.

'use strict';

const EPS = 1e-6;

function fmtRate(n) {
  if (!isFinite(n)) return '∞';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(1);
}

function processLabel(p) {
  const strip = (s) => String(s).replace(/^(?:byprod|belt)::/, '');
  switch (p.kind) {
    case 'purchase': return `Buy ${Object.keys(p.produces)[0]}`;
    case 'mint': return `Mint ${Object.keys(p.produces)[0]}`;
    case 'cash': return 'Coins (minted)';
    case 'sale': return `Sell ${strip(Object.keys(p.consumes)[0])}`;
    case 'burn': return `Burn ${strip(Object.keys(p.consumes)[0])}${p.flags && p.flags.belt ? ' (belt)' : ''}`;
    case 'fertilize': return `Fertilize w/ ${strip(Object.keys(p.consumes)[0])}${p.flags && p.flags.belt ? ' (belt)' : ''}`;
    case 'cauldron': {
      const out = strip(Object.keys(p.produces)[0] || '?');
      const ins = Object.entries(p.consumes).map(([n, q]) => (q > 1 ? `${q}× ${n}` : n)).join(' + ');
      return `${out} ⬅ cauldron(${ins})`;
    }
    case 'catalystVariant': return `${strip(p.primary || p.recipeId)} (+${p.flags.catalyst})`;
    case 'reuseByproduct': return `Reuse ${strip(Object.keys(p.produces)[0])}`;
    case 'belt': return `Main belt: ${p.item}`;
    // a recipe node is named for the ITEM it makes (its primary output), not the raw
    // recipe id — so an alternate recipe like "CopperPowder2_Alt" reads "Copper Powder"
    default: return strip(p.primary || p.recipeId || p.id);
  }
}

function badges(p) {
  const out = [];
  if (p.flags?.exactTie) out.push('TIE');
  else if (p.flags?.fragileMargin !== undefined) out.push('FRAGILE');
  if (p.kind === 'mint') out.push('ASSUMPTION');
  if (p.flags?.catalyst) out.push(p.flags.catalyst.toUpperCase());
  return out;
}

// Build {nodes, edges, summary} from a solved result.
// demand: {item: rate}. model supplies skill params for machine counts.
// opts.resourceConsumerEdges (default false): when true, draw an edge from the
// HEAT/NUTRIENT hub to every consuming machine. These cross the whole graph, so
// by default the hub is a "pooled" sink — supply edges in, consumers annotated
// rather than wired — which keeps deep builds legible.
const NURSERIES = new Set(['Nursery', 'World Tree Nursery']);

// Virtual LP rows (byprod::Y, belt::X) are internal fences — display the real item.
// copper::cash is the money row; show it as "copper".
const COPPER = 'copper::cash';
const stripVirtual = (s) => (String(s) === COPPER ? 'copper' : String(s).replace(/^(?:byprod|belt)::/, ''));

function buildFlowGraph(result, model, demand, opts = {}) {
  if (result.status !== 'Optimal') throw new Error(`cannot graph a ${result.status} result`);
  const speedMult = model.pt.params.speedMult;
  const beltSpeed = model.pt.params.beltSpeed; // items/min a belt carries (logistics skill)
  const resourceConsumerEdges = opts.resourceConsumerEdges === true;
  const flowsAll = result.flows.filter((f) => f.rate > EPS);

  // Nursery crops grow at a rate set by the fertilizer's maxFertility, capped by
  // belt speed: per-plot rate = min(60·maxFertility/nutrientCost, beltSpeed). Pick
  // the dominant active fertilizer (most nutrient supplied). Without this a Nursery
  // node falsely implies one plot makes the whole crop demand.
  let fertMaxFertility = 0;
  let fertItem = null;
  let primaryFertNutrient = 0; // nutrient produced per unit of the dominant fertilizer
  let bestNutrient = 0;
  for (const f of flowsAll) {
    if (f.process.kind !== 'fertilize') continue;
    const nutrientOut = (f.process.nutrient || 0) * f.rate;
    if (nutrientOut > bestNutrient) {
      bestNutrient = nutrientOut;
      fertMaxFertility = f.process.maxFertility || 0;
      fertItem = stripVirtual(Object.keys(f.process.consumes)[0]);
      primaryFertNutrient = f.process.nutrient || 0;
    }
  }
  const nurseryPlots = (proc, rate) => {
    const nutrientCost = proc.nutrient < 0 ? -proc.nutrient : 0;
    if (!nutrientCost) return { count: null, perPlot: null };
    const fertilityRate = fertMaxFertility ? (60 * fertMaxFertility) / nutrientCost : Infinity;
    const perPlot = Math.min(fertilityRate, beltSpeed);
    return {
      count: isFinite(perPlot) && perPlot > 0 ? Math.ceil(rate / perPlot - 1e-9) : null,
      perPlot: isFinite(perPlot) ? perPlot : null,
      limitedBy: fertilityRate < beltSpeed ? 'fertilizer' : 'belt speed',
    };
  };
  const nodes = [];
  const edges = [];
  const nodeById = new Map();

  const addNode = (n) => { nodeById.set(n.id, n); nodes.push(n); return n; };

  // Primary fuel burned in the solution — used to express each heated machine's
  // heat draw as "X of your fuel per minute" directly on the machine (instead of
  // a separate HEAT box). Heat per item = item.heat × fuelMult.
  const fuelMult = model.pt.params.fuelMult;
  let primaryFuel = null;
  let primaryFuelHeat = 0;
  {
    let maxHeat = 0;
    for (const f of flowsAll) {
      if (f.process.kind !== 'burn') continue;
      const h = f.process.heat * f.rate;
      const item = stripVirtual(Object.keys(f.process.consumes)[0]);
      if (h > maxHeat) { maxHeat = h; primaryFuel = item; primaryFuelHeat = (model.db.items[item].heat || 1) * fuelMult; }
    }
  }

  // --- process nodes ---
  // burn (fuel→heat) and fertilize (item→nutrient) columns are LP artifacts. They're
  // not rendered as nodes: the supply flows straight from its source (belt / the
  // fuel or fertilizer recipe) to the machine that consumes it, shown by a band on
  // that machine. So skip them here and splice them out of the edges below.
  const flows = flowsAll;
  // burn/fertilize (heat/nutrient) AND spend/cash (copper) columns are LP artifacts —
  // not rendered as nodes; their supply is wired source→consumer below (fuel/fert
  // bands; coin→purchase cash edges), then spliced out of the raw edge list.
  const hidden = new Set(flows.filter((f) => ['burn', 'fertilize', 'spend'].includes(f.process.kind)).map((f) => f.process.id));
  for (const f of flows) {
    const p = f.process;
    if (hidden.has(p.id)) continue;
    let machineCount = p.machine && p.timeSec > 0
      ? Math.ceil((f.rate * p.timeSec) / (60 * speedMult) - 1e-9)
      : null;
    let util = machineCount ? (f.rate * p.timeSec) / (60 * speedMult) / machineCount : null;
    // tileLoad = continuous machine/plot demand (NOT the integer ceil) — what
    // blueprint() tiles into clean cells. For a timed machine it's the fractional
    // machine-equivalents; for a nursery it's the fractional plot count (rate/perPlot).
    // Kept separate from `utilization` (which stays null for nurseries — the render
    // layer uses utilization!=null to tell timed machines from plot-count nurseries).
    let tileLoad = p.machine && p.timeSec > 0 ? (f.rate * p.timeSec) / (60 * speedMult) : null;
    let nurseryNote = null;
    if (p.machine && NURSERIES.has(p.machine)) {
      const np = nurseryPlots(p, f.rate);
      machineCount = np.count;
      util = null; // nurseries are plot-count, not time-utilization (render + blueprint key off this)
      tileLoad = np.perPlot ? f.rate / np.perPlot : null;
      nurseryNote = np.perPlot ? `${fmtRate(np.perPlot)}/plot, limited by ${np.limitedBy}` : 'plot count needs a fertilizer';
    }
    const heatPerMin = p.heat < 0 ? -p.heat * f.rate : 0;
    const nutrientPerMin = p.nutrient < 0 ? -p.nutrient * f.rate : 0;
    const external = p.kind === 'purchase' || p.kind === 'mint' || p.kind === 'belt' || p.kind === 'cash';
    // Belt nodes: how many parallel belts this supply needs at the current belt
    // speed (Logistics skill). A single belt only carries beltSpeed items/min.
    const beltLanes = p.kind === 'belt' && beltSpeed > 0 ? Math.ceil(f.rate / beltSpeed - 1e-9) : null;
    addNode({
      id: p.id,
      type: external ? 'external' : 'process',
      kind: p.kind,
      label: processLabel(p),
      machine: p.machine ?? null,
      machineCount,
      utilization: util,
      tileLoad,
      nurseryNote,
      heatPerMin,
      nutrientPerMin,
      // fuel this machine burns / fertilizer it consumes per minute (bands on the node)
      fuelItem: heatPerMin > 0 && primaryFuel ? primaryFuel : null,
      fuelPerMin: heatPerMin > 0 && primaryFuelHeat ? heatPerMin / primaryFuelHeat : 0,
      fertItem: nutrientPerMin > 0 && fertItem ? fertItem : null,
      fertPerMin: nutrientPerMin > 0 && primaryFertNutrient ? nutrientPerMin / primaryFertNutrient : 0,
      ratePerMin: f.rate,
      beltLanes,
      beltSpeed: p.kind === 'belt' ? beltSpeed : null,
      // a purchase's copper cost lives on its buyPrice now (it consumes the copper
      // row rather than carrying a scalar cost); everything else uses copperCost.
      copperPerMin: (p.kind === 'purchase' ? (p.flags.buyPrice || 0) : (p.copperCost - p.copperRevenue)) * f.rate || 0,
      badges: badges(p),
    });
  }

  // --- demand nodes ---
  for (const [item, rate] of Object.entries(demand)) {
    addNode({ id: `demand:${item}`, type: 'demand', label: `${item} (target)`, ratePerMin: rate, badges: [] });
  }

  // --- item flow edges, pro-rata producer→consumer attribution ---
  const producers = new Map(); // item -> [{nodeId, rate}]
  const consumers = new Map();
  const push = (map, item, nodeId, rate) => {
    if (rate <= EPS) return;
    if (!map.has(item)) map.set(item, []);
    map.get(item).push({ nodeId, rate });
  };
  for (const f of flows) {
    const p = f.process;
    for (const [item, qty] of Object.entries(p.produces)) push(producers, item, p.id, qty * f.rate);
    for (const [item, qty] of Object.entries(p.consumes)) push(consumers, item, p.id, qty * f.rate);
  }
  for (const [item, rate] of Object.entries(demand)) push(consumers, item, `demand:${item}`, rate);

  for (const [item, prods] of producers) {
    if (item === COPPER) continue; // money flow is drawn by the dedicated cash wiring below
    const cons = consumers.get(item) ?? [];
    const totalProd = prods.reduce((s, x) => s + x.rate, 0);
    const totalCons = cons.reduce((s, x) => s + x.rate, 0);
    const itemLabel = stripVirtual(item);
    for (const pr of prods) {
      for (const co of cons) {
        const rate = (pr.rate / totalProd) * (co.rate / Math.max(totalCons, EPS)) * Math.min(totalProd, totalCons);
        if (rate > EPS) edges.push({ from: pr.nodeId, to: co.nodeId, item: itemLabel, ratePerMin: rate });
      }
    }
    // Surplus production with no consumer → implicit disposal. Only worth showing
    // a discard node for a MEANINGFUL surplus; sub-fractional leftovers (LP rounding
    // / activation-floor polish) are just buffer on the line, not a discard pile.
    const surplus = totalProd - totalCons;
    const surplusFloor = Math.max(0.02, totalProd * 0.005);
    if (surplus > surplusFloor) {
      const id = `surplus:${item}`;
      if (!nodeById.has(id)) addNode({ id, type: 'surplus', label: `${itemLabel} surplus (discard/store)`, ratePerMin: surplus, badges: [] });
      for (const pr of prods) {
        const rate = (pr.rate / totalProd) * surplus;
        if (rate > EPS) edges.push({ from: pr.nodeId, to: id, item: itemLabel, ratePerMin: rate });
      }
    }
  }

  // --- HEAT (furnace) / NUTRIENT pools, wired fuel → source → consumers ---
  // Heated machines attach to a Stone Furnace that burns fuel; this makes that
  // physical heat source explicit (with furnace count from slot occupancy) and
  // wires it to every consuming machine, so the heat→fuel dependency is visible.
  // dagre routes the consumer edges cleanly. Set resourceConsumerEdges:false to
  // collapse back to a pooled node (supply edges only) on very dense graphs.
  const wire = opts.resourceConsumerEdges !== false;
  const furnaceTotals = {};

  // HEAT: no pool box and no burn node — fuel flows straight from its SOURCE (the
  // belt node, or the recipe that makes the fuel) to the machine that burns it,
  // dim heat-styled and labelled in fuel/min to match the machine's red band. The
  // burn column is spliced out: we attribute each machine's heat across the burn
  // columns, then to each burn column's fuel producer(s). We also count the Stone
  // Furnace(s) the heated machines attach to (slot occupancy).
  {
    const burners = flows.filter((f) => f.process.heat > EPS); // fuel → heat
    const heatConsumers = flows.filter((f) => f.process.heat < -EPS); // machines drawing heat
    const totalHeatOut = burners.reduce((s, f) => s + f.process.heat * f.rate, 0);
    if (wire && totalHeatOut > EPS) {
      for (const b of burners) {
        const share = (b.process.heat * b.rate) / totalHeatOut; // this fuel's slice of the heat pool
        const fuelKey = Object.keys(b.process.consumes)[0];
        const fuelItem = stripVirtual(fuelKey);
        const fuelHeat = (model.db.items[fuelItem]?.heat || 1) * fuelMult;
        const fuelProds = producers.get(fuelKey) || []; // who makes/supplies this fuel
        const totalFuelProd = fuelProds.reduce((s, x) => s + x.rate, 0) || 1;
        for (const c of heatConsumers) {
          const fuelRate = (-c.process.heat * c.rate * share) / fuelHeat;
          if (fuelRate <= EPS) continue;
          for (const fp of fuelProds) {
            if (hidden.has(fp.nodeId)) continue;
            const r = fuelRate * (fp.rate / totalFuelProd);
            if (r > EPS) edges.push({ from: fp.nodeId, to: c.process.id, item: fuelItem, ratePerMin: r, heat: true });
          }
        }
      }
    }
    const slotsByFurnace = {};
    for (const f of heatConsumers) {
      const m = model.db.machines[f.process.machine];
      const node = nodeById.get(f.process.id);
      if (!m || !m.parent || !node || !node.machineCount) continue;
      const slots = m.slotsRequired ?? (model.db.machines[m.parent]?.slots ?? 9);
      slotsByFurnace[m.parent] = (slotsByFurnace[m.parent] ?? 0) + node.machineCount * slots;
    }
    for (const [fname, slots] of Object.entries(slotsByFurnace)) {
      furnaceTotals[fname] = Math.ceil(slots / (model.db.machines[fname]?.slots || 9));
    }
  }

  // NUTRIENT: no hub box and no fertilize node — fertilizer flows straight from its
  // SOURCE (the recipe that makes it) to the machine that consumes it (a Nursery),
  // dim and labelled in fertilizer/min to match the machine's green band. Mirrors
  // the fuel wiring: the fertilize column is spliced out below.
  {
    const fertilizers = flows.filter((f) => f.process.nutrient > EPS); // fertilizer → nutrient
    const nutrientConsumers = flows.filter((f) => f.process.nutrient < -EPS);
    const totalNutrientOut = fertilizers.reduce((s, f) => s + f.process.nutrient * f.rate, 0);
    if (wire && totalNutrientOut > EPS) {
      for (const b of fertilizers) {
        const share = (b.process.nutrient * b.rate) / totalNutrientOut; // this fertilizer's slice
        const fertKey = Object.keys(b.process.consumes)[0];
        const fItem = stripVirtual(fertKey);
        const perUnit = b.process.nutrient || 1; // nutrient per 1 fertilizer unit
        const fProds = producers.get(fertKey) || []; // who makes/supplies this fertilizer
        const totalFProd = fProds.reduce((s, x) => s + x.rate, 0) || 1;
        for (const c of nutrientConsumers) {
          const fertRate = (-c.process.nutrient * c.rate * share) / perUnit;
          if (fertRate <= EPS) continue;
          for (const fp of fProds) {
            if (hidden.has(fp.nodeId)) continue;
            const r = fertRate * (fp.rate / totalFProd);
            if (r > EPS) edges.push({ from: fp.nodeId, to: c.process.id, item: fItem, ratePerMin: r, nutrient: true });
          }
        }
      }
    }
  }

  // COPPER (cash): purchases consume copper, supplied by belt coins (spend columns)
  // and the mint valve (money you spend beyond the belt). Each money SOURCE is wired
  // straight to the purchases it funds with a cash-styled edge, so every Buy node
  // shows where its money comes from: a belt coin node when you have coins on the
  // belt, otherwise the "Coins (minted)" node. The spend columns are hidden artifacts
  // (the belt coin node is the visible source); the mint node is shown as that source.
  {
    const cashConsumers = flows.filter((f) => (f.process.consumes[COPPER] || 0) > 0); // purchases
    const cashProducers = flows.filter((f) => (f.process.produces[COPPER] || 0) > 0); // belt-coin spend + mint
    const totalCopperOut = cashProducers.reduce((s, f) => s + (f.process.produces[COPPER] || 0) * f.rate, 0);
    if (wire && totalCopperOut > EPS) {
      for (const prod of cashProducers) {
        const share = ((prod.process.produces[COPPER] || 0) * prod.rate) / totalCopperOut; // this source's slice of the cash pool
        // resolve the visible money source + the unit its edge is labelled in
        let srcNodes, label, denom;
        if (prod.process.kind === 'spend') {
          const coinKey = Object.keys(prod.process.consumes)[0]; // belt::<coin>
          label = stripVirtual(coinKey);
          denom = model.db.items[label]?.sellPrice || 1; // copper per coin → edge in coins/min
          srcNodes = (producers.get(coinKey) || []).map((x) => ({ nodeId: x.nodeId, w: x.rate }));
        } else { // mint:copper — the valve node is itself the visible source
          label = 'copper';
          denom = 1; // edge in copper/min
          srcNodes = [{ nodeId: prod.process.id, w: 1 }];
        }
        const totalW = srcNodes.reduce((s, x) => s + x.w, 0) || 1;
        for (const c of cashConsumers) {
          const copperToBuy = (c.process.consumes[COPPER] || 0) * c.rate * share;
          if (copperToBuy <= EPS) continue;
          const rate = copperToBuy / denom;
          for (const sn of srcNodes) {
            if (hidden.has(sn.nodeId)) continue;
            const r = rate * (sn.w / totalW);
            if (r > EPS) edges.push({ from: sn.nodeId, to: c.process.id, item: label, ratePerMin: r, cash: true });
          }
        }
      }
    }
  }

  // splice out the hidden burn/fertilize/spend/cash columns: drop any edge touching
  // one. Their replacement (source → machine, coin → purchase) was added above.
  for (let i = edges.length - 1; i >= 0; i--) {
    if (hidden.has(edges[i].from) || hidden.has(edges[i].to)) edges.splice(i, 1);
  }

  // --- summary ---
  const externals = flows
    .filter((f) => f.process.kind === 'purchase' || f.process.kind === 'mint')
    .map((f) => ({
      item: stripVirtual(Object.keys(f.process.produces)[0]),
      kind: f.process.kind,
      ratePerMin: f.rate * Object.values(f.process.produces)[0],
      // purchases carry cost via buyPrice (they consume the copper row); mints via copperCost
      copperPerMin: (f.process.kind === 'purchase' ? (f.process.flags.buyPrice || 0) : f.process.copperCost) * f.rate,
    }))
    .sort((a, b) => b.copperPerMin - a.copperPerMin);
  for (const f of flows.filter((x) => x.process.kind === 'belt')) {
    externals.push({
      item: `${f.process.item} (belt)`,
      kind: 'belt',
      ratePerMin: f.rate,
      copperPerMin: 0,
    });
  }
  const machineTotals = {};
  for (const n of nodes) {
    if (n.machineCount) machineTotals[n.machine] = (machineTotals[n.machine] ?? 0) + n.machineCount;
  }
  // furnaces (heat sources) are not recipe machines but are buildables you need
  for (const [fname, count] of Object.entries(furnaceTotals)) {
    machineTotals[fname] = (machineTotals[fname] ?? 0) + count;
  }
  // capital (amortized machine build) portion of the objective, split out so the
  // user can see how much of the cost is machines vs materials
  const capitalPerMin = flows.reduce((s, f) => s + model.capitalPerRun(f.process) * f.rate, 0);
  // NET external copper actually spent = objective minus capital (belt coins offset
  // gross purchase cost, so net is what's truly minted). Used for the self-sustaining
  // check; the externals list still shows each purchase's gross copper for detail.
  const spend = result.objective - capitalPerMin;
  const demandTotal = Object.values(demand).reduce((s, r) => s + r, 0);
  const summary = {
    copperPerMin: result.objective,
    capitalPerMin,
    beltSpeed, // items/min one belt carries — tile blueprints cap per-tile output at this

    materialPerMin: result.objective - capitalPerMin,
    externals,
    machineTotals,
    cgRounds: result.rounds,
    binding: result.binding ?? [],
    selfSustaining: demandTotal > 0 && spend < 1 && capitalPerMin < 1,
    fragileRoutes: flows.filter((f) => f.process.kind === 'cauldron' && (f.process.flags.fragileMargin !== undefined || f.process.flags.exactTie)).length,
  };

  const graph = { nodes, edges, summary };
  summary.validation = validateGraph(graph, result, demand);
  return graph;
}

// Graphviz DOT export of the same graph (for users who want dot/neato rendering).
function toDot(graph) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const lines = ['digraph factory {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const n of graph.nodes) {
    const extra = n.machineCount ? `\\n${n.machineCount}× ${n.machine}` : '';
    const badge = n.badges.length ? `\\n[${n.badges.join(', ')}]` : '';
    const color = { external: 'lightblue', demand: 'gold', resource: 'lightcoral', surplus: 'lightgray', process: 'white' }[n.type] ?? 'white';
    lines.push(`  "${esc(n.id)}" [label="${esc(n.label)}${extra}${badge}", style=filled, fillcolor=${color}];`);
  }
  for (const e of graph.edges) {
    lines.push(`  "${esc(e.from)}" -> "${esc(e.to)}" [label="${esc(e.item)} ${e.ratePerMin.toFixed(1)}/min"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

// Mermaid flowchart export, with one subgraph per production line so it renders
// the sub-line grouping in GitHub / Notion / Obsidian / docs. Needs the layout's
// cluster assignment, so the caller passes assignClusters() output.
function toMermaid(graph, clusterAssignment) {
  const dir = 'TD';
  const safe = (id) => 'n' + String(id).replace(/[^a-zA-Z0-9]/g, '_');
  const esc = (s) => String(s).replace(/["\n]/g, ' ').replace(/[[\]{}|]/g, '');
  const nodeLabel = (n) => {
    const sub = n.machineCount ? `<br/>${n.machineCount}× ${n.machine}` : (n.machine ? `<br/>${n.machine}` : '');
    const rate = n.ratePerMin != null ? `<br/>${n.ratePerMin >= 100 ? Math.round(n.ratePerMin) : n.ratePerMin.toFixed(1)}/min` : '';
    return esc(n.label) + sub + rate;
  };
  const shape = (n) => {
    if (n.type === 'demand') return (id, l) => `${id}{{"${l}"}}`;
    if (n.type === 'external') return (id, l) => `${id}[/"${l}"/]`;
    if (n.type === 'resource' || n.type === 'surplus') return (id, l) => `${id}(["${l}"])`;
    return (id, l) => `${id}["${l}"]`;
  };
  const lines = [`flowchart ${dir}`];
  const clusterOf = (clusterAssignment && clusterAssignment.clusterOf) || new Map();
  const clusters = (clusterAssignment && clusterAssignment.clusters) || [];
  const emitted = new Set();
  const emitNode = (n) => { lines.push('  ' + shape(n)(safe(n.id), nodeLabel(n))); emitted.add(n.id); };
  // shared main-belt supply band (feeds every line, so it's its own group)
  const beltNodes = graph.nodes.filter((n) => n.type === 'external' && n.kind === 'belt');
  if (beltNodes.length) {
    lines.push('  subgraph belt_box ["Main belt"]');
    for (const n of beltNodes) emitNode(n);
    lines.push('  end');
  }
  // one subgraph per production line
  for (const c of clusters) {
    const members = c.members.filter((id) => graph.nodes.find((n) => n.id === id));
    if (members.length < 2) continue;
    lines.push(`  subgraph ${safe(c.id)}_box ["${esc(c.label)} line"]`);
    for (const id of members) { const n = graph.nodes.find((x) => x.id === id); if (n) emitNode(n); }
    lines.push('  end');
  }
  for (const n of graph.nodes) if (!emitted.has(n.id)) emitNode(n);
  for (const e of graph.edges) {
    if (!graph.nodes.find((n) => n.id === e.from) || !graph.nodes.find((n) => n.id === e.to)) continue;
    const lbl = `${esc(e.item)} ${e.ratePerMin >= 100 ? Math.round(e.ratePerMin) : e.ratePerMin.toFixed(1)}`;
    lines.push(`  ${safe(e.from)} -->|"${lbl}"| ${safe(e.to)}`);
  }
  return lines.join('\n');
}

// Graph completeness validator. Every rendered recipe/machine node must show
// where each of its inputs comes from and where each output goes:
//   - one incoming edge per MATERIAL it consumes (in meaningful quantity)
//   - a heat (fuel) edge if it burns fuel
//   - a NUTRIENT edge if it needs fertilizer
//   - one outgoing edge per MATERIAL it produces (to a consumer, surplus, or the
//     demand sink)
// Returns a list of { node, label, kind, item } issues; empty means the drawing
// faithfully represents the solved plan (nothing dangling, nothing missing).
function validateGraph(graph, result, demand) {
  const RATE_EPS = 0.02; // ignore buffer-scale (<0.02/min) imbalances — those aren't drawn
  const incoming = new Map();
  const outgoing = new Map();
  const heatIn = new Set();
  const nutrientIn = new Set();
  for (const n of graph.nodes) { incoming.set(n.id, new Set()); outgoing.set(n.id, new Set()); }
  for (const e of graph.edges) {
    if (outgoing.has(e.from)) outgoing.get(e.from).add(e.item);
    if (incoming.has(e.to)) incoming.get(e.to).add(e.item);
    if (e.to != null && (e.heat || e.item === 'HEAT')) heatIn.add(e.to);
    if (e.to != null && (e.nutrient || e.item === 'NUTRIENT')) nutrientIn.add(e.to);
  }
  const rendered = new Set(graph.nodes.map((n) => n.id));
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label || n.id]));
  const issues = [];
  for (const f of result.flows) {
    const p = f.process;
    if (!rendered.has(p.id)) continue; // hidden artifacts (burn) aren't drawn — skip
    const inSet = incoming.get(p.id);
    const outSet = outgoing.get(p.id);
    for (const [item, qty] of Object.entries(p.consumes || {})) {
      if (qty * f.rate <= RATE_EPS) continue;
      if (item === COPPER) continue; // money: minted externally or shown as coin edges (labelled by coin, not "copper")
      const disp = stripVirtual(item);
      if (!inSet.has(disp)) issues.push({ node: p.id, label: labelOf.get(p.id), kind: 'missing-input', item: disp });
    }
    for (const [item, qty] of Object.entries(p.produces || {})) {
      if (qty * f.rate <= RATE_EPS) continue;
      const disp = stripVirtual(item);
      if (demand[disp] != null) continue; // routed to the demand sink
      if (!outSet.has(disp)) issues.push({ node: p.id, label: labelOf.get(p.id), kind: 'missing-output', item: disp });
    }
    if (p.heat < -EPS && !heatIn.has(p.id)) issues.push({ node: p.id, label: labelOf.get(p.id), kind: 'missing-fuel', item: 'HEAT' });
    if (p.nutrient < -EPS && !nutrientIn.has(p.id)) issues.push({ node: p.id, label: labelOf.get(p.id), kind: 'missing-fertilizer', item: 'NUTRIENT' });
  }
  return issues;
}

module.exports = { buildFlowGraph, toDot, toMermaid, validateGraph };
