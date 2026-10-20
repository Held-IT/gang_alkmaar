// Reads the cached 3D BAG pages (data-raw/bag/pages/*.json.gz) and turns CityJSONFeatures into
// compact building records in local world coordinates (see ARCHITECTURE section 2).
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ORIGIN_RD, PAGES_DIR } from './config.mjs';
import { cleanRing, centroid2, signedArea2 } from './geom.mjs';

/**
 * @typedef {{ type: string, onEdge: boolean, rings: number[][][] }} Surface
 *   rings: [outer, ...holes] of [x, y, z] local coords, y relative to the building's maaiveld.
 * @typedef {{
 *   id: string, attrs: Record<string, any>, maaiveld: number,
 *   footprint: number[][][],   // [outer, ...holes] of [x, z] (local); orientation as in the source
 *   centroid: [number, number], area: number,
 *   lods: Record<string, Surface[]>,
 * }} Building
 */

const KEEP_ATTRS = [
  'b3_h_maaiveld', 'b3_dak_type', 'b3_bouwlagen', 'oorspronkelijkbouwjaar', 'b3_h_dak_min',
  'b3_h_dak_50p', 'b3_h_dak_70p', 'b3_h_dak_max', 'b3_h_nok', 'status', 'b3_opp_grond',
];

/** Flatten CityJSON geometry boundaries to a list of { rings, semIdx }. */
function surfacesOf(g) {
  const out = [];
  const sem = g.semantics;
  if (g.type === 'Solid') {
    g.boundaries.forEach((shell, si) => {
      shell.forEach((surf, k) => out.push({ rings: surf, sem: sem?.values?.[si]?.[k] ?? null }));
    });
  } else if (g.type === 'MultiSurface' || g.type === 'CompositeSurface') {
    g.boundaries.forEach((surf, k) => out.push({ rings: surf, sem: sem?.values?.[k] ?? null }));
  } else if (g.type === 'MultiSolid' || g.type === 'CompositeSolid') {
    g.boundaries.forEach((solid, so) => {
      solid.forEach((shell, si) => {
        shell.forEach((surf, k) => out.push({ rings: surf, sem: sem?.values?.[so]?.[si]?.[k] ?? null }));
      });
    });
  }
  return out.map((s) => ({ ...s, semObj: s.sem == null ? null : sem.surfaces[s.sem] }));
}

/** Iterate every page file in the cache (sorted for determinism). */
export function listPages() {
  return readdirSync(PAGES_DIR).filter((f) => f.endsWith('.json.gz')).sort();
}

/**
 * Load all buildings. `wantLods(centroidX, centroidZ)` returns the LoD keys to convert for a
 * building (e.g. ['2.2','1.2']) or null to skip it entirely.
 * @returns {Map<string, Building>}
 */
export function loadBuildings(wantLods, { log = console.log } = {}) {
  const pages = listPages();
  const buildings = new Map();
  let nFeat = 0;
  for (const file of pages) {
    const page = JSON.parse(gunzipSync(readFileSync(resolve(PAGES_DIR, file))).toString('utf8'));
    const T = page.transform;
    if (!page.features?.length) continue;
    if (!T) throw new Error(`no transform in ${file}`);
    const [sx, sy, sz] = T.scale;
    const [tx, ty, tz] = T.translate;
    for (const f of page.features) {
      nFeat++;
      if (buildings.has(f.id)) continue;
      const bobj = f.CityObjects[f.id];
      if (!bobj || bobj.type !== 'Building') continue;
      const a = bobj.attributes ?? {};
      const maaiveld = Number.isFinite(a.b3_h_maaiveld) ? a.b3_h_maaiveld : null;
      const V = f.vertices;
      // local coords of vertex i (y relative to maaiveld)
      const mv = maaiveld ?? 0;
      const vx = (i) => V[i][0] * sx + tx - ORIGIN_RD.x;
      const vz = (i) => -(V[i][1] * sy + ty - ORIGIN_RD.y);
      const vy = (i) => V[i][2] * sz + tz - mv;
      // Footprint from LoD 0 (MultiSurface of 1 polygon, sometimes more).
      const lod0 = (bobj.geometry ?? []).find((g) => g.lod === '0');
      if (!lod0) continue;
      const fpSurfs = surfacesOf(lod0);
      let best = null;
      for (const s of fpSurfs) {
        const rings = s.rings.map((r) => cleanRing(r.map((i) => [vx(i), vz(i)])));
        if (rings[0].length < 3) continue;
        const area = Math.abs(signedArea2(rings[0]));
        if (!best || area > best.area) best = { rings, area };
      }
      if (!best) continue;
      const footprint = best.rings;
      const centroid = centroid2(footprint[0]);
      const want = wantLods(centroid[0], centroid[1]);
      if (!want) continue;
      const attrs = {};
      for (const k of KEEP_ATTRS) if (a[k] !== undefined) attrs[k] = a[k];
      /** @type {Building} */
      const b = { id: f.id, attrs, maaiveld: mv, footprint, centroid, area: best.area, lods: {} };
      // Note: extra footprint polygons (rare) are ignored for party-wall tests.
      for (const childId of bobj.children ?? []) {
        const part = f.CityObjects[childId];
        if (!part) continue;
        for (const g of part.geometry ?? []) {
          if (!want.includes(g.lod)) continue;
          const list = (b.lods[g.lod] ??= []);
          for (const s of surfacesOf(g)) {
            const rings = s.rings.map((r) => cleanRing(r.map((i) => [vx(i), vy(i), vz(i)])));
            if (rings[0].length < 3) continue;
            list.push({ type: s.semObj?.type ?? 'Unknown', onEdge: s.semObj?.on_footprint_edge !== false, rings });
          }
        }
      }
      buildings.set(f.id, b);
    }
  }
  log(`loaded ${pages.length} pages, ${nFeat} features, ${buildings.size} unique buildings selected`);
  return buildings;
}
