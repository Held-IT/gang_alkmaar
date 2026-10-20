// Global constants shared by runtime modules. Owned by the orchestrator; do not change values
// without updating docs/ARCHITECTURE.md (the data pipelines in tools/ use the same numbers).

/** World origin: centre of De Waag (Kaasmarkt), in Rijksdriehoekstelsel (EPSG:28992) metres. */
export const ORIGIN_RD = { x: 111866, y: 516173 } as const;
/** Same origin in WGS84. */
export const ORIGIN_WGS84 = { lat: 52.6313607, lon: 4.7500868 } as const;

/**
 * Local world coordinates (metres):
 *   x =  RD.x - ORIGIN_RD.x   (east is +x)
 *   y =  height above street level (street level = 0)
 *   z = -(RD.y - ORIGIN_RD.y) (north is -z, south is +z)
 */
export function rdToLocal(rdX: number, rdY: number): { x: number; z: number } {
  return { x: rdX - ORIGIN_RD.x, z: -(rdY - ORIGIN_RD.y) };
}

/** Canal water surface height (metres, relative to street level). */
export const WATER_LEVEL = -1.5;
/** Top of quay walls / street level. */
export const STREET_LEVEL = 0;

/** Asset roots (relative to index.html so they work from file/app:// in Electron too). */
export const DATA_URL = './data/';
export const ASSETS_URL = './assets/';

/** Fixed physics timestep (seconds). */
export const PHYSICS_DT = 1 / 120;

/**
 * Render layer for planar water reflections. The reflection camera renders ONLY objects with
 * this layer enabled (obj.layers.enable(LAYER_REFLECT)); the main camera renders layer 0 as usual.
 * Enable it on large, visible-in-water geometry: buildings, landmarks, quays/ground near water,
 * bridges, canal-side trees. Not on small props, traffic or people.
 */
export const LAYER_REFLECT = 1;
