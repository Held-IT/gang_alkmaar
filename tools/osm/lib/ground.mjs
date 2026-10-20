// Ground tile processor. Each 200 m tile of the playable area is partitioned into disjoint
// regions with polygon booleans (no overlaps => no z-fighting):
//   water (canal bed), bridge decks, low surfaces at y=0 (car roads, pedestrian streets,
//   squares, parking), raised surfaces at y=0.12 (curb strip, paths, cycleways, grass, sidewalk).
// Vertical faces are generated from region boundaries by sampling the neighbour just outside
// each edge: curbs (low<->raised), quay walls (land->water), bridge sides with arches (deck->
// water), green banks (grass->water); plus quay caps, bridge parapets and railings.
import RBush from 'rbush';
import earcut, { deviation } from 'earcut';
import { union, intersection, difference, clean, unionMany, setClipContext } from './clip.mjs';
import {
  normalizePoly, openRing, rectPoly, rectBBox, clipRingRect, expandRect, densifyRing, offsetRingChain, ringArea,
  simplifyRing, pointInPoly,
} from './geom.mjs';
import { CANAL_BED, SIDEWALK_H, WATER_LEVEL } from './proj.mjs';
import { MeshBuilder } from './mesh.mjs';

export const CAP_W = 0.32;
export const CAP_RISE = 0.06;

/** RBush of polygon records {poly, bb, ...}. */
export function polyTree(items) {
  const t = new RBush();
  t.load(items.filter((i) => Number.isFinite(i.bb[0])).map((i) => ({ minX: i.bb[0], minY: i.bb[1], maxX: i.bb[2], maxY: i.bb[3], item: i })));
  return t;
}

const searchRect = (tree, rc, m = 0) => tree.search({ minX: rc.minX - m, minY: rc.minZ - m, maxX: rc.maxX + m, maxY: rc.maxZ + m }).map((h) => h.item);

/** Clip a polygon to rc (expanded) with Sutherland-Hodgman; null if empty. */
function preclip(poly, rc) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const r = clipRingRect(openRing(poly[i]), rc);
    if (r.length < 3 || Math.abs(ringArea(r)) < 1e-4) { if (i === 0) return null; continue; }
    out.push(r);
  }
  return out;
}

function unionClipped(items, rc, simplifyTol = 0) {
  const er = expandRect(rc, 1);
  const polys = [];
  for (const it of items) {
    let p = preclip(it.poly, er);
    if (!p) continue;
    if (simplifyTol) p = p.map((r) => simplifyRing(r, simplifyTol));
    polys.push([p]);
  }
  if (!polys.length) return [];
  return union(...polys);
}

function triangulateOnce(poly) {
  const flat = [];
  const holes = [];
  for (let r = 0; r < poly.length; r++) {
    if (r > 0) holes.push(flat.length / 2);
    for (const p of poly[r]) flat.push(p[0], p[1]);
  }
  const h = holes.length ? holes : undefined;
  const tris = earcut(flat, h, 2);
  return { flat, tris, dev: tris.length ? deviation(flat, h, 2, tris) : 1 };
}

export const triStats = { fallbacks: 0, failed: 0 };

/**
 * earcut with a safety net: complex union results (holes touching the outline etc.) sometimes
 * triangulate incompletely; then the polygon is cut into grid cells and each cell triangulated.
 */
export function triangulate(poly, depth = 0) {
  const r = triangulateOnce(poly);
  if (r.dev < 1e-6 || depth >= 3) {
    if (r.dev >= 1e-6) triStats.failed++;
    return r;
  }
  triStats.fallbacks++;
  let bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of poly[0]) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); }
  const n = 3;
  const cw = (bb[2] - bb[0]) / n + 1e-6, ch = (bb[3] - bb[1]) / n + 1e-6;
  const flat = [], tris = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const cell = { minX: bb[0] + i * cw, maxX: bb[0] + (i + 1) * cw, minZ: bb[1] + j * ch, maxZ: bb[1] + (j + 1) * ch };
    const parts = clean(intersection([poly], [rectPoly(cell)]), 1e-4);
    for (const part of parts) {
      const t = triangulate(normalizePoly(part), depth + 1);
      const base = flat.length / 2;
      flat.push(...t.flat);
      for (const k of t.tris) tris.push(k + base);
    }
  }
  return { flat, tris, dev: 0 };
}

/**
 * Triangle locator: point -> region. Regions: { kind: 'water'|'low'|'raised'|'deck', mat, h, deck? }
 */
/**
 * Triangulate a polygon cut into a world-aligned grid of `cell` m squares (vertices shared
 * between cells), so curved surfaces (arched bridge decks) get interior vertices at least every
 * `cell` metres. The outline keeps all its own vertices (plus grid-line crossings).
 */
