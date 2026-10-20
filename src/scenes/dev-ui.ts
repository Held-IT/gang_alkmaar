// UI dev scene: ?scene=dev-ui&state=loading|menu|hud|pause|settings|rijden|controls|credits|spawn|map|sheet|confirm
//   hud extras: &speed=50 &fps=1 &lights=head,park,abs,tcs,esc &car=<id>
// Optional: &car=<specId> &speed=<km/u, fixed> &fraction=<0..1 loading> &bg=0 (no 3D backdrop)
// Shows the UI over a simple procedural canal-street backdrop with real data from public/data
// when available (falls back to generated fake data / fake car specs).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  CarSpec,
  Engine,
  Footprints,
  Map2D,
  OsmMeta,
  RoadEdge,
  RoadGraph,
  SceneEntry,
  SpawnPoint,
  VehicleTelemetry,
} from '../contracts';
import { DATA_URL } from '../config';
import { createUI, type GameUI, type HudInfo, type HudLights, type PauseHandlers } from '../ui';

type SpecsModule = { CAR_SPECS?: CarSpec[]; DEFAULT_CAR_ID?: string };
const specModules = import.meta.glob<SpecsModule>('../vehicle/specs.ts');

// ---------------------------------------------------------------------------------- fake data
const base: Omit<CarSpec, 'id' | 'name' | 'category' | 'description' | 'powerKw' | 'massKg' | 'topSpeedKmh' | 'paints'> = {
  length: 4.25, width: 1.79, height: 1.46, wheelbase: 2.62, trackFront: 1.54, trackRear: 1.52,
  wheelRadius: 0.32, wheelWidth: 0.22, cgHeight: 0.55, frontWeight: 0.6, drivetrain: 'fwd',
  torqueNm: 250, idleRpm: 800, redlineRpm: 6200, gearRatios: [3.6, 2.1, 1.4, 1.05, 0.83, 0.68],
  reverseRatio: 3.3, finalDrive: 3.9, maxSteerDeg: 35, suspensionTravel: 0.18,
};
const FAKE_CARS: CarSpec[] = [
  { ...base, id: 'fake_hatch', name: 'Veluna Kompakt 1.5', category: 'hatchback', description: 'Wendbare gezinshatchback met een zuinige turbomotor. Ideaal voor de smalle straatjes van de binnenstad.', powerKw: 110, massKg: 1290, topSpeedKmh: 210, paints: ['#8f1a1f', '#e8eaeb', '#1d2b45', '#7d858c', '#23262a'] },
  { ...base, id: 'fake_wagon', name: 'Strada Familia Kombi', category: 'stationwagen', length: 4.7, description: 'Ruime stationwagen met veel bagageruimte.', powerKw: 96, massKg: 1480, topSpeedKmh: 200, paints: ['#2c3640', '#c9ccce', '#5c6b5a'] },
  { ...base, id: 'fake_city', name: 'Mibo Citi', category: 'stadsauto', length: 3.6, description: 'Kleine stadsauto, past in elk parkeervak.', powerKw: 51, massKg: 940, topSpeedKmh: 165, paints: ['#e8c34a', '#b8d4d0', '#c22a2a'] },
  { ...base, id: 'fake_van', name: 'Hanze Transit L2', category: 'bestelbus', length: 5.1, height: 1.95, description: 'Bestelbus voor de bevoorrading van winkels.', powerKw: 100, massKg: 1950, topSpeedKmh: 165, paints: ['#f2f2f0', '#25476b'] },
  { ...base, id: 'fake_ev', name: 'Nordvik E-Sedan', category: 'sedan', length: 4.8, description: 'Stille elektrische sedan.', powerKw: 180, massKg: 1850, topSpeedKmh: 200, electric: true, drivetrain: 'rwd', paints: ['#1f3a68', '#0f1012', '#e6e7e8'] },
];

async function loadCars(forceFake: boolean): Promise<{ cars: CarSpec[]; def: string }> {
  const loader = forceFake ? undefined : Object.values(specModules)[0];
  if (loader) {
    try {
      const m = await loader();
      if (m.CAR_SPECS?.length) return { cars: m.CAR_SPECS, def: m.DEFAULT_CAR_ID ?? m.CAR_SPECS[0].id };
    } catch (e) {
      console.warn('[dev-ui] specs unavailable', e);
    }
  }
  return { cars: FAKE_CARS, def: FAKE_CARS[0].id };
}

