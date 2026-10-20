// Tiny forward-kinematics helper for posing a beast visual without physics (lobby preview,
// winner podium, placeholder beast system): each part rotates about its joint anchor relative
// to its parent; the result is written to the visual's part objects (world = root-group space).
import * as THREE from 'three';
import { BEAST_PARTS, BEAST_RIG } from '../beast/rig';
import type { BeastPartName } from './contracts';

const _m = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _r = new THREE.Matrix4();

export class RigPose {
  /** Local rotation of every part about its joint (relative to the parent part). */
  readonly rot = {} as Record<BeastPartName, THREE.Quaternion>;
  /** Beast-local → target space: position of the feet, body orientation, uniform scale. */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  scale = 1;
  private readonly mats = {} as Record<BeastPartName, THREE.Matrix4>;
  private readonly quats = {} as Record<BeastPartName, THREE.Quaternion>;
  private readonly worldPos = {} as Record<BeastPartName, THREE.Vector3>;

  constructor() {
    for (const p of BEAST_PARTS) {
      this.rot[p] = new THREE.Quaternion();
      this.mats[p] = new THREE.Matrix4();
      this.quats[p] = new THREE.Quaternion();
      this.worldPos[p] = new THREE.Vector3();
    }
  }

  reset(): this {
    for (const p of BEAST_PARTS) this.rot[p].identity();
    return this;
  }

  /** Set a part's local rotation from Euler angles (radians, XYZ order). */
  set(part: BeastPartName, x: number, y = 0, z = 0): this {
    _euler.set(x, y, z);
    this.rot[part].setFromEuler(_euler);
    return this;
  }

  /** Compute world transforms (call before reading partWorld / apply). */
  solve(): void {
    const root = _m.compose(this.position, this.quaternion, _s.set(this.scale, this.scale, this.scale));
    for (const p of BEAST_PARTS) {
      const spec = BEAST_RIG[p];
      const pivot = spec.joint ?? spec.rest;
      const parentM = spec.parent ? this.mats[spec.parent] : root;
      const parentQ = spec.parent ? this.quats[spec.parent] : this.quaternion;
      // M = parent * T(pivot) * R * T(-pivot)
      const m = this.mats[p].copy(parentM);
      m.multiply(_t.makeTranslation(pivot[0], pivot[1], pivot[2]));
      m.multiply(_r.makeRotationFromQuaternion(this.rot[p]));
      m.multiply(_t.makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
      this.quats[p].copy(parentQ).multiply(this.rot[p]);
      this.worldPos[p].set(spec.rest[0], spec.rest[1], spec.rest[2]).applyMatrix4(m);
    }
  }

  partWorld(part: BeastPartName, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.worldPos[part]);
  }

  /** Write the solved pose to the visual's part objects. */
  apply(parts: Readonly<Record<BeastPartName, THREE.Object3D>>): void {
    for (const p of BEAST_PARTS) {
      const o = parts[p];
      o.position.copy(this.worldPos[p]);
      o.quaternion.copy(this.quats[p]);
    }
  }

  /** Local point of a part (beast-local rest coordinates) transformed to target space. */
  pointOn(part: BeastPartName, local: [number, number, number], out: THREE.Vector3): THREE.Vector3 {
    return out.set(local[0], local[1], local[2]).applyMatrix4(this.mats[part]);
  }
}

const _euler = new THREE.Euler();
const _s = new THREE.Vector3();

/**
 * A playful idle / cheer animation (used by the lobby preview and the winner podium).
 * mode 'idle': breathing, swaying, an occasional wave; 'cheer': jumping with both arms up.
 */
export function animateIdle(pose: RigPose, t: number, mode: 'idle' | 'cheer' | 'wave' = 'idle'): number {
  pose.reset();
  const sway = Math.sin(t * 1.7) * 0.06;
  const breathe = Math.sin(t * 2.6) * 0.03;
  let lift = 0;
  pose.set('pelvis', 0, 0, sway * 0.5);
  pose.set('chest', breathe, Math.sin(t * 0.9) * 0.08, -sway * 0.6);
  pose.set('head', -breathe * 1.5, Math.sin(t * 0.7 + 1) * 0.25, Math.sin(t * 1.3) * 0.08);
  // arms hang slightly outwards, swing gently (+x = beast's left: +z roll lifts the left arm out)
  pose.set('upperArmL', Math.sin(t * 1.7) * 0.12, 0, 0.18 + breathe);
  pose.set('upperArmR', -Math.sin(t * 1.7) * 0.12, 0, -0.18 - breathe);
  pose.set('lowerArmL', -0.25, 0, 0);
  pose.set('lowerArmR', -0.25, 0, 0);
  if (mode === 'wave' || (mode === 'idle' && t % 9 > 6.5)) {
    const w = mode === 'wave' ? 1 : Math.min(1, Math.min(t % 9 - 6.5, 9 - (t % 9)) * 3);
    pose.set('upperArmR', 0, 0, -0.18 - w * 2.55);
    pose.set('lowerArmR', 0, 0, -w * (0.5 + Math.sin(t * 11) * 0.45));
  }
  if (mode === 'cheer') {
    const ph = (t * 2.2) % 1;
    lift = Math.max(0, Math.sin(ph * Math.PI)) * 0.32;
    const flap = Math.sin(t * 13) * 0.25;
    pose.set('upperArmL', 0, 0, 2.6 + flap);
    pose.set('upperArmR', 0, 0, -2.6 - flap);
    pose.set('lowerArmL', 0, 0, 0.3);
    pose.set('lowerArmR', 0, 0, -0.3);
    pose.set('upperLegL', -lift * 1.2, 0, 0.1);
    pose.set('upperLegR', -lift * 1.2, 0, -0.1);
    pose.set('lowerLegL', lift * 2, 0, 0);
    pose.set('lowerLegR', lift * 2, 0, 0);
    pose.set('head', -0.25, Math.sin(t * 3) * 0.2, 0);
  }
  return lift;
}
