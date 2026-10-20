// Dev scene for the props & landmarks module.
//   ?scene=dev-props&view=lineup   all props on a test street next to a small canal (default)
//   ?view=molen                     Molen van Piet on a grass bastion
//   ?view=kaas                      Kaasmarkt (cheese market) next to a placeholder Waag
//   ?view=data                      props.json + osm-meta.json landmarks on a simple ground
// Extra params: &night=1 (lamps on), &cam=x,y,z&look=x,y,z (dev camera), &nowind=1, &mats=0
import * as THREE from 'three';
import type { Engine, Footprints, Landmark, MaterialLibrary, Map2D, OsmMeta, PhysicsWorld, PropsData, RoadGraph, SceneEntry } from '../contracts';
import { DATA_URL, WATER_LEVEL } from '../config';
import { setupDevCamera } from '../dev/devCamera';
import { createProps } from '../world/props';
import { createLandmarks } from '../world/landmarks';
import type { StaticColliderSink } from '../world/props/types';
import { createNullPhysics } from '../world/props/util/physicsStub';
import { getGrungeTexture } from '../world/props/util/textures';
import { propUniforms } from '../world/props/util/propMaterial';
import { synthesizeProps } from '../world/props/dev/synthProps';
import { compileTimings } from '../world/props/dev/compileTest';

const materialModules = import.meta.glob<{ createMaterialLibrary: (e: Engine) => Promise<MaterialLibrary> }>('../world/materials/index.ts');
const physicsModules = import.meta.glob<{ createPhysics: () => Promise<PhysicsWorld> }>('../physics/physics.ts');

async function loadMaterials(engine: Engine): Promise<MaterialLibrary | null> {
  const loader = materialModules['../world/materials/index.ts'];
  if (!loader) return null;
  try {
    const mod = await loader();
    return await mod.createMaterialLibrary(engine);
  } catch (e) {
    console.warn('[dev-props] MaterialLibrary niet beschikbaar:', e);
    return null;
  }
}

async function loadPhysics(): Promise<PhysicsWorld | StaticColliderSink> {
  const loader = physicsModules['../physics/physics.ts'];
  if (loader) {
    try {
      const mod = await loader();
      return await mod.createPhysics();
    } catch (e) {
      console.warn('[dev-props] physics niet beschikbaar, stub gebruikt:', e);
    }
  }
  return createNullPhysics();
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function groundMaterial(materials: MaterialLibrary | null, cls: 'klinkers' | 'grass' | 'square' | 'quay' | 'canal_bed', fallback: number): THREE.Material {
  if (materials) {
    try {
      return materials.get(cls);
    } catch { /* fall through */ }
  }
  const tex = getGrungeTexture().clone();
  tex.repeat.set(1 / 3, 1 / 3);
  tex.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: fallback, roughness: 0.92, map: tex });
}

/** Horizontal ground mesh with metric UVs from a THREE.Shape (x, -z plane => y = h). */
function flatShape(shape: THREE.Shape, y: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.ShapeGeometry(shape, 4);
  g.rotateX(-Math.PI / 2); // shape (x, y) -> world (x, -y) ... flip below
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, y);
    uv.setXY(i, pos.getX(i), pos.getZ(i));
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

function waterMesh(materials: MaterialLibrary | null, geo: THREE.BufferGeometry): THREE.Mesh {
  if (materials) {
    try {
      return materials.createWater(geo);
    } catch { /* fall through */ }
  }
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2c3a33, roughness: 0.08, metalness: 0.2 }));
}

// ---------------------------------------------------------------------------------------------
// lineup
// ---------------------------------------------------------------------------------------------

const CANAL = { z0: 9, z1: 21, x0: -70, x1: 90 };

