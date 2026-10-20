# Alkmaar Drive — Architecture & contracts

A realistic 3D driving game through the historic centre (binnenstad, inside the Singel) of
Alkmaar, the Netherlands. Built with Three.js (WebGL2) + Rapier physics, packaged as a Windows
.exe with Electron. All user-facing text is **Dutch**.

## 1. Goals & hard requirements

* **Looks like the real Alkmaar.** Real street layout, canals and buildings from open data
  (OpenStreetMap, 3D BAG). Recognisable landmarks: De Waag + Kaasmarkt, Grote Kerk
  (Sint-Laurenskerk), Molen van Piet (windmill on the Singel), Accijnstoren, Stadhuis,
  Verdronkenoord / Bierkade / Luttik Oudorp canals, Langestraat, Laat, Mient, Voordam.
* **Realistic graphics**: PBR materials with real CC0 textures, HDRI sky + image based lighting,
  sun shadows, SSAO, subtle bloom, ACES/AgX tone mapping, canal reflections, fog/aerial perspective.
* **Runs on modest Windows hardware**: target 60 fps at 1920x1080 on a GTX 1660 Super (6 GB) with
  quality "hoog". The dev machine has an AMD Ryzen 5 7530U iGPU (~3x slower than a 1660S):
  aim for >= 30 fps there on "midden" and >= 20 fps on "hoog".
* **European cars and design**: fictional European brands (no real trademarks/logos), Dutch yellow
  licence plates (format like `GZ-123-K`), driving on the right, km/h, Dutch road signs (RVV 1990),
  red asphalt cycle paths, brick klinkers, Dutch street-name signs, lots of bicycles.
* **Gameplay**: free roam driving; car selection (several European car types); AI traffic
  (cars, cyclists, pedestrians).

### Performance budget (quality "hoog", 1660S, 1080p)
| item | budget |
|---|---|
| draw calls | <= 700 |
| triangles rendered | <= 2.5 M |
| GPU texture memory | <= 900 MB |
| JS frame time (update) | <= 4 ms |
| initial load | <= 25 s from SSD |

Techniques: merge static geometry per chunk, `InstancedMesh` for repeated props, LOD for cars and
trees, frustum culling per chunk, no per-frame allocations in hot loops, shadow map only around
the player.

## 2. Coordinate system

* Origin = De Waag, RD (EPSG:28992) **x0 = 111866, y0 = 516173** (WGS84 52.6313607, 4.7500868).
* Local metres: `x = RDx - 111866` (east), `y = up` (street level = 0), `z = -(RDy - 516173)`
  (south positive, north = -z).
* RD proj4 string (use in tools):
  `+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs`
* Terrain is treated as **flat** at y = 0. Buildings are placed with their own ground level
  (`b3_h_maaiveld`) mapped to y = 0. Canal water surface at **y = -1.5** (`WATER_LEVEL`),
  canal bed at about y = -3.5. Quay tops at y = 0.
* Area: **playable** rectangle approx. RD x 110700..112480, y 515475..517075 (refined by the OSM
  pipeline so it contains the whole Singel ring + ~80 m margin). Outside it, a **backdrop** ring of
  low-detail buildings (3D BAG LoD1.2) up to ~900 m further, so there is no visible world edge.
  The player is kept inside the playable rect by invisible walls.
* Vehicles: local +z forward, +y up, +x = left. Heading 0 = facing +z (south).

## 3. Directory layout & ownership

Each module has ONE owner. Never edit files owned by someone else; integrate via the contracts in
`src/contracts.ts`. Shared files (`src/contracts.ts`, `src/config.ts`, `src/main.ts`,
`docs/*`, `tools/shot*`, `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`) are owned
by the orchestrator.

