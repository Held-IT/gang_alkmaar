// Gang Beasts style framing camera: frames all active beasts (weighted towards the human) inside
// the arena's camera frame (fixed yaw/pitch, min/max distance), smooth damped pan + zoom, a slow
// drift, clearance against buildings (ray cast, like the reference engine's camera_clearance
// with a minimum of 45 % of the framing distance), a dramatic punch-in on knock-outs and a
// "fly to the winner" focus mode. Ported loosely from reference/gang-beasts-rust
// crates/gb_game/src/play.rs follow_camera (OrbitLerpSpeed 0.075 per frame @60 fps).
import * as THREE from 'three';
import type { Engine } from '../contracts';
import type { PhysicsWorldExt } from '../physics/physics';
import type { ArenaCameraFrame } from './contracts';

export type CameraMode = 'frame' | 'focus' | 'orbit' | 'manual';

export interface BrawlCamera {
  readonly mode: CameraMode;
  setFrame(frame: ArenaCameraFrame): void;
  /** Subjects for the framing mode this frame (positions + weights, copied). */
  setSubjects(points: readonly THREE.Vector3[], weights: readonly number[]): void;
  /** The subject that must stay visible (the human); occlusion is tested from here. null = centre. */
  setPrimary(p: THREE.Vector3 | null): void;
  /** Distance to the nearest drop (arena.edgeDistance): the camera keeps the drops near the action in view. */
  setEdgeTest(fn: ((p: THREE.Vector3) => number) | null): void;
  /** Fly to a subject: camera in front of it (facing = the subject's heading). */
  focus(p: THREE.Vector3, facing: number, distance?: number): void;
  /** Slow orbit around p (match winner celebration). */
  orbit(p: THREE.Vector3, distance?: number): void;
  /** Back to framing the subjects. */
  release(): void;
  /** The scene drives the camera itself (lobby). */
  setManual(on: boolean): void;
  /** Short dramatic zoom towards p (knock-out). */
  punchIn(p: THREE.Vector3, amount?: number): void;
  shake(amount: number): void;
  /** Jump to the goal immediately. */
  snap(): void;
  update(dt: number): void;
  /** Current look-at point (smoothed). */
  readonly target: THREE.Vector3;
  readonly debug: { target: THREE.Vector3; distance: number; clearance: number; yaw: number; pitch: number; yawOffset: number; pitchOffset: number; crowns: number; scores(): unknown };
}

const FOV = 46;
/** colliders the camera may look through (arena dressing, barriers, props, moving hazards) */
export const IGNORE_TAG = /^(arena|barrier|invisible|gate|hazard|beast|boat|prop|kaas|berrie|sail|wiek|bridge|brug)/i;

/** [yaw, pitch] offsets tried (in this order) when the view is blocked (walls, tree crowns) */
const PROBES: readonly (readonly [number, number])[] = [
  [0, 0], [0, 0.14], [0.4, 0], [-0.4, 0], [0.4, 0.14], [-0.4, 0.14], [0.8, 0], [-0.8, 0], [0.8, 0.14], [-0.8, 0.14],
  [1.2, 0], [-1.2, 0], [1.6, 0], [-1.6, 0], [2.2, 0], [-2.2, 0], [Math.PI, 0],
];
/** tree crowns closer than this to the line of sight hide a subject (crowns are leafy at the rim) */
const CROWN_SOLID = 0.8;
/** weight of one probe point on a drop edge (a subject weighs 1, the human 2) */
const EDGE_W = 0.4;
const FOCUS_PITCH = 0.16;
/** yaw offsets tried around the default winner-zoom view */
const FOCUS_PROBES = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2.1, -2.1, 2.7, -2.7];

