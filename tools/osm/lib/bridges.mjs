// Bridge decks: every bridge (road/cycle/foot/rail way tagged bridge=*, or man_made=bridge
// area) that crosses water becomes a deck polygon with a height function (gentle arch for short
// canal bridges, flat for long ones), an arch-shaped underside and parapets. Also fills the gaps
// that the 3dShapes water polygons leave under bridges so canals continue under the deck.
import RBush from 'rbush';
import { union, intersection, difference, clean } from './clip.mjs';
import {
  bboxOfMulti, bboxOfPts, bufferPolylinePieces, cumLengths, polylineLength, projectOnPolyline, pointAt, pointInMulti,
  rectPoly, multiArea, openRing, dirOf, leftN, segIntersectT,
} from './geom.mjs';
import { CANAL_BED, WATER_LEVEL } from './proj.mjs';

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

/** Merge bridge ways that continue each other (share an end node) into chains. */
function chainWays(ways) {
  const byEnd = new Map();
  for (const w of ways) for (const n of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
    if (!byEnd.has(n)) byEnd.set(n, []);
    byEnd.get(n).push(w);
  }
  const used = new Set();
  const chains = [];
  for (const w of ways) {
    if (used.has(w)) continue;
    used.add(w);
    let pts = w.pts.slice();
    let nodes = w.nodes.slice();
    const members = [w];
    for (const dir of [1, -1]) {
      for (;;) {
        const endNode = dir === 1 ? nodes[nodes.length - 1] : nodes[0];
        const cand = (byEnd.get(endNode) ?? []).filter((o) => !used.has(o) && o.kind === w.kind);
        if (byEnd.get(endNode).length !== 2 || cand.length !== 1) break;
        const o = cand[0];
        used.add(o);
        members.push(o);
        let op = o.pts, on = o.nodes;
        if (dir === 1) {
          if (on[0] !== endNode) { op = op.slice().reverse(); on = on.slice().reverse(); }
          pts = pts.concat(op.slice(1)); nodes = nodes.concat(on.slice(1));
        } else {
          if (on[on.length - 1] !== endNode) { op = op.slice().reverse(); on = on.slice().reverse(); }
          pts = op.slice(0, -1).concat(pts); nodes = on.slice(0, -1).concat(nodes);
        }
      }
    }
    chains.push({ pts, nodes, members, kind: w.kind, width: Math.max(...members.map((m) => m.width)), tags: w.tags });
  }
  return chains;
}

const KIND_RANK = { car: 4, bus: 3, ped: 2, cycle: 2, foot: 1, rail: 0 };

/**
 * @param roads classified road features; rails rail features; bridgeAreas man_made=bridge areas
 * @param waterTree rbush of water records ({poly, bb})
 * @returns {{ decks: any[], gapFill: any[] }}
 */
