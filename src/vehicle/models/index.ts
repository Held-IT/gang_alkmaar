// Procedural modern European cars (fictional brands). Public API:
//   createCarModel(specId, opts)       -> CarModel (contract in src/contracts.ts) + extras (CarModelExt)
//   randomDutchPlate(kind?)            -> e.g. 'GZ-123-K' (kind 'bestel' gives V-plates)
//   getMergedGeometries(specId, lod)   -> shared geometries + base materials for traffic instancing
//   getSharedLightsMaterial(state)     -> cached lights material per light state (instanced traffic)
//   getModelStats(specId, lod)         -> triangle / draw call counts (+ per-part breakdown)
//   preloadCarModels(ids?)             -> builds the per-spec caches up front (avoids hitches)
//
// Vehicle-local axes: +z forward, +x LEFT, +y up; origin on the ground between the axles.
// Geometry, textures and shared materials are cached per spec (and per LOD); a CarModel only
// owns its paint, light and plate materials.
import * as THREE from 'three';
import type { CarLightState, CarModel, CarModelOptions, CarSpec } from '../../contracts';
import { CAR_SPECS, getSpec } from '../specs';
import { AtlasLayout } from './atlasLayout';
import { paintBodyAtlas, type BodyTextures } from './atlasPaint';
import { BodyFrame } from './body';
import { BodyMap } from './bodyMap';
import { buildBodyMesh } from './bodyMesh';
import { MeshBuilder } from './builder';
import { getDesign } from './designs';
import { buildDetails, type DetailOut } from './details';
import { buildFeatures, type Features } from './features';
import {
  CH,
  createDecalMaterial,
  createDetailMaterial,
  createGlassMaterial,
  createLightsMaterial,
  createPaintMaterial,
  createWheelMaterial,
  type LightsMaterial,
  type PaintMaterial,
} from './materials';
import { buildArchLiners, buildGlass, buildInnerShell, buildUnderbody } from './parts';
import { createPlateTexture, randomDutchPlate as randomPlate } from './plates';
import { buildWheel, type WheelGeometry } from './wheels';

export { randomPlate as randomDutchPlate };

type Lod = 0 | 1 | 2;

interface LodGeometry {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  detail: THREE.BufferGeometry;
  lights: THREE.BufferGeometry;
  decal: THREE.BufferGeometry;
  wheel: WheelGeometry;
  /** decal canvas layout: uv rectangles of the plates (front, rear) and extras */
  triangles: number;
  anchors: LightAnchors;
  /** triangle counts of the sub-builders (diagnostics) */
  breakdown: Record<string, number>;
}

/** Vehicle-local positions useful for other modules (headlight spot lights, exhaust smoke...). */
export interface LightAnchors {
  headL: THREE.Vector3;
  headR: THREE.Vector3;
  tailL: THREE.Vector3;
  tailR: THREE.Vector3;
  exhaust: THREE.Vector3[];
  /** driver eye point (for an interior / bumper camera) */
  driverEye: THREE.Vector3;
}

interface SpecCache {
  spec: CarSpec;
  frame: BodyFrame;
  map: BodyMap;
  atlas: AtlasLayout;
  features: Features;
  tex: BodyTextures;
  detailMat: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  glassMat: THREE.MeshPhysicalMaterial;
  lods: (LodGeometry | undefined)[];
  /** base materials for instancing (white paint, lights in DRL state) */
  basePaint: [PaintMaterial | undefined, PaintMaterial | undefined];
}

const cache = new Map<string, SpecCache>();
let wheelMat: THREE.MeshStandardMaterial | null = null;

function ghArcMax(f: BodyFrame): number {
  let m = 0;
  for (let i = 0; i <= 60; i++) {
    const p = f.pRearBase + ((f.pCowl - f.pRearBase) * i) / 60;
    m = Math.max(m, f.ghSection(p).len);
  }
  return m;
}

function specCache(id: string): SpecCache {
  let c = cache.get(id);
  if (!c) {
    const spec = getSpec(id);
    const frame = new BodyFrame(spec, getDesign(spec));
    const atlas = new AtlasLayout(frame, ghArcMax(frame));
    const map = new BodyMap(frame, atlas);
    const features = buildFeatures(map);
    const tex = paintBodyAtlas(map, features);
    c = {
      spec,
      frame,
      map,
      atlas,
      features,
      tex,
      detailMat: [createDetailMaterial(tex.map), createDetailMaterial(null)],
      glassMat: createGlassMaterial(tex.orm),
      lods: [],
      basePaint: [undefined, undefined],
    };
    cache.set(spec.id, c);
  }
  return c;
}

