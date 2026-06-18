'use strict';

// Bump on every app.js change. Echoed by "Copy settings" and compared against the
// server's stamp (/api/items) so a stale-asset mismatch is obvious in a bug report.
const BUILD_STAMP = (typeof window !== 'undefined' && window.__BUILD__) || 'dev'; // git sha, injected by build-stamp.js

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
  const prefs = { fields, belt: beltSupply, extraTargets, allowed: [...allowed], orientation, showClusters, utilEdgeMode, layoutMode, collapsed: [...collapsed] };
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
  if (Array.isArray(prefs.extraTargets)) {
    extraTargets.length = 0;
    for (const t of prefs.extraTargets) extraTargets.push({ item: t.item || '', rate: t.rate != null ? t.rate : 1, rateMode: t.rateMode || 'machines' });
    renderTargets();
  }
  if (Array.isArray(prefs.allowed)) { allowed.clear(); prefs.allowed.forEach((n) => allowed.add(n)); renderChips(); }
  // orientation / clusters / util-edge mode only affect the legacy layout3 path (?pipeline=legacy);
  // their toolbar toggles were removed when the IR renderer became the default.
  if (prefs.orientation === 'LR' || prefs.orientation === 'TB') orientation = prefs.orientation;
  if (typeof prefs.showClusters === 'boolean') showClusters = prefs.showClusters;
  if (typeof prefs.utilEdgeMode === 'string' && UTIL_MODE_LABEL[prefs.utilEdgeMode]) utilEdgeMode = prefs.utilEdgeMode;
  else if (typeof prefs.showUtilEdges === 'boolean') utilEdgeMode = prefs.showUtilEdges ? 'all' : 'off';
  if (Array.isArray(prefs.collapsed)) { collapsed.clear(); prefs.collapsed.forEach((k) => collapsed.add(k)); }
}

