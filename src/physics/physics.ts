// Rapier physics world for Gang Alkmaar (copied from Alkmaar Drive; owned by beast-physics now).
//
// - Fixed sub-steps of PHYSICS_DT with an accumulator (max 8 per frame) and an interpolation
//   factor `alpha` for smooth rendering.
// - Static helpers (trimesh / cylinder / box) used by the world, props and landmarks modules.
// - Collision groups so the player chassis, static world, AI traffic and loose props only
//   interact where they should (see COLLISION_GROUPS).
// - Contact-force events are dispatched to listeners per collider (used for impact telemetry).
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PHYSICS_DT } from '../config';
import type { PhysicsWorld } from '../contracts';

/** Max fixed sub-steps per frame; excess time is dropped (slow motion instead of a death spiral). */
export const MAX_SUBSTEPS = 8;

/** Rapier solver iterations (substeps) per fixed step. */
export const SOLVER_ITERATIONS = 4;

/** Collision group bits (16 bits available). */
export const GROUP = {
  STATIC: 0x0001,
  CHASSIS: 0x0002,
  TRAFFIC: 0x0004,
  PROP: 0x0008,
  /**
   * Beast ragdoll parts. Eight slot bits (0x0010..0x0800): every beast gets one slot bit (see
   * beastGroups) so its own parts never collide with each other while still colliding with the
   * parts of all other beasts. Use GROUP.BEAST (all slots) in filters that should see beasts.
   */
  BEAST: 0x0ff0,
} as const;

/** Number of beast slot bits (beasts sharing a slot - index modulo 8 - do not collide). */
export const BEAST_SLOTS = 8;

/** Single collision bit of beast slot `slot` (0..7). */
export function beastSlotBit(slot: number): number {
  return 0x0010 << (((slot % BEAST_SLOTS) + BEAST_SLOTS) % BEAST_SLOTS);
}

/** Packs membership + filter bits into a Rapier InteractionGroups value. */
export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/**
 * Ready-made interaction groups. Use with ColliderDesc.setCollisionGroups(...).
 *   staticWorld: ground, buildings, quays, bollards... collides with everything dynamic.
 *   playerChassis: the player car body.
 *   traffic: AI cars (kinematic or dynamic) — collide with the player and props, not with the static
 *            world (they are driven along the road graph) nor with each other.
 *   prop: loose dynamic props (bins, cones) — collide with everything.
 *   queryStatic: filter for scene queries that should only see the static world.
 */
export const COLLISION_GROUPS = {
  staticWorld: interactionGroups(GROUP.STATIC, GROUP.CHASSIS | GROUP.TRAFFIC | GROUP.PROP | GROUP.BEAST),
  playerChassis: interactionGroups(GROUP.CHASSIS, GROUP.STATIC | GROUP.TRAFFIC | GROUP.PROP | GROUP.BEAST),
  traffic: interactionGroups(GROUP.TRAFFIC, GROUP.CHASSIS | GROUP.PROP),
  prop: interactionGroups(GROUP.PROP, GROUP.STATIC | GROUP.CHASSIS | GROUP.TRAFFIC | GROUP.PROP | GROUP.BEAST),
  /** Generic beast part (any slot); real beast parts use beastGroups(slot). */
  beast: interactionGroups(GROUP.BEAST, GROUP.STATIC | GROUP.CHASSIS | GROUP.PROP | GROUP.BEAST),
  /** Kinematic hazards (sails, bridges, porters): hit beasts and props, ignore the static world. */
  hazard: interactionGroups(GROUP.STATIC, GROUP.PROP | GROUP.BEAST | GROUP.CHASSIS),
  /** Query filter: only beast parts. */
  queryBeasts: interactionGroups(0xffff, GROUP.BEAST),
  /** Query filter: static world + loose props. */
  queryStaticAndProps: interactionGroups(0xffff, GROUP.STATIC | GROUP.PROP),
  queryStatic: interactionGroups(0xffff, GROUP.STATIC),
  queryStaticAndTraffic: interactionGroups(0xffff, GROUP.STATIC | GROUP.TRAFFIC),
} as const;

/**
 * Interaction groups for the parts of the beast in `slot`: collide with the static world, props,
 * hazards, cars and every other beast, but not with the own parts.
 */
export function beastGroups(slot: number): number {
  const bit = beastSlotBit(slot);
  return interactionGroups(bit, GROUP.STATIC | GROUP.PROP | GROUP.CHASSIS | (GROUP.BEAST & ~bit));
}

