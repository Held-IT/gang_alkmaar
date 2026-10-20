// Arena "Molen van Piet": the fight is on the stage (stelling, ~6.3 m up) of the real mill on the
// Singel bastion. The city's mill is hidden (and its body collider disabled) while this arena owns
// its own copy (buildMolen with arena options): broken / low railing sections so beasts can fall
// off, slightly longer sails on a less tilted shaft so the blades sweep through the front part of the
// stage at chest height. The 4 blades are one kinematic body driven per physics sub-step and synced
// to the visual sails (interpolated). Wind gusts speed the sails up (whoosh + creak). The brick body
// fades out while a fighter is hidden behind it (camera occlusion). A few flour sacks are props.
//
// Mill local frame (buildMolen): +z = front (sails), angle a around the axis: 0 = front, x = sin a.
import * as THREE from 'three';
import type { ArenaContext } from '../brawl/contracts';
import type { ArenaExt } from '../brawl/types';
import { ArenaKit, clamp, playGust, rng } from './common';
import { buildMolen, MOLEN } from '../world/landmarks/molen';
import { MeshBuilder, mat } from '../world/props/util/geom';
import { createPropMaterial } from '../world/props/util/propMaterial';

const SAIL_SCALE = 1.09;
const TILT_DEG = 5;
const SPIN_BASE = 0.3; // rad/s (blade tip ~4 m/s)
const SPIN_GUST = 0.85;
// open (railing-less) front where the blades sweep; wider on the +x side where they leave the stage
const FRONT_OPEN: [number, number] = [-0.32, 0.92];

/** Railing per stage angle (local, 0 = front): open front, two broken gaps, two low parts. */
function railing(a: number): 'full' | 'low' | 'none' {
  const w = Math.atan2(Math.sin(a), Math.cos(a));
  if (w > FRONT_OPEN[0] && w < FRONT_OPEN[1]) return 'none';
  if (w > 1.25 && w < 1.62) return 'low';
  if (w > 2.2 && w < 2.5) return 'none';
  if (w < -1.55 && w > -1.95) return 'none';
  if (w < -2.45 && w > -2.85) return 'low';
  return 'full';
}

function sackGeometry(): THREE.BufferGeometry {
  // jute flour sack: squashed rounded box with a tied neck
  const g = new THREE.SphereGeometry(0.3, 14, 10);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + 0.18 * (1 - Math.abs(y) / 0.3);
    p.setXYZ(i, x * 0.85 * k, y * 1.1, z * 0.62 * k);
  }
  g.computeVertexNormals();
  const b = new MeshBuilder();
  b.add(g, null, { color: 0xb59a6a, rough: 0.95 });
  b.add(new THREE.CylinderGeometry(0.05, 0.09, 0.12, 8), mat(0, 0.36, 0), { color: 0x9c8257, rough: 0.95 });
  b.add(new THREE.TorusGeometry(0.06, 0.015, 4, 10), mat(0, 0.34, 0, Math.PI / 2, 0, 0), { color: 0x5a4630, rough: 0.9 });
  return b.build();
}

