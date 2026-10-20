// Parked Dutch bicycles: omafiets (step-through, twin lateral tubes), opafiets (diamond frame
// with a front carrier + crate), omafiets with pannier bags, and bakfietsen (cargo bikes).
// Model frame: +z forward, +x left, wheels touch y = 0. Instances lean ~7 degrees to the left on
// the kickstand. Frame / mudguards / chain guard are "paint" (instance colour), the rest fixed.
import * as THREE from 'three';
import type { PropsData } from '../../contracts';
import type { GroundFn } from './util/ground';
import { PropBatch, type BatchLod } from './util/batch';
import { MeshBuilder, beam, box, cylinder, extrude, mat, rod, sphere, sweep, torus, type Style } from './util/geom';
import { getFurnitureMaterial } from './street';
import { Rng, hash2 } from './util/rng';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const R = 0.352; // 28" wheel outer radius
const REAR = V(0, R, -0.56);
const FRONT = V(0, R, 0.57);

const PAINT: Style = { color: 0xffffff, rough: 0.38, metal: 0.35, paint: 1 };
const BLACK: Style = { color: 0x0c0c0d, rough: 0.55, metal: 0.2 };
const RUBBER: Style = { color: 0x111111, rough: 0.88, metal: 0 };
const CHROME: Style = { color: 0xb9bcbf, rough: 0.25, metal: 0.95 };
const STEEL: Style = { color: 0x8c9093, rough: 0.4, metal: 0.8 };
const LEATHER: Style = { color: 0x2a1b12, rough: 0.6, metal: 0 };

type Variant = 'oma' | 'opa' | 'tassen' | 'bakfiets';

function wheel(b: MeshBuilder, c: THREE.Vector3, r: number, lod: number, hubR = 0.03): void {
  const m = mat(c.x, c.y, c.z, 0, Math.PI / 2, 0); // torus in the YZ plane
  const tyreTube = r * 0.062;
  b.add(torus(r - tyreTube, tyreTube, lod === 0 ? 6 : lod === 1 ? 4 : 3, lod === 0 ? 36 : lod === 1 ? 18 : 10), m, RUBBER);
  if (lod <= 1) b.add(torus(r - tyreTube * 2.3, r * 0.03, lod === 0 ? 4 : 3, lod === 0 ? 32 : 16), m, CHROME);
  if (lod === 0) {
    // hub + spokes
    b.add(new THREE.CylinderGeometry(hubR, hubR, 0.1, 10), mat(c.x, c.y, c.z, 0, 0, Math.PI / 2), STEEL);
    const n = 32;
    const rimR = r - tyreTube * 2.6;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const side = i % 2 === 0 ? 1 : -1;
      // tangential lacing: spoke leaves the flange offset by an angle
      const a0 = a + side * 0.35;
      const p0 = V(c.x + side * 0.03, c.y + Math.sin(a0) * hubR, c.z + Math.cos(a0) * hubR);
      const p1 = V(c.x, c.y + Math.sin(a) * rimR, c.z + Math.cos(a) * rimR);
      b.add(rod(p0, p1, 0.0022, 3), null, CHROME);
    }
  } else if (lod === 1) {
    b.add(new THREE.CylinderGeometry(hubR, hubR, 0.1, 6), mat(c.x, c.y, c.z, 0, 0, Math.PI / 2), STEEL);
  }
}

/** Mudguard strip around a wheel from angle a0 to a1 (0 = forward, PI/2 = top, PI = rear). */
function mudguard(b: MeshBuilder, c: THREE.Vector3, rad: number, a0: number, a1: number, lod: number, style: Style): void {
  const steps = lod === 0 ? 20 : 8;
  const w = 0.03;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
  const colr = new THREE.Color(style.color);
  const prof = lod === 0 ? [[-w, -0.008], [-w * 0.5, 0.0], [w * 0.5, 0.0], [w, -0.008]] : [[-w, -0.006], [w, -0.006]];
  const np = prof.length;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const dy = Math.sin(a), dz = Math.cos(a);
    for (const [x, dr] of prof) {
      pos.push(c.x + x, c.y + dy * (rad + dr), c.z + dz * (rad + dr));
      const nx = x * 4;
      const l = Math.hypot(nx, 1);
      nor.push(nx / l, dy / l, dz / l);
      uv.push(x, a * rad);
      col.push(colr.r, colr.g, colr.b);
    }
  }
  for (let i = 0; i < steps; i++) {
    for (let k = 0; k < np - 1; k++) {
      const a = i * np + k, bq = a + 1, cq = a + np, d = cq + 1;
      // both faces (thin sheet)
      idx.push(a, cq, bq, bq, cq, d);
      idx.push(a, bq, cq, bq, d, cq);
    }
  }
  b.addRaw(pos, nor, uv, idx, col, style);
}

