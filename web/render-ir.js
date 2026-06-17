// Geometry-only renderer for the tile-DAG IR. Consumes a fully-decided IR and only positions + draws
// — never re-derives structure (no clustering, no count math, no belt replication). Styling reuses the
// app's existing CSS classes (.node.*, .sub, .util, .fuelband/.fertband, .edge.*, .cluster…) so it
// matches the original look while keeping the new recursive nesting + dynamic cell sizing.
//
//   layoutIR(ir, opts) -> { pos, boxes, backEdges, width, height }   (pure, DOM-free)
//   drawIR(ir, layout, gEl)                                          (DOM)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AlchRenderIR = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const U = 22;                                  // fine grid unit
  const snap = (v) => Math.ceil(v / U) * U;
  const CHAR_W = 7.2;
  const BAND_H = 17;
  const TOPHDR = U * 4;                           // line-box header clearance (name + output + machines)

  const fmt = (n) => (n == null ? '' : Math.abs(n) >= 100 ? String(Math.round(n)) : Math.abs(n) >= 1 ? String(Math.round(n * 10) / 10) : String(Math.round(n * 1000) / 1000));
  const fmtCu = (n) => (n == null ? '' : n >= 1000 ? `${Math.round(n)}c` : `${Math.round(n * 10) / 10}c`);

  const bandsOf = (n) => {
    if (n.machine == null) return 0;
    let b = 0;
    if (n.fuelItem && n.fuelPerMin > 0) b++;
    if (n.furnaces) b++;
    if (n.fertItem && n.fertPerMin > 0) b++;
    if (n.recirc) b += n.recirc.length;
    return b;
  };
  const hasBadge = (n) => n.machine != null && n.utilization != null && Math.round(n.utilization * 100) < 90;
  const BADGE_W = 50; // reserve for the ⚙NN% chip so it never overlaps the title
  function defaultSizeOf(node) {
    const isTile = node.machine != null;
    const label = isTile ? `${node.machine} → ${node.item}` : (node.item || node.id);
    const minW = node.role === 'belt' ? 280 : isTile ? 170 : 200;
    const badge = hasBadge(node) ? BADGE_W : 0;
    const w = snap(Math.max(minW + badge, Math.min(300 + badge, String(label).length * CHAR_W + 24 + badge)));
    const titleLines = String(label).length * CHAR_W > w - 16 - badge ? 2 : 1;
    const h = snap(titleLines * 16 + 16 + bandsOf(node) * BAND_H + 14);
    return { w, h };
  }

  // recursive tidy layout of a material-tree subtree -> {w,h,place,boxes}
  // suppressSelf: top (line-root) call — the line box wraps it, so it gets no own box/header.
  function layoutSubtree(id, childrenOf, sizeFn, depth, suppressSelf) {
    const kids = childrenOf.get(id) || [];
    const self = sizeFn(id);
    if (!kids.length) return { w: self.w, h: self.h, place: new Map([[id, { x: 0, y: 0, w: self.w, h: self.h }]]), boxes: [] };
    const HGAP = U * 3, VGAP = U * 2, PAD = U;
    const boxed = !suppressSelf && kids.length >= 2;
    const HDR = boxed ? U * 3 : 0;                // header clearance inside a branch box
    const blocks = kids.map((k) => layoutSubtree(k, childrenOf, sizeFn, depth + 1, false));
    const childRowH = Math.max(...blocks.map((b) => b.h));
    const place = new Map();
    const boxes = [];
    let x = 0;
    blocks.forEach((b) => {
      const oy = childRowH - b.h + HDR;            // push children below this box's header
      for (const [nid, p] of b.place) place.set(nid, { x: p.x + x, y: p.y + oy, w: p.w, h: p.h });
      for (const bx of b.boxes) boxes.push({ ...bx, x: bx.x + x, y: bx.y + oy });
      x += b.w + HGAP;
    });
    const childrenW = x - HGAP;
    const totalW = Math.max(childrenW, self.w);
    const selfX = Math.round((totalW - self.w) / 2 / U) * U;
    const selfY = HDR + childRowH + VGAP;
    place.set(id, { x: selfX, y: selfY, w: self.w, h: self.h });
    const w = totalW, h = selfY + self.h;
    if (boxed) boxes.push({ key: id, x: -PAD, y: -PAD, w: w + 2 * PAD, h: h + 2 * PAD, depth, headerH: HDR });
    return { w, h, place, boxes };
  }

  function layoutIR(ir, opts) {
    const o = opts || {};
    const sizeOpt = o.sizeOf;
    const ids = new Set([...ir.tiles.map((t) => t.id), ...ir.ports.map((p) => p.id)]);
    const nodeById = new Map();
    for (const t of ir.tiles) nodeById.set(t.id, t);
    for (const p of ir.ports) nodeById.set(p.id, p);
    const sizeFn = (id) => { const n = nodeById.get(id); return (sizeOpt && sizeOpt(n)) || defaultSizeOf(n); };

    const parentOf = new Map();
    for (const n of nodeById.values()) parentOf.set(n.id, n.parent || null);
    const isAncestor = (anc, node) => { let c = parentOf.get(node); while (c != null) { if (c === anc) return true; c = parentOf.get(c); } return false; };
    const backEdges = new Set();
    for (const b of ir.belts) if (ids.has(b.from) && ids.has(b.to) && isAncestor(b.from, b.to)) backEdges.add(b.from + '\t' + b.to);

    const childrenOf = new Map([...ids].map((id) => [id, []]));
    for (const id of ids) { const par = parentOf.get(id); if (par != null && childrenOf.has(par)) childrenOf.get(par).push(id); }
    for (const arr of childrenOf.values()) arr.sort((a, c) => (sizeFn(c).w - sizeFn(a).w) || (a < c ? -1 : 1));

    const supply = ir.ports.filter((p) => p.line === 'supply').map((p) => p.id);
    const demand = ir.ports.filter((p) => p.role === 'demand').map((p) => p.id);
    const special = new Set([...supply, ...demand]);
    const lineRoots = [...ids].filter((id) => parentOf.get(id) == null && !special.has(id)).sort();

    const pos = new Map();
    const boxes = [];
    const GAP = U * 2;

    // supply band (top), wrapped in a Main belt box
    let cursorX = U, supplyH = 0;
    supply.forEach((id) => { const s = sizeFn(id); pos.set(id, { x: cursorX, y: TOPHDR, w: s.w, h: s.h }); cursorX += s.w + U; supplyH = Math.max(supplyH, s.h); });
    if (supply.length) boxes.push({ key: '__mainbelt__', belt: true, label: 'Main belt', x: 0, y: 0, w: cursorX, h: TOPHDR + supplyH + U, depth: 0 });
    const bandBottom = supply.length ? TOPHDR + supplyH + U : 0;

    // line blocks
    const SIDEPAD = U * 2;                          // horizontal inset so branch boxes clear the line edge
    const lineTop = bandBottom ? bandBottom + GAP : 0;
    let lineX = 0, lineBottom = lineTop;
    const lineCenterX = new Map();
    for (const rootId of lineRoots) {
      const sub = layoutSubtree(rootId, childrenOf, sizeFn, 1, true); // root: line box wraps it
      for (const [nid, p] of sub.place) pos.set(nid, { x: p.x + lineX + SIDEPAD, y: p.y + lineTop + TOPHDR, w: p.w, h: p.h });
      for (const bx of sub.boxes) boxes.push({ ...bx, x: bx.x + lineX + SIDEPAD, y: bx.y + lineTop + TOPHDR });
      const boxW = sub.w + 2 * SIDEPAD;
      boxes.push({ key: rootId, line: nodeById.get(rootId).line, x: lineX, y: lineTop, w: boxW, h: sub.h + TOPHDR + U, depth: 0 });
      lineCenterX.set(nodeById.get(rootId).line, lineX + boxW / 2);
      lineX += boxW + GAP;
      lineBottom = Math.max(lineBottom, lineTop + sub.h + TOPHDR + U);
    }

    // demand sinks under their line
    const demandY = lineBottom + GAP;
    demand.forEach((id, i) => {
      const s = sizeFn(id);
      const ln = nodeById.get(id).line;
      const cx = lineCenterX.has(ln) ? lineCenterX.get(ln) : i * (s.w + U) + s.w / 2;
      pos.set(id, { x: Math.max(0, Math.round(cx - s.w / 2)), y: demandY, w: s.w, h: s.h });
    });

    let mx = 0;
    for (const id of ids) if (!pos.has(id)) { const s = sizeFn(id); pos.set(id, { x: mx, y: demandY + 4 * U, w: s.w, h: s.h }); mx += s.w + U; }

    // outer margin so nothing sits flush against the canvas edge
    const M = U * 2;
    for (const p of pos.values()) { p.x += M; p.y += M; }
    for (const b of boxes) { b.x += M; b.y += M; }
    let width = 0, height = 0;
    for (const p of pos.values()) { width = Math.max(width, p.x + p.w); height = Math.max(height, p.y + p.h); }
    for (const b of boxes) { width = Math.max(width, b.x + b.w); height = Math.max(height, b.y + b.h); }
    return { pos, boxes, backEdges, width: width + M, height: height + M };
  }

  // ---------------- DOM drawing ----------------
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  function wrap(text, maxChars, maxLines) {
    const words = String(text).split(' '); const lines = []; let cur = '';
    for (const w of words) { if (!cur || (cur + ' ' + w).length <= maxChars) cur = (cur ? cur + ' ' : '') + w; else { lines.push(cur); cur = w; if (lines.length === maxLines - 1) break; } }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines) lines[maxLines - 1] = clip(lines[maxLines - 1] + ' ' + words.slice(lines.join(' ').split(' ').length).join(' '), maxChars);
    return lines;
  }

  function edgeClass(kind, back) { return 'edge' + (kind === 'fuel' ? ' heat' : kind === 'fert' ? ' nutrient' : kind === 'cash' ? ' cash' : back ? ' recycle' : ''); }
  // Shared edge attachment: the exit point on the source and the entry point on the target, each on
  // the edge FACING the other node (by dominant direction), with its outward normal. Incoming and
  // outgoing placements use this same rule — that's the unification.
  function attach(s, t) {
    const sx = s.x + s.w / 2, sy = s.y + s.h / 2, tx = t.x + t.w / 2, ty = t.y + t.h / 2;
    const dx = tx - sx, dy = ty - sy;
    const overlapY = Math.min(s.y + s.h, t.y + t.h) - Math.max(s.y, t.y);
    const sideBySide = overlapY > Math.min(s.h, t.h) * 0.5;
    // EXIT and ENTRY are chosen INDEPENDENTLY. Producers drop output out the BOTTOM toward a target
    // below (only a side exit when genuinely side-by-side). The consumer is entered on the TOP when
    // the source is roughly overhead, but on the facing SIDE when the source is offset enough — so a
    // shallow input reads as "drop out the bottom, curve into the side" rather than knifing the top.
    const exit = sideBySide
      ? (dx >= 0 ? { x: s.x + s.w, y: sy, nx: 1, ny: 0 } : { x: s.x, y: sy, nx: -1, ny: 0 })
      : (dy >= 0 ? { x: sx, y: s.y + s.h, nx: 0, ny: 1 } : { x: sx, y: s.y, nx: 0, ny: -1 });
    // Enter the facing SIDE only when the boxes sit in clearly different columns (little horizontal
    // overlap, <~37%); enter TOP/BOTTOM when they're stacked or mostly aligned. Keeps partly-aligned
    // convergence inputs (Plant Ash/Quicklime → Basic Fert, 40–50% overlap) entering the top, while
    // genuinely off-column inputs (Rotten Log → Table Saw 33%) come in the side.
    const xOverlap = (Math.min(s.x + s.w, t.x + t.w) - Math.max(s.x, t.x)) / Math.min(s.w, t.w);
    const offset = xOverlap < 0.37;
    const entry = (sideBySide || offset)
      ? (dx >= 0 ? { x: t.x, y: ty, nx: -1, ny: 0 } : { x: t.x + t.w, y: ty, nx: 1, ny: 0 })  // facing side
      : (dy >= 0 ? { x: tx, y: t.y, nx: 0, ny: -1 } : { x: tx, y: t.y + t.h, nx: 0, ny: 1 }); // top/bottom
    return { exit, entry };
  }
  // Curve leaving `exit` along its edge normal and ARRIVING at `entry` aligned with the exit→entry
  // direction, so the auto-oriented arrowhead points along the flow into the edge.
  function link(exit, entry) {
    const dx = entry.x - exit.x, dy = entry.y - exit.y, len = Math.hypot(dx, dy) || 1;
    const out = Math.min(44, len * 0.4), stub = Math.min(38, len * 0.45);
    const c1x = exit.x + exit.nx * out, c1y = exit.y + exit.ny * out;
    const c2x = entry.x - (dx / len) * stub, c2y = entry.y - (dy / len) * stub;
    return `M${exit.x},${exit.y} C${c1x},${c1y} ${c2x},${c2y} ${entry.x},${entry.y}`;
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  function edgeLabel(g, x, y, text) { for (const cls of ['bg', '']) { const t = el('text', { x, y: y - 3, 'text-anchor': 'middle' }); if (cls) t.setAttribute('class', cls); t.textContent = text; g.appendChild(t); } }

  function drawIR(ir, layout, gEl) {
    const tileById = new Map(ir.tiles.map((t) => [t.id, t]));
    const portById = new Map(ir.ports.map((p) => [p.id, p]));
    const nodeById = new Map([...tileById, ...portById]);
    const pos = layout.pos;

    // per-line header content (output rate + machine summary), all from the IR (faithful)
    const lineTiles = new Map();
    for (const t of ir.tiles) { if (!lineTiles.has(t.line)) lineTiles.set(t.line, []); lineTiles.get(t.line).push(t); }
    const lineBox = new Map();
    for (const b of layout.boxes) if (b.depth === 0 && b.line) lineBox.set(b.line, b);
    // transparent full-canvas rect so getBBox (and thus fitView) includes the outer margin
    gEl.appendChild(el('rect', { x: 0, y: 0, width: layout.width, height: layout.height, fill: 'none' }));
    const lineOutput = (line) => {
      const dem = ir.ports.find((p) => p.role === 'demand' && p.line === line);
      if (dem) return dem.rate;
      let best = 0; const set = new Set((lineTiles.get(line) || []).map((t) => t.id));
      for (const b of ir.belts) if (b.kind === 'material' && set.has(b.from) && !set.has(b.to)) best = Math.max(best, b.rate);
      return best;
    };

    // ---- group boxes (behind), deepest first ----
    for (const b of [...layout.boxes].sort((a, c) => (c.depth || 0) - (a.depth || 0))) {
      // .cluster CSS only sets opacities/stroke-width — the original supplies fill+stroke colour
      // inline, so we must too (otherwise labels default to black). Gold for the Main belt, slate
      // for production lines / branch boxes.
      const col = b.belt ? '#c9a14a' : '#7a9cc6';
      gEl.appendChild(el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: 'cluster' + (b.belt ? ' belt' : ''), fill: col, stroke: col }));
      if (b.belt) { const lb = el('text', { x: b.x + 10, y: b.y + 16, class: 'clusterlabel', fill: col }); lb.textContent = b.label; gEl.appendChild(lb); continue; }
      if (b.depth === 0 && b.line) {
        const maxc = Math.floor((b.w - 20) / 6);
        const name = el('text', { x: b.x + 10, y: b.y + 16, class: 'clusterlabel', fill: col }); name.textContent = `${b.line} line`; gEl.appendChild(name);
        const out = el('text', { x: b.x + 10, y: b.y + 31, class: 'clustersub', fill: col }); out.textContent = `● ${fmt(lineOutput(b.line))} ${b.line}/min`; gEl.appendChild(out);
        const sum = (lineTiles.get(b.line) || []).map((t) => `${t.count}× ${t.machine}`).join(' + ');
        const ms = el('text', { x: b.x + 10, y: b.y + 46, class: 'clustersub', fill: col }); ms.textContent = clip(sum, maxc); gEl.appendChild(ms);
      } else if (b.key) {
        // branch sub-box: same metadata as the line box, scoped to this subtree
        const n = nodeById.get(b.key);
        if (n) {
          const maxc = Math.floor((b.w - 20) / 6);
          const name = el('text', { x: b.x + 10, y: b.y + 15, class: 'clusterlabel', fill: col }); name.textContent = n.item; gEl.appendChild(name);
          const out = el('text', { x: b.x + 10, y: b.y + 29, class: 'clustersub', fill: col }); out.textContent = `● ${fmt(n.out)} ${n.item}/min`; gEl.appendChild(out);
          const sub = ir.tiles.filter((t) => t.id === b.key || t.id.startsWith(b.key + '>'));
          const ms = el('text', { x: b.x + 10, y: b.y + 43, class: 'clustersub', fill: col }); ms.textContent = clip(sub.map((t) => `${t.count}× ${t.machine}`).join(' + '), maxc); gEl.appendChild(ms);
        }
      }
    }

    // ---- belts: trunk the util/cash flows; material + feedback drawn individually ----
    const trunks = new Map(); // `${from}|${line}|${kind}` -> {from, kind, item, rate, tos:[]}
    const individual = [];
    for (const b of ir.belts) {
      const back = layout.backEdges.has(b.from + '\t' + b.to);
      if ((b.kind === 'fuel' || b.kind === 'fert' || b.kind === 'cash') && !back) {
        const line = (nodeById.get(b.to) || {}).line || '·';
        const k = `${b.from}|${line}|${b.kind}`;
        if (!trunks.has(k)) trunks.set(k, { from: b.from, kind: b.kind, item: b.item, rate: 0, tos: [], line });
        const tr = trunks.get(k); tr.rate += b.rate; tr.tos.push(b.to);
      } else individual.push({ b, back });
    }
    // trunks: one aggregated line from the source DOWN to the TOP of the consuming line box (a short
    // hop into the box, label in the clear gap above it — not a deep rake to the consumer centroid).
    for (const tr of trunks.values()) {
      const s = pos.get(tr.from); if (!s) continue;
      const cs = tr.tos.map((id) => pos.get(id)).filter(Boolean);
      if (!cs.length) continue;
      const lb = lineBox.get(tr.line);
      let cx = cs.reduce((a, p) => a + p.x + p.w / 2, 0) / cs.length;
      let cy;
      if (lb) { cy = lb.y; cx = Math.min(Math.max(cx, lb.x + 24), lb.x + lb.w - 24); } else { cy = Math.min(...cs.map((p) => p.y)); }
      const exit = { x: s.x + s.w / 2, y: s.y + s.h, nx: 0, ny: 1 }, entry = { x: cx, y: cy, nx: 0, ny: -1 };
      const g = el('g', { class: edgeClass(tr.kind, false) + ' trunk' });
      g.appendChild(el('path', { d: link(exit, entry), 'marker-end': 'url(#arrow)' }));
      const m = mid(exit, entry); edgeLabel(g, m.x, m.y, `${tr.item} ${fmt(tr.rate)}`);
      gEl.appendChild(g);
    }
    for (const { b, back } of individual) {
      const s = pos.get(b.from), t = pos.get(b.to); if (!s || !t) continue;
      const g = el('g', { class: edgeClass(b.kind, back) });
      if (back) {
        // Against the grain (ancestor below -> descendant above, across many ranks): fully bespoke
        // routing. Leave the SOURCE'S SIDE (the rail is sideways), detour up a side rail, and enter
        // the target's BOTTOM edge with an angled-up arrow — avoids crossing the chain between them
        // AND a clipped side-edge arrowhead.
        const rightSide = s.x + s.w / 2 >= t.x + t.w / 2;
        const ex = rightSide ? s.x : s.x + s.w, ey0 = s.y + s.h / 2;
        const ey = t.y + t.h;
        const bx = rightSide ? t.x + t.w + 28 : t.x - 28;
        const cx = rightSide ? t.x + t.w - 18 : t.x + 18;
        g.appendChild(el('path', { d: `M${ex},${ey0} C${bx},${ey0} ${bx},${ey + 40} ${cx},${ey}`, 'marker-end': 'url(#arrow)' }));
        edgeLabel(g, bx + (rightSide ? 10 : -10), (ey0 + ey) / 2, `${b.item} ${fmt(b.rate)}`);
      } else {
        // with the grain (adjacent ranks): direct link between the facing edges
        const { exit, entry } = attach(s, t);
        g.appendChild(el('path', { d: link(exit, entry), 'marker-end': 'url(#arrow)' }));
        const m = mid(exit, entry); edgeLabel(g, m.x, m.y, `${b.item} ${fmt(b.rate)}`);
      }
      gEl.appendChild(g);
    }

    // ---- tiles + ports ----
    for (const [id, p] of pos) {
      const tile = tileById.get(id), port = portById.get(id);
      const role = tile ? 'process' : (port.role === 'belt' ? 'external' : port.role);
      const g = el('g', { class: `node ${role}`, transform: `translate(${p.x},${p.y})` });
      g.appendChild(el('rect', { width: p.w, height: p.h, rx: 7 }));
      const maxc = Math.floor((p.w - 16) / 7);
      if (tile) {
        const titleMaxc = Math.floor((p.w - 16 - (hasBadge(tile) ? BADGE_W : 0)) / 7);
        const titleLines = wrap(`${tile.machine} → ${tile.item}`, titleMaxc, 2);
        titleLines.forEach((ln, i) => { const t = el('text', { x: 10, y: 19 + i * 15 }); t.textContent = ln; g.appendChild(t); });
        const subY = titleLines.length === 2 ? 50 : 37;
        const sub = el('text', { x: 10, y: subY, class: 'sub' }); sub.textContent = `${tile.count}× · ${fmt(tile.out)}/min`; g.appendChild(sub);
        if (tile.utilization != null && Math.round(tile.utilization * 100) < 90) {
          const u = el('text', { x: p.w - 8, y: 18, 'text-anchor': 'end', class: 'util' }); u.textContent = `⚙ ${Math.round(tile.utilization * 100)}%`; g.appendChild(u);
        }
        // util/furnace/fert bands across the bottom (clipped to the tile)
        let bi = 0;
        const band = (cls, text) => {
          const idx = bi++;
          const cid = `irclip_${idx}_${id.replace(/[^a-z0-9]/gi, '')}`;
          const cp = el('clipPath', { id: cid }); cp.appendChild(el('rect', { width: p.w, height: p.h, rx: 7 })); g.appendChild(cp);
          const bg = el('g', { 'clip-path': `url(#${cid})` });
          bg.appendChild(el('rect', { x: 0, y: p.h - BAND_H * (idx + 1), width: p.w, height: BAND_H, class: cls }));
          const bt = el('text', { x: 8, y: p.h - 5 - BAND_H * idx, class: cls + 'text' }); bt.textContent = clip(text, maxc); bg.appendChild(bt);
          g.appendChild(bg);
        };
        if (tile.fuelItem && tile.fuelPerMin > 0) band('fuelband', `🔥 ${fmt(tile.fuelPerMin)} ${tile.fuelItem}/min`);
        if (tile.furnaces) band('fuelband', `🏭 ${tile.furnaces}× ${tile.furnaceItem}`);
        if (tile.fertItem && tile.fertPerMin > 0) band('fertband', `🌱 ${fmt(tile.fertPerMin)} ${tile.fertItem}/min`);
        if (tile.recirc) for (const rc of tile.recirc) band('recircband', `♻ ${fmt(rc.ratePerMin)} ${rc.item}/min`);
      } else {
        const t = el('text', { x: 10, y: 19 }); t.textContent = clip(port.item || port.id, maxc); g.appendChild(t);
        let subText = '';
        if (port.role === 'demand') subText = `${fmt(port.rate)}/min target`;
        else if (port.role === 'belt') subText = `${fmt(port.rate)}/min drawn${port.supplyRate != null ? ` · ${fmt(port.supplyRate)}/min belt supply` : ''}`;
        else if (port.role === 'surplus' || port.role === 'trash') subText = `${fmt(port.rate)}/min`;
        else subText = `${fmt(port.rate)}/min${port.cost ? ` · ${fmtCu(port.cost)}/min` : ' · free'}`;
        const sub = el('text', { x: 10, y: 36, class: 'sub' }); sub.textContent = clip(subText, maxc); g.appendChild(sub);
      }
      gEl.appendChild(g);
    }
  }

  return { layoutIR, drawIR, defaultSizeOf };
}));
