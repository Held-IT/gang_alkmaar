// Arena "Kaasmarkt": a fenced-off part of the Waagplein between the cheese market (in front of De
// Waag) and the canal quay. The quay side is open: whoever goes over the edge lands in the canal.
// The other three sides are dranghekken with a cheering crowd behind them (and more onlookers on the
// far quay). Physics props: loose Gouda wheels, a loaded and an empty draagberrie. Hazard: two cheese
// porters trot along the quay with a loaded barrow every ~25 s (kinematic body, knocks beasts over /
// into the canal), announced by a hand bell.
//
// Layout frame: O = a point on the quay edge, A = unit vector along the quay (northwards),
// W = unit vector from the quay into the square (westwards). Area: a in [-12, 12], w in [0, 20].
import * as THREE from 'three';
import type { Arena, ArenaContext } from '../brawl/contracts';
import {
  ArenaKit, BERRIE_COLOURS, CHEESE, ConvexArea, berrieColliders, berrieGeometry, buildBarriers, cheeseCollider,
  cheeseGeometry, clamp, createCrowd, playBell, rng, type CrowdSpot,
} from './common';
import { buildHumanGeometry, createHumanMaterials } from '../traffic/humanMesh';
import { lathe, MeshBuilder, mat } from '../world/props/util/geom';
import { createPropMaterial } from '../world/props/util/propMaterial';

export type ArenaWithReset = Arena & { reset(): void; readonly floorY: number; debug: Record<string, unknown> };

const HALF_A = 11;
const DEPTH_W = 18;
const PORTER_W = 4.1; // porters' lane (distance from the quay edge)
const PORTER_SPEED = 2.3;