/** Query groups that see what a beast in `slot` collides with (static, props, other beasts). */
export function beastQueryGroups(slot: number): number {
  const bit = beastSlotBit(slot);
  return interactionGroups(bit, GROUP.STATIC | GROUP.PROP | (GROUP.BEAST & ~bit));
}

export interface RayHit {
  /** distance along the (normalised) direction */
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  colliderHandle: number;
  tag: string | undefined;
}

export type ContactForceListener = (otherColliderHandle: number, forceMagnitude: number, direction: THREE.Vector3) => void;

/** Extended physics world (superset of the PhysicsWorld contract). */
export interface PhysicsWorldExt extends PhysicsWorld {
  /** Debug: live pre/post-step hook counts (leak checks). */
  readonly hookCount: { pre: number; post: number };
  /** Total simulated time (s). */
  readonly time: number;
  /** Generic ray cast (direction need not be normalised). Defaults to static world only. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, groups?: number, excludeRigidBody?: unknown): RayHit | null;
  /** Tag given to a collider by the add* helpers (e.g. 'ground', 'building'). */
  tagOf(colliderHandle: number): string | undefined;
  /** Assign a tag to any collider you created yourself. */
  setTag(colliderHandle: number, tag: string): void;
  /** Receive contact-force events for a collider (requires ActiveEvents.CONTACT_FORCE_EVENTS on it). */
  onContactForce(colliderHandle: number, fn: ContactForceListener): () => void;
  /** Drop the accumulated time (e.g. after loading or unpausing) so no catch-up burst happens. */
  resetAccumulator(): void;
  /** Number of fixed sub-steps done in the last step() call. */
  readonly lastSubsteps: number;
  dispose(): void;
}

let rapierReady: Promise<void> | null = null;