export function gridTriangulate(poly, cell) {
  const outer = poly[0];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of outer) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
  const flat = [], tris = [];
  const vmap = new Map();
  const vid = (x, z) => {
    const k = `${Math.round(x * 1e3)},${Math.round(z * 1e3)}`;
    let i = vmap.get(k);
    if (i === undefined) { i = flat.length / 2; flat.push(x, z); vmap.set(k, i); }
    return i;
  };
  for (let gx = Math.floor(x0 / cell) * cell; gx < x1; gx += cell) {
    for (let gz = Math.floor(z0 / cell) * cell; gz < z1; gz += cell) {
      const pieces = clean(intersection([poly], rectPoly({ minX: gx, minZ: gz, maxX: gx + cell, maxZ: gz + cell })), 1e-4);
      for (const piece of pieces) {
        const t = triangulate(normalizePoly(piece));
        for (let k = 0; k < t.tris.length; k += 3) {
          const a = vid(t.flat[t.tris[k] * 2], t.flat[t.tris[k] * 2 + 1]);
          const b = vid(t.flat[t.tris[k + 1] * 2], t.flat[t.tris[k + 1] * 2 + 1]);
          const c = vid(t.flat[t.tris[k + 2] * 2], t.flat[t.tris[k + 2] * 2 + 1]);
          if (a !== b && b !== c && a !== c) tris.push(a, b, c);
        }
      }
    }
  }
  if (!tris.length) return triangulate(poly);
  return { flat, tris };
}

export class Locator {
  constructor() { this.items = []; this.tree = null; }
  add(flat, tris, region) {
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
      const ax = flat[a], az = flat[a + 1], bx = flat[b], bz = flat[b + 1], cx = flat[c], cz = flat[c + 1];
      this.items.push({
        minX: Math.min(ax, bx, cx), minY: Math.min(az, bz, cz), maxX: Math.max(ax, bx, cx), maxY: Math.max(az, bz, cz),
        ax, az, bx, bz, cx, cz, region,
      });
    }
  }
  build() { this.tree = new RBush(); this.tree.load(this.items); this.items = []; }
  /**
   * Serialise (after build) to { tris: Float32Array (6 per triangle), reg: Uint32Array, regions }.
   * Regions keep only plain fields; decks are referenced by their index in `decks`.
   */
  toCache(decks) {
    const all = this.tree.all();
    const regIdx = new Map();
    const regions = [];
    const tris = new Float32Array(all.length * 6);
    const reg = new Uint32Array(all.length);
    all.forEach((t, i) => {
      let k = regIdx.get(t.region);
      if (k === undefined) {
        const r = t.region;
        k = regions.length;
        regIdx.set(r, k);
        regions.push({ kind: r.kind, mat: r.mat, h: r.h ?? 0, layer: r.layer, garden: r.garden, curbStrip: r.curbStrip, deck: r.deck ? decks.indexOf(r.deck) : undefined });
      }
      tris.set([t.ax, t.az, t.bx, t.bz, t.cx, t.cz], i * 6);
      reg[i] = k;
    });
    return { tris, reg, regions };
  }
  static fromCache({ tris, reg, regions }, decks) {
    const loc = new Locator();
    for (const r of regions) if (r.deck !== undefined && r.deck >= 0) r.deck = decks[r.deck];
    for (let i = 0; i < reg.length; i++) {
      const o = i * 6;
      const ax = tris[o], az = tris[o + 1], bx = tris[o + 2], bz = tris[o + 3], cx = tris[o + 4], cz = tris[o + 5];
      loc.items.push({
        minX: Math.min(ax, bx, cx), minY: Math.min(az, bz, cz), maxX: Math.max(ax, bx, cx), maxY: Math.max(az, bz, cz),
        ax, az, bx, bz, cx, cz, region: regions[reg[i]],
      });
    }
    loc.build();
    return loc;
  }
  /** Highest-priority region at (x, z); `skipDecks` looks underneath bridge decks. */
  locate(x, z, skipDecks = false) {
    const hits = this.tree.search({ minX: x, minY: z, maxX: x, maxY: z });
    let best = null;
    for (const t of hits) {
      if (skipDecks && t.region.kind === 'deck') continue;
      const d1 = (x - t.bx) * (t.az - t.bz) - (t.ax - t.bx) * (z - t.bz);
      const d2 = (x - t.cx) * (t.bz - t.cz) - (t.bx - t.cx) * (z - t.cz);
      const d3 = (x - t.ax) * (t.cz - t.az) - (t.cx - t.ax) * (z - t.az);
      const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (neg && pos) continue;
      if (!best || PRI[t.region.kind] > PRI[best.kind]) best = t.region;
    }
    return best;
  }
}
const PRI = { deck: 3, low: 2, raised: 2, under: 1, water: 0 };

export function regionHeight(reg, x, z) {
  if (!reg) return 0;
  if (reg.kind === 'deck') return reg.deck.heightAt(x, z);
  if (reg.kind === 'water') return CANAL_BED;
  if (reg.kind === 'under') return reg.h;
  return reg.h;
}

/**
 * Process one playable tile.
 * @param rc tile rect; ctx shared context (trees, decks, playable rect); out {mats, coll, locator}
 */
