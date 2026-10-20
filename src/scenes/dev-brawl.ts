// Fast dev variant of the brawl scene: skips the city (world=0) unless ?world=1 is given.
// Same parameters as src/scenes/brawl.ts (autostart, arena, bots, difficulty, wins, fallback).
import type { SceneEntry } from '../contracts';
import brawl from './brawl';

const devBrawl: SceneEntry = async (engine, params) => {
  if (!params.has('world')) params.set('world', '0');
  await brawl(engine, params);
};

export default devBrawl;
