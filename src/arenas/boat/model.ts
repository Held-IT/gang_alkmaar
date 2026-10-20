// Rondvaartboot model (original design): a low Alkmaar canal tour boat, 19 m x 4.2 m. Dark blue steel
// hull with a white sheer stripe and a black rubbing strake, a long glass-roofed cabin with a flat
// walkable roof only 1 m above the water (the binnenstad bridges are low), an open rear deck with
// wooden planks, benches, the skipper's console and a low railing (with a gap at the stern), a small
// bow deck with a pulpit rail, beacons that flash when a low bridge is coming, the Dutch flag.
//
// Local frame: +z = bow, +x = port side seen from behind... (x just "across"), y = height above the
// waterline. buildBoat() creates the visuals (one group) and the static colliders in world space.
import * as THREE from 'three';
import { ArenaKit } from '../common';
import { MeshBuilder, box, cylinder, mat, rod, sweep, torus, type Style } from '../../world/props/util/geom';
import { createPropMaterial } from '../../world/props/util/propMaterial';
import { canvasToTexture, makeCanvas } from '../../world/props/util/textures';
import { LAYER_REFLECT } from '../../config';

export const BOAT = {
  halfLength: 9.5,
  halfBeam: 2.1,
  /** gunwale (top of the hull side) above the waterline */
  sheer: 0.45,
  /** rear deck floor */
  deck: 0.32,
  /** cabin roof top */
  roof: 1.0,
  cabin: { z0: -4.6, z1: 7.0, halfW: 1.78, chamfer: 0.6 },
  rearDeck: { z0: -9.4, z1: -4.6 },
  bowDeck: { z0: 7.0, y: 0.5 },
  rail: 0.55,
  keel: -0.62,
};

/** Half width of the hull at z (plan shape). */
export function hullHalfWidth(z: number): number {
  const L = BOAT.halfLength, W = BOAT.halfBeam;
  if (z < -L || z > L) return 0;
  if (z < -8.6) {
    const t = (z + 8.6) / (L - 8.6);
    return 1.72 + (W - 1.72) * Math.sqrt(Math.max(0, 1 - t * t));
  }
  if (z > 4.2) {
    const t = (z - 4.2) / (L - 4.2);
    return Math.max(0.1, W * Math.pow(Math.max(0, 1 - t * t), 0.62));
  }
  return W;
}

function sheerAt(z: number): number {
  return BOAT.sheer + (z > 3.5 ? 0.24 * Math.pow((z - 3.5) / (BOAT.halfLength - 3.5), 2) : 0);
}

function keelAt(z: number): number {
  let k = BOAT.keel;
  if (z > 5.5) k += (0.45 * (z - 5.5)) / (BOAT.halfLength - 5.5);
  if (z < -8.0) k += (0.2 * (-8.0 - z)) / 1.5;
  return k;
}

/** Hull outline (plan) as a closed ring of [x, z], counter-clockwise seen from above. */
export function hullOutline(step = 0.5): [number, number][] {
  const L = BOAT.halfLength;
  const right: [number, number][] = [];
  for (let z = -L; z <= L + 1e-6; z += step) right.push([-hullHalfWidth(z), z]);
  const left: [number, number][] = right.map(([x, z]) => [-x, z] as [number, number]).reverse();
  return [...right, ...left];
}

/** Cabin outline (plan), chamfered front corners. */
export function cabinOutline(inset = 0): [number, number][] {
  const c = BOAT.cabin;
  const w = c.halfW - inset, z0 = c.z0 + inset, z1 = c.z1 - inset, ch = c.chamfer;
  return [[w, z0], [w, z1 - ch], [w - ch, z1], [-(w - ch), z1], [-w, z1 - ch], [-w, z0]];
}

const NAVY = 0x1b2b45;
const WHITE: Style = { color: 0xeeeeea, rough: 0.45 };
const STEEL: Style = { color: 0xc9cdd0, rough: 0.28, metal: 0.9 };
const BLACK: Style = { color: 0x151515, rough: 0.7 };
const CUSHION: Style = { color: 0x23365e, rough: 0.85 };
const ORANGE: Style = { color: 0xe8611c, rough: 0.55 };
const WOODLIGHT: Style = { color: 0x9a7048, rough: 0.7 };

