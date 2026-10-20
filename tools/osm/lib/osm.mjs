// Loads the cached Overpass JSON (data-raw/osm/*.json), projects everything to local metres and
// assembles multipolygon relations into polygons. The JSON is untrusted data: only parsed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toLocal } from './proj.mjs';
import { normalizePoly, openRing, pointInRing, ringArea } from './geom.mjs';

const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

/** Join open member ways into closed rings. Returns open-represented rings. */
function assembleRings(parts) {
  const rings = [];
  const open = [];
  for (const p of parts) {
    if (p.length < 2) continue;
    if (key(p[0]) === key(p[p.length - 1])) rings.push(p.slice(0, -1));
    else open.push(p.slice());
  }
  while (open.length) {
    let cur = open.pop();
    let progress = true;
    while (progress && key(cur[0]) !== key(cur[cur.length - 1])) {
      progress = false;
      const end = key(cur[cur.length - 1]);
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        if (key(o[0]) === end) { cur = cur.concat(o.slice(1)); open.splice(i, 1); progress = true; break; }
        if (key(o[o.length - 1]) === end) { cur = cur.concat(o.slice(0, -1).reverse()); open.splice(i, 1); progress = true; break; }
      }
    }
    if (key(cur[0]) === key(cur[cur.length - 1]) && cur.length >= 4) rings.push(cur.slice(0, -1));
  }
  return rings.map(openRing).filter((r) => r.length >= 3);
}

function relationPolygons(rel) {
  const outers = [];
  const inners = [];
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    const pts = m.geometry.filter(Boolean).map((g) => toLocal(g.lat, g.lon));
    (m.role === 'inner' ? inners : outers).push(pts);
  }
  const oRings = assembleRings(outers);
  const iRings = assembleRings(inners);
  const polys = oRings.map((r) => [r]);
  for (const h of iRings) {
    const p0 = h[0];
    // assign to the smallest outer containing it
    let best = null, bestA = Infinity;
    for (const poly of polys) {
      if (pointInRing(p0[0], p0[1], poly[0])) {
        const a = Math.abs(ringArea(poly[0]));
        if (a < bestA) { bestA = a; best = poly; }
      }
    }
    if (best) best.push(h);
  }
  return polys.map(normalizePoly);
}

/**
 * @returns {{ ways: Array<{id:number,tags:Record<string,string>,nodes:number[],pts:[number,number][],closed:boolean}>,
 *            rels: Array<{id:number,tags:Record<string,string>,polys:any[]}>,
 *            nodes: Array<{id:number,tags:Record<string,string>,x:number,z:number}>,
 *            nodePos: Map<number,[number,number]> }}
 */
export function loadOsm(rawDir) {
  const wj = JSON.parse(readFileSync(resolve(rawDir, 'ways.json'), 'utf8'));
  const nj = JSON.parse(readFileSync(resolve(rawDir, 'nodes.json'), 'utf8'));
  const ways = [];
  const rels = [];
  const nodePos = new Map();
  for (const e of wj.elements) {
    if (e.type === 'way') {
      if (!Array.isArray(e.geometry) || !Array.isArray(e.nodes) || e.geometry.length !== e.nodes.length) continue;
      const pts = e.geometry.map((g) => toLocal(g.lat, g.lon));
      e.nodes.forEach((id, k) => nodePos.set(id, pts[k]));
      ways.push({ id: e.id, tags: e.tags ?? {}, nodes: e.nodes, pts, closed: e.nodes.length > 3 && e.nodes[0] === e.nodes[e.nodes.length - 1] });
    } else if (e.type === 'relation') {
      const polys = relationPolygons(e);
      if (polys.length) rels.push({ id: e.id, tags: e.tags ?? {}, polys });
    }
  }
  const nodes = [];
  for (const e of nj.elements) {
    if (e.type !== 'node' || typeof e.lat !== 'number') continue;
    const [x, z] = toLocal(e.lat, e.lon);
    nodes.push({ id: e.id, tags: e.tags ?? {}, x, z });
  }
  ways.sort((a, b) => a.id - b.id);
  rels.sort((a, b) => a.id - b.id);
  nodes.sort((a, b) => a.id - b.id);
  return { ways, rels, nodes, nodePos };
}

/** Polygon(s) of an area feature (closed way or multipolygon relation). */
export function areaPolys(feature) {
  if (feature.polys) return feature.polys;
  if (!feature.closed) return [];
  return [normalizePoly([feature.pts])];
}
