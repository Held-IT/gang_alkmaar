// Beast visuals (module beast-visual): soft, chunky one-colour jelly fighters with a procedural
// face and Alkmaar-themed costumes.
//
// Structure per beast (contract: src/brawl/contracts.ts BeastVisual):
//   root (Group)
//     11 part objects (THREE.Bone, direct children, one per BeastPartName; the physics writes
//       their position/quaternion in root space every frame)
//     body    SkinnedMesh (shared geometry per scale, own material instance: colour + face uniforms)
//     costume SkinnedMesh (shared geometry per costume/scale/guild, own material instance)
// -> 2 draw calls per beast (+ 2 in the shadow pass), ~10-18k triangles incl. costume.
// Both meshes share one Skeleton of the part bones, so one bone texture/upload per beast.
import * as THREE from 'three';
import type { BeastExpression, BeastPartName, BeastVisual, CostumeInfo } from '../../brawl/contracts';
import { BEAST_PARTS, BEAST_RIG } from '../rig';
import { getBodyGeometry } from './body';
import { COSTUMES as COSTUME_LIST, costumeTraits, getCostumeGeometry } from './costumes';
import { FaceAnimator } from './expressions';
import {
  applyBodyColour,
  createBeastUniforms,
  createBodyMaterial,
  createCostumeMaterial,
  createFaceUniforms,
} from './materials';
import { getTorsoShape } from './shape';
import { guildForColour } from './palette';

export { BEAST_COLOURS, BEAST_COLOUR_HEX, GUILD_COLOURS, type BeastColour } from './palette';
export { applyPose, POSES, type PoseSpec, type PoseOptions } from './pose';
export { EXPRESSIONS } from './expressions';

/** All costumes (ids are stable; 'geen' = no costume). */
export const COSTUMES: CostumeInfo[] = COSTUME_LIST;

/**
 * Builds (and caches) the shared body + costume geometries up front, e.g. behind a loading screen
 * (first use of a costume otherwise costs ~6-18 ms on the dev iGPU machine). ids default to all.
 */
export function prewarmBeastVisuals(opts: { scales?: number[]; costumes?: string[] } = {}): void {
  const ids = opts.costumes ?? COSTUME_LIST.map((c) => c.id);
  for (const s of opts.scales ?? [1]) {
    getBodyGeometry(s);
    for (const id of ids) {
      if (costumeTraits(id).guild) for (const g of ['rood', 'groen', 'blauw', 'geel'] as const) getCostumeGeometry(id, s, g);
      else getCostumeGeometry(id, s, 'rood');
    }
  }
}

/** Optional extras on top of the BeastVisual contract. */
export interface BeastVisualExt extends BeastVisual {
  readonly colour: string;
  readonly costume: string;
  readonly expression: BeastExpression;
  readonly scale: number;
  /** KO face style: 'x' (default) or 'spiraal' (spinning spiral eyes). */
  setKoStyle(style: 'x' | 'spiraal'): void;
  /** Jump to the current expression target immediately (no blend), e.g. for previews. */
  snapExpression(): void;
  /** Pupil direction override (-1..1, null = automatic wandering). */
  setLook(x: number | null, y?: number): void;
  /** Strength of the jelly jiggle (0 = off, default 1). */
  jiggle: number;
  /** Rendering info (triangles of body + costume, draw calls per pass). */
  info(): { triangles: number; drawCalls: number };
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();
let beastCounter = 0;

export function createBeastVisual(opts: { colour: string; costume: string; scale?: number }): BeastVisualExt {
  const scale = opts.scale ?? 1;
  const shape = getTorsoShape();
  const root = new THREE.Group();
  root.name = 'beast';

  // ------------------------------------------------------------------ bones (= rig parts)
  const parts = {} as Record<BeastPartName, THREE.Object3D>;
  const bones: THREE.Bone[] = [];
  const inverses: THREE.Matrix4[] = [];
  for (const name of BEAST_PARTS) {
    const b = new THREE.Bone();
    b.name = name;
    const r = BEAST_RIG[name].rest;
    b.position.set(r[0] * scale, r[1] * scale, r[2] * scale);
    root.add(b);
    parts[name] = b;
    bones.push(b);
    inverses.push(new THREE.Matrix4().makeTranslation(-r[0] * scale, -r[1] * scale, -r[2] * scale));
  }
  const skeleton = new THREE.Skeleton(bones, inverses);

  // ------------------------------------------------------------------ materials & meshes
  const bu = createBeastUniforms();
  const fu = createFaceUniforms();
  fu.uHeadC.value.copy(shape.dims.headC).multiplyScalar(scale);
  fu.uHeadR.value = shape.dims.headR * scale;
  const colour = new THREE.Color(opts.colour);
  const bodyMat = createBodyMaterial(colour, bu, fu);
  applyBodyColour(bodyMat, fu, colour);
  const costumeMat = createCostumeMaterial(bu);

  const sphere = new THREE.Sphere(new THREE.Vector3(0, 0.8 * scale, 0), 1.2 * scale);
  const makeMesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.SkinnedMesh => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.name = name;
    m.bind(skeleton, IDENTITY);
    m.castShadow = true;
    m.receiveShadow = true;
    m.boundingSphere = sphere; // kept up to date from the part positions in update()
    root.add(m);
    return m;
  };
  const body = makeMesh(getBodyGeometry(scale), bodyMat, 'beast-body');
  let costumeMesh: THREE.SkinnedMesh | null = null;

