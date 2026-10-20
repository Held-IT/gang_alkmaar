// Runtime-generated textures (canvas 2D) for props: helpers to turn canvases into GPU textures
// with proper colour space, mipmaps and colour bleeding for alpha-tested atlases.
import * as THREE from 'three';
import { mulberry32 } from './rng';

export function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context niet beschikbaar');
  return { canvas, ctx };
}

export interface TexOptions {
  srgb?: boolean;
  /** For alpha textures: RGB written into fully transparent texels (avoids dark mip fringes). */
  bleed?: [number, number, number] | 'auto';
  repeat?: boolean;
  mipmaps?: boolean;
  anisotropy?: number;
}

/**
 * Convert a canvas into a DataTexture (rows flipped so v = 0 is the bottom of the canvas),
 * optionally bleeding colour into transparent texels.
 */
export function canvasToTexture(canvas: HTMLCanvasElement, opts: TexOptions = {}): THREE.DataTexture {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  let bleed: [number, number, number] | null = null;
  if (opts.bleed === 'auto') {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < src.length; i += 16) {
      if (src[i + 3] > 200) { r += src[i]; g += src[i + 1]; b += src[i + 2]; n++; }
    }
    bleed = n ? [r / n, g / n, b / n] : [0, 0, 0];
  } else if (opts.bleed) bleed = opts.bleed;
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++) {
      const si = (sy * w + x) * 4;
      const di = (y * w + x) * 4;
      const a = src[si + 3];
      if (bleed && a < 8) {
        out[di] = bleed[0]; out[di + 1] = bleed[1]; out[di + 2] = bleed[2]; out[di + 3] = a;
      } else {
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = a;
      }
    }
  }
  if (bleed) dilate(out, w, h, 4);
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  finishTexture(tex, opts);
  return tex;
}

/** Spread opaque colours into transparent neighbours (keeps alpha) so mips don't fringe. */
function dilate(data: Uint8Array, w: number, h: number, passes: number): void {
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = data[i * 4 + 3] >= 8 ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = filled.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!filled[j]) continue;
            r += data[j * 4]; g += data[j * 4 + 1]; b += data[j * 4 + 2]; n++;
          }
        }
        if (n) {
          data[i * 4] = r / n; data[i * 4 + 1] = g / n; data[i * 4 + 2] = b / n;
          next[i] = 1;
        }
      }
    }
    filled.set(next);
  }
}

function finishTexture(tex: THREE.Texture, opts: TexOptions): void {
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  if (opts.mipmaps !== false) {
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
  } else {
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
  }
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.flipY = false;
  tex.needsUpdate = true;
}

/** Build a tangent-space normal map from a height field (0..1), tiling. */
export function heightToNormalMap(height: Float32Array, w: number, h: number, strength: number, anisotropy = 4): THREE.DataTexture {
  const out = new Uint8Array(w * h * 4);
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      // rows already in texture order (y = 0 is v = 0)
      const i = (y * w + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  finishTexture(tex, { srgb: false, repeat: true, anisotropy });
  return tex;
}

/** Tileable value noise (grid size `cells`) sampled at (x, y) in [0, 1). */
export function makeTileNoise(cells: number, seed: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const s = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const fx = (((x % 1) + 1) % 1) * cells, fy = (((y % 1) + 1) % 1) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = s(fx - x0), ty = s(fy - y0);
    const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
    const a = grid[y0 * cells + x0], b = grid[y0 * cells + x1];
    const c = grid[y1 * cells + x0], d = grid[y1 * cells + x1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

/** Fractal tileable noise in [0, 1). */
export function makeFbm(baseCells: number, octaves: number, seed: number): (x: number, y: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) => makeTileNoise(baseCells << i, seed + i * 101));
  return (x, y) => {
    let v = 0, amp = 0.5, sum = 0;
    for (const f of layers) {
      v += f(x, y) * amp;
      sum += amp;
      amp *= 0.5;
    }
    return v / sum;
  };
}

/** RGBA DataTexture directly from a pixel generator (v = 0 is the bottom row). */
export function generateTexture(
  w: number,
  h: number,
  fn: (u: number, v: number) => [number, number, number, number?],
  opts: TexOptions = {},
): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn((x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = c[3] ?? 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  finishTexture(tex, opts);
  return tex;
}

let grungeTex: THREE.DataTexture | null = null;
/**
 * Shared subtle grunge/detail texture (sRGB, mean ~0.9) multiplied onto all prop surfaces so
 * painted metal and wood never look perfectly flat. Tiling; props use metric-ish UVs.
 */
export function getGrungeTexture(): THREE.DataTexture {
  if (grungeTex) return grungeTex;
  const fbm = makeFbm(4, 5, 77);
  const fine = makeTileNoise(64, 9);
  grungeTex = generateTexture(256, 256, (u, v) => {
    const n = fbm(u, v);
    const f = fine(u, v);
    const g = 0.82 + 0.16 * n + 0.05 * f - (n < 0.35 ? (0.35 - n) * 0.5 : 0);
    const c = Math.max(0, Math.min(255, g * 255));
    return [c, c * 0.995, c * 0.985, 255];
  }, { repeat: true, srgb: true });
  return grungeTex;
}
