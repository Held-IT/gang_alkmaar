// Small deterministic random helpers for the traffic module (no allocations per call).

/** mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of an integer (and optional salt) to a float in [0, 1). */
export function hash01(i: number, salt = 0): number {
  let h = (Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Picks an index from cumulative weights (last element = total) with u in [0, 1). */
export function pickWeighted(cum: ArrayLike<number>, u: number): number {
  const target = u * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
