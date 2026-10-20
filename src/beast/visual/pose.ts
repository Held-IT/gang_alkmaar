// Forward-kinematics pose helper (no physics): sets the part objects' transforms from joint
// rotations relative to the rest pose. Used by the dev scene for static "action poses", and handy
// for lobby/podium previews (game-flow) where no ragdoll runs.
import * as THREE from 'three';
import { BEAST_PARTS, BEAST_RIG } from '../rig';
import type { BeastPartName } from '../../brawl/contracts';

/** Euler XYZ (radians) per part, rotating the part (and its children) about its joint anchor. */
export type PoseSpec = Partial<Record<BeastPartName, readonly [number, number, number]>>;

export interface PoseOptions {
  /** where the beast-local origin (between the feet) goes, in the parts' parent (root) space */
  position?: THREE.Vector3;
  /** heading (radians about +y, 0 = facing +z) */
  facing?: number;
  scale?: number;
  pose?: PoseSpec;
}

const _m = new Map<BeastPartName, THREE.Matrix4>();
const _t = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export function applyPose(parts: Readonly<Record<BeastPartName, THREE.Object3D>>, o: PoseOptions = {}): void {
  const s = o.scale ?? 1;
  const base = new THREE.Matrix4()
    .makeTranslation(o.position?.x ?? 0, o.position?.y ?? 0, o.position?.z ?? 0)
    .multiply(_r.makeRotationY(o.facing ?? 0));
  for (const name of BEAST_PARTS) {
    const spec = BEAST_RIG[name];
    const parent = spec.parent ? _m.get(spec.parent)! : base;
    let M = _m.get(name);
    if (!M) { M = new THREE.Matrix4(); _m.set(name, M); }
    M.copy(parent);
    const rot = o.pose?.[name];
    if (rot) {
      const j = spec.joint ?? spec.rest;
      _v.set(j[0] * s, j[1] * s, j[2] * s);
      _e.set(rot[0], rot[1], rot[2], 'XYZ');
      M.multiply(_t.makeTranslation(_v.x, _v.y, _v.z))
        .multiply(_r.makeRotationFromEuler(_e))
        .multiply(_t.makeTranslation(-_v.x, -_v.y, -_v.z));
    }
    const part = parts[name];
    part.position.set(spec.rest[0] * s, spec.rest[1] * s, spec.rest[2] * s).applyMatrix4(M);
    M.decompose(_v, _q, _s);
    part.quaternion.copy(_q);
    part.scale.set(1, 1, 1);
    part.updateMatrix();
  }
}

/** A few ready-made poses (Euler XYZ per part). +x rotation tips a hanging limb backwards. */
export const POSES: Readonly<Record<string, PoseSpec>> = {
  rest: {},
  idle: {
    upperArmL: [0, 0, 0.12], upperArmR: [0, 0, -0.12],
    lowerArmL: [-0.15, 0, 0], lowerArmR: [-0.15, 0, 0],
  },
  punch: {
    chest: [0.12, -0.35, 0],
    head: [-0.08, 0.2, 0],
    upperArmR: [-1.62, 0.15, 0.1], lowerArmR: [-0.05, 0, 0],
    upperArmL: [-0.5, 0, 0.35], lowerArmL: [-1.3, 0, 0],
    upperLegL: [-0.45, 0, 0], lowerLegL: [0.3, 0, 0],
    upperLegR: [0.3, 0, 0], lowerLegR: [0.25, 0, 0],
  },
  grab: {
    chest: [0.15, 0, 0],
    upperArmL: [-2.6, 0, -0.12], lowerArmL: [-0.15, 0, 0],
    upperArmR: [-2.6, 0, 0.12], lowerArmR: [-0.15, 0, 0],
    head: [-0.15, 0, 0],
  },
  kick: {
    chest: [-0.2, 0, 0],
    upperArmL: [-0.4, 0, 0.6], upperArmR: [-0.4, 0, -0.6],
    lowerArmL: [-0.6, 0, 0], lowerArmR: [-0.6, 0, 0],
    upperLegR: [-1.35, 0, 0], lowerLegR: [0.15, 0, 0],
    upperLegL: [0.12, 0, 0], lowerLegL: [0.2, 0, 0],
  },
  fall: {
    pelvis: [-0.55, 0, 0.25],
    chest: [-0.3, 0.2, 0.1],
    head: [-0.25, 0, 0.15],
    upperArmL: [-2.0, 0, 0.9], lowerArmL: [-0.5, 0, 0],
    upperArmR: [-1.6, 0, -1.1], lowerArmR: [-0.7, 0, 0],
    upperLegL: [-0.9, 0, 0.2], lowerLegL: [1.1, 0, 0],
    upperLegR: [-0.2, 0, -0.3], lowerLegR: [0.8, 0, 0],
  },
  ko: {
    pelvis: [-1.52, 0, 0],
    chest: [-0.05, 0, 0.08],
    head: [0.1, 0.5, 0.15],
    upperArmL: [-0.2, 0, 1.25], lowerArmL: [-0.4, 0, 0],
    upperArmR: [0.1, 0, -1.4], lowerArmR: [-0.9, 0, 0],
    upperLegL: [-0.25, 0, 0.3], lowerLegL: [0.35, 0, 0],
    upperLegR: [-0.6, 0, -0.15], lowerLegR: [0.9, 0, 0],
  },
  cheer: {
    upperArmL: [-2.75, 0, -0.35], lowerArmL: [-0.2, 0, 0],
    upperArmR: [-2.75, 0, 0.35], lowerArmR: [-0.2, 0, 0],
    head: [-0.25, 0, 0],
    chest: [-0.08, 0, 0],
  },
};