export function processPlayableTile(rc, ctx, out) {
  const { mats, coll } = out;
  setClipContext(`tile ${rc.minX},${rc.minZ}`);
  const T = [rectPoly(rc)];
  const W = clean(intersection(unionClipped(searchRect(ctx.waterTree, rc, 1), rc), T), 0.05);
  const deckParts = [];
  let Dacc = [];
  for (const h of ctx.deckTree.search({ minX: rc.minX, minY: rc.minZ, maxX: rc.maxX, maxY: rc.maxZ })) {
    let dp = clean(intersection(h.d.poly, T), 0.02);
    if (Dacc.length) dp = clean(difference(dp, Dacc), 0.02);
    if (!dp.length) continue;
    deckParts.push({ deck: h.d, mp: dp });
    Dacc = union(Dacc, dp);
  }
  const land = clean(difference(T, W, Dacc), 0.02);

  /** @type {Array<{mp:any, mat:string, kind:string, h:number, deck?:any}>} */
  const regions = [];
  // ---- low surfaces (y = 0)
  let acc = [];
  for (const L of ctx.lowLayers) {
    const items = searchRect(L.tree, rc, 1);
    if (!items.length) continue;
    let r = intersection(union(...items.map((i) => [i.poly])), land);
    if (L.maskLayer) {
      const mItems = searchRect(L.maskLayer.tree, rc, 1);
      r = mItems.length ? intersection(r, union(...mItems.map((i) => [i.poly]))) : [];
    }
    if (acc.length) r = difference(r, acc);
    r = clean(r, 0.05);
    if (!r.length) continue;
    regions.push({ mp: r, mat: L.mat, kind: 'low', h: 0, layer: L.key });
    acc = union(acc, r);
  }
  // ---- raised (y = 0.12)
  let R = clean(difference(land, acc), 0.02);
  {
    const items = searchRect(ctx.curbTree, rc, 1);
    if (items.length && R.length) {
      const cs = clean(intersection(union(...items.map((i) => [i.poly])), R), 0.01);
      if (cs.length) {
        regions.push({ mp: cs, mat: 'curb', kind: 'raised', h: SIDEWALK_H, curbStrip: true });
        R = clean(difference(R, cs), 0.02);
      }
    }
  }
  let accR = [];
  for (const L of ctx.raisedLayers) {
    if (!R.length) break;
    const items = searchRect(L.tree, rc, 1);
    if (!items.length) continue;
    let r = intersection(L.isArea ? unionClipped(items, rc) : union(...items.map((i) => [i.poly])), R);
    if (accR.length) r = difference(r, accR);
    r = clean(r, 0.05);
    if (!r.length) continue;
    regions.push({ mp: r, mat: L.mat, kind: 'raised', h: L.h ?? SIDEWALK_H, layer: L.key });
    accR = union(accR, r);
  }
  let SW = clean(accR.length ? difference(R, accR) : R, 0.02);
  // Back gardens: parts of the pavement fill farther than GARDEN_DIST from any block edge (street,
  // path, water, park) become grass, unless inside paved land use (industry, schools, ...).
  if (SW.length && ctx.gardens !== false) {
    const G = gardensOf(SW, rc, ctx);
    if (G.length) {
      regions.push({ mp: G, mat: 'grass', kind: 'raised', h: SIDEWALK_H, garden: true });
      SW = clean(difference(SW, G), 0.02);
    }
  }
  if (SW.length) regions.push({ mp: SW, mat: 'sidewalk', kind: 'raised', h: SIDEWALK_H });

  // ---- normalise + mesh + locator
  const loc = new Locator();
  const waterReg = { kind: 'water', mat: 'canal_bed', h: CANAL_BED, mp: W.map(normalizePoly) };
  for (const poly of waterReg.mp) {
    const { flat, tris } = triangulate(poly);
    addTris(mats.get('canal_bed'), flat, tris, () => CANAL_BED, coll);
    loc.add(flat, tris, waterReg);
  }
  for (const reg of regions) {
    reg.mp = reg.mp.map(normalizePoly);
    for (const poly of reg.mp) {
      const { flat, tris } = triangulate(poly);
      addTris(mats.get(reg.mat), flat, tris, () => reg.h, coll);
      loc.add(flat, tris, reg);
      out.globalLoc?.add(flat, tris, reg);
    }
  }
  const deckRegs = [];
  for (const dp of deckParts) {
    const reg = { kind: 'deck', mat: 'bridge_deck', deck: dp.deck, mp: dp.mp.map(normalizePoly) };
    reg.mp = reg.mp.map((poly) => poly.map((r) => densifyRing(r, 1.0)));
    const curved = dp.deck.rise > 0 || !!dp.deck.group;
    for (const poly of reg.mp) {
      // curved decks need interior vertices, otherwise long earcut triangles flatten the arch
      // and leave ridges where a car crosses them
      const { flat, tris } = curved ? gridTriangulate(poly, 2.0) : triangulate(poly);
      addTris(mats.get('bridge_deck'), flat, tris, (x, z) => dp.deck.heightAt(x, z), coll, true);
      loc.add(flat, tris, reg);
      out.globalLoc?.add(flat, tris, reg);
    }
    deckRegs.push(reg);
  }
  // ground under bridge decks where there is no water (abutments): a hidden surface at -0.3 whose
  // water-side edges get quay walls, so nothing is see-through under the arches
  const underRegs = [];
  if (Dacc.length) {
    const U = clean(difference(Dacc, W), 0.05);
    if (U.length) {
      const reg = { kind: 'under', mat: 'quay', h: -0.3, mp: U.map(normalizePoly) };
      for (const poly of reg.mp) {
        const { flat, tris } = triangulate(poly);
        addTris(mats.get('quay'), flat, tris, () => reg.h, null);
        loc.add(flat, tris, reg);
      }
      underRegs.push(reg);
    }
  }
  loc.build();
  out.regionsCount = regions.length + deckRegs.length;
  if (ctx.probe && ctx.probe[0] >= rc.minX && ctx.probe[0] <= rc.maxX && ctx.probe[1] >= rc.minZ && ctx.probe[1] <= rc.maxZ) {
    const [px, pz] = ctx.probe;
    const inM = (mp) => mp.some((p) => pointInPoly(px, pz, p));
    console.log('[probe]', px, pz, { W: inM(W), D: inM(Dacc), land: inM(land), U: underRegs.some((r) => inM(r.mp)), decks: deckParts.map((d) => [d.deck.id, inM(d.mp)]) });
    for (const r of regions) if (inM(r.mp)) console.log('[probe] region', r.kind, r.mat);
    console.log('[probe] locate ->', loc.locate(px, pz)?.kind, loc.locate(px, pz)?.mat);
  }

  // ---- vertical faces etc.
  const pr = ctx.playable;
  const onLine = (a, b, coord, v) => Math.abs(a[coord] - v) < 1e-6 && Math.abs(b[coord] - v) < 1e-6;
  const onRect = (a, b, r) => onLine(a, b, 0, r.minX) || onLine(a, b, 0, r.maxX) || onLine(a, b, 1, r.minZ) || onLine(a, b, 1, r.maxZ);

  for (const reg of [...regions, ...deckRegs, ...underRegs]) {
    for (const poly of reg.mp) for (const ring of poly) {
      const n = ring.length;
      const info = new Array(n);
      let u = 0;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        const e = { a, b, len, u, cls: 'none', nx: 0, nz: 0, nb: null };
        info[i] = e;
        u += len;
        if (len < 1e-5) continue;
        e.nx = dz / len; e.nz = -dx / len;
        if (onRect(a, b, rc)) {
          if (onRect(a, b, pr)) e.cls = 'border';
          continue;
        }
        const mx = (a[0] + b[0]) / 2 + e.nx * 0.03, mz = (a[1] + b[1]) / 2 + e.nz * 0.03;
        const nb = loc.locate(mx, mz);
        e.nb = nb;
        if (!nb) continue;
        if (nb.kind === 'water') e.cls = reg.kind === 'deck' ? 'deckwater' : reg.mat === 'grass' ? 'bank' : 'quay';
        else if (reg.kind === 'under') e.cls = 'none';
        else e.cls = 'step';
        // rail corridor: fence along every edge towards ordinary land (not tracks, platforms, decks)
        if (e.cls === 'step' && reg.layer === 'rail' && nb.layer !== 'rail' && nb.layer !== 'platform' && nb.kind !== 'deck' && nb.kind !== 'under') e.fence = true;
        if (e.cls === 'step' && reg.layer === 'platform' && nb.layer === 'rail') e.platformEdge = true;
        // land next to a bridge deck with water underneath: the quay wall continues under the deck
        if (nb.kind === 'deck' && reg.kind !== 'deck' && reg.kind !== 'under') {
          const below = loc.locate(mx, mz, true);
          if (below?.kind === 'water') e.underWater = true;
        }
      }
      // walls
      for (const e of info) {
        if (e.cls === 'none' || e.len < 1e-5) continue;
        const ha = regionHeight(reg, e.a[0], e.a[1]), hb = regionHeight(reg, e.b[0], e.b[1]);
        if (e.cls === 'border') {
          mats.get('curb').addWall(e.a, e.b, ha, hb, Math.min(0, ha), Math.min(0, hb), e.nx, e.nz, e.u, coll);
        } else if (e.cls === 'quay') {
          mats.get('quay').addWall(e.a, e.b, ha, hb, CANAL_BED, CANAL_BED, e.nx, e.nz, e.u, reg.kind === 'under' ? null : coll);
        } else if (e.cls === 'step') {
          if (e.underWater) mats.get('quay').addWall(e.a, e.b, Math.min(ha, 0), Math.min(hb, 0), CANAL_BED, CANAL_BED, e.nx, e.nz, e.u, null);
          const na = regionHeight(e.nb, e.a[0], e.a[1]), nbh = regionHeight(e.nb, e.b[0], e.b[1]);
          if (ha > na + 0.003 || hb > nbh + 0.003) {
            const mat = reg.kind === 'deck' ? 'bridge_side' : 'curb';
            mats.get(mat).addWall(e.a, e.b, ha, hb, Math.min(ha, na), Math.min(hb, nbh), e.nx, e.nz, e.u, coll);
          }
        } else if (e.cls === 'deckwater') {
          // subdivided so the arch underside is smooth
          const steps = Math.max(1, Math.ceil(e.len / 0.5));
          const d = reg.deck;
          for (let k = 0; k < steps; k++) {
            const t0 = k / steps, t1 = (k + 1) / steps;
            const p0 = [e.a[0] + (e.b[0] - e.a[0]) * t0, e.a[1] + (e.b[1] - e.a[1]) * t0];
            const p1 = [e.a[0] + (e.b[0] - e.a[0]) * t1, e.a[1] + (e.b[1] - e.a[1]) * t1];
            mats.get('bridge_side').addWall(p0, p1, d.heightAt(p0[0], p0[1]), d.heightAt(p1[0], p1[1]),
              d.bottomAt(p0[0], p0[1]), d.bottomAt(p1[0], p1[1]), e.nx, e.nz, e.u + e.len * t0, coll);
          }
        }
      }
      // (not around holes: an island enclosed by the yard cannot be reached by car anyway)
      if (reg.layer === 'rail' && ring === poly[0]) for (const chain of chainsOf(info, (e) => e.fence)) addRailFence(mats, chain, reg.h, coll);
      if (reg.layer === 'platform') for (const chain of chainsOf(info, (e) => e.platformEdge)) addPlatformLine(mats.get('road_marking'), chain, reg.h);
      // chains (caps / banks / parapets)
      for (const cls of ['quay', 'bank', 'deckwater']) {
        for (const chain of chainsOf(info, cls)) {
          if (cls === 'quay') { if (reg.kind !== 'under') addQuayCap(mats.get('quay_cap'), chain, reg.h, coll); }
          else if (cls === 'bank') addBank(mats, chain, reg.h, coll);
          else addParapet(mats, chain, reg.deck, coll);
        }
      }
    }
  }
  return { W: waterReg.mp, regions, deckRegs };
}

