// Dev scene for the OSM pipeline outputs (tools/osm). ?scene=dev-osm
//   ?graph=1        draw roadgraph edges (car red, bike orange, foot white)
//   ?props=1        draw prop markers (trees green, lamps yellow, bikes cyan, cars blue, signs magenta, ...)
//   ?spawns=1       draw spawn points (arrows) and landmarks (white pillars)
//   ?near=x,z,r     only load ground chunks within r metres of (x, z) (faster)
//   ?backdrop=0     skip the backdrop ring;  ?water=0 skip the water surface
//   ?cam=x,y,z&look=x,y,z  camera (see src/dev/devCamera.ts)
// Materials are flat debug colours per MaterialClass (the real PBR library is substituted in-game).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SceneEntry, OsmMeta, RoadGraph, PropsData } from '../contracts';
import { DATA_URL, WATER_LEVEL } from '../config';
import { setupDevCamera } from '../dev/devCamera';

/** Cache buster: the pipeline rewrites files in place, never show stale data. */
const BUST = `?v=${Date.now()}`;
/** ?data=<url>: load the pipeline output from another directory (e.g. a --out test build under
 *  data-raw, served by Vite via /@fs/...). */
let dataUrl = DATA_URL;

const DEBUG_COLORS: Record<string, number> = {
  asphalt: 0x3a3b3e, klinkers: 0x8f4a36, sidewalk: 0xa3a39e, square: 0x9c8670, curb: 0xd2d2cc, bikelane: 0xa83a2e,
  grass: 0x5d8a3c, water: 0x2f5566, quay: 0x7a4a36, quay_cap: 0xc4c2bb, bridge_deck: 0x6a625a, bridge_side: 0x86513c,
  bridge_rail: 0x1d2a24, road_marking: 0xf2f2f2, parking: 0x55565a, canal_bed: 0x2b2620, ground: 0x7d7058,
};

function debugMaterial(name: string): THREE.Material {
  const color = DEBUG_COLORS[name] ?? 0xff00ff;
  if (name === 'water') {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.82 });
  }
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
  m.name = name;
  if (name === 'road_marking') {
    m.polygonOffset = true;
    m.polygonOffsetFactor = -2;
    m.polygonOffsetUnits = -2;
  }
  return m;
}

async function fetchJson<T>(file: string): Promise<T | null> {
  try {
    const r = await fetch(dataUrl + file + BUST, { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function drawGraph(scene: THREE.Scene, g: RoadGraph): void {
  const groups: Record<string, number[]> = { car: [], bike: [], foot: [] };
  for (const e of g.edges) {
    const key = e.car ? 'car' : e.bike ? 'bike' : 'foot';
    const y = key === 'car' ? 0.45 : key === 'bike' ? 0.4 : 0.35;
    for (let i = 1; i < e.pts.length; i++) {
      groups[key].push(e.pts[i - 1][0], y, e.pts[i - 1][1], e.pts[i][0], y, e.pts[i][1]);
    }
    if (e.oneway && key === 'car' && e.pts.length >= 2) {
      // small arrow head at the midpoint of the edge
      const k = Math.floor((e.pts.length - 1) / 2);
      const a = e.pts[k], b = e.pts[k + 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const ux = dx / l, uz = dz / l;
      groups.car.push(mx, y, mz, mx - ux * 2 + uz * 1.2, y, mz - uz * 2 - ux * 1.2);
      groups.car.push(mx, y, mz, mx - ux * 2 - uz * 1.2, y, mz - uz * 2 + ux * 1.2);
    }
  }
  const colors: Record<string, number> = { car: 0xff2020, bike: 0xff9a1a, foot: 0xffffff };
  for (const [k, arr] of Object.entries(groups)) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: colors[k], depthTest: true })));
  }
  const nodeGeo = new THREE.BufferGeometry();
  nodeGeo.setAttribute('position', new THREE.Float32BufferAttribute(g.nodes.flatMap((n) => [n[0], 0.5, n[1]]), 3));
  scene.add(new THREE.Points(nodeGeo, new THREE.PointsMaterial({ color: 0xffff00, size: 3, sizeAttenuation: false })));
}

/** Instanced cylinder markers; oriented items (3rd value = rotY) get a nose pointing along local +z. */
function markers(scene: THREE.Scene, pts: [number, number, number?][], color: number, h: number, r: number): void {
  if (!pts.length) return;
  let geo: THREE.BufferGeometry = new THREE.CylinderGeometry(r, r, h, 6).translate(0, h / 2, 0);
  if (pts[0][2] !== undefined) {
    const len = Math.max(0.6, r * 2.5);
    const nose = new THREE.BoxGeometry(Math.max(0.06, r * 0.5), Math.max(0.06, r * 0.5), len).translate(0, h * 0.85, len / 2);
    geo = mergeGeometries([geo, nose]) ?? geo;
  }
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.25 });
  const mesh = new THREE.InstancedMesh(geo, mat, pts.length);
  const m = new THREE.Matrix4();
  pts.forEach((p, i) => {
    m.makeRotationY(p[2] ?? 0).setPosition(p[0], 0.12, p[1]);
    mesh.setMatrixAt(i, m);
  });
  scene.add(mesh);
}

