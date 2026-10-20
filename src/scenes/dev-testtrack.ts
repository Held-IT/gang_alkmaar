// Vehicle test track (owned by the Vehicle module). ?scene=dev-testtrack
//
// Params:
//   car=<specId>              car to drive (specs from src/vehicle/specs.ts, else local fallbacks)
//   view=chase|bumper|hood|orbit   initial camera mode
//   devcam=1                  free orbit dev camera (with cam=x,y,z&look=x,y,z) instead of the car camera
//   autodrive=accel|brake|slalom|circle|curb|bump|rest|reverse|handbrake   scripted test; results in
//                             the console ("[autodrive] RESULT {...}") and window.__debug.results
//   fast=1|0                  simulate faster than real time (default on for accel/brake/circle)
//   spawn=x,z,heading         start position
//   hud=0                     hide the debug HUD
//   model=placeholder         use the simple placeholder model instead of src/vehicle/models
import * as THREE from 'three';
import { PHYSICS_DT } from '../config';
import type { CarModel, CarModelOptions, CarSpec, SceneEntry, VehicleInput } from '../contracts';
import { createCameraController, type CameraMode } from '../camera/cameraController';
import { createInput } from '../core/input';
import { createPhysics } from '../physics/physics';
import { createVehicleAudio } from '../audio/vehicleAudio';
import { setupDevCamera } from '../dev/devCamera';
import { FALLBACK_SPECS, getFallbackSpec } from '../vehicle/physics/fallbackSpecs';
import { createPlaceholderModel } from '../vehicle/physics/placeholderModel';
import { createPlayerVehicle, type PlayerVehicleExt } from '../vehicle/physics/vehicle';
import {
  addTrackColliders,
  AUTODRIVE_SPAWNS,
  bumpGeometry,
  makeAutodriveScript,
  rampGeometry,
  TRACK,
} from '../vehicle/physics/testTrack';

interface SpecsModule {
  CAR_SPECS: CarSpec[];
  getSpec(id: string): CarSpec | undefined;
}
interface ModelsModule {
  createCarModel(specId: string, opts?: CarModelOptions): CarModel | Promise<CarModel>;
}

const specModules = import.meta.glob<SpecsModule>('../vehicle/specs.ts');
const modelModules = import.meta.glob<ModelsModule>('../vehicle/models/index.ts');

function makeCheckerTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  // 10 m x 10 m tile: 2 m checks of slightly different asphalt greys, fine grain, 10 m grid line.
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cell = size / 5;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      g.fillStyle = (i + j) % 2 === 0 ? '#5a5a57' : '#51514e';
      g.fillRect(i * cell, j * cell, cell, cell);
    }
  }
  const img = g.getImageData(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let p = 0; p < img.data.length; p += 4) {
    const n = (rnd() - 0.5) * 10 + (rnd() < 0.003 ? 18 : 0);
    img.data[p] = Math.max(0, Math.min(255, img.data[p] + n));
    img.data[p + 1] = Math.max(0, Math.min(255, img.data[p + 1] + n));
    img.data[p + 2] = Math.max(0, Math.min(255, img.data[p + 2] + n * 0.9));
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(225,225,215,0.75)';
  g.fillRect(0, 0, size, 10);
  g.fillRect(0, 0, 10, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}

function buildTrackVisuals(engine: Parameters<SceneEntry>[0]): void {
  // Sky, fog and lighting are owned by the engine (HDRI environment + aerial fog).
  const scene = engine.scene;
  const S = TRACK.groundHalfSize;
  const groundTex = makeCheckerTexture(engine.renderer);
  groundTex.repeat.set((2 * S) / 10, (2 * S) / 10);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * S, 2 * S).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.92, metalness: 0 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const white = new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.6 });
  for (const x of [-12, 12]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 7800).rotateX(-Math.PI / 2), white);
    line.position.set(x, 0.004, 3900);
    scene.add(line);
  }

  const c = TRACK.curb;
  const curb = new THREE.Mesh(
    new THREE.BoxGeometry(c.x1 - c.x0, c.h, c.z1 - c.z0),
    new THREE.MeshStandardMaterial({ color: 0x9a9890, roughness: 0.85 }),
  );
  curb.position.set((c.x0 + c.x1) / 2, c.h / 2, (c.z0 + c.z1) / 2);
  curb.receiveShadow = curb.castShadow = true;
  scene.add(curb);

  const bump = new THREE.Mesh(bumpGeometry(), new THREE.MeshStandardMaterial({ color: 0x8a3b2c, roughness: 0.8 }));
  bump.receiveShadow = true;
  scene.add(bump);
  const ramp = new THREE.Mesh(
    rampGeometry(),
    new THREE.MeshStandardMaterial({ color: 0x6f7378, roughness: 0.8, side: THREE.DoubleSide }),
  );
  ramp.castShadow = ramp.receiveShadow = true;
  scene.add(ramp);

  const brick = new THREE.MeshStandardMaterial({ color: 0x8b4a36, roughness: 0.9 });
  for (const [x, y, z, hx, hy, hz] of TRACK.boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), brick);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }

  const m4 = new THREE.Matrix4();
  const posts = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.075, 0.09, 0.95, 12),
    new THREE.MeshStandardMaterial({ color: 0x4a1f17, roughness: 0.55, metalness: 0.3 }),
    TRACK.posts.length,
  );
  TRACK.posts.forEach(([x, z], k) => posts.setMatrixAt(k, m4.makeTranslation(x, 0.475, z)));
  posts.castShadow = true;
  scene.add(posts);

  const ci = TRACK.circle;
  const ring = new THREE.Mesh(new THREE.RingGeometry(ci.r - 0.08, ci.r + 0.08, 128).rotateX(-Math.PI / 2), white);
  ring.position.set(ci.x, 0.004, ci.z);
  scene.add(ring);
  const sl = TRACK.slalom;
  const cones = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.18, 0.5, 16),
    new THREE.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.6 }),
    sl.n,
  );
  for (let k = 0; k < sl.n; k++) cones.setMatrixAt(k, m4.makeTranslation(sl.x, 0.25, sl.z0 + k * sl.gap));
  cones.castShadow = true;
  scene.add(cones);
}

