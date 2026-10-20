// Procedural trees: Dutch canal lindens / elms (kind 0), small ornamental trees (kind 1) and
// conifers (kind 2). Each variant has three LOD levels:
//   LOD0  trunk + main + secondary branches (tubes, bark texture) and ~250 leaf cards
//   LOD1  simplified skeleton and ~90 larger leaf cards
//   LOD2  crossed-quad impostor rendered at startup from LOD0 (render-to-texture)
// Leaf cards carry crown-shaped normals (volume shading instead of flat cards) and baked AO in
// the vertex colour; wind sway + leaf flutter run in the vertex shader (propMaterial wind).
import * as THREE from 'three';
import { Rng } from './util/rng';
import { MeshBuilder, sweep, triCount } from './util/geom';
import { createPropDepthMaterial, createPropMaterial } from './util/propMaterial';
import { getBarkTextures, getLeafAtlas, leafCellRect } from './treeTextures';
import type { BatchLod } from './util/batch';

export interface TreeVariantSpec {
  name: string;
  kind: 0 | 1 | 2;
  seed: number;
  /** model height in metres (instances are scaled to the requested height) */
  height: number;
  /** height of the first main branches */
  trunkHeight: number;
  trunkRadius: number;
  /** crown ellipsoid: centre height and radii */
  crownY: number;
  crownR: number;
  crownRy: number;
  /** leader (trunk continuation) reaches this fraction of the height */
  leader: number;
  mainCount: number;
  /** angle of the main branches from vertical, degrees [lowest, highest] */
  mainAngle: [number, number];
  /** upward bending of main branches (0..1) and gravity droop */
  bendUp: number;
  droop: number;
  secPerMain: number;
  twigCell: number;
  fillCell: number;
  cardSize: [number, number];
  cardsPerAnchor: number;
  /** foliage clumps at branch tips: cards per clump and clump radius range (m) */
  clumpCards: number;
  clumpR: [number, number];
  innerCards: number;
  /** wind sway amplitude at the top (m) */
  sway: number;
}

export const TREE_VARIANTS: TreeVariantSpec[] = [
  {
    name: 'linde_a', kind: 0, seed: 11, height: 14, trunkHeight: 3.6, trunkRadius: 0.31,
    crownY: 8.6, crownR: 4.9, crownRy: 5.3, leader: 0.78, mainCount: 9, mainAngle: [62, 24],
    bendUp: 0.45, droop: 0.25, secPerMain: 5, twigCell: 0, fillCell: 1, cardSize: [1.5, 2.1],
    cardsPerAnchor: 1, clumpCards: 7, clumpR: [1.25, 1.95], innerCards: 26, sway: 0.16,
  },
  {
    name: 'linde_b', kind: 0, seed: 23, height: 14, trunkHeight: 4.0, trunkRadius: 0.29,
    crownY: 9.0, crownR: 4.2, crownRy: 5.0, leader: 0.85, mainCount: 10, mainAngle: [55, 20],
    bendUp: 0.55, droop: 0.15, secPerMain: 5, twigCell: 0, fillCell: 1, cardSize: [1.4, 2.0],
    cardsPerAnchor: 1, clumpCards: 7, clumpR: [1.2, 1.8], innerCards: 26, sway: 0.16,
  },
  {
    name: 'sierboom_a', kind: 1, seed: 37, height: 6.5, trunkHeight: 1.9, trunkRadius: 0.13,
    crownY: 4.3, crownR: 2.6, crownRy: 2.2, leader: 0.6, mainCount: 6, mainAngle: [65, 35],
    bendUp: 0.35, droop: 0.1, secPerMain: 4, twigCell: 2, fillCell: 2, cardSize: [0.9, 1.3],
    cardsPerAnchor: 1, clumpCards: 6, clumpR: [0.75, 1.15], innerCards: 14, sway: 0.1,
  },
  {
    name: 'sierboom_b', kind: 1, seed: 41, height: 6.5, trunkHeight: 2.2, trunkRadius: 0.12,
    crownY: 4.5, crownR: 2.1, crownRy: 2.0, leader: 0.7, mainCount: 6, mainAngle: [55, 25],
    bendUp: 0.4, droop: 0.05, secPerMain: 4, twigCell: 2, fillCell: 2, cardSize: [0.9, 1.25],
    cardsPerAnchor: 1, clumpCards: 6, clumpR: [0.7, 1.05], innerCards: 12, sway: 0.1,
  },
  {
    name: 'conifeer', kind: 2, seed: 53, height: 11, trunkHeight: 1.2, trunkRadius: 0.2,
    crownY: 5.4, crownR: 2.6, crownRy: 5.6, leader: 0.97, mainCount: 26, mainAngle: [95, 60],
    bendUp: 0.1, droop: 0.35, secPerMain: 2, twigCell: 3, fillCell: 3, cardSize: [1.2, 1.6],
    cardsPerAnchor: 1, clumpCards: 4, clumpR: [0.6, 0.95], innerCards: 10, sway: 0.08,
  },
];

