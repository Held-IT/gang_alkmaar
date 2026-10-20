#!/usr/bin/env node
// Downloads + processes the CC0 PBR texture sets used by src/world/materials.
//
//   node tools/assets/fetch.mjs            # download (cached) + process everything
//   node tools/assets/fetch.mjs --only klinkers,asphalt
//   (downloads are cached in data-raw/assets/, re-running only re-processes)
//
// Sources: ambientCG (https://ambientcg.com, CC0) and Poly Haven (https://polyhaven.com, CC0).
// Every download goes into its own folder data-raw/assets/<source>_<id>/ and is treated as
// untrusted data: zips are parsed by the tiny reader below and ONLY image entries are extracted
// (names sanitised, no paths), images are only decoded by sharp. Nothing downloaded is executed.
//
// Output per set: public/assets/textures/<name>/color.jpg (sRGB), normal.jpg (OpenGL / +Y),
// arm.jpg (R = AO, G = roughness, B = metalness), JPEG q85. Colour maps keep the set size (2048
// for the large surfaces); normal + arm maps are capped at 1024 px (GPU memory budget). Plus public/assets/credits.json and
// public/assets/textures/meta.json (physical size of each texture tile in metres, used at runtime).
// Generated (not downloaded) textures: water normal map + macro noise, see tools/assets/generate.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = resolve(root, 'data-raw/assets');
const OUT = resolve(root, 'public/assets/textures');
const UA = { 'User-Agent': 'AlkmaarDrive/0.1 (texture fetch)' };

/**
 * The chosen sets (picked by eye from preview contact sheets, see tools/assets/search.mjs + flat.mjs).
 * size    : output resolution of color + normal (arm is written at min(size, armSize)).
 * metres  : real-world size of one texture tile (used by the runtime for UV scaling).
 * grey    : convert the colour map to neutral grey (material tints it at runtime).
 * grade   : recolour the raised parts (bricks / pavers, found via the displacement map) towards
 *           target sRGB keeping their luminance variation; joints/mortar stay untouched.
 */
