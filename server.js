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
const { assignClusters } = require('./src/layout');
const { explain } = require('./src/explain');
const db = require('./data/alchemy_db.v41.json');

// Bump alongside web/app.js BUILD_STAMP. Surfaced at /api/version so a bug report can
// prove whether the browser and the running server agree on the code version.
const SERVER_STAMP = 'tile-self-contained-replication-2026-06-14v';
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
  cfg.buildability = 0; // scaled below, relative to THIS build's own cost (see the probe)
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
