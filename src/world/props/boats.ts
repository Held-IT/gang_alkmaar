// Moored boats in the canals: Dutch sloepen (open launches, some under a canvas cover), small open
// bootjes, steel cabin cruisers, houseboats (woonarken, on the wide Singel water, with mooring
// posts) and a few canal tour boats (rondvaartboten; one always at the Mient quay by the Waag).
// Placed along the water polygon edges of map2d.json, parallel to the quay with a little skew,
// in irregular stretches, inside the playable rect, away from bridges, leaving the canal navigable.
// Three LODs; shadow and water reflection use the next coarser shape.
// Boats float at WATER_LEVEL with a gentle bob in the vertex shader (propMaterial bob).
import * as THREE from 'three';
import type { Map2D, Rect, RoadGraph } from '../../contracts';
import { WATER_LEVEL } from '../../config';
import { PropBatch, type BatchLod } from './util/batch';
import { MeshBuilder, box, cylinder, mat, sweep, type Style } from './util/geom';
import { createPropDepthMaterial, createPropMaterial } from './util/propMaterial';
import type { Colliders } from './util/physicsStub';
import { getGrungeTexture } from './util/textures';
import { getFurnitureMaterial } from './street';
import { Rng } from './util/rng';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface HullSpec {
  L: number;
  B: number;
  /** gunwale height above the waterline at the stern / bow */
  sheerAft: number;
  sheerBow: number;
  draft: number;
  /** transom width as a fraction of the beam */
  transom: number;
}

/**
 * Hull surface: stations along z (stern -L/2 .. bow +L/2), U-shaped sections from the keel to the
 * gunwale. Returns the outer skin (paint), inner skin and a list of gunwale points per side.
 */
function hull(b: MeshBuilder, h: HullSpec, lod: number, outer: Style, inner: Style | null): { gunwale: THREE.Vector3[][]; halfBeamAt: (t: number) => number; sheerAt: (t: number) => number } {
  const ns = lod === 0 ? 22 : lod === 1 ? 10 : 6;
  const nk = lod === 0 ? 7 : lod === 1 ? 4 : 2;
  const halfBeamAt = (t: number) => {
    // t: 0 = stern, 1 = bow
    if (t < 0.45) return (h.B / 2) * (h.transom + (1 - h.transom) * Math.sin((t / 0.45) * Math.PI / 2));
    const u = (t - 0.45) / 0.55;
    return (h.B / 2) * Math.pow(Math.max(0, 1 - Math.pow(u, 2.2)), 0.62);
  };
  const sheerAt = (t: number) => h.sheerAft + (h.sheerBow - h.sheerAft) * Math.pow(t, 2.2);
  const keelAt = (t: number) => -h.draft + h.draft * 0.9 * THREE.MathUtils.smoothstep(t, 0.7, 1.0) + h.draft * 0.25 * Math.pow(1 - t, 3);
  const pts: THREE.Vector3[][] = []; // [station][k] for +x side
  for (let i = 0; i <= ns; i++) {
    const t = i / ns;
    const z = -h.L / 2 + t * h.L;
    const hb = Math.max(0.005, halfBeamAt(t));
    const yk = keelAt(t), yg = sheerAt(t);
    const row: THREE.Vector3[] = [];
    for (let k = 0; k <= nk; k++) {
      const s = k / nk;
      const x = hb * Math.pow(Math.sin((s * Math.PI) / 2), 0.55);
      const y = yk + (yg - yk) * (1 - Math.cos((s * Math.PI) / 2));
      row.push(V(x, y, z));
    }
    pts.push(row);
  }
  const skin = (side: number, inside: boolean, style: Style) => {
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
    const c = new THREE.Color(style.color);
    for (let i = 0; i <= ns; i++) {
      for (let k = 0; k <= nk; k++) {
        const p = pts[i][k];
        const sh = inside ? 0.94 : 1;
        pos.push(p.x * side * sh, inside ? Math.max(p.y, 0.05) : p.y, p.z * (inside ? 0.985 : 1));
        // approximate normal: outward from the centreline, tilted by the section slope
        const pn = pts[i][Math.min(nk, k + 1)], pp = pts[i][Math.max(0, k - 1)];
        const tx = pn.x - pp.x, ty = pn.y - pp.y;
        let nx = ty * side, ny = -tx;
        const l = Math.hypot(nx, ny) || 1;
        nx /= l; ny /= l;
        if (inside) { nx = -nx; ny = -ny; }
        nor.push(nx, ny, 0);
        uv.push(p.z, p.y);
        col.push(c.r, c.g, c.b);
      }
    }
    const row = nk + 1;
    for (let i = 0; i < ns; i++) {
      for (let k = 0; k < nk; k++) {
        const a = i * row + k, bq = a + 1, cq = a + row, d = cq + 1;
        // (a, bq, cq) faces outwards on the +x side; mirrored / inner skins reverse it
        if ((side > 0) !== inside) idx.push(a, bq, cq, bq, d, cq);
        else idx.push(a, cq, bq, bq, cq, d);
      }
    }
    b.addRaw(pos, nor, uv, idx, col, style);
  };
  skin(1, false, outer);
  skin(-1, false, outer);
  if (inner) {
    skin(1, true, inner);
    skin(-1, true, inner);
  }
  // transom (flat stern)
  {
    const shape = new THREE.Shape();
    const row = pts[0];
    shape.moveTo(-row[nk].x, row[nk].y);
    for (let k = nk; k >= 0; k--) shape.lineTo(-row[k].x, row[k].y);
    for (let k = 0; k <= nk; k++) shape.lineTo(row[k].x, row[k].y);
    const g = new THREE.ShapeGeometry(shape);
    g.rotateY(Math.PI);
    g.translate(0, 0, -h.L / 2);
    b.add(g, null, outer);
    const g2 = new THREE.ShapeGeometry(shape);
    g2.translate(0, 0, -h.L / 2 + 0.01);
    b.add(g2, null, inner ?? outer);
  }
  const gunwale = [1, -1].map((side) => pts.map((r) => V(r[nk].x * side, r[nk].y, r[nk].z)));
  return { gunwale, halfBeamAt, sheerAt };
}

