// Public types of the props & landmarks modules (extensions of the contract in ARCHITECTURE §5).
import type * as THREE from 'three';
import type { PhysicsWorld } from '../../contracts';

/** Subset of PhysicsWorld the props need (lets dev scenes pass a stub). */
export type StaticColliderSink = Pick<PhysicsWorld, 'addStaticCylinder' | 'addStaticBox'>;

export interface PropsStats {
  /** total instances per prop type */
  instances: Record<string, number>;
  /** visible instances per prop type after the last update (all LOD levels) */
  visible: Record<string, number>;
  /** instanced draw calls issued by props (camera pass) */
  drawCalls: number;
  /** triangles rendered by props (camera pass) */
  triangles: number;
  colliders: number;
}

/** Return type of createProps (contract: root + update; the rest are optional extras). */
export interface PropsSystem {
  root: THREE.Group;
  update(dt: number, camPos: THREE.Vector3): void;
  /** Resolves when asynchronous parts (boats from map2d.json) are placed. */
  ready: Promise<void>;
  /** 0 = day (lamps nearly off) .. 1 = night (lamps fully on). */
  setLightsOn(level: number): void;
  stats(): PropsStats;
  dispose(): void;
}

/** Return type of createLandmarks. */
export interface LandmarksSystem {
  root: THREE.Group;
  update(dt: number, camPos: THREE.Vector3): void;
  /** Resolves when the Kaasmarkt placement (needs footprints/map2d) is finished. */
  ready: Promise<void>;
  /** Molen van Piet group. */
  molen: THREE.Object3D | null;
  /** Hand-made hero buildings by landmark id ('waag', 'accijnstoren'). */
  heroes: Record<string, THREE.Object3D>;
  /** Where the Kaasmarkt was placed (centre, rotation of its length axis from +x towards +z), once ready. */
  kaasmarktSite(): { x: number; z: number; rot: number; length: number; width: number; verified: boolean } | null;
  stats(): { drawCalls: number; triangles: number; cheeses: number };
  dispose(): void;
}
