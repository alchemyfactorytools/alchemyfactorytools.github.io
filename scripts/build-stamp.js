'use strict';
// Build identifier = git short SHA (+ "-dirty" when the working tree has uncommitted changes), so
// the version surfaced in the UI footer / "Copy settings" / /api/version reflects exactly the commit
// that produced the build. Used by: build-static.js (writes dist/build-stamp.js for the deploy),
// `npm run build:bundle` (writes web/build-stamp.js for local dev), and server.js (SERVER_STAMP).
// Falls back to "unknown" outside a git checkout.
const { execSync } = require('node:child_process');

function gitStamp() {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ? '-dirty' : '';
    return (sha || 'unknown') + dirty;
  } catch {
    return 'unknown';
  }
}

module.exports = { gitStamp };

// Run directly → emit a tiny browser stamp file: `window.__BUILD__ = "<sha>";`
if (require.main === module) {
  const fs = require('node:fs');
  fs.writeFileSync(process.argv[2] || 'web/build-stamp.js', `window.__BUILD__ = ${JSON.stringify(gitStamp())};\n`);
}