function lineupData(): { props: PropsData; map2d: Map2D } {
  const p: PropsData = {
    trees: [], lamps: [], benches: [], bollards: [], parkedBikes: [], parkedCars: [], signs: [],
    streetNameSigns: [], trafficLights: [], bins: [],
  };
  // canal-side tree row: lindens, then ornamental and conifer
  const treeRow: [number, number, number][] = [
    [-36, 15, 0], [-25, 14, 0], [-14, 16, 0], [-3, 13, 0], [8, 6, 1], [15, 7, 1], [22, 6.5, 1], [30, 11, 2], [37, 9, 2], [46, 18, 0], [57, 12, 0],
  ];
  for (const [x, h, k] of treeRow) p.trees.push([x, 7.2, h, k]);
  // a second row far away to see LOD1 / impostors
  for (let i = 0; i < 30; i++) p.trees.push([-200 + i * 14, 60 + (i % 3) * 4, 12 + (i % 5), i % 7 === 0 ? 1 : 0]);
  for (let i = 0; i < 40; i++) p.trees.push([-300 + i * 16, -280 + (i % 4) * 6, 13 + (i % 4), 0]);
  // lamps: historic lanterns along the quay, modern lights further on
  for (let x = -32; x <= 20; x += 13) p.lamps.push([x, 5.0, Math.PI, 0]);
  p.lamps.push([34, 4.6, Math.PI, 1], [50, 4.6, Math.PI, 1]);
  // bollards along the kerb
  for (let x = -30; x <= -12; x += 1.6) p.bollards.push([x, 2.2]);
  // parked bikes along the canal railing, front wheel towards the water
  for (let i = 0; i < 26; i++) p.parkedBikes.push([-11 + i * 0.68, 7.4, 0]);
  for (let i = 0; i < 6; i++) p.parkedBikes.push([24 + i * 0.7, -2.5, Math.PI]);
  // benches, bins
  p.benches.push([-5, 5.6, 0], [3.5, 5.6, 0]);
  p.bins.push([-1, 5.6, 0], [7.5, 5.6, 0], [20, -2.6, 0]);
  // signs
  const codes = ['C2', 'C1', 'B6', 'A1-30', 'A1-50', 'B1', 'D7', 'E1', 'E4', 'G7', 'G11', 'C6', 'C12', 'J37', 'L2', 'F5', 'B7', 'G5', 'D2', 'X99'];
  codes.forEach((c, i) => p.signs.push([-28 + i * 2.6, -1.0, 0, c]));
  p.streetNameSigns.push([-20, -4.0, 0, 'Verdronkenoord'], [-14, -4.0, 0, 'Luttik Oudorp'], [-8.5, -4.0, 0, 'Mient'], [-3, -4.0, 0, 'Lange Halstraat']);
  p.trafficLights.push([30, -1.0, 0], [34, -1.0, Math.PI / 2]);
  const map2d: Map2D = {
    water: [[[[CANAL.x0, CANAL.z0], [CANAL.x1, CANAL.z0], [CANAL.x1, CANAL.z1], [CANAL.x0, CANAL.z1], [CANAL.x0, CANAL.z0]]]],
    parks: [],
    bounds: { minX: -400, minZ: -400, maxX: 400, maxZ: 400 },
  };
  return { props: p, map2d };
}

function buildLineupGround(engine: Engine, materials: MaterialLibrary | null): void {
  const pave = groundMaterial(materials, 'klinkers', 0x8a6a58);
  const S = 600;
  const north = new THREE.Shape([new THREE.Vector2(-S, S), new THREE.Vector2(S, S), new THREE.Vector2(S, -CANAL.z0), new THREE.Vector2(-S, -CANAL.z0)]);
  // shape y = -z (we map world z = -shape.y)
  const mkRect = (x0: number, z0: number, x1: number, z1: number) =>
    new THREE.Shape([new THREE.Vector2(x0, -z0), new THREE.Vector2(x1, -z0), new THREE.Vector2(x1, -z1), new THREE.Vector2(x0, -z1)]);
  void north;
  engine.scene.add(flatShape(mkRect(-S, -S, S, CANAL.z0), 0, pave));
  engine.scene.add(flatShape(mkRect(-S, CANAL.z1, S, S), 0, pave));
  engine.scene.add(flatShape(mkRect(-S, CANAL.z0, CANAL.x0, CANAL.z1), 0, pave));
  engine.scene.add(flatShape(mkRect(CANAL.x1, CANAL.z0, S, CANAL.z1), 0, pave));
  // quay walls
  const quay = groundMaterial(materials, 'quay', 0x7a4a3a);
  for (const z of [CANAL.z0, CANAL.z1]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(CANAL.x1 - CANAL.x0, 3.5), quay);
    w.position.set((CANAL.x0 + CANAL.x1) / 2, -1.75, z);
    w.rotation.y = z === CANAL.z0 ? 0 : Math.PI;
    w.receiveShadow = true;
    engine.scene.add(w);
  }
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(CANAL.x1 - CANAL.x0, CANAL.z1 - CANAL.z0).rotateX(-Math.PI / 2), groundMaterial(materials, 'canal_bed', 0x2b2a22));
  bed.position.set((CANAL.x0 + CANAL.x1) / 2, -3.5, (CANAL.z0 + CANAL.z1) / 2);
  engine.scene.add(bed);
  const wg = new THREE.PlaneGeometry(CANAL.x1 - CANAL.x0, CANAL.z1 - CANAL.z0).rotateX(-Math.PI / 2);
  wg.translate((CANAL.x0 + CANAL.x1) / 2, WATER_LEVEL, (CANAL.z0 + CANAL.z1) / 2);
  engine.scene.add(waterMesh(materials, wg));
  // simple canal railing (the real one comes from the ground pipeline)
  const rail = new THREE.Mesh(new THREE.BoxGeometry(CANAL.x1 - CANAL.x0, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0x1d2420, roughness: 0.5, metalness: 0.5 }));
  rail.position.set((CANAL.x0 + CANAL.x1) / 2, 0.95, CANAL.z0 - 0.15);
  rail.castShadow = true;
  engine.scene.add(rail);
  for (let x = CANAL.x0; x <= CANAL.x1; x += 2.5) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.95, 0.05), rail.material);
    post.position.set(x, 0.475, CANAL.z0 - 0.15);
    engine.scene.add(post);
  }
}

