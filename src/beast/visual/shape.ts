// Body dimensions derived from the canonical rig (src/beast/rig.ts) at unit scale, plus the
// sculpted torso "bean" (pelvis + chest + head as one soft blob) as a lathe-like surface with
// elliptical, slightly front/back asymmetric cross-sections.
//
// Bind space = beast-local rest pose (feet at y = 0, +z forward, +x = the beast's left).
// Torso surface parameters: s in [0, 1] = arc length along the profile from the bottom pole to the
// top of the head, theta = angle around the vertical axis measured from +z (front) towards +x.
import * as THREE from 'three';
import { BEAST_RIG } from '../rig';
import type { BeastPartName } from '../../brawl/contracts';

export interface Limb {
  /** joint at the top (shoulder / hip) */
  top: THREE.Vector3;
  /** middle joint (elbow / knee) */
  mid: THREE.Vector3;
  /** end of the lower segment (wrist / ankle) */
  end: THREE.Vector3;
  rTop: number;
  rMid: number;
  rEnd: number;
}

export interface BodyDims {
  yB: number;
  yT: number;
  pelvisY: number;
  chestY: number;
  /** y of the pelvis-chest joint and of the neck (chest-head) joint */
  waistY: number;
  neckY: number;
  headC: THREE.Vector3;
  headR: number;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  /** mitten centre (left; mirror x for right) */
  handL: THREE.Vector3;
  /** foot sole height and foot centre (left) */
  soleY: number;
  footL: THREE.Vector3;
  footR: THREE.Vector3;
  handR: THREE.Vector3;
}

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function limb(upper: BeastPartName, lower: BeastPartName, rUp: number, rLow: number, rEnd: number, endExtra: number): Limb {
  const U = BEAST_RIG[upper];
  const L = BEAST_RIG[lower];
  const top = v3(U.joint ?? U.rest);
  const mid = v3(L.joint ?? L.rest);
  // end of the lower segment: mirror the joint through the part centre (the physics capsule is
  // centred between its joint and its far end), slightly extended
  const c = v3(L.rest);
  const end = c.clone().multiplyScalar(2).sub(mid);
  const dir = end.clone().sub(mid).normalize();
  end.addScaledVector(dir, endExtra);
  return { top, mid, end, rTop: rUp, rMid: rLow, rEnd };
}

export function computeDims(): BodyDims {
  const P = BEAST_RIG.pelvis;
  const C = BEAST_RIG.chest;
  const H = BEAST_RIG.head;
  const yB = P.rest[1] - P.halfHeight - P.radius - 0.012;
  const yT = H.rest[1] + H.radius + 0.014;
  const ua = BEAST_RIG.upperArmL, la = BEAST_RIG.lowerArmL;
  const ul = BEAST_RIG.upperLegL, ll = BEAST_RIG.lowerLegL;
  const armL = limb('upperArmL', 'lowerArmL', ua.radius + 0.012, (ua.radius + la.radius) / 2 + 0.008, la.radius + 0.006, -0.035);
  const armR = limb('upperArmR', 'lowerArmR', ua.radius + 0.012, (ua.radius + la.radius) / 2 + 0.008, la.radius + 0.006, -0.035);
  const legL = limb('upperLegL', 'lowerLegL', ul.radius + 0.024, (ul.radius + ll.radius) / 2 + 0.017, ll.radius + 0.012, 0);
  const legR = limb('upperLegR', 'lowerLegR', ul.radius + 0.024, (ul.radius + ll.radius) / 2 + 0.017, ll.radius + 0.012, 0);
  // sink the shoulder balls a little into the torso so the arms sprout from the body
  for (const a of [armL, armR]) a.top.addScaledVector(a.mid.clone().sub(a.top).normalize(), 0.028);
  // feet: sole at the bottom of the lower-leg capsule (never below -3 cm)
  const lowBottom = ll.rest[1] - ll.halfHeight - ll.radius;
  const soleY = Math.max(-0.03, Math.min(0.02, lowBottom - 0.003));
  // ankle a bit above the sole so the stubby foot hangs under it
  legL.end.y = Math.max(legL.end.y, soleY + 0.1);
  legR.end.y = Math.max(legR.end.y, soleY + 0.1);
  const footL = new THREE.Vector3(legL.end.x + 0.004, soleY + 0.056, 0.035);
  const footR = new THREE.Vector3(legR.end.x - 0.004, soleY + 0.056, 0.035);
  const handL = armL.end.clone().add(new THREE.Vector3(0.003, -0.022, 0.008));
  const handR = armR.end.clone().add(new THREE.Vector3(-0.003, -0.022, 0.008));
  return {
    yB,
    yT,
    pelvisY: P.rest[1],
    chestY: C.rest[1],
    waistY: C.joint ? C.joint[1] : (P.rest[1] + C.rest[1]) / 2,
    neckY: H.joint ? H.joint[1] : (C.rest[1] + H.rest[1]) / 2,
    headC: new THREE.Vector3(0, H.rest[1], 0),
    headR: H.radius + 0.012,
    armL,
    armR,
    legL,
    legR,
    handL,
    handR,
    soleY,
    footL,
    footR,
  };
}

/** The torso bean. Built once (rig numbers are constants at runtime). */
export class TorsoShape {
  readonly dims: BodyDims;
  private readonly sR: Float32Array; // radius (x half width) per table entry
  private readonly sY: Float32Array;
  private readonly N = 512;

