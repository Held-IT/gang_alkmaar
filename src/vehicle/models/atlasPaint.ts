// Paints the body texture atlas of one car spec: windows (cut-outs), pillars, frits, panel gaps,
// lamp housings, grilles, intakes, cowl, cladding. Painted on opaque canvases (no premultiplied
// alpha loss) and composed into two DataTextures:
//   map : RGB albedo (pure white = car paint, anything else = its own colour), A = body opacity
//   orm : R clearcoat, G roughness, B metalness, A = glass mask
import * as THREE from 'three';
import { PATCHES, type PatchName } from './atlasLayout';
import type { GhSection } from './body';
import type { BodyMap } from './bodyMap';
import { lerp } from './curves';
import { densify, roundPoly, type Features, type Pt } from './features';

interface Mat {
  albedo: string;
  /** 1 = car paint (albedo white, tinted by the paint colour) */
  paint?: number;
  opaque: number;
  glass: number;
  cc: number;
  rough: number;
  metal: number;
}

const M = {
  paint: { albedo: '#ffffff', paint: 1, opaque: 1, glass: 0, cc: 1, rough: 0.34, metal: 1 },
  glass: { albedo: '#030405', opaque: 0, glass: 1, cc: 1, rough: 0.03, metal: 0 },
  /** windscreen / front side glass: lighter tint than the (privacy) rear glass */
  glassClear: { albedo: '#030405', opaque: 0, glass: 0.8, cc: 1, rough: 0.03, metal: 0 },
  frit: { albedo: '#060606', opaque: 1, glass: 1, cc: 1, rough: 0.3, metal: 0 },
  gloss: { albedo: '#050607', opaque: 1, glass: 0, cc: 1, rough: 0.1, metal: 0 },
  satin: { albedo: '#121314', opaque: 1, glass: 0, cc: 0.05, rough: 0.62, metal: 0 },
  grey: { albedo: '#3a3c3e', opaque: 1, glass: 0, cc: 0.05, rough: 0.6, metal: 0 },
  rubber: { albedo: '#090909', opaque: 1, glass: 0, cc: 0, rough: 0.78, metal: 0 },
  gap: { albedo: "#0c0c0d", opaque: 1, glass: 0, cc: 0.15, rough: 0.7, metal: 0 },
  chrome: { albedo: '#d0d4d8', opaque: 1, glass: 0, cc: 0.6, rough: 0.1, metal: 1 },
  white: { albedo: '#fefefe', opaque: 1, glass: 0, cc: 0, rough: 0.6, metal: 0 },
  lampHouse: { albedo: '#0b0c0e', opaque: 1, glass: 0, cc: 1, rough: 0.06, metal: 0.2 },
  lampChrome: { albedo: '#b8bec4', opaque: 1, glass: 0, cc: 1, rough: 0.14, metal: 1 },
  lampGuide: { albedo: '#c9cfd3', opaque: 1, glass: 0, cc: 1, rough: 0.2, metal: 0 },
  tailHouse: { albedo: '#2a0305', opaque: 1, glass: 0, cc: 1, rough: 0.05, metal: 0 },
  tailRed: { albedo: '#650a10', opaque: 1, glass: 0, cc: 1, rough: 0.08, metal: 0 },
  tailSmoke: { albedo: '#170c0c', opaque: 1, glass: 0, cc: 1, rough: 0.06, metal: 0 },
  tailClear: { albedo: '#7d8285', opaque: 1, glass: 0, cc: 1, rough: 0.1, metal: 0.6 },
  amberOff: { albedo: '#2c1c12', opaque: 1, glass: 0, cc: 1, rough: 0.08, metal: 0 },
  reflector: { albedo: '#5a0508', opaque: 1, glass: 0, cc: 1, rough: 0.15, metal: 0 },
  grilleBack: { albedo: '#070708', opaque: 1, glass: 0, cc: 0.2, rough: 0.55, metal: 0 },
} satisfies Record<string, Mat>;

const PATCH_MATS: Record<PatchName, Mat> = {
  paint: M.paint,
  gloss: M.gloss,
  satin: M.satin,
  grey: M.grey,
  chrome: M.chrome,
  rubber: M.rubber,
  glass: { ...M.glass, opaque: 1 },
  lens: { ...M.glass, opaque: 1, glass: 0.5 },
  white: M.white,
};

export interface BodyTextures {
  map: THREE.DataTexture;
  orm: THREE.DataTexture;
  /** glass mask (0..1) at a uv (for selecting greenhouse faces that need glass) */
  glassAt(u: number, v: number): number;
  /** body opacity (0..1) at a uv */
  opaqueAt(u: number, v: number): number;
}

type Conv = (a: number, b: number) => [number, number];

