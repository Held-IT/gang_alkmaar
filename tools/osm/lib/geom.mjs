// 2D geometry helpers. Points are [x, z] arrays (local metres). "CCW" means positive shoelace
// area when (x, z) is treated as a math (x, y) plane. Polygons are [outerRing, ...holeRings];
// a multipolygon is an array of polygons (same as polygon-clipping).

export function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i];
    const q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function polyArea(poly) {
  let a = Math.abs(ringArea(poly[0]));
  for (let i = 1; i < poly.length; i++) a -= Math.abs(ringArea(poly[i]));
  return a;
}

export function multiArea(mp) {
  let a = 0;
  for (const p of mp) a += polyArea(p);
  return a;
}

/** Removes the closing duplicate point (and consecutive duplicates). */
export function openRing(r) {
  const out = [];
  for (const p of r) {
    const l = out[out.length - 1];
    if (l && Math.abs(l[0] - p[0]) < 1e-9 && Math.abs(l[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(l[0] - f[0]) < 1e-9 && Math.abs(l[1] - f[1]) < 1e-9) out.pop();
  }
  return out;
}

export function closeRing(r) {
  const o = openRing(r);
  if (o.length) o.push([o[0][0], o[0][1]]);
  return o;
}

/** Outer rings CCW (area > 0), holes CW. Rings returned open. */
export function normalizePoly(poly) {
  return poly.map((r, i) => {
    const o = openRing(r);
    const a = ringArea(o);
    if ((i === 0 && a < 0) || (i > 0 && a > 0)) o.reverse();
    return o;
  });
}

export function bboxOfPts(pts, bb = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (const p of pts) {
    if (p[0] < bb[0]) bb[0] = p[0];
    if (p[1] < bb[1]) bb[1] = p[1];
    if (p[0] > bb[2]) bb[2] = p[0];
    if (p[1] > bb[3]) bb[3] = p[1];
  }
  return bb;
}

export function bboxOfMulti(mp) {
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of mp) bboxOfPts(poly[0], bb);
  return bb;
}

export const bboxOverlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x, z, poly) {
  if (!pointInRing(x, z, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) if (pointInRing(x, z, poly[i])) return false;
  return true;
}

export function pointInMulti(x, z, mp) {
  for (const p of mp) if (pointInPoly(x, z, p)) return true;
  return false;
}

/** Squared distance from p to segment ab, and the parameter t on ab. */
export function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px, qz = az + t * dz - pz;
  return { d2: qx * qx + qz * qz, t };
}

export function polylineLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

export function cumLengths(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}

/** Point + unit direction at distance s along the polyline (clamped). */
export function pointAt(pts, cum, s) {
  const n = pts.length;
  if (s <= 0) {
    const d = dirOf(pts[0], pts[1]);
    return { x: pts[0][0], z: pts[0][1], dx: d[0], dz: d[1], seg: 0 };
  }
  for (let i = 1; i < n; i++) {
    if (cum[i] >= s || i === n - 1) {
      const segL = cum[i] - cum[i - 1] || 1e-9;
      const t = Math.min(1, (s - cum[i - 1]) / segL);
      const a = pts[i - 1], b = pts[i];
      const d = dirOf(a, b);
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: d[0], dz: d[1], seg: i - 1 };
    }
  }
  const d = dirOf(pts[n - 2], pts[n - 1]);
  return { x: pts[n - 1][0], z: pts[n - 1][1], dx: d[0], dz: d[1], seg: n - 2 };
}