// Output-picker options: targetable (craftable, non-raw, non-currency) items at or below the current
// Unlock tier, grouped by category. Shared by the primary + every extra target <select>.
function outputGroups() {
  const sel = $('maxTier').value;
  const maxTier = sel === '' ? Infinity : Number(sel);
  const groups = new Map();
  for (const it of CATALOG) {
    if (!it.targetable) continue;                        // craftable, non-raw, non-currency only
    if (it.tier != null && it.tier > maxTier) continue;  // above your unlock tier
    if (!groups.has(it.category)) groups.set(it.category, []);
    groups.get(it.category).push(it.name);
  }
  return groups;
}
// Fill a product <select> with the tier-gated options (optgroups by category), preserving the current
// pick. If the pick is no longer in range (tier lowered), it's kept as a flagged option, not dropped.
function fillOutputSelect(sel, selected) {
  const groups = outputGroups();
  sel.innerHTML = '';
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select a product…';
  sel.appendChild(ph);
  let found = false;
  for (const [cat, names] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const og = document.createElement('optgroup'); og.label = cat;
    for (const n of names.sort()) {
      const o = document.createElement('option'); o.value = n; o.textContent = n;
      if (n === selected) { o.selected = true; found = true; }
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (selected && !found) {
    const o = document.createElement('option'); o.value = selected; o.textContent = `${selected} (above tier)`; o.selected = true;
    sel.appendChild(o);
  }
}
// Belt-supply autocomplete: the same items as the output picker (produced, targetable, tier-gated)
// PLUS raw feedstock (Raw Materials, Seeds) and currency (the money belt) — i.e. everything you'd
// realistically put on an incoming supply belt. RAW_FEEDSTOCK_CATEGORIES mirrors composer-solve.js's
// RAW_TARGET_CATEGORIES (the categories the output picker drops because you buy/mine, not build them).
const RAW_FEEDSTOCK_CATEGORIES = new Set(['Raw Materials', 'Seeds']);
function rebuildBeltList() {
  const dl = $('items');
  if (!dl) return;
  const sel = $('maxTier').value;
  const maxTier = sel === '' ? Infinity : Number(sel);
  const names = CATALOG
    .filter((it) => {
      if (it.category === 'Currency') return true; // coins are minted, not tier-unlocked — always allow (money belt)
      if (!(it.targetable || RAW_FEEDSTOCK_CATEGORIES.has(it.category))) return false;
      return it.tier == null || it.tier <= maxTier;  // produced + raw feedstock track the output picker's tier gate
    })
    .map((it) => it.name)
    .sort();
  dl.innerHTML = '';
  for (const name of names) { const o = document.createElement('option'); o.value = name; dl.appendChild(o); }
}
// Dispatch mode (primary picker only): the product list narrows to items with a dispatch contract.
function fillDispatchSelect(sel, selected) {
  sel.innerHTML = '';
  const ph = document.createElement('option'); ph.value = ''; ph.textContent = 'Select a dispatch item…';
  sel.appendChild(ph);
  for (const c of CATALOG.filter((c) => c.dispatch)) {
    const o = document.createElement('option'); o.value = c.name; o.textContent = c.name;
    if (c.name === selected) o.selected = true;
    sel.appendChild(o);
  }
}
// Repopulate the primary product picker (dispatch list in dispatch mode, else the tier-gated output
// list) and re-fill every extra target row's picker at the current tier.
function rebuildOutputs() {
  const item = $('item');
  if (!item) return;
  if ($('rateUnit').value === 'dispatch') fillDispatchSelect(item, item.value);
  else fillOutputSelect(item, item.value);
  rebuildBeltList(); // keep the belt-supply list tier-synced with the output picker
  renderTargets();
}

// ---------- bootstrap ----------
async function init() {
  const items = AlchSolver.itemCatalog();
  CATALOG = items;
  // The belt-supply datalist (#items) is built tier-aware by rebuildBeltList(), invoked from
  // rebuildOutputs() below — not filled with the whole catalog here.
  const buyList = $('buyables');
  for (const it of items.filter((x) => x.buyPrice != null || x.mintable)) {
    const o = document.createElement('option');
    o.value = it.name;
    buyList.appendChild(o);
  }
  $('version').textContent = 'dataset 0.5.0.4471 · DB v41';
  const buildEl = $('buildSha'); if (buildEl) buildEl.textContent = BUILD_STAMP;
  const gvEl = $('fGameVer'); if (gvEl && window.AlchSolver && AlchSolver.db) gvEl.textContent = 'v' + AlchSolver.db.gameVersion;
  // Populate the product picker BEFORE restoring prefs (so a saved selection can stick to a real
  // option), then again AFTER (to re-filter to the restored Unlock tier). Dispatch items are filled
  // on demand by rebuildOutputs when the rate unit is "dispatch", so there's no dispatch datalist.
  rebuildOutputs();
  loadPrefs();
  rebuildOutputs();
  updateDispatchUI(); // reflect a restored rateUnit (show/hide the dispatch row + live readout)
  updateSolverUI();   // hide the LP-only tuning block when the composer is selected (it ignores them)
  updateSteamUI();    // reveal the steam free/at-cost selector if "Use steam" was restored on
  updateMultiUI();    // show the multi-target hint + hide "add target" in dispatch mode
  // persist any sidebar field edit (typing the output/rate, toggling a checkbox, …)
  $('controls').addEventListener('change', () => { savePrefs(); updateDispatchUI(); updateSolverUI(); updateSteamUI(); updateMultiUI(); });
  $('controls').addEventListener('input', () => { savePrefs(); updateDispatchUI(); });
  // Keep each "full belt" rate label in sync as Logistics changes (focus is in the Logistics field
  // then, so this never clobbers an in-progress belt-rate edit elsewhere).
  $('sk_logistics').addEventListener('input', renderBelt);
  // Switching INTO dispatch mode with a non-dispatchable item selected clears it (so you're not
  // left targeting an item with no contract). Only on the mode switch — not per keystroke, which
  // would erase partial typing. Validation + the filtered datalist handle the rest.
  $('rateUnit').addEventListener('change', () => {
    if ($('rateUnit').value === 'dispatch' && !dispatchInfo($('item').value.trim())) $('item').value = '';
    rebuildOutputs();   // swap the product picker between dispatch items and the tier-gated output list
    updateDispatchUI();
    updateMultiUI();
  });
  // changing the unlock tier re-filters the output picker (items above the tier drop out)
  $('maxTier').addEventListener('change', rebuildOutputs);
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
const beltSupply = []; // [{item, rate|null}] — rate null = one full belt at the current Logistics level
// Throughput of one belt at the current Logistics skill. A blank/null belt rate means "one full
// belt" rather than unlimited, so it tracks Logistics live (and falls back to 60 pre-bundle-load).
function fullBeltRate() {
  const lvl = Number($('sk_logistics').value) || 0;
  return (window.AlchSolver && AlchSolver.beltSpeed) ? AlchSolver.beltSpeed(lvl) : 60;
}
function renderBelt() {
  const box = $('beltRows');
  box.innerHTML = '';
  const fb = fullBeltRate();
  const lvl = Number($('sk_logistics').value) || 0;
  beltSupply.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'belt-row';
    const fert = CATALOG.find((c) => c.name === b.item);
    const tag = fert && fert.cauldronTarget == null && b.item.match(/Fertilizer|Potion|Catalyst/) ? ' 🌱' : '';
    const item = document.createElement('span');
    item.className = 'belt-item';
    item.innerHTML = `${esc(b.item)}${tag}`;
    const rate = document.createElement('span');
    rate.className = 'belt-rate' + (b.rate == null ? ' belt-rate-auto' : '');
    rate.textContent = `${fmt(b.rate == null ? fb : b.rate)}/min`;
    rate.title = b.rate == null
      ? `Full belt at Logistics ${lvl} (${fmt(fb)}/min) — click to set a fixed cap`
      : 'Click to edit · clear to revert to a full belt';
    rate.onclick = () => editBeltRate(i, rate);
    const x = document.createElement('button');
    x.textContent = '×';
    x.onclick = () => { beltSupply.splice(i, 1); renderBelt(); savePrefs(); };
    row.append(item, rate, x);
    box.appendChild(row);
  });
}
// Inline-edit a belt row's rate: swap the rate label for a number input. Empty commit reverts the
// row to "full belt" (rate = null); any number sets a fixed /min cap. Enter/blur commit, Esc cancels.
function editBeltRate(i, span) {
  const b = beltSupply[i];
  const input = document.createElement('input');
  input.type = 'number'; input.min = '0'; input.step = 'any';
  input.className = 'belt-rate-edit';
  input.value = b.rate == null ? '' : b.rate;
  input.placeholder = `${fmt(fullBeltRate())} (full belt)`;
  span.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const raw = input.value.trim();
    const n = Number(raw);
    b.rate = raw === '' || !Number.isFinite(n) || n < 0 ? null : n;
    renderBelt(); savePrefs();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { done = true; renderBelt(); }
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

// ---------- extra output targets (composer multi-target) ----------
// Outputs BEYOND the primary Target above. Each row carries its own item + qty + unit; the composer
// builds one replicated tile tree per target, all sharing the fuel/fert trunks + co-product surplus.
const extraTargets = []; // [{ item, rate, rateMode: 'min'|'sec'|'machines' }]
function renderTargets() {
  const box = $('extraTargets');
  if (!box) return;
  box.innerHTML = '';
  extraTargets.forEach((t, i) => {
    const block = document.createElement('div');
    block.className = 'target';
    const item = document.createElement('select');
    item.className = 't-item';
    fillOutputSelect(item, t.item || '');
    item.addEventListener('change', () => { t.item = item.value; savePrefs(); });
    const qty = document.createElement('div');
    qty.className = 't-qty-row';
    const at = document.createElement('span'); at.className = 'at'; at.textContent = '@';
    const rate = document.createElement('input');
    rate.type = 'number'; rate.className = 't-rate'; rate.min = '0'; rate.step = 'any'; rate.value = t.rate;
    rate.addEventListener('input', () => { t.rate = Number(rate.value); savePrefs(); });
    const unit = document.createElement('select');
    unit.className = 't-unit';
    for (const [v, label] of [['min', '/ min'], ['sec', '/ sec'], ['machines', '× machines']]) {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      if (v === t.rateMode) o.selected = true;
      unit.appendChild(o);
    }
    unit.addEventListener('change', () => { t.rateMode = unit.value; savePrefs(); });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 't-del'; del.title = 'Remove this target'; del.textContent = '×';
    del.onclick = () => { extraTargets.splice(i, 1); renderTargets(); updateMultiUI(); savePrefs(); };
    qty.append(at, rate, unit, del);
    block.append(item, qty);
    box.appendChild(block);
  });
}
// Reveal the multi-target hint when extras exist; hide "add target" in dispatch mode (single-quota).
function updateMultiUI() {
  const dispatch = $('rateUnit').value === 'dispatch';
  const has = extraTargets.length > 0;
  const add = $('addTarget'); if (add) add.style.display = dispatch ? 'none' : '';
  const hint = $('multiHint'); if (hint) hint.style.display = (!dispatch && has) ? '' : 'none';
  const extras = $('extraTargets'); if (extras) extras.style.display = dispatch ? 'none' : '';
  // the primary target is removable only when another target exists — never delete the last one
  const delP = $('delPrimary'); if (delP) delP.style.display = (!dispatch && has) ? '' : 'none';
}
$('addTarget').onclick = () => {
  // inherit the primary row's unit so "set primary to × machines, add row" keeps machines
  const u = $('rateUnit').value;
  const rateMode = (u === 'min' || u === 'sec' || u === 'machines') ? u : 'machines';
  extraTargets.push({ item: '', rate: 1, rateMode });
  renderTargets();
  updateMultiUI();
  savePrefs();
};
// Remove the PRIMARY target by promoting the first extra into its slot — the primary controls own the
// canonical #item/#rate/#rateUnit ids (dispatch + persistence read them), so we shift rather than delete.
// Only reachable when an extra exists (updateMultiUI hides the button otherwise), so the last target stays.
$('delPrimary').onclick = () => {
  if (!extraTargets.length) return;
  const next = extraTargets.shift();
  fillOutputSelect($('item'), next.item || '');
  $('item').value = next.item || '';
  $('rate').value = next.rate;
  $('rateUnit').value = next.rateMode || 'min';
  renderTargets();
  updateDispatchUI();
  updateMultiUI();
  savePrefs();
};

// ---------- build config from controls ----------
const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function buildConfig() {
  const cfg = { cauldron: {}, byproducts: {}, machines: {}, skills: {} };
  cfg.solver = $('solver').value; // 'lp' (default) | 'composer' (deterministic tile composer)
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
  cfg.steam = { enabled: $('useSteam').checked, mode: $('steamMode').value }; // composer: central steam for heat
  // A null/blank belt rate means "one full belt at the current Logistics level", so resolve it to
  // that concrete /min here instead of emitting an uncapped supply.
  cfg.belt = beltSupply.map((b) => ({ item: b.item, rate: b.rate == null ? fullBeltRate() : b.rate }));
  cfg.machines.defaultCount = Number($('machines').value) || 1000;
  cfg.capital = { enabled: $('capital').checked }; // amortization knob removed; Model uses a fixed sane default
  cfg.buildabilityFraction = Number($('buildability').value) || 0; // × item value → per-machine penalty (server)
  cfg.cauldronChainFraction = Number($('cauldronChain').value) || 0; // weight per cauldron→cauldron input (server)
  cfg.costTolerance = Number($('costTolerance').value) || 0; // copper/item: below this, prefer fewest machines (server)
  cfg.farmWeight = Number($('farmPenalty').value) || 0; // ×(1+w) build-cost markup on Nursery+Cauldron (server)
  const tier = $('maxTier').value;
  cfg.maxTier = tier === '' ? null : Number(tier);
  for (const s of ['factory', 'logistics', 'alchemy', 'fuel', 'fertilizer']) {
    cfg.skills[s] = Number($('sk_' + s).value) || 0;
  }
  if (allowed.size) cfg.buy = { allow: [...allowed] };
  return cfg;
}

// ---------- dispatch quota (output target) ----------
// "Saturate dispatch quota" targets the /min rate that exactly fills an item's daily dispatch
// quota: rate = dailyMaxBase · (1 + 0.25·Negotiation) / dayLengthMin (base day 16 min). There is
// ONE quota per item — adding portals does NOT raise it; only Negotiation does — so there's no
// count to pick. Contract data rides on the item catalog (server attaches `dispatch`). Pure
// client-side math: the solver only ever sees the resolved /min rate, no server solve changes.
const dispatchInfo = (name) => (CATALOG.find((c) => c.name === name) || {}).dispatch || null;
const dispatchNames = () => CATALOG.filter((c) => c.dispatch).map((c) => c.name);
const dispatchDailyMax = (d, neg) => d.dailyMaxBase * (1 + 0.25 * neg);
function dispatchRate(name, neg, dayLen) {
  const d = dispatchInfo(name);
  if (!d || !(dayLen > 0)) return 0;
  return dispatchDailyMax(d, neg) / dayLen;
}

function requestBody() {
  let rate = Number($('rate').value);
  const unit = $('rateUnit').value;
  if (unit === 'sec') rate *= 60;
  let rateMode = unit === 'machines' ? 'machines' : 'rate';
  const config = buildConfig();
  if (unit === 'dispatch') {
    // no quantity field — saturate the whole quota for the item.
    rate = dispatchRate($('item').value.trim(), Number($('sk_negotiation').value) || 0, Number($('dispatchDayLen').value) || 16);
    rateMode = 'rate';
    // dispatch runs continuously → optimise for profit (minimise true operating cost), not build ease.
    config.composer = { ...(config.composer || {}), profit: true };
  }
  const primary = { item: $('item').value.trim(), rate, rateMode };
  // Extra targets (composer multi-target). Ignored in dispatch mode (a single quota). Each row carries
  // its own unit: /sec → /min, "machines" stays a rateMode the composer sizes per target.
  const targets = [primary];
  if (unit !== 'dispatch') {
    for (const t of extraTargets) {
      if (!t.item) continue;
      let r = Number(t.rate);
      if (!(r > 0)) continue;
      if (t.rateMode === 'sec') r *= 60;
      targets.push({ item: t.item, rate: r, rateMode: t.rateMode === 'machines' ? 'machines' : 'rate' });
    }
  }
  // `item`/`rate`/`rateMode` mirror the primary target so the single-target UI reads (dispatch,
  // status, "pick an item" guards) keep working; `targets` drives the (possibly multi) solve.
  return { item: primary.item, rate: primary.rate, rateMode: primary.rateMode, targets, config };
}

// The LP-only tuning knobs do nothing on the tile composer, so hide them when it's selected —
// leaving Advanced with only the settings that affect the chosen solver.
function updateSolverUI() {
  const lp = $('lpOnly');
  if (lp) lp.style.display = $('solver').value === 'composer' ? 'none' : '';
}

// Central steam: reveal the free/at-cost selector only when the toggle is on.
function updateSteamUI() {
  const row = $('steamModeRow');
  if (row) row.style.display = $('useSteam').checked ? '' : 'none';
}

// show/hide the dispatch day-length row and a live "= X/min · ~Y/day" readout.
function updateDispatchUI() {
  const isDispatch = $('rateUnit').value === 'dispatch';
  const name = $('item').value.trim();
  // (a) the "× dispatch portals" option only appears once an eligible item is picked (or it's
  // already selected — never hide the option out from under the current selection).
  const opt = $('rateUnit').querySelector('option[value="dispatch"]');
  if (opt) opt.hidden = !(isDispatch || dispatchInfo(name));
  // (b) in dispatch mode the item picker narrows to dispatchable items, and the quantity field is
  // hidden — saturating the quota has no count to pick (rate is fixed by item + Negotiation + day).
  $('rate').style.display = isDispatch ? 'none' : '';
  $('dispatchRow').style.display = isDispatch ? '' : 'none';
  const hint = $('dispatchHint');
  if (!hint) return;
  if (!isDispatch) { hint.textContent = ''; return; }
  const d = dispatchInfo(name);
  if (!d) { hint.textContent = name ? `No dispatch contract for "${name}". Dispatchable: ${dispatchNames().join(', ')}.` : `Pick a dispatchable item: ${dispatchNames().join(', ')}.`; return; }
  const neg = Number($('sk_negotiation').value) || 0;
  const dayLen = Number($('dispatchDayLen').value) || 16;
  const dailyMax = dispatchDailyMax(d, neg);
  const rate = dispatchRate(name, neg, dayLen);
  const revPerDay = dailyMax * (d.reward / d.unitsPerContract);
  hint.textContent = `${name} quota ${fmt(dailyMax)}/day (Neg L${neg}) → ${fmt(rate)}/min · ~${fmtCu(revPerDay)}/day`;
}

// ---------- solve ----------
// Solve routing. The tile composer runs fully in-browser (bundled in solver.bundle.js as the
// global AlchSolver), so the hosted static site needs no server. The LP optimizer's WASM solver
// isn't bundled yet, so LP still posts to the dev server's /api/solve — works under
// `npm run serve`; on the static build, choose the Tile composer.
async function solveBody(body) {
  const useComposer = body.config && body.config.solver === 'composer';
  if (useComposer && window.AlchSolver) return AlchSolver.solve(body);
  const res = await fetch('/api/solve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`server solve failed (${res.status}) — the LP optimizer needs the local dev server; switch Solver to "Tile composer" for the hosted build`);
  return res.json();
}
async function solve() {
  const body = requestBody();
  if (!body.item) { setStatus('Pick an output item.', 'error'); return; }
  const multi = body.targets.length > 1;
  if (multi && body.config.solver !== 'composer') {
    setStatus('Multiple targets need the Tile composer — switch Build method to "Tile composer".', 'error');
    return;
  }
  const dispatchUnit = $('rateUnit').value === 'dispatch';
  if (dispatchUnit && !dispatchInfo(body.item)) {
    setStatus(`No dispatch contract for "${body.item}". Dispatchable: ${dispatchNames().join(', ')}.`, 'error');
    return;
  }
  if (dispatchUnit && !(body.rate > 0)) { setStatus('Dispatch quota resolves to 0 — check the day length.', 'error'); return; }
  setStatus('Solving…', '');
  $('summary').innerHTML = '';
  let out;
  try {
    out = await solveBody(body);
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
  lastConfig = body.config;
  renderGraph(out.graph);
  $('explain').textContent = out.explainText || '';
  let status;
  if (multi && out.targets) {
    const list = out.targets.map((t) => `${t.machines ? t.machines + '× ' : ''}${t.item} ${fmt(t.rate)}/min`).join(' + ');
    status = `Built ${out.targets.length} targets: ${list}. ${fmtCu(out.copperPerItem)}/item avg, ${fmtCu(out.copperPerMin)}/min total.`;
  } else {
    status = `Solved in ${out.cgRounds} CG round(s). ${fmtCu(out.copperPerItem)} per ${body.item}.`;
    if (out.machineTarget) status = `Building ${out.machineTarget}× ${body.item} machine(s) = ${fmt(out.effectiveRate)}/min. ` + status;
    if (dispatchUnit) status = `Saturating ${body.item} dispatch quota = ${fmt(body.rate)}/min (Neg L${Number($('sk_negotiation').value) || 0}, ${Number($('dispatchDayLen').value) || 16}-min day). ` + status;
  }
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
  // furnaces are heating infrastructure, not production machines — summarised separately
  const furnaceList = Object.entries(s.furnaces || {}).sort((a, b) => b[1] - a[1]);
  const totalFurnaces = furnaceList.reduce((a, [, n]) => a + n, 0);
  let html = '<div class="stat-row">';
  html += `<div class="stat">Cost <b>${fmtCu(out.copperPerMin)}</b>/min</div>`;
  html += `<div class="stat">Per item <b>${fmtCu(out.copperPerItem)}</b></div>`;
  if (s.profitPerMin != null) {
    // Revenue source depends on how the output leaves: a dispatch target earns the CONTRACT REWARD
    // (reward per unit = reward / unitsPerContract), everything else its sell price. Input cost is the
    // same either way, so we just swap revenue here rather than re-solving.
    const d = $('rateUnit').value === 'dispatch' ? dispatchInfo(body.item) : null;
    const revenue = d ? out.effectiveRate * (d.reward / d.unitsPerContract) : s.revenuePerMin;
    const profit = revenue - s.inputCostPerMin;
    // Input-cost breakdown depends on the basis the solver used. In profit/dispatch mode the build
    // grows+cauldrons most inputs (near-zero external spend), so cost is the INTRINSIC material value
    // of the ingredients (game cauldronCost); in build mode it's actual belt buys + belted fuel/fert.
    const costDetail = s.costBasis === 'intrinsic'
      ? 'intrinsic material value of ingredients'
      : `${fmtCu(out.copperPerMin)} buys${s.beltUtilCostPerMin > 0.01 ? ` + ${fmtCu(s.beltUtilCostPerMin)} belted fuel/fert` : ''}`;
    const title = `Revenue ${fmtCu(revenue)}/min (${d ? 'dispatch reward' : 'output sell value'}) − inputs ${fmtCu(s.inputCostPerMin)}/min (${costDetail})`;
    html += `<div class="stat" title="${esc(title)}">Profit <b class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">${profit < 0 ? '−' : ''}${fmtCu(Math.abs(profit))}</b>/min</div>`;
  }
  if (s.capitalPerMin > 0.01) {
    html += `<div class="stat">Mat <b>${fmtCu(s.materialPerMin)}</b> · cap <b>${fmtCu(s.capitalPerMin)}</b>/min</div>`;
  }
  html += `<div class="stat">Machines <b>${totalMachines}</b></div>`;
  if (totalFurnaces) html += `<div class="stat">🏭 Furnaces <b>${totalFurnaces}</b></div>`;
  if (s.externals.length) {
    html += `<div class="stat">Inputs <b>${s.externals.map((e) => `${esc(e.item)} ${fmt(e.ratePerMin)}/min`).join('</b>, <b>')}</b></div>`;
  }
  html += '</div>';
  // machine totals as compact wrapping chips (was a tall 20-row table)
  if (machineList.length || furnaceList.length) {
    html += '<div class="machine-chips">' +
      machineList.map(([m, n]) => `<span class="mchip">${esc(m)} <b>×${n}</b></span>`).join('') +
      furnaceList.map(([m, n]) => `<span class="mchip" title="heating device (infrastructure), not a production machine">🏭 ${esc(m)} <b>×${n}</b></span>`).join('') +
      '</div>';
  }
  $('summary').innerHTML = html;
}

// ---------- layered SVG graph ----------
let viewState = { k: 1, x: 0, y: 0 };
let orientation = 'TB';   // 'TB' vertical (default) | 'LR' horizontal
let showClusters = true;  // draw labeled production-line containers
// Single layout engine: 2D-nested (layout3.js) — lane-based + vertical nesting of wide shared
// producers over their consumers, with the per-line split + container rendering. The older
// 'classic' (layout.js) and '2d' (layout2.js) engines were removed; splitBaseGoods's
// line-membership clustering now comes from the bundled AlchSolver.assignClusters, which is
// byte-identical to the src/layout.js code that 'classic' used.
const layoutMode = '2dn';
const collapsed = new Set(); // cluster ids folded into a single group node (drill-down)
const COLLAPSE_ENABLED = false; // line collapse/drill-down temporarily disabled (re-clustering made it confusing)
// fuel/fert distribution edges: 'all' = every source→machine edge, 'trunk' = one
// aggregated edge per line box, 'off' = rely on the per-machine bands only.
let utilEdgeMode = 'trunk';
const UTIL_MODE_LABEL = { all: '🔥 Fuel/fert: all', trunk: '🔥 Fuel/fert: trunk', off: '🔥 Fuel/fert: off' };
let lastGraph = null;     // cached so a re-render can reuse the last solve
let lastConfig = null;    // config of the last solve (Level-2 needs it for standalone unit solves)
const CLUSTER_COLORS = ['#7a9cc6', '#c69c7a', '#7ac68f', '#c67a9c', '#9c7ac6', '#c6c07a'];
const NODE_W = 260, NODE_H = 84;
// The solver-owned tile-DAG IR is the default renderer; ?pipeline=legacy falls back to layout3,
// ?pipeline=tiles2 uses the Level-2 canonical belt-sized stamped-tile producer + layered DAG layout.
const PIPELINE = new URLSearchParams(location.search).get('pipeline') || 'tiles';
const TILES_PIPELINE = PIPELINE !== 'legacy';
const TILES2 = PIPELINE === 'tiles2';
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
function applyCollapse(graph, engine) {
  if (!COLLAPSE_ENABLED || !collapsed.size) return graph;
  // Cluster membership MUST come from the engine that actually rendered the boxes — the
  // line headers the user clicked to collapse carry that engine's cluster keys (layout3's,
  // in 2D-nested mode). Looking them up in the classic engine's clustering (which can group
  // nodes differently, e.g. shared sub-assemblies / disposal sinks) means the collapse finds
  // no matching cluster (click does nothing) or folds the wrong members. Mirror renderGraph's
  // own clOf/tileByKey, which already key off the render engine.
  const ca = (engine && engine.assignClusters ? engine : AlchSolver).assignClusters(graph);
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

// Replicate EVERY shared material producer into per-line dedicated copies, so each
// product line is a fully self-contained tile: it takes only main-belt inputs (cash /
// fuel / fertilizer) and produces one full belt of output, with nothing exiting
// mid-tile. The mental model is "I need Brick, so I drop a Brick blueprint" — that
// blueprint must carry its OWN Sand sub-chain, not siphon Sand off the Glass line.
//
// A node is REPLICATED when its (transitive) material output reaches ≥2 distinct lines
// (Sand → Salt + Brick + Glass). Its entire upstream cone replicates with it — each
// line gets a private copy of Limestone → Stone → Sand. Copies are sized by lineFrac:
// the fraction of the node's output that actually serves each line (Sand splits
// 224 / 600 / 3600, NOT evenly), so per-line machine counts and tile loads stay honest.
// Backpressure means a replicated nursery/crusher costs the same total buildings + fuel
// as the one shared producer it replaces — it just stops raking edges across the canvas.
//
// Fuel / fertilizer UTILITY lines are NOT replicated: their heat/nutrient output trunks
// to every consumer (that's a main-belt input, not a mid-tile material exit). Only
// item edges drive replication; belt taps are physical (tapped per consumer) so they
// replicate too, keyed off the lines their fuel/fert/cash ultimately serves.
function splitBaseGoods(graph) {
  const cl = AlchSolver.assignClusters(graph);
  const homeLine = (id) => cl.clusterOf.get(id) ?? '·loose';
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A co-product feed is a cross-tile reuse edge (Salt tile's Sand → the Glass line), not part of a
  // node's primary material spine — it renders as a dashed recycle link but must NOT drag its source
  // into the consumer's replication cone, or the Salt tile would clone onto the Glass line.
  // A disposal sink (a trashed co-product, e.g. Salt's Sand → trash) is the SAME deal: it is not a
  // product line, so it must not count toward how many lines its producer serves. Without this, a
  // single-line producer (Salt → Brine, dumping Sand → trash) reads as serving TWO lines — its real
  // Brine line plus the trash sink's home — and gets cloned into a phantom orphan line (Buy Rock Salt
  // → Salt → Sand → trash drawn off to the side). This is engine-independent on purpose: only
  // layout3.assignClusters attaches sinks to their producer's cluster; classic/layout2 leave them
  // '·loose', so keying the decision off clustering alone would still orphan in 2D and classic modes.
  const isSink = (id) => { const n = byId.get(id); return !!n && (n.type === 'surplus' || n.type === 'trash'); };
  const isItemEdge = (e) => !e.heat && !e.nutrient && !e.cash && !e.coproduct && !isSink(e.to);
  const isBelt = (n) => n && n.type === 'external' && n.kind === 'belt';
  const outEdges = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) if (e.from !== e.to && outEdges.has(e.from)) outEdges.get(e.from).push(e);
  // Edges that decide a node's line membership: a normal producer is keyed by where its
  // MATERIAL (item) output goes; a belt tap by where its fuel/fert/cash ultimately lands
  // (heat/nutrient/cash), since a belt has no item output of its own.
  const relevantOut = (id) => {
    const es = outEdges.get(id) || [];
    return isBelt(byId.get(id)) ? es : es.filter(isItemEdge);
  };

  // linesOf(id): the set of distinct product/util lines this node's output ultimately
  // serves. A consumer that is itself replicated passes its whole line-set through; a
  // single-line consumer anchors to its home cluster. Memoized; a cycle contributes
  // nothing (a self-consuming loop never widens the served set). REPLICATED ⇔ ≥2 lines.
  const linesMemo = new Map(), onPath = new Set();
  const linesOf = (id) => {
    if (linesMemo.has(id)) return linesMemo.get(id);
    if (onPath.has(id)) return new Set();
    onPath.add(id);
    const outs = relevantOut(id);
    let res;
    if (!outs.length) res = new Set([homeLine(id)]);
    else {
      res = new Set();
      for (const e of outs) {
        const sub = linesOf(e.to);
        if (sub.size >= 2) for (const L of sub) res.add(L);
        else res.add(homeLine(e.to));
      }
    }
    onPath.delete(id);
    linesMemo.set(id, res);
    return res;
  };
  const replicated = (id) => linesOf(id).size >= 2;

  // lineFrac(id): fraction of this node's output that serves each line — the rate weight
  // for its per-line copy. Propagates downstream weights (Sand's 224/600/3600 split flows
  // up to size the Stone and Limestone copies feeding it). Sums to ~1 over linesOf(id).
  const fracMemo = new Map(), onPath2 = new Set();
  const lineFrac = (id) => {
    if (fracMemo.has(id)) return fracMemo.get(id);
    if (onPath2.has(id)) return new Map();
    onPath2.add(id);
    const outs = relevantOut(id);
    const total = outs.reduce((s, e) => s + (e.ratePerMin || 0), 0);
    const res = new Map();
    if (!total) { const L = [...linesOf(id)][0] ?? homeLine(id); res.set(L, 1); }
    else for (const e of outs) {
      const w = (e.ratePerMin || 0) / total;
      if (replicated(e.to)) { for (const [L, fr] of lineFrac(e.to)) res.set(L, (res.get(L) || 0) + w * fr); }
      else { const L = homeLine(e.to); res.set(L, (res.get(L) || 0) + w); }
    }
    onPath2.delete(id);
    fracMemo.set(id, res);
    return res;
  };

  // The main-belt MONEY line (money:belt) is fungible — compose-graph makes it "a single source
  // feeding every buy/mint". Unlike a physical item belt (tapped per consuming machine), it should
  // NOT be replicated per line: coins are valued by their copper worth, so one belt of high-value
  // coins covers the whole spend. Replicating it just spawned duplicate "Main belt: <Coin>" nodes
  // (one per line it pays into). Keep it a single node; layout3 then trunks its cash edges per line.
  const split = graph.nodes.filter((n) => n.id !== 'money:belt' && replicated(n.id));
  if (!split.length) return graph;
  const splitSet = new Set(split.map((n) => n.id));
  const copyId = (id, line) => `${id}@@${line}`;

  const nodes = graph.nodes.filter((n) => !splitSet.has(n.id));
  for (const n of split) {
    for (const [line, f] of lineFrac(n.id)) {
      nodes.push({
        ...n, id: copyId(n.id, line), ratePerMin: (n.ratePerMin || 0) * f,
        machineCount: n.machineCount ? Math.max(1, Math.ceil(n.machineCount * f)) : n.machineCount,
        tileLoad: n.tileLoad != null ? n.tileLoad * f : n.tileLoad, // continuous load follows the line's share
        nutrientPerMin: (n.nutrientPerMin || 0) * f, fertPerMin: (n.fertPerMin || 0) * f,
        heatPerMin: (n.heatPerMin || 0) * f, fuelPerMin: (n.fuelPerMin || 0) * f, // fuel scales with the line's share
        copperPerMin: (n.copperPerMin || 0) * f, // each per-line copy carries its share of the spend
        beltLanes: n.beltLanes ? Math.max(1, Math.ceil(n.beltLanes * f)) : n.beltLanes,
      });
    }
  }

  const edges = [];
  for (const e of graph.edges) {
    const fromSplit = splitSet.has(e.from), toSplit = splitSet.has(e.to);
    if (!fromSplit && !toSplit) { edges.push(e); continue; }
    if (toSplit) {
      // consumer is replicated → fan this edge to each consumer copy by its line share.
      // A replicated source shares the same line keys, so route from the matching copy.
      for (const [line, f] of lineFrac(e.to)) {
        const from = fromSplit ? copyId(e.from, line) : e.from;
        edges.push({ ...e, from, to: copyId(e.to, line), ratePerMin: (e.ratePerMin || 0) * f });
      }
    } else {
      // only the source is replicated → route to the copy(ies) serving the consumer.
      const fr = replicated(e.to) ? lineFrac(e.to) : new Map([[homeLine(e.to), 1]]);
      for (const [line, f] of fr) edges.push({ ...e, from: copyId(e.from, line), ratePerMin: (e.ratePerMin || 0) * f });
    }
  }
  // Safety net: the per-line keying can, in rare chained/cyclic cases, reference a copy
  // that wasn't created. Drop any such dangling edge rather than let it reach the layout
  // (an edge endpoint with no node crashes the spanning-tree walk).
  const liveIds = new Set(nodes.map((n) => n.id));
  const liveEdges = edges.filter((e) => liveIds.has(e.from) && liveIds.has(e.to));
  return { nodes, edges: liveEdges, summary: graph.summary };
}

function renderGraph(rawGraph) {
  lastGraph = rawGraph;
  const ENGINE = AlchLayout3;
  let graph = applyCollapse(rawGraph, ENGINE);
  graph = splitBaseGoods(graph);
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

  // Experimental tile-DAG pipeline (?pipeline=tiles): solver-owned IR drawn by the geometry-only
  // renderer. Bypasses the layout3 clustering/blueprint path entirely. Pan/zoom/fit reuse #viewport.
  if (TILES_PIPELINE && window.AlchRenderIR && AlchSolver.graphToIR) {
    const drawOpts = { beltSpeed: AlchSolver.beltSpeed((lastConfig && lastConfig.skills && lastConfig.skills.logistics) || 0), isLiquid: AlchSolver.isLiquid };
    if (TILES2 && AlchSolver.composeTilesIR) {
      const ir = AlchSolver.composeTilesIR(rawGraph, lastConfig);
      AlchRenderIR.drawIR(ir, AlchRenderIR.layoutTilesDAG(ir), root, drawOpts);
    } else {
      const ir = AlchSolver.graphToIR(rawGraph);
      AlchRenderIR.drawIR(ir, AlchRenderIR.layoutIR(ir), root, drawOpts);
    }
    fitView();
    return;
  }

  const { pos, edges: edgePts, recycle, clusters, trunks, trunkedEdges } = ENGINE.layout(graph, { nodeW: NODE_W, nodeH: NODE_H, orientation, clusters: showClusters, utilEdges: utilEdgeMode });

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
  const clusterEls = []; // { members:[nodeId], els:[svg] } so hover can un-fade a box that holds a lit node
  (clusters || []).forEach((c, i) => {
    const col = c.belt ? 'var(--accent)' : CLUSTER_COLORS[i % CLUSTER_COLORS.length];
    const els = [];
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', c.x); r.setAttribute('y', c.y); r.setAttribute('width', c.w); r.setAttribute('height', c.h);
    r.setAttribute('rx', 10); r.setAttribute('class', c.belt ? 'cluster belt' : 'cluster'); r.setAttribute('style', `fill:${col};stroke:${col}`);
    cg.appendChild(r); els.push(r);
    clusterEls.push({ members: c.members || [], els });
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', c.x + 10); t.setAttribute('y', c.y + 16); t.setAttribute('class', 'clusterlabel'); t.setAttribute('style', `fill:${col}`);
    // clickable label collapses the line into a single group node (belt isn't collapsible)
    const bp = c.tile;
    // Line 1 = the line name. The tiling blueprint goes on its OWN line below (line 2),
    // so the header stays clean instead of stretching the cell list across the canvas.
    t.textContent = c.belt ? c.label : `${COLLAPSE_ENABLED ? '▾ ' : ''}${c.label} line`;
    if (bp) {
      const cellShort = bp.cell.map((x) => `${x.count}× ${x.machine}`).join(' + ');
      // each tile is sized to output one full belt (or the whole line if it's sub-belt) —
      // shown as the tile's capacity, even though backpressure may run it below that.
      const perTile = bp.perTileOut != null ? bp.perTileOut : (c.outRate && bp.K ? c.outRate / bp.K : null);
      const rateStr = perTile ? ` · ${fmt(perTile)}${c.outItem ? ' ' + c.outItem : ''}/min/tile` : '';
      const idleStr = bp.idle > 0.2 ? ` (${Math.round(bp.idle * 100)}% idle)` : '';
      const cellStr = bp.cell.map((x) => `${x.count}× ${x.label} (${x.machine})`).join(' + ');
      const ttlText = (bp.K > 1
        ? `Tileable: build ${bp.K} identical tiles, each one = ${cellStr}. `
        : `Single tile (output ≤ one belt): ${cellStr}. `)
        + `${Math.round(bp.idle * 100)}% of machine capacity idles (build cost only — backpressure means no extra input/fuel).`;
      // line 2 = tile count + per-tile output; line 3 = the cell (its own line so the long
      // machine list doesn't stretch the header sideways across the canvas).
      const subLine = (dy, text) => {
        const tx = document.createElementNS(SVGNS, 'text');
        tx.setAttribute('x', c.x + 10); tx.setAttribute('y', c.y + dy); tx.setAttribute('class', 'clustersub'); tx.setAttribute('style', `fill:${col}`);
        tx.textContent = text;
        const ttl = document.createElementNS(SVGNS, 'title'); ttl.textContent = ttlText; tx.appendChild(ttl);
        cg.appendChild(tx); els.push(tx);
      };
      if (bp.K > 1) {
        subLine(30, `⬢ ${bp.K}× tiles${rateStr}${idleStr}`);
        subLine(44, `each: ${cellShort}`);
      } else {
        // single tile = the whole line; skip the "1× tiles" framing
        subLine(30, `⬢ ${perTile ? `${fmt(perTile)}${c.outItem ? ' ' + c.outItem : ''}/min` : 'single tile'}${idleStr}`);
        subLine(44, cellShort);
      }
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
    cg.appendChild(t); els.push(t);
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
    // co-product feed (reuse mode): a reused co-product crossing tiles — styled like a recycle link
    const isRecycle = (recycle && recycle.has(e.from + '\t' + e.to)) || e.coproduct;
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'edge' + (fuelEdge ? ' heat' : fertEdge ? ' nutrient' : cashEdge ? ' cash' : (isRecycle ? ' recycle' : '')));
    edgeGroups.push({ g, from: e.from, to: e.to, feedback: fuelEdge || fertEdge });
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('d', ENGINE.edgePath(eo, orientation));
    path.setAttribute('marker-end', 'url(#arrow)');
    g.appendChild(path);
    const m = ENGINE.edgeMid(eo);
    // Split the flow per-tile + total when the PRODUCER is a tiled line (K>1), matching the
    // node sub-lines — "Flax 180 per tile · 360 total". A single producer keeps the bare total.
    const fromTile = tileByKey.get(clOf.get(e.from));
    const eK = fromTile && fromTile.K > 1 ? fromTile.K : 1;
    const rateStr = eK > 1 ? `${fmt(e.ratePerMin / eK)} per tile · ${fmt(e.ratePerMin)} total` : `${fmt(e.ratePerMin)}`;
    const label = `${e.coproduct ? '♻ ' : ''}${e.item} ${rateStr}`;
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
    // sub-line carries machine count + throughput (utilization is a separate corner flag below)
    const subY = titleLines.length === 2 ? 50 : 37;
    const sub = document.createElementNS(SVGNS, 'text');
    sub.setAttribute('x', 10); sub.setAttribute('y', subY); sub.setAttribute('class', 'sub');
    let subText = '';
    let subClip = 40; // node-width budget; the tiled split below carries four numbers, so it gets more
    if (n.kind === 'group') subText = `${n.collapsedCount} steps${n.blueprint ? ` · ⬢ ${n.blueprint.K}× cell` : ''}${n.machineCount ? ` · ${n.machineCount} machines` : ''} — click to expand`;
    // tiled line (K>1): pair each machine count with its throughput at that scope so the rate
    // is unambiguous — "3× 180/min per tile · 6× 360/min total". ratePerMin is the line total;
    // the per-tile rate is that split across the K identical tiles. Single-tile lines (K=1)
    // fall through: per-tile == total there, so the plain machine-count branch reads cleaner.
    else if (pt && pt.K > 1) {
      const perTileRate = n.ratePerMin / pt.K;
      subText = `${pt.perTile}× ${fmt(perTileRate)}/min per tile · ${pt.total}× ${fmt(n.ratePerMin)}/min total`;
      subClip = 46; // four numbers, digit/symbol-heavy — fits the 260px node (utilization moved to the corner flag)
    }
    else if (n.machineCount) subText = `${n.machineCount}× ${promote ? '' : n.machine + ' '}· ${fmt(n.ratePerMin)}/min`; // utilization moved to the bottom-left corner flag below
    else if (n.machine) subText = `${n.machine} · ${fmt(n.ratePerMin)}/min`;
    else if (n.kind === 'belt' && n.supplyRate != null) subText = `${fmt(n.ratePerMin)}/min drawn · ${fmt(n.supplyRate)}/min belt supply${n.beltLanes ? ` · ${n.beltLanes} belt${n.beltLanes > 1 ? 's' : ''}` : ''}`;
    else if (n.kind === 'belt' && n.beltLanes) subText = `${fmt(n.ratePerMin)}/min · ${n.beltLanes} belt${n.beltLanes > 1 ? 's' : ''} @ ${fmt(n.beltSpeed)}/min`;
    else if (n.type === 'external') subText = `${fmt(n.ratePerMin)}/min${n.copperPerMin ? ' · ' + fmtCu(n.copperPerMin) + '/min' : ' · free'}`;
    else if (n.type === 'demand') subText = `${fmt(n.ratePerMin)}/min target`;
    else if (n.type === 'resource') subText = `${fmt(n.ratePerMin)}/min → ${n.consumerCount} machines`;
    else if (n.type === 'surplus') subText = `${fmt(n.ratePerMin)}/min`;
    else if (n.type === 'trash') subText = `${fmt(n.ratePerMin)}/min wasted`;
    sub.textContent = clip(subText, subClip);
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
    // heating devices: the furnaces that host this box's heated machines (it slots into them).
    if (n.furnaces) drawBand('fuelband', `🏭 ${n.furnaces}× ${clip(n.furnaceItem, 24)}`, bandIdx++);
    if (n.fertItem && n.fertPerMin > 0) drawBand('fertband', `🌱 ${fmt(n.fertPerMin)} ${clip(n.fertItem, 26)}/min`, bandIdx++);
    // co-products a recipe loops back into the same machine (raw in ∩ out) — net inputs
    // already cover them, so there's nothing to route; the band just says "this output
    // recirculates, not an unhandled byproduct".
    if (n.recirc) for (const rc of n.recirc) drawBand('recircband', `♻ ${fmt(rc.ratePerMin)} ${clip(rc.item, 24)}/min recirculated`, bandIdx++);
    // Utilization flag: surfaced only when a machine/tile runs notably under capacity (<90%),
    // so the common fully-loaded case shows nothing. Lives top-right on the title row — the
    // bottom-left collides with the fuel/fert bands, and the title row's right side is always
    // free on process nodes (they carry no badge), so it reads as a clean status chip there.
    if (n.utilization != null && Math.round(n.utilization * 100) < 90) {
      const u = document.createElementNS(SVGNS, 'text');
      u.setAttribute('x', NODE_W - 8); u.setAttribute('y', 18); u.setAttribute('text-anchor', 'end'); u.setAttribute('class', 'util');
      u.textContent = `⚙ ${Math.round(n.utilization * 100)}%`;
      g.appendChild(u);
    }
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
  // feedback edge can't pre-empt a real material path to the same node). suppliers =
  // the fuel/fert SOURCE nodes feeding the lineage (fb nodes reached on the upstream
  // walk); their whole line gets lit (see below). The downstream walk passes no
  // supplier set, so the lines that merely BURN our fuel stay 1-hop, not fully lit.
  const walk = (startId, adjMap, seen, fbNodes, edges, suppliers) => {
    const stack = [startId];
    while (stack.length) {
      for (const { id: nb, g, fb } of adjMap.get(stack.pop()) || []) {
        edges.add(g);
        if (fb) { fbNodes.add(nb); if (suppliers) suppliers.add(nb); continue; }
        if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
      }
    }
  };
  // node → its cluster box (for fully lighting a fuel/fert source line on hover)
  const nodeToCluster = new Map();
  for (const ce of clusterEls) for (const m of ce.members) nodeToCluster.set(m, ce);
  for (const [id, g] of nodeGroups) {
    g.addEventListener('mouseenter', () => {
      svg.classList.add('hovering');
      const seen = new Set([id]);
      const fbNodes = new Set();
      const edges = new Set();
      const suppliers = new Set();
      walk(id, inAdj, seen, fbNodes, edges, suppliers); // everything that feeds this node (+ fuel/fert suppliers)
      walk(id, outAdj, seen, fbNodes, edges, null);     // everything this node feeds (consumers stay 1-hop)
      // A fuel/fert source line that powers the lineage lights in full — every node +
      // its internal edges — so "here's the line making your fuel" reads as one unit
      // instead of a lit box around faded guts. Bounded to that line: we light its
      // members, never walk out of it into its OTHER consumers.
      const litLines = new Set();
      for (const s of suppliers) { const ce = nodeToCluster.get(s); if (ce) litLines.add(ce); }
      for (const ce of litLines) {
        const mem = new Set(ce.members);
        for (const m of ce.members) fbNodes.add(m);
        for (const { g: eg3, from, to } of edgeGroups) if (mem.has(from) && mem.has(to)) edges.add(eg3);
        for (const { g: tg, from, tos } of trunkGroups) if (mem.has(from) && tos.length && tos.every((t) => mem.has(t))) edges.add(tg);
      }
      for (const nid of seen) nodeGroups.get(nid)?.classList.add('hl');
      for (const nid of fbNodes) nodeGroups.get(nid)?.classList.add('hl');
      for (const eg2 of edges) eg2.classList.add('hl');
      // keep a line's wrapper + header lit while any of its tiles is in focus
      for (const ce of clusterEls) if (ce.members.some((m) => seen.has(m) || fbNodes.has(m))) for (const el of ce.els) el.classList.add('hl');
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
  if (n.furnaces) txt += `\nhosted in ${n.furnaces}× ${n.furnaceItem} (heating device)`;
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
  // Reserve space for the floating toolbar + legend (top-left, z-index 2) so the initial fit
  // doesn't park the diagram underneath them. Measured from the element since it wraps to two
  // rows on narrow panels; the diagram is then fit + centred in the area BELOW it.
  const tb = document.querySelector('.graph-toolbar');
  const topPad = tb ? tb.offsetTop + tb.offsetHeight + 8 : 16;
  const availH = Math.max(40, h - topPad);
  const k = Math.min(w / (bb.width + 60), availH / (bb.height + 60), 1.4);
  viewState = { k, x: (w - bb.width * k) / 2 - bb.x * k, y: topPad + (availH - bb.height * k) / 2 - bb.y * k };
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
  $('mermaidBtn').onclick = async () => {
    const body = requestBody();
    if (!body.item) { setStatus('Pick an item first.', 'error'); return; }
    let out; try { out = await solveBody(body); } catch (e) { setStatus(e.message, 'error'); return; }
    if (!out || out.status !== 'Optimal' || !out.graph) { setStatus('No solution to export.', 'error'); return; }
    await navigator.clipboard.writeText(AlchSolver.toMermaid(out.graph));
    setStatus('Mermaid diagram copied — paste into GitHub/Notion/Obsidian.', 'ok');
  };
})();

// ---------- DOT export ----------
$('exportDot').onclick = async () => {
  const body = requestBody();
  if (!body.item) { setStatus('Pick an item first.', 'error'); return; }
  let out; try { out = await solveBody(body); } catch (e) { setStatus(e.message, 'error'); return; }
  if (!out || out.status !== 'Optimal' || !out.graph) { setStatus('No solution to export.', 'error'); return; }
  await navigator.clipboard.writeText(AlchSolver.toDot(out.graph));
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
