// Street furniture: historic Alkmaar lanterns, modern street lights, Amsterdammertje bollards,
// benches, waste bins, bike racks ("nietjes") and Dutch traffic lights. Each prop is one merged
// geometry (vertex colours / roughness / metalness) per LOD -> one instanced draw call per LOD.
import * as THREE from 'three';
import type { PropsData } from '../../contracts';
import { PropBatch, type BatchLod } from './util/batch';
import { MeshBuilder, beam, box, cylinder, lathe, mat, rod, sphere, sweep } from './util/geom';
import { createPropMaterial } from './util/propMaterial';
import type { GroundFn } from './util/ground';
import type { Colliders } from './util/physicsStub';
import { getGrungeTexture } from './util/textures';
import { Rng, hash2 } from './util/rng';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// colours (sRGB hex -> converted to linear by THREE.Color)
export const COL = {
  lanternGreen: 0x1d2b23,
  iron: 0x18191a,
  galvanised: 0x8d9193,
  darkGrey: 0x34383b,
  bollard: 0x4a1d16,
  wood: 0x7d5a3c,
  woodGrey: 0x6f6152,
  binGreen: 0x23392c,
  glassWarm: 0xf3e2b8,
  bulb: 0xffe2a8,
  led: 0xeef3ff,
  black: 0x0e0f10,
  white: 0xe8e8e4,
  yellow: 0xe3b512,
};

let furnitureMat: THREE.MeshStandardMaterial | null = null;
let signalMat: THREE.MeshStandardMaterial | null = null;

/** Shared opaque prop material (vertex attributes + subtle grunge). */
export function getFurnitureMaterial(): THREE.MeshStandardMaterial {
  if (!furnitureMat) furnitureMat = createPropMaterial({ name: 'straatmeubilair', map: getGrungeTexture(), emissiveBoost: 5 });
  return furnitureMat;
}
function getSignalMaterial(): THREE.MeshStandardMaterial {
  if (!signalMat) signalMat = createPropMaterial({ name: 'verkeerslicht', map: getGrungeTexture(), signal: true });
  return signalMat;
}

// ---------------------------------------------------------------------------------------------
// Historic lantern (kind 0): dark green cast-iron post with a four-sided tapered glass lantern
// ---------------------------------------------------------------------------------------------