class Painter {
  readonly W: number;
  readonly H: number;
  readonly alb: CanvasRenderingContext2D;
  readonly msk: CanvasRenderingContext2D;
  readonly orm: CanvasRenderingContext2D;
  /** pixels per metre */
  readonly s: number;
  constructor(W: number, H: number, s: number) {
    this.W = W;
    this.H = H;
    this.s = s;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      return c.getContext('2d', { willReadFrequently: true })!;
    };
    this.alb = mk();
    this.msk = mk();
    this.orm = mk();
  }

  private styles(m: Mat): [string, string, string] {
    const b = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    return [m.albedo, `rgb(${b(m.opaque)},${b(m.glass)},${b(m.paint ?? 0)})`, `rgb(${b(m.cc)},${b(m.rough)},${b(m.metal)})`];
  }

  private each(fn: (g: CanvasRenderingContext2D, style: string) => void, m: Mat): void {
    const st = this.styles(m);
    fn(this.alb, st[0]);
    fn(this.msk, st[1]);
    fn(this.orm, st[2]);
  }

  clip(rect: [number, number, number, number] | null): void {
    for (const g of [this.alb, this.msk, this.orm]) {
      g.restore();
      g.save();
      if (rect) {
        g.beginPath();
        g.rect(rect[0], rect[1], rect[2], rect[3]);
        g.clip();
      }
    }
  }

  rect(x: number, y: number, w: number, h: number, m: Mat): void {
    this.each((g, s) => {
      g.fillStyle = s;
      g.fillRect(x, y, w, h);
    }, m);
  }

  private path(g: CanvasRenderingContext2D, pts: Pt[], conv: Conv, closed: boolean): void {
    g.beginPath();
    pts.forEach((q, i) => {
      const [x, y] = conv(q[0], q[1]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    if (closed) g.closePath();
  }

  fill(pts: Pt[], conv: Conv, m: Mat): void {
    this.each((g, s) => {
      this.path(g, pts, conv, true);
      g.fillStyle = s;
      g.fill();
    }, m);
  }

  /** stroke with a width in metres */
  stroke(pts: Pt[], conv: Conv, widthM: number, m: Mat, closed = false): void {
    this.each((g, s) => {
      this.path(g, pts, conv, closed);
      g.strokeStyle = s;
      g.lineWidth = Math.max(1, widthM * this.s);
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.stroke();
    }, m);
  }

  /** cut-out: body opacity 0 (LOD 0 alpha test) while keeping the painted colours for LOD 1/2 */
  cut(pts: Pt[], conv: Conv): void {
    this.path(this.msk, pts, conv, true);
    this.msk.fillStyle = 'rgb(0,0,0)';
    this.msk.fill();
  }

  /** draw only into the albedo canvas (decorative patterns) with a custom style */
  albedoOnly(fn: (g: CanvasRenderingContext2D) => void): void {
    fn(this.alb);
  }
  ormOnly(fn: (g: CanvasRenderingContext2D) => void): void {
    fn(this.orm);
  }
}

function regionRect(r: { px0: number; py0: number; wm: number; hm: number }, s: number): [number, number, number, number] {
  return [r.px0, r.py0, r.wm * s, r.hm * s];
}

/**
 * Maps rear-wall coordinates (x lateral from the centre line, y height) to greenhouse (z, arc)
 * for a near-vertical rear wall (van), using exact sections sampled densely in z. On such a wall
 * every section is a horizontal-ish curve across the wall at the height of the top line, so for a
 * fixed x the height grows with z and can be inverted by a 1D search.
 */
function rearWallInverter(m: BodyMap, z0: number, z1: number, n = 320) {
  const f = m.f;
  const zs: number[] = [];
  const secs: GhSection[] = [];
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, z1, i / n);
    zs.push(z);
    secs.push(f.ghSection(f.pOfShoulderZ(z)));
  }
  const g = { x: 0, y: 0, tx: 0, ty: 0 };
  const secAt = (z: number): GhSection => secs[Math.round(Math.min(1, Math.max(0, (z - z0) / (z1 - z0))) * n)];
  /** arc where the section reaches lateral x (x falls monotonically from the shoulder to the centre) */
  const arcAtX = (sec: GhSection, xt: number): number => {
    const xs = sec.xs;
    const k = xs.length - 1;
    if (xt >= xs[0]) return 0;
    if (xt <= xs[k]) return sec.len;
    let lo = 0;
    let hi = k;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > xt) lo = mid;
      else hi = mid;
    }
    const t = (xs[lo] - xt) / (xs[lo] - xs[hi] || 1);
    return lerp(sec.arc[lo], sec.arc[hi], t);
  };
  const yOnSec = (sec: GhSection, x: number): number => {
    f.ghPoint(sec, arcAtX(sec, x), g);
    return g.y;
  };
  return {
    /** (z, arc) of the wall point at lateral x, height y (clamped to the sampled z range) */
    at(x: number, y: number): Pt {
      let pa = arcAtX(secs[0], x);
      f.ghPoint(secs[0], pa, g);
      let py = g.y;
      if (py >= y) return [zs[0], pa];
      for (let i = 1; i <= n; i++) {
        const a = arcAtX(secs[i], x);
        f.ghPoint(secs[i], a, g);
        if (g.y >= y) {
          const t = (y - py) / (g.y - py || 1);
          return [lerp(zs[i - 1], zs[i], t), lerp(pa, a, t)];
        }
        pa = a;
        py = g.y;
      }
      return [zs[n], pa];
    },
    /** wall height at section z and lateral x */
    yOn(z: number, x: number): number {
      return yOnSec(secAt(z), x);
    },
    /** lateral x where the section at z leaves the roof-edge corner (outer edge of the flat wall) */
    xCorner(z: number): number {
      const sec = secAt(z);
      f.ghPoint(sec, sec.cornerEnd, g);
      return g.x;
    },
  };
}