  const face = new FaceAnimator(++beastCounter);
  let colourHex = opts.colour;
  let costumeId = 'geen';

  const applyCostume = (id: string): void => {
    const known = COSTUME_LIST.some((c) => c.id === id) ? id : 'geen';
    costumeId = known;
    const geo = getCostumeGeometry(known, scale, guildForColour(colourHex));
    if (costumeMesh) {
      root.remove(costumeMesh);
      costumeMesh = null;
    }
    if (geo) costumeMesh = makeMesh(geo, costumeMat, 'beast-costume');
    const t = costumeTraits(known);
    face.blushBias = t.blush;
  };
  applyCostume(opts.costume);
  face.set('neutral');
  face.snap();
  face.update(0, fu, bu);

  // ------------------------------------------------------------------ jiggle spring
  const jig = { off: new THREE.Vector3(), vel: new THREE.Vector3(), prevP: new THREE.Vector3(), prevV: new THREE.Vector3(), init: false };
  const K = 260; // stiffness (1/s^2): ~2.6 Hz wobble
  const C = 9; // damping (1/s)
  const G = 0.0105; // acceleration -> offset gain
  const MAX = 0.055 * scale;

  let lookOverride: THREE.Vector2 | null = null;

  const visual: BeastVisualExt = {
    root,
    parts,
    jiggle: 1,
    get colour() { return colourHex; },
    get costume() { return costumeId; },
    get expression() { return face.expression; },
    scale,
    setExpression(e) {
      if (e !== face.expression) face.set(e);
    },
    setColour(hex) {
      colourHex = hex;
      colour.set(hex);
      applyBodyColour(bodyMat, fu, colour);
      // the kaasdrager ribbon follows the guild of the body colour
      if (costumeTraits(costumeId).guild) applyCostume(costumeId);
    },
    setCostume(id) {
      if (id !== costumeId) applyCostume(id);
    },
    setKoStyle(style) {
      face.koStyle = style;
      if (face.expression === 'ko') face.set('ko');
    },
    snapExpression() {
      face.snap();
      face.update(0, fu, bu);
    },
    setLook(x, y = 0) {
      lookOverride = x === null ? null : new THREE.Vector2(x, y);
    },
    update(dt) {
      const d = Math.min(Math.max(dt, 0), 0.05);
      face.update(d, fu, bu);
      if (lookOverride) fu.uLook.value.copy(lookOverride);

      // chest acceleration drives a damped spring; the offset is applied to the upper body
      // (weighted per vertex) in the vertex shader -> the head-torso blob wobbles like jelly.
      const p = parts.chest.position;
      if (!jig.init || d <= 0) {
        if (!jig.init) {
          jig.prevP.copy(p);
          jig.prevV.set(0, 0, 0);
          jig.init = true;
        }
      } else {
        const v = _v.subVectors(p, jig.prevP).divideScalar(d);
        if (v.lengthSq() > 30 * 30) {
          // teleport / respawn: no jiggle from the jump
          v.set(0, 0, 0);
          jig.prevV.set(0, 0, 0);
        }
        const acc = _a.subVectors(v, jig.prevV).divideScalar(d);
        const amax = 70;
        if (acc.lengthSq() > amax * amax) acc.setLength(amax);
        jig.prevP.copy(p);
        jig.prevV.copy(v);
        // semi-implicit Euler in 2 sub-steps
        const h = d / 2;
        for (let i = 0; i < 2; i++) {
          jig.vel.addScaledVector(jig.off, -K * h);
          jig.vel.addScaledVector(jig.vel, -C * h);
          jig.vel.addScaledVector(acc, -K * G * h);
          jig.off.addScaledVector(jig.vel, h);
        }
        if (jig.off.length() > MAX) {
          jig.off.setLength(MAX);
          jig.vel.multiplyScalar(0.5);
        }
      }
      bu.uJiggle.value.copy(jig.off).multiplyScalar(visual.jiggle);

      // culling sphere around all parts (bind-space bounds don't follow the ragdoll)
      const c = sphere.center.copy(parts.pelvis.position).add(parts.chest.position).add(parts.head.position).multiplyScalar(1 / 3);
      let r = 0;
      for (const name of BEAST_PARTS) r = Math.max(r, parts[name].position.distanceTo(c));
      sphere.radius = r + 0.45 * scale;
    },
    info() {
      const tri = (g: THREE.BufferGeometry) => (g.index ? g.index.count / 3 : g.getAttribute('position').count / 3);
      return { triangles: tri(body.geometry) + (costumeMesh ? tri(costumeMesh.geometry) : 0), drawCalls: costumeMesh ? 2 : 1 };
    },
    dispose() {
      root.removeFromParent();
      bodyMat.dispose();
      costumeMat.dispose();
      skeleton.dispose();
      // geometries are shared (cached per scale/costume) and stay alive
    },
  };
  return visual;
}
