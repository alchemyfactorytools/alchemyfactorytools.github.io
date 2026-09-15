// Module extraction: composer build → belt-vs-rail cut → modules + flows → rail-plan input.
//
// The composer graph gives every item flow with its rate. Rule of thumb encoded here: belts
// stay INSIDE a module when the flow is high-rate and point-to-point; a flow becomes a wagon
// flow (a module boundary) when it is low-rate, fans out from a shared producer, feeds the shop
// or the boilers, or is fertilizer to farms. Liquids are pipes and never cut. Modules are the
// connected components of the belt edges; each gets a floor by a simple rule (farms and
// extractors on tower floors, shop on 1, everything else on the trunk floor) that the caller
// can override per item.

'use strict';

const { solveComposerBody } = require('./composer-solve');

const itemOf = (label) => String(label || '').split(' ⬅ ')[0];

function extractModules(body, db, opts = {}) {
  const railMax = opts.railMaxPerMin ?? 40;       // flows at or below this rate are wagon-worthy
  const maxFullLoadWaitMin = opts.maxFullLoadWaitMin ?? 10; // slower than a pack per this many minutes → ship partial loads
  const minRailRate = opts.minRailRatePerMin ?? 1;           // slower than this is a trickle: hand-stock a chest, no wagon flow
  // Purchasing Portals can be placed anywhere, so bought inputs are LOCAL by default: a portal at
  // the consuming module with a coin chest, no wagon flow. 'hub' rails the goods from one portal
  // bank instead (one flow per bought item per module).
  const portals = opts.portals || 'local';
  const packSize = (opts.params && opts.params.packSize) || 100;
  const floorOf = opts.floorOf || {};             // item → floor override
  const out = solveComposerBody(body, db);
  if (out.status !== 'Optimal') return { status: out.status, error: out.error || (out.probe && out.probe.detail) };
  const g = out.graph;
  const isLiquid = (it) => !!(db.items[it] && db.items[it].liquid);

  // item-level nodes: machines per produced item
  const items = new Map(); // item → { machines: {name: count}, sources: Set }
  const nodeItem = new Map();
  for (const n of g.nodes) {
    if (n.type === 'process') {
      const it = itemOf(n.label);
      nodeItem.set(n.id, it);
      if (!items.has(it)) items.set(it, { machines: {} });
      if (n.machine && n.machineCount) items.get(it).machines[n.machine] = (items.get(it).machines[n.machine] || 0) + n.machineCount;
    } else if (n.type === 'external') nodeItem.set(n.id, n.kind === 'purchase' ? 'portals' : n.kind === 'belt' ? `belt:${(n.label || '').replace(/^Main belt: /, '')}` : 'money');
    else if (n.type === 'demand') nodeItem.set(n.id, 'shop');
    else nodeItem.set(n.id, null);
  }

  // aggregate edges by (from item, to item, item, kind)
  const agg = new Map();
  for (const e of g.edges) {
    if (e.cash) continue;
    const a = nodeItem.get(e.from), b = nodeItem.get(e.to);
    if (!a || !b || a === 'money') continue;
    const kind = e.heat ? 'fuel' : e.nutrient ? 'fert' : 'material';
    const to = kind === 'fuel' ? 'boilers' : b; // under steam every fuel edge is boiler demand
    const key = `${a}|${to}|${e.item}|${kind}`;
    if (!agg.has(key)) agg.set(key, { from: a, to, item: e.item, kind, ratePerMin: 0 });
    agg.get(key).ratePerMin += e.ratePerMin;
  }

  // decide belt / rail / pipe
  const producersOfConsumer = new Map();
  for (const f of agg.values()) { if (!producersOfConsumer.has(f.from)) producersOfConsumer.set(f.from, new Set()); producersOfConsumer.get(f.from).add(f.to); }
  const cut = [];
  const belt = [];
  const pipes = [];
  const localPortals = []; // bought inputs served by a portal AT the module
  for (const f of agg.values()) {
    if (isLiquid(f.item)) { pipes.push(f); continue; }
    const fanOut = (producersOfConsumer.get(f.from) || new Set()).size > 1;
    let reason = null;
    if (f.to === 'shop') reason = 'to shop';
    else if (f.to === 'boilers') reason = 'fuel to boilers';
    else if (f.kind === 'fert') reason = 'fertilizer to farms';
    else if (f.from === 'portals') { if (portals === 'hub' && f.ratePerMin <= railMax) reason = 'bought, low rate'; else { localPortals.push(f); continue; } }
    else if (f.from.startsWith('belt:')) reason = 'main-belt supply';
    else if (f.ratePerMin <= railMax && fanOut) reason = 'shared producer, low rate';
    // a low-rate flow between two otherwise private modules stays a belt: rail is for distance
    // and fan-out, not for small numbers
    if (reason) cut.push({ ...f, reason }); else belt.push(f);
  }

  // modules = components of belt edges over item nodes (+ isolated items)
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const it of items.keys()) find(it);
  for (const f of belt) if (f.from !== 'portals' && !f.from.startsWith('belt:') && f.to !== 'shop' && f.to !== 'boilers') union(f.from, f.to);
  const members = new Map();
  for (const it of items.keys()) { const r = find(it); if (!members.has(r)) members.set(r, []); members.get(r).push(it); }
  // name a module by its most-downstream member (the one nothing else in the module feeds), else the root
  const modOf = new Map();
  const modules = [];
  for (const [root, mem] of members) {
    const fedInside = new Set(belt.filter((f) => mem.includes(f.from) && mem.includes(f.to)).map((f) => f.from));
    const head = mem.find((m) => !fedInside.has(m)) || root;
    const machines = {};
    for (const m of mem) for (const [k, v] of Object.entries(items.get(m).machines)) machines[k] = (machines[k] || 0) + v;
    // name the module by its biggest tile (what you'd see on the floor), with the head product as a suffix
    const count = (m) => Object.values(items.get(m).machines).reduce((a, b) => a + b, 0);
    const biggest = [...mem].sort((a, b) => count(b) - count(a))[0];
    const id = (biggest === head || mem.length === 1 ? head : `${biggest}+${head}`).replace(/\s+/g, '_');
    const grower = mem.some((m) => /Nursery|Seed Plot|Extractor|World Tree/.test(Object.keys(items.get(m).machines).join(' ')));
    const floor = floorOf[head] ?? (grower ? 2 : 0);
    modules.push({ id, head, floor, members: mem, machines });
    for (const m of mem) modOf.set(m, id);
  }
  modOf.set('portals', 'portals'); modOf.set('shop', 'shop'); modOf.set('boilers', 'boilers');
  for (const f of cut) if (f.from.startsWith('belt:')) modOf.set(f.from, f.from);
  const extra = [{ id: 'portals', floor: floorOf.portals ?? 0 }, { id: 'shop', floor: floorOf.shop ?? 1 }, { id: 'boilers', floor: floorOf.boilers ?? 0 }];
  for (const f of cut) if (f.from.startsWith('belt:')) extra.push({ id: f.from, floor: 0 });

  // flows between modules (merge same item + endpoints)
  const flowMap = new Map();
  for (const f of cut) {
    const from = modOf.get(f.from), to = modOf.get(f.to);
    if (!from || !to || from === to) continue;
    const key = `${from}|${to}|${f.item}`;
    if (!flowMap.has(key)) flowMap.set(key, { from, to, item: f.item, ratePerMin: 0, kind: f.to === 'shop' || f.kind === 'fert' ? 'stock' : 'freight', reasons: new Set() });
    flowMap.get(key).ratePerMin += f.ratePerMin; flowMap.get(key).reasons.add(f.reason);
  }
  // a freight flow too slow to fill a pack within maxFullLoadWaitMin ships partial loads instead
  for (const f of flowMap.values()) if (f.kind === 'freight' && f.ratePerMin * maxFullLoadWaitMin < packSize) { f.kind = 'stock'; f.reasons.add('too slow for full loads'); }
  const all = [...flowMap.values()].map((f) => ({ ...f, ratePerMin: +f.ratePerMin.toFixed(2), reasons: [...f.reasons] }));
  const trickles = all.filter((f) => f.ratePerMin < minRailRate);
  const flows = all.filter((f) => f.ratePerMin >= minRailRate);
  const used = new Set(flows.flatMap((f) => [f.from, f.to]));
  const planModules = [...modules.map((m) => ({ id: m.id, floor: m.floor })), ...extra].filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i && (used.has(m.id) || modules.some((x) => x.id === m.id)));
  const plan = { params: opts.params || {}, geometry: opts.geometry, modules: planModules, flows: flows.map(({ reasons, ...f }) => f) };
  // local portal placements per module with the copper they draw
  const portalsAt = new Map();
  for (const f of localPortals) {
    const mod = modOf.get(f.to) || f.to;
    if (!portalsAt.has(mod)) portalsAt.set(mod, { module: mod, items: [], copperPerMin: 0 });
    const p = portalsAt.get(mod);
    p.items.push({ item: f.item, ratePerMin: +f.ratePerMin.toFixed(2) });
    p.copperPerMin += f.ratePerMin * ((db.items[f.item] && db.items[f.item].buyPrice) || 0);
  }
  const localPortalList = [...portalsAt.values()].map((p) => ({ ...p, copperPerMin: Math.round(p.copperPerMin) }));
  return { status: 'Optimal', modules, flows, trickles, pipes, localPortals: localPortalList, beltFlows: belt, plan, summary: g.summary };
}

