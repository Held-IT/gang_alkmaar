// Instanced rendering of every traffic car (moving AI cars and parked cars).
//
// Per car spec and LOD (1 = near, 2 = far) there is one bucket: an InstancedMesh per merged part
// (body, detail, lights, decal) sharing ONE instanceMatrix attribute, plus one InstancedMesh for
// the wheels (4 instances per car). The body is tinted per car with instanceColor; the lights part
// uses a traffic-specific copy of the car lights shader that reads a per-instance light bitmask
// (running / brake / indicators / head / reverse), so brake lights and blinkers cost no extra draw
// calls. Buckets are refilled every frame by the caller (begin -> push* -> end).
import * as THREE from 'three';
import { getMergedGeometries, preloadCarModels } from '../vehicle/models';
import { getSpec } from '../vehicle/specs';

export const LIGHT_RUNNING = 1;
export const LIGHT_BRAKE = 2;
export const LIGHT_IND_L = 4;
export const LIGHT_IND_R = 8;
export const LIGHT_HEAD = 16;
export const LIGHT_REVERSE = 32;

/** Spec mix of Dutch city traffic (weights). */
export const TRAFFIC_MIX: { id: string; w: number; parkedW: number }[] = [
  { id: 'hatchback', w: 30, parkedW: 30 },
  { id: 'stadsauto', w: 22, parkedW: 26 },
  { id: 'stationwagen', w: 17, parkedW: 18 },
  { id: 'ev', w: 10, parkedW: 9 },
  { id: 'sedan', w: 8, parkedW: 7 },
  { id: 'bestelbus', w: 9, parkedW: 8 },
  { id: 'taxi', w: 3, parkedW: 0.6 },
];

/** Typical Dutch car colours (sRGB hex, weight). Grey/black/white/blue dominate. */
const PALETTE: [string, number][] = [
  ['#6f757b', 10], ['#4a4f55', 8], ['#9aa0a6', 6], ['#5d6166', 4],
  ['#141518', 11], ['#24272b', 7],
  ['#e9ebec', 10], ['#f4f4f2', 6],
  ['#bfc4c8', 8],
  ['#1d2b45', 7], ['#2d4566', 5], ['#3f5a6b', 4], ['#24324a', 3],
  ['#8f1a1f', 4], ['#6b1d22', 2],
  ['#5c6b5a', 2], ['#7a6a55', 1.5], ['#c9b48a', 0.8], ['#2f4a3a', 1.5], ['#d8c24a', 0.5], ['#b85a25', 0.5],
];
const VAN_PALETTE: [string, number][] = [
  ['#f2f2f0', 14], ['#e3e5e6', 6], ['#bfc4c8', 4], ['#9ea4a8', 3], ['#25476b', 2], ['#1e1f22', 2], ['#c22a2a', 0.6],
];
const TAXI_PALETTE: [string, number][] = [['#0e0f11', 6], ['#16181b', 3], ['#22262b', 2]];

function toLinear(pal: [string, number][]): { cols: THREE.Color[]; cum: number[] } {
  const cols: THREE.Color[] = [];
  const cum: number[] = [];
  let acc = 0;
  for (const [hex, w] of pal) {
    cols.push(new THREE.Color(hex));
    acc += w;
    cum.push(acc);
  }
  return { cols, cum };
}
const PAL = toLinear(PALETTE);
const PAL_VAN = toLinear(VAN_PALETTE);
const PAL_TAXI = toLinear(TAXI_PALETTE);

/** Picks a paint colour (linear) for a spec using u in [0,1); writes into out. */
export function pickPaint(specId: string, u: number, out: THREE.Color): THREE.Color {
  const p = specId === 'bestelbus' ? PAL_VAN : specId === 'taxi' ? PAL_TAXI : PAL;
  const t = u * p.cum[p.cum.length - 1];
  let i = 0;
  while (i < p.cum.length - 1 && p.cum[i] <= t) i++;
  return out.copy(p.cols[i]);
}

const LIGHT_COLORS = [
  new THREE.Color(0, 0, 0),
  new THREE.Color(0.85, 0.92, 1.0), // DRL
  new THREE.Color(0.9, 0.95, 1.0), // head
  new THREE.Color(1.0, 0.02, 0.01), // tail
  new THREE.Color(1.0, 0.0, 0.0), // brake
  new THREE.Color(1.0, 0.36, 0.0), // indicator L
  new THREE.Color(1.0, 0.36, 0.0), // indicator R
  new THREE.Color(1.0, 1.0, 1.0), // reverse
];

/** Car lights shader with a per-instance light bitmask attribute `aLight` (see LIGHT_*). */
function createTrafficLightsMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0 });
  m.name = 'traffic-car-lights';
  const uLightCol = { value: LIGHT_COLORS };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLightCol = uLightCol;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float lightCh;
