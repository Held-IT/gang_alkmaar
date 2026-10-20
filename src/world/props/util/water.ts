// "Is this point near a canal?" for map2d water polygons: edges bucketed in a coarse grid, so a
// query only tests the few edges around it. Used to put canal-side trees on the water
// reflection layer.
import type { Map2D } from '../../../contracts';

export function makeNearWater(map2d: Map2D | null | undefined, dist: number, cell = 16): (x: number, z: number) => boolean {
  const water = map2d?.water;
  if (!water || !water.length) return () => false;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
  for (const poly of water) {
    for (const ring of poly as unknown as [number, number][][]) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], b = ring[(k + 1) % ring.length];
        const i0 = Math.floor((Math.min(a[0], b[0]) - dist) / cell), i1 = Math.floor((Math.max(a[0], b[0]) + dist) / cell);
        const j0 = Math.floor((Math.min(a[1], b[1]) - dist) / cell), j1 = Math.floor((Math.max(a[1], b[1]) + dist) / cell);
        for (let i = i0; i <= i1; i++) {
          for (let j = j0; j <= j1; j++) {
            const k2 = key(i, j);
            let list = grid.get(k2);
            if (!list) grid.set(k2, (list = []));
            list.push(a[0], a[1], b[0], b[1]);
          }
        }
      }
    }
  }
  const d2 = dist * dist;
  return (x: number, z: number): boolean => {
    const list = grid.get(key(Math.floor(x / cell), Math.floor(z / cell)));
    if (!list) return false;
    for (let k = 0; k < list.length; k += 4) {
      const ax = list[k], az = list[k + 1], dx = list[k + 2] - ax, dz = list[k + 3] - az;
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const ex = ax + dx * t - x, ez = az + dz * t - z;
      if (ex * ex + ez * ez < d2) return true;
    }
    return false;
  };
}
