// Player vehicle dynamics (owned by the Vehicle module).
//
// A Rapier dynamic rigid body (mass, CG and inertia from the CarSpec) with a rounded compound
// chassis collider, four multi-ray suspensions (rays along the tyre circumference, so curbs are climbed
// smoothly) and a custom tyre model (tyre.ts): combined-slip magic formula with relaxation
// lengths, load sensitivity and per-wheel spin integration. Drivetrain: torque curve from the
// spec, launch clutch, automatic gearbox with kickdown (manual via shiftUp/shiftDown), viscous
// LSD, ABS, traction control, handbrake on the rear wheels, speed-sensitive steering with
// Ackermann and self-aligning, anti-roll bars, aero drag + rolling resistance.
//
// Integration (see report): call physics.step(dt) every frame at priority 10 and setInput()
// before it (priority 0). The vehicle registers its own pre/post physics hooks and a render
// update at priority 20 that writes the interpolated transform into model.root.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { WATER_LEVEL } from '../../config';
import type {
  CarLightState,
  CarModel,
  CarSpec,
  Engine,
  PhysicsWorld,
  PlayerVehicle,
  VehicleInput,
  VehicleTelemetry,
} from '../../contracts';
import { COLLISION_GROUPS } from '../../physics/physics';
import { createEngineModel, RAD_TO_RPM, shiftDuration } from './drivetrain';
import { peakForce, relaxState, TYRE_SHAPE_SLOPE0, tyreShape, type TyreParams } from './tyre';

type RapierModule = typeof RAPIER;

const G = 9.81;
const AIR_DENSITY = 1.225;
/** Tyre / wheel-spin sub-steps per physics step (stiff wheel dynamics). */
const WHEEL_SUBSTEPS = 4;
const DRIVELINE_EFFICIENCY = 0.92;
const ROLLING_RESISTANCE = 0.012;
/** Reverse gear speed limit (m/s), ~35 km/h. */
const REVERSE_MAX_SPEED = 9.7;

export type GearboxMode = 'auto' | 'manual';

export interface WheelState {
  readonly index: number;
  readonly front: boolean;
  readonly left: boolean;
  readonly driven: boolean;
  readonly radius: number;
  grounded: boolean;
  /** Suspension compression from full droop (m). */
  compression: number;
  /** Visual suspension offset relative to the rest position (m, +up). */
  suspensionOffset: number;
  /** Vertical tyre load (N). */
  load: number;
  /** Wheel angular velocity (rad/s, + = rolling forward). */
  omega: number;
  /** Accumulated spin angle (rad, wrapped). */
  spin: number;
  /** Steer angle (rad, + = left). */
  steer: number;
  slipRatio: number;
  /** Slip angle (rad). */
  slipAngle: number;
  /** Normalised combined slip (1 = at the grip peak). */
  slip: number;
  /** Longitudinal / lateral tyre force (N). */
  fx: number;
  fy: number;
  readonly contactPoint: THREE.Vector3;
  readonly contactNormal: THREE.Vector3;
  surfaceTag: string | undefined;
}

export interface VehicleControlsState {
  /** Front wheel steer angle (rad, + = left, average of both wheels). */
  steerAngle: number;
  /** Current speed-dependent steering lock (rad) that input.steer = ±1 maps to. */
  steerLimit: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  horn: boolean;
  headlights: boolean;
  gearboxMode: GearboxMode;
  hold: boolean;
  /** Assist activity this step (for dashboard warning lights / sounds). */
  absActive: boolean;
  tcsActive: boolean;
  escActive: boolean;
}

export interface VehicleAssists {
  /** Electronic stability control: brakes the outer wheels and trims torque when the car
   *  yaws more than the steering asks for (oversteer / spin). Inactive while the handbrake is on. */
  esc: boolean;
  abs: boolean;
  tcs: boolean;
}

/** Extended player vehicle API (superset of the PlayerVehicle contract). */
export interface PlayerVehicleExt extends PlayerVehicle {
  /** Rapier rigid body of the chassis. */
  readonly body: RAPIER.RigidBody;
  readonly wheelStates: readonly WheelState[];
  readonly controls: Readonly<VehicleControlsState>;
  /** Signed speed along the car's forward axis (m/s). */
  readonly forwardSpeed: number;
  /** Smoothed acceleration in vehicle-local axes (x = left, y = up, z = forward), m/s^2. */
  readonly localAcceleration: THREE.Vector3;
  readonly angularVelocity: THREE.Vector3;
  /** Engine load 0..1 (positive torque fraction) for sound. */
  readonly engineLoad: number;
  /** Physics-rate gear (-1 R, 0 N, 1..n) and engine rpm (telemetry is updated once per frame). */
  readonly gear: number;
  readonly engineRpm: number;
  /** True while a gear change is in progress. */
  readonly isShifting: boolean;
  /** True when the car is in the canal. */
  readonly inWater: boolean;
  /** Dimensions used by cameras (m). */
  readonly dims: { length: number; width: number; height: number; wheelbase: number };
  setGearboxMode(mode: GearboxMode): void;
  setAssists(a: Partial<VehicleAssists>): void;
  setHeadlights(on: boolean): void;
  /** Put the car upright at a safe nearby spot (same as input.reset). */
  reset(): void;
  /** Freeze the car (e.g. while paused / in menus): the body is made kinematic and inputs ignored. */
  setFrozen(frozen: boolean): void;
  /** Callback for collisions: impulse (N s) and impact speed (m/s). */
  onImpact(fn: (impulse: number, deltaV: number) => void): () => void;
}

export interface VehicleOptions {
  /** Automatically reset when upside down or in the canal for a few seconds (default true). */
  autoReset?: boolean;
  /** Add model.root to engine.scene (default true). */
  addToScene?: boolean;
}

interface WheelConfig {
  rest: THREE.Vector3;
  hardpoint: THREE.Vector3;
  front: boolean;
  left: boolean;
  driven: boolean;
  radius: number;
  staticLoad: number;
  springK: number;
  damperBump: number;
  damperRebound: number;
  brakeCap: number;
  inertia: number;
  rollCentre: number;
}

