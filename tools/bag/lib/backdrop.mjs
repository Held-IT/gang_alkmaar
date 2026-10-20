// Backdrop buildings (outside the detailed area): simplified LoD 1.2 extrusions of the BAG
// footprint up to b3_h_dak_70p. Walls hidden by an equally high or higher neighbour are removed.
import { buildingColor, coveredIntervals, mergeIntervals, WALL_BOTTOM } from './buildings.mjs';
import { signedArea2, simplifyRing, triangulate2 } from './geom.mjs';

export const BACKDROP_SIMPLIFY = 0.6; // m (Douglas-Peucker)
export const BACKDROP_MIN_AREA = 25; // m^2: drop sheds / garages
export const BACKDROP_MIN_HEIGHT = 2.2;

/** LoD 1.2 height above maaiveld (m), or null when unknown. */
export function lod12Height(b) {
  const h = b.attrs.b3_h_dak_70p;
  if (!Number.isFinite(h)) return null;
  return h - b.maaiveld;
}

/** Simplified footprint rings ([outer, ...holes larger than minHoleArea]); orientation unchanged. */
export function simplifiedRings(b, tol, minHoleArea = 40) {
  const out = [];
  b.footprint.forEach((r, k) => {
    if (k > 0 && Math.abs(signedArea2(r)) < minHoleArea) return;
    const s = simplifyRing(r, tol);
    if (s.length >= 3 && Math.abs(signedArea2(s)) > 0.5) out.push(s);
  });
  return out;
}

/**
 * Emit a backdrop building into PrimBuilder `pb` (material 'backdrop').
 * Walls: uv0 = (u along wall, y), uv1 = (wall width, height); roof: uv0 = (x, z), uv1 = (0, 0).
 */
export function emitBackdrop(b, h, edgeIndex, pb, stats, neighbourFilter = () => true) {
  const rings = simplifiedRings(b, BACKDROP_SIMPLIFY);
  if (!rings.length) return;
  const col = buildingColor(b);
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k];
    // Outward normal: footprint (x, z) with z = south. For a ring that is CCW seen from above
    // (signed area in (x, -z) > 0), the outward normal of edge a->b is (dz, -dx)/len in (x, z).
    const ccw = signedArea2(ring.map((p) => [p[0], -p[1]])) > 0;
    const outerSign = (k === 0 ? 1 : -1) * (ccw ? 1 : -1);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.1) continue;
      // normal: rotate direction by -90 deg seen from above
      let n2 = [-dz / len, dx / len];
      n2 = [n2[0] * outerSign, n2[1] * outerSign];
      const t = [n2[1], -n2[0]];
      const w0 = a[0] * n2[0] + a[1] * n2[1];
      const sa = a[0] * t[0] + a[1] * t[1];
      const sc = c[0] * t[0] + c[1] * t[1];
      const s0 = Math.min(sa, sc), s1 = Math.max(sa, sc);
      // parts covered by a neighbour at least as high are invisible
      const cov = coveredIntervals(edgeIndex, b.id, t, n2, w0, s0, s1, 0.3, (e) => e.h >= h - 0.3 && neighbourFilter(e));
      const vis = complement(cov, s0, s1);
      stats.backdropWalls++;
      for (const [lo, hi] of vis) {
        if (hi - lo < 0.15) continue;
        const P = (s, y) => [s * t[0] + w0 * n2[0], y, s * t[1] + w0 * n2[1]];
        const nrm = [n2[0], 0, n2[1]];
        const i0 = pb.vertex(P(lo, WALL_BOTTOM), nrm, [lo - s0, WALL_BOTTOM], [s1 - s0, h], col);
        const i1 = pb.vertex(P(hi, WALL_BOTTOM), nrm, [hi - s0, WALL_BOTTOM], [s1 - s0, h], col);
        const i2 = pb.vertex(P(hi, h), nrm, [hi - s0, h], [s1 - s0, h], col);
        const i3 = pb.vertex(P(lo, h), nrm, [lo - s0, h], [s1 - s0, h], col);
        // CCW seen from outside (s to the right, y up)
        pb.tri(i0, i1, i2);
        pb.tri(i0, i2, i3);
        stats.backdropTris += 2;
      }
    }
  }
  // flat roof
  const idx = triangulate2(rings);
  const flat = rings.flat();
  const base = flat.map((p) => pb.vertex([p[0], h, p[1]], [0, 1, 0], [p[0], p[1]], [0, 0], col));
  for (let i = 0; i < idx.length; i += 3) {
    const A = flat[idx[i]], B = flat[idx[i + 1]], C = flat[idx[i + 2]];
    // facing up: CCW seen from above. In (x, z) with z south, "seen from above" CCW means the
    // cross product (B-A) x (C-A) in (x, z) is negative.
    const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(cr) < 1e-8) continue;
    if (cr < 0) pb.tri(base[idx[i]], base[idx[i + 1]], base[idx[i + 2]]);
    else pb.tri(base[idx[i]], base[idx[i + 2]], base[idx[i + 1]]);
    stats.backdropTris++;
  }
}

export function complement(ints, s0, s1) {
  const out = [];
  let cur = s0;
  for (const [lo, hi] of mergeIntervals(ints.map((x) => [x[0], x[1]]), 0.05)) {
    if (lo > cur) out.push([cur, Math.min(lo, s1)]);
    cur = Math.max(cur, hi);
  }
  if (cur < s1) out.push([cur, s1]);
  return out;
}
