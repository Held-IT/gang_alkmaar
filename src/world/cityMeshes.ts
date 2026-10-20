// Turns parsed chunk primitives into renderable meshes and culls them.
//
// Draw calls are the scarce resource (ARCHITECTURE budget <= 700 incl. shadow passes): every
// 200 m ground chunk has up to ~17 material primitives. Chunks are therefore merged per
// material into "super-chunks" of S x S chunks (S configurable per category). Each resulting
// mesh gets a tight bounding box/sphere (three's frustum culling + front-to-back sorting) and
// a per-material maximum view distance: small details (road paint, railings, curbs) disappear
// long before the big surfaces, and nothing is drawn past quality.drawDistance.
import * as THREE from 'three';
import type { MaterialClass, QualityLevel, QualitySettings } from '../contracts';
import type { GlbPrimitive } from './loaders/glb';
import { WATER_LEVEL } from '../config';

export type CityCategory = 'building' | 'ground' | 'backdrop' | 'groundBackdrop';

export interface CityMesh {
  mesh: THREE.Mesh;
  cls: MaterialClass;
  category: CityCategory;
  key: string;
  /** world-space AABB */
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  triangles: number;
  /** current max view distance (m), Infinity = always */
  maxDist: number;
}

/**
 * Max view distance per detail material at quality 'hoog' (scaled per level, capped by
 * drawDistance). Materials not listed use the full drawDistance.
 */
const DETAIL_DIST: Partial<Record<MaterialClass, number>> = {
  road_marking: 280,
  bridge_rail: 400,
  curb: 450,
  quay_cap: 550,
  bikelane: 900,
  parking: 900,
};
/**
 * Ground materials with few triangles per 200 m chunk: twice as coarse super-chunks (fewer draw
 * calls; their meshes stay small anyway).
 */
const COARSE_GROUND = new Set<string>([
  'asphalt', 'ground', 'square', 'parking', 'bikelane', 'canal_bed', 'quay', 'quay_cap', 'bridge_deck', 'road_marking',
]);
export function groundSuperChunk(cls: string, base: number): number {
  return COARSE_GROUND.has(cls) ? base * 2 : base;
}
/** The canal bed is only visible from below the (opaque) water surface. */
const CANAL_BED_MAX_CAM_Y = WATER_LEVEL + 1.0;
const LEVEL_SCALE: Record<QualityLevel, number> = { laag: 0.65, midden: 0.85, hoog: 1, ultra: 1.35 };

/** Chunk grid indices from a chunk name like "ground_10_7" / "buildings_10_7". */
export function chunkIndexOf(name: string): { i: number; j: number } | null {
  const m = /_(\d+)_(\d+)(?:\.glb)?$/.exec(name);
  return m ? { i: Number(m[1]), j: Number(m[2]) } : null;
}

/** Concatenates primitives (same material) into one primitive (a single one is returned as is). */
export function mergeToPrimitive(pieces: readonly GlbPrimitive[]): GlbPrimitive {
  if (pieces.length === 1) return pieces[0];
  let vtx = 0, idx = 0;
  let hasNormal = true, hasUv = true, hasUv1 = true, hasColor = true;
  for (const p of pieces) {
    vtx += p.vertexCount;
    idx += p.index.length;
    hasNormal &&= !!p.normal;
    hasUv &&= !!p.uv;
    hasUv1 &&= !!p.uv1;
    hasColor &&= !!p.color;
  }
  const position = new Float32Array(vtx * 3);
  const normal = hasNormal ? new Float32Array(vtx * 3) : null;
  const uv = hasUv ? new Float32Array(vtx * 2) : null;
  const uv1 = hasUv1 ? new Float32Array(vtx * 2) : null;
  const color = hasColor ? new Uint8Array(vtx * 4) : null;
  const index = new Uint32Array(idx);
  let vo = 0, io = 0;
  for (const p of pieces) {
    position.set(p.position, vo * 3);
    if (normal && p.normal) normal.set(p.normal, vo * 3);
    if (uv && p.uv) uv.set(p.uv, vo * 2);
    if (uv1 && p.uv1) uv1.set(p.uv1, vo * 2);
    if (color && p.color) color.set(p.color, vo * 4);
    const src = p.index;
    if (vo === 0) index.set(src, io);
    else for (let k = 0; k < src.length; k++) index[io + k] = src[k] + vo;
    vo += p.vertexCount;
    io += src.length;
  }
  return { material: pieces[0]?.material ?? 'ground', node: pieces[0]?.node ?? '', vertexCount: vtx, position, normal, uv, uv1, color, index };
}

