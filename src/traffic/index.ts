// Traffic module entry: AI cars, parked cars, cyclists and pedestrians around the player.
//
//   const traffic = createTraffic(engine, physics, world);
//   traffic.setPlayer({ position: vehicle.position, velocity: vehicle.velocity });
//   engine.onUpdate((dt) => traffic.update(dt, vehicle.position), 30);
//
// Uses from World only: roadGraph, props.parkedCars, heightAt(x, z) and root (traffic.root is
// added to world.root). Everything is drawn with instancing (see carRender.ts / people.ts).
import * as THREE from 'three';
import type { Engine, PhysicsWorld, TrafficSystem, World } from '../contracts';
import { Network } from './network';
import { AgentGrid, KIND_PLAYER } from './spatial';
import { CarRenderer, TRAFFIC_MIX } from './carRender';
import { CarSim, type PlayerState } from './cars';
import { ParkedCars } from './parked';
import { PeopleSim } from './people';
import { makeRng } from './rng';

export interface TrafficOptions {
  /** AI cars at density 1 (default 40). */
  maxCars?: number;
  /** cyclists at density 1 (default 60). */
  maxBikes?: number;
  /** pedestrians at density 1 (default 120). */
  maxPeds?: number;
  /** radius around the camera in which parked cars are drawn (default 180 m). */
  parkedRange?: number;
  /** draw distance for people (default 130 m). */
  peopleRange?: number;
  /** random seed (default 1). */
  seed?: number;
  /** false = no parked cars (default true). */
  parked?: boolean;
}

export interface TrafficStats {
  updateMs: number;
  carsMs: number;
  peopleMs: number;
  renderMs: number;
  drawnCars: number;
  drawnParked: number;
  drawnHumans: number;
  drawnBikes: number;
  droppedInstances: number;
  /** triangles of all traffic instances drawn this frame (main pass) */
  triangles: number;
  /** draw calls of traffic (main pass, without shadows) */
  drawCalls: number;
  spawnedCars: number;
  despawnedCars: number;
  stuckDespawns: number;
  avgCarSpeed: number;
  stoppedCars: number;
  stuckCars: number;
  carsInJunction: number;
  /** people currently dodging the player car / stumbling after a bump */
  dodging: number;
  /** parked-car colliders currently in the physics world (streamed around the focus) */
  parkedColliders: number;
  /** total bumps (player car touched a pedestrian/cyclist, who was pushed aside) */
  bumps: number;
}

export interface PlayerRef {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Optional body orientation (vehicle.quaternion): exact car box for people's dodging/bumps.
   *  Without it the box axis follows the velocity direction (kept while standing still). */
  quaternion?: THREE.Quaternion;
}

export interface TrafficSystemExt extends TrafficSystem {
  /** Group with all traffic meshes (already added to world.root). */
  readonly root: THREE.Group;
  /** The player car: AI cars follow/yield to it and stop when hit; pedestrians stop in front of it. */
  setPlayer(p: PlayerRef | null): void;
  /** Night: AI car headlights + tail lights on. */
  setHeadlights(on: boolean): void;
  readonly stats: Readonly<TrafficStats>;
  /** Internals for debugging / dev scenes. */
  readonly debug: { cars: CarSim; people: PeopleSim; network: Network; parked: ParkedCars | null; grid: AgentGrid };
}

