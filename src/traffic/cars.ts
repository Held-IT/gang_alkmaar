// AI cars: route following on right-hand lanes, IDM car following, curve speeds, junction
// reservations with priority roads / "rechts heeft voorrang", kinematic Rapier bodies.
//
// Each car follows a route of Paths (lane, connector, lane, ...). route[0] is the path it is on,
// `s` its arc length there. Path.occ lists the cars on a path front-first (IDM leaders). At a
// junction cluster the car registers as "approaching", and may only drive past the stop line once
// it holds a reservation (Cluster.inside) — see canEnter().
import * as THREE from 'three';
import type { PhysicsWorld } from '../contracts';
import { COLLISION_GROUPS } from '../physics/physics';
import type { Cluster, Network } from './network';
import { PATH_CONN, makeSample, type Path, type PathOccupant } from './paths';
import { AgentGrid, KIND_BIKE, KIND_CAR, KIND_PED, KIND_PLAYER } from './spatial';
import {
  CarRenderer, LIGHT_BRAKE, LIGHT_HEAD, LIGHT_IND_L, LIGHT_IND_R, LIGHT_RUNNING, TRAFFIC_MIX, composeCarMatrix, pickPaint,
} from './carRender';
import { pickWeighted } from './rng';

const BOX_MAX = 64;
/** Relative car spawn weight per metre of road by OSM class. */
const CAR_W: Record<string, number> = { primary: 3, secondary: 2.6, tertiary: 2, unclassified: 1.2, residential: 1, living_street: 0.4, service: 0.3 };
const CONFLICT_DIST = 2.9;
const APPROACH_DIST = 45;
const LOOKAHEAD = 70;
/** LOD1 below LOD_NEAR m from the camera, LOD2 beyond LOD_FAR (hysteresis band in between). */
export const LOD_NEAR = 25;
export const LOD_FAR = 30;

export interface PlayerState {
  present: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  /** body forward axis (unit, xz) */
  fx: number;
  fz: number;
}

/** A junction-box reservation held by a car (copied from its approach data on grant). */
export class Reservation {
  cl: Cluster | null = null;
  approachPath: Path | null = null;
  exit: Path | null = null;
  readonly pts = new Float32Array(BOX_MAX * 2);
  readonly s = new Float32Array(BOX_MAX);
  n = 0;
  /** distance driven since the stop line */
  progress = 0;
}

export class Car implements PathOccupant {
  readonly id: number;
  specIdx = 0;
  readonly color = new THREE.Color();
  halfLen = 2.2;
  halfW = 0.9;
  height = 1.5;
  wheelRadius = 0.32;
  wheelbase = 2.6;
  route: Path[] = [];
  s = 0;
  hint = 0;
  v = 0;
  acc = 0;
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  pitch = 0;
  dirX = 0;
  dirZ = 1;
  steer = 0;
  spin = 0;
  lod: 1 | 2 = 2;
  // driver
  vFactor = 1;
  T = 1.3;
  aMax = 1.6;
  bComf = 2.2;
  s0 = 2.2;
  // junction
  approach: Cluster | null = null;
  approachPath: Path | null = null;
  exitPath: Path | null = null;
  distToBox = 1e9;
  boxDirX = 0;
  boxDirZ = 1;
  boxPX = 0;
  boxPZ = 0;
  boxTurn = 0;
  approachRank = 0;
  readonly boxPts = new Float32Array(BOX_MAX * 2);
  readonly boxS = new Float32Array(BOX_MAX);
  boxN = 0;
  /** junction reservations held (pooled; the first resN are active) */
  readonly res: Reservation[] = [new Reservation(), new Reservation(), new Reservation()];
  resN = 0;
  waitT = 0;
  // state
  stunT = 0;
  stuckT = 0;
  ignoreT = 0;
  /** seconds before this car may ask for a junction reservation again */
  holdOff = 0;
  lights = LIGHT_RUNNING;
  indicator = 0;
  blink = 0;
  terminal = false;
  visible = false;
  body: any = null;
  collider: any = null;
  unsubContact: (() => void) | null = null;
  hitFlag = false;
  // diagnostics
  gap = 1e9;
  leadKind = -1;
  leadRef = -1;
  born = 0;

  constructor(id: number) {
    this.id = id;
  }

  resFor(cl: Cluster): Reservation | null {
    for (let i = 0; i < this.resN; i++) if (this.res[i].cl === cl) return this.res[i];
    return null;
  }

  resForId(id: number): Reservation | null {
    for (let i = 0; i < this.resN; i++) if (this.res[i].cl!.id === id) return this.res[i];
    return null;
  }

  /** first held reservation (diagnostics) */
  get granted(): Cluster | null {
    return this.resN > 0 ? this.res[0].cl : null;
  }
}

export interface CarSimOptions {
  maxCars: number;
  spawnMin: number;
  spawnMax: number;
  despawnR: number;
  headlights: boolean;
}

const tmpS = makeSample();
const tmpS2 = makeSample();
const qIdx = new Int32Array(256);
const dirTmp = [0, 0];
const dirTmp2 = [0, 0];
const matTmp = new Float32Array(16);
const vec3Tmp = { x: 0, y: 0, z: 0 };
const quatTmp = { x: 0, y: 0, z: 0, w: 1 };

