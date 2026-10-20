#!/usr/bin/env node
// Validates the OSM pipeline outputs in public/data (schema, NaN, ranges, budgets, graph
// connectivity, spawn points on drivable roads). Exit code 1 when an error is found.
//
// Usage: node tools/osm/check.mjs [--quick]   (--quick skips reading every GLB)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = resolve(root, 'public/data');
const quick = process.argv.includes('--quick');
let errors = 0, warnings = 0;
const err = (m) => { errors++; console.log(`ERROR  ${m}`); };
const warn = (m) => { warnings++; console.log(`warn   ${m}`); };
const info = (m) => console.log(`       ${m}`);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const readJson = (f) => {
  const p = resolve(dataDir, f);
  if (!existsSync(p)) { err(`${f} missing`); return null; }
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { err(`${f}: ${e.message}`); return null; }
};

const GROUND_MATS = new Set(['asphalt', 'klinkers', 'sidewalk', 'square', 'curb', 'bikelane', 'grass', 'water', 'quay', 'quay_cap',
  'bridge_deck', 'bridge_side', 'bridge_rail', 'road_marking', 'parking', 'canal_bed', 'ground']);
const BUDGET = { playable: 700_000, backdrop: 150_000, collision: 400_000 };

// ------------------------------------------------------------------ osm-meta.json
const meta = readJson('osm-meta.json');
let playable = null;
if (meta) {
  playable = meta.playable;
  if (!playable || ![playable.minX, playable.minZ, playable.maxX, playable.maxZ].every(fin) || playable.maxX <= playable.minX || playable.maxZ <= playable.minZ) err('osm-meta.playable invalid');
  else info(`playable ${JSON.stringify(playable)} (${(playable.maxX - playable.minX).toFixed(0)} x ${(playable.maxZ - playable.minZ).toFixed(0)} m)`);
  if (!/OpenStreetMap/.test(meta.attribution ?? '')) err('osm-meta.attribution missing OpenStreetMap credit');
  for (const id of ['waag', 'grote_kerk', 'station', 'molen', 'singel', 'verdronkenoord']) {
    const s = meta.spawnPoints?.find((p) => p.id === id);
    if (!s) err(`spawn point '${id}' missing`);
    else if (![s.x, s.z, s.heading].every(fin) || typeof s.name !== 'string') err(`spawn point '${id}' invalid`);
  }
  for (const id of ['waag', 'grote_kerk', 'molen_van_piet', 'accijnstoren', 'stadhuis']) {
    const l = meta.landmarks?.find((p) => p.id === id);
    if (!l) err(`landmark '${id}' missing`);
    else if (![l.x, l.z].every(fin)) err(`landmark '${id}' invalid`);
    else if (l.footprint && !l.footprint.every((p) => fin(p[0]) && fin(p[1]))) err(`landmark '${id}' footprint has NaN`);
  }
  const listed = new Set(meta.groundFiles ?? []);
  for (const f of listed) if (!existsSync(resolve(dataDir, f))) err(`groundFiles lists missing file ${f}`);
  for (const f of readdirSync(dataDir)) if (/^ground_.*\.glb$/.test(f) && !listed.has(f)) err(`stale/unlisted ground file ${f}`);
  if (!listed.has('ground_water.glb')) err('ground_water.glb not listed');
  if (!listed.has('ground_backdrop.glb')) err('ground_backdrop.glb not listed (full build required)');
  info(`groundFiles: ${listed.size}, spawn points ${meta.spawnPoints?.length}, landmarks ${meta.landmarks?.length}`);
}