export async function createKaasmarkt(ctx: ArenaContext): Promise<ArenaWithReset> {
  const kit = new ArenaKit(ctx, 'kaasmarkt');
  const world = ctx.world;
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const forceHazard = params.get('hazard') === '1';

  // ---------------------------------------------------------------- frame on the real quay
  const A = new THREE.Vector2(0.19, -0.98).normalize();
  const W = new THREE.Vector2(-A.y, A.x); // perpendicular
  if (W.x > 0) W.multiplyScalar(-1); // westwards (into the square)
  const O = new THREE.Vector2(37.1, -30);
  if (world) {
    // fit the quay line to the real water edge: march from the square towards the canal at several
    // points along the quay, then a least-squares line through the edge points
    const pts: THREE.Vector2[] = [];
    for (let a = -12; a <= 12; a += 2) {
      for (let w = 9; w > -6; w -= 0.1) {
        const x = O.x + A.x * a + W.x * w, z = O.y + A.y * a + W.y * w;
        if (world.isWater(x, z)) {
          pts.push(new THREE.Vector2(x - W.x * 0.05, z - W.y * 0.05));
          break;
        }
      }
    }
    if (pts.length >= 5) {
      const c = new THREE.Vector2();
      for (const p of pts) c.addScaledVector(p, 1 / pts.length);
      let sxx = 0, sxz = 0, szz = 0;
      for (const p of pts) {
        const dx = p.x - c.x, dz = p.y - c.y;
        sxx += dx * dx;
        sxz += dx * dz;
        szz += dz * dz;
      }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
      const dir = new THREE.Vector2(Math.cos(ang), Math.sin(ang));
      if (dir.dot(A) < 0) dir.multiplyScalar(-1);
      A.copy(dir);
      W.set(-A.y, A.x);
      if (W.x > 0) W.multiplyScalar(-1);
      O.copy(c);
    }
  }
  const P = (a: number, w: number): [number, number] => [O.x + A.x * a + W.x * w, O.y + A.y * a + W.y * w];
  const groundY = (x: number, z: number) => (world ? Math.max(0, world.heightAt(x, z)) : 0);
  const [cx0, cz0] = P(0, DEPTH_W / 2);
  const floorY = groundY(cx0, cz0);
  const area = new ConvexArea([P(-HALF_A, 0), P(HALF_A, 0), P(HALF_A, DEPTH_W), P(-HALF_A, DEPTH_W)], [true, false, false, false]);
  const yawA = Math.atan2(A.x, A.y); // heading of +A

  // without the city: a simple square + water so the dev scene still has a stage
  if (!world) {
    const g = new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2);
    const sq = new THREE.Mesh(g, kit.pbr('square_cobbles', 1.2, 0x8f8a80));
    const [sx, sz] = P(0, 15);
    sq.position.set(sx, 0, sz);
    sq.rotation.y = yawA;
    sq.position.addScaledVector(new THREE.Vector3(W.x, 0, W.y), 14.9);
    kit.add(sq, false, true);
    kit.staticBox(sq.position.x, -0.25, sq.position.z, 30, 0.25, 30, yawA, 'ground');
  }

  // ---------------------------------------------------------------- dranghekken
  const LA = HALF_A + 0.35, LW = DEPTH_W + 0.35;
  const lines = [
    { a: P(-LA, 0.25), b: P(-LA, PORTER_W - 1.1) },
    { a: P(-LA, PORTER_W + 1.1), b: P(-LA, LW) },
    { a: P(-LA, LW), b: P(LA, LW) },
    { a: P(LA, LW), b: P(LA, PORTER_W + 1.1) },
    { a: P(LA, PORTER_W - 1.1), b: P(LA, 0.25) },
  ];
  buildBarriers(kit, lines, groundY);
  // invisible beast blockers in the porters' gaps (the kinematic porters ignore static colliders)
  for (const s of [-1, 1]) {
    const [gx, gz] = P(s * LA, PORTER_W);
    kit.staticBox(gx, floorY + 0.8, gz, 0.1, 0.8, 1.15, Math.atan2(-W.y, W.x), 'gate');
  }

  // ---------------------------------------------------------------- crowd
  const r = rng(1769);
  const spots: CrowdSpot[] = [];
  const free = (x: number, z: number) => !world || (!world.isWater(x, z) && !world.isInsideBuilding(x, z));
  const facingTo = (x: number, z: number) => Math.atan2(cx0 - x, cz0 - z);
  const push = (a: number, w: number, jitter = 0.25) => {
    const [x, z] = P(a + (r() - 0.5) * jitter, w + (r() - 0.5) * jitter);
    if (!free(x, z)) return;
    spots.push({ x, y: groundY(x, z), z, facing: facingTo(x, z) + (r() - 0.5) * 0.5 });
  };
  for (const s of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let w = 0.9; w < DEPTH_W + 1; w += 0.85 + r() * 0.35) {
        if (w > PORTER_W - 1.6 && w < PORTER_W + 1.6) continue; // the porters' lane stays free
        if (r() < 0.12 * row) continue;
        push(s * (LA + 0.75 + row * 0.75), w);
      }
    }
  }
  for (let row = 0; row < 3; row++) {
    for (let a = -LA + 0.4; a < LA; a += 0.8 + r() * 0.35) {
      if (r() < 0.1 * row) continue;
      push(a, LW + 0.75 + row * 0.75);
    }
  }
  // onlookers on the opposite quay
  if (world) {
    let far = -1;
    for (let w = -8; w > -30; w -= 0.25) {
      const [x, z] = P(0, w);
      if (!world.isWater(x, z)) {
        far = w - 1.2;
        break;
      }
    }
    if (far < -2) for (let a = -14; a < 14; a += 1.0 + r() * 0.8) push(a, far - r() * 0.8, 0.3);
  }
  const crowd = createCrowd(kit, spots, 42);

  // ---------------------------------------------------------------- cheese + barrows
  const cheeseGeo = cheeseGeometry();
  const cheeseMat = kit.own(createPropMaterial({ name: 'arena_kaas' }));
  const loose: [number, number, number][] = [
    // a, w, stack height index
    [-8.5, 15.5, 0], [-8.5, 15.5, 1], [-8.5, 15.5, 2], [-7.9, 16.2, 0], [-2.2, 17.2, 0], [3.3, 15.8, 0],
    [7.8, 16.8, 0], [7.8, 16.8, 1], [5.5, 10.4, 0], [-4.6, 9.7, 0], [9.5, 7.6, 0], [-10, 6.5, 0],
  ];
  const berrieCheese = 6;
  const nCheese = loose.length + berrieCheese;
  const cheeseMesh = new THREE.InstancedMesh(cheeseGeo, cheeseMat, nCheese);
  cheeseMesh.name = 'arena_kaas';
  kit.add(cheeseMesh);
  let ci = 0;
  const up = new THREE.Vector3(0, 1, 0);
  const addCheese = (x: number, y: number, z: number, q: THREE.Quaternion) => {
    const body = kit.dynamic(new THREE.Vector3(x, y, z), q, [cheeseCollider(kit)], { linDamp: 0.05, angDamp: 0.4, tag: 'kaas' });
    kit.addProp(body, null, { mesh: cheeseMesh, index: ci++, scale: 1 });
  };
  for (const [a, w, k] of loose) {
    const [x, z] = P(a, w);
    const q = new THREE.Quaternion().setFromAxisAngle(up, r() * 6.28);
    addCheese(x, groundY(x, z) + CHEESE.height * (k + 0.5) + 0.004 * k, z, q);
  }
  // barrows
  const berrieMats = kit.own(createPropMaterial({ name: 'arena_berrie' }));
  const berrieSpots: [number, number, number, boolean][] = [
    [-3.5, 13.5, 0.4, true],
    [4.5, 5.8, -0.9, false],
  ];
  berrieSpots.forEach(([a, w, rot, loaded], i) => {
    const [x, z] = P(a, w);
    const gy = groundY(x, z);
    const geo = berrieGeometry(BERRIE_COLOURS[i % BERRIE_COLOURS.length], false);
    const mesh = new THREE.Mesh(geo, berrieMats);
    mesh.name = 'arena_berrie';
    kit.add(mesh);
    const q = new THREE.Quaternion().setFromAxisAngle(up, yawA + rot);
    const body = kit.dynamic(new THREE.Vector3(x, gy + 0.235, z), q, berrieColliders(kit), { linDamp: 0.1, angDamp: 0.5, tag: 'berrie' });
    kit.addProp(body, mesh);
    if (loaded) {
      const lx = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const lz = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      for (let k = 0; k < berrieCheese; k++) {
        const ox = ((k % 2) - 0.5) * 0.4, oz = (Math.floor(k / 2) - 1) * 0.41;
        addCheese(x + lx.x * ox + lz.x * oz, gy + 0.235 + 0.03 + CHEESE.height / 2 + 0.01, z + lx.z * ox + lz.z * oz, q.clone());
      }
    }
  });
  cheeseMesh.count = ci;

  // ---------------------------------------------------------------- porters (hazard)
  const porterGroup = new THREE.Group();
  porterGroup.name = 'arena_kaasdragers';
  const bob = new THREE.Group();
  porterGroup.add(bob);
  const pb = berrieGeometry(BERRIE_COLOURS[2], true);
  const pMesh = new THREE.Mesh(pb, berrieMats);
  pMesh.position.y = 0.78;
  bob.add(pMesh);
  // two porters (white suits) carrying it by the handles
  const hg = buildHumanGeometry();
  const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(2 * size), size);
  const pa = { c0: mk(4), c1: mk(4), c2: mk(4), anim: mk(4) };
  hg.setAttribute('aCol0', pa.c0);
  hg.setAttribute('aCol1', pa.c1);
  hg.setAttribute('aCol2', pa.c2);
  hg.setAttribute('aAnim', pa.anim);
  const hm = createHumanMaterials();
  kit.own(hm.material);
  kit.own(hm.depth);
  const porters = new THREE.InstancedMesh(hg, hm.material, 2);
  porters.customDepthMaterial = hm.depth;
  porters.frustumCulled = false;
  const skin = [[0.93, 0.78, 0.66], [0.85, 0.66, 0.52]];
  for (let i = 0; i < 2; i++) {
    pa.c0.setXYZW(i, 0.95, 0.95, 0.93, 0);
    pa.c1.setXYZW(i, 0.95, 0.95, 0.93, 1);
    pa.c2.setXYZW(i, skin[i][0], skin[i][1], skin[i][2], i * 3);
    pa.anim.setXYZW(i, i * 3.14, 1, 0, 0);
    const m = new THREE.Matrix4().makeTranslation(0, 0, i === 0 ? 1.42 : -1.42);
    porters.setMatrixAt(i, m);
  }
  bob.add(porters);
  // straw hats with a ribbon in the guild colour
  const hb = new MeshBuilder();
  const hatProf: [number, number][] = [[0, 0.115], [0.1, 0.112], [0.115, 0.06], [0.13, 0.012], [0.25, 0.0], [0.26, -0.012], [0.0, -0.012]];
  hb.add(lathe(hatProf, 18), null, { color: 0xe6cf8a, rough: 0.85 });
  hb.add(lathe([[0.121, 0.045], [0.127, 0.012], [0.13, 0.012], [0.124, 0.045]], 18), null, { color: 0x2f7a3a, rough: 0.6 });
  const hatGeo = hb.build();
  for (const z of [1.42, -1.42]) {
    const h = new THREE.Mesh(hatGeo, berrieMats);
    h.position.set(0, 1.74, z + 0.01);
    bob.add(h);
  }
  porterGroup.visible = false;
  kit.add(porterGroup);
  const C = kit.R.ColliderDesc;
  const porterBody = kit.kinematic([C.cuboid(0.42, 0.82, 1.92).setTranslation(0, 0.82, 0).setFriction(0.4)], porterGroup, 'kaasdragers');
  const parkP = new THREE.Vector3(O.x, -400, O.y);
  const tmpP = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  porterBody.place(parkP, tmpQ);

  const START_A = HALF_A + 6;
  let nextRun = forceHazard ? 2 : 12;
  let runT = -1; // time into the current run (s), -1 = idle
  let runDir = 1;
  let walkPhase = 0;
  let belled = false;
  let clock = 0;
  const runLen = (2 * START_A) / PORTER_SPEED;

  kit.onPreStep((dt) => {
    if (runT < 0) return;
    runT += dt;
    if (runT > runLen) {
      runT = -1;
      porterBody.place(parkP, tmpQ.identity());
      return;
    }
    const a = runDir * (-START_A + PORTER_SPEED * runT);
    const [x, z] = P(a, PORTER_W);
    tmpP.set(x, groundY(x, z), z);
    tmpQ.setFromAxisAngle(up, runDir > 0 ? yawA : yawA + Math.PI);
    porterBody.set(tmpP, tmpQ);
    knockPorters(tmpP, runDir > 0 ? yawA : yawA + Math.PI);
  });

  // a kinematic box only shoves balancing beasts aside; whoever the barrow reaches is knocked over
  // (forwards and away from the lane) once per second
  const slots = new Map<number, import('./common').Body[]>();
  const hitAt = new Map<number, number>();
  let simT = 0;
  const knockPorters = (c: THREE.Vector3, heading: number) => {
    simT += 1 / 120;
    const fx = Math.sin(heading), fz = Math.cos(heading);
    kit.beastsBySlot(slots);
    for (const [slot, parts] of slots) {
      if (!parts.length) continue;
      const last = hitAt.get(slot);
      if (last !== undefined && simT - last < 1.0) continue;
      let lat = 0;
      const hit = parts.some((b) => {
        const t = b.translation();
        const rx = t.x - c.x, rz = t.z - c.z;
        const al = rx * fx + rz * fz;
        lat = rx * fz - rz * fx;
        return al > 1.6 && al < 2.5 && Math.abs(lat) < 0.75 && t.y < c.y + 1.8;
      });
      if (!hit) continue;
      hitAt.set(slot, simT);
      const side = lat >= 0 ? 1 : -1;
      const sx = fz * side, sz = -fx * side;
      kit.knock(parts, fx * 4.5 + sx * 2.6, 2.6, fz * 4.5 + sz * 2.6, c.y + 0.7, 1.9);
    }
  };

  // ---------------------------------------------------------------- per-frame
  const focus = new THREE.Vector3();
  const update = (dt: number) => {
    clock += dt;
    const elapsed = clock;
    // schedule porters
    if (runT < 0 && elapsed >= nextRun) {
      runT = 0;
      runDir = -runDir;
      belled = false;
      nextRun = elapsed + runLen + (forceHazard ? 4 : 14 + Math.random() * 12);
      const a = runDir * -START_A;
      const [x, z] = P(a, PORTER_W);
      tmpQ.setFromAxisAngle(up, runDir > 0 ? yawA : yawA + Math.PI);
      porterBody.place(tmpP.set(x, groundY(x, z), z), tmpQ);
    }
    if (runT >= 0 && !belled) {
      belled = true;
      playBell();
    }
    porterGroup.visible = runT >= 0;
    if (runT >= 0) {
      walkPhase += dt * PORTER_SPEED * 3.4;
      pa.anim.setX(0, walkPhase);
      pa.anim.setX(1, walkPhase + Math.PI);
      pa.anim.needsUpdate = true;
      bob.position.y = Math.abs(Math.sin(walkPhase)) * 0.03;
    }
    // crowd: excited by fast / near-the-edge action
    let n = 0, vmax = 0, edge = 0;
    focus.set(0, 0, 0);
    kit.forEachBeastPart((x, y, z, b) => {
      n++;
      focus.x += x;
      focus.y += y;
      focus.z += z;
      const v = b.linvel();
      vmax = Math.max(vmax, Math.hypot(v.x, v.y, v.z));
      const d = area.dropDistance(x, z);
      if (d < 2.5 && area.contains(x, z, -1)) edge = Math.max(edge, 1 - d / 2.5);
    });
    if (n > 0) focus.multiplyScalar(1 / n);
    const excite = clamp(0.15 + vmax / 9 + edge * 0.5 + (runT >= 0 ? 0.3 : 0), 0, 1);
    crowd.update(dt, excite, n > 0 ? focus : null);
  };

  const [tx, tz] = P(0, 9.5);
  const camTarget = new THREE.Vector3(tx, floorY + 0.6, tz);
  // look along the quay towards De Waag (south): canal + tree row on the left, the cheese market and
  // De Waag in the background; the camera stays west of the tree crowns
  const camYaw = Math.atan2(-A.x, -A.y) + 0.09;

  const spawnPoints: { position: THREE.Vector3; facing: number }[] = [];
  for (const w of [6.5, 13.5]) {
    for (const a of [-7.5, -2.5, 2.5, 7.5]) {
      const [x, z] = P(a, w);
      spawnPoints.push({ position: new THREE.Vector3(x, groundY(x, z), z), facing: Math.atan2(cx0 - x, cz0 - z) });
    }
  }

  return {
    id: 'kaasmarkt',
    debug: {
      /** arena frame (a along the quay, w into the square) -> world */
      P: (a: number, w: number) => { const [x, z] = P(a, w); return [x, groundY(x, z), z]; },
      porters: () => ({ runT, runDir, nextRun, clock }),
    },
    name: 'Kaasmarkt',
    description: 'Op het Waagplein naast de kaasmarkt, met de gracht als afgrond en kaasdragers die overal doorheen draven.',
    root: kit.root,
    spawnPoints,
    floorY,
    camera: { target: camTarget, yaw: camYaw, pitch: 0.62, minDistance: 10, maxDistance: 26 },
    isOut(p: THREE.Vector3): boolean {
      if (p.y < floorY - 0.8) return true;
      // thrown over the dranghekken (0.35 m outside the area) into the crowd: out as soon as the
      // chest is clearly past the barrier (there is no way back over it)
      if (!area.contains(p.x, p.z, -0.8)) return true;
      return !!world && p.y < floorY - 0.15 && world.isWater(p.x, p.z);
    },
    edgeDistance(p: THREE.Vector3): number {
      return area.dropDistance(p.x, p.z);
    },
    clampToArea(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
      area.clamp(p.x, p.z, 0.6, out);
      out.y = floorY;
      return out;
    },
    update,
    reset() {
      kit.resetProps();
      runT = -1;
      porterBody.place(parkP, tmpQ.identity());
      porterGroup.visible = false;
      clock = 0;
      nextRun = forceHazard ? 2 : 12;
    },
    dispose() {
      kit.dispose();
    },
  };
}

export { createKaasmarkt as create };