export class CarSim {
  readonly cars: Car[] = [];
  private readonly carById = new Map<number, Car>();
  private nextId = 1;
  private readonly specCum: number[] = [];
  private readonly specIds: string[];
  private ringIdx = new Int32Array(4096);
  private ringCum = new Float32Array(4096);
  private ringN = 0;
  private ringX = 1e9;
  private ringZ = 1e9;
  private ringT = 0;
  private initialized = false;
  target = 0;
  time = 0;
  // stats
  spawned = 0;
  despawned = 0;
  stuckDespawns = 0;
  forcedGrants = 0;
  mutualBreaks = 0;
  updateMs = 0;

  constructor(
    private readonly net: Network,
    private readonly renderer: CarRenderer,
    private readonly physics: PhysicsWorld | null,
    private readonly rng: () => number,
    readonly opts: CarSimOptions,
  ) {
    this.specIds = renderer.specs.map((s) => s.id);
    let acc = 0;
    for (const id of this.specIds) {
      acc += TRAFFIC_MIX.find((m) => m.id === id)?.w ?? 1;
      this.specCum.push(acc);
    }
  }

  setDensity(d: number): void {
    this.target = Math.round(this.opts.maxCars * Math.max(0, Math.min(1, d)));
  }

  // ============================================================================ per frame

  update(dt: number, fx: number, fz: number, grid: AgentGrid, player: PlayerState): void {
    const t0 = performance.now();
    this.time += dt;
    for (let i = 0; i < this.cars.length; i++) this.stepCar(this.cars[i], dt, grid, player);
    this.manage(fx, fz, grid, player);
    this.updateMs = performance.now() - t0;
  }

  /** Adds all cars to the spatial grid (call before any agent update). */
  fillGrid(grid: AgentGrid): void {
    for (const c of this.cars) grid.add(KIND_CAR, c.id, c.x, c.z, c.dirX, c.dirZ, c.v, c.halfLen, c.halfW);
  }

  /** Pushes visible cars to the instanced renderer. */
  render(): void {
    const r = this.renderer;
    const cam = r.camPos;
    for (const c of this.cars) {
      c.visible = r.visible(c.x, c.y + 0.8, c.z, c.halfLen + 1.8);
      if (!c.visible) continue;
      const d = Math.hypot(c.x - cam.x, c.z - cam.z, c.y - cam.y);
      c.lod = c.lod === 1 ? (d > LOD_FAR ? 2 : 1) : d < LOD_NEAR ? 1 : 2;
      composeCarMatrix(matTmp, 0, c.x, c.y, c.z, c.heading, c.pitch);
      let lights = c.lights;
      if (this.opts.headlights) lights |= LIGHT_HEAD;
      r.push(c.specIdx, c.lod, matTmp, 0, c.color, lights, c.steer, c.spin);
    }
  }

  // ============================================================================ driving

