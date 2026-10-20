#!/usr/bin/env node
// Builds the game with Vite and packages it as a Windows x64 Electron app in release/.
//   node tools/package.mjs            -> release/Alkmaar Drive-win32-x64/Alkmaar Drive.exe (+ zip)
//   node tools/package.mjs --no-build -> skip vite build (use existing dist/)
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
}

// --- 1. Icon: Waag-tower-ish silhouette on Alkmaar red, written as a PNG-in-ICO file.
async function makeIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" rx="48" fill="#d4202c"/>
    <path fill="#ffffff" d="M120 36 L136 36 L136 52 L146 70 L146 96 L156 96 L156 120 L176 120 L196 150 L196 206
      L60 206 L60 150 L80 120 L100 120 L100 96 L110 96 L110 70 L120 52 Z"/>
    <rect x="60" y="214" width="136" height="10" rx="5" fill="#ffffff"/>
    <circle cx="128" cy="160" r="14" fill="#d4202c"/>
  </svg>`;
  const sizes = [256, 64, 48, 32, 16];
  const pngs = await Promise.all(sizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer()));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const o = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, o);
    dir.writeUInt8(s >= 256 ? 0 : s, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(pngs[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });
  writeFileSync(join(root, 'electron', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
}

function dirSize(p) {
  let total = 0;
  for (const e of readdirSync(p)) {
    const f = join(p, e);
    const st = statSync(f);
    total += st.isDirectory() ? dirSize(f) : st.size;
  }
  return total;
}

await makeIcon();
if (!args.has('--no-build')) run('npx vite build');
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('dist/index.html missing — build failed?');

const { packager } = await import('@electron/packager');
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const appPaths = await packager({
  dir: root,
  out: outDir,
  name: 'Gang Alkmaar',
  executableName: 'Gang Alkmaar',
  platform: 'win32',
  arch: 'x64',
  overwrite: true,
  asar: true,
  prune: false,
  icon: join(root, 'electron', 'icon.ico'),
  appCopyright: 'Kaartdata © OpenStreetMap-bijdragers (ODbL) · Gebouwen © 3D BAG (CC BY 4.0)',
  win32metadata: { CompanyName: 'Gang Alkmaar', FileDescription: 'Gang Alkmaar', ProductName: 'Gang Alkmaar' },
  // Only ship the Electron shell, the built game and package.json.
  ignore: (p) => {
    if (p === '' || p === '/package.json') return false;
    if (p === '/electron' || p.startsWith('/electron/')) return false;
    if (p === '/dist' || p.startsWith('/dist/')) return false;
    return true;
  },
});
for (const p of appPaths) {
  console.log(`Packaged: ${p} (${(dirSize(p) / 1e6).toFixed(0)} MB)`);
  const zip = `${p}.zip`;
  rmSync(zip, { force: true });
  run(`powershell -NoProfile -Command "Compress-Archive -Path '${p}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal"`);
  console.log(`Zip: ${zip}`);
}
