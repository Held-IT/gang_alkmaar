// PropBatch: instanced rendering of many copies of one prop with LOD levels and CPU culling.
//
// Instances are bucketed into square cells. Every update (when the camera moved / turned enough)
// the visible cells (distance + frustum test) are scanned, each instance picks its LOD level by
// distance, and its matrix (+ colour + extra attributes) is copied into the instanced buffers of
// that level. All parts (meshes) of one level share the same instanced buffers, so one upload
// serves several draw calls. Static, allocation free in the hot path.
import * as THREE from 'three';
import { hash2 } from './rng';
import { LAYER_REFLECT } from '../../../config';

export interface BatchPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  depthMaterial?: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** cast into the nearest shadow cascade only (small objects whose far-cascade shadow is sub-texel) */
  nearShadow?: boolean;
}

export interface BatchLod {
  /** this level is used while the distance to the camera is below `dist` (metres) */
  dist: number;
  parts: BatchPart[];
  /** cap on simultaneously visible instances at this level (default: all) */
  maxInstances?: number;
  /**
   * Shadow-only stand-ins (usually a coarser LOD) drawn into the sun's shadow map instead of
   * `parts`; when given, `parts` cast no shadow. They share the instance buffers of this level.
   */
  shadowParts?: BatchPart[];
  /**
   * Stand-ins drawn only in the planar water reflection (batch option `reflect`); when given,
   * `parts` stay off LAYER_REFLECT. Shadow settings of these parts are ignored.
   */
  reflectParts?: BatchPart[];
}

export interface BatchOptions {
  name: string;
  lods: BatchLod[];
  cellSize?: number;
  /** extra margin (m) added to cell boxes for the frustum test (e.g. shadows, sway) */
  margin?: number;
  /** affected by quality.propDensity */
  density?: boolean;
  /** per-instance colour (instanceColor) */
  colors?: boolean;
  /** extra per-instance float attributes (InstancedBufferAttribute on every part geometry) */
  attrs?: { name: string; itemSize: number }[];
  /** re-cull when the camera moved more than this (m). Default 1.5 */
  moveThreshold?: number;
  /** object radius at scale 1 (for the cell bounds). Default: LOD0 bounding sphere */
  radius?: number;
  /** also draw in the planar water reflection (LAYER_REFLECT): canal-side trees, boats */
  reflect?: boolean;
}

export interface CullContext {
  camPos: THREE.Vector3;
  camDir: THREE.Vector3;
  frustum: THREE.Frustum;
  /** multiplies all LOD distances (quality) */
  lodScale: number;
  density: number;
  /** force a rebuild this frame */
  force: boolean;
}

interface Cell {
  box: THREE.Box3;
  indices: Uint32Array;
}

