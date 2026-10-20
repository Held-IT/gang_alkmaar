// DEV ONLY: synthesises a plausible, city-scale PropsData from roadgraph.json + map2d.json +
// footprints.json, for performance/visual testing while the OSM pipeline's props.json is empty.
// Not used by the game. (?scene=dev-props&view=data&synth=1)
import type { Footprints, Map2D, PropsData, Rect, RoadGraph } from '../../../contracts';
import { Rng } from '../util/rng';

class Occupancy {
  private readonly n: number;
  private readonly m: number;
  private readonly cells: Uint8Array;
  constructor(private readonly r: Rect, private readonly cs: number) {
    this.n = Math.ceil((r.maxX - r.minX) / cs);
    this.m = Math.ceil((r.maxZ - r.minZ) / cs);
    this.cells = new Uint8Array(this.n * this.m);
  }
  fillRing(ring: [number, number][], v = 1): void {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const i0 = Math.max(0, Math.floor((minX - this.r.minX) / this.cs)), i1 = Math.min(this.n - 1, Math.floor((maxX - this.r.minX) / this.cs));
    const j0 = Math.max(0, Math.floor((minZ - this.r.minZ) / this.cs)), j1 = Math.min(this.m - 1, Math.floor((maxZ - this.r.minZ) / this.cs));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = this.r.minX + (i + 0.5) * this.cs, z = this.r.minZ + (j + 0.5) * this.cs;
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, za] = ring[a], [xb, zb] = ring[b];
        if ((za > z) !== (zb > z) && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
      }
      if (inside) this.cells[j * this.n + i] = v;
    }
  }
  get(x: number, z: number): number {
    const i = Math.floor((x - this.r.minX) / this.cs), j = Math.floor((z - this.r.minZ) / this.cs);
    if (i < 0 || j < 0 || i >= this.n || j >= this.m) return 255;
    return this.cells[j * this.n + i];
  }
  set(x: number, z: number, v: number): void {
    const i = Math.floor((x - this.r.minX) / this.cs), j = Math.floor((z - this.r.minZ) / this.cs);
    if (i < 0 || j < 0 || i >= this.n || j >= this.m) return;
    this.cells[j * this.n + i] = v;
  }
}

