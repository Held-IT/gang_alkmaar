// Small numeric helpers for the procedural car bodies: clamped smooth interpolation of 1D
// profiles (monotone cubic, no overshoot) and Catmull-Rom evaluation of 2D control polylines.

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Monotone cubic (Fritsch-Carlson) interpolation through points sorted by x.
 * Outside the range the end values are held (clamped).
 */
export class Curve1D {
  private xs: Float64Array;
  private ys: Float64Array;
  private ms: Float64Array;

  constructor(points: ReadonlyArray<readonly [number, number]>) {
    const pts = [...points].sort((a, b) => a[0] - b[0]);
    const n = pts.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = pts[i][0];
      this.ys[i] = pts[i][1];
    }
    if (n < 2) return;
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = this.xs[i + 1] - this.xs[i];
      d[i] = dx > 1e-9 ? (this.ys[i + 1] - this.ys[i]) / dx : 0;
    }
    this.ms[0] = d[0];
    this.ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) this.ms[i] = 0;
      else {
        // harmonic mean keeps the curve monotone between monotone data points
        this.ms[i] = (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
      }
    }
  }

  eval(x: number): number {
    const xs = this.xs;
    const n = xs.length;
    if (n === 0) return 0;
    if (n === 1 || x <= xs[0]) return this.ys[0];
    if (x >= xs[n - 1]) return this.ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * this.ys[lo] +
      (t3 - 2 * t2 + t) * h * this.ms[lo] +
      (-2 * t3 + 3 * t2) * this.ys[hi] +
      (t3 - t2) * h * this.ms[hi]
    );
  }

  get minX(): number {
    return this.xs[0];
  }
  get maxX(): number {
    return this.xs[this.xs.length - 1];
  }
}

/**
 * Uniform Catmull-Rom through 2D control points [a, b]; t in [0, n-1] (control index space).
 * End tangents use mirrored phantom points so the curve starts in the direction of the first segment.
 */
export function catmullRom2(pts: ReadonlyArray<readonly [number, number]>, t: number, out: [number, number]): [number, number] {
  const n = pts.length;
  const tc = clamp(t, 0, n - 1);
  let i = Math.floor(tc);
  if (i >= n - 1) i = n - 2;
  const u = tc - i;
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p0 = i > 0 ? pts[i - 1] : ([2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] as const);
  const p3 = i + 2 < n ? pts[i + 2] : ([2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] as const);
  const u2 = u * u;
  const u3 = u2 * u;
  for (let k = 0; k < 2; k++) {
    out[k] =
      0.5 *
      (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
  }
  return out;
}

/** Signed superellipse helper: sign(c) * |c|^e */
export function spow(c: number, e: number): number {
  return Math.sign(c) * Math.pow(Math.abs(c), e);
}

/** Deterministic PRNG (mulberry32) for repeatable procedural detail. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Simple string hash (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
