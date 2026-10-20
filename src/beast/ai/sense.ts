// Arena knowledge shared by all bots in one arena (bots module):
//  - a coarse walkability grid (0.5 m cells, built once with static ray casts): floor / high
//    obstacle / drop / out, plus the surface height (step-ups need a jump);
//  - the edge margin scale (narrow boat roof vs. the wide Waagplein);
//  - hazards: the molen sails (kinematic body tagged 'wieken'), the kaasmarkt cheese porters
//    (kinematic body tagged 'kaasdragers') and the rondvaartboot bridge warning;
//  - loose props (cheese wheels, flour sacks) for silly throwing.
// Everything is read from Rapier bodies / arena getters so it also works in fast-forward dev runs.
import * as THREE from 'three';
import type { Arena } from '../../brawl/contracts';
import type { PhysicsWorld } from '../../contracts';
import { GROUP } from '../../physics/physics';

export const FLOOR = 0;
export const HIGH = 1;
export const DROP = 2;
export const OUT = 3;

/** Minimal view of a Rapier rigid body (typed loosely, as PhysicsWorld.RAPIER is). */
export interface BodyLike {
  readonly handle: number;
  translation(): { x: number; y: number; z: number };
  rotation(): { x: number; y: number; z: number; w: number };
  isDynamic(): boolean;
  mass(): number;
}
interface ColliderLike {
  readonly handle: number;
  collisionGroups(): number;
  parent(): BodyLike | null;
}
interface PhysicsLike extends PhysicsWorld {
  readonly time?: number;
  tagOf?(handle: number): string | undefined;
}
interface BoatFrameLike {
  toLocal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  toWorld(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
}
type ArenaDebug = {
  debug?: { frame?: BoatFrameLike; sails?: () => { omega: number }; state?: () => { v: number; flip: boolean; next: number } };
  warning?: number;
  floorY?: number;
};

// molen sails (src/arenas/molen.ts: SAIL_SCALE 1.09, blade cuboids in the pivot frame)
const SAIL_S = 1.09;
const BLADE_C = 7.475 * SAIL_S;
const BLADE_HALF = 5.2 * SAIL_S;
const BLADE_HW = 1.54 * SAIL_S;
const BLADE_OFF = 0.51 * SAIL_S;
const BLADE_Z0 = -0.59;
const BLADE_Z1 = 0.5;
// kaasmarkt porter box half extents (cuboid 0.42 x 0.82 x 1.92)
const PORTER_HW = 0.42;
const PORTER_HL = 1.92;
// boat (src/arenas/boat/model.ts BOAT): rear deck z -9.4..-4.6 at 0.32, cabin roof 1.0
const BOAT_DECK = 0.32;
const BOAT_CABIN_Z0 = -4.6;
const BOAT_CABIN_Z1 = 7.0;
const BOAT_HALF_L = 9.5;
/** a bridge deck is ~5-10 m long: under it for that far after its face passed */
const BRIDGE_LEN = 11;

const TAU = Math.PI * 2;
const wrap2Pi = (a: number) => ((a % TAU) + TAU) % TAU;

export class ArenaSense {
  readonly arena: Arena;
  readonly physics: PhysicsLike;
  readonly floorY: number;
  /** average of the spawn points (a safe interior point) */
  readonly centre = new THREE.Vector3();
  /** multiplier for edge margins: 1 on big squares, ~0.4 on the narrow boat */
  readonly marginScale: number;
  /** extra edge margin (m): the boat roof edge sits 0.3 m inside the hull outline */
  readonly marginOffset: number;

  // ---------------------------------------------------------------- grid
  readonly cell = 0.5;
  private x0 = 0;
  private z0 = 0;
  private nx = 0;
  private nz = 0;
  private cls: Uint8Array = new Uint8Array(0);
  private hgt: Float32Array = new Float32Array(0);
  /** false until a plausible grid was built (spawn cells are floor) */
  gridOk = false;
  private gridTries = 0;
  private gridNextT = 0;

