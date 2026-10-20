// LoD 2.2 building processing: wall frames, party-wall detection, hidden-wall removal, facade
// grouping (continuous u) and emission of wall / roof triangles with the attributes of
// ARCHITECTURE 4.2.
import RBush from 'rbush';
import polygonClipping from 'polygon-clipping';
import { clipU, hash01, newell, normalize3, pointInPolygon, pointInRing, triangulate2, triangulate3 } from './geom.mjs';
import { lineIntervals } from './passages.mjs';

/** A footprint edge / wall closer than this (m) to another building's edge is a party wall. */
export const PARTY_DIST = 0.3;
/** A party wall is only dropped when the neighbour's wall is within this distance (m). */
export const HIDE_DIST = 0.1;
const PARALLEL_SIN = Math.sin((10 * Math.PI) / 180);
/** Faces / facades narrower than this get no windows. */
const NARROW = 1.2;
/** Facades lower than this (m), e.g. steps between roof levels, get no windows. */
const SHORT_WALL = 2.0;
/** Walls are extended down to this height so there is no gap with the street. */
export const WALL_BOTTOM = -0.3;
const GROUND_EPS = 0.05;
const FLAT_ROOF_DEG = 10;
/** Roof vertices are kept at or above this height (no geometry under the street). */
const ROOF_MIN_Y = 0.02;

export const KIND_NORMAL = 0;
export const KIND_PARTY = 0.5;
export const KIND_LANDMARK = 1;

// ---------------------------------------------------------------------------------------------
// Per-building attribute values (COLOR_0)
// ---------------------------------------------------------------------------------------------

/**
 * Construction years used by the municipality as placeholder for "historic, exact year unknown"
 * (in the Alkmaar binnenstad 1901 alone covers ~14 % of all buildings). Treated as <= 1850.
 */
const PLACEHOLDER_YEARS = new Set([1900, 1901]);

export function ageClass(year) {
  if (!Number.isFinite(year)) return 0.33;
  if (PLACEHOLDER_YEARS.has(year)) return 0;
  if (year <= 1850) return 0;
  if (year <= 1940) return 0.33;
  if (year <= 1990) return 0.66;
  return 1;
}

/** Typical floor height (m) estimated from b3_bouwlagen or the construction year. */
export function floorHeight(b) {
  const yr = b.attrs.oorspronkelijkbouwjaar;
  let fh = Number.isFinite(yr) && yr > 1940 ? 2.9 : 3.2;
  const n = b.attrs.b3_bouwlagen;
  const h70 = b.attrs.b3_h_dak_70p;
  if (Number.isFinite(n) && n >= 1 && Number.isFinite(h70)) {
    const h = h70 - b.maaiveld;
    if (h > 2) fh = Math.max(2.6, Math.min(4.2, h / n));
  }
  return fh;
}

/**
 * COLOR_0 (r seed, g kind, b age, a floor-height hint) for a building; g is filled per face.
 * The seed is pre-quantised to the ubyte grid so it stays in [0, 1) after normalisation.
 */
export function buildingColor(b) {
  const seed = Math.floor(hash01(b.id) * 255) / 255;
  return [seed, 0, ageClass(b.attrs.oorspronkelijkbouwjaar), (floorHeight(b) - 2.5) / 2];
}

// ---------------------------------------------------------------------------------------------
// Footprint edge index (all buildings, also backdrop) for party-wall detection
// ---------------------------------------------------------------------------------------------

export function buildEdgeIndex(buildings) {
  const items = [];
  for (const b of buildings) {
    for (const ring of b.footprint) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (len < 0.05) continue;
        items.push({
          minX: Math.min(a[0], c[0]), minY: Math.min(a[1], c[1]),
          maxX: Math.max(a[0], c[0]), maxY: Math.max(a[1], c[1]),
          bid: b.id, ax: a[0], az: a[1], bx: c[0], bz: c[1], len, h: b._height ?? 0,
        });
      }
    }
  }
  const tree = new RBush();
  tree.load(items);
  return tree;
}

/**
 * Covered intervals [lo, hi] along a line (frame: point(s) = s*t + w0*n2) by edges of OTHER
 * buildings that are parallel and within `dist` of the line. `filter(edge)` optionally rejects.
 */