/** Horizontal deck/floor outline following the hull between stations t0..t1 (y = 0, faces up). */
function deckShape(halfBeamAt: (t: number) => number, L: number, t0: number, t1: number, scale: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = 14;
  const pt = (i: number) => t0 + (i / n) * (t1 - t0);
  for (let i = 0; i <= n; i++) {
    const t = pt(i);
    const x = -halfBeamAt(t) * scale, zz = -(-L / 2 + t * L);
    if (i === 0) shape.moveTo(x, zz); else shape.lineTo(x, zz);
  }
  for (let i = n; i >= 0; i--) {
    const t = pt(i);
    shape.lineTo(halfBeamAt(t) * scale, -(-L / 2 + t * L));
  }
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2); // shape (x, -z) -> world (x, 0, z), normal +y
  return g;
}

const WOOD: Style = { color: 0x8a5c36, rough: 0.55 };
const TEAK: Style = { color: 0x9b7448, rough: 0.7 };
const WHITE: Style = { color: 0xe9e9e4, rough: 0.35 };
const DARK: Style = { color: 0x1d1f21, rough: 0.5, metal: 0.2 };
const CHROME: Style = { color: 0xc4c7ca, rough: 0.2, metal: 0.95 };
const PAINT: Style = { color: 0xffffff, rough: 0.28, metal: 0.05, paint: 1 };
const CANVAS: Style = { color: 0x24384a, rough: 0.95 };
const GLASS: Style = { color: 0x22343c, rough: 0.04, metal: 0.5 };
const OUTBOARD: Style = { color: 0x1a1a1b, rough: 0.35, metal: 0.2 };

/** Far LOD of an open / covered small boat: hull, a flat top and the outboard (~70 tris). */
function farTop(b: MeshBuilder, h: HullSpec, halfBeamAt: (t: number) => number, y: number, style: Style, outboard = true): void {
  b.add(deckShape(halfBeamAt, h.L, 0.02, 0.97, 0.96), mat(0, y, 0), style);
  if (outboard) b.add(box(0.36, 0.5, 0.42), mat(0, h.sheerAft + 0.15, -h.L / 2 - 0.25), OUTBOARD);
}

