// Toolkit for the hand-made hero landmarks (De Waag, Accijnstoren).
//
// HeroBuilder collects geometry per material (brick / stone / roof / lead / detail) and merges it
// into ONE mesh per material, so a whole building is 5 draw calls. Brick, stone and roof use the
// MaterialLibrary PBR texture sets (colour / normal / ARM) with metric box-projected UVs computed
// from the final positions and normals; the vertex colour tints them (darker plinth, weathered
// stone). 'detail' is the prop uber material (per-vertex colour, roughness and metalness) for
// windows, shutters, doors, clock faces, gilding and bells.
//
// Facades are built in facade coordinates: u to the right seen from outside, y up, w outwards
// with w = 0 on the outer wall face. Walls are extruded shapes with real openings (reveals), so
// windows sit in deep jambs.
import * as THREE from 'three';
import type { MaterialLibrary } from '../../contracts';
import { LAYER_REFLECT } from '../../config';
import { MeshBuilder, mat, type Style } from '../props/util/geom';
import { createPropMaterial } from '../props/util/propMaterial';
import { getGrungeTexture } from '../props/util/textures';

export type HeroMat = 'brick' | 'stone' | 'roof' | 'lead' | 'detail';
const MATS: HeroMat[] = ['brick', 'stone', 'roof', 'lead', 'detail'];

/** Texture set, default tile size (metres) and colour without a MaterialLibrary. */
const SETS: Record<HeroMat, { set: string | null; tile: number; fallback: number }> = {
  brick: { set: 'brick_facade', tile: 1.25, fallback: 0x9a4a3a },
  stone: { set: 'stone', tile: 2, fallback: 0xd8d2c4 },
  roof: { set: 'roof_tiles_dark', tile: 2.9, fallback: 0x45484e },
  lead: { set: null, tile: 1.6, fallback: 0xffffff },
  detail: { set: null, tile: 1, fallback: 0xffffff },
};

interface PbrLib {
  pbr(name: string, opts?: { normalScale?: number }): THREE.MeshStandardMaterial;
  metres(name: string): number;
}
function pbrLib(lib: MaterialLibrary | null): PbrLib | null {
  return lib && 'pbr' in lib && 'metres' in lib ? (lib as unknown as PbrLib) : null;
}

// ------------------------------------------------------------------------------------- palette
export const C = {
  white: { color: 0xf1efe8, rough: 0.45 } as Style,
  glass: { color: 0x1a2328, rough: 0.06 } as Style,
  glassLead: { color: 0x2a3236, rough: 0.12 } as Style,
  leadBar: { color: 0x202224, rough: 0.5, metal: 0.4 } as Style,
  red: { color: 0xa11e1a, rough: 0.5 } as Style,
  shutterWhite: { color: 0xeeece4, rough: 0.5 } as Style,
  green: { color: 0x1f3a2c, rough: 0.5 } as Style,
  doorWood: { color: 0x4a3324, rough: 0.7 } as Style,
  dark: { color: 0x0f0d0c, rough: 0.95 } as Style,
  gold: { color: 0xd1a443, rough: 0.28, metal: 1 } as Style,
  dial: { color: 0x15223d, rough: 0.45 } as Style,
  bronze: { color: 0x7a5530, rough: 0.4, metal: 1 } as Style,
  iron: { color: 0x1b1c1e, rough: 0.55, metal: 0.6 } as Style,
  louvre: { color: 0x3b2e24, rough: 0.8 } as Style,
  // multipliers on the textured materials
  brick: { color: new THREE.Color(0.9, 0.8, 0.76) } as Style,
  brickDark: { color: new THREE.Color(0.62, 0.55, 0.52) } as Style,
  stone: { color: new THREE.Color(1.0, 0.98, 0.93) } as Style,
  stoneGrey: { color: new THREE.Color(0.74, 0.73, 0.7) } as Style,
  roof: { color: new THREE.Color(0.78, 0.8, 0.86) } as Style,
  lead: { color: 0x6a7278 } as Style,
  leadDark: { color: 0x4c5257 } as Style,
};

export const V2 = (x: number, y: number): THREE.Vector2 => new THREE.Vector2(x, y);

/** Flat-shaded copy (non-indexed, per-face normals) for faceted parts (octagons, pyramids). */
export function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const f = g.index ? g.toNonIndexed() : g;
  f.deleteAttribute('normal');
  f.computeVertexNormals();
  return f;
}

