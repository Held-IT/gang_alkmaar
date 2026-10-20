// Mesh builders: accumulate triangles per material with POSITION / NORMAL / TEXCOORD_0
// (metric UVs, ARCHITECTURE 4.1) and a separate collision soup. Triangle winding is always made
// consistent with the intended normal (front face = CCW seen from the normal side).
import earcut from 'earcut';

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
    this.n = 0;
  }

  get triCount() { return this.idx.length / 3; }

  vert(x, y, z, nx, ny, nz, u, v) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.n++;
  }

  /** Adds triangle (a,b,c) flipped if needed so its geometric normal points along (nx,ny,nz). */
  tri(a, b, c, nx, ny, nz) {
    const p = this.pos;
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const e1x = p[b * 3] - ax, e1y = p[b * 3 + 1] - ay, e1z = p[b * 3 + 2] - az;
    const e2x = p[c * 3] - ax, e2y = p[c * 3 + 1] - ay, e2z = p[c * 3 + 2] - az;
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return; // degenerate
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /**
   * Horizontal polygon (open rings) triangulated with earcut. `h` is a number or (x,z)=>y.
   * For variable heights, normals are averaged from the faces (all facing up).
   */
  addPoly(poly, h, coll = null) {
    const flat = [];
    const holes = [];
    for (let r = 0; r < poly.length; r++) {
      if (r > 0) holes.push(flat.length / 2);
      for (const p of poly[r]) flat.push(p[0], p[1]);
    }
    const tris = earcut(flat, holes.length ? holes : undefined, 2);
    if (!tris.length) return 0;
    const fn = typeof h === 'function';
    const base = this.n;
    const nv = flat.length / 2;
    for (let i = 0; i < nv; i++) {
      const x = flat[i * 2], z = flat[i * 2 + 1];
      this.vert(x, fn ? h(x, z) : h, z, 0, 1, 0, x, z);
    }
    const i0 = this.idx.length;
    for (let i = 0; i < tris.length; i += 3) this.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2], 0, 1, 0);
    if (fn) this.smoothNormals(base, this.n, i0);
    if (coll) for (let i = i0; i < this.idx.length; i += 3) coll.addTriFrom(this, this.idx[i], this.idx[i + 1], this.idx[i + 2]);
    return (this.idx.length - i0) / 3;
  }

  /** Recompute normals of vertices [v0, v1) from triangles starting at index offset i0. */
  smoothNormals(v0, v1, i0) {
    const p = this.pos, nr = this.nrm;
    for (let v = v0; v < v1; v++) nr[v * 3] = nr[v * 3 + 1] = nr[v * 3 + 2] = 0;
    for (let i = i0; i < this.idx.length; i += 3) {
      const a = this.idx[i], b = this.idx[i + 1], c = this.idx[i + 2];
      const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
      const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) { nr[v * 3] += cx; nr[v * 3 + 1] += cy; nr[v * 3 + 2] += cz; }
    }
    for (let v = v0; v < v1; v++) {
      const l = Math.hypot(nr[v * 3], nr[v * 3 + 1], nr[v * 3 + 2]);
      if (!(l > 1e-12)) { nr[v * 3] = 0; nr[v * 3 + 1] = 1; nr[v * 3 + 2] = 0; continue; }
      nr[v * 3] /= l; nr[v * 3 + 1] /= l; nr[v * 3 + 2] /= l;
    }
  }

  /**
   * Vertical wall quad from a to b (2D points) with top/bottom heights at both ends, facing the
   * horizontal direction (nx, nz). u runs along the wall from u0 (metres), v = y.
   */
  addWall(a, b, topA, topB, botA, botB, nx, nz, u0 = 0, coll = null) {
    if (topA - botA < 1e-4 && topB - botB < 1e-4) return;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-4) return;
    const i0 = this.vert(a[0], topA, a[1], nx, 0, nz, u0, topA);
    const i1 = this.vert(a[0], botA, a[1], nx, 0, nz, u0, botA);
    const i2 = this.vert(b[0], botB, b[1], nx, 0, nz, u0 + len, botB);
    const i3 = this.vert(b[0], topB, b[1], nx, 0, nz, u0 + len, topB);
    const k = this.idx.length;
    this.tri(i0, i1, i2, nx, 0, nz);
    this.tri(i0, i2, i3, nx, 0, nz);
    if (coll) for (let i = k; i < this.idx.length; i += 3) coll.addTriFrom(this, this.idx[i], this.idx[i + 1], this.idx[i + 2]);
  }

  /** Generic quad p0..p3 ([x,y,z]) with given normal and uvs ([u,v] x4). */
  addQuad(p0, p1, p2, p3, n, uvs, coll = null) {
    const ids = [p0, p1, p2, p3].map((p, i) => this.vert(p[0], p[1], p[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1]));
    const k = this.idx.length;
    this.tri(ids[0], ids[1], ids[2], n[0], n[1], n[2]);
    this.tri(ids[0], ids[2], ids[3], n[0], n[1], n[2]);
    if (coll) for (let i = k; i < this.idx.length; i += 3) coll.addTriFrom(this, this.idx[i], this.idx[i + 1], this.idx[i + 2]);
  }

  /**
   * Axis-aligned-in-plan box along segment a->b (2D), centred on the segment, width w,
   * from y0 to y1. Used for railings / posts. Ends capped.
   */
  addBeam(a, b, w, y0, y1, coll = null, uScale = 1) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (L < 1e-4) return;
    const tx = dx / L, tz = dz / L;
    const nx = -tz * (w / 2), nz = tx * (w / 2);
    const c = [
      [a[0] + nx, a[1] + nz], [b[0] + nx, b[1] + nz], [b[0] - nx, b[1] - nz], [a[0] - nx, a[1] - nz],
    ];
    const len = L * uScale;
    // sides
    const sides = [[0, 1, -tz, tx], [2, 3, tz, -tx]];
    for (const [i, j, sx, sz] of sides) {
      this.addQuad([c[i][0], y1, c[i][1]], [c[i][0], y0, c[i][1]], [c[j][0], y0, c[j][1]], [c[j][0], y1, c[j][1]], [sx, 0, sz],
        [[0, y1], [0, y0], [len, y0], [len, y1]], coll);
    }
    // top
    this.addQuad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], [0, 1, 0],
      [[c[0][0], c[0][1]], [c[1][0], c[1][1]], [c[2][0], c[2][1]], [c[3][0], c[3][1]]], coll);
    // ends
    this.addQuad([c[3][0], y1, c[3][1]], [c[3][0], y0, c[3][1]], [c[0][0], y0, c[0][1]], [c[0][0], y1, c[0][1]], [-tx, 0, -tz],
      [[0, y1], [0, y0], [w, y0], [w, y1]], coll);
    this.addQuad([c[1][0], y1, c[1][1]], [c[1][0], y0, c[1][1]], [c[2][0], y0, c[2][1]], [c[2][0], y1, c[2][1]], [tx, 0, tz],
      [[0, y1], [0, y0], [w, y0], [w, y1]], coll);
  }

  /** Append all triangles of another builder. */
  append(o) {
    const base = this.n;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.uv.push(...o.uv);
    for (const i of o.idx) this.idx.push(i + base);
    this.n += o.n;
  }
}

