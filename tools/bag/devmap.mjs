#!/usr/bin/env node
// Dev helper (verification only): renders a 2D map PNG of the BAG footprints (footprints.json)
// with the OSM road graph (public/data/roadgraph.json, when present) and a local-coordinate grid,
// to pick camera positions for screenshots.
//
//   node tools/bag/devmap.mjs <x0> <z0> <x1> <z1> <out.png>
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { OUT_DIR } from './lib/config.mjs';

const [x0, z0, x1, z1] = process.argv.slice(2, 6).map(Number);
const out = process.argv[6];
if (![x0, z0, x1, z1].every(Number.isFinite) || !out) {
  console.log('usage: node tools/bag/devmap.mjs <x0> <z0> <x1> <z1> <out.png>');
  process.exit(1);
}
const W = 1400;
const H = Math.round((W * (z1 - z0)) / (x1 - x0));
const sx = (x) => ((x - x0) / (x1 - x0)) * W;
const sz = (z) => ((z - z0) / (z1 - z0)) * H;
const pts = (ring) => ring.map((p) => `${sx(p[0]).toFixed(1)},${sz(p[1]).toFixed(1)}`).join(' ');
const esc = (s) => String(s).replace(/[<>&"]/g, '');

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fff"/>`;
const fp = JSON.parse(readFileSync(resolve(OUT_DIR, 'footprints.json'), 'utf8'));
for (const r of fp.rings) svg += `<polygon points="${pts(r)}" fill="#c98" stroke="#844" stroke-width="0.5"/>`;

const rgFile = resolve(OUT_DIR, 'roadgraph.json');
if (existsSync(rgFile)) {
  const rg = JSON.parse(readFileSync(rgFile, 'utf8'));
  const labelled = new Set();
  for (const e of rg.edges) {
    if (!e.car) continue;
    svg += `<polyline points="${pts(e.pts)}" fill="none" stroke="#06c" stroke-width="1.5"/>`;
    if (e.name && !labelled.has(e.name)) {
      const m = e.pts[Math.floor(e.pts.length / 2)];
      if (m[0] > x0 && m[0] < x1 && m[1] > z0 && m[1] < z1) {
        labelled.add(e.name);
        svg += `<text x="${sx(m[0])}" y="${sz(m[1])}" font-size="11" fill="#036">${esc(e.name)}</text>`;
      }
    }
  }
}
const step = x1 - x0 > 800 ? 100 : 50;
for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
  svg += `<line x1="${sx(x)}" y1="0" x2="${sx(x)}" y2="${H}" stroke="#0a0" stroke-width="0.6"/><text x="${sx(x) + 2}" y="12" font-size="11" fill="#060">${x}</text>`;
}
for (let z = Math.ceil(z0 / step) * step; z <= z1; z += step) {
  svg += `<line x1="0" y1="${sz(z)}" x2="${W}" y2="${sz(z)}" stroke="#0a0" stroke-width="0.6"/><text x="2" y="${sz(z) - 2}" font-size="11" fill="#060">${z}</text>`;
}
svg += '</svg>';
await sharp(Buffer.from(svg)).png().toFile(out);
console.log(`wrote ${out} (${W}x${H})`);
