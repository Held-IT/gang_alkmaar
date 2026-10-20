// The jelly body: torso bean (pelvis + chest + head, smooth skin weights) + limbs as rigid
// rounded capsules whose ball ends sit exactly on the joints (so any joint angle still reads as one
// soft sausage), mitten hands and stubby feet. One skinned geometry, shared by all beasts of a scale.
import * as THREE from 'three';
import type { BeastPartName } from '../../brawl/contracts';
import { SkinMesher, capsuleProfile, deform, ellipsoid, latheAlong, torsoBand } from './geometry';
import { getTorsoShape, type Limb, type TorsoShape } from './shape';

const LIMB_RADIAL = 16;

export function limbSegment(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, radial = LIMB_RADIAL): THREE.BufferGeometry {
  const L = a.distanceTo(b);
  return latheAlong(a, b, capsuleProfile(L, ra, rb, 4, 3), radial);
}

function addLimb(m: SkinMesher, limb: Limb, upper: BeastPartName, lower: BeastPartName): void {
  m.add(limbSegment(limb.top, limb.mid, limb.rTop, limb.rMid), { color: 0xffffff }, { bone: upper });
  m.add(limbSegment(limb.mid, limb.end, limb.rMid, limb.rEnd), { color: 0xffffff }, { bone: lower });
}

/** Mitten: a soft paddle with a thumb pointing forward (side = +1 left, -1 right). */
export function mittenGeometry(c: THREE.Vector3, side: number, inflate = 0): THREE.BufferGeometry[] {
  const paddle = ellipsoid(c, 0.066 + inflate, 0.082 + inflate, 0.079 + inflate, 16, 12);
  deform(paddle, (v) => {
    // fuller at the fingertips (bottom), flatter palm side
    const t = (c.y - v.y) / 0.083;
    const k = 1 + 0.12 * Math.max(0, t);
    v.z = c.z + (v.z - c.z) * k;
    if ((v.x - c.x) * side < 0) v.x = c.x + (v.x - c.x) * 0.88;
  });
  const t0 = new THREE.Vector3(c.x - side * 0.016, c.y + 0.02, c.z + 0.045);
  const t1 = new THREE.Vector3(c.x - side * 0.03, c.y - 0.018, c.z + 0.09);
  const thumb = latheAlong(t0, t1, capsuleProfile(t0.distanceTo(t1), 0.034 + inflate, 0.03 + inflate, 4, 2), 10);
  return [paddle, thumb];
}

/** Stubby rounded foot with a flat-ish sole. */
export function footGeometry(c: THREE.Vector3, soleY: number, inflate = 0, len = 1): THREE.BufferGeometry {
  const g = ellipsoid(c, 0.086 + inflate, 0.058 + inflate, 0.122 * len + inflate, 16, 10);
  return deform(g, (v) => {
    if (v.y < c.y) v.y = Math.max(soleY - inflate, c.y + (v.y - c.y) * 0.75);
    // wider at the toes
    const f = (v.z - c.z) / 0.122;
    v.x = c.x + (v.x - c.x) * (1 + 0.1 * f);
  });
}

function buildBody(shape: TorsoShape): THREE.BufferGeometry {
  const d = shape.dims;
  const m = new SkinMesher(shape);
  const white = { color: 0xffffff };
  m.add(torsoBand(shape, d.yB, d.yT, 0, { rings: 40, radial: 40 }), white, 'torso');
  // soft shoulders: blobs half way between the torso and the upper arm fill the notch
  for (const [side, bone] of [[1, 'upperArmL'], [-1, 'upperArmR']] as const) {
    const top = side > 0 ? d.armL.top : d.armR.top;
    const c = new THREE.Vector3(top.x - side * 0.04, top.y + 0.004, top.z - 0.004);
    m.add(ellipsoid(c, 0.072, 0.072, 0.086, 16, 10), white, { blend: [['chest', 0.6], [bone, 0.4]] });
  }
  addLimb(m, d.armL, 'upperArmL', 'lowerArmL');
  addLimb(m, d.armR, 'upperArmR', 'lowerArmR');
  addLimb(m, d.legL, 'upperLegL', 'lowerLegL');
  addLimb(m, d.legR, 'upperLegR', 'lowerLegR');
  for (const g of mittenGeometry(d.handL, 1)) m.add(g, white, { bone: 'lowerArmL' });
  for (const g of mittenGeometry(d.handR, -1)) m.add(g, white, { bone: 'lowerArmR' });
  m.add(footGeometry(d.footL, d.soleY), white, { bone: 'lowerLegL' });
  m.add(footGeometry(d.footR, d.soleY), white, { bone: 'lowerLegR' });
  return m.build(false);
}

const cache = new Map<number, THREE.BufferGeometry>();

/** Shared body geometry for a given scale (bind space scaled about the feet). */
export function getBodyGeometry(scale: number): THREE.BufferGeometry {
  const key = Math.round(scale * 1000);
  let g = cache.get(key);
  if (!g) {
    g = buildBody(getTorsoShape());
    if (key !== 1000) {
      g.scale(scale, scale, scale);
      g.computeBoundingSphere();
      g.computeBoundingBox();
    }
    cache.set(key, g);
  }
  return g;
}
