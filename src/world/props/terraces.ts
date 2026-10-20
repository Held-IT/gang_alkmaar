// Café terraces (terrassen): bistro and four-seat tables with chairs, square / round parasols,
// glass windscreens and planters in front of the real cafés and restaurants (OSM amenity nodes).
// The layout is generated offline (dev/genTerraces.mjs -> public/assets/props/terraces.json);
// this module only instantiates it: 6 instanced batches, colour schemes per terrace through the
// instance colour, and one low box collider per terrace so the player cannot drive through it.
import * as THREE from 'three';
import { PropBatch, type BatchLod } from './util/batch';
import { MeshBuilder, box, cylinder, mat, sphere, type Style } from './util/geom';
import { getFurnitureMaterial } from './street';
import type { Colliders } from './util/physicsStub';
import type { GroundFn } from './util/ground';

/** public/assets/props/terraces.json (see dev/genTerraces.mjs) */
export interface TerraceData {
  version: number;
  /** [x, z, rotY, shape (0 = round bistro, 1 = square four-seat), tableColour] */
  tables: [number, number, number, number, number][];
  /** [x, z, rotY, colour] (chair faces +z after rotY) */
  chairs: [number, number, number, number][];
  /** [x, z, rotY, size (0 = small round, 1 = large square), style] */
  parasols: [number, number, number, number, number][];
  /** [x, z, rotY, length, style] panel along local x */
  screens: [number, number, number, number, number][];
  /** [x, z, rotY] */
  planters: [number, number, number][];
  /** [cx, cz, rotY, halfLength (local x), halfDepth (local z)] */
  areas: [number, number, number, number, number][];
}

const STYLE_COLOURS = [0xe8e0cc, 0x2f4a36, 0x6e1f26, 0x1f2c44, 0x3a3c3f, 0xb45a3c];
const CHAIR_COLOURS = [0x9c7a50, 0x262626, 0xe4e4df, 0x8a6a48, 0x3c5a3c];
const TABLE_COLOURS = [0xe6e4de, 0x2a2a2a, 0x7a5a3a];

const PAINT: Style = { color: 0xffffff, rough: 0.55, paint: 1 };
const METAL: Style = { color: 0x2a2b2d, rough: 0.45, metal: 0.6 };
const ALU: Style = { color: 0xb9bcbf, rough: 0.35, metal: 0.8 };
const GLASS: Style = { color: 0xaebfc6, rough: 0.06, metal: 0.55 };

function buildChair(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // faces +z: seat at 0.46 m, backrest at -z
  b.add(box(0.42, 0.04, 0.42), mat(0, 0.46, 0), PAINT);
  b.add(box(0.42, 0.36, 0.035), mat(0, 0.68, -0.2, -0.12, 0, 0), PAINT);
  if (lod === 0) {
    for (const [x, z] of [[-0.18, 0.18], [0.18, 0.18], [-0.18, -0.18], [0.18, -0.18]]) {
      b.add(cylinder(0.012, 0.012, 0.46, 4, true), mat(x, 0, z), METAL);
    }
    b.add(box(0.03, 0.42, 0.03), mat(-0.18, 0.66, -0.19, -0.12, 0, 0), METAL);
    b.add(box(0.03, 0.42, 0.03), mat(0.18, 0.66, -0.19, -0.12, 0, 0), METAL);
  } else {
    b.add(box(0.36, 0.44, 0.36), mat(0, 0.22, 0), { color: 0x2a2b2d, rough: 0.6, paint: 0 });
  }
  return b.build();
}

function buildTable(lod: number, square: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const top = 0.74;
  if (square) b.add(box(0.8, 0.03, 0.8), mat(0, top, 0), PAINT);
  else b.add(cylinder(0.32, 0.32, 0.03, lod === 0 ? 16 : 8), mat(0, top - 0.015, 0), PAINT);
  b.add(cylinder(0.03, 0.03, top - 0.02, lod === 0 ? 6 : 4, true), mat(0, 0, 0), METAL);
  if (lod === 0) {
    b.add(box(0.5, 0.03, 0.06), mat(0, 0.015, 0), METAL);
    b.add(box(0.06, 0.03, 0.5), mat(0, 0.015, 0), METAL);
  }
  return b.build();
}

/** Square market parasol (3.1 m, faces up), canopy = instance colour. Small round = scaled. */
function buildParasol(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const H = 2.55, half = 1.55, rise = 0.45;
  b.add(cylinder(0.025, 0.025, H + rise, lod === 0 ? 6 : 4, true), mat(0, 0, 0), ALU);
  b.add(box(0.55, 0.08, 0.55), mat(0, 0.04, 0), { color: 0x3a3b3d, rough: 0.7 });
  // pyramid canopy (both sides so it shades and reads from below)
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
  const corners: [number, number][] = [[-half, -half], [half, -half], [half, half], [-half, half]];
  const apex = [0, H + rise, 0];
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = corners[k], [x1, z1] = corners[(k + 1) % 4];
    const n = new THREE.Vector3((x0 + x1) / 2, (half * half) / rise / 1.2, (z0 + z1) / 2).normalize();
    const base = pos.length / 3;
    pos.push(x0, H, z0, x1, H, z1, apex[0], apex[1], apex[2]);
    for (let i = 0; i < 3; i++) { nor.push(n.x, n.y, n.z); col.push(1, 1, 1); }
    uv.push(0, 0, 1, 0, 0.5, 1);
    idx.push(base, base + 2, base + 1, base, base + 1, base + 2);
  }
  b.addRaw(pos, nor, uv, idx, col, { rough: 0.9, paint: 1 });
  if (lod === 0) {
    // valance strips around the edge
    for (const [x, z, w, d] of [[0, -half, 2 * half, 0.02], [0, half, 2 * half, 0.02], [-half, 0, 0.02, 2 * half], [half, 0, 0.02, 2 * half]]) {
      b.add(box(w, 0.22, d), mat(x, H - 0.11, z), { color: 0xffffff, rough: 0.9, paint: 1 });
    }
    b.add(sphere(0.05, 6, 4), mat(0, H + rise + 0.03, 0), ALU);
  }
  return b.build();
}

