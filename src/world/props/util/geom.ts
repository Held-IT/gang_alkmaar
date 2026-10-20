// Geometry helpers for procedural props.
//
// MeshBuilder merges primitive geometries into ONE BufferGeometry with the per-vertex attributes
// the prop "uber" material (propMaterial.ts) understands:
//   position, normal, uv, color (vec3, linear), aRM (roughness, metalness), aPaint (0..1: how much
//   the per-instance colour applies), aEmit (emissive weight / signal slot), optional aWind (vec2).
// This lets a whole multi-material object (e.g. a bicycle) render in a single draw call.
import * as THREE from 'three';

export interface Style {
  color: THREE.ColorRepresentation;
  /** default 0.6 */
  rough?: number;
  /** default 0 */
  metal?: number;
  /** 1 = vertex colour is multiplied by the instance colour (paint), 0 = fixed colour */
  paint?: number;
  /** emissive weight (lamps) or signal slot (traffic lights: 1 red, 2 amber, 3 green) */
  emit?: number;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _c = new THREE.Color();

export type WindFn = (x: number, y: number, z: number) => [number, number];
export type ColorFn = (x: number, y: number, z: number, base: THREE.Color) => THREE.Color;

export class MeshBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private rm: number[] = [];
  private paint: number[] = [];
  private emit: number[] = [];
  private wind: number[] = [];
  private idx: number[] = [];
  private readonly withWind: boolean;
  /** optional extra float attributes: name -> item size */
  private readonly extraSpec: Record<string, number>;
  private readonly extras: Record<string, number[]> = {};

  constructor(opts: { wind?: boolean; extras?: Record<string, number> } = {}) {
    this.withWind = !!opts.wind;
    this.extraSpec = opts.extras ?? {};
    for (const k of Object.keys(this.extraSpec)) this.extras[k] = [];
  }

  private padExtras(n: number, values?: Record<string, ArrayLike<number>>): void {
    for (const [k, size] of Object.entries(this.extraSpec)) {
      const src = values?.[k];
      const dst = this.extras[k];
      for (let i = 0; i < n * size; i++) dst.push(src ? src[i] ?? 0 : 0);
    }
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /**
   * Append a geometry (indexed or not) transformed by `matrix`, coloured with `style`.
   * `windFn` (only when the builder was created with wind) gives the aWind value per vertex
   * from the transformed position. `colorFn` may modulate the colour per vertex.
   */
  add(
    geo: THREE.BufferGeometry,
    matrix: THREE.Matrix4 | null,
    style: Style,
    opts: { windFn?: WindFn; colorFn?: ColorFn; flipNormals?: boolean } = {},
  ): this {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    let nAttr = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!nAttr) {
      geo.computeVertexNormals();
      nAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
    }
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const base = this.pos.length / 3;
    if (matrix) _nm.getNormalMatrix(matrix);
    const baseColor = new THREE.Color(style.color);
    const rough = style.rough ?? 0.6;
    const metal = style.metal ?? 0;
    const paint = style.paint ?? 0;
    const emit = style.emit ?? 0;
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      _n.fromBufferAttribute(nAttr, i);
      if (matrix) {
        _v.applyMatrix4(matrix);
        _n.applyMatrix3(_nm).normalize();
      }
      if (opts.flipNormals) _n.negate();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      if (uvAttr) this.uv.push(uvAttr.getX(i), uvAttr.getY(i));
      else this.uv.push(0, 0);
      const c = opts.colorFn ? opts.colorFn(_v.x, _v.y, _v.z, _c.copy(baseColor)) : baseColor;
      this.col.push(c.r, c.g, c.b);
      this.rm.push(rough, metal);
      this.paint.push(paint);
      this.emit.push(emit);
      if (this.withWind) {
        const w = opts.windFn ? opts.windFn(_v.x, _v.y, _v.z) : [0, 0];
        this.wind.push(w[0], w[1]);
      }
    }
    this.padExtras(p.count);
    const index = geo.getIndex();
    const flip = !!matrix && matrix.determinant() < 0;
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
        if (flip) this.idx.push(base + a, base + c, base + b);
        else this.idx.push(base + a, base + b, base + c);
      }
    } else {
      for (let i = 0; i < p.count; i += 3) {
        if (flip) this.idx.push(base + i, base + i + 2, base + i + 1);
        else this.idx.push(base + i, base + i + 1, base + i + 2);
      }
    }
    return this;
  }

  /** Append raw vertices (already final) — used by generators that build their own buffers. */
  addRaw(
    positions: ArrayLike<number>,
    normals: ArrayLike<number>,
    uvs: ArrayLike<number>,
    indices: ArrayLike<number>,
    colors: ArrayLike<number>,
    style: Omit<Style, 'color'>,
    wind?: ArrayLike<number>,
    extras?: Record<string, ArrayLike<number>>,
  ): this {
    const base = this.pos.length / 3;
    const n = positions.length / 3;
    for (let i = 0; i < positions.length; i++) this.pos.push(positions[i]);
    for (let i = 0; i < normals.length; i++) this.nor.push(normals[i]);
    for (let i = 0; i < uvs.length; i++) this.uv.push(uvs[i]);
    for (let i = 0; i < colors.length; i++) this.col.push(colors[i]);
    for (let i = 0; i < n; i++) {
      this.rm.push(style.rough ?? 0.6, style.metal ?? 0);
      this.paint.push(style.paint ?? 0);
      this.emit.push(style.emit ?? 0);
      if (this.withWind) this.wind.push(wind ? wind[i * 2] : 0, wind ? wind[i * 2 + 1] : 0);
    }
    this.padExtras(n, extras);
    for (let i = 0; i < indices.length; i++) this.idx.push(base + indices[i]);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aRM', new THREE.Float32BufferAttribute(this.rm, 2));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 1));
    g.setAttribute('aEmit', new THREE.Float32BufferAttribute(this.emit, 1));
    if (this.withWind) g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.wind, 2));
    for (const [k, size] of Object.entries(this.extraSpec)) g.setAttribute(k, new THREE.Float32BufferAttribute(this.extras[k], size));
    const vc = this.pos.length / 3;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ---------------------------------------------------------------------------------------------