export function createTraffic(engine: Engine, physics: PhysicsWorld | null, world: World, options: TrafficOptions = {}): TrafficSystemExt {
  const t0 = performance.now();
  const rng = makeRng(options.seed ?? 1);
  const heightFn = (x: number, z: number): number => world.heightAt(x, z);
  const net = new Network(world.roadGraph, heightFn);
  // optional WorldExt method (world module): keeps walkers and dodging people out of buildings
  const wx = world as World & { isInsideBuilding?: (x: number, z: number) => boolean };
  if (typeof wx.isInsideBuilding === 'function') net.insideFn = (x, z) => wx.isInsideBuilding!(x, z);
  const maxCars = options.maxCars ?? 40;
  const maxBikes = options.maxBikes ?? 60;
  const maxPeds = options.maxPeds ?? 120;

  const root = new THREE.Group();
  root.name = 'traffic';
  const specIds = TRAFFIC_MIX.map((m) => m.id);
  const renderer = new CarRenderer(specIds, 56, 200);
  root.add(renderer.root);
  const cars = new CarSim(net, renderer, physics, rng, {
    maxCars, spawnMin: 60, spawnMax: 350, despawnR: 380, headlights: false,
  });
  const people = new PeopleSim(net, rng, { maxBikes, maxPeds });
  root.add(people.root);
  people.carWaitsFor = (carId, kind, id) => cars.waitsFor(carId, kind, id);
  const parked = options.parked === false || !world.props?.parkedCars
    ? null
    : new ParkedCars(world.props.parkedCars, renderer, physics, heightFn, options.parkedRange ?? 180);
  world.root.add(root);

  const grid = new AgentGrid(1024, 8, 12);
  const player: PlayerState = { present: false, x: 0, z: 0, vx: 0, vz: 0, speed: 0, fx: 0, fz: 1 };
  const fwd = new THREE.Vector3();
  let playerRef: PlayerRef | null = null;
  const peopleRange = options.peopleRange ?? 130;
  const visibleFn = (x: number, y: number, z: number, r: number): boolean => renderer.visible(x, y, z, r);

  const stats: TrafficStats = {
    updateMs: 0, carsMs: 0, peopleMs: 0, renderMs: 0, drawnCars: 0, drawnParked: 0, drawnHumans: 0, drawnBikes: 0,
    droppedInstances: 0, triangles: 0, drawCalls: 0, spawnedCars: 0, despawnedCars: 0, stuckDespawns: 0, avgCarSpeed: 0, stoppedCars: 0,
    stuckCars: 0, carsInJunction: 0, dodging: 0, bumps: 0, parkedColliders: 0,
  };
  const counts = { cars: 0, cyclists: 0, pedestrians: 0 };

  function setDensity(d: number): void {
    cars.setDensity(d);
    people.setDensity(d);
    parked?.setDensity(d);
  }
  setDensity(engine.quality.trafficDensity);
  const unsubQuality = engine.onQualityChange((q) => setDensity(q.trafficDensity));
  console.info(`[traffic] klaar in ${(performance.now() - t0).toFixed(0)} ms: ${net.carEdges.length} auto-, ${net.bikeEdges.length} fiets-, ${net.footEdges.length} looproutes, ${net.clusters.length} kruispunten, ${parked?.occupiedCount ?? 0} geparkeerde auto's`);

  // Shader warm-up in the background (no blocking renderer.compile on the loading thread):
  // world.warmUp compiles with compileAsync in the program variants the frame really uses (the
  // composer's render target, planar reflection), against the real scene lights and fog. three
  // only compiles visible objects, so every instanced mesh stays visible with 0 instances (draws
  // nothing) until the warm-up has finished. Registering traffic.root here also keeps the world's
  // own 'childadded' warm-up from compiling the same subtree a second time.
  renderer.showAllForCompile();
  people.showAllForCompile();
  const releaseHold = (): void => {
    renderer.holdVisible = false;
    people.holdVisible = false;
  };
  const wu = world as World & { warmUp?: (objects: readonly THREE.Object3D[], timeoutMs?: number) => Promise<boolean> };
  const tWarm = performance.now();
  const p0 = engine.renderer.info.programs?.length ?? 0;
  const warming: Promise<unknown> = typeof wu.warmUp === 'function'
    ? wu.warmUp([root], 15000)
    : engine.renderer.compileAsync(root, engine.camera, engine.scene);
  warming
    .then((ok) => {
      const n = (engine.renderer.info.programs?.length ?? 0) - p0;
      console.info(`[traffic] shaders ${ok === false ? 'niet klaar' : 'klaar'} na ${Math.round(performance.now() - tWarm)} ms (${n} nieuwe programma's)`);
    })
    .catch((e: unknown) => console.warn('[traffic] shaders vooraf compileren mislukt', e))
    .finally(releaseHold);
  renderer.begin(engine.camera);
  renderer.end();

  let summaryT = 0;

  const system: TrafficSystemExt = {
    root,
    counts,
    stats,
    debug: { cars, people, network: net, parked, grid },
    setDensity,
    setPlayer(p) {
      playerRef = p;
    },
    setHeadlights(on) {
      cars.opts.headlights = on;
    },
    update(dtIn, focus) {
      const tStart = performance.now();
      const dt = Math.min(Math.max(dtIn, 0), 0.1);
      renderer.begin(engine.camera);
      // player
      if (playerRef) {
        player.present = true;
        player.x = playerRef.position.x;
        player.z = playerRef.position.z;
        player.vx = playerRef.velocity.x;
        player.vz = playerRef.velocity.z;
        player.speed = Math.hypot(player.vx, player.vz);
        // body axis: from the quaternion when given, else the motion direction (sign kept stable
        // so reversing does not flip it; held while standing still)
        if (playerRef.quaternion) {
          fwd.set(0, 0, 1).applyQuaternion(playerRef.quaternion);
          const l = Math.hypot(fwd.x, fwd.z);
          if (l > 1e-3) {
            player.fx = fwd.x / l;
            player.fz = fwd.z / l;
          }
        } else if (player.speed > 0.6) {
          let ax = player.vx / player.speed;
          let az = player.vz / player.speed;
          if (ax * player.fx + az * player.fz < 0) {
            ax = -ax;
            az = -az;
          }
          player.fx = ax;
          player.fz = az;
        }
      } else player.present = false;
      // spatial hash of everyone (positions of the previous step)
      grid.clear();
      if (player.present) {
        const sp = player.speed;
        const dx = sp > 0.3 ? player.vx / sp : player.fx;
        const dz = sp > 0.3 ? player.vz / sp : player.fz;
        grid.add(KIND_PLAYER, 0, player.x, player.z, dx, dz, sp, 2.3, 1.0);
      }
      cars.fillGrid(grid);
      people.fillGrid(grid);
      if (dt > 0) {
        cars.update(dt, focus.x, focus.z, grid, player);
        people.update(dt, focus.x, focus.z, grid, player, visibleFn);
      }
      // parked-car colliders only near the focus (player car): Rapier's per-step cost grows with
      // the total collider count
      parked?.updateColliders(focus.x, focus.z);
      stats.parkedColliders = parked?.liveColliders ?? 0;
      const tR = performance.now();
      cars.render();
      parked?.render();
      renderer.end();
      people.render(visibleFn, renderer.camPos, peopleRange);
      const tEnd = performance.now();
      counts.cars = cars.cars.length;
      counts.cyclists = people.bikes.length;
      counts.pedestrians = people.peds.length;
      stats.carsMs = cars.updateMs;
      stats.peopleMs = people.updateMs;
      stats.renderMs = tEnd - tR;
      stats.updateMs = tEnd - tStart;
      stats.drawnCars = renderer.drawnInstances - (parked?.drawn ?? 0);
      stats.drawnParked = parked?.drawn ?? 0;
      stats.drawnHumans = people.drawnHumans;
      stats.drawnBikes = people.drawnBikes;
      stats.droppedInstances = renderer.dropped;
      const tp = people.trianglesPer;
      stats.triangles = renderer.drawnTriangles + people.drawnHumans * tp.human + people.drawnBikes * tp.bike;
      let calls = people.drawnHumans > 0 ? 1 : 0;
      if (people.drawnBikes > 0) calls++;
      const ch = renderer.root.children;
      for (let k = 0; k < ch.length; k++) if (ch[k].visible && (ch[k] as THREE.InstancedMesh).count > 0) calls++;
      stats.drawCalls = calls;
      stats.spawnedCars = cars.spawned;
      stats.despawnedCars = cars.despawned;
      stats.stuckDespawns = cars.stuckDespawns;
      stats.dodging = people.dodging;
      stats.bumps = people.bumps;
      summaryT -= dt;
      if (summaryT <= 0) {
        summaryT = 0.5;
        const s = cars.summary();
        stats.avgCarSpeed = s.avgSpeed;
        stats.stoppedCars = s.stopped;
        stats.stuckCars = s.stuck;
        stats.carsInJunction = s.inBox;
      }
    },
    dispose() {
      unsubQuality();
      cars.clear();
      people.dispose();
      parked?.dispose();
      renderer.dispose();
      root.removeFromParent();
    },
  };
  return system;
}