  private stepCar(c: Car, dt: number, grid: AgentGrid, player: PlayerState): void {
    if (c.terminal && c.route.length === 0) return;
    this.planRoute(c);
    let stopDist = 1e9;
    // ---------------------------------------------------------------- junction reservation
    const boxIdx = this.nextBoxIndex(c);
    // (the route may shift while advancing below: keep the Path, not the index)
    const boxPath = boxIdx > 0 ? c.route[boxIdx] : null;
    if (boxIdx > 0) {
      const box = c.route[boxIdx];
      const cl = this.net.clusters[box.cluster];
      let d = c.route[0].len - c.s;
      for (let k = 1; k < boxIdx; k++) d += c.route[k].len;
      c.distToBox = d;
      if (!c.resFor(cl)) {
        if (c.approach !== cl && d < APPROACH_DIST) this.registerApproach(c, cl, boxIdx);
        if (c.approach === cl) {
          const decide = Math.max(6, (c.v * c.v) / (2 * 3) + 4);
          if (d < decide) {
            if (c.holdOff <= 0 && this.canEnter(c, cl, player)) this.grant(c, cl);
            else stopDist = d;
          }
        }
      }
    } else {
      c.distToBox = 1e9;
    }
    for (let r = 0; r < c.resN; r++) c.res[r].progress += c.v * dt;
    // a car that got a reservation but is held up before the stop line (walker, queue) gives it
    // back so the junction is not blocked, and re-applies a bit later
    if (c.holdOff > 0) c.holdOff -= dt;
    for (let r = c.resN - 1; r >= 0; r--) {
      const rr = c.res[r];
      if (rr.progress < -0.5 && c.v < 0.3 && c.waitT > 2.5) {
        this.release(c, rr);
        c.holdOff = 1.5;
      }
    }

    // ---------------------------------------------------------------- free speed (limit + curves)
    const r0 = c.route[0];
    let vDes = r0.speed * c.vFactor;
    {
      let d = -c.s;
      const reach = (c.v * c.v) / (2 * c.bComf) + 12;
      for (let k = 0; k < c.route.length && d < reach; k++) {
        const p = c.route[k];
        if (k > 0) vDes = Math.min(vDes, Math.sqrt(p.speed * p.speed * c.vFactor * c.vFactor + 2 * c.bComf * Math.max(0, d)));
        if (p.vmin < 30) {
          const cum = p.cum;
          for (let i = 0; i < p.n; i++) {
            const di = d + cum[i];
            if (di < -1) continue;
            if (di > reach) break;
            const vm = p.vmax[i];
            if (vm < 30) vDes = Math.min(vDes, Math.sqrt(vm * vm + 2 * c.bComf * Math.max(0, di)));
          }
        }
        d += p.len;
      }
      if (c.terminal) {
        // route ends (dead end): stop at the end
        stopDist = Math.min(stopDist, d - 1);
      }
    }

    // ---------------------------------------------------------------- leader
    let gap = 1e9;
    let leadV = 0;
    let leadKind = -1;
    let leadRef = -1;
    {
      const occ = r0.occ;
      const idx = occ.indexOf(c);
      if (idx > 0) {
        const L = occ[idx - 1];
        gap = L.s - c.s - L.halfLen - c.halfLen;
        leadV = L.v;
        leadKind = KIND_CAR;
        leadRef = (L as Car).id;
      } else {
        let d = r0.len - c.s;
        for (let k = 1; k < c.route.length && d < LOOKAHEAD; k++) {
          const P = c.route[k];
          if (P.occ.length > 0) {
            const L = P.occ[P.occ.length - 1];
            const g = d + L.s - L.halfLen - c.halfLen;
            if (g < gap) {
              gap = g;
              leadV = L.v;
              leadKind = KIND_CAR;
              leadRef = (L as Car).id;
            }
            break;
          }
          d += P.len;
        }
        // cars from my lane that took another connector at the junction ahead are still in front
        let jc: Cluster | null = c.approach && c.approachPath === r0 ? c.approach : null;
        for (let r = 0; r < c.resN && !jc; r++) if (c.res[r].approachPath === r0) jc = c.res[r].cl;
        if (jc && jc.inside.length > 0) {
          const base = r0.len - c.s;
          for (const o of jc.inside) {
            if (o === c || o.resFor(jc)?.approachPath !== r0 || o.route.length === 0) continue;
            const or0 = o.route[0];
            if (or0.kind !== PATH_CONN || or0.inPath !== r0) continue;
            const g = base + o.s - o.halfLen - c.halfLen;
            if (g < gap) {
              gap = g;
              leadV = o.v;
              leadKind = KIND_CAR;
              leadRef = o.id;
            }
          }
        }
      }
    }
    // ---------------------------------------------------------------- obstacles in front (cone)
    if (c.ignoreT > 0) c.ignoreT -= dt;
    {
      const range = Math.min(22, Math.max(7, 5 + c.v * 1.7));
      const qx = c.x + c.dirX * range * 0.5;
      const qz = c.z + c.dirZ * range * 0.5;
      const n = grid.query(qx, qz, range * 0.5 + 2.5, qIdx);
      const rx = -c.dirZ;
      const rz = c.dirX;
      for (let k = 0; k < n; k++) {
        const j = qIdx[k];
        const kind = grid.kind[j];
        if (kind === KIND_CAR && grid.ref[j] === c.id) continue;
        const ox = grid.x[j] - c.x;
        const oz = grid.z[j] - c.z;
        const along = ox * c.dirX + oz * c.dirZ;
        if (along <= 0) continue;
        const odx = grid.dx[j];
        const odz = grid.dz[j];
        const cosH = odx * c.dirX + odz * c.dirZ;
        if (kind === KIND_CAR) {
          if (cosH < -0.5 || c.ignoreT > 0) continue;
        }
        const ohl = grid.halfLen[j];
        const ohw = grid.halfW[j];
        const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
        const extAlong = ohl * Math.abs(cosH) + ohw * sinH;
        const extLat = ohl * sinH + ohw * Math.abs(cosH);
        if (along - extAlong > range) continue;
        const lat = Math.abs(ox * rx + oz * rz);
        // walkers moving parallel beside the lane (sidewalk) only count when directly in the path
        const margin = kind === KIND_PED ? (Math.abs(cosH) > 0.75 ? -0.15 : 0.45) : kind === KIND_PLAYER ? 0.5 : kind === KIND_BIKE ? 0.15 : 0.2;
        if (lat > c.halfW + extLat + margin) continue;
        const g = along - c.halfLen - extAlong;
        if (g < gap) {
          gap = g;
          leadV = Math.max(0, grid.v[j] * cosH);
          leadKind = kind;
          leadRef = grid.ref[j];
        }
      }
    }
    // ---------------------------------------------------------------- stop line as a virtual leader
    if (stopDist < 1e8) {
      const g = stopDist - c.halfLen + (c.s0 - 1.0);
      if (g < gap) {
        gap = g;
        leadV = 0;
        leadKind = 9;
      }
    }
    c.gap = gap;
    c.leadKind = leadKind;
    c.leadRef = leadRef;

    // ---------------------------------------------------------------- IDM
    let acc: number;
    if (c.stunT > 0) {
      c.stunT -= dt;
      acc = -6;
      if (c.stunT <= 0) c.stunT = 0;
    } else {
      const v = c.v;
      const v0 = Math.max(0.5, vDes);
      const ratio = v / v0;
      let a = c.aMax * (1 - ratio * ratio * ratio * ratio);
      if (gap < 1e8) {
        const sStar = c.s0 + Math.max(0, v * c.T + (v * (v - leadV)) / (2 * Math.sqrt(c.aMax * c.bComf)));
        const q = sStar / Math.max(gap, 0.05);
        a -= c.aMax * q * q;
      }
      acc = Math.max(-7.5, Math.min(c.aMax, a));
      if (gap < 0.25 && leadV < 0.5) {
        acc = -9;
        c.v = Math.min(c.v, Math.max(0, gap) * 2);
      }
    }
    c.acc = acc;
    c.v = Math.max(0, c.v + acc * dt);
    const ds = c.v * dt;
    c.s += ds;

    // ---------------------------------------------------------------- waiting / stuck bookkeeping
    if (c.v < 0.3) {
      c.waitT += dt;
      c.stuckT += dt;
    } else {
      c.waitT = 0;
      if (c.v > 1.0) c.stuckT = 0;
    }
    // mutual blocking (each is the other's leader): the newer car gives way by ignoring cars briefly
    if (c.waitT > 4 && leadKind === KIND_CAR && c.ignoreT <= 0) {
      const o = this.byId(leadRef);
      if (o && o.leadKind === KIND_CAR && o.leadRef === c.id && o.waitT > 4 && c.id > o.id) {
        c.ignoreT = 2.5;
        this.mutualBreaks++;
      }
    }
    if (c.stuckT > 30 && c.ignoreT <= 0 && leadKind === KIND_CAR) {
      // gridlock breaker: ignore other AI cars in the cone for a moment
      c.ignoreT = 3;
      c.stuckT = 20;
    }

    // ---------------------------------------------------------------- advance along the route
    while (c.route.length > 0 && c.s >= c.route[0].len) {
      if (c.route.length === 1) {
        c.s = c.route[0].len;
        c.v = 0;
        c.terminal = true;
        break;
      }
      const p = c.route[0];
      c.s -= p.len;
      removeOcc(p, c);
      c.route.shift();
      c.hint = 0;
      for (let r = c.resN - 1; r >= 0; r--) if (c.res[r].exit === p) this.release(c, c.res[r]);
      const np = c.route[0];
      np.occ.push(c); // entering at the start: rearmost
      if (np.kind === PATH_CONN && np.cluster >= 0 && !c.resForId(np.cluster)) {
        // drove into a box without a reservation (late decision or spawn): take it now
        const cl = this.net.clusters[np.cluster];
        if (c.approach !== cl) this.registerApproach(c, cl, 0);
        if (c.approach === cl) {
          this.grant(c, cl);
          this.forcedGrants++;
        }
      }
    }
    for (let r = c.resN - 1; r >= 0; r--) if (c.route[0] === c.res[r].exit && c.s > c.halfLen * 2 + 1) this.release(c, c.res[r]);

    // ---------------------------------------------------------------- pose
    const p = c.route[0];
    p.sample(c.s, tmpS, c.hint);
    c.hint = tmpS.i;
    const target = Math.atan2(tmpS.tx, tmpS.tz);
    let dh = target - c.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const k = 1 - Math.exp(-ds / 1.6);
    const turnStep = dh * k;
    c.heading += turnStep;
    c.dirX = Math.sin(c.heading);
    c.dirZ = Math.cos(c.heading);
    const curv = ds > 1e-4 ? turnStep / ds : 0;
    const steerT = Math.max(-0.6, Math.min(0.6, Math.atan(c.wheelbase * curv)));
    c.steer += (steerT - c.steer) * Math.min(1, dt * 8);
    c.x = tmpS.x;
    c.z = tmpS.z;
    const hb = c.wheelbase * 0.5;
    const yF = p.heightAt(c.s + hb);
    const yB = p.heightAt(c.s - hb);
    c.y = (yF + yB) * 0.5;
    c.pitch = Math.atan2(yF - yB, c.wheelbase);
    c.spin = (c.spin + ds / c.wheelRadius) % (Math.PI * 2);

    // ---------------------------------------------------------------- lights
    let lights = LIGHT_RUNNING;
    if (c.acc < -0.9 || c.v < 0.4) lights |= LIGHT_BRAKE;
    c.blink += dt;
    const blinkOn = c.blink % 0.8 < 0.42;
    if (c.stunT > 0 || c.stuckT > 12) {
      if (blinkOn) lights |= LIGHT_IND_L | LIGHT_IND_R;
    } else {
      let turn = 0;
      if (boxPath && c.distToBox < 32) turn = boxPath.turn;
      else if (c.route[0].kind === PATH_CONN) turn = c.route[0].turn;
      if (turn === 2) turn = -1;
      if (turn !== 0 && blinkOn) lights |= turn < 0 ? LIGHT_IND_L : LIGHT_IND_R;
    }
    c.lights = lights;

    // ---------------------------------------------------------------- physics body
    if (c.body) {
      vec3Tmp.x = c.x;
      vec3Tmp.y = c.y;
      vec3Tmp.z = c.z;
      c.body.setNextKinematicTranslation(vec3Tmp);
      const hy = c.heading * 0.5;
      const hx = -c.pitch * 0.5;
      const cy = Math.cos(hy), sy = Math.sin(hy), cx = Math.cos(hx), sx = Math.sin(hx);
      quatTmp.x = cy * sx;
      quatTmp.y = cx * sy;
      quatTmp.z = -sy * sx;
      quatTmp.w = cy * cx;
      c.body.setNextKinematicRotation(quatTmp);
    }
    // ---------------------------------------------------------------- hit by the player
    if (player.present) {
      const ox = player.x - c.x;
      const oz = player.z - c.z;
      if (ox * ox + oz * oz < 49) {
        const al = Math.abs(ox * c.dirX + oz * c.dirZ);
        const la = Math.abs(-ox * c.dirZ + oz * c.dirX);
        // player car approx. 2.2 x 0.9 half extents, oriented arbitrarily: use a generous radius
        if (al < c.halfLen + 1.4 && la < c.halfW + 1.0 && player.speed > 0.8) c.hitFlag = true;
      }
    }
    if (c.hitFlag) {
      c.hitFlag = false;
      if (c.stunT <= 0) c.stunT = 3 + this.rng() * 2.5;
    }
  }

