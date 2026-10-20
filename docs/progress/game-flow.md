# game-flow — progress

Owner: src/brawl/** (except contracts.ts), src/scenes/brawl.ts, src/scenes/dev-brawl*.ts

## Status: IN PROGRESS (session 3, started 16:14)

## Files (tsc clean)
- modules.ts (import.meta.glob loader + fallbacks in fallback/*), types.ts, match.ts (RoundJudge, Dutch messages)
- camera.ts, input.ts, pad.ts, audio.ts, prefs.ts, pose.ts (lobby preview idle anim)
- ui/: loading.ts, lobby.ts, menus.ts, hud.ts, nav.ts, icons.ts, style.css
- scenes/brawl.ts (main game), scenes/dev-brawl.ts (world=0)

## Done
- session 1: all files written
- session 2: placeholder shots (shots/game-flow/f*, rf*, m_*), city shots for all 3 arenas (fallback arenas),
  real beast physics + visual wired via glob; camera work on molen (city_molen_cam*.png, 15:58)

## Next (session 3)
- review latest shots, verify camera/HUD in city; arena thumbnails (public/assets/brawl/)
- switch to real arenas when src/arenas/index.ts appears; report bot wiring

## Session 3 (done so far)
- "Jij" bobbing marker above the human's tag during countdown + first 3.5 s (hud.ts, style.css)
- slow motion (x0.3, 1.25 s) for the round-deciding fall/out + whoosh + punch-in (brawl.ts, match.ts isFalling)
- winner cheer: empty-handed lift = arms up + hops (human keeps control, cheers when idle; bot winners auto)
- winner/orbit camera target raised 0.3 m (beast below the banner)
- src/scenes/dev-brawl-thumbs.ts: lobby card thumbnails (arena=<id>&dist&yaw&pitch&up) → convert with sharp
  to public/assets/brawl/arena_<id>.jpg (lobby already loads those, SVG fallback) — do once real arenas exist
- shots: shots/game-flow/s3_* (city flow, slow-mo, cheer, celebration)

## Session 4 (started 18:02)
- state: tsc clean; real beast physics + visual in use; arenas/index.ts not there yet (kaasmarkt.ts exists)
- plan: interim per-arena loading (arenas/<id>.ts create*), verify real kaasmarkt in city, thumbnails,
  final flow shots, bot wiring notes
- 18:20 arenas/index.ts landed (kaasmarkt real; molen/boat throw -> my placeholder via ensureArena catch)
- camera.ts: tree crowns (from 'tree' trunk colliders via Rapier shape query) + drop-edge probes
  (arena.edgeDistance via camera.setEdgeTest) scored per [yaw,pitch] candidate; free swing during the
  countdown, max 0.85 rad swing + 2.5 s hold during play; winner zoom picks a crown/wall-free yaw and
  close-ups pull in in front of crowns. debug: __debug.cam.debug.scores()
- public/assets/brawl/arena_kaasmarkt.jpg (dev-brawl-thumbs arena=kaasmarkt&dist=0&yaw=0.25&pitch=0.38&up=2)
- perf: kaasmarkt real, 5 bots, 1920x1080 hoog on the iGPU: 56 fps, 369 draw calls, 3.7 M tris
- camera: sight lines also from all subjects (60 % human / 40 % mean), foreground-crown probes at the
  bottom of the screen, never parks inside a crown; HUD name tags de-overlap (nearest keeps its spot)
- public/assets/brawl/arena_molen.jpg (city mill + placeholder spawns; re-render when src/arenas/molen.ts
  exists: dev-brawl-thumbs arena=molen&dist=1.3&yaw=0.5&pitch=0.18&up=5); rondvaartboot keeps the SVG card
  until boat/index.ts exists
- dev-brawl-thumbs falls back to the placeholder when createArena throws
- final shots: shots/game-flow/s4f_* (flow + celebration with real kaasmarkt + costumes), s4g_cam*, s4m_cam*
## Status after session 4: DONE except re-checks when molen / rondvaartboot / bots land
