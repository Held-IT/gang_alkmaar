// World assembly: loads the city data produced by the OSM and 3D BAG pipelines and builds the
// playable Alkmaar at runtime (ARCHITECTURE 4 + 5).
//
//   const world = await loadWorld(engine, physics, (f, label) => ui.progress(f, label));
//   engine.onUpdate((dt) => world.update(dt, engine.camera.position), 40);
//
// loadWorld adds world.root to engine.scene itself (adding it again is harmless).
// Steps: JSON metadata + MaterialLibrary -> all chunk GLBs in parallel (own GLB reader) ->
// height/surface grid -> merged super-chunk meshes with real materials -> static colliders
// (ground per surface type, buildings, boundary walls) -> props + landmarks -> shader warm-up.
import * as THREE from 'three';
import type {
  BagMeta, Engine, Footprints, Map2D, MaterialClass, OsmMeta, PhysicsWorld, ProgressFn, PropsData, RoadGraph,
  SpawnPoint,
} from '../contracts';
import { createMaterialLibrary, type MaterialLibraryExt } from './materials';
import { createProps, type CreatePropsOptions } from './props';
import { createLandmarks, type CreateLandmarksOptions } from './landmarks';
import { LAYER_REFLECT } from '../config';
import { ShaderWarmer, type WarmUpStage } from './warmup';
import { StreamedColliders } from './colliderStream';
import type { LandmarksSystem, PropsSystem } from './props/types';
import { parseGlb, type GlbPrimitive } from './loaders/glb';
import { loadDataBuffer, loadDataJson, loadDataJsonOptional, runPool, yieldToBrowser } from './loaders/fetch';
import { addBoundaryWalls, addBuildingCollision, addGroundCollision, parseCollisionBin } from './loaders/collision';
import { HeightGrid, SURFACE_CLASSES, surfaceId } from './heightGrid';
import {
  CityCuller, chunkIndexOf, createCityMesh, groundSuperChunk, mergePrimitives, mergeToPrimitive, splitByGrid, type CityCategory,
} from './cityMeshes';
import type { LoadWorldOptions, WorldExt, WorldStats } from './types';

export type { LoadWorldOptions, WorldExt, WorldStats } from './types';

/** Ground materials that are not walkable surfaces (left out of the height grid). */
const NOT_A_SURFACE = new Set<string>(['bridge_rail', 'bridge_side', 'quay', 'road_marking']);
/** Ground materials that cast sun shadows (parapets and railings onto the decks). */
const GROUND_SHADOW_CASTERS = new Set<string>(['bridge_side']);
/**
 * Ground materials drawn in the planar water reflection (LAYER_REFLECT). The mirrored camera
 * sits below the water plane, so upward-facing surfaces (streets, squares, grass) show their
 * back faces and never appear in the reflection: only the near-vertical ground parts matter.
 */
const REFLECT_GROUND = new Set<string>(['quay', 'quay_cap', 'bridge_side', 'bridge_rail', 'bridge_deck', 'curb']);
/** Cell sizes (m) for splitting the backdrop ring and the water into frustum-cullable parts. */
const BACKDROP_CELL = 600;
const WATER_CELL = 400;
/** Extra margin of the height grid around the playable rect (full-detail ground is +60 m). */
const GRID_MARGIN = 70;

type JobCategory = CityCategory | 'water';
interface Job { file: string; category: JobCategory }
interface Piece { prim: GlbPrimitive; file: string }

const LABELS: Record<JobCategory, string> = {
  ground: 'Straten en grachten laden',
  water: 'Straten en grachten laden',
  groundBackdrop: 'Omgeving laden',
  building: 'Gebouwen laden',
  backdrop: 'Omgeving laden',
};

/** Monotonic progress reporter. */
class Progress {
  private value = 0;
  constructor(private readonly fn?: ProgressFn) {}
  set(f: number, label: string): void {
    this.value = Math.max(this.value, Math.min(1, f));
    try {
      this.fn?.(this.value, label);
    } catch (e) {
      console.warn('[world] onProgress faalde', e);
    }
  }
}

