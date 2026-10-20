// Traffic signs (RVV) on grey posts and blue street-name plates on two short posts.
// Sign faces: one alpha-tested quad per sign, all shapes from one atlas (per-instance aUvRect),
// back faces render as galvanised metal. Several signs on the same spot are stacked on one post.
import * as THREE from 'three';
import type { PropsData } from '../../contracts';
import type { GroundFn } from './util/ground';
import { PropBatch } from './util/batch';
import { MeshBuilder, cylinder } from './util/geom';
import { createPropDepthMaterial, createPropMaterial } from './util/propMaterial';
import type { Colliders } from './util/physicsStub';
import { PLATE_H, normalizeSignCode, renderSignAtlas, renderStreetNameAtlas } from './signTextures';
import { getFurnitureMaterial } from './street';

const SIGN_BOTTOM = 2.2; // lowest sign edge above the pavement (m)
const STACK_GAP = 0.06;
const PLATE_Y = 0.95; // street-name plate centre height

function poleGeometry(lod: number): THREE.BufferGeometry {
  const b = new MeshBuilder();
  // unit-height pole, scaled in y per instance
  b.add(cylinder(0.024, 0.024, 1, lod === 0 ? 10 : 5), null, { color: 0x8f9395, rough: 0.4, metal: 0.8 });
  return b.build();
}

function signQuad(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add(new THREE.PlaneGeometry(1, 1), null, { color: 0xffffff, rough: 0.45, metal: 0.0 });
  return b.build();
}

function plateBox(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.add(new THREE.BoxGeometry(1, PLATE_H, 0.018), null, { color: 0xffffff, rough: 0.3, metal: 0.0 });
  return b.build();
}

export function buildSigns(props: PropsData, colliders: Colliders, anisotropy: number, ground: GroundFn = () => 0): PropBatch[] {
  const out: PropBatch[] = [];
  const signs = props.signs ?? [];
  const names = props.streetNameSigns ?? [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  const poles = new PropBatch({
    name: 'bordpaal',
    lods: [
      { dist: 60, parts: [{ geometry: poleGeometry(0), material: getFurnitureMaterial(), castShadow: true }] },
      { dist: 240, parts: [{ geometry: poleGeometry(1), material: getFurnitureMaterial(), castShadow: false }] },
    ],
    cellSize: 64,
    margin: 3,
  });

  // ------------------------------------------------------------------ RVV signs
  if (signs.length) {
    const atlas = renderSignAtlas(signs.map((s) => s[3]), anisotropy);
    const opts = { name: 'verkeersbord', map: atlas.texture, alphaTest: 0.5, side: THREE.DoubleSide, uvRect: true, signBack: true };
    const material = createPropMaterial(opts);
    const depth = createPropDepthMaterial(opts);
    const faces = new PropBatch({
      name: 'verkeersbord',
      lods: [
        { dist: 70, parts: [{ geometry: signQuad(), material, depthMaterial: depth, castShadow: true }] },
        { dist: 260, parts: [{ geometry: signQuad(), material, castShadow: false }] },
      ],
      attrs: [{ name: 'aUvRect', itemSize: 4 }],
      cellSize: 64,
      margin: 3,
    });
    // group signs on (nearly) the same spot into one stack on one post
    const groups = new Map<string, { x: number; z: number; rot: number; codes: string[] }>();
    for (const [x, z, rot, code] of signs) {
      const key = `${Math.round(x / 0.4)},${Math.round(z / 0.4)}`;
      const g = groups.get(key);
      if (g) g.codes.push(code);
      else groups.set(key, { x, z, rot, codes: [code] });
    }
    for (const g of groups.values()) {
      const lay = g.codes.map((c) => atlas.layouts.get(normalizeSignCode(c))!).filter(Boolean);
      if (!lay.length) continue;
      const stackH = lay.reduce((s, l) => s + l.h, 0) + STACK_GAP * (lay.length - 1);
      const gy = ground(g.x, g.z);
      let top = gy + SIGN_BOTTOM + stackH;
      const fx = Math.sin(g.rot), fz = Math.cos(g.rot);
      q.setFromAxisAngle(up, g.rot);
      for (const l of lay) {
        const cy = top - l.h / 2;
        pos.set(g.x + fx * 0.035, cy, g.z + fz * 0.035);
        m.compose(pos, q, scl.set(l.w, l.h, 1));
        faces.addMatrix(m, null, l.uv);
        top -= l.h + STACK_GAP;
      }
      const poleTop = SIGN_BOTTOM + stackH + 0.03;
      m.compose(pos.set(g.x, gy, g.z), q, scl.set(1, poleTop, 1));
      poles.addMatrix(m);
      colliders.cylinder(g.x, g.z, 0.05, poleTop, gy, 'sign');
    }
    out.push(faces);
  }

  // ------------------------------------------------------------------ street-name plates
  if (names.length) {
    const atlas = renderStreetNameAtlas(names.map((n) => n[3]), anisotropy);
    const plateBatches = atlas.pages.map((tex, p) => {
      const material = createPropMaterial({ name: `straatnaambord_${p}`, map: tex, uvRect: true });
      const depth = createPropDepthMaterial({ name: `straatnaambord_${p}`, uvRect: true });
      return new PropBatch({
        name: `straatnaambord_${p}`,
        lods: [
          { dist: 45, parts: [{ geometry: plateBox(), material, depthMaterial: depth, castShadow: true }] },
          { dist: 140, parts: [{ geometry: plateBox(), material, castShadow: false }] },
        ],
        attrs: [{ name: 'aUvRect', itemSize: 4 }],
        cellSize: 64,
        margin: 2,
      });
    });
    for (const [x, z, rot, name] of names) {
      const l = atlas.layouts.get(String(name ?? '').trim());
      if (!l) continue;
      q.setFromAxisAngle(up, rot);
      const gy = ground(x, z);
      m.compose(pos.set(x, gy + PLATE_Y, z), q, scl.set(l.w, 1, 1));
      plateBatches[l.page].addMatrix(m, null, l.uv);
      // two posts just inside the plate ends, slightly behind it
      const rx = Math.cos(rot), rz = -Math.sin(rot);
      const bx = -Math.sin(rot) * 0.035, bz = -Math.cos(rot) * 0.035;
      for (const s of [-1, 1]) {
        const off = s * (l.w / 2 - 0.07);
        const px = x + rx * off + bx, pz = z + rz * off + bz;
        m.compose(pos.set(px, gy, pz), q, scl.set(0.85, PLATE_Y + PLATE_H / 2 + 0.02, 0.85));
        poles.addMatrix(m);
        colliders.cylinder(px, pz, 0.04, 1.1, gy, 'street_sign');
      }
    }
    out.push(...plateBatches);
  }
  out.push(poles);
  return out.filter((b) => b.count > 0);
}
