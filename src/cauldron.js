// Cauldron recipe compiler (DESIGN.md §3.2).
//
// Enumerates every unordered triple-with-repetition of cauldron-eligible items
// and resolves the deterministic output:
//   T = (c1 + c2 + c3) × ratio,  ratio = 0.5 (all identical) / 0.65 (two identical) / 1.0
//   output = argmin over cauldronTarget items of |T − target| × cauldronMulti
//   exact ties broken by lower item id.
//
// Arithmetic is exact: cauldronCost/cauldronTarget carry up to 10 decimal places
// in the dataset, so values are parsed from their decimal string form into BigInt
// at scale 10^10, and T is carried at an extra ×20 (the common denominator of
// 1/2, 13/20, 1/1) so ratios stay integral. Exact ties are exact BigInt equality.
//
// Time/heat are piecewise-linear on the OUTPUT's cauldronTarget (float is fine
// there — they are cost coefficients, not tie-adjudicated).

'use strict';

const SCALE_DECIMALS = 10;
const SCALE = 10n ** BigInt(SCALE_DECIMALS);

// Parse a JS number's shortest decimal representation into BigInt at SCALE.
// Exact for every value the dataset contains (≤10 decimal places).
function toScaled(value) {
  const s = String(value);
  if (s.includes('e') || s.includes('E')) throw new Error(`exponent form not supported: ${s}`);
  const neg = s.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  if (fracPart.length > SCALE_DECIMALS) throw new Error(`more than ${SCALE_DECIMALS} decimals: ${s}`);
  const scaled = BigInt(intPart) * SCALE + BigInt(fracPart.padEnd(SCALE_DECIMALS, '0') || '0');
  return neg ? -scaled : scaled;
}

// Piecewise-linear cauldron craft time (s) and heat per craft, on output target.
const INTERP_T = [1, 100, 1000, 10000, 1000000];
const INTERP_TIME = [3, 6, 12, 24, 60];
const INTERP_HEAT = [1, 20, 200, 1500, 10000];

function cauldronStats(target) {
  const t = INTERP_T;
  if (target <= t[0]) return { time: INTERP_TIME[0], heat: INTERP_HEAT[0] };
  if (target >= t[t.length - 1]) return { time: INTERP_TIME[t.length - 1], heat: INTERP_HEAT[t.length - 1] };
  for (let i = 0; i < t.length - 1; i++) {
    if (target >= t[i] && target <= t[i + 1]) {
      const p = (target - t[i]) / (t[i + 1] - t[i]);
      return {
        time: Math.round((INTERP_TIME[i] + p * (INTERP_TIME[i + 1] - INTERP_TIME[i])) * 10) / 10,
        heat: Math.round((INTERP_HEAT[i] + p * (INTERP_HEAT[i + 1] - INTERP_HEAT[i])) * 10) / 10,
      };
    }
  }
  throw new Error('unreachable');
}

// Eligible cauldron inputs: items with cauldronCost, excluding liquids
// (rule from raw/starfi5h/alchemy_cauldron.js isVaildCandidate).
function eligibleInputs(db) {
  return Object.entries(db.items)
    .filter(([, item]) => item.cauldronCost !== undefined && !item.liquid)
    .map(([name, item]) => ({
      name,
      id: item.id,
      cost: item.cauldronCost,
      costScaled: toScaled(item.cauldronCost),
      buyPrice: item.buyPrice,
    }))
    .sort((a, b) => a.id - b.id);
}

function outputTargets(db) {
  const targets = Object.entries(db.items)
    .filter(([, item]) => item.cauldronTarget !== undefined)
    .map(([name, item]) => ({
      name,
      id: item.id,
      target: item.cauldronTarget,
      // T carries ×20 (ratio common denominator), so targets compare at ×20 too
      targetScaled20: toScaled(item.cauldronTarget) * 20n,
      multi: item.cauldronMulti ?? 1,
      ...cauldronStats(item.cauldronTarget),
    }))
    .sort((a, b) => (a.targetScaled20 < b.targetScaled20 ? -1 : a.targetScaled20 > b.targetScaled20 ? 1 : 0));
  // The nearest-neighbor argmin below assumes distance weights are uniform.
  // All cauldronMulti are 1 in v41; a future non-1 value needs a full-scan argmin.
  const nonUnit = targets.filter((t) => t.multi !== 1);
  if (nonUnit.length) {
    throw new Error(`non-1 cauldronMulti values present (${nonUnit.map((t) => t.name).join(', ')}); ` +
      'the binary-search argmin is invalid — implement weighted full scan');
  }
  return targets;
}

