// Tyre force model: Pacejka "magic formula" shape on a normalised combined slip vector
// (friction ellipse), with load sensitivity and first-order relaxation (transient slip states).
//
// The relaxation states behave like tyre carcass deflection: at speed they converge to the
// steady-state slip in about relaxationLength / speed seconds, at standstill they integrate the
// contact-patch displacement, which acts as a stiff spring. That makes the car hold still on a
// slope with the brakes on, removes low-speed jitter and allows a stable explicit integration.

/** Magic-formula shape factor C. sin(C * PI / 2) is the sliding / peak friction ratio (~0.76). */
const MF_C = 1.45;
/** Curvature factor E (0 = plain arctan shape). */
const MF_E = 0.0;

function mfRaw(x: number): number {
  return Math.sin(MF_C * Math.atan(x - MF_E * (x - Math.atan(x))));
}

// Locate the peak once so that shape(1) == 1 exactly.
const { xPeak, yPeak } = (() => {
  let bestX = 1;
  let bestY = 0;
  for (let i = 1; i <= 4000; i++) {
    const x = i * 0.002;
    const y = mfRaw(x);
    if (y > bestY) {
      bestY = y;
      bestX = x;
    }
  }
  return { xPeak: bestX, yPeak: bestY };
})();

/** Normalised friction curve: 0 at s = 0, 1 at s = 1 (peak), ~0.76 for s -> infinity. */
export function tyreShape(s: number): number {
  return mfRaw(s * xPeak) / yPeak;
}

/** d(shape)/ds at s = 0 (initial stiffness of the normalised curve). */
export const TYRE_SHAPE_SLOPE0 = (MF_C * xPeak) / yPeak;

export interface TyreParams {
  /** Peak friction coefficient on dry asphalt. */
  mu: number;
  /** Slip ratio at peak longitudinal force. */
  kappaPeak: number;
  /** tan(slip angle) at peak lateral force. */
  tanAlphaPeak: number;
  /** Lateral force scale relative to longitudinal (friction ellipse). */
  lateralScale: number;
  /** Relaxation lengths (m). */
  relaxLong: number;
  relaxLat: number;
  /** Load sensitivity: mu drops by this fraction per 100% load above nominal. */
  loadSensitivity: number;
  /** Nominal (static) wheel load in N. */
  nominalLoad: number;
}

/** Peak force available for a given vertical load and surface grip multiplier. */
export function peakForce(p: TyreParams, fz: number, surfaceGrip: number): number {
  if (fz <= 0) return 0;
  const rel = fz / p.nominalLoad - 1;
  const sens = Math.min(1.15, Math.max(0.7, 1 - p.loadSensitivity * rel));
  return p.mu * surfaceGrip * fz * sens;
}

/**
 * Advances a relaxation state exactly for constant inputs:
 *   d(state)/dt = (slipVelocity - |v| * state) / sigma
 * Steady state = slipVelocity / |v|; at |v| = 0 it integrates the slip displacement.
 */
export function relaxState(state: number, slipVelocity: number, absV: number, sigma: number, h: number): number {
  const a = absV / sigma;
  if (a * h < 1e-4) return state + (slipVelocity / sigma) * h;
  const e = Math.exp(-a * h);
  return state * e + (slipVelocity / absV) * (1 - e);
}
