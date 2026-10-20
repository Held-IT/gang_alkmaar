// Vehicle test track layout + scripted driving tests ("autodrive"). Shared by the browser dev
// scene (src/scenes/dev-testtrack.ts) and headless Node runs (no DOM / rendering needed here).
import * as THREE from 'three';
import type { VehicleInput } from '../../contracts';
import type { PhysicsWorldExt } from '../../physics/physics';
import type { PlayerVehicleExt } from './vehicle';

// Track layout (world metres). The car spawns at the origin facing +z (south) down the runway.
export const TRACK = {
  groundHalfSize: 9000,
  curb: { x0: -62, x1: -30, z0: 20, z1: 28, h: 0.12 },
  bump: { x0: -62, x1: -30, z: 44, len: 3.6, h: 0.1 },
  ramp: { x0: -58, x1: -50, z: 70 },
  circle: { x: 120, z: 120, r: 30 },
  slalom: { x: 40, z0: 60, gap: 18, n: 8 },
  /** [x, y, z, hx, hy, hz] static boxes: wall, building block, crates. */
  boxes: [
    [-85, 1.25, 30, 0.5, 1.25, 30],
    [-112, 7, 70, 12, 7, 9],
    [-70, 0.6, 140, 0.6, 0.6, 0.6],
    [-72, 0.6, 143, 0.6, 0.6, 0.6],
    [-69, 0.6, 147, 0.6, 0.6, 0.6],
  ] as [number, number, number, number, number, number][],
  /** bollard positions [x, z] */
  posts: Array.from({ length: 16 }, (_, k) => [-40, 100 + k * 1.6] as [number, number]),
} as const;

