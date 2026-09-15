#!/usr/bin/env node
// Compare rail topologies for a factory plan:
//   node scripts/rail-explore.js scenarios/rail/plan-tier6.json [--minutes 90] [--speed 4] [--emit single-loop:shared out.json] [--detail trunk-zones:perFlow]
'use strict';
const fs = require('fs');
const path = require('path');
const { explore } = require(path.join(__dirname, '..', 'src', 'rail-plan'));
const { formatReport } = require(path.join(__dirname, '..', 'src', 'rail'));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/rail-explore.js <plan.json> [--minutes N] [--speed U] [--emit template:fleet out.json] [--detail template:fleet]'); process.exit(1); }
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
const results = explore(plan, { minutes: opt('minutes') ? Number(opt('minutes')) : 90, params: opt('speed') ? { wagonSpeed: Number(opt('speed')) } : {} });
const cols = ['template', 'fleet', 'loops', 'launchesPerLoop', 'wagons', 'track', 'stations', 'transfers', 'fedPct', 'worstStarvedPct', 'blockedLoaders', 'avgLoadedPct', 'maxLapSec'];
console.log(cols.map((c) => c.padEnd(c === 'template' ? 13 : c === 'fleet' ? 8 : 15)).join(''));
for (const r of results) console.log(cols.map((c) => String(r[c]).padEnd(c === 'template' ? 13 : c === 'fleet' ? 8 : 15)).join(''));
const pick = (key) => { const [t, f] = key.split(':'); return results.find((r) => r.template === t && r.fleet === f); };
if (opt('detail')) { const r = pick(opt('detail')); if (r) { console.log('\nwagons by launch:', JSON.stringify(r.wagonsByLaunch)); console.log(formatReport(r.report)); } }
if (opt('emit')) { const i = args.indexOf('--emit'); const r = pick(args[i + 1]); if (r) { fs.writeFileSync(args[i + 2], JSON.stringify({ ...r.scenario, params: plan.params || {} }, null, 2) + '\n'); console.log('wrote', args[i + 2]); } }
