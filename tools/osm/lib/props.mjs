// Street furniture and vegetation placement -> public/data/props.json (PropsData).
//
// Sources: OSM point features (trees, tree rows, benches, bollards, waste baskets, bicycle
// parking, traffic signs/signals, give-way nodes) PLUS generated, plausible placements where OSM
// is sparse (typical for Alkmaar): lanterns along streets, trees along canal quays and in parks,
// parked bicycles along canal edges / facades of shopping streets, corner bollards, street-name
// signs at junctions, one C2 no-entry sign per one-way street (D2 on dual-carriageway medians, C1 at
// pedestrian streets, E4 at parking lots), parked cars on mapped on-street
// parking strips and parking lots.
//
// Every candidate is validated against the ground partition (Locator: water / low road surfaces
// / raised pavement / decks) and against building footprints (OSM + 3D BAG), so nothing stands
// in a road, in a canal or inside a house.
//
// Rotation conventions (match src/world/props): rotY rotates the model's local +z axis, i.e. the
// model's +z points to (sin rotY, cos rotY) in world xz.
//   * sign / street-name sign / traffic light: +z = the face normal (towards the viewer)
//   * modern lamp: +z = arm direction (towards the road); bench: +z = where the sitter looks
//   * parked bike / car: +z = front of the vehicle
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import RBush from 'rbush';
import { inBinnenstad } from './features.mjs';
import { bboxOfPts, cumLengths, dirOf, inRect, leftN, pointAt, pointInPoly, pointInRing, round, segDist2, segIntersectT } from './geom.mjs';

const r2 = (v) => round(v, 2);
/** Normalised, rounded angle in (-PI, PI]. */
const ang = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return round(a, 3);
};
/** rotY whose +z axis points along (dx, dz). */
const rotTo = (dx, dz) => Math.atan2(dx, dz);
/** Deterministic hash -> [0, 1) from a position and salt (stable across runs). */
function h01(x, z, salt = 0) {
  let h = Math.imul(Math.round(x * 10) | 0, 73856093) ^ Math.imul(Math.round(z * 10) | 0, 19349663) ^ Math.imul(salt + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Uniform hash grid for "anything within r?" spacing checks. */
class PGrid {
  constructor(cell = 8) { this.cell = cell; this.m = new Map(); }
  key(i, j) { return i * 100003 + j; }
  add(x, z) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let a = this.m.get(k);
    if (!a) this.m.set(k, (a = []));
    a.push(x, z);
  }
  near(x, z, r) {
    const c = this.cell, i0 = Math.floor((x - r) / c), i1 = Math.floor((x + r) / c), j0 = Math.floor((z - r) / c), j1 = Math.floor((z + r) / c);
    const r2_ = r * r;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(this.key(i, j));
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) { const dx = a[k] - x, dz = a[k + 1] - z; if (dx * dx + dz * dz < r2_) return true; }
    }
    return false;
  }
}

/** Molen van Piet (BAG centroid): keep trees and lamps away from the sails. */
const MOLEN = [-564.65, 146.41];
const CAR_LAYERS = new Set(['carA', 'carK', 'carG', 'lanes']);
const SMALL_GENERA = /^(prunus|malus|sorbus|crataegus|magnolia|pyrus|amelanchier|cercis|corylus|syringa|cornus|laburnum|ilex)/i;

/**
 * @param {object} p
 * @param {any} p.osm  loaded OSM (nodes/ways)
 * @param {any} p.F    extracted features
 * @param {{nodes:[number,number][], edges:any[]}} p.graph
 * @param {any} p.loc  global Locator of the playable ground
 * @param {any} p.detail rect of the detailed ground
 * @param {any[]} p.roads classified roads near the detail rect
 * @param {any} p.RP   road pieces (flush set, parking strips)
 * @param {any} [p.meta] OsmMeta (landmarks + spawn points: tree clearances / sightlines)
 */