// Resolve T(×20, scaled) → { winner, margin } with exact tie-break by lower id.
// With uniform multi, only the nearest target below and above T can win.
function resolveOutput(t20, targets) {
  // binary search: first index with targetScaled20 >= t20
  let lo = 0;
  let hi = targets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (targets[mid].targetScaled20 < t20) lo = mid + 1;
    else hi = mid;
  }
  const above = lo < targets.length ? targets[lo] : null;
  const below = lo > 0 ? targets[lo - 1] : null;
  if (!above) return { winner: below, runnerUp: null, distScaled20: t20 - below.targetScaled20, tie: false };
  if (!below) return { winner: above, runnerUp: null, distScaled20: above.targetScaled20 - t20, tie: false };
  const dBelow = t20 - below.targetScaled20;
  const dAbove = above.targetScaled20 - t20;
  if (dBelow < dAbove) return { winner: below, runnerUp: above, distScaled20: dBelow, marginScaled20: dAbove - dBelow, tie: false };
  if (dAbove < dBelow) return { winner: above, runnerUp: below, distScaled20: dAbove, marginScaled20: dBelow - dAbove, tie: false };
  // exact tie: lower item id wins
  const winner = below.id < above.id ? below : above;
  const runnerUp = winner === below ? above : below;
  return { winner, runnerUp, distScaled20: dAbove, marginScaled20: 0n, tie: true };
}

const scaled20ToNumber = (v) => Number(v) / (Number(SCALE) * 20);

// Resolve a single triple of item names (unordered). Exposed for tests/CLI.
function resolveTriple(db, names, compiled) {
  const c = compiled || compileCauldron(db);
  const idxs = names.map((n) => {
    const i = c.inputIndex.get(n);
    if (i === undefined) throw new Error(`"${n}" is not a cauldron-eligible input`);
    return i;
  });
  const [a, b, d] = idxs;
  const inputs = c.inputs;
  const sum = inputs[a].costScaled + inputs[b].costScaled + inputs[d].costScaled;
  const allSame = a === b && b === d;
  const twoSame = !allSame && (a === b || b === d || a === d);
  const ratioNum = allSame ? 10n : twoSame ? 13n : 20n;
  const t20 = sum * ratioNum;
  const r = resolveOutput(t20, c.targets);
  return {
    inputs: names,
    T: scaled20ToNumber(t20),
    ratio: allSame ? 0.5 : twoSame ? 0.65 : 1.0,
    output: r.winner.name,
    runnerUp: r.runnerUp ? r.runnerUp.name : null,
    distance: scaled20ToNumber(r.distScaled20),
    margin: r.marginScaled20 !== undefined && r.runnerUp ? scaled20ToNumber(r.marginScaled20) : null,
    exactTie: r.tie,
    time: r.winner.time,
    heat: r.winner.heat,
  };
}

