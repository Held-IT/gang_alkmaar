// Polyline paths used by every traffic agent: car lanes, junction connectors, cycle tracks and
// walking lines. A Path stores its points in travel order with cumulative arc lengths, a lazily
// sampled ground-height profile and a per-vertex "comfortable curve speed" for cars.

export type HeightFn = (x: number, z: number) => number;

export const PATH_LANE = 0;
export const PATH_CONN = 1;

/** Output of Path.sample (reused by callers; never allocated per frame). */
export interface PathSample {
  x: number;
  z: number;
  /** unit tangent (travel direction) */
  tx: number;
  tz: number;
  /** segment index (pass back as `hint` for O(1) sequential lookups) */
  i: number;
}

export function makeSample(): PathSample {
  return { x: 0, z: 0, tx: 0, tz: 1, i: 0 };
}

/** Anything that occupies a path (cars), ordered front-first in Path.occ. */
export interface PathOccupant {
  s: number;
  v: number;
  halfLen: number;
}

/** Lateral acceleration used to derive curve speeds (m/s^2). */
const A_LAT = 2.6;
/** Height profile sample spacing (m). */
const H_STEP = 2;

let nextPathId = 1;

export class Path {
  readonly id = nextPathId++;
  readonly xs: Float32Array;
  readonly zs: Float32Array;
  readonly cum: Float32Array;
  readonly n: number;
  readonly len: number;
  /** PATH_LANE or PATH_CONN */
  kind = PATH_LANE;
  /** road graph edge (lanes) */
  edge = -1;
  /** 0 = a->b, 1 = b->a (lanes) */
  dir = 0;
  /** lane index within the direction (0 = leftmost) */
  lane = 0;
  startNode = -1;
  endNode = -1;
  /** connectors: junction cluster id, -1 for a plain join (degree-2 node / dead-end turn) */
  cluster = -1;
  /** lanes: both ends belong to the same junction cluster (part of the junction box) */
  internal = false;
  /** speed limit (m/s) */
  speed = 13.9;
  /** road class rank (priority) of the edge */
  rank = 0;
  /** connectors: incoming / outgoing lane */
  inPath: Path | null = null;
  outPath: Path | null = null;
  /** connectors: -1 left turn, 0 straight, 1 right turn, 2 U-turn */
  turn = 0;
  /** per-vertex comfortable speed (m/s) for cars */
  vmax: Float32Array;
  /** minimum of vmax */
  vmin = 99;
  /** car occupancy, front (largest s) first */
  readonly occ: PathOccupant[] = [];
  private hs: Float32Array | null = null;
  private readonly heightFn: HeightFn | null;

