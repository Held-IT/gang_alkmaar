// Fallback beast visual (beast-physics module): simple coloured capsules/spheres per rig part with
// googly eyes, used while src/beast/visual is missing or fails. Implements the BeastVisual contract.
import * as THREE from 'three';
import type { BeastExpression, BeastPartName, BeastVisual } from '../../brawl/contracts';
import { BEAST_PARTS, BEAST_RIG } from '../rig';

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) geoCache.set(key, (g = make()));
  return g;
}

const eyeWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
const eyePupil = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });

export function createFallbackVisual(opts: { colour: string; costume?: string; scale?: number }): BeastVisual {
  const s = opts.scale ?? 1;
  const root = new THREE.Group();
  root.name = 'beast-fallback';
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(opts.colour), roughness: 0.55 });
  const parts = {} as Record<BeastPartName, THREE.Object3D>;
  for (const name of BEAST_PARTS) {
    const spec = BEAST_RIG[name];
    const r = spec.radius * s;
    const hh = spec.halfHeight * s;
    const g =
      spec.shape === 'sphere'
        ? geo(`s${r.toFixed(3)}`, () => new THREE.SphereGeometry(r, 20, 14))
        : geo(`c${r.toFixed(3)}_${hh.toFixed(3)}`, () => new THREE.CapsuleGeometry(r, hh * 2, 6, 14));
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    root.add(mesh);
    parts[name] = mesh;
  }
  // eyes on the head (+z = forward)
  const head = parts.head;
  const hr = BEAST_RIG.head.radius * s;
  const eyes: THREE.Object3D[] = [];
  for (const side of [1, -1]) {
    const e = new THREE.Mesh(geo(`ew${hr.toFixed(3)}`, () => new THREE.SphereGeometry(hr * 0.26, 12, 8)), eyeWhite);
    e.position.set(side * hr * 0.38, hr * 0.18, hr * 0.82);
    const p = new THREE.Mesh(geo(`ep${hr.toFixed(3)}`, () => new THREE.SphereGeometry(hr * 0.12, 10, 6)), eyePupil);
    p.position.set(0, 0, hr * 0.2);
    e.add(p);
    head.add(e);
    eyes.push(e);
  }
  let expr: BeastExpression = 'neutral';
  let t = 0;
  return {
    root,
    parts,
    setExpression(e) {
      expr = e;
    },
    setColour(hex) {
      mat.color.set(hex);
    },
    setCostume() {
      /* no costumes in the fallback */
    },
    update(dt) {
      t += dt;
      const ko = expr === 'ko';
      for (let i = 0; i < eyes.length; i++) {
        const e = eyes[i];
        const sy = ko ? 0.25 : expr === 'scared' ? 1.25 : expr === 'angry' ? 0.7 : 1;
        e.scale.set(1, sy, 1);
        const pupil = e.children[0];
        pupil.position.x = ko ? Math.sin(t * 9 + i * 2) * hr * 0.08 : 0;
      }
    },
    dispose() {
      mat.dispose();
      root.removeFromParent();
    },
  };
}
