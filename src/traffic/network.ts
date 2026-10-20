// Road network preprocessing for traffic: node incidence per mode, junction clusters, and lazily
// built (cached) Paths for car lanes, cycle tracks, walking lines and the connectors between them.
//
// Conventions: travel direction (tx, tz); its RIGHT side is (-tz, tx) (world x east, z south).
// Car lanes keep right: two-way roads put lane k (0 = innermost) at (k + 0.5) * width / (2 * lanes)
// right of the centre line; one-way roads spread their lanes over the full width.
import type { RoadGraph, RoadEdge } from '../contracts';
import {
  Path, PATH_CONN, PATH_LANE, bezierConnector, offsetPolyline, straightConnector,
  type HeightFn,
} from './paths';
import type { Car } from './cars';

/** Priority rank by OSM highway class (higher = priority road). */
const RANK: Record<string, number> = {
  motorway: 6, trunk: 5, primary: 5, secondary: 4, tertiary: 3,
  unclassified: 2, residential: 2, living_street: 1, service: 1,
};

/** Car edges shorter than this joining two junction nodes are merged into one junction cluster. */
const CLUSTER_EDGE = 15;
/** Way-split nodes (car degree 2) closer than this to a junction join its cluster. */
const ABSORB_EDGE = 10;

export interface NetNode {
  x: number;
  z: number;
  car: number[];
  bike: number[];
  foot: number[];
  /** junction cluster id (car degree >= 3), else -1 */
  cluster: number;
}

export interface Cluster {
  id: number;
  nodes: number[];
  x: number;
  z: number;
  radius: number;
  /** cars that hold a reservation (inside the junction box) */
  readonly inside: Car[];
  /** cars approaching (registered, no reservation yet) */
  readonly approaching: Car[];
}

export class Network {
  readonly graph: RoadGraph;
  readonly edges: RoadEdge[];
  readonly nodes: NetNode[];
  readonly clusters: Cluster[] = [];
  readonly heightFn: HeightFn;
  /** world.isInsideBuilding when the world provides it (sidewalk validation, people dodging). */
  insideFn: ((x: number, z: number) => boolean) | null = null;
  /** per edge: unit direction leaving node a (0,1) and leaving node b (2,3) */
  private readonly endDir: Float32Array;
  /** per edge bbox minX, minZ, maxX, maxZ */
  readonly bbox: Float32Array;
  readonly carEdges: number[] = [];
  readonly bikeEdges: number[] = [];
  readonly footEdges: number[] = [];
  private readonly carLanes = new Map<number, Path>();
  private readonly conns = new Map<number, Path>();
  private readonly bikePaths = new Map<number, Path>();
  private readonly footPaths = new Map<number, Path | null>();
  private readonly trims = new Map<number, number>();
  /** sidewalk lateral offset per edge*2+side (NaN = no usable sidewalk, undefined = unknown) */
  private readonly sideOff = new Map<number, number>();

