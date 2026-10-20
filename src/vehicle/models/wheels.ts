// Wheel geometry: tyre (revolved sidewall profile, tread via bump map), alloy rim (extruded
// spoke face with bevels and concave dish, barrel, flange, hub, lug nuts), brake disc and caliper.
// Built for a LEFT wheel: axle along x, outer face towards +x, centre at the origin.
// Vertex colours + `pbr` (roughness, metalness) drive the shared wheel material (materials.ts).
import * as THREE from 'three';
import type { CarSpec } from '../../contracts';
import { MeshBuilder } from './builder';
import { catmullRom2, lerp } from './curves';
import type { BodyDesign, RimStyle } from './designs';
import { roundPoly, type Pt } from './features';

export interface WheelGeometry {
  /** spinning part: tyre, rim, disc */
  spin: THREE.BufferGeometry;
  /** non-spinning caliper (null at low LOD) */
  caliper: THREE.BufferGeometry | null;
  triangles: number;
}

const TYRE_COL = new THREE.Color(0.028, 0.028, 0.03);
const TREAD_REPEAT = 46;

function colorOf(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** revolve a profile (x = axial, r = radius) around the x axis */
function revolve(
  mb: MeshBuilder,
  prof: { x: number; r: number; v: number }[],
  segs: number,
  uRepeat: number,
  flipNormals = false,
): void {
  // profile normals from neighbours (in the x-r plane)
  const n = prof.length;
  const pn: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = prof[Math.max(0, i - 1)];
    const b = prof[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let tr = b.r - a.r;
    const l = Math.hypot(tx, tr) || 1;
    tx /= l;
    tr /= l;
    // walking the profile from inner bead over the tread to the outer bead, outward = (-tr, tx)
    let nx = -tr;
    let nr = tx;
    if (flipNormals) {
      nx = -nx;
      nr = -nr;
    }
    pn.push([nx, nr]);
  }
  const base = mb.vertexCount;
  for (let s = 0; s <= segs; s++) {
    const ang = (s / segs) * Math.PI * 2;
    const c = Math.cos(ang);
    const si = Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const q = prof[i];
      mb.vert(q.x, q.r * si, q.r * c, pn[i][0], pn[i][1] * si, pn[i][1] * c, (s / segs) * uRepeat, q.v);
    }
  }
  for (let s = 0; s < segs; s++) {
    for (let i = 0; i < n - 1; i++) {
      const a = base + s * n + i;
      const b = base + (s + 1) * n + i;
      if (flipNormals) mb.quad(a, b, b + 1, a + 1);
      else mb.quad(a, a + 1, b + 1, b);
    }
  }
}

interface SpokeLine {
  ti: number; // angle at the inner radius
  to: number; // angle at the outer radius
  w: number; // width (m)
  pair: number; // spokes with the same pair id enclose a "split" window starting at rm
}

function spokeLayout(style: RimStyle): { spokes: SpokeLine[]; holes?: { r: number; a: number; rw: number; rh: number }[]; rmFrac: number } {
  const sp: SpokeLine[] = [];
  const TAU = Math.PI * 2;
  switch (style) {
    case 'vspoke5':
      for (let k = 0; k < 5; k++) {
        const t = (k / 5) * TAU;
        sp.push({ ti: t - 0.045, to: t - 0.17, w: 0.022, pair: k });
        sp.push({ ti: t + 0.045, to: t + 0.17, w: 0.022, pair: k });
      }
      return { spokes: sp, rmFrac: 0.42 };
    case 'yspoke5':
      for (let k = 0; k < 5; k++) {
        const t = (k / 5) * TAU;
        sp.push({ ti: t - 0.03, to: t - 0.2, w: 0.024, pair: k });
        sp.push({ ti: t + 0.03, to: t + 0.2, w: 0.024, pair: k });
      }
      return { spokes: sp, rmFrac: 0.62 };
    case 'turbine10':
      for (let k = 0; k < 10; k++) {
        const t = (k / 10) * TAU;
        sp.push({ ti: t, to: t + 0.24, w: 0.024, pair: -1 - k });
      }
      return { spokes: sp, rmFrac: 0 };
    case 'spoke5':
      for (let k = 0; k < 5; k++) {
        const t = (k / 5) * TAU;
        sp.push({ ti: t, to: t, w: 0.05, pair: -1 - k });
      }
      return { spokes: sp, rmFrac: 0 };
    case 'holes5': {
      const holes = [];
      for (let k = 0; k < 5; k++) holes.push({ r: 0.62, a: (k / 5) * TAU, rw: 0.2, rh: 0.25 });
      return { spokes: [], holes, rmFrac: 0 };
    }
    case 'steelcap': {
      const holes = [];
      for (let k = 0; k < 12; k++) holes.push({ r: 0.74, a: (k / 12) * TAU, rw: 0.06, rh: 0.14 });
      return { spokes: [], holes, rmFrac: 0 };
    }
    case 'aero5':
      // five broad, twisted aero spokes (EV style)
      for (let k = 0; k < 5; k++) {
        const t = (k / 5) * TAU;
        sp.push({ ti: t, to: t + 0.42, w: 0.07, pair: -1 - k });
      }
      return { spokes: sp, rmFrac: 0 };
  }
}

