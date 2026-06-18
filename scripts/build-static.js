#!/usr/bin/env node
'use strict';
// Assemble the static GitHub Pages build into dist/: the in-browser solver bundle + the web
// assets (index.html, app.js, layout3.js, style.css) + a .nojekyll marker so Pages serves the
// files verbatim. No server and no /api — the tile composer runs entirely in the browser, so
// `dist/` is fully self-contained and can be served by any static host.
//
//   npm run build        → regenerates dist/ from scratch
//
// (The LP optimizer's WASM solver is not bundled yet; the static build ships the composer only.)

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { gitStamp } = require('./build-stamp');

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const dist = path.join(root, 'dist');

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1) Bundle the browser solver (composer core + graph/export helpers + dataset JSON). Minified
//    for shipping. esbuild inlines the JSON and resolves the CommonJS src/ modules; highs/WASM
//    never enters the graph because solver.entry.js imports composer-solve.js, not solve.js.
esbuild.buildSync({
  entryPoints: [path.join(web, 'solver.entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'AlchSolver',
  platform: 'browser',
  outfile: path.join(dist, 'solver.bundle.js'),
  minify: true,
});

// 2) Copy the static front-end assets verbatim. render-ir.js is the default tile-IR renderer —
// without it app.js silently falls back to the layout3 path, so it MUST ship.
for (const f of ['index.html', 'style.css', 'layout3.js', 'render-ir.js', 'app.js']) {
  fs.copyFileSync(path.join(web, f), path.join(dist, f));
}

// 2b) Build id (git sha) — the footer / "Copy settings" read it via window.__BUILD__.
fs.writeFileSync(path.join(dist, 'build-stamp.js'), `window.__BUILD__ = ${JSON.stringify(gitStamp())};\n`);

// 3) .nojekyll so GitHub Pages serves the assets as-is (no Jekyll build step).
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

const kb = (p) => (fs.statSync(p).size / 1024).toFixed(1) + 'kb';
console.log('built dist/:');
for (const f of fs.readdirSync(dist).sort()) console.log('  ' + f.padEnd(20) + kb(path.join(dist, f)));
