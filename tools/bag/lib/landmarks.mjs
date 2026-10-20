// Parses the cached Overpass result (data-raw/bag/osm/landmarks.json) into landmark footprints
// (churches, Waag, Stadhuis, towers ...) and the Molen van Piet footprint (to be excluded).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import proj4 from 'proj4';
import { OSM_DIR, rdToLocal } from './config.mjs';

const RD_PROJ =
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs';
const toRd = proj4('WGS84', RD_PROJ);

function ll2local(p) {
  const [x, y] = toRd.forward([p.lon, p.lat]);
  return rdToLocal(x, y);
}

const LANDMARK_NAME = /\b(Waag|Stadhuis|Accijnstoren|Kapelkerk|Laurenskerk|Grote Kerk)\b/i;
const HISTORIC_BUILDINGS = new Set(['church', 'city_gate', 'castle', 'tower', 'monastery', 'chapel']);

/** Is this OSM element a landmark building (stone/brick, no procedural windows)? */
function isLandmark(tags, isNode) {
  if (tags['tower:type'] === 'communication') return false; // antenna masts on roofs
  if (tags.highway || tags.amenity === 'parking' || tags.historic === 'memorial') return false;
  if (isNode) {
    // Nodes are matched by point-in-footprint: they mark the building they stand in.
    return tags.amenity === 'townhall' || tags.amenity === 'place_of_worship' ||
      HISTORIC_BUILDINGS.has(tags.historic) || tags.man_made === 'tower';
  }
  const isBuilding = tags.building !== undefined || tags.man_made === 'tower' || tags['building:part'] !== undefined;
  if (!isBuilding) return false;
  if (['church', 'chapel', 'cathedral', 'synagogue', 'mosque'].includes(tags.building)) return true;
  if (tags.amenity === 'place_of_worship' || tags.amenity === 'townhall') return true;
  if (tags.man_made === 'tower' || HISTORIC_BUILDINGS.has(tags.historic)) return true;
  return !!(tags.name && LANDMARK_NAME.test(tags.name));
}

/**
 * @returns {{
 *   landmarks: { osm: string, name: string, refBag: string|null, rings: number[][][] }[],
 *   landmarkPoints: { osm: string, name: string, x: number, z: number }[],
 *   windmill: { osm: string, name: string, refBag: string|null, rings: number[][][], x: number, z: number } | null,
 * }}
 */
export function loadLandmarks() {
  const file = resolve(OSM_DIR, 'landmarks.json');
  if (!existsSync(file)) throw new Error(`missing ${file}: run node tools/bag/fetch.mjs first`);
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const landmarks = [];
  const landmarkPoints = [];
  let windmill = null;
  for (const e of json.elements ?? []) {
    const tags = e.tags ?? {};
    const name = tags.name ?? tags.alt_name ?? '';
    const refBag = tags['ref:bag'] ? `NL.IMBAG.Pand.${String(tags['ref:bag']).padStart(16, '0')}` : null;
    const osm = `${e.type}/${e.id}`;
    let rings = null;
    if (e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length >= 4) {
      rings = [e.geometry.map(ll2local)];
    } else if (e.type === 'relation' && Array.isArray(e.members)) {
      // Multipolygon: use the outer ways (closed ones only; good enough for overlap tests).
      rings = [];
      for (const m of e.members) {
        if (m.type === 'way' && m.role !== 'inner' && Array.isArray(m.geometry) && m.geometry.length >= 4) {
          rings.push(m.geometry.map(ll2local));
        }
      }
      if (!rings.length) rings = null;
    }
    // Molen van Piet (the only windmill inside the Singel ring with a building footprint).
    if (tags.man_made === 'windmill' && /Molen van Piet/i.test(name)) {
      const pts = rings ? rings[0] : e.type === 'node' ? [ll2local(e)] : [];
      const cx = pts.reduce((s, p) => s + p[0], 0) / Math.max(1, pts.length);
      const cz = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length);
      windmill = { osm, name, refBag, rings: rings ?? [], x: cx, z: cz };
      continue;
    }
    if (!isLandmark(tags, e.type === 'node')) continue;
    if (rings) {
      // A multipolygon relation is split into separate outer rings.
      for (const r of rings) landmarks.push({ osm, name, refBag, rings: [r] });
    } else if (e.type === 'node') {
      const [x, z] = ll2local(e);
      landmarkPoints.push({ osm, name, x, z });
    }
  }
  return { landmarks, landmarkPoints, windmill };
}