export function buildProps({ osm, F, graph, loc, detail, roads, RP, meta }) {
  const out = { trees: [], lamps: [], benches: [], bollards: [], parkedBikes: [], parkedCars: [], signs: [], streetNameSigns: [], trafficLights: [], bins: [] };
  const inside = (x, z, m = 0) => x > detail.minX + m && x < detail.maxX - m && z > detail.minZ + m && z < detail.maxZ - m;

  // ------------------------------------------------------------------ site queries
  const site = (x, z) => loc.locate(x, z);
  const isCar = (r) => r && ((r.kind === 'low' && CAR_LAYERS.has(r.layer)) || r.kind === 'deck');
  const isPedLow = (r) => r && r.kind === 'low' && (r.layer === 'pedK' || r.layer === 'pedA' || r.layer === 'square');
  const isRaised = (r) => r && r.kind === 'raised';
  /** pavement / grass / pedestrian surface a prop may stand on (not road, water, deck, curb strip) */
  const walkable = (r) => r && ((r.kind === 'raised' && !r.curbStrip && r.layer !== 'rail' && r.layer !== 'platform') || isPedLow(r));

  // buildings: OSM polygons + 3D BAG footprints (what is actually rendered)
  const bItems = [];
  for (const b of F.buildings) if (Number.isFinite(b.bb[0])) bItems.push({ minX: b.bb[0], minY: b.bb[1], maxX: b.bb[2], maxY: b.bb[3], ring: b.poly[0] });
  const fpFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/data/footprints.json');
  if (existsSync(fpFile)) {
    for (const ring of JSON.parse(readFileSync(fpFile, 'utf8')).rings) {
      const bb = bboxOfPts(ring);
      bItems.push({ minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3], ring });
    }
  }
  const BT = new RBush();
  BT.load(bItems);
  /** Distance to the nearest building wall (0 inside), capped at maxR; nx/nz = unit vector building -> point. */
  const bNear = (x, z, maxR = 6) => {
    let best = maxR, nx = 0, nz = 0;
    for (const h of BT.search({ minX: x - maxR, minY: z - maxR, maxX: x + maxR, maxY: z + maxR })) {
      const ring = h.ring;
      if (x >= h.minX && x <= h.maxX && z >= h.minY && z <= h.maxY && pointInRing(x, z, ring)) return { d: 0, nx: 0, nz: 0 };
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const r = segDist2(x, z, a[0], a[1], b[0], b[1]);
        if (r.d2 < best * best) {
          best = Math.sqrt(r.d2);
          const qx = a[0] + (b[0] - a[0]) * r.t, qz = a[1] + (b[1] - a[1]) * r.t;
          nx = (x - qx) / (best || 1); nz = (z - qz) / (best || 1);
        }
      }
    }
    return { d: best, nx, nz };
  };
  const bDist = (x, z, maxR = 6) => bNear(x, z, maxR).d;

  // graph segments for "nearest road" queries
  const segTree = new RBush();
  {
    const items = [];
    graph.edges.forEach((e, ei) => {
      for (let k = 1; k < e.pts.length; k++) {
        const a = e.pts[k - 1], b = e.pts[k];
        items.push({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]), ei, k });
      }
    });
    segTree.load(items);
  }
  /** Nearest graph edge segment (optionally filtered) within maxR: { e, d, qx, qz, dx, dz, s } */
  const nearestEdge = (x, z, maxR = 25, filter = null) => {
    let best = null;
    for (const h of segTree.search({ minX: x - maxR, minY: z - maxR, maxX: x + maxR, maxY: z + maxR })) {
      const e = graph.edges[h.ei];
      if (filter && !filter(e)) continue;
      const a = e.pts[h.k - 1], b = e.pts[h.k];
      const r = segDist2(x, z, a[0], a[1], b[0], b[1]);
      if (r.d2 > maxR * maxR || (best && r.d2 >= best.d2)) continue;
      const d = dirOf(a, b);
      best = { e, d2: r.d2, qx: a[0] + (b[0] - a[0]) * r.t, qz: a[1] + (b[1] - a[1]) * r.t, dx: d[0], dz: d[1], k: h.k, t: r.t };
    }
    if (best) best.d = Math.sqrt(best.d2);
    return best;
  };
  const carEdge = (e) => e.car;

  // node degrees in the graph (all modes / car only)
  const deg = new Map(), carDeg = new Map(), nodeEdges = new Map();
  graph.edges.forEach((e) => {
    for (const n of [e.a, e.b]) {
      deg.set(n, (deg.get(n) ?? 0) + 1);
      if (e.car) carDeg.set(n, (carDeg.get(n) ?? 0) + 1);
      if (!nodeEdges.has(n)) nodeEdges.set(n, []);
      nodeEdges.get(n).push(e);
    }
  });

  const treeGrid = new PGrid(8), lampGrid = new PGrid(16), bikeGrid = new PGrid(4), benchGrid = new PGrid(16);
  const signGrid = new PGrid(8), carGrid = new PGrid(6), bollardGrid = new PGrid(4), binGrid = new PGrid(16);
  const tagNodes = osm.nodes.filter((n) => inside(n.x, n.z));

  // ------------------------------------------------------------------ trees
  // Landmark clearances. Molenbiotoop around the Molen van Piet: no trees within 30 m, lower trees
  // out to 100 m so the sails stay visible from the Singel; no trees crowding the Accijnstoren;
  // open sightlines from the landmark spawn points to their landmark.
  const LM = Object.fromEntries((meta?.landmarks ?? []).map((l) => [l.id, l]));
  const mill = LM.molen_van_piet ? [LM.molen_van_piet.x, LM.molen_van_piet.z] : MOLEN;
  const ringDist = (x, z, r) => {
    if (pointInRing(x, z, r)) return 0;
    let d2 = Infinity;
    for (let i = 0; i < r.length; i++) { const j = (i + 1) % r.length; d2 = Math.min(d2, segDist2(x, z, r[i][0], r[i][1], r[j][0], r[j][1]).d2); }
    return Math.sqrt(d2);
  };
  const keepClear = [['accijnstoren', 12], ['waag', 6]].filter(([id]) => LM[id]?.footprint).map(([id, m]) => [LM[id].footprint, m]);
  const SPAWN_LM = { waag: 'waag', grote_kerk: 'grote_kerk', molen: 'molen_van_piet', station: 'station' };
  const sightlines = (meta?.spawnPoints ?? []).filter((sp) => LM[SPAWN_LM[sp.id]]).map((sp) => [sp.x, sp.z, LM[SPAWN_LM[sp.id]].x, LM[SPAWN_LM[sp.id]].z]);
  const treeStats = { mill: 0, millCapped: 0, landmark: 0, sightline: 0 };
  const addTree = (x, z, h, kind) => {
    const dm = Math.hypot(x - mill[0], z - mill[1]);
    if (dm < 30) { treeStats.mill++; return; }
    if (dm < 100) {
      const cap = 7 + (dm - 30) * 0.1;
      if (h > cap) { h = cap; treeStats.millCapped++; if (kind === 0 && cap < 9) kind = 1; }
    }
    for (const [ring, m] of keepClear) if (ringDist(x, z, ring) < m) { treeStats.landmark++; return; }
    for (const [ax, az, bx, bz] of sightlines) if (segDist2(x, z, ax, az, bx, bz).d2 < 3.5 * 3.5) { treeStats.sightline++; return; }
    out.trees.push([r2(x), r2(z), round(h, 1), kind]);
    treeGrid.add(x, z);
  };
  const treeSiteOk = (x, z, clearB = 2.5) => {
    if (Math.hypot(x - MOLEN[0], z - MOLEN[1]) < 16) return false; // windmill sails sweep ~12 m
    const r = site(x, z);
    if (!r || isCar(r) || (r.kind === 'raised' && r.curbStrip) || r.layer === 'rail' || r.layer === 'platform') return false;
    return bDist(x, z, clearB + 0.5) >= clearB;
  };
  const treeHeight = (x, z, kind) => kind === 1 ? 5 + h01(x, z, 3) * 3 : kind === 2 ? 9 + h01(x, z, 3) * 6 : 11 + h01(x, z, 3) * 7;
  for (const n of tagNodes) {
    if (n.tags.natural !== 'tree') continue;
    if (!treeSiteOk(n.x, n.z, 1.0)) continue;
    const t = n.tags;
    let h = parseFloat(t.height);
    let kind = t.leaf_type === 'needleleaved' ? 2 : SMALL_GENERA.test(t.genus ?? t.species ?? '') ? 1 : 0;
    if (Number.isFinite(h) && h < 7 && kind === 0) kind = 1;
    if (!Number.isFinite(h) || h < 2 || h > 35) h = treeHeight(n.x, n.z, kind);
    addTree(n.x, n.z, h, kind);
  }
  for (const tr of F.treeRows) {
    const cum = cumLengths(tr.pts), L = cum[cum.length - 1];
    for (let s = 2; s < L; s += 8.5) {
      const p = pointAt(tr.pts, cum, s);
      if (!inside(p.x, p.z) || treeGrid.near(p.x, p.z, 5) || !treeSiteOk(p.x, p.z, 1.5)) continue;
      addTree(p.x, p.z, treeHeight(p.x, p.z, 0), 0);
    }
  }

  // ---- canal edges (binnenstad): quay trees, bikes against the railing, benches facing the water
  /** Samples along water boundaries: { x, z, tx, tz (along edge), ix, iz (inland normal) } */
  const waterEdges = [];
  for (const w of F.water) {
    if (!(w.bb[2] > detail.minX && w.bb[0] < detail.maxX && w.bb[3] > detail.minZ && w.bb[1] < detail.maxZ)) continue;
    for (const ring of w.poly) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 0.5) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
        const [nx, nz] = leftN(tx, tz);
        for (let s = 0.5; s < L; s += 1.5) {
          const x = a[0] + tx * s, z = a[1] + tz * s;
          if (!inside(x, z, 2)) continue;
          const A = site(x + nx * 1.2, z + nz * 1.2), B = site(x - nx * 1.2, z - nz * 1.2);
          if (!!A === !!B) continue; // inner seam between water polygons, or both land
          const sg = A ? 1 : -1;
          if ((A ?? B).kind === 'deck') continue;
          waterEdges.push({ x, z, tx, tz, ix: nx * sg, iz: nz * sg, bin: inBinnenstad(x, z) });
        }
      }
    }
  }
  // quay trees every ~9 m where there is a pavement / grass strip of >= 2.6 m along the water
  {
    let lastS = -Infinity, run = 0;
    for (const e of waterEdges) {
      run += 1.5;
      if (run - lastS < 9) continue;
      const x = e.x + e.ix * 1.7, z = e.z + e.iz * 1.7;
      if (treeGrid.near(x, z, 7)) continue;
      const strip = [0.8, 1.7, 2.6].every((d) => walkable(site(e.x + e.ix * d, e.z + e.iz * d)));
      if (!strip || !treeSiteOk(x, z, 3)) continue;
      // binnenstad: dense canal trees; elsewhere only every other slot
      if (!e.bin && h01(x, z, 7) < 0.5) continue;
      addTree(x, z, e.bin ? 12 + h01(x, z, 4) * 7 : treeHeight(x, z, 0), 0);
      lastS = run;
    }
  }
  // parks, green banks of the Singel, woods: jittered grid scatter
  for (const g of F.grass) {
    if (!(g.bb[2] > detail.minX && g.bb[0] < detail.maxX && g.bb[3] > detail.minZ && g.bb[1] < detail.maxZ)) continue;
    const spacing = g.kind === 'wood' ? 6 : g.kind === 'park' ? 11 : 17;
    const keep = g.kind === 'grass' ? 0.55 : 0.85;
    for (let x = Math.ceil(g.bb[0] / spacing) * spacing; x < g.bb[2]; x += spacing) {
      for (let z = Math.ceil(g.bb[1] / spacing) * spacing; z < g.bb[3]; z += spacing) {
        const px = x + (h01(x, z, 21) - 0.5) * spacing * 0.8, pz = z + (h01(x, z, 22) - 0.5) * spacing * 0.8;
        if (!inside(px, pz) || h01(x, z, 23) > keep || !pointInPoly(px, pz, g.poly)) continue;
        const r = site(px, pz);
        if (!r || r.mat !== 'grass' || r.garden) continue;
        if (treeGrid.near(px, pz, spacing * 0.55)) continue;
        // keep off paths and away from the water's edge
        let ok = true;
        for (let k = 0; k < 6 && ok; k++) {
          const a = (k / 6) * Math.PI * 2;
          const q = site(px + Math.cos(a) * 2.2, pz + Math.sin(a) * 2.2);
          if (!q || q.mat !== 'grass') ok = false;
        }
        if (!ok || bDist(px, pz, 4) < 3.5 || Math.hypot(px - MOLEN[0], pz - MOLEN[1]) < 16) continue;
        const u = h01(px, pz, 24);
        const kind = g.kind === 'wood' ? (u < 0.25 ? 2 : 0) : u < 0.12 ? 2 : u < 0.3 ? 1 : 0;
        addTree(px, pz, treeHeight(px, pz, kind), kind);
      }
    }
  }

  // ------------------------------------------------------------------ lamps
  const addLamp = (x, z, rot, kind) => { out.lamps.push([r2(x), r2(z), ang(rot), kind]); lampGrid.add(x, z); };
  for (const n of tagNodes) {
    if (n.tags.highway !== 'street_lamp') continue;
    const ne = nearestEdge(n.x, n.z, 20);
    const rot = ne ? rotTo(ne.qx - n.x, ne.qz - n.z) : 0;
    addLamp(n.x, n.z, rot, inBinnenstad(n.x, n.z) ? 0 : 1);
  }
  /**
   * Walk outwards from the centre line on one side and return the first spot where a pole can
   * stand: on pavement/grass (or against the facade of a flush street), clear of walls.
   */
  const roadsideSpot = (p, nx, nz, hw, flush, minB = 0.45, maxOut = 4.5) => {
    for (let d = hw + 0.55; d <= hw + maxOut; d += 0.3) {
      const x = p.x + nx * d, z = p.z + nz * d;
      const r = site(x, z);
      if (!r) return null; // water
      const b = bDist(x, z, 2);
      if (b < minB) return null; // reached a wall
      if (r.kind === 'deck' || (r.kind === 'raised' && r.curbStrip)) continue;
      if (r.layer === 'rail' || r.layer === 'platform') return null; // railway fence
      if (isCar(r)) { if (flush && b < 1.0) return { x, z, d }; continue; }
      return { x, z, d };
    }
    return null;
  };
  for (const rd of roads) {
    if (rd.bridge) continue;
    const isRoad = rd.kind === 'car' || rd.kind === 'ped';
    if (!isRoad && rd.kind !== 'cycle') continue;
    if (rd.kind === 'car' && rd.hw === 'service' && !rd.name) continue;
    const cum = cumLengths(rd.pts), L = cum[cum.length - 1];
    const mid = rd.pts[Math.floor(rd.pts.length / 2)];
    const binnen = inBinnenstad(mid[0], mid[1]);
    const spacing = rd.kind === 'cycle' ? 36 : binnen ? 26 : 32;
    const flush = RP.flush.has(rd.id) || rd.kind === 'ped';
    const main = ['primary', 'secondary', 'tertiary', 'trunk'].includes(rd.hw);
    let side = h01(mid[0], mid[1], 31) < 0.5 ? 1 : -1;
    for (let s = 4 + h01(mid[0], mid[1], 32) * spacing * 0.5; s < L - 2; s += spacing) {
      const p = pointAt(rd.pts, cum, s);
      if (!inside(p.x, p.z)) continue;
      side = -side;
      const [nx, nz] = leftN(p.dx, p.dz);
      let spot = null;
      for (const sg of [side, -side]) {
        spot = roadsideSpot(p, nx * sg, nz * sg, rd.width / 2, flush);
        if (spot) { spot.sg = sg; break; }
      }
      if (!spot || lampGrid.near(spot.x, spot.z, spacing * 0.45) || treeGrid.near(spot.x, spot.z, 1.5)) continue;
      const kind = inBinnenstad(spot.x, spot.z) && !(main && !binnen) ? 0 : 1;
      addLamp(spot.x, spot.z, rotTo(-nx * spot.sg, -nz * spot.sg), kind);
    }
  }

  // ------------------------------------------------------------------ benches + bins (OSM)
  const benchRot = (x, z) => {
    const b = bNear(x, z, 8);
    if (b.d < 8 && b.d > 0) return rotTo(b.nx, b.nz); // back to the wall
    const ne = nearestEdge(x, z, 30);
    return ne ? rotTo(ne.qx - x, ne.qz - z) : 0;
  };
  const dirRot = (v) => {
    const deg = parseFloat(v);
    if (!Number.isFinite(deg)) return null;
    const b = (deg * Math.PI) / 180; // compass bearing: 0 = north (-z), 90 = east (+x)
    return rotTo(Math.sin(b), -Math.cos(b));
  };
  for (const n of tagNodes) {
    const t = n.tags;
    if ((t.amenity === 'bench' || t.amenity === 'waste_basket') && !walkable(site(n.x, n.z)) && site(n.x, n.z)?.mat !== 'parking') continue;
    if (t.amenity === 'bench' && bDist(n.x, n.z, 1) > 0.3) {
      out.benches.push([r2(n.x), r2(n.z), ang(dirRot(t.direction) ?? benchRot(n.x, n.z))]);
      benchGrid.add(n.x, n.z);
    } else if (t.amenity === 'waste_basket' && bDist(n.x, n.z, 1) > 0.2) {
      const ne = nearestEdge(n.x, n.z, 20);
      out.bins.push([r2(n.x), r2(n.z), ang(ne ? rotTo(ne.qx - n.x, ne.qz - n.z) : 0)]);
      binGrid.add(n.x, n.z);
    }
  }

  // ------------------------------------------------------------------ bollards
  const addBollard = (x, z) => { out.bollards.push([r2(x), r2(z)]); bollardGrid.add(x, z); };
  for (const n of tagNodes) if (n.tags.barrier === 'bollard' && !bollardGrid.near(n.x, n.z, 0.6)) addBollard(n.x, n.z);
  for (const b of F.barriers) {
    if (b.tags.barrier !== 'bollard') continue;
    const cum = cumLengths(b.pts), L = cum[cum.length - 1];
    for (let s = 0; s <= L + 0.01; s += 1.6) {
      const p = pointAt(b.pts, cum, Math.min(s, L));
      if (inside(p.x, p.z) && !bollardGrid.near(p.x, p.z, 0.8)) addBollard(p.x, p.z);
    }
  }
  // Amsterdammertjes on the kerb corners of binnenstad car streets (stop corner cutting/parking)
  for (const rd of roads) {
    if (rd.kind !== 'car' || rd.bridge || RP.flush.has(rd.id) || rd.hw === 'service') continue;
    const cum = cumLengths(rd.pts), L = cum[cum.length - 1];
    if (L < 16) continue;
    for (const end of [0, 1]) {
      const p0 = rd.pts[end ? rd.pts.length - 1 : 0];
      if (!inBinnenstad(p0[0], p0[1]) || h01(p0[0], p0[1], 41 + end) < 0.35) continue;
      for (const sg of [1, -1]) {
        for (let k = 0; k < 4; k++) {
          const s = 3.5 + k * 1.7;
          const p = pointAt(rd.pts, cum, end ? L - s : s);
          const [nx, nz] = leftN(p.dx, p.dz);
          const d = rd.width / 2 + 0.4;
          const x = p.x + nx * sg * d, z = p.z + nz * sg * d;
          const r = site(x, z);
          if (!r || r.kind !== 'raised' || r.curbStrip || r.mat === 'grass' || bDist(x, z, 1.5) < 1.2 || bollardGrid.near(x, z, 1.2)) break;
          addBollard(x, z);
        }
      }
    }
  }

  // ------------------------------------------------------------------ parked bicycles
  const addBike = (x, z, rot) => { out.parkedBikes.push([r2(x), r2(z), ang(rot)]); bikeGrid.add(x, z); };
  const bikeOk = (x, z, minB = 0.35) => {
    const r = site(x, z);
    return r && !isCar(r) && r.mat !== 'grass' && !(r.kind === 'raised' && r.curbStrip) && r.layer !== 'rail' && r.layer !== 'platform' && bDist(x, z, 1) >= minB && !bikeGrid.near(x, z, 0.5) && !treeGrid.near(x, z, 0.9) && !lampGrid.near(x, z, 0.5);
  };
  /** A row of n bikes centred at (x, z) along (ux, uz); each bike faces (fx, fz). */
  const bikeRow = (x, z, ux, uz, fx, fz, n, gap = 0.62) => {
    let placed = 0;
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * gap;
      const bx = x + ux * o, bz = z + uz * o;
      if (!bikeOk(bx, bz) || !bikeOk(bx + fx * 0.7, bz + fz * 0.7, 0.1) || !bikeOk(bx - fx * 0.7, bz - fz * 0.7, 0.1)) continue;
      addBike(bx, bz, rotTo(fx, fz));
      placed++;
    }
    return placed;
  };
  // OSM bicycle parking nodes (capacity -> row length)
  for (const n of tagNodes) {
    if (n.tags.amenity !== 'bicycle_parking' || n.tags.bicycle_parking === 'building' || n.tags.covered === 'yes' && n.tags.bicycle_parking === 'shed') continue;
    const cap = Math.min(160, parseInt(n.tags.capacity ?? '10', 10) || 10);
    const cnt = Math.max(3, Math.round(cap * (0.55 + h01(n.x, n.z, 51) * 0.35)));
    const ne = nearestEdge(n.x, n.z, 30);
    const [ux, uz] = ne ? [ne.dx, ne.dz] : [1, 0];
    const [fx, fz] = leftN(ux, uz);
    const rows = Math.ceil(cnt / 24);
    for (let r = 0; r < rows; r++) bikeRow(n.x - fx * r * 2.2, n.z - fz * r * 2.2, ux, uz, fx, fz, Math.min(24, cnt - r * 24));
  }
  // OSM bicycle parking areas: rows along the long axis
  for (const w of osm.ways) {
    if (w.tags.amenity !== 'bicycle_parking' || !w.closed || ['building', 'shed'].includes(w.tags.bicycle_parking) || w.tags.location === 'underground') continue;
    const ring = w.pts;
    const bb = bboxOfPts(ring);
    if (!inside((bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2)) continue;
    let ux = 1, uz = 0, best = 0;
    for (let i = 1; i < ring.length; i++) {
      const L = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      if (L > best) { best = L; [ux, uz] = dirOf(ring[i - 1], ring[i]); }
    }
    const [fx, fz] = leftN(ux, uz);
    let placed = 0;
    const cx = (bb[0] + bb[2]) / 2, cz = (bb[1] + bb[3]) / 2, R = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 2;
    for (let b = -R; b <= R && placed < 220; b += 2.3) {
      for (let a = -R; a <= R && placed < 220; a += 0.62) {
        const x = cx + ux * a + fx * b, z = cz + uz * a + fz * b;
        if (!pointInRing(x, z, ring) || !pointInRing(x + fx * 0.8, z + fz * 0.8, ring) || !pointInRing(x - fx * 0.8, z - fz * 0.8, ring)) continue;
        if (h01(x, z, 52) < 0.25 || !bikeOk(x, z, 0.3)) continue;
        addBike(x, z, rotTo(fx, fz));
        placed++;
      }
    }
  }
  // along canal railings / quay edges in the binnenstad: clusters of 2..8 bikes
  {
    let gapLeft = 0;
    for (const e of waterEdges) {
      if (!e.bin) continue;
      gapLeft -= 1.5;
      if (gapLeft > 0) continue;
      const x = e.x + e.ix * 1.15, z = e.z + e.iz * 1.15;
      const r0 = site(x, z), r1 = site(e.x + e.ix * 2.2, e.z + e.iz * 2.2);
      if (!walkable(r0) || r0.mat === 'grass' || !r1 || isCar(r1)) { gapLeft = 3; continue; }
      const n = 2 + Math.floor(h01(x, z, 61) * 7);
      const placed = bikeRow(x, z, e.tx, e.tz, -e.ix, -e.iz, n);
      gapLeft = placed ? 8 + h01(x, z, 62) * 22 : 3;
    }
  }
  // against facades of pedestrian streets and squares in the binnenstad
  for (const rd of roads) {
    if (rd.kind !== 'ped' || rd.bridge) continue;
    const cum = cumLengths(rd.pts), L = cum[cum.length - 1];
    let side = 1;
    for (let s = 5; s < L - 3; s += 11 + h01(rd.pts[0][0], s, 71) * 8) {
      const p = pointAt(rd.pts, cum, s);
      if (!inside(p.x, p.z) || !inBinnenstad(p.x, p.z)) continue;
      side = -side;
      const [nx, nz] = leftN(p.dx, p.dz);
      for (let d = 1; d < 14; d += 0.25) {
        const x = p.x + nx * side * d, z = p.z + nz * side * d;
        const b = bDist(x, z, 1.5);
        if (b < 1.05) {
          if (b > 0.7) bikeRow(x, z, p.dx, p.dz, nx * side, nz * side, 2 + Math.floor(h01(x, z, 72) * 5));
          break;
        }
        const r = site(x, z);
        if (!r || isCar(r)) break;
      }
    }
  }

  // ------------------------------------------------------------------ benches + bins (generated)
  const addBench = (x, z, rot, withBin) => {
    out.benches.push([r2(x), r2(z), ang(rot)]);
    benchGrid.add(x, z);
    if (withBin) {
      const bx = x + Math.cos(rot) * 1.2, bz = z - Math.sin(rot) * 1.2; // model +x side
      if (walkable(site(bx, bz)) && bDist(bx, bz, 1) > 0.4) { out.bins.push([r2(bx), r2(bz), ang(rot)]); binGrid.add(bx, bz); }
    }
  };
  // canal-side benches looking at the water (binnenstad), roughly every 70 m
  {
    let run = 0;
    for (const e of waterEdges) {
      run += 1.5;
      if (!e.bin || run < 70) continue;
      const x = e.x + e.ix * 1.3, z = e.z + e.iz * 1.3;
      if (!walkable(site(x, z)) || !walkable(site(e.x + e.ix * 2.3, e.z + e.iz * 2.3)) || bDist(x, z, 3) < 2.5) continue;
      if (benchGrid.near(x, z, 40) || bikeGrid.near(x, z, 2) || treeGrid.near(x, z, 1.2) || lampGrid.near(x, z, 1)) continue;
      addBench(x, z, rotTo(-e.ix, -e.iz), h01(x, z, 81) < 0.6);
      run = 0;
    }
  }
  // park paths: benches beside footways inside green areas
  for (const rd of roads) {
    if (!(rd.kind === 'foot' || rd.kind === 'cycle') || rd.bridge) continue;
    const cum = cumLengths(rd.pts), L = cum[cum.length - 1];
    for (let s = 10; s < L - 5; s += 55) {
      const p = pointAt(rd.pts, cum, s);
      if (!inside(p.x, p.z)) continue;
      const [nx, nz] = leftN(p.dx, p.dz);
      const sg = h01(p.x, p.z, 82) < 0.5 ? 1 : -1;
      const d = rd.width / 2 + 0.9;
      const x = p.x + nx * sg * d, z = p.z + nz * sg * d;
      const r = site(x, z);
      if (!r || r.mat !== 'grass' || r.garden || benchGrid.near(x, z, 35) || treeGrid.near(x, z, 1.5) || bDist(x, z, 4) < 4) continue;
      if (!site(x + nx * sg * 1.2, z + nz * sg * 1.2)) continue; // not on the bank edge
      addBench(x, z, rotTo(-nx * sg, -nz * sg), h01(x, z, 83) < 0.4);
    }
  }
  // extra bins along pedestrian streets / squares (every ~45 m, against a facade)
  for (const rd of roads) {
    if (rd.kind !== 'ped') continue;
    const cum = cumLengths(rd.pts), L = cum[cum.length - 1];
    for (let s = 15; s < L; s += 45) {
      const p = pointAt(rd.pts, cum, s);
      if (!inside(p.x, p.z)) continue;
      const [nx, nz] = leftN(p.dx, p.dz);
      const spot = roadsideSpot(p, nx, nz, 0, true, 0.6, 12);
      if (!spot || binGrid.near(spot.x, spot.z, 25) || bikeGrid.near(spot.x, spot.z, 1)) continue;
      out.bins.push([r2(spot.x), r2(spot.z), ang(rotTo(-nx, -nz))]);
      binGrid.add(spot.x, spot.z);
    }
  }

  // ------------------------------------------------------------------ parked cars
  const addCar = (x, z, rot) => { out.parkedCars.push([r2(x), r2(z), ang(rot)]); carGrid.add(x, z); };
  const carSlotOk = (x, z, ux, uz, half) => {
    for (const o of [-half, 0, half]) {
      const r = site(x + ux * o, z + uz * o);
      if (!r || r.kind !== 'low' || r.layer !== 'parking') return false;
    }
    // the whole body (plus a small margin) must be clear of the water: corners at +-1.05 m side,
    // +-(half + 0.45) m along the car
    for (const [o, l] of [[-half - 0.45, -1.05], [-half - 0.45, 1.05], [half + 0.45, -1.05], [half + 0.45, 1.05], [0, -1.05], [0, 1.05]]) {
      const r = site(x + ux * o - uz * l, z + uz * o + ux * l);
      if (!r || r.kind === 'water') return false;
    }
    return bDist(x, z, 2) >= 1.2 && !carGrid.near(x, z, 2.3) && !treeGrid.near(x, z, 1.4) && !lampGrid.near(x, z, 1.2);
  };
  // on-street parking strips (OSM parking:* tags)
  for (const ps of RP.parkStrips) {
    const cum = cumLengths(ps.line), L = cum[cum.length - 1];
    const step = ps.orient === 'parallel' ? 5.7 : ps.orient === 'diagonal' ? 3.2 : 2.6;
    const rd = ps.road;
    for (let s = step / 2 + 0.3; s < L - step / 2; s += step) {
      const p = pointAt(ps.line, cum, s);
      if (!inside(p.x, p.z) || h01(p.x, p.z, 91) < 0.22) continue;
      // only along streets that are still car roads (not the ones inside buildings)
      if (!nearestEdge(p.x, p.z, rd.width / 2 + 6, carEdge)) continue;
      const [nx, nz] = leftN(p.dx, p.dz);
      // driver's right = +offset side (sg 1): parallel cars face the travel direction of their side
      const fwd = rd.oneway === 1 ? 1 : rd.oneway === -1 ? -1 : ps.side;
      let fx, fz, half;
      if (ps.orient === 'parallel') { fx = p.dx * fwd; fz = p.dz * fwd; half = 1.9; }
      else if (ps.orient === 'perpendicular') { fx = nx * ps.side; fz = nz * ps.side; half = 1.6; }
      else { const c = Math.SQRT1_2; fx = (p.dx * fwd + nx * ps.side) * c; fz = (p.dz * fwd + nz * ps.side) * c; half = 1.6; }
      // strips along a quay are often just a car wide: nudge the car sideways (max 0.4 m) when its
      // body would overhang the water at the strip centre
      for (const sh of [0, 0.2, -0.2, 0.4, -0.4]) {
        const x = p.x + nx * sh, z = p.z + nz * sh;
        if (!carSlotOk(x, z, fx, fz, half)) continue;
        addCar(x, z, rotTo(fx, fz));
        break;
      }
    }
  }
  // parking lots: rows of perpendicular bays along the lot's long axis (aisle 6 m between rows)
  for (const lot of F.parking) {
    if (lot.tags?.amenity !== 'parking') continue;
    const ring = lot.poly[0];
    const bb = lot.bb;
    if (!(bb[2] > detail.minX && bb[0] < detail.maxX && bb[3] > detail.minZ && bb[1] < detail.maxZ)) continue;
    let ux = 1, uz = 0, best = 0;
    for (let i = 1; i < ring.length; i++) {
      const L = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
      if (L > best) { best = L; [ux, uz] = dirOf(ring[i - 1], ring[i]); }
    }
    const [fx, fz] = leftN(ux, uz);
    const cx = (bb[0] + bb[2]) / 2, cz = (bb[1] + bb[3]) / 2, R = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) / 2;
    let placed = 0;
    // row pattern across the axis: bay (5 m, nose +f) | bay (nose -f) | aisle 6 m  => period 16 m
    for (let b0 = -R; b0 <= R && placed < 300; b0 += 16) {
      for (const [bo, sgn] of [[2.5, 1], [7.5, -1]]) {
        const b = b0 + bo;
        for (let a = -R; a <= R && placed < 300; a += 2.55) {
          const x = cx + ux * a + fx * b, z = cz + uz * a + fz * b;
          if (!pointInPoly(x, z, lot.poly) || !pointInPoly(x + fx * 2.4, z + fz * 2.4, lot.poly) || !pointInPoly(x - fx * 2.4, z - fz * 2.4, lot.poly)) continue;
          if (!inside(x, z) || h01(x, z, 92) < 0.3) continue;
          if (!carSlotOk(x, z, fx * sgn, fz * sgn, 1.9)) continue;
          addCar(x, z, rotTo(fx * sgn, fz * sgn));
          placed++;
        }
      }
    }
  }

  // ------------------------------------------------------------------ signs
  const addSign = (x, z, rot, code) => { out.signs.push([r2(x), r2(z), ang(rot), code]); signGrid.add(x, z); };
  /** Kerbside spot right of travel direction (dx, dz) at p, at least hw + 0.6 out. */
  const rightSpot = (px, pz, dx, dz, hw, flush) => {
    const [rx, rz] = leftN(dx, dz); // +offset = driver's right (z points south)
    return roadsideSpot({ x: px, z: pz }, rx, rz, hw, flush, 0.3, 5);
  };
  const SIGN_RE = /^(NL:)?([A-L]\d|OB\d)/i;
  for (const n of tagNodes) {
    const t = n.tags;
    if (!t.traffic_sign) continue;
    const codes = t.traffic_sign.split(/[;,]/).map((c) => c.trim().replace(/^NL:/i, '')).filter((c) => SIGN_RE.test(c));
    if (!codes.length) continue;
    const ne = nearestEdge(n.x, n.z, 25, carEdge);
    let x = n.x, z = n.z, rot = 0;
    if (ne) {
      let dx = ne.dx, dz = ne.dz;
      if (t.direction === 'backward') { dx = -dx; dz = -dz; }
      else if (t.direction !== 'forward') {
        // facing the traffic that has the sign on its right
        const [rx, rz] = leftN(dx, dz);
        if ((n.x - ne.qx) * rx + (n.z - ne.qz) * rz < 0) { dx = -dx; dz = -dz; }
      }
      rot = dirRot(t.direction) ?? rotTo(-dx, -dz);
      if (isCar(site(n.x, n.z))) {
        const sp = rightSpot(ne.qx, ne.qz, dx, dz, ne.e.width / 2, true);
        if (!sp) continue;
        x = sp.x; z = sp.z;
      }
    }
    for (const c of codes) addSign(x, z, rot, c);
  }
  // B6 (give way) at give_way nodes, facing the traffic approaching the junction
  for (const n of tagNodes) {
    if (n.tags.highway !== 'give_way' && n.tags.highway !== 'stop') continue;
    const ne = nearestEdge(n.x, n.z, 8, carEdge);
    if (!ne) continue;
    const e = ne.e;
    // approach direction: towards the nearer end that is a junction (or per direction tag)
    const cum = cumLengths(e.pts);
    const sHere = cum[ne.k - 1] + ne.t * (cum[ne.k] - cum[ne.k - 1]);
    let toB = (cum[cum.length - 1] - sHere) < sHere;
    if (n.tags.direction === 'forward') toB = true;
    else if (n.tags.direction === 'backward') toB = false;
    const dx = toB ? ne.dx : -ne.dx, dz = toB ? ne.dz : -ne.dz;
    if (e.oneway === 1 && !toB) continue;
    const sp = rightSpot(ne.qx, ne.qz, dx, dz, e.width / 2, false);
    if (!sp || signGrid.near(sp.x, sp.z, 2)) continue;
    addSign(sp.x, sp.z, rotTo(-dx, -dz), n.tags.highway === 'stop' ? 'B7' : 'B6');
  }
  /** Like rightSpot but on the driver's left (median islands, narrow one-way streets). */
  const leftSpot = (px, pz, dx, dz, hw, flush, maxOut = 5) => {
    const [rx, rz] = leftN(dx, dz);
    return roadsideSpot({ x: px, z: pz }, -rx, -rz, hw, flush, 0.3, maxOut);
  };
  // ---- one-way streets. Consecutive one-way car edges of the same street form one chain; C2 (no
  // entry) stands once per chain at its exit end, where a wrong-way driver could turn in. Dual
  // carriageways (an opposite one-way twin of the same name alongside) get a D2 (keep right) on the
  // median at their start instead. Roundabouts and slip roads get nothing.
  {
    const ptKey = (p) => `${r2(p[0])},${r2(p[1])}`;
    const rbKeys = new Set();
    for (const rd of roads) {
      if (rd.tags?.junction !== 'roundabout' && rd.tags?.junction !== 'circular') continue;
      for (const p of rd.pts) rbKeys.add(ptKey(p));
    }
    const onRoundabout = (e) => e.pts.every((p) => rbKeys.has(ptKey(p)));
    const ow = graph.edges.filter((e) => e.car && e.oneway === 1 && !/_link$/.test(e.type) && !onRoundabout(e));
    const outOf = new Map(), inTo = new Map();
    const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, (a = [])); a.push(v); };
    for (const e of ow) { push(outOf, e.a, e); push(inTo, e.b, e); }
    const endDir = (e, atEnd) => { const p = e.pts, n = p.length; return atEnd ? dirOf(p[n - 2], p[n - 1]) : dirOf(p[0], p[1]); };
    const sameStreet = (e, o) => (e.name ?? '') === (o.name ?? '');
    const next = (e) => {
      const c = (outOf.get(e.b) ?? []).filter((o) => o !== e && sameStreet(e, o));
      if (c.length !== 1) return null;
      const o = c[0];
      if ((inTo.get(o.a) ?? []).filter((g) => sameStreet(g, o)).length !== 1) return null;
      const d0 = endDir(e, true), d1 = endDir(o, false);
      return d0[0] * d1[0] + d0[1] * d1[1] > 0.5 ? o : null;
    };
    const hasPrev = new Set();
    for (const e of ow) { const o = next(e); if (o) hasPrev.add(o); }
    const seen = new Set(), chains = [];
    for (const e of [...ow.filter((x) => !hasPrev.has(x)), ...ow]) {
      if (seen.has(e)) continue;
      const ch = [];
      for (let c = e; c && !seen.has(c); c = next(c)) { seen.add(c); ch.push(c); }
      chains.push(ch);
    }
    for (const ch of chains) {
      const len = ch.reduce((acc, e) => acc + e.len, 0);
      const first = ch[0], last = ch[ch.length - 1];
      if (len < 15 || last.b === first.a) continue;
      const pts = ch.flatMap((e, i) => (i ? e.pts.slice(1) : e.pts));
      const cum = cumLengths(pts);
      const chainSet = new Set(ch);
      const twinOf = (p) => {
        if (!first.name) return null;
        const ne = nearestEdge(p.x, p.z, 30, (o) => o.car && o.oneway === 1 && o.name === first.name && !chainSet.has(o));
        return ne && ne.dx * p.dx + ne.dz * p.dz < -0.7 ? ne : null;
      };
      if (twinOf(pointAt(pts, cum, len / 2))) {
        // dual carriageway: D2 on the median nose at the start (needs a median of >= 4 m)
        const PA = graph.nodes[first.a];
        if (!inside(PA[0], PA[1]) || (carDeg.get(first.a) ?? 0) < 2) continue;
        const p = pointAt(pts, cum, Math.min(len / 2, 4));
        const tw = twinOf(p);
        if (!tw || tw.d < 4) continue;
        const maxOut = tw.d / 2 + 0.3 - first.width / 2;
        if (maxOut < 0.7) continue;
        const sp = leftSpot(p.x, p.z, p.dx, p.dz, first.width / 2, false, maxOut);
        if (!sp || signGrid.near(sp.x, sp.z, 3)) continue;
        addSign(sp.x, sp.z, rotTo(-p.dx, -p.dz), 'D2');
        continue;
      }
      const B = last.b, PB = graph.nodes[B];
      if (!inside(PB[0], PB[1])) continue;
      // somebody must be able to arrive at the exit node other than through this street
      const arrivals = (nodeEdges.get(B) ?? []).filter((o) => o !== last && o.car && (o.oneway === 0 || o.b === B));
      if (!arrivals.length) continue;
      // wrong-way traveller enters at the exit node heading back along the chain
      const rev = pts.slice().reverse();
      const p = pointAt(rev, cumLengths(rev), Math.min(len / 2, 6));
      const sp = rightSpot(p.x, p.z, p.dx, p.dz, last.width / 2, true) ?? leftSpot(p.x, p.z, p.dx, p.dz, last.width / 2, true);
      if (!sp || signGrid.near(sp.x, sp.z, 3)) continue;
      addSign(sp.x, sp.z, rotTo(-p.dx, -p.dz), 'C2');
    }
  }
  // C1 (closed to vehicles) where a pedestrian street leaves the car network
  graph.nodes.forEach((P, ni) => {
    if (!inside(P[0], P[1])) return;
    const es = nodeEdges.get(ni) ?? [];
    if (!es.some((e) => e.car)) return;
    for (const e of es) {
      if (e.car || e.type !== 'pedestrian' || e.len < 10) continue;
      const pts = e.a === ni ? e.pts : e.pts.slice().reverse();
      const p = pointAt(pts, cumLengths(pts), 3);
      const sp = rightSpot(p.x, p.z, p.dx, p.dz, e.width / 2, true);
      if (!sp || signGrid.near(sp.x, sp.z, 4)) continue;
      addSign(sp.x, sp.z, rotTo(-p.dx, -p.dz), 'C1');
    }
  });
  // E4 (parking) at the car entrance of larger public parking lots, 4 m before the lot boundary
  for (const lot of F.parking) {
    if (lot.tags?.amenity !== 'parking' || lot.tags?.access === 'private') continue;
    const bb = lot.bb;
    if (!(bb[0] > detail.minX && bb[2] < detail.maxX && bb[1] > detail.minZ && bb[3] < detail.maxZ)) continue;
    if ((bb[2] - bb[0]) * (bb[3] - bb[1]) < 600) continue;
    const ring = lot.poly[0];
    let best = null;
    for (const h of segTree.search({ minX: bb[0] - 1, minY: bb[1] - 1, maxX: bb[2] + 1, maxY: bb[3] + 1 })) {
      const e = graph.edges[h.ei];
      if (!e.car) continue;
      const a = e.pts[h.k - 1], b = e.pts[h.k];
      for (let i = 0; i < ring.length; i++) {
        const t = segIntersectT(a, b, ring[i], ring[(i + 1) % ring.length]);
        if (t === null) continue;
        const [dx0, dz0] = dirOf(a, b);
        const tq = Math.min(1, t + 0.5 / Math.max(0.5, Math.hypot(b[0] - a[0], b[1] - a[1])));
        const into = pointInPoly(a[0] + (b[0] - a[0]) * tq, a[1] + (b[1] - a[1]) * tq, lot.poly) ? 1 : -1;
        if (into === -1 && e.oneway === 1) continue;
        const cand = { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: dx0 * into, dz: dz0 * into, e };
        if (!best || e.width > best.e.width) best = cand;
      }
    }
    if (!best) continue;
    const sp = rightSpot(best.x - best.dx * 4, best.z - best.dz * 4, best.dx, best.dz, best.e.width / 2, true);
    if (!sp || signGrid.near(sp.x, sp.z, 4)) continue;
    addSign(sp.x, sp.z, rotTo(-best.dx, -best.dz), 'E4');
  }
  // G5 / G6 (woonerf begin / end) where living streets meet other car roads
  for (const e of graph.edges) {
    if (!e.car || e.type !== 'living_street') continue;
    for (const [nid, fromA] of [[e.a, true], [e.b, false]]) {
      const others = (nodeEdges.get(nid) ?? []).filter((o) => o !== e && o.car && o.type !== 'living_street');
      if (!others.length || (fromA === false && e.oneway === 1)) continue;
      const pts = fromA ? e.pts : e.pts.slice().reverse();
      const cum = cumLengths(pts);
      if (cum[cum.length - 1] < 8) continue;
      const p = pointAt(pts, cum, 4);
      const sp = rightSpot(p.x, p.z, p.dx, p.dz, e.width / 2, true);
      if (!sp || signGrid.near(sp.x, sp.z, 3)) continue;
      addSign(sp.x, sp.z, rotTo(-p.dx, -p.dz), 'G5');
    }
  }

  // ------------------------------------------------------------------ traffic lights
  for (const n of tagNodes) {
    if (n.tags.highway !== 'traffic_signals') continue;
    const ne = nearestEdge(n.x, n.z, 10, carEdge);
    if (!ne) continue;
    const e = ne.e;
    const dirs = e.oneway === 1 ? [1] : [1, -1];
    if (n.tags['traffic_signals:direction'] === 'forward') dirs.splice(0, dirs.length, 1);
    else if (n.tags['traffic_signals:direction'] === 'backward') dirs.splice(0, dirs.length, -1);
    for (const sg of dirs) {
      const dx = ne.dx * sg, dz = ne.dz * sg;
      const sp = rightSpot(ne.qx, ne.qz, dx, dz, e.width / 2, false);
      if (!sp) continue;
      let dup = false;
      for (const l of out.trafficLights) if (Math.hypot(l[0] - sp.x, l[1] - sp.z) < 4) { dup = true; break; }
      if (dup) continue;
      out.trafficLights.push([r2(sp.x), r2(sp.z), ang(rotTo(-dx, -dz))]);
    }
  }

  // ------------------------------------------------------------------ street-name signs
  {
    const placedNames = new Map(); // name -> [[x,z]...]
    graph.nodes.forEach((P, ni) => {
      if (!inside(P[0], P[1]) || (deg.get(ni) ?? 0) < 3) return;
      const inc = (nodeEdges.get(ni) ?? []).filter((e) => (e.car || e.type === 'pedestrian') && e.name);
      if (inc.length < 1) return;
      const crossW = Math.max(...(nodeEdges.get(ni) ?? []).map((e) => e.width));
      const seen = new Set();
      for (const e of inc) {
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        const prev = placedNames.get(e.name) ?? [];
        if (prev.some(([x, z]) => Math.hypot(x - P[0], z - P[1]) < 45)) continue;
        const pts = e.a === ni ? e.pts : e.pts.slice().reverse();
        const cum = cumLengths(pts);
        const s = Math.min(cum[cum.length - 1] * 0.5, crossW / 2 + 2.5);
        const p = pointAt(pts, cum, s);
        const [rx, rz] = leftN(p.dx, p.dz);
        let sp = null, sg = 1;
        for (const g of [1, -1]) {
          sp = roadsideSpot(p, rx * g, rz * g, e.width / 2, true, 0.3, 6);
          if (sp) { sg = g; break; }
        }
        if (!sp) continue;
        out.streetNameSigns.push([r2(sp.x), r2(sp.z), ang(rotTo(rx * sg, rz * sg)), e.name]);
        prev.push([P[0], P[1]]);
        placedNames.set(e.name, prev);
      }
    });
  }

  // ------------------------------------------------------------------ final safety: nothing over water
  // (props standing on a bridge deck over the canal are fine)
  let dropped = 0;
  for (const k of Object.keys(out)) {
    const before = out[k].length;
    out[k] = out[k].filter((a) => { const r = site(a[0], a[1]); return !(r && r.kind === 'water'); });
    dropped += before - out[k].length;
  }
  if (dropped) console.log(`[props] dropped ${dropped} items over water`);
  console.log(`[props] tree clearances: mill biotope removed ${treeStats.mill}, capped ${treeStats.millCapped}; landmarks ${treeStats.landmark}; spawn sightlines ${treeStats.sightline}`);

  return out;
}