interface Branch {
  pts: THREE.Vector3[];
  radii: number[];
  depth: number;
}

interface Card {
  center: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
  w: number;
  h: number;
  cell: number;
  tint: number;
  /** anchor at the bottom edge (twig) or centred (filler) */
  anchored: boolean;
  /** foliage clump this card belongs to (local volume shading) */
  clump?: { c: THREE.Vector3; r: number };
}

interface Skeleton {
  spec: TreeVariantSpec;
  branches: Branch[];
  twigCards: Card[];
  shellCards: Card[];
  center: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Distance along `dir` from `p` to the crown ellipsoid surface (or a default). */
function toCrownSurface(spec: TreeVariantSpec, p: THREE.Vector3, dir: THREE.Vector3): number {
  // conifers: cone-ish crown => shrink radius with height
  const rx = spec.crownR, ry = spec.crownRy;
  const ox = p.x, oy = p.y - spec.crownY, oz = p.z;
  const a = (dir.x * dir.x + dir.z * dir.z) / (rx * rx) + (dir.y * dir.y) / (ry * ry);
  const b = 2 * ((ox * dir.x + oz * dir.z) / (rx * rx) + (oy * dir.y) / (ry * ry));
  const c = (ox * ox + oz * oz) / (rx * rx) + (oy * oy) / (ry * ry) - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return 1;
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return Math.max(0.5, t);
}

function coneFactor(spec: TreeVariantSpec, y: number): number {
  if (spec.kind !== 2) return 1;
  // conifer silhouette: wide at the bottom of the crown, narrow at the top
  const t = THREE.MathUtils.clamp((y - spec.trunkHeight) / (spec.height - spec.trunkHeight), 0, 1);
  return 1.15 - t * 1.0;
}

function buildSkeleton(spec: TreeVariantSpec): Skeleton {
  const rng = new Rng(spec.seed * 7919);
  const branches: Branch[] = [];
  const twigCards: Card[] = [];
  const shellCards: Card[] = [];
  const H = spec.height;

  // trunk / leader
  const trunkTop = H * spec.leader;
  const trunk: Branch = { pts: [], radii: [], depth: 0 };
  const lean = new THREE.Vector3(rng.range(-0.04, 0.04), 1, rng.range(-0.04, 0.04)).normalize();
  const tSegs = Math.max(6, Math.round(trunkTop / 1.1));
  for (let i = 0; i <= tSegs; i++) {
    const t = i / tSegs;
    const y = t * trunkTop;
    const p = lean.clone().multiplyScalar(y);
    p.x += Math.sin(y * 0.9 + spec.seed) * 0.05 * t;
    p.z += Math.cos(y * 0.7 + spec.seed) * 0.05 * t;
    trunk.pts.push(p);
    const flare = y < 0.6 ? 1 + (0.6 - y) * 0.6 : 1;
    const taper = spec.kind === 2 ? 1 - t * 0.9 : y < spec.trunkHeight ? 1 - t * 0.25 : (1 - t) * 0.9 + 0.08;
    trunk.radii.push(spec.trunkRadius * flare * Math.max(0.12, taper));
  }
  branches.push(trunk);
  const trunkRadiusAt = (y: number) => {
    const t = THREE.MathUtils.clamp(y / trunkTop, 0, 1);
    const i = Math.min(tSegs, Math.round(t * tSegs));
    return trunk.radii[i];
  };
  const trunkPointAt = (y: number) => {
    const t = THREE.MathUtils.clamp(y / trunkTop, 0, 1) * tSegs;
    const i = Math.min(tSegs - 1, Math.floor(t));
    return trunk.pts[i].clone().lerp(trunk.pts[i + 1], t - i);
  };

  // main branches
  const mains: Branch[] = [];
  for (let k = 0; k < spec.mainCount; k++) {
    const t = spec.mainCount > 1 ? k / (spec.mainCount - 1) : 0.5;
    const y = spec.trunkHeight + t * (trunkTop * (spec.kind === 2 ? 0.98 : 0.95) - spec.trunkHeight) + rng.range(-0.25, 0.25);
    const az = k * 2.39996 + rng.range(-0.35, 0.35);
    const ang = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(spec.mainAngle[0], spec.mainAngle[1], t) + rng.range(-7, 7));
    let dir = new THREE.Vector3(Math.sin(ang) * Math.cos(az), Math.cos(ang), Math.sin(ang) * Math.sin(az)).normalize();
    const start = trunkPointAt(y);
    let L = toCrownSurface(spec, start, dir) * rng.range(0.72, 0.92);
    if (spec.kind === 2) L = spec.crownR * coneFactor(spec, y) * rng.range(0.75, 1.0);
    const segs = 6;
    const br: Branch = { pts: [start.clone()], radii: [], depth: 1 };
    const r0 = Math.min(trunkRadiusAt(y) * 0.62, spec.trunkRadius * (spec.kind === 2 ? 0.28 : 0.55) * (1 - t * 0.45));
    const p = start.clone();
    for (let s = 1; s <= segs; s++) {
      const f = s / segs;
      dir = dir.clone()
        .addScaledVector(UP, spec.bendUp * 0.25 - spec.droop * f * 0.35)
        .add(new THREE.Vector3(rng.range(-0.12, 0.12), rng.range(-0.08, 0.08), rng.range(-0.12, 0.12)))
        .normalize();
      p.addScaledVector(dir, L / segs);
      br.pts.push(p.clone());
    }
    // thick at the fork, thinning faster towards the tip (pipe-model like)
    for (let s = 0; s <= segs; s++) br.radii.push(Math.max(0.012, r0 * (1 - Math.pow(s / segs, 0.75) * 0.88)));
    mains.push(br);
    branches.push(br);
  }