| path | owner | purpose |
|---|---|---|
| `tools/osm/**`, `data-raw/osm/**` | OSM pipeline | fetch + process OpenStreetMap |
| `public/data/ground_*.glb`, `collision_ground.bin`, `roadgraph.json`, `props.json`, `map2d.json`, `osm-meta.json` | OSM pipeline | outputs |
| `tools/bag/**`, `data-raw/bag/**` | BAG pipeline | fetch + process 3D BAG |
| `public/data/buildings_*.glb`, `backdrop*.glb`, `collision_buildings.bin`, `footprints.json`, `bag-meta.json` | BAG pipeline | outputs |
| `tools/assets/**`, `public/assets/textures/**`, `public/assets/credits.json` | Materials | CC0 PBR textures |
| `src/world/materials/**` | Materials | MaterialLibrary, facade shader, water |
| `src/core/**` (except `input.ts`), `tools/engine/**`, `public/assets/hdri/**` | Engine | renderer, post-processing, environment (HDRI sky), quality |
| `src/physics/**`, `src/vehicle/physics/**`, `src/camera/**`, `src/core/input.ts`, `src/audio/**` | Vehicle | Rapier world, vehicle dynamics, cameras, input, sound |
| `src/vehicle/models/**`, `src/vehicle/specs.ts` | Car models | procedural European cars + specs |
| `src/world/props/**`, `src/world/landmarks/**`, `public/assets/props/**` | Props | trees, lamps, bikes, signs..., windmill, boats etc. |
| `src/world/*.ts` (top level), `src/world/loaders/**` | World | loads data, assembles the city |
| `src/traffic/**` | Traffic | AI cars, parked cars, cyclists, pedestrians |
| `src/ui/**` | UI | menus, HUD, minimap, settings, loading screen |
| `src/scenes/game.ts`, `src/game/**`, `electron/**`, `tools/package.mjs` | Integration | final game scene, packaging |
| `src/scenes/dev-<module>.ts` | that module | dev/test scene for the module |

## 4. Data pipeline outputs (`public/data/`)

Run with `node tools/osm/build.mjs` and `node tools/bag/build.mjs` (each also has a `fetch` step
that caches raw downloads in `data-raw/`). Pipelines are deterministic and re-runnable.

### 4.1 GLB conventions (both pipelines)
* glTF 2.0 binary, written with `@gltf-transform/core`. Units metres, local coords (section 2).
* **Material name = `MaterialClass`** (see `src/contracts.ts`). The runtime ignores the material's
  parameters and substitutes the real material, so in the GLB just give a flat debug colour.
* One mesh per material per chunk (geometry merged). Indices uint32. Node name = chunk id.
* `TEXCOORD_0` = metric UVs (1 unit = 1 metre):
  * horizontal surfaces (roads, squares, roofs, water): `u = x`, `v = z` (world metres).
  * vertical surfaces (walls, quays, curbs, bridge sides): `u` = distance along the wall (m,
    continuous around a facade polygon), `v` = height above street level (m, i.e. y).
* `NORMAL` always present. `COLOR_0` only where specified below.

### 4.2 Buildings (`buildings_<i>_<j>.glb`, BAG pipeline)
* Source: 3D BAG API `https://api.3dbag.nl/collections/pand/items?bbox=...` (CityJSONFeature,
  LoD 2.2 geometry; LoD 1.2 for backdrop). Licence CC BY 4.0, "© 3D BAG by tudelft3d and 3DGI".
* Chunk grid 200 m x 200 m, `i = floor((x + 2000)/200)`, `j = floor((z + 2000)/200)`.
* Primitives (materials): `wall`, `roof_slanted`, `roof_flat`. Skip ground surfaces.
* Vertical position: `y = z_NAP - b3_h_maaiveld` of that building; extend walls down to y = -0.3
  so there are no gaps with the street.
* **Wall vertex attributes** (consumed by the facade shader in `src/world/materials`):
  * `TEXCOORD_0` = (u along facade in metres, v = height above street in metres)
  * `TEXCOORD_1` = (facadeWidth m, eaveHeight m) of the wall polygon this vertex belongs to.
    `eaveHeight` = min top height of the polygon (above it is the gable triangle).
  * `COLOR_0` (RGBA, float or normalised ubyte):
    * `r` = building style seed, uniform random in [0,1) from a hash of the BAG pand id
    * `g` = facade kind: `0.0` normal street facade (windows), `0.5` party / blank wall (wall
      shared with or touching a neighbour footprint, or very narrow faces < 1.2 m: no windows),
      `1.0` landmark (church/Waag etc.: stone/brick without procedural windows)
    * `b` = age class from `oorspronkelijkbouwjaar`: `0.0` <= 1850, `0.33` 1851–1940,
      `0.66` 1941–1990, `1.0` > 1990
    * `a` = typical floor height hint, `(floorHeight - 2.5) / 2` (floorHeight from
      `b3_bouwlagen` if present, else 3.2 for old, 2.9 for modern)
* Roofs: `TEXCOORD_0` = (x, z) world; `COLOR_0` same as walls (r used for tile colour variation).
* `backdrop_*.glb`: LoD 1.2 extrusions for the ring outside the playable rect, single material
  `backdrop` with `COLOR_0` (r = seed), simplified, no wall UV requirements beyond 4.1.
* `collision_buildings.bin`: simplified building collision (LoD 1.2 walls only, no roofs needed,
  only buildings inside the playable rect).
