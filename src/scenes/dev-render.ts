// Lighting / rendering test scene for the engine module.  ?scene=dev-render
//   ?view=street (default) | aerial | spheres | canyon | far | sun | closeup | poles   camera presets
//   ?stress=1   ~20k instanced boxes over 2 km (fog + performance test)
//   ?city=1     load the real city data instead (views: waag, verdronkenoord, kerk, cityAerial, cityLow)
//   ?quality=..., ?tm=..., ?exposure=...  (handled by the engine)
// Contents: tiled ground, PBR sphere grid (roughness x metalness), car-paint sphere, brick
// house-like blocks with gable roofs forming a street canyon (shadows / AO), thin poles, a car-sized
// box, a glass pane (transparency + fog), an emissive lamp (bloom), distant blocks (aerial fog).
import * as THREE from 'three';
import type { Engine, MaterialClass, MaterialLibrary, SceneEntry } from '../contracts';
import { setupDevCamera } from '../dev/devCamera';
import { asEngineExt } from '../core/engine';
import { DATA_URL } from '../config';

const VIEWS: Record<string, { cam: [number, number, number]; look: [number, number, number] }> = {
  street: { cam: [-6, 1.7, 30], look: [2, 4.5, -10] },
  aerial: { cam: [-160, 110, 210], look: [0, 0, -20] },
  spheres: { cam: [10, 2.2, 22], look: [14, 0.8, 12] },
  canyon: { cam: [0.5, 1.6, 18], look: [0, 3, -30] },
  far: { cam: [-30, 4, 120], look: [0, 30, -900] },
  sun: { cam: [5, 1.7, 30], look: [-60, 45, 70] },
  closeup: { cam: [-2.5, 1.5, 14.5], look: [1.5, 0.4, 7.5] },
  poles: { cam: [-8, 2.2, 10], look: [-2, 0, -2] },
  // real city (?city=1)
  waag: { cam: [52, 1.7, 22], look: [0, 1.5, 0] },
  verdronkenoord: { cam: [70, 1.7, 205], look: [140, 1.5, 250] },
  kerk: { cam: [-345, 1.7, -40], look: [-420, 1.5, -125] },
  cityAerial: { cam: [420, 260, 620], look: [-150, 0, -100] },
  cityLow: { cam: [180, 40, 260], look: [-200, 10, -120] },
};

