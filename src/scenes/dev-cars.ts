// Showroom for the procedural car models.  ?scene=dev-cars
//   (no params)        all cars in a row on a light-grey studio floor
//   ?car=<id>          one car close-up on a slow turntable
//   ?lod=0|1|2         level of detail (default 0)
//   ?lights=1          head/tail/brake lights on (dusk exposure)
//   ?view=front|rear|side|34|top|r34|low|close|wheel|chase|rclose|face|tail   camera preset (default 34)
//   ?spin=0            stop the turntable
//   ?paint=#rrggbb     override paint colour
//   ?wire=1            wireframe overlay
//   ?steer=deg         front wheel steer angle
//   ?inst=N            instancing test: N cars per model as InstancedMeshes (getMergedGeometries)
// Exposes window.__debug.cars (CarModel[]) and window.__debug.carStats.
import * as THREE from 'three';
import type { CarModel, SceneEntry } from '../contracts';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { setupDevCamera } from '../dev/devCamera';
import { CAR_SPECS } from '../vehicle/specs';
import { createCarModel, getAtlasTextures, getMergedGeometries, getModelStats } from '../vehicle/models';

// camera presets for a 35 degree vertical field of view; +x is the car's LEFT side
const VIEWS: Record<string, (L: number, H: number) => { cam: THREE.Vector3; look: THREE.Vector3 }> = {
  '34': (L, H) => ({ cam: new THREE.Vector3(L * 0.95, H * 1.05, L * 1.2), look: new THREE.Vector3(0, H * 0.4, 0.15) }),
  r34: (L, H) => ({ cam: new THREE.Vector3(L * 0.95, H * 1.1, -L * 1.2), look: new THREE.Vector3(0, H * 0.4, -0.15) }),
  front: (L, H) => ({ cam: new THREE.Vector3(0, H * 0.75, L * 1.45), look: new THREE.Vector3(0, H * 0.42, 0) }),
  rear: (L, H) => ({ cam: new THREE.Vector3(0, H * 0.9, -L * 1.45), look: new THREE.Vector3(0, H * 0.42, 0) }),
  side: (L, H) => ({ cam: new THREE.Vector3(L * 1.75, H * 0.5, 0), look: new THREE.Vector3(0, H * 0.42, 0) }),
  top: (L, H) => ({ cam: new THREE.Vector3(0.01, L * 2.1, 0), look: new THREE.Vector3(0, 0, 0) }),
  low: (L, H) => ({ cam: new THREE.Vector3(L * 0.62, 0.42, L * 0.75), look: new THREE.Vector3(0, H * 0.38, 0.25) }),
  close: (L, H) => ({ cam: new THREE.Vector3(L * 0.42, H * 0.75, L * 0.5), look: new THREE.Vector3(0.3, H * 0.4, L * 0.3) }),
  wheel: (L, H) => ({ cam: new THREE.Vector3(L * 0.38, H * 0.35, L * 0.42), look: new THREE.Vector3(0.75, 0.3, L * 0.3) }),
  face: (L, H) => ({ cam: new THREE.Vector3(L * 0.5, H * 0.8, L * 1.05), look: new THREE.Vector3(0, H * 0.42, L * 0.36) }),
  tail: (L, H) => ({ cam: new THREE.Vector3(L * 0.45, H * 0.85, -L * 1.0), look: new THREE.Vector3(0, H * 0.45, -L * 0.36) }),
  // game chase camera: behind and above the car
  chase: (L, H) => ({ cam: new THREE.Vector3(0.0, H + 0.45, -L * 0.5 - 4.2), look: new THREE.Vector3(0, H * 0.6, L * 0.5) }),
  rclose: (L, H) => ({ cam: new THREE.Vector3(L * 0.3, H * 0.8, -L * 0.62), look: new THREE.Vector3(0.2, H * 0.5, -L * 0.4) }),
};

function makeFloor(): THREE.Mesh {
  // light grey studio floor with a soft radial falloff (canvas texture)
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(256, 256, 20, 256, 256, 256);
  grd.addColorStop(0, '#d9dad9');
  grd.addColorStop(0.6, '#cfd0cf');
  grd.addColorStop(1, '#b9bab9');
  g.fillStyle = grd;
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(60, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 }),
  );
  floor.receiveShadow = true;
  floor.name = 'studio-floor';
  return floor;
}

