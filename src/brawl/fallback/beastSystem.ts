// Placeholder BeastSystem (used only until src/beast/physics/index.ts exists): a kinematic
// "wobbly" fighter per beast — walking, jumping, punching (tap a grab button), grabbing,
// lifting + throwing, kicking, ducking/headbutts, knock-outs — posed with forward kinematics.
// No ragdoll: it exists so the game flow (rounds, HUD, camera, audio) can be built and tested.
import * as THREE from 'three';
import type { Engine, PhysicsWorld } from '../../contracts';
import type { WorldExt } from '../../world/types';
import type {
  Beast,
  BeastInput,
  BeastOptions,
  BeastPartName,
  BeastState,
  BeastSystem,
  BeastSystemEvents,
  BeastVisual,
} from '../contracts';
import { RigPose } from '../pose';

type VisualFactory = (opts: { colour: string; costume: string; scale?: number }) => BeastVisual;

const NEUTRAL: BeastInput = { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false };
const GRAVITY = 16;
const WALK = 3.1;
const RUN = 4.3;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const Y = new THREE.Vector3(0, 1, 0);

class FallbackBeast implements Beast {
  readonly root: THREE.Object3D;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  facing: number;
  state: BeastState = 'active';
  consciousness = 1;
  holding: { left: number | null; right: number | null } = { left: null, right: null };
  readonly visual: BeastVisual;
  readonly feet = new THREE.Vector3();
  readonly pose = new RigPose();
  readonly input: BeastInput = { ...NEUTRAL };
  readonly prev: BeastInput = { ...NEUTRAL };
  onGround = false;
  koTimer = 0;
  punchL = 0;
  punchR = 0;
  kickT = 0;
  holdTimeL = 0;
  holdTimeR = 0;
  walkPhase = 0;
  wobble = 0;
  hurtT = 0;
  airT = 0;
  heldBy: FallbackBeast | null = null;
  thrownT = 0;

  constructor(
    readonly id: number,
    readonly options: Readonly<BeastOptions>,
    visual: BeastVisual,
    at: THREE.Vector3,
    facing: number,
  ) {
    this.visual = visual;
    this.root = visual.root;
    this.facing = facing;
    this.pose.scale = options.scale ?? 1;
    this.feet.copy(at);
  }

  partPosition(part: BeastPartName, out: THREE.Vector3): THREE.Vector3 {
    return this.pose.partWorld(part, out);
  }
  setInput(input: BeastInput): void {
    Object.assign(this.input, input);
  }
  teleport(p: THREE.Vector3, facing: number): void {
    this.feet.copy(p);
    this.velocity.set(0, 0, 0);
    this.facing = facing;
    this.state = 'active';
    this.consciousness = 1;
    this.koTimer = 0;
    this.heldBy = null;
    this.holding = { left: null, right: null };
  }
  eliminate(): void {
    this.state = 'eliminated';
    this.holding = { left: null, right: null };
    Object.assign(this.input, NEUTRAL);
  }
}

