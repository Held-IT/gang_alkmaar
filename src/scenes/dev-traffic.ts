// Dev scene for the traffic module: ?scene=dev-traffic
//
// Loads the city around ?focus=x,z (default the Waag 0,0): ground + buildings GLBs within ?radius
// (default 450 m) with the MaterialLibrary when available, collision_ground.bin into physics (used
// for heightAt), optional street props, and runs createTraffic around the focus.
//   ?focus=x,z        traffic focus (spawn ring centre)
//   ?cam=x,y,z&look=  orbit camera (dev camera)
//   ?follow=1         chase camera behind an AI car (focus follows it); ?follow=<carId>
//   ?density=0..1     traffic density (default: quality preset)
//   ?warm=s           simulate s seconds before the first frame (default 6)
//   ?props=0 ?city=0  skip street props / buildings;  ?world=1 use loadWorld() from src/world
//   ?lanes=1          draw car lanes (red), bike paths (orange) and walking lines (white) near focus
//   ?player=x,z       put a fake player car (static box) at x,z to test yielding
//   ?drive=x,z,heading,kmh[,delay]  fake player box driving a straight line (dodging / bumps)
//   ?traffic=0        hide all traffic (cost comparison);  ?showcase=x,z,heading  people line-up
// window.__debug: trafficCounts, trafficStats, traffic, sim(seconds), overlaps(), carsNear(r),
//   lineUp(x,z,heading,n), drive(x,z,heading,kmh,delay), ram(x,z,heading,kmh,seconds,lineUpN)
import * as THREE from 'three';
import type { Engine, MaterialClass, MaterialLibrary, OsmMeta, PhysicsWorld, PropsData, RoadGraph, SceneEntry, World } from '../contracts';
import { DATA_URL } from '../config';
import { setupDevCamera } from '../dev/devCamera';
import { createTraffic, type TrafficSystemExt } from '../traffic';
import { PATH_LANE } from '../traffic/paths';

type PhysModule = { createPhysics: () => Promise<PhysicsWorld> };
type MatModule = { createMaterialLibrary: (e: Engine) => Promise<MaterialLibrary> };
type PropsModule = { createProps: (e: Engine, p: PhysicsWorld | null, m: MaterialLibrary | null, d: PropsData, o?: Record<string, unknown>) => { root: THREE.Group; update(dt: number, cam: THREE.Vector3): void } };
type WorldModule = { loadWorld: (e: Engine, p: PhysicsWorld | null, onProgress?: (f: number, l: string) => void) => Promise<World> };

const physicsModules = import.meta.glob<PhysModule>('../physics/physics.ts');
const materialModules = import.meta.glob<MatModule>('../world/materials/index.ts');
const propsModules = import.meta.glob<PropsModule>('../world/props/index.ts');
const worldModules = import.meta.glob<WorldModule>('../world/world.ts');

function vec2(s: string | null, def: [number, number]): [number, number] {
  if (!s) return def;
  const p = s.split(',').map(Number);
  return p.length === 2 && p.every(Number.isFinite) ? [p[0], p[1]] : def;
}

