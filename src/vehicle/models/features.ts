// Detail layout of a car body: lamps, grille, intakes, plates, door lines, handles, mirrors.
// Coordinates are body-surface coordinates of the LEFT half:
//   lower body: [p, y]  (p = plan perimeter from the rear centre, y = height)
//   the front centre is p = P, the rear centre is p = 0; mirroring gives the right half.
// The same layout drives the texture painter (atlasPaint.ts) and the 3D parts (parts.ts).
import type { BodyMap } from './bodyMap';
import { lerp } from './curves';

export type Pt = [number, number];

export interface HeadLamp {
  outline: Pt[];
  /** light guide polyline (DRL / position light) */
  drl: Pt[];
  drlWidth: number;
  projectors: { p: number; y: number; r: number }[];
  /** indicator polyline (amber, sequential style) */
  indicator: Pt[];
}

export interface TailLamp {
  outline: Pt[];
  /** red light guide polyline (tail / position) */
  guide: Pt[];
  guideWidth: number;
  /** brake light polygon */
  brake: Pt[];
  indicator: Pt[];
  reverse: Pt[];
}

/** Grille insert: diamond mesh, horizontal chrome bars, vertical chrome bars, horizontal black slats. */
export type GrillePattern = 'mesh' | 'bars' | 'vbars' | 'slats' | 'closed';

export interface Features {
  head: HeadLamp;
  tail: TailLamp;
  /** grille opening polygon(s) on the front face (left half, may end at p = P) */
  grilles: { poly: Pt[]; pattern: GrillePattern; frame: boolean }[];
  /** black plastic areas (bumper inserts, diffusers, cladding) */
  blacks: { poly: Pt[]; gloss: boolean }[];
  /** body panel gap polylines in lower coordinates */
  gaps: Pt[][];
  /** hood gap polylines in hood coordinates [z, x] */
  hoodGaps: Pt[][];
  plateFront: { y: number };
  plateRear: { y: number; p: number };
  /** door handles in side-view [z, y] */
  handles: Pt[];
  /** mirror attachment in side view [z, y] */
  mirror: Pt;
  /** brand badge positions: front [p, y], rear [p, y] */
  badgeFront: Pt;
  badgeRear: Pt;
  /** rear reflectors (red) */
  reflectors: Pt[][];
  /** exhaust tip positions in front view [x, y] (left side positive) */
  exhausts: Pt[];
  /** fog / auxiliary lamp polygons (front) */
  fogs: Pt[][];
  /** van: sliding door span in z (front and rear edge), continued above the belt by the painter */
  slidingDoor: { z0: number; z1: number } | null;
  /** LOD 0 recessed units (lamps, grilles, intakes): the body is cut out along the outline */
  recesses: Recess[];
  /** p of the tailgate shut line that splits the tail lamps (null: one-piece lamps) */
  tailSplitP: number | null;
}

/**
 * A recessed unit at LOD 0: the painted body is cut out along `poly` (lower-body [p, y],
 * left half, clipped to 0 <= p <= P) and a housing `depth` deep is built behind the opening.
 */
export interface Recess {
  kind: 'head' | 'tail' | 'grille' | 'intake' | 'fog';
  poly: Pt[];
  depth: number;
  pattern?: GrillePattern;
  chrome?: boolean;
}

/** Clip a polygon to the band pMin <= p <= pMax (Sutherland-Hodgman on two half-planes). */
export function clipBand(poly: Pt[], pMin: number, pMax: number): Pt[] {
  let out = poly;
  const planes: [(q: Pt) => boolean, number][] = [
    [(q) => q[0] >= pMin, pMin],
    [(q) => q[0] <= pMax, pMax],
  ];
  for (const [inside, pc] of planes) {
    const inp = out;
    out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i];
      const prev = inp[(i + inp.length - 1) % inp.length];
      const cut = (): Pt => {
        const t = (pc - prev[0]) / (cur[0] - prev[0]);
        return [pc, prev[1] + t * (cur[1] - prev[1])];
      };
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut());
        out.push(cur);
      } else if (inside(prev)) out.push(cut());
    }
  }
  return out;
}

/** Rounded rectangle-ish closed polygon through corner points, with corner radius r (metres). */
export function roundPoly(pts: Pt[], r: number, seg = 5): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const l1 = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const rr = Math.min(r, l1 * 0.45, l2 * 0.45);
    if (rr < 1e-4) {
      out.push([b[0], b[1]]);
      continue;
    }
    const p0: Pt = [b[0] + ((a[0] - b[0]) / l1) * rr, b[1] + ((a[1] - b[1]) / l1) * rr];
    const p1: Pt = [b[0] + ((c[0] - b[0]) / l2) * rr, b[1] + ((c[1] - b[1]) / l2) * rr];
    for (let k = 0; k <= seg; k++) {
      const t = k / seg;
      const m = 1 - t;
      out.push([m * m * p0[0] + 2 * m * t * b[0] + t * t * p1[0], m * m * p0[1] + 2 * m * t * b[1] + t * t * p1[1]]);
    }
  }
  return out;
}

