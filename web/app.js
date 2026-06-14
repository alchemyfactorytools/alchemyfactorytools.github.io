'use strict';

// Bump on every app.js change. Echoed by "Copy settings" and compared against the
// server's stamp (/api/items) so a stale-asset mismatch is obvious in a bug report.
const BUILD_STAMP = 'liquid-pipe-cap-2026-06-14q';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
let CATALOG = [];
const allowed = new Set();

// ---------- persistence (skills + belt supply survive reloads) ----------
const STORE_KEY = 'alchfact.prefs.v1';
const SKILLS = ['factory', 'logistics', 'alchemy', 'fuel', 'fertilizer'];
// adder inputs that hold transient text, not a setting worth restoring
const TRANSIENT_FIELDS = new Set(['allowInput', 'beltItem', 'beltRate']);
function savePrefs() {
  const fields = {};
  for (const el of document.querySelectorAll('#controls input[id], #controls select[id]')) {
    if (TRANSIENT_FIELDS.has(el.id)) continue;
    fields[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const prefs = { fields, belt: beltSupply, allowed: [...allowed], orientation, showClusters, utilEdgeMode, layoutMode, collapsed: [...collapsed] };
  try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore quota/private mode */ }
}
function loadPrefs() {
  let prefs;
  try { prefs = JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); } catch (e) { prefs = {}; }
  // restore every saved form field by id (output item, rate, unit, tier, cauldron,
  // byproducts, capital, buildability, skills, … — everything in the sidebar)
  if (prefs.fields) for (const [id, val] of Object.entries(prefs.fields)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
  }
  // backward-compat with the old field-by-field format
  if (prefs.skills) for (const s of SKILLS) if (prefs.skills[s] != null) $('sk_' + s).value = prefs.skills[s];
  if (prefs.maxTier != null && $('maxTier')) $('maxTier').value = prefs.maxTier;
  if (Array.isArray(prefs.belt)) { beltSupply.length = 0; beltSupply.push(...prefs.belt); renderBelt(); }
  if (Array.isArray(prefs.allowed)) { allowed.clear(); prefs.allowed.forEach((n) => allowed.add(n)); renderChips(); }
  if (prefs.orientation === 'LR' || prefs.orientation === 'TB') orientation = prefs.orientation;
  $('orientToggle').textContent = orientation === 'LR' ? '⇄ Horizontal' : '⇅ Vertical';
  if (typeof prefs.showClusters === 'boolean') showClusters = prefs.showClusters;
  $('clusterToggle').style.opacity = showClusters ? '1' : '0.5';
  if (typeof prefs.utilEdgeMode === 'string' && UTIL_MODE_LABEL[prefs.utilEdgeMode]) utilEdgeMode = prefs.utilEdgeMode;
  else if (typeof prefs.showUtilEdges === 'boolean') utilEdgeMode = prefs.showUtilEdges ? 'all' : 'off';
  $('utilEdgeToggle').textContent = UTIL_MODE_LABEL[utilEdgeMode];
  if (typeof prefs.layoutMode === 'string' && LAYOUT_LABEL[prefs.layoutMode]) layoutMode = prefs.layoutMode;
  else if (typeof prefs.useLayout2 === 'boolean') layoutMode = prefs.useLayout2 ? '2d' : 'classic'; // migrate old pref
  $('layoutToggle').textContent = LAYOUT_LABEL[layoutMode];
  if (Array.isArray(prefs.collapsed)) { collapsed.clear(); prefs.collapsed.forEach((k) => collapsed.add(k)); }
}

// ---------- bootstrap ----------
async function init() {
  const items = await (await fetch('/api/items')).json();
  CATALOG = items;
  const itemList = $('items');
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.name;
    itemList.appendChild(o);
  }
  const buyList = $('buyables');
  for (const it of items.filter((x) => x.buyPrice != null || x.mintable)) {
    const o = document.createElement('option');
    o.value = it.name;
    buyList.appendChild(o);
  }
  $('version').textContent = 'dataset 0.5.0.4471 · DB v41';
  loadPrefs();
  // persist any sidebar field edit (typing the output/rate, toggling a checkbox, …)
  $('controls').addEventListener('change', savePrefs);
  $('controls').addEventListener('input', savePrefs);
}

// ---------- allowed-inputs chips ----------
function renderChips() {
  const box = $('allowChips');
  box.innerHTML = '';
  for (const name of allowed) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = name;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { allowed.delete(name); renderChips(); savePrefs(); };
    chip.appendChild(x);
    box.appendChild(chip);
  }
}
$('allowInput').addEventListener('change', (e) => {
  const name = e.target.value.trim();
  if (name && CATALOG.some((c) => c.name === name)) { allowed.add(name); renderChips(); savePrefs(); }
  e.target.value = '';
});

// ---------- main belt supply editor ----------
const beltSupply = []; // [{item, rate|null}]
function renderBelt() {
  const box = $('beltRows');
  box.innerHTML = '';
  beltSupply.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'belt-row';
    const fert = CATALOG.find((c) => c.name === b.item);
    const tag = fert && fert.cauldronTarget == null && b.item.match(/Fertilizer|Potion|Catalyst/) ? ' 🌱' : '';
    row.innerHTML = `<span class="belt-item">${esc(b.item)}${tag}</span><span class="belt-rate">${b.rate == null ? '∞' : fmt(b.rate) + '/min'}</span>`;
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { beltSupply.splice(i, 1); renderBelt(); savePrefs(); };
    row.appendChild(x);
    box.appendChild(row);
  });
}
$('beltAdd').onclick = () => {
  const item = $('beltItem').value.trim();
  if (!item || !CATALOG.some((c) => c.name === item)) { setStatus('Pick a valid belt item.', 'error'); return; }
  const rateRaw = $('beltRate').value.trim();
  const rate = rateRaw === '' ? null : Number(rateRaw);
  beltSupply.push({ item, rate: Number.isFinite(rate) ? rate : null });
  $('beltItem').value = ''; $('beltRate').value = '';
  renderBelt();
  savePrefs();
};

