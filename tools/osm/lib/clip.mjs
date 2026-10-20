// Robust wrappers around polygon-clipping. All geometry here is a MultiPolygon
// (array of polygons, each [outer, ...holes], rings closed or open). Empty = [].
//
// polygon-clipping occasionally throws on near-degenerate input; on failure we retry with the
// inputs snapped to a coarser grid, and finally fall back to a conservative result.
import pc from 'polygon-clipping';
import { openRing, ringArea } from './geom.mjs';

let failures = 0;
let context = '';
export const clipFailures = () => failures;
/** Label printed with failure warnings (e.g. the tile being processed). */
export const setClipContext = (label) => { context = label; };

function snapRing(r, g) {
  const out = [];
  for (const p of r) {
    const q = [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g];
    const l = out[out.length - 1];
    if (l && l[0] === q[0] && l[1] === q[1]) continue;
    out.push(q);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function snapMulti(mp, g) {
  const out = [];
  for (const poly of mp) {
    const rings = [];
    for (let i = 0; i < poly.length; i++) {
      const r = snapRing(poly[i], g);
      if (r.length < 3 || Math.abs(ringArea(r)) < g * g) {
        if (i === 0) break;
        continue;
      }
      rings.push(r);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/** Drop tiny slivers / degenerate rings from an op result. */
export function clean(mp, minArea = 0.01) {
  const out = [];
  for (const poly of mp) {
    const outer = openRing(poly[0]);
    if (outer.length < 3 || Math.abs(ringArea(outer)) < minArea) continue;
    const rings = [outer];
    for (let i = 1; i < poly.length; i++) {
      const h = openRing(poly[i]);
      if (h.length >= 3 && Math.abs(ringArea(h)) >= minArea * 0.1) rings.push(h);
    }
    out.push(rings);
  }
  return out;
}

function run(op, geoms, quiet = false) {
  const nonEmpty = geoms.filter((g) => g && g.length);
  const grids = [0, 1e-4, 1e-3, 5e-3, 2e-2];
  let lastErr;
  for (const g of grids) {
    try {
      const inp = g ? nonEmpty.map((m) => snapMulti(m, g)).filter((m) => m.length) : nonEmpty;
      if (op === 'union') {
        if (!inp.length) return [];
        return pc.union(...inp);
      }
      if (op === 'intersection') {
        if (inp.length < nonEmpty.length || inp.length < 2) return [];
        return pc.intersection(...inp);
      }
      if (op === 'difference') {
        const first = g ? snapMulti(geoms[0], g) : geoms[0];
        if (!first.length) return [];
        const rest = geoms.slice(1).map((m) => (g ? snapMulti(m, g) : m)).filter((m) => m.length);
        if (!rest.length) return first;
        return pc.difference(first, ...rest);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  if (quiet) return null;
  return fail(op, lastErr, geoms);
}

function fail(op, lastErr, geoms) {
  failures++;
  console.warn(`[clip] ${op} failed after retries (${context}): ${lastErr?.message}`);
  if (process.env.CLIP_DEBUG && failures < 3) { console.warn(lastErr?.stack); console.warn(JSON.stringify(geoms).slice(0, 600)); }
  return null;
}

export function union(...geoms) {
  const r = run('union', geoms, true);
  if (r) return r;
  console.warn(`[clip] union: piecewise fallback (${context})`);
  // fallback: fold the individual polygons in one by one (different sweep-line situations);
  // a polygon that still fails is appended as is (may overlap, but never lost)
  const polys = geoms.filter((g) => g && g.length).flat();
  let acc = [];
  for (const p of polys) {
    const u = acc.length ? run('union', [acc, [p]], true) : [p];
    acc = u ?? [...acc, p];
  }
  return acc;
}

export function intersection(a, b) {
  if (!a?.length || !b?.length) return [];
  const r = run('intersection', [a, b], true);
  if (r) return r;
  console.warn(`[clip] intersection: piecewise fallback (${context})`);
  // fallback: intersect polygon by polygon (results of disjoint inputs stay disjoint)
  const out = [];
  const [many, other] = a.length >= b.length ? [a, b] : [b, a];
  for (const p of many) {
    const q = run('intersection', [[p], other], true);
    if (q) out.push(...q);
    else console.warn(`[clip] intersection piece lost (${context})`);
  }
  return out;
}

export function difference(a, ...bs) {
  if (!a?.length) return [];
  const sub = bs.filter((g) => g && g.length);
  if (!sub.length) return a;
  const r = run('difference', [a, ...sub]);
  if (r) return r;
  // fallback: subtract one by one
  let cur = a;
  for (const b of sub) {
    const rr = run('difference', [cur, b]);
    if (rr) cur = rr;
  }
  return cur;
}

/** Union a large list of small polygons in batches (faster + more robust than one huge call). */
export function unionMany(polys, batch = 400) {
  if (!polys.length) return [];
  let parts = [];
  for (let i = 0; i < polys.length; i += batch) {
    parts.push(union(...polys.slice(i, i + batch).map((p) => [p])));
  }
  while (parts.length > 1) {
    const next = [];
    for (let i = 0; i < parts.length; i += 2) next.push(i + 1 < parts.length ? union(parts[i], parts[i + 1]) : parts[i]);
    parts = next;
  }
  return parts[0];
}