/** Resample a polyline at roughly constant spacing. */
export function densify(pts: Pt[], step: number, closed = false): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.ceil(l / step));
    for (let j = 0; j < k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
  }
  if (!closed) out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

/** Smooth polyline through points (Catmull-Rom), returning ~seg points per span. */
export function smoothLine(pts: Pt[], seg = 6): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let k = 0; k < seg; k++) {
      const t = k / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push([pts[n - 1][0], pts[n - 1][1]]);
  return out;
}

// ------------------------------------------------------------------------------------------------

export function buildFeatures(m: BodyMap): Features {
  const f = m.f;
  const d = f.d;
  const P = f.P;
  const hw = d.halfWidth;
  const fp = (x: number) => m.frontP(x);
  const rp = (x: number) => m.rearP(x);
  const sp = (z: number) => m.sideP(z);
  const ys = (p: number) => m.shoulderY(p);
  const R = f.archR;
  const zArchFrontRear = f.zFA - R; // rear edge of the front arch
  const zArchRearFront = f.zRA + R; // front edge of the rear arch
  const belt = (z: number) => ys(sp(z));

  // ---------------- headlamps ----------------
  const front = d.front;
  const yTipF = ys(P);
  let head: HeadLamp;
  {
    // inner end (towards the grille) and outer end (wrapping onto the side)
    const xIn = front === 'city' ? 0.42 * hw : front === 'van' ? 0.5 * hw : front === 'ev' ? 0.0 : 0.3 * hw;
    const pIn = front === 'ev' ? P : fp(xIn);
    const pOut = f.pSide1 - (front === 'van' ? 0.02 : front === 'city' ? 0.03 : 0.1);
    // slim modern lamps: the hatch is slimmest at the grille and a little taller at the wrap
    // Each brand has its own lamp graphic: Ostwald (hatch) DRL along the lower edge turning up,
    // Norrvik (estate / taxi) thin lamps with a C-shaped DRL at the outer end, Feldhaus (sport) an
    // angular eyebrow DRL along the top edge.
    const hIn = front === 'city' ? 0.12 : front === 'van' ? 0.2 : front === 'sport' ? 0.085 : front === 'ev' ? 0.05 : front === 'hatch' ? 0.07 : 0.088;
    const hOut = front === 'city' ? 0.1 : front === 'van' ? 0.16 : front === 'ev' ? 0.06 : front === 'hatch' ? 0.098 : front === 'estate' ? 0.078 : 0.08;
    const gapTop = front === 'van' ? 0.03 : front === 'city' ? 0.018 : 0.007;
    const topIn = ys(pIn) - gapTop;
    const topOut = ys(pOut) - gapTop - (front === 'sport' ? 0.03 : 0.012);
    let outline: Pt[];
    if (front === 'city') {
      // round-ish retro lamps on the corners
      const pc = lerp(pIn, pOut, 0.45);
      const yc = lerp(topIn, topOut, 0.5) - 0.06;
      const rp0 = Math.abs(pIn - pOut) * 0.55;
      outline = [];
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        outline.push([pc + Math.cos(a) * rp0, yc + Math.sin(a) * 0.075]);
      }
    } else {
      outline = roundPoly(
        [
          [pIn, topIn],
          [pOut, topOut],
          [pOut + 0.03, topOut - hOut],
          [pIn, topIn - hIn],
        ],
        front === 'van' ? 0.04 : front === 'sport' ? 0.012 : 0.025,
      );
    }
    const botIn = topIn - hIn;
    const botOut = topOut - hOut;
    // DRL light guide: along the lower edge, turning up at the outer end
    const drl: Pt[] =
      front === 'city'
        ? (() => {
            const pc = lerp(pIn, pOut, 0.45);
            const yc = lerp(topIn, topOut, 0.5) - 0.06;
            const rp0 = Math.abs(pIn - pOut) * 0.55 - 0.012;
            const o: Pt[] = [];
            for (let i = 0; i <= 30; i++) {
              const a = (i / 30) * Math.PI * 2;
              o.push([pc + Math.cos(a) * rp0, yc + Math.sin(a) * 0.062]);
            }
            return o;
          })()
        : front === 'ev'
          ? smoothLine([
              [P + 0.01, topIn - 0.018],
              [lerp(pIn, pOut, 0.5), lerp(topIn, topOut, 0.5) - 0.018],
              [pOut + 0.02, topOut - 0.02],
            ])
          : front === 'estate'
            ? // C-shaped light guide wrapping the outer end
              smoothLine([
                [lerp(pIn, pOut, 0.6), lerp(botIn, botOut, 0.6) + 0.016],
                [pOut + 0.05, botOut + 0.02],
                [pOut + 0.03, topOut - 0.018],
                [lerp(pIn, pOut, 0.72), lerp(topIn, topOut, 0.72) - 0.016],
              ])
            : front === 'sport'
              ? // eyebrow along the top edge, dropping down the outer end
                smoothLine([
                  [pIn - 0.008, topIn - 0.02],
                  [lerp(pIn, pOut, 0.5), lerp(topIn, topOut, 0.5) - 0.02],
                  [pOut + 0.03, topOut - 0.022],
                  [pOut + 0.045, botOut + 0.022],
                ])
              : smoothLine([
              [pIn - 0.01, topIn - hIn + 0.022],
              [lerp(pIn, pOut, 0.55), lerp(topIn - hIn, topOut - hOut, 0.55) + 0.02],
              [pOut + 0.035, topOut - hOut + 0.03],
              [pOut + 0.025, topOut - 0.016],
            ]);
    const projectors: { p: number; y: number; r: number }[] = [];
    if (front !== 'ev') {
      const n = front === 'van' ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const t = front === 'van' ? 0.35 : 0.2 + i * 0.22;
        const pp = lerp(pIn, pOut, t);
        if (front === 'sport') {
          // smaller projectors below the eyebrow
          projectors.push({ p: pp, y: lerp(botIn, botOut, t) + 0.031, r: 0.021 });
          continue;
        }
        projectors.push({ p: pp, y: lerp(topIn, topOut, t) - lerp(hIn, hOut, t) * 0.5, r: front === 'van' ? 0.04 : front === 'city' ? 0.028 : 0.026 });
      }
    } else {
      // matrix LED dots in a slim strip
      for (let i = 0; i < 4; i++) {
        const t = 0.45 + i * 0.1;
        projectors.push({ p: lerp(pIn, pOut, t), y: lerp(topIn, topOut, t) - 0.04, r: 0.012 });
      }
    }
    const indicator: Pt[] =
      front === 'city'
        ? []
        : front === 'estate'
          ? // inside the C
            smoothLine([
              [pOut + 0.075, topOut - 0.026],
              [pOut + 0.085, botOut + 0.026],
            ])
          : front === 'sport'
            ? // along the lower edge, under the eyebrow
              smoothLine([
                [lerp(pIn, pOut, 0.72), lerp(botIn, botOut, 0.72) + 0.014],
                [lerp(pIn, pOut, 0.9), lerp(botIn, botOut, 0.9) + 0.016],
              ])
            : smoothLine([
                [pOut + 0.06, topOut - 0.012],
                [pOut + 0.02, topOut - 0.016],
              ]);
    head = { outline, drl, drlWidth: front === 'sport' ? 0.01 : 0.012, projectors, indicator };
  }

  // ---------------- grille / intakes / fog lamps ----------------
  const grilles: Features['grilles'] = [];
  const blacks: Features['blacks'] = [];
  const fogs: Pt[][] = [];
  const yBot = d.frontBottomY;
  {
    const pLampIn = front === 'ev' ? P : fp(front === 'city' ? 0.42 * hw : front === 'van' ? 0.5 * hw : 0.3 * hw);
    if (front === 'hatch') {
      // compact hatch: a thin slot between the lamps (lamps + slot read as one band), a big
      // trapezoid lower intake carrying the plate, vertical corner air curtains, thin lip
      grilles.push({
        poly: roundPoly(
          [
            [pLampIn + 0.012, ys(pLampIn) - 0.014],
            [P + 0.02, yTipF - 0.018],
            [P + 0.02, yTipF - 0.075],
            [pLampIn + 0.02, ys(pLampIn) - 0.068],
          ],
          0.012,
        ),
        pattern: 'slats',
        frame: false,
      });
      const y0 = yBot + 0.04;
      const y1 = yBot + 0.29;
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.6 * hw), y1],
            [P + 0.02, y1 - 0.008],
            [P + 0.02, y0],
            [fp(0.7 * hw), y0],
          ],
          0.035,
        ),
        pattern: 'mesh',
        frame: false,
      });
      blacks.push({
        poly: roundPoly(
          [
            [fp(0.93 * hw), y1 + 0.045],
            [fp(0.8 * hw), y1 + 0.02],
            [fp(0.79 * hw), y0 + 0.03],
            [fp(0.9 * hw), y0 + 0.04],
          ],
          0.02,
        ),
        gloss: true,
      });
      blacks.push({
        poly: [
          [f.pSide1 - 0.1, yBot + 0.015],
          [P + 0.02, yBot + 0.015],
          [P + 0.02, yBot - 0.05],
          [f.pSide1 - 0.1, yBot - 0.05],
        ],
        gloss: false,
      });
    } else if (front === 'estate') {
      // slim upper grille between the lamps
      grilles.push({
        poly: roundPoly(
          [
            [pLampIn + 0.012, ys(pLampIn) - 0.016],
            [P + 0.02, yTipF - 0.02],
            [P + 0.02, yTipF - (front === 'estate' ? 0.2 : 0.13)],
            [pLampIn + 0.03, ys(pLampIn) - (front === 'estate' ? 0.16 : 0.115)],
          ],
          0.015,
        ),
        pattern: front === 'estate' ? 'vbars' : 'slats',
        frame: front === 'estate',
      });
      // wide lower grille spanning most of the bumper
      const y0 = yBot + 0.05;
      const y1 = yBot + (front === 'estate' ? 0.27 : 0.3);
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.74 * hw), y1],
            [P + 0.02, y1 + 0.012],
            [P + 0.02, y0],
            [fp(0.66 * hw), y0],
          ],
          0.03,
        ),
        pattern: front === 'estate' ? 'slats' : 'mesh',
        frame: front === 'estate',
      });
      // corner intakes (air curtains), slanted towards the wheel arches
      blacks.push({
        poly: roundPoly(
          [
            [fp(0.94 * hw), y1 + 0.03],
            [fp(0.79 * hw), y1 + 0.005],
            [fp(0.73 * hw), y0 + 0.02],
            [fp(0.9 * hw), y0 + 0.05],
          ],
          0.02,
        ),
        gloss: true,
      });
      // satin black lower lip
      blacks.push({
        poly: [
          [f.pSide1 - 0.12, yBot + 0.035],
          [P + 0.02, yBot + 0.035],
          [P + 0.02, yBot - 0.05],
          [f.pSide1 - 0.12, yBot - 0.05],
        ],
        gloss: false,
      });
    } else if (front === 'sport') {
      // one wide, shallow upper grille between the lamps (horizontal bars, chrome frame) and a
      // wide lower intake
      const pIn = fp(0.3 * hw);
      grilles.push({
        poly: roundPoly(
          [
            [pIn + 0.015, ys(pIn) - 0.02],
            [P + 0.02, yTipF - 0.018],
            [P + 0.02, yTipF - 0.12],
            [fp(0.26 * hw), ys(fp(0.26 * hw)) - 0.1],
          ],
          0.02,
        ),
        pattern: 'bars',
        frame: true,
      });
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.7 * hw), yBot + 0.24],
            [P + 0.02, yBot + 0.22],
            [P + 0.02, yBot + 0.07],
            [fp(0.6 * hw), yBot + 0.06],
          ],
          0.03,
        ),
        pattern: 'mesh',
        frame: false,
      });
      blacks.push({
        poly: roundPoly(
          [
            [fp(0.86 * hw), yBot + 0.3],
            [fp(0.74 * hw), yBot + 0.27],
            [fp(0.72 * hw), yBot + 0.08],
            [fp(0.9 * hw), yBot + 0.1],
          ],
          0.02,
        ),
        gloss: true,
      });
    } else if (front === 'city') {
      // wide 'smile' intake low in the bumper with a chrome frame, round fog lamps at its ends
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.5), yBot + 0.22],
            [P + 0.02, yBot + 0.2],
            [P + 0.02, yBot + 0.07],
            [fp(0.42), yBot + 0.08],
          ],
          0.05,
        ),
        pattern: 'bars',
        frame: true,
      });
      // satin black lower lip across the front
      blacks.push({
        poly: [
          [f.pSide1 - 0.1, yBot + 0.045],
          [P + 0.02, yBot + 0.045],
          [P + 0.02, yBot - 0.05],
          [f.pSide1 - 0.1, yBot - 0.05],
        ],
        gloss: false,
      });
      const fog: Pt[] = [];
      const pf = fp(0.6);
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        fog.push([pf + Math.cos(a) * 0.035, yBot + 0.15 + Math.sin(a) * 0.035]);
      }
      fogs.push(fog);
    } else if (front === 'van') {
      // tall grille between the lamps, black bumper
      grilles.push({
        poly: roundPoly(
          [
            [pLampIn + 0.015, ys(pLampIn) - 0.04],
            [P + 0.02, yTipF - 0.05],
            [P + 0.02, yTipF - 0.24],
            [pLampIn + 0.03, ys(pLampIn) - 0.22],
          ],
          0.03,
        ),
        pattern: 'bars',
        frame: true,
      });
      blacks.push({
        poly: [
          [f.pSide1 - 0.25, yBot + 0.33],
          [P + 0.02, yBot + 0.33],
          [P + 0.02, yBot - 0.05],
          [f.pSide1 - 0.25, yBot - 0.05],
        ],
        gloss: false,
      });
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.55), yBot + 0.24],
            [P + 0.02, yBot + 0.24],
            [P + 0.02, yBot + 0.09],
            [fp(0.5), yBot + 0.09],
          ],
          0.02,
        ),
        pattern: 'mesh',
        frame: false,
      });
    } else if (front === 'ev') {
      // closed nose: gloss-black panel under the light bar, small lower intake
      blacks.push({
        poly: roundPoly(
          [
            [fp(0.55 * hw), ys(fp(0.55 * hw)) - 0.075],
            [P + 0.02, yTipF - 0.075],
            [P + 0.02, yTipF - 0.14],
            [fp(0.5 * hw), ys(fp(0.5 * hw)) - 0.12],
          ],
          0.02,
        ),
        gloss: true,
      });
      grilles.push({
        poly: roundPoly(
          [
            [fp(0.8 * hw), yBot + 0.28],
            [P + 0.02, yBot + 0.27],
            [P + 0.02, yBot + 0.1],
            [fp(0.72 * hw), yBot + 0.1],
          ],
          0.03,
        ),
        pattern: 'mesh',
        frame: false,
      });
    }
  }

  // ---------------- rear lamps ----------------
  const rearStyle = d.rearLamp;
  const yTipR = ys(0);
  let tail: TailLamp;
  {
    const pOut = f.pSide0 + (rearStyle === 'van' ? 0.0 : rearStyle === 'round' ? 0.02 : 0.1);
    const xIn = rearStyle === 'bar' ? 0 : rearStyle === 'van' ? 0.93 * hw : rearStyle === 'round' ? 0.62 * hw : rearStyle === 'vertical' ? 0.7 * hw : 0.34 * hw;
    const pIn = xIn <= 1e-3 ? 0 : rp(xIn);
    const gapTop = rearStyle === 'van' ? 0.05 : rearStyle === 'split' ? 0.012 : 0.025;
    const topOut = ys(pOut) - gapTop;
    const topIn = ys(pIn) - gapTop;
    const h = rearStyle === 'vertical' ? 0.34 : rearStyle === 'van' ? 0.42 : rearStyle === 'round' ? 0.15 : rearStyle === 'bar' ? 0.085 : 0.15;
    let outline: Pt[];
    if (rearStyle === 'vertical' || rearStyle === 'van') {
      outline = roundPoly(
        [
          [pIn, topIn],
          [pOut, topOut],
          [pOut, topOut - h],
          [pIn, topIn - h * 0.92],
        ],
        0.025,
      );
    } else if (rearStyle === 'round') {
      const pc = lerp(pIn, pOut, 0.5);
      const yc = lerp(topIn, topOut, 0.5) - 0.085;
      outline = [];
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        outline.push([pc + Math.cos(a) * Math.abs(pIn - pOut) * 0.5, yc + Math.sin(a) * 0.08]);
      }
    } else if (rearStyle === 'split') {
      // wedge: tallest where it wraps onto the quarter panel, tapering towards the plate
      outline = roundPoly(
        [
          [pIn - 0.005, topIn],
          [pOut, topOut],
          [pOut - 0.012, topOut - h],
          [lerp(pIn, pOut, 0.42), lerp(topIn, topOut, 0.42) - h * 0.84],
          [pIn - 0.005, topIn - h * 0.58],
        ],
        0.02,
      );
    } else {
      outline = roundPoly(
        [
          [pIn - 0.005, topIn],
          [pOut, topOut],
          [pOut - 0.01, topOut - h * 0.75],
          [pIn - 0.005, topIn - h],
        ],
        0.02,
      );
    }
    const yMid = (topIn + topOut) / 2 - h / 2;
    const guide: Pt[] =
      rearStyle === 'round'
        ? outline.map((q) => [lerp(q[0], lerp(pIn, pOut, 0.5), 0.2), lerp(q[1], yMid, 0.2)] as Pt).concat([[lerp(outline[0][0], lerp(pIn, pOut, 0.5), 0.2), lerp(outline[0][1], yMid, 0.2)]])
        : rearStyle === 'vertical' || rearStyle === 'van'
          ? smoothLine([
              [pOut + 0.025, topOut - 0.03],
              [pIn + 0.0, topIn - 0.03],
              [pIn + 0.0, topIn - h * 0.85],
            ])
          : rearStyle === 'bar'
            ? smoothLine([
                [-0.01, topIn - 0.03],
                [lerp(pIn, pOut, 0.6), lerp(topIn, topOut, 0.6) - 0.03],
                [pOut + 0.02, topOut - 0.035],
              ])
            : smoothLine([
                [pIn + 0.01, topIn - 0.03],
                [lerp(pIn, pOut, 0.5), lerp(topIn, topOut, 0.5) - 0.032],
                [pOut + 0.03, topOut - 0.03],
                [pOut + 0.02, topOut - h * 0.55],
              ]);
    // brake area: the inner block of the lamp
    const bIn = rearStyle === 'bar' ? lerp(pIn, pOut, 0.55) : pIn + 0.015;
    const bOut = rearStyle === 'vertical' || rearStyle === 'van' ? pOut - 0.02 : lerp(pIn, pOut, 0.55);
    const brake: Pt[] =
      rearStyle === 'vertical' || rearStyle === 'van'
        ? roundPoly(
            [
              [pIn + 0.015, topIn - 0.06],
              [pOut - 0.015, topOut - 0.06],
              [pOut - 0.015, topOut - h * 0.42],
              [pIn + 0.015, topIn - h * 0.42],
            ],
            0.01,
          )
        : roundPoly(
            [
              [bIn, lerp(topIn, topOut, 0.1) - 0.05],
              [bOut, lerp(topIn, topOut, 0.55) - 0.05],
              [bOut, lerp(topIn, topOut, 0.55) - h * 0.68],
              [bIn, lerp(topIn, topOut, 0.1) - h * 0.85],
            ],
            0.01,
          );
    const indicator: Pt[] =
      rearStyle === 'vertical' || rearStyle === 'van'
        ? roundPoly(
            [
              [pIn + 0.015, topIn - h * 0.48],
              [pOut - 0.015, topOut - h * 0.48],
              [pOut - 0.015, topOut - h * 0.68],
              [pIn + 0.015, topIn - h * 0.68],
            ],
            0.01,
          )
        : roundPoly(
            [
              [lerp(pIn, pOut, 0.6), lerp(topIn, topOut, 0.6) - 0.055],
              [pOut + 0.01, topOut - 0.05],
              [pOut + 0.0, topOut - h * 0.55],
              [lerp(pIn, pOut, 0.6), lerp(topIn, topOut, 0.6) - h * 0.62],
            ],
            0.008,
          );
    const reverse: Pt[] =
      rearStyle === 'vertical' || rearStyle === 'van'
        ? roundPoly(
            [
              [pIn + 0.015, topIn - h * 0.72],
              [pOut - 0.015, topOut - h * 0.72],
              [pOut - 0.015, topOut - h * 0.9],
              [pIn + 0.015, topIn - h * 0.88],
            ],
            0.01,
          )
        : roundPoly(
            [
              [pIn + 0.015, topIn - h * 0.62],
              [lerp(pIn, pOut, 0.3), lerp(topIn, topOut, 0.3) - h * 0.62],
              [lerp(pIn, pOut, 0.3), lerp(topIn, topOut, 0.3) - h * 0.86],
              [pIn + 0.015, topIn - h * 0.88],
            ],
            0.008,
          );
    if (rearStyle === 'split') {
      // wedge lamp: brake block in the middle (spans the tailgate split), amber at the outer
      // end, reverse light low in the middle
      const L = (t: number) => lerp(pIn, pOut, t);
      const T = (t: number) => lerp(topIn, topOut, t);
      tail = {
        outline,
        guide,
        guideWidth: 0.014,
        brake: roundPoly(
          [
            [L(0.08), T(0.08) - 0.045],
            [L(0.6), T(0.6) - 0.045],
            [L(0.6), T(0.6) - h * 0.58],
            [L(0.08), T(0.08) - h * 0.46],
          ],
          0.01,
        ),
        indicator: roundPoly(
          [
            [L(0.68), T(0.68) - 0.05],
            [pOut + 0.01, topOut - 0.05],
            [pOut - 0.004, topOut - h * 0.6],
            [L(0.68), T(0.68) - h * 0.66],
          ],
          0.008,
        ),
        reverse: roundPoly(
          [
            [L(0.3), T(0.3) - h * 0.64],
            [L(0.62), T(0.62) - h * 0.68],
            [L(0.62), T(0.62) - h * 0.84],
            [L(0.3), T(0.3) - h * 0.76],
          ],
          0.008,
        ),
      };
    } else tail = { outline, guide, guideWidth: 0.014, brake, indicator, reverse };
  }

  // ---------------- side: panel gaps, handles, mirror ----------------
  const gaps: Pt[][] = [];
  let slidingDoor: Features['slidingDoor'] = null;
  const sillGap = d.sillY + 0.075;
  // windows sorted front first: [front door, rear door (four-door bodies), fixed quarter glass...]
  const wins = [...d.windows].sort((a, b) => b.pts[3][0] - a.pts[3][0]);
  const frontWin = wins[0];
  const fourDoor = !d.van && (d.doors ?? 2) === 2 && wins.length > 1;
  const rearDoorWin = fourDoor ? wins[1] : null;
  const zBpil = rearDoorWin ? 0.5 * (frontWin.pts[0][0] + rearDoorWin.pts[3][0]) : frontWin.pts[0][0] - 0.05;
  const zFrontDoor = zArchFrontRear - 0.035;
  const yBeltFront = belt(d.cowlZ - 0.05);
  // front door front edge (behind the front wheel arch, up to the A-pillar base)
  gaps.push(
    smoothLine(
      [
        [zFrontDoor, sillGap],
        [zFrontDoor + 0.005, 0.55],
        [zFrontDoor + 0.02, yBeltFront - 0.12],
        [d.cowlZ - 0.04, yBeltFront - 0.005],
      ].map(([z, y]) => [sp(z), y] as Pt),
    ),
  );
  if (rearDoorWin) {
    // B pillar: both doors meet here
    gaps.push(
      [
        [zBpil, belt(zBpil) - 0.004],
        [zBpil + 0.01, sillGap],
      ].map(([z, y]) => [sp(z), y] as Pt),
    );
    // rear door rear edge, curving around the rear wheel arch
    const zRD = Math.min(rearDoorWin.pts[0][0] - 0.035, zArchRearFront + 0.12);
    const yArchTop = f.wheelR + R;
    gaps.push(
      smoothLine(
        [
          [zRD, belt(zRD) - 0.004],
          [zRD + 0.005, yArchTop + 0.06],
          [zArchRearFront + 0.06, yArchTop - 0.03],
          [zArchRearFront + 0.035, f.wheelR + 0.05],
          [zArchRearFront + 0.03, sillGap],
        ].map(([z, y]) => [sp(z), y] as Pt),
        5,
      ),
    );
    // door bottoms
    gaps.push([
      [sp(zArchRearFront + 0.03), sillGap],
      [sp(zFrontDoor), sillGap],
    ]);
  } else if (!d.van) {
    // three-door body: one long door, its rear edge just behind the door window
    gaps.push(
      [
        [zBpil, belt(zBpil) - 0.004],
        [zBpil - 0.01, sillGap],
      ].map(([z, y]) => [sp(z), y] as Pt),
    );
    gaps.push([
      [sp(zBpil - 0.01), sillGap],
      [sp(zFrontDoor), sillGap],
    ]);
  } else {
    // van: cab door rear edge at the B pillar, sliding door outline
    gaps.push(
      [
        [zBpil, belt(zBpil) - 0.004],
        [zBpil, sillGap],
      ].map(([z, y]) => [sp(z), y] as Pt),
    );
    const zs0 = zBpil - 0.04;
    const zs1 = zBpil - 1.25;
    slidingDoor = { z0: zs0, z1: zs1 };
    gaps.push(
      roundPoly(
        [
          [zs0, belt(zs0) + 0.6],
          [zs1, belt(zs1) + 0.6],
          [zs1, sillGap],
          [zs0, sillGap],
        ],
        0.03,
      )
        .concat([[zs0, belt(zs0) + 0.6]])
        .map(([z, y]) => [sp(z), y] as Pt),
    );
    gaps.push([
      [sp(zs0), sillGap],
      [sp(zFrontDoor), sillGap],
    ]);
  }
  // front bumper / fender seam from the arch up to the lamp corner
  const pLampOut = head.outline.reduce((a, q) => Math.min(a, q[0]), Infinity);
  gaps.push(
    smoothLine([
      [sp(f.zFA + R * 0.78), f.wheelR + R * 0.62],
      [pLampOut + 0.04, lerp(f.wheelR + R * 0.62, ys(pLampOut) - 0.08, 0.6)],
      [pLampOut + 0.02, ys(pLampOut) - 0.085],
    ]),
  );
  // rear bumper seam
  const pTailOut = tail.outline.reduce((a, q) => Math.max(a, q[0]), -Infinity);
  const yBumpR = d.rearBottomY + (d.van ? 0.33 : 0.3);
  gaps.push(
    smoothLine([
      [sp(f.zRA - R * 0.8), f.wheelR + R * 0.58],
      [pTailOut + 0.03, yBumpR + 0.02],
      [rp(0.75 * hw), yBumpR],
      [-0.02, yBumpR],
    ]),
  );
  // tailgate / trunk shut lines on the rear face
  if (!d.trunk) {
    const xg = d.van ? 0.0 : 0.56 * hw;
    if (d.van) {
      // twin rear doors: centre split + outer frame
      gaps.push([
        [0.0, ys(0) - 0.01],
        [0.0, yBumpR + 0.005],
      ]);
      gaps.push([
        [rp(0.88 * hw), ys(rp(0.88 * hw)) - 0.012],
        [rp(0.88 * hw), yBumpR + 0.005],
        [-0.02, yBumpR + 0.005],
      ]);
    } else {
      gaps.push(
        smoothLine([
          [rp(xg), ys(rp(xg)) - 0.004],
          [rp(xg * 1.01), lerp(ys(rp(xg)), yBumpR, 0.5)],
          [rp(xg * 0.96), yBumpR + 0.04],
          [rp(xg * 0.8), yBumpR + 0.03],
          [-0.02, yBumpR + 0.03],
        ]),
      );
    }
  }

  // hood shut lines in hood coordinates [z, x]
  const hoodGaps: Pt[][] = [];
  {
    // offset of the hood outline (shoulder line in the z/x plane) 14 mm towards the hood centre,
    // so the front shut line sits right at the leading edge instead of on top of the bonnet
    const outline: Pt[] = [];
    const n = 80;
    const p0 = f.pOfShoulderZ(d.cowlZ + 0.075);
    for (let i = 0; i <= n; i++) {
      const s = f.shoulderPoint(lerp(p0, f.P, i / n));
      outline.push([s.z, s.x]);
    }
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = outline[Math.max(0, i - 1)];
      const b = outline[Math.min(n, i + 1)];
      const tz = b[0] - a[0];
      const tx = b[1] - a[1];
      const l = Math.hypot(tz, tx) || 1;
      const q = outline[i];
      pts.push([q[0] + (tx / l) * 0.014, Math.max(0, q[1] - (tz / l) * 0.014)]);
    }
    hoodGaps.push(pts);
    hoodGaps.push([
      [d.cowlZ + 0.075, 0],
      [d.cowlZ + 0.075, pts[0][1]],
    ]);
  }

  // door handles and mirror
  const handles: Pt[] = [];
  const yH = (z: number) => belt(z) - (d.van ? 0.16 : 0.105);
  handles.push([zBpil + 0.2, yH(zBpil + 0.2)]);
  if (rearDoorWin) handles.push([zBpil - 0.82, yH(zBpil - 0.82)]);
  else if (d.van) handles.push([zBpil - 0.25, yH(zBpil - 0.25)]);
  const mirror: Pt = [d.cowlZ - (d.van ? 0.05 : 0.12), belt(d.cowlZ - 0.12) + 0.05];

  const plateFront = { y: front === 'city' ? yBot + 0.07 : front === 'van' ? yBot + 0.25 : yBot + 0.165 };
  const plateRearY = d.trunk ? ys(0) - 0.2 : d.van ? yBumpR + 0.1 : yBumpR + 0.13;
  const plateRear = { y: plateRearY, p: 0 };
  const reflectors: Pt[][] = [
    roundPoly(
      [
        [rp(0.86 * hw), yBumpR - 0.12],
        [rp(0.68 * hw), yBumpR - 0.12],
        [rp(0.68 * hw), yBumpR - 0.15],
        [rp(0.86 * hw), yBumpR - 0.15],
      ],
      0.01,
    ),
  ];
  // rear diffuser / lower bumper black
  blacks.push({
    poly: [
      [-0.02, d.rearBottomY + 0.12],
      [rp(0.8 * hw), d.rearBottomY + 0.1],
      [rp(0.9 * hw), d.rearBottomY - 0.05],
      [-0.02, d.rearBottomY - 0.05],
    ],
    gloss: false,
  });
  if (d.cladding) {
    // crossover: black wheel arch and sill cladding is painted in atlasPaint (needs the arch shape)
  }
  const exhausts: Pt[] =
    d.exhaust === 'twin'
      ? [
          [0.5 * hw, d.rearBottomY + 0.03],
          [0.4 * hw, d.rearBottomY + 0.03],
          [-0.5 * hw, d.rearBottomY + 0.03],
          [-0.4 * hw, d.rearBottomY + 0.03],
        ]
      : d.exhaust === 'left'
        ? [[0.55 * hw, d.rearBottomY + 0.02]]
        : [];

  // ---------------- LOD 0 recessed units ----------------
  const recesses: Recess[] = [];
  const half = (poly: Pt[]) => clipBand(poly, 0, P);
  recesses.push({ kind: 'head', poly: half(head.outline), depth: front === 'van' ? 0.06 : 0.05 });
  let tailSplitP: number | null = null;
  {
    const ps = tail.outline.map((q) => q[0]);
    const pg = rp(0.56 * hw);
    if (!d.trunk && !d.van && Math.min(...ps) < pg - 0.03 && Math.max(...ps) > pg + 0.03) tailSplitP = pg;
  }
  if (tailSplitP !== null) {
    recesses.push({ kind: 'tail', poly: clipBand(tail.outline, 0, tailSplitP - 0.004), depth: 0.035 });
    recesses.push({ kind: 'tail', poly: clipBand(tail.outline, tailSplitP + 0.004, P), depth: 0.035 });
  } else recesses.push({ kind: 'tail', poly: half(tail.outline), depth: 0.035 });
  for (const g of grilles) {
    if (g.pattern === 'closed') continue;
    recesses.push({ kind: 'grille', poly: half(g.poly), depth: g.pattern === 'mesh' ? 0.05 : 0.035, pattern: g.pattern, chrome: g.pattern === 'bars' || g.pattern === 'vbars' });
  }
  if (front !== 'ev') for (const b of blacks) if (b.gloss) recesses.push({ kind: 'intake', poly: half(b.poly), depth: 0.035 });
  for (const fg of fogs) recesses.push({ kind: 'fog', poly: half(fg), depth: 0.03 });

  return {
    head,
    tail,
    grilles,
    blacks,
    gaps,
    hoodGaps,
    plateFront,
    plateRear,
    handles,
    mirror,
    badgeFront: [P, front === 'sport' ? yTipF - 0.025 : front === 'van' ? yTipF - 0.14 : front === 'hatch' ? yTipF - 0.045 : yTipF - 0.075],
    badgeRear: [0, ys(0) - (d.trunk ? 0.08 : 0.085)],
    reflectors,
    exhausts,
    fogs,
    slidingDoor,
    recesses,
    tailSplitP,
  };
}