// ------------------------------------------------------------------ roadgraph.json
const graph = readJson('roadgraph.json');
if (graph) {
  const N = graph.nodes.length;
  let bad = 0;
  graph.nodes.forEach((p) => { if (!fin(p[0]) || !fin(p[1])) bad++; });
  if (bad) err(`roadgraph: ${bad} nodes with NaN`);
  const adj = Array.from({ length: N }, () => []);
  const types = {};
  graph.edges.forEach((e, i) => {
    const okIdx = Number.isInteger(e.a) && Number.isInteger(e.b) && e.a >= 0 && e.b >= 0 && e.a < N && e.b < N;
    if (!okIdx) { err(`edge ${i}: bad node index`); return; }
    if (!Array.isArray(e.pts) || e.pts.length < 2 || !e.pts.every((p) => fin(p[0]) && fin(p[1]))) { err(`edge ${i}: bad pts`); return; }
    const A = graph.nodes[e.a], B = graph.nodes[e.b], p0 = e.pts[0], p1 = e.pts[e.pts.length - 1];
    if (Math.hypot(A[0] - p0[0], A[1] - p0[1]) > 0.05 || Math.hypot(B[0] - p1[0], B[1] - p1[1]) > 0.05) err(`edge ${i}: end points do not match nodes`);
    let L = 0;
    for (let k = 1; k < e.pts.length; k++) L += Math.hypot(e.pts[k][0] - e.pts[k - 1][0], e.pts[k][1] - e.pts[k - 1][1]);
    if (!fin(e.len) || Math.abs(L - e.len) > 0.1 + L * 0.01) err(`edge ${i}: len ${e.len} != ${L.toFixed(2)}`);
    if (e.oneway !== 0 && e.oneway !== 1) err(`edge ${i}: oneway ${e.oneway}`);
    if (!(e.lanes >= 1) || !(e.speed > 0) || !(e.width > 0)) err(`edge ${i}: lanes/speed/width invalid`);
    for (const k of ['car', 'bike', 'foot', 'bridge']) if (typeof e[k] !== 'boolean') err(`edge ${i}: ${k} not boolean`);
    if (typeof e.type !== 'string') err(`edge ${i}: type`);
    types[e.type] = (types[e.type] ?? 0) + 1;
    adj[e.a].push([e.b, i]); adj[e.b].push([e.a, i]);
  });
  // connectivity (undirected) of car edges / all edges
  const comp = (filter) => {
    const seen = new Int32Array(N).fill(-1);
    const sizes = [];
    for (let s = 0; s < N; s++) {
      if (seen[s] >= 0 || !adj[s].some(([, ei]) => filter(graph.edges[ei]))) continue;
      const c = sizes.length; let n = 0; const st = [s]; seen[s] = c;
      while (st.length) {
        const u = st.pop(); n++;
        for (const [v, ei] of adj[u]) if (seen[v] < 0 && filter(graph.edges[ei])) { seen[v] = c; st.push(v); }
      }
      sizes.push(n);
    }
    return sizes.sort((a, b) => b - a);
  };
  const carC = comp((e) => e.car), allC = comp(() => true);
  const carNodes = carC.reduce((a, b) => a + b, 0), allNodes = allC.reduce((a, b) => a + b, 0);
  info(`roadgraph: ${N} nodes, ${graph.edges.length} edges ${JSON.stringify(types)}`);
  info(`car components: ${carC.length} (largest ${carC[0]} of ${carNodes} nodes), all-mode components ${allC.length} (largest ${allC[0]} of ${allNodes})`);
  if (carC[0] < carNodes * 0.85) err('car network: largest component < 85 % of car nodes');
  if (allC[0] < allNodes * 0.85) err('road network: largest component < 85 % of nodes');
  const tiny = allC.filter((n) => n <= 2).length;
  if (tiny > 10) warn(`${tiny} tiny (<= 2 node) fragments in the graph`);

  // car components with their lengths; spawns must be on the biggest one
  const cp = graph.nodes.map((_, i) => i);
  const cf = (x) => { while (cp[x] !== x) { cp[x] = cp[cp[x]]; x = cp[x]; } return x; };
  // (only edges inside the playable rect: the connectors in the detail margin are AI-only)
  const inP = (e) => !meta?.playable || e.pts.every((p) => p[0] >= meta.playable.minX - 0.05 && p[0] <= meta.playable.maxX + 0.05 && p[1] >= meta.playable.minZ - 0.05 && p[1] <= meta.playable.maxZ + 0.05);
  for (const e of graph.edges) if (e.car && inP(e)) cp[cf(e.a)] = cf(e.b);
  const cLen = new Map();
  for (const e of graph.edges) if (e.car && inP(e)) cLen.set(cf(e.a), (cLen.get(cf(e.a)) ?? 0) + e.len);
  const cSorted = [...cLen].sort((p, q) => q[1] - p[1]);
  const mainCar = cSorted[0]?.[0];
  if (cSorted.length > 1) info(`car network pockets the player cannot leave by road: ${cSorted.slice(1).map(([, l]) => Math.round(l) + ' m').join(', ')}`);
  // spawn points must lie on a car-drivable edge of the main network and head along it
  if (meta) for (const s of meta.spawnPoints ?? []) {
    let best = { d: Infinity, c: 0, e: null };
    for (const e of graph.edges) {
      if (!e.car) continue;
      for (let k = 1; k < e.pts.length; k++) {
        const a = e.pts[k - 1], b = e.pts[k];
        const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((s.x - a[0]) * dx + (s.z - a[1]) * dz) / l2));
        const d = Math.hypot(a[0] + dx * t - s.x, a[1] + dz * t - s.z);
        if (d < best.d) {
          const l = Math.sqrt(l2);
          best = { d, c: Math.abs((dx / l) * Math.sin(s.heading) + (dz / l) * Math.cos(s.heading)), e };
        }
      }
    }
    if (!best.e || best.d > best.e.width / 2 + 0.5) err(`spawn '${s.id}' is ${best.d.toFixed(1)} m from the nearest car road`);
    else if (best.c < 0.9) err(`spawn '${s.id}' heading not along the road (|cos| ${best.c.toFixed(2)})`);
    else if (cf(best.e.a) !== mainCar) err(`spawn '${s.id}' is on a car network pocket ('${best.e.name ?? best.e.type}'), not on the main network`);
    else info(`spawn ${s.id}: on '${best.e.name ?? best.e.type}' (${best.d.toFixed(2)} m off centre, |cos| ${best.c.toFixed(2)})`);
  }
}

