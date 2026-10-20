// Dev scene for the materials module: a canal street in the spirit of Alkmaar's Verdronkenoord /
// Oudegracht, built in code with the SAME vertex attribute conventions as the real BAG/OSM data
// (ARCHITECTURE 4.1-4.3): a row of attached canal houses (gables, cornices, a modern infill),
// sidewalk + curb, klinker street, parking strip, quay + water, a brick arch bridge with railings,
// an asphalt road with red cycle lane + markings, a setts square, grass and backdrop blocks.
//
//   ?scene=dev-materials[&view=street|canal|bridge|aerial|facade|far|night][&cam=..&look=..]
import * as THREE from 'three';
import earcut from 'earcut';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { MaterialClass, SceneEntry } from '../contracts';
import { LAYER_REFLECT, WATER_LEVEL } from '../config';
import { setupDevCamera } from '../dev/devCamera';
import { createMaterialLibrary } from '../world/materials';

interface Attr { seed: number; kind: number; age: number; floorHint: number }

/** Accumulates triangles per material with position/normal/uv/uv1/color(vec4). */
class Builder {
  private readonly data = new Map<MaterialClass, { p: number[]; n: number[]; uv: number[]; uv1: number[]; c: number[] }>();

  private bucket(m: MaterialClass) {
    let b = this.data.get(m);
    if (!b) { b = { p: [], n: [], uv: [], uv1: [], c: [] }; this.data.set(m, b); }
    return b;
  }

  tri(m: MaterialClass, pts: THREE.Vector3[], uvs: [number, number][], normal: THREE.Vector3, uv1: [number, number] | [number, number][] = [0, 0], attr?: Attr): void {
    const b = this.bucket(m);
    // enforce CCW winding seen from the normal side
    const e1 = pts[1].clone().sub(pts[0]);
    const e2 = pts[2].clone().sub(pts[0]);
    const order = e1.cross(e2).dot(normal) >= 0 ? [0, 1, 2] : [0, 2, 1];
    for (const i of order) {
      b.p.push(pts[i].x, pts[i].y, pts[i].z);
      b.n.push(normal.x, normal.y, normal.z);
      b.uv.push(uvs[i][0], uvs[i][1]);
      const q1 = (Array.isArray(uv1[0]) ? (uv1 as [number, number][])[i] : uv1) as [number, number];
      b.uv1.push(q1[0], q1[1]);
      if (attr) b.c.push(attr.seed, attr.kind, attr.age, attr.floorHint);
      else b.c.push(0, 0, 0, 0);
    }
  }

