# UI module — progress

Status: DONE (all states verified at 1280x720, 1600x900, 2560x1440; tsc clean; 0 console errors).

## Done (predecessor)
- src/ui/*: loading screen (skyline, tips), main menu (car cards, paints, spawn, 3D preview),
  HUD (speedo canvas, gear, rpm, street sign, speed-limit sign, F3 fps), minimap + big map
  (async setData with race token, real data verified), pause menu, settings, credits, toasts,
  confirm dialog, keyboard/gamepad nav. Dev scene src/scenes/dev-ui.ts.

## This session
- [x] dashboard warning lights: HudInfo.lights = { head, handbrake, abs, tcs, esc } + gearboxMode;
      telltales in the dial's bottom gap; ESP OFF / ABS steady when assist disabled; gear shows D3 / M3
- [x] driving prefs (src/ui/driving.ts): Instellingen › Rijden tab (Versnellingsbak, ABS, TCS, ESP)
      + warning-light legend; PauseHandlers.onGearbox?/onAssists?; GameUI.gearbox/assists/
      onDrivingChange/setDriving; pause overview shows "Rijden" chips
- [x] controls table synced with src/core/input.ts (Shift/Ctrl shifting, pad B reset, Y camera ...)
- [x] big map: pad View closes it; duplicate unforced toggle within 250 ms ignored (M handled by UI
      and by the vehicle input 'map' action)
- [x] dev scene params: lights=, gearbox=, assists=, state=rijden
- [x] reviewed all states: shots/ui/v720/*.png, shots/ui/v900/*.png, shots/ui/v1440/*.png, shots/ui/final_*.png, rijden*.png, tt_*.png
- [x] final report (also: N8AO licence fixed to ISC in credits)

## Fix round (review findings)
- [x] map holes at De Waag / Accijnstoren / Molen van Piet: footprints.json excludes the panden the
      landmarks module models itself. StaticMap.paintLandmarks(OsmMeta.landmarks) (called from
      minimap.setData + setLandmarks, no integration change) paints every landmark footprint into the
      detail level in MAP_COLORS.landmark (#4b5363, highlighted), re-strokes nearby roads clipped to the
      rings, and refreshes the overview level per region. Verified: shots/ui/fix/zoom2-*.png.
- [x] main menu always reset the start location to De Waag (game.ts passes defaultSpawnId 'waag', which
      overrode the remembered choice). Remembered spawn now wins, defaultSpawnId is the fallback (same
      as the car). Verified: pick Molen van Piet -> Start rit -> __debug.menu() shows Molen van Piet.