const GARDEN_DIST = 7;

/** Erosion of the pavement fill by GARDEN_DIST (tile-boundary edges excluded), minus paved land use. */
function gardensOf(SW, rc, ctx) {
  const onLine = (a, b, coord, v) => Math.abs(a[coord] - v) < 1e-6 && Math.abs(b[coord] - v) < 1e-6;
  const onRect = (a, b) => onLine(a, b, 0, rc.minX) || onLine(a, b, 0, rc.maxX) || onLine(a, b, 1, rc.minZ) || onLine(a, b, 1, rc.maxZ);
  const pieces = [];
  const d = GARDEN_DIST;
  for (const poly of SW) {
    // tiny or thin blocks cannot hold a garden
    for (const ring0 of poly) {
      const ring = openRing(ring0);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (onRect(a, b)) continue;
        const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 1e-3) continue;
        const nx = -dz / L * d, nz = dx / L * d;
        pieces.push([[[a[0] - nx, a[1] - nz], [b[0] - nx, b[1] - nz], [b[0] + nx, b[1] + nz], [a[0] + nx, a[1] + nz]]]);
        pieces.push([octagon(a[0], a[1], d)]);
      }
    }
  }
  if (!pieces.length) return [];
  let blocked = unionMany(pieces.map((p) => p[0]), 300);
  const paved = ctx.pavedTree ? searchRect(ctx.pavedTree, rc, 1) : [];
  if (paved.length) blocked = union(blocked, unionClipped(paved, rc));
  return clean(difference(SW, blocked), 25);
}

