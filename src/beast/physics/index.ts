// Beast system factory (beast-physics module): spawns active-ragdoll beasts, runs their controller
// before every fixed physics sub-step, reads the body states after it, and syncs the visuals
// (src/beast/visual via import.meta.glob, coloured-capsule fallback) every frame.
//
// Spellogica deels gebaseerd op gb-rust door muffinmxn, MIT-licentie.
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { BeastOptions, BeastSystem, BeastSystemEvents, BeastVisual } from '../../brawl/contracts';
import { WATER_LEVEL } from '../../config';
import type { Engine, PhysicsWorld } from '../../contracts';
import type { WorldExt } from '../../world/types';
import { BEAST_SLOTS } from '../../physics/physics';
import { BeastImpl, type BeastCtx } from './beast';
import { createFallbackVisual } from './fallbackVisual';
import { BEAST_TUNING } from './tuning';

export { BeastImpl, PART_COUNT, PELVIS, CHEST, HEAD } from './beast';
export type { BeastMode, HeldKind } from './beast';
export { BEAST_TUNING, DAMAGE_MULT } from './tuning';
export type { BeastTuning } from './tuning';

/** The Beast handed out by this system: the contract plus extra read-only members. */
export type BeastExt = BeastImpl;

type VisualModule = {
  createBeastVisual(opts: { colour: string; costume: string; scale?: number }): BeastVisual;
};
const visualModules = import.meta.glob<VisualModule>('../visual/index.ts');

export interface BeastSystemPerf {
  /** controller time per rendered frame (ms, smoothed), all beasts, all sub-steps */
  controllerMs: number;
  /** body state read-back per frame (ms, smoothed) */
  readMs: number;
  /** visual sync per frame (ms, smoothed) */
  syncMs: number;
}

export interface BeastSystemExt extends BeastSystem {
  readonly beasts: readonly BeastImpl[];
  spawn(opts: BeastOptions, at: THREE.Vector3, facing: number): BeastImpl;
  /** Water surface height (default WATER_LEVEL). */
  waterLevel: number;
  /** Override where water is (default: world.isWater, or everywhere without a world). */
  setWaterQuery(fn: ((x: number, z: number) => boolean) | null): void;
  /** Beast owning a Rapier collider handle (null if none). */
  beastOfCollider(handle: number): BeastImpl | null;
  readonly perf: Readonly<BeastSystemPerf>;
  /** 'visual' when src/beast/visual delivered the meshes, else 'fallback'. */
  readonly visualSource: 'visual' | 'fallback';
  /** Show the little stars circling a knocked-out beast's head (default true). */
  setKoStars(enabled: boolean): void;
  readonly tuning: typeof BEAST_TUNING;
}

function makeStarGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? 0.07 : 0.03;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
  g.center();
  return g;
}

