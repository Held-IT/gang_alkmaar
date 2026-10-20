# Materials module — progress

Status: polish round 2 DONE (resumed after a stopped agent). tsc clean.

## Done (predecessor)
- tools/assets/fetch.mjs (ambientCG/Poly Haven download + sharp processing), search.mjs, flat.mjs,
  generate.mjs (water normal map + macro noise texture).
- public/assets/textures/<set>/{color,normal,arm}.jpg for all 17 sets + water + noise; meta.json; credits.json.
- src/world/materials: index.ts (createMaterialLibrary + ext API pbr/metres/setNight/store),
  facade.ts (procedural Dutch facade shader), roofs.ts (roof tiles + backdrop), surfaces.ts
  (generic ground surface shader w/ stochastic anti-tiling + macro), shaderLib.ts, textures.ts,
  water.ts (planar reflections / env, dual normals, fresnel).
- src/scenes/dev-materials.ts: test street (views street|canal|bridge|aerial|facade|far|night|high|props).
- Screenshots up to v8_* in shots/materials/.

## This session
- [x] checked real data (dev-bag view=lib): r1_*/r2_*/r3_* shots
- [x] shaderLib: SKY_OCCLUSION (sSkyOcc/sHorizon/sOppDist): glass reflects a fake facade row across
      the street instead of the open sky; env-only water reflects quay/houses below ~16 deg
- [x] facade: interior mapping (adRoom) for house windows and shops (shelves with goods, downlights)
- [x] facade: landmarks brighter brick + sandstone speklagen, quoins, plinth
- [x] roofs: TEXCOORD_1 eave alignment (+ zinc gutter), muted colour mix (28% anthracite), high-pass de-tiling
- [x] roof_flat: mostly dark bitumen, gravel, sedum
- [x] dev-materials roofs now carry TEXCOORD_1 like BAG roofs
- [x] env-only water (laag/midden): fake reflection of quay + houses (sOppDist 20 m) -> murky canal look
- [x] fewer net curtains (Dutch bare windows), toned-down Renaissance relieving arches
- [x] final shots: shots/materials/final_*.png, r6_*, r7_*, v16_*; 1080p Langestraat 58 fps (iGPU, dev-bag)

## Next steps / notes
- BAG facts: COLOR_0 normalised ubyte (use thresholds); roofs TEXCOORD_1 = (along eave m, up slope m);
  backdrop roofs uv1 = (0,0).

- Possible follow-ups: shop interior variety (only shelves now), klinker moire at 60-100 m,
  roof_tiles texture has baked 0.5 m blotches visible from above (consider another CC0 set).

## Polish round 2 (QA fixes)
- [x] water.ts: mirror camera renders only LAYER_REFLECT (+ sky dome and all lights, auto-enabled every
      120 frames; userData.reflectAlways=true forces an object on). No per-frame allocation (hidden list reused).
      dev-city hoog: verdronkenoord 289 dc/1.81 M -> 242/1.47 M (env-only 189/1.12; pass 100 dc/0.69 M -> 53/0.35 M);
      view=waag 498/3.75 M -> 413/3.08 M. Shots p1_*, p6_*.
- [x] 'Sky-only reflection at the Waag': not a clip/culling bug (oblique near plane verified for reversed and
      classic depth; buildings + bridge are reflected: p6_devmat_canal_hoog, p1_luttik_hoog, p9_game_hoog).
      From a standing camera across the Waagplein canal the 1.5 m quay wall hides the facades physically;
      the missing piece is the quay trees (props owner: canal trees not on LAYER_REFLECT yet). The env-only
      (midden) fake facade reflection made laag/midden look 'fuller'. Far plane 600 vs 900 m: no cost difference.
- [x] facade: landmark walls always seed-varied red-brown brick (BRICK_TINTS 0/2/5), sandstone speklagen on
      ~half the landmarks at 2.2-3.6 m pitch, grey plinth; quoins only where the wall polygon is a real facade
      (smoothstep(2.2, 3.6, facadeWidth)) and below the eave. Shots p2_kerk*, p7_kerk_close, p7_kerkLow.
- [x] roof_tiles -> ambientCG RoofingTiles014A (clean S-pantiles, CC0; credits.json + meta.json updated by
      fetch.mjs). roofs.ts v3: v flipped (lips downhill), TILE_ASPECT, per-tile tone variation (19x11 tiles per
      texture), landmark roofs mostly blue-grey slate. Shots p3_roof_aerial, p3_roof_waagLow.
- [x] klinker moire: SurfaceOptions.antiMoire [start,end] (pixel footprint in m): textureGrad with up to +1
      mip bias + normal fade; on klinkers, parking, bridge_deck, square, sidewalk. Klinkers also get a 4.3 m
      paver-batch variation. Far-pavement Laplacian energy -8..-11 % (p5_kerk7_*, p5_kerkstreet_*).

## Fix round (render fixer, reviewer findings)
- Shop fronts (facade.ts): 7 seeded archetypes with matching interiors: shelves (books/drugstore/gifts),
  clothing rails + dressed mannequin, cafe (wood wainscot, framed pictures, tables/chairs, warm pendant
  lamps), bakery (loaves on shelves + counter with display case), cheese/deli (yellow/orange/black-wax
  wheels + counter), florist (plants + zinc buckets of flowers behind the glass), vacant (bare, dark,
  "TE HUUR" board on the glass). Furniture = a cut-out plane zf metres behind the glass (parallax).
  Signs: real text from a runtime canvas atlas (R8 1024x1472, ~2 MB) of fictional Dutch names per
  archetype (SHOP_NAMES, no brands), centred and scaled to the band, mirrored correctly via tSign,
  analytic textureGrad. Shots: shots/materials/shop_after_*.png, crop_cafe.png, crop_bakery.png,
  shop_forced2.png (TE HUUR). Awnings (zonneschermen) need geometry: not done here.
- textures.ts setAnisotropy: sets TEXTURE_MAX_ANISOTROPY directly on the GL textures (via three's state
  cache) instead of needsUpdate (re-uploaded ~50 maps + mipmaps on every quality switch).
- water.ts: occlusion query (ANY_SAMPLES_PASSED_CONSERVATIVE) around every water draw in the main pass;
  the planar reflection is skipped while no water pixel passed the depth test in the last 3 frames
  (env-only look for the 1-2 frames until it reappears), and refreshed every 2nd frame below ultra (the
  texture keeps its own mirror matrix). Waag hoog: reflection 5.9 -> 3.05 ms GPU avg, 93 -> 51 draws/frame;
  station spawn (canal hidden): 0. Far plane: 300 vs 900 m changed nothing (93 draws / 0.8 M tris either
  way: city chunks are merged super-chunks), so it stays 900 (long canals keep their far reflection).
  Debug: ?wr_far=<m>, ?wr_scale=<0.2..1>.
