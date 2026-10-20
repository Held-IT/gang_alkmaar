// Static collision for the city: ground (split per surface type so the vehicle gets a surface
// tag + grip multiplier per wheel), buildings and invisible boundary walls.
//
// collision_ground.bin has no surface information. Every triangle is classified by sampling the
// height/surface grid (rasterised from the ground GLB meshes) at the triangle centroid:
//   - steep triangles  -> 'curb' (low faces) or 'wall' (quay walls, bridge bodies, banks)
//   - flat triangles   -> the MaterialClass in the grid cell when its height matches,
//                         otherwise 'canal_bed' (below the water) or 'ground'.
// Triangles are then grouped per tag and each group becomes one compact Rapier trimesh.
import * as THREE from 'three';
import type { PhysicsWorld, Rect } from '../../contracts';
import { HeightGrid, SURFACE_CLASSES } from '../heightGrid';

export interface CollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Parses the ARCHITECTURE 4.4 binary format. */
export function parseCollisionBin(buf: ArrayBuffer): CollisionMesh {
  const dv = new DataView(buf);
  const vc = dv.getUint32(0, true);
  const ic = dv.getUint32(4, true);
  if (8 + vc * 12 + ic * 4 > buf.byteLength) throw new Error('collision bin te kort');
  return {
    positions: new Float32Array(buf, 8, vc * 3),
    indices: new Uint32Array(buf, 8 + vc * 12, ic),
  };
}

/** Physics tag + grip multiplier per ground surface (vehicle: friction = grip multiplier). */
export const SURFACE_PHYSICS: Record<string, { tag: string; friction: number }> = {
  asphalt: { tag: 'asphalt', friction: 1.0 },
  road_marking: { tag: 'asphalt', friction: 1.0 },
  bikelane: { tag: 'bikelane', friction: 1.0 },
  parking: { tag: 'parking', friction: 0.97 },
  klinkers: { tag: 'klinkers', friction: 0.95 },
  square: { tag: 'square', friction: 0.92 },
  sidewalk: { tag: 'sidewalk', friction: 0.97 },
  curb: { tag: 'curb', friction: 1.0 },
  quay_cap: { tag: 'sidewalk', friction: 0.95 },
  bridge_deck: { tag: 'bridge_deck', friction: 0.95 },
  bridge_side: { tag: 'wall', friction: 0.6 },
  bridge_rail: { tag: 'wall', friction: 0.6 },
  quay: { tag: 'wall', friction: 0.6 },
  grass: { tag: 'grass', friction: 0.6 },
  ground: { tag: 'ground', friction: 0.8 },
  canal_bed: { tag: 'canal_bed', friction: 0.5 },
  water: { tag: 'canal_bed', friction: 0.5 },
  wall: { tag: 'wall', friction: 0.6 },
};

export interface GroundCollisionStats {
  /** triangles per tag */
  tags: Record<string, number>;
  ms: number;
}

/**
 * Adds the ground collision as one trimesh per surface tag. Without a grid everything goes into
 * a single 'ground' trimesh.
 */