interface InternalWheel extends WheelState {
  cfg: WheelConfig;
  prevCompression: number;
  kappa: number;
  tanAlpha: number;
  absFactor: number;
  driveTorque: number;
  fxAcc: number;
  fyAcc: number;
  // per-step contact frame (world)
  readonly fw: THREE.Vector3;
  readonly lat: THREE.Vector3;
  vLong: number;
  vLat: number;
  peak: number;
  surfaceGrip: number;
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function createPlayerVehicle(
  engine: Engine,
  physics: PhysicsWorld,
  spec: CarSpec,
  model: CarModel,
  options: VehicleOptions = {},
): PlayerVehicleExt {
  const R = physics.RAPIER as RapierModule;
  const world = physics.world as RAPIER.World;
  const autoReset = options.autoReset ?? true;

  // ------------------------------------------------------------------------------------------
  // Derived parameters
  // ------------------------------------------------------------------------------------------
  const mass = clamp(spec.massKg, 500, 4000);
  const radius = clamp(spec.wheelRadius, 0.2, 0.5);
  const van = spec.category === 'bestelbus';
  const sporty = spec.category === 'sedan';
  const clearance = van ? 0.17 : sporty ? 0.13 : 0.14;
  const travel = clamp(spec.suspensionTravel || 0.2, 0.12, 0.32);
  const bump = 0.55 * travel;
  const droop = travel - bump;

  // Wheel rest centres: take x/z from the visual model so wheels line up with the arches.
  const restCenters = [0, 1, 2, 3].map((i) => {
    const front = i < 2;
    const left = i % 2 === 0;
    const m = model.wheelCenters?.[i];
    const track = front ? spec.trackFront : spec.trackRear;
    const fallback = new THREE.Vector3((left ? 1 : -1) * track / 2, radius, (front ? 1 : -1) * spec.wheelbase / 2);
    if (!m || !Number.isFinite(m.x + m.y + m.z) || Math.abs(m.z) < 0.5) return fallback;
    const y = m.y > 0.6 * radius && m.y < 1.6 * radius ? m.y : radius;
    return new THREE.Vector3(m.x, y, m.z);
  });
  const zFront = (restCenters[0].z + restCenters[1].z) / 2;
  const zRear = (restCenters[2].z + restCenters[3].z) / 2;
  const wheelbase = Math.max(1.5, zFront - zRear);
  const frontWeight = clamp(spec.frontWeight, 0.35, 0.7);
  const cgZ = zRear + frontWeight * wheelbase;
  const cgY = clamp(spec.cgHeight, 0.35, 1.1);
  const trackFront = Math.abs(restCenters[0].x - restCenters[1].x);
  const trackRear = Math.abs(restCenters[2].x - restCenters[3].x);

  const length = spec.length;
  const width = spec.width;
  const height = spec.height;
  // Box inertia with a small reduction (mass is concentrated between the axles).
  const inertia = {
    x: (mass / 12) * (height * height + length * length) * 0.85, // pitch
    y: (mass / 12) * (width * width + length * length) * 0.85, // yaw
    z: (mass / 12) * (width * width + height * height) * 0.9, // roll
  };

  const frontCornerLoad = (mass * G * frontWeight) / 2;
  const rearCornerLoad = (mass * G * (1 - frontWeight)) / 2;
  const springHzFront = van ? 1.3 : sporty ? 1.6 : 1.45;
  const springHzRear = van ? 1.45 : sporty ? 1.75 : 1.6;

  const tyre: TyreParams = {
    mu: van ? 1.03 : sporty ? 1.17 : spec.category === 'stadsauto' ? 1.07 : 1.12,
    kappaPeak: 0.11,
    tanAlphaPeak: Math.tan(THREE.MathUtils.degToRad(sporty ? 7 : van ? 8.5 : 7.5)),
    lateralScale: 0.97,
    relaxLong: 0.18,
    relaxLat: 0.32,
    loadSensitivity: 0.12,
    nominalLoad: (mass * G) / 4,
  };

  const driven = (i: number): boolean =>
    spec.drivetrain === 'awd' ? true : spec.drivetrain === 'fwd' ? i < 2 : i >= 2;
  const drivenCount = spec.drivetrain === 'awd' ? 4 : 2;

  const totalBrakeTorque = 1.35 * tyre.mu * mass * G * radius;
  const brakeBiasFront = clamp(frontWeight + 0.12, 0.6, 0.76);
  const handbrakeTorque = 0.55 * tyre.mu * mass * G * radius;
  const wheelInertiaBase = 0.55 + 1.0 * Math.pow(radius / 0.31, 2) * Math.pow(mass / 1300, 0.35);

  const engineModel = createEngineModel(spec);
  const gearRatios = spec.gearRatios.length > 0 ? spec.gearRatios.slice() : [1];
  const finalDrive = spec.finalDrive > 0 ? spec.finalDrive : 1;
  const nGears = gearRatios.length;
  const shiftTime = shiftDuration(spec);
  const topSpeed = Math.max(60, spec.topSpeedKmh) / 3.6;

  // Aerodynamic drag area from the power balance at top speed.
  const pWheel = engineModel.maxPowerW * DRIVELINE_EFFICIENCY;
  const cdA = clamp(
    (pWheel / topSpeed - ROLLING_RESISTANCE * mass * G) / (0.5 * AIR_DENSITY * topSpeed * topSpeed),
    0.45,
    1.6,
  );
  const maxSteer = THREE.MathUtils.degToRad(clamp(spec.maxSteerDeg, 25, 45));

  const wheelConfigs: WheelConfig[] = restCenters.map((rest, i) => {
    const front = i < 2;
    const staticLoad = front ? frontCornerLoad : rearCornerLoad;
    const sprung = (staticLoad / G) * 0.88;
    const omega = 2 * Math.PI * (front ? springHzFront : springHzRear);
    const k = sprung * omega * omega;
    const crit = 2 * Math.sqrt(k * sprung);
    return {
      rest,
      hardpoint: rest.clone().add(new THREE.Vector3(0, bump, 0)),
      front,
      left: i % 2 === 0,
      driven: driven(i),
      radius,
      staticLoad,
      springK: k,
      damperBump: crit * 0.32,
      damperRebound: crit * 0.55,
      brakeCap: (totalBrakeTorque * (front ? brakeBiasFront : 1 - brakeBiasFront)) / 2,
      inertia: wheelInertiaBase,
      rollCentre: front ? 0.07 : 0.14,
    };
  });
  const arbFront = wheelConfigs[0].springK * (van ? 0.5 : 0.6);
  const arbRear = wheelConfigs[2].springK * (sporty ? 0.35 : 0.25);

  // ------------------------------------------------------------------------------------------
  // Rigid body + chassis colliders
  // ------------------------------------------------------------------------------------------
  const bodyDesc = R.RigidBodyDesc.dynamic()
    .setTranslation(0, 0.05, 0)
    .setAdditionalMassProperties(mass, { x: 0, y: cgY, z: cgZ }, inertia, { x: 0, y: 0, z: 0, w: 1 })
    .setAngularDamping(0.05)
    .setCanSleep(false)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);

