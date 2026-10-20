# bots — progress

Owner: src/beast/ai/**, src/scenes/dev-bots.ts

## Status: DONE (session 1)

## Files
- src/beast/ai/profiles.ts   BOT_PROFILES (makkelijk / normaal / moeilijk), mutable for tuning
- src/beast/ai/sense.ts      ArenaSense, shared per arena (getSense): 0.5 m walkability grid (static ray
                             casts, built once at the first createBotController, ~15-24 ms), edge margin scale,
                             hazards: molen sails (kinematic body tag 'wieken'), kaasmarkt porters ('kaasdragers'),
                             boat bridge ETA (arena.debug.state()/frame), props (dynamic PROP bodies)
- src/beast/ai/bot.ts        BotBrain: think() every profile.think s (reaction delay) -> plan; act() per frame
- src/beast/ai/index.ts      createBotController(beast, ctx): BotControllerExt + re-exports
- src/scenes/dev-bots.ts     bots-only FFA in the real city, ?rounds=N fast sim (~15x real time, city hidden),
                             per-round stats, self-out traces, dummy=1, ai.<diff>.<field>=<n> overrides

## Done
- all behaviours: warm-up, target choice (anti dog-pile, human bias), jab combos, grab+punch, kick /
  headbutt / drop kick near drops, edge control, KO -> grab -> drag to drop -> lift -> throw (prefers the
  canal), stomp hanging beasts, flee from edges, evade, lurk around pile-ups, KO mashing, ledge catch +
  climb, vault back over the crowd barrier, hazard dodge (sails, porters), boat shelter + duck, taunts,
  wobble, flour-sack / cheese throwing (sacks work, flat cheese wheels rarely: hands grab the floor)
- tuning: normaal 4 bots: kaasmarkt ~48-76 s, molen ~45-68 s, boat ~30-42 s; self-outs ~0-7 %
- dummy test (bot vs passive beast, kaasmarkt): makkelijk ~90 s, normaal ~35 s, moeilijk ~20 s
- shots: shots/bots/sheet_kaas_throw.png, sheet_boat_bridge.png, m_live*.png, k_live*.png, brawl_k*.png

## Final numbers (fast sim, real city, 4 bots, same difficulty)
| arena | makkelijk avg/med (s) | normaal avg/med (s) | moeilijk avg/med (s) |
|---|---|---|---|
| kaasmarkt | 86.7 / 90 (2 of 8 hit 150 s) | 65.1 / 68.1 | 46.5 / 48.4 |
| molen | 86.6 / 101 | 31.3 / 32.3 (earlier runs 45-68) | 46.9 / 46.5 |
| rondvaartboot | 54.6 / 42.8 | 51.6 / 47.4 (earlier runs 30-42) | 33.3 / 40.4 |
- self-outs 0-4 %; bot cost 0.001-0.005 ms per update avg, worst single update <= 2 ms; grid build 15-24 ms once
- dummy test, 1 bot vs a beast without a controller (kaasmarkt, 8 rounds): median makkelijk 40 s, normaal 42 s,
  moeilijk 33 s; avg 60 / 45 / 28 s (an earlier 10-round run gave avg 91 / 35 / 20 s)
- 1v1 bot duels moeilijk vs normaal are about 50/50 (chaotic physics); moeilijk deals more KOs and throws

## Open / for others
- brawl.ts passes the real dt to bot.update(); dt * timeScale would match slow motion (game-flow)
- flat cheese wheels are hard to pick up: a ducking reach hits the floor first (beast-physics could prefer
  dynamic props over static ground in tryGrab)
- kaasmarkt: a beast pushed 0-1.3 m past the crowd barrier is not out yet but stuck behind it; bots try to
  vault back (jump + grab), not always successfully (arenas could lower that margin)
