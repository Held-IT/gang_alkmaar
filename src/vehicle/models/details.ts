// Detail parts that sit on the body surface: lamp light-guides / LED patches (lights bucket),
// mirrors, door handles, spoiler, shark fin (body bucket), wipers, grille frames, badges, exhausts,
// roof rails, plate holders (detail bucket), licence plates, lettering and taxi sign (decal bucket).
// Positions come from the same BodyMap / Features as the painted atlas, so everything lines up.
import * as THREE from 'three';
import earcut from 'earcut';
import { type PatchName } from './atlasLayout';
import type { V3 } from './body';
import type { BodyMap } from './bodyMap';
import type { BodyMesh } from './bodyMesh';
import { MeshBuilder } from './builder';
import { lerp } from './curves';
import { clipBand, densify, type Features, type Pt, type Recess } from './features';
import { buildInterior, seatLayout } from './interior';
import { CH } from './materials';
import { decalUv, type DecalRectName } from './plates';
import type { LightAnchors } from './index';

export interface DetailOut {
  body: MeshBuilder;
  detail: MeshBuilder;
  interior: MeshBuilder;
  lights: MeshBuilder;
  decal: MeshBuilder;
  /** LOD 0 clear lamp lens shells (merged into the glass geometry) */
  lens: MeshBuilder;
  anchors: LightAnchors;
}

type SurfMap = (a: number, b: number, pos: V3, nrm: V3) => void;

// ------------------------------------------------------------------------------------------------
// generic surface-conforming builders

/** Clip polygon to an axis-aligned rectangle (Sutherland-Hodgman). */
function clipRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  let out = poly;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= x1, (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= y0, (a, b) => { const t = (y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y0]; }],
    [(p) => p[1] <= y1, (a, b) => { const t = (y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y1]; }],
  ];
  for (const [inside, cut] of edges) {
    const inp = out;
    out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prev = inp[(i + inp.length - 1) % inp.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

/**
 * Surface patch: polygon in surface coordinates (a, b) -> triangles conforming to the surface,
 * offset along the normal. Faces are oriented along the surface normal.
 */
function patch(mb: MeshBuilder, poly: Pt[], cell: number, off: number, map: SurfMap, uv?: (a: number, b: number) => [number, number]): void {
  const xs = poly.map((q) => q[0]);
  const ys = poly.map((q) => q[1]);
  const ax0 = Math.min(...xs);
  const ax1 = Math.max(...xs);
  const by0 = Math.min(...ys);
  const by1 = Math.max(...ys);
  const nx = Math.max(1, Math.ceil((ax1 - ax0) / cell));
  const ny = Math.max(1, Math.ceil((by1 - by0) / cell));
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = clipRect(poly, lerp(ax0, ax1, i / nx), lerp(by0, by1, j / ny), lerp(ax0, ax1, (i + 1) / nx), lerp(by0, by1, (j + 1) / ny));
      if (c.length < 3) continue;
      const flat: number[] = [];
      for (const q of c) flat.push(q[0], q[1]);
      const tris = earcut(flat);
      if (!tris.length) continue;
      const ids = c.map((q) => {
        map(q[0], q[1], P, N);
        const t = uv ? uv(q[0], q[1]) : [0.5, 0.5];
        return mb.vert(P.x + N.x * off, P.y + N.y * off, P.z + N.z * off, N.x, N.y, N.z, t[0], t[1]);
      });
      for (let k = 0; k < tris.length; k += 3) orientTri(mb, ids[tris[k]], ids[tris[k + 1]], ids[tris[k + 2]]);
    }
  }
}

/** add a triangle, flipping it if its winding disagrees with the vertex normals */
function orientTri(mb: MeshBuilder, a: number, b: number, c: number): void {
  const p = mb.pos;
  const ux = p[3 * b] - p[3 * a];
  const uy = p[3 * b + 1] - p[3 * a + 1];
  const uz = p[3 * b + 2] - p[3 * a + 2];
  const vx = p[3 * c] - p[3 * a];
  const vy = p[3 * c + 1] - p[3 * a + 1];
  const vz = p[3 * c + 2] - p[3 * a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const n = mb.nrm;
  const dot = nx * (n[3 * a] + n[3 * b] + n[3 * c]) + ny * (n[3 * a + 1] + n[3 * b + 1] + n[3 * c + 1]) + nz * (n[3 * a + 2] + n[3 * b + 2] + n[3 * c + 2]);
  if (dot < 0) mb.tri(a, c, b);
  else mb.tri(a, b, c);
}

/** Ribbon along a polyline in surface coordinates; optional height gives a raised box profile. */
function ribbon(mb: MeshBuilder, line: Pt[], width: number, off: number, map: SurfMap, height = 0, step = 0.01): void {
  const pts = densify(line, step);
  if (pts.length < 2) return;
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  const rows: number[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const q = pts[i];
    const row: number[] = [];
    const sides = height > 0 ? [-1, -1, 1, 1] : [-1, 1];
    sides.forEach((s, k) => {
      const qa = q[0] - ty * s * width * 0.5;
      const qb = q[1] + tx * s * width * 0.5;
      map(qa, qb, P, N);
      const h = height > 0 && (k === 1 || k === 2) ? height : 0;
      row.push(mb.vert(P.x + N.x * (off + h), P.y + N.y * (off + h), P.z + N.z * (off + h), N.x, N.y, N.z, 0.5, 0.5));
    });
    rows.push(row);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const A = rows[i];
    const B = rows[i + 1];
    for (let k = 0; k < A.length - 1; k++) {
      orientTri(mb, A[k], A[k + 1], B[k]);
      orientTri(mb, B[k], A[k + 1], B[k + 1]);
    }
  }
}

/** set all uvs of vertices [from, to) to a patch uv */
function setUv(mb: MeshBuilder, from: number, uv: [number, number]): void {
  for (let i = from; i < mb.vertexCount; i++) {
    mb.uv[2 * i] = uv[0];
    mb.uv[2 * i + 1] = uv[1];
  }
}

/** mirror a builder's content across x = 0 and swap left/right indicator channels in the copy */
function mirrorLights(mb: MeshBuilder): void {
  const n = mb.vertexCount;
  mb.mirrorX();
  for (let i = n; i < mb.vertexCount; i++) {
    if (mb.ch[i] === CH.indL) mb.ch[i] = CH.indR;
    else if (mb.ch[i] === CH.indR) mb.ch[i] = CH.indL;
  }
}

/** Superellipsoid pod (mirror housings etc.), long axis x. */
function pod(rx: number, ry: number, rz: number, pw: number, seg: number, flattenBack: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg >> 1));
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const e = 2 / pw;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sx = Math.sign(x) * Math.pow(Math.abs(x), e);
    const sy = Math.sign(y) * Math.pow(Math.abs(y), e);
    let sz = Math.sign(z) * Math.pow(Math.abs(z), e);
    if (sz < 0) sz *= flattenBack;
    pos.setXYZ(i, sx * rx, sy * ry, sz * rz);
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** Matrix placing local axes (tangent t = x, normal n = z) at a surface point. */
function frameAt(p: V3, n: V3, t: THREE.Vector3): THREE.Matrix4 {
  const nz = new THREE.Vector3(n.x, n.y, n.z).normalize();
  const tx = t.clone().sub(nz.clone().multiplyScalar(t.dot(nz))).normalize();
  const ty = new THREE.Vector3().crossVectors(nz, tx);
  return new THREE.Matrix4().makeBasis(tx, ty, nz).setPosition(p.x, p.y, p.z);
}