/**
 * raw=1: bypass the engine loop / post-processing and render directly with a studio environment
 * (RoomEnvironment IBL + one soft shadowed key light). Useful to judge shapes and materials in
 * neutral light and while the engine is being changed.
 */
function startRawLoop(engine: Parameters<SceneEntry>[0], controls: { update(): void; target: THREE.Vector3 }, exposure: number): void {
  const { renderer, scene } = engine;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 1;
  scene.background = new THREE.Color(0xc9cbcd);
  scene.fog = null;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 60 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 6;
  key.position.set(-6, 14, 8);
  scene.add(key, key.target);
  // hide the engine's sky / sun objects (we light the studio ourselves)
  scene.traverse((o) => {
    if (o.name === 'studio-floor' || o.name === 'showroom' || o === key || o === key.target || o === scene) return;
    if ((o as THREE.Mesh).isMesh || (o as THREE.Light).isLight) {
      let p: THREE.Object3D | null = o;
      while (p && p.name !== 'showroom') p = p.parent;
      if (!p) o.visible = false;
    }
  });
  const canvas = renderer.domElement;
  const frame = (): void => {
    requestAnimationFrame(frame);
    controls.update();
    for (const fn of rawUpdates) fn(1 / 60);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const cam = engine.camera;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
    }
    if (cam.aspect !== w / h) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    renderer.render(scene, cam);
    (engine.stats as { drawCalls: number; triangles: number }).drawCalls = renderer.info.render.calls;
    (engine.stats as { drawCalls: number; triangles: number }).triangles = renderer.info.render.triangles;
  };
  renderer.info.autoReset = true;
  requestAnimationFrame(frame);
}
const rawUpdates: ((dt: number) => void)[] = [];

