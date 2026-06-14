#!/usr/bin/env node
// CLI for the Alchemy Factory production optimizer.
//
//   node src/cli.js cost <item> [--rate N] [options]      min-cost plan for an item
//   node src/cli.js profit [options]                      max copper/min plan
//   node src/cli.js triple "A" "B" "C"                    resolve one cauldron triple
//   node src/cli.js machines <item> [--rate N] [options]  min integer machines for a target
//
// Options:
//   --rate N                 target rate per minute (default 1)
//   --config FILE            JSON config file (merged over defaults)
//   --no-cauldron            disable the cauldron formula block
//   --pool unrestricted|buyables   cauldron input pool
//   --pool-allow "A,B,C"     restrict cauldron inputs to a list
//   --pool-deny "A,B,C"      exclude items from the cauldron input pool
//   --forbid-cauldron "A,B"  never produce these items via cauldron
//   --force-cauldron "A,B"   these items may ONLY come via cauldron
//   --byproducts reuse|trash|sell   byproduct policy (default reuse)
//   --byproduct-trash "A,B"  per-item trash override (others keep global mode)
//   --no-self-fuel           fuel must be bought, not crafted
//   --no-self-fert           fertilizer must be bought, not crafted
//   --no-buy / --no-sell     disable purchase / sale columns
//   --machines N             machine count per type (default 50)
//   --machine-count "Cauldron=10,Athanor=5"  per-machine overrides
//   --skills "factory=4,alchemy=2,fuel=3,fertilizer=1,logistics=5"
//   --no-catalysts           disable Advanced Athanor catalyst variants
//   --json                   machine-readable output

'use strict';

