// Simple dark interior visible through the glass (LOD 0 only): floor, front seats, rear bench,
// dashboard with screens, steering wheel (left-hand drive: driver on the LEFT = +x), centre
// console, parcel shelf or a cargo bulkhead for the van. Goes into the detail bucket.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BodyMap } from './bodyMap';
import type { BodyMesh } from './bodyMesh';
import type { MeshBuilder } from './builder';

const FABRIC: [number, number, number] = [0.045, 0.045, 0.048];
const FABRIC_HI: [number, number, number] = [0.07, 0.068, 0.066];
const DASH: [number, number, number] = [0.03, 0.03, 0.032];
const SCREEN: [number, number, number] = [0.01, 0.012, 0.016];

/** Front seat layout (vehicle-local, driver on the left): shared by the interior and the anchors. */
export function seatLayout(m: BodyMap): { seatX: number; seatZ: number; cushionTop: number; eye: [number, number, number] } {
  const f = m.f;
  const d = f.d;
  const floorY = Math.max(d.sillY + 0.12, 0.3);
  const wins = [...d.windows].sort((a, b) => b.pts[3][0] - a.pts[3][0]);
  const zB = wins.length > 1 ? 0.5 * (wins[0].pts[0][0] + wins[1].pts[3][0]) : wins[0].pts[0][0] - 0.05;
  const inner = f.shoulderPoint(f.pOfShoulderZ(zB)).x - 0.07;
  const seatX = Math.min(0.37, inner * 0.48);
  // seat positions follow the windscreen base (driving position), not the door layout
  const seatZ = d.cowlZ - (d.van ? 0.95 : d.front === 'city' ? 0.93 : 1.0);
  const cushionTop = floorY + (d.van ? 0.36 : 0.26);
  // eye point: above the hip point, slightly behind the cushion centre (reclined back)
  return { seatX, seatZ, cushionTop, eye: [seatX, cushionTop + 0.68, seatZ - 0.18] };
}