/** Collision triangle soup with vertex welding (1 mm). */
export class CollisionBuilder {
  constructor() {
    this.pos = [];
    this.idx = [];
    this.map = new Map();
  }

  get triCount() { return this.idx.length / 3; }

  v(x, y, z) {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
    let i = this.map.get(k);
    if (i === undefined) {
      i = this.pos.length / 3;
      this.pos.push(x, y, z);
      this.map.set(k, i);
    }
    return i;
  }

  addTriFrom(mb, a, b, c) {
    const p = mb.pos;
    const ia = this.v(p[a * 3], p[a * 3 + 1], p[a * 3 + 2]);
    const ib = this.v(p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
    const ic = this.v(p[c * 3], p[c * 3 + 1], p[c * 3 + 2]);
    if (ia === ib || ib === ic || ia === ic) return;
    this.idx.push(ia, ib, ic);
  }

  /** Binary format ARCHITECTURE 4.4. */
  toBuffer() {
    const nv = this.pos.length / 3, ni = this.idx.length;
    const ab = new ArrayBuffer(8 + nv * 12 + ni * 4);
    const head = new Uint32Array(ab, 0, 2);
    head[0] = nv;
    head[1] = ni;
    new Float32Array(ab, 8, nv * 3).set(this.pos);
    new Uint32Array(ab, 8 + nv * 12, ni).set(this.idx);
    return Buffer.from(ab);
  }
}

/** Per-chunk set of builders keyed by material class. */
export class MaterialSet {
  constructor() { this.m = new Map(); }
  get(name) {
    let b = this.m.get(name);
    if (!b) { b = new MeshBuilder(); this.m.set(name, b); }
    return b;
  }
  entries() { return [...this.m.entries()].filter(([, b]) => b.idx.length > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)); }
  get triCount() { let t = 0; for (const b of this.m.values()) t += b.triCount; return t; }
}
