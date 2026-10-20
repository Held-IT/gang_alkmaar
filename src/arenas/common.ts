// Shared building blocks of the three arenas: an ArenaKit that owns every Rapier body / collider /
// mesh an arena creates (so dispose() can remove them again), dynamic props synced to their bodies,
// kinematic hazards driven per physics sub-step with interpolated visuals, a scan of the beast
// bodies (the arena does not know the BeastSystem), convex area polygons for isOut / edgeDistance /
// clampToArea, an instanced cheering crowd (procedural people from src/traffic), Dutch crowd
// barriers ("dranghekken"), Gouda cheese wheels and porters' barrows ("draagberries"), canvas signs
// and a few synthesized sounds (boat horn, bell, creak).
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Engine, PhysicsWorld } from '../contracts';
import type { ArenaContext } from '../brawl/contracts';
import type { WorldExt } from '../world/types';
import { COLLISION_GROUPS, GROUP } from '../physics/physics';
import { MeshBuilder, box, cylinder, lathe, mat, rod, type Style } from '../world/props/util/geom';
import { createPropMaterial } from '../world/props/util/propMaterial';
import { canvasToTexture, makeCanvas } from '../world/props/util/textures';
import { BOTTOMS, SKINS, TOPS, buildHumanGeometry, createHumanMaterials, pickColor } from '../traffic/humanMesh';

type R = typeof RAPIER;
export type Body = RAPIER.RigidBody;
export type ColliderDesc = RAPIER.ColliderDesc;

export interface PbrLib {
  pbr(name: string, opts?: { repeat?: number | [number, number]; color?: THREE.ColorRepresentation; roughness?: number; metalness?: number; normalScale?: number }): THREE.MeshStandardMaterial;
  metres(name: string): number;
}

/** Seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = THREE.MathUtils.clamp;

// ---------------------------------------------------------------------------------------------
// Kit: ownership of bodies, meshes, materials, update hooks
// ---------------------------------------------------------------------------------------------

export interface DynProp {
  body: Body;
  /** home pose (for reset) */
  home: { p: THREE.Vector3; q: THREE.Quaternion };
  /** visual: either an object or an instance slot of an InstancedMesh */
  obj: THREE.Object3D | null;
  inst: { mesh: THREE.InstancedMesh; index: number; scale: number } | null;
}

export interface Kinematic {
  body: Body;
  obj: THREE.Object3D | null;
  /** pose of the previous / current fixed step (visual interpolation) */
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  curP: THREE.Vector3;
  curQ: THREE.Quaternion;
  /** drive: set the pose for the step that is about to run */
  set(p: THREE.Vector3, q: THREE.Quaternion): void;
  /** teleport (no sweep velocity), e.g. to park it */
  place(p: THREE.Vector3, q: THREE.Quaternion): void;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);

export class ArenaKit {
  readonly engine: Engine;
  readonly physics: PhysicsWorld;
  readonly world: WorldExt | null;
  readonly R: R;
  readonly w: RAPIER.World;
  readonly root = new THREE.Group();
  readonly lib: PbrLib | null;
  readonly props: DynProp[] = [];
  readonly kinematics: Kinematic[] = [];
  private readonly bodies: Body[] = [];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly unsubs: (() => void)[] = [];
  private fixed: Body | null = null;
  private readonly fallbackMats = new Map<string, THREE.MeshStandardMaterial>();

  constructor(ctx: ArenaContext, name: string) {
    this.engine = ctx.engine;
    this.physics = ctx.physics;
    this.world = ctx.world;
    this.R = ctx.physics.RAPIER as R;
    this.w = ctx.physics.world as RAPIER.World;
    this.root.name = `arena:${name}`;
    const m = ctx.world?.materials as unknown as Partial<PbrLib> | undefined;
    this.lib = m && typeof m.pbr === 'function' && typeof m.metres === 'function' ? (m as PbrLib) : null;
    // keep the visuals of props / kinematics in sync after every physics step (priority 15: after
    // the physics (10), before beasts (20) and the camera (50))
    this.unsubs.push(this.engine.onUpdate(() => this.sync(), 15));
  }

