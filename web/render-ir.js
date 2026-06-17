// Geometry-only renderer for the tile-DAG IR. It consumes a fully-decided IR (tiles, ports, belts,
// groups) and does ONE thing: assign positions and draw. It NEVER re-derives structure — no
// clustering, no count math, no belt replication. If the picture is wrong, the producer is wrong,
// not this file. (This is the "second brain" deletion: the renderer only does geometry.)
//
//   layoutIR(ir, opts) -> { pos: Map(id -> {x,y,w,h}), groups: [{key,x,y,w,h}], width, height }   (pure)
//   drawIR(ir, layout, gEl, opts)                                                                  (DOM)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlchRenderIR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function layoutIR(ir, opts) {
    const o = opts || {};
    const NW = o.nodeW || 200, NH = o.nodeH || 64, GX = o.gapX || 36, GY = o.gapY || 90;
    const ids = [...ir.tiles.map((t) => t.id), ...ir.ports.map((p) => p.id)];
    const idSet = new Set(ids);
    const groupById = new Map();
    for (const t of ir.tiles) groupById.set(t.id, t.group);
    for (const p of ir.ports) groupById.set(p.id, p.group);
    const fwd = new Map(ids.map((n) => [n, []]));
    const rev = new Map(ids.map((n) => [n, []]));
    for (const b of ir.belts) { if (!idSet.has(b.from) || !idSet.has(b.to)) continue; fwd.get(b.from).push(b.to); rev.get(b.to).push(b.from); }

    // break cycles (self-fuel/fert loops) so ranking terminates: DFS, flag back edges
    const back = new Set(), color = new Map(ids.map((n) => [n, 0]));
    const visit = (u) => {
      color.set(u, 1);
      for (const v of fwd.get(u)) { if (color.get(v) === 1) back.add(u + '\t' + v); else if (color.get(v) === 0) visit(v); }
      color.set(u, 2);
    };
    for (const n of ids) if (color.get(n) === 0) visit(n);
    const parents = (u) => rev.get(u).filter((p) => !back.has(p + '\t' + u));

    // rank = longest path from a source (memoized; back edges excluded)
    const rank = new Map();
    const lp = (u, seen) => {
      if (rank.has(u)) return rank.get(u);
      if (seen.has(u)) return 0; // defensive
      seen.add(u);
      let r = 0;
      for (const p of parents(u)) r = Math.max(r, lp(p, seen) + 1);
      seen.delete(u);
      rank.set(u, r);
      return r;
    };
    for (const n of ids) lp(n, new Set());

    // rows by rank
    const maxRank = Math.max(0, ...ids.map((n) => rank.get(n)));
    const rows = Array.from({ length: maxRank + 1 }, () => []);
    for (const n of ids) rows[rank.get(n)].push(n);

    // order within each row: keep groups contiguous (group is solver-owned), then barycenter
    const groupOrder = new Map();
    for (const n of ids) if (!groupOrder.has(groupById.get(n))) groupOrder.set(groupById.get(n), groupOrder.size);
    const idx = new Map();
    const reindex = () => rows.forEach((row) => row.forEach((n, i) => idx.set(n, i)));
    rows.forEach((row) => row.sort((a, b) => (groupOrder.get(groupById.get(a)) - groupOrder.get(groupById.get(b)))));
    reindex();
    const bary = (n, adj) => { const a = adj.get(n).filter((m) => idSet.has(m)); return a.length ? a.reduce((s, m) => s + (idx.get(m) || 0), 0) / a.length : (idx.get(n) || 0); };
    for (let pass = 0; pass < 4; pass++) {
      const dir = pass % 2 === 0 ? rev : fwd;
      rows.forEach((row) => { const b = new Map(row.map((n) => [n, bary(n, dir)])); row.sort((x, y) => (groupOrder.get(groupById.get(x)) - groupOrder.get(groupById.get(y))) || (b.get(x) - b.get(y))); });
      reindex();
    }

    // positions (TB): y by rank, x by order in row
    const pos = new Map();
    let width = 0;
    rows.forEach((row, r) => {
      let x = 0;
      for (const n of row) { pos.set(n, { x, y: r * (NH + GY), w: NW, h: NH }); x += NW + GX; }
      width = Math.max(width, x - GX);
    });
    const height = (maxRank + 1) * (NH + GY) - GY;

    // group hulls (drawn from the solver's group field — NOT re-clustered)
    const gmap = new Map();
    for (const n of ids) {
      const g = groupById.get(n), p = pos.get(n);
      if (!gmap.has(g)) gmap.set(g, { key: g, x: p.x, y: p.y, x2: p.x + p.w, y2: p.y + p.h });
      const e = gmap.get(g);
      e.x = Math.min(e.x, p.x); e.y = Math.min(e.y, p.y); e.x2 = Math.max(e.x2, p.x + p.w); e.y2 = Math.max(e.y2, p.y + p.h);
    }
    const groups = [...gmap.values()].map((g) => ({ key: g.key, x: g.x - 8, y: g.y - 22, w: g.x2 - g.x + 16, h: g.y2 - g.y + 30 }));
    return { pos, groups, width: Math.max(width, 1), height: Math.max(height, 1) };
  }

  // ---- DOM drawing (browser only) ----
  const NS = 'http://www.w3.org/2000/svg';
  const KIND_COLOR = { material: '#7a9cc6', fuel: '#c6884a', fert: '#6fbf73', cash: '#c9b24a' };
  function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function drawIR(ir, layout, gEl, opts) {
    const o = opts || {};
    const tileById = new Map(ir.tiles.map((t) => [t.id, t]));
    const portById = new Map(ir.ports.map((p) => [p.id, p]));
    // group hulls first (behind), labeled with the solver-provided group key
    for (const g of layout.groups) {
      if (g.key === 'supply') continue; // don't box the raw-supply band
      gEl.appendChild(el('rect', { x: g.x, y: g.y, width: g.w, height: g.h, rx: 10, fill: 'none', stroke: '#3a4654', 'stroke-dasharray': '4 4' }));
      const lbl = el('text', { x: g.x + 8, y: g.y + 15, fill: '#8aa0b6', 'font-size': 12, 'font-weight': 600 });
      lbl.textContent = `${g.key} line`; gEl.appendChild(lbl);
    }
    // belts
    for (const b of ir.belts) {
      const s = layout.pos.get(b.from), t = layout.pos.get(b.to);
      if (!s || !t) continue;
      const x1 = s.x + s.w / 2, y1 = s.y + s.h, x2 = t.x + t.w / 2, y2 = t.y;
      const my = (y1 + y2) / 2;
      const p = el('path', { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, fill: 'none', stroke: KIND_COLOR[b.kind] || '#888', 'stroke-width': b.kind === 'material' ? 1.5 : 1, opacity: 0.7 });
      if (b.kind !== 'material') p.setAttribute('stroke-dasharray', '5 4');
      gEl.appendChild(p);
    }
    // tiles + ports
    for (const [id, p] of layout.pos) {
      const tile = tileById.get(id), port = portById.get(id);
      const g = el('g', { transform: `translate(${p.x},${p.y})` });
      if (tile) {
        g.appendChild(el('rect', { width: p.w, height: p.h, rx: 8, fill: '#2f3a44', stroke: '#46566a' }));
        const title = el('text', { x: 10, y: 22, fill: '#e6edf3', 'font-size': 13, 'font-weight': 600 });
        title.textContent = clip(`${tile.machine} → ${tile.item}`, 28); g.appendChild(title);
        const sub = el('text', { x: 10, y: 42, fill: '#9bb0c4', 'font-size': 12 });
        sub.textContent = `${tile.count}× · ${Math.round(tile.out)}/min`; g.appendChild(sub);
      } else if (port) {
        const fill = port.role === 'demand' ? '#6b5410' : port.role === 'trash' || port.role === 'surplus' ? '#5a2d2d' : '#2d4356';
        g.appendChild(el('rect', { width: p.w, height: p.h, rx: 8, fill, stroke: '#46566a', opacity: 0.9 }));
        const title = el('text', { x: 10, y: 26, fill: '#cdd9e5', 'font-size': 12 });
        title.textContent = clip(port.item || port.id, 30); g.appendChild(title);
      }
      gEl.appendChild(g);
    }
  }

  return { layoutIR, drawIR };
}));
