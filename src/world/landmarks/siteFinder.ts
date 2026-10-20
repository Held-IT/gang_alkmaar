// Finds an open rectangle near a landmark (e.g. the Kaasmarkt next to De Waag): rasterises
// building footprints, water polygons and car roads around the landmark into an occupancy grid,
// then scores candidate rectangles (free, close to the landmark, aligned with its footprint).
import type { Footprints, Map2D, RoadGraph } from '../../contracts';

export interface Site {
  x: number;
  z: number;
  /** rotation about Y (radians); the rectangle's local +x is the "length" axis */
  rot: number;
  length: number;
  width: number;
  /** true when the rectangle was verified against data, false for the fallback */
  verified: boolean;
}

type Ring = [number, number][];

function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Principal direction (radians) of a ring: direction of its longest edge. */
export function ringAngle(ring: Ring): number {
  let best = 0, ang = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const dx = ring[i + 1][0] - ring[i][0], dz = ring[i + 1][1] - ring[i][1];
    const l = Math.hypot(dx, dz);
    if (l > best) { best = l; ang = Math.atan2(dz, dx); }
  }
  return ang;
}

export interface SiteQuery {
  cx: number;
  cz: number;
  /** footprint ring of the landmark itself (also an obstacle) */
  ownRing?: Ring | null;
  footprints?: Footprints | null;
  map2d?: Map2D | null;
  roads?: RoadGraph | null;
  length: number;
  width: number;
  /** clearance around the rectangle (m) */
  margin: number;
  minDist: number;
  maxDist: number;
}

export function findOpenSite(q: SiteQuery): Site {
  const R = q.maxDist + Math.max(q.length, q.width) + 10;
  const res = 0.5;
  const n = Math.ceil((2 * R) / res);
  const x0 = q.cx - R, z0 = q.cz - R;
  const occ = new Uint8Array(n * n);
  const markRing = (ring: Ring) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    if (maxX < x0 || minX > x0 + 2 * R || maxZ < z0 || minZ > z0 + 2 * R) return;
    const i0 = Math.max(0, Math.floor((minX - x0) / res)), i1 = Math.min(n - 1, Math.ceil((maxX - x0) / res));
    const j0 = Math.max(0, Math.floor((minZ - z0) / res)), j1 = Math.min(n - 1, Math.ceil((maxZ - z0) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (pointInRing(x0 + (i + 0.5) * res, z0 + (j + 0.5) * res, ring)) occ[j * n + i] = 1;
    }
  };
  let haveData = false;
  for (const ring of q.footprints?.rings ?? []) { markRing(ring); haveData = true; }
  if (q.ownRing) markRing(q.ownRing);
  for (const poly of q.map2d?.water ?? []) if (poly[0]) { markRing(poly[0]); haveData = true; }
  for (const e of q.roads?.edges ?? []) {
    if (!e.car || e.type === 'pedestrian' || e.type === 'footway') continue;
    const hw = (e.width || 6) / 2 + 0.5;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const steps = Math.ceil(len / (res * 0.8));
      for (let s = 0; s <= steps; s++) {
        const px = ax + ((bx - ax) * s) / steps, pz = az + ((bz - az) * s) / steps;
        const r = Math.ceil(hw / res);
        const ci = Math.floor((px - x0) / res), cj = Math.floor((pz - z0) / res);
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          if (di * di + dj * dj <= r * r) occ[j * n + i] = 1;
        }
      }
    }
    haveData = true;
  }
  const free = (x: number, z: number) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((z - z0) / res);
    if (i < 0 || j < 0 || i >= n || j >= n) return false;
    return occ[j * n + i] === 0;
  };
  const baseAng = q.ownRing && q.ownRing.length > 2 ? ringAngle(q.ownRing) : 0;
  const L = q.length + 2 * q.margin, W = q.width + 2 * q.margin;
  let best: Site | null = null;
  let bestScore = Infinity;
  if (haveData || q.ownRing) {
    for (const rot of [baseAng, baseAng + Math.PI / 2]) {
      const ux = Math.cos(rot), uz = Math.sin(rot); // length axis
      const vx = -uz, vz = ux; // width axis
      for (let gz = -q.maxDist; gz <= q.maxDist; gz += 1.5) {
        for (let gx = -q.maxDist; gx <= q.maxDist; gx += 1.5) {
          const d = Math.hypot(gx, gz);
          if (d < q.minDist || d > q.maxDist) continue;
          const cx = q.cx + gx, cz = q.cz + gz;
          let ok = true;
          for (let a = -L / 2; a <= L / 2 + 1e-6 && ok; a += 1) {
            for (let b = -W / 2; b <= W / 2 + 1e-6; b += 1) {
              if (!free(cx + ux * a + vx * b, cz + uz * a + vz * b)) { ok = false; break; }
            }
          }
          if (!ok) continue;
          const score = d + (rot === baseAng ? 0 : 1.5);
          if (score < bestScore) {
            bestScore = score;
            best = { x: cx, z: cz, rot, length: q.length, width: q.width, verified: true };
          }
        }
      }
    }
  }
  if (best) return best;
  // fallback: next to the landmark along its short axis
  const off = q.minDist + q.width / 2 + 4;
  return { x: q.cx - Math.sin(baseAng) * off, z: q.cz + Math.cos(baseAng) * off, rot: baseAng, length: q.length, width: q.width, verified: false };
}