  /** Vertical polygon given in (u, y) coordinates along the horizontal direction `dir` from `origin`. */
  wall(m: MaterialClass, outline: [number, number][], origin: THREE.Vector3, dir: THREE.Vector3, attr?: Attr, eave?: number): void {
    const normal = new THREE.Vector3(-dir.z, 0, dir.x); // = dir x up: u increases to the viewer's right
    const flat = outline.flat();
    const idx = earcut(flat);
    let minU = Infinity; let maxU = -Infinity;
    for (const [u] of outline) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); }
    const W = maxU - minU;
    const ev = eave ?? Math.min(...outline.filter(([, y]) => y > 0.5).map(([, y]) => y));
    for (let i = 0; i < idx.length; i += 3) {
      const pts: THREE.Vector3[] = [];
      const uvs: [number, number][] = [];
      for (let k = 0; k < 3; k++) {
        const [u, y] = outline[idx[i + k]];
        pts.push(origin.clone().addScaledVector(dir, u).setY(origin.y + y));
        uvs.push([u - minU, origin.y + y]);
      }
      this.tri(m, pts, uvs, normal, [W, ev], attr);
    }
  }

  /** Planar quad (p0..p3 in order), uv = world (x, z) for horizontal, given explicitly otherwise. */
  /** uv1s: optional per-corner TEXCOORD_1 (roofs: metres along the eave, metres up the slope). */
  quad(m: MaterialClass, p: THREE.Vector3[], uvs?: [number, number][], attr?: Attr, uv1s?: [number, number][]): void {
    const n = p[1].clone().sub(p[0]).cross(p[3].clone().sub(p[0])).normalize();
    if (n.y < -0.01) n.negate();
    const uv = uvs ?? p.map((q) => [q.x, q.z] as [number, number]);
    this.tri(m, [p[0], p[1], p[2]], [uv[0], uv[1], uv[2]], n, uv1s ? [uv1s[0], uv1s[1], uv1s[2]] : [0, 0], attr);
    this.tri(m, [p[0], p[2], p[3]], [uv[0], uv[2], uv[3]], n, uv1s ? [uv1s[0], uv1s[2], uv1s[3]] : [0, 0], attr);
  }

  rectXZ(m: MaterialClass, x0: number, z0: number, x1: number, z1: number, y: number): void {
    this.quad(m, [new THREE.Vector3(x0, y, z0), new THREE.Vector3(x1, y, z0), new THREE.Vector3(x1, y, z1), new THREE.Vector3(x0, y, z1)]);
  }

  /** Vertical rectangle along x at z (normal +z if facing > 0) from y0 to y1, uv = (x, y). */
  faceX(m: MaterialClass, x0: number, x1: number, z: number, y0: number, y1: number, facing: 1 | -1): void {
    const dir = new THREE.Vector3(facing > 0 ? 1 : -1, 0, 0);
    const origin = new THREE.Vector3(facing > 0 ? x0 : x1, 0, z);
    this.wall(m, [[0, y0], [x1 - x0, y0], [x1 - x0, y1], [0, y1]], origin, dir);
  }

  /** Box (for railings, posts). uv = metric along the longest axis. */
  box(m: MaterialClass, c: THREE.Vector3, s: THREE.Vector3): void {
    const h = s.clone().multiplyScalar(0.5);
    const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
    ];
    for (const [n, a, b] of faces) {
      const ext = (v: THREE.Vector3) => Math.abs(v.x) * h.x + Math.abs(v.y) * h.y + Math.abs(v.z) * h.z;
      const center = c.clone().addScaledVector(n, ext(n));
      const ea = ext(a); const eb = ext(b);
      const pts = [
        center.clone().addScaledVector(a, -ea).addScaledVector(b, -eb),
        center.clone().addScaledVector(a, ea).addScaledVector(b, -eb),
        center.clone().addScaledVector(a, ea).addScaledVector(b, eb),
        center.clone().addScaledVector(a, -ea).addScaledVector(b, eb),
      ];
      const uvs: [number, number][] = [[-ea, -eb], [ea, -eb], [ea, eb], [-ea, eb]];
      this.tri(m, [pts[0], pts[1], pts[2]], [uvs[0], uvs[1], uvs[2]], n);
      this.tri(m, [pts[0], pts[2], pts[3]], [uvs[0], uvs[2], uvs[3]], n);
    }
  }

  build(): Map<MaterialClass, THREE.BufferGeometry> {
    const out = new Map<MaterialClass, THREE.BufferGeometry>();
    for (const [m, b] of this.data) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(b.uv1, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 4));
      out.set(m, mergeGeometries([g]) ?? g);
    }
    return out;
  }
}

type Gable = 'trap' | 'tuit' | 'hals' | 'lijst' | 'flat';
interface House { w: number; floors: number; floorH: number; gable: Gable; age: number; seed: number }

