// Mesh accumulation + GLB writing (glTF 2.0 via @gltf-transform/core) for the BAG pipeline.
import { Document, NodeIO } from '@gltf-transform/core';

/** Growable typed array. */
class Grow {
  constructor(Type, cap = 1024) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  push(...v) {
    if (this.n + v.length > this.a.length) {
      const b = new this.Type(Math.max(this.a.length * 2, this.n + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (let i = 0; i < v.length; i++) this.a[this.n++] = v[i];
  }
  get array() {
    return this.a.subarray(0, this.n);
  }
}

/**
 * Accumulates one primitive (one material). Every vertex has position + normal + uv0, and
 * optionally uv1 (vec2) and color (vec4 normalised ubyte, values given in 0..1).
 */
export class PrimBuilder {
  constructor({ uv1 = false, color = false } = {}) {
    this.pos = new Grow(Float32Array);
    this.nrm = new Grow(Float32Array);
    this.uv0 = new Grow(Float32Array);
    this.uv1 = uv1 ? new Grow(Float32Array) : null;
    this.col = color ? new Grow(Uint8Array) : null;
    this.idx = new Grow(Uint32Array);
    this.vcount = 0;
  }
  /** Adds a vertex, returns its index. */
  vertex(p, n, uv0, uv1, c) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv0.push(uv0[0], uv0[1]);
    if (this.uv1) this.uv1.push(uv1[0], uv1[1]);
    if (this.col) this.col.push(q8(c[0]), q8(c[1]), q8(c[2]), q8(c[3]));
    return this.vcount++;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  get triCount() {
    return this.idx.n / 3;
  }
}

const q8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Flat debug colours per material (the runtime substitutes real materials by name). */
const DEBUG_COLOR = {
  wall: [0.55, 0.25, 0.18, 1],
  roof_slanted: [0.45, 0.2, 0.12, 1],
  roof_flat: [0.25, 0.25, 0.25, 1],
  backdrop: [0.6, 0.55, 0.5, 1],
};

/**
 * Write a GLB. `nodes` = [{ name, prims: { [materialName]: PrimBuilder } }].
 * One mesh per node, one primitive per material, uint32 indices.
 */
export async function writeGlb(path, nodes) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  const mats = new Map();
  const material = (name) => {
    if (!mats.has(name)) {
      mats.set(
        name,
        doc.createMaterial(name).setBaseColorFactor(DEBUG_COLOR[name] ?? [0.5, 0.5, 0.5, 1]).setRoughnessFactor(0.9).setMetallicFactor(0),
      );
    }
    return mats.get(name);
  };
  const acc = (type, array, normalized = false) => {
    const a = doc.createAccessor().setType(type).setArray(array.slice()).setBuffer(buffer);
    if (normalized) a.setNormalized(true);
    return a;
  };
  for (const n of nodes) {
    const mesh = doc.createMesh(n.name);
    for (const [matName, pb] of Object.entries(n.prims)) {
      if (!pb || pb.triCount === 0) continue;
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', acc('VEC3', pb.pos.array))
        .setAttribute('NORMAL', acc('VEC3', pb.nrm.array))
        .setAttribute('TEXCOORD_0', acc('VEC2', pb.uv0.array))
        .setIndices(acc('SCALAR', pb.idx.array))
        .setMaterial(material(matName));
      if (pb.uv1) prim.setAttribute('TEXCOORD_1', acc('VEC2', pb.uv1.array));
      if (pb.col) prim.setAttribute('COLOR_0', acc('VEC4', pb.col.array, true));
      mesh.addPrimitive(prim);
    }
    if (mesh.listPrimitives().length === 0) continue;
    scene.addChild(doc.createNode(n.name).setMesh(mesh));
  }
  doc.getRoot().getAsset().generator = 'AlkmaarDrive tools/bag';
  await new NodeIO().write(path, doc);
}