function octagon(cx, cz, r) {
  const out = [];
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); }
  return out;
}

function addTris(mb, flat, tris, hfn, coll, smooth = false) {
  const base = mb.n;
  for (let i = 0; i < flat.length; i += 2) mb.vert(flat[i], hfn(flat[i], flat[i + 1]), flat[i + 1], 0, 1, 0, flat[i], flat[i + 1]);
  const i0 = mb.idx.length;
  for (let i = 0; i < tris.length; i += 3) mb.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2], 0, 1, 0);
  if (smooth) mb.smoothNormals(base, mb.n, i0);
  if (coll) for (let i = i0; i < mb.idx.length; i += 3) coll.addTriFrom(mb, mb.idx[i], mb.idx[i + 1], mb.idx[i + 2]);
}

/** Consecutive runs of edges with class `cls` in a ring -> [{pts, closed}] */
function chainsOf(info, cls) {
  const n = info.length;
  const test = typeof cls === 'function' ? cls : (e) => e.cls === cls;
  const isC = (i) => test(info[(i + n) % n]) && info[(i + n) % n].len > 1e-5;
  const out = [];
  if (!info.some((e, i) => isC(i))) return out;
  if (info.every((e, i) => isC(i) || e.len <= 1e-5)) {
    out.push({ pts: info.filter((e) => e.len > 1e-5).map((e) => e.a), closed: true });
    return out;
  }
  // start at an edge whose predecessor is not cls
  let start = 0;
  while (!(isC(start) && !isC(start - 1))) start++;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (isC(i) && !isC(i - 1)) {
      const pts = [info[i].a];
      let j = i;
      while (isC(j)) { pts.push(info[(j + n) % n].b); j++; if (j - i > n) break; }
      out.push({ pts, closed: false });
    }
  }
  return out;
}

