// Bot brain (bots module): Gang-Beasts-like opponents.
//
// Two layers:
//  - think(): runs every `profile.think` seconds (the reaction delay) and picks a plan: recover from
//    KO, catch / climb a ledge, dodge a hazard, shelter from a bridge, struggle when held, carry +
//    throw a victim, fight a target (jab combos, grab + punch, kick / headbutt / drop kick near a
//    drop), stomp a beast hanging on the ledge, flee from a drop, or idle silliness (taunts, cheese
//    throwing, wobbling about).
//  - act(): every frame, turns the plan into a BeastInput (movement steering with obstacle whiskers
//    on the arena grid, edge safety filter, button taps / holds with proper Gang Beasts timings).
// No allocations in update(); all scratch vectors are fields.
import * as THREE from 'three';
import type { Arena, Beast, BeastInput, BeastSystem, BotController, BotDifficulty } from '../../brawl/contracts';
import type { PhysicsWorld } from '../../contracts';
import { BOT_PROFILES, type BotProfile } from './profiles';
import { ArenaSense, DROP, FLOOR, HIGH, OUT, getSense, type BodyLike } from './sense';

/** The extra (optional) members of the real beast (src/beast/physics BeastImpl). */
interface BeastX extends Beast {
  readonly mode?: string;
  readonly strength?: number;
  readonly health?: number;
  readonly stamina?: number;
  readonly koTime?: number;
  readonly heldBy?: readonly number[];
  readonly heldBeast?: Beast | null;
  readonly isLifting?: boolean;
  readonly isAttacking?: boolean;
  readonly grounded?: boolean;
  readonly groundY?: number;
  heldBodyOf?(side: 'left' | 'right'): BodyLike | null;
}

export type BotPlan =
  | 'idle'
  | 'fight'
  | 'grab'
  | 'carry'
  | 'stomp'
  | 'flee'
  | 'dodge'
  | 'shelter'
  | 'prop'
  | 'taunt'
  | 'wobble'
  | 'wander'
  | 'recover'
  | 'getup'
  | 'climb'
  | 'save'
  | 'swim'
  | 'struggle'
  | 'cheer'
  | 'vault'
  | 'lurk'
  | 'evade'
  | 'out';

type Pattern = 'jab' | 'grabPunch' | 'kick' | 'headbutt' | 'dropkick';

export interface BotStats {
  punches: number;
  kicks: number;
  headbutts: number;
  dropkicks: number;
  grabs: number;
  throws: number;
  propThrows: number;
  hitsDealt: number;
  kosDealt: number;
  climbs: number;
  dodges: number;
  shelters: number;
  taunts: number;
  stuck: number;
  /** unstick events per plan (debug) */
  stuckBy: Record<string, number>;
  /** seconds per plan */
  planTime: Partial<Record<BotPlan, number>>;
}

const TAU = Math.PI * 2;
const wrapPi = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const rnd = Math.random;

function modeOf(b: BeastX): string {
  if (typeof b.mode === 'string') return b.mode;
  switch (b.state) {
    case 'knockedOut':
      return 'ko';
    case 'airborne':
      return 'fall';
    case 'swimming':
      return 'swim';
    case 'eliminated':
      return 'out';
    default:
      return 'stand';
  }
}

/** Shared per BeastSystem: how many bots currently target each beast id (anti dog-pile). */
const boards = new WeakMap<object, Map<number, number>>();

export interface BotContext {
  system: BeastSystem;
  arena: Arena;
  difficulty: BotDifficulty;
  physics: PhysicsWorld;
}

export class BotBrain implements BotController {
  readonly beast: Beast;
  readonly difficulty: BotDifficulty;
  readonly profile: BotProfile;
  readonly stats: BotStats = {
    punches: 0,
    kicks: 0,
    headbutts: 0,
    dropkicks: 0,
    grabs: 0,
    throws: 0,
    propThrows: 0,
    hitsDealt: 0,
    kosDealt: 0,
    climbs: 0,
    dodges: 0,
    shelters: 0,
    taunts: 0,
    stuck: 0,
    stuckBy: {},
    planTime: {},
  };
  plan: BotPlan = 'idle';
  /** perf: smoothed ms per update, and the worst single update */
  ms = 0;
  msMax = 0;

  private readonly b: BeastX;
  private readonly system: BeastSystem;
  private readonly arena: Arena;
  private readonly sense: ArenaSense;
  private readonly board: Map<number, number>;
  private readonly input: BeastInput = { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false, run: false };
  private readonly unsub: () => void;
  private disposed = false;

  // clock / thinking
  private t = 0;
  private thinkAt = 0;
  private planT = 0;
  private planUntil = 0;
  private lastMode = '';
  private modeT = 0;

  // target
  private target: BeastX | null = null;
  private targetSince = 0;
  private readonly aimOff = new THREE.Vector3();
  private lastAttacker: Beast | null = null;
  private lastHitT = -99;

  // attack state
  private pattern: Pattern = 'jab';
  private range = 1.2;
  private nextHitAt = 0;
  private comboLeft = 0;
  private pauseUntil = 0;
  private side = 0; // 0 = left hand next
  private strafe = 1;
  private patternT = 0;
  private dropkickAt = -1;

  // buttons
  private tapL = 0;
  private tapR = 0;
  private tapKick = 0;
  private tapDuck = 0;
  private tapJump = 0;
  private holdL = false;
  private holdR = false;
  private holdLift = false;
  private holdDuck = false;
  private holdJump = false;
  private nextJumpOk = 0;

  // movement
  private readonly mv = new THREE.Vector3();
  private moveMag = 0;
  private run = false;
  private safetyFactor = 1;
  private steerSide = 1;
  private steerSideUntil = 0;
  private readonly margin: number;
  private readonly edgeCtlP: number;

  // carry / throw
  private carryT = 0;
  private stage = 0;
  private stageT = 0;
  private throwYaw = 0;
  private victim: Beast | null = null;
  private victimCheckAt = -1;
  // props
  private prop: BodyLike | null = null;
  private propReadAt = 0;
  private propTries = 0;
  private readonly propPos = new THREE.Vector3();
  // decisions that must not flip-flop between thinks
  private grabFor: Beast | null = null;
  private grabDecision = false;
  private fleeCool = 0;
  private edgeCtl = false;
  private readonly ctlDir = new THREE.Vector3();
  private evadeCool = 0;
  private lurkAround: Beast | null = null;
  private grabCool = 0;
  private openUntil = 0;
  // hazards / reflexes
  private hazardRolled = false;
  private hazardSeen = false;
  private readonly escape = new THREE.Vector3();
  private airRolled = false;
  private airSave = false;
  private climbOk = true;
  private climbLetGo = 0;
  private struggleRolled = false;
  private struggleOn = false;
  private shelterJit = 0;
  // stuck
  private readonly lastPos = new THREE.Vector3();
  private lastPosT = 0;
  private wantMoveT = 0;
  private detourUntil = 0;
  private readonly detour = new THREE.Vector3();

  // scratch
  private readonly me = new THREE.Vector3();
  private readonly tp = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private readonly mres = { d: 0, k: 0 };

