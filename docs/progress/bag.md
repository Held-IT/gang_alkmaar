# BAG pipeline — progress

Status: DONE. `node tools/bag/build.mjs` (~11 s) + `node tools/bag/check.mjs` = CHECK OK.

## Commands
- `node tools/bag/fetch.mjs` — 3D BAG pages -> data-raw/bag (cached)
- `node tools/bag/build.mjs [--exclude id,...]` — buildings_*.glb, backdrop*.glb,
  collision_buildings.bin, footprints.json, bag-meta.json (persistent exclusions: lib/config.mjs)
- `node tools/bag/check.mjs` — formats, budgets, normals; lists car roads that run into a building
  collision wall (warn > 15)
- Run the OSM build after a BAG change that alters footprints.json (road graph uses it).

## Review round (data fixer)
- Building passages (lib/passages.mjs): OSM car / cycle roads tagged tunnel=building_passage or
  covered=yes under a BAG pand open a passage: convex hull of the road corridors (car roads +1.8 m
  each side, plus parallel untagged carriageways / cycle tracks next to them), limited to the
  footprint grown by 2 m. Walls (render) are cut below the clear height (1 m under the lowest roof,
  max 4.6 m), the passage gets a roof_flat ceiling (normal down) and blank side walls; collision is
  open below the ceiling with double-sided side walls; footprints.json excludes the passage.
  7 passages, incl. the Geestersingel under pand 0361100000105735 (was a solid wall across the road).
- Collision across car roads: footprint edges where the rendered LoD 2.2 shell has no wall down to
  the street (pand 0361100000125124 joins blocks across Compagniestraat / Wolfpad) are left open
  on OSM car carriageways only (199 m). Remaining crossings: Gedempte Baansloot (a real building
  corner, OSM centre line cuts it) and service roads ending in garages.
- Landmarks (Grote Kerk etc.): steep roof faces that come down low (> 50 deg, lowest point < 5 m)
  or are small (> 45 deg, < 5 m2) become tilted walls: removes the dark floating 'M' (roof #730,
  zig-zag buttress caps at the choir) and loose slate triangles on the aisle walls (66 faces).
- Historic gables: narrow (3.5-10 m) pre-1910 street facades with a triangular top (3D BAG splits
  them at the apex: coplanar pieces are clustered first) get a 0.35 m brick parapet profile by seed:
  trapgevel 40 %, halsgevel 25 %, klokgevel 15 %, plain 20 %. 331 gables, +25k triangles.
- Not done (needs other modules): windowless Grote Kerk / Stadhuis facades (landmark facade kind =
  no windows; a hero model or a gothic window mode in the facade shader is needed, then add the
  pand ids 0361100000015852 / 0361100000014540 to EXCLUDED_PANDEN).