const FENCE_IN = 0.35, FENCE_H = 1.5, POST_STEP = 2.5;
/**
 * Railway fence (posts + three rails, dark steel) just inside the rail corridor edge, with a 1.5 m
 * collision wall so cars cannot get onto the tracks.
 */
function addRailFence(mats, chain, h, coll) {
  if (chain.pts.length < 2) return;
  const pts = offsetRingChain(chain.pts, FENCE_IN, chain.closed);
  const mb = mats.get('bridge_rail');
  const collMb = new MeshBuilder(); // collision-only geometry, not rendered
  const n = pts.length, segs = chain.closed ? n : n - 1;
  let u = 0, nextPost = 0;
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-3) continue;
    const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
    for (const [y0, y1] of [[0.1, 0.15], [0.78, 0.83], [1.42, 1.48]]) sBeam(mb, a, b, 0.05, h + y0, h + y1, h + y0, h + y1, null);
    while (nextPost <= u + L + 1e-6) {
      const t = nextPost - u;
      const px = a[0] + tx * t, pz = a[1] + tz * t;
      mb.addBeam([px - tx * 0.035, pz - tz * 0.035], [px + tx * 0.035, pz + tz * 0.035], 0.07, h - 0.05, h + 1.55, null);
      nextPost += POST_STEP;
    }
    // collision only: a solid wall along the fence line
    // facing out of the corridor (towards the road): the game's trimeshes are one-sided
    collMb.addWall(a, b, h + FENCE_H, h + FENCE_H, h - 0.3, h - 0.3, tz, -tx, 0, coll);
    u += L;
  }
  if (!chain.closed) {
    const a = pts[n - 1], p = pts[n - 2];
    const L = Math.hypot(a[0] - p[0], a[1] - p[1]) || 1;
    const tx = (a[0] - p[0]) / L, tz = (a[1] - p[1]) / L;
    mb.addBeam([a[0] - tx * 0.035, a[1] - tz * 0.035], [a[0] + tx * 0.035, a[1] + tz * 0.035], 0.07, h - 0.05, h + 1.55, null);
  }
}


/** White safety line on the platform, 0.6 m from the edge along the tracks. */
function addPlatformLine(mb, chain, h) {
  if (chain.pts.length < 2) return;
  const a = offsetRingChain(chain.pts, 0.6, chain.closed), b = offsetRingChain(chain.pts, 0.7, chain.closed);
  const n = a.length, segs = chain.closed ? n : n - 1, y = h + 0.006;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    mb.addQuad([a[i][0], y, a[i][1]], [a[j][0], y, a[j][1]], [b[j][0], y, b[j][1]], [b[i][0], y, b[i][1]], [0, 1, 0],
      [[a[i][0], a[i][1]], [a[j][0], a[j][1]], [b[j][0], b[j][1]], [b[i][0], b[i][1]]]);
  }
}

/** Stone coping along a quay chain: top strip (land side 0.32 m), small overhang over the water. */
function addQuayCap(mb, chain, h, coll) {
  const pts = chain.pts;
  if (pts.length < 2) return;
  const inner = offsetRingChain(pts, CAP_W, chain.closed);
  const outer = offsetRingChain(pts, -0.03, chain.closed);
  const top = h + CAP_RISE;
  const n = pts.length;
  const segs = chain.closed ? n : n - 1;
  let u = 0;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const o0 = outer[i], o1 = outer[j], i0 = inner[i], i1 = inner[j];
    const L = Math.hypot(o1[0] - o0[0], o1[1] - o0[1]);
    mb.addQuad([o0[0], top, o0[1]], [o1[0], top, o1[1]], [i1[0], top, i1[1]], [i0[0], top, i0[1]], [0, 1, 0],
      [[o0[0], o0[1]], [o1[0], o1[1]], [i1[0], i1[1]], [i0[0], i0[1]]], coll);
    // water face (outer) faces right of chain direction
    const dx = o1[0] - o0[0], dz = o1[1] - o0[1], l = Math.hypot(dx, dz) || 1;
    mb.addWall(o0, o1, top, top, -0.28, -0.28, dz / l, -dx / l, u, coll);
    // land face (inner) faces left
    const ex = i1[0] - i0[0], ez = i1[1] - i0[1], m = Math.hypot(ex, ez) || 1;
    mb.addWall(i1, i0, top, top, h, h, -ez / m, ex / m, u, coll);
    u += L;
  }
  if (!chain.closed) {
    for (const [k, sgn] of [[0, -1], [n - 1, 1]]) {
      const o = outer[k], ii = inner[k];
      const d = k === 0 ? [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]] : [pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]];
      const l = Math.hypot(d[0], d[1]) || 1;
      const nx = (d[0] / l) * sgn, nz = (d[1] / l) * sgn;
      mb.addWall(k === 0 ? ii : o, k === 0 ? o : ii, top, top, h, h, nx, nz, 0, coll);
    }
  }
}

