// Molen van Piet ("De Groot", 1769): round stone stage mill (stellingmolen) on the Singel bastion.
// Tapered dark (tarred) brick body ~19 m, wooden stage at 6.2 m with beams, struts and railing,
// reed-thatched cap with front board ("baard"), windshaft + cast-iron head, 4 sails with a
// 25.8 m span (fokwieken: lattice + leading-edge boards), sail cloth partially set ("op de
// eerste reef"), tail beam with winding wheel. The sails turn slowly (counter-clockwise seen
// from the front, as Dutch mills do). Local frame: +z = front (sails / wind side), y up.
import * as THREE from 'three';
import type { MaterialLibrary } from '../../contracts';
import { MeshBuilder, beam, box, cylinder, mat, rod, sweep, torus, type Style } from '../props/util/geom';
import { createPropMaterial } from '../props/util/propMaterial';
import { getGrungeTexture, makeCanvas, canvasToTexture } from '../props/util/textures';
import { getTarredBrick, getThatch, type TexPair } from './textures';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const MOLEN = {
  baseRadius: 4.8,
  topRadius: 3.05,
  bodyHeight: 19.0,
  stageY: 6.2,
  stageWidth: 3.0,
  capBase: 19.25,
  span: 25.8,
  tiltDeg: 9,
  spin: 0.55, // rad/s
};

/** Body radius at height y (slightly concave taper). */
export function bodyRadius(y: number): number {
  const t = THREE.MathUtils.clamp(y / MOLEN.bodyHeight, 0, 1);
  return MOLEN.topRadius + (MOLEN.baseRadius - MOLEN.topRadius) * Math.pow(1 - t, 1.15);
}

const WOOD_GREY: Style = { color: 0x6e665c, rough: 0.85 };
const WOOD_DARK: Style = { color: 0x4a4038, rough: 0.85 };
const GREEN: Style = { color: 0x1f3b2c, rough: 0.5, metal: 0.05 };
const WHITE: Style = { color: 0xe8e6df, rough: 0.5 };
const IRON: Style = { color: 0x222324, rough: 0.55, metal: 0.6 };
const SAIL_WOOD: Style = { color: 0xd8d3c6, rough: 0.7 };
const STOCK: Style = { color: 0x1d3a2a, rough: 0.55 };
const GLASS: Style = { color: 0x1c2427, rough: 0.08, metal: 0.4 };
const CLOTH: Style = { color: 0xcfc6b0, rough: 0.92 };