/** Octagonal lathe (faces aligned with the x / z axes), flat shaded. Profile = [radius, y]. */
export function octLathe(profile: [number, number][], seg = 8): THREE.BufferGeometry {
  return flat(new THREE.LatheGeometry(profile.map(([r, y]) => V2(Math.max(r, 0.0005), y)), seg, Math.PI / seg));
}

/** Octagonal prism (faces aligned with x / z), radius to the corners, base at y = 0. */
export function octPrism(r: number, h: number, seg = 8): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1, false, Math.PI / seg);
  g.translate(0, h / 2, 0);
  return flat(g);
}

function autoUV(g: THREE.BufferGeometry, tile: number): void {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
  const k = 1 / tile;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i);
    let u: number, v: number;
    if (Math.abs(ny) > 0.88) {
      u = x;
      v = z;
    } else {
      const h = Math.hypot(nx, nz) || 1;
      u = (z * nx - x * nz) / h; // along the surface, horizontally
      v = y / h; // distance along the slope (= height on walls)
    }
    uv.setXY(i, u * k, v * k);
  }
  g.setAttribute('uv', uv);
}

export interface HeroModel {
  group: THREE.Group;
  triangles: number;
  drawCalls: number;
  dispose(): void;
}

export class HeroBuilder {
  private readonly mb = {} as Record<HeroMat, MeshBuilder>;
  private readonly tile = {} as Record<HeroMat, number>;
  private readonly pl: PbrLib | null;

  constructor(private readonly lib: MaterialLibrary | null) {
    this.pl = pbrLib(lib);
    for (const m of MATS) {
      this.mb[m] = new MeshBuilder();
      let t = SETS[m].tile;
      const set = SETS[m].set;
      if (set && this.pl) {
        try {
          t = this.pl.metres(set) || t;
        } catch {
          /* default tile */
        }
      }
      this.tile[m] = t;
    }
  }

  /**
   * Append a geometry (model coordinates after `matrix`). uv 'auto' = metric box projection,
   * 'keep' = the geometry's own UVs (round parts: columns, bells, dials).
   */
  add(m: HeroMat, geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, style: Style, uv: 'auto' | 'keep' = 'auto'): this {
    const g = geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (uv === 'auto') autoUV(g, this.tile[m]);
    this.mb[m].add(g, null, style);
    g.dispose();
    return this;
  }

  /** Axis-aligned box in model coordinates. */
  box(m: HeroMat, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, style: Style): this {
    return this.add(m, new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)), mat((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), style);
  }

  private material(m: HeroMat, name: string): THREE.Material {
    const s = SETS[m];
    if (m === 'detail') return createPropMaterial({ name: `${name}_detail`, map: getGrungeTexture() });
    if (s.set && this.pl) {
      try {
        const base = this.pl.pbr(s.set, { normalScale: m === 'stone' ? 0.8 : 1 });
        const out = base.clone();
        out.name = `${name}_${m}`;
        out.vertexColors = true;
        out.metalness = 0; // brick / stone / tiles are dielectric (the ARM blue channel is ignored)
        return out;
      } catch {
        /* fall back below */
      }
    }
    if (m === 'lead') {
      return new THREE.MeshStandardMaterial({ name: `${name}_lead`, color: 0xffffff, vertexColors: true, map: getGrungeTexture(), roughness: 0.5, metalness: 0.55 });
    }
    return new THREE.MeshStandardMaterial({ name: `${name}_${m}`, color: s.fallback, vertexColors: true, map: getGrungeTexture(), roughness: 0.85, metalness: 0 });
  }

  /** Merge everything into one mesh per material (shadows on, on the water reflection layer). */
  build(name: string): HeroModel {
    const group = new THREE.Group();
    group.name = name;
    const owned: { dispose(): void }[] = [];
    let triangles = 0;
    let drawCalls = 0;
    for (const m of MATS) {
      const b = this.mb[m];
      if (!b.vertexCount) continue;
      const g = b.build();
      if (m !== 'detail') {
        g.deleteAttribute('aRM');
        g.deleteAttribute('aPaint');
        g.deleteAttribute('aEmit');
      }
      const material = this.material(m, name);
      const mesh = new THREE.Mesh(g, material);
      mesh.name = `${name}:${m}`;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.layers.enable(LAYER_REFLECT);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      triangles += (g.index ? g.index.count : (g.getAttribute('position') as THREE.BufferAttribute).count) / 3;
      drawCalls++;
      owned.push(g, material);
    }
    return { group, triangles, drawCalls, dispose: () => owned.forEach((o) => o.dispose()) };
  }
}

