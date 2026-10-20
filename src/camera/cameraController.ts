// Player cameras (owned by the Vehicle module): chase (default), bumper, hood and orbit.
//
// Chase: spring-damped yaw around the car (smooth on turns, a touch of drift angle), height
// ~1.7 m above the roof, look-ahead with speed, speed-dependent FOV (60 -> 75) and distance,
// raycast against the static physics world so it never clips into buildings, right mouse /
// right stick to look around. Orbit: drag with the mouse around the car; when idle while
// driving it swings back into chase mode. Impacts add a short camera shake.
import * as THREE from 'three';
import type { Engine, PhysicsWorld, PlayerVehicle } from '../contracts';
import { castRayStatic } from '../physics/physics';

export type CameraMode = 'chase' | 'bumper' | 'hood' | 'orbit';
const MODES: CameraMode[] = ['chase', 'bumper', 'hood', 'orbit'];

export interface CameraController {
  readonly mode: CameraMode;
  readonly camera: THREE.PerspectiveCamera;
  setMode(mode: CameraMode): void;
  /** Next mode (chase -> bumper -> hood -> orbit -> chase). Returns the new mode. */
  cycleMode(): CameraMode;
  /** Add camera shake (0..1). */
  shake(amount: number): void;
  /** Skip smoothing for the next frame (after teleports / resets). */
  snap(): void;
  /** When disabled the controller leaves engine.camera alone (menus, photo mode). */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

interface VehicleLike extends PlayerVehicle {
  readonly dims?: { length: number; width: number; height: number; wheelbase: number };
  readonly localAcceleration?: THREE.Vector3;
  readonly forwardSpeed?: number;
}

interface DampState {
  v: number;
}

/** Critically damped spring (Unity-style SmoothDamp). */
function smoothDamp(cur: number, target: number, st: DampState, smoothTime: number, dt: number): number {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (st.v + omega * change) * dt;
  st.v = (st.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

export function createCameraController(engine: Engine, target: PlayerVehicle, physics?: PhysicsWorld): CameraController {
  const car = target as VehicleLike;
  let camera = engine.camera;
  const dims = car.dims ?? {
    length: car.spec.length,
    width: car.spec.width,
    height: car.spec.height,
    wheelbase: car.spec.wheelbase,
  };

  let mode: CameraMode = 'chase';
  let enabled = true;
  let snapNext = true;

  // Chase state
  let camYaw = car.heading;
  const yawDamp: DampState = { v: 0 };
  let smoothY = car.position.y;
  const yDamp: DampState = { v: 0 };
  let dist = 0;
  const distDamp: DampState = { v: 0 };
  let clipDist = Infinity;
  let fov = 60;
  let lookYaw = 0;
  let lookPitch = 0;
  let trauma = 0;
  let time = 0;
  const lastCarPos = car.position.clone();

  // Orbit state
  let orbitAz = 0;
  let orbitEl = 0.35;
  let orbitRadius = 7;
  let orbitIdle = 0;

  // Mouse
  let rightDown = false;
  let leftDown = false;
  let lastMouseInput = -1e9;

  const tmpPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();
  const tmpFwd = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const pivot = new THREE.Vector3();

  function onPointerDown(e: PointerEvent): void {
    if (!enabled) return;
    if (e.button === 2) rightDown = true;
    if (e.button === 0 && mode === 'orbit') leftDown = true;
    if (rightDown || leftDown) engine.canvas.setPointerCapture?.(e.pointerId);
    lastMouseInput = time;
  }
  function onPointerUp(e: PointerEvent): void {
    if (e.button === 2) rightDown = false;
    if (e.button === 0) leftDown = false;
    engine.canvas.releasePointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: PointerEvent): void {
    if (!enabled) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (mode === 'orbit' && (leftDown || rightDown)) {
      orbitAz -= dx * 0.006;
      orbitEl = clamp(orbitEl + dy * 0.005, -0.05, 1.35);
      lastMouseInput = time;
      orbitIdle = 0;
    } else if (rightDown && mode === 'chase') {
      lookYaw = wrapAngle(lookYaw - dx * 0.006);
      lookPitch = clamp(lookPitch + dy * 0.004, -0.35, 0.6);
      lastMouseInput = time;
    }
  }
  function onWheel(e: WheelEvent): void {
    if (!enabled || mode !== 'orbit') return;
    orbitRadius = clamp(orbitRadius * (1 + Math.sign(e.deltaY) * 0.1), 3.5, 18);
    orbitIdle = 0;
    lastMouseInput = time;
  }
  function onContextMenu(e: Event): void {
    e.preventDefault();
  }
  const canvas = engine.canvas;
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  canvas.addEventListener('contextmenu', onContextMenu);

  function readRightStick(): { x: number; y: number } {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
      return { x: dz(p.axes[2] ?? 0), y: dz(p.axes[3] ?? 0) };
    }
    return { x: 0, y: 0 };
  }

  function setFov(target: number): void {
    if (Math.abs(camera.fov - target) > 0.01) {
      camera.fov = target;
      camera.updateProjectionMatrix();
    }
  }

  function speedOf(): number {
    if (typeof car.forwardSpeed === 'number') return car.forwardSpeed;
    tmpFwd.set(Math.sin(car.heading), 0, Math.cos(car.heading));
    return car.velocity.dot(tmpFwd);
  }

  /** Clip distance from pivot towards dir (normalised), static world only. */
  function clipAlong(px: number, py: number, pz: number, dx: number, dy: number, dz: number, maxD: number): number {
    if (!physics) return maxD;
    const hit = castRayStatic(physics, px, py, pz, dx, dy, dz, maxD + 0.4);
    return hit === null ? maxD : Math.max(0.6, Math.min(maxD, hit - 0.4));
  }

  function updateChase(dt: number): void {
    const v = speedOf();
    const speed = Math.abs(v);
    const speedN = clamp(speed / 44, 0, 1); // 0..160 km/h
    const pos = car.position;

    // Yaw: follow heading, lean a little into the velocity direction while drifting.
    let targetYaw = car.heading;
    if (v > 3) {
      const velYaw = Math.atan2(car.velocity.x, car.velocity.z);
      targetYaw += clamp(wrapAngle(velYaw - car.heading), -0.6, 0.6) * 0.35;
    }
    const yawSmooth = 0.32 - 0.14 * speedN;
    const diff = wrapAngle(targetYaw - camYaw);
    camYaw = snapNext ? targetYaw : wrapAngle(targetYaw - smoothDamp(diff, 0, yawDamp, yawSmooth, dt));

    // Mouse / stick free look, springs back when released.
    const stick = readRightStick();
    if (Math.abs(stick.x) > 0 || Math.abs(stick.y) > 0) {
      lookYaw = wrapAngle(lookYaw - stick.x * 2.6 * dt);
      lookPitch = clamp(lookPitch + stick.y * 1.4 * dt, -0.35, 0.6);
      lastMouseInput = time;
    } else if (!rightDown) {
      const k = 1 - Math.exp(-dt * 3.2);
      lookYaw *= 1 - k;
      lookPitch *= 1 - k;
    }

    // Vertical smoothing (keeps bumps out of the camera, but follows ramps).
    smoothY = snapNext ? pos.y : smoothDamp(smoothY, pos.y, yDamp, 0.12, dt);

    // Distance grows with speed and briefly with acceleration (sense of thrust / braking).
    const accZ = car.localAcceleration?.z ?? 0;
    const baseDist = dims.length * 0.5 + 4.5 + speedN * 1.0;
    const targetDist = baseDist + clamp(accZ * 0.05, -0.5, 0.5);
    dist = snapNext ? targetDist : smoothDamp(dist, targetDist, distDamp, 0.35, dt);

    const height = dims.height + 1.7 + speedN * 0.15;
    const yaw = camYaw + lookYaw;
    const pitchExtra = lookPitch;
    const horiz = dist * Math.cos(pitchExtra);
    const offX = -Math.sin(yaw) * horiz;
    const offZ = -Math.cos(yaw) * horiz;
    const offY = height - dims.height * 0.75 + dist * Math.sin(pitchExtra);

    // Collision against buildings: ray from a pivot above the car towards the desired spot.
    pivot.set(pos.x, smoothY + dims.height * 0.75, pos.z);
    const len = Math.hypot(offX, offY, offZ);
    const want = clipAlong(pivot.x, pivot.y, pivot.z, offX / len, offY / len, offZ / len, len);
    clipDist = snapNext || want < clipDist ? want : Math.min(want, clipDist + dt * 4);
    const s = clipDist / len;
    // When a wall pulls the camera in, lift it so the view goes over the roof instead of
    // staring at the rear window.
    const lift = (1 - s) * 1.9;
    tmpPos.set(pivot.x + offX * s, pivot.y + offY * s + lift, pivot.z + offZ * s);
    // Keep above the street (e.g. when the car is on a quay edge).
    if (physics) {
      const g = physics.raycastDown(tmpPos.x, tmpPos.z, tmpPos.y + 1);
      if (g !== null && tmpPos.y < g + 0.5) tmpPos.y = g + 0.5;
    }

    // Look target: slightly ahead of the car.
    const ahead = clamp(1.2 + speed * 0.12, 1.2, 6.5) * (v < -1 ? 0.3 : 1);
    tmpLook.set(
      pos.x + Math.sin(camYaw) * ahead,
      smoothY + dims.height * 0.62 + (1 - s) * 0.4,
      pos.z + Math.cos(camYaw) * ahead,
    );
    camera.position.copy(tmpPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(tmpLook);

    const targetFov = 60 + 15 * Math.pow(speedN, 1.15);
    fov = snapNext ? targetFov : fov + (targetFov - fov) * (1 - Math.exp(-dt * 2.5));
    setFov(fov);
  }

  // Hood / bumper mount points in vehicle space, found by ray casting the car model once, so
  // they sit just above the real hood (or windscreen base) and just in front of the bumper.
  let mounts: { hood: THREE.Vector3; bumper: THREE.Vector3 } | null = null;
  function mountPoints(): { hood: THREE.Vector3; bumper: THREE.Vector3 } {
    if (mounts) return mounts;
    const hood = new THREE.Vector3(0, dims.height * 0.78, dims.wheelbase * 0.5 - 0.15);
    const bumper = new THREE.Vector3(0, 0.55, dims.length * 0.5 + 0.08);
    const root = car.model.root;
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const rc = new THREE.Raycaster();
    const hitLocal = (o: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 | null => {
      const wo = o.clone().applyMatrix4(root.matrixWorld);
      const wd = d.clone().transformDirection(root.matrixWorld);
      rc.set(wo, wd);
      rc.far = 10;
      const hits = rc.intersectObject(car.model.body, true);
      return hits.length ? hits[0].point.clone().applyMatrix4(inv) : null;
    };
    try {
      const h = hitLocal(new THREE.Vector3(0, dims.height + 1, hood.z), new THREE.Vector3(0, -1, 0));
      if (h && h.y > 0.5 && h.y < dims.height + 0.1) hood.y = h.y + 0.2;
      const b = hitLocal(new THREE.Vector3(0, 0.55, dims.length + 1), new THREE.Vector3(0, 0, -1));
      if (b && b.z > dims.length * 0.3) bumper.z = b.z + 0.06;
    } catch {
      /* model without raycastable meshes: keep the estimates */
    }
    mounts = { hood, bumper };
    return mounts;
  }

  function updateMounted(dt: number, hood: boolean): void {
    const q = car.quaternion;
    // Horizon stabilisation: keep 40% of the car's roll and 70% of its pitch.
    tmpE.setFromQuaternion(q, 'YXZ');
    tmpE.z *= 0.4;
    tmpE.x *= 0.7;
    tmpQ.setFromEuler(tmpE);
    const m = mountPoints();
    tmpPos.copy(hood ? m.hood : m.bumper);
    tmpPos.applyQuaternion(q).add(car.position);
    camera.position.copy(tmpPos);
    camera.quaternion.copy(tmpQ);
    // three.js cameras look down -z; the car's forward is +z.
    camera.rotateY(Math.PI);
    camera.rotateX(hood ? -0.07 : -0.02);
    const speedN = clamp(Math.abs(speedOf()) / 44, 0, 1);
    const targetFov = (hood ? 66 : 70) + 10 * speedN;
    fov = snapNext ? targetFov : fov + (targetFov - fov) * (1 - Math.exp(-dt * 2.5));
    setFov(fov);
  }

  function updateOrbit(dt: number): void {
    const pos = car.position;
    orbitIdle += dt;
    const speed = Math.abs(speedOf());
    if (orbitIdle > 4 && speed > 3 && time - lastMouseInput > 4) {
      // Swing back to chase, continuing from the current azimuth.
      camYaw = wrapAngle(orbitAz + Math.PI);
      yawDamp.v = 0;
      mode = 'chase';
      updateChase(dt);
      return;
    }
    if (!leftDown && !rightDown && time - lastMouseInput > 2.5 && speed > 3) {
      // Drift back behind the car while idle.
      const behind = car.heading + Math.PI;
      orbitAz += wrapAngle(behind - orbitAz) * (1 - Math.exp(-dt * 0.8));
    }
    smoothY = smoothDamp(smoothY, pos.y, yDamp, 0.12, dt);
    pivot.set(pos.x, smoothY + dims.height * 0.5, pos.z);
    const ce = Math.cos(orbitEl);
    const dx = Math.sin(orbitAz) * ce;
    const dz = Math.cos(orbitAz) * ce;
    const dy = Math.sin(orbitEl);
    const r = clipAlong(pivot.x, pivot.y, pivot.z, dx, dy, dz, orbitRadius);
    camera.position.set(pivot.x + dx * r, Math.max(pivot.y + dy * r, 0.3), pivot.z + dz * r);
    camera.up.set(0, 1, 0);
    camera.lookAt(pivot);
    fov += (55 - fov) * (1 - Math.exp(-dt * 3));
    setFov(fov);
  }

  function applyShake(dt: number): void {
    trauma = Math.max(0, trauma - dt * 1.6);
    const speed = Math.abs(speedOf());
    const roadBuzz = mode === 'chase' ? 0 : clamp((speed - 15) / 30, 0, 1) * 0.12;
    const amount = trauma * trauma + roadBuzz * 0.05;
    if (amount < 1e-4) return;
    const t = time * 37;
    const nx = Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1.7) * 0.4;
    const ny = Math.sin(t * 1.7 + 0.5) * 0.6 + Math.sin(t * 3.3 + 2.1) * 0.4;
    const nr = Math.sin(t * 1.1 + 3.1) * 0.7 + Math.sin(t * 2.3) * 0.3;
    const mag = mode === 'chase' || mode === 'orbit' ? 0.22 : 0.06;
    camera.position.x += nx * amount * mag;
    camera.position.y += ny * amount * mag;
    camera.rotateZ(nr * amount * 0.03);
  }

  function update(dt: number): void {
    time += dt;
    if (!enabled) return;
    camera = engine.camera;
    if (car.position.distanceToSquared(lastCarPos) > 400) snapNext = true;
    lastCarPos.copy(car.position);

    // Impacts -> shake (normalised by car mass: delta-v of ~5 m/s gives full shake).
    const impact = car.telemetry.impact;
    if (impact > 0) trauma = Math.min(1, trauma + impact / (car.spec.massKg * 5));

    if (mode === 'chase') updateChase(dt);
    else if (mode === 'bumper') updateMounted(dt, false);
    else if (mode === 'hood') updateMounted(dt, true);
    else updateOrbit(dt);
    applyShake(dt);
    camera.updateMatrixWorld();
    snapNext = false;
    engine.setFocus(car.position);
  }

  const offUpdate = engine.onUpdate(update, 50);

  const ctrl: CameraController = {
    get mode() {
      return mode;
    },
    get camera() {
      return camera;
    },
    setMode(m) {
      if (m === mode) return;
      if (m === 'orbit') {
        // Start orbiting from the current view direction.
        orbitAz = Math.atan2(camera.position.x - car.position.x, camera.position.z - car.position.z);
        orbitEl = 0.3;
        orbitRadius = Math.max(5, dims.length + 3);
        orbitIdle = 0;
        lastMouseInput = time;
      }
      if (m === 'chase') {
        camYaw = car.heading;
        yawDamp.v = 0;
        clipDist = Infinity;
      }
      mode = m;
      snapNext = m !== 'orbit';
    },
    cycleMode() {
      ctrl.setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
      return mode;
    },
    shake(amount) {
      trauma = Math.min(1, trauma + amount);
    },
    snap() {
      snapNext = true;
    },
    setEnabled(e) {
      enabled = e;
      if (e) snapNext = true;
    },
    dispose() {
      offUpdate();
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
  return ctrl;
}
