// De Waag (Waagplein 2): the 14th-century Heilige Geestkapel, converted into the city weigh house
// in 1582, with the tower of 1595-1599 that is the skyline signature of Alkmaar.
//
// Built on the real 3D BAG footprint (pand 0361100000014453, which is excluded from the BAG
// city meshes): a 32 x 13 m hall whose long axis runs WNW-ESE, three parts:
//   * west: the former chapel nave with buttresses, tall pointed windows and a stepped west gable
//   * middle: the transverse 1582 front with the rich Renaissance stepped gable (klauwstukken,
//     obelisks, the city arms) facing the Kaasmarkt, with the arched weigh hall openings
//   * east: the weigh-house extension with its stepped east gable
// The tower rises from the crossing: square brick shaft with white stone bands and four clock
// faces, balustrade with obelisks, octagonal bell stage with louvres, lead skirt, open carillon
// lantern with bells, bell-shaped lead cupola, small lantern, spire, gilded ball and weather vane.
//
// Model frame: +x = WNW along the long axis, +z = NNE (the Kaasmarkt side), y up from the ground.
import * as THREE from 'three';
import type { MaterialLibrary } from '../../contracts';
import { mat } from '../props/util/geom';
import {
  C, Facade, HeroBuilder, archPath, bell, cityArms, clockFace, dress, gableRoof, holesOf, obelisk, octLathe, octPrism,
  steppedOutline, V2, type HeroBox, type HeroBuildingModel, type Op,
} from './hero';
import type { Style } from '../props/util/geom';

/** World placement of the model frame (from the BAG footprint). */
export const WAAG = {
  x: -0.1,
  z: 0.33,
  /** group rotation.y: model +x = (-0.832, -0.555) world, model +z = (0.555, -0.832) */
  rotation: 2.5536,
  /** footprint corners in model coordinates (for the ground height) */
  ring: [[15.8, -6.6], [15.8, 6.0], [-15.8, 6.6], [-15.8, -5.8], [-1.8, -10.9], [3.0, -10.9]] as [number, number][],
};

const BASE = -0.6; // walls start below ground level, so sloping squares never show a gap

type Steps = [number, number][];

/** Copings, klauwstukken (scrolls) and obelisks / balls on a stepped gable. */
function gableDressing(f: Facade, steps: Steps, o: { scrolls?: boolean; pinnacles?: boolean }): void {
  const n = steps.length;
  for (let i = 0; i < n - 1; i++) {
    const [hw, y] = steps[i];
    const hwN = steps[i + 1][0];
    const rise = steps[i + 1][1] - y;
    for (const s of [-1, 1]) {
      f.box(s * (hwN - 0.03), s * (hw + 0.09), y, y + 0.16, -f.depth - 0.07, 0.1, 'stone', C.stone);
      // riser cap (stone strip on the outer face of the next step)
      f.box(s * (hwN - 0.22), s * (hwN + 0.05), y + 0.16, steps[i + 1][1], -0.05, 0.05, 'stone', C.stone);
      if (o.scrolls) {
        const a = hwN, b = hw - 0.4, y0 = y + 0.16, top = y0 + rise * 0.72;
        const sh = new THREE.Shape();
        sh.moveTo(s * a, y0);
        sh.lineTo(s * b, y0);
        sh.quadraticCurveTo(s * b, top, s * a, top);
        sh.lineTo(s * a, y0);
        f.plate(sh, -0.06, 'stone', C.stone, 0.34);
        // volute eye
        f.hb.add('stone', new THREE.SphereGeometry(0.1, 8, 6), f.at(s * (b - 0.04), y0 + 0.14, -0.2), C.stone);
      }
      const p = f.point(s * (hw - 0.17), y + 0.16, -f.depth / 2);
      if (o.pinnacles) obelisk(f.hb, p, 1.05, 0.3);
      else f.hb.add('stone', new THREE.SphereGeometry(0.17, 10, 8), mat(p.x, p.y + 0.17, p.z), C.stone);
    }
  }
  const [hwT, yT] = steps[n - 1];
  f.box(-hwT - 0.1, hwT + 0.1, yT, yT + 0.18, -f.depth - 0.07, 0.1, 'stone', C.stone);
}