/** Initialise the Rapier WASM module once. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export async function createPhysics(): Promise<PhysicsWorldExt> {
  await initRapier();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYSICS_DT;
  // Solver substeps: 4 keeps 6 ragdolls (66 bodies, 60 joints) within ~2.3 ms per frame on the dev iGPU
  // laptop while the grab / lift joints stay stiff enough.
  world.numSolverIterations = SOLVER_ITERATIONS;

  const eventQueue = new RAPIER.EventQueue(true);
  const preHooks: ((dt: number) => void)[] = [];
  const postHooks: ((dt: number) => void)[] = [];
  const tags = new Map<number, string>();
  const contactListeners = new Map<number, ContactForceListener[]>();

  let accumulator = 0;
  let alpha = 0;
  let simTime = 0;
  let lastSubsteps = 0;

  const tmpDir = new THREE.Vector3();
  const forceDir = new THREE.Vector3();

  function removeFrom<T>(arr: T[], item: T): void {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  }

  function dispatchContactForces(): void {
    if (contactListeners.size === 0) {
      eventQueue.clear();
      return;
    }
    eventQueue.drainContactForceEvents((ev) => {
      const h1 = ev.collider1();
      const h2 = ev.collider2();
      const mag = ev.totalForceMagnitude();
      const d = ev.maxForceDirection();
      forceDir.set(d.x, d.y, d.z);
      const l1 = contactListeners.get(h1);
      if (l1) for (const fn of l1) fn(h2, mag, forceDir);
      const l2 = contactListeners.get(h2);
      if (l2) for (const fn of l2) fn(h1, mag, forceDir);
    });
  }

  function addCollider(desc: RAPIER.ColliderDesc, tag: string | undefined): RAPIER.Collider {
    desc.setCollisionGroups(COLLISION_GROUPS.staticWorld);
    const col = world.createCollider(desc);
    if (tag) tags.set(col.handle, tag);
    return col;
  }

  const physics: PhysicsWorldExt = {
    RAPIER,
    world,
    get alpha() {
      return alpha;
    },
    get time() {
      return simTime;
    },
    get lastSubsteps() {
      return lastSubsteps;
    },

    step(dt: number): number {
      // Clamp huge frame gaps (tab switch, loading hitch).
      accumulator += Math.min(Math.max(dt, 0), 0.25);
      let n = 0;
      while (accumulator >= PHYSICS_DT && n < MAX_SUBSTEPS) {
        for (let i = 0; i < preHooks.length; i++) preHooks[i](PHYSICS_DT);
        world.step(eventQueue);
        dispatchContactForces();
        simTime += PHYSICS_DT;
        for (let i = 0; i < postHooks.length; i++) postHooks[i](PHYSICS_DT);
        accumulator -= PHYSICS_DT;
        n++;
      }
      if (accumulator >= PHYSICS_DT) accumulator %= PHYSICS_DT;
      alpha = accumulator / PHYSICS_DT;
      lastSubsteps = n;
      return n;
    },

    resetAccumulator() {
      accumulator = 0;
      alpha = 0;
    },

    addStaticTrimesh(positions, indices, opts) {
      const flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES;
      const desc = RAPIER.ColliderDesc.trimesh(positions, indices, flags);
      desc.setFriction(opts?.friction ?? 1.0);
      desc.setRestitution(0.05);
      addCollider(desc, opts?.tag ?? 'ground');
    },

    addStaticCylinder(x, z, radius, height, y0 = 0, tag = 'post') {
      const desc = RAPIER.ColliderDesc.cylinder(height / 2, radius).setTranslation(x, y0 + height / 2, z);
      desc.setFriction(0.6);
      desc.setRestitution(0.1);
      addCollider(desc, tag);
    },

    addStaticBox(center, halfExtents, rotationY = 0, tag = 'box') {
      const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z).setTranslation(
        center.x,
        center.y,
        center.z,
      );
      if (rotationY !== 0) {
        const s = Math.sin(rotationY / 2);
        desc.setRotation({ x: 0, y: s, z: 0, w: Math.cos(rotationY / 2) });
      }
      desc.setFriction(0.8);
      desc.setRestitution(0.05);
      addCollider(desc, tag);
    },

    raycastDown(x, z, yFrom = 100) {
      const ray = new RAPIER.Ray({ x, y: yFrom, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, yFrom + 200, true, RAPIER.QueryFilterFlags.ONLY_FIXED, COLLISION_GROUPS.queryStatic);
      return hit ? yFrom - hit.timeOfImpact : null;
    },

    raycast(origin, dir, maxDist, groups = COLLISION_GROUPS.queryStatic, excludeRigidBody) {
      tmpDir.copy(dir);
      const len = tmpDir.length();
      if (len < 1e-9) return null;
      tmpDir.multiplyScalar(1 / len);
      const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: tmpDir.x, y: tmpDir.y, z: tmpDir.z });
      const hit = world.castRayAndGetNormal(
        ray,
        maxDist,
        true,
        undefined,
        groups,
        undefined,
        excludeRigidBody as RAPIER.RigidBody | undefined,
      );
      if (!hit) return null;
      const t = hit.timeOfImpact;
      return {
        distance: t,
        point: new THREE.Vector3(origin.x + tmpDir.x * t, origin.y + tmpDir.y * t, origin.z + tmpDir.z * t),
        normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
        colliderHandle: hit.collider.handle,
        tag: tags.get(hit.collider.handle),
      };
    },

    tagOf(handle) {
      return tags.get(handle);
    },
    setTag(handle, tag) {
      tags.set(handle, tag);
    },

    get hookCount() {
      return { pre: preHooks.length, post: postHooks.length };
    },
    onPreStep(fn) {
      preHooks.push(fn);
      return () => removeFrom(preHooks, fn);
    },
    onPostStep(fn) {
      postHooks.push(fn);
      return () => removeFrom(postHooks, fn);
    },

    onContactForce(handle, fn) {
      let list = contactListeners.get(handle);
      if (!list) contactListeners.set(handle, (list = []));
      list.push(fn);
      return () => {
        const l = contactListeners.get(handle);
        if (!l) return;
        removeFrom(l, fn);
        if (l.length === 0) contactListeners.delete(handle);
      };
    },

    dispose() {
      preHooks.length = 0;
      postHooks.length = 0;
      contactListeners.clear();
      eventQueue.free();
      world.free();
    },
  };
  return physics;
}

/**
 * Ray cast against the static world that works with any PhysicsWorld implementation
 * (uses the contract's `RAPIER` + `world`). Returns the hit distance or null.
 */
export function castRayStatic(
  physics: PhysicsWorld,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number | null {
  const R = physics.RAPIER as typeof RAPIER;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  const ray = new R.Ray({ x: ox, y: oy, z: oz }, { x: dx / len, y: dy / len, z: dz / len });
  const hit = (physics.world as RAPIER.World).castRay(
    ray,
    maxDist,
    true,
    R.QueryFilterFlags.ONLY_FIXED,
    COLLISION_GROUPS.queryStatic,
  );
  return hit ? hit.timeOfImpact : null;
}
