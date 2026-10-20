// Road surface pieces for the ground builder:
//   * centre line -> convex pieces (segment quads + round joins), junction discs
//   * facade fitting: pedestrian streets span facade to facade; narrow car streets without room
//     for sidewalks become flush (woonerf-like) streets that reach the facades
//   * kerb fillets (rounded corners) at junctions of car roads
//   * curb-strip pieces (road grown by 0.15 m) and painted cycle-lane strips
import { bboxOfPts, bufferPolylinePieces, cumLengths, discRing, dirOf, leftN, offsetPolyline, pointAt, segIntersectT, pointInRing } from './geom.mjs';

const RAY = 18;

/** Distance from p along direction n to the nearest building edge (or Infinity). */
function facadeDist(bTree, p, n) {
  const q = [p[0] + n[0] * RAY, p[1] + n[1] * RAY];
  const hits = bTree.search({ minX: Math.min(p[0], q[0]), minY: Math.min(p[1], q[1]), maxX: Math.max(p[0], q[0]), maxY: Math.max(p[1], q[1]) });
  let best = Infinity;
  for (const h of hits) {
    const ring = h.item.poly[0];
    for (let i = 0; i < ring.length; i++) {
      const t = segIntersectT(p, q, ring[i], ring[(i + 1) % ring.length]);
      if (t !== null && t * RAY < best) best = t * RAY;
    }
  }
  return best;
}

function insideBuilding(bTree, p) {
  for (const h of bTree.search({ minX: p[0], minY: p[1], maxX: p[0], maxY: p[1] })) if (pointInRing(p[0], p[1], h.item.poly[0])) return true;
  return false;
}

/** Facade distances (left/right of travel in the (x,z) math plane) sampled every `step` m. */
function sampleFacades(r, bTree, step = 3) {
  const cum = cumLengths(r.pts);
  const L = cum[cum.length - 1];
  const out = [];
  const n = Math.max(2, Math.ceil(L / step) + 1);
  for (let k = 0; k < n; k++) {
    const s = (k / (n - 1)) * L;
    const p = pointAt(r.pts, cum, s);
    const pt = [p.x, p.z];
    if (insideBuilding(bTree, pt)) { out.push({ s, p: pt, d: [p.dx, p.dz], a: NaN, b: NaN }); continue; }
    const nl = leftN(p.dx, p.dz);
    out.push({ s, p: pt, d: [p.dx, p.dz], a: facadeDist(bTree, pt, nl), b: facadeDist(bTree, pt, [-nl[0], -nl[1]]) });
  }
  return out;
}

const pct = (arr, q) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
};

/** Variable-width pieces from samples (half widths ha on the math-left, hb on the right). */
function variablePieces(samples) {
  const pieces = [];
  for (let k = 1; k < samples.length; k++) {
    const s0 = samples[k - 1], s1 = samples[k];
    const d = dirOf(s0.p, s1.p);
    const n = leftN(d[0], d[1]);
    if (Math.hypot(s1.p[0] - s0.p[0], s1.p[1] - s0.p[1]) < 1e-3) continue;
    pieces.push([[
      [s0.p[0] - n[0] * s0.hb, s0.p[1] - n[1] * s0.hb], [s1.p[0] - n[0] * s1.hb, s1.p[1] - n[1] * s1.hb],
      [s1.p[0] + n[0] * s1.ha, s1.p[1] + n[1] * s1.ha], [s0.p[0] + n[0] * s0.ha, s0.p[1] + n[1] * s0.ha],
    ]]);
    // joins at sample points (cover bends)
    if (k < samples.length - 1) {
      const hw = Math.max(s1.ha, s1.hb);
      pieces.push([discRing(s1.p[0], s1.p[1], Math.min(s1.ha, s1.hb, hw), 8)]);
    }
  }
  return pieces;
}

/** Kerb fillet polygon between two arms at junction P (CCW-adjacent in the math plane). */
function fillet(P, ui, hwi, uj, hwj, r) {
  const ni = leftN(ui[0], ui[1]), nj = leftN(uj[0], uj[1]);
  // edge of arm i on its math-left, edge of arm j on its math-right
  const a0 = [P[0] + ni[0] * hwi, P[1] + ni[1] * hwi];
  const b0 = [P[0] - nj[0] * hwj, P[1] - nj[1] * hwj];
  const den = ui[0] * uj[1] - ui[1] * uj[0];
  if (Math.abs(den) < 0.15) return null; // nearly parallel
  const t = ((b0[0] - a0[0]) * uj[1] - (b0[1] - a0[1]) * uj[0]) / den;
  const s = ((b0[0] - a0[0]) * ui[1] - (b0[1] - a0[1]) * ui[0]) / den;
  if (t < -0.5 || s < -0.5) return null;
  const C = [a0[0] + ui[0] * t, a0[1] + ui[1] * t];
  const cosPhi = ui[0] * uj[0] + ui[1] * uj[1];
  const phi = Math.acos(Math.max(-1, Math.min(1, cosPhi)));
  if (phi < 0.35 || phi > 2.8) return null;
  const tanHalf = Math.tan(phi / 2);
  let rr = r;
  if (rr / tanHalf > 7) rr = 7 * tanHalf;
  const off = rr / tanHalf;
  const T1 = [C[0] + ui[0] * off, C[1] + ui[1] * off];
  const T2 = [C[0] + uj[0] * off, C[1] + uj[1] * off];
  // centre: from T1 towards the block (math-left of ui)
  const O = [T1[0] + ni[0] * rr, T1[1] + ni[1] * rr];
  let a1 = Math.atan2(T1[1] - O[1], T1[0] - O[0]);
  let a2 = Math.atan2(T2[1] - O[1], T2[0] - O[0]);
  let da = a2 - a1;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  const ring = [C, T1];
  const steps = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 12)));
  for (let k = 1; k < steps; k++) {
    const a = a1 + (da * k) / steps;
    ring.push([O[0] + Math.cos(a) * rr, O[1] + Math.sin(a) * rr]);
  }
  ring.push(T2);
  return ring;
}