// Primitive helpers (all return fresh geometries)
// ---------------------------------------------------------------------------------------------

/** Matrix from position, Euler rotation (radians, XYZ order) and scale. */
export function mat(
  x = 0, y = 0, z = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = sx, sz = sx,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
}

/** Vertical cylinder with its base at y = 0. */
export function cylinder(rTop: number, rBottom: number, h: number, seg = 8, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open);
  g.translate(0, h / 2, 0);
  return g;
}

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** Lathe from a profile of [radius, y] pairs (bottom to top). */
export function lathe(profile: [number, number][], seg = 12): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg);
}

export function sphere(r: number, ws = 8, hs = 6): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, ws, hs);
}

export function torus(R: number, r: number, radialSeg = 6, tubularSeg = 24, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(R, r, radialSeg, tubularSeg, arc);
}

/** Cylinder between two points. */
export function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6, rB = r): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(rB, r, len, seg, 1, false);
  g.translate(0, len / 2, 0);
  const dir = new THREE.Vector3().subVectors(b, a).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Thin box between two points (e.g. slats, laths). `up` sets the box's local Y orientation. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, h: number, up = new THREE.Vector3(0, 1, 0)): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, h, len);
  const z = new THREE.Vector3().subVectors(b, a).normalize();
  let x = new THREE.Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-6) x = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), z);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  m.setPosition(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return g;
}

/**
 * Sweep a circular cross-section along a polyline (parallel-transport frames).
 * uv: u around the circumference (0..1), v = distance along the path in metres.
 */
export function sweep(
  path: THREE.Vector3[],
  radius: number | ((t: number, i: number) => number),
  radial = 6,
  opts: { capEnd?: boolean; capStart?: boolean } = {},
): THREE.BufferGeometry {
  const n = path.length;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const T: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  // initial normal
  const t0 = T[0];
  const ref = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let N = new THREE.Vector3().crossVectors(t0, ref).normalize();
  let dist = 0;
  const B = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      dist += path[i].distanceTo(path[i - 1]);
      const axis = new THREE.Vector3().crossVectors(T[i - 1], T[i]);
      const s = axis.length();
      if (s > 1e-6) {
        const ang = Math.atan2(s, T[i - 1].dot(T[i]));
        N = N.clone().applyAxisAngle(axis.divideScalar(s), ang);
      }
    }
    B.crossVectors(T[i], N).normalize();
    const r = typeof radius === 'number' ? radius : radius(n > 1 ? i / (n - 1) : 0, i);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      pos.push(path[i].x + dir.x * r, path[i].y + dir.y * r, path[i].z + dir.z * r);
      nor.push(dir.x, dir.y, dir.z);
      uv.push(j / radial, dist);
    }
  }
  const row = radial + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const addCap = (i: number, sign: number) => {
    const center = pos.length / 3;
    const p = path[i];
    const t = T[i];
    pos.push(p.x, p.y, p.z);
    nor.push(t.x * sign, t.y * sign, t.z * sign);
    uv.push(0.5, dist);
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + 1;
      if (sign > 0) idx.push(center, a, b);
      else idx.push(center, b, a);
    }
  };
  if (opts.capEnd) addCap(n - 1, 1);
  if (opts.capStart) addCap(0, -1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Quadratic/cubic bezier sampled into points. */
export function bezier(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3 | null, steps: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    if (p3) {
      out.push(new THREE.Vector3()
        .addScaledVector(p0, u * u * u)
        .addScaledVector(p1, 3 * u * u * t)
        .addScaledVector(p2, 3 * u * t * t)
        .addScaledVector(p3, t * t * t));
    } else {
      out.push(new THREE.Vector3()
        .addScaledVector(p0, u * u)
        .addScaledVector(p1, 2 * u * t)
        .addScaledVector(p2, t * t));
    }
  }
  return out;
}

/** Extrude a 2D shape (in the XY plane) along +Z by `depth`, centred on z = 0. */
export function extrude(shape: THREE.Shape, depth: number, curveSegments = 8, bevel = 0): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Plane quad facing +Z, centred, width w and height h. */
export function quad(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}

/** Total triangle count of an indexed geometry. */
export function triCount(g: THREE.BufferGeometry): number {
  const idx = g.getIndex();
  return idx ? idx.count / 3 : (g.getAttribute('position').count / 3);
}