  /** Real PBR material from the world's library (metric repeat), or a flat fallback colour. */
  pbr(name: string, tileMetres: number | null, fallback: THREE.ColorRepresentation, opts: { color?: THREE.ColorRepresentation; roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
    if (this.lib) {
      try {
        const rep = tileMetres ? 1 / tileMetres : 1;
        return this.lib.pbr(name, { repeat: rep, ...opts });
      } catch {
        /* fall through */
      }
    }
    const key = `${name}:${String(fallback)}`;
    let m = this.fallbackMats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: opts.color ?? fallback, roughness: opts.roughness ?? 0.8, metalness: opts.metalness ?? 0 });
      this.fallbackMats.set(key, m);
      this.own(m);
    }
    return m;
  }

  own<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  onDispose(fn: () => void): void {
    this.unsubs.push(fn);
  }

  /** Add a mesh to the arena root with shadows. */
  add<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
    o.traverse((c) => {
      if ((c as THREE.Mesh).isMesh) {
        c.castShadow = cast;
        c.receiveShadow = receive;
      }
    });
    this.root.add(o);
    return o;
  }

  /** Static colliders of this arena (one fixed body, removed on dispose). */
  staticCollider(desc: ColliderDesc, tag = 'arena'): RAPIER.Collider {
    if (!this.fixed) {
      this.fixed = this.w.createRigidBody(this.R.RigidBodyDesc.fixed());
      this.bodies.push(this.fixed);
    }
    desc.setCollisionGroups(COLLISION_GROUPS.staticWorld);
    const c = this.w.createCollider(desc, this.fixed);
    (this.physics as PhysicsWorld & { setTag?(h: number, t: string): void }).setTag?.(c.handle, tag);
    return c;
  }

  staticBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0, tag = 'arena', friction = 0.8): RAPIER.Collider {
    const d = this.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setFriction(friction);
    if (rotY) {
      _q.setFromAxisAngle(_v.set(0, 1, 0), rotY);
      d.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
    return this.staticCollider(d, tag);
  }

  staticBoxQ(c: THREE.Vector3, half: THREE.Vector3, q: THREE.Quaternion, tag = 'arena', friction = 0.8): RAPIER.Collider {
    const d = this.R.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(friction);
    return this.staticCollider(d, tag);
  }

  /** Dynamic prop body (COLLISION_GROUPS.prop) with one or more colliders. */
  dynamic(p: THREE.Vector3, q: THREE.Quaternion, colliders: ColliderDesc[], opts: { linDamp?: number; angDamp?: number; ccd?: boolean; tag?: string } = {}): Body {
    const bd = this.R.RigidBodyDesc.dynamic()
      .setTranslation(p.x, p.y, p.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(opts.linDamp ?? 0.05)
      .setAngularDamping(opts.angDamp ?? 0.25)
      .setCcdEnabled(!!opts.ccd);
    const body = this.w.createRigidBody(bd);
    for (const c of colliders) {
      c.setCollisionGroups(COLLISION_GROUPS.prop);
      const col = this.w.createCollider(c, body);
      if (opts.tag) (this.physics as PhysicsWorld & { setTag?(h: number, t: string): void }).setTag?.(col.handle, opts.tag);
    }
    this.bodies.push(body);
    return body;
  }

  addProp(body: Body, obj: THREE.Object3D | null, inst: DynProp['inst'] = null): DynProp {
    const t = body.translation(), r = body.rotation();
    const d: DynProp = { body, obj, inst, home: { p: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) } };
    this.props.push(d);
    return d;
  }

  /** Kinematic (position based) hazard body with COLLISION_GROUPS.hazard colliders. */
  kinematic(colliders: ColliderDesc[], obj: THREE.Object3D | null, tag = 'hazard'): Kinematic {
    const body = this.w.createRigidBody(this.R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0));
    for (const c of colliders) {
      c.setCollisionGroups(COLLISION_GROUPS.hazard);
      const col = this.w.createCollider(c, body);
      (this.physics as PhysicsWorld & { setTag?(h: number, t: string): void }).setTag?.(col.handle, tag);
    }
    this.bodies.push(body);
    const k: Kinematic = {
      body,
      obj,
      prevP: new THREE.Vector3(0, -500, 0),
      prevQ: new THREE.Quaternion(),
      curP: new THREE.Vector3(0, -500, 0),
      curQ: new THREE.Quaternion(),
      set(p, q) {
        k.prevP.copy(k.curP);
        k.prevQ.copy(k.curQ);
        k.curP.copy(p);
        k.curQ.copy(q);
        body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
        body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      },
      place(p, q) {
        k.prevP.copy(p);
        k.curP.copy(p);
        k.prevQ.copy(q);
        k.curQ.copy(q);
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
        body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
        body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      },
    };
    this.kinematics.push(k);
    return k;
  }

  /** Copy body poses to the visuals (props: latest state; kinematics: interpolated). */
  sync(): void {
    const alpha = clamp(this.physics.alpha, 0, 1);
    const dirty = new Set<THREE.InstancedMesh>();
    for (const d of this.props) {
      const t = d.body.translation(), r = d.body.rotation();
      if (d.obj) {
        d.obj.position.set(t.x, t.y, t.z);
        d.obj.quaternion.set(r.x, r.y, r.z, r.w);
      } else if (d.inst) {
        _v.set(t.x, t.y, t.z);
        _q.set(r.x, r.y, r.z, r.w);
        _s.setScalar(d.inst.scale);
        _m.compose(_v, _q, _s);
        d.inst.mesh.setMatrixAt(d.inst.index, _m);
        dirty.add(d.inst.mesh);
      }
    }
    for (const m of dirty) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
    for (const k of this.kinematics) {
      if (!k.obj) continue;
      k.obj.position.lerpVectors(k.prevP, k.curP, alpha);
      k.obj.quaternion.slerpQuaternions(k.prevQ, k.curQ, alpha);
    }
  }

  /** Put every dynamic prop back at its home pose, at rest. */
  resetProps(): void {
    for (const d of this.props) {
      const b = d.body;
      b.setTranslation({ x: d.home.p.x, y: d.home.p.y, z: d.home.p.z }, true);
      b.setRotation({ x: d.home.q.x, y: d.home.q.y, z: d.home.q.z, w: d.home.q.w }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.sleep();
    }
    this.sync();
  }

  onPreStep(fn: (dt: number) => void): void {
    this.unsubs.push(this.physics.onPreStep(fn));
  }

  onUpdate(fn: (dt: number, elapsed: number) => void, priority: number): void {
    this.unsubs.push(this.engine.onUpdate(fn, priority));
  }

  /**
   * Calls fn for every awake beast part body (membership in GROUP.BEAST). The arena does not get the
   * BeastSystem, so hazards / crowd / camera helpers find the fighters through the physics world.
   */
  forEachBeastPart(fn: (x: number, y: number, z: number, body: Body) => void): void {
    this.w.forEachActiveRigidBody((b) => {
      if (!b.isDynamic() || b.numColliders() === 0) return;
      const g = b.collider(0).collisionGroups() >>> 16;
      if ((g & GROUP.BEAST) === 0) return;
      const t = b.translation();
      fn(t.x, t.y, t.z, b);
    });
  }

  /**
   * All beast part bodies grouped per beast (the slot bit of their collision membership). Reuses
   * the given map (its lists are emptied first).
   */
  beastsBySlot(out: Map<number, Body[]>): Map<number, Body[]> {
    for (const l of out.values()) l.length = 0;
    this.forEachBeastPart((_x, _y, _z, b) => {
      const slot = (b.collider(0).collisionGroups() >>> 16) & GROUP.BEAST;
      let l = out.get(slot);
      if (!l) out.set(slot, (l = []));
      l.push(b);
    });
    return out;
  }

  /**
   * Knock a whole beast over: velocity change (dx, dy, dz) (world) on every part; parts higher than
   * upperY get upperBoost times the horizontal part (so the beast tumbles instead of sliding).
   */
  knock(parts: Body[], dx: number, dy: number, dz: number, upperY: number, upperBoost = 1.8): void {
    for (const b of parts) {
      const m = b.mass();
      const k = b.translation().y > upperY ? upperBoost : 1;
      b.applyImpulse({ x: m * dx * k, y: m * dy, z: m * dz * k }, true);
    }
  }

  /** Temporarily disable foreign static colliders (e.g. the city's mill body); re-enabled on dispose. */
  disableColliders(pred: (c: RAPIER.Collider, tag: string | undefined) => boolean): number {
    const tagOf = (this.physics as PhysicsWorld & { tagOf?(h: number): string | undefined }).tagOf?.bind(this.physics);
    const list: RAPIER.Collider[] = [];
    this.w.forEachCollider((c) => {
      if (!c.isEnabled()) return;
      const parent = c.parent();
      if (parent && this.bodies.includes(parent)) return;
      if (pred(c, tagOf ? tagOf(c.handle) : undefined)) list.push(c);
    });
    for (const c of list) c.setEnabled(false);
    this.unsubs.push(() => {
      for (const c of list) {
        try {
          c.setEnabled(true);
        } catch {
          /* collider gone */
        }
      }
    });
    return list.length;
  }

  dispose(): void {
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch (e) {
        console.warn('[arena] opruimen mislukt', e);
      }
    }
    for (const b of this.bodies.splice(0)) {
      try {
        this.w.removeRigidBody(b);
      } catch {
        /* already gone */
      }
    }
    this.fixed = null;
    this.props.length = 0;
    this.kinematics.length = 0;
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const d of this.disposables.splice(0)) d.dispose();
    this.root.removeFromParent();
    this.root.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Convex area polygon in xz
