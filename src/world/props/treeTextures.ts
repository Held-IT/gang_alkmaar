// Procedural foliage atlas and bark textures for the trees (canvas 2D at runtime).
//
// Leaf atlas (1024 x 1024, 2 x 2 cells, v = 0 at the bottom):
//   cell 0 (top-left)     linden twig spray (heart-shaped leaves on twigs)
//   cell 1 (top-right)    dense linden foliage clump (crown filler)
//   cell 2 (bottom-left)  ornamental tree clump (smaller oval leaves, lighter)
//   cell 3 (bottom-right) conifer needle spray
import * as THREE from 'three';
import { Rng } from './util/rng';
import { canvasToTexture, heightToNormalMap, makeCanvas } from './util/textures';

export const LEAF_CELLS = 2;
/** UV rect [u0, v0, u1, v1] of an atlas cell. */
export function leafCellRect(cell: number): [number, number, number, number] {
  const cx = cell % 2;
  const cy = Math.floor(cell / 2);
  // canvas row 0 (top) => v in [0.5, 1]
  const u0 = cx * 0.5;
  const v0 = cy === 0 ? 0.5 : 0;
  return [u0 + 0.002, v0 + 0.002, u0 + 0.498, v0 + 0.498];
}

type HSL = [number, number, number];
const hsl = (c: HSL, a = 1) => `hsla(${c[0].toFixed(1)},${c[1].toFixed(1)}%,${c[2].toFixed(1)}%,${a})`;

function drawHeartLeaf(ctx: CanvasRenderingContext2D, len: number, width: number, col: HSL, rng: Rng): void {
  // petiole
  ctx.strokeStyle = hsl([col[0] - 10, col[1] * 0.7, col[2] * 0.8]);
  ctx.lineWidth = Math.max(1, len * 0.045);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.2);
  ctx.stroke();
  ctx.translate(0, -len * 0.2);
  const asym = rng.range(-0.08, 0.08);
  const g = ctx.createLinearGradient(-width * 0.5, 0, width * 0.4, -len);
  g.addColorStop(0, hsl([col[0] - 3, col[1], col[2] * 0.82]));
  g.addColorStop(0.55, hsl(col));
  g.addColorStop(1, hsl([col[0] + 5, col[1] * 1.05, col[2] * 1.18]));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.07);
  ctx.bezierCurveTo(-width * 0.22, len * 0.07, -width * (0.62 + asym), -len * 0.02, -width * (0.56 + asym), -len * 0.38);
  ctx.bezierCurveTo(-width * 0.5, -len * 0.68, -width * 0.18, -len * 0.86, 0, -len);
  ctx.bezierCurveTo(width * 0.18, -len * 0.86, width * (0.5 - asym), -len * 0.68, width * (0.56 - asym), -len * 0.38);
  ctx.bezierCurveTo(width * (0.62 - asym), -len * 0.02, width * 0.22, len * 0.07, 0, -len * 0.07);
  ctx.fill();
  // midrib and side veins
  ctx.strokeStyle = hsl([col[0] + 8, col[1] * 0.6, Math.min(80, col[2] * 1.45)], 0.55);
  ctx.lineWidth = Math.max(0.6, len * 0.022);
  ctx.beginPath();
  ctx.moveTo(0, -len * 0.04);
  ctx.lineTo(0, -len * 0.93);
  for (let k = 1; k <= 3; k++) {
    const y = -len * (0.18 + k * 0.17);
    ctx.moveTo(0, y);
    ctx.lineTo(-width * 0.33, y - len * 0.12);
    ctx.moveTo(0, y);
    ctx.lineTo(width * 0.33, y - len * 0.12);
  }
  ctx.stroke();
}

