#!/usr/bin/env node
// Build step of the 3D BAG pipeline (runs offline from data-raw/bag, see fetch.mjs).
//
//   node tools/bag/build.mjs [--exclude <pand id>,<pand id>]
//
// Outputs (public/data/, formats in docs/ARCHITECTURE.md 4.2 / 4.4):
//   buildings_<i>_<j>.glb   LoD 2.2 buildings per 200 m chunk (wall / roof_slanted / roof_flat)
//   backdrop_<name>.glb     surrounding ring, material 'backdrop': LoD 2.2 (party walls removed)
//                           up to BACKDROP_LOD22 m from the playable rect, LoD 1.2 extrusions beyond
//   collision_buildings.bin LoD 1.2 walls (footprint extrusions) of the playable buildings
//   footprints.json         simplified outer rings of the playable buildings (minimap)
//   bag-meta.json           BagMeta (+ extra: excluded, landmarks, stats)
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import polygonClipping from 'polygon-clipping';
import {
  ATTRIBUTION, BACKDROP_RD, OUT_DIR, ORIGIN_RD, PLAYABLE_LOCAL, chunkI, chunkJ,
} from './lib/config.mjs';
import { loadBuildings } from './lib/load.mjs';
import { loadLandmarks } from './lib/landmarks.mjs';
import { PrimBuilder, writeGlb } from './lib/glb.mjs';
import { buildEdgeIndex, buildWallIndex, coveredIntervals, emitBuilding, prepareBuilding, yRangeAt } from './lib/buildings.mjs';
import { BACKDROP_MIN_AREA, BACKDROP_MIN_HEIGHT, complement, emitBackdrop, lod12Height, simplifiedRings } from './lib/backdrop.mjs';
import { pointInPolygon, signedArea2, simplifyRing } from './lib/geom.mjs';
import { carRoadIndex, findPassages, lineIntervals, passageHeight } from './lib/passages.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

/** LoD 2.2 buildings are generated for the playable rect plus this margin (m). */
const DETAIL_MARGIN = 150;
/** Backdrop buildings closer than this (m) to the playable rect use simplified LoD 2.2 geometry
 *  (single 'backdrop' material); further away they are LoD 1.2 extrusions. */
const BACKDROP_LOD22 = 450;
/** Collision walls for buildings with their centroid within the playable rect + this margin. */
const COLLISION_MARGIN = 40;
const COLLISION_MAX_H = 30;

const P = PLAYABLE_LOCAL;
const rectDist = (x, z) => Math.max(P.minX - x, x - P.maxX, P.minZ - z, z - P.maxZ, 0);
const inRect = (x, z, m = 0) => rectDist(x, z) <= m;
const B = {
  minX: BACKDROP_RD.minX - ORIGIN_RD.x, maxX: BACKDROP_RD.maxX - ORIGIN_RD.x,
  minZ: -(BACKDROP_RD.maxY - ORIGIN_RD.y), maxZ: -(BACKDROP_RD.minY - ORIGIN_RD.y),
};
const inBackdrop = (x, z) => x >= B.minX && x <= B.maxX && z >= B.minZ && z <= B.maxZ;

// ---------------------------------------------------------------------------------------------
// 1. load
// ---------------------------------------------------------------------------------------------
const lm = loadLandmarks();
log(`landmarks: ${lm.landmarks.length} polygons, ${lm.landmarkPoints.length} points; windmill: ${lm.windmill?.name ?? 'none'}`);

const all = loadBuildings((x, z) => {
  if (inRect(x, z, BACKDROP_LOD22)) return ['2.2', '1.2'];
  if (inBackdrop(x, z)) return [];
  return null;
}, { log });

// heights used by the backdrop / collision neighbour tests
for (const b of all.values()) b._height = lod12Height(b) ?? 0;

