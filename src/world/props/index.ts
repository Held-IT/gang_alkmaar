// Props module: trees, street lights, bollards, benches, bins, bike racks, parked bicycles,
// traffic signs, street-name signs, traffic lights, moored boats and café terraces.
//
// createProps(engine, physics, materials, props[, options]) -> PropsSystem (see types.ts)
// Everything is instanced (PropBatch: per-cell CPU culling + distance LOD), static colliders are
// registered once. Boats need map2d.json / roadgraph.json and are added asynchronously.
import * as THREE from 'three';
import type { Engine, MaterialLibrary, Map2D, PhysicsWorld, PropsData, RoadGraph } from '../../contracts';
import { ASSETS_URL, DATA_URL } from '../../config';
import type { PropsStats, PropsSystem, StaticColliderSink } from './types';
import { PropBatch, syncShadowFrustums, type CullContext } from './util/batch';
import { Colliders } from './util/physicsStub';
import { propUniforms } from './util/propMaterial';
import { Rng, hash2 } from './util/rng';
import { getTreeAssets } from './trees';
import { buildStreetProps } from './street';
import { buildBikes } from './bikes';
import { buildSigns } from './signs';
import { buildBoats } from './boats';
import { buildTerraces, type TerraceData } from './terraces';
import { safeGround, type GroundFn } from './util/ground';
import { makeNearWater } from './util/water';

export type { PropsSystem, PropsStats, LandmarksSystem } from './types';

export interface CreatePropsOptions {
  /** Water polygons for boats; fetched from public/data/map2d.json when omitted. */
  map2d?: Map2D | null;
  /** Bridges to keep clear of boats; fetched from public/data/roadgraph.json when omitted. */
  roadGraph?: RoadGraph | null;
  /** Restrict boats to this rect (default: osm-meta playable rect if fetchable, else all). */
  boatRect?: { minX: number; minZ: number; maxX: number; maxZ: number } | null;
  /** Ground height (m) under a prop; props.json has no y. Default: everything on y = 0. */
  heightAt?: GroundFn | null;
  /** Skip the boats entirely. */
  noBoats?: boolean;
  /** Skip the café terraces (public/assets/props/terraces.json). */
  noTerraces?: boolean;
  /** Canal-side trees and boats on the water reflection layer (LAYER_REFLECT). Default true. */
  reflectTrees?: boolean;
  reflectBoats?: boolean;
}

