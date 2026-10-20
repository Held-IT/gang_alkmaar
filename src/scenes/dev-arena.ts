// Arena test scene (arenas module). ?scene=dev-arena
//
// Loads the real city (loadWorld) + physics + one arena and drops test beasts (the real
// createBeastSystem when src/beast/physics exists, else plain capsule bodies) that wander, brawl a
// bit and get respawned after falling out, to validate colliders, edges and hazards.
//
// Params:
//   arena=kaasmarkt|rondvaartboot|molen   (default kaasmarkt)
//   city=0          no city (lightweight arena placeholders)
//   hazard=1        hazards on a short loop (read by the arenas)
//   beasts=N        test beasts (default 4, 0..8)       ai=wander|idle|edge   (default wander)
//   respawn=0       leave eliminated beasts in the water
//   view=frame|eye|top   arena camera frame (default), beast eye level, top-down
//   devcam=1        free orbit camera (cam=x,y,z&look=x,y,z)     camdist=<m> override
//   visual=fallback simple capsule visuals
// window.__debug: arena, world, physics, beasts(), probe(x,y,z), isOutTests(), setCam(x,y,z,lx,ly,lz),
//   setView(v), teleport(i,x,y,z), push(i,vx,vy,vz), stats(), log
import * as THREE from 'three';
import type { Engine, SceneEntry } from '../contracts';
import type { Arena, ArenaId, Beast, BeastInput, BeastSystem } from '../brawl/contracts';
import { COLLISION_GROUPS, createPhysics, type PhysicsWorldExt } from '../physics/physics';
import { setupDevCamera } from '../dev/devCamera';
import { createArena } from '../arenas';
import type { WorldExt } from '../world/types';

type BeastMod = { createBeastSystem(engine: Engine, physics: PhysicsWorldExt, opts?: { world?: WorldExt | null; visual?: 'auto' | 'fallback' }): Promise<BeastSystem> };
const beastGlob = import.meta.glob<BeastMod>('../beast/physics/index.ts');

const COLOURS = ['#f2a03d', '#4f9be8', '#e8505b', '#66c45a', '#b07ce0', '#f4d548', '#5ad1c8', '#f08fc0'];

function neutral(): BeastInput {
  return { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false, run: false };
}

/** Minimal stand-in when the beast physics module is missing: capsule bodies, no control. */
async function capsuleSystem(engine: Engine, physics: PhysicsWorldExt): Promise<BeastSystem> {
  const R = physics.RAPIER;
  const beasts: Beast[] = [];
  const mat = new THREE.MeshStandardMaterial({ color: 0xe0a040, roughness: 0.6 });
  const geo = new THREE.CapsuleGeometry(0.3, 0.7, 4, 12);
  const bodies: { b: InstanceType<typeof R.RigidBody>; m: THREE.Mesh }[] = [];
  return {
    beasts,
    spawn(opts, at, facing) {
      const body = physics.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(at.x, at.y + 0.7, at.z));
      physics.world.createCollider(R.ColliderDesc.capsule(0.35, 0.3).setMass(60).setCollisionGroups(COLLISION_GROUPS.beast), body);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      engine.scene.add(m);
      bodies.push({ b: body, m });
      const pos = new THREE.Vector3();
      const vel = new THREE.Vector3();
      const beast: Beast = {
        id: beasts.length,
        options: opts,
        root: m,
        get position() {
          const t = body.translation();
          return pos.set(t.x, t.y, t.z);
        },
        get velocity() {
          const v = body.linvel();
          return vel.set(v.x, v.y, v.z);
        },
        facing,
        state: 'active',
        consciousness: 1,
        holding: { left: null, right: null },
        partPosition: (_p, out) => out.copy(beast.position),
        setInput() {},
        teleport(p) {
          body.setTranslation({ x: p.x, y: p.y + 0.7, z: p.z }, true);
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        },
        eliminate() {},
      };
      beasts.push(beast);
      return beast;
    },
    remove() {},
    update() {
      for (const { b, m } of bodies) {
        const t = b.translation(), r = b.rotation();
        m.position.set(t.x, t.y, t.z);
        m.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },
    on: () => () => {},
    dispose() {},
  };
}

