// Placeholder arenas (used only until src/arenas/index.ts exists): a wooden stage on the
// Waagplein, a flat "boat" deck on the nearest canal and a ring-shaped stage around the Molen van
// Piet. Real geometry, hazards and camera frames come from the arenas module.
import * as THREE from 'three';
import type { ArenaContext, ArenaId } from '../contracts';
import type { ArenaExt, ArenaInfo } from '../types';

export const FALLBACK_ARENAS: ArenaInfo[] = [
  { id: 'kaasmarkt', name: 'Kaasmarkt', description: 'Tussen de kazen op het Waagplein, met de gracht als afgrond.' },
  { id: 'rondvaartboot', name: 'Rondvaartboot', description: 'Op het dak van een rondvaartboot door de grachten. Bukken voor de bruggen!' },
  { id: 'molen', name: 'Molen van Piet', description: 'Op de stelling van de molen, met wieken die alles wegmaaien.' },
];

interface Layout {
  centre: THREE.Vector3;
  radius: number;
  inner: number;
  colour: number;
  yaw: number;
}

function findWater(ctx: ArenaContext, x0: number, z0: number): THREE.Vector3 | null {
  const w = ctx.world;
  if (!w) return null;
  for (let r = 0; r < 160; r += 3) {
    for (let a = 0; a < Math.PI * 2; a += 0.35) {
      const x = x0 + Math.cos(a) * r;
      const z = z0 + Math.sin(a) * r;
      let ok = w.isWater(x, z);
      for (let k = 0; ok && k < 8; k++) ok = w.isWater(x + Math.cos(k * 0.785) * 4.5, z + Math.sin(k * 0.785) * 4.5);
      if (ok) return new THREE.Vector3(x, w.heightAt(x + 8, z) - 0.6, z);
    }
  }
  return null;
}

function layoutFor(id: ArenaId, ctx: ArenaContext): Layout {
  const w = ctx.world;
  const lm = (name: string, fx: number, fz: number) => {
    const l = w?.osmMeta.landmarks.find((m) => m.id === name);
    return l ? { x: l.x, z: l.z } : { x: fx, z: fz };
  };
  if (id === 'molen') {
    const m = lm('molen_van_piet', -564.6, 146.4);
    const y = (w ? w.heightAt(m.x + 12, m.z) : 0) + 7;
    return { centre: new THREE.Vector3(m.x, y, m.z), radius: 7.5, inner: 3.6, colour: 0x6d5236, yaw: 2.4 };
  }
  if (id === 'rondvaartboot') {
    const c = findWater(ctx, 30, 36) ?? new THREE.Vector3(0, 0, 0);
    return { centre: c, radius: 5.2, inner: 0, colour: 0x2a3d5c, yaw: 0.6 };
  }
  // in front of De Waag (its +z model axis points onto the square)
  const waag = lm('waag', -0.5, 0.77);
  const x = waag.x + Math.sin(2.5536) * 26;
  const z = waag.z + Math.cos(2.5536) * 26;
  const y = (w ? w.heightAt(x, z) : 0) + 0.7;
  return { centre: new THREE.Vector3(x, y, z), radius: 7, inner: 0, colour: 0x8a6a3e, yaw: 2.5536 + Math.PI };
}

