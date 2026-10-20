// Procedural low-poly people and Dutch city bikes ("omafietsen") for instanced rendering, with
// vertex-shader skeletal animation (walking, pedalling, rolling wheels, cranks).
//
// Human local frame: origin between the feet on the ground, +z forward, +x = LEFT, y up,
// height ~1.75 m. Every vertex carries aBP = (bone, part). Bones: 0 torso/head, 2 L thigh,
// 3 L shin+foot, 4 R thigh, 5 R shin+foot, 6 L upper arm, 7 L forearm+hand, 8 R upper arm,
// 9 R forearm+hand. Parts (colour slots): 0 skin, 1 top, 2 bottom, 3 shoes, 4 hair,
// 5 backpack (optional), 6 hand bag (optional), 7 long hair (optional), 8 eyes, 9 skirt/dress (optional).
// Per instance: aCol0 = (top rgb, flags), aCol1 = (bottom rgb, shoe idx), aCol2 = (skin rgb, hair idx),
// aAnim = (phase, amplitude, mode 0 walk / 1 ride / 2..3 walk + startled arms, bag idx). flags: 1 backpack, 2 hand bag, 4 long hair, 8 skirt.
//
// Bike local frame: origin on the ground between the axles, +z forward. aBP = (bone, part):
// bones 0 frame, 1 front wheel, 2 rear wheel, 3 crank + pedals; parts 0 frame colour, 1 rubber,
// 2 metal, 3 saddle/grips, 4 dark detail. Per instance: aAnim = (wheel angle, crank angle, 0, 0),
// aFrame = frame colour.
import * as THREE from 'three';