function buildSloep(lod: number, covered: boolean): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const h: HullSpec = { L: 6.2, B: 2.15, sheerAft: 0.55, sheerBow: 0.86, draft: 0.38, transom: 0.84 };
  const { gunwale, halfBeamAt, sheerAt } = hull(b, h, lod, PAINT, lod < 2 ? WHITE : null);
  if (lod >= 2) {
    farTop(b, h, halfBeamAt, covered ? sheerAt(0.5) + 0.12 : h.sheerAft - 0.14, covered ? CANVAS : TEAK);
    return b.build();
  }
  // rub rail (fender strip) along the gunwale
  for (const g of gunwale) b.add(sweep(g, lod === 0 ? 0.045 : 0.05, lod === 0 ? 6 : 3), null, lod === 0 ? WOOD : DARK);
  // cockpit floor
  // (kept above the waterline: the canal surface is one flat plane that would show inside the hull)
  const floorY = 0.07;
  b.add(deckShape(halfBeamAt, h.L, 0.03, 0.83, 0.82), mat(0, floorY, 0), TEAK);
  // U-shaped bench at the stern + side benches
  const benchY = 0.3;
  b.add(box(h.B * 0.72, 0.06, 0.45), mat(0, benchY, -h.L / 2 + 0.45), TEAK);
  b.add(box(h.B * 0.72, benchY - floorY, 0.4), mat(0, (benchY + floorY) / 2, -h.L / 2 + 0.45), WHITE);
  for (const s of [-1, 1]) {
    b.add(box(0.4, 0.06, 1.9), mat(s * (h.B / 2 - 0.36), benchY, -h.L / 2 + 1.6), TEAK);
    b.add(box(0.36, benchY - floorY, 1.9), mat(s * (h.B / 2 - 0.36), (benchY + floorY) / 2, -h.L / 2 + 1.6), WHITE);
  }
  // fore deck
  {
    const t0 = 0.8;
    const z0 = -h.L / 2 + t0 * h.L;
    const len = h.L / 2 - z0;
    const hw = halfBeamAt(t0);
    const g = new THREE.BufferGeometry();
    const yy = sheerAt(t0) - 0.04, yb = sheerAt(1) - 0.04;
    g.setAttribute('position', new THREE.Float32BufferAttribute([-hw, yy, z0, hw, yy, z0, 0, yb, z0 + len], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    g.setIndex([0, 2, 1]);
    b.add(g, null, TEAK);
  }
  if (!covered) {
    // steering console with windscreen and wheel
    const cz = 0.55;
    b.add(box(0.55, 0.75, 0.45), mat(0.35, floorY + 0.375, cz), WHITE);
    if (lod === 0) {
      b.add(box(0.6, 0.28, 0.02), mat(0.35, floorY + 0.88, cz + 0.2, -0.45, 0, 0), { color: 0x3a4a50, rough: 0.05, metal: 0.3 });
      const wheel = new THREE.TorusGeometry(0.16, 0.015, 4, 16);
      b.add(wheel, mat(0.35, floorY + 0.85, cz - 0.24, -0.6, 0, 0), DARK);
      // cushions
      b.add(box(h.B * 0.66, 0.08, 0.4), mat(0, benchY + 0.07, -h.L / 2 + 0.45), { color: 0x2c3a4c, rough: 0.9 });
    }
    // outboard engine on the transom
    b.add(box(0.36, 0.5, 0.42), mat(0, h.sheerAft + 0.15, -h.L / 2 - 0.25), { color: 0x1a1a1b, rough: 0.35, metal: 0.2 });
    b.add(box(0.12, 0.7, 0.14), mat(0, h.sheerAft - 0.35, -h.L / 2 - 0.22), { color: 0x2a2b2c, rough: 0.4 });
  } else {
    // canvas cover (huif) over the cockpit, slightly sagging
    const n = lod === 0 ? 14 : 6;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
    const canvas = new THREE.Color(0x24384a);
    const m = 8;
    for (let i = 0; i <= n; i++) {
      const t = 0.02 + (i / n) * 0.78;
      const z = -h.L / 2 + t * h.L;
      const hb = halfBeamAt(t) + 0.02;
      const yg = sheerAt(t) + 0.02;
      for (let k = 0; k <= m; k++) {
        const s = k / m;
        const x = (s * 2 - 1) * hb;
        const y = yg + 0.32 * Math.sin(s * Math.PI) * (0.7 + 0.3 * Math.sin(t * Math.PI)) - 0.03 * Math.sin(i * 1.9) * Math.sin(s * Math.PI);
        pos.push(x, y, z);
        nor.push(-(s * 2 - 1) * 0.6, 0.8, 0);
        uv.push(x, z);
        col.push(canvas.r, canvas.g, canvas.b);
      }
    }
    for (let i = 0; i < n; i++) for (let k = 0; k < m; k++) {
      const a = i * (m + 1) + k, bq = a + 1, cq = a + m + 1, d = cq + 1;
      idx.push(a, bq, cq, bq, d, cq);
    }
    b.addRaw(pos, nor, uv, idx, col, { rough: 0.95 });
    b.add(box(0.36, 0.45, 0.4), mat(0, h.sheerAft + 0.12, -h.L / 2 - 0.24), { color: 0x1a1a1b, rough: 0.35 });
  }
  // fenders hanging over the side (white, left side only: moored side)
  if (lod === 0) {
    for (const z of [-1.4, 0.2, 1.6]) b.add(cylinder(0.07, 0.07, 0.38, 8), mat(h.B / 2 + 0.03, 0.0, z), WHITE);
    // mooring cleats
    for (const z of [-h.L / 2 + 0.2, h.L / 2 - 0.5]) b.add(box(0.06, 0.04, 0.16), mat(0, sheerAt(z > 0 ? 0.9 : 0.05) + 0.03, z), CHROME);
  }
  return b.build();
}

function buildTourBoat(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const h: HullSpec = { L: 17.5, B: 3.7, sheerAft: 0.5, sheerBow: 0.68, draft: 0.65, transom: 0.86 };
  const { gunwale, halfBeamAt, sheerAt } = hull(b, h, lod, { color: 0x14284a, rough: 0.3, metal: 0.1 }, null);
  if (lod < 2) for (const g of gunwale) b.add(sweep(g, 0.06, lod === 0 ? 6 : 3), null, WHITE);
  // deck
  b.add(deckShape(halfBeamAt, h.L, 0, 1, 1), mat(0, 0.45, 0), TEAK);
  // white band above the waterline
  b.add(box(0.02, 0.12, h.L * 0.7), mat(h.B / 2 - 0.02, 0.22, -0.8), WHITE);
  b.add(box(0.02, 0.12, h.L * 0.7), mat(-h.B / 2 + 0.02, 0.22, -0.8), WHITE);
  // glass saloon
  const z0 = -h.L / 2 + 1.3, z1 = h.L / 2 - 3.2;
  const cl = z1 - z0, cz = (z0 + z1) / 2;
  const w = h.B - 0.5;
  const base = sheerAt(0.5);
  b.add(box(w, 0.35, cl), mat(0, base + 0.15, cz), WHITE);
  b.add(box(w - 0.04, 0.85, cl - 0.04), mat(0, base + 0.75, cz), GLASS);
  // window posts
  if (lod === 0) {
    for (let i = 0; i <= 10; i++) {
      const z = z0 + (i / 10) * cl;
      for (const s of [-1, 1]) b.add(box(0.05, 0.85, 0.06), mat(s * (w / 2), base + 0.75, z), WHITE);
    }
    // seats seen through the glass
    for (let i = 0; i < 9; i++) for (const s of [-1, 1]) b.add(box(0.55, 0.5, 0.4), mat(s * 0.65, base + 0.3, z0 + 0.8 + i * (cl - 1.4) / 8), { color: 0x6b1c1f, rough: 0.8 });
  }
  // curved roof
  {
    const n = 8;
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      pts.push([(s - 0.5) * (w + 0.12), base + 1.2 + 0.12 * Math.sin(s * Math.PI)]);
    }
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
    const c = new THREE.Color(0xe7e7e2);
    for (const z of [z0 - 0.1, z1 + 0.1]) for (const [x, y] of pts) {
      pos.push(x, y, z);
      nor.push(x * 0.15, 1, 0);
      uv.push(x, z);
      col.push(c.r, c.g, c.b);
    }
    for (let i = 0; i < n; i++) idx.push(i, i + 1, i + n + 1, i + 1, i + n + 2, i + n + 1);
    b.addRaw(pos, nor, uv, idx, col, { rough: 0.4 });
  }
  // wheelhouse at the stern end of the saloon + rail at the bow
  b.add(box(1.4, 1.0, 1.1), mat(0, base + 0.5, z0 - 0.6), WHITE);
  if (lod === 0) {
    const rail: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const t = 0.82 + (i / 10) * 0.17;
      rail.push(V(halfBeamAt(t) - 0.08, sheerAt(t) + 0.55, -h.L / 2 + t * h.L));
    }
    const railL = rail.map((p) => V(-p.x, p.y, p.z)).reverse();
    b.add(sweep([...railL, ...rail], 0.02, 4), null, CHROME);
  }
  return b.build();
}