  constructor(beast: Beast, ctx: BotContext) {
    this.beast = beast;
    this.b = beast as BeastX;
    this.difficulty = BOT_PROFILES[ctx.difficulty] ? ctx.difficulty : 'normaal';
    this.profile = BOT_PROFILES[this.difficulty];
    this.system = ctx.system;
    this.arena = ctx.arena;
    this.sense = getSense(ctx.arena, ctx.physics);
    let board = boards.get(ctx.system);
    if (!board) {
      board = new Map();
      boards.set(ctx.system, board);
    }
    this.board = board;
    // narrow arenas (boat roof, mill stage): a bit more caution and more fighting from the inward side
    const narrow = this.sense.marginScale < 0.6;
    this.margin = this.profile.edgeMargin * (narrow ? 1.3 : 1) * this.sense.marginScale + this.sense.marginOffset;
    this.edgeCtlP = narrow && this.profile.edgeControl > 0 ? Math.max(this.profile.edgeControl, 0.65) : this.profile.edgeControl;
    this.thinkAt = rnd() * this.profile.think;
    this.strafe = rnd() < 0.5 ? 1 : -1;
    // a short wobbly warm-up before the first punches (sizing each other up)
    this.openUntil = 0.4 + rnd() * (this.difficulty === 'makkelijk' ? 2.6 : this.difficulty === 'normaal' ? 1.8 : 0.9);
    this.lastPos.copy(beast.position);
    this.unsub = ctx.system.on({
      onHit: (target, attacker) => {
        if (target === this.beast && attacker && attacker !== this.beast) {
          this.lastAttacker = attacker;
          this.lastHitT = this.t;
        } else if (attacker === this.beast && target !== this.beast) this.stats.hitsDealt++;
      },
      onKnockout: (target) => {
        if (target !== this.beast && this.target === target) this.stats.kosDealt++;
      },
    });
  }

  /** Name of the current target (debug). */
  get targetName(): string | null {
    return this.target ? this.target.options.name : null;
  }

  // =================================================================================== update
  update(dt: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const b = this.b;
    if (!(dt > 0)) dt = 1 / 60;
    if (dt > 0.1) dt = 0.1;
    this.t += dt;
    if (b.state === 'eliminated') {
      if (this.plan !== 'out') {
        this.setTarget(null);
        this.setPlan('out', 1e9);
        this.release();
        this.neutral();
        b.setInput(this.input);
      }
      return;
    }
    this.sense.tick();
    this.me.copy(b.position);
    const mode = modeOf(b);
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      this.modeT = 0;
      // reflexes: KO / hanging / falling get an (almost) immediate re-think
      const fast = mode === 'ko' || mode === 'climb' || mode === 'fall' || mode === 'getup';
      this.thinkAt = Math.min(this.thinkAt, this.t + (fast ? 0.04 : this.profile.react * 0.6));
      if (mode !== 'jump' && mode !== 'fall') this.airRolled = false;
      if (mode !== 'climb') this.climbLetGo = 0;
    } else this.modeT += dt;
    this.planT += dt;
    const pt = this.stats.planTime;
    pt[this.plan] = (pt[this.plan] ?? 0) + dt;