export function coveredIntervals(edgeIndex, bid, t, n2, w0, s0, s1, dist, filter) {
  const p0 = [s0 * t[0] + w0 * n2[0], s0 * t[1] + w0 * n2[1]];
  const p1 = [s1 * t[0] + w0 * n2[0], s1 * t[1] + w0 * n2[1]];
  const m = dist + 0.05;
  const cands = edgeIndex.search({
    minX: Math.min(p0[0], p1[0]) - m, minY: Math.min(p0[1], p1[1]) - m,
    maxX: Math.max(p0[0], p1[0]) + m, maxY: Math.max(p0[1], p1[1]) + m,
  });
  const ints = [];
  for (const e of cands) {
    if (e.bid === bid) continue;
    if (filter && !filter(e)) continue;
    const dx = (e.bx - e.ax) / e.len, dz = (e.bz - e.az) / e.len;
    if (Math.abs(dx * n2[0] + dz * n2[1]) > PARALLEL_SIN) continue;
    const sa = e.ax * t[0] + e.az * t[1];
    const sb = e.bx * t[0] + e.bz * t[1];
    if (Math.abs(sb - sa) < 1e-6) continue;
    const lo = Math.max(Math.min(sa, sb), s0);
    const hi = Math.min(Math.max(sa, sb), s1);
    if (hi - lo < 0.05) continue;
    // perpendicular offset of the edge from our line at both ends of the overlap
    const off = (s) => {
      const k = (s - sa) / (sb - sa);
      const x = e.ax + (e.bx - e.ax) * k, z = e.az + (e.bz - e.az) * k;
      return x * n2[0] + z * n2[1] - w0;
    };
    if (Math.abs(off(lo)) > dist || Math.abs(off(hi)) > dist) continue;
    ints.push([lo, hi]);
  }
  return mergeIntervals(ints, 0.25);
}

export function mergeIntervals(ints, gap = 0) {
  ints.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const it of ints) {
    const last = out[out.length - 1];
    if (last && it[0] <= last[1] + gap) last[1] = Math.max(last[1], it[1]);
    else out.push([it[0], it[1]]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Wall frames
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   bid: string, n: number[], n2: number[], t: number[], c: number, hxz: number, w0: number,
 *   s0: number, s1: number, outer: number[][], holes: number[][][], onEdge: boolean,
 * }} Wall
 */

/** y range of a polygon (outer ring in (s, y)) at abscissa s; null if s is outside. */
export function yRangeAt(ring, s) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if ((a[0] - s) * (b[0] - s) > 0) continue;
    if (Math.abs(b[0] - a[0]) < 1e-9) {
      lo = Math.min(lo, a[1], b[1]);
      hi = Math.max(hi, a[1], b[1]);
    } else {
      const y = a[1] + ((b[1] - a[1]) * (s - a[0])) / (b[0] - a[0]);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  return hi >= lo ? [lo, hi] : null;
}

/**
 * Make a vertical wall frame from 3D rings; returns null for degenerate faces.
 * `orient(x, z, n2, y)` decides the facing at base point (x, z) / mid height y: +1 = normal
 * n2 points outwards, -1 = inverted (flip), 0 = unknown (keep the CityJSON orientation).
 */
function makeWall(bid, rings3, nIn, onEdge, orient, stats) {
  let n = nIn;
  let hxz = Math.hypot(n[0], n[2]);
  if (hxz < 0.2) return null;
  // plane constant from the original (un-extended) outer ring
  let cx = 0, cy = 0, cz = 0;
  for (const p of rings3[0]) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const k = rings3[0].length;
  cx /= k; cy /= k; cz /= k;
  let c = n[0] * cx + n[1] * cy + n[2] * cz;
  let n2 = [n[0] / hxz, n[2] / hxz];
  // Orientation check (the CityJSON winding is wrong for a few percent of the faces).
  {
    const w = (c - n[1] * cy) / hxz;
    const tt = [n2[1], -n2[0]];
    const sm = cx * tt[0] + cz * tt[1];
    const bx = sm * tt[0] + w * n2[0], bz = sm * tt[1] + w * n2[1];
    const o = orient(bx, bz, n2, cy);
    if (o < 0) {
      n = [-n[0], -n[1], -n[2]];
      c = -c;
      n2 = [-n2[0], -n2[1]];
      if (onEdge) stats.flipped++;
      else stats.flippedInterior = (stats.flippedInterior ?? 0) + 1;
    } else if (o === 0) stats.ambiguous++;
  }
  const t = [n2[1], -n2[0]];
  const conv = (ring) =>
    ring.map((p) => [p[0] * t[0] + p[2] * t[1], p[1] < GROUND_EPS ? WALL_BOTTOM : p[1]]);
  const outer = conv(rings3[0]);
  const holes = rings3.slice(1).map(conv);
  let s0 = Infinity, s1 = -Infinity;
  for (const p of outer) { s0 = Math.min(s0, p[0]); s1 = Math.max(s1, p[0]); }
  if (s1 - s0 < 0.05) return null;
  return { bid, n, n2, t, c, hxz, w0: c / hxz, s0, s1, outer, holes, onEdge };
}

/** 3D position of wall point (s, y). */
function wallPoint(w, s, y) {
  const off = (w.c - w.n[1] * y) / w.hxz;
  return [s * w.t[0] + off * w.n2[0], y, s * w.t[1] + off * w.n2[1]];
}

