'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../data/alchemy_db.json');
const { extractModules } = require('../src/rail-modules');
const { explore } = require('../src/rail-plan');

const body = (targets) => ({ item: targets[0].item, rate: targets[0].rate, rateMode: 'rate', targets, config: { solver: 'composer', maxTier: 6, cauldron: { enabled: true, inputPool: 'easy' }, composer: { priority: 'balanced' }, steam: { enabled: true, mode: 'cost' } } });

test('module extraction: belts stay inside modules, low-rate / shop / fuel / fert flows become wagon flows, liquids are pipes', () => {
  const res = extractModules(body([{ item: 'Healing Potion', rate: 60, rateMode: 'rate' }, { item: 'Vitality Potion', rate: 30, rateMode: 'rate' }]), db);
  assert.equal(res.status, 'Optimal');
  assert.ok(res.modules.length >= 2);
  // the potion line and its herb farm/powder chain are one belt module (360/min herb belts are never rail)
  const hp = res.modules.find((m) => m.members.includes('Healing Potion'));
  assert.ok(hp.members.includes('Sage Powder') && hp.members.includes('Sage'), hp.members.join(','));
  // shop deliveries are stock flows, fuel goes to boilers, fertilizer to the farm module
  assert.ok(res.flows.some((f) => f.to === 'shop' && f.item === 'Healing Potion' && f.kind === 'stock'));
  const all = [...res.flows, ...res.trickles];
  assert.ok(all.some((f) => f.to === 'boilers'), 'fuel flow to boilers exists (rail or trickle)');
  assert.ok(all.some((f) => f.item === 'Growth Potion' && f.kind === 'stock'));
  // liquids are piped, never wagon flows
  assert.ok(res.pipes.length > 0 && res.pipes.every((p) => db.items[p.item].liquid), 'pipes are exactly the liquid flows');
  assert.ok(!res.flows.some((f) => db.items[f.item] && db.items[f.item].liquid));
  // bought inputs are served by local portals by default (no wagon flow); 'hub' rails them
  assert.ok(res.localPortals.length > 0 && !res.flows.some((f) => f.from === 'portals'));
  const hub = extractModules(body([{ item: 'Healing Potion', rate: 60, rateMode: 'rate' }, { item: 'Vitality Potion', rate: 30, rateMode: 'rate' }]), db, { portals: 'hub' });
  assert.ok([...hub.flows, ...hub.trickles].some((f) => f.from === 'portals'));
  assert.ok(res.flows.every((f) => f.ratePerMin >= 1));
  for (const f of res.flows) if (f.ratePerMin * 10 < 100) assert.equal(f.kind, 'stock', JSON.stringify(f));
  // every flow endpoint is a plan module
  const ids = new Set(res.plan.modules.map((m) => m.id));
  for (const f of res.plan.flows) assert.ok(ids.has(f.from) && ids.has(f.to), `${f.from} → ${f.to}`);
});

test('the derived plan runs through the explorer and trunk-zones/shared feeds it', () => {
  const res = extractModules(body([{ item: 'Healing Potion', rate: 60, rateMode: 'rate' }]), db);
  const rows = explore(res.plan, { minutes: 60, combos: [['trunk-zones', 'shared']] });
  assert.equal(rows[0].fedPct, 100, JSON.stringify(rows[0]));
});