/** Green bank: slope from the grass edge down under the water to the canal bed. */
function addBank(mats, chain, h, coll) {
  const pts = chain.pts;
  if (pts.length < 2) return;
  const off1 = offsetRingChain(pts, -2.2, chain.closed);
  const off2 = offsetRingChain(pts, -3.8, chain.closed);
  const y1 = WATER_LEVEL - 0.45;
  const n = pts.length;
  const segs = chain.closed ? n : n - 1;
  const g = mats.get('grass'), bed = mats.get('canal_bed');
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = pts[i], b = pts[j];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const ox = dz / l, oz = -dx / l; // outward (towards water)
    const s1 = [ox * 0.74, 0.67, oz * 0.74];
    g.addQuad([a[0], h, a[1]], [b[0], h, b[1]], [off1[j][0], y1, off1[j][1]], [off1[i][0], y1, off1[i][1]], s1,
      [[a[0], a[1]], [b[0], b[1]], [off1[j][0], off1[j][1]], [off1[i][0], off1[i][1]]], coll);
    const s2 = [ox * 0.6, 0.8, oz * 0.6];
    bed.addQuad([off1[i][0], y1, off1[i][1]], [off1[j][0], y1, off1[j][1]], [off2[j][0], CANAL_BED, off2[j][1]], [off2[i][0], CANAL_BED, off2[i][1]], s2,
      [[off1[i][0], off1[i][1]], [off1[j][0], off1[j][1]], [off2[j][0], off2[j][1]], [off2[i][0], off2[i][1]]], coll);
  }
}

/** Sloped box between two plan points with per-end bottom/top heights (railing parts). */
function sBeam(mb, a, b, w, ya0, ya1, yb0, yb1, coll) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz);
  if (L < 1e-4) return;
  const tx = dx / L, tz = dz / L;
  const nx = -tz * (w / 2), nz = tx * (w / 2);
  const A0 = [a[0] + nx, a[1] + nz], A1 = [a[0] - nx, a[1] - nz], B0 = [b[0] + nx, b[1] + nz], B1 = [b[0] - nx, b[1] - nz];
  mb.addQuad([A0[0], ya1, A0[1]], [B0[0], yb1, B0[1]], [B1[0], yb1, B1[1]], [A1[0], ya1, A1[1]], [0, 1, 0], [[0, 0], [L, 0], [L, w], [0, w]], coll);
  mb.addQuad([A0[0], ya0, A0[1]], [A1[0], ya0, A1[1]], [B1[0], yb0, B1[1]], [B0[0], yb0, B0[1]], [0, -1, 0], [[0, 0], [0, w], [L, w], [L, 0]], coll);
  mb.addQuad([A0[0], ya1, A0[1]], [A0[0], ya0, A0[1]], [B0[0], yb0, B0[1]], [B0[0], yb1, B0[1]], [-tz, 0, tx], [[0, ya1], [0, ya0], [L, yb0], [L, yb1]], coll);
  mb.addQuad([B1[0], yb1, B1[1]], [B1[0], yb0, B1[1]], [A1[0], ya0, A1[1]], [A1[0], ya1, A1[1]], [tz, 0, -tx], [[0, yb1], [0, yb0], [L, ya0], [L, ya1]], coll);
}

