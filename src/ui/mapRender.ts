// Static 2D map of the city, pre-rendered once into two offscreen canvases (detail ~2 px/m and
// overview ~0.8 px/m). The minimap, the full-screen map and the spawn picker draw rotated /
// scaled crops of these canvases every frame, which costs a single drawImage call.

import type { Footprints, Landmark, Map2D, Rect, RoadEdge, RoadGraph } from '../contracts';

export const MAP_COLORS = {
  land: '#1a1f27',
  park: '#1e3828',
  water: '#1d4d77',
  waterEdge: '#2b6597',
  building: '#2c333e',
  buildingEdge: '#20262f',
  /** Landmark footprints (De Waag, Grote Kerk, molen ...): a lighter tone so they stand out. */
  landmark: '#4b5363',
  landmarkEdge: '#2a2f38',
  foot: '#363d48',
  pedestrian: '#5a4c43',
  cycle: '#9c4236',
  casing: '#10141a',
  road: '#8f99a5',
  roadMajor: '#e9edf2',
};

export interface MapView {
  /** World point shown at (ox, oy). */
  cx: number;
  cz: number;
  /** Screen pixels per metre. */
  pxPerM: number;
  /** Canvas rotation (radians, clockwise on screen). Heading-up: heading - PI. */
  rotation: number;
  ox: number;
  oy: number;
  /** Destination size in px (used to crop the source). */
  w: number;
  h: number;
}

export interface StreetLabel {
  name: string;
  x: number;
  z: number;
  /** Text angle in world xz (radians, already flipped to read left-to-right). */
  angle: number;
  /** Length of the polyline the label sits on (m), for priority. */
  len: number;
  major: boolean;
}

export interface StaticMap {
  readonly bounds: Rect;
  readonly labels: StreetLabel[];
  landmarks: Landmark[];
  /**
   * Paints the footprints of these landmarks into the pre-rendered map (once per landmark id),
   * re-stroking the nearby roads so they stay on top. footprints.json leaves out the panden that
   * the landmarks module models itself (De Waag, Accijnstoren, Molen van Piet), so without this
   * the map has holes at exactly the places players look for. Returns true when anything changed.
   */
  paintLandmarks(list: readonly Landmark[]): boolean;
  draw(ctx: CanvasRenderingContext2D, v: MapView): void;
  /** World -> screen for a view (for markers / labels). */
  project(v: MapView, x: number, z: number, out: { x: number; y: number }): void;
  dispose(): void;
}

interface Level {
  canvas: HTMLCanvasElement;
  scale: number;
}

const MAJOR = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);
const FOOT = new Set(['footway', 'path', 'steps', 'track', 'bridleway', 'corridor']);

function roadClass(e: RoadEdge): 'major' | 'minor' | 'pedestrian' | 'cycle' | 'foot' {
  if (e.car) return MAJOR.has(e.type) ? 'major' : 'minor';
  if (e.type === 'pedestrian' || e.type === 'living_street') return 'pedestrian';
  if (e.type === 'cycleway' || (e.bike && !e.foot)) return 'cycle';
  if (FOOT.has(e.type)) return 'foot';
  return e.bike ? 'cycle' : 'foot';
}

function tracePolys(g: CanvasRenderingContext2D, polys: [number, number][][][]): void {
  g.beginPath();
  for (const poly of polys) {
    for (const ring of poly) {
      if (ring.length < 3) continue;
      g.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1]);
      g.closePath();
    }
  }
}

function traceEdges(g: CanvasRenderingContext2D, edges: RoadEdge[]): void {
  g.beginPath();
  for (const e of edges) {
    const p = e.pts;
    if (p.length < 2) continue;
    g.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) g.lineTo(p[i][0], p[i][1]);
  }
}

function strokeEdges(g: CanvasRenderingContext2D, edges: RoadEdge[], color: string, width: (e: RoadEdge) => number): void {
  // group by rounded width to keep the number of stroke calls low
  const byW = new Map<number, RoadEdge[]>();
  for (const e of edges) {
    const w = Math.round(width(e) * 4) / 4;
    let l = byW.get(w);
    if (!l) byW.set(w, (l = []));
    l.push(e);
  }
  g.strokeStyle = color;
  for (const [w, list] of [...byW].sort((a, b) => a[0] - b[0])) {
    g.lineWidth = w;
    traceEdges(g, list);
    g.stroke();
  }
}

