// Simple placeholder CarModel used by the vehicle test track when the real procedural car
// models (src/vehicle/models) are not available. Implements the CarModel contract faithfully
// (root/body/wheel pivots, setWheel, lights) so the physics and cameras can be tested.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { CarLightState, CarModel, CarSpec } from '../../contracts';

export function createPlaceholderModel(spec: CarSpec, color?: THREE.ColorRepresentation): CarModel {
  const root = new THREE.Group();
  root.name = `placeholder-${spec.id}`;
  const body = new THREE.Group();
  root.add(body);

  const L = spec.length;
  const W = spec.width;
  const H = spec.height;
  const R = spec.wheelRadius;
  const clearance = 0.15;
  const beltY = clearance + 0.52 * (H - clearance);
  const van = spec.category === 'bestelbus';

  const paint = new THREE.MeshPhysicalMaterial({
    color: color ?? spec.paints[0] ?? '#3a5a80',
    roughness: 0.35,
    metalness: 0.4,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1218, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.85 });
  const black = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.75 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.92 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.3, metalness: 0.9 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1a10, emissiveIntensity: 0.15, roughness: 0.3 });
  const revMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.3 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 });

  const lower = new THREE.Mesh(new RoundedBoxGeometry(W, beltY - clearance + 0.05, L, 3, 0.12), paint);
  lower.position.set(0, (beltY + clearance) / 2, 0);
  const cabinL = van ? L * 0.88 : L * 0.52;
  const cabinW = van ? W * 0.98 : W * 0.86;
  const cabinH = H - beltY;
  const cabin = new THREE.Mesh(new RoundedBoxGeometry(cabinW, cabinH, cabinL, 3, 0.14), glass);
  cabin.position.set(0, beltY + cabinH / 2 - 0.02, van ? -L * 0.04 : -L * 0.05);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(cabinW * 0.96, 0.06, cabinL * 0.86, 2, 0.03), paint);
  roof.position.set(0, H - 0.02, cabin.position.z - (van ? 0 : 0.05));
  const bumperF = new THREE.Mesh(new RoundedBoxGeometry(W * 0.96, 0.18, 0.12, 2, 0.05), black);
  bumperF.position.set(0, clearance + 0.12, L / 2 - 0.02);
  const bumperR = bumperF.clone();
  bumperR.position.z = -L / 2 + 0.02;
  for (const m of [lower, cabin, roof, bumperF, bumperR]) {
    m.castShadow = true;
    m.receiveShadow = true;
    body.add(m);
  }

  const lightGeo = new THREE.BoxGeometry(0.32, 0.1, 0.04);
  const heads: THREE.Mesh[] = [];
  const tails: THREE.Mesh[] = [];
  for (const side of [1, -1]) {
    const h = new THREE.Mesh(lightGeo, headMat);
    h.position.set(side * (W / 2 - 0.25), beltY - 0.1, L / 2 + 0.005);
    const t = new THREE.Mesh(lightGeo, tailMat);
    t.position.set(side * (W / 2 - 0.22), beltY - 0.08, -L / 2 - 0.005);
    heads.push(h);
    tails.push(t);
    body.add(h, t);
  }
  const rev = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.03), revMat);
  rev.position.set(-0.3, clearance + 0.25, -L / 2 - 0.01);
  body.add(rev);
  const plateF = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.11, 0.02), plateMat);
  plateF.position.set(0, clearance + 0.28, L / 2 + 0.04);
  const plateR = plateF.clone();
  plateR.position.z = -L / 2 - 0.035;
  body.add(plateF, plateR);

  // Wheels: pivot (steer) -> spinner (spin about x) -> tyre + rim.
  const tyreGeo = new THREE.CylinderGeometry(R, R, spec.wheelWidth, 28, 1).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(R * 0.62, R * 0.62, spec.wheelWidth + 0.01, 10, 1).rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(spec.wheelWidth + 0.02, R * 1.15, 0.05);
  const wb = spec.wheelbase;
  const centers: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(spec.trackFront / 2, R, wb / 2),
    new THREE.Vector3(-spec.trackFront / 2, R, wb / 2),
    new THREE.Vector3(spec.trackRear / 2, R, -wb / 2),
    new THREE.Vector3(-spec.trackRear / 2, R, -wb / 2),
  ];
  const pivots: THREE.Object3D[] = [];
  const spinners: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const pivot = new THREE.Group();
    pivot.position.copy(centers[i]);
    const spinner = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, rubber);
    tyre.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    spinner.add(tyre, rim);
    for (let k = 0; k < 3; k++) {
      const spoke = new THREE.Mesh(spokeGeo, rimMat);
      spoke.rotation.x = (k * Math.PI) / 3;
      spinner.add(spoke);
    }
    pivot.add(spinner);
    root.add(pivot);
    pivots.push(pivot);
    spinners.push(spinner);
  }

  const lights: CarLightState = {};
  return {
    specId: spec.id,
    root,
    body,
    wheels: pivots as [THREE.Object3D, THREE.Object3D, THREE.Object3D, THREE.Object3D],
    wheelCenters: centers,
    setWheel(i, steer, spin, suspensionOffset) {
      const p = pivots[i];
      p.rotation.y = steer;
      p.position.y = centers[i].y + suspensionOffset;
      spinners[i].rotation.x = spin;
    },
    setPaint(c) {
      paint.color.set(c);
    },
    setLights(state) {
      Object.assign(lights, state);
      headMat.emissiveIntensity = lights.head ? 4 : 0;
      tailMat.emissiveIntensity = lights.brake ? 6 : lights.head ? 1.5 : 0.15;
      revMat.emissiveIntensity = lights.reverse ? 3 : 0;
    },
    setPlate() {
      /* placeholder: plain yellow plate */
    },
    dispose() {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of [paint, glass, black, rubber, rimMat, headMat, tailMat, revMat, plateMat]) m.dispose();
    },
  };
}
