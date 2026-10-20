// GLB writer (glTF 2.0 binary via @gltf-transform/core). Material name = MaterialClass with a flat
// debug colour; the runtime substitutes the real material (ARCHITECTURE 4.1).
import { Document, NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';

export const DEBUG_COLORS = {
  asphalt: [0.18, 0.18, 0.19], klinkers: [0.55, 0.27, 0.2], sidewalk: [0.62, 0.62, 0.6], square: [0.6, 0.5, 0.42],
  curb: [0.78, 0.78, 0.76], bikelane: [0.62, 0.17, 0.14], grass: [0.3, 0.5, 0.2], water: [0.15, 0.3, 0.4],
  quay: [0.45, 0.25, 0.18], quay_cap: [0.7, 0.7, 0.68], bridge_deck: [0.35, 0.33, 0.3], bridge_side: [0.5, 0.28, 0.2],
  bridge_rail: [0.1, 0.15, 0.12], road_marking: [0.95, 0.95, 0.95], parking: [0.3, 0.3, 0.32], canal_bed: [0.15, 0.13, 0.1],
  ground: [0.45, 0.4, 0.33],
};

/**
 * @param {string} file
 * @param {Array<{name:string, prims:Array<[string, import('./mesh.mjs').MeshBuilder]>}>} nodes
 */
export async function writeGlb(file, nodes) {
  const doc = new Document();
  doc.createBuffer();
  const buffer = doc.getRoot().listBuffers()[0];
  const scene = doc.createScene('ground');
  const mats = new Map();
  const mat = (name) => {
    let m = mats.get(name);
    if (!m) {
      const c = DEBUG_COLORS[name] ?? [1, 0, 1];
      m = doc.createMaterial(name).setBaseColorFactor([c[0], c[1], c[2], 1]).setRoughnessFactor(1).setMetallicFactor(0);
      mats.set(name, m);
    }
    return m;
  };
  let tris = 0;
  for (const nd of nodes) {
    const prims = nd.prims.filter(([, b]) => b.idx.length);
    if (!prims.length) continue;
    const mesh = doc.createMesh(nd.name);
    for (const [name, b] of prims) {
      const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.pos)).setBuffer(buffer);
      const nrm = doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.nrm)).setBuffer(buffer);
      const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array(b.uv)).setBuffer(buffer);
      const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(b.idx)).setBuffer(buffer);
      const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setAttribute('TEXCOORD_0', uv)
        .setIndices(idx).setMaterial(mat(name));
      mesh.addPrimitive(prim);
      tris += b.idx.length / 3;
    }
    scene.addChild(doc.createNode(nd.name).setMesh(mesh));
  }
  const bin = await new NodeIO().writeBinary(doc);
  writeFileSync(file, bin);
  return { bytes: bin.byteLength, tris };
}
