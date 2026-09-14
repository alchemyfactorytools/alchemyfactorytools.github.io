// Shareable-URL codec for the sidebar settings.
//
// Pure functions over the same plain object savePrefs() stores:
//   { fields: {controlId: value}, belt: [{item, rate|null}],
//     extraTargets: [{item, rate, rateMode}], allowed: [itemName] }
// Only values that differ from the control's default are written, so a typical
// link is ?v=55&o=basic_fertilizer&t=4&r=30. Item names travel as slugs
// (lowercase, non-alphanumerics to "_") and are resolved against the catalog on
// decode; unknown slugs and malformed values fall back to the default silently.
// `v` is the dataset version the link was made on, so a link from an older
// dataset can be flagged. Unrelated query params (?pipeline=) are left alone.
//
// Loaded as a classic script (window.AlchShare) and required by test/share.test.js.

(function (root) {
  'use strict';

  // controlId → [urlKey, default]. Defaults mirror web/index.html.
  const FIELDS = {
    item: ['o', ''],
    rate: ['r', '0.1'],
    rateUnit: ['u', 'min'],
    dispatchDayLen: ['dl', '16'],
    maxTier: ['t', ''],
    solver: ['s', 'composer'],
    sk_factory: ['sf', '0'],
    sk_logistics: ['sl', '0'],
    sk_alchemy: ['sa', '0'],
    sk_fuel: ['su', '0'],
    sk_fertilizer: ['se', '0'],
    sk_negotiation: ['sn', '0'],
    cauldronEnabled: ['c', true],
    pool: ['p', 'unrestricted'],
    forbidCauldron: ['fc', ''],
    forceCauldron: ['xc', ''],
    byproducts: ['bp', 'reuse'],
    byproductTrash: ['bt', ''],
    useSteam: ['st', false],
    steamMode: ['sm', 'free'],
    selfFuel: ['ff', true],
    selfFert: ['fe', true],
    fullBeltTiles: ['fb', true],
    buildability: ['bd', '0'],
    costTolerance: ['ct', '0'],
    cauldronChain: ['cc', '0'],
    farmPenalty: ['fp', '3'],
    machines: ['m', '1000'],
    capital: ['cap', true],
  };
  // fields whose value is an item name (or a comma list of item names) → slugs in the URL
  const ITEM_FIELDS = new Set(['item']);
  const ITEM_LIST_FIELDS = new Set(['forbidCauldron', 'forceCauldron', 'byproductTrash']);
  const LIST_KEYS = { belt: 'b', extraTargets: 'x', allowed: 'a' };
  const VERSION_KEY = 'v';
  const RATE_MODE_SUFFIX = { min: 'm', sec: 's', machines: 'c', belts: 'b' };
  const SUFFIX_RATE_MODE = { m: 'min', s: 'sec', c: 'machines', b: 'belts' };
  const OWN_KEYS = new Set([VERSION_KEY, ...Object.values(FIELDS).map((f) => f[0]), ...Object.values(LIST_KEYS)]);

  const slug = (name) => String(name).toLowerCase().replace(/[ˈ']/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

  // catalog: array of {name} (or names) → slug → name
  function slugMap(catalog) {
    const m = new Map();
    for (const it of catalog || []) { const name = typeof it === 'string' ? it : it.name; m.set(slug(name), name); }
    return m;
  }

  function encode(prefs, { version, base } = {}) {
    const q = new URLSearchParams(base || '');
    for (const k of [...q.keys()]) if (OWN_KEYS.has(k)) q.delete(k);
    if (version != null) q.set(VERSION_KEY, String(version));
    const fields = (prefs && prefs.fields) || {};
    for (const [id, [key, def]] of Object.entries(FIELDS)) {
      let v = fields[id];
      if (v === undefined) continue;
      if (typeof def === 'boolean') { v = !!v; if (v === def) continue; q.set(key, v ? '1' : '0'); continue; }
      v = String(v).trim();
      if (v === String(def) || (v === '' && def === '')) continue;
      if (ITEM_FIELDS.has(id)) v = slug(v);
      else if (ITEM_LIST_FIELDS.has(id)) v = v.split(',').map((s) => s.trim()).filter(Boolean).map(slug).join(',');
      if (v !== '') q.set(key, v);
    }
    const belt = (prefs && prefs.belt) || [];
    if (belt.length) q.set(LIST_KEYS.belt, belt.map((b) => slug(b.item) + (b.rate == null || b.rate === '' ? '' : ':' + b.rate)).join(','));
    const xt = ((prefs && prefs.extraTargets) || []).filter((t) => t.item);
    if (xt.length) q.set(LIST_KEYS.extraTargets, xt.map((t) => slug(t.item) + ':' + (t.rate == null ? 1 : t.rate) + (RATE_MODE_SUFFIX[t.rateMode] || 'c')).join(','));
    const allowed = (prefs && prefs.allowed) || [];
    if (allowed.length) q.set(LIST_KEYS.allowed, allowed.map(slug).join(','));
    return q.toString().replace(/%2C/gi, ',').replace(/%3A/gi, ':');
  }

  // Returns { prefs, version, present } — present is false when the query carries none of
  // our keys (so the caller can fall back to localStorage). Unknown slugs are dropped.
  function decode(search, catalog) {
    const q = new URLSearchParams(search || '');
    const names = slugMap(catalog);
    const resolve = (s) => names.get(slug(s)) || null;
    let present = false;
    const fields = {};
    for (const [id, [key, def]] of Object.entries(FIELDS)) {
      if (!q.has(key)) continue;
      present = true;
      const raw = q.get(key);
      if (typeof def === 'boolean') { fields[id] = raw === '1' || raw === 'true'; continue; }
      if (ITEM_FIELDS.has(id)) { const n = resolve(raw); if (n) fields[id] = n; continue; }
      if (ITEM_LIST_FIELDS.has(id)) { fields[id] = raw.split(',').map(resolve).filter(Boolean).join(', '); continue; }
      fields[id] = raw;
    }
    const prefs = { fields };
    if (q.has(LIST_KEYS.belt)) {
      present = true;
      prefs.belt = [];
      for (const part of q.get(LIST_KEYS.belt).split(',').filter(Boolean)) {
        const [s, r] = part.split(':');
        const item = resolve(s);
        if (item) prefs.belt.push({ item, rate: r === undefined || r === '' ? null : num(r) });
      }
    }
    if (q.has(LIST_KEYS.extraTargets)) {
      present = true;
      prefs.extraTargets = [];
      for (const part of q.get(LIST_KEYS.extraTargets).split(',').filter(Boolean)) {
        const m = /^([^:]+):([0-9.]+)([mscb])?$/.exec(part);
        if (!m) continue;
        const item = resolve(m[1]);
        if (item) prefs.extraTargets.push({ item, rate: num(m[2]) ?? 1, rateMode: SUFFIX_RATE_MODE[m[3]] || 'machines' });
      }
    }
    if (q.has(LIST_KEYS.allowed)) {
      present = true;
      prefs.allowed = q.get(LIST_KEYS.allowed).split(',').map(resolve).filter(Boolean);
    }
    const version = q.has(VERSION_KEY) ? num(q.get(VERSION_KEY)) : null;
    return { prefs, version, present };
  }

  // Query string with our keys removed (what a "clean" URL looks like).
  function strip(search) {
    const q = new URLSearchParams(search || '');
    for (const k of [...q.keys()]) if (OWN_KEYS.has(k)) q.delete(k);
    return q.toString();
  }

  const api = { encode, decode, strip, slug, FIELDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AlchShare = api;
})(typeof window !== 'undefined' ? window : globalThis);