// --------------------------------------------------------------------------------------------- builder

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  bp: number[] = [];
  idx: number[] = [];

  private v(x: number, y: number, z: number, nx: number, ny: number, nz: number, bone: number, part: number): number {
    this.pos.push(x, y, z);
    const l = Math.hypot(nx, ny, nz) || 1;
    this.nor.push(nx / l, ny / l, nz / l);
    this.bp.push(bone, part);
    return this.pos.length / 3 - 1;
  }

  /**
   * Tapered tube from a to b with elliptical cross-section (radius r * (sx, sz) in the plane
   * perpendicular to the axis). `caps` closes the ends.
   */
  tube(
    a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, seg: number, bone: number, part: number,
    sx = 1, sz = 1, caps = true,
  ): void {
    const axis = new THREE.Vector3().subVectors(b, a);
    const len = axis.length();
    axis.normalize();
    // basis: u ~ world x projected, w = axis x u
    const ref = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const u = new THREE.Vector3().crossVectors(ref, axis).cross(axis).negate().normalize();
    const w = new THREE.Vector3().crossVectors(axis, u).normalize();
    const base = this.pos.length / 3;
    const slope = (ra - rb) / Math.max(len, 1e-4);
    for (let ring = 0; ring < 2; ring++) {
      const c = ring === 0 ? a : b;
      const r = ring === 0 ? ra : rb;
      for (let i = 0; i < seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        const cx = Math.cos(t) * sx;
        const cz = Math.sin(t) * sz;
        const px = c.x + (u.x * cx + w.x * cz) * r;
        const py = c.y + (u.y * cx + w.y * cz) * r;
        const pz = c.z + (u.z * cx + w.z * cz) * r;
        const nx = (u.x * cx) / sx + (w.x * cz) / sz + axis.x * slope;
        const ny = (u.y * cx) / sx + (w.y * cz) / sz + axis.y * slope;
        const nz = (u.z * cx) / sx + (w.z * cz) / sz + axis.z * slope;
        this.v(px, py, pz, nx, ny, nz, bone, part);
      }
    }
    for (let i = 0; i < seg; i++) {
      const i0 = base + i;
      const i1 = base + ((i + 1) % seg);
      const j0 = i0 + seg;
      const j1 = i1 + seg;
      this.idx.push(i0, i1, j1, i0, j1, j0);
    }
    if (caps) {
      for (let ring = 0; ring < 2; ring++) {
        const c = ring === 0 ? a : b;
        const n = ring === 0 ? axis.clone().negate() : axis;
        const r = ring === 0 ? ra : rb;
        const cb = this.pos.length / 3;
        this.v(c.x, c.y, c.z, n.x, n.y, n.z, bone, part);
        for (let i = 0; i < seg; i++) {
          const t = (i / seg) * Math.PI * 2;
          const cx = Math.cos(t) * sx;
          const cz = Math.sin(t) * sz;
          this.v(c.x + (u.x * cx + w.x * cz) * r, c.y + (u.y * cx + w.y * cz) * r, c.z + (u.z * cx + w.z * cz) * r, n.x, n.y, n.z, bone, part);
        }
        for (let i = 0; i < seg; i++) {
          const p0 = cb + 1 + i;
          const p1 = cb + 1 + ((i + 1) % seg);
          if (ring === 0) this.idx.push(cb, p1, p0);
          else this.idx.push(cb, p0, p1);
        }
      }
    }
  }

  /**
   * Vertical loft through elliptical rings [y, rx, rz, zOffset, part] (bottom to top) with smooth
   * profile normals. Each band is emitted separately so parts get crisp colour borders, but
   * adjacent bands share ring positions (no cracks). Optional bottom/top caps.
   */
  loft(rings: [number, number, number, number, number][], seg: number, bone: number, capBottom: boolean, capTop: boolean): void {
    const n = rings.length;
    // profile slope per ring for normals
    const slope = rings.map((r, i) => {
      const a = rings[Math.max(0, i - 1)];
      const b = rings[Math.min(n - 1, i + 1)];
      const dy = Math.max(1e-3, b[0] - a[0]);
      return { sx: (b[1] - a[1]) / dy, sz: (b[2] - a[2]) / dy };
    });
    for (let i = 0; i < n - 1; i++) {
      const base = this.pos.length / 3;
      const part = rings[i][4];
      for (const k of [i, i + 1]) {
        const [y, rx, rz, zo] = rings[k];
        for (let s = 0; s < seg; s++) {
          const t = (s / seg) * Math.PI * 2;
          const cx = Math.sin(t);
          const cz = Math.cos(t);
          const rm = (rx + rz) * 0.5;
          this.v(cx * rx, y, zo + cz * rz, (cx / rx) * rm, -(cx * cx * slope[k].sx + cz * cz * slope[k].sz), (cz / rz) * rm, bone, part);
        }
      }
      for (let s = 0; s < seg; s++) {
        const a = base + s;
        const b = base + ((s + 1) % seg);
        this.idx.push(a, b, a + seg, b, b + seg, a + seg);
      }
    }
    const cap = (k: number, up: boolean) => {
      const [y, rx, rz, zo, part] = rings[k];
      const c = this.pos.length / 3;
      this.v(0, y, zo, 0, up ? 1 : -1, 0, bone, part);
      for (let s = 0; s < seg; s++) {
        const t = (s / seg) * Math.PI * 2;
        this.v(Math.sin(t) * rx, y, zo + Math.cos(t) * rz, 0, up ? 1 : -1, 0, bone, part);
      }
      for (let s = 0; s < seg; s++) {
        const a = c + 1 + s;
        const b = c + 1 + ((s + 1) % seg);
        if (up) this.idx.push(c, a, b);
        else this.idx.push(c, b, a);
      }
    };
    if (capBottom) cap(0, false);
    if (capTop) cap(n - 1, true);
  }

  /** Polyline tube through points (shared radius). */
  tubePath(pts: THREE.Vector3[], r: number, seg: number, bone: number, part: number): void {
    for (let i = 0; i < pts.length - 1; i++) this.tube(pts[i], pts[i + 1], r, r, seg, bone, part, 1, 1, false);
  }

  /** Ellipsoid (optionally a latitude band phi0..phi1, 0 = top) rotated by `tiltX` about x. */
  ellipsoid(
    c: THREE.Vector3, rx: number, ry: number, rz: number, segW: number, segH: number, bone: number, part: number,
    phi0 = 0, phi1 = Math.PI, tiltX = 0,
  ): void {
    const base = this.pos.length / 3;
    const ct = Math.cos(tiltX);
    const st = Math.sin(tiltX);
    for (let j = 0; j <= segH; j++) {
      const phi = phi0 + ((phi1 - phi0) * j) / segH;
      for (let i = 0; i <= segW; i++) {
        const th = (i / segW) * Math.PI * 2;
        const ux = Math.sin(phi) * Math.sin(th);
        const uy = Math.cos(phi);
        const uz = Math.sin(phi) * Math.cos(th);
        // scale by the radii, then tilt about x (normals use the inverse radii)
        const sy = uy * ry;
        const sz = uz * rz;
        const ny = uy / ry;
        const nz = uz / rz;
        this.v(
          c.x + ux * rx, c.y + sy * ct - sz * st, c.z + sy * st + sz * ct,
          ux / rx, ny * ct - nz * st, ny * st + nz * ct, bone, part,
        );
      }
    }
    for (let j = 0; j < segH; j++) {
      for (let i = 0; i < segW; i++) {
        const a = base + j * (segW + 1) + i;
        const b = a + segW + 1;
        this.idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }

  /** Axis-aligned box (rotated by rotX about its centre) with flat normals. */
  box(c: THREE.Vector3, sx: number, sy: number, sz: number, bone: number, part: number, rotX = 0): void {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const cr = Math.cos(rotX), sr = Math.sin(rotX);
    const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [nx, ny, nz] of faces) {
      // two tangents
      const t1 = nx !== 0 ? [0, 1, 0] : [1, 0, 0];
      const t2 = [ny * t1[2] - nz * t1[1], nz * t1[0] - nx * t1[2], nx * t1[1] - ny * t1[0]];
      const base = this.pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (nx + t1[0] * a + t2[0] * b) * hx;
        const ly = (ny + t1[1] * a + t2[1] * b) * hy;
        const lz = (nz + t1[2] * a + t2[2] * b) * hz;
        const ry = ly * cr - lz * sr;
        const rz = ly * sr + lz * cr;
        const nny = ny * cr - nz * sr;
        const nnz = ny * sr + nz * cr;
        this.v(c.x + lx, c.y + ry, c.z + rz, nx, nny, nnz, bone, part);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Torus segment (ring in the y-z plane around axis x through c), angles a0..a1. */
  ring(c: THREE.Vector3, R: number, r: number, segR: number, segT: number, bone: number, part: number, a0 = 0, a1 = Math.PI * 2, width = 1): void {
    const base = this.pos.length / 3;
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const nR = full ? segR : segR + 1;
    for (let i = 0; i < nR; i++) {
      const a = a0 + ((a1 - a0) * i) / segR;
      const cy = Math.cos(a);
      const cz = Math.sin(a);
      for (let j = 0; j < segT; j++) {
        const t = (j / segT) * Math.PI * 2;
        const ox = Math.sin(t) * r * width;
        const orr = Math.cos(t) * r;
        this.v(c.x + ox, c.y + cy * (R + orr), c.z + cz * (R + orr), Math.sin(t) / width, cy * Math.cos(t), cz * Math.cos(t), bone, part);
      }
    }
    const rings = full ? segR : segR;
    for (let i = 0; i < rings; i++) {
      const i2 = full ? (i + 1) % segR : i + 1;
      for (let j = 0; j < segT; j++) {
        const j2 = (j + 1) % segT;
        const a = base + i * segT + j;
        const b = base + i2 * segT + j;
        const c2 = base + i2 * segT + j2;
        const d = base + i * segT + j2;
        this.idx.push(a, b, c2, a, c2, d);
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aBP', new THREE.Float32BufferAttribute(this.bp, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// --------------------------------------------------------------------------------------------- human

export function buildHumanGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  for (const side of [1, -1]) {
    const L = side > 0;
    const thigh = L ? 2 : 4;
    const shin = L ? 3 : 5;
    const upper = L ? 6 : 8;
    const fore = L ? 7 : 9;
    const x = 0.095 * side;
    // legs (trousers) with knee joints so bending does not open cracks
    m.tube(V(x, 0.93, 0), V(x * 1.02, 0.49, 0.012), 0.086, 0.06, 9, thigh, 2, 1, 1.05, false);
    m.ellipsoid(V(x * 1.02, 0.495, 0.012), 0.059, 0.06, 0.062, 8, 5, shin, 2);
    m.tube(V(x * 1.02, 0.5, 0.012), V(x * 1.03, 0.1, -0.005), 0.058, 0.043, 9, shin, 2, 1, 1, false);
    // shoe: sole block + rounded toe
    m.box(V(x * 1.03, 0.04, 0.035), 0.094, 0.08, 0.24, shin, 3);
    m.ellipsoid(V(x * 1.03, 0.055, 0.14), 0.047, 0.045, 0.06, 8, 4, shin, 3, 0, Math.PI * 0.55);
    m.box(V(x * 1.03, 0.1, -0.015), 0.086, 0.06, 0.1, shin, 3);
    // arms (sleeves): shoulder ball, upper arm, elbow ball, forearm, hand
    m.ellipsoid(V(0.178 * side, 1.4, -0.005), 0.064, 0.066, 0.064, 8, 6, upper, 1);
    m.tube(V(0.19 * side, 1.41, -0.005), V(0.215 * side, 1.135, -0.02), 0.053, 0.044, 8, upper, 1, 1, 1, false);
    m.ellipsoid(V(0.215 * side, 1.135, -0.02), 0.044, 0.044, 0.044, 7, 4, fore, 1);
    m.tube(V(0.215 * side, 1.135, -0.02), V(0.222 * side, 0.885, 0.02), 0.042, 0.034, 8, fore, 1, 1, 1, false);
    m.tube(V(0.222 * side, 0.9, 0.018), V(0.223 * side, 0.87, 0.022), 0.03, 0.028, 7, fore, 0, 1, 1, false);
    m.ellipsoid(V(0.224 * side, 0.83, 0.026), 0.029, 0.062, 0.045, 7, 5, fore, 0);
    // ears
    m.ellipsoid(V(0.083 * side, 1.635, 0.0), 0.014, 0.03, 0.022, 6, 4, 0, 0);
  }
  // pelvis + torso: one continuous loft (trousers up to the belt, then the top garment)
  m.loft([
    [0.83, 0.15, 0.1, 0.0, 2],
    [0.9, 0.166, 0.11, 0.0, 2],
    [0.97, 0.16, 0.106, 0.004, 2],
    [1.0, 0.153, 0.101, 0.005, 1],
    [1.1, 0.156, 0.104, 0.01, 1],
    [1.22, 0.17, 0.113, 0.015, 1],
    [1.33, 0.177, 0.11, 0.01, 1],
    [1.4, 0.17, 0.098, 0.0, 1],
    [1.445, 0.13, 0.08, -0.005, 1],
    [1.47, 0.06, 0.05, -0.005, 1],
  ], 12, 0, true, true);
  // neck + head
  m.tube(V(0, 1.44, -0.005), V(0, 1.57, 0.005), 0.055, 0.05, 8, 0, 0, 1, 1, false);
  m.ellipsoid(V(0, 1.64, 0.012), 0.082, 0.112, 0.097, 12, 9, 0, 0);
  // eyes (dark) + brows (hair colour)
  for (const sx of [1, -1]) {
    m.ellipsoid(V(0.03 * sx, 1.648, 0.098), 0.012, 0.007, 0.006, 6, 3, 0, 8);
    m.box(V(0.031 * sx, 1.666, 0.099), 0.03, 0.007, 0.012, 0, 4);
  }
  // nose + chin hint
  m.box(V(0, 1.627, 0.11), 0.024, 0.036, 0.03, 0, 0);
  // hair cap (tilted back: hairline at the forehead, down to the nape at the back)
  m.ellipsoid(V(0, 1.648, -0.004), 0.09, 0.12, 0.106, 12, 6, 0, 4, 0, Math.PI * 0.62, -0.6);
  // optional long hair (flag 4): falls to the shoulders
  m.ellipsoid(V(0, 1.53, -0.058), 0.088, 0.14, 0.056, 10, 6, 0, 7);
  // optional skirt / dress (flag 8): A-line from the waist to just above the knee, top colour
  m.loft([
    [0.5, 0.25, 0.21, 0.0, 9],
    [0.62, 0.22, 0.17, 0.0, 9],
    [0.8, 0.185, 0.13, 0.0, 9],
    [0.94, 0.172, 0.118, 0.0, 9],
    [1.0, 0.158, 0.106, 0.005, 9],
  ], 12, 0, true, false);
  // optional backpack (flag 1)
  m.box(V(0, 1.2, -0.165), 0.27, 0.36, 0.13, 0, 5);
  m.box(V(0, 1.06, -0.15), 0.25, 0.08, 0.11, 0, 5);
  // optional hand bag / shopping bag in the right hand (flag 2)
  m.box(V(-0.235, 0.66, 0.03), 0.07, 0.3, 0.32, 9, 6);
  return m.build();
}

const HUMAN_GLSL = /* glsl */ `
attribute vec2 aBP;
attribute vec4 aCol0;
attribute vec4 aCol1;
attribute vec4 aCol2;
attribute vec4 aAnim;
vec3 hRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 hPivot(vec3 p, vec3 o, float a, float isN) { return isN > 0.5 ? hRotX(p, a) : hRotX(p - o, a) + o; }
vec3 humanXform(vec3 p, float isN) {
  float bone = aBP.x;
  float part = aBP.y;
  float flags = aCol0.w;
  float fBack = mod(flags, 2.0);
  float fHand = mod(floor(flags * 0.5), 2.0);
  float fLong = mod(floor(flags * 0.25), 2.0);
  float fSkirt = mod(floor(flags * 0.125), 2.0);
  if ((part > 4.5 && part < 5.5 && fBack < 0.5) || (part > 5.5 && part < 6.5 && fHand < 0.5) || (part > 6.5 && part < 7.5 && fLong < 0.5) || (part > 8.5 && fSkirt < 0.5)) {
    return isN > 0.5 ? p : vec3(0.0, 1.0, 0.0);
  }
  int b = int(bone + 0.5);
  bool left = (b == 2 || b == 3 || b == 6 || b == 7);
  float sx = left ? 1.0 : -1.0;
  float phi = aAnim.x + (left ? 0.0 : 3.14159265);
  float A = aAnim.y;
  bool ride = aAnim.z > 0.5 && aAnim.z < 1.5;
  // aAnim.z in 2..3: walking with a startled pose (hands up in front, dodging a car), amount z - 2
  float startle = clamp(aAnim.z - 2.0, 0.0, 1.0);
  vec3 hip = vec3(0.095 * sx, 0.9, 0.0);
  vec3 knee = vec3(0.097 * sx, 0.495, 0.012);
  vec3 sh = vec3(0.19 * sx, 1.415, -0.005);
  vec3 el = vec3(0.215 * sx, 1.135, -0.02);
  vec3 pelvis = vec3(0.0, 0.92, 0.0);
  float hipR, kneeR, shR, elR, lean;
  if (ride) {
    hipR = -(1.12 + 0.3 * sin(phi));
    kneeR = 1.3 + 0.34 * sin(phi + 1.4);
    shR = -0.72;
    elR = -0.28;
    lean = 0.16;
  } else {
    float f = 0.42 * A * sin(phi);
    hipR = -f;
    kneeR = A * (0.08 + 0.72 * pow(max(0.0, cos(phi + 0.3)), 1.5));
    shR = 0.62 * f;
    elR = -(0.22 + 0.12 * A);
    if (!left && fHand > 0.5) { shR *= 0.25; elR = -0.06; }
    lean = 0.03 * A;
    float stA = (!left && fHand > 0.5) ? startle * 0.5 : startle;
    shR = mix(shR, -1.2, stA);
    elR = mix(elR, -1.1, stA);
    lean -= 0.07 * startle;
  }
  if (b == 3 || b == 5) { p = hPivot(p, knee, kneeR, isN); p = hPivot(p, hip, hipR, isN); }
  else if (b == 2 || b == 4) { p = hPivot(p, hip, hipR, isN); }
  else if (b == 7 || b == 9) { p = hPivot(p, el, elR, isN); p = hPivot(p, sh, shR, isN); p = hPivot(p, pelvis, lean, isN); }
  else if (b == 6 || b == 8) { p = hPivot(p, sh, shR, isN); p = hPivot(p, pelvis, lean, isN); }
  else { p = hPivot(p, pelvis, lean, isN); }
  if (isN < 0.5 && !ride) p.y += A * 0.022 * (cos(2.0 * aAnim.x) - 0.5);
  return p;
}
`;

const HAIR = ['#17130f', '#2e2118', '#4f3726', '#7a5a3c', '#b8955a', '#8f8a84', '#d2cec8', '#7c3f22'];
const SHOES = ['#d9d8d4', '#18181a', '#3b2a1c', '#4b4e52'];
const BAGS = ['#1b1b1d', '#4a3020', '#22304d', '#8a2a26', '#b7a27c', '#2e4234'];

function colorArray(hex: string[]): THREE.Color[] {
  return hex.map((h) => new THREE.Color(h));
}

export function createHumanMaterials(): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const uHair = { value: colorArray(HAIR) };
  const uShoe = { value: colorArray(SHOES) };
  const uBag = { value: colorArray(BAGS) };
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0 });
  material.name = 'traffic-humans';
  material.onBeforeCompile = (sh) => {
    sh.uniforms.uHair = uHair;
    sh.uniforms.uShoe = uShoe;
    sh.uniforms.uBag = uBag;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
${HUMAN_GLSL}
uniform vec3 uHair[8];
uniform vec3 uShoe[4];
uniform vec3 uBag[6];
varying vec3 vPartCol;`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = humanXform(objectNormal, 1.0);')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed = humanXform(transformed, 0.0);
{
  float part = aBP.y;
  vec3 col = aCol2.rgb;
  if (part > 0.5 && part < 1.5) col = aCol0.rgb;
  else if (part > 1.5 && part < 2.5) col = aCol1.rgb;
  else if (part > 2.5 && part < 3.5) col = uShoe[int(aCol1.w + 0.5)];
  else if ((part > 3.5 && part < 4.5) || (part > 6.5 && part < 7.5)) col = uHair[int(aCol2.w + 0.5)];
  else if (part > 8.5) col = aCol0.rgb;
  else if (part > 7.5) col = vec3(0.03, 0.025, 0.02);
  else if (part > 4.5 && part < 6.5) col = uBag[int(aAnim.w + 0.5)];
  vPartCol = col;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPartCol;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPartCol;');
  };
  material.customProgramCacheKey = () => 'traffic-humans-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${HUMAN_GLSL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = humanXform(transformed, 0.0);');
  };
  depth.customProgramCacheKey = () => 'traffic-humans-depth-v1';
  return { material, depth };
}

// --------------------------------------------------------------------------------------------- bike

/** Geometry constants of the bike (also used to seat the rider). */
export const BIKE = {
  wheelR: 0.34,
  frontZ: 0.56,
  rearZ: -0.56,
  bb: new THREE.Vector3(0, 0.28, -0.08),
  saddle: new THREE.Vector3(0, 0.99, -0.33),
  /** rider instance offset (human hip pivot y = 0.9 sits on the saddle) */
  riderOffset: new THREE.Vector3(0, 0.12, -0.32),
};

export function buildBikeGeometry(): THREE.BufferGeometry {
  const m = new MeshBuilder();
  const R = BIKE.wheelR;
  const F = V(0, R, BIKE.frontZ);
  const Rr = V(0, R, BIKE.rearZ);
  const BB = BIKE.bb.clone();
  const H = V(0, 0.94, 0.42); // head tube top
  const Hb = V(0, 0.74, 0.46); // head tube bottom
  const ST = V(0, 0.9, -0.29); // seat tube top
  // wheels: tyre, rim, spokes, hub
  for (const [c, bone] of [[F, 1], [Rr, 2]] as [THREE.Vector3, number][]) {
    m.ring(c, R - 0.02, 0.021, 18, 5, bone, 1);
    m.ring(c, R - 0.05, 0.011, 18, 3, bone, 2, 0, Math.PI * 2, 1.6);
    for (let k = 0; k < 9; k++) {
      const a = (k / 9) * Math.PI * 2;
      const p = V(c.x, c.y + Math.cos(a) * (R - 0.055), c.z + Math.sin(a) * (R - 0.055));
      m.tube(c, p, 0.0035, 0.0035, 3, bone, 2, 1, 1, false);
    }
    m.tube(V(0.045, c.y, c.z), V(-0.045, c.y, c.z), 0.022, 0.022, 6, bone, 2, 1, 1, true);
    // mudguard (black, static)
    m.ring(c, R + 0.03, 0.028, 10, 3, 0, 4, -0.35, 1.9, 1.5);
  }
  // fix mudguard orientation for the rear wheel: second ring above covers -0.35..1.9 rad which is
  // front-top for both; good enough at street distances.
  // frame: step-through "omafiets" with twin curved tubes
  m.tubePath([H, V(0, 0.82, 0.3), V(0, 0.55, 0.06), BB], 0.019, 6, 0, 0);
  m.tubePath([Hb, V(0, 0.5, 0.3), V(0, 0.36, 0.1), BB], 0.019, 6, 0, 0);
  m.tube(H, Hb, 0.024, 0.024, 7, 0, 0, 1, 1, true);
  m.tube(BB, ST, 0.019, 0.019, 6, 0, 0, 1, 1, false);
  for (const sx of [0.05, -0.05]) {
    m.tube(V(sx * 0.6, BB.y, BB.z), V(sx, Rr.y, Rr.z), 0.011, 0.011, 4, 0, 0, 1, 1, false); // chain stay
    m.tube(V(sx * 0.4, 0.84, -0.3), V(sx, Rr.y, Rr.z), 0.011, 0.011, 4, 0, 0, 1, 1, false); // seat stay
    m.tube(V(sx * 0.6, Hb.y, Hb.z), V(sx, F.y, F.z), 0.013, 0.012, 5, 0, 0, 1, 1, false); // fork blades
  }
  // chain guard (closed "kettingkast" on the right = -x side)
  m.box(V(-0.06, 0.31, -0.33), 0.03, 0.15, 0.6, 0, 0);
  // seat post + saddle
  m.tube(ST, V(0, 0.97, -0.315), 0.013, 0.013, 5, 0, 2, 1, 1, false);
  m.box(V(0, 0.99, -0.33), 0.17, 0.06, 0.25, 0, 3);
  m.box(V(0, 0.975, -0.43), 0.2, 0.05, 0.08, 0, 3);
  // stem + swept-back handlebar + grips
  m.tube(H, V(0, 1.05, 0.39), 0.014, 0.014, 5, 0, 2, 1, 1, false);
  m.tubePath([V(0.28, 1.05, 0.22), V(0.2, 1.06, 0.36), V(0, 1.06, 0.4), V(-0.2, 1.06, 0.36), V(-0.28, 1.05, 0.22)], 0.011, 5, 0, 2);
  m.tube(V(0.28, 1.05, 0.22), V(0.29, 1.045, 0.12), 0.017, 0.017, 6, 0, 3, 1, 1, true);
  m.tube(V(-0.28, 1.05, 0.22), V(-0.29, 1.045, 0.12), 0.017, 0.017, 6, 0, 3, 1, 1, true);
  // rear rack (metal) + struts
  m.box(V(0, 0.75, -0.54), 0.15, 0.015, 0.42, 0, 2);
  for (const sx of [0.065, -0.065]) m.tube(V(sx, 0.75, -0.72), V(sx * 0.8, Rr.y + 0.02, Rr.z - 0.01), 0.006, 0.006, 3, 0, 2, 1, 1, false);
  // front lamp
  m.tube(V(0, 0.82, 0.53), V(0, 0.82, 0.6), 0.03, 0.035, 8, 0, 4, 1, 1, true);
  // crank + pedals (bone 3, rotate about the bottom bracket)
  for (const sx of [1, -1]) {
    const a = sx > 0 ? 0 : Math.PI;
    const px = V(0.1 * sx, BB.y + Math.cos(a) * 0.17, BB.z + Math.sin(a) * 0.17);
    m.tube(V(0.07 * sx, BB.y, BB.z), px, 0.012, 0.01, 4, 3, 2, 1, 1, false);
    m.box(V(0.14 * sx, px.y, px.z), 0.09, 0.025, 0.06, 3, 4);
  }
  m.tube(V(0.08, BB.y, BB.z), V(-0.08, BB.y, BB.z), 0.03, 0.03, 8, 3, 2, 1, 1, true);
  return m.build();
}

const BIKE_GLSL = /* glsl */ `
attribute vec2 aBP;
attribute vec4 aAnim;
attribute vec3 aFrame;
vec3 bRotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c); }
vec3 bikeXform(vec3 p, float isN) {
  int b = int(aBP.x + 0.5);
  vec3 o = vec3(0.0);
  float a = 0.0;
  if (b == 1) { o = vec3(0.0, ${BIKE.wheelR.toFixed(3)}, ${BIKE.frontZ.toFixed(3)}); a = aAnim.x; }
  else if (b == 2) { o = vec3(0.0, ${BIKE.wheelR.toFixed(3)}, ${BIKE.rearZ.toFixed(3)}); a = aAnim.x; }
  else if (b == 3) { o = vec3(0.0, ${BIKE.bb.y.toFixed(3)}, ${BIKE.bb.z.toFixed(3)}); a = aAnim.y; }
  else return p;
  return isN > 0.5 ? bRotX(p, a) : bRotX(p - o, a) + o;
}
`;

export function createBikeMaterials(): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.25 });
  material.name = 'traffic-bikes';
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${BIKE_GLSL}\nvarying vec3 vPartCol;\nvarying float vMetal;`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = bikeXform(objectNormal, 1.0);')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
transformed = bikeXform(transformed, 0.0);
{
  float part = aBP.y;
  vec3 col = aFrame;
  float metal = 0.35;
  if (part > 0.5 && part < 1.5) { col = vec3(0.025); metal = 0.0; }
  else if (part > 1.5 && part < 2.5) { col = vec3(0.55, 0.56, 0.58); metal = 0.9; }
  else if (part > 2.5 && part < 3.5) { col = vec3(0.06, 0.035, 0.02); metal = 0.0; }
  else if (part > 3.5) { col = vec3(0.03); metal = 0.1; }
  vPartCol = col;
  vMetal = metal;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPartCol;\nvarying float vMetal;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPartCol;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vMetal;');
  };
  material.customProgramCacheKey = () => 'traffic-bikes-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${BIKE_GLSL}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = bikeXform(transformed, 0.0);');
  };
  depth.customProgramCacheKey = () => 'traffic-bikes-depth-v1';
  return { material, depth };
}

