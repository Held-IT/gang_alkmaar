// The game: loading screen → city → main menu (car select over a slow city fly-over) → driving.
//
// URL parameters (mainly for testing / screenshots):
//   ?autostart=1          skip the main menu and drive immediately
//   &car=<specId>         car for autostart (default: DEFAULT_CAR_ID)
//   &color=<hex>          paint colour for autostart, e.g. 2b4c7e
//   &spawn=<spawnId>      start point for autostart (waag, grote_kerk, station, molen, singel, verdronkenoord)
//   &traffic=0            disable AI traffic
//   &quality=<level>      handled by the engine (laag | midden | hoog | ultra)
import * as THREE from 'three';
import type { CarSpec, SceneEntry, SpawnPoint } from '../contracts';
import { createPhysics } from '../physics/physics';
import { loadWorld } from '../world/world';
import { createTraffic, type TrafficSystemExt } from '../traffic';
import { createUI, type HudInfo, type PauseHandlers } from '../ui';
import { CAR_SPECS, DEFAULT_CAR_ID, getSpec } from '../vehicle/specs';
import { createCarModel, randomDutchPlate, type CarModelExt } from '../vehicle/models';
import { createPlayerVehicle, type PlayerVehicleExt } from '../vehicle/physics/vehicle';
import { createCameraController, type CameraController } from '../camera/cameraController';
import { createInput } from '../core/input';
import { createVehicleAudio, prepareVehicleAudio, type VehicleAudio } from '../audio/vehicleAudio';

type GameState = 'loading' | 'menu' | 'driving' | 'paused';

interface Session {
  spec: CarSpec;
  model: CarModelExt;
  vehicle: PlayerVehicleExt;
  camera: CameraController;
  audio: VehicleAudio;
  unsubs: (() => void)[];
}

