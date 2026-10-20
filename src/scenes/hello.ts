// Sanity scene for the tooling: a lit box on a plane. ?scene=hello
import * as THREE from 'three';
import type { SceneEntry } from '../contracts';
import { setupDevCamera } from '../dev/devCamera';

const hello: SceneEntry = async (engine, params) => {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x6d6a63, roughness: 0.9 }),
  );
  ground.receiveShadow = true;
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 4),
    new THREE.MeshStandardMaterial({ color: 0x9b3b2a, roughness: 0.7 }),
  );
  box.position.y = 2;
  box.castShadow = true;
  engine.scene.add(ground, box);
  setupDevCamera(engine, params, { cam: new THREE.Vector3(12, 8, 14), look: new THREE.Vector3(0, 2, 0) });
  engine.onUpdate((dt) => (box.rotation.y += dt * 0.5), 40);
  engine.start();
  window.__ready = true;
};

export default hello;
