// Street-level height + surface grid, rasterised once at load time from the ground GLB meshes.
//
// Each cell stores the HIGHEST walkable/drivable surface whose triangle covers the cell centre
// (int16 centimetres) and the MaterialClass of that surface (uint8 id). Water (y = WATER_LEVEL)
// is rasterised too, so over canals the grid holds the water level instead of the canal bed,
// and on bridges the deck wins over the water below it. Vertical faces (curbs, quay walls,
// parapets) are skipped by their normal; railings/parapets are left out by material.
//
// heightAt() interpolates bilinearly between valid cells (cells under buildings have no data
// and are ignored); outside the grid it returns the fallback (street level).
import type { MaterialClass, Rect } from '../contracts';

/** Surface ids stored in the grid (0 = no data). */
export const SURFACE_CLASSES: readonly (MaterialClass | null)[] = [
  null, 'asphalt', 'klinkers', 'sidewalk', 'square', 'curb', 'bikelane', 'grass', 'water', 'quay', 'quay_cap',
  'bridge_deck', 'bridge_side', 'bridge_rail', 'road_marking', 'parking', 'canal_bed', 'ground',
];
const SURFACE_ID = new Map<string, number>(SURFACE_CLASSES.map((c, i) => [c ?? '', i]));
export function surfaceId(cls: string): number {
  return SURFACE_ID.get(cls) ?? SURFACE_ID.get('ground')!;
}

const NO_DATA = -32768;

export class HeightGrid {
  readonly minX: number;
  readonly minZ: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  /** height per cell in centimetres, NO_DATA where nothing was rasterised */
  readonly h: Int16Array;
  /** surface id per cell (index into SURFACE_CLASSES) */
  readonly s: Uint8Array;
  /** building footprint bit mask (1 bit per cell), null until rasterizeFootprints() */
  b: Uint8Array | null = null;
  private readonly inv: number;

  constructor(rect: Rect, cell = 0.5) {
    this.cell = cell;
    this.inv = 1 / cell;
    this.minX = rect.minX;
    this.minZ = rect.minZ;
    this.nx = Math.max(1, Math.ceil((rect.maxX - rect.minX) / cell));
    this.nz = Math.max(1, Math.ceil((rect.maxZ - rect.minZ) / cell));
    this.h = new Int16Array(this.nx * this.nz).fill(NO_DATA);
    this.s = new Uint8Array(this.nx * this.nz);
  }