/**
 * Split a building's LoD surfaces into wall frames and roof polygons.
 * opts.landmark: steep roof faces that come down low (> 50 deg, lowest point < 5 m) or are small
 * (> 45 deg, < 5 m2) are rendered as (tilted) walls. On the Grote Kerk these are buttress
 * weatherings / caps that 3D BAG models as one zig-zag 'roof' standing in front of the facade (the
 * dark floating 'M') and loose slate triangles on the aisle walls.
 * @returns {{ walls: Wall[], roofs: { rings: number[][][], n: number[] }[] }}
 */
export function prepareBuilding(b, lodKey, stats, opts = {}) {
  const walls = [];
  const roofs = [];
  const wallSurfs = [];
  /** roof planes for the interior-wall orientation test: { ring2, n, p0 } */
  const roofPlanes = [];
  for (const s of b.lods[lodKey] ?? []) {
    if (s.type === 'GroundSurface') continue;
    const nr = newell(s.rings[0]);
    const area = Math.hypot(nr[0], nr[1], nr[2]) / 2;
    if (area < 0.02) continue;
    const n = normalize3(nr);
    let isWall = s.type === 'WallSurface' || (s.type !== 'RoofSurface' && Math.abs(n[1]) < 0.3);
    if (!isWall && opts.landmark && Math.abs(n[1]) < Math.cos((45 * Math.PI) / 180)) {
      let minY = Infinity;
      for (const p of s.rings[0]) minY = Math.min(minY, p[1]);
      if ((minY < 5 && Math.abs(n[1]) < Math.cos((50 * Math.PI) / 180)) || area < 5) { isWall = true; stats.steepRoofWalls = (stats.steepRoofWalls ?? 0) + 1; }
    }
    if (isWall) {
      if (Math.abs(n[1]) > 0.9) continue; // horizontal "wall": skip
      wallSurfs.push({ s, n });
    } else {
      if (Math.abs(n[1]) > 0.05) roofPlanes.push({ ring2: s.rings[0].map((p) => [p[0], p[2]]), n, p0: s.rings[0][0] });
      // Roof parts below street level (sunken courtyards, terraces along canals) would poke
      // under the flat street: lift them to just above it.
      let maxY = -Infinity;
      for (const p of s.rings[0]) maxY = Math.max(maxY, p[1]);
      let rings = s.rings;
      let rn = n[1] < 0 ? [-n[0], -n[1], -n[2]] : n;
      if (maxY < ROOF_MIN_Y) {
        rings = rings.map((r) => r.map((p) => [p[0], ROOF_MIN_Y, p[2]]));
        rn = [0, 1, 0];
        stats.sunkenRoofs = (stats.sunkenRoofs ?? 0) + 1;
      } else if (rings.some((r) => r.some((p) => p[1] < ROOF_MIN_Y))) {
        rings = rings.map((r) => r.map((p) => (p[1] < ROOF_MIN_Y ? [p[0], ROOF_MIN_Y, p[2]] : p)));
        stats.sunkenRoofs = (stats.sunkenRoofs ?? 0) + 1;
      }
      roofs.push({ rings, n: rn });
    }
  }
  // Highest roof height at (x, z), or null outside all roof polygons.
  const roofHeight = (x, z) => {
    let h = null;
    for (const r of roofPlanes) {
      if (!pointInRing(x, z, r.ring2)) continue;
      const y = r.p0[1] - (r.n[0] * (x - r.p0[0]) + r.n[2] * (z - r.p0[2])) / r.n[1];
      if (h === null || y > h) h = y;
    }
    return h;
  };
  // Walls on the footprint edge: the outside point must lie outside the footprint.
  const orientEdge = (x, z, n2) => {
    const outIn = pointInPolygon(x + n2[0] * 0.25, z + n2[1] * 0.25, b.footprint);
    const inIn = pointInPolygon(x - n2[0] * 0.25, z - n2[1] * 0.25, b.footprint);
    return outIn === inIn ? 0 : outIn ? -1 : 1;
  };
  // Interior walls (steps between roof levels) must face the lower roof.
  const orientInterior = (x, z, n2) => {
    const hOut = roofHeight(x + n2[0] * 0.3, z + n2[1] * 0.3);
    const hIn = roofHeight(x - n2[0] * 0.3, z - n2[1] * 0.3);
    if (hOut === null || hIn === null) return 0;
    return hOut < hIn - 0.2 ? 1 : hOut > hIn + 0.2 ? -1 : 0;
  };
  for (const { s, n } of wallSurfs) {
    const w = makeWall(b.id, s.rings, n, s.onEdge, s.onEdge ? orientEdge : orientInterior, stats);
    if (w) walls.push(w);
  }
  return { walls, roofs };
}

export function buildWallIndex(allWalls) {
  const items = [];
  for (const w of allWalls) {
    const a = wallPoint(w, w.s0, 0), b = wallPoint(w, w.s1, 0);
    items.push({ minX: Math.min(a[0], b[0]), minY: Math.min(a[2], b[2]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[2], b[2]), w });
  }
  const tree = new RBush();
  tree.load(items);
  return tree;
}