function drawOvalLeaf(ctx: CanvasRenderingContext2D, len: number, width: number, col: HSL): void {
  ctx.strokeStyle = hsl([col[0] - 10, col[1] * 0.7, col[2] * 0.75]);
  ctx.lineWidth = Math.max(1, len * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.15);
  ctx.stroke();
  ctx.translate(0, -len * 0.15);
  const g = ctx.createLinearGradient(-width * 0.5, 0, width * 0.5, -len);
  g.addColorStop(0, hsl([col[0], col[1], col[2] * 0.85]));
  g.addColorStop(1, hsl([col[0] + 6, col[1], col[2] * 1.2]));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-width * 0.6, -len * 0.15, -width * 0.55, -len * 0.75, 0, -len);
  ctx.bezierCurveTo(width * 0.55, -len * 0.75, width * 0.6, -len * 0.15, 0, 0);
  ctx.fill();
  ctx.strokeStyle = hsl([col[0] + 8, col[1] * 0.6, Math.min(80, col[2] * 1.4)], 0.45);
  ctx.lineWidth = Math.max(0.6, len * 0.025);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.9);
  ctx.stroke();
}

function leafColor(rng: Rng, base: HSL, depth: number): HSL {
  // depth 0 = inner/back (darker), 1 = outer/front (lighter)
  const l = base[2] * (0.68 + 0.42 * depth) * rng.range(0.85, 1.15);
  return [base[0] + rng.range(-7, 7), base[1] * rng.range(0.85, 1.12), l];
}

