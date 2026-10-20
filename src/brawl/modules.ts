// Loads the factories of the modules written in parallel (beast physics, beast visuals, arenas,
// bots) through import.meta.glob, so the game builds and runs before they exist. Missing (or
// failing) modules fall back to the placeholders in ./fallback. `?fallback=all` or a comma list
// (physics,visual,arenas,ai) forces the placeholders for debugging.
import type { CostumeInfo } from './contracts';
import type { ArenaInfo, BrawlModules, ColourInfo } from './types';
import { createFallbackBeastSystem } from './fallback/beastSystem';
import { createFallbackVisual, FALLBACK_COLOURS, FALLBACK_COSTUMES } from './fallback/visual';
import { createFallbackArena, FALLBACK_ARENAS } from './fallback/arena';
import { createFallbackBot } from './fallback/bot';

type Mod = Record<string, unknown>;
const physicsGlob = import.meta.glob<Mod>('../beast/physics/index.ts');
const visualGlob = import.meta.glob<Mod>('../beast/visual/index.ts');
const arenasGlob = import.meta.glob<Mod>('../arenas/index.ts');
const aiGlob = import.meta.glob<Mod>('../beast/ai/index.ts');

async function load(glob: Record<string, () => Promise<Mod>>, name: string, forced: boolean): Promise<Mod | null> {
  if (forced) return null;
  const loader = Object.values(glob)[0];
  if (!loader) return null;
  try {
    return await loader();
  } catch (e) {
    console.warn(`[brawl] module ${name} kon niet laden, placeholder gebruikt:`, e);
    return null;
  }
}

const isFn = (v: unknown): v is (...a: never[]) => unknown => typeof v === 'function';

/** Accepts string[] / {hex|colour|color|value, name}[] / Record<name, hex>. */
function normaliseColours(raw: unknown): ColourInfo[] | null {
  const names = FALLBACK_COLOURS;
  const out: ColourInfo[] = [];
  const push = (hex: unknown, name: unknown, i: number) => {
    if (typeof hex === 'number') hex = `#${hex.toString(16).padStart(6, '0')}`;
    if (typeof hex !== 'string') return;
    out.push({ hex, name: typeof name === 'string' && name ? name : names[i % names.length].name });
  };
  if (Array.isArray(raw)) {
    raw.forEach((c, i) => {
      if (typeof c === 'string' || typeof c === 'number') push(c, null, i);
      else if (c && typeof c === 'object') {
        const o = c as Record<string, unknown>;
        push(o.hex ?? o.colour ?? o.color ?? o.value, o.name ?? o.label, i);
      }
    });
  } else if (raw && typeof raw === 'object') {
    Object.entries(raw as Record<string, unknown>).forEach(([k, v], i) => push(v, k, i));
  }
  return out.length ? out : null;
}

export async function loadBrawlModules(params: URLSearchParams): Promise<BrawlModules> {
  const f = (params.get('fallback') ?? '').split(',');
  const force = (n: string) => f.includes('all') || f.includes(n);
  const [phys, vis, arenas, ai] = await Promise.all([
    load(physicsGlob, 'beast/physics', force('physics')),
    load(visualGlob, 'beast/visual', force('visual')),
    load(arenasGlob, 'arenas', force('arenas')),
    load(aiGlob, 'beast/ai', force('ai')),
  ]);
  const real = {
    physics: !!phys && isFn(phys.createBeastSystem),
    visual: !!vis && isFn(vis.createBeastVisual),
    arenas: !!arenas && isFn(arenas.createArena),
    ai: !!ai && isFn(ai.createBotController),
  };
  const createBeastVisual = (real.visual ? vis!.createBeastVisual : createFallbackVisual) as BrawlModules['createBeastVisual'];
  const costumes =
    real.visual && Array.isArray(vis!.COSTUMES) && (vis!.COSTUMES as CostumeInfo[]).length
      ? (vis!.COSTUMES as CostumeInfo[])
      : FALLBACK_COSTUMES;
  const colours = (real.visual && normaliseColours(vis!.BEAST_COLOURS)) || FALLBACK_COLOURS;
  const arenaList =
    real.arenas && Array.isArray(arenas!.ARENAS) && (arenas!.ARENAS as ArenaInfo[]).length
      ? (arenas!.ARENAS as ArenaInfo[])
      : FALLBACK_ARENAS;
  const mods: BrawlModules = {
    createBeastSystem: real.physics
      ? (phys!.createBeastSystem as BrawlModules['createBeastSystem'])
      : (engine, physics, opts) => createFallbackBeastSystem(engine, physics, opts ?? {}, createBeastVisual),
    createBeastVisual,
    costumes,
    colours,
    createArena: real.arenas ? (arenas!.createArena as BrawlModules['createArena']) : createFallbackArena,
    arenas: arenaList,
    createBotController: real.ai ? (ai!.createBotController as BrawlModules['createBotController']) : createFallbackBot,
    prewarmVisuals: () => {
      if (real.visual && isFn(vis!.prewarmBeastVisuals)) (vis!.prewarmBeastVisuals as () => void)();
    },
    real,
  };
  console.info('[brawl] modules:', JSON.stringify(real));
  return mods;
}