function makeTileTexture(renderer: THREE.WebGLRenderer, anisotropy: number): THREE.CanvasTexture {
  // 2 x 2 m of 30 cm concrete tiles with grout and speckle (procedural, for shadow/AO judging)
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8d8a84';
  g.fillRect(0, 0, size, size);
  const tile = size / 6;
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const v = 128 + Math.floor((rnd() - 0.5) * 22);
      g.fillStyle = `rgb(${v + 6},${v + 3},${v - 2})`;
      g.fillRect(x * tile + 2, y * tile + 2, tile - 4, tile - 4);
    }
  }
  for (let i = 0; i < 9000; i++) {
    const v = Math.floor(90 + rnd() * 90);
    g.fillStyle = `rgba(${v},${v},${v - 4},0.35)`;
    g.fillRect(rnd() * size, rnd() * size, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(anisotropy, renderer.capabilities.getMaxAnisotropy());
  tex.repeat.set(1, 1);
  return tex;
}

function makeBrickTexture(): THREE.CanvasTexture {
  // simple running-bond brick (21 x 5 cm + 1 cm joints), 1 m tile
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b7aa98';
  g.fillRect(0, 0, size, size);
  const rows = 16;
  const bh = size / rows;
  const bw = size / 4.5;
  let seed = 3;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let x = -bw; x < size + bw; x += bw) {
      const k = rnd();
      const R = 120 + k * 40; const G = 48 + k * 18; const B = 34 + k * 10;
      g.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`;
      g.fillRect(x + off + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Box house with a gable roof prism, UVs in metres (so a 1 m texture tiles correctly). */
function makeHouse(w: number, d: number, h: number, roofH: number, wallMat: THREE.Material, roofMat: THREE.Material): THREE.Group {
  const grp = new THREE.Group();
  const body = new THREE.BoxGeometry(w, h, d);
  // metric UVs on the box (u along face, v height)
  const pos = body.attributes.position as THREE.BufferAttribute;
  const nrm = body.attributes.normal as THREE.BufferAttribute;
  const uv = body.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)); const ny = Math.abs(nrm.getY(i));
    const x = pos.getX(i); const y = pos.getY(i) + h / 2; const z = pos.getZ(i);
    if (ny > 0.5) uv.setXY(i, x, z);
    else if (nx > 0.5) uv.setXY(i, z, y);
    else uv.setXY(i, x, y);
  }
  const wall = new THREE.Mesh(body, wallMat);
  wall.position.y = h / 2;
  wall.castShadow = wall.receiveShadow = true;
  grp.add(wall);
  // gable roof: triangular prism along x
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2 - 0.3, 0);
  shape.lineTo(d / 2 + 0.3, 0);
  shape.lineTo(0, roofH);
  shape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(shape, { depth: w + 0.4, bevelEnabled: false });
  roofGeo.translate(0, 0, -(w + 0.4) / 2);
  roofGeo.rotateY(Math.PI / 2);
  const roof = new THREE.Mesh(roofGeo, roofMat);
  roof.position.y = h;
  roof.castShadow = roof.receiveShadow = true;
  grp.add(roof);
  return grp;
}

/**
 * ?city=1: loads the real Alkmaar data (public/data buildings / backdrop / ground GLBs) with the
 * materials module's MaterialLibrary when available (optional import), to judge the engine's
 * lighting, shadows and fog on the real city. Not a replacement for the world module.
 */
async function loadCity(engine: Engine, root: THREE.Group): Promise<void> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  type MatModule = { createMaterialLibrary: (e: Engine) => Promise<MaterialLibrary> };
  const matModules = import.meta.glob<MatModule>('../world/materials/index.ts');
  let lib: MaterialLibrary | null = null;
  const loadLib = matModules['../world/materials/index.ts'];
  if (loadLib) {
    try {
      lib = await (await loadLib()).createMaterialLibrary(engine);
    } catch (e) {
      console.warn('[dev-render] MaterialLibrary niet beschikbaar, eenvoudige materialen:', e);
    }
  }
  const fallbackColors: Record<string, number> = {
    wall: 0x8a4a3a, roof_slanted: 0x5a2e26, roof_flat: 0x555555, backdrop: 0x7a5a50, asphalt: 0x404040,
    klinkers: 0x7a4a3c, sidewalk: 0x9a968e, square: 0x8a7a6a, curb: 0xa0a0a0, bikelane: 0x7a3a32,
    grass: 0x4a6a32, water: 0x203038, quay: 0x6a3a2e, quay_cap: 0xb0aaa0, canal_bed: 0x2a2620,
  };
  const fallback = new Map<string, THREE.Material>();
  const matFor = (name: string): THREE.Material => {
    if (lib) {
      try { return lib.get(name as MaterialClass); } catch { /* unknown class: fall back */ }
    }
    let m = fallback.get(name);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: fallbackColors[name] ?? 0x888888, roughness: 0.85 });
      fallback.set(name, m);
    }
    return m;
  };
  const getJson = async <T,>(f: string): Promise<T> => JSON.parse((await new THREE.FileLoader().loadAsync(DATA_URL + f)) as string) as T;
  const bag = await getJson<{ buildingFiles: { file: string }[]; backdropFiles: string[] }>('bag-meta.json');
  const osm = await getJson<{ groundFiles: string[] }>('osm-meta.json');
  const loader = new GLTFLoader();
  const files = [...bag.buildingFiles.map((f) => f.file), ...bag.backdropFiles, ...osm.groundFiles];
  await Promise.all(files.map(async (file) => {
    try {
      const gltf = await loader.loadAsync(DATA_URL + file);
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const mesh of meshes) {
        const name = (mesh.material as THREE.Material).name;
        if (name === 'water' && lib) {
          const water = lib.createWater(mesh.geometry);
          water.position.copy(mesh.position);
          water.quaternion.copy(mesh.quaternion);
          mesh.parent?.add(water);
          mesh.parent?.remove(mesh);
          continue;
        }
        mesh.material = matFor(name);
        mesh.castShadow = !file.startsWith('backdrop') && name !== 'water';
        mesh.receiveShadow = true;
      }
      root.add(gltf.scene);
    } catch (e) {
      console.warn(`[dev-render] ${file} kon niet geladen worden`, e);
    }
  }));
}

/** The synthetic lighting test content (default mode). */
function buildTestScene(engine: Engine, root: THREE.Group, params: URLSearchParams): void {
  const { renderer } = engine;
  // --- ground --------------------------------------------------------------------------------------
  const tiles = makeTileTexture(renderer, engine.quality.anisotropy);
  tiles.repeat.set(1 / 2, 1 / 2);
  const groundMat = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.88, metalness: 0 });
  const groundGeo = new THREE.PlaneGeometry(6000, 6000, 1, 1).rotateX(-Math.PI / 2);
  {
    const uv = groundGeo.attributes.uv as THREE.BufferAttribute;
    const pos = groundGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
  }
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  root.add(ground);

  // asphalt road strip through the canyon
  const asphalt = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 400).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x3b3a39, roughness: 0.93 }),
  );
  asphalt.position.set(0, 0.005, -80);
  asphalt.receiveShadow = true;
  root.add(asphalt);

  // --- PBR spheres ---------------------------------------------------------------------------------
  const sphereGeo = new THREE.SphereGeometry(0.5, 48, 24);
  for (let m = 0; m < 2; m++) {
    for (let r = 0; r < 6; r++) {
      const mat = new THREE.MeshStandardMaterial({
        color: m ? 0xd8d4cc : 0xb8b2a8,
        roughness: 0.05 + r * 0.19,
        metalness: m,
      });
      const s = new THREE.Mesh(sphereGeo, mat);
      s.position.set(9 + r * 1.4, 0.5, 9 + m * 1.6);
      s.castShadow = s.receiveShadow = true;
      root.add(s);
    }
  }
  // glossy car-paint sphere (metallic flake base + clearcoat)
  const paint = new THREE.Mesh(
    new THREE.SphereGeometry(1.1, 64, 32),
    new THREE.MeshPhysicalMaterial({ color: 0x14305e, metalness: 0.55, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.03 }),
  );
  paint.position.set(13, 1.1, 14.5);
  paint.castShadow = paint.receiveShadow = true;
  root.add(paint);
  // a car-sized box for contact shadows / AO under a vehicle
  const car = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1.0, 4.2),
    new THREE.MeshPhysicalMaterial({ color: 0x8a1c14, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05 }),
  );
  car.position.set(2.2, 0.75, 8);
  car.castShadow = car.receiveShadow = true;
  root.add(car);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.1, metalness: 0.2 }));
  cabin.position.set(2.2, 1.5, 7.8);
  cabin.castShadow = true;
  root.add(cabin);

  // --- brick houses forming a street canyon ---------------------------------------------------------
  const brick = makeBrickTexture();
  const wallMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5a2a20, roughness: 0.7 });
  const plasterMat = new THREE.MeshStandardMaterial({ color: 0xe6e0d4, roughness: 0.9 });
  let seed = 11;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const side of [-1, 1]) {
    let z = 4;
    while (z > -160) {
      const w = 5 + rnd() * 3;
      const h = 4 + rnd() * 8;
      const d = 9 + rnd() * 4;
      const house = makeHouse(d, w, h, 2.5 + rnd() * 3, rnd() < 0.2 ? plasterMat : wallMat, roofMat);
      house.position.set(side * (5 + d / 2), 0, z - w / 2);
      root.add(house);
      z -= w;
    }
  }

  // thin poles (lamp posts) to judge shadow resolution
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1e2a22, roughness: 0.5, metalness: 0.6 });
  for (let i = 0; i < 6; i++) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 12), poleMat);
    pole.position.set(-3.8, 2.1, 6 - i * 14);
    pole.castShadow = pole.receiveShadow = true;
    root.add(pole);
  }
  // emissive lamp (bloom test)
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffd8a0, emissiveIntensity: 40 }),
  );
  lamp.position.set(-3.8, 4.3, 6);
  root.add(lamp);
  // glass pane (transparency + fog)
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(3, 2),
    new THREE.MeshPhysicalMaterial({ color: 0x9fb8c0, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35 }),
  );
  glass.position.set(6, 1.2, 16);
  glass.rotation.y = -0.4;
  root.add(glass);

  // distant blocks (aerial perspective)
  const farGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const farMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.85 });
  const tower = new THREE.Mesh(farGeo, farMat);
  tower.scale.set(14, 70, 14);
  tower.position.set(-40, 0, -400);
  tower.castShadow = tower.receiveShadow = true;
  root.add(tower);

  const stress = params.get('stress') === '1';
  const ringCount = stress ? 20000 : 600;
  const inst = new THREE.InstancedMesh(farGeo, new THREE.MeshStandardMaterial({ color: 0x8c5a48, roughness: 0.9 }), ringCount);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < ringCount; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = stress ? 60 + Math.sqrt(rnd()) * 1000 : 250 + rnd() * 1500;
    p.set(Math.cos(a) * rr, 0, Math.sin(a) * rr);
    if (Math.abs(p.x) < 25 && p.z < 30 && p.z > -200) p.x += 60 * Math.sign(p.x || 1);
    sc.set(6 + rnd() * 10, 5 + rnd() * (stress ? 14 : 22), 6 + rnd() * 10);
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI);
    m4.compose(p, q, sc);
    inst.setMatrixAt(i, m4);
    col.setHSL(0.03 + rnd() * 0.05, 0.35 + rnd() * 0.2, 0.35 + rnd() * 0.25);
    inst.setColorAt(i, col);
  }
  inst.castShadow = inst.receiveShadow = true;
  inst.computeBoundingSphere();
  root.add(inst);
}

const devRender: SceneEntry = async (engine, params) => {
  const ext = asEngineExt(engine);
  const { scene, renderer } = engine;
  const root = new THREE.Group();
  root.name = 'dev-render';
  scene.add(root);

  const city = params.get('city') === '1';
  if (city) await loadCity(engine, root);
  else buildTestScene(engine, root, params);

  // --- camera --------------------------------------------------------------------------------------
  const view = VIEWS[params.get('view') ?? (city ? 'waag' : 'street')] ?? VIEWS.street;
  setupDevCamera(engine, params, { cam: new THREE.Vector3(...view.cam), look: new THREE.Vector3(...view.look) });

  window.__debug = window.__debug ?? {};
  window.__debug.setQuality = (level: string) => ext.setQuality({ level: level as never });
  window.__debug.setView = (name: string) => {
    const v = VIEWS[name];
    if (v) (window.__debug!.setCam as (...a: number[]) => void)(...v.cam, ...v.look);
  };
  /**
   * Synchronous benchmark: renders `frames` frames back-to-back, forcing a GPU sync after each
   * (readPixels), so the result is the real CPU+GPU frame time independent of vsync/rAF.
   */
  window.__debug.bench = (frames = 40) => {
    const gl = renderer.getContext();
    const px = new Uint8Array(4);
    engine.stop();
    for (let i = 0; i < 10; i++) engine.renderOnce();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // several batches; the iGPU clocks up/down, so report the median batch
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        engine.renderOnce();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      batches.push((performance.now() - t0) / frames);
    }
    batches.sort((a, b) => a - b);
    const ms = batches[2];
    engine.start();
    return {
      level: ext.quality.level,
      ms: Number(ms.toFixed(2)),
      minMs: Number(batches[0].toFixed(2)),
      fps: Number((1000 / ms).toFixed(1)),
      drawCalls: engine.stats.drawCalls,
      triangles: engine.stats.triangles,
      size: [renderer.domElement.width, renderer.domElement.height],
    };
  };
  /** GPU time per frame (ms, median) via EXT_disjoint_timer_query_webgl2, null if unsupported. */
  window.__debug.gpuTime = async (frames = 30) => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!timer) return null;
    engine.stop();
    for (let i = 0; i < 5; i++) engine.renderOnce();
    const queries: WebGLQuery[] = [];
    for (let i = 0; i < frames; i++) {
      const q = gl.createQuery()!;
      gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
      engine.renderOnce();
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queries.push(q);
      await new Promise((r) => setTimeout(r, 0));
    }
    const times: number[] = [];
    for (const q of queries) {
      for (let tries = 0; tries < 200 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); tries++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) times.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(q);
    }
    engine.start();
    times.sort((a, b) => a - b);
    return {
      level: ext.quality.level,
      gpuMs: Number((times[Math.floor(times.length / 2)] ?? NaN).toFixed(2)),
      gpuMinMs: Number((times[0] ?? NaN).toFixed(2)),
      samples: times.length,
      drawCalls: engine.stats.drawCalls,
      triangles: engine.stats.triangles,
    };
  };
  window.__debug.info = () => ({
    gpu: ext.gpu,
    quality: { ...ext.quality },
    reversedDepth: ext.reversedDepth,
    exposure: ext.exposure,
    sunDir: engine.env.sunDirection.toArray(),
    sunIntensity: engine.env.sun.intensity,
    fogDensity: ext.env.fog.density,
    visibility: ext.env.visibility,
    postfx: ext.postfx.active,
    stats: { ...engine.stats },
  });

  engine.start();
  await engine.env.ready;
  // let a few frames render (shader compilation) before the screenshot tool captures
  await new Promise((r) => setTimeout(r, 300));
  window.__ready = true;
};

export default devRender;
