// Building blocks for the costumes (module beast-visual): hats fitted to the head of the torso bean,
// garments that hug the torso, sleeves / trouser legs with ball ends on the joints (so they bend
// like the jelly body underneath), shoes, straps, studs and beads. Everything is merged into one
// SkinMesher -> one draw call per costume.
import * as THREE from 'three';
import type { BeastPartName } from '../../brawl/contracts';
import { footGeometry } from './body';
import {
  SkinMesher,
  axisRing,
  capsuleProfile,
  clipProfile,
  ellipsoid,
  ensureOutward,
  inflate,
  latheAlong,
  mergeSeams,
  paramSurface,
  torsoBand,
  torsoJig,
  type Skin,
  type Style,
} from './geometry';
import { smooth, type BodyDims, type Limb, type TorsoShape } from './shape';

const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Local frame of a hat: origin on the head axis, `up` = hat axis, fwd/left span the brim plane. */
export interface Frame {
  o: THREE.Vector3;
  up: THREE.Vector3;
  fwd: THREE.Vector3;
  left: THREE.Vector3;
}

/** Hat frame at height y0 (z0 forward), tilted back by `pitch` (front higher) and rolled sideways. */
export function hatFrame(y0: number, pitch: number, roll = 0, z0 = 0): Frame {
  const q = new THREE.Quaternion().setFromAxisAngle(Z, roll).multiply(new THREE.Quaternion().setFromAxisAngle(X, -pitch));
  return {
    o: new THREE.Vector3(0, y0, z0),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    left: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
  };
}

export function framePoint(f: Frame, r: number, phi: number, h: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out
    .copy(f.o)
    .addScaledVector(f.up, h)
    .addScaledVector(f.fwd, Math.cos(phi) * r)
    .addScaledVector(f.left, Math.sin(phi) * r);
}

/** Wrap an angle to [-pi, pi]. */
export function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Smooth "front" weight: 1 at theta = 0, 0 beyond +-width (cosine falloff). */
export function frontW(theta: number, width: number): number {
  const a = Math.abs(wrapPi(theta));
  return a >= width ? 0 : 0.5 + 0.5 * Math.cos((a / width) * Math.PI);
}

export interface SkirtOpts {
  anchor: number;
  bottom: number;
  off: number;
  offTheta?: (theta: number) => number;
  flare: (t: number, theta: number) => number;
}

/** Unused-type guard for BodyDims re-export. */
export type { BodyDims };

export class CostumeKit {
  readonly shape: TorsoShape;
  readonly d: BodyDims;
  readonly m: SkinMesher;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(shape: TorsoShape) {
    this.shape = shape;
    this.d = shape.dims;
    this.m = new SkinMesher(shape);
  }

  add(g: THREE.BufferGeometry, style: Style, skin: Skin): void {
    this.m.add(g, style, skin);
  }

  // ------------------------------------------------------------------------------------- head
  /** Largest radius (R) and height (H) of the head surface above the frame's base plane. */
  fitHead(f: Frame): { R: number; H: number } {
    const s0 = this.shape.yToS(1.05);
    let R = 0, H = 0;
    const p = this.tmp;
    for (let i = 0; i <= 60; i++) {
      const s = s0 + ((1 - s0) * i) / 60;
      for (let j = 0; j < 48; j++) {
        this.shape.rawPoint(s, (j / 48) * Math.PI * 2, p);
        p.sub(f.o);
        const h = p.dot(f.up);
        if (h < 0) continue;
        H = Math.max(H, h);
        R = Math.max(R, p.addScaledVector(f.up, -h).length());
      }
    }
    return { R, H };
  }

