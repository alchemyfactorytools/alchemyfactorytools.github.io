// Server-side SVG renderer: produces a standalone, self-contained .svg of a
// solved factory graph (same layered layout as the web UI). Used by the
// `node src/cli.js svg ...` command and as a portable export.

'use strict';

const { layout, edgePath, edgeMid } = require('./layout');
const NODE_W = 260, NODE_H = 84;
const MARGIN = 20;
const TITLE_CHARS = 30; // chars per title line at NODE_W/12px before wrapping
const COLORS = {
  process: '#2f3a44', external: '#2d4356', demand: '#6b5410',
  resource: '#5a2f2f', surplus: '#333', bg: '#14110d', ink: '#ece3d4',
  muted: '#9b8e78', accent: '#c9a14a', line: '#3a3024', warn: '#d9b35a', heat: '#8a4a3a',
  fert: '#4e8a64', recycle: '#6a7a8a', flow: '#6a9fd4', cash: '#d4af37',
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(1);
  return n.toFixed(3);
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// greedy word-wrap into ≤maxLines lines of ≤maxChars; overflow clipped with an ellipsis
function wrapLabel(s, maxChars, maxLines) {
  const words = String(s).split(' ');
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const test = cur ? cur + ' ' + words[i] : words[i];
    if (test.length <= maxChars) { cur = test; continue; }
    if (lines.length === maxLines - 1) { cur = [cur, ...words.slice(i)].filter(Boolean).join(' '); break; }
    lines.push(cur);
    cur = words[i];
  }
  if (cur) lines.push(cur);
  return lines.filter((l) => l.length).map((l) => clip(l, maxChars));
}

const CLUSTER_COLORS = ['#7a9cc6', '#c69c7a', '#7ac68f', '#c67a9c', '#9c7ac6', '#c6c07a'];