  constructor(dims: BodyDims) {
    this.dims = dims;
    const d = dims;
    const H = d.yT - d.yB;
    const C = BEAST_RIG.chest.radius;
    const Hr = BEAST_RIG.head.radius;
    const P = BEAST_RIG.pelvis.radius;
    // control points (radius, y): round bottom, soft belly, barely-there neck, big round head
    const y = (f: number) => d.yB + f * H;
    const pts: [number, number][] = [
      [0, d.yB],
      [P * 0.5, y(0.008)],
      [P * 0.93, y(0.045)],
      [P * 1.13, y(0.11)],
      [C * 1.16, y(0.21)],
      [C * 1.19, y(0.31)],
      [C * 1.17, y(0.42)],
      [C * 1.11, y(0.53)],
      [C * 1.045, y(0.625)],
      [Hr * 1.055, y(0.71)],
      [Hr * 1.07, y(0.79)],
      [Hr * 1.05, y(0.855)],
      [Hr * 0.975, y(0.905)],
      [Hr * 0.84, y(0.948)],
      [Hr * 0.6, y(0.983)],
      [Hr * 0.3, y(0.997)],
      [0, d.yT],
    ];
    const curve = new THREE.SplineCurve(pts.map(([r, yy]) => new THREE.Vector2(r, yy)));
    const sp = curve.getSpacedPoints(this.N - 1);
    this.sR = new Float32Array(this.N);
    this.sY = new Float32Array(this.N);
    let lastY = -Infinity;
    for (let i = 0; i < this.N; i++) {
      this.sR[i] = Math.max(0, sp[i].x);
      // keep y monotonic (needed for yToS)
      lastY = Math.max(lastY + 1e-6, sp[i].y);
      this.sY[i] = lastY;
    }
    this.sR[0] = 0;
    this.sR[this.N - 1] = 0;
  }

  private lookup(s: number): [number, number] {
    const f = Math.min(Math.max(s, 0), 1) * (this.N - 1);
    const i = Math.min(this.N - 2, Math.floor(f));
    const t = f - i;
    return [this.sR[i] + (this.sR[i + 1] - this.sR[i]) * t, this.sY[i] + (this.sY[i + 1] - this.sY[i]) * t];
  }

  /** Profile parameter s at height y. */
  yToS(y: number): number {
    const Y = this.sY;
    if (y <= Y[0]) return 0;
    if (y >= Y[this.N - 1]) return 1;
    let lo = 0, hi = this.N - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (Y[m] <= y) lo = m; else hi = m;
    }
    const t = (y - Y[lo]) / Math.max(1e-9, Y[hi] - Y[lo]);
    return (lo + t) / (this.N - 1);
  }

  /** Front/back depth factors and forward offset of the cross-section at height y. */
  private depth(y: number): { f: number; b: number; cz: number } {
    const d = this.dims;
    const head = smooth(d.neckY - 0.02, d.neckY + 0.12, y);
    const belly = Math.exp(-(((y - (d.waistY - 0.02)) / 0.15) ** 2));
    return {
      f: 0.95 + 0.05 * head + 0.07 * belly,
      b: 0.9 + 0.07 * head,
      cz: 0.016 * belly - 0.004 * head,
    };
  }

  /** Surface point (offset `off` along the outward normal). */
  point(s: number, theta: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    this.rawPoint(s, theta, out);
    if (off !== 0) {
      const n = this.normal(s, theta, _n);
      out.addScaledVector(n, off);
    }
    return out;
  }

  rawPoint(s: number, theta: number, out: THREE.Vector3): THREE.Vector3 {
    const [r, y] = this.lookup(s);
    const dp = this.depth(y);
    const c = Math.cos(theta);
    const rz = r * (c >= 0 ? dp.f : dp.b);
    return out.set(r * Math.sin(theta), y, dp.cz + rz * c);
  }

  /** Outward unit normal of the surface at (s, theta) (finite differences). */
  normal(s: number, theta: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 1e-3;
    const s0 = Math.max(0, s - e), s1 = Math.min(1, s + e);
    this.rawPoint(s1, theta, _a);
    this.rawPoint(s0, theta, _b);
    const ds = _a.sub(_b); // along the profile (upwards)
    this.rawPoint(s, theta + e, _c);
    this.rawPoint(s, theta - e, _d);
    const dt = _c.sub(_d); // around (towards +theta)
    out.crossVectors(dt, ds);
    if (out.lengthSq() < 1e-14) {
      // pole
      out.set(0, s < 0.5 ? -1 : 1, 0);
      return out;
    }
    out.normalize();
    // make sure it points outwards
    this.rawPoint(s, theta, _a);
    _b.set(_a.x, 0, _a.z - this.depth(_a.y).cz);
    if (s > 0.02 && s < 0.98 && out.x * _b.x + out.z * _b.z < 0) out.negate();
    return out;
  }

  /** Horizontal radius (distance from the axis) of the surface at height y towards theta. */
  radiusAt(y: number, theta: number): number {
    this.rawPoint(this.yToS(y), theta, _a);
    return Math.hypot(_a.x, _a.z - this.depth(y).cz);
  }

  /** Surface point at height y towards theta, offset along the normal. */
  pointAtY(y: number, theta: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    return this.point(this.yToS(y), theta, off, out);
  }

  normalAtY(y: number, theta: number, out: THREE.Vector3): THREE.Vector3 {
    return this.normal(this.yToS(y), theta, out);
  }
}

const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

export function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

let cached: TorsoShape | null = null;
export function getTorsoShape(): TorsoShape {
  if (!cached) cached = new TorsoShape(computeDims());
  return cached;
}