// ---------------------------------------------------------------------------------------------

export class ConvexArea {
  /** points counter-clockwise or clockwise, any; edges i -> i + 1 */
  readonly pts: [number, number][];
  /** per edge: true = a drop (water / fall), false = barrier */
  readonly drop: boolean[];
  private readonly nx: number[] = [];
  private readonly nz: number[] = [];
  private readonly d0: number[] = [];

  constructor(pts: [number, number][], drop: boolean[]) {
    this.pts = pts;
    this.drop = drop;
    // inward normals
    let cx = 0, cz = 0;
    for (const p of pts) {
      cx += p[0] / pts.length;
      cz += p[1] / pts.length;
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      let nx = -(b[1] - a[1]), nz = b[0] - a[0];
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      if ((cx - a[0]) * nx + (cz - a[1]) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      this.nx.push(nx);
      this.nz.push(nz);
      this.d0.push(a[0] * nx + a[1] * nz);
    }
  }

  /** signed distance inside edge i (positive = inside) */
  inside(i: number, x: number, z: number): number {
    return x * this.nx[i] + z * this.nz[i] - this.d0[i];
  }

  contains(x: number, z: number, margin = 0): boolean {
    for (let i = 0; i < this.pts.length; i++) if (this.inside(i, x, z) < margin) return false;
    return true;
  }

  /** Distance to the nearest drop edge segment (Infinity without drop edges). */
  dropDistance(x: number, z: number): number {
    let best = Infinity;
    for (let i = 0; i < this.pts.length; i++) {
      if (!this.drop[i]) continue;
      best = Math.min(best, segDist(x, z, this.pts[i], this.pts[(i + 1) % this.pts.length]));
    }
    return best;
  }

  /** Push (x, z) inside by at least `margin` from every edge. */
  clamp(x: number, z: number, margin: number, out: THREE.Vector3): THREE.Vector3 {
    let px = x, pz = z;
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < this.pts.length; i++) {
        const d = this.inside(i, px, pz);
        if (d < margin) {
          px += this.nx[i] * (margin - d);
          pz += this.nz[i] * (margin - d);
        }
      }
    }
    out.x = px;
    out.z = pz;
    return out;
  }
}

