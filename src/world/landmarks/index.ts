// Landmarks module: the hero buildings De Waag and the Accijnstoren (hand-made models replacing
// their BAG shells), the Molen van Piet (windmill with turning sails) and the Kaasmarkt (cheese
// market with draagberries and Alkmaar flags) next to De Waag.
//
// createLandmarks(engine, physics, materials, meta[, options]) -> LandmarksSystem (props/types.ts)
// The mill is built synchronously; the Kaasmarkt needs footprints.json / map2d.json /
// roadgraph.json to find the open square and is added when `ready` resolves.
import * as THREE from 'three';
import type { Engine, Footprints, Landmark, MaterialLibrary, Map2D, OsmMeta, PhysicsWorld, RoadGraph } from '../../contracts';
import { DATA_URL } from '../../config';
import type { LandmarksSystem, StaticColliderSink } from '../props/types';
import { PropBatch, type CullContext } from '../props/util/batch';
import { Colliders } from '../props/util/physicsStub';
import { propUniforms } from '../props/util/propMaterial';
import { buildMolen, MOLEN, type MolenObject } from './molen';
import { buildWaag, WAAG } from './waag';
import { buildAccijnstoren, ACCIJNSTOREN } from './accijnstoren';
import type { HeroBuildingModel } from './hero';
import { groundMin, safeGround, type GroundFn } from '../props/util/ground';
import { MARKET_LAYOUTS, buildKaasmarkt, marketSize } from './kaasmarkt';
import { findOpenSite } from './siteFinder';

export type { LandmarksSystem } from '../props/types';
export { MOLEN } from './molen';

export interface CreateLandmarksOptions {
  /** BAG footprints (to find the open Waagplein); fetched from public/data when omitted. */
  footprints?: Footprints | null;
  map2d?: Map2D | null;
  roadGraph?: RoadGraph | null;
  /** Ground height (world.heightAt): base y of every model and collider. Default: y = 0. */
  heightAt?: GroundFn | null;
  /** Build the hero buildings (De Waag, Accijnstoren). Default true. */
  heroes?: boolean;
}

interface HeroPlacement { x: number; z: number; rotation: number; ring: [number, number][] }

/** Fallback positions (local metres) from OpenStreetMap, used if osm-meta lacks the landmark. */
const FALLBACK: Record<string, { x: number; z: number }> = {
  molen_van_piet: { x: -564.6, z: 146.6 },
  waag: { x: 0, z: 0 },
};

/** Real Waag footprint (OSM way 51089999, simplified) used when meta has none. */
const WAAG_RING: [number, number][] = [[-17.1, -1.5], [-9.9, -14.4], [16.5, 3.2], [10.1, 14.0], [-17.1, -1.5]];

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

function findLandmark(meta: OsmMeta, id: string): Landmark | null {
  return meta.landmarks?.find((l) => l.id === id) ?? null;
}