/** Is the wall piece [a, b] of wall w completely hidden behind other buildings' walls? */
function isHidden(w, ring, a, b, wallIndex) {
  const pa = wallPoint(w, a, 0), pb = wallPoint(w, b, 0);
  const m = HIDE_DIST + 0.05;
  const cands = wallIndex
    .search({ minX: Math.min(pa[0], pb[0]) - m, minY: Math.min(pa[2], pb[2]) - m, maxX: Math.max(pa[0], pb[0]) + m, maxY: Math.max(pa[2], pb[2]) + m })
    .map((it) => it.w)
    .filter((o) => o.bid !== w.bid && o.n2[0] * w.n2[0] + o.n2[1] * w.n2[1] < -0.985 && Math.abs(o.w0 + w.w0) < HIDE_DIST);
  if (!cands.length) return false;
  const k = Math.max(3, Math.ceil((b - a) / 0.75));
  for (let i = 0; i <= k; i++) {
    const s = a + 0.05 + ((b - a - 0.1) * i) / k;
    const own = yRangeAt(ring, s);
    if (!own) continue;
    const need0 = Math.max(own[0], 0), need1 = own[1] - 0.05;
    if (need1 <= need0) continue;
    const xz = [s * w.t[0] + w.w0 * w.n2[0], s * w.t[1] + w.w0 * w.n2[1]];
    const ints = [];
    for (const o of cands) {
      const so = xz[0] * o.t[0] + xz[1] * o.t[1];
      if (so < o.s0 - 0.02 || so > o.s1 + 0.02) continue;
      const r = yRangeAt(o.outer, Math.min(Math.max(so, o.s0), o.s1));
      if (r) ints.push(r);
    }
    const merged = mergeIntervals(ints, 0.02);
    if (!merged.some((r) => r[0] <= need0 + 0.02 && r[1] >= need1)) return false;
  }
  return true;
}

/**
 * Classify the walls of one building into pieces, drop hidden party pieces, group coplanar
 * neighbours for continuous u and emit triangles.
 * prims: { wall, roof_slanted, roof_flat } PrimBuilders, or { backdrop } when opts.backdrop
 * (everything in one primitive; roofs then get TEXCOORD_1 = (0, 0)).
 * opts.passage { mp, h } (passages.mjs): walls are cut open below h over the passage polygons and
 * the passage gets a ceiling and side walls.
 */
