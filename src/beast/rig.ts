// Canonical beast rig: part shapes and rest pose (beast-local, feet at y = 0, +z forward,
// +x = the beast's left). Owned by the beast-physics module, which may tune the NUMBERS; the part
// names and parent structure are a contract (beast visuals build their meshes from this).
// Proportions follow a chunky "jelly" fighter of ~1.5 m: big head-torso blob, short legs,
// long-ish arms with mitten hands at the end of the lower arms, feet at the end of the lower legs.
import type { BeastPartName, BeastPartSpec } from '../brawl/contracts';

export const BEAST_PARTS: readonly BeastPartName[] = [
  'pelvis',
  'chest',
  'head',
  'upperArmL',
  'lowerArmL',
  'upperArmR',
  'lowerArmR',
  'upperLegL',
  'lowerLegL',
  'upperLegR',
  'lowerLegR',
];

export const BEAST_RIG: Readonly<Record<BeastPartName, BeastPartSpec>> = {
  pelvis: { shape: 'capsule', radius: 0.2, halfHeight: 0.06, rest: [0, 0.62, 0], parent: null, joint: null },
  chest: { shape: 'capsule', radius: 0.22, halfHeight: 0.1, rest: [0, 0.92, 0], parent: 'pelvis', joint: [0, 0.76, 0] },
  head: { shape: 'sphere', radius: 0.21, halfHeight: 0, rest: [0, 1.28, 0], parent: 'chest', joint: [0, 1.12, 0] },
  upperArmL: { shape: 'capsule', radius: 0.07, halfHeight: 0.1, rest: [0.31, 0.95, 0], parent: 'chest', joint: [0.28, 1.08, 0] },
  lowerArmL: { shape: 'capsule', radius: 0.065, halfHeight: 0.09, rest: [0.31, 0.68, 0], parent: 'upperArmL', joint: [0.31, 0.82, 0] },
  upperArmR: { shape: 'capsule', radius: 0.07, halfHeight: 0.1, rest: [-0.31, 0.95, 0], parent: 'chest', joint: [-0.28, 1.08, 0] },
  lowerArmR: { shape: 'capsule', radius: 0.065, halfHeight: 0.09, rest: [-0.31, 0.68, 0], parent: 'upperArmR', joint: [-0.31, 0.82, 0] },
  upperLegL: { shape: 'capsule', radius: 0.09, halfHeight: 0.08, rest: [0.11, 0.415, 0], parent: 'pelvis', joint: [0.11, 0.54, 0] },
  lowerLegL: { shape: 'capsule', radius: 0.085, halfHeight: 0.08, rest: [0.11, 0.165, 0], parent: 'upperLegL', joint: [0.11, 0.29, 0] },
  upperLegR: { shape: 'capsule', radius: 0.09, halfHeight: 0.08, rest: [-0.11, 0.415, 0], parent: 'pelvis', joint: [-0.11, 0.54, 0] },
  lowerLegR: { shape: 'capsule', radius: 0.085, halfHeight: 0.08, rest: [-0.11, 0.165, 0], parent: 'upperLegR', joint: [-0.11, 0.29, 0] },
};

/**
 * Part masses (kg) for scale 1: a heavy head-torso blob on short legs (total ~63 kg). The physics
 * scales them with scale^3. Visual-only consumers can ignore these.
 */
export const BEAST_MASS: Readonly<Record<BeastPartName, number>> = {
  pelvis: 12,
  chest: 16,
  head: 7,
  upperArmL: 2.4,
  lowerArmL: 2.2,
  upperArmR: 2.4,
  lowerArmR: 2.2,
  upperLegL: 5,
  lowerLegL: 4,
  upperLegR: 5,
  lowerLegR: 4,
};

/** Standing pelvis-centre height above the feet (m, scale 1) = BEAST_RIG.pelvis.rest[1]. */
export const BEAST_STAND_HEIGHT = 0.62;

/** Hand / foot tip: distance from the lower arm / lower leg centre along its -Y axis (scale 1). */
export const BEAST_HAND_TIP = 0.09 + 0.065 * 0.6;
export const BEAST_FOOT_TIP = 0.08 + 0.085 * 0.8;