const SETS = [
  { name: 'brick_facade', src: 'acg', id: 'Bricks073A', size: 2048, metres: 1.25, grade: { target: [134, 80, 66], amount: 0.85, joints: [0.2, 0.27], variation: 0.12 }, desc: 'Dutch red-brown facade brick, light mortar' },
  { name: 'brick_facade_alt', src: 'ph', id: 'red_brick_03', size: 1024, metres: 0.9, desc: 'darker purple-brown facade brick' },
  { name: 'plaster', src: 'acg', id: 'Plaster001', size: 1024, metres: 2.0, desc: 'white painted stucco' },
  { name: 'brick_quay', src: 'acg', id: 'Bricks097', size: 1024, metres: 1.1, desc: 'old weathered quay brick' },
  { name: 'klinkers', src: 'acg', id: 'PavingStones118', size: 2048, metres: 1.75, grade: { target: [126, 70, 56], amount: 0.8, joints: [0.06, 0.14], variation: 0.1 }, desc: 'red-brown clay pavers, 45 deg herringbone' },
  { name: 'sidewalk_tiles', src: 'acg', id: 'PavingStones038', size: 2048, metres: 2.4, desc: 'grey 30x30 concrete pavement tiles' },
  { name: 'square_cobbles', src: 'acg', id: 'PavingStones070', size: 1024, metres: 1.15, desc: 'natural stone setts' },
  { name: 'asphalt', src: 'acg', id: 'Asphalt023L', size: 2048, metres: 2.5, desc: 'fine grey asphalt' },
  { name: 'curb', src: 'ph', id: 'granite_tile', size: 1024, metres: 2.3, desc: 'granite (curbs, quay coping)' },
  { name: 'roof_tiles', src: 'acg', id: 'RoofingTiles014A', size: 2048, metres: 2.9, desc: 'clean Dutch S-pantiles (weathering is procedural, non-repeating)' },
  { name: 'roof_tiles_dark', src: 'acg', id: 'RoofingTiles013B', size: 1024, metres: 2.9, desc: 'anthracite glazed pantiles' },
  { name: 'roof_flat', src: 'ph', id: 'tarred_gravel', size: 1024, metres: 2.2, desc: 'bitumen with gravel chippings' },
  { name: 'grass', src: 'acg', id: 'Grass004', size: 1024, metres: 1.4, desc: 'lawn grass' },
  { name: 'stone', src: 'ph', id: 'white_sandstone_blocks_02', size: 1024, metres: 2.0, desc: 'light sandstone blocks (churches, Waag)' },
  { name: 'wood', src: 'ph', id: 'weathered_plank_siding', size: 1024, metres: 1.57, desc: 'aged wooden planks' },
  { name: 'mud', src: 'ph', id: 'brown_mud_02', size: 1024, metres: 1.3, desc: 'canal bed mud' },
  { name: 'metal_painted', src: 'acg', id: 'PaintedMetal004', size: 1024, metres: 1.0, grey: true, desc: 'painted metal, scratched (neutral, tint at runtime)' },
];
const ARM_MAX = 1024; // AO/roughness/metal detail at 2K is invisible; saves ~80 MB GPU memory.
const NORMAL_MAX = 1024; // 1K normals = 1-3 mm/px for these tile sizes; saves another ~85 MB.

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function download(url, file) {
  if (existsSync(file)) return;
  const r = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
  console.log(`  downloaded ${url} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

/** Minimal ZIP reader: returns {name, data} for image entries only (stored or deflated). */
function extractImagesFromZip(buf) {
  // Find End Of Central Directory record (signature 0x06054b50) scanning backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const base = rawName.split(/[\\/]/).pop() ?? '';
    if (!/^[\w.-]+\.(jpe?g|png)$/i.test(base)) continue; // images only, sanitised flat names
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = inflateRawSync(comp);
    else continue;
    out.push({ name: base, data });
  }
  return out;
}

/** Download raw maps for one set into data-raw/assets/<src>_<id>/, return paths of the maps. */
async function fetchRaw(set) {
  const dir = resolve(RAW, `${set.src}_${set.id}`);
  mkdirSync(dir, { recursive: true });
  const maps = {};
  if (set.src === 'acg') {
    const res = set.size >= 2048 ? '2K' : '1K';
    const zipFile = resolve(dir, `${set.id}_${res}-JPG.zip`);
    await download(`https://ambientcg.com/get?file=${set.id}_${res}-JPG.zip`, zipFile);
    const extracted = resolve(dir, 'img');
    if (!existsSync(extracted)) {
      mkdirSync(extracted);
      for (const e of extractImagesFromZip(readFileSync(zipFile))) writeFileSync(resolve(extracted, e.name), e.data);
    }
    for (const f of readdirSync(extracted)) {
      const full = resolve(extracted, f);
      if (/_Color\./i.test(f)) maps.color = full;
      else if (/_NormalGL\./i.test(f)) maps.normal = full;
      else if (/_NormalDX\./i.test(f) && !maps.normal) { maps.normal = full; maps.normalDX = true; }
      else if (/_Roughness\./i.test(f)) maps.rough = full;
      else if (/_AmbientOcclusion\./i.test(f)) maps.ao = full;
      else if (/_Metalness\./i.test(f)) maps.metal = full;
      else if (/_Displacement\./i.test(f)) maps.disp = full;
    }
    const info = await getJson(`https://ambientcg.com/api/v2/full_json?id=${set.id}`);
    set.url = `https://ambientcg.com/view?id=${set.id}`;
    set.title = info.foundAssets?.[0]?.displayName ?? set.id;
    set.author = 'ambientCG (Lennart Demes)';
  } else {
    const res = set.size >= 2048 ? '2k' : '1k';
    const files = await getJson(`https://api.polyhaven.com/files/${set.id}`);
    const info = await getJson(`https://api.polyhaven.com/info/${set.id}`);
    const want = { color: 'Diffuse', normal: 'nor_gl', arm: 'arm' };
    for (const [key, ph] of Object.entries(want)) {
      const entry = files[ph]?.[res]?.jpg ?? files[ph]?.['2k']?.jpg;
      if (!entry) continue;
      const file = resolve(dir, `${set.id}_${ph}_${res}.jpg`);
      await download(entry.url, file);
      maps[key] = file;
    }
    set.url = `https://polyhaven.com/a/${set.id}`;
    set.title = info.name ?? set.id;
    set.author = Object.keys(info.authors ?? {}).join(', ') || 'Poly Haven';
  }
  if (!maps.color || !maps.normal) throw new Error(`${set.name}: missing color/normal maps in ${dir}`);
  return maps;
}

/**
 * Recolour the raised parts (bricks / pavers: displacement above the joint percentile range)
 * by a per-channel ratio so their average becomes grade.target while every brick keeps its own
 * variation. Joints / mortar (the lowest displacement values) are left untouched.
 */