export function addGroundCollision(physics: PhysicsWorld, mesh: CollisionMesh, grid: HeightGrid | null): GroundCollisionStats {
  const t0 = performance.now();
  const { positions: P, indices: I } = mesh;
  const triCount = Math.floor(I.length / 3);
  const tagNames: string[] = [];
  const tagIndex = new Map<string, number>();
  const tagOfTri = new Uint8Array(triCount);
  const classify = (tag: string): number => {
    let k = tagIndex.get(tag);
    if (k === undefined) {
      k = tagNames.length;
      tagNames.push(tag);
      tagIndex.set(tag, k);
    }
    return k;
  };
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az;
    const vx = P[c] - ax, vy = P[c + 1] - ay, vz = P[c + 2] - az;
    const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
    const len = Math.sqrt(nX * nX + nY * nY + nZ * nZ) || 1;
    const cx = ax + (ux + vx) / 3, cy = ay + (uy + vy) / 3, cz = az + (uz + vz) / 3;
    let tag: string;
    if (Math.abs(nY) < 0.5 * len) {
      const yMax = Math.max(ay, ay + uy, ay + vy);
      const yMin = Math.min(ay, ay + uy, ay + vy);
      tag = yMax <= 0.4 && yMin >= -0.4 ? 'curb' : 'wall';
    } else if (grid) {
      const gh = grid.rawHeightAt(cx, cz);
      const cls = SURFACE_CLASSES[grid.surfaceIdAt(cx, cz)];
      if (gh !== null && cls && Math.abs(gh - cy) < 0.3) tag = SURFACE_PHYSICS[cls]?.tag ?? 'ground';
      else tag = cy < -1.0 ? 'canal_bed' : 'ground';
    } else {
      tag = cy < -1.0 ? 'canal_bed' : 'ground';
    }
    tagOfTri[t] = classify(tag);
  }

  // one compact trimesh per tag
  const vertCount = P.length / 3;
  const stamp = new Int32Array(vertCount).fill(-1);
  const remap = new Uint32Array(vertCount);
  const stats: Record<string, number> = {};
  const friction = (tag: string): number => {
    for (const k in SURFACE_PHYSICS) if (SURFACE_PHYSICS[k].tag === tag) return SURFACE_PHYSICS[k].friction;
    return 1;
  };
  for (let g = 0; g < tagNames.length; g++) {
    let n = 0;
    for (let t = 0; t < triCount; t++) if (tagOfTri[t] === g) n++;
    if (n === 0) continue;
    const idx = new Uint32Array(n * 3);
    const verts: number[] = [];
    let w = 0;
    let vcount = 0;
    for (let t = 0; t < triCount; t++) {
      if (tagOfTri[t] !== g) continue;
      for (let k = 0; k < 3; k++) {
        const v = I[t * 3 + k];
        if (stamp[v] !== g) {
          stamp[v] = g;
          remap[v] = vcount++;
          verts.push(v);
        }
        idx[w++] = remap[v];
      }
    }
    const pos = new Float32Array(vcount * 3);
    for (let i = 0; i < vcount; i++) {
      const v = verts[i] * 3;
      pos[i * 3] = P[v];
      pos[i * 3 + 1] = P[v + 1];
      pos[i * 3 + 2] = P[v + 2];
    }
    physics.addStaticTrimesh(pos, idx, { tag: tagNames[g], friction: friction(tagNames[g]) });
    stats[tagNames[g]] = n;
  }
  return { tags: stats, ms: Math.round(performance.now() - t0) };
}

/** Building walls (collision_buildings.bin) as one trimesh. */
export function addBuildingCollision(physics: PhysicsWorld, mesh: CollisionMesh): void {
  // copy: the views may point into a larger buffer that should be released
  physics.addStaticTrimesh(mesh.positions.slice(), mesh.indices.slice(), { tag: 'building', friction: 0.4 });
}

/** Invisible walls just outside the playable rect keep the player inside it. */
export function addBoundaryWalls(physics: PhysicsWorld, r: Rect, height = 60, thickness = 4): void {
  const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
  const hx = (r.maxX - r.minX) / 2 + thickness, hz = (r.maxZ - r.minZ) / 2 + thickness;
  const hy = height / 2, y = hy - 10;
  const t = thickness / 2;
  const half = new THREE.Vector3();
  const c = new THREE.Vector3();
  physics.addStaticBox(c.set(cx, y, r.minZ - t), half.set(hx, hy, t), 0, 'boundary');
  physics.addStaticBox(c.set(cx, y, r.maxZ + t), half.set(hx, hy, t), 0, 'boundary');
  physics.addStaticBox(c.set(r.minX - t, y, cz), half.set(t, hy, hz), 0, 'boundary');
  physics.addStaticBox(c.set(r.maxX + t, y, cz), half.set(t, hy, hz), 0, 'boundary');
}
