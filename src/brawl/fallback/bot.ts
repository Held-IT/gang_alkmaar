// Placeholder bot (used only until src/beast/ai/index.ts exists): walks to the nearest
// opponent, punches/kicks, grabs and throws now and then, and steps back from the edge.
import * as THREE from 'three';
import type { PhysicsWorld } from '../../contracts';
import type { Arena, Beast, BeastInput, BeastSystem, BotController, BotDifficulty } from '../contracts';

const TUNING: Record<BotDifficulty, { react: number; punch: number; aggro: number }> = {
  makkelijk: { react: 0.55, punch: 0.9, aggro: 0.55 },
  normaal: { react: 0.3, punch: 0.55, aggro: 0.8 },
  moeilijk: { react: 0.15, punch: 0.32, aggro: 1 },
};

export function createFallbackBot(
  beast: Beast,
  ctx: { system: BeastSystem; arena: Arena; difficulty: BotDifficulty; physics: PhysicsWorld },
): BotController {
  const tune = TUNING[ctx.difficulty] ?? TUNING.normaal;
  const input: BeastInput = { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false };
  const tmp = new THREE.Vector3();
  let think = Math.random() * tune.react;
  let target: Beast | null = null;
  let attackT = 0;
  let grabT = 0;
  let side = false;
  let wander = Math.random() * 6;
  return {
    beast,
    update(dt) {
      if (beast.state === 'eliminated') return;
      think -= dt;
      attackT -= dt;
      wander += dt;
      input.jump = false;
      input.kick = false;
      if (think <= 0) {
        think = tune.react * (0.6 + Math.random() * 0.8);
        let best = Infinity;
        target = null;
        for (const o of ctx.system.beasts) {
          if (o === beast || o.state === 'eliminated') continue;
          const d = o.position.distanceTo(beast.position) + (Math.random() - 0.5) * 2;
          if (d < best) {
            best = d;
            target = o;
          }
        }
      }
      let mx = 0;
      let mz = 0;
      if (target) {
        mx = target.position.x - beast.position.x;
        mz = target.position.z - beast.position.z;
        const d = Math.hypot(mx, mz);
        if (d > 0.01) {
          mx /= d;
          mz /= d;
        }
        // circle a bit instead of walking straight in
        const swirl = Math.sin(wander * 0.7) * 0.35;
        const ox = mx * Math.cos(swirl) - mz * Math.sin(swirl);
        mz = mx * Math.sin(swirl) + mz * Math.cos(swirl);
        mx = ox;
        if (d < 1.1) {
          mx *= 0.25;
          mz *= 0.25;
          if (attackT <= 0) {
            attackT = tune.punch * (0.7 + Math.random() * 0.6);
            const r = Math.random();
            if (r < 0.15 * tune.aggro) input.kick = true;
            else if (r < 0.3 * tune.aggro) grabT = 1.4;
            else side = !side;
          }
        }
        mx *= tune.aggro;
        mz *= tune.aggro;
      }
      // grabbing: hold both hands, lift and throw
      if (grabT > 0) {
        grabT -= dt;
        input.grabLeft = true;
        input.grabRight = true;
        input.lift = grabT < 0.8 && beast.holding.left !== null;
        if (grabT <= 0) {
          input.grabLeft = input.grabRight = input.lift = false;
        }
      } else {
        // a tap = punch: press for one short moment
        const tap = attackT > tune.punch * 0.5;
        input.grabLeft = tap && side;
        input.grabRight = tap && !side;
        input.lift = false;
      }
      // stay away from the edge
      if (ctx.arena.edgeDistance(beast.position) < 1.4) {
        ctx.arena.clampToArea(beast.position, tmp);
        const cx = tmp.x - beast.position.x;
        const cz = tmp.z - beast.position.z;
        const l = Math.hypot(cx, cz) || 1;
        mx = mx * 0.3 + (cx / l) * 0.9;
        mz = mz * 0.3 + (cz / l) * 0.9;
      }
      if (beast.state === 'airborne' && Math.random() < dt) input.jump = true;
      const l = Math.hypot(mx, mz);
      input.moveX = l > 1 ? mx / l : mx;
      input.moveZ = l > 1 ? mz / l : mz;
      beast.setInput(input);
    },
    dispose() {
      target = null;
    },
  };
}
