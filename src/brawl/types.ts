// Internal types of the game-flow module (lobby, match flow, HUD). Shared contracts live in
// ./contracts.ts (orchestrator-owned); everything here is game-flow private.
import type * as THREE from 'three';
import type { Engine, PhysicsWorld } from '../contracts';
import type { WorldExt } from '../world/types';
import type {
  Arena,
  ArenaContext,
  ArenaId,
  Beast,
  BeastExpression,
  BeastSystem,
  BeastVisual,
  BotController,
  BotDifficulty,
  CostumeInfo,
} from './contracts';

/** Choices made in the lobby (persisted in localStorage). */
export interface LobbyChoices {
  name: string;
  colour: string;
  costume: string;
  arena: ArenaId;
  bots: number;
  difficulty: BotDifficulty;
  wins: number;
}

export interface MatchOptions {
  arena: ArenaId;
  bots: number;
  difficulty: BotDifficulty;
  wins: number;
  player: { name: string; colour: string; costume: string };
}

/** A colour swatch offered in the lobby. */
export interface ColourInfo {
  hex: string;
  /** Dutch name ("Kaasgeel") */
  name: string;
}

export interface ArenaInfo {
  id: ArenaId;
  name: string;
  description: string;
}

/** Optional members a real Beast may offer (used when present). */
export type BeastExt = Beast & {
  readonly visual?: BeastVisual;
  setExpression?(e: BeastExpression): void;
  /** beast-physics: a forced expression that wins over the automatic one (null = automatic). */
  expressionOverride?: BeastExpression | null;
  /** Optional: un-eliminate / full reset between rounds. */
  reset?(p: THREE.Vector3, facing: number): void;
};

/** Optional members a real Arena may offer. */
export type ArenaExt = Arena & {
  /** Restore dynamic props / hazards for a new round (otherwise the arena is rebuilt). */
  reset?(): void;
  /** Floor height of the fighting area (otherwise derived from the spawn points). */
  readonly floorY?: number;
};

/** The factories of the parallel modules (real or fallback). */
export interface BrawlModules {
  createBeastSystem(engine: Engine, physics: PhysicsWorld, opts?: { world?: WorldExt | null }): Promise<BeastSystem>;
  createBeastVisual(opts: { colour: string; costume: string; scale?: number }): BeastVisual;
  costumes: CostumeInfo[];
  colours: ColourInfo[];
  createArena(id: ArenaId, ctx: ArenaContext): Promise<Arena>;
  arenas: ArenaInfo[];
  createBotController(
    beast: Beast,
    ctx: { system: BeastSystem; arena: Arena; difficulty: BotDifficulty; physics: PhysicsWorld },
  ): BotController;
  /** Builds and caches all beast/costume geometry up front (no-op for the placeholder visual). */
  prewarmVisuals(): void;
  /** Which modules are the real ones (false = placeholder from src/brawl/fallback). */
  real: { physics: boolean; visual: boolean; arenas: boolean; ai: boolean };
}

/** One fighter in a match. */
export interface Fighter {
  index: number;
  name: string;
  colour: string;
  costume: string;
  isBot: boolean;
  /** Per-beast voice pitch factor (audio). */
  voice: number;
  wins: number;
  beast: BeastExt | null;
  bot: BotController | null;
  /** Out in the current round. */
  out: boolean;
  /** match time (s) when it went out */
  outAt: number;
}

export type GamePhase =
  | 'loading'
  | 'lobby'
  | 'starting'
  | 'countdown'
  | 'fight'
  | 'settle'
  | 'winnerZoom'
  | 'scoreboard'
  | 'celebration';