// ---------------------------------------------------------------------------------------------
// 2. exclusions (Molen van Piet) and landmarks
// ---------------------------------------------------------------------------------------------
function ringsOverlapArea(ringA, ringB) {
  try {
    const res = polygonClipping.intersection([ringA.map((p) => [p[0], p[1]])], [ringB.map((p) => [p[0], p[1]])]);
    let area = 0;
    for (const poly of res) {
      poly.forEach((r, k) => (area += (k === 0 ? 1 : -1) * Math.abs(signedArea2(r))));
    }
    return area;
  } catch {
    return 0;
  }
}

// Buildings replaced by custom models: the Molen van Piet (found via OSM) plus any pand ids
// given with --exclude id1,id2 (e.g. when a landmark gets a hand-made model later).
const excluded = [];
const excludedInfo = [];
const cliExclude = (() => {
  const i = process.argv.indexOf('--exclude');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
})();
const excludeBuilding = (b, reason) => {
  excluded.push(b.id);
  const r1 = (v) => Math.round(v * 100) / 100;
  excludedInfo.push({
    id: b.id, reason,
    centroid: b.centroid.map(r1),
    footprint: b.footprint[0].map((p) => p.map(r1)),
    heightMax: Number.isFinite(b.attrs.b3_h_dak_max) ? r1(b.attrs.b3_h_dak_max - b.maaiveld) : null,
    height70: Number.isFinite(b.attrs.b3_h_dak_70p) ? r1(b.attrs.b3_h_dak_70p - b.maaiveld) : null,
  });
};
for (const id of cliExclude) {
  const full = id.startsWith('NL.IMBAG.Pand.') ? id : `NL.IMBAG.Pand.${id.padStart(16, '0')}`;
  const b = all.get(full);
  if (b) excludeBuilding(b, 'cli');
  else console.warn(`--exclude: ${full} not found`);
}
if (lm.windmill) {
  for (const b of all.values()) {
    const d = Math.hypot(b.centroid[0] - lm.windmill.x, b.centroid[1] - lm.windmill.z);
    if (d > 60) continue;
    let hit = b.id === lm.windmill.refBag;
    for (const r of lm.windmill.rings) if (!hit && ringsOverlapArea(b.footprint[0], r) > 0.2 * Math.min(b.area, Math.abs(signedArea2(r)))) hit = true;
    if (!hit && pointInPolygon(lm.windmill.x, lm.windmill.z, b.footprint)) hit = true;
    if (hit && !excluded.includes(b.id)) excludeBuilding(b, lm.windmill.name);
  }
}
for (const id of excluded) all.delete(id);
log(`excluded: ${excluded.join(', ') || 'none'}`);

const landmarkIds = new Set();
const landmarkInfo = [];
for (const b of all.values()) {
  if (!inRect(b.centroid[0], b.centroid[1], DETAIL_MARGIN)) continue;
  for (const L of lm.landmarks) {
    let hit = b.id === L.refBag;
    if (!hit) {
      const ov = ringsOverlapArea(b.footprint[0], L.rings[0]);
      hit = ov > 0.5 * b.area || ov > 0.5 * Math.abs(signedArea2(L.rings[0]));
    }
    if (hit) { landmarkIds.add(b.id); landmarkInfo.push({ id: b.id, name: L.name, x: Math.round(b.centroid[0] * 10) / 10, z: Math.round(b.centroid[1] * 10) / 10 }); break; }
  }
  if (landmarkIds.has(b.id)) continue;
  for (const L of lm.landmarkPoints) {
    if (pointInPolygon(L.x, L.z, b.footprint)) { landmarkIds.add(b.id); landmarkInfo.push({ id: b.id, name: L.name, x: Math.round(b.centroid[0] * 10) / 10, z: Math.round(b.centroid[1] * 10) / 10 }); break; }
  }
}
log(`landmark buildings: ${landmarkIds.size}`);