  // secondary branches + twig cards
  const anchors: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  const tips: { p: THREE.Vector3; d: THREE.Vector3 }[] = [];
  for (const m of mains) {
    const n = m.pts.length;
    for (let s = 0; s < spec.secPerMain; s++) {
      const f = 0.3 + (s / Math.max(1, spec.secPerMain - 1)) * 0.6 + rng.range(-0.05, 0.05);
      const fi = f * (n - 1);
      const i = Math.min(n - 2, Math.floor(fi));
      const start = m.pts[i].clone().lerp(m.pts[i + 1], fi - i);
      const md = new THREE.Vector3().subVectors(m.pts[i + 1], m.pts[i]).normalize();
      const side = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.3, 0.6), rng.range(-1, 1)).normalize();
      side.addScaledVector(md, -side.dot(md)).normalize();
      let dir = md.clone().multiplyScalar(0.55).addScaledVector(side, 0.75).addScaledVector(UP, 0.18).normalize();
      const L = Math.min(toCrownSurface(spec, start, dir) * rng.range(0.7, 0.95), (spec.kind === 2 ? 1.2 : 3.2) * (spec.height / 14));
      const segs = 3;
      const br: Branch = { pts: [start.clone()], radii: [], depth: 2 };
      const r0 = Math.max(0.01, m.radii[i] * 0.55);
      const p = start.clone();
      for (let k = 1; k <= segs; k++) {
        dir = dir.clone().addScaledVector(UP, 0.12 - spec.droop * 0.15).add(new THREE.Vector3(rng.range(-0.15, 0.15), rng.range(-0.1, 0.1), rng.range(-0.15, 0.15))).normalize();
        p.addScaledVector(dir, L / segs);
        br.pts.push(p.clone());
      }
      for (let k = 0; k <= segs; k++) br.radii.push(Math.max(0.008, r0 * (1 - (k / segs) * 0.8)));
      branches.push(br);
      // thin tertiary twigs (LOD0 only) so the inside of the crown is not a few bare sticks
      if (spec.kind !== 2) {
        for (let k = 1; k <= segs; k++) {
          const tp = br.pts[k];
          const bd = new THREE.Vector3().subVectors(tp, br.pts[k - 1]).normalize();
          const sd = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.2, 0.7), rng.range(-1, 1)).normalize();
          sd.addScaledVector(bd, -sd.dot(bd)).normalize();
          const td = bd.clone().multiplyScalar(0.5).addScaledVector(sd, 0.85).normalize();
          const tl = rng.range(0.6, 1.3) * (spec.height / 14);
          const tw: Branch = { pts: [tp.clone()], radii: [], depth: 3 };
          const q = tp.clone();
          for (let j = 1; j <= 2; j++) {
            td.addScaledVector(UP, 0.1 - spec.droop * 0.2).normalize();
            q.addScaledVector(td, tl / 2);
            tw.pts.push(q.clone());
          }
          const tr = Math.max(0.006, br.radii[k] * 0.6);
          tw.radii.push(tr, tr * 0.6, tr * 0.25);
          branches.push(tw);
        }
      }
      // twig cards along the outer part of the secondary branch, a clump at its tip
      for (let k = 2; k <= segs; k++) {
        const d = new THREE.Vector3().subVectors(br.pts[k], br.pts[k - 1]).normalize();
        anchors.push({ p: br.pts[k].clone(), d });
      }
      tips.push({ p: br.pts[segs].clone(), d: new THREE.Vector3().subVectors(br.pts[segs], br.pts[segs - 1]).normalize() });
    }
    tips.push({ p: m.pts[n - 1].clone(), d: new THREE.Vector3().subVectors(m.pts[n - 1], m.pts[n - 2]).normalize() });
  }
  const center = new THREE.Vector3(0, spec.crownY, 0);
  const [cMin, cMax] = spec.cardSize;
  for (const a of anchors) {
    for (let c = 0; c < spec.cardsPerAnchor + (rng.chance(0.5) ? 1 : 0); c++) {
      const up = a.d.clone().multiplyScalar(0.6)
        .add(new THREE.Vector3(rng.range(-0.7, 0.7), rng.range(-0.3, 0.8), rng.range(-0.7, 0.7)))
        .normalize();
      if (spec.kind === 2) up.y = Math.min(up.y, 0.25); // needle sprays mostly horizontal
      up.normalize();
      const rnd = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
      const right = new THREE.Vector3().crossVectors(up, rnd).normalize();
      const s = rng.range(cMin, cMax);
      const centerP = a.p.clone().addScaledVector(up, s * 0.42).add(new THREE.Vector3(rng.range(-0.2, 0.2), rng.range(-0.2, 0.2), rng.range(-0.2, 0.2)));
      twigCards.push({ center: centerP, up, right, w: s, h: s, cell: spec.twigCell, tint: rng.range(0.85, 1.12), anchored: true });
    }
  }
  // foliage clumps at the branch tips: each a loose ball of cards with its own volume shading,
  // which gives the crown the typical cauliflower structure instead of one smooth blob
  for (const t of tips) {
    const R = rng.range(spec.clumpR[0], spec.clumpR[1]);
    const c = t.p.clone().addScaledVector(t.d, R * 0.35);
    if (c.y < spec.trunkHeight + R * 0.6) c.y = spec.trunkHeight + R * 0.6;
    const clump = { c, r: R };
    for (let k = 0; k < spec.clumpCards; k++) {
      const dir = new THREE.Vector3(rng.normal(), rng.normal() * 0.8 + 0.25, rng.normal()).normalize();
      const p = c.clone().addScaledVector(dir, R * rng.range(0.25, 0.85));
      const up = dir.clone().multiplyScalar(0.55).add(new THREE.Vector3(rng.range(-0.6, 0.6), rng.range(-0.2, 0.9), rng.range(-0.6, 0.6))).normalize();
      if (spec.kind === 2) { up.y = Math.min(up.y, 0.2); up.normalize(); }
      const rnd = new THREE.Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).normalize();
      const right = new THREE.Vector3().crossVectors(up, rnd).normalize();
      const sz = rng.range(cMin, cMax) * (0.8 + R / spec.clumpR[1] * 0.35);
      const cell = rng.chance(0.65) ? spec.fillCell : spec.twigCell;
      shellCards.push({ center: p, up, right, w: sz, h: sz, cell, tint: rng.range(0.86, 1.1), anchored: false, clump });
    }
  }
  // a few filler cards deep inside so the crown is not hollow
  for (let k = 0; k < spec.innerCards; k++) {
    const dir = new THREE.Vector3(rng.normal(), rng.normal() * 0.7, rng.normal()).normalize();
    const rr = rng.range(0.3, 0.65);
    const y = Math.max(spec.trunkHeight + 0.6, spec.crownY + dir.y * spec.crownRy * rr);
    const cf = coneFactor(spec, y);
    const p = new THREE.Vector3(dir.x * spec.crownR * rr * cf, y, dir.z * spec.crownR * rr * cf);
    const up = new THREE.Vector3(rng.range(-0.6, 0.6), 1, rng.range(-0.6, 0.6)).normalize();
    const right = new THREE.Vector3().crossVectors(up, new THREE.Vector3(rng.range(-1, 1), 0, rng.range(-1, 1)).normalize()).normalize();
    const sz = rng.range(cMin, cMax) * 1.2;
    shellCards.push({ center: p, up, right, w: sz, h: sz, cell: spec.fillCell, tint: rng.range(0.8, 1.0), anchored: false });
  }
  return { spec, branches, twigCards, shellCards, center };
}