const fs = require('fs');
const { resolveConfig } = require('./config');
const { buildProcessTable } = require('./normalize');
const { Model, optimize, minMachines, probeInfeasibility } = require('./model');
const { explain } = require('./explain');
const { resolveTriple } = require('./cauldron');
const { buildFlowGraph } = require('./flowgraph');
const { renderSvg } = require('./svg');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const flagOnly = ['no-cauldron', 'no-self-fuel', 'no-self-fert', 'no-buy', 'no-sell', 'no-catalysts', 'json', 'vertical'];
    if (flagOnly.includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function parseKv(s) {
  const out = {};
  for (const pair of splitList(s)) {
    const [k, v] = pair.split('=');
    out[k.trim()] = Number(v);
    if (Number.isNaN(out[k.trim()])) throw new Error(`bad number in "${pair}"`);
  }
  return out;
}

function configFromArgs(args) {
  const base = args.config ? JSON.parse(fs.readFileSync(args.config, 'utf8')) : {};
  const o = structuredClone(base);
  o.cauldron ??= {};
  o.byproducts ??= {};
  o.machines ??= {};
  if (args['no-cauldron']) o.cauldron.enabled = false;
  if (args.pool) o.cauldron.inputPool = args.pool;
  if (args['pool-allow']) o.cauldron.inputPool = { allow: splitList(args['pool-allow']) };
  if (args['pool-deny']) o.cauldron.inputPool = { deny: splitList(args['pool-deny']) };
  if (args['forbid-cauldron']) o.cauldron.forbidFor = splitList(args['forbid-cauldron']);
  if (args['force-cauldron']) o.cauldron.forceFor = splitList(args['force-cauldron']);
  if (args.byproducts) o.byproducts.mode = args.byproducts;
  if (args['byproduct-trash']) {
    o.byproducts.perItem = Object.fromEntries(splitList(args['byproduct-trash']).map((i) => [i, 'trash']));
  }
  if (args['no-self-fuel']) o.selfFuel = false;
  if (args['no-self-fert']) o.selfFert = false;
  if (args['no-buy']) o.buy = false;
  if (args['no-sell']) o.sell = false;
  if (args['max-tier']) o.maxTier = Number(args['max-tier']);
  if (args.belt) o.belt = splitList(args.belt).map((item) => ({ item }));
  if (args.machines) o.machines.defaultCount = Number(args.machines);
  if (args['machine-count']) o.machines.counts = parseKv(args['machine-count']);
  if (args.skills) o.skills = { ...o.skills, ...parseKv(args.skills) };
  if (args['no-catalysts']) o.catalysts = { ...(o.catalysts ?? {}), enabled: false };
  return resolveConfig(o);
}

function findItem(db, name) {
  if (db.items[name]) return name;
  const lower = name.toLowerCase();
  const match = Object.keys(db.items).find((n) => n.toLowerCase() === lower);
  if (match) return match;
  const partial = Object.keys(db.items).filter((n) => n.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  throw new Error(`unknown item "${name}"${partial.length ? ` — did you mean: ${partial.slice(0, 5).join(', ')}?` : ''}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, ...rest] = args._;
  const db = require('../data/alchemy_db.v41.json');

  if (!command || command === 'help') {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 31).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }

  if (command === 'triple') {
    const names = rest.map((n) => findItem(db, n));
    if (names.length !== 3) throw new Error('triple needs exactly 3 item names');
    const r = resolveTriple(db, names);
    console.log(args.json ? JSON.stringify(r, null, 2)
      : `${names.join(' + ')} → ${r.output} (T=${r.T}, ratio ${r.ratio}, distance ${r.distance}` +
        `${r.exactTie ? ', EXACT TIE → id rule' : r.margin !== null ? `, margin ${r.margin} over ${r.runnerUp}` : ''}) — ${r.time}s, ${r.heat} heat`);
    return;
  }

  const cfg = configFromArgs(args);
  const pt = buildProcessTable(db, cfg);
  for (const w of pt.warnings) console.error(`note: ${w}`);
  const model = new Model(pt, db);

  if (command === 'cost' || command === 'machines') {
    const item = findItem(db, rest.join(' '));
    const rate = Number(args.rate ?? 1);
    const demand = { [item]: rate };
    const result = await optimize(model, { demand, objective: 'cost' });
    if (result.status === 'Infeasible') {
      const probe = await probeInfeasibility(model, demand, 'cost');
      if (args.json) { console.log(JSON.stringify({ status: 'Infeasible', probe }, null, 2)); return; }
      console.log(`INFEASIBLE: ${probe.detail}`);
      if (probe.needed) {
        for (const n of probe.needed) console.log(`  ${n.machine}: need ~${n.needed}, configured ${n.configured}`);
        console.log('Raise --machines or --machine-count.');
      }
      process.exitCode = 2;
      return;
    }
    if (result.status !== 'Optimal') {
      console.log(`Solve failed: ${result.status}`);
      process.exitCode = 1;
      return;
    }

    if (command === 'machines') {
      const mm = await minMachines(model, result, { demand, slotWeighted: false });
      if (args.json) { console.log(JSON.stringify(mm, null, 2)); return; }
      console.log(`Minimum machines for ${item} @ ${rate}/min (cost-optimal routing): ${mm.totalMachines}`);
      for (const m of mm.machines.sort((a, b) => b.count - a.count)) console.log(`  ${m.count}× ${m.machine}  — ${m.process}`);
      return;
    }

    if (args.json) {
      console.log(JSON.stringify({
        status: result.status,
        copperPerMinute: result.objective,
        copperPerItem: result.objective / rate,
        cgRounds: result.rounds,
        flows: result.flows.map((f) => ({ id: f.process.id, kind: f.process.kind, rate: f.rate, consumes: f.process.consumes, produces: f.process.produces, flags: f.process.flags })),
      }, null, 2));
      return;
    }
    console.log(`${item} @ ${rate}/min — ${result.objective.toFixed(1)} g/min (${(result.objective / rate).toFixed(1)} g/item)`);
    console.log(`[CG: ${result.rounds} round(s), ${result.admittedCauldron ?? 0} cauldron columns in master]`);
    console.log('');
    console.log(explain(result, demand));
    return;
  }

  if (command === 'svg') {
    const item = findItem(db, rest.join(' '));
    const rate = Number(args.rate ?? 1);
    const demand = { [item]: rate };
    const result = await optimize(model, { demand, objective: 'cost' });
    if (result.status !== 'Optimal') { console.error(`cannot render: ${result.status}`); process.exit(2); }
    const graph = buildFlowGraph(result, model, demand);
    const orientation = args.vertical ? 'TB' : 'LR';
    const svg = renderSvg(graph, { title: `${item} @ ${rate}/min — ${result.objective.toFixed(0)} g/min`, orientation });
    const outPath = args.out ?? `${item.replace(/\s+/g, '_')}.svg`;
    fs.writeFileSync(outPath, svg);
    console.error(`wrote ${outPath} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
    return;
  }

  if (command === 'profit') {
    const result = await optimize(model, { objective: 'profit' });
    if (result.status !== 'Optimal') { console.log(`Solve failed: ${result.status}`); process.exitCode = 1; return; }
    if (args.json) {
      console.log(JSON.stringify({ status: result.status, copperPerMinute: result.objective, flows: result.flows.map((f) => ({ id: f.process.id, rate: f.rate })) }, null, 2));
      return;
    }
    console.log(`Max profit: ${result.objective.toFixed(1)} g/min`);
    console.log(explain(result, {}));
    return;
  }

  throw new Error(`unknown command "${command}" — try: cost, profit, machines, triple, help`);
}

main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