export async function createBeastSystem(
  engine: Engine,
  physics: PhysicsWorld,
  opts?: {
    world?: WorldExt | null;
    /** 'fallback' skips src/beast/visual (dev scenes while that module is being written). */
    visual?: 'auto' | 'fallback';
  },
): Promise<BeastSystemExt> {
  const world = physics.world as RAPIER.World;
  const cityWorld = opts?.world ?? null;

  // ---------------------------------------------------------------- visuals
  let createVisual: VisualModule['createBeastVisual'] | null = null;
  const loader = visualModules['../visual/index.ts'];
  if (loader && opts?.visual !== 'fallback') {
    try {
      const mod = await loader();
      if (typeof mod.createBeastVisual === 'function') createVisual = mod.createBeastVisual;
    } catch (e) {
      console.warn('[beast] src/beast/visual niet beschikbaar, gebruik eenvoudige vormen:', e);
    }
  }
  let visualSource: 'visual' | 'fallback' = createVisual ? 'visual' : 'fallback';

  const beasts: BeastImpl[] = [];
  const listeners: BeastSystemEvents[] = [];
  const colliderOwner = new Map<number, BeastImpl>();
  let simTime = 0;
  let waterFn: ((x: number, z: number) => boolean) | null = null;
  const defaultWater = cityWorld ? (x: number, z: number) => cityWorld.isWater(x, z) : () => true;
  let nextId = 0;

  const ctx: BeastCtx = {
    world,
    beasts,
    waterLevel: WATER_LEVEL,
    isWater: (x, z) => (waterFn ?? defaultWater)(x, z),
    time: () => simTime,
    emitHit(target, attacker, strength, point) {
      for (const l of listeners) l.onHit?.(target, attacker, strength, point);
    },
    emitKo(target) {
      for (const l of listeners) l.onKnockout?.(target);
    },
    emitGrab(grabber, target) {
      for (const l of listeners) l.onGrab?.(grabber, target);
    },
    emitSplash(target, point) {
      for (const l of listeners) l.onSplash?.(target, point);
    },
    registerCollider(handle, beast) {
      colliderOwner.set(handle, beast);
    },
    unregisterCollider(handle) {
      colliderOwner.delete(handle);
    },
  };

  // ---------------------------------------------------------------- KO stars
  const starGeo = makeStarGeometry();
  const starMat = new THREE.MeshBasicMaterial({ color: 0xffd84a, toneMapped: false });
  let koStars = true;
  const stars = new Map<BeastImpl, THREE.Group>();
  function starsFor(b: BeastImpl): THREE.Group {
    let g = stars.get(b);
    if (!g) {
      g = new THREE.Group();
      g.name = 'ko-stars';
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(starGeo, starMat);
        g.add(m);
      }
      g.visible = false;
      engine.scene.add(g);
      stars.set(b, g);
    }
    return g;
  }

  // ---------------------------------------------------------------- physics hooks
  const perf: BeastSystemPerf = { controllerMs: 0, readMs: 0, syncMs: 0 };
  let ctrlAcc = 0;
  let readAcc = 0;
  const offPre = physics.onPreStep((dt) => {
    const t0 = performance.now();
    simTime += dt;
    for (let i = 0; i < beasts.length; i++) beasts[i].preStep(dt);
    ctrlAcc += performance.now() - t0;
  });
  const offPost = physics.onPostStep(() => {
    const t0 = performance.now();
    for (let i = 0; i < beasts.length; i++) beasts[i].readState();
    readAcc += performance.now() - t0;
  });

  const tmpHead = new THREE.Vector3();

  const system: BeastSystemExt = {
    get beasts() {
      return beasts;
    },
    get waterLevel() {
      return ctx.waterLevel;
    },
    set waterLevel(v: number) {
      ctx.waterLevel = v;
    },
    get perf() {
      return perf;
    },
    get visualSource() {
      return visualSource;
    },
    tuning: BEAST_TUNING,

    spawn(o, at, facing) {
      const used = new Set(beasts.map((b) => b.slot));
      let slot = 0;
      while (used.has(slot) && slot < BEAST_SLOTS - 1) slot++;
      let visual: BeastVisual;
      try {
        visual = createVisual
          ? createVisual({ colour: o.colour, costume: o.costume, scale: o.scale ?? 1 })
          : createFallbackVisual({ colour: o.colour, costume: o.costume, scale: o.scale ?? 1 });
      } catch (e) {
        console.warn('[beast] createBeastVisual faalde, gebruik eenvoudige vormen:', e);
        visual = createFallbackVisual({ colour: o.colour, scale: o.scale ?? 1 });
        visualSource = 'fallback';
      }
      const b = new BeastImpl(ctx, nextId++, slot, o, visual, at, facing);
      beasts.push(b);
      engine.scene.add(visual.root);
      b.syncVisual(1, 0);
      return b;
    },

    remove(b) {
      const impl = b as BeastImpl;
      const i = beasts.indexOf(impl);
      if (i < 0) return;
      for (const o of beasts) if (o !== impl) o.releaseTarget(impl);
      beasts.splice(i, 1);
      impl.dispose();
      const g = stars.get(impl);
      if (g) {
        g.removeFromParent();
        stars.delete(impl);
      }
    },

    update(dt) {
      const t0 = performance.now();
      const alpha = physics.alpha;
      for (let i = 0; i < beasts.length; i++) {
        const b = beasts[i];
        b.syncVisual(alpha, dt);
        const ko = koStars && b.mode === 'ko';
        if (ko || stars.has(b)) {
          const g = starsFor(b);
          g.visible = ko;
          if (ko) {
            b.partPosition('head', tmpHead);
            const sc = b.scale;
            g.position.set(tmpHead.x, tmpHead.y + 0.32 * sc, tmpHead.z);
            const n = g.children.length;
            const t = simTime * 3.2;
            for (let k = 0; k < n; k++) {
              const a = t + (k / n) * Math.PI * 2;
              const m = g.children[k];
              m.position.set(Math.cos(a) * 0.24 * sc, Math.sin(t * 2 + k) * 0.03, Math.sin(a) * 0.24 * sc);
              m.rotation.set(0, -a + Math.PI / 2, 0);
              m.scale.setScalar(sc * (0.8 + 0.3 * b.koFraction));
            }
          }
        }
      }
      // smoothed per-frame timings
      const k = 0.08;
      perf.controllerMs += (ctrlAcc - perf.controllerMs) * k;
      perf.readMs += (readAcc - perf.readMs) * k;
      ctrlAcc = 0;
      readAcc = 0;
      perf.syncMs += (performance.now() - t0 - perf.syncMs) * k;
    },

    on(events) {
      listeners.push(events);
      return () => {
        const i = listeners.indexOf(events);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    setWaterQuery(fn) {
      waterFn = fn;
    },

    beastOfCollider(handle) {
      return colliderOwner.get(handle) ?? null;
    },

    setKoStars(enabled) {
      koStars = enabled;
      if (!enabled) for (const g of stars.values()) g.visible = false;
    },

    dispose() {
      offPre();
      offPost();
      for (const b of [...beasts]) system.remove(b);
      for (const g of stars.values()) g.removeFromParent();
      stars.clear();
      starGeo.dispose();
      starMat.dispose();
      listeners.length = 0;
    },
  };
  return system;
}
