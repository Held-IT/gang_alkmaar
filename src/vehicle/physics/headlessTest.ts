// Headless vehicle regression runner (owned by the Vehicle module). Runs the autodrive scripts
// from testTrack.ts in their own physics world without rendering, much faster than real time.
// Works in the browser (window.__debug.runVehicleTests in ?scene=dev-testtrack) and in Node
// through Vite's ssrLoadModule:
//
//   const server = await createServer({ root, configFile: false, appType: 'custom',
//     server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true } });
//   const { runVehicleTests } = await server.ssrLoadModule('/src/vehicle/physics/headlessTest.ts');
//   const { CAR_SPECS } = await server.ssrLoadModule('/src/vehicle/specs.ts');
//   console.log(await runVehicleTests(CAR_SPECS[0], ['rest', 'accel', 'brake']));
import type { CarSpec, Engine, VehicleInput } from '../../contracts';
import { createPhysics } from '../../physics/physics';
import { createPlaceholderModel } from './placeholderModel';
import { addTrackColliders, AUTODRIVE_SPAWNS, makeAutodriveScript } from './testTrack';
import { createPlayerVehicle, type PlayerVehicleExt } from './vehicle';

export const ALL_VEHICLE_TESTS = [
  'rest', 'accel', 'brake', 'circle', 'slalom', 'lanechange', 'handbrake', 'curb', 'bump', 'ramp', 'reverse', 'crash', 'flip',
] as const;

export interface VehicleTestResult {
  test: string;
  simSeconds: number;
  wallMs: number;
  result: Record<string, unknown> | null;
}

/** Runs the given autodrive tests for one car spec (60 Hz frames, 120 Hz physics). */
export async function runVehicleTests(spec: CarSpec, tests: readonly string[] = ALL_VEHICLE_TESTS): Promise<VehicleTestResult[]> {
  const out: VehicleTestResult[] = [];
  for (const test of tests) {
    const physics = await createPhysics();
    addTrackColliders(physics);
    const updates: { fn: (dt: number, t: number) => void; p: number }[] = [];
    // Minimal engine stand-in: the vehicle only needs onUpdate() and a scene to add its model to.
    const engine = {
      scene: { add() {}, remove() {} },
      onUpdate(fn: (dt: number, t: number) => void, p = 50) {
        updates.push({ fn, p });
        updates.sort((a, b) => a.p - b.p);
        return () => undefined;
      },
    } as unknown as Engine;
    let result: Record<string, unknown> | null = null;
    const script = makeAutodriveScript(test, (r) => (result = r));
    if (!script) {
      out.push({ test, simSeconds: 0, wallMs: 0, result: { error: 'unknown test' } });
      physics.dispose();
      continue;
    }
    const inp: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    let t = 0;
    let done = false;
    let vehicle: PlayerVehicleExt | null = null;
    // Registered before the vehicle, so the script's input is used in the same physics step.
    physics.onPreStep((dt) => {
      if (done || !vehicle) return;
      t += dt;
      done = script(t, dt, vehicle, inp);
      vehicle.setInput(inp);
    });
    const model = createPlaceholderModel(spec);
    vehicle = createPlayerVehicle(engine, physics, spec, model, { addToScene: false });
    const s = AUTODRIVE_SPAWNS[test] ?? { x: 0, z: 0, h: 0 };
    vehicle.teleport(s.x, s.z, s.h);
    const t0 = performance.now();
    let frames = 0;
    while (!done && frames < 60 * 200) {
      physics.step(1 / 60);
      for (const u of updates) u.fn(1 / 60, frames / 60);
      frames++;
    }
    out.push({ test, simSeconds: +(frames / 60).toFixed(1), wallMs: Math.round(performance.now() - t0), result });
    vehicle.dispose();
    model.dispose();
    physics.dispose();
  }
  return out;
}
