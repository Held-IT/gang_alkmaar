// One active-ragdoll beast (beast-physics module): 11 Rapier rigid bodies (BEAST_RIG) joined by
// impulse joints, driven by a Gang-Beasts-style controller that runs before every fixed sub-step.
//
// How it moves (see docs/progress/beast-physics.md for the tuning story):
// - Every part is steered in WORLD space by "align" torques (PD on an axis, scaled by the part's
//   own inertia) like the reference engine's MovementHandeler.AlignToVector: torso/pelvis upright +
//   yaw toward the facing, limbs toward procedural poses (walk cycle, guard, reach, punch, kick).
//   All gains are multiplied by `strength` (0..1, Gang Beasts' "applyed force"): hits, landings and
//   KO drop it, it recovers at 0.5/s, so beasts wobble, stagger and flop.
// - A pelvis-height spring (ground ray under the pelvis) carries the weight while grounded;
//   horizontal forces on pelvis+chest chase the desired velocity; legs only animate (step cycle).
// - Combat is evaluated analytically (hand / foot / head tip vs. the capsules of the other beasts)
//   for robust, readable hits; grabs create spherical joints between the hand and what it touches.
//
// Spellogica deels gebaseerd op gb-rust door muffinmxn, MIT-licentie.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type {
  Beast,
  BeastExpression,
  BeastInput,
  BeastOptions,
  BeastPartName,
  BeastState,
  BeastVisual,
} from '../../brawl/contracts';
import { PHYSICS_DT } from '../../config';
import { beastGroups, beastQueryGroups, beastSlotBit, GROUP, interactionGroups } from '../../physics/physics';
import { BEAST_FOOT_TIP, BEAST_HAND_TIP, BEAST_MASS, BEAST_PARTS, BEAST_RIG, BEAST_STAND_HEIGHT } from '../rig';
import { BEAST_TUNING as T, DAMAGE_MULT } from './tuning';

// Part indices (order of BEAST_PARTS).
export const PELVIS = 0;
export const CHEST = 1;
export const HEAD = 2;
export const UARM_L = 3;
export const LARM_L = 4;
export const UARM_R = 5;
export const LARM_R = 6;
export const ULEG_L = 7;
export const LLEG_L = 8;
export const ULEG_R = 9;
export const LLEG_R = 10;
export const PART_COUNT = 11;

/** Internal controller mode (finer than the contract's BeastState). */
export type BeastMode =
  | 'stand'
  | 'walk'
  | 'run'
  | 'duck'
  | 'jump'
  | 'fall'
  | 'climb'
  | 'ko'
  | 'getup'
  | 'swim'
  | 'out';

export type HeldKind = 'beast' | 'prop' | 'static';

/** Shared state of the beast system that every beast needs. */
export interface BeastCtx {
  world: RAPIER.World;
  beasts: BeastImpl[];
  waterLevel: number;
  isWater(x: number, z: number): boolean;
  time(): number;
  emitHit(target: BeastImpl, attacker: BeastImpl | null, strength: number, point: THREE.Vector3): void;
  emitKo(target: BeastImpl): void;
  emitGrab(grabber: BeastImpl, target: BeastImpl | null): void;
  emitSplash(target: BeastImpl, point: THREE.Vector3): void;
  registerCollider(handle: number, beast: BeastImpl, part: number): void;
  unregisterCollider(handle: number): void;
}

interface PartRt {
  index: number;
  name: BeastPartName;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  mass: number;
  /** principal inertia (local x, y, z) */
  inertia: THREE.Vector3;
  radius: number;
  halfHeight: number;
  restLocal: THREE.Vector3;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  lin: THREE.Vector3;
  ang: THREE.Vector3;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  prevLin: THREE.Vector3;
  /** interpolated world transform of the last visual sync */
  ipos: THREE.Vector3;
  iquat: THREE.Quaternion;
  /** accumulated linear impulse (N s) and angular acceleration (rad/s^2) for this sub-step */
  imp: THREE.Vector3;
  alpha: THREE.Vector3;
  /** cached world bone axis (local -Y) of this sub-step */
  bone: THREE.Vector3;
}

interface HandRt {
  side: 0 | 1;
  upper: number;
  lower: number;
  btn: boolean;
  pressT: number;
  punchT: number;
  punchLanded: boolean;
  punchCool: number;
  aim: THREE.Vector3;
  joint: RAPIER.ImpulseJoint | null;
  kind: HeldKind | null;
  heldBeast: BeastImpl | null;
  heldPart: number;
  heldBody: RAPIER.RigidBody | null;
  /** anchor on the held body (body local) */
  anchorLocal: THREE.Vector3;
  anchorBody: RAPIER.RigidBody | null;
  stretchT: number;
  grabT: number;
  /** top of the obstacle above a static grab point (ledge climbing) */
  ledgeY: number;
  /** horizontal direction into the obstacle (minus its face normal) */
  ledgeDir: THREE.Vector3;
}

// ------------------------------------------------------------------------------------ scratch
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _g = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _left = new THREE.Vector3();
const _move = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _tipVel = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitDir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const _rv = { x: 0, y: 0, z: 0 };
const _rv2 = { x: 0, y: 0, z: 0 };
const _rq = { x: 0, y: 0, z: 0, w: 1 };
const _ident = { x: 0, y: 0, z: 0, w: 1 };
const IMPACT_PARTS = [HEAD, CHEST] as const;
const AIR_PARTS = [PELVIS, CHEST] as const;
const REACH_PARTS = [HEAD, CHEST, PELVIS, UARM_L, UARM_R] as const;
const LEGS_BOTH = [0, 1] as const;
const KNEE_PARTS = [ULEG_L, ULEG_R] as const;
const LEGS_L = [0] as const;
const LEGS_R = [1] as const;
const _found: { c: RAPIER.Collider | null } = { c: null };
function takeFound(): RAPIER.Collider | null {
  const c = _found.c;
  _found.c = null;
  return c;
}
/** Shape-query callback: a dynamic prop (cheese wheel, sack) wins over the floor / walls it lies on. */
function onShapeHit(c: RAPIER.Collider): boolean {
  if (c.isSensor()) return true;
  const b = c.parent();
  if (b && b.isDynamic()) {
    _found.c = c;
    return false;
  }
  if (!_found.c) _found.c = c;
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Distance from point p to the segment a-b (THREE vectors), writes the closest point to out. */
function pointSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2 : 0;
  t = clamp(t, 0, 1);
  out.set(a.x + abx * t, a.y + aby * t, a.z + abz * t);
  return out.distanceTo(p);
}

let _rayCache: RAPIER.Ray | null = null;
let _ballCache: RAPIER.Ball | null = null;
let _ballRadius = -1;

export class BeastImpl implements Beast {
  readonly id: number;
  readonly slot: number;
  readonly options: Readonly<BeastOptions>;
  readonly root: THREE.Object3D;
  readonly visual: BeastVisual;
  readonly scale: number;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly parts: PartRt[] = [];
  readonly bodies = {} as Record<BeastPartName, RAPIER.RigidBody>;
  readonly holding: { left: number | null; right: number | null } = { left: null, right: null };
  /** ids of beasts whose hands hold this beast */
  readonly heldBy: number[] = [];
  readonly totalMass: number;
  readonly input: BeastInput = {
    moveX: 0,
    moveZ: 0,
    jump: false,
    duck: false,
    lift: false,
    kick: false,
    grabLeft: false,
    grabRight: false,
    run: false,
  };

  facing = 0;
  state: BeastState = 'active';
  mode: BeastMode = 'stand';
  consciousness = 1;
  health = T.healthMax;
  stamina = T.staminaMax;
  strength = 1;
  grounded = false;
  groundY = 0;
  groundDist = 0;
  koTime = 0;
  inWater = false;
  alive = true;
  /** set while a scripted/forced expression should win (e.g. 'happy' for the round winner) */
  expressionOverride: BeastExpression | null = null;

  private readonly ctx: BeastCtx;
  private readonly hands: [HandRt, HandRt];
  private readonly joints: RAPIER.ImpulseJoint[] = [];
  private readonly queryGroups: number;
  private readonly staticPropGroups: number;
  private readonly standH: number;
  private targetYaw = 0;
  private phase = 0;
  private legAmp = 0;
  private airT = 0;
  private groundLock = 0;
  private jumpCool = 0;
  private prevJump = false;
  private prevKick = false;
  private prevDuck = false;
  private prevLift = false;
  private duckT = 0;
  private ducking = false;
  private kickT = -1;
  private kickLeg = 0;
  private kickAir = false;
  private kickLanded = false;
  private kickCool = 0;
  private headbuttT = -1;
  private headbuttLanded = false;
  private headbuttCool = 0;
  private liftT = 0;
  private lastHitT = -10;
  private recentKos = 0;
  private koTotal = 0;
  private getupT = 0;
  private grabDelay = 0;
  private impactGrace = 0;
  private lastThrower: BeastImpl | null = null;
  private lastThrowT = -10;
  private splashed = false;
  private dryT = 0;
  private mashCool = 0;
  private hurtT = 0;
  private attackT = 0;
  private lastExpr: BeastExpression | null = null;
  private hangAnchor = new THREE.Vector3();
  private climbDir = new THREE.Vector3(0, 0, 1);
  /** after an automatic release (ledge climbed) no new grab until both grab buttons are up */
  private grabLock = false;
  /** debug: last release reason */
  lastRelease = '';
  /** top of the ledge while climbing (world y) */
  climbLedgeY = 0;

  constructor(
    ctx: BeastCtx,
    id: number,
    slot: number,
    opts: BeastOptions,
    visual: BeastVisual,
    at: THREE.Vector3,
    facing: number,
  ) {
    this.ctx = ctx;
    this.id = id;
    this.slot = slot;
    this.options = Object.freeze({ ...opts });
    this.scale = opts.scale ?? 1;
    this.visual = visual;
    this.root = visual.root;
    this.queryGroups = beastQueryGroups(slot);
    this.staticPropGroups = interactionGroups(beastSlotBit(slot), GROUP.STATIC | GROUP.PROP);
    this.standH = BEAST_STAND_HEIGHT * this.scale;

    const s = this.scale;
    const world = ctx.world;
    const groups = beastGroups(slot);
    let total = 0;
    for (let i = 0; i < PART_COUNT; i++) {
      const name = BEAST_PARTS[i];
      const spec = BEAST_RIG[name];
      const mass = BEAST_MASS[name] * s * s * s;
      total += mass;
      const r = spec.radius * s;
      const hh = spec.halfHeight * s;
      const rest = new THREE.Vector3(spec.rest[0] * s, spec.rest[1] * s, spec.rest[2] * s);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(at.x + rest.x, at.y + rest.y, at.z + rest.z)
          .setLinearDamping(T.linearDamping)
          .setAngularDamping(T.angularDamping)
          .setCanSleep(false)
          .setCcdEnabled(i === LARM_L || i === LARM_R),
      );
      const torso = i <= HEAD;
      const k = torso ? T.inertiaTorso : T.inertiaLimb;
      const inertia = new THREE.Vector3();
      if (spec.shape === 'sphere') {
        const I = 0.4 * mass * r * r * k;
        inertia.set(I, I, I);
      } else {
        const L = 2 * hh + 1.4 * r;
        const Ix = ((mass * (3 * r * r + L * L)) / 12) * k;
        const Iy = 0.5 * mass * r * r * k;
        inertia.set(Ix, Iy, Ix);
      }
      const desc = spec.shape === 'sphere' ? RAPIER.ColliderDesc.ball(r) : RAPIER.ColliderDesc.capsule(hh, r);
      desc
        .setMassProperties(mass, { x: 0, y: 0, z: 0 }, { x: inertia.x, y: inertia.y, z: inertia.z }, _ident)
        .setFriction(i === LLEG_L || i === LLEG_R ? T.footFriction : T.friction)
        .setRestitution(0.05)
        .setCollisionGroups(groups);
      const collider = world.createCollider(desc, body);
      ctx.registerCollider(collider.handle, this, i);
      const p: PartRt = {
        index: i,
        name,
        body,
        collider,
        mass,
        inertia,
        radius: r,
        halfHeight: hh,
        restLocal: rest,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        lin: new THREE.Vector3(),
        ang: new THREE.Vector3(),
        prevPos: new THREE.Vector3(),
        prevQuat: new THREE.Quaternion(),
        prevLin: new THREE.Vector3(),
        ipos: new THREE.Vector3(),
        iquat: new THREE.Quaternion(),
        imp: new THREE.Vector3(),
        alpha: new THREE.Vector3(),
        bone: new THREE.Vector3(),
      };
      this.parts.push(p);
      this.bodies[name] = body;
    }
    this.totalMass = total;

