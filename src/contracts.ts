// Shared interfaces between the modules of Alkmaar Drive.
// Owned by the orchestrator. Module owners implement these; they must not change them.
// If a contract is insufficient, add an OPTIONAL extra member in your own module's type
// (e.g. `interface MyThing extends Contract { extra... }`) and report it in your final summary.
//
// Coordinate conventions (see docs/ARCHITECTURE.md):
//   world: x = east, y = up, z = south (north = -z), metres, street level y = 0.
//   vehicles: local +z = forward, +y = up, +x = LEFT side of the car. Origin at ground level,
//             centred laterally, z = 0 halfway between the axles.
//   heading: radians, rotation about +y. heading 0 = facing +z (south), PI/2 = facing +x (east).
//            forward vector = (sin(heading), 0, cos(heading)).

import type * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Engine (src/core)
// ---------------------------------------------------------------------------------------------

export type QualityLevel = 'laag' | 'midden' | 'hoog' | 'ultra';

export interface QualitySettings {
  level: QualityLevel;
  /** Internal resolution multiplier (0.5 .. 1). */
  renderScale: number;
  /** Shadow map resolution; 0 disables shadows. */
  shadowMapSize: 0 | 1024 | 2048 | 4096;
  /** Radius (m) around the focus point that receives sun shadows. */
  shadowDistance: number;
  /** Screen-space ambient occlusion. */
  ao: boolean;
  bloom: boolean;
  /** Canal water reflections. 'planar' = real reflection pass, 'env' = environment map only. */
  waterReflections: 'env' | 'planar';
  antialias: 'off' | 'smaa' | 'msaa';
  /** Max render distance for city detail in metres. */
  drawDistance: number;
  /** AI traffic amount multiplier (0 .. 1). */
  trafficDensity: number;
  /** Prop density multiplier (parked bikes, small street furniture) (0 .. 1). */
  propDensity: number;
  anisotropy: number;
}

export interface EngineStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

export interface EnvironmentHandle {
  /** The sun. Its shadow camera is managed by the engine (follows the focus point). */
  sun: THREE.DirectionalLight;
  /** Ambient/hemisphere fill light (may be null if the environment map covers it). */
  fill: THREE.Light | null;
  /** Pre-filtered environment map (PMREM) used for scene.environment. Null until loaded. */
  envMap: THREE.Texture | null;
  /** Normalised direction from the scene TOWARDS the sun. */
  sunDirection: THREE.Vector3;
  /** Resolves when the HDRI/environment is loaded and applied. */
  ready: Promise<void>;
}

export type UpdateFn = (dt: number, elapsed: number) => void;

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  /** Active camera. Scenes may assign another PerspectiveCamera. */
  camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly quality: Readonly<QualitySettings>;
  readonly env: EnvironmentHandle;
  readonly stats: Readonly<EngineStats>;
  /**
   * Register a per-frame callback. Lower priority runs first. Returns an unsubscribe function.
   * Conventional priorities: input 0, physics 10, vehicles 20, traffic 30, world 40, camera 50, ui 60.
   */
  onUpdate(fn: UpdateFn, priority?: number): () => void;
  /** Point that the sun shadow frustum is centred on (usually the player car). */
  setFocus(p: THREE.Vector3): void;
  /** Change quality at runtime (also persisted by the engine). Listeners are notified. */
  setQuality(q: Partial<QualitySettings>): void;
  onQualityChange(fn: (q: Readonly<QualitySettings>) => void): () => void;
  start(): void;
  stop(): void;
  /** Render one frame immediately (used by screenshot tooling). */
  renderOnce(): void;
}

// ---------------------------------------------------------------------------------------------
// Materials (src/world/materials)
// ---------------------------------------------------------------------------------------------

/**
 * Material classes. glTF material names in public/data/*.glb MUST be one of these strings;
 * the runtime replaces them with real PBR materials from the MaterialLibrary.
 */