function buildBike(variant: Variant, lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const tr = lod === 0 ? 0.0165 : 0.019; // tube radius
  const rs = lod === 0 ? 6 : lod === 1 ? 4 : 3; // radial segments
  const tube = (pts: THREE.Vector3[], r = tr, style: Style = PAINT) => b.add(sweep(pts, r, rs), null, style);
  const isBak = variant === 'bakfiets';
  const front = isBak ? V(0, 0.255, 1.55) : FRONT;
  const rearW = REAR;
  const BB = V(0, 0.29, -0.06);
  const seatTop = V(0, 0.86, -0.22);
  const headTop = isBak ? V(0, 0.98, 0.4) : V(0, 0.98, 0.4);
  const headBot = V(0, 0.8, 0.45);

  // wheels
  wheel(b, rearW, R, lod, 0.045);
  wheel(b, front, isBak ? 0.255 : R, lod);

  if (lod === 2) {
    // far LOD: a few boxes for the frame and the saddle
    b.add(beam(BB, headTop, 0.04, 0.04), null, PAINT);
    b.add(beam(BB, seatTop, 0.04, 0.04), null, PAINT);
    b.add(beam(BB, rearW, 0.04, 0.04), null, PAINT);
    b.add(beam(headBot, front, 0.04, 0.04), null, PAINT);
    b.add(box(0.16, 0.05, 0.24), mat(0, 1.0, -0.27), LEATHER);
    b.add(beam(V(-0.27, 1.05, 0.2), V(0.27, 1.05, 0.2), 0.03, 0.03), null, BLACK);
    if (isBak) b.add(box(0.62, 0.42, 0.85), mat(0, 0.55, 0.95), PAINT);
    return b.build();
  }

  // ---- frame
  tube([headBot, headTop], tr * 1.5);
  tube([seatTop.clone().add(V(0, 0.02, -0.006)), BB], tr * 1.3);
  if (variant === 'opa') {
    tube([V(0, 0.95, 0.41), V(0, 0.87, -0.2)]);
    tube([V(0, 0.84, 0.44), V(0, 0.55, 0.2), BB], tr * 1.25);
  } else if (!isBak) {
    // step-through: curved main tube + twin lateral tubes to the rear axle
    tube([V(0, 0.9, 0.43), V(0, 0.62, 0.3), V(0, 0.38, 0.12), V(0, 0.3, 0.0), BB.clone().add(V(0, 0, 0.02))], tr * 1.4);
    for (const s of [-1, 1]) {
      tube([V(s * 0.012, 0.93, 0.42), V(s * 0.03, 0.66, 0.12), V(s * 0.045, 0.53, -0.2), V(s * 0.062, R + 0.03, -0.54)], tr * 0.75);
    }
  } else {
    // cargo bike: long low tube from the head tube forward to the front wheel
    tube([V(0, 0.9, 0.43), V(0, 0.5, 0.3), BB], tr * 1.4);
    for (const s of [-1, 1]) tube([V(s * 0.05, 0.48, 0.42), V(s * 0.05, 0.3, 0.6), V(s * 0.05, 0.28, 1.55)], tr * 1.2);
  }
  // chain stays and seat stays
  for (const s of [-1, 1]) {
    tube([BB.clone().add(V(s * 0.03, 0, 0)), V(s * 0.065, R, -0.56)], tr * 0.85);
    tube([seatTop.clone().add(V(s * 0.02, -0.03, 0)), V(s * 0.065, R + 0.01, -0.555)], tr * 0.75);
  }
  // fork + steering
  if (!isBak) {
    for (const s of [-1, 1]) tube([V(0, headBot.y, headBot.z), V(s * 0.045, 0.66, 0.49), V(s * 0.05, 0.5, 0.53), V(s * 0.05, R, 0.57)], tr * 0.9);
  } else {
    for (const s of [-1, 1]) tube([V(s * 0.045, 0.45, 1.48), V(s * 0.05, 0.255, 1.55)], tr * 0.9);
    // steering rod from the handlebar to the front fork
    b.add(rod(V(0, 0.45, 0.42), V(0, 0.45, 1.48), 0.008, 4), null, STEEL);
  }
  // seat post + saddle (sprung leather saddle)
  b.add(rod(seatTop, V(0, 1.0, -0.265), 0.0135, 6), null, CHROME);
  const saddle = new THREE.Shape();
  saddle.moveTo(0, 0.13);
  saddle.bezierCurveTo(0.03, 0.12, 0.035, 0.03, 0.06, -0.04);
  saddle.bezierCurveTo(0.1, -0.1, 0.11, -0.14, 0.0, -0.15);
  saddle.bezierCurveTo(-0.11, -0.14, -0.1, -0.1, -0.06, -0.04);
  saddle.bezierCurveTo(-0.035, 0.03, -0.03, 0.12, 0, 0.13);
  const sg = extrude(saddle, 0.05, lod === 0 ? 6 : 3, lod === 0 ? 0.012 : 0);
  // shape XY -> (x, z), extruded along y
  b.add(sg, mat(0, 1.035, -0.29, Math.PI / 2, 0, 0), LEATHER);
  if (lod === 0) {
    for (const s of [-1, 1]) b.add(cylinder(0.016, 0.016, 0.05, 6), mat(s * 0.05, 0.985, -0.37), CHROME);
  }
  // handlebar: swept back Dutch bar
  b.add(rod(headTop, V(0, 1.07, 0.39), 0.014, 6), null, CHROME);
  const bar = [V(-0.28, 1.05, 0.17), V(-0.22, 1.07, 0.3), V(-0.08, 1.08, 0.39), V(0, 1.08, 0.4), V(0.08, 1.08, 0.39), V(0.22, 1.07, 0.3), V(0.28, 1.05, 0.17)];
  b.add(sweep(bar, 0.011, rs), null, CHROME);
  for (const s of [-1, 1]) b.add(rod(V(s * 0.28, 1.05, 0.17), V(s * 0.3, 1.045, 0.07), 0.017, rs), null, LEATHER);
  if (lod === 0) {
    b.add(sphere(0.026, 8, 6), mat(0.2, 1.09, 0.31), CHROME); // bell
    // brake levers / roller brake cable hint
    b.add(rod(V(-0.2, 1.06, 0.31), V(-0.24, 1.0, 0.25), 0.005, 3), null, BLACK);
  }
  // mudguards
  const fc = front;
  mudguard(b, rearW, R + 0.03, THREE.MathUtils.degToRad(30), THREE.MathUtils.degToRad(195), lod, PAINT);
  mudguard(b, fc, (isBak ? 0.255 : R) + 0.03, THREE.MathUtils.degToRad(-25), THREE.MathUtils.degToRad(140), lod, PAINT);
  if (lod === 0) {
    // mudguard stays
    for (const s of [-1, 1]) b.add(rod(V(s * 0.06, R, -0.56), V(s * 0.03, R + 0.25, -0.86), 0.003, 3), null, STEEL);
    // rear reflector on the mudguard
    b.add(box(0.035, 0.05, 0.01), mat(0, 0.47, -0.93, -0.5, 0, 0), { color: 0xa0100c, rough: 0.3, emit: 0.4 });
  }
  // chain guard (closed "kettingkast") on the right side (-x)
  {
    const sh = new THREE.Shape();
    const r1 = 0.105, r2 = 0.062, L = 0.5;
    sh.absarc(0, 0, r1, Math.PI / 2, -Math.PI / 2, true);
    sh.lineTo(-L, -r2);
    sh.absarc(-L, 0, r2, -Math.PI / 2, Math.PI / 2, true);
    sh.lineTo(0, r1);
    const g = extrude(sh, 0.05, lod === 0 ? 10 : 4);
    // shape x -> -z (towards the rear), y -> y; extrusion along x
    b.add(g, mat(-0.085, BB.y + 0.02, BB.z, 0, -Math.PI / 2, 0), PAINT);
  }
  // cranks + pedals
  {
    const pr = V(-0.13, BB.y - 0.12, BB.z + 0.12);
    const pl = V(0.13, BB.y + 0.12, BB.z - 0.12);
    b.add(rod(V(-0.12, BB.y, BB.z), pr, 0.01, 4), null, STEEL);
    b.add(rod(V(0.12, BB.y, BB.z), pl, 0.01, 4), null, STEEL);
    b.add(box(0.1, 0.025, 0.06), mat(-0.18, pr.y, pr.z), BLACK);
    b.add(box(0.1, 0.025, 0.06), mat(0.18, pl.y, pl.z), BLACK);
  }
  // rear carrier
  if (!isBak) {
    for (const s of [-1, 1]) {
      tube([V(s * 0.07, 0.8, -0.2), V(s * 0.07, 0.82, -0.32), V(s * 0.07, 0.82, -0.8)], 0.008, BLACK);
      b.add(rod(V(s * 0.065, R + 0.01, -0.56), V(s * 0.07, 0.82, -0.7), 0.007, 4), null, BLACK);
    }
    const nSl = lod === 0 ? 4 : 2;
    for (let i = 0; i < nSl; i++) {
      const z = -0.36 - (i * 0.42) / (nSl - 1);
      b.add(rod(V(-0.07, 0.82, z), V(0.07, 0.82, z), 0.006, 3), null, BLACK);
    }
    if (lod === 0) {
      // rear light on the carrier
      b.add(box(0.07, 0.045, 0.03), mat(0, 0.81, -0.81), { color: 0x7a0c08, rough: 0.3, emit: 0.6 });
    }
  }
  // front light
  b.add(cylinder(0.024, 0.02, 0.07, lod === 0 ? 10 : 5), mat(0, 0.72, isBak ? 0.48 : 0.5, Math.PI / 2, 0, 0), CHROME);
  if (lod === 0) b.add(new THREE.CircleGeometry(0.022, 10), mat(0, 0.72, (isBak ? 0.48 : 0.5) + 0.036), { color: 0xfff6dd, rough: 0.1, emit: 0.8 });
  // kickstand (left side, foot touches the ground when leaning 7 deg to +x)
  if (!isBak) b.add(rod(V(0.05, 0.32, -0.42), V(0.2, 0.025, -0.38), 0.008, 4), null, STEEL);
  else for (const s of [-1, 1]) b.add(rod(V(s * 0.08, 0.3, -0.42), V(s * 0.14, 0.0, -0.36), 0.009, 4), null, STEEL);

  // variant extras
  if (variant === 'opa') {
    // front carrier + plastic crate (very Dutch)
    for (const s of [-1, 1]) b.add(rod(V(s * 0.05, 0.62, 0.5), V(s * 0.12, 0.8, 0.62), 0.008, 4), null, BLACK);
    b.add(box(0.32, 0.02, 0.3), mat(0, 0.82, 0.64), BLACK);
    b.add(box(0.38, 0.24, 0.32), mat(0, 0.95, 0.64), { color: 0x2b2e31, rough: 0.7 });
    if (lod === 0) b.add(box(0.34, 0.2, 0.28), mat(0, 0.97, 0.64), { color: 0x141516, rough: 0.9 });
  } else if (variant === 'tassen') {
    // double pannier bags over the rear carrier
    for (const s of [-1, 1]) {
      b.add(box(0.12, 0.32, 0.36), mat(s * 0.14, 0.66, -0.58), { color: 0x1f2522, rough: 0.85 });
      if (lod === 0) b.add(box(0.13, 0.04, 0.37), mat(s * 0.14, 0.78, -0.58), { color: 0x2c332f, rough: 0.8 });
    }
    b.add(box(0.3, 0.02, 0.36), mat(0, 0.835, -0.58), { color: 0x1f2522, rough: 0.85 });
  } else if (isBak) {
    // wooden cargo box between head tube and front wheel
    const wood: Style = { color: 0x9a7448, rough: 0.7, paint: 0 };
    const bz = 0.92, w = 0.66, d = 0.86, hgt = 0.44, t = 0.018;
    b.add(box(w, t, d), mat(0, 0.32, bz), wood);
    b.add(box(w, hgt, t), mat(0, 0.32 + hgt / 2, bz + d / 2), wood);
    b.add(box(w, hgt * 0.7, t), mat(0, 0.32 + hgt * 0.35, bz - d / 2), wood);
    for (const s of [-1, 1]) b.add(box(t, hgt, d), mat(s * w / 2, 0.32 + hgt / 2, bz), wood);
    if (lod === 0) {
      b.add(box(w - 0.04, 0.03, 0.12), mat(0, 0.6, bz - d / 2 + 0.12), wood); // bench inside
      for (const s of [-1, 1]) b.add(box(0.03, 0.03, d), mat(s * (w / 2 + 0.01), 0.32 + hgt, bz), { color: 0x6d4f30, rough: 0.7 });
    }
    // rear carrier light only
    b.add(box(0.07, 0.045, 0.03), mat(0, 0.6, -0.9), { color: 0x7a0c08, rough: 0.3, emit: 0.6 });
  }
  return b.build();
}