// ---------- build config from controls ----------
const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function buildConfig() {
  const cfg = { cauldron: {}, byproducts: {}, machines: {}, skills: {} };
  cfg.cauldron.enabled = $('cauldronEnabled').checked;
  cfg.cauldron.inputPool = $('pool').value;
  const forbid = splitList($('forbidCauldron').value);
  const force = splitList($('forceCauldron').value);
  if (forbid.length) cfg.cauldron.forbidFor = forbid;
  if (force.length) cfg.cauldron.forceFor = force;
  cfg.byproducts.mode = $('byproducts').value;
  const trash = splitList($('byproductTrash').value);
  if (trash.length) cfg.byproducts.perItem = Object.fromEntries(trash.map((i) => [i, 'trash']));
  cfg.selfFuel = $('selfFuel').checked;
  cfg.selfFert = $('selfFert').checked;
  cfg.belt = beltSupply.map((b) => (b.rate == null ? { item: b.item } : { item: b.item, rate: b.rate }));
  cfg.machines.defaultCount = Number($('machines').value) || 1000;
  cfg.capital = { enabled: $('capital').checked }; // amortization knob removed; Model uses a fixed sane default
  cfg.buildabilityFraction = Number($('buildability').value) || 0; // × item value → per-machine penalty (server)
  cfg.cauldronChainFraction = Number($('cauldronChain').value) || 0; // weight per cauldron→cauldron input (server)
  cfg.costTolerance = Number($('costTolerance').value) || 0; // copper/item: below this, prefer fewest machines (server)
  const tier = $('maxTier').value;
  cfg.maxTier = tier === '' ? null : Number(tier);
  for (const s of ['factory', 'logistics', 'alchemy', 'fuel', 'fertilizer']) {
    cfg.skills[s] = Number($('sk_' + s).value) || 0;
  }
  if (allowed.size) cfg.buy = { allow: [...allowed] };
  return cfg;
}

function requestBody() {
  let rate = Number($('rate').value);
  const unit = $('rateUnit').value;
  if (unit === 'sec') rate *= 60;
  const rateMode = unit === 'machines' ? 'machines' : 'rate';
  return { item: $('item').value.trim(), rate, rateMode, config: buildConfig() };
}

