// Road graph (contracts RoadGraph / RoadEdge): car roads, cycleways and footways inside the
// playable rect. Graph nodes at junctions (OSM nodes shared by >= 2 included ways), way ends and
// where ways leave the playable rect. Edge pts keep the full shape.
import { inRect, polylineLength, round } from './geom.mjs';
import { insideFraction } from './footprints.mjs';

/** Road classes that keep car access even under an overbuilt passage (the network depends on them). */
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;

function boundaryHit(a, b, rc) {
  // parameter t in (0,1] where segment a->b (a inside) leaves rc
  let t = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  if (dx > 0 && b[0] > rc.maxX) t = Math.min(t, (rc.maxX - a[0]) / dx);
  if (dx < 0 && b[0] < rc.minX) t = Math.min(t, (rc.minX - a[0]) / dx);
  if (dz > 0 && b[1] > rc.maxZ) t = Math.min(t, (rc.maxZ - a[1]) / dz);
  if (dz < 0 && b[1] < rc.minZ) t = Math.min(t, (rc.minZ - a[1]) / dz);
  return [a[0] + dx * t, a[1] + dz * t];
}

/**
 * Car edges outside `rc` (in the larger `outer` rect) that join parts of the car network that are
 * separate inside `rc` (e.g. the station's north side, linked to the Helderseweg just beyond the
 * playable edge). Returns a Set of 'roadId:ptIndex' keys of the road points to keep.
 */
function connectorPoints(roads, decks, rc, outer) {
  const { nodes, edges } = buildEdges(roads, decks, outer, null);
  const tol = 0.5;
  const inRc = (p) => p[0] >= rc.minX - tol && p[0] <= rc.maxX + tol && p[1] >= rc.minZ - tol && p[1] <= rc.maxZ + tol;
  const car = edges.filter((e) => e.car);
  const inner = car.filter((e) => e.pts.every(inRc)), outerE = car.filter((e) => !e.pts.every(inRc));
  const uf = (n) => { const p = Array.from({ length: n }, (_, i) => i); const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }; return { find, join: (a, b) => { p[find(a)] = find(b); } }; };
  const I = uf(nodes.length), O = uf(nodes.length);
  const anchor = new Set();
  for (const e of inner) { I.join(e.a, e.b); anchor.add(e.a); anchor.add(e.b); }
  for (const e of outerE) O.join(e.a, e.b);
  // inner components each outer component touches
  const touches = new Map();
  for (const e of outerE) for (const n of [e.a, e.b]) if (anchor.has(n)) {
    const c = O.find(n);
    if (!touches.has(c)) touches.set(c, new Set());
    touches.get(c).add(I.find(n));
  }
  // per outer component (shortest first): shortest paths from the biggest inner component it
  // touches to every other one that is not connected yet
  const iLen = new Map();
  for (const e of inner) iLen.set(I.find(e.a), (iLen.get(I.find(e.a)) ?? 0) + e.len);
  const oEdges = new Map();
  for (const e of outerE) { const c = O.find(e.a); if (!oEdges.has(c)) oEdges.set(c, []); oEdges.get(c).push(e); }
  const oLen = (c) => oEdges.get(c).reduce((t, e) => t + e.len, 0);
  const J = uf(nodes.length);
  const keep = [];
  for (const [c, set] of [...touches].sort((p, q) => oLen(p[0]) - oLen(q[0]))) {
    if (new Set([...set].map((x) => J.find(x))).size < 2) continue;
    const es = oEdges.get(c);
    const adj = new Map();
    for (const e of es) for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) { if (!adj.has(u)) adj.set(u, []); adj.get(u).push([v, e]); }
    const anchors = [...adj.keys()].filter((n) => anchor.has(n));
    const base = [...set].sort((p, q) => (iLen.get(q) ?? 0) - (iLen.get(p) ?? 0))[0];
    // Dijkstra (small graphs: linear scan) from the base component's anchors
    const dist = new Map(), via = new Map(), done = new Set();
    for (const n of anchors) if (I.find(n) === base) dist.set(n, 0);
    for (;;) {
      let u = -1, du = Infinity;
      for (const [n, d] of dist) if (!done.has(n) && d < du) { u = n; du = d; }
      if (u < 0) break;
      done.add(u);
      for (const [v, e] of adj.get(u)) if (du + e.len < (dist.get(v) ?? Infinity)) { dist.set(v, du + e.len); via.set(v, [u, e]); }
    }
    for (const comp of set) {
      if (J.find(comp) === J.find(base)) continue;
      let best = -1;
      for (const n of anchors) if (I.find(n) === comp && dist.has(n) && (best < 0 || dist.get(n) < dist.get(best))) best = n;
      if (best < 0) continue;
      for (let n = best; via.has(n); n = via.get(n)[0]) keep.push(via.get(n)[1]);
      J.join(comp, base);
    }
  }
  const pts = new Set();
  for (const e of keep) for (const k of e.src) pts.add(k);
  return pts;
}

