// Dev helper for test scenes: orbit camera controlled by URL params.
//   ?cam=x,y,z&look=x,y,z   initial camera position / target (world metres)
// Also exposes window.__debug.setCam(x,y,z,lx,ly,lz) for the screenshot tool.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Engine } from '../contracts';

function parseVec(s: string | null, fallback: THREE.Vector3): THREE.Vector3 {
  if (!s) return fallback.clone();
  const p = s.split(',').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return fallback.clone();
  return new THREE.Vector3(p[0], p[1], p[2]);
}

export function setupDevCamera(
  engine: Engine,
  params: URLSearchParams,
  defaults: { cam: THREE.Vector3; look: THREE.Vector3 },
): OrbitControls {
  const cam = engine.camera;
  cam.position.copy(parseVec(params.get('cam'), defaults.cam));
  const controls = new OrbitControls(cam, engine.canvas);
  controls.target.copy(parseVec(params.get('look'), defaults.look));
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();
  engine.onUpdate(() => {
    controls.update();
    engine.setFocus(controls.target);
  }, 50);
  window.__debug = window.__debug ?? {};
  window.__debug.setCam = (x: number, y: number, z: number, lx: number, ly: number, lz: number) => {
    cam.position.set(x, y, z);
    controls.target.set(lx, ly, lz);
    controls.update();
  };
  return controls;
}