// ------------------------------------------------------------------ props.json
const props = readJson('props.json');
if (props && playable) {
  const shapes = {
    trees: ['n', 'n', 'n', 'n'], lamps: ['n', 'n', 'n', 'n'], benches: ['n', 'n', 'n'], bollards: ['n', 'n'], parkedBikes: ['n', 'n', 'n'],
    parkedCars: ['n', 'n', 'n'], signs: ['n', 'n', 'n', 's'], streetNameSigns: ['n', 'n', 'n', 's'], trafficLights: ['n', 'n', 'n'], bins: ['n', 'n', 'n'],
  };
  const m = 150;
  const counts = [];
  for (const [k, shape] of Object.entries(shapes)) {
    const arr = props[k];
    if (!Array.isArray(arr)) { err(`props.${k} missing`); continue; }
    let bad = 0, outside = 0;
    for (const it of arr) {
      if (!Array.isArray(it) || it.length !== shape.length || !shape.every((t, i) => (t === 'n' ? fin(it[i]) : typeof it[i] === 'string' && it[i].length))) { bad++; continue; }
      if (it[0] < playable.minX - m || it[0] > playable.maxX + m || it[1] < playable.minZ - m || it[1] > playable.maxZ + m) outside++;
    }
    if (bad) err(`props.${k}: ${bad} malformed entries`);
    if (outside) err(`props.${k}: ${outside} entries far outside the playable rect`);
    counts.push(`${k} ${arr.length}`);
  }
  info(`props: ${counts.join(', ')}`);
  for (const k of ['trees', 'lamps', 'benches', 'parkedBikes', 'parkedCars', 'signs', 'streetNameSigns', 'trafficLights', 'bins', 'bollards']) {
    if (!props[k]?.length) err(`props.${k} is empty`);
  }
  if (props.trees?.some((t) => t[2] < 2 || t[2] > 40 || ![0, 1, 2].includes(t[3]))) err('props.trees: height/kind out of range');
  if (props.lamps?.some((t) => ![0, 1].includes(t[3]))) err('props.lamps: kind not 0/1');
}