/** Front outline (u, y) of a house facade including the gable. Returns [outline, eave, ridge]. */
function frontOutline(h: House): [[number, number][], number, number] {
  const eave = 0.6 + h.floors * h.floorH + (h.age < 0.2 ? 0.5 : 0);
  const w = h.w;
  const base: [number, number][] = [[0, -0.3], [w, -0.3]];
  if (h.gable === 'lijst' || h.gable === 'flat') {
    return [[...base, [w, eave], [0, eave]], eave, eave];
  }
  const rise = (w / 2) * Math.tan(THREE.MathUtils.degToRad(57));
  const ridge = eave + rise;
  if (h.gable === 'tuit') {
    return [[...base, [w, eave], [w / 2 + 0.35, ridge - 0.5], [w / 2 + 0.35, ridge + 0.3], [w / 2 - 0.35, ridge + 0.3], [w / 2 - 0.35, ridge - 0.5], [0, eave]], eave, ridge];
  }
  if (h.gable === 'trap') {
    // stepped gable (trapgevel): 3 steps each side + a narrow top
    const steps = 3;
    const topW = Math.min(1.2, w * 0.25);
    const stepW = (w - topW) / (2 * steps);
    const stepH = rise / (steps + 0.6);
    const pts: [number, number][] = [...base, [w, eave]];
    for (let i = 0; i < steps; i++) {
      const x = w - i * stepW;
      const y = eave + (i + 1) * stepH;
      pts.push([x, y], [x - stepW, y]);
    }
    const top = eave + (steps + 0.9) * stepH;
    const xr = w - steps * stepW;
    pts.push([xr, top], [w - xr, top]);
    for (let i = steps - 1; i >= 0; i--) {
      const x = i * stepW;
      const y = eave + (i + 1) * stepH;
      pts.push([x + stepW, y], [x, y]);
    }
    pts.push([0, eave]);
    return [pts, eave, ridge];
  }
  // halsgevel: shoulders then a vertical neck with a small pediment
  const neck = Math.min(2.2, w * 0.5);
  const sh = eave + 1.3;
  return [[...base, [w, eave], [w / 2 + neck / 2 + 0.6, sh - 0.3], [w / 2 + neck / 2, sh], [w / 2 + neck / 2, ridge - 0.4],
    [w / 2, ridge + 0.4], [w / 2 - neck / 2, ridge - 0.4], [w / 2 - neck / 2, sh], [w / 2 - neck / 2 - 0.6, sh - 0.3], [0, eave]], eave, ridge];
}