/** Strip along x (x0..x1) following a height profile ys over zs; top surface + side walls. */
export function profileStrip(x0: number, x1: number, zs: number[], ys: number[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = zs.length;
  for (let i = 0; i < n; i++) pos.push(x0, ys[i], zs[i], x1, ys[i], zs[i]);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  for (const x of [x0, x1]) {
    const base = pos.length / 3;
    for (let i = 0; i < n; i++) pos.push(x, ys[i], zs[i], x, 0, zs[i]);
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      if (x === x0) idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function bumpGeometry(): THREE.BufferGeometry {
  const b = TRACK.bump;
  const zs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i <= 24; i++) {
    const s = i / 24;
    zs.push(b.z - b.len / 2 + s * b.len);
    ys.push(b.h * Math.sin(Math.PI * s) ** 2);
  }
  return profileStrip(b.x0, b.x1, zs, ys);
}

export function rampGeometry(): THREE.BufferGeometry {
  const r = TRACK.ramp;
  return profileStrip(r.x0, r.x1, [r.z, r.z + 9, r.z + 12, r.z + 17], [0, 0.9, 0.9, 0]);
}

function addTrimesh(physics: PhysicsWorldExt, geo: THREE.BufferGeometry, tag: string): void {
  const p = geo.getAttribute('position').array as Float32Array;
  physics.addStaticTrimesh(new Float32Array(p), new Uint32Array(geo.getIndex()!.array), { tag });
}

/** Adds every collider of the test track to the physics world. */
export function addTrackColliders(physics: PhysicsWorldExt): void {
  const S = TRACK.groundHalfSize;
  physics.addStaticTrimesh(
    new Float32Array([-S, 0, -S, S, 0, -S, S, 0, S, -S, 0, S]),
    new Uint32Array([0, 2, 1, 0, 3, 2]),
    { tag: 'asphalt' },
  );
  const c = TRACK.curb;
  physics.addStaticBox(
    new THREE.Vector3((c.x0 + c.x1) / 2, c.h / 2, (c.z0 + c.z1) / 2),
    new THREE.Vector3((c.x1 - c.x0) / 2, c.h / 2, (c.z1 - c.z0) / 2),
    0,
    'curb',
  );
  addTrimesh(physics, bumpGeometry(), 'klinkers');
  addTrimesh(physics, rampGeometry(), 'ramp');
  for (const [x, y, z, hx, hy, hz] of TRACK.boxes) {
    physics.addStaticBox(new THREE.Vector3(x, y, z), new THREE.Vector3(hx, hy, hz), 0, hx > 5 ? 'building' : 'box');
  }
  for (const [x, z] of TRACK.posts) physics.addStaticCylinder(x, z, 0.085, 0.95, 0, 'bollard');
}

// ---------------------------------------------------------------------------------------------
// Autodrive scripts
// ---------------------------------------------------------------------------------------------

/** Called at the physics rate before the vehicle step. Returns true when the test is finished. */
export type AutodriveScript = (t: number, dt: number, v: PlayerVehicleExt, inp: VehicleInput) => boolean;

export const AUTODRIVE_SPAWNS: Record<string, { x: number; z: number; h: number }> = {
  curb: { x: -46, z: 6, h: 0 },
  bump: { x: -46, z: 30, h: 0 },
  slalom: { x: TRACK.slalom.x, z: TRACK.slalom.z0 - 70, h: 0 },
  circle: { x: TRACK.circle.x + TRACK.circle.r, z: TRACK.circle.z, h: Math.PI },
  ramp: { x: (TRACK.ramp.x0 + TRACK.ramp.x1) / 2, z: 0, h: 0 },
  // Faces the wall (x = -84.5 face) head-on, 40 m run-up.
  crash: { x: -44, z: 30, h: -Math.PI / 2 },
};

/** Heading from the physics body (v.heading is the render-interpolated value). */
export function bodyHeading(v: PlayerVehicleExt): number {
  const r = v.body.rotation();
  const fx = 2 * (r.x * r.z + r.w * r.y);
  const fz = 1 - 2 * (r.x * r.x + r.y * r.y);
  return Math.atan2(fx, fz);
}

function toLocal(v: PlayerVehicleExt, x: number, z: number): { fwd: number; left: number } {
  const p = v.body.translation();
  const dx = x - p.x;
  const dz = z - p.z;
  const h = bodyHeading(v);
  return { fwd: dx * Math.sin(h) + dz * Math.cos(h), left: dx * Math.cos(h) - dz * Math.sin(h) };
}

/** Pure-pursuit steering towards a world point. Returns input.steer (-1 left .. 1 right). */
export function pursuit(v: PlayerVehicleExt, x: number, z: number): number {
  const { fwd, left } = toLocal(v, x, z);
  const ld2 = Math.max(1, fwd * fwd + left * left);
  const delta = Math.atan(((2 * left) / ld2) * v.dims.wheelbase); // + = left
  return THREE.MathUtils.clamp(-delta / Math.max(0.02, v.controls.steerLimit), -1, 1);
}

function speedControl(state: { i: number }, v: PlayerVehicleExt, target: number, dt: number, inp: VehicleInput): void {
  const e = target - v.forwardSpeed;
  state.i = THREE.MathUtils.clamp(state.i + e * dt, -5, 20);
  inp.throttle = THREE.MathUtils.clamp(0.25 * e + 0.05 * state.i, 0, 1);
  inp.brake = e < -1.5 ? THREE.MathUtils.clamp(-0.12 * e, 0, 1) : 0;
}

export function makeAutodriveScript(name: string, log: (r: Record<string, unknown>) => void): AutodriveScript | null {
  const r: Record<string, unknown> = { test: name };
  const { curb, circle, slalom } = TRACK;
  switch (name) {
    case 'accel': {
      let t60 = -1;
      let t100 = -1;
      let maxV = 0;
      let lastCheckV = 0;
      let lastCheckT = 0;
      const samples: string[] = [];
      return (t, dt, v, inp) => {
        inp.throttle = t > 0.5 ? 1 : 0;
        inp.steer = pursuit(v, 0, v.body.translation().z + 40);
        const kmh = v.forwardSpeed * 3.6;
        const ta = t - 0.5;
        if (t60 < 0 && kmh >= 60) t60 = ta;
        if (t100 < 0 && kmh >= 100) t100 = ta;
        maxV = Math.max(maxV, kmh);
        if (Math.floor(t) !== Math.floor(t - dt) && samples.length < 30)
          samples.push(`${Math.floor(ta)}s ${kmh.toFixed(0)}kmh g${v.gear} ${v.engineRpm.toFixed(0)}rpm`);
        if (t - lastCheckT > 10) {
          if (kmh - lastCheckV < 0.5 && t > 30) {
            Object.assign(r, { t0_60: +t60.toFixed(2), t0_100: +t100.toFixed(2), topSpeedKmh: +maxV.toFixed(1), samples });
            log(r);
            return true;
          }
          lastCheckV = kmh;
          lastCheckT = t;
        }
        if (t > 150) {
          Object.assign(r, { t0_60: t60, t0_100: t100, topSpeedKmh: +maxV.toFixed(1), note: 'timeout', samples });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'brake': {
      let phase = 0;
      let z0 = 0;
      let v0 = 0;
      let tb = 0;
      let maxDecel = 0;
      return (t, _dt, v, inp) => {
        inp.steer = pursuit(v, 0, v.body.translation().z + 40);
        const kmh = v.forwardSpeed * 3.6;
        if (phase === 0) {
          inp.throttle = 1;
          inp.brake = 0;
          if (kmh >= 100) {
            phase = 1;
            z0 = v.body.translation().z;
            v0 = kmh;
            tb = t;
          }
        } else {
          inp.throttle = 0;
          inp.brake = 1;
          maxDecel = Math.max(maxDecel, -v.localAcceleration.z);
          if (Math.abs(v.forwardSpeed) < 0.05) {
            const d = v.body.translation().z - z0;
            Object.assign(r, {
              fromKmh: +v0.toFixed(1),
              distance: +d.toFixed(2),
              distance100: +(d * (100 / v0) ** 2).toFixed(2),
              time: +(t - tb).toFixed(2),
              maxDecelG: +(maxDecel / 9.81).toFixed(2),
            });
            log(r);
            return true;
          }
        }
        if (t > 60) {
          Object.assign(r, { note: 'timeout', phase });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'slalom': {
      const sc = { i: 0 };
      let maxLat = 0;
      let maxErr = 0;
      const target = 55 / 3.6;
      const amp = 2.4;
      return (t, dt, v, inp) => {
        const p = v.body.translation();
        const zl = p.z + Math.max(7, v.forwardSpeed * 0.55);
        const xl = slalom.x + (zl > slalom.z0 - 10 ? amp * Math.sin(((zl - slalom.z0) / slalom.gap) * Math.PI) : 0);
        inp.steer = pursuit(v, xl, zl);
        speedControl(sc, v, target, dt, inp);
        if (p.z > slalom.z0 && p.z < slalom.z0 + slalom.gap * (slalom.n - 1)) {
          maxLat = Math.max(maxLat, Math.abs(v.localAcceleration.x));
          maxErr = Math.max(maxErr, Math.abs(p.x - (slalom.x + amp * Math.sin(((p.z - slalom.z0) / slalom.gap) * Math.PI))));
        }
        if (p.z > slalom.z0 + slalom.gap * slalom.n + 10 || t > 60) {
          Object.assign(r, {
            maxLatG: +(maxLat / 9.81).toFixed(2),
            maxPathErr: +maxErr.toFixed(2),
            kmh: +(v.forwardSpeed * 3.6).toFixed(1),
            note: t > 60 ? 'timeout' : undefined,
          });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'circle': {
      const sc = { i: 0 };
      let targetV = 20 / 3.6;
      let windowLat = 0;
      let windowN = 0;
      let windowErr = 0;
      let best = 0;
      let bestV = 0;
      let lastWin = 0;
      return (t, dt, v, inp) => {
        const p = v.body.translation();
        const dx = p.x - circle.x;
        const dz = p.z - circle.z;
        const ang = Math.atan2(dz, dx);
        // Counter-clockwise seen from above with +z south = the car turns left.
        const ta = ang - Math.max(6, v.forwardSpeed * 0.5) / circle.r;
        inp.steer = pursuit(v, circle.x + Math.cos(ta) * circle.r, circle.z + Math.sin(ta) * circle.r);
        speedControl(sc, v, targetV, dt, inp);
        const err = Math.abs(Math.hypot(dx, dz) - circle.r);
        if (t > 8) {
          targetV += dt * 0.3;
          windowLat += Math.abs(v.localAcceleration.x);
          windowErr = Math.max(windowErr, err);
          windowN++;
          if (t - lastWin > 1.5) {
            const lat = windowLat / windowN;
            if (windowErr < 1.5 && lat > best) {
              best = lat;
              bestV = v.forwardSpeed * 3.6;
            }
            windowLat = windowN = windowErr = 0;
            lastWin = t;
          }
        }
        if (err > 4 || t > 90) {
          Object.assign(r, { maxSteadyLatG: +(best / 9.81).toFixed(3), atKmh: +bestV.toFixed(1), endErr: +err.toFixed(2), t: +t.toFixed(1) });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'curb':
    case 'bump': {
      const sc = { i: 0 };
      const speed = name === 'curb' ? 8 : 30;
      const zStart = name === 'curb' ? curb.z0 : TRACK.bump.z - 2;
      const zEnd = name === 'curb' ? curb.z1 + 8 : TRACK.bump.z + 12;
      let maxPitch = 0;
      let minV = 99;
      let onTop = false;
      let maxY = -1;
      let maxRoofAcc = 0;
      return (t, dt, v, inp) => {
        const p = v.body.translation();
        inp.steer = pursuit(v, -46, p.z + 15);
        speedControl(sc, v, speed / 3.6, dt, inp);
        if (p.z > zStart - 4) {
          minV = Math.min(minV, v.forwardSpeed);
          const rq = v.body.rotation();
          const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w), 'YXZ');
          maxPitch = Math.max(maxPitch, Math.abs(e.x));
          maxY = Math.max(maxY, p.y);
          maxRoofAcc = Math.max(maxRoofAcc, Math.abs(v.localAcceleration.y));
        }
        if (name === 'curb' && p.z > curb.z0 + v.dims.wheelbase / 2 + 0.6 && p.z < curb.z1 - v.dims.wheelbase / 2) {
          if (v.wheelStates.every((w) => w.grounded) && Math.abs(p.y - curb.h) < 0.05) onTop = true;
        }
        if (p.z > zEnd) {
          Object.assign(r, {
            ok: (name === 'bump' || onTop) && minV > 0.3,
            onTopLevel: name === 'curb' ? onTop : undefined,
            minSpeedKmh: +(minV * 3.6).toFixed(2),
            maxPitchDeg: +THREE.MathUtils.radToDeg(maxPitch).toFixed(2),
            maxBodyY: +maxY.toFixed(3),
            maxVertAccG: +(maxRoofAcc / 9.81).toFixed(2),
          });
          log(r);
          return true;
        }
        if (t > 40) {
          Object.assign(r, { ok: false, note: 'stuck', z: +p.z.toFixed(2), minSpeedKmh: +(minV * 3.6).toFixed(2) });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'crash': {
      // Full throttle into the wall, then check the impact report and that nothing tunnelled.
      let maxImpulse = 0;
      let maxDv = 0;
      let impactKmh = 0;
      let minX = Infinity;
      let off: (() => void) | null = null;
      let tHit = -1;
      let now = 0;
      return (t, _dt, v, inp) => {
        now = t;
        if (!off) off = v.onImpact((imp, dv) => {
          if (imp > maxImpulse) impactKmh = Math.abs(v.forwardSpeed) * 3.6;
          maxImpulse = Math.max(maxImpulse, imp);
          maxDv = Math.max(maxDv, dv);
          if (tHit < 0 && dv > 2) tHit = now;
        });
        const p = v.body.translation();
        minX = Math.min(minX, p.x);
        inp.throttle = tHit < 0 ? 1 : 0;
        inp.brake = tHit < 0 ? 0 : 0.2;
        inp.steer = 0;
        if ((tHit > 0 && t - tHit > 3) || t > 20) {
          off?.();
          const front = minX - v.dims.length / 2;
          Object.assign(r, {
            ok: tHit > 0 && front > -84.5 - 0.15,
            maxImpulseNs: Math.round(maxImpulse),
            maxDeltaV: +maxDv.toFixed(2),
            frontMinX: +front.toFixed(2),
            endKmh: +(v.forwardSpeed * 3.6).toFixed(1),
            upright: v.body.rotation().w > 0.5,
          });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'flip': {
      // Phase 1: flip the car onto its roof, press reset. Phase 2: flip again and wait for the
      // automatic recovery (upside down + slow for 3 s).
      let phase = 0;
      let tPhase = 0;
      const out: Record<string, unknown> = {};
      const flip = (v: PlayerVehicleExt) => {
        const p = v.body.translation();
        v.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
        v.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
        v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      };
      const state = (v: PlayerVehicleExt) => {
        const r0 = v.body.rotation();
        const upY = 1 - 2 * (r0.x * r0.x + r0.z * r0.z);
        return { upY: +upY.toFixed(3), y: +v.body.translation().y.toFixed(3), grounded: v.wheelStates.every((w) => w.grounded) };
      };
      return (t, _dt, v, inp) => {
        inp.throttle = inp.brake = inp.steer = 0;
        inp.reset = false;
        if (phase === 0 && t > 1) { flip(v); phase = 1; tPhase = t; }
        else if (phase === 1 && t - tPhase > 1.5) { out.upsideDown = state(v); inp.reset = true; phase = 2; tPhase = t; }
        else if (phase === 2 && t - tPhase > 1.5) { out.afterReset = state(v); flip(v); phase = 3; tPhase = t; }
        else if (phase === 3 && t - tPhase > 5.5) {
          out.afterAutoReset = state(v);
          const a = out.afterReset as { upY: number; grounded: boolean };
          const b = out.afterAutoReset as { upY: number; grounded: boolean };
          Object.assign(r, out, { ok: a.upY > 0.99 && a.grounded && b.upY > 0.99 && b.grounded });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'lanechange': {
      // Accelerate to 150 km/h, then a sharp double steering pulse (full lock, keyboard-like)
      // and hands off: the car must settle without spinning.
      const sc = { i: 0 };
      let tStart = -1;
      let h0 = 0;
      let maxYaw = 0;
      let maxBeta = 0;
      return (t, dt, v, inp) => {
        if (tStart < 0) {
          speedControl(sc, v, 150 / 3.6, dt, inp);
          inp.steer = pursuit(v, 0, v.body.translation().z + 60);
          if (v.forwardSpeed * 3.6 > 149) { tStart = t; h0 = bodyHeading(v); }
          if (t > 60) { Object.assign(r, { note: 'never reached 150' }); log(r); return true; }
          return false;
        }
        const tt = t - tStart;
        inp.throttle = 0.35;
        inp.brake = 0;
        inp.steer = tt < 0.6 ? -1 : tt < 1.2 ? 1 : 0;
        const lv = v.body.linvel();
        const hd = bodyHeading(v);
        const fwd = lv.x * Math.sin(hd) + lv.z * Math.cos(hd);
        const lat = lv.x * Math.cos(hd) - lv.z * Math.sin(hd);
        maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(lat, Math.abs(fwd))));
        maxYaw = Math.max(maxYaw, Math.abs(v.body.angvel().y));
        if (tt > 5) {
          let dh = hd - h0;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          const yawNow = Math.abs(v.body.angvel().y);
          Object.assign(r, {
            ok: maxBeta < 0.35 && yawNow < 0.05,
            maxBodySlipDeg: +THREE.MathUtils.radToDeg(maxBeta).toFixed(1),
            maxYawRateDegS: +THREE.MathUtils.radToDeg(maxYaw).toFixed(1),
            finalYawRateDegS: +THREE.MathUtils.radToDeg(yawNow).toFixed(2),
            headingChangeDeg: +THREE.MathUtils.radToDeg(dh).toFixed(1),
            kmh: +(v.forwardSpeed * 3.6).toFixed(1),
          });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'ramp': {
      // Over the 0.9 m ramp at 70 km/h: airtime, landing impact, must stay upright and drive on.
      const sc = { i: 0 };
      const xMid = (TRACK.ramp.x0 + TRACK.ramp.x1) / 2;
      let maxY = 0;
      let airTime = 0;
      let maxPitch = 0;
      let maxRoll = 0;
      return (t, dt, v, inp) => {
        const p = v.body.translation();
        inp.steer = pursuit(v, xMid, p.z + 20);
        speedControl(sc, v, 70 / 3.6, dt, inp);
        maxY = Math.max(maxY, p.y);
        if (v.wheelStates.every((w) => !w.grounded)) airTime += dt;
        if (p.z > TRACK.ramp.z) {
          const rq = v.body.rotation();
          const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w), 'YXZ');
          maxPitch = Math.max(maxPitch, Math.abs(e.x));
          maxRoll = Math.max(maxRoll, Math.abs(e.z));
        }
        if (p.z > TRACK.ramp.z + 60 || t > 30) {
          const rq = v.body.rotation();
          const upY = 1 - 2 * (rq.x * rq.x + rq.z * rq.z);
          Object.assign(r, {
            ok: upY > 0.98 && v.forwardSpeed > 10 && t <= 30,
            maxBodyY: +maxY.toFixed(2),
            airTimeS: +airTime.toFixed(2),
            maxPitchDeg: +THREE.MathUtils.radToDeg(maxPitch).toFixed(1),
            maxRollDeg: +THREE.MathUtils.radToDeg(maxRoll).toFixed(1),
            kmh: +(v.forwardSpeed * 3.6).toFixed(1),
          });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'rest': {
      let start: THREE.Vector3 | null = null;
      let maxSpeed = 0;
      return (t, _dt, v, inp) => {
        inp.throttle = inp.brake = inp.steer = 0;
        const p = v.body.translation();
        if (t > 2 && !start) start = new THREE.Vector3(p.x, p.y, p.z);
        const lv = v.body.linvel();
        // Horizontal speed only: Rapier reports the post-step velocity, which includes one step of
        // gravity that the suspension cancels again in the next pre-step.
        if (start) maxSpeed = Math.max(maxSpeed, Math.hypot(lv.x, lv.z));
        if (start && t > 7) {
          const d = new THREE.Vector3(p.x, p.y, p.z).sub(start);
          Object.assign(r, {
            ok: d.length() < 0.01,
            driftCm: +(d.length() * 100).toFixed(3),
            horizontalCm: +(Math.hypot(d.x, d.z) * 100).toFixed(3),
            maxHorizSpeedMms: +(maxSpeed * 1000).toFixed(3),
          });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'reverse': {
      let minV = 0;
      return (t, _dt, v, inp) => {
        inp.throttle = 0;
        inp.brake = t > 1 ? 1 : 0;
        inp.steer = 0;
        minV = Math.min(minV, v.forwardSpeed);
        if (t > 6) {
          Object.assign(r, { ok: v.gear === -1 && minV < -2, gear: v.gear, minSpeedKmh: +(minV * 3.6).toFixed(1) });
          log(r);
          return true;
        }
        return false;
      };
    }
    case 'handbrake': {
      const sc = { i: 0 };
      let h0 = 0;
      let tStart = -1;
      let maxYawRate = 0;
      return (t, dt, v, inp) => {
        if (tStart < 0) {
          inp.steer = pursuit(v, 0, v.body.translation().z + 40);
          speedControl(sc, v, 50 / 3.6, dt, inp);
          if (v.forwardSpeed * 3.6 > 49) {
            tStart = t;
            h0 = bodyHeading(v);
          }
          if (t > 30) {
            Object.assign(r, { note: 'never reached 50 km/h' });
            log(r);
            return true;
          }
          return false;
        }
        const tt = t - tStart;
        inp.throttle = 0;
        inp.brake = 0;
        inp.steer = tt < 1.2 ? -1 : 0;
        inp.handbrake = tt > 0.15 && tt < 1.1;
        maxYawRate = Math.max(maxYawRate, Math.abs(v.body.angvel().y));
        if (tt > 4) {
          let dh = bodyHeading(v) - h0;
          dh = Math.atan2(Math.sin(dh), Math.cos(dh));
          Object.assign(r, {
            headingChangeDeg: +THREE.MathUtils.radToDeg(dh).toFixed(1),
            maxYawRateDegS: +THREE.MathUtils.radToDeg(maxYawRate).toFixed(1),
            endKmh: +(v.forwardSpeed * 3.6).toFixed(1),
          });
          log(r);
          return true;
        }
        return false;
      };
    }
  }
  return null;
}