/** Remove triangles whose whole area samples as atlas cut-out (alpha 0), checked on a dense barycentric grid. */
function cullCutTriangles(mb: MeshBuilder, tex: BodyTextures): void {
  const uv = mb.uv;
  const idx = mb.idx;
  const out: number[] = [];
  const N = 8;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    let cut = true;
    for (let i = 0; i <= N && cut; i++) {
      for (let j = 0; j <= N - i; j++) {
        const wa = i / N;
        const wb = j / N;
        const wc = 1 - wa - wb;
        const u = uv[2 * a] * wa + uv[2 * b] * wb + uv[2 * c] * wc;
        const v = uv[2 * a + 1] * wa + uv[2 * b + 1] * wb + uv[2 * c + 1] * wc;
        if (tex.opaqueAt(u, v) > 0.2) {
          cut = false;
          break;
        }
      }
    }
    if (!cut) out.push(a, b, c);
  }
  mb.idx = out;
}

function lodGeometry(c: SpecCache, lod: Lod): LodGeometry {
  let g = c.lods[lod];
  if (g) return g;
  const bm = buildBodyMesh(c.frame, c.atlas, lod);
  // LOD 0 shows window / lamp / grille openings by alpha test: drop the shell triangles that lie
  // entirely inside a cut-out (no visible pixels, saves triangles and alpha-tested overdraw)
  if (lod === 0) cullCutTriangles(bm.body, c.tex);
  const breakdown: Record<string, number> = { shell: bm.body.triangleCount };
  const detail = new MeshBuilder();
  buildArchLiners(c.map, bm, detail, lod);
  buildUnderbody(c.map, bm, detail);
  detail.mirrorX();
  breakdown.linersUnderbody = detail.triangleCount;
  const det: DetailOut = buildDetails(c.map, c.features, bm, lod);
  breakdown.bodyParts = det.body.triangleCount;
  breakdown.detailParts = det.detail.triangleCount;
  breakdown.interior = det.interior.triangleCount;
  // body-coloured parts (mirror caps, handles...) go into the body bucket
  bm.body.append(det.body);
  detail.append(det.detail);
  if (lod === 0) {
    const inner = new MeshBuilder();
    buildInnerShell(c.map, bm, inner);
    inner.mirrorX();
    breakdown.innerShell = inner.triangleCount;
    detail.append(inner);
    detail.append(det.interior);
  }
  const glass = lod === 0 ? buildGlass(bm, c.tex) : null;
  if (glass) {
    breakdown.lampLenses = det.lens.triangleCount;
    glass.append(det.lens);
  }
  const wheel = buildWheel(c.spec, c.frame.d, lod);
  g = {
    body: bm.body.build(),
    glass: glass ? glass.build() : null,
    detail: detail.build(),
    lights: det.lights.build(),
    decal: det.decal.build(),
    wheel,
    triangles: 0,
    anchors: det.anchors,
    breakdown,
  };
  g.triangles =
    bm.body.triangleCount +
    (glass ? glass.triangleCount : 0) +
    detail.triangleCount +
    det.lights.triangleCount +
    det.decal.triangleCount +
    4 * wheel.triangles;
  c.lods[lod] = g;
  return g;
}

/** Build every per-spec cache now (textures, LOD geometry) so spawning a car later is cheap. */
export function preloadCarModels(ids: string[] = CAR_SPECS.map((s) => s.id), lods: Lod[] = [0, 1, 2]): void {
  for (const id of ids) {
    const c = specCache(id);
    for (const l of lods) lodGeometry(c, l);
  }
}

/** Debug: the painted body atlas textures of a spec. */
export function getAtlasTextures(id: string): { map: THREE.Texture; orm: THREE.Texture } {
  const c = specCache(id);
  return { map: c.tex.map, orm: c.tex.orm };
}

export function getModelStats(
  id: string,
  lod: Lod,
): { triangles: number; drawCalls: number; bodyTriangles: number; wheelTriangles: number; parts: Record<string, number> } {
  const c = specCache(id);
  const g = lodGeometry(c, lod);
  const idx = (x: THREE.BufferGeometry | null) => (x && x.index ? x.index.count / 3 : 0);
  const drawCalls = 1 + (g.glass ? 1 : 0) + 1 + 1 + 1 + 4 * (g.wheel.caliper ? 2 : 1);
  const parts = { body: idx(g.body), glass: idx(g.glass), detail: idx(g.detail), lights: idx(g.lights), decal: idx(g.decal), wheels4: 4 * g.wheel.triangles, ...g.breakdown };
  return { triangles: g.triangles, drawCalls, bodyTriangles: idx(g.body), wheelTriangles: g.wheel.triangles, parts };
}

export interface MergedPart {
  name: 'body' | 'glass' | 'detail' | 'lights' | 'decal';
  geometry: THREE.BufferGeometry;
  /** shared base material; paint is white so InstancedMesh.setColorAt gives each car its colour */
  material: THREE.Material;
}