export function emitBuilding(b, prep, ctx, prims, stats, opts = {}) {
  const backdrop = !!opts.backdrop;
  const passage = opts.passage ?? null;
  const openR = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
  const closeR = (r) => [...r, r[0]];
  /** wall piece minus the passage opening(s) below passage.h */
  const cutPassage = (w, ring, holes, a, c) => {
    if (!passage) return [{ ring, holes }];
    const ints = lineIntervals(passage.mp, [w.w0 * w.n2[0], w.w0 * w.n2[1]], w.t, a - 0.01, c + 0.01);
    if (!ints.length) return [{ ring, holes }];
    stats.passageCuts = (stats.passageCuts ?? 0) + 1;
    const rects = ints.map(([lo, hi]) => [[[lo, -50], [hi, -50], [hi, passage.h], [lo, passage.h], [lo, -50]]]);
    const res = polygonClipping.difference([[closeR(ring), ...holes.map(closeR)]], ...rects);
    return res.map((poly) => ({ ring: openR(poly[0]), holes: poly.slice(1).map(openR) })).filter((p) => p.ring.length >= 3);
  };
  const color = buildingColor(b);
  const isLandmark = ctx.landmarkIds.has(b.id);
  /** pieces: { w, ring: [[s,y]], holes, a, b, party } */
  const pieces = [];
  for (const w of prep.walls) {
    stats.walls++;
    let ints = [];
    if (w.onEdge) ints = coveredIntervals(ctx.edgeIndex, b.id, w.t, w.n2, w.w0, w.s0, w.s1, PARTY_DIST);
    // segments between interval boundaries
    const bounds = [w.s0];
    for (const [lo, hi] of ints) bounds.push(lo, hi);
    bounds.push(w.s1);
    let segs = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const a = bounds[i], c = bounds[i + 1];
      if (c - a <= 1e-6) continue;
      segs.push({ a, b: c, party: i % 2 === 1 });
    }
    // absorb tiny segments into their neighbours
    segs = absorbTiny(segs, 0.3);
    if (w.holes.length > 0 && segs.length > 1) {
      // do not split polygons with holes: majority vote
      const cov = segs.reduce((s, g) => s + (g.party ? g.b - g.a : 0), 0);
      segs = [{ a: w.s0, b: w.s1, party: cov > (w.s1 - w.s0) / 2 }];
    }
    for (const g of segs) {
      let ring = w.outer;
      if (segs.length > 1) {
        ring = clipU(clipU(ring, g.a, 1), g.b, -1);
        if (ring.length < 3) continue;
      }
      if (g.party) {
        stats.partyPieces++;
        if (isHidden(w, ring, g.a, g.b, ctx.wallIndex)) {
          stats.hiddenPieces++;
          continue;
        }
      }
      for (const cut of cutPassage(w, ring, segs.length > 1 ? [] : w.holes, g.a, g.b)) {
        pieces.push({ w, ring: cut.ring, holes: cut.holes, a: g.a, b: g.b, party: g.party });
      }
    }
  }
  // group coplanar adjacent pieces with the same party flag -> continuous u
  const groups = [];
  const sorted = pieces.slice().sort((p, q) => p.a - q.a);
  for (const p of sorted) {
    const g = groups.find(
      (G) => G.party === p.party && G.w.n2[0] * p.w.n2[0] + G.w.n2[1] * p.w.n2[1] > 0.9995 &&
        Math.abs(G.w.w0 - p.w.w0) < 0.05 && Math.abs(G.w.n[1] - p.w.n[1]) < 0.02 && p.a <= G.b + 0.05 && p.a >= G.a - 0.05,
    );
    if (g) { g.b = Math.max(g.b, p.b); g.items.push(p); }
    else groups.push({ party: p.party, w: p.w, a: p.a, b: p.b, items: [p] });
  }
  const wallPb = backdrop ? prims.backdrop : prims.wall;
  const gableStyle = backdrop || isLandmark ? null : gableStyleOf(b, color[0]);
  const gablePieces = [];
  for (const G of groups) {
    const width = G.b - G.a;
    // vertical extent of the facade group: low step walls (between roof levels, dormer sides)
    // get no windows either
    let gy0 = Infinity, gy1 = -Infinity;
    for (const p of G.items) for (const v of p.ring) { gy0 = Math.min(gy0, v[1]); gy1 = Math.max(gy1, v[1]); }
    const short = gy1 - gy0 < SHORT_WALL;
    let kind = G.party || width < NARROW || short ? KIND_PARTY : KIND_NORMAL;
    if (isLandmark) kind = KIND_LANDMARK;
    if (kind === KIND_PARTY) stats.partyGroups++;
    else if (kind === KIND_NORMAL) stats.normalGroups++;
    const col = [color[0], kind, color[2], color[3]];
    for (const p of G.items) {
      const w = p.w;
      // eave = minimum top height over the piece
      let eave = Infinity;
      for (const v of p.ring) {
        const r = yRangeAt(p.ring, Math.min(Math.max(v[0], p.a), p.b));
        if (r) eave = Math.min(eave, r[1]);
      }
      if (!Number.isFinite(eave)) continue;
      const rings = [p.ring, ...p.holes];
      const idx = triangulate2(rings);
      const flat = rings.flat();
      const base = [];
      for (const v of flat) {
        base.push(wallPb.vertex(wallPoint(w, v[0], v[1]), w.n, [v[0] - G.a, v[1]], [width, eave], col));
      }
      for (let i = 0; i < idx.length; i += 3) {
        const A = flat[idx[i]], B = flat[idx[i + 1]], C = flat[idx[i + 2]];
        const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
        if (Math.abs(cr) < 1e-6) continue;
        if (cr > 0) wallPb.tri(base[idx[i]], base[idx[i + 1]], base[idx[i + 2]]);
        else wallPb.tri(base[idx[i]], base[idx[i + 2]], base[idx[i + 1]]);
        stats.wallTris++;
      }
    }
    if (gableStyle && kind === KIND_NORMAL) for (const p of G.items) if (!p.holes.length) gablePieces.push(p);
  }
  // 3D BAG splits a gable facade at the apex into two coplanar walls (often with a small gap and
  // in different facade groups): cluster coplanar street-facade pieces into facades first
  if (gableStyle) {
    const facades = [];
    for (const p of gablePieces.sort((x, y) => x.a - y.a)) {
      const F = facades.find((q) => q.w.n2[0] * p.w.n2[0] + q.w.n2[1] * p.w.n2[1] > 0.999 && Math.abs(q.w.w0 - p.w.w0) < 0.08 &&
        Math.abs(q.w.n[1] - p.w.n[1]) < 0.02 && p.a <= q.b + 0.35 && p.b >= q.a - 0.35);
      if (F) { F.rings.push(p.ring); F.a = Math.min(F.a, p.a); F.b = Math.max(F.b, p.b); }
      else facades.push({ w: p.w, rings: [p.ring], a: p.a, b: p.b });
    }
    for (const F of facades) {
      const W = F.b - F.a;
      if (W < 3.5 || W > 10) continue;
      emitGableTop(F.w, F.rings, F.a, F.b, W, gableStyle, wallPb, [color[0], KIND_PARTY, color[2], color[3]], stats);
    }
  }
  if (passage && !backdrop) emitPassage(b, passage, prims, color, stats);
  // roofs
  const roofG = isLandmark ? KIND_LANDMARK : KIND_NORMAL;
  const rcol = [color[0], roofG, color[2], color[3]];
  for (const r of prep.roofs) {
    const slope = (Math.acos(Math.min(1, r.n[1])) * 180) / Math.PI;
    const pb = backdrop ? prims.backdrop : slope > FLAT_ROOF_DEG ? prims.roof_slanted : prims.roof_flat;
    // slope frame: e = along eave (horizontal), up = up-slope direction in the plane
    const hx = Math.hypot(r.n[0], r.n[2]);
    let e, up;
    if (hx > 1e-3) {
      e = [r.n[2] / hx, 0, -r.n[0] / hx];
      up = normalize3([-r.n[0] * r.n[1], 1 - r.n[1] * r.n[1], -r.n[2] * r.n[1]]);
    } else {
      e = [1, 0, 0];
      up = [0, 0, -1];
    }
    const { pts, tris } = triangulate3(r.rings, r.n);
    if (!tris.length) continue;
    const base = pts.map((p) =>
      pb.vertex(p, r.n, [p[0], p[2]], backdrop ? [0, 0] : [p[0] * e[0] + p[1] * e[1] + p[2] * e[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]], rcol),
    );
    for (let i = 0; i < tris.length; i += 3) pb.tri(base[tris[i]], base[tris[i + 1]], base[tris[i + 2]]);
    stats.roofTris += tris.length / 3;
  }
}

