# integration (Gang Alkmaar) — progress notes

Role: end-to-end integrator & game-feel tuner (all modules finished; may edit any module file).
Test harness (scratchpad, not in repo): page monitor (phase log + leak counters), scripted human
"pilot" (approach / jab / grab / lift-carry / throw), perf probe (update / physics / render CPU ms).

## Session 1
- baseline: brawl uses the real physics, visuals, arenas and bots in all 3 arenas, 0 console errors
- leak loop: 9 matches back to back (all arenas, 1-5 bots, all difficulties) via startMatch/forceWin/skip:
  rigid bodies / joints back to 0 in the lobby, engine updates 11, physics hooks 1/1, scene objects 650,
  geometries plateau (~508, caches), textures 110, heap stable ~250 MB
- added debug counters: `engine.updateCount`, `physics.hookCount`
- brawl.ts: bots get `dt * timeScale` (slow motion); `mods.prewarmVisuals()` under the loading screen
- tree cut-out: tree materials (PROP_WIND in propMaterial.ts) dither away foliage/bark in front of each
  fighter (8 view-space points) and close to the camera (uCutNear); `src/brawl/treeCut.ts`, set after
  the camera each frame; camera scoring no longer penalises crowns in front of fighters
- input.ts: human auto-run after 0.65 s of steady full movement (bots could run, the human could not)
- camera min distances: kaasmarkt 12->10, molen 14->12, boat 11->9.5
- bots: moeilijk humanCap Infinity -> 3
- kaasmarkt: crowd out-margin 1.3 -> 0.8 m (beasts stuck behind the dranghekken)
- perf (iGPU, 1920x1080 window = 1538x817 css @1.25, 6 beasts): kaasmarkt midden 58 fps / 343 dc / 3.1 M,
  hoog 56 / 411 / 3.9 M (dyn-res 0.91); molen 60/284/1.35 M, 60/424/2.3 M; boat 60/274/1.5 M, 58/269/1.5 M.
  CPU per frame: updates 2.3-3.5 ms (physics 1.7-2.7), render submit 3.7-5.5 ms

- camera cut-outs extended: molen sails (new `cut` option -> PROP_CUT on the sail materials in
  landmarks/molen.ts) and the bridge materials (`bridge_*` keys in materials/shaderLib.ts, only while a bridge
  is over the boat: uCityCutCount); facades/ground keep shaders without discard (early-z)
- rondvaartboot: HUD warning "Lage brug! Bukken!" (hud.warn, style .ga-warn) while arena.warning > 0.5, camera
  pitch flattened by 0.28 * warning so the fighters under the arch stay visible
- beast physics: grab shape query prefers dynamic props over the floor (cheese wheels can be picked up);
  a held (not lifted) beast whose chest drops 0.55 m below the holder's feet slips loose (tuning.dropRelease)
- molen camera min distance back to 14 (12 crowded the mill body)
- lobby thumbnails re-rendered for molen + rondvaartboot from the real arenas (public/assets/brawl/)
- scripted play-tests (pilot = approach, jab combos, grab KO'd target, lift-carry to the edge, throw):
  kaasmarkt / molen / boat at normaal and moeilijk, human wins and loses rounds; rounds 14-64 s;
  keyboard: 0.11 s to 1 m/s, walk 2.4 m/s, auto-run 3.9 m/s, stop 0.3-0.4 s
- full flow: loading -> lobby -> arena/difficulty clicks -> Vechten! -> 5 rounds -> celebration -> lobby;
  pause menu Hervatten/Opnieuw/Naar lobby/Afsluiten (closes the Electron window); 0 console errors

## Open
- throwing right at an edge after dragging (instead of lifting first) can still pull the thrower in
- boat rounds with 2-3 fighters are short (10-35 s); bridge pass keeps the warning up ~15 s
- iGPU hoog @1080p: 50-58 fps (dynamic resolution 0.8-0.92); midden 58-60

---
# (old Alkmaar Drive integration notes below)
# integration — progress notes

Owns `src/scenes/game.ts`, `electron/**`, `tools/package.mjs`.

## Review fixes (round: integration fixer)

- **`__debug.start()` while the menu was open**: `startDriving()` now always calls
  `ui.hideMainMenu()` and `ui.hidePause()` (both no-ops when hidden). Before, a start that did not
  come from the menu's own "Start rit" left the menu overlay up and `ui.isBlockingInput()` true, so
  the car never received input. Verified: menu → `__debug.start` → W for 3 s = 35 km/h, no overlay
  (`shots/integration/debugstart_drive.png`).
- **Start hitch (player-car programs)**: the warm-up car (`programKeeper`) is no longer disposed on
  the first start. three.js frees a program when its last material is disposed; disposing the
  warm car in the same tick as the new car was created released `car-decal` (and friends) before
  the new car had ever rendered, so its first frame recompiled them. The keeper is built with the
  same options as a session car (plate), compiled via `world.warmUp`, then drawn for two frames
  under the loading screen in front of the camera (covers shadow-depth variants + buffer uploads)
  and taken out of the scene again. It lives for the whole game (never in the scene; tiny).
  Also calls `prepareVehicleAudio()` (audio module API) during loading for the first car and in
  the background for all cars once the menu is up: the first `createVehicleAudio()` used to block
  ~270 ms creating the AudioContext.
  Measured (iGPU, quality=hoog, start from menu): `__debug.start` call 293 ms → ~17 ms, new
  programs on the first frames `['car-decal']` → none, first frame gap 231 ms → ~55 ms. A car
  change (menu → other car) also compiles nothing new.
- **Menu render-scale trick removed**: the main menu used `engine.setQuality({renderScale:0.6})`,
  which persists to localStorage (stuck at 60% after a crash / kill in the menu, and shown as
  "Resolutieschaal 60% · Aangepast" in Instellingen). Measured: the fly-over is no heavier than
  driving (iGPU hoog @1280x720: menu 18.8 fps vs driving 15.5 fps at scale 1), so the menu now
  simply renders at the player's settings. If a cheaper menu is wanted later it needs a
  non-persisted engine-level override (engine module), not `setQuality`.
- **Volume slider while paused**: `ui.onVolumeChange` now applies 0 while `state === 'paused'`;
  `resume()` restores `ui.volume` (verified: gain stays 0 when the slider moves to 0.7 in the pause
  menu, 0.7 after resume).
- **Minimized window kept rendering**: `electron/main.cjs` keeps `backgroundThrottling:false`
  (focus loss / occlusion must not stall the game) but turns throttling on at `minimize`/`hide`
  and off again at `restore`/`show`/`focus` (not in `--selftest`, which renders off-screen).
  Verified in a scratch Electron app with the same switches: minimized → page `hidden`, 0 rAF/s;
  restored → `visible`, 57 rAF/s. The packaged build needs `node tools/package.mjs` to pick it up.
