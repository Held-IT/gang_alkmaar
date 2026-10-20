// Parked cars at props.parkedCars slots: deterministic occupancy/spec/colour per slot (by hash),
// static box colliders (COLLISION_GROUPS.traffic on one fixed body, so ground ray casts ignore
// them), and per-frame instanced drawing of the slots near the camera (LOD1 near, LOD2 far).
//
// Colliders are streamed per 32 m cell around the focus (the player car): Rapier 0.21 pays per
// collider on every world.step() (World.step maps all collider handles each step), so ~2000
// city-wide parked-car boxes made each step ~3.5x slower and produced a lot of garbage. Only the
// cells within `colliderRadius` are live (removed beyond radius + one cell, hysteresis).
import * as THREE from 'three';
import type { PhysicsWorld } from '../contracts';
import { COLLISION_GROUPS } from '../physics/physics';
import { CarRenderer, TRAFFIC_MIX, composeCarMatrix, pickPaint } from './carRender';
import { LOD_FAR, LOD_NEAR } from './cars';
import { hash01, pickWeighted } from './rng';
import type { HeightFn } from './paths';

const CELL = 32;

export class ParkedCars {
  readonly n: number;
  private readonly xz: Float32Array;
  private readonly rot: Float32Array;
  private readonly spec: Uint8Array;
  private readonly occupied: Uint8Array;
  private readonly lod: Uint8Array;
  private readonly colors: Float32Array;
  private readonly mats: Float32Array;
  private readonly matReady: Uint8Array;
  private readonly cells = new Map<number, number[]>();
  private cand = new Int32Array(0);
  private candN = 0;
  private candX = 1e9;
  private candZ = 1e9;
  private body: any = null;
  /** cell key -> live Rapier colliders of that cell */
  private readonly liveCells = new Map<number, any[]>();
  private colFx = Infinity;
  private colFz = Infinity;
  private disposed = false;
  /** colliders currently in the Rapier world */
  liveColliders = 0;
  private readonly color = new THREE.Color();
  density = 1;
  drawn = 0;
  occupiedCount = 0;

  constructor(
    slots: [number, number, number][],
    private readonly renderer: CarRenderer,
    private readonly physics: PhysicsWorld | null,
    private readonly heightFn: HeightFn,
    private readonly range: number,
    /** parked-car colliders exist only within this distance of the focus (m) */
    readonly colliderRadius = 72,
  ) {
    this.n = slots.length;
    this.xz = new Float32Array(this.n * 2);
    this.rot = new Float32Array(this.n);
    this.spec = new Uint8Array(this.n);
    this.occupied = new Uint8Array(this.n);
    this.lod = new Uint8Array(this.n).fill(2);
    this.colors = new Float32Array(this.n * 3);
    this.mats = new Float32Array(this.n * 16);
    this.matReady = new Uint8Array(this.n);
    const specIds = renderer.specs.map((s) => s.id);
    const cum: number[] = [];
    let acc = 0;
    for (const id of specIds) {
      acc += TRAFFIC_MIX.find((m) => m.id === id)?.parkedW ?? 1;
      cum.push(acc);
    }
    for (let i = 0; i < this.n; i++) {
      const [x, z, r] = slots[i];
      // small natural misalignment
      const jl = (hash01(i, 11) - 0.5) * 0.16;
      this.xz[i * 2] = x + Math.cos(r) * jl;
      this.xz[i * 2 + 1] = z - Math.sin(r) * jl;
      this.rot[i] = r + (hash01(i, 12) - 0.5) * 0.05;
      const si = pickWeighted(cum, hash01(i, 13));
      this.spec[i] = si;
      pickPaint(specIds[si], hash01(i, 14), this.color);
      this.colors[i * 3] = this.color.r;
      this.colors[i * 3 + 1] = this.color.g;
      this.colors[i * 3 + 2] = this.color.b;
      const key = this.cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(i);
    }
    this.cand = new Int32Array(this.n);
  }

  private cellKey(cx: number, cz: number): number {
    return (cx + 1000) * 4096 + (cz + 1000);
  }