// ------------------------------------------------------------------------------------------------
// recessed units (LOD 0): lamp housings, grille and intake openings behind the cut-out body

/** twice the signed area of a polygon (positive = counter-clockwise in (a, b)) */
function area2(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/**
 * Inner walls of a recess: from 3 mm above the surface down to -depth along the surface normal,
 * facing the opening. Edges with both ends on the centre line are skipped (the mirrored half
 * continues the housing).
 */
function recessWalls(mb: MeshBuilder, poly: Pt[], depth: number, map: SurfMap, onCentre: (q: Pt) => boolean, step: number): void {
  const pts = densify(poly, step, true);
  const n = pts.length;
  if (n < 3) return;
  const ccw = area2(pts) > 0;
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  const Q = { x: 0, y: 0, z: 0 };
  const NQ = { x: 0, y: 0, z: 0 };
  const top: number[] = [];
  const bot: number[] = [];
  const ps = new Float64Array(3 * n);
  const ns = new Float64Array(3 * n);
  const ins = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[(i + 1) % n];
    const q = pts[i];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const ix = ccw ? -ty : ty;
    const iy = ccw ? tx : -tx;
    map(q[0], q[1], P, N);
    map(q[0] + ix * 0.004, q[1] + iy * 0.004, Q, NQ);
    ps[3 * i] = P.x;
    ps[3 * i + 1] = P.y;
    ps[3 * i + 2] = P.z;
    ns[3 * i] = N.x;
    ns[3 * i + 1] = N.y;
    ns[3 * i + 2] = N.z;
    ins[3 * i] = Q.x - P.x;
    ins[3 * i + 1] = Q.y - P.y;
    ins[3 * i + 2] = Q.z - P.z;
  }
  for (let i = 0; i < n; i++) {
    // wall normal = edge tangent x extrusion direction, facing into the opening (the extrusion
    // direction need not be the surface normal, see recessMap)
    const i0 = 3 * ((i + n - 1) % n);
    const i1 = 3 * ((i + 1) % n);
    const tx = ps[i1] - ps[i0];
    const ty = ps[i1 + 1] - ps[i0 + 1];
    const tz = ps[i1 + 2] - ps[i0 + 2];
    const k = 3 * i;
    const nx = ns[k];
    const ny = ns[k + 1];
    const nz = ns[k + 2];
    let dx = ty * nz - tz * ny;
    let dy = tz * nx - tx * nz;
    let dz = tx * ny - ty * nx;
    if (dx * ins[k] + dy * ins[k + 1] + dz * ins[k + 2] < 0) {
      dx = -dx;
      dy = -dy;
      dz = -dz;
    }
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    const px = ps[k];
    const py = ps[k + 1];
    const pz = ps[k + 2];
    top.push(mb.vert(px + nx * 0.003, py + ny * 0.003, pz + nz * 0.003, dx, dy, dz, 0.5, 0.5));
    bot.push(mb.vert(px - nx * depth, py - ny * depth, pz - nz * depth, dx, dy, dz, 0.5, 0.5));
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (onCentre(pts[i]) && onCentre(pts[j])) continue;
    orientTri(mb, top[i], bot[i], top[j]);
    orientTri(mb, top[j], bot[i], bot[j]);
  }
}

/** Segments of the parallel lines (direction angle ang, spacing sp) inside a polygon. */
function hatchLines(poly: Pt[], ang: number, sp: number, phase = 0.5): Pt[][] {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const nx = -dy;
  const ny = dx;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (const q of poly) {
    const s = q[0] * nx + q[1] * ny;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  const out: Pt[][] = [];
  for (let s = s0 + sp * phase; s < s1; s += sp) {
    const ox = nx * s;
    const oy = ny * s;
    const ts: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i];
      const B = poly[(i + 1) % poly.length];
      const ex = B[0] - A[0];
      const ey = B[1] - A[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      // o + d t = A + e u
      const ax = A[0] - ox;
      const ay = A[1] - oy;
      const t = (ax * ey - ay * ex) / den;
      const u = (ax * dy - ay * dx) / den;
      if (u >= 0 && u < 1) ts.push(t);
    }
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      if (ts[k + 1] - ts[k] < 0.012) continue;
      out.push([
        [ox + dx * ts[k], oy + dy * ts[k]],
        [ox + dx * ts[k + 1], oy + dy * ts[k + 1]],
      ]);
    }
  }
  return out;
}