function plainBox(hb: HeroBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, style: Style = C.brick): void {
  hb.box('brick', x0, x1, y0, y1, z0, z1, style);
}

export function buildWaag(materials: MaterialLibrary | null): HeroBuildingModel {
  const hb = new HeroBuilder(materials);
  const colliders: HeroBox[] = [];
  const col = (x0: number, x1: number, z0: number, z1: number, h: number): void => {
    colliders.push({ c: new THREE.Vector3((x0 + x1) / 2, h / 2, (z0 + z1) / 2), h: new THREE.Vector3(Math.abs(x1 - x0) / 2, h / 2, Math.abs(z1 - z0) / 2) });
  };

  // =========================================================================================
  // Front: transverse Renaissance gable towards the Kaasmarkt (+z face, z = 6.4)
  // =========================================================================================
  {
    const f = Facade.axis(hb, '+z', 6.4, -1.8, 0.55);
    const steps: Steps = [[5.45, 11.4], [4.5, 12.9], [3.55, 14.4], [2.6, 15.9], [1.65, 17.4], [0.9, 19.7]];
    const ops: Op[] = [
      { kind: 'open', u: 0, y0: 0, y1: 3.2, w: 3.0, top: 'round', deep: 2.6 },
      { kind: 'door', u: -3.55, y0: 0, y1: 2.9, w: 2.0, top: 'round', doorStyle: C.green },
      { kind: 'door', u: 3.55, y0: 0, y1: 2.9, w: 2.0, top: 'round', doorStyle: C.green },
      ...[-3.55, 0, 3.55].map((u): Op => ({ u, y0: 5.9, y1: 8.7, w: 1.5, transom: 7.5, shutters: true, leaded: true })),
      ...[-2.1, 2.1].map((u): Op => ({ u, y0: 10.75, y1: 12.35, w: 1.0, transom: 11.65, shutters: true, leaded: true })),
      { u: 0, y0: 14.4, y1: 15.5, w: 0.9, top: 'round', leaded: true, mullion: true },
      { kind: 'oculus', u: 0, y0: 17.25, w: 0.84, y1: 0, r: 0.42 },
    ];
    f.wall(steppedOutline(steps, BASE), holesOf(ops));
    dress(f, ops);
    gableDressing(f, steps, { scrolls: true, pinnacles: true });
    f.plinth(-5.45, 5.45, BASE, 0.45, [[-4.55, -2.55], [-1.5, 1.5], [2.55, 4.55]]);
    f.band(-5.45, 5.45, 5.2, 0.3);
    f.band(-5.45, 5.45, 9.55, 0.26, 0.09);
    f.band(-3.55, 3.55, 13.5, 0.14, 0.05);
    for (const s of [-1, 1] as const) f.quoins(s * 5.45, 0.45, 9.55, s === 1 ? -1 : 1);
    cityArms(f, 0, 11.75, 0.85);
    // crown: semicircular pediment, obelisk, gilded ball and vane
    const crown = new THREE.Shape();
    crown.moveTo(-0.9, 19.88);
    crown.lineTo(0.9, 19.88);
    crown.absarc(0, 19.88, 0.9, 0, Math.PI, false);
    f.plate(crown, -0.08, 'stone', C.stone, 0.4);
    f.hb.add('detail', new THREE.CircleGeometry(0.42, 20), f.at(0, 20.15, -0.07), C.gold, 'keep');
    obelisk(hb, f.point(0, 20.78, -0.28), 1.3, 0.34, C.gold);
    hb.add('detail', new THREE.CylinderGeometry(0.018, 0.018, 0.9, 6), mat(...f.point(0, 22.6, -0.28).toArray() as [number, number, number]), C.iron, 'keep');
    // weigh hall: the great balance hanging behind the middle arch
    const beam = (u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, st: Style) => f.box(u0, u1, y0, y1, w0, w1, 'detail', st);
    beam(-1.25, 1.25, 3.55, 3.75, -1.45, -1.25, C.doorWood);
    beam(-0.07, 0.07, 3.75, 4.6, -1.42, -1.28, C.iron);
    for (const s of [-1, 1]) {
      for (const dw of [-0.3, 0.3]) beam(s * 0.95 - 0.015, s * 0.95 + 0.015, 1.15, 3.55, -1.35 + dw - 0.015, -1.35 + dw + 0.015, C.iron);
      beam(s * 0.95 - 0.5, s * 0.95 + 0.5, 1.05, 1.15, -1.85, -0.85, C.doorWood);
    }
    // lanterns beside the middle arch
    for (const s of [-1, 1]) {
      beam(s * 2.0 - 0.12, s * 2.0 + 0.12, 3.6, 4.0, 0.05, 0.3, C.iron);
      beam(s * 2.0 - 0.09, s * 2.0 + 0.09, 3.65, 3.95, 0.08, 0.27, { color: 0xfff1c8, rough: 0.3, emit: 0 });
    }
    // corner pier at the east end of the front
    plainBox(hb, -7.25, -6.45, BASE, 9.55, 6.3, 7.9);
    hb.box('stone', -7.33, -6.37, 9.55, 9.85, 6.3, 7.98, C.stone);
    hb.box('stone', -7.3, -6.4, 5.2, 5.5, 6.3, 7.95, C.stone);
    hb.box('stone', -7.3, -6.4, BASE, 0.45, 6.3, 7.98, C.stoneGrey);
    obelisk(hb, new THREE.Vector3(-6.85, 9.85, 7.15), 1.6, 0.42);
    col(-7.25, -6.45, 6.3, 7.9, 9.5);
  }

  // =========================================================================================
  // Crossing south wall (behind the annexes) with its stepped gable (-z face, z = -6.3)
  // =========================================================================================
  {
    const f = Facade.axis(hb, '-z', -6.3, -1.8, 0.5);
    const steps: Steps = [[5.55, 11.4], [4.5, 12.9], [3.55, 14.4], [2.6, 15.9], [1.65, 17.4], [0.9, 19.7]];
    const ops: Op[] = [
      { u: -2.4, y0: 7.0, y1: 9.0, w: 1.2, transom: 8.2, shutters: true, leaded: true },
      { u: 2.6, y0: 5.0, y1: 8.4, w: 1.3, transom: 7.2, shutters: true, leaded: true },
      ...[-2.0, 2.0].map((u): Op => ({ u, y0: 10.75, y1: 12.35, w: 1.0, transom: 11.65, shutters: true })),
      { u: 0, y0: 14.4, y1: 15.5, w: 0.9, top: 'round', leaded: true },
    ];
    f.wall(steppedOutline(steps, BASE), holesOf(ops));
    dress(f, ops);
    gableDressing(f, steps, { pinnacles: false });
    f.band(-5.55, 5.55, 9.55, 0.24, 0.08);
  }
  col(-7.4, 3.7, -6.3, 6.4, 10);

  // =========================================================================================
  // Nave (former chapel): long walls with buttresses and pointed windows, west gable
  // =========================================================================================
  const buttress = (f: Facade, u: number, deep = 1.0): void => {
    f.box(u - 0.4, u + 0.4, BASE, 3.4, 0, deep, 'brick', C.brick);
    f.box(u - 0.4, u + 0.4, 3.4, 6.7, 0, deep * 0.68, 'brick', C.brick);
    f.box(u - 0.44, u + 0.44, BASE, 0.45, 0, deep + 0.06, 'stone', C.stoneGrey);
    // sloping stone weatherings
    const cap = (y: number, d: number): void => {
      const len = d / Math.cos(0.62) + 0.1;
      f.hb.add('stone', new THREE.BoxGeometry(0.88, 0.14, len), f.at(u, y + (d * Math.tan(0.62)) / 2, d / 2, 0, 0, 0.62), C.stone);
    };
    cap(3.4, deep);
    cap(6.7, deep * 0.68);
  };
  {
    const nWin = (u: number): Op => ({ u, y0: 2.6, y1: 6.0, w: 1.7, top: 'pointed', transom: 4.5, mullion: true, leaded: true, stoneFrame: true });
    // north (+z, z = 6.0)
    const fn = Facade.axis(hb, '+z', 6.0, 9.75, 0.5);
    const opsN = [-3.75, 0.05, 4.1].map(nWin);
    fn.wall([V2(-6.05, BASE), V2(6.05, BASE), V2(6.05, 8.3), V2(-6.05, 8.3)], holesOf(opsN));
    dress(fn, opsN);
    for (const u of [-5.65, -1.8, 1.95]) buttress(fn, u);
    fn.box(5.85, 6.65, BASE, 6.7, -0.6, 0.9, 'brick', C.brick); // corner buttress
    fn.box(5.81, 6.69, BASE, 0.45, -0.6, 0.96, 'stone', C.stoneGrey);
    fn.plinth(-6.05, 6.05, BASE, 0.45);
    fn.band(-6.05, 6.05, 2.4, 0.16, 0.06);
    fn.box(-6.05, 6.05, 8.05, 8.3, -0.1, 0.16, 'stone', C.stone);
    fn.box(-6.05, 6.05, 8.3, 8.48, -0.05, 0.32, 'lead', C.leadDark); // gutter
    // south (-z, z = -6.6)
    const fs = Facade.axis(hb, '-z', -6.6, 9.75, 0.5);
    const opsS = [4.45, 0.65, -3.15].map(nWin);
    fs.wall([V2(-6.05, BASE), V2(6.05, BASE), V2(6.05, 8.3), V2(-6.05, 8.3)], holesOf(opsS));
    dress(fs, opsS);
    for (const u of [2.6, -1.25, -5.05]) buttress(fs, u);
    buttress(fs, 6.05, 1.0);
    fs.plinth(-6.05, 6.05, BASE, 0.45);
    fs.band(-6.05, 6.05, 2.4, 0.16, 0.06);
    fs.box(-6.05, 6.05, 8.05, 8.3, -0.1, 0.16, 'stone', C.stone);
    fs.box(-6.05, 6.05, 8.3, 8.48, -0.05, 0.32, 'lead', C.leadDark);
    // west gable (+x, x = 15.8)
    const fw = Facade.axis(hb, '+x', 15.8, -0.3, 0.55);
    const stepsW: Steps = [[6.3, 9.6], [5.3, 11.3], [4.3, 13.0], [3.3, 14.7], [2.3, 16.4], [1.3, 18.1], [0.75, 19.9]];
    const opsW: Op[] = [
      { u: 0, y0: 2.3, y1: 6.2, w: 2.4, top: 'pointed', transom: 4.4, mullion: true, leaded: true, stoneFrame: true },
      ...[-1.9, 1.9].map((u): Op => ({ u, y0: 11.4, y1: 12.7, w: 0.8, shuttersFull: true })),
      { u: 0, y0: 14.6, y1: 15.6, w: 0.7, top: 'round', leaded: true },
      { kind: 'oculus', u: 0, y0: 17.4, w: 0.64, y1: 0, r: 0.32 },
    ];
    fw.wall(steppedOutline(stepsW, BASE), holesOf(opsW));
    dress(fw, opsW);
    gableDressing(fw, stepsW, {});
    fw.plinth(-6.3, 6.3, BASE, 0.45);
    fw.band(-6.3, 6.3, 9.0, 0.2, 0.07);
    for (const s of [-1, 1] as const) fw.quoins(s * 6.3, 0.45, 9.0, s === 1 ? -1 : 1);
    col(3.7, 15.8, -6.6, 6.0, 9);
    for (const x of [4.1, 7.95, 11.7]) col(x - 0.4, x + 0.4, 6.0, 7.0, 6.7);
    col(15.6, 16.4, 5.4, 6.9, 6.7);
    for (const x of [7.15, 11.0, 14.8]) col(x - 0.4, x + 0.4, -7.6, -6.6, 6.7);
    col(3.1, 3.9, -7.6, -6.3, 6.7);
  }

  // =========================================================================================
  // East extension: two storeys of cross windows, stepped east gable
  // =========================================================================================
  {
    const twoFloors = (us: number[]): Op[] => [
      ...us.map((u): Op => ({ u, y0: 1.1, y1: 3.7, w: 1.3, transom: 2.8, shutters: true, leaded: true })),
      ...us.map((u): Op => ({ u, y0: 5.1, y1: 7.9, w: 1.3, transom: 6.8, shutters: true, leaded: true })),
    ];
    for (const [facing, plane] of [['+z', 6.6], ['-z', -5.8]] as const) {
      const f = Facade.axis(hb, facing, plane, -11.6, 0.5);
      const ops = twoFloors([-2.0, 2.0]);
      f.wall([V2(-4.2, BASE), V2(4.2, BASE), V2(4.2, 9.0), V2(-4.2, 9.0)], holesOf(ops));
      dress(f, ops);
      f.plinth(-4.2, 4.2, BASE, 0.45);
      f.band(-4.2, 4.2, 4.4, 0.25);
      f.box(-4.2, 4.2, 8.7, 9.0, -0.1, 0.18, 'stone', C.stone);
      f.box(-4.2, 4.2, 9.0, 9.18, -0.05, 0.34, 'lead', C.leadDark);
      f.quoins(facing === '+z' ? -4.2 : 4.2, 0.45, 8.7, facing === '+z' ? 1 : -1);
    }
    const f = Facade.axis(hb, '-x', -15.8, 0.4, 0.55);
    const steps: Steps = [[6.2, 10.3], [5.2, 11.9], [4.2, 13.5], [3.2, 15.1], [2.2, 16.7], [1.2, 18.3], [0.7, 19.6]];
    const ops: Op[] = [
      { kind: 'door', u: 0, y0: 0, y1: 2.5, w: 1.5, top: 'round', doorStyle: C.doorWood },
      ...[-3.0, 3.0].map((u): Op => ({ u, y0: 1.1, y1: 3.7, w: 1.3, transom: 2.8, shutters: true, leaded: true })),
      ...[-3.0, 0, 3.0].map((u): Op => ({ u, y0: 5.1, y1: 7.9, w: 1.3, transom: 6.8, shutters: true, leaded: true })),
      ...[-1.8, 1.8].map((u): Op => ({ u, y0: 10.8, y1: 12.3, w: 1.0, transom: 11.7, shutters: true })),
      { u: 0, y0: 13.7, y1: 14.9, w: 0.9, top: 'round', leaded: true },
      { kind: 'oculus', u: 0, y0: 16.9, w: 0.7, y1: 0, r: 0.35 },
    ];
    f.wall(steppedOutline(steps, BASE), holesOf(ops));
    dress(f, ops);
    gableDressing(f, steps, { pinnacles: true });
    f.plinth(-6.2, 6.2, BASE, 0.45, [[-0.75, 0.75]]);
    f.band(-6.2, 6.2, 4.4, 0.25);
    f.band(-6.2, 6.2, 9.0, 0.26, 0.09);
    for (const s of [-1, 1] as const) f.quoins(s * 6.2, 0.45, 9.0, s === 1 ? -1 : 1);
    col(-15.8, -7.4, -5.8, 6.6, 9);
  }

  // =========================================================================================
  // South annexes (low later additions on the BAG footprint)
  // =========================================================================================
  {
    // annex 1: two storeys, flat roof behind a parapet
    plainBox(hb, -1.8, 3.0, BASE, 6.1, -10.4, -6.2);
    const f = Facade.axis(hb, '-z', -10.9, 0.6, 0.5);
    const ops: Op[] = [
      ...[-1.1, 1.1].map((u): Op => ({ u, y0: 1.0, y1: 2.8, w: 1.0, transom: 2.2, shutters: true })),
      ...[-1.1, 1.1].map((u): Op => ({ u, y0: 3.9, y1: 5.6, w: 1.0, transom: 5.0, shutters: true })),
    ];
    f.wall([V2(-2.4, BASE), V2(2.4, BASE), V2(2.4, 6.6), V2(-2.4, 6.6)], holesOf(ops));
    dress(f, ops);
    f.plinth(-2.4, 2.4, BASE, 0.45);
    f.band(-2.4, 2.4, 3.3, 0.2);
    f.box(-2.5, 2.5, 6.6, 6.75, -0.6, 0.1, 'stone', C.stone);
    for (const x of [-1.8, 3.0]) {
      hb.box('brick', x - 0.13, x + 0.13, 6.0, 6.6, -10.9, -6.3, C.brick);
      hb.box('stone', x - 0.18, x + 0.18, 6.6, 6.75, -10.95, -6.3, C.stone);
    }
    hb.box('lead', -1.7, 2.9, 6.0, 6.12, -10.5, -6.3, C.leadDark);
    col(-1.8, 3.0, -10.9, -6.3, 6.6);
    // annex 2: one storey with a door
    plainBox(hb, -7.9, -1.8, BASE, 3.7, -7.8, -6.0);
    const g = Facade.axis(hb, '-z', -8.3, -4.85, 0.5);
    const ops2: Op[] = [
      { kind: 'door', u: 0, y0: 0, y1: 2.4, w: 1.1, doorStyle: C.green },
      ...[-1.75, 1.75].map((u): Op => ({ u, y0: 1.0, y1: 2.9, w: 1.1, transom: 2.3, shutters: true })),
    ];
    g.wall([V2(-3.05, BASE), V2(3.05, BASE), V2(3.05, 4.1), V2(-3.05, 4.1)], holesOf(ops2));
    dress(g, ops2);
    g.plinth(-3.05, 3.05, BASE, 0.45, [[-0.55, 0.55]]);
    g.box(-3.12, 3.12, 4.1, 4.24, -0.6, 0.1, 'stone', C.stone);
    hb.box('brick', -8.05, -7.75, 3.6, 4.1, -8.3, -5.9, C.brick);
    hb.box('stone', -8.1, -7.7, 4.1, 4.24, -8.35, -5.9, C.stone);
    hb.box('lead', -7.8, -1.9, 3.6, 3.72, -7.9, -5.9, C.leadDark);
    col(-7.9, -1.8, -8.3, -5.9, 4.2);
  }

  // =========================================================================================
  // Roofs (dark glazed tiles)
  // =========================================================================================
  gableRoof(hb, { axis: 'x', from: 3.7, to: 15.65, center: -0.3, halfW: 6.3, yEave: 8.3, yRidge: 18.9, overhang: 0.32 });
  gableRoof(hb, { axis: 'x', from: -1.8, to: 3.7, center: -0.3, halfW: 6.3, yEave: 8.3, yRidge: 18.9, overhang: -0.6, ridgeCap: false });
  gableRoof(hb, { axis: 'x', from: -15.65, to: -7.4, center: 0.4, halfW: 6.2, yEave: 9.0, yRidge: 18.0, overhang: 0.32 });
  gableRoof(hb, { axis: 'x', from: -7.4, to: -1.8, center: 0.4, halfW: 6.2, yEave: 9.0, yRidge: 18.0, overhang: -0.6, ridgeCap: false });
  gableRoof(hb, { axis: 'z', from: -6.15, to: 6.25, center: -1.8, halfW: 5.6, yEave: 10.0, yRidge: 19.2, overhang: 0.12 });

  // =========================================================================================
  // Tower
  // =========================================================================================
  const TX = -1.8, TZ = 0, TH = 2.75, SHAFT_TOP = 25.8;
  hb.box('brick', TX - TH, TX + TH, 13, SHAFT_TOP, TZ - TH, TZ + TH, C.brick);
  for (const [facing, plane, center] of [['+z', TZ + TH, TX], ['-z', TZ - TH, TX], ['+x', TX + TH, TZ], ['-x', TX - TH, TZ]] as const) {
    const f = Facade.axis(hb, facing, plane, center, 0.3);
    f.band(-TH, TH, 19.4, 0.22);
    f.band(-TH, TH, 24.55, 0.22);
    f.band(-TH, TH, 17.6, 0.18, 0.06);
    f.quoins(-TH, 17.8, 25.6, 1);
    f.quoins(TH, 17.8, 25.6, -1);
    clockFace(hb, f.at(0, 22.05, 0), 1.15, 10, 9);
    // small louvred openings flanking the clock
    for (const s of [-1, 1]) {
      const sh = new THREE.Shape(archPath(s * 2.05 - 0.22, s * 2.05 + 0.22, 20.4, 23.0, 'round').getPoints(8));
      f.plate(sh, 0.01, 'detail', C.dark, 0.02);
      f.box(s * 2.05 - 0.3, s * 2.05 + 0.3, 20.25, 20.4, -0.05, 0.08, 'stone', C.stone);
    }
  }
  // cornice + balustrade with corner obelisks
  hb.box('stone', TX - TH - 0.1, TX + TH + 0.1, SHAFT_TOP - 0.2, SHAFT_TOP, TZ - TH - 0.1, TZ + TH + 0.1, C.stone);
  hb.box('stone', TX - TH - 0.25, TX + TH + 0.25, SHAFT_TOP, SHAFT_TOP + 0.3, TZ - TH - 0.25, TZ + TH + 0.25, C.stone);
  hb.box('lead', TX - TH, TX + TH, SHAFT_TOP + 0.3, SHAFT_TOP + 0.34, TZ - TH, TZ + TH, C.leadDark);
  const BY = SHAFT_TOP + 0.3, BR = TH + 0.12;
  for (const [ax, sgn] of [['x', 1], ['x', -1], ['z', 1], ['z', -1]] as const) {
    const along = (a0: number, a1: number, y0: number, y1: number, t: number) => {
      if (ax === 'x') hb.box('stone', TX + sgn * BR - t, TX + sgn * BR + t, y0, y1, TZ + a0, TZ + a1, C.stone);
      else hb.box('stone', TX + a0, TX + a1, y0, y1, TZ + sgn * BR - t, TZ + sgn * BR + t, C.stone);
    };
    along(-BR, BR, BY, BY + 0.12, 0.12);
    along(-BR - 0.06, BR + 0.06, BY + 0.85, BY + 0.98, 0.15);
    for (let a = -BR + 0.4; a < BR - 0.25; a += 0.38) along(a - 0.055, a + 0.055, BY + 0.12, BY + 0.85, 0.055);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) obelisk(hb, new THREE.Vector3(TX + sx * BR, BY, TZ + sz * BR), 2.5, 0.52);
  // octagonal bell stage (brick with stone pilasters, arched louvres)
  const OR = 2.35, OY0 = BY, OY1 = 31.4;
  const ap = OR * Math.cos(Math.PI / 8), half = OR * Math.sin(Math.PI / 8);
  hb.add('detail', octPrism(1.75, OY1 - OY0), mat(TX, OY0, TZ), C.dark);
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const f = Facade.radial(hb, TX, TZ, a, ap, 0.4);
    const ys = 29.6;
    f.wall([V2(-half - 0.02, OY0), V2(half + 0.02, OY0), V2(half + 0.02, OY1), V2(-half - 0.02, OY1)], [archPath(-0.4, 0.4, 27.2, ys, 'round')]);
    f.voussoirs(0, ys, 0.4, 7, 0.26, 0.04);
    f.box(-0.52, 0.52, 27.05, 27.2, -0.2, 0.08, 'stone', C.stone);
    for (let i = 0; i < 7; i++) f.box(-0.4, 0.4, 27.45 + i * 0.36, 27.5 + i * 0.36, -0.36, -0.14, 'detail', C.louvre, 0);
    for (let i = 0; i < 7; i++) f.hb.add('detail', new THREE.BoxGeometry(0.8, 0.04, 0.24), f.at(0, 27.42 + i * 0.36, -0.25, 0, 0, 0.55), C.louvre);
    f.band(-half, half, 28.35, 0.12, 0.04);
  }
  for (let k = 0; k < 8; k++) {
    const phi = Math.PI / 8 + (k * Math.PI) / 4;
    hb.add('stone', new THREE.BoxGeometry(0.3, OY1 - OY0, 0.3), mat(TX + Math.sin(phi) * (OR - 0.02), (OY0 + OY1) / 2, TZ + Math.cos(phi) * (OR - 0.02), 0, phi, 0), C.stone);
  }
  hb.add('stone', octLathe([[1.8, OY1], [2.42, OY1], [2.6, OY1 + 0.18], [2.62, OY1 + 0.4], [1.8, OY1 + 0.4]]), mat(TX, 0, TZ), C.stone);
  // lead skirt up to the open lantern
  const LY0 = 33.3;
  hb.add('lead', octLathe([[2.52, OY1 + 0.4], [2.36, 32.2], [2.02, 32.75], [1.8, LY0], [0.01, LY0]]), mat(TX, 0, TZ), C.lead);
  // open carillon lantern: 8 columns, entablature, bells
  const LY1 = 36.7, CR = 1.58;
  for (let k = 0; k < 8; k++) {
    const phi = Math.PI / 8 + (k * Math.PI) / 4;
    const x = TX + Math.sin(phi) * CR, z = TZ + Math.cos(phi) * CR;
    hb.add('stone', new THREE.CylinderGeometry(0.1, 0.12, 2.6, 10), mat(x, LY0 + 0.25 + 1.3, z), C.stone, 'keep');
    hb.add('stone', new THREE.BoxGeometry(0.3, 0.25, 0.3), mat(x, LY0 + 0.125, z, 0, phi, 0), C.stone);
    hb.add('stone', new THREE.BoxGeometry(0.32, 0.2, 0.32), mat(x, LY0 + 2.95, z, 0, phi, 0), C.stone);
  }
  hb.add('stone', octLathe([[1.3, LY0 + 3.05], [1.85, LY0 + 3.05], [2.0, LY0 + 3.25], [2.0, LY1], [1.3, LY1]]), mat(TX, 0, TZ), C.stone);
  // balustrade rail between the columns
  hb.add('stone', octLathe([[1.5, LY0 + 0.75], [1.66, LY0 + 0.75], [1.66, LY0 + 0.85], [1.5, LY0 + 0.85]]), mat(TX, 0, TZ), C.stone);
  hb.box('detail', TX - 1.4, TX + 1.4, LY0 + 2.75, LY0 + 2.9, TZ - 0.07, TZ + 0.07, C.doorWood);
  hb.box('detail', TX - 0.07, TX + 0.07, LY0 + 2.75, LY0 + 2.9, TZ - 1.4, TZ + 1.4, C.doorWood);
  hb.add('detail', bell(1.0), mat(TX, LY0 + 1.6, TZ), C.bronze, 'keep');
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.3;
    const h = 0.32 + (k % 3) * 0.08;
    hb.add('detail', bell(h), mat(TX + Math.sin(a) * 0.95, LY0 + 2.65 - h - (k % 2) * 0.35, TZ + Math.cos(a) * 0.95), C.bronze, 'keep');
  }
  // bell-shaped lead cupola
  const KY = LY1;
  hb.add('lead', octLathe([[1.98, KY], [2.05, KY + 0.15], [1.98, KY + 0.5], [1.76, KY + 0.95], [1.42, KY + 1.5], [1.05, KY + 2.15], [0.74, KY + 2.8], [0.58, KY + 3.3], [0.52, KY + 3.8], [0.001, KY + 3.8]]), mat(TX, 0, TZ), C.lead);
  // small open lantern, cap, spire, ball and vane
  const SY = KY + 3.8;
  for (let k = 0; k < 8; k++) {
    const phi = Math.PI / 8 + (k * Math.PI) / 4;
    hb.add('detail', new THREE.BoxGeometry(0.08, 1.1, 0.08), mat(TX + Math.sin(phi) * 0.42, SY + 0.55, TZ + Math.cos(phi) * 0.42), C.white);
  }
  hb.add('detail', new THREE.CylinderGeometry(0.2, 0.2, 1.1, 8), mat(TX, SY + 0.55, TZ), C.dark, 'keep');
  hb.add('lead', octLathe([[0.6, SY + 1.1], [0.62, SY + 1.22], [0.45, SY + 1.45], [0.22, SY + 1.8], [0.13, SY + 1.95]]), mat(TX, 0, TZ), C.lead);
  hb.add('lead', octLathe([[0.14, SY + 1.95], [0.1, SY + 3.3], [0.015, SY + 5.8]]), mat(TX, 0, TZ), C.leadDark);
  hb.add('detail', new THREE.SphereGeometry(0.22, 12, 8), mat(TX, SY + 3.5, TZ), C.gold, 'keep');
  hb.add('detail', new THREE.CylinderGeometry(0.025, 0.025, 1.6, 6), mat(TX, SY + 6.1, TZ), C.gold, 'keep');
  hb.add('detail', new THREE.BoxGeometry(0.8, 0.34, 0.025), mat(TX + 0.42, SY + 6.45, TZ), C.gold);
  hb.add('detail', new THREE.SphereGeometry(0.07, 8, 6), mat(TX, SY + 6.92, TZ), C.gold, 'keep');
  for (const [dx, dz] of [[1, 0], [0, 1]]) hb.add('detail', new THREE.BoxGeometry(0.02 + dx * 0.6, 0.02, 0.02 + dz * 0.6), mat(TX, SY + 5.95, TZ), C.iron);

  const model = hb.build('de_waag');
  return { ...model, colliders };
}
