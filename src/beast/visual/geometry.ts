// Geometry helpers for the beast meshes: a skinned "mesher" that merges many pieces into one
// BufferGeometry (one draw call per material) and a few procedural primitives (lathes along an
// axis, capsules with ball ends at the joints, torso bands that hug the body bean).
import * as THREE from 'three';
import { BEAST_PARTS, BEAST_RIG } from '../rig';
import type { BeastPartName } from '../../brawl/contracts';
import { smooth, type TorsoShape } from './shape';

export const BONE_INDEX: Readonly<Record<BeastPartName, number>> = Object.fromEntries(
  BEAST_PARTS.map((p, i) => [p, i]),
) as Record<BeastPartName, number>;

/** Cosmetic surface parameters per vertex (costume material). */
export interface Style {
  color: THREE.ColorRepresentation;
  /** second colour for procedural patterns */
  color2?: THREE.ColorRepresentation;
  rough?: number;
  metal?: number;
  /** fabric sheen amount 0..1 */
  sheen?: number;
  /** procedural pattern id (see PATTERN in materials.ts) */
  pattern?: number;
}

/**
 * Skinning of a piece:
 * - { bone, jig? }: rigid to one part (jig = constant jiggle weight; default: torso jiggle at the
 *   piece's attachment height, see jigAt)
 * - 'torso': smooth pelvis/chest/head weights from the bind height (same as the body bean), so
 *   garments deform exactly like the body underneath.
 */
export type Skin = { bone: BeastPartName; jig?: number } | { blend: [BeastPartName, number][]; jig?: number } | 'torso';

export class SkinMesher {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private col2: number[] = [];
  private surf: number[] = [];
  private pm: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private jig: number[] = [];
  private idx: number[] = [];
  private readonly c1 = new THREE.Color();
  private readonly c2 = new THREE.Color();

