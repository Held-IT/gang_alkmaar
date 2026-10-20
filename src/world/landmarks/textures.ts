// Procedural fallback textures for the landmarks (used when the MaterialLibrary has no CC0 set):
// dark tarred brick, reed thatch, weathered wood, and the Alkmaar flag.
import * as THREE from 'three';
import { Rng } from '../props/util/rng';
import { canvasToTexture, heightToNormalMap, makeCanvas, makeFbm } from '../props/util/textures';

export interface TexPair { map: THREE.Texture; normal: THREE.Texture | null; /** metres per texture tile (u, v) */ tile: [number, number] }

let brick: TexPair | null = null;
/** Dark (tarred) Dutch brick in running bond. One tile = 1.1 m x 1.0 m (5 bricks x 16 courses). */
export function getTarredBrick(): TexPair {
  if (brick) return brick;
  const W = 512, H = 512;
  const rng = new Rng(77);
  const fbm = makeFbm(8, 4, 31);
  const data = new Uint8Array(W * H * 4);
  const height = new Float32Array(W * H);
  const courses = 16, perRow = 5;
  const ch = H / courses, bw = W / perRow;
  const tones: number[] = [];
  for (let i = 0; i < courses * perRow * 2; i++) tones.push(rng.range(0.75, 1.2));
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / ch);
    const fy = (y % ch) / ch;
    const shift = row % 2 ? bw / 2 : 0;
    for (let x = 0; x < W; x++) {
      const xx = (x + shift) % W;
      const col = Math.floor(xx / bw);
      const fx = (xx % bw) / bw;
      const mortar = fy < 0.16 || fx < 0.045;
      const n = fbm(x / W, y / H);
      const tone = tones[(row * perRow + col) % tones.length];
      let r: number, g: number, b: number, h: number;
      if (mortar) {
        const m = 70 + n * 30;
        r = m; g = m * 0.97; b = m * 0.92; h = 0.15 + n * 0.1;
      } else {
        const k = tone * (0.75 + n * 0.5);
        r = 58 * k; g = 42 * k; b = 36 * k;
        h = 0.75 + n * 0.25 - Math.pow(Math.abs(fx - 0.5) * 2, 8) * 0.2;
      }
      const i = (y * W + x) * 4;
      data[i] = Math.min(255, r); data[i + 1] = Math.min(255, g); data[i + 2] = Math.min(255, b); data[i + 3] = 255;
      height[y * W + x] = h;
    }
  }
  const map = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 8;
  map.needsUpdate = true;
  brick = { map, normal: heightToNormalMap(height, W, H, 3.5, 8), tile: [1.1, 1.0] };
  return brick;
}

let thatch: TexPair | null = null;
/** Grey-brown reed thatch (fibres along v). One tile = 1.2 m x 1.2 m. */
export function getThatch(): TexPair {
  if (thatch) return thatch;
  const W = 256, H = 512;
  const { canvas, ctx } = makeCanvas(W, H);
  const rng = new Rng(5);
  ctx.fillStyle = '#7a6d58';
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 5200; i++) {
    const x = rng.range(0, W), y = rng.range(-40, H);
    const len = rng.range(30, 110);
    const l = rng.range(30, 62);
    ctx.strokeStyle = `hsla(${rng.range(30, 45).toFixed(0)},${rng.range(14, 30).toFixed(0)}%,${l.toFixed(0)}%,0.8)`;
    ctx.lineWidth = rng.range(0.8, 2.0);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + rng.range(-3, 3), y + len);
    ctx.stroke();
  }
  // wrap the fibres that cross the bottom edge so the tile repeats
  const img = ctx.getImageData(0, 0, W, H);
  const height = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    height[(H - 1 - y) * W + x] = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 765;
  }
  const map = canvasToTexture(canvas, { srgb: true, repeat: true, anisotropy: 8 });
  thatch = { map, normal: heightToNormalMap(height, W, H, 2.5, 8), tile: [0.6, 1.2] };
  return thatch;
}

let flagTex: THREE.DataTexture | null = null;
/**
 * Alkmaar flag: six horizontal bands alternating white and red (white on top), with a red canton
 * three bands high in the hoist showing the white castle from the city arms.
 */
export function getAlkmaarFlag(): THREE.DataTexture {
  if (flagTex) return flagTex;
  const W = 384, H = 256;
  const { canvas, ctx } = makeCanvas(W, H);
  const red = '#c8102e', white = '#f7f7f4';
  const bh = H / 6;
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 === 0 ? white : red;
    ctx.fillRect(0, i * bh, W, bh + 1);
  }
  const cw = W * 0.4, chh = bh * 3;
  ctx.fillStyle = red;
  ctx.fillRect(0, 0, cw, chh);
  // castle: wall with gate and three towers
  ctx.fillStyle = white;
  const cx = cw / 2, base = chh * 0.86, s = chh / 128;
  ctx.fillRect(cx - 36 * s, base - 46 * s, 72 * s, 46 * s); // wall
  ctx.fillRect(cx - 44 * s, base - 72 * s, 20 * s, 72 * s); // left tower
  ctx.fillRect(cx + 24 * s, base - 72 * s, 20 * s, 72 * s); // right tower
  ctx.fillRect(cx - 11 * s, base - 88 * s, 22 * s, 42 * s); // middle tower
  for (const [tx, tw, ty] of [[-44, 20, -72], [24, 20, -72], [-11, 22, -88]] as [number, number, number][]) {
    for (let k = 0; k < 3; k++) ctx.fillRect(cx + (tx + k * (tw / 3)) * s, base + (ty - 7) * s, (tw / 3 - 2) * s, 8 * s);
  }
  ctx.fillStyle = red;
  ctx.beginPath();
  ctx.arc(cx, base - 16 * s, 9 * s, Math.PI, 0);
  ctx.lineTo(cx + 9 * s, base);
  ctx.lineTo(cx - 9 * s, base);
  ctx.fill();
  for (const tx of [-37, 31, -3]) ctx.fillRect(cx + tx * s, base - 58 * s, 6 * s, 9 * s);
  flagTex = canvasToTexture(canvas, { srgb: true, anisotropy: 4 });
  return flagTex;
}
