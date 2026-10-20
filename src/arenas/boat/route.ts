// Canal tour route for the rondvaartboot arena: a smooth closed centreline through the binnenstad
// canals, derived from hand-picked waypoints that are centred between the real canal banks
// (map2d water polygons) and smoothed, plus the bridges (road graph bridge edges) that cross it.
//
// Pure data code (no three.js) so it can be unit-tested in node.
// Coordinates: world x = east, z = south (metres); heading 0 = +z, forward = (sin h, cos h).

export type XZ = [number, number];

/** Clockwise loop from the junction of the Voordam / Kleine Glop canals north along the Waagplein
 * (De Waag and the Kaasmarkt on the left) under the Schapenbrug, Dijkbrug, Kaarsemakersbrug and
 * Bokkebrug onto the wide Noordervaart, east to the Kooltuinbrug, south through the narrow Kooltuin
 * canal under the Torenburgbrug and Dambrug, and west along the Wijde / Kleine Glop under the
 * Kuipersbrug. Rough positions; centred on the real banks at runtime. */
export const ROUTE_WAYPOINTS: XZ[] = [
  [60.1, 31.9], [49.9, 27.2], [41.5, 21.5], [37.2, 12.5], [38.2, 2], [41, -9.7], [44.5, -24.3], [47.8, -37.7],
  [49.5, -50.7], [53.4, -65.1], [55.8, -82.3], [60, -100], [64.9, -114.7], [70.6, -129.8], [79, -147.5],
  [85.2, -161.9], [90.7, -171.7], [97, -183], [108.5, -189], [122.7, -182.4], [147.5, -170.9], [169.3, -160.8],
  [184, -152], [191.5, -141], [192, -127.6], [186.7, -113.8], [179.5, -98.2], [171.8, -82.8], [163.4, -63.3],
  [153.9, -39.6], [143.5, -13.8], [132.9, 9.6], [125.3, 28.2], [120.5, 41], [113, 49.5], [104, 50], [92.2, 46.5],
  [78.4, 40.2], [68.2, 35.7],
];

/** Open path (the boat sails it forth and back): from the Verdronkenoord north of the Waagplein south
 * past the Kaasmarkt and De Waag (Schapenbrug), through the junction by the Mient and east along the
 * Luttik Oudorp almost to the Singel. Rough canal centres from the water polygons (5 m raster),
 * centred on the real banks at runtime. The narrower canals further north (Dijkbrug) and the
 * Kooltuin are too narrow for an 18 m tour boat in the OSM data, so they are left out. */
export const PATH_WAYPOINTS: XZ[] = [
  [55.8, -84], [53.4, -65.1], [49.5, -50.7], [47.8, -37.7], [44.5, -24.3], [41, -9.7], [38.2, 2], [37.6, 12.5],
  [41.5, 21.5], [49.9, 27.2], [60.1, 31.9], [68.2, 35.7], [78.4, 40.2], [92.2, 46.5], [110, 51], [137, 60],
  [160, 70], [187, 80], [212, 90], [240, 100], [257, 110], [280, 120], [296, 130], [312, 140], [330, 150],
  [346, 159],
];

export interface RouteBridge {
  /** arc length of the crossing along the route (m) */
  s: number;
  /** half extent along the route (m, deck width seen by the boat) */
  halfLen: number;
  /** crossing point (world) */
  x: number;
  z: number;
  /** direction of the bridge road (radians, heading convention) */
  roadHeading: number;
  name: string;
}

export interface Route {
  /** samples every `step` metres (closed loop: the last sample connects to the first) */
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** heading at each sample (radians, 0 = +z) */
  readonly h: Float64Array;
  /** canal half widths to the left / right bank at each sample (m, Infinity if unknown) */
  readonly left: Float64Array;
  readonly right: Float64Array;
  readonly step: number;
  readonly length: number;
  readonly bridges: RouteBridge[];
  /** open path (sample clamps s to [0, length]) or closed loop (wraps) */
  readonly closed: boolean;
  /** position + heading at arc length s (wraps around / clamps for open paths) */
  sample(s: number, out: { x: number; z: number; h: number }): { x: number; z: number; h: number };
}

export interface BridgeEdgeLike {
  pts: XZ[];
  width: number;
  bridge: boolean;
  name?: string;
}

interface Seg { ax: number; az: number; bx: number; bz: number }

const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Ray (ox,oz)+t(dx,dz) against segment; returns t or Infinity. */
function raySeg(ox: number, oz: number, dx: number, dz: number, s: Seg): number {
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const qx = s.ax - ox, qz = s.az - oz;
  const t = (qx * ez - qz * ex) / den;
  const u = (qx * dz - qz * dx) / den;
  return t > 0 && u >= 0 && u <= 1 ? t : Infinity;
}