// ---------------------------------------------------------------------------------------------
// 3. detailed buildings (LoD 2.2)
// ---------------------------------------------------------------------------------------------
const edgeIndex = buildEdgeIndex(all.values());
const detail = [...all.values()].filter((b) => inRect(b.centroid[0], b.centroid[1], DETAIL_MARGIN)).sort((a, b) => (a.id < b.id ? -1 : 1));
const stats = {
  buildings: 0, lod12Fallback: 0, walls: 0, flipped: 0, ambiguous: 0, partyPieces: 0, hiddenPieces: 0,
  partyGroups: 0, normalGroups: 0, wallTris: 0, roofTris: 0, backdropWalls: 0, backdropTris: 0,
};
// backdrop buildings that get (simplified) LoD 2.2 geometry
const band22 = [...all.values()]
  .filter((b) => !inRect(b.centroid[0], b.centroid[1], DETAIL_MARGIN) && inRect(b.centroid[0], b.centroid[1], BACKDROP_LOD22))
  .filter((b) => (b._height ?? 0) >= BACKDROP_MIN_HEIGHT && b.area >= BACKDROP_MIN_AREA)
  .sort((a, b) => (a.id < b.id ? -1 : 1));
const band22Ids = new Set(band22.map((b) => b.id));
const preps = new Map();
for (const b of [...detail, ...band22]) {
  let lod = '2.2';
  if (!(b.lods['2.2'] ?? []).length) { lod = '1.2'; stats.lod12Fallback++; }
  preps.set(b.id, prepareBuilding(b, lod, stats, { landmark: landmarkIds.has(b.id) }));
}
const wallIndex = buildWallIndex([...preps.values()].flatMap((p) => p.walls));
log(`prepared ${detail.length} detailed + ${band22.length} LoD 2.2 backdrop buildings`);

// building passages (OSM tunnel=building_passage / covered=yes roads under a building)
const passages = new Map();
for (const [bid, p] of findPassages(detail.filter((b) => inRect(b.centroid[0], b.centroid[1], COLLISION_MARGIN)), log)) {
  const h = passageHeight(preps.get(bid), p.mp);
  if (h === null) { log(`passage under ${bid}: too low, kept closed`); continue; }
  passages.set(bid, { mp: p.mp, h });
  log(`passage under ${bid}: ${p.area.toFixed(0)} m2, clear height ${h.toFixed(2)} m (ways ${p.ways.join(',')})`);
}

const chunks = new Map();
const chunkOf = (b) => {
  const key = `${chunkI(b.centroid[0])}_${chunkJ(b.centroid[1])}`;
  if (!chunks.has(key)) {
    chunks.set(key, {
      key, count: 0,
      prims: {
        wall: new PrimBuilder({ uv1: true, color: true }),
        roof_slanted: new PrimBuilder({ uv1: true, color: true }),
        roof_flat: new PrimBuilder({ uv1: true, color: true }),
      },
    });
  }
  return chunks.get(key);
};
const ctx = { edgeIndex, wallIndex, landmarkIds };
for (const b of detail) {
  const ch = chunkOf(b);
  emitBuilding(b, preps.get(b.id), ctx, ch.prims, stats, { passage: passages.get(b.id) });
  ch.count++;
  stats.buildings++;
}
log(`detail: ${stats.buildings} buildings, ${stats.wallTris + stats.roofTris} triangles in ${chunks.size} chunks`);

// clean old outputs of this pipeline
mkdirSync(OUT_DIR, { recursive: true });
for (const f of readdirSync(OUT_DIR)) {
  if (/^(buildings_.*\.glb|backdrop.*\.glb)$/.test(f)) rmSync(resolve(OUT_DIR, f));
}

const buildingFiles = [];
const chunkStats = [];
for (const ch of [...chunks.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
  const file = `buildings_${ch.key}.glb`;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, tris = 0;
  for (const pb of Object.values(ch.prims)) {
    const a = pb.pos.array;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] < minX) minX = a[i];
      if (a[i] > maxX) maxX = a[i];
      if (a[i + 2] < minZ) minZ = a[i + 2];
      if (a[i + 2] > maxZ) maxZ = a[i + 2];
    }
    tris += pb.triCount;
  }
  if (!tris) continue;
  await writeGlb(resolve(OUT_DIR, file), [{ name: `buildings_${ch.key}`, prims: ch.prims }]);
  const r1 = (v) => Math.round(v * 10) / 10;
  buildingFiles.push({ file, bounds: { minX: r1(minX), minZ: r1(minZ), maxX: r1(maxX), maxZ: r1(maxZ) } });
  chunkStats.push({ file, buildings: ch.count, triangles: tris });
}
log(`wrote ${buildingFiles.length} building chunks`);
chunks.clear();