/** Small open polyester boat ("bootje") with two thwarts and a tiller outboard. */
function buildBootje(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const h: HullSpec = { L: 4.3, B: 1.7, sheerAft: 0.46, sheerBow: 0.66, draft: 0.3, transom: 0.8 };
  const { gunwale, halfBeamAt } = hull(b, h, lod, PAINT, lod < 2 ? { color: 0xd8d6cf, rough: 0.5 } : null);
  if (lod >= 2) {
    farTop(b, h, halfBeamAt, h.sheerAft - 0.12, { color: 0xc9c6bd, rough: 0.6 });
    return b.build();
  }
  for (const g of gunwale) b.add(sweep(g, 0.035, lod === 0 ? 5 : 3), null, DARK);
  b.add(deckShape(halfBeamAt, h.L, 0.03, 0.85, 0.8), mat(0, 0.06, 0), { color: 0xb8b4aa, rough: 0.7 });
  for (const z of [-1.4, 0.3]) b.add(box(h.B * 0.8, 0.05, 0.28), mat(0, 0.32, z), TEAK);
  // tiller outboard
  b.add(box(0.3, 0.42, 0.36), mat(0, h.sheerAft + 0.12, -h.L / 2 - 0.2), OUTBOARD);
  b.add(box(0.1, 0.6, 0.12), mat(0, h.sheerAft - 0.3, -h.L / 2 - 0.18), DARK);
  if (lod === 0) {
    b.add(box(0.04, 0.04, 0.6), mat(0, h.sheerAft + 0.3, -h.L / 2 + 0.05, 0.25, 0, 0), DARK);
    for (const z of [-0.8, 0.9]) b.add(cylinder(0.06, 0.06, 0.3, 8), mat(h.B / 2 + 0.02, 0.05, z), WHITE);
  }
  return b.build();
}

