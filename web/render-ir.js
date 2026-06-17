// Geometry-only renderer for the tile-DAG IR. It consumes a fully-decided IR (tiles, ports, belts,
// line/parent tree) and does ONE thing: assign positions and draw. It NEVER re-derives structure —
// no clustering, no count math, no belt replication. If the picture is wrong, the producer is wrong.
//
// DYNAMIC CELL SIZING + RECURSIVE GROUPING:
//   * Each tile/port is sized to its CONTENT (title + count/rate + one band per util kind it draws),
//     snapped UP to a fine grid unit. So a bare buy is short and a heated cauldron with fuel/fert/cash
//     bands is tall — without breaking alignment.
//   * Layout is RECURSIVE bottom-up over the composer's material tree: lay out the deepest subtrees
//     first, freeze each into a rigid block sized to its contents + padding, then the parent packs
//     those blocks (children above, the producer tile below, centred). Group BOXES are drawn at
//     branch points (>=2 children) and at line roots; linear chains collapse. Because every level
//     only ever packs solid rectangles, sibling overlap is impossible by construction.
//   * Top level: a supply band (belts) on top, the line blocks packed in a row, demand sinks below
//     their line. Belts are drawn over the result, coloured by kind.
//
//   layoutIR(ir, opts) -> { pos: Map(id->{x,y,w,h}), boxes: [{key,x,y,w,h,depth}], backEdges:Set,
//                           width, height }   (pure, DOM-free)
//   drawIR(ir, layout, gEl, opts)            (DOM)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlchRenderIR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const U = 22;                       // fine grid unit (~one text line)
  const snap = (v) => Math.ceil(v / U) * U;
  const CHAR_W = 7.2;                  // approx px per char at our font size

  // ---- dynamic cell size from content ----
  // belts arriving into a tile decide its util bands (fuel/fert/cash), which make it taller.
  function defaultSizeOf(node, kindsIn) {
    const isTile = node.machine != null;
    let lines = isTile ? 2 : 1;       // tile: title + count/rate; port: one label line
    const bands = kindsIn ? [...kindsIn].filter((k) => k !== 'material').length : 0;
    lines += bands;
    const label = isTile ? `${node.machine} → ${node.item}` : (node.item || node.id);
    const w = snap(Math.max(150, Math.min(300, String(label).length * CHAR_W + 24)));
    const h = snap(lines * 19 + 14);
    return { w, h };
  }

  // ---- recursive tidy layout of one material-tree subtree ----
  // returns { w, h, place: Map(id->{x,y,w,h} relative to block top-left), boxes:[{key,x,y,w,h,depth}] }
  function layoutSubtree(id, childrenOf, sizeFn, depth) {
    const kids = (childrenOf.get(id) || []);
    const self = sizeFn(id);
    if (!kids.length) {
      return { w: self.w, h: self.h, place: new Map([[id, { x: 0, y: 0, w: self.w, h: self.h }]]), boxes: [] };
    }
    const HGAP = U * 3, VGAP = U * 2, PAD = U; // HGAP > 2·PAD so adjacent branch boxes never touch
    const blocks = kids.map((k) => layoutSubtree(k, childrenOf, sizeFn, depth + 1));
    const childRowH = Math.max(...blocks.map((b) => b.h));
    // pack children left->right, bottoms aligned (roots sit just above the parent)
    const place = new Map();
    const boxes = [];
    let x = 0;
    blocks.forEach((b, i) => {
      const oy = childRowH - b.h;
      for (const [nid, p] of b.place) place.set(nid, { x: p.x + x, y: p.y + oy, w: p.w, h: p.h });
      for (const bx of b.boxes) boxes.push({ ...bx, x: bx.x + x, y: bx.y + oy });
      x += b.w + HGAP;
    });
    const childrenW = x - HGAP;
    const totalW = Math.max(childrenW, self.w);
    // centre the producer tile under its children's span
    const selfX = Math.round((totalW - self.w) / 2 / U) * U;
    const selfY = childRowH + VGAP;
    place.set(id, { x: selfX, y: selfY, w: self.w, h: self.h });
    const w = totalW, h = selfY + self.h;
    // draw a box around this subtree at branch points (and let the caller box line roots)
    if (kids.length >= 2) boxes.push({ key: id, x: -PAD, y: -PAD, w: w + 2 * PAD, h: h + 2 * PAD, depth });
    return { w, h, place, boxes };
  }

  function layoutIR(ir, opts) {
    const o = opts || {};
    const sizeOpt = o.sizeOf;
    const ids = new Set([...ir.tiles.map((t) => t.id), ...ir.ports.map((p) => p.id)]);
    const nodeById = new Map();
    for (const t of ir.tiles) nodeById.set(t.id, t);
    for (const p of ir.ports) nodeById.set(p.id, p);

    // util kinds entering each node (drives dynamic height)
    const kindsIn = new Map([...ids].map((id) => [id, new Set()]));
    for (const b of ir.belts) if (ids.has(b.to)) kindsIn.get(b.to).add(b.kind);
    const sizeFn = (id) => {
      const n = nodeById.get(id);
      return (sizeOpt && sizeOpt(n, kindsIn.get(id))) || defaultSizeOf(n, kindsIn.get(id));
    };

    // Material flow runs leaf->root (a producer is a CHILD of its consumer in the tree). A back edge
    // is therefore one that runs the other way — from an ancestor DOWN to a descendant — i.e. a
    // self-fuel/self-fert loop where a producer feeds something upstream of itself.
    const parentOf = new Map();
    for (const t of ir.tiles) parentOf.set(t.id, t.parent || null);
    for (const p of ir.ports) parentOf.set(p.id, p.parent || null);
    const isAncestor = (anc, node) => { let c = parentOf.get(node); while (c != null) { if (c === anc) return true; c = parentOf.get(c); } return false; };
    const backEdges = new Set();
    for (const b of ir.belts) if (ids.has(b.from) && ids.has(b.to) && isAncestor(b.from, b.to)) backEdges.add(b.from + '\t' + b.to);

    // material-tree children (forward links only; ignore the special bands)
    const childrenOf = new Map([...ids].map((id) => [id, []]));
    for (const id of ids) { const par = parentOf.get(id); if (par != null && childrenOf.has(par)) childrenOf.get(par).push(id); }
    for (const arr of childrenOf.values()) arr.sort((a, c) => (sizeFn(c).w - sizeFn(a).w) || (a < c ? -1 : 1)); // widest subtree first-ish, stable

    // classify top-level nodes
    const supply = ir.ports.filter((p) => p.line === 'supply').map((p) => p.id);
    const demand = ir.ports.filter((p) => p.role === 'demand').map((p) => p.id);
    const special = new Set([...supply, ...demand]);
    const lineRoots = [...ids].filter((id) => parentOf.get(id) == null && !special.has(id));
    lineRoots.sort((a, c) => (a < c ? -1 : 1));

    const pos = new Map();
    const boxes = [];
    const GAP = U * 2;
    let cursorX = 0, supplyH = 0;

    // supply band (top)
    supply.forEach((id) => { const s = sizeFn(id); pos.set(id, { x: cursorX, y: 0, w: s.w, h: s.h }); cursorX += s.w + U; supplyH = Math.max(supplyH, s.h); });
    const supplyW = Math.max(0, cursorX - U);

    // line blocks (row under the supply band)
    const lineTop = supplyH ? supplyH + GAP : 0;
    let lineX = 0, lineBottom = lineTop;
    const lineRootX = new Map();
    for (const rootId of lineRoots) {
      const sub = layoutSubtree(rootId, childrenOf, sizeFn, 1);
      for (const [nid, p] of sub.place) pos.set(nid, { x: p.x + lineX + U, y: p.y + lineTop + U, w: p.w, h: p.h });
      for (const bx of sub.boxes) boxes.push({ ...bx, x: bx.x + lineX + U, y: bx.y + lineTop + U });
      // line wrapper box (sized to internals + a bit)
      boxes.push({ key: rootId, line: nodeById.get(rootId) ? nodeById.get(rootId).line : rootId, x: lineX, y: lineTop, w: sub.w + 2 * U, h: sub.h + 2 * U, depth: 0 });
      const rp = pos.get(rootId);
      lineRootX.set(nodeById.get(rootId).line, rp.x + rp.w / 2);
      lineX += sub.w + 2 * U + GAP;
      lineBottom = Math.max(lineBottom, lineTop + sub.h + 2 * U);
    }
    const linesW = Math.max(0, lineX - GAP);

    // demand sinks (bottom, under their line root if known)
    let demandY = lineBottom + GAP;
    demand.forEach((id, i) => {
      const s = sizeFn(id);
      const ln = nodeById.get(id).line;
      const cx = lineRootX.has(ln) ? lineRootX.get(ln) : (i * (s.w + U) + s.w / 2);
      pos.set(id, { x: Math.max(0, Math.round(cx - s.w / 2)), y: demandY, w: s.w, h: s.h });
    });

    // any stragglers (shouldn't happen): drop into a misc row so completeness holds
    let mx = 0;
    for (const id of ids) if (!pos.has(id)) { const s = sizeFn(id); pos.set(id, { x: mx, y: demandY + 4 * U, w: s.w, h: s.h }); mx += s.w + U; }

    let width = 0, height = 0;
    for (const p of pos.values()) { width = Math.max(width, p.x + p.w); height = Math.max(height, p.y + p.h); }
    for (const b of boxes) { width = Math.max(width, b.x + b.w); height = Math.max(height, b.y + b.h); }
    return { pos, boxes, backEdges, width: Math.max(width, 1), height: Math.max(height, 1) };
  }

  // ---- DOM drawing (browser only) ----
  const NS = 'http://www.w3.org/2000/svg';
  const KIND_COLOR = { material: '#7a9cc6', fuel: '#c6884a', fert: '#6fbf73', cash: '#c9b24a' };
  const BOX_STROKE = ['#5a6b80', '#46566a', '#3a4654'];
  function el(tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function drawIR(ir, layout, gEl) {
    const tileById = new Map(ir.tiles.map((t) => [t.id, t]));
    const portById = new Map(ir.ports.map((p) => [p.id, p]));
    // group boxes deepest-first so outer boxes sit behind
    for (const b of [...layout.boxes].sort((a, c) => (c.depth || 0) - (a.depth || 0))) {
      gEl.appendChild(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, fill: 'none', stroke: BOX_STROKE[Math.min(b.depth || 0, 2)], 'stroke-dasharray': b.depth ? '4 4' : '' }));
      if (b.line || b.depth === 0) { const lbl = el('text', { x: b.x + 8, y: b.y + 15, fill: '#8aa0b6', 'font-size': 12, 'font-weight': 600 }); lbl.textContent = `${b.line || (tileById.get(b.key) || {}).item || ''}`; gEl.appendChild(lbl); }
    }
    // belts
    for (const b of ir.belts) {
      const s = layout.pos.get(b.from), t = layout.pos.get(b.to);
      if (!s || !t) continue;
      const back = layout.backEdges.has(b.from + '\t' + b.to);
      const x1 = s.x + s.w / 2, y1 = s.y + s.h, x2 = t.x + t.w / 2, y2 = t.y;
      const my = (y1 + y2) / 2;
      const p = el('path', { d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, fill: 'none', stroke: KIND_COLOR[b.kind] || '#888', 'stroke-width': b.kind === 'material' ? 1.5 : 1, opacity: back ? 0.5 : 0.75 });
      if (b.kind !== 'material') p.setAttribute('stroke-dasharray', '5 4');
      gEl.appendChild(p);
    }
    // tiles + ports
    for (const [id, p] of layout.pos) {
      const tile = tileById.get(id), port = portById.get(id);
      const g = el('g', { transform: `translate(${p.x},${p.y})` });
      if (tile) {
        g.appendChild(el('rect', { width: p.w, height: p.h, rx: 8, fill: '#2f3a44', stroke: '#46566a' }));
        const title = el('text', { x: 8, y: 18, fill: '#e6edf3', 'font-size': 12, 'font-weight': 600 });
        title.textContent = clip(`${tile.machine} → ${tile.item}`, Math.floor(p.w / 7)); g.appendChild(title);
        const sub = el('text', { x: 8, y: 36, fill: '#9bb0c4', 'font-size': 11 });
        sub.textContent = `${tile.count}× · ${Math.round(tile.out)}/min`; g.appendChild(sub);
      } else if (port) {
        const fill = port.role === 'demand' ? '#6b5410' : (port.role === 'surplus' || port.role === 'trash') ? '#5a2d2d' : '#2d4356';
        g.appendChild(el('rect', { width: p.w, height: p.h, rx: 8, fill, stroke: '#46566a', opacity: 0.92 }));
        const title = el('text', { x: 8, y: Math.min(22, p.h / 2 + 4), fill: '#cdd9e5', 'font-size': 11 });
        title.textContent = clip(port.item || port.id, Math.floor(p.w / 7)); g.appendChild(title);
      }
      gEl.appendChild(g);
    }
  }

  return { layoutIR, drawIR, defaultSizeOf };
}));
