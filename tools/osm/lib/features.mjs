// Tag classification: turns raw OSM ways/relations into typed features for the ground builder,
// road graph and props generator.
import { areaPolys } from './osm.mjs';
import { bboxOfPts, pointInRing, polyArea, polylineLength, segIntersectT } from './geom.mjs';

/**
 * Hand-traced outline of the binnenstad (centre lines of the Singel ring + Noordhollandsch
 * Kanaal). Only used to choose defaults (30 km/h, klinkers, historic lanterns).
 */
export const BINNENSTAD = [
  [-290, -428], [-245, -374], [-200, -336], [-150, -310], [-80, -305], [0, -245], [100, -195],
  [200, -150], [300, -90], [355, -55], [400, 0], [440, 60], [445, 120], [410, 200], [375, 270],
  [360, 330], [390, 390], [450, 440], [535, 500], [470, 560], [395, 617], [300, 580], [195, 540],
  [100, 505], [0, 470], [-100, 440], [-192, 410], [-250, 405], [-300, 340], [-350, 300],
  [-420, 255], [-500, 205], [-580, 215], [-610, 190], [-615, 140], [-600, 85], [-605, 30],
  [-615, -60], [-640, -120], [-670, -170], [-700, -230], [-710, -268], [-700, -290], [-660, -300],
  [-560, -300], [-470, -365], [-400, -445], [-360, -450], [-320, -428],
];
export const inBinnenstad = (x, z) => pointInRing(x, z, BINNENSTAD);

export const CAR_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road',
]);
const MAIN_TYPES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const FOOT_TYPES = new Set(['footway', 'path', 'steps', 'bridleway', 'corridor', 'track', 'platform']);
const DEFAULT_W = {
  motorway: 11, motorway_link: 5, trunk: 8, trunk_link: 5, primary: 7.5, primary_link: 5, secondary: 7.5, secondary_link: 5,
  tertiary: 6.5, tertiary_link: 5, unclassified: 5.5, residential: 5.5, living_street: 4.5, service: 4.5, road: 5,
  busway: 6.5, pedestrian: 7, cycleway: 2.5, footway: 2, path: 2, steps: 2, bridleway: 2, corridor: 2, track: 3, platform: 3,
};
const KLINKER_SURF = new Set(['paving_stones', 'sett', 'cobblestone', 'bricks', 'unhewn_cobblestone', 'concrete:plates', 'paving_stones:30', 'grass_paver', 'stone', 'pebblestone']);
const UNPAVED_SURF = new Set(['unpaved', 'gravel', 'fine_gravel', 'compacted', 'dirt', 'ground', 'earth', 'sand', 'woodchips', 'mud']);

export function parseWidth(v) {
  if (!v) return NaN;
  const f = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(f) && f >= 1 && f <= 40 ? f : NaN;
}

/** Strip width per on-street parking orientation (m). */
const PARK_W = { parallel: 2.0, diagonal: 4.2, perpendicular: 4.8 };
/**
 * On-street parking on one side of a way ('left'/'right' relative to the OSM way direction),
 * from the old (parking:lane:*) or new (parking:*) schema. Returns { orient, w } or null.
 */
function parkSide(t, side) {
  const o = t[`parking:lane:${side}`] ?? t['parking:lane:both'];
  let orient = null;
  if (o === 'parallel' || o === 'diagonal' || o === 'perpendicular') orient = o;
  else if (o === 'marked') orient = 'parallel';
  else if (o === undefined) {
    const n = t[`parking:${side}`] ?? t['parking:both'];
    if (['lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder', 'yes'].includes(n)) {
      orient = t[`parking:${side}:orientation`] ?? t['parking:both:orientation'] ?? 'parallel';
    }
  }
  return orient && PARK_W[orient] ? { orient, w: PARK_W[orient] } : null;
}

function parseSpeedKmh(v) {
  if (!v) return NaN;
  if (v === 'walk') return 7;
  if (/NL:urban/i.test(v)) return 50;
  if (/NL:living_street|NL:zone30/i.test(v)) return /30/.test(v) ? 30 : 15;
  const f = parseFloat(v);
  return Number.isFinite(f) && f > 0 && f <= 130 ? (/mph/.test(v) ? f * 1.609 : f) : NaN;
}

const isYes = (v) => v === 'yes' || v === 'true' || v === '1';