/** Small steel cabin cruiser ("kruiser") with a white cabin, aft cockpit and a Dutch flag. */
function buildKruiser(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const h: HullSpec = { L: 8.6, B: 2.7, sheerAft: 0.72, sheerBow: 1.0, draft: 0.6, transom: 0.9 };
  const { gunwale, halfBeamAt } = hull(b, h, lod, PAINT, null);
  const deckY = h.sheerAft - 0.02;
  b.add(deckShape(halfBeamAt, h.L, 0, 1, 0.99), mat(0, deckY, 0), lod < 2 ? TEAK : WHITE);
  if (lod < 2) for (const g of gunwale) b.add(sweep(g, 0.05, lod === 0 ? 5 : 3), null, WHITE);
  // cabin forward of the middle, window band, roof
  const cw = h.B * 0.68, cl = h.L * 0.4, cz = 0.5;
  b.add(box(cw, 0.85, cl), mat(0, deckY + 0.42, cz), WHITE);
  if (lod < 2) {
    b.add(box(cw + 0.02, 0.3, cl - 0.5), mat(0, deckY + 0.55, cz - 0.1), GLASS);
    b.add(box(cw - 0.1, 0.36, 0.04), mat(0, deckY + 1.0, cz - cl / 2 - 0.05, -0.35, 0, 0), GLASS);
  }
  b.add(box(cw + 0.12, 0.07, cl + 0.15), mat(0, deckY + 0.88, cz), lod < 2 ? { color: 0xdedbd2, rough: 0.5 } : WHITE);
  if (lod === 0) {
    // aft cockpit: seats + flagpole with the Dutch tricolour on the transom
    b.add(box(h.B * 0.7, 0.35, 0.45), mat(0, deckY + 0.17, -h.L / 2 + 0.6), { color: 0x2c3a4c, rough: 0.9 });
    b.add(cylinder(0.02, 0.02, 1.2, 6), mat(0, deckY, -h.L / 2 + 0.1), WOOD);
    const fc = [0xae1c28, 0xf4f4f0, 0x21468b];
    fc.forEach((c, i) => b.add(box(0.01, 0.12, 0.55), mat(0, deckY + 1.12 - i * 0.12, -h.L / 2 - 0.2), { color: c, rough: 0.8 }));
    for (const z of [-2.2, 0, 2.2]) b.add(cylinder(0.08, 0.08, 0.42, 8), mat(h.B / 2 + 0.03, 0.15, z), WHITE);
  }
  return b.build();
}

/** Houseboat ("woonark"): concrete pontoon with a timber-clad house (cladding = instance colour). */
function buildWoonboot(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const L = 16, B = 5;
  const top = 0.75;
  b.add(box(B, 1.2, L), mat(0, top - 0.6, 0), { color: 0x55575a, rough: 0.85 });
  const hl = L - 4, hw = B - 0.7, hh = 2.5, hz = -0.6;
  b.add(box(hw, hh, hl), mat(0, top + hh / 2, hz), { color: 0xffffff, rough: 0.75, paint: 1 });
  // flat roof with overhang + dark fascia
  b.add(box(hw + 0.5, 0.18, hl + 0.6), mat(0, top + hh + 0.09, hz), { color: 0x2b2c2e, rough: 0.8 });
  if (lod < 2) {
    b.add(box(B - 0.1, 0.03, L - 0.1), mat(0, top + 0.015, 0), TEAK);
    // windows on both long sides, a glass end wall (terrace end) and a door at the other end
    const nw = lod === 0 ? 4 : 2;
    for (const sx of [-1, 1]) {
      for (let i = 0; i < nw; i++) {
        const z = hz - hl / 2 + ((i + 0.5) / nw) * hl;
        b.add(box(0.06, 1.25, lod === 0 ? 1.5 : 3.2), mat(sx * (hw / 2 + 0.01), top + 1.45, z), GLASS);
        if (lod === 0) b.add(box(0.08, 0.08, 1.7), mat(sx * (hw / 2 + 0.02), top + 0.8, z), WHITE);
      }
    }
    b.add(box(hw * 0.7, 1.4, 0.06), mat(0, top + 1.4, hz + hl / 2 + 0.01), GLASS);
    b.add(box(0.9, 2.0, 0.06), mat(0, top + 1.0, hz - hl / 2 - 0.01), { color: 0x6b4a2e, rough: 0.6 });
  }
  if (lod === 0) {
    // front terrace railing + planters
    const rz = L / 2 - 0.15;
    b.add(box(B - 0.3, 0.05, 0.05), mat(0, top + 0.95, rz), WHITE);
    for (const sx of [-1, 1]) b.add(box(0.05, 0.05, 2.6), mat(sx * (B / 2 - 0.15), top + 0.95, rz - 1.3), WHITE);
    for (const x of [-1.6, -0.8, 0, 0.8, 1.6]) b.add(box(0.04, 0.95, 0.04), mat(x, top + 0.47, rz), WHITE);
    for (const x of [-1.5, 1.5]) {
      b.add(box(0.6, 0.45, 0.6), mat(x, top + 0.23, L / 2 - 1.2), { color: 0x6b4a32, rough: 0.8 });
      b.add(box(0.7, 0.5, 0.7), mat(x, top + 0.65, L / 2 - 1.2), { color: 0x3d5a2a, rough: 0.95 });
    }
  }
  return b.build();
}