// ---------------------------------------------------------------------------------------------
// 4. backdrop (LoD 1.2 extrusions)
// ---------------------------------------------------------------------------------------------
const bands = {
  north: new PrimBuilder({ uv1: true, color: true }),
  south: new PrimBuilder({ uv1: true, color: true }),
  west: new PrimBuilder({ uv1: true, color: true }),
  east: new PrimBuilder({ uv1: true, color: true }),
};
const bandOf = (x, z) => {
  if (z < P.minZ - DETAIL_MARGIN) return 'north';
  if (z > P.maxZ + DETAIL_MARGIN) return 'south';
  return x < P.minX ? 'west' : 'east';
};
let backdropCount = 0;
const bstats = { ...stats, walls: 0, partyPieces: 0, hiddenPieces: 0, partyGroups: 0, normalGroups: 0, wallTris: 0, roofTris: 0 };
for (const b of band22) {
  emitBuilding(b, preps.get(b.id), ctx, { backdrop: bands[bandOf(b.centroid[0], b.centroid[1])] }, bstats, { backdrop: true });
  backdropCount++;
}
stats.backdropTris += bstats.wallTris + bstats.roofTris;
stats.backdropLod22 = band22.length;
// LoD 1.2 boxes further out. Walls are only dropped behind other boxes (a LoD 2.2 neighbour
// may be lower than its LoD 1.2 height, which would open a hole).
const boxes = [...all.values()]
  .filter((b) => !inRect(b.centroid[0], b.centroid[1], BACKDROP_LOD22))
  .filter((b) => (b._height ?? 0) >= BACKDROP_MIN_HEIGHT && b.area >= BACKDROP_MIN_AREA)
  .sort((a, c) => (a.id < c.id ? -1 : 1));
const boxIds = new Set(boxes.map((b) => b.id));
for (const b of boxes) {
  emitBackdrop(b, Math.min(b._height, 120), edgeIndex, bands[bandOf(b.centroid[0], b.centroid[1])], stats, (e) => boxIds.has(e.bid));
  backdropCount++;
}
stats.backdropBoxes = boxes.length;
const backdropFiles = [];
for (const [name, pb] of Object.entries(bands)) {
  if (!pb.triCount) continue;
  const file = `backdrop_${name}.glb`;
  await writeGlb(resolve(OUT_DIR, file), [{ name: `backdrop_${name}`, prims: { backdrop: pb } }]);
  backdropFiles.push(file);
  chunkStats.push({ file, buildings: null, triangles: pb.triCount });
}
log(`backdrop: ${backdropCount} buildings, ${stats.backdropTris} triangles in ${backdropFiles.length} files`);

