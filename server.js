#!/usr/bin/env node
// Local visualization server (zero dependencies beyond `highs`).
//
//   node server.js [port]      → http://localhost:8347
//
// GET  /api/items              item catalog (names, buyability, cauldron data)
// POST /api/solve              { item, rate, config } → { summary, graph, explain }
// POST /api/dot                same body → Graphviz DOT text
//
// The solve itself lives in src/solve.js (shared with the CLI and the browser bundle); this
// file is just the HTTP shell + static file server for local dev. The static GitHub Pages
// build runs the same composer solve in-browser, so /api/solve is a dev-only convenience.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { solve, itemCatalog } = require('./src/solve');
const { toDot, toMermaid } = require('./src/flowgraph');
const { assignClusters } = require('./src/layout');
const db = require('./data/alchemy_db.v41.json');
const contracts = require('./data/contracts.json'); // Dispatch Portal contract data (per-item daily caps)

// Bump alongside web/app.js BUILD_STAMP. Surfaced at /api/version so a bug report can
// prove whether the browser and the running server agree on the code version.
const { gitStamp } = require('./scripts/build-stamp');
const SERVER_STAMP = gitStamp(); // git sha (+ -dirty), surfaced at /api/version
const SERVER_STARTED = new Date().toISOString();

const PORT = Number(process.argv[2] ?? 8347);
const WEB = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

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
    if (req.method === 'GET' && url.pathname === '/api/items') return send(res, 200, itemCatalog(db, contracts));
    if (req.method === 'POST' && url.pathname === '/api/solve') {
      return send(res, 200, await solve(await readBody(req), db));
    }
    if (req.method === 'POST' && url.pathname === '/api/dot') {
      const out = await solve(await readBody(req), db);
      if (out.status !== 'Optimal') return send(res, 422, out);
      return send(res, 200, toDot(out.graph), 'text/plain');
    }
    if (req.method === 'POST' && url.pathname === '/api/mermaid') {
      const out = await solve(await readBody(req), db);
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
