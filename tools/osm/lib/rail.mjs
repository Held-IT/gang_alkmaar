// Railway (station yard and the lines through the playable area):
//  * railCorridorPieces: the gravel bed region of the ground partition (raised layer 'rail',
//    material 'ground'): every track buffered by 3 m plus filler quads between parallel tracks up
//    to 9.5 m apart, so the yard reads as one ballast field instead of strips with pavement between.
//  * platformPieces: railway=platform areas -> raised layer 'platform' at PLATFORM_H (sidewalk
//    top, curb faces come from the generic step walls in ground.mjs).
//  * buildTrackGeometry: on the finished ground, per track a raised ballast bed ('ground', in the
//    collision), concrete sleepers every 0.6 m ('bridge_deck') and two steel rails ('bridge_rail').
//    On rail bridges the sleepers sit directly on the deck. Fences along the corridor edge are made
//    in ground.mjs (they need the region neighbours).
import RBush from 'rbush';
import { cumLengths, densifyPolyline, dirOf, leftN, offsetPolyline, pointAt, ringArea, segDist2, segIntersectT, simplifyDP } from './geom.mjs';

export const RAIL_CORRIDOR_HW = 3.0;
export const PLATFORM_H = 0.76;
const GAP_MAX = 9.5;

// cross-section (metres above the corridor surface)
const BED_BOTTOM_HW = 1.95, BED_TOP_HW = 1.4, BED_RISE = 0.2;
const SLEEPER_HL = 1.3, SLEEPER_HW = 0.13, SLEEPER_SINK = 0.03, SLEEPER_UP = 0.05, SLEEPER_STEP = 0.6;
const RAIL_OFF = 0.7525, RAIL_HW = 0.036, RAIL_H = 0.15;

/** Ground-partition pieces of the rail corridor (not on bridges). */
export function railCorridorPieces(rails) {
  const pieces = [];
  const ground = rails.filter((r) => !r.bridge && r.pts.length >= 2);
  for (const r of ground) pieces.push(...bufferPolylinePiecesSafe(r.pts, RAIL_CORRIDOR_HW));
  // gap fillers between parallel neighbouring tracks
  const tree = new RBush();
  const items = [];
  ground.forEach((r, ri) => {
    for (let k = 1; k < r.pts.length; k++) {
      const a = r.pts[k - 1], b = r.pts[k];
      items.push({ minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]), ri, a, b });
    }
  });
  tree.load(items);
  const nearestOther = (ri, x, z, dx, dz) => {
    let best = null;
    for (const h of tree.search({ minX: x - GAP_MAX, minY: z - GAP_MAX, maxX: x + GAP_MAX, maxY: z + GAP_MAX })) {
      if (h.ri === ri) continue;
      const d = dirOf(h.a, h.b);
      if (Math.abs(d[0] * dx + d[1] * dz) < 0.95) continue;
      const r = segDist2(x, z, h.a[0], h.a[1], h.b[0], h.b[1]);
      if (r.d2 > GAP_MAX * GAP_MAX || (best && r.d2 >= best.d2)) continue;
      best = { ri: h.ri, d2: r.d2, q: [h.a[0] + (h.b[0] - h.a[0]) * r.t, h.a[1] + (h.b[1] - h.a[1]) * r.t] };
    }
    return best;
  };
  let fillers = 0;
  ground.forEach((r, ri) => {
    const cum = cumLengths(r.pts), L = cum[cum.length - 1];
    let prev = null;
    for (let s = 0; s <= L + 1e-6; s += 3) {
      const p = pointAt(r.pts, cum, Math.min(s, L));
      const nb = nearestOther(ri, p.x, p.z, p.dx, p.dz);
      // only gaps the 3 m buffers do not close already
      const cur = nb && nb.d2 > (2 * RAIL_CORRIDOR_HW - 0.5) ** 2 ? { p: [p.x, p.z], q: nb.q, ri: nb.ri } : null;
      if (cur && prev && prev.ri === cur.ri) {
        const ring = [prev.p, cur.p, cur.q, prev.q];
        if (Math.abs(ringArea(ring)) > 0.5 && segIntersectT(prev.p, prev.q, cur.p, cur.q) === null) {
          pieces.push([ring]);
          fillers++;
        }
      }
      prev = cur;
    }
  });
  return { pieces, fillers };
}