export function buildLantern(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const seg = lod === 0 ? 14 : 7;
  const iron = { color: COL.lanternGreen, rough: 0.42, metal: 0.55 };
  // base plinth + fluted-looking shaft (lathe profile)
  const profile: [number, number][] = lod === 0
    ? [
        [0.19, 0], [0.19, 0.06], [0.17, 0.08], [0.165, 0.2], [0.14, 0.24], [0.13, 0.34], [0.105, 0.38], [0.1, 0.46],
        [0.085, 0.5], [0.075, 0.56], [0.068, 1.2], [0.06, 2.6], [0.075, 2.64], [0.075, 2.7], [0.055, 2.74], [0.05, 3.18],
        [0.085, 3.22], [0.095, 3.28], [0.06, 3.32], [0.06, 3.36],
      ]
    : [[0.19, 0], [0.17, 0.2], [0.12, 0.36], [0.08, 0.5], [0.065, 1.4], [0.055, 3.2], [0.09, 3.26], [0.06, 3.36]];
  b.add(lathe(profile, seg), null, iron);
  // ladder bar (ladderligger) with ball ends
  if (lod === 0) {
    b.add(rod(V(-0.32, 2.95, 0), V(0.32, 2.95, 0), 0.016, 6), null, iron);
    b.add(sphere(0.03, 6, 4), mat(-0.33, 2.95, 0), iron);
    b.add(sphere(0.03, 6, 4), mat(0.33, 2.95, 0), iron);
    // decorative scroll brackets under the lantern
    for (const s of [-1, 1]) {
      const pts = [V(0, 3.05, 0), V(0.07 * s, 3.12, 0), V(0.12 * s, 3.27, 0), V(0.1 * s, 3.36, 0)];
      b.add(sweep(pts, 0.012, 4), null, iron);
    }
  }
  // lantern bowl
  b.add(lathe([[0.0, 3.3], [0.06, 3.33], [0.13, 3.4], [0.15, 3.42]], lod === 0 ? 4 : 4), mat(0, 0, 0, 0, Math.PI / 4), iron);
  // glass body: 4-sided truncated pyramid, wider at the top
  const glassH = 0.56;
  const gb = new THREE.CylinderGeometry(0.19 * Math.SQRT2, 0.13 * Math.SQRT2, glassH, 4, 1, true);
  gb.translate(0, 3.42 + glassH / 2, 0);
  gb.rotateY(Math.PI / 4);
  b.add(gb, null, { color: 0xb8ac90, rough: 0.06, metal: 0.1, emit: 1 });
  // bulb inside
  b.add(sphere(0.05, 6, 4), mat(0, 3.62, 0), { color: COL.bulb, rough: 0.3, emit: 2.5 });
  // frame corner bars
  if (lod === 0) {
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      const r0 = 0.13 * Math.SQRT2, r1 = 0.19 * Math.SQRT2;
      b.add(rod(V(Math.cos(a) * r0, 3.42, Math.sin(a) * r0), V(Math.cos(a) * r1, 3.98, Math.sin(a) * r1), 0.012, 4), null, iron);
    }
    // top ring and bottom ring (square frames)
    const ring = (y: number, r: number, t: number) => {
      const g = new THREE.CylinderGeometry(r * Math.SQRT2, r * Math.SQRT2, t, 4, 1, false);
      g.translate(0, y, 0);
      g.rotateY(Math.PI / 4);
      return g;
    };
    b.add(ring(3.43, 0.14, 0.03), null, iron);
    b.add(ring(3.99, 0.2, 0.04), null, iron);
  }
  // roof: overhanging four-sided pyramid + crown + finial
  const roof = new THREE.CylinderGeometry(0.0, 0.3 * Math.SQRT2, 0.24, 4, 1, false);
  roof.translate(0, 4.13, 0);
  roof.rotateY(Math.PI / 4);
  b.add(roof, null, iron);
  const eave = new THREE.CylinderGeometry(0.3 * Math.SQRT2, 0.27 * Math.SQRT2, 0.04, 4, 1, false);
  eave.translate(0, 4.0, 0);
  eave.rotateY(Math.PI / 4);
  b.add(eave, null, iron);
  b.add(lathe([[0.045, 4.2], [0.05, 4.24], [0.03, 4.3], [0.008, 4.42], [0.0, 4.44]], lod === 0 ? 8 : 4), null, iron);
  if (lod === 0) b.add(sphere(0.035, 8, 6), mat(0, 4.29, 0), iron);
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Modern street light (kind 1): conical galvanised pole, short arm, flat LED head (faces +z)
// ---------------------------------------------------------------------------------------------