export function segDist(x: number, z: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
  return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z);
}

// ---------------------------------------------------------------------------------------------
// Crowd of onlookers (instanced procedural people with idle / cheering animation)
// ---------------------------------------------------------------------------------------------

export interface CrowdSpot {
  x: number;
  y: number;
  z: number;
  facing: number;
}

export interface Crowd {
  readonly mesh: THREE.InstancedMesh;
  /** excitement 0..1 (arms up, hopping); `focus` = point they turn their heads/bodies towards */
  update(dt: number, excitement: number, focus: THREE.Vector3 | null): void;
}

export function createCrowd(kit: ArenaKit, spots: CrowdSpot[], seed: number): Crowd {
  const n = spots.length;
  const r = rng(seed);
  const g = buildHumanGeometry();
  const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
  const c0 = mk(4), c1 = mk(4), c2 = mk(4), anim = mk(4);
  anim.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('aCol0', c0);
  g.setAttribute('aCol1', c1);
  g.setAttribute('aCol2', c2);
  g.setAttribute('aAnim', anim);
  const hm = createHumanMaterials();
  kit.own(hm.material);
  kit.own(hm.depth);
  const mesh = new THREE.InstancedMesh(g, hm.material, n);
  mesh.customDepthMaterial = hm.depth;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.name = 'arena_crowd';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const col = new THREE.Color();
  const people = spots.map((s, i) => {
    pickColor(TOPS, r(), col);
    // a few in orange (Dutch fans) or red-white (Alkmaar)
    const u = r();
    if (u < 0.12) col.set('#e8701e');
    else if (u < 0.2) col.set('#c8202a');
    let flags = 0;
    if (r() < 0.25) flags += 1;
    if (r() < 0.2) flags += 2;
    const female = r() < 0.5;
    if (female && r() < 0.6) flags += 4;
    if (female && r() < 0.25) flags += 8;
    c0.setXYZW(i, col.r, col.g, col.b, flags);
    pickColor(BOTTOMS, r(), col);
    c1.setXYZW(i, col.r, col.g, col.b, Math.floor(r() * 4));
    pickColor(SKINS, r(), col);
    c2.setXYZW(i, col.r, col.g, col.b, Math.floor(r() * 8));
    anim.setXYZW(i, r() * 6.28, 0, 0, Math.floor(r() * 6));
    return {
      s,
      scale: 0.9 + r() * 0.2,
      phase: r() * 6.28,
      rate: 0.6 + r() * 0.8,
      hop: r(),
      cheer: r(),
      yaw: s.facing,
      walk: r() * 6.28,
    };
  });
  const tmpQ = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let t = 0;
  const update = (dt: number, excitement: number, focus: THREE.Vector3 | null) => {
    t += dt;
    const e = clamp(excitement, 0, 1);
    for (let i = 0; i < n; i++) {
      const p = people[i];
      // turn towards the action (limited to +-60 degrees from the spot facing)
      let want = p.s.facing;
      if (focus) {
        const a = Math.atan2(focus.x - p.s.x, focus.z - p.s.z);
        const d = Math.atan2(Math.sin(a - p.s.facing), Math.cos(a - p.s.facing));
        want = p.s.facing + clamp(d, -1.05, 1.05);
      }
      const dy = Math.atan2(Math.sin(want - p.yaw), Math.cos(want - p.yaw));
      p.yaw += dy * Math.min(1, dt * 1.5);
      // excitement: arms up (startle pose) pulsing, small hops, shuffling feet
      const cheer = clamp(e * (0.55 + 0.45 * Math.sin(t * (2.2 + p.rate) + p.phase)) * (0.4 + p.cheer), 0, 1);
      const hop = e > 0.35 && p.hop > 0.45 ? Math.max(0, Math.sin(t * (6 + p.rate * 2) + p.phase)) * 0.09 * e : 0;
      p.walk += dt * (1.2 + 3 * e) * p.rate;
      const amp = 0.08 + 0.18 * e * p.hop;
      anim.setXYZW(i, p.walk, amp, cheer > 0.04 ? 2 + cheer : 0, anim.getW(i));
      _v.set(p.s.x, p.s.y + hop, p.s.z);
      tmpQ.setFromAxisAngle(up, p.yaw);
      _s.setScalar(p.scale);
      _m.compose(_v, tmpQ, _s);
      mesh.setMatrixAt(i, _m);
    }
    anim.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0, 0.2, null);
  kit.add(mesh);
  return { mesh, update };
}

