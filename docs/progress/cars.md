# Car models module — progress

Owner files: src/vehicle/models/**, src/vehicle/specs.ts, src/scenes/dev-cars.ts

## Status: DONE (session 3, polish round)
All 7 cars (hatchback, stationwagen, stadsauto, sedan, bestelbus, taxi, ev) have their own body
design and read as their class (side/34/rear checked). LOD budgets met, instancing API verified,
`npx tsc --noEmit -p .` clean.

### Triangles per car (LOD0 / LOD1 / LOD2), draw calls 13 / 8 / 8 (session 3)
| car | LOD0 | LOD1 | LOD2 |
|---|---|---|---|
| hatchback | 59.97k | 10.02k | 1.81k |
| stationwagen | 59.32k | 11.51k | 1.89k |
| stadsauto | 48.38k | 9.31k | 1.64k |
| sedan | 59.76k | 10.34k | 1.71k |
| bestelbus | 57.50k | 11.02k | 1.93k |
| taxi | 57.82k | 11.21k | 1.92k |
| ev | 59.10k | 10.23k | 1.82k |
First build of a spec (atlas painting + geometry) ~100-260 ms on the dev iGPU machine; cached after.

## Session 4 log (review fixes)
- Van rear-door windows (pointed sliver between the panes, wedge-shaped outer edges): the rear
  wall rises ~0.8 m within 4 cm of z, so (z, arc) lines and the interpolated gh() table are badly
  distorted there. atlasPaint `rearWallInverter` samples exact greenhouse sections densely and
  inverts rear-wall (x, y) points to (z, arc); windows are now rounded rectangles in wall space
  (9 cm centre pillar, straight vertical shut line). Shots: shots/cars/fix_van_tail_{before,after}.png,
  fix_van_chase.png.
- Torn / folded headlamp corner (hatch menu preview): the lamp wraps over the fender-top roll where
  the surface normal jumps ~45 degrees (roll crease ~10 cm below the shoulder) and even points down
  (nose-corner fold, top 2-3 cm near pSide1+0.15). details.ts `recessMap`: head recess walls, back
  panel, DRL and indicator are extruded along one direction (perimeter-mean normal) instead of the
  local normals; recessWalls now derives wall normals from edge tangent x extrusion direction
  (consistent winding). Shots: fix_hatch_corner{,2}_{before,after}.png, fix_menu_hatch_crop.png.
- Brand faces (Ostwald / Norrvik / Feldhaus looked alike): Norrvik (estate + taxi) gets a
  vertical chrome-slat shield grille (new GrillePattern 'vbars', recess fins + painted LOD1/2
  look), horizontal-slat lower grille, thinner lamps with a C-shaped DRL at the outer end and the
  indicator inside the C; Feldhaus (sport) gets sharper lamp corners, an eyebrow DRL along the
  top edge, smaller projectors below it and the indicator along the lower edge. Ostwald keeps the
  slot grille + big mesh intake + lower-edge DRL. Shot: shots/cars/fix_faces_montage.png.

## Session 3 log (polish round, QA: hatch read as van/saloon, flat painted lamps/grilles)
- LOD 0 recessed units (features.ts Recess/recesses/tailSplitP, clipBand): head/tail lamps, grilles,
  intakes and fog lamps are cut out of the painted body (atlasPaint Painter.cut -> alpha 0, LOD 0
  alpha test only; LOD 1/2 keep the painted look) and rebuilt in details.ts buildRecessUnits:
  housing walls + back panel (dark chrome / red reflector / black), diamond-mesh ribs, slats and
  chrome bars as real fins (fin(): flat per-face normals), clear lens shells (glass bucket, atlas
  patch 'lens' = half glass alpha, via DetailOut.lens merged into the glass geometry in index.ts).
  Lamp internals at LOD 0: raised LED light guides (DRL, tail guides split at the tailgate line),
  projector modules (chrome barrel, dark ring, domed lens on the head channel), brake/indicator/
  reverse chambers at 3/4 depth. Closed (EV) grilles stay painted.
- Hatchback: rear-door window runs back to z -1.22 with a forward-raked rear edge (Golf-like wide
  but not van-sized C-pillar), narrow tailgate glass (BodyDesign.rearGlassHW) framed by body-colour
  pillars, bigger roof spoiler, split wraparound tail lamps (body + tailgate), shorter rear deck,
  bonnet leading edge lowered to 0.738 m with a steeper bonnet, belt/cowl raised ~2 cm, squarer
  nose plan (noseDepth 0.36 / pow 3.7), tumblehome 0.42, slim lamps, slot grille between the lamps,
  big trapezoid lower intake + corner air curtains.
- Lighter windscreen/front side glass, glass opacity 0.74 (darker rear glass).
- Tailgate brand lettering was mirrored (u mapping of centreDecal) - fixed.
- LOD 0 shell: triangles fully inside an atlas cut-out (windows, recesses) are culled
  (index.ts cullCutTriangles, 45-sample barycentric check) - ~2.7k tris and alpha-test overdraw saved.
- Inner tyre sidewall (facing the car) one step per span at LOD 0.

## Session 2 log
- Scratchpad blueprint tool (prof/run.sh <id>): side/front/plan silhouettes vs reference outlines,
  shoulder fold check.
- body.ts: BodyDesign.shoulderInset (fender-top roll -> narrower hood/greenhouse base, side only).
- designs.ts rewritten: designs for all ids + per-class nose/tail sweeps and section profiles;
  BodyDesign.doors (1|2).
- features.ts: three-door support, rear-door window = 2nd window, hood shut line as offset of the
  hood outline, new faces (wide lower grilles, non-kidney sport grille, city smile intake, EV black
  lower bumper), bigger tail lamps, van sliding door data.
- bodyMesh.ts: deck rows clamped instead of skipped (no hood gaps), new LOD densities.
- interior.ts: seats placed from the windscreen base (fixes the city car rear bench).
- wheels.ts: lighter LODs (flat spoke face at LOD1), twisted aero5 rims, darker discs, rim caps.
- materials.ts: paint shader fixed for instanced colours (vColor is vec4 in r186).
- index.ts: getSharedLightsMaterial(state), per-spec traffic decals, per-part triangle stats,
  softer tail/brake emission (saturated red at night).
- atlasPaint.ts: thinner panel gaps, van rear-door windows + sliding door above the belt, EV
  bumper cladding + skid plates, smoked indicators.
- specs.ts: van shortened to L1 (4.90 m, WB 3.0).
- dev-cars.ts: angled-parking row, views face/tail/chase/rclose, ?lights=1 dusk, ?inst=N
  instancing test, build-time stats.

## Known limitations / ideas
- Hood shut line still reads slightly behind the bonnet's leading-edge roll in close-ups; in
  extreme close-ups the hood leading edge and the lamp bottom edge show small alpha-test
  stair-steps (sub-pixel at menu / chase distance).
- The body surface itself folds slightly at the top of the nose corner (normals point down in the
  top 2-3 cm around pSide1+0.15, body.ts lower surface); hidden by the hood edge in normal views.
- Instanced traffic lights: one material per light state (split instances per state).
- CarCategory has no 'crossover': the EV uses 'hatchback' (contracts.ts is orchestrator-owned).

## Notes
- Shot helper: scratchpad/carshots.sh <car> <prefix> "<views>" [extra params]
- Montage/crop helpers: scratchpad/montage.cjs out cols cellW in..., scratchpad/crop.cjs
- dev-cars params: car, spin=0, raw=1, lod, lights, view, paint, steer, inst, atlas.
