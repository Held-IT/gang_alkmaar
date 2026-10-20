// Small deterministic random helpers (seeded), so props look the same every run.

/** Mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash of two numbers (e.g. world x/z) to a float in [0, 1). */
export function hash2(x: number, z: number, salt = 0): number {
  let h = Math.imul(Math.floor(x * 97.13) | 0, 0x27d4eb2d) ^ Math.imul(Math.floor(z * 61.7) | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** String hash (FNV-1a) to uint32. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private readonly f: () => number;
  constructor(seed: number) {
    this.f = mulberry32(seed);
  }
  next(): number {
    return this.f();
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.f();
  }
  int(a: number, bInclusive: number): number {
    return a + Math.floor(this.f() * (bInclusive - a + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.f() * arr.length) % arr.length];
  }
  chance(p: number): boolean {
    return this.f() < p;
  }
  /** Approximately normal distributed (mean 0, sd 1). */
  normal(): number {
    return (this.f() + this.f() + this.f() + this.f() - 2) * 1.732;
  }
  /** Weighted pick: weights need not sum to 1. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let sum = 0;
    for (const w of weights) sum += w;
    let r = this.f() * sum;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