async function fetchJson<T>(name: string): Promise<T | null> {
  try {
    const r = await fetch(DATA_URL + name);
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Fallback map: a Singel-like ring canal with a grid of streets and blocks. */
function fakeMap(): { map2d: Map2D; fp: Footprints; graph: RoadGraph; spawns: SpawnPoint[] } {
  const ring = (r: number, n = 48): [number, number][] =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (1 + 0.08 * Math.cos(a * 5));
      return [Math.cos(a) * rr * 1.2, Math.sin(a) * rr] as [number, number];
    });
  const water: [number, number][][][] = [[ring(520), ring(480).reverse()]];
  const nodes: [number, number][] = [];
  const edges: RoadEdge[] = [];
  const names = ['Langestraat', 'Laat', 'Mient', 'Voordam', 'Houttil', 'Koorstraat', 'Ritsevoort', 'Fnidsen', 'Oudegracht', 'Verdronkenoord'];
  const id = (x: number, z: number) => {
    nodes.push([x, z]);
    return nodes.length - 1;
  };
  for (let i = -3; i <= 3; i++) {
    const a = id(-420, i * 110);
    const b = id(420, i * 110);
    edges.push({ a, b, pts: [[-420, i * 110], [420, i * 110]], len: 840, type: i === 0 ? 'tertiary' : 'residential', name: names[i + 3], oneway: 0, lanes: 1, speed: 8.33, width: 6, car: true, bike: true, foot: true, bridge: false });
  }
  const rings: [number, number][][] = [];
  for (let x = -400; x < 400; x += 14) for (let z = -320; z < 320; z += 110) rings.push([[x, z + 8], [x + 12, z + 8], [x + 12, z + 40], [x, z + 40]]);
  return {
    map2d: { water, parks: [], bounds: { minX: -700, minZ: -600, maxX: 700, maxZ: 600 } },
    fp: { rings },
    graph: { nodes, edges },
    spawns: [
      { id: 'waag', name: 'De Waag', x: 0, z: 0, heading: 1.57 },
      { id: 'grote_kerk', name: 'Grote Kerk', x: -380, z: -110, heading: 1.57 },
      { id: 'molen', name: 'Molen van Piet', x: -300, z: 220, heading: 0 },
    ],
  };
}