  constructor(graph: RoadGraph, heightFn: HeightFn) {
    this.graph = graph;
    this.edges = graph.edges;
    this.heightFn = heightFn;
    this.nodes = graph.nodes.map(([x, z]) => ({ x, z, car: [], bike: [], foot: [], cluster: -1 }));
    const E = this.edges.length;
    this.endDir = new Float32Array(E * 4);
    this.bbox = new Float32Array(E * 4);
    for (let i = 0; i < E; i++) {
      const e = this.edges[i];
      if (e.a === e.b || e.pts.length < 2) continue;
      if (e.car) {
        this.nodes[e.a].car.push(i);
        this.nodes[e.b].car.push(i);
        this.carEdges.push(i);
      }
      if (e.bike) {
        this.nodes[e.a].bike.push(i);
        this.nodes[e.b].bike.push(i);
        this.bikeEdges.push(i);
      }
      if (e.foot) {
        this.nodes[e.a].foot.push(i);
        this.nodes[e.b].foot.push(i);
        this.footEdges.push(i);
      }
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const p of e.pts) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < z0) z0 = p[1];
        if (p[1] > z1) z1 = p[1];
      }
      this.bbox[i * 4] = x0;
      this.bbox[i * 4 + 1] = z0;
      this.bbox[i * 4 + 2] = x1;
      this.bbox[i * 4 + 3] = z1;
      this.computeEndDir(i, 0);
      this.computeEndDir(i, 1);
    }
    this.buildClusters();
  }

  rank(edge: number): number {
    return RANK[this.edges[edge].type] ?? 1;
  }

  /** Unit direction leaving `node` along `edge` (written to out[0], out[1]). */
  leaveDir(edge: number, node: number, out: number[]): void {
    const e = this.edges[edge];
    const k = e.a === node ? 0 : 2;
    out[0] = this.endDir[edge * 4 + k];
    out[1] = this.endDir[edge * 4 + k + 1];
  }

  otherNode(edge: number, node: number): number {
    const e = this.edges[edge];
    return e.a === node ? e.b : e.a;
  }

  private computeEndDir(i: number, end: 0 | 1): void {
    const e = this.edges[i];
    const pts = e.pts;
    const m = pts.length;
    const want = Math.min(4, e.len * 0.5);
    let acc = 0;
    let k = 0;
    const p0 = end === 0 ? pts[0] : pts[m - 1];
    let qx = p0[0];
    let qz = p0[1];
    for (k = 1; k < m; k++) {
      const p = end === 0 ? pts[k] : pts[m - 1 - k];
      const pp = end === 0 ? pts[k - 1] : pts[m - k];
      acc += Math.hypot(p[0] - pp[0], p[1] - pp[1]);
      qx = p[0];
      qz = p[1];
      if (acc >= want) break;
    }
    let dx = qx - p0[0];
    let dz = qz - p0[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    this.endDir[i * 4 + end * 2] = dx;
    this.endDir[i * 4 + end * 2 + 1] = dz;
  }

  private buildClusters(): void {
    const N = this.nodes.length;
    const parent = new Int32Array(N);
    for (let i = 0; i < N; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const isJ = (n: number): boolean => this.nodes[n].car.length >= 3;
    // members: junction nodes, plus way-split nodes (degree 2, e.g. a bridge start) right next to a
    // junction, so the stop line is never pushed into the crossing road by a very short edge
    const member = new Uint8Array(N);
    for (let n = 0; n < N; n++) if (isJ(n)) member[n] = 1;
    for (const ei of this.carEdges) {
      const e = this.edges[ei];
      if (e.len >= ABSORB_EDGE) continue;
      if (isJ(e.a) && this.nodes[e.b].car.length === 2) member[e.b] = 1;
      if (isJ(e.b) && this.nodes[e.a].car.length === 2) member[e.a] = 1;
    }
    for (const ei of this.carEdges) {
      const e = this.edges[ei];
      if (!member[e.a] || !member[e.b]) continue;
      const lim = isJ(e.a) && isJ(e.b) ? CLUSTER_EDGE : ABSORB_EDGE;
      if (e.len < lim) parent[find(e.a)] = find(e.b);
    }
    const byRoot = new Map<number, number>();
    for (let n = 0; n < N; n++) {
      if (!member[n]) continue;
      const r = find(n);
      let cid = byRoot.get(r);
      if (cid === undefined) {
        cid = this.clusters.length;
        byRoot.set(r, cid);
        this.clusters.push({ id: cid, nodes: [], x: 0, z: 0, radius: 0, inside: [], approaching: [] });
      }
      this.clusters[cid].nodes.push(n);
      this.nodes[n].cluster = cid;
    }
    for (const c of this.clusters) {
      let sx = 0, sz = 0;
      for (const n of c.nodes) {
        sx += this.nodes[n].x;
        sz += this.nodes[n].z;
      }
      c.x = sx / c.nodes.length;
      c.z = sz / c.nodes.length;
      let r = 0;
      for (const n of c.nodes) {
        let hw = 0;
        for (const ei of this.nodes[n].car) hw = Math.max(hw, this.edges[ei].width * 0.5);
        r = Math.max(r, Math.hypot(this.nodes[n].x - c.x, this.nodes[n].z - c.z) + hw + 2);
      }
      c.radius = r;
    }
  }

  // ------------------------------------------------------------------------------------- cars

  /** Lanes per direction for car travel on an edge. */
  laneCount(edge: number): number {
    const e = this.edges[edge];
    const n = Math.max(1, Math.min(3, Math.round(e.lanes || 1)));
    const per = e.oneway ? e.width / n : e.width / (2 * n);
    return per < 2.4 ? Math.max(1, Math.floor((e.oneway ? e.width : e.width / 2) / 2.6)) : n;
  }

  /** Car travel direction index leaving `node` along `edge`, or -1 when not allowed. */
  carDirFrom(edge: number, node: number): number {
    const e = this.edges[edge];
    if (!e.car || e.a === e.b) return -1;
    if (e.a === node) return 0;
    if (e.b === node) return e.oneway ? -1 : 1;
    return -1;
  }

  /** Distance (m) to pull a car lane back from `node` so it ends at the junction edge. */
  carTrim(node: number, edge: number): number {
    const key = node * 8192 + edge;
    const cached = this.trims.get(key);
    if (cached !== undefined) return cached;
    const nd = this.nodes[node];
    const e = this.edges[edge];
    let trim: number;
    if (nd.car.length <= 1) trim = 0.6;
    else if (nd.car.length === 2) trim = 0.4;
    else {
      const d0 = [0, 0];
      const d1 = [0, 0];
      this.leaveDir(edge, node, d0);
      trim = 2;
      for (const f of nd.car) {
        if (f === edge) continue;
        this.leaveDir(f, node, d1);
        const sin = Math.abs(d0[0] * d1[1] - d0[1] * d1[0]);
        const cos = d0[0] * d1[0] + d0[1] * d1[1];
        // roads nearly in line with this one (cos < -0.8) do not cut across it
        if (cos < -0.8) continue;
        const need = (this.edges[f].width * 0.5 + 1.0) / Math.max(sin, 0.45);
        trim = Math.max(trim, need);
      }
      trim = Math.min(trim, 11);
    }
    trim = Math.min(trim, e.len * 0.45);
    this.trims.set(key, trim);
    return trim;
  }

  /** Right-hand lateral offset of car lane `lane` (0 = leftmost) on an edge. */
  laneOffset(edge: number, lane: number): number {
    const e = this.edges[edge];
    const n = this.laneCount(edge);
    if (e.oneway) {
      const lw = e.width / n;
      return -e.width / 2 + lw * (lane + 0.5);
    }
    const lw = e.width / (2 * n);
    return Math.max(lw * (lane + 0.5), lane === 0 ? Math.min(0.95, e.width * 0.3) : 0);
  }

  carLane(edge: number, dir: number, lane: number): Path {
    const key = (edge * 2 + dir) * 4 + lane;
    let p = this.carLanes.get(key);
    if (p) return p;
    const e = this.edges[edge];
    const startNode = dir === 0 ? e.a : e.b;
    const endNode = dir === 0 ? e.b : e.a;
    const { xs, zs } = offsetPolyline(
      e.pts, dir === 1, this.laneOffset(edge, lane),
      this.carTrim(startNode, edge), this.carTrim(endNode, edge),
    );
    p = new Path(xs, zs, this.heightFn);
    p.kind = PATH_LANE;
    p.edge = edge;
    p.dir = dir;
    p.lane = lane;
    p.startNode = startNode;
    p.endNode = endNode;
    p.speed = e.speed > 1 ? e.speed : 8.3;
    p.rank = this.rank(edge);
    const cs = this.nodes[startNode].cluster;
    p.internal = cs >= 0 && cs === this.nodes[endNode].cluster;
    p.computeCurveSpeeds();
    this.carLanes.set(key, p);
    return p;
  }

  /** Connector from the end of lane `a` to the start of lane `b` (they meet at a.endNode). */
  carConnector(a: Path, b: Path): Path {
    const key = a.id * 1048576 + b.id;
    let p = this.conns.get(key);
    if (p) return p;
    const n0 = a.n - 1;
    const t0x = a.xs[n0] - a.xs[n0 - 1];
    const t0z = a.zs[n0] - a.zs[n0 - 1];
    const l0 = Math.hypot(t0x, t0z) || 1;
    const t3x = b.xs[1] - b.xs[0];
    const t3z = b.zs[1] - b.zs[0];
    const l3 = Math.hypot(t3x, t3z) || 1;
    const uturn = a.edge === b.edge;
    const { xs, zs } = bezierConnector(
      a.xs[n0], a.zs[n0], t0x / l0, t0z / l0, b.xs[0], b.zs[0], t3x / l3, t3z / l3, uturn ? 3.2 : 0,
    );
    p = new Path(xs, zs, this.heightFn);
    p.kind = PATH_CONN;
    p.inPath = a;
    p.outPath = b;
    p.startNode = a.endNode;
    p.endNode = a.endNode;
    p.cluster = this.nodes[a.endNode].cluster;
    p.speed = Math.min(a.speed, b.speed);
    p.rank = a.rank;
    // turn classification
    const cross = (t0x / l0) * (t3z / l3) - (t0z / l0) * (t3x / l3);
    const dot = (t0x / l0) * (t3x / l3) + (t0z / l0) * (t3z / l3);
    // right of (tx, tz) is (-tz, tx): turning right means the new direction has a positive
    // component along that vector: -t0z*t3x + t0x*t3z = cross
    p.turn = uturn || dot < -0.8 ? 2 : dot > 0.75 ? 0 : cross > 0 ? 1 : -1;
    p.computeCurveSpeeds(Math.max(2, p.len * 0.35), p.turn === 2 ? 3.5 : 2.6);
    this.conns.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------------------------- bikes

  bikeDirFrom(edge: number, node: number): number {
    const e = this.edges[edge];
    if (!e.bike || e.a === e.b) return -1;
    if (e.a === node) return 0;
    if (e.b !== node) return -1;
    // cyclists may ride against one-way traffic on quiet streets (common "uitgezonderd fietsers")
    if (e.oneway && !(e.car && (e.type === 'residential' || e.type === 'living_street' || e.type === 'service'))) return -1;
    return 1;
  }

  private bikeTrim(node: number, edge: number): number {
    const nd = this.nodes[node];
    if (nd.bike.length <= 2) return 0.2;
    if (nd.car.length >= 3 && this.edges[edge].car) return Math.max(0.2, this.carTrim(node, edge) - 0.8);
    let hw = 0;
    for (const f of nd.bike) if (f !== edge) hw = Math.max(hw, this.edges[f].width * 0.5);
    return Math.min(Math.max(1, hw * 0.8), 5, this.edges[edge].len * 0.4);
  }

  /** Does a polyline (or its 0.4 m right shoulder) run through a building? Samples every ~4 m. */
  private lineInside(xs: Float32Array, zs: Float32Array, inside: (x: number, z: number) => boolean): boolean {
    for (let i = 0; i + 1 < xs.length; i++) {
      const dx = xs[i + 1] - xs[i];
      const dz = zs[i + 1] - zs[i];
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      const rx = (-dz / l) * 0.4;
      const rz = (dx / l) * 0.4;
      const n = Math.max(1, Math.ceil(l / 4));
      for (let k = 0; k <= n; k++) {
        const x = xs[i] + (dx * k) / n;
        const z = zs[i] + (dz * k) / n;
        if (inside(x, z) || inside(x + rx, z + rz)) return true;
      }
    }
    return false;
  }

  bikeOffset(edge: number): number {
    const e = this.edges[edge];
    if (e.car) return Math.max(0.45, e.width * 0.5 - 0.75);
    return Math.max(0.4, Math.min(1.2, e.width * 0.25));
  }

  bikePath(edge: number, dir: number): Path {
    const key = edge * 2 + dir;
    let p = this.bikePaths.get(key);
    if (p) return p;
    const e = this.edges[edge];
    const startNode = dir === 0 ? e.a : e.b;
    const endNode = dir === 0 ? e.b : e.a;
    const base = this.bikeOffset(edge);
    const tA = this.bikeTrim(startNode, edge);
    const tB = this.bikeTrim(endNode, edge);
    let { xs, zs } = offsetPolyline(e.pts, dir === 1, base, tA, tB);
    // OSM width vs building footprints: move the line toward the centre while it clips a facade
    const inside = this.insideFn;
    if (inside) {
      for (const f of [0.6, 0.3, 0]) {
        if (!this.lineInside(xs, zs, inside)) break;
        ({ xs, zs } = offsetPolyline(e.pts, dir === 1, Math.max(0.3, base * f), tA, tB));
      }
    }
    p = new Path(xs, zs, this.heightFn);
    p.edge = edge;
    p.dir = dir;
    p.startNode = startNode;
    p.endNode = endNode;
    p.speed = 5.5;
    p.computeCurveSpeeds(4, 2.2);
    this.bikePaths.set(key, p);
    return p;
  }

  bikeConnector(a: Path, b: Path): Path {
    const key = -(a.id * 1048576 + b.id);
    let p = this.conns.get(key);
    if (p) return p;
    const n0 = a.n - 1;
    const t0x = a.xs[n0] - a.xs[n0 - 1];
    const t0z = a.zs[n0] - a.zs[n0 - 1];
    const l0 = Math.hypot(t0x, t0z) || 1;
    const t3x = b.xs[1] - b.xs[0];
    const t3z = b.zs[1] - b.zs[0];
    const l3 = Math.hypot(t3x, t3z) || 1;
    const { xs, zs } = bezierConnector(a.xs[n0], a.zs[n0], t0x / l0, t0z / l0, b.xs[0], b.zs[0], t3x / l3, t3z / l3, a.edge === b.edge ? 1.6 : 0);
    p = new Path(xs, zs, this.heightFn);
    p.kind = PATH_CONN;
    p.inPath = a;
    p.outPath = b;
    p.startNode = a.endNode;
    p.endNode = a.endNode;
    p.computeCurveSpeeds(Math.max(1.5, p.len * 0.35), 2.2);
    this.conns.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------------------------- feet

  /**
   * Lateral offset of the usable sidewalk on `side` (0 = right of a->b, 1 = left) of a car edge,
   * or NaN when there is none (water, building, parking strip at road level...). Pure foot edges
   * return 0 (walk on the way itself).
   */
  sidewalkOffset(edge: number, side: number): number {
    const e = this.edges[edge];
    if (!e.car && side !== 0) return NaN;
    const key = edge * 2 + side;
    const c = this.sideOff.get(key);
    if (c !== undefined) return c;
    if (!e.car) {
      // foot-only way: walk on the way itself, unless it runs through a building (BAG passages /
      // indoor ways: the buildings are solid in the game); 1 m samples, a touched corner is fine
      let ok = true;
      const inside = this.insideFn;
      if (inside) {
        let cnt = 0;
        let run = 0;
        for (let k = 1; k < e.pts.length && ok; k++) {
          const [ax, az] = e.pts[k - 1];
          const [bx, bz] = e.pts[k];
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
          for (let j = k === 1 ? 0 : 1; j <= n; j++) {
            const t = j / n;
            if (inside(ax + (bx - ax) * t, az + (bz - az) * t)) {
              cnt++;
              run++;
              if (cnt >= 3 || run >= 2) {
                ok = false;
                break;
              }
            } else run = 0;
          }
        }
      }
      const r = ok ? 0 : NaN;
      this.sideOff.set(key, r);
      return r;
    }
    let found = NaN;
    const cands = [e.width * 0.5 + 1.1, e.width * 0.5 + 1.9, e.width * 0.5 + 3.0];
    const fr = e.len < 10 ? [0.5] : [0.2, 0.5, 0.8];
    for (const off of cands) {
      const { xs, zs } = offsetPolyline(e.pts, side === 1, off, 0, 0);
      const path = new Path(xs, zs, null);
      const tmp = { x: 0, z: 0, tx: 0, tz: 1, i: 0 };
      let ok = true;
      for (const f of fr) {
        path.sample(path.len * f, tmp, tmp.i);
        const h = this.heightFn(tmp.x, tmp.z);
        if (!(h > 0.05 && h < 0.4)) {
          ok = false;
          break;
        }
      }
      // no walking through facades: sample the whole line every ~4 m, plus the walker's outer shoulder
      const inside = this.insideFn;
      if (ok && inside) {
        const n = Math.min(24, Math.max(2, Math.ceil(path.len / 4)));
        tmp.i = 0;
        for (let k = 0; k <= n && ok; k++) {
          path.sample((path.len * k) / n, tmp, tmp.i);
          // outward = right of the (possibly reversed) offset line
          if (inside(tmp.x, tmp.z) || inside(tmp.x - tmp.tz * 0.35, tmp.z + tmp.tx * 0.35)) ok = false;
        }
      }
      if (ok) {
        found = side === 1 ? -off : off;
        break;
      }
    }
    this.sideOff.set(key, found);
    return found;
  }

  /** Walking path on an edge: side 0/1 (sidewalk side for car edges), dir 0 = a->b, 1 = b->a. */
  footPath(edge: number, side: number, dir: number): Path | null {
    const key = (edge * 2 + side) * 2 + dir;
    const c = this.footPaths.get(key);
    if (c !== undefined) return c;
    const e = this.edges[edge];
    let off = this.sidewalkOffset(edge, side);
    let p: Path | null = null;
    if (Number.isFinite(off)) {
      const startNode = dir === 0 ? e.a : e.b;
      const endNode = dir === 0 ? e.b : e.a;
      // offset is relative to a->b; walking b->a mirrors it
      if (dir === 1) off = -off;
      const tA = e.car ? this.footTrim(startNode, edge) : 0;
      const tB = e.car ? this.footTrim(endNode, edge) : 0;
      const { xs, zs } = offsetPolyline(e.pts, dir === 1, off, tA, tB);
      p = new Path(xs, zs, this.heightFn);
      p.edge = edge;
      p.dir = dir;
      p.lane = side;
      p.startNode = startNode;
      p.endNode = endNode;
      p.speed = 1.4;
    }
    this.footPaths.set(key, p);
    return p;
  }

  private footTrim(node: number, edge: number): number {
    const nd = this.nodes[node];
    if (nd.car.length < 3) return 0;
    return Math.min(this.carTrim(node, edge) + 0.6, this.edges[edge].len * 0.45);
  }

  footConnector(a: Path, b: Path): Path {
    const key = -(a.id * 1048576 + b.id) - 0.5;
    let p = this.conns.get(key);
    if (p) return p;
    const { xs, zs } = straightConnector(a.xs[a.n - 1], a.zs[a.n - 1], b.xs[0], b.zs[0]);
    p = new Path(xs, zs, this.heightFn);
    p.kind = PATH_CONN;
    p.inPath = a;
    p.outPath = b;
    p.startNode = a.endNode;
    p.endNode = a.endNode;
    this.conns.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------------------------- spawning

  /**
   * Collects edges of `list` whose bbox intersects the ring [rMin, rMax] around (fx, fz) into
   * outIdx with cumulative lengths in outCum (for weighted random picks). Returns the count.
   */
  collectRing(
    list: number[], fx: number, fz: number, rMin: number, rMax: number, outIdx: Int32Array, outCum: Float32Array,
    weight?: (e: RoadEdge) => number,
  ): number {
    let n = 0;
    let acc = 0;
    const b = this.bbox;
    for (let k = 0; k < list.length && n < outIdx.length; k++) {
      const i = list[k];
      const x0 = b[i * 4], z0 = b[i * 4 + 1], x1 = b[i * 4 + 2], z1 = b[i * 4 + 3];
      // nearest distance from the focus to the bbox
      const dx = fx < x0 ? x0 - fx : fx > x1 ? fx - x1 : 0;
      const dz = fz < z0 ? z0 - fz : fz > z1 ? fz - z1 : 0;
      if (dx * dx + dz * dz > rMax * rMax) continue;
      // farthest corner distance
      const fxd = Math.max(Math.abs(fx - x0), Math.abs(fx - x1));
      const fzd = Math.max(Math.abs(fz - z0), Math.abs(fz - z1));
      if (fxd * fxd + fzd * fzd < rMin * rMin) continue;
      const e = this.edges[i];
      acc += Math.max(e.len, 1) * (weight ? weight(e) : 1);
      outIdx[n] = i;
      outCum[n] = acc;
      n++;
    }
    return n;
  }
}
