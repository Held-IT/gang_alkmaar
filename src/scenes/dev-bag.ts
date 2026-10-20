// Dev scene for the 3D BAG pipeline output (public/data/buildings_*.glb, backdrop_*.glb).
//   ?scene=dev-bag[&view=lit|kind|uv|age|lib][&backdrop=0][&ground=1][&collision=1][&footprints=1]
//                 [&raw=1][&cam=x,y,z&look=x,y,z]
// Views:
//   lit  (default) walls brick-red tinted by COLOR_0.r with a simple window preview from the facade
//        attributes, slanted roofs orange/grey, flat roofs dark grey
//   kind COLOR_0.g: white = street facade, orange = party / blank wall, magenta = landmark
//   uv   1 m grid from TEXCOORD_0, floor lines from COLOR_0.a, blue above eaveHeight (TEXCOORD_1.y),
//        red ramp = u / facadeWidth
//   age  COLOR_0.b: dark red <= 1850, orange 1851-1940, green 1941-1990, blue > 1990
//   lib  the real MaterialLibrary from src/world/materials (falls back to lit when missing)
// `ground=1` also loads the OSM ground chunks when osm-meta.json exists (flat colours, or the
// library materials with view=lib).
// `collision=1` overlays collision_buildings.bin (cyan wireframe), `footprints=1` draws
// footprints.json as yellow outlines at y = 0.3. `raw=1` renders without the engine loop.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BagMeta, Footprints, MaterialClass, MaterialLibrary, OsmMeta, SceneEntry } from '../contracts';
import { DATA_URL } from '../config';
import { setupDevCamera } from '../dev/devCamera';

type View = 'lit' | 'kind' | 'uv' | 'age' | 'lib';
const VIEW_ID: Record<View, number> = { lit: 0, kind: 1, uv: 2, age: 3, lib: 0 };
/** Optional import: the materials module may not exist yet (ARCHITECTURE section 6). */
const materialModules = import.meta.glob<{ createMaterialLibrary(engine: Parameters<SceneEntry>[0]): Promise<MaterialLibrary> }>(
  '../world/materials/index.ts',
);
const CLASS_ID: Record<string, number> = { wall: 0, roof_slanted: 1, roof_flat: 2, backdrop: 3 };

/** Debug material: MeshStandardMaterial patched to read the BAG vertex attributes. */
function makeMaterial(cls: string, view: View): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, color: 0xffffff });
  mat.name = `dev-bag-${cls}`;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 bagData;