  private byId(id: number): Car | null {
    return this.carById.get(id) ?? null;
  }

  /** True when AI car carId is standing still waiting for agent (kind, id) (a walker/cyclist). */
  waitsFor(carId: number, kind: number, id: number): boolean {
    const c = this.carById.get(carId);
    return !!c && c.v < 0.6 && c.leadKind === kind && c.leadRef === id;
  }

  /** Index in c.route of the first connector of a junction box the car has no reservation for. */
  private nextBoxIndex(c: Car): number {
    for (let k = 1; k < c.route.length; k++) {
      const p = c.route[k];
      if (p.kind === PATH_CONN && p.cluster >= 0) {
        if (c.resForId(p.cluster)) continue;
        return k;
      }
    }
    return -1;
  }

  /** Extends the route so it covers the lookahead and every junction box is complete. */
  private planRoute(c: Car): void {
    if (c.terminal) return;
    let guard = 0;
    for (;;) {
      if (guard++ > 8) return;
      const last = c.route[c.route.length - 1];
      let ahead = -c.s;
      for (const p of c.route) ahead += p.len;
      if (ahead > LOOKAHEAD && !last.internal) return;
      if (!this.appendNext(c)) {
        c.terminal = true;
        return;
      }
    }
  }

  private appendNext(c: Car): boolean {
    const net = this.net;
    const last = c.route[c.route.length - 1];
    const node = last.endNode;
    const nd = net.nodes[node];
    // arrival direction = reverse of the edge's leave direction at this node
    net.leaveDir(last.edge, node, dirTmp);
    const inX = -dirTmp[0];
    const inZ = -dirTmp[1];
    let total = 0;
    let choice = -1;
    let choiceDir = 0;
    // two passes: sum weights, then pick
    const u = this.rng();
    for (let pass = 0; pass < 2; pass++) {
      let acc = 0;
      for (const f of nd.car) {
        if (f === last.edge) continue;
        const dir = net.carDirFrom(f, node);
        if (dir < 0) continue;
        // avoid looping inside a junction box: do not go back to the node we came from
        const other = net.otherNode(f, node);
        if (last.internal && other === last.startNode) continue;
        net.leaveDir(f, node, dirTmp2);
        const straight = inX * dirTmp2[0] + inZ * dirTmp2[1];
        let w = 0.3 + Math.max(0, straight) * 1.4 + net.rank(f) * 0.25;
        if (net.nodes[other].car.length === 1) w *= 0.08; // dead end / map edge
        if (straight < -0.6) w *= 0.15; // very sharp turn back
        if (pass === 0) total += w;
        else {
          acc += w;
          if (acc >= u * total) {
            choice = f;
            choiceDir = dir;
            break;
          }
        }
      }
      if (total <= 0) break;
    }
    let next: Path;
    if (choice < 0) {
      // dead end: U-turn when the road is two-way
      const back = net.carDirFrom(last.edge, node);
      if (back < 0) return false;
      next = net.carLane(last.edge, back, 0);
    } else {
      const lanes = net.laneCount(choice);
      let lane = 0;
      if (lanes > 1) {
        net.leaveDir(choice, node, dirTmp2);
        const cross = inX * dirTmp2[1] - inZ * dirTmp2[0];
        const dot = inX * dirTmp2[0] + inZ * dirTmp2[1];
        if (dot > 0.75) lane = Math.floor(this.rng() * lanes);
        else lane = cross > 0 ? lanes - 1 : 0; // right turn -> rightmost lane
      }
      next = net.carLane(choice, choiceDir, lane);
    }
    if (next.len < 0.05) return false;
    const conn = net.carConnector(last, next);
    c.route.push(conn, next);
    return true;
  }

