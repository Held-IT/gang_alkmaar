// Nearest car road edge to a point (for the HUD speed-limit sign and a street-name fallback).
// Uniform grid over the road segments; lookups do not allocate.
import type { RoadEdge, RoadGraph } from '../contracts';

const CELL = 25;

export interface RoadLookup {
  /** Nearest car-road edge within maxDist metres, or null. */
  nearest(x: number, z: number, maxDist?: number): RoadEdge | null;
}

export function createRoadLookup(graph: RoadGraph): RoadLookup {
  const seg: number[] = []; // ax, az, bx, bz
  const segEdge: number[] = [];
  const edges = graph.edges ?? [];
  edges.forEach((e, ei) => {
    if (!e.car) return;
    for (let i = 0; i + 1 < e.pts.length; i++) {
      seg.push(e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1]);
      segEdge.push(ei);
    }
  });
  const cells = new Map<number, number[]>();
  const key = (cx: number, cz: number) => (cx + 4096) * 8192 + (cz + 4096);
  for (let s = 0; s < segEdge.length; s++) {
    const ax = seg[s * 4], az = seg[s * 4 + 1], bx = seg[s * 4 + 2], bz = seg[s * 4 + 3];
    for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) {
      for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) {
        const k = key(cx, cz);
        let l = cells.get(k);
        if (!l) cells.set(k, (l = []));
        l.push(s);
      }
    }
  }
  return {
    nearest(x, z, maxDist = 14) {
      const r = Math.ceil(maxDist / CELL);
      const cx0 = Math.floor(x / CELL);
      const cz0 = Math.floor(z / CELL);
      let best = maxDist * maxDist;
      let bestE = -1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const l = cells.get(key(cx0 + dx, cz0 + dz));
          if (!l) continue;
          for (let i = 0; i < l.length; i++) {
            const s = l[i];
            const ax = seg[s * 4], az = seg[s * 4 + 1];
            const ex = seg[s * 4 + 2] - ax, ez = seg[s * 4 + 3] - az;
            const l2 = ex * ex + ez * ez;
            let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + ex * t - x, pz = az + ez * t - z;
            const d2 = px * px + pz * pz;
            if (d2 < best) {
              best = d2;
              bestE = segEdge[s];
            }
          }
        }
      }
      return bestE >= 0 ? edges[bestE] : null;
    },
  };
}