function renderSvg(graph, { title = '', orientation = 'LR' } = {}) {
  const { pos, edges: edgePts, recycle, clusters } = layout(graph, { nodeW: NODE_W, nodeH: NODE_H, orientation });
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H); }
  const W = maxX + 2 * MARGIN, H = maxY + 2 * MARGIN + 24;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<rect width="${W}" height="${H}" fill="${COLORS.bg}"/>`);
  out.push(`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>`);
  out.push(`<g transform="translate(${MARGIN},${MARGIN})">`);
  if (title) out.push(`<text x="0" y="${maxY + 22}" fill="${COLORS.muted}" font-size="13">${esc(title)}</text>`);

  // production-line containers (behind everything)
  (clusters || []).forEach((c, i) => {
    const col = c.belt ? COLORS.accent : CLUSTER_COLORS[i % CLUSTER_COLORS.length];
    out.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="10" fill="${col}" fill-opacity="${c.belt ? 0.1 : 0.06}" stroke="${col}" stroke-opacity="0.5" stroke-width="1.2" stroke-dasharray="2 4"/>`);
    out.push(`<text x="${c.x + 10}" y="${c.y + 16}" font-size="12" font-weight="700" fill="${col}">${esc(c.label)}${c.belt ? '' : ' line'}</text>`);
  });

  // edges — curved links along the columns; primary solid, recycle/shared dashed
  for (const e of graph.edges) {
    const eo = edgePts.get(e.from + '\t' + e.to);
    if (!eo) continue;
    const isFuel = e.heat || e.item === 'HEAT';
    const isFert = e.nutrient || e.item === 'NUTRIENT';
    const isCash = e.cash;
    const isCoproduct = e.coproduct; // a reused co-product feeding another tile (cross-tile recycle)
    const isRecycle = (recycle && recycle.has(e.from + '\t' + e.to)) || isCoproduct;
    const stroke = isFuel ? COLORS.heat : isFert ? COLORS.fert : isCash ? COLORS.cash : (isRecycle ? COLORS.recycle : COLORS.flow);
    const dash = isCash ? ' stroke-dasharray="5 3"' : isRecycle ? ' stroke-dasharray="4 3"' : '';
    out.push(`<path d="${edgePath(eo, orientation)}" fill="none" stroke="${stroke}" stroke-width="1.4"${dash} marker-end="url(#a)" opacity="${isRecycle ? 0.6 : 0.95}"/>`);
    const m = edgeMid(eo);
    const label = `${isCoproduct ? '♻ ' : ''}${e.item} ${fmt(e.ratePerMin)}`;
    out.push(`<text x="${m.x}" y="${m.y - 3}" text-anchor="middle" font-size="10" fill="${COLORS.bg}" stroke="${COLORS.bg}" stroke-width="3" paint-order="stroke">${esc(label)}</text>`);
    out.push(`<text x="${m.x}" y="${m.y - 3}" text-anchor="middle" font-size="10" fill="${isRecycle ? COLORS.recycle : COLORS.muted}">${esc(label)}</text>`);
  }
  // nodes
  for (const n of graph.nodes) {
    const p = pos.get(n.id); const x = p.x, y = p.y;
    const fill = COLORS[n.type] ?? COLORS.process;
    const dash = n.type === 'surplus' ? ' stroke-dasharray="3 3"' : '';
    const badgeText = (n.badges && n.badges.length) ? n.badges.slice(0, 2).join(' ') : '';
    const titleLines = wrapLabel(n.label, TITLE_CHARS, 2);
    out.push(`<g transform="translate(${x},${y})">`);
    out.push(`<rect width="${NODE_W}" height="${NODE_H}" rx="7" fill="${fill}" stroke="${COLORS.line}"${dash}/>`);
    titleLines.slice(0, 2).forEach((ln, i) => out.push(`<text x="10" y="${19 + i * 15}" font-size="12" fill="${COLORS.ink}">${esc(ln)}</text>`));
    if (badgeText) out.push(`<text x="${NODE_W - 8}" y="18" text-anchor="end" font-size="9" font-weight="700" fill="${badgeText.includes('ASSUMPTION') ? '#6fae8f' : COLORS.warn}">${esc(badgeText)}</text>`);
    const subY = Math.min(titleLines.length, 2) === 2 ? 50 : 39;
    let sub = '';
    if (n.machineCount && n.utilization != null) sub = `${n.machineCount}× ${n.machine} (${Math.round(n.utilization * 100)}%) · ${fmt(n.ratePerMin)}/min`;
    else if (n.machineCount) sub = `${n.machineCount}× ${n.machine} · ${fmt(n.ratePerMin)}/min`;
    else if (n.machine) sub = `${n.machine} · ${fmt(n.ratePerMin)}/min`;
    else if (n.kind === 'belt' && n.supplyRate != null) sub = `${fmt(n.ratePerMin)}/min drawn · ${fmt(n.supplyRate)}/min belt supply${n.beltLanes ? ` · ${n.beltLanes} belt${n.beltLanes > 1 ? 's' : ''}` : ''}`;
    else if (n.kind === 'belt' && n.beltLanes) sub = `${fmt(n.ratePerMin)}/min · ${n.beltLanes} belt${n.beltLanes > 1 ? 's' : ''} @ ${fmt(n.beltSpeed)}/min`;
    else if (n.type === 'external') sub = `${fmt(n.ratePerMin)}/min${n.copperPerMin ? ' · ' + fmt(n.copperPerMin) + ' c/min' : ' · free'}`;
    else if (n.type === 'demand') sub = `${fmt(n.ratePerMin)}/min target`;
    else if (n.type === 'resource') sub = `${fmt(n.ratePerMin)}/min → ${n.consumerCount} machines`;
    else if (n.type === 'surplus') sub = `${fmt(n.ratePerMin)}/min`;
    out.push(`<text x="10" y="${subY}" font-size="10.5" fill="${COLORS.muted}">${esc(clip(sub, 42))}</text>`);
    const draws = [];
    if (n.heatPerMin > 0) draws.push(`H ${fmt(n.heatPerMin)}`);
    if (n.nutrientPerMin > 0) draws.push(`N ${fmt(n.nutrientPerMin)}`);
    if (draws.length && n.type === 'process' && !n.machineCount) out.push(`<text x="${NODE_W - 8}" y="${subY}" text-anchor="end" font-size="9.5" fill="${COLORS.muted}">${esc(draws.join('  '))}</text>`);
    // lower-third supply bands: fuel burned (red 🔥) and/or fertilizer consumed (green 🌱)
    const bands = [];
    if (n.fuelItem && n.fuelPerMin > 0) bands.push({ fill: '#5a2f2f', tx: '#f0c9c0', t: `🔥 ${fmt(n.fuelPerMin)} ${n.fuelItem}/min` });
    if (n.fertItem && n.fertPerMin > 0) bands.push({ fill: '#2f4a36', tx: '#bfe3c8', t: `🌱 ${fmt(n.fertPerMin)} ${n.fertItem}/min` });
    // items a recipe loops back into the same machine — flagged so a raw co-output isn't read as orphaned
    if (n.recirc) for (const rc of n.recirc) bands.push({ fill: '#2c3a4a', tx: '#b9cfe6', t: `♻ ${fmt(rc.ratePerMin)} ${rc.item}/min recirculated` });
    if (bands.length) {
      const bh = 17;
      const cid = 'clip' + esc(n.id).replace(/[^a-z0-9]/gi, '');
      out.push(`<clipPath id="${cid}"><rect width="${NODE_W}" height="${NODE_H}" rx="7"/></clipPath>`);
      out.push(`<g clip-path="url(#${cid})">`);
      bands.forEach((b, i) => {
        out.push(`<rect x="0" y="${NODE_H - bh * (i + 1)}" width="${NODE_W}" height="${bh}" fill="${b.fill}"/>`);
        out.push(`<text x="8" y="${NODE_H - 5 - bh * i}" font-size="10" fill="${b.tx}">${esc(clip(b.t, 40))}</text>`);
      });
      out.push('</g>');
    }
    out.push('</g>');
  }
  out.push('</g>');
  out.push('</svg>');
  return out.join('\n');
}

module.exports = { renderSvg };
