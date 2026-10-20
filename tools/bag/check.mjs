#!/usr/bin/env node
// Sanity check of the BAG pipeline outputs in public/data/ (run after build.mjs):
//   node tools/bag/check.mjs
// Verifies that every file in bag-meta.json loads, has the attributes of ARCHITECTURE 4.2,
// contains no NaN/Inf, has unit normals that agree with the triangle winding, sane attribute
// ranges (COLOR_0 classes, wall UVs, roof UVs = world xz), plausible heights (no floating or
// sunken buildings), chunk bounds/naming, budgets, and validates collision/footprint files.
// Exit code 1 when an error is found.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { CHUNK, OUT_DIR } from './lib/config.mjs';

const BUDGET_BUILDINGS = 1_200_000;
const BUDGET_BACKDROP = 300_000;

let errors = 0;
let warnings = 0;
const err = (...a) => { errors++; console.log('ERROR', ...a); };
const warn = (...a) => { warnings++; console.log('WARN ', ...a); };

const meta = JSON.parse(readFileSync(resolve(OUT_DIR, 'bag-meta.json'), 'utf8'));
for (const k of ['buildingFiles', 'backdropFiles', 'buildingCount', 'attribution']) if (!(k in meta)) err(`bag-meta.json missing ${k}`);

const io = new NodeIO();
const totals = { buildings: 0, backdrop: 0, vertices: 0, bytes: 0 };
const kindHist = { 0: 0, 0.5: 0, 1: 0, other: 0 };
const ageHist = {};
let windingBad = 0, windingTotal = 0;

