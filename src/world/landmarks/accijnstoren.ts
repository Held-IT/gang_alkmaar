// Accijnstoren (1622): the small excise tower at the head of the quay where the harbour meets the
// canals. Square red-brick body with white natural-stone quoins, bands and window dressings, the
// city arms on the water side, a steep pyramid roof and an octagonal open lantern with a bell,
// lead ogee cap, spire, gilded ball and weather vane. A low lean-to on the landward side follows
// the BAG footprint (pand 0361100000010548, excluded from the BAG city meshes).
//
// Model frame: +x = (-0.856, -0.517) world, +z = (0.517, -0.856) (landward, NNE), y up.
import * as THREE from 'three';
import type { MaterialLibrary } from '../../contracts';
import { mat } from '../props/util/geom';
import { C, Facade, HeroBuilder, bell, cityArms, dress, holesOf, octLathe, octPrism, pyramidRoof, V2, type HeroBox, type HeroBuildingModel, type Op } from './hero';

export const ACCIJNSTOREN = {
  x: 314.46,
  z: 329.42,
  rotation: 2.5982,
  ring: [[-2.8, -3.7], [2.8, -3.7], [2.8, 3.7], [-2.8, 3.7]] as [number, number][],
};

const BASE = -1.6; // the plinth reaches down to the water at the quay head