  constructor(xs: Float32Array, zs: Float32Array, heightFn: HeightFn | null) {
    this.xs = xs;
    this.zs = zs;
    this.n = xs.length;
    this.heightFn = heightFn;
    const cum = new Float32Array(this.n);
    for (let i = 1; i < this.n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    this.cum = cum;
    this.len = Math.max(cum[this.n - 1], 1e-3);
    this.vmax = new Float32Array(this.n).fill(99);
  }

  /** Position + tangent at arc length s (extrapolates linearly outside [0, len]). */
  sample(s: number, out: PathSample, hint = 0): PathSample {
    const n = this.n;
    const cum = this.cum;
    let i = hint < 0 ? 0 : hint > n - 2 ? n - 2 : hint;
    if (s <= 0) i = 0;
    else if (s >= this.len) i = n - 2;
    else {
      while (i < n - 2 && cum[i + 1] < s) i++;
      while (i > 0 && cum[i] > s) i--;
    }
    const x0 = this.xs[i];
    const z0 = this.zs[i];
    const dx = this.xs[i + 1] - x0;
    const dz = this.zs[i + 1] - z0;
    const sl = cum[i + 1] - cum[i];
    const t = sl > 1e-6 ? (s - cum[i]) / sl : 0;
    out.x = x0 + dx * t;
    out.z = z0 + dz * t;
    if (sl > 1e-6) {
      out.tx = dx / sl;
      out.tz = dz / sl;
    }
    out.i = i;
    return out;
  }

  /** Ground height at arc length s (lazily sampled profile, linear interpolation). */
  heightAt(s: number): number {
    if (!this.heightFn) return 0;
    if (!this.hs) {
      const cnt = Math.max(2, Math.ceil(this.len / H_STEP) + 1);
      const hs = new Float32Array(cnt);
      const tmp = makeSample();
      for (let k = 0; k < cnt; k++) {
        this.sample((k / (cnt - 1)) * this.len, tmp, tmp.i);
        const h = this.heightFn(tmp.x, tmp.z);
        hs[k] = Number.isFinite(h) && h > -1 && h < 3 ? h : 0;
      }
      this.hs = hs;
    }
    const hs = this.hs;
    const f = (Math.min(Math.max(s, 0), this.len) / this.len) * (hs.length - 1);
    const k = Math.min(Math.floor(f), hs.length - 2);
    const t = f - k;
    return hs[k] * (1 - t) + hs[k + 1] * t;
  }

  /** Computes vmax from the polyline curvature (window of +-win metres). */
  computeCurveSpeeds(win = 6, aLat = A_LAT): void {
    const n = this.n;
    const tmp = makeSample();
    let vmin = 99;
    for (let i = 0; i < n; i++) {
      const s = this.cum[i];
      const sb = Math.max(0, s - win);
      const sf = Math.min(this.len, s + win);
      if (s - sb < 0.5 || sf - s < 0.5) continue;
      this.sample(sb, tmp, i);
      const bx = tmp.x;
      const bz = tmp.z;
      this.sample(sf, tmp, i);
      const fx = tmp.x;
      const fz = tmp.z;
      const px = this.xs[i];
      const pz = this.zs[i];
      const ax = px - bx;
      const az = pz - bz;
      const cx = fx - px;
      const cz = fz - pz;
      const la = Math.hypot(ax, az);
      const lc = Math.hypot(cx, cz);
      if (la < 1e-3 || lc < 1e-3) continue;
      const cosT = Math.min(1, Math.max(-1, (ax * cx + az * cz) / (la * lc)));
      const theta = Math.acos(cosT);
      if (theta < 0.02) continue;
      const r = (0.5 * (la + lc)) / (2 * Math.sin(theta * 0.5));
      const v = Math.sqrt(aLat * Math.max(r, 2));
      this.vmax[i] = v;
      if (v < vmin) vmin = v;
    }
    this.vmin = vmin;
  }
}

/**
 * Offsets a polyline (travel order) `off` metres to the RIGHT of the travel direction and trims
 * `trimA` metres at the start and `trimB` at the end. Right of direction (tx, tz) is (-tz, tx).
 */
export function offsetPolyline(
  pts: ArrayLike<number>[],
  reverse: boolean,
  off: number,
  trimA: number,
  trimB: number,
): { xs: Float32Array; zs: Float32Array } {
  // de-duplicated points in travel order
  const px: number[] = [];
  const pz: number[] = [];
  const m = pts.length;
  for (let k = 0; k < m; k++) {
    const p = pts[reverse ? m - 1 - k : k];
    const L = px.length;
    if (L > 0 && Math.hypot(p[0] - px[L - 1], p[1] - pz[L - 1]) < 0.05) continue;
    px.push(p[0]);
    pz.push(p[1]);
  }
  if (px.length < 2) {
    const p = pts[0];
    const q = pts[m - 1];
    px.length = 0;
    pz.length = 0;
    px.push(p[0], q[0] + 0.01);
    pz.push(p[1], q[1] + 0.01);
  }
  const n = px.length;
  const ox = new Array<number>(n);
  const oz = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    // right normals of the adjacent segments
    let nx = 0;
    let nz = 0;
    let n1x = 0;
    let n1z = 0;
    let cnt = 0;
    if (i > 0) {
      const dx = px[i] - px[i - 1];
      const dz = pz[i] - pz[i - 1];
      const l = Math.hypot(dx, dz) || 1;
      n1x = -dz / l;
      n1z = dx / l;
      nx += n1x;
      nz += n1z;
      cnt++;
    }
    if (i < n - 1) {
      const dx = px[i + 1] - px[i];
      const dz = pz[i + 1] - pz[i];
      const l = Math.hypot(dx, dz) || 1;
      if (cnt === 0) {
        n1x = -dz / l;
        n1z = dx / l;
      }
      nx += -dz / l;
      nz += dx / l;
    }
    const l = Math.hypot(nx, nz);
    if (l < 1e-4) {
      nx = n1x;
      nz = n1z;
    } else {
      nx /= l;
      nz /= l;
    }
    // miter scale (limited so sharp corners do not explode)
    const cosHalf = Math.max(0.6, nx * n1x + nz * n1z);
    ox[i] = px[i] + (nx * off) / cosHalf;
    oz[i] = pz[i] + (nz * off) / cosHalf;
  }
  // arc lengths of the offset line
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(ox[i] - ox[i - 1], oz[i] - oz[i - 1]);
  const total = cum[n - 1];
  let a = Math.max(0, trimA);
  let b = Math.max(0, trimB);
  const maxTrim = total * 0.9;
  if (a + b > maxTrim) {
    const k = maxTrim / Math.max(a + b, 1e-6);
    a *= k;
    b *= k;
  }
  const s0 = a;
  const s1 = total - b;
  const outX: number[] = [];
  const outZ: number[] = [];
  const lerpAt = (s: number): void => {
    let i = 0;
    while (i < n - 2 && cum[i + 1] < s) i++;
    const sl = cum[i + 1] - cum[i];
    const t = sl > 1e-6 ? (s - cum[i]) / sl : 0;
    outX.push(ox[i] + (ox[i + 1] - ox[i]) * t);
    outZ.push(oz[i] + (oz[i + 1] - oz[i]) * t);
  };
  lerpAt(s0);
  for (let i = 0; i < n; i++) {
    if (cum[i] > s0 + 0.05 && cum[i] < s1 - 0.05) {
      outX.push(ox[i]);
      outZ.push(oz[i]);
    }
  }
  lerpAt(s1);
  return { xs: Float32Array.from(outX), zs: Float32Array.from(outZ) };
}

