// osm-meta.json (OsmMeta: playable rect, spawn points, landmarks, ground files, attribution)
// and map2d.json (Map2D: water + parks for the minimap).
import { clipRingRect, simplifyRing, openRing, ringArea, pointInRing, round, cumLengths, pointAt, leftN, segDist2 } from './geom.mjs';
import { inFootprint } from './footprints.mjs';

const r1 = (v) => round(v, 1);

function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return ring[0];
  return [cx / (3 * a), cz / (3 * a)];
}

/** Heading (contract convention) of the long axis of the minimum-area bounding rectangle. */
function mainAxisHeading(ring) {
  let best = { area: Infinity, ang: 0, len: 0, wid: 0 };
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const v of ring) {
      const a = v[0] * c + v[1] * s, b = -v[0] * s + v[1] * c;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (area < best.area) best = { area, ang, len: a1 - a0, wid: b1 - b0 };
  }
  let ang = best.ang;
  if (best.wid > best.len) ang += Math.PI / 2;
  const dx = Math.cos(ang), dz = Math.sin(ang);
  let h = Math.atan2(dx, dz);
  if (h < 0) h += Math.PI; // axis, not direction: keep in [0, PI)
  return h;
}

export function buildMeta({ osm, F, graph, playable, groundFiles, loc, footprints }) {
  const byWayId = new Map(osm.ways.map((w) => [w.id, w]));
  const bldgContaining = (x, z) => {
    let best = null, bestA = Infinity;
    for (const b of F.buildings) {
      if (x < b.bb[0] || x > b.bb[2] || z < b.bb[1] || z > b.bb[3]) continue;
      if (pointInRing(x, z, b.poly[0])) { const a = Math.abs(ringArea(b.poly[0])); if (a < bestA) { bestA = a; best = b; } }
    }
    return best;
  };
  const findWay = (pred) => osm.ways.find((w) => w.closed && pred(w.tags));
  const lm = [];
  const addFromRing = (id, name, ring) => {
    const r = openRing(ring);
    const c = centroid(r);
    lm.push({ id, name, x: round(c[0]), z: round(c[1]), rotation: round(mainAxisHeading(r), 4), footprint: r.map((p) => [round(p[0]), round(p[1])]) });
  };
  const defs = [
    ['waag', 'De Waag', (t) => t.name === 'Waag' && t.building],
    ['grote_kerk', 'Grote of Sint-Laurenskerk', (t) => t.name === 'Grote of Sint-Laurenskerk' && t.building],
    ['molen_van_piet', 'Molen van Piet', (t) => t.man_made === 'windmill' && t.name === 'Molen van Piet'],
    ['accijnstoren', 'Accijnstoren', (t) => t.name === 'Accijnstoren'],
    ['kapelkerk', 'Kapelkerk', (t) => t.name === 'Kapelkerk' && t.building],
    ['sint_laurentiuskerk', 'Sint-Laurentiuskerk', (t) => t.name === 'Sint-Laurentiuskerk' && t.building === 'church' && t['addr:street'] === 'Verdronkenoord'],
  ];
  for (const [id, name, pred] of defs) {
    const w = findWay(pred);
    if (w) addFromRing(id, name, w.pts);
    else console.warn(`[meta] landmark ${id} not found`);
  }
  const th = osm.nodes.find((n) => n.tags.amenity === 'townhall' && /Stadhuis Alkmaar/.test(n.tags.name ?? ''));
  if (th) {
    const b = bldgContaining(th.x, th.z);
    if (b) addFromRing('stadhuis', 'Stadhuis', b.poly[0]);
    else lm.push({ id: 'stadhuis', name: 'Stadhuis', x: round(th.x), z: round(th.z) });
  }
  const st = osm.nodes.find((n) => n.tags.railway === 'station' && n.tags.name === 'Alkmaar');
  if (st) {
    const b = bldgContaining(st.x, st.z);
    if (b) addFromRing('station', 'Station Alkmaar', b.poly[0]);
    else lm.push({ id: 'station', name: 'Station Alkmaar', x: round(st.x), z: round(st.z) });
  }
  void byWayId;

  // ---- spawn points: on the main car network, heading along the road with >= RUN m of open,
  // flush surface straight ahead (no water, quay, kerb or building: holding W must be safe), and
  // facing the landmark with a clear line of sight where the spawn is named after one
  const RUN = 45;
  const drivable = (x, z) => {
    if (x < playable.minX + 3 || x > playable.maxX - 3 || z < playable.minZ + 3 || z > playable.maxZ - 3) return false;
    if (footprints && inFootprint(footprints, x, z)) return false;
    if (!loc) return true;
    const r = loc.locate(x, z);
    if (!r) return false;
    if (r.kind === 'deck') return r.deck?.kind === 'car' || r.deck?.kind === 'bus';
    return r.kind === 'low' && r.layer !== 'parking';
  };
  const clearRun = (x, z, dx, dz, max = RUN) => {
    const [rx, rz] = leftN(dx, dz);
    for (let d = 0; d <= max; d += 1) for (const l of [-1, 0, 1]) if (!drivable(x + dx * d + rx * l, z + dz * d + rz * l)) return d;
    return max;
  };
  // biggest car component the PLAYER can drive (edges inside the playable rect: the connectors in
  // the detail margin are behind the invisible walls); a spawn in a pocket would trap the player
  const inRectP = (p) => p[0] >= playable.minX - 0.05 && p[0] <= playable.maxX + 0.05 && p[1] >= playable.minZ - 0.05 && p[1] <= playable.maxZ + 0.05;
  const parent = graph.nodes.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const playerCar = graph.edges.filter((e) => e.car && e.pts.every(inRectP));
  for (const e of playerCar) parent[find(e.a)] = find(e.b);
  const compLen = new Map();
  for (const e of playerCar) compLen.set(find(e.a), (compLen.get(find(e.a)) ?? 0) + e.len);
  const mainC = [...compLen].sort((p, q) => q[1] - p[1])[0]?.[0];
  const inPlay = (p) => p[0] > playable.minX + 10 && p[0] < playable.maxX - 10 && p[1] > playable.minZ + 10 && p[1] < playable.maxZ - 10;
  const carEdges = graph.edges.filter((e) => e.car && !e.bridge && e.len > 20 && e.type !== 'service' && find(e.a) === mainC && e.pts.every(inPlay));
  /** spawn candidates every 2 m along the edges (both directions on two-way roads, keep right) */
  const candidates = (filter) => {
    const out = [];
    for (const e of carEdges) {
      if (!filter(e)) continue;
      const cum = cumLengths(e.pts);
      for (let s = 8; s <= e.len - 8; s += 2) {
        const p = pointAt(e.pts, cum, s);
        for (const dir of e.oneway ? [1] : [1, -1]) {
          const dx = p.dx * dir, dz = p.dz * dir;
          const [rx, rz] = leftN(dx, dz); // driver's right in the (x,z) plane
          const off = e.oneway ? 0 : Math.min(1.6, e.width / 4);
          out.push({ x: p.x + rx * off, z: p.z + rz * off, dx, dz, e });
        }
      }
    }
    return out;
  };
  const distToRing = (x, z, r) => {
    let d = Infinity;
    for (let i = 0; i < r.length; i++) d = Math.min(d, Math.sqrt(segDist2(x, z, r[i][0], r[i][1], r[(i + 1) % r.length][0], r[(i + 1) % r.length][1]).d2));
    return d;
  };
  /** no (other) building between the spawn and the landmark */
  const losClear = (x, z, lmk) => {
    const D = Math.hypot(lmk.x - x, lmk.z - z);
    for (let s = 3; s < D; s += 1) {
      const px = x + ((lmk.x - x) * s) / D, pz = z + ((lmk.z - z) * s) / D;
      if (lmk.footprint ? pointInRing(px, pz, lmk.footprint) || distToRing(px, pz, lmk.footprint) < 3 : D - s < 8) return true;
      if (footprints && inFootprint(footprints, px, pz)) return false;
    }
    return true;
  };
  const pick = (ranked, lmk) => {
    for (const c of ranked) if (clearRun(c.x, c.z, c.dx, c.dz) >= RUN && (!lmk || losClear(c.x, c.z, lmk))) return c;
    return null;
  };
  /** facing the landmark (within maxAng, 30..170 m away), else the nearest safe spot */
  const spawnFacing = (lmk, filter = () => true) => {
    const cand = candidates(filter);
    for (const maxAng of [30, 50]) {
      const ranked = [];
      for (const c of cand) {
        const vx = lmk.x - c.x, vz = lmk.z - c.z, D = Math.hypot(vx, vz);
        if (D < 30 || D > 170) continue;
        const ang = (Math.acos(Math.max(-1, Math.min(1, (vx * c.dx + vz * c.dz) / D))) * 180) / Math.PI;
        if (ang > maxAng) continue;
        ranked.push({ ...c, score: ang * 1.2 + Math.abs(D - 70) * 0.4 });
      }
      const best = pick(ranked.sort((p, q) => p.score - q.score), lmk);
      if (best) return best;
    }
    return spawnNear(lmk.x, lmk.z, filter);
  };
  const spawnNear = (x, z, filter = () => true) => pick(candidates(filter).map((c) => ({ ...c, score: Math.hypot(c.x - x, c.z - z) })).sort((p, q) => p.score - q.score), null);
  const L = Object.fromEntries(lm.map((l) => [l.id, l]));
  const spawns = [];
  const add = (id, name, s) => {
    if (s) spawns.push({ id, name, x: round(s.x), z: round(s.z), heading: round(Math.atan2(s.dx, s.dz), 4) });
    else console.warn(`[meta] no spawn for ${id}`);
  };
  if (L.waag) add('waag', 'De Waag', spawnFacing(L.waag));
  if (L.grote_kerk) add('grote_kerk', 'Grote Kerk', spawnFacing(L.grote_kerk));
  const stL = L.station ?? (st && { x: st.x, z: st.z });
  if (stL) add('station', 'Station Alkmaar', spawnFacing(stL, (e) => e.type !== 'busway'));
  if (L.molen_van_piet) add('molen', 'Molen van Piet', spawnFacing(L.molen_van_piet));
  {
    // longest car edge on a singel street
    const singel = carEdges.filter((e) => /singel$/i.test(e.name ?? '')).sort((a, b) => b.len - a.len)[0];
    if (singel) { const c = pointAt(singel.pts, cumLengths(singel.pts), singel.len / 2); add('singel', 'Singel', spawnNear(c.x, c.z, (e) => /singel$/i.test(e.name ?? ''))); }
  }
  {
    const vo = carEdges.filter((e) => e.name === 'Verdronkenoord').sort((a, b) => b.len - a.len)[0];
    if (vo) { const c = pointAt(vo.pts, cumLengths(vo.pts), vo.len / 2); add('verdronkenoord', 'Verdronkenoord', spawnNear(c.x, c.z, (e) => e.name === 'Verdronkenoord')); }
  }
  for (const s of spawns) console.log(`[meta] spawn ${s.id}: (${s.x}, ${s.z}) heading ${s.heading}`);
  return {
    playable,
    spawnPoints: spawns,
    groundFiles,
    landmarks: lm,
    attribution: 'Kaartdata © OpenStreetMap-bijdragers (ODbL)',
  };
}

export function buildMap2D(F, waterAll, bounds) {
  const clipSimplify = (poly, tol) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      let r = clipRingRect(openRing(poly[i]), bounds);
      if (r.length < 3) { if (i === 0) return null; continue; }
      r = simplifyRing(r, tol);
      if (Math.abs(ringArea(r)) < (i === 0 ? 20 : 5)) { if (i === 0) return null; continue; }
      out.push(r.map((p) => [r1(p[0]), r1(p[1])]));
    }
    return out.length ? out : null;
  };
  const water = [];
  for (const w of waterAll) { const p = clipSimplify(w.poly, 0.8); if (p) water.push(p); }
  const parks = [];
  for (const g of F.grass) { const p = clipSimplify(g.poly, 1.0); if (p) parks.push(p); }
  return { water, parks, bounds };
}
