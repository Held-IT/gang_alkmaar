# Traffic module — progress

Owner: Traffic agent. Files: `src/traffic/**`, `src/scenes/dev-traffic.ts`.

## Status: DONE (session 2, polish round) — people react to the player car, BAG-aware walking lines

| file | content |
|---|---|
| `index.ts` | `createTraffic(engine, physics, world, opts?) -> TrafficSystemExt` (setPlayer, setHeadlights, stats, debug) |
| `network.ts` | graph preprocessing: lanes keep right, Bezier connectors, junction clusters, sidewalk validation |
| `paths.ts` | Path polylines (arc length, lazy height profile, curve speeds), offset/connector builders |
| `cars.ts` | AI car sim: IDM, curve speeds, junction reservations, priority rules, kinematic bodies, lights |
| `carRender.ts` | instanced car rendering (merged LOD1/LOD2 parts, shared instanceMatrix, per-instance lights) |
| `parked.ts` | parked cars at props.parkedCars + fixed colliders |
| `people.ts`, `humanMesh.ts` | cyclists + pedestrians sim, procedural animated humans and omafietsen |
| `spatial.ts`, `rng.ts` | spatial hash, deterministic random |

## Behaviour summary
- Cars: right-hand lanes (two-way: width/4 per lane, multi-lane spread), one-way respected, speed
  limit x driver factor, curvature speed (a_lat 2.6), IDM (lane occupancy + junction diverging + cone
  check against player/cars/bikes/walkers), stop lines.
- Junctions: clusters of nodes with car degree >= 3 (< 15 m apart merged, way-split nodes < 10 m
  absorbed). Approach registration (45 m) -> decision near the stop line: no conflicting reservation
  (sampled box paths 2.9 m), exit lane has room, nobody with priority arriving (higher road class,
  else from the right; left turn yields to oncoming), player not in/approaching the box.
  Deadlock breaker: the longest waiter goes. Up to 3 reservations per car (chained junctions);
  reservation handed back when held up > 2.5 s before the stop line.
- Cyclists: cycle tracks (width/4 right) and right edge of car roads (width/2 - 0.75), 15-21 km/h,
  contraflow allowed on residential one-ways; walkers: validated sidewalks (heightAt 0.05..0.4 at
  width/2 + 1.1/1.9/3.0), footways keep right, pedestrian streets spread over the width, pauses.
- Walkers/cyclists proceed when a car is standing still for them; walkers walk around standing
  cars/bikes; patience timers break remaining deadlocks.

## Verification (dev iGPU AMD 7530U, density 1: 40 cars, 60 bikes, 120 walkers)
- 30 s sims: Verdronkenoord 22.7 km/h cars / 15.6 bikes / 4.5 walkers, 0 car-car overlaps, max stuck 1.1 s;
  Kennemersingel 22.9 / 14.2 / 4.6, max stuck 7.1 s; 120 s soaks at Waag and Grote Kerk: 0 errors,
  overlapAvg 0.01, 0 forced junction entries, update 0.25-0.55 ms avg (spikes 2-10 ms on lazy path builds).
- Traffic main pass: 27-52 draw calls, 80-185k triangles; all passes (incl. shadows) +112-128 calls.
- Screenshots: shots/traffic/final_singel_a/b, final_binnenstad_a/b, m_lange_a/b, j_kruis_street1/2,
  b_follow1/2, h_kruis1/3 (top view junction), p_showcase (people close-up), o_headlights.

## Session 2 (polish round)
- Player car vs people (people.ts threat/pickSide/applyOffset/bump/separate): time-to-collision check
  against the player's swept box (exact box when PlayerRef.quaternion is given, else velocity axis).
  After a per-person reaction delay walkers step aside (fast cars: a hop, startled arm pose), cyclists
  brake hard and swerve; escape side = away from the car's centre line unless a facade/quay blocks it
  (canStand: !isInsideBuilding && |heightAt - y| < 0.45). Walkers stepping aside keep ~0.6 m apart.
  Unavoidable contact: kinematic push out of the car box; a hit by the nose/tail deflects the person
  sideways off the bumper (never carried ahead), short stumble (lean + recovery, 0.8-1.4 s), then they
  stroll back onto their path. Offsets are wall/quay-checked every frame (slide along, else stop).
  stats.dodging / stats.bumps count it.
