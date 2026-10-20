// Building passages (overbouwingen): OSM roads tagged tunnel=building_passage / covered=yes that run
// under a 3D BAG building (e.g. the Geestersingel under the 1970 office block, pand 0361100000105735).
// 3D BAG models such a building down to the ground, so the road would end in a solid wall. This
// module finds the passage area per building (plan polygons + clear height); build.mjs /
// buildings.mjs use it to cut the walls (render and collision), add a ceiling and the passage side
// walls, and keep the passage out of footprints.json.
import { resolve } from 'node:path';
import polygonClipping from 'polygon-clipping';
import { loadOsm } from '../../osm/lib/osm.mjs';
import { ROOT } from './config.mjs';
import { pointInPolygon } from './geom.mjs';

/** Default carriageway widths (m); car roads also get a 1.8 m footway / cycle strip each side. */
const ROAD_W = {
  motorway: 7, trunk: 7, primary: 6.5, secondary: 6.5, tertiary: 6, unclassified: 5.5, residential: 5.5,
  living_street: 4.5, service: 3.6, busway: 3.5, cycleway: 2.5, pedestrian: 4, footway: 2, path: 2,
};
const CAR = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|busway)(_link)?$/;
/** Ways that open a passage (walkers keep the archway-less BAG shell: not drivable anyway). */
const OPENS = (t) => (t.tunnel === 'building_passage' || t.covered === 'yes') && (CAR.test(t.highway) || t.highway === 'cycleway');

const bboxOf = (pts) => {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pts) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
  return bb;
};
const overlaps = (a, b, m = 0) => a[0] <= b[2] + m && a[2] >= b[0] - m && a[1] <= b[3] + m && a[3] >= b[1] - m;

function widthOf(t) {
  const w = parseFloat(t.width);
  if (Number.isFinite(w) && w > 1) return w;
  const lanes = parseInt(t.lanes ?? '', 10);
  if (CAR.test(t.highway) && lanes > 0) return Math.min(14, lanes * 3.1 + (lanes === 1 ? 0.6 : 0));
  return ROAD_W[t.highway.replace('_link', '')] ?? 4;
}

/** Buffered polyline (flat caps, ends extended by `ext`) as a polygon-clipping MultiPolygon. */
function corridor(pts, hw, ext) {
  const P = pts.map((p) => [p[0], p[1]]);
  const n = P.length;
  const dir = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  const d0 = dir(P[1], P[0]), d1 = dir(P[n - 2], P[n - 1]);
  P[0] = [P[0][0] + d0[0] * ext, P[0][1] + d0[1] * ext];
  P[n - 1] = [P[n - 1][0] + d1[0] * ext, P[n - 1][1] + d1[1] * ext];
  const polys = [];
  for (let i = 1; i < n; i++) {
    const a = P[i - 1], b = P[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3) continue;
    const [dx, dz] = dir(a, b);
    const nx = -dz * hw, nz = dx * hw;
    polys.push([[[a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz], [a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz]]]);
  }
  for (let i = 1; i < n - 1; i++) {
    // octagonal joint so bends stay closed
    const ring = [];
    for (let k = 0; k <= 8; k++) { const a = (k % 8) * Math.PI / 4; ring.push([P[i][0] + Math.cos(a) * hw, P[i][1] + Math.sin(a) * hw]); }
    polys.push([ring]);
  }
  return polys.length ? polygonClipping.union(...polys) : [];
}