export type MaterialClass =
  // buildings (tools/bag)
  | 'wall'            // brick facades with procedural windows (facade shader, see ARCHITECTURE)
  | 'roof_slanted'    // clay/ceramic roof tiles
  | 'roof_flat'       // bitumen / gravel flat roofs
  | 'backdrop'        // distant low-detail buildings outside the playable area
  // ground (tools/osm)
  | 'asphalt'
  | 'klinkers'        // red/brown clay brick pavers (herringbone), typical binnenstad streets
  | 'sidewalk'        // grey 30x30 concrete tiles
  | 'square'          // plein paving (e.g. Kaasmarkt cobbles)
  | 'curb'            // granite / concrete curb stones
  | 'bikelane'        // red asphalt cycle path
  | 'grass'
  | 'water'           // canal surface (special: rendered by MaterialLibrary.createWater)
  | 'quay'            // brick quay walls
  | 'quay_cap'        // stone coping on top of quay walls
  | 'bridge_deck'
  | 'bridge_side'     // brick / stone parapets and bridge body
  | 'bridge_rail'     // metal railings
  | 'road_marking'    // white road paint (decal geometry slightly above the road)
  | 'parking'
  | 'canal_bed'       // dark mud under the water
  | 'ground';         // generic fallback ground (compact soil/pavement)

