// Ground height sampling for props / landmarks. props.json has no y, so the world passes its ground
// grid as heightAt(x, z) (sidewalks are +0.12 m, roads 0). Without it everything stands on y = 0.
export type GroundFn = (x: number, z: number) => number;

/** Wraps an optional heightAt so it never throws or returns garbage (fallback: street level 0). */
export function safeGround(fn?: GroundFn | null): GroundFn {
  if (!fn) return () => 0;
  return (x, z) => {
    let h = 0;
    try {
      h = fn(x, z);
    } catch {
      h = 0;
    }
    return Number.isFinite(h) ? Math.max(-1, Math.min(3, h)) : 0;
  };
}

/** Lowest ground height under a footprint ring (plus its centre), for buildings / large objects. */
export function groundMin(ground: GroundFn, ring: ArrayLike<readonly [number, number] | number[]>, cx: number, cz: number): number {
  let h = ground(cx, cz);
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    // sample just inside the corner (the corner itself may lie on the street / quay edge)
    const x = p[0] + (cx - p[0]) * 0.08, z = p[1] + (cz - p[1]) * 0.08;
    h = Math.min(h, ground(x, z));
  }
  return h;
}