/**
 * @param roads classified roads (features.mjs)
 * @param opts.stats optional object that receives { insideEdges, insideLen, connectorEdges, connectorLen }
 * @param opts.footprints RBush of 3D BAG footprint rings (footprints.mjs): minor car edges whose
 *   centre line lies mostly inside rendered buildings (garage ramps, courtyards built over) lose car access
 * @param opts.connectRect larger rect (the full-detail ground area): car roads in it that link
 *   otherwise separate parts of the network inside `rc` are kept in full
 * @returns {import('../../../src/contracts').RoadGraph}
 */
export function buildRoadGraph(roads, decks, rc, opts = {}) {
  const extra = opts.connectRect ? connectorPoints(roads, decks, rc, opts.connectRect) : null;
  const { nodes, edges } = buildEdges(roads, decks, rc, extra);
  for (const e of edges) delete e.src;
  return finishGraph(nodes, edges, rc, extra, opts);
}

/** Graph nodes + edges of all roads with points in `rc` (or in `extra`, 'roadId:ptIndex' keys). */
function buildEdges(roads, decks, rc, extra) {
  const isIn = (r, k) => inRect(r.pts[k][0], r.pts[k][1], rc) || (extra !== null && extra.has(`${r.id}:${k}`));
  const incl = roads.filter((r) => (r.car || r.bike || r.foot) && r.kind !== 'bus' && r.pts.some((_, k) => isIn(r, k)));
  const use = new Map();
  for (const r of incl) for (const n of r.nodes) use.set(n, (use.get(n) ?? 0) + 1);

  const nodes = [];
  const nodeIndex = new Map();
  const nodeId = (key, p) => {
    let i = nodeIndex.get(key);
    if (i === undefined) {
      i = nodes.length;
      nodes.push([round(p[0]), round(p[1])]);
      nodeIndex.set(key, i);
    }
    return i;
  };
  const deckIds = new Set(decks.flatMap((d) => d.ids));
  const edges = [];
  let synth = 0;
  for (const r of incl) {
    // split into runs inside the rect
    const runs = [];
    let cur = null;
    for (let k = 0; k < r.pts.length; k++) {
      const p = r.pts[k];
      const inside = isIn(r, k);
      if (inside) {
        if (!cur) {
          cur = { pts: [], keys: [], src: [] };
          // entering through the rect edge (a connector point outside it starts at its own node)
          if (k > 0 && inRect(p[0], p[1], rc)) {
            const q = boundaryHit(p, r.pts[k - 1], rc);
            cur.pts.push(q); cur.keys.push(`b${synth++}`); cur.src.push(-1);
          }
        }
        cur.pts.push(p); cur.keys.push(String(r.nodes[k])); cur.src.push(k);
      } else if (cur) {
        const prev = r.pts[k - 1];
        if (inRect(prev[0], prev[1], rc)) {
          const q = boundaryHit(prev, p, rc);
          cur.pts.push(q); cur.keys.push(`b${synth++}`); cur.src.push(-1);
        }
        runs.push(cur); cur = null;
      }
    }
    if (cur) runs.push(cur);
    for (const run of runs) {
      if (run.pts.length < 2) continue;
      let start = 0;
      for (let k = 1; k < run.pts.length; k++) {
        const key = run.keys[k];
        const isNode = k === run.pts.length - 1 || (use.get(Number(key)) ?? 0) >= 2;
        if (!isNode) continue;
        const pts = run.pts.slice(start, k + 1);
        const src = run.src.slice(start, k + 1).filter((i) => i >= 0).map((i) => `${r.id}:${i}`);
        const keyA = run.keys[start], keyB = key;
        start = k;
        const len = polylineLength(pts);
        if (len < 0.05) continue;
        let a = nodeId(keyA, pts[0]), b = nodeId(keyB, pts[pts.length - 1]);
        let ptsOut = pts;
        let oneway = r.oneway !== 0 ? 1 : 0;
        if (r.kind === 'foot' || r.kind === 'ped') oneway = 0;
        if (r.oneway === -1) { [a, b] = [b, a]; ptsOut = pts.slice().reverse(); }
        if (a === b) continue;
        edges.push({
          a, b,
          pts: ptsOut.map((p) => [round(p[0]), round(p[1])]),
          len: round(len, 2),
          type: r.hw,
          ...(r.name ? { name: r.name } : {}),
          oneway,
          lanes: r.lanes,
          speed: round(r.speed, 2),
          width: round(r.width, 2),
          car: r.car,
          bike: r.bike,
          foot: r.foot,
          bridge: r.bridge || deckIds.has(r.id),
          src,
        });
      }
    }
  }

  return { nodes, edges };
}