// ---------------------------------------------------------------------------------------------
// data view ground: plane with water holes from map2d
// ---------------------------------------------------------------------------------------------

function buildDataGround(engine: Engine, materials: MaterialLibrary | null, map2d: Map2D | null, rect: { minX: number; minZ: number; maxX: number; maxZ: number }): void {
  const pave = groundMaterial(materials, 'square', 0x8a7f74);
  const pad = 300;
  const outer = new THREE.Shape([
    new THREE.Vector2(rect.minX - pad, -(rect.minZ - pad)), new THREE.Vector2(rect.maxX + pad, -(rect.minZ - pad)),
    new THREE.Vector2(rect.maxX + pad, -(rect.maxZ + pad)), new THREE.Vector2(rect.minX - pad, -(rect.maxZ + pad)),
  ]);
  const waterShapes: THREE.Shape[] = [];
  for (const poly of map2d?.water ?? []) {
    const ring = poly[0];
    if (!ring || ring.length < 3) continue;
    const pts = ring.map(([x, z]) => new THREE.Vector2(x, -z));
    outer.holes.push(new THREE.Path(pts));
    const ws = new THREE.Shape(pts);
    for (const hole of poly.slice(1)) ws.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
    waterShapes.push(ws);
  }
  engine.scene.add(flatShape(outer, 0, pave));
  if (waterShapes.length) {
    const g = new THREE.ShapeGeometry(waterShapes, 2);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, WATER_LEVEL);
      uv.setXY(i, pos.getX(i), pos.getZ(i));
    }
    g.computeVertexNormals();
    engine.scene.add(waterMesh(materials, g));
  }
}

/** Simple 9 m extruded blocks from the BAG footprints (only for judging placement in ?view=data). */
function buildFootprintBlocks(engine: Engine, fp: Footprints | null): void {
  if (!fp) return;
  const shapes: THREE.Shape[] = [];
  for (const ring of fp.rings) {
    if (ring.length < 4) continue;
    const [x0, z0] = ring[0];
    if (Math.hypot(x0, z0) > 450 && Math.hypot(x0 + 565, z0 - 146) > 250) continue;
    shapes.push(new THREE.Shape(ring.map(([x, z]) => new THREE.Vector2(x, z))));
  }
  if (!shapes.length) return;
  const g = new THREE.ExtrudeGeometry(shapes, { depth: 9, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // shape (x, z) in XY, extruded +z -> rotate so it extrudes towards -y
  g.translate(0, 9, 0);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x9a8f86, roughness: 0.9, side: THREE.DoubleSide }));
  m.castShadow = m.receiveShadow = true;
  engine.scene.add(m);
}

// ---------------------------------------------------------------------------------------------