export function buildAccijnstoren(materials: MaterialLibrary | null): HeroBuildingModel {
  const hb = new HeroBuilder(materials);
  const colliders: HeroBox[] = [];
  const col = (x0: number, x1: number, z0: number, z1: number, h: number): void => {
    colliders.push({ c: new THREE.Vector3((x0 + x1) / 2, h / 2, (z0 + z1) / 2), h: new THREE.Vector3((x1 - x0) / 2, h / 2, (z1 - z0) / 2) });
  };
  const HX = 2.8, Z0 = -3.7, Z1 = 2.0, ZC = (Z0 + Z1) / 2, HZ = (Z1 - Z0) / 2, EAVE = 7.6;

  // ---------------------------------------------------------------- tower body
  const sides: [Facade, number, Op[]][] = [
    [
      Facade.axis(hb, '-z', Z0, 0, 0.55),
      HX,
      [
        { u: 0, y0: 1.0, y1: 2.6, w: 1.0, transom: 2.0, shutters: true, leaded: true },
        { u: 0, y0: 3.4, y1: 5.6, w: 1.3, transom: 4.6, shutters: true, leaded: true },
      ],
    ],
    [
      Facade.axis(hb, '+x', HX, ZC, 0.55),
      HZ,
      [
        { u: 0, y0: 1.0, y1: 2.6, w: 0.9, transom: 2.0, shutters: true },
        { u: 0, y0: 3.4, y1: 5.6, w: 1.1, transom: 4.6, shutters: true, leaded: true },
      ],
    ],
    [
      Facade.axis(hb, '-x', -HX, ZC, 0.55),
      HZ,
      [
        { u: 0, y0: 1.0, y1: 2.6, w: 0.9, transom: 2.0, shutters: true },
        { u: 0, y0: 3.4, y1: 5.6, w: 1.1, transom: 4.6, shutters: true, leaded: true },
      ],
    ],
    [Facade.axis(hb, '+z', Z1, 0, 0.55), HX, [{ u: 0, y0: 3.6, y1: 5.6, w: 1.0, transom: 4.7, shutters: true }]],
  ];
  for (const [f, half, ops] of sides) {
    f.wall([V2(-half, BASE), V2(half, BASE), V2(half, EAVE), V2(-half, EAVE)], holesOf(ops));
    dress(f, ops);
    const gaps = ops.filter((o) => o.kind === 'door').map((o): [number, number] => [o.u - o.w / 2, o.u + o.w / 2]);
    f.plinth(-half, half, BASE, 0.5, gaps, 0.1);
    f.band(-half, half, 3.0, 0.22);
    f.quoins(-half, 0.5, 7.25, 1);
    f.quoins(half, 0.5, 7.25, -1);
    f.box(-half - 0.12, half + 0.12, 7.25, 7.45, -0.1, 0.14, 'stone', C.stone);
    f.box(-half - 0.22, half + 0.22, 7.45, EAVE, -0.1, 0.24, 'stone', C.stone);
  }
  // city arms with the year stone on the water side
  const south = sides[0][0];
  cityArms(south, 0, 6.65, 0.4);
  south.box(-0.75, 0.75, 6.05, 6.17, -0.05, 0.12, 'stone', C.stone);
  col(-HX, HX, Z0, Z1, EAVE);

  // ---------------------------------------------------------------- roof + lantern
  pyramidRoof(hb, 0, ZC, HX + 0.32, HZ + 0.32, EAVE + 0.02, 11.4);
  // lead hip rolls
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const a = new THREE.Vector3(sx * (HX + 0.32), EAVE + 0.06, ZC + sz * (HZ + 0.32));
    const b = new THREE.Vector3(0, 11.42, ZC);
    const d = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(0.06, 0.06, d.length(), 5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    hb.add('lead', g, new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)), C.leadDark, 'keep');
  }
  const LY = 10.5;
  hb.add('lead', octPrism(0.98, 11.05 - LY), mat(0, LY, ZC), C.lead);
  hb.add('stone', octLathe([[0.6, 11.05], [1.05, 11.05], [1.05, 11.15], [0.6, 11.15]]), mat(0, 0, ZC), C.stone);
  for (let k = 0; k < 8; k++) {
    const phi = Math.PI / 8 + (k * Math.PI) / 4;
    hb.add('detail', new THREE.BoxGeometry(0.11, 1.45, 0.11), mat(Math.sin(phi) * 0.86, 11.15 + 0.725, ZC + Math.cos(phi) * 0.86), C.white);
  }
  hb.add('detail', octLathe([[0.75, 11.15], [0.95, 11.15], [0.95, 11.6], [0.75, 11.6]]), mat(0, 0, ZC), C.white);
  hb.add('detail', bell(0.55), mat(0, 11.85, ZC), C.bronze, 'keep');
  hb.box('detail', -0.8, 0.8, 12.45, 12.53, ZC - 0.05, ZC + 0.05, C.doorWood);
  hb.add('detail', octLathe([[0.8, 12.6], [1.0, 12.6], [1.06, 12.75], [1.06, 12.92], [0.8, 12.92]]), mat(0, 0, ZC), C.white);
  hb.add('lead', octLathe([[1.02, 12.92], [1.04, 13.02], [0.92, 13.3], [0.62, 13.7], [0.32, 14.1], [0.18, 14.3], [0.001, 14.3]]), mat(0, 0, ZC), C.lead);
  hb.add('lead', octLathe([[0.17, 14.3], [0.12, 15.1], [0.015, 16.6]]), mat(0, 0, ZC), C.leadDark);
  hb.add('detail', new THREE.SphereGeometry(0.15, 12, 8), mat(0, 15.3, ZC), C.gold, 'keep');
  hb.add('detail', new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6), mat(0, 16.9, ZC), C.gold, 'keep');
  hb.add('detail', new THREE.BoxGeometry(0.55, 0.26, 0.02), mat(0.29, 17.15, ZC), C.gold);
  hb.add('detail', new THREE.SphereGeometry(0.05, 8, 6), mat(0, 17.42, ZC), C.gold, 'keep');

  // ---------------------------------------------------------------- landward lean-to
  {
    const ZA = Z1, ZB = 3.7, HI = 3.0, LO = 2.2;
    hb.box('brick', -HX, HX, BASE, LO, ZA - 0.1, ZB - 0.5, C.brick);
    const f = Facade.axis(hb, '+z', ZB, 0, 0.5);
    const ops: Op[] = [
      { kind: 'door', u: 0.9, y0: 0, y1: 1.95, w: 0.95, doorStyle: C.doorWood },
      { u: -1.3, y0: 0.9, y1: 1.75, w: 0.9, shuttersFull: true },
    ];
    f.wall([V2(-HX, BASE), V2(HX, BASE), V2(HX, LO), V2(-HX, LO)], holesOf(ops));
    dress(f, ops);
    f.plinth(-HX, HX, BASE, 0.5, [[0.42, 1.38]], 0.1);
    const mid = (ZA + ZB) / 2, hz = (ZB - ZA) / 2;
    Facade.axis(hb, '+x', HX, mid, 0.5).wall([V2(-hz, BASE), V2(hz, BASE), V2(hz, HI), V2(-hz, LO)], []);
    Facade.axis(hb, '-x', -HX, mid, 0.5).wall([V2(-hz, BASE), V2(hz, BASE), V2(hz, LO), V2(-hz, HI)], []);
    const dz = ZB + 0.3 - ZA, dy = HI - LO + 0.12;
    const phi = Math.atan2(dy, dz), L = Math.hypot(dz, dy);
    hb.add('roof', new THREE.BoxGeometry(2 * HX + 0.3, 0.14, L).translate(0, -0.07, L / 2).rotateX(phi), mat(0, HI + 0.12, ZA), C.roof);
    col(-HX, HX, ZA, ZB, LO + 0.4);
  }

  const model = hb.build('accijnstoren');
  return { ...model, colliders };
}