// ------------------------------------------------------------------------------------- paths
export function rectPath(u0: number, y0: number, u1: number, y1: number): THREE.Path {
  const p = new THREE.Path();
  p.moveTo(u0, y0);
  p.lineTo(u1, y0);
  p.lineTo(u1, y1);
  p.lineTo(u0, y1);
  p.lineTo(u0, y0);
  return p;
}

export type Top = 'flat' | 'round' | 'pointed' | 'segment';

/** Opening outline: rectangle up to ySpring, then a round / pointed / segmental head. */
export function archPath(u0: number, u1: number, y0: number, ySpring: number, top: Top): THREE.Path {
  const p = new THREE.Path();
  const w = u1 - u0, uc = (u0 + u1) / 2;
  p.moveTo(u0, y0);
  p.lineTo(u1, y0);
  p.lineTo(u1, ySpring);
  if (top === 'round') p.absarc(uc, ySpring, w / 2, 0, Math.PI, false);
  else if (top === 'pointed') {
    p.absarc(u0, ySpring, w, 0, Math.PI / 3, false);
    p.absarc(u1, ySpring, w, (2 * Math.PI) / 3, Math.PI, false);
  } else if (top === 'segment') {
    // shallow arch (rise = w / 6)
    const rise = w / 6;
    const r = (w * w / 4 + rise * rise) / (2 * rise);
    const a = Math.asin(w / 2 / r);
    p.absarc(uc, ySpring + rise - r, r, Math.PI / 2 - a, Math.PI / 2 + a, false);
  } else p.lineTo(u0, ySpring);
  p.lineTo(u0, y0);
  return p;
}

export function circlePath(uc: number, yc: number, r: number): THREE.Path {
  const p = new THREE.Path();
  p.absarc(uc, yc, r, 0, Math.PI * 2, false);
  return p;
}

/** Top of an opening (apex height) for a given head shape. */
export function archTop(w: number, ySpring: number, top: Top): number {
  return top === 'round' ? ySpring + w / 2 : top === 'pointed' ? ySpring + w * 0.866 : top === 'segment' ? ySpring + w / 6 : ySpring;
}

/**
 * Stepped gable outline (u, y) from y = 0: steps[0] = [half width of the wall, top of the first
 * step], ..., last = [crown half width, crown top].
 */
export function steppedOutline(s: [number, number][], yBase = 0): THREE.Vector2[] {
  const pts = [V2(-s[0][0], yBase), V2(s[0][0], yBase)];
  for (let i = 0; i < s.length; i++) {
    pts.push(V2(s[i][0], s[i][1]));
    if (i + 1 < s.length) pts.push(V2(s[i + 1][0], s[i][1]));
  }
  for (let i = s.length - 1; i >= 0; i--) {
    pts.push(V2(-s[i][0], s[i][1]));
    if (i > 0) pts.push(V2(-s[i][0], s[i - 1][1]));
  }
  return pts;
}

// ------------------------------------------------------------------------------------- facade
export type Facing = '+z' | '-z' | '+x' | '-x';

export interface WindowOpts {
  u: number;
  y0: number;
  /** top of the rectangular part (the springing line for arched heads) */
  y1: number;
  w: number;
  top?: Top;
  /** height of the transom (cross window); omit for none */
  transom?: number;
  mullion?: boolean;
  /** red / white open shutters beside the lower lights */
  shutters?: boolean;
  /** shutters on the upper lights too (attic / tower windows) */
  shuttersFull?: boolean;
  /** leaded small panes in the upper lights */
  leaded?: boolean;
  /** frame colour (default white) */
  frame?: Style;
  /** stone mullion / tracery instead of painted wood (gothic windows) */
  stoneFrame?: boolean;
  recess?: number;
}

export class Facade {
  readonly m: THREE.Matrix4;

  constructor(readonly hb: HeroBuilder, m: THREE.Matrix4, readonly depth = 0.5) {
    this.m = m;
  }

  /** Wall facing an axis; `plane` = outer face coordinate, `center` = u origin along the wall. */
  static axis(hb: HeroBuilder, facing: Facing, plane: number, center: number, depth = 0.5): Facade {
    const U = new THREE.Vector3(), W = new THREE.Vector3(), T = new THREE.Vector3();
    switch (facing) {
      case '+z': U.set(1, 0, 0); W.set(0, 0, 1); T.set(center, 0, plane); break;
      case '-z': U.set(-1, 0, 0); W.set(0, 0, -1); T.set(center, 0, plane); break;
      case '+x': U.set(0, 0, -1); W.set(1, 0, 0); T.set(plane, 0, center); break;
      default: U.set(0, 0, 1); W.set(-1, 0, 0); T.set(plane, 0, center); break;
    }
    return new Facade(hb, new THREE.Matrix4().makeBasis(U, new THREE.Vector3(0, 1, 0), W).setPosition(T), depth);
  }