// ------------------------------------------------------------------ map2d.json
const map2d = readJson('map2d.json');
if (map2d) {
  let bad = 0;
  for (const k of ['water', 'parks']) for (const poly of map2d[k] ?? []) for (const ring of poly) for (const p of ring) if (!fin(p[0]) || !fin(p[1])) bad++;
  if (bad) err(`map2d: ${bad} NaN points`);
  if (!map2d.bounds || !fin(map2d.bounds.minX)) err('map2d.bounds missing');
  info(`map2d: water ${map2d.water?.length} polys, parks ${map2d.parks?.length} polys`);
}

// ------------------------------------------------------------------ props vs water / sign mix
if (props && map2d?.water && graph) {
  const inRing = (x, z, r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c;
    }
    return c;
  };
  const wp = map2d.water.map((poly) => {
    const bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of poly[0]) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
    return { poly, bb };
  });
  const inWater = (x, z) => wp.some(({ poly, bb }) => x > bb[0] && x < bb[2] && z > bb[1] && z < bb[3] && inRing(x, z, poly[0]) && !poly.slice(1).some((h) => inRing(x, z, h)));
  // props on a bridge deck are fine: within (half width + 3 m) of a bridge edge
  const bridgeSegs = [];
  for (const e of graph.edges) if (e.bridge) for (let k = 1; k < e.pts.length; k++) bridgeSegs.push([e.pts[k - 1], e.pts[k], e.width / 2 + 3]);
  const onBridge = (x, z) => bridgeSegs.some(([a, b, r]) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2));
    return Math.hypot(a[0] + dx * t - x, a[1] + dz * t - z) < r;
  });
  // OSM water polygons overlap the quays in places: a candidate only counts when the ground
  // collision mesh has no land surface (y >= -0.05) under it either
  let cm = null;
  const landAt = (x, z) => {
    if (!cm) {
      const b = readFileSync(resolve(dataDir, 'collision_ground.bin'));
      const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const [vc, ic] = new Uint32Array(ab, 0, 2);
      cm = { V: new Float32Array(ab, 8, vc * 3), I: new Uint32Array(ab, 8 + vc * 12, ic) };
    }
    const { V, I } = cm;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const d = (V[b + 2] - V[c + 2]) * (V[a] - V[c]) + (V[c] - V[b]) * (V[a + 2] - V[c + 2]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((V[b + 2] - V[c + 2]) * (x - V[c]) + (V[c] - V[b]) * (z - V[c + 2])) / d;
      const l2 = ((V[c + 2] - V[a + 2]) * (x - V[c]) + (V[a] - V[c]) * (z - V[c + 2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      if (l1 * V[a + 1] + l2 * V[b + 1] + l3 * V[c + 1] >= -0.05) return true;
    }
    return false;
  };
  const wet = [];
  for (const k of ['parkedCars', 'signs', 'trees', 'lamps', 'benches', 'bins', 'parkedBikes', 'trafficLights', 'streetNameSigns']) {
    const n = (props[k] ?? []).filter((it) => inWater(it[0], it[1]) && !onBridge(it[0], it[1]) && !landAt(it[0], it[1])).length;
    if (n) wet.push(`${k} ${n}`);
  }
  if (wet.length) err(`props over water (not on a bridge): ${wet.join(', ')}`);
  const sc = {};
  for (const s of props.signs ?? []) sc[s[3]] = (sc[s[3]] ?? 0) + 1;
  info(`signs: ${Object.entries(sc).map(([c, n]) => `${c} ${n}`).join(', ')}`);
  if ((sc.C2 ?? 0) > 0.6 * (props.signs?.length ?? 0)) warn(`C2 dominates the signs (${sc.C2} of ${props.signs.length})`);
}

// ------------------------------------------------------------------ collision_ground.bin
{
  const p = resolve(dataDir, 'collision_ground.bin');
  if (!existsSync(p)) err('collision_ground.bin missing');
  else {
    const buf = readFileSync(p);
    const vc = buf.readUInt32LE(0), ic = buf.readUInt32LE(4);
    if (buf.byteLength !== 8 + vc * 12 + ic * 4) err(`collision_ground.bin size mismatch (${buf.byteLength} vs ${8 + vc * 12 + ic * 4})`);
    else {
      const pos = new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + vc * 12));
      const idx = new Uint32Array(buf.buffer.slice(buf.byteOffset + 8 + vc * 12, buf.byteOffset + 8 + vc * 12 + ic * 4));
      let nan = 0, yMin = Infinity, yMax = -Infinity, badIdx = 0;
      for (let i = 0; i < pos.length; i += 3) { if (!Number.isFinite(pos[i] + pos[i + 1] + pos[i + 2])) nan++; yMin = Math.min(yMin, pos[i + 1]); yMax = Math.max(yMax, pos[i + 1]); }
      for (const i of idx) if (i >= vc) badIdx++;
      if (nan) err(`collision: ${nan} NaN vertices`);
      if (badIdx) err(`collision: ${badIdx} indices out of range`);
      if (ic % 3) err('collision: index count not a multiple of 3');
      if (ic / 3 > BUDGET.collision) err(`collision: ${ic / 3} triangles > budget ${BUDGET.collision}`);
      if (yMin < -4 || yMax > 3) err(`collision: y range ${yMin}..${yMax}`);
      info(`collision: ${vc} vertices, ${ic / 3} triangles, y ${yMin.toFixed(2)}..${yMax.toFixed(2)}, ${(buf.byteLength / 1e6).toFixed(1)} MB`);
      if (graph) checkDrivable(pos, idx);
    }
  }
}