// ---------------------------------------------------------------------------------------------
// Historic gable tops. 3D BAG reconstructs every canal-house gable as a plain triangle; Alkmaar's
// fronts are a mix of trapgevels (step gables) and halsgevels (neck gables). For narrow pre-1910
// street facades with a triangular top, a brick parapet profile (0.35 m thick) is built on the
// slope lines, rising above the roof like the real ones. Seeded by the building style seed.
// ---------------------------------------------------------------------------------------------
const GABLE_T = 0.35;

/** 'trap' | 'hals' | 'klok' | 'plain' for an old building (by seed), null for a newer one. */
function gableStyleOf(b, seed) {
  const y = b.attrs.oorspronkelijkbouwjaar;
  const old = !Number.isFinite(y) || PLACEHOLDER_YEARS.has(y) || y <= 1910;
  if (!old) return null;
  const u = hash01(b.id + ':gable');
  if (u < 0.4) return 'trap';
  if (u < 0.65) return 'hals';
  if (u < 0.8) return 'klok';
  return 'plain';
}

/**
 * Detects a triangular gable top on a facade piece (ring in (s, y)) and emits the parapet profile.
 * Returns true when something was emitted.
 */
function emitGableTop(w, rings, a0, c0, width, style, pb, col, stats) {
  const skip = (why) => { stats.gableSkip = stats.gableSkip ?? {}; stats.gableSkip[why] = (stats.gableSkip[why] ?? 0) + 1; return false; };
  let a = Infinity, c = -Infinity;
  for (const ring of rings) for (const v of ring) { a = Math.min(a, v[0]); c = Math.max(c, v[0]); }
  a = Math.max(a, a0); c = Math.min(c, c0);
  const W = c - a;
  if (W < 3.5) return skip('narrow');
  /** top of the facade outline at s (highest over the coplanar pieces) */
  const top = (s) => {
    const q = Math.min(Math.max(s, a + 1e-3), c - 1e-3);
    let y = null;
    for (const ring of rings) { const r = yRangeAt(ring, q); if (r && (y === null || r[1] > y)) y = r[1]; }
    return y;
  };
  // apex = highest outline vertex
  let sA = 0, yA = -Infinity;
  for (const ring of rings) for (const v of ring) if (v[1] > yA) { yA = v[1]; sA = v[0]; }
  const eave = Math.min(top(a + 0.02) ?? yA, top(c - 0.02) ?? yA);
  const eL = top(a + 0.02), eR = top(c - 0.02);
  if (eL === null || eR === null) return skip('noEave');
  const e = Math.max(eL, eR);
  if (yA - e < 2.2) return skip('flat');
  if (Math.abs(eL - eR) > 0.9) return skip('asymmetric');
  if (yA - e > W * 1.6) return skip('tall');
  const f = (sA - a) / W;
  if (f < 0.35 || f > 0.65) return skip('offCentre');
  // both halves must be straight slopes from the eave corners to the apex
  const slopeL = (s) => eL + ((yA - eL) * (s - a)) / (sA - a);
  const slopeR = (s) => eR + ((yA - eR) * (c - s)) / (c - sA);
  for (const t of [0.25, 0.5, 0.75]) {
    const sl = a + (sA - a) * t, sr = sA + (c - sA) * t;
    if (Math.abs(top(sl) - slopeL(sl)) > 0.3 || Math.abs(top(sr) - slopeR(sr)) > 0.3) return skip('notStraight');
  }
  if (style === 'plain') return skip('plain');
  const blocks = [];
  if (style === 'trap') {
    const n = Math.max(2, Math.min(6, Math.round((yA - e) / 1.15)));
    const wA = Math.max(0.7, W * 0.16);
    const L = sA - wA / 2 - a, R = c - (sA + wA / 2);
    const rise = 0.2;
    for (let k = 0; k < n; k++) {
      const s0 = a + (L * k) / n, s1 = a + (L * (k + 1)) / n;
      const yt = slopeL(s1) + rise;
      blocks.push([[s0, slopeL(s0)], [s1, slopeL(s1)], [s1, yt], [s0, yt]]);
      const r1 = c - (R * k) / n, r0 = c - (R * (k + 1)) / n;
      const yr = slopeR(r0) + rise;
      blocks.push([[r0, slopeR(r0)], [r1, slopeR(r1)], [r1, yr], [r0, yr]]);
    }
    const yTop = yA + 0.55;
    blocks.push([[sA - wA / 2, slopeL(sA - wA / 2)], [sA, yA], [sA + wA / 2, slopeR(sA + wA / 2)], [sA + wA / 2, yTop], [sA - wA / 2, yTop]]);
  } else if (style === 'klok') {
    // klokgevel: bell outline (cosine bell, widened so it stays above the roof slopes)
    const Hb = yA - e + 0.8;
    const P = [[a, eL], [sA, yA], [c, eR]];
    const N = 16;
    for (let k = N - 1; k >= 1; k--) {
      const sk = a + (W * k) / N;
      const x = Math.min(1, Math.abs(sk - sA) / (sk < sA ? sA - a : c - sA));
      const yb = e + Hb * Math.pow((Math.cos(Math.PI * x) + 1) / 2, 0.6);
      const ys = sk < sA ? slopeL(sk) : slopeR(sk);
      P.push([sk, Math.max(yb, ys + 0.12)]);
    }
    // polygon: along the slopes (left eave -> apex -> right eave), back over the bell
    blocks.push(P.filter((p, i) => i < 3 || Math.abs(p[0] - sA) > 0.05));
  } else {
    // halsgevel: vertical neck with a small pediment, low shoulders where the neck meets the slopes
    const nw = Math.max(1.2, W * 0.4);
    const l = sA - nw / 2, r = sA + nw / 2;
    const yN = yA + 0.45;
    blocks.push([[l, slopeL(l)], [sA, yA], [r, slopeR(r)], [r, yN], [sA, yN + Math.min(1.0, nw * 0.45)], [l, yN]]);
    const sh = Math.min(0.8, (l - a) * 0.6);
    if (sh > 0.3) {
      blocks.push([[l - sh, slopeL(l - sh)], [l, slopeL(l)], [l, slopeL(l) + 0.5], [l - sh * 0.5, slopeL(l) + 0.5]]);
      blocks.push([[r, slopeR(r)], [r + sh, slopeR(r + sh)], [r + sh * 0.5, slopeR(r) + 0.5], [r, slopeR(r) + 0.5]]);
    }
    // the slopes below the shoulders get a thin coping course so the outline reads as a gable
    const cp = 0.18;
    blocks.push([[a, eL], [l - sh, slopeL(l - sh)], [l - sh, slopeL(l - sh) + cp], [a, eL + cp]]);
    blocks.push([[r + sh, slopeR(r + sh)], [c, eR], [c, eR + cp], [r + sh, slopeR(r + sh) + cp]]);
  }
  for (const P of blocks) prism(w, P, a0, width, eave, pb, col, stats);
  stats.gables = (stats.gables ?? 0) + 1;
  stats[`gable_${style}`] = (stats[`gable_${style}`] ?? 0) + 1;
  return true;
}

