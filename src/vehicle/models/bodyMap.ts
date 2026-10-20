// Coordinate helpers on top of a BodyFrame: converts feature coordinates (side view, front view,
// greenhouse arc, deck) to atlas pixels and to 3D surface points + normals, so painted details and
// geometric parts (lights, handles, mirrors) land on exactly the same spot.
import type { AtlasLayout } from './atlasLayout';
import { BodyFrame, type GhSection, type V3 } from './body';
import { clamp, lerp } from './curves';

export interface GhInfo {
  p: number;
  sideLen: number;
  cornerEnd: number;
  len: number;
  /** arc of the roof-edge corner midpoint (A-pillar / rail centre line) */
  mid: number;
}

export class BodyMap {
  readonly f: BodyFrame;
  readonly atlas: AtlasLayout;
  private tz: Float64Array;
  private tInfo: GhInfo[];
  private secCache: GhSection | undefined;

  constructor(f: BodyFrame, atlas: AtlasLayout) {
    this.f = f;
    this.atlas = atlas;
    const d = f.d;
    const n = Math.max(40, Math.ceil((d.cowlZ - d.rearBaseZ) / 0.006));
    this.tz = new Float64Array(n + 1);
    this.tInfo = [];
    // shoulder z is monotonic in p inside the greenhouse range: walk p and invert
    for (let i = 0; i <= n; i++) {
      const z = lerp(d.rearBaseZ, d.cowlZ, i / n);
      const p = f.pOfShoulderZ(z);
      const sec = f.ghSection(p);
      this.tz[i] = z;
      this.tInfo.push({
        p,
        sideLen: sec.sideLen,
        cornerEnd: sec.cornerEnd,
        len: sec.len,
        mid: 0.5 * (sec.sideLen + sec.cornerEnd),
      });
    }
  }

  /** Greenhouse section info at z (interpolated table). */
  gh(z: number): GhInfo {
    const n = this.tz.length - 1;
    const t = clamp((z - this.tz[0]) / (this.tz[n] - this.tz[0]), 0, 1) * n;
    const i = Math.min(Math.floor(t), n - 1);
    const u = t - i;
    const a = this.tInfo[i];
    const b = this.tInfo[i + 1];
    return {
      p: lerp(a.p, b.p, u),
      sideLen: lerp(a.sideLen, b.sideLen, u),
      cornerEnd: lerp(a.cornerEnd, b.cornerEnd, u),
      len: lerp(a.len, b.len, u),
      mid: lerp(a.mid, b.mid, u),
    };
  }

  // ---- atlas pixels -------------------------------------------------------------------------------
  pxLower(p: number, y: number): [number, number] {
    return this.atlas.px(this.atlas.lower, p, y);
  }
  pxGh(z: number, arc: number): [number, number] {
    return this.atlas.px(this.atlas.gh, this.f.sc(z), arc);
  }
  pxHood(z: number, x: number): [number, number] {
    return this.atlas.px(this.atlas.hood, z, Math.abs(x));
  }
  pxTrunk(z: number, x: number): [number, number] {
    return this.atlas.px(this.atlas.trunk, z, Math.abs(x));
  }

  // ---- plan helpers -------------------------------------------------------------------------------
  /** p on the body side at longitudinal position z */
  sideP(z: number): number {
    return this.f.pOfPlanZ(z);
  }
  /** p on the front face at lateral offset x (0 = centre) */
  frontP(x: number): number {
    return Math.abs(x) < 1e-4 ? this.f.P : this.f.pOfPlanX(Math.abs(x), true);
  }
  /** p on the rear face at lateral offset x */
  rearP(x: number): number {
    return Math.abs(x) < 1e-4 ? 0 : this.f.pOfPlanX(Math.abs(x), false);
  }
  /** shoulder (top of lower body) height at plan p */
  shoulderY(p: number): number {
    return this.f.shoulderPoint(p).y;
  }

  // ---- 3D placement (left side) ---------------------------------------------------------------------
  lowerPos(p: number, y: number, out: V3, normal?: V3): V3 {
    return this.f.lowerAt(p, y, out, normal);
  }

  /** Greenhouse surface point at z and section arc, with normal (left side). */
  ghPos(z: number, arc: number, out: V3, normal?: V3): V3 {
    const info = this.gh(z);
    const f = this.f;
    this.secCache = f.ghSection(info.p, this.secCache);
    const g = { x: 0, y: 0, tx: 0, ty: 0 };
    f.ghPoint(this.secCache, arc, g);
    out.x = g.x;
    out.y = g.y;
    out.z = this.secCache.z;
    if (normal) {
      const e = 0.004;
      const a = f.ghSection(this.gh(z - e).p);
      const b = f.ghSection(this.gh(z + e).p);
      const ga = { x: 0, y: 0, tx: 0, ty: 0 };
      const gb = { x: 0, y: 0, tx: 0, ty: 0 };
      f.ghPoint(a, arc, ga);
      f.ghPoint(b, arc, gb);
      const dx = gb.x - ga.x;
      const dy = gb.y - ga.y;
      const dz = b.z - a.z;
      let nx = g.ty * dz;
      let ny = -g.tx * dz;
      let nz = g.tx * dy - g.ty * dx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      normal.x = nx;
      normal.y = ny;
      normal.z = nz;
    }
    return out;
  }

  /** Deck (hood / trunk) surface point at z and lateral x. */
  deckPos(z: number, x: number, out: V3, normal?: V3): V3 {
    const f = this.f;
    const d = f.d;
    const hood = z > d.cowlZ - 0.01;
    const eval1 = (zz: number, xx: number, o: V3) => {
      const p = f.pOfShoulderZ(zz);
      const s = f.shoulderPoint(p);
      const crown0 = hood ? d.hoodCrown : d.deckCrown;
      const crown = crown0 * Math.min(1, s.x / (0.6 * d.halfWidth));
      const w = s.x > 1e-5 ? clamp(xx / s.x, -1, 1) : 0;
      o.x = xx;
      o.y = s.y + crown * (1 - w * w);
      o.z = s.z;
      return o;
    };
    eval1(z, x, out);
    if (normal) {
      const e = 0.005;
      const a = eval1(z, x - e, { x: 0, y: 0, z: 0 });
      const b = eval1(z, x + e, { x: 0, y: 0, z: 0 });
      const c = eval1(z - e, x, { x: 0, y: 0, z: 0 });
      const dd = eval1(z + e, x, { x: 0, y: 0, z: 0 });
      // (dz-dir) x (dx-dir) = up
      const ux = dd.x - c.x;
      const uy = dd.y - c.y;
      const uz = dd.z - c.z;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const vz = b.z - a.z;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      normal.x = nx;
      normal.y = ny;
      normal.z = nz;
    }
    return out;
  }
}