const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function createBrawlCamera(engine: Engine, physics: PhysicsWorldExt | null): BrawlCamera {
  let mode: CameraMode = 'manual';
  let frame: ArenaCameraFrame = { target: new THREE.Vector3(), yaw: 0, pitch: 0.6, minDistance: 7, maxDistance: 18 };
  const subjects: THREE.Vector3[] = [];
  const weights: number[] = [];
  let count = 0;
  // smoothed state
  const target = new THREE.Vector3();
  let dist = 12;
  let yaw = 0;
  let pitch = 0.6;
  let clearance = Infinity;
  // goals
  const gTarget = new THREE.Vector3();
  let gDist = 12;
  let gYaw = 0;
  let gPitch = 0.6;
  // focus / orbit
  const focusP = new THREE.Vector3();
  let focusFacing = 0;
  let focusDist = 3.4;
  let focusOff = 0;
  let focusProbeT = 0;
  let orbitYaw = 0;
  // effects
  const punchP = new THREE.Vector3();
  let punch = 0;
  let punchAmount = 0;
  let shake = 0;
  let time = 0;
  let snapNext = true;
  // occlusion avoidance: swing the yaw around walls / the mill body between camera and primary
  const primary = new THREE.Vector3();
  let hasPrimary = false;
  let yawOff = 0;
  let gYawOff = 0;
  let pitchOff = 0;
  let gPitchOff = 0;
  let probeT = 0;
  /** a new view is kept at least this long (no flapping), unless it gets badly blocked */
  let holdT = 0;
  const probeDir = new THREE.Vector3();
  const probeCam = new THREE.Vector3();
  // tree crowns around the arena (trees only have trunk colliders): ellipsoids found from the
  // 'tree' cylinders once per arena (re-scanned a few times while the streamed colliders arrive)
  const crowns: { x: number; y: number; z: number; r: number; h: number }[] = [];
  let scanAt: number[] = [];
  const probePts: THREE.Vector3[] = Array.from({ length: 24 }, () => new THREE.Vector3());
  const probeW: number[] = [];
  /** the first nSubj probe points are the subjects */
  let nSubj = 0;
  const camP = new THREE.Vector3();
  const fgP = new THREE.Vector3();
  /** radius of the arena sample ring of the last buildProbePoints */
  let probeR = 4;
  let edgeTest: ((p: THREE.Vector3) => number) | null = null;
  /** until then (countdown) the view may swing freely */
  let freeUntil = 0;

  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const look = new THREE.Vector3();

  function computeGoals(dt: number): void {
    if (mode === 'frame') {
      // weighted centre + spread
      let wsum = 0;
      gTarget.set(0, 0, 0);
      for (let i = 0; i < count; i++) {
        gTarget.addScaledVector(subjects[i], weights[i]);
        wsum += weights[i];
      }
      if (wsum > 0) gTarget.multiplyScalar(1 / wsum);
      else gTarget.copy(frame.target);
      let spread = 0;
      for (let i = 0; i < count; i++) {
        const p = subjects[i];
        const d = Math.hypot(p.x - gTarget.x, (p.y - gTarget.y) * 0.7, p.z - gTarget.z);
        spread = Math.max(spread, d);
      }
      // keep the arena centre in mind, and never leave the arena too far
      gTarget.lerp(frame.target, count ? 0.22 : 1);
      tmp.subVectors(gTarget, frame.target);
      tmp.y = 0;
      const lim = frame.maxDistance * 0.45;
      if (tmp.length() > lim) {
        tmp.setLength(lim);
        gTarget.x = frame.target.x + tmp.x;
        gTarget.z = frame.target.z + tmp.z;
      }
      gTarget.y = Math.max(gTarget.y, frame.target.y - 2.5);
      const fit = (spread + 1.1) / Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
      gDist = THREE.MathUtils.clamp(fit * 0.9 + 1.5, frame.minDistance, frame.maxDistance);
      if (hasPrimary && gYawOff !== 0) gTarget.lerp(primary, 0.35);
      gYaw = frame.yaw + Math.sin(time * 0.11) * 0.05;
      gPitch = frame.pitch + Math.sin(time * 0.083 + 1) * 0.02;
    } else if (mode === 'focus') {
      gTarget.copy(focusP);
      gTarget.y += 0.32; // the beast sits a bit low in the frame, under the winner banner
      gDist = focusDist;
      updateFocusOffset(dt);
      gYaw = focusFacing + Math.PI + 0.35 + focusOff;
      gPitch = FOCUS_PITCH;
    } else if (mode === 'orbit') {
      orbitYaw += dt * 0.32;
      gTarget.copy(focusP);
      gTarget.y += 0.3;
      gDist = focusDist;
      gYaw = orbitYaw;
      gPitch = 0.2 + Math.sin(time * 0.4) * 0.05;
    }
  }

  /**
   * Free fraction (0..1) of the sight lines to a camera at yaw y / pitch p (around the goal target):
   * 60 % the primary subject (the human), 40 % the mean over the subjects (only that without a
   * primary). Static geometry only (walls, the mill body); tree crowns are handled separately.
   */
  function sightFree(y: number, p: number): number {
    if (!physics) return 1;
    probeDir.set(Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p));
    camP.copy(gTarget).addScaledVector(probeDir, -gDist);
    if (count === 0) return sightFrom(hasPrimary ? primary : gTarget);
    let s = 0;
    const n = Math.min(count, 6);
    for (let i = 0; i < n; i++) s += sightFrom(subjects[i]);
    return hasPrimary ? 0.6 * sightFrom(primary) + 0.4 * (s / n) : s / n;
  }

  function sightFrom(from: THREE.Vector3): number {
    origin.copy(from);
    origin.y += 0.6;
    probeCam.copy(camP).sub(origin);
    const len = probeCam.length();
    if (len < 0.5) return 1;
    probeCam.multiplyScalar(1 / len);
    const hit = physics!.raycast(origin, probeCam, len);
    if (!hit || (hit.tag && IGNORE_TAG.test(hit.tag))) return 1;
    return hit.distance / len;
  }

  /** Find the tree trunks around the arena and estimate their crowns (props: trunk collider radius = trunkRadius · scale · 1.1). */
  function scanCrowns(): void {
    if (!physics) return;
    const P = physics;
    crowns.length = 0;
    try {
      const shape = new P.RAPIER.Ball(frame.maxDistance + 30);
      P.world.intersectionsWithShape(frame.target, { x: 0, y: 0, z: 0, w: 1 }, shape, (col: { handle: number; translation(): THREE.Vector3Like; radius?(): number; halfHeight?(): number }) => {
        if (P.tagOf(col.handle) !== 'tree') return true;
        const t = col.translation();
        const r = col.radius?.() ?? 0.3;
        const base = t.y - (col.halfHeight?.() ?? 1.5);
        const big = r > 0.21; // lindes (~0.33 m) vs. small ornamental trees (~0.14 m)
        const H = THREE.MathUtils.clamp(big ? 14 * (r / 0.33) : 6.5 * (r / 0.143), big ? 7 : 3.5, big ? 24 : 11);
        const bottom = base + H * 0.3;
        const top = base + H;
        crowns.push({ x: t.x, y: (bottom + top) / 2, z: t.z, h: (top - bottom) / 2, r: H * (big ? 0.33 : 0.35) });
        return true;
      });
    } catch (e) {
      console.warn('[camera] boomkruinen zoeken mislukt', e);
    }
  }

  /** True when a tree crown (ellipsoid) hides p from the camera at c. */
  function crownBlocks(p: THREE.Vector3, c: THREE.Vector3): boolean {
    const dx = c.x - p.x;
    const dy = c.y - p.y;
    const dz = c.z - p.z;
    for (let i = 0; i < crowns.length; i++) {
      const k = crowns[i];
      const s = k.r / k.h;
      const px = p.x - k.x;
      const py = (p.y - k.y) * s;
      const pz = p.z - k.z;
      const ey = dy * s;
      const ee = dx * dx + ey * ey + dz * dz;
      let t = ee > 1e-6 ? -(px * dx + py * ey + pz * dz) / ee : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px + dx * t;
      const qy = py + ey * t;
      const qz = pz + dz * t;
      const lim = k.r * CROWN_SOLID;
      if (qx * qx + qy * qy + qz * qz < lim * lim) return true;
    }
    return false;
  }

  /** Probe points: the subjects (chests) and a ring of arena samples around the goal target. */
  function buildProbePoints(): number {
    let n = 0;
    nSubj = 0;
    for (let i = 0; i < count && n < probePts.length - 5; i++) {
      probePts[n].copy(subjects[i]);
      probePts[n].y += 0.25;
      probeW[n++] = weights[i];
      nSubj = n;
    }
    let spread = 3;
    for (let i = 0; i < count; i++) spread = Math.max(spread, Math.hypot(subjects[i].x - gTarget.x, subjects[i].z - gTarget.z));
    const R = Math.min(spread + 1.5, 9);
    probeR = R;
    const ring = [[0, 0, 0.5], [R, 0, 0.3], [-R, 0, 0.3], [0, R, 0.3], [0, -R, 0.3]] as const;
    for (const [x, z, w] of ring) {
      probePts[n].set(gTarget.x + x, gTarget.y, gTarget.z + z);
      probeW[n++] = w;
    }
    // the drops (water edge / stage rim) near the action must be visible too
    if (edgeTest) {
      const R2 = THREE.MathUtils.clamp(spread + 3, 5, 12);
      for (let k = 0; k < 16 && n < probePts.length; k++) {
        const a = (k / 16) * Math.PI * 2;
        const p = probePts[n].set(gTarget.x + Math.sin(a) * R2, gTarget.y, gTarget.z + Math.cos(a) * R2);
        if (edgeTest(p) < 1.6) probeW[n++] = EDGE_W;
      }
    }
    return n;
  }

  /** View quality (0..1) of a camera at yaw y / pitch p: tree crowns for all probes, walls for the primary. */
  function viewScore(y: number, p: number, n: number): number {
    let crown = 1;
    if (crowns.length) {
      dir.set(Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p));
      camP.copy(gTarget).addScaledVector(dir, -gDist);
      let vis = 0;
      let wsum = 0;
      for (let i = 0; i < n; i++) {
        wsum += probeW[i];
        // crowns in front of the fighters themselves are dithered away (brawl/treeCut.ts)
        if (i < nSubj || !crownBlocks(probePts[i], camP)) vis += probeW[i];
      }
      // the bottom of the screen (ground between the action and the camera): foreground crowns
      const fx = Math.sin(y);
      const fz = Math.cos(y);
      const R = probeR * 1.15;
      for (const side of [-0.8, 0, 0.8]) {
        fgP.set(gTarget.x - fx * R + fz * side * R, gTarget.y, gTarget.z - fz * R - fx * side * R);
        wsum += 0.3;
        if (!crownBlocks(fgP, camP)) vis += 0.3;
      }
      crown = wsum > 0 ? vis / wsum : 1;
      // never park the camera in (or right next to) a crown
      for (const k of crowns) {
        const s = k.r / k.h;
        const dx = camP.x - k.x;
        const dy = (camP.y - k.y) * s;
        const dz = camP.z - k.z;
        if (dx * dx + dy * dy + dz * dz < k.r * k.r * 1.3) {
          crown *= 0.3;
          break;
        }
      }
    }
    const wall = sightFree(y, p);
    return crown * (wall >= 0.92 ? 1 : 0.35 + 0.6 * wall);
  }

  /**
   * Re-plan the view offset every 0.25 s. While snapping (round start) any yaw is allowed; during
   * play the camera only swings by up to MAX_SWING at a time (camera-relative controls).
   */
  function updateViewOffset(dt: number, snapping = false): void {
    if (!physics || mode !== 'frame') {
      gYawOff = 0;
      gPitchOff = 0;
    } else if ((probeT -= dt) <= 0) {
      probeT = 0.25;
      holdT -= 0.25;
      if (scanAt.length && time >= scanAt[0]) {
        scanAt.shift();
        scanCrowns();
      }
      const GOOD = 0.9;
      const CLEAR = 0.97;
      const MAX_SWING = 0.85;
      const n = buildProbePoints();
      const cur = viewScore(gYaw + gYawOff, gPitch + gPitchOff, n);
      const atDefault = gYawOff === 0 && gPitchOff === 0;
      const free = snapping || time < freeUntil;
      const reachable = (o: number) => free || Math.abs(wrap(o - gYawOff)) <= MAX_SWING;
      // back to the arena's own view as soon as it is clear again; re-plan when the current one is blocked
      const hold = !free && holdT > 0 && cur >= GOOD - 0.15;
      if (hold) {
        // keep the current view a little longer
      } else if (!atDefault && reachable(0) && viewScore(gYaw, gPitch, n) >= CLEAR) {
        holdT = 2.5;
        gYawOff = 0;
        gPitchOff = 0;
      } else if (cur < CLEAR) {
        // first clear view in PROBES order (small swings first), else the best clearly better one
        let best: readonly [number, number] = [gYawOff, gPitchOff];
        let bestS = cur + (cur < GOOD ? 0.05 : 0.08);
        for (const o of PROBES) {
          if (!reachable(o[0])) continue;
          const s = viewScore(gYaw + o[0], gPitch + o[1], n) - Math.abs(o[0]) * 0.02;
          if (s >= CLEAR - 0.04) {
            best = o;
            break;
          }
          if (s > bestS) {
            bestS = s;
            best = o;
          }
        }
        if (best[0] !== gYawOff || best[1] !== gPitchOff) holdT = 2.5;
        gYawOff = best[0];
        gPitchOff = best[1];
      }
    }
    yawOff += wrap(gYawOff - yawOff) * damp(1.3, dt);
    pitchOff += (gPitchOff - pitchOff) * damp(1.3, dt);
  }

  /** Distance along the unit ray (o, u) to the first tree crown, maxLen when none (0 = inside one). */
  function crownEntry(o: THREE.Vector3, u: THREE.Vector3, maxLen: number): number {
    let best = maxLen;
    for (let i = 0; i < crowns.length; i++) {
      const k = crowns[i];
      const s = k.r / k.h;
      const ox = o.x - k.x;
      const oy = (o.y - k.y) * s;
      const oz = o.z - k.z;
      const dy = u.y * s;
      const R = k.r * 0.9;
      const a = u.x * u.x + dy * dy + u.z * u.z;
      const b = 2 * (ox * u.x + oy * dy + oz * u.z);
      const c = ox * ox + oy * oy + oz * oz - R * R;
      if (c < 0) return 0;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  /** Is the winner-zoom camera at yaw y free of walls and tree crowns? */
  function focusClear(y: number): boolean {
    const p = FOCUS_PITCH;
    tmp.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
    origin.copy(focusP);
    origin.y += 0.32;
    const len = focusDist + 0.6;
    if (crownEntry(origin, tmp, len) < len) return false;
    const hit = physics?.raycast(origin, tmp, len);
    return !hit || (!!hit.tag && IGNORE_TAG.test(hit.tag));
  }

  function updateFocusOffset(dt: number): void {
    if ((focusProbeT -= dt) > 0) return;
    focusProbeT = 0.4;
    const base = focusFacing + Math.PI + 0.35;
    if (focusClear(base + focusOff)) return;
    for (const o of FOCUS_PROBES) {
      if (focusClear(base + o)) {
        focusOff = o;
        return;
      }
    }
  }

  function placeCamera(dt: number): void {
    const cam = engine.camera;
    if (cam.fov !== FOV) {
      cam.fov = FOV;
      cam.updateProjectionMatrix();
    }
    // KO punch-in: decays over ~1.2 s
    let d = dist;
    look.copy(target);
    if (punch > 0) {
      const e = Math.sin(Math.min(1, punch) * Math.PI) * punchAmount;
      d *= 1 - 0.3 * e;
      look.lerp(punchP, 0.35 * e);
      punch -= dt / 1.3;
    }
    const y = yaw + yawOff;
    const pt = Math.min(1.25, pitch + pitchOff);
    dir.set(Math.sin(y) * Math.cos(pt), -Math.sin(pt), Math.cos(y) * Math.cos(pt));
    // clearance: ray from the subject (raised) back towards the camera
    if (physics) {
      origin.copy(look);
      origin.y += 0.8;
      tmp.copy(dir).multiplyScalar(-1);
      const hit = physics.raycast(origin, tmp, d + 0.6);
      let c = d + 5;
      // (a hit at ~0 means the look point is inside a solid, e.g. the mill body: the yaw search
      // handles that case, pulling the camera in would only put it inside the wall)
      if (hit && hit.distance > 0.25 && !(hit.tag && IGNORE_TAG.test(hit.tag))) c = Math.max(d * 0.45, hit.distance - 0.6);
      // close-ups (winner zoom, orbit) also stay out of tree crowns
      if (mode === 'focus' || mode === 'orbit') {
        const ce = crownEntry(origin, tmp, d + 0.6);
        if (ce < d + 0.6) c = Math.min(c, Math.max(1, ce - 0.5));
      }
      // pull in fast, let go slowly
      clearance = c < clearance ? c : clearance + (c - clearance) * damp(1.2, dt);
      d = Math.min(d, clearance);
    }
    cam.position.copy(look).addScaledVector(dir, -d);
    if (shake > 0.001) {
      const s = shake * 0.12;
      cam.position.x += (Math.sin(time * 71) + Math.sin(time * 37)) * s;
      cam.position.y += (Math.sin(time * 63) + Math.sin(time * 29)) * s;
      shake *= Math.exp(-dt * 7);
    }
    cam.lookAt(look);
    engine.setFocus(look);
  }

  return {
    get mode() {
      return mode;
    },
    setFrame(f) {
      frame = { ...f, target: f.target.clone() };
      crowns.length = 0;
      scanAt = [time + 0.3, time + 1.5, time + 4];
      gYawOff = gPitchOff = 0;
      snapNext = true;
    },
    setEdgeTest(fn) {
      edgeTest = fn;
    },
    setPrimary(p) {
      hasPrimary = !!p;
      if (p) primary.copy(p);
    },
    setSubjects(points, w) {
      count = Math.min(points.length, 16);
      for (let i = 0; i < count; i++) {
        if (!subjects[i]) subjects[i] = new THREE.Vector3();
        subjects[i].copy(points[i]);
        weights[i] = w[i] ?? 1;
      }
    },
    focus(p, facing, distance = 3.4) {
      if (mode !== 'focus') {
        focusOff = 0;
        focusProbeT = 0;
      }
      focusP.copy(p);
      focusFacing = facing;
      focusDist = distance;
      mode = 'focus';
    },
    orbit(p, distance = 4.6) {
      focusP.copy(p);
      focusDist = distance;
      if (mode !== 'orbit') orbitYaw = yaw;
      mode = 'orbit';
    },
    release() {
      mode = 'frame';
    },
    setManual(on) {
      if (on) mode = 'manual';
      else if (mode === 'manual') {
        mode = 'frame';
        snapNext = true;
      }
    },
    punchIn(p, amount = 1) {
      punchP.copy(p);
      punch = 1;
      punchAmount = Math.min(1, amount);
    },
    shake(a) {
      shake = Math.min(1.5, shake + a);
    },
    snap() {
      snapNext = true;
    },
    get target() {
      return target;
    },
    update(dt) {
      time += dt;
      if (mode === 'manual') return;
      computeGoals(dt);
      if (snapNext) {
        target.copy(gTarget);
        dist = gDist;
        yaw = gYaw;
        pitch = gPitch;
        clearance = gDist + 5;
        snapNext = false;
        probeT = 0;
        if (!crowns.length) scanCrowns();
        freeUntil = time + 4.5;
        updateViewOffset(0, true);
        yawOff = gYawOff;
        pitchOff = gPitchOff;
      } else {
        // OrbitLerpSpeed 0.075 / frame @ 60 fps ≈ 4.7 /s; focus flies a bit slower and eases
        const kT = mode === 'frame' ? 3.2 : 2.2;
        target.lerp(gTarget, damp(kT, dt));
        dist += (gDist - dist) * damp(mode === 'frame' ? 1.8 : 2.0, dt);
        yaw += wrap(gYaw - yaw) * damp(mode === 'frame' ? 2 : 1.6, dt);
        pitch += (gPitch - pitch) * damp(2, dt);
        updateViewOffset(dt);
      }
      placeCamera(dt);
    },
    get debug() {
      return {
        target, distance: dist, clearance, yaw, pitch, yawOffset: yawOff, pitchOffset: pitchOff, crowns: crowns.length,
        scores: () => {
          const n = buildProbePoints();
          return { probes: n, edge: probeW.slice(0, n).filter((w) => w === EDGE_W).length, s: PROBES.map((o) => [o[0], o[1], +viewScore(gYaw + o[0], gPitch + o[1], n).toFixed(2)]) };
        },
      };
    },
  };
}