attribute float aLight;
uniform vec3 uLightCol[8];
varying vec3 vLightEm;
varying float vLv;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  float b = aLight;
  float running = mod(b, 2.0); b = floor(b * 0.5);
  float brake = mod(b, 2.0); b = floor(b * 0.5);
  float indL = mod(b, 2.0); b = floor(b * 0.5);
  float indR = mod(b, 2.0); b = floor(b * 0.5);
  float head = mod(b, 2.0); b = floor(b * 0.5);
  float rev = mod(b, 2.0);
  int ch = int(lightCh + 0.5);
  float lv = 0.0;
  if (ch == 1) lv = running * 6.0;
  else if (ch == 2) lv = head * 22.0;
  else if (ch == 3) lv = head * 1.6 + brake * 0.6;
  else if (ch == 4) lv = brake * 4.5;
  else if (ch == 5) lv = indL * 14.0;
  else if (ch == 6) lv = indR * 14.0;
  else if (ch == 7) lv = rev * 8.0;
  vLv = lv;
  vLightEm = uLightCol[ch] * lv;
}`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLightEm;\nvarying float vLv;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += vLightEm;
  diffuseColor.rgb *= 1.0 / ( 1.0 + vLv * 0.5 );`,
      );
  };
  m.customProgramCacheKey = () => 'traffic-car-lights-v1';
  return m;
}

interface Bucket {
  specIdx: number;
  lod: 1 | 2;
  capacity: number;
  count: number;
  matrix: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute;
  light: THREE.InstancedBufferAttribute;
  wheelMatrix: THREE.InstancedBufferAttribute;
  meshes: THREE.InstancedMesh[];
  wheels: THREE.InstancedMesh;
  wheelCenters: THREE.Vector3[];
  overflowWarned: boolean;
  /** triangles drawn per car instance (all parts + 4 wheels) */
  tris: number;
}

export interface CarSpecInfo {
  id: string;
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  wheelbase: number;
}

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _sp = new THREE.Sphere();

export class CarRenderer {
  readonly root = new THREE.Group();
  readonly specs: CarSpecInfo[];
  private readonly buckets: Bucket[][] = [];
  private readonly lightsMat = createTrafficLightsMaterial();
  readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  readonly camPos = new THREE.Vector3();
  drawnInstances = 0;
  drawnTriangles = 0;
  dropped = 0;
  /** While set (background shader warm-up), end() keeps empty meshes visible with 0 instances:
   *  three only compiles visible objects, and a 0-instance mesh draws nothing. */
  holdVisible = false;

  constructor(specIds: string[], capLod1: number, capLod2: number) {
    this.root.name = 'traffic-cars';
    preloadCarModels(specIds, [1, 2]);
    this.specs = specIds.map((id) => {
      const s = getSpec(id);
      return { id, length: s.length, width: s.width, height: s.height, wheelRadius: s.wheelRadius, wheelbase: s.wheelbase };
    });
    specIds.forEach((id, si) => {
      this.buckets.push([this.makeBucket(id, si, 1, capLod1), this.makeBucket(id, si, 2, capLod2)]);
    });
  }

