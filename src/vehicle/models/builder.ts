// Geometry accumulator for the procedural cars. Each material bucket of a car has one builder;
// at the end everything in a bucket becomes ONE BufferGeometry (one draw call).
//
// Optional per-vertex attributes:
//   color : linear RGB albedo multiplier (vertexColors)
//   pbr   : (roughness, metalness) read by the patched detail/wheel materials
//   lightCh : light channel index read by the lights material (see materials.ts)
import * as THREE from 'three';

export interface VertexExtras {
  color?: THREE.Color | readonly [number, number, number];
  pbr?: readonly [number, number];
  ch?: number;
}

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  pbr: number[] = [];
  ch: number[] = [];
  idx: number[] = [];
  private hasCol = false;
  private hasPbr = false;
  private hasCh = false;
  // current defaults applied by vert()
  curColor: [number, number, number] = [1, 1, 1];
  curPbr: [number, number] = [0.5, 0];
  curCh = 0;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  setColor(c: THREE.ColorRepresentation | readonly [number, number, number]): this {
    if (Array.isArray(c)) this.curColor = [c[0], c[1], c[2]];
    else {
      const k = new THREE.Color(c as THREE.ColorRepresentation);
      this.curColor = [k.r, k.g, k.b];
    }
    this.hasCol = true;
    return this;
  }
  setPbr(roughness: number, metalness: number): this {
    this.curPbr = [roughness, metalness];
    this.hasPbr = true;
    return this;
  }
  setCh(ch: number): this {
    this.curCh = ch;
    this.hasCh = true;
    return this;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.curColor[0], this.curColor[1], this.curColor[2]);
    this.pbr.push(this.curPbr[0], this.curPbr[1]);
    this.ch.push(this.curCh);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Append an existing geometry (positions, normals, optional uvs / index) transformed by m.
   * Its uvs are kept unless `uv` is given (then every vertex gets that constant uv).
   */
  addGeometry(g: THREE.BufferGeometry, m?: THREE.Matrix4, uv?: readonly [number, number]): void {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const uva = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const base = this.vertexCount;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.fromBufferAttribute(nrm, i);
      if (m) {
        v.applyMatrix4(m);
        n.applyMatrix3(nm!).normalize();
      }
      const u0 = uv ? uv[0] : uva ? uva.getX(i) : 0;
      const v0 = uv ? uv[1] : uva ? uva.getY(i) : 0;
      this.vert(v.x, v.y, v.z, n.x, n.y, n.z, u0, v0);
    }
    const flip = m ? m.determinant() < 0 : false;
    const index = g.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = base + index.getX(i);
        const b = base + index.getX(i + 1);
        const c = base + index.getX(i + 2);
        if (flip) this.tri(a, c, b);
        else this.tri(a, b, c);
      }
    } else {
      for (let i = 0; i < pos.count; i += 3) {
        if (flip) this.tri(base + i, base + i + 2, base + i + 1);
        else this.tri(base + i, base + i + 1, base + i + 2);
      }
    }
  }

  /** Append another builder's content (optionally transformed). */
  append(o: MeshBuilder, m?: THREE.Matrix4): void {
    const base = this.vertexCount;
    const v = new THREE.Vector3();
    const n = new THREE.Vector3();
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    for (let i = 0; i < o.vertexCount; i++) {
      v.set(o.pos[3 * i], o.pos[3 * i + 1], o.pos[3 * i + 2]);
      n.set(o.nrm[3 * i], o.nrm[3 * i + 1], o.nrm[3 * i + 2]);
      if (m) {
        v.applyMatrix4(m);
        n.applyMatrix3(nm!).normalize();
      }
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(o.uv[2 * i], o.uv[2 * i + 1]);
      this.col.push(o.col[3 * i], o.col[3 * i + 1], o.col[3 * i + 2]);
      this.pbr.push(o.pbr[2 * i], o.pbr[2 * i + 1]);
      this.ch.push(o.ch[i]);
    }
    const flip = m ? m.determinant() < 0 : false;
    for (let i = 0; i < o.idx.length; i += 3) {
      const a = base + o.idx[i];
      const b = base + o.idx[i + 1];
      const c = base + o.idx[i + 2];
      if (flip) this.idx.push(a, c, b);
      else this.idx.push(a, b, c);
    }
    this.hasCol ||= o.hasCol;
    this.hasPbr ||= o.hasPbr;
    this.hasCh ||= o.hasCh;
  }

  /** Mirrored copy of everything added so far across x = 0 (left -> right side), appended. */
  mirrorX(): void {
    const m = new THREE.Matrix4().makeScale(-1, 1, 1);
    const copy = new MeshBuilder();
    copy.pos = this.pos.slice();
    copy.nrm = this.nrm.slice();
    copy.uv = this.uv.slice();
    copy.col = this.col.slice();
    copy.pbr = this.pbr.slice();
    copy.ch = this.ch.slice();
    copy.idx = this.idx.slice();
    copy.hasCol = this.hasCol;
    copy.hasPbr = this.hasPbr;
    copy.hasCh = this.hasCh;
    this.append(copy, m);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.hasCol) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.hasPbr) g.setAttribute('pbr', new THREE.Float32BufferAttribute(this.pbr, 2));
    if (this.hasCh) g.setAttribute('lightCh', new THREE.Float32BufferAttribute(this.ch, 1));
    const vc = this.vertexCount;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }
}