  /** Torso parameter s where the head surface crosses the frame's base plane towards theta. */
  private loopS(f: Frame, theta: number): number {
    const g = (s: number) => this.shape.rawPoint(s, theta, this.tmp).sub(f.o).dot(f.up);
    let lo = this.shape.yToS(0.95), hi = 1;
    if (g(lo) > 0) return lo;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (g(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  /**
   * Dome hugging the head above the frame plane, offset `off(v, theta)` along the surface normal
   * (v = 0 at the rim, 1 at the top). `fn` may reshape each vertex (flatten, stretch...).
   * Returns the geometry and the rim loop (closed, `radial` points) with outward normals.
   */
  headCap(f: Frame, o: {
    off: number | ((v: number, theta: number) => number);
    radial?: number;
    rings?: number;
    fn?: (p: THREE.Vector3, v: number, theta: number) => void;
  }): { geo: THREE.BufferGeometry; rim: THREE.Vector3[]; rimN: THREE.Vector3[]; at: (theta: number, v: number) => THREE.Vector3; top: THREE.Vector3 } {
    const radial = o.radial ?? 28;
    const rings = o.rings ?? 10;
    const sLoop: number[] = [];
    for (let j = 0; j < radial; j++) sLoop.push(this.loopS(f, (j / radial) * Math.PI * 2));
    const off = typeof o.off === 'number' ? () => o.off as number : o.off;
    const eval_ = (j: number, v: number, out: THREE.Vector3) => {
      const th = (j / radial) * Math.PI * 2;
      const s = sLoop[j % radial] + (1 - sLoop[j % radial]) * v;
      this.shape.point(Math.min(1, s), th, off(v, th), out);
      o.fn?.(out, v, th);
      return out;
    };
    const geo = paramSurface(radial, rings, (u, v, out) => {
      eval_(Math.round(u * radial), v, out);
    }, true, this.d.headC);
    const rim: THREE.Vector3[] = [];
    const rimN: THREE.Vector3[] = [];
    for (let j = 0; j < radial; j++) {
      rim.push(eval_(j, 0, new THREE.Vector3()));
      // outward = away from the hat axis
      const n = rim[j].clone().sub(f.o);
      n.addScaledVector(f.up, -n.dot(f.up)).normalize();
      rimN.push(n);
    }
    const at = (theta: number, v: number): THREE.Vector3 => {
      const sl = this.loopS(f, theta);
      const out = this.shape.point(Math.min(1, sl + (1 - sl) * v), theta, off(v, theta), new THREE.Vector3());
      o.fn?.(out, v, theta);
      return out;
    };
    return { geo, rim, rimN, at, top: at(0, 1) };
  }

  // ------------------------------------------------------------------------------------- skirts
  /**
   * Point of a garment that hugs the torso above `anchor` and hangs free below it (skirt, coat):
   * below the anchor it continues straight down from the anchor ring, pushed out by flare(t, theta)
   * (t = 0 at the anchor, 1 at `bottom`).
   */
  skirtPoint(th: number, y: number, o: SkirtOpts, out: THREE.Vector3): THREE.Vector3 {
    const off = o.off + (o.offTheta ? o.offTheta(th) : 0);
    if (y >= o.anchor) return this.shape.pointAtY(y, th, off, out);
    this.shape.pointAtY(o.anchor, th, off, out);
    const n = this.shape.normalAtY(o.anchor, th, this.tmp2);
    n.y = 0;
    n.normalize();
    const t = (o.anchor - y) / Math.max(1e-6, o.anchor - o.bottom);
    const fl = o.flare(t, th);
    out.x += n.x * fl;
    out.z += n.z * fl;
    out.y = y;
    return out;
  }

  skirt(o: SkirtOpts & { top: number; th0?: number; th1?: number; nu?: number; nv?: number }): THREE.BufferGeometry {
    const full = o.th0 === undefined;
    const th0 = o.th0 ?? 0, th1 = o.th1 ?? Math.PI * 2;
    const nu = o.nu ?? (full ? 48 : Math.max(8, Math.round((48 * (th1 - th0)) / (Math.PI * 2))));
    const nv = o.nv ?? Math.max(4, Math.round((o.top - o.bottom) / 0.03));
    const g = paramSurface(nu, nv, (u, v, out) => {
      this.skirtPoint(th0 + u * (th1 - th0), o.top + (o.bottom - o.top) * v, o, out);
    }, full);
    ensureOutward(g, new THREE.Vector3(0, (o.top + o.bottom) / 2, 0));
    return g;
  }

  /** Closed (or partial) ring of skirt points at height y. */
  skirtEdge(y: number, o: SkirtOpts, th0 = 0, th1 = Math.PI * 2, n = 56): { pts: THREE.Vector3[]; outs: THREE.Vector3[] } {
    const pts: THREE.Vector3[] = [];
    const outs: THREE.Vector3[] = [];
    const full = Math.abs(th1 - th0 - Math.PI * 2) < 1e-6;
    for (let i = 0; i < (full ? n : n + 1); i++) {
      const th = th0 + ((th1 - th0) * i) / n;
      const p = this.skirtPoint(th, y, o, new THREE.Vector3());
      pts.push(p);
      outs.push(new THREE.Vector3(Math.sin(th), 0, Math.cos(th)));
    }
    return { pts, outs };
  }

  // ------------------------------------------------------------------------------------- lathe
  /**
   * Surface of revolution about the frame axis; fn(phi, k) -> [radius, height] for profile point k
   * (phi = 0 forward, +pi/2 = the beast's left). Partial when th0/th1 are given.
   */
  revolve(f: Frame, radial: number, n: number, fn: (phi: number, k: number) => [number, number], o: { th0?: number; th1?: number; inside?: THREE.Vector3 } = {}): THREE.BufferGeometry {
    const full = o.th0 === undefined;
    const th0 = o.th0 ?? 0, th1 = o.th1 ?? Math.PI * 2;
    return paramSurface(radial, n - 1, (u, v, out) => {
      const phi = th0 + u * (th1 - th0);
      const k = Math.round(v * (n - 1));
      const [r, h] = fn(phi, k);
      framePoint(f, r, phi, h, out);
    }, full, o.inside);
  }

  revolveProf(f: Frame, prof: [number, number][], radial: number, o: { th0?: number; th1?: number; inside?: THREE.Vector3 } = {}): THREE.BufferGeometry {
    return this.revolve(f, radial, prof.length, (_p, k) => prof[k], o);
  }

  // ------------------------------------------------------------------------------------- torso
  /** Torso panel between yLo(theta) and yHi(theta), offset off(theta, y) along the normal. */
  torsoPanel(o: {
    yLo: number | ((theta: number) => number);
    yHi: number | ((theta: number) => number);
    off: number | ((theta: number, y: number) => number);
    th0?: number;
    th1?: number;
    nu?: number;
    nv?: number;
  }): THREE.BufferGeometry {
    const full = o.th0 === undefined;
    const th0 = o.th0 ?? 0, th1 = o.th1 ?? Math.PI * 2;
    const yLo = typeof o.yLo === 'number' ? () => o.yLo as number : o.yLo;
    const yHi = typeof o.yHi === 'number' ? () => o.yHi as number : o.yHi;
    const off = typeof o.off === 'number' ? () => o.off as number : o.off;
    const nu = o.nu ?? (full ? 44 : Math.max(6, Math.round((44 * (th1 - th0)) / (Math.PI * 2))));
    const span = Math.abs(yHi(0) - yLo(0));
    const nv = o.nv ?? Math.max(3, Math.round(span / 0.025));
    const g = paramSurface(nu, nv, (u, v, out) => {
      const th = th0 + u * (th1 - th0);
      const y = yLo(th) + (yHi(th) - yLo(th)) * v;
      this.shape.pointAtY(y, th, off(th, y), out);
    }, full);
    ensureOutward(g, new THREE.Vector3(0, (yLo(0) + yHi(0)) / 2, 0));
    return g;
  }

  /** Points (and outward normals) along a curve on the torso surface: [theta, y, off] controls. */
  surfacePath(ctrl: [number, number, number][], n: number): { pts: THREE.Vector3[]; outs: THREE.Vector3[] } {
    const c = new THREE.CatmullRomCurve3(ctrl.map(([t, y, o]) => new THREE.Vector3(t, y, o)), false, 'centripetal');
    const pts: THREE.Vector3[] = [];
    const outs: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const q = c.getPoint(i / n);
      pts.push(this.shape.pointAtY(q.y, q.x, q.z, new THREE.Vector3()));
      outs.push(this.shape.normalAtY(q.y, q.x, new THREE.Vector3()));
    }
    return { pts, outs };
  }

  /** Points along an edge y = yf(theta) on the torso (for hems, collars, plackets). */
  edgePath(yf: (theta: number) => number, off: number, th0: number, th1: number, n: number): { pts: THREE.Vector3[]; outs: THREE.Vector3[] } {
    const pts: THREE.Vector3[] = [];
    const outs: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const th = th0 + ((th1 - th0) * i) / n;
      const y = yf(th);
      pts.push(this.shape.pointAtY(y, th, off, new THREE.Vector3()));
      outs.push(this.shape.normalAtY(y, th, new THREE.Vector3()));
    }
    return { pts, outs };
  }

  // ------------------------------------------------------------------------------------- limbs
  limbAxis(limb: Limb, seg: 'upper' | 'lower'): { a: THREE.Vector3; b: THREE.Vector3; ra: number; rb: number; L: number; u: THREE.Vector3 } {
    const a = seg === 'upper' ? limb.top : limb.mid;
    const b = seg === 'upper' ? limb.mid : limb.end;
    const ra = seg === 'upper' ? limb.rTop : limb.rMid;
    const rb = seg === 'upper' ? limb.rMid : limb.rEnd;
    const L = a.distanceTo(b);
    return { a, b, ra, rb, L, u: b.clone().sub(a).normalize() };
  }

  /** Sleeve / trouser leg over a limb segment; from/to = fractions of the segment (omit = ball cap). */
  limbTube(limb: Limb, seg: 'upper' | 'lower', o: { from?: number; to?: number; off: number; bulge?: (f: number) => number; radial?: number }): THREE.BufferGeometry {
    const { a, b, ra, rb, L } = this.limbAxis(limb, seg);
    let prof = capsuleProfile(L, ra, rb, 4, 3);
    if (o.from !== undefined || o.to !== undefined) {
      prof = clipProfile(prof, o.from === undefined ? -ra - 1 : o.from * L, o.to === undefined ? L + rb + 1 : o.to * L);
    }
    prof = inflate(prof, o.off);
    // the joint ball of a lower segment hides inside the upper segment's ball (no z-fighting of
    // two identical spheres with differently mapped patterns at the elbow / knee)
    if (seg === 'lower' && o.from === undefined) {
      prof = prof.map(([r, t], i) => (t <= 1e-6 ? [i === 0 ? 0 : Math.max(0, r - 0.0025), i === 0 ? t + 0.0025 : t] : [r, t]) as [number, number]);
    }
    if (o.bulge) prof = prof.map(([r, t]) => [r > 1e-6 ? r + o.bulge!(t / L) : r, t] as [number, number]);
    return latheAlong(a, b, prof, o.radial ?? 14);
  }

  /** Ring (cuff, hem) around a limb segment at fraction f. */
  limbRing(limb: Limb, seg: 'upper' | 'lower', f: number, off: number, tube: number): THREE.BufferGeometry {
    const { a, ra, rb, L, u } = this.limbAxis(limb, seg);
    const c = a.clone().addScaledVector(u, f * L);
    const r = ra + (rb - ra) * Math.min(1, Math.max(0, f)) + off;
    return axisRing(c, u, r, tube, 16, 5);
  }

  /** Garment over the soft shoulder blob (same centre/blend as the body's blob). */
  shoulderBlob(side: 1 | -1, off: number): { geo: THREE.BufferGeometry; skin: Skin } {
    const top = side > 0 ? this.d.armL.top : this.d.armR.top;
    const c = new THREE.Vector3(top.x - side * 0.04, top.y + 0.004, top.z - 0.004);
    const bone: BeastPartName = side > 0 ? 'upperArmL' : 'upperArmR';
    return { geo: ellipsoid(c, 0.072 + off, 0.072 + off, 0.086 + off, 16, 10), skin: { blend: [['chest', 0.6], [bone, 0.4]] } };
  }

  // ------------------------------------------------------------------------------------- feet
  /** Shoe upper (inflated foot) + sole slab, rigid to the lower leg. */
  shoe(side: 1 | -1, upper: Style, sole: Style, o: { inflate?: number; len?: number; soleT?: number } = {}): void {
    const inf = o.inflate ?? 0.012;
    const len = o.len ?? 1.04;
    const c = side > 0 ? this.d.footL.clone() : this.d.footR.clone();
    const soleY = this.d.soleY;
    const bone: BeastPartName = side > 0 ? 'lowerLegL' : 'lowerLegR';
    c.z += 0.006;
    const up = footGeometry(c, soleY + 0.002 + inf, inf, len);
    this.add(up, upper, { bone, jig: 0 });
    const t = o.soleT ?? 0.011;
    const slab = ellipsoid(new THREE.Vector3(c.x, soleY + 0.003, c.z + 0.004), 0.088 + inf, t, 0.128 * len + inf, 18, 6);
    this.add(slab, sole, { bone, jig: 0 });
  }

  footCentre(side: 1 | -1): THREE.Vector3 {
    return side > 0 ? this.d.footL.clone() : this.d.footR.clone();
  }
}

// ---------------------------------------------------------------------------------------------
// free primitives
// ---------------------------------------------------------------------------------------------

/**
 * Tube along a polyline. Cross-section: ellipse with radius rOut along the per-point outward
 * vector (outs) and rSide across it (flat straps: small rOut, big rSide).
 */
export function tubeAlong(pts: THREE.Vector3[], o: { rOut: number; rSide?: number; seg?: number; closed?: boolean; outs?: THREE.Vector3[]; taper?: (f: number) => number }): THREE.BufferGeometry {
  const seg = o.seg ?? 8;
  const n = pts.length;
  const closed = o.closed ?? false;
  const pos: number[] = [];
  const idx: number[] = [];
  const centre = new THREE.Vector3();
  for (const p of pts) centre.add(p);
  centre.divideScalar(n);
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    T.subVectors(next, prev).normalize();
    if (o.outs) N.copy(o.outs[i]);
    else N.subVectors(pts[i], centre);
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-12) N.set(0, 1, 0).addScaledVector(T, -T.y);
    N.normalize();
    B.crossVectors(T, N).normalize();
    const k = o.taper ? o.taper(i / (n - 1)) : 1;
    const ro = o.rOut * k, rs = (o.rSide ?? o.rOut) * k;
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const c = Math.cos(a) * ro, s = Math.sin(a) * rs;
      pos.push(pts[i].x + N.x * c + B.x * s, pts[i].y + N.y * c + B.y * s, pts[i].z + N.z * c + B.z * s);
    }
  }
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const i1 = (i + 1) % n;
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = i * seg + j, b = i * seg + j1, c = i1 * seg + j, d = i1 * seg + j1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // end caps (fan) for open tubes
  if (!closed) {
    for (const [ring, flip] of [[0, true], [n - 1, false]] as const) {
      const ci = pos.length / 3;
      const p = pts[ring];
      pos.push(p.x, p.y, p.z);
      for (let j = 0; j < seg; j++) {
        const j1 = (j + 1) % seg;
        const a = ring * seg + j, b = ring * seg + j1;
        if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Rounded box (superellipsoid; e < 1 = boxier). */
export function roundBox(c: THREE.Vector3, hx: number, hy: number, hz: number, e = 0.32, w = 16, h = 12, m?: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.deleteAttribute('uv');
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const f = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), e);
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i)) * hx, f(p.getY(i)) * hy, f(p.getZ(i)) * hz);
  if (m) g.applyMatrix4(m);
  g.translate(c.x, c.y, c.z);
  return mergeSeams(g);
}

/** Small flattened dome (button, rivet, gem) on a surface point p with normal n. */
export function stud(p: THREE.Vector3, n: THREE.Vector3, r: number, depth: number, w = 8, h = 5): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.deleteAttribute('uv');
  const q = new THREE.Quaternion().setFromUnitVectors(Z, n.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(r, r, depth)));
  return mergeSeams(g);
}

/** Matrix that maps local z to `dir` (and local y as close as possible to `upHint`) at p. */
export function orient(p: THREE.Vector3, dir: THREE.Vector3, upHint = new THREE.Vector3(0, 1, 0), scale = new THREE.Vector3(1, 1, 1)): THREE.Matrix4 {
  const z = dir.clone().normalize();
  const x = new THREE.Vector3().crossVectors(upHint, z);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  m.scale(scale);
  m.setPosition(p);
  return m;
}

/** Cylinder between a and b (radius ra at a, rb at b), capped. */
export function cylinderAB(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb = ra, radial = 12): THREE.BufferGeometry {
  const L = a.distanceTo(b);
  const prof: [number, number][] = [[0, 0], [ra, 0], [rb, L], [0, L]];
  return latheAlong(a, b, prof, radial);
}

export { smooth, torsoBand, torsoJig };