/** Lofted hull: U sections from the keel to the gunwale, closed transom; per-vertex paint bands. */
function hullGeometry(): THREE.BufferGeometry {
  const zs: number[] = [];
  for (let z = -BOAT.halfLength; z <= BOAT.halfLength + 1e-6; z += 0.25) zs.push(z);
  // section parameter u in [-1, 1]: -1 = right gunwale, 0 = keel, 1 = left gunwale
  const us = [-1, -0.86, -0.7, -0.5, -0.28, 0, 0.28, 0.5, 0.7, 0.86, 1];
  const pos: number[] = [];
  const idx: number[] = [];
  const P = (z: number, u: number): [number, number, number] => {
    const w = hullHalfWidth(z), top = sheerAt(z), k = keelAt(z);
    const a = Math.abs(u);
    // side stays nearly vertical down to the waterline, then rounds into a flat bottom
    let x: number, y: number;
    if (a >= 0.5) {
      const t = (a - 0.5) / 0.5; // 0 at the bilge .. 1 at the gunwale
      x = w * (0.9 + 0.1 * Math.sin((t * Math.PI) / 2));
      y = k + 0.32 + (top - k - 0.32) * t;
    } else {
      const t = a / 0.5;
      x = w * 0.9 * Math.sin((t * Math.PI) / 2);
      y = k + 0.32 * (1 - Math.cos((t * Math.PI) / 2));
    }
    return [Math.sign(u) * x, y, z];
  };
  for (const z of zs) for (const u of us) pos.push(...P(z, u));
  const nu = us.length;
  for (let i = 0; i + 1 < zs.length; i++) {
    for (let j = 0; j + 1 < nu; j++) {
      const a = i * nu + j, b = a + 1, c = a + nu, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // transom (fan at the stern station)
  const base = pos.length / 3;
  const zt = zs[0];
  pos.push(0, (sheerAt(zt) + keelAt(zt)) / 2, zt);
  for (let j = 0; j < nu; j++) pos.push(...P(zt, us[j]));
  for (let j = 0; j + 1 < nu; j++) idx.push(base, base + 2 + j, base + 1 + j);
  // close the transom top
  idx.push(base, base + 1, base + nu);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  g.dispose();
  return ng;
}

function textTexture(text: string, w: number, h: number, opts: { font: string; fg: string; bg?: string; stroke?: string }): THREE.Texture {
  const { canvas, ctx } = makeCanvas(w, h);
  if (opts.bg) {
    ctx.fillStyle = opts.bg;
    ctx.fillRect(0, 0, w, h);
  } else ctx.clearRect(0, 0, w, h);
  ctx.font = opts.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.stroke) {
    ctx.strokeStyle = opts.stroke;
    ctx.lineWidth = h * 0.06;
    ctx.strokeText(text, w / 2, h / 2);
  }
  ctx.fillStyle = opts.fg;
  ctx.fillText(text, w / 2, h / 2);
  return canvasToTexture(canvas, { srgb: true, anisotropy: 4 });
}

function flagTexture(): THREE.Texture {
  const { canvas, ctx } = makeCanvas(96, 64);
  const cols = ['#ae1c28', '#ffffff', '#21468b'];
  cols.forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.fillRect(0, (i * 64) / 3, 96, 64 / 3 + 1);
  });
  return canvasToTexture(canvas, { srgb: true });
}

