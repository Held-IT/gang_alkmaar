// Minimal GLB reader for the city chunk files written by tools/osm and tools/bag
// (ARCHITECTURE 4.1). Those files are simple: a few nodes without transforms, one mesh each,
// triangle primitives with POSITION / NORMAL / TEXCOORD_0 (/ TEXCOORD_1 / COLOR_0), uint32
// indices, interleaved vertex buffers, and the material NAME is the MaterialClass.
//
// Parsing them ourselves (instead of GLTFLoader) avoids creating throw-away materials and scene
// graphs, and gives tightly packed arrays that can be concatenated per material straight away.

export interface GlbPrimitive {
  /** glTF material name (= MaterialClass). */
  material: string;
  /** Name of the node that references the mesh (chunk id, e.g. "ground_10_10"). */
  node: string;
  vertexCount: number;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  uv1: Float32Array | null;
  /** RGBA, normalised unsigned bytes (converted when the file stores floats). */
  color: Uint8Array | null;
  index: Uint32Array;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
}
interface GltfBufferView { byteOffset?: number; byteLength: number; byteStride?: number }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }
interface GltfJson {
  nodes?: { name?: string; mesh?: number }[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  materials?: { name?: string }[];
  accessors: GltfAccessor[];
  bufferViews: GltfBufferView[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const GL_FLOAT = 5126;
const GL_UNSIGNED_BYTE = 5121;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Parses a .glb buffer. Throws on malformed input. */
export function parseGlb(buf: ArrayBuffer, file = 'glb'): GlbPrimitive[] {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${file}: geen GLB`);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen))) as GltfJson;
  const binHeader = 20 + jsonLen;
  const binStart = binHeader + 8;
  if (binHeader + 8 > buf.byteLength) throw new Error(`${file}: BIN-chunk ontbreekt`);

  const accessorInfo = (index: number) => {
    const acc = json.accessors[index];
    if (!acc || acc.bufferView === undefined) throw new Error(`${file}: accessor ${index} ongeldig`);
    const bv = json.bufferViews[acc.bufferView];
    const comps = COMPONENTS[acc.type] ?? 1;
    const elemBytes = BYTES[acc.componentType] ?? 4;
    const offset = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? comps * elemBytes;
    return { acc, comps, elemBytes, offset, stride };
  };

  const readFloat = (index: number): Float32Array => {
    const { acc, comps, offset, stride } = accessorInfo(index);
    if (acc.componentType !== GL_FLOAT) throw new Error(`${file}: verwacht float-attribuut`);
    const out = new Float32Array(acc.count * comps);
    if (offset % 4 === 0 && stride % 4 === 0) {
      const s = stride >> 2;
      const src = new Float32Array(buf, offset, (acc.count - 1) * s + comps);
      if (s === comps) out.set(src.subarray(0, acc.count * comps));
      else {
        for (let i = 0, o = 0, p = 0; i < acc.count; i++, p += s) {
          for (let c = 0; c < comps; c++) out[o++] = src[p + c];
        }
      }
    } else {
      for (let i = 0, o = 0; i < acc.count; i++) {
        for (let c = 0; c < comps; c++) out[o++] = dv.getFloat32(offset + i * stride + c * 4, true);
      }
    }
    return out;
  };

  const readColor = (index: number): Uint8Array => {
    const { acc, comps, offset, stride } = accessorInfo(index);
    const out = new Uint8Array(acc.count * 4);
    for (let i = 0; i < acc.count; i++) {
      const base = offset + i * stride;
      for (let c = 0; c < 4; c++) {
        let v = 255;
        if (c < comps) {
          if (acc.componentType === GL_UNSIGNED_BYTE) v = dv.getUint8(base + c);
          else if (acc.componentType === GL_FLOAT) v = Math.round(Math.min(1, Math.max(0, dv.getFloat32(base + c * 4, true))) * 255);
          else if (acc.componentType === GL_UNSIGNED_SHORT) v = dv.getUint16(base + c * 2, true) >> 8;
        }
        out[i * 4 + c] = v;
      }
    }
    return out;
  };

  const readIndices = (index: number): Uint32Array => {
    const { acc, offset, stride, elemBytes } = accessorInfo(index);
    if (acc.componentType === GL_UNSIGNED_INT && offset % 4 === 0 && stride === 4) {
      return new Uint32Array(buf.slice(offset, offset + acc.count * 4));
    }
    const out = new Uint32Array(acc.count);
    for (let i = 0; i < acc.count; i++) {
      const p = offset + i * stride;
      out[i] = elemBytes === 4 ? dv.getUint32(p, true) : elemBytes === 2 ? dv.getUint16(p, true) : dv.getUint8(p);
    }
    return out;
  };

  const out: GlbPrimitive[] = [];
  const meshes = json.meshes ?? [];
  // node name per mesh (falls back to the mesh name)
  const nodeOf = new Map<number, string>();
  for (const n of json.nodes ?? []) if (n.mesh !== undefined && !nodeOf.has(n.mesh)) nodeOf.set(n.mesh, n.name ?? '');
  meshes.forEach((mesh, mi) => {
    for (const p of mesh.primitives) {
      if (p.mode !== undefined && p.mode !== 4) continue; // triangles only
      const a = p.attributes;
      if (a.POSITION === undefined) continue;
      const position = readFloat(a.POSITION);
      const vertexCount = position.length / 3;
      let index: Uint32Array;
      if (p.indices !== undefined) index = readIndices(p.indices);
      else {
        index = new Uint32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) index[i] = i;
      }
      out.push({
        material: (p.material !== undefined ? json.materials?.[p.material]?.name : undefined) ?? 'ground',
        node: nodeOf.get(mi) ?? mesh.name ?? file,
        vertexCount,
        position,
        normal: a.NORMAL !== undefined ? readFloat(a.NORMAL) : null,
        uv: a.TEXCOORD_0 !== undefined ? readFloat(a.TEXCOORD_0) : null,
        uv1: a.TEXCOORD_1 !== undefined ? readFloat(a.TEXCOORD_1) : null,
        color: a.COLOR_0 !== undefined ? readColor(a.COLOR_0) : null,
        index,
      });
    }
  });
  return out;
}
