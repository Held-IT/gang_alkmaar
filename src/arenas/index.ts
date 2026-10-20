// Arenas module: the three Gang Alkmaar arenas in the real city (contract: src/brawl/contracts.ts).
//   kaasmarkt      Waagplein next to the canal quay (De Waag, cheese, porters, crowd)
//   rondvaartboot  canal tour boat; the city glides past ("scrolling world"), bridges sweep the roof
//   molen          stage of the Molen van Piet with sweeping sails
// Each arena module exports `create(ctx)`; they are loaded lazily so the city-only scenes stay small.
// Extras on the returned arenas (ArenaExt in src/brawl/types.ts): reset() for a new round and floorY.
import type { Arena, ArenaContext, ArenaId } from '../brawl/contracts';

export const ARENAS: { id: ArenaId; name: string; description: string }[] = [
  {
    id: 'kaasmarkt',
    name: 'Kaasmarkt',
    description: 'Op het Waagplein bij De Waag: kazen, kaasdragers en de gracht als afgrond.',
  },
  {
    id: 'rondvaartboot',
    name: 'Rondvaartboot',
    description: 'Op een rondvaartboot door de grachten. Bukken voor de lage bruggen!',
  },
  {
    id: 'molen',
    name: 'Molen van Piet',
    description: 'Op de stelling van de molen, met wieken die alles van het plankier maaien.',
  },
];

type ArenaModule = { create(ctx: ArenaContext): Promise<Arena> };

const modules = import.meta.glob<ArenaModule>(['./kaasmarkt.ts', './molen.ts', './boat/index.ts']);
const FILE: Record<ArenaId, string> = {
  kaasmarkt: './kaasmarkt.ts',
  rondvaartboot: './boat/index.ts',
  molen: './molen.ts',
};

export async function createArena(id: ArenaId, ctx: ArenaContext): Promise<Arena> {
  const load = modules[FILE[id]];
  if (!load) throw new Error(`[arenas] onbekende arena: ${id}`);
  const mod = await load();
  return mod.create(ctx);
}