/** Decide surface material class for a car road / ped street. */
function roadMaterial(hw, surface, inside) {
  if (surface === 'asphalt' || surface === 'concrete' || surface === 'chipseal') return 'asphalt';
  if (KLINKER_SURF.has(surface)) return 'klinkers';
  if (UNPAVED_SURF.has(surface)) return 'ground';
  if (hw === 'busway') return 'asphalt';
  if (MAIN_TYPES.has(hw)) return 'asphalt';
  if (hw === 'unclassified') return inside ? 'klinkers' : 'asphalt';
  return 'klinkers';
}

/**
 * Classify a highway way. Returns null for ways that produce no surface.
 * kind: 'car' (y=0, curbs), 'bus' (y=0, no cars in graph), 'ped' (pedestrian street, flush y=0),
 *       'cycle' (raised, red), 'foot' (raised path).
 */
export function classifyHighway(w) {
  const t = w.tags;
  const hw = t.highway;
  if (!hw || t.area === 'yes') return null;
  if (['construction', 'proposed', 'abandoned', 'razed', 'disused', 'elevator', 'escalator', 'rest_area', 'services', 'bus_stop', 'emergency_bay', 'raceway'].includes(hw)) return null;
  // tunnels are not modelled; a very short one (< 16 m, e.g. a road passing under a station
  // footbridge) is an open-air road in the game. extractFeatures drops those that pass under tracks.
  let shortTunnel = false;
  if ((t.tunnel === 'yes' || t.tunnel === 'culvert') && Number(t.layer ?? -1) < 0) {
    if (t.tunnel !== 'yes' || polylineLength(w.pts) >= 16) return null;
    shortTunnel = true;
  }
  if (t.indoor === 'yes' || t.level && Number(t.level) < 0) return null;
  const mid = w.pts[Math.floor(w.pts.length / 2)];
  const inside = inBinnenstad(mid[0], mid[1]);
  let kind;
  if (CAR_TYPES.has(hw)) kind = 'car';
  else if (hw === 'busway' || hw === 'bus_guideway') kind = 'bus';
  else if (hw === 'pedestrian') kind = 'ped';
  else if (hw === 'cycleway') kind = 'cycle';
  else if (FOOT_TYPES.has(hw)) kind = 'foot';
  else return null;
  if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') kind = kind === 'cycle' ? 'cycle' : 'foot';

  const onewayRaw = t.oneway ?? (t.junction === 'roundabout' || t.junction === 'circular' || hw === 'motorway' ? 'yes' : 'no');
  const oneway = isYes(onewayRaw) ? 1 : onewayRaw === '-1' ? -1 : 0;
  const lanesTag = parseInt(t.lanes ?? '', 10);
  let width = parseWidth(t.width ?? t['width:carriageway'] ?? t.est_width);
  if (!Number.isFinite(width)) {
    if (kind === 'car' || kind === 'bus') {
      if (Number.isFinite(lanesTag) && lanesTag > 0) width = Math.min(14, lanesTag * 3.1 + (lanesTag === 1 ? 0.6 : 0));
      else if (oneway !== 0) width = { residential: 4.5, unclassified: 4.5, living_street: 4.0, service: 3.6, tertiary: 4.5, secondary: 4.5, primary: 5.0, trunk: 7.0 }[hw] ?? DEFAULT_W[hw] ?? 4.5;
      else width = DEFAULT_W[hw] ?? 5;
      if (t.service === 'parking_aisle') width = Math.min(width, 5);
      if (t.service === 'driveway' || t.service === 'alley') width = Math.min(width, 3.5);
    } else width = DEFAULT_W[hw] ?? 2;
  }
  // Painted cycle lanes (fietsstroken) on the carriageway.
  const cl = t['cycleway:both'] ?? t.cycleway;
  let bikeLaneL = cl === 'lane' || t['cycleway:left'] === 'lane';
  let bikeLaneR = cl === 'lane' || t['cycleway:right'] === 'lane';
  if (kind !== 'car') bikeLaneL = bikeLaneR = false;
  if (oneway !== 0 && cl === 'lane' && !t['cycleway:both'] && !t['cycleway:left']) bikeLaneL = false; // usually only on the right of a oneway
  if (!parseWidth(t.width) && (bikeLaneL || bikeLaneR)) width += (bikeLaneL ? 1.5 : 0) + (bikeLaneR ? 1.5 : 0);

  const surface = t.surface ?? '';
  let mat;
  if (kind === 'car' || kind === 'bus') mat = roadMaterial(hw, surface, inside);
  else if (kind === 'ped') mat = surface === 'asphalt' ? 'asphalt' : 'klinkers';
  else if (kind === 'cycle') mat = KLINKER_SURF.has(surface) && inside ? 'klinkers' : UNPAVED_SURF.has(surface) ? 'ground' : 'bikelane';
  else {
    if (surface === 'grass') return null;
    mat = surface === 'asphalt' ? 'asphalt' : UNPAVED_SURF.has(surface) ? 'ground' : KLINKER_SURF.has(surface) ? (t.footway === 'sidewalk' ? 'sidewalk' : 'sidewalk') : 'sidewalk';
  }

  const access = t.access ?? '';
  const mv = t.motor_vehicle ?? t.motorcar ?? t.vehicle ?? '';
  let car = kind === 'car';
  if (['no', 'private', 'agricultural', 'forestry'].includes(mv) || ['no', 'private'].includes(access)) car = false;
  if (t.service === 'emergency_access') car = false;
  let bike = kind === 'cycle' || (kind === 'car' && !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(hw)) ||
    (kind === 'ped' && ['yes', 'designated', 'permissive'].includes(t.bicycle)) || (hw === 'path' && t.bicycle !== 'no') ||
    (kind === 'foot' && ['yes', 'designated'].includes(t.bicycle));
  if (t.bicycle === 'no' || t.bicycle === 'use_sidepath') bike = false;
  if (hw === 'steps') bike = false;
  let foot = kind === 'foot' || kind === 'ped' || hw === 'living_street' || (kind === 'car' && !['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(hw));
  if (t.foot === 'no' || t.foot === 'use_sidepath') foot = false;
  if (kind === 'cycle' && ['yes', 'designated'].includes(t.foot)) foot = true;

  let speedKmh = parseSpeedKmh(t.maxspeed);
  if (!Number.isFinite(speedKmh)) {
    if (kind === 'car') {
      if (hw === 'living_street') speedKmh = 15;
      else if (hw === 'service') speedKmh = 15;
      else if (inside) speedKmh = MAIN_TYPES.has(hw) ? 30 : 30;
      else speedKmh = MAIN_TYPES.has(hw) || hw === 'unclassified' ? 50 : 30;
      if (/singel|kade|weg$/i.test(t.name ?? '') && MAIN_TYPES.has(hw)) speedKmh = 50;
    } else if (kind === 'bus') speedKmh = 30;
    else if (kind === 'ped') speedKmh = 10;
    else if (kind === 'cycle') speedKmh = 20;
    else speedKmh = 5;
  }
  if (kind === 'car' && hw === 'living_street') speedKmh = Math.min(speedKmh, 15);

  const bridge = !!t.bridge && t.bridge !== 'no';
  const layer = Number.isFinite(Number(t.layer)) ? Number(t.layer) : bridge ? 1 : 0;
  const lanes = Math.max(1, Number.isFinite(lanesTag) ? Math.round(oneway ? lanesTag : lanesTag / 2) : 1);
  return {
    id: w.id, tags: t, nodes: w.nodes, pts: w.pts, hw, kind, width, mat, inside, oneway, car, bike, foot,
    speed: speedKmh / 3.6, bridge, layer, lanes, name: t.name, bikeLaneL, bikeLaneR,
    ...(shortTunnel ? { shortTunnel } : {}),
    park: kind === 'car' && !bridge ? { L: parkSide(t, 'left'), R: parkSide(t, 'right') } : { L: null, R: null },
  };
}

function polyRec(poly, extra = {}) {
  return { poly, bb: bboxOfPts(poly[0]), ...extra };
}

/** Extract all area and line features. */
export function extractFeatures(osm) {
  const water = [], grass = [], parking = [], squares = [], buildings = [], bridgeAreas = [], platforms = [], paved = [];
  const roads = [], rails = [], treeRows = [], barriers = [];
  const areaSources = [...osm.ways.filter((w) => w.closed), ...osm.rels];
  for (const f of areaSources) {
    const t = f.tags;
    const polys = areaPolys(f);
    if (!polys.length) continue;
    const isWater = (t.natural === 'water' && t.water !== 'wastewater' && t.intermittent !== 'yes') || t.waterway === 'riverbank' ||
      t.landuse === 'reservoir' || t.landuse === 'basin' || t.waterway === 'dock';
    if (isWater && t.tunnel !== 'culvert' && t.covered !== 'yes') {
      for (const p of polys) water.push(polyRec(p, { id: f.id }));
      continue;
    }
    if (t.man_made === 'bridge') {
      for (const p of polys) bridgeAreas.push(polyRec(p, { id: f.id, tags: t }));
      continue;
    }
    if (t.building && t.building !== 'no' && t.building !== 'roof' && !t['building:part']) {
      for (const p of polys) buildings.push(polyRec(p, { id: f.id, tags: t }));
      continue;
    }
    if ((t.highway === 'pedestrian' && (t.area === 'yes' || f.polys)) || t.place === 'square' || t['area:highway'] === 'pedestrian' || t.amenity === 'marketplace') {
      if (t.bridge && t.bridge !== 'no') continue;
      for (const p of polys) squares.push(polyRec(p, { id: f.id, mat: 'square', low: true, name: t.name }));
      continue;
    }
    if ((t.highway === 'footway' && t.area === 'yes') || t['area:highway'] === 'footway') {
      for (const p of polys) squares.push(polyRec(p, { id: f.id, mat: 'sidewalk', low: false }));
      continue;
    }
    if (t.highway === 'service' && t.area === 'yes') {
      for (const p of polys) parking.push(polyRec(p, { id: f.id }));
      continue;
    }
    if ((t.railway === 'platform' || t.public_transport === 'platform') && f.closed) {
      for (const p of polys) platforms.push(polyRec(p, { id: f.id, rail: t.railway === 'platform' }));
      continue;
    }
    if (t.amenity === 'parking' && !['multi-storey', 'underground', 'rooftop', 'carports', 'garage_boxes'].includes(t.parking) && t.location !== 'underground') {
      for (const p of polys) parking.push(polyRec(p, { id: f.id, tags: t }));
      continue;
    }
    // paved land use: no generated back gardens inside
    if (['industrial', 'commercial', 'retail', 'railway', 'construction', 'garages', 'depot', 'brownfield', 'military'].includes(t.landuse) ||
      ['school', 'university', 'college', 'hospital', 'fuel', 'bus_station', 'place_of_worship', 'townhall', 'prison', 'fire_station', 'police'].includes(t.amenity) ||
      ['playground', 'sports_centre', 'stadium', 'marina'].includes(t.leisure) || t.man_made === 'works' || t.power === 'substation' || t.railway === 'station') {
      for (const p of polys) paved.push(polyRec(p, { id: f.id }));
    }
    const green =
      ['grass', 'meadow', 'village_green', 'recreation_ground', 'cemetery', 'forest', 'flowerbed', 'greenfield', 'allotments', 'orchard', 'plant_nursery', 'farmland', 'grave_yard'].includes(t.landuse) ||
      ['park', 'garden', 'dog_park', 'golf_course', 'common', 'nature_reserve'].includes(t.leisure) ||
      (t.leisure === 'pitch' && (!t.surface || t.surface === 'grass')) ||
      ['grassland', 'scrub', 'wood', 'heath', 'wetland', 'shrubbery'].includes(t.natural) || t.amenity === 'grave_yard';
    if (green) {
      const kind = ['forest'].includes(t.landuse) || t.natural === 'wood' ? 'wood' : t.leisure === 'park' ? 'park' : 'grass';
      for (const p of polys) if (polyArea(p) > 1) grass.push(polyRec(p, { id: f.id, kind, name: t.name }));
    }
  }
  for (const w of osm.ways) {
    const t = w.tags;
    if (t.highway) {
      const r = classifyHighway(w);
      if (r) roads.push(r);
    }
    if (['rail', 'light_rail', 'tram', 'narrow_gauge'].includes(t.railway) && t.tunnel !== 'yes' && !t.area) {
      rails.push({ id: w.id, pts: w.pts, nodes: w.nodes, bridge: !!t.bridge && t.bridge !== 'no', tags: t });
    }
    if (t.natural === 'tree_row') treeRows.push({ id: w.id, pts: w.pts });
    if (t.barrier) barriers.push({ id: w.id, pts: w.pts, tags: t });
  }
  // short open-air 'tunnels' that actually pass under railway tracks stay out (no underpass geometry)
  const crossesRail = (r) => rails.some((q) => {
    for (let i = 1; i < r.pts.length; i++) for (let j = 1; j < q.pts.length; j++) if (segIntersectT(r.pts[i - 1], r.pts[i], q.pts[j - 1], q.pts[j]) !== null) return true;
    return false;
  });
  // ... and so do dead-end ones (garage ramps): both ends must join ordinary roads
  const endUse = new Map();
  for (const r of roads) if (!r.shortTunnel) for (const n of r.nodes) endUse.set(n, true);
  const roadsOut = roads.filter((r) => !r.shortTunnel || (!crossesRail(r) && endUse.has(r.nodes[0]) && endUse.has(r.nodes[r.nodes.length - 1])));
  return { water, grass, parking, squares, buildings, bridgeAreas, platforms, paved, roads: roadsOut, rails, treeRows, barriers };
}