export function synthesizeProps(graph: RoadGraph, map2d: Map2D | null, fp: Footprints | null, rect: Rect): PropsData {
  const p: PropsData = { trees: [], lamps: [], benches: [], bollards: [], parkedBikes: [], parkedCars: [], signs: [], streetNameSigns: [], trafficLights: [], bins: [] };
  const rng = new Rng(4711);
  const occ = new Occupancy(rect, 1);
  for (const ring of fp?.rings ?? []) occ.fillRing(ring, 1);
  for (const poly of map2d?.water ?? []) if (poly[0]) occ.fillRing(poly[0], 2);
  // roads: mark carriageways as 3 so props stay on the pavement
  for (const e of graph.edges) {
    if (!e.car) continue;
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= len; s += 0.8) {
        const t = s / (len || 1);
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const hw = e.width / 2;
        const nx = -(bz - az) / (len || 1), nz = (bx - ax) / (len || 1);
        for (let o = -hw; o <= hw; o += 0.8) if (occ.get(x + nx * o, z + nz * o) === 0) occ.set(x + nx * o, z + nz * o, 3);
      }
    }
  }
  const free = (x: number, z: number) => occ.get(x, z) === 0;
  const inner = (x: number, z: number) => Math.hypot(x + 150, z + 30) < 650;

  // lamps + bollards + street names along car roads
  const named = new Map<string, number>();
  for (const e of graph.edges) {
    if (!e.car) continue;
    let acc = rng.range(0, 25);
    for (let k = 0; k + 1 < e.pts.length; k++) {
      const [ax, az] = e.pts[k], [bx, bz] = e.pts[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      const nx = -dz, nz = dx;
      while (acc < len) {
        const x = ax + dx * acc, z = az + dz * acc;
        const side = rng.chance(0.5) ? 1 : -1;
        const off = e.width / 2 + 0.7;
        const lx = x + nx * off * side, lz = z + nz * off * side;
        if (free(lx, lz)) p.lamps.push([lx, lz, Math.atan2(-nx * side, -nz * side), inner(lx, lz) && e.type !== 'primary' && e.type !== 'secondary' ? 0 : 1]);
        acc += 28;
      }
      acc -= len;
      // bollards on short stretches in the binnenstad
      if (inner(ax, az) && rng.chance(0.12)) {
        for (let s = 2; s < Math.min(len, 14); s += 1.6) {
          const bx2 = ax + dx * s + nx * (e.width / 2 + 0.35), bz2 = az + dz * s + nz * (e.width / 2 + 0.35);
          if (free(bx2, bz2)) p.bollards.push([bx2, bz2]);
        }
      }
    }
    if (e.name && e.len > 40) {
      const last = named.get(e.name) ?? 0;
      if (last < 3) {
        named.set(e.name, last + 1);
        const [x, z] = e.pts[0];
        const [x2, z2] = e.pts[1];
        const l = Math.hypot(x2 - x, z2 - z) || 1;
        const nx = -(z2 - z) / l, nz = (x2 - x) / l;
        const sx = x + (x2 - x) / l * 6 + nx * (e.width / 2 + 1.0), sz = z + (z2 - z) / l * 6 + nz * (e.width / 2 + 1.0);
        if (free(sx, sz)) p.streetNameSigns.push([sx, sz, Math.atan2(x2 - x, z2 - z) + Math.PI / 2, e.name]);
      }
    }
    if (e.oneway && e.pts.length > 1) {
      const [x, z] = e.pts[e.pts.length - 1], [xp, zp] = e.pts[e.pts.length - 2];
      const l = Math.hypot(x - xp, z - zp) || 1;
      const dx = (x - xp) / l, dz = (z - zp) / l;
      const sx = x - dx * 3 + -dz * (e.width / 2 + 0.6), sz = z - dz * 3 + dx * (e.width / 2 + 0.6);
      if (free(sx, sz)) p.signs.push([sx, sz, Math.atan2(-dx, -dz), 'C2']);
    }
    if ((e.type === 'residential' || e.type === 'living_street') && rng.chance(0.05)) {
      const [x, z] = e.pts[0];
      const sx = x + 2, sz = z + 2;
      if (free(sx, sz)) p.signs.push([sx, sz, rng.range(0, 6.28), rng.pick(['A1-30', 'E1', 'G5', 'B6', 'C6', 'E4'])]);
    }
  }
  // traffic lights at junctions of main roads
  const deg = new Map<number, number>();
  for (const e of graph.edges) if (e.car && (e.type === 'primary' || e.type === 'secondary' || e.type === 'tertiary')) {
    deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
    deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
  }
  for (const [node, d] of deg) {
    if (d < 3) continue;
    const [x, z] = graph.nodes[node];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + 0.3;
      const lx = x + Math.sin(a) * 8, lz = z + Math.cos(a) * 8;
      if (free(lx, lz)) p.trafficLights.push([lx, lz, a + Math.PI]);
    }
  }
  // canal trees, bikes, benches and bins along the water edges
  for (const poly of map2d?.water ?? []) {
    const ring = poly[0];
    if (!ring) continue;
    let accT = rng.range(0, 9), accB = rng.range(0, 30), accS = rng.range(0, 60);
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.1) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      let nx = -dz, nz = dx;
      if (occ.get(ax + dx * len / 2 + nx * 1.5, az + dz * len / 2 + nz * 1.5) === 2) { nx = -nx; nz = -nz; }
      while (accT < len) {
        const x = ax + dx * accT + nx * 2.4, z = az + dz * accT + nz * 2.4;
        if (x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ && free(x, z)) p.trees.push([x, z, rng.range(11, 17), rng.chance(0.06) ? 1 : 0]);
        accT += rng.range(8, 11);
      }
      accT -= len;
      while (accB < len) {
        const n = rng.int(4, 14);
        for (let b = 0; b < n && accB < len; b++, accB += 0.7) {
          const x = ax + dx * accB + nx * 1.1, z = az + dz * accB + nz * 1.1;
          if (inner(x, z) && free(x, z)) p.parkedBikes.push([x, z, Math.atan2(-nx, -nz)]);
        }
        accB += rng.range(15, 45);
      }
      accB -= len;
      while (accS < len) {
        const x = ax + dx * accS + nx * 3.6, z = az + dz * accS + nz * 3.6;
        if (inner(x, z) && free(x, z)) {
          p.benches.push([x, z, Math.atan2(-nx, -nz)]);
          p.bins.push([x + dx * 1.6, z + dz * 1.6, Math.atan2(-nx, -nz)]);
        }
        accS += rng.range(50, 90);
      }
      accS -= len;
    }
  }
  return p;
}
