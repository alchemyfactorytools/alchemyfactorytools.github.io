// Route-tree explanation layer (DESIGN.md §3.7).
//
// Decomposes the optimal flow vector into a per-item production attribution:
// for each item, which processes supply it and at what share. Cycles are
// detected and rendered as loop annotations instead of infinite trees.
// Self-consuming cauldron triples never appear as explanations (their net
// contribution is already netted out of the column).

'use strict';

const EPS = 1e-6;

// Build production/consumption indexes from a solved flow vector.
function flowIndex(flows) {
  const producers = new Map(); // item -> [{flow, ratePerMin}]
  const consumers = new Map();
  for (const f of flows) {
    for (const [item, qty] of Object.entries(f.process.produces)) {
      const r = qty * f.rate;
      if (r > EPS) (producers.get(item) ?? producers.set(item, []).get(item)).push({ flow: f, rate: r });
    }
    for (const [item, qty] of Object.entries(f.process.consumes)) {
      const r = qty * f.rate;
      if (r > EPS) (consumers.get(item) ?? consumers.set(item, []).get(item)).push({ flow: f, rate: r });
    }
  }
  return { producers, consumers };
}

function describeProcess(p) {
  switch (p.kind) {
    case 'purchase': return `buy @ ${p.copperCost}g`;
    case 'mint': return `mint at face value (${p.copperCost}g/run) [ASSUMPTION]`;
    case 'cauldron': {
      const ins = Object.entries(p.consumes).map(([n, q]) => (q > 1 ? `${q}× ${n}` : n)).join(' + ');
      const marks = [];
      if (p.flags.exactTie) marks.push('EXACT TIE → id rule');
      else if (p.flags.fragileMargin !== undefined) marks.push(`FRAGILE margin ${p.flags.fragileMargin.toFixed(3)}`);
      return `cauldron [${ins}]${marks.length ? ' (' + marks.join(', ') + ')' : ''}`;
    }
    case 'catalystVariant': return `${p.machine} ${p.recipeId} +${p.flags.catalyst} catalyst`;
    case 'recipe': {
      const ins = Object.entries(p.consumes).map(([n, q]) => `${q}× ${n}`).join(' + ');
      return `${p.machine}${ins ? ` [${ins}]` : ''}`;
    }
    default: return p.id;
  }
}

// Render the route tree for one item to a list of text lines.
function renderItem(item, idx, lines, prefix, visiting, demandRate) {
  const prods = idx.producers.get(item) ?? [];
  const total = prods.reduce((s, p) => s + p.rate, 0);
  if (visiting.has(item)) {
    lines.push(`${prefix}↻ ${item} (loop — self-sustaining at steady state)`);
    return;
  }
  visiting.add(item);
  prods.sort((a, b) => b.rate - a.rate);
  for (const { flow, rate } of prods) {
    const p = flow.process;
    const share = total > 0 ? rate / total : 0;
    const shareStr = share < 0.999 ? ` (${(share * 100).toFixed(0)}%)` : '';
    lines.push(`${prefix}${item} ← ${describeProcess(p)} @ ${rate.toFixed(2)}/min${shareStr}`);
    if (p.kind === 'recipe' || p.kind === 'catalystVariant' || p.kind === 'cauldron') {
      for (const input of Object.keys(p.consumes)) {
        renderItem(input, idx, lines, prefix + '  ', visiting, 0);
      }
    }
  }
  if (prods.length === 0 && demandRate > 0) {
    lines.push(`${prefix}${item}: no producer in solution (?)`);
  }
  visiting.delete(item);
}

// Regime detection: is the solution materially self-sustaining?
function detectRegime(result, demand) {
  const purchases = result.flows.filter((f) => f.process.kind === 'purchase' || f.process.kind === 'mint');
  const spend = purchases.reduce((s, f) => s + f.process.copperCost * f.rate, 0);
  const loops = result.flows.filter((f) => f.process.kind === 'cauldron' && f.process.flags.fragileMargin !== undefined);
  const demandTotal = Object.values(demand).reduce((s, r) => s + r, 0);
  if (demandTotal > 0 && spend / demandTotal < 1) {
    return {
      regime: 'self-sustaining',
      note: 'This configuration is materially (near-)self-sustaining: external purchases are ~zero and the binding constraint is machine capacity, not copper. '
        + (loops.length ? `${loops.length} active cauldron column(s) ride fragile winning margins — verify these in-game before building.` : ''),
    };
  }
  return { regime: 'priced', note: null };
}

function explain(result, demand) {
  if (result.status !== 'Optimal') {
    const lines = [`Status: ${result.status}`];
    if (result.reason) lines.push(result.reason);
    return lines.join('\n');
  }
  const idx = flowIndex(result.flows);
  const lines = [];
  const regime = detectRegime(result, demand);

  for (const [item, rate] of Object.entries(demand)) {
    lines.push(`── ${item} @ ${rate}/min ──`);
    renderItem(item, idx, lines, '  ', new Set(), rate);
  }

  const buys = result.flows.filter((f) => f.process.kind === 'purchase' || f.process.kind === 'mint');
  if (buys.length) {
    lines.push('');
    lines.push('External inputs:');
    for (const f of buys.sort((a, b) => b.process.copperCost * b.rate - a.process.copperCost * a.rate)) {
      const item = Object.keys(f.process.produces)[0];
      lines.push(`  ${item}: ${(f.rate * (f.process.produces[item] ?? 1)).toFixed(2)}/min — ${(f.process.copperCost * f.rate).toFixed(1)} c/min${f.process.kind === 'mint' ? ' [mint, face-value assumption]' : ''}`);
    }
  }
  const sells = result.flows.filter((f) => f.process.kind === 'sale');
  if (sells.length) {
    lines.push('Sales:');
    for (const f of sells.sort((a, b) => b.process.copperRevenue * b.rate - a.process.copperRevenue * a.rate).slice(0, 15)) {
      lines.push(`  ${Object.keys(f.process.consumes)[0]}: ${f.rate.toFixed(2)}/min — ${(f.process.copperRevenue * f.rate).toFixed(1)} c/min`);
    }
  }

  if (result.binding?.length) {
    lines.push('');
    lines.push('Binding machine capacity:');
    for (const b of result.binding) {
      lines.push(`  ${b.machine}: at capacity (${b.capacity.toFixed(0)} machine-sec/min); marginal value ${Math.abs(b.dual).toFixed(2)} g per machine-sec`);
    }
  }
  if (regime.note) {
    lines.push('');
    lines.push(`⚠ ${regime.note}`);
  }

  const fragileActive = result.flows.filter((f) => f.process.kind === 'cauldron' && (f.process.flags.fragileMargin !== undefined || f.process.flags.exactTie));
  if (fragileActive.length && regime.regime !== 'self-sustaining') {
    lines.push('');
    lines.push(`⚠ ${fragileActive.length} active cauldron route(s) have fragile/tie-decided outputs — they can flip in a balance patch. Verify in-game.`);
  }
  return lines.join('\n');
}

module.exports = { explain, flowIndex, detectRegime, describeProcess };