/** Wooden mooring post (meerpaal), base at the canal bed, ~1.6 m above the water. */
function buildMeerpaal(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add(cylinder(0.14, 0.15, 3.0, lod === 0 ? 8 : 5), mat(0, -1.4, 0), { color: 0x3b2f25, rough: 0.9 });
  if (lod === 0) b.add(cylinder(0.16, 0.16, 0.06, 8), mat(0, 1.6, 0), { color: 0x1d1f21, rough: 0.6 });
  return b.build();
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

type Seg = [number, number, number, number];

class SegGrid {
  private cells = new Map<string, Seg[]>();
  constructor(private readonly cs: number) {}
  add(s: Seg): void {
    const x0 = Math.floor(Math.min(s[0], s[2]) / this.cs), x1 = Math.floor(Math.max(s[0], s[2]) / this.cs);
    const z0 = Math.floor(Math.min(s[1], s[3]) / this.cs), z1 = Math.floor(Math.max(s[1], s[3]) / this.cs);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = `${x},${z}`;
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(s);
    }
  }
  near(x: number, z: number, r: number): Seg[] {
    const out = new Set<Seg>();
    const x0 = Math.floor((x - r) / this.cs), x1 = Math.floor((x + r) / this.cs);
    const z0 = Math.floor((z - r) / this.cs), z1 = Math.floor((z + r) / this.cs);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) for (const s of this.cells.get(`${gx},${gz}`) ?? []) out.add(s);
    return [...out];
  }
}

function distSeg(px: number, pz: number, s: Seg): number {
  const dx = s[2] - s[0], dz = s[3] - s[1];
  const l2 = dx * dx + dz * dz || 1e-9;
  const t = Math.max(0, Math.min(1, ((px - s[0]) * dx + (pz - s[1]) * dz) / l2));
  return Math.hypot(px - (s[0] + t * dx), pz - (s[1] + t * dz));
}

function pointInRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Cached outer-ring bounding boxes (minX, minZ, maxX, maxZ) per water polygon. */
const polyBoxes = new WeakMap<[number, number][][], [number, number, number, number]>();
function polyBox(poly: [number, number][][]): [number, number, number, number] {
  let b = polyBoxes.get(poly);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of poly[0] ?? []) {
      if (x < b[0]) b[0] = x;
      if (z < b[1]) b[1] = z;
      if (x > b[2]) b[2] = x;
      if (z > b[3]) b[3] = z;
    }
    polyBoxes.set(poly, b);
  }
  return b;
}

