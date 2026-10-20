// Live 3D car preview for the car-selection menu: a small dedicated WebGLRenderer showing the
// selected car on a turntable in a soft studio light (RoomEnvironment reflections, contact
// shadow, glowing platform ring). Real models come from src/vehicle/models (optional import);
// when that module is missing or fails, a simple extruded silhouette car is shown instead.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarModel, CarModelOptions, CarSpec } from '../contracts';

type ModelsModule = {
  createCarModel?: (specId: string, opts?: CarModelOptions) => CarModel;
  randomDutchPlate?: () => string;
};
const modelModules = import.meta.glob<ModelsModule>('../vehicle/models/index.ts');

export interface CarPreview {
  readonly canvas: HTMLCanvasElement;
  setCar(spec: CarSpec, color: string): void;
  setPaint(color: string): void;
  /** Start / stop the render loop (stop while the menu is hidden). */
  start(): void;
  stop(): void;
  dispose(): void;
}

interface Shown {
  specId: string;
  root: THREE.Object3D;
  setPaint(c: string): void;
  dispose(): void;
}

const FOV = 24;
const ELEVATION = THREE.MathUtils.degToRad(12);
const AUTO_SPIN = 0.24; // rad/s

function radialTexture(stops: [number, string][], size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCarPreview(host: HTMLElement): CarPreview {
  const canvas = document.createElement('canvas');
  canvas.className = 'ad-preview-canvas';
  host.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.035);
  room.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.95;

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(4, 7, 6);
  const rim = new THREE.DirectionalLight(0xa9c2ff, 1.6);
  rim.position.set(-6, 3, -7);
  scene.add(key, rim);

  // Platform: soft floor disc, two thin rings (red accent + faint white) and a contact shadow.
  const platform = new THREE.Group();
  const floorTex = radialTexture([
    [0, 'rgba(92,100,114,0.55)'],
    [0.45, 'rgba(48,54,64,0.42)'],
    [0.8, 'rgba(22,26,32,0.16)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(1, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  const ringRed = new THREE.Mesh(
    new THREE.RingGeometry(0.992, 1, 192).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xff2b38, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
  );
  const ringGlow = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1.06, 192).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(0,0,0,0)'], [0.86, 'rgba(0,0,0,0)'], [0.94, 'rgba(255,40,52,0.35)'], [1, 'rgba(0,0,0,0)']]),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  // Ring UVs on RingGeometry are planar (0..1 over the bounding square): the radial texture
  // therefore maps the ring radius directly.
  const ringFaint = new THREE.Mesh(
    new THREE.RingGeometry(0.996, 1, 192).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false, toneMapped: false }),
  );
  floor.renderOrder = 0;
  ringFaint.renderOrder = ringRed.renderOrder = ringGlow.renderOrder = 1;
  platform.add(floor, ringGlow, ringRed, ringFaint);
  ringFaint.scale.setScalar(1.18);
  ringFaint.position.y = 0.001;
  ringRed.position.y = ringGlow.position.y = 0.002;
  const shadowTex = radialTexture([
    [0, 'rgba(0,0,0,0.88)'],
    [0.42, 'rgba(0,0,0,0.62)'],
    [0.75, 'rgba(0,0,0,0.2)'],
    [1, 'rgba(0,0,0,0)'],
  ]);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.position.y = 0.004;
  shadow.renderOrder = 2;
  scene.add(platform);

  const turntable = new THREE.Group();
  turntable.add(shadow);
  scene.add(turntable);

  let shown: Shown | null = null;
  let token = 0;
  let angle = -0.55;
  let introT = 1;
  let running = false;
  let raf = 0;
  let lastT = 0;
  let idleUntil = 0;
  let disposed = false;

  // `?silhouette` (dev flag) forces the fallback preview car.
  const modelsLoader = new URLSearchParams(location.search).has('silhouette') ? undefined : Object.values(modelModules)[0];
  const modelsPromise: Promise<ModelsModule | null> = modelsLoader
    ? modelsLoader().catch((e) => {
        console.warn('[ui] car models unavailable, using silhouette preview', e);
        return null;
      })
    : Promise.resolve(null);

  function frame(spec: CarSpec, obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const len = Math.max(size.z, size.x, spec.length);
    const ht = Math.max(size.y, spec.height);
    // Fixed reference length keeps relative car sizes visible (city car vs van).
    const ref = Math.max(len, 4.35);
    const vt = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const ht2 = vt * camera.aspect;
    const dW = ref / 2 / (ht2 * 0.62) + ref * 0.2;
    const dH = (Math.max(ht, 1.5) * 2.3) / 2 / vt;
    const d = Math.max(dW, dH);
    const ty = ht * 0.36;
    camera.position.set(0, ty + d * Math.sin(ELEVATION), d * Math.cos(ELEVATION));
    camera.lookAt(0, ty - ht * 0.08, 0);
    const pr = Math.hypot(spec.length, spec.width) * 0.5 + 0.55;
    platform.scale.setScalar(pr);
    ringFaint.scale.setScalar(1.12);
    shadow.scale.set(spec.width * 1.32, 1, spec.length * 1.12);
  }

  function resize(): void {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (shown) frame(currentSpec!, shown.root);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  let currentSpec: CarSpec | null = null;
  let plate = 'AD-073-K';

  async function load(spec: CarSpec, color: string): Promise<void> {
    const tk = ++token;
    canvas.classList.add('is-swap');
    const [mod] = await Promise.all([modelsPromise, new Promise((r) => setTimeout(r, 140))]);
    if (tk !== token || disposed) return;
    let next: Shown | null = null;
    if (mod?.createCarModel) {
      try {
        if (mod.randomDutchPlate && plate === 'AD-073-K') plate = mod.randomDutchPlate();
        const m = mod.createCarModel(spec.id, { lod: 0, color, plate });
        next = { specId: spec.id, root: m.root, setPaint: (c) => m.setPaint(c), dispose: () => m.dispose() };
      } catch (e) {
        console.warn(`[ui] createCarModel('${spec.id}') failed, using silhouette`, e);
      }
    }
    if (!next) next = buildFallbackCar(spec, color);
    if (shown) {
      turntable.remove(shown.root);
      shown.dispose();
    }
    shown = next;
    currentSpec = spec;
    turntable.add(next.root);
    frame(spec, next.root);
    angle = -0.62;
    introT = 0;
    canvas.classList.remove('is-swap');
    if (!running) render(0);
  }

  function render(dt: number): void {
    if (introT < 1) {
      introT = Math.min(1, introT + dt / 1.1);
    }
    if (performance.now() > idleUntil) angle += dt * AUTO_SPIN * (introT < 1 ? 0.2 + introT * 0.8 : 1);
    // ease-out spin-in when a new car appears
    const ease = 1 - Math.pow(1 - introT, 3);
    turntable.rotation.y = angle + (1 - ease) * -0.9;
    renderer.render(scene, camera);
  }

  function loop(t: number): void {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
    lastT = t;
    render(dt);
  }

  // drag to rotate
  let dragX: number | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    dragX = e.clientX;
    canvas.setPointerCapture(e.pointerId);
    idleUntil = performance.now() + 1e9;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragX === null) return;
    angle += (e.clientX - dragX) * 0.008;
    dragX = e.clientX;
  });
  const endDrag = (e: PointerEvent) => {
    if (dragX === null) return;
    dragX = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    idleUntil = performance.now() + 2500;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  resize();

  return {
    canvas,
    setCar(spec, color) {
      if (shown && shown.specId === spec.id && currentSpec === spec) {
        shown.setPaint(color);
        return;
      }
      void load(spec, color);
    },
    setPaint(color) {
      shown?.setPaint(color);
    },
    start() {
      if (running || disposed) return;
      running = true;
      lastT = 0;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    dispose() {
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (shown) shown.dispose();
      shown = null;
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mt) => {
            (mt as THREE.MeshBasicMaterial).map?.dispose();
            mt.dispose();
          });
        }
      });
      envRT.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fallback silhouette car (only used when src/vehicle/models is not available).
