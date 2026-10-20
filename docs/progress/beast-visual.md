# beast-visual — progress

Status: DONE (session 3). Verified in studio + real city (bg=city), tsc clean.

Design
- Part objects are THREE.Bone (direct children of root); one SkinnedMesh for the body (torso bean
  pelvis+chest+head with smooth weights, limbs = rounded capsules with ball ends at the joints,
  mitten hands, stubby feet), one SkinnedMesh per costume (all items merged, vertex colours +
  per-vertex roughness/metal/sheen/pattern; garments share the torso skin weights).
- Face painted procedurally in the body fragment shader (eyes, lids, brows, mouth, X/spiral KO eyes,
  blush) -> 0 extra draw calls; expressions = uniforms, blinking, pupil saccades.
- Jelly shading: MeshPhysical + sheen + wrap-lighting SSS hack. Jiggle: spring on chest acceleration.
- Costumes: costumeKit.ts (hat frames fitted to the head bean, headCap, revolve, brims, torso panels,
  skirts, limb tubes, shoes, straps, studs) + costumes.ts (10 builders + 'geen').
  Patterns: per-vertex `pmap` (position relative to the piece's axis + arc radius) -> stripes/checks
  wrap limbs; planar mapping on horizontal surfaces; analytic derivatives (no atan seam).

Numbers
- 2 draw calls per beast (+2 shadow); body 7.9k tris; with costume max 19.4k (klederdracht).
- update(): ~0.002 ms per beast. Costume build 6-18 ms once (cached per id/scale/guild);
  prewarmBeastVisuals() builds everything in ~130 ms.

Shots (shots/beast-visual/)
- c3_<costume>.png front, c2b_* back, c2s_* side, p_* poses (punch/kick/fall/ko/cheer/grab),
  p7_ko_close.png (pattern fixes), c3_grid.png, c4_gamecam.png, city_lineup.png, jig1/jig2.png.

Next (optional)
- more costumes; cloth flutter for scarf/apron (currently rigid/torso-skinned).
