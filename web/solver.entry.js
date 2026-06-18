'use strict';
// esbuild entry → web/solver.bundle.js (IIFE exposing a global `AlchSolver`). It bundles ONLY
// the browser-safe composer core + the graph/cluster/export helpers + the dataset JSON, so the
// WASM LP solver (model.js → highs) never enters the static build. app.js calls these in place
// of fetch('/api/*'), which makes the dev server and the GitHub Pages build behave identically
// for the composer path. The dataset JSONs are inlined into the bundle by esbuild.

const { itemCatalog, solveComposerBody } = require('../src/composer-solve');
const { toDot, toMermaid } = require('../src/flowgraph');
const { assignClusters } = require('../src/layout');
const { graphToIR } = require('../src/tile-ir');
const { composeTilesIR } = require('../src/tile-compose-ir');
const { beltSpeed } = require('../src/config');
const db = require('../data/alchemy_db.v41.json');
const contracts = require('../data/contracts.json');

module.exports = {
  // Item catalog for the picker (same shape the old GET /api/items returned).
  itemCatalog: () => itemCatalog(db, contracts),
  // Composer solve, in-browser. Same response envelope the server's POST /api/solve produced.
  solve: (body) => solveComposerBody(body, db),
  // Export helpers — operate on an already-solved graph (no re-solve needed).
  toDot: (graph) => toDot(graph),
  toMermaid: (graph) => toMermaid(graph, assignClusters(graph)),
  // Clustering used by app.js's splitBaseGoods/collapse (byte-identical to the old web/layout.js
  // AlchLayout.assignClusters, since web/layout.js was a copy of src/layout.js). Returns
  // { clusterOf, clusters }.
  assignClusters: (graph) => assignClusters(graph),
  // Tile-DAG IR (solver-owned structure) for the experimental ?pipeline=tiles renderer.
  graphToIR: (graph) => graphToIR(graph),
  // Level-2 canonical belt-sized stamped-tile IR (?pipeline=tiles2). Needs the build config to do
  // standalone per-item solves for the canonical units; injects the in-browser composer as `solve`.
  composeTilesIR: (graph, config) => composeTilesIR(graph, { solve: (body) => solveComposerBody(body, db), config: config || {}, mode: 'hybrid' }),
  // Belt throughput (items/min one belt carries) at a given Logistics level — used by the belt
  // supply editor so a blank rate means "one full belt at current skills" instead of unlimited.
  beltSpeed: (logisticsLvl) => beltSpeed(logisticsLvl || 0),
  db,
};