// ---------------------------------------------------------------------------------------------

/** Side profiles as (z / length, y / height): lower body and greenhouse. Front = +z. */
const PROFILES: Record<string, { body: [number, number][]; glass: [number, number][] }> = {
  hatch: {
    body: [[-0.5, 0.2], [-0.5, 0.56], [-0.47, 0.65], [0.16, 0.67], [0.45, 0.58], [0.5, 0.46], [0.5, 0.22], [0.46, 0.15], [-0.46, 0.15]],
    glass: [[-0.46, 0.64], [-0.39, 0.97], [0.04, 0.99], [0.18, 0.66]],
  },
  wagon: {
    body: [[-0.5, 0.2], [-0.5, 0.6], [-0.48, 0.66], [0.17, 0.67], [0.45, 0.58], [0.5, 0.46], [0.5, 0.22], [0.46, 0.15], [-0.46, 0.15]],
    glass: [[-0.48, 0.65], [-0.45, 0.96], [0.04, 0.99], [0.19, 0.66]],
  },
  sedan: {
    body: [[-0.5, 0.22], [-0.5, 0.6], [-0.44, 0.68], [-0.27, 0.69], [0.16, 0.67], [0.45, 0.58], [0.5, 0.46], [0.5, 0.22], [0.46, 0.15], [-0.46, 0.15]],
    glass: [[-0.3, 0.68], [-0.17, 0.98], [0.05, 0.99], [0.19, 0.66]],
  },
  van: {
    body: [[-0.5, 0.14], [-0.5, 0.98], [0.2, 0.99], [0.3, 0.86], [0.42, 0.6], [0.5, 0.5], [0.5, 0.2], [0.46, 0.13], [-0.46, 0.13]],
    glass: [[0.2, 0.66], [0.21, 0.94], [0.29, 0.85], [0.37, 0.66]],
  },
};