// ---------------------------------------------------------------------------------------------
// Dranghek (Dutch galvanised crowd barrier, 2.5 m x 1.1 m)
// ---------------------------------------------------------------------------------------------

export const DRANGHEK = { length: 2.5, height: 1.1 };

export function dranghekGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const steel: Style = { color: 0xa9adb0, rough: 0.42, metal: 0.85 };
  const L = DRANGHEK.length, H = DRANGHEK.height;
  const hl = L / 2 - 0.05;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // frame: top and bottom rails, end posts (local x = along the barrier)
  b.add(rod(V(-hl, H - 0.02, 0), V(hl, H - 0.02, 0), 0.021, 6), null, steel);
  b.add(rod(V(-hl, 0.2, 0), V(hl, 0.2, 0), 0.021, 6), null, steel);
  b.add(rod(V(-hl, 0.12, 0), V(-hl, H, 0), 0.021, 6), null, steel);
  b.add(rod(V(hl, 0.12, 0), V(hl, H, 0), 0.021, 6), null, steel);
  // vertical bars
  for (let k = 1; k < 18; k++) {
    const x = -hl + (2 * hl * k) / 18;
    b.add(rod(V(x, 0.2, 0), V(x, H - 0.02, 0), 0.0085, 4), null, steel);
  }
  // flat feet sticking out at both ends + coupling hooks
  for (const sx of [-1, 1]) {
    b.add(box(0.05, 0.03, 0.62), mat(sx * (hl + 0.02), 0.015, 0), steel);
    b.add(rod(V(sx * hl, 0.03, 0), V(sx * hl, 0.12, 0), 0.02, 6), null, steel);
    b.add(rod(V(sx * hl, H - 0.12, 0), V(sx * (hl + 0.07), H - 0.12, 0), 0.012, 4), null, steel);
  }
  return b.build();
}