  /**
   * Rasterises the upward-facing triangles (|normal.y| >= minNy) of an indexed mesh, keeping
   * the highest surface per cell. Returns the number of triangles used.
   */
  rasterize(pos: Float32Array, idx: Uint32Array, sid: number, minNy = 0.35): number {
    const { nx, nz, h, s, cell, minX, minZ, inv } = this;
    const eps = 1e-5;
    let used = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
      const ux = pos[b] - ax, uy = pos[b + 1] - ay, uz = pos[b + 2] - az;
      const vx = pos[c] - ax, vy = pos[c + 1] - ay, vz = pos[c + 2] - az;
      // normal = u x v
      const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx;
      const len = Math.sqrt(nX * nX + nY * nY + nZ * nZ);
      if (len < 1e-10 || Math.abs(nY) < minNy * len) continue;
      const det = ux * vz - vx * uz; // 2D (xz) doubled area
      if (Math.abs(det) < 1e-10) continue;
      const invDet = 1 / det;
      const x0 = Math.min(ax, ax + ux, ax + vx), x1 = Math.max(ax, ax + ux, ax + vx);
      const z0 = Math.min(az, az + uz, az + vz), z1 = Math.max(az, az + uz, az + vz);
      const i0 = Math.max(0, Math.ceil((x0 - minX) * inv - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((x1 - minX) * inv - 0.5));
      const j0 = Math.max(0, Math.ceil((z0 - minZ) * inv - 0.5));
      const j1 = Math.min(nz - 1, Math.floor((z1 - minZ) * inv - 0.5));
      if (i0 > i1 || j0 > j1) continue;
      used++;
      const by = uy, cy = vy;
      for (let j = j0; j <= j1; j++) {
        const pz = minZ + (j + 0.5) * cell - az;
        const row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const px = minX + (i + 0.5) * cell - ax;
          const w1 = (px * vz - vx * pz) * invDet;
          if (w1 < -eps) continue;
          const w2 = (ux * pz - px * uz) * invDet;
          if (w2 < -eps || w1 + w2 > 1 + eps) continue;
          let v = Math.round((ay + w1 * by + w2 * cy) * 100);
          if (v > 32767) v = 32767;
          else if (v < -32767) v = -32767;
          const k = row + i;
          if (v > h[k]) {
            h[k] = v;
            s[k] = sid;
          }
        }
      }
    }
    return used;
  }

  /** Nearest-cell index or -1 outside the grid. */
  cellIndex(x: number, z: number): number {
    const i = Math.floor((x - this.minX) * this.inv);
    const j = Math.floor((z - this.minZ) * this.inv);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  /** Height of the nearest cell in metres, or null when it holds no data. */
  rawHeightAt(x: number, z: number): number | null {
    const k = this.cellIndex(x, z);
    if (k < 0 || this.h[k] === NO_DATA) return null;
    return this.h[k] * 0.01;
  }

  /** Surface id of the nearest cell (0 = none). */
  surfaceIdAt(x: number, z: number): number {
    const k = this.cellIndex(x, z);
    return k < 0 ? 0 : this.s[k];
  }

  /** Bilinearly interpolated height (m) over valid cells; `fallback` where there is no data. */
  heightAt(x: number, z: number, fallback = 0): number {
    const fx = (x - this.minX) * this.inv - 0.5;
    const fz = (z - this.minZ) * this.inv - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < -1 || j < -1 || i >= this.nx || j >= this.nz) return fallback;
    const tx = fx - i, tz = fz - j;
    let sum = 0, wsum = 0;
    for (let dj = 0; dj < 2; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= this.nz) continue;
      const wz = dj ? tz : 1 - tz;
      for (let di = 0; di < 2; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= this.nx) continue;
        const v = this.h[jj * this.nx + ii];
        if (v === NO_DATA) continue;
        const w = wz * (di ? tx : 1 - tx) + 1e-6;
        sum += v * w;
        wsum += w;
      }
    }
    return wsum > 0 ? (sum / wsum) * 0.01 : fallback;
  }

  /**
   * Fills the building bit mask from footprint rings (scanline, cell centres inside the ring,
   * even-odd rule; open or closed rings). Returns the number of cells marked.
   */
  rasterizeFootprints(rings: readonly (readonly (readonly [number, number])[])[]): number {
    const { nx, nz, cell, minX, minZ, inv } = this;
    const bits = this.b ?? (this.b = new Uint8Array((nx * nz + 7) >> 3));
    const xs: number[] = [];
    let marked = 0;
    for (const ring of rings) {
      let n = ring.length;
      if (n < 3) continue;
      if (ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--; // closed ring
      if (n < 3) continue;
      let z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < n; k++) {
        const z = ring[k][1];
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const j0 = Math.max(0, Math.ceil((z0 - minZ) * inv - 0.5));
      const j1 = Math.min(nz - 1, Math.floor((z1 - minZ) * inv - 0.5));
      for (let j = j0; j <= j1; j++) {
        const zc = minZ + (j + 0.5) * cell;
        xs.length = 0;
        for (let k = 0, p = n - 1; k < n; p = k++) {
          const za = ring[p][1], zb = ring[k][1];
          if ((za <= zc && zc < zb) || (zb <= zc && zc < za)) {
            const xa = ring[p][0], xb = ring[k][0];
            xs.push(xa + ((zc - za) / (zb - za)) * (xb - xa));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        const row = j * nx;
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((xs[q] - minX) * inv - 0.5));
          const i1 = Math.min(nx - 1, Math.floor((xs[q + 1] - minX) * inv - 0.5));
          for (let i = i0; i <= i1; i++) {
            const k = row + i;
            const m = 1 << (k & 7);
            if (!(bits[k >> 3] & m)) {
              bits[k >> 3] |= m;
              marked++;
            }
          }
        }
      }
    }
    return marked;
  }

  /** True when the nearest cell lies inside a building footprint (false outside the grid). */
  insideBuilding(x: number, z: number): boolean {
    const b = this.b;
    if (!b) return false;
    const k = this.cellIndex(x, z);
    return k >= 0 && (b[k >> 3] & (1 << (k & 7))) !== 0;
  }

  /** Approximate memory use in bytes. */
  get bytes(): number {
    return this.h.byteLength + this.s.byteLength + (this.b?.byteLength ?? 0);
  }
}