  constructor(private readonly shape: TorsoShape) {}

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Adds a geometry (indexed or not, positions in bind space after `matrix`). Consumes `geo`. */
  add(geo: THREE.BufferGeometry, style: Style, skin: Skin, matrix?: THREE.Matrix4): void {
    if (matrix) geo.applyMatrix4(matrix);
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const base = this.vertexCount;
    this.c1.set(style.color);
    this.c2.set(style.color2 ?? style.color);
    const rough = style.rough ?? 0.8;
    const metal = style.metal ?? 0;
    const sheen = style.sheen ?? 0;
    const pat = style.pattern ?? 0;
    let rigidJig = 0;
    if (skin !== 'torso') {
      if (skin.jig !== undefined) rigidJig = skin.jig;
      else {
        // jiggle like the torso at the piece's centre height (rigid items move rigidly)
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        rigidJig = this.jigAt((bb.min.y + bb.max.y) / 2, 'bone' in skin ? skin.bone : skin.blend[0][0]);
      }
    }
    const blend = skin !== 'torso' && 'blend' in skin ? skin.blend : null;
    const [pcx, pcz, pR] = patternAxis(skin);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      this.pos.push(x, y, z);
      this.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(this.c1.r, this.c1.g, this.c1.b);
      this.col2.push(this.c2.r, this.c2.g, this.c2.b);
      this.surf.push(rough, metal, sheen, pat);
      this.pm.push(x - pcx, y, z - pcz, pR);
      if (skin === 'torso') {
        const w = torsoWeights(this.shape, y);
        this.si.push(BONE_INDEX.pelvis, BONE_INDEX.chest, BONE_INDEX.head, 0);
        this.sw.push(w[0], w[1], w[2], 0);
        this.jig.push(torsoJig(this.shape, y));
      } else if (blend) {
        for (let k = 0; k < 4; k++) {
          this.si.push(k < blend.length ? BONE_INDEX[blend[k][0]] : 0);
          this.sw.push(k < blend.length ? blend[k][1] : 0);
        }
        this.jig.push(rigidJig);
      } else if ('bone' in skin) {
        this.si.push(BONE_INDEX[skin.bone], 0, 0, 0);
        this.sw.push(1, 0, 0, 0);
        this.jig.push(rigidJig);
      }
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  /** Jiggle weight of a rigid item attached to `bone` at bind height y. */
  jigAt(y: number, bone: BeastPartName): number {
    if (bone === 'pelvis' || bone === 'chest' || bone === 'head') return torsoJig(this.shape, y);
    if (bone.startsWith('upperArm') || bone.startsWith('lowerArm')) return torsoJig(this.shape, this.shape.dims.armL.top.y);
    return 0;
  }

  build(withCostumeAttributes: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('jig', new THREE.Float32BufferAttribute(this.jig, 1));
    if (withCostumeAttributes) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('color2', new THREE.Float32BufferAttribute(this.col2, 3));
      g.setAttribute('surf', new THREE.Float32BufferAttribute(this.surf, 4));
      g.setAttribute('pmap', new THREE.Float32BufferAttribute(this.pm, 4));
    }
    const vc = this.vertexCount;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * Axis of the procedural fabric patterns for a piece: [x, z, arc radius]. Torso items use the body
 * axis; sleeves / trouser legs / shoes use their limb axis, so stripes and checks wrap the limb.
 */
function patternAxis(skin: Skin): [number, number, number] {
  if (skin === 'torso' || 'blend' in skin) return [0, 0, 0.24];
  const b = skin.bone;
  if (b === 'pelvis' || b === 'chest' || b === 'head') return [0, 0, 0.24];
  const r = BEAST_RIG[b].rest;
  return [r[0], r[2], b.includes('Leg') ? 0.1 : 0.085];
}

/** Pelvis / chest / head weights of the torso bean (and torso garments) at bind height y. */
export function torsoWeights(shape: TorsoShape, y: number): [number, number, number] {
  const d = shape.dims;
  const head = smooth(d.neckY - 0.035, d.neckY + 0.085, y);
  const pelvis = 1 - smooth(d.waistY - 0.1, d.waistY + 0.07, y);
  const chest = Math.max(0, 1 - head - pelvis);
  const s = pelvis + chest + head;
  return [pelvis / s, chest / s, head / s];
}

/** Jiggle weight of the torso bean at bind height y (0 at the hips, 1 at the top of the head). */
export function torsoJig(shape: TorsoShape, y: number): number {
  const d = shape.dims;
  const t = Math.min(1, Math.max(0, (y - d.pelvisY + 0.05) / (d.yT - d.pelvisY + 0.05)));
  return Math.pow(t, 1.35);
}

// ---------------------------------------------------------------------------------------------
// primitives (all return indexed geometries in bind space)
// ---------------------------------------------------------------------------------------------

/** Radius profile point: [radius, t] with t = distance along the axis from `a`. */
export type Prof = [number, number][];

/**
 * Surface of revolution around the axis a -> b. profile = [radius, t]; a first/last point with
 * radius 0 becomes a single pole vertex. `sx`/`sz` scale the cross-section (ellipse).
 */
export function latheAlong(a: THREE.Vector3, b: THREE.Vector3, profile: Prof, radial: number, opts: { sx?: number; sz?: number; side?: THREE.Vector3; twist?: number } = {}): THREE.BufferGeometry {
  const axis = b.clone().sub(a);
  const L = axis.length();
  const u = L > 1e-9 ? axis.divideScalar(L) : new THREE.Vector3(0, 1, 0);
  // stable side vector: prefer +z-ish front
  const ref = opts.side ? opts.side.clone() : Math.abs(u.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const v = ref.sub(u.clone().multiplyScalar(ref.dot(u))).normalize(); // "front"
  const w = new THREE.Vector3().crossVectors(u, v).normalize();
  const sx = opts.sx ?? 1, sz = opts.sz ?? 1;
  const pos: number[] = [];
  const idx: number[] = [];
  const ringStart: number[] = [];
  const ringIsPole: boolean[] = [];
  const tmp = new THREE.Vector3();
  for (let k = 0; k < profile.length; k++) {
    const [r, t] = profile[k];
    const c = tmp.copy(a).addScaledVector(u, t);
    ringStart.push(pos.length / 3);
    const pole = r < 1e-6 && (k === 0 || k === profile.length - 1);
    ringIsPole.push(pole);
    if (pole) {
      pos.push(c.x, c.y, c.z);
      continue;
    }
    for (let j = 0; j < radial; j++) {
      const ang = (j / radial) * Math.PI * 2 + (opts.twist ?? 0);
      const cv = Math.cos(ang) * r * sz, sw = Math.sin(ang) * r * sx;
      pos.push(c.x + v.x * cv + w.x * sw, c.y + v.y * cv + w.y * sw, c.z + v.z * cv + w.z * sw);
    }
  }
  for (let k = 0; k < profile.length - 1; k++) {
    const A = ringStart[k], B = ringStart[k + 1];
    const pa = ringIsPole[k], pb = ringIsPole[k + 1];
    for (let j = 0; j < radial; j++) {
      const j1 = (j + 1) % radial;
      if (pa && pb) continue;
      if (pa) idx.push(A, B + j1, B + j);
      else if (pb) idx.push(A + j, A + j1, B);
      else idx.push(A + j, A + j1, B + j, A + j1, B + j1, B + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  fixWinding(g, a, u);
  g.computeVertexNormals();
  return g;
}

/** Ensure triangles face away from the axis (flip the index if the majority faces inwards). */
function fixWinding(g: THREE.BufferGeometry, a: THREE.Vector3, u: THREE.Vector3): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const index = g.getIndex()!;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const n = new THREE.Vector3(), c = new THREE.Vector3(), r = new THREE.Vector3();
  let score = 0;
  const step = Math.max(1, Math.floor(index.count / 3 / 64));
  for (let f = 0; f < index.count / 3; f += step) {
    A.fromBufferAttribute(p, index.getX(f * 3));
    B.fromBufferAttribute(p, index.getX(f * 3 + 1));
    C.fromBufferAttribute(p, index.getX(f * 3 + 2));
    n.subVectors(B, A).cross(C.clone().sub(A));
    c.copy(A).add(B).add(C).divideScalar(3);
    r.copy(c).sub(a);
    r.addScaledVector(u, -r.dot(u));
    score += Math.sign(n.dot(r));
  }
  if (score < 0) {
    const arr = index.array as ArrayLike<number> & { [i: number]: number };
    for (let i = 0; i < index.count; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  }
}

/** Capsule-like profile from a (t = 0) to b (t = L): ball ends of radius ra / rb. */
export function capsuleProfile(L: number, ra: number, rb: number, capRings = 6, bodyRings = 6): Prof {
  const out: Prof = [];
  for (let k = 0; k <= capRings; k++) {
    const ph = (k / capRings) * (Math.PI / 2);
    out.push([ra * Math.sin(ph), -ra * Math.cos(ph)]);
  }
  for (let k = 1; k < bodyRings; k++) {
    const t = k / bodyRings;
    out.push([ra + (rb - ra) * t, L * t]);
  }
  for (let k = capRings; k >= 0; k--) {
    const ph = (k / capRings) * (Math.PI / 2);
    out.push([rb * Math.sin(ph), L + rb * Math.cos(ph)]);
  }
  return out;
}

/** Keep the part of a profile with t in [t0, t1] (interpolating the cut rings). */
export function clipProfile(prof: Prof, t0: number, t1: number): Prof {
  const out: Prof = [];
  const lerp = (p: [number, number], q: [number, number], t: number): [number, number] => {
    const f = (t - p[1]) / (q[1] - p[1]);
    return [p[0] + (q[0] - p[0]) * f, t];
  };
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i];
    const inside = p[1] >= t0 && p[1] <= t1;
    if (i > 0) {
      const q = prof[i - 1];
      for (const cut of [t0, t1]) {
        if ((q[1] - cut) * (p[1] - cut) < 0) out.push(lerp(q, p, cut));
      }
    }
    if (inside) out.push([p[0], p[1]]);
  }
  return out;
}

/** Inflate a profile's radius by `off` (open ends stay open). */
export function inflate(prof: Prof, off: number, poleScale = 1): Prof {
  return prof.map(([r, t], i) => {
    const pole = r < 1e-6 && (i === 0 || i === prof.length - 1);
    return [pole ? 0 : r + off, t + (pole ? (i === 0 ? -off : off) * poleScale : 0)] as [number, number];
  });
}

/**
 * Band of the torso surface between heights y0 and y1, pushed out by `off` (+ optional flare(y)).
 * theta range (radians from +z towards +x) for partial panels (apron, bib), else the full ring.
 */
export function torsoBand(shape: TorsoShape, y0: number, y1: number, off: number, opts: {
  theta0?: number;
  theta1?: number;
  rings?: number;
  radial?: number;
  flare?: (y: number) => number;
} = {}): THREE.BufferGeometry {
  const s0 = shape.yToS(y0), s1 = shape.yToS(y1);
  const full = opts.theta0 === undefined;
  const th0 = opts.theta0 ?? 0, th1 = opts.theta1 ?? Math.PI * 2;
  const radial = opts.radial ?? (full ? 40 : Math.max(6, Math.round(40 * (th1 - th0) / (Math.PI * 2))));
  const rings = opts.rings ?? Math.max(3, Math.round((s1 - s0) * 40));
  const cols = full ? radial : radial + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const poleBottom = s0 <= 1e-4 && full, poleTop = s1 >= 1 - 1e-4 && full;
  const start: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = s0 + ((s1 - s0) * i) / rings;
    start.push(pos.length / 3);
    const pole = (i === 0 && poleBottom) || (i === rings && poleTop);
    for (let j = 0; j < (pole ? 1 : cols); j++) {
      const th = th0 + ((th1 - th0) * j) / radial;
      shape.rawPoint(s, th, P);
      shape.normal(s, th, N);
      const o = off + (opts.flare ? opts.flare(P.y) : 0);
      if (pole) pos.push(0, P.y + (i === 0 ? -o : o), P.z);
      else pos.push(P.x + N.x * o, P.y + N.y * o, P.z + N.z * o);
    }
  }
  // A + j -> A + j1 runs along +theta, A + j -> B + j along +s: cross(dtheta, ds) is outward
  for (let i = 0; i < rings; i++) {
    const A = start[i], B = start[i + 1];
    for (let j = 0; j < (full ? cols : cols - 1); j++) {
      const j1 = full ? (j + 1) % cols : j + 1;
      if (i === 0 && poleBottom) idx.push(A, B + j1, B + j);
      else if (i === rings - 1 && poleTop) idx.push(A + j, A + j1, B);
      else idx.push(A + j, A + j1, B + j, A + j1, B + j1, B + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tube following the torso cross-section at height y (hems, collars, belts, necklace path). */
export function torsoRing(shape: TorsoShape, y: number, off: number, tubeR: number, opts: { theta0?: number; theta1?: number; radial?: number; tubeSeg?: number; flatten?: number } = {}): THREE.BufferGeometry {
  const full = opts.theta0 === undefined;
  const th0 = opts.theta0 ?? 0, th1 = opts.theta1 ?? Math.PI * 2;
  const radial = opts.radial ?? 40;
  const seg = opts.tubeSeg ?? 6;
  const flatten = opts.flatten ?? 1; // < 1 squashes the tube vertically (belt)
  const cols = full ? radial : radial + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(), N = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  for (let j = 0; j < cols; j++) {
    const th = th0 + ((th1 - th0) * j) / radial;
    shape.pointAtY(y, th, off, P);
    shape.normalAtY(y, th, N);
    const nh = new THREE.Vector3(N.x, 0, N.z).normalize();
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const c = Math.cos(a) * tubeR, s = Math.sin(a) * tubeR * flatten;
      pos.push(P.x + nh.x * c + up.x * s, P.y + up.y * s, P.z + nh.z * c + up.z * s);
    }
  }
  for (let j = 0; j < (full ? cols : cols - 1); j++) {
    const j1 = full ? (j + 1) % cols : j + 1;
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      const a = j * seg + k, b = j * seg + k1, c = j1 * seg + k, d = j1 * seg + k1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  ensureOutward(g, new THREE.Vector3(0, y, 0));
  return g;
}

/** Flip the index of a closed-ish shape so its normals point away from `centre` on average. */
export function ensureOutward(g: THREE.BufferGeometry, centre: THREE.Vector3): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  let score = 0;
  for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 200))) {
    score += (p.getX(i) - centre.x) * n.getX(i) + (p.getY(i) - centre.y) * n.getY(i) + (p.getZ(i) - centre.z) * n.getZ(i);
  }
  if (score >= 0) return;
  const index = g.getIndex();
  if (index) {
    const arr = index.array as unknown as number[];
    for (let i = 0; i < index.count; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  n.needsUpdate = true;
}

/** Indexed sphere (ellipsoid via scale) at c. */
export function ellipsoid(c: THREE.Vector3, rx: number, ry: number, rz: number, w = 16, h = 12): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.deleteAttribute('uv');
  const m = new THREE.Matrix4().makeScale(rx, ry, rz).setPosition(c);
  g.applyMatrix4(m);
  return mergeSeams(g);
}

/** Weld coincident vertices (sphere/lathe seams) so normals are smooth. */
export function mergeSeams(g: THREE.BufferGeometry, tol = 1e-5): THREE.BufferGeometry {
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const map = new Map<string, number>();
  const remap = new Int32Array(p.count);
  const pos: number[] = [];
  const q = 1 / tol;
  for (let i = 0; i < p.count; i++) {
    const key = `${Math.round(p.getX(i) * q)},${Math.round(p.getY(i) * q)},${Math.round(p.getZ(i) * q)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = pos.length / 3;
      map.set(key, j);
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
    }
    remap[i] = j;
  }
  const idxOld = g.getIndex();
  const idx: number[] = [];
  const count = idxOld ? idxOld.count : p.count;
  for (let f = 0; f < count; f += 3) {
    const a = remap[idxOld ? idxOld.getX(f) : f], b = remap[idxOld ? idxOld.getX(f + 1) : f + 1], c = remap[idxOld ? idxOld.getX(f + 2) : f + 2];
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  g.dispose();
  return out;
}

/** Deform every vertex with f (in place) and recompute normals. */
export function deform(g: THREE.BufferGeometry, f: (v: THREE.Vector3) => void): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    f(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Matrix helper: translate + Euler rotation (XYZ) + uniform/non-uniform scale. */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'XYZ')),
    new THREE.Vector3(sx, sy, sz),
  );
}

/**
 * Generic parametric surface: f(u, v) for u in [0,1] (around, columns) and v in [0,1] (rows).
 * wrapU joins the last column to the first (closed ring). Normals: computed + oriented away
 * from `inside` when given.
 */
export function paramSurface(nu: number, nv: number, f: (u: number, v: number, out: THREE.Vector3) => void, wrapU: boolean, inside?: THREE.Vector3): THREE.BufferGeometry {
  const cols = wrapU ? nu : nu + 1;
  const pos: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i < cols; i++) {
      f(i / nu, j / nv, P);
      pos.push(P.x, P.y, P.z);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const i1 = wrapU ? (i + 1) % cols : i + 1;
      const a = j * cols + i, b = j * cols + i1, c = (j + 1) * cols + i, d = (j + 1) * cols + i1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const merged = mergeSeams(g, 1e-6);
  if (inside) ensureOutward(merged, inside);
  return merged;
}

/** Torus ring around an axis (hems/cuffs on limbs). */
export function axisRing(centre: THREE.Vector3, axis: THREE.Vector3, radius: number, tube: number, seg = 16, tubeSeg = 6): THREE.BufferGeometry {
  const g = new THREE.TorusGeometry(radius, tube, tubeSeg, seg);
  g.deleteAttribute('uv');
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(centre, q, new THREE.Vector3(1, 1, 1)));
  return mergeSeams(g);
}