async function gradeColor(color, dispFile, S, grade) {
  const { data, info } = await color.raw().toBuffer({ resolveWithObject: true });
  const disp = await sharp(dispFile).resize(info.width, info.height, { fit: 'fill' }).greyscale().raw().toBuffer();
  const sorted = Float32Array.from(disp).sort();
  const [pLo, pHi] = grade.joints ?? [0.15, 0.25];
  const lo = sorted[Math.floor(sorted.length * pLo)];
  const hi = Math.max(lo + 1, sorted[Math.floor(sorted.length * pHi)]);
  const ch = info.channels;
  const avg = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < disp.length; i++) {
    if (disp[i] < hi) continue;
    avg[0] += data[i * ch]; avg[1] += data[i * ch + 1]; avg[2] += data[i * ch + 2]; n++;
  }
  const ratio = avg.map((v, c) => grade.target[c] / (v / Math.max(1, n)));
  // labels from a blurred displacement so brick faces form single connected components
  const dispBlur = await sharp(dispFile).resize(info.width, info.height, { fit: 'fill' }).greyscale().blur(info.width / 680).raw().toBuffer();
  const sortedB = Float32Array.from(dispBlur).sort();
  const core = sortedB[Math.floor(sortedB.length * 0.5)]; // brick cores: upper half of the blurred height
  const tint = perBrickTints(dispBlur, info.width, info.height, core, grade.variation ?? 0);
  const out = Buffer.alloc(info.width * info.height * 3);
  for (let i = 0; i < disp.length; i++) {
    const t = Math.min(1, Math.max(0, (disp[i] - lo) / (hi - lo)));
    const m = t * t * (3 - 2 * t);
    for (let c = 0; c < 3; c++) {
      const v = data[i * ch + c];
      const g = 1 + (ratio[c] - 1) * m * grade.amount;
      const k = 1 + (tint[i * 3 + c] - 1) * m;
      out[i * 3 + c] = Math.min(255, v * g * k);
    }
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
}

/**
 * Random colour multiplier per brick / paver: connected components of the raised mask
 * (displacement >= hi, wrapping at the edges so the texture stays tileable), labels grown a few
 * pixels into the joint bevels. Returns rgb multipliers per pixel (1 = unchanged).
 */
function perBrickTints(disp, W, H, hi, variation) {
  const out = new Float32Array(W * H * 3).fill(1);
  if (!variation) return out;
  const label = new Int32Array(W * H).fill(-1);
  let next = 0;
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] >= 0 || disp[start] < hi) continue;
    let sp = 0;
    stack[sp++] = start;
    label[start] = next;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W; const y = (p - x) / W;
      const nb = [((x + 1) % W) + y * W, ((x - 1 + W) % W) + y * W, x + ((y + 1) % H) * W, x + ((y - 1 + H) % H) * W];
      for (const q of nb) if (label[q] < 0 && disp[q] >= hi) { label[q] = next; stack[sp++] = q; }
    }
    next++;
  }
  // components smaller than ~1/3 of a typical brick are noise: no tint
  const sizes = new Int32Array(next);
  for (let p = 0; p < W * H; p++) if (label[p] >= 0) sizes[label[p]]++;
  const minSize = (W * H) / 900;
  for (let p = 0; p < W * H; p++) if (label[p] >= 0 && sizes[label[p]] < minSize) label[p] = -2;
  // grow labels into the bevel / joint edge (a few passes)
  for (let pass = 0; pass < Math.round(W / 128); pass++) {
    const copy = label.slice();
    for (let p = 0; p < W * H; p++) {
      if (copy[p] >= 0 || copy[p] === -2) continue;
      const x = p % W; const y = (p - x) / W;
      const l = Math.max(copy[((x + 1) % W) + y * W], copy[((x - 1 + W) % W) + y * W], copy[x + ((y + 1) % H) * W], copy[x + ((y - 1 + H) % H) * W]);
      if (l >= 0) label[p] = l;
    }
  }
  const rand = (i, k) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
  const tints = [];
  for (let i = 0; i < next; i++) {
    const r = rand(i, 1);
    let c = [1, 1, 1];
    if (r < 0.12) c = [0.72, 0.66, 0.72];        // dark purple/blue-ish fired brick
    else if (r < 0.22) c = [1.12, 0.98, 0.86];   // lighter orange
    else if (r < 0.3) c = [0.86, 0.8, 0.76];     // brown
    const b = 1 + (rand(i, 2) - 0.5) * 2 * variation;
    tints.push(c.map((v) => 1 + (v * b - 1) * Math.min(1, variation * 4)));
  }
  for (let p = 0; p < W * H; p++) {
    const l = label[p];
    if (l < 0) continue;
    out[p * 3] = tints[l][0]; out[p * 3 + 1] = tints[l][1]; out[p * 3 + 2] = tints[l][2];
  }
  let big = 0;
  for (let i = 0; i < next; i++) if (sizes[i] >= minSize) big++;
  console.log(`  per-brick variation: ${big} bricks (${next - big} small fragments ignored)`);
  return out;
}