/** Cooperative time slicing: yields to the event loop once a slice exceeded its budget. */
class Slicer {
  private t0 = performance.now();
  constructor(private budgetMs: number) {}
  async step(): Promise<void> {
    if (performance.now() - this.t0 < this.budgetMs) return;
    await new Promise<void>((r) => setTimeout(r, 0));
    this.t0 = performance.now();
  }
}

/** Vector render of the detail level, sliced so the loading screen keeps animating. */
async function renderLevel(b: Rect, scale: number, map2d: Map2D, fp: Footprints | null, graph: RoadGraph, sl: Slicer): Promise<Level> {
  const W = Math.max(1, Math.ceil((b.maxX - b.minX) * scale));
  const H = Math.max(1, Math.ceil((b.maxZ - b.minZ) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d', { alpha: false })!;
  g.fillStyle = MAP_COLORS.land;
  g.fillRect(0, 0, W, H);
  g.setTransform(scale, 0, 0, scale, -b.minX * scale, -b.minZ * scale);
  const px = 1 / scale;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  g.fillStyle = MAP_COLORS.park;
  tracePolys(g, map2d.parks ?? []);
  g.fill('evenodd');
  await sl.step();

  g.fillStyle = MAP_COLORS.water;
  tracePolys(g, map2d.water ?? []);
  g.fill('evenodd');
  g.strokeStyle = MAP_COLORS.waterEdge;
  g.lineWidth = 1.4 * px;
  g.stroke();
  await sl.step();

  // buildings in batches (only those inside the map extent)
  const rings = (fp?.rings ?? []).filter((r) => r.length >= 3 && r[0][0] > b.minX - 50 && r[0][0] < b.maxX + 50 && r[0][1] > b.minZ - 50 && r[0][1] < b.maxZ + 50);
  const BATCH = 1200;
  for (let s = 0; s < rings.length; s += BATCH) {
    g.beginPath();
    for (let k = s; k < Math.min(rings.length, s + BATCH); k++) {
      const ring = rings[k];
      g.moveTo(ring[0][0], ring[0][1]);
      for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1]);
      g.closePath();
    }
    g.fillStyle = MAP_COLORS.building;
    g.fill();
    g.strokeStyle = MAP_COLORS.buildingEdge;
    g.lineWidth = px;
    g.stroke();
    await sl.step();
  }

  for (const [list, color, width] of roadPasses(graph.edges ?? [], px)) {
    strokeEdges(g, list, color, width);
    await sl.step();
  }
  return { canvas, scale };
}

/** Road stroke passes, bottom to top. `px` = one canvas pixel in metres. */
function roadPasses(edges: readonly RoadEdge[], px: number): [RoadEdge[], string, (e: RoadEdge) => number][] {
  const groups = { major: [] as RoadEdge[], minor: [] as RoadEdge[], pedestrian: [] as RoadEdge[], cycle: [] as RoadEdge[], foot: [] as RoadEdge[] };
  for (const e of edges) groups[roadClass(e)].push(e);
  const minPx = (m: number, p: number) => Math.max(m, p * px);
  const minorW = (e: RoadEdge) => minPx(Math.max(5, e.width || 5), 2);
  const majorW = (e: RoadEdge) => minPx(Math.max(7.5, e.width || 7.5), 3);
  return [
    [groups.foot, MAP_COLORS.foot, () => minPx(1.6, 1)],
    [groups.pedestrian, MAP_COLORS.pedestrian, (e) => minPx(Math.max(4, e.width || 4), 2)],
    [groups.cycle, MAP_COLORS.cycle, () => minPx(2.4, 1.4)],
    [groups.minor, MAP_COLORS.casing, (e) => minorW(e) + minPx(2, 1.5)],
    [groups.major, MAP_COLORS.casing, (e) => majorW(e) + minPx(2.6, 2)],
    [groups.minor, MAP_COLORS.road, minorW],
    [groups.major, MAP_COLORS.roadMajor, majorW],
  ];
}