/** window polygons (holes in the rim face) in the face plane (2D, metres) */
function rimWindows(style: RimStyle, ri: number, ro: number, segs: number, cornerSeg = 2): Pt[][] {
  const lay = spokeLayout(style);
  const out: Pt[][] = [];
  const pol = (r: number, a: number): Pt => [Math.cos(a) * r, Math.sin(a) * r];
  if (lay.holes) {
    for (const h of lay.holes) {
      const pts: Pt[] = [];
      const rc = ri + (ro - ri) * h.r;
      const n = Math.max(10, Math.round(segs * 0.5));
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        // ellipse in (radial, tangential) coordinates
        const rr = rc + Math.cos(t) * (ro - ri) * h.rh * 0.5;
        const aa = h.a + (Math.sin(t) * (ro - ri) * h.rw) / rc;
        pts.push(pol(rr, aa));
      }
      out.push(pts);
    }
    return out;
  }
  const sp = [...lay.spokes].sort((a, b) => a.to - b.to);
  const n = sp.length;
  const rm = ri + (ro - ri) * lay.rmFrac;
  for (let j = 0; j < n; j++) {
    const s1 = sp[j];
    const s2 = sp[(j + 1) % n];
    const wrap = j === n - 1 ? Math.PI * 2 : 0;
    const inner = s1.pair === s2.pair && s1.pair >= 0 ? rm : ri;
    const to1 = s1.to + s1.w / 2 / ro;
    const to2 = s2.to + wrap - s2.w / 2 / ro;
    // angles of the spoke edges at the inner radius of this window (interpolate along the spoke)
    const tAt = (s: SpokeLine, r: number, w: number) => {
      const f = (r - ri) / (ro - ri);
      return lerp(s.ti, s.to, f) + w / 2 / r;
    };
    const ti1 = tAt(s1, inner, s1.w);
    const ti2 = tAt({ ...s2, ti: s2.ti + wrap, to: s2.to + wrap }, inner, -s2.w);
    if (to2 - to1 < 0.02) continue;
    const pts: Pt[] = [];
    const k = Math.max(3, Math.round(((to2 - to1) / (Math.PI * 2)) * segs));
    for (let i = 0; i <= k; i++) pts.push(pol(ro, lerp(to1, to2, i / k)));
    if (ti2 - ti1 > 0.01) {
      const k2 = Math.max(2, Math.round(((ti2 - ti1) / (Math.PI * 2)) * segs));
      for (let i = 0; i <= k2; i++) pts.push(pol(inner, lerp(ti2, ti1, i / k2)));
    } else {
      pts.push(pol(inner + 0.01, 0.5 * (ti1 + ti2)));
    }
    out.push(roundPoly(pts, 0.007, cornerSeg));
  }
  return out;
}