  const beltY = clearance + 0.5 * (height - clearance);
  const halfW = Math.max(width / 2, Math.max(trackFront, trackRear) / 2 + spec.wheelWidth / 2 + 0.01);
  const lowerHalfH = (beltY - clearance) / 2;
  const border = 0.08;
  const chassisColliders: RAPIER.Collider[] = [];
  const lowerDesc = R.ColliderDesc.roundCuboid(halfW - border, lowerHalfH - border, length / 2 - border, border)
    .setTranslation(0, clearance + lowerHalfH, 0)
    .setDensity(0);
  const cabinLen = van ? length * 0.86 : length * 0.5;
  const cabinHalfH = (height - beltY) / 2;
  const cabinDesc = R.ColliderDesc.roundCuboid(
    (van ? halfW : width * 0.42) - border,
    Math.max(0.05, cabinHalfH - border),
    cabinLen / 2 - border,
    border,
  )
    .setTranslation(0, beltY + cabinHalfH, van ? -length * 0.05 : -length * 0.06)
    .setDensity(0);
  for (const d of [lowerDesc, cabinDesc]) {
    d.setFriction(0.35)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min)
      .setRestitution(0.12)
      .setCollisionGroups(COLLISION_GROUPS.playerChassis);
    chassisColliders.push(world.createCollider(d, body));
  }

  // ------------------------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------------------------
  const wheels: InternalWheel[] = wheelConfigs.map((cfg, i) => ({
    index: i,
    front: cfg.front,
    left: cfg.left,
    driven: cfg.driven,
    radius: cfg.radius,
    grounded: false,
    compression: 0,
    suspensionOffset: 0,
    load: 0,
    omega: 0,
    spin: 0,
    steer: 0,
    slipRatio: 0,
    slipAngle: 0,
    slip: 0,
    fx: 0,
    fy: 0,
    contactPoint: new THREE.Vector3(),
    contactNormal: new THREE.Vector3(0, 1, 0),
    surfaceTag: undefined,
    cfg,
    prevCompression: droop,
    kappa: 0,
    tanAlpha: 0,
    absFactor: 1,
    driveTorque: 0,
    fxAcc: 0,
    fyAcc: 0,
    fw: new THREE.Vector3(),
    lat: new THREE.Vector3(),
    vLong: 0,
    vLat: 0,
    peak: 0,
    surfaceGrip: 1,
  }));

  const input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const pending = { shiftUp: false, shiftDown: false, reset: false };
  const controls: VehicleControlsState = {
    steerAngle: 0,
    steerLimit: maxSteer,
    throttle: 0,
    brake: 0,
    handbrake: false,
    horn: false,
    headlights: false,
    gearboxMode: 'auto',
    hold: false,
    absActive: false,
    tcsActive: false,
    escActive: false,
  };
  const assists: VehicleAssists = { abs: true, tcs: true, esc: true };

  let gear = 1; // -1 R, 0 N, 1..n
  let shiftTimer = 0;
  let shiftCooldown = 0;
  let manualHoldTimer = 0;
  let reverseTimer = 0;
  let forwardTimer = 0;
  let engineRpm = engineModel.idleRpm;
  let clutchLocked = false;
  let fuelCut = false;
  let tcsFactor = 1;
  let throttleEff = 0;
  let brakeEff = 0;
  let throttleSmooth = 0;
  let engineLoad = 0;
  let steerAngle = 0; // rad, + left (centre-line angle before Ackermann)
  let forwardSpeed = 0;
  let frozen = false;
  /** placeAt() ran while frozen: zero the restored dynamic velocity on unfreeze. */
  let zeroVelOnThaw = false;
  let inWater = false;
  let waterTimer = 0;
  let flipTimer = 0;
  let impactAccum = 0;
  let impactDv = 0;
  /** Physics steps to ignore for impact detection (after teleports / resets). */
  let skipImpactSteps = 0;

  const telemetry: VehicleTelemetry = {
    speedKmh: 0,
    rpm: engineRpm,
    gear,
    throttle: 0,
    brake: 0,
    slip: 0,
    grounded: [false, false, false, false],
    impact: 0,
  };

  // Interpolation buffers
  const prevPos = new THREE.Vector3();
  const curPos = new THREE.Vector3();
  const prevQuat = new THREE.Quaternion();
  const curQuat = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const velocity = new THREE.Vector3();
  const angularVelocity = new THREE.Vector3();
  const localAcceleration = new THREE.Vector3();
  const lastVel = new THREE.Vector3();
  let heading = 0;

  // Safe positions for reset (ring buffer)
  const safeSpots: { x: number; y: number; z: number; heading: number }[] = [];
  let safeTimer = 0;

  // Temps (no per-step allocations in hot paths besides Rapier's own wrappers)
  const q = new THREE.Quaternion();
  const axLeft = new THREE.Vector3();
  const axUp = new THREE.Vector3();
  const axFwd = new THREE.Vector3();
  const linv = new THREE.Vector3();
  const angv = new THREE.Vector3();
  const com = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const hp = new THREE.Vector3();
  const preStepVel = new THREE.Vector3();
  const invQ = new THREE.Quaternion();
  const impulse = new THREE.Vector3();
  const lightState: CarLightState = { head: false, brake: false, reverse: false };
  const lastLights = { head: false, brake: false, reverse: false };
  const impactListeners: ((impulse: number, deltaV: number) => void)[] = [];
  const rapierVec = { x: 0, y: 0, z: 0 };
  const rapierVec2 = { x: 0, y: 0, z: 0 };

  function readPose(): void {
    const t = body.translation();
    const r = body.rotation();
    pos.set(t.x, t.y, t.z);
    q.set(r.x, r.y, r.z, r.w);
    axLeft.set(1, 0, 0).applyQuaternion(q);
    axUp.set(0, 1, 0).applyQuaternion(q);
    axFwd.set(0, 0, 1).applyQuaternion(q);
    const lv = body.linvel();
    linv.set(lv.x, lv.y, lv.z);
    const av = body.angvel();
    angv.set(av.x, av.y, av.z);
    const c = body.worldCom();
    com.set(c.x, c.y, c.z);
  }

  function applyImpulseAt(imp: THREE.Vector3, point: THREE.Vector3): void {
    rapierVec.x = imp.x;
    rapierVec.y = imp.y;
    rapierVec.z = imp.z;
    rapierVec2.x = point.x;
    rapierVec2.y = point.y;
    rapierVec2.z = point.z;
    body.applyImpulseAtPoint(rapierVec, rapierVec2, true);
  }

  function gearRatio(g: number): number {
    if (g >= 1) return gearRatios[Math.min(g, nGears) - 1] * finalDrive;
    if (g === -1) return -(spec.reverseRatio > 0 ? spec.reverseRatio : gearRatios[0]) * finalDrive;
    return 0;
  }

  function drivenOmega(): number {
    let s = 0;
    for (const w of wheels) if (w.driven) s += w.omega;
    return s / drivenCount;
  }

  function startShift(target: number): void {
    if (target === gear) return;
    const up = target > gear;
    gear = target;
    shiftTimer = engineModel.electric ? 0 : shiftTime;
    shiftCooldown = up ? 0.7 : 0.45;
    clutchLocked = false;
  }

  // ------------------------------------------------------------------------------------------
  // Controls / gearbox (once per physics step)
  // ------------------------------------------------------------------------------------------
  function processControls(dt: number): void {
    const thrIn = clamp(input.throttle, 0, 1);
    const brkIn = clamp(input.brake, 0, 1);
    const v = forwardSpeed;

    // Manual shift requests.
    if (pending.shiftUp || pending.shiftDown) {
      const omegaD = drivenOmega();
      if (pending.shiftUp) {
        if (gear === -1) {
          if (v > -1.5) startShift(1);
        } else if (gear < nGears) startShift(gear + 1);
      }
      if (pending.shiftDown) {
        if (gear === 1 || gear === 0) {
          if (v < 1.5) startShift(-1);
        } else if (gear > 1) {
          const rpmLower = Math.abs(omegaD * gearRatio(gear - 1)) * RAD_TO_RPM;
          if (rpmLower < engineModel.redlineRpm * 1.02) startShift(gear - 1);
        }
      }
      pending.shiftUp = pending.shiftDown = false;
      if (controls.gearboxMode === 'auto') manualHoldTimer = 6;
    }

    // Brake-to-reverse and throttle-to-forward at (near) standstill.
    if (gear >= 0 && brkIn > 0.3 && thrIn < 0.05 && v < 0.6) {
      reverseTimer += dt;
      if (reverseTimer > 0.3 && v < 0.3) {
        startShift(-1);
        shiftTimer = 0;
        reverseTimer = 0;
      }
    } else reverseTimer = 0;
    if (gear === -1 && thrIn > 0.3 && brkIn < 0.05 && v > -0.6) {
      forwardTimer += dt;
      if (forwardTimer > 0.3 && v > -0.3) {
        startShift(1);
        shiftTimer = 0;
        forwardTimer = 0;
      }
    } else forwardTimer = 0;
    if (gear === 0 && thrIn > 0.3) startShift(1);

    if (gear === -1) {
      throttleEff = brkIn;
      brakeEff = thrIn;
    } else {
      throttleEff = thrIn;
      brakeEff = brkIn;
    }
    throttleSmooth += (throttleEff - throttleSmooth) * (1 - Math.exp(-dt / 0.25));

    controls.hold = Math.abs(v) < 0.35 && throttleEff < 0.02;
    controls.throttle = throttleEff;
    controls.brake = brakeEff;
    controls.handbrake = !!input.handbrake;

    // Gear change timing.
    if (shiftTimer > 0) shiftTimer = Math.max(0, shiftTimer - dt);
    if (shiftCooldown > 0) shiftCooldown -= dt;
    if (manualHoldTimer > 0) manualHoldTimer -= dt;

    // Automatic gearbox.
    const autoActive = controls.gearboxMode === 'auto' && manualHoldTimer <= 0 && !engineModel.electric;
    if (autoActive && gear >= 1 && shiftTimer <= 0 && shiftCooldown <= 0) {
      const omegaD = drivenOmega();
      const groundRpm = (Math.max(0, v) / radius) * gearRatio(gear) * RAD_TO_RPM;
      const wheelRpm = Math.max(0, omegaD) * gearRatio(gear) * RAD_TO_RPM;
      // Use the ground-speed rpm when the wheels spin so we don't upshift during wheelspin.
      const rpm = Math.min(wheelRpm, groundRpm * 1.12 + 300);
      const redline = engineModel.redlineRpm;
      const thr = Math.max(throttleSmooth, throttleEff * 0.7);
      const upRpm = redline * (0.36 + 0.58 * Math.pow(thr, 1.2));
      const downRpm = redline * (0.2 + 0.36 * thr);
      const anyGrounded = wheels.some((w) => w.grounded);
      const braking = brakeEff > 0.05;
      if (gear < nGears && rpm > upRpm && anyGrounded && !braking && (wheelRpm < redline * 1.05 || thr < 0.95)) {
        const rpmNext = (rpm * gearRatios[gear]) / gearRatios[gear - 1];
        if (rpmNext > engineModel.idleRpm * 1.15) startShift(gear + 1);
      } else if (gear > 1 && rpm < downRpm) {
        let target = gear;
        const limit = upRpm * 0.9;
        if (thr > 0.8) {
          // Kickdown: lowest gear that keeps the rpm below the upshift point.
          for (let g = gear - 1; g >= 1; g--) {
            const r = (rpm * gearRatios[g - 1]) / gearRatios[gear - 1];
            if (r < limit) target = g;
            else break;
          }
        } else {
          const r = (rpm * gearRatios[gear - 2]) / gearRatios[gear - 1];
          if (r < limit) target = gear - 1;
        }
        if (target !== gear) startShift(target);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Steering
  // ------------------------------------------------------------------------------------------
  function updateSteering(dt: number): void {
    const v = Math.max(Math.abs(forwardSpeed), 0.1);
    const vLatBody = linv.dot(axLeft);
    const beta = Math.atan2(vLatBody, v); // + = sliding towards the left
    const sf = clamp((v - 15) / 25, 0, 1); // 0 below ~55 km/h, 1 above ~145 km/h
    // Max useful angle: grip-limited cornering angle + peak slip angle (less at high speed) +
    // extra lock only while countersteering (steering towards the direction of travel).
    const gripAngle = Math.atan((wheelbase * tyre.mu * G) / (v * v));
    const slipRoom = Math.atan(tyre.tanAlphaPeak) * lerp(1.2, 0.8, sf);
    const wanted = -clamp(input.steer, -1, 1); // + = left
    const counterRoom = wanted * beta > 0 ? Math.abs(beta) * 0.9 : 0;
    const limit = Math.min(maxSteer, gripAngle + slipRoom + counterRoom);
    let target = wanted * limit;
    if (Math.abs(input.steer) < 0.05 && forwardSpeed > 4) {
      // Self-aligning: the front wheels follow the direction of travel of the front axle.
      tmpA.copy(axFwd).multiplyScalar(zFront - cgZ);
      tmpB.crossVectors(angv, tmpA).add(linv);
      const betaF = Math.atan2(tmpB.dot(axLeft), Math.max(tmpB.dot(axFwd), 0.5));
      target = clamp(betaF * 0.5, -limit, limit);
    }
    const rate = Math.max(0.6, limit * lerp(3.4, 2.2, sf));
    const d = target - steerAngle;
    steerAngle += clamp(d, -rate * dt, rate * dt);

    // Ackermann (60%).
    const a = steerAngle;
    if (Math.abs(a) < 1e-4) {
      wheels[0].steer = wheels[1].steer = 0;
    } else {
      const rTurn = wheelbase / Math.tan(Math.abs(a));
      const inner = Math.atan(wheelbase / Math.max(0.5, rTurn - trackFront / 2));
      const outer = Math.atan(wheelbase / (rTurn + trackFront / 2));
      const s = Math.sign(a);
      const innerA = lerp(Math.abs(a), inner, 0.6) * s;
      const outerA = lerp(Math.abs(a), outer, 0.6) * s;
      // Left turn (a > 0): the left wheel (index 0) is the inner wheel.
      wheels[0].steer = a > 0 ? innerA : outerA;
      wheels[1].steer = a > 0 ? outerA : innerA;
    }
    wheels[2].steer = wheels[3].steer = 0;
    controls.steerAngle = (wheels[0].steer + wheels[1].steer) / 2;
    controls.steerLimit = limit;
  }

  // ------------------------------------------------------------------------------------------
  // Suspension
  // ------------------------------------------------------------------------------------------
  // Wheel ground probe: parallel rays along the tyre's circumference (in the wheel plane)
  // approximate a cylinder sweep. A ray hitting the ground at longitudinal offset s requires the
  // wheel centre to be sqrt(R^2 - s^2) above that point. Where two neighbouring rays see a step
  // (curb edge), a short bisection locates the edge so the wheel climbs it continuously instead
  // of in jumps. Rays are used instead of a shape cast because they are numerically robust on
  // the very large / long triangles of the city ground meshes.
  const PROBE_OFFSETS = [-0.92, -0.7, -0.45, -0.2, 0, 0.2, 0.45, 0.7, 0.92];
  const CENTRE_PROBE = 4;
  const PROBE_FIRST = [4, 0, 8];
  const probeToi = new Float64Array(PROBE_OFFSETS.length);
  const probeNx = new Float64Array(PROBE_OFFSETS.length);
  const probeNy = new Float64Array(PROBE_OFFSETS.length);
  const probeNz = new Float64Array(PROBE_OFFSETS.length);
  const probeCol: (RAPIER.Collider | null)[] = PROBE_OFFSETS.map(() => null);
  const castOrigin = { x: 0, y: 0, z: 0 };
  const castDir = { x: 0, y: 0, z: 0 };
  const ray = new R.Ray(castOrigin, castDir);
  const tagOf = (physics as { tagOf?: (h: number) => string | undefined }).tagOf;
  let lastHit: RAPIER.RayColliderIntersection | null = null;

  /** Cast one probe ray at longitudinal offset s (m). Returns toi or Infinity. */
  function probe(s: number, maxToi: number): number {
    castOrigin.x = hp.x + tmpA.x * s;
    castOrigin.y = hp.y + tmpA.y * s;
    castOrigin.z = hp.z + tmpA.z * s;
    ray.origin = castOrigin;
    const hit = world.castRayAndGetNormal(
      ray,
      maxToi,
      true,
      R.QueryFilterFlags.ONLY_FIXED,
      COLLISION_GROUPS.queryStatic,
      undefined,
      body,
    );
    lastHit = hit;
    if (!hit) return Infinity;
    // Vertical faces are handled by the chassis collider.
    if (hit.normal.x * axUp.x + hit.normal.y * axUp.y + hit.normal.z * axUp.z < 0.2) return Infinity;
    return hit.timeOfImpact;
  }

  function castWheel(w: InternalWheel): number {
    hp.copy(w.cfg.hardpoint).applyQuaternion(q).add(pos);
    // Wheel heading (steered) in world space.
    tmpA.set(Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(q);
    castDir.x = -axUp.x;
    castDir.y = -axUp.y;
    castDir.z = -axUp.z;
    const maxToi = travel + radius;
    const r2 = radius * radius;
    let best = Infinity;
    let bestS = 0;
    let bestToi = 0;
    let bestCol: RAPIER.Collider | null = null;
    // Fast path: centre + both outer rays first; when they agree within 1 cm the ground under the
    // tyre is flat (or a gentle slope) and the inner rays add nothing.
    let flat = true;
    for (const k of PROBE_FIRST) {
      probeToi[k] = probe(PROBE_OFFSETS[k] * radius, maxToi);
      probeCol[k] = probeToi[k] < Infinity && lastHit ? lastHit.collider : null;
      if (probeToi[k] < Infinity && lastHit) {
        probeNx[k] = lastHit.normal.x;
        probeNy[k] = lastHit.normal.y;
        probeNz[k] = lastHit.normal.z;
      }
    }
    const tc = probeToi[CENTRE_PROBE];
    if (!(tc < Infinity) || Math.abs(probeToi[0] - tc) > 0.01 || Math.abs(probeToi[PROBE_OFFSETS.length - 1] - tc) > 0.01) flat = false;
    for (let k = 0; k < PROBE_OFFSETS.length; k++) {
      const s = PROBE_OFFSETS[k] * radius;
      const first = k === 0 || k === CENTRE_PROBE || k === PROBE_OFFSETS.length - 1;
      if (flat && !first) {
        probeToi[k] = Infinity;
        continue;
      }
      const toi = first ? probeToi[k] : probe(s, maxToi);
      if (!first) {
        probeToi[k] = toi;
        probeCol[k] = toi < Infinity && lastHit ? lastHit.collider : null;
        if (toi < Infinity && lastHit) {
          probeNx[k] = lastHit.normal.x;
          probeNy[k] = lastHit.normal.y;
          probeNz[k] = lastHit.normal.z;
        }
      }
      const d = toi - Math.sqrt(r2 - s * s);
      if (d < best) {
        best = d;
        bestS = s;
        bestToi = toi;
        bestCol = probeCol[k];
      }
    }
    // Refine steps between neighbouring probes (ground height jump > 1.5 cm).
    for (let k = 0; k < PROBE_OFFSETS.length - 1 && !flat; k++) {
      const ta = probeToi[k];
      const tb = probeToi[k + 1];
      if (Math.abs(ta - tb) < 0.015 || (ta === Infinity && tb === Infinity)) continue;
      // hi = the probe on the higher ground (smaller toi), lo = the other one.
      let sHi = (tb < ta ? PROBE_OFFSETS[k + 1] : PROBE_OFFSETS[k]) * radius;
      let sLo = (tb < ta ? PROBE_OFFSETS[k] : PROBE_OFFSETS[k + 1]) * radius;
      let tHi = Math.min(ta, tb);
      const tLo = Math.max(ta, tb);
      let colHi = tb < ta ? probeCol[k + 1] : probeCol[k];
      const split = tLo === Infinity ? tHi + 0.02 : (tHi + tLo) / 2;
      for (let it = 0; it < 4; it++) {
        const sm = (sHi + sLo) / 2;
        const tm = probe(sm, maxToi);
        if (tm < split) {
          sHi = sm;
          tHi = tm;
          colHi = lastHit ? lastHit.collider : colHi;
        } else sLo = sm;
      }
      // The edge lies between sLo and sHi; the tyre touches it at sHi (closest high point).
      const s = sHi;
      if (Math.abs(s) >= radius) continue;
      const d = tHi - Math.sqrt(r2 - s * s);
      if (d < best) {
        best = d;
        bestS = s;
        bestToi = tHi;
        bestCol = colHi;
      }
    }
    if (best === Infinity || !bestCol) return -1;
    w.contactPoint.copy(hp).addScaledVector(tmpA, bestS).addScaledVector(axUp, -bestToi);
    const centreToi = probeToi[CENTRE_PROBE];
    const centreD = centreToi - radius;
    if (centreToi < Infinity && centreD - best < 0.004) {
      // Practically flat under the wheel: use the surface normal of the centre ray.
      w.contactNormal.set(probeNx[CENTRE_PROBE], probeNy[CENTRE_PROBE], probeNz[CENTRE_PROBE]);
    } else {
      // Edge contact (curb / step): normal points from the contact point to the wheel centre.
      w.contactNormal.copy(axUp).multiplyScalar(Math.sqrt(r2 - bestS * bestS)).addScaledVector(tmpA, -bestS).normalize();
    }
    w.surfaceGrip = bestCol.friction();
    w.surfaceTag = tagOf?.(bestCol.handle);
    return Math.max(0, best);
  }

  const suspForce = [0, 0, 0, 0];

  // ------------------------------------------------------------------------------------------
  // Stability control (ESC)
  // ------------------------------------------------------------------------------------------
  const escBrake = [0, 0, 0, 0];
  let escCut = 1;
  let escActive = false;

  function updateEsc(): void {
    escBrake[0] = escBrake[1] = escBrake[2] = escBrake[3] = 0;
    escCut = 1;
    escActive = false;
    const v = forwardSpeed;
    if (!assists.esc || input.handbrake || v < 5) return;
    // Reference yaw rate from the steering (bicycle model with a little understeer), limited
    // by what the tyres can deliver.
    const delta = (wheels[0].steer + wheels[1].steer) / 2;
    const rMax = (tyre.mu * G) / v;
    const rRef = clamp((v * Math.tan(delta)) / (wheelbase * (1 + 0.0012 * v * v)), -rMax, rMax);
    const r = angv.dot(axUp); // + = yawing left
    const beta = Math.atan2(linv.dot(axLeft), v);
    let excess = Math.sign(r) === Math.sign(rRef) ? Math.abs(r) - Math.abs(rRef) : Math.abs(r);
    excess += -0.08 + Math.max(0, Math.abs(beta) - 0.1) * 1.5;
    if (excess <= 0) return;
    escActive = true;
    // Yawing left too much -> brake the right (outer) wheels, and vice versa.
    const front = r > 0 ? 1 : 0;
    const rear = r > 0 ? 3 : 2;
    escBrake[front] = Math.min(wheelConfigs[front].brakeCap, excess * wheelConfigs[front].brakeCap * 3);
    escBrake[rear] = Math.min(wheelConfigs[rear].brakeCap * 0.6, excess * wheelConfigs[rear].brakeCap * 1.5);
    escCut = clamp(1 - excess * 2.5, 0.25, 1);
  }

  // ------------------------------------------------------------------------------------------
  // Main physics step
  // ------------------------------------------------------------------------------------------
  function preStep(dt: number): void {
    if (frozen) return;
    if (pending.reset) {
      pending.reset = false;
      doReset();
    }
    readPose();
    forwardSpeed = linv.dot(axFwd);
    processControls(dt);
    updateSteering(dt);

    // 1. Suspension casts.
    for (const w of wheels) {
      const d = castWheel(w);
      if (d >= 0 && d <= travel) {
        w.grounded = true;
        w.compression = travel - d;
      } else {
        w.grounded = false;
        w.compression = 0;
        w.surfaceTag = undefined;
      }
      w.suspensionOffset = w.compression - droop;
    }

    // 2. Spring / damper / bump stop / anti-roll forces.
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      const cfg = w.cfg;
      if (!w.grounded) {
        suspForce[i] = 0;
        w.prevCompression = w.compression;
        continue;
      }
      const c = w.compression;
      const cv = clamp((c - w.prevCompression) / dt, -2.5, 2.5);
      w.prevCompression = c;
      let f = cfg.staticLoad + cfg.springK * (c - droop);
      f += (cv > 0 ? cfg.damperBump : cfg.damperRebound) * cv;
      const bs = c - 0.72 * travel;
      // Progressive rubber bump stop (also stands in for tyre sidewall compliance).
      if (bs > 0) f += cfg.springK * (6 * bs + (90 * bs * bs) / Math.max(travel, 0.1));
      suspForce[i] = f;
    }
    for (let axle = 0; axle < 2; axle++) {
      const l = axle * 2;
      const r = l + 1;
      const k = axle === 0 ? arbFront : arbRear;
      const df = k * (wheels[l].compression - wheels[r].compression);
      if (wheels[l].grounded) suspForce[l] += df;
      if (wheels[r].grounded) suspForce[r] -= df;
    }

    // 3. Contact frames and loads.
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      w.load = w.grounded ? Math.max(0, suspForce[i]) : 0;
      if (!w.grounded) {
        w.peak = 0;
        continue;
      }
      const n = w.contactNormal;
      // Wheel heading in world, projected onto the contact plane.
      tmpA.set(Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(q);
      w.fw.copy(tmpA).addScaledVector(n, -tmpA.dot(n)).normalize();
      w.lat.crossVectors(n, w.fw).normalize();
      // Contact point velocity.
      tmpB.copy(w.contactPoint).sub(com);
      tmpC.crossVectors(angv, tmpB).add(linv);
      w.vLong = tmpC.dot(w.fw);
      w.vLat = tmpC.dot(w.lat);
      w.peak = peakForce(tyre, w.load, w.surfaceGrip);
      w.fxAcc = 0;
      w.fyAcc = 0;
    }

    // 4. Stability control, then drivetrain + tyres with wheel sub-steps.
    updateEsc();
    const h = dt / WHEEL_SUBSTEPS;
    const Gr = gearRatio(gear);
    // Soft speed limiters: spec top speed forwards, REVERSE_MAX_SPEED backwards.
    const limiter =
      gear === -1
        ? clamp(1 - (-forwardSpeed - REVERSE_MAX_SPEED + 0.8) / 0.8, 0, 1)
        : clamp(1 - (forwardSpeed - topSpeed - 0.3) / 1.5, 0, 1);
    let loadAcc = 0;
    let absActiveStep = false;
    for (let s = 0; s < WHEEL_SUBSTEPS; s++) {
      // --- engine / clutch ---
      const omegaD = drivenOmega();
      let wheelTorqueTotal = 0;
      let reflectedInertia = 0;
      const thr = throttleEff;
      if (engineModel.electric) {
        const rpm = Math.abs(omegaD * Gr) * RAD_TO_RPM;
        engineRpm = rpm;
        clutchLocked = true;
        const dir = Math.sign(omegaD * Gr) || 1;
        const regen = (1 - thr) * engineModel.dragTorque(rpm) * dir;
        const te = Gr === 0 ? 0 : thr * engineModel.fullTorque(rpm) * tcsFactor * escCut * limiter - regen;
        wheelTorqueTotal = te * Gr * DRIVELINE_EFFICIENCY;
        reflectedInertia = (engineModel.inertia * Gr * Gr) / drivenCount;
        loadAcc += te > 0 ? te / engineModel.maxTorque : 0;
      } else if (Gr === 0 || shiftTimer > 0) {
        // Clutch open: engine spins towards the rpm of the (new) gear, with a throttle blip.
        const target = Gr === 0 ? engineModel.idleRpm + thr * 2500 : Math.max(engineModel.idleRpm, omegaD * Gr * RAD_TO_RPM);
        engineRpm += (target - engineRpm) * (1 - Math.exp(-h * 14));
        clutchLocked = false;
      } else {
        const cr = omegaD * Gr * RAD_TO_RPM; // positive when rolling in the gear's direction
        const launch = engineModel.launchRpm(thr);
        const lockRpm = Math.abs(gear) === 1 ? Math.max(launch, engineModel.idleRpm) : engineModel.idleRpm * 0.85;
        // Hard braking: the converter / clutch decouples the engine inertia from the wheels
        // (keeps ABS effective); the engine keeps turning with the wheels for sound / display.
        const brakeDecouple = brakeEff > 0.3 && thr < 0.05;
        if (brakeDecouple || (clutchLocked ? cr < lockRpm - 120 : cr < lockRpm)) clutchLocked = false;
        else clutchLocked = true;
        if (brakeDecouple) {
          engineRpm = Math.max(engineModel.idleRpm, cr);
        } else if (clutchLocked) {
          engineRpm = cr;
          if (engineRpm > engineModel.redlineRpm) fuelCut = true;
          else if (engineRpm < engineModel.redlineRpm - 250) fuelCut = false;
          const thrE = fuelCut ? 0 : thr;
          const te = thrE * engineModel.fullTorque(engineRpm) * tcsFactor * escCut * limiter - (1 - thrE) * engineModel.dragTorque(engineRpm);
          wheelTorqueTotal = te * Gr * DRIVELINE_EFFICIENCY;
          reflectedInertia = (engineModel.inertia * Gr * Gr) / drivenCount;
          loadAcc += te > 0 ? te / engineModel.maxTorque : 0;
        } else {
          const target = thr > 0.02 ? Math.max(launch, cr) : engineModel.idleRpm;
          engineRpm += (target - engineRpm) * (1 - Math.exp(-h * 7));
          const tc = thr * engineModel.fullTorque(engineRpm) * tcsFactor * escCut * limiter;
          wheelTorqueTotal = tc * Gr * DRIVELINE_EFFICIENCY;
          loadAcc += thr * tcsFactor;
        }
      }

      // --- differential: axle split + viscous limited slip ---
      for (let axle = 0; axle < 2; axle++) {
        const l = wheels[axle * 2];
        const r = wheels[axle * 2 + 1];
        if (!l.driven) {
          l.driveTorque = r.driveTorque = 0;
          continue;
        }
        const share = spec.drivetrain === 'awd' ? (axle === 0 ? 0.4 : 0.6) : 1;
        const tAxle = wheelTorqueTotal * share;
        const lsd = clamp(18 * (l.omega - r.omega), -Math.abs(tAxle) * 0.4 - 60, Math.abs(tAxle) * 0.4 + 60);
        l.driveTorque = tAxle / 2 - lsd;
        r.driveTorque = tAxle / 2 + lsd;
      }

      // --- tyres + wheel spin ---
      let maxDrivenSlip = 0;
      for (const w of wheels) {
        const cfg = w.cfg;
        const inertiaEff = cfg.inertia + (w.driven && clutchLocked ? reflectedInertia : 0);
        // Brake torque request.
        let tb = brakeEff * cfg.brakeCap;
        if (controls.hold) tb = Math.max(tb, cfg.brakeCap * 0.35);
        if (assists.abs && brakeEff > 0.05 && Math.abs(w.vLong) > 1.0 && w.grounded && w.peak > 0) {
          // Model-based ABS: never ask more brake torque than the tyre can transmit at its peak
          // (minus the share needed for the current lateral force), plus the torque that
          // decelerates the wheel together with the car. A slip watchdog trims any overshoot.
          const fxAvail = Math.sqrt(Math.max(0, w.peak * w.peak - w.fy * w.fy));
          const decel = Math.max(0, -localAcceleration.z * Math.sign(w.vLong));
          const cap = fxAvail * cfg.radius * 0.985 + (inertiaEff * decel) / cfg.radius;
          const sxDir = (w.kappa / tyre.kappaPeak) * Math.sign(w.vLong);
          if (sxDir < -1.25) w.absFactor = Math.max(0.3, w.absFactor - h * 10);
          else w.absFactor = Math.min(1, w.absFactor + h * 4);
          if (cap * w.absFactor < tb) absActiveStep = true;
          tb = Math.min(tb, cap * w.absFactor);
        } else w.absFactor = 1;
        // ESC brake pulses act on top of (and are not limited by) the driver's ABS-capped braking;
        // the extra longitudinal slip also trims that wheel's lateral force (friction circle).
        if (escBrake[w.index] > 0) tb += Math.min(escBrake[w.index], 0.7 * w.peak * cfg.radius);
        if (input.handbrake && !cfg.front) tb += handbrakeTorque;

        let fx = 0;
        let fy = 0;
        let cb = 0; // low-speed longitudinal damping coefficient (implicit)
        let fs = 0; // longitudinal force from the slip state
        if (w.grounded && w.peak > 0) {
          const absV = Math.abs(w.vLong);
          w.kappa = relaxState(w.kappa, w.omega * cfg.radius - w.vLong, absV, tyre.relaxLong, h);
          w.tanAlpha = relaxState(w.tanAlpha, w.vLat, absV, tyre.relaxLat, h);
          // Keep the deflection states bounded (fully sliding beyond this anyway).
          w.kappa = clamp(w.kappa, -6 * tyre.kappaPeak, 6 * tyre.kappaPeak);
          w.tanAlpha = clamp(w.tanAlpha, -6 * tyre.tanAlphaPeak, 6 * tyre.tanAlphaPeak);
          const sx = w.kappa / tyre.kappaPeak;
          const sy = w.tanAlpha / tyre.tanAlphaPeak;
          const sMag = Math.hypot(sx, sy);
          w.slip = sMag;
          if (sMag > 1e-6) {
            const f = w.peak * tyreShape(sMag);
            fs = (f * sx) / sMag;
            fy = (-f * sy * tyre.lateralScale) / sMag;
          }
          // Low-speed carcass damping (prevents oscillation and creep near standstill).
          const blend = clamp(1 - absV / 3, 0, 1);
          if (blend > 0) {
            const mEff = w.load / G;
            const kx = (w.peak * TYRE_SHAPE_SLOPE0) / (tyre.kappaPeak * tyre.relaxLong);
            const ky = (w.peak * TYRE_SHAPE_SLOPE0) / (tyre.tanAlphaPeak * tyre.relaxLat);
            cb = 2 * 0.6 * Math.sqrt(kx * mEff) * blend;
            const cy = 2 * 0.6 * Math.sqrt(ky * mEff) * blend;
            fy -= cy * (w.vLat - absV * w.tanAlpha);
          }
          if (w.driven && w.driveTorque * Gr >= 0) maxDrivenSlip = Math.max(maxDrivenSlip, sx * Math.sign(Gr || 1));
        } else {
          w.kappa *= 0.5;
          w.tanAlpha *= 0.5;
          w.slip = 0;
        }

        // Wheel spin, implicit in the damping term; brakes act as static friction on the hub.
        const rr = cfg.radius;
        const absV = Math.abs(w.vLong);
        const den = 1 + (h * cb * rr * rr) / inertiaEff;
        const freeOmega = (w.omega + (h / inertiaEff) * (w.driveTorque - fs * rr + cb * rr * (w.vLong + absV * w.kappa))) / den;
        const tbTotal = tb + ROLLING_RESISTANCE * w.load * rr;
        const dOmegaBrake = (h * tbTotal) / inertiaEff / den;
        if (Math.abs(freeOmega) <= dOmegaBrake) w.omega = 0;
        else w.omega = freeOmega - Math.sign(freeOmega) * dOmegaBrake;
        if (w.grounded && w.peak > 0) {
          fx = fs + cb * (w.omega * rr - w.vLong - absV * w.kappa);
          // Friction circle cap for the total force (damping can add a little).
          const fm = Math.hypot(fx, fy);
          const cap = w.peak * 1.05;
          if (fm > cap) {
            fx *= cap / fm;
            fy *= cap / fm;
          }
        }
        w.fxAcc += fx;
        w.fyAcc += fy;
        // Clamp runaway wheel speeds (e.g. airborne at the limiter).
        w.omega = clamp(w.omega, -250, 250);
      }

      // --- traction control ---
      if (assists.tcs && !input.handbrake && throttleEff > 0.05) {
        if (maxDrivenSlip > 1.35) tcsFactor = Math.max(0.2, tcsFactor - h * 7);
        else tcsFactor = Math.min(1, tcsFactor + h * 2.5);
      } else tcsFactor = Math.min(1, tcsFactor + h * 5);
    }
    engineLoad = loadAcc / WHEEL_SUBSTEPS;
    controls.absActive = absActiveStep;
    controls.tcsActive = tcsFactor < 0.97;
    controls.escActive = escActive;
    if (!engineModel.electric && !clutchLocked && engineRpm < engineModel.idleRpm) engineRpm = engineModel.idleRpm;

    // 5. Apply forces as impulses.
    let slipMax = 0;
    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      w.spin = (w.spin + w.omega * dt) % (Math.PI * 2);
      if (!w.grounded) {
        w.fx = w.fy = 0;
        w.slipRatio = 0;
        w.slipAngle = 0;
        continue;
      }
      w.fx = w.fxAcc / WHEEL_SUBSTEPS;
      w.fy = w.fyAcc / WHEEL_SUBSTEPS;
      w.slipRatio = w.kappa;
      w.slipAngle = Math.atan(w.tanAlpha);
      // Suspension force along the body up axis, plus the in-plane reaction of a tilted contact
      // (curb edges push the wheel back as well as up).
      const n = w.contactNormal;
      const nUp = n.dot(axUp);
      impulse.copy(axUp).multiplyScalar(w.load * dt);
      tmpA.copy(n).addScaledVector(axUp, -nUp);
      if (tmpA.lengthSq() > 1e-4) impulse.addScaledVector(tmpA, ((w.load / Math.max(nUp, 0.5)) * 0.7) * dt);
      applyImpulseAt(impulse, w.contactPoint);
      // Tyre forces, applied at roll-centre height above the contact patch.
      impulse.copy(w.fw).multiplyScalar(w.fx * dt).addScaledVector(w.lat, w.fy * dt);
      tmpB.copy(w.contactPoint).addScaledVector(axUp, w.cfg.rollCentre);
      applyImpulseAt(impulse, tmpB);
      const speedFactor = clamp((Math.abs(w.vLong) + Math.abs(w.vLat)) / 4, 0, 1);
      slipMax = Math.max(slipMax, clamp((w.slip - 0.85) / 1.6, 0, 1) * speedFactor * clamp(w.load / w.cfg.staticLoad, 0, 1.2));
    }

    // 6. Aerodynamic drag at the centre of mass.
    const sp = linv.length();
    if (sp > 0.1) {
      impulse.copy(linv).multiplyScalar(-0.5 * AIR_DENSITY * cdA * sp * dt);
      applyImpulseAt(impulse, com);
    }

    // 7. Canal water: buoyancy + heavy drag.
    inWater = pos.y < WATER_LEVEL - 0.1;
    if (inWater) {
      impulse.set(0, mass * G * 0.75 * dt, 0).addScaledVector(linv, -mass * 1.6 * dt);
      applyImpulseAt(impulse, com);
      const av = body.angvel();
      rapierVec.x = av.x * 0.97;
      rapierVec.y = av.y * 0.97;
      rapierVec.z = av.z * 0.97;
      body.setAngvel(rapierVec, true);
    }

    telemetry.slip = slipMax;
    const lv = body.linvel();
    preStepVel.set(lv.x, lv.y, lv.z);
  }

  function postStep(dt: number): void {
    if (frozen) return;
    prevPos.copy(curPos);
    prevQuat.copy(curQuat);
    const t = body.translation();
    const r = body.rotation();
    curPos.set(t.x, t.y, t.z);
    curQuat.set(r.x, r.y, r.z, r.w);

    // Collision impulse = velocity change not explained by our own impulses and gravity.
    const lv = body.linvel();
    tmpA.set(lv.x, lv.y, lv.z).sub(preStepVel);
    tmpA.y += G * dt;
    if (inWater) tmpA.set(0, 0, 0);
    const dv = tmpA.length();
    if (skipImpactSteps > 0) skipImpactSteps--;
    else if (dv > 0.25) {
      impactAccum = Math.max(impactAccum, dv * mass);
      impactDv = Math.max(impactDv, dv);
    }

    // Local acceleration (smoothed) for camera / body roll.
    tmpB.set(lv.x, lv.y, lv.z);
    tmpC.copy(tmpB).sub(lastVel).multiplyScalar(1 / dt);
    lastVel.copy(tmpB);
    invQ.copy(curQuat).invert();
    tmpC.applyQuaternion(invQ);
    localAcceleration.lerp(tmpC, 1 - Math.exp(-dt / 0.12));

    // Safety bookkeeping.
    const upY = axUp.y;
    const allGrounded = wheels.every((w) => w.grounded);
    safeTimer += dt;
    if (safeTimer > 1 && allGrounded && upY > 0.95 && curPos.y > -0.6 && linv.length() < 25) {
      safeTimer = 0;
      safeSpots.push({ x: curPos.x, y: curPos.y, z: curPos.z, heading: Math.atan2(axFwd.x, axFwd.z) });
      if (safeSpots.length > 8) safeSpots.shift();
    }
    if (autoReset) {
      flipTimer = upY < 0.3 && linv.length() < 2 ? flipTimer + dt : 0;
      waterTimer = inWater ? waterTimer + dt : 0;
      if (flipTimer > 3 || waterTimer > 3) {
        flipTimer = waterTimer = 0;
        pending.reset = true;
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Reset / teleport
  // ------------------------------------------------------------------------------------------
  const overlapShape = new R.Cuboid(halfW, (height - clearance) / 2, length / 2);

  function spotIsFree(x: number, y: number, z: number, hdg: number): boolean {
    const s = Math.sin(hdg / 2);
    const c = Math.cos(hdg / 2);
    const hit = world.intersectionWithShape(
      { x, y: y + clearance + (height - clearance) / 2 + 0.05, z },
      { x: 0, y: s, z: 0, w: c },
      overlapShape,
      R.QueryFilterFlags.ONLY_FIXED,
      COLLISION_GROUPS.queryStatic,
      undefined,
      body,
    );
    return !hit;
  }

  function placeAt(x: number, y: number, z: number, hdg: number): void {
    const s = Math.sin(hdg / 2);
    const c = Math.cos(hdg / 2);
    body.setTranslation({ x, y: y + 0.04, z }, true);
    body.setRotation({ x: 0, y: s, z: 0, w: c }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // While frozen the body is kinematic and Rapier restores its old dynamic velocity on
    // setBodyType(Dynamic): remember to zero it again when unfreezing (respawn from the pause menu).
    if (frozen) zeroVelOnThaw = true;
    for (const w of wheels) {
      w.omega = 0;
      w.kappa = 0;
      w.tanAlpha = 0;
      w.absFactor = 1;
      w.prevCompression = droop;
      w.compression = droop;
      w.grounded = false;
    }
    steerAngle = 0;
    gear = 1;
    shiftTimer = 0;
    clutchLocked = false;
    engineRpm = engineModel.idleRpm;
    curPos.set(x, y + 0.04, z);
    curQuat.set(0, s, 0, c);
    prevPos.copy(curPos);
    prevQuat.copy(curQuat);
    position.copy(curPos);
    quaternion.copy(curQuat);
    lastVel.set(0, 0, 0);
    preStepVel.set(0, 0, 0);
    impactAccum = impactDv = 0;
    skipImpactSteps = 2;
    localAcceleration.set(0, 0, 0);
    flipTimer = waterTimer = 0;
    inWater = false;
  }

  function groundAt(x: number, z: number, fromY: number): number | null {
    return physics.raycastDown(x, z, fromY);
  }

  function doReset(): void {
    const t = body.translation();
    const r = body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    axFwd.set(0, 0, 1).applyQuaternion(q);
    const hdg = Math.atan2(axFwd.x, axFwd.z);
    const y = groundAt(t.x, t.z, t.y + 2.5);
    if (y !== null && y > WATER_LEVEL + 0.6 && spotIsFree(t.x, y, t.z, hdg)) {
      placeAt(t.x, y, t.z, hdg);
      return;
    }
    for (let i = safeSpots.length - 1; i >= 0; i--) {
      const s = safeSpots[i];
      const gy = groundAt(s.x, s.z, s.y + 2.5);
      if (gy !== null && spotIsFree(s.x, gy, s.z, s.heading)) {
        placeAt(s.x, gy, s.z, s.heading);
        return;
      }
    }
    // Nothing better known: lift the car upright where it is.
    placeAt(t.x, (y ?? t.y) + 0.5, t.z, hdg);
  }

  // ------------------------------------------------------------------------------------------
  // Render update (interpolation, wheels, lights, telemetry)
  // ------------------------------------------------------------------------------------------
  const extraRollPitch = { roll: 0, pitch: 0 };

  function renderUpdate(dt: number): void {
    const alpha = physics.alpha;
    position.lerpVectors(prevPos, curPos, alpha);
    quaternion.slerpQuaternions(prevQuat, curQuat, alpha);
    model.root.position.copy(position);
    model.root.quaternion.copy(quaternion);
    tmpA.set(0, 0, 1).applyQuaternion(quaternion);
    heading = Math.atan2(tmpA.x, tmpA.z);
    const lv = body.linvel();
    velocity.set(lv.x, lv.y, lv.z);
    const av = body.angvel();
    angularVelocity.set(av.x, av.y, av.z);

    for (let i = 0; i < 4; i++) {
      const w = wheels[i];
      model.setWheel(i, w.steer, w.spin, w.suspensionOffset);
    }

    // Subtle extra body roll / pitch from accelerations (the rigid body already rolls on its springs).
    const k = 1 - Math.exp(-dt / 0.15);
    extraRollPitch.roll += (clamp(localAcceleration.x / G, -1.2, 1.2) * 0.012 - extraRollPitch.roll) * k;
    extraRollPitch.pitch += (clamp(-localAcceleration.z / G, -1.2, 1.2) * 0.01 - extraRollPitch.pitch) * k;
    model.body.rotation.z = extraRollPitch.roll;
    model.body.rotation.x = extraRollPitch.pitch;

    // Lights.
    lightState.head = controls.headlights;
    lightState.brake = brakeEff > 0.05 && !frozen;
    lightState.reverse = gear === -1;
    if (
      lightState.head !== lastLights.head ||
      lightState.brake !== lastLights.brake ||
      lightState.reverse !== lastLights.reverse
    ) {
      lastLights.head = !!lightState.head;
      lastLights.brake = !!lightState.brake;
      lastLights.reverse = !!lightState.reverse;
      model.setLights(lightState);
    }

    // Telemetry.
    telemetry.speedKmh = Math.abs(forwardSpeed) * 3.6;
    telemetry.rpm = engineRpm;
    telemetry.gear = gear;
    telemetry.throttle = throttleEff;
    telemetry.brake = brakeEff;
    for (let i = 0; i < 4; i++) telemetry.grounded[i] = wheels[i].grounded;
    telemetry.impact = impactAccum;
    if (impactAccum > 0) for (const fn of impactListeners) fn(impactAccum, impactDv);
    impactAccum = 0;
    impactDv = 0;
  }

  // ------------------------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------------------------
  const offPre = physics.onPreStep(preStep);
  const offPost = physics.onPostStep(postStep);
  const offRender = engine.onUpdate(renderUpdate, 20);
  if (options.addToScene !== false && !model.root.parent) engine.scene.add(model.root);
  model.setLights({ head: false, brake: false, reverse: false });
  placeAt(0, 0, 0, 0);

  const vehicle: PlayerVehicleExt = {
    spec,
    model,
    body,
    position,
    quaternion,
    velocity,
    angularVelocity,
    localAcceleration,
    get heading() {
      return heading;
    },
    telemetry,
    wheelStates: wheels,
    controls,
    get forwardSpeed() {
      return forwardSpeed;
    },
    get engineLoad() {
      return engineLoad;
    },
    get gear() {
      return gear;
    },
    get engineRpm() {
      return engineRpm;
    },
    get isShifting() {
      return shiftTimer > 0;
    },
    get inWater() {
      return inWater;
    },
    dims: { length, width, height, wheelbase },

    setInput(inp: VehicleInput) {
      if (frozen) return;
      input.throttle = clamp(Number.isFinite(inp.throttle) ? inp.throttle : 0, 0, 1);
      input.brake = clamp(Number.isFinite(inp.brake) ? inp.brake : 0, 0, 1);
      input.steer = clamp(Number.isFinite(inp.steer) ? inp.steer : 0, -1, 1);
      input.handbrake = !!inp.handbrake;
      controls.horn = !!inp.horn;
      if (inp.shiftUp) pending.shiftUp = true;
      if (inp.shiftDown) pending.shiftDown = true;
      if (inp.reset) pending.reset = true;
      if (inp.toggleLights) controls.headlights = !controls.headlights;
    },

    teleport(x: number, z: number, hdg: number) {
      const y = groundAt(x, z, 60) ?? 0;
      placeAt(x, y, z, hdg);
      safeSpots.length = 0;
      safeSpots.push({ x, y, z, heading: hdg });
    },

    reset() {
      pending.reset = true;
    },

    setGearboxMode(mode: GearboxMode) {
      controls.gearboxMode = mode;
      manualHoldTimer = 0;
    },
    setAssists(a: Partial<VehicleAssists>) {
      Object.assign(assists, a);
    },
    setHeadlights(on: boolean) {
      controls.headlights = on;
    },
    setFrozen(f: boolean) {
      if (f === frozen) return;
      frozen = f;
      if (f) {
        input.throttle = input.brake = input.steer = 0;
        input.handbrake = false;
        controls.horn = false;
        body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
      } else {
        body.setBodyType(R.RigidBodyType.Dynamic, true);
        if (zeroVelOnThaw) {
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          for (const w of wheels) w.omega = 0;
          preStepVel.set(0, 0, 0);
          skipImpactSteps = 2;
        }
        zeroVelOnThaw = false;
        lastVel.set(0, 0, 0);
      }
    },
    onImpact(fn) {
      impactListeners.push(fn);
      return () => {
        const i = impactListeners.indexOf(fn);
        if (i >= 0) impactListeners.splice(i, 1);
      };
    },

    dispose() {
      offPre();
      offPost();
      offRender();
      if (model.root.parent) model.root.parent.remove(model.root);
      for (const c of chassisColliders) world.removeCollider(c, false);
      world.removeRigidBody(body);
      impactListeners.length = 0;
    },
  };
  return vehicle;
}