/** Paints extra footprint rings into the detail level (under the roads that cross `boxes`). */
function paintRings(lvl: Level, b: Rect, rings: [number, number][][], boxes: Rect[], graph: RoadGraph): void {
  const g = lvl.canvas.getContext('2d')!;
  const s = lvl.scale;
  const px = 1 / s;
  g.save();
  g.setTransform(s, 0, 0, s, -b.minX * s, -b.minZ * s);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  for (const ring of rings) {
    g.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) g.lineTo(ring[i][0], ring[i][1]);
    g.closePath();
  }
  g.fillStyle = MAP_COLORS.landmark;
  g.fill();
  g.strokeStyle = MAP_COLORS.landmarkEdge;
  g.lineWidth = px;
  g.stroke();
  // roads stay on top: re-stroke the edges near the rings (same passes as renderLevel), clipped to
  // the rings so road pixels outside them are not drawn twice (no seams in the anti-aliasing)
  g.clip();
  const near = (graph.edges ?? []).filter((e) => edgeNearBoxes(e, boxes, 25));
  for (const [list, color, width] of roadPasses(near, px)) strokeEdges(g, list, color, width);
  g.restore();
}

/** True when a segment's bounding box (grown by `pad` m, > half the widest stroke) overlaps a box. */
function edgeNearBoxes(e: RoadEdge, boxes: Rect[], pad: number): boolean {
  const p = e.pts;
  for (let i = 0; i + 1 < p.length; i++) {
    const x0 = Math.min(p[i][0], p[i + 1][0]) - pad;
    const x1 = Math.max(p[i][0], p[i + 1][0]) + pad;
    const z0 = Math.min(p[i][1], p[i + 1][1]) - pad;
    const z1 = Math.max(p[i][1], p[i + 1][1]) + pad;
    for (const r of boxes) if (x1 > r.minX && x0 < r.maxX && z1 > r.minZ && z0 < r.maxZ) return true;
  }
  return false;
}

/** Refreshes the overview level from the detail level inside world rect `r`. */
function downscaleRegion(src: Level, dst: Level, b: Rect, r: Rect): void {
  const k = dst.scale / src.scale;
  const x0 = Math.max(0, Math.floor((r.minX - b.minX) * dst.scale) - 2);
  const y0 = Math.max(0, Math.floor((r.minZ - b.minZ) * dst.scale) - 2);
  const x1 = Math.min(dst.canvas.width, Math.ceil((r.maxX - b.minX) * dst.scale) + 2);
  const y1 = Math.min(dst.canvas.height, Math.ceil((r.maxZ - b.minZ) * dst.scale) + 2);
  if (x1 <= x0 || y1 <= y0) return;
  const g = dst.canvas.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src.canvas, x0 / k, y0 / k, (x1 - x0) / k, (y1 - y0) / k, x0, y0, x1 - x0, y1 - y0);
}

/** Overview level: a smooth 2:1 (or smaller) downscale of the detail level. */
function downscale(src: Level, scale: number): Level {
  const k = scale / src.scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.canvas.width * k));
  canvas.height = Math.max(1, Math.round(src.canvas.height * k));
  const g = canvas.getContext('2d', { alpha: false })!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src.canvas, 0, 0, canvas.width, canvas.height);
  return { canvas, scale };
}

function computeLabels(graph: RoadGraph): StreetLabel[] {
  // Longest polyline per street name; label at its middle.
  const best = new Map<string, RoadEdge>();
  for (const e of graph.edges ?? []) {
    if (!e.name || e.pts.length < 2) continue;
    const cls = roadClass(e);
    if (cls === 'foot') continue;
    const cur = best.get(e.name);
    if (!cur || e.len > cur.len) best.set(e.name, e);
  }
  const out: StreetLabel[] = [];
  for (const [name, e] of best) {
    if (e.len < 35) continue;
    const half = e.len / 2;
    let acc = 0;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      const [ax, az] = e.pts[i];
      const [bx, bz] = e.pts[i + 1];
      const sl = Math.hypot(bx - ax, bz - az);
      if (acc + sl >= half || i + 2 === e.pts.length) {
        const t = sl > 0 ? Math.min(1, (half - acc) / sl) : 0;
        let angle = Math.atan2(bz - az, bx - ax);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
        out.push({ name, x: ax + (bx - ax) * t, z: az + (bz - az) * t, angle, len: e.len, major: e.car && MAJOR.has(e.type) });
        break;
      }
      acc += sl;
    }
  }
  out.sort((a, b) => Number(b.major) - Number(a.major) || b.len - a.len);
  return out;
}

