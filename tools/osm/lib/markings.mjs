// Road markings (material 'road_marking', 1 cm above the surface): dashed centre lines on
// two-way asphalt roads >= 6 m, edge lines on main roads, broken lines along painted cycle lanes,
// zebra crossings and shark teeth (haaientanden). Every quad corner must lie on a low road
// surface or bridge deck, otherwise the quad is dropped (clips markings at curbs/junctions).
import RBush from 'rbush';
import { cumLengths, pointAt, leftN, offsetPolyline, polylineLength } from './geom.mjs';

const MAIN = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link', 'secondary_link']);
const MINOR = new Set(['residential', 'unclassified', 'service', 'living_street']);
const LIFT = 0.012;

export function buildMarkings(roads, osm, decks, dTree, loc, rc) {
  const quads = [];
  const carRoads = roads.filter((r) => r.kind === 'car' && r.car !== undefined);
  // junction nodes with clearance radius
  const byNode = new Map();
  for (const r of carRoads) r.nodes.forEach((n, k) => {
    if (!byNode.has(n)) byNode.set(n, []);
    byNode.get(n).push({ r, k });
  });
  const junctions = new RBush();
  const jItems = [];
  for (const [n, list] of byNode) {
    const ways = new Set(list.map((l) => l.r));
    if (ways.size < 2 && !(list.length === 1 && (list[0].k === 0 || list[0].k === list[0].r.nodes.length - 1))) continue;
    if (ways.size < 2) continue;
    const p = list[0].r.pts[list[0].k];
    const R = Math.max(...list.map((l) => l.r.width / 2)) + 2.5;
    jItems.push({ minX: p[0] - R, minY: p[1] - R, maxX: p[0] + R, maxY: p[1] + R, x: p[0], z: p[1], R, list });
  }
  junctions.load(jItems);
  const nearJunction = (x, z, extra = 0) => junctions.search({ minX: x, minY: z, maxX: x, maxY: z })
    .some((j) => Math.hypot(j.x - x, j.z - z) < j.R + extra);

  const surfY = (x, z) => {
    const reg = loc.locate(x, z);
    if (!reg) return null;
    if (reg.kind === 'deck') return reg.deck.heightAt(x, z);
    if (reg.kind === 'low' && (reg.mat === 'asphalt' || reg.mat === 'klinkers' || reg.mat === 'bikelane')) return 0;
    return null;
  };
  const pushQuad = (c) => {
    const out = [];
    for (const p of c) {
      const y = surfY(p[0], p[1]);
      if (y === null) return false;
      out.push([p[0], y + LIFT, p[1]]);
    }
    quads.push(out);
    return true;
  };

  /** Dashed / solid line along a polyline. dash <= 0 => solid. */
  const line = (pts, width, dash, gap, avoidJunctions = true) => {
    const cum = cumLengths(pts);
    const L = cum[cum.length - 1];
    const period = dash > 0 ? dash + gap : 2.0;
    const segLen = dash > 0 ? dash : 2.0;
    for (let s = dash > 0 ? gap / 2 : 0; s < L - 0.2; s += period) {
      const e = Math.min(L, s + segLen);
      const a = pointAt(pts, cum, s), b = pointAt(pts, cum, e);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (avoidJunctions && nearJunction(mx, mz)) continue;
      const [na, nza] = leftN(a.dx, a.dz), [nb, nzb] = leftN(b.dx, b.dz);
      const hw = width / 2;
      pushQuad([[a.x - na * hw, a.z - nza * hw], [b.x - nb * hw, b.z - nzb * hw], [b.x + nb * hw, b.z + nzb * hw], [a.x + na * hw, a.z + nza * hw]]);
    }
  };

  for (const r of carRoads) {
    if (r.mat !== 'asphalt' || r.hw === 'service' || r.hw === 'living_street') continue;
    if (!r.pts.some((p) => p[0] > rc.minX && p[0] < rc.maxX && p[1] > rc.minZ && p[1] < rc.maxZ)) continue;
    const L = polylineLength(r.pts);
    if (L < 4) continue;
    const laneW = r.width - (r.bikeLaneL ? 1.5 : 0) - (r.bikeLaneR ? 1.5 : 0);
    if (r.oneway === 0 && laneW >= 5.8) line(r.pts, 0.1, 3, 9);
    if (MAIN.has(r.hw) && r.width >= 6 && !r.bikeLaneL && !r.bikeLaneR) {
      line(offsetPolyline(r.pts, r.width / 2 - 0.3), 0.1, 0, 0);
      line(offsetPolyline(r.pts, -(r.width / 2 - 0.3)), 0.1, 0, 0);
    }
    if (r.bikeLaneL) line(offsetPolyline(r.pts, -(r.width / 2 - 1.5)), 0.1, 1, 1);
    if (r.bikeLaneR) line(offsetPolyline(r.pts, r.width / 2 - 1.5), 0.1, 1, 1);
  }

  // node lookups
  const wayAtNode = new Map();
  for (const r of carRoads) r.nodes.forEach((n, k) => { if (!wayAtNode.has(n)) wayAtNode.set(n, []); wayAtNode.get(n).push({ r, k }); });

  // zebra crossings
  for (const n of osm.nodes) {
    const t = n.tags;
    const zebra = t.crossing === 'zebra' || t.crossing_ref === 'zebra' || t['crossing:markings'] === 'zebra' || (t.highway === 'crossing' && t.crossing === 'uncontrolled' && t['crossing:markings'] === 'yes');
    if (!zebra) continue;
    const ws = wayAtNode.get(n.id);
    if (!ws) continue;
    const { r, k } = ws[0];
    const a = r.pts[Math.max(0, k - 1)], b = r.pts[Math.min(r.pts.length - 1, k + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const [nx, nz] = leftN(dx, dz);
    const hw = r.width / 2 - 0.25;
    const len = 2.0; // half of 4 m walking width
    for (let o = -hw + 0.25; o <= hw - 0.2; o += 1.0) {
      const cx = n.x + nx * o, cz = n.z + nz * o;
      pushQuad([
        [cx - nx * 0.25 - dx * len, cz - nz * 0.25 - dz * len], [cx + nx * 0.25 - dx * len, cz + nz * 0.25 - dz * len],
        [cx + nx * 0.25 + dx * len, cz + nz * 0.25 + dz * len], [cx - nx * 0.25 + dx * len, cz - nz * 0.25 + dz * len],
      ]);
    }
  }

  // shark teeth: explicit give_way nodes + minor road meeting a main road
  const teeth = (x, z, dx, dz, hwAcross, side) => {
    // dx,dz = travel direction of the yielding traffic; teeth across the lane, apex towards the driver
    const [nx, nz] = leftN(dx, dz);
    // NOTE: leftN() in the (x,z) plane points to the driver's RIGHT (z is south).
    const from = side === 'right' ? 0 : -hwAcross, to = hwAcross;
    for (let o = from + 0.15; o + 0.45 <= to - 0.05; o += 0.75) {
      const b0 = [x + nx * o, z + nz * o], b1 = [x + nx * (o + 0.45), z + nz * (o + 0.45)];
      const apex = [x + nx * (o + 0.225) - dx * 0.6, z + nz * (o + 0.225) - dz * 0.6];
      pushQuad([b0, b1, apex, apex]);
    }
  };
  const signals = new Set(osm.nodes.filter((n) => n.tags.highway === 'traffic_signals').map((n) => n.id));
  for (const n of osm.nodes) {
    if (n.tags.highway !== 'give_way' && n.tags.highway !== 'stop') continue;
    const ws = wayAtNode.get(n.id);
    if (!ws) continue;
    const { r, k } = ws[0];
    // yield towards the nearer way end
    const toEnd = k >= r.nodes.length / 2;
    const p0 = r.pts[Math.max(0, toEnd ? k - 1 : k + 1)] ?? r.pts[k];
    let dx = n.x - p0[0], dz = n.z - p0[1];
    if (!toEnd) { dx = -dx; dz = -dz; }
    if (n.tags.direction === 'backward') { dx = -dx; dz = -dz; }
    const l = Math.hypot(dx, dz) || 1;
    teeth(n.x, n.z, dx / l, dz / l, r.width / 2, r.oneway ? 'full' : 'right');
  }
  for (const [nid, list] of wayAtNode) {
    if (signals.has(nid) || list.length < 2) continue;
    const mains = list.filter((l) => MAIN.has(l.r.hw));
    if (!mains.length) continue;
    const mainHW = Math.max(...mains.map((m) => m.r.width / 2));
    for (const { r, k } of list) {
      if (!MINOR.has(r.hw) || r.mat === 'ground') continue;
      if (k !== 0 && k !== r.nodes.length - 1) continue;
      // direction travelling towards the junction
      const inner = k === 0 ? r.pts.slice(0, 2).reverse() : r.pts.slice(-2);
      let dx = inner[1][0] - inner[0][0], dz = inner[1][1] - inner[0][1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      if (r.oneway === 1 && k === 0) continue; // traffic leaves the junction here
      if (r.oneway === -1 && k !== 0) continue;
      const p = r.pts[k];
      const back = mainHW + 1.2;
      teeth(p[0] - dx * back, p[1] - dz * back, dx, dz, r.width / 2, r.oneway ? 'full' : 'right');
    }
  }
  return quads;
}