  /** Wall whose outward normal is (sin a, 0, cos a), outer face at distance `dist` from (cx, cz). */
  static radial(hb: HeroBuilder, cx: number, cz: number, a: number, dist: number, depth = 0.4): Facade {
    const W = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const U = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const T = new THREE.Vector3(cx + W.x * dist, 0, cz + W.z * dist);
    return new Facade(hb, new THREE.Matrix4().makeBasis(U, new THREE.Vector3(0, 1, 0), W).setPosition(T), depth);
  }

  /** Matrix for a part at facade point (u, y, w), rotated about the facade normal by rz. */
  at(u: number, y: number, w: number, rz = 0, ry = 0, rx = 0, s = 1): THREE.Matrix4 {
    return this.m.clone().multiply(mat(u, y, w, rx, ry, rz, s));
  }

  /** Model-space point of facade coordinates. */
  point(u: number, y: number, w: number): THREE.Vector3 {
    return new THREE.Vector3(u, y, w).applyMatrix4(this.m);
  }

  /** Solid wall: outline polygon (u, y) with holes, extruded `depth` inwards from w = 0. */
  wall(outline: THREE.Vector2[], holes: THREE.Path[], style: Style = C.brick, m: HeroMat = 'brick', depth = this.depth, w0 = 0): void {
    const shape = new THREE.Shape(outline);
    shape.holes.push(...holes);
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 9 });
    g.translate(0, 0, w0 - depth);
    this.hb.add(m, g, this.m, style);
  }

  /** Box in facade coordinates. */
  box(u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, m: HeroMat, style: Style, rz = 0): void {
    const g = new THREE.BoxGeometry(Math.abs(u1 - u0), Math.abs(y1 - y0), Math.abs(w1 - w0));
    this.hb.add(m, g, this.at((u0 + u1) / 2, (y0 + y1) / 2, (w0 + w1) / 2, rz), style);
  }

  /** Flat shape (u, y) at depth w, facing outwards. */
  plate(shape: THREE.Shape, w: number, m: HeroMat, style: Style, thick = 0): void {
    const g = thick > 0 ? new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 10 }) : new THREE.ShapeGeometry(shape, 10);
    if (thick > 0) g.translate(0, 0, -thick);
    this.hb.add(m, g, this.at(0, 0, w), style);
  }

  /** Horizontal stone band / string course. */
  band(u0: number, u1: number, y: number, h = 0.25, proud = 0.07, style: Style = C.stone): void {
    this.box(u0, u1, y, y + h, -0.12, proud, 'stone', style);
  }

  /** Corner quoins at u (blocks run from the corner in direction `dir`). */
  quoins(u: number, y0: number, y1: number, dir: 1 | -1, proud = 0.03, h = 0.32): void {
    let k = 0;
    for (let y = y0; y + h * 0.6 < y1; y += h * 1.0, k++) {
      const len = k % 2 ? 0.34 : 0.62;
      const yt = Math.min(y1, y + h - 0.02);
      this.box(u, u + dir * len, y, yt, -0.05, proud, 'stone', C.stone);
    }
  }

  /** Alternating stone voussoirs around a round head (keystone on top). */
  voussoirs(uc: number, ys: number, r: number, n = 9, depth = 0.42, proud = 0.05): void {
    for (let k = 0; k < n; k++) {
      if (k % 2 === 1 && k !== (n - 1) / 2) continue;
      const a = ((k + 0.5) / n) * Math.PI;
      const rc = r + depth / 2;
      const len = ((Math.PI * r) / n) * 0.96;
      const key = k === (n - 1) / 2;
      const d = key ? depth * 1.35 : depth;
      const g = new THREE.BoxGeometry(len, key ? d : d, 0.12 + proud);
      this.hb.add('stone', g, this.at(uc + Math.cos(a) * (rc + (key ? 0.06 : 0)), ys + Math.sin(a) * (rc + (key ? 0.06 : 0)), proud / 2 - 0.06, a - Math.PI / 2), C.stone);
    }
  }

  /** Stone surround of a pointed opening: two arcs of blocks (every other block stone). */
  pointedSurround(u0: number, u1: number, ys: number, n = 6, depth = 0.3): void {
    const w = u1 - u0;
    for (const side of [0, 1]) {
      const cu = side ? u1 : u0;
      for (let k = 0; k < n; k++) {
        if (k % 2 && k !== n - 1) continue;
        const t = (k + 0.5) / n;
        const a = side ? Math.PI - (Math.PI / 3) * t : (Math.PI / 3) * t;
        const rc = w + depth / 2;
        const len = ((w * Math.PI) / 3 / n) * 0.94;
        this.hb.add('stone', new THREE.BoxGeometry(len, depth, 0.16), this.at(cu + Math.cos(a) * rc, ys + Math.sin(a) * rc, -0.04, a - Math.PI / 2), C.stone);
      }
    }
  }

  /** Stone plinth band from y0 to y1 along [u0, u1], interrupted at the given gaps. */
  plinth(u0: number, u1: number, y0: number, y1: number, gaps: [number, number][] = [], proud = 0.08): void {
    const g = gaps.slice().sort((a, b) => a[0] - b[0]);
    let u = u0;
    for (const [a, b] of g) {
      if (a > u + 0.02) this.box(u, a, y0, y1, -0.12, proud, 'stone', C.stoneGrey);
      u = Math.max(u, b);
    }
    if (u1 > u + 0.02) this.box(u, u1, y0, y1, -0.12, proud, 'stone', C.stoneGrey);
  }

  /** Painted window (or stone tracery window) inside an opening. */
  window(o: WindowOpts): void {
    const top = o.top ?? 'flat';
    const r = o.recess ?? 0.16;
    const hw = o.w / 2;
    const u0 = o.u - hw, u1 = o.u + hw;
    const frame = o.frame ?? C.white;
    const fm: HeroMat = o.stoneFrame ? 'stone' : 'detail';
    const fs = o.stoneFrame ? C.stone : frame;
    const ft = o.stoneFrame ? 0.14 : 0.09; // frame bar width
    // glass pane in the full opening outline
    const glass = new THREE.Shape(archPath(u0, u1, o.y0, o.y1, top).getPoints(10));
    this.plate(glass, -r - 0.04, 'detail', o.leaded ? C.glassLead : C.glass);
    // frame: jambs, sill, head (rectangular part)
    const wf0 = -r - 0.07, wf1 = -r + 0.05;
    this.box(u0, u0 + ft, o.y0, o.y1, wf0, wf1, fm, fs);
    this.box(u1 - ft, u1, o.y0, o.y1, wf0, wf1, fm, fs);
    this.box(u0, u1, o.y0, o.y0 + ft, wf0, wf1, fm, fs);
    if (top === 'flat') this.box(u0, u1, o.y1 - ft, o.y1, wf0, wf1, fm, fs);
    const yTop = archTop(o.w, o.y1, top);
    if (o.mullion !== false && (o.mullion || o.transom !== undefined)) this.box(o.u - ft / 2, o.u + ft / 2, o.y0, top === 'flat' ? o.y1 : yTop - 0.05, wf0, wf1, fm, fs);
    if (o.transom !== undefined) this.box(u0, u1, o.transom - ft / 2, o.transom + ft / 2, wf0, wf1, fm, fs);
    // leaded lights: thin dark bars in the upper part
    if (o.leaded) {
      const yA = o.transom ?? o.y0;
      for (let y = yA + 0.3; y < o.y1 - 0.1; y += 0.3) this.box(u0 + 0.05, u1 - 0.05, y - 0.012, y + 0.012, -r - 0.05, -r - 0.025, 'detail', C.leadBar);
    }
    // shutters (open, against the wall next to the opening)
    if (o.shutters || o.shuttersFull) {
      const yS0 = o.y0, yS1 = o.shuttersFull ? o.y1 : o.transom ?? o.y1;
      const sw = hw, sh = yS1 - yS0;
      for (const s of [-1, 1]) this.shutter(o.u + s * (hw + sw / 2 + 0.03), (yS0 + yS1) / 2, sw - 0.02, sh - 0.04);
    }
  }

  /** Red / white hourglass-painted shutter flat against the wall at (u, y) (centre). */
  shutter(u: number, y: number, sw: number, sh: number): void {
    const x = sw / 2, h = sh / 2, b = 0.07;
    // backing board (white edge)
    this.box(u - x, u + x, y - h, y + h, 0, 0.045, 'detail', C.shutterWhite);
    const tri = (pts: number[]): THREE.BufferGeometry => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const nrm: number[] = [];
      for (let i = 0; i < pts.length / 3; i++) nrm.push(0, 0, 1);
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      return g;
    };
    const X = x - b, H = h - b, z = 0;
    // top + bottom triangles red (hourglass), left + right white
    this.hb.add('detail', tri([-X, H, z, 0, 0, z, X, H, z, X, -H, z, 0, 0, z, -X, -H, z]), this.at(u, y, 0.047), C.red);
    this.hb.add('detail', tri([-X, -H, z, 0, 0, z, -X, H, z, X, H, z, 0, 0, z, X, -H, z]), this.at(u, y, 0.047), C.shutterWhite);
    // hinges
    for (const yy of [-h * 0.6, h * 0.6]) this.box(u - x - 0.02, u - x * 0.2, y + yy - 0.025, y + yy + 0.025, 0.045, 0.06, 'detail', C.iron);
  }

  /** Dark interior plane behind an opening (so it never shows the sky through the model). */
  interior(u0: number, u1: number, y0: number, y1: number, depth: number): void {
    this.box(u0, u1, y0, y1, -depth - 0.05, -depth, 'detail', C.dark);
  }

  /** Wooden door (two leaves with panels) inside an opening. */
  door(o: { u: number; y0: number; y1: number; w: number; top?: Top; style?: Style; recess?: number }): void {
    const r = o.recess ?? 0.25;
    const top = o.top ?? 'flat';
    const u0 = o.u - o.w / 2, u1 = o.u + o.w / 2;
    const st = o.style ?? C.green;
    const sh = new THREE.Shape(archPath(u0, u1, o.y0, o.y1, top).getPoints(10));
    this.plate(sh, -r, 'detail', st, 0.06);
    // panels / stiles
    this.box(o.u - 0.03, o.u + 0.03, o.y0, archTop(o.w, o.y1, top) - 0.05, -r, -r + 0.03, 'detail', C.dark);
    for (const s of [-1, 1]) {
      for (const [ya, yb] of [[0.25, 0.45], [0.55, 0.92]] as [number, number][]) {
        const H = o.y1 - o.y0;
        this.box(o.u + s * 0.12, o.u + s * (o.w / 2 - 0.12), o.y0 + H * ya, o.y0 + H * yb, -r, -r + 0.025, 'detail', st);
      }
    }
    this.box(o.u + 0.08, o.u + 0.12, o.y0 + 1.0, o.y0 + 1.06, -r, -r + 0.06, 'detail', C.gold);
  }
}