function segSegT(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): [number, number] | null {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

/** Densify a closed polyline to ~`step` spacing. */
function densify(pts: XZ[], step: number, closed = true): XZ[] {
  const out: XZ[] = [];
  const segs = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  if (!closed) out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

/** Closed moving-average smoothing. */
function smooth(p: XZ[], radius: number, iterations: number, closed = true): XZ[] {
  let cur = p;
  const n = p.length;
  for (let it = 0; it < iterations; it++) {
    const next: XZ[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) {
        next[i] = [cur[i][0], cur[i][1]];
        continue;
      }
      // open paths: shrink the window near the ends (keeps the end points)
      const r = closed ? radius : Math.min(radius, i, n - 1 - i);
      let sx = 0, sz = 0;
      for (let k = -r; k <= r; k++) {
        const q = cur[(i + k + n) % n];
        sx += q[0];
        sz += q[1];
      }
      next[i] = [sx / (2 * r + 1), sz / (2 * r + 1)];
    }
    cur = next;
  }
  return cur;
}

/** Resample a closed polyline at exactly `step` spacing (arc length). */
function resample(p: XZ[], step: number, closed = true): XZ[] {
  const n = p.length;
  const segs = closed ? n : n - 1;
  const cum: number[] = [0];
  for (let i = 0; i < segs; i++) {
    const a = p[i], b = p[(i + 1) % n];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[segs];
  const m = Math.max(8, Math.round(total / step));
  const ds = total / m;
  const out: XZ[] = [];
  let j = 0;
  for (let k = 0; k < (closed ? m : m + 1); k++) {
    const s = k * ds;
    while (j < segs - 1 && cum[j + 1] < s) j++;
    const a = p[j], b = p[(j + 1) % n];
    const seg = cum[j + 1] - cum[j];
    const t = seg > 1e-9 ? (s - cum[j]) / seg : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function bankSegments(water: XZ[][][] | null, minX: number, minZ: number, maxX: number, maxZ: number): Seg[] {
  const segs: Seg[] = [];
  if (!water) return segs;
  for (const poly of water) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.max(a[0], b[0]) < minX || Math.min(a[0], b[0]) > maxX || Math.max(a[1], b[1]) < minZ || Math.min(a[1], b[1]) > maxZ) continue;
      if (a[0] === b[0] && a[1] === b[1]) continue;
      segs.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1] });
    }
  }
  return segs;
}

/** Simple uniform grid over segments for ray queries. */
class SegGrid {
  private cells = new Map<number, number[]>();
  readonly segs: Seg[];
  readonly cell: number;
  constructor(segs: Seg[], cell: number) {
    this.segs = segs;
    this.cell = cell;
    segs.forEach((s, i) => {
      const x0 = Math.floor(Math.min(s.ax, s.bx) / cell), x1 = Math.floor(Math.max(s.ax, s.bx) / cell);
      const z0 = Math.floor(Math.min(s.az, s.bz) / cell), z1 = Math.floor(Math.max(s.az, s.bz) / cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = (x + 4096) * 8192 + (z + 4096);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(i);
      }
    });
  }
  /** nearest hit distance of a ray up to maxDist (marches the cells along the ray) */
  ray(ox: number, oz: number, dx: number, dz: number, maxDist: number): number {
    let best = Infinity;
    const seen = new Set<number>();
    const stepLen = this.cell * 0.5;
    for (let d = 0; d <= maxDist + stepLen; d += stepLen) {
      const cx = Math.floor((ox + dx * d) / this.cell), cz = Math.floor((oz + dz * d) / this.cell);
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
        const l = this.cells.get((ix + 4096) * 8192 + (iz + 4096));
        if (!l) continue;
        for (const i of l) {
          if (seen.has(i)) continue;
          seen.add(i);
          const t = raySeg(ox, oz, dx, dz, this.segs[i]);
          if (t < best) best = t;
        }
      }
      if (best < d - this.cell) break;
    }
    return best <= maxDist ? best : Infinity;
  }
}

export interface RouteOptions {
  /** sample spacing of the final route (m), default 1 */
  step?: number;
  /** ignore canal-centring where the water is wider than this (Singel), default 34 m */
  maxCentreWidth?: number;
  /** max shift of a waypoint sample towards the centre (m), default 7 */
  maxShift?: number;
  /** final moving-average smoothing (samples of 2 m): radius / iterations, default 2 / 4 */
  smoothRadius?: number;
  smoothIterations?: number;
  /** open path instead of a closed loop (default false) */
  open?: boolean;
}

