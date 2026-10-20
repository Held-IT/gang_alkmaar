// Small geometry helpers for the BAG pipeline (pure JS, no deps except earcut).
import earcut from 'earcut';

/** Newell normal (not normalised) of a 3D ring given as array of [x,y,z]. */
export function newell(ring) {
  let nx = 0, ny = 0, nz = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

export function len3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize3(v) {
  const l = len3(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Signed area of a 2D ring [[x,y],...] (positive = counter-clockwise in a y-up frame). */
export function signedArea2(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function centroid2(ring) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    // degenerate: average of points
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Point in polygon (even-odd) for a 2D ring. */
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in polygon with holes ([outer, ...holes]). */
export function pointInPolygon(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false;
  return true;
}

/** Douglas-Peucker simplification of a closed 2D ring (no repeated closing point). */
export function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring.slice();
  // Split at the two most distant points to treat the ring as two polylines.
  let i0 = 0, i1 = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > best) { best = d; i1 = i; }
  }
  const keep = new Uint8Array(ring.length);
  keep[i0] = keep[i1] = 1;
  const stack = [[i0, i1], [i1, ring.length]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const pa = ring[a];
    const pb = ring[b % ring.length];
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(ring[i], pa, pb);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 3 ? out : ring.slice();
}

export function segDist2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return x * x + y * y;
}

/** Remove consecutive duplicates (and the closing duplicate) from a ring. */
export function cleanRing(ring, eps = 1e-4) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(p[0] - q[0]) > eps || Math.abs(p[1] - q[1]) > eps || (p.length > 2 && Math.abs(p[2] - q[2]) > eps)) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && (a.length <= 2 || Math.abs(a[2] - b[2]) <= eps)) out.pop();
    else break;
  }
  return out;
}

/**
 * Triangulate a planar 3D polygon with holes. `rings` = [outer, ...holes], each [[x,y,z],...].
 * `normal` = unit normal the triangles must face. Returns { pts: [[x,y,z]...], tris: [i,j,k,...] }
 * with indices into pts (all rings concatenated).
 */
export function triangulate3(rings, normal) {
  // Projection basis on the polygon plane.
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  // tangent u: any vector perpendicular to n
  let t = ay < 0.9 ? [0, 1, 0] : [1, 0, 0];
  // u = normalize(t x n), v = n x u
  let u = [t[1] * normal[2] - t[2] * normal[1], t[2] * normal[0] - t[0] * normal[2], t[0] * normal[1] - t[1] * normal[0]];
  u = normalize3(u);
  const v = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]];
  void ax; void az;
  const flat = [];
  const holes = [];
  const pts = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(pts.length);
    for (const p of rings[r]) {
      pts.push(p);
      flat.push(p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]);
    }
  }
  const idx = earcut(flat, holes.length ? holes : undefined, 2);
  const tris = [];
  for (let i = 0; i < idx.length; i += 3) {
    let a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const pa = pts[a], pb = pts[b], pc = pts[c];
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const area2 = len3(cr);
    if (area2 < 1e-6) continue; // degenerate
    const d = (cr[0] * normal[0] + cr[1] * normal[1] + cr[2] * normal[2]) / area2;
    // Slivers caused by slightly non-planar input polygons: tiny triangles whose own normal
    // deviates strongly from the polygon normal are dropped (invisible, but they would shade
    // inconsistently with the flat polygon normal).
    if (Math.abs(d) < 0.5 && area2 < 0.1) continue;
    if (d < 0) { const tmp = b; b = c; c = tmp; }
    tris.push(a, b, c);
  }
  return { pts, tris };
}

/** Triangulate a 2D polygon with holes ([outer, ...holes] of [x,z]) -> index array (earcut order). */
export function triangulate2(rings) {
  const flat = [];
  const holes = [];
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2);
    for (const p of rings[r]) flat.push(p[0], p[1]);
  }
  return earcut(flat, holes.length ? holes : undefined, 2);
}

/** Clip a 2D polygon (array of [u, y, ...extra]) to the half-plane u >= c (keep=+1) or u <= c (keep=-1). */
export function clipU(poly, c, keep) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const pin = keep > 0 ? p[0] >= c : p[0] <= c;
    const qin = keep > 0 ? q[0] >= c : q[0] <= c;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = (c - p[0]) / (q[0] - p[0]);
      out.push([c, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** FNV-1a 32-bit hash of a string -> [0, 1). */
export function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche (murmur3 fmix32)
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