// ---------- solve ----------
async function solve() {
  const body = requestBody();
  if (!body.item) { setStatus('Pick an output item.', 'error'); return; }
  setStatus('Solving…', '');
  $('summary').innerHTML = '';
  let out;
  try {
    out = await (await fetch('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  } catch (e) { setStatus('Request failed: ' + e.message, 'error'); return; }

  if (out.error) { setStatus(out.error, 'error'); return; }
  if (out.status === 'Infeasible') {
    let msg = 'INFEASIBLE — ' + (out.probe?.detail ?? 'no production route under these settings.');
    if (out.probe?.needed?.length) {
      msg += ' Raise machine count: ' + out.probe.needed.map((n) => `${n.machine} needs ~${n.needed} (have ${n.configured})`).join(', ') + '.';
    }
    if (out.probe?.cause === 'structural' && $('maxTier').value !== '') {
      msg += ` Your Unlock tier (${$('maxTier').value}) may be locking a required item — try raising it.`;
    }
    setStatus(msg, 'error');
    clearGraph();
    return;
  }
  if (out.status !== 'Optimal') { setStatus('Solve returned: ' + out.status, 'error'); return; }

  renderSummary(out, body);
  renderGraph(out.graph);
  $('explain').textContent = out.explainText || '';
  let status = `Solved in ${out.cgRounds} CG round(s). ${fmtCu(out.copperPerItem)} per ${body.item}.`;
  if (out.machineTarget) status = `Building ${out.machineTarget}× ${body.item} machine(s) = ${fmt(out.effectiveRate)}/min. ` + status;
  setStatus(status, 'ok');
  if (out.warnings?.length) {
    $('status').insertAdjacentHTML('beforeend', out.warnings.map((w) => `<span class="warn">⚠ ${esc(w)}</span>`).join(''));
  }
  if (out.graph.summary.validation?.length) {
    const v = out.graph.summary.validation;
    $('status').insertAdjacentHTML('beforeend', `<span class="warn">⚠ graph incomplete: ${v.length} edge issue(s) — ${esc(v.slice(0, 3).map((i) => `${i.label} ${i.kind} ${i.item}`).join('; '))}${v.length > 3 ? '…' : ''}</span>`);
  }
  if (out.graph.summary.fragileRoutes) {
    $('status').insertAdjacentHTML('beforeend', `<span class="warn">⚠ ${out.graph.summary.fragileRoutes} cauldron route(s) ride fragile/tie margins — verify in-game.</span>`);
  }
  if (out.graph.summary.selfSustaining) {
    $('status').insertAdjacentHTML('beforeend', `<span class="warn">⚠ Materially self-sustaining: external spend ≈ 0; the binding limit is machines, not copper.</span>`);
  }
}

function setStatus(msg, cls) { const s = $('status'); s.className = 'status ' + (cls || ''); s.textContent = msg; }

function renderSummary(out, body) {
  const s = out.graph.summary;
  const machineList = Object.entries(s.machineTotals).sort((a, b) => b[1] - a[1]);
  const totalMachines = machineList.reduce((a, [, n]) => a + n, 0);
  let html = '<div class="stat-row">';
  html += `<div class="stat">Cost <b>${fmtCu(out.copperPerMin)}</b>/min</div>`;
  html += `<div class="stat">Per item <b>${fmtCu(out.copperPerItem)}</b></div>`;
  if (s.capitalPerMin > 0.01) {
    html += `<div class="stat">Mat <b>${fmtCu(s.materialPerMin)}</b> · cap <b>${fmtCu(s.capitalPerMin)}</b>/min</div>`;
  }
  html += `<div class="stat">Machines <b>${totalMachines}</b></div>`;
  if (s.externals.length) {
    html += `<div class="stat">Inputs <b>${s.externals.map((e) => `${esc(e.item)} ${fmt(e.ratePerMin)}/min`).join('</b>, <b>')}</b></div>`;
  }
  html += '</div>';
  // machine totals as compact wrapping chips (was a tall 20-row table)
  if (machineList.length) {
    html += '<div class="machine-chips">' +
      machineList.map(([m, n]) => `<span class="mchip">${esc(m)} <b>×${n}</b></span>`).join('') + '</div>';
  }
  $('summary').innerHTML = html;
}

// ---------- layered SVG graph ----------
let viewState = { k: 1, x: 0, y: 0 };
let orientation = 'TB';   // 'TB' vertical (default) | 'LR' horizontal
let showClusters = true;  // draw labeled production-line containers
// layout engine: 'classic' (layout.js) | '2d' (layout2.js, lane-based) | '2dn'
// (layout3.js, lane-based + vertical nesting of wide shared producers over their
// consumers). '2d' and '2dn' both use the per-line split + container rendering.
let layoutMode = 'classic';
const LAYOUT_LABEL = { classic: '⊞ Layout: classic', '2d': '⊞ Layout: 2D', '2dn': '⊞ Layout: 2D-nested' };
const engineFor = (m) => (m === '2dn' && window.AlchLayout3) ? AlchLayout3 : (m === '2d' && window.AlchLayout2) ? AlchLayout2 : AlchLayout;
const isLayout2ish = (m) => m === '2d' || m === '2dn';
const collapsed = new Set(); // cluster ids folded into a single group node (drill-down)
const COLLAPSE_ENABLED = false; // line collapse/drill-down temporarily disabled (re-clustering made it confusing)
// fuel/fert distribution edges: 'all' = every source→machine edge, 'trunk' = one
// aggregated edge per line box, 'off' = rely on the per-machine bands only.
let utilEdgeMode = 'trunk';
const UTIL_MODE_LABEL = { all: '🔥 Fuel/fert: all', trunk: '🔥 Fuel/fert: trunk', off: '🔥 Fuel/fert: off' };
const UTIL_MODE_NEXT = { all: 'trunk', trunk: 'off', off: 'all' };
let lastGraph = null;     // cached so the orientation toggle can re-render
const CLUSTER_COLORS = ['#7a9cc6', '#c69c7a', '#7ac68f', '#c67a9c', '#9c7ac6', '#c6c07a'];
const NODE_W = 260, NODE_H = 84;
const TITLE_CHARS = 30;
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

function clearGraph() { $('graph').innerHTML = ''; lastGraph = null; }

// Drill-down: fold each cluster in `collapsed` into a single "group" node. Members
// are removed, their external edges rewired to the group node and merged. Pure
// client-side transform of the solved graph — no re-solve, instant.
function applyCollapse(graph) {
  if (!COLLAPSE_ENABLED || !collapsed.size) return graph;
  const ca = AlchLayout.assignClusters(graph);
  const byId = new Map(ca.clusters.map((c) => [c.id, c]));
  const active = [...collapsed].filter((id) => byId.has(id));
  if (!active.length) return graph;
  const groupOf = new Map(); const removed = new Set();
  for (const id of active) for (const m of byId.get(id).members) { groupOf.set(m, id); removed.add(m); }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const groupNodes = active.map((id) => {
    const c = byId.get(id);
    let outRate = 0, outItem = '';
    for (const e of graph.edges) {
      if (e.heat || e.nutrient) continue;
      if (groupOf.get(e.from) === id && groupOf.get(e.to) !== id) { outRate += e.ratePerMin; outItem = outItem || e.item; }
    }
    const machines = c.members.reduce((s, m) => s + ((nodeById.get(m) || {}).machineCount || 0), 0);
    return { id: 'group:' + id, type: 'process', kind: 'group', groupId: id, label: c.label, sub: outItem, ratePerMin: outRate, machineCount: machines || null, machine: machines ? `${c.members.length} steps` : null, collapsedCount: c.members.length, blueprint: c.tile, badges: [] };
  });
  const remap = (x) => (groupOf.has(x) ? 'group:' + groupOf.get(x) : x);
  const em = new Map();
  for (const e of graph.edges) {
    const f = remap(e.from), t = remap(e.to);
    if (f === t) continue; // internal to a collapsed group
    const k = `${f}\t${t}\t${e.heat ? 'h' : e.nutrient ? 'n' : 'm'}\t${e.item || ''}`;
    let m = em.get(k);
    if (!m) { m = { ...e, from: f, to: t, ratePerMin: 0 }; em.set(k, m); }
    m.ratePerMin += e.ratePerMin;
  }
  return { nodes: graph.nodes.filter((n) => !removed.has(n.id)).concat(groupNodes), edges: [...em.values()], summary: graph.summary };
}

// Split shared, purely use-proportional "base good" producers (nurseries, smelters,
// crushers, saws — any single-step-from-raw maker) into per-line dedicated copies. A
// nursery's nutrient draw scales with USED output (backpressure idles the rest), so one
// shared 24× Flax nursery feeding three lines costs the same nutrient + same total
// buildings as three dedicated nurseries (8/10/6) — it just rakes crop edges across the
// whole graph. The SAME holds for a furnace's fuel: it comes off the main belt just like
// fertilizer, so a buy-ore→smelter→ingot chain is a base good too (Iron Ore + Iron
// Smelter, Limestone + Stone Crusher, Logs + Wood Saw, …). Splitting makes each line
// self-contained and tileable, at no ongoing cost beyond per-line machine rounding.
//   base good   = a process whose every ITEM input comes from a raw node (Buy/input/
//                 resource), or that has none at all (grown in a Nursery). Fuel/heat is
//                 a belt resource (like fertilizer), so it does NOT disqualify it.
//   shared only = must feed ≥2 distinct production lines (else nothing to untangle).
function splitBaseGoods(graph) {
  const cl = AlchLayout.assignClusters(graph);
  const lineOf = (id) => cl.clusterOf.get(id) ?? '·loose';
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const RAW = new Set(['external', 'input', 'resource']);
  const isItemEdge = (e) => !e.heat && !e.nutrient && !e.cash;
  const itemIn = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (isItemEdge(e) && itemIn.has(e.to)) itemIn.get(e.to).push(e);
  const isBaseGood = (n) => n.type === 'process'
    && itemIn.get(n.id).every((e) => RAW.has((byId.get(e.from) || {}).type));
  // A main-belt supply tap is splittable too: a conveyor is physically tapped at many
  // points, so showing it as one box per consumer cluster (each fed by a short edge)
  // is realistic, not a fudge — and untangles the coin/fert rake across the canvas.
  const isBelt = (n) => n.type === 'external' && n.kind === 'belt';
  // A purchase (Buy X) is just a coin draw + purchasing portal — in-game you'd place one
  // per consuming line, not a single shared buy stranded between two lines. So split it
  // per-line too, keeping each Buy tightly coupled to the machine it feeds.
  const isPurchase = (n) => n.type === 'external' && n.kind === 'purchase';
  const splittable = (n) => isBelt(n) || isBaseGood(n) || isPurchase(n);
  // Resolve a consumer to the PRODUCT line(s) it serves. A split base good (nursery)
  // resolves to ITS OWN output lines — so a fert/coin tap feeding a nursery is grouped
  // by the cauldron the nursery ultimately feeds, not by each co-located nursery
  // sub-line (which is what spawned the redundant "two Growth boxes, same region").
  // Recurse through splittable chains: a purchase→smelter→ingot stack resolves to the
  // PRODUCT lines the ingot ultimately feeds, so every link in the chain (Buy Ore, the
  // coin tap funding it, the smelter) splits on the SAME line keys — otherwise the cash
  // edge from a split coin tap to a split Buy lands on mismatched keys (dangling edge).
  // `seen` is the current DFS PATH (cycle guard), not a global visited set — it must
  // be cloned per recursion and never mutated in place. A shared mutable `seen` lets one
  // sibling branch's additions truncate the next sibling, so groupLines(X) under-resolves
  // X's line set vs. computing it per-consumer. That mismatch makes a split source get
  // fewer per-line copies than a downstream consumer references → dangling edges (and a
  // layout crash). Cloning keeps each branch independent while still breaking cycles.
  const groupLines = (id, seen) => {
    seen = seen || new Set();
    if (seen.has(id)) return [lineOf(id)];
    const n = byId.get(id);
    if (n && (isBaseGood(n) || isPurchase(n))) {
      const childSeen = new Set(seen).add(id);
      const outs = [...new Set(graph.edges.filter((e) => e.from === id && isItemEdge(e)).flatMap((e) => groupLines(e.to, childSeen)))];
      if (outs.length) return outs;
    }
    return [lineOf(id)];
  };
  const split = graph.nodes.filter((n) => {
    if (!splittable(n)) return false;
    const lines = new Set();
    for (const e of graph.edges) if (e.from === n.id) for (const L of groupLines(e.to)) lines.add(L);
    return lines.size >= 2;
  });
  if (!split.length) return graph;
  const splitSet = new Set(split.map((n) => n.id));
  const copyId = (id, line) => `${id}@@${line}`;
  // rate each product line draws from each split node — fan each out-edge across the
  // product line(s) its consumer serves.
  const rateByLine = new Map(); // nodeId -> Map(line -> rate)
  for (const e of graph.edges) {
    if (!splitSet.has(e.from)) continue;
    const ls = groupLines(e.to);
    const m = rateByLine.get(e.from) || rateByLine.set(e.from, new Map()).get(e.from);
    for (const L of ls) m.set(L, (m.get(L) || 0) + (e.ratePerMin || 0) / ls.length);
  }
  const nodes = graph.nodes.filter((n) => !splitSet.has(n.id));
  for (const n of split) {
    const lines = rateByLine.get(n.id) || new Map();
    const total = [...lines.values()].reduce((a, b) => a + b, 0) || 1;
    for (const [line, rate] of lines) {
      const f = rate / total;
      nodes.push({
        ...n, id: copyId(n.id, line), ratePerMin: rate,
        machineCount: n.machineCount ? Math.max(1, Math.ceil(n.machineCount * f)) : n.machineCount,
        tileLoad: n.tileLoad != null ? n.tileLoad * f : n.tileLoad, // continuous load follows the line's share
        nutrientPerMin: (n.nutrientPerMin || 0) * f, fertPerMin: (n.fertPerMin || 0) * f,
        heatPerMin: (n.heatPerMin || 0) * f, fuelPerMin: (n.fuelPerMin || 0) * f, // fuel scales with the line's share
        copperPerMin: (n.copperPerMin || 0) * f, // each per-line Buy carries its share of the spend
        beltLanes: n.beltLanes ? Math.max(1, Math.ceil(n.beltLanes * f)) : n.beltLanes,
      });
    }
  }
  const edges = [];
  for (const e of graph.edges) {
    const fromSplit = splitSet.has(e.from), toSplit = splitSet.has(e.to);
    if (!fromSplit && !toSplit) { edges.push(e); continue; }
    if (toSplit) { // consumer is split: fan to its per-line copies (by each copy's
      // output fraction). If the source is ALSO split it shares the product-line key,
      // so route from the source copy serving that same line — no dangling endpoint.
      const lines = rateByLine.get(e.to) || new Map();
      const total = [...lines.values()].reduce((a, b) => a + b, 0) || 1;
      for (const [line, rate] of lines) {
        const from = fromSplit ? copyId(e.from, line) : e.from;
        edges.push({ ...e, from, to: copyId(e.to, line), ratePerMin: (e.ratePerMin || 0) * (rate / total) });
      }
    } else { // only the source is split → route to the copy serving the consumer's line(s)
      const ls = groupLines(e.to);
      for (const L of ls) edges.push({ ...e, from: copyId(e.from, L), ratePerMin: (e.ratePerMin || 0) / ls.length });
    }
  }
  // Safety net: the per-line keying above can, in rare chained-split cases, reference a
  // source/target copy that wasn't created. Drop any such dangling edge rather than let
  // it reach the layout (an edge endpoint with no node crashes the spanning-tree walk).
  const liveIds = new Set(nodes.map((n) => n.id));
  const liveEdges = edges.filter((e) => liveIds.has(e.from) && liveIds.has(e.to));
  return { nodes, edges: liveEdges, summary: graph.summary };
}

function renderGraph(rawGraph) {
  lastGraph = rawGraph;
  let graph = applyCollapse(rawGraph);
  if (isLayout2ish(layoutMode) && engineFor(layoutMode) !== AlchLayout) graph = splitBaseGoods(graph);
  const svg = $('graph');
  svg.innerHTML = '';
  const defs = document.createElementNS(SVGNS, 'defs');
  // context-stroke makes each arrowhead inherit its edge's stroke colour — so it
  // turns gold on hover, red for fuel, green for fertilizer, automatically.
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>`;
  svg.appendChild(defs);
  const root = document.createElementNS(SVGNS, 'g');
  root.setAttribute('id', 'viewport');
  svg.appendChild(root);

  const ENGINE = engineFor(layoutMode);
  const { pos, edges: edgePts, recycle, clusters, trunks, trunkedEdges } = ENGINE.layout(graph, { nodeW: NODE_W, nodeH: NODE_H, orientation, clusters: showClusters });

  // map each node to its line's tile blueprint, so a node can show "2× per tile (8× total)"
  const tileByKey = new Map((clusters || []).filter((c) => c.key && c.tile).map((c) => [c.key, c.tile]));
  const clOf = ENGINE.assignClusters ? ENGINE.assignClusters(graph).clusterOf : new Map();
  const perTileOf = (n) => {
    const tile = tileByKey.get(clOf.get(n.id));
    if (!tile || !n.machineCount) return null;
    const cell = tile.cell.find((c) => c.label === n.label);
    return cell ? { perTile: cell.count, total: cell.count * tile.K, K: tile.K } : null;
  };

  // production-line containers (behind everything)
  const cg = document.createElementNS(SVGNS, 'g');
  (clusters || []).forEach((c, i) => {
    const col = c.belt ? 'var(--accent)' : CLUSTER_COLORS[i % CLUSTER_COLORS.length];
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', c.x); r.setAttribute('y', c.y); r.setAttribute('width', c.w); r.setAttribute('height', c.h);
    r.setAttribute('rx', 10); r.setAttribute('class', c.belt ? 'cluster belt' : 'cluster'); r.setAttribute('style', `fill:${col};stroke:${col}`);
    cg.appendChild(r);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', c.x + 10); t.setAttribute('y', c.y + 16); t.setAttribute('class', 'clusterlabel'); t.setAttribute('style', `fill:${col}`);
    // clickable label collapses the line into a single group node (belt isn't collapsible)
    const bp = c.tile;
    // Line 1 = the line name. The tiling blueprint goes on its OWN line below (line 2),
    // so the header stays clean instead of stretching the cell list across the canvas.
    t.textContent = c.belt ? c.label : `${COLLAPSE_ENABLED ? '▾ ' : ''}${c.label} line`;
    if (bp) {
      const cellShort = bp.cell.map((x) => `${x.count}× ${x.machine}`).join(' + ');
      // each tile makes the line's output / K — shown so a tile reads as a self-contained unit.
      const perTile = c.outRate && bp.K ? c.outRate / bp.K : null;
      const rateStr = perTile ? ` · ${fmt(perTile)}${c.outItem ? ' ' + c.outItem : ''}/min per tile` : '';
      const t2 = document.createElementNS(SVGNS, 'text');
      t2.setAttribute('x', c.x + 10); t2.setAttribute('y', c.y + 30); t2.setAttribute('class', 'clustersub'); t2.setAttribute('style', `fill:${col}`);
      t2.textContent = `⬢ ${bp.K}× tiles${rateStr} · each: ${cellShort}${bp.idle > 0.2 ? ` (${Math.round(bp.idle * 100)}% idle)` : ''}`;
      const cellStr = bp.cell.map((x) => `${x.count}× ${x.label} (${x.machine})`).join(' + ');
      const ttl = document.createElementNS(SVGNS, 'title');
      ttl.textContent = `Tileable: build ${bp.K} identical tiles, each one = ${cellStr}. ${Math.round(bp.idle * 100)}% of machine capacity idles (build cost only — backpressure means no extra input/fuel).`;
      t2.appendChild(ttl);
      cg.appendChild(t2);
    }
    if (COLLAPSE_ENABLED && c.key && !c.belt) {
      t.style.cursor = 'pointer';
      t.addEventListener('click', (ev) => { ev.stopPropagation(); collapsed.add(c.key); savePrefs(); renderGraph(lastGraph); });
      const hit = document.createElementNS(SVGNS, 'rect'); // wider click target over the label
      hit.setAttribute('x', c.x); hit.setAttribute('y', c.y); hit.setAttribute('width', Math.min(c.w, 240)); hit.setAttribute('height', 22);
      hit.setAttribute('fill', 'transparent'); hit.style.cursor = 'pointer';
      hit.addEventListener('click', (ev) => { ev.stopPropagation(); collapsed.add(c.key); savePrefs(); renderGraph(lastGraph); });
      cg.appendChild(hit);
    }
    cg.appendChild(t);
  });
  root.appendChild(cg);

  // edges — curved links along the columns; primary solid, recycle/shared dashed
  const eg = document.createElementNS(SVGNS, 'g');
  const edgeGroups = []; // { g, from, to } for hover highlighting
  for (const e of graph.edges) {
    const eo = edgePts.get(e.from + '\t' + e.to);
    if (!eo) continue;
    const fuelEdge = e.heat || e.item === 'HEAT';
    const fertEdge = e.nutrient || e.item === 'NUTRIENT';
    const cashEdge = e.cash; // belt coin → purchase (money)
    if (fuelEdge || fertEdge || cashEdge) {
      if (utilEdgeMode === 'off') continue; // bands carry the info
      if (utilEdgeMode === 'trunk' && trunkedEdges && trunkedEdges.has(e.from + '\t' + e.to)) continue; // drawn as a trunk
    }
    const isRecycle = recycle && recycle.has(e.from + '\t' + e.to);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'edge' + (fuelEdge ? ' heat' : fertEdge ? ' nutrient' : cashEdge ? ' cash' : (isRecycle ? ' recycle' : '')));
    edgeGroups.push({ g, from: e.from, to: e.to, feedback: fuelEdge || fertEdge });
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', ENGINE.edgePath(eo, orientation));
    path.setAttribute('marker-end', 'url(#arrow)');
    g.appendChild(path);
    const m = ENGINE.edgeMid(eo);
    const label = `${e.item} ${fmt(e.ratePerMin)}`;
    for (const cls of ['bg', '']) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', m.x); t.setAttribute('y', m.y - 3);
      t.setAttribute('text-anchor', 'middle'); if (cls) t.setAttribute('class', cls);
      t.textContent = label; g.appendChild(t);
    }
    eg.appendChild(g);
  }
  // trunk edges: one aggregated fuel/fert link per source → line box (trunk mode)
  const trunkGroups = []; // { g, from, tos:[consumer ids] } for hover highlighting
  if (utilEdgeMode === 'trunk' && trunks) {
    for (const t of trunks) {
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'edge trunk ' + (t.heat ? 'heat' : t.nutrient ? 'nutrient' : 'cash'));
      const path = document.createElementNS(SVGNS, 'path');
      const eo = { start: t.start, end: t.end };
      path.setAttribute('d', ENGINE.edgePath(eo, orientation));
      path.setAttribute('marker-end', 'url(#arrow)');
      g.appendChild(path);
      const m = ENGINE.edgeMid(eo);
      const label = `${t.item} ${fmt(t.ratePerMin)}`;
      for (const cls of ['bg', '']) {
        const tx = document.createElementNS(SVGNS, 'text');
        tx.setAttribute('x', m.x); tx.setAttribute('y', m.y - 3);
        tx.setAttribute('text-anchor', 'middle'); if (cls) tx.setAttribute('class', cls);
        tx.textContent = label; g.appendChild(tx);
      }
      eg.appendChild(g);
      trunkGroups.push({ g, from: t.from, tos: t.tos || [] });
    }
  }
  root.appendChild(eg);

  // nodes
  const nodeGroups = new Map(); // id → <g>
  for (const n of graph.nodes) {
    const p = pos.get(n.id);
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'node ' + n.type + (n.kind === 'group' ? ' group' : ''));
    g.setAttribute('transform', `translate(${p.x},${p.y})`);
    nodeGroups.set(n.id, g);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', NODE_W); rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 7);
    g.appendChild(rect);
    // a collapsed line: click to expand it back to its machines
    if (n.kind === 'group') {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => { collapsed.delete(n.groupId); savePrefs(); renderGraph(lastGraph); });
    }
    // badge top-right; title wraps onto up to 2 full-width lines
    const badgeText = (n.badges && n.badges.length) ? n.badges.slice(0, 2).join(' ') : '';
    // Promote the device into the header — "Iron Smelter → Iron Ingot" — so the machine
    // is the headline, not buried in the sub-line. Skip cauldrons (label already names it).
    const pt = perTileOf(n);
    const promote = n.machine && n.machineCount && n.kind !== 'group' && !/⬅|cauldron/i.test(n.label || '');
    const titleText = (n.kind === 'group' ? '▸ ' : '') + (promote ? `${n.machine} → ${n.label}` : n.label) + (n.kind === 'group' ? ' line' : '');
    const titleLines = wrapLabel(titleText, TITLE_CHARS, 2);
    titleLines.forEach((ln, i) => {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', 10); t.setAttribute('y', 19 + i * 15);
      t.textContent = ln;
      g.appendChild(t);
    });
    if (badgeText) {
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('x', NODE_W - 8); t.setAttribute('y', 18); t.setAttribute('text-anchor', 'end');
      t.setAttribute('class', 'badge ' + n.badges[0]);
      t.textContent = badgeText;
      g.appendChild(t);
    }
    // sub-line carries machine count + utilization + throughput together
    const subY = titleLines.length === 2 ? 50 : 37;
    const sub = document.createElementNS(SVGNS, 'text');
    sub.setAttribute('x', 10); sub.setAttribute('y', subY); sub.setAttribute('class', 'sub');
    let subText = '';
    if (n.kind === 'group') subText = `${n.collapsedCount} steps${n.blueprint ? ` · ⬢ ${n.blueprint.K}× cell` : ''}${n.machineCount ? ` · ${n.machineCount} machines` : ''} — click to expand`;
    // tiled line: lead with the per-tile count, then the total to build (machine name is
    // already in the promoted header) — "2× per tile · 8× total · 100/min".
    else if (pt) subText = `${pt.perTile}× per tile · ${pt.total}× total${n.utilization != null ? ` (${Math.round(n.utilization * 100)}%)` : ''} · ${fmt(n.ratePerMin)}/min`;
    else if (n.machineCount && n.utilization != null) subText = `${n.machineCount}× ${promote ? '' : n.machine + ' '}(${Math.round(n.utilization * 100)}%) · ${fmt(n.ratePerMin)}/min`;
    else if (n.machineCount) subText = `${n.machineCount}× ${promote ? '' : n.machine + ' '}· ${fmt(n.ratePerMin)}/min`; // nursery: plot count, no time-util
    else if (n.machine) subText = `${n.machine} · ${fmt(n.ratePerMin)}/min`;
    else if (n.kind === 'belt' && n.beltLanes) subText = `${fmt(n.ratePerMin)}/min · ${n.beltLanes} belt${n.beltLanes > 1 ? 's' : ''} @ ${fmt(n.beltSpeed)}/min`;
    else if (n.type === 'external') subText = `${fmt(n.ratePerMin)}/min${n.copperPerMin ? ' · ' + fmtCu(n.copperPerMin) + '/min' : ' · free'}`;
    else if (n.type === 'demand') subText = `${fmt(n.ratePerMin)}/min target`;
    else if (n.type === 'resource') subText = `${fmt(n.ratePerMin)}/min → ${n.consumerCount} machines`;
    else if (n.type === 'surplus') subText = `${fmt(n.ratePerMin)}/min`;
    sub.textContent = clip(subText, 40);
    g.appendChild(sub);
    // heat/nutrient a machine draws from the pool — shown only on count-less
    // nodes (Nursery crops) where the sub-line is short enough to not collide
    const draws = [];
    if (n.heatPerMin > 0) draws.push(`🔥 ${fmt(n.heatPerMin)}`);
    if (n.nutrientPerMin > 0) draws.push(`🌱 ${fmt(n.nutrientPerMin)}`);
    if (draws.length && n.type === 'process' && !n.machineCount) {
      const d = document.createElementNS(SVGNS, 'text');
      d.setAttribute('x', NODE_W - 8); d.setAttribute('y', subY); d.setAttribute('text-anchor', 'end'); d.setAttribute('class', 'draw');
      d.textContent = draws.join('  ');
      g.appendChild(d);
    }
    // lower-third supply band: fuel a machine burns for heat (red 🔥) or fertilizer
    // it consumes for nutrient (green 🌱). Drawn straight on the consuming machine
    // instead of routing through a burn/fertilize node + pool.
    const drawBand = (cls, text, idx) => {
      const bh = 17;
      const clipEl = document.createElementNS(SVGNS, 'clipPath');
      const cid = `bclip_${idx}_` + n.id.replace(/[^a-z0-9]/gi, '');
      clipEl.setAttribute('id', cid);
      const cr = document.createElementNS(SVGNS, 'rect');
      cr.setAttribute('width', NODE_W); cr.setAttribute('height', NODE_H); cr.setAttribute('rx', 7);
      clipEl.appendChild(cr); g.appendChild(clipEl);
      const band = document.createElementNS(SVGNS, 'g');
      band.setAttribute('clip-path', `url(#${cid})`);
      const br = document.createElementNS(SVGNS, 'rect');
      br.setAttribute('x', 0); br.setAttribute('y', NODE_H - bh * (idx + 1)); br.setAttribute('width', NODE_W); br.setAttribute('height', bh);
      br.setAttribute('class', cls);
      band.appendChild(br);
      const bt = document.createElementNS(SVGNS, 'text');
      bt.setAttribute('x', 8); bt.setAttribute('y', NODE_H - 5 - bh * idx); bt.setAttribute('class', cls + 'text');
      bt.textContent = text;
      band.appendChild(bt);
      g.appendChild(band);
    };
    let bandIdx = 0;
    if (n.fuelItem && n.fuelPerMin > 0) drawBand('fuelband', `🔥 ${fmt(n.fuelPerMin)} ${clip(n.fuelItem, 26)}/min`, bandIdx++);
    if (n.fertItem && n.fertPerMin > 0) drawBand('fertband', `🌱 ${fmt(n.fertPerMin)} ${clip(n.fertItem, 26)}/min`, bandIdx++);
    g.appendChild(makeTitle(n));
    root.appendChild(g);
  }

  // hover: spotlight a node's production lineage — walk UPSTREAM (toward inputs) and
  // DOWNSTREAM (toward outputs) only, never sideways through a shared node into its
  // siblings. Fuel/fert (heat/nutrient) edges are followed only ONE hop, never
  // recursed through: a fertilizer/fuel a line makes feeds back into its own
  // nurseries/furnaces, so recursing through it lit up the entire self-feeding box
  // (hover any cauldron → the whole fert line). One hop still shows "your fertilizer
  // comes from here" without dragging in that source's whole production loop.
  const outAdj = new Map(); // id → [{ id, g, fb }]  (this node → its consumers)
  const inAdj = new Map();  // id → [{ id, g, fb }]  (this node's producers → this node)
  for (const n of graph.nodes) { outAdj.set(n.id, []); inAdj.set(n.id, []); }
  const link = (from, to, g, fb) => { outAdj.get(from)?.push({ id: to, g, fb }); inAdj.get(to)?.push({ id: from, g, fb }); };
  for (const { g, from, to, feedback } of edgeGroups) link(from, to, g, !!feedback);
  for (const { g, from, tos } of trunkGroups) for (const to of tos) link(from, to, g, true); // trunks are fuel/fert
  // seen = material lineage (gates recursion); fbNodes = nodes touched only via a
  // 1-hop fuel/fert edge (highlighted, but never the seed of further recursion, so a
  // feedback edge can't pre-empt a real material path to the same node).
  const walk = (startId, adjMap, seen, fbNodes, edges) => {
    const stack = [startId];
    while (stack.length) {
      for (const { id: nb, g, fb } of adjMap.get(stack.pop()) || []) {
        edges.add(g);
        if (fb) { fbNodes.add(nb); continue; }
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
  };
  for (const [id, g] of nodeGroups) {
    g.addEventListener('mouseenter', () => {
      svg.classList.add('hovering');
      const seen = new Set([id]);
      const fbNodes = new Set();
      const edges = new Set();
      walk(id, inAdj, seen, fbNodes, edges);   // everything that feeds this node
      walk(id, outAdj, seen, fbNodes, edges);  // everything this node feeds
      for (const nid of seen) nodeGroups.get(nid)?.classList.add('hl');
      for (const nid of fbNodes) nodeGroups.get(nid)?.classList.add('hl');
      for (const eg2 of edges) eg2.classList.add('hl');
    });
    g.addEventListener('mouseleave', () => {
      svg.classList.remove('hovering');
      for (const el of svg.querySelectorAll('.hl')) el.classList.remove('hl');
    });
  }

  fitView();
}

function makeTitle(n) {
  const t = document.createElementNS(SVGNS, 'title');
  let txt = n.label;
  if (n.machineCount && n.utilization != null) txt += `\n${n.machineCount}× ${n.machine} at ${Math.round(n.utilization * 100)}% utilization\n${fmt(n.ratePerMin)} runs/min`;
  else if (n.machineCount) txt += `\n${n.machineCount}× ${n.machine}\n${fmt(n.ratePerMin)}/min`;
  if (n.nurseryNote) txt += `\n${n.nurseryNote}`;
  if (n.badges?.length) txt += `\n[${n.badges.join(', ')}]`;
  t.textContent = txt;
  return t;
}

// ---------- pan / zoom ----------
function applyView() { $('viewport')?.setAttribute('transform', `translate(${viewState.x},${viewState.y}) scale(${viewState.k})`); }
function fitView() {
  const vp = $('viewport'); if (!vp) return;
  const bb = vp.getBBox();
  const svg = $('graph'); const w = svg.clientWidth, h = svg.clientHeight;
  if (!bb.width || !bb.height) return;
  const k = Math.min(w / (bb.width + 60), h / (bb.height + 60), 1.4);
  viewState = { k, x: (w - bb.width * k) / 2 - bb.x * k, y: (h - bb.height * k) / 2 - bb.y * k };
  applyView();
}
(function setupPanZoom() {
  const svg = $('graph');
  let drag = null;
  svg.addEventListener('mousedown', (e) => { drag = { x: e.clientX - viewState.x, y: e.clientY - viewState.y }; });
  window.addEventListener('mousemove', (e) => { if (drag) { viewState.x = e.clientX - drag.x; viewState.y = e.clientY - drag.y; applyView(); } });
  window.addEventListener('mouseup', () => { drag = null; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    viewState.x = mx - (mx - viewState.x) * f;
    viewState.y = my - (my - viewState.y) * f;
    viewState.k *= f;
    applyView();
  }, { passive: false });
  $('zoomIn').onclick = () => { viewState.k *= 1.15; applyView(); };
  $('zoomOut').onclick = () => { viewState.k /= 1.15; applyView(); };
  $('zoomFit').onclick = fitView;
  $('orientToggle').onclick = () => {
    orientation = orientation === 'LR' ? 'TB' : 'LR';
    $('orientToggle').textContent = orientation === 'LR' ? '⇄ Horizontal' : '⇅ Vertical';
    savePrefs();
    if (lastGraph) { renderGraph(lastGraph); }
  };
  $('clusterToggle').onclick = () => {
    showClusters = !showClusters;
    $('clusterToggle').style.opacity = showClusters ? '1' : '0.5';
    savePrefs();
    if (lastGraph) { renderGraph(lastGraph); }
  };
  $('utilEdgeToggle').onclick = () => {
    utilEdgeMode = UTIL_MODE_NEXT[utilEdgeMode];
    $('utilEdgeToggle').textContent = UTIL_MODE_LABEL[utilEdgeMode];
    savePrefs();
    if (lastGraph) { renderGraph(lastGraph); }
  };
  $('layoutToggle').onclick = () => {
    const order = ['classic', '2d', '2dn'];
    layoutMode = order[(order.indexOf(layoutMode) + 1) % order.length];
    $('layoutToggle').textContent = LAYOUT_LABEL[layoutMode];
    savePrefs();
    if (lastGraph) { renderGraph(lastGraph); }
  };
  $('mermaidBtn').onclick = async () => {
    const body = requestBody();
    if (!body.item) { setStatus('Pick an item first.', 'error'); return; }
    const res = await fetch('/api/mermaid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { setStatus('No solution to export.', 'error'); return; }
    await navigator.clipboard.writeText(await res.text());
    setStatus('Mermaid diagram copied — paste into GitHub/Notion/Obsidian.', 'ok');
  };
})();

// ---------- DOT export ----------
$('exportDot').onclick = async () => {
  const body = requestBody();
  if (!body.item) { setStatus('Pick an item first.', 'error'); return; }
  const res = await fetch('/api/dot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { setStatus('No solution to export.', 'error'); return; }
  const dot = await res.text();
  await navigator.clipboard.writeText(dot);
  setStatus('Graphviz DOT copied to clipboard.', 'ok');
};

// Copy the EXACT request body the browser sends to /api/solve, plus a build stamp, so a
// bug report can be reproduced verbatim. The stamp surfaces stale-asset mismatches.
$('copySettings').onclick = async () => {
  let server = null;
  try { server = await (await fetch('/api/version', { cache: 'no-store' })).json(); } catch (e) { server = { error: String(e) }; }
  const payload = {
    clientStamp: BUILD_STAMP,
    serverStamp: server,           // mismatch with clientStamp ⇒ stale browser or wrong server
    location: location.href,
    request: requestBody(),
  };
  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Settings copied — paste them to reproduce.', 'ok');
  } catch (e) {
    // clipboard can be blocked; fall back to a prompt the user can copy from
    window.prompt('Copy your settings:', text);
  }
};

// ---------- helpers ----------
function fmt(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(1);
  return n.toFixed(3);
}
// Copper-denominated money, shown in coin units: 1 silver = 1,000 copper,
// 1 gold = 100 silver = 100,000 copper. e.g. 280000 → "2g 80s", 1200 → "1s 200c".
function fmtCu(n) {
  if (n == null) return '—';
  const neg = n < 0 ? '-' : '';
  let c = Math.round(Math.abs(n));
  if (c === 0) return '0c';
  const g = Math.floor(c / 100000); c -= g * 100000;
  const s = Math.floor(c / 1000); c -= s * 1000;
  const parts = [];
  if (g) parts.push(g + 'g');
  if (s) parts.push(s + 's');
  if (c || !parts.length) parts.push(c + 'c');
  return neg + parts.slice(0, 2).join(' '); // two most-significant denominations
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

$('solve').onclick = solve;
$('item').addEventListener('keydown', (e) => { if (e.key === 'Enter') solve(); });
$('sidebarToggle').onclick = () => {
  $('layout').classList.toggle('collapsed');
  setTimeout(fitView, 180); // reframe after the column-width transition
};
init();
