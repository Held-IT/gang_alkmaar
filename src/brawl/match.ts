// Round judge: detects outs (arena.isOut(chest) or > 4 m below the arena floor), eliminates
// beasts, and decides the round: last beast standing wins; when the last ones fall within 1 s it
// is a draw. Rounds never end in the first 2 s (reference: gb_game/src/round.rs MIN_ROUND_TIME)
// and are called a draw after 150 s.
import * as THREE from 'three';
import type { WorldExt } from '../world/types';
import type { Arena, ArenaId } from './contracts';
import type { ArenaExt, Fighter } from './types';

export const MIN_ROUND_TIME = 2;
export const DRAW_WINDOW = 1;
export const MAX_ROUND_TIME = 150;
export const FALL_LIMIT = 4;

export type OutReason = 'water' | 'fall';

export interface JudgeEvents {
  onOut(f: Fighter, reason: OutReason, at: THREE.Vector3): void;
  /** A beast starts falling off (scream before the splash). */
  onFalling(f: Fighter): void;
  onRoundOver(winner: Fighter | null, timeUp: boolean): void;
}

export class RoundJudge {
  time = 0;
  settle = -1;
  over = false;
  readonly floorY: number;
  private readonly falling = new Set<Fighter>();
  private readonly p = new THREE.Vector3();

  constructor(
    private readonly fighters: Fighter[],
    private readonly arena: Arena,
    private readonly world: WorldExt | null,
    private readonly events: JudgeEvents,
  ) {
    const ext = arena as ArenaExt;
    if (typeof ext.floorY === 'number') this.floorY = ext.floorY;
    else {
      const ys = arena.spawnPoints.map((s) => s.position.y);
      this.floorY = ys.length ? Math.min(...ys) : 0;
    }
  }

  /** The fighter is currently falling off (chest well below the arena floor). */
  isFalling(f: Fighter): boolean {
    return this.falling.has(f);
  }

  get alive(): Fighter[] {
    return this.fighters.filter((f) => !f.out);
  }

  /** Eliminate a fighter now (used for outs and by __debug.forceWin). */
  knockOut(f: Fighter, reason: OutReason): void {
    if (f.out) return;
    f.out = true;
    f.outAt = this.time;
    if (f.bot) {
      f.bot.dispose();
      f.bot = null;
    }
    const b = f.beast;
    if (b) {
      b.partPosition('chest', this.p);
      b.eliminate();
    }
    this.events.onOut(f, reason, this.p);
  }

  update(dt: number): void {
    if (this.over) return;
    this.time += dt;
    for (const f of this.fighters) {
      if (f.out || !f.beast) continue;
      const b = f.beast;
      b.partPosition('chest', this.p);
      if (!this.falling.has(f) && this.p.y < this.floorY - 0.7) {
        this.falling.add(f);
        this.events.onFalling(f);
      } else if (this.falling.has(f) && this.p.y > this.floorY - 0.2) this.falling.delete(f); // climbed back
      if (this.arena.isOut(this.p) || this.p.y < this.floorY - FALL_LIMIT) {
        const water = !!this.world && this.world.isWater(this.p.x, this.p.z);
        this.knockOut(f, water || this.arena.id === 'rondvaartboot' ? 'water' : 'fall');
      }
    }
    let alive = 0;
    for (const f of this.fighters) if (!f.out) alive++;
    if (this.settle < 0) {
      if (alive <= 1 && this.time >= MIN_ROUND_TIME) this.settle = 0;
      else if (this.time >= MAX_ROUND_TIME) {
        this.over = true;
        this.events.onRoundOver(null, true);
        return;
      }
    }
    if (this.settle >= 0) {
      this.settle += dt;
      if (this.settle >= DRAW_WINDOW) {
        this.over = true;
        const left = this.alive;
        this.events.onRoundOver(left.length === 1 ? left[0] : null, false);
      }
    }
  }
}

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

export function outMessage(name: string, arena: ArenaId, reason: OutReason): string {
  if (arena === 'rondvaartboot')
    return pick([`${name} is overboord!`, `Man overboord: ${name}!`, `${name} gaat kopje-onder in de gracht!`]);
  if (arena === 'molen')
    return reason === 'water'
      ? `${name} plonst in de Singel!`
      : pick([`${name} is van de molen gewaaid!`, `${name} maakt een vrije val van de stelling!`, `${name} vliegt van de molen af!`]);
  return reason === 'water'
    ? pick([`${name} ligt in de gracht!`, `${name} neemt een duik in de gracht!`, `${name} zwemt maar naar huis!`])
    : pick([`${name} is van het plein gevlogen!`, `${name} ligt tussen de kazen!`]);
}

export function koMessage(name: string): string {
  return pick([`${name} is knock-out!`, `${name} ziet sterretjes!`, `${name} doet even een dutje.`, `${name} is van de kaart!`]);
}

export const BOT_NAMES = [
  'Kees', 'Truus', 'Henk', 'Bep', 'Joop', 'Ans', 'Sjaak', 'Mien', 'Gerrit', 'Fenna', 'Klaas', 'Door',
  'Piet', 'Greet', 'Teun', 'Lies', 'Bram', 'Jet', 'Wim', 'Riek',
];