export function buildInterior(m: BodyMap, _bm: BodyMesh, mb: MeshBuilder): void {
  const f = m.f;
  const d = f.d;
  const uv = m.atlas.patchUv('white');
  const box = (w: number, h: number, dp: number, r: number, mtx: THREE.Matrix4, col: [number, number, number], rough: number, metal = 0) => {
    const g = new RoundedBoxGeometry(w, h, dp, 1, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, dp / 2 - 1e-3));
    mb.setColor(col).setPbr(rough, metal);
    mb.addGeometry(g, mtx, uv);
    g.dispose();
  };
  const T = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));

  const floorY = Math.max(d.sillY + 0.12, 0.3);
  const belt = (z: number) => f.shoulderPoint(f.pOfShoulderZ(z)).y;
  const inner = (z: number) => f.shoulderPoint(f.pOfShoulderZ(z)).x - 0.07;
  const wins = [...d.windows].sort((a, b) => b.pts[3][0] - a.pts[3][0]);
  const zB = wins.length > 1 ? 0.5 * (wins[0].pts[0][0] + wins[1].pts[3][0]) : wins[0].pts[0][0] - 0.05;
  const van = d.van;
  const city = d.front === 'city';

  // floor
  const zFloor0 = d.cowlZ - 0.15;
  const zFloor1 = van ? zB - 0.35 : Math.max(d.rearBaseZ + 0.05, f.zRA - 0.2);
  const wFloor = 2 * inner(0) - 0.02;
  box(wFloor, 0.04, zFloor0 - zFloor1, 0.01, T(0, floorY - 0.02, 0.5 * (zFloor0 + zFloor1)), [0.03, 0.03, 0.032], 0.95);

  // front seats (driver on the left, +x)
  const { seatX, seatZ, cushionTop } = seatLayout(m);
  for (const sx of [seatX, -seatX]) {
    box(0.5, 0.12, 0.52, 0.05, T(sx, cushionTop - 0.06, seatZ, -0.08), FABRIC, 0.92);
    // side bolsters
    for (const bx of [-0.21, 0.21]) box(0.08, 0.16, 0.48, 0.035, T(sx + bx, cushionTop - 0.03, seatZ, -0.08), FABRIC_HI, 0.9);
    // backrest, reclined ~20 deg
    const bz = seatZ - 0.26;
    box(0.5, 0.62, 0.13, 0.05, T(sx, cushionTop + 0.27, bz - 0.06, -0.33), FABRIC, 0.92);
    box(0.27, 0.17, 0.11, 0.045, T(sx, cushionTop + 0.68, bz - 0.17, -0.2), FABRIC_HI, 0.9);
  }
  if (van) {
    // middle passenger seat and the cargo bulkhead behind the cab
    box(0.36, 0.12, 0.48, 0.05, T(0, cushionTop - 0.06, seatZ), FABRIC, 0.92);
    const zBh = seatZ - 0.42;
    const top = f.topY(zBh) - 0.05;
    box(2 * inner(zBh), top - floorY, 0.03, 0.01, T(0, 0.5 * (top + floorY), zBh), [0.09, 0.09, 0.095], 0.8, 0.3);
  } else {
    // rear bench
    const rz = seatZ - (city ? 0.78 : 0.88);
    const rw = 2 * inner(rz) - 0.12;
    box(rw, 0.13, 0.48, 0.05, T(0, cushionTop - 0.05, rz), FABRIC, 0.92);
    const brz = rz - 0.27;
    box(rw, 0.58, 0.12, 0.05, T(0, cushionTop + 0.25, brz - 0.05, -0.28), FABRIC, 0.92);
    for (const hx of [-0.38, 0, 0.38]) {
      if (Math.abs(hx) * 2 > rw - 0.2) continue;
      box(0.24, 0.13, 0.09, 0.04, T(hx * (rw / 1.3), cushionTop + 0.6, brz - 0.13, -0.2), FABRIC_HI, 0.9);
    }
    // parcel shelf / load cover up to the tailgate
    const z0 = brz - 0.12;
    const z1 = d.trunk ? d.rearBaseZ + 0.02 : d.rearBaseZ + 0.06;
    if (z0 > z1 + 0.05) {
      const y = belt(0.5 * (z0 + z1)) - 0.03;
      box(2 * inner(0.5 * (z0 + z1)) - 0.02, 0.02, z0 - z1, 0.008, T(0, y, 0.5 * (z0 + z1)), [0.02, 0.02, 0.022], 0.95);
    }
  }

  // dashboard: main slab under the windscreen + driver binnacle + centre screen
  const zDash = d.cowlZ - 0.2;
  const yDash = belt(zDash) + 0.03;
  const wDash = 2 * inner(zDash);
  box(wDash, 0.2, 0.42, 0.06, T(0, yDash - 0.1, zDash), DASH, 0.75);
  box(wDash - 0.06, 0.16, 0.12, 0.03, T(0, yDash - 0.21, zDash - 0.25), DASH, 0.7);
  // driver screen and centre touchscreen (glossy dark)
  box(0.32, 0.11, 0.025, 0.01, T(seatX, yDash + 0.04, zDash - 0.19, -0.25), SCREEN, 0.08);
  box(0.26, 0.16, 0.025, 0.01, T(0.02, yDash + 0.03, zDash - 0.2, -0.3), SCREEN, 0.08);
  // trim strip
  box(wDash - 0.1, 0.012, 0.012, 0.004, T(0, yDash - 0.07, zDash - 0.215), [0.45, 0.46, 0.48], 0.25, 1);

  // steering wheel
  {
    const r = city ? 0.17 : 0.185;
    const wz = zDash - 0.42;
    const wy = yDash - 0.03;
    const rot = T(seatX, wy, wz, -1.1 + Math.PI / 2 - 0.35, 0, 0);
    const torus = new THREE.TorusGeometry(r, 0.016, 6, 20);
    mb.setColor([0.025, 0.025, 0.027]).setPbr(0.6, 0);
    mb.addGeometry(torus, rot, uv);
    torus.dispose();
    const hub = new THREE.CylinderGeometry(0.065, 0.07, 0.05, 16).rotateX(Math.PI / 2);
    mb.addGeometry(hub, rot, uv);
    hub.dispose();
    for (const a of [Math.PI / 2 + 0.05, -Math.PI / 2 - 0.05, -Math.PI]) {
      const sp = new THREE.BoxGeometry(r - 0.05, 0.03, 0.018).translate((r - 0.05) / 2 + 0.04, 0, 0);
      sp.rotateZ(a);
      mb.addGeometry(sp, rot, uv);
      sp.dispose();
    }
    // column
    box(0.07, 0.07, 0.22, 0.02, T(seatX, wy + 0.04, wz + 0.13, 0.35), DASH, 0.7);
  }

  // centre console
  if (!van) {
    const cz0 = zDash - 0.2;
    const cz1 = seatZ - 0.3;
    box(0.2, 0.2, cz0 - cz1, 0.04, T(0, floorY + 0.1, 0.5 * (cz0 + cz1)), DASH, 0.7);
    box(0.17, 0.02, 0.2, 0.01, T(0, floorY + 0.21, cz0 - 0.15), [0.4, 0.41, 0.43], 0.3, 1);
  }
}