/**
 * @returns {{ items: Map<string, any[]>, laneStrips: any[], parkStrips: any[], flush: Set<number>, fitted: Map<number, any> }}
 */
export function buildRoadPieces(roads, bTree, rails, squares, parking) {
  const items = new Map();
  const add = (key, polys, road) => {
    if (!items.has(key)) items.set(key, []);
    for (const p of polys) if (p && p[0] && p[0].length >= 3) items.get(key).push({ poly: p, bb: bboxOfPts(p[0]), road });
  };
  const nodeUse = new Map();
  const pathNodeUse = new Map();
  for (const r of roads) {
    const m = r.kind === 'foot' || r.kind === 'cycle' ? pathNodeUse : nodeUse;
    for (const n of r.nodes) m.set(n, (m.get(n) ?? 0) + 1);
  }
  const flush = new Set();
  const fitted = new Map();
  const laneStrips = [];
  const parkStrips = [];

  const keyFor = (r) => {
    if (r.kind === 'car' || r.kind === 'bus') return r.mat === 'asphalt' ? 'carA' : r.mat === 'ground' ? 'carG' : 'carK';
    if (r.kind === 'ped') return r.mat === 'asphalt' ? 'pedA' : 'pedK';
    return `path_${r.mat}`;
  };

  for (const r of roads) {
    const key = keyFor(r);
    const lowRoad = r.kind === 'car' || r.kind === 'bus' || r.kind === 'ped';
    let pieces = null;
    let hwDisc = r.width / 2;
    if (lowRoad && !r.bridge) {
      const samples = sampleFacades(r, bTree);
      const gaps = samples.map((s) => s.a + s.b);
      const g25 = pct(gaps, 0.3);
      if (r.kind === 'ped') {
        // flush paving from facade to facade (0.5 m under the walls), default width where open
        for (const s of samples) {
          s.ha = Number.isFinite(s.a) && s.a < 14 ? s.a + 0.5 : Math.max(r.width / 2, 3);
          s.hb = Number.isFinite(s.b) && s.b < 14 ? s.b + 0.5 : Math.max(r.width / 2, 3);
          if (!Number.isFinite(s.ha)) s.ha = r.width / 2;
          if (!Number.isFinite(s.hb)) s.hb = r.width / 2;
        }
        smooth(samples);
        pieces = variablePieces(samples);
        fitted.set(r.id, samples);
      } else if (Number.isFinite(g25) && g25 < r.width + 1.7 && r.hw !== 'service' && !['trunk', 'primary', 'secondary'].includes(r.hw)) {
        // too narrow for sidewalks: flush street from facade to facade
        flush.add(r.id);
        for (const s of samples) {
          const half = Math.max(r.width / 2, 2);
          s.ha = Number.isFinite(s.a) && s.a < half + 3 ? s.a + 0.5 : half;
          s.hb = Number.isFinite(s.b) && s.b < half + 3 ? s.b + 0.5 : half;
        }
        smooth(samples);
        pieces = variablePieces(samples);
        fitted.set(r.id, samples);
      }
    }
    if (!pieces) pieces = bufferPolylinePieces(r.pts, r.width / 2);
    // junction discs at way ends that continue into other ways
    const use = r.kind === 'foot' || r.kind === 'cycle' ? pathNodeUse : nodeUse;
    for (const k of [0, r.pts.length - 1]) {
      if ((use.get(r.nodes[k]) ?? 0) >= 2) pieces.push([discRing(r.pts[k][0], r.pts[k][1], hwDisc, 12)]);
    }
    add(key, pieces, r);
    if ((r.kind === 'car' || r.kind === 'bus') && !flush.has(r.id)) {
      const cp = bufferPolylinePieces(r.pts, r.width / 2 + 0.15);
      for (const k of [0, r.pts.length - 1]) if ((nodeUse.get(r.nodes[k]) ?? 0) >= 2) cp.push([discRing(r.pts[k][0], r.pts[k][1], r.width / 2 + 0.15, 12)]);
      add('curb', cp, r);
      // on-street parking strips (low 'parking' surface beside the carriageway, own outer curb);
      // trimmed back from junctions. The graph width stays the carriageway width.
      if (r.kind === 'car' && r.park && (r.park.L || r.park.R)) {
        const cum = cumLengths(r.pts);
        const L = cum[cum.length - 1];
        const t0 = (nodeUse.get(r.nodes[0]) ?? 0) >= 2 ? 6 : 0.5;
        const t1 = (nodeUse.get(r.nodes[r.nodes.length - 1]) ?? 0) >= 2 ? 6 : 0.5;
        if (L - t0 - t1 >= 6) {
          const base = subPolyline(r.pts, cum, t0, L - t1);
          for (const [ps, sgn] of [[r.park.L, -1], [r.park.R, 1]]) {
            if (!ps) continue;
            const line = offsetPolyline(base, sgn * (r.width / 2 + ps.w / 2));
            add('parking', bufferPolylinePieces(line, ps.w / 2 + 0.05), r);
            const lc = cumLengths(line);
            add('curb', bufferPolylinePieces(subPolyline(line, lc, -0.15, lc[lc.length - 1] + 0.15), ps.w / 2 + 0.15), r);
            parkStrips.push({ road: r, side: sgn, line, w: ps.w, orient: ps.orient });
          }
        }
      }
      if (r.bikeLaneL || r.bikeLaneR) {
        // offsetPolyline(+d) = driver's right (z points south)
        for (const [on, sgn] of [[r.bikeLaneL, -1], [r.bikeLaneR, 1]]) {
          if (!on) continue;
          const line = offsetPolyline(r.pts, sgn * (r.width / 2 - 0.75));
          for (const p of bufferPolylinePieces(line, 0.75)) laneStrips.push({ poly: p, bb: bboxOfPts(p[0]) });
        }
      }
    }
  }

  // kerb fillets at junctions of low roads (car / bus / ped)
  const arms = new Map();
  for (const r of roads) {
    if (!(r.kind === 'car' || r.kind === 'bus' || r.kind === 'ped') || r.bridge) continue;
    r.nodes.forEach((n, k) => {
      if ((nodeUse.get(n) ?? 0) < 2) return;
      const P = r.pts[k];
      const addArm = (q) => {
        const d = dirOf(P, q);
        if (!arms.has(n)) arms.set(n, { P, list: [] });
        arms.get(n).list.push({ u: d, r, ang: Math.atan2(d[1], d[0]) });
      };
      if (k > 0) addArm(r.pts[k - 1]);
      if (k < r.pts.length - 1) addArm(r.pts[k + 1]);
    });
  }
  let nFillets = 0;
  for (const { P, list } of arms.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.ang - b.ang);
    for (let i = 0; i < list.length; i++) {
      const A = list[i], B = list[(i + 1) % list.length];
      if (A.r === B.r && list.length === 2) continue; // through road with no side street
      const hwA = A.r.width / 2, hwB = B.r.width / 2;
      const main = (x) => ['trunk', 'primary', 'secondary', 'tertiary'].includes(x.r.hw);
      const ped = A.r.kind === 'ped' || B.r.kind === 'ped';
      const r = ped ? 1.5 : main(A) || main(B) ? 5 : 3;
      const ring = fillet(P, A.u, hwA, B.u, hwB, r);
      if (!ring) continue;
      const carry = A.r.kind !== 'ped' ? A.r : B.r;
      add(keyFor(carry), [[ring]], carry);
      if (!ped && !flush.has(A.r.id) && !flush.has(B.r.id)) {
        const cr = fillet(P, A.u, hwA + 0.15, B.u, hwB + 0.15, Math.max(0.5, r - 0.15));
        if (cr) add('curb', [[cr]], carry);
      }
      nFillets++;
    }
  }

  // rail corridor + platforms: added by build.mjs (lib/rail.mjs)
  add('square', squares.filter((s) => s.low).map((s) => s.poly), null);
  add('parking', parking.map((s) => s.poly), null);
  return { items, laneStrips, parkStrips, flush, fitted, nFillets };
}

/** Part of a polyline between arc lengths s0..s1 (may extend past the ends linearly). */
export function subPolyline(pts, cum, s0, s1) {
  const out = [];
  const a = pointAt(pts, cum, Math.max(0, s0));
  out.push(s0 < 0 ? [a.x + a.dx * s0, a.z + a.dz * s0] : [a.x, a.z]);
  const L = cum[cum.length - 1];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 + 0.05 && cum[i] < s1 - 0.05) out.push(pts[i]);
  const b = pointAt(pts, cum, Math.min(L, s1));
  out.push(s1 > L ? [b.x + b.dx * (s1 - L), b.z + b.dz * (s1 - L)] : [b.x, b.z]);
  return out;
}

/** Light smoothing of fitted half widths (3-tap median then mean) to avoid jagged edges. */
function smooth(samples) {
  for (const key of ['ha', 'hb']) {
    const v = samples.map((s) => s[key]);
    const med = v.map((_, i) => {
      const w = [v[Math.max(0, i - 1)], v[i], v[Math.min(v.length - 1, i + 1)]].sort((a, b) => a - b);
      return w[1];
    });
    for (let i = 0; i < samples.length; i++) samples[i][key] = med[i];
  }
}