function isFiniteArr(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

async function checkGlb(file, kind, bounds) {
  const path = resolve(OUT_DIR, file);
  totals.bytes += statSync(path).size;
  const doc = await io.read(path);
  const nodes = doc.getRoot().listNodes();
  const expectedName = file.replace(/\.glb$/, '');
  if (nodes.length !== 1 || nodes[0].getName() !== expectedName) err(`${file}: expected one node named ${expectedName}`);
  let tris = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial()?.getName();
      const allowed = kind === 'backdrop' ? ['backdrop'] : ['wall', 'roof_slanted', 'roof_flat'];
      if (!allowed.includes(mat)) err(`${file}: unexpected material ${mat}`);
      const pos = prim.getAttribute('POSITION')?.getArray();
      const nrm = prim.getAttribute('NORMAL')?.getArray();
      const uv0 = prim.getAttribute('TEXCOORD_0')?.getArray();
      const uv1 = prim.getAttribute('TEXCOORD_1')?.getArray();
      const colAcc = prim.getAttribute('COLOR_0');
      const idx = prim.getIndices()?.getArray();
      if (!pos || !nrm || !uv0 || !idx) { err(`${file}/${mat}: missing POSITION/NORMAL/TEXCOORD_0/indices`); continue; }
      if (!colAcc) err(`${file}/${mat}: missing COLOR_0`);
      if ((mat === 'wall' || mat === 'backdrop') && !uv1) err(`${file}/${mat}: missing TEXCOORD_1`);
      if (!(idx instanceof Uint32Array)) err(`${file}/${mat}: indices are not uint32`);
      const n = pos.length / 3;
      totals.vertices += n;
      if (!isFiniteArr(pos) || !isFiniteArr(nrm) || !isFiniteArr(uv0) || (uv1 && !isFiniteArr(uv1))) err(`${file}/${mat}: NaN/Inf in attributes`);
      for (let i = 0; i < idx.length; i++) if (idx[i] >= n) { err(`${file}/${mat}: index out of range`); break; }
      tris += idx.length / 3;
      // colour: normalised ubyte or float
      const col = colAcc?.getArray();
      const cs = colAcc ? (colAcc.getNormalized() ? 255 : 1) : 1;
      let badNormal = 0, badUv = 0, badRoofUv = 0, badKind = 0;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        const nl = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
        if (Math.abs(nl - 1) > 1e-3) badNormal++;
        const isRoofVertex = mat.startsWith('roof') || (mat === 'backdrop' && uv1 && uv1[i * 2] === 0);
        if (isRoofVertex) {
          if (Math.abs(uv0[i * 2] - x) > 1e-3 || Math.abs(uv0[i * 2 + 1] - z) > 1e-3) badRoofUv++;
          // downward only for the flat ceilings of building passages (roof_flat, n = (0,-1,0))
          if (nrm[i * 3 + 1] < 0 && !(mat === 'roof_flat' && nrm[i * 3 + 1] < -0.999)) badNormal++;
        } else {
          // walls: v = height, 0 <= u <= facadeWidth
          if (Math.abs(uv0[i * 2 + 1] - y) > 1e-3) badUv++;
          if (uv1 && (uv0[i * 2] < -0.01 || uv0[i * 2] > uv1[i * 2] + 0.01)) badUv++;
          if (uv1 && (uv1[i * 2 + 1] < -0.31 || uv1[i * 2 + 1] > 200 || uv1[i * 2] <= 0)) badUv++; // eave / width
        }
        if (col) {
          const g = col[i * 4 + 1] / cs, b = col[i * 4 + 2] / cs, r = col[i * 4] / cs, a = col[i * 4 + 3] / cs;
          if (r < 0 || r >= 1 || a < 0 || a > 1) badKind++; // seed must be in [0, 1)
          const gk = Math.abs(g) < 0.01 ? 0 : Math.abs(g - 0.5) < 0.01 ? 0.5 : Math.abs(g - 1) < 0.01 ? 1 : 'other';
          if (gk === 'other') badKind++;
          if (!isRoofVertex && kind !== 'backdrop') kindHist[gk]++;
          const bk = b.toFixed(2);
          ageHist[bk] = (ageHist[bk] ?? 0) + 1;
          if (!['0.00', '0.33', '0.66', '1.00'].includes(bk)) badKind++;
        }
      }
      if (badNormal) err(`${file}/${mat}: ${badNormal} bad normals`);
      if (badUv) err(`${file}/${mat}: ${badUv} wall UV values out of range`);
      if (badRoofUv) err(`${file}/${mat}: ${badRoofUv} roof UVs differ from world xz`);
      if (badKind) err(`${file}/${mat}: ${badKind} COLOR_0 values outside the defined classes`);
      // winding vs normal
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
        const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
        const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(cr[0], cr[1], cr[2]);
        if (len < 0.1) continue; // ignore slivers (< 0.05 m^2)
        windingTotal++;
        if (cr[0] * nrm[a] + cr[1] * nrm[a + 1] + cr[2] * nrm[a + 2] < 0.5 * len) windingBad++;
      }
    }
  }
  if (kind === 'buildings') {
    totals.buildings += tris;
    if (minY < -0.31) err(`${file}: geometry below y = -0.3 (${minY.toFixed(2)})`);
    if (Math.abs(minY + 0.3) > 0.01) warn(`${file}: lowest vertex ${minY.toFixed(2)} (expected -0.30)`);
    if (maxY > 120) warn(`${file}: very tall geometry ${maxY.toFixed(1)} m`);
    // chunk naming: centre of the bounds must be near the named cell
    const m = /buildings_(\d+)_(\d+)\.glb/.exec(file);
    if (m) {
      const ci = Number(m[1]), cj = Number(m[2]);
      const cx = -2000 + (ci + 0.5) * CHUNK, cz = -2000 + (cj + 0.5) * CHUNK;
      if (Math.abs((minX + maxX) / 2 - cx) > CHUNK || Math.abs((minZ + maxZ) / 2 - cz) > CHUNK) err(`${file}: content far from its chunk cell`);
    }
    if (bounds && (Math.abs(bounds.minX - minX) > 0.2 || Math.abs(bounds.maxX - maxX) > 0.2 || Math.abs(bounds.minZ - minZ) > 0.2 || Math.abs(bounds.maxZ - maxZ) > 0.2)) {
      err(`${file}: bounds in bag-meta.json do not match the geometry`);
    }
  } else {
    totals.backdrop += tris;
    if (minY < -0.31) err(`${file}: geometry below y = -0.3`);
  }
  return tris;
}

for (const f of meta.buildingFiles) await checkGlb(f.file, 'buildings', f.bounds);
for (const f of meta.backdropFiles) await checkGlb(f, 'backdrop', null);

if (totals.buildings > BUDGET_BUILDINGS) err(`building triangles ${totals.buildings} > budget ${BUDGET_BUILDINGS}`);
if (totals.backdrop > BUDGET_BACKDROP) err(`backdrop triangles ${totals.backdrop} > budget ${BUDGET_BACKDROP}`);
if (meta.backdropFiles.length < 2 || meta.backdropFiles.length > 6) warn(`backdrop split into ${meta.backdropFiles.length} files (expected 2-6)`);
if (windingBad > windingTotal * 0.001) err(`winding disagrees with normals for ${windingBad}/${windingTotal} triangles`);

// collision
{
  const buf = readFileSync(resolve(OUT_DIR, 'collision_buildings.bin'));
  const vc = buf.readUInt32LE(0), ic = buf.readUInt32LE(4);
  if (buf.length !== 8 + vc * 12 + ic * 4) err('collision_buildings.bin: size does not match header');
  else {
    const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + vc * 12));
    const idx = new Uint32Array(buf.buffer.slice(buf.byteOffset + 8 + vc * 12, buf.byteOffset + 8 + vc * 12 + ic * 4));
    if (!isFiniteArr(pos)) err('collision_buildings.bin: NaN');
    if (ic % 3) err('collision_buildings.bin: index count not a multiple of 3');
    for (let i = 0; i < idx.length; i++) if (idx[i] >= vc) { err('collision_buildings.bin: index out of range'); break; }
    console.log(`collision: ${vc} vertices, ${ic / 3} triangles`);
    roadCrossings(pos, idx);
  }
}

