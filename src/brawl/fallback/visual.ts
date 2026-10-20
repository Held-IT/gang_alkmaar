// Placeholder beast visual (used only until src/beast/visual/index.ts exists): one smooth blob
// mesh per rig part, two eyes on the head, a simple hat per costume.
import * as THREE from 'three';
import { BEAST_PARTS, BEAST_RIG } from '../../beast/rig';
import type { BeastExpression, BeastPartName, BeastVisual, CostumeInfo } from '../contracts';
import type { ColourInfo } from '../types';

export const FALLBACK_COSTUMES: CostumeInfo[] = [
  { id: 'geen', name: 'Geen', description: 'Gewoon jezelf, lekker puur.' },
  { id: 'kaasdrager', name: 'Kaasdrager', description: 'Strohoed en wit pak van het Kaasdragersgilde.' },
  { id: 'molenaar', name: 'Molenaar', description: 'Pet en schort vol meel.' },
  { id: 'schipper', name: 'Schipper', description: 'Kapiteinspet van de rondvaartboot.' },
  { id: 'toerist', name: 'Toerist', description: 'Zonnehoedje en een fototoestel.' },
];

export const FALLBACK_COLOURS: ColourInfo[] = [
  { hex: '#f2c230', name: 'Kaasgeel' },
  { hex: '#d22b2b', name: 'Alkmaars rood' },
  { hex: '#2f6fb5', name: 'Grachtblauw' },
  { hex: '#4c9a3a', name: 'Poldergroen' },
  { hex: '#e85d9c', name: 'Tulpenroze' },
  { hex: '#f07f1e', name: 'Oranje' },
  { hex: '#7d4bb3', name: 'Paars' },
  { hex: '#2bb3a6', name: 'Turkoois' },
  { hex: '#f1ede4', name: 'Melkwit' },
  { hex: '#9a6233', name: 'Stroopwafel' },
];

const HAT: Record<string, { colour: number; r: number; h: number; brim: number } | null> = {
  geen: null,
  kaasdrager: { colour: 0xe8cf7a, r: 0.13, h: 0.08, brim: 0.25 },
  molenaar: { colour: 0x6b5a48, r: 0.17, h: 0.07, brim: 0.19 },
  schipper: { colour: 0x1d2b4a, r: 0.16, h: 0.09, brim: 0.18 },
  toerist: { colour: 0xf4f0e0, r: 0.14, h: 0.07, brim: 0.24 },
};

export function createFallbackVisual(opts: { colour: string; costume: string; scale?: number }): BeastVisual {
  const root = new THREE.Group();
  root.name = 'beast-fallback';
  const scale = opts.scale ?? 1;
  const body = new THREE.MeshStandardMaterial({ color: opts.colour, roughness: 0.42, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.3 });
  const geoms: THREE.BufferGeometry[] = [];
  const parts = {} as Record<BeastPartName, THREE.Object3D>;
  for (const name of BEAST_PARTS) {
    const s = BEAST_RIG[name];
    const g =
      s.shape === 'sphere'
        ? new THREE.SphereGeometry(s.radius * scale, 20, 14)
        : new THREE.CapsuleGeometry(s.radius * scale, s.halfHeight * 2 * scale, 6, 14);
    geoms.push(g);
    const m = new THREE.Mesh(g, body);
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = name;
    root.add(m);
    parts[name] = m;
  }
  // eyes on the head (+z forward)
  const eyeGeo = new THREE.SphereGeometry(0.035 * scale, 10, 8);
  geoms.push(eyeGeo);
  const eyes: THREE.Mesh[] = [];
  for (const sx of [1, -1]) {
    const e = new THREE.Mesh(eyeGeo, dark);
    e.position.set(sx * 0.075 * scale, 0.04 * scale, 0.19 * scale);
    parts.head.add(e);
    eyes.push(e);
  }
  let hat: THREE.Group | null = null;
  function setCostume(id: string): void {
    if (hat) {
      hat.removeFromParent();
      hat.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      hat = null;
    }
    const spec = HAT[id];
    if (!spec) return;
    hat = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: spec.colour, roughness: 0.7 });
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(spec.r * scale, spec.r * 1.05 * scale, spec.h * scale, 18), mat);
    crown.position.y = spec.h * 0.5 * scale;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(spec.brim * scale, spec.brim * scale, 0.015 * scale, 20), mat);
    hat.add(crown, brim);
    hat.position.y = 0.17 * scale;
    hat.traverse((o) => (o.castShadow = true));
    parts.head.add(hat);
  }
  setCostume(opts.costume);
  let expression: BeastExpression = 'neutral';
  let blink = 2 + Math.random() * 3;
  return {
    root,
    parts,
    setExpression(e) {
      expression = e;
    },
    setColour(hex) {
      body.color.set(hex);
    },
    setCostume,
    update(dt) {
      blink -= dt;
      let sy = expression === 'ko' ? 0.15 : expression === 'happy' ? 0.55 : expression === 'scared' ? 1.4 : 1;
      if (blink < 0) {
        sy = 0.1;
        if (blink < -0.12) blink = 2 + Math.random() * 4;
      }
      for (const e of eyes) e.scale.set(1, sy, 1);
    },
    dispose() {
      setCostume('geen');
      root.removeFromParent();
      geoms.forEach((g) => g.dispose());
      body.dispose();
      dark.dispose();
    },
  };
}