const devProps: SceneEntry = async (engine, params) => {
  const view = params.get('view') ?? 'lineup';
  // &mats=0 skips the (optional) MaterialLibrary, e.g. while that module is being worked on
  const [materials, physics] = await Promise.all([params.get('mats') === '0' ? Promise.resolve(null) : loadMaterials(engine), loadPhysics()]);
  if (params.get('nowind') === '1') propUniforms.uWindStrength.value = 0;
  window.__debug = window.__debug ?? {};

  let camDefault = { cam: new THREE.Vector3(-14, 2.2, -3), look: new THREE.Vector3(-4, 1.2, 7) };
  const systems: { update(dt: number, camPos: THREE.Vector3): void }[] = [];

  if (view === 'lineup') {
    buildLineupGround(engine, materials);
    const { props, map2d } = lineupData();
    const ps = createProps(engine, physics, materials, props, { map2d, roadGraph: null, boatRect: null });
    engine.scene.add(ps.root);
    systems.push(ps);
    window.__debug.props = ps;
    await ps.ready;
  } else if (view === 'molen' || view === 'kaas') {
    const isMolen = view === 'molen';
    const ground = groundMaterial(materials, isMolen ? 'grass' : 'square', isMolen ? 0x55703a : 0x8a7f74);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2), ground);
    const uv = g.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 800, uv.getY(i) * 800);
    g.receiveShadow = true;
    engine.scene.add(g);
    const landmarks: Landmark[] = isMolen
      ? [{ id: 'molen_van_piet', name: 'Molen van Piet', x: 0, z: 0 }, { id: 'waag', name: 'De Waag', x: 2000, z: 2000 }]
      : [{ id: 'waag', name: 'De Waag', x: 0, z: 0, footprint: [[-9, -6], [9, -6], [9, 6], [-9, 6]] }, { id: 'molen_van_piet', name: 'Molen van Piet', x: -2000, z: -2000 }];
    if (!isMolen) {
      // placeholder Waag block so the market placement can be judged
      const waag = new THREE.Mesh(new THREE.BoxGeometry(18, 14, 12), new THREE.MeshStandardMaterial({ color: 0x8a5040, roughness: 0.9 }));
      waag.position.y = 7;
      waag.castShadow = waag.receiveShadow = true;
      engine.scene.add(waag);
    }
    const meta: OsmMeta = { playable: { minX: -400, minZ: -400, maxX: 400, maxZ: 400 }, spawnPoints: [], groundFiles: [], landmarks, attribution: '' };
    const lm = createLandmarks(engine, physics, materials, meta, {
      footprints: isMolen ? { rings: [] } : { rings: [[[-9, -6], [9, -6], [9, 6], [-9, 6], [-9, -6]]] },
      map2d: null,
      roadGraph: null,
      heroes: false,
    });
    engine.scene.add(lm.root);
    systems.push(lm);
    window.__debug.landmarks = lm;
    await lm.ready;
    const site = lm.kaasmarktSite();
    window.__debug.site = site;
    if (isMolen) camDefault = { cam: new THREE.Vector3(-34, 6, 30), look: new THREE.Vector3(0, 13, 0) };
    else if (site) {
      // look at the market across its width, from the side away from the Waag
      const vx = -Math.sin(site.rot), vz = Math.cos(site.rot);
      const s = Math.sign(vx * site.x + vz * site.z) || 1;
      camDefault = {
        cam: new THREE.Vector3(site.x + vx * s * 16, 4.5, site.z + vz * s * 16),
        look: new THREE.Vector3(site.x, 0.2, site.z),
      };
    }
  } else if (view === 'hero') {
    // hand-made hero buildings (De Waag, Accijnstoren) at their real positions on a flat square
    const ground = groundMaterial(materials, 'square', 0x8a7f74);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2), ground);
    const uv = g.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1400, uv.getY(i) * 1400);
    g.receiveShadow = true;
    engine.scene.add(g);
    const meta = await fetchJson<OsmMeta>(`${DATA_URL}osm-meta.json`);
    const t0 = performance.now();
    const lm = createLandmarks(engine, physics, materials, meta ?? { playable: { minX: -900, minZ: -800, maxX: 700, maxZ: 900 }, spawnPoints: [], groundFiles: [], landmarks: [], attribution: '' }, {
      footprints: { rings: [] },
      map2d: null,
      roadGraph: null,
    });
    console.info(`[dev-props] createLandmarks: ${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(lm.stats()));
    engine.scene.add(lm.root);
    systems.push(lm);
    window.__debug.landmarks = lm;
    await lm.ready;
    camDefault = params.get('hero') === 'accijns'
      ? { cam: new THREE.Vector3(301.5, 5, 350.8), look: new THREE.Vector3(314.4, 7.5, 329.4) }
      : { cam: new THREE.Vector3(27.7, 9, -41.6), look: new THREE.Vector3(-1, 16, 0) };
  } else {
    const [props, meta, map2d, graph] = await Promise.all([
      fetchJson<PropsData>(`${DATA_URL}props.json`),
      fetchJson<OsmMeta>(`${DATA_URL}osm-meta.json`),
      fetchJson<Map2D>(`${DATA_URL}map2d.json`),
      fetchJson<RoadGraph>(`${DATA_URL}roadgraph.json`),
    ]);
    const rect = meta?.playable ?? { minX: -900, minZ: -800, maxX: 700, maxZ: 900 };
    buildDataGround(engine, materials, map2d, rect);
    const footprints = await fetchJson<Footprints>(`${DATA_URL}footprints.json`);
    buildFootprintBlocks(engine, footprints);
    let props2 = props;
    const empty = !props || Object.values(props).every((a) => !Array.isArray(a) || a.length === 0);
    if ((params.get('synth') === '1' || empty) && graph) {
      // DEV: city-scale synthetic placements while the pipeline's props.json is empty
      const t0 = performance.now();
      props2 = synthesizeProps(graph, map2d, footprints, rect);
      console.info(`[dev-props] synthetische props (${(performance.now() - t0).toFixed(0)} ms):`, Object.fromEntries(Object.entries(props2).map(([k, v]) => [k, v.length])));
    }
    const props3 = props2;
    if (props3) {
      const t1 = performance.now();
      const ps = createProps(engine, physics, materials, props3, { map2d, roadGraph: graph, boatRect: meta?.playable ?? null });
      console.info(`[dev-props] createProps: ${(performance.now() - t1).toFixed(0)} ms`);
      engine.scene.add(ps.root);
      systems.push(ps);
      window.__debug.props = ps;
      await ps.ready;
    } else console.warn('[dev-props] public/data/props.json ontbreekt');
    if (meta) {
      const lm = createLandmarks(engine, physics, materials, meta);
      engine.scene.add(lm.root);
      systems.push(lm);
      window.__debug.landmarks = lm;
      await lm.ready;
      window.__debug.site = lm.kaasmarktSite();
    }
    camDefault = { cam: new THREE.Vector3(-60, 40, 80), look: new THREE.Vector3(0, 0, 0) };
  }

  if (params.get('night') === '1') propUniforms.uLampOn.value = 1;
  window.__debug.setLights = (v: number) => (propUniforms.uLampOn.value = v);

  setupDevCamera(engine, params, camDefault);
  // &compiletest=1: time the cold shader compile of every props / landmarks program (ANGLE hang hunt)
  const compileRoots = (): THREE.Object3D[] => {
    const d = window.__debug ?? {};
    const roots: THREE.Object3D[] = [];
    for (const k of ['props', 'landmarks']) {
      const r = (d[k] as { root?: THREE.Object3D } | undefined)?.root;
      if (r) roots.push(r);
    }
    return roots;
  };
  window.__debug.compileTest = (bust = true) => compileTimings(engine, compileRoots(), bust);
  if (params.get('compiletest') === '1') {
    for (const r of compileRoots()) {
      const t = performance.now();
      const res = await compileTimings(engine, [r], params.get('bust') !== '0', params.get('verbose') === '1');
      const slow = res.items.filter((x) => x.ms > 300).sort((a, b) => b.ms - a.ms).slice(0, 12);
      console.info(`[compiletest] ${r.name}: ${res.items.length} programma's in ${(performance.now() - t).toFixed(0)} ms; traag: ${slow.map((x) => `${x.name} ${x.ms.toFixed(0)}`).join(', ') || 'geen'}`);
    }
  }
  engine.onUpdate((dt) => {
    for (const s of systems) s.update(dt, engine.camera.position);
  }, 40);
  engine.start();
  // let culling run a few frames before declaring ready
  await new Promise((r) => setTimeout(r, 300));
  window.__ready = true;
};

export default devProps;
