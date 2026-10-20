// Offline generator for public/assets/props/terraces.json (café terraces).
//
//   node src/world/props/dev/genTerraces.mjs
//
// Reads the raw OSM nodes (amenity = cafe / restaurant / bar / pub / ice_cream, minus
// outdoor_seating=no) and the processed city data (footprints + excluded hero footprints, water,
// roadgraph, props.json). For every café it finds the facade it belongs to, measures the free
// space in front of it (buildings, water, carriageways, cycleways, street furniture) and lays out
// a terrace there: bistro tables with chairs facing the street against the wall, four-seat tables
// further out, square parasols, glass windscreens and planters. The Kaasmarkt lots on the
// Waagplein stay clear. Output is a compact list of instances that src/world/props/terraces.ts
// instantiates at runtime (y from the ground height).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toLocal } from '../../../../tools/osm/lib/proj.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const nodes = rd('data-raw/osm/nodes.json').elements;
const footprints = rd('public/data/footprints.json').rings;
const bagMeta = rd('public/data/bag-meta.json');
const osmMeta = rd('public/data/osm-meta.json');
const map2d = rd('public/data/map2d.json');
const graph = rd('public/data/roadgraph.json');
const props = rd('public/data/props.json');

// Kaasmarkt lots (landmarks/kaasmarkt.ts site at runtime: centre (7, -12.7), rot 0.507,
// 35.2 x 12.8 m) + a walking margin. Terraces must not touch this rectangle.
const KAAS = { x: 7, z: -12.73, rot: 0.5075, hl: 35.19 / 2 + 4, hw: 12.82 / 2 + 4 };
const inKaas = (x, z) => {
  const dx = x - KAAS.x, dz = z - KAAS.z;
  const c = Math.cos(KAAS.rot), s = Math.sin(KAAS.rot);
  // length along (sin rot, cos rot) (heading convention), width across
  const a = dx * s + dz * c, b = dx * c - dz * s;
  return Math.abs(a) < KAAS.hl && Math.abs(b) < KAAS.hw;
};

// ------------------------------------------------------------------------------------ helpers
function pip(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function distSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}
class Grid {
  constructor(cs) { this.cs = cs; this.m = new Map(); }
  key(i, j) { return i * 100003 + j; }
  addBox(minX, minZ, maxX, maxZ, item) {
    const cs = this.cs;
    for (let i = Math.floor(minX / cs); i <= Math.floor(maxX / cs); i++)
      for (let j = Math.floor(minZ / cs); j <= Math.floor(maxZ / cs); j++) {
        const k = this.key(i, j);
        let a = this.m.get(k);
        if (!a) this.m.set(k, (a = []));
        a.push(item);
      }
  }
  near(x, z, r) {
    const out = new Set(), cs = this.cs;
    for (let i = Math.floor((x - r) / cs); i <= Math.floor((x + r) / cs); i++)
      for (let j = Math.floor((z - r) / cs); j <= Math.floor((z + r) / cs); j++) for (const it of this.m.get(this.key(i, j)) ?? []) out.add(it);
    return out;
  }
}
const bbox = (ring) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, z] of ring) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return [a, b, c, d];
};

// buildings (incl. hero footprints excluded from footprints.json)
const rings = [...footprints];
for (const e of bagMeta.excludedInfo ?? []) if (e.footprint?.length >= 3) rings.push(e.footprint);
for (const l of osmMeta.landmarks ?? []) if (l.footprint?.length >= 3) rings.push(l.footprint);
const bGrid = new Grid(20);
rings.forEach((r) => { const b = bbox(r); bGrid.addBox(b[0], b[1], b[2], b[3], r); });
const inBuilding = (x, z) => { for (const r of bGrid.near(x, z, 0)) if (pip(x, z, r)) return r; return null; };