function drawProps(scene: THREE.Scene, p: PropsData): void {
  markers(scene, p.trees.map((t) => [t[0], t[1]]), 0x2f9a2f, 6, 0.6);
  markers(scene, p.lamps.map((t) => [t[0], t[1]]), 0xffd040, 4.5, 0.15);
  markers(scene, p.benches.map((t) => [t[0], t[1], t[2]]), 0x8a5a2a, 0.5, 0.5);
  markers(scene, p.bollards.map((t) => [t[0], t[1]]), 0x5a2a20, 0.9, 0.08);
  markers(scene, p.parkedBikes.map((t) => [t[0], t[1], t[2]]), 0x20d0e0, 1.0, 0.25);
  markers(scene, p.parkedCars.map((t) => [t[0], t[1], t[2]]), 0x2040ff, 1.4, 0.9);
  markers(scene, p.signs.map((t) => [t[0], t[1], t[2]]), 0xff30ff, 2.6, 0.12);
  markers(scene, p.streetNameSigns.map((t) => [t[0], t[1], t[2]]), 0x3060ff, 2.8, 0.12);
  markers(scene, p.trafficLights.map((t) => [t[0], t[1], t[2]]), 0x20ff20, 3.2, 0.14);
  markers(scene, p.bins.map((t) => [t[0], t[1], t[2]]), 0x404040, 0.9, 0.3);
}

function drawSpawns(scene: THREE.Scene, meta: OsmMeta): void {
  for (const s of meta.spawnPoints) {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading)), new THREE.Vector3(s.x, 1.0, s.z), 8, 0x00ffff, 3, 2,
    );
    scene.add(arrow);
  }
  for (const l of meta.landmarks) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 40, 8).translate(0, 20, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    m.position.set(l.x, 0, l.z);
    scene.add(m);
    if (l.footprint) {
      const pts = l.footprint.map((p) => new THREE.Vector3(p[0], 0.6, p[1]));
      pts.push(pts[0].clone());
      scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff })));
    }
  }
}