  private registerApproach(c: Car, cl: Cluster, boxIdx: number): void {
    if (c.approach) this.unregisterApproach(c);
    // make sure the box (connectors + internal lanes) and its exit lane are planned
    let j = boxIdx;
    while (j < c.route.length && (c.route[j].kind === PATH_CONN || c.route[j].internal)) j++;
    if (j >= c.route.length) return; // route incomplete (dead end inside the box): try again later
    const inLane = boxIdx > 0 ? c.route[boxIdx - 1] : c.route[0].inPath ?? c.route[0];
    const exit = c.route[j];
    c.approach = cl;
    c.approachPath = inLane;
    c.exitPath = exit;
    c.approachRank = inLane.rank;
    inLane.sample(inLane.len, tmpS, inLane.n - 2);
    c.boxPX = tmpS.x;
    c.boxPZ = tmpS.z;
    c.boxDirX = tmpS.tx;
    c.boxDirZ = tmpS.tz;
    exit.sample(0, tmpS2, 0);
    const dot = c.boxDirX * tmpS2.tx + c.boxDirZ * tmpS2.tz;
    const cross = c.boxDirX * tmpS2.tz - c.boxDirZ * tmpS2.tx;
    c.boxTurn = dot < -0.8 ? 2 : dot > 0.7 ? 0 : cross > 0 ? 1 : -1;
    // sample the box path
    let n = 0;
    let acc = 0;
    for (let k = boxIdx; k <= j && n < BOX_MAX; k++) {
      const p = c.route[k];
      const len = k === j ? Math.min(p.len, c.halfLen * 2 + 1) : p.len;
      const steps = Math.max(1, Math.ceil(len / 1.5));
      for (let q = k === boxIdx ? 0 : 1; q <= steps && n < BOX_MAX; q++) {
        const s = (q / steps) * len;
        p.sample(s, tmpS, tmpS.i);
        c.boxPts[n * 2] = tmpS.x;
        c.boxPts[n * 2 + 1] = tmpS.z;
        c.boxS[n] = acc + s;
        n++;
      }
      acc += p.len;
    }
    c.boxN = n;
    cl.approaching.push(c);
  }

