// Shared interfaces for Gang Alkmaar (the wobbly-ragdoll brawler set in Alkmaar).
// Owned by the orchestrator. Module owners implement these; extend in your own module types if
// needed (optional members) and report it — do not change this file.
//
// Conventions (same as src/contracts.ts): world x = east, y = up, z = south, metres.
// Beast local axes: +z = forward (facing), +y = up, +x = the beast's LEFT side.
// facing: radians about +y, 0 = looking along +z; forward = (sin(facing), 0, cos(facing)).

import type * as THREE from 'three';
import type { Engine, PhysicsWorld } from '../contracts';
import type { WorldExt } from '../world/types';

// ---------------------------------------------------------------------------------------------
// Beast rig (src/beast/rig.ts holds the numbers)
// ---------------------------------------------------------------------------------------------

export type BeastPartName =
  | 'pelvis'
  | 'chest'
  | 'head'
  | 'upperArmL'
  | 'lowerArmL'
  | 'upperArmR'
  | 'lowerArmR'
  | 'upperLegL'
  | 'lowerLegL'
  | 'upperLegR'
  | 'lowerLegR';

export interface BeastPartSpec {
  shape: 'capsule' | 'sphere';
  /** capsule/sphere radius (m) */
  radius: number;
  /** capsule half height of the cylindrical part along the part's local Y axis (0 for spheres) */
  halfHeight: number;
  /** rest-pose centre in beast-local coordinates (feet at y = 0, standing, arms hanging) */
  rest: [number, number, number];
  /** parent part (joint), null for the pelvis (root) */
  parent: BeastPartName | null;
  /** joint anchor in beast-local rest coordinates */
  joint: [number, number, number] | null;
}

// ---------------------------------------------------------------------------------------------
// Beast input & beast (src/beast/physics — ragdoll + controller + combat)
// ---------------------------------------------------------------------------------------------

/** One fighter's intent for this frame (humans: built from keyboard/gamepad; bots: from AI). */
export interface BeastInput {
  /** Desired move direction in WORLD space (x, z); length 0..1 (0 = stand still). */
  moveX: number;
  moveZ: number;
  /** Held actions (Gang Beasts style). Punching = tapping a grab button (no separate punch). */
  jump: boolean;
  duck: boolean;      // duck; with a quick press near an enemy: headbutt
  lift: boolean;      // lift what both hands hold over the head; release to throw
  kick: boolean;
  grabLeft: boolean;  // raise the left arm; grabs what the hand touches while held
  grabRight: boolean;
  /** Optional: run (otherwise speed follows the stick magnitude). */
  run?: boolean;
}

export type BeastState = 'active' | 'airborne' | 'knockedOut' | 'swimming' | 'eliminated';

export interface BeastOptions {
  name: string;
  /** body colour (hex) */
  colour: string;
  /** costume id from COSTUMES (src/beast/visual) */
  costume: string;
  isBot: boolean;
  /** team index for team modes (unused in free-for-all), default = own index */
  team?: number;
  /** 1 = normal, 1.2 = big, 0.8 = tiny */
  scale?: number;
}

export interface Beast {
  readonly id: number;
  readonly options: Readonly<BeastOptions>;
  /** Visual root (added to the scene by the BeastSystem). */
  readonly root: THREE.Object3D;
  /** Interpolated world position of the chest (centre of mass-ish). */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** Heading of the torso (radians, 0 = +z). */
  readonly facing: number;
  readonly state: BeastState;
  /** 1 = fully awake, 0 = knocked out. */
  readonly consciousness: number;
  /** What each hand holds: another beast's id, -1 for an object/scenery, null for nothing. */
  readonly holding: { readonly left: number | null; readonly right: number | null };
  /** Interpolated world positions of body parts (for camera, AI, effects). */
  partPosition(part: BeastPartName, out: THREE.Vector3): THREE.Vector3;
  setInput(input: BeastInput): void;
  /** Place the beast standing at p (feet on the ground below p) facing `facing`; resets KO. */
  teleport(p: THREE.Vector3, facing: number): void;
  /** Called by the round logic when the beast is out (fell in the water / off the stage). */
  eliminate(): void;
}

export interface BeastSystemEvents {
  /** A punch/kick/headbutt/impact hit `target` (strength 0..1). attacker = null for scenery impacts. */
  onHit?(target: Beast, attacker: Beast | null, strength: number, point: THREE.Vector3): void;
  onKnockout?(target: Beast): void;
  onGrab?(grabber: Beast, target: Beast | null): void;
  onSplash?(target: Beast, point: THREE.Vector3): void;
}

export interface BeastSystem {
  readonly beasts: readonly Beast[];
  spawn(opts: BeastOptions, at: THREE.Vector3, facing: number): Beast;
  remove(b: Beast): void;
  /** Visual sync / per-frame logic. Physics is stepped by the scene (physics.step). */
  update(dt: number): void;
  /** Subscribe to gameplay events (sound, effects, scoring). Returns unsubscribe. */
  on(events: BeastSystemEvents): () => void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Beast visuals (src/beast/visual)
// ---------------------------------------------------------------------------------------------

export type BeastExpression = 'neutral' | 'angry' | 'hurt' | 'ko' | 'happy' | 'scared';

export interface BeastVisual {
  /** Group to add to the scene. Part objects are its direct children (not hierarchical). */
  readonly root: THREE.Group;
  /** One object per rig part; the physics sets their world position/quaternion every frame. */
  readonly parts: Readonly<Record<BeastPartName, THREE.Object3D>>;
  setExpression(e: BeastExpression): void;
  setColour(hex: string): void;
  setCostume(id: string): void;
  /** Per-frame cosmetic animation (blinking, jiggle, cloth). */
  update(dt: number): void;
  dispose(): void;
}

export interface CostumeInfo {
  id: string;
  /** Dutch display name */
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------------------------
// Arenas (src/arenas)
// ---------------------------------------------------------------------------------------------

export type ArenaId = 'kaasmarkt' | 'rondvaartboot' | 'molen';

export interface ArenaCameraFrame {
  /** default look-at point */
  target: THREE.Vector3;
  /** yaw (radians, 0 = camera looks along +z) and pitch (radians down from horizontal) */
  yaw: number;
  pitch: number;
  minDistance: number;
  maxDistance: number;
}

export interface ArenaContext {
  engine: Engine;
  physics: PhysicsWorld;
  /** The real city (already loaded), null in lightweight dev scenes. */
  world: WorldExt | null;
}

export interface Arena {
  readonly id: ArenaId;
  /** Dutch display name and one-line description for the lobby. */
  readonly name: string;
  readonly description: string;
  readonly root: THREE.Group;
  /** Up to 8 spawn spots (feet position + facing). */
  readonly spawnPoints: readonly { position: THREE.Vector3; facing: number }[];
  readonly camera: ArenaCameraFrame;
  /** True when a beast whose chest is at p is out (in the canal, fallen off the stage...). */
  isOut(p: THREE.Vector3): boolean;
  /** Horizontal distance (m) from p to the nearest ledge / drop / water edge; Infinity if none near. */
  edgeDistance(p: THREE.Vector3): number;
  /** Nearest point on the walkable fighting area to p (for bots to stay inside). */
  clampToArea(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** Hazards / moving parts (boat, sails, cheese porters...). */
  update(dt: number, elapsed: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Bots (src/beast/ai)
// ---------------------------------------------------------------------------------------------

export type BotDifficulty = 'makkelijk' | 'normaal' | 'moeilijk';

export interface BotController {
  readonly beast: Beast;
  /** Decide and call beast.setInput(...). */
  update(dt: number): void;
  dispose(): void;
}