// ---------------------------------------------------------------------------------- backdrop
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function facadeTex(brick: string, seed: number): THREE.CanvasTexture {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return canvasTex(256, 512, (g) => {
    g.fillStyle = brick;
    g.fillRect(0, 0, 256, 512);
    for (let y = 0; y < 512; y += 6) {
      for (let x = (y / 6) % 2 ? -8 : 0; x < 256; x += 16) {
        g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${0.04 + rnd() * 0.06})`;
        g.fillRect(x + 1, y + 1, 14, 4);
      }
    }
    const floors = 3;
    const cols = rnd() < 0.5 ? 2 : 3;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const ww = cols === 2 ? 70 : 52;
        const x = ((c + 0.5) * 256) / cols - ww / 2;
        const y = 40 + f * 120;
        g.fillStyle = '#f2efe8';
        g.fillRect(x - 5, y - 5, ww + 10, 96);
        const gr = g.createLinearGradient(0, y, 0, y + 86);
        gr.addColorStop(0, '#5d6f80');
        gr.addColorStop(1, '#141a20');
        g.fillStyle = gr;
        g.fillRect(x, y, ww, 86);
        g.fillStyle = '#f2efe8';
        g.fillRect(x + ww / 2 - 2, y, 4, 86);
        g.fillRect(x, y + 34, ww, 4);
      }
    }
    // ground floor: shop window + door
    g.fillStyle = '#1d2a25';
    g.fillRect(14, 412, 228, 100);
    g.fillStyle = '#3d4f5c';
    g.fillRect(22, 422, 150, 82);
    g.fillStyle = '#f2efe8';
    g.fillRect(186, 422, 44, 90);
    g.fillStyle = '#2a3a34';
    g.fillRect(191, 427, 34, 85);
  });
}

function buildBackdrop(engine: Engine): THREE.Vector3 {
  const scene = engine.scene;
  const sky = canvasTex(4, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#6f97c4');
    gr.addColorStop(0.55, '#a9c3dc');
    gr.addColorStop(0.8, '#dfe6ea');
    gr.addColorStop(1, '#8a8d8c');
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 256);
  });
  scene.background = sky;
  scene.fog = new THREE.Fog(0xc4d2de, 60, 380);
  // environment for reflections: the same gradient on a sphere
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.MeshBasicMaterial({ map: sky, side: THREE.BackSide })));
  const pmrem = new THREE.PMREMGenerator(engine.renderer);
  scene.environment = pmrem.fromScene(envScene).texture;
  scene.environmentIntensity = 0.6;

  const klinker = canvasTex(256, 256, (g) => {
    g.fillStyle = '#6b4537';
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 16) for (let x = 0; x < 256; x += 32) {
      g.fillStyle = `hsl(12, ${30 + ((x * 7 + y * 13) % 20)}%, ${28 + ((x * 3 + y * 5) % 12)}%)`;
      g.fillRect(x + ((y / 16) % 2) * 16 + 1, y + 1, 30, 14);
    }
  });
  klinker.wrapS = klinker.wrapT = THREE.RepeatWrapping;
  klinker.repeat.set(11.5, 400);
  // brick-paved quays on both sides of a canal (x in -7..7)
  const groundMat = new THREE.MeshStandardMaterial({ map: klinker, roughness: 0.9 });
  const sideG = new THREE.PlaneGeometry(23, 800).rotateX(-Math.PI / 2);
  for (const s of [-1, 1]) {
    const g = new THREE.Mesh(sideG, groundMat);
    g.position.x = s * 18.5;
    g.receiveShadow = true;
    scene.add(g);
  }
  // canal: dark water at -1.5 inside brick quay walls (inside faces of a box)
  const water = new THREE.Mesh(new THREE.PlaneGeometry(14, 800).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x22343a, roughness: 0.06, metalness: 0.1 }));
  water.position.y = -1.5;
  const quay = new THREE.Mesh(new THREE.BoxGeometry(14, 1.6, 800), new THREE.MeshStandardMaterial({ color: 0x4e2f27, roughness: 0.95, side: THREE.BackSide }));
  quay.position.y = -0.75;
  scene.add(water, quay);

  const bricks = ['#7e3f30', '#6a3529', '#94553b', '#d9d3c6', '#5b3a2e', '#8c4a36', '#e3ddcf', '#4b4f55'];
  const facades = bricks.map((b, i) => new THREE.MeshStandardMaterial({ map: facadeTex(b, 17 + i * 31), roughness: 0.85 }));
  const plain = bricks.map((b) => new THREE.MeshStandardMaterial({ color: b, roughness: 0.9 }));
  const roof = new THREE.MeshStandardMaterial({ color: 0x3b3431, roughness: 0.8 });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // geometry is collected per material and merged: a handful of draw calls in total
  const facadeParts: THREE.BufferGeometry[][] = bricks.map(() => []);
  const plainParts: THREE.BufferGeometry[][] = bricks.map(() => []);
  const roofParts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    for (let z = -380; z < 120; ) {
      const w = 5 + rnd() * 3.5;
      const h = 9 + rnd() * 5;
      const d = 11;
      const k = Math.floor(rnd() * bricks.length);
      plainParts[k].push(new THREE.BoxGeometry(d, h, w).translate(side * (14 + d / 2), h / 2, z + w / 2));
      // facade plane facing the canal, 2 cm in front of the box
      facadeParts[k].push(
        new THREE.PlaneGeometry(w, h)
          .rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2)
          .translate(side * 13.98, h / 2, z + w / 2),
      );
      // gable facing the canal: stepped or pitched prism
      const gh = 3 + rnd() * 3;
      const shape = new THREE.Shape();
      const stepped = rnd() < 0.55;
      shape.moveTo(-w / 2, 0);
      if (stepped) {
        const n = 3;
        for (let i = 0; i < n; i++) {
          shape.lineTo(-w / 2 + (i * w) / (2 * n + 1), ((i + 1) * gh) / n);
          shape.lineTo(-w / 2 + ((i + 1) * w) / (2 * n + 1), ((i + 1) * gh) / n);
        }
        for (let i = n - 1; i >= 0; i--) {
          shape.lineTo(w / 2 - ((i + 1) * w) / (2 * n + 1), ((i + 1) * gh) / n);
          shape.lineTo(w / 2 - (i * w) / (2 * n + 1), ((i + 1) * gh) / n);
        }
      } else {
        shape.lineTo(0, gh);
      }
      shape.lineTo(w / 2, 0);
      const gx = side * 14 + (side > 0 ? 0 : -d);
      roofParts.push(new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false }).rotateY(Math.PI / 2).translate(gx, h, z + w / 2));
      // brick gable cap on the canal side
      plainParts[k].push(
        new THREE.ShapeGeometry(shape)
          .rotateY(side > 0 ? -Math.PI / 2 : Math.PI / 2)
          .translate(side * 13.97, h, z + w / 2),
      );
      z += w + 0.05;
    }
  }
  const addMerged = (parts: THREE.BufferGeometry[], mat: THREE.Material) => {
    if (!parts.length) return;
    // ExtrudeGeometry is non-indexed; make everything non-indexed with the same attributes
    const norm = parts.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const a of Object.keys(n.attributes)) if (a !== 'position' && a !== 'normal' && a !== 'uv') n.deleteAttribute(a);
      n.clearGroups();
      return n;
    });
    const merged = mergeGeometries(norm, false);
    if (!merged) return;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  };
  bricks.forEach((_, k) => {
    addMerged(plainParts[k], plain[k]);
    addMerged(facadeParts[k], facades[k]);
  });
  addMerged(roofParts, roof);
  // trees along the quays (instanced)
  const trunkG = new THREE.CylinderGeometry(0.18, 0.25, 4, 8);
  const crownG = new THREE.IcosahedronGeometry(2.6, 1);
  const n = 50;
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x3c3128, roughness: 1 }), n);
  const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0x4e6b34, roughness: 0.9, flatShading: true }), n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const z = 100 - Math.floor(i / 2) * 15;
    m.makeTranslation(side * 8.2, 2, z);
    trunks.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(side * 8.2, 5.6, z), new THREE.Quaternion(), new THREE.Vector3(1, 1.15, 1).multiplyScalar(0.85 + ((i * 37) % 10) / 25));
    crowns.setMatrixAt(i, m);
  }
  trunks.castShadow = crowns.castShadow = true;
  scene.add(trunks, crowns);

  const cam = engine.camera;
  cam.fov = 58;
  cam.position.set(10.6, 1.9, 60);
  cam.lookAt(9.6, 2.6, -40);
  cam.updateProjectionMatrix();
  engine.setFocus(new THREE.Vector3(10, 0, 20));
  return cam.position.clone();
}

// ---------------------------------------------------------------------------------- driving sim
function routeFollower(graph: RoadGraph, start: SpawnPoint) {
  const adj = new Map<number, number[]>();
  graph.edges.forEach((e, i) => {
    if (!e.car) return;
    for (const n of [e.a, e.b]) {
      let l = adj.get(n);
      if (!l) adj.set(n, (l = []));
      l.push(i);
    }
  });
  // nearest car edge to the start
  let best = 0;
  let bestD = Infinity;
  graph.edges.forEach((e, i) => {
    if (!e.car) return;
    for (const p of e.pts) {
      const d = (p[0] - start.x) ** 2 + (p[1] - start.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  });
  let edge = best;
  let forward = true;
  let dist = 0;
  const pos = { x: start.x, z: start.z, heading: start.heading };
  return {
    pos,
    advance(m: number) {
      dist += m;
      for (let guard = 0; guard < 8; guard++) {
        const e = graph.edges[edge];
        const pts = forward ? e.pts : [...e.pts].reverse();
        let acc = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
          const [ax, az] = pts[i];
          const [bx, bz] = pts[i + 1];
          const l = Math.hypot(bx - ax, bz - az);
          if (acc + l >= dist) {
            const t = l > 0 ? (dist - acc) / l : 0;
            pos.x = ax + (bx - ax) * t;
            pos.z = az + (bz - az) * t;
            pos.heading = Math.atan2(bx - ax, bz - az);
            return;
          }
          acc += l;
        }
        // next edge
        dist -= acc;
        const end = forward ? e.b : e.a;
        const options = (adj.get(end) ?? []).filter((i) => i !== edge);
        const next = options.length ? options[Math.floor((edge * 7919) % options.length)] : edge;
        forward = graph.edges[next].a === end;
        edge = next;
      }
    },
  };
}

// ---------------------------------------------------------------------------------- scene
const devUi: SceneEntry = async (engine, params) => {
  const state = params.get('state') ?? 'menu';
  if (params.get('bg') !== '0') buildBackdrop(engine);
  engine.start();

  const ui: GameUI = createUI(engine);
  window.__debug = { ...(window.__debug ?? {}), ui };

  if (state === 'loading') {
    const fixed = params.get('fraction');
    const labels = ['Kaartgegevens laden…', 'Wegen en grachten opbouwen…', 'Gebouwen laden (3D BAG)…', 'Texturen laden…', 'Verkeer voorbereiden…'];
    let f = fixed ? Number(fixed) : 0;
    ui.showLoading(f, labels[0]);
    if (!fixed) {
      engine.onUpdate((dt) => {
        f = Math.min(1, f + dt * 0.06);
        ui.showLoading(f, labels[Math.min(labels.length - 1, Math.floor(f * labels.length))]);
      }, 60);
    }
    window.__ready = true;
    return;
  }

  const [{ cars, def }, map2d, fp, graph, meta] = await Promise.all([
    loadCars(params.get('fakecars') === '1'),
    fetchJson<Map2D>('map2d.json'),
    fetchJson<Footprints>('footprints.json'),
    fetchJson<RoadGraph>('roadgraph.json'),
    fetchJson<OsmMeta>('osm-meta.json'),
  ]);
  const fake = !map2d || !graph ? fakeMap() : null;
  const spawns = meta?.spawnPoints?.length ? meta.spawnPoints : fake?.spawns ?? [];
  ui.minimap.setData(map2d ?? fake!.map2d, fp ?? fake?.fp ?? null, graph ?? fake!.graph);
  if (meta?.landmarks) ui.minimap.setLandmarks(meta.landmarks);
  ui.setSpawnPoints(spawns);
  // ?gearbox=manual|auto  ?assists=abs0,tcs0,esc0 (switch assists off)
  const gb = params.get('gearbox');
  const as = params.get('assists');
  if (gb === 'manual' || gb === 'auto' || as !== null) {
    const off = new Set((as ?? '').split(','));
    ui.setDriving({ gearbox: gb === 'manual' ? 'manual' : gb === 'auto' ? 'auto' : undefined, assists: { abs: !off.has('abs0'), tcs: !off.has('tcs0'), esc: !off.has('esc0') } });
  }
  const carId = params.get('car') ?? def;
  const spec = cars.find((c) => c.id === carId) ?? cars[0];

  let stopSim: (() => void) | null = null;
  const startHud = (spawnId?: string, carSpec: CarSpec = spec) => {
    stopSim?.();
    ui.hud.setCar(carSpec);
    ui.hud.show();
    const sp = spawns.find((s) => s.id === spawnId) ?? spawns[0] ?? { id: 'o', name: 'O', x: 0, z: 0, heading: 0 };
    const route = routeFollower(graph ?? fake!.graph, sp);
    const fixedSpeed = params.get('speed');
    let t = 0;
    const tel: VehicleTelemetry = { speedKmh: 0, rpm: 800, gear: 1, throttle: 0, brake: 0, slip: 0, grounded: [true, true, true, true], impact: 0 };
    // ?lights=head,park,abs,tcs,esc lights fixed telltales; default: dimlicht on, short ESP pulses
    const lp = params.get('lights');
    const lset = new Set((lp ?? 'head').split(','));
    const lights: HudLights = { head: lset.has('head'), handbrake: lset.has('park'), abs: lset.has('abs'), tcs: lset.has('tcs'), esc: lset.has('esc') };
    const info: HudInfo = { x: 0, z: 0, heading: 0, lights };
    stopSim = engine.onUpdate((dt) => {
      t += dt;
      const v = fixedSpeed ? Number(fixedSpeed) : 32 + 18 * Math.sin(t * 0.35);
      route.advance((v / 3.6) * dt);
      const gearMax = spec.gearRatios.length;
      const gear = spec.electric ? 1 : Math.min(gearMax, 1 + Math.floor(v / 17));
      const ratio = spec.electric ? 9 : spec.gearRatios[gear - 1] * spec.finalDrive;
      tel.speedKmh = v;
      tel.gear = v < 0.5 ? 0 : gear;
      tel.rpm = Math.max(spec.idleRpm, (v / 3.6 / (2 * Math.PI * spec.wheelRadius)) * ratio * 60);
      tel.throttle = 0.35 + 0.3 * Math.cos(t * 0.35);
      if (lp === null) lights.tcs = (t % 7) < 0.6; // demo: TCS pulse every 7 s
      info.x = route.pos.x;
      info.z = route.pos.z;
      info.heading = route.pos.heading;
      ui.hud.update(tel, info);
      ui.minimap.update(route.pos.x, route.pos.z, route.pos.heading);
    }, 60);
  };

  const handlers: PauseHandlers = {
    onResume: () => ui.toast('Verder rijden'),
    onChangeCar: () => showMenu(),
    onRespawn: (id) => {
      ui.toast(`Verplaatst naar ${spawns.find((s) => s.id === id)?.name ?? id}`);
      startHud(id, ui.hud.spec ?? spec);
    },
    onQuit: () => ui.toast('Afsluiten (alleen in de .exe)'),
    onVolume: () => {},
    onGearbox: (m) => ui.toast(m === 'manual' ? 'Handgeschakeld' : 'Automaat'),
    onAssists: (a) => ui.toast(`ABS ${a.abs ? 'aan' : 'uit'} · TCS ${a.tcs ? 'aan' : 'uit'} · ESP ${a.esc ? 'aan' : 'uit'}`),
  };
  const showMenu = () =>
    ui.showMainMenu({
      cars,
      defaultCarId: spec.id,
      spawnPoints: spawns,
      onStart: (sel) => {
        ui.toast(`Rit gestart bij ${spawns.find((s) => s.id === sel.spawnId)?.name ?? sel.spawnId}`, 3000);
        startHud(sel.spawnId, cars.find((c) => c.id === sel.carId));
      },
      onQuit: () => ui.toast('Afsluiten (alleen in de .exe)'),
    });

  // Simulates the integration: Esc while driving opens the pause menu.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.repeat && ui.hud.visible && !ui.isBlockingInput()) ui.showPause(handlers);
  });

  switch (state) {
    case 'menu':
      showMenu();
      break;
    case 'sheet':
      showMenu();
      setTimeout(() => (document.querySelector('.ad-menu-links button') as HTMLButtonElement | null)?.click(), 300);
      break;
    case 'hud':
      startHud();
      setTimeout(() => ui.toast('Welkom in Alkmaar! Druk op Esc voor het menu.', 6000), 400);
      if (params.get('fps') === '1') ui.hud.toggleFps(true);
      break;
    case 'map':
      startHud();
      setTimeout(() => ui.minimap.toggleBigMap(true), 200);
      break;
    case 'rijden':
      startHud();
      setTimeout(() => {
        ui.showPause(handlers, 'settings');
        setTimeout(() => (document.querySelectorAll('.ad-tab')[2] as HTMLButtonElement | undefined)?.click(), 150);
      }, 300);
      break;
    case 'pause':
    case 'settings':
    case 'controls':
    case 'credits':
    case 'spawn':
      startHud();
      setTimeout(() => ui.showPause(handlers, state === 'pause' ? undefined : state), 300);
      break;
    case 'confirm':
      startHud();
      setTimeout(() => {
        ui.showPause(handlers);
        setTimeout(() => (document.querySelector('.ad-pause-item.is-quit') as HTMLButtonElement | null)?.click(), 200);
      }, 300);
      break;
    default:
      showMenu();
  }
  setTimeout(() => (window.__ready = true), 600);
};

export default devUi;