/** Builds an indexed BufferGeometry (with bounds) from primitives of one material. */
export function mergePrimitives(pieces: readonly GlbPrimitive[]): THREE.BufferGeometry {
  const p = mergeToPrimitive(pieces);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
  if (p.uv) geo.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  if (p.uv1) geo.setAttribute('uv1', new THREE.BufferAttribute(p.uv1, 2));
  if (p.color) geo.setAttribute('color', new THREE.BufferAttribute(p.color, 4, true));
  geo.setIndex(new THREE.BufferAttribute(p.index, 1));
  if (p.normal) geo.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
  else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Splits a primitive into square cells (by triangle centroid) so large meshes (the city-wide
 * water, the backdrop ring) can be frustum culled. Returns compact primitives keyed "ix_iz".
 */
export function splitByGrid(p: GlbPrimitive, cell: number): Map<string, GlbPrimitive> {
  const P = p.position, I = p.index;
  const tris = new Map<string, number[]>();
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const key = `${Math.floor(cx / cell)}_${Math.floor(cz / cell)}`;
    let list = tris.get(key);
    if (!list) tris.set(key, (list = []));
    list.push(t);
  }
  const out = new Map<string, GlbPrimitive>();
  const stamp = new Int32Array(p.vertexCount).fill(-1);
  const remap = new Uint32Array(p.vertexCount);
  let g = 0;
  for (const [key, list] of tris) {
    const verts: number[] = [];
    const index = new Uint32Array(list.length * 3);
    let w = 0;
    for (const t of list) {
      for (let k = 0; k < 3; k++) {
        const v = I[t + k];
        if (stamp[v] !== g) {
          stamp[v] = g;
          remap[v] = verts.length;
          verts.push(v);
        }
        index[w++] = remap[v];
      }
    }
    const n = verts.length;
    const pick = <T extends Float32Array | Uint8Array>(src: T | null, size: number, make: (len: number) => T): T | null => {
      if (!src) return null;
      const dst = make(n * size);
      for (let i = 0; i < n; i++) for (let s = 0; s < size; s++) dst[i * size + s] = src[verts[i] * size + s];
      return dst;
    };
    const f32 = (len: number) => new Float32Array(len);
    out.set(key, {
      material: p.material,
      node: `${p.node}:${key}`,
      vertexCount: n,
      position: pick(p.position, 3, f32)!,
      normal: pick(p.normal, 3, f32),
      uv: pick(p.uv, 2, f32),
      uv1: pick(p.uv1, 2, f32),
      color: pick(p.color, 4, (len) => new Uint8Array(len)),
      index,
    });
    g++;
  }
  return out;
}

function releaseArray(this: THREE.BufferAttribute): void {
  // after the GPU upload the CPU copy is not needed (no CPU raycasts against city meshes)
  (this as unknown as { array: ArrayLike<number> | null }).array = null;
}

/** Drops the CPU copies of a static geometry once it has been uploaded to the GPU. */
export function freeAfterUpload(geo: THREE.BufferGeometry): void {
  for (const name of Object.keys(geo.attributes)) (geo.attributes[name] as THREE.BufferAttribute).onUpload(releaseArray);
  geo.index?.onUpload(releaseArray);
}

const noRaycast = (): void => {};

export function createCityMesh(
  geo: THREE.BufferGeometry,
  material: THREE.Material,
  cls: MaterialClass,
  category: CityCategory,
  key: string,
  opts: { castShadow: boolean; receiveShadow: boolean; freeCpu: boolean },
): CityMesh {
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = key;
  mesh.castShadow = opts.castShadow;
  mesh.receiveShadow = opts.receiveShadow;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  if (opts.freeCpu) {
    mesh.raycast = noRaycast;
    freeAfterUpload(geo);
  }
  const bb = geo.boundingBox ?? new THREE.Box3();
  return {
    mesh, cls, category, key,
    minX: bb.min.x, minY: bb.min.y, minZ: bb.min.z,
    maxX: bb.max.x, maxY: bb.max.y, maxZ: bb.max.z,
    triangles: (geo.index ? geo.index.count : geo.attributes.position.count) / 3,
    maxDist: Infinity,
  };
}

/** Distance culling of city meshes (three does the frustum part). */
export class CityCuller {
  readonly list: CityMesh[] = [];
  private last = new THREE.Vector3(1e9, 1e9, 1e9);
  private dirty = true;
  visibleCount = 0;
  visibleTriangles = 0;

  add(m: CityMesh): void {
    this.list.push(m);
    this.dirty = true;
  }

  /** Recomputes the per-mesh max distance for the given quality settings. */
  applyQuality(q: Readonly<QualitySettings>): void {
    const scale = LEVEL_SCALE[q.level] ?? 1;
    const draw = q.drawDistance * 1.05; // the aerial fog is ~93 % at 1.05 x drawDistance
    for (const m of this.list) {
      if (m.category === 'backdrop' || m.category === 'groundBackdrop' || m.cls === 'water') {
        m.maxDist = Infinity;
        continue;
      }
      const detail = DETAIL_DIST[m.cls];
      m.maxDist = detail !== undefined ? Math.min(detail * scale, draw) : draw;
    }
    this.dirty = true;
  }

  update(cam: THREE.Vector3, force = false): void {
    // re-evaluate after 1 m of movement (or crossing the water level for the canal bed)
    if (!force && !this.dirty && cam.distanceToSquared(this.last) < 1 && (cam.y < CANAL_BED_MAX_CAM_Y) === (this.last.y < CANAL_BED_MAX_CAM_Y)) return;
    this.last.copy(cam);
    this.dirty = false;
    let n = 0, tris = 0;
    for (const m of this.list) {
      let vis = true;
      if (m.cls === 'canal_bed') vis = cam.y < CANAL_BED_MAX_CAM_Y;
      if (vis && m.maxDist !== Infinity) {
        const dx = Math.max(m.minX - cam.x, 0, cam.x - m.maxX);
        const dy = Math.max(m.minY - cam.y, 0, cam.y - m.maxY);
        const dz = Math.max(m.minZ - cam.z, 0, cam.z - m.maxZ);
        vis = dx * dx + dy * dy + dz * dz <= m.maxDist * m.maxDist;
      }
      m.mesh.visible = vis;
      if (vis) {
        n++;
        tris += m.triangles;
      }
    }
    this.visibleCount = n;
    this.visibleTriangles = tris;
  }
}
