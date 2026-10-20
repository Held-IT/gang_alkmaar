// Tree crowns never hide the fighters: the tree materials (src/world/props/util/propMaterial.ts,
// PROP_WIND) dither away foliage and bark that sit in front of these points on screen. Called by
// the brawl scene after the camera has been placed for the frame.
import * as THREE from 'three';
import { PROP_CUT_MAX, propUniforms } from '../world/props/util/propMaterial';

const v = new THREE.Vector3();

/**
 * Cut-outs around `points` (world, beast chests), `radius` metres at the point's depth; `near`:
 * trees closer to the camera than that fade out; `city`: also cut city surfaces (a bridge deck
 * passing over the rondvaartboot).
 */
export function setTreeCut(camera: THREE.Camera, points: readonly THREE.Vector3[], radius: number, near = 0, city = false): void {
  camera.updateMatrixWorld();
  // trees much closer than the action fade out (foreground crowns at the bottom / sides of the screen)
  propUniforms.uCutNear.value.set(near * 0.8, near);
  const n = Math.min(points.length, PROP_CUT_MAX);
  const cut = propUniforms.uCut.value;
  for (let i = 0; i < n; i++) {
    v.copy(points[i]);
    v.y += 0.25;
    v.applyMatrix4(camera.matrixWorldInverse);
    cut[i].set(v.x, v.y, v.z, radius);
  }
  propUniforms.uCutCount.value = n;
  propUniforms.uCityCutCount.value = city ? n : 0;
}

export function clearTreeCut(): void {
  propUniforms.uCutCount.value = 0;
  propUniforms.uCityCutCount.value = 0;
  propUniforms.uCutNear.value.set(0, 0);
}