/**
 * Shared, cached geometries of one spec/LOD for instanced traffic. Do not dispose them.
 * Body parts are in vehicle-local coordinates (same frame as CarModel.root). Wheels: one
 * geometry for a LEFT wheel centred at the origin (axle along x, outer face +x); for right
 * wheels rotate it by PI about y. `wheelCenters` are the rest positions FL, FR, RL, RR.
 * The decal part (licence plates) uses a generic plate texture.
 */
export function getMergedGeometries(
  specId: string,
  lod: Lod,
): { parts: MergedPart[]; wheel: { geometry: THREE.BufferGeometry; material: THREE.Material }; wheelCenters: THREE.Vector3[] } {
  const c = specCache(specId);
  const g = lodGeometry(c, lod);
  const cut = lod === 0 ? 0 : 1;
  if (!c.basePaint[cut]) c.basePaint[cut] = createPaintMaterial(c.tex.map, c.tex.orm, 0xffffff, lod === 0);
  const paint = c.basePaint[cut]!;
  // instanced cars cannot use per-car metalness: use a mid metallic look
  paint.metalness = 0.45;
  const lights = sharedTrafficLights();
  const parts: MergedPart[] = [
    { name: 'body', geometry: g.body, material: paint },
    { name: 'detail', geometry: g.detail, material: c.detailMat[lod === 0 ? 0 : 1] },
    { name: 'lights', geometry: g.lights, material: lights },
    { name: 'decal', geometry: g.decal, material: sharedTrafficDecal(c) },
  ];
  if (g.glass) parts.push({ name: 'glass', geometry: g.glass, material: c.glassMat });
  return { parts, wheel: { geometry: g.wheel.spin, material: getWheelMaterial() }, wheelCenters: wheelCenters(c.spec) };
}

const sharedLights = new Map<string, LightsMaterial>();
/**
 * Shared (cached) lights material for a light state, for instanced traffic: the 'lights' part of
 * getMergedGeometries() uses the daytime state (DRL only). To show brake / head / indicator
 * lights per car, split the instances of the lights part into one InstancedMesh per state and give
 * each this material. Indicators do not blink here (the caller toggles the state).
 */
export function getSharedLightsMaterial(state: CarLightState = {}): THREE.Material {
  const key = [state.head, state.brake, state.reverse, state.indicatorL, state.indicatorR].map((v) => (v ? 1 : 0)).join('');
  let m = sharedLights.get(key);
  if (!m) {
    m = createLightsMaterial();
    applyLights(m, state);
    sharedLights.set(key, m);
  }
  return m;
}
function sharedTrafficLights(): THREE.Material {
  return getSharedLightsMaterial({});
}
const trafficDecals = new Map<string, THREE.MeshStandardMaterial>();
/** Decal material for instanced traffic of one spec: generic plate, brand lettering, taxi sign. */
function sharedTrafficDecal(c: SpecCache): THREE.MeshStandardMaterial {
  let m = trafficDecals.get(c.spec.id);
  if (!m) {
    const taxi = c.spec.category === 'taxi';
    const plate = c.spec.category === 'bestelbus' ? 'VX-999-X' : taxi ? 'T-999-XX' : 'XX-999-X';
    m = createDecalMaterial(createPlateTexture(plate, { taxi, sign: taxi ? 'TAXI' : null, brand: c.frame.d.brandText, model: c.frame.d.modelText }));
    trafficDecals.set(c.spec.id, m);
  }
  return m;
}

function getWheelMaterial(): THREE.MeshStandardMaterial {
  if (!wheelMat) wheelMat = createWheelMaterial();
  return wheelMat;
}

function wheelCenters(spec: CarSpec): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const left = i % 2 === 0;
    const track = front ? spec.trackFront : spec.trackRear;
    out.push(new THREE.Vector3((left ? 1 : -1) * track * 0.5, spec.wheelRadius, (front ? 1 : -1) * spec.wheelbase * 0.5));
  }
  return out;
}

/** Light levels per channel (emissive multipliers, HDR). */
function applyLights(mat: LightsMaterial, s: CarLightState, blinkOn = true): void {
  const L = mat.userData.levels;
  const head = !!s.head;
  L[CH.none] = 0;
  L[CH.drl] = 6;
  L[CH.head] = head ? 22 : 0;
  L[CH.tail] = head ? 1.6 : 0;
  L[CH.brake] = s.brake ? 4.5 : 0;
  L[CH.indL] = s.indicatorL && blinkOn ? 9 : 0;
  L[CH.indR] = s.indicatorR && blinkOn ? 9 : 0;
  L[CH.reverse] = s.reverse ? 8 : 0;
}

