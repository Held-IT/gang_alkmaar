// Arena "Rondvaartboot": a fight on a canal tour boat that sails through the binnenstad.
//
// Scrolling world (as the Train stage of the reference engine): the boat and its colliders stay put
// at a free spot B on the open Singel (real water there, so swimming / splashes just work and no city
// colliders are near), and the CITY VISUALS glide past: world.root gets the rigid transform
//   render = B + R(phi) (p_city - P(s)),   phi = H0 - h(s)
// for the boat's arc length s along the path (P, h from route.ts). The path is open: the boat sails it
// forth and back (it slows down at the ends and reverses). Everything that must touch the fighters is
// re-created as kinematic bodies moved with the same transform every physics sub-step: the low
// bridges (slices that follow the arch underside of the real bridge, so the visual bridge and its
// collider sweep over the roof together) and the quay walls next to the boat (so a beast thrown
// sideways hits the quay instead of flying through it). world.update() is wrapped so the city's
// distance culling / prop LOD / landmark culling see a proxy camera in city coordinates.
// Lighting: the sun and sky stay fixed (shading stays consistent; in bends the house shadows turn).
// Textures of the city are UV mapped (they move with the geometry); only the very low-frequency macro
// variation and the water ripples are keyed to render-space positions, which is not noticeable.
import * as THREE from 'three';
import type { ArenaContext } from '../../brawl/contracts';
import type { ArenaExt } from '../../brawl/types';
import { WATER_LEVEL } from '../../config';
import type RAPIER from '@dimforge/rapier3d-compat';
import { ArenaKit, ConvexArea, clamp, playHorn, segDist, signTexture, type Kinematic } from '../common';
import { GROUP, castRayStatic } from '../../physics/physics';
import { buildRoute, PATH_WAYPOINTS, type Route, type RouteBridge } from './route';
import { BOAT, BoatFrame, buildBoat } from './model';

const VMAX = 2.8; // m/s
const ACC = 0.35; // m/s^2
const H0 = Math.PI / 2; // boat heading in the physics / render frame (bow towards +x)
const SPRING = WATER_LEVEL - 0.4; // arch springing line (tools/osm/lib/bridges.mjs)
const BRIDGE_TOP = 1.45; // deck + parapet top used for the bridge colliders
const QUAY_WINDOW = 20; // m along the path around the boat with live quay colliders
const QUAY_POOL = 44;

interface BridgeSlice {
  /** lateral offset of the slice centre from the canal centre line (m) */
  u: number;
  /** along-canal positions of the two faces relative to the crossing point */
  f1: number;
  f2: number;
  /** underside (world y) */
  y: number;
}

interface BridgeSpec {
  b: RouteBridge;
  /** heading of the canal (route) at the bridge */
  h: number;
  slices: BridgeSlice[];
  /** true when measured on the city colliders (else the generator formula) */
  measured: boolean;
  sliceAt(u: number): BridgeSlice;
  kin: Kinematic;
  /** underside height (world y) at lateral offset u from the canal centre */
  under(u: number): number;
  live: boolean;
  boards: THREE.Object3D[];
}

interface QuayPiece {
  cx: number;
  cz: number;
  h: number;
  half: number;
  s: number;
  body: Kinematic | null;
}