export interface BarrierLine {
  /** start / end of the line (xz), barriers fill it */
  a: [number, number];
  b: [number, number];
}

/** Instanced dranghekken along lines (+ one static box collider per line). */
export function buildBarriers(kit: ArenaKit, lines: BarrierLine[], groundY: (x: number, z: number) => number): THREE.InstancedMesh {
  const slots: { x: number; y: number; z: number; rot: number }[] = [];
  for (const l of lines) {
    const dx = l.b[0] - l.a[0], dz = l.b[1] - l.a[1];
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.round(len / DRANGHEK.length));
    const rot = Math.atan2(-dz, dx); // local +x along the line
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = l.a[0] + dx * t, z = l.a[1] + dz * t;
      slots.push({ x, y: groundY(x, z), z, rot });
    }
    const cx = (l.a[0] + l.b[0]) / 2, cz = (l.a[1] + l.b[1]) / 2;
    const gy = groundY(cx, cz);
    kit.staticBox(cx, gy + 0.6, cz, len / 2, 0.6, 0.09, rot, 'dranghek', 0.5);
  }
  const geo = dranghekGeometry();
  const material = kit.own(createPropMaterial({ name: 'arena_dranghek' }));
  const mesh = new THREE.InstancedMesh(geo, material, slots.length);
  mesh.name = 'arena_dranghekken';
  const up = new THREE.Vector3(0, 1, 0);
  slots.forEach((s, i) => {
    _q.setFromAxisAngle(up, s.rot);
    _m.compose(_v.set(s.x, s.y, s.z), _q, _s.setScalar(1));
    mesh.setMatrixAt(i, _m);
  });
  mesh.computeBoundingSphere();
  kit.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Cheese wheels and draagberries
// ---------------------------------------------------------------------------------------------

export const CHEESE = { radius: 0.2, height: 0.13, mass: 13 };

/** Gouda wheel with rounded edges, wax sheen and a little red "kaasmerk" label (axis = local y, centred). */
export function cheeseGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const r = CHEESE.radius, h = CHEESE.height;
  const prof: [number, number][] = [[0, 0], [r * 0.82, 0], [r * 0.95, h * 0.1], [r, h * 0.5], [r * 0.95, h * 0.9], [r * 0.82, h], [0, h]];
  const g = lathe(prof, 22);
  g.translate(0, -h / 2, 0);
  b.add(g, null, { color: 0xf1bf2c, rough: 0.34, metal: 0 });
  const lbl = new THREE.CircleGeometry(0.035, 12);
  lbl.rotateX(-Math.PI / 2);
  b.add(lbl, mat(0.07, h / 2 + 0.002, 0.02, 0, 0, 0, 1, 1, 0.7), { color: 0x9a1c20, rough: 0.6 });
  return b.build();
}

export function cheeseCollider(kit: ArenaKit): ColliderDesc {
  const br = 0.03;
  return kit.R.ColliderDesc.roundCylinder(CHEESE.height / 2 - br, CHEESE.radius - br, br)
    .setMass(CHEESE.mass)
    .setFriction(0.75)
    .setRestitution(0.15);
}

export const BERRIE_COLOURS = [0xb8282a, 0xe7b928, 0x2f7a3a, 0x2a4f9a];