function profileFor(cat: string): { body: [number, number][]; glass: [number, number][] } {
  if (cat === 'stationwagen') return PROFILES.wagon;
  if (cat === 'sedan' || cat === 'taxi') return PROFILES.sedan;
  if (cat === 'bestelbus') return PROFILES.van;
  return PROFILES.hatch;
}

function extrude(pts: [number, number][], L: number, H: number, width: number, bevel: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z * L, y * H)));
  const depth = Math.max(0.05, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 4,
    curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2); // shape x -> world z (length), extrusion -> world x (width)
  g.computeVertexNormals();
  return g;
}

function buildFallbackCar(spec: CarSpec, color: string): Shown {
  const L = spec.length;
  const H = spec.height;
  const Wd = spec.width;
  const prof = profileFor(spec.category);
  const root = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.55,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0e13, metalness: 0.1, roughness: 0.04, clearcoat: 1 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.88 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 1, roughness: 0.22 });
  const lightW = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf2ff, emissiveIntensity: 1.6 });
  const lightR = new THREE.MeshStandardMaterial({ color: 0x660000, emissive: 0xff1a1a, emissiveIntensity: 1.2 });

  const body = new THREE.Mesh(extrude(prof.body, L, H, Wd, 0.1), paint);
  const gh = new THREE.Mesh(extrude(prof.glass, L, H, Wd * 0.84, 0.07), glass);
  root.add(body, gh);
  const r = spec.wheelRadius;
  const tw = spec.wheelWidth;
  const tyreG = new THREE.CylinderGeometry(r, r, tw, 36).rotateZ(Math.PI / 2);
  const rimG = new THREE.CylinderGeometry(r * 0.66, r * 0.66, tw * 1.02, 28).rotateZ(Math.PI / 2);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    // wheels flush with the body sides so they read as wheels in the silhouette
    const x = sx * (Wd / 2 - tw * 0.42);
    const z = (sz * spec.wheelbase) / 2;
    const t = new THREE.Mesh(tyreG, tyre);
    const rm = new THREE.Mesh(rimG, rim);
    t.position.set(x, r, z);
    rm.position.set(x, r, z);
    root.add(t, rm);
  }
  const hl = new THREE.BoxGeometry(Wd * 0.26, H * 0.05, 0.05);
  for (const s of [1, -1]) {
    const a = new THREE.Mesh(hl, lightW);
    a.position.set((s * Wd) / 3, H * 0.52, L * 0.5 - 0.02);
    const b = new THREE.Mesh(hl, lightR);
    b.position.set((s * Wd) / 3, H * 0.56, -L * 0.5 + 0.01);
    root.add(a, b);
  }
  return {
    specId: spec.id,
    root,
    setPaint: (c) => paint.color.set(c),
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      [paint, glass, tyre, rim, lightW, lightR].forEach((m) => m.dispose());
    },
  };
}