const mpArea = (mp) => {
  let A = 0;
  for (const poly of mp) poly.forEach((r, k) => {
    let a = 0;
    for (let i = 0; i + 1 < r.length; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    A += (k === 0 ? 1 : -1) * Math.abs(a / 2);
  });
  return A;
};
/** Andrew's monotone chain. */
function convexHull(pts) {
  const P = pts.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
const closeRing = (r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);

/**
 * Passage areas per building id: Map<bid, { mp: MultiPolygon (closed rings), ways: number[] }>.
 * For a building with a tagged passage, every other road / path crossing its footprint (parallel
 * cycle track, footway) is opened too.
 */
export function findPassages(buildings, log = console.log) {
  let osm;
  try { osm = loadOsm(resolve(ROOT, 'data-raw/osm')); } catch (e) { log(`passages: no OSM cache (${e.message})`); return new Map(); }
  const roads = osm.ways.filter((w) => w.tags.highway && w.pts.length >= 2 && w.tags.highway !== 'steps').map((w) => ({ w, bb: bboxOf(w.pts) }));
  const blds = [...buildings].map((b) => ({ b, bb: bboxOf(b.footprint[0]) }));
  const out = new Map();
  for (const { w, bb } of roads) {
    if (!OPENS(w.tags)) continue;
    for (const B of blds) {
      if (!overlaps(bb, B.bb, 3)) continue;
      if (!w.pts.some((p) => pointInPolygon(p[0], p[1], B.b.footprint)) && !w.pts.some((p, i) => i > 0 && pointInPolygon((p[0] + w.pts[i - 1][0]) / 2, (p[1] + w.pts[i - 1][1]) / 2, B.b.footprint))) continue;
      if (!out.has(B.b.id)) out.set(B.b.id, { b: B.b, bb: B.bb, ways: [] });
    }
  }
  const res = new Map();
  const dirOf = (pts) => { const a = pts[0], c = pts[pts.length - 1], l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [(c[0] - a[0]) / l, (c[1] - a[1]) / l]; };
  for (const [bid, P] of out) {
    const fpRings = P.b.footprint.map((r) => closeRing(r.map((p) => [p[0], p[1]])));
    const fp = [fpRings];
    // footprint grown by 2 m: the passage reaches just past the facades, so the wall cut is not
    // decided on the facade line itself
    const grow = [fp];
    for (const r of fpRings) for (let i = 0; i + 1 < r.length; i++) {
      const a = r[i], c = r[i + 1], dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const nx = (-dz / l) * 2, nz = (dx / l) * 2;
      grow.push([[[a[0] - nx, a[1] - nz], [c[0] - nx, c[1] - nz], [c[0] + nx, c[1] + nz], [a[0] + nx, a[1] + nz], [a[0] - nx, a[1] - nz]]]);
    }
    const grown = polygonClipping.union(...grow);
    // tagged passage ways, plus untagged roads / paths that run through next to them in the same
    // direction (parallel cycle tracks, footways, the other carriageway)
    const tagged = [];
    const cand = [];
    for (const { w, bb } of roads) {
      if (!overlaps(bb, P.bb, 3)) continue;
      const car = CAR.test(w.tags.highway);
      const c = corridor(w.pts, widthOf(w.tags) / 2 + (car ? 1.8 : 0.4), 3);
      if (!c.length) continue;
      const inter = polygonClipping.intersection(c, fp);
      if (mpArea(inter) < 2) continue;
      const inside = w.pts.filter((p) => pointInPolygon(p[0], p[1], fpRings));
      const rec = { w, c, dir: dirOf(inside.length >= 2 ? inside : w.pts), mid: inside.length ? inside[Math.floor(inside.length / 2)] : w.pts[Math.floor(w.pts.length / 2)] };
      (OPENS(w.tags) ? tagged : cand).push(rec);
    }
    if (!tagged.length) continue;
    const near = (r) => tagged.some((t) => {
      const cos = Math.abs(t.dir[0] * r.dir[0] + t.dir[1] * r.dir[1]);
      let d = Infinity;
      for (let i = 1; i < t.w.pts.length; i++) {
        const a = t.w.pts[i - 1], c = t.w.pts[i], dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
        const u = Math.max(0, Math.min(1, ((r.mid[0] - a[0]) * dx + (r.mid[1] - a[1]) * dz) / l2));
        d = Math.min(d, Math.hypot(a[0] + dx * u - r.mid[0], a[1] + dz * u - r.mid[1]));
      }
      return cos > Math.cos((35 * Math.PI) / 180) && d < 20;
    });
    const use = [...tagged, ...cand.filter(near)];
    const raw = polygonClipping.intersection(polygonClipping.union(...use.map((r) => r.c)), grown);
    if (!raw.length) continue;
    // one opening: the convex hull of the corridors (no thin piers between carriageway, cycle
    // track and footway), still limited to the grown footprint
    const hull = convexHull(raw.flatMap((poly) => poly[0]));
    const mp = hull.length >= 3 ? polygonClipping.intersection([[closeRing(hull)]], grown) : raw;
    res.set(bid, { mp, ways: use.map((r) => r.w.id), area: mpArea(polygonClipping.intersection(mp, fp)) });
  }
  return res;
}

/**
 * Clear height of a passage: 1 m under the lowest roof surface above it (sampled every metre),
 * at most 4.6 m; null when the building is too low over the road for a passage.
 */
export function passageHeight(prep, mp) {
  let lowest = Infinity;
  const bb = bboxOf(mp.flatMap((poly) => poly[0]));
  const inMp = (x, z) => mp.some((poly) => pointInPolygon(x, z, poly));
  const roofs = prep.roofs.filter((r) => Math.abs(r.n[1]) > 0.05).map((r) => ({ ring: r.rings[0].map((p) => [p[0], p[2]]), n: r.n, p0: r.rings[0][0] }));
  for (let x = bb[0] + 0.5; x < bb[2]; x += 1) for (let z = bb[1] + 0.5; z < bb[3]; z += 1) {
    if (!inMp(x, z)) continue;
    for (const r of roofs) {
      if (!pointInPolygon(x, z, [r.ring])) continue;
      const y = r.p0[1] - (r.n[0] * (x - r.p0[0]) + r.n[2] * (z - r.p0[2])) / r.n[1];
      lowest = Math.min(lowest, y);
    }
  }
  if (!Number.isFinite(lowest)) return 4.6;
  const h = Math.min(4.6, lowest - 1.0);
  return h >= 2.6 ? h : null;
}

/**
 * Car carriageways from the OSM cache as a grid of centre-line segments with half widths:
 * near(x, z) -> true when (x, z) lies on a car road.
 */
export function carRoadIndex(log = console.log) {
  let osm;
  try { osm = loadOsm(resolve(ROOT, 'data-raw/osm')); } catch (e) { log(`car roads: no OSM cache (${e.message})`); return null; }
  const C = 16, grid = new Map();
  for (const w of osm.ways) {
    const t = w.tags;
    if (!t.highway || !CAR.test(t.highway) || t.area === 'yes' || (t.tunnel && t.tunnel !== 'building_passage')) continue;
    const hw = widthOf(t) / 2;
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1], b = w.pts[i];
      const sg = [a[0], a[1], b[0], b[1], hw];
      for (let gx = Math.floor((Math.min(a[0], b[0]) - hw) / C); gx <= Math.floor((Math.max(a[0], b[0]) + hw) / C); gx++)
        for (let gz = Math.floor((Math.min(a[1], b[1]) - hw) / C); gz <= Math.floor((Math.max(a[1], b[1]) + hw) / C); gz++) {
          const k = gx * 65536 + gz; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(sg);
        }
    }
  }
  return {
    near(x, z) {
      for (const [ax, az, bx, bz, hw] of grid.get(Math.floor(x / C) * 65536 + Math.floor(z / C)) ?? []) {
        const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        if (Math.hypot(ax + dx * u - x, az + dz * u - z) < hw) return true;
      }
      return false;
    },
  };
}

/** Intervals [s0, s1] (s along the line p(s) = o + s*d) inside the passage polygons. */
export function lineIntervals(mp, o, d, sMin, sMax) {
  const ss = [sMin, sMax];
  for (const poly of mp) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) {
    const a = r[i], b = r[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = d[0] * ez - d[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const s = ((a[0] - o[0]) * ez - (a[1] - o[1]) * ex) / den;
    const u = ((a[0] - o[0]) * d[1] - (a[1] - o[1]) * d[0]) / den;
    if (u >= 0 && u <= 1 && s > sMin && s < sMax) ss.push(s);
  }
  ss.sort((p, q) => p - q);
  const out = [];
  for (let i = 0; i + 1 < ss.length; i++) {
    const s0 = ss[i], s1 = ss[i + 1];
    if (s1 - s0 < 0.05) continue;
    const m = (s0 + s1) / 2;
    if (mp.some((poly) => pointInPolygon(o[0] + d[0] * m, o[1] + d[1] * m, poly))) {
      if (out.length && Math.abs(out[out.length - 1][1] - s0) < 1e-6) out[out.length - 1][1] = s1;
      else out.push([s0, s1]);
    }
  }
  return out;
}
