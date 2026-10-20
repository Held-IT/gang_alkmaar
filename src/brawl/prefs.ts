// Persisted player choices (localStorage can throw: private mode, file://, previews).
import type { ArenaId, BotDifficulty } from './contracts';
import type { LobbyChoices } from './types';

const PREFIX = 'gangAlkmaar.';

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && fallback && typeof fallback === 'object' ? { ...fallback, ...(v as object) } : (v as T);
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export interface BrawlSettings {
  /** effects + ambience, 0..1 */
  volume: number;
  music: number;
  tags: 'altijd' | 'vervagen' | 'uit';
  shake: boolean;
}

export const DEFAULT_SETTINGS: BrawlSettings = { volume: 0.8, music: 0.6, tags: 'vervagen', shake: true };

export const DIFFICULTIES: { id: BotDifficulty; name: string }[] = [
  { id: 'makkelijk', name: 'Makkelijk' },
  { id: 'normaal', name: 'Normaal' },
  { id: 'moeilijk', name: 'Moeilijk' },
];

export function sanitizeChoices(c: Partial<LobbyChoices>, arenaIds: ArenaId[], fallback: LobbyChoices): LobbyChoices {
  const clampInt = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d;
  return {
    name: typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 14) : fallback.name,
    colour: typeof c.colour === 'string' ? c.colour : fallback.colour,
    costume: typeof c.costume === 'string' ? c.costume : fallback.costume,
    arena: c.arena && arenaIds.includes(c.arena) ? c.arena : fallback.arena,
    bots: clampInt(c.bots, 1, 5, fallback.bots),
    difficulty: DIFFICULTIES.some((d) => d.id === c.difficulty) ? (c.difficulty as BotDifficulty) : fallback.difficulty,
    wins: clampInt(c.wins, 1, 10, fallback.wins),
  };
}