function bufferPolylinePiecesSafe(pts, hw) {
  // drop duplicate points (zero-length segments break the joins)
  const clean = [pts[0]];
  for (const p of pts) if (Math.hypot(p[0] - clean[clean.length - 1][0], p[1] - clean[clean.length - 1][1]) > 0.01) clean.push(p);
  if (clean.length < 2) return [];
  const out = [];
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1], b = clean[i];
    const [dx, dz] = dirOf(a, b);
    const [nx, nz] = leftN(dx, dz);
    // segment quad extended by a little along the track so joins have no slivers
    const e = Math.min(hw, 1.5);
    out.push([[
      [a[0] - nx * hw - dx * e, a[1] - nz * hw - dz * e], [b[0] - nx * hw + dx * e, b[1] - nz * hw + dz * e],
      [b[0] + nx * hw + dx * e, b[1] + nz * hw + dz * e], [a[0] + nx * hw - dx * e, a[1] + nz * hw - dz * e],
    ]]);
  }
  return out;
}

/** Ground-partition pieces of railway platforms. */
export function platformPieces(platforms) {
  return platforms.filter((p) => p.rail).map((p) => p.poly);
}

/**
 * Track geometry on top of the finished ground.
 * @param rails rail features; loc global Locator; chunkOf (x,z) => {mats} | undefined; coll CollisionBuilder
 */
export function buildTrackGeometry(rails, loc, chunkOf, coll, rect) {
  const stats = { bedLen: 0, deckLen: 0, sleepers: 0 };
  const inR = (p) => p[0] > rect.minX && p[0] < rect.maxX && p[1] > rect.minZ && p[1] < rect.maxZ;
  for (const r of rails) {
    if (r.pts.length < 2 || !r.pts.some(inR)) continue;
    const dense = densifyPolyline(r.pts, 1.0);
    // classify every vertex: gravel bed, bridge deck, or nothing (road, platform, outside)
    const cls = dense.map((p) => {
      if (!inR(p)) return null;
      const reg = loc.locate(p[0], p[1]);
      if (!reg) return null;
      if (reg.kind === 'deck') return { k: 'deck', h: reg.deck.heightAt(p[0], p[1]) };
      if (reg.layer === 'rail') return { k: 'bed', h: reg.h };
      return null;
    });
    let i = 0;
    while (i < dense.length) {
      if (!cls[i]) { i++; continue; }
      const k = cls[i].k;
      let j = i;
      while (j + 1 < dense.length && cls[j + 1] && cls[j + 1].k === k) j++;
      if (j > i) {
        const run = dense.slice(i, j + 1).map((p, n) => [p[0], p[1], cls[i + n].h]);
        emitRun(run, k, chunkOf, coll, stats);
      }
      i = j + 1;
    }
  }
  return stats;
}