function addParapet(mats, chain, deck, coll) {
  const pts = chain.pts;
  if (pts.length < 2) return;
  const side = mats.get('bridge_side'), rail = mats.get('bridge_rail');
  const inner = offsetRingChain(pts, 0.28, chain.closed);
  const n = pts.length;
  const segs = chain.closed ? n : n - 1;
  const H0 = 0.3;
  const hAt = (p) => deck.heightAt(p[0], p[1]);
  let u = 0;
  // brick/stone curb of the parapet
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const a = pts[i], b = pts[j], ia = inner[i], ib = inner[j];
    const ha = hAt(a), hb = hAt(b), hia = hAt(ia), hib = hAt(ib);
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    side.addWall(a, b, ha + H0, hb + H0, ha, hb, dz / l, -dx / l, u, coll);
    side.addQuad([a[0], ha + H0, a[1]], [b[0], hb + H0, b[1]], [ib[0], hib + H0, ib[1]], [ia[0], hia + H0, ia[1]], [0, 1, 0],
      [[a[0], a[1]], [b[0], b[1]], [ib[0], ib[1]], [ia[0], ia[1]]], coll);
    const ex = ib[0] - ia[0], ez = ib[1] - ia[1], m = Math.hypot(ex, ez) || 1;
    side.addWall(ib, ia, hib + H0, hia + H0, hib, hia, -ez / m, ex / m, u, coll);
    u += l;
  }
  // railing: posts + rails along the centre line of the curb
  const mid = pts.map((p, i) => [(p[0] + inner[i][0]) / 2, (p[1] + inner[i][1]) / 2]);
  let acc = 0;
  const postEvery = 1.8;
  const postPts = [mid[0]];
  for (let i = 0; i < segs; i++) {
    const a = mid[i], b = mid[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = postEvery - acc;
    while (s < L) { postPts.push([a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L]); s += postEvery; }
    acc = (acc + L) % postEvery;
  }
  if (!chain.closed) postPts.push(mid[n - 1]);
  for (const p of postPts) {
    const h = hAt(p) + H0;
    const d = 0.035;
    sBeam(rail, [p[0] - d, p[1]], [p[0] + d, p[1]], 0.07, h, h + 0.78, h, h + 0.78, null);
  }
  for (let i = 0; i < segs; i++) {
    const a = mid[i], b = mid[(i + 1) % n];
    const ha = hAt(a) + H0, hb = hAt(b) + H0;
    sBeam(rail, a, b, 0.06, ha + 0.72, ha + 0.8, hb + 0.72, hb + 0.8, null);
    sBeam(rail, a, b, 0.03, ha + 0.36, ha + 0.4, hb + 0.36, hb + 0.4, null);
    // invisible collision fence so cars cannot drop off the bridge
    if (coll) {
      const tmp = { pos: [a[0], ha, a[1], b[0], hb, b[1], b[0], hb + 0.9, b[1], a[0], ha + 0.9, a[1]] };
      coll.addTriFrom(tmp, 0, 1, 2);
      coll.addTriFrom(tmp, 0, 2, 3);
    }
  }
}

/** Underside vault of an arched deck (render only). */
export function addVault(mb, deck, crossSection) {
  if (!deck.arch) return;
  const step = 0.5;
  let prev = null;
  for (let s = deck.s0 - 0.25; s <= deck.s1 + 0.25 + 1e-6; s += step) {
    const cs = crossSection(deck, s);
    if (!cs) { prev = null; continue; }
    const y = deck.bottomAt(cs.center[0], cs.center[1]);
    const cur = { l: cs.left, r: cs.right, y };
    if (prev) {
      mb.addQuad([prev.l[0], prev.y, prev.l[1]], [cur.l[0], cur.y, cur.l[1]], [cur.r[0], cur.y, cur.r[1]], [prev.r[0], prev.y, prev.r[1]], [0, -1, 0],
        [[prev.l[0], prev.y], [cur.l[0], cur.y], [cur.r[0], cur.y], [prev.r[0], prev.y]]);
    }
    prev = cur;
  }
}

/**
 * Backdrop tile: low detail, everything at y = 0 except water; roads drawn over water (bridges),
 * simple vertical banks down to -2.5.
 */
export function processBackdropTile(rc, ctx, out) {
  setClipContext(`backdrop ${rc.minX},${rc.minZ}`);
  const { mats } = out;
  const T = [rectPoly(rc)];
  const W0 = clean(intersection(unionClipped(searchRect(ctx.waterTree, rc, 1), rc, 0.6), T), 0.5);
  const roadItems = searchRect(ctx.backdropRoadTree, rc, 1);
  const roads = roadItems.length ? clean(intersection(union(...roadItems.map((i) => [i.poly])), T), 0.3) : [];
  const W = clean(difference(W0, roads), 0.5);
  const land = clean(difference(T, W, roads), 0.3);
  const gItems = searchRect(ctx.grassTree, rc, 1);
  const G = gItems.length ? clean(intersection(unionClipped(gItems, rc, 0.8), land), 1) : [];
  const rest = clean(G.length ? difference(land, G) : land, 0.3);
  const B = -2.5;
  const put = (mp, mat, h) => {
    for (const p of mp) {
      const poly = normalizePoly(p);
      const { flat, tris } = triangulate(poly);
      addTris(mats.get(mat), flat, tris, () => h, null);
    }
  };
  put(roads, 'asphalt', 0);
  put(G, 'grass', 0);
  put(rest, 'ground', 0);
  put(W, 'canal_bed', B);
  // banks: walls along water edges (faces towards the water)
  const onLine = (a, b, coord, v) => Math.abs(a[coord] - v) < 1e-6 && Math.abs(b[coord] - v) < 1e-6;
  for (const p of W) for (const r of normalizePoly(p)) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      if (onLine(a, b, 0, rc.minX) || onLine(a, b, 0, rc.maxX) || onLine(a, b, 1, rc.minZ) || onLine(a, b, 1, rc.maxZ)) continue;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      if (l < 1e-4) continue;
      // water interior on the left; wall faces into the water (left normal)
      mats.get('quay').addWall(b, a, 0, 0, B, B, -dz / l, dx / l, 0, null);
    }
  }
}