  /** Occupancy fraction follows the traffic density (busy town: most slots are taken). */
  setDensity(d: number): void {
    this.density = d;
    const frac = 0.5 + 0.45 * Math.max(0, Math.min(1, d));
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      this.occupied[i] = hash01(i, 21) < frac ? 1 : 0;
      count += this.occupied[i];
    }
    this.occupiedCount = count;
    // occupancy changed: rebuild the live collider cells
    this.clearColliders();
    if (Number.isFinite(this.colFx)) this.updateColliders(this.colFx, this.colFz, true);
    this.candX = 1e9; // force candidate refresh
  }

  /** Squared distance from (x, z) to the square of cell `key`. */
  private cellDist2(key: number, x: number, z: number): number {
    const x0 = (Math.floor(key / 4096) - 1000) * CELL;
    const z0 = ((key % 4096) - 1000) * CELL;
    const dx = x < x0 ? x0 - x : x > x0 + CELL ? x - x0 - CELL : 0;
    const dz = z < z0 ? z0 - z : z > z0 + CELL ? z - z0 - CELL : 0;
    return dx * dx + dz * dz;
  }

  /**
   * Streams the parked-car colliders around (x, z): cells within colliderRadius are added, cells
   * beyond colliderRadius + one cell removed. Returns at once when the focus moved less than 4 m.
   */
  updateColliders(x: number, z: number, force = false): void {
    const ph = this.physics;
    if (this.disposed || !ph || !ph.RAPIER || !ph.world || !Number.isFinite(x + z)) return;
    const mx = x - this.colFx;
    const mz = z - this.colFz;
    if (!force && mx * mx + mz * mz < 16) return;
    this.colFx = x;
    this.colFz = z;
    const world = ph.world;
    const rIn = this.colliderRadius;
    const rOut = rIn + CELL;
    try {
      for (const [key, list] of this.liveCells) {
        if (this.cellDist2(key, x, z) <= rOut * rOut) continue;
        for (const c of list) world.removeCollider(c, false);
        this.liveColliders -= list.length;
        this.liveCells.delete(key);
      }
      const c0x = Math.floor((x - rIn) / CELL);
      const c1x = Math.floor((x + rIn) / CELL);
      const c0z = Math.floor((z - rIn) / CELL);
      const c1z = Math.floor((z + rIn) / CELL);
      for (let i = c0x; i <= c1x; i++) {
        for (let j = c0z; j <= c1z; j++) {
          const key = this.cellKey(i, j);
          if (this.liveCells.has(key)) continue;
          const slots = this.cells.get(key);
          if (!slots || this.cellDist2(key, x, z) > rIn * rIn) continue;
          const list: any[] = [];
          for (const k of slots) if (this.occupied[k]) list.push(this.createCollider(k));
          this.liveCells.set(key, list);
          this.liveColliders += list.length;
        }
      }
    } catch (e) {
      console.warn('[traffic] parked car colliders failed', e);
    }
  }

  private createCollider(i: number): any {
    const ph = this.physics!;
    const R = ph.RAPIER;
    if (!this.body) this.body = ph.world.createRigidBody(R.RigidBodyDesc.fixed());
    const s = this.renderer.specs[this.spec[i]];
    const y = this.height(i);
    const hh = (s.height - 0.25) * 0.5;
    const h = this.rot[i] * 0.5;
    const cd = R.ColliderDesc.cuboid(s.width * 0.48, hh, s.length * 0.48)
      .setTranslation(this.xz[i * 2], y + 0.25 + hh, this.xz[i * 2 + 1])
      .setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) })
      .setCollisionGroups(COLLISION_GROUPS.traffic)
      .setFriction(0.6);
    return ph.world.createCollider(cd, this.body);
  }

  /** Removes every live parked-car collider (the next updateColliders call adds them again). */
  private clearColliders(): void {
    const world = this.physics?.world;
    try {
      if (world) for (const list of this.liveCells.values()) for (const c of list) world.removeCollider(c, false);
    } catch { /* world gone */ }
    this.liveCells.clear();
    this.liveColliders = 0;
  }

  private heights: Float32Array | null = null;
  private height(i: number): number {
    if (!this.heights) this.heights = new Float32Array(this.n).fill(NaN);
    let y = this.heights[i];
    if (Number.isNaN(y)) {
      y = this.heightFn(this.xz[i * 2], this.xz[i * 2 + 1]);
      if (!Number.isFinite(y) || y < -0.5 || y > 1.5) y = 0;
      this.heights[i] = y;
    }
    return y;
  }

  private refreshCandidates(cx: number, cz: number): void {
    this.candX = cx;
    this.candZ = cz;
    let n = 0;
    const r = this.range;
    const c0x = Math.floor((cx - r) / CELL);
    const c1x = Math.floor((cx + r) / CELL);
    const c0z = Math.floor((cz - r) / CELL);
    const c1z = Math.floor((cz + r) / CELL);
    for (let i = c0x; i <= c1x; i++) {
      for (let j = c0z; j <= c1z; j++) {
        const list = this.cells.get(this.cellKey(i, j));
        if (!list) continue;
        for (const k of list) {
          if (!this.occupied[k]) continue;
          const dx = this.xz[k * 2] - cx;
          const dz = this.xz[k * 2 + 1] - cz;
          if (dx * dx + dz * dz < r * r) this.cand[n++] = k;
        }
      }
    }
    this.candN = n;
  }

  /** Pushes the visible parked cars to the renderer (call between renderer.begin/end). */
  render(): void {
    const r = this.renderer;
    const cam = r.camPos;
    if (Math.hypot(cam.x - this.candX, cam.z - this.candZ) > 12) this.refreshCandidates(cam.x, cam.z);
    let drawn = 0;
    for (let k = 0; k < this.candN; k++) {
      const i = this.cand[k];
      const x = this.xz[i * 2];
      const z = this.xz[i * 2 + 1];
      const s = r.specs[this.spec[i]];
      if (!r.visible(x, 0.8, z, s.length * 0.5 + 1.2)) continue;
      if (!this.matReady[i]) {
        composeCarMatrix(this.mats, i * 16, x, this.height(i), z, this.rot[i], 0);
        this.matReady[i] = 1;
      }
      const d = Math.hypot(x - cam.x, z - cam.z, cam.y);
      const lod = this.lod[i] === 1 ? (d > LOD_FAR ? 2 : 1) : d < LOD_NEAR ? 1 : 2;
      this.lod[i] = lod;
      this.color.setRGB(this.colors[i * 3], this.colors[i * 3 + 1], this.colors[i * 3 + 2]);
      if (r.push(this.spec[i], lod as 1 | 2, this.mats, i * 16, this.color, 0, 0, 0)) drawn++;
    }
    this.drawn = drawn;
  }

  dispose(): void {
    const ph = this.physics;
    if (ph?.world) {
      try {
        if (this.body) ph.world.removeRigidBody(this.body);
      } catch { /* world gone */ }
    }
    this.body = null;
    this.liveCells.clear();
    this.liveColliders = 0;
    this.colFx = this.colFz = Infinity;
    this.disposed = true;
  }
}
