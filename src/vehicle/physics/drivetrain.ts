// Engine torque model and gearbox helpers derived from a CarSpec.
import type { CarSpec } from '../../contracts';

export const RAD_TO_RPM = 60 / (2 * Math.PI);
export const RPM_TO_RAD = (2 * Math.PI) / 60;

export interface EngineModel {
  electric: boolean;
  idleRpm: number;
  redlineRpm: number;
  maxTorque: number;
  maxPowerW: number;
  /** Rotational inertia of the engine / motor (kg m^2). */
  inertia: number;
  /** Full-throttle torque (Nm) at rpm. */
  fullTorque(rpm: number): number;
  /** Engine braking (or regen) torque magnitude (Nm, >= 0) at rpm with closed throttle. */
  dragTorque(rpm: number): number;
  /** Rpm the clutch slips at while launching with the given throttle. */
  launchRpm(throttle: number): number;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function createEngineModel(spec: CarSpec): EngineModel {
  const electric = !!spec.electric;
  const maxTorque = Math.max(50, spec.torqueNm);
  const maxPowerW = Math.max(20, spec.powerKw) * 1000;
  const redline = Math.max(3000, spec.redlineRpm);
  const idle = electric ? 0 : Math.max(500, spec.idleRpm);

  if (electric) {
    return {
      electric,
      idleRpm: 0,
      redlineRpm: redline,
      maxTorque,
      maxPowerW,
      inertia: 0.05,
      fullTorque(rpm) {
        const w = Math.max(1, Math.abs(rpm) * RPM_TO_RAD);
        let t = Math.min(maxTorque, maxPowerW / w);
        if (rpm > redline) t = 0;
        return t;
      },
      dragTorque(rpm) {
        // Gentle regen when lifting off; fades out at low rpm so the car can roll to a stop.
        return maxTorque * 0.1 * smoothstep(200, 1500, Math.abs(rpm));
      },
      launchRpm() {
        return 0;
      },
    };
  }

  // Combustion engine: torque rises from idle to a plateau (turbo-like for strong engines),
  // then is capped by constant max power, and falls off a little towards the redline.
  const plateauStart = Math.min(Math.max(0.27 * redline, 1500), 2600);
  const powerPeakRpm = 0.9 * redline;
  const turbo = maxTorque / (maxPowerW / 1000) > 1.7;
  const lowFrac = turbo ? 0.5 : 0.62;
  const isDiesel = redline < 5000;

  return {
    electric,
    idleRpm: idle,
    redlineRpm: redline,
    maxTorque,
    maxPowerW,
    inertia: 0.1 + (maxTorque / 1000) * 0.25 + (isDiesel ? 0.06 : 0),
    fullTorque(rpm) {
      const r = Math.max(rpm, idle * 0.5);
      const rise = lowFrac + (1 - lowFrac) * smoothstep(idle * 0.7, plateauStart, r);
      const powerCap = maxPowerW / (r * RPM_TO_RAD);
      let t = Math.min(maxTorque * rise, powerCap);
      if (r > powerPeakRpm) {
        const f = (r - powerPeakRpm) / (redline - powerPeakRpm);
        t *= 1 - 0.18 * f * f;
      }
      return Math.max(0, t);
    },
    dragTorque(rpm) {
      const r = Math.max(0, rpm);
      return maxTorque * (0.06 + 0.14 * (r / redline)) * (isDiesel ? 1.25 : 1);
    },
    launchRpm(throttle) {
      const top = Math.min(plateauStart + 400, 0.5 * redline);
      return idle + (top - idle) * Math.min(1, Math.max(0, throttle));
    },
  };
}

/** Typical gear shift duration (torque interruption) per car category. */
export function shiftDuration(spec: CarSpec): number {
  switch (spec.category) {
    case 'sedan':
      return 0.16;
    case 'bestelbus':
      return 0.32;
    case 'stadsauto':
      return 0.28;
    default:
      return 0.22;
  }
}
