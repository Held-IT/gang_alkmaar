#!/usr/bin/env node
// Downloads the CC0 sky HDRI from Poly Haven, analyses it and writes the runtime assets:
//   public/assets/hdri/sky_1k.hdr, sky_2k.hdr  (full equirect, as published)
//   public/assets/hdri/sky_4k_top.hdr          (4k, cropped to the upper hemisphere + 10 deg)
//   public/assets/hdri/sky.json                (sun direction, sun / sky irradiance, horizon colours)
//   public/assets/hdri/credits.json
// Raw downloads are cached in data-raw/hdri/<id>/ (treated as untrusted data: only parsed).
//
// Usage: node tools/engine/fetch-hdri.mjs [--id kloofendal_48d_partly_cloudy_puresky] [--azimuth 235] [--force]
//   --azimuth  compass bearing (deg, from north clockwise) where the sun should appear in the game.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHdr, writeHdr } from './hdr.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? true : all[i + 1]] : null)).filter(Boolean),
);
const ID = typeof args.id === 'string' ? args.id : 'kloofendal_48d_partly_cloudy_puresky';
const WORLD_SUN_AZIMUTH_DEG = args.azimuth ? Number(args.azimuth) : 235;
const UA = { 'User-Agent': 'AlkmaarDrive/0.1 (engine asset tool)' };
const rawDir = resolve(root, 'data-raw/hdri', ID);
const outDir = resolve(root, 'public/assets/hdri');
mkdirSync(rawDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function download(url, file, md5) {
  if (existsSync(file) && !args.force) {
    const have = createHash('md5').update(readFileSync(file)).digest('hex');
    if (!md5 || have === md5) { console.log(`cached ${file}`); return; }
  }
  console.log(`download ${url}`);
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = createHash('md5').update(buf).digest('hex');
  if (md5 && got !== md5) throw new Error(`md5 mismatch for ${url}: ${got} != ${md5}`);
  writeFileSync(file, buf);
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Pixel centre -> elevation (rad) / three.js equirect azimuth phi = atan2(z, x) (rad). */
function pixelAngles(x, y, w, h) {
  const u = (x + 0.5) / w;
  const v = (y + 0.5) / h;
  return { el: (0.5 - v) * Math.PI, phi: (u - 0.5) * 2 * Math.PI };
}
function dirFromAngles(el, phi) {
  return [Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi)];
}

function analyse(img) {
  const { width: w, height: h, data } = img;
  const dPhi = (2 * Math.PI) / w;
  const dEl = Math.PI / h;
  // 1. brightest pixel of the upper hemisphere
  let maxL = 0; let mx = 0; let my = 0;
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const l = lum(data[o], data[o + 1], data[o + 2]);
      if (l > maxL) { maxL = l; mx = x; my = y; }
    }
  }
  const peak = pixelAngles(mx, my, w, h);
  const peakDir = dirFromAngles(peak.el, peak.phi);
  const angleTo = (el, phi) => {
    const d = dirFromAngles(el, phi);
    return Math.acos(Math.min(1, d[0] * peakDir[0] + d[1] * peakDir[1] + d[2] * peakDir[2]));
  };
  // 2. robust "brightest sky" level outside a 6 degree disk around the sun
  const samples = [];
  for (let y = 0; y < h / 2; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const a = pixelAngles(x, y, w, h);
      if (angleTo(a.el, a.phi) < (6 * Math.PI) / 180) continue;
      const o = (y * w + x) * 3;
      samples.push(lum(data[o], data[o + 1], data[o + 2]));
    }
  }
  samples.sort((p, q) => p - q);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  const clampL = pct(0.9995) * 1.5;

  // 3. sun: energy above the clamp level within 4 degrees of the peak
  const sunE = [0, 0, 0];
  const cen = [0, 0, 0];
  let sunPixels = 0;
  const yR = Math.ceil((4 / 180) * h) + 2;
  for (let y = Math.max(0, my - yR); y < Math.min(h, my + yR); y++) {
    for (let x = 0; x < w; x++) {
      const a = pixelAngles(x, y, w, h);
      if (angleTo(a.el, a.phi) > (4 * Math.PI) / 180) continue;
      const o = (y * w + x) * 3;
      const l = lum(data[o], data[o + 1], data[o + 2]);
      if (l <= clampL) continue;
      const k = 1 - clampL / l; // fraction of this pixel above the clamp (hue preserved)
      const dO = dPhi * dEl * Math.cos(a.el);
      for (let c = 0; c < 3; c++) sunE[c] += data[o + c] * k * dO;
      const d = dirFromAngles(a.el, a.phi);
      const wgt = (l - clampL) * dO;
      for (let c = 0; c < 3; c++) cen[c] += d[c] * wgt;
      sunPixels++;
    }
  }
  const cl = Math.hypot(cen[0], cen[1], cen[2]) || 1;
  const sunDir = cen.map((c) => c / cl);
  const sunEl = Math.asin(sunDir[1]);
  const sunPhi = Math.atan2(sunDir[2], sunDir[0]);

  // 4. sky irradiance (sun clamped) on a horizontal surface, band colours
  const skyE = [0, 0, 0];
  const band = (lo, hi) => ({ lo: (lo * Math.PI) / 180, hi: (hi * Math.PI) / 180, sum: [0, 0, 0], wsum: 0 });
  const bands = { horizon: band(0.3, 3), low: band(3, 10), mid: band(10, 35), zenith: band(60, 90), below: band(-6, -1) };
  const AZ_BINS = 32;
  const horizonAz = Array.from({ length: AZ_BINS }, () => [0, 0, 0, 0]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = pixelAngles(x, y, w, h);
      const o = (y * w + x) * 3;
      let r = data[o]; let g = data[o + 1]; let b = data[o + 2];
      const l = lum(r, g, b);
      if (l > clampL) { const k = clampL / l; r *= k; g *= k; b *= k; }
      const dO = dPhi * dEl * Math.cos(a.el);
      if (a.el > 0) {
        const cosT = Math.sin(a.el);
        skyE[0] += r * cosT * dO; skyE[1] += g * cosT * dO; skyE[2] += b * cosT * dO;
      }
      for (const bd of Object.values(bands)) {
        if (a.el >= bd.lo && a.el < bd.hi) {
          bd.sum[0] += r * dO; bd.sum[1] += g * dO; bd.sum[2] += b * dO; bd.wsum += dO;
        }
      }
      if (a.el >= bands.horizon.lo && a.el < bands.horizon.hi) {
        const bin = Math.min(AZ_BINS - 1, Math.floor(((a.phi + Math.PI) / (2 * Math.PI)) * AZ_BINS));
        horizonAz[bin][0] += r * dO; horizonAz[bin][1] += g * dO; horizonAz[bin][2] += b * dO; horizonAz[bin][3] += dO;
      }
    }
  }
  const avg = (bd) => bd.sum.map((s) => s / bd.wsum);
  return {
    peak: { x: mx, y: my, luminance: maxL },
    clampLuminance: clampL,
    sunPixels,
    sun: { direction: sunDir, elevationDeg: (sunEl * 180) / Math.PI, phiRad: sunPhi, irradiance: sunE },
    skyIrradianceHorizontal: skyE,
    bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, avg(v)])),
    horizonByAzimuth: horizonAz.map((v) => [v[0] / v[3], v[1] / v[3], v[2] / v[3]]),
    percentiles: { p50: pct(0.5), p99: pct(0.99), p999: pct(0.999), p9995: pct(0.9995) },
  };
}

