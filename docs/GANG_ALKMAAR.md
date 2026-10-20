# Gang Alkmaar — architecture & contracts (read this first)

Gang Alkmaar is a Gang Beasts-style wobbly-ragdoll brawler set in the real 3D Alkmaar of
"Alkmaar Drive" (this project is a copy of it). One human player fights 1–5 AI bots in arenas on
recognisable spots; whoever falls into the canal or off the stage is out; last beast standing wins
the round, first to N round wins takes the match. All user-facing text is Dutch.

Original assets only: no Gang Beasts / Boneloaf content (models, sounds, names, logos). The MIT
licensed reference engine in `reference/gang-beasts-rust` (Rust/Bevy/PhysX) may be STUDIED for
gameplay logic and constants (especially `crates/gb_logic/src/actor.rs`, `beast.rs`, `input.rs`,
`crates/gb_game/src/binds.rs`, `crates/gb_phys/src/world.rs`); ported logic must credit it
("Spellogica deels gebaseerd op gb-rust door muffinmxn, MIT-licentie") in the credits. Never build
or run anything from `reference/`.

## Reused modules (from Alkmaar Drive, see docs/ARCHITECTURE.md)
Engine (`src/core`), materials, world loading (`loadWorld`), props & landmarks (De Waag hero,
Molen van Piet, Kaasmarkt cheese, boats), city data in `public/data`, UI helpers in `src/ui`,
traffic (optional ambience), Electron shell, shot tool. These are FROZEN: use their APIs; only the
owners listed below may change them, and only where stated.

## New modules & ownership
| path | owner | purpose |
|---|---|---|
| `src/beast/physics/**`, `src/beast/rig.ts`, `src/physics/**` | beast-physics | Rapier ragdoll, balance/walk controller, grab/punch/kick/headbutt/lift/throw, KO, swimming/drowning, `createBeastSystem` |
| `src/beast/visual/**`, `public/assets/beast/**` | beast-visual | jelly beast meshes per rig part, face/expressions, colours, Alkmaar costumes, `createBeastVisual`, `COSTUMES` |
| `src/beast/ai/**` | bots | `createBotController` |
| `src/arenas/**`, `src/world/landmarks/molen.ts` (hooks only) | arenas | the three arenas + hazards, `createArena` |
| `src/brawl/**` (except `contracts.ts`), `src/scenes/brawl.ts` | game-flow | lobby/menus/HUD (Dutch), round & match flow, Gang-Beasts-style framing camera, human input mapping, brawl audio, the main scene |
| `src/brawl/contracts.ts`, `src/main.ts`, `docs/**`, `electron/**`, `tools/package.mjs`, `tools/shot*` | orchestrator | contracts, packaging |
| `src/scenes/dev-<module>.ts` | that module | dev/test scenes |

## Factories (exact names)
| module | factory |
|---|---|
| `src/beast/physics/index.ts` | `createBeastSystem(engine, physics, opts?: { world?: WorldExt \| null }): Promise<BeastSystem>` |
| `src/beast/visual/index.ts` | `createBeastVisual(opts: { colour: string; costume: string; scale?: number }): BeastVisual`, `COSTUMES: CostumeInfo[]` |
| `src/beast/ai/index.ts` | `createBotController(beast, ctx: { system: BeastSystem; arena: Arena; difficulty: BotDifficulty; physics: PhysicsWorld }): BotController` |
| `src/arenas/index.ts` | `createArena(id: ArenaId, ctx: ArenaContext): Promise<Arena>`, `ARENAS: { id: ArenaId; name: string; description: string }[]` |
| `src/scenes/brawl.ts` | the game (default scene of `src/main.ts`) |

Types: `src/brawl/contracts.ts`; rig numbers: `src/beast/rig.ts`.

## Physics
- Rapier via `src/physics/physics.ts` (`createPhysics`, fixed 120 Hz sub-steps; the scene calls
  `physics.step(dt)` at engine priority 10). beast-physics owns this file now and adds a `BEAST`
  collision group (beast parts collide with the static world, props, kinematic hazards and other
  beasts; a beast's own adjacent parts don't collide).
- Arena colliders: static via `physics.addStatic*`; dynamic props (cheese wheels, barrows) use
  `COLLISION_GROUPS.prop`; moving hazards are kinematic bodies.
- The real city's colliders are loaded by `loadWorld` (quays, canal bed, buildings); arenas may
  rely on them or add their own invisible barriers.
- Moving platform (rondvaartboot): prefer the "scrolling world" trick of the reference engine's
  Train stage: keep the boat (and its colliders) static and move the CITY visuals (and kinematic
  bridge colliders) past it, so ragdolls never ride a moving body.

## Arenas
1. `kaasmarkt` — the cheese market on the Waagplein in front of De Waag (world origin): rows of
   cheese on the square, tourists behind crowd barriers (dranghekken), cheese wheels and porters'
   barrows as physics props, the canal side as the drop. Optional hazard: a pair of cheese porters
   trotting through with a loaded barrow.
2. `rondvaartboot` — fight on a canal tour boat sailing through the binnenstad canals past the real
   houses; low bridges sweep over the roof/deck (duck or get knocked off); falling in = out.
3. `molen` — on the stage (stelling, ~7 m up) of the Molen van Piet; the rotating sails sweep
   past the stage and can catch beasts; falling off = out.

## Gameplay rules
- Free-for-all; 1 human + 1..5 bots (difficulty makkelijk / normaal / moeilijk); wins to win 1..10.
- Out = `arena.isOut(chest position)` or fell > 4 m below the arena floor; eliminated beasts stay
  visible (sinking/lying) and stop being controlled.
- Round flow: countdown ("3, 2, 1, Vechten!"), last beast standing wins the round (draw if the last
  ones fall within 1 s), winner zoom, scoreboard (points as cheese wheels), next round.

## Verification
`npx tsc --noEmit -p .` clean; `node tools/shot.mjs --scene <scene> ...` and LOOK at the PNGs;
screenshots in `shots/<module>/`. Gameplay needs motion: take shot sequences (steps with waits)
and log numbers (positions, states) from `window.__debug`.