  private unregisterApproach(c: Car): void {
    if (!c.approach) return;
    removeFrom(c.approach.approaching, c);
    c.approach = null;
  }

  private grant(c: Car, cl: Cluster): void {
    removeFrom(cl.approaching, c);
    if (c.resFor(cl)) return;
    if (c.resN === c.res.length) this.release(c, c.res[0]); // pool full: drop the oldest
    if (cl.inside.indexOf(c) < 0) cl.inside.push(c);
    const r = c.res[c.resN++];
    r.cl = cl;
    r.approachPath = c.approachPath;
    r.exit = c.exitPath;
    r.pts.set(c.boxPts);
    r.s.set(c.boxS);
    r.n = c.boxN;
    r.progress = c.route[0].kind === PATH_CONN && c.route[0].cluster === cl.id ? c.s : -c.distToBox;
    c.approach = null;
    c.approachPath = null;
    c.exitPath = null;
    c.waitT = 0;
  }

  private release(c: Car, r: Reservation): void {
    const i = c.res.indexOf(r);
    if (i < 0 || i >= c.resN) return;
    if (r.cl) removeFrom(r.cl.inside, c);
    r.cl = null;
    r.approachPath = null;
    r.exit = null;
    r.n = 0;
    // keep active reservations packed at the front of the pool
    c.res.splice(i, 1);
    c.res.push(r);
    c.resN--;
  }

  /** Do the junction paths of a (approach data) and b (reservation or approach data) come close? */
  private conflict(a: Car, b: Car, bRes: Reservation | null): boolean {
    const bPts = bRes ? bRes.pts : b.boxPts;
    const bS = bRes ? bRes.s : b.boxS;
    const bN = bRes ? bRes.n : b.boxN;
    const bFrom = bRes ? bRes.progress - b.halfLen - 1.5 : -1e9;
    const d2 = CONFLICT_DIST * CONFLICT_DIST;
    for (let i = 0; i < a.boxN; i++) {
      const ax = a.boxPts[i * 2];
      const az = a.boxPts[i * 2 + 1];
      for (let j = 0; j < bN; j++) {
        if (bS[j] < bFrom) continue;
        const dx = bPts[j * 2] - ax;
        const dz = bPts[j * 2 + 1] - az;
        if (dx * dx + dz * dz < d2) return true;
      }
    }
    return false;
  }

  /** True when `o` has right of way over `c` (both approaching the same junction). */
  private hasPriority(o: Car, c: Car): boolean {
    if (o.approachRank !== c.approachRank) return o.approachRank > c.approachRank;
    const dd = o.boxDirX * c.boxDirX + o.boxDirZ * c.boxDirZ;
    if (dd < -0.6) return c.boxTurn === -1 && o.boxTurn !== -1; // left turn yields to oncoming
    if (dd > 0.6) return false;
    const rx = -c.boxDirZ;
    const rz = c.boxDirX;
    return (o.boxPX - c.boxPX) * rx + (o.boxPZ - c.boxPZ) * rz > 0; // o comes from the right
  }