// ------------------------------------------------------------------------------------- roofs
export interface GableRoofOpts {
  /** ridge direction */
  axis: 'x' | 'z';
  from: number;
  to: number;
  /** ridge position across (z for axis x, x for axis z) */
  center: number;
  halfW: number;
  yEave: number;
  yRidge: number;
  overhang?: number;
  thick?: number;
  style?: Style;
  ridgeCap?: boolean;
}

/** Two sloping slabs meeting at the ridge (gable ends are closed by the gable walls). */
export function gableRoof(hb: HeroBuilder, o: GableRoofOpts): void {
  const dy = o.yRidge - o.yEave;
  const phi = Math.atan2(dy, o.halfW);
  const ov = o.overhang ?? 0.35;
  const t = o.thick ?? 0.22;
  const L = Math.hypot(o.halfW, dy) + ov;
  const len = Math.abs(o.to - o.from), mid = (o.from + o.to) / 2;
  const style = o.style ?? C.roof;
  for (const s of [1, -1]) {
    if (o.axis === 'x') {
      const g = new THREE.BoxGeometry(len, t, L).translate(0, -t / 2, (s * L) / 2);
      g.rotateX(s * phi);
      hb.add('roof', g, mat(mid, o.yRidge, o.center), style);
    } else {
      const g = new THREE.BoxGeometry(L, t, len).translate((s * L) / 2, -t / 2, 0);
      g.rotateZ(-s * phi);
      hb.add('roof', g, mat(o.center, o.yRidge, mid), style);
    }
  }
  if (o.ridgeCap !== false) {
    const g = o.axis === 'x' ? new THREE.BoxGeometry(len, 0.26, 0.26).rotateX(Math.PI / 4) : new THREE.BoxGeometry(0.26, 0.26, len).rotateZ(Math.PI / 4);
    hb.add('lead', g, o.axis === 'x' ? mat(mid, o.yRidge + 0.02, o.center) : mat(o.center, o.yRidge + 0.02, mid), C.leadDark);
  }
}

