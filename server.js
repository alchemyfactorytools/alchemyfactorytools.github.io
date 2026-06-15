#!/usr/bin/env node
// Local visualization server (zero dependencies beyond `highs`).
//
//   node server.js [port]      → http://localhost:8347
//
// GET  /api/items              item catalog (names, buyability, cauldron data)
// POST /api/solve              { item, rate, config } → { summary, graph, explain }
// POST /api/dot                same body → Graphviz DOT text

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { resolveConfig } = require('./src/config');
const { buildProcessTable } = require('./src/normalize');
const { Model, optimize, optimizeWithinTolerance, probeInfeasibility } = require('./src/model');
const { buildFlowGraph, toDot, toMermaid } = require('./src/flowgraph');
const { canonicalUtilities, canonicalCarriers } = require('./src/utilities');
const { makeComposer } = require('./src/composer');
const { composeGraph } = require('./src/compose-graph');
const { assignClusters } = require('./src/layout');
const { explain } = require('./src/explain');
const db = require('./data/alchemy_db.v41.json');

// Bump alongside web/app.js BUILD_STAMP. Surfaced at /api/version so a bug report can
// prove whether the browser and the running server agree on the code version.
const SERVER_STAMP = 'composer-recirc-and-converge-2026-06-14z';
const SERVER_STARTED = new Date().toISOString();

const PORT = Number(process.argv[2] ?? 8347);
const WEB = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function itemCatalog() {
  return Object.entries(db.items).map(([name, item]) => ({
    name,
    category: item.category,
    buyPrice: item.buyPrice ?? null,
    sellPrice: item.sellPrice ?? null,
    cauldronTarget: item.cauldronTarget ?? null,
    cauldronEligible: item.cauldronCost !== undefined && !item.liquid,
    mintable: ['Copper Coin', 'Silver Coin', 'Gold Coin'].includes(name),
  }));
}

async function solveRequest(body) {
  const { item, rate = 1, rateMode = 'rate', config = {} } = body;
  if (!db.items[item]) throw Object.assign(new Error(`unknown item "${item}"`), { status: 400 });
  if (!(rate > 0)) throw Object.assign(new Error('rate must be > 0'), { status: 400 });
  const cfg = resolveConfig(config);
  // "Simplest" solver: the deterministic tile composer, not the LP. Picks one canonical recipe per
  // item and composes a replicated, self-contained tile tree (fuel/fert/coins as shared trunks).
  // Same {summary, graph} response shape as the LP path, so the renderer is unchanged.
  if (config.solver === 'composer') return composerSolve(item, rate, rateMode, cfg);
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

// Tile-composer ("Simplest") solve — no LP. Deterministic canonical picks → sized replicated tile
// tree → renderable graph. Returns the same response envelope solveRequest does for the LP path.
function composerSolve(item, rate, rateMode, cfg) {
  const { fuelItem, fertItem } = canonicalCarriers(db, cfg);
  cfg.canonical = { fuelItem, fertItem };
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

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { stamp: SERVER_STAMP, pid: process.pid, started: SERVER_STARTED });
    if (req.method === 'GET' && url.pathname === '/api/items') return send(res, 200, itemCatalog());
    if (req.method === 'POST' && url.pathname === '/api/solve') {
      return send(res, 200, await solveRequest(await readBody(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/dot') {
      const out = await solveRequest(await readBody(req));
      if (out.status !== 'Optimal') return send(res, 422, out);
      return send(res, 200, toDot(out.graph), 'text/plain');
    }
    if (req.method === 'POST' && url.pathname === '/api/mermaid') {
      const out = await solveRequest(await readBody(req));
      if (out.status !== 'Optimal') return send(res, 422, out);
      return send(res, 200, toMermaid(out.graph, assignClusters(out.graph)), 'text/plain');
    }
    // static files
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(WEB, path.normalize(rel));
      if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? 'application/octet-stream');
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status ?? 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`alchfact optimizer UI → http://localhost:${PORT}`);
  console.log(`dataset: ${db.gameVersion} (DB v${db.version}, ${db.date})`);
});