async function getJson<T>(file: string): Promise<T> {
  const r = await fetch(DATA_URL + file);
  if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

function nullPhysics(): PhysicsWorld {
  return {
    RAPIER: null, world: null, alpha: 0,
    step: () => 0, addStaticTrimesh: () => {}, addStaticCylinder: () => {}, addStaticBox: () => {},
    raycastDown: () => null, onPreStep: () => () => {}, onPostStep: () => () => {},
  };
}

/** Minimal World: ground + buildings near the focus, heightAt via physics ray casts. */
async function loadLocalWorld(
  engine: Engine, physics: PhysicsWorld, params: URLSearchParams, fx: number, fz: number,
): Promise<World> {
  const radius = Number(params.get('radius') ?? 450);
  const [meta, graph, props] = await Promise.all([
    getJson<OsmMeta>('osm-meta.json'), getJson<RoadGraph>('roadgraph.json'), getJson<PropsData>('props.json'),
  ]);
  const root = new THREE.Group();
  root.name = 'dev-world';
  engine.scene.add(root);
  let lib: MaterialLibrary | null = null;
  const lm = materialModules['../world/materials/index.ts'];
  if (lm) {
    try { lib = await (await lm()).createMaterialLibrary(engine); } catch (e) { console.warn('[dev-traffic] MaterialLibrary niet beschikbaar', e); }
  }
  const fallback = new Map<string, THREE.Material>();
  const colors: Record<string, number> = { wall: 0x8a4a3a, roof_slanted: 0x5a2e26, roof_flat: 0x555555, asphalt: 0x404040, klinkers: 0x7a4a3c, sidewalk: 0x9a968e, square: 0x8a7a6a, curb: 0xa0a0a0, bikelane: 0x7a3a32, grass: 0x4a6a32, water: 0x203038, quay: 0x6a3a2e };
  const matFor = (name: string): THREE.Material => {
    if (lib) { try { return lib.get(name as MaterialClass); } catch { /* fall through */ } }
    let m = fallback.get(name);
    if (!m) fallback.set(name, (m = new THREE.MeshStandardMaterial({ color: colors[name] ?? 0x888888, roughness: 0.9 })));
    return m;
  };
  // chunk files near the focus (chunk grid: i = floor((x + 2000) / 200))
  const near = (i: number, j: number): boolean => {
    const cx = i * 200 - 2000 + 100;
    const cz = j * 200 - 2000 + 100;
    return Math.hypot(cx - fx, cz - fz) < radius + 142;
  };
  const files: string[] = [];
  for (const f of meta.groundFiles) {
    const m = /ground_(\d+)_(\d+)\.glb/.exec(f);
    if (!m || near(Number(m[1]), Number(m[2])) ) files.push(f);
  }
  if (params.get('city') !== '0') {
    try {
      const bag = await getJson<{ buildingFiles: { file: string; bounds: { minX: number; minZ: number; maxX: number; maxZ: number } }[] }>('bag-meta.json');
      for (const b of bag.buildingFiles) {
        const cx = (b.bounds.minX + b.bounds.maxX) / 2;
        const cz = (b.bounds.minZ + b.bounds.maxZ) / 2;
        if (Math.hypot(cx - fx, cz - fz) < radius + 150) files.push(b.file);
      }
    } catch (e) { console.warn('[dev-traffic] geen bag-meta', e); }
  }
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  await Promise.all(files.map(async (file) => {
    try {
      const gltf = await loader.loadAsync(DATA_URL + file);
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
      for (const mesh of meshes) {
        const name = (mesh.material as THREE.Material).name;
        if (name === 'water' && lib) {
          const w = lib.createWater(mesh.geometry);
          mesh.parent?.add(w);
          mesh.parent?.remove(mesh);
          continue;
        }
        mesh.material = matFor(name);
        mesh.castShadow = file.startsWith('buildings');
        mesh.receiveShadow = true;
      }
      root.add(gltf.scene);
    } catch (e) { console.warn(`[dev-traffic] ${file} niet geladen`, e); }
  }));
  // collision ground -> physics (heightAt)
  try {
    const buf = await (await fetch(DATA_URL + 'collision_ground.bin')).arrayBuffer();
    const dv = new DataView(buf);
    const vc = dv.getUint32(0, true);
    const ic = dv.getUint32(4, true);
    const pos = new Float32Array(buf, 8, vc * 3);
    const idx = new Uint32Array(buf, 8 + vc * 12, ic);
    physics.addStaticTrimesh(pos, idx, { tag: 'ground' });
  } catch (e) { console.warn('[dev-traffic] collision_ground.bin niet geladen', e); }
  // props (trees, lamps, parked bikes...)
  let propsSys: { root: THREE.Group; update(dt: number, cam: THREE.Vector3): void } | null = null;
  const pm = propsModules['../world/props/index.ts'];
  if (pm && params.get('props') !== '0') {
    try {
      propsSys = (await pm()).createProps(engine, physics, lib, props, { roadGraph: graph, noBoats: params.get('boats') !== '1' });
      root.add(propsSys.root);
    } catch (e) { console.warn('[dev-traffic] props niet beschikbaar', e); }
  }
  const camPos = new THREE.Vector3();
  return {
    root,
    osmMeta: meta,
    bagMeta: { buildingFiles: [], backdropFiles: [], buildingCount: 0, attribution: '' },
    roadGraph: graph,
    props,
    materials: lib ?? ({ get: matFor, createWater: () => new THREE.Mesh(), texture: () => undefined, dispose: () => {} } as unknown as MaterialLibrary),
    update(dt: number, cam: THREE.Vector3) {
      camPos.copy(cam);
      propsSys?.update(dt, camPos);
    },
    heightAt(x: number, z: number): number {
      const h = physics.raycastDown(x, z, 4);
      return h === null ? NaN : h;
    },
    dispose() { root.removeFromParent(); },
  };
}

/** Number of overlapping AI car pairs (oriented rectangles, 5 cm tolerance). */
function countOverlaps(traffic: TrafficSystemExt): number {
  const cars = traffic.debug.cars.cars;
  let n = 0;
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (dx * dx + dz * dz > 49) continue;
      // SAT over the 4 axes
      const axes = [[a.dirX, a.dirZ], [-a.dirZ, a.dirX], [b.dirX, b.dirZ], [-b.dirZ, b.dirX]];
      let sep = false;
      for (const [ax, az] of axes) {
        const ra = Math.abs(a.halfLen * (a.dirX * ax + a.dirZ * az)) + Math.abs(a.halfW * (-a.dirZ * ax + a.dirX * az));
        const rb = Math.abs(b.halfLen * (b.dirX * ax + b.dirZ * az)) + Math.abs(b.halfW * (-b.dirZ * ax + b.dirX * az));
        if (Math.abs(dx * ax + dz * az) > ra + rb - 0.05) { sep = true; break; }
      }
      if (!sep) n++;
    }
  }
  return n;
}

