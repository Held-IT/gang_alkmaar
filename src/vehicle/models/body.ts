// Analytic description of a procedural car body (BodyFrame). Mesh generation (any LOD), texture
// drawing and detail placement all query this one description, so every part lines up exactly.
//
// The body consists of three surfaces that share their seam vertices:
//  * lower body: a "wall" swept around the plan outline (rear centre -> left side -> front centre),
//    parameterised by p (arc length along the plan outline, metres) and t (section control index,
//    0 = bottom edge .. K-1 = shoulder). Columns near the wheels are cut by the wheel arches.
//  * greenhouse: at each station p a section rising from the left shoulder point S over the roof
//    to the centre line: side glass line -> roof edge corner -> crowned roof / windscreen.
//  * deck: hood and trunk lid caps spanning between the left and right shoulder points.
// Everything is built for the LEFT half (+x); the right half is mirrored.
import type { CarSpec } from '../../contracts';
import { Curve1D, catmullRom2, clamp, lerp, smoothstep, spow } from './curves';
import type { BodyDesign, P2 } from './designs';

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Column {
  p: number;
  /** plan outline point and its outward normal (in the xz plane) */
  x: number;
  z: number;
  nx: number;
  nz: number;
  /** blend weights: side / front / rear profile */
  wS: number;
  wF: number;
  wR: number;
  yRef: number;
  yS: number;
  ctrl: [number, number][];
  /** weights of the nose / tail lean fields (z-only offsets, see BodyDesign.noseLean) */
  leanF: number;
  leanR: number;
}

/** Dense greenhouse half-section (left), from the shoulder S to the roof centre C. */
export interface GhSection {
  p: number;
  z: number;
  /** dense polyline */
  xs: Float64Array;
  ys: Float64Array;
  arc: Float64Array;
  /** total arc length S -> C */
  len: number;
  /** arc length S -> R0 (side glass line), R0 -> R1 (roof edge corner) */
  sideLen: number;
  cornerEnd: number;
  /** height of the section above S */
  b: number;
  xS: number;
  yS: number;
}

/** Index of the profile control point used as the body side character line. */
export const CTRL_CHAR = 5;
const SIDE_N = 24;
const CORNER_N = 16;
const ROOF_N = 32;

export class BodyFrame {
  readonly spec: CarSpec;
  readonly d: BodyDesign;
  readonly zF: number;
  readonly zR: number;
  readonly zFA: number;
  readonly zRA: number;
  readonly wheelR: number;
  readonly archR: number;
  /** total plan half perimeter */
  readonly P: number;
  /** p at the start / end of the straight side of the plan outline */
  readonly pSide0: number;
  readonly pSide1: number;
  /** number of profile control points */
  readonly K: number;
  /** p of the stations at the windscreen base and the rear window base (shoulder z = cowlZ / rearBaseZ) */
  readonly pCowl: number;
  readonly pRearBase: number;
  readonly yCowl: number;
  readonly yRearBase: number;

  private planN: number;
  private planX: Float64Array;
  private planZ: Float64Array;
  private planNX: Float64Array;
  private planNZ: Float64Array;
  private shoulder: Curve1D;
  private noseLean: Curve1D;
  private tailLean: Curve1D;
  private inset: Curve1D | null;
  private top!: Curve1D;
  // centre line arc length table (for greenhouse / roof texture coordinates)
  private scZ!: Float64Array;
  private scS!: Float64Array;