/** Extrude a CCW (s, y) polygon of wall w inwards by GABLE_T (front, back and side faces). */
function prism(w, P, uOff, width, eave, pb, col, stats) {
  const area = P.reduce((A, p, i) => { const q = P[(i + 1) % P.length]; return A + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  if (area < 0.01) return;
  const t3 = [w.t[0], 0, w.t[1]];
  const back = (p) => [p[0] - w.n2[0] * GABLE_T, p[1], p[2] - w.n2[1] * GABLE_T];
  const uv = (v) => [v[0] - uOff, v[1]];
  const F = P.map((v) => wallPoint(w, v[0], v[1]));
  const idx = triangulate2([P]);
  const nb = [-w.n[0], -w.n[1], -w.n[2]];
  const fv = P.map((v, i) => pb.vertex(F[i], w.n, uv(v), [width, eave], col));
  const bv = P.map((v, i) => pb.vertex(back(F[i]), nb, uv(v), [width, eave], col));
  for (let i = 0; i < idx.length; i += 3) {
    pb.tri(fv[idx[i]], fv[idx[i + 1]], fv[idx[i + 2]]);
    pb.tri(bv[idx[i]], bv[idx[i + 2]], bv[idx[i + 1]]);
    stats.wallTris += 2;
  }
  for (let i = 0; i < P.length; i++) {
    const j = (i + 1) % P.length;
    const ds = P[j][0] - P[i][0], dy = P[j][1] - P[i][1];
    const l = Math.hypot(ds, dy);
    if (l < 1e-3) continue;
    // outward normal of a CCW polygon edge (dy, -ds) in (s, y)
    const n = normalize3([t3[0] * dy, -ds, t3[2] * dy]);
    const A = pb.vertex(F[i], n, uv(P[i]), [width, eave], col);
    const B = pb.vertex(F[j], n, uv(P[j]), [width, eave], col);
    const C = pb.vertex(back(F[j]), n, uv(P[j]), [width, eave], col);
    const D = pb.vertex(back(F[i]), n, uv(P[i]), [width, eave], col);
    pb.tri(A, C, B);
    pb.tri(A, D, C);
    stats.wallTris += 2;
  }
}

/** Ceiling (roof_flat, facing down) and blank side walls of a building passage. */
function emitPassage(b, P, prims, color, stats) {
  const closeR = (r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);
  const openR = (r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
  const area = polygonClipping.intersection(P.mp, [b.footprint.map((r) => closeR(r.map((p) => [p[0], p[1]])))]);
  const H = P.h;
  const wcol = [color[0], KIND_PARTY, color[2], color[3]];
  const rcol = [color[0], KIND_NORMAL, color[2], color[3]];
  const fpDist = (x, z) => {
    let d2 = Infinity;
    for (const r of b.footprint) for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], l2 = dx * dx + dz * dz || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      d2 = Math.min(d2, (a[0] + dx * t - x) ** 2 + (a[1] + dz * t - z) ** 2);
    }
    return Math.sqrt(d2);
  };
  for (const poly of area) {
    const rings = poly.map(openR);
    // ceiling
    const idx = triangulate2(rings);
    const flat = rings.flat();
    const vs = flat.map((p) => prims.roof_flat.vertex([p[0], H, p[1]], [0, -1, 0], [p[0], p[1]], [p[0], p[1]], rcol));
    for (let i = 0; i < idx.length; i += 3) {
      const A = flat[idx[i]], B = flat[idx[i + 1]], C = flat[idx[i + 2]];
      const ny = (B[1] - A[1]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[1] - A[1]);
      if (Math.abs(ny) < 1e-9) continue;
      if (ny < 0) prims.roof_flat.tri(vs[idx[i]], vs[idx[i + 1]], vs[idx[i + 2]]);
      else prims.roof_flat.tri(vs[idx[i]], vs[idx[i + 2]], vs[idx[i + 1]]);
      stats.roofTris++;
    }
    // side walls along the passage edges inside the footprint (not the openings in the facade)
    for (const r of rings) for (let i = 0; i < r.length; i++) {
      const a = r[i], c = r[(i + 1) % r.length];
      const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      if (fpDist(mx, mz) < 0.05) continue;
      const nL = [-dz / len, dx / len];
      const inside = pointInPolygon(mx + nL[0] * 0.1, mz + nL[1] * 0.1, rings);
      const nIn = inside ? nL : [-nL[0], -nL[1]];
      const n = [nIn[0], 0, nIn[1]];
      const A0 = prims.wall.vertex([a[0], WALL_BOTTOM, a[1]], n, [0, WALL_BOTTOM], [len, H], wcol);
      const C0 = prims.wall.vertex([c[0], WALL_BOTTOM, c[1]], n, [len, WALL_BOTTOM], [len, H], wcol);
      const C1 = prims.wall.vertex([c[0], H, c[1]], n, [len, H], [len, H], wcol);
      const A1 = prims.wall.vertex([a[0], H, a[1]], n, [0, H], [len, H], wcol);
      if (inside) { prims.wall.tri(A0, C0, C1); prims.wall.tri(A0, C1, A1); }
      else { prims.wall.tri(A0, C1, C0); prims.wall.tri(A0, A1, C1); }
      stats.wallTris += 2;
    }
  }
}

function absorbTiny(segs, minLen) {
  if (segs.length <= 1) return segs;
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.b - s.a >= minLen) continue;
      // flip its class to match the longer neighbour, then merge equal neighbours
      const nb = [segs[i - 1], segs[i + 1]].filter(Boolean).sort((p, q) => (q.b - q.a) - (p.b - p.a))[0];
      if (nb && nb.party !== s.party) { s.party = nb.party; changed = true; }
    }
    const merged = [];
    for (const s of segs) {
      const last = merged[merged.length - 1];
      if (last && last.party === s.party) last.b = s.b;
      else merged.push({ ...s });
    }
    if (merged.length !== segs.length) changed = true;
    segs = merged;
    if (!changed) break;
  }
  return segs;
}