function addHouseRow(B: Builder, houses: House[], x0: number, zFront: number, depth: number, facing: 1 | -1): void {
  let x = x0;
  for (const h of houses) {
    const attr: Attr = { seed: h.seed, kind: 0, age: h.age, floorHint: (h.floorH - 2.5) / 2 };
    const party: Attr = { ...attr, kind: 0.5 };
    const [outline, eave, ridge] = frontOutline(h);
    const zBack = zFront - facing * depth;
    const xa = x; const xb = x + h.w;
    // front facade (normal towards the street: +z if facing = 1)
    const dirF = new THREE.Vector3(facing, 0, 0);
    B.wall('wall', outline, new THREE.Vector3(facing > 0 ? xa : xb, 0, zFront), dirF, attr, eave);
    // back facade (simple: same gable outline)
    B.wall('wall', outline, new THREE.Vector3(facing > 0 ? xb : xa, 0, zBack), dirF.clone().negate(), attr, eave);
    // party side walls up to the eave (roof covers the rest)
    const sideOutline: [number, number][] = [[0, -0.3], [depth, -0.3], [depth, eave], [0, eave]];
    const zA = Math.min(zFront, zBack); const zB = Math.max(zFront, zBack);
    B.wall('wall', h.gable === 'lijst' ? [[0, -0.3], [depth, -0.3], [depth, eave], [depth / 2, eave + depth / 2 * 0.84], [0, eave]] : sideOutline,
      new THREE.Vector3(xa, 0, zA), new THREE.Vector3(0, 0, 1), party, eave);
    B.wall('wall', h.gable === 'lijst' ? [[0, -0.3], [depth, -0.3], [depth, eave], [depth / 2, eave + depth / 2 * 0.84], [0, eave]] : sideOutline,
      new THREE.Vector3(xb, 0, zB), new THREE.Vector3(0, 0, -1), party, eave);
    // roofs (uv = world xz, colour attribute carries the seed)
    const V = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz);
    if (h.gable === 'flat') {
      B.quad('roof_flat', [V(xa, eave, zA), V(xb, eave, zA), V(xb, eave, zB), V(xa, eave, zB)], undefined, attr);
    } else if (h.gable === 'lijst') {
      const zm = (zA + zB) / 2;
      const rr = eave + (depth / 2) * 0.84;
      const w = xb - xa; const L = Math.hypot(zB - zm, rr - eave);
      B.quad('roof_slanted', [V(xa, eave, zB), V(xb, eave, zB), V(xb, rr, zm), V(xa, rr, zm)], undefined, attr, [[0, 0], [w, 0], [w, L], [0, L]]);
      B.quad('roof_slanted', [V(xa, rr, zm), V(xb, rr, zm), V(xb, eave, zA), V(xa, eave, zA)], undefined, attr, [[0, L], [w, L], [w, 0], [0, 0]]);
    } else {
      const xm = (xa + xb) / 2;
      const d = zB - zA; const L = Math.hypot(xm - xa, ridge - eave);
      B.quad('roof_slanted', [V(xa, eave, zA), V(xm, ridge, zA), V(xm, ridge, zB), V(xa, eave, zB)], undefined, attr, [[0, 0], [0, L], [d, L], [d, 0]]);
      B.quad('roof_slanted', [V(xm, ridge, zA), V(xb, eave, zA), V(xb, eave, zB), V(xm, ridge, zB)], undefined, attr, [[0, L], [0, 0], [d, 0], [d, L]]);
    }
    x = xb;
  }
}

/** Fallback sky + environment when the engine has not (yet) provided one. */
function ensureEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, sunDir: THREE.Vector3): void {
  if (scene.environment) return;
  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(sunDir).multiplyScalar(1000);
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  sky.layers.enable(LAYER_REFLECT);
  scene.add(sky);
  scene.background = null;
  pmrem.dispose();
}

const VIEWS: Record<string, [number[], number[]]> = {
  street: [[44, 1.7, -7.5], [8, 3.5, -10.5]],
  facade: [[18, 1.7, -6.0], [18, 4.5, -12]],
  canal: [[46, 1.7, -4.2], [6, 0.0, 6.0]],
  bridge: [[33, 2.0, 4.8], [-5, 4.0, -8]],
  aerial: [[60, 45, 40], [22, 0, 0]],
  far: [[110, 12, 6], [20, 6, -12]],
  road: [[60, 1.4, 17], [10, 1.5, 19]],
  square: [[62, 1.7, -2], [70, 2.0, -10]],
  roofs: [[22, 22, -2], [16, 13, -18]],
  mirror: [[26, 0.4, 12.4], [24, 3.0, -12]],
  distant: [[150, 2.5, -7.0], [10, 6.0, -12]],
  plaster: [[21.5, 1.7, -7.0], [21.5, 4.0, -12]],
  south: [[14, 1.7, 16.5], [24, 4.5, 23]],
  props: [[64, 1.7, -9.5], [67, 0.6, -14.5]],
  high: [[20, 160, 120], [20, 0, 0]],
  southclose: [[19, 1.7, 20.0], [16, 3.0, 23]],
  quay: [[20, 0.6, 12.0], [26, -1.0, -3.2]],
};