export async function createFallbackArena(id: ArenaId, ctx: ArenaContext): Promise<ArenaExt> {
  const info = FALLBACK_ARENAS.find((a) => a.id === id) ?? FALLBACK_ARENAS[0];
  const L = layoutFor(id, ctx);
  const root = new THREE.Group();
  root.name = `arena-fallback-${id}`;
  const mat = new THREE.MeshStandardMaterial({ color: L.colour, roughness: 0.85 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.6 });
  const thick = 0.5;
  const top = L.centre.y;
  // deck visual + colliders (boxes around a ring for the molen stage, one box per slice otherwise)
  const seg = 24;
  for (let i = 0; i < seg; i++) {
    const a = ((i + 0.5) / seg) * Math.PI * 2;
    const rIn = L.inner;
    const rOut = L.radius;
    const mid = (rIn + rOut) / 2;
    const len = rOut - rIn;
    const width = ((Math.PI * 2 * rOut) / seg) * 1.08;
    const cx = L.centre.x + Math.sin(a) * mid;
    const cz = L.centre.z + Math.cos(a) * mid;
    const yaw = a;
    ctx.physics.addStaticBox(new THREE.Vector3(cx, top - thick / 2, cz), new THREE.Vector3(width / 2, thick / 2, len / 2), yaw, 'arena-floor');
  }
  const deckGeo =
    L.inner > 0 ? new THREE.RingGeometry(L.inner, L.radius, 48, 1) : new THREE.CircleGeometry(L.radius, 48);
  deckGeo.rotateX(-Math.PI / 2);
  const deck = new THREE.Mesh(deckGeo, mat);
  deck.position.copy(L.centre);
  deck.receiveShadow = true;
  const rimGeo = new THREE.CylinderGeometry(L.radius, L.radius * 0.97, thick, 48, 1, true);
  const rim = new THREE.Mesh(rimGeo, edge);
  rim.position.set(L.centre.x, top - thick / 2, L.centre.z);
  rim.castShadow = true;
  root.add(deck, rim);
  if (!ctx.world) {
    // dev scene without the city: a water plane far below
    const water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x24465a, roughness: 0.15 }));
    water.position.set(L.centre.x, top - 2.5, L.centre.z);
    root.add(water);
    ctx.physics.addStaticBox(new THREE.Vector3(L.centre.x, top - 3.5, L.centre.z), new THREE.Vector3(200, 1, 200), 0, 'canal_bed');
  }
  ctx.engine.scene.add(root);
  const spawnPoints: { position: THREE.Vector3; facing: number }[] = [];
  const spawnR = L.inner > 0 ? (L.inner + L.radius) / 2 : L.radius * 0.55;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const p = new THREE.Vector3(L.centre.x + Math.sin(a) * spawnR, top, L.centre.z + Math.cos(a) * spawnR);
    spawnPoints.push({ position: p, facing: Math.atan2(L.centre.x - p.x, L.centre.z - p.z) });
  }
  const camTarget = L.centre.clone();
  camTarget.y += 0.8;
  const horiz = (p: THREE.Vector3) => Math.hypot(p.x - L.centre.x, p.z - L.centre.z);
  return {
    id,
    name: info.name,
    description: info.description,
    root,
    spawnPoints,
    camera: { target: camTarget, yaw: L.yaw, pitch: 0.62, minDistance: 7, maxDistance: 17 },
    isOut(p) {
      return p.y < top - 1.2 || (horiz(p) > L.radius + 0.4 && p.y < top - 0.4);
    },
    edgeDistance(p) {
      const d = horiz(p);
      return L.inner > 0 ? Math.min(L.radius - d, Math.max(0, d - L.inner) + 99) : L.radius - d;
    },
    clampToArea(p, out) {
      out.copy(p);
      const dx = p.x - L.centre.x;
      const dz = p.z - L.centre.z;
      const d = Math.hypot(dx, dz);
      const maxR = L.radius - 0.6;
      const minR = L.inner > 0 ? L.inner + 0.5 : 0;
      const r = Math.min(maxR, Math.max(minR, d));
      if (d > 1e-4) {
        out.x = L.centre.x + (dx / d) * r;
        out.z = L.centre.z + (dz / d) * r;
      }
      out.y = top;
      return out;
    },
    floorY: top,
    reset() {
      /* nothing dynamic to restore */
    },
    update() {
      /* no hazards */
    },
    dispose() {
      root.removeFromParent();
      deckGeo.dispose();
      rimGeo.dispose();
      mat.dispose();
      edge.dispose();
      // note: static colliders are left in the physics world (the fallback is dev-only)
    },
  };
}