function inWater(x: number, z: number, polys: [number, number][][][]): boolean {
  for (const poly of polys) {
    if (!poly[0]) continue;
    const bb = polyBox(poly);
    if (x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
    if (!pointInRing(x, z, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(x, z, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/** Smooth value noise in [0, 1] with ~70 m features (decides which quay stretches have boats). */
function mooringNoise(x: number, z: number): number {
  const S = 70;
  const fx = x / S, fz = z / S;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const tx = fx - x0, tz = fz - z0;
  const h = (i: number, j: number) => {
    const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = h(x0, z0), b = h(x0 + 1, z0), c = h(x0, z0 + 1), d = h(x0 + 1, z0 + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Distance from p along direction d to the first water edge (ray cast against segments). */
function rayToShore(px: number, pz: number, dx: number, dz: number, grid: SegGrid, maxD: number): number {
  let best = maxD;
  for (const s of grid.near(px + dx * maxD * 0.5, pz + dz * maxD * 0.5, maxD * 0.5 + 1)) {
    const ex = s[2] - s[0], ez = s[3] - s[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((s[0] - px) * ez - (s[1] - pz) * ex) / den;
    const u = ((s[0] - px) * dz - (s[1] - pz) * dx) / den;
    if (t > 0.3 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return best;
}

type BoatKind = 'sloep' | 'sloep_huif' | 'bootje' | 'kruiser' | 'rondvaart' | 'woonboot';
interface BoatType { kind: BoatKind; L: number; B: number; /** yaw jitter (rad) */ yaw: number }
const TYPES: Record<BoatKind, BoatType> = {
  sloep: { kind: 'sloep', L: 6.6, B: 2.2, yaw: 0.05 },
  sloep_huif: { kind: 'sloep_huif', L: 6.6, B: 2.2, yaw: 0.05 },
  bootje: { kind: 'bootje', L: 4.7, B: 1.75, yaw: 0.07 },
  kruiser: { kind: 'kruiser', L: 9.0, B: 2.75, yaw: 0.03 },
  rondvaart: { kind: 'rondvaart', L: 17.8, B: 3.8, yaw: 0 },
  woonboot: { kind: 'woonboot', L: 16.2, B: 5.1, yaw: 0 },
};

const HULL_COLOURS = [0xf0f0ec, 0x1b2b4a, 0x23412f, 0x5a1c1f, 0xd9cdb0, 0x2a2d30, 0x6f8faa, 0x8a8f8c, 0x2f5d7c, 0xb9472f];
const CRUISER_COLOURS = [0x1b2b4a, 0x23412f, 0x5a1c1f, 0x2a2d30, 0xf0f0ec, 0x3b4e5c];
const CLADDING_COLOURS = [0x2f4a3a, 0x232427, 0x5b6f80, 0xb08a46, 0xe6e4dc, 0x6b2e22, 0x4e5a3a];
/** Mient quay by the Waag, where the rondvaartboten moor (hero placement). */
const MIENT_JETTY: [number, number] = [14, 64];

export function buildBoats(map2d: Map2D, graph: RoadGraph | null, rect: Rect | null, colliders: Colliders, reflect = true): PropBatch[] {
  const material = createPropMaterial({ name: 'boot', map: getGrungeTexture(), bob: true });
  const depth = createPropDepthMaterial({ name: 'boot', bob: true });
  // near: full detail, shadow + reflection from the LOD1 shape; mid: LOD1 (reflection LOD2);
  // far: LOD2 (~70-150 tris)
  const mkBatch = (name: string, build: (lod: number) => THREE.BufferGeometry): PropBatch => {
    const g0 = build(0), g1 = build(1), g2 = build(2);
    const lods: BatchLod[] = [
      {
        dist: 110,
        parts: [{ geometry: g0, material, depthMaterial: depth, castShadow: true }],
        shadowParts: [{ geometry: g1, material, depthMaterial: depth }],
        reflectParts: [{ geometry: g1, material }],
      },
      { dist: 250, parts: [{ geometry: g1, material, castShadow: false }], reflectParts: [{ geometry: g2, material }] },
      { dist: 560, parts: [{ geometry: g2, material, castShadow: false }] },
    ];
    return new PropBatch({ name, lods, colors: true, cellSize: 96, margin: 4, moveThreshold: 2.5, reflect });
  };
  const batches: Record<BoatKind, PropBatch> = {
    sloep: mkBatch('boot_sloep', (l) => buildSloep(l, false)),
    sloep_huif: mkBatch('boot_sloep_huif', (l) => buildSloep(l, true)),
    bootje: mkBatch('boot_bootje', buildBootje),
    kruiser: mkBatch('boot_kruiser', buildKruiser),
    rondvaart: mkBatch('boot_rondvaart', (l) => buildTourBoat(l)),
    woonboot: mkBatch('boot_woonark', buildWoonboot),
  };
  const postMat = getFurnitureMaterial(); // posts stand on the canal bed: no bob
  const posts = new PropBatch({
    name: 'meerpaal',
    lods: [
      { dist: 90, parts: [{ geometry: buildMeerpaal(0), material: postMat, castShadow: true, nearShadow: true }] },
      { dist: 300, parts: [{ geometry: buildMeerpaal(1), material: postMat, castShadow: false }] },
    ],
    cellSize: 96,
    margin: 2,
    reflect,
  });

  const polys = map2d.water ?? [];
  const grid = new SegGrid(25);
  for (const poly of polys) for (const ring of poly) for (let i = 0; i + 1 < ring.length; i++) grid.add([ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]]);
  const bridges = new SegGrid(25);
  let nBridges = 0;
  for (const e of graph?.edges ?? []) {
    if (!e.bridge) continue;
    for (let i = 0; i + 1 < e.pts.length; i++) { bridges.add([e.pts[i][0], e.pts[i][1], e.pts[i + 1][0], e.pts[i + 1][1]]); nBridges++; }
  }
  const inRect = (x: number, z: number) => !rect || (x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ);
  const placed: { x: number; z: number; L: number }[] = [];
  const rng = new Rng(2024);
  let tourBoats = 0, houseboats = 0;
  const col = new THREE.Color();
  const center = new THREE.Vector3();
  const half = new THREE.Vector3();
  const pick = (width: number): BoatType => {
    if (width > 30 && houseboats < 18 && rng.chance(0.2)) return TYPES.woonboot;
    if (width > 22 && tourBoats < 4 && rng.chance(0.12)) return TYPES.rondvaart;
    const r = rng.next();
    if (r < 0.34) return TYPES.sloep;
    if (r < 0.56) return TYPES.sloep_huif;
    if (r < 0.78) return TYPES.bootje;
    return width > 14 ? TYPES.kruiser : TYPES.sloep;
  };

  /**
   * Moors `type` along the quay edge point (px, pz) (edge direction d, water side n); returns
   * false when it does not fit. `minWidth` = required distance to the opposite shore.
   */
  const tryPlace = (type: BoatType, px: number, pz: number, dx: number, dz: number, nx: number, nz: number, minWidth: number, width: number): boolean => {
    if (width < minWidth) return false;
    const off = type.B / 2 + 0.45 + (type.yaw ? rng.range(0, 0.3) : 0.15);
    const cx = px + dx * (type.L / 2) + nx * off, cz = pz + dz * (type.L / 2) + nz * off;
    if (!inRect(cx, cz)) return false;
    // the whole hull must be on the water
    for (const [fl, fw] of [[-0.5, -1], [-0.5, 1], [0.5, -1], [0.5, 1], [0, 0]] as [number, number][]) {
      const qx = cx + dx * fl * type.L + nx * fw * (type.B / 2 + 0.2);
      const qz = cz + dz * fl * type.L + nz * fw * (type.B / 2 + 0.2);
      if (!inWater(qx, qz, polys)) return false;
    }
    for (const sg of grid.near(cx, cz, type.L / 2 + 1)) {
      if (distSeg(cx, cz, sg) < type.B / 2 + 0.25) return false;
    }
    if (nBridges) for (const sg of bridges.near(cx, cz, type.L / 2 + 8)) if (distSeg(cx, cz, sg) < type.L / 2 + 6) return false;
    for (const p of placed) if (Math.hypot(p.x - cx, p.z - cz) < (p.L + type.L) / 2 + 0.7) return false;
    const flip = type.kind === 'woonboot' ? false : rng.chance(0.5);
    // moored boats hang a little skew on their lines
    const rot = Math.atan2(dx, dz) + (flip ? Math.PI : 0) + (type.yaw ? rng.range(-type.yaw, type.yaw) : 0);
    if (type.kind === 'rondvaart') {
      tourBoats++;
      col.setRGB(1, 1, 1);
    } else if (type.kind === 'woonboot') {
      houseboats++;
      col.set(rng.pick(CLADDING_COLOURS));
      // two mooring posts on the water side
      for (const fl of [-0.32, 0.32]) {
        posts.add(cx + dx * fl * type.L + nx * (type.B / 2 + 0.35), WATER_LEVEL, cz + dz * fl * type.L + nz * (type.B / 2 + 0.35), 0);
      }
    } else {
      col.set(rng.pick(type.kind === 'kruiser' ? CRUISER_COLOURS : HULL_COLOURS));
      // the odd post along a busy mooring stretch
      if (rng.chance(0.12)) posts.add(px + nx * 0.4 - dx * 0.5, WATER_LEVEL, pz + nz * 0.4 - dz * 0.5, 0);
    }
    batches[type.kind].add(cx, WATER_LEVEL, cz, rot, 1, col);
    placed.push({ x: cx, z: cz, L: type.L });
    colliders.box(center.set(cx, WATER_LEVEL, cz), half.set(type.B / 2, type.kind === 'woonboot' ? 1.8 : 0.45, type.L / 2), rot, 'boat');
    return true;
  };

  const waterSide = (px: number, pz: number, dx: number, dz: number): [number, number] => {
    const nx = -dz, nz = dx;
    return inWater(px + nx * 1.2, pz + nz * 1.2, polys) ? [nx, nz] : [-nx, -nz];
  };

  // hero: a rondvaartboot at the Mient quay (narrow canal -> relaxed navigability rule)
  {
    let best: Seg | null = null;
    let bestD = 40;
    for (const sg of grid.near(MIENT_JETTY[0], MIENT_JETTY[1], 40)) {
      if (Math.hypot(sg[2] - sg[0], sg[3] - sg[1]) < TYPES.rondvaart.L + 1) continue;
      const d = distSeg(MIENT_JETTY[0], MIENT_JETTY[1], sg);
      if (d < bestD) { bestD = d; best = sg; }
    }
    if (best) {
      const len = Math.hypot(best[2] - best[0], best[3] - best[1]);
      const dx = (best[2] - best[0]) / len, dz = (best[3] - best[1]) / len;
      for (let s = 1; s + TYPES.rondvaart.L <= len + 0.5 && tourBoats === 0; s += 1.5) {
        const px = best[0] + dx * s, pz = best[1] + dz * s;
        const [nx, nz] = waterSide(px, pz, dx, dz);
        const width = rayToShore(px + nx * 0.05, pz + nz * 0.05, nx, nz, grid, 80);
        tryPlace(TYPES.rondvaart, px, pz, dx, dz, nx, nz, TYPES.rondvaart.B + 2.5, width);
      }
    }
  }

  for (const poly of polys) {
    for (const ring of poly) {
      let carry = rng.range(2, 10);
      for (let i = 0; i + 1 < ring.length; i++) {
        const [ax, az] = ring[i], [bx, bz] = ring[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const dx = (bx - ax) / len, dz = (bz - az) / len;
        let s = carry;
        while (s < len) {
          const px = ax + dx * s, pz = az + dz * s;
          const [nx, nz] = waterSide(px, pz, dx, dz);
          const width = rayToShore(px + nx * 0.05, pz + nz * 0.05, nx, nz, grid, 80);
          const type = pick(width);
          // irregular gaps: mostly close together, sometimes an empty berth or two
          const step = type.L + rng.range(0.6, 3.2) + (rng.chance(0.16) ? rng.range(5, 16) : 0);
          let ok = false;
          if (s + type.L <= len + 0.5) {
            // moorings come in stretches: low-frequency noise along the shore decides where boats
            // are allowed; wide water (the Singel) is less crowded than the inner canals
            const busy = mooringNoise(px, pz);
            const p = busy > 0.4 ? 0.85 : busy > 0.25 ? 0.45 : 0.06;
            if (rng.chance(width > 26 && type.kind !== 'woonboot' ? p * 0.6 : p)) {
              ok = tryPlace(type, px, pz, dx, dz, nx, nz, type.B * 2 + 4.5, width); // keep the canal navigable
            }
          }
          s += ok ? step : rng.range(3, 8);
        }
        carry = s - len;
      }
    }
  }
  return [...Object.values(batches), posts].filter((b) => b.count > 0);
}
