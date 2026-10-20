// Kaasmarkt on the Waagplein: lots ("partijen") of yellow waxed Gouda wheels laid out in neat
// rows on the cobbles, cheese porters' barrows (draagberries) in the guild colours red, yellow,
// green and blue loaded with cheese, a rope barrier, and red-white Alkmaar flags on poles.
import * as THREE from 'three';
import { PropBatch, type BatchLod } from '../props/util/batch';
import { MeshBuilder, box, cylinder, lathe, mat, rod, sphere, type Style } from '../props/util/geom';
import { createPropDepthMaterial, createPropMaterial } from '../props/util/propMaterial';
import { getFurnitureMaterial } from '../props/street';
import type { Colliders } from '../props/util/physicsStub';
import { Rng } from '../props/util/rng';
import { getAlkmaarFlag } from './textures';
import type { Site } from './siteFinder';

const WHEEL_D = 0.36;
const WHEEL_H = 0.115;

function cheeseGeometry(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const r = WHEEL_D / 2, h = WHEEL_H;
  const prof: [number, number][] = lod === 0
    ? [[0, 0], [r * 0.84, 0], [r * 0.96, h * 0.12], [r, h * 0.5], [r * 0.96, h * 0.88], [r * 0.84, h], [0, h]]
    : lod === 1
      ? [[0, 0], [r * 0.9, 0], [r, h * 0.5], [r * 0.9, h], [0, h]]
      : [[0, 0], [r, 0.01], [r, h], [0, h]];
  const g = lathe(prof, lod === 0 ? 20 : lod === 1 ? 10 : 6);
  b.add(g, null, { color: 0xffffff, rough: 0.32, metal: 0, paint: 1 });
  if (lod === 0) {
    // stamped "kaasmerk" label on top: small dark-red oval
    const lbl = new THREE.CircleGeometry(0.03, 10);
    lbl.rotateX(-Math.PI / 2);
    b.add(lbl, mat(0.06, h + 0.001, 0.02, 0, 0, 0, 1, 1, 0.65), { color: 0xd9cfb4, rough: 0.6 });
  }
  return b.build();
}

/** Draagberrie: two carrying poles, slatted bed, short legs. Painted parts take the guild colour. */
function berrieGeometry(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const paint: Style = { color: 0xffffff, rough: 0.45, paint: 1 };
  const wood: Style = { color: 0x8a6a45, rough: 0.7 };
  const L = 2.5, hw = 0.38, y = 0.22;
  for (const s of [-1, 1]) {
    b.add(box(0.065, 0.075, L), mat(s * hw, y, 0), paint);
    // rounded handle grips
    // (cylinder base sits at its origin: start just inside the pole end, point outwards)
    for (const e of [-1, 1]) b.add(cylinder(0.034, 0.034, 0.36, lod === 0 ? 8 : 4), mat(s * hw, y, e * (L / 2 - 0.04), e * Math.PI / 2, 0, 0), wood);
  }
  const nSl = lod === 0 ? 7 : 3;
  for (let i = 0; i < nSl; i++) {
    const z = -0.6 + (1.2 * i) / (nSl - 1);
    b.add(box(hw * 2 + 0.06, 0.03, lod === 0 ? 0.09 : 0.3), mat(0, y + 0.05, z), paint);
  }
  // side rails
  for (const s of [-1, 1]) b.add(box(0.04, 0.09, 1.3), mat(s * (hw - 0.02), y + 0.1, 0), paint);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(box(0.06, y, 0.06), mat(sx * hw, y / 2, sz * 0.62), paint);
  // 8 cheeses (2 layers of 2 x 2)
  if (lod <= 1) {
    const cheese = cheeseGeometry(lod === 0 ? 0 : 2);
    for (let layer = 0; layer < 2; layer++) for (const cx of [-0.19, 0.19]) for (const cz of [-0.2, 0.2]) {
      b.add(cheese, mat(cx, y + 0.065 + layer * (WHEEL_H + 0.005), cz + (layer ? 0.02 : 0)), { color: 0xe6aa20, rough: 0.32 });
    }
  }
  return b.build();
}

function flagPoleGeometry(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add(cylinder(0.04, 0.065, 8.0, lod === 0 ? 10 : 5), null, { color: 0xecebe6, rough: 0.4, metal: 0.2 });
  b.add(sphere(0.07, 8, 6), mat(0, 8.05, 0), { color: 0xc9a43a, rough: 0.3, metal: 0.9 });
  b.add(cylinder(0.11, 0.13, 0.2, 10), null, { color: 0x3c3f42, rough: 0.5, metal: 0.4 });
  return b.build();
}

function flagGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const g = new THREE.PlaneGeometry(1.5, 1.0, 16, 8);
  g.translate(0.75, 0, 0); // hoist at x = 0
  b.add(g, null, { color: 0xffffff, rough: 0.85 });
  return b.build();
}

export interface Kaasmarkt {
  group: THREE.Group;
  batches: PropBatch[];
  cheeses: number;
}