export interface MaterialLibrary {
  get(name: MaterialClass): THREE.Material;
  /**
   * Creates the canal water mesh for the given (flat, y = WATER_LEVEL) geometry.
   * Handles reflections according to quality.waterReflections and animates itself.
   */
  createWater(geometry: THREE.BufferGeometry): THREE.Mesh;
  /** Loaded texture by logical name, e.g. 'brick_red' (for props/landmarks to reuse). */
  texture(name: string): THREE.Texture | undefined;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// City data (public/data, produced by tools/osm + tools/bag)
// ---------------------------------------------------------------------------------------------

export interface Rect { minX: number; minZ: number; maxX: number; maxZ: number }

export interface SpawnPoint { id: string; name: string; x: number; z: number; heading: number }

/** public/data/osm-meta.json */
export interface OsmMeta {
  playable: Rect;
  spawnPoints: SpawnPoint[];
  /** ground GLB files (relative to public/data/). */
  groundFiles: string[];
  landmarks: Landmark[];
  attribution: string;
}

/** public/data/bag-meta.json */
export interface BagMeta {
  buildingFiles: { file: string; bounds: Rect }[];
  backdropFiles: string[];
  buildingCount: number;
  attribution: string;
}

export interface Landmark {
  id: 'waag' | 'grote_kerk' | 'molen_van_piet' | 'accijnstoren' | 'stadhuis' | string;
  name: string;
  x: number;
  z: number;
  /** Optional orientation (radians, same convention as heading). */
  rotation?: number;
  /** Optional footprint ring [[x,z],...] */
  footprint?: [number, number][];
}

/** public/data/roadgraph.json */
export interface RoadGraph {
  /** node index -> [x, z] */
  nodes: [number, number][];
  edges: RoadEdge[];
}

export interface RoadEdge {
  a: number;
  b: number;
  /** polyline including both end points, [x, z] */
  pts: [number, number][];
  len: number;
  /** OSM highway value, e.g. 'primary', 'residential', 'living_street', 'cycleway', 'footway', 'pedestrian' */
  type: string;
  name?: string;
  /** 0 = two-way, 1 = only a -> b */
  oneway: 0 | 1;
  /** lanes per direction (>= 1) */
  lanes: number;
  /** speed limit, m/s */
  speed: number;
  /** total carriageway width, metres */
  width: number;
  car: boolean;
  bike: boolean;
  foot: boolean;
  bridge: boolean;
}

/** public/data/props.json — all arrays of tuples to keep the file small. */
export interface PropsData {
  /** [x, z, height, kind] kind: 0 = deciduous (linden/elm), 1 = small ornamental, 2 = conifer */
  trees: [number, number, number, number][];
  /** [x, z, rotY, kind] kind: 0 = historic lantern (binnenstad), 1 = modern street light */
  lamps: [number, number, number, number][];
  /** [x, z, rotY] */
  benches: [number, number, number][];
  /** [x, z] */
  bollards: [number, number][];
  /** [x, z, rotY] — single parked bicycle */
  parkedBikes: [number, number, number][];
  /** [x, z, rotY] — parked car slot (along singels / parking areas) */
  parkedCars: [number, number, number][];
  /** [x, z, rotY, code] Dutch RVV sign code, e.g. 'C2' (no entry), 'C1', 'B6' (yield), 'A1-30', 'G7' */
  signs: [number, number, number, string][];
  /** [x, z, rotY, streetName] blue Dutch street name sign */
  streetNameSigns: [number, number, number, string][];
  /** [x, z, rotY] */
  trafficLights: [number, number, number][];
  /** [x, z, rotY] waste bins, planters etc. */
  bins: [number, number, number][];
}

/** public/data/map2d.json + footprints.json — 2D data for the minimap. */
export interface Map2D {
  water: [number, number][][][];   // polygons: rings: points
  parks: [number, number][][][];
  bounds: Rect;
}
export interface Footprints {
  /** simplified building footprints (outer rings only) */
  rings: [number, number][][];
}

// ---------------------------------------------------------------------------------------------
// Physics (src/physics)
// ---------------------------------------------------------------------------------------------

export interface PhysicsWorld {
  /** The initialised RAPIER module (from @dimforge/rapier3d-compat). Typed loosely on purpose. */
  readonly RAPIER: any;
  readonly world: any; // RAPIER.World
  /** Advance the simulation by dt seconds using fixed sub-steps (PHYSICS_DT). Returns sub-steps done. */
  step(dt: number): number;
  /** Interpolation factor (0..1) between the last two fixed steps, for smooth rendering. */
  readonly alpha: number;
  addStaticTrimesh(positions: Float32Array, indices: Uint32Array, opts?: { friction?: number; tag?: string }): void;
  addStaticCylinder(x: number, z: number, radius: number, height: number, y0?: number, tag?: string): void;
  addStaticBox(center: THREE.Vector3, halfExtents: THREE.Vector3, rotationY?: number, tag?: string): void;
  /** Highest static surface y below (x, yFrom, z), or null when nothing is hit. */
  raycastDown(x: number, z: number, yFrom?: number): number | null;
  /** Register a callback run before every fixed sub-step (e.g. vehicle force application). */
  onPreStep(fn: (dt: number) => void): () => void;
  /** Register a callback run after every fixed sub-step. */
  onPostStep(fn: (dt: number) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Vehicles (src/vehicle)
// ---------------------------------------------------------------------------------------------

export type CarCategory = 'hatchback' | 'stationwagen' | 'stadsauto' | 'bestelbus' | 'sedan' | 'taxi' | 'crossover';

export interface CarSpec {
  id: string;
  /** Display name (fictional European brand + model, no real trademarks). */
  name: string;
  category: CarCategory;
  /** Short Dutch description for the car-select menu. */
  description: string;
  massKg: number;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  wheelRadius: number;
  wheelWidth: number;
  /** centre of gravity height above ground (m) */
  cgHeight: number;
  /** fraction of mass on the front axle (0..1) */
  frontWeight: number;
  drivetrain: 'fwd' | 'rwd' | 'awd';
  powerKw: number;
  torqueNm: number;
  idleRpm: number;
  redlineRpm: number;
  /** forward gear ratios, e.g. [3.6, 2.1, 1.4, 1.0, 0.8] */
  gearRatios: number[];
  reverseRatio: number;
  finalDrive: number;
  topSpeedKmh: number;
  maxSteerDeg: number;
  /** suspension at rest: spring travel (m) */
  suspensionTravel: number;
  /** typical paint colours (hex) for this model */
  paints: string[];
  /** true if electric (no gears / different sound) */
  electric?: boolean;
}

export interface CarLightState {
  head?: boolean;
  brake?: boolean;
  reverse?: boolean;
  indicatorL?: boolean;
  indicatorR?: boolean;
}

export interface CarModel {
  readonly specId: string;
  /** Root in vehicle-local coordinates (see conventions at top). */
  readonly root: THREE.Group;
  /** Sprung part (body, glass, lights). Physics may rotate/offset it slightly for roll/pitch. */
  readonly body: THREE.Object3D;
  /** FL, FR, RL, RR wheel pivots, children of root, positioned at wheel centres.
   *  rotation.y = steer angle, the child mesh spins about local x. Use setWheel() to drive them. */
  readonly wheels: [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D];
  /** Rest positions of the wheel centres (vehicle-local). */
  readonly wheelCenters: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** Set wheel steer (rad, +left), spin angle (rad) and suspension offset (m, +up) for wheel i. */
  setWheel(i: number, steer: number, spin: number, suspensionOffset: number): void;
  setPaint(color: THREE.ColorRepresentation): void;
  setLights(state: CarLightState): void;
  setPlate(text: string): void;
  dispose(): void;
}

export interface CarModelOptions {
  /** 0 = full detail (player / showroom), 1 = medium (nearby traffic), 2 = low (far traffic) */
  lod?: 0 | 1 | 2;
  color?: THREE.ColorRepresentation;
  /** Dutch licence plate text, e.g. 'GZ-123-K'. Random if omitted. */
  plate?: string;
}

export interface VehicleInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1 (left) .. 1 (right)
  handbrake: boolean;
  /** one-shot requests */
  shiftUp?: boolean;
  shiftDown?: boolean;
  reset?: boolean;
  toggleLights?: boolean;
  horn?: boolean;
}

export interface VehicleTelemetry {
  speedKmh: number;
  rpm: number;
  /** -1 = R, 0 = N, 1.. = forward gear */
  gear: number;
  throttle: number;
  brake: number;
  /** 0..1 how much the tyres slip (for sound / smoke) */
  slip: number;
  /** wheel contact flags FL, FR, RL, RR */
  grounded: [boolean, boolean, boolean, boolean];
  /** last collision impulse magnitude this frame (for sound / camera shake) */
  impact: number;
}

export interface PlayerVehicle {
  readonly spec: CarSpec;
  readonly model: CarModel;
  /** Interpolated world transform of the vehicle origin (ground level, between axles). */
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly velocity: THREE.Vector3;
  readonly heading: number;
  readonly telemetry: VehicleTelemetry;
  setInput(input: VehicleInput): void;
  teleport(x: number, z: number, heading: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// World (src/world)
// ---------------------------------------------------------------------------------------------

export interface World {
  readonly root: THREE.Group;
  readonly osmMeta: OsmMeta;
  readonly bagMeta: BagMeta;
  readonly roadGraph: RoadGraph;
  readonly props: PropsData;
  readonly materials: MaterialLibrary;
  /** Per-frame update: LOD switching, animated landmarks (windmill), streaming. */
  update(dt: number, cameraPos: THREE.Vector3): void;
  /** Street-level ground height at (x, z); WATER_LEVEL over canals, bridge deck height on bridges. */
  heightAt(x: number, z: number): number;
  dispose(): void;
}

export type ProgressFn = (fraction: number, label: string) => void;

// ---------------------------------------------------------------------------------------------
// Traffic (src/traffic)
// ---------------------------------------------------------------------------------------------

export interface TrafficSystem {
  /** Update all agents; `focus` is the player position (agents spawn/despawn around it). */
  update(dt: number, focus: THREE.Vector3): void;
  setDensity(d: number): void;
  readonly counts: { cars: number; cyclists: number; pedestrians: number };
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Scenes (src/scenes/*.ts) — selected with ?scene=<file name without .ts>, default 'game'.
// ---------------------------------------------------------------------------------------------

/**
 * Every scene module default-exports a SceneEntry. When the scene is fully loaded it must set
 * `window.__ready = true` (the screenshot tool waits for this).
 */
export type SceneEntry = (engine: Engine, params: URLSearchParams) => Promise<void>;

declare global {
  interface Window {
    __ready?: boolean;
    __engine?: Engine;
    /** Free-form debug hooks scenes may expose for tooling (e.g. __debug.teleport(...)). */
    __debug?: Record<string, unknown>;
  }
}
