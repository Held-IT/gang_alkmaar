#!/usr/bin/env node
// Builds all OSM-derived game data from the cached Overpass download (run tools/osm/fetch.mjs
// first). Deterministic and offline.
//
// Usage: node tools/osm/build.mjs [--only x0,z0,x1,z1] [--skip-backdrop] [--quiet] [--props-only] [--out dir]
//   --props-only  reuse the ground locator cached by the last full build (data-raw/osm/cache) and
//                 only regenerate roadgraph.json + props.json (fast iteration on props)
//
// Outputs (public/data/): ground_<i>_<j>.glb (playable chunks), ground_backdrop.glb,
// ground_water.glb, collision_ground.bin, roadgraph.json, props.json, map2d.json, osm-meta.json
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOsm } from './lib/osm.mjs';
import { extractFeatures, inBinnenstad } from './lib/features.mjs';
import { ARCH_PLAYABLE, CHUNK, chunkI, chunkJ, chunkMinX, chunkMinZ, WATER_LEVEL, toLocal } from './lib/proj.mjs';
import { bboxOfPts, bufferPolylinePieces, discRing, normalizePoly, offsetPolyline, rectPoly } from './lib/geom.mjs';
import { union, clean, intersection, clipFailures } from './lib/clip.mjs';
import { buildDecks, deckTree, deckCrossSection } from './lib/bridges.mjs';
import { polyTree, processPlayableTile, processBackdropTile, addVault, Locator, triStats } from './lib/ground.mjs';
import { MaterialSet, CollisionBuilder, MeshBuilder } from './lib/mesh.mjs';
import { writeGlb } from './lib/glb.mjs';
import { buildMarkings } from './lib/markings.mjs';
import { buildRoadGraph } from './lib/roadgraph.mjs';
import { loadFootprintIndex } from './lib/footprints.mjs';
import { buildProps } from './lib/props.mjs';
import { buildMeta, buildMap2D } from './lib/meta.mjs';
import { buildRoadPieces } from './lib/roads.mjs';
import { railCorridorPieces, platformPieces, buildTrackGeometry, PLATFORM_H } from './lib/rail.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rawDir = resolve(root, 'data-raw/osm');
const dataDir = resolve(root, 'public/data');
const outArg = process.argv.indexOf('--out');
/** --out <dir>: write to a scratch directory instead of public/data (testing without disturbing the game) */
const outDir = outArg >= 0 ? resolve(process.argv[outArg + 1]) : dataDir;
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const only = argVal('--only')?.split(',').map(Number);
const skipBackdrop = args.includes('--skip-backdrop');
const propsOnly = args.includes('--props-only');
const cacheDir = resolve(rawDir, 'cache');
const t0 = Date.now();
const log = (...a) => console.log(`[build ${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ------------------------------------------------------------------ load
const osm = loadOsm(rawDir);
log(`loaded ${osm.ways.length} ways, ${osm.rels.length} relations, ${osm.nodes.length} tagged nodes`);
const F = extractFeatures(osm);
log(`features: water ${F.water.length}, grass ${F.grass.length}, roads ${F.roads.length}, buildings ${F.buildings.length}, squares ${F.squares.length}, parking ${F.parking.length}, bridgeAreas ${F.bridgeAreas.length}`);

// ------------------------------------------------------------------ areas
/** Singel ring + Noordhollandsch Kanaal stretch + station forecourt, + 80 m, unioned with ARCH rect. */
function computePlayable() {
  const ringNames = /^(Kennemersingel|Geestersingel|Nieuwlandersingel|Baansingel|Afgesneden Kanaalvak|Lindegracht|Schelphoekgracht)$/;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const w of osm.ways) {
    const t = w.tags;
    if (t.waterway === 'canal' && ringNames.test(t.name ?? '')) bboxOfPts(w.pts, bb);
  }
  // Noordhollandsch Kanaal: the stretch along the east side of the binnenstad
  for (const w of osm.ways) {
    if (w.tags.waterway === 'canal' && w.tags.name === 'Noordhollandsch Kanaal') {
      bboxOfPts(w.pts.filter((p) => inBinnenstadBand(p)), bb);
    }
  }
  const station = osm.nodes.find((n) => n.tags.railway === 'station' && n.tags.name === 'Alkmaar');
  if (station) bboxOfPts([[station.x - 120, station.z - 60], [station.x + 120, station.z + 60]], bb);
  const m = 80;
  const r = { minX: bb[0] - m, minZ: bb[1] - m, maxX: bb[2] + m, maxZ: bb[3] + m };
  const u = {
    minX: Math.floor(Math.min(r.minX, ARCH_PLAYABLE.minX)), minZ: Math.floor(Math.min(r.minZ, ARCH_PLAYABLE.minZ)),
    maxX: Math.ceil(Math.max(r.maxX, ARCH_PLAYABLE.maxX)), maxZ: Math.ceil(Math.max(r.maxZ, ARCH_PLAYABLE.maxZ)),
  };
  log(`singel/station rect + margin: ${JSON.stringify(r)} -> playable ${JSON.stringify(u)}`);
  return u;
}
function inBinnenstadBand(p) { return p[0] > -400 && p[0] < 700 && p[1] > -450 && p[1] < 650; }
const playable = computePlayable();
/** Full-detail ground extends a bit beyond the playable rect (matches the BAG LoD2.2 margin). */
const DETAIL_MARGIN = 60;
const detail = { minX: playable.minX - DETAIL_MARGIN, minZ: playable.minZ - DETAIL_MARGIN, maxX: playable.maxX + DETAIL_MARGIN, maxZ: playable.maxZ + DETAIL_MARGIN };
const BACKDROP_MARGIN = 900;
const fetchSW = toLocal(52.615, 4.716), fetchNE = toLocal(52.649, 4.777);
const backdrop = {
  minX: Math.max(playable.minX - BACKDROP_MARGIN, Math.ceil(fetchSW[0] + 30)),
  maxX: Math.min(playable.maxX + BACKDROP_MARGIN, Math.floor(fetchNE[0] - 30)),
  minZ: Math.max(playable.minZ - BACKDROP_MARGIN, Math.ceil(fetchNE[1] + 30)),
  maxZ: Math.min(playable.maxZ + BACKDROP_MARGIN, Math.floor(fetchSW[1] - 30)),
};
log(`backdrop rect ${JSON.stringify(backdrop)}`);

// ------------------------------------------------------------------ decks + water
const waterTree0 = polyTree(F.water);
const { decks, gapFill } = buildDecks(F.roads, F.rails, F.bridgeAreas, waterTree0, detail);
log(`decks: ${decks.length} (arched ${decks.filter((d) => d.arch).length}), gap fills ${gapFill.length}`);
const waterAll = [...F.water, ...gapFill.map((p) => ({ poly: p, bb: bboxOfPts(p[0]) }))];
const waterTree = polyTree(waterAll);
const dTree = deckTree(decks);

// ------------------------------------------------------------------ road pieces per layer
const inBox = (r, rc, m) => r.pts.some((p) => p[0] > rc.minX - m && p[0] < rc.maxX + m && p[1] > rc.minZ - m && p[1] < rc.maxZ + m);
const pRoads = F.roads.filter((r) => inBox(r, detail, 30));
const bTree = polyTree(F.buildings);
const detailRails = F.rails.filter((r) => inBox(r, detail, 30));
const RP = buildRoadPieces(pRoads, bTree, detailRails, F.squares, F.parking);
{
  // railway: gravel corridor around the tracks + raised platforms (lib/rail.mjs)
  const rec = (p) => ({ poly: p, bb: bboxOfPts(p[0]), road: null });
  const rc = railCorridorPieces(detailRails);
  RP.items.set('rail', rc.pieces.map(rec));
  const plat = platformPieces(F.platforms.filter((p) => p.bb[2] > detail.minX && p.bb[0] < detail.maxX && p.bb[3] > detail.minZ && p.bb[1] < detail.maxZ));
  RP.items.set('platform', plat.map(rec));
  log(`rail: ${detailRails.length} tracks, corridor pieces ${rc.pieces.length} (gap fillers ${rc.fillers}), platforms ${plat.length}`);
}
log(`road pieces: ${[...RP.items].map(([k, v]) => `${k} ${v.length}`).join(', ')}; flush streets ${RP.flush.size}, fillets ${RP.nFillets}`);
const layerItems = RP.items;
const laneStrips = RP.laneStrips;
const tree = (key) => polyTree(layerItems.get(key) ?? []);
const carALayer = { key: 'carA', mat: 'asphalt', tree: tree('carA') };
const lowLayers = [
  { key: 'lanes', mat: 'bikelane', tree: polyTree(laneStrips), maskLayer: carALayer },
  carALayer,
  { key: 'carK', mat: 'klinkers', tree: tree('carK') },
  { key: 'carG', mat: 'ground', tree: tree('carG') },
  { key: 'pedK', mat: 'klinkers', tree: tree('pedK') },
  { key: 'pedA', mat: 'asphalt', tree: tree('pedA') },
  { key: 'square', mat: 'square', tree: tree('square') },
  { key: 'parking', mat: 'parking', tree: tree('parking') },
];
const raisedLayers = [
  { key: 'platform', mat: 'sidewalk', tree: tree('platform'), h: PLATFORM_H },
  { key: 'path_bikelane', mat: 'bikelane', tree: tree('path_bikelane') },
  { key: 'path_klinkers', mat: 'klinkers', tree: tree('path_klinkers') },
  { key: 'path_asphalt', mat: 'asphalt', tree: tree('path_asphalt') },
  { key: 'path_ground', mat: 'ground', tree: tree('path_ground') },
  { key: 'path_sidewalk', mat: 'sidewalk', tree: tree('path_sidewalk') },
  { key: 'rail', mat: 'ground', tree: tree('rail') },
  { key: 'grass', mat: 'grass', tree: polyTree(F.grass), isArea: true },
];
const ctx = { waterTree, deckTree: dTree, lowLayers, raisedLayers, curbTree: tree('curb'), playable: detail, pavedTree: polyTree(F.paved), probe: argVal('--probe')?.split(',').map(Number) };

// ------------------------------------------------------------------ playable tiles
const coll = new CollisionBuilder();
let globalLoc = new Locator();
const groundFiles = [];
if (propsOnly) {
  if (!existsSync(resolve(cacheDir, 'locator.json'))) throw new Error('no locator cache: run a full build first');
  const meta = JSON.parse(readFileSync(resolve(cacheDir, 'locator.json'), 'utf8'));
  const tb = readFileSync(resolve(cacheDir, 'locator_tris.bin')), rb = readFileSync(resolve(cacheDir, 'locator_reg.bin'));
  globalLoc = Locator.fromCache({
    tris: new Float32Array(tb.buffer, tb.byteOffset, tb.byteLength / 4),
    reg: new Uint32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4), regions: meta.regions,
  }, decks);
  log(`props-only: loaded locator cache (${meta.regions.length} regions)`);
} else {
const chunkOut = new Map();
const i0 = chunkI(detail.minX), i1 = chunkI(detail.maxX - 1e-6), j0 = chunkJ(detail.minZ), j1 = chunkJ(detail.maxZ - 1e-6);
let tileCount = 0;
for (let j = j0; j <= j1; j++) {
  for (let i = i0; i <= i1; i++) {
    const rc = {
      minX: Math.max(chunkMinX(i), detail.minX), maxX: Math.min(chunkMinX(i) + CHUNK, detail.maxX),
      minZ: Math.max(chunkMinZ(j), detail.minZ), maxZ: Math.min(chunkMinZ(j) + CHUNK, detail.maxZ),
    };
    if (only && (rc.maxX < only[0] || rc.minX > only[2] || rc.maxZ < only[1] || rc.minZ > only[3])) continue;
    const mats = new MaterialSet();
    const tt = Date.now();
    processPlayableTile(rc, ctx, { mats, coll, globalLoc });
    chunkOut.set(`${i}_${j}`, { i, j, mats, rc });
    tileCount++;
    if (!args.includes('--quiet')) log(`tile ${i}_${j}: ${mats.triCount} tris (${Date.now() - tt} ms)`);
  }
}
log(`playable tiles: ${tileCount}, clip failures so far: ${clipFailures()}, triangulation fallbacks ${triStats.fallbacks}, failed ${triStats.failed}`);
globalLoc.build();
if (!only) {
  mkdirSync(cacheDir, { recursive: true });
  const c = globalLoc.toCache(decks);
  writeFileSync(resolve(cacheDir, 'locator_tris.bin'), Buffer.from(c.tris.buffer));
  writeFileSync(resolve(cacheDir, 'locator_reg.bin'), Buffer.from(c.reg.buffer));
  writeFileSync(resolve(cacheDir, 'locator.json'), JSON.stringify({ regions: c.regions }));
}

const chunkOf = (x, z) => chunkOut.get(`${chunkI(x)}_${chunkJ(z)}`);
// vaults under arched decks
for (const d of decks) {
  const p = d.axis[Math.floor(d.axis.length / 2)];
  const ch = chunkOf(p[0], p[1]);
  if (ch) addVault(ch.mats.get('bridge_side'), d, deckCrossSection);
}

// ------------------------------------------------------------------ markings
const markings = buildMarkings(pRoads, osm, decks, dTree, globalLoc, detail);
let markTris = 0;
for (const q of markings) {
  const cx = (q[0][0] + q[2][0]) / 2, cz = (q[0][2] + q[2][2]) / 2;
  const ch = chunkOf(cx, cz);
  if (!ch) continue;
  ch.mats.get('road_marking').addQuad(q[0], q[1], q[2], q[3], [0, 1, 0], q.map((p) => [p[0], p[2]]));
  markTris += 2;
}
log(`markings: ${markings.length} quads`);

// ------------------------------------------------------------------ railway tracks
{
  const ts = buildTrackGeometry(detailRails, globalLoc, chunkOf, coll, detail);
  log(`tracks: ballast ${Math.round(ts.bedLen)} m, on decks ${Math.round(ts.deckLen)} m, ${ts.sleepers} sleepers`);
}

// ------------------------------------------------------------------ write chunks
for (const f of readdirSync(outDir)) if (/^ground_.*\.glb$/.test(f)) unlinkSync(resolve(outDir, f));
let playTris = 0;
for (const ch of [...chunkOut.values()].sort((a, b) => a.j - b.j || a.i - b.i)) {
  const name = `ground_${ch.i}_${ch.j}`;
  const prims = ch.mats.entries().filter(([m]) => m !== 'water');
  if (!prims.length) continue;
  const r = await writeGlb(resolve(outDir, `${name}.glb`), [{ name, prims }]);
  playTris += r.tris;
  groundFiles.push(`${name}.glb`);
}
log(`playable ground: ${groundFiles.length} files, ${playTris} triangles`);

// ------------------------------------------------------------------ water surface (one mesh)
{
  const wm = new MeshBuilder();
  const rc = only ? { minX: only[0], minZ: only[1], maxX: only[2], maxZ: only[3] } : backdrop;
  const big = [{ minX: rc.minX, minZ: rc.minZ, maxX: rc.maxX, maxZ: rc.maxZ }];
  for (const r of big) {
    const items = waterTree.search({ minX: r.minX, minY: r.minZ, maxX: r.maxX, maxY: r.maxZ }).map((h) => h.item);
    // union in 400 m tiles to keep the clipper fast, then triangulate
    for (let z = r.minZ; z < r.maxZ; z += 400) for (let x = r.minX; x < r.maxX; x += 400) {
      const tr = { minX: x, minZ: z, maxX: Math.min(x + 400, r.maxX), maxZ: Math.min(z + 400, r.maxZ) };
      const its = items.filter((it) => it.bb[0] < tr.maxX && it.bb[2] > tr.minX && it.bb[1] < tr.maxZ && it.bb[3] > tr.minZ);
      if (!its.length) continue;
      const u = clean(intersection(union(...its.map((it) => [it.poly])), [rectPoly(tr)]), 0.5);
      for (const p of u) wm.addPoly(normalizePoly(p), WATER_LEVEL);
    }
  }
  const r = await writeGlb(resolve(outDir, 'ground_water.glb'), [{ name: 'water', prims: [['water', wm]] }]);
  groundFiles.push('ground_water.glb');
  log(`water: ${r.tris} triangles`);
}

// ------------------------------------------------------------------ backdrop
if (!skipBackdrop && !only) {
  const bdRoads = [];
  for (const r of F.roads) {
    if (!(r.kind === 'car' || r.kind === 'bus') || r.hw === 'service' && r.tags.service) continue;
    if (!inBox(r, backdrop, 10)) continue;
    bdRoads.push(...bufferPolylinePieces(r.pts, r.width / 2).map((p) => ({ poly: p, bb: bboxOfPts(p[0]) })));
  }
  const bctx = { waterTree, grassTree: polyTree(F.grass), backdropRoadTree: polyTree(bdRoads) };
  const quads = { n: new MaterialSet(), s: new MaterialSet(), w: new MaterialSet(), e: new MaterialSet() };
  const BT = 400;
  let bt = 0;
  for (let z = backdrop.minZ; z < backdrop.maxZ; z += BT) {
    for (let x = backdrop.minX; x < backdrop.maxX; x += BT) {
      const tile = { minX: x, minZ: z, maxX: Math.min(x + BT, backdrop.maxX), maxZ: Math.min(z + BT, backdrop.maxZ) };
      // split the tile against the detail rect: process only the parts outside it
      const parts = subtractRect(tile, detail);
      for (const rc of parts) {
        const cx = (rc.minX + rc.maxX) / 2, cz = (rc.minZ + rc.maxZ) / 2;
        const q = cz < detail.minZ ? 'n' : cz > detail.maxZ ? 's' : cx < detail.minX ? 'w' : 'e';
        processBackdropTile(rc, bctx, { mats: quads[q] });
        bt++;
      }
    }
  }
  const nodes = Object.entries(quads).map(([k, m]) => ({ name: `ground_backdrop_${k}`, prims: m.entries() }));
  const r = await writeGlb(resolve(outDir, 'ground_backdrop.glb'), nodes);
  groundFiles.push('ground_backdrop.glb');
  log(`backdrop: ${bt} tiles, ${r.tris} triangles, ${(r.bytes / 1e6).toFixed(1)} MB`);
}

function subtractRect(t, p) {
  const out = [];
  if (t.maxX <= p.minX || t.minX >= p.maxX || t.maxZ <= p.minZ || t.minZ >= p.maxZ) return [t];
  if (t.minZ < p.minZ) out.push({ ...t, maxZ: p.minZ });
  if (t.maxZ > p.maxZ) out.push({ ...t, minZ: p.maxZ });
  const zA = Math.max(t.minZ, p.minZ), zB = Math.min(t.maxZ, p.maxZ);
  if (t.minX < p.minX) out.push({ minX: t.minX, maxX: p.minX, minZ: zA, maxZ: zB });
  if (t.maxX > p.maxX) out.push({ minX: p.maxX, maxX: t.maxX, minZ: zA, maxZ: zB });
  return out.filter((r) => r.maxX - r.minX > 0.01 && r.maxZ - r.minZ > 0.01);
}

// ------------------------------------------------------------------ collision
writeFileSync(resolve(outDir, 'collision_ground.bin'), coll.toBuffer());
log(`collision: ${coll.triCount} triangles, ${coll.pos.length / 3} vertices`);
} // end of ground generation (skipped with --props-only)

// ------------------------------------------------------------------ graph, props, meta
const gStats = {};
const footprints = loadFootprintIndex(resolve(dataDir, 'footprints.json'));
if (!footprints) log('WARNING: public/data/footprints.json missing (BAG pipeline) - car edges inside buildings stay drivable');
// car roads in the detail margin that link separate parts of the network (station north side) stay in
const graph = buildRoadGraph(F.roads, decks, playable, { footprints, stats: gStats, connectRect: detail });
writeFileSync(resolve(outDir, 'roadgraph.json'), JSON.stringify(graph));
log(`roadgraph: ${graph.nodes.length} nodes, ${graph.edges.length} edges; car off inside buildings: ${gStats.insideEdges ?? 0} edges, ${Math.round(gStats.insideLen ?? 0)} m; connectors outside the playable rect: ${gStats.connectorEdges ?? 0} edges, ${Math.round(gStats.connectorLen ?? 0)} m`);

// meta before props: the spawn points and landmarks also steer the tree clearances
let groundList = groundFiles;
if (propsOnly) {
  const old = [outDir, dataDir].map((d) => resolve(d, 'osm-meta.json')).find((p) => existsSync(p));
  groundList = old ? JSON.parse(readFileSync(old, 'utf8')).groundFiles : [];
}
const meta = buildMeta({ osm, F, graph, playable, groundFiles: groundList, loc: globalLoc, footprints });
writeFileSync(resolve(outDir, 'osm-meta.json'), JSON.stringify(meta, null, 1));
log(`meta: ${meta.spawnPoints.length} spawn points, ${meta.landmarks.length} landmarks`);
if (!propsOnly) {
const map2d = buildMap2D(F, waterAll, backdrop);
writeFileSync(resolve(outDir, 'map2d.json'), JSON.stringify(map2d));
}

const props = buildProps({ osm, F, graph, decks, loc: globalLoc, playable, detail, roads: pRoads, bTree, RP, meta });
writeFileSync(resolve(outDir, 'props.json'), JSON.stringify(props));
log(`props: ${Object.entries(props).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
log(`done. clip failures: ${clipFailures()}`);