/** Map extent: the road graph (= playable area) plus a margin, limited to the Map2D bounds. */
function mapBounds(map2d: Map2D, graph: RoadGraph, margin: number): Rect {
  const mb = map2d.bounds;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of graph.nodes ?? []) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) return { ...mb };
  return {
    minX: Math.max(mb.minX, minX - margin),
    minZ: Math.max(mb.minZ, minZ - margin),
    maxX: Math.min(mb.maxX, maxX + margin),
    maxZ: Math.min(mb.maxZ, maxZ + margin),
  };
}

/**
 * Pre-renders the map. Work is time-sliced (~`budgetMs` per task) so the page stays responsive;
 * the returned promise resolves when both levels are ready.
 */
export async function buildStaticMap(map2d: Map2D, footprints: Footprints | null, graph: RoadGraph, budgetMs = 12): Promise<StaticMap> {
  const b = mapBounds(map2d, graph, 260);
  const W = b.maxX - b.minX;
  const H = b.maxZ - b.minZ;
  // detail level ~1.6-2 px/m (capped to keep the canvas <= ~3.6k px), overview level 0.8 px/m
  const hiScale = Math.min(2, 3600 / W, 3600 / H);
  const loScale = Math.min(0.8, hiScale / 2);
  const sl = new Slicer(budgetMs);
  let hi: Level | null = await renderLevel(b, hiScale, map2d, footprints, graph, sl);
  await sl.step();
  let lo: Level | null = downscale(hi, loScale);
  const labels = computeLabels(graph);
  const painted = new Set<string>();

  return {
    bounds: b,
    labels,
    landmarks: [],
    paintLandmarks(list) {
      if (!hi || !lo) return false;
      const rings: [number, number][][] = [];
      const boxes: Rect[] = [];
      for (const l of list) {
        const ring = l.footprint;
        const key = `${l.id}@${l.x},${l.z}`;
        if (!ring || ring.length < 3 || painted.has(key)) continue;
        painted.add(key);
        const r: Rect = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
        for (const [x, z] of ring) {
          if (x < r.minX) r.minX = x;
          if (x > r.maxX) r.maxX = x;
          if (z < r.minZ) r.minZ = z;
          if (z > r.maxZ) r.maxZ = z;
        }
        // skip rings outside the map extent; grow the box by ~2 px for the edge stroke
        if (r.maxX < b.minX || r.minX > b.maxX || r.maxZ < b.minZ || r.minZ > b.maxZ) continue;
        const m = 2 / hi.scale;
        r.minX -= m; r.minZ -= m; r.maxX += m; r.maxZ += m;
        rings.push(ring);
        boxes.push(r);
      }
      if (!rings.length) return false;
      paintRings(hi, b, rings, boxes, graph);
      for (const r of boxes) downscaleRegion(hi, lo, b, r);
      return true;
    },
    draw(ctx, v) {
      if (!hi || !lo) return;
      const lvl = v.pxPerM <= lo.scale * 1.15 ? lo : hi;
      const k = v.pxPerM / lvl.scale;
      const pcx = (v.cx - b.minX) * lvl.scale;
      const pcy = (v.cz - b.minZ) * lvl.scale;
      // generous source radius: covers any rotation and an off-centre origin
      const r = (Math.hypot(v.w, v.h) + Math.hypot(v.ox - v.w / 2, v.oy - v.h / 2)) / k;
      const cw = lvl.canvas.width;
      const ch = lvl.canvas.height;
      const sx0 = Math.max(0, Math.floor(pcx - r));
      const sy0 = Math.max(0, Math.floor(pcy - r));
      const sx1 = Math.min(cw, Math.ceil(pcx + r));
      const sy1 = Math.min(ch, Math.ceil(pcy + r));
      if (sx1 <= sx0 || sy1 <= sy0) return;
      ctx.save();
      ctx.translate(v.ox, v.oy);
      ctx.rotate(v.rotation);
      ctx.scale(k, k);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(lvl.canvas, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0 - pcx, sy0 - pcy, sx1 - sx0, sy1 - sy0);
      ctx.restore();
    },
    project(v, x, z, out) {
      const dx = (x - v.cx) * v.pxPerM;
      const dz = (z - v.cz) * v.pxPerM;
      const c = Math.cos(v.rotation);
      const s = Math.sin(v.rotation);
      out.x = v.ox + dx * c - dz * s;
      out.y = v.oy + dx * s + dz * c;
    },
    dispose() {
      for (const l of [hi, lo]) if (l) l.canvas.width = l.canvas.height = 0;
      hi = lo = null;
    },
  };
}