- world.isInsideBuilding (optional WorldExt, via net.insideFn): car-road sidewalks (whole line every
  4 m + 0.35 m shoulder), bike lines (moved toward the centre while clipping), pedestrian-street lateral
  range (freeLat, every 2 m) and NEW: foot-only ways that run through a building (BAG passages,
  indoor ways; >= 3 m or 2 consecutive 1 m samples inside) are not used by walkers (39+9 of 1356 ways).
- AI car lights: brake light when acc < -0.9 or standing, indicators 32 m before a turning junction
  path (blink 0.8 s), hazard lights when stunned/stuck > 12 s — all via the per-instance light bitmask
  (0 extra draw calls); indicator emission raised 9 -> 14 for daylight visibility.
- dev-traffic: ?drive=x,z,heading,kmh[,delay], __debug.lineUp / drive / ram (bumps, inBox, nearBox =
  carried, inBuilding, offQuay); sim() reports peopleInBuildingSamples.
- Verified (dev iGPU): ram tests (15-50 km/h, walkers lined up 3.5-16 m ahead, head-on cyclists):
  0 samples inside the car box, 0 in buildings, 0 off a quay; game ?scene=game&autostart=1&spawn=waag
  driving (KeyW) into lined-up walkers on the Voordam: all step aside, 0 inside the car.
  sim(30) at Langestraat/Voordam and Waag: 0 stuck > 15 s, 0 car-car overlaps (60 s soak too), people in
  buildings 19/91 -> 0/2 samples, update 0.33-0.61 ms avg. Shots: g_ped1/2, g_bump1-3, r_dodge1-4,
  i_blink_row (indicator crop).

## Known issues / next steps
- Traffic lights (props.trafficLights) are not simulated; signalled junctions use priority rules.
- No lane changes / overtaking (also not of a stopped player: AI queues behind it).
- Cyclists waiting > 4 s on crossing standing traffic ghost through (rare brief car-bike overlaps).
- game.ts passes no quaternion to setPlayer: dodge box follows the velocity axis (fine except drifts).
- Lazy path construction can cost a few ms in a single frame when many new streets come into range.

## Session 3 (fix round)
- Parked-car colliders are streamed (parked.ts updateColliders, called from traffic.update with the
  focus): only the 32 m cells within 72 m of the player are in the Rapier world (removed beyond
  72 + 32 m, refresh when the focus moved > 4 m; occupancy change rebuilds the live cells). Rapier
  0.21 maps all collider handles on every world.step, so the old ~1955 city-wide boxes made each
  step ~3x slower and created garbage. Waag: 2649 -> 712 colliders (18 parked live), station 290
  (32 parked); mapNewSoftBodies 0.475 -> 0.20 ms in one session. stats.parkedColliders reports it.
  Verified the player car still stops against parked cars (shots/traffic/fix/parked_hit.png).
- No synchronous renderer.compile any more: createTraffic calls world.warmUp([traffic.root])
  (compileAsync in the variants the frame really uses, against the real scene; fallback
  renderer.compileAsync when the World has no warmUp). All instanced meshes stay visible with
  0 instances (CarRenderer/PeopleSim.holdVisible) until the warm-up resolves, because three only
  compiles visible objects; registering the root also keeps world's 'childadded' warm-up from
  compiling it twice. Game 'hoog': one '[traffic] shaders klaar ... (16 nieuwe programma's)' line,
  no '[world] shaders van traffic' line; after driving, 0 traffic programs unused (gl.useProgram
  hook; the 10 unused programs left belong to PMREM/world/props).
- stats.drawCalls counts only meshes with instances (held meshes are visible with count 0).