/** Glass roof texture (u across, v along the cabin) + roughness map. */
function roofTextures(len: number, wid: number): { map: THREE.Texture; rough: THREE.Texture } {
  const W = 128, H = 512;
  const px = (m: number) => (m / wid) * W, pz = (m: number) => (m / len) * H;
  const { canvas, ctx } = makeCanvas(W, H);
  const r = makeCanvas(W, H);
  ctx.fillStyle = '#dcdfdb';
  ctx.fillRect(0, 0, W, H);
  r.ctx.fillStyle = '#9a9a9a';
  r.ctx.fillRect(0, 0, W, H);
  const rim = 0.42, bar = 0.07;
  const x0 = px(rim), x1 = W - px(rim);
  const n = 9;
  const z0 = pz(0.35), z1 = H - pz(0.8);
  const pl = (z1 - z0) / n;
  for (let k = 0; k < n; k++) {
    const a = z0 + k * pl + pz(bar) / 2, b = z0 + (k + 1) * pl - pz(bar) / 2;
    const g = ctx.createLinearGradient(x0, a, x1, b);
    g.addColorStop(0, '#22404c');
    g.addColorStop(0.45, '#2f5866');
    g.addColorStop(0.55, '#1d3741');
    g.addColorStop(1, '#264653');
    ctx.fillStyle = g;
    ctx.fillRect(x0, a, x1 - x0, b - a);
    r.ctx.fillStyle = '#141414';
    r.ctx.fillRect(x0, a, x1 - x0, b - a);
  }
  // longitudinal centre bar + rivet dots on the rim
  ctx.fillStyle = '#dcdfdb';
  ctx.fillRect(W / 2 - px(bar) / 2, z0, px(bar), z1 - z0);
  r.ctx.fillStyle = '#9a9a9a';
  r.ctx.fillRect(W / 2 - px(bar) / 2, z0, px(bar), z1 - z0);
  ctx.fillStyle = 'rgba(80,84,82,0.5)';
  for (let z = 6; z < H; z += 14) for (const x of [px(0.12), W - px(0.12)]) ctx.fillRect(x - 1, z, 2, 2);
  // dark non-slip strip at the rear edge (where the beasts climb up)
  ctx.fillStyle = '#4a4d4c';
  ctx.fillRect(0, 0, W, pz(0.18));
  return { map: canvasToTexture(canvas, { srgb: true, anisotropy: 4 }), rough: canvasToTexture(r.canvas, { srgb: false, anisotropy: 4 }) };
}

export interface BoatObject {
  group: THREE.Group;
  /** footprint polygon (local x, z) used for isOut / edges */
  outline: [number, number][];
  /** set the beacon flashing (0 = off .. 1 = full warning) and animate the flag */
  update(dt: number, warn: number, speed: number): void;
}

/** Local -> world mapping of the (static) boat. */
export class BoatFrame {
  readonly origin: THREE.Vector3;
  readonly heading: number;
  private readonly c: number;
  private readonly s: number;
  constructor(origin: THREE.Vector3, heading: number) {
    this.origin = origin.clone();
    this.heading = heading;
    this.c = Math.cos(heading);
    this.s = Math.sin(heading);
  }
  /** local (x across, y above the waterline, z along) -> world */
  toWorld(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.origin.x + x * this.c + z * this.s, this.origin.y + y, this.origin.z - x * this.s + z * this.c);
  }
  toLocal(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const dx = p.x - this.origin.x, dz = p.z - this.origin.z;
    return out.set(dx * this.c - dz * this.s, p.y - this.origin.y, dx * this.s + dz * this.c);
  }
}