/** Four-sided pyramid roof over a rectangle (half sizes hx, hz). */
export function pyramidRoof(hb: HeroBuilder, cx: number, cz: number, hx: number, hz: number, yEave: number, yApex: number, m: HeroMat = 'roof', style: Style = C.roof): void {
  const g = flat(new THREE.ConeGeometry(Math.SQRT2, 1, 4, 1, false, Math.PI / 4));
  hb.add(m, g, mat(cx, (yEave + yApex) / 2, cz, 0, 0, 0, hx, yApex - yEave, hz), style);
}

// ------------------------------------------------------------------------------------- ornaments
/** Small stone obelisk (pedestal + needle + ball) standing at p. */
export function obelisk(hb: HeroBuilder, p: THREE.Vector3, h: number, base = 0.3, ball: Style | null = C.stone): void {
  hb.add('stone', new THREE.BoxGeometry(base, base * 0.8, base), mat(p.x, p.y + base * 0.4, p.z), C.stone);
  const needle = flat(new THREE.ConeGeometry(base * 0.36 * Math.SQRT2, h - base * 0.8, 4, 1, false, Math.PI / 4));
  hb.add('stone', needle, mat(p.x, p.y + base * 0.8 + (h - base * 0.8) / 2, p.z), C.stone);
  if (ball) hb.add(ball === C.stone ? 'stone' : 'detail', new THREE.SphereGeometry(base * 0.22, 8, 6), mat(p.x, p.y + h + base * 0.12, p.z), ball);
}