/** Crown-shaped normal at point p (ellipsoid gradient), blended with the card normal. */
function crownNormal(spec: TreeVariantSpec, p: THREE.Vector3, cardN: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const cf = coneFactor(spec, p.y);
  const rx = spec.crownR * cf;
  out.set(p.x / (rx * rx), (p.y - spec.crownY) / (spec.crownRy * spec.crownRy) + 0.04, p.z / (rx * rx));
  if (out.lengthSq() < 1e-6) out.set(0, 1, 0);
  out.normalize();
  const cn = cardN.dot(out) < 0 ? cardN.clone().negate() : cardN;
  return out.multiplyScalar(0.8).addScaledVector(cn, 0.2).normalize();
}

/** Ambient occlusion factor for foliage at p: darker inside and at the bottom of the crown. */
function crownAO(spec: TreeVariantSpec, p: THREE.Vector3): number {
  const cf = coneFactor(spec, p.y);
  const rx = spec.crownR * cf;
  const e = Math.sqrt((p.x * p.x + p.z * p.z) / (rx * rx) + ((p.y - spec.crownY) ** 2) / (spec.crownRy ** 2));
  const radial = 0.62 + 0.38 * THREE.MathUtils.smoothstep(e, 0.2, 1.0);
  const vert = 0.8 + 0.2 * THREE.MathUtils.clamp((p.y - (spec.crownY - spec.crownRy)) / (2 * spec.crownRy), 0, 1);
  return radial * vert;
}

