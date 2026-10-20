#!/usr/bin/env node
// Flat colour-map comparison sheet for texture candidates (dev tool).
//
//   node tools/assets/flat.mjs --name bricks --ids "acg:Bricks097,ph:red_brick,..." [--metres 1.5]
//
// Downloads the flat colour preview of every candidate (ambientCG surface preview / Poly Haven
// 1k diffuse) into data-raw/assets/flat/<id>.jpg and composes a sheet where every cell shows the
// SAME real-world area (--metres x --metres, when the source declares its physical size), so
// brick/tile sizes can be compared directly. Downloads are only decoded as images by sharp.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UA = { 'User-Agent': 'AlkmaarDrive/0.1 (texture picker)' };

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
async function getBuffer(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

const args = parseArgs(process.argv.slice(2));
const ids = String(args.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const metres = Number(args.metres ?? 1.5);
const name = String(args.name ?? 'sheet');
const dir = resolve(root, 'data-raw/assets/flat');
mkdirSync(dir, { recursive: true });
const cell = 340;
const labelH = 22;
const cols = Math.min(5, ids.length);

const composites = [];
await Promise.all(ids.map(async (full, i) => {
  const [src, id] = full.split(':');
  const file = resolve(dir, `${src}_${id}.jpg`);
  let sizeM = 0; // physical width of the texture in metres (0 = unknown)
  try {
    if (src === 'acg') {
      const j = await getJson(`https://ambientcg.com/api/v2/full_json?id=${id}&include=dimensionsData`);
      const a = j.foundAssets[0];
      sizeM = (a?.dimensionX ?? 0) / 100;
      if (!existsSync(file)) {
        const buf = await getBuffer(`https://f003.backblazeb2.com/file/ambientCG-Web/media/surface-preview/${id}/${id}_SQ_Color.jpg`);
        await sharp(buf).jpeg({ quality: 90 }).toFile(file);
      }
    } else {
      const info = await getJson(`https://api.polyhaven.com/info/${id}`);
      sizeM = (info.dimensions?.[0] ?? 0) / 1000;
      if (!existsSync(file)) {
        const files = await getJson(`https://api.polyhaven.com/files/${id}`);
        const buf = await getBuffer(files.Diffuse['1k'].jpg.url);
        await sharp(buf).jpeg({ quality: 90 }).toFile(file);
      }
    }
    const meta = await sharp(file).metadata();
    // Crop the area corresponding to `metres` (tile when the texture is smaller than that).
    let img;
    if (sizeM > 0) {
      const frac = metres / sizeM;
      if (frac <= 1) {
        const w = Math.max(8, Math.round(meta.width * frac));
        img = await sharp(file).extract({ left: 0, top: 0, width: w, height: Math.min(w, meta.height) }).resize(cell, cell).toBuffer();
      } else {
        const reps = Math.ceil(frac);
        const tileSize = Math.round(cell / frac);
        const tile = await sharp(file).resize(tileSize, tileSize).toBuffer();
        const parts = [];
        for (let y = 0; y < reps; y++) for (let x = 0; x < reps; x++) parts.push({ input: tile, left: x * tileSize, top: y * tileSize });
        img = await sharp({ create: { width: reps * tileSize, height: reps * tileSize, channels: 3, background: '#000' } })
          .composite(parts).jpeg().toBuffer();
        img = await sharp(img).extract({ left: 0, top: 0, width: Math.min(cell, reps * tileSize), height: Math.min(cell, reps * tileSize) }).resize(cell, cell).toBuffer();
      }
    } else {
      img = await sharp(file).resize(cell, cell).toBuffer();
    }
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (cell + labelH);
    composites.push({ input: img, left: x, top: y });
    const label = `${full} ${sizeM ? sizeM.toFixed(2) + 'm' : '(size ?)'}`;
    const svg = `<svg width="${cell}" height="${labelH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="16" font-family="Arial" font-size="14" fill="#fff">${label}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y + cell });
  } catch (e) {
    console.warn('failed', full, e.message);
  }
}));
const rows = Math.ceil(ids.length / cols);
const out = resolve(root, 'data-raw/assets/flat', `sheet_${name}.jpg`);
await sharp({ create: { width: cols * cell, height: rows * (cell + labelH), channels: 3, background: '#222' } })
  .composite(composites).jpeg({ quality: 85 }).toFile(out);
writeFileSync(resolve(dir, `sheet_${name}.txt`), ids.join('\n'));
console.log(out, `(each cell = ${metres} m where size is known)`);