export function paintBodyAtlas(m: BodyMap, feat: Features): BodyTextures {
  const f = m.f;
  const d = f.d;
  const a = m.atlas;
  const P = f.P;
  const pt = new Painter(a.W, a.H, a.s);
  // background: unused texels are opaque paint (keeps mip borders sane)
  pt.rect(0, 0, a.W, a.H, M.paint);

  const lower: Conv = (p, y) => m.pxLower(p, y);
  const hood: Conv = (z, x) => m.pxHood(z, x);
  const trunk: Conv = (z, x) => m.pxTrunk(z, x);
  const ghArc: Conv = (z, arc) => m.pxGh(z, arc);
  /** greenhouse side-window coordinates (z, f) with f relative to the A-pillar / rail edge */
  const pw = d.aPillarW;
  const fArc = (z: number, fr: number) => {
    const g = m.gh(z);
    return fr * Math.max(0, g.mid - pw * 0.5);
  };
  const ghF: Conv = (z, fr) => m.pxGh(z, fArc(z, fr));

  // ======================= greenhouse =======================
  pt.clip(regionRect(a.gh, a.s));
  const zc = d.cowlZ;
  const zrb = d.rearBaseZ;
  const wins = d.windows.map((w) => densify(roundWin(w.pts, w.radius, m, pw), 0.01, true));
  // sail (mirror base) and B pillars: black band between and in front of the side windows
  const sorted = [...d.windows].sort((x, y) => y.pts[3][0] - x.pts[3][0]); // front first
  {
    const fw = sorted[0];
    const sail: Pt[] = densify(
      [
        [fw.pts[3][0] - 0.02, 0],
        [fw.pts[2][0] - 0.02, 1.0],
        [zc + 0.01, 1.0],
        [zc + 0.01, 0],
      ],
      0.01,
      true,
    );
    pt.fill(sail, ghF, M.gloss);
    if (d.blackPillars) {
      const fTop = Math.max(...d.windows.map((w) => Math.max(w.pts[1][1], w.pts[2][1]))) + 0.012;
      for (let i = 0; i < sorted.length - 1; i++) {
        const A = sorted[i];
        const B = sorted[i + 1];
        const band: Pt[] = densify(
          [
            [A.pts[0][0] + 0.02, -0.02],
            [A.pts[1][0] + 0.02, fTop],
            [B.pts[2][0] - 0.02, fTop],
            [B.pts[3][0] - 0.02, -0.02],
          ],
          0.01,
          true,
        );
        pt.fill(band, ghF, M.gloss);
      }
    }
  }
  // windscreen
  {
    const zt = d.roofFrontZ;
    const n = 40;
    const side: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(zt, zc + 0.02, i / n);
      side.push([z, m.gh(z).mid + pw * 0.5]);
    }
    const poly: Pt[] = [...side, [zc + 0.02, m.gh(zc).len + 0.05], [zt, m.gh(zt).len + 0.05]];
    pt.fill(poly, ghArc, M.glassClear);
    // black frit band along the pillars, the top edge and the bottom edge
    const fritSide: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(zt, zc + 0.02, i / n);
      fritSide.push([z, m.gh(z).mid + pw * 0.5 + 0.045]);
    }
    pt.fill([...side, ...fritSide.reverse()], ghArc, M.frit);
    const topFrit: Pt[] = [];
    for (let i = 0; i <= 20; i++) {
      const arc = lerp(m.gh(zt).mid + pw * 0.5, m.gh(zt).len + 0.05, i / 20);
      topFrit.push([zt, arc]);
    }
    for (let i = 20; i >= 0; i--) topFrit.push([zt - 0.06, lerp(m.gh(zt - 0.06).mid + pw * 0.5, m.gh(zt - 0.06).len + 0.05, i / 20)]);
    pt.fill(topFrit, ghArc, M.frit);
    const botFrit: Pt[] = [
      [zc + 0.03, m.gh(zc).sideLen],
      [zc + 0.03, m.gh(zc).len + 0.05],
      [zc - 0.05, m.gh(zc - 0.05).len + 0.05],
      [zc - 0.05, m.gh(zc - 0.05).mid + pw * 0.5],
    ];
    pt.fill(densify(botFrit, 0.01, true), ghArc, M.frit);
    // dotted frit fade (dots)
    pt.albedoOnly((g) => {
      g.fillStyle = M.frit.albedo;
      for (let i = 0; i <= n; i++) {
        const z = lerp(zt, zc, i / n);
        for (let k = 0; k < 3; k++) {
          const [x, y] = ghArc(z, m.gh(z).mid + pw * 0.5 + 0.05 + k * 0.008);
          g.beginPath();
          g.arc(x, y, Math.max(0.6, (2.2 - k * 0.6) * (a.s / 400)), 0, Math.PI * 2);
          g.fill();
        }
      }
    });
  }
  // rear window
  if (d.van) {
    // Twin rear doors: a window in each door either side of the centre split. The van's rear wall
    // rises ~0.8 m within 4 cm of z, so lines of constant z / arc (and the interpolated gh() table)
    // are badly distorted there (pointed sliver between the panes, wedge-shaped outer edges).
    // Instead the windows are rounded rectangles in rear-wall space (x lateral, y up), every
    // point inverted onto the exact greenhouse sections the body mesh is built from.
    const wall = rearWallInverter(m, zrb, d.roofRearZ + 0.01);
    const zTop = d.roofRearZ - 0.008;
    const xEdge = wall.xCorner(zTop); // where the rear wall rolls into the side
    const xIn = 0.045; // 9 cm between the panes: both door frames + the shut line
    const xOut = xEdge - 0.075;
    const yTop = Math.min(wall.yOn(zTop, xIn), wall.yOn(zTop, xOut)) - 0.07;
    const yBase = wall.yOn(zrb, xIn);
    const yBot = Math.max(yBase + 0.05, lerp(yBase, yTop + 0.07, 0.42));
    const rect: Pt[] = [
      [xIn, yBot],
      [xIn, yTop],
      [xOut, yTop],
      [xOut, yBot],
    ];
    const win = densify(roundPoly(rect, 0.045, 6), 0.01, true).map((q) => wall.at(q[0], q[1]));
    pt.stroke(win, ghArc, 0.022, M.gloss, true);
    pt.fill(win, ghArc, M.glass);
    pt.stroke(win, ghArc, 0.006, M.rubber, true);
    // door shut line (x = 0), straight up the wall into the roof roll
    const yWallTop = wall.yOn(d.roofRearZ + 0.01, 0);
    const split = densify([[0, yBase], [0, yWallTop]], 0.01).map((q) => wall.at(q[0], q[1]));
    pt.stroke(split, ghArc, 0.006, M.gap);
    // sliding door above the belt
    if (feat.slidingDoor) {
      const { z0: a, z1: b } = feat.slidingDoor;
      const fTop = 0.82;
      pt.stroke(
        [
          [a, 0],
          [a, fTop],
          [b, fTop],
          [b, 0],
        ],
        ghF,
        0.0045,
        M.gap,
      );
      // guide rail slot along the waist behind the door
      pt.stroke(
        [
          [b - 0.02, fTop * 0.5],
          [zrb + 0.15, fTop * 0.5],
        ],
        ghF,
        0.008,
        M.gap,
      );
    }
  } else if (d.rearGlassHW) {
    // tailgate glass narrower than the greenhouse: outline in (slant distance s, lateral distance
    // c from the centre line), rounded corners, clamped to the pillar edge; arc = len - c
    const zt = d.roofRearZ;
    const z0 = zrb + 0.015;
    const rp = d.rearPillarW;
    const Ls = Math.hypot(zt - z0, f.topY(zt) - f.topY(z0));
    const toArc = (s: number, c: number): Pt => {
      const z = lerp(z0, zt, s / Ls);
      const g = m.gh(z);
      const cMax = g.len - (g.mid + rp * 0.5);
      return [z, g.len - Math.min(c, cMax)];
    };
    const [hwB, hwT] = d.rearGlassHW;
    const outer = densify(
      roundPoly(
        [
          [0, -0.06],
          [0, hwB],
          [Ls, hwT],
          [Ls, -0.06],
        ],
        0.07,
        8,
      ),
      0.01,
      true,
    );
    pt.fill(outer.map((q) => toArc(q[0], q[1])), ghArc, M.frit);
    const fr = 0.035;
    const inner = densify(
      roundPoly(
        [
          [fr * 0.6, -0.06],
          [fr * 0.6, hwB - fr],
          [Ls - fr * 1.4, hwT - fr],
          [Ls - fr * 1.4, -0.06],
        ],
        0.05,
        8,
      ),
      0.01,
      true,
    );
    pt.fill(inner.map((q) => toArc(q[0], q[1])), ghArc, M.glass);
    // third brake light housing under the spoiler
    const zz = zt + 0.035;
    const g0 = m.gh(zz);
    pt.fill(
      [
        [zz - 0.012, g0.len - 0.22],
        [zz - 0.012, g0.len + 0.05],
        [zz + 0.01, g0.len + 0.05],
        [zz + 0.01, g0.len - 0.22],
      ],
      ghArc,
      M.tailHouse,
    );
  } else {
    const zt = d.roofRearZ;
    const rp = d.rearPillarW;
    const n = 30;
    const side: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lerp(zrb + 0.015, zt, i / n);
      side.push([z, m.gh(z).mid + rp * 0.5]);
    }
    const poly: Pt[] = [...side, [zt, m.gh(zt).len + 0.05], [zrb + 0.015, m.gh(zrb + 0.015).len + 0.05]];
    pt.fill(poly, ghArc, M.glass);
    const frit: Pt[] = [];
    for (let i = n; i >= 0; i--) {
      const z = lerp(zrb + 0.015, zt, i / n);
      frit.push([z, m.gh(z).mid + rp * 0.5 + 0.04]);
    }
    pt.fill([...side, ...frit], ghArc, M.frit);
    const fr2: Pt[] = [];
    for (let i = 0; i <= 16; i++) fr2.push([zt, lerp(m.gh(zt).mid + rp * 0.5, m.gh(zt).len + 0.05, i / 16)]);
    for (let i = 16; i >= 0; i--) fr2.push([zt + 0.05, lerp(m.gh(zt + 0.05).mid + rp * 0.5, m.gh(zt + 0.05).len + 0.05, i / 16)]);
    pt.fill(fr2, ghArc, M.frit);
    // spoiler / roof end: third brake light housing (red strip at the top centre)
    if (!d.trunk) {
      const zz = zt + 0.035;
      const g0 = m.gh(zz);
      pt.fill(
        [
          [zz - 0.012, g0.len - 0.22],
          [zz - 0.012, g0.len + 0.05],
          [zz + 0.01, g0.len + 0.05],
          [zz + 0.01, g0.len - 0.22],
        ],
        ghArc,
        M.tailHouse,
      );
    }
  }
  // side windows (cut-outs) + rubber seals
  wins.forEach((w, i) => {
    // gloss-black window frame, glass, then a thin rubber seal; front door glass is clear, the
    // rear side glass is privacy tinted (darker)
    pt.stroke(w, ghF, 0.022, M.gloss, true);
    pt.fill(w, ghF, d.windows[i] === sorted[0] ? M.glassClear : M.glass);
    pt.stroke(w, ghF, 0.006, M.rubber, true);
  });
  // belt line moulding just below the windows
  {
    const zs = sorted.map((w) => w.pts[3][0]).concat(sorted.map((w) => w.pts[0][0]));
    const z0 = Math.min(...zs) - 0.03;
    const z1 = Math.max(...zs) + 0.03;
    const line: Pt[] = [];
    for (let i = 0; i <= 40; i++) line.push([lerp(z0, z1, i / 40), 0.012]);
    pt.stroke(line, ghF, 0.012, d.blackPillars ? M.gloss : M.chrome);
  }
  // roof: optional rail drip line (subtle gap along the roof edge)
  {
    const line: Pt[] = [];
    for (let i = 0; i <= 60; i++) {
      const z = lerp(d.roofRearZ + 0.05, d.roofFrontZ - 0.03, i / 60);
      line.push([z, m.gh(z).cornerEnd + 0.012]);
    }
    pt.stroke(line, ghArc, 0.004, M.gap);
  }

  // ======================= lower body =======================
  pt.clip(regionRect(a.lower, a.s));
  // crossover cladding: arches + sills
  if (d.cladding) {
    const R = f.archR;
    for (const za of [f.zFA, f.zRA]) {
      const ring: Pt[] = [];
      const ro = R + 0.075;
      for (let i = 0; i <= 40; i++) {
        const t = Math.PI * (i / 40);
        const z = za + Math.cos(t) * ro;
        const y = f.wheelR + Math.sin(t) * ro;
        ring.push([m.sideP(z), y]);
      }
      ring.push([m.sideP(za - ro - 0.02), d.sillY - 0.05], [m.sideP(za + ro + 0.02), d.sillY - 0.05]);
      pt.fill(ring, lower, M.satin);
    }
    pt.fill(
      [
        [m.sideP(f.zRA), d.sillY + 0.11],
        [m.sideP(f.zFA), d.sillY + 0.11],
        [m.sideP(f.zFA), d.sillY - 0.05],
        [m.sideP(f.zRA), d.sillY - 0.05],
      ],
      lower,
      M.satin,
    );
    // bumper bottoms (front and rear) in textured black, silver skid plates in the centre
    pt.fill(
      [
        [f.pSide1 - 0.22, d.frontBottomY + 0.15],
        [P + 0.02, d.frontBottomY + 0.15],
        [P + 0.02, d.frontBottomY - 0.05],
        [f.pSide1 - 0.22, d.frontBottomY - 0.05],
      ],
      lower,
      M.satin,
    );
    pt.fill(
      [
        [-0.02, d.rearBottomY + 0.15],
        [f.pSide0 + 0.22, d.rearBottomY + 0.15],
        [f.pSide0 + 0.22, d.rearBottomY - 0.05],
        [-0.02, d.rearBottomY - 0.05],
      ],
      lower,
      M.satin,
    );
    const hw = d.halfWidth;
    pt.fill(
      [
        [m.frontP(0.42 * hw), d.frontBottomY + 0.05],
        [P + 0.02, d.frontBottomY + 0.05],
        [P + 0.02, d.frontBottomY - 0.01],
        [m.frontP(0.46 * hw), d.frontBottomY - 0.01],
      ],
      lower,
      M.grey,
    );
    pt.fill(
      [
        [-0.02, d.rearBottomY + 0.05],
        [m.rearP(0.42 * hw), d.rearBottomY + 0.05],
        [m.rearP(0.46 * hw), d.rearBottomY - 0.01],
        [-0.02, d.rearBottomY - 0.01],
      ],
      lower,
      M.grey,
    );
  }
  for (const b of feat.blacks) pt.fill(b.poly, lower, b.gloss ? M.gloss : M.satin);
  // panel gaps
  for (const g of feat.gaps) pt.stroke(g, lower, 0.0045, M.gap);
  // grilles
  for (const gr of feat.grilles) {
    pt.fill(gr.poly, lower, M.grilleBack);
    drawGrillePattern(pt, gr.poly, gr.pattern, lower, a.s);
    if (gr.frame) pt.stroke(gr.poly, lower, 0.012, d.front === 'sport' || d.front === 'van' || d.front === 'city' ? M.chrome : M.gloss, true);
  }
  for (const fg of feat.fogs) {
    pt.fill(fg, lower, M.lampHouse);
    pt.stroke(fg, lower, 0.006, M.lampChrome, true);
  }
  // headlamps
  {
    const h = feat.head;
    pt.fill(h.outline, lower, M.lampHouse);
    // inner chrome / grey structure: a band under the top edge
    for (const pr of h.projectors) {
      const ring: Pt[] = [];
      for (let i = 0; i < 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        ring.push([pr.p + Math.cos(t) * pr.r * 1.7, pr.y + Math.sin(t) * pr.r * 1.5]);
      }
      pt.fill(ring, lower, M.lampChrome);
      const inner = ring.map((q) => [lerp(q[0], pr.p, 0.42), lerp(q[1], pr.y, 0.42)] as Pt);
      pt.fill(inner, lower, M.lampHouse);
    }
    pt.stroke(h.drl, lower, h.drlWidth * 1.6, M.lampGuide);
    if (h.indicator.length) pt.stroke(h.indicator, lower, 0.012, M.amberOff);
    pt.stroke(h.outline, lower, 0.006, M.gloss, true);
  }
  // tail lamps
  {
    const t = feat.tail;
    pt.fill(t.outline, lower, M.tailHouse);
    pt.fill(t.brake, lower, M.tailRed);
    pt.fill(t.indicator, lower, M.tailSmoke);
    pt.fill(t.reverse, lower, M.tailClear);
    pt.stroke(t.guide, lower, t.guideWidth * 1.4, M.tailRed);
    pt.stroke(t.outline, lower, 0.005, M.gloss, true);
    // the tailgate shut line runs through the lamp: outer half on the body, inner on the tailgate
    for (const g of feat.gaps) if (g.every((q) => q[0] < f.pSide0)) pt.stroke(g, lower, 0.007, M.gap);
  }
  for (const r of feat.reflectors) pt.fill(r, lower, M.reflector);
  // plate recesses
  {
    const pf = feat.plateFront.y;
    const pw2 = 0.29;
    const p0 = m.frontP(pw2);
    pt.fill(
      [
        [p0, pf + 0.07],
        [P + 0.02, pf + 0.07],
        [P + 0.02, pf - 0.07],
        [p0, pf - 0.07],
      ],
      lower,
      d.front === 'van' ? M.satin : M.grilleBack,
    );
    const pr = feat.plateRear.y;
    const r0 = m.rearP(pw2);
    pt.fill(
      [
        [-0.02, pr + 0.075],
        [r0, pr + 0.075],
        [r0, pr - 0.075],
        [-0.02, pr - 0.075],
      ],
      lower,
      M.satin,
    );
  }

  // recessed lamps / grilles / intakes are separate geometry at LOD 0: cut the body open there
  for (const r of feat.recesses) if (r.poly.length > 2) pt.cut(r.poly, lower);

  // ======================= hood =======================
  pt.clip(regionRect(a.hood, a.s));
  {
    const hw = d.halfWidth + 0.05;
    pt.fill(
      [
        [zc - 0.04, 0],
        [zc - 0.04, hw],
        [zc + 0.07, hw],
        [zc + 0.07, 0],
      ],
      hood,
      M.satin,
    );
    // cowl vent slots
    pt.albedoOnly((g) => {
      g.strokeStyle = '#050505';
      g.lineWidth = Math.max(1, 0.004 * a.s);
      for (let x = 0.03; x < d.halfWidth - 0.1; x += 0.025) {
        const [x0, y0] = hood(zc + 0.02, x);
        const [x1, y1] = hood(zc + 0.05, x);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
    });
    for (const g of feat.hoodGaps) pt.stroke(g, hood, 0.0045, M.gap);
    // washer jets
    for (const x of [0.28, 0.5]) {
      const c: Pt[] = [];
      for (let i = 0; i < 10; i++) c.push([zc + 0.13 + Math.cos((i / 10) * Math.PI * 2) * 0.008, x + Math.sin((i / 10) * Math.PI * 2) * 0.012]);
      pt.fill(c, hood, M.gloss);
    }
  }

  // ======================= trunk =======================
  pt.clip(regionRect(a.trunk, a.s));
  {
    const hw = d.halfWidth + 0.05;
    pt.fill(
      [
        [zrb - 0.012, 0],
        [zrb - 0.012, hw],
        [zrb + 0.03, hw],
        [zrb + 0.03, 0],
      ],
      trunk,
      M.rubber,
    );
    if (d.trunk) {
      // trunk lid shut line: along the edges and the front edge
      const pts: Pt[] = [];
      for (let i = 0; i <= 30; i++) {
        const z = lerp(zrb - 0.035, f.shoulderPoint(0).z + 0.02, i / 30);
        const s = f.shoulderPoint(f.pOfShoulderZ(z));
        pts.push([z, Math.max(0, s.x - 0.03)]);
      }
      pt.stroke(pts, trunk, 0.006, M.gap);
      pt.stroke(
        [
          [zrb - 0.035, 0],
          [zrb - 0.035, pts[0][1]],
        ],
        trunk,
        0.0045,
        M.gap,
      );
    }
  }

  // ======================= material patches =======================
  pt.clip(null);
  for (const name of PATCHES) {
    const [cx, cy] = a.patchPx[name];
    const hs = 11;
    pt.rect(cx - hs, cy - hs, 2 * hs, 2 * hs, PATCH_MATS[name]);
  }

  return compose(pt);
}