/** Clock face facing +z of `m` (dial centre at the origin of m). */
export function clockFace(hb: HeroBuilder, m: THREE.Matrix4, r: number, hour = 10, minute = 9): void {
  const at = (x: number, y: number, z: number, rz = 0) => m.clone().multiply(mat(x, y, z, 0, 0, rz));
  hb.add('stone', new THREE.TorusGeometry(r + 0.1, 0.12, 5, 32), at(0, 0, 0.04), C.stone, 'keep');
  hb.add('detail', new THREE.CircleGeometry(r, 32), at(0, 0, 0.06), C.dial, 'keep');
  hb.add('detail', new THREE.RingGeometry(r * 0.93, r * 0.99, 32), at(0, 0, 0.065), C.gold, 'keep');
  hb.add('detail', new THREE.RingGeometry(r * 0.66, r * 0.69, 32), at(0, 0, 0.065), C.gold, 'keep');
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const big = k % 3 === 0;
    hb.add('detail', new THREE.BoxGeometry(big ? 0.09 : 0.05, r * 0.2, 0.02), at(Math.sin(a) * r * 0.8, Math.cos(a) * r * 0.8, 0.07, -a), C.gold);
  }
  const ha = -((hour % 12) + minute / 60) / 12 * Math.PI * 2;
  const ma = -(minute / 60) * Math.PI * 2;
  hb.add('detail', new THREE.BoxGeometry(0.08, r * 0.52, 0.02).translate(0, r * 0.22, 0), at(0, 0, 0.085, ha), C.gold);
  hb.add('detail', new THREE.BoxGeometry(0.05, r * 0.82, 0.02).translate(0, r * 0.36, 0), at(0, 0, 0.1, ma), C.gold);
  hb.add('detail', new THREE.CylinderGeometry(0.07, 0.07, 0.06, 10).rotateX(Math.PI / 2), at(0, 0, 0.1), C.gold, 'keep');
}

/** Bronze bell (mouth at y = 0, height h). */
export function bell(h: number): THREE.BufferGeometry {
  const prof: [number, number][] = [[0.0, 1.0], [0.3, 1.0], [0.36, 0.92], [0.38, 0.6], [0.44, 0.3], [0.56, 0.08], [0.6, 0.0], [0.5, 0.02]];
  return new THREE.LatheGeometry(prof.map(([r, y]) => V2(r * h, y * h)), 12);
}