const game: SceneEntry = async (engine, params) => {
  const ui = createUI(engine);
  let state: GameState = 'loading';
  ui.showLoading(0.01, 'Opstarten');
  engine.start();

  // ---------------------------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------------------------
  const physics = await createPhysics();
  ui.showLoading(0.04, 'Kaartgegevens laden');
  const world = await loadWorld(engine, physics, (f, label) => ui.showLoading(0.04 + f * 0.84, label));

  let traffic: TrafficSystemExt | null = null;
  if (params.get('traffic') !== '0') {
    ui.showLoading(0.9, 'Verkeer de stad in sturen');
    await nextFrame();
    traffic = createTraffic(engine, physics, world);
  }

  // Build a player car once (same options as a session car) and compile its shaders now, so the
  // first drive starts without a hitch. It stays out of the scene (apart from two warm-up frames)
  // and alive for the whole game: three.js frees a program once the last material using it is disposed, and
  // the per-car materials (paint, lights, plate/decal) are disposed with every session. Without a
  // keeper, each start (and each car change) would recompile them on its first frame.
  ui.showLoading(0.93, 'Auto voorbereiden');
  const programKeeper = createCarModel(DEFAULT_CAR_ID, {
    lod: 0,
    color: getSpec(DEFAULT_CAR_ID).paints[0],
    plate: randomDutchPlate('auto'),
  });
  programKeeper.root.position.set(0, -50, 0);
  await world.warmUp([programKeeper.root], 8000);
  // compileAsync() skips the shadow-map depth variants and the buffer/texture uploads: draw the
  // keeper for two frames (under the loading screen) just in front of the camera, then take it out.
  {
    const cam = engine.camera;
    const ahead = cam.getWorldDirection(new THREE.Vector3()).multiplyScalar(12);
    programKeeper.root.position.copy(cam.position).add(ahead);
    engine.scene.add(programKeeper.root);
    await nextFrame();
    await nextFrame();
    programKeeper.root.removeFromParent();
    programKeeper.root.position.set(0, -50, 0);
  }
  // Shared AudioContext + synthesized sounds for the first car: otherwise the first
  // createVehicleAudio() blocks ~250 ms (iGPU laptop) when driving starts. The other cars follow
  // in the background once the main menu is up.
  const autostart = params.get('autostart') === '1';
  const firstCar = CAR_SPECS.find((s) => s.id === (autostart ? params.get('car') : null)) ?? getSpec(DEFAULT_CAR_ID);
  await prepareVehicleAudio(firstCar);

  ui.showLoading(0.96, 'Kaart tekenen');
  const spawnPoints = world.osmMeta.spawnPoints;
  ui.setSpawnPoints(spawnPoints);
  if (world.map2d) {
    await ui.minimap.setData(world.map2d, world.footprints, world.roadGraph);
    ui.minimap.setLandmarks(world.osmMeta.landmarks);
  }

  const input = createInput(engine);
  let session: Session | null = null;
  // Note: the main menu renders at the player's own quality settings. (It used to lower
  // renderScale through engine.setQuality, but that persists the value and shows it in
  // Instellingen; the fly-over measured no heavier than driving, so the trick was dropped.)

  // ---------------------------------------------------------------------------------------------
  // Menu fly-over camera: slow orbit around the Kaasmarkt / Waag, drifting between landmarks.
  // ---------------------------------------------------------------------------------------------
  const flyTargets = flyoverTargets(world.osmMeta.landmarks);
  const flyFocus = new THREE.Vector3();
  const flyLook = new THREE.Vector3();
  let flyTime = 0;
  function updateFlyover(dt: number): void {
    flyTime += dt;
    const seg = 28; // seconds per landmark
    const i = Math.floor(flyTime / seg) % flyTargets.length;
    const t = (flyTime % seg) / seg;
    const tgt = flyTargets[i];
    const ang = tgt.angle + t * 0.9;
    const radius = tgt.radius;
    flyFocus.set(tgt.x, 0, tgt.z);
    const cam = engine.camera;
    cam.position.set(tgt.x + Math.sin(ang) * radius, tgt.height, tgt.z + Math.cos(ang) * radius);
    flyLook.set(tgt.x, tgt.lookY, tgt.z);
    cam.lookAt(flyLook);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
    engine.setFocus(flyFocus);
  }

  // ---------------------------------------------------------------------------------------------
  // Frame loop (engine.onUpdate priorities: input 0, physics 10, traffic 30, world 40, camera 50, ui 60)
  // ---------------------------------------------------------------------------------------------
  const hudInfo: HudInfo = {
    x: 0,
    z: 0,
    heading: 0,
    lights: { head: false, handbrake: false, abs: false, tcs: false, esc: false },
    gearboxMode: 'auto',
  };

  engine.onUpdate(() => {
    const driving = state === 'driving' && !ui.isBlockingInput();
    input.setEnabled(driving);
    if (session && state === 'driving') session.vehicle.setInput(input.read());
  }, 0);

  engine.onUpdate((dt) => {
    if (state !== 'paused') physics.step(dt);
  }, 10);

  engine.onUpdate((dt) => {
    if (!traffic || state === 'paused') return;
    traffic.update(dt, session ? session.vehicle.position : flyFocus);
  }, 30);

  engine.onUpdate((dt) => {
    world.update(dt, engine.camera.position);
    if (session) session.model.update(dt);
  }, 40);

  engine.onUpdate((dt) => {
    if (state === 'menu' || state === 'loading') updateFlyover(dt);
  }, 50);

  engine.onUpdate((dt) => {
    if (!session) return;
    const { vehicle, audio, camera } = session;
    audio.update(dt);
    audio.setPerspective(camera.mode === 'hood' || camera.mode === 'bumper' ? 'interior' : 'exterior');
    if (state !== 'driving') return;
    const c = vehicle.controls;
    hudInfo.x = vehicle.position.x;
    hudInfo.z = vehicle.position.z;
    hudInfo.heading = vehicle.heading;
    const l = hudInfo.lights!;
    l.head = c.headlights;
    l.handbrake = c.handbrake;
    l.abs = c.absActive;
    l.tcs = c.tcsActive;
    l.esc = c.escActive;
    hudInfo.gearboxMode = c.gearboxMode;
    ui.hud.update(vehicle.telemetry, hudInfo);
    ui.minimap.update(vehicle.position.x, vehicle.position.z, vehicle.heading);
  }, 60);

  // ---------------------------------------------------------------------------------------------
  // Car session management
  // ---------------------------------------------------------------------------------------------
  function endSession(): void {
    if (!session) return;
    traffic?.setPlayer(null);
    session.unsubs.forEach((u) => u());
    session.audio.dispose();
    session.camera.dispose();
    session.vehicle.dispose();
    session.model.dispose();
    session = null;
    ui.hud.hide();
  }

  function spawnAt(sp: SpawnPoint): void {
    if (!session) return;
    session.vehicle.teleport(sp.x, sp.z, sp.heading);
    session.camera.snap();
    physics.resetAccumulator();
  }

  function startDriving(carId: string, color: string | undefined, spawnId: string | undefined): void {
    endSession();
    // The menu closes itself before onStart, but __debug.start() and other callers do not go through
    // it: an open menu or pause sheet would keep blocking input (both calls are no-ops when hidden).
    ui.hideMainMenu();
    ui.hidePause();
    const spec = getSpec(carId);
    const model = createCarModel(spec.id, {
      lod: 0,
      color: color ?? spec.paints[0],
      plate: randomDutchPlate(spec.category === 'bestelbus' ? 'bestel' : 'auto'),
    });
    const vehicle = createPlayerVehicle(engine, physics, spec, model);
    const camera = createCameraController(engine, vehicle, physics);
    const audio = createVehicleAudio(vehicle);
    audio.setVolume(ui.volume);
    vehicle.setGearboxMode(ui.gearbox);
    vehicle.setAssists(ui.assists);
    session = {
      spec,
      model,
      vehicle,
      camera,
      audio,
      unsubs: [
        // While paused the engine sound stays muted; resume() restores ui.volume.
        ui.onVolumeChange((v) => audio.setVolume(state === 'paused' ? 0 : v)),
        ui.onDrivingChange((p) => {
          vehicle.setGearboxMode(p.gearbox);
          vehicle.setAssists(p.assists);
        }),
      ],
    };
    spawnAt(world.spawn(spawnId));
    traffic?.setPlayer({ position: vehicle.position, velocity: vehicle.velocity, quaternion: vehicle.quaternion });
    ui.hud.setCar(spec);
    ui.hud.show();
    state = 'driving';
    ui.toast(`Welkom in Alkmaar — ${spec.name}`, 3200);
  }

  function showMenu(): void {
    endSession();
    state = 'menu';
    flyTime = 0;
    ui.showMainMenu({
      cars: CAR_SPECS,
      defaultCarId: DEFAULT_CAR_ID,
      spawnPoints,
      defaultSpawnId: 'waag',
      onStart: (sel) => startDriving(sel.carId, sel.color, sel.spawnId),
      onQuit: () => quitGame(),
    });
  }

  function quitGame(): void {
    window.close();
    // In a normal browser tab window.close() is ignored: fall back to the main menu.
    setTimeout(() => {
      if (state !== 'menu') showMenu();
    }, 200);
  }

  const pauseHandlers: PauseHandlers = {
    onResume: () => resume(),
    onChangeCar: () => showMenu(),
    onRespawn: (spawnId) => {
      spawnAt(world.spawn(spawnId));
      resume();
    },
    onQuit: () => quitGame(),
  };

  function pause(): void {
    if (state !== 'driving' || !session) return;
    state = 'paused';
    session.vehicle.setFrozen(true);
    session.audio.setVolume(0);
    ui.showPause(pauseHandlers);
  }

  function resume(): void {
    if (!session) return;
    ui.hidePause();
    session.vehicle.setFrozen(false);
    session.audio.setVolume(ui.volume);
    physics.resetAccumulator();
    state = 'driving';
  }

  input.onAction('pause', () => {
    if (state === 'driving' && !ui.isBlockingInput()) pause();
  });
  input.onAction('camera', () => {
    if (state === 'driving') session?.camera.cycleMode();
  });
  // Lose focus (alt-tab) while driving → pause, like most games.
  window.addEventListener('blur', () => {
    if (state === 'driving' && !autostart) pause();
  });

  // ---------------------------------------------------------------------------------------------
  // Debug hooks for tooling
  // ---------------------------------------------------------------------------------------------
  window.__debug = {
    ...(window.__debug ?? {}),
    world,
    traffic,
    physics,
    get state() {
      return state;
    },
    get vehicle() {
      return session?.vehicle ?? null;
    },
    get camera() {
      return session?.camera ?? null;
    },
    start: (carId = DEFAULT_CAR_ID, spawnId = 'waag', color?: string) => startDriving(carId, color, spawnId),
    teleport: (x: number, z: number, heading = 0) => {
      session?.vehicle.teleport(x, z, heading);
      session?.camera.snap();
    },
    menu: () => showMenu(),
    pause: () => pause(),
    resume: () => resume(),
  };

  // ---------------------------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------------------------
  ui.showLoading(1, 'Klaar');
  await nextFrame();
  ui.hideLoading();
  if (autostart) {
    const color = params.get('color');
    startDriving(params.get('car') ?? DEFAULT_CAR_ID, color ? `#${color.replace('#', '')}` : undefined, params.get('spawn') ?? 'waag');
  } else {
    showMenu();
    // Cached per car; yields between buffers so the menu fly-over keeps running.
    void prepareVehicleAudio(CAR_SPECS);
  }
  window.__ready = true;
};

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

interface FlyTarget {
  x: number;
  z: number;
  angle: number;
  radius: number;
  height: number;
  lookY: number;
}

/** Camera orbits for the main menu, around recognisable landmarks. */
function flyoverTargets(landmarks: { id: string; x: number; z: number }[]): FlyTarget[] {
  const byId = new Map(landmarks.map((l) => [l.id, l]));
  const pick = (id: string, fallback: [number, number]) => {
    const l = byId.get(id);
    return l ? [l.x, l.z] : fallback;
  };
  const [wx, wz] = pick('waag', [0, 0]);
  const [kx, kz] = pick('grote_kerk', [-420, 40]);
  const [mx, mz] = pick('molen_van_piet', [-565, 146]);
  const [ax, az] = pick('accijnstoren', [80, -60]);
  return [
    { x: wx, z: wz, angle: 2.4, radius: 95, height: 38, lookY: 10 },
    { x: kx, z: kz, angle: 0.6, radius: 120, height: 48, lookY: 18 },
    { x: mx, z: mz, angle: 3.6, radius: 70, height: 26, lookY: 12 },
    { x: ax, z: az, angle: 5.0, radius: 80, height: 30, lookY: 6 },
  ];
}

export default game;