export function buildWheel(spec: CarSpec, d: BodyDesign, lod: 0 | 1 | 2): WheelGeometry {
  const mb = new MeshBuilder();
  const R = spec.wheelRadius;
  const w = spec.wheelWidth;
  const Rr = (d.rimInch * 0.0254) / 2; // bead seat radius
  const segs = lod === 0 ? 36 : lod === 1 ? 14 : 10;
  const rimCol = colorOf(d.rimColor);
  const flatV = 0.78;

  // ---------------- tyre ----------------
  mb.setColor([TYRE_COL.r, TYRE_COL.g, TYRE_COL.b]).setPbr(0.86, 0);
  {
    const h = R - Rr;
    const ctrl: [number, number][] = [
      [-w / 2 + 0.014, Rr + 0.006],
      [-w / 2 - 0.004, Rr + 0.3 * h],
      [-w / 2 + 0.002, Rr + 0.72 * h],
      [-w / 2 + 0.016, R - 0.008],
      [-w / 2 + 0.04, R],
      [w / 2 - 0.04, R],
      [w / 2 - 0.016, R - 0.008],
      [w / 2 - 0.002, Rr + 0.72 * h],
      [w / 2 + 0.004, Rr + 0.3 * h],
      [w / 2 - 0.014, Rr + 0.006],
    ];
    const per = lod === 0 ? 2 : 1;
    const prof: { x: number; r: number; v: number }[] = [];
    const tmp: [number, number] = [0, 0];
    const last = ctrl.length - 1;
    for (let i = 0; i < last; i++) {
      // LOD 2: only every other control span on the sidewalls
      if (lod === 2 && (i === 1 || i === 2 || i === 6 || i === 7)) continue;
      // the inner sidewall (x < 0, facing the car) is hardly ever seen: one step per span
      const steps = i < 3 ? 1 : per;
      for (let k = 0; k < steps; k++) {
        catmullRom2(ctrl, i + k / steps, tmp);
        prof.push({ x: tmp[0], r: tmp[1], v: 0 });
      }
    }
    prof.push({ x: ctrl[last][0], r: ctrl[last][1], v: 0 });
    // tread band v in [0.02, 0.48] between the shoulders, flat elsewhere
    const xa = -w / 2 + 0.018;
    const xb = w / 2 - 0.018;
    for (const q of prof) {
      if (q.r > R - 0.012 && q.x > xa && q.x < xb) q.v = 0.02 + ((q.x - xa) / (xb - xa)) * 0.46;
      else q.v = flatV;
    }
    revolve(mb, prof, segs, TREAD_REPEAT);
  }

  // ---------------- rim ----------------
  const ro = Rr - 0.004; // face outer radius
  const xFace = w / 2 - (lod === 2 ? 0.02 : 0.032); // outer face plane of the spokes
  const machined: [number, number, number] = d.rim === 'turbine10' || d.rim === 'yspoke5' || d.rim === 'aero5' ? [0.78, 0.8, 0.82] : rimCol;
  if (lod < 2) {
    // barrel (inside surface) and flange lip
    mb.setColor(rimCol).setPbr(0.32, 1);
    const barrel = [
      { x: w / 2 + 0.002, r: Rr + 0.014, v: flatV },
      { x: w / 2 - 0.004, r: Rr + 0.016, v: flatV },
      { x: w / 2 - 0.012, r: Rr + 0.006, v: flatV },
      { x: w / 2 - 0.016, r: Rr - 0.006, v: flatV },
      { x: xFace - 0.01, r: Rr - 0.012, v: flatV },
    ];
    revolve(mb, barrel, segs, 1);
    // inner barrel (seen through the spokes) darker
    mb.setColor([rimCol[0] * 0.45, rimCol[1] * 0.45, rimCol[2] * 0.45]).setPbr(0.5, 1);
    revolve(
      mb,
      [
        { x: xFace - 0.01, r: Rr - 0.012, v: flatV },
        { x: -w / 2 + 0.02, r: Rr - 0.016, v: flatV },
        { x: -w / 2 + 0.01, r: Rr + 0.01, v: flatV },
      ],
      segs,
      1,
    );
    // spoke face: extruded shape with holes
    const shape = new THREE.Shape();
    const ns = lod === 0 ? 40 : 16;
    for (let i = 0; i <= ns; i++) {
      const a = (i / ns) * Math.PI * 2;
      if (i === 0) shape.moveTo(Math.cos(a) * ro, Math.sin(a) * ro);
      else shape.lineTo(Math.cos(a) * ro, Math.sin(a) * ro);
    }
    const hub = 0.062;
    for (const win of rimWindows(d.rim, hub, ro - 0.012, lod === 0 ? 40 : 16, lod === 0 ? 2 : 1)) {
      const hole = new THREE.Path();
      // holes must wind opposite to the outline
      const pts = [...win].reverse();
      pts.forEach((q, i) => (i ? hole.lineTo(q[0], q[1]) : hole.moveTo(q[0], q[1])));
      hole.closePath();
      shape.holes.push(hole);
    }
    const depth = d.rim === 'steelcap' ? 0.006 : 0.022;
    const bevel = lod === 0 && d.rim !== 'steelcap';
    let geo: THREE.BufferGeometry;
    if (lod === 0) {
      geo = new THREE.ExtrudeGeometry(shape, {
        depth,
        bevelEnabled: bevel,
        bevelThickness: 0.005,
        bevelSize: 0.004,
        bevelSegments: 1,
        curveSegments: 4,
      });
    } else {
      // LOD 1: flat spoke face (the x/z swap below mirrors it, so flip the winding to face +x)
      geo = new THREE.ShapeGeometry(shape, 1).translate(0, 0, depth);
      const ix = geo.getIndex()!;
      for (let i = 0; i < ix.count; i += 3) {
        const b = ix.getX(i + 1);
        ix.setX(i + 1, ix.getX(i + 2));
        ix.setX(i + 2, b);
      }
    }
    // extrusion runs along +z: map shape (x, y) -> wheel (z, y), extrusion z -> wheel +x
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const dish = d.rim === 'steelcap' || d.rim === 'aero5' ? 0.012 : 0.03;
    for (let i = 0; i < pos.count; i++) {
      const sx = pos.getX(i);
      const sy = pos.getY(i);
      const sz = pos.getZ(i);
      const r = Math.hypot(sx, sy);
      const fr = Math.min(1, r / ro);
      // concave face: the centre sits deeper inside the wheel
      const xOff = -dish * (1 - fr * fr);
      pos.setXYZ(i, xFace - depth + sz + xOff, sy, sx);
    }
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
    // colour: machined faces (normal ~ +x) vs painted sides
    const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
    const start = mb.vertexCount;
    mb.setColor(rimCol).setPbr(0.3, 1);
    mb.addGeometry(geo, undefined, [0.5, flatV]);
    for (let i = 0; i < nrm.count; i++) {
      const nx = nrm.getX(i);
      const k = start + i;
      if (nx > 0.85) {
        mb.col[3 * k] = machined[0];
        mb.col[3 * k + 1] = machined[1];
        mb.col[3 * k + 2] = machined[2];
        mb.pbr[2 * k] = d.rim === 'turbine10' || d.rim === 'yspoke5' || d.rim === 'aero5' ? 0.16 : 0.3;
      } else if (d.rim === 'turbine10' || d.rim === 'yspoke5' || d.rim === 'aero5') {
        mb.col[3 * k] = rimCol[0] * 0.55;
        mb.col[3 * k + 1] = rimCol[1] * 0.55;
        mb.col[3 * k + 2] = rimCol[2] * 0.55;
      }
    }
    geo.dispose();
    // centre cap + lug nuts
    // centre cap in rim colour with a dark emblem disc
    const cap = new THREE.CylinderGeometry(0.03, 0.033, 0.012, lod === 0 ? 16 : 10).rotateZ(-Math.PI / 2);
    const mCap = new THREE.Matrix4().makeTranslation(xFace - dish + 0.008, 0, 0);
    mb.setColor(machined).setPbr(0.25, 1);
    mb.addGeometry(cap, mCap, [0.5, flatV]);
    if (lod === 0) {
      const emblem = new THREE.CircleGeometry(0.02, 16).rotateY(Math.PI / 2);
      mb.setColor([0.02, 0.02, 0.025]).setPbr(0.2, 0.3);
      mb.addGeometry(emblem, new THREE.Matrix4().makeTranslation(xFace - dish + 0.0145, 0, 0), [0.5, flatV]);
      emblem.dispose();
    }
    if (lod === 0) {
      const ring = new THREE.TorusGeometry(0.03, 0.003, 4, 20).rotateY(Math.PI / 2);
      mb.setColor([0.85, 0.86, 0.88]).setPbr(0.12, 1);
      mb.addGeometry(ring, new THREE.Matrix4().makeTranslation(xFace - dish + 0.015, 0, 0), [0.5, flatV]);
      const nut = new THREE.CylinderGeometry(0.0095, 0.0095, 0.018, 6).rotateZ(-Math.PI / 2);
      mb.setColor([0.55, 0.57, 0.6]).setPbr(0.25, 1);
      const nNuts = spec.massKg > 1900 ? 6 : 5;
      for (let k = 0; k < nNuts; k++) {
        const a = (k / nNuts) * Math.PI * 2 + 0.3;
        const r = 0.052;
        mb.addGeometry(nut, new THREE.Matrix4().makeTranslation(xFace - dish * 0.75 - 0.002, Math.sin(a) * r, Math.cos(a) * r), [0.5, flatV]);
      }
      nut.dispose();
      ring.dispose();
    }
    cap.dispose();
  } else {
    // LOD 2: flat rim disc with a darker centre
    mb.setColor(rimCol).setPbr(0.35, 1);
    const c0 = mb.vert(xFace, 0, 0, 1, 0, 0, 0.5, flatV);
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      mb.vert(xFace, Math.sin(a) * Rr, Math.cos(a) * Rr, 1, 0, 0, 0.5, flatV);
    }
    for (let s = 0; s < segs; s++) mb.tri(c0, c0 + 1 + s, c0 + 2 + s);
  }

  // ---------------- brake disc ----------------
  if (lod === 0) {
    const dro = Math.min(Rr - 0.035, 0.175);
    const dx = xFace - 0.075;
    mb.setColor([0.16, 0.16, 0.165]).setPbr(0.55, 0.9);
    const disc = [
      { x: dx + 0.013, r: 0.075, v: flatV },
      { x: dx + 0.013, r: dro, v: flatV },
      { x: dx - 0.013, r: dro, v: flatV },
      { x: dx - 0.013, r: 0.075, v: flatV },
    ];
    revolve(mb, disc, 32, 1, true);
    // disc face (outer side) as an annulus facing +x
    mb.setColor([0.22, 0.22, 0.225]).setPbr(0.48, 0.9);
    const b0 = mb.vertexCount;
    for (let s = 0; s <= 32; s++) {
      const a = (s / 32) * Math.PI * 2;
      mb.vert(dx + 0.013, Math.sin(a) * 0.075, Math.cos(a) * 0.075, 1, 0, 0, 0.5, flatV);
      mb.vert(dx + 0.013, Math.sin(a) * dro, Math.cos(a) * dro, 1, 0, 0, 0.5, flatV);
    }
    for (let s = 0; s < 32; s++) {
      const a = b0 + 2 * s;
      mb.quad(a, a + 2, a + 3, a + 1);
    }
    // hat
    mb.setColor([0.12, 0.12, 0.13]).setPbr(0.6, 0.6);
    const hat = new THREE.CylinderGeometry(0.078, 0.078, 0.05, 16).rotateZ(-Math.PI / 2);
    mb.addGeometry(hat, new THREE.Matrix4().makeTranslation(dx + 0.03, 0, 0), [0.5, flatV]);
    hat.dispose();
  } else if (lod === 1) {
    // dark disc behind the spokes so the rim is not see-through
    mb.setColor([0.08, 0.08, 0.085]).setPbr(0.7, 0.3);
    const c0 = mb.vert(xFace - 0.06, 0, 0, 1, 0, 0, 0.5, flatV);
    for (let s = 0; s <= 16; s++) {
      const a = (s / 16) * Math.PI * 2;
      mb.vert(xFace - 0.06, Math.sin(a) * (Rr - 0.01), Math.cos(a) * (Rr - 0.01), 1, 0, 0, 0.5, flatV);
    }
    for (let s = 0; s < 16; s++) mb.tri(c0, c0 + 1 + s, c0 + 2 + s);
  }

  const spin = mb.build();
  let caliper: THREE.BufferGeometry | null = null;
  let calTris = 0;
  if (lod === 0) {
    const cb = new MeshBuilder();
    const dro = Math.min(Rr - 0.035, 0.175);
    const dx = xFace - 0.075;
    cb.setColor(colorOf(d.caliperColor)).setPbr(0.4, 0.2);
    // caliper: a curved block straddling the disc edge, behind and above the axle
    const a0 = 2.35;
    const a1 = 2.95;
    const r0 = dro - 0.05;
    const r1 = dro + 0.014;
    const x0 = dx - 0.03;
    const x1 = dx + 0.036;
    const n = 10;
    const ring = (r: number, x: number) => {
      const ids: number[] = [];
      for (let i = 0; i <= n; i++) {
        const a = lerp(a0, a1, i / n);
        ids.push(cb.vert(x, Math.sin(a) * r, Math.cos(a) * r, 0, 0, 0));
      }
      return ids;
    };
    // outer face (x1), inner face (x0), outer radius, inner radius, ends
    const o1 = ring(r1, x1);
    const o0 = ring(r0, x1);
    const i1 = ring(r1, x0);
    const i0 = ring(r0, x0);
    for (let i = 0; i < n; i++) {
      cb.quad(o0[i], o0[i + 1], o1[i + 1], o1[i]); // face +x
      cb.quad(i1[i], i1[i + 1], i0[i + 1], i0[i]); // face -x
      cb.quad(o1[i], o1[i + 1], i1[i + 1], i1[i]); // outer radius
      cb.quad(i0[i], i0[i + 1], o0[i + 1], o0[i]); // inner radius
    }
    cb.quad(o0[0], o1[0], i1[0], i0[0]);
    cb.quad(o1[n], o0[n], i0[n], i1[n]);
    const g = cb.build();
    g.toNonIndexed();
    const flat = g.toNonIndexed();
    flat.computeVertexNormals();
    caliper = flat;
    calTris = flat.getAttribute('position').count / 3;
    g.dispose();
  }
  return { spin, caliper, triangles: mb.triangleCount + calTris };
}