const LOD_SCALE: Record<string, number> = { laag: 0.6, midden: 0.8, hoog: 1, ultra: 1.35 };

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function createProps(
  engine: Engine,
  physics: PhysicsWorld | StaticColliderSink | null,
  materials: MaterialLibrary | null,
  props: PropsData,
  options: CreatePropsOptions = {},
): PropsSystem {
  const root = new THREE.Group();
  root.name = 'props';
  const colliders = new Colliders(physics);
  const batches: PropBatch[] = [];
  const anisotropy = Math.min(engine.quality.anisotropy || 4, engine.renderer.capabilities.getMaxAnisotropy());

  const ground = safeGround(options.heightAt);
  const tStart = performance.now();
  const timing: Record<string, number> = {};
  let tMark = tStart;
  const lap = (k: string) => { const n = performance.now(); timing[k] = Math.round(n - tMark); tMark = n; };
  // ---------------------------------------------------------------- trees
  const trees = getTreeAssets(engine.renderer, anisotropy);
  lap('boomModellen');
  // canal-side trees (crown within ~9 m of a canal edge) get their own batches on the planar
  // water reflection layer; all other trees stay off it (performance)
  const mkTrees = (waterside: boolean) =>
    trees.variants.map(
      (v) =>
        new PropBatch({
          name: `boom_${v.spec.name}${waterside ? '_waterkant' : ''}`,
          lods: v.lods,
          colors: true,
          cellSize: 64,
          margin: 18, // shadows and sway reach outside the crown
          moveThreshold: 2,
          reflect: waterside && options.reflectTrees !== false,
        }),
    );
  const treeBatches = mkTrees(false);
  const waterBatches = mkTrees(true);
  const nearWater = makeNearWater(options.map2d, 9);
  let watersideTrees = 0;
  const tint = new THREE.Color();
  for (const t of props.trees ?? []) {
    const [x, z, hRaw, kRaw] = t;
    const kind = kRaw === 1 || kRaw === 2 ? kRaw : 0;
    const vars = trees.byKind[kind];
    const h0 = hash2(x, z, 1);
    const v = vars[Math.floor(h0 * vars.length) % vars.length];
    const defH = kind === 0 ? 13 : kind === 1 ? 6 : 10;
    const height = hRaw > 2 && hRaw < 40 ? hRaw : defH * (0.85 + 0.3 * hash2(x, z, 2));
    const s = THREE.MathUtils.clamp(height / v.spec.height, 0.45, 1.9);
    const rng = new Rng(Math.floor(h0 * 1e9));
    // leaf tint: a little lighter/darker/yellower per tree
    tint.setHSL(0.24 + rng.range(-0.025, 0.02), rng.range(0.0, 0.25), 0.5);
    const bright = rng.range(0.82, 1.1);
    tint.setRGB(bright * (1 + rng.range(-0.04, 0.08)), bright, bright * (1 + rng.range(-0.1, 0.02)));
    const sxz = s * rng.range(0.9, 1.1);
    const wet = nearWater(x, z);
    if (wet) watersideTrees++;
    const idx = (wet ? waterBatches : treeBatches)[trees.variants.indexOf(v)];
    const gy = ground(x, z);
    idx.add(x, gy, z, rng.range(0, Math.PI * 2), new THREE.Vector3(sxz, s, sxz), tint);
    colliders.cylinder(x, z, Math.max(0.15, v.spec.trunkRadius * s * 1.1), 3, gy, 'tree');
  }
  for (const b of [...treeBatches, ...waterBatches]) if (b.count) batches.push(b);
  lap('bomen');

  // ---------------------------------------------------------------- street furniture etc.
  const street = buildStreetProps(props, colliders, anisotropy, ground);
  batches.push(...street);
  lap('straatmeubilair');
  const bikes = buildBikes(props, anisotropy, ground);
  batches.push(...bikes);
  lap('fietsen');
  const signs = buildSigns(props, colliders, anisotropy, ground);
  batches.push(...signs);
  lap('borden');

  for (const b of batches) {
    b.finalize();
    root.add(b.group);
  }
  lap('finalize');

  let forceCull = true;

  // ---------------------------------------------------------------- café terraces (async)
  const terracesReady = (async () => {
    if (options.noTerraces) return;
    const data = await fetchJson<TerraceData>(`${ASSETS_URL}props/terraces.json`);
    if (!data) return;
    const tt = performance.now();
    for (const b of buildTerraces(data, colliders, ground)) {
      b.finalize();
      root.add(b.group);
      batches.push(b);
    }
    timing.terrassen = Math.round(performance.now() - tt);
    forceCull = true;
  })().catch((e) => console.warn('[props] terrassen overgeslagen:', e));

  // ---------------------------------------------------------------- boats (async)
  const boatsReady = (async () => {
    if (options.noBoats) return;
    const map2d = options.map2d !== undefined ? options.map2d : await fetchJson<Map2D>(`${DATA_URL}map2d.json`);
    if (!map2d || !map2d.water?.length) return;
    const graph = options.roadGraph !== undefined ? options.roadGraph : await fetchJson<RoadGraph>(`${DATA_URL}roadgraph.json`);
    let rect = options.boatRect ?? null;
    if (options.boatRect === undefined) {
      const meta = await fetchJson<{ playable?: { minX: number; minZ: number; maxX: number; maxZ: number } }>(`${DATA_URL}osm-meta.json`);
      rect = meta?.playable ?? null;
    }
    const tb = performance.now();
    const boatBatches = buildBoats(map2d, graph, rect, colliders, options.reflectBoats !== false);
    timing.boten = Math.round(performance.now() - tb);
    for (const b of boatBatches) {
      b.finalize();
      root.add(b.group);
      batches.push(b);
    }
    forceCull = true;
  })()
    .catch((e) => console.warn('[props] boten overgeslagen:', e));
  const ready = Promise.all([terracesReady, boatsReady]).finally(() =>
    console.info('[props] opbouw (ms):', JSON.stringify(timing), `bomen aan het water: ${watersideTrees}`),
  );

  // ---------------------------------------------------------------- culling / LOD
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const camPosW = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  let density = engine.quality.propDensity ?? 1;
  let lodScale = LOD_SCALE[engine.quality.level] ?? 1;
  const offQuality = engine.onQualityChange((q) => {
    density = q.propDensity ?? 1;
    lodScale = LOD_SCALE[q.level] ?? 1;
    forceCull = true;
  });
  const ctx: CullContext = { camPos: camPosW, camDir, frustum, lodScale, density, force: true };

  function update(_dt: number, _camPos: THREE.Vector3): void {
    propUniforms.uTime.value = performance.now() / 1000;
    const sun = engine.env.sun;
    syncShadowFrustums(sun);
    propUniforms.uSunDir.value.copy(engine.env.sunDirection);
    propUniforms.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    const cam = engine.camera;
    cam.updateMatrixWorld();
    projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    camPosW.setFromMatrixPosition(cam.matrixWorld);
    cam.getWorldDirection(camDir);
    ctx.lodScale = lodScale;
    ctx.density = density;
    ctx.force = forceCull;
    forceCull = false;
    for (const b of batches) b.update(ctx);
  }

  function stats(): PropsStats {
    const instances: Record<string, number> = {};
    const visible: Record<string, number> = {};
    let drawCalls = 0, triangles = 0;
    for (const b of batches) {
      instances[b.name] = b.count;
      visible[b.name] = b.visible.reduce((a, c) => a + c, 0);
      drawCalls += b.drawCalls();
      triangles += b.triangles();
    }
    return { instances, visible, drawCalls, triangles, colliders: colliders.count };
  }

  return {
    root,
    update,
    ready: ready.then(() => undefined),
    setLightsOn(level: number) {
      propUniforms.uLampOn.value = THREE.MathUtils.clamp(level, 0, 1);
    },
    stats,
    dispose() {
      offQuality();
      for (const b of batches) b.dispose();
      root.clear();
    },
  };
}