async function processSet(set, maps) {
  const dir = resolve(OUT, set.name);
  mkdirSync(dir, { recursive: true });
  const S = set.size;
  const A = Math.min(S, ARM_MAX);
  const jpeg = { quality: 85, chromaSubsampling: '4:4:4', mozjpeg: true };

  // Colour (sRGB). Optional neutral grey for tintable materials.
  let color = sharp(maps.color).resize(S, S, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha();
  if (set.grey) {
    // keep luminance only, recentred to a light neutral so the runtime tint defines the colour
    const { data, info } = await color.raw().toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (let i = 0; i < data.length; i += info.channels) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const mean = sum / (data.length / info.channels);
    const out = Buffer.alloc(info.width * info.height * 3);
    for (let i = 0, j = 0; i < data.length; i += info.channels, j += 3) {
      const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const v = Math.max(0, Math.min(255, 200 + (l - mean) * 0.8));
      out[j] = out[j + 1] = out[j + 2] = v;
    }
    color = sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
  }
  if (set.grade && maps.disp) color = await gradeColor(color, maps.disp, S, set.grade);
  await color.jpeg(jpeg).toFile(resolve(dir, 'color.jpg'));

  // Normal (OpenGL convention: +Y up / green = up). Renormalise after resampling.
  {
    const NS = Math.min(S, NORMAL_MAX);
    const { data, info } = await sharp(maps.normal).resize(NS, NS, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(info.width * info.height * 3);
    for (let i = 0, j = 0; i < data.length; i += info.channels, j += 3) {
      let x = data[i] / 127.5 - 1;
      let y = data[i + 1] / 127.5 - 1;
      let z = data[i + 2] / 127.5 - 1;
      if (maps.normalDX) y = -y;
      const l = Math.hypot(x, y, z) || 1;
      x /= l; y /= l; z /= l;
      out[j] = Math.round((x * 0.5 + 0.5) * 255);
      out[j + 1] = Math.round((y * 0.5 + 0.5) * 255);
      out[j + 2] = Math.round((Math.max(z, 0) * 0.5 + 0.5) * 255);
    }
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg(jpeg).toFile(resolve(dir, 'normal.jpg'));
  }

  // ARM: R = AO, G = roughness, B = metalness.
  if (maps.arm) {
    await sharp(maps.arm).resize(A, A, { fit: 'fill' }).removeAlpha().jpeg(jpeg).toFile(resolve(dir, 'arm.jpg'));
  } else {
    const grey = async (file, fallback) => {
      if (!file) return Buffer.alloc(A * A, fallback);
      return sharp(file).resize(A, A, { fit: 'fill' }).greyscale().raw().toBuffer();
    };
    const ao = await grey(maps.ao, 255);
    const rough = await grey(maps.rough, 200);
    const metal = await grey(maps.metal, 0);
    const out = Buffer.alloc(A * A * 3);
    for (let i = 0; i < A * A; i++) { out[i * 3] = ao[i]; out[i * 3 + 1] = rough[i]; out[i * 3 + 2] = metal[i]; }
    await sharp(out, { raw: { width: A, height: A, channels: 3 } }).jpeg(jpeg).toFile(resolve(dir, 'arm.jpg'));
  }
}

const args = parseArgs(process.argv.slice(2));
const only = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });

const creditsPath = resolve(root, 'public/assets/credits.json');
const metaPath = resolve(OUT, 'meta.json');
const credits = existsSync(creditsPath) ? JSON.parse(readFileSync(creditsPath, 'utf8')) : [];
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};

for (const set of SETS) {
  if (only && !only.has(set.name)) continue;
  console.log(`[${set.name}] ${set.src}:${set.id}`);
  const maps = await fetchRaw(set);
  await processSet(set, maps);
  meta[set.name] = { metres: set.metres, size: set.size, source: `${set.src}:${set.id}` };
  const entry = {
    name: set.name,
    asset: set.title,
    source: set.src === 'acg' ? 'ambientCG' : 'Poly Haven',
    author: set.author,
    url: set.url,
    license: 'CC0',
  };
  const i = credits.findIndex((c) => c.name === set.name);
  if (i >= 0) credits[i] = entry; else credits.push(entry);
}
writeFileSync(creditsPath, JSON.stringify(credits, null, 2) + '\n');
writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
console.log(`done: ${Object.keys(meta).length} sets -> ${OUT}`);