function emitRun(run, kind, chunkOf, coll, stats) {
  // simplify straight stretches (heights are constant on the bed; decks keep every vertex)
  let pts = run;
  if (kind === 'bed') {
    // ...but keep segments <= 12 m: every quad goes to the chunk of its midpoint
    const s = densifyPolyline(simplifyDP(run.map((p) => [p[0], p[1]]), 0.04), 12);
    const h = run[0][2];
    pts = s.map((p) => [p[0], p[1], h]);
  }
  if (pts.length < 2) return;
  const plan = pts.map((p) => [p[0], p[1]]);
  const cum = cumLengths(plan), L = cum[cum.length - 1];
  if (L < 0.5) return;
  if (kind === 'bed') stats.bedLen += L; else stats.deckLen += L;
  const hOf = (s) => {
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const t = (s - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1]);
    return pts[k - 1][2] + (pts[k][2] - pts[k - 1][2]) * Math.min(1, Math.max(0, t));
  };
  // base heights of the track (top of ballast / deck)
  const bedTop = (i) => pts[i][2] + (kind === 'bed' ? BED_RISE : 0);
  const sleeperTop = (y) => y + (kind === 'bed' ? SLEEPER_UP : 0.1);

  // ---- ballast bed: left slope, top, right slope (+ end caps)
  if (kind === 'bed') {
    const oL = offsetPolyline(plan, BED_BOTTOM_HW), iL = offsetPolyline(plan, BED_TOP_HW);
    const iR = offsetPolyline(plan, -BED_TOP_HW), oR = offsetPolyline(plan, -BED_BOTTOM_HW);
    const slopeN = BED_RISE / (BED_BOTTOM_HW - BED_TOP_HW);
    const nl = 1 / Math.hypot(1, slopeN);
    for (let i = 1; i < pts.length; i++) {
      const mx = (plan[i - 1][0] + plan[i][0]) / 2, mz = (plan[i - 1][1] + plan[i][1]) / 2;
      const ch = chunkOf(mx, mz);
      if (!ch) continue;
      const mb = ch.mats.get('ground');
      const y0 = pts[i - 1][2], y1 = pts[i][2], t0 = bedTop(i - 1), t1 = bedTop(i);
      const [dx, dz] = dirOf(plan[i - 1], plan[i]);
      const [lx, lz] = leftN(dx, dz);
      const q = (p, y) => [p[0], y, p[1]];
      const uv = (p) => [p[0], p[1]];
      mb.addQuad(q(iL[i - 1], t0), q(iL[i], t1), q(iR[i], t1), q(iR[i - 1], t0), [0, 1, 0], [uv(iL[i - 1]), uv(iL[i]), uv(iR[i]), uv(iR[i - 1])], coll);
      mb.addQuad(q(oL[i - 1], y0), q(oL[i], y1), q(iL[i], t1), q(iL[i - 1], t0), [lx * slopeN * nl, nl, lz * slopeN * nl], [uv(oL[i - 1]), uv(oL[i]), uv(iL[i]), uv(iL[i - 1])], coll);
      mb.addQuad(q(iR[i - 1], t0), q(iR[i], t1), q(oR[i], y1), q(oR[i - 1], y0), [-lx * slopeN * nl, nl, -lz * slopeN * nl], [uv(iR[i - 1]), uv(iR[i]), uv(oR[i]), uv(oR[i - 1])], coll);
    }
    // end caps (vertical trapezoids)
    for (const [e, sgn] of [[0, -1], [pts.length - 1, 1]]) {
      const ch = chunkOf(plan[e][0], plan[e][1]);
      if (!ch) continue;
      const mb = ch.mats.get('ground');
      const [dx, dz] = e === 0 ? dirOf(plan[0], plan[1]) : dirOf(plan[e - 1], plan[e]);
      const y = pts[e][2], t = bedTop(e);
      const A = [oL[e][0], y, oL[e][1]], B = [iL[e][0], t, iL[e][1]], C = [iR[e][0], t, iR[e][1]], D = [oR[e][0], y, oR[e][1]];
      const n = [dx * sgn, 0, dz * sgn];
      const vi = [A, B, C, D].map((p) => mb.vert(p[0], p[1], p[2], n[0], n[1], n[2], p[0] * dz - p[2] * dx, p[1]));
      mb.tri(vi[0], vi[1], vi[2], n[0], n[1], n[2]);
      mb.tri(vi[0], vi[2], vi[3], n[0], n[1], n[2]);
    }
  }

  // ---- sleepers (top + both long faces)
  for (let s = SLEEPER_STEP / 2; s < L - SLEEPER_HW; s += SLEEPER_STEP) {
    const p = pointAt(plan, cum, s);
    const ch = chunkOf(p.x, p.z);
    if (!ch) continue;
    const mb = ch.mats.get('bridge_deck');
    const base = hOf(s) + (kind === 'bed' ? BED_RISE : 0);
    const yb = base - (kind === 'bed' ? SLEEPER_SINK : 0), yt = sleeperTop(base);
    const [lx, lz] = leftN(p.dx, p.dz);
    const c = (a, l) => [p.x + p.dx * a + lx * l, p.z + p.dz * a + lz * l];
    const f0 = c(-SLEEPER_HW, SLEEPER_HL), f1 = c(-SLEEPER_HW, -SLEEPER_HL), b0 = c(SLEEPER_HW, SLEEPER_HL), b1 = c(SLEEPER_HW, -SLEEPER_HL);
    mb.addQuad([f0[0], yt, f0[1]], [b0[0], yt, b0[1]], [b1[0], yt, b1[1]], [f1[0], yt, f1[1]], [0, 1, 0],
      [[s, SLEEPER_HL], [s + 2 * SLEEPER_HW, SLEEPER_HL], [s + 2 * SLEEPER_HW, -SLEEPER_HL], [s, -SLEEPER_HL]]);
    mb.addQuad([f0[0], yt, f0[1]], [f1[0], yt, f1[1]], [f1[0], yb, f1[1]], [f0[0], yb, f0[1]], [-p.dx, 0, -p.dz],
      [[SLEEPER_HL, yt], [-SLEEPER_HL, yt], [-SLEEPER_HL, yb], [SLEEPER_HL, yb]]);
    mb.addQuad([b1[0], yt, b1[1]], [b0[0], yt, b0[1]], [b0[0], yb, b0[1]], [b1[0], yb, b1[1]], [p.dx, 0, p.dz],
      [[-SLEEPER_HL, yt], [SLEEPER_HL, yt], [SLEEPER_HL, yb], [-SLEEPER_HL, yb]]);
    stats.sleepers++;
  }

  // ---- rails (top + inner/outer faces), web/foot implied
  for (const side of [1, -1]) {
    const line = offsetPolyline(plan, RAIL_OFF * side);
    const inn = offsetPolyline(plan, RAIL_OFF * side - RAIL_HW), out = offsetPolyline(plan, RAIL_OFF * side + RAIL_HW);
    let u = 0;
    for (let i = 1; i < pts.length; i++) {
      const mx = (line[i - 1][0] + line[i][0]) / 2, mz = (line[i - 1][1] + line[i][1]) / 2;
      const segL = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
      const ch = chunkOf(mx, mz);
      if (ch) {
        const mb = ch.mats.get('bridge_rail');
        const b0 = sleeperTop(bedTop(i - 1)), b1 = sleeperTop(bedTop(i));
        const t0 = b0 + RAIL_H, t1 = b1 + RAIL_H;
        const [dx, dz] = dirOf(line[i - 1], line[i]);
        const [lx, lz] = leftN(dx, dz);
        const q = (p, y) => [p[0], y, p[1]];
        mb.addQuad(q(out[i - 1], t0), q(out[i], t1), q(inn[i], t1), q(inn[i - 1], t0), [0, 1, 0], [[u, 0], [u + segL, 0], [u + segL, 0.07], [u, 0.07]]);
        // faces: left (+l) and right (-l) of the rail line
        const L0 = out, R0 = inn; // out = larger left offset
        mb.addQuad(q(L0[i - 1], t0), q(L0[i - 1], b0), q(L0[i], b1), q(L0[i], t1), [lx, 0, lz], [[u, t0], [u, b0], [u + segL, b1], [u + segL, t1]]);
        mb.addQuad(q(R0[i], t1), q(R0[i], b1), q(R0[i - 1], b0), q(R0[i - 1], t0), [-lx, 0, -lz], [[u + segL, t1], [u + segL, b1], [u, b0], [u, t0]]);
      }
      u += segL;
    }
  }
}


