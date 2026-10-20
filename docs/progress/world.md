# World assembly — progress

Owner: world module (src/world/*.ts top level, src/world/loaders/**, src/scenes/dev-city.ts)

## Status: DONE (session 1 + polish round 2) — full city loads in 7-9 s (warm shader cache) / ~18 s (cold), tsc clean, 0 console errors

## Files
- world.ts: `loadWorld(engine, physics|null, onProgress?, options?) -> WorldExt` (adds root to engine.scene)
- types.ts: WorldExt, LoadWorldOptions, WorldStats
- cityMeshes.ts: mergeToPrimitive / mergePrimitives / splitByGrid, CityCuller (per-material distance culling,
  canal bed only below water), createCityMesh (frees CPU arrays after GPU upload)
- heightGrid.ts: 0.5 m int16 height + uint8 surface grid rasterised from ground GLBs + water
- loaders/glb.ts (own GLB reader, interleaved -> tight arrays), loaders/fetch.ts (fetch + XHR fallback, pool),
  loaders/collision.ts (ground trimesh per surface tag + friction, buildings, boundary walls)
- scenes/dev-city.ts: orbit + WASD fly, ?spawn= ?street= ?view= ?cam/look, HUD, __debug (heightCheck, breakdown)

## Key decisions
- Super-chunks: buildings 2x2 chunks (400 m), ground 4x4 (800 m), sparse ground materials 8x8; backdrop
  ring split into 600 m cells, water into 400 m tiles (planar reflection only runs when a tile is in view)
- Per-material max distance at 'hoog' (scaled laag .65 / midden .85 / ultra 1.35): road_marking 280,
  bridge_rail 400, curb 450, quay_cap 550, bikelane/parking 900, rest drawDistance*1.05; backdrop always
- Shadows: walls + slanted roofs + bridge_side cast; flat roofs don't (back-face shadow pass ignores them)
- Shader warm-up (warmup.ts ShaderWarmer): staged compileAsync per subtree with own time limit
  (city+water 12 s, props 8 s, landmarks 8 s, other root children 6 s), in the program variant the
  frame really uses (composer active -> render-target variant: linear, no tone mapping; direct path
  with planar water -> screen + RT variant), then one real frame (shadow depth / post programs).
  Children added to world.root later (traffic) are warmed on 'childadded' (microtask, before the
  next frame). world.warmUp(objects, ms) is public for other subtrees (e.g. the player car).

## Measured (dev iGPU, 1920x1080)
- midden: 181-336 draw calls, 1.0-2.1 M tris, 45-60 fps (final defaults sb=2 sg=4)
- hoog: 293-537 draw calls, 1.9-3.8 M tris (planar reflection + 2 cascades), 28-50 fps (sb=2 sg=4)
- heightAt 0.18 us/call; vs physics ray: p50 0, p90 0, p99 1.05 m (quay/canal edges), 1.2 % > 30 cm

## Polish round 2 (QA fixes)
- isInsideBuilding(x,z): footprints rasterised on the height grid, 14 ns/call; spawn 'waag' false;
  street cells inside: asphalt 0.2 %, bikelane 1.5 %, klinkers 3.5 % (footprint overhangs), sidewalk
  46 % (block fill under buildings, expected). heightAt unchanged (street level).
- createProps(..., { map2d, roadGraph, boatRect: osmMeta.playable, heightAt }) and
  createLandmarks(..., { footprints, map2d, roadGraph, heightAt }) (landmarks: heightAt forward compatible).
- LAYER_REFLECT on building chunks, backdrop cells and the vertical ground parts (quay, quay_cap,
  bridge_side/rail/deck, curb). Flat ground is not needed: the mirrored camera sees its back faces.
  Verified at Verdronkenoord + Voordam on hoog (s_verdronkenoord_hoog, s_drive).
- Warm-up measured (hoog, iGPU): city 1.1-1.3 s warm cache / 6.6 s cold (46 programs), props 0,
  landmarks 4 programs 30-300 ms, first frame 7-13 ms; traffic 9 programs 273 ms on add
  (was 1.5-2 s polled from update). Menu: 0 new programs, no frame > 100 ms.
- First drive hitch (not world): 1.8-2.3 s frame = player car shaders (8 programs ~1.5 s, game.ts/vehicle)
  + createVehicleAudio 0.69 s (audio). Pre-warming the car model with world.warmUp in the menu
  measured 2.33 s -> 0.85 s (remaining = audio). Requested from orchestrator/audio.
- Frame breakdown 1920x1080 iGPU, Waag spawn, standing: hoog avg 47 ms (physics 3.6, traffic 0.8,
  world.update 0.05, render cpu ~7.6, rest GPU; 442 dc, 3.2 M tris); midden avg 23 ms (physics 3.5,
  traffic 1.1, world 0.09, render cpu ~10; 335 dc, 2.2 M tris). Hoog GPU cost isolation (noisy):
  planar ~8 ms (76 dc / 0.57 M tris), shadows ~15 ms (1.3 M tris in 2 cascades), AO ~12 ms,
  drawDistance 2600 -> 500 only -74 dc.

## Review fix round (world group)
- isInsideBuilding: the hero buildings the BAG pipeline excludes (Waag, Accijnstoren, Molen van Piet:
  rendered by landmarks) were missing from the building bit mask. loadWorld now also rasterises
  bag-meta.json `excludedInfo[].footprint` (pipeline extra, read defensively) + osm-meta landmark
  footprints (heroFootprints() in world.ts). Verified in-game: Waag (-0.5,0.77), Accijnstoren,
  Molen, Grote Kerk, Stadhuis centres all true. The 'station' landmark point (-629,-759) is an OSM
  node outside every footprint (16 m from the nearest ring), so false there is correct.
- dev-city view 'langestraat' moved onto the street axis (-232,1.7,-33) -> (-300,4,-80) (was inside
  two footprints). shots/world/v_langestraat.png.

## Remaining / next
- landmarks: heightAt passed, waiting for the landmarks owner to use it; player car warm-up in game.ts (request)
- report requests (materials: Grote Kerk light grey, reflection layer mask; OSM: railway tracks at station)

## Verification shots (shots/world/)
c_* (midden 1080p tour), p_* (hoog perf tour), b_*Low (low aerials), d_brug (planar water, hoog),
e_sidewalk (Luttik Oudorp), f_laag/f_ultra (live quality switch), f_night, g_spawn_verdronkenoord,
a3_waaglow, a2_aerial, r_* (reflection layer), s_* (polish round 2). Steps files: shots/world/steps/*.json (mk.cjs builds tours with STATS logging).