  constructor(spec: CarSpec, d: BodyDesign) {
    this.spec = spec;
    this.d = d;
    this.zFA = spec.wheelbase / 2;
    this.zRA = -spec.wheelbase / 2;
    this.zF = this.zFA + d.frontOverhang;
    this.zR = this.zF - spec.length;
    this.wheelR = spec.wheelRadius;
    this.archR = spec.wheelRadius + d.archGap;
    this.K = d.sideProfile.length;
    this.shoulder = new Curve1D(d.shoulder);
    this.noseLean = new Curve1D(d.noseLean);
    this.tailLean = new Curve1D(d.tailLean);
    this.inset = d.shoulderInset ? new Curve1D(d.shoulderInset) : null;

    // ---- plan outline (left half), dense and resampled uniformly by arc length ----
    const raw: number[] = [];
    const hw = d.halfWidth;
    const NC = 2000;
    for (let i = 0; i <= NC; i++) {
      const phi = (1 - i / NC) * (Math.PI / 2);
      raw.push(hw * spow(Math.cos(phi), 2 / d.tailPow), this.zR + d.tailDepth - d.tailDepth * spow(Math.sin(phi), 2 / d.tailPow));
    }
    const zs0 = this.zR + d.tailDepth;
    const zs1 = this.zF - d.noseDepth;
    const NS = 300;
    for (let i = 1; i < NS; i++) raw.push(hw, lerp(zs0, zs1, i / NS));
    for (let i = 0; i <= NC; i++) {
      const phi = (i / NC) * (Math.PI / 2);
      raw.push(hw * spow(Math.cos(phi), 2 / d.nosePow), zs1 + d.noseDepth * spow(Math.sin(phi), 2 / d.nosePow));
    }
    const rn = raw.length / 2;
    const cum = new Float64Array(rn);
    for (let i = 1; i < rn; i++) {
      cum[i] = cum[i - 1] + Math.hypot(raw[2 * i] - raw[2 * i - 2], raw[2 * i + 1] - raw[2 * i - 1]);
    }
    this.P = cum[rn - 1];
    const N = 4096;
    this.planN = N;
    this.planX = new Float64Array(N);
    this.planZ = new Float64Array(N);
    this.planNX = new Float64Array(N);
    this.planNZ = new Float64Array(N);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = (i / (N - 1)) * this.P;
      while (j < rn - 2 && cum[j + 1] < s) j++;
      const seg = cum[j + 1] - cum[j];
      const u = seg > 1e-12 ? clamp((s - cum[j]) / seg, 0, 1) : 0;
      this.planX[i] = lerp(raw[2 * j], raw[2 * j + 2], u);
      this.planZ[i] = lerp(raw[2 * j + 1], raw[2 * j + 3], u);
    }
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 2);
      const b = Math.min(N - 1, i + 2);
      const tx = this.planX[b] - this.planX[a];
      const tz = this.planZ[b] - this.planZ[a];
      const l = Math.hypot(tx, tz) || 1;
      // outward normal of a curve walked rear -> left side -> front: (tz, -tx)
      this.planNX[i] = tz / l;
      this.planNZ[i] = -tx / l;
    }
    this.pSide0 = this.pOfPlanZ(zs0);
    this.pSide1 = this.pOfPlanZ(zs1);

    // ---- greenhouse centre line, with its ends glued to the hood / trunk crown ----
    this.pCowl = this.pOfShoulderZ(d.cowlZ);
    this.pRearBase = this.pOfShoulderZ(d.rearBaseZ);
    const sc = this.shoulderPoint(this.pCowl);
    const sr = this.shoulderPoint(this.pRearBase);
    this.yCowl = sc.y + d.hoodCrown;
    this.yRearBase = sr.y + d.deckCrown;
    const tl: P2[] = d.topLine.filter((q) => q[0] > d.rearBaseZ + 1e-3 && q[0] < d.cowlZ - 1e-3);
    tl.push([d.rearBaseZ, this.yRearBase], [d.cowlZ, this.yCowl]);
    this.top = new Curve1D(tl);

    // ---- centre line arc length table ----
    const nz = 1200;
    this.scZ = new Float64Array(nz);
    this.scS = new Float64Array(nz);
    let prevY = 0;
    for (let i = 0; i < nz; i++) {
      const z = lerp(this.zR, this.zF, i / (nz - 1));
      const y = this.centreY(z);
      this.scZ[i] = z;
      if (i > 0) this.scS[i] = this.scS[i - 1] + Math.hypot(z - this.scZ[i - 1], y - prevY);
      prevY = y;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // plan outline
  planAt(p: number, out: { x: number; z: number; nx: number; nz: number }): void {
    const f = clamp(p / this.P, 0, 1) * (this.planN - 1);
    const i = Math.min(Math.floor(f), this.planN - 2);
    const u = f - i;
    out.x = lerp(this.planX[i], this.planX[i + 1], u);
    out.z = lerp(this.planZ[i], this.planZ[i + 1], u);
    const nx = lerp(this.planNX[i], this.planNX[i + 1], u);
    const nz = lerp(this.planNZ[i], this.planNZ[i + 1], u);
    const l = Math.hypot(nx, nz) || 1;
    out.nx = nx / l;
    out.nz = nz / l;
  }

  /** p of the plan outline point with the given z (left half; z increases monotonically with p). */
  pOfPlanZ(z: number): number {
    const zs = this.planZ;
    let lo = 0;
    let hi = this.planN - 1;
    if (z <= zs[0]) return 0;
    if (z >= zs[hi]) return this.P;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (zs[m] > z) hi = m;
      else lo = m;
    }
    const u = (z - zs[lo]) / Math.max(1e-12, zs[hi] - zs[lo]);
    return ((lo + u) / (this.planN - 1)) * this.P;
  }

  /** p of the plan point with the given x on the front (side 1) or rear (side -1) face. */
  pOfPlanX(x: number, front: boolean): number {
    // x decreases monotonically from the side towards the tip on the corner curves
    let lo = front ? this.pSide1 : 0;
    let hi = front ? this.P : this.pSide0;
    const tmp = { x: 0, z: 0, nx: 0, nz: 0 };
    for (let it = 0; it < 40; it++) {
      const m = 0.5 * (lo + hi);
      this.planAt(m, tmp);
      if (front ? tmp.x > x : tmp.x < x) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  // ------------------------------------------------------------------------------------------------
  // lower body
  column(p: number, out?: Column): Column {
    const d = this.d;
    const c: Column =
      out ??
      ({ p, x: 0, z: 0, nx: 0, nz: 0, wS: 1, wF: 0, wR: 0, yRef: 0, yS: 1, leanF: 0, leanR: 0, ctrl: d.sideProfile.map(() => [0, 0] as [number, number]) } as Column);
    c.p = p;
    this.planAt(p, c);
    const wF = smoothstep(0.2, 0.92, c.nz);
    const wR = smoothstep(0.2, 0.92, -c.nz);
    const wS = 1 - wF - wR;
    c.wF = wF;
    c.wR = wR;
    c.wS = wS;
    c.yRef = d.sillY * wS + d.frontBottomY * wF + d.rearBottomY * wR;
    c.yS = this.shoulder.eval(c.z);
    // z-only lean fields: their ramp is gentle enough (slope * lean < 1) to keep the shoulder line
    // monotonic in z, so the hood / trunk caps never fold
    c.leanF = smoothstep(this.zF - d.noseDepth - 0.12, this.zF - 0.02, c.z);
    c.leanR = smoothstep(this.zR + d.tailDepth + 0.12, this.zR + 0.02, c.z);
    for (let k = 0; k < this.K; k++) {
      c.ctrl[k][0] = d.sideProfile[k][0] * wS + d.frontProfile[k][0] * wF + d.rearProfile[k][0] * wR;
      c.ctrl[k][1] = d.sideProfile[k][1] * wS + d.frontProfile[k][1] * wF + d.rearProfile[k][1] * wR;
    }
    if (this.inset) {
      // fender-top / shoulder roll: pulls the top of the section inwards (narrower hood and
      // greenhouse base than the body sides); body sides only, it fades out around the nose / tail
      const ins = this.inset.eval(c.z) * wS;
      for (let k = 0; k < this.K; k++) c.ctrl[k][1] -= ins * smoothstep(0.8, 1.0, c.ctrl[k][0]);
    }
    const cl = d.charLine;
    if (cl && wS > 0) {
      const yc = lerp(cl.yRear, cl.yFront, (c.z - this.zR) / (this.zF - this.zR));
      const yN = (yc - c.yRef) / (c.yS - c.yRef);
      const k = CTRL_CHAR;
      const lo = c.ctrl[k - 1][0] + 0.04;
      const hi = c.ctrl[k + 1][0] - 0.03;
      c.ctrl[k][0] = lerp(c.ctrl[k][0], clamp(yN, lo, hi), wS);
      const fade = smoothstep(this.zR + 0.08, this.zR + 0.45, c.z) * smoothstep(this.zF - 0.25, this.zF - 0.75, c.z);
      c.ctrl[k][1] += cl.depth * wS * fade;
    }
    return c;
  }

  private tmp2: [number, number] = [0, 0];

  /** Point on the lower body at control parameter t of a column. */
  lowerPoint(c: Column, t: number, out: V3): V3 {
    const q = catmullRom2(c.ctrl, t, this.tmp2);
    const y = c.yRef + q[0] * (c.yS - c.yRef);
    const dd = q[1] + this.extras(c, y);
    out.x = c.x + c.nx * dd;
    out.y = y;
    out.z = c.z + c.nz * dd - this.noseLean.eval(q[0]) * c.leanF + this.tailLean.eval(q[0]) * c.leanR;
    return out;
  }

  /** Additive fender flares and rear haunch (outward offset in metres). */
  private extras(c: Column, y: number): number {
    const d = this.d;
    if (c.wS <= 0) return 0;
    let e = 0;
    const fade = smoothstep(c.yS - 0.02, c.yS - 0.18, y);
    for (let a = 0; a < 2; a++) {
      const za = a === 0 ? this.zFA : this.zRA;
      const r = Math.hypot(c.z - za, y - this.wheelR);
      const t = Math.max(0, r - this.archR) / 0.17;
      e += d.flare * Math.exp(-t * t * 3) * fade;
    }
    const hz = (c.z - this.zRA) / 0.9;
    const hy = (y - (c.yRef + 0.6 * (c.yS - c.yRef))) / (0.28 * (c.yS - c.yRef));
    e += d.haunch * Math.exp(-hz * hz - hy * hy);
    return e * c.wS;
  }

  /** Height of the bottom edge of the body side at plan z (wheel arches cut into the sill). */
  bottomY(z: number, yRef: number): number {
    let y = yRef;
    const R = this.archR;
    const legSlope = 0.12; // dz per dy of the arch "legs" below the wheel centre
    for (let a = 0; a < 2; a++) {
      const dz = Math.abs(z - (a === 0 ? this.zFA : this.zRA));
      let ya = -1;
      if (dz <= R) ya = this.wheelR + Math.sqrt(R * R - dz * dz);
      else if (dz <= R + (this.wheelR - yRef) * legSlope) ya = this.wheelR - (dz - R) / legSlope;
      if (ya > y) y = ya;
    }
    return y;
  }

  /** Parameter t at which the column's profile reaches the normalised height yN. */
  tOfYN(c: Column, yN: number): number {
    let lo = 0;
    let hi = this.K - 1;
    const q = this.tmp2;
    if (catmullRom2(c.ctrl, lo, q)[0] >= yN) return 0;
    for (let i = 0; i < 40; i++) {
      const m = 0.5 * (lo + hi);
      if (catmullRom2(c.ctrl, m, q)[0] < yN) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** t of the bottom edge of a column (0 unless a wheel arch cuts it). */
  bottomT(c: Column): number {
    const yb = this.bottomY(c.z, c.yRef);
    if (yb <= c.yRef + 1e-5) return 0;
    return this.tOfYN(c, (yb - c.yRef) / (c.yS - c.yRef));
  }

  /** t at absolute height y in a column. */
  tOfY(c: Column, y: number): number {
    return this.tOfYN(c, (y - c.yRef) / (c.yS - c.yRef));
  }

  private colA?: Column;
  private colB?: Column;

  /** Outward unit normal of the lower body at (p, t) by central differences. */
  lowerNormal(p: number, t: number, out: V3): V3 {
    const ep = 0.004;
    const et = 0.01;
    const p0 = Math.max(0, p - ep);
    const p1 = Math.min(this.P, p + ep);
    this.colA = this.column(p0, this.colA);
    this.colB = this.column(p1, this.colB);
    const a = this.lowerPoint(this.colA, t, { x: 0, y: 0, z: 0 });
    const b = this.lowerPoint(this.colB, t, { x: 0, y: 0, z: 0 });
    const c = this.column(p, this.colA);
    const t0 = Math.max(0, t - et);
    const t1 = Math.min(this.K - 1, t + et);
    const e = this.lowerPoint(c, t0, { x: 0, y: 0, z: 0 });
    const f = this.lowerPoint(c, t1, { x: 0, y: 0, z: 0 });
    // dP/dt x dP/dp
    const ux = f.x - e.x;
    const uy = f.y - e.y;
    const uz = f.z - e.z;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const vz = b.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) {
      out.x = c.nx;
      out.y = 0;
      out.z = c.nz;
      return out;
    }
    nx /= l;
    ny /= l;
    nz /= l;
    out.x = nx;
    out.y = ny;
    out.z = nz;
    return out;
  }

  /** Shoulder point S (top of the lower body) at station p. */
  shoulderPoint(p: number, out?: V3): V3 {
    const c = this.column(p);
    return this.lowerPoint(c, this.K - 1, out ?? { x: 0, y: 0, z: 0 });
  }

  /** p whose shoulder point has the given z (bisection). */
  pOfShoulderZ(z: number): number {
    let lo = 0;
    let hi = this.P;
    const s = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 50; i++) {
      const m = 0.5 * (lo + hi);
      this.shoulderPoint(m, s);
      if (s.z < z) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  /** Lower body point at plan p and absolute height y (for decals / details). */
  lowerAt(p: number, y: number, out: V3, normal?: V3): V3 {
    const c = this.column(p);
    const t = this.tOfY(c, y);
    this.lowerPoint(c, t, out);
    if (normal) this.lowerNormal(p, t, normal);
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // greenhouse
  /** Greenhouse centre-line height (only meaningful between rearBaseZ and cowlZ). */
  topY(z: number): number {
    return this.top.eval(z);
  }

  /** Height of the body centre line (deck, greenhouse) at z, used for the roof texture u. */
  centreY(z: number): number {
    const d = this.d;
    if (z >= d.rearBaseZ && z <= d.cowlZ) return this.top.eval(z);
    return this.shoulder.eval(z) + (z > d.cowlZ ? d.hoodCrown : d.deckCrown);
  }

  /** Arc length along the centre line from the rear tip to z. */
  sc(z: number): number {
    const t = clamp((z - this.zR) / (this.zF - this.zR), 0, 1) * (this.scZ.length - 1);
    const i = Math.min(Math.floor(t), this.scZ.length - 2);
    return lerp(this.scS[i], this.scS[i + 1], t - i);
  }

  ghSection(p: number, out?: GhSection): GhSection {
    const d = this.d;
    const n = SIDE_N + CORNER_N + ROOF_N;
    const sec: GhSection =
      out ??
      ({
        p,
        z: 0,
        xs: new Float64Array(n),
        ys: new Float64Array(n),
        arc: new Float64Array(n),
        len: 0,
        sideLen: 0,
        cornerEnd: 0,
        b: 0,
        xS: 0,
        yS: 0,
      } as GhSection);
    sec.p = p;
    const S = this.shoulderPoint(p);
    const z = S.z;
    sec.z = z;
    sec.xS = S.x;
    sec.yS = S.y;
    const yc = this.top.eval(z);
    const b = Math.max(0, yc - S.y);
    sec.b = b;
    const crownH = Math.min(d.roofCrown, b);
    const rc = clamp(b - crownH, 0, d.roofEdgeR);
    const hSide = Math.max(0, b - crownH - rc);
    const taper =
      d.roofTaperF * smoothstep(d.roofFrontZ - 0.3, d.cowlZ, z) + d.roofTaperR * smoothstep(d.roofRearZ + 0.3, d.rearBaseZ, z);
    const taperEff = taper * Math.min(1, hSide / 0.35);
    const r0x = S.x - d.tumblehome * hSide - taperEff;
    const r0y = S.y + hSide;
    // side direction
    let sdx = r0x - S.x;
    let sdy = r0y - S.y;
    let sl = Math.hypot(sdx, sdy);
    if (sl < 1e-6) {
      sdx = -d.tumblehome;
      sdy = 1;
      sl = Math.hypot(sdx, sdy);
    }
    sdx /= sl;
    sdy /= sl;
    const r1x = r0x - rc * 0.92;
    const r1y = r0y + rc;
    const roofSlope = r1x > 1e-4 ? (2 * crownH) / r1x : 0;
    let rdx = -1;
    let rdy = roofSlope;
    const rl = Math.hypot(rdx, rdy);
    rdx /= rl;
    rdy /= rl;
    // side line with a slight outward bow
    const bow = d.glassBow * hSide;
    let k = 0;
    for (let i = 0; i < SIDE_N; i++, k++) {
      const u = i / SIDE_N;
      const bb = bow * 4 * u * (1 - u);
      sec.xs[k] = lerp(S.x, r0x, u) + sdy * bb;
      sec.ys[k] = lerp(S.y, r0y, u) - sdx * bb;
    }
    // roof edge corner: cubic bezier
    const c1x = r0x + sdx * rc * 0.55;
    const c1y = r0y + sdy * rc * 0.55;
    const c2x = r1x - rdx * rc * 0.55;
    const c2y = r1y - rdy * rc * 0.55;
    for (let i = 0; i < CORNER_N; i++, k++) {
      const u = i / CORNER_N;
      const m = 1 - u;
      sec.xs[k] = m * m * m * r0x + 3 * m * m * u * c1x + 3 * m * u * u * c2x + u * u * u * r1x;
      sec.ys[k] = m * m * m * r0y + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u * u * u * r1y;
    }
    // crowned roof to the centre line
    for (let i = 0; i < ROOF_N; i++, k++) {
      const u = i / (ROOF_N - 1);
      const x = r1x * (1 - u);
      const xn = r1x > 1e-6 ? x / r1x : 0;
      sec.xs[k] = x;
      sec.ys[k] = yc - crownH * xn * xn;
    }
    sec.arc[0] = 0;
    for (let i = 1; i < n; i++) sec.arc[i] = sec.arc[i - 1] + Math.hypot(sec.xs[i] - sec.xs[i - 1], sec.ys[i] - sec.ys[i - 1]);
    sec.len = sec.arc[n - 1];
    sec.sideLen = sec.arc[SIDE_N];
    sec.cornerEnd = sec.arc[SIDE_N + CORNER_N];
    return sec;
  }

  /** Point (x, y) on a greenhouse section at arc length a; also the in-section tangent. */
  ghPoint(sec: GhSection, a: number, out: { x: number; y: number; tx: number; ty: number }): void {
    const arc = sec.arc;
    const n = arc.length;
    const aa = clamp(a, 0, sec.len);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (arc[m] > aa) hi = m;
      else lo = m;
    }
    const seg = arc[hi] - arc[lo];
    const u = seg > 1e-12 ? (aa - arc[lo]) / seg : 0;
    out.x = lerp(sec.xs[lo], sec.xs[hi], u);
    out.y = lerp(sec.ys[lo], sec.ys[hi], u);
    // tangent from a slightly wider window, skipping collapsed samples
    let i0 = lo;
    let i1 = hi;
    while (i0 > 0 && arc[lo] - arc[i0] < 0.004) i0--;
    while (i1 < n - 1 && arc[i1] - arc[hi] < 0.004) i1++;
    let tx = sec.xs[i1] - sec.xs[i0];
    let ty = sec.ys[i1] - sec.ys[i0];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    out.tx = tx;
    out.ty = ty;
  }

  /**
   * Arc length on a section for a "row parameter" r in [0, 3]: 0..1 along the side line,
   * 1..2 across the roof edge corner, 2..3 across the roof to the centre.
   */
  static rowArc(sec: GhSection, r: number): number {
    if (r <= 1) return sec.sideLen * Math.max(0, r);
    if (r <= 2) return lerp(sec.sideLen, sec.cornerEnd, r - 1);
    return lerp(sec.cornerEnd, sec.len, Math.min(1, r - 2));
  }
}
