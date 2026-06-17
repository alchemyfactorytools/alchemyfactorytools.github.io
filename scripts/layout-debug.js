#!/usr/bin/env node
'use strict';
// Layout geometry debugger. Feed it a request config (the SAME JSON the web app's "Copy settings"
// button produces) and it solves the build, runs the layout3 engine with the production render
// constants, and dumps every geometric primitive the layout produces — node positions, edge
// endpoints (incl. the self-feed side-rail `bulge`/`bulgeY`), trunks, cluster boxes — plus a
// crossing report that samples each drawn edge's bezier and flags the node rectangles it passes
// through. This is the offline stand-in for eyeballing the SVG when the browser isn't handy.
//
// Usage:
//   node scripts/layout-debug.js <request.json>          # human-readable dump
//   pbpaste | node scripts/layout-debug.js -             # read the copied settings from stdin
//   node scripts/layout-debug.js req.json --json         # full machine-readable JSON
//   node scripts/layout-debug.js req.json --crossings    # only the crossing report
//   flags: --orientation TB|LR  --util trunk|all|off  --no-clusters  --node-w N  --node-h N
//
// Input accepts either a bare request body ({ item, rate, targets, config }) OR the whole
// "Copy settings" envelope ({ clientStamp, serverStamp, request: {...} }) — the `request` is
// unwrapped automatically.

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { solveComposerBody } = require(path.join(ROOT, 'src/composer-solve'));
const db = require(path.join(ROOT, 'data/alchemy_db.v41.json'));
const ENGINE = require(path.join(ROOT, 'web/layout3.js'));

// ---------- args ----------
const argv = process.argv.slice(2);
const opts = { orientation: 'TB', util: 'trunk', clusters: true, nodeW: 260, nodeH: 84, json: false, crossingsOnly: false };
let src = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--json') opts.json = true;
  else if (a === '--crossings') opts.crossingsOnly = true;
  else if (a === '--no-clusters') opts.clusters = false;
  else if (a === '--orientation') opts.orientation = argv[++i];
  else if (a === '--util') opts.util = argv[++i];
  else if (a === '--node-w') opts.nodeW = Number(argv[++i]);
  else if (a === '--node-h') opts.nodeH = Number(argv[++i]);
  else if (!src) src = a;
}
if (!src) {
  console.error('usage: node scripts/layout-debug.js <request.json|-> [--json] [--crossings] [--orientation TB|LR] [--util trunk|all|off] [--no-clusters]');
  process.exit(2);
}

// ---------- load request ----------
const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
let body;
try { body = JSON.parse(raw); } catch (e) { console.error('input is not valid JSON:', e.message); process.exit(2); }
if (body && body.request && typeof body.request === 'object') body = body.request; // unwrap "Copy settings" envelope

// ---------- solve + layout ----------
const out = solveComposerBody(body, db);
if (out.status !== 'Optimal' || !out.graph) {
  console.error(`solve did not produce a graph: status=${out.status}${out.error ? ' — ' + out.error : ''}${out.probe ? ' — ' + out.probe.detail : ''}`);
  process.exit(1);
}
const NODE_W = opts.nodeW, NODE_H = opts.nodeH;
const L = ENGINE.layout(out.graph, { nodeW: NODE_W, nodeH: NODE_H, orientation: opts.orientation, clusters: opts.clusters, utilEdges: opts.util });

// ---------- geometry helpers ----------
const ekey = (e) => e.from + '\t' + e.to;
const isSupport = (e) => !!(e.heat || e.nutrient || e.cash);
const supportKind = (e) => (e.heat ? 'heat' : e.nutrient ? 'nutrient' : e.cash ? 'cash' : '');
const isTrunked = (e) => L.trunkedEdges && L.trunkedEdges.has(ekey(e));

// Reconstruct the cubic-bezier control points exactly as layout3.edgePath does, so the sampled
// curve matches what the renderer draws (incl. the side-rail bulge variants).
function ctrl(eo) {
  const { start: s, end: t } = eo;
  if (opts.orientation === 'TB') {
    if (eo.bulge != null) return [{ x: eo.bulge, y: s.y }, { x: eo.bulge, y: t.y }];
    const dy = (t.y - s.y) * 0.5; return [{ x: s.x, y: s.y + dy }, { x: t.x, y: t.y - dy }];
  }
  if (eo.bulgeY != null) return [{ x: s.x, y: eo.bulgeY }, { x: t.x, y: eo.bulgeY }];
  const dx = (t.x - s.x) * 0.5; return [{ x: s.x + dx, y: s.y }, { x: t.x - dx, y: t.y }];
}
function sample(eo, n = 60) {
  const { start: s, end: t } = eo; const [c1, c2] = ctrl(eo); const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, m = 1 - u;
    pts.push({
      x: m * m * m * s.x + 3 * m * m * u * c1.x + 3 * m * u * u * c2.x + u * u * u * t.x,
      y: m * m * m * s.y + 3 * m * m * u * c1.y + 3 * m * u * u * c2.y + u * u * u * t.y,
    });
  }
  return pts;
}
// node rects a drawn edge's curve passes through (excluding its own endpoints)
function crossings(e, eo) {
  const pts = sample(eo); const hits = [];
  for (const [id, p] of L.pos) {
    if (id === e.from || id === e.to) continue;
    if (pts.some((q) => q.x >= p.x && q.x <= p.x + NODE_W && q.y >= p.y && q.y <= p.y + NODE_H)) hits.push(id);
  }
  return hits;
}
const r = (n) => Math.round(n);
const xy = (p) => p ? `(${r(p.x)},${r(p.y)})` : '—';