/** Tone-mapped preview with the detected sun marked (for visual verification). */
async function writePreview(img, res, file) {
  const sharp = (await import('sharp')).default;
  const pw = 1024; const ph = 512;
  const out = Buffer.alloc(pw * ph * 3);
  const exposure = 0.6 / Math.max(1e-6, lum(...res.bands.mid));
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const sx = Math.floor((x / pw) * img.width);
      const sy = Math.floor((y / ph) * img.height);
      const o = (sy * img.width + sx) * 3;
      for (let c = 0; c < 3; c++) {
        const v = img.data[o + c] * exposure;
        out[(y * pw + x) * 3 + c] = Math.round(255 * Math.pow(v / (1 + v), 1 / 2.2));
      }
    }
  }
  // cross-hair at the detected sun
  const su = res.sun.phiRad / (2 * Math.PI) + 0.5;
  const sv = 0.5 - Math.asin(res.sun.direction[1]) / Math.PI;
  const cx = Math.round(su * pw); const cy = Math.round(sv * ph);
  for (let k = -14; k <= 14; k++) {
    for (const [px, py] of [[cx + k, cy], [cx, cy + k]]) {
      if (px < 0 || py < 0 || px >= pw || py >= ph || Math.abs(k) < 4) continue;
      const o = (py * pw + px) * 3; out[o] = 255; out[o + 1] = 0; out[o + 2] = 0;
    }
  }
  await sharp(out, { raw: { width: pw, height: ph, channels: 3 } }).png().toFile(file);
}