/** Split a polyline at a band around p = pc (gap of +-g). */
function splitLine(line: Pt[], pc: number | null, g: number): Pt[][] {
  if (pc === null) return [line];
  const pts = densify(line, 0.004);
  const out: Pt[][] = [];
  let run: Pt[] = [];
  for (const q of pts) {
    if (Math.abs(q[0] - pc) < g) {
      if (run.length > 1) out.push(run);
      run = [];
    } else {
      if (run.length && Math.sign(run[run.length - 1][0] - pc) !== Math.sign(q[0] - pc)) {
        if (run.length > 1) out.push(run);
        run = [];
      }
      run.push(q);
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

/**
 * Thin box (rib, slat, bar, light guide) along a line in surface coordinates: two side walls and a
 * top face from base to base + height along the surface normal, with flat per-face normals
 * (a ribbon's surface normals would leave its side walls arbitrarily oriented).
 */
function fin(mb: MeshBuilder, line: Pt[], width: number, base: number, height: number, map: SurfMap, step: number): void {
  const pts = densify(line, step);
  if (pts.length < 2) return;
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  const Q = { x: 0, y: 0, z: 0 };
  const NQ = { x: 0, y: 0, z: 0 };
  const rows: number[][] = [];
  const hw = width * 0.5;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const q = pts[i];
    map(q[0], q[1], P, N);
    map(q[0] - ty * 0.004, q[1] + tx * 0.004, Q, NQ);
    let lx = Q.x - P.x;
    let ly = Q.y - P.y;
    let lz = Q.z - P.z;
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll;
    ly /= ll;
    lz /= ll;
    const v = (s: number, h: number, nx: number, ny: number, nz: number) =>
      mb.vert(P.x + lx * s * hw + N.x * (base + h), P.y + ly * s * hw + N.y * (base + h), P.z + lz * s * hw + N.z * (base + h), nx, ny, nz, 0.5, 0.5);
    rows.push([
      v(-1, 0, -lx, -ly, -lz),
      v(-1, height, -lx, -ly, -lz),
      v(-1, height, N.x, N.y, N.z),
      v(1, height, N.x, N.y, N.z),
      v(1, height, lx, ly, lz),
      v(1, 0, lx, ly, lz),
    ]);
  }
  for (let i = 0; i < rows.length - 1; i++) {
    const A = rows[i];
    const B = rows[i + 1];
    for (let k = 0; k < 6; k += 2) {
      orientTri(mb, A[k], A[k + 1], B[k]);
      orientTri(mb, B[k], A[k + 1], B[k + 1]);
    }
  }
}

type Rgb = [number, number, number];
const REC_LOOK: Record<Recess['kind'], { wall: Rgb; wallPbr: [number, number]; back: Rgb; backPbr: [number, number] }> = {
  // dark-chrome lamp housing (env reflections make it read as a lamp, not a hole)
  head: { wall: [0.09, 0.095, 0.1], wallPbr: [0.16, 0.85], back: [0.05, 0.053, 0.058], backPbr: [0.1, 0.9] },
  // red reflector body behind the smoked lens
  tail: { wall: [0.09, 0.008, 0.01], wallPbr: [0.18, 0.3], back: [0.16, 0.01, 0.014], backPbr: [0.12, 0.45] },
  fog: { wall: [0.06, 0.062, 0.066], wallPbr: [0.2, 0.7], back: [0.35, 0.36, 0.38], backPbr: [0.12, 1] },
  grille: { wall: [0.014, 0.014, 0.016], wallPbr: [0.5, 0], back: [0.006, 0.006, 0.007], backPbr: [0.75, 0] },
  intake: { wall: [0.014, 0.014, 0.016], wallPbr: [0.45, 0], back: [0.006, 0.006, 0.007], backPbr: [0.75, 0] },
};

/**
 * LOD 0 recessed units: housing walls + back panel (detail bucket), grille / intake inserts
 * (detail bucket) and clear lens shells over the lamps (glass bucket). The painted atlas is cut
 * open along the same polygons (atlasPaint), so the body surface stops exactly at the walls.
 */
/**
 * SurfMap for a recess whose normal is one fixed extrusion direction (perimeter-mean surface
 * normal). Headlamps wrap from the nose over the fender-top roll, where the surface normal jumps
 * by ~45 degrees (roll crease) and even turns downwards (nose-corner fold): walls / back panel
 * extruded along the local normals there folded through each other and poked out above the hood
 * line. Extruded along one direction they are parallel translations of the outline instead.
 * Units touching the centre line keep x = 0 so the mirrored halves still meet.
 */
function recessMap(poly: Pt[], map: SurfMap, onCentre: (q: Pt) => boolean): SurfMap {
  const P = { x: 0, y: 0, z: 0 };
  const N = { x: 0, y: 0, z: 0 };
  let dx = 0;
  let dy = 0;
  let dz = 0;
  let centre = false;
  for (const q of densify(poly, 0.01, true)) {
    map(q[0], q[1], P, N);
    dx += N.x;
    dy += N.y;
    dz += N.z;
    if (onCentre(q)) centre = true;
  }
  if (centre) dx = 0;
  const l = Math.hypot(dx, dy, dz) || 1;
  dx /= l;
  dy /= l;
  dz /= l;
  return (a, b, pos, nrm) => {
    map(a, b, pos, nrm);
    nrm.x = dx;
    nrm.y = dy;
    nrm.z = dz;
  };
}

function buildRecessUnits(feat: Features, P: number, map: SurfMap, det: MeshBuilder, lens: MeshBuilder, white: [number, number], lensUv: [number, number]): void {
  const onC = (q: Pt) => q[0] >= P - 1e-4;
  for (const r of feat.recesses) {
    if (r.poly.length < 3) continue;
    const look = REC_LOOK[r.kind];
    const from = det.vertexCount;
    // headlamps wrap over creases: one extrusion direction (see recessMap)
    const rmap = r.kind === 'head' ? recessMap(r.poly, map, onC) : map;
    det.setColor(look.wall).setPbr(look.wallPbr[0], look.wallPbr[1]);
    recessWalls(det, r.poly, r.depth, rmap, onC, 0.02);
    det.setColor(look.back).setPbr(look.backPbr[0], look.backPbr[1]);
    patch(det, r.poly, 0.08, -r.depth, rmap);
    if ((r.kind === 'grille' || r.kind === 'intake') && r.pattern !== 'closed') {
      const chrome = !!r.chrome;
      det.setColor(chrome ? [0.72, 0.74, 0.77] : [0.022, 0.022, 0.025]).setPbr(chrome ? 0.12 : 0.28, chrome ? 1 : 0);
      const pat = r.kind === 'intake' ? 'slats' : r.pattern ?? 'mesh';
      if (pat === 'mesh') {
        // diamond mesh: two crossing sets of thin ribs standing out of the back panel
        for (const ang of [0.6, -0.6]) {
          for (const seg of hatchLines(r.poly, ang, 0.038)) fin(det, seg, 0.0045, -r.depth, r.depth * 0.6, map, 0.12);
        }
      } else if (pat === 'slats') {
        for (const seg of hatchLines(r.poly, 0, r.kind === 'intake' ? 0.022 : 0.017)) fin(det, seg, 0.004, -r.depth, r.depth * 0.8, map, 0.1);
      } else if (pat === 'vbars') {
        // vertical chrome slats standing out of the back panel (Norrvik face)
        for (const seg of hatchLines(r.poly, Math.PI / 2, 0.026)) fin(det, seg, 0.006, -r.depth, r.depth * 0.75, map, 0.04);
      } else {
        // horizontal bars, set back a little from the opening
        for (const seg of hatchLines(r.poly, 0, 0.03)) fin(det, seg, 0.011, -r.depth * 0.45, 0.01, map, 0.1);
      }
    }
    setUv(det, from, white);
    if (r.kind === 'head' || r.kind === 'tail' || r.kind === 'fog') {
      const lf = lens.vertexCount;
      patch(lens, r.poly, 0.04, 0.0015, map);
      setUv(lens, lf, lensUv);
    }
  }
}

export function buildDetails(m: BodyMap, feat: Features, bm: BodyMesh, lod: 0 | 1 | 2): DetailOut {
  const f = m.f;
  const d = f.d;
  const spec = f.spec;
  const P = f.P;
  const atlas = m.atlas;
  const puv = (n: PatchName) => atlas.patchUv(n);

  const bodySym = new MeshBuilder(); // body colour, mirrored
  const bodyCtr = new MeshBuilder(); // body colour, centre parts
  const detSym = new MeshBuilder();
  const detCtr = new MeshBuilder();
  const litSym = new MeshBuilder();
  const litCtr = new MeshBuilder();
  const decal = new MeshBuilder();
  const lensSym = new MeshBuilder(); // LOD 0 lamp lens shells (glass bucket), mirrored
  const interior = new MeshBuilder();

  const lowerMap: SurfMap = (p, y, pos, nrm) => {
    m.lowerPos(Math.min(P, Math.max(0, p)), y, pos, nrm);
  };
  const ghMap: SurfMap = (z, arc, pos, nrm) => {
    m.ghPos(z, arc, pos, nrm);
  };
  const cell = lod === 0 ? 0.022 : lod === 1 ? 0.06 : 1;
  // lamp parts float a few mm above the analytic surface: the tessellated body (coarser than the
  // lamp patches) deviates from it by up to ~3 mm on tight curves
  const LAMP_OFF = lod === 0 ? 0.005 : 0.008;

  // ---------------- lamps ----------------
  const h = feat.head;
  const t = feat.tail;
  if (lod === 0) {
    // recessed units: the lit parts sit inside the housings, behind clear lens shells
    buildRecessUnits(feat, P, lowerMap, detSym, lensSym, puv('white'), puv('lens'));
    const headRec = feat.recesses.find((r) => r.kind === 'head');
    const hd = headRec?.depth ?? 0.05;
    const td = feat.recesses.find((r) => r.kind === 'tail')?.depth ?? 0.035;
    // lamp internals are extruded along the housing's direction (see recessMap)
    const headMap = headRec && headRec.poly.length > 2 ? recessMap(headRec.poly, lowerMap, (q) => q[0] >= P - 1e-4) : lowerMap;
    // DRL light guide: a raised LED bar half way into the housing
    litSym.setColor([0.82, 0.86, 0.9]).setCh(CH.drl).setPbr(0.2, 0);
    fin(litSym, h.drl, h.drlWidth, -hd * 0.55, hd * 0.25, headMap, 0.02);
    // projector modules: chrome barrel + domed lens
    const S = { x: 0, y: 0, z: 0 };
    const SN = { x: 0, y: 0, z: 0 };
    const barrel = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true).rotateX(Math.PI / 2);
    const dome = new THREE.SphereGeometry(1, 14, 3, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
    const domeS = new THREE.SphereGeometry(1, 8, 2, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2);
    const ring = new THREE.RingGeometry(0.78, 1, 14, 1);
    for (const pr of h.projectors) {
      lowerMap(pr.p, pr.y, S, SN);
      const fr = frameAt(S, SN, new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(SN.x, SN.y, SN.z)).lengthSq() > 1e-4 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0));
      const rr = pr.r * 1.3;
      const small = pr.r < 0.02;
      detSym.setColor([0.62, 0.64, 0.67]).setPbr(0.14, 1);
      if (!small) detSym.addGeometry(barrel, fr.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -hd * 0.65).scale(new THREE.Vector3(rr, rr, hd * 0.7))), puv('white'));
      detSym.setColor([0.03, 0.03, 0.034]).setPbr(0.3, 0.4);
      detSym.addGeometry(ring, fr.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -hd * 0.3).scale(new THREE.Vector3(rr, rr, 1))), puv('white'));
      litSym.setColor([0.2, 0.21, 0.23]).setCh(CH.head).setPbr(0.04, 0);
      litSym.addGeometry(small ? domeS : dome, fr.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -hd * 0.32).scale(new THREE.Vector3(pr.r, pr.r, pr.r * 0.3))));
    }
    barrel.dispose();
    dome.dispose();
    domeS.dispose();
    ring.dispose();
    if (h.indicator.length) {
      litSym.setColor([0.42, 0.28, 0.12]).setCh(CH.indL);
      fin(litSym, h.indicator, 0.014, -hd * 0.6, hd * 0.15, headMap, 0.02);
    }
    // tail: raised red light guides (split at the tailgate shut line), recessed lamp chambers
    const sp = feat.tailSplitP;
    const halves = (poly: Pt[]): Pt[][] => (sp === null ? [poly] : [clipBand(poly, 0, sp - 0.006), clipBand(poly, sp + 0.006, P)]);
    litSym.setColor([0.42, 0.02, 0.025]).setCh(CH.tail);
    for (const run of splitLine(t.guide, sp, 0.006)) fin(litSym, run, t.guideWidth, -td * 0.6, td * 0.35, lowerMap, 0.03);
    for (const [poly, col, ch] of [
      [t.brake, [0.3, 0.015, 0.02], CH.brake],
      [t.indicator, [0.2, 0.1, 0.05], CH.indL],
      [t.reverse, [0.55, 0.57, 0.6], CH.reverse],
    ] as [Pt[], [number, number, number], number][]) {
      litSym.setColor(col).setCh(ch);
      for (const part of halves(poly)) if (part.length > 2) patch(litSym, part, 0.07, -td * 0.75, lowerMap);
    }
  } else {
    litSym.setColor([0.82, 0.86, 0.9]).setCh(CH.drl).setPbr(0.2, 0);
    ribbon(litSym, h.drl, h.drlWidth, LAMP_OFF, lowerMap, 0, lod === 2 ? 0.12 : 0.025);
    if (lod < 2) {
      for (const pr of h.projectors) {
        litSym.setColor([0.55, 0.58, 0.62]).setCh(CH.head);
        const circ: Pt[] = [];
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          circ.push([pr.p + Math.cos(a) * pr.r, pr.y + Math.sin(a) * pr.r]);
        }
        patch(litSym, circ, cell, LAMP_OFF + 0.001, lowerMap);
      }
      if (h.indicator.length) {
        litSym.setColor([0.42, 0.28, 0.12]).setCh(CH.indL);
        ribbon(litSym, h.indicator, 0.014, LAMP_OFF + 0.0003, lowerMap);
      }
    }
    litSym.setColor([0.42, 0.02, 0.025]).setCh(CH.tail);
    ribbon(litSym, t.guide, t.guideWidth, LAMP_OFF, lowerMap, 0, lod === 2 ? 0.12 : 0.025);
    litSym.setColor([0.3, 0.015, 0.02]).setCh(CH.brake);
    patch(litSym, t.brake, cell, LAMP_OFF - 0.0005, lowerMap);
    if (lod < 2) {
      litSym.setColor([0.2, 0.1, 0.05]).setCh(CH.indL);
      patch(litSym, t.indicator, cell, LAMP_OFF - 0.0005, lowerMap);
      litSym.setColor([0.55, 0.57, 0.6]).setCh(CH.reverse);
      patch(litSym, t.reverse, cell, LAMP_OFF - 0.0005, lowerMap);
    }
  }

  // ---------------- mirrors ----------------
  {
    const [mz, my] = feat.mirror;
    const S = f.shoulderPoint(f.pOfShoulderZ(mz));
    const van = d.van;
    const rx = van ? 0.13 : 0.105;
    const ry = van ? 0.12 : 0.068;
    const rz = van ? 0.07 : 0.06;
    const cx = S.x + rx + (van ? 0.06 : 0.012);
    const cy = my + 0.05;
    const cz = mz - 0.02;
    const seg = lod === 0 ? 20 : lod === 1 ? 10 : 5;
    const g = pod(rx, ry, rz, 2.6, seg, 0.28);
    const mat = new THREE.Matrix4().makeRotationY(-0.12).setPosition(cx, cy, cz);
    const from = bodySym.vertexCount;
    bodySym.addGeometry(g, mat);
    setUv(bodySym, from, puv('paint'));
    g.dispose();
    // arm / base (black)
    detSym.setColor([0.02, 0.02, 0.022]).setPbr(0.55, 0);
    const arm = new THREE.BoxGeometry(cx - S.x, 0.035, 0.07);
    detSym.addGeometry(arm, new THREE.Matrix4().makeTranslation((S.x + cx) / 2 - 0.03, my + 0.015, cz + 0.01), puv('white'));
    arm.dispose();
    if (lod < 2) {
      // mirror glass on the back face
      detSym.setColor([0.55, 0.58, 0.6]).setPbr(0.02, 1);
      const disc = new THREE.CircleGeometry(1, 24);
      const mg = new THREE.Matrix4()
        .makeTranslation(cx, cy, cz - rz * 0.28 - 0.002)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI - 0.12))
        .multiply(new THREE.Matrix4().makeScale(rx * 0.86, ry * 0.8, 1));
      detSym.addGeometry(disc, mg, puv('white'));
      disc.dispose();
      // indicator strip on the front-outer edge
      litSym.setColor([0.38, 0.25, 0.1]).setCh(CH.indL).setPbr(0.2, 0);
      const strip = new THREE.BoxGeometry(rx * 0.95, 0.012, 0.012);
      litSym.addGeometry(strip, new THREE.Matrix4().makeRotationY(-0.12).setPosition(cx + rx * 0.15, cy - ry * 0.35, cz + rz * 0.82));
      strip.dispose();
    }
  }

  // ---------------- door handles ----------------
  if (lod < 2) {
    for (const [hz, hy] of feat.handles) {
      const p = m.sideP(hz);
      const pos = { x: 0, y: 0, z: 0 };
      const nrm = { x: 0, y: 0, z: 0 };
      m.lowerPos(p, hy, pos, nrm);
      const cap = new THREE.CapsuleGeometry(0.014, 0.13, 4, lod === 0 ? 10 : 6).rotateZ(Math.PI / 2);
      cap.scale(1, 1, 0.7);
      const mtx = frameAt({ x: pos.x + nrm.x * 0.008, y: pos.y + nrm.y * 0.008, z: pos.z + nrm.z * 0.008 }, nrm, new THREE.Vector3(0, 0, 1));
      // capsule long axis is x after rotation; align x with the body tangent (forward)
      const from = bodySym.vertexCount;
      bodySym.addGeometry(cap, mtx);
      setUv(bodySym, from, puv('paint'));
      cap.dispose();
      // dark recess behind the handle
      detSym.setColor([0.015, 0.015, 0.015]).setPbr(0.7, 0);
      const rec: Pt[] = [];
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        rec.push([p + Math.cos(a) * 0.085, hy - 0.006 + Math.sin(a) * 0.02]);
      }
      const from2 = detSym.vertexCount;
      patch(detSym, rec, 0.03, 0.0012, lowerMap);
      setUv(detSym, from2, puv('white'));
    }
  }

  // ---------------- grille frames ----------------
  for (const gr of feat.grilles) {
    if (!gr.frame || lod === 2) continue;
    const chrome = d.front === 'sport' || d.front === 'van' || d.front === 'city';
    detSym.setColor(chrome ? [0.8, 0.82, 0.85] : [0.01, 0.01, 0.012]).setPbr(chrome ? 0.12 : 0.15, chrome ? 1 : 0);
    // drop the edge lying on the centre line (the mirrored half closes the outline)
    const fstep = lod === 0 ? 0.015 : 0.045;
    const pts = densify([...gr.poly, gr.poly[0]], fstep).map((q) => [Math.min(q[0], P), q[1]] as Pt);
    let run: Pt[] = [];
    const flush = () => {
      if (run.length > 1) {
        const from = detSym.vertexCount;
        ribbon(detSym, run, 0.013, 0.004, lowerMap, 0.006, fstep);
        setUv(detSym, from, puv('white'));
      }
      run = [];
    };
    for (const q of pts) {
      if (q[0] >= P - 1e-4 && run.length && run[run.length - 1][0] >= P - 1e-4) {
        flush();
        run.push(q);
        continue;
      }
      run.push(q);
    }
    flush();
  }

  // ---------------- spoiler (hatchbacks / estates / ev) ----------------
  if (d.spoiler && !d.trunk) {
    const zr = d.roofRearZ;
    const g0 = m.gh(zr);
    const n = lod === 0 ? 14 : lod === 1 ? 6 : 3;
    const from = bodySym.vertexCount;
    const P0 = { x: 0, y: 0, z: 0 };
    const N0 = { x: 0, y: 0, z: 0 };
    const rows: number[][] = [];
    const chord = d.van ? 0.05 : d.front === 'city' ? 0.07 : d.front === 'hatch' ? 0.14 : 0.11;
    for (let i = 0; i <= n; i++) {
      const arc = lerp(g0.sideLen + 0.02, g0.len, i / n);
      m.ghPos(zr + 0.04, arc, P0, N0);
      // section: roof point -> trailing edge -> underside -> back onto the rear glass
      const sec: [number, number][] = [
        [0, 0.004],
        [-chord * 0.6, -0.004],
        [-chord, -0.018],
        [-chord - 0.008, -0.038],
        [-chord * 0.7, -0.044],
        [-0.035, -0.06],
      ];
      const row: number[] = [];
      sec.forEach(([dz, dy], k) => {
        const ny = k < 3 ? 1 : -0.3;
        const nz = k < 3 ? 0.15 : -1;
        row.push(bodySym.vert(P0.x * (1 - 0.02 * (k / 5)), P0.y + dy, P0.z + dz, 0, ny, nz));
      });
      rows.push(row);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let k = 0; k < rows[i].length - 1; k++) {
        orientTriPreferred(bodySym, rows[i][k], rows[i][k + 1], rows[i + 1][k], rows[i + 1][k + 1]);
      }
    }
    // recompute normals for the spoiler block
    smoothNormals(bodySym, from);
    setUv(bodySym, from, puv('paint'));
    // third brake light under the trailing edge (centre part)
    m.ghPos(zr + 0.04, g0.len, P0, N0);
    litCtr.setColor([0.3, 0.02, 0.02]).setCh(CH.brake).setPbr(0.2, 0);
    const bl = new THREE.BoxGeometry(0.34, 0.008, 0.01);
    litCtr.addGeometry(bl, new THREE.Matrix4().makeTranslation(0, P0.y - 0.022, P0.z - chord - 0.004));
    bl.dispose();
  } else if (d.trunk) {
    // sedan: third brake light at the top of the rear window
    const z = d.roofRearZ + 0.035;
    const g0 = m.gh(z);
    const P0 = { x: 0, y: 0, z: 0 };
    const N0 = { x: 0, y: 0, z: 0 };
    m.ghPos(z, g0.len, P0, N0);
    litCtr.setColor([0.3, 0.02, 0.02]).setCh(CH.brake).setPbr(0.2, 0);
    const bl = new THREE.BoxGeometry(0.3, 0.01, 0.006);
    const mt = frameAt({ x: 0, y: P0.y + N0.y * 0.004, z: P0.z + N0.z * 0.004 }, N0, new THREE.Vector3(1, 0, 0));
    litCtr.addGeometry(bl, mt);
    bl.dispose();
  }

  // ---------------- shark fin antenna ----------------
  if (lod < 2 && !d.van) {
    const z = d.roofRearZ + (d.trunk ? 0.12 : 0.22);
    const P0 = { x: 0, y: 0, z: 0 };
    const N0 = { x: 0, y: 0, z: 0 };
    m.ghPos(z, m.gh(z).len, P0, N0);
    const fin = pod(0.024, 0.05, 0.085, 2.2, lod === 0 ? 14 : 8, 1);
    const pa = fin.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      // swept back: lean the top rearwards, flat bottom
      const y = pa.getY(i);
      const yy = Math.max(0, y);
      pa.setXYZ(i, pa.getX(i) * (1 - yy * 8), yy, pa.getZ(i) * (1 - yy * 4) - yy * 0.9);
    }
    fin.computeVertexNormals();
    const from = bodyCtr.vertexCount;
    bodyCtr.addGeometry(fin, new THREE.Matrix4().makeTranslation(0, P0.y - 0.003, P0.z));
    setUv(bodyCtr, from, puv('paint'));
    fin.dispose();
  }

  // ---------------- wipers (LOD 0 only: invisible at traffic distance) ----------------
  if (lod === 0) {
    detCtr.setColor([0.012, 0.012, 0.014]).setPbr(0.5, 0);
    const zw = d.cowlZ - 0.07;
    const sec = f.ghSection(m.gh(zw).p);
    const gp = { x: 0, y: 0, tx: 0, ty: 0 };
    const pointAtX = (x: number, lift: number): V3 => {
      // search the section polyline for |x|
      const ax = Math.abs(x);
      let best = 0;
      let bd = Infinity;
      for (let a = 0; a <= sec.len; a += 0.005) {
        f.ghPoint(sec, a, gp);
        const dd = Math.abs(gp.x - ax);
        if (dd < bd) {
          bd = dd;
          best = a;
        }
      }
      f.ghPoint(sec, best, gp);
      const nx = gp.ty;
      const ny = -gp.tx;
      return { x: Math.sign(x || 1) * (gp.x + nx * lift), y: gp.y + ny * lift, z: sec.z };
    };
    const blade = (x0: number, x1: number) => {
      const n = 10;
      const ids: number[][] = [];
      for (let i = 0; i <= n; i++) {
        const x = lerp(x0, x1, i / n);
        const a = pointAtX(x, 0.006);
        const b = pointAtX(x, 0.022);
        ids.push([
          detCtr.vert(a.x, a.y, a.z - 0.006, 0, 0.3, 1, ...puv('white')),
          detCtr.vert(b.x, b.y, b.z - 0.004, 0, 0.6, 0.8, ...puv('white')),
          detCtr.vert(a.x, a.y, a.z + 0.008, 0, 1, 0, ...puv('white')),
        ]);
      }
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 2; k++) {
          detCtr.tri(ids[i][k], ids[i + 1][k], ids[i][k + 1]);
          detCtr.tri(ids[i + 1][k], ids[i + 1][k + 1], ids[i][k + 1]);
          detCtr.tri(ids[i][k], ids[i][k + 1], ids[i + 1][k]);
          detCtr.tri(ids[i + 1][k], ids[i][k + 1], ids[i + 1][k + 1]);
        }
      }
    };
    const hw = d.halfWidth;
    blade(hw * 0.72, -hw * 0.02);
    blade(-hw * 0.08, -hw * 0.7);
    // rear wiper
    if (!d.trunk) {
      const zr = d.rearBaseZ + (d.van ? 0.25 : 0.07);
      const g0 = m.gh(zr);
      const pts: V3[] = [];
      for (let i = 0; i <= 6; i++) {
        const P0 = { x: 0, y: 0, z: 0 };
        const N0 = { x: 0, y: 0, z: 0 };
        m.ghPos(zr + i * 0.01, g0.len - i * 0.055, P0, N0);
        pts.push({ x: P0.x + N0.x * 0.012, y: P0.y + N0.y * 0.012, z: P0.z + N0.z * 0.012 });
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const box = new THREE.BoxGeometry(0.012, 0.012, 1);
        const dir = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);
        const len = dir.length();
        const mt = new THREE.Matrix4().lookAt(new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z), new THREE.Vector3(0, 1, 0));
        mt.multiply(new THREE.Matrix4().makeScale(1, 1, len));
        mt.setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
        detCtr.addGeometry(box, mt, puv('white'));
        box.dispose();
      }
    }
  }

  // ---------------- roof rails ----------------
  if (d.roofRails) {
    detSym.setColor(d.front === 'estate' ? [0.62, 0.64, 0.66] : [0.02, 0.02, 0.022]).setPbr(0.35, d.front === 'estate' ? 1 : 0);
    const n = lod === 0 ? 40 : lod === 1 ? 12 : 4;
    const z0 = d.roofRearZ + 0.06;
    const z1 = d.roofFrontZ - 0.06;
    const rows: number[][] = [];
    const P0 = { x: 0, y: 0, z: 0 };
    const N0 = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= n; i++) {
      const z = lerp(z0, z1, i / n);
      const g0 = m.gh(z);
      m.ghPos(z, g0.cornerEnd + 0.02, P0, N0);
      const endFade = Math.min(1, Math.min(i, n - i) / (n * 0.06));
      const hgt = 0.012 + 0.03 * endFade;
      const w = 0.026;
      const row = [
        detSym.vert(P0.x - w / 2, P0.y + 0.002, P0.z, -1, 0, 0),
        detSym.vert(P0.x - w / 2, P0.y + hgt, P0.z, -0.4, 1, 0),
        detSym.vert(P0.x + w / 2, P0.y + hgt, P0.z, 0.4, 1, 0),
        detSym.vert(P0.x + w / 2, P0.y + 0.002, P0.z, 1, 0, 0),
      ];
      rows.push(row);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let k = 0; k < 3; k++) {
        orientTriPreferred(detSym, rows[i][k], rows[i][k + 1], rows[i + 1][k], rows[i + 1][k + 1]);
      }
    }
  }

  // ---------------- centre parts: plates, holders, badges, lettering, exhausts, taxi sign ------------
  const plate = (front: boolean) => {
    const y = front ? feat.plateFront.y : feat.plateRear.y;
    const pos = { x: 0, y: 0, z: 0 };
    const nrm = { x: 0, y: 0, z: 0 };
    m.lowerPos(front ? P : 0, y, pos, nrm);
    // keep plates vertical-ish
    const n = new THREE.Vector3(0, nrm.y * 0.4, front ? 1 : -1).normalize();
    const zOff = front ? 0.012 : -0.012;
    // holder (detail, black)
    detCtr.setColor([0.01, 0.01, 0.01]).setPbr(0.6, 0);
    const holder = new THREE.BoxGeometry(0.545, 0.128, 0.012);
    const mt = frameAt({ x: 0, y: pos.y, z: pos.z + zOff * 0.4 }, { x: n.x, y: n.y, z: n.z }, new THREE.Vector3(front ? 1 : -1, 0, 0));
    detCtr.addGeometry(holder, mt, puv('white'));
    holder.dispose();
    // plate quad (decal)
    const uv = decalUv(front ? 'plateFront' : 'plateRear');
    const q = new THREE.PlaneGeometry(0.52, 0.11);
    const uva = q.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uva.count; i++) uva.setXY(i, lerp(uv[0], uv[2], uva.getX(i)), lerp(uv[1], uv[3], uva.getY(i)));
    const mq = frameAt({ x: 0, y: pos.y, z: pos.z + zOff * 1.05 }, { x: n.x, y: n.y, z: n.z }, new THREE.Vector3(front ? 1 : -1, 0, 0));
    decal.addGeometry(q, mq);
    q.dispose();
    return { pos, n };
  };
  plate(true);
  plate(false);

  // decal patch conforming to the front/rear face, centred on x = 0
  const centreDecal = (front: boolean, y: number, w: number, hh: number, rect: DecalRectName) => {
    const uv = decalUv(rect);
    const nx = 12;
    const ny = 2;
    const ids: number[][] = [];
    const pos = { x: 0, y: 0, z: 0 };
    const nrm = { x: 0, y: 0, z: 0 };
    for (let i = 0; i <= nx; i++) {
      const x = lerp(-w / 2, w / 2, i / nx);
      const row: number[] = [];
      for (let j = 0; j <= ny; j++) {
        const yy = lerp(y - hh / 2, y + hh / 2, j / ny);
        const p = front ? m.frontP(Math.abs(x)) : m.rearP(Math.abs(x));
        m.lowerPos(p, yy, pos, nrm);
        const sx = x < 0 ? -1 : 1;
        // texture runs left-to-right as seen from outside
        // (+x is the car's left: seen from behind the text starts at +x, from the front at -x)
        const u = front ? lerp(uv[0], uv[2], i / nx) : lerp(uv[0], uv[2], 1 - i / nx);
        row.push(decal.vert(sx * pos.x + sx * nrm.x * 0.0015, pos.y + nrm.y * 0.0015, pos.z + nrm.z * 0.0015, sx * nrm.x, nrm.y, nrm.z, u, lerp(uv[1], uv[3], j / ny)));
      }
      ids.push(row);
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      orientTri(decal, ids[i][j], ids[i + 1][j], ids[i][j + 1]);
      orientTri(decal, ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
    }
  };
  if (lod < 2) {
    const yb = feat.badgeRear[1];
    centreDecal(false, yb - 0.075, 0.36, 0.04, 'brand');
    // badges
    const badge = (front: boolean) => {
      const y = front ? feat.badgeFront[1] : yb;
      const pos = { x: 0, y: 0, z: 0 };
      const nrm = { x: 0, y: 0, z: 0 };
      m.lowerPos(front ? P : 0, y, pos, nrm);
      const shape = badgeShape(d.badge);
      const geo =
        lod === 0
          ? new THREE.ExtrudeGeometry(shape, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 1, curveSegments: 10 })
          : new THREE.ShapeGeometry(shape, 4).translate(0, 0, 0.003);
      const s = front ? 1 : 0.85;
      const mt = frameAt({ x: 0, y: pos.y, z: pos.z + (front ? 0.004 : -0.004) }, { x: 0, y: nrm.y, z: nrm.z }, new THREE.Vector3(front ? 1 : -1, 0, 0)).multiply(
        new THREE.Matrix4().makeScale(s, s, 1),
      );
      detCtr.setColor([0.86, 0.88, 0.9]).setPbr(0.1, 1);
      detCtr.addGeometry(geo, mt, puv('white'));
      geo.dispose();
    };
    badge(true);
    badge(false);
  }
  // exhaust tips
  if (lod < 2) {
    for (const [ex, ey] of feat.exhausts) {
      const pos = { x: 0, y: 0, z: 0 };
      m.lowerPos(m.rearP(Math.abs(ex)), ey + 0.03, pos);
      const r = d.exhaust === 'twin' ? 0.036 : 0.042;
      const tip = new THREE.CylinderGeometry(r, r, 0.09, lod === 0 ? 20 : 8, 1, true).rotateX(Math.PI / 2);
      detCtr.setColor([0.78, 0.8, 0.82]).setPbr(0.18, 1);
      detCtr.addGeometry(tip, new THREE.Matrix4().makeTranslation(ex, ey, pos.z + 0.02), puv('white'));
      tip.dispose();
      const inner = new THREE.CircleGeometry(r * 0.9, lod === 0 ? 16 : 8).rotateY(Math.PI);
      detCtr.setColor([0.02, 0.02, 0.02]).setPbr(0.9, 0);
      detCtr.addGeometry(inner, new THREE.Matrix4().makeTranslation(ex, ey, pos.z - 0.0), puv('white'));
      inner.dispose();
    }
  }
  // taxi roof sign
  if (spec.category === 'taxi') {
    const z = 0.5 * (d.roofFrontZ + d.roofRearZ) + 0.25;
    const y = f.topY(z);
    const box = new THREE.BoxGeometry(0.58, 0.14, 0.13);
    const uvs = box.getAttribute('uv') as THREE.BufferAttribute;
    const sign = decalUv('sign');
    const plain = decalUv('signPlain');
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each)
    for (let fi = 0; fi < 6; fi++) {
      const r = fi === 4 || fi === 5 ? sign : plain;
      for (let k = 0; k < 4; k++) {
        const i = fi * 4 + k;
        const u = uvs.getX(i);
        const v = uvs.getY(i);
        uvs.setXY(i, lerp(r[0], r[2], fi === 5 ? u : u), lerp(r[1], r[3], v));
      }
    }
    decal.addGeometry(box, new THREE.Matrix4().makeTranslation(0, y + 0.09, z));
    box.dispose();
    detCtr.setColor([0.02, 0.02, 0.02]).setPbr(0.5, 0);
    const foot = new THREE.BoxGeometry(0.5, 0.025, 0.09);
    detCtr.addGeometry(foot, new THREE.Matrix4().makeTranslation(0, y + 0.012, z), puv('white'));
    foot.dispose();
  }

  // ---------------- interior ----------------
  if (lod === 0) buildInterior(m, bm, interior);

  // ---------------- anchors ----------------
  const pos = { x: 0, y: 0, z: 0 };
  const pr = h.projectors[0] ?? { p: h.drl[0][0], y: h.drl[0][1], r: 0 };
  m.lowerPos(pr.p, pr.y, pos);
  const headL = new THREE.Vector3(pos.x, pos.y, pos.z);
  const bc = t.brake.reduce((a, q) => [a[0] + q[0] / t.brake.length, a[1] + q[1] / t.brake.length], [0, 0]);
  m.lowerPos(bc[0], bc[1], pos);
  const tailL = new THREE.Vector3(pos.x, pos.y, pos.z);
  const exhaust = feat.exhausts.map(([x, y]) => {
    m.lowerPos(m.rearP(Math.abs(x)), y + 0.03, pos);
    return new THREE.Vector3(x, y, pos.z - 0.03);
  });
  if (!exhaust.length && !spec.electric) {
    m.lowerPos(m.rearP(0.4), d.rearBottomY + 0.02, pos);
    exhaust.push(new THREE.Vector3(0.4, d.rearBottomY, pos.z));
  }
  const anchors: LightAnchors = {
    headL,
    headR: headL.clone().setX(-headL.x),
    tailL,
    tailR: tailL.clone().setX(-tailL.x),
    exhaust,
    driverEye: new THREE.Vector3(...seatLayout(m).eye),
  };

  // ---------------- merge ----------------
  bodySym.mirrorX();
  bodySym.append(bodyCtr);
  detSym.mirrorX();
  detSym.append(detCtr);
  mirrorLights(litSym);
  litSym.append(litCtr);
  lensSym.mirrorX();
  return { body: bodySym, detail: detSym, interior, lights: litSym, decal, lens: lensSym, anchors };
}