export function createLandmarks(
  engine: Engine,
  physics: PhysicsWorld | StaticColliderSink | null,
  materials: MaterialLibrary | null,
  meta: OsmMeta,
  options: CreateLandmarksOptions = {},
): LandmarksSystem {
  const root = new THREE.Group();
  root.name = 'landmarks';
  const colliders = new Colliders(physics);
  const batches: PropBatch[] = [];
  const ground = safeGround(options.heightAt);
  let molen: MolenObject | null = null;

  // ---------------------------------------------------------------- hero buildings
  const heroes: HeroBuildingModel[] = [];
  const heroObjects: Record<string, THREE.Object3D> = {};
  const placeHero = (id: string, build: () => HeroBuildingModel, at: HeroPlacement): void => {
    try {
      const model = build();
      const c = Math.cos(at.rotation), s = Math.sin(at.rotation);
      // THREE rotation.y: local (x, z) -> world (x cos + z sin, -x sin + z cos)
      const toWorld = (lx: number, lz: number): [number, number] => [at.x + lx * c + lz * s, at.z - lx * s + lz * c];
      const ring = at.ring.map(([a, b]) => toWorld(a, b));
      const y0 = groundMin(ground, ring, at.x, at.z);
      model.group.position.set(at.x, y0, at.z);
      model.group.rotation.y = at.rotation;
      model.group.updateMatrixWorld(true);
      model.group.matrixAutoUpdate = false;
      root.add(model.group);
      for (const b of model.colliders) {
        const [wx, wz] = toWorld(b.c.x, b.c.z);
        colliders.box(new THREE.Vector3(wx, y0 + b.c.y, wz), b.h, at.rotation, id);
      }
      heroes.push(model);
      heroObjects[id] = model.group;
    } catch (e) {
      console.error(`[landmarks] ${id} kon niet gebouwd worden:`, e);
    }
  };
  if (options.heroes !== false) {
    placeHero('waag', () => buildWaag(materials), WAAG);
    placeHero('accijnstoren', () => buildAccijnstoren(materials), ACCIJNSTOREN);
  }

  // ---------------------------------------------------------------- Molen van Piet
  // The mill always exists in Alkmaar: fall back to its OSM position if osm-meta lacks it.
  const ml = findLandmark(meta, 'molen_van_piet') ?? findLandmark(meta, 'molen');
  {
    const p = ml ?? FALLBACK.molen_van_piet;
    molen = buildMolen(materials);
    const r = MOLEN.baseRadius;
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) ring.push([p.x + Math.sin((k * Math.PI) / 4) * r, p.z + Math.cos((k * Math.PI) / 4) * r]);
    const my = groundMin(ground, ring, p.x, p.z);
    molen.group.position.set(p.x, my, p.z);
    // The cap turns into the wind: the sails face where the (south-westerly) wind comes from.
    // (osm-meta's rotation for a round mill is only the footprint orientation, so it is ignored.)
    const w = propUniforms.uWindDir.value;
    molen.group.rotation.y = Math.atan2(-w.x, -w.y);
    molen.group.updateMatrixWorld(true);
    root.add(molen.group);
    colliders.cylinder(p.x, p.z, MOLEN.baseRadius + 0.1, MOLEN.bodyHeight, my, 'molen');
  }

  // ---------------------------------------------------------------- Kaasmarkt (async: site search)
  let cheeseCount = 0;
  let marketSite: ReturnType<typeof findOpenSite> | null = null;
  let forceCull = true;
  // De Waag is the world origin by definition (ARCHITECTURE section 2)
  const waag: Landmark = findLandmark(meta, 'waag') ?? { id: 'waag', name: 'De Waag', ...FALLBACK.waag };
  const ready = (async () => {
    const [footprints, map2d, roads] = await Promise.all([
      options.footprints !== undefined ? options.footprints : fetchJson<Footprints>(`${DATA_URL}footprints.json`),
      options.map2d !== undefined ? options.map2d : fetchJson<Map2D>(`${DATA_URL}map2d.json`),
      options.roadGraph !== undefined ? options.roadGraph : fetchJson<RoadGraph>(`${DATA_URL}roadgraph.json`),
    ]);
    const ownRing = waag.footprint && waag.footprint.length > 2 ? waag.footprint : Math.hypot(waag.x, waag.z) < 5 ? WAAG_RING : null;
    // try the biggest market layout that fits on the open square next to the Waag
    let site = null as ReturnType<typeof findOpenSite> | null;
    let layout = MARKET_LAYOUTS[MARKET_LAYOUTS.length - 1];
    for (const l of MARKET_LAYOUTS) {
      const [length, width] = marketSize(l);
      const s = findOpenSite({ cx: waag.x, cz: waag.z, ownRing, footprints, map2d, roads, length, width, margin: 1.0, minDist: 10, maxDist: 60 });
      if (s.verified || l === MARKET_LAYOUTS[MARKET_LAYOUTS.length - 1]) {
        site = s;
        layout = l;
        break;
      }
    }
    if (!site) return;
    if (!site.verified) console.warn('[landmarks] Kaasmarkt: geen vrije plek gevonden in de data, standaardpositie gebruikt');
    marketSite = site;
    // the whole market stands on the square's height at its centre
    const dy = ground(site.x, site.z);
    const km = buildKaasmarkt(site, colliders.lifted(dy), propUniforms.uWindDir.value, layout);
    cheeseCount = km.cheeses;
    km.group.position.y += dy;
    km.group.updateMatrixWorld(true);
    root.add(km.group);
    for (const b of km.batches) {
      b.finalize();
      b.group.position.y += dy;
      b.group.updateMatrix();
      b.group.updateMatrixWorld(true);
      root.add(b.group);
      batches.push(b);
    }
    forceCull = true;
  })().catch((e) => console.warn('[landmarks] Kaasmarkt overgeslagen:', e));

  // ---------------------------------------------------------------- per-frame
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const ctx: CullContext = { camPos, camDir, frustum, lodScale: 1, density: 1, force: true };
  const LOD_SCALE: Record<string, number> = { laag: 0.6, midden: 0.8, hoog: 1, ultra: 1.35 };

  function update(dt: number, _cam: THREE.Vector3): void {
    propUniforms.uTime.value = performance.now() / 1000;
    molen?.update(dt);
    if (!batches.length) return;
    const cam = engine.camera;
    cam.updateMatrixWorld();
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    camPos.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(camDir);
    ctx.lodScale = LOD_SCALE[engine.quality.level] ?? 1;
    ctx.force = forceCull;
    forceCull = false;
    for (const b of batches) b.update(ctx);
  }

  return {
    root,
    update,
    ready: ready.then(() => undefined),
    molen: molen?.group ?? null,
    heroes: heroObjects,
    kaasmarktSite: () => marketSite,
    stats() {
      let drawCalls = molen ? 7 : 0;
      let triangles = molen?.triangles ?? 0;
      for (const h of heroes) { drawCalls += h.drawCalls; triangles += h.triangles; }
      for (const b of batches) { drawCalls += b.drawCalls(); triangles += b.triangles(); }
      return { drawCalls, triangles, cheeses: cheeseCount };
    },
    dispose() {
      molen?.dispose();
      for (const h of heroes) h.dispose();
      for (const b of batches) b.dispose();
      root.clear();
    },
  };
}
