// Cyclists and pedestrians: path following on the road graph (cycle tracks / right road edge,
// sidewalks / footways / pedestrian streets), loose avoidance via the shared spatial hash, and
// instanced rendering of animated people and bikes (see humanMesh.ts).
import * as THREE from 'three';
import type { Network } from './network';
import { PATH_CONN, makeSample, type Path } from './paths';
import { AgentGrid, KIND_BIKE, KIND_CAR, KIND_PED, KIND_PLAYER } from './spatial';
import { pickWeighted } from './rng';
import {
  BIKE, BOTTOMS, FRAMES, SKINS, TIGHTS, TOPS, buildBikeGeometry, buildHumanGeometry, createBikeMaterials,
  createHumanMaterials, pickColor,
} from './humanMesh';
import type { PlayerState } from './cars';

export class Person {
  readonly id: number;
  readonly kind: number; // KIND_BIKE or KIND_PED
  route: Path[] = [];
  s = 0;
  hint = 0;
  v = 0;
  vDes = 1.3;
  lat = 0;
  latT = 0;
  /** lateral offset chosen for the current path (avoidance returns to it) */
  baseLat = 0;
  /** usable lateral range on the current path (facades) */
  latLo = -9;
  latHi = 9;
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  dirX = 0;
  dirZ = 1;
  roll = 0;
  phase = 0;
  crank = 0;
  wheel = 0;
  scale = 1;
  waitT = 0;
  ignoreT = 0;
  stuckT = 0;
  visible = false;
  terminal = false;
  /** showcase agents: stay in place, animate as if moving at vDes */
  pinned = false;
  /** pedestrians: time left standing still (window shopping, chatting) */
  pauseT = 0;
  /** walking around a standing car: keep the lateral detour for this long */
  avoidT = 0;
  /** diagnostics: what stopped us last */
  leadKind = -1;
  leadRef = -1;
  // ---- reaction to the player car: world-space offset from the path position (dodging, bumped)
  /** position on the path (x/z = path position + offset) */
  px = 0;
  pz = 0;
  offX = 0;
  offZ = 0;
  offVX = 0;
  offVZ = 0;
  /** target offset velocity of this step (escape) */
  tvX = 0;
  tvZ = 0;
  escaping = false;
  /** > 0: keep clear of the player car (stand aside, do not walk on) */
  dodgeT = 0;
  /** how long the threat has been seen (reaction delay) */
  alertT = 0;
  readonly reactDelay: number;
  /** chosen escape side (+1/-1 along the car's right axis), 0 = none */
  escSide = 0;
  /** stumble after a bump: time left / duration, lean direction (world, unit) */
  stumbleT = 0;
  stumbleDur = 1;
  leanX = 0;
  leanZ = 0;
  /** jump aside: time left */
  hopT = 0;
  /** startled pose 0..1 (hands up) */
  startle = 0;
  // appearance
  readonly top = new THREE.Color();
  readonly bottom = new THREE.Color();
  readonly skin = new THREE.Color();
  readonly frame = new THREE.Color();
  hair = 0;
  shoe = 0;
  bag = 0;
  flags = 0;

  constructor(id: number, kind: number) {
    this.id = id;
    this.kind = kind;
    this.reactDelay = 0.15 + ((id * 0.6180339887) % 1) * 0.35;
  }
}

export interface PeopleOptions {
  maxBikes: number;
  maxPeds: number;
}

const tmpS = makeSample();
const lead = { v: 0, kind: -1, lat: 0, ref: -1 };
const qIdx = new Int32Array(256);
const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YZX');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _off = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _ax = new THREE.Vector3();
/** player car box (half length / half width) for dodging and bumps */
const PL_HL = 2.25;
const PL_HW = 0.95;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const LAT_STEPS = [1, 0.66, 0.33, 0];

/** Spawn weight per metre of edge: busy shopping streets and squares get many more walkers. */
const PED_W: Record<string, number> = { pedestrian: 6, living_street: 2, footway: 1, residential: 0.8, path: 0.5, steps: 0.3, cycleway: 0.4, service: 0.4, unclassified: 0.6, tertiary: 0.7, secondary: 0.6, platform: 1 };
const BIKE_W: Record<string, number> = { cycleway: 1.6, residential: 1, living_street: 0.8, tertiary: 0.9, secondary: 0.8, unclassified: 0.8, service: 0.3, path: 0.6, footway: 0.4, pedestrian: 0.3 };
function pedWeight(e: { type: string }): number {
  return PED_W[e.type] ?? 0.5;
}
function distTo(e: { pts: [number, number][] }, x: number, z: number): number {
  const p = e.pts[e.pts.length >> 1];
  return Math.hypot(p[0] - x, p[1] - z);
}
function bikeWeight(e: { type: string }): number {
  return BIKE_W[e.type] ?? 0.5;
}

export class PeopleSim {
  readonly bikes: Person[] = [];
  readonly peds: Person[] = [];
  readonly root = new THREE.Group();
  private nextId = 1;
  private targetBikes = 0;
  private targetPeds = 0;
  private readonly humans: THREE.InstancedMesh;
  private readonly bikeMesh: THREE.InstancedMesh;
  private readonly hA: { c0: THREE.InstancedBufferAttribute; c1: THREE.InstancedBufferAttribute; c2: THREE.InstancedBufferAttribute; anim: THREE.InstancedBufferAttribute };
  private readonly bA: { anim: THREE.InstancedBufferAttribute; frame: THREE.InstancedBufferAttribute };
  private readonly humanCap: number;
  private readonly bikeCap: number;
  private ring = {
    bike: { idx: new Int32Array(4096), cum: new Float32Array(4096), n: 0 },
    ped: { idx: new Int32Array(4096), cum: new Float32Array(4096), n: 0 },
  };
  private ringX = 1e9;
  private ringZ = 1e9;
  private ringT = 0;
  private initialized = false;
  private readonly latRange = new Map<Path, Float32Array>();
  /** set by the traffic system: is AI car carId standing still waiting for agent (kind, id)? */
  carWaitsFor: ((carId: number, kind: number, id: number) => boolean) | null = null;
  updateMs = 0;
  /** While set (background shader warm-up), render() keeps empty meshes visible (0 instances). */
  holdVisible = false;
  drawnHumans = 0;
  drawnBikes = 0;
  /** people currently dodging / stumbling / walking back (last update) */
  dodging = 0;
  /** total bumps by the player car */
  bumps = 0;