    if (this.t >= this.thinkAt) {
      this.thinkAt = this.t + this.profile.think * (0.7 + rnd() * 0.6);
      this.think(mode);
    }
    this.act(dt, mode);
    b.setInput(this.input);
    const ms = performance.now() - t0;
    this.ms += (ms - this.ms) * 0.05;
    if (ms > this.msMax) this.msMax = ms;
  }

  dispose(): void {
    if (this.disposed) return;
    this.setTarget(null);
    this.unsub();
    this.release();
    this.neutral();
    this.b.setInput(this.input);
    this.disposed = true;
  }

  // =================================================================================== think
  private setPlan(p: BotPlan, dur = 0): void {
    if (p !== this.plan) {
      this.plan = p;
      this.planT = 0;
      this.stage = 0;
      this.stageT = 0;
    }
    if (dur > 0) this.planUntil = this.t + dur;
  }

  private planActive(): boolean {
    return this.t < this.planUntil;
  }

  private think(mode: string): void {
    const b = this.b;
    const P = this.profile;
    const S = this.sense;
    this.checkStuck();
    this.checkVictim();

    // ------------------------------------------------ body states first
    if (mode === 'ko') return this.setPlan('recover');
    if (mode === 'out') return this.setPlan('out');
    if (mode === 'swim') return this.setPlan('swim');
    if (mode === 'climb') {
      if (this.plan !== 'climb') {
        this.climbOk = rnd() < P.climbSkill;
        this.climbLetGo = this.climbOk ? 0 : this.t + 1.5 + rnd() * 2.5;
        if (this.climbOk) this.stats.climbs++;
      }
      return this.setPlan('climb');
    }
    if (mode === 'jump' || mode === 'fall') {
      const below = this.me.y < S.floorY + 0.35;
      const k = S.cellAt(this.me.x, this.me.z);
      const overDrop = k === DROP || k === OUT || this.arena.edgeDistance(this.me) < 0.4 || this.arena.isOut(this.me);
      if ((below && overDrop) || (overDrop && (b.velocity.y < -1 || this.plan === 'save'))) {
        if (!this.airRolled) {
          this.airRolled = true;
          this.airSave = rnd() < P.climbSkill;
        }
        if (this.airSave) return this.setPlan('save');
      }
      if (this.plan === 'carry' || this.plan === 'fight' || this.plan === 'dodge' || this.plan === 'shelter') return; // keep going
    }
    if (mode === 'getup') {
      if (this.plan !== 'getup') this.release();
      return this.setPlan('getup');
    }

    // ------------------------------------------------ hazards
    const ht = S.hazardTime(this.me, this.escape);
    if (ht < P.hazardLook) {
      if (!this.hazardRolled) {
        this.hazardRolled = true;
        this.hazardSeen = rnd() < P.hazardSkill;
        if (this.hazardSeen) this.stats.dodges++;
      }
      if (this.hazardSeen) {
        if (this.plan !== 'dodge') this.thinkAt = this.t + Math.max(0.08, P.think * 0.5);
        return this.setPlan('dodge', 0.6);
      }
    } else if (ht > P.hazardLook + 0.6) this.hazardRolled = false;
    if (this.plan === 'dodge' && this.planActive()) return;

    // rondvaartboot: a low bridge coming -> run to the low rear deck and duck in time
    if (S.boatFrame) {
      const tb = S.bridgeTime(this.me);
      const need = this.shelterNeed();
      const spare = this.difficulty === 'makkelijk' ? 0.5 : this.difficulty === 'normaal' ? 2.2 : 1.6;
      // (once sheltering, stay until the bridge has passed: no flip-flopping as 'need' shrinks)
      if (tb < need + spare || (this.plan === 'shelter' && tb < need + spare + 4)) {
        if (this.plan !== 'shelter') {
          if (!this.hazardRolled) {
            this.hazardRolled = true;
            this.hazardSeen = rnd() < Math.min(1, P.hazardSkill + 0.1);
          }
          if (this.hazardSeen) {
            this.stats.shelters++;
            this.shelterJit = rnd() * 2 - 1;
            this.setPlan('shelter');
            return;
          }
        } else return;
      } else if (this.plan === 'shelter') {
        this.hazardRolled = false;
        this.setPlan('idle');
      }
    }

    // ------------------------------------------------ grabbed by an enemy?
    const heldBy = b.heldBy;
    const holdingBeast = this.heldVictim();
    if (heldBy && heldBy.length > 0 && !holdingBeast) {
      if (!this.struggleRolled) {
        this.struggleRolled = true;
        this.struggleOn = rnd() < P.struggle;
      }
      if (this.struggleOn) return this.setPlan('struggle');
    } else this.struggleRolled = false;

    // ------------------------------------------------ carrying a victim / prop
    if (holdingBeast && this.t >= this.grabCool) {
      if (this.plan !== 'carry') {
        this.carryT = 0;
        this.stats.grabs++;
      }
      this.target = holdingBeast as BeastX;
      return this.setPlan('carry');
    }
    if (this.plan === 'carry' && this.stage >= 3 && this.planT < 0.6) return; // let the throw finish
    if (this.plan === 'prop' && this.planActive()) return;
    if (this.plan === 'cheer' && this.planActive()) return;
    if ((this.plan === 'taunt' || this.plan === 'wobble') && this.planActive() && !this.threatNear(2.2)) return;
    if (this.plan === 'flee' && this.planActive()) return;

    // ------------------------------------------------ outside the fighting area (behind the crowd barrier):
    // walk back and vault over (jump + grab the top -> climb)
    if (this.outsideArea(this.me) && this.b.grounded !== false) {
      return this.setPlan('vault', 0.5);
    }
    if (this.plan === 'evade' && this.planActive()) return;
    if (this.plan === 'lurk' && this.planActive() && !this.threatNear(1.2)) return;
    // side-step an incoming attack (moeilijk often, normaal sometimes)
    if (P.evade > 0 && this.t > this.evadeCool) {
      const att = this.incomingAttack();
      if (att) {
        this.evadeCool = this.t + 1.2;
        if (rnd() < P.evade) {
          const dx = this.me.x - att.position.x, dz = this.me.z - att.position.z;
          const sg = rnd() < 0.5 ? 1 : -1;
          this.escape.set(dz * sg + dx * 0.4, 0, -dx * sg + dz * 0.4).normalize();
          return this.setPlan('evade', 0.3 + rnd() * 0.15);
        }
      }
    }

    // ------------------------------------------------ edge danger while attacked
    const e0 = this.arena.edgeDistance(this.me);
    if (e0 < this.margin * 1.7 && this.t > this.fleeCool && (this.t - this.lastHitT < 1.2 || this.threatNear(1.4))) {
      this.fleeCool = this.t + 1.6 + rnd();
      if (rnd() < P.edgeCaution) return this.setPlan('flee', 0.5 + rnd() * 0.5);
    }

    // ------------------------------------------------ warm-up
    if (this.t < this.openUntil) {
      if (this.plan !== 'taunt' && this.plan !== 'wander') this.setPlan(rnd() < 0.4 ? 'taunt' : 'wander', this.openUntil - this.t);
      return;
    }
    // ------------------------------------------------ choose a target
    const tgt = this.chooseTarget();
    this.setTarget(tgt);
    if (!tgt) {
      if (rnd() < P.silly * 2) return this.startSilly();
      return this.setPlan('wander', 1.5 + rnd() * 2);
    }
    // occasional silliness when nobody is close
    const d = this.horizDist(tgt.position);
    if (d > 4 && rnd() < P.silly * 0.4 && this.plan !== 'fight') return this.startSilly();
    const tm = modeOf(tgt);
    if (tm === 'climb') return this.setPlan('stomp');
    const vulnerable = tm === 'ko' || (tgt.strength ?? 1) < 0.3;
    if (!vulnerable) this.grabFor = null;
    else if (this.grabFor !== tgt) {
      this.grabFor = tgt;
      this.grabDecision = rnd() < P.grabUse;
    }
    if (vulnerable && this.grabDecision && this.t >= this.grabCool) {
      // somebody else already carries it: punch the carrier instead
      if (tgt.heldBy && tgt.heldBy.length > 0) {
        const carrier = this.beastById(tgt.heldBy[0]);
        if (carrier && carrier !== this.beast) this.setTarget(carrier);
        return this.setPlan('fight');
      }
      return this.setPlan('grab');
    }
    // hang back from a pile-up and pick off the survivors (moeilijk)
    if (tm !== 'ko' && this.plan !== 'fight' && P.pileAvoid > 0 && this.pileAround(tgt, 2.5) >= 2 && rnd() < P.pileAvoid) {
      this.lurkAround = tgt;
      return this.setPlan('lurk', 1.2 + rnd() * 1.2);
    }
    // choose an attack pattern on (re)engaging, or after the current one finished
    if (this.plan !== 'fight' || this.patternT > 3.5 || this.patternDone()) {
      if (!(this.pattern === 'grabPunch' && this.plan === 'fight' && this.patternT < 2.6)) this.pickPattern(tgt, d);
    }
    this.setPlan('fight');
    // aim error re-rolled on each think
    const err = Math.min(1, P.aimError * d);
    this.aimOff.set((rnd() * 2 - 1) * err, 0, (rnd() * 2 - 1) * err);
    // edge control: come in from the inward side so the target ends up between me and the drop
    this.edgeCtl = false;
    if (this.edgeCtlP > 0 && this.arena.edgeDistance(tgt.position) < 5 && rnd() < this.edgeCtlP) {
      this.inward(tgt.position, this.n);
      this.edgeCtl = true;
      this.ctlDir.copy(this.n);
    }
  }

  /** Dev/test hook: start a silly behaviour now ('prop' | 'taunt' | 'wobble'). */
  forceSilly(kind: 'prop' | 'taunt' | 'wobble'): void {
    this.startSilly(kind === 'prop' ? 0 : kind === 'taunt' ? 0.5 : 0.9);
    this.thinkAt = this.t + 3;
  }

  /** Debug info for dev scenes. */
  get debugInfo(): string {
    const h = this.b.holding;
    return `${this.plan}:${this.stage} ${this.pattern} L${this.holdL ? 1 : 0}R${this.holdR ? 1 : 0} lift${this.holdLift ? 1 : 0} duck${this.holdDuck ? 1 : 0} hold ${h.left}/${h.right}`;
  }

  private startSilly(r = rnd()): void {
    this.holdL = this.holdR = this.holdLift = false;
    this.propTries = 0;
    const S = this.sense;
    if (r < 0.4 && S.props.length > 0) {
      // nearest prop within 9 m
      let best: BodyLike | null = null;
      let bd = 81;
      for (const p of S.props) {
        const tr = p.translation();
        const dx = tr.x - this.me.x, dz = tr.z - this.me.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd && Math.abs(tr.y - S.floorY) < 1.2) {
          bd = d2;
          best = p;
        }
      }
      if (best) {
        this.prop = best;
        this.propReadAt = 0;
        this.setPlan('prop', 7);
        return;
      }
    }
    this.stats.taunts++;
    if (r < 0.75) this.setPlan('taunt', 1.2 + rnd() * 1.2);
    else this.setPlan('wobble', 1.0 + rnd() * 1.0);
  }

  private pickPattern(tgt: BeastX, d: number): void {
    const P = this.profile;
    let wJ = P.wJab, wG = this.t < this.grabCool ? 0 : P.wGrabPunch, wK = P.wKick, wH = P.wHeadbutt, wD = P.wDropKick;
    // near a drop with the drop behind the target: heavy knockback moves
    if (this.pushesOff(tgt)) {
      wK *= 3;
      wH *= 2;
      wD *= 3;
      wJ *= 0.6;
    }
    if (d < 1.6) wD = 0;
    if (modeOf(tgt) === 'jump' || modeOf(tgt) === 'fall') wG *= 0.3;
    const sum = wJ + wG + wK + wH + wD;
    let r = rnd() * sum;
    this.pattern = (r -= wJ) < 0 ? 'jab' : (r -= wG) < 0 ? 'grabPunch' : (r -= wK) < 0 ? 'kick' : (r -= wH) < 0 ? 'headbutt' : 'dropkick';
    this.patternT = 0;
    this.comboLeft = P.comboMin + Math.floor(rnd() * (P.comboMax - P.comboMin + 1));
    this.range = P.rangeBase + rnd() * P.rangeSloppiness;
    this.dropkickAt = -1;
    if (this.pattern !== 'grabPunch') this.holdL = this.holdR = false;
  }

  private patternDone(): boolean {
    return this.pattern === 'jab' ? this.comboLeft <= 0 && this.t > this.pauseUntil : this.pattern !== 'grabPunch' && this.patternT > 1.4;
  }

  /** Target beast is between me and a drop (a kick could send it off). */
  private pushesOff(tgt: Beast): boolean {
    const e = this.arena.edgeDistance(tgt.position);
    if (!(e < 1.8)) return false;
    this.inward(tgt.position, this.n);
    const dx = tgt.position.x - this.me.x, dz = tgt.position.z - this.me.z;
    const l = Math.hypot(dx, dz) || 1;
    return -(dx * this.n.x + dz * this.n.z) / l > 0.45;
  }

  private chooseTarget(): BeastX | null {
    const P = this.profile;
    let best: BeastX | null = null;
    let bs = Infinity;
    for (const o of this.system.beasts) {
      const ob = o as BeastX;
      if (ob === this.b || ob.state === 'eliminated' || ob.state === 'swimming') continue;
      if (this.arena.isOut(ob.position) || this.outsideArea(ob.position)) continue;
      const d = this.horizDist(ob.position) + Math.abs(ob.position.y - this.me.y) * 1.5;
      if (d > 30) continue;
      let s = d;
      const human = ob.options.isBot === false;
      const om = modeOf(ob);
      if (om === 'ko') s -= P.koBonus;
      else if (om === 'climb') s -= P.edgeOpportunism + 1;
      s -= (1 - (ob.health ?? 100) / 100) * P.weakBonus;
      if (human) s -= P.humanBias;
      let piled = this.board.get(ob.id) ?? 0;
      if (this.target === ob) piled--;
      if (piled > 0) s += piled * P.pilePenalty;
      if (human && piled >= P.humanCap) s += 8;
      if (ob === this.target) s -= 1.2;
      if (ob === this.lastAttacker && this.t - this.lastHitT < 4) s -= 1.5;
      const e = this.arena.edgeDistance(ob.position);
      if (e < 2) s -= P.edgeOpportunism * (1 - e / 2);
      s += rnd() * 1.2;
      if (s < bs) {
        bs = s;
        best = ob;
      }
    }
    return best;
  }

  private setTarget(t: BeastX | null): void {
    if (t === this.target) return;
    if (this.target) {
      const c = (this.board.get(this.target.id) ?? 1) - 1;
      if (c <= 0) this.board.delete(this.target.id);
      else this.board.set(this.target.id, c);
    }
    this.target = t;
    this.targetSince = this.t;
    if (t) this.board.set(t.id, (this.board.get(t.id) ?? 0) + 1);
  }

  private beastById(id: number): BeastX | null {
    for (const o of this.system.beasts) if (o.id === id) return o as BeastX;
    return null;
  }

  /** The beast held in my hands (if any). */
  private heldVictim(): BeastX | null {
    const h = this.b.heldBeast;
    if (h) return h as BeastX;
    const l = this.b.holding.left, r = this.b.holding.right;
    const id = l !== null && l >= 0 ? l : r !== null && r >= 0 ? r : -1;
    return id >= 0 ? this.beastById(id) : null;
  }

  /** An awake enemy within 1.6 m that is punching / kicking and facing me. */
  private incomingAttack(): BeastX | null {
    for (const o of this.system.beasts) {
      const ob = o as BeastX;
      if (ob === this.b || ob.state === 'eliminated' || !ob.isAttacking) continue;
      const dx = this.me.x - ob.position.x, dz = this.me.z - ob.position.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.6 || d < 0.05) continue;
      if ((dx * Math.sin(ob.facing) + dz * Math.cos(ob.facing)) / d > 0.6) return ob;
    }
    return null;
  }

  /** p is off the fighting area on solid ground (behind the crowd barrier), not over a drop. */
  private outsideArea(p: THREE.Vector3): boolean {
    this.arena.clampToArea(p, this.v2);
    if (Math.hypot(this.v2.x - p.x, this.v2.z - p.z) <= 1.0) return false;
    return this.arena.edgeDistance(p) > 2 && Math.abs(this.v2.y - p.y) < 2;
  }

  /** Awake beasts (other than me and t) within r of t. */
  private pileAround(t: Beast, r: number): number {
    let n = 0;
    for (const o of this.system.beasts) {
      if (o === this.beast || o === t || o.state === 'eliminated' || o.state === 'knockedOut') continue;
      if (Math.hypot(o.position.x - t.position.x, o.position.z - t.position.z) < r) n++;
    }
    return n;
  }

  private threatNear(r: number): boolean {
    for (const o of this.system.beasts) {
      if (o === this.beast || o.state === 'eliminated' || o.state === 'knockedOut') continue;
      if (this.horizDist(o.position) < r) return true;
    }
    return false;
  }

  private checkVictim(): void {
    if (!this.victim || this.t < this.victimCheckAt) return;
    const v = this.victim;
    this.victim = null;
    if (v.state === 'eliminated' || this.arena.isOut(v.position) || v.position.y < this.sense.floorY - 1.2) {
      if (!this.threatNear(2.5) && modeOf(this.b) !== 'ko') {
        this.stats.taunts++;
        this.setPlan('cheer', 1.3 + rnd() * 0.8);
      }
    }
  }

  private checkStuck(): void {
    if (this.t - this.lastPosT < 1.6) return;
    const moved = Math.hypot(this.me.x - this.lastPos.x, this.me.z - this.lastPos.z);
    const wanted = this.wantMoveT / (this.t - this.lastPosT);
    this.lastPos.copy(this.me);
    this.lastPosT = this.t;
    this.wantMoveT = 0;
    if (wanted > 0.7 && moved < 0.3 && this.t > this.detourUntil && modeOf(this.b) !== 'ko' && this.plan !== 'vault' && this.plan !== 'lurk') {
      this.stats.stuck++;
      const key = this.plan === 'fight' ? 'fight:' + this.pattern : this.plan;
      this.stats.stuckBy[key] = (this.stats.stuckBy[key] ?? 0) + 1;
      const a = Math.atan2(this.mv.x, this.mv.z) + (rnd() < 0.5 ? 1 : -1) * (Math.PI / 2 + rnd() * 0.6);
      this.detour.set(Math.sin(a), 0, Math.cos(a));
      this.detourUntil = this.t + 0.7 + rnd() * 0.5;
      if (this.t > this.nextJumpOk && this.jumpSafe(this.detour.x, this.detour.z, 1.2)) {
        this.tapJump = this.t + 0.08;
        this.nextJumpOk = this.t + 1;
      }
    }
  }

  // =================================================================================== act
  private neutral(): void {
    const i = this.input;
    i.moveX = i.moveZ = 0;
    i.jump = i.duck = i.lift = i.kick = i.grabLeft = i.grabRight = false;
    i.run = false;
  }

  private release(): void {
    this.holdL = this.holdR = this.holdLift = this.holdDuck = this.holdJump = false;
    this.tapL = this.tapR = this.tapKick = this.tapDuck = this.tapJump = 0;
  }

  private moveTo(p: THREE.Vector3, mag: number, stopAt = 0.2): number {
    const dx = p.x - this.me.x, dz = p.z - this.me.z;
    const d = Math.hypot(dx, dz);
    if (d < stopAt) {
      this.moveMag = 0;
      return d;
    }
    this.mv.set(dx / d, 0, dz / d);
    this.moveMag = mag;
    return d;
  }

  private moveDir(x: number, z: number, mag: number): void {
    const l = Math.hypot(x, z);
    if (l < 1e-6) {
      this.moveMag = 0;
      return;
    }
    this.mv.set(x / l, 0, z / l);
    this.moveMag = mag;
  }

  private act(dt: number, mode: string): void {
    const P = this.profile;
    this.moveMag = 0;
    this.run = false;
    this.safetyFactor = 1;
    let steer = true;
    // default: no holds unless the plan keeps them
    const keepHolds = this.plan === 'carry' || this.plan === 'climb' || this.plan === 'save' || this.plan === 'grab' || this.plan === 'prop' ||
      (this.plan === 'fight' && this.pattern === 'grabPunch') || this.plan === 'struggle' || this.plan === 'dodge';
    if (!keepHolds) this.holdL = this.holdR = false;
    if (this.plan !== 'carry' && this.plan !== 'prop' && this.plan !== 'taunt' && this.plan !== 'cheer') this.holdLift = false;
    if (this.plan !== 'shelter') this.holdDuck = false;
    if (this.plan !== 'climb') this.holdJump = false;

    switch (this.plan) {
      case 'recover': {
        // mash to wake up sooner
        this.release();
        if (rnd() < P.mash * dt) this.tapJump = this.t + 0.05;
        steer = false;
        break;
      }
      case 'getup':
      case 'swim': {
        this.safetyFactor = 1.4;
        this.arena.clampToArea(this.me, this.goal);
        if (this.horizDist(this.goal) > 0.3 || this.arena.edgeDistance(this.me) < this.margin * 1.4) this.moveTo(this.goal, 0.6);
        break;
      }
      case 'out':
        this.release();
        steer = false;
        break;
      case 'climb':
        this.actClimb();
        steer = false;
        break;
      case 'save': {
        // reach for the ledge, air-steer back towards the area
        this.holdL = this.holdR = true;
        this.arena.clampToArea(this.me, this.goal);
        this.moveTo(this.goal, 1, 0.05);
        steer = false;
        this.safetyFactor = 0;
        break;
      }
      case 'dodge': {
        this.moveDir(this.escape.x, this.escape.z, 1);
        this.run = true;
        if (!this.heldVictim()) this.holdL = this.holdR = false;
        this.safetyFactor = 1.2;
        break;
      }
      case 'shelter':
        this.actShelter();
        break;
      case 'struggle':
        this.actStruggle();
        break;
      case 'carry':
        this.actCarry(dt);
        break;
      case 'grab':
        this.actGrab();
        break;
      case 'fight':
        this.actFight(dt);
        break;
      case 'stomp':
        this.actStomp();
        break;
      case 'flee': {
        this.inward(this.me, this.n);
        let x = this.n.x, z = this.n.z;
        const a = this.lastAttacker;
        if (a && a.state !== 'eliminated') {
          const dx = this.me.x - a.position.x, dz = this.me.z - a.position.z;
          const l = Math.hypot(dx, dz) || 1;
          x += (dx / l) * 0.5;
          z += (dz / l) * 0.5;
        }
        this.moveDir(x, z, 1);
        this.run = true;
        break;
      }
      case 'prop':
        this.actProp(dt);
        break;
      case 'taunt':
      case 'cheer': {
        // arms up (empty-handed lift), pumping, the odd hop
        const ph = (this.planT * (this.plan === 'cheer' ? 2.4 : 1.7)) % 1;
        this.holdLift = ph < 0.6;
        if (this.plan === 'cheer' && ph > 0.8 && ph < 0.85 && this.t > this.nextJumpOk && this.jumpSafe(0, 0, 0)) {
          this.tapJump = this.t + 0.08;
          this.nextJumpOk = this.t + 1.2;
        }
        break;
      }
      case 'wobble': {
        // little circles with wavering speed (drunk-ish waddle)
        const a = this.planT * 3.2 * this.strafe;
        this.moveDir(Math.sin(a), Math.cos(a), 0.45 + 0.3 * Math.sin(this.planT * 7));
        this.safetyFactor = 1.6;
        break;
      }
      case 'vault': {
        // back over the barrier: run at it, jump and reach (the climb mode pulls us over)
        this.arena.clampToArea(this.me, this.goal);
        const d = this.moveTo(this.goal, 0.8, 0.05);
        this.safetyFactor = 0;
        steer = false;
        this.holdL = this.holdR = d < 2.4;
        if (d < 2.2 && this.b.grounded !== false && this.t > this.nextJumpOk) {
          this.tapJump = this.t + 0.12;
          this.nextJumpOk = this.t + 1.1;
        }
        break;
      }
      case 'evade':
        this.moveDir(this.escape.x, this.escape.z, 1);
        this.run = true;
        this.safetyFactor = 1.3;
        break;
      case 'lurk': {
        // circle the pile at ~3.5 m, facing it
        const c = this.lurkAround;
        if (!c || c.state === 'eliminated') {
          this.setPlan('idle');
          break;
        }
        const dx = this.me.x - c.position.x, dz = this.me.z - c.position.z;
        const d = Math.hypot(dx, dz) || 1;
        const k = (d - 3.5) * 0.8;
        this.moveDir(-dz / d * this.strafe * 0.6 - (dx / d) * k, (dx / d) * this.strafe * 0.6 - (dz / d) * k, 0.5);
        this.safetyFactor = 1.3;
        break;
      }
      case 'wander': {
        if (this.stage === 0 || this.horizDist(this.goal) < 0.8) {
          this.stage = 1;
          const S = this.sense;
          this.goal.set(S.centre.x + (rnd() * 2 - 1) * 6, S.centre.y, S.centre.z + (rnd() * 2 - 1) * 6);
          this.arena.clampToArea(this.goal, this.goal);
        }
        this.moveTo(this.goal, 0.55);
        this.safetyFactor = 1.5;
        break;
      }
      case 'idle':
      default:
        break;
    }

    // ------------------------------------------------ steering + safety
    if (this.t < this.detourUntil && this.moveMag > 0.2 && this.plan !== 'climb' && this.plan !== 'save' && this.plan !== 'recover') {
      this.mv.lerp(this.detour, 0.75).normalize();
    }
    if (steer && this.moveMag > 0.05) this.avoidObstacles();
    if (this.safetyFactor > 0 && this.moveMag > 0.05) this.edgeSafety();
    if (this.moveMag > 0.5) this.wantMoveT += dt;

    // ------------------------------------------------ write input
    const i = this.input;
    const t = this.t;
    i.moveX = this.mv.x * this.moveMag;
    i.moveZ = this.mv.z * this.moveMag;
    i.run = this.run && this.moveMag > 0.5;
    i.grabLeft = this.holdL || t < this.tapL;
    i.grabRight = this.holdR || t < this.tapR;
    i.kick = t < this.tapKick;
    i.duck = this.holdDuck || t < this.tapDuck;
    i.jump = this.holdJump || t < this.tapJump;
    i.lift = this.holdLift;
    void mode;
  }

  // ---------------------------------------------------------------------------------- plans
  private actClimb(): void {
    // hold on, pull up (hold jump); letting go of jump would drop us with a hop
    this.holdL = this.holdR = true;
    if (this.climbOk) this.holdJump = this.modeT > this.profile.react * 0.5;
    else if (this.climbLetGo > 0 && this.t > this.climbLetGo) {
      // clumsy: try a late pull-up, half of them slip off
      if (rnd() < 0.5) this.holdJump = true;
      else this.holdL = this.holdR = false;
      this.climbLetGo = 0;
      this.climbOk = this.holdJump;
    }
    this.arena.clampToArea(this.me, this.goal);
    this.moveTo(this.goal, 0.7, 0.05);
  }

  /** Seconds a run from here to the bridge shelter takes (boat). */
  private shelterNeed(): number {
    const S = this.sense;
    if (!S.shelterPoint(this.me, this.v2, this.shelterJit)) return 0;
    const gy = this.b.groundY ?? this.me.y - 0.9;
    if (S.onLowDeck(this.me, gy)) return 0.3;
    return this.horizDist(this.v2) / 3.4 + 0.4;
  }

  private actShelter(): void {
    const S = this.sense;
    const gy = this.b.groundY ?? this.me.y - 0.9;
    const onDeck = S.onLowDeck(this.me, gy);
    if (S.shelterPoint(this.me, this.goal, this.shelterJit)) {
      const d = this.moveTo(this.goal, 1, onDeck ? 0.9 : 0.25);
      this.run = d > 1.2;
      this.safetyFactor = 0.6;
    }
    // duck on the low deck just before the bridge arrives (on the roof only when it is too late)
    const tb = S.bridgeTime(this.me);
    this.holdDuck = (onDeck && tb < 1.6) || tb < 0.3;
    if (this.holdDuck) {
      this.moveMag = Math.min(this.moveMag, 0.3);
      // swat at whoever shares the deck
      const e = this.nearestEnemy(1.1);
      if (e && this.t >= this.nextHitAt) this.punch();
    }
  }

  private actStruggle(): void {
    const b = this.b;
    const holder = b.heldBy && b.heldBy.length ? this.beastById(b.heldBy[0]) : null;
    if (!holder) return;
    const lifted = holder.isLifting === true;
    const ph = this.planT % 1.6;
    if (lifted) {
      // flail: mash punches and kicks
      if (this.t >= this.nextHitAt) this.punch();
      if (rnd() < 0.08) this.kickTap();
      return;
    }
    this.inward(this.me, this.n);
    const e = this.arena.edgeDistance(this.me);
    if (ph < 0.7 || e < this.margin * 1.2) {
      // pull away from the drop (and from the holder)
      const dx = this.me.x - holder.position.x, dz = this.me.z - holder.position.z;
      const l = Math.hypot(dx, dz) || 1;
      this.moveDir(this.n.x * 1.2 + (dx / l) * 0.6, this.n.z * 1.2 + (dz / l) * 0.6, 1);
      this.run = true;
    } else {
      // stand and punch back (the beast auto-faces the nearest enemy when attacking)
      if (this.t >= this.nextHitAt) this.punch();
      if (rnd() < 0.03) this.kickTap();
    }
    // grab back now and then (hard bots)
    this.holdL = this.difficulty !== 'makkelijk' && ph > 1.1;
  }

  private actGrab(): void {
    const tgt = this.target;
    if (!tgt || tgt.state === 'eliminated') {
      this.setPlan('idle');
      return;
    }
    const d = this.horizDist(tgt.position);
    this.tp.copy(tgt.position);
    if (d > 1.0) {
      this.moveTo(this.tp, d > 3 ? 1 : 0.7);
      this.run = this.profile.run && d > 3.5;
      // raise the arms when close
      this.holdL = this.holdR = d < 1.7;
    } else {
      this.moveTo(this.tp, 0.25, 0.3);
      this.holdL = this.holdR = true;
    }
    this.safetyFactor = 0.7;
    if (this.planT > 4.5) {
      this.holdL = this.holdR = false;
      this.setPlan('fight');
      this.pickPattern(tgt, d);
    }
  }

  private actCarry(dt: number): void {
    const P = this.profile;
    const b = this.b;
    const v = this.heldVictim();
    this.carryT += dt;
    this.stageT += dt;
    if (!v && this.stage < 3) {
      this.holdL = this.holdR = this.holdLift = false;
      this.setPlan('idle');
      this.thinkAt = Math.min(this.thinkAt, this.t + 0.1);
      return;
    }
    // which hand holds it: keep that one; the other joins in or punches (hard bots)
    const vid = v ? v.id : -2;
    const leftHolds = b.holding.left === vid;
    const rightHolds = b.holding.right === vid;
    const vm = v ? modeOf(v) : 'out';
    const awake = vm !== 'ko' && vm !== 'out';
    if (this.stage < 3) {
      const punchFree = this.stage === 0 && leftHolds !== rightHolds && v !== null &&
        (awake || (P.dragPunch && (v.koTime ?? 9) < 1.4));
      if (punchFree) {
        // keep the victim knocked out with the free hand
        this.holdL = leftHolds;
        this.holdR = rightHolds;
        if (this.t >= this.nextHitAt) {
          if (leftHolds) this.tapR = this.t + 0.07;
          else this.tapL = this.t + 0.07;
          this.nextHitAt = this.t + P.punchInterval * 1.6;
          this.stats.punches++;
        }
      } else this.holdL = this.holdR = true;
    }
    const stamina = b.stamina ?? 100;
    const hurry = this.carryT > P.maxCarry || stamina < 18;
    switch (this.stage) {
      case 0: {
        // find a throw direction from here; else drag towards the nearest drop.
        // Awake victims are only thrown by normaal/moeilijk (makkelijk keeps punching them).
        const vs = v ? v.strength ?? 1 : 1;
        const awakeThrow = this.difficulty === 'moeilijk' ? vs < 0.45 && this.carryT > 0.8 : this.difficulty === 'normaal' ? vs < 0.35 && this.carryT > 1.4 : false;
        if (awake && this.carryT > 3.5 && !awakeThrow) {
          // can't get this one off its feet: let go and punch it instead
          this.holdL = this.holdR = false;
          this.grabCool = this.t + 2.5;
          this.setPlan('fight');
          this.pattern = 'jab';
          this.comboLeft = 3;
          return;
        }
        const yaw = !awake || awakeThrow ? this.bestThrowYaw() : null;
        if (yaw !== null) {
          this.throwYaw = yaw;
          this.stage = 1;
          this.stageT = 0;
          break;
        }
        if (hurry) {
          // no good direction: throw at the nearest drop direction anyway
          this.throwYaw = this.nearestDropYaw() ?? b.facing;
          this.stage = 1;
          this.stageT = 0;
          break;
        }
        const dy = this.nearestDropYaw();
        if (dy !== null) this.moveDir(Math.sin(dy), Math.cos(dy), 1);
        else this.moveTo(this.sense.centre, 0.8);
        this.safetyFactor = 0.8;
        break;
      }
      case 1: {
        // turn to the throw direction (moving slowly that way turns the torso)
        this.moveDir(Math.sin(this.throwYaw), Math.cos(this.throwYaw), 0.3);
        this.safetyFactor = 0.6;
        if (Math.abs(wrapPi(b.facing - this.throwYaw)) < 0.35 || this.stageT > 0.9) {
          this.stage = 2;
          this.stageT = 0;
        }
        break;
      }
      case 2: {
        this.holdLift = true;
        this.moveDir(Math.sin(this.throwYaw), Math.cos(this.throwYaw), 0.2);
        this.safetyFactor = 0.6;
        // throw once the victim is really up over the head (or the lift is taking too long)
        const up = v ? v.position.y - this.me.y : 0;
        if ((this.stageT > P.liftHold && up > 0.55) || this.stageT > P.liftHold + 0.9) {
          // release lift -> throw
          this.holdLift = false;
          this.stage = 3;
          this.stageT = 0;
          this.stats.throws++;
          this.victim = v;
          this.victimCheckAt = this.t + 1.8;
        }
        break;
      }
      case 3: {
        this.holdLift = false;
        if (this.stageT > 0.08) this.holdL = this.holdR = false;
        else this.holdL = this.holdR = true;
        if (this.stageT > 0.45) {
          this.setPlan('idle');
          this.thinkAt = this.t;
        }
        break;
      }
    }
  }

  private actFight(dt: number): void {
    const tgt = this.target;
    const P = this.profile;
    if (!tgt || tgt.state === 'eliminated') {
      this.setPlan('idle');
      return;
    }
    this.patternT += dt;
    const d = this.horizDist(tgt.position);
    const grounded = this.b.grounded !== false;
    this.tp.copy(tgt.position);
    if (d > 2.2) this.tp.add(this.aimOff);
    if (this.edgeCtl && d > 0.9) {
      // the spot 1 m on the inward side of the target; once there, step in towards the drop
      const side = (this.me.x - tgt.position.x) * this.ctlDir.x + (this.me.z - tgt.position.z) * this.ctlDir.z;
      if (side < 0.5 && d < 4) this.tp.addScaledVector(this.ctlDir, 1.1);
    }
    this.safetyFactor = 1;
    switch (this.pattern) {
      case 'grabPunch': {
        const holdsIt = this.b.holding.left === tgt.id || this.b.holding.right === tgt.id;
        if (holdsIt) {
          // hold with the left, hammer with the right
          this.holdL = this.b.holding.left === tgt.id;
          this.holdR = this.b.holding.right === tgt.id && !this.holdL;
          this.moveTo(this.tp, 0.2, 0.4);
          if (this.t >= this.nextHitAt) {
            if (this.holdL) this.tapR = this.t + 0.07;
            else this.tapL = this.t + 0.07;
            this.nextHitAt = this.t + P.punchInterval * (0.85 + rnd() * 0.4);
            this.stats.punches++;
          }
          if (this.patternT > 5) this.pickPattern(tgt, d);
        } else {
          this.moveTo(this.tp, d > 2.5 ? 1 : 0.6, 0.35);
          this.run = P.run && d > 4;
          this.holdL = d < 1.9;
          this.holdR = false;
          if (this.patternT > 2.6) this.pickPattern(tgt, d);
        }
        return;
      }
      case 'dropkick': {
        if (this.dropkickAt > 0) {
          this.moveTo(this.tp, 1, 0.05);
          if (this.t >= this.dropkickAt) {
            this.kickTap();
            this.stats.dropkicks++;
            this.dropkickAt = -1;
            this.pattern = 'jab';
            this.comboLeft = 2;
          }
          return;
        }
        if (d > 2.4) {
          this.moveTo(this.tp, 1);
          this.run = P.run;
        } else if (d > 1.3 && grounded && this.t > this.nextJumpOk && this.jumpSafe(this.mv.x, this.mv.z, d + 0.6, 0.8)) {
          this.moveTo(this.tp, 1);
          this.tapJump = this.t + 0.08;
          this.nextJumpOk = this.t + 1.2;
          this.dropkickAt = this.t + 0.16;
        } else {
          this.pattern = 'kick';
          this.patternT = 0;
        }
        return;
      }
      case 'kick':
      case 'headbutt': {
        const want = this.pattern === 'kick' ? 1.05 : 0.75;
        if (d > want) {
          this.moveTo(this.tp, d > 2.5 ? 1 : 0.6, 0.2);
          this.run = P.run && d > 4;
          if (this.patternT > 3) this.pickPattern(tgt, d);
          return;
        }
        this.moveTo(this.tp, 0.2, 0.3);
        if (this.pattern === 'kick') this.kickTap();
        else {
          this.tapDuck = this.t + 0.1;
          this.stats.headbutts++;
        }
        this.pattern = 'jab';
        this.patternT = 0;
        this.comboLeft = Math.max(1, this.comboLeft - 1);
        this.nextHitAt = this.t + 0.35;
        return;
      }
      case 'jab':
      default: {
        if (d > this.range) {
          this.moveTo(this.tp, d > 2.5 ? 1 : 0.65, 0.2);
          this.run = P.run && d > 4.5;
          return;
        }
        // in range: everything below aims at the beast itself (no approach offsets)
        this.tp.copy(tgt.position);
        if (this.t < this.pauseUntil) {
          // circle around the target between combos
          const dx = this.tp.x - this.me.x, dz = this.tp.z - this.me.z;
          this.moveDir(dz * this.strafe + dx * 0.25, -dx * this.strafe + dz * 0.25, 0.45);
          return;
        }
        if (this.comboLeft <= 0) {
          this.comboLeft = P.comboMin + Math.floor(rnd() * (P.comboMax - P.comboMin + 1));
          this.pauseUntil = this.t + P.comboPause * (0.6 + rnd() * 0.8);
          if (rnd() < 0.35) this.strafe = -this.strafe;
          if (rnd() > P.aggression) this.pauseUntil += 0.6;
          if (rnd() < 0.3) this.pickPattern(tgt, d);
          return;
        }
        // off balance (just got hit): back off a moment instead of throwing weak punches
        if ((this.b.strength ?? 1) < P.strengthGate) {
          const dx = this.me.x - this.tp.x, dz = this.me.z - this.tp.z;
          this.moveDir(dx + dz * this.strafe * 0.8, dz - dx * this.strafe * 0.8, 0.55);
          return;
        }
        // keep the punching distance: step in when far, step back when crowded
        if (d < P.minRange) {
          // a slow back-step (|move| <= 0.15 keeps the torso turned to the target while punching)
          const dx = this.me.x - this.tp.x, dz = this.me.z - this.tp.z;
          this.moveDir(dx, dz, 0.14);
        } else this.moveTo(this.tp, d > 0.75 ? 0.3 : 0.12, 0.25);
        if (this.t >= this.nextHitAt) {
          this.punch();
          this.comboLeft--;
        }
      }
    }
  }

  private actStomp(): void {
    const tgt = this.target;
    if (!tgt || tgt.state === 'eliminated' || modeOf(tgt) !== 'climb') {
      this.setPlan('idle');
      return;
    }
    // stand at the edge above the hanging beast and punch / kick its hands and head
    this.arena.clampToArea(tgt.position, this.goal);
    const d = this.moveTo(this.goal, 0.8, 0.35);
    this.safetyFactor = 0.45;
    if (d < 1.3 && this.horizDist(tgt.position) < 1.6) {
      if (this.t >= this.nextHitAt) {
        if (rnd() < 0.3) this.kickTap();
        else this.punch();
      }
    }
  }

  private actProp(dt: number): void {
    const p = this.prop;
    const b = this.b;
    if (!p) {
      this.setPlan('idle');
      return;
    }
    if (this.t >= this.propReadAt) {
      // rapier allocates a small object per translation(): read it at 10 Hz
      this.propReadAt = this.t + 0.1;
      const tr = p.translation();
      this.propPos.set(tr.x, tr.y, tr.z);
    }
    this.goal.copy(this.propPos);
    this.stageT += dt;
    switch (this.stage) {
      case 0: {
        const d = this.moveTo(this.goal, 0.6, 0.55);
        this.safetyFactor = 1.3;
        if (d < 0.75) {
          this.stage = 1;
          this.stageT = 0;
        } else if (this.planT > 5) this.setPlan('idle');
        break;
      }
      case 1: {
        // stop with the prop ~0.5 m in front (under the hands), duck, then reach down with both hands
        this.moveTo(this.goal, 0.2, 0.5);
        this.holdDuck = true;
        this.holdL = this.holdR = this.stageT > 0.3;
        const hl = b.heldBodyOf?.('left') ?? null;
        const hr = b.heldBodyOf?.('right') ?? null;
        const got = (hl && hl.handle === p.handle) || (hr && hr.handle === p.handle);
        const wrong = (b.holding.left !== null && !(hl && hl.handle === p.handle)) || (b.holding.right !== null && !(hr && hr.handle === p.handle));
        if (got) {
          this.stage = 2;
          this.stageT = 0;
        } else if (wrong || this.stageT > 1.4) {
          // grabbed the floor (or nothing): let go, one more try from a step back
          this.holdL = this.holdR = false;
          if (this.propTries++ < 1) {
            this.stage = 0;
            this.stageT = 0;
          } else this.setPlan('idle');
        }
        break;
      }
      case 2: {
        // turn to the nearest enemy, lift, throw
        this.holdDuck = false;
        this.holdL = this.holdR = true;
        const e = this.nearestEnemy(8);
        if (e) {
          this.throwYaw = Math.atan2(e.position.x - this.me.x, e.position.z - this.me.z);
          this.moveDir(Math.sin(this.throwYaw), Math.cos(this.throwYaw), 0.25);
        }
        this.holdLift = this.stageT > 0.35;
        if (this.stageT > 0.35 + this.profile.liftHold + 0.2) {
          this.holdLift = false;
          this.stage = 3;
          this.stageT = 0;
          this.stats.propThrows++;
        }
        if (b.holding.left === null && b.holding.right === null) this.setPlan('idle');
        break;
      }
      default: {
        this.holdLift = false;
        this.holdL = this.holdR = this.stageT < 0.08;
        if (this.stageT > 0.4) this.setPlan('idle');
      }
    }
    this.holdDuck = this.stage === 1;
    if (this.stage !== 1 && this.plan === 'prop') this.holdDuck = false;
    if (this.plan !== 'prop') {
      this.holdDuck = false;
      this.holdLift = false;
      this.prop = null;
    }
  }

  // ---------------------------------------------------------------------------------- buttons
  private punch(): void {
    if (this.side === 0) this.tapL = this.t + 0.07;
    else this.tapR = this.t + 0.07;
    this.side = 1 - this.side;
    this.nextHitAt = this.t + this.profile.punchInterval * (0.8 + rnd() * 0.45);
    this.stats.punches++;
  }

  private kickTap(): void {
    if (this.t < this.tapKick + 0.1) return;
    this.tapKick = this.t + 0.08;
    this.stats.kicks++;
    this.nextHitAt = Math.max(this.nextHitAt, this.t + 0.4);
  }

  // ---------------------------------------------------------------------------------- perception
  private horizDist(p: THREE.Vector3): number {
    return Math.hypot(p.x - this.me.x, p.z - this.me.z);
  }

  private nearestEnemy(r: number): Beast | null {
    let best: Beast | null = null;
    let bd = r;
    for (const o of this.system.beasts) {
      if (o === this.beast || o.state === 'eliminated') continue;
      const d = this.horizDist(o.position);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Unit horizontal direction away from the nearest drop at p (edgeDistance gradient). */
  private inward(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const a = this.arena;
    const h = 0.3;
    const v = this.v2;
    const ex1 = a.edgeDistance(v.set(p.x + h, p.y, p.z));
    const ex0 = a.edgeDistance(v.set(p.x - h, p.y, p.z));
    const ez1 = a.edgeDistance(v.set(p.x, p.y, p.z + h));
    const ez0 = a.edgeDistance(v.set(p.x, p.y, p.z - h));
    let gx = ex1 - ex0, gz = ez1 - ez0;
    if (!Number.isFinite(gx) || !Number.isFinite(gz) || Math.hypot(gx, gz) < 1e-4) {
      gx = this.sense.centre.x - p.x;
      gz = this.sense.centre.z - p.z;
    }
    const l = Math.hypot(gx, gz) || 1;
    return out.set(gx / l, 0, gz / l);
  }

  /** Yaw of a throw from here that lands the victim out (closest to the current facing), or null. */
  private bestThrowYaw(): number | null {
    const S = this.sense;
    const f = this.b.facing;
    let best: number | null = null;
    let bs = Infinity;
    for (let k = 0; k < 16; k++) {
      const yaw = f + (k / 16) * TAU;
      const dx = Math.sin(yaw), dz = Math.cos(yaw);
      S.march(this.me.x, this.me.z, dx, dz, 4.6, this.mres);
      if (this.mres.k !== DROP && this.mres.k !== OUT) continue;
      if (this.mres.d > 3.8) continue;
      // the landing spot (~4 m) must be out too
      this.v1.set(this.me.x + dx * 4.2, S.floorY + 0.9, this.me.z + dz * 4.2);
      const kl = S.cellAt(this.v1.x, this.v1.z);
      if (kl === FLOOR && !this.arena.isOut(this.v1)) continue;
      const s = Math.abs(wrapPi(yaw - f)) * 0.8 + this.mres.d * 0.35 + (this.mres.k === OUT ? 0.6 : 0);
      if (s < bs) {
        bs = s;
        best = yaw;
      }
    }
    return best;
  }

  /** Yaw towards the nearest drop / out zone (grid march), null if none within 14 m. */
  private nearestDropYaw(): number | null {
    const S = this.sense;
    let best: number | null = null;
    let bd = Infinity;
    for (let k = 0; k < 16; k++) {
      const yaw = (k / 16) * TAU;
      S.march(this.me.x, this.me.z, Math.sin(yaw), Math.cos(yaw), 14, this.mres);
      // prefer the water (a splash!) over the crowd behind the barriers
      const cost = this.mres.k === DROP ? this.mres.d : this.mres.d * 1.5 + 2;
      if ((this.mres.k === DROP || this.mres.k === OUT) && cost < bd) {
        bd = cost;
        best = yaw;
      }
    }
    if (best === null && S.gridOk === false) {
      // no grid: the edgeDistance gradient
      if (Number.isFinite(this.arena.edgeDistance(this.me))) {
        this.inward(this.me, this.n);
        return Math.atan2(-this.n.x, -this.n.z);
      }
    }
    return best;
  }

  /** A jump along (dx, dz) landing ~dist m ahead keeps clear of drops (both here and there). */
  private jumpSafe(dx: number, dz: number, dist: number, extra = 0): boolean {
    const v = this.b.velocity;
    const sp = Math.hypot(v.x, v.z);
    const need = this.margin + 0.5 + sp * 0.2 + extra;
    if (!(this.arena.edgeDistance(this.me) > need)) return false;
    if (dist <= 0) return true;
    const l = Math.hypot(dx, dz) || 1;
    // the flight carries the current speed too
    const reach = dist + sp * 0.45;
    for (let k = 1; k <= 3; k++) {
      const f = (reach * k) / 3;
      const p = this.v1.set(this.me.x + (dx / l) * f + v.x * 0.15 * k, this.me.y, this.me.z + (dz / l) * f + v.z * 0.15 * k);
      if (!(this.arena.edgeDistance(p) > need * 0.8)) return false;
      if (this.sense.cellAt(p.x, p.z) !== FLOOR) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------- steering
  /** Obstacle whiskers on the grid (mill body, cheese stacks, benches) + jump onto steps. */
  private avoidObstacles(): void {
    const S = this.sense;
    if (!S.gridOk) return;
    const look = 0.75;
    const x = this.me.x, z = this.me.z;
    const here = S.heightAt(x, z);
    let dx = this.mv.x, dz = this.mv.z;
    if (S.cellAt(x + dx * look, z + dz * look) === HIGH) {
      if (this.t > this.steerSideUntil) {
        // pick the side that frees up first, stick with it for a while
        this.steerSide = this.freeSide(dx, dz, look);
        this.steerSideUntil = this.t + 1.2;
      }
      for (let i = 1; i <= 4; i++) {
        const a = this.steerSide * i * 0.5;
        const c = Math.cos(a), s = Math.sin(a);
        const rx = dx * c + dz * s, rz = -dx * s + dz * c;
        if (S.cellAt(x + rx * look, z + rz * look) !== HIGH) {
          dx = rx;
          dz = rz;
          break;
        }
      }
      this.mv.set(dx, 0, dz);
    }
    // step up (boat roof from the rear deck, low benches): jump
    const ahead = S.heightAt(x + dx * 0.6, z + dz * 0.6);
    const beyond = S.heightAt(x + dx * 1.2, z + dz * 1.2);
    const platform = Number.isFinite(beyond) && Math.abs(beyond - ahead) < 0.25;
    if (platform && Number.isFinite(here) && Number.isFinite(ahead) && ahead - here > 0.35 && ahead - here < 1.1 && this.moveMag > 0.4) {
      if (this.b.grounded !== false && this.t > this.nextJumpOk && this.jumpSafe(dx, dz, 1.3)) {
        this.tapJump = this.t + 0.1;
        this.nextJumpOk = this.t + 0.9;
      }
    }
  }

  private freeSide(dx: number, dz: number, look: number): number {
    const S = this.sense;
    for (let i = 1; i <= 4; i++) {
      for (let sg = 1; sg >= -1; sg -= 2) {
        const a = sg * i * 0.45;
        const c = Math.cos(a), s = Math.sin(a);
        const rx = dx * c + dz * s, rz = -dx * s + dz * c;
        if (S.cellAt(this.me.x + rx * look, this.me.z + rz * look) !== HIGH) return sg;
      }
    }
    return 1;
  }

  /** Keep away from drops: remove the outward part of the move, push back in when too close. */
  private edgeSafety(): void {
    const a = this.arena;
    const S = this.sense;
    const margin = this.margin * this.safetyFactor;
    const look = 0.35 + 0.4 * this.moveMag * (this.run ? 1.4 : 1);
    const e0 = a.edgeDistance(this.me);
    const p1 = this.v1.set(this.me.x + this.mv.x * look, this.me.y, this.me.z + this.mv.z * look);
    const e1 = a.edgeDistance(p1);
    const k0 = S.cellAt(this.me.x, this.me.z);
    const k1 = S.cellAt(p1.x, p1.z);
    const gridDrop = k1 === DROP && k0 === FLOOR;
    const close = e1 < margin && e1 <= e0 + 0.01;
    if (!close && !gridDrop && !(e0 < margin * 0.5)) return;
    this.inward(this.me, this.n);
    let mx = this.mv.x * this.moveMag, mz = this.mv.z * this.moveMag;
    const dot = mx * this.n.x + mz * this.n.z;
    if (dot < 0) {
      mx -= this.n.x * dot;
      mz -= this.n.z * dot;
    }
    if (gridDrop && !close) {
      // a drop the arena data does not know about: stop going that way
      mx -= this.mv.x * this.moveMag * 0.9;
      mz -= this.mv.z * this.moveMag * 0.9;
    }
    if (e0 < margin * 0.6) {
      const k = (1 - e0 / (margin * 0.6)) * 0.8;
      mx += this.n.x * k;
      mz += this.n.z * k;
    }
    const l = Math.hypot(mx, mz);
    if (l < 1e-4) {
      this.moveMag = 0;
      return;
    }
    this.mv.set(mx / l, 0, mz / l);
    this.moveMag = Math.min(1, l);
    if (e0 < margin) this.run = false;
  }
}