interface LodOut {
  cap: number;
  count: number;
  matrix: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute | null;
  attrs: THREE.InstancedBufferAttribute[];
  meshes: THREE.InstancedMesh[];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();

// ---------------------------------------------------------------------------------------------
// Shadow-pass detection. three's shadow pass and main pass both cull with
// object.intersectsFrustum(frustum); the shadow pass passes the light shadow's own frustum
// (one per cascade, stable objects). Knowing those lets a mesh render ONLY into the shadow map
// (cheap shadow stand-ins) or only into the nearest cascade, without engine changes.
// ---------------------------------------------------------------------------------------------
const shadowFrustums: THREE.Frustum[] = [];
let shadowSource: THREE.LightShadow | null = null;

/** Registers the sun's shadow frustums (cascade 0 first). Cheap when unchanged; call per frame. */
export function syncShadowFrustums(light: { shadow?: THREE.LightShadow } | null | undefined): void {
  const sh = light?.shadow ?? null;
  if (sh === shadowSource) return;
  shadowSource = sh;
  shadowFrustums.length = 0;
  if (!sh) return;
  const n = Math.max(1, Math.min(8, typeof sh.getViewportCount === 'function' ? sh.getViewportCount() : 1));
  const get = sh.getFrustum as unknown as (i: number) => THREE.Frustum | undefined;
  for (let i = 0; i < n; i++) {
    const f = get.call(sh, i);
    if (f && !shadowFrustums.includes(f)) shadowFrustums.push(f);
  }
}

/** shadow-only stand-in: every cascade */
function inShadowPass(f: THREE.Frustum): boolean {
  return shadowFrustums.includes(f);
}
/** shadow-only stand-in: nearest cascade only */
function inNearShadowPass(f: THREE.Frustum): boolean {
  return shadowFrustums.length > 0 && shadowFrustums[0] === f;
}
/** regular mesh that skips the far cascade(s) */
function notInFarShadowPass(f: THREE.Frustum): boolean {
  return shadowFrustums.indexOf(f) <= 0;
}

export class PropBatch {
  readonly name: string;
  readonly group = new THREE.Group();
  private readonly opts: BatchOptions;
  private n = 0;
  private mats: number[] = [];
  private cols: number[] = [];
  private extra: number[] = [];
  private scales: number[] = [];
  private keep: number[] = [];
  // finalized arrays
  private M!: Float32Array;
  private C!: Float32Array;
  private X!: Float32Array;
  private P!: Float32Array; // x, y, z per instance
  private K!: Float32Array;
  private cells: Cell[] = [];
  private outs: LodOut[] = [];
  private extraStride = 0;
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private lastScale = -1;
  private lastDensity = -1;
  private finalized = false;
  /** number of instances drawn per LOD level after the last update */
  readonly visible: number[] = [];

  constructor(opts: BatchOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.group.name = `props:${opts.name}`;
    this.extraStride = (opts.attrs ?? []).reduce((s, a) => s + a.itemSize, 0);
  }

  get count(): number {
    return this.n;
  }

  /** Add an instance at (x, y, z) rotated about Y, uniformly or per-axis scaled. */
  add(x: number, y: number, z: number, rotY: number, scale: number | THREE.Vector3 = 1, color?: THREE.Color | null, extra?: ArrayLike<number>, keep?: number): number {
    _q.setFromAxisAngle(_up, rotY);
    if (typeof scale === 'number') _s.set(scale, scale, scale);
    else _s.copy(scale);
    _m.compose(_p.set(x, y, z), _q, _s);
    return this.addMatrix(_m, color, extra, keep);
  }

  addMatrix(m: THREE.Matrix4, color?: THREE.Color | null, extra?: ArrayLike<number>, keep?: number): number {
    if (this.finalized) throw new Error(`PropBatch ${this.name}: add after finalize`);
    const e = m.elements;
    if (keep === undefined) keep = hash2(e[12], e[14], 7);
    for (let i = 0; i < 16; i++) this.mats.push(e[i]);
    if (this.opts.colors) {
      if (color) this.cols.push(color.r, color.g, color.b);
      else this.cols.push(1, 1, 1);
    }
    for (let i = 0; i < this.extraStride; i++) this.extra.push(extra ? extra[i] ?? 0 : 0);
    const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
    this.scales.push(Math.max(sx, sy, sz));
    this.keep.push(keep);
    return this.n++;
  }

  /** Build cells and instanced meshes. Call once after all add() calls. */
  finalize(): this {
    this.finalized = true;
    const n = this.n;
    this.M = new Float32Array(this.mats);
    this.C = new Float32Array(this.cols);
    this.X = new Float32Array(this.extra);
    this.K = new Float32Array(this.keep);
    this.P = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      this.P[i * 3] = this.M[i * 16 + 12];
      this.P[i * 3 + 1] = this.M[i * 16 + 13];
      this.P[i * 3 + 2] = this.M[i * 16 + 14];
    }
    this.mats = []; this.cols = []; this.extra = []; this.keep = [];

    // object radius
    let radius = this.opts.radius ?? 0;
    if (!radius) {
      const g = this.opts.lods[0].parts[0].geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      const bs = g.boundingSphere!;
      radius = bs.radius + bs.center.length();
    }
    const margin = this.opts.margin ?? 4;