const devCars: SceneEntry = async (engine, params) => {
  const scene = engine.scene;
  const lod = Math.max(0, Math.min(2, Number(params.get('lod') ?? 0))) as 0 | 1 | 2;
  const carId = params.get('car');
  const lightsOn = params.get('lights') === '1';
  const spin = params.get('spin') !== '0' && !!carId;
  const view = params.get('view') ?? '34';
  const steer = THREE.MathUtils.degToRad(Number(params.get('steer') ?? 0));

  await engine.env.ready;
  scene.add(makeFloor());

  // ?atlas=<id>&ch=map|orm : show the painted body atlas of a spec on a screen-filling plane
  const atlasId = params.get('atlas');
  if (atlasId) {
    const tex = getAtlasTextures(atlasId);
    const which = params.get('ch') === 'orm' ? tex.orm : tex.map;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial({ map: which, transparent: params.get('alpha') === '1', toneMapped: false }));
    plane.position.set(0, 1.2, 0);
    plane.name = 'showroom';
    scene.add(plane);
    engine.camera.fov = 35;
    engine.camera.updateProjectionMatrix();
    const controls = setupDevCamera(engine, params, { cam: new THREE.Vector3(0, 1.2, 3.25), look: new THREE.Vector3(0, 1.2, 0) });
    startRawLoop(engine, controls, 1);
    window.__ready = true;
    return;
  }

  const root = new THREE.Group();
  root.name = 'showroom';
  scene.add(root);

  // ?inst=N : traffic-style instancing test of getMergedGeometries (one InstancedMesh per part)
  const inst = Number(params.get('inst') ?? 0);
  if (inst > 0) {
    const ilod = (params.has('lod') ? lod : 1) as 0 | 1 | 2;
    const m4 = new THREE.Matrix4();
    const wm = new THREE.Matrix4();
    const flip = new THREE.Matrix4().makeRotationY(Math.PI);
    const col = new THREE.Color();
    CAR_SPECS.forEach((spec, row) => {
      const mg = getMergedGeometries(spec.id, ilod);
      const meshes = mg.parts.map((part) => {
        const im = new THREE.InstancedMesh(part.geometry, part.material, inst);
        im.castShadow = part.name !== 'glass' && part.name !== 'lights';
        im.receiveShadow = true;
        root.add(im);
        return im;
      });
      const wheels = new THREE.InstancedMesh(mg.wheel.geometry, mg.wheel.material, inst * 4);
      wheels.castShadow = true;
      root.add(wheels);
      for (let i = 0; i < inst; i++) {
        m4.makeRotationY(0.5).setPosition((i - (inst - 1) / 2) * 2.6, 0, (row - 3) * 6);
        for (const im of meshes) {
          im.setMatrixAt(i, m4);
          if (im.material === mg.parts[0].material) im.setColorAt(i, col.set(spec.paints[i % spec.paints.length]));
        }
        mg.wheelCenters.forEach((c, k) => {
          wm.makeTranslation(c.x, c.y, c.z);
          if (k % 2 === 1) wm.multiply(flip);
          wheels.setMatrixAt(i * 4 + k, m4.clone().multiply(wm));
        });
      }
    });
    engine.camera.fov = 35;
    engine.camera.updateProjectionMatrix();
    setupDevCamera(engine, params, { cam: new THREE.Vector3(-6, 9, 30), look: new THREE.Vector3(0, 0, 0) });
    engine.start();
    window.__ready = true;
    return;
  }
  const cars: CarModel[] = [];
  const specs = carId ? CAR_SPECS.filter((s) => s.id === carId) : CAR_SPECS;
  if (!specs.length) throw new Error(`Onbekende auto "${carId}". Kies uit: ${CAR_SPECS.map((s) => s.id).join(', ')}`);

  const buildMs: Record<string, number> = {};
  // all cars: angled parking (front three-quarter towards the camera), 2.7 m apart
  const pitch = 2.7;
  const totalW = pitch * (specs.length - 1) + 4;
  specs.forEach((spec, i) => {
    const paint = params.get('paint');
    const t0 = performance.now();
    const car = createCarModel(spec.id, { lod, color: paint ?? spec.paints[0] });
    buildMs[spec.id] = Math.round(performance.now() - t0);
    if (specs.length > 1) {
      car.root.rotation.y = 0.62;
      car.root.position.set((i - (specs.length - 1) / 2) * pitch, 0, 0);
    }
    car.setLights({ head: lightsOn, brake: lightsOn, indicatorL: false, reverse: false });
    for (let i = 0; i < 2; i++) car.setWheel(i, steer, 0, 0);
    root.add(car.root);
    cars.push(car);
  });

  const L = carId ? specs[0].length : totalW * 0.55 + 3;
  const H = carId ? specs[0].height : 1.6;
  const v = (VIEWS[view] ?? VIEWS['34'])(L, H);
  if (!carId) {
    v.cam.set(-1.0, 2.8, totalW * 0.78 + 1.5);
    v.look.set(0, 0.55, 0);
  }
  engine.camera.fov = 35;
  engine.camera.updateProjectionMatrix();
  const controls = setupDevCamera(engine, params, v);
  const setView = (name: string) => {
    const vv = (VIEWS[name] ?? VIEWS['34'])(L, H);
    (window.__debug!.setCam as (...a: number[]) => void)(vv.cam.x, vv.cam.y, vv.cam.z, vv.look.x, vv.look.y, vv.look.z);
  };
  const raw = params.get('raw') === '1';

  if (spin) {
    const turn = (dt: number) => {
      root.rotation.y += dt * 0.12;
    };
    if (raw) rawUpdates.push(turn);
    else engine.onUpdate(turn, 40);
  }
  if (lightsOn && !raw) {
    // dusk: dim sun and sky light so the emissive lamps read
    engine.env.sun.intensity *= 0.04;
    if (engine.env.fill) engine.env.fill.intensity *= 0.1;
    scene.environmentIntensity = 0.08;
    const dim = (dt: number) => {
      void dt;
      scene.environmentIntensity = 0.08;
    };
    engine.onUpdate(dim, 45);
  }
  window.__debug = window.__debug ?? {};
  window.__debug.cars = cars;
  window.__debug.view = setView;
  window.__debug.lights = (on: boolean) => cars.forEach((c) => c.setLights({ head: on, brake: on }));
  window.__debug.carStats = specs.map((s) => ({ id: s.id, buildMs: buildMs[s.id], ...getModelStats(s.id, lod) }));
  if (raw) startRawLoop(engine, controls, lightsOn ? 0.35 : 1);
  else engine.start();
  window.__ready = true;
};

export default devCars;