/** Windscreen panel 1.6 m (local x) x 1.4 m: printed lower panel (style colour) + glass. */
function buildScreen(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const L = 1.6;
  b.add(box(L - 0.06, 0.62, 0.02), mat(0, 0.36, 0), PAINT);
  b.add(box(L - 0.06, 0.7, 0.012), mat(0, 1.02, 0), GLASS);
  if (lod === 0) {
    for (const x of [-L / 2 + 0.025, L / 2 - 0.025]) b.add(box(0.05, 1.4, 0.05), mat(x, 0.7, 0), ALU);
    b.add(box(L, 0.04, 0.05), mat(0, 1.39, 0), ALU);
    b.add(box(0.5, 0.03, 0.3), mat(-L / 2 + 0.3, 0.015, 0), METAL);
    b.add(box(0.5, 0.03, 0.3), mat(L / 2 - 0.3, 0.015, 0), METAL);
  }
  return b.build();
}

function buildPlanter(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add(box(0.75, 0.55, 0.75), mat(0, 0.275, 0), { color: 0x5c4630, rough: 0.85 });
  b.add(sphere(0.42, lod === 0 ? 10 : 6, lod === 0 ? 7 : 4), mat(0, 0.86, 0, 0, 0, 0, 1, 0.9, 1), { color: 0x34502a, rough: 0.95 });
  return b.build();
}

/** LOD levels: shadow from the coarse shape; `near` = nearest shadow cascade only. */
function lods(build: (lod: number) => THREE.BufferGeometry, d0: number, d1: number, near: boolean): BatchLod[] {
  const material = getFurnitureMaterial();
  const g0 = build(0), g1 = build(1);
  return [
    {
      dist: d0,
      parts: [{ geometry: g0, material, castShadow: true, nearShadow: near }],
      shadowParts: [{ geometry: g1, material, nearShadow: near }],
    },
    { dist: d1, parts: [{ geometry: g1, material, castShadow: !near }] },
  ];
}

export function buildTerraces(data: TerraceData, colliders: Colliders, ground: GroundFn): PropBatch[] {
  const opts = { colors: true, cellSize: 48, margin: 3, moveThreshold: 1.5 };
  const chairs = new PropBatch({ name: 'terras_stoel', lods: lods(buildChair, 45, 120, true), ...opts });
  const roundT = new PropBatch({ name: 'terras_tafel_rond', lods: lods((l) => buildTable(l, false), 50, 130, true), ...opts });
  const squareT = new PropBatch({ name: 'terras_tafel_vierkant', lods: lods((l) => buildTable(l, true), 50, 130, true), ...opts });
  const parasols = new PropBatch({ name: 'terras_parasol', lods: lods(buildParasol, 90, 320, false), ...opts, margin: 4 });
  const screens = new PropBatch({ name: 'terras_windscherm', lods: lods(buildScreen, 60, 200, true), ...opts });
  const planters = new PropBatch({ name: 'terras_plantenbak', lods: lods(buildPlanter, 60, 200, true), ...opts });

  const c = new THREE.Color();
  const s = new THREE.Vector3();
  for (const [x, z, rot, col] of data.chairs ?? []) chairs.add(x, ground(x, z), z, rot, 1, c.set(CHAIR_COLOURS[col % CHAIR_COLOURS.length]));
  for (const [x, z, rot, shape, col] of data.tables ?? []) {
    (shape === 1 ? squareT : roundT).add(x, ground(x, z), z, rot, 1, c.set(TABLE_COLOURS[col % TABLE_COLOURS.length]));
  }
  for (const [x, z, rot, size, style] of data.parasols ?? []) {
    // small round-ish parasol on narrow strips: scaled square one, a little lower
    parasols.add(x, ground(x, z), z, rot + (size ? 0 : Math.PI / 4), size ? 1 : s.set(0.78, 0.92, 0.78), c.set(STYLE_COLOURS[style % STYLE_COLOURS.length]));
  }
  for (const [x, z, rot, len, style] of data.screens ?? []) {
    screens.add(x, ground(x, z), z, rot, s.set(len / 1.6, 1, 1), c.set(STYLE_COLOURS[style % STYLE_COLOURS.length]));
  }
  for (const [x, z, rot] of data.planters ?? []) planters.add(x, ground(x, z), z, rot);
  // one low box per terrace (tables, chairs, screens): the car stops at the terrace edge
  const centre = new THREE.Vector3(), half = new THREE.Vector3();
  for (const [x, z, rot, hl, hd] of data.areas ?? []) {
    const gy = ground(x, z);
    colliders.box(centre.set(x, gy + 0.45, z), half.set(hl, 0.45, hd), rot, 'terrace');
  }
  return [chairs, roundT, squareT, parasols, screens, planters].filter((b) => b.count > 0);
}