export async function loadWorld(
  engine: Engine,
  physics: PhysicsWorld | null,
  onProgress?: ProgressFn,
  options: LoadWorldOptions = {},
): Promise<WorldExt> {
  const opt = {
    buildings: options.buildings ?? true,
    backdrop: options.backdrop ?? true,
    props: options.props ?? true,
    landmarks: options.landmarks ?? true,
    collision: options.collision ?? true,
    compileShaders: options.compileShaders ?? true,
    sb: Math.max(1, Math.round(options.superChunk?.building ?? 2)),
    sg: Math.max(1, Math.round(options.superChunk?.ground ?? 4)),
    freeCpu: options.freeCpuGeometry ?? true,
    concurrency: Math.max(1, options.concurrency ?? 8),
    cell: options.gridCell ?? 0.5,
  };
  const t0 = performance.now();
  const timings: Record<string, number> = {};
  let tMark = t0;
  const lap = (k: string): void => {
    const n = performance.now();
    timings[k] = Math.round(n - tMark);
    tMark = n;
  };
  const prog = new Progress(onProgress);
  prog.set(0, 'Kaartgegevens laden');

  // ------------------------------------------------------------------ metadata + materials
  const matsP = createMaterialLibrary(engine);
  matsP.catch(() => undefined); // awaited below; avoid an unhandled rejection in between
  const [osmMeta, bagMeta, roadGraph, propsData, map2d, footprints] = await Promise.all([
    loadDataJson<OsmMeta>('osm-meta.json'),
    loadDataJson<BagMeta>('bag-meta.json'),
    loadDataJson<RoadGraph>('roadgraph.json'),
    loadDataJson<PropsData>('props.json'),
    loadDataJsonOptional<Map2D>('map2d.json'),
    loadDataJsonOptional<Footprints>('footprints.json'),
  ]);
  lap('metadata');
  prog.set(0.03, 'Materialen laden');

  // collision files load alongside the GLBs
  const wantCollision = !!physics && opt.collision;
  const collisionP = wantCollision
    ? Promise.all([loadDataBuffer('collision_ground.bin'), loadDataBuffer('collision_buildings.bin')])
    : null;
  collisionP?.catch(() => undefined);

  // ------------------------------------------------------------------ chunk GLBs
  const jobs: Job[] = [];
  for (const f of osmMeta.groundFiles) {
    if (/water/.test(f)) jobs.push({ file: f, category: 'water' });
    else if (/backdrop/.test(f)) {
      if (opt.backdrop) jobs.push({ file: f, category: 'groundBackdrop' });
    } else jobs.push({ file: f, category: 'ground' });
  }
  if (opt.buildings) for (const f of bagMeta.buildingFiles) jobs.push({ file: f.file, category: 'building' });
  if (opt.backdrop) for (const f of bagMeta.backdropFiles) jobs.push({ file: f, category: 'backdrop' });

  const pieces: Record<JobCategory, Piece[]> = { ground: [], water: [], groundBackdrop: [], building: [], backdrop: [] };
  let done = 0;
  let failed = 0;
  let bytes = 0;
  await runPool(
    jobs,
    opt.concurrency,
    async (job) => {
      const buf = await loadDataBuffer(job.file);
      bytes += buf.byteLength;
      for (const prim of parseGlb(buf, job.file)) pieces[job.category].push({ prim, file: job.file });
      done++;
      const next = jobs[Math.min(jobs.length - 1, done)];
      prog.set(0.04 + 0.52 * (done / jobs.length), LABELS[next.category]);
    },
    (job, err) => {
      failed++;
      console.error(`[world] ${job.file} kon niet geladen worden:`, err);
    },
  );
  lap('chunks');

  const lib = (await matsP) as MaterialLibraryExt;
  lap('materials');

  // ------------------------------------------------------------------ height / surface grid
  prog.set(0.57, 'Hoogtekaart berekenen');
  await yieldToBrowser();
  const pr = osmMeta.playable;
  const grid = new HeightGrid(
    { minX: pr.minX - GRID_MARGIN, minZ: pr.minZ - GRID_MARGIN, maxX: pr.maxX + GRID_MARGIN, maxZ: pr.maxZ + GRID_MARGIN },
    opt.cell,
  );
  for (const { prim } of pieces.ground) {
    if (!NOT_A_SURFACE.has(prim.material)) grid.rasterize(prim.position, prim.index, surfaceId(prim.material));
  }
  for (const { prim } of pieces.water) grid.rasterize(prim.position, prim.index, surfaceId('water'));
  let buildingCells = footprints ? grid.rasterizeFootprints(footprints.rings) : 0;
  // Hero buildings the BAG pipeline excluded (Waag, Accijnstoren, Molen: rendered by landmarks) are
  // not in footprints.json; add their rings (bag-meta excludedInfo + osm-meta landmark footprints)
  // so isInsideBuilding() also covers them.
  buildingCells += grid.rasterizeFootprints(heroFootprints(bagMeta, osmMeta));
  lap('heightGrid');

  // ------------------------------------------------------------------ meshes
  prog.set(0.62, 'Stad opbouwen');
  await yieldToBrowser();
  const root = new THREE.Group();
  root.name = 'world';
  const cityRoot = new THREE.Group();
  cityRoot.name = 'city';
  cityRoot.matrixAutoUpdate = false;
  root.add(cityRoot);
  const culler = new CityCuller();
  const waterMeshes: THREE.Mesh[] = [];

  const groups = new Map<string, { cls: string; category: CityCategory; list: GlbPrimitive[] }>();
  const addToGroup = (key: string, cls: string, category: CityCategory, prim: GlbPrimitive): void => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { cls, category, list: [] }));
    g.list.push(prim);
  };
  const superKey = (file: string, s: number): string => {
    const ij = chunkIndexOf(file);
    return ij ? `${Math.floor(ij.i / s)}_${Math.floor(ij.j / s)}` : file;
  };
  for (const { prim, file } of pieces.ground) addToGroup(`g:${prim.material}:${superKey(file, groundSuperChunk(prim.material, opt.sg))}`, prim.material, 'ground', prim);
  for (const { prim, file } of pieces.building) addToGroup(`b:${prim.material}:${superKey(file, opt.sb)}`, prim.material, 'building', prim);
  for (const { prim } of pieces.groundBackdrop) addToGroup(`gb:${prim.material}`, prim.material, 'groundBackdrop', prim);
  // the backdrop ring files are huge slabs: cut them into cells so the frustum culls them
  for (const { prim } of pieces.backdrop) {
    for (const [cell, part] of splitByGrid(prim, BACKDROP_CELL)) addToGroup(`bd:${prim.material}:${cell}`, prim.material, 'backdrop', part);
  }

  let built = 0;
  for (const [key, g] of groups) {
    const geo = mergePrimitives(g.list);
    const cls = g.cls as MaterialClass;
    const isBuilding = g.category === 'building';
    const cm = createCityMesh(geo, lib.get(cls), cls, g.category, key, {
      // flat roofs face the sun: the shadow pass renders back faces only, so they never cast
      castShadow: (isBuilding && cls !== 'roof_flat') || (g.category === 'ground' && GROUND_SHADOW_CASTERS.has(cls)),
      receiveShadow: true,
      freeCpu: opt.freeCpu,
    });
    // buildings first: at street level they hide most of the ground behind them (early-z), and
    // within the wall material three sorts the super-chunks front to back
    cm.mesh.renderOrder = isBuilding ? -1 : 0;
    // planar water reflection: buildings, the backdrop ring and the vertical ground parts
    if (isBuilding || g.category === 'backdrop' || (g.category === 'ground' && REFLECT_GROUND.has(cls))) {
      cm.mesh.layers.enable(LAYER_REFLECT);
    }
    cityRoot.add(cm.mesh);
    culler.add(cm);
    if (++built % 40 === 0) {
      prog.set(0.62 + 0.08 * (built / groups.size), 'Stad opbouwen');
      await yieldToBrowser();
    }
  }
  // water through the material library (animated, reflections per quality), in tiles: the
  // planar reflection pass only runs when a water tile is inside the view frustum
  if (pieces.water.length) {
    const merged = mergeToPrimitive(pieces.water.map((p) => p.prim));
    for (const [cell, part] of splitByGrid(merged, WATER_CELL)) {
      const geo = mergePrimitives([part]);
      const water = lib.createWater(geo);
      water.name = `water:${cell}`;
      water.matrixAutoUpdate = false;
      water.updateMatrix();
      root.add(water);
      waterMeshes.push(water);
    }
  }
  const triangles = {
    ground: sumTris(pieces.ground), building: sumTris(pieces.building),
    backdrop: sumTris(pieces.backdrop) + sumTris(pieces.groundBackdrop), water: sumTris(pieces.water),
  };
  // drop the parsed chunk data (the merged geometries hold their own copies)
  for (const k of Object.keys(pieces) as JobCategory[]) pieces[k].length = 0;
  groups.clear();
  lap('meshes');

  // ------------------------------------------------------------------ physics
  if (wantCollision && physics && collisionP) {
    prog.set(0.71, 'Botsingsmodel opbouwen');
    await yieldToBrowser();
    try {
      const [gbuf, bbuf] = await collisionP;
      const gstats = addGroundCollision(physics, parseCollisionBin(gbuf), grid);
      addBuildingCollision(physics, parseCollisionBin(bbuf));
      addBoundaryWalls(physics, osmMeta.playable);
      console.info('[world] botsing ondergrond (driehoeken per oppervlak):', JSON.stringify(gstats.tags));
    } catch (e) {
      console.error('[world] botsingsmodel kon niet geladen worden:', e);
    }
    lap('collision');
  }

  // ------------------------------------------------------------------ props + landmarks
  const heightAt: HeightFn = (x, z) => grid.heightAt(x, z, 0);
  // the ~13 000 prop colliders are streamed in around the camera (Rapier pays per collider per step)
  const propColliders = wantCollision && physics ? new StreamedColliders(physics) : null;
  let propsSystem: PropsSystem | null = null;
  let landmarks: LandmarksSystem | null = null;
  if (opt.props) {
    prog.set(0.78, 'Bomen planten en fietsen parkeren');
    await yieldToBrowser();
    try {
      // props.json has no y: the props stand on the street-level height grid
      const propOpts: CreatePropsOptions = {
        map2d, roadGraph, boatRect: osmMeta.playable, heightAt,
      };
      propsSystem = createProps(engine, propColliders ?? physics, lib, propsData, propOpts);
      root.add(propsSystem.root);
    } catch (e) {
      console.error('[world] props konden niet gemaakt worden:', e);
    }
    lap('props');
  }
  if (opt.landmarks) {
    prog.set(0.86, 'Molen en Kaasmarkt bouwen');
    await yieldToBrowser();
    try {
      // heightAt: forward compatible (the landmarks owner adds ground-height support)
      const lmOpts: CreateLandmarksOptions & { heightAt?: HeightFn } = { footprints, map2d, roadGraph, heightAt };
      landmarks = createLandmarks(engine, physics, lib, osmMeta, lmOpts);
      root.add(landmarks.root);
    } catch (e) {
      console.error('[world] bezienswaardigheden konden niet gemaakt worden:', e);
    }
    lap('landmarks');
  }
  prog.set(0.9, 'Boten aanmeren');
  await Promise.all([propsSystem?.ready, landmarks?.ready].map((p) => p?.catch((e: unknown) => console.error('[world]', e))));
  lap('propsReady');

  // ------------------------------------------------------------------ scene + shader warm-up
  engine.scene.add(root);
  culler.applyQuality(engine.quality);
  const warmer = new ShaderWarmer(engine);
  const warmed = new Set<THREE.Object3D>();
  if (opt.compileShaders) {
    // Staged warm-up, one subtree at a time with its own time limit: a slow (or hung) driver
    // compile in one part never blocks loading, and the other parts are still compiled.
    // Then one real frame compiles what compile() cannot see (shadow depth variants, post passes).
    const stages: WarmUpStage[] = [{ name: 'city', objects: [cityRoot, ...waterMeshes], timeoutMs: 12000 }];
    if (propsSystem) stages.push({ name: 'props', objects: [propsSystem.root], timeoutMs: 8000 });
    if (landmarks) stages.push({ name: 'landmarks', objects: [landmarks.root], timeoutMs: 8000 });
    for (const st of stages) for (const o of st.objects) warmed.add(o);
    const others = root.children.filter((c) => !warmed.has(c));
    if (others.length) stages.push({ name: 'overig', objects: others, timeoutMs: 6000 });
    for (const o of others) warmed.add(o);
    const results = await warmer.run(stages, (i) => prog.set(0.93 + (0.05 * i) / stages.length, 'Shaders voorbereiden'));
    for (const r of results) timings[`shaders_${r.name}`] = r.ms;
    tMark = performance.now();
    culler.update(engine.camera.position, true);
    try {
      engine.renderOnce();
    } catch (e) {
      console.warn('[world] eerste frame mislukt', e);
    }
    lap('shaders_frame');
    console.info(`[world] shaders: ${results.map((r) => `${r.name} ${r.ms} ms ${r.programs} programma's${r.ok ? '' : ' (time-out)'}`).join(', ')}, eerste frame ${timings.shaders_frame} ms`);
  } else {
    for (const c of root.children) warmed.add(c);
  }
  culler.update(engine.camera.position, true);
  propColliders?.update(engine.camera.position.x, engine.camera.position.z, true);
  const unsubQuality = engine.onQualityChange((q) => culler.applyQuality(q));

  const loadMs = Math.round(performance.now() - t0);
  console.info(
    `[world] stad geladen in ${(loadMs / 1000).toFixed(1)} s: ${done} bestanden (${(bytes / 1048576).toFixed(0)} MB, ${failed} mislukt), ` +
      `${buildingCells} gebouwcellen, ` +
      `${culler.list.length} meshes, driehoeken ${JSON.stringify(triangles)}, fasen (ms) ${JSON.stringify(timings)}`,
  );
  prog.set(1, 'Klaar');

  const waterId = surfaceId('water');
  const fallbackSpawn: SpawnPoint = { id: 'waag', name: 'De Waag', x: 48.5, z: 6.5, heading: 0 };
  let disposed = false;
  // Objects added to world.root after loading (traffic) get a background shader warm-up as soon
  // as they are added: 'childadded' fires synchronously, the microtask runs once the caller's
  // synchronous setup is done (subtree complete) and before the next frame renders them.
  let lateQueued = false;
  const warmLateChildren = (): void => {
    lateQueued = false;
    if (disposed) return;
    const fresh = root.children.filter((c) => !warmed.has(c));
    if (!fresh.length) return;
    const t = performance.now();
    const p0 = engine.renderer.info.programs?.length ?? 0;
    void world.warmUp(fresh, 15000).then((ok) => {
      const n = (engine.renderer.info.programs?.length ?? 0) - p0;
      console.info(`[world] shaders van ${fresh.map((c) => c.name || c.type).join(', ')} ${ok ? 'klaar' : 'niet klaar'} na ${Math.round(performance.now() - t)} ms (${n} nieuwe programma's)`);
    });
  };

  const onChildAdded = (): void => {
    if (lateQueued) return;
    lateQueued = true;
    queueMicrotask(warmLateChildren);
  };

  const world: WorldExt = {
    root,
    osmMeta,
    bagMeta,
    roadGraph,
    props: propsData,
    materials: lib,
    map2d,
    footprints,
    propsSystem,
    landmarks,
    heightGrid: grid,
    staticColliders: propColliders,
    timings,
    loadMs,
    update(dt: number, cameraPos: THREE.Vector3): void {
      if (disposed) return;
      culler.update(cameraPos);
      propColliders?.update(cameraPos.x, cameraPos.z);
      propsSystem?.update(dt, cameraPos);
      landmarks?.update(dt, cameraPos);
    },
    heightAt(x: number, z: number): number {
      return grid.heightAt(x, z, 0);
    },
    surfaceAt(x: number, z: number): MaterialClass | null {
      return SURFACE_CLASSES[grid.surfaceIdAt(x, z)] ?? null;
    },
    isWater(x: number, z: number): boolean {
      return grid.surfaceIdAt(x, z) === waterId;
    },
    isInsideBuilding(x: number, z: number): boolean {
      return grid.insideBuilding(x, z);
    },
    warmUp(objects: readonly THREE.Object3D[], timeoutMs = 10000): Promise<boolean> {
      for (const o of objects) warmed.add(o);
      return warmer.compile(objects, timeoutMs).catch((e: unknown) => {
        console.warn('[world] shaders vooraf compileren mislukt', e);
        return false;
      });
    },
    setNight(amount: number): void {
      const a = Math.min(1, Math.max(0, amount));
      lib.setNight?.(a);
      propsSystem?.setLightsOn(a);
    },
    spawn(id?: string): SpawnPoint {
      const list = osmMeta.spawnPoints ?? [];
      return (id ? list.find((s) => s.id === id) : undefined) ?? list[0] ?? fallbackSpawn;
    },
    stats(): WorldStats {
      const ps = propsSystem?.stats();
      const ls = landmarks?.stats();
      let instances = 0;
      if (ps) for (const k in ps.instances) instances += ps.instances[k];
      return {
        meshes: culler.list.length,
        visibleMeshes: culler.visibleCount,
        visibleTriangles: culler.visibleTriangles,
        props: ps ? { drawCalls: ps.drawCalls, triangles: ps.triangles, instances } : null,
        landmarks: ls ? { drawCalls: ls.drawCalls, triangles: ls.triangles } : null,
        colliders: propColliders ? { total: propColliders.total, active: propColliders.active } : null,
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubQuality();
      root.removeEventListener('childadded', onChildAdded);
      warmer.dispose();
      propColliders?.dispose();
      root.parent?.remove(root);
      for (const m of culler.list) m.mesh.geometry.dispose();
      for (const w of waterMeshes) w.geometry.dispose();
      propsSystem?.dispose();
      landmarks?.dispose();
      lib.dispose();
      // static colliders stay in the physics world (the contract has no removal API);
      // dispose the physics world together with the world.
    },
  };
  if (opt.compileShaders) {
    root.addEventListener('childadded', onChildAdded);
  }
  return world;
}

type HeightFn = (x: number, z: number) => number;
type Ring = readonly (readonly [number, number])[];

/**
 * Footprints of buildings that are not in footprints.json because a landmark replaces them:
 * bag-meta.json `excludedInfo[].footprint` (pipeline extra, not in the BagMeta contract) plus
 * osm-meta landmark footprints. Malformed entries are skipped.
 */
function heroFootprints(bagMeta: BagMeta, osmMeta: OsmMeta): Ring[] {
  const out: Ring[] = [];
  const add = (fp: unknown): void => {
    if (!Array.isArray(fp) || fp.length < 3) return;
    for (const p of fp) {
      if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    }
    out.push(fp as Ring);
  };
  const excluded = (bagMeta as BagMeta & { excludedInfo?: { footprint?: unknown }[] }).excludedInfo;
  if (Array.isArray(excluded)) for (const e of excluded) add(e?.footprint);
  for (const l of osmMeta.landmarks ?? []) add(l.footprint);
  return out;
}

function sumTris(list: readonly Piece[]): number {
  let n = 0;
  for (const p of list) n += p.prim.index.length / 3;
  return n;
}
