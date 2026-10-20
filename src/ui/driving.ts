// Driving preferences edited in Instellingen › Rijden: gearbox mode and driver assists.
// The shapes match the Vehicle module (GearboxMode / VehicleAssists in src/vehicle/physics), so the
// integration can pass them straight to vehicle.setGearboxMode() / vehicle.setAssists().

import { loadPref, savePref } from './dom';

/** 'auto' = the gearbox shifts itself, 'manual' = the player shifts (Shift / Ctrl, pad RB / LB). */
export type GearboxMode = 'auto' | 'manual';

/** Driver aids. ESP off allows drifting; ABS off lets the wheels lock under hard braking. */
export interface DriverAssists {
  abs: boolean;
  tcs: boolean;
  esc: boolean;
}

export interface DrivingPrefs {
  gearbox: GearboxMode;
  assists: DriverAssists;
}

export const DEFAULT_DRIVING: Readonly<DrivingPrefs> = {
  gearbox: 'auto',
  assists: { abs: true, tcs: true, esc: true },
};

/** Reads the persisted preferences (validated; falls back to the defaults per field). */
export function loadDriving(): DrivingPrefs {
  const raw = loadPref<Partial<DrivingPrefs> | null>('driving', null);
  const a = (raw?.assists ?? {}) as Partial<DriverAssists>;
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    gearbox: raw?.gearbox === 'manual' ? 'manual' : 'auto',
    assists: {
      abs: b(a.abs, DEFAULT_DRIVING.assists.abs),
      tcs: b(a.tcs, DEFAULT_DRIVING.assists.tcs),
      esc: b(a.esc, DEFAULT_DRIVING.assists.esc),
    },
  };
}

export function saveDriving(p: DrivingPrefs): void {
  savePref('driving', p);
}