// ---------- machine-readable dump ----------
if (opts.json) {
  const nodes = [...L.pos.entries()].map(([id, p]) => ({ id, x: p.x, y: p.y, w: p.w, h: p.h }));
  const edges = out.graph.edges.map((e) => {
    const eo = L.edges.get(ekey(e));
    return {
      from: e.from, to: e.to, item: e.item, ratePerMin: e.ratePerMin,
      kind: isSupport(e) ? supportKind(e) : 'material', trunked: isTrunked(e),
      start: eo ? eo.start : null, end: eo ? eo.end : null,
      bulge: eo && eo.bulge != null ? eo.bulge : undefined, bulgeY: eo && eo.bulgeY != null ? eo.bulgeY : undefined,
      crossings: eo && !isTrunked(e) ? crossings(e, eo) : [],
    };
  });
  console.log(JSON.stringify({
    status: out.status, size: { width: L.width, height: L.height }, opts,
    nodes, edges, trunks: L.trunks, clusterBoxes: L.clusters,
  }, null, 2));
  process.exit(0);
}

// ---------- crossing report (always; the rest is suppressed by --crossings) ----------
function crossingReport() {
  console.log('\n## CROSSINGS (drawn edges whose curve overlaps a node rect)');
  let total = 0, drawn = 0;
  const rows = [];
  for (const e of out.graph.edges) {
    if (isTrunked(e)) continue;                 // rendered as a clean trunk, not a bezier
    const eo = L.edges.get(ekey(e)); if (!eo) continue;
    drawn++;
    const hits = crossings(e, eo);
    total += hits.length;
    if (hits.length) rows.push({ e, eo, hits });
  }
  console.log(`drawn edges: ${drawn}   total node-crossings: ${total}`);
  for (const { e, eo, hits } of rows.sort((a, b) => b.hits.length - a.hits.length)) {
    const rail = eo.bulge != null ? ` rail@${r(eo.bulge)}` : eo.bulgeY != null ? ` rail@y${r(eo.bulgeY)}` : '';
    console.log(`  [${isSupport(e) ? supportKind(e) : 'material'}]${rail} ${e.from} → ${e.to}`);
    console.log(`      crosses ${hits.length}: ${hits.join(', ')}`);
  }
}

if (opts.crossingsOnly) { crossingReport(); process.exit(0); }

// ---------- full human-readable dump ----------
console.log(`# layout-debug  ${src === '-' ? '(stdin)' : src}`);
console.log(`targets: ${out.targets.map((t) => `${t.item}@${t.rate}`).join(', ')}`);
console.log(`opts: orientation=${opts.orientation} util=${opts.util} clusters=${opts.clusters} node=${NODE_W}x${NODE_H}`);
console.log(`canvas: ${r(L.width)} x ${r(L.height)}   nodes=${L.pos.size} edges=${out.graph.edges.length} trunks=${(L.trunks || []).length} boxes=${(L.clusters || []).length}`);

console.log('\n## NODES (id @ x,y  w×h)');
for (const [id, p] of [...L.pos.entries()].sort((a, b) => a[1].y - b[1].y || a[1].x - b[1].x)) {
  console.log(`  ${xy(p)}  ${r(p.w)}×${r(p.h)}  ${id}`);
}

console.log('\n## EDGES (start → end ; rail ; trunked)');
for (const e of out.graph.edges) {
  const eo = L.edges.get(ekey(e));
  const kind = isSupport(e) ? supportKind(e) : 'mat';
  const rail = eo && eo.bulge != null ? ` bulge=${r(eo.bulge)}` : eo && eo.bulgeY != null ? ` bulgeY=${r(eo.bulgeY)}` : '';
  const tr = isTrunked(e) ? ' [TRUNKED]' : '';
  console.log(`  [${kind}] ${eo ? xy(eo.start) + ' → ' + xy(eo.end) : '(no geom)'}${rail}${tr}  ${e.from} → ${e.to}  (${e.item} ${r(e.ratePerMin)}/min)`);
}

console.log('\n## TRUNKS (source → line-box, aggregated util/cash)');
for (const t of L.trunks || []) {
  console.log(`  [${t.heat ? 'heat' : t.cash ? 'cash' : 'fert'}] ${xy(t.start)} → ${xy(t.end)}  ${t.from} → ${t.toKey}  (${t.item} ${r(t.ratePerMin)}/min, ${t.tos.length} consumers)`);
}

console.log('\n## CLUSTER BOXES (x,y  w×h  key)');
for (const b of L.clusters || []) {
  console.log(`  (${r(b.x)},${r(b.y)})  ${r(b.w)}×${r(b.h)}  ${b.belt ? '[belt] ' : b.util ? '[util] ' : ''}${b.label || ''}  key=${b.key != null ? b.key : '—'}`);
}

crossingReport();