/** Market layout: lots along the length axis x lots across, each 4 rows of cheese wheels. */
export interface MarketLayout { lotsA: number; lotsB: number; lotLen: number }
export const MARKET_LAYOUTS: MarketLayout[] = [
  { lotsA: 3, lotsB: 3, lotLen: 18 },
  { lotsA: 2, lotsB: 3, lotLen: 18 },
  { lotsA: 2, lotsB: 2, lotLen: 14 },
];
const PITCH = WHEEL_D + 0.025;
const GAP_A = 2.4, GAP_B = 2.1;
/** Footprint (length, width) of a layout including the rope barrier and flags. */
export function marketSize(l: MarketLayout): [number, number] {
  const a = l.lotsA * l.lotLen * PITCH + (l.lotsA - 1) * GAP_A;
  const b = l.lotsB * 4 * PITCH + (l.lotsB - 1) * GAP_B;
  return [a + 2 * 3.6 + 2.4, b + 2 * 1.2 + 1.6];
}

export function buildKaasmarkt(site: Site, colliders: Colliders, windDir: THREE.Vector2, layout: MarketLayout = MARKET_LAYOUTS[1]): Kaasmarkt {
  const group = new THREE.Group();
  group.name = 'kaasmarkt';
  const rng = new Rng(1622); // Kaasmarkt since 1622-ish
  const ux = Math.cos(site.rot), uz = Math.sin(site.rot);
  const vx = -uz, vz = ux;
  const W = (a: number, b: number): [number, number] => [site.x + ux * a + vx * b, site.z + uz * a + vz * b];
  const yaw = -site.rot; // THREE yaw that maps local +x onto the site length axis
  const material = getFurnitureMaterial();

  // ---------------------------------------------------------------- cheese lots
  const cheeseLods: BatchLod[] = [
    { dist: 15, maxInstances: 900, parts: [{ geometry: cheeseGeometry(0), material, castShadow: true }] },
    { dist: 70, parts: [{ geometry: cheeseGeometry(1), material, castShadow: true }] },
    { dist: 400, parts: [{ geometry: cheeseGeometry(2), material, castShadow: false }] },
  ];
  const cheese = new PropBatch({ name: 'kaas', lods: cheeseLods, colors: true, cellSize: 8, margin: 1, moveThreshold: 0.8 });
  const col = new THREE.Color();
  const pitch = PITCH;
  const lotRows = 4, lotLen = layout.lotLen;
  const lotsA = layout.lotsA, lotsB = layout.lotsB;
  const gapA = GAP_A, gapB = GAP_B;
  const lotSizeA = lotLen * pitch, lotSizeB = lotRows * pitch;
  const totalA = lotsA * lotSizeA + (lotsA - 1) * gapA;
  const totalB = lotsB * lotSizeB + (lotsB - 1) * gapB;
  const centre = new THREE.Vector3(), half = new THREE.Vector3();
  let count = 0;
  for (let la = 0; la < lotsA; la++) for (let lb = 0; lb < lotsB; lb++) {
    const a0 = -totalA / 2 + la * (lotSizeA + gapA);
    const b0 = -totalB / 2 + lb * (lotSizeB + gapB);
    const lotTint = rng.range(-0.04, 0.04);
    const stacked = la === Math.floor(lotsA / 2) && lb === 1;
    for (let layer = 0; layer < (stacked ? 2 : 1); layer++) {
      for (let i = 0; i < lotLen - layer; i++) for (let j = 0; j < lotRows - layer; j++) {
        const a = a0 + (i + 0.5 + layer * 0.5) * pitch + rng.range(-0.01, 0.01);
        const bb = b0 + (j + 0.5 + layer * 0.5) * pitch + rng.range(-0.01, 0.01);
        const [x, z] = W(a, bb);
        // yellow wax, slightly varying per lot and wheel
        col.setHSL(0.104 + lotTint * 0.2 + rng.range(-0.006, 0.006), 0.9, 0.47 + rng.range(-0.035, 0.03));
        cheese.add(x, layer * (WHEEL_H + 0.004), z, rng.range(0, Math.PI * 2), 1, col);
        count++;
      }
    }
    const [cx, cz] = W(a0 + lotSizeA / 2, b0 + lotSizeB / 2);
    colliders.box(centre.set(cx, 0.08, cz), half.set(lotSizeA / 2, 0.08, lotSizeB / 2), yaw, 'kaas');
  }

  // ---------------------------------------------------------------- draagberries
  const berries = new PropBatch({
    name: 'draagberrie',
    lods: [
      { dist: 40, parts: [{ geometry: berrieGeometry(0), material, castShadow: true }] },
      { dist: 300, parts: [{ geometry: berrieGeometry(1), material, castShadow: true }] },
    ],
    colors: true,
    cellSize: 16,
    margin: 1,
  });
  const guild = [0xb81f22, 0xe8b417, 0x1f6b3a, 0x1e4f9a, 0xb81f22, 0x1e4f9a];
  const spots: [number, number, number][] = [
    [-totalA / 2 - 2.2, -1.6, 0.1], [-totalA / 2 - 2.2, 1.4, -0.08],
    [0, -totalB / 2 + lotSizeB + gapB / 2, Math.PI / 2 + 0.05],
    [3.2, totalB / 2 - lotSizeB - gapB / 2, Math.PI / 2 - 0.1],
    [totalA / 2 + 2.0, 0.6, 0.15], [-4.2, -totalB / 2 + lotSizeB + gapB / 2, Math.PI / 2],
  ];
  spots.forEach(([a, bb, r], k) => {
    const [x, z] = W(a, bb);
    col.set(guild[k % guild.length]);
    berries.add(x, 0, z, yaw + r, 1, col);
    colliders.box(centre.set(x, 0.3, z), half.set(0.45, 0.3, 1.35), yaw + r, 'draagberrie');
  });

  // ---------------------------------------------------------------- rope barrier
  const postGeo = new MeshBuilder();
  postGeo.add(cylinder(0.035, 0.045, 0.95, 8), null, { color: 0xf0efea, rough: 0.5 });
  postGeo.add(sphere(0.05, 8, 6), mat(0, 0.97, 0), { color: 0xf0efea, rough: 0.5 });
  postGeo.add(cylinder(0.14, 0.16, 0.05, 10), null, { color: 0x2b2d2f, rough: 0.6 });
  const posts = new PropBatch({
    name: 'afzetpaal',
    lods: [{ dist: 220, parts: [{ geometry: postGeo.build(), material, castShadow: true }] }],
    cellSize: 32,
    margin: 1,
  });
  const ra = totalA / 2 + 3.6, rb = totalB / 2 + 1.2;
  const corners: [number, number][] = [[-ra, -rb], [ra, -rb], [ra, rb], [-ra, rb], [-ra, -rb]];
  const rope = new MeshBuilder();
  for (let c = 0; c < 4; c++) {
    const [a0, b0] = corners[c], [a1, b1] = corners[c + 1];
    const len = Math.hypot(a1 - a0, b1 - b0);
    const n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i < n; i++) {
      // leave an opening in the middle of the long side facing the Waag for the porters
      const t0 = i / n, t1 = (i + 1) / n;
      const p0 = W(a0 + (a1 - a0) * t0, b0 + (b1 - b0) * t0);
      const p1 = W(a0 + (a1 - a0) * t1, b0 + (b1 - b0) * t1);
      posts.add(p0[0], 0, p0[1], 0);
      if (c === 3 && i === Math.floor(n / 2)) continue;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 6; k++) {
        const t = k / 6;
        pts.push(new THREE.Vector3(p0[0] + (p1[0] - p0[0]) * t, 0.86 - 0.16 * Math.sin(Math.PI * t), p0[1] + (p1[1] - p0[1]) * t));
      }
      for (let k = 0; k < 6; k++) {
        rope.add(rod(pts[k], pts[k + 1], 0.012, 4), null, { color: k % 2 === 0 ? 0xb3141c : 0xf0eee8, rough: 0.8 });
      }
    }
  }
  const ropeMesh = new THREE.Mesh(rope.build(), material);
  ropeMesh.castShadow = true;
  ropeMesh.receiveShadow = true;
  group.add(ropeMesh);

  // ---------------------------------------------------------------- flags
  const poles = new PropBatch({
    name: 'vlaggenmast',
    lods: [
      { dist: 80, parts: [{ geometry: flagPoleGeometry(0), material, castShadow: true }] },
      { dist: 600, parts: [{ geometry: flagPoleGeometry(1), material, castShadow: false }] },
    ],
    cellSize: 64,
    margin: 2,
  });
  const flagOpts = { name: 'vlag_alkmaar', map: getAlkmaarFlag(), side: THREE.DoubleSide, flag: true };
  const flags = new PropBatch({
    name: 'vlag',
    lods: [{ dist: 700, parts: [{ geometry: flagGeometry(), material: createPropMaterial(flagOpts), depthMaterial: createPropDepthMaterial(flagOpts), castShadow: true }] }],
    cellSize: 64,
    margin: 3,
  });
  const flagYaw = Math.atan2(-windDir.y, windDir.x); // local +x (fly) points downwind
  const flagSpots: [number, number][] = [[-ra - 1.2, -rb - 0.8], [ra + 1.2, -rb - 0.8], [ra + 1.2, rb + 0.8], [-ra - 1.2, rb + 0.8]];
  for (const [a, bb] of flagSpots) {
    const [x, z] = W(a, bb);
    poles.add(x, 0, z, 0);
    flags.add(x + Math.cos(flagYaw) * 0.06, 7.3, z - Math.sin(flagYaw) * 0.06, flagYaw + rng.range(-0.15, 0.15));
    colliders.cylinder(x, z, 0.08, 8, 0, 'flagpole');
  }
  return { group, batches: [cheese, berries, posts, poles, flags], cheeses: count };
}