/** CarModel with module extras. */
export interface CarModelExt extends CarModel {
  readonly lod: Lod;
  readonly anchors: LightAnchors;
  readonly plate: string;
  /** current light state (indicators blink automatically while set) */
  readonly lights: Readonly<CarLightState>;
  /** set the paint and optionally force metallic / solid */
  setPaint(color: THREE.ColorRepresentation, metallic?: boolean): void;
  /** advance indicator blinking (call once per frame with dt); returns blink phase on/off */
  update(dt: number): boolean;
}

export function createCarModel(specId: string, opts: CarModelOptions = {}): CarModelExt {
  const spec = getSpec(specId);
  const c = specCache(spec.id);
  const lod = (opts.lod ?? 0) as Lod;
  const g = lodGeometry(c, lod);

  const paint = createPaintMaterial(c.tex.map, c.tex.orm, opts.color ?? spec.paints[0], lod === 0);
  const lightsMat = createLightsMaterial();
  let plateText = opts.plate ?? randomPlate(spec.category === 'bestelbus' ? 'bestel' : 'auto');
  const decalInfo = {
    taxi: spec.category === 'taxi',
    sign: spec.category === 'taxi' ? 'TAXI' : null,
    brand: c.frame.d.brandText,
    model: c.frame.d.modelText,
  };
  let plateTex = createPlateTexture(plateText, decalInfo);
  const decalMat = createDecalMaterial(plateTex);

  const root = new THREE.Group();
  root.name = `car-${spec.id}`;
  const body = new THREE.Group();
  body.name = 'body';
  root.add(body);
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, shadow = true) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    body.add(mesh);
    return mesh;
  };
  add(g.body, paint, 'paint');
  add(g.detail, c.detailMat[lod === 0 ? 0 : 1], 'detail');
  add(g.lights, lightsMat, 'lights', false);
  add(g.decal, decalMat, 'decal', false);
  if (g.glass) {
    const gm = add(g.glass, c.glassMat, 'glass', false);
    gm.renderOrder = 2;
  }

  const wm = getWheelMaterial();
  const centers = wheelCenters(spec) as CarModel['wheelCenters'];
  const wheels: THREE.Object3D[] = [];
  const spinNodes: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const left = i % 2 === 0;
    const pivot = new THREE.Object3D();
    pivot.name = ['FL', 'FR', 'RL', 'RR'][i];
    pivot.position.copy(centers[i]);
    const spinNode = new THREE.Object3D();
    const mesh = new THREE.Mesh(g.wheel.spin, wm);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!left) mesh.rotation.y = Math.PI;
    spinNode.add(mesh);
    pivot.add(spinNode);
    if (g.wheel.caliper) {
      const cal = new THREE.Mesh(g.wheel.caliper, wm);
      cal.castShadow = false;
      if (!left) cal.scale.x = -1;
      if (i >= 2) cal.rotation.x = 0.35; // rear calipers sit a bit lower
      pivot.add(cal);
    }
    root.add(pivot);
    wheels.push(pivot);
    spinNodes.push(spinNode);
  }

  const lightState: CarLightState = { head: false };
  let blinkT = 0;
  let blinkOn = true;
  applyLights(lightsMat, lightState);

  const model: CarModelExt = {
    specId: spec.id,
    root,
    body,
    wheels: wheels as CarModel['wheels'],
    wheelCenters: centers,
    lod,
    anchors: g.anchors,
    get plate() {
      return plateText;
    },
    get lights() {
      return lightState;
    },
    setWheel(i, steer, spinA, suspensionOffset) {
      const w = wheels[i];
      w.rotation.y = steer;
      w.position.y = centers[i].y + suspensionOffset;
      spinNodes[i].rotation.x = spinA;
    },
    setPaint(color, metallic?: boolean) {
      paint.color.set(color);
      const met = metallic ?? paint.userData.metallic;
      paint.metalness = met ? 0.62 : 0.0;
    },
    setLights(s) {
      Object.assign(lightState, s);
      applyLights(lightsMat, lightState, blinkOn);
      decalMat.emissiveIntensity = lightState.head ? 0.35 : 0;
    },
    setPlate(text) {
      plateText = text;
      const old = plateTex;
      plateTex = createPlateTexture(text, decalInfo);
      decalMat.map = plateTex;
      decalMat.emissiveMap = plateTex;
      decalMat.needsUpdate = true;
      old.dispose();
    },
    update(dt) {
      if (lightState.indicatorL || lightState.indicatorR) {
        blinkT += dt;
        const on = blinkT % 0.75 < 0.42;
        if (on !== blinkOn) {
          blinkOn = on;
          applyLights(lightsMat, lightState, blinkOn);
        }
      } else if (!blinkOn) {
        blinkOn = true;
        blinkT = 0;
        applyLights(lightsMat, lightState, blinkOn);
      }
      return blinkOn;
    },
    dispose() {
      paint.dispose();
      lightsMat.dispose();
      decalMat.dispose();
      plateTex.dispose();
      root.removeFromParent();
    },
  };
  return model;
}