export function dirOf(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Closest point on polyline: { s (distance along), d (distance), x, z, dx, dz }. */
export function projectOnPolyline(pts, cum, x, z) {
  let best = { d2: Infinity, s: 0, x: 0, z: 0, dx: 1, dz: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const r = segDist2(x, z, a[0], a[1], b[0], b[1]);
    if (r.d2 < best.d2) {
      const d = dirOf(a, b);
      best = { d2: r.d2, s: cum[i - 1] + r.t * (cum[i] - cum[i - 1]), x: a[0] + (b[0] - a[0]) * r.t, z: a[1] + (b[1] - a[1]) * r.t, dx: d[0], dz: d[1] };
    }
  }
  return { ...best, d: Math.sqrt(best.d2) };
}

/** Douglas-Peucker simplification of an open polyline. */
export function simplifyDP(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let md = -1, mi = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const { d2 } = segDist2(pts[i][0], pts[i][1], pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1]);
      if (d2 > md) { md = d2; mi = i; }
    }
    if (md > t2) {
      keep[mi] = 1;
      stack.push([i0, mi], [mi, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplify a closed ring (open representation) keeping at least a triangle. */
export function simplifyRing(r, tol) {
  if (r.length < 5) return r;
  // split at the point farthest from r[0] so DP has two anchors
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) {
    const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = simplifyDP(r.slice(0, far + 1), tol);
  const b = simplifyDP([...r.slice(far), r[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : r;
}

/** Insert points so no edge of the (open) ring is longer than step. */
export function densifyRing(r, step) {
  const out = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    out.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(L / step);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

export function densifyPolyline(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(L / step);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

/** Left normal of direction (dx, dz) in the math plane: (-dz, dx). */
export const leftN = (dx, dz) => [-dz, dx];

/**
 * Offset an open polyline by d (positive = left of travel direction in the math plane) with
 * limited miter joins. Returns the offset points (same count as input).
 */
export function offsetPolyline(pts, d, miterLimit = 3) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    let nx, nz;
    if (i === 0) {
      const t = dirOf(pts[0], pts[1]);
      [nx, nz] = leftN(t[0], t[1]);
      out.push([pts[i][0] + nx * d, pts[i][1] + nz * d]);
    } else if (i === n - 1) {
      const t = dirOf(pts[n - 2], pts[n - 1]);
      [nx, nz] = leftN(t[0], t[1]);
      out.push([pts[i][0] + nx * d, pts[i][1] + nz * d]);
    } else {
      const t0 = dirOf(pts[i - 1], pts[i]);
      const t1 = dirOf(pts[i], pts[i + 1]);
      const n0 = leftN(t0[0], t0[1]);
      const n1 = leftN(t1[0], t1[1]);
      let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { mx = n0[0]; mz = n0[1]; } else { mx /= ml; mz /= ml; }
      const cosHalf = mx * n0[0] + mz * n0[1];
      let s = 1 / Math.max(cosHalf, 1 / miterLimit);
      out.push([pts[i][0] + mx * d * s, pts[i][1] + mz * d * s]);
    }
  }
  return out;
}

/** Offset a closed (open-represented) ring; d > 0 = towards the left of the ring direction. */
export function offsetRingChain(pts, d, closed, miterLimit = 2.5) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const p = pts[i];
    let n0 = null, n1 = null;
    if (hasPrev) { const t = dirOf(pts[(i - 1 + n) % n], p); n0 = leftN(t[0], t[1]); }
    if (hasNext) { const t = dirOf(p, pts[(i + 1) % n]); n1 = leftN(t[0], t[1]); }
    if (!n0) n0 = n1;
    if (!n1) n1 = n0;
    let mx = n0[0] + n1[0], mz = n0[1] + n1[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = n0[0]; mz = n0[1]; } else { mx /= ml; mz /= ml; }
    const cosHalf = mx * n0[0] + mz * n0[1];
    const s = 1 / Math.max(cosHalf, 1 / miterLimit);
    out.push([p[0] + mx * d * s, p[1] + mz * d * s]);
  }
  return out;
}

export function discRing(cx, cz, r, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Buffer an open polyline into simple convex pieces (segment quads + join wedges). The union of
 * the returned polygons is the buffered shape with flat end caps.
 */
export function bufferPolylinePieces(pts, hw) {
  const pieces = [];
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const [dx, dz] = dirOf(a, b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-4) continue;
    const [nx, nz] = leftN(dx, dz);
    pieces.push([[
      [a[0] - nx * hw, a[1] - nz * hw],
      [b[0] - nx * hw, b[1] - nz * hw],
      [b[0] + nx * hw, b[1] + nz * hw],
      [a[0] + nx * hw, a[1] + nz * hw],
    ]]);
  }
  for (let i = 1; i < n - 1; i++) {
    const p = pts[i];
    const t0 = dirOf(pts[i - 1], p), t1 = dirOf(p, pts[i + 1]);
    const cross = t0[0] * t1[1] - t0[1] * t1[0];
    const dot = t0[0] * t1[0] + t0[1] * t1[1];
    if (Math.abs(cross) < 1e-4 && dot > 0) continue;
    // Outer side of the turn: if turning left (cross > 0) the outer side is the right.
    const side = cross > 0 ? -1 : 1;
    const n0 = leftN(t0[0], t0[1]), n1 = leftN(t1[0], t1[1]);
    const a = [p[0] + n0[0] * hw * side, p[1] + n0[1] * hw * side];
    const b = [p[0] + n1[0] * hw * side, p[1] + n1[1] * hw * side];
    // round-ish join: 3 intermediate points on the arc
    const ring = [[p[0], p[1]], a];
    const a0 = Math.atan2(a[1] - p[1], a[0] - p[0]);
    let a1 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    let da = a1 - a0;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(Math.abs(da) / (Math.PI / 8)));
    for (let k = 1; k < steps; k++) {
      const ang = a0 + (da * k) / steps;
      ring.push([p[0] + Math.cos(ang) * hw, p[1] + Math.sin(ang) * hw]);
    }
    ring.push(b);
    if (Math.abs(ringArea(ring)) > 1e-6) pieces.push([ring]);
  }
  return pieces;
}

/** Sutherland-Hodgman clip of a ring against an axis-aligned rect {minX,minZ,maxX,maxZ}. */
export function clipRingRect(ring, rc) {
  let out = ring;
  const edges = [
    (p) => p[0] >= rc.minX, (p) => p[0] <= rc.maxX, (p) => p[1] >= rc.minZ, (p) => p[1] <= rc.maxZ,
  ];
  const inter = [
    (a, b) => { const t = (rc.minX - a[0]) / (b[0] - a[0]); return [rc.minX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (rc.maxX - a[0]) / (b[0] - a[0]); return [rc.maxX, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (rc.minZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rc.minZ]; },
    (a, b) => { const t = (rc.maxZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), rc.maxZ]; },
  ];
  for (let e = 0; e < 4; e++) {
    const inp = out;
    out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prev = inp[(i + inp.length - 1) % inp.length];
      const ci = edges[e](cur), pi = edges[e](prev);
      if (ci) {
        if (!pi) out.push(inter[e](prev, cur));
        out.push(cur);
      } else if (pi) out.push(inter[e](prev, cur));
    }
  }
  return out;
}

export const rectRing = (rc) => [[rc.minX, rc.minZ], [rc.maxX, rc.minZ], [rc.maxX, rc.maxZ], [rc.minX, rc.maxZ]];
export const rectPoly = (rc) => [rectRing(rc)];
export const expandRect = (rc, m) => ({ minX: rc.minX - m, minZ: rc.minZ - m, maxX: rc.maxX + m, maxZ: rc.maxZ + m });
export const inRect = (x, z, rc) => x >= rc.minX && x <= rc.maxX && z >= rc.minZ && z <= rc.maxZ;
export const rectBBox = (rc) => [rc.minX, rc.minZ, rc.maxX, rc.maxZ];

/** Intersection of segments p1p2 and p3p4: returns t on p1p2 or null. */
export function segIntersectT(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1z = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2z = p4[1] - p3[1];
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((p3[0] - p1[0]) * d2z - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1z - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const round = (v, d = 2) => { const m = 10 ** d; return Math.round(v * m) / m; };