function bodyGeometry(tile: [number, number]): THREE.BufferGeometry {
  const segs = 56, rings = 30;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const H = MOLEN.bodyHeight;
  for (let i = 0; i <= rings; i++) {
    const y = (i / rings) * H - 0.3;
    const r = bodyRadius(Math.max(0, y));
    const dr = (bodyRadius(Math.min(H, y + 0.1)) - bodyRadius(Math.max(0, y - 0.1))) / 0.2;
    for (let j = 0; j <= segs; j++) {
      const a = Math.PI + (j / segs) * Math.PI * 2; // seam at the back (-z)
      const sx = Math.sin(a), cz = Math.cos(a);
      pos.push(sx * r, y, cz * r);
      const n = new THREE.Vector3(sx, -dr, cz).normalize();
      nor.push(n.x, n.y, n.z);
      uv.push(((j / segs) * Math.PI * 2 * r) / tile[0], (y + 0.3) / tile[1]);
    }
  }
  const row = segs + 1;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Thatched hood: superellipse plan (flatter front), arched section. uv: (z, arc) / tile. */
function hoodGeometry(tile: [number, number]): THREE.BufferGeometry {
  const L = 7.4, W = 6.9, Hh = 3.7, z0 = -3.35, y0 = MOLEN.capBase;
  const nu = 30, nv = 18;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nu; i++) {
    const u = -1 + (2 * i) / nu;
    const e = u > 0 ? 7 : 2.6; // front nearly flat, back rounded
    const f = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), e)), 1 / e);
    const z = z0 + ((u + 1) / 2) * L;
    let arc = 0;
    let px = 0, py = 0;
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * Math.PI;
      const x = (W / 2) * f * Math.cos(v);
      const y = y0 + Hh * Math.pow(f, 0.7) * Math.pow(Math.sin(v), 0.85);
      if (j > 0) arc += Math.hypot(x - px, y - py);
      px = x; py = y;
      pos.push(x, y, z);
      uv.push(z / tile[0], arc / tile[1]);
    }
  }
  const row = nv + 1;
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * row + j, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Tapered square beam (for the stocks) from a to b, sizes at both ends. */
function taperedBeam(a: THREE.Vector3, b: THREE.Vector3, w0: number, w1: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry((w1 / 2) * Math.SQRT2, (w0 / 2) * Math.SQRT2, len, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), new THREE.Vector3().subVectors(b, a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Matrix: yaw a about Y, then pitch about the local X axis, at p. */
function yawPitch(p: THREE.Vector3, a: number, pitch: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeRotationX(pitch));
  return m.setPosition(p);
}

/** Sails assembly in the sail plane (local XY, +z = towards the wind). */
function sailsGeometry(): { frame: THREE.BufferGeometry; cloth: THREE.BufferGeometry } {
  const f = new MeshBuilder();
  const c = new MeshBuilder();
  const R = MOLEN.span / 2;
  // two stocks (roeden) crossing in the shaft head; the second slightly behind
  for (const [axis, z] of [[0, 0], [1, -0.48]] as [number, number][]) {
    for (const s of [-1, 1]) {
      const tip = axis === 0 ? V(0, s * R, z) : V(s * R, 0, z);
      f.add(taperedBeam(V(0, 0, z), tip, 0.42, 0.17), null, STOCK);
      // white tip
      const t0 = tip.clone().multiplyScalar(0.94), t1 = tip.clone().multiplyScalar(1.004);
      t0.z = t1.z = z;
      f.add(taperedBeam(t0, t1, 0.2, 0.18), null, WHITE);
    }
  }
  // per sail: lattice (hekwerk), leading board (fok), cloth
  const r0 = 2.3, r1 = R - 0.25;
  const lead = -0.42, trail = 2.05;
  for (let k = 0; k < 4; k++) {
    const rot = new THREE.Matrix4().makeRotationZ((k * Math.PI) / 2);
    const zOff = k % 2 === 0 ? 0.0 : -0.48;
    const M = (m: THREE.Matrix4) => rot.clone().multiply(m);
    const nBars = 26;
    for (let i = 0; i <= nBars; i++) {
      const y = r0 + ((r1 - r0) * i) / nBars;
      f.add(box(trail - lead, 0.055, 0.05), M(mat((trail + lead) / 2, y, zOff + 0.12)), SAIL_WOOD);
    }
    for (const x of [lead, 0.68, 1.36, trail]) {
      f.add(box(0.06, r1 - r0 + 0.1, 0.07), M(mat(x, (r0 + r1) / 2, zOff + 0.17)), SAIL_WOOD);
    }
    // fok: streamlined leading-edge board, angled to the wind
    f.add(box(0.62, r1 - r0 - 0.9, 0.035), M(mat(lead - 0.3, (r0 + r1) / 2 + 0.3, zOff + 0.02, 0, 0.35, 0)), STOCK);
    // cloth: partially set (first reef) — spread over part of the lattice, rest rolled up
    const cx0 = 0.12, cx1 = 1.32, cy0 = r0 + 0.35, cy1 = r1 - 0.6;
    const nx = 4, ny = 12;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [], col: number[] = [];
    const cc = new THREE.Color(CLOTH.color);
    const tmp = new THREE.Vector3();
    for (let iy = 0; iy <= ny; iy++) for (let ix = 0; ix <= nx; ix++) {
      const fx = ix / nx, fy = iy / ny;
      const x = cx0 + (cx1 - cx0) * fx, y = cy0 + (cy1 - cy0) * fy;
      const bulge = 0.14 * Math.sin(Math.PI * fx) * (0.6 + 0.4 * Math.sin(Math.PI * fy));
      tmp.set(x, y, zOff + 0.24 + bulge).applyMatrix4(rot);
      pos.push(tmp.x, tmp.y, tmp.z);
      const n = new THREE.Vector3(-Math.cos(Math.PI * fx) * 0.25, 0, 1).normalize().transformDirection(rot);
      nor.push(n.x, n.y, n.z);
      uv.push(fx, fy);
      const shade = 0.92 + 0.08 * Math.sin(fy * 37.0);
      col.push(cc.r * shade, cc.g * shade, cc.b * shade);
    }
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const a = iy * (nx + 1) + ix, b = a + 1, d = a + nx + 1, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
    c.addRaw(pos, nor, uv, idx, col, { rough: CLOTH.rough });
    // rolled-up part of the cloth along the reef line + lashing at the tip
    const roll = rod(V(cx1 + 0.08, cy0, zOff + 0.26).applyMatrix4(rot), V(cx1 + 0.08, cy1, zOff + 0.26).applyMatrix4(rot), 0.075, 8);
    c.add(roll, null, CLOTH);
  }
  return { frame: f.build(), cloth: c.build() };
}

/**
 * Optional build options (hooks for the Gang Alkmaar "molen" arena; the city mill uses the defaults).
 */
export interface MolenBuildOptions {
  /** railing kind per stage angle (radians, 0 = front +z, x = sin a): full (default), low (only the lower rail) or none (broken off) */
  railing?: (a: number) => 'full' | 'low' | 'none';
  /** sail size factor (default 1) */
  sailScale?: number;
  /** windshaft tilt in degrees (default MOLEN.tiltDeg) */
  tiltDeg?: number;
}

export interface MolenObject {
  group: THREE.Group;
  /** sail pivot on the windshaft head (parent of `sails`); its local z axis is the shaft */
  sailsPivot?: THREE.Object3D;
  /** the brick body, thatched cap and name board meshes (e.g. to fade them out) */
  parts?: { body: THREE.Mesh; cap: THREE.Mesh; baard: THREE.Mesh; wood: THREE.Mesh };
  /** stage deck height (top), inner / outer radius (local) */
  stage?: { y: number; rIn: number; rOut: number };
  /** sail spin speed used by update() (rad/s, default MOLEN.spin) */
  spinSpeed?: number;
  /** spinning sail assembly */
  sails: THREE.Object3D;
  update(dt: number): void;
  dispose(): void;
  /** triangles of the whole mill */
  triangles: number;
}

function libTex(materials: MaterialLibrary | null, name: string): THREE.Texture | undefined {
  try {
    return materials?.texture(name);
  } catch {
    return undefined;
  }
}

export function buildMolen(materials: MaterialLibrary | null, opts: MolenBuildOptions = {}): MolenObject {
  const railKind = opts.railing ?? (() => 'full' as const);
  const group = new THREE.Group();
  group.name = 'molen_van_piet';
  const geos: THREE.BufferGeometry[] = [];

  // ---------------------------------------------------------------- body (brick)
  let brick: TexPair;
  const libBrick = libTex(materials, 'brick_facade');
  if (libBrick) brick = { map: libBrick, normal: libTex(materials, 'brick_facade/normal') ?? null, tile: [1.25, 1.25] };
  else brick = getTarredBrick();
  const bodyMat = new THREE.MeshStandardMaterial({
    name: 'molen_romp',
    map: brick.map,
    normalMap: brick.normal,
    color: libBrick ? new THREE.Color(0.2, 0.175, 0.17) : 0xffffff, // tarred: darken + desaturate the CC0 brick
    roughness: 0.82,
  });
  const body = new THREE.Mesh(bodyGeometry(brick.tile), bodyMat);
  body.castShadow = body.receiveShadow = true;
  geos.push(body.geometry);

  // ---------------------------------------------------------------- wood / paint parts (merged)
  const b = new MeshBuilder();
  const H = MOLEN.bodyHeight;
  // tarred plinth band
  b.add(cylinder(bodyRadius(0) + 0.06, bodyRadius(0) + 0.08, 0.55, 48, true), mat(0, -0.05, 0), { color: 0x1b1a19, rough: 0.6 });
  // windows and doors on the body surface
  const onBody = (a: number, y: number, w: number, h: number, style: Style, depth = 0.1, frame = true) => {
    const r = bodyRadius(y);
    const p = V(Math.sin(a) * r, y, Math.cos(a) * r);
    const m = yawPitch(p, a, -0.1);
    if (frame) b.add(box(w + 0.16, h + 0.16, depth), m, WHITE);
    b.add(box(w, h, depth + 0.04), m, style);
  };
  onBody(0, 1.15, 1.1, 2.2, GREEN, 0.14);
  onBody(Math.PI, 1.15, 1.1, 2.2, GREEN, 0.14);
  onBody(0, MOLEN.stageY + 1.25, 0.95, 2.0, GREEN, 0.14);
  onBody(Math.PI, MOLEN.stageY + 1.25, 0.95, 2.0, GREEN, 0.14);
  for (const [a, y] of [[Math.PI / 2, 3.2], [-Math.PI / 2, 3.2], [Math.PI * 0.3, 10.2], [-Math.PI * 0.7, 10.2], [Math.PI * 0.75, 13.6], [-Math.PI * 0.25, 13.6], [Math.PI / 2, 16.6], [-Math.PI / 2, 16.6]] as [number, number][]) {
    onBody(a, y, 0.62, 0.86, GLASS, 0.1);
    // glazing bars
    const r = bodyRadius(y) + 0.06;
    const gp = V(Math.sin(a) * r, y, Math.cos(a) * r);
    b.add(box(0.04, 0.86, 0.04), yawPitch(gp, a, -0.1), WHITE);
    b.add(box(0.62, 0.04, 0.04), yawPitch(gp, a, -0.1), WHITE);
  }
  // stage (stelling): deck, beams, struts, railing
  const sy = MOLEN.stageY;
  const rIn = bodyRadius(sy) - 0.05;
  const rOut = rIn + MOLEN.stageWidth;
  const deck = new THREE.RingGeometry(rIn, rOut, 64, 1);
  deck.rotateX(-Math.PI / 2);
  b.add(deck, mat(0, sy + 0.12, 0), WOOD_GREY);
  const deckUnder = new THREE.RingGeometry(rIn, rOut, 64, 1);
  deckUnder.rotateX(Math.PI / 2);
  b.add(deckUnder, mat(0, sy + 0.04, 0), WOOD_DARK);
  b.add(new THREE.CylinderGeometry(rOut, rOut, 0.08, 64, 1, true), mat(0, sy + 0.08, 0), WOOD_DARK);
  const nBeams = 24;
  for (let k = 0; k < nBeams; k++) {
    const a = (k / nBeams) * Math.PI * 2 + 0.07;
    const dir = V(Math.sin(a), 0, Math.cos(a));
    b.add(beam(dir.clone().multiplyScalar(rIn - 0.1).setY(sy - 0.08), dir.clone().multiplyScalar(rOut + 0.18).setY(sy - 0.08), 0.16, 0.22), null, WOOD_DARK);
    // strut from lower on the body to the beam
    const ys = sy - 2.6;
    b.add(beam(dir.clone().multiplyScalar(bodyRadius(ys) - 0.05).setY(ys), dir.clone().multiplyScalar(rOut - 0.7).setY(sy - 0.18), 0.12, 0.12), null, WOOD_DARK);
  }
  const nPosts = 36;
  for (let k = 0; k < nPosts; k++) {
    const a = (k / nPosts) * Math.PI * 2;
    const kind = railKind(a);
    if (kind === 'none') continue;
    const ph = kind === 'low' ? 0.64 : 1.08;
    b.add(box(0.08, ph, 0.08), mat(Math.sin(a) * (rOut - 0.06), sy + 0.12 + ph / 2, Math.cos(a) * (rOut - 0.06), 0, a, 0), WOOD_GREY);
  }
  for (const [hgt, r] of [[1.12, 0.045], [0.6, 0.03]] as [number, number][]) {
    // rails run over the 'full' (top rail) / 'full' + 'low' (lower rail) parts of the ring
    const keep = (a: number) => { const k = railKind(((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)); return hgt > 1 ? k === 'full' : k !== 'none'; };
    let ring: THREE.Vector3[] = [];
    const flush = () => {
      if (ring.length >= 2) b.add(sweep(ring, r, 5), null, WOOD_GREY);
      ring = [];
    };
    const allOn = Array.from({ length: 72 }, (_, k) => keep(((k + 0.5) / 72) * Math.PI * 2)).every((v) => v);
    const k0 = allOn ? 0 : Array.from({ length: 72 }, (_, k) => k).find((k) => !keep(((k + 0.5) / 72) * Math.PI * 2)) ?? 0;
    for (let i = 0; i <= 72; i++) {
      const k = k0 + i;
      const a = (k / 72) * Math.PI * 2;
      if (i < 72 && !keep(a + Math.PI / 72)) {
        if (ring.length) ring.push(V(Math.sin(a) * (rOut - 0.06), sy + 0.12 + hgt, Math.cos(a) * (rOut - 0.06)));
        flush();
        continue;
      }
      ring.push(V(Math.sin(a) * (rOut - 0.06), sy + 0.12 + hgt, Math.cos(a) * (rOut - 0.06)));
    }
    flush();
  }
  // cap curb (kuip) ring
  b.add(cylinder(MOLEN.topRadius + 0.32, MOLEN.topRadius + 0.32, 0.26, 48), mat(0, H, 0), WOOD_DARK);
  // windshaft + head
  const tilt = THREE.MathUtils.degToRad(opts.tiltDeg ?? MOLEN.tiltDeg);
  const shaftDir = V(0, Math.sin(tilt), Math.cos(tilt));
  const head = V(0, 20.55, 4.62);
  b.add(rod(head.clone().addScaledVector(shaftDir, -5.5), head.clone().addScaledVector(shaftDir, -0.35), 0.3, 12), null, IRON);
  {
    const hm = new THREE.Matrix4().makeRotationX(-tilt);
    hm.setPosition(head);
    b.add(box(0.95, 0.95, 0.75), hm, IRON);
  }
  // front board under the shaft (baard) frame + wind boards
  b.add(box(3.0, 0.16, 0.12), mat(0, MOLEN.capBase + 0.12, 3.98), GREEN);
  // tail (staart) with struts and the winding wheel (kruirad) on the stage at the back
  const tailTop = V(0, MOLEN.capBase + 0.5, -3.3);
  const tailEnd = V(0, sy + 0.9, -(rOut + 0.35));
  b.add(beam(tailTop, tailEnd, 0.26, 0.3), null, WOOD_DARK);
  for (const s of [-1, 1]) {
    b.add(beam(V(s * 2.6, MOLEN.capBase + 0.2, -1.6), tailEnd.clone().lerp(tailTop, 0.45), 0.18, 0.18), null, WOOD_DARK);
  }
  const wheelC = tailEnd.clone().lerp(tailTop, 0.12);
  b.add(torus(1.0, 0.05, 6, 32), mat(wheelC.x + 0.3, wheelC.y, wheelC.z, 0, Math.PI / 2, 0), WOOD_DARK);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    b.add(rod(V(wheelC.x + 0.3, wheelC.y, wheelC.z), V(wheelC.x + 0.3, wheelC.y + Math.sin(a) * 1.25, wheelC.z + Math.cos(a) * 1.25), 0.035, 5), null, WOOD_DARK);
  }
  // chain to an anchor post on the stage + the anchor post (kruipaal)
  b.add(rod(V(wheelC.x + 0.3, wheelC.y - 1.0, wheelC.z), V(1.2, sy + 0.3, -(rOut - 0.4)), 0.02, 4), null, IRON);
  const woodMat = createPropMaterial({ name: 'molen_hout', map: getGrungeTexture() });
  const wood = new THREE.Mesh(b.build(), woodMat);
  wood.castShadow = wood.receiveShadow = true;
  geos.push(wood.geometry);

  // ---------------------------------------------------------------- cap (thatch)
  const th = getThatch();
  const capMat = new THREE.MeshStandardMaterial({ name: 'molen_kap', map: th.map, normalMap: th.normal, roughness: 0.95, color: 0xa39a90 }); // weathered reed: grey-brown
  const cap = new THREE.Mesh(hoodGeometry(th.tile), capMat);
  cap.castShadow = cap.receiveShadow = true;
  geos.push(cap.geometry);

  // baard: name board on the front of the cap
  const { canvas, ctx } = makeCanvas(512, 160);
  ctx.fillStyle = '#1f3b2c';
  ctx.fillRect(0, 0, 512, 160);
  ctx.strokeStyle = '#e9e6dc';
  ctx.lineWidth = 8;
  ctx.strokeRect(10, 10, 492, 140);
  ctx.fillStyle = '#efece3';
  ctx.font = '700 84px Georgia, "Times New Roman", serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ANNO 1769', 256, 84);
  const baardTex = canvasToTexture(canvas, { srgb: true, anisotropy: 8 });
  const baard = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.82), new THREE.MeshStandardMaterial({ map: baardTex, roughness: 0.6 }));
  baard.position.set(0, MOLEN.capBase + 0.62, 4.03);
  geos.push(baard.geometry);

  // ---------------------------------------------------------------- sails (rotating)
  const sailsPivot = new THREE.Group();
  sailsPivot.position.copy(head).addScaledVector(shaftDir, 0.3);
  sailsPivot.rotation.x = -tilt;
  const spin = new THREE.Group();
  spin.rotation.z = 0.3;
  if (opts.sailScale && opts.sailScale !== 1) spin.scale.setScalar(opts.sailScale);
  const sg = sailsGeometry();
  // the sails get their own materials with camera cut-outs (Gang Alkmaar: fighters behind a blade stay visible)
  const sailWoodMat = createPropMaterial({ name: 'molen_wiek', map: getGrungeTexture(), cut: true });
  const frame = new THREE.Mesh(sg.frame, sailWoodMat);
  frame.castShadow = true;
  frame.receiveShadow = true;
  const clothMat = createPropMaterial({ name: 'molen_zeil', map: getGrungeTexture(), side: THREE.DoubleSide, cut: true });
  const cloth = new THREE.Mesh(sg.cloth, clothMat);
  cloth.castShadow = true;
  cloth.receiveShadow = true;
  geos.push(sg.frame, sg.cloth);
  spin.add(frame, cloth);
  sailsPivot.add(spin);

  group.add(body, wood, cap, baard, sailsPivot);
  let triangles = 0;
  for (const g of geos) triangles += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;

  const obj: MolenObject = {
    group,
    sails: spin,
    sailsPivot,
    parts: { body, cap, baard, wood },
    stage: { y: sy + 0.12, rIn, rOut },
    spinSpeed: MOLEN.spin,
    triangles,
    update(dt: number) {
      spin.rotation.z += (obj.spinSpeed ?? MOLEN.spin) * Math.min(dt, 0.1);
    },
    dispose() {
      for (const g of geos) g.dispose();
      bodyMat.dispose();
      capMat.dispose();
      clothMat.dispose();
      sailWoodMat.dispose();
      baardTex.dispose();
    },
  };
  group.userData.molen = obj;
  return obj;
}
