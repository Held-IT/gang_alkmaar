// Shared constants for the 3D BAG pipeline (tools/bag). Mirrors src/config.ts / ARCHITECTURE.md.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const RAW_DIR = resolve(ROOT, 'data-raw/bag');
export const PAGES_DIR = resolve(RAW_DIR, 'pages');
export const OSM_DIR = resolve(RAW_DIR, 'osm');
export const OUT_DIR = resolve(ROOT, 'public/data');

/** World origin (De Waag) in RD (EPSG:28992). */
export const ORIGIN_RD = { x: 111866, y: 516173 };

/** Playable rectangle in RD metres (inside: LoD 2.2 buildings). */
export const PLAYABLE_RD = { minX: 110650, minY: 515420, maxX: 112530, maxY: 517130 };
/** Backdrop ring extends this far (m) beyond the playable rectangle (LoD 1.2 extrusions). */
export const BACKDROP_MARGIN = 900;
export const BACKDROP_RD = {
  minX: PLAYABLE_RD.minX - BACKDROP_MARGIN,
  minY: PLAYABLE_RD.minY - BACKDROP_MARGIN,
  maxX: PLAYABLE_RD.maxX + BACKDROP_MARGIN,
  maxY: PLAYABLE_RD.maxY + BACKDROP_MARGIN,
};

/** RD -> local world coordinates (x east, z south). */
export function rdToLocal(x, y) {
  return [x - ORIGIN_RD.x, -(y - ORIGIN_RD.y)];
}

/** Playable rect in local coordinates (Rect contract: minX/minZ/maxX/maxZ). */
export const PLAYABLE_LOCAL = {
  minX: PLAYABLE_RD.minX - ORIGIN_RD.x,
  maxX: PLAYABLE_RD.maxX - ORIGIN_RD.x,
  minZ: -(PLAYABLE_RD.maxY - ORIGIN_RD.y),
  maxZ: -(PLAYABLE_RD.minY - ORIGIN_RD.y),
};

/** Chunk grid (ARCHITECTURE 4.2): 200 m cells. */
export const CHUNK = 200;
export const chunkI = (x) => Math.floor((x + 2000) / CHUNK);
export const chunkJ = (z) => Math.floor((z + 2000) / CHUNK);

export const ATTRIBUTION = 'Gebouwen: 3D BAG door tudelft3d en 3DGI (CC BY 4.0)';
export const USER_AGENT = 'AlkmaarDrive/0.1 (hobby game)';

/**
 * Persistent exclusions: BAG panden replaced by hand-made hero models (src/world/landmarks).
 * The Molen van Piet is excluded automatically via OSM (build.mjs); these are added on top.
 *   0361100000014453  De Waag (Waagplein 2)       -> landmarks/waag.ts
 *   0361100000010548  Accijnstoren (1622, Mient)  -> landmarks/accijnstoren.ts
 */
export const EXCLUDED_PANDEN = ['0361100000014453', '0361100000010548'];

// build.mjs reads its exclusions from `--exclude id1,id2`; merge the persistent list into argv so a
// plain `node tools/bag/build.mjs` always leaves these shells out (config.mjs is imported first).
if (/build\.mjs$/i.test(process.argv[1] ?? '')) {
  const i = process.argv.indexOf('--exclude');
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    const have = new Set(process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
    for (const id of EXCLUDED_PANDEN) have.add(id);
    process.argv[i + 1] = [...have].join(',');
  } else if (i >= 0) {
    process.argv.splice(i + 1, 0, EXCLUDED_PANDEN.join(','));
  } else {
    process.argv.push('--exclude', EXCLUDED_PANDEN.join(','));
  }
}