  private makeBucket(id: string, specIdx: number, lod: 1 | 2, cap: number): Bucket {
    const merged = getMergedGeometries(id, lod);
    const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    matrix.setUsage(THREE.DynamicDrawUsage);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    color.setUsage(THREE.DynamicDrawUsage);
    const light = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    light.setUsage(THREE.DynamicDrawUsage);
    const meshes: THREE.InstancedMesh[] = [];
    for (const part of merged.parts) {
      if (part.name === 'glass') continue;
      let geo = part.geometry;
      let mat = part.material;
      if (part.name === 'lights') {
        // reference-copy of the shared geometry with our per-instance light attribute
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(part.geometry.attributes)) g.setAttribute(name, attr);
        g.setIndex(part.geometry.index);
        g.setAttribute('aLight', light);
        if (!g.getAttribute('lightCh')) {
          console.warn('[traffic] lights geometry has no lightCh attribute; using shared material');
        } else {
          geo = g;
          mat = this.lightsMat;
        }
      }
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix = matrix;
      if (part.name === 'body') mesh.instanceColor = color;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = part.name === 'body' || (lod === 1 && part.name === 'detail');
      mesh.receiveShadow = part.name === 'body' || part.name === 'detail';
      mesh.name = `traffic_${id}_lod${lod}_${part.name}`;
      mesh.visible = false;
      this.root.add(mesh);
      meshes.push(mesh);
    }
    const wheelMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4 * 16), 16);
    wheelMatrix.setUsage(THREE.DynamicDrawUsage);
    const wheels = new THREE.InstancedMesh(merged.wheel.geometry, merged.wheel.material, cap * 4);
    wheels.instanceMatrix = wheelMatrix;
    wheels.count = 0;
    wheels.frustumCulled = false;
    wheels.castShadow = lod === 1;
    wheels.receiveShadow = true;
    wheels.visible = false;
    wheels.name = `traffic_${id}_lod${lod}_wheels`;
    this.root.add(wheels);
    return {
      specIdx, lod, capacity: cap, count: 0, matrix, color, light, wheelMatrix, meshes, wheels,
      wheelCenters: merged.wheelCenters.map((v) => v.clone()), overflowWarned: false,
      tris: meshes.reduce((a, m) => a + triCount(m.geometry), 0) + 4 * triCount(merged.wheel.geometry),
    };
  }

  /** Call once per frame before pushing instances. */
  begin(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const row of this.buckets) for (const b of row) b.count = 0;
    this.drawnInstances = 0;
    this.drawnTriangles = 0;
    this.dropped = 0;
  }

  /** Sphere-in-frustum test (with margin for shadows). */
  visible(x: number, y: number, z: number, r: number): boolean {
    _sp.center.set(x, y, z);
    _sp.radius = r;
    return this.frustum.intersectsSphere(_sp);
  }

  /**
   * Adds a car instance. `m` = column-major 4x4 world matrix of the car origin. `steer` (rad,
   * +left) turns the front wheels, `spin` (rad) rolls all wheels. Returns false when the bucket is full.
   */
  push(specIdx: number, lod: 1 | 2, m: ArrayLike<number>, mo: number, color: THREE.Color, lights: number, steer: number, spin: number): boolean {
    const b = this.buckets[specIdx][lod - 1];
    if (b.count >= b.capacity) {
      this.dropped++;
      if (!b.overflowWarned) {
        b.overflowWarned = true;
        console.info(`[traffic] instance bucket ${this.specs[specIdx].id} lod${lod} full (${b.capacity})`);
      }
      return false;
    }
    const i = b.count++;
    const arr = b.matrix.array as Float32Array;
    for (let k = 0; k < 16; k++) arr[i * 16 + k] = m[mo + k];
    const ca = b.color.array as Float32Array;
    ca[i * 3] = color.r;
    ca[i * 3 + 1] = color.g;
    ca[i * 3 + 2] = color.b;
    (b.light.array as Float32Array)[i] = lights;
    _m.fromArray(m as number[], mo);
    const wa = b.wheelMatrix.array as Float32Array;
    for (let w = 0; w < 4; w++) {
      const right = (w & 1) === 1;
      const front = w < 2;
      _w.makeRotationY((front ? steer : 0) + (right ? Math.PI : 0));
      _r.makeRotationX(right ? -spin : spin);
      _w.multiply(_r);
      const c = b.wheelCenters[w];
      _w.setPosition(c.x, c.y, c.z);
      _w.premultiply(_m);
      _w.toArray(wa, (i * 4 + w) * 16);
    }
    this.drawnInstances++;
    this.drawnTriangles += b.tris;
    return true;
  }

  /** Uploads this frame's instances. */
  end(): void {
    for (const row of this.buckets) {
      for (const b of row) {
        const n = b.count;
        for (const mesh of b.meshes) {
          mesh.count = n;
          mesh.visible = n > 0 || this.holdVisible;
        }
        b.wheels.count = n * 4;
        b.wheels.visible = n > 0 || this.holdVisible;
        if (n > 0) {
          b.matrix.clearUpdateRanges();
          b.matrix.addUpdateRange(0, n * 16);
          b.matrix.needsUpdate = true;
          b.color.clearUpdateRanges();
          b.color.addUpdateRange(0, n * 3);
          b.color.needsUpdate = true;
          b.light.clearUpdateRanges();
          b.light.addUpdateRange(0, n);
          b.light.needsUpdate = true;
          b.wheelMatrix.clearUpdateRanges();
          b.wheelMatrix.addUpdateRange(0, n * 64);
          b.wheelMatrix.needsUpdate = true;
        }
      }
    }
  }

  /**
   * Makes every bucket visible with 0 instances (part of a shader compile pass, draws nothing).
   * Sets holdVisible so end() keeps them visible until the warm-up clears it.
   */
  showAllForCompile(): void {
    this.holdVisible = true;
    for (const row of this.buckets) {
      for (const b of row) {
        for (const m of b.meshes) {
          m.count = 0;
          m.visible = true;
        }
        b.wheels.count = 0;
        b.wheels.visible = true;
      }
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const row of this.buckets) {
      for (const b of row) {
        // geometries/materials are shared caches of the car-models module: only drop instance buffers
        for (const m of b.meshes) m.dispose();
        b.wheels.dispose();
      }
    }
    this.lightsMat.dispose();
  }
}

function triCount(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}

/** Writes a car world matrix (position, heading about +y, pitch nose-up) column-major into out[o..o+15]. */
export function composeCarMatrix(out: Float32Array, o: number, x: number, y: number, z: number, heading: number, pitch: number): void {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const a = -pitch;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  out[o] = ch;
  out[o + 1] = 0;
  out[o + 2] = -sh;
  out[o + 3] = 0;
  out[o + 4] = sh * sa;
  out[o + 5] = ca;
  out[o + 6] = ch * sa;
  out[o + 7] = 0;
  out[o + 8] = sh * ca;
  out[o + 9] = -sa;
  out[o + 10] = ch * ca;
  out[o + 11] = 0;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}