function findOpenWater(ctx: ArenaContext, x0: number, z0: number): THREE.Vector2 {
  const w = ctx.world;
  if (!w) return new THREE.Vector2(x0, z0);
  const ok = (x: number, z: number) => {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (const r of [0, 8, 16, 24]) if (!w.isWater(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false;
    }
    return true;
  };
  for (let r = 0; r < 200; r += 10) {
    for (let a = 0; a < Math.PI * 2; a += 0.5) {
      const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      if (ok(x, z)) return new THREE.Vector2(x, z);
      if (r === 0) break;
    }
  }
  console.warn('[rondvaartboot] geen open water gevonden, standaardplek gebruikt');
  return new THREE.Vector2(x0, z0);
}

export async function create(ctx: ArenaContext): Promise<ArenaExt & { debug: Record<string, unknown>; readonly warning: number }> {
  const kit = new ArenaKit(ctx, 'rondvaartboot');
  const world = ctx.world;
  const engine = ctx.engine;
  const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const forceHazard = params.get('hazard') === '1';
  const R = kit.R;

  // ---------------------------------------------------------------- route + boat placement
  const route: Route = buildRoute(PATH_WAYPOINTS, world?.map2d?.water ?? null, world ? (world.roadGraph.edges as never) : null, { open: true });
  const L = route.length;
  const Bxz = findOpenWater(ctx, 360, 340);
  const frame = new BoatFrame(new THREE.Vector3(Bxz.x, WATER_LEVEL, Bxz.y), H0);
  const boat = buildBoat(kit, frame);
  const outline = boat.outline;
  const area = new ConvexArea(outline, outline.map(() => true));
  const deckY = WATER_LEVEL + BOAT.deck;
  const roofY = WATER_LEVEL + BOAT.roof;

  // without the city: a plain water plane + bed so the dev scene works
  if (!world) {
    const g = new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x24363a, roughness: 0.1, metalness: 0.2 }));
    kit.own(m.material as THREE.Material);
    m.position.set(Bxz.x, WATER_LEVEL, Bxz.y);
    kit.add(m, false, true);
    kit.staticBox(Bxz.x, WATER_LEVEL - 2.5, Bxz.y, 100, 0.5, 100, 0, 'bodem');
  }

  // ---------------------------------------------------------------- motion state (physics steps)
  let s = L * 0.3, sPrev = s, v = 0, dir = 1;
  /** boat turned around for this round (bow towards -s), so it sails bow first */
  let flip = false;
  let speedScale = 1;
  const pose = { x: 0, z: 0, h: 0 };
  /** city -> render transform for arc length sArc */
  const xf = { c: 1, s: 0, ox: 0, oz: 0, phi: 0 };
  const setXf = (sArc: number) => {
    route.sample(sArc, pose);
    const phi = H0 - pose.h - (flip ? Math.PI : 0);
    xf.phi = phi;
    xf.c = Math.cos(phi);
    xf.s = Math.sin(phi);
    xf.ox = Bxz.x - (pose.x * xf.c + pose.z * xf.s);
    xf.oz = Bxz.y - (-pose.x * xf.s + pose.z * xf.c);
  };
  const toRender = (x: number, z: number, out: THREE.Vector3, y = 0) =>
    out.set(xf.ox + x * xf.c + z * xf.s, y, xf.oz - x * xf.s + z * xf.c);

  // ---------------------------------------------------------------- bridges (kinematic slices)
  const C = R.ColliderDesc;
  const widthAt = (sArc: number) => {
    const i = clamp(Math.round(sArc / route.step), 0, route.x.length - 1);
    const w = route.left[i] + route.right[i];
    return Number.isFinite(w) ? w : NaN;
  };
  const boardTex = kit.own(signTexture(['LAGE BRUG', 'BUKKEN!'], { w: 512, h: 128, bg: '#f2c200', fg: '#141414' }));
  const boardMat = kit.own(new THREE.MeshStandardMaterial({ map: boardTex, roughness: 0.6, emissive: 0x332600, emissiveIntensity: 0.4 }));
  const boardGeo = kit.own(new THREE.PlaneGeometry(2.0, 0.5));
  const debugCol = params.get('debugcol') === '1';
  const debugMat = debugCol ? kit.own(new THREE.MeshBasicMaterial({ color: 0xff2020, wireframe: true })) : null;
  // The bridges are measured on the real city colliders: horizontal rays along the canal at several
  // lateral offsets find the two faces of the bridge body, a binary search in height finds the arch
  // underside (rays below it pass under the bridge). Falls back to the generator's formula
  // (tools/osm/lib/bridges.mjs) without colliders.
  const SLICE = 0.5, ULIM = 3.5;
  /** along-canal coordinate (relative to the crossing point) of the bridge face hit from side sg */
  const faceRay = (b: RouteBridge, h: number, u: number, y: number, sg: -1 | 1): number | null => {
    const dx = Math.sin(h), dz = Math.cos(h), nx = Math.cos(h), nz = -Math.sin(h);
    const X = b.halfLen + 12;
    const ox = b.x + nx * u + sg * dx * X, oz = b.z + nz * u + sg * dz * X;
    const d = castRayStatic(kit.physics, ox, y, oz, -sg * dx, 0, -sg * dz, 2 * X);
    return d === null ? null : sg * (X - d);
  };
  const measure = (b: RouteBridge, h: number): BridgeSlice[] | null => {
    if (!world) return null;
    const face = (u: number, y: number, sg: -1 | 1) => faceRay(b, h, u, y, sg);
    const out: BridgeSlice[] = [];
    for (let u = -ULIM; u < ULIM - 1e-6; u += SLICE) {
      const uc = u + SLICE / 2;
      const f1 = face(uc, 0.35, -1), f2 = face(uc, 0.35, 1);
      if (f1 === null || f2 === null || f2 - f1 < 0.6 || f1 < -b.halfLen - 8 || f2 > b.halfLen + 8) continue;
      const hits = (y: number) => {
        const f = face(uc, y, -1);
        return f !== null && Math.abs(f - f1) < 1.2;
      };
      let lo = WATER_LEVEL + 0.05, hi = 0.35;
      if (hits(lo)) hi = lo;
      else for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2;
        if (hits(mid)) hi = mid;
        else lo = mid;
      }
      out.push({ u: uc, f1, f2, y: hi });
    }
    return out.length >= 3 ? out : null;
  };
  // built lazily on the second physics sub-step: Rapier only answers ray casts against colliders
  // that went through a world step (the city colliders may have just been created)
  let bridges: BridgeSpec[] = [];
  let bridgesBuilt = false;
  const buildBridges = () => {
    bridgesBuilt = true;
    bridges = route.bridges.map(buildBridge);
    const bad = bridges.filter((b) => !b.measured).map((b) => b.b.name);
    if (world && bad.length) console.warn('[rondvaartboot] bruggen niet gemeten (formule gebruikt):', bad.join(', '));
    placeKinematics(true);
  };
  const buildBridge = (b: RouteBridge): BridgeSpec => {
    const i = clamp(Math.round(b.s / route.step), 0, route.x.length - 1);
    const h = route.h[i];
    let slices = measure(b, h);
    let measured = !!slices;
    if (!slices) {
      // formula fallback
      const sinA = Math.max(0.35, Math.abs(Math.sin(b.roadHeading - h)));
      const ws: number[] = [];
      for (const d of [2, 3.5, 5]) for (const sg of [-1, 1]) {
        const w = widthAt(b.s + sg * (b.halfLen + d));
        if (Number.isFinite(w) && w > 3) ws.push(w);
      }
      ws.sort((p1, p2) => p1 - p2);
      const span = clamp((ws.length ? ws[Math.floor(ws.length / 2)] : 10) / sinA, 4, 40);
      const rise = span <= 26 ? Math.min(0.6, Math.max(0.2, 0.035 * span + 0.1)) : 0;
      const crown = rise - 0.45, half = span / 2 + 0.25;
      slices = [];
      for (let u = -ULIM; u < ULIM - 1e-6; u += SLICE) {
        const uc = (u + SLICE / 2) / sinA;
        const y = span <= 16 ? SPRING + (crown - SPRING) * Math.sqrt(Math.max(0, 1 - (uc / half) ** 2)) : Math.max(WATER_LEVEL + 0.4, rise - 0.9);
        slices.push({ u: u + SLICE / 2, f1: -b.halfLen, f2: b.halfLen, y });
      }
      measured = false;
    }
    const sl = slices;
    const sliceAt = (u: number) => sl[clamp(Math.round((u - sl[0].u) / SLICE), 0, sl.length - 1)];
    const under = (u: number) => {
      const q = sliceAt(u);
      return Math.abs(q.u - u) <= SLICE ? q.y : Infinity;
    };
    const descs = [];
    const dbg = debugCol ? new THREE.Group() : null;
    for (const q of sl) {
      const hy = (BRIDGE_TOP - q.y) / 2, hz = (q.f2 - q.f1) / 2, cz = (q.f1 + q.f2) / 2;
      descs.push(C.cuboid(SLICE / 2 + 0.01, hy, hz).setTranslation(q.u, q.y + hy, cz).setFriction(0.6).setRestitution(0.1));
      if (dbg) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(SLICE, hy * 2, hz * 2), debugMat!);
        m.position.set(q.u, q.y + hy, cz);
        dbg.add(m);
      }
    }
    if (dbg) kit.root.add(dbg);
    const kin = kit.kinematic(descs, dbg, 'brug');
    const mid = sliceAt(0);
    // warning boards on both faces (children of the city root: they move with the bridge)
    const boards: THREE.Object3D[] = [];
    if (world) {
      for (const sg of [-1, 1]) {
        const m = new THREE.Mesh(boardGeo, boardMat);
        const fx = Math.sin(h) * sg, fz = Math.cos(h) * sg;
        const f = (sg < 0 ? -mid.f1 : mid.f2) + 0.05;
        m.position.set(b.x + fx * f, Math.min(0.2, mid.y) + 0.3, b.z + fz * f);
        m.rotation.y = Math.atan2(fx, fz);
        m.name = 'arena_brugbord';
        m.castShadow = false;
        world.root.add(m);
        boards.push(m);
      }
    }
    return { b, h, slices: sl, measured, sliceAt, kin, under, live: false, boards };
  };
  kit.onDispose(() => {
    for (const br of bridges) for (const o of br.boards) o.removeFromParent();
  });

  // ---------------------------------------------------------------- quay walls (kinematic pool)
  const pieces: QuayPiece[] = [];
  if (world?.map2d) {
    const near = (x: number, z: number) => {
      // nearest route sample (coarse search every 2 m, then refine)
      let best = Infinity, bi = 0;
      for (let i = 0; i < route.x.length; i += 2) {
        const d = (route.x[i] - x) ** 2 + (route.z[i] - z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      for (let i = Math.max(0, bi - 2); i <= Math.min(route.x.length - 1, bi + 2); i++) {
        const d = (route.x[i] - x) ** 2 + (route.z[i] - z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
        }
      }
      return { i: bi, d: Math.sqrt(best) };
    };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < route.x.length; i++) {
      minX = Math.min(minX, route.x[i]); maxX = Math.max(maxX, route.x[i]);
      minZ = Math.min(minZ, route.z[i]); maxZ = Math.max(maxZ, route.z[i]);
    }
    const inBridge = (sArc: number) => route.bridges.some((rb) => Math.abs(sArc - rb.s) < rb.halfLen + 1.5);
    for (const poly of world.map2d.water) for (const ring of poly) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k], c2 = ring[(k + 1) % ring.length];
        if (Math.max(a[0], c2[0]) < minX - 15 || Math.min(a[0], c2[0]) > maxX + 15 || Math.max(a[1], c2[1]) < minZ - 15 || Math.min(a[1], c2[1]) > maxZ + 15) continue;
        const len = Math.hypot(c2[0] - a[0], c2[1] - a[1]);
        if (len < 0.3) continue;
        const n = Math.max(1, Math.ceil(len / 3));
        for (let j = 0; j < n; j++) {
          const t0 = j / n, t1 = (j + 1) / n;
          const x0 = a[0] + (c2[0] - a[0]) * t0, z0 = a[1] + (c2[1] - a[1]) * t0;
          const x1 = a[0] + (c2[0] - a[0]) * t1, z1 = a[1] + (c2[1] - a[1]) * t1;
          const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
          const nr = near(cx, cz);
          if (nr.d > 12 || nr.d < 2.4) continue;
          const sArc = nr.i * route.step;
          if (inBridge(sArc)) continue;
          const eh = Math.atan2(x1 - x0, z1 - z0);
          if (Math.abs(Math.cos(eh - route.h[nr.i])) < 0.6) continue; // across the canal (cut at bridges / ends)
          // push the box centre 1 m away from the water (towards the land side)
          const lx = route.x[nr.i], lz = route.z[nr.i];
          let ox = cx - lx, oz = cz - lz;
          const ol = Math.hypot(ox, oz) || 1;
          ox /= ol;
          oz /= ol;
          pieces.push({ cx: cx + ox * 1.0, cz: cz + oz * 1.0, h: eh, half: (len / n) / 2 + 0.06, s: sArc, body: null });
        }
      }
    }
    pieces.sort((p, q) => p.s - q.s);
  }
  const quayPool: Kinematic[] = [];
  const freeQuays: Kinematic[] = [];
  const park = new THREE.Vector3(Bxz.x, -300, Bxz.y);
  const qId = new THREE.Quaternion();
  if (pieces.length) {
    for (let k = 0; k < QUAY_POOL; k++) {
      const kin = kit.kinematic([C.cuboid(1.0, 1.75, 1.6).setTranslation(0, -1.75, 0).setFriction(0.7)], null, 'kade');
      kin.place(park, qId);
      quayPool.push(kin);
      freeQuays.push(kin);
    }
  }
  const livePieces = new Set<QuayPiece>();
  let pieceLo = 0;
  const refreshQuays = () => {
    if (!pieces.length) return;
    // pieces in [s - W, s + W]
    while (pieceLo > 0 && pieces[pieceLo - 1].s > s - QUAY_WINDOW) pieceLo--;
    while (pieceLo < pieces.length && pieces[pieceLo].s < s - QUAY_WINDOW) pieceLo++;
    for (const p of livePieces) {
      if (Math.abs(p.s - s) > QUAY_WINDOW + 2) {
        p.body!.place(park, qId);
        freeQuays.push(p.body!);
        p.body = null;
        livePieces.delete(p);
      }
    }
    for (let k = pieceLo; k < pieces.length && pieces[k].s < s + QUAY_WINDOW; k++) {
      const p = pieces[k];
      if (p.body || !freeQuays.length) continue;
      p.body = freeQuays.pop()!;
      livePieces.add(p);
      toRender(p.cx, p.cz, tmpP);
      tmpQ.setFromAxisAngle(up, p.h + xf.phi);
      p.body.place(tmpP, tmpQ);
    }
  };

  // ---------------------------------------------------------------- per physics step
  const tmpP = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const placeKinematics = (teleport: boolean) => {
    setXf(s);
    for (const br of bridges) {
      const near = Math.abs(br.b.s - s) < 45;
      if (!near) {
        if (br.live) {
          br.kin.place(park, qId);
          br.live = false;
        }
        continue;
      }
      toRender(br.b.x, br.b.z, tmpP, 0);
      tmpQ.setFromAxisAngle(up, br.h + xf.phi);
      if (!br.live || teleport) br.kin.place(tmpP, tmpQ);
      else br.kin.set(tmpP, tmpQ);
      br.live = true;
    }
    for (const p of livePieces) {
      toRender(p.cx, p.cz, tmpP, 0);
      tmpQ.setFromAxisAngle(up, p.h + xf.phi);
      if (teleport) p.body!.place(tmpP, tmpQ);
      else p.body!.set(tmpP, tmpQ);
    }
  };
  let simTime = 0;
  let preSteps = 0;
  kit.onPreStep((dt) => {
    simTime += dt;
    if (!bridgesBuilt && ++preSteps >= 2) buildBridges();
    sPrev = s;
    const vmax = VMAX * speedScale;
    // brake for the end of the path, then reverse
    const toEnd = dir > 0 ? L - s : s;
    const brake = (v * v) / (2 * ACC) + 0.5;
    const target = toEnd <= brake ? 0 : dir * vmax;
    v += clamp(target - v, -ACC * dt, ACC * dt);
    if (toEnd <= brake && Math.abs(v) < 0.04) {
      v = 0;
      dir = -dir;
    }
    s = clamp(s + v * dt, 0, L);
    placeKinematics(false);
    smack();
    drift(dt);
  });

  // A bridge face only shoves a balancing beast along the roof at boat speed; to make it a real hit
  // (Gang Beasts style), body parts that the leading face reaches get a one-off impulse backwards
  // and a bit up, so the beast tumbles over (or off the boat).
  const hitAt = new Map<number, number>();
  const smackDbg = { hits: 0, parts: 0, best: 99, yMiss: 0 };
  // Beasts that went overboard drift away with the water (which moves past the boat at -v), so the
  // boat visibly leaves them behind in the canal.
  const drift = (dt: number) => {
    if (Math.abs(v) < 0.05) return;
    const k = 1 - Math.exp(-dt * 4);
    const fx = Math.sin(H0) * (flip ? 1 : -1) * v, fz = Math.cos(H0) * (flip ? 1 : -1) * v; // water velocity (render)
    kit.forEachBeastPart((x, y, z, body) => {
      if (y > WATER_LEVEL + 0.35 || Math.abs(x - Bxz.x) > 30 || Math.abs(z - Bxz.y) > 30) return;
      tmpV2.set(x, y, z);
      if (outsideBy(tmpV2) < 0.4) return;
      const lv = body.linvel();
      const m = body.mass();
      body.applyImpulse({ x: (fx - lv.x) * k * m, y: 0, z: (fz - lv.z) * k * m }, true);
    });
  };
  const slotParts = new Map<number, { body: RAPIER.RigidBody; y: number }[]>();
  const smack = () => {
    const now = simTime;
    if (Math.abs(v) < 0.3) return;
    let any = false;
    for (const br of bridges) if (br.live && Math.abs(br.b.s - s) < br.b.halfLen + BOAT.halfLength + 1) any = true;
    if (!any) return;
    // all beast parts grouped by beast (slot bit of the collision membership)
    for (const l of slotParts.values()) l.length = 0;
    kit.forEachBeastPart((_x, y, _z, body) => {
      const slot = (body.collider(0).collisionGroups() >>> 16) & GROUP.BEAST;
      let l = slotParts.get(slot);
      if (!l) slotParts.set(slot, (l = []));
      l.push({ body, y });
    });
    const sv = Math.sign(v);
    for (const br of bridges) {
      if (!br.live || Math.abs(br.b.s - s) > br.b.halfLen + BOAT.halfLength + 2) continue;
      // bridge frame in render space: origin, along-canal direction, lateral direction
      toRender(br.b.x, br.b.z, tmpP, 0);
      const hx = Math.sin(br.h), hz = Math.cos(br.h);
      const dxr = hx * xf.c + hz * xf.s, dzr = -hx * xf.s + hz * xf.c;
      const nxr = dzr, nzr = -dxr;
      for (const [slot, parts] of slotParts) {
        if (!parts.length) continue;
        const last = hitAt.get(slot);
        if (last !== undefined && now - last < 1.2) continue;
        let hitSlice: BridgeSlice | null = null;
        for (const q of parts) {
          const t = q.body.translation();
          const rx = t.x - tmpP.x, rz = t.z - tmpP.z;
          const al = rx * dxr + rz * dzr, u = rx * nxr + rz * nzr;
          if (Math.abs(u) > ULIM) continue;
          const sl = br.sliceAt(u);
          if (Math.abs(sl.u - u) > SLICE) continue;
          const ahead = sv > 0 ? sl.f1 - al : al - sl.f2; // > 0: in front of the leading face
          smackDbg.parts++;
          smackDbg.best = Math.min(smackDbg.best, Math.abs(ahead));
          if (ahead > 0.62 || ahead < -0.7) continue;
          if (t.y < sl.y - 0.15) {
            smackDbg.yMiss++;
            continue;
          }
          hitSlice = sl;
          break;
        }
        if (!hitSlice) continue;
        hitAt.set(slot, now);
        smackDbg.hits++;
        // whole beast knocked back + up; the parts the face reaches more (it tumbles over)
        const back = 3.0 + Math.abs(v);
        const kx = -sv * dxr, kz = -sv * dzr;
        for (const q of parts) {
          const m = q.body.mass();
          const k = q.y > hitSlice.y - 0.25 ? 1.9 : 1;
          q.body.applyImpulse({ x: m * back * k * kx, y: m * 2.2, z: m * back * k * kz }, true);
        }
      }
    }
  };
  const tmpV2 = new THREE.Vector3();

  // ---------------------------------------------------------------- moving the city (visuals)
  const root = world?.root ?? null;
  const rootM = new THREE.Matrix4();
  const rootInv = new THREE.Matrix4();
  const proxy = new THREE.PerspectiveCamera();
  let sVis = s;
  const applyCity = () => {
    if (!root) return;
    setXf(sVis);
    root.position.set(xf.ox, 0, xf.oz);
    root.rotation.set(0, xf.phi, 0);
    root.updateMatrix();
  };
  kit.onUpdate(() => {
    const a = clamp(kit.physics.alpha, 0, 1);
    sVis = sPrev + (s - sPrev) * a;
    applyCity();
  }, 15);
  if (world && root) {
    const orig = world.update;
    world.update = (dt: number, camPos: THREE.Vector3) => {
      const cam = engine.camera;
      cam.updateMatrixWorld();
      rootM.compose(root.position, root.quaternion, root.scale);
      rootInv.copy(rootM).invert();
      proxy.projectionMatrix.copy(cam.projectionMatrix);
      proxy.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
      proxy.fov = cam.fov;
      proxy.aspect = cam.aspect;
      proxy.near = cam.near;
      proxy.far = cam.far;
      tmpM.multiplyMatrices(rootInv, cam.matrixWorld);
      tmpM.decompose(proxy.position, proxy.quaternion, proxy.scale);
      proxy.updateMatrixWorld(true);
      const p = tmpV.copy(camPos).applyMatrix4(rootInv);
      engine.camera = proxy;
      try {
        orig.call(world, dt, p);
      } finally {
        engine.camera = cam;
      }
    };
    kit.onDispose(() => {
      world.update = orig;
      root.position.set(0, 0, 0);
      root.rotation.set(0, 0, 0);
      root.updateMatrix();
      root.updateMatrixWorld(true);
    });
  }
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();

  // ---------------------------------------------------------------- wake foam
  const foamTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 128, 256);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * 128, y = Math.random() * 256;
      const r = 1 + Math.random() * 3.5;
      g.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.5})`;
      g.beginPath();
      g.ellipse(x, y, r, r * (1.5 + Math.random() * 2), 0, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    return kit.own(t);
  })();
  const foamMat = kit.own(
    new THREE.MeshStandardMaterial({ map: foamTex, transparent: true, opacity: 0.55, depthWrite: false, roughness: 0.7, color: 0xe8eeee, vertexColors: true, blending: THREE.AdditiveBlending }),
  );
  // wake: a fan behind the stern; alpha fades along the length via vertex colours
  const wakeGeo = (() => {
    const g = new THREE.PlaneGeometry(1, 1, 4, 12);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) + 0.5, t = p.getY(i) + 0.5; // t: 0 at the stern .. 1 far behind
      const w = 2.2 + t * 6.5;
      p.setXYZ(i, (u - 0.5) * w, -t * 26, 0);
      const edge = 1 - Math.abs(u - 0.5) * 2;
      const a = (1 - t) * (0.35 + 0.65 * (1 - edge * 0.7));
      col.push(a, a, a);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.rotateX(-Math.PI / 2);
    return kit.own(g);
  })();
  const wakeMat = kit.own(foamMat.clone());
  wakeMat.map = kit.own(foamTex.clone());
  wakeMat.map.wrapS = wakeMat.map.wrapT = THREE.RepeatWrapping;
  wakeMat.map.repeat.set(2, 5);
  const wake = new THREE.Mesh(wakeGeo, wakeMat);
  wake.name = 'boot_kielzog';
  wake.renderOrder = 2;
  boat.group.add(wake);
  wake.castShadow = false;
  wake.receiveShadow = false;
  // bow waves along both sides
  const bowGeo = (() => {
    const g = new THREE.PlaneGeometry(1.0, 6, 3, 10);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col: number[] = [];
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / 1.0 + 0.5, t = 0.5 - p.getY(i) / 6; // t: 0 at the bow .. 1 aft
      const a = 0.6 * Math.sin(Math.PI * u) * Math.pow(1 - t, 1.2) * Math.min(1, t * 5);
      col.push(a, a, a);
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.rotateX(-Math.PI / 2);
    return kit.own(g);
  })();
  const bowWave = new THREE.Mesh(bowGeo, foamMat);
  bowWave.renderOrder = 2;
  const bowWave2 = bowWave.clone();
  boat.group.add(bowWave, bowWave2);

  // ---------------------------------------------------------------- warnings (horn + beacons)
  let warning = 0;
  let hornFor: BridgeSpec | null = null;
  const nextBridge = () => {
    // distance from the leading end of the boat to the near face of the next bridge ahead
    const sign = v >= 0 ? 1 : -1;
    const lead = s + sign * BOAT.halfLength;
    let best: BridgeSpec | null = null, bd = Infinity;
    for (const br of bridges) {
      const face = br.b.s - sign * br.b.halfLen;
      const d = (face - lead) * sign;
      const tail = (br.b.s + sign * br.b.halfLen - (s - sign * BOAT.halfLength)) * sign;
      if (tail < 0) continue; // passed
      if (d < bd) {
        bd = d;
        best = br;
      }
    }
    return { br: best, d: bd };
  };

  const update = (dt: number) => {
    const nb = nextBridge();
    const sp = Math.abs(v);
    const tWarn = 5;
    if (nb.br && nb.d < Math.max(6, sp * tWarn)) {
      warning = Math.min(1, warning + dt * 4);
      if (hornFor !== nb.br && nb.d > 0) {
        hornFor = nb.br;
        playHorn(1.3, 0.2);
      }
    } else warning = Math.max(0, warning - dt * 1.5);
    boat.update(dt, warning, v);
    // wake behind the moving direction (boat-local), scrolling with the speed
    const fwd = (v >= 0) !== flip;
    wake.position.set(0, BOAT.deck - BOAT.deck + 0.02, fwd ? -BOAT.halfLength + 0.2 : BOAT.halfLength - 0.5);
    wake.rotation.y = fwd ? 0 : Math.PI;
    wakeMat.opacity = clamp(sp / VMAX, 0, 1) * 0.6;
    wakeMat.map!.offset.y -= (dt * sp) / 5.2;
    foamMat.map!.offset.y += (dt * sp * (fwd ? 1 : -1)) / 9;
    for (const [m, sx] of [[bowWave, 1], [bowWave2, -1]] as [THREE.Mesh, number][]) {
      // starts at the bow, spreads outwards aft (a V); at the stern when sailing stern first
      const zc = fwd ? 6.2 : -7.6;
      m.position.set(sx * (fwd ? 1.75 : 2.3), 0.015, zc);
      m.rotation.y = (fwd ? 0 : Math.PI) + sx * (fwd ? 0.3 : -0.3);
    }
    foamMat.opacity = clamp(sp / VMAX, 0, 1) * 0.45;
  };

  // ---------------------------------------------------------------- start position
  const startAt = (sArc: number, d: number) => {
    s = sPrev = sVis = clamp(sArc, 0, L);
    dir = d;
    flip = d < 0;
    camFrame.yaw = H0;
    v = dir * VMAX * speedScale * 0.8;
    hornFor = null;
    warning = 0;
    pieceLo = 0;
    setXf(s);
    refreshQuays();
    placeKinematics(true);
    applyCity();
  };
  const randomStart = () => {
    const p = params.get('boatpos');
    if (p !== null && Number.isFinite(Number(p))) return startAt(Number(p), 1);
    if (forceHazard && bridges.length) {
      const br = bridges[Math.floor(Math.random() * bridges.length)];
      const d = br.b.s > L * 0.5 ? 1 : br.b.s < 40 ? 1 : -1;
      return startAt(br.b.s - d * (br.b.halfLen + BOAT.halfLength + 22), d);
    }
    // long enough run ahead (no reversal in a normal round), never right in front of / under a bridge
    for (let k = 0; k < 40; k++) {
      const d = Math.random() < 0.5 ? 1 : -1;
      const s0 = d > 0 ? L * (0.03 + Math.random() * 0.5) : L * (0.47 + Math.random() * 0.5);
      const clear = route.bridges.every((b) => {
        const ahead = (b.s - s0) * d - b.halfLen - BOAT.halfLength;
        return ahead > 28 || ahead < -2 * BOAT.halfLength - 2 * b.halfLen;
      });
      if (clear || k === 39) return startAt(s0, d);
    }
  };
  const camFrame = { target: frame.toWorld(0, BOAT.roof + 0.2, 0.8), yaw: H0, pitch: 0.82, minDistance: 9.5, maxDistance: 21 };
  randomStart();
  // quay pool refresh once per frame (before the physics step)
  kit.onUpdate(() => refreshQuays(), 9.5);

  // ---------------------------------------------------------------- camera, spawns
  const spawnPoints: { position: THREE.Vector3; facing: number }[] = [];
  const spawnLocal: [number, number, number][] = [
    [0.8, BOAT.roof, -2.6], [-0.8, BOAT.roof, 0.6], [0.8, BOAT.roof, 3.8], [-0.8, BOAT.roof, -3.6],
    [-0.8, BOAT.roof, 2.4], [0.8, BOAT.roof, -0.6], [0.9, BOAT.deck, -7.4], [-0.9, BOAT.deck, -8.2],
  ];
  for (const [x, y, z] of spawnLocal) {
    const p = frame.toWorld(x, y, z);
    // face across the boat towards its centre line
    spawnPoints.push({ position: p, facing: H0 + (x > 0 ? -Math.PI / 2 : Math.PI / 2) });
  }
  const loc = new THREE.Vector3();
  const outsideBy = (p: THREE.Vector3) => {
    frame.toLocal(p, loc);
    if (area.contains(loc.x, loc.z)) return 0;
    let d = Infinity;
    for (let i = 0; i < outline.length; i++) d = Math.min(d, segDist(loc.x, loc.z, outline[i], outline[(i + 1) % outline.length]));
    return d;
  };

  return {
    id: 'rondvaartboot',
    name: 'Rondvaartboot',
    description: 'Op een rondvaartboot door de grachten. Bukken voor de lage bruggen!',
    root: kit.root,
    spawnPoints,
    floorY: deckY,
    camera: camFrame,
    get warning() {
      return warning;
    },
    debug: {
      route,
      frame,
      bridges: () => bridges.map((b) => ({ name: b.b.name, s: +b.b.s.toFixed(1), measured: b.measured, faces: [+b.sliceAt(0).f1.toFixed(2), +b.sliceAt(0).f2.toFixed(2)], under: b.slices.map((q) => +q.y.toFixed(2)) })),
      smack: smackDbg,
      faceRay: (i: number, u: number, y: number, sg: -1 | 1) => faceRay(bridges[i].b, bridges[i].h, u, y, sg),
      rayDown: (i: number, a: number, u: number) => {
        const br = bridges[i];
        const x = br.b.x + Math.sin(br.h) * a + Math.cos(br.h) * u, z = br.b.z + Math.cos(br.h) * a - Math.sin(br.h) * u;
        const d = castRayStatic(kit.physics, x, 5, z, 0, -1, 0, 10);
        return d === null ? null : +(5 - d).toFixed(3);
      },
      state: () => ({ s: +s.toFixed(2), v: +v.toFixed(2), dir, flip, L: +L.toFixed(1), warning: +warning.toFixed(2), next: nextBridge().d, quays: livePieces.size, pieces: pieces.length }),
      jump: (sArc: number, d = 1) => startAt(sArc, d),
      setSpeed: (k: number) => {
        speedScale = k;
      },
    },
    isOut(p: THREE.Vector3): boolean {
      if (p.y < WATER_LEVEL + 0.15) return true;
      const o = outsideBy(p);
      if (o > 2.5) return true;
      return o > 0.3 && p.y < roofY + 0.2;
    },
    edgeDistance(p: THREE.Vector3): number {
      frame.toLocal(p, loc);
      if (!area.contains(loc.x, loc.z)) return 0;
      return area.dropDistance(loc.x, loc.z);
    },
    clampToArea(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
      frame.toLocal(p, loc);
      area.clamp(loc.x, loc.z, 0.5, loc);
      const c = BOAT.cabin;
      const onRoof = Math.abs(loc.x) < c.halfW - 0.2 && loc.z > c.z0 + 0.2 && loc.z < c.z1 - 0.2;
      frame.toWorld(loc.x, onRoof ? BOAT.roof : loc.z > c.z1 ? BOAT.bowDeck.y : BOAT.deck, loc.z, out);
      return out;
    },
    update,
    reset() {
      kit.resetProps();
      randomStart();
    },
    dispose() {
      kit.dispose();
    },
  };
}