/**
 * Drives every car edge (bridges first-class) over the collision mesh: samples the top surface
 * every 0.5 m along the centre line and ±1 m beside it; a missing surface (hole) or a height
 * step > 0.1 m between consecutive samples is an error (curbs never cross a car road).
 */
function checkDrivable(pos, idx) {
  const CELL = 4;
  const grid = new Map();
  const triCount = idx.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ny = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (Math.abs(ny) < 1e-6) continue; // vertical faces
    const x0 = Math.min(pos[a], pos[b], pos[c]), x1 = Math.max(pos[a], pos[b], pos[c]);
    const z0 = Math.min(pos[a + 2], pos[b + 2], pos[c + 2]), z1 = Math.max(pos[a + 2], pos[b + 2], pos[c + 2]);
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const k = i * 65536 + j;
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(t);
    }
  }
  /** Highest walkable surface at (x, z) below maxY (null = hole). */
  const top = (x, z, maxY) => {
    const l = grid.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL));
    let best = null;
    for (const t of l ?? []) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const ax = pos[a], az = pos[a + 2], bx = pos[b], bz = pos[b + 2], cx = pos[c], cz = pos[c + 2];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
      const y = u * pos[a + 1] + v * pos[b + 1] + (1 - u - v) * pos[c + 1];
      if (y <= maxY && (best === null || y > best)) best = y;
    }
    return best;
  };
  // a "hole" must be a real gap, not a float-precision miss exactly on a T-junction vertex
  const topRobust = (x, z, maxY) => {
    const y = top(x, z, maxY);
    if (y !== null) return y;
    for (const [ox, oz] of [[0.05, 0], [-0.05, 0], [0, 0.05], [0, -0.05]]) { const q = top(x + ox, z + oz, maxY); if (q !== null) return q; }
    return null;
  };
  // vertical faces (quay / bridge walls, parapet and fence colliders) as plan segments + height range
  const vgrid = new Map();
  const vseg = [];
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ny = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (Math.abs(ny) >= 1e-6) continue;
    const P = [a, b, c];
    let bi = 0, bj = 1, bd = -1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) { const d = Math.hypot(pos[P[i]] - pos[P[j]], pos[P[i] + 2] - pos[P[j] + 2]); if (d > bd) { bd = d; bi = i; bj = j; } }
    if (bd < 1e-3) continue;
    const sg = [pos[P[bi]], pos[P[bi] + 2], pos[P[bj]], pos[P[bj] + 2], Math.min(pos[a + 1], pos[b + 1], pos[c + 1]), Math.max(pos[a + 1], pos[b + 1], pos[c + 1])];
    const k0 = vseg.length; vseg.push(sg);
    for (let i = Math.floor(Math.min(sg[0], sg[2]) / CELL); i <= Math.floor(Math.max(sg[0], sg[2]) / CELL); i++) for (let j = Math.floor(Math.min(sg[1], sg[3]) / CELL); j <= Math.floor(Math.max(sg[1], sg[3]) / CELL); j++) {
      const k = i * 65536 + j;
      let l = vgrid.get(k);
      if (!l) vgrid.set(k, (l = []));
      l.push(k0);
    }
  }
  const cross = (ax, az, bx, bz, cx, cz, dx, dz) => {
    const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz;
    const den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-12) return false;
    const t = ((cx - ax) * d2z - (cz - az) * d2x) / den, u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  /** a wall/railing (vertical collider reaching height y) between two plan points < CELL apart */
  const wallBetween = (x0, z0, x1, z1, y) => {
    const seen = new Set();
    for (const [x, z] of [[x0, z0], [x1, z1]]) for (const k of vgrid.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL)) ?? []) {
      if (seen.has(k)) continue;
      seen.add(k);
      const sg = vseg[k];
      if (y > sg[4] && y < sg[5] && cross(x0, z0, x1, z1, sg[0], sg[1], sg[2], sg[3])) return true;
    }
    return false;
  };
  const degree = new Map();
  for (const e of graph.edges) if (e.car) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  /** true when the height change between two samples 0.5 m apart is a discontinuity (> 4 cm
   *  within 5 cm, i.e. a kerb or ridge), false when it is a (steep) ramp */
  let maxGrade = 0;
  const isStep = (xa, za, xb, zb, ya) => {
    let p = ya;
    for (let k = 1; k <= 10; k++) {
      const x = xa + (xb - xa) * k / 10, z = za + (zb - za) * k / 10;
      const y = topRobust(x, z, p + 0.6);
      if (y === null) continue;
      if (Math.abs(y - p) > 0.04) return true;
      maxGrade = Math.max(maxGrade, Math.abs(y - p) / 0.05);
      p = y;
    }
    return false;
  };
  let holes = 0, steps = 0, walls = 0, edgesBad = 0, bridges = 0;
  const bad = [];
  for (const e of graph.edges) {
    if (!e.car) continue;
    if (e.bridge) bridges++;
    let eBad = false;
    for (const lat of [0, -1, 1]) {
      let prev = null;
      for (let k = 1; k < e.pts.length; k++) {
        const a = e.pts[k - 1], b = e.pts[k];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-3) continue;
        const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
        for (let s = 0; s < L; s += 0.5) {
          const x = a[0] + dx * s - dz * lat, z = a[1] + dz * s + dx * lat;
          // car dead ends (may continue as a path) stop at a kerb by design: skip the last 2.5 m
          const A = graph.nodes[e.a], B = graph.nodes[e.b];
          if ((degree.get(e.a) === 1 && Math.hypot(x - A[0], z - A[1]) < 2.5) || (degree.get(e.b) === 1 && Math.hypot(x - B[0], z - B[1]) < 2.5)) { prev = null; continue; }
          if (playable && (x < playable.minX || x > playable.maxX || z < playable.minZ || z > playable.maxZ)) { prev = null; continue; }
          const y = topRobust(x, z, (prev ?? 0) + 0.6);
          if (y !== null && prev !== null && wallBetween(x - dx * 0.5, z - dz * 0.5, x, z, Math.max(y, prev) + 0.45)) { walls++; eBad = true; if (bad.length < (process.env.CHECK_ALL ? 999 : 8)) bad.push(`wall/railing across the road at ${x.toFixed(1)},${z.toFixed(1)} (${e.name ?? e.type}${e.bridge ? ', bridge' : ''})`); }
          if (y === null) { holes++; eBad = true; if (bad.length < (process.env.CHECK_ALL ? 999 : 8)) bad.push(`hole at ${x.toFixed(1)},${z.toFixed(1)} (${e.name ?? e.type})`); prev = null; continue; }
          if (prev !== null && Math.abs(y - prev) > 0.1 && isStep(x - dx * 0.5, z - dz * 0.5, x, z, prev)) { steps++; eBad = true; if (bad.length < (process.env.CHECK_ALL ? 999 : 8)) bad.push(`step ${(y - prev).toFixed(2)} m at ${x.toFixed(1)},${z.toFixed(1)} (${e.name ?? e.type}${e.bridge ? ', bridge' : ''})`); }
          prev = y;
        }
      }
    }
    if (eBad) edgesBad++;
  }
  const msg = `drive test over car edges (${bridges} bridge edges): ${holes} holes, ${steps} kerbs/ridges, ${walls} walls/railings across the road on ${edgesBad} edges, steepest ramp ${(maxGrade * 100).toFixed(0)} %`;
  if (maxGrade > 0.35) warn(`ramps steeper than 35 % (${(maxGrade * 100).toFixed(0)} %)`);
  if (holes || steps || walls) {
    (holes > 0 || walls > 0 || steps > 20 ? err : warn)(msg);
    for (const b of bad) info('  ' + b);
  } else info(msg);

  // spawn points: holding W from the spawn must be safe. March 40 m straight ahead (centre and
  // +-1 m): no water / canal bed, hole, kerb, wall or railing, and no BAG building.
  const fpRings = (() => { try { return JSON.parse(readFileSync(resolve(dataDir, 'footprints.json'), 'utf8')).rings ?? []; } catch { return []; } })();
  const pip = (x, z, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const fpBB = fpRings.map((r) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const p of r) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); } return [x0, z0, x1, z1]; });
  const inBuilding = (x, z) => fpRings.some((r, i) => x >= fpBB[i][0] && x <= fpBB[i][2] && z >= fpBB[i][1] && z <= fpBB[i][3] && pip(x, z, r));
  for (const sp of meta?.spawnPoints ?? []) {
    const fx = Math.sin(sp.heading), fz = Math.cos(sp.heading);
    let problem = null;
    for (const lat of [0, -1, 1]) {
      let prev = null;
      for (let d = 0; d <= 40 && !problem; d += 0.5) {
        const x = sp.x + fx * d - fz * lat, z = sp.z + fz * d + fx * lat;
        const y = topRobust(x, z, (prev ?? 0) + 0.6);
        if (y === null) problem = `hole at ${d} m`;
        else if (y < -0.3) problem = `water / canal at ${d} m`;
        else if (prev !== null && Math.abs(y - prev) > 0.1 && isStep(x - fx * 0.5, z - fz * 0.5, x, z, prev)) problem = `kerb at ${d} m`;
        else if (prev !== null && wallBetween(x - fx * 0.5, z - fz * 0.5, x, z, Math.max(y, prev) + 0.45)) problem = `wall/railing at ${d} m`;
        else if (inBuilding(x, z)) problem = `building at ${d} m`;
        prev = y;
      }
    }
    if (problem) err(`spawn '${sp.id}': driving straight ahead hits ${problem}`);
    else info(`spawn ${sp.id}: 40 m straight ahead clear`);
  }
}

