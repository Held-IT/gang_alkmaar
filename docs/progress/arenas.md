# arenas — progress

Owner: src/arenas/**, src/scenes/dev-arena.ts (+ hooks in src/world/landmarks/molen.ts, kaasmarkt.ts)

## Status: DONE (all three arenas verified in the real city and in the brawl scene)

## Files
- src/arenas/index.ts — ARENAS + createArena (lazy import.meta.glob per arena, each exports `create`)
- src/arenas/common.ts — ArenaKit (bodies/meshes/dispose, dynamic props, kinematic hazards with
  interpolated visuals, forEachBeastPart / beastsBySlot via GROUP.BEAST, knock()), ConvexArea, crowd,
  dranghekken, cheese, draagberries, signs, synth sounds (horn/bell/gust)
- src/arenas/kaasmarkt.ts — Waagplein next to the canal quay north of De Waag (quay line fitted to
  the real water edge), dranghekken + 163 cheering onlookers, 18 cheese wheels + 2 barrows, porters
  hazard (bell, every 14-26 s; knocks beasts over / towards the canal). Thrown into the crowd = out.
- src/arenas/molen.ts — own mill copy (city mill hidden, 'molen' collider disabled), open front
  (-0.32..0.92 rad) + broken/low railing, sails = one kinematic body (SAIL_SCALE 1.09, tilt 5 deg)
  sweeping the front of the stage ~0.5-1.3 m above the deck, gusts (0.3 -> 0.85 rad/s), body fade on
  occlusion, 3 flour sacks
- src/arenas/boat/route.ts — open path PATH_WAYPOINTS (Verdronkenoord -> Waag -> Luttik Oudorp,
  445 m, 3 bridges), buildRoute(open) with bank centring + bridges from the road graph
- src/arenas/boat/model.ts — original tour boat "De Kaaskop" (19 x 4.2 m, glass roof 1.0 m above
  the water, open rear deck with benches/console/railing with a stern gap, bow pulpit, flag, beacons)
- src/arenas/boat/index.ts — scrolling world (world.root transform, world.update proxy camera),
  bridges measured on the city colliders (face rays + underside binary search, lazily after 2 physics
  steps) -> kinematic slices; bridge "smack" (whole-beast impulse -> KO + flung back), kinematic quay
  wall pool, wake/bow foam, horn + beacons + "LAGE BRUG / BUKKEN!" boards, ping-pong path (bow first
  per round, start >= 28 m before a bridge), overboard drift
- src/scenes/dev-arena.ts — ?arena=&hazard=1&beasts=&ai=wander|idle|edge&view=frame|eye|top&devcam=1
  &debugcol=1&boatpos=<m>&city=0; __debug.{arena,probe,isOutTests,beasts,map,setCam,setView,teleport,push,stats}

## Verification (dev machine AMD 7530U iGPU)
- 1920x1080 with 6 beasts: midden 60 fps (vsync) in all three; hoog: kaasmarkt 50, molen 50, boot 52
- no console errors (dev-arena all arenas, city and city=0; brawl scene autostart all arenas)
- dispose restores world.root transform, world.update, city mill visibility; 0 bodies left
- hazards: bridge pass KOs + flings roof beasts; sails sweep 2/3 front beasts off the stage;
  porters knock 3/3 lane beasts aside; gusts ramp; mill body fades to 0.28 when a beast hides behind
- shots in shots/arenas/ (k_*, m_*, r_*, game_*)