/**
 * Cubic Bezier connector from (p0, tangent t0) to (p3, tangent t3), sampled to a polyline.
 * Handle length adapts to the turn so 90 degree turns approximate a circular arc.
 */
export function bezierConnector(
  p0x: number, p0z: number, t0x: number, t0z: number,
  p3x: number, p3z: number, t3x: number, t3z: number,
  minHandle = 0,
): { xs: Float32Array; zs: Float32Array } {
  const d = Math.hypot(p3x - p0x, p3z - p0z);
  const turn = (1 - (t0x * t3x + t0z * t3z)) * 0.5; // 0 straight .. 1 U-turn
  const h = Math.max(minHandle, d * (0.36 + 0.2 * turn));
  const p1x = p0x + t0x * h;
  const p1z = p0z + t0z * h;
  const p2x = p3x - t3x * h;
  const p2z = p3z - t3z * h;
  const cnt = Math.min(24, Math.max(3, Math.ceil((d + h * turn * 2) / 1.2)));
  const xs = new Float32Array(cnt + 1);
  const zs = new Float32Array(cnt + 1);
  for (let k = 0; k <= cnt; k++) {
    const t = k / cnt;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    xs[k] = b0 * p0x + b1 * p1x + b2 * p2x + b3 * p3x;
    zs[k] = b0 * p0z + b1 * p1z + b2 * p2z + b3 * p3z;
  }
  return { xs, zs };
}

/** Straight two-point segment (walking connectors). */
export function straightConnector(p0x: number, p0z: number, p3x: number, p3z: number): { xs: Float32Array; zs: Float32Array } {
  const xs = new Float32Array([p0x, p3x]);
  const zs = new Float32Array([p0z, p3z === p0z && p3x === p0x ? p0z + 0.01 : p3z]);
  return { xs, zs };
}