// ------------------------------------------------------------------ GLBs
if (meta && !quick) {
  const io = new NodeIO();
  let playTris = 0, bdTris = 0, waterTris = 0, bytes = 0, maxOver = 0;
  const matTris = {};
  for (const f of meta.groundFiles ?? []) {
    const p = resolve(dataDir, f);
    if (!existsSync(p)) continue;
    bytes += statSync(p).size;
    const doc = await io.read(p);
    const chunk = /^ground_(\d+)_(\d+)\.glb$/.exec(f);
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial()?.getName();
        if (!GROUND_MATS.has(mat)) err(`${f}: material '${mat}' not a ground MaterialClass`);
        const pos = prim.getAttribute('POSITION'), nrm = prim.getAttribute('NORMAL'), uv = prim.getAttribute('TEXCOORD_0'), ind = prim.getIndices();
        if (!pos || !nrm || !uv || !ind) { err(`${f}/${mat}: missing POSITION/NORMAL/TEXCOORD_0/indices`); continue; }
        if (!(ind.getArray() instanceof Uint32Array)) err(`${f}/${mat}: indices not uint32`);
        const a = pos.getArray(), n = nrm.getArray();
        let nan = 0, out = 0, yBad = 0, nBad = 0;
        for (let i = 0; i < a.length; i += 3) {
          const x = a[i], y = a[i + 1], z = a[i + 2];
          if (!Number.isFinite(x + y + z)) { nan++; continue; }
          if (chunk) {
            const minX = Number(chunk[1]) * 200 - 2000, minZ = Number(chunk[2]) * 200 - 2000;
            // bridge sides / bank slopes / bed skirts may poke a few metres past the chunk edge
            const over = Math.max(minX - x, x - minX - 200, minZ - z, z - minZ - 200);
            if (over > maxOver) maxOver = over;
            if (over > 15) out++;
          }
          if (y < -3.6 || y > 2.5) yBad++;
          if (Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) > 0.02) nBad++;
        }
        if (mat === 'water') for (let i = 1; i < a.length; i += 3) if (Math.abs(a[i] + 1.5) > 1e-3) { err(`${f}: water not at y=-1.5`); break; }
        const horiz = ['asphalt', 'klinkers', 'sidewalk', 'square', 'bikelane', 'grass', 'parking', 'canal_bed', 'ground', 'water', 'road_marking'];
        if (horiz.includes(mat)) {
          let down = 0;
          for (let i = 1; i < n.length; i += 3) if (n[i] < -0.1) down++;
          if (down) err(`${f}/${mat}: ${down} downward normals`);
        }
        if (nan) err(`${f}/${mat}: ${nan} NaN vertices`);
        if (out) err(`${f}/${mat}: ${out} vertices > 15 m outside the chunk`);
        if (yBad) err(`${f}/${mat}: ${yBad} vertices with y out of range`);
        if (nBad) err(`${f}/${mat}: ${nBad} non-unit normals`);
        const tris = ind.getCount() / 3;
        matTris[mat] = (matTris[mat] ?? 0) + tris;
        if (f === 'ground_backdrop.glb') bdTris += tris;
        else if (f === 'ground_water.glb') waterTris += tris;
        else playTris += tris;
      }
    }
  }
  info(`max vertex overshoot past a chunk edge: ${maxOver.toFixed(1)} m`);
  info(`ground GLBs: playable ${playTris} tris, backdrop ${bdTris}, water ${waterTris}, ${(bytes / 1e6).toFixed(1)} MB`);
  info(`per material: ${Object.entries(matTris).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (playTris > BUDGET.playable) err(`playable ground ${playTris} triangles > budget ${BUDGET.playable}`);
  if (bdTris > BUDGET.backdrop) err(`backdrop ground ${bdTris} triangles > budget ${BUDGET.backdrop}`);
}

console.log(`\nOSM check: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