// water
const wGrid = new Grid(40);
for (const poly of map2d.water) { if (!poly[0]) continue; const b = bbox(poly[0]); wGrid.addBox(b[0], b[1], b[2], b[3], poly); }
const inWater = (x, z) => {
  for (const poly of wGrid.near(x, z, 0)) {
    if (!pip(x, z, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (pip(x, z, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
};

// carriageways + cycleways (clearance from the centre line)
const rGrid = new Grid(25);
for (const e of graph.edges) {
  const cycle = !e.car && e.bike && e.type === 'cycleway';
  if (!e.car && !cycle) continue;
  const clear = (e.width || (e.car ? 5 : 2.2)) / 2 + (e.car ? 0.5 : 0.3);
  for (let i = 0; i + 1 < e.pts.length; i++) {
    const [ax, az] = e.pts[i], [bx, bz] = e.pts[i + 1];
    rGrid.addBox(Math.min(ax, bx) - clear, Math.min(az, bz) - clear, Math.max(ax, bx) + clear, Math.max(az, bz) + clear, [ax, az, bx, bz, clear]);
  }
}
const onRoad = (x, z) => { for (const s of rGrid.near(x, z, 0)) if (distSeg(x, z, s[0], s[1], s[2], s[3]) < s[4]) return true; return false; };

// street furniture / trees / parked bikes and cars: [x, z, radius]
const oGrid = new Grid(10);
const addObs = (x, z, r) => oGrid.addBox(x - r, z - r, x + r, z + r, [x, z, r]);
for (const [x, z] of props.trees ?? []) addObs(x, z, 0.45);
for (const [x, z] of props.lamps ?? []) addObs(x, z, 0.3);
for (const [x, z] of props.benches ?? []) addObs(x, z, 1.0);
for (const [x, z] of props.bollards ?? []) addObs(x, z, 0.25);
for (const [x, z] of props.bins ?? []) addObs(x, z, 0.45);
for (const [x, z] of props.parkedBikes ?? []) addObs(x, z, 0.9);
for (const [x, z] of props.parkedCars ?? []) addObs(x, z, 2.5);
for (const [x, z] of props.signs ?? []) addObs(x, z, 0.3);
for (const [x, z] of props.streetNameSigns ?? []) addObs(x, z, 0.3);
for (const [x, z] of props.trafficLights ?? []) addObs(x, z, 0.4);
const obstacle = (x, z, r) => { for (const o of oGrid.near(x, z, r)) if (Math.hypot(o[0] - x, o[1] - z) < o[2] + r) return true; return false; };
const treeNear = (x, z, r) => { for (const [tx, tz] of props.trees ?? []) if (Math.abs(tx - x) < r && Math.abs(tz - z) < r && Math.hypot(tx - x, tz - z) < r) return true; return false; };

const blocked = (x, z) => !!inBuilding(x, z) || inWater(x, z) || onRoad(x, z) || inKaas(x, z);

// terrace occupancy (0.5 m cells) so neighbouring cafés do not overlap
const occ = new Set();
const occKey = (x, z) => `${Math.round(x * 2)},${Math.round(z * 2)}`;

// deterministic rng
let seed = 1234567;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const range = (a, b) => a + (b - a) * rnd();

// ------------------------------------------------------------------------------------ cafés
const pr = osmMeta.playable;
const cafes = [];
for (const e of nodes) {
  const t = e.tags;
  if (!t || !/^(cafe|restaurant|bar|pub|ice_cream)$/.test(t.amenity ?? '')) continue;
  if (t.outdoor_seating === 'no') continue;
  const [x, z] = toLocal(e.lat, e.lon);
  if (x < pr.minX + 20 || x > pr.maxX - 20 || z < pr.minZ + 20 || z > pr.maxZ - 20) continue;
  // explicit terraces / outdoor seating first: they claim the space before plain restaurants
  const prio = /^terras/i.test(t.name ?? '') || ['yes', 'terrace', 'sidewalk', 'pedestrian_zone'].includes(t.outdoor_seating) ? 0 : 1;
  cafes.push({ x, z, prio, kind: t.amenity, name: t.name ?? '' });
}
cafes.sort((a, b) => a.prio - b.prio || a.x - b.x || a.z - b.z);

/** Facade candidates: edges of the café's own building, else of buildings within 14 m. */
function facadeFor(c) {
  const own = inBuilding(c.x, c.z);
  const cand = own ? [own] : [...bGrid.near(c.x, c.z, 14)];
  let best = null;
  for (const ring of cand) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % n];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 3) continue;
      const ex = (bx - ax) / len, ez = (bz - az) / len;
      let nx = -ez, nz = ex;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (pip(mx + nx * 0.4, mz + nz * 0.4, ring)) { nx = -nx; nz = -nz; }
      const t = Math.max(1.2, Math.min(len - 1.2, (c.x - ax) * ex + (c.z - az) * ez));
      const fx = ax + ex * t, fz = az + ez * t;
      // must face open ground
      if (blocked(fx + nx * 1.0, fz + nz * 1.0)) continue;
      // a café outside its building must be on the open side of that facade
      if (!own && (c.x - fx) * nx + (c.z - fz) * nz < -0.5) continue;
      const d = Math.hypot(c.x - fx, c.z - fz);
      if (d > (own ? 30 : 14)) continue;
      if (!best || d < best.d) best = { d, ax, az, ex, ez, nx, nz, len, t };
    }
  }
  return best;
}

const out = { tables: [], chairs: [], parasols: [], screens: [], planters: [], areas: [] };
let made = 0;
for (const c of cafes) {
  const f = facadeFor(c);
  if (!f) continue;
  // terrace extent along the facade (within the edge, 0.4 m from the corners)
  const u0 = Math.max(0.4, f.t - range(4, 6.5)), u1 = Math.min(f.len - 0.4, f.t + range(4, 6.5));
  const L = u1 - u0;
  if (L < 2.6) continue;
  const P = (u, v) => [f.ax + f.ex * u + f.nx * v, f.az + f.ez * u + f.nz * v];
  // free depth: first blocked sample on 3 probe lines
  let free = 12;
  for (const u of [u0 + 0.3, (u0 + u1) / 2, u1 - 0.3]) {
    for (let v = 0.4; v < free; v += 0.25) {
      const [x, z] = P(u, v);
      if (blocked(x, z)) { free = v; break; }
    }
  }
  const square = free >= 11.5;
  let depth = square ? Math.min(6.2, free - 4) : Math.min(3.4, free - 1.8);
  if (depth < 1.2) continue;
  // reject overlap with an earlier terrace
  let hit = 0, tot = 0;
  for (let u = u0; u <= u1; u += 0.5) for (let v = 0.25; v <= depth; v += 0.5) { tot++; const [x, z] = P(u, v); if (occ.has(occKey(x, z))) hit++; }
  if (hit > tot * 0.1) continue;
  for (let u = u0 - 0.5; u <= u1 + 0.5; u += 0.5) for (let v = 0; v <= depth + 0.5; v += 0.5) { const [x, z] = P(u, v); occ.add(occKey(x, z)); }

  const rotOut = Math.atan2(f.nx, f.nz); // heading convention: +z forward rotated by rotY
  const style = Math.floor(rnd() * 6);
  const chairCol = Math.floor(rnd() * 5);
  const tableCol = Math.floor(rnd() * 3);
  const startCount = out.tables.length;
  // front row: bistro tables against the wall, two chairs facing the street
  const rows = [];
  for (let v = 0.75; v + 0.45 <= depth; v += 1.55) rows.push(v);
  rows.forEach((v, k) => {
    const four = k > 0 && v + 0.9 <= depth;
    const pitch = four ? 2.15 : 1.75;
    const n = Math.max(1, Math.floor((L - 0.4) / pitch));
    const off = (L - n * pitch) / 2 + pitch / 2;
    for (let i = 0; i < n; i++) {
      const u = u0 + off + i * pitch + range(-0.12, 0.12);
      const vv = v + (four ? 0.35 : 0) + range(-0.08, 0.08);
      const [tx, tz] = P(u, vv);
      if (obstacle(tx, tz, four ? 1.1 : 0.8) || blocked(tx, tz)) continue;
      out.tables.push([+tx.toFixed(2), +tz.toFixed(2), +(rotOut + range(-0.15, 0.15)).toFixed(3), four ? 1 : 0, tableCol]);
      // four-seat: chairs around, facing the table; bistro: two chairs behind it facing the street
      const seats = four ? [[-0.62, 0], [0.62, 0], [0, -0.62], [0, 0.62]] : [[-0.36, -0.5], [0.36, -0.5]];
      for (const [du, dv] of seats) {
        if (rnd() < 0.08) continue; // a chair taken away
        const [cx, cz] = P(u + du + range(-0.06, 0.06), vv + dv + range(-0.06, 0.06));
        if (blocked(cx, cz)) continue;
        const yaw = four ? Math.atan2(tx - cx, tz - cz) : rotOut;
        out.chairs.push([+cx.toFixed(2), +cz.toFixed(2), +(yaw + range(-0.25, 0.25)).toFixed(3), chairCol]);
      }
    }
  });
  if (out.tables.length === startCount) continue;
  // parasols: square ones over the terrace (deep terraces), small round ones on narrow strips
  const big = depth >= 2.4;
  const pitch = big ? 3.3 : 2.6;
  const np = Math.max(1, Math.floor(L / pitch));
  const pv = big ? Math.min(depth / 2 + 0.2, 2.6) : 1.0;
  for (let i = 0; i < np; i++) {
    const u = u0 + (L - np * pitch) / 2 + pitch / 2 + i * pitch;
    const [px, pz] = P(u, pv);
    if (obstacle(px, pz, 0.3) || treeNear(px, pz, big ? 3.2 : 2.4) || blocked(px, pz)) continue;
    out.parasols.push([+px.toFixed(2), +pz.toFixed(2), +rotOut.toFixed(3), big ? 1 : 0, style]);
  }
  // windscreens along the outer edge (+ ends) or planters at the outer corners
  if (depth >= 1.9 && rnd() < 0.55) {
    const vs = depth + 0.1;
    const seg = 1.6;
    const ns = Math.max(1, Math.round(L / seg));
    const sl = L / ns;
    for (let i = 0; i < ns; i++) {
      const [sx, sz] = P(u0 + (i + 0.5) * sl, vs);
      if (obstacle(sx, sz, 0.3) || blocked(sx, sz)) continue;
      out.screens.push([+sx.toFixed(2), +sz.toFixed(2), +rotOut.toFixed(3), +sl.toFixed(2), style]);
    }
    for (const u of [u0 - 0.05, u1 + 0.05]) {
      const ne = Math.max(1, Math.round((vs - 0.4) / seg));
      const el = (vs - 0.4) / ne;
      for (let i = 0; i < ne; i++) {
        const [sx, sz] = P(u, 0.4 + (i + 0.5) * el);
        if (obstacle(sx, sz, 0.3) || blocked(sx, sz)) continue;
        out.screens.push([+sx.toFixed(2), +sz.toFixed(2), +(rotOut + Math.PI / 2).toFixed(3), +el.toFixed(2), style]);
      }
    }
  } else {
    for (const u of [u0 + 0.35, u1 - 0.35]) {
      const [qx, qz] = P(u, depth);
      if (obstacle(qx, qz, 0.5) || blocked(qx, qz)) continue;
      out.planters.push([+qx.toFixed(2), +qz.toFixed(2), +(rotOut + range(-0.1, 0.1)).toFixed(3)]);
    }
  }
  // walkable rectangle for the runtime collider: centre, rot, half length, half depth
  const [cx, cz] = P((u0 + u1) / 2, (depth + 0.1) / 2);
  out.areas.push([+cx.toFixed(2), +cz.toFixed(2), +rotOut.toFixed(3), +(L / 2).toFixed(2), +((depth + 0.1) / 2).toFixed(2)]);
  made++;
}

const file = path.join(ROOT, 'public/assets/props/terraces.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const json = { version: 1, source: 'OpenStreetMap amenity nodes (ODbL) + city data', ...out };
fs.writeFileSync(file, JSON.stringify(json));
console.log(`terrassen: ${made} van ${cafes.length} horecapunten; tafels ${out.tables.length}, stoelen ${out.chairs.length}, parasols ${out.parasols.length}, schermen ${out.screens.length}, bakken ${out.planters.length}; ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