/** Alkmaar arms: white castle on a red shield, on a stone tablet (shape in facade u/y). */
export function cityArms(f: Facade, u: number, y: number, s: number): void {
  // stone tablet with a moulded frame
  f.box(u - 0.95 * s, u + 0.95 * s, y - 1.05 * s, y + 1.05 * s, -0.05, 0.1, 'stone', C.stone);
  f.box(u - 1.08 * s, u + 1.08 * s, y + 1.05 * s, y + 1.2 * s, -0.05, 0.16, 'stone', C.stone);
  f.box(u - 1.08 * s, u + 1.08 * s, y - 1.2 * s, y - 1.05 * s, -0.05, 0.16, 'stone', C.stone);
  const sh = new THREE.Shape();
  sh.moveTo(u - 0.6 * s, y + 0.75 * s);
  sh.lineTo(u + 0.6 * s, y + 0.75 * s);
  sh.lineTo(u + 0.6 * s, y - 0.1 * s);
  sh.quadraticCurveTo(u + 0.58 * s, y - 0.7 * s, u, y - 0.85 * s);
  sh.quadraticCurveTo(u - 0.58 * s, y - 0.7 * s, u - 0.6 * s, y - 0.1 * s);
  sh.lineTo(u - 0.6 * s, y + 0.75 * s);
  f.plate(sh, 0.13, 'detail', C.red, 0.03);
  // castle: wall with gate and three towers
  const W = (a: number, b: number, c: number, d: number) => f.box(u + a * s, u + b * s, y + c * s, y + d * s, 0.13, 0.15, 'detail', C.shutterWhite);
  W(-0.42, 0.42, -0.4, 0.05);
  W(-0.42, -0.24, 0.05, 0.42);
  W(-0.1, 0.1, 0.05, 0.55);
  W(0.24, 0.42, 0.05, 0.42);
  f.box(u - 0.09 * s, u + 0.09 * s, y - 0.4 * s, y - 0.14 * s, 0.15, 0.155, 'detail', C.red);
  // gilded crown on top
  f.box(u - 0.45 * s, u + 0.45 * s, y + 0.8 * s, y + 0.95 * s, 0.1, 0.16, 'detail', C.gold);
}

// ------------------------------------------------------------------------------------- openings
/** Collision box in model coordinates (centre + half extents, base at y = 0). */
export interface HeroBox { c: THREE.Vector3; h: THREE.Vector3 }
export interface HeroBuildingModel extends HeroModel { colliders: HeroBox[] }

export interface Op extends WindowOpts {
  kind?: 'win' | 'door' | 'open' | 'oculus';
  /** oculus radius (y0 = centre height) */
  r?: number;
  doorStyle?: Style;
  /** interior depth for 'open' */
  deep?: number;
}

export function holesOf(ops: Op[]): THREE.Path[] {
  return ops.map((o) => (o.kind === 'oculus' ? circlePath(o.u, o.y0, o.r ?? 0.4) : archPath(o.u - o.w / 2, o.u + o.w / 2, o.y0, o.y1, o.top ?? 'flat')));
}

/** Window / door / arch contents plus their stone dressings. */
export function dress(f: Facade, ops: Op[]): void {
  for (const o of ops) {
    const hw = o.w / 2;
    const top: Top = o.top ?? 'flat';
    if (o.kind === 'oculus') {
      const r = o.r ?? 0.4;
      const sh = new THREE.Shape(circlePath(o.u, o.y0, r).getPoints(16));
      f.plate(sh, -0.2, 'detail', C.glassLead);
      f.hb.add('stone', new THREE.TorusGeometry(r + 0.08, 0.1, 5, 20), f.at(o.u, o.y0, 0.0), C.stone, 'keep');
      for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) f.box(o.u - 0.1, o.u + 0.1, o.y0 + r + 0.05, o.y0 + r + 0.3, -0.05, 0.06, 'stone', C.stone, a);
      continue;
    }
    if (o.kind === 'door') f.door({ u: o.u, y0: o.y0, y1: o.y1, w: o.w, top, style: o.doorStyle });
    else if (o.kind === 'open') f.interior(o.u - hw - 0.1, o.u + hw + 0.1, o.y0 - 0.1, archTop(o.w, o.y1, top) + 0.1, o.deep ?? 2.5);
    else f.window(o);
    // stone dressings
    if (top === 'round') {
      const n = o.w > 2.2 ? 13 : o.w > 1.2 ? 11 : 7;
      f.voussoirs(o.u, o.y1, hw, n, o.w > 2 ? 0.5 : 0.36);
      // impost blocks
      for (const s of [-1, 1]) f.box(o.u + s * hw, o.u + s * (hw + 0.32), o.y1 - 0.3, o.y1, -0.06, 0.07, 'stone', C.stone);
    } else if (top === 'pointed') f.pointedSurround(o.u - hw, o.u + hw, o.y1, 6, 0.28);
    else {
      f.box(o.u - hw - 0.16, o.u + hw + 0.16, o.y1, o.y1 + 0.3, -0.08, 0.05, 'stone', C.stone); // lintel
      f.box(o.u - 0.13, o.u + 0.13, o.y1 + 0.02, o.y1 + 0.4, -0.08, 0.08, 'stone', C.stone); // keystone
    }
    if (o.kind !== 'door' && o.kind !== 'open') f.box(o.u - hw - 0.1, o.u + hw + 0.1, o.y0 - 0.14, o.y0, -0.22, 0.09, 'stone', C.stone); // sill
  }
}