export function buildDecks(roads, rails, bridgeAreas, waterTree, area) {
  const nearWater = (bb, m) => waterTree.search({ minX: bb[0] - m, minY: bb[1] - m, maxX: bb[2] + m, maxY: bb[3] + m });
  const waterMP = (bb, m) => nearWater(bb, m).map((w) => w.item.poly);

  // 1) candidate ways
  const bridgeWays = roads.filter((r) => r.bridge && r.tags.bridge !== 'boardwalk' && r.layer >= 0).map((r) => ({ ...r }));
  for (const r of rails) if (r.bridge) bridgeWays.push({ id: r.id, pts: r.pts, nodes: r.nodes, kind: 'rail', width: 4, tags: r.tags });
  const inArea = (pts) => pts.some((p) => p[0] > area.minX - 50 && p[0] < area.maxX + 50 && p[1] > area.minZ - 50 && p[1] < area.maxZ + 50);
  const ways = bridgeWays.filter((w) => w.pts.length >= 2 && inArea(w.pts));
  for (const w of ways) if (!w.nodes || w.nodes.length !== w.pts.length) w.nodes = w.pts.map((_, i) => -(w.id * 1000 + i));
  const chains = chainWays(ways);

  // 2) raw decks
  const raw = [];
  const areaRecs = bridgeAreas.filter((a) => inArea(a.poly[0])).map((a) => ({ ...a, axis: null, rank: -1, chainList: [] }));
  for (const c of chains) {
    const mid = pointAt(c.pts, cumLengths(c.pts), polylineLength(c.pts) / 2);
    const host = areaRecs.find((a) => pointInMulti(mid.x, mid.z, [a.poly]));
    if (host) {
      host.chainList.push(c);
      continue;
    }
    const extra = c.kind === 'car' || c.kind === 'bus' ? 1.2 : c.kind === 'rail' ? 0.8 : 0.35;
    const hw = c.width / 2 + extra;
    const poly = union(...bufferPolylinePieces(c.pts, hw).map((p) => [p]));
    raw.push({ poly: clean(poly), axis: c.pts, rank: KIND_RANK[c.kind] ?? 0, kind: c.kind, hw, ids: c.members.map((m) => m.id), humpback: /humpback/.test(c.tags?.['bridge:structure'] ?? '') });
  }
  for (const a of areaRecs) {
    let axis = null, rank = 0, kind = 'foot', hw = 3;
    if (a.chainList.length) {
      a.chainList.sort((p, q) => (KIND_RANK[q.kind] ?? 0) - (KIND_RANK[p.kind] ?? 0) || polylineLength(q.pts) - polylineLength(p.pts));
      axis = a.chainList[0].pts; rank = KIND_RANK[a.chainList[0].kind] ?? 0; kind = a.chainList[0].kind; hw = a.chainList[0].width / 2;
    } else {
      // principal axis of the outline
      const pts = a.poly[0];
      let cx = 0, cz = 0;
      for (const p of pts) { cx += p[0]; cz += p[1]; }
      cx /= pts.length; cz /= pts.length;
      let sxx = 0, szz = 0, sxz = 0;
      for (const p of pts) { const dx = p[0] - cx, dz = p[1] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      let lo = Infinity, hi = -Infinity;
      for (const p of pts) { const s = (p[0] - cx) * Math.cos(ang) + (p[1] - cz) * Math.sin(ang); lo = Math.min(lo, s); hi = Math.max(hi, s); }
      axis = [[cx + Math.cos(ang) * lo, cz + Math.sin(ang) * lo], [cx + Math.cos(ang) * hi, cz + Math.sin(ang) * hi]];
    }
    const isHump = /humpback/.test(a.tags?.['bridge:structure'] ?? '') || a.chainList.some((c) => /humpback/.test(c.tags?.['bridge:structure'] ?? ''));
    raw.push({ poly: [a.poly], axis, rank, kind, hw, ids: [a.id, ...a.chainList.flatMap((c) => c.members.map((m) => m.id))], humpback: isHump, fromArea: true, fromChain: a.chainList.length > 0 });
  }

  // keep only decks near water
  const overWater = raw.filter((d) => {
    if (!d.poly.length) return false;
    const bb = bboxOfMulti(d.poly);
    const wn = waterMP(bb, 8);
    if (!wn.length) return false;
    const box = rectPoly({ minX: bb[0] - 6, minZ: bb[1] - 6, maxX: bb[2] + 6, maxZ: bb[3] + 6 });
    const w = intersection(union(...wn.map((p) => [p])), [box]);
    return multiArea(w) > 4;
  });

  // 3) merge overlapping decks (e.g. road + separately mapped sidewalks on one bridge)
  overWater.sort((a, b) => b.rank - a.rank || multiArea(b.poly) - multiArea(a.poly));
  const merged = [];
  const grownOf = (d, g) => d.fromArea ? d.poly : union(...bufferPolylinePieces(d.axis, d.hw + g).map((p) => [p]));
  for (const d of overWater) {
    const bb = bboxOfMulti(d.poly);
    let host = null, parallel = false;
    for (const m of merged) {
      const mb = bboxOfMulti(m.poly);
      if (bb[0] > mb[2] + 3 || bb[2] < mb[0] - 3 || bb[1] > mb[3] + 3 || bb[3] < mb[1] - 3) continue;
      if (multiArea(intersection(m.poly, d.poly)) > 0.3) { host = m; break; }
      // separate carriageways of one bridge (e.g. Friesebrug): close and parallel
      if (!d.fromArea && !m.fromArea && multiArea(intersection(grownOf(m, 4.0), d.poly)) > 0.5) {
        const da = dirOf(d.axis[0], d.axis[d.axis.length - 1]), ma = dirOf(m.axis[0], m.axis[m.axis.length - 1]);
        if (Math.abs(da[0] * ma[0] + da[1] * ma[1]) > 0.9) { host = m; parallel = true; break; }
      }
    }
    if (host) {
      const hull = parallel ? [[convexHull([...host.poly.flatMap((p) => openRing(p[0])), ...d.poly.flatMap((p) => openRing(p[0]))])]] : [];
      host.poly = clean(union(host.poly, d.poly, hull));
      host.ids.push(...d.ids);
      host.humpback = host.humpback || d.humpback;
      host.hw = Math.max(host.hw, d.hw);
    } else merged.push({ ...d, ids: d.ids.slice() });
  }

  // 4) water gap fill under each deck + final deck polygons and profiles
  const decks = [];
  const gapFill = [];
  let idn = 0;
  let extendedHeads = 0;
  for (const d of merged) {
    const bb = bboxOfMulti(d.poly);
    const m = 6;
    const box = [rectPoly({ minX: bb[0] - m, minZ: bb[1] - m, maxX: bb[2] + m, maxZ: bb[3] + m })];
    const wNear = intersection(union(...waterMP(bb, m + 2).map((p) => [p])), box);
    let gap = [];
    if (wNear.length >= 1) {
      const hullPts = convexHull(wNear.flatMap((p) => openRing(p[0])));
      if (hullPts.length >= 3) {
        const hull = [[hullPts]];
        // limit to the deck grown by 3 m (pieces of the deck outline buffered)
        const grown = union(d.poly, ...d.poly.flatMap((p) => p.flatMap((r) => {
          const rr = openRing(r);
          return bufferPolylinePieces([...rr, rr[0]], 3).map((q) => [q]);
        })));
        gap = clean(intersection(difference(hull, wNear), grown), 0.5);
        // only keep gap pieces that overlap the deck itself
        gap = gap.filter((g) => multiArea(intersection([g], d.poly)) > 0.5);
      }
    }
    let poly = clean(gap.length ? union(d.poly, gap) : d.poly, 0.2);
    if (!poly.length) continue;
    if (!d.fromArea || d.fromChain) {
      // bridge heads that stop just short of the bank (OSM way ends on the water edge, e.g. the
      // Baanbrug): extend the deck along the axis onto the land, otherwise a water sliver with a
      // parapet across the road blocks it
      const ext = [];
      for (const end of [0, 1]) {
        const ax = d.axis, n = ax.length;
        const p = end ? ax[n - 1] : ax[0], q = end ? ax[n - 2] : ax[1];
        const t = dirOf(q, p); // outward
        const [lx, lz] = leftN(t[0], t[1]);
        const hwS = Math.max(0.5, d.hw - 0.8);
        let wetTo = 0;
        for (const e of [0.04, 0.08, 0.12, 0.18, 0.25, 0.375, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4]) {
          for (let l = -hwS; l <= hwS + 1e-6; l += hwS / 4) {
            const x = p[0] + t[0] * e + lx * l, z = p[1] + t[1] * e + lz * l;
            if (pointInMulti(x, z, wNear) && !pointInMulti(x, z, poly)) { wetTo = e; break; }
          }
        }
        if (wetTo > 0 && wetTo < 3.5) {
          const L2 = wetTo + 0.75;
          // starts 0.5 m inside the deck so the pieces overlap (the deck end is rarely square)
          ext.push(...bufferPolylinePieces([[p[0] - t[0] * 0.5, p[1] - t[1] * 0.5], [p[0] + t[0] * L2, p[1] + t[1] * L2]], d.hw).map((r) => [r]));
        }
      }
      if (ext.length) { poly = clean(union(poly, ...ext), 0.2); extendedHeads++; }
    }
    const waterHere = clean(union(wNear, gap));

    // axis profile
    const axis = d.axis;
    const cum = cumLengths(axis);
    const L = cum[cum.length - 1];
    // extend axis virtually by projecting deck outline extent
    let sMin = Infinity, sMax = -Infinity;
    for (const p of poly) for (const q of p[0]) { const pr = projectOnPolyline(axis, cum, q[0], q[1]); sMin = Math.min(sMin, pr.s); sMax = Math.max(sMax, pr.s); }
    // water interval along the axis
    let s0 = Infinity, s1 = -Infinity;
    for (let s = 0; s <= L; s += 0.5) {
      const p = pointAt(axis, cum, s);
      if (pointInMulti(p.x, p.z, waterHere)) { s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
    }
    const span = s1 > s0 ? s1 - s0 : 0;
    // not really over water (e.g. a road bridge over a culvert next to the singel): plain road
    if (span < 1) continue;
    if (gap.length) gapFill.push(...gap);
    let rise = 0;
    if (span > 1 && span <= 26 && d.kind !== 'rail') {
      rise = Math.min(0.6, Math.max(0.2, 0.035 * span + 0.1));
      if (d.humpback) rise = 0.6;
    }
    const margin = Math.max(3, 0.6 * span);
    const sA = Math.max(0, s0 - margin), sB = Math.min(L, s1 + margin);
    const arch = span > 1 && span <= 16 && d.kind !== 'rail';
    const deck = {
      id: idn++, poly, bb: bboxOfMulti(poly), axis, cum, L, rise, s0, s1, sA, sB, span, arch, kind: d.kind, ids: d.ids, hw: d.hw,
      heightAtS(s) {
        const rise = this.rise;
        if (rise <= 0 || sB - sA < 1) return 0;
        const t = (s - sA) / (sB - sA);
        if (t <= 0 || t >= 1) return 0;
        const k = Math.sin(Math.PI * t);
        return rise * k * k;
      },
      /** own profile, faded out sideways beyond hw + 1 m (wide decks meet the street flush) */
      ownHeight(x, z) {
        const pr = projectOnPolyline(axis, cum, x, z);
        const h = this.heightAtS(pr.s);
        if (h <= 0) return 0;
        const t = Math.min(1, Math.max(0, (pr.d - (this.hw + 1)) / 5));
        let f = 1 - t * t * (3 - 2 * t);
        // flush with the carriageway of other car roads touching the deck (quay streets at the
        // bridge heads, side streets joining on the bridge)
        for (const r of this.foreign ?? []) {
          const q = projectOnPolyline(r.pts, r.cum, x, z);
          const u = Math.min(1, Math.max(0, (q.d - r.hw) / 4));
          f = Math.min(f, u * u * (3 - 2 * u));
        }
        return h * f;
      },
      heightAt(x, z) {
        if (!this.group) return this.ownHeight(x, z);
        let h = 0;
        for (const g of this.group) h = Math.max(h, g.ownHeight(x, z));
        return h;
      },
      /** underside of the bridge body at (x, z) when that point is over water */
      bottomAt(x, z) {
        const s = projectOnPolyline(axis, cum, x, z).s;
        const top = this.heightAtS(s);
        if (span <= 1 || s < s0 - 0.25 || s > s1 + 0.25) return CANAL_BED;
        if (!arch) return Math.max(WATER_LEVEL + 0.4, top - 0.9);
        const sm = (s0 + s1) / 2, half = span / 2 + 0.25;
        const u = Math.min(1, Math.abs(s - sm) / half);
        const spring = WATER_LEVEL - 0.4;
        const crown = this.heightAtS(sm) - 0.45;
        return spring + (crown - spring) * Math.sqrt(Math.max(0, 1 - u * u));
      },
    };
    decks.push(deck);
  }
  if (extendedHeads) console.log(`[bridges] ${extendedHeads} deck(s) extended onto the bank`);
  flattenCrossedDecks(decks, roads);
  groupTouchingDecks(decks);
  attachForeignRoads(decks, roads);
  return { decks, gapFill: clean(gapFill.length ? union(...gapFill.map((g) => [g])) : []) };
}

/** Cross-section half extents of a deck polygon at axis position s (for the vault underside). */
/**
 * A deck crossed at an angle by another car road (a junction on the bridge, a square-like bridge
 * with streets along it) gets no arch: cars on the crossing road must not meet a ridge.
 */
function flattenCrossedDecks(decks, roads) {
  for (const d of decks) {
    if (d.rise <= 0) continue;
    const own = new Set(d.ids);
    for (const r of roads) {
      if (own.has(r.id) || !(r.kind === 'car' || r.kind === 'bus') || r.tunnel) continue;
      const bb = bboxOfPts(r.pts);
      if (bb[0] > d.bb[2] || bb[2] < d.bb[0] || bb[1] > d.bb[3] || bb[3] < d.bb[1]) continue;
      const cum = cumLengths(r.pts), L = cum[cum.length - 1];
      let hits = 0;
      for (let s = 0; s <= L; s += 1) {
        const p = pointAt(r.pts, cum, s);
        if (!pointInMulti(p.x, p.z, d.poly)) continue;
        const pr = projectOnPolyline(d.axis, d.cum, p.x, p.z);
        if (Math.abs(p.dx * pr.dx + p.dz * pr.dz) < 0.82 && d.ownHeight(p.x, p.z) > 0.03) hits++;
      }
      if (hits >= 2) { d.rise = 0; break; }
    }
  }
}

/** Car roads (not carried by the deck or its touching group) that come within 3 m of a deck. */
function attachForeignRoads(decks, roads) {
  for (const d of decks) {
    if (d.rise <= 0) continue;
    const own = new Set((d.group ?? [d]).flatMap((g) => g.ids));
    const bb = d.bb;
    for (const r of roads) {
      if (own.has(r.id) || !(r.kind === 'car' || r.kind === 'bus')) continue;
      const rb = bboxOfPts(r.pts);
      const m = r.width / 2 + 3;
      if (rb[0] > bb[2] + m || rb[2] < bb[0] - m || rb[1] > bb[3] + m || rb[3] < bb[1] - m) continue;
      // close enough to the deck outline?
      let near = false;
      const cum = cumLengths(r.pts), L = cum[cum.length - 1];
      for (let s = 0; s <= L && !near; s += 1) {
        const p = pointAt(r.pts, cum, s);
        if (pointInMulti(p.x, p.z, d.poly)) { near = true; break; }
        for (const poly of d.poly) for (const q of poly[0]) if (Math.hypot(q[0] - p.x, q[1] - p.z) < m) { near = true; break; }
      }
      if (near) (d.foreign ??= []).push({ pts: r.pts, cum, hw: r.width / 2 });
    }
  }
}

/** Decks that touch share one height field (max of their profiles): no steps between them. */
function groupTouchingDecks(decks) {
  const parent = decks.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const near = (a, b) => {
    for (const p of a.poly) for (const q of p[0]) {
      if (pointInMulti(q[0], q[1], b.poly)) return true;
      for (const pb of b.poly) {
        const r = pb[0];
        for (let i = 0; i < r.length; i++) {
          const u = r[i], v = r[(i + 1) % r.length];
          const dx = v[0] - u[0], dz = v[1] - u[1], l2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((q[0] - u[0]) * dx + (q[1] - u[1]) * dz) / l2));
          if (Math.hypot(u[0] + dx * t - q[0], u[1] + dz * t - q[1]) < 0.6) return true;
        }
      }
    }
    return false;
  };
  for (let i = 0; i < decks.length; i++) for (let j = i + 1; j < decks.length; j++) {
    const a = decks[i], b = decks[j];
    if (a.bb[0] > b.bb[2] + 1 || a.bb[2] < b.bb[0] - 1 || a.bb[1] > b.bb[3] + 1 || a.bb[3] < b.bb[1] - 1) continue;
    if (near(a, b) || near(b, a)) parent[find(i)] = find(j);
  }
  const groups = new Map();
  decks.forEach((d, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
  for (const g of groups.values()) if (g.length > 1) for (const d of g) d.group = g;
}

export function deckCrossSection(deck, s) {
  const p = pointAt(deck.axis, deck.cum, Math.max(0, Math.min(deck.L, s)));
  const [nx, nz] = leftN(p.dx, p.dz);
  const far = 60;
  const a = [p.x - nx * far, p.z - nz * far], b = [p.x + nx * far, p.z + nz * far];
  let tMin = Infinity, tMax = -Infinity;
  for (const poly of deck.poly) for (const ring of poly) {
    const r = openRing(ring);
    for (let i = 0; i < r.length; i++) {
      const t = segIntersectT(a, b, r[i], r[(i + 1) % r.length]);
      if (t !== null) { tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
    }
  }
  if (!(tMax > tMin)) return null;
  const toPt = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { left: toPt(tMin), right: toPt(tMax), center: [p.x, p.z], dir: [p.dx, p.dz] };
}

export function deckTree(decks) {
  const t = new RBush();
  t.load(decks.map((d) => ({ minX: d.bb[0], minY: d.bb[1], maxX: d.bb[2], maxY: d.bb[3], d })));
  return t;
}