export async function create(ctx: ArenaContext): Promise<ArenaExt & { debug: Record<string, unknown> }> {
  const kit = new ArenaKit(ctx, 'molen');
  const world = ctx.world;
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const forceHazard = params.get('hazard') === '1';
  const R = kit.R;

  // ---------------------------------------------------------------- placement (= the city mill)
  const pos = new THREE.Vector3();
  let yaw = Math.atan2(0.6, 0.8);
  const cityMill = world?.landmarks?.molen ?? null;
  if (cityMill) {
    cityMill.updateMatrixWorld(true);
    pos.setFromMatrixPosition(cityMill.matrixWorld);
    yaw = cityMill.rotation.y;
    const was = cityMill.visible;
    cityMill.visible = false;
    kit.onDispose(() => {
      cityMill.visible = was;
    });
    kit.disableColliders((_c, tag) => tag === 'molen');
  } else if (world) {
    const lm = world.osmMeta.landmarks.find((l) => l.id === 'molen_van_piet');
    if (lm) pos.set(lm.x, Math.max(0, world.heightAt(lm.x, lm.z)), lm.z);
  }
  if (!world) {
    const g = new THREE.CircleGeometry(40, 48).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, kit.pbr('grass', 2, 0x58763a));
    m.position.copy(pos);
    kit.add(m, false, true);
    kit.staticBox(pos.x, pos.y - 0.25, pos.z, 40, 0.25, 40, 0, 'ground');
  }

  const mill = buildMolen(world?.materials ?? null, { railing, sailScale: SAIL_SCALE, tiltDeg: TILT_DEG });
  mill.group.position.copy(pos);
  mill.group.rotation.y = yaw;
  mill.group.name = 'arena_molen';
  kit.add(mill.group);
  kit.own({ dispose: () => mill.dispose() });
  mill.group.updateMatrixWorld(true);
  const stage = mill.stage ?? { y: MOLEN.stageY + 0.12, rIn: 4.1, rOut: 7.1 };
  const deckY = pos.y + stage.y;
  const rIn = stage.rIn, rOut = stage.rOut;
  const rMid = (rIn + rOut) / 2;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  /** local (x, z) -> world */
  const LW = (x: number, z: number): [number, number] => [pos.x + x * cosY + z * sinY, pos.z - x * sinY + z * cosY];
  /** local angle -> world angle (heading convention) */
  const WA = (a: number) => a + yaw;

  // ---------------------------------------------------------------- static colliders
  const NSEG = 36;
  for (let k = 0; k < NSEG; k++) {
    const a = ((k + 0.5) / NSEG) * Math.PI * 2;
    const [x, z] = LW(Math.sin(a) * rMid, Math.cos(a) * rMid);
    const ht = rOut * Math.tan(Math.PI / NSEG) + 0.03;
    kit.staticBox(x, deckY - 0.08, z, ht, 0.08, (rOut - rIn) / 2 + 0.05, WA(a), 'stelling', 0.9);
    const kind = railing(a);
    if (kind !== 'none') {
      const h = kind === 'full' ? 1.12 : 0.64;
      const [rx, rz] = LW(Math.sin(a) * (rOut - 0.06), Math.cos(a) * (rOut - 0.06));
      kit.staticBox(rx, deckY + h / 2, rz, ht, h / 2, 0.05, WA(a), 'reling', 0.4);
    }
  }
  // brick body: below the stage, at the stage, above it
  const C = R.ColliderDesc;
  const cyl = (y0: number, y1: number, r: number, tag: string) =>
    kit.staticCollider(C.cylinder((y1 - y0) / 2, r).setTranslation(pos.x, pos.y + (y0 + y1) / 2, pos.z).setFriction(0.5), tag);
  cyl(0, stage.y - 0.4, 4.7, 'molenromp');
  cyl(stage.y - 0.4, stage.y + 4, rIn + 0.04, 'molenromp');
  cyl(stage.y + 4, MOLEN.bodyHeight + 0.2, 3.7, 'molenromp');
  // tail beam (staart) down to the back of the stage + the winding wheel
  {
    const top = new THREE.Vector3(0, MOLEN.capBase + 0.5, -3.3);
    const end = new THREE.Vector3(0, MOLEN.stageY + 0.9, -(rOut + 0.35));
    const mid = top.clone().add(end).multiplyScalar(0.5);
    const len = top.distanceTo(end);
    const dir = top.clone().sub(end).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    const [mx, mz] = LW(mid.x, mid.z);
    kit.staticCollider(C.capsule(len / 2, 0.16).setTranslation(mx, pos.y + mid.y, mz).setRotation(q), 'staart');
    const wc = end.clone().lerp(top, 0.12);
    const [wx, wz] = LW(wc.x + 0.3, wc.z);
    const qw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    qw.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    kit.staticCollider(C.cylinder(0.05, 1.25).setTranslation(wx, pos.y + wc.y, wz).setRotation(qw), 'kruirad');
  }

  // ---------------------------------------------------------------- sails (kinematic)
  const pivot = mill.sailsPivot!;
  const pPivot = new THREE.Vector3();
  const qPivot = new THREE.Quaternion();
  pivot.updateMatrixWorld(true);
  pivot.matrixWorld.decompose(pPivot, qPivot, new THREE.Vector3());
  const s = SAIL_SCALE;
  const blades: THREE.Vector3[] = [];
  const bladeDescs = [0, 1, 2, 3].map((k) => {
    const zOff = k % 2 === 0 ? 0 : -0.48;
    const c = new THREE.Vector3(0.51 * s, 7.475 * s, (zOff + 0.2) * s).applyAxisAngle(new THREE.Vector3(0, 0, 1), (k * Math.PI) / 2);
    blades.push(c);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (k * Math.PI) / 2);
    return C.cuboid(1.54 * s, 5.2 * s, 0.26 * s).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.9).setRestitution(0.2);
  });
  const sailBody = kit.kinematic(bladeDescs, null, 'wieken');
  let theta = mill.sails.rotation.z;
  let thetaPrev = theta;
  let omega = SPIN_BASE;
  const qz = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  const qTmp = new THREE.Quaternion();
  sailBody.place(pPivot, qTmp.copy(qPivot).multiply(qz.setFromAxisAngle(zAxis, theta)));
  kit.onPreStep((dt) => {
    thetaPrev = theta;
    theta += omega * dt;
    if (theta > Math.PI * 2) {
      theta -= Math.PI * 2;
      thetaPrev -= Math.PI * 2;
    }
    sailBody.set(pPivot, qTmp.copy(qPivot).multiply(qz.setFromAxisAngle(zAxis, theta)));
  });
  kit.onUpdate(() => {
    mill.sails.rotation.z = thetaPrev + (theta - thetaPrev) * clamp(kit.physics.alpha, 0, 1);
  }, 15);

  // ---------------------------------------------------------------- flour sacks
  const sackMat = kit.own(createPropMaterial({ name: 'arena_meelzak' }));
  const sackGeo = sackGeometry();
  const r = rng(77);
  const sackSpots = [[-2.35, rMid + 0.6], [-2.05, rMid - 0.3], [2.75, rMid + 0.2]];
  for (const [a, rr] of sackSpots) {
    const [x, z] = LW(Math.sin(a) * rr, Math.cos(a) * rr);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
    const body = kit.dynamic(new THREE.Vector3(x, deckY + 0.36, z), q, [C.roundCuboid(0.2, 0.25, 0.13, 0.06).setMass(22).setFriction(0.9).setRestitution(0.05)], {
      linDamp: 0.2,
      angDamp: 0.8,
      tag: 'meelzak',
    });
    const m = new THREE.Mesh(sackGeo, sackMat);
    m.name = 'arena_meelzak';
    kit.add(m);
    kit.addProp(body, m);
  }

  // ---------------------------------------------------------------- body fade (occlusion)
  const fadeMats: THREE.MeshStandardMaterial[] = [];
  if (mill.parts) {
    for (const m of [mill.parts.body, mill.parts.cap, mill.parts.baard]) fadeMats.push(m.material as THREE.MeshStandardMaterial);
  }
  let fade = 1;
  const setFade = (f: number) => {
    const transparent = f < 0.995;
    for (const m of fadeMats) {
      m.opacity = f;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.depthWrite = !transparent;
      }
    }
  };

  // ---------------------------------------------------------------- per frame
  let clock = 0;
  let gustAt = forceHazard ? 3 : 14 + Math.random() * 8;
  let gustT = -1;
  const GUST_LEN = 7;
  const cam = new THREE.Vector3();
  const update = (dt: number) => {
    clock += dt;
    // gusts: ramp up 1.5 s, hold, ramp down 2 s
    if (gustT < 0 && clock >= gustAt) {
      gustT = 0;
      playGust(GUST_LEN * 0.8, 0.12);
    }
    let target = SPIN_BASE;
    if (gustT >= 0) {
      gustT += dt;
      const u = gustT < 1.5 ? gustT / 1.5 : gustT > GUST_LEN - 2 ? Math.max(0, (GUST_LEN - gustT) / 2) : 1;
      target = SPIN_BASE + (SPIN_GUST - SPIN_BASE) * u * u * (3 - 2 * u);
      if (gustT >= GUST_LEN) {
        gustT = -1;
        gustAt = clock + (forceHazard ? 6 : 16 + Math.random() * 14);
      }
    }
    omega += (target - omega) * Math.min(1, dt * 3);
    // fade the body while a fighter is hidden behind it
    cam.copy(kit.engine.camera.position);
    let hidden = false;
    const cdx = cam.x - pos.x, cdz = cam.z - pos.z;
    const cd = Math.hypot(cdx, cdz);
    if (cd > rIn) {
      kit.forEachBeastPart((x, y, z) => {
        if (hidden || y < deckY - 0.5 || y > deckY + 8) return;
        // part on the far side of the axis and the sight line passing through the body
        const px = x - pos.x, pz = z - pos.z;
        const along = (px * cdx + pz * cdz) / cd;
        if (along > 0) return;
        const sx = cam.x - x, sz = cam.z - z;
        const sl = Math.hypot(sx, sz) || 1;
        const t = clamp(-(px * sx + pz * sz) / (sl * sl), 0, 1);
        const qx = px + sx * t, qz2 = pz + sz * t;
        if (Math.hypot(qx, qz2) < rIn - 0.35) hidden = true;
      });
    }
    const want = hidden ? 0.28 : 1;
    fade += (want - fade) * Math.min(1, dt * 6);
    if (Math.abs(fade - want) < 0.01) fade = want;
    setFade(fade);
  };

  // ---------------------------------------------------------------- camera, spawns
  const camA = 0.7; // camera on the right side of the mill (local angle), looking at the front-right part
  const [tx, tz] = LW(Math.sin(0.2) * (rMid - 0.6), Math.cos(0.2) * (rMid - 0.6));
  const camTarget = new THREE.Vector3(tx, deckY + 0.6, tz);
  const camYaw = Math.atan2(-Math.sin(WA(camA)), -Math.cos(WA(camA)));
  const spawnPoints: { position: THREE.Vector3; facing: number }[] = [];
  for (const deg of [38, 78, 118, 158, -158, -118, -78, -38]) {
    const a = THREE.MathUtils.degToRad(deg);
    const [x, z] = LW(Math.sin(a) * rMid, Math.cos(a) * rMid);
    // face along the ring towards the front
    const tang = WA(a) + (deg > 0 ? -Math.PI / 2 : Math.PI / 2);
    spawnPoints.push({ position: new THREE.Vector3(x, deckY, z), facing: tang });
  }

  return {
    id: 'molen',
    debug: {
      /** mill-local (x, y above the deck, z) -> world */
      local: (x: number, y: number, z: number) => { const [wx, wz] = LW(x, z); return [wx, deckY + y, wz]; },
      sails: () => ({ theta, omega, gust: gustT >= 0 }),
      fade: () => fade,
    },
    name: 'Molen van Piet',
    description: 'Op de stelling van de molen, met wieken die alles van het plankier maaien.',
    root: kit.root,
    spawnPoints,
    floorY: deckY,
    camera: { target: camTarget, yaw: camYaw, pitch: 0.62, minDistance: 14, maxDistance: 26 },
    isOut(p: THREE.Vector3): boolean {
      return p.y < deckY - 1.0;
    },
    edgeDistance(p: THREE.Vector3): number {
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      return Math.max(0, rOut - d);
    },
    clampToArea(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
      let dx = p.x - pos.x, dz = p.z - pos.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        dx = Math.sin(WA(camA));
        dz = Math.cos(WA(camA));
        d = 1;
      }
      const rr = clamp(d, rIn + 0.45, rOut - 0.6);
      out.set(pos.x + (dx / d) * rr, deckY, pos.z + (dz / d) * rr);
      return out;
    },
    update,
    reset() {
      kit.resetProps();
      gustT = -1;
      clock = 0;
      gustAt = forceHazard ? 3 : 14 + Math.random() * 8;
      omega = SPIN_BASE;
      fade = 1;
      setFade(1);
    },
    dispose() {
      setFade(1);
      kit.dispose();
    },
  };
}
