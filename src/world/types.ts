// Public types of the world module (extensions of the World contract in src/contracts.ts).
import type * as THREE from 'three';
import type { Footprints, Map2D, MaterialClass, SpawnPoint, World } from '../contracts';
import type { LandmarksSystem, PropsSystem } from './props/types';
import type { HeightGrid } from './heightGrid';
import type { StreamedColliders } from './colliderStream';

export interface LoadWorldOptions {
  /** Load the building chunks (default true). */
  buildings?: boolean;
  /** Load the low-detail backdrop ring (buildings + ground) (default true). */
  backdrop?: boolean;
  /** Trees, street furniture, bikes, signs, boats (default true). */
  props?: boolean;
  /** Molen van Piet, Kaasmarkt (default true). */
  landmarks?: boolean;
  /** Static colliders (ground, buildings, boundary walls) when a physics world is given (default true). */
  collision?: boolean;
  /** Pre-compile all shaders before resolving (avoids the first-frame hitch) (default true). */
  compileShaders?: boolean;
  /** Super-chunk size in 200 m chunks for buildings / ground (default 2 / 4; sparse ground materials x2). */
  superChunk?: { building?: number; ground?: number };
  /** Release the CPU copies of static geometry after the GPU upload (default true). */
  freeCpuGeometry?: boolean;
  /** Parallel file downloads (default 8). */
  concurrency?: number;
  /** Height grid resolution in metres (default 0.5). */
  gridCell?: number;
}

export interface WorldStats {
  /** city meshes (merged chunk meshes) in total / currently not distance-culled */
  meshes: number;
  visibleMeshes: number;
  /** triangles of the not distance-culled city meshes (before frustum culling) */
  visibleTriangles: number;
  props: { drawCalls: number; triangles: number; instances: number } | null;
  landmarks: { drawCalls: number; triangles: number } | null;
  /** streamed static prop colliders: recorded / currently in the physics world */
  colliders: { total: number; active: number } | null;
}

export interface WorldExt extends World {
  /** Water + park polygons (also for the minimap). */
  readonly map2d: Map2D | null;
  /** Building footprints (minimap). */
  readonly footprints: Footprints | null;
  readonly propsSystem: PropsSystem | null;
  readonly landmarks: LandmarksSystem | null;
  readonly heightGrid: HeightGrid | null;
  /**
   * Streamed static colliders (null without physics): same addStaticCylinder / addStaticBox as
   * PhysicsWorld, but only the colliders within ~160 m of the camera live in the Rapier world.
   * Use it for many small static colliders (props, parked cars) that never move or get removed.
   */
  readonly staticColliders: StreamedColliders | null;
  /**
   * Ground material under (x, z) (nearest 0.5 m cell), null outside the data. Under buildings
   * the ground mesh continues (mostly 'sidewalk' block fill): check isInsideBuilding() first.
   */
  surfaceAt(x: number, z: number): MaterialClass | null;
  /** True over open water (canals, Singel), false on bridges and land. */
  isWater(x: number, z: number): boolean;
  /**
   * True when (x, z) lies inside a building footprint (BAG footprints rasterised on the 0.5 m
   * height grid, nearest cell, ~20 ns). False outside the grid (playable rect + 70 m) and when
   * footprints.json is missing. heightAt() still returns street level there.
   */
  isInsideBuilding(x: number, z: number): boolean;
  /**
   * Compiles the shaders of `objects` (e.g. traffic.root after it was created) in the background
   * with the variants the current render path needs; resolves true when done within `timeoutMs`.
   */
  warmUp(objects: readonly THREE.Object3D[], timeoutMs?: number): Promise<boolean>;
  /** 0 = day .. 1 = night: lit windows/shops and street lamps. */
  setNight(amount: number): void;
  /** Spawn point by id (falls back to the first one / the Waag). */
  spawn(id?: string): SpawnPoint;
  stats(): WorldStats;
  /** Load phase durations (ms) and total load time. */
  readonly timings: Readonly<Record<string, number>>;
  readonly loadMs: number;
}