export function buildStreetLight(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const steel = { color: COL.galvanised, rough: 0.42, metal: 0.75 };
  const seg = lod === 0 ? 12 : 6;
  b.add(cylinder(0.11, 0.12, 0.6, seg), null, { ...steel, color: 0x6e7275 });
  b.add(cylinder(0.05, 0.09, 6.9, seg), mat(0, 0.6, 0), steel);
  // arm curving out over the road
  const arm = [V(0, 7.4, 0), V(0, 7.62, 0.12), V(0, 7.72, 0.4), V(0, 7.76, 0.75)];
  b.add(sweep(arm, 0.035, lod === 0 ? 8 : 4), null, steel);
  // head
  const head = new THREE.BoxGeometry(0.3, 0.08, 0.66);
  b.add(head, mat(0, 7.76, 1.0, -0.08, 0, 0), { color: COL.darkGrey, rough: 0.5, metal: 0.4 });
  const led = new THREE.BoxGeometry(0.22, 0.012, 0.48);
  b.add(led, mat(0, 7.71, 1.03, -0.08, 0, 0), { color: COL.led, rough: 0.2, emit: 1.6 });
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Amsterdammertje-style bollard (dark red-brown cast iron, ~1 m)
// ---------------------------------------------------------------------------------------------

export function buildBollard(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const prof: [number, number][] = lod === 0
    ? [[0.085, 0], [0.08, 0.04], [0.07, 0.08], [0.064, 0.6], [0.062, 0.8], [0.074, 0.82], [0.074, 0.87], [0.064, 0.89], [0.062, 0.94], [0.056, 0.99], [0.045, 1.02], [0.026, 1.045], [0.0, 1.05]]
    : [[0.08, 0], [0.064, 0.6], [0.07, 0.85], [0.055, 1.0], [0.0, 1.05]];
  b.add(lathe(prof, lod === 0 ? 12 : 6), null, { color: COL.bollard, rough: 0.48, metal: 0.35 });
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Bench: cast-iron frames + wooden slats, faces +z (sitter looks towards +z)
// ---------------------------------------------------------------------------------------------

export function buildBench(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const iron = { color: COL.iron, rough: 0.5, metal: 0.5 };
  const wood = { color: COL.wood, rough: 0.75, metal: 0 };
  const L = 1.8;
  for (const sx of [-1, 1]) {
    const x = sx * (L / 2 - 0.12);
    // front leg, back leg, seat rail, back rail, armrest
    b.add(beam(V(x, 0, 0.2), V(x, 0.44, 0.17), 0.05, 0.04), null, iron);
    b.add(beam(V(x, 0, -0.24), V(x, 0.43, -0.2), 0.05, 0.04), null, iron);
    b.add(beam(V(x, 0.42, 0.24), V(x, 0.42, -0.24), 0.05, 0.045), null, iron);
    b.add(beam(V(x, 0.42, -0.2), V(x, 0.86, -0.32), 0.05, 0.04), null, iron);
    if (lod === 0) {
      b.add(beam(V(x, 0.64, 0.2), V(x, 0.64, -0.24), 0.045, 0.035), null, iron);
      b.add(beam(V(x, 0.44, 0.18), V(x, 0.64, 0.2), 0.04, 0.035), null, iron);
    }
  }
  // seat slats
  const nSeat = lod === 0 ? 5 : 2;
  for (let i = 0; i < nSeat; i++) {
    const z = 0.2 - (i * 0.44) / (nSeat - 1);
    b.add(box(L, 0.035, lod === 0 ? 0.075 : 0.2), mat(0, 0.46, z), wood);
  }
  // back slats (tilted)
  const nBack = lod === 0 ? 3 : 1;
  for (let i = 0; i < nBack; i++) {
    const t = nBack === 1 ? 0.5 : i / (nBack - 1);
    const y = 0.56 + t * 0.26, z = -0.23 - t * 0.075;
    b.add(box(L, lod === 0 ? 0.08 : 0.26, 0.03), mat(0, y, z, -0.27, 0, 0), wood);
  }
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Waste bin: Dutch city bin (painted body on a short post, rain hood with slot)
// ---------------------------------------------------------------------------------------------

export function buildBin(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const seg = lod === 0 ? 16 : 8;
  const paint = { color: 0xffffff, rough: 0.45, metal: 0.25, paint: 1 };
  b.add(cylinder(0.05, 0.06, 0.25, 8), null, { color: COL.darkGrey, rough: 0.5, metal: 0.5 });
  b.add(lathe([[0.0, 0.2], [0.23, 0.2], [0.25, 0.24], [0.27, 0.8], [0.28, 0.82], [0.28, 0.86]], seg), null, paint);
  // hood with dark slot
  b.add(lathe([[0.29, 0.86], [0.29, 0.9], [0.24, 0.97], [0.12, 1.0], [0.0, 1.01]], seg), null, paint);
  if (lod === 0) {
    b.add(box(0.26, 0.07, 0.08), mat(0, 0.9, 0.24, -0.4, 0, 0), { color: COL.black, rough: 0.8 });
    // vertical ribs
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      b.add(box(0.025, 0.56, 0.02), mat(Math.sin(a) * 0.268, 0.52, Math.cos(a) * 0.268, -0.03, a, 0), paint);
    }
    // small label plate
    b.add(box(0.14, 0.08, 0.01), mat(0, 0.62, 0.278), { color: COL.white, rough: 0.6 });
  }
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Bike rack "nietje": galvanised inverted U (plane = local XY, bikes park along x)
// ---------------------------------------------------------------------------------------------

export function buildRack(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const steel = { color: COL.galvanised, rough: 0.38, metal: 0.8 };
  const pts: THREE.Vector3[] = [V(-0.38, 0, 0), V(-0.38, 0.62, 0)];
  const n = lod === 0 ? 8 : 4;
  for (let i = 1; i < n; i++) {
    const a = Math.PI - (i / n) * Math.PI;
    pts.push(V(Math.cos(a) * 0.18 + (a > Math.PI / 2 ? -0.2 : 0.2), 0.62 + Math.sin(a) * 0.18, 0));
  }
  pts.push(V(0.38, 0.62, 0), V(0.38, 0, 0));
  b.add(sweep(pts, 0.03, lod === 0 ? 8 : 4), null, steel);
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Traffic light (Dutch): grey pole, black three-aspect head with black/white backboard, visors,
// a small cyclist head and a yellow push-button box. Faces +z. aEmit = signal slot.
// ---------------------------------------------------------------------------------------------

export function buildTrafficLight(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const seg = lod === 0 ? 12 : 6;
  b.add(cylinder(0.065, 0.075, 3.55, seg), null, { color: 0x6b7073, rough: 0.45, metal: 0.6 });
  b.add(cylinder(0.068, 0.068, 0.04, seg), mat(0, 3.55, 0), { color: COL.darkGrey, rough: 0.5, metal: 0.5 });
  const head = (y0: number, scale: number, withBoard: boolean) => {
    const s = scale;
    const zc = 0.16 * s;
    b.add(box(0.29 * s, 0.86 * s, 0.22 * s), mat(0, y0 + 0.43 * s, zc), { color: COL.black, rough: 0.55, metal: 0.2 });
    if (withBoard) {
      // black backboard with a white border on the front only
      const bw = 0.56 * s, bh = 1.12 * s, bz = zc - 0.12 * s, by = y0 + 0.43 * s, e = 0.035 * s;
      b.add(box(bw, bh, 0.015), mat(0, by, bz), { color: COL.black, rough: 0.6 });
      for (const sy of [-1, 1]) b.add(box(bw, e, 0.004), mat(0, by + sy * (bh / 2 - e / 2), bz + 0.0095), { color: COL.white, rough: 0.5 });
      for (const sx of [-1, 1]) b.add(box(e, bh, 0.004), mat(sx * (bw / 2 - e / 2), by, bz + 0.0095), { color: COL.white, rough: 0.5 });
    }
    // lenses red (top), amber, green
    const lens: [number, number][] = [[1, 0.71], [2, 0.43], [3, 0.15]];
    const lensCol = [0, 0x4a0603, 0x5a3002, 0x043a26]; // dark when off; lit via the signal shader
    for (const [slot, f] of lens) {
      const y = y0 + f * s;
      b.add(new THREE.CircleGeometry(0.1 * s, lod === 0 ? 16 : 8), mat(0, y, zc + 0.111 * s), { color: lensCol[slot], rough: 0.15, emit: slot });
      if (lod === 0) {
        // visor (hood): half cylinder open at the bottom
        const visor = new THREE.CylinderGeometry(0.115 * s, 0.115 * s, 0.14 * s, 10, 1, true, -Math.PI / 2, Math.PI);
        visor.rotateX(-Math.PI / 2);
        visor.translate(0, y, zc + 0.18 * s);
        b.add(visor, null, { color: COL.black, rough: 0.6 });
      }
    }
    // bracket to the pole
    b.add(box(0.08, 0.06, 0.2), mat(0, y0 + 0.75 * s, 0.06), { color: COL.darkGrey, rough: 0.5, metal: 0.5 });
    b.add(box(0.08, 0.06, 0.2), mat(0, y0 + 0.12 * s, 0.06), { color: COL.darkGrey, rough: 0.5, metal: 0.5 });
  };
  head(2.55, 1, true);
  if (lod === 0) {
    head(1.75, 0.55, false); // cyclist signal
    b.add(box(0.12, 0.2, 0.09), mat(0.0, 1.1, 0.1), { color: COL.yellow, rough: 0.5 });
    b.add(box(0.06, 0.06, 0.01), mat(0.0, 1.13, 0.15), { color: COL.black, rough: 0.5 });
  }
  return b.build();
}

// ---------------------------------------------------------------------------------------------

/**
 * LOD levels; a shadow-casting level uses the next coarser geometry as its shadow stand-in.
 * `near`: small objects cast into the nearest shadow cascade only.
 */
function lods(
  name: string, build: (lod: number) => THREE.BufferGeometry, dists: number[], shadow: boolean[],
  material = getFurnitureMaterial(), near = false,
): BatchLod[] {
  const geos = dists.map((_, i) => build(i));
  return dists.map((dist, i) => ({
    dist,
    parts: [{ geometry: geos[i], material, castShadow: shadow[i], receiveShadow: true, nearShadow: near }],
    shadowParts: shadow[i] && i + 1 < geos.length ? [{ geometry: geos[i + 1], material, nearShadow: near }] : undefined,
  }));
}

/** Build batches for lamps, bollards, benches, bins, racks and traffic lights; registers colliders. */
export function buildStreetProps(props: PropsData, colliders: Colliders, _anisotropy: number, ground: GroundFn = () => 0): PropBatch[] {
  const out: PropBatch[] = [];
  const lantern = new PropBatch({ name: 'lantaarn', lods: lods('lantaarn', buildLantern, [60, 260], [true, false]), cellSize: 64, margin: 6 });
  const modern = new PropBatch({ name: 'straatlicht', lods: lods('straatlicht', buildStreetLight, [70, 340], [true, false]), cellSize: 64, margin: 8 });
  for (const [x, z, rot, kind] of props.lamps ?? []) {
    if (kind === 1) {
      const gy = ground(x, z);
      modern.add(x, gy, z, rot);
      colliders.cylinder(x, z, 0.12, 4, gy, 'lamp');
    } else {
      const gy = ground(x, z);
      lantern.add(x, gy, z, rot + hash2(x, z, 3) * 0.2);
      colliders.cylinder(x, z, 0.16, 3.3, gy, 'lamp');
    }
  }
  out.push(lantern, modern);

  const bollards = new PropBatch({ name: 'paaltje', lods: lods('paaltje', buildBollard, [45, 150], [true, false], undefined, true), cellSize: 48, margin: 2 });
  for (const [x, z] of props.bollards ?? []) {
    const gy = ground(x, z);
    bollards.add(x, gy, z, hash2(x, z, 5) * Math.PI * 2);
    colliders.cylinder(x, z, 0.08, 1.05, gy, 'bollard');
  }
  out.push(bollards);

  const benches = new PropBatch({ name: 'bank', lods: lods('bank', buildBench, [40, 130], [true, false], undefined, true), cellSize: 64, margin: 2 });
  const c = new THREE.Vector3(), h = new THREE.Vector3(0.9, 0.45, 0.3);
  for (const [x, z, rot] of props.benches ?? []) {
    const gy = ground(x, z);
    benches.add(x, gy, z, rot);
    c.set(x - Math.sin(rot) * 0.03, gy + 0.45, z - Math.cos(rot) * 0.03);
    colliders.box(c, h, rot, 'bench');
  }
  out.push(benches);

  const bins = new PropBatch({ name: 'afvalbak', lods: lods('afvalbak', buildBin, [40, 130], [true, false], undefined, true), cellSize: 64, margin: 2, colors: true });
  const binCols = [new THREE.Color(COL.binGreen), new THREE.Color(0x4d5257), new THREE.Color(0x1e2a24)];
  for (const [x, z, rot] of props.bins ?? []) {
    const k = Math.floor(hash2(x, z, 6) * 10);
    const gy = ground(x, z);
    bins.add(x, gy, z, rot, 1, binCols[k < 6 ? 0 : k < 8 ? 2 : 1]);
    colliders.cylinder(x, z, 0.3, 1.0, gy, 'bin');
  }
  out.push(bins);

  const lights = new PropBatch({
    name: 'verkeerslicht',
    lods: lods('verkeerslicht', buildTrafficLight, [70, 260], [true, false], getSignalMaterial()),
    cellSize: 64,
    margin: 4,
  });
  for (const [x, z, rot] of props.trafficLights ?? []) {
    const gy = ground(x, z);
    lights.add(x, gy, z, rot);
    colliders.cylinder(x, z, 0.08, 3.6, gy, 'traffic_light');
  }
  out.push(lights);

  out.push(buildRacks(props, ground));
  return out.filter((b) => b.count > 0);
}

/**
 * Bike racks: PropsData has no explicit racks, so "nietjes" are placed under dense rows of parked
 * bicycles (every second bike in a row with neighbours closer than 1 m). Density-scaled.
 */
function buildRacks(props: PropsData, ground: GroundFn): PropBatch {
  const racks = new PropBatch({ name: 'fietsnietje', lods: lods('fietsnietje', buildRack, [35, 100], [true, false], undefined, true), cellSize: 48, margin: 2, density: true });
  const bikes = props.parkedBikes ?? [];
  const rng = new Rng(99);
  // grid hash for neighbour lookup
  const cell = 2;
  const grid = new Map<string, number[]>();
  bikes.forEach(([x, z], i) => {
    const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  });
  const used = new Uint8Array(bikes.length);
  bikes.forEach(([x, z, rot], i) => {
    if (used[i]) return;
    let near = 0;
    const gx = Math.floor(x / cell), gz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
        if (j === i) continue;
        const d = Math.hypot(bikes[j][0] - x, bikes[j][1] - z);
        if (d < 1.0) { near++; used[j] = 1; }
      }
    }
    if (near >= 1 && rng.chance(0.85)) {
      // rack runs along the bike (in the bike's plane), next to it
      const sx = Math.cos(rot) * 0.22, sz = -Math.sin(rot) * 0.22;
      racks.add(x + sx, ground(x, z), z + sz, rot + Math.PI / 2);
    }
  });
  return racks;
}