/** Cars overlapping a cyclist or pedestrian (point inside the car rectangle grown by the person radius). */
function countPeopleOverlaps(traffic: TrafficSystemExt): { bikes: number; peds: number } {
  const cars = traffic.debug.cars.cars;
  const { bikes, peds } = traffic.debug.people;
  let nb = 0;
  let np = 0;
  for (const c of cars) {
    for (const [list, r, isBike] of [[bikes, 0.35, true], [peds, 0.22, false]] as const) {
      for (const p of list) {
        const dx = p.x - c.x;
        const dz = p.z - c.z;
        if (dx * dx + dz * dz > 16) continue;
        const al = Math.abs(dx * c.dirX + dz * c.dirZ);
        const la = Math.abs(-dx * c.dirZ + dz * c.dirX);
        if (al < c.halfLen + r - 0.05 && la < c.halfW + r - 0.05) { if (isBike) nb++; else np++; }
      }
    }
  }
  return { bikes: nb, peds: np };
}

function drawLanes(traffic: TrafficSystemExt, root: THREE.Group, fx: number, fz: number, r: number): void {
  const net = traffic.debug.network;
  const pts: number[] = [];
  const cols: number[] = [];
  const add = (p: { xs: Float32Array; zs: Float32Array; n: number }, c: [number, number, number], y: number) => {
    for (let i = 0; i < p.n - 1; i++) {
      pts.push(p.xs[i], y, p.zs[i], p.xs[i + 1], y, p.zs[i + 1]);
      cols.push(...c, ...c);
    }
  };
  for (let ei = 0; ei < net.edges.length; ei++) {
    const e = net.edges[ei];
    const q = e.pts[Math.floor(e.pts.length / 2)];
    if (Math.hypot(q[0] - fx, q[1] - fz) > r) continue;
    if (e.car) {
      for (let dir = 0; dir < (e.oneway ? 1 : 2); dir++) for (let l = 0; l < net.laneCount(ei); l++) add(net.carLane(ei, dir, l), [1, 0.1, 0.1], 0.25);
    }
    if (e.bike) add(net.bikePath(ei, 0), [1, 0.6, 0], 0.3);
    if (e.foot) for (let side = 0; side < (e.car ? 2 : 1); side++) { const p = net.footPath(ei, side, 0); if (p) add(p, [1, 1, 1], 0.35); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false }));
  lines.renderOrder = 10;
  root.add(lines);
}