  private canEnter(c: Car, cl: Cluster, player: PlayerState): boolean {
    for (const o of cl.inside) {
      const r = o.resFor(cl);
      if (o === c || !r || r.approachPath === c.approachPath) continue;
      if (this.conflict(c, o, r)) return false;
    }
    if (!this.exitHasSpace(c, cl)) return false;
    for (const o of cl.approaching) {
      if (o === c || o.approachPath === c.approachPath) continue;
      if (o.distToBox > Math.max(6, o.v * 3.2)) continue;
      if (!this.hasPriority(o, c)) continue;
      // deadlock breaker: the longest waiting car goes first
      if (o.v < 0.5 && c.waitT > 2 && (o.waitT < c.waitT - 0.25 || (Math.abs(o.waitT - c.waitT) <= 0.25 && c.id < o.id))) continue;
      if (o.v < 0.3 && o.waitT > 9) continue;
      if (!this.conflict(c, o, null)) continue;
      return false;
    }
    if (player.present) {
      const px = player.x - cl.x;
      const pz = player.z - cl.z;
      const dist = Math.hypot(px, pz);
      const behind = (player.x - c.x) * c.dirX + (player.z - c.z) * c.dirZ < 0;
      if (!behind) {
        if (dist < cl.radius + 1) return false;
        if (dist < cl.radius + 14 && player.speed > 1.5 && player.vx * -px + player.vz * -pz > 0) return false;
      }
    }
    return true;
  }

  private exitHasSpace(c: Car, cl: Cluster): boolean {
    const exit = c.exitPath;
    if (!exit) return true;
    const need = c.halfLen * 2 + 1.5;
    let free = 1e9;
    let d = 0;
    let started = false;
    for (let k = 0; k < c.route.length; k++) {
      const p = c.route[k];
      if (!started) {
        if (p !== exit) continue;
        started = true;
      }
      if (p.occ.length > 0) {
        const L = p.occ[p.occ.length - 1];
        free = d + L.s - L.halfLen;
        break;
      }
      d += p.len;
      if (d > need + 8) break;
    }
    for (const o of cl.inside) if (o !== c && o.resFor(cl)?.exit === exit) free -= o.halfLen * 2 + 1.5;
    return free > need;
  }

  // ============================================================================ spawning