const BIKE_COLOURS: [number, number][] = [
  [0x0b0b0c, 50], [0x1b1d20, 6], [0x1a2740, 7], [0x1e3528, 6], [0x4a1518, 6], [0xcbbd9f, 5],
  [0x7d9bb5, 4], [0x23474f, 4], [0xd9d9d4, 3], [0x9cc2ad, 2], [0x8e1b1b, 2], [0x3d3b38, 3], [0x5a4632, 2],
];

/** Instance matrix for a bike parked at (x, z) heading `rot`, leaning on its kickstand. */
function bikeMatrix(x: number, z: number, rot: number, lean: number, out: THREE.Matrix4): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, -lean, 'YXZ'));
  return out.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, 1, 1));
}

export function buildBikes(props: PropsData, _anisotropy: number, ground: GroundFn = () => 0): PropBatch[] {
  const material = getFurnitureMaterial();
  const variants: Variant[] = ['oma', 'opa', 'tassen', 'bakfiets'];
  const batches = new Map<Variant, PropBatch>();
  for (const v of variants) {
    // bikes cast into the nearest shadow cascade only; from LOD1 on the shadow is the LOD2 shape
    const g2 = buildBike(v, 2);
    const lodsDef: BatchLod[] = [
      { dist: 24, maxInstances: 400, parts: [{ geometry: buildBike(v, 0), material, castShadow: true, nearShadow: true }] },
      {
        dist: 75,
        parts: [{ geometry: buildBike(v, 1), material, castShadow: true }],
        shadowParts: [{ geometry: g2, material, nearShadow: true }],
      },
      { dist: 140, parts: [{ geometry: g2, material, castShadow: false }] },
    ];
    batches.set(v, new PropBatch({ name: `fiets_${v}`, lods: lodsDef, colors: true, density: true, cellSize: 40, margin: 2, moveThreshold: 1 }));
  }
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const colours = BIKE_COLOURS.map(([c]) => c);
  const weights = BIKE_COLOURS.map(([, w]) => w);
  for (const [x, z, rot] of props.parkedBikes ?? []) {
    const rng = new Rng(Math.floor(hash2(x, z, 11) * 1e9));
    const r = rng.next();
    const v: Variant = r < 0.03 ? 'bakfiets' : r < 0.25 ? 'opa' : r < 0.4 ? 'tassen' : 'oma';
    col.set(rng.weighted(colours, weights));
    const lean = v === 'bakfiets' ? 0 : THREE.MathUtils.degToRad(rng.range(5.5, 8));
    // stagger neighbouring bikes forward/backward so handlebars do not interpenetrate
    const shift = (Math.floor(hash2(x, z, 13) * 3) - 1) * 0.16;
    const r2 = rot + rng.range(-0.07, 0.07);
    bikeMatrix(x + Math.sin(r2) * shift, z + Math.cos(r2) * shift, r2, lean, m);
    m.elements[13] += ground(x, z);
    batches.get(v)!.addMatrix(m, col, undefined, hash2(x, z, 12));
  }
  return [...batches.values()].filter((b) => b.count > 0);
}

/** Exposed for other modules (e.g. traffic cyclists could reuse the parked-bike geometry). */
export function createBikeGeometry(variant: Variant = 'oma', lod: 0 | 1 | 2 = 1): THREE.BufferGeometry {
  return buildBike(variant, lod);
}