/** Rounded window polygon in (z, f) space; rounding is done in metric (z, arc) space. */
function roundWin(pts: readonly (readonly [number, number])[], r: number, m: BodyMap, pw: number): Pt[] {
  // convert to metric, round, convert back
  const toM = (z: number, fr: number): Pt => [z, fr * Math.max(1e-4, m.gh(z).mid - pw * 0.5)];
  const met = pts.map((q) => toM(q[0], q[1]));
  const out: Pt[] = [];
  const n = met.length;
  for (let i = 0; i < n; i++) {
    const A = met[(i + n - 1) % n];
    const B = met[i];
    const C = met[(i + 1) % n];
    const l1 = Math.hypot(A[0] - B[0], A[1] - B[1]);
    const l2 = Math.hypot(C[0] - B[0], C[1] - B[1]);
    const rr = Math.min(r, l1 * 0.4, l2 * 0.4);
    const p0: Pt = [B[0] + ((A[0] - B[0]) / l1) * rr, B[1] + ((A[1] - B[1]) / l1) * rr];
    const p1: Pt = [B[0] + ((C[0] - B[0]) / l2) * rr, B[1] + ((C[1] - B[1]) / l2) * rr];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      out.push([u * u * p0[0] + 2 * u * t * B[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * B[1] + t * t * p1[1]]);
    }
  }
  return out.map((q) => [q[0], q[1] / Math.max(1e-4, m.gh(q[0]).mid - pw * 0.5)] as Pt);
}