export function buildRoute(
  waypoints: XZ[],
  water: XZ[][][] | null,
  roads: BridgeEdgeLike[] | null,
  opts: RouteOptions = {},
): Route {
  const step = opts.step ?? 1;
  const maxW = opts.maxCentreWidth ?? 34;
  const maxShift = opts.maxShift ?? 7;
  const closed = !opts.open;
  const at = (n: number, i: number) => (closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of waypoints) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const grid = new SegGrid(bankSegments(water, minX - 80, minZ - 80, maxX + 80, maxZ + 80), 8);
  const hasBanks = grid.segs.length > 0;

  // 1) densify + centre between the banks (two passes, smoothing in between)
  let p = densify(waypoints, 3, closed);
  const banks = (pts: XZ[], i: number): { l: number; r: number; nx: number; nz: number } => {
    const n = pts.length;
    const a = pts[at(n, i - 2)], b = pts[at(n, i + 2)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // left normal of heading (sin h, cos h) is (cos h, -sin h) = (tz, -tx)
    const nx = tz, nz = -tx;
    const [x, z] = pts[i];
    const l = hasBanks ? grid.ray(x, z, nx, nz, 60) : Infinity;
    const r = hasBanks ? grid.ray(x, z, -nx, -nz, 60) : Infinity;
    return { l, r, nx, nz };
  };
  for (let pass = 0; pass < 3; pass++) {
    const q: XZ[] = p.map((v) => [v[0], v[1]] as XZ);
    for (let i = 0; i < p.length; i++) {
      const { l, r, nx, nz } = banks(p, i);
      if (!Number.isFinite(l) || !Number.isFinite(r) || l + r > maxW) continue;
      const shift = Math.max(-maxShift, Math.min(maxShift, (l - r) / 2));
      q[i][0] += nx * shift * 0.8;
      q[i][1] += nz * shift * 0.8;
    }
    p = smooth(q, 2, 2, closed);
  }
  // 2) strong smoothing for gentle turns, resample at `step`
  p = smooth(resample(p, 2, closed), opts.smoothRadius ?? 2, opts.smoothIterations ?? 4, closed);
  p = resample(p, step, closed);
  const n = p.length;
  const x = new Float64Array(n), z = new Float64Array(n), h = new Float64Array(n);
  const left = new Float64Array(n), right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = p[i][0];
    z[i] = p[i][1];
  }
  for (let i = 0; i < n; i++) {
    const a = p[at(n, i - 1)], b = p[at(n, i + 1)];
    h[i] = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const bk = banks(p, i);
    left[i] = bk.l;
    right[i] = bk.r;
  }
  const length = closed ? n * step : (n - 1) * step;

  // 3) bridges crossing the route
  const raw: RouteBridge[] = [];
  if (roads) {
    for (const e of roads) {
      if (!e.bridge || e.pts.length < 2) continue;
      for (let k = 0; k + 1 < e.pts.length; k++) {
        let [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
        // extend the deck line by 2.5 m at both open ends (OSM bridge ways often stop at the quay)
        const el = Math.hypot(bx - ax, bz - az) || 1, ex = ((bx - ax) / el) * 2.5, ez = ((bz - az) / el) * 2.5;
        if (k === 0) { ax -= ex; az -= ez; }
        if (k + 2 === e.pts.length) { bx += ex; bz += ez; }
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const j = (i + 1) % n;
          const hit = segSegT(x[i], z[i], x[j], z[j], ax, az, bx, bz);
          if (!hit) continue;
          const s = (i + hit[0]) * step;
          const roadH = Math.atan2(bx - ax, bz - az);
          const sinA = Math.abs(Math.sin(wrapAngle(roadH - h[i])));
          const halfLen = Math.min(9, (Math.max(3, e.width) / 2 + 0.8) / Math.max(0.35, sinA));
          raw.push({ s, halfLen, x: x[i] + (x[j] - x[i]) * hit[0], z: z[i] + (z[j] - z[i]) * hit[0], roadHeading: roadH, name: e.name ?? 'brug' });
        }
      }
    }
  }
  raw.sort((a, b) => a.s - b.s);
  const bridges: RouteBridge[] = [];
  for (const b of raw) {
    const last = bridges[bridges.length - 1];
    if (last && b.s - b.halfLen < last.s + last.halfLen + 1.5) {
      // merge (parallel carriageways / sidewalks of one bridge)
      const lo = Math.min(last.s - last.halfLen, b.s - b.halfLen);
      const hi = Math.max(last.s + last.halfLen, b.s + b.halfLen);
      last.s = (lo + hi) / 2;
      last.halfLen = (hi - lo) / 2;
      if (last.name === 'brug' && b.name !== 'brug') last.name = b.name;
      continue;
    }
    bridges.push({ ...b });
  }

  const sample = (s: number, out: { x: number; z: number; h: number }) => {
    const u = closed ? (((s % length) + length) % length) / step : Math.max(0, Math.min(length, s)) / step;
    const i = Math.min(Math.floor(u), closed ? n - 1 : n - 2), t = u - i;
    const j = (i + 1) % n;
    out.x = x[i] + (x[j] - x[i]) * t;
    out.z = z[i] + (z[j] - z[i]) * t;
    out.h = h[i] + wrapAngle(h[j] - h[i]) * t;
    return out;
  };

  return { x, z, h, left, right, step, length, bridges, closed, sample };
}

/** Max turn rate (rad/m) of the route, for diagnostics. */
export function maxCurvature(r: Route): number {
  let m = 0;
  const n = r.h.length;
  for (let i = 0; i < (r.closed ? n : n - 1); i++) m = Math.max(m, Math.abs(wrapAngle(r.h[(i + 1) % n] - r.h[i])) / r.step);
  return m;
}