export function buildBoat(kit: ArenaKit, frame: BoatFrame): BoatObject {
  const group = new THREE.Group();
  group.name = 'arena_rondvaartboot';
  group.position.copy(frame.origin);
  group.rotation.y = frame.heading;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const C = BOAT.cabin;

  // ---------------------------------------------------------------- hull + painted parts (one mesh)
  const b = new MeshBuilder();
  const hullCol = new THREE.Color(NAVY), stripe = new THREE.Color(0xf2f1ec), anti = new THREE.Color(0x6e2a20);
  b.add(hullGeometry(), null, { color: NAVY, rough: 0.66, metal: 0.05 }, {
    colorFn: (_x, y, z, c) => {
      const top = sheerAt(z);
      if (y > top - 0.11) return c.copy(stripe);
      if (y < -0.04) return c.copy(anti);
      return c.copy(hullCol);
    },
  });
  // rubbing strake (black fender) and white gunwale cap along the outline
  const ring = hullOutline(0.5);
  const strake = ring.map(([x, z]) => V(x * 1.015, sheerAt(z) - 0.16, z));
  strake.push(strake[0].clone());
  b.add(sweep(strake, 0.065, 6), null, BLACK);
  const cap = ring.map(([x, z]) => V(x, sheerAt(z) + 0.01, z));
  cap.push(cap[0].clone());
  b.add(sweep(cap, 0.04, 5), null, WHITE);

  // side decks around the cabin + bow deck rim (white non-slip)
  for (const sx of [-1, 1]) {
    const w0 = C.halfW, w1 = BOAT.halfBeam - 0.04;
    b.add(box(w1 - w0, 0.04, C.z1 - C.z0 - 0.6), mat(sx * (w0 + w1) / 2, BOAT.sheer - 0.01, (C.z0 + C.z1 - 0.6) / 2), { color: 0xd9dbd6, rough: 0.8 });
  }
  // cabin lower wall band (white), with a thin blue line
  const co = cabinOutline(0);
  for (let i = 0; i < co.length; i++) {
    const a = co[i], c2 = co[(i + 1) % co.length];
    if (i === co.length - 1) continue; // rear wall built separately (door)
    const len = Math.hypot(c2[0] - a[0], c2[1] - a[1]);
    const ang = Math.atan2(c2[0] - a[0], c2[1] - a[1]);
    const mx = (a[0] + c2[0]) / 2, mz = (a[1] + c2[1]) / 2;
    b.add(box(0.08, 0.16, len + 0.02), mat(mx, BOAT.sheer + 0.07, mz, 0, ang, 0), WHITE);
    b.add(box(0.085, 0.025, len + 0.02), mat(mx, BOAT.sheer + 0.12, mz, 0, ang, 0), { color: 0x2a4f9a, rough: 0.5 });
  }
  // rear wall of the cabin: white panels left and right of a glass door
  b.add(box(1.25, 0.5, 0.08), mat(-1.15, BOAT.deck + 0.3, C.z0), WHITE);
  b.add(box(1.25, 0.5, 0.08), mat(1.15, BOAT.deck + 0.3, C.z0), WHITE);
  // roof slab edge (rubber) + roof frame
  const ro = cabinOutline(0.06);
  const roofEdge = ro.map(([x, z]) => V(x, BOAT.roof - 0.03, z));
  roofEdge.push(roofEdge[0].clone());
  b.add(sweep(roofEdge, 0.04, 5), null, { color: 0x2b2d2f, rough: 0.8 });
  // window mullions (white posts) along the sides
  for (let z = C.z0 + 0.1; z <= C.z1 - C.chamfer + 0.01; z += 1.29) {
    for (const sx of [-1, 1]) b.add(box(0.05, 0.42, 0.06), mat(sx * (C.halfW - 0.035), 0.77, z, 0, 0, sx * 0.17), WHITE);
  }
  // interior: two rows of blue benches along the windows, sunk floor (visible through the glass)
  for (let z = C.z0 + 0.8; z < C.z1 - 1.2; z += 1.05) {
    for (const sx of [-1, 1]) {
      b.add(box(1.1, 0.12, 0.42), mat(sx * 0.95, 0.12, z), CUSHION);
      b.add(box(1.1, 0.45, 0.08), mat(sx * 0.95, 0.38, z - 0.2), CUSHION);
    }
  }
  b.add(box(C.halfW * 2 - 0.1, 0.02, C.z1 - C.z0 - 0.2), mat(0, -0.05, (C.z0 + C.z1) / 2), { color: 0x30312f, rough: 0.9 });
  // rear deck: benches along the sides, skipper's console with wheel
  for (const sx of [-1, 1]) {
    b.add(box(0.4, 0.05, 3.6), mat(sx * 1.58, BOAT.deck + 0.42, -7.1), WOODLIGHT);
    b.add(box(0.36, 0.38, 3.5), mat(sx * 1.6, BOAT.deck + 0.2, -7.1), WHITE);
    b.add(box(0.06, 0.32, 3.6), mat(sx * 1.8, BOAT.deck + 0.62, -7.1), WOODLIGHT);
  }
  b.add(box(0.7, 0.62, 0.55), mat(-1.15, BOAT.deck + 0.31, -5.05), WHITE);
  b.add(box(0.72, 0.04, 0.4), mat(-1.15, BOAT.deck + 0.63, -5.1, -0.4, 0, 0), { color: 0x1d2328, rough: 0.3, metal: 0.3 });
  b.add(torus(0.17, 0.018, 6, 18), mat(-1.15, BOAT.deck + 0.85, -5.25, -0.6, 0, 0), BLACK);
  b.add(rod(V(-1.15, BOAT.deck + 0.62, -5.12), V(-1.15, BOAT.deck + 0.85, -5.25), 0.02, 5), null, STEEL);
  // life ring on the cabin rear wall
  b.add(torus(0.24, 0.055, 8, 20), mat(1.15, BOAT.deck + 0.36, C.z0 - 0.09), ORANGE);
  // rear deck railing: posts + two rails on the gunwale, gap at the stern centre
  // one side of the rear deck outline: from the cabin wall aft, around the stern corner to the gap
  const rearSide = (sx: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let z = BOAT.rearDeck.z1; z > -BOAT.halfLength + 0.01; z -= 0.5) pts.push([sx * hullHalfWidth(z), z]);
    pts.push([sx * hullHalfWidth(-BOAT.halfLength), -BOAT.halfLength]);
    pts.push([sx * 1.1, -BOAT.halfLength]);
    pts.push([sx * 0.6, -BOAT.halfLength]);
    return pts;
  };
  const railPath = (pts: [number, number][], h: number) => pts.map(([x, z]) => V(x * 0.985, BOAT.sheer + h, z));
  const runs: [number, number][][] = [rearSide(-1), rearSide(1)];
  const railH = BOAT.deck + BOAT.rail - BOAT.sheer;
  for (const run of runs) {
    b.add(sweep(railPath(run, railH), 0.025, 6), null, STEEL);
    b.add(sweep(railPath(run, railH * 0.5), 0.016, 5), null, STEEL);
    for (let i = 0; i < run.length; i += 2) {
      const [x, z] = run[i];
      b.add(rod(V(x * 0.985, BOAT.sheer, z), V(x * 0.985, BOAT.sheer + railH, z), 0.022, 6), null, STEEL);
    }
  }
  // bow pulpit rail + bollards + bow flag staff
  const bowPts = ring.filter(([, z]) => z >= 7.6).sort((p, q) => Math.atan2(p[0], p[1] - 7) - Math.atan2(q[0], q[1] - 7));
  b.add(sweep(bowPts.map(([x, z]) => V(x * 0.95, sheerAt(z) + 0.42, z)), 0.022, 6), null, STEEL);
  for (let i = 0; i < bowPts.length; i += 2) {
    const [x, z] = bowPts[i];
    b.add(rod(V(x * 0.95, sheerAt(z), z), V(x * 0.95, sheerAt(z) + 0.42, z), 0.02, 6), null, STEEL);
  }
  for (const sx of [-0.55, 0.55]) b.add(cylinder(0.07, 0.08, 0.2, 10), mat(sx, BOAT.bowDeck.y, 7.6), BLACK);
  b.add(rod(V(0, sheerAt(9.2), 9.15), V(0, sheerAt(9.2) + 1.1, 9.15), 0.025, 6), null, WHITE);
  // stern flag staff
  b.add(rod(V(0, BOAT.sheer, -9.42), V(0, BOAT.sheer + 1.6, -9.6), 0.028, 6), null, WHITE);
  // roof: horn + small mast with the navigation light (front), two beacons get their own material
  b.add(cylinder(0.05, 0.08, 0.14, 8), mat(0.5, BOAT.roof, 6.0), WHITE);
  b.add(rod(V(0.5, BOAT.roof + 0.12, 6.0), V(0.5, BOAT.roof + 0.15, 6.35), 0.06, 8, 0.11), null, { color: 0xb8bcbe, rough: 0.3, metal: 0.8 });
  b.add(rod(V(-0.4, BOAT.roof, 6.3), V(-0.4, BOAT.roof + 0.55, 6.3), 0.025, 6), null, WHITE);
  b.add(cylinder(0.06, 0.06, 0.1, 10), mat(-0.4, BOAT.roof + 0.55, 6.3), { color: 0xfafafa, rough: 0.2, emit: 0.6 });
  // two low roof vents (trip hazards for the eye only)
  for (const z of [-2.2, 3.4]) b.add(box(0.55, 0.08, 0.55), mat(0.9, BOAT.roof + 0.04, z), { color: 0xb9bdbb, rough: 0.5, metal: 0.4 });

  const hullMat = kit.own(createPropMaterial({ name: 'arena_boot' }));
  const hull = new THREE.Mesh(b.build(), hullMat);
  hull.name = 'boot_romp';
  group.add(hull);

  // ---------------------------------------------------------------- PBR surfaces (metric UVs)
  const shapeMesh = (pts: [number, number][], y: number, material: THREE.Material, name: string) => {
    const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ShapeGeometry(sh);
    g.rotateX(-Math.PI / 2);
    g.translate(0, y, 0);
    const m = new THREE.Mesh(g, material);
    m.name = name;
    group.add(m);
    return m;
  };
  const woodMat = kit.pbr('wood', 1.6, 0x8a6441, { color: 0xb08a66, roughness: 0.75 });
  const rearPts = [...rearSide(-1), ...rearSide(1).reverse()].map(([x, z]) => [x * 0.96, Math.max(z, -BOAT.halfLength + 0.06)] as [number, number]);
  shapeMesh(rearPts, BOAT.deck, woodMat, 'boot_achterdek');
  const bowShape = ring.filter(([, z]) => z >= BOAT.bowDeck.z0).map(([x, z]) => [x * 0.95, z] as [number, number]);
  bowShape.sort((p, q) => Math.atan2(p[0], p[1] - 7.3) - Math.atan2(q[0], q[1] - 7.3));
  shapeMesh(bowShape, BOAT.bowDeck.y, woodMat, 'boot_voordek');
  // glass roof: tinted panels between white frame bars, a walkable white rim (one texture over the
  // whole roof; roughness map: glass smooth, frame painted)
  const roofTex = roofTextures(C.z1 - C.z0, C.halfW * 2);
  kit.own(roofTex.map);
  kit.own(roofTex.rough);
  const roofMat = kit.own(new THREE.MeshStandardMaterial({ name: 'boot_dak', map: roofTex.map, roughnessMap: roofTex.rough, roughness: 1, metalness: 0.1, envMapIntensity: 1.2 }));
  {
    const m = shapeMesh(cabinOutline(0.07), BOAT.roof, roofMat, 'boot_dak');
    const g = m.geometry;
    const pa = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) uv.setXY(i, (pa.getX(i) + C.halfW) / (2 * C.halfW), (pa.getZ(i) - C.z0) / (C.z1 - C.z0));
    uv.needsUpdate = true;
  }

  // glass band (inclined) + rear door glass
  const glassMat = kit.own(
    new THREE.MeshStandardMaterial({ name: 'boot_glas', color: 0x28404c, roughness: 0.06, metalness: 0.55, transparent: true, opacity: 0.62, envMapIntensity: 1.3 }),
  );
  {
    const lo = cabinOutline(0.0), hi = cabinOutline(0.09);
    const pos: number[] = [];
    const y0 = BOAT.sheer + 0.14, y1 = BOAT.roof - 0.04;
    for (let i = 0; i < lo.length - 1; i++) {
      const a = lo[i], c2 = lo[i + 1], A = hi[i], Cc = hi[i + 1];
      pos.push(a[0], y0, a[1], c2[0], y0, c2[1], Cc[0], y1, Cc[1], a[0], y0, a[1], Cc[0], y1, Cc[1], A[0], y1, A[1]);
    }
    // rear door + upper rear glass
    const zr = C.z0 + 0.01;
    pos.push(-0.52, BOAT.deck, zr, 0.52, BOAT.deck, zr, 0.52, y1, zr, -0.52, BOAT.deck, zr, 0.52, y1, zr, -0.52, y1, zr);
    for (const [x0, x1] of [[-C.halfW, -0.52], [0.52, C.halfW]]) pos.push(x0, BOAT.deck + 0.55, zr, x1, BOAT.deck + 0.55, zr, x1, y1, zr, x0, BOAT.deck + 0.55, zr, x1, y1, zr, x0, y1, zr);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const glass = new THREE.Mesh(g, glassMat);
    glass.name = 'boot_ramen';
    glassMat.side = THREE.DoubleSide;
    group.add(glass);
    glass.userData.noShadow = true;
  }

  // name boards on the bow and the home port on the stern
  const nameTex = kit.own(textTexture('De Kaaskop', 512, 96, { font: 'italic 700 64px Georgia, "Times New Roman", serif', fg: '#f4f1e6' }));
  const nameMat = kit.own(new THREE.MeshStandardMaterial({ map: nameTex, transparent: true, roughness: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.36), nameMat);
    const z = 5.6;
    m.position.set(sx * (hullHalfWidth(z) * 0.995 + 0.012), sheerAt(z) - 0.32, z);
    m.rotation.y = sx > 0 ? Math.PI / 2 + 0.17 : -Math.PI / 2 - 0.17;
    m.name = 'boot_naam';
    group.add(m);
  }
  const portTex = kit.own(textTexture('ALKMAAR', 512, 96, { font: '700 60px Georgia, "Times New Roman", serif', fg: '#f4f1e6' }));
  const portMat = kit.own(new THREE.MeshStandardMaterial({ map: portTex, transparent: true, roughness: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.3), portMat);
    m.position.set(0, 0.12, -BOAT.halfLength - 0.012);
    m.rotation.y = Math.PI;
    group.add(m);
  }
  // flag (cloth, waving in the vertex positions every frame: 7 x 5 grid)
  const flagGeo = new THREE.PlaneGeometry(0.75, 0.5, 6, 4);
  flagGeo.translate(-0.375, 0, 0);
  const flagBase = Float32Array.from((flagGeo.getAttribute('position') as THREE.BufferAttribute).array);
  const flagMat = kit.own(new THREE.MeshStandardMaterial({ map: kit.own(flagTexture()), side: THREE.DoubleSide, roughness: 0.8 }));
  const flag = new THREE.Mesh(flagGeo, flagMat);
  flag.position.set(0, BOAT.sheer + 1.38, -9.58);
  flag.rotation.y = Math.PI / 2;
  flag.name = 'boot_vlag';
  group.add(flag);

  // beacons (orange, flash when a bridge is near)
  const beaconMat = kit.own(new THREE.MeshStandardMaterial({ name: 'boot_zwaailicht', color: 0xff8a1e, emissive: 0xff6a00, emissiveIntensity: 0, roughness: 0.3 }));
  for (const z of [6.55, -4.3]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.16, 12), beaconMat);
    m.position.set(z > 0 ? 0.0 : -0.6, BOAT.roof + 0.08, z);
    group.add(m);
  }

  kit.add(group);
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.layers.enable(LAYER_REFLECT);
  });
  // transparent glass / labels: no shadows from the labels
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && (m.material === nameMat || m.material === portMat || m.userData.noShadow)) m.castShadow = false;
  });

  // ---------------------------------------------------------------- static colliders (world space)
  const R = kit.R;
  const w = new THREE.Vector3();
  const hullPts = (zMin: number, zMax: number, y0: number, y1: number, scale = 1) => {
    const pts: number[] = [];
    for (const [x, z] of ring) {
      if (z < zMin - 1e-6 || z > zMax + 1e-6) continue;
      for (const y of [y0, y1]) {
        frame.toWorld(x * scale, y, z, w);
        pts.push(w.x, w.y, w.z);
      }
    }
    // cap the cut faces
    for (const z of [zMin, zMax]) {
      const hw = hullHalfWidth(z) * scale;
      for (const x of [-hw, hw]) for (const y of [y0, y1]) {
        frame.toWorld(x, y, z, w);
        pts.push(w.x, w.y, w.z);
      }
    }
    return new Float32Array(pts);
  };
  const hull3 = (zMin: number, zMax: number, y0: number, y1: number, tag: string, scale = 1) => {
    const d = R.ColliderDesc.convexHull(hullPts(zMin, zMax, y0, y1, scale));
    if (d) kit.staticCollider(d.setFriction(0.85).setRestitution(0.05), tag);
  };
  hull3(-BOAT.halfLength, BOAT.rearDeck.z1, BOAT.keel + 0.1, BOAT.deck, 'boot_achterdek');
  hull3(BOAT.rearDeck.z1, C.z1, BOAT.keel, BOAT.sheer, 'boot_romp');
  hull3(C.z1, BOAT.halfLength, BOAT.keel + 0.2, BOAT.bowDeck.y, 'boot_voordek');
  {
    const pts: number[] = [];
    for (const [x, z] of cabinOutline(0)) for (const y of [BOAT.keel + 0.2, BOAT.roof]) {
      frame.toWorld(x, y, z, w);
      pts.push(w.x, w.y, w.z);
    }
    const d = R.ColliderDesc.convexHull(new Float32Array(pts));
    if (d) kit.staticCollider(d.setFriction(0.9), 'boot_dak');
  }
  // rails: rear deck (with the stern gap) and bow
  const railBox = (a: [number, number], c2: [number, number], yb: number, h: number, tag: string) => {
    const mx = (a[0] + c2[0]) / 2, mz = (a[1] + c2[1]) / 2;
    const len = Math.hypot(c2[0] - a[0], c2[1] - a[1]);
    const ang = Math.atan2(c2[0] - a[0], c2[1] - a[1]);
    frame.toWorld(mx, yb + h / 2, mz, w);
    kit.staticBox(w.x, w.y, w.z, 0.04, h / 2, len / 2 + 0.03, frame.heading + ang, tag, 0.4);
  };
  for (const run of runs) for (let i = 0; i + 1 < run.length; i++) railBox([run[i][0] * 0.985, run[i][1]], [run[i + 1][0] * 0.985, run[i + 1][1]], BOAT.deck, BOAT.rail, 'boot_reling');
  for (let i = 0; i + 1 < bowPts.length; i++) railBox([bowPts[i][0] * 0.95, bowPts[i][1]], [bowPts[i + 1][0] * 0.95, bowPts[i + 1][1]], BOAT.bowDeck.y, 0.4, 'boot_reling');
  // benches + console
  for (const sx of [-1, 1]) {
    frame.toWorld(sx * 1.6, BOAT.deck + 0.22, -7.1, w);
    kit.staticBox(w.x, w.y, w.z, 0.2, 0.22, 1.8, frame.heading, 'boot_bank', 0.8);
  }
  frame.toWorld(-1.15, BOAT.deck + 0.32, -5.05, w);
  kit.staticBox(w.x, w.y, w.z, 0.35, 0.32, 0.28, frame.heading, 'boot_stuur', 0.6);

  // ---------------------------------------------------------------- animation
  const fp = flagGeo.getAttribute('position') as THREE.BufferAttribute;
  let t = 0;
  return {
    group,
    outline: ring,
    update(dt: number, warn: number, speed: number) {
      t += dt;
      beaconMat.emissiveIntensity = warn > 0 ? (Math.sin(t * 14) > 0 ? 3.5 * warn : 0.15) : 0;
      const wind = 0.6 + Math.min(1, Math.abs(speed) / 3) * 0.6;
      for (let i = 0; i < fp.count; i++) {
        const x = flagBase[i * 3], y = flagBase[i * 3 + 1];
        const k = -x / 0.75; // 0 at the staff .. 1 at the free end
        fp.setXYZ(i, x, y - k * k * 0.06 * (1.2 - wind), Math.sin(t * 7 * wind + k * 5) * 0.07 * k * wind);
      }
      fp.needsUpdate = true;
    },
  };
}