attribute vec2 metricUv;
attribute vec2 facade;
varying vec4 vBag;
varying vec2 vMuv;
varying vec2 vFacade;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vBag = bagData; vMuv = metricUv; vFacade = facade;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec4 vBag;
varying vec2 vMuv;
varying vec2 vFacade;
const int VIEW = ${VIEW_ID[view]};
const int CLS = ${CLASS_ID[cls] ?? 0};
float gridLine(float x, float w) { float f = abs(fract(x - 0.5) - 0.5); return 1.0 - smoothstep(0.0, w, f); }
vec3 brick(float seed) {
  vec3 a = vec3(0.42, 0.16, 0.10), b = vec3(0.55, 0.27, 0.16), c = vec3(0.36, 0.20, 0.15), d = vec3(0.62, 0.50, 0.38);
  vec3 col = seed < 0.4 ? mix(a, b, seed / 0.4) : seed < 0.85 ? mix(b, c, (seed - 0.4) / 0.45) : d;
  return col;
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  vec3 col = vec3(0.7);
  float seed = vBag.r, kind = vBag.g, age = vBag.b;
  float floorH = 2.5 + vBag.a * 2.0;
  if (VIEW == 0) {
    if (CLS == 0) {
      col = brick(seed);
      if (kind > 0.75) col = vec3(0.55, 0.50, 0.44);
      else if (kind > 0.25) col *= 0.82;
      else {
        // window preview: evenly spaced windows per floor below the eave
        float w = max(vFacade.x, 0.01);
        float n = max(1.0, floor(w / 2.4 + 0.5));
        float cell = w / n;
        float cu = fract(vMuv.x / cell);
        float fl = vMuv.y / floorH;
        float cv = fract(fl);
        bool inWin = abs(cu - 0.5) < 0.27 && cv > 0.25 && cv < 0.85 && vMuv.y > 0.6 && vMuv.y < vFacade.y - 0.4;
        bool attic = vMuv.y > vFacade.y + 0.6 && abs(cu - 0.5) < 0.18 && abs(fract((vMuv.y - vFacade.y) / 2.2) - 0.5) < 0.22;
        if (inWin || (attic && n >= 1.0 && w > 3.0 && w < 12.0)) col = vec3(0.06, 0.07, 0.08);
      }
    } else if (CLS == 1) {
      col = seed < 0.65 ? mix(vec3(0.45, 0.17, 0.09), vec3(0.55, 0.25, 0.12), seed / 0.65) : vec3(0.18, 0.18, 0.19);
    } else if (CLS == 2) {
      col = vec3(0.20 + 0.06 * seed);
    } else {
      // backdrop: TEXCOORD_1.x == 0 marks roofs
      bool roof = vFacade.x < 0.01;
      col = roof ? (seed < 0.6 ? vec3(0.45, 0.22, 0.14) : vec3(0.22, 0.22, 0.23)) : mix(brick(seed), vec3(0.5), 0.25);
    }
  } else if (VIEW == 1) {
    col = kind > 0.75 ? vec3(0.9, 0.1, 0.8) : kind > 0.25 ? vec3(1.0, 0.55, 0.1) : vec3(0.92);
    if (CLS == 1 || CLS == 2) col = mix(col, vec3(0.3, 0.3, 0.35), 0.6);
  } else if (VIEW == 2) {
    float g = max(gridLine(vMuv.x, 0.03), gridLine(vMuv.y, 0.03));
    col = vec3(0.85);
    if (CLS == 0 || CLS == 3) {
      float r = clamp(vMuv.x / max(vFacade.x, 0.01), 0.0, 1.0);
      col = mix(vec3(0.95, 0.95, 0.9), vec3(0.95, 0.35, 0.3), r);
      if (vMuv.y > vFacade.y) col = mix(col, vec3(0.3, 0.5, 1.0), 0.6);
      float fl = gridLine(vMuv.y / floorH, 0.02);
      col = mix(col, vec3(0.1, 0.6, 0.1), fl);
    }
    col = mix(col, vec3(0.1), g * 0.7);
  } else {
    col = age < 0.15 ? vec3(0.45, 0.05, 0.05) : age < 0.5 ? vec3(0.95, 0.55, 0.1) : age < 0.85 ? vec3(0.25, 0.7, 0.25) : vec3(0.2, 0.4, 0.95);
  }
  diffuseColor.rgb = col;
}`,
      );
  };
  mat.customProgramCacheKey = () => `dev-bag-${cls}-${view}`;
  return mat;
}

/** Copy GLB attributes to names the debug shader declares (avoids clashing with three's uv1/color). */
function aliasAttributes(geo: THREE.BufferGeometry): void {
  const n = geo.getAttribute('position').count;
  const color = geo.getAttribute('color');
  geo.setAttribute('bagData', color ?? new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  const uv = geo.getAttribute('uv');
  geo.setAttribute('metricUv', uv ?? new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const uv1 = geo.getAttribute('uv1');
  geo.setAttribute('facade', uv1 ?? new THREE.BufferAttribute(new Float32Array(n * 2), 2));
}

const GROUND_COLORS: Record<string, number> = {
  asphalt: 0x3a3a3c, klinkers: 0x7a4a3a, sidewalk: 0x8d8a85, square: 0x8a7f72, curb: 0x9a9a98,
  bikelane: 0x8a3a32, grass: 0x4e6b32, water: 0x2f4650, quay: 0x5e3a2c, quay_cap: 0xa8a49c,
  bridge_deck: 0x6a6460, bridge_side: 0x6a4030, bridge_rail: 0x222222, road_marking: 0xeeeeee,
  parking: 0x55524e, canal_bed: 0x2a2620, ground: 0x6d6a63,
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null; // dev server returns index.html for missing files
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Collision walls (ARCHITECTURE 4.4 binary format) as a wireframe overlay. */
async function addCollisionOverlay(scene: THREE.Scene): Promise<void> {
  const res = await fetch(`${DATA_URL}collision_buildings.bin`);
  if (!res.ok) return;
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const vc = dv.getUint32(0, true);
  const ic = dv.getUint32(4, true);
  const pos = new Float32Array(buf, 8, vc * 3);
  const idx = new Uint32Array(buf, 8 + vc * 12, ic);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x00e5ff, wireframe: true, depthTest: false, transparent: true, opacity: 0.6 }));
  mesh.renderOrder = 10;
  scene.add(mesh);
}

/** footprints.json outlines (minimap data). */
async function addFootprintOverlay(scene: THREE.Scene): Promise<void> {
  const fp = await fetchJson<Footprints>(`${DATA_URL}footprints.json`);
  if (!fp) return;
  const pts: number[] = [];
  for (const r of fp.rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      pts.push(a[0], 0.3, a[1], b[0], 0.3, b[1]);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xffe100, depthTest: false, transparent: true }));
  lines.renderOrder = 11;
  scene.add(lines);
}

/** Plain render loop without the engine (sky colour, fog, hemisphere + sun with shadows). */
function startRawLoop(engine: Parameters<SceneEntry>[0], controls: { update(): void; target: THREE.Vector3 }): void {
  const { renderer, scene } = engine;
  scene.background = new THREE.Color(0xa9c3dc);
  scene.fog = new THREE.Fog(0xa9c3dc, 700, 3500);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1;
  const hemi = new THREE.HemisphereLight(0xc4d8ee, 0x5a5348, 0.9);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 1200 });
  sun.shadow.bias = -0.0005;
  scene.add(hemi, sun, sun.target);
  const dir = new THREE.Vector3(-0.45, 0.75, 0.35).normalize();
  const canvas = renderer.domElement;
  const frame = (): void => {
    requestAnimationFrame(frame);
    controls.update();
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    const cam = engine.camera;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setPixelRatio(1);
      renderer.setSize(w, h, false);
    }
    if (cam.aspect !== w / h) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
    if (cam.far < 5000) { cam.far = 5000; cam.updateProjectionMatrix(); }
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).addScaledVector(dir, 500);
    renderer.render(scene, cam);
  };
  requestAnimationFrame(frame);
}

const devBag: SceneEntry = async (engine, params) => {
  const view = (params.get('view') ?? 'lit') as View;
  const showBackdrop = params.get('backdrop') !== '0';
  const showGround = params.get('ground') === '1';
  // raw=1: bypass the engine frame loop / post-processing and render directly with simple
  // lights (useful while the engine is being changed, or to judge the raw geometry).
  const raw = params.get('raw') === '1';
  const scene = engine.scene;

  const meta = await fetchJson<BagMeta>(`${DATA_URL}bag-meta.json`);
  if (!meta) throw new Error('bag-meta.json ontbreekt: draai eerst node tools/bag/build.mjs');

  // view=lib: use the real MaterialLibrary (materials module) when it exists.
  let library: MaterialLibrary | null = null;
  if (view === 'lib') {
    const libLoader = materialModules['../world/materials/index.ts'];
    if (libLoader) library = await (await libLoader()).createMaterialLibrary(engine);
    else console.warn('[dev-bag] MaterialLibrary niet gevonden, val terug op debugweergave');
  }
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const matFor = (cls: string): THREE.Material => {
    if (library) return library.get(cls as MaterialClass);
    if (!materials.has(cls)) materials.set(cls, makeMaterial(cls, view));
    return materials.get(cls)!;
  };

  const root = new THREE.Group();
  root.name = 'bag';
  scene.add(root);
  const loader = new GLTFLoader();
  const files = [...meta.buildingFiles.map((f) => f.file), ...(showBackdrop ? meta.backdropFiles : [])];
  let triangles = 0;
  let meshes = 0;
  const failed: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        const gltf = await loader.loadAsync(`${DATA_URL}${file}`);
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const cls = (mesh.material as THREE.Material).name;
          if (!library) aliasAttributes(mesh.geometry);
          mesh.material = matFor(cls);
          mesh.castShadow = cls !== 'backdrop';
          mesh.receiveShadow = true;
          triangles += (mesh.geometry.index?.count ?? 0) / 3;
          meshes++;
        });
        root.add(gltf.scene);
      } catch (err) {
        failed.push(file);
        console.error(`[dev-bag] laden mislukt: ${file}`, err);
      }
    }),
  );

  // ground plane (street level y = 0)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.95 }),
  );
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);

  if (params.get('collision') === '1') await addCollisionOverlay(scene);
  if (params.get('footprints') === '1') await addFootprintOverlay(scene);

  if (showGround) {
    const osm = await fetchJson<OsmMeta>(`${DATA_URL}osm-meta.json`);
    if (osm) {
      await Promise.all(
        osm.groundFiles.map(async (file) => {
          try {
            const gltf = await loader.loadAsync(`${DATA_URL}${file}`);
            const water: THREE.Mesh[] = [];
            gltf.scene.traverse((o) => {
              const mesh = o as THREE.Mesh;
              if (!mesh.isMesh) return;
              const name = (mesh.material as THREE.Material).name;
              if (library && name === 'water') water.push(mesh);
              else if (library) mesh.material = library.get(name as MaterialClass);
              else mesh.material = new THREE.MeshStandardMaterial({ color: GROUND_COLORS[name] ?? 0x777777, roughness: 0.9 });
              mesh.receiveShadow = true;
            });
            for (const w of water) {
              // water has its own mesh/material (reflections) from the library
              w.removeFromParent();
              const wm = library!.createWater(w.geometry);
              wm.position.copy(w.position);
              scene.add(wm);
            }
            scene.add(gltf.scene);
          } catch (err) {
            console.warn(`[dev-bag] ground ${file} niet geladen`, err);
          }
        }),
      );
      ground.position.y = -3.6;
    }
  }

  const controls = setupDevCamera(engine, params, { cam: new THREE.Vector3(200, 500, 600), look: new THREE.Vector3(0, 0, 0) });
  window.__debug = window.__debug ?? {};
  window.__debug.bag = { files: files.length, failed, meshes, triangles, buildingCount: meta.buildingCount };
  console.info(`[dev-bag] ${files.length} files, ${meshes} meshes, ${Math.round(triangles)} triangles`);
  if (raw) startRawLoop(engine, controls);
  else engine.start();
  window.__ready = true;
};

export default devBag;