function finishGraph(nodes, edges, rc, extra, opts) {
  // car edges inside rendered buildings: no traffic, no parked cars / signs (foot / bike kept)
  const stats = { insideEdges: 0, insideLen: 0, connectorEdges: 0, connectorLen: 0 };
  if (opts.footprints) {
    for (const e of edges) {
      if (!e.car || MAJOR.test(e.type)) continue;
      if (insideFraction(opts.footprints, e.pts, 1) < 0.5) continue;
      e.car = false;
      stats.insideEdges++;
      stats.insideLen += e.len;
    }
  }
  // remove tiny disconnected fragments: car flag off for small car components, drop small components
  const comp = (pred) => {
    const parent = nodes.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const e of edges) if (pred(e)) parent[find(e.a)] = find(e.b);
    const total = new Map();
    for (const e of edges) if (pred(e)) { const c = find(e.a); total.set(c, (total.get(c) ?? 0) + e.len); }
    return { find, total };
  };
  const carC = comp((e) => e.car);
  let biggestCar = 0;
  for (const v of carC.total.values()) biggestCar = Math.max(biggestCar, v);
  for (const e of edges) if (e.car && carC.total.get(carC.find(e.a)) < Math.min(250, biggestCar)) e.car = false;
  // outside the rect only the car connectors are wanted (their foot/bike flags stay)
  const nearRc = (p) => p[0] >= rc.minX - 0.05 && p[0] <= rc.maxX + 0.05 && p[1] >= rc.minZ - 0.05 && p[1] <= rc.maxZ + 0.05;
  for (const e of edges) if (extra && !e.pts.every(nearRc)) {
    if (e.car) { stats.connectorEdges++; stats.connectorLen += e.len; } else { e.bike = false; e.foot = false; }
  }
  const allC = comp(() => true);
  const kept = edges.filter((e) => (e.car || e.bike || e.foot) && allC.total.get(allC.find(e.a)) >= 40);

  // compact node indices
  const used = new Map();
  const outNodes = [];
  for (const e of kept) for (const k of ['a', 'b']) {
    if (!used.has(e[k])) { used.set(e[k], outNodes.length); outNodes.push(nodes[e[k]]); }
    e[k] = used.get(e[k]);
  }
  if (opts.stats) Object.assign(opts.stats, stats);
  return { nodes: outNodes, edges: kept };
}