// ---------------------------------------------------------------------------------------------
// 5. collision walls + footprints (playable buildings)
// ---------------------------------------------------------------------------------------------
const colPos = [];
const colIdx = [];
const footprintRings = [];
let collisionBuildings = 0;
let colNoWall = 0;
const carRoads = carRoadIndex(log);
for (const b of [...all.values()].sort((a, c) => (a.id < c.id ? -1 : 1))) {
  const [x, z] = b.centroid;
  const pas = passages.get(b.id);
  if (inRect(x, z) && b.area >= 4) {
    // passages are not 'inside the building' for the road graph / minimap
    let outers = [b.footprint[0]];
    if (pas) {
      const close = (r) => [...r.map((p) => [p[0], p[1]]), [r[0][0], r[0][1]]];
      outers = polygonClipping.difference([close(b.footprint[0])], pas.mp).map((poly) => poly[0].slice(0, -1)).filter((r) => Math.abs(signedArea2(r)) >= 4);
    }
    for (const o of outers) {
      const r = simplifyRing(o, 0.25).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
      if (r.length >= 3) footprintRings.push(r);
    }
  }
  if (!inRect(x, z, COLLISION_MARGIN)) continue;
  const h = Math.min(Math.max(b._height || 6, 3), COLLISION_MAX_H);
  collisionBuildings++;
  for (const ring of simplifiedRings(b, 0.2, 10)) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // Edges shared with another building are unreachable: drop them.
      const n2 = [-dz / len, dx / len];
      const t = [n2[1], -n2[0]];
      const w0 = a[0] * n2[0] + a[1] * n2[1];
      const sa = a[0] * t[0] + a[1] * t[1], sc = c[0] * t[0] + c[1] * t[1];
      const s0 = Math.min(sa, sc), s1 = Math.max(sa, sc);
      let vis = complement(coveredIntervals(edgeIndex, b.id, t, n2, w0, s0, s1, 0.3), s0, s1);
      // Across car roads, only where the rendered LoD 2.2 shell really has a wall down to the
      // street: some large panden have footprint edges without walls (blocks joined over a street,
      // overhangs), which were invisible walls across the road (Compagniestraat, Wolfpad).
      const prep = preps.get(b.id);
      if (prep && prep.walls.length) {
        const ground = [];
        for (const w of prep.walls) {
          const dot = w.n2[0] * n2[0] + w.n2[1] * n2[1];
          if (Math.abs(dot) < 0.98) continue;
          // distance of the wall's base line (mid point) to the edge line (w0 values are not
          // comparable directly: they are offsets from the world origin, km away)
          const sm = (w.s0 + w.s1) / 2;
          if (Math.abs((sm * w.t[0] + w.w0 * w.n2[0]) * n2[0] + (sm * w.t[1] + w.w0 * w.n2[1]) * n2[1] - w0) > 0.5) continue;
          // wall frame s -> edge frame s (the frames may run opposite ways)
          const toEdge = (sw) => (sw * w.t[0] + w.w0 * w.n2[0]) * t[0] + (sw * w.t[1] + w.w0 * w.n2[1]) * t[1];
          let run = null;
          for (let sw = w.s0; sw <= w.s1 + 1e-6; sw += Math.max(0.05, Math.min(0.5, (w.s1 - w.s0) / 2))) {
            const r = yRangeAt(w.outer, Math.min(Math.max(sw, w.s0 + 1e-3), w.s1 - 1e-3));
            const ok = r && r[0] < 1.2;
            const se = toEdge(sw);
            if (ok) { if (!run) run = [se, se]; else { run[0] = Math.min(run[0], se); run[1] = Math.max(run[1], se); } }
            else if (run) { ground.push(run); run = null; }
          }
          if (run) ground.push(run);
        }
        // open = no ground-reaching wall AND on a car road (elsewhere the footprint wall stays: safer)
        const noWall = complement(ground.map(([p, q]) => [p - 0.3, q + 0.3]), s0, s1);
        const open = [];
        for (const [p, q] of noWall) {
          let run = null;
          for (let sv = p; sv <= q + 1e-6; sv += 0.25) {
            const on = carRoads?.near(sv * t[0] + w0 * n2[0], sv * t[1] + w0 * n2[1]);
            if (on) { if (!run) run = [sv, sv]; run[1] = sv; } else if (run) { open.push([run[0] - 0.25, run[1] + 0.25]); run = null; }
          }
          if (run) open.push([run[0] - 0.25, run[1] + 0.25]);
        }
        const keep = complement(open, s0, s1);
        const before = vis.reduce((t2, [lo, hi]) => t2 + hi - lo, 0);
        vis = vis.flatMap(([lo, hi]) => keep.filter(([p, q]) => q > lo && p < hi).map(([p, q]) => [Math.max(p, lo), Math.min(q, hi)]));
        const lost = before - vis.reduce((t2, [lo, hi]) => t2 + hi - lo, 0);
        colNoWall += lost;
      }
      if (pas) {
        // open below the passage ceiling (the part above is out of reach anyway)
        const open = lineIntervals(pas.mp, [w0 * n2[0], w0 * n2[1]], t, s0, s1);
        vis = vis.flatMap(([lo, hi]) => complement(open.filter(([p, q]) => q > lo && p < hi).map(([p, q]) => [Math.max(p, lo), Math.min(q, hi)]), lo, hi));
      }
      for (const [lo, hi] of vis) {
        if (hi - lo < 0.05) continue;
        const pA = [lo * t[0] + w0 * n2[0], lo * t[1] + w0 * n2[1]];
        const pB = [hi * t[0] + w0 * n2[0], hi * t[1] + w0 * n2[1]];
        const base = colPos.length / 3;
        colPos.push(pA[0], -1, pA[1], pB[0], -1, pB[1], pB[0], h, pB[1], pA[0], h, pA[1]);
        colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
  }
}
// passage side walls (double-sided: the trimesh colliders are one-sided)
for (const [bid, pas] of passages) {
  const b = all.get(bid);
  const close = (r) => [...r.map((p) => [p[0], p[1]]), [r[0][0], r[0][1]]];
  const area = polygonClipping.intersection(pas.mp, [b.footprint.map(close)]);
  const onFp = (x, z) => b.footprint.some((r) => r.some((a, i) => {
    const c = r[(i + 1) % r.length], dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
    const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
    return Math.hypot(a[0] + dx * u - x, a[1] + dz * u - z) < 0.05;
  }));
  for (const poly of area) for (const r of poly) for (let i = 0; i + 1 < r.length; i++) {
    const a = r[i], c = r[i + 1];
    if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 0.05 || onFp((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)) continue;
    for (const [p, q] of [[a, c], [c, a]]) {
      const base = colPos.length / 3;
      colPos.push(p[0], -1, p[1], q[0], -1, q[1], q[0], pas.h, q[1], p[0], pas.h, p[1]);
      colIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}
{
  const vc = colPos.length / 3, ic = colIdx.length;
  const buf = Buffer.alloc(8 + vc * 12 + ic * 4);
  buf.writeUInt32LE(vc, 0);
  buf.writeUInt32LE(ic, 4);
  Buffer.from(new Float32Array(colPos).buffer).copy(buf, 8);
  Buffer.from(new Uint32Array(colIdx).buffer).copy(buf, 8 + vc * 12);
  writeFileSync(resolve(OUT_DIR, 'collision_buildings.bin'), buf);
  log(`collision: ${collisionBuildings} buildings, ${vc} vertices, ${ic / 3} triangles; ${colNoWall.toFixed(0)} m of footprint edge without a LoD 2.2 wall left open on car roads`);
}
writeFileSync(resolve(OUT_DIR, 'footprints.json'), JSON.stringify({ rings: footprintRings }));
log(`footprints: ${footprintRings.length} rings`);

// ---------------------------------------------------------------------------------------------
// 6. meta
// ---------------------------------------------------------------------------------------------
const meta = {
  buildingFiles,
  backdropFiles,
  buildingCount: stats.buildings,
  attribution: ATTRIBUTION,
  excluded,
  excludedInfo,
  landmarks: landmarkInfo.sort((a, b) => (a.id < b.id ? -1 : 1)),
  detailRect: { minX: P.minX - DETAIL_MARGIN, minZ: P.minZ - DETAIL_MARGIN, maxX: P.maxX + DETAIL_MARGIN, maxZ: P.maxZ + DETAIL_MARGIN },
  playableRect: P,
  backdropBuildingCount: backdropCount,
  triangles: {
    buildings: stats.wallTris + stats.roofTris,
    walls: stats.wallTris,
    roofs: stats.roofTris,
    backdrop: stats.backdropTris,
  },
  files: chunkStats,
  stats,
};
writeFileSync(resolve(OUT_DIR, 'bag-meta.json'), JSON.stringify(meta, null, 1));
log('stats', JSON.stringify(stats));
log('done');