const devTraffic: SceneEntry = async (engine, params) => {
  const [fx, fz] = vec2(params.get('focus'), [0, 0]);
  const focus = new THREE.Vector3(fx, 0, fz);
  // physics
  let physics: PhysicsWorld = nullPhysics();
  const lp = physicsModules['../physics/physics.ts'];
  if (lp) {
    try { physics = await (await lp()).createPhysics(); } catch (e) { console.warn('[dev-traffic] physics niet beschikbaar', e); }
  }
  // world
  let world: World | null = null;
  const lw = worldModules['../world/world.ts'];
  if (lw && params.get('world') === '1') {
    try { world = await (await lw()).loadWorld(engine, physics); engine.scene.add(world.root); } catch (e) { console.warn('[dev-traffic] loadWorld mislukt, eigen loader', e); world = null; }
  }
  if (!world) world = await loadLocalWorld(engine, physics, params, fx, fz);

  const traffic = createTraffic(engine, physics, world, { seed: Number(params.get('seed') ?? 1), parked: params.get('parked') !== '0' });
  if (params.get('tshadow') === '0') traffic.root.traverse((o) => (o.castShadow = false));
  if (params.get('people') === '0') traffic.debug.people.root.visible = false;
  // ?traffic=0: keep the system but hide it (for cost measurements)
  if (params.get('traffic') === '0') traffic.root.visible = false;
  if (params.has('density')) traffic.setDensity(Number(params.get('density')));
  const sc = params.get('showcase');
  if (sc) {
    const p = sc.split(',').map(Number);
    const hy = world.heightAt(p[0], p[1]);
    traffic.debug.people.addShowcase(p[0], Number.isFinite(hy) ? hy : 0, p[1], p[2] ?? 0, p[3] ?? 8, p[4] ?? 3);
  }
  if (params.get('lanes') === '1') drawLanes(traffic, world.root, fx, fz, Number(params.get('lanesR') ?? 120));

  // optional fake player (static box) to test yielding; drive=x,z,heading,kmh[,delay s] (or
  // __debug.drive(...)) moves it in a straight line (people dodging / bump test)
  const pl = params.get('player');
  let drv: number[] | null = null;
  const fakePos = new THREE.Vector3();
  const fakeVel = new THREE.Vector3();
  const fakeQuat = new THREE.Quaternion();
  let fakeBox: THREE.Mesh | null = null;
  let driveT = 0;
  const placeFake = (px: number, pz: number, hd: number): void => {
    if (!fakeBox) {
      fakeBox = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 4.3), new THREE.MeshStandardMaterial({ color: 0xff00ff }));
      engine.scene.add(fakeBox);
    }
    fakePos.set(px, 0, pz);
    fakeVel.set(0, 0, 0);
    fakeQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hd);
    fakeBox.position.set(px, world.heightAt(px, pz) + 0.8, pz);
    fakeBox.quaternion.copy(fakeQuat);
    traffic.setPlayer({ position: fakePos, velocity: fakeVel, quaternion: fakeQuat });
  };
  const startDrive = (x: number, z: number, hd: number, kmh = 30, delay = 0): void => {
    drv = [x, z, hd, kmh, delay];
    driveT = 0;
    placeFake(x, z, hd);
  };
  const drvP = params.get('drive')?.split(',').map(Number);
  if (drvP) startDrive(drvP[0], drvP[1], drvP[2] ?? 0, drvP[3] ?? 30, drvP[4] ?? 0);
  else if (pl) {
    const [px, pz] = vec2(pl, [fx, fz]);
    placeFake(px, pz, 0);
  }
  const driveStep = (dt: number): void => {
    if (!drv || !fakeBox) return;
    driveT += dt;
    const v = driveT >= drv[4] ? drv[3] / 3.6 : 0;
    fakeVel.set(Math.sin(drv[2]) * v, 0, Math.cos(drv[2]) * v);
    fakePos.addScaledVector(fakeVel, dt);
    fakeBox.position.set(fakePos.x, world.heightAt(fakePos.x, fakePos.z) + 0.8, fakePos.z);
  };

  // camera
  const followParam = params.get('follow');
  let followId = followParam ? Number(followParam) : 0;
  const cam = engine.camera;
  cam.near = 0.1;
  cam.updateProjectionMatrix();
  if (!followParam) {
    setupDevCamera(engine, params, { cam: new THREE.Vector3(fx + 30, 22, fz + 30), look: new THREE.Vector3(fx, 0, fz) });
  }
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  let camInit = false;
  const followCar = () => {
    const cars = traffic.debug.cars.cars;
    let c = cars.find((k) => k.id === followId);
    if (!c && cars.length) {
      // nearest moving car to the focus
      let best = 1e9;
      for (const k of cars) {
        const d = Math.hypot(k.x - focus.x, k.z - focus.z) + (k.v < 1 ? 50 : 0);
        if (d < best) { best = d; c = k; }
      }
      if (c) followId = c.id;
    }
    return c ?? null;
  };

  engine.onUpdate((dt) => physics.step(dt), 10);
  engine.onUpdate((dt) => {
    if (followParam) {
      const c = followCar();
      if (c) {
        focus.set(c.x, 0, c.z);
        const tx = c.x - c.dirX * 8.5;
        const tz = c.z - c.dirZ * 8.5;
        if (!camInit || Math.hypot(camPos.x - tx, camPos.z - tz) > 25) { camPos.set(tx, c.y + 3.2, tz); camInit = true; }
        const k = 1 - Math.exp(-dt * 4);
        camPos.x += (tx - camPos.x) * k;
        camPos.z += (tz - camPos.z) * k;
        camPos.y += (c.y + 3.2 - camPos.y) * k;
        lookAt.set(c.x + c.dirX * 5, c.y + 1.0, c.z + c.dirZ * 5);
        cam.position.copy(camPos);
        cam.lookAt(lookAt);
        engine.setFocus(focus);
      }
    }
    driveStep(dt);
    traffic.update(dt, focus);
  }, 30);
  engine.onUpdate((dt) => world!.update(dt, cam.position), 40);

  // debug hooks
  const dbg = (window.__debug = window.__debug ?? {});
  dbg.trafficCounts = traffic.counts;
  dbg.trafficStats = traffic.stats;
  dbg.traffic = traffic;
  dbg.overlaps = () => ({ cars: countOverlaps(traffic), ...countPeopleOverlaps(traffic) });
  dbg.carsNear = (r = 60) => traffic.debug.cars.cars
    .filter((c) => Math.hypot(c.x - focus.x, c.z - focus.z) < r)
    .map((c) => ({ id: c.id, x: +c.x.toFixed(1), z: +c.z.toFixed(1), v: +(c.v * 3.6).toFixed(0), gap: +c.gap.toFixed(1), lead: c.leadKind, wait: +c.waitT.toFixed(1), path: c.route[0].kind === PATH_LANE ? 'lane' : 'conn' }));
  dbg.setFocus = (x: number, z: number) => focus.set(x, 0, z);
  const who = (kind: number, ref: number) => {
    const t = traffic.debug;
    const a = kind === 0 ? t.cars.cars.find((c) => c.id === ref) : kind === 1 ? t.people.bikes.find((b) => b.id === ref) : kind === 2 ? t.people.peds.find((b) => b.id === ref) : null;
    if (!a) return null;
    const pa = a as unknown as { leadKind: number; leadRef: number; waitT: number; v: number; x: number; z: number; route: { kind: number; edge: number }[]; pauseT?: number; lat?: number };
    return { k: kind, id: ref, x: +pa.x.toFixed(1), z: +pa.z.toFixed(1), v: +pa.v.toFixed(2), wait: +pa.waitT.toFixed(1), lead: pa.leadKind + ':' + pa.leadRef, onConn: pa.route[0]?.kind === 1, edgeType: pa.route[0] ? traffic.debug.network.edges[pa.route[0].edge]?.type : '', pause: pa.pauseT, lat: pa.lat };
  };
  dbg.pedOverlaps = () => {
    const out: unknown[] = [];
    for (const c of traffic.debug.cars.cars) for (const p of traffic.debug.people.peds) {
      const dx = p.x - c.x, dz = p.z - c.z;
      if (dx * dx + dz * dz > 16) continue;
      const al = Math.abs(dx * c.dirX + dz * c.dirZ), la = Math.abs(-dx * c.dirZ + dz * c.dirX);
      if (al < c.halfLen + 0.17 && la < c.halfW + 0.17) out.push({ car: c.id, cv: +c.v.toFixed(1), clead: c.leadKind + ':' + c.leadRef, cpath: c.route[0].kind, ped: who(2, p.id) });
    }
    return out;
  };
  dbg.bikeOverlaps = () => {
    const out: unknown[] = [];
    for (const c of traffic.debug.cars.cars) for (const b of traffic.debug.people.bikes) {
      const dx = b.x - c.x, dz = b.z - c.z;
      if (dx * dx + dz * dz > 16) continue;
      const al = Math.abs(dx * c.dirX + dz * c.dirZ), la = Math.abs(-dx * c.dirZ + dz * c.dirX);
      if (al < c.halfLen + 0.3 && la < c.halfW + 0.3) out.push({ car: c.id, cv: +c.v.toFixed(1), clead: c.leadKind + ':' + c.leadRef, cpath: c.route[0].kind, cturn: c.route[0].turn, cosH: +(c.dirX * b.dirX + c.dirZ * b.dirZ).toFixed(2), bike: who(1, b.id), ign: +b.ignoreT.toFixed(1) });
    }
    return out;
  };
  dbg.stuck = (minT = 8) => traffic.debug.cars.cars.filter((c) => c.stuckT > minT).map((c) => ({
    id: c.id, x: +c.x.toFixed(1), z: +c.z.toFixed(1), t: +c.stuckT.toFixed(1), gap: +c.gap.toFixed(1), lead: c.leadKind,
    path: c.route[0].kind === PATH_LANE ? 'lane' : 'conn', approach: c.approach?.id ?? -1, granted: c.granted?.id ?? -1,
    dBox: +c.distToBox.toFixed(1), term: c.terminal, leadInfo: who(c.leadKind, c.leadRef), inside: c.approach ? c.approach.inside.map((o) => o.id) : [],
    appr: c.approach ? c.approach.approaching.map((o) => o.id + ':' + o.waitT.toFixed(1)) : [],
  }));
  const insideFn = (world as World & { isInsideBuilding?: (x: number, z: number) => boolean }).isInsideBuilding?.bind(world) ?? null;
  /** Moves up to n walkers of the same street onto the line (x, z, heading) at 10 m + 2.5 m steps. */
  dbg.lineUp = (x: number, z: number, heading: number, n = 6, first = 10) => {
    const fxr = Math.sin(heading);
    const fzr = Math.cos(heading);
    // walkers on the same street (close to the line) so that walking back stays on the street
    const near = (p: { x: number; z: number }) => {
      const la = (p.x - x) * fxr + (p.z - z) * fzr;
      return la > -10 && la < 60 && Math.abs(-(p.x - x) * fzr + (p.z - z) * fxr) < 5;
    };
    const cand = traffic.debug.people.peds.filter((p) => !p.pinned && near(p)).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    for (let i = 0; i < Math.min(n, cand.length); i++) {
      const d = first + i * 2.5;
      const p = cand[i];
      p.offX += x + fxr * d + (i % 2 ? 0.4 : -0.4) * fzr - p.x;
      p.offZ += z + fzr * d - (i % 2 ? 0.4 : -0.4) * fxr - p.z;
      p.x = p.px + p.offX;
      p.z = p.pz + p.offZ;
      p.pauseT = 30;
      p.dodgeT = 3;
    }
    return Math.min(n, cand.length);
  };
  dbg.drive = startDrive;
  /**
   * Headless ram test: a player box drives from (x, z) along `heading` at `kmh` for `seconds`
   * (through whatever people are there; `toward` > 0 lines that many walkers up first). Returns
   * bumps, dodges and people whose centre ended up inside the car outline, just ahead of a bumper
   * (carried along), inside a building or off a quay.
   */
  dbg.ram =(x: number, z: number, heading: number, kmh = 30, seconds = 5, toward = 0) => {
    const pos = new THREE.Vector3(x, 0, z);
    const vel = new THREE.Vector3();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const fxr = Math.sin(heading);
    const fzr = Math.cos(heading);
    const v = kmh / 3.6;
    const ppl = traffic.debug.people;
    if (toward > 0) (dbg.lineUp as (x: number, z: number, h: number, n: number) => number)(x, z, heading, toward);
    traffic.setPlayer({ position: pos, velocity: vel, quaternion: q });
    const b0 = traffic.stats.bumps;
    let inBox = 0;
    let nearBox = 0; // just ahead of / behind the bumpers within the car width (carried along)
    let inBuilding = 0;
    let offQuay = 0;
    let maxDodging = 0;
    let minLatClear = 9;
    const all = () => [...ppl.peds, ...ppl.bikes];
    for (let i = 0; i < Math.round(seconds * 30); i++) {
      vel.set(fxr * v, 0, fzr * v);
      pos.addScaledVector(vel, 1 / 30);
      traffic.update(1 / 30, pos);
      maxDodging = Math.max(maxDodging, traffic.stats.dodging);
      for (const a of all()) {
        const dx = a.x - pos.x;
        const dz = a.z - pos.z;
        if (dx * dx + dz * dz > 36) continue;
        const la = dx * fxr + dz * fzr;
        const lr = -dx * fzr + dz * fxr;
        if (Math.abs(la) < 2.25) minLatClear = Math.min(minLatClear, Math.abs(lr) - 0.95);
        if (Math.abs(la) < 2.2 && Math.abs(lr) < 0.9) inBox++;
        else if (Math.abs(la) < 2.8 && Math.abs(lr) < 0.95) nearBox++;
        if (insideFn && insideFn(a.x, a.z)) inBuilding++;
        if (world.heightAt(a.x, a.z) < a.y - 0.5) offQuay++;
      }
    }
    traffic.setPlayer(null);
    return { bumps: traffic.stats.bumps - b0, maxDodging, inBoxSamples: inBox, nearBoxSamples: nearBox, inBuildingSamples: inBuilding, offQuaySamples: offQuay, minLatClear: +minLatClear.toFixed(2), hasInsideFn: !!insideFn };
  };
  /** Headless simulation (no rendering) of `seconds` at 30 Hz; returns a summary. */
  dbg.sim = (seconds = 30) => {
    const dt = 1 / 30;
    const steps = Math.round(seconds / dt);
    let overlapMax = 0;
    let bikeOv = 0;
    const povSamples: unknown[] = [];
    const bovSamples: unknown[] = [];
    let pedOv = 0;
    let inBld = 0;
    const inBldSamples: unknown[] = [];
    let overlapSum = 0;
    let samples = 0;
    let maxMs = 0;
    let sumMs = 0;
    let speedSum = 0;
    let bikeSpeed = 0;
    let pedSpeed = 0;
    const startSpawned = traffic.stats.spawnedCars;
    const startStuck = traffic.stats.stuckDespawns;
    for (let i = 0; i < steps; i++) {
      traffic.update(dt, focus);
      const ms = traffic.stats.updateMs;
      sumMs += ms;
      if (ms > maxMs) maxMs = ms;
      if (i % 15 === 0) {
        const o = countOverlaps(traffic);
        overlapMax = Math.max(overlapMax, o);
        overlapSum += o;
        const po = countPeopleOverlaps(traffic);
        if (po.peds > 0 && povSamples.length < 6) povSamples.push((dbg.pedOverlaps as () => unknown[])());
        if (po.bikes > 0 && bovSamples.length < 8) bovSamples.push((dbg.bikeOverlaps as () => unknown[])());
        bikeOv += po.bikes;
        pedOv += po.peds;
        if (insideFn) {
          for (const a of [...traffic.debug.people.peds, ...traffic.debug.people.bikes]) {
            if (!insideFn(a.x, a.z)) continue;
            inBld++;
            if (inBldSamples.length < 6) inBldSamples.push({ k: a.kind, x: +a.x.toFixed(1), z: +a.z.toFixed(1), off: +Math.hypot(a.offX, a.offZ).toFixed(2), lat: +a.lat.toFixed(2), conn: a.route[0].kind, type: traffic.debug.network.edges[a.route[0].edge]?.type });
          }
        }
        samples++;
        const cs = traffic.debug.cars.cars;
        speedSum += cs.reduce((a, c) => a + c.v, 0) / Math.max(1, cs.length);
        const bs = traffic.debug.people.bikes;
        bikeSpeed += bs.reduce((a, c) => a + c.v, 0) / Math.max(1, bs.length);
        const ps = traffic.debug.people.peds;
        pedSpeed += ps.reduce((a, c) => a + c.v, 0) / Math.max(1, ps.length);
      }
    }
    const cars = traffic.debug.cars.cars;
    return {
      seconds, counts: { ...traffic.counts },
      avgCarKmh: +((speedSum / samples) * 3.6).toFixed(1),
      avgBikeKmh: +((bikeSpeed / samples) * 3.6).toFixed(1),
      avgPedKmh: +((pedSpeed / samples) * 3.6).toFixed(1),
      stoppedNow: cars.filter((c) => c.v < 0.3).length,
      stuckOver15s: cars.filter((c) => c.stuckT > 15).length,
      maxStuckS: +Math.max(0, ...cars.map((c) => c.stuckT)).toFixed(1),
      peopleInBuildingSamples: inBld, inBldSamples,
      overlapMax, overlapAvg: +(overlapSum / samples).toFixed(2), carBikeOverlapSamples: bikeOv, carPedOverlapSamples: pedOv, povSamples, bovSamples, forcedGrants: traffic.debug.cars.forcedGrants, mutualBreaks: traffic.debug.cars.mutualBreaks,
      spawned: traffic.stats.spawnedCars - startSpawned,
      stuckDespawns: traffic.stats.stuckDespawns - startStuck,
      updateMsAvg: +(sumMs / steps).toFixed(3), updateMsMax: +maxMs.toFixed(2),
    };
  };

  // warm-up so the screenshot shows a settled traffic state
  const warm = Number(params.get('warm') ?? 6);
  for (let t = 0; t < warm; t += 1 / 30) traffic.update(1 / 30, focus);
  engine.start();
  window.__ready = true;
};

export default devTraffic;
