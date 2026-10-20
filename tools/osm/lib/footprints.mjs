// 3D BAG building footprints (public/data/footprints.json, written by the BAG pipeline): what is
// actually rendered and collides in the game. Used to keep car traffic out of buildings.
import { readFileSync, existsSync } from 'node:fs';
import RBush from 'rbush';
import { bboxOfPts, cumLengths, pointAt, pointInRing } from './geom.mjs';

/** Load footprint rings into an RBush index; null when the BAG output is not there yet. */
export function loadFootprintIndex(file) {
  if (!existsSync(file)) return null;
  const rings = JSON.parse(readFileSync(file, 'utf8')).rings ?? [];
  const tree = new RBush();
  tree.load(rings.map((ring) => {
    const bb = bboxOfPts(ring);
    return { minX: bb[0], minY: bb[1], maxX: bb[2], maxY: bb[3], ring };
  }));
  return tree;
}

/** Is (x, z) inside any footprint of the index? */
export function inFootprint(tree, x, z) {
  for (const h of tree.search({ minX: x, minY: z, maxX: x, maxY: z })) if (pointInRing(x, z, h.ring)) return true;
  return false;
}

/** Fraction of a polyline (sampled every `step` m) that lies inside footprints. */
export function insideFraction(tree, pts, step = 1) {
  const cum = cumLengths(pts), L = cum[cum.length - 1];
  if (!(L > 0)) return 0;
  let n = 0, k = 0;
  for (let s = Math.min(step / 2, L / 2); s < L; s += step) {
    const p = pointAt(pts, cum, s);
    n++;
    if (inFootprint(tree, p.x, p.z)) k++;
  }
  return n ? k / n : 0;
}