/** quad (a,b) row i, (c,d) row i+1: oriented by the vertex normals */
function orientTriPreferred(mb: MeshBuilder, a: number, b: number, c: number, d: number): void {
  orientTri(mb, a, b, c);
  orientTri(mb, c, b, d);
}

/** recompute smooth normals for vertices from `from` using the triangles that reference them */
function smoothNormals(mb: MeshBuilder, from: number): void {
  const n = mb.vertexCount;
  const acc = new Float64Array((n - from) * 3);
  for (let i = 0; i < mb.idx.length; i += 3) {
    const a = mb.idx[i];
    const b = mb.idx[i + 1];
    const c = mb.idx[i + 2];
    if (a < from || b < from || c < from) continue;
    const p = mb.pos;
    const ux = p[3 * b] - p[3 * a];
    const uy = p[3 * b + 1] - p[3 * a + 1];
    const uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a];
    const vy = p[3 * c + 1] - p[3 * a + 1];
    const vz = p[3 * c + 2] - p[3 * a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      acc[3 * (v - from)] += nx;
      acc[3 * (v - from) + 1] += ny;
      acc[3 * (v - from) + 2] += nz;
    }
  }
  for (let v = from; v < n; v++) {
    const k = 3 * (v - from);
    const l = Math.hypot(acc[k], acc[k + 1], acc[k + 2]) || 1;
    mb.nrm[3 * v] = acc[k] / l;
    mb.nrm[3 * v + 1] = acc[k + 1] / l;
    mb.nrm[3 * v + 2] = acc[k + 2] / l;
  }
}