  private manage(fx: number, fz: number, grid: AgentGrid, player: PlayerState): void {
    const o = this.opts;
    // despawn
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const d = Math.hypot(c.x - fx, c.z - fz);
      const hidden = !c.visible || d > 150;
      const far = d > o.despawnR + 100 || (d > o.despawnR && !c.visible);
      const stuck = c.stuckT > 25 && hidden;
      let ended = false;
      if (c.terminal && c.v < 0.2) {
        let rem = -c.s;
        for (const p of c.route) rem += p.len;
        ended = rem < c.halfLen + 4 && (hidden || c.stuckT > 6);
      }
      const surplus = this.cars.length > this.target && !c.visible;
      if (far || stuck || ended || surplus) {
        if (stuck) this.stuckDespawns++;
        this.remove(i);
      }
    }
    // spawn ring candidates
    this.ringT -= 1;
    if (this.ringT <= 0 || Math.hypot(fx - this.ringX, fz - this.ringZ) > 25) {
      this.ringN = this.net.collectRing(this.net.carEdges, fx, fz, this.initialized ? o.spawnMin : 8, o.spawnMax, this.ringIdx, this.ringCum, (e) => {
        // busier main roads; more cars near the focus than at the far edge of the ring
        const p = e.pts[e.pts.length >> 1];
        const d = Math.hypot(p[0] - fx, p[1] - fz);
        return (CAR_W[e.type] ?? 0.6) / (1 + d / 90);
      });
      this.ringX = fx;
      this.ringZ = fz;
      this.ringT = 60;
    }
    if (this.ringN === 0) return;
    const initial = !this.initialized;
    let budget = initial ? this.target * 6 : 3;
    while (this.cars.length < this.target && budget-- > 0) this.trySpawn(fx, fz, grid, player, initial);
    if (initial) {
      this.initialized = true;
      this.ringT = 0;
    }
  }

  private trySpawn(fx: number, fz: number, grid: AgentGrid, player: PlayerState, initial: boolean): boolean {
    const net = this.net;
    const ei = this.ringIdx[pickWeighted(this.ringCum.subarray(0, this.ringN), this.rng())];
    const e = net.edges[ei];
    const dirs = e.oneway ? 1 : 2;
    const dir = Math.floor(this.rng() * dirs);
    const lane = Math.floor(this.rng() * net.laneCount(ei));
    const path = net.carLane(ei, dir, lane);
    if (path.len < 9 || path.internal) return false;
    const s = 3 + this.rng() * (path.len - 6);
    path.sample(s, tmpS, 0);
    const d = Math.hypot(tmpS.x - fx, tmpS.z - fz);
    const rMin = initial ? 8 : this.opts.spawnMin;
    if (d < rMin || d > this.opts.spawnMax) return false;
    if (!initial && d < 160 && this.renderer.visible(tmpS.x, 1, tmpS.z, 3)) return false;
    if (player.present && Math.hypot(player.x - tmpS.x, player.z - tmpS.z) < 25) return false;
    // free space on the lane and around
    for (const o of path.occ) if (Math.abs(o.s - s) < 14) return false;
    for (const c of this.cars) {
      const dx = c.x - tmpS.x;
      const dz = c.z - tmpS.z;
      if (dx * dx + dz * dz < 100) return false;
    }
    const n = grid.query(tmpS.x, tmpS.z, 6, qIdx);
    for (let k = 0; k < n; k++) {
      const j = qIdx[k];
      if (Math.hypot(grid.x[j] - tmpS.x, grid.z[j] - tmpS.z) < 6) return false;
    }
    const c = new Car(this.nextId++);
    const si = pickWeighted(this.specCum, this.rng());
    const spec = this.renderer.specs[si];
    c.specIdx = si;
    pickPaint(spec.id, this.rng(), c.color);
    c.halfLen = spec.length * 0.5;
    c.halfW = spec.width * 0.5;
    c.height = spec.height;
    c.wheelRadius = spec.wheelRadius;
    c.wheelbase = spec.wheelbase;
    const van = spec.id === 'bestelbus';
    c.vFactor = 0.88 + this.rng() * 0.2;
    c.T = 1.1 + this.rng() * 0.6;
    c.aMax = (van ? 1.2 : 1.5) + this.rng() * 0.6;
    c.bComf = 2.0 + this.rng() * 0.8;
    c.s0 = 1.8 + this.rng() * 0.8;
    c.route.push(path);
    c.s = s;
    c.hint = tmpS.i;
    c.x = tmpS.x;
    c.z = tmpS.z;
    c.heading = Math.atan2(tmpS.tx, tmpS.tz);
    c.dirX = tmpS.tx;
    c.dirZ = tmpS.tz;
    c.y = path.heightAt(s);
    c.v = path.speed * 0.6;
    c.blink = this.rng();
    c.born = this.time;
    // insert in occupancy keeping front-first order
    let at = 0;
    while (at < path.occ.length && path.occ[at].s > s) at++;
    path.occ.splice(at, 0, c);
    this.planRoute(c);
    this.createBody(c);
    this.cars.push(c);
    this.carById.set(c.id, c);
    this.spawned++;
    return true;
  }

  private createBody(c: Car): void {
    const ph = this.physics;
    if (!ph || !ph.RAPIER || !ph.world) return;
    try {
      const R = ph.RAPIER;
      const bd = R.RigidBodyDesc.kinematicPositionBased().setTranslation(c.x, c.y, c.z);
      const body = ph.world.createRigidBody(bd);
      const hh = (c.height - 0.25) * 0.5;
      const cd = R.ColliderDesc.cuboid(c.halfW * 0.97, hh, c.halfLen * 0.97)
        .setTranslation(0, 0.25 + hh, 0)
        .setCollisionGroups(COLLISION_GROUPS.traffic)
        .setFriction(0.6);
      if (R.ActiveEvents) cd.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(6000);
      const col = ph.world.createCollider(cd, body);
      c.body = body;
      c.collider = col;
      const ext = ph as PhysicsWorld & { onContactForce?: (h: number, fn: (o: number, f: number) => void) => () => void; setTag?: (h: number, t: string) => void };
      ext.setTag?.(col.handle, 'traffic');
      if (ext.onContactForce) c.unsubContact = ext.onContactForce(col.handle, () => (c.hitFlag = true));
    } catch (e) {
      console.warn('[traffic] could not create car body', e);
      c.body = null;
    }
  }

  private remove(i: number): void {
    const c = this.cars[i];
    if (c.route.length > 0) removeOcc(c.route[0], c);
    this.unregisterApproach(c);
    while (c.resN > 0) this.release(c, c.res[0]);
    c.route.length = 0;
    if (c.unsubContact) c.unsubContact();
    if (c.body && this.physics?.world) {
      try {
        this.physics.world.removeRigidBody(c.body);
      } catch { /* already gone */ }
    }
    c.body = null;
    this.carById.delete(c.id);
    const last = this.cars.length - 1;
    if (i !== last) this.cars[i] = this.cars[last];
    this.cars.pop();
    this.despawned++;
  }

  clear(): void {
    for (let i = this.cars.length - 1; i >= 0; i--) this.remove(i);
  }

  /** Summary for diagnostics. */
  summary(): { cars: number; avgSpeed: number; stopped: number; stuck: number; inBox: number } {
    let sv = 0;
    let stopped = 0;
    let stuck = 0;
    let inBox = 0;
    for (const c of this.cars) {
      sv += c.v;
      if (c.v < 0.3) stopped++;
      if (c.stuckT > 15) stuck++;
      if (c.resN > 0) inBox++;
    }
    return { cars: this.cars.length, avgSpeed: this.cars.length ? sv / this.cars.length : 0, stopped, stuck, inBox };
  }
}

function removeFrom<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

function removeOcc(p: Path, c: Car): void {
  const i = p.occ.indexOf(c);
  if (i >= 0) p.occ.splice(i, 1);
}