    // cells
    const cs = this.opts.cellSize ?? 48;
    const map = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(this.P[i * 3] / cs)},${Math.floor(this.P[i * 3 + 2] / cs)}`;
      let arr = map.get(key);
      if (!arr) map.set(key, (arr = []));
      arr.push(i);
    }
    for (const arr of map.values()) {
      const box = new THREE.Box3();
      for (const i of arr) {
        const r = radius * this.scales[i];
        _p.set(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]);
        box.expandByPoint(_box.min.set(_p.x - r, _p.y - r, _p.z - r));
        box.expandByPoint(_box.max.set(_p.x + r, _p.y + r, _p.z + r));
      }
      box.expandByScalar(margin);
      this.cells.push({ box, indices: new Uint32Array(arr) });
    }
    this.scales = [];

    // outputs per LOD
    for (const lod of this.opts.lods) {
      const cap = Math.max(1, Math.min(n, lod.maxInstances ?? n));
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      const color = this.opts.colors ? new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3) : null;
      color?.setUsage(THREE.DynamicDrawUsage);
      const attrs: THREE.InstancedBufferAttribute[] = [];
      for (const a of this.opts.attrs ?? []) {
        const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * a.itemSize), a.itemSize);
        attr.setUsage(THREE.DynamicDrawUsage);
        attrs.push(attr);
      }
      const meshes: THREE.InstancedMesh[] = [];
      const reflect = !!this.opts.reflect;
      const mk = (part: BatchPart, kind: 'main' | 'shadow' | 'reflect', mainLayers: 'both' | 'main'): void => {
        let geo = part.geometry;
        if (attrs.length) {
          geo = geo.clone();
          (this.opts.attrs ?? []).forEach((a, k) => geo.setAttribute(a.name, attrs[k]));
        }
        const mesh = new THREE.InstancedMesh(geo, part.material, 0);
        mesh.instanceMatrix = matrix;
        if (color) mesh.instanceColor = color;
        mesh.count = 0;
        mesh.frustumCulled = false; // the batch culls per cell on the CPU
        if (part.depthMaterial) mesh.customDepthMaterial = part.depthMaterial;
        if (kind === 'shadow') {
          mesh.castShadow = true;
          // never drawn in a colour pass; same flag as the main parts so renderer.compile()
          // (shader warm-up) does not build an extra, unused program variant for it
          mesh.receiveShadow = part.receiveShadow !== false;
          mesh.frustumCulled = true;
          mesh.intersectsFrustum = part.nearShadow ? inNearShadowPass : inShadowPass;
        } else if (kind === 'reflect') {
          mesh.castShadow = false;
          mesh.receiveShadow = part.receiveShadow !== false;
          mesh.layers.set(LAYER_REFLECT);
        } else {
          mesh.castShadow = !!part.castShadow;
          mesh.receiveShadow = part.receiveShadow !== false;
          if (reflect && mainLayers === 'both') mesh.layers.enable(LAYER_REFLECT);
          if (mesh.castShadow && part.nearShadow) {
            mesh.frustumCulled = true;
            mesh.intersectsFrustum = notInFarShadowPass;
          }
        }
        mesh.matrixAutoUpdate = false;
        mesh.name = `${this.name}:lod${this.outs.length}${kind === 'main' ? '' : ':' + kind}`;
        meshes.push(mesh);
        this.group.add(mesh);
      };
      const ownShadow = !!lod.shadowParts?.length;
      const ownReflect = reflect && !!lod.reflectParts?.length;
      for (const part of lod.parts) mk(ownShadow ? { ...part, castShadow: false } : part, 'main', ownReflect ? 'main' : 'both');
      if (ownShadow) for (const part of lod.shadowParts!) mk(part, 'shadow', 'main');
      if (ownReflect) for (const part of lod.reflectParts!) mk(part, 'reflect', 'main');
      this.outs.push({ cap, count: 0, matrix, color, attrs, meshes });
      this.visible.push(0);
    }
    this.group.matrixAutoUpdate = false;
    return this;
  }

  /** Re-cull and repack instances if the camera changed enough (or ctx.force). */
  update(ctx: CullContext): boolean {
    if (!this.finalized || this.n === 0) return false;
    const thr = this.opts.moveThreshold ?? 1.5;
    const density = this.opts.density ? ctx.density : 1;
    if (
      !ctx.force &&
      ctx.lodScale === this.lastScale &&
      density === this.lastDensity &&
      ctx.camPos.distanceToSquared(this.lastPos) < thr * thr &&
      ctx.camDir.dot(this.lastDir) > 0.9985
    ) return false;
    this.lastPos.copy(ctx.camPos);
    this.lastDir.copy(ctx.camDir);
    this.lastScale = ctx.lodScale;
    this.lastDensity = density;

    const lods = this.opts.lods;
    const nl = lods.length;
    const d2 = new Float64Array(nl);
    for (let l = 0; l < nl; l++) {
      const d = lods[l].dist * ctx.lodScale;
      d2[l] = d * d;
    }
    const maxD = lods[nl - 1].dist * ctx.lodScale;
    for (const o of this.outs) o.count = 0;
    const cx = ctx.camPos.x, cy = ctx.camPos.y, cz = ctx.camPos.z;
    const P = this.P, M = this.M, C = this.C, X = this.X, K = this.K;
    const stride = this.extraStride;
    const attrSpecs = this.opts.attrs ?? [];

    for (const cell of this.cells) {
      if (cell.box.distanceToPoint(ctx.camPos) > maxD) continue;
      if (!ctx.frustum.intersectsBox(cell.box)) continue;
      const idx = cell.indices;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (K[i] >= density) continue;
        const dx = P[i * 3] - cx, dy = P[i * 3 + 1] - cy, dz = P[i * 3 + 2] - cz;
        const dd = dx * dx + dy * dy + dz * dz;
        let l = 0;
        while (l < nl && dd >= d2[l]) l++;
        // full levels spill over to the next coarser level
        while (l < nl && this.outs[l].count >= this.outs[l].cap) l++;
        if (l >= nl) continue;
        const o = this.outs[l];
        const c = o.count++;
        o.matrix.array.set(M.subarray(i * 16, i * 16 + 16), c * 16);
        if (o.color) {
          const ca = o.color.array as Float32Array;
          ca[c * 3] = C[i * 3]; ca[c * 3 + 1] = C[i * 3 + 1]; ca[c * 3 + 2] = C[i * 3 + 2];
        }
        if (stride) {
          let off = i * stride;
          for (let a = 0; a < attrSpecs.length; a++) {
            const sz = attrSpecs[a].itemSize;
            const arr = o.attrs[a].array as Float32Array;
            for (let s = 0; s < sz; s++) arr[c * sz + s] = X[off + s];
            off += sz;
          }
        }
      }
    }
    for (let l = 0; l < nl; l++) {
      const o = this.outs[l];
      this.visible[l] = o.count;
      for (const mesh of o.meshes) {
        mesh.count = o.count;
        mesh.visible = o.count > 0;
      }
      if (o.count > 0) {
        markRange(o.matrix, o.count);
        if (o.color) markRange(o.color, o.count);
        for (const a of o.attrs) markRange(a, o.count);
      }
    }
    return true;
  }

  /** Approximate rendered triangles (camera pass) after the last update. */
  triangles(): number {
    let t = 0;
    this.outs.forEach((o, l) => {
      for (const part of this.opts.lods[l].parts) {
        const idx = part.geometry.getIndex();
        const tris = idx ? idx.count / 3 : part.geometry.getAttribute('position').count / 3;
        t += tris * o.count;
      }
    });
    return t;
  }

  /** Number of draw calls (camera pass) currently issued. */
  drawCalls(): number {
    let d = 0;
    this.outs.forEach((o, l) => { if (o.count > 0) d += this.opts.lods[l].parts.length; });
    return d;
  }

  /** World position of instance i (for colliders / debugging). */
  positionOf(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.P[i * 3], this.P[i * 3 + 1], this.P[i * 3 + 2]);
  }

  dispose(): void {
    for (const o of this.outs) for (const m of o.meshes) m.geometry.dispose();
    this.group.clear();
  }
}

function markRange(attr: THREE.InstancedBufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}