async function loadSpec(id: string | null): Promise<{ spec: CarSpec; source: string }> {
  const loader = specModules['../vehicle/specs.ts'];
  if (loader) {
    try {
      const mod = await loader();
      const spec = id ? (mod.getSpec?.(id) ?? mod.CAR_SPECS.find((s) => s.id === id)) : mod.CAR_SPECS[0];
      if (spec) return { spec, source: 'specs.ts' };
    } catch (e) {
      console.warn('[testtrack] specs.ts failed to load, using fallback specs', e);
    }
  }
  return { spec: FALLBACK_SPECS.find((s) => s.id === id) ?? getFallbackSpec(id), source: 'fallback' };
}

async function loadModel(spec: CarSpec, forcePlaceholder: boolean): Promise<{ model: CarModel; source: string }> {
  const loader = modelModules['../vehicle/models/index.ts'];
  if (loader && !forcePlaceholder) {
    try {
      const mod = await loader();
      const model = await mod.createCarModel(spec.id, { lod: 0, color: spec.paints[0], plate: 'GZ-123-K' });
      if (model) return { model, source: 'models' };
    } catch (e) {
      console.warn('[testtrack] car model failed, using placeholder', e);
    }
  }
  return { model: createPlaceholderModel(spec), source: 'placeholder' };
}