function formatModules(res) {
  const out = [];
  out.push('modules (belt-connected tiles):');
  for (const m of res.modules) out.push(`  ${m.id.padEnd(24)} floor ${m.floor}  ${Object.entries(m.machines).sort((a, b) => b[1] - a[1]).map(([k, v]) => v + '× ' + k).join(', ')}${m.members.length > 1 ? `  [${m.members.join(', ')}]` : ''}`);
  const total = res.modules.reduce((a, m) => a + Object.values(m.machines).reduce((x, y) => x + y, 0), 0);
  out.push(`  total production machines: ${total}`);
  out.push('wagon flows (module boundaries):');
  for (const f of res.flows) out.push(`  ${f.from.padEnd(22)} → ${f.to.padEnd(14)} ${f.item.padEnd(22)} ${String(f.ratePerMin).padStart(7)}/min  ${f.kind.padEnd(7)} (${f.reasons.join('; ')})`);
  if (res.localPortals && res.localPortals.length) {
    out.push('local purchasing portals (coin chest at the module; silver/min to keep it fed):');
    for (const p of res.localPortals) out.push(`  ${p.module.padEnd(28)} ${p.items.map((i) => `${i.item} ${i.ratePerMin}/min`).join(', ').padEnd(70)} ${(p.copperPerMin / 1000).toFixed(2)} s/min`);
  }
  if (res.trickles.length) out.push('trickles (hand-stock a chest, below 1/min): ' + res.trickles.map((f) => `${f.item} → ${f.to} ${f.ratePerMin}/min`).join('; '));
  if (res.pipes.length) out.push('pipes: ' + [...new Set(res.pipes.map((p) => p.item))].join(', '));
  return out.join('\n');
}

module.exports = { extractModules, formatModules };