  constructor(
    private readonly net: Network,
    private readonly rng: () => number,
    readonly opts: PeopleOptions,
  ) {
    this.root.name = 'traffic-people';
    this.humanCap = opts.maxPeds + opts.maxBikes + 8;
    this.bikeCap = opts.maxBikes + 4;
    // humans
    const hg = buildHumanGeometry();
    const hc = this.humanCap;
    const mk = (n: number, size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.hA = { c0: mk(hc, 4), c1: mk(hc, 4), c2: mk(hc, 4), anim: mk(hc, 4) };
    hg.setAttribute('aCol0', this.hA.c0);
    hg.setAttribute('aCol1', this.hA.c1);
    hg.setAttribute('aCol2', this.hA.c2);
    hg.setAttribute('aAnim', this.hA.anim);
    const hm = createHumanMaterials();
    this.humans = new THREE.InstancedMesh(hg, hm.material, hc);
    this.humans.customDepthMaterial = hm.depth;
    this.humans.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.humans.frustumCulled = false;
    this.humans.castShadow = true;
    this.humans.receiveShadow = true;
    this.humans.count = 0;
    this.humans.name = 'traffic_humans';
    // bikes
    const bg = buildBikeGeometry();
    const bc = this.bikeCap;
    this.bA = { anim: mk(bc, 4), frame: mk(bc, 3) };
    bg.setAttribute('aAnim', this.bA.anim);
    bg.setAttribute('aFrame', this.bA.frame);
    const bm = createBikeMaterials();
    this.bikeMesh = new THREE.InstancedMesh(bg, bm.material, bc);
    this.bikeMesh.customDepthMaterial = bm.depth;
    this.bikeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bikeMesh.frustumCulled = false;
    this.bikeMesh.castShadow = true;
    this.bikeMesh.receiveShadow = true;
    this.bikeMesh.count = 0;
    this.bikeMesh.name = 'traffic_bikes';
    this.root.add(this.humans, this.bikeMesh);
    this.humanAttrs = [this.humans.instanceMatrix, this.hA.c0, this.hA.c1, this.hA.c2, this.hA.anim];
    this.bikeAttrs = [this.bikeMesh.instanceMatrix, this.bA.anim, this.bA.frame];
  }
  private readonly humanAttrs: THREE.BufferAttribute[];
  private readonly bikeAttrs: THREE.BufferAttribute[];

  /** Triangles per human / bike (for stats). */
  get trianglesPer(): { human: number; bike: number } {
    const t = (m: THREE.InstancedMesh) => (m.geometry.index ? m.geometry.index.count / 3 : 0);
    return { human: t(this.humans), bike: t(this.bikeMesh) };
  }

  setDensity(d: number): void {
    const k = Math.max(0, Math.min(1, d));
    this.targetBikes = Math.round(this.opts.maxBikes * k);
    this.targetPeds = Math.round(this.opts.maxPeds * k);
  }

  fillGrid(grid: AgentGrid): void {
    for (const b of this.bikes) grid.add(KIND_BIKE, b.id, b.x, b.z, b.dirX, b.dirZ, b.v, 0.9, 0.32);
    for (const p of this.peds) grid.add(KIND_PED, p.id, p.x, p.z, p.dirX, p.dirZ, p.v, 0.25, 0.28);
  }

  update(dt: number, fx: number, fz: number, grid: AgentGrid, player: PlayerState, visible: (x: number, y: number, z: number, r: number) => boolean): void {
    const t0 = performance.now();
    this.dodging = 0;
    for (const b of this.bikes) this.stepBike(b, dt, grid, player);
    for (const p of this.peds) this.stepPed(p, dt, grid, player);
    this.manage(fx, fz, grid, player, visible);
    this.updateMs = performance.now() - t0;
  }

  // ============================================================================ movement

  private advance(a: Person, ds: number): void {
    a.s += ds;
    while (a.s >= a.route[0].len) {
      if (a.route.length === 1) {
        if (!this.appendNext(a)) {
          a.s = a.route[0].len;
          a.terminal = true;
          return;
        }
      }
      a.s -= a.route[0].len;
      a.route.shift();
      a.hint = 0;
      this.onNewPath(a);
    }
    if (a.route.length < 3) this.appendNext(a);
  }

  /**
   * Usable lateral range on a foot path (OSM width and the building footprints do not always
   * agree): per side the largest of half, 2/3, 1/3, 0 x half whose line (+0.35 m shoulder) stays
   * out of buildings, sampled every ~2 m. Cached per path; writes a.latLo / a.latHi.
   */
  private freeLat(p: Path, half: number, a: Person): void {
    let r = this.latRange.get(p);
    if (!r) {
      r = new Float32Array([-half, half]);
      const ins = this.net.insideFn;
      if (ins) {
        const n = Math.min(48, Math.max(2, Math.ceil(p.len / 2)));
        for (let side = 0; side < 2; side++) {
          const sg = side === 0 ? -1 : 1;
          let found = 0;
          for (const f of LAT_STEPS) {
            const l = sg * (half * f + 0.35);
            let good = true;
            let hint = 0;
            for (let k = 0; k <= n && good; k++) {
              p.sample((p.len * k) / n, tmpS, hint);
              hint = tmpS.i;
              if (ins(tmpS.x - tmpS.tz * l, tmpS.z + tmpS.tx * l)) good = false;
            }
            if (good) {
              found = sg * half * f;
              break;
            }
          }
          r[side] = found;
        }
      }
      this.latRange.set(p, r);
    }
    a.latLo = r[0];
    a.latHi = r[1];
  }

  /** Lateral offset target when entering a new path. */
  private onNewPath(a: Person): void {
    const p = a.route[0];
    if (a.kind === KIND_PED && p.kind !== PATH_CONN && p.edge >= 0) {
      const e = this.net.edges[p.edge];
      a.latLo = -9;
      a.latHi = 9;
      if (!e.car && (e.type === 'pedestrian' || e.width >= 5)) {
        const half = Math.max(0.3, e.width * 0.5 - 1.2);
        this.freeLat(p, half, a);
        a.latT = a.latLo + this.rng() * (a.latHi - a.latLo);
      } else if (!e.car) {
        this.freeLat(p, 0.65, a);
        a.latT = clamp(0.3 + this.rng() * 0.35, a.latLo, a.latHi); // keep right on footways
      } else a.latT = (this.rng() - 0.5) * 0.5;
      a.baseLat = a.latT;
    } else if (a.kind === KIND_PED) {
      a.latT = a.baseLat = 0; // crossings: straight line
      a.latLo = -0.9;
      a.latHi = 0.9;
    }
  }

  private pose(a: Person, ds: number, smooth: number): void {
    const p = a.route[0];
    p.sample(a.s, tmpS, a.hint);
    a.hint = tmpS.i;
    const target = Math.atan2(tmpS.tx, tmpS.tz);
    let dh = target - a.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const k = 1 - Math.exp(-Math.max(ds, 0) / smooth);
    const turn = dh * k;
    a.heading += turn;
    a.dirX = Math.sin(a.heading);
    a.dirZ = Math.cos(a.heading);
    // lateral offset to the right of the path tangent
    const rx = -tmpS.tz;
    const rz = tmpS.tx;
    a.x = a.px = tmpS.x + rx * a.lat;
    a.z = a.pz = tmpS.z + rz * a.lat;
    a.y = p.heightAt(a.s);
    if (a.kind === KIND_BIKE) {
      const curv = ds > 1e-4 ? turn / ds : 0;
      const rollT = Math.max(-0.3, Math.min(0.3, Math.atan((a.v * a.v * curv) / 9.81)));
      a.roll += (rollT - a.roll) * 0.15;
    }
  }

  /** Nearest obstacle gap in front (spatial hash cone check). */
  /**
   * Whether agent a waits for an obstacle of this kind (cosH = cosine between headings).
   * Standing cars/bikes are walked around by pedestrians (avoidStanding) instead of waited for.
   * While impatient (ignoreT > 0, after waiting long) only the player and moving cars count.
   */
  private reacts(a: Person, kind: number, cosH: number, moving: boolean): boolean {
    if (kind === KIND_PLAYER) return true;
    const impatient = a.ignoreT > 0;
    if (kind === KIND_CAR) {
      if (cosH < -0.6) return false; // oncoming: passes beside us
      if (a.kind === KIND_PED) return moving;
      return moving || !impatient || cosH > 0.6; // cyclists never ride into a car ahead
    }
    if (impatient) return false;
    if (kind === KIND_BIKE) return a.kind === KIND_BIKE ? cosH > 0.3 : moving;
    // pedestrians
    return a.kind === KIND_BIKE || cosH > -0.2; // oncoming walkers sidestep instead
  }

  private coneGap(a: Person, range: number, latPad: number, grid: AgentGrid, player: PlayerState, out: { v: number; kind: number; lat: number; ref: number }): number {
    let gap = 1e9;
    const qx = a.x + a.dirX * range * 0.5;
    const qz = a.z + a.dirZ * range * 0.5;
    const n = grid.query(qx, qz, range * 0.5 + 1.5, qIdx);
    const rx = -a.dirZ;
    const rz = a.dirX;
    const myHalfL = a.kind === KIND_BIKE ? 0.9 : 0.25;
    const myHalfW = a.kind === KIND_BIKE ? 0.32 : 0.28;
    for (let k = 0; k < n; k++) {
      const j = qIdx[k];
      const kind = grid.kind[j];
      if (kind === a.kind && grid.ref[j] === a.id) continue;
      const ox = grid.x[j] - a.x;
      const oz = grid.z[j] - a.z;
      const along = ox * a.dirX + oz * a.dirZ;
      if (along <= 0) continue;
      const cosH = grid.dx[j] * a.dirX + grid.dz[j] * a.dirZ;
      const moving = grid.v[j] > 0.4;
      if (!this.reacts(a, kind, cosH, moving)) continue;
      // a car that is standing still for us: go ahead (it yields)
      if (kind === KIND_CAR && this.carWaitsFor && this.carWaitsFor(grid.ref[j], a.kind, a.id)) continue;
      const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH));
      const ohl = grid.halfLen[j];
      const ohw = grid.halfW[j];
      const extA = ohl * Math.abs(cosH) + ohw * sinH;
      const extL = ohl * sinH + ohw * Math.abs(cosH);
      if (along - extA > range) continue;
      const slat = ox * rx + oz * rz;
      const lat = Math.abs(slat);
      if (lat > myHalfW + extL + latPad) continue;
      // walkers only react to moving cars right in front of them (cars yield to walkers)
      if (kind === KIND_CAR && a.kind === KIND_PED && along - extA > 1.4) continue;
      const g = along - myHalfL - extA;
      if (g < gap) {
        gap = g;
        out.v = Math.max(0, grid.v[j] * cosH);
        out.kind = kind;
        out.lat = slat;
        out.ref = grid.ref[j];
      }
    }
    return gap;
  }

  private stepBike(b: Person, dt: number, grid: AgentGrid, player: PlayerState): void {
    if (b.pinned) {
      b.wheel = (b.wheel + (b.vDes * dt) / BIKE.wheelR) % (Math.PI * 2);
      b.crank = (b.crank + ((b.vDes * dt) / 2.4) * Math.PI) % (Math.PI * 2);
      b.v = 0;
      return;
    }
    const threat = this.threat(b, dt, player);
    if (b.terminal) {
      this.applyOffset(b, dt, player);
      return;
    }
    lead.v = 0;
    lead.kind = -1;
    lead.ref = -1;
    if (b.ignoreT > 0) b.ignoreT -= dt;
    // desired speed with curve limits ahead
    let vDes = b.vDes;
    let d = -b.s;
    for (let k = 0; k < b.route.length && d < 14; k++) {
      const p = b.route[k];
      if (p.vmin < 30) {
        for (let i = 0; i < p.n; i++) {
          const di = d + p.cum[i];
          if (di < -0.5 || di > 14) continue;
          const vm = p.vmax[i];
          vDes = Math.min(vDes, Math.sqrt(vm * vm + 2 * 1.5 * Math.max(0, di)));
        }
      }
      d += p.len;
    }
    const gap = this.coneGap(b, 3 + b.v * 1.3, 0.25, grid, player, lead);
    b.leadKind = lead.kind;
    b.leadRef = lead.ref;
    let acc: number;
    if (gap < 1e8) {
      const sStar = 1.2 + Math.max(0, b.v * 0.8 + (b.v * (b.v - lead.v)) / (2 * Math.sqrt(1.2 * 2.5)));
      const q = sStar / Math.max(gap, 0.05);
      acc = 1.2 * (1 - Math.pow(b.v / Math.max(vDes, 0.5), 4) - q * q);
    } else acc = 1.2 * (1 - Math.pow(b.v / Math.max(vDes, 0.5), 4));
    // player car threatening: brake hard when it comes from the front/side (from behind: hold the
    // line speed and swerve); after a bump the bike rolls out
    if (b.stumbleT > 0) acc = Math.min(acc, -3);
    else if (threat && b.escaping && player.speed > 0.5) {
      const cosA = (player.vx * b.dirX + player.vz * b.dirZ) / player.speed;
      if (cosA < 0.6) acc = Math.min(acc, -4.5);
    }
    acc = Math.max(-5, Math.min(1.2, acc));
    b.v = Math.max(0, b.v + acc * dt);
    if (gap < 0.2) b.v = 0;
    if (b.v < 0.2) {
      b.waitT += dt;
      // patience: after waiting on a car/bike for a while, go anyway (the car yields)
      if (b.waitT > 4 && lead.kind !== KIND_PLAYER) {
        b.ignoreT = 2;
        b.waitT = 0;
      }
    } else b.waitT = 0;
    b.stuckT = b.v < 0.2 ? b.stuckT + dt : 0;
    const ds = b.v * dt;
    this.advance(b, ds);
    b.lat += (b.latT - b.lat) * Math.min(1, dt * 0.8);
    this.pose(b, ds, 1.1);
    this.applyOffset(b, dt, player);
    b.wheel = (b.wheel + ds / BIKE.wheelR) % (Math.PI * 2);
    if (b.v > 0.3 || acc > 0) b.crank = (b.crank + ds / 2.4 * Math.PI * 2 * 0.5) % (Math.PI * 2);
  }

  private stepPed(p: Person, dt: number, grid: AgentGrid, player: PlayerState): void {
    if (p.pinned) {
      p.phase = (p.phase + ((p.vDes * dt) / (1.45 * p.scale)) * Math.PI * 2) % (Math.PI * 2);
      p.v = p.vDes;
      return;
    }
    const threat = this.threat(p, dt, player);
    if (threat) this.separate(p, grid);
    if (p.terminal) {
      this.applyOffset(p, dt, player);
      this.stepPhase(p, 0, dt);
      return;
    }
    if (p.ignoreT > 0) p.ignoreT -= dt;
    lead.v = 0;
    lead.kind = -1;
    lead.ref = -1;
    const gap = this.coneGap(p, 2.6, 0.12, grid, player, lead);
    p.leadKind = lead.kind;
    p.leadRef = lead.ref;
    let vT = p.vDes;
    if (p.pauseT > 0) {
      p.pauseT -= dt;
      vT = 0;
    } else if (p.route[0].kind !== PATH_CONN && this.rng() < dt * 0.012) p.pauseT = 2 + this.rng() * 7;
    if (gap < 1e8) {
      if (lead.kind === KIND_PLAYER || lead.kind === KIND_CAR) vT = gap < 1.6 ? 0 : Math.min(vT, gap * 0.6);
      else vT = Math.min(vT, Math.max(lead.v, gap < 0.5 ? 0 : (gap - 0.4) * 1.2));
    }
    // player car right in front: stop
    if (player.present) {
      const ox = player.x - p.x;
      const oz = player.z - p.z;
      const along = ox * p.dirX + oz * p.dirZ;
      const lat = Math.abs(-ox * p.dirZ + oz * p.dirX);
      if (along > -0.5 && along < 4.5 && lat < 1.8) vT = 0;
    }
    // sidestep oncoming walkers / slower ones
    {
      const n = grid.query(p.x + p.dirX * 1.5, p.z + p.dirZ * 1.5, 2, qIdx);
      let push = 0;
      for (let k = 0; k < n; k++) {
        const j = qIdx[k];
        if (grid.kind[j] !== KIND_PED || grid.ref[j] === p.id) continue;
        const ox = grid.x[j] - p.x;
        const oz = grid.z[j] - p.z;
        const along = ox * p.dirX + oz * p.dirZ;
        const lat = -ox * p.dirZ + oz * p.dirX; // + = on my right
        if (along >= 0.2 && along <= 3) {
          if (Math.abs(lat) > 0.75) continue;
          push += lat > 0.05 ? -0.5 : 0.5;
        } else if (Math.abs(along) < 0.45 && Math.abs(lat) < 0.55) {
          // side by side and too close: drift apart
          push += lat > 0.02 ? -0.4 : lat < -0.02 ? 0.4 : p.id & 1 ? 0.4 : -0.4;
        }
      }
      if (p.avoidT > 0) p.avoidT -= dt;
      else if (push !== 0) p.latT = clamp(clamp(p.lat + push, p.baseLat - 0.9, p.baseLat + 0.9), p.latLo, p.latHi);
      else p.latT += (p.baseLat - p.latT) * Math.min(1, dt * 0.4);
    }
    if (p.waitT > 5 && lead.kind !== KIND_PLAYER) {
      p.ignoreT = 2;
      p.waitT = 0;
    }
    // standing cars/bikes (waiting at a junction, stopped for us): walk around the nearer end
    if (this.avoidStanding(p, grid)) vT = Math.min(vT, 0.7);
    // player car: stand aside while it passes (threat/stumble), stroll back onto the path afterwards
    const aside = threat || p.stumbleT > 0;
    if (aside) vT = 0;
    else if (p.offX !== 0 || p.offZ !== 0) vT = Math.min(vT, 0.8);
    p.v += Math.max(aside ? -8 : -3, Math.min(1.0, (vT - p.v) * 3)) * dt;
    if (p.v < 0) p.v = 0;
    p.waitT = p.v < 0.1 ? p.waitT + dt : 0;
    p.stuckT = p.v < 0.1 ? p.stuckT + dt : 0;
    const ds = p.v * dt;
    this.advance(p, ds);
    const latRate = p.avoidT > 0 ? 1.1 : 0.6;
    p.lat += Math.max(-latRate * dt, Math.min(latRate * dt, p.latT - p.lat));
    this.pose(p, ds, 0.5);
    this.applyOffset(p, dt, player);
    this.stepPhase(p, ds, dt);
  }

  /** Walk cycle from path progress plus side-stepping / stumbling motion. */
  private stepPhase(p: Person, ds: number, dt: number): void {
    const side = Math.hypot(p.offVX, p.offVZ) * dt;
    p.phase = (p.phase + ((ds + side) / (1.45 * p.scale)) * Math.PI * 2) % (Math.PI * 2);
  }

  // ======================================================================= player car reactions

  /** Can a person stand at (x, z) coming from height y: not inside a building, no big drop/climb. */
  private canStand(x: number, z: number, y: number): boolean {
    const ins = this.net.insideFn;
    if (ins && ins(x, z)) return false;
    const h = this.net.heightFn(x, z);
    return h > y - 0.45 && h < y + 0.45;
  }

  /**
   * Time-to-collision check against the player car's swept box (straight-line prediction in its
   * motion frame). After a short per-person reaction delay the person picks an escape side (away
   * from the car's centre line unless that is blocked by a facade/quay) and gets an escape
   * velocity that clears the box in time; fast cars make walkers jump aside. Returns true while
   * the person keeps clear (also ~1 s after the threat ended).
   */
  private threat(a: Person, dt: number, player: PlayerState): boolean {
    if (a.dodgeT > 0) a.dodgeT -= dt;
    if (a.hopT > 0) a.hopT -= dt;
    a.tvX = 0;
    a.tvZ = 0;
    a.escaping = false;
    const sp = player.speed;
    const dx = a.x - player.x;
    const dz = a.z - player.z;
    if (!player.present || sp < 0.8 || dx * dx + dz * dz > 1600) {
      a.alertT = 0;
      a.escSide = 0;
      return a.dodgeT > 0;
    }
    const ux = player.vx / sp;
    const uz = player.vz / sp;
    const rx = -uz;
    const rz = ux;
    const along = dx * ux + dz * uz;
    const lat = dx * rx + dz * rz;
    // car box and person extents projected on the motion frame
    const c = Math.abs(ux * player.fx + uz * player.fz);
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const cA = PL_HL * c + PL_HW * s;
    const cL = PL_HL * s + PL_HW * c;
    let pA = 0.3;
    let pL = 0.3;
    if (a.kind === KIND_BIKE) {
      const cb = Math.abs(a.dirX * ux + a.dirZ * uz);
      const sb = Math.sqrt(Math.max(0, 1 - cb * cb));
      pA = 0.9 * cb + 0.3 * sb;
      pL = 0.9 * sb + 0.3 * cb;
    }
    const clearLat = cL + pL + 0.45;
    const gap = along - cA - pA;
    const closing = sp - ((a.dirX * ux + a.dirZ * uz) * a.v + a.offVX * ux + a.offVZ * uz);
    const ttc = gap <= 0 ? 0 : closing > 0.1 ? gap / closing : 99;
    if (!(along > -cA - pA && Math.abs(lat) < clearLat && ttc < (a.kind === KIND_BIKE ? 2.2 : 1.9))) {
      a.alertT = Math.max(0, a.alertT - dt * 2);
      if (a.alertT === 0) a.escSide = 0;
      return a.dodgeT > 0;
    }
    a.alertT += dt;
    if (a.alertT < a.reactDelay) return a.dodgeT > 0; // not noticed yet: carry on
    a.dodgeT = 1.1;
    if (a.escSide === 0) a.escSide = this.pickSide(a, lat, clearLat, rx, rz, ttc);
    const move = a.escSide * clearLat - lat; // signed, along the car's right axis
    if (move * a.escSide > 0.03) {
      const ped = a.kind === KIND_PED;
      const vEsc = clamp((Math.abs(move) / Math.max(ttc - 0.1, 0.25)) * 1.3, ped ? 1.5 : 1.0, ped ? 4.5 : 3.0);
      a.tvX = rx * a.escSide * vEsc;
      a.tvZ = rz * a.escSide * vEsc;
      a.escaping = true;
      if (ped && vEsc > 2.4 && ttc < 1.0 && a.hopT <= 0) a.hopT = 0.42;
    }
    return true;
  }

  /** While stepping aside for the player: keep ~0.6 m from other walkers (no clumping into each
   *  other at the same escape spot); never pushes against the escape direction. */
  private separate(p: Person, grid: AgentGrid): void {
    const n = grid.query(p.x, p.z, 0.7, qIdx);
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < n; k++) {
      const j = qIdx[k];
      if (grid.kind[j] !== KIND_PED || grid.ref[j] === p.id) continue;
      let ox = p.x - grid.x[j];
      let oz = p.z - grid.z[j];
      const d2 = ox * ox + oz * oz;
      if (d2 > 0.36) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-3) {
        ox = p.id & 1 ? 1 : -1;
        oz = 0;
        d = 1;
      }
      const w = (0.6 - Math.min(d, 0.6)) / 0.6;
      sx += (ox / d) * w;
      sz += (oz / d) * w;
    }
    if (sx === 0 && sz === 0) return;
    const el = Math.hypot(p.tvX, p.tvZ);
    if (el > 0) {
      const ex = p.tvX / el;
      const ez = p.tvZ / el;
      const dot = sx * ex + sz * ez;
      if (dot < 0) {
        sx -= ex * dot;
        sz -= ez * dot;
      }
    }
    p.tvX += sx * 1.6;
    p.tvZ += sz * 1.6;
  }

  /** Escape side: away from the car's centre line, else across it when there is time; checks the
   *  landing spot and the way there against facades and quay edges. */
  private pickSide(a: Person, lat: number, clearLat: number, rx: number, rz: number, ttc: number): number {
    const pref = lat > 0.05 ? 1 : lat < -0.05 ? -1 : a.id & 1 ? 1 : -1;
    for (let k = 0; k < 2; k++) {
      const sg = k === 0 ? pref : -pref;
      const move = sg * clearLat - lat;
      if (k === 1 && Math.abs(move) / 4 > ttc + 0.2) break; // no time to cross in front of the car
      const m2 = move + sg * 0.3;
      if (this.canStand(a.x + rx * m2, a.z + rz * m2, a.y) && this.canStand(a.x + rx * move * 0.5, a.z + rz * move * 0.5, a.y)) return sg;
    }
    return pref; // blocked both ways: press to the near side (movement stops at the wall)
  }

  /** Integrates the dodge/bump offset (wall-checked), walks it back afterwards and resolves contact. */
  private applyOffset(a: Person, dt: number, player: PlayerState): void {
    const ped = a.kind === KIND_PED;
    let returning = false;
    if (a.stumbleT > 0) {
      a.stumbleT -= dt;
      const sp = Math.hypot(a.offVX, a.offVZ);
      const dec = (5 + sp * 3) * dt; // fast shoves die out quickly (no sliding metres away)
      const k = sp > dec ? (sp - dec) / sp : 0;
      a.offVX *= k;
      a.offVZ *= k;
    } else if (a.escaping || a.dodgeT > 0 || a.offX !== 0 || a.offZ !== 0 || a.offVX !== 0 || a.offVZ !== 0) {
      let tx = a.tvX;
      let tz = a.tvZ;
      if (!a.escaping && a.dodgeT <= 0) {
        // back onto the path
        returning = true;
        const d = Math.hypot(a.offX, a.offZ);
        if (d < 0.04) {
          a.offX = a.offZ = a.offVX = a.offVZ = 0;
          tx = tz = 0;
        } else {
          const v = Math.min(ped ? 0.9 : 1.4, d * 2);
          tx = (-a.offX / d) * v;
          tz = (-a.offZ / d) * v;
        }
      }
      const acc = (a.escaping ? (ped ? 16 : 7) : 5) * dt;
      let ex = tx - a.offVX;
      let ez = tz - a.offVZ;
      const el = Math.hypot(ex, ez);
      if (el > acc) {
        ex *= acc / el;
        ez *= acc / el;
      }
      a.offVX += ex;
      a.offVZ += ez;
    }
    if (a.offVX !== 0 || a.offVZ !== 0) {
      let mx = a.offVX * dt;
      let mz = a.offVZ * dt;
      if (!returning) {
        // never into a facade, never off a quay: slide along, else stop
        const bx = a.px + a.offX;
        const bz = a.pz + a.offZ;
        if (!this.canStand(bx + mx, bz + mz, a.y)) {
          if (mx !== 0 && this.canStand(bx + mx, bz, a.y)) {
            mz = 0;
            a.offVZ = 0;
          } else if (mz !== 0 && this.canStand(bx, bz + mz, a.y)) {
            mx = 0;
            a.offVX = 0;
          } else {
            mx = mz = 0;
            a.offVX = a.offVZ = 0;
          }
        }
      }
      a.offX += mx;
      a.offZ += mz;
    }
    a.x = a.px + a.offX;
    a.z = a.pz + a.offZ;
    this.bump(a, player);
    const off = a.offX !== 0 || a.offZ !== 0;
    if (off) a.y = this.net.heightFn(a.x, a.z);
    const st = a.escaping || a.stumbleT > 0 ? 1 : a.dodgeT > 0 ? 0.6 : 0;
    a.startle += (st - a.startle) * Math.min(1, dt * (st > a.startle ? 10 : 2.5));
    if (a.startle < 0.01) a.startle = 0;
    if (off || a.dodgeT > 0 || a.stumbleT > 0) this.dodging++;
  }

  /**
   * Contact with the player car (oriented box vs the person's circle / the bike's 3 circles):
   * push the person out of the box, preferably sideways, never into a facade or the water, and
   * start a short stumble with a push velocity.
   */
  private bump(a: Person, player: PlayerState): void {
    if (!player.present) return;
    const dx = a.x - player.x;
    const dz = a.z - player.z;
    if (dx * dx + dz * dz > 16) return;
    const fx = player.fx;
    const fz = player.fz;
    const rx = -fz;
    const rz = fx;
    const bike = a.kind === KIND_BIKE;
    const rad = bike ? 0.36 : 0.3;
    let best = 0;
    let nx = 0;
    let nz = 0;
    for (let k = 0; k < (bike ? 3 : 1); k++) {
      const o = bike ? (k - 1) * 0.6 : 0;
      const qx = dx + a.dirX * o;
      const qz = dz + a.dirZ * o;
      const la = qx * fx + qz * fz;
      const lr = qx * rx + qz * rz;
      const ea = la - clamp(la, -PL_HL, PL_HL);
      const er = lr - clamp(lr, -PL_HW, PL_HW);
      const d2 = ea * ea + er * er;
      if (d2 >= rad * rad) continue;
      let pen: number;
      let ux: number;
      let uz: number;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pen = rad - d;
        ux = (ea * fx + er * rx) / d;
        uz = (ea * fz + er * rz) / d;
      } else {
        // inside the car's outline: out of the nearer side
        const sg = lr >= 0 ? 1 : -1;
        pen = PL_HW - Math.abs(lr) + rad;
        ux = rx * sg;
        uz = rz * sg;
      }
      if (pen > best) {
        best = pen;
        nx = ux;
        nz = uz;
      }
    }
    if (best <= 0) return;
    let mx = nx * (best + 0.03);
    let mz = nz * (best + 0.03);
    if (!this.canStand(a.x + mx, a.z + mz, a.y)) {
      // pinned against a wall: along the car's length instead (ahead of / behind it), else stay
      const la = dx * fx + dz * fz;
      const sg = la >= 0 ? 1 : -1;
      const m = PL_HL - Math.abs(la) + rad + 0.03;
      if (!this.canStand(a.x + fx * sg * m, a.z + fz * sg * m, a.y)) return;
      nx = fx * sg;
      nz = fz * sg;
      mx = nx * m;
      mz = nz * m;
    }
    a.offX += mx;
    a.offZ += mz;
    a.x += mx;
    a.z += mz;
    if (player.speed < 0.7) return; // a standing car only nudges
    const vn = player.vx * nx + player.vz * nz;
    let sg = 0;
    if (vn > 0.5 && Math.abs(nx * fx + nz * fz) > 0.7) {
      // hit by the nose / tail: deflected sideways off the bumper instead of being carried ahead
      const lr = dx * rx + dz * rz;
      sg = lr > 0.05 ? 1 : lr < -0.05 ? -1 : a.escSide !== 0 ? a.escSide : a.id & 1 ? 1 : -1;
      const m = PL_HW + rad + 0.1 - sg * lr;
      if (!this.canStand(a.x + rx * sg * m, a.z + rz * sg * m, a.y)) {
        sg = -sg;
        const m2 = PL_HW + rad + 0.1 - sg * lr;
        if (!this.canStand(a.x + rx * sg * m2, a.z + rz * sg * m2, a.y)) sg = 0;
      }
    }
    if (sg !== 0) {
      const vLat = clamp(player.speed * 0.7, 3.5, 7.5);
      const vFwd = Math.min(vn * 0.5, 2.5);
      a.offVX = rx * sg * vLat + nx * vFwd;
      a.offVZ = rz * sg * vLat + nz * vFwd;
      const l = Math.hypot(a.offVX, a.offVZ);
      a.leanX = a.offVX / l;
      a.leanZ = a.offVZ / l;
    } else {
      const push = clamp(vn * 0.7 + 0.6, 0.8, 3.5);
      a.offVX = nx * push + player.vx * 0.1;
      a.offVZ = nz * push + player.vz * 0.1;
      a.leanX = nx;
      a.leanZ = nz;
    }
    if (a.stumbleT <= 0.3) {
      this.bumps++;
      a.stumbleDur = a.stumbleT = bike ? 0.8 + this.rng() * 0.3 : 0.9 + this.rng() * 0.5;
    }
    a.dodgeT = Math.max(a.dodgeT, 1.6);
    a.v *= bike ? 0.4 : 0;
  }

  /** Sets a lateral detour around a standing car/bike ahead; returns true while detouring. */
  private avoidStanding(p: Person, grid: AgentGrid): boolean {
    const n = grid.query(p.x + p.dirX * 1.5, p.z + p.dirZ * 1.5, 3.5, qIdx);
    const rx = -p.dirZ;
    const rz = p.dirX;
    let best = 0;
    let found = false;
    for (let k = 0; k < n; k++) {
      const j = qIdx[k];
      const kj = grid.kind[j];
      if ((kj !== KIND_CAR && kj !== KIND_BIKE) || grid.v[j] > 0.4) continue;
      const cx = grid.x[j] - p.x;
      const cz = grid.z[j] - p.z;
      const dx = grid.dx[j];
      const dz = grid.dz[j];
      const hl = grid.halfLen[j] + 0.1;
      const hw = grid.halfW[j] + 0.1;
      let aMin = 1e9, aMax = -1e9, lMin = 1e9, lMax = -1e9;
      for (let c = 0; c < 4; c++) {
        const sl = c < 2 ? hl : -hl;
        const sw = c & 1 ? hw : -hw;
        const px = cx + dx * sl - dz * sw;
        const pz = cz + dz * sl + dx * sw;
        const al = px * p.dirX + pz * p.dirZ;
        const la = px * rx + pz * rz;
        if (al < aMin) aMin = al;
        if (al > aMax) aMax = al;
        if (la < lMin) lMin = la;
        if (la > lMax) lMax = la;
      }
      if (aMax < -0.2 || aMin > 2.4) continue;
      if (lMin > 0.35 || lMax < -0.35) continue;
      const sR = lMax + 0.4;
      const sL = lMin - 0.4;
      const s = Math.abs(sR) < Math.abs(sL) ? sR : sL;
      if (!found || Math.abs(s) > Math.abs(best)) best = s;
      found = true;
    }
    if (!found || Math.abs(best) > 3.5) return false;
    p.latT = clamp(p.lat + best, p.latLo - 1.5, p.latHi + 1.5);
    p.avoidT = 1.2;
    return true;
  }

  // ============================================================================ routing

  private appendNext(a: Person): boolean {
    const net = this.net;
    const last = a.route[a.route.length - 1];
    const node = last.endNode;
    const nd = net.nodes[node];
    const dir0 = [0, 0];
    const dir1 = [0, 0];
    net.leaveDir(last.edge, node, dir0);
    const inX = -dir0[0];
    const inZ = -dir0[1];
    const u = this.rng();
    let next: Path | null = null;
    if (a.kind === KIND_BIKE) {
      let total = 0;
      for (let pass = 0; pass < 2 && !next; pass++) {
        let acc = 0;
        for (const f of nd.bike) {
          if (f === last.edge) continue;
          const dir = net.bikeDirFrom(f, node);
          if (dir < 0) continue;
          net.leaveDir(f, node, dir1);
          const st = inX * dir1[0] + inZ * dir1[1];
          let w = 0.4 + Math.max(0, st) * 1.2;
          if (!net.edges[f].car) w *= 1.4;
          if (net.nodes[net.otherNode(f, node)].bike.length === 1) w *= 0.1;
          if (pass === 0) total += w;
          else if ((acc += w) >= u * total) {
            next = net.bikePath(f, dir);
            break;
          }
        }
        if (total <= 0) break;
      }
      if (!next) {
        const back = net.bikeDirFrom(last.edge, node);
        if (back < 0) return false;
        next = net.bikePath(last.edge, back);
      }
      a.route.push(net.bikeConnector(last, next), next);
      return true;
    }
    // pedestrians
    const ex = last.xs[last.n - 1];
    const ez = last.zs[last.n - 1];
    let total = 0;
    for (let pass = 0; pass < 2 && !next; pass++) {
      let acc = 0;
      for (const f of nd.foot) {
        const e = net.edges[f];
        const dir = e.a === node ? 0 : 1;
        const sides = e.car ? 2 : 1;
        for (let side = 0; side < sides; side++) {
          if (f === last.edge && side === last.lane) continue;
          const p = net.footPath(f, side, dir);
          if (!p) continue;
          net.leaveDir(f, node, dir1);
          const st = inX * dir1[0] + inZ * dir1[1];
          let w = 0.5 + Math.max(0, st) * 0.8;
          const gap = Math.hypot(p.xs[0] - ex, p.zs[0] - ez);
          if (gap > 3.5) w *= 0.3; // crossing the road
          if (f === last.edge) w *= 0.05; // crossing to the other side of the same street
          if (pass === 0) total += w;
          else if ((acc += w) >= u * total) {
            next = p;
            break;
          }
        }
        if (next) break;
      }
      if (total <= 0) break;
    }
    if (!next) {
      // dead end: turn around on the same line
      const e = net.edges[last.edge];
      next = net.footPath(last.edge, last.lane, e.a === node ? 0 : 1);
      if (!next) return false;
    }
    a.route.push(net.footConnector(last, next), next);
    return true;
  }

  // ============================================================================ spawning

  private manage(fx: number, fz: number, grid: AgentGrid, player: PlayerState, visible: (x: number, y: number, z: number, r: number) => boolean): void {
    // despawn
    this.despawn(this.bikes, 270, this.targetBikes, fx, fz);
    this.despawn(this.peds, 175, this.targetPeds, fx, fz);
    this.ringT--;
    const initial = !this.initialized;
    if (this.ringT <= 0 || Math.hypot(fx - this.ringX, fz - this.ringZ) > 20) {
      this.ring.bike.n = this.net.collectRing(this.net.bikeEdges, fx, fz, initial ? 3 : 30, 230, this.ring.bike.idx, this.ring.bike.cum, (e) => bikeWeight(e) / (1 + distTo(e, fx, fz) / 80));
      this.ring.ped.n = this.net.collectRing(this.net.footEdges, fx, fz, initial ? 2 : 22, 150, this.ring.ped.idx, this.ring.ped.cum, (e) => pedWeight(e) / (1 + distTo(e, fx, fz) / 50));
      this.ringX = fx;
      this.ringZ = fz;
      this.ringT = 60;
    }
    let budget = initial ? 600 : 3;
    while (this.bikes.length < this.targetBikes && budget-- > 0) this.trySpawn(KIND_BIKE, fx, fz, grid, player, visible, initial);
    budget = initial ? 900 : 4;
    while (this.peds.length < this.targetPeds && budget-- > 0) this.trySpawn(KIND_PED, fx, fz, grid, player, visible, initial);
    if (initial) {
      this.initialized = true;
      this.ringT = 0;
    }
  }

  private despawn(list: Person[], rMax: number, target: number, fx: number, fz: number): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      const d = Math.hypot(a.x - fx, a.z - fz);
      if (a.pinned) continue;
      const hidden = !a.visible || d > 120;
      if (d > rMax + 60 || (d > rMax && !a.visible) || (a.terminal && hidden) || (a.stuckT > 20 && hidden) || (list.length > target && !a.visible)) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }

  private trySpawn(kind: number, fx: number, fz: number, grid: AgentGrid, player: PlayerState, visible: (x: number, y: number, z: number, r: number) => boolean, initial: boolean): boolean {
    const net = this.net;
    const ring = kind === KIND_BIKE ? this.ring.bike : this.ring.ped;
    if (ring.n === 0) return false;
    const ei = ring.idx[pickWeighted(ring.cum.subarray(0, ring.n), this.rng())];
    const e = net.edges[ei];
    let path: Path | null;
    if (kind === KIND_BIKE) {
      const dir = e.oneway && !(e.car && (e.type === 'residential' || e.type === 'living_street' || e.type === 'service')) ? 0 : this.rng() < 0.5 ? 0 : 1;
      if (net.bikeDirFrom(ei, dir === 0 ? e.a : e.b) < 0) return false;
      path = net.bikePath(ei, dir);
    } else {
      const side = e.car ? (this.rng() < 0.5 ? 0 : 1) : 0;
      path = net.footPath(ei, side, this.rng() < 0.5 ? 0 : 1);
    }
    if (!path || path.len < 3) return false;
    const s = this.rng() * path.len;
    path.sample(s, tmpS, 0);
    const d = Math.hypot(tmpS.x - fx, tmpS.z - fz);
    const rMin = initial ? 3 : kind === KIND_BIKE ? 30 : 22;
    const rMax = kind === KIND_BIKE ? 230 : 150;
    if (d < rMin || d > rMax) return false;
    if (!initial && d < (kind === KIND_BIKE ? 110 : 70) && visible(tmpS.x, 1, tmpS.z, 1.5)) return false;
    if (player.present && Math.hypot(player.x - tmpS.x, player.z - tmpS.z) < 8) return false;
    const n = grid.query(tmpS.x, tmpS.z, 3, qIdx);
    for (let k = 0; k < n; k++) {
      const j = qIdx[k];
      const dd = Math.hypot(grid.x[j] - tmpS.x, grid.z[j] - tmpS.z);
      if (dd < (grid.kind[j] === KIND_CAR ? 3.5 : 1.8)) return false;
    }
    const list = kind === KIND_BIKE ? this.bikes : this.peds;
    for (const o of list) if (Math.abs(o.x - tmpS.x) < 1.5 && Math.abs(o.z - tmpS.z) < 1.5) return false;
    const a = new Person(this.nextId++, kind);
    a.route.push(path);
    a.s = s;
    a.hint = tmpS.i;
    a.heading = Math.atan2(tmpS.tx, tmpS.tz);
    a.dirX = tmpS.tx;
    a.dirZ = tmpS.tz;
    a.x = a.px = tmpS.x;
    a.z = a.pz = tmpS.z;
    a.y = path.heightAt(s);
    this.dress(a);
    if (kind === KIND_BIKE) {
      a.vDes = (15 + this.rng() * 6) / 3.6;
      a.v = a.vDes * 0.8;
      a.lat = a.latT = (this.rng() - 0.5) * 0.3;
      a.crank = this.rng() * Math.PI * 2;
    } else {
      a.vDes = 1.15 + this.rng() * 0.4;
      a.v = a.vDes;
      this.onNewPath(a);
      a.lat = a.latT;
      a.phase = this.rng() * Math.PI * 2;
    }
    this.appendNext(a);
    list.push(a);
    return true;
  }

  /** Debug: a row of pinned (animated in place) pedestrians and cyclists for close inspection. */
  addShowcase(x: number, y: number, z: number, heading: number, peds = 8, bikes = 3): void {
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    const rx = -dz;
    const rz = dx;
    for (let i = 0; i < peds + bikes; i++) {
      const bike = i >= peds;
      const a = new Person(this.nextId++, bike ? KIND_BIKE : KIND_PED);
      const k = bike ? i - peds : i;
      const lateral = bike ? (k - (bikes - 1) / 2) * 2.2 : (k - (peds - 1) / 2) * 1.1;
      const back = bike ? 3.5 : 0;
      a.x = x + rx * lateral - dx * back;
      a.z = z + rz * lateral - dz * back;
      a.y = y;
      a.heading = heading + (bike ? 0.5 : 0);
      a.dirX = Math.sin(a.heading);
      a.dirZ = Math.cos(a.heading);
      a.pinned = true;
      this.dress(a);
      a.vDes = bike ? 4.5 : 1.3;
      a.phase = k * 0.9;
      if (!bike && k === 0) a.vDes = 0; // one standing person
      (bike ? this.bikes : this.peds).push(a);
    }
  }

  private dress(a: Person): void {
    const r = this.rng;
    pickColor(TOPS, r(), a.top);
    pickColor(BOTTOMS, r(), a.bottom);
    pickColor(SKINS, r(), a.skin);
    pickColor(FRAMES, r(), a.frame);
    const old = r() < 0.18;
    a.hair = old ? (r() < 0.6 ? 5 : 6) : Math.floor(r() * 5 + (r() < 0.06 ? 3 : 0)) % 8;
    a.shoe = r() < 0.22 ? 0 : 1 + Math.floor(r() * 3);
    a.bag = Math.floor(r() * 6);
    let flags = 0;
    if (r() < 0.22) flags |= 1; // backpack
    if (a.kind === KIND_PED && r() < 0.2) flags |= 2; // shopping / hand bag
    if (r() < 0.38) flags |= 4; // long hair
    if (a.kind === KIND_PED && flags & 4 && r() < 0.35) {
      flags |= 8; // skirt or dress, with dark or skin-tone tights
      pickColor(TIGHTS, r(), a.bottom);
    }
    a.flags = flags;
    a.scale = (flags & 4 ? 0.95 : 1.0) * (0.94 + r() * 0.1);
  }

  // ============================================================================ rendering

  render(visible: (x: number, y: number, z: number, r: number) => boolean, camPos: THREE.Vector3, maxDist: number): void {
    let h = 0;
    let bk = 0;
    const hm = this.humans.instanceMatrix.array as Float32Array;
    const bmArr = this.bikeMesh.instanceMatrix.array as Float32Array;
    const c0 = this.hA.c0.array as Float32Array;
    const c1 = this.hA.c1.array as Float32Array;
    const c2 = this.hA.c2.array as Float32Array;
    const an = this.hA.anim.array as Float32Array;
    const ba = this.bA.anim.array as Float32Array;
    const bf = this.bA.frame.array as Float32Array;
    const md2 = maxDist * maxDist;
    for (const b of this.bikes) {
      const dx = b.x - camPos.x;
      const dz = b.z - camPos.z;
      b.visible = dx * dx + dz * dz < md2 && visible(b.x, b.y + 0.9, b.z, 1.6);
      if (!b.visible || bk >= this.bikeCap || h >= this.humanCap) continue;
      // swerving (sideways offset motion) turns the front wheel into the swerve
      let yaw = b.heading;
      if (b.offVX !== 0 || b.offVZ !== 0) {
        const latV = -b.offVX * b.dirZ + b.offVZ * b.dirX;
        yaw -= clamp(Math.atan2(latV, Math.max(b.v, 1.2)), -0.6, 0.6);
      }
      _e.set(0, yaw, -b.roll);
      _q.setFromEuler(_e);
      if (b.stumbleT > 0) this.leanQuat(b, 0.2);
      _p.set(b.x, b.y, b.z);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      _m.toArray(bmArr, bk * 16);
      ba[bk * 4] = b.wheel;
      ba[bk * 4 + 1] = b.crank;
      bf[bk * 3] = b.frame.r;
      bf[bk * 3 + 1] = b.frame.g;
      bf[bk * 3 + 2] = b.frame.b;
      bk++;
      // rider sits on the saddle
      _off.copy(BIKE.riderOffset);
      _r.makeTranslation(_off.x, _off.y, _off.z);
      _r.premultiply(_m);
      _r.toArray(hm, h * 16);
      this.writeHuman(b, h, c0, c1, c2, an, b.crank, 1, 1);
      h++;
    }
    for (const p of this.peds) {
      const dx = p.x - camPos.x;
      const dz = p.z - camPos.z;
      p.visible = dx * dx + dz * dz < md2 && visible(p.x, p.y + 0.9, p.z, 1.2);
      if (!p.visible || h >= this.humanCap) continue;
      _e.set(0, p.heading, 0);
      _q.setFromEuler(_e);
      let amp = Math.min(1, p.v / 1.2);
      let y = p.y;
      if (p.stumbleT > 0) {
        this.leanQuat(p, 0.42);
        amp = 1.25;
      } else if (p.offVX !== 0 || p.offVZ !== 0) amp = Math.max(amp, Math.min(1.3, Math.hypot(p.offVX, p.offVZ) / 1.3));
      if (p.hopT > 0) y += 0.2 * Math.sin((Math.PI * (0.42 - p.hopT)) / 0.42);
      _p.set(p.x, y, p.z);
      _s.setScalar(p.scale);
      _m.compose(_p, _q, _s);
      _m.toArray(hm, h * 16);
      this.writeHuman(p, h, c0, c1, c2, an, p.phase, amp, p.startle > 0 ? 2 + p.startle : 0);
      h++;
    }
    this.humans.count = h;
    this.bikeMesh.count = bk;
    this.humans.visible = h > 0 || this.holdVisible;
    this.bikeMesh.visible = bk > 0 || this.holdVisible;
    for (const a of this.humanAttrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, h * a.itemSize);
      a.needsUpdate = true;
    }
    for (const a of this.bikeAttrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, bk * a.itemSize);
      a.needsUpdate = true;
    }
    this.drawnHumans = h;
    this.drawnBikes = bk;
  }

  /** Stumble: tilts _q toward the push direction and back up over the stumble time. */
  private leanQuat(a: Person, maxAng: number): void {
    const u = 1 - a.stumbleT / a.stumbleDur;
    const ang = maxAng * Math.sin(Math.PI * Math.min(1, u * 1.15)) * (1 - 0.4 * u);
    _ax.set(a.leanZ, 0, -a.leanX);
    _q2.setFromAxisAngle(_ax, ang);
    _q.premultiply(_q2);
  }

  private writeHuman(a: Person, i: number, c0: Float32Array, c1: Float32Array, c2: Float32Array, an: Float32Array, phase: number, amp: number, mode: number): void {
    c0[i * 4] = a.top.r;
    c0[i * 4 + 1] = a.top.g;
    c0[i * 4 + 2] = a.top.b;
    c0[i * 4 + 3] = a.flags;
    c1[i * 4] = a.bottom.r;
    c1[i * 4 + 1] = a.bottom.g;
    c1[i * 4 + 2] = a.bottom.b;
    c1[i * 4 + 3] = a.shoe;
    c2[i * 4] = a.skin.r;
    c2[i * 4 + 1] = a.skin.g;
    c2[i * 4 + 2] = a.skin.b;
    c2[i * 4 + 3] = a.hair;
    an[i * 4] = phase;
    an[i * 4 + 1] = amp;
    an[i * 4 + 2] = mode;
    an[i * 4 + 3] = a.bag;
  }

  /**
   * Makes both meshes visible with 0 instances (part of a shader compile pass, draws nothing).
   * Sets holdVisible so render() keeps them visible until the warm-up clears it.
   */
  showAllForCompile(): void {
    this.holdVisible = true;
    for (const m of [this.humans, this.bikeMesh]) {
      m.count = 0;
      m.visible = true;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const m of [this.humans, this.bikeMesh]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.customDepthMaterial?.dispose();
      m.dispose();
    }
    this.bikes.length = 0;
    this.peds.length = 0;
  }
}