const testtrack: SceneEntry = async (engine, params) => {
  const physics = await createPhysics();
  addTrackColliders(physics);
  buildTrackVisuals(engine);

  const { spec, source: specSource } = await loadSpec(params.get('car'));
  const { model, source: modelSource } = await loadModel(spec, params.get('model') === 'placeholder');
  console.info(`[testtrack] car ${spec.id} (spec: ${specSource}, model: ${modelSource})`);

  // The autodrive hook must run before the vehicle's own pre-step (hooks run in registration order).
  const autoName = params.get('autodrive');
  const results: Record<string, unknown>[] = [];
  const autoInput: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  let vehicle: PlayerVehicleExt | null = null;
  let autoT = 0;
  let autoDone = false;
  const script = autoName
    ? makeAutodriveScript(autoName, (r) => {
        results.push(r);
        console.log(`[autodrive] RESULT ${JSON.stringify(r)}`);
      })
    : null;
  if (autoName && !script) console.error(`[testtrack] unknown autodrive "${autoName}"`);
  if (script) {
    physics.onPreStep((dt) => {
      if (!vehicle || autoDone) return;
      autoT += dt;
      autoDone = script(autoT, dt, vehicle, autoInput);
      if (autoDone) {
        autoInput.throttle = 0;
        autoInput.brake = 0.25; // below the brake-to-reverse threshold
        autoInput.steer = 0;
        autoInput.handbrake = false;
      }
      vehicle.setInput(autoInput);
    });
  }

  vehicle = createPlayerVehicle(engine, physics, spec, model);
  const v = vehicle;
  const sp = params.get('spawn')?.split(',').map(Number);
  const spawn =
    sp && sp.length === 3 && sp.every(Number.isFinite)
      ? { x: sp[0], z: sp[1], h: sp[2] }
      : (AUTODRIVE_SPAWNS[autoName ?? ''] ?? { x: 0, z: 0, h: 0 });
  v.teleport(spawn.x, spawn.z, spawn.h);

  const input = createInput(engine);
  const devcam = params.get('devcam') === '1';
  const cameraCtl = devcam ? null : createCameraController(engine, v, physics);
  if (devcam) {
    setupDevCamera(engine, params, {
      cam: new THREE.Vector3(spawn.x + 8, 4, spawn.z - 9),
      look: new THREE.Vector3(spawn.x, 0.8, spawn.z),
    });
  }
  const view = params.get('view') as CameraMode | null;
  if (cameraCtl && view) cameraCtl.setMode(view);
  input.onAction('camera', () => cameraCtl?.cycleMode());
  input.onAction('pause', () => console.info('[testtrack] pause pressed'));
  const audio = createVehicleAudio(v);

  // Simulation loop. Fast mode runs extra fixed steps per frame (long scripted tests).
  const fastParam = params.get('fast');
  const fast = fastParam === '1' || (fastParam !== '0' && (autoName === 'accel' || autoName === 'brake' || autoName === 'circle'));
  engine.onUpdate(() => {
    const inp = input.read();
    if (!script) v.setInput(inp);
  }, 0);
  // Per-module CPU timing (ms per frame, exponentially averaged) for performance checks.
  const perf = { physicsMs: 0, vehicleRenderMs: 0, cameraMs: 0, audioMs: 0, substeps: 0 };
  const avg = (cur: number, v: number) => cur + (v - cur) * 0.05;
  engine.onUpdate((dt) => {
    const t0 = performance.now();
    if (fast && script && !autoDone) for (let k = 0; k < 90; k++) physics.step(PHYSICS_DT);
    else perf.substeps = avg(perf.substeps, physics.step(dt));
    perf.physicsMs = avg(perf.physicsMs, performance.now() - t0);
  }, 10);
  let tMark = 0;
  engine.onUpdate(() => (tMark = performance.now()), 19);
  engine.onUpdate(() => (perf.vehicleRenderMs = avg(perf.vehicleRenderMs, performance.now() - tMark)), 21);
  engine.onUpdate(() => (tMark = performance.now()), 49);
  engine.onUpdate(() => (perf.cameraMs = avg(perf.cameraMs, performance.now() - tMark)), 51);
  engine.onUpdate((dt) => {
    const ta = performance.now();
    audio.update(dt);
    perf.audioMs = avg(perf.audioMs, performance.now() - ta);
    if (cameraCtl) audio.setPerspective(cameraCtl.mode === 'chase' || cameraCtl.mode === 'orbit' ? 'exterior' : 'interior');
  }, 55);

  // Debug HUD.
  if (params.get('hud') !== '0') {
    const hud = document.createElement('div');
    hud.style.cssText =
      'position:fixed;left:12px;top:12px;padding:8px 10px;background:rgba(10,14,20,0.62);color:#e8eef5;' +
      'font:12px/1.45 Consolas,monospace;border-radius:6px;pointer-events:none;white-space:pre;z-index:10';
    document.body.appendChild(hud);
    let acc = 0;
    engine.onUpdate((dt) => {
      acc += dt;
      if (acc < 0.1) return;
      acc = 0;
      const t = v.telemetry;
      const g = t.gear === -1 ? 'R' : t.gear === 0 ? 'N' : String(t.gear);
      hud.textContent =
        `${spec.name} (${spec.id})  ${modelSource}\n` +
        `${t.speedKmh.toFixed(0).padStart(3)} km/h  ${g}  ${t.rpm.toFixed(0).padStart(5)} rpm\n` +
        `gas ${t.throttle.toFixed(2)}  rem ${t.brake.toFixed(2)}  slip ${t.slip.toFixed(2)}\n` +
        `lat ${(v.localAcceleration.x / 9.81).toFixed(2)}g  long ${(v.localAcceleration.z / 9.81).toFixed(2)}g\n` +
        `cam ${cameraCtl?.mode ?? 'dev'}  ${engine.stats.fps.toFixed(0)} fps  ` +
        `${v.controls.absActive ? 'ABS ' : ''}${v.controls.tcsActive ? 'TCS ' : ''}${v.controls.escActive ? 'ESP' : ''}` +
        (autoName ? `\nautodrive ${autoName}${autoDone ? ' (klaar)' : ''}` : '');
    }, 60);
  }

  window.__debug = window.__debug ?? {};
  Object.assign(window.__debug, {
    telemetry: v.telemetry,
    vehicle: v,
    physics,
    perf,
    results,
    camera: cameraCtl,
    audio,
    isAutoDone: () => autoDone,
    teleport: (x: number, z: number, h: number) => v.teleport(x, z, h),
    /** Headless regression tests for this car (see src/vehicle/physics/headlessTest.ts). */
    runVehicleTests: async (tests?: string[]) => {
      const { runVehicleTests } = await import('../vehicle/physics/headlessTest');
      return runVehicleTests(spec, tests);
    },
    /** Offline-render the car sound scenario; returns per-segment levels + a base64 WAV. */
    renderAudioDemo: async () => {
      const { renderVehicleAudioDemo } = await import('../audio/audioDemo');
      const r = await renderVehicleAudioDemo(spec);
      return { segments: r.segments, sampleRate: r.sampleRate, wav: r.wavBase64 };
    },
  });

  engine.start();
  // Let the suspension settle a few frames before declaring ready.
  await new Promise((r) => setTimeout(r, 300));
  window.__ready = true;
};

export default testtrack;