* `footprints.json` (`Footprints`): simplified outer rings for the minimap.
* `bag-meta.json` (`BagMeta`).

### 4.3 Ground (`ground_<i>_<j>.glb`, OSM pipeline)
* Source: Overpass API (`https://overpass-api.de/api/interpreter`, send a `User-Agent` header,
  e.g. `AlkmaarDrive/0.1`). Licence ODbL, "© OpenStreetMap-bijdragers".
* Same chunk grid as buildings. Materials (one primitive each, only those present):
  `asphalt`, `klinkers`, `sidewalk`, `square`, `curb`, `bikelane`, `grass`, `quay`, `quay_cap`,
  `bridge_deck`, `bridge_side`, `bridge_rail`, `road_marking`, `parking`, `canal_bed`, `ground`,
  and `water` (flat at y = WATER_LEVEL, may be one big mesh, UV = world xz).
* Layout rules:
  * Everything that is not road/water/grass/building is pavement (`sidewalk`/`square`) at
    y = 0.12 (sidewalk height). Car roads are at y = 0 with `curb` faces between road and
    sidewalk (12 cm). Pedestrian streets / squares (Langestraat, Kaasmarkt) are flush at y = 0.
  * Road surface by OSM `surface`: `asphalt` → asphalt; `paving_stones`, `sett`, `bricks`,
    `cobblestone`, unknown in the binnenstad → `klinkers`. Cycleways with asphalt → `bikelane`
    (red). Roads get widths from `width`/`lanes`/type defaults.
  * Water polygons are holes in the ground; their edges get `quay` walls from y = 0 down to
    y = -3.5 plus a `quay_cap` strip (0.3 m wide, 0.05 m high) — except natural banks along
    parks/grass, which slope down (grass) to the water.
  * Bridges (`bridge=yes` roads over water): deck at y = 0 (optionally a gentle arch up to
    +0.6 m in the middle for short canal bridges), `bridge_side` parapet/body down to the water,
    `bridge_rail` railings.
  * `road_marking`: white lines on asphalt car roads (dashed centre lines on two-way roads with
    >= 6 m width, edge lines on main roads), zebra crossings (`crossing=zebra`), shark teeth
    (haaientanden) where minor roads meet main roads. Raised 1 cm above the road.
* `collision_ground.bin`: drivable static surfaces (roads, sidewalks with curb steps, squares,
  bridge decks, quay walls, canal beds, bridge parapets). Water itself has no collider (cars that
  fall in end up on the canal bed).
* `roadgraph.json` (`RoadGraph`): directed-capable graph of car roads, cycleways and footways
  inside the playable rect. Nodes at intersections + endpoints only; edge `pts` keeps the shape.
* `props.json` (`PropsData`): OSM nodes (trees, street lamps, benches, bollards, bicycle
  parking, traffic signs, traffic signals, waste baskets) PLUS generated plausible placements
  where OSM is sparse: lamps every ~25–30 m along streets (historic lanterns `kind 0` in the
  binnenstad, modern `kind 1` on the singels/main roads), trees along canal quays (every ~9 m
  where OSM has tree rows or the quay is not a road), parked bikes near bicycle parking and along
  canal railings, street-name signs at intersections, C2/C1 one-way signs at oneway entries,
  parked cars along singel roads with `parking:*` tags.
* `map2d.json` (`Map2D`), `osm-meta.json` (`OsmMeta`, incl. `spawnPoints` such as `waag`,
  `grote_kerk`, `station`, `molen`, `singel`, and `landmarks` positions from OSM names).

### 4.4 Binary collision format (`*.bin`)
Little endian: `uint32 vertexCount, uint32 indexCount, float32[vertexCount*3] positions,
uint32[indexCount] indices`. Triangles, world coordinates.

## 5. Runtime modules

All interfaces in `src/contracts.ts`. Factory functions (exact names, used by integration):

