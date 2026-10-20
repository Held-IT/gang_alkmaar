// Texture atlas layout of a car body. The body texture holds four unwrapped regions in metric
// coordinates plus a few flat "material patches" used by small parts merged into the body or
// detail meshes:
//   lower : u = plan perimeter p (m), v = height y (m)           (body side incl. nose and tail)
//   gh    : u = centre-line arc sc(z) (m), v = section arc (m)   (greenhouse: glass, pillars, roof)
//   hood  : u = z (m), v = |x| (m)
//   trunk : u = z (m), v = |x| (m)
// Pixel coordinates have their origin top-left; the canvas texture uses flipY, so uv.v = 1 - py/H.
import type { BodyFrame } from './body';

export type PatchName = 'paint' | 'gloss' | 'satin' | 'grey' | 'chrome' | 'rubber' | 'glass' | 'white' | 'lens';
export const PATCHES: PatchName[] = ['paint', 'gloss', 'satin', 'grey', 'chrome', 'rubber', 'glass', 'white', 'lens'];

export interface Region {
  /** pixel position of the region's top-left corner */
  px0: number;
  py0: number;
  /** metric u at the left edge and v at the top edge */
  u0: number;
  v1: number;
  /** metric size */
  wm: number;
  hm: number;
}

export class AtlasLayout {
  readonly W = 2048;
  readonly H = 1024;
  /** pixels per metre */
  readonly s: number;
  readonly lower: Region;
  readonly gh: Region;
  readonly hood: Region;
  readonly trunk: Region;
  readonly patchPx: Record<PatchName, [number, number]>;
  readonly patchSize = 20;
  /** extents used for the layout */
  readonly ghArcMax: number;
  readonly lowerYMax: number;

  constructor(f: BodyFrame, ghArcMax: number) {
    const pad = 6;
    const d = f.d;
    this.ghArcMax = ghArcMax;
    let yMax = 0;
    for (let i = 0; i <= 200; i++) {
      const s = f.shoulderPoint((i / 200) * f.P);
      yMax = Math.max(yMax, s.y);
    }
    yMax += 0.03;
    this.lowerYMax = yMax;
    const hw = d.halfWidth + 0.06;
    const ghU0 = f.sc(d.rearBaseZ) - 0.03;
    const ghU1 = f.sc(d.cowlZ) + 0.03;
    const ghW = ghU1 - ghU0;
    const hoodW = f.zF - d.cowlZ + 0.06;
    const trunkW = d.rearBaseZ - f.zR + 0.06;
    const patchW = 2 * 24 + pad;
    const topH = Math.max(ghArcMax + 0.02, hw);
    // fit scale
    const sW1 = (this.W - 2 * pad) / f.P;
    const sW2 = (this.W - patchW - 5 * pad) / (ghW + hoodW + trunkW);
    const sH = (this.H - 3 * pad) / (yMax + topH);
    const s = Math.floor(Math.min(sW1, sW2, sH));
    this.s = s;
    // top row: gh | hood | trunk | patches ; bottom row: lower
    let x = pad;
    const yTop = pad;
    this.gh = { px0: x, py0: yTop, u0: ghU0, v1: ghArcMax + 0.02, wm: ghW, hm: ghArcMax + 0.02 };
    x += ghW * s + pad;
    this.hood = { px0: x, py0: yTop, u0: d.cowlZ - 0.04, v1: hw, wm: hoodW, hm: hw };
    x += hoodW * s + pad;
    this.trunk = { px0: x, py0: yTop, u0: f.zR - 0.02, v1: hw, wm: trunkW, hm: hw };
    x += trunkW * s + pad;
    const yLow = yTop + topH * s + pad;
    this.lower = { px0: pad, py0: yLow, u0: 0, v1: yMax, wm: f.P, hm: yMax };
    // patches in a 2-column grid at the right end of the top row
    const px = this.W - pad - 2 * 24;
    const pp = {} as Record<PatchName, [number, number]>;
    PATCHES.forEach((name, i) => {
      pp[name] = [px + (i % 2) * 24 + 12, yTop + Math.floor(i / 2) * 24 + 12];
    });
    this.patchPx = pp;
  }

  /** pixel coordinates of metric (u, v) in a region */
  px(r: Region, u: number, v: number): [number, number] {
    return [r.px0 + (u - r.u0) * this.s, r.py0 + (r.v1 - v) * this.s];
  }

  /** uv of metric (u, v) in a region */
  uv(r: Region, u: number, v: number, out: [number, number] = [0, 0]): [number, number] {
    out[0] = (r.px0 + (u - r.u0) * this.s) / this.W;
    out[1] = 1 - (r.py0 + (r.v1 - v) * this.s) / this.H;
    return out;
  }

  patchUv(name: PatchName): [number, number] {
    const p = this.patchPx[name];
    return [p[0] / this.W, 1 - p[1] / this.H];
  }
}
