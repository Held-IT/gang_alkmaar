# OSM pipeline — progress

Status: DONE (full build in public/data, `node tools/osm/check.mjs` = 0 errors, 0 warnings).

## Commands
- `node tools/osm/fetch.mjs` — Overpass download -> data-raw/osm/{ways,nodes}.json (cached, already done)
- `node tools/osm/build.mjs [--quiet]` — full offline build (~3-4 min on the dev laptop)
- `node tools/osm/build.mjs --props-only` — regenerate roadgraph.json + props.json only (~20 s),
  reuses the ground locator cached by the last full build (data-raw/osm/cache)
- `node tools/osm/build.mjs --only x0,z0,x1,z1 --skip-backdrop` — debug subset (overwrites ground files!)
- `node tools/osm/check.mjs [--quick]` — validation incl. drive test over the collision mesh

## Outputs (final build)
- 99 playable chunks ground_<i>_<j>.glb (i 3..13, j 5..13): 580,507 tris incl. railway (budget 700k)
- ground_backdrop.glb (4 nodes n/s/w/e): 89,200 tris (budget 150k); ground_water.glb 12,369 tris
- collision_ground.bin: 343,194 tris (budget 400k)
- roadgraph.json 2,661 nodes / 3,534 edges; props.json; map2d.json; osm-meta.json

## Session log (continuation)
- props.mjs implemented (OSM + generated: trees, lamps, benches, bins, bollards, bikes, cars,
  RVV signs, traffic lights, street-name signs)
- on-street parking strips from parking:* tags (low 'parking' surface + outer curb)
- clip.mjs piecewise fallbacks -> 0 clip failures (was 5, i.e. holes/overlaps)
- bridges: arch fades laterally and towards other car roads, flat when crossed, touching decks
  share heights; curved decks grid-triangulated (2 m) -> drive test 0 holes / 0 kerbs on all car edges
- check.mjs written; dev-osm markers show orientation
- tools/osm/scratch removed

## Polish round (QA fixes) — DONE (full build, check 0 errors / 0 warnings)
- rail yard: lib/rail.mjs. Ground layer 'rail' (raised 0.12, mat 'ground'): every non-bridge track
  buffered 3 m + filler quads between parallel tracks <= 9.5 m apart. Layer 'platform' (railway=platform
  areas, raised 0.76 m, 'sidewalk' top, 'curb' step faces, white safety line 0.6 m from the track edge).
  On top: per track a ballast bed (trapezoid, +0.2 m, 'ground', in collision), concrete sleepers every
  0.6 m ('bridge_deck') and two rails ('bridge_rail'); on rail bridges sleepers sit on the deck.
  Railway fence (bridge_rail posts + 3 rails, 1.5 m collision wall) along every corridor edge towards
  ordinary land (not tracks/platforms/decks) -> cars cannot get onto the tracks.
- parked cars: whole body (+margin) must be clear of water, sideways nudge on narrow quay strips;
  final safety pass drops every prop over water (bridge decks excepted).
- footprints.mjs + roadgraph: minor car edges whose centre line is >= 50 % inside BAG footprints
  (public/data/footprints.json) -> car=false (foot/bike kept): 11 edges, 202 m (Compagniestraat etc.).
  Generated parked cars only along remaining car edges.
- signs: one-way edges chained per street; one C2 per chain at the exit end (>= 15 m, not on
  roundabouts/slip roads, only if someone can arrive there); D2 on medians of dual carriageways;
  C1 at pedestrian streets, E4 at large public car parks, G5 at woonerf entries, B6/B7 at give-way
  nodes, OSM traffic_sign nodes. 396 signs (343 C2) -> ~222 (97 C2).
- build.mjs `--out <dir>`: test builds into a scratch dir; dev-osm `&data=<url>` loads them
  (e.g. `data=/@fs/C:/.../data-raw/osm/testout/`; in Git Bash set MSYS_NO_PATHCONV=1).
- check.mjs: props over water (not on a bridge) = error; sign mix printed, warn if C2 > 60 %.
- Rail numbers: 117 tracks in the detail area, 10.9 km ballast + 157 m on decks, 18,352 sleepers
  (bridge_deck +~110k tris, bridge_rail incl. fences ~108k). Ballast runs are re-densified to <= 12 m
  segments so every quad lands in the right chunk (max overshoot 8.2 m).
- Fence collision faces OUT of the corridor: the game's trimeshes use FIX_INTERNAL_EDGES = one-sided
  (a wall facing the tracks let the car straight through). Verified: car from the station spawn
  driven at the yard stops at the fence (shots/osm/fence_testA.png). No fences around holes of the yard.
- (fixed in the review round) BAG footprint over the Geestersingel: the BAG pipeline now cuts the
  tagged building passage (tunnel=building_passage), see docs/progress/bag.md.

## Review round (data fixer) — DONE (full build, check 0 errors / 0 warnings)
- Spawn points (lib/meta.mjs): candidates every 2 m on car edges of the main network the PLAYER can
  drive (edges inside the playable rect only), both directions on two-way roads. A spawn needs
  >= 45 m of flush surface straight ahead (+-1 m: no water, quay, kerb, parking strip or BAG
  footprint, via the ground locator). Landmark spawns face their landmark (<= 30 deg, then 50 deg,
  30..170 m) with a free line of sight past the BAG footprints, else the nearest safe spot.
  Result: waag = Luttik Oudorp looking along the canal at the Waag tower (147.6, 75.1); station =
  Stationsweg facing the station (city side, was the north-side pocket); molen faces the mill.
- build.mjs: meta is built before props (spawns/landmarks steer tree clearances); --props-only
  now also rebuilds osm-meta.json (keeps groundFiles of the existing file).
- Tree clearances (lib/props.mjs addTree): molenbiotoop (no trees < 30 m from the Molen van Piet,
  height capped 7 m + 0.1 m/m out to 100 m), none within 12 m of the Accijnstoren / 6 m of the
  Waag, none within 3.5 m of the sightline spawn -> landmark.
- Bridges (lib/bridges.mjs): decks whose head stops short of the bank (OSM way ends on the water
  edge, e.g. Baanbrug, Lyceumbrug) are extended along the axis onto the land (10 decks), so no
  water sliver with a parapet blocks the road.
- Road graph (lib/roadgraph.mjs): connectors. Car roads in the detail margin (playable + 60 m) that
  join parts of the network that are separate inside the playable rect are kept (shortest paths
  only, 15 edges / 832 m): station north side + Bloemwijk + Bergerweg pocket joined for the AI.
  Short open-air tunnels (< 16 m, both ends on ordinary roads, not under tracks; lib/features.mjs)
  are surface roads: the Wognumsebuurt under the station footbridge. Remaining player pockets
  (north of the tracks, 't Hondsbosch behind the car-free Schermerbrug) are real.
- check.mjs: drive test also finds walls/railings across car edges (vertical colliders); spawns
  must be on the main player network and have 40 m straight ahead clear (hole, water, kerb, wall,
  BAG building) — all 6 pass; pockets are listed.
- Verified in-game: Waag spawn + 4 s W stays on the road; Baanbrug, Lyceumbrug, Geestersingel
  passage, Compagniestraat and Wolfpad are drivable (shots/osm/g_*.png, r_*.png).