    // Joints. Anchors from the rig (beast-local rest); body frames are identity at rest.
    for (let i = 1; i < PART_COUNT; i++) {
      const spec = BEAST_RIG[BEAST_PARTS[i]];
      const parent = this.parts[BEAST_PARTS.indexOf(spec.parent!)];
      const child = this.parts[i];
      const j = spec.joint!;
      const jx = j[0] * s;
      const jy = j[1] * s;
      const jz = j[2] * s;
      const a1 = { x: jx - parent.restLocal.x, y: jy - parent.restLocal.y, z: jz - parent.restLocal.z };
      const a2 = { x: jx - child.restLocal.x, y: jy - child.restLocal.y, z: jz - child.restLocal.z };
      const isHinge = i === LARM_L || i === LARM_R || i === LLEG_L || i === LLEG_R;
      const data = isHinge
        ? RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 })
        : RAPIER.JointData.spherical(a1, a2);
      const joint = world.createImpulseJoint(data, parent.body, child.body, true);
      joint.setContactsEnabled(false);
      if (isHinge) {
        // knees bend backwards (+X rotation of the shin), elbows forwards
        const knee = i === LLEG_L || i === LLEG_R;
        (joint as unknown as RAPIER.RevoluteImpulseJoint).setLimits(knee ? -0.05 : -2.5, knee ? 2.4 : 0.05);
      } else {
        const raw = (world.impulseJoints as unknown as { raw: { jointSetLimits(h: number, ax: number, a: number, b: number): void } }).raw;
        const lim =
          i === CHEST
            ? [0.7, 0.55, 0.45]
            : i === HEAD
              ? [0.7, 1.0, 0.5]
              : i === ULEG_L || i === ULEG_R
                ? [1.75, 0.6, 0.9]
                : null; // shoulders free
        if (lim) {
          raw.jointSetLimits(joint.handle, 3, -lim[0], lim[0]);
          raw.jointSetLimits(joint.handle, 4, -lim[1], lim[1]);
          raw.jointSetLimits(joint.handle, 5, -lim[2], lim[2]);
        }
      }
      this.joints.push(joint);
    }

    const mkHand = (side: 0 | 1): HandRt => ({
      side,
      upper: side === 0 ? UARM_L : UARM_R,
      lower: side === 0 ? LARM_L : LARM_R,
      btn: false,
      pressT: 0,
      punchT: -1,
      punchLanded: false,
      punchCool: 0,
      aim: new THREE.Vector3(),
      joint: null,
      kind: null,
      heldBeast: null,
      heldPart: -1,
      heldBody: null,
      anchorLocal: new THREE.Vector3(),
      anchorBody: null,
      stretchT: 0,
      grabT: 0,
      ledgeY: 0,
      ledgeDir: new THREE.Vector3(0, 0, 1),
    });
    this.hands = [mkHand(0), mkHand(1)];

    this.teleport(at, facing);
  }

  // ======================================================================== public API
  partPosition(part: BeastPartName, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.parts[BEAST_PARTS.indexOf(part)].ipos);
  }

  /** Current (not interpolated) linear velocity of a part. */
  partVelocity(part: BeastPartName, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.parts[BEAST_PARTS.indexOf(part)].lin);
  }

  /** World position of a hand tip (side 'left' | 'right'), current physics state. */
  handPosition(side: 'left' | 'right', out: THREE.Vector3): THREE.Vector3 {
    return this.tipOf(side === 'left' ? LARM_L : LARM_R, BEAST_HAND_TIP, out);
  }

  setInput(input: BeastInput): void {
    const d = this.input;
    d.moveX = Number.isFinite(input.moveX) ? input.moveX : 0;
    d.moveZ = Number.isFinite(input.moveZ) ? input.moveZ : 0;
    d.jump = !!input.jump;
    d.duck = !!input.duck;
    d.lift = !!input.lift;
    d.kick = !!input.kick;
    d.grabLeft = !!input.grabLeft;
    d.grabRight = !!input.grabRight;
    d.run = !!input.run;
  }

  teleport(p: THREE.Vector3, facing: number): void {
    this.releaseAll();
    this.releaseHeldBy();
    // feet on the ground below p
    let feetY = p.y;
    const ray = this.ray();
    ray.origin.x = p.x;
    ray.origin.y = p.y + 1.5;
    ray.origin.z = p.z;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const hit = this.ctx.world.castRay(ray, 8, true, undefined, this.staticPropGroups);
    if (hit) feetY = p.y + 1.5 - hit.timeOfImpact;
    _q.setFromAxisAngle(UP, facing);
    _rq.x = _q.x;
    _rq.y = _q.y;
    _rq.z = _q.z;
    _rq.w = _q.w;
    for (const part of this.parts) {
      _a.copy(part.restLocal).applyQuaternion(_q);
      _rv.x = p.x + _a.x;
      _rv.y = feetY + _a.y + 0.02;
      _rv.z = p.z + _a.z;
      part.body.setTranslation(_rv, true);
      part.body.setRotation(_rq, true);
      _rv2.x = _rv2.y = _rv2.z = 0;
      part.body.setLinvel(_rv2, true);
      part.body.setAngvel(_rv2, true);
      part.pos.set(_rv.x, _rv.y, _rv.z);
      part.prevPos.copy(part.pos);
      part.ipos.copy(part.pos);
      part.quat.copy(_q);
      part.prevQuat.copy(_q);
      part.iquat.copy(_q);
      part.lin.set(0, 0, 0);
      part.prevLin.set(0, 0, 0);
      part.ang.set(0, 0, 0);
      part.collider.setFriction(part.index === LLEG_L || part.index === LLEG_R ? T.footFriction : T.friction);
    }
    this.facing = facing;
    this.targetYaw = facing;
    this.state = 'active';
    this.mode = 'stand';
    this.health = T.healthMax;
    this.consciousness = 1;
    this.stamina = T.staminaMax;
    this.strength = 1;
    this.koTime = 0;
    this.airT = 0;
    this.groundLock = 0;
    this.kickT = -1;
    this.headbuttT = -1;
    this.impactGrace = 0.1;
    this.splashed = false;
    this.inWater = false;
    this.alive = true;
    this.position.copy(this.parts[CHEST].pos);
    this.velocity.set(0, 0, 0);
  }

  /** Move the whole ragdoll by d (keeps pose and velocities; no ground snapping). */
  translate(d: THREE.Vector3): void {
    for (const part of this.parts) {
      part.pos.add(d);
      part.prevPos.add(d);
      part.ipos.add(d);
      _rv.x = part.pos.x;
      _rv.y = part.pos.y;
      _rv.z = part.pos.z;
      part.body.setTranslation(_rv, true);
    }
    this.impactGrace = 0.05;
  }

  eliminate(): void {
    if (this.state === 'eliminated') return;
    this.state = 'eliminated';
    this.mode = 'out';
    this.releaseAll();
    this.strength = 0;
    this.consciousness = 0;
  }

  /** Force a knock-out (tests, hazards). */
  knockOut(seconds?: number): void {
    if (this.state === 'eliminated') return;
    const dur = seconds ?? clamp(T.koBase + T.koExtra * Math.floor(this.recentKos), T.koBase, T.koMax);
    const wasKo = this.mode === 'ko';
    this.mode = 'ko';
    this.state = 'knockedOut';
    this.koTime = Math.max(this.koTime, dur);
    this.koTotal = this.koTime;
    this.consciousness = 0;
    this.strength = 0.02;
    this.releaseAll();
    for (const part of this.parts) part.collider.setFriction(T.koFriction);
    if (!wasKo) {
      this.recentKos += 1;
      // crumple: knees buckle, the head lolls in a random direction
      const a = Math.random() * Math.PI * 2;
      for (const i of IMPACT_PARTS) {
        const q = this.parts[i];
        _rv.x = Math.cos(a) * 1.3 * q.mass;
        _rv.y = -0.4 * q.mass;
        _rv.z = Math.sin(a) * 1.3 * q.mass;
        q.body.applyImpulse(_rv, true);
      }
      for (const i of KNEE_PARTS) {
        const q = this.parts[i];
        _rv.x = -Math.sin(this.facing) * 1.2 * q.mass;
        _rv.y = 0;
        _rv.z = -Math.cos(this.facing) * 1.2 * q.mass;
        q.body.applyImpulse(_rv, true);
      }
      this.impactGrace = Math.max(this.impactGrace, 0.05);
      this.ctx.emitKo(this);
    }
  }

  /** Velocity change on every part (hazards, explosions, tests). */
  push(dv: THREE.Vector3, stun = 0): void {
    for (const part of this.parts) {
      _rv.x = dv.x * part.mass;
      _rv.y = dv.y * part.mass;
      _rv.z = dv.z * part.mass;
      part.body.applyImpulse(_rv, true);
    }
    if (stun > 0) this.strength = Math.max(0.05, this.strength - stun);
    this.impactGrace = Math.max(this.impactGrace, 0.05);
  }

  /** Impulse (N s) on one part. */
  applyImpulse(part: BeastPartName, impulse: THREE.Vector3): void {
    const p = this.parts[BEAST_PARTS.indexOf(part)];
    _rv.x = impulse.x;
    _rv.y = impulse.y;
    _rv.z = impulse.z;
    p.body.applyImpulse(_rv, true);
  }

  get isAttacking(): boolean {
    return this.hands[0].punchT >= 0 || this.hands[1].punchT >= 0 || this.kickT >= 0 || this.headbuttT >= 0;
  }

  /** Rigid body of a grab joint per hand (null = nothing / static). */
  heldBodyOf(side: 'left' | 'right'): RAPIER.RigidBody | null {
    return this.hands[side === 'left' ? 0 : 1].heldBody;
  }

  /** Heaviest thing the hands hold: the held beast if any. */
  get heldBeast(): BeastImpl | null {
    return this.hands[0].heldBeast ?? this.hands[1].heldBeast;
  }

  get isLifting(): boolean {
    return this.liftT > 0;
  }

  dispose(): void {
    this.releaseAll();
    this.releaseHeldBy();
    this.alive = false;
    const world = this.ctx.world;
    for (const h of this.hands) {
      if (h.anchorBody) world.removeRigidBody(h.anchorBody);
      h.anchorBody = null;
    }
    for (const j of this.joints) world.removeImpulseJoint(j, false);
    this.joints.length = 0;
    for (const part of this.parts) {
      this.ctx.unregisterCollider(part.collider.handle);
      world.removeRigidBody(part.body);
    }
    this.visual.dispose();
  }

  // ======================================================================== physics state
  /** Read body states after a fixed step (also computes impact damage). */
  readState(): void {
    if (!this.alive) return;
    for (let i = 0; i < PART_COUNT; i++) {
      const p = this.parts[i];
      const b = p.body;
      const t = b.translation();
      const r = b.rotation();
      const l = b.linvel();
      const w = b.angvel();
      p.prevPos.copy(p.pos);
      p.prevQuat.copy(p.quat);
      p.prevLin.copy(p.lin);
      p.pos.set(t.x, t.y, t.z);
      p.quat.set(r.x, r.y, r.z, r.w);
      p.lin.set(l.x, l.y, l.z);
      p.ang.set(w.x, w.y, w.z);
    }
    if (this.impactGrace > 0) {
      this.impactGrace -= PHYSICS_DT;
      return;
    }
    if (this.state === 'eliminated') return;
    // impact damage (falls, being thrown into walls, hazards)
    for (const idx of IMPACT_PARTS) {
      const p = this.parts[idx];
      const dv = _a.subVectors(p.lin, p.prevLin).length();
      if (dv > T.impactDv) {
        const dmg = (dv - T.impactDv) * T.impactDamage * (idx === HEAD ? 1.5 : 1);
        if (dmg > 2) {
          const attacker = this.ctx.time() - this.lastThrowT < 2 ? this.lastThrower : null;
          this.receiveHit(attacker, idx, dmg, clamp((dv - T.impactDv) / 8, 0.1, 1), null, p.pos, false);
          break;
        }
      }
    }
  }

  // ======================================================================== controller
  preStep(dt: number): void {
    if (!this.alive) return;
    const parts = this.parts;
    for (let i = 0; i < PART_COUNT; i++) {
      parts[i].imp.set(0, 0, 0);
      parts[i].alpha.set(0, 0, 0);
      parts[i].bone.set(0, -1, 0).applyQuaternion(parts[i].quat);
    }
    const now = this.ctx.time();
    const inp = this.input;
    const chest = parts[CHEST];
    const pelvis = parts[PELVIS];

    // ---------------------------------------------------------------- frame
    this.facing = this.yawOf(chest, this.facing);
    _fwd.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    _left.set(_fwd.z, 0, -_fwd.x);
    const mx = clamp(inp.moveX, -1, 1);
    const mz = clamp(inp.moveZ, -1, 1);
    let mag = Math.hypot(mx, mz);
    if (mag > 1) mag = 1;
    if (mag > 0.08) _move.set(mx, 0, mz).normalize();
    else {
      _move.set(0, 0, 0);
      mag = 0;
    }

    // ---------------------------------------------------------------- timers / status
    this.jumpCool -= dt;
    this.kickCool -= dt;
    this.headbuttCool -= dt;
    this.grabDelay -= dt;
    this.groundLock -= dt;
    this.mashCool -= dt;
    this.hurtT -= dt;
    this.attackT -= dt;
    this.recentKos = Math.max(0, this.recentKos - dt / 15);
    if (this.mode !== 'ko' && this.state !== 'eliminated' && now - this.lastHitT > T.regenDelay) {
      this.health = Math.min(T.healthMax, this.health + T.healthRegen * dt);
    }
    const holdingAny = this.hands[0].joint !== null || this.hands[1].joint !== null;
    if (!holdingAny) this.stamina = Math.min(T.staminaMax, this.stamina + T.staminaRegen * dt);

    // ---------------------------------------------------------------- ground + water
    this.groundCheck();
    this.waterCheck(dt);

    // ---------------------------------------------------------------- input edges
    const jumpEdge = inp.jump && !this.prevJump;
    const jumpUp = !inp.jump && this.prevJump;
    const kickEdge = inp.kick && !this.prevKick;
    const duckEdge = inp.duck && !this.prevDuck;
    const duckUp = !inp.duck && this.prevDuck;
    const liftUp = !inp.lift && this.prevLift;
    const anyPress =
      jumpEdge ||
      kickEdge ||
      duckEdge ||
      (inp.grabLeft && !this.hands[0].btn) ||
      (inp.grabRight && !this.hands[1].btn) ||
      (inp.lift && !this.prevLift);
    this.prevJump = inp.jump;
    this.prevKick = inp.kick;
    this.prevDuck = inp.duck;
    this.prevLift = inp.lift;

    // ---------------------------------------------------------------- mode
    const out = this.state === 'eliminated';
    if (out) {
      this.mode = 'out';
    } else if (this.mode === 'ko') {
      this.koTime -= dt;
      if (anyPress && this.mashCool <= 0) {
        this.koTime -= T.koMashReduce;
        this.mashCool = 0.12;
      }
      if (this.koTime <= 0) {
        this.koTime = 0;
        this.mode = 'getup';
        this.getupT = 0;
        this.strength = 0.15;
        this.health = T.healthMax;
        this.state = 'active';
        for (const part of parts) part.collider.setFriction(part.index === LLEG_L || part.index === LLEG_R ? T.footFriction : T.friction);
      }
    }
    if (!out && this.mode !== 'ko') {
      // duck / headbutt
      if (duckEdge) this.duckT = 0;
      if (inp.duck) this.duckT += dt;
      this.ducking = inp.duck && this.duckT >= 0.2;
      if (duckUp && this.duckT < 0.3 && this.headbuttCool <= 0 && this.mode !== 'getup' && this.mode !== 'swim') {
        this.headbuttT = 0;
        this.headbuttLanded = false;
        this.headbuttCool = T.headbuttCooldown;
        this.attackT = 0.5;
      }
      const hanging = this.hangingCount() > 0;
      if (this.mode === 'getup') {
        this.getupT += dt;
        const upright = chest.pos.y - pelvis.pos.y > 0.2 * this.scale && this.grounded;
        if ((this.strength > 0.65 && upright) || this.getupT > 3) this.mode = 'stand';
      } else if (this.inWater) {
        this.mode = 'swim';
      } else if (hanging && !this.grounded) {
        this.mode = 'climb';
      } else if (this.grounded) {
        this.airT = 0;
        if (this.mode === 'jump' || this.mode === 'fall') {
          // landing costs balance (Gang Beasts: applyed force 0.5 after JUMP/FALL)
          this.strength = Math.min(this.strength, this.mode === 'fall' ? 0.35 : 0.6);
        }
        if (this.ducking) this.mode = 'duck';
        else if (mag > 0.08) this.mode = inp.run && this.strength > 0.5 ? 'run' : 'walk';
        else this.mode = 'stand';
      } else {
        this.airT += dt;
        if (this.airT > 0.6) this.mode = 'fall';
        else if (this.airT > 0.08 || this.mode === 'jump') this.mode = 'jump';
      }
      this.state = this.mode === 'swim' ? 'swimming' : this.mode === 'jump' || this.mode === 'fall' || this.mode === 'climb' ? 'airborne' : 'active';
    }

    // ---------------------------------------------------------------- strength
    if (this.mode === 'ko' || out) {
      this.strength = out ? 0 : 0.02;
    } else if (this.mode === 'getup') {
      this.strength = Math.min(1, this.strength + T.getupRate * dt);
    } else {
      this.strength = Math.min(1, this.strength + T.strengthRecover * dt);
      if (this.mode === 'jump' || this.mode === 'fall' || this.mode === 'climb') {
        this.strength = Math.min(this.strength, T.airStrengthCap);
      }
    }
    const s = this.strength;
    this.consciousness = this.mode === 'ko' || out ? 0 : this.health / T.healthMax;

    // ---------------------------------------------------------------- facing target
    if (mag > 0.15 && this.mode !== 'ko' && !out) {
      this.targetYaw = Math.atan2(_move.x, _move.z);
    } else if ((this.isAttacking || this.hands[0].btn || this.hands[1].btn) && !holdingAny) {
      const tgt = this.nearestEnemy(2.2, -0.2);
      if (tgt) {
        const tc = tgt.parts[CHEST].pos;
        this.targetYaw = Math.atan2(tc.x - chest.pos.x, tc.z - chest.pos.z);
      }
    }

    // ---------------------------------------------------------------- jump
    const canAct = this.mode !== 'ko' && !out && this.mode !== 'getup';
    if (
      canAct &&
      jumpEdge &&
      this.grounded &&
      this.jumpCool <= 0 &&
      this.strength > 0.3 &&
      (this.mode === 'stand' || this.mode === 'walk' || this.mode === 'run' || this.mode === 'duck')
    ) {
      const heavy = this.heldBeast ? 0.75 : 1;
      for (const part of parts) {
        part.imp.y += part.mass * T.jumpV * heavy * this.jumpScale();
        part.imp.x += part.mass * _move.x * mag * T.jumpFwd;
        part.imp.z += part.mass * _move.z * mag * T.jumpFwd;
      }
      this.jumpCool = T.jumpCooldown;
      this.groundLock = 0.2;
      this.grounded = false;
      this.mode = 'jump';
      this.state = 'airborne';
      this.airT = 0.09;
    }
    if (canAct && this.mode === 'climb' && jumpUp) {
      // let go of the ledge with a hop (grab-jump)
      this.releaseAll();
      this.lastRelease = 'grabjump';
      this.grabDelay = 0.4;
      for (const part of parts) {
        part.imp.y += part.mass * T.jumpV * 0.9;
        part.imp.x += part.mass * _move.x * mag * 1.5;
        part.imp.z += part.mass * _move.z * mag * 1.5;
      }
      this.mode = 'jump';
      this.airT = 0.09;
      this.groundLock = 0.2;
    }

    // ---------------------------------------------------------------- kick
    if (canAct && kickEdge && this.kickCool <= 0 && this.mode !== 'swim' && this.mode !== 'climb') {
      this.kickT = 0;
      this.kickLanded = false;
      this.kickAir = this.mode === 'jump' || this.mode === 'fall';
      this.kickLeg = 1 - this.kickLeg;
      this.kickCool = T.kickCooldown;
      this.attackT = 0.6;
    }

    // ---------------------------------------------------------------- body control
    switch (this.mode) {
      case 'stand':
      case 'walk':
      case 'run':
      case 'duck':
      case 'getup':
        this.controlGrounded(dt, s, mag);
        break;
      case 'jump':
      case 'fall':
        this.controlAir(dt, s, mag, now);
        break;
      case 'climb':
        this.controlClimb(dt, s, mag, inp.jump);
        break;
      case 'swim':
        this.controlSwim(dt, s, mag, now);
        break;
      case 'ko':
      case 'out':
        break;
    }
    if (this.mode !== 'ko' && !out) this.controlHead(s);

    // ---------------------------------------------------------------- hands, kick, headbutt
    this.updateHands(dt, s, canAct && this.mode !== 'swim', now, liftUp);
    if (this.kickT >= 0) this.updateKick(dt, s);
    if (this.headbuttT >= 0) this.updateHeadbutt(dt, s);
    this.maintainGrabs(dt);
    this.applyBuoyancy(dt);

    // ---------------------------------------------------------------- damping + apply
    const kdT = (this.mode === 'ko' || out ? 0.6 : T.torsoDamp * (0.25 + 0.75 * s));
    const kdH = this.mode === 'ko' || out ? 0.3 : T.headDamp * (0.4 + 0.6 * s);
    const kdL = this.mode === 'ko' || out ? 0.4 : T.limbDamp * (0.3 + 0.7 * s);
    for (let i = 0; i < PART_COUNT; i++) {
      const p = parts[i];
      const kd = i <= CHEST ? kdT : i === HEAD ? kdH : kdL;
      p.alpha.addScaledVector(p.ang, -kd);
      const am = p.alpha.length();
      if (am > 1400) p.alpha.multiplyScalar(1400 / am);
      if (am > 1e-6) {
        // torque = R * (I_local . (R^-1 alpha)) * dt
        _q2.copy(p.quat).invert();
        _a.copy(p.alpha).applyQuaternion(_q2);
        _a.set(_a.x * p.inertia.x, _a.y * p.inertia.y, _a.z * p.inertia.z).applyQuaternion(p.quat).multiplyScalar(dt);
        _rv.x = _a.x;
        _rv.y = _a.y;
        _rv.z = _a.z;
        p.body.applyTorqueImpulse(_rv, true);
      }
      if (p.imp.lengthSq() > 1e-12) {
        _rv.x = p.imp.x;
        _rv.y = p.imp.y;
        _rv.z = p.imp.z;
        p.body.applyImpulse(_rv, true);
      }
    }
    this.hands[0].btn = inp.grabLeft;
    this.hands[1].btn = inp.grabRight;
    if (this.grabLock && !inp.grabLeft && !inp.grabRight) this.grabLock = false;
  }

  // ------------------------------------------------------------------------ grounded
  private controlGrounded(dt: number, s: number, mag: number): void {
    const parts = this.parts;
    const pelvis = parts[PELVIS];
    const chest = parts[CHEST];
    const getup = this.mode === 'getup';
    const duck = this.mode === 'duck';
    const M = this.totalMass;
    const g = T.gravity;

    // horizontal velocity of the body (pelvis + chest)
    const vx = (pelvis.lin.x + chest.lin.x) * 0.5;
    const vz = (pelvis.lin.z + chest.lin.z) * 0.5;
    const speedH = Math.hypot(vx, vz);

    // ---------------- support (pelvis height spring)
    let ax = 0;
    let az = 0;
    if (this.grounded) {
      const h0 = duck ? T.duckHeight * this.scale : this.standH;
      const bob = Math.abs(Math.cos(this.phase)) * T.bob * (this.legAmp / T.stepAmpMax);
      const err = h0 + bob - this.groundDist;
      const sup = getup ? smooth01((s - 0.1) / 0.6) : 0.55 + 0.45 * s;
      let ay = g + T.hoverK * err * sup - T.hoverC * pelvis.lin.y;
      ay = clamp(ay, 0, g * (getup ? 1 + 0.9 * sup : T.hoverMaxG));
      if (getup) ay *= 0.5 + 0.5 * sup;
      const J = M * ay * dt;
      pelvis.imp.y += J * (1 - T.hoverChestShare);
      chest.imp.y += J * T.hoverChestShare;

      // ---------------- locomotion
      if (!getup || s > 0.45) {
        let speed = this.input.run && s > 0.5 ? T.runSpeed : T.walkSpeed;
        if (duck) speed = T.duckSpeed;
        if (this.heldBeast) speed *= T.holdSpeedFactor;
        if (this.headbuttT >= 0 || this.kickT >= 0) speed *= 0.5;
        speed *= this.scale > 1 ? 1 / Math.sqrt(this.scale) : 1;
        const tvx = _move.x * mag * speed;
        const tvz = _move.z * mag * speed;
        ax = (tvx - vx) * T.moveGain;
        az = (tvz - vz) * T.moveGain;
        const amax = T.moveAccel * (0.35 + 0.65 * s);
        const am = Math.hypot(ax, az);
        if (am > amax) {
          ax *= amax / am;
          az *= amax / am;
        }
        const Jx = M * ax * dt;
        const Jz = M * az * dt;
        pelvis.imp.x += Jx * 0.55;
        pelvis.imp.z += Jz * 0.55;
        chest.imp.x += Jx * 0.45;
        chest.imp.z += Jz * 0.45;
      }
    }

    // ---------------- torso posture (lean into the acceleration, waddle, idle sway)
    const sT = getup ? s * 1.1 : s;
    _a.set(ax * T.lean, 1, az * T.lean);
    const ampN = this.legAmp / T.stepAmpMax;
    const wad = Math.sin(this.phase) * T.waddle * ampN;
    _a.addScaledVector(_left, wad);
    const tt = this.ctx.time() + this.id * 1.7;
    _a.x += Math.sin(tt * 1.3) * T.idleSway * (1 - ampN);
    _a.z += Math.cos(tt * 0.9) * T.idleSway * (1 - ampN);
    if (duck) _a.addScaledVector(_fwd, 0.55);
    if (this.heldBeast && this.liftT <= 0) _a.addScaledVector(_fwd, -0.15); // lean back while dragging
    _a.normalize();
    this.align(chest, this.upOf(chest, _b), _a, T.torsoTilt * sT);
    _b.copy(UP).addScaledVector(_left, -wad * 0.6);
    this.align(pelvis, this.upOf(pelvis, _a), _b, T.pelvisTilt * sT);
    const yawK = T.torsoYaw * s;
    this.yawTo(chest, this.targetYaw, yawK);
    this.yawTo(pelvis, this.targetYaw, yawK);

    // ---------------- legs (step cycle)
    const moving = speedH > 0.3 || mag > 0.1;
    const freq = moving ? T.stepBase + speedH * T.stepPerSpeed : 0;
    this.phase = (this.phase + Math.PI * 2 * freq * dt) % (Math.PI * 2);
    const ampT = moving ? clamp(speedH * T.stepAmpPerSpeed + 0.12, 0, T.stepAmpMax) : 0;
    this.legAmp += (ampT - this.legAmp) * Math.min(1, dt * 8);
    const legK = T.legGain * (getup ? s * 0.8 : s);
    // the pelvis frame for leg targets
    const pf = this.yawOf(pelvis, this.facing);
    _c.set(Math.sin(pf), 0, Math.cos(pf));
    _d.set(_c.z, 0, -_c.x);
    for (let side = 0; side < 2; side++) {
      const upper = side === 0 ? ULEG_L : ULEG_R;
      const lower = side === 0 ? LLEG_L : LLEG_R;
      if (this.kickT >= 0 && (this.kickAir || this.kickLeg === side)) continue;
      const sign = side === 0 ? 1 : -1;
      const ph = this.phase + side * Math.PI;
      let th = this.legAmp * Math.sin(ph);
      let knee = this.legAmp * 1.7 * Math.max(0, Math.cos(ph));
      if (duck) {
        th += 0.85;
        knee += 1.5;
      }
      if (getup && s < 0.5) {
        th += 0.6;
        knee += 1.2;
      }
      this.legTarget(_e, th, sign * 0.07, _c, _d);
      this.align(parts[upper], parts[upper].bone, _e, legK);
      this.legTarget(_e, th - knee, sign * 0.04, _c, _d);
      this.align(parts[lower], parts[lower].bone, _e, legK);
      this.twistTo(parts[lower], _c, legK * 0.3);
    }
    // ---------------- arms
    this.swingArms(s, getup);
  }

  // ------------------------------------------------------------------------ airborne
  private controlAir(dt: number, s: number, mag: number, now: number): void {
    const parts = this.parts;
    const pelvis = parts[PELVIS];
    const chest = parts[CHEST];
    const fall = this.mode === 'fall';
    // air control
    if (mag > 0) {
      const ax = _move.x * mag * T.airAccel;
      const az = _move.z * mag * T.airAccel;
      const vx = chest.lin.x;
      const vz = chest.lin.z;
      // only accelerate up to the walk speed in the move direction
      if (vx * _move.x + vz * _move.z < T.walkSpeed) {
        for (const i of AIR_PARTS) {
          parts[i].imp.x += this.totalMass * 0.5 * ax * dt;
          parts[i].imp.z += this.totalMass * 0.5 * az * dt;
        }
      }
    }
    const tilt = fall ? 0.35 : 0.7;
    if (this.kickT >= 0 && this.kickAir) {
      // drop kick: lean back
      _a.copy(UP).addScaledVector(_fwd, -1.2).normalize();
      this.align(chest, this.upOf(chest, _b), _a, T.torsoTilt * 0.8);
      this.align(pelvis, this.upOf(pelvis, _b), _a, T.pelvisTilt * 0.8);
    } else {
      this.align(chest, this.upOf(chest, _b), UP, T.torsoTilt * tilt * s);
      this.align(pelvis, this.upOf(pelvis, _b), UP, T.pelvisTilt * tilt * s);
    }
    this.yawTo(chest, this.targetYaw, T.torsoYaw * 0.4 * s);
    this.yawTo(pelvis, this.targetYaw, T.torsoYaw * 0.4 * s);
    // legs: tucked while jumping, cycling while falling
    for (let side = 0; side < 2; side++) {
      if (this.kickT >= 0 && (this.kickAir || this.kickLeg === side)) continue;
      const upper = side === 0 ? ULEG_L : ULEG_R;
      const lower = side === 0 ? LLEG_L : LLEG_R;
      const sign = side === 0 ? 1 : -1;
      let th = 0.55;
      let knee = 1.1;
      if (fall) {
        th = 0.5 * Math.sin(now * 11 + side * Math.PI);
        knee = 0.8 + 0.5 * Math.cos(now * 11 + side * Math.PI);
      }
      this.legTarget(_e, th, sign * 0.12, _fwd, _left);
      this.align(parts[upper], parts[upper].bone, _e, T.legGain * 0.6 * s);
      this.legTarget(_e, th - knee, sign * 0.06, _fwd, _left);
      this.align(parts[lower], parts[lower].bone, _e, T.legGain * 0.6 * s);
    }
    if (fall) this.flailArms(now, s);
    else this.swingArms(s, false);
  }

  // ------------------------------------------------------------------------ climbing
  private controlClimb(dt: number, s: number, mag: number, jumpHeld: boolean): void {
    const parts = this.parts;
    const chest = parts[CHEST];
    const pelvis = parts[PELVIS];
    const n = this.hangingCount();
    // anchor = mean of the static grab points
    _g.set(0, 0, 0);
    let k = 0;
    let ledgeY = -Infinity;
    for (const h of this.hands) {
      if (h.joint && h.kind === 'static') {
        this.anchorWorld(h, _a);
        _g.add(_a);
        k++;
        ledgeY = Math.max(ledgeY, h.ledgeY);
      }
    }
    if (k > 0) _g.multiplyScalar(1 / k);
    if (!Number.isFinite(ledgeY)) ledgeY = _g.y;
    this.climbLedgeY = ledgeY;
    this.hangAnchor.copy(_g);
    const M = this.totalMass;
    // strong arms: carry part of the weight so the hands don't stretch
    const assist = Math.min(0.85, T.hangAssist * n);
    chest.imp.y += M * T.gravity * assist * dt;
    const over = chest.pos.y > ledgeY + 0.1 * this.scale;
    // horizontal direction into the obstacle (from its face normal)
    const cd = this.climbDir.set(0, 0, 0);
    for (const h of this.hands) if (h.joint && h.kind === 'static') cd.add(h.ledgeDir);
    if (cd.lengthSq() < 1e-4) cd.copy(_fwd);
    cd.normalize();
    if (jumpHeld && this.stamina > 5) {
      // pull up: chest toward above the ledge, then over it (pelvis follows, knees up)
      _a.set(_g.x, ledgeY + 0.45 * this.scale, _g.z);
      _b.subVectors(_a, chest.pos);
      if (over) {
        _b.x += cd.x * 0.9;
        _b.z += cd.z * 0.9;
      }
      _b.multiplyScalar(12).addScaledVector(chest.lin, -4);
      let am = _b.length();
      if (am > T.pullUpAccel) _b.multiplyScalar(T.pullUpAccel / am);
      chest.imp.addScaledVector(_b, M * 0.6 * dt);
      pelvis.imp.addScaledVector(_b, M * 0.2 * dt);
      if (over) {
        _c.set(_g.x + cd.x * 0.35, ledgeY + 0.3 * this.scale, _g.z + cd.z * 0.35).sub(pelvis.pos).multiplyScalar(10).addScaledVector(pelvis.lin, -3);
        am = _c.length();
        if (am > T.pullUpAccel) _c.multiplyScalar(T.pullUpAccel / am);
        pelvis.imp.addScaledVector(_c, M * 0.45 * dt);
        // made it: pelvis at ledge height and the body past the grab point -> let go, roll on top
        // on top when a ray down from the chest finds the ledge surface: let go and roll over
        if (pelvis.pos.y > ledgeY - 0.1 * this.scale && this.surfaceBelow(chest.pos, 0.6) > ledgeY - 0.12) {
          this.releaseAll();
          this.lastRelease = 'climbed';
          this.grabLock = true;
          this.grabDelay = 0.3;
          for (const q of parts) {
            q.imp.addScaledVector(cd, q.mass * 1.7);
            q.imp.y += q.mass * 1.4;
          }
          this.impactGrace = 0.05;
          this.groundLock = 0;
        }
      }
      this.stamina -= 6 * dt;
    }
    if (mag > 0) {
      chest.imp.x += M * 0.3 * _move.x * mag * 3 * dt;
      chest.imp.z += M * 0.3 * _move.z * mag * 3 * dt;
    }
    // face the wall/ledge
    this.targetYaw = Math.atan2(cd.x, cd.z);
    this.align(chest, this.upOf(chest, _b), UP, T.torsoTilt * 0.5 * s);
    this.yawTo(chest, this.targetYaw, T.torsoYaw * 0.5 * s);
    this.yawTo(pelvis, this.targetYaw, T.torsoYaw * 0.3 * s);
    // legs scramble
    const t = this.ctx.time();
    for (let side = 0; side < 2; side++) {
      const upper = side === 0 ? ULEG_L : ULEG_R;
      const lower = side === 0 ? LLEG_L : LLEG_R;
      const ph = t * 9 + side * Math.PI;
      this.legTarget(_e, (over ? 1.1 : 0.5) + 0.45 * Math.sin(ph), 0, _fwd, _left);
      this.align(parts[upper], parts[upper].bone, _e, T.legGain * 0.4 * s);
      this.legTarget(_e, -0.4 + 0.4 * Math.sin(ph), 0, _fwd, _left);
      this.align(parts[lower], parts[lower].bone, _e, T.legGain * 0.4 * s);
    }
  }

  // ------------------------------------------------------------------------ swimming
  private controlSwim(dt: number, s: number, mag: number, now: number): void {
    const parts = this.parts;
    const chest = parts[CHEST];
    const pelvis = parts[PELVIS];
    if (mag > 0) {
      const vx = chest.lin.x;
      const vz = chest.lin.z;
      let ax = (_move.x * mag * T.swimSpeed - vx) * 3;
      let az = (_move.z * mag * T.swimSpeed - vz) * 3;
      const am = Math.hypot(ax, az);
      if (am > T.swimAccel) {
        ax *= T.swimAccel / am;
        az *= T.swimAccel / am;
      }
      chest.imp.x += this.totalMass * 0.6 * ax * dt;
      chest.imp.z += this.totalMass * 0.6 * az * dt;
      pelvis.imp.x += this.totalMass * 0.4 * ax * dt;
      pelvis.imp.z += this.totalMass * 0.4 * az * dt;
    }
    this.align(chest, this.upOf(chest, _b), UP, T.torsoTilt * 0.45 * s);
    this.align(pelvis, this.upOf(pelvis, _b), UP, T.pelvisTilt * 0.3 * s);
    this.yawTo(chest, this.targetYaw, T.torsoYaw * 0.5 * s);
    // paddling arms + kicking legs
    for (const h of this.hands) {
      if (h.joint || h.punchT >= 0) continue;
      const sign = h.side === 0 ? 1 : -1;
      const ph = now * 6.5 + h.side * Math.PI;
      _a.copy(_fwd).multiplyScalar(Math.cos(ph)).addScaledVector(DOWN, 0.4 + 0.6 * Math.sin(ph)).addScaledVector(_left, sign * 0.55);
      this.align(parts[h.upper], parts[h.upper].bone, _a, 140 * s);
      this.align(parts[h.lower], parts[h.lower].bone, _a, 140 * s);
    }
    for (let side = 0; side < 2; side++) {
      const upper = side === 0 ? ULEG_L : ULEG_R;
      const lower = side === 0 ? LLEG_L : LLEG_R;
      const th = 0.35 * Math.sin(now * 8 + side * Math.PI);
      this.legTarget(_e, th, 0, _fwd, _left);
      this.align(parts[upper], parts[upper].bone, _e, T.legGain * 0.3 * s);
      this.align(parts[lower], parts[lower].bone, _e, T.legGain * 0.3 * s);
    }
  }

  private controlHead(s: number): void {
    const head = this.parts[HEAD];
    this.align(head, this.upOf(head, _b), UP, T.headTilt * s);
    this.yawTo(head, this.targetYaw, T.headYaw * s);
  }

  // ------------------------------------------------------------------------ arms
  private swingArms(s: number, getup: boolean): void {
    const parts = this.parts;
    for (const h of this.hands) {
      if (this.armBusy(h)) continue;
      const sign = h.side === 0 ? 1 : -1;
      const legPh = this.phase + h.side * Math.PI;
      const th = -this.legAmp * T.armSwing * Math.sin(legPh) + 0.1;
      _a.copy(DOWN).multiplyScalar(Math.cos(th)).addScaledVector(_fwd, Math.sin(th)).addScaledVector(_left, sign * 0.16);
      const k = (this.legAmp > 0.15 ? T.armSwingGain : T.armIdleGain) * s * (getup ? 0.5 : 1);
      this.align(parts[h.upper], parts[h.upper].bone, _a, k);
      const tf = th + 0.45 + this.legAmp * 0.4;
      _a.copy(DOWN).multiplyScalar(Math.cos(tf)).addScaledVector(_fwd, Math.sin(tf)).addScaledVector(_left, sign * 0.1);
      this.align(parts[h.lower], parts[h.lower].bone, _a, k);
    }
  }

  private flailArms(now: number, s: number): void {
    const parts = this.parts;
    for (const h of this.hands) {
      if (this.armBusy(h)) continue;
      const sign = h.side === 0 ? 1 : -1;
      _a.copy(UP)
        .multiplyScalar(0.7)
        .addScaledVector(_left, sign * 0.8)
        .addScaledVector(_fwd, 0.6 * Math.sin(now * 13 + h.side * 2.1));
      this.align(parts[h.upper], parts[h.upper].bone, _a, 130 * Math.max(0.4, s));
      _a.copy(UP).addScaledVector(_fwd, 0.7 * Math.sin(now * 16 + h.side)).addScaledVector(_left, sign * 0.4);
      this.align(parts[h.lower], parts[h.lower].bone, _a, 130 * Math.max(0.4, s));
    }
  }

  private armBusy(h: HandRt): boolean {
    return h.punchT >= 0 || h.btn || h.joint !== null || (this.input.lift && this.mode !== 'ko');
  }

  private updateHands(dt: number, s: number, canAct: boolean, now: number, liftUp: boolean): void {
    const parts = this.parts;
    const inp = this.input;
    const chest = parts[CHEST];
    let liftActive = false;
    const holdingSomething = this.hands[0].joint !== null || this.hands[1].joint !== null;
    if (canAct && inp.lift && holdingSomething) {
      this.liftT += dt;
      liftActive = true;
    }
    // throw on lift release after a proper lift
    if (liftUp && this.liftT > 0.25 && holdingSomething) this.throwHeld();
    if (!liftActive) this.liftT = 0;

    for (const h of this.hands) {
      const btn = h.side === 0 ? inp.grabLeft : inp.grabRight;
      h.punchCool -= dt;
      if (!canAct) {
        if (this.mode === 'ko' || this.mode === 'out') {
          h.pressT = 0;
          h.punchT = -1;
        }
        if (!btn) h.pressT = 0;
        continue;
      }
      const upper = parts[h.upper];
      const lower = parts[h.lower];
      const sign = h.side === 0 ? 1 : -1;
      // ---------------- button logic (Gang Beasts PunchGrab)
      if (btn && !h.btn) {
        h.pressT = 0;
      }
      if (btn) h.pressT += dt;
      if (!btn && h.btn) {
        if (h.pressT <= T.tapTime && !h.joint) {
          if (h.punchT < 0 && h.punchCool <= 0) this.startPunch(h);
        } else if (h.joint) {
          if (inp.lift && this.liftT > 0.15) this.throwHeld();
          else this.release(h);
          this.grabDelay = Math.max(this.grabDelay, 0.15);
        }
        h.pressT = 0;
      }

      // ---------------- arm control by priority
      if (h.punchT >= 0) {
        this.updatePunch(h, dt, s);
        continue;
      }
      if (h.joint) {
        if (liftActive) {
          _a.copy(UP).addScaledVector(_fwd, 0.25).addScaledVector(_left, sign * 0.15).normalize();
          this.align(upper, upper.bone, _a, T.liftArmGain * Math.max(0.5, s));
          this.align(lower, lower.bone, _a, T.liftArmGain * Math.max(0.5, s));
        } else {
          // pull toward what is held
          this.anchorWorld(h, _b);
          this.shoulderOf(h, _c);
          _a.subVectors(_b, _c);
          if (this.mode === 'climb') _a.y = Math.max(_a.y, 0.2);
          this.align(upper, upper.bone, _a, T.reachGain * 0.7 * s);
          this.align(lower, lower.bone, _a, T.reachGain * 0.7 * s);
        }
        continue;
      }
      if (btn) {
        if (h.pressT <= T.tapTime) {
          // guard / cocked fist
          _a.copy(DOWN).multiplyScalar(0.55).addScaledVector(_fwd, 0.3).addScaledVector(_left, sign * 0.4);
          this.align(upper, upper.bone, _a, T.guardGain * s);
          _a.copy(_fwd).multiplyScalar(0.8).addScaledVector(UP, 0.75).addScaledVector(_left, -sign * 0.15);
          this.align(lower, lower.bone, _a, T.guardGain * s);
        } else {
          // reach (grab mode)
          this.shoulderOf(h, _c);
          const target = this.reachTarget(h, _b);
          if (target) _a.subVectors(_b, _c);
          else if (this.mode === 'jump' || this.mode === 'fall') _a.copy(_fwd).multiplyScalar(0.6).addScaledVector(UP, 0.8);
          else _a.copy(_fwd).addScaledVector(UP, this.ducking ? -0.4 : 0.12).addScaledVector(_left, sign * 0.08);
          this.align(upper, upper.bone, _a, T.reachGain * Math.max(0.35, s));
          this.align(lower, lower.bone, _a, T.reachGain * Math.max(0.35, s));
          if (target) {
            const tip = this.tipOf(h.lower, BEAST_HAND_TIP, _d);
            _e.subVectors(_b, tip);
            const dist = _e.length();
            if (dist < 1.3 && dist > 1e-4) {
              _e.multiplyScalar((T.handPull * s) / dist);
              lower.imp.addScaledVector(_e, lower.mass * dt);
              upper.imp.addScaledVector(_e, -lower.mass * dt);
            }
          }
          if (this.grabDelay <= 0 && this.stamina > 0 && !this.grabLock) this.tryGrab(h);
        }
        continue;
      }
      if (inp.lift && this.mode !== 'ko') {
        // cheering: both arms straight up
        _a.copy(UP).addScaledVector(_left, sign * 0.25);
        this.align(upper, upper.bone, _a, 160 * s);
        this.align(lower, lower.bone, _a, 160 * s);
      }
    }
  }

  private startPunch(h: HandRt): void {
    h.punchT = 0;
    h.punchLanded = false;
    h.punchCool = T.punchCooldown;
    const other = this.hands[1 - h.side];
    other.punchCool = Math.max(other.punchCool, 0.16);
    this.attackT = 0.5;
    // aim at the nearest enemy head/chest in front, else straight ahead
    const tgt = this.nearestEnemy(1.9, 0.2);
    const chest = this.parts[CHEST];
    if (tgt) {
      const head = tgt.parts[HEAD].pos;
      const tc = tgt.parts[CHEST].pos;
      // aim between head and upper chest
      h.aim.copy(head).lerp(tc, 0.35);
    } else {
      h.aim.copy(chest.pos).addScaledVector(_fwd, 1.2).addScaledVector(UP, 0.18 * this.scale);
    }
  }

  private updatePunch(h: HandRt, dt: number, s: number): void {
    const parts = this.parts;
    const upper = parts[h.upper];
    const lower = parts[h.lower];
    const sign = h.side === 0 ? 1 : -1;
    const t = h.punchT;
    h.punchT += dt;
    const k = Math.max(0.45, s);
    if (t < T.punchWind) {
      _a.copy(DOWN).multiplyScalar(0.4).addScaledVector(_fwd, -0.5).addScaledVector(_left, sign * 0.5);
      this.align(upper, upper.bone, _a, T.guardGain * 1.2 * k);
      _a.copy(_fwd).addScaledVector(UP, 0.6);
      this.align(lower, lower.bone, _a, T.guardGain * 1.2 * k);
    } else if (t < T.punchStrike) {
      this.shoulderOf(h, _c);
      _a.subVectors(h.aim, _c);
      if (_a.lengthSq() < 1e-6) _a.copy(_fwd);
      _a.normalize();
      this.align(upper, upper.bone, _a, T.punchGain * k);
      this.align(lower, lower.bone, _a, T.punchGain * k);
      if (t - dt < T.punchWind) {
        // the snap: velocity change on the fist, a small lunge of the body
        lower.imp.addScaledVector(_a, lower.mass * T.punchSpeed * k);
        upper.imp.addScaledVector(_a, upper.mass * T.punchSpeed * 0.5 * k);
        // lunge: step into the punch when the target is a bit far
        _b.subVectors(h.aim, _c);
        const far = clamp((Math.hypot(_b.x, _b.z) - 0.55 * this.scale) * 2.5, 0.4, 1.6);
        parts[CHEST].imp.addScaledVector(_fwd, parts[CHEST].mass * far);
        parts[PELVIS].imp.addScaledVector(_fwd, parts[PELVIS].mass * far * 0.6);
      }
      if (!h.punchLanded) {
        const tip = this.tipOf(h.lower, BEAST_HAND_TIP, _tip);
        this.tipVelocity(lower, tip, _tipVel);
        const hit = this.hitScan(tip, lower.radius, h.lower);
        if (hit) {
          h.punchLanded = true;
          this.landHit(hit.beast, hit.part, tip, _tipVel, T.punchDamage, T.punchDamageExtra, 9);
        }
      }
    } else if (t < T.punchEnd) {
      _a.copy(DOWN).multiplyScalar(0.6).addScaledVector(_fwd, 0.4).addScaledVector(_left, sign * 0.3);
      this.align(upper, upper.bone, _a, T.guardGain * 0.5 * k);
      _a.copy(_fwd).addScaledVector(UP, 0.3);
      this.align(lower, lower.bone, _a, T.guardGain * 0.5 * k);
    } else {
      h.punchT = -1;
      this.grabDelay = Math.max(this.grabDelay, 0.1);
    }
  }

  // ------------------------------------------------------------------------ kick / headbutt
  private updateKick(dt: number, s: number): void {
    const parts = this.parts;
    const t = this.kickT;
    this.kickT += dt;
    const k = Math.max(0.5, s);
    const legs = this.kickAir ? LEGS_BOTH : this.kickLeg === 0 ? LEGS_L : LEGS_R;
    for (const side of legs) {
      const upper = parts[side === 0 ? ULEG_L : ULEG_R];
      const lower = parts[side === 0 ? LLEG_L : LLEG_R];
      if (t < T.kickChamber) {
        this.legTarget(_e, 1.2, 0, _fwd, _left);
        this.align(upper, upper.bone, _e, T.kickGain * 0.6 * k);
        this.legTarget(_e, -0.3, 0, _fwd, _left);
        this.align(lower, lower.bone, _e, T.kickGain * 0.6 * k);
      } else if (t < T.kickExtend) {
        this.legTarget(_e, 1.45, 0, _fwd, _left);
        this.align(upper, upper.bone, _e, T.kickGain * k);
        this.align(lower, lower.bone, _e, T.kickGain * k);
        if (t - dt < T.kickChamber) {
          lower.imp.addScaledVector(_e, lower.mass * T.kickSpeed * k);
          upper.imp.addScaledVector(_e, upper.mass * T.kickSpeed * 0.5 * k);
          if (this.kickAir) {
            for (const p of parts) p.imp.addScaledVector(_fwd, p.mass * 2.2);
            this.impactGrace = 0.05;
          } else {
            parts[PELVIS].imp.addScaledVector(_fwd, -parts[PELVIS].mass * 0.6);
          }
        }
        if (!this.kickLanded) {
          const tip = this.tipOf(lower.index, BEAST_FOOT_TIP, _tip);
          this.tipVelocity(lower, tip, _tipVel);
          const hit = this.hitScan(tip, lower.radius, lower.index);
          if (hit) {
            this.kickLanded = true;
            const mult = this.kickAir ? 2 : 1;
            this.landHit(hit.beast, hit.part, tip, _tipVel, T.kickDamage * mult, T.kickDamageExtra * mult, 8);
          }
        }
      } else if (t < T.kickEnd) {
        this.legTarget(_e, 0.4, 0, _fwd, _left);
        this.align(upper, upper.bone, _e, T.legGain * 0.6 * k);
        this.align(lower, lower.bone, _e, T.legGain * 0.6 * k);
      }
    }
    if (t >= T.kickEnd) this.kickT = -1;
  }

  private updateHeadbutt(dt: number, s: number): void {
    const parts = this.parts;
    const chest = parts[CHEST];
    const head = parts[HEAD];
    const t = this.headbuttT;
    this.headbuttT += dt;
    const k = Math.max(0.5, s);
    if (t < T.headbuttWind) {
      _a.copy(UP).addScaledVector(_fwd, -0.4).normalize();
      this.align(chest, this.upOf(chest, _b), _a, T.torsoTilt * 1.5 * k);
      this.align(head, this.upOf(head, _b), _a, T.headTilt * 2 * k);
    } else if (t < T.headbuttStrike) {
      _a.copy(UP).addScaledVector(_fwd, 1.1).normalize();
      this.align(chest, this.upOf(chest, _b), _a, T.torsoTilt * 2.5 * k);
      this.align(head, this.upOf(head, _b), _a, T.headTilt * 3 * k);
      if (t - dt < T.headbuttWind) {
        head.imp.addScaledVector(_fwd, head.mass * T.headbuttSpeed * k);
        chest.imp.addScaledVector(_fwd, chest.mass * T.headbuttSpeed * 0.4 * k);
      }
      if (!this.headbuttLanded) {
        this.tipVelocity(head, head.pos, _tipVel);
        const hit = this.hitScan(head.pos, head.radius, HEAD);
        if (hit) {
          this.headbuttLanded = true;
          this.landHit(hit.beast, hit.part, head.pos, _tipVel, T.headbuttDamage, T.headbuttDamageExtra, 6);
          this.strength = Math.max(0.2, this.strength - 0.15); // it hurts a bit yourself too
        }
      }
    } else if (t >= T.headbuttEnd) {
      this.headbuttT = -1;
    }
  }

  // ------------------------------------------------------------------------ hits
  /** Nearest part of another beast touching a sphere (p, r). */
  private hitScan(p: THREE.Vector3, r: number, _ownPart: number): { beast: BeastImpl; part: number } | null {
    let best: BeastImpl | null = null;
    let bestPart = -1;
    let bestD = Infinity;
    for (const o of this.ctx.beasts) {
      if (o === this || !o.alive || o.state === 'eliminated') continue;
      const oc = o.parts[CHEST].pos;
      if (Math.abs(oc.x - p.x) > 2 || Math.abs(oc.z - p.z) > 2 || Math.abs(oc.y - p.y) > 2.2) continue;
      for (let i = 0; i < PART_COUNT; i++) {
        const q = o.parts[i];
        const d = this.distToPart(p, q, _hitPoint) - q.radius - r;
        if (d < 0.03 && d < bestD) {
          bestD = d;
          best = o;
          bestPart = i;
        }
      }
    }
    return best ? { beast: best, part: bestPart } : null;
  }

  private distToPart(p: THREE.Vector3, q: PartRt, out: THREE.Vector3): number {
    if (q.halfHeight <= 0) {
      out.copy(q.pos);
      return p.distanceTo(q.pos);
    }
    _f.copy(q.bone).multiplyScalar(q.halfHeight);
    _a.copy(q.pos).sub(_f);
    _b.copy(q.pos).add(_f);
    return pointSegment(p, _a, _b, out);
  }

  /** Apply a strike from this beast to `target.parts[part]`. */
  private landHit(
    target: BeastImpl,
    part: number,
    at: THREE.Vector3,
    tipVel: THREE.Vector3,
    base: number,
    extra: number,
    speedRef: number,
  ): void {
    const q = target.parts[part];
    _hitDir.subVectors(tipVel, q.lin);
    const rel = _hitDir.length();
    if (rel < 1e-3) _hitDir.copy(_fwd);
    _hitDir.normalize();
    const strength = clamp((rel - 1) / speedRef, 0.15, 1);
    const dmg = (base + extra * strength) * DAMAGE_MULT[part];
    _hitPoint.copy(q.pos).lerp(at, 0.5);
    target.receiveHit(this, part, dmg, strength, _hitDir, _hitPoint, true);
  }

  /** Damage + knockback + stagger. dir = null: physical impact (no extra knockback). */
  receiveHit(
    attacker: BeastImpl | null,
    part: number,
    damage: number,
    strength: number,
    dir: THREE.Vector3 | null,
    point: THREE.Vector3,
    knock: boolean,
  ): void {
    if (this.state === 'eliminated') return;
    const now = this.ctx.time();
    this.lastHitT = now;
    this.hurtT = 0.6;
    if (dir && knock) {
      const kb = T.knockback * strength * (part === HEAD ? 1.2 : 1);
      const q = this.parts[part];
      q.body.applyImpulse({ x: dir.x * kb * q.mass * 1.5, y: (dir.y * kb + 0.8 * kb * 0.3) * q.mass * 1.5, z: dir.z * kb * q.mass * 1.5 }, true);
      const c = this.parts[CHEST];
      c.body.applyImpulse({ x: dir.x * kb * c.mass * 0.45, y: 0.6 * c.mass * strength, z: dir.z * kb * c.mass * 0.45 }, true);
      this.impactGrace = Math.max(this.impactGrace, 0.04);
    }
    if (this.mode === 'ko') {
      this.koTime = Math.min(T.koMax, this.koTime + T.koHitExtend * (0.5 + strength));
    } else {
      this.health -= damage;
      this.strength = Math.max(0.05, this.strength - T.hitStagger * strength * (part === HEAD ? 1.3 : 0.8));
      if (damage >= T.koThreshold || this.health <= 0) {
        this.health = 0;
        this.knockOut();
      }
    }
    this.ctx.emitHit(this, attacker, strength, point);
  }

  // ------------------------------------------------------------------------ grabbing
  private reachTarget(h: HandRt, out: THREE.Vector3): boolean {
    const tgt = this.nearestEnemy(T.reachRange * this.scale, 0.0);
    if (!tgt) return false;
    // closest of chest / head / upper arms / pelvis to the hand
    const tip = this.tipOf(h.lower, BEAST_HAND_TIP, _d);
    let best = Infinity;
    for (const i of REACH_PARTS) {
      const d = tip.distanceToSquared(tgt.parts[i].pos);
      if (d < best) {
        best = d;
        out.copy(tgt.parts[i].pos);
      }
    }
    return true;
  }

  private tryGrab(h: HandRt): void {
    const lower = this.parts[h.lower];
    const tip = this.tipOf(h.lower, BEAST_HAND_TIP, _tip);
    // 1) other beasts (analytic)
    let best: BeastImpl | null = null;
    let bestPart = -1;
    let bestD = Infinity;
    for (const o of this.ctx.beasts) {
      if (o === this || !o.alive) continue;
      const oc = o.parts[CHEST].pos;
      if (Math.abs(oc.x - tip.x) > 2 || Math.abs(oc.z - tip.z) > 2) continue;
      for (let i = 0; i < PART_COUNT; i++) {
        const q = o.parts[i];
        const d = this.distToPart(tip, q, _hitPoint) - q.radius - lower.radius;
        if (d < 0.06 && d < bestD) {
          bestD = d;
          best = o;
          bestPart = i;
        }
      }
    }
    if (best) {
      this.attach(h, 'beast', best.parts[bestPart].body, tip, best, bestPart);
      return;
    }
    // 2) props and scenery (Rapier shape query)
    const r = lower.radius + 0.04;
    if (!_ballCache || _ballRadius !== r) {
      _ballCache = new RAPIER.Ball(r);
      _ballRadius = r;
    }
    _found.c = null;
    _rv.x = tip.x;
    _rv.y = tip.y;
    _rv.z = tip.z;
    this.ctx.world.intersectionsWithShape(_rv, _ident, _ballCache, onShapeHit, undefined, this.staticPropGroups);
    const c = takeFound();
    if (c) {
      const body = c.parent();
      if (body && body.isDynamic()) this.attach(h, 'prop', body, tip, null, -1);
      else this.attach(h, 'static', body && !body.isFixed() ? body : null, tip, null, -1);
    }
  }

  private attach(h: HandRt, kind: HeldKind, body: RAPIER.RigidBody | null, tip: THREE.Vector3, beast: BeastImpl | null, part: number): void {
    const world = this.ctx.world;
    const hand = this.parts[h.lower];
    let other = body;
    if (!other) {
      if (!h.anchorBody) h.anchorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(tip.x, tip.y, tip.z));
      else {
        _rv.x = tip.x;
        _rv.y = tip.y;
        _rv.z = tip.z;
        h.anchorBody.setTranslation(_rv, false);
      }
      other = h.anchorBody;
      h.anchorLocal.set(0, 0, 0);
    } else {
      const t = other.translation();
      const r = other.rotation();
      _q.set(r.x, r.y, r.z, r.w).invert();
      h.anchorLocal.set(tip.x - t.x, tip.y - t.y, tip.z - t.z).applyQuaternion(_q);
    }
    const a1 = { x: 0, y: -BEAST_HAND_TIP * this.scale, z: 0 };
    const a2 = { x: h.anchorLocal.x, y: h.anchorLocal.y, z: h.anchorLocal.z };
    const joint = world.createImpulseJoint(RAPIER.JointData.spherical(a1, a2), hand.body, other, true);
    joint.setContactsEnabled(false);
    h.joint = joint;
    h.kind = kind;
    h.heldBody = body;
    h.heldBeast = beast;
    h.heldPart = part;
    h.stretchT = 0;
    h.grabT = 0;
    h.ledgeY = tip.y;
    if (kind === 'static') {
      // find the top of what we hold: ray down from above, slightly into the obstacle
      const c = this.parts[CHEST].pos;
      let dx = tip.x - c.x;
      let dz = tip.z - c.z;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const ray = this.ray();
      h.ledgeDir.set(dx, 0, dz);
      ray.origin.x = c.x;
      ray.origin.y = tip.y;
      ray.origin.z = c.z;
      ray.dir.x = dx;
      ray.dir.y = 0;
      ray.dir.z = dz;
      const face = world.castRayAndGetNormal(ray, dl + 0.4, true, undefined, this.staticPropGroups);
      if (face && Math.hypot(face.normal.x, face.normal.z) > 0.7) {
        const nl = Math.hypot(face.normal.x, face.normal.z);
        h.ledgeDir.set(-face.normal.x / nl, 0, -face.normal.z / nl);
      }
      ray.origin.x = tip.x + dx * 0.2;
      ray.origin.y = tip.y + 1.4 * this.scale;
      ray.origin.z = tip.z + dz * 0.2;
      ray.dir.x = 0;
      ray.dir.y = -1;
      ray.dir.z = 0;
      const hit = world.castRay(ray, 1.4 * this.scale + 0.3, true, undefined, this.staticPropGroups);
      if (hit) {
        const y = ray.origin.y - hit.timeOfImpact;
        if (y > tip.y - 0.15 && hit.timeOfImpact > 0.05) h.ledgeY = y;
      }
    }
    const id = beast ? beast.id : -1;
    if (h.side === 0) this.holding.left = id;
    else this.holding.right = id;
    if (beast) beast.heldBy.push(this.id);
    this.ctx.emitGrab(this, beast);
  }

  release(h: HandRt): void {
    if (!h.joint) return;
    try {
      this.ctx.world.removeImpulseJoint(h.joint, true);
    } catch {
      /* body already removed */
    }
    if (h.heldBeast) {
      const arr = h.heldBeast.heldBy;
      const i = arr.indexOf(this.id);
      if (i >= 0) arr.splice(i, 1);
    }
    h.joint = null;
    h.kind = null;
    h.heldBeast = null;
    h.heldBody = null;
    h.heldPart = -1;
    if (h.side === 0) this.holding.left = null;
    else this.holding.right = null;
  }

  releaseAll(): void {
    if (!this.hands) return;
    this.release(this.hands[0]);
    this.release(this.hands[1]);
    this.liftT = 0;
  }

  /** Make every beast that holds this one let go. */
  releaseHeldBy(): void {
    for (const o of this.ctx.beasts) {
      if (o === this) continue;
      for (const h of o.hands) if (h.heldBeast === this) o.release(h);
    }
  }

  /** Release this beast's hands that hold `target` (used when `target` is removed). */
  releaseTarget(target: BeastImpl): void {
    for (const h of this.hands) if (h.heldBeast === target) this.release(h);
  }

  private hangingCount(): number {
    let n = 0;
    for (const h of this.hands) if (h.joint && h.kind === 'static') n++;
    return n;
  }

  private anchorWorld(h: HandRt, out: THREE.Vector3): THREE.Vector3 {
    if (h.heldBeast) {
      const q = h.heldBeast.parts[h.heldPart];
      return out.copy(h.anchorLocal).applyQuaternion(q.quat).add(q.pos);
    }
    const b = h.heldBody ?? h.anchorBody;
    if (!b) return out.set(0, 0, 0);
    if (b === h.anchorBody) {
      const t = b.translation();
      return out.set(t.x, t.y, t.z);
    }
    const t = b.translation();
    const r = b.rotation();
    _q2.set(r.x, r.y, r.z, r.w);
    return out.copy(h.anchorLocal).applyQuaternion(_q2).add(_a.set(t.x, t.y, t.z));
  }

  private maintainGrabs(dt: number): void {
    const g = T.gravity;
    let lifted = false;
    for (const h of this.hands) {
      if (!h.joint) continue;
      h.grabT += dt;
      if (h.heldBeast && !h.heldBeast.alive) {
        this.release(h);
        continue;
      }
      // overstretched -> slip
      const tip = this.tipOf(h.lower, BEAST_HAND_TIP, _tip);
      this.anchorWorld(h, _b);
      const stretch = tip.distanceTo(_b);
      if (stretch > T.grabBreakDist * this.scale) h.stretchT += dt;
      else h.stretchT = 0;
      if (h.stretchT > 0.12) {
        this.release(h);
        this.lastRelease = 'stretch';
        this.grabDelay = 0.3;
        continue;
      }
      // a held beast that slides over a ledge (chest well below our feet) slips out of the hands
      // instead of dragging a standing holder in after it (lifted beasts stay held)
      if (h.heldBeast && this.grounded && this.liftT <= 0 && h.heldBeast.parts[CHEST].pos.y < this.groundY - T.dropRelease * this.scale) {
        this.release(h);
        this.lastRelease = 'drop';
        this.grabDelay = 0.4;
        continue;
      }
      // stamina
      const drain = h.kind === 'beast' ? T.drainBeast : h.kind === 'static' ? T.drainStatic : T.drainProp;
      this.stamina -= drain * dt * 0.5;
      if (this.stamina <= 0) {
        this.stamina = -20;
        this.releaseAll();
        this.grabDelay = 1;
        break;
      }
      // lift what is held
      if (this.liftT > 0 && (h.kind === 'beast' || h.kind === 'prop')) {
        lifted = true;
        const both = this.hands[0].joint !== null && this.hands[1].joint !== null;
        const gc = T.liftGComp * (both ? 1 : 0.8) * Math.min(1, this.liftT * 3);
        const head = this.parts[HEAD];
        _c.copy(head.pos).addScaledVector(UP, 0.6 * this.scale).addScaledVector(_fwd, 0.15);
        if (h.heldBeast) {
          const hb = h.heldBeast;
          const share = both ? 0.5 : 1;
          for (const q of hb.parts) {
            _rv.x = 0;
            _rv.y = q.mass * g * gc * share * dt;
            _rv.z = 0;
            q.body.applyImpulse(_rv, true);
          }
          const hp = hb.parts[h.heldPart];
          _d.subVectors(_c, hp.pos).multiplyScalar(T.liftK).addScaledVector(_e.subVectors(hp.lin, this.parts[CHEST].lin), -T.liftC);
          const am = _d.length();
          if (am > T.liftMaxAccel) _d.multiplyScalar(T.liftMaxAccel / am);
          const m = hb.totalMass * 0.35 * share;
          _rv.x = _d.x * m * dt;
          _rv.y = _d.y * m * dt;
          _rv.z = _d.z * m * dt;
          hp.body.applyImpulse(_rv, true);
          const hc = hb.parts[CHEST];
          _rv.x *= 0.6;
          _rv.y *= 0.6;
          _rv.z *= 0.6;
          hc.body.applyImpulse(_rv, true);
        } else if (h.heldBody) {
          const b = h.heldBody;
          const m = b.mass();
          const t = b.translation();
          const lv = b.linvel();
          _d.set(_c.x - t.x, _c.y - t.y, _c.z - t.z).multiplyScalar(T.liftK);
          _d.x -= (lv.x - this.parts[CHEST].lin.x) * T.liftC;
          _d.y -= (lv.y - this.parts[CHEST].lin.y) * T.liftC;
          _d.z -= (lv.z - this.parts[CHEST].lin.z) * T.liftC;
          const am = _d.length();
          if (am > T.liftMaxAccel) _d.multiplyScalar(T.liftMaxAccel / am);
          _rv.x = _d.x * m * dt;
          _rv.y = (_d.y + g * gc) * m * dt;
          _rv.z = _d.z * m * dt;
          b.applyImpulse(_rv, true);
        }
      }
    }
    if (!lifted && this.liftT > 0 && this.hands[0].joint === null && this.hands[1].joint === null) this.liftT = 0;
  }

  /** Throw whatever the hands hold forward (release lift / release grab while lifting). */
  throwHeld(): void {
    const now = this.ctx.time();
    const chest = this.parts[CHEST];
    _g.copy(_fwd).multiplyScalar(T.throwFwd).addScaledVector(UP, T.throwUp);
    const thrown = new Set<BeastImpl | RAPIER.RigidBody>();
    for (const h of this.hands) {
      if (!h.joint) continue;
      const hb = h.heldBeast;
      const body = h.heldBody;
      this.release(h);
      if (hb && !thrown.has(hb)) {
        thrown.add(hb);
        for (const q of hb.parts) {
          _rv.x = (_g.x + chest.lin.x * 0.5 - q.lin.x * 0.5) * q.mass;
          _rv.y = (_g.y - q.lin.y * 0.5) * q.mass;
          _rv.z = (_g.z + chest.lin.z * 0.5 - q.lin.z * 0.5) * q.mass;
          q.body.applyImpulse(_rv, true);
        }
        hb.impactGrace = 0.1;
        hb.lastThrower = this;
        hb.lastThrowT = now;
        hb.strength = Math.min(hb.strength, 0.25);
      } else if (body && !thrown.has(body) && body.isDynamic()) {
        thrown.add(body);
        const m = body.mass();
        _rv.x = _g.x * m;
        _rv.y = _g.y * m;
        _rv.z = _g.z * m;
        body.applyImpulse(_rv, true);
      }
    }
    this.liftT = 0;
    this.grabDelay = 0.4;
    this.attackT = 0.5;
  }

  // ------------------------------------------------------------------------ ground / water
  private ray(): RAPIER.Ray {
    if (!_rayCache) _rayCache = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    return _rayCache;
  }

  /** Highest static/prop surface y below p within maxD (-Infinity if none). */
  surfaceBelow(p: THREE.Vector3, maxD: number): number {
    const ray = this.ray();
    ray.origin.x = p.x;
    ray.origin.y = p.y;
    ray.origin.z = p.z;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const hit = this.ctx.world.castRay(ray, maxD, true, undefined, this.staticPropGroups);
    return hit ? p.y - hit.timeOfImpact : -Infinity;
  }

  private groundCheck(): void {
    const pelvis = this.parts[PELVIS];
    const ray = this.ray();
    ray.origin.x = pelvis.pos.x;
    ray.origin.y = pelvis.pos.y;
    ray.origin.z = pelvis.pos.z;
    ray.dir.x = 0;
    ray.dir.y = -1;
    ray.dir.z = 0;
    const maxD = this.standH + T.groundSlack * this.scale + 0.4;
    const hit = this.ctx.world.castRay(ray, maxD, true, undefined, this.queryGroups);
    if (hit) {
      this.groundDist = hit.timeOfImpact;
      this.groundY = pelvis.pos.y - hit.timeOfImpact;
      const slack = this.mode === 'duck' ? 0.45 : T.groundSlack;
      this.grounded = this.groundLock <= 0 && hit.timeOfImpact < this.standH + slack * this.scale;
    } else {
      this.groundDist = maxD;
      this.grounded = false;
    }
  }

  private waterCheck(dt: number): void {
    const chest = this.parts[CHEST];
    const wl = this.ctx.waterLevel;
    const wet = chest.pos.y < wl + 0.15 * this.scale && this.ctx.isWater(chest.pos.x, chest.pos.z);
    this.inWater = wet;
    if (wet) {
      this.dryT = 0;
      if (!this.splashed) {
        this.splashed = true;
        _a.set(chest.pos.x, wl, chest.pos.z);
        this.ctx.emitSplash(this, _a);
      }
    } else if (this.splashed) {
      this.dryT += dt;
      if (this.dryT > 1.5 && chest.pos.y > wl + 0.6) this.splashed = false;
    }
  }

  private applyBuoyancy(dt: number): void {
    const wl = this.ctx.waterLevel;
    const out = this.state === 'eliminated';
    const g = T.gravity;
    for (let i = 0; i < PART_COUNT; i++) {
      const p = this.parts[i];
      const r = p.radius + p.halfHeight * 0.5;
      const depth = wl - p.pos.y;
      if (depth < -r) continue;
      if (!this.ctx.isWater(p.pos.x, p.pos.z)) continue;
      const frac = clamp((depth + r) / (2 * r), 0, 1);
      const b = out ? T.buoyancyOut : i === CHEST ? T.buoyancyChest : i === PELVIS ? T.buoyancyPelvis : i === HEAD ? T.buoyancyHead : T.buoyancyLimb;
      p.imp.y += p.mass * g * b * frac * dt;
      p.imp.addScaledVector(p.lin, -p.mass * T.waterDrag * frac * dt);
      p.alpha.addScaledVector(p.ang, -2 * frac);
    }
  }

  // ------------------------------------------------------------------------ helpers
  private jumpScale(): number {
    return this.scale > 1 ? 1 / Math.sqrt(this.scale) : 1;
  }

  /** Nearest non-eliminated other beast within range, in front (cos of half-angle >= minDot). */
  nearestEnemy(range: number, minDot: number): BeastImpl | null {
    const c = this.parts[CHEST].pos;
    const fx = Math.sin(this.facing);
    const fz = Math.cos(this.facing);
    let best: BeastImpl | null = null;
    let bestD = range * range;
    for (const o of this.ctx.beasts) {
      if (o === this || !o.alive || o.state === 'eliminated') continue;
      const oc = o.parts[CHEST].pos;
      const dx = oc.x - c.x;
      const dz = oc.z - c.z;
      const dy = oc.y - c.y;
      const d2 = dx * dx + dz * dz + dy * dy * 0.5;
      if (d2 >= bestD) continue;
      const dh = Math.hypot(dx, dz);
      if (dh > 0.05 && (dx * fx + dz * fz) / dh < minDot) continue;
      bestD = d2;
      best = o;
    }
    return best;
  }

  private tipOf(part: number, tipLen: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.parts[part];
    return out.copy(p.bone).multiplyScalar(tipLen * this.scale).add(p.pos);
  }

  private tipVelocity(p: PartRt, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _f.subVectors(point, p.pos);
    return out.crossVectors(p.ang, _f).add(p.lin);
  }

  private shoulderOf(h: HandRt, out: THREE.Vector3): THREE.Vector3 {
    const u = this.parts[h.upper];
    return out.copy(u.bone).multiplyScalar(-(u.halfHeight + u.radius * 0.5)).add(u.pos);
  }

  private upOf(p: PartRt, out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 1, 0).applyQuaternion(p.quat);
  }

  /** Heading (radians about +y, 0 = +z) of a part's forward axis; fallback when it points up/down. */
  private yawOf(p: PartRt, fallback: number): number {
    _f.set(0, 0, 1).applyQuaternion(p.quat);
    const h = Math.hypot(_f.x, _f.z);
    if (h < 0.3) return fallback;
    return Math.atan2(_f.x, _f.z);
  }

  /** legTarget: bone direction rotated `th` from straight down toward `fwd`, plus a side spread. */
  private legTarget(out: THREE.Vector3, th: number, spread: number, fwd: THREE.Vector3, left: THREE.Vector3): THREE.Vector3 {
    return out
      .copy(DOWN)
      .multiplyScalar(Math.cos(th))
      .addScaledVector(fwd, Math.sin(th))
      .addScaledVector(left, spread);
  }

  /** PD alignment of world axis `axis` (of part p) toward `target` (any length). */
  private align(p: PartRt, axis: THREE.Vector3, target: THREE.Vector3, gain: number): void {
    if (gain <= 0) return;
    const tl = target.length();
    if (tl < 1e-6) return;
    const tx = target.x / tl;
    const ty = target.y / tl;
    const tz = target.z / tl;
    let cx = axis.y * tz - axis.z * ty;
    let cy = axis.z * tx - axis.x * tz;
    let cz = axis.x * ty - axis.y * tx;
    const sn = Math.hypot(cx, cy, cz);
    const cs = axis.x * tx + axis.y * ty + axis.z * tz;
    const ang = Math.atan2(sn, cs);
    if (sn < 1e-5) {
      if (cs > 0) return;
      // antiparallel: rotate about any perpendicular axis
      cx = axis.y;
      cy = -axis.x;
      cz = 0;
      const l = Math.hypot(cx, cy, cz) || 1;
      p.alpha.x += (cx / l) * ang * gain;
      p.alpha.y += (cy / l) * ang * gain;
      p.alpha.z += (cz / l) * ang * gain;
      return;
    }
    const k = (gain * ang) / sn;
    p.alpha.x += cx * k;
    p.alpha.y += cy * k;
    p.alpha.z += cz * k;
  }

  /** Yaw torque (about world +y) turning the part's forward axis toward `yaw`. */
  private yawTo(p: PartRt, yaw: number, gain: number): void {
    if (gain <= 0) return;
    _f.set(0, 0, 1).applyQuaternion(p.quat);
    if (Math.hypot(_f.x, _f.z) < 0.3) return;
    const err = wrapAngle(yaw - Math.atan2(_f.x, _f.z));
    p.alpha.y += err * gain;
  }

  /** Twist about the bone axis so the part's local +z points along `fwd` (projected). */
  private twistTo(p: PartRt, fwd: THREE.Vector3, gain: number): void {
    if (gain <= 0) return;
    const b = p.bone;
    _f.set(0, 0, 1).applyQuaternion(p.quat);
    // project both on the plane perpendicular to the bone
    _g.copy(fwd).addScaledVector(b, -fwd.dot(b));
    const gl = _g.length();
    if (gl < 0.2) return;
    _g.multiplyScalar(1 / gl);
    _f.addScaledVector(b, -_f.dot(b)).normalize();
    const c = _a.crossVectors(_f, _g);
    const sn = c.dot(b);
    const ang = Math.atan2(sn, _f.dot(_g));
    p.alpha.addScaledVector(b, ang * gain);
  }

  // ======================================================================== visuals
  /** Interpolate the visual parts between the last two physics states. */
  syncVisual(alpha: number, dt: number): void {
    const vp = this.visual.parts;
    for (let i = 0; i < PART_COUNT; i++) {
      const p = this.parts[i];
      p.ipos.lerpVectors(p.prevPos, p.pos, alpha);
      p.iquat.slerpQuaternions(p.prevQuat, p.quat, alpha);
      const o = vp[p.name];
      o.position.copy(p.ipos);
      o.quaternion.copy(p.iquat);
    }
    this.position.copy(this.parts[CHEST].ipos);
    this.velocity.copy(this.parts[CHEST].lin);
    const e = this.expression();
    if (e !== this.lastExpr) {
      this.lastExpr = e;
      this.visual.setExpression(e);
    }
    this.visual.update(dt);
  }

  private expression(): BeastExpression {
    if (this.expressionOverride) return this.expressionOverride;
    if (this.mode === 'ko' || this.mode === 'out') return 'ko';
    if (this.hurtT > 0) return 'hurt';
    if (this.mode === 'fall' || this.mode === 'swim' || (this.heldBy.length > 0 && this.liftTByOthers())) return 'scared';
    if (this.attackT > 0 || this.heldBeast) return 'angry';
    return 'neutral';
  }

  private liftTByOthers(): boolean {
    for (const o of this.ctx.beasts) if (o !== this && o.heldBeast === this && o.liftT > 0) return true;
    return false;
  }

  /** KO progress for effects: 1 right after the KO, 0 when waking up. */
  get koFraction(): number {
    return this.mode === 'ko' && this.koTotal > 0 ? clamp(this.koTime / this.koTotal, 0, 1) : 0;
  }
}