function drawGrillePattern(pt: Painter, poly: Pt[], pattern: string, conv: Conv, s: number): void {
  // bounding box in pixels
  const px = poly.map((q) => conv(q[0], q[1]));
  const xs = px.map((q) => q[0]);
  const ys = px.map((q) => q[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const clipPath = (g: CanvasRenderingContext2D) => {
    g.save();
    g.beginPath();
    px.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
    g.closePath();
    g.clip();
  };
  const unit = s / 100; // pixels per centimetre
  if (pattern === 'mesh') {
    // honeycomb mesh: lighter cell walls, dark holes
    pt.albedoOnly((g) => {
      clipPath(g);
      g.strokeStyle = '#1d1e20';
      g.lineWidth = Math.max(1, 0.45 * unit);
      const cw = 2.2 * unit;
      const ch = 1.3 * unit;
      for (let y = y0 - ch, row = 0; y < y1 + ch; y += ch, row++) {
        for (let x = x0 - cw + ((row % 2) * cw) / 2; x < x1 + cw; x += cw) {
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + cw / 2, y - ch / 2);
          g.lineTo(x + cw, y);
          g.lineTo(x + cw / 2, y + ch / 2);
          g.closePath();
          g.stroke();
        }
      }
      g.restore();
    });
    pt.ormOnly((g) => {
      clipPath(g);
      g.fillStyle = 'rgb(30,150,0)';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.restore();
    });
  } else if (pattern === 'bars' || pattern === 'slats') {
    const bar = pattern === 'bars' ? 1.0 * unit : 1.6 * unit;
    const gap = pattern === 'bars' ? 1.6 * unit : 1.1 * unit;
    pt.albedoOnly((g) => {
      clipPath(g);
      for (let y = y0 + gap * 0.5; y < y1; y += bar + gap) {
        const grd = g.createLinearGradient(0, y, 0, y + bar);
        if (pattern === 'bars') {
          grd.addColorStop(0, '#9aa0a6');
          grd.addColorStop(0.5, '#d5d9dc');
          grd.addColorStop(1, '#6d7276');
        } else {
          grd.addColorStop(0, '#202224');
          grd.addColorStop(0.4, '#0a0b0c');
          grd.addColorStop(1, '#050505');
        }
        g.fillStyle = grd;
        g.fillRect(x0, y, x1 - x0, bar);
      }
      g.restore();
    });
    pt.ormOnly((g) => {
      clipPath(g);
      for (let y = y0 + gap * 0.5; y < y1; y += bar + gap) {
        g.fillStyle = pattern === 'bars' ? 'rgb(200,40,255)' : 'rgb(255,30,0)';
        g.fillRect(x0, y, x1 - x0, bar);
      }
      g.restore();
    });
  } else if (pattern === 'vbars') {
    // vertical chrome slats (LOD 1/2 look of the Norrvik grille)
    const bar = 0.7 * unit;
    const gap = 1.9 * unit;
    pt.albedoOnly((g) => {
      clipPath(g);
      for (let x = x0 + gap * 0.5; x < x1; x += bar + gap) {
        const grd = g.createLinearGradient(x, 0, x + bar, 0);
        grd.addColorStop(0, '#8d9399');
        grd.addColorStop(0.5, '#d5d9dc');
        grd.addColorStop(1, '#666b70');
        g.fillStyle = grd;
        g.fillRect(x, y0, bar, y1 - y0);
      }
      g.restore();
    });
    pt.ormOnly((g) => {
      clipPath(g);
      for (let x = x0 + gap * 0.5; x < x1; x += bar + gap) {
        g.fillStyle = 'rgb(200,40,255)';
        g.fillRect(x, y0, bar, y1 - y0);
      }
      g.restore();
    });
  }
}

/** Compose the painted canvases into the final textures (flip rows for flipY = false). */
function compose(pt: Painter): BodyTextures {
  const W = pt.W;
  const H = pt.H;
  const alb = pt.alb.getImageData(0, 0, W, H).data;
  const msk = pt.msk.getImageData(0, 0, W, H).data;
  const orm = pt.orm.getImageData(0, 0, W, H).data;
  const mapData = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const src = y * W * 4;
    const dst = (H - 1 - y) * W * 4;
    for (let x = 0; x < W * 4; x += 4) {
      mapData[dst + x] = alb[src + x];
      mapData[dst + x + 1] = alb[src + x + 1];
      mapData[dst + x + 2] = alb[src + x + 2];
      // alpha: 0 = cut-out, 0.75 = opaque trim, 1 = opaque paint (paint mask = (a - 0.75) * 4)
      mapData[dst + x + 3] = Math.round(msk[src + x] * (0.75 + 0.25 * (msk[src + x + 2] / 255)));
    }
  }
  // ORM at half resolution (2x2 box filter)
  const w2 = W >> 1;
  const h2 = H >> 1;
  const ormData = new Uint8Array(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const dst = ((h2 - 1 - y) * w2 + x) * 4;
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const i = ((2 * y + dy) * W + 2 * x + dx) * 4;
            sum += c < 3 ? orm[i + c] : msk[i + 1];
          }
        }
        ormData[dst + c] = sum >> 2;
      }
    }
  }
  const map = new THREE.DataTexture(mapData, W, H, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.generateMipmaps = true;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.magFilter = THREE.LinearFilter;
  map.anisotropy = 8;
  map.needsUpdate = true;
  const ormTex = new THREE.DataTexture(ormData, w2, h2, THREE.RGBAFormat);
  ormTex.colorSpace = THREE.NoColorSpace;
  ormTex.generateMipmaps = true;
  ormTex.minFilter = THREE.LinearMipmapLinearFilter;
  ormTex.magFilter = THREE.LinearFilter;
  ormTex.anisotropy = 4;
  ormTex.needsUpdate = true;
  const sample = (u: number, v: number, ch: number) => {
    const x = Math.min(W - 1, Math.max(0, Math.round(u * W - 0.5)));
    const yy = Math.min(H - 1, Math.max(0, Math.round(v * H - 0.5)));
    return mapData[(yy * W + x) * 4 + ch];
  };
  // glass mask lookup from the full resolution mask (row flipped like the textures)
  const glassFull = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) glassFull[(H - 1 - y) * W + x] = msk[(y * W + x) * 4 + 1];
  return {
    map,
    orm: ormTex,
    glassAt(u, v) {
      const x = Math.min(W - 1, Math.max(0, Math.round(u * W - 0.5)));
      const y = Math.min(H - 1, Math.max(0, Math.round(v * H - 0.5)));
      return glassFull[y * W + x] / 255;
    },
    opaqueAt(u, v) {
      return sample(u, v, 3) / 255;
    },
  };
}
