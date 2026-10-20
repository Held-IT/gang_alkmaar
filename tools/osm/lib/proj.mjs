// Projection + shared constants for the OSM pipeline (must match src/config.ts and
// docs/ARCHITECTURE.md section 2).
import proj4 from 'proj4';

export const RD_PROJ =
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs';
export const ORIGIN_RD = { x: 111866, y: 516173 };

export const WATER_LEVEL = -1.5;
export const CANAL_BED = -3.5;
export const SIDEWALK_H = 0.12;
export const CURB_STRIP_W = 0.15;
export const CHUNK = 200;
export const CHUNK_OFFSET = 2000;

/** Approximate playable rect from ARCHITECTURE (local metres); the pipeline unions its own result with it. */
export const ARCH_PLAYABLE = { minX: 110700 - 111866, maxX: 112480 - 111866, minZ: -(517075 - 516173), maxZ: -(515475 - 516173) };

const conv = proj4('EPSG:4326', RD_PROJ);

/** WGS84 -> local [x, z] (x east, z south). */
export function toLocal(lat, lon) {
  const [x, y] = conv.forward([lon, lat]);
  return [x - ORIGIN_RD.x, -(y - ORIGIN_RD.y)];
}

export const chunkI = (x) => Math.floor((x + CHUNK_OFFSET) / CHUNK);
export const chunkJ = (z) => Math.floor((z + CHUNK_OFFSET) / CHUNK);
export const chunkMinX = (i) => i * CHUNK - CHUNK_OFFSET;
export const chunkMinZ = (j) => j * CHUNK - CHUNK_OFFSET;