/**
 * Car roads of the OSM road graph that run into a building collision wall (car height 0.5 m).
 * Passages (tunnel=building_passage) are cut open by build.mjs, so a big number here means a
 * passage or the road graph broke. Remaining ones are OSM/BAG misalignments at building corners
 * and service roads ending in a garage.
 */
function roadCrossings(pos, idx) {
  let g;
  try { g = JSON.parse(readFileSync(resolve(OUT_DIR, 'roadgraph.json'), 'utf8')); } catch { return; }
  const C = 8, grid = new Map(), segs = [];
  for (let t = 0; t + 1 < idx.length / 3; t += 2) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const sg = [pos[a], pos[a + 2], pos[b], pos[b + 2], Math.min(pos[a + 1], pos[c + 1]), Math.max(pos[a + 1], pos[c + 1])];
    const k = segs.length; segs.push(sg);
    for (let i = Math.floor(Math.min(sg[0], sg[2]) / C); i <= Math.floor(Math.max(sg[0], sg[2]) / C); i++)
      for (let j = Math.floor(Math.min(sg[1], sg[3]) / C); j <= Math.floor(Math.max(sg[1], sg[3]) / C); j++) {
        const key = i * 65536 + j; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k);
      }
  }
  const cross = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz, den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * d2z - (cz - az) * d2x) / den, u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  const hit = new Map();
  for (const e of g.edges) {
    if (!e.car) continue;
    for (let k = 1; k < e.pts.length; k++) {
      const [ax, az] = e.pts[k - 1], [bx, bz] = e.pts[k];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < L; s += 1) {
        const s1 = Math.min(L, s + 1);
        const x0 = ax + ((bx - ax) * s) / L, z0 = az + ((bz - az) * s) / L, x1 = ax + ((bx - ax) * s1) / L, z1 = az + ((bz - az) * s1) / L;
        for (const key of [Math.floor(x0 / C) * 65536 + Math.floor(z0 / C), Math.floor(x1 / C) * 65536 + Math.floor(z1 / C)])
          for (const q of grid.get(key) ?? []) {
            const S = segs[q];
            if (S[4] < 0.5 && S[5] > 0.5 && cross(x0, z0, x1, z1, S[0], S[1], S[2], S[3])) hit.set(e, `${e.name ?? e.type} ${x0.toFixed(0)},${z0.toFixed(0)}`);
          }
      }
    }
  }
  const list = [...hit.values()];
  console.log(`car roads running into a building wall: ${list.length}${list.length ? ' (' + list.slice(0, 10).join('; ') + ')' : ''}`);
  if (list.length > 15) warn(`${list.length} car roads run into building walls (passages broken?)`);
}
// footprints
{
  const fp = JSON.parse(readFileSync(resolve(OUT_DIR, 'footprints.json'), 'utf8'));
  if (!Array.isArray(fp.rings) || !fp.rings.length) err('footprints.json: no rings');
  const bad = fp.rings.filter((r) => r.length < 3 || r.some((p) => p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])));
  if (bad.length) err(`footprints.json: ${bad.length} invalid rings`);
  console.log(`footprints: ${fp.rings.length} rings`);
}

const kTotal = kindHist[0] + kindHist[0.5] + kindHist[1];
console.log(`files: ${meta.buildingFiles.length} building chunks + ${meta.backdropFiles.length} backdrop, ${(totals.bytes / 1e6).toFixed(1)} MB, ${totals.vertices} vertices`);
console.log(`triangles: buildings ${totals.buildings} (budget ${BUDGET_BUILDINGS}), backdrop ${totals.backdrop} (budget ${BUDGET_BACKDROP})`);
console.log(`wall vertices by kind: normal ${(100 * kindHist[0] / kTotal).toFixed(1)}%, party ${(100 * kindHist[0.5] / kTotal).toFixed(1)}%, landmark ${(100 * kindHist[1] / kTotal).toFixed(1)}%`);
console.log(`age classes (all vertices): ${JSON.stringify(ageHist)}`);
console.log(`winding/normal disagreement: ${windingBad} of ${windingTotal} triangles`);
console.log(`excluded: ${JSON.stringify(meta.excluded ?? [])}; landmarks: ${(meta.landmarks ?? []).length}`);
console.log(errors ? `CHECK FAILED: ${errors} errors, ${warnings} warnings` : `CHECK OK (${warnings} warnings)`);
process.exit(errors ? 1 : 0);