// Full enumeration. Returns compact parallel arrays over all C(n+2,3) triples.
function compileCauldron(db) {
  const inputs = eligibleInputs(db);
  const targets = outputTargets(db);
  const n = inputs.length;
  const count = (n * (n + 1) * (n + 2)) / 6;

  const triA = new Uint16Array(count);
  const triB = new Uint16Array(count);
  const triC = new Uint16Array(count);
  const outIdx = new Uint16Array(count); // index into targets
  const margin = new Float64Array(count); // winning margin (cost units); 0 = exact tie
  const flags = new Uint8Array(count); // 1 = exactTie, 2 = selfConsuming

  const targetIndex = new Map(targets.map((t, i) => [t.name, i]));
  const costs = inputs.map((it) => it.costScaled);
  const names = inputs.map((it) => it.name);

  let w = 0;
  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    for (let j = i; j < n; j++) {
      const cij = ci + costs[j];
      for (let k = j; k < n; k++) {
        const sum = cij + costs[k];
        const allSame = i === j && j === k;
        const twoSame = !allSame && (i === j || j === k);
        const t20 = sum * (allSame ? 10n : twoSame ? 13n : 20n);
        const r = resolveOutput(t20, targets);
        triA[w] = i; triB[w] = j; triC[w] = k;
        outIdx[w] = targetIndex.get(r.winner.name);
        margin[w] = r.runnerUp ? scaled20ToNumber(r.marginScaled20) : Infinity;
        let f = 0;
        if (r.tie) f |= 1;
        const out = r.winner.name;
        if (out === names[i] || out === names[j] || out === names[k]) f |= 2;
        flags[w] = f;
        w++;
      }
    }
  }

  // inverted index: input index → list of triple indexes (built lazily; large)
  let inverted = null;
  const invertedIndex = () => {
    if (inverted) return inverted;
    const counts = new Uint32Array(n);
    for (let t = 0; t < count; t++) {
      counts[triA[t]]++;
      if (triB[t] !== triA[t]) counts[triB[t]]++;
      if (triC[t] !== triB[t] && triC[t] !== triA[t]) counts[triC[t]]++;
    }
    const offsets = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + counts[i];
    const data = new Uint32Array(offsets[n]);
    const cursor = offsets.slice(0, n);
    for (let t = 0; t < count; t++) {
      data[cursor[triA[t]]++] = t;
      if (triB[t] !== triA[t]) data[cursor[triB[t]]++] = t;
      if (triC[t] !== triB[t] && triC[t] !== triA[t]) data[cursor[triC[t]]++] = t;
    }
    inverted = { offsets, data };
    return inverted;
  };

  return {
    inputs,
    inputIndex: new Map(inputs.map((it, i) => [it.name, i])),
    targets,
    targetIndex,
    count,
    triA, triB, triC, outIdx, margin, flags,
    invertedIndex,
  };
}