| module | factory |
|---|---|
| `src/core/engine.ts` | `createEngine(canvas): Promise<Engine>` |
| `src/core/input.ts` | `createInput(engine): InputController` with `read(): VehicleInput` (keyboard WASD/arrows, Space handbrake, R reset, L lights, H horn, C camera, Esc pause; Xbox gamepad) |
| `src/physics/physics.ts` | `createPhysics(): Promise<PhysicsWorld>` |
| `src/vehicle/specs.ts` | `CAR_SPECS: CarSpec[]`, `getSpec(id)` |
| `src/vehicle/models/index.ts` | `createCarModel(specId, opts?: CarModelOptions): CarModel`, `randomDutchPlate(): string` |
| `src/vehicle/physics/vehicle.ts` | `createPlayerVehicle(engine, physics, spec, model): PlayerVehicle` |
| `src/camera/cameraController.ts` | `createCameraController(engine, target: PlayerVehicle, physics?)` with modes chase / bumper / hood / orbit, `cycleMode()` |
| `src/audio/vehicleAudio.ts` | `createVehicleAudio(vehicle: PlayerVehicle)` (WebAudio synthesis: engine, tyres, impacts, horn) |
| `src/world/materials/index.ts` | `createMaterialLibrary(engine): Promise<MaterialLibrary>` |
| `src/world/props/index.ts` | `createProps(engine, physics, materials, props: PropsData): { root: THREE.Group; update(dt, camPos) }` |
| `src/world/landmarks/index.ts` | `createLandmarks(engine, physics, materials, meta: OsmMeta): { root: THREE.Group; update(dt, camPos) }` |
| `src/world/world.ts` | `loadWorld(engine, physics, onProgress?): Promise<World>` |
| `src/traffic/index.ts` | `createTraffic(engine, physics, world: World): TrafficSystem` |
| `src/ui/index.ts` | `createUI(engine): GameUI` (loading screen, main menu + car select, HUD, minimap, pause/settings, credits) |

### Water reflection layer
Planar water reflections render only objects on render layer `LAYER_REFLECT` (src/config.ts):
world enables it on buildings/ground/backdrop near water, landmarks on hero models, props on canal
trees and boats. Small props, traffic and people stay off it (performance).

### Facade shader (materials module)
`wall` is a `MeshStandardMaterial` patched with `onBeforeCompile` that uses the wall attributes
(4.2) to draw a Dutch brick facade with procedural windows: windows per floor, white painted
frames, glazing bars on old buildings, dark reflective glass (env-map reflections), shop windows
on the ground floor of street facades, only small attic windows in gable triangles (above
`eaveHeight`), blank `g = 0.5` party walls, brick colour/tint variation by `r`, some white
plaster/stucco facades. Base brick from a real CC0 texture (u, v in metres).

## 6. Scenes, testing and verification

* Scenes: `src/scenes/<name>.ts`, choose with `?scene=<name>`; default `game`.
  Each module owner makes `src/scenes/dev-<module>.ts` to test their work in isolation.
  `src/dev/devCamera.ts` gives an orbit camera with `?cam=x,y,z&look=x,y,z` and
  `window.__debug.setCam(...)`.
* When loaded, a scene sets `window.__ready = true`.
* **Visual verification is mandatory**: use the screenshot tool and LOOK at the PNG (Read tool):
  ```
  node tools/shot.mjs --scene dev-cars --params "car=hatchback" --out shots/cars/hatch.png
  ```
  It prints `[console.error]` lines and a final `SHOT_RESULT {...}` with fps, draw calls and
  triangles. Use `--steps steps.json` for several shots in one run. Put screenshots in
  `shots/<module>/`. Several instances can run at the same time.
* Type check: `npx tsc --noEmit -p .` must pass (strict mode).
* Optional cross-module imports (a module another agent is still writing): use
  `import.meta.glob('../path/to/module.ts')` and fall back to a placeholder when it is missing.
* Never run `npm install` (shared node_modules; parallel installs corrupt it). Installed:
  three 0.186 (+ examples/jsm addons), @dimforge/rapier3d-compat, postprocessing, n8ao, vite,
  typescript, electron, @electron/packager, @gltf-transform/{core,functions,extensions},
  proj4, earcut, polygon-clipping, sharp, rbush, meshoptimizer. Need something else? Write it
  yourself or report it.
* three r186 notes: `THREE.Clock` is deprecated (use `THREE.Timer`), `PCFSoftShadowMap` is gone
  (use `PCFShadowMap`/`VSMShadowMap`). WebGLRenderer + `onBeforeCompile` patches are fine.

## 7. Alkmaar / Dutch realism checklist
* Narrow brick streets with klinkers, canal houses with gables (trapgevels, halsgevels,
  tuitgevels), white window frames, dark green or black shutters/doors, shop fronts on ground
  floors, many parked bicycles (black "omafietsen"), Amsterdammertje-style bollards
  (dark brown/red), historic green/black lanterns, canal railings, trees (linden/elms) along
  canals, boats moored in canals (optional), the Waag tower with carillon on the Kaasmarkt,
  cheese porters' area, red-white-red Alkmaar flag details, blue street-name signs with white
  text, RVV road signs, red cycle lanes, yellow licence plates, overcast/partly cloudy Dutch sky.