/** Cheese porters' barrow: tray with raised ends and two long carrying poles (local z = length). */
export function berrieGeometry(colour: number, withCheese: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const paint: Style = { color: colour, rough: 0.55 };
  const trim: Style = { color: 0xefeee8, rough: 0.6 };
  const wood: Style = { color: 0x6c4a2a, rough: 0.8 };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // tray (y = 0 at the poles' centre line)
  b.add(box(0.78, 0.05, 1.28), mat(0, 0.0, 0), paint);
  // raised curved ends ("kop")
  for (const sz of [-1, 1]) {
    b.add(box(0.8, 0.26, 0.05), mat(0, 0.12, sz * 0.64, sz * -0.25, 0, 0), paint);
    b.add(box(0.82, 0.04, 0.07), mat(0, 0.25, sz * 0.67), trim);
  }
  // side boards (low)
  for (const sx of [-1, 1]) b.add(box(0.04, 0.08, 1.24), mat(sx * 0.38, 0.05, 0), trim);
  // poles + handles
  for (const sx of [-1, 1]) {
    b.add(rod(V(sx * 0.43, -0.02, -1.12), V(sx * 0.43, -0.02, 1.12), 0.028, 6), null, paint);
    for (const sz of [-1, 1]) b.add(rod(V(sx * 0.43, -0.02, sz * 0.95), V(sx * 0.43, -0.02, sz * 1.14), 0.032, 6), null, wood);
  }
  // little feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(cylinder(0.025, 0.03, 0.14), mat(sx * 0.3, -0.16, sz * 0.5), wood);
  if (withCheese) {
    const cg = cheeseGeometry();
    for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) b.add(cg, mat((i - 0.5) * 0.39, 0.09, (j - 1.5) * 0.3), { color: 0xf1bf2c, rough: 0.34 });
    for (let j = 0; j < 3; j++) b.add(cg, mat(0, 0.2, (j - 1) * 0.32), { color: 0xf1bf2c, rough: 0.34 });
  }
  return b.build();
}

export function berrieColliders(kit: ArenaKit): ColliderDesc[] {
  const C = kit.R.ColliderDesc;
  return [
    C.cuboid(0.39, 0.03, 0.64).setMass(14).setFriction(0.7),
    C.cuboid(0.4, 0.13, 0.03).setTranslation(0, 0.12, 0.64).setMass(1.5),
    C.cuboid(0.4, 0.13, 0.03).setTranslation(0, 0.12, -0.64).setMass(1.5),
    C.capsule(1.08, 0.035).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }).setTranslation(0.43, -0.02, 0).setMass(4),
    C.capsule(1.08, 0.035).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }).setTranslation(-0.43, -0.02, 0).setMass(4),
    C.cuboid(0.34, 0.07, 0.54).setTranslation(0, -0.12, 0).setMass(1),
  ];
}

// ---------------------------------------------------------------------------------------------
// Canvas sign + simple synthesized sounds
// ---------------------------------------------------------------------------------------------

export function signTexture(lines: string[], opts: { w?: number; h?: number; bg?: string; fg?: string; border?: string } = {}): THREE.Texture {
  const W = opts.w ?? 512, H = opts.h ?? 256;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = opts.bg ?? '#f2c200';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = opts.border ?? '#141414';
  ctx.lineWidth = Math.round(H * 0.06);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
  ctx.fillStyle = opts.fg ?? '#141414';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = (H * 0.8) / lines.length;
  lines.forEach((l, i) => {
    ctx.font = `800 ${Math.round(lh * (i === 0 ? 0.78 : 0.6))}px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(l, W / 2, H * 0.1 + lh * (i + 0.5));
  });
  return canvasToTexture(canvas, { srgb: true, anisotropy: 4 });
}

let audioCtx: AudioContext | null = null;
function ac(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Ship's horn (two detuned low saws through a low-pass), `dur` seconds. */
export function playHorn(dur = 1.4, volume = 0.22): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime;
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(volume, t0 + 0.08);
  g.gain.setValueAtTime(volume, t0 + dur - 0.2);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  const lp = a.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  lp.Q.value = 2;
  lp.connect(g).connect(a.destination);
  for (const f of [146.8, 147.9, 220.4]) {
    const o = a.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(lp);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
}

/** Hand bell (porters coming through). */
export function playBell(volume = 0.12): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime;
  for (let k = 0; k < 3; k++) {
    const t = t0 + k * 0.32;
    const g = a.createGain();
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    g.connect(a.destination);
    for (const [f, v] of [[1180, 1], [2950, 0.35], [4400, 0.15]] as [number, number][]) {
      const o = a.createOscillator();
      const og = a.createGain();
      og.gain.value = v;
      o.frequency.value = f;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 0.95);
    }
  }
}

/** Wind gust whoosh (noise through a sweeping band-pass). */
export function playGust(dur = 3, volume = 0.1): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
    d[i] = last * 6;
  }
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.8;
  bp.frequency.setValueAtTime(250, t0);
  bp.frequency.linearRampToValueAtTime(700, t0 + dur * 0.5);
  bp.frequency.linearRampToValueAtTime(300, t0 + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(volume, t0 + dur * 0.35);
  g.gain.linearRampToValueAtTime(0, t0 + dur);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t0);
}