function addCards(b: MeshBuilder, spec: TreeVariantSpec, cards: Card[], sizeMul: number): void {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [], wind: number[] = [], cardn: number[] = [];
  const n = new THREE.Vector3();
  const cardN = new THREE.Vector3();
  const corner = new THREE.Vector3();
  const cn = new THREE.Vector3();
  const H = spec.height;
  for (const c of cards) {
    const [u0, v0, u1, v1] = leafCellRect(c.cell);
    cardN.crossVectors(c.right, c.up).normalize();
    const w = c.w * sizeMul, h = c.h * sizeMul;
    const base = pos.length / 3;
    const corners: [number, number, number, number][] = [
      [-0.5, -0.5, u0, v0], [0.5, -0.5, u1, v0], [0.5, 0.5, u1, v1], [-0.5, 0.5, u0, v1],
    ];
    for (const [sx, sy, cu, cv] of corners) {
      corner.copy(c.center).addScaledVector(c.right, sx * w).addScaledVector(c.up, sy * h);
      pos.push(corner.x, corner.y, corner.z);
      crownNormal(spec, corner, cardN, n);
      let ao = crownAO(spec, corner) * c.tint;
      if (c.clump) {
        // blend in the clump's own sphere normal + darken its underside / core
        cn.subVectors(corner, c.clump.c);
        const d = cn.length() / c.clump.r;
        cn.normalize();
        n.multiplyScalar(0.45).addScaledVector(cn, 0.55).normalize();
        ao *= (0.72 + 0.28 * THREE.MathUtils.smoothstep(d, 0.15, 0.95)) * (0.82 + 0.18 * (cn.y * 0.5 + 0.5));
      }
      nor.push(n.x, n.y, n.z);
      uv.push(cu, cv);
      col.push(ao, ao, ao);
      const hf = Math.max(0, corner.y / H);
      const attach = c.anchored ? (sy < 0 ? 0.3 : 1) : 0.8;
      wind.push(spec.sway * Math.pow(hf, 1.5), 0.035 * attach);
      cardn.push(cardN.x, cardN.y, cardN.z);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  b.addRaw(pos, nor, uv, idx, col, { rough: 0.78, metal: 0, paint: 1 }, wind, { aCardN: cardn });
}

function addBranches(b: MeshBuilder, spec: TreeVariantSpec, branches: Branch[], lod: 0 | 1): void {
  const H = spec.height;
  for (const br of branches) {
    if (lod === 1 && br.depth >= 2) continue;
    let radial = br.depth === 0 ? (lod === 0 ? 10 : 6) : br.depth === 1 ? (lod === 0 ? 7 : 4) : br.depth === 2 ? (lod === 0 ? 5 : 4) : 3;
    let pts = br.pts;
    let radii = br.radii;
    if (lod === 1 && br.depth === 0 && pts.length > 5) {
      // halve the ring count of the trunk at LOD1
      const keep = pts.map((_, i) => i).filter((i) => i % 2 === 0 || i === pts.length - 1);
      pts = keep.map((i) => br.pts[i]);
      radii = keep.map((i) => br.radii[i]);
    }
    if (br.depth === 2 && radii[0] < 0.015) radial = 3;
    // branches start on the trunk axis: close both ends so no open tube end pokes through the bark
    const g = sweep(pts, (_t, i) => radii[i], radial, { capEnd: true, capStart: br.depth > 0 });
    b.add(g, null, { color: 0xffffff, rough: 0.92, metal: 0 }, {
      windFn: (_x, y) => [spec.sway * Math.pow(Math.max(0, y / H), 1.5) * (br.depth === 0 ? 0.7 : 1), 0],
      colorFn: (x, y, z, c) => {
        // branches inside the crown are darker (occluded)
        const inCrown = y > spec.trunkHeight ? crownAO(spec, new THREE.Vector3(x, y, z)) * 0.9 + 0.1 : 1;
        return c.multiplyScalar(inCrown);
      },
    });
    g.dispose();
  }
}

export interface TreeVariantMeshes {
  spec: TreeVariantSpec;
  lods: BatchLod[];
  /** triangles per LOD level (for stats) */
  tris: number[];
}

export interface TreeAssets {
  variants: TreeVariantMeshes[];
  /** variants by kind */
  byKind: TreeVariantMeshes[][];
  barkMaterial: THREE.MeshStandardMaterial;
  leafMaterial: THREE.MeshStandardMaterial;
}

let cached: TreeAssets | null = null;

/** Build all tree variants (geometry, materials, impostors). Cached per page. */
export function getTreeAssets(renderer: THREE.WebGLRenderer, anisotropy = 4, lodDist: [number, number, number] = [55, 170, 1400]): TreeAssets {
  if (cached) return cached;
  const leafTex = getLeafAtlas(anisotropy);
  const barkTex = getBarkTextures(anisotropy);
  barkTex.map.repeat.set(2, 0.5);
  barkTex.normal.repeat.set(2, 0.5);
  const barkOpts = { name: 'boomschors', map: barkTex.map, normalMap: barkTex.normal, normalScale: 1.2, wind: true };
  const barkMaterial = createPropMaterial(barkOpts);
  const barkDepth = createPropDepthMaterial({ ...barkOpts, map: null });
  const leafOpts = { name: 'bladeren', map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, wind: true, foliage: true };
  const leafMaterial = createPropMaterial(leafOpts);
  const leafDepth = createPropDepthMaterial(leafOpts);

  const variants: TreeVariantMeshes[] = [];
  for (const spec of TREE_VARIANTS) {
    const sk = buildSkeleton(spec);
    // LOD0
    const wood0 = new MeshBuilder({ wind: true });
    addBranches(wood0, spec, sk.branches, 0);
    const leaves0 = new MeshBuilder({ wind: true, extras: { aCardN: 3 } });
    addCards(leaves0, spec, sk.twigCards, 1);
    addCards(leaves0, spec, sk.shellCards, 1);
    const gWood0 = wood0.build();
    const gLeaves0 = leaves0.build();
    // LOD1: fewer, larger cards
    const wood1 = new MeshBuilder({ wind: true });
    addBranches(wood1, spec, sk.branches, 1);
    const leaves1 = new MeshBuilder({ wind: true, extras: { aCardN: 3 } });
    addCards(leaves1, spec, sk.twigCards.filter((_, i) => i % 4 === 0), 1.5);
    addCards(leaves1, spec, sk.shellCards.filter((_, i) => i % 2 === 0), 1.4);
    const gWood1 = wood1.build();
    const gLeaves1 = leaves1.build();
    // LOD2: impostor
    const imp = buildImpostor(renderer, spec, gWood0, gLeaves0, barkTex.map, leafTex);
    const lods: BatchLod[] = [
      {
        dist: lodDist[0],
        maxInstances: 600,
        parts: [
          { geometry: gWood0, material: barkMaterial, depthMaterial: barkDepth, castShadow: true, receiveShadow: true },
          { geometry: gLeaves0, material: leafMaterial, depthMaterial: leafDepth, castShadow: true, receiveShadow: true },
        ],
        // shadow + water reflection use the LOD1 branches (5k -> 0.6k tris); the near shadow keeps
        // the full leaf cards for the dappled pattern, the rippled reflection gets the LOD1 crown
        shadowParts: [
          { geometry: gWood1, material: barkMaterial, depthMaterial: barkDepth },
          { geometry: gLeaves0, material: leafMaterial, depthMaterial: leafDepth },
        ],
        reflectParts: [
          { geometry: gWood1, material: barkMaterial },
          { geometry: gLeaves1, material: leafMaterial },
        ],
      },
      {
        dist: lodDist[1],
        parts: [
          { geometry: gWood1, material: barkMaterial, depthMaterial: barkDepth, castShadow: true, receiveShadow: true },
          { geometry: gLeaves1, material: leafMaterial, depthMaterial: leafDepth, castShadow: true, receiveShadow: true },
        ],
      },
      { dist: lodDist[2], parts: [{ geometry: imp.geometry, material: imp.material, castShadow: false, receiveShadow: false }] },
    ];
    variants.push({
      spec,
      lods,
      tris: [triCount(gWood0) + triCount(gLeaves0), triCount(gWood1) + triCount(gLeaves1), triCount(imp.geometry)],
    });
  }
  const byKind: TreeVariantMeshes[][] = [[], [], []];
  for (const v of variants) byKind[v.spec.kind].push(v);
  cached = { variants, byKind, barkMaterial, leafMaterial };
  return cached;
}

// ---------------------------------------------------------------------------------------------
// Impostors
// ---------------------------------------------------------------------------------------------

function buildImpostor(
  renderer: THREE.WebGLRenderer,
  spec: TreeVariantSpec,
  wood: THREE.BufferGeometry,
  leaves: THREE.BufferGeometry,
  barkMap: THREE.Texture,
  leafMap: THREE.Texture,
): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } {
  wood.computeBoundingBox();
  leaves.computeBoundingBox();
  const bb = wood.boundingBox!.clone().union(leaves.boundingBox!);
  const R = Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x), Math.abs(bb.min.z), Math.abs(bb.max.z)) * 1.02;
  const top = bb.max.y * 1.01;
  // atlas: side view in the left half (W x Hpx), top view in the right half (W x W)
  const W = 256, Hpx = Math.min(512, Math.max(256, Math.round((256 * top) / (2 * R) / 32) * 32));
  const rt = new THREE.WebGLRenderTarget(W * 2, Hpx, {
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  const scene = new THREE.Scene();
  const bark = new THREE.MeshBasicMaterial({ map: barkMap, vertexColors: true });
  const leaf = new THREE.MeshBasicMaterial({ map: leafMap, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide });
  // albedo with a touch of baked directional shading so the impostor is not flat
  scene.add(new THREE.Mesh(wood, bark), new THREE.Mesh(leaves, leaf));
  const cam = new THREE.OrthographicCamera(-R, R, top, 0, -50, 50);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevToneMapping = renderer.toneMapping;
  const prevAutoClear = renderer.autoClear;
  renderer.toneMapping = THREE.NoToneMapping;
  // clear once: an auto-clear would wipe the whole atlas (gl.clear ignores the viewport)
  renderer.autoClear = false;
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new THREE.Color(0x3a4a22), 0);
  renderer.clear(true, true, true);
  rt.viewport.set(0, 0, W, Hpx);
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  // top view (seen from above: x -> u, -z -> v)
  const camTop = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, top + 20);
  camTop.position.set(0, top + 10, 0);
  camTop.up.set(0, 0, -1);
  camTop.lookAt(0, 0, 0);
  rt.viewport.set(W, 0, W, W);
  renderer.setRenderTarget(rt);
  renderer.render(scene, camTop);
  rt.viewport.set(0, 0, W * 2, Hpx);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.toneMapping = prevToneMapping;
  renderer.autoClear = prevAutoClear;
  bark.dispose();
  leaf.dispose();
  rt.texture.anisotropy = 4;

  // two crossed quads, each spanning [-R, R] x [0, top]
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let q = 0; q < 2; q++) {
    const a = (q * Math.PI) / 2;
    const cx = Math.cos(a), cz = -Math.sin(a);
    const nx = Math.sin(a), nz = Math.cos(a);
    const base = pos.length / 3;
    const corners: [number, number][] = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      pos.push(cx * sx * R, sy * top, cz * sx * R);
      nor.push(nx, 0, nz);
      uv.push((sx + 1) / 4, sy);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // horizontal quad at the upper crown for views from above (the material cross-fades between
  // the side quads and this one by view elevation)
  {
    const base = pos.length / 3;
    const yTop = Math.min(top * 0.97, spec.crownY + spec.crownRy * 0.55);
    const vMax = W / Hpx;
    for (const [sx, sz] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as [number, number][]) {
      pos.push(sx * R, yTop, sz * R);
      nor.push(0, 1, 0);
      uv.push(0.5 + (sx + 1) / 4, ((-sz + 1) / 2) * vMax);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    name: `impostor_${spec.name}`,
    map: rt.texture,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
  });
  const cy = spec.crownY, ry = spec.crownRy, rx = spec.crownR;
  material.onBeforeCompile = (shader) => {
    // screen-space crown normal: sphere around the crown centre in view space
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vImp;
varying float vElev;
varying float vTopQ;`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  {
    #ifdef USE_INSTANCING
      mat4 im = instanceMatrix;
    #else
      mat4 im = mat4(1.0);
    #endif
    float sc = length(im[0].xyz);
    vec4 cView = modelViewMatrix * im * vec4(0.0, ${cy.toFixed(3)}, 0.0, 1.0);
    vImp = (mvPosition.xy - cView.xy) / (vec2(${rx.toFixed(3)}, ${ry.toFixed(3)}) * sc);
    vec3 wp = (modelMatrix * im * vec4(position, 1.0)).xyz;
    vElev = abs(normalize(cameraPosition - wp).y);
    vTopQ = step(0.5, abs(normal.y));
  }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vImp;
varying float vElev;
varying float vTopQ;`)
      .replace(
        '#include <normal_fragment_begin>',
        `float faceDirection = 1.0;
  vec2 ip = vImp * 0.85;
  vec3 normal = normalize(vec3(ip.x, ip.y + 0.1, sqrt(max(0.08, 1.0 - dot(ip, ip)))));
  vec3 nonPerturbedNormal = normal;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  {
    vec2 tsz = vec2(textureSize(map, 0));
    vec2 dx = dFdx(vMapUv * tsz), dy = dFdy(vMapUv * tsz);
    float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    diffuseColor.a *= 1.0 + mip * 0.3;
    // cross-fade: side quads seen from the street, the top quad seen from above
    float wTop = smoothstep(0.5, 0.8, vElev);
    diffuseColor.a *= mix(1.0 - wTop, wTop, vTopQ);
  }`,
      );
  };
  material.customProgramCacheKey = () => `tree-impostor-${spec.name}`;
  return { geometry, material };
}
