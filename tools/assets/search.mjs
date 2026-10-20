#!/usr/bin/env node
// Texture candidate browser for the materials module (dev tool, not part of the game build).
//
// Downloads preview thumbnails of CC0 texture sets from ambientCG and/or Poly Haven and builds a
// labelled contact sheet so a human (or agent) can pick the most Dutch-looking set by eye.
//
//   node tools/assets/search.mjs --source acg --q "Bricks" [--limit 48] [--offset 0]
//   node tools/assets/search.mjs --source ph  --cat brick  [--tag red] [--limit 48]
//
// Output: data-raw/assets/previews/<source>_<query>/sheet.png (+ the individual thumbnails).
// Downloaded files are treated as untrusted data: they are only decoded as images by sharp.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
const source = args.source ?? 'acg';
const limit = Number(args.limit ?? 48);
const offset = Number(args.offset ?? 0);

/** @type {{id:string,label:string,thumb:string}[]} */
let items = [];
let tag;
if (source === 'acg') {
  const q = String(args.q ?? 'Bricks');
  tag = `acg_${q.replace(/\W+/g, '_')}_${offset}`;
  const url = `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(q)}&type=Material&limit=${limit}&offset=${offset}&sort=Popular&include=previewData,dimensionsData`;
  const j = await getJson(url);
  items = j.foundAssets.map((a) => ({
    id: a.assetId,
    label: `${a.assetId} ${a.dimensionX ?? '?'}x${a.dimensionY ?? '?'}`,
    thumb: a.previewImage?.['256-JPG-242424'] ?? a.previewImage?.['256-PNG'],
  }));
} else {
  const cat = String(args.cat ?? 'brick');
  const want = args.tag ? String(args.tag).toLowerCase() : null;
  tag = `ph_${cat}${want ? '_' + want : ''}_${offset}`;
  const cachePath = resolve(root, 'data-raw/assets/api/polyhaven_textures.json');
  let j;
  if (existsSync(cachePath)) j = JSON.parse(readFileSync(cachePath, 'utf8'));
  else {
    j = await getJson('https://api.polyhaven.com/assets?t=textures');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(j));
  }
  items = Object.entries(j)
    .filter(([id, a]) => a.categories.includes(cat) || id.includes(cat))
    .filter(([id, a]) => !want || id.includes(want) || a.tags.some((t) => t.toLowerCase().includes(want)) || a.name.toLowerCase().includes(want))
    .sort((x, y) => y[1].download_count - x[1].download_count)
    .slice(offset, offset + limit)
    .map(([id, a]) => ({
      id,
      label: `${id} ${(a.dimensions?.[0] ?? 0) / 1000}m`,
      thumb: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
    }));
}

const dir = resolve(root, 'data-raw/assets/previews', tag);
mkdirSync(dir, { recursive: true });
const cell = 256;
const labelH = 22;
const cols = 6;
const rows = Math.ceil(items.length / cols);
const composites = [];
await Promise.all(items.map(async (it, i) => {
  if (!it.thumb) return;
  const file = resolve(dir, `${it.id}.png`);
  try {
    if (!existsSync(file)) {
      const buf = await getBuffer(it.thumb);
      // Re-encode through sharp: only pixel data survives.
      await sharp(buf).resize(cell, cell, { fit: 'cover' }).png().toFile(file);
    }
    const x = (i % cols) * cell;
    const y = Math.floor(i / cols) * (cell + labelH);
    composites.push({ input: file, left: x, top: y });
    const svg = `<svg width="${cell}" height="${labelH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#111"/><text x="4" y="16" font-family="Arial" font-size="13" fill="#fff">${it.label.replace(/[<&>]/g, '')}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left: x, top: y + cell });
  } catch (e) {
    console.warn('thumb failed', it.id, e.message);
  }
}));
if (!items.length) { console.log("no candidates"); process.exit(0); }
const sheet = resolve(dir, "sheet.jpg");
await sharp({ create: { width: cols * cell, height: rows * (cell + labelH), channels: 3, background: '#222' } })
  .composite(composites)
  .jpeg({ quality: 80 })
  .toFile(sheet);
console.log(`${items.length} candidates -> ${sheet}`);
for (const it of items) console.log(' ', it.label);
