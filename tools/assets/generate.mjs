#!/usr/bin/env node
// Generates procedural, perfectly tileable textures for the materials module:
//
//   public/assets/textures/water/normal.png  canal ripple normal map (OpenGL convention), 1024^2
//   public/assets/textures/noise/noise.png   RGBA macro noise (4 octaves of periodic gradient noise), 512^2
//
//   node tools/assets/generate.mjs
//
// Water: sum of ~300 sinusoids with integer wave vectors on the unit torus (=> seamless tiling),
// amplitudes from a wind-biased spectrum, normals from the analytic derivatives. PNG (not JPEG)
// because block artefacts in smooth normals are very visible on a mirror-like surface.
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(root, 'public/assets/textures');

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function waterNormal() {
  const N = 1024;
  const rand = rng(1234);
  const waves = [];
  const wind = Math.atan2(0.35, 1);
  for (let i = 0; i < 640; i++) {
    // log-distributed frequency, integer wave vector => tileable
    const f = Math.exp(Math.log(4) + rand() * (Math.log(110) - Math.log(4)));
    const ang = wind + (rand() - 0.5) * Math.PI * 1.3;
    const kx = Math.round(Math.cos(ang) * f);
    const ky = Math.round(Math.sin(ang) * f);
    if (kx === 0 && ky === 0) continue;
    const k = Math.hypot(kx, ky);
    const dirW = (0.35 + 0.65 * Math.pow(Math.max(0, Math.cos(Math.atan2(ky, kx) - wind)), 2));
    // height ~ k^-1.75 (slope ~ k^-0.75): small ripples still carry visible slope
    const amp = (dirW * Math.pow(k, -1.75)) * (0.6 + rand() * 0.8);
    waves.push({ kx, ky, amp, ph: rand() * Math.PI * 2 });
  }
  const dx = new Float32Array(N * N);
  const dy = new Float32Array(N * N);
  const TWO_PI = Math.PI * 2;
  for (const w of waves) {
    const ax = w.amp * TWO_PI * w.kx;
    const ay = w.amp * TWO_PI * w.ky;
    // precompute separable phase tables: cos(a + b) = cos a cos b - sin a sin b
    const cx = new Float32Array(N); const sx = new Float32Array(N);
    const cy = new Float32Array(N); const sy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const px = TWO_PI * w.kx * i / N + w.ph;
      const py = TWO_PI * w.ky * i / N;
      cx[i] = Math.cos(px); sx[i] = Math.sin(px);
      cy[i] = Math.cos(py); sy[i] = Math.sin(py);
    }
    for (let y = 0; y < N; y++) {
      const cyy = cy[y]; const syy = sy[y];
      const row = y * N;
      for (let x = 0; x < N; x++) {
        const c = cx[x] * cyy - sx[x] * syy; // cos(phase)
        dx[row + x] += ax * c;
        dy[row + x] += ay * c;
      }
    }
  }
  // normalise the RMS slope (calm canal water: mostly gentle ripples, some steeper ones)
  let sum2 = 0;
  for (let i = 0; i < N * N; i++) sum2 += dx[i] * dx[i] + dy[i] * dy[i];
  const scale = 0.45 / Math.sqrt(sum2 / (N * N));
  const out = Buffer.alloc(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    // height h(x,y): normal = normalize(-dh/dx, -dh/dy, 1); image y axis points down, GL +Y up.
    let nx = -dx[i] * scale;
    let ny = dy[i] * scale;
    let nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    out[i * 3] = Math.round((nx * 0.5 + 0.5) * 255);
    out[i * 3 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    out[i * 3 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
  mkdirSync(resolve(OUT, 'water'), { recursive: true });
  await sharp(out, { raw: { width: N, height: N, channels: 3 } }).png({ compressionLevel: 9 }).toFile(resolve(OUT, 'water/normal.png'));
  console.log('water/normal.png', waves.length, 'waves');
}

/** Periodic 2D gradient noise with `cells` lattice cells across the texture. */
function makePerlin(cells, seed) {
  const rand = rng(seed);
  const g = new Float32Array(cells * cells * 2);
  for (let i = 0; i < cells * cells; i++) {
    const a = rand() * Math.PI * 2;
    g[i * 2] = Math.cos(a); g[i * 2 + 1] = Math.sin(a);
  }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (u, v) => { // u, v in [0,1)
    const x = u * cells; const y = v * cells;
    const x0 = Math.floor(x); const y0 = Math.floor(y);
    const fx = x - x0; const fy = y - y0;
    const dot = (ix, iy, ox, oy) => {
      const k = (((iy % cells) + cells) % cells) * cells + (((ix % cells) + cells) % cells);
      return g[k * 2] * ox + g[k * 2 + 1] * oy;
    };
    const n00 = dot(x0, y0, fx, fy);
    const n10 = dot(x0 + 1, y0, fx - 1, fy);
    const n01 = dot(x0, y0 + 1, fx, fy - 1);
    const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const sx = fade(fx); const sy = fade(fy);
    return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
  };
}

async function macroNoise() {
  const N = 512;
  // Each channel: fBm (3 octaves) starting at a different base frequency.
  const bases = [4, 8, 16, 32];
  const chans = bases.map((b, c) => [makePerlin(b, 11 + c * 7), makePerlin(b * 2, 101 + c * 7), makePerlin(b * 4, 211 + c * 7)]);
  const out = Buffer.alloc(N * N * 4);
  const vals = bases.map(() => new Float32Array(N * N));
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N; const v = y / N;
      for (let c = 0; c < 4; c++) {
        const [a, b, d] = chans[c];
        vals[c][y * N + x] = a(u, v) + 0.5 * b(u, v) + 0.25 * d(u, v);
      }
    }
  }
  for (let c = 0; c < 4; c++) {
    // normalise each channel to [0,1] using its own range (roughly uniform-ish distribution)
    let mn = Infinity; let mx = -Infinity;
    for (const v of vals[c]) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    for (let i = 0; i < N * N; i++) out[i * 4 + c] = Math.round(((vals[c][i] - mn) / (mx - mn)) * 255);
  }
  mkdirSync(resolve(OUT, 'noise'), { recursive: true });
  await sharp(out, { raw: { width: N, height: N, channels: 4 } }).png({ compressionLevel: 9 }).toFile(resolve(OUT, 'noise/noise.png'));
  console.log('noise/noise.png');
}

await waterNormal();
await macroNoise();