const devOsm: SceneEntry = async (engine, params) => {
  // Default: a plain debug render loop with its own scene + simple lights, independent of the
  // engine's post-processing (flat debug colours are what we want to judge here).
  // ?engine=1 renders through the full engine pipeline instead.
  const useEngine = params.get('engine') === '1';
  dataUrl = params.get('data') ?? DATA_URL;
  const scene = useEngine ? engine.scene : new THREE.Scene();
  if (!useEngine) {
    scene.background = new THREE.Color(0xa9c3dc);
    scene.add(new THREE.HemisphereLight(0xdde8f5, 0x50483c, 1.6));
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.2);
    sun.position.set(-300, 500, 250);
    scene.add(sun);
    scene.fog = new THREE.Fog(0xa9c3dc, 900, 4000);
  }
  const meta = await fetchJson<OsmMeta>('osm-meta.json');
  if (!meta) {
    console.error('[dev-osm] public/data/osm-meta.json missing - run node tools/osm/build.mjs');
    window.__ready = true;
    return;
  }
  // reference plane below the canal bed (makes holes in the ground obvious)
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
  plane.position.y = -6;
  if (params.get('plane') !== '0') scene.add(plane);

  const near = params.get('near')?.split(',').map(Number);
  // ?hide=bridge_deck,quay  hides those material classes (debugging)
  const hidden = new Set((params.get('hide') ?? '').split(',').filter(Boolean));
  const loader = new GLTFLoader();
  const mats = new Map<string, THREE.Material>();
  const matFor = (name: string): THREE.Material => {
    let m = mats.get(name);
    if (!m) { m = debugMaterial(name); mats.set(name, m); }
    return m;
  };
  const files = meta.groundFiles.filter((f) => {
    if (f === 'ground_backdrop.glb') return params.get('backdrop') !== '0';
    if (f === 'ground_water.glb') return params.get('water') !== '0';
    if (!near) return true;
    const m = /ground_(\d+)_(\d+)\.glb/.exec(f);
    if (!m) return true;
    const cx = Number(m[1]) * 200 - 2000 + 100, cz = Number(m[2]) * 200 - 2000 + 100;
    return Math.hypot(cx - near[0], cz - near[1]) < near[2] + 142;
  });
  let tris = 0;
  await Promise.all(files.map(async (f) => {
    const gltf = await loader.loadAsync(dataUrl + f + BUST);
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const name = (mesh.material as THREE.Material).name;
      mesh.material = matFor(name);
      if (hidden.has(name)) mesh.visible = false;
      mesh.receiveShadow = true;
      mesh.castShadow = name === 'bridge_side' || name === 'bridge_rail' || name === 'quay_cap';
      tris += (mesh.geometry.index?.count ?? 0) / 3;
    });
    scene.add(gltf.scene);
  }));
  console.info(`[dev-osm] loaded ${files.length} files, ${tris} triangles, water level ${WATER_LEVEL}`);

  // ?bag=1: also show the BAG building chunks (flat colours) for context
  if (params.get('bag') === '1') {
    type BagMetaLite = { buildingFiles: { file: string; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } }[] };
    const bag = await fetchJson<BagMetaLite>('bag-meta.json');
    const wall = new THREE.MeshStandardMaterial({ color: 0xc9b9a6, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: 0x8a5040, roughness: 0.9 });
    const bfiles = (bag?.buildingFiles ?? []).filter((b) => {
      if (!near) return true;
      const cx = (b.bounds.minX + b.bounds.maxX) / 2, cz = (b.bounds.minZ + b.bounds.maxZ) / 2;
      return Math.hypot(cx - near[0], cz - near[1]) < near[2] + 160;
    });
    await Promise.all(bfiles.map(async (b) => {
      try {
        const g = await loader.loadAsync(DATA_URL + b.file);
        g.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const n = (mesh.material as THREE.Material).name;
          mesh.material = n === 'wall' ? wall : roof;
        });
        scene.add(g.scene);
      } catch (e) {
        console.warn('[dev-osm] bag file failed', b.file, e);
      }
    }));
  }

  if (params.get('graph') === '1') {
    const g = await fetchJson<RoadGraph>('roadgraph.json');
    if (g) drawGraph(scene, g);
  }
  if (params.get('props') === '1') {
    const p = await fetchJson<PropsData>('props.json');
    if (p) drawProps(scene, p);
  }
  if (params.get('spawns') === '1') drawSpawns(scene, meta);
  // ?grid=x0,z0,x1,z1,step  coordinate grid lines (every 5th line brighter) for locating problems
  const gridSpec = params.get('grid')?.split(',').map(Number);
  if (gridSpec && gridSpec.length === 5) {
    const [gx0, gz0, gx1, gz1, step] = gridSpec;
    const minor: number[] = [], major: number[] = [];
    for (let x = Math.ceil(gx0 / step) * step; x <= gx1; x += step) (Math.round(x / step) % 5 === 0 ? major : minor).push(x, 1.0, gz0, x, 1.0, gz1);
    for (let z = Math.ceil(gz0 / step) * step; z <= gz1; z += step) (Math.round(z / step) % 5 === 0 ? major : minor).push(gx0, 1.0, z, gx1, 1.0, z);
    for (const [arr, color] of [[minor, 0x00ffff], [major, 0xffff00]] as [number[], number][]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.6 })));
    }
  }

  setupDevCamera(engine, params, { cam: new THREE.Vector3(150, 220, 260), look: new THREE.Vector3(0, 0, 0) });
  window.__debug = window.__debug ?? {};
  window.__debug.meta = meta;
  // __debug.pick(px, py): what is under that screen pixel (logs material + world point)
  const raycaster = new THREE.Raycaster();
  window.__debug.pick = (px: number, py: number): string => {
    const w = engine.canvas.clientWidth || window.innerWidth, h = engine.canvas.clientHeight || window.innerHeight;
    raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), engine.camera);
    const hits = raycaster.intersectObjects(scene.children, true).filter((i) => (i.object as THREE.Mesh).isMesh && i.object.visible);
    const s = hits.slice(0, 3).map((i) => `${((i.object as THREE.Mesh).material as THREE.Material).name || 'mesh'}@${i.point.x.toFixed(2)},${i.point.y.toFixed(2)},${i.point.z.toFixed(2)}`).join(' ; ');
    console.info(`[pick ${px},${py}] ${s || 'nothing'}`);
    return s;
  };
  if (useEngine) {
    engine.start();
    await engine.env.ready;
  } else {
    const cam = engine.camera;
    const renderer = engine.renderer;
    const loop = (): void => {
      requestAnimationFrame(loop);
      const w = engine.canvas.clientWidth || window.innerWidth, h = engine.canvas.clientHeight || window.innerHeight;
      if (Math.abs(cam.aspect - w / h) > 1e-3) { cam.aspect = w / h; cam.updateProjectionMatrix(); }
      renderer.setRenderTarget(null);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.render(scene, cam);
    };
    loop();
  }
  // give the GPU a few frames to upload everything
  await new Promise((r) => setTimeout(r, 300));
  window.__ready = true;
};

export default devOsm;