  // ---------------------------------------------------------------- hazards
  private lastT = -1;
  private clock = 0;
  // molen
  private sailBody: BodyLike | null = null;
  private readonly sailPos = new THREE.Vector3();
  private readonly sailInv = new THREE.Quaternion();
  private omega = 0.3;
  private omegaAt = -1;
  private readonly millPos = new THREE.Vector3();
  private millYaw = 0;
  readonly hasSails: boolean;
  // kaasmarkt
  private porterBody: BodyLike | null = null;
  readonly porterPos = new THREE.Vector3();
  readonly porterVel = new THREE.Vector3();
  private readonly porterPrev = new THREE.Vector3();
  private porterPrevT = -1;
  porterActive = false;
  // boat
  readonly boatFrame: BoatFrameLike | null;
  warning = 0;
  /** boat: distance (m) from the leading end to the next bridge face, speed, +1 = bow leads */
  boatNext = Infinity;
  boatSpeed = 0;
  boatLead = 1;
  private boatAt = -1;
  // props
  readonly props: BodyLike[] = [];

  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(arena: Arena, physics: PhysicsWorld) {
    this.arena = arena;
    this.physics = physics as PhysicsLike;
    const ext = arena as Arena & ArenaDebug;
    const sp = arena.spawnPoints;
    let minY = Infinity;
    for (const s of sp) {
      this.centre.add(s.position);
      minY = Math.min(minY, s.position.y);
    }
    if (sp.length) this.centre.multiplyScalar(1 / sp.length);
    else this.centre.copy(arena.camera.target);
    this.floorY = typeof ext.floorY === 'number' ? ext.floorY : Number.isFinite(minY) ? minY : this.centre.y;
    let es = 0;
    for (const s of sp) {
      const e = arena.edgeDistance(s.position);
      if (Number.isFinite(e)) es = Math.max(es, e);
    }
    if (es === 0) es = 6;
    this.marginScale = THREE.MathUtils.clamp(es / 3, 0.4, 1);
    this.marginOffset = ext.debug?.frame ? 0.5 : 0;
    this.boatFrame = ext.debug?.frame && typeof ext.debug.frame.toLocal === 'function' ? ext.debug.frame : null;

    // hazard bodies by collider tag
    const tagOf = this.physics.tagOf?.bind(this.physics);
    if (tagOf) {
      this.physics.world.forEachCollider((c: ColliderLike) => {
        const tag = tagOf(c.handle);
        if (tag === 'wieken' && !this.sailBody) this.sailBody = c.parent();
        else if (tag === 'kaasdragers' && !this.porterBody) this.porterBody = c.parent();
      });
    }
    this.hasSails = !!this.sailBody;
    const mill = arena.root.getObjectByName('arena_molen');
    if (mill) {
      mill.updateWorldMatrix(true, false);
      this.millPos.setFromMatrixPosition(mill.matrixWorld);
      this.millYaw = mill.rotation.y;
    }
    this.collectProps();
  }

  // ================================================================ grid
  /** ms the last grid build took (one-off per arena) */
  buildMs = 0;