export async function createFallbackBeastSystem(
  engine: Engine,
  physics: PhysicsWorld,
  opts: { world?: WorldExt | null },
  makeVisual: VisualFactory,
): Promise<BeastSystem> {
  const world = opts.world ?? null;
  const beasts: FallbackBeast[] = [];
  const listeners = new Set<BeastSystemEvents>();
  let nextId = 1;
  const byId = (id: number | null) => (id === null ? null : beasts.find((b) => b.id === id) ?? null);

  function emitHit(target: FallbackBeast, attacker: FallbackBeast | null, strength: number, point: THREE.Vector3): void {
    target.wobble = Math.min(1.5, target.wobble + strength * 1.4);
    target.hurtT = 0.6;
    for (const l of listeners) l.onHit?.(target, attacker, strength, point);
    if (target.state !== 'eliminated' && target.state !== 'knockedOut') {
      target.consciousness -= strength * 0.42;
      if (target.consciousness <= 0) {
        target.consciousness = 0;
        target.state = 'knockedOut';
        target.koTimer = 3.2;
        target.holding = { left: null, right: null };
        for (const l of listeners) l.onKnockout?.(target);
      }
    }
  }

  /** Closest other beast in front of b within range (chest to chest). */
  function victim(b: FallbackBeast, range: number, minDot = 0.25): FallbackBeast | null {
    let best: FallbackBeast | null = null;
    let bestD = range;
    const fx = Math.sin(b.facing);
    const fz = Math.cos(b.facing);
    for (const o of beasts) {
      if (o === b || o.state === 'eliminated') continue;
      const dx = o.position.x - b.position.x;
      const dz = o.position.z - b.position.z;
      const dy = o.position.y - b.position.y;
      const d = Math.hypot(dx, dz);
      if (d > bestD || Math.abs(dy) > 1.3) continue;
      if (d > 0.2 && (dx * fx + dz * fz) / d < minDot) continue;
      best = o;
      bestD = d;
    }
    return best;
  }

  function strike(b: FallbackBeast, range: number, push: number, up: number, strength: number): void {
    const t = victim(b, range);
    if (!t) return;
    _v.set(t.position.x - b.position.x, 0, t.position.z - b.position.z).normalize();
    t.velocity.addScaledVector(_v, push);
    t.velocity.y += up;
    t.onGround = false;
    _w.copy(t.position).lerp(b.position, 0.35);
    emitHit(t, b, strength, _w);
  }

  function stepBeast(b: FallbackBeast, dt: number): void {
    const out = b.state === 'eliminated';
    const ko = b.state === 'knockedOut';
    const held = b.heldBy !== null;
    const inp = out || ko || held ? NEUTRAL : b.input;
    const prev = b.prev;
    if (ko) {
      b.koTimer -= dt;
      if (b.koTimer <= 0) {
        b.state = 'active';
        b.consciousness = 0.55;
      }
    } else if (!out) b.consciousness = Math.min(1, b.consciousness + dt * 0.07);
    b.hurtT = Math.max(0, b.hurtT - dt);
    b.wobble *= Math.exp(-dt * 3);
    b.thrownT = Math.max(0, b.thrownT - dt);

    // --- held by another beast: follow its hands (lifted over the head when it lifts) ---
    if (b.heldBy) {
      const h = b.heldBy;
      const both = h.holding.left === b.id && h.holding.right === b.id;
      const lifting = both && h.input.lift && h.state !== 'knockedOut';
      const fx = Math.sin(h.facing);
      const fz = Math.cos(h.facing);
      _v.set(h.feet.x + fx * (lifting ? 0.1 : 0.62), h.feet.y + (lifting ? 1.55 : 0.1), h.feet.z + fz * (lifting ? 0.1 : 0.62));
      b.feet.lerp(_v, 1 - Math.exp(-dt * 14));
      b.velocity.set(0, 0, 0);
      if ((h.holding.left !== b.id && h.holding.right !== b.id) || h.state === 'eliminated' || h.state === 'knockedOut') {
        b.heldBy = null;
      }
    }

    // --- control ---
    const mx = inp.moveX;
    const mz = inp.moveZ;
    const mag = Math.min(1, Math.hypot(mx, mz));
    if (!b.heldBy) {
      const speed = (inp.run ? RUN : WALK) * (inp.duck ? 0.4 : 1) * mag;
      const accel = b.onGround ? 16 : 3.5;
      const tx = mag > 0.01 ? (mx / Math.max(mag, 1e-3)) * speed : 0;
      const tz = mag > 0.01 ? (mz / Math.max(mag, 1e-3)) * speed : 0;
      if (b.thrownT <= 0 && (mag > 0.01 || b.onGround)) {
        const k = Math.min(1, accel * dt);
        b.velocity.x += (tx - b.velocity.x) * k;
        b.velocity.z += (tz - b.velocity.z) * k;
      }
      if (mag > 0.1) {
        const target = Math.atan2(mx, mz);
        let d = target - b.facing;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        b.facing += Math.sign(d) * Math.min(Math.abs(d), dt * 9);
      }
      if (inp.jump && !prev.jump && b.onGround) {
        b.velocity.y = 5.4;
        b.onGround = false;
      }
      b.velocity.y -= GRAVITY * dt;
      _v.copy(b.feet).addScaledVector(b.velocity, dt);
      if (!out) {
        // walls: refuse steps higher than 0.45 m
        const g = physics.raycastDown(_v.x, _v.z, b.feet.y + 0.45);
        const gHere = physics.raycastDown(b.feet.x, b.feet.z, b.feet.y + 0.45);
        if (g !== null && gHere !== null && g > b.feet.y + 0.44) {
          _v.x = b.feet.x;
          _v.z = b.feet.z;
          b.velocity.x = 0;
          b.velocity.z = 0;
        }
      }
      b.feet.copy(_v);
      const ground = physics.raycastDown(b.feet.x, b.feet.z, b.feet.y + 0.4);
      const water = world && world.isWater(b.feet.x, b.feet.z) && ground !== null && b.feet.y < ground + 1.2;
      if (out && water) {
        // sink slowly, bob
        b.velocity.multiplyScalar(Math.exp(-dt * 3));
      }
      if (ground !== null && b.feet.y <= ground && b.velocity.y <= 0) {
        b.feet.y = ground;
        b.velocity.y = 0;
        if (!b.onGround) b.airT = 0;
        b.onGround = true;
        if (mag < 0.01 || ko || out) {
          const f = Math.exp(-dt * (ko ? 5 : 9));
          b.velocity.x *= f;
          b.velocity.z *= f;
        }
      } else {
        b.onGround = ground !== null && b.feet.y - ground < 0.04;
        if (!b.onGround) b.airT += dt;
      }
      if (b.feet.y < -60) {
        b.feet.y = -60;
        b.velocity.set(0, 0, 0);
      }
    }
    if (!out && !ko) {
      if (b.state === 'active' && !b.onGround && b.airT > 0.15) b.state = 'airborne';
      else if (b.state === 'airborne' && b.onGround) b.state = 'active';
    }

    // --- combat ---
    if (!out && !ko && !b.heldBy) {
      b.punchL = Math.max(0, b.punchL - dt);
      b.punchR = Math.max(0, b.punchR - dt);
      b.kickT = Math.max(0, b.kickT - dt);
      // a tap of a grab button = punch (fires on the press)
      if (inp.grabLeft && !prev.grabLeft && b.punchL <= 0) {
        b.punchL = 0.3;
        strike(b, 1.15, 3.0, 2.0, 0.55);
      }
      if (inp.grabRight && !prev.grabRight && b.punchR <= 0) {
        b.punchR = 0.3;
        strike(b, 1.15, 3.0, 2.0, 0.55);
      }
      if (inp.kick && !prev.kick && b.kickT <= 0) {
        b.kickT = 0.4;
        strike(b, 1.35, 4.6, 1.6, 0.4);
      }
      if (inp.duck && !prev.duck) {
        // headbutt when an enemy is right in front
        const t = victim(b, 0.85, 0.4);
        if (t) strike(b, 0.85, 1.6, 1.0, 0.85);
      }
      // grabbing: holding a grab button near a beast for a moment latches on
      b.holdTimeL = inp.grabLeft ? b.holdTimeL + dt : 0;
      b.holdTimeR = inp.grabRight ? b.holdTimeR + dt : 0;
      for (const side of ['left', 'right'] as const) {
        const held = side === 'left' ? inp.grabLeft : inp.grabRight;
        const tHeld = side === 'left' ? b.holdTimeL : b.holdTimeR;
        const cur = byId(b.holding[side]);
        if (!held) {
          if (cur && side === 'right' && b.holding.left !== cur.id) cur.heldBy = null;
          if (cur && side === 'left' && b.holding.right !== cur.id) cur.heldBy = null;
          b.holding[side] = null;
          continue;
        }
        if (!cur && tHeld > 0.3) {
          const t = victim(b, 0.95, 0.2);
          if (t && t.heldBy === null) {
            b.holding[side] = t.id;
            t.heldBy = b;
            for (const l of listeners) l.onGrab?.(b, t);
          }
        }
      }
      // throw: release lift while holding with both hands
      const both = b.holding.left !== null && b.holding.left === b.holding.right ? byId(b.holding.left) : null;
      if (both && prev.lift && !inp.lift) {
        both.heldBy = null;
        b.holding = { left: null, right: null };
        both.velocity.set(Math.sin(b.facing) * 7.5, 4.2, Math.cos(b.facing) * 7.5);
        both.thrownT = 0.8;
        both.onGround = false;
        emitHit(both, b, 0.3, both.position);
      }
    }
    if (ko || out) {
      for (const side of ['left', 'right'] as const) {
        const cur = byId(b.holding[side]);
        if (cur) cur.heldBy = null;
        b.holding[side] = null;
      }
    }
    Object.assign(b.prev, inp);
  }

  function poseBeast(b: FallbackBeast, dt: number, t: number): void {
    const p = b.pose;
    p.reset();
    const inp = b.prev;
    const speed = Math.hypot(b.velocity.x, b.velocity.z);
    b.walkPhase += dt * (2 + speed * 3.2) * (b.onGround ? 1 : 0.3);
    const ko = b.state === 'knockedOut' || b.state === 'eliminated';
    // body orientation: facing + lean with speed + jelly wobble
    _e.set(Math.min(0.35, speed * 0.06) + Math.sin(t * 17) * b.wobble * 0.12, b.facing, Math.sin(t * 13 + b.id) * b.wobble * 0.15, 'YXZ');
    p.quaternion.setFromEuler(_e);
    p.position.copy(b.feet);
    if (ko) {
      _q.setFromAxisAngle(_v.set(1, 0, 0), -1.42);
      p.quaternion.setFromAxisAngle(Y, b.facing).multiply(_q);
      p.position.y += 0.22;
      p.set('head', 0.3, 0, 0.4);
      p.set('upperArmL', 0, 0, 1.3);
      p.set('upperArmR', 0, 0, -1.3);
      p.set('upperLegL', -0.2, 0, 0.3);
      p.set('upperLegR', -0.1, 0, -0.3);
    } else {
      const amp = Math.min(1, speed / 3) * (b.onGround ? 1 : 0.4);
      const s = Math.sin(b.walkPhase);
      p.set('upperLegL', s * 0.75 * amp);
      p.set('upperLegR', -s * 0.75 * amp);
      p.set('lowerLegL', Math.max(0, s) * 0.9 * amp);
      p.set('lowerLegR', Math.max(0, -s) * 0.9 * amp);
      p.set('upperArmL', -s * 0.5 * amp, 0, 0.15);
      p.set('upperArmR', s * 0.5 * amp, 0, -0.15);
      p.set('lowerArmL', -0.3);
      p.set('lowerArmR', -0.3);
      p.set('chest', Math.sin(t * 2.4 + b.id) * 0.03, s * 0.12 * amp, 0);
      p.set('head', 0, Math.sin(t * 0.8 + b.id) * 0.15, Math.sin(t * 9) * b.wobble * 0.3);
      if (!b.onGround) {
        p.set('upperArmL', -0.4, 0, 1.4 + Math.sin(t * 14) * 0.4);
        p.set('upperArmR', -0.4, 0, -1.4 - Math.sin(t * 14) * 0.4);
        p.set('upperLegL', -0.5);
        p.set('lowerLegL', 0.9);
      }
      if (inp.duck) {
        p.position.y -= 0.18;
        p.set('pelvis', 0.15);
        p.set('chest', 0.55);
        p.set('upperLegL', -1.0, 0, 0.1);
        p.set('upperLegR', -1.0, 0, -0.1);
        p.set('lowerLegL', 1.6);
        p.set('lowerLegR', 1.6);
      }
      if (inp.grabLeft) p.set('upperArmL', -1.5 - (b.punchL > 0.15 ? 0.1 : 0), 0, 0.05).set('lowerArmL', 0);
      if (inp.grabRight) p.set('upperArmR', -1.5, 0, -0.05).set('lowerArmR', 0);
      if (inp.lift && (b.holding.left !== null || b.holding.right !== null)) {
        p.set('upperArmL', -3.0, 0, 0.1).set('upperArmR', -3.0, 0, -0.1);
      }
      if (b.punchL > 0) p.set('chest', 0, -0.35 * Math.sin((b.punchL / 0.3) * Math.PI), 0);
      if (b.punchR > 0) p.set('chest', 0, 0.35 * Math.sin((b.punchR / 0.3) * Math.PI), 0);
      if (b.kickT > 0) {
        const k = Math.sin((b.kickT / 0.4) * Math.PI);
        p.set('upperLegR', -1.5 * k).set('lowerLegR', 0.2 * k);
      }
    }
    p.solve();
    p.apply(b.visual.parts);
    p.partWorld('chest', b.position);
    // expression
    const v = b.visual;
    if (ko) v.setExpression('ko');
    else if (b.hurtT > 0) v.setExpression('hurt');
    else if (b.airT > 0.6 || b.heldBy) v.setExpression('scared');
    else if (inp.grabLeft || inp.grabRight || inp.kick) v.setExpression('angry');
    else v.setExpression('neutral');
    v.update(dt);
  }

  let time = 0;
  const system: BeastSystem = {
    get beasts() {
      return beasts;
    },
    spawn(o, at, facing) {
      const visual = makeVisual({ colour: o.colour, costume: o.costume, scale: o.scale });
      const b = new FallbackBeast(nextId++, { ...o }, visual, at, facing);
      engine.scene.add(visual.root);
      beasts.push(b);
      b.teleport(at, facing);
      poseBeast(b, 0, 0);
      return b;
    },
    remove(b) {
      const i = beasts.indexOf(b as FallbackBeast);
      if (i < 0) return;
      const fb = beasts[i];
      for (const o of beasts) {
        if (o.heldBy === fb) o.heldBy = null;
        if (o.holding.left === fb.id) o.holding.left = null;
        if (o.holding.right === fb.id) o.holding.right = null;
      }
      beasts.splice(i, 1);
      fb.visual.dispose();
      fb.root.removeFromParent();
    },
    update(dt) {
      dt = Math.min(dt, 1 / 30);
      time += dt;
      for (const b of beasts) stepBeast(b, dt);
      // keep bodies apart (simple capsule push)
      for (let i = 0; i < beasts.length; i++) {
        for (let j = i + 1; j < beasts.length; j++) {
          const a = beasts[i];
          const c = beasts[j];
          if (a.heldBy === c || c.heldBy === a) continue;
          const dx = c.feet.x - a.feet.x;
          const dz = c.feet.z - a.feet.z;
          const d = Math.hypot(dx, dz);
          if (d >= 0.55 || Math.abs(c.feet.y - a.feet.y) > 1.2 || d < 1e-4) continue;
          const push = (0.55 - d) * 0.5;
          a.feet.x -= (dx / d) * push;
          a.feet.z -= (dz / d) * push;
          c.feet.x += (dx / d) * push;
          c.feet.z += (dz / d) * push;
        }
      }
      for (const b of beasts) poseBeast(b, dt, time);
    },
    on(events) {
      listeners.add(events);
      return () => listeners.delete(events);
    },
    dispose() {
      for (const b of [...beasts]) system.remove(b);
      listeners.clear();
    },
  };
  return system;
}