function twigSpray(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng, base: HSL): void {
  ctx.save();
  ctx.translate(ox, oy);
  const S = size / 512;
  // stems: main + side twigs, as polylines
  const twigs: { pts: [number, number][]; w: number }[] = [];
  const main: [number, number][] = [];
  let x = 256 + rng.range(-10, 10), y = 505, ang = -Math.PI / 2 + rng.range(-0.15, 0.15);
  for (let i = 0; i < 12; i++) {
    main.push([x, y]);
    ang += rng.range(-0.12, 0.12);
    x += Math.cos(ang) * 38;
    y += Math.sin(ang) * 38;
  }
  twigs.push({ pts: main, w: 5 });
  for (let k = 0; k < 8; k++) {
    const i = 2 + Math.floor(k * 1.1);
    const p = main[Math.min(i, main.length - 1)];
    const side = k % 2 === 0 ? -1 : 1;
    let a = -Math.PI / 2 + side * rng.range(0.6, 1.05);
    let tx = p[0], ty = p[1];
    const pts: [number, number][] = [[tx, ty]];
    const segs = 4 + rng.int(0, 2);
    for (let s = 0; s < segs; s++) {
      a += rng.range(-0.15, 0.15) - side * 0.08;
      tx += Math.cos(a) * 30;
      ty += Math.sin(a) * 30;
      pts.push([tx, ty]);
    }
    twigs.push({ pts, w: 3 });
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.scale(S, S);
  for (const t of twigs) {
    ctx.strokeStyle = '#4a3f33';
    ctx.lineWidth = t.w;
    ctx.beginPath();
    t.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
  }
  // leaves along twigs (back layer darker, then front)
  for (const layer of [0, 1]) {
    for (const t of twigs) {
      for (let i = 1; i < t.pts.length; i++) {
        const [ax, ay] = t.pts[i - 1];
        const [bx, by] = t.pts[i];
        const dir = Math.atan2(by - ay, bx - ax);
        for (const side of [-1, 1]) {
          if (rng.chance(layer === 0 ? 0.35 : 0.2)) continue;
          const f = rng.range(0.2, 0.9);
          const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(dir + Math.PI / 2 + side * rng.range(0.6, 1.2) + (layer === 0 ? rng.range(-0.4, 0.4) : 0));
          const len = rng.range(44, 60);
          drawHeartLeaf(ctx, len, len * rng.range(0.78, 0.92), leafColor(rng, base, layer === 0 ? 0.25 : 0.85), rng);
          ctx.restore();
        }
      }
      // terminal leaf
      const e = t.pts[t.pts.length - 1];
      const p = t.pts[t.pts.length - 2];
      ctx.save();
      ctx.translate(e[0], e[1]);
      ctx.rotate(Math.atan2(e[1] - p[1], e[0] - p[0]) + Math.PI / 2);
      const len = rng.range(48, 62);
      drawHeartLeaf(ctx, len, len * 0.85, leafColor(rng, base, 0.9), rng);
      ctx.restore();
    }
  }
  ctx.restore();
}

function clump(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  size: number,
  rng: Rng,
  base: HSL,
  count: number,
  leaf: 'heart' | 'oval',
  lenRange: [number, number],
): void {
  ctx.save();
  ctx.translate(ox, oy);
  const S = size / 512;
  ctx.scale(S, S);
  // a few twigs visible inside
  ctx.strokeStyle = '#43392f';
  ctx.lineCap = 'round';
  for (let k = 0; k < 7; k++) {
    ctx.lineWidth = rng.range(2, 4);
    ctx.beginPath();
    let x = 256 + rng.range(-40, 40), y = 470;
    ctx.moveTo(x, y);
    let a = -Math.PI / 2 + rng.range(-0.9, 0.9);
    for (let s = 0; s < 6; s++) {
      a += rng.range(-0.2, 0.2);
      x += Math.cos(a) * 35;
      y += Math.sin(a) * 35;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let i = 0; i < count; i++) {
    const depth = i / count; // later = front, lighter
    // ragged round clump: radius with angular noise, denser in the middle
    const a = rng.range(0, Math.PI * 2);
    const rr = Math.sqrt(rng.next()) * (205 + 25 * Math.sin(a * 5 + 1.3) + 15 * Math.sin(a * 9));
    const x = 256 + Math.cos(a) * rr;
    const y = 262 + Math.sin(a) * rr * 0.95;
    ctx.save();
    ctx.translate(x, y);
    // leaves point outward with randomness
    ctx.rotate(a + Math.PI / 2 + rng.range(-0.9, 0.9));
    const len = rng.range(lenRange[0], lenRange[1]);
    const col = leafColor(rng, base, 0.15 + depth * 0.85);
    if (leaf === 'heart') drawHeartLeaf(ctx, len, len * rng.range(0.78, 0.92), col, rng);
    else drawOvalLeaf(ctx, len, len * rng.range(0.5, 0.62), col);
    ctx.restore();
  }
  ctx.restore();
}

function needleSpray(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(size / 512, size / 512);
  ctx.lineCap = 'round';
  const branches: [number, number, number, number][] = [];
  // main axis from bottom centre upward, side shoots
  let x = 256, y = 500, a = -Math.PI / 2;
  const axis: [number, number][] = [];
  for (let i = 0; i < 14; i++) {
    axis.push([x, y]);
    a += rng.range(-0.08, 0.08);
    x += Math.cos(a) * 34;
    y += Math.sin(a) * 34;
  }
  for (let i = 1; i < axis.length; i++) branches.push([axis[i - 1][0], axis[i - 1][1], axis[i][0], axis[i][1]]);
  for (let k = 1; k < 13; k++) {
    for (const side of [-1, 1]) {
      const [px, py] = axis[k];
      const len = (200 - k * 12) * rng.range(0.7, 1.0);
      let bx = px, by = py, ba = -Math.PI / 2 + side * rng.range(0.9, 1.3);
      for (let s = 0; s < 4; s++) {
        const nx = bx + Math.cos(ba) * len / 4, ny = by + Math.sin(ba) * len / 4;
        branches.push([bx, by, nx, ny]);
        bx = nx; by = ny;
        ba -= side * 0.08;
      }
    }
  }
  for (const [x0, y0, x1, y1] of branches) {
    ctx.strokeStyle = '#3b3326';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    const d = Math.atan2(y1 - y0, x1 - x0);
    const segLen = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.floor(segLen / 3.2);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
      for (const side of [-1, 1]) {
        const na = d + side * rng.range(0.7, 1.1) - 0.25;
        const nl = rng.range(16, 24);
        const l = rng.range(17, 30);
        ctx.strokeStyle = `hsl(${rng.range(115, 140).toFixed(0)},${rng.range(25, 40).toFixed(0)}%,${l.toFixed(0)}%)`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

let atlas: THREE.DataTexture | null = null;

/** The shared leaf atlas (sRGB, mipmapped, colour-bled). */
export function getLeafAtlas(anisotropy = 4): THREE.DataTexture {
  if (atlas) return atlas;
  const { canvas, ctx } = makeCanvas(1024, 1024);
  const rng = new Rng(1337);
  const linden: HSL = [92, 36, 32];
  twigSpray(ctx, 0, 0, 512, rng, linden);
  clump(ctx, 512, 0, 512, rng, [94, 34, 30], 340, 'heart', [40, 56]);
  clump(ctx, 0, 512, 512, rng, [84, 40, 33], 420, 'oval', [30, 44]);
  needleSpray(ctx, 512, 512, 512, rng);
  atlas = canvasToTexture(canvas, { bleed: 'auto', srgb: true, anisotropy });
  atlas.name = 'leafAtlas';
  return atlas;
}

let bark: { map: THREE.DataTexture; normal: THREE.DataTexture } | null = null;

/** Grey-brown furrowed bark (tiling; u around the trunk, v along it; 1 tile = 0.6 x 2 m). */
export function getBarkTextures(anisotropy = 4): { map: THREE.DataTexture; normal: THREE.DataTexture } {
  if (bark) return bark;
  const W = 256, H = 512;
  const rng = new Rng(4242);
  // anisotropic tileable noise: few cells vertically, many horizontally -> vertical furrows
  const mk = (gx: number, gy: number, seed: number) => {
    const r = new Rng(seed);
    const g = new Float32Array(gx * gy);
    for (let i = 0; i < g.length; i++) g[i] = r.next();
    return (u: number, v: number) => {
      const fx = u * gx, fy = v * gy;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const xa = ((x0 % gx) + gx) % gx, xb = (xa + 1) % gx;
      const ya = ((y0 % gy) + gy) % gy, yb = (ya + 1) % gy;
      const a = g[ya * gx + xa], b = g[ya * gx + xb], c = g[yb * gx + xa], d = g[yb * gx + xb];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const n1 = mk(14, 3, 11), n2 = mk(28, 6, 12), n3 = mk(56, 24, 13), n4 = mk(8, 8, 14), warp = mk(6, 4, 15);
  const height = new Float32Array(W * H);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const wu = u + (warp(u, v) - 0.5) * 0.08;
      const ridge = 1 - Math.abs(n1(wu, v) * 2 - 1);
      const ridge2 = 1 - Math.abs(n2(wu, v) * 2 - 1);
      let h = Math.pow(ridge, 1.6) * 0.6 + Math.pow(ridge2, 2) * 0.3 + n3(u, v) * 0.1;
      // horizontal cracks across the plates
      h -= Math.max(0, n3(u * 0.5, v * 2) - 0.8) * 0.8;
      height[y * W + x] = h;
      const lichen = Math.max(0, n4(u, v) - 0.62) * 2.2;
      const k = 0.35 + h * 0.85;
      let r = 92 * k, g = 82 * k, b = 72 * k;
      r = r * (1 - lichen) + 108 * k * lichen;
      g = g * (1 - lichen) + 116 * k * lichen;
      b = b * (1 - lichen) + 84 * k * lichen;
      const j = rng.range(-6, 6);
      const i = (y * W + x) * 4;
      data[i] = Math.max(0, Math.min(255, r + j));
      data[i + 1] = Math.max(0, Math.min(255, g + j));
      data[i + 2] = Math.max(0, Math.min(255, b + j));
      data[i + 3] = 255;
    }
  }
  const map = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = anisotropy;
  map.needsUpdate = true;
  const normal = heightToNormalMap(height, W, H, 6, anisotropy);
  bark = { map, normal };
  return bark;
}