  private buildGrid(): void {
    const t0 = performance.now();
    const sp = this.arena.spawnPoints;
    let r = 0;
    for (const s of sp) r = Math.max(r, Math.hypot(s.position.x - this.centre.x, s.position.z - this.centre.z));
    r = Math.min(22, r + 5.5);
    const c = this.cell;
    this.nx = Math.ceil((2 * r) / c);
    this.nz = this.nx;
    this.x0 = this.centre.x - r;
    this.z0 = this.centre.z - r;
    const n = this.nx * this.nz;
    if (this.cls.length !== n) {
      this.cls = new Uint8Array(n);
      this.hgt = new Float32Array(n);
    }
    const fy = this.floorY;
    const p = this.v;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + (ix + 0.5) * c;
        const z = this.z0 + (iz + 0.5) * c;
        const h = this.physics.raycastDown(x, z, fy + 3.5);
        const i = iz * this.nx + ix;
        let k: number;
        if (h === null || h < fy - 0.8) k = DROP;
        else if (h > fy + 1.05) k = HIGH;
        else k = FLOOR;
        p.set(x, fy + 0.9, z);
        if (k === FLOOR && this.arena.edgeDistance(p) <= 0) k = DROP;
        if (k !== HIGH && this.arena.isOut(p)) k = k === DROP ? DROP : OUT;
        this.cls[i] = k;
        this.hgt[i] = h === null ? -1e9 : h;
      }
    }
    // plausibility: every spawn must stand on floor
    let ok = true;
    for (const s of sp) {
      const k = this.cellAt(s.position.x, s.position.z, true);
      if (k !== FLOOR) ok = false;
    }
    this.gridOk = ok;
    this.buildMs = performance.now() - t0;
  }

  /** Make sure the grid exists (built lazily: Rapier answers ray casts only after a world step). */
  ensureGrid(force = false): void {
    if (this.gridOk || this.gridTries >= 6 || (!force && this.clock < this.gridNextT)) return;
    this.gridTries++;
    this.gridNextT = this.clock + 0.75;
    this.buildGrid();
  }

  /** Cell class at (x, z); FLOOR while the grid is not trustworthy, OUT outside the grid. */
  cellAt(x: number, z: number, raw = false): number {
    if (!this.gridOk && !raw) return FLOOR;
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return OUT;
    return this.cls[iz * this.nx + ix];
  }

  /** Surface height of the cell (NaN when unknown / no grid / no surface). */
  heightAt(x: number, z: number): number {
    if (!this.gridOk) return NaN;
    const ix = Math.floor((x - this.x0) / this.cell);
    const iz = Math.floor((z - this.z0) / this.cell);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return NaN;
    const h = this.hgt[iz * this.nx + ix];
    return h < -1e8 ? NaN : h;
  }

  /**
   * Walk from (x, z) along (dx, dz) (unit) up to maxD: distance to the first non-floor cell and its
   * class in `res` ({ d, k }); a thin high cell (barrier) followed by out/drop counts as that edge.
   */
  march(x: number, z: number, dx: number, dz: number, maxD: number, res: { d: number; k: number }): void {
    res.d = maxD;
    res.k = FLOOR;
    const step = this.cell * 0.8;
    for (let d = step; d <= maxD; d += step) {
      const k = this.cellAt(x + dx * d, z + dz * d);
      if (k === FLOOR) continue;
      res.d = d;
      res.k = k;
      if (k === HIGH) {
        // barrier with the crowd / water behind it?
        for (let e = d + step; e <= d + 1.6; e += step) {
          const k2 = this.cellAt(x + dx * e, z + dz * e);
          if (k2 === OUT || k2 === DROP) {
            res.k = k2;
            return;
          }
          if (k2 === FLOOR) return;
        }
      }
      return;
    }
  }

  // ================================================================ hazards
  /** Update hazard state (once per physics time change, whichever bot calls it first). */
  tick(): void {
    const t = typeof this.physics.time === 'number' ? this.physics.time : performance.now() / 1000;
    if (t === this.lastT) return;
    const dt = this.lastT < 0 ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    this.clock += dt;
    this.ensureGrid();
    const ext = this.arena as Arena & ArenaDebug;
    if (typeof ext.warning === 'number') this.warning = ext.warning;
    if (this.boatFrame && this.clock - this.boatAt >= 0.1) {
      this.boatAt = this.clock;
      const st = ext.debug?.state?.();
      if (st) {
        this.boatNext = Number.isFinite(st.next) ? st.next : Infinity;
        this.boatSpeed = Math.abs(st.v);
        this.boatLead = (st.v >= 0) !== !!st.flip ? 1 : -1;
      }
    }
    if (this.sailBody) {
      const tr = this.sailBody.translation();
      const ro = this.sailBody.rotation();
      this.sailPos.set(tr.x, tr.y, tr.z);
      this.sailInv.set(ro.x, ro.y, ro.z, ro.w).invert();
      if (this.clock - this.omegaAt > 0.25) {
        this.omegaAt = this.clock;
        const s = ext.debug?.sails?.();
        if (s && Number.isFinite(s.omega)) this.omega = s.omega;
      }
    }
    if (this.porterBody) {
      const tr = this.porterBody.translation();
      if (this.porterPrevT < 0) {
        this.porterPrev.set(tr.x, tr.y, tr.z);
        this.porterPrevT = this.clock;
      } else if (this.clock - this.porterPrevT >= 0.1) {
        const pdt = this.clock - this.porterPrevT;
        this.porterPos.set(tr.x, tr.y, tr.z);
        this.porterVel.subVectors(this.porterPos, this.porterPrev).multiplyScalar(1 / pdt);
        this.porterVel.y = 0;
        if (this.porterPos.distanceToSquared(this.porterPrev) > 9) this.porterVel.set(0, 0, 0); // parked / teleported
        this.porterPrev.copy(this.porterPos);
        this.porterPrevT = this.clock;
        const sp = this.porterVel.length();
        this.porterActive = sp > 0.6 && sp < 12 && Math.hypot(this.porterPos.x - this.centre.x, this.porterPos.z - this.centre.z) < 40;
      }
    }
  }

  /**
   * Seconds until a hazard hits a beast whose chest is at p (0 = now, Infinity = none in sight).
   * `escape` gets a horizontal unit direction away from it.
   */
  hazardTime(p: THREE.Vector3, escape: THREE.Vector3): number {
    let best = Infinity;
    if (this.sailBody) {
      const t = this.sailTime(p);
      if (t < best) {
        best = t;
        this.sailEscape(p, escape);
      }
    }
    if (this.porterActive) {
      const t = this.porterTime(p);
      if (t < best) {
        best = t;
        this.porterEscape(p, escape);
      }
    }
    return best;
  }

  private sailTime(p: THREE.Vector3): number {
    const l = this.v.copy(p).sub(this.sailPos).applyQuaternion(this.sailInv);
    if (l.z < BLADE_Z0 - 0.55 || l.z > BLADE_Z1 + 0.55) return Infinity;
    const r = Math.hypot(l.x, l.y);
    if (r < BLADE_C - BLADE_HALF - 0.5 || r > BLADE_C + BLADE_HALF + 0.5) return Infinity;
    // angle of the point in the blade frame (blade 0 points along +y, angles like the blade rotation)
    const phi = Math.atan2(-l.x, l.y);
    const off = Math.atan2(BLADE_OFF, r);
    const hw = Math.atan2(BLADE_HW + 0.45, r);
    const w = Math.abs(this.omega) < 0.02 ? 0.02 : this.omega;
    let best = Infinity;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 - off;
      // the point's blade-frame angle moves at -omega
      let rel = w > 0 ? wrap2Pi(phi - a + hw) : wrap2Pi(a + hw - phi);
      if (rel <= 2 * hw) return 0;
      rel -= 2 * hw;
      const t = rel / Math.abs(w);
      if (t < best) best = t;
    }
    return best;
  }

  /** Away from the sail plane: along the stage ring towards the back, a bit inwards. */
  private sailEscape(p: THREE.Vector3, out: THREE.Vector3): void {
    const dx = p.x - this.millPos.x, dz = p.z - this.millPos.z;
    const c = Math.cos(this.millYaw), s = Math.sin(this.millYaw);
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const a = Math.atan2(lx, lz);
    const sg = a >= 0 ? 1 : -1;
    // local tangent (increasing |a|) + inward radial
    const tx = Math.cos(a) * sg - Math.sin(a) * 0.35;
    const tz = -Math.sin(a) * sg - Math.cos(a) * 0.35;
    // local -> world (R_y(yaw))
    out.set(tx * c + tz * s, 0, -tx * s + tz * c).normalize();
  }

  private porterTime(p: THREE.Vector3): number {
    const vx = this.porterVel.x, vz = this.porterVel.z;
    const sp = Math.hypot(vx, vz);
    const ux = vx / sp, uz = vz / sp;
    const dx = p.x - this.porterPos.x, dz = p.z - this.porterPos.z;
    const along = dx * ux + dz * uz;
    const lat = Math.abs(dx * uz - dz * ux);
    if (lat > PORTER_HW + 0.85 || along < -PORTER_HL - 0.4) return Infinity;
    // porters are seen from far away: report them early (x0.65)
    return Math.max(0, (along - PORTER_HL - 0.4) / sp) * 0.65;
  }

  private porterEscape(p: THREE.Vector3, out: THREE.Vector3): void {
    const vx = this.porterVel.x, vz = this.porterVel.z;
    const sp = Math.hypot(vx, vz) || 1;
    const px = vz / sp, pz = -vx / sp;
    const dx = p.x - this.porterPos.x, dz = p.z - this.porterPos.z;
    // run to the side away from the drop (the porters knock beasts towards the canal)
    let sg = dx * px + dz * pz >= 0 ? 1 : -1;
    const c = this.v.set(p.x + px * sg * 1.6, p.y, p.z + pz * sg * 1.6);
    const e1 = this.arena.edgeDistance(c);
    c.set(p.x - px * sg * 1.6, p.y, p.z - pz * sg * 1.6);
    const e2 = this.arena.edgeDistance(c);
    if (e2 > e1 + 0.3) sg = -sg;
    out.set(px * sg - (vx / sp) * 0.15, 0, pz * sg - (vz / sp) * 0.15).normalize();
  }

  // ================================================================ boat
  /** Boat: is p on a low deck (rear deck or bow deck), where ducking clears the bridges? */
  onLowDeck(p: THREE.Vector3, groundY: number): boolean {
    if (!this.boatFrame) return false;
    const l = this.boatFrame.toLocal(p, this.v);
    if (l.z < BOAT_CABIN_Z0 - 0.35 || l.z > BOAT_CABIN_Z1 + 0.5) return true;
    return groundY < this.floorY + 0.3 && (l.z < BOAT_CABIN_Z0 + 0.2 || l.z > BOAT_CABIN_Z1 - 0.2);
  }

  /**
   * Boat: seconds until the next low bridge reaches p (0 while it passes over p), Infinity when no
   * bridge is coming. Uses the arena's route state (distance from the leading end to the bridge).
   */
  bridgeTime(p: THREE.Vector3): number {
    if (!this.boatFrame || !Number.isFinite(this.boatNext)) return Infinity;
    const z = this.boatFrame.toLocal(p, this.v).z;
    const d = this.boatNext + (this.boatLead > 0 ? BOAT_HALF_L - z : z + BOAT_HALF_L);
    if (d < 0) return d > -BRIDGE_LEN ? 0 : Infinity;
    return d / Math.max(0.4, this.boatSpeed);
  }

  /** Boat: a spot on the rear deck (bow deck when much closer) to shelter from a bridge. */
  shelterPoint(p: THREE.Vector3, out: THREE.Vector3, jitter: number): THREE.Vector3 | null {
    if (!this.boatFrame) return null;
    const l = this.boatFrame.toLocal(p, this.v);
    const bow = l.z > 6.2;
    if (bow) return this.boatFrame.toWorld(jitter * 0.3, BOAT_DECK + 0.2, 8.0, out);
    return this.boatFrame.toWorld(jitter * 1.1, BOAT_DECK, -7.0 + jitter * 0.8, out);
  }

  // ================================================================ props
  private collectProps(): void {
    this.props.length = 0;
    const seen = new Set<number>();
    this.physics.world.forEachCollider((c: ColliderLike) => {
      const member = c.collisionGroups() >>> 16;
      if (!(member & GROUP.PROP) || member & GROUP.BEAST) return;
      const b = c.parent();
      if (!b || !b.isDynamic() || seen.has(b.handle)) return;
      const t = b.translation();
      if (Math.hypot(t.x - this.centre.x, t.z - this.centre.z) > 25) return;
      if (b.mass() > 60) return;
      seen.add(b.handle);
      if (this.props.length < 32) this.props.push(b);
    });
  }

  /** World quaternion helper scratch (no allocations for callers). */
  scratchQuat(): THREE.Quaternion {
    return this.q;
  }
}

const senses = new WeakMap<Arena, ArenaSense>();

/** One shared ArenaSense per arena object. */
export function getSense(arena: Arena, physics: PhysicsWorld): ArenaSense {
  let s = senses.get(arena);
  if (!s || s.physics !== physics) {
    s = new ArenaSense(arena, physics);
    senses.set(arena, s);
    // build the grid now (round start / countdown) rather than on the first fighting frame;
    // retried from tick() when the physics had not been stepped yet
    s.ensureGrid(true);
  }
  return s;
}