const devMaterials: SceneEntry = async (engine, params) => {
  const t0 = performance.now();
  await engine.env.ready;
  ensureEnvironment(engine.renderer, engine.scene, engine.env.sunDirection);
  if (!engine.scene.fog) engine.scene.fog = new THREE.Fog(0xb8c4cc, 120, 1400);
  const lib = await createMaterialLibrary(engine);
  const B = new Builder();

  // ------------------------------------------------------------ canal houses (north side)
  const zF = -12;
  const row: House[] = [
    { w: 5.2, floors: 3, floorH: 3.2, gable: 'trap', age: 0.0, seed: 0.11 },
    { w: 4.1, floors: 3, floorH: 3.1, gable: 'hals', age: 0.0, seed: 0.37 },
    { w: 6.8, floors: 3, floorH: 3.3, gable: 'lijst', age: 0.0, seed: 0.58 },
    { w: 3.6, floors: 2, floorH: 3.0, gable: 'tuit', age: 0.0, seed: 0.83 },
    { w: 5.6, floors: 4, floorH: 3.1, gable: 'lijst', age: 0.33, seed: 0.24 },
    { w: 4.6, floors: 3, floorH: 3.0, gable: 'trap', age: 0.0, seed: 0.69 },
    { w: 7.2, floors: 3, floorH: 2.9, gable: 'flat', age: 0.66, seed: 0.47 },
    { w: 4.3, floors: 2, floorH: 3.2, gable: 'hals', age: 0.33, seed: 0.92 },
    { w: 6.0, floors: 4, floorH: 2.9, gable: 'flat', age: 1.0, seed: 0.05 },
    { w: 5.0, floors: 3, floorH: 3.2, gable: 'tuit', age: 0.0, seed: 0.31 },
  ];
  addHouseRow(B, row, 0, zF, 12, 1);

  // ------------------------------------------------------------ houses on the south side (facing north)
  const rowS: House[] = [
    { w: 6.0, floors: 3, floorH: 3.0, gable: 'lijst', age: 0.33, seed: 0.15 },
    { w: 4.8, floors: 3, floorH: 3.2, gable: 'trap', age: 0.0, seed: 0.52 },
    { w: 8.0, floors: 4, floorH: 2.9, gable: 'flat', age: 0.66, seed: 0.74 },
    { w: 5.4, floors: 2, floorH: 3.1, gable: 'hals', age: 0.0, seed: 0.28 },
    { w: 6.5, floors: 3, floorH: 3.0, gable: 'lijst', age: 0.0, seed: 0.63 },
    { w: 9.0, floors: 3, floorH: 3.0, gable: 'flat', age: 1.0, seed: 0.88 },
  ];
  addHouseRow(B, rowS, 0, 23, 12, -1);

  const X0 = -40; const X1 = 200;
  // ------------------------------------------------------------ north street: sidewalk, curb, klinkers, parking
  B.rectXZ('sidewalk', X0, -12, X1, -10, 0.12);
  B.faceX('curb', X0, X1, -10, 0, 0.12, 1);
  B.rectXZ('klinkers', X0, -10, X1, -5, 0);
  B.rectXZ('parking', X0, -5, X1, -3.5, 0);
  // quay cap + quay wall (north)
  B.rectXZ('quay_cap', X0, -3.5, X1, -3.2, 0.05);
  B.faceX('quay_cap', X0, X1, -3.2, 0, 0.05, 1);
  B.faceX('quay', X0, X1, -3.2, -3.5, 0, 1);
  // canal bed + water
  B.rectXZ('canal_bed', X0, -3.2, X1, 12.8, -3.5);
  // south quay
  B.faceX('quay', X0, X1, 12.8, -3.5, 0, -1);
  B.faceX('quay_cap', X0, X1, 12.8, 0, 0.05, -1);
  B.rectXZ('quay_cap', X0, 12.8, X1, 13.1, 0.05);
  // south: bike lane, road with markings, sidewalk
  B.rectXZ('bikelane', X0, 13.1, X1, 15.0, 0);
  B.rectXZ('asphalt', X0, 15.0, X1, 21.0, 0);
  B.faceX('curb', X0, X1, 21, 0, 0.12, -1);
  B.rectXZ('sidewalk', X0, 21, X1, 23, 0.12);
  for (let x = X0; x < X1; x += 9) B.rectXZ('road_marking', x, 17.95, x + 3, 18.05, 0.01); // dashed centre line
  B.rectXZ('road_marking', X0, 15.1, X1, 15.2, 0.01); // edge line next to the cycle lane
  for (let i = 0; i < 6; i++) B.rectXZ('road_marking', 50 + i * 0.9 - 0.25, 15.3, 50 + i * 0.9 + 0.25, 20.8, 0.01); // zebra

  // ------------------------------------------------------------ brick arch bridge over the canal
  const bx0 = 30; const bx1 = 37;
  const span = [-3.2, 12.8];
  B.rectXZ('bridge_deck', bx0, span[0], bx1, span[1], 0.06);
  const archOutline = (): [number, number][] => {
    const pts: [number, number][] = [[0, -3.5], [2.2, -3.5]];
    const a0 = 2.2; const a1 = 13.8; const am = (a0 + a1) / 2; const ar = (a1 - a0) / 2;
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI - (i / 16) * Math.PI;
      pts.push([am + Math.cos(t) * ar, -1.9 + Math.sin(t) * 1.45]);
    }
    pts.push([a1, -3.5], [16, -3.5], [16, 0.06], [0, 0.06]);
    return pts;
  };
  B.wall('bridge_side', archOutline(), new THREE.Vector3(bx0, 0, span[0]), new THREE.Vector3(0, 0, 1));
  B.wall('bridge_side', archOutline(), new THREE.Vector3(bx1, 0, span[1]), new THREE.Vector3(0, 0, -1));
  // arch intrados (barrel vault underside)
  {
    const a0 = span[0] + 2.2; const ar = 5.8; const am = a0 + ar;
    for (let i = 0; i < 16; i++) {
      const t0 = Math.PI - (i / 16) * Math.PI; const t1 = Math.PI - ((i + 1) / 16) * Math.PI;
      const z0 = am + Math.cos(t0) * ar; const y0 = -1.9 + Math.sin(t0) * 1.45;
      const z1 = am + Math.cos(t1) * ar; const y1 = -1.9 + Math.sin(t1) * 1.45;
      const p = [new THREE.Vector3(bx0, y0, z0), new THREE.Vector3(bx1, y0, z0), new THREE.Vector3(bx1, y1, z1), new THREE.Vector3(bx0, y1, z1)];
      const n = new THREE.Vector3(0, -Math.sin((t0 + t1) / 2), -Math.cos((t0 + t1) / 2));
      B.tri('bridge_side', [p[0], p[1], p[2]], [[bx0, z0], [bx1, z0], [bx1, z1]], n);
      B.tri('bridge_side', [p[0], p[2], p[3]], [[bx0, z0], [bx1, z1], [bx0, z1]], n);
    }
  }
  // railings: posts every 1.6 m + top and mid rails (dark green painted steel)
  for (const xr of [bx0 + 0.1, bx1 - 0.1]) {
    for (let z = span[0]; z <= span[1] + 0.01; z += 1.6) B.box('bridge_rail', new THREE.Vector3(xr, 0.6, z), new THREE.Vector3(0.07, 1.1, 0.07));
    B.box('bridge_rail', new THREE.Vector3(xr, 1.13, (span[0] + span[1]) / 2), new THREE.Vector3(0.09, 0.05, span[1] - span[0]));
    B.box('bridge_rail', new THREE.Vector3(xr, 0.55, (span[0] + span[1]) / 2), new THREE.Vector3(0.04, 0.03, span[1] - span[0]));
  }

  // ------------------------------------------------------------ square with setts, grass, ground
  B.rectXZ('square', 56, -26, 80, -12, 0.0);
  B.rectXZ('grass', 80, -26, X1, -12, 0.02);
  B.rectXZ('ground', -40, -26, 0, -12, 0.0);

  // ------------------------------------------------------------ backdrop blocks far away (LoD1.2 style)
  for (let i = 0; i < 14; i++) {
    const bx = -160 + i * 28; const bz = -120 - (i % 3) * 30;
    const w = 20 + (i * 7) % 10; const d = 14; const hgt = 9 + (i * 5) % 12;
    const attr: Attr = { seed: (i * 0.137) % 1, kind: 0, age: 0.66, floorHint: 0.2 };
    B.wall('backdrop', [[0, 0], [w, 0], [w, hgt], [0, hgt]], new THREE.Vector3(bx, 0, bz), new THREE.Vector3(1, 0, 0), attr);
    B.quad('backdrop', [new THREE.Vector3(bx, hgt, bz - d), new THREE.Vector3(bx + w, hgt, bz - d), new THREE.Vector3(bx + w, hgt, bz), new THREE.Vector3(bx, hgt, bz)], undefined, attr);
  }
  B.rectXZ('ground', -200, -200, 200, -26, -0.01);
  B.rectXZ('ground', -200, 23, 200, 200, 0.11);

  // ------------------------------------------------------------ meshes
  const root = new THREE.Group();
  root.name = 'dev-materials';
  for (const [m, g] of B.build()) {
    // ?simple=1: plain materials, to measure the cost of the library shaders
    const simple = params.get('simple') === '1';
    const mesh = new THREE.Mesh(g, simple ? new THREE.MeshStandardMaterial({ color: 0x996655, roughness: 0.8 }) : lib.get(m));
    mesh.name = m;
    mesh.receiveShadow = true;
    mesh.layers.enable(LAYER_REFLECT); // big static geometry: visible in the planar water reflection
    mesh.castShadow = m === 'wall' || m === 'roof_slanted' || m === 'roof_flat' || m === 'bridge_rail' || m === 'bridge_side';
    root.add(mesh);
  }
  const waterGeo = new THREE.PlaneGeometry(X1 - X0, 16, 1, 1).rotateX(-Math.PI / 2).translate((X0 + X1) / 2, WATER_LEVEL, 4.8);
  // uv = world xz (same as the OSM pipeline)
  const pos = waterGeo.getAttribute('position');
  const uv = waterGeo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
  root.add(lib.createWater(waterGeo));
  // props-style test objects using lib.pbr() (plain MeshStandardMaterial with the shared texture sets)
  const bench = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.45, 0.5), lib.pbr('wood', { repeat: [1.2, 0.3] }));
  bench.position.set(66, 0.225, -14);
  const block = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), lib.pbr('stone', { repeat: 0.6 }));
  block.position.set(69, 0.6, -15);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.0, 16), lib.pbr('metal_painted', { color: 0x3a1a14, roughness: 1 }));
  post.position.set(63, 0.5, -12.4);
  for (const m of [bench, block, post]) { m.castShadow = true; m.receiveShadow = true; root.add(m); }
  engine.scene.add(root);

  if (params.get('view') === 'night') lib.setNight(1);
  const view = VIEWS[params.get('view') ?? 'street'] ?? VIEWS.street;
  setupDevCamera(engine, params, { cam: new THREE.Vector3(...view[0]), look: new THREE.Vector3(...view[1]) });
  const dbg = (window.__debug ??= {});
  dbg.views = VIEWS;
  dbg.view = (name: string) => {
    const v = VIEWS[name];
    if (v) (dbg.setCam as (...a: number[]) => void)(...v[0], ...v[1]);
  };
  dbg.materials = lib;
  dbg.quality = (q: Record<string, unknown>) => engine.setQuality(q);
  engine.start();
  // let shaders compile before reporting ready
  engine.renderer.compile(engine.scene, engine.camera);
  console.info(`[dev-materials] ready in ${(performance.now() - t0).toFixed(0)} ms`);
  window.__ready = true;
};

export default devMaterials;
