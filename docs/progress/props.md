# Props & landmarks — progress

Owner: props module (src/world/props/**, src/world/landmarks/**, public/assets/props/**, src/scenes/dev-props.ts)

## Status: DONE (session 3 polish round finished; tsc clean, 0 console errors)

## Module contents
- util: rng, geom builder (MeshBuilder, sweep, box/cylinder (cylinder base at origin!)), procedural textures,
  propMaterial (wind sway, boat bob, flag wave, lamp glow, traffic-light cycle, foliage tricks),
  PropBatch (instanced, per-cell CPU frustum culling + distance LOD), physics stub
- trees.ts: 5 variants (linde_a/b kind 0, sierboom_a/b kind 1, conifeer kind 2); LOD0 3.2-6.8k tris,
  LOD1 0.6-1.9k, LOD2 impostor atlas (side + top view) 6 tris; treeTextures (canvas leaf atlas + bark)
- street.ts: lanterns, modern lights, bollards, benches, bins, bike racks, traffic lights
- bikes.ts: oma/opa/tassen fiets + bakfiets; signs.ts + signTextures.ts: RVV renderer + blue street-name plates
- boats.ts: sloepen (open / huif) + rondvaartboten along map2d water edges, clustered moorings, avoid bridges
- landmarks: molen.ts (Molen van Piet at osm-meta landmark = BAG centroid), kaasmarkt.ts + siteFinder.ts, flags
- dev scene views lineup / molen / kaas / data (+ synth fallback via dev/synthProps.ts when props.json is empty)

## Session 2 changes
- trees: rounder branches, pipe-model taper, tertiary twigs at LOD0, stronger edge-on card fade
- impostor atlas: side view + top view (horizontal quad, cross-fade by view elevation).
  Bug fixed: renderer.autoClear wiped the atlas between the two viewport renders
- boats: inWater bbox prefilter (createProps 4.9 s -> ~1.3 s), moorings clustered by 70 m value noise
- traffic-light off lenses darkened; molen brick darker/tarred, thatch cap grey-brown; draagberrie handles fixed
- createProps logs '[props] opbouw (ms)' timings once
- verified with the REAL regenerated props.json (22:36): 5429 trees, 1973 lamps, 1830 bikes, 396 signs,
  794 street names ... -> createProps 1.3 s, props 5-45 draw calls / <=200k tris per view, 11708 colliders

## Session 3 (polish round) — hero landmarks, heightAt, compile timings
- NEW landmarks/hero.ts: HeroBuilder (one merged mesh per material: brick / stone / roof / lead / detail,
  MaterialLibrary PBR sets brick_facade, stone, roof_tiles_dark with metric box-projected UVs + vertex
  tint; detail = prop uber material), Facade (extruded walls with real openings), stepped gables,
  gable / pyramid roofs, windows with red-white hourglass shutters, voussoirs, quoins, clock faces,
  octagonal lathes, bells, Alkmaar arms. All hero meshes cast/receive shadows + LAYER_REFLECT.
- NEW landmarks/waag.ts: De Waag on the real BAG footprint (model +x = WNW, +z = Kaasmarkt side,
  rotation.y 2.5536 at (-0.1, 0.33)): chapel nave with buttresses + pointed windows, Renaissance
  front gable (klauwstukken, obelisks, arms, weigh-hall arches with the balance inside), east
  extension, south annexes, tower (clock shaft, balustrade, octagonal louvre stage, lead skirt,
  open carillon lantern with bells, bell-shaped cupola, lantern, spire, ball + vane, top ~47 m).
  5 draw calls, ~38k triangles, 20 box colliders.
- NEW landmarks/accijnstoren.ts: 1622 excise tower at the quay head (rotation 2.5982 at
  (314.46, 329.42)), pyramid roof + octagonal bell lantern + spire, landward lean-to. 5 draw calls.
- BAG: tools/bag/lib/config.mjs EXCLUDED_PANDEN (Waag 0361100000014453, Accijnstoren
  0361100000010548) merged into build.mjs --exclude; rebuilt (14 s), check.mjs OK (0 warnings).
- heightAt: createProps + createLandmarks option heightAt (util/ground.ts safeGround/groundMin);
  every instance AND collider base uses it (trees, lamps, bollards, benches, bins, traffic lights,
  racks, bikes, signs, street-name plates, molen, kaasmarkt (lifted by ground at its centre), heroes).
- dev-props ?view=hero[&hero=accijns]: hero buildings at their real positions on a flat square.
- Measured in the city: Waag 5 draw calls / 39,225 tris, Accijnstoren 5 / 5,420 tris; createLandmarks
  ~180-200 ms; base y from heightAt (both 0.00, molen 0.12). No gaps where the BAG shells were.
- Reflection layer: PropBatch option reflect; trees within 9 m of map2d water go to separate
  '<boom>_waterkant' batches with LAYER_REFLECT (2434 of 5429 trees), all boats too
  (createProps options reflectTrees / reflectBoats, default true). Verdronkenoord ?quality=hoog
  1080p: +7 draw calls, +170k tris, frame time unchanged (16.66 ms, vsync bound on the iGPU).
- Shader compile (ANGLE/D3D11, dev iGPU), cold = every material cache-busted with a random define,
  renderer.compile + KHR_parallel_shader_compile polling (props/dev/compileTest.ts coldCompileProfile):
    midden: props 1.95 s (14 materials), landmarks 0.49 s (17), city 5.7 s (20), whole scene 9.8 s (82)
    hoog:   props 2.1 s, landmarks 0.9 s, city 5.6 s, whole scene 10.3 s
  No program hangs; the 19-minute full-scene hang does NOT reproduce (props/landmarks have no GLSL
  loops, no dynamic indexing, fixed customProgramCacheKey per define set, no per-frame needsUpdate;
  renderer.info.programs stays constant (92) while driving). Hero buildings add only 2 programs
  (textured PBR + vertexColors shared by brick/stone/roof, and lead); detail reuses the prop program.

## Review fix round (world group): perf stand-ins, café terraces, canal variety
- PropBatch (util/batch.ts): per LOD optional `shadowParts` (shadow-only stand-ins, usually the next
  coarser LOD; the main parts then cast nothing) and `reflectParts` (planar-reflection-only stand-ins
  on LAYER_REFLECT; the main parts then stay on layer 0); per part `nearShadow` = nearest cascade
  only. Mechanism: three's shadow pass and colour passes both cull with object.intersectsFrustum(f);
  the shadow pass passes the sun's own cascade frustums, which createProps().update() registers via
  syncShadowFrustums(engine.env.sun). Proxies keep receiveShadow equal to the main part so the shader
  warm-up builds no extra program.
- Used by: trees LOD0 (shadow wood1+leaves0 = 1.6k instead of 6.6k tris, reflection LOD1),
  bikes (cascade 0 only, LOD1 shadow = LOD2 shape), lantern/bollard/bench/bin/rack/traffic light
  (LOD0 shadow = LOD1 shape; small ones cascade 0 only), boats (3 LODs now: 110/250/560 m, LOD0
  shadow+reflection = LOD1, LOD1 reflection = LOD2 ~70-150 tris).
- Measured, game spawn=waag hoog 1280x720 (per-pass hook on renderBufferDirect): props main 423k ->
  172k, shadow 518k -> 116k, reflection 319k -> 29k tris; frame total 3.6 M -> 2.68 M (main 1.41 M,
  shadow 0.84 M, refl 0.44 M), 472 draw calls (unchanged).
- Café terraces (terraces.ts + public/assets/props/terraces.json, generated by
  `node src/world/props/dev/genTerraces.mjs` from OSM amenity=cafe/restaurant/bar/pub/ice_cream nodes,
  outdoor_seating!=no): facade of the café's own BAG footprint, free depth probed against buildings
  (incl. hero footprints), water, carriageways/cycleways, Kaasmarkt rectangle (+4 m) and street
  furniture; squares (free >= 11.5 m) get up to 6.2 m deep terraces, streets <= 3.4 m with a walking
  strip. Bistro tables + 2 chairs facing the street against the wall, four-seat tables further out,
  square parasols (small rotated/scaled ones on narrow strips; none under tree crowns), glass
  windscreens with printed lower panel or planters (buxus). 6 colour schemes (instance colour).
  113 terraces / 682 tables / 1728 chairs / 165 parasols / 475 screens / 93 planters (83 kB).
  One 0.9 m box collider per terrace (car cannot drive through). 6 batches, build 8 ms.
  Spawn points and all carriageway vertices verified clear. Shots: shots/props/terras_*.png.
- Canal life: new boat types bootje (4.3 m polyester, tiller outboard), kruiser (8.6 m steel cabin
  cruiser with Dutch flag), woonark (16 m houseboat on wide water, cladding colour per instance,
  2 meerpalen each) + rondvaartboot hero at the Mient quay (relaxed width rule) + sloep / sloep met
  huif; 10 hull colours, yaw skew +-3-4 deg, lateral offset jitter, irregular gaps (16 % chance of an
  empty berth or two), occasional meerpaal. ~1000 boats (357 sloep, 220 huif, 241 bootje, 160
  kruiser, 4 rondvaart, 18 woonark), 157 posts. Shots: shots/props/boats_*.png, woonboot*.png.

## Known / open
- Minimap (UI) does not draw the excluded hero footprints (bag-meta excludedInfo); world's
  isInsideBuilding now does.
- Terrace layout is offline data: rerun dev/genTerraces.mjs after an OSM/BAG rebuild (it reads the
  Kaasmarkt site as a constant: centre (7, -12.73), rot 0.507, 35.2 x 12.8 m).
- Close-up leaf cards seen at grazing angles from above can still show streaks.
- Street-name atlases (794 names -> 3 atlases) take ~0.4 s to draw at load.