const entry: SceneEntry = async (engine, params) => {
  const id = (params.get('arena') ?? 'kaasmarkt') as ArenaId;
  const useCity = params.get('city') !== '0';
  const physics = await createPhysics();
  engine.start();
  let world: WorldExt | null = null;
  if (useCity) {
    const { loadWorld } = await import('../world/world');
    world = await loadWorld(engine, physics, undefined, {});
  }
  const t0 = performance.now();
  const arena: Arena & { reset?(): void; floorY?: number } = await createArena(id, { engine, physics, world });
  if (!arena.root.parent) engine.scene.add(arena.root);
  if (world) await world.warmUp([arena.root], 6000);
  const buildMs = performance.now() - t0;
  console.info(`[dev-arena] ${arena.name} gebouwd in ${buildMs.toFixed(0)} ms`);

  // ---------------------------------------------------------------- beasts
  const load = beastGlob['../beast/physics/index.ts'];
  let system: BeastSystem;
  try {
    system = load ? await (await load()).createBeastSystem(engine, physics, { world, visual: params.get('visual') === 'fallback' ? 'fallback' : 'auto' }) : await capsuleSystem(engine, physics);
  } catch (e) {
    console.warn('[dev-arena] beestsysteem niet beschikbaar, capsules gebruikt:', e);
    system = await capsuleSystem(engine, physics);
  }
  const n = Math.max(0, Math.min(8, Number(params.get('beasts') ?? 4)));
  const ai = params.get('ai') ?? 'wander';
  const respawn = params.get('respawn') !== '0';
  const beasts: Beast[] = [];
  for (let i = 0; i < n; i++) {
    const sp = arena.spawnPoints[i % arena.spawnPoints.length];
    beasts.push(system.spawn({ name: `Test ${i + 1}`, colour: COLOURS[i % COLOURS.length], costume: i % 2 ? 'tourist' : 'kaasdrager', isBot: true }, sp.position.clone(), sp.facing));
  }
  const log: string[] = [];
  const say = (s: string) => {
    log.push(`${physics.time.toFixed(1)} ${s}`);
    if (log.length > 80) log.shift();
    console.info('[dev-arena]', s);
  };
  system.on({
    onHit(t, a, s) {
      if (!a && s > 0.3) say(`omgeving raakt ${t.options.name} ${s.toFixed(2)}`);
    },
    onSplash(t) {
      say(`plons ${t.options.name}`);
    },
  });

  // simple test brains
  const brains = beasts.map(() => ({ input: neutral(), target: new THREE.Vector3(), until: 0, outAt: -1 }));
  const tmp = new THREE.Vector3();
  const centre = arena.camera.target.clone();
  let simT = 0;
  engine.onUpdate((dt) => {
    simT += dt;
    beasts.forEach((b, i) => {
      const br = brains[i];
      const inp = br.input;
      if (br.outAt >= 0) {
        if (respawn && simT - br.outAt > 3) {
          const sp = arena.spawnPoints[(i + Math.floor(simT)) % arena.spawnPoints.length];
          b.teleport(sp.position, sp.facing);
          br.outAt = -1;
        }
        return;
      }
      if (arena.isOut(b.position)) {
        say(`${b.options.name} is af bij (${b.position.x.toFixed(1)}, ${b.position.y.toFixed(1)}, ${b.position.z.toFixed(1)})`);
        br.outAt = simT;
        if (!respawn) b.eliminate();
        b.setInput(neutral());
        return;
      }
      if (ai === 'idle') {
        b.setInput(neutral());
        return;
      }
      if (simT > br.until) {
        br.until = simT + 1.5 + Math.random() * 2.5;
        if (ai === 'edge' || Math.random() < 0.25) {
          // towards the nearest drop
          tmp.set(centre.x + (Math.random() - 0.5) * 40, centre.y, centre.z + (Math.random() - 0.5) * 40);
          br.target.copy(tmp);
        } else {
          tmp.set(centre.x + (Math.random() - 0.5) * 16, centre.y, centre.z + (Math.random() - 0.5) * 16);
          arena.clampToArea(tmp, br.target);
        }
      }
      // nearest other beast close by: go for it
      let near: Beast | null = null;
      let nd = 2.2;
      for (const o of beasts) {
        if (o === b) continue;
        const d = o.position.distanceTo(b.position);
        if (d < nd) {
          nd = d;
          near = o;
        }
      }
      const goal = near ? near.position : br.target;
      let dx = goal.x - b.position.x, dz = goal.z - b.position.z;
      const l = Math.hypot(dx, dz);
      if (l < 0.6 && !near) dx = dz = 0;
      else {
        dx /= l || 1;
        dz /= l || 1;
      }
      inp.moveX = dx * 0.8;
      inp.moveZ = dz * 0.8;
      const ph = simT * 3 + i;
      inp.grabLeft = !!near && Math.sin(ph) > 0.3;
      inp.grabRight = !!near && Math.sin(ph + 1.7) > 0.3;
      inp.jump = Math.random() < 0.004;
      inp.duck = false;
      b.setInput(inp);
    });
  }, 5);

  engine.onUpdate((dt, el) => arena.update(dt, el), 9);
  engine.onUpdate((dt) => {
    physics.step(dt);
  }, 10);
  engine.onUpdate((dt) => system.update(dt), 20);
  if (world) {
    const w = world;
    engine.onUpdate((dt) => w.update(dt, engine.camera.position), 40);
  }

  // ---------------------------------------------------------------- camera
  let view = params.get('view') ?? 'frame';
  const fr = arena.camera;
  const camDistParam = params.get('camdist');
  const camTarget = fr.target.clone();
  const look = new THREE.Vector3();
  let manual = false;
  if (params.get('devcam') === '1') {
    manual = true;
    const d = Number(camDistParam ?? (fr.minDistance + fr.maxDistance) / 2);
    const dir = new THREE.Vector3(Math.sin(fr.yaw) * Math.cos(fr.pitch), -Math.sin(fr.pitch), Math.cos(fr.yaw) * Math.cos(fr.pitch));
    setupDevCamera(engine, params, { cam: fr.target.clone().addScaledVector(dir, -d), look: fr.target.clone() });
  }
  engine.onUpdate((dt) => {
    const cam = engine.camera;
    if (manual) {
      engine.setFocus(fr.target);
      return;
    }
    // centroid of the beasts still in play, pulled to the arena target
    tmp.set(0, 0, 0);
    let c = 0;
    let spread = 0;
    beasts.forEach((b, i) => {
      if (brains[i].outAt >= 0) return;
      tmp.add(b.position);
      c++;
    });
    if (c) tmp.multiplyScalar(1 / c).lerp(fr.target, 0.4);
    else tmp.copy(fr.target);
    beasts.forEach((b, i) => {
      if (brains[i].outAt < 0) spread = Math.max(spread, b.position.distanceTo(tmp));
    });
    camTarget.lerp(tmp, 1 - Math.exp(-dt * 2));
    if (view === 'eye' && beasts.length) {
      const b = beasts[0];
      b.partPosition('head', look);
      const f = b.facing;
      cam.position.set(look.x - Math.sin(f) * 2.2, look.y + 0.35, look.z - Math.cos(f) * 2.2);
      cam.lookAt(look.x + Math.sin(f) * 6, look.y - 0.2, look.z + Math.cos(f) * 6);
    } else if (view === 'top') {
      cam.position.set(fr.target.x, fr.target.y + 60, fr.target.z + 0.01);
      cam.lookAt(fr.target);
    } else {
      const d = camDistParam ? Number(camDistParam) : THREE.MathUtils.clamp(spread * 1.6 + 6, fr.minDistance, fr.maxDistance);
      const dir = look.set(Math.sin(fr.yaw) * Math.cos(fr.pitch), -Math.sin(fr.pitch), Math.cos(fr.yaw) * Math.cos(fr.pitch));
      cam.position.copy(camTarget).addScaledVector(dir, -d);
      cam.lookAt(camTarget);
    }
    engine.setFocus(camTarget);
  }, 50);

  // ---------------------------------------------------------------- debug
  const probe = (x: number, y: number, z: number) => {
    const p = new THREE.Vector3(x, y, z);
    const c = arena.clampToArea(p, new THREE.Vector3());
    return { isOut: arena.isOut(p), edge: arena.edgeDistance(p), clamp: [c.x, c.y, c.z].map((v) => +v.toFixed(2)) };
  };
  window.__debug = {
    arena,
    world,
    physics,
    system,
    log,
    buildMs,
    beasts: () =>
      beasts.map((b, i) => ({
        i,
        p: [b.position.x, b.position.y, b.position.z].map((v) => +v.toFixed(2)),
        state: b.state,
        mode: (b as Beast & { mode?: string }).mode,
        v: +b.velocity.length().toFixed(1),
        out: brains[i].outAt >= 0,
        edge: +arena.edgeDistance(b.position).toFixed(2),
      })),
    probe,
    isOutTests: () => {
      const t = fr.target;
      const res: Record<string, unknown> = { centre: probe(t.x, t.y + 0.9, t.z) };
      arena.spawnPoints.forEach((s, i) => (res['spawn' + i] = probe(s.position.x, s.position.y + 0.9, s.position.z)));
      for (const [k, dx, dz] of [['n', 0, -30], ['s', 0, 30], ['e', 30, 0], ['w', -30, 0]] as [string, number, number][]) res[k] = probe(t.x + dx, t.y - 2, t.z + dz);
      return res;
    },
    setCam(x: number, y: number, z: number, lx: number, ly: number, lz: number) {
      manual = true;
      engine.camera.position.set(x, y, z);
      engine.camera.lookAt(lx, ly, lz);
    },
    setView(v: string) {
      manual = false;
      view = v;
    },
    teleport(i: number, x: number, y: number, z: number) {
      beasts[i]?.teleport(new THREE.Vector3(x, y, z), 0);
      if (brains[i]) brains[i].outAt = -1;
    },
    push(i: number, vx: number, vy: number, vz: number) {
      const b = beasts[i] as Beast & { push?(dv: THREE.Vector3, stun?: number): void };
      b?.push?.(new THREE.Vector3(vx, vy, vz), 1.5);
    },
    /** ASCII map: ~ water, # building, T tree, o other small collider, . open; rows = z */
    map(x0: number, z0: number, x1: number, z1: number, step = 2) {
      const cols = Math.ceil((x1 - x0) / step), rows = Math.ceil((z1 - z0) / step);
      const g: string[][] = [];
      for (let r = 0; r < rows; r++) {
        const row: string[] = [];
        for (let c = 0; c < cols; c++) {
          const x = x0 + (c + 0.5) * step, z = z0 + (r + 0.5) * step;
          row.push(!world ? '?' : world.isWater(x, z) ? '~' : world.isInsideBuilding(x, z) ? '#' : '.');
        }
        g.push(row);
      }
      physics.world.forEachCollider((col: { translation(): THREE.Vector3Like; handle: number; parent(): { isFixed(): boolean } | null }) => {
        const t = col.translation();
        const c = Math.floor((t.x - x0) / step), r = Math.floor((t.z - z0) / step);
        if (r < 0 || r >= rows || c < 0 || c >= cols) return;
        const tag = physics.tagOf(col.handle) ?? '';
        if (tag === 'tree') g[r][c] = 'T';
        else if (col.parent()?.isFixed() && tag !== 'ground' && g[r][c] === '.' && !/arena|dranghek|gate/.test(tag)) g[r][c] = 'o';
      });
      return g.map((r, i) => `${(z0 + i * step).toFixed(0).padStart(5)} ${r.join('')}`).join('\n');
    },
    stats: () => ({ fps: engine.stats.fps, frameMs: engine.stats.frameMs, drawCalls: engine.stats.drawCalls, triangles: engine.stats.triangles, world: world?.stats() }),
  };
  window.__ready = true;
};

export default entry;
