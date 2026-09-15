#!/usr/bin/env node
// Run a rail scenario: node scripts/rail-sim.js scenarios/rail/trunk-tower.json [--minutes 60] [--speed 4] [--json]
'use strict';
const fs = require('fs');
const path = require('path');
const { simulate, formatReport } = require(path.join(__dirname, '..', 'src', 'rail'));
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/rail-sim.js <scenario.json> [--minutes N] [--speed U] [--json]'); process.exit(1); }
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));
const rep = simulate(scenario, { minutes: opt('minutes') ? Number(opt('minutes')) : undefined, params: opt('speed') ? { wagonSpeed: Number(opt('speed')) } : {} });
console.log(args.includes('--json') ? JSON.stringify(rep, null, 2) : formatReport(rep));
