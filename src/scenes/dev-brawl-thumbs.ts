// Arena thumbnails for the lobby cards (public/assets/brawl/arena_<id>.jpg): the real city, the
// arena and a few posed beasts, framed by the arena camera. Render with
//   node tools/shot.mjs --scene dev-brawl-thumbs --params "arena=molen" --width 640 --height 340 --out shots/game-flow/thumb_molen.png
// then convert to JPEG (tools: sharp). Params: arena=<id>, dist=<0..1 between min/max distance>,
// yaw=<offset rad>, pitch=<rad>, up=<target height offset m>.
import * as THREE from 'three';
import type { SceneEntry } from '../contracts';
import { createPhysics } from '../physics/physics';
import { loadWorld } from '../world/world';
import { loadBrawlModules } from '../brawl/modules';
import { createFallbackArena } from '../brawl/fallback/arena';
import type { ArenaId, BeastExpression, BeastVisual } from '../brawl/contracts';
import { animateIdle, RigPose } from '../brawl/pose';

const MODES: ('idle' | 'cheer' | 'wave')[] = ['cheer', 'idle', 'wave', 'idle'];
const FACES: BeastExpression[] = ['happy', 'angry', 'neutral', 'angry'];

const thumbs: SceneEntry = async (engine, params) => {
  engine.start();
  const physics = await createPhysics();
  const world = await loadWorld(engine, physics, () => undefined);
  const mods = await loadBrawlModules(params);
  const id = (params.get('arena') ?? 'kaasmarkt') as ArenaId;
  let placeholder = !mods.real.arenas;
  const arena = await mods.createArena(id, { engine, physics, world }).catch((e) => {
    console.warn('[thumbs] arena ontbreekt, placeholder:', e);
    placeholder = true;
    return createFallbackArena(id, { engine, physics, world });
  });
  if (!arena.root.parent) engine.scene.add(arena.root);
  // placeholder arenas are only used for their spawn points / camera frame
  if (placeholder) arena.root.visible = false;

  const frame = arena.camera;
  const k = THREE.MathUtils.clamp(parseFloat(params.get('dist') ?? '0.3') || 0, 0, 1.5);
  const dist = THREE.MathUtils.lerp(frame.minDistance, frame.maxDistance, k);
  const num = (k: string, d: number) => {
    const v = parseFloat(params.get(k) ?? '');
    return Number.isFinite(v) ? v : d;
  };
  const yaw = frame.yaw + num('yaw', 0);
  const pitch = num('pitch', frame.pitch);
  frame.target.y += num('up', 0);
  const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const cam = engine.camera;
  cam.fov = 46;
  cam.updateProjectionMatrix();
  cam.position.copy(frame.target).addScaledVector(dir, -dist);
  cam.lookAt(frame.target);
  engine.setFocus(frame.target);

  // posed beasts on the spawn spots nearest to the camera target, looking roughly at the camera
  const spots = [...arena.spawnPoints].sort((a, b) => a.position.distanceTo(frame.target) - b.position.distanceTo(frame.target));
  const beasts: { visual: BeastVisual; pose: RigPose; mode: 'idle' | 'cheer' | 'wave'; t: number }[] = [];
  const groups: THREE.Object3D[] = [];
  for (let i = 0; i < Math.min(4, spots.length); i++) {
    const sp = spots[i];
    const colour = mods.colours[(i * 3 + 1) % mods.colours.length].hex;
    const costume = mods.costumes[(i + 1) % mods.costumes.length].id;
    const visual = mods.createBeastVisual({ colour, costume });
    visual.setExpression(FACES[i]);
    const g = new THREE.Group();
    g.add(visual.root);
    g.position.copy(sp.position);
    if (!mods.real.arenas && id === 'kaasmarkt') g.position.y = world.heightAt(sp.position.x, sp.position.z);
    g.rotation.y = Math.atan2(cam.position.x - g.position.x, cam.position.z - g.position.z) + (i % 2 ? 0.45 : -0.35);
    engine.scene.add(g);
    groups.push(g);
    beasts.push({ visual, pose: new RigPose(), mode: MODES[i], t: i * 0.7 });
  }

  let elapsed = 0;
  engine.onUpdate((dt) => {
    elapsed += dt;
    arena.update(dt, elapsed);
    physics.step(dt);
    for (const b of beasts) {
      b.t += dt;
      const lift = animateIdle(b.pose, b.t, b.mode);
      b.pose.position.set(0, lift, 0);
      b.pose.solve();
      b.pose.apply(b.visual.parts);
      b.visual.update(dt);
    }
    world.update(dt, cam.position);
  }, 30);

  await world.warmUp([arena.root, ...groups], 6000);
  window.__ready = true;
};

export default thumbs;