// --------------------------------------------------------------------------------------------- palettes

function pal(hexW: [string, number][]): { cols: THREE.Color[]; cum: number[] } {
  const cols: THREE.Color[] = [];
  const cum: number[] = [];
  let a = 0;
  for (const [h, w] of hexW) {
    cols.push(new THREE.Color(h));
    a += w;
    cum.push(a);
  }
  return { cols, cum };
}
function pick(p: { cols: THREE.Color[]; cum: number[] }, u: number): THREE.Color {
  const t = u * p.cum[p.cum.length - 1];
  let i = 0;
  while (i < p.cum.length - 1 && p.cum[i] <= t) i++;
  return p.cols[i];
}

export const TOPS = pal([
  ['#1f2a44', 10], ['#1a1a1c', 12], ['#3a3d42', 8], ['#6b6e72', 6], ['#a8875e', 5], ['#4d5236', 5],
  ['#6a2430', 4], ['#e6e4df', 5], ['#8fa9c6', 4], ['#4a6283', 4], ['#a33a32', 3], ['#d9b43a', 2],
  ['#2f4a37', 4], ['#4a3226', 4], ['#c98d9a', 2], ['#7d8a96', 3], ['#c46a2c', 1.5],
]);
export const BOTTOMS = pal([
  ['#3b4b66', 14], ['#283246', 10], ['#1c1c1e', 12], ['#55585c', 6], ['#b39f7e', 5], ['#575a42', 3], ['#5a4634', 3], ['#2a2f3a', 4],
]);
export const SKINS = pal([
  ['#f1d0b5', 9], ['#e8bf9f', 9], ['#d9a785', 6], ['#c68e68', 4], ['#a8714f', 3], ['#8a5a3c', 2], ['#6b4430', 2],
]);
export const TIGHTS = pal([['#141416', 5], ['#2a2a2e', 3], ['#c9a58c', 2], ['#3a2c2a', 2]]);
export const FRAMES = pal([
  ['#141416', 14], ['#1d2a3a', 3], ['#2f3e2f', 3], ['#5a1f24', 2], ['#6b6e72', 3], ['#e6e3da', 2], ['#3a5a7a', 2], ['#7a6a4a', 1],
]);
export function pickColor(p: { cols: THREE.Color[]; cum: number[] }, u: number, out: THREE.Color): THREE.Color {
  return out.copy(pick(p, u));
}
