// Bots module: AI opponents for Gang Alkmaar (contract: src/brawl/contracts.ts BotController).
//
//   const bot = createBotController(beast, { system, arena, difficulty, physics });
//   engine.onUpdate((dt) => bot.update(dt), 5);   // before physics.step (priority 10)
//   bot.dispose();                                 // when the beast is out / the round ends
//
// The bot only calls beast.setInput(); it reads the beast (BeastExt extras when present), the
// arena (edgeDistance / clampToArea / isOut / hazards) and static ray casts of the physics world.
// See bot.ts for the behaviour, profiles.ts for the difficulty numbers, sense.ts for arena knowledge.
import type { Arena, Beast, BeastSystem, BotController, BotDifficulty } from '../../brawl/contracts';
import type { PhysicsWorld } from '../../contracts';
import { BotBrain, type BotPlan, type BotStats } from './bot';

export { BOT_PROFILES, type BotProfile } from './profiles';
export { BotBrain, type BotPlan, type BotStats } from './bot';
export { getSense, ArenaSense } from './sense';

/** BotController plus debug members (plan, target, stats, perf). */
export interface BotControllerExt extends BotController {
  readonly difficulty: BotDifficulty;
  /** current plan ('fight', 'carry', 'dodge', 'shelter', 'climb', 'taunt', ...) */
  readonly plan: BotPlan;
  readonly targetName: string | null;
  readonly stats: BotStats;
  /** smoothed ms per update(), worst single update() */
  readonly ms: number;
  readonly msMax: number;
}

export function createBotController(
  beast: Beast,
  ctx: { system: BeastSystem; arena: Arena; difficulty: BotDifficulty; physics: PhysicsWorld },
): BotControllerExt {
  return new BotBrain(beast, ctx);
}
