// Collider helper: wraps a PhysicsWorld (or nothing) and counts colliders. Never throws, so a
// missing / stubbed physics module never breaks prop creation.
import * as THREE from 'three';
import type { StaticColliderSink } from '../types';

const _c = new THREE.Vector3();

export class Colliders {
  count = 0;
  /** `dy` lifts every collider (e.g. a whole market standing on raised ground). */
  constructor(private sink: StaticColliderSink | null | undefined, private readonly dy = 0) {}

  /** Same physics sink, colliders lifted by `dy` metres. */
  lifted(dy: number): Colliders {
    const c = new Colliders(this.sink, this.dy + dy);
    return c;
  }

  cylinder(x: number, z: number, radius: number, height: number, y0 = 0, tag = 'prop'): void {
    if (!this.sink) return;
    try {
      this.sink.addStaticCylinder(x, z, radius, height, y0 + this.dy, tag);
      this.count++;
    } catch (e) {
      console.warn('[props] addStaticCylinder faalde', e);
      this.sink = null;
    }
  }

  box(center: THREE.Vector3, half: THREE.Vector3, rotY = 0, tag = 'prop'): void {
    if (!this.sink) return;
    try {
      this.sink.addStaticBox(this.dy ? _c.copy(center).setY(center.y + this.dy) : center, half, rotY, tag);
      this.count++;
    } catch (e) {
      console.warn('[props] addStaticBox faalde', e);
    }
  }
}

/** No-op physics with the PhysicsWorld collider methods (for dev scenes without Rapier). */
export function createNullPhysics(): StaticColliderSink & { colliders: number } {
  const p = {
    colliders: 0,
    addStaticCylinder() { p.colliders++; },
    addStaticBox() { p.colliders++; },
  };
  return p;
}