async function main() {
  console.log(`HDRI ${ID}`);
  const info = await getJson(`https://api.polyhaven.com/info/${ID}`);
  const files = await getJson(`https://api.polyhaven.com/files/${ID}`);
  writeFileSync(resolve(rawDir, 'info.json'), JSON.stringify(info, null, 1));
  const want = ['1k', '2k', '4k'];
  const local = {};
  for (const res of want) {
    const f = files.hdri?.[res]?.hdr;
    if (!f) throw new Error(`no ${res} hdr for ${ID}`);
    local[res] = resolve(rawDir, `${ID}_${res}.hdr`);
    await download(f.url, local[res], f.md5);
  }

  // copy the published 1k / 2k files unchanged
  for (const res of ['1k', '2k']) writeFileSync(resolve(outDir, `sky_${res}.hdr`), readFileSync(local[res]));

  const img4 = readHdr(readFileSync(local['4k']));
  console.log(`4k: ${img4.width}x${img4.height}`);
  const a = analyse(img4);

  // crop the 4k to the upper hemisphere + 10 degrees below the horizon
  const ELEV_MIN_DEG = -10;
  const rows = Math.ceil(img4.height * (0.5 - ELEV_MIN_DEG / 180));
  const top = img4.data.subarray(0, rows * img4.width * 3);
  writeFileSync(resolve(outDir, 'sky_4k_top.hdr'), writeHdr(img4.width, rows, top));
  const elevMinDeg = 90 - (180 * rows) / img4.height;

  // normalisation: sun irradiance (normal incidence) = SUN_IRRADIANCE engine units
  const SUN_IRRADIANCE = 4.0;
  const sunLum = lum(...a.sun.irradiance);
  const scale = SUN_IRRADIANCE / sunLum;
  const skyLum = lum(...a.skyIrradianceHorizontal);
  const r3 = (v) => v.map((x) => Number(x.toPrecision(5)));

  const sky = {
    id: ID,
    note: 'Generated by tools/engine/fetch-hdri.mjs. Radiance values are raw HDRI units; multiply by `scale`.',
    full: { '1k': 'sky_1k.hdr', '2k': 'sky_2k.hdr' },
    top: { file: 'sky_4k_top.hdr', width: img4.width, height: rows, elevMinDeg: Number(elevMinDeg.toFixed(5)), elevMaxDeg: 90 },
    scale: Number(scale.toPrecision(6)),
    worldSunAzimuthDeg: WORLD_SUN_AZIMUTH_DEG,
    sun: {
      // direction in three.js equirect space (before rotation): phi = atan2(z, x)
      direction: r3(a.sun.direction),
      elevationDeg: Number(a.sun.elevationDeg.toFixed(3)),
      phiRad: Number(a.sun.phiRad.toFixed(5)),
      irradiance: r3(a.sun.irradiance),
      color: r3(a.sun.irradiance.map((c) => c / Math.max(...a.sun.irradiance))),
    },
    clampLuminance: Number(a.clampLuminance.toPrecision(6)),
    skyIrradianceHorizontal: r3(a.skyIrradianceHorizontal),
    sunToSkyRatio: Number((sunLum / skyLum).toFixed(3)),
    bands: Object.fromEntries(Object.entries(a.bands).map(([k, v]) => [k, r3(v)])),
    horizonByAzimuth: a.horizonByAzimuth.map(r3),
  };
  writeFileSync(resolve(outDir, 'sky.json'), JSON.stringify(sky, null, 1));
  writeFileSync(
    resolve(outDir, 'credits.json'),
    JSON.stringify(
      [{
        asset: info.name,
        id: ID,
        source: 'Poly Haven',
        url: `https://polyhaven.com/a/${ID}`,
        authors: Object.keys(info.authors ?? {}),
        license: 'CC0 1.0',
        files: ['sky_1k.hdr', 'sky_2k.hdr', 'sky_4k_top.hdr (cropped)'],
      }],
      null,
      1,
    ),
  );
  await writePreview(img4, a, resolve(rawDir, 'analysis_preview.png'));
  console.log(JSON.stringify({ peak: a.peak, percentiles: a.percentiles, sunPixels: a.sunPixels, sun: sky.sun, scale: sky.scale, sunToSkyRatio: sky.sunToSkyRatio, bands: sky.bands }, null, 1));
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