/** fictional brand emblems (no real logos) */
function badgeShape(kind: string): THREE.Shape[] {
  const s = new THREE.Shape();
  const ring = (r0: number, r1: number) => {
    s.absarc(0, 0, r1, 0, Math.PI * 2, false);
    const h = new THREE.Path();
    h.absarc(0, 0, r0, 0, Math.PI * 2, true);
    s.holes.push(h);
  };
  switch (kind) {
    case 'ring': {
      ring(0.034, 0.042);
      return [s, chevron()];
    }
    case 'rhomb': {
      s.moveTo(0, 0.04);
      s.lineTo(0.03, 0);
      s.lineTo(0, -0.04);
      s.lineTo(-0.03, 0);
      s.closePath();
      const h = new THREE.Path();
      h.moveTo(0, 0.032);
      h.lineTo(-0.023, 0);
      h.lineTo(0, -0.032);
      h.lineTo(0.023, 0);
      h.closePath();
      s.holes.push(h);
      return [s];
    }
    case 'oval': {
      s.absellipse(0, 0, 0.05, 0.026, 0, Math.PI * 2, false, 0);
      const h = new THREE.Path();
      h.absellipse(0, 0, 0.044, 0.02, 0, Math.PI * 2, true, 0);
      s.holes.push(h);
      return [s];
    }
    case 'shield': {
      s.moveTo(-0.03, 0.035);
      s.lineTo(0.03, 0.035);
      s.lineTo(0.03, -0.005);
      s.quadraticCurveTo(0.028, -0.03, 0, -0.042);
      s.quadraticCurveTo(-0.028, -0.03, -0.03, -0.005);
      s.closePath();
      const h = new THREE.Path();
      h.moveTo(-0.024, 0.029);
      h.quadraticCurveTo(-0.022, -0.026, 0, -0.035);
      h.quadraticCurveTo(0.022, -0.026, 0.024, 0.029);
      h.closePath();
      s.holes.push(h);
      return [s];
    }
    case 'hex': {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        if (i === 0) s.moveTo(Math.cos(a) * 0.042, Math.sin(a) * 0.036);
        else s.lineTo(Math.cos(a) * 0.042, Math.sin(a) * 0.036);
      }
      s.closePath();
      const h = new THREE.Path();
      for (let i = 5; i >= 0; i--) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        if (i === 5) h.moveTo(Math.cos(a) * 0.034, Math.sin(a) * 0.028);
        else h.lineTo(Math.cos(a) * 0.034, Math.sin(a) * 0.028);
      }
      h.closePath();
      s.holes.push(h);
      return [s];
    }
    default: {
      ring(0.034, 0.041);
      return [s, wave()];
    }
  }
}

function chevron(): THREE.Shape {
  const c = new THREE.Shape();
  c.moveTo(-0.024, -0.014);
  c.lineTo(0, 0.02);
  c.lineTo(0.024, -0.014);
  c.lineTo(0.015, -0.014);
  c.lineTo(0, 0.007);
  c.lineTo(-0.015, -0.014);
  c.closePath();
  return c;
}

function wave(): THREE.Shape {
  const c = new THREE.Shape();
  c.moveTo(-0.026, -0.004);
  c.bezierCurveTo(-0.012, 0.016, 0.012, -0.024, 0.026, -0.004);
  c.lineTo(0.026, 0.004);
  c.bezierCurveTo(0.012, -0.016, -0.012, 0.024, -0.026, 0.004);
  c.closePath();
  return c;
}

