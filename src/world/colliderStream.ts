// Streamed static prop colliders.
//
// Rapier 0.21 pays per static collider on every world.step(), even when nothing moves near it:
// measured on the dev CPU ~0.22 ms per substep per 1000 colliders (10 000 parentless cylinders
// = 2.2 ms per substep, an empty world 0.0 ms). The props alone register ~13 000 posts, trees,
// bollards and boxes, which made physics the largest CPU cost of a frame (2-5 substeps).
//
// This sink has the PhysicsWorld collider methods (addStaticCylinder / addStaticBox, same
// shapes, friction, restitution, collision groups and tags as src/physics), records every
// collider in a grid of cells and only keeps the cells within `radius` of the focus point
// (the camera / car) in the Rapier world. Cells are added when they come within `radius` and
// removed beyond `radius + cell` (hysteresis), checked when the focus moved a few metres.
import type * as THREE from 'three';
import type { PhysicsWorld } from '../contracts';
import { COLLISION_GROUPS } from '../physics/physics';

const KIND_CYLINDER = 0;
const KIND_BOX = 1;
/** floats per record: kind, x, y, z, a, b, c, rotY (cylinder: a = half height, b = radius) */
const STRIDE = 8;

interface RapierCollider { handle: number }

export interface StreamedCollidersOptions {
  /** cell size in metres (default 48) */
  cell?: number;
  /** keep colliders within this distance of the focus (default 160 m) */
  radius?: number;
}

export class StreamedColliders {
  readonly cell: number;
  readonly radius: number;
  private rec: number[] = [];
  private tags: string[] = [];
  /** cell key -> record indices */
  private cells = new Map<number, number[]>();
  /** cell key -> live colliders */
  private live = new Map<number, RapierCollider[]>();
  private fx = Infinity;
  private fz = Infinity;
  private liveCount = 0;
  private disposed = false;

  constructor(private readonly physics: PhysicsWorld, opts: StreamedCollidersOptions = {}) {
    this.cell = opts.cell ?? 48;
    this.radius = opts.radius ?? 160;
  }

  /** Number of recorded colliders / colliders currently in the Rapier world. */
  get total(): number {
    return this.tags.length;
  }
  get active(): number {
    return this.liveCount;
  }

  addStaticCylinder(x: number, z: number, radius: number, height: number, y0 = 0, tag = 'post'): void {
    this.add(KIND_CYLINDER, x, y0 + height / 2, z, height / 2, radius, 0, 0, tag);
  }

  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, rotationY = 0, tag = 'box'): void {
    this.add(KIND_BOX, center.x, center.y, center.z, halfExtents.x, halfExtents.y, halfExtents.z, rotationY, tag);
  }

  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }

  private add(kind: number, x: number, y: number, z: number, a: number, b: number, c: number, rot: number, tag: string): void {
    if (!Number.isFinite(x + y + z + a + b + c + rot)) return;
    const idx = this.tags.length;
    this.rec.push(kind, x, y, z, a, b, c, rot);
    this.tags.push(tag);
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(idx);
    // a cell that is already live gets its late arrivals (boats) right away
    const live = this.live.get(k);
    if (live) live.push(this.create(idx));
  }

  private create(idx: number): RapierCollider {
    const R = this.physics.RAPIER;
    const o = idx * STRIDE;
    const r = this.rec;
    let desc;
    if (r[o] === KIND_CYLINDER) {
      desc = R.ColliderDesc.cylinder(r[o + 4], r[o + 5]).setTranslation(r[o + 1], r[o + 2], r[o + 3]);
      desc.setFriction(0.6);
      desc.setRestitution(0.1);
    } else {
      desc = R.ColliderDesc.cuboid(r[o + 4], r[o + 5], r[o + 6]).setTranslation(r[o + 1], r[o + 2], r[o + 3]);
      const rot = r[o + 7];
      if (rot !== 0) {
        const s = Math.sin(rot / 2);
        desc.setRotation({ x: 0, y: s, z: 0, w: Math.cos(rot / 2) });
      }
      desc.setFriction(0.8);
      desc.setRestitution(0.05);
    }
    desc.setCollisionGroups(COLLISION_GROUPS.staticWorld);
    const col = this.physics.world.createCollider(desc) as RapierCollider;
    (this.physics as { setTag?: (h: number, t: string) => void }).setTag?.(col.handle, this.tags[idx]);
    this.liveCount++;
    return col;
  }

  /** Streams cells in/out around (x, z). Cheap when the focus moved less than a few metres. */
  update(x: number, z: number, force = false): void {
    if (this.disposed) return;
    const dx = x - this.fx, dz = z - this.fz;
    if (!force && dx * dx + dz * dz < 16) return;
    this.fx = x;
    this.fz = z;
    const cs = this.cell;
    const rIn = this.radius;
    const rOut = this.radius + cs;
    // remove far cells
    for (const [k, cols] of this.live) {
      const ci = Math.floor(k / 65536) - 32768, cj = (k % 65536) - 32768;
      if (cellDist(ci, cj, cs, x, z) > rOut) {
        for (const c of cols) this.physics.world.removeCollider(c, false);
        this.liveCount -= cols.length;
        this.live.delete(k);
      }
    }
    // add near cells
    const i0 = Math.floor((x - rIn) / cs), i1 = Math.floor((x + rIn) / cs);
    const j0 = Math.floor((z - rIn) / cs), j1 = Math.floor((z + rIn) / cs);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = this.key(i, j);
        if (this.live.has(k)) continue;
        const list = this.cells.get(k);
        if (!list || cellDist(i, j, cs, x, z) > rIn) continue;
        const cols: RapierCollider[] = [];
        for (const idx of list) cols.push(this.create(idx));
        this.live.set(k, cols);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      for (const cols of this.live.values()) for (const c of cols) this.physics.world.removeCollider(c, false);
    } catch {
      // the physics world may already be freed
    }
    this.live.clear();
    this.liveCount = 0;
  }
}

/** Distance from (x, z) to the nearest point of cell (i, j). */
function cellDist(i: number, j: number, cs: number, x: number, z: number): number {
  const ddx = Math.max(i * cs - x, 0, x - (i + 1) * cs);
  const ddz = Math.max(j * cs - z, 0, z - (j + 1) * cs);
  return Math.sqrt(ddx * ddx + ddz * ddz);
}