// Eligibility mask over the compiled triples for a given config — the SINGLE source of
// truth shared by the LP normalizer (`normalize.js`) and the tile composer (`composer.js`).
// Forbidding a cauldron output is a triple-mask operation, NOT a recipe-id denylist (the
// triples are generated, not curated rows), so both callers must derive eligibility the
// same way or they drift. Returns the mask plus, optionally, an output→eligible-triples
// index the composer needs to enumerate cauldron producers of an item.
//
//   locked(name) → true if the item is above the active tier (caller supplies the rule).
//   buildOutputIndex → also return `byOutput`: Map<targetName, tripleIdx[]> over eligible
//     triples (the LP doesn't need it — it materializes columns lazily — so it's opt-in).
function cauldronEligibility(db, cfg, { locked, compiled, buildOutputIndex = false } = {}) {
  const c = compiled || compileCauldron(db);
  const { inputs, targets, count, triA, triB, triC, outIdx, margin, flags } = c;

  // input-pool allow mask
  const poolAllowed = new Uint8Array(inputs.length).fill(1);
  const pool = cfg.cauldron.inputPool;
  // "growable" = an item you produce in a Nursery (the 9 Herbs: Flax, Sage,
  // Chamomile, …). Seeds are a separate, BUYABLE category, so they count as
  // buyables, not growables.
  const NURSERY = new Set(['Nursery', 'World Tree Nursery']);
  const growable = new Set();
  for (const r of db.recipes) if (NURSERY.has(r.machine)) for (const o of Object.keys(r.outputs || {})) growable.add(o);
  if (pool === 'buyables') {
    inputs.forEach((it, i) => { poolAllowed[i] = it.buyPrice !== undefined ? 1 : 0; });
  } else if (pool === 'growables') {
    inputs.forEach((it, i) => { poolAllowed[i] = growable.has(it.name) ? 1 : 0; });
  } else if (pool === 'buyables+growables') {
    inputs.forEach((it, i) => { poolAllowed[i] = (it.buyPrice !== undefined || growable.has(it.name)) ? 1 : 0; });
  } else if (pool === 'easy') {
    // "easy" = buyable ∪ growable ∪ anything craftable in ONE recipe step from those
    // (Sand ← buyable Rock Salt; Sage Powder ← grown Sage). Multi-step items (Linen
    // Thread ← Flax Fiber ← Flax) stay out — only base + depth-1 crafts qualify. A
    // recipe counts if ALL its item inputs are in the base set (one of its recipes
    // is enough — you can make it the easy way).
    const base = new Set();
    for (const [n, it] of Object.entries(db.items)) if (it.buyPrice !== undefined || growable.has(n)) base.add(n);
    const easy = new Set(base);
    for (const r of db.recipes) {
      const ins = Object.keys(r.inputs || {});
      if (ins.length && ins.every((i) => base.has(i))) for (const o of Object.keys(r.outputs || {})) easy.add(o);
    }
    inputs.forEach((it, i) => { poolAllowed[i] = easy.has(it.name) ? 1 : 0; });
  } else if (pool && typeof pool === 'object' && pool.allow) {
    const allow = new Set(pool.allow);
    inputs.forEach((it, i) => { poolAllowed[i] = allow.has(it.name) ? 1 : 0; });
  } else if (pool && typeof pool === 'object' && pool.deny) {
    const deny = new Set(pool.deny);
    inputs.forEach((it, i) => { poolAllowed[i] = deny.has(it.name) ? 0 : 1; });
  } else if (pool !== 'unrestricted') {
    throw new Error(`unknown cauldron input pool: ${JSON.stringify(pool)}`);
  }

  const isLocked = locked || (() => false);
  const forbidCauldron = new Set(cfg.cauldron.forbidFor);
  const outputForbidden = targets.map((t) => forbidCauldron.has(t.name));
  const inputLocked = inputs.map((it) => isLocked(it.name));
  const outputLocked = targets.map((t) => isLocked(t.name));
  const mask = new Uint8Array(count);
  const byOutput = buildOutputIndex ? new Map() : null;
  let eligibleCount = 0;
  for (let t = 0; t < count; t++) {
    if (!poolAllowed[triA[t]] || !poolAllowed[triB[t]] || !poolAllowed[triC[t]]) continue;
    if (inputLocked[triA[t]] || inputLocked[triB[t]] || inputLocked[triC[t]] || outputLocked[outIdx[t]]) continue;
    if (outputForbidden[outIdx[t]]) continue;
    if (!cfg.cauldron.allowSelfConsuming && (flags[t] & 2)) continue;
    if (cfg.cauldron.minMargin > 0 && margin[t] < cfg.cauldron.minMargin) continue;
    mask[t] = 1;
    eligibleCount++;
    if (byOutput) {
      const nm = targets[outIdx[t]].name;
      let arr = byOutput.get(nm);
      if (!arr) byOutput.set(nm, (arr = []));
      arr.push(t);
    }
  }
  return { compiled: c, poolAllowed, mask, eligibleCount, byOutput };
}

// Validate curated machine:"Cauldron" recipe rows in the DB against the formula
// (DESIGN.md: the Ruby row is known to contradict it — quarantine, don't trust).
function validateCuratedRows(db, compiled) {
  const c = compiled || compileCauldron(db);
  const results = [];
  for (const recipe of db.recipes) {
    if (recipe.machine !== 'Cauldron' && recipe.machine !== 'Advanced Cauldron') continue;
    const inputNames = [];
    for (const [name, qty] of Object.entries(recipe.inputs || {})) {
      for (let q = 0; q < qty; q++) inputNames.push(name);
    }
    if (inputNames.length !== 3) {
      results.push({ recipe: recipe.id, status: 'skipped', reason: `${inputNames.length} inputs, not 3` });
      continue;
    }
    if (!inputNames.every((nm) => c.inputIndex.has(nm))) {
      results.push({ recipe: recipe.id, status: 'skipped', reason: 'ineligible input' });
      continue;
    }
    const r = resolveTriple(db, inputNames, c);
    const expected = Object.keys(recipe.outputs)[0];
    results.push({
      recipe: recipe.id,
      status: r.output === expected ? 'consistent' : 'CONTRADICTION',
      formulaOutput: r.output,
      curatedOutput: expected,
      T: r.T,
      distance: r.distance,
    });
  }
  return results;
}

module.exports = { compileCauldron, cauldronEligibility, resolveTriple, cauldronStats, validateCuratedRows, toScaled, scaled20ToNumber };
