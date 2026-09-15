#!/usr/bin/env node
// Derive rail modules + flows from a production target set, then (optionally) explore topologies.
//   node scripts/rail-modules.js --targets "Healing Potion:60,Soap:60,Vitality Potion:30" --tier 6 [--rail-max 40] [--out plan.json] [--explore] [--priority balanced] [--no-steam]
//   node scripts/rail-modules.js --sellables --tier 6 [--rate 10] [--relic-rate 1] [--jewelry-rate 2]   # every sellable item at the tier
'use strict';
const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'data', 'alchemy_db.json'));
const { extractModules, formatModules } = require(path.join(__dirname, '..', 'src', 'rail-modules'));
const { explore, buildSheet } = require(path.join(__dirname, '..', 'src', 'rail-plan'));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const tier = Number(opt('tier', 6));
let targets;
if (args.includes('--sellables')) {
  const rate = Number(opt('rate', 10)), relic = Number(opt('relic-rate', 1)), jewel = Number(opt('jewelry-rate', 2));
  targets = Object.entries(db.items)
    .filter(([, i]) => i.sellPrice > 0 && i.tier <= tier && i.category !== 'Currency')
    .map(([item, i]) => ({ item, rate: i.category === 'Relic' ? relic : i.category === 'Jewelry' ? jewel : rate, rateMode: 'rate' }));
  console.log('targets:', targets.map((t) => `${t.item} ${t.rate}/min`).join(', '), '\n');
} else targets = String(opt('targets', 'Healing Potion:60')).split(',').map((s) => { const [item, r] = s.split(':'); return { item: item.trim(), rate: Number(r || 60), rateMode: 'rate' }; });
const config = { solver: 'composer', maxTier: tier, cauldron: { enabled: true, inputPool: opt('pool', 'easy') }, composer: { priority: opt('priority', 'balanced') }, steam: { enabled: !args.includes('--no-steam'), mode: 'cost' }, quarantine: { bankPortal: !args.includes('--no-mint') }, carriers: { fuel: opt('fuel', null), fert: opt('fert', null) } };
const res = extractModules({ item: targets[0].item, rate: targets[0].rate, rateMode: 'rate', targets, config }, db, { railMaxPerMin: Number(opt('rail-max', 40)) });
if (res.status !== 'Optimal') { console.error('composer:', res.status, res.error || ''); process.exit(1); }
console.log(formatModules(res));
if (opt('out')) { fs.writeFileSync(opt('out'), JSON.stringify(res.plan, null, 2) + '\n'); console.log('wrote', opt('out')); }
if (args.includes('--explore')) {
  const rows = explore(res.plan, { minutes: Number(opt('minutes', 120)), params: { warmupMin: Number(opt('warmup', 20)) } });
  const cols = ['template', 'fleet', 'loops', 'wagons', 'track', 'sharedTrack', 'stations', 'transfers', 'fedPct', 'worstStarvedPct', 'avgLoadedPct', 'maxLapSec'];
  console.log('\n' + cols.map((c) => c.padEnd(c === 'template' ? 13 : c === 'fleet' ? 8 : 13)).join(''));
  for (const r of rows) console.log(cols.map((c) => String(r[c] ?? '-').padEnd(c === 'template' ? 13 : c === 'fleet' ? 8 : 13)).join(''));
  const hub = rows.find((r) => r.template === 'hub-loops');
  if (hub && !args.includes('--no-sheet')) { console.log('\nbuild sheet (hub-loops):'); console.log(buildSheet(hub.scenario, hub.wagonsByLaunch)); }
}
