# beast-physics progress

Status: DONE (verified in dev arena + real city; further tuning possible via BEAST_TUNING)

Files: src/physics/physics.ts (GROUP.BEAST slots, beastGroups, SOLVER_ITERATIONS=4),
src/beast/rig.ts (+BEAST_MASS, BEAST_STAND_HEIGHT, BEAST_HAND_TIP, BEAST_FOOT_TIP; lower legs moved
so feet rest at y=0), src/beast/physics/{index,beast,tuning,fallbackVisual}.ts, src/scenes/dev-beast.ts.

Done (measured in dev-beast, fallback visuals):
- stand/walk 2.38 m/s / run 3.9 m/s, turn 90 deg in 0.4 s, max torso tilt ~15 deg
- punch: 5 hits -> KO in ~3 s of jabbing; KO 3.2 s (+1.5 s per recent KO), get-up ~1 s
- grab beast (both hands) + drag KO'd beast 3.7-4.4 m in 4 s
- lift over head + throw off the platform -> splash (throw ~5-8 m incl. 3 m drop)
- ledge: jump, grab wall, hold jump to pull up, roll on top (1.8 s)
- water: splash event, chest floats at the surface, paddling
- fall 4 m: lands, recovers in ~1.1 s
- perf 6 beasts brawling: controller 0.5-0.6 ms, physics step total ~2.3 ms/frame (2 sub-steps)

- kick 6/6 hits -> KO 4.8 s, headbutt 6/6 -> KO 6.3 s; real src/beast/visual jelly meshes sync fine
- city=1: spawn on the quay near De Waag, walk into the canal -> splash, floats head above water

Next (optional): balance damage vs. bots, more idle wobble.
Tests: node tools/shot.mjs --scene dev-beast --params "test=<walk|punch|ko|grab|drag|throw|ledge|water|fall|perf>&visual=fallback" ...
(scripts start at __ready; sim time can lag wall time on the first seconds -> use long waits)

## API notes (for bots / arenas / game-flow)
- `createBeastSystem(engine, physics, { world?, visual?: 'auto'|'fallback' })` -> BeastSystemExt
  (beasts: BeastImpl[], spawn -> BeastImpl, waterLevel, setWaterQuery(fn), beastOfCollider(h),
  perf {controllerMs, readMs, syncMs}, visualSource, setKoStars(bool), tuning (= BEAST_TUNING)).
- Scene loop: physics.step(dt) at priority 10, then system.update(dt) (visual sync) e.g. priority 20.
- BeastImpl extras: mode ('stand'|'walk'|'run'|'duck'|'jump'|'fall'|'climb'|'ko'|'getup'|'swim'|'out'),
  strength, health, stamina, grounded, groundY, koTime, koFraction, inWater, heldBy (ids),
  heldBeast, isLifting, isAttacking, input, parts[] (pos/quat/lin/ang per part, index order of
  BEAST_PARTS), bodies (Record<part, RigidBody>), totalMass, slot, scale, visual,
  partVelocity(), handPosition(), nearestEnemy(range, minDot), surfaceBelow(p, maxD),
  knockOut(s?), push(dv, stun?), applyImpulse(part, J), translate(d), expressionOverride.
- Collision: GROUP.BEAST = 0x0FF0 (8 slot bits), beastGroups(slot), COLLISION_GROUPS.hazard for
  kinematic hazards (membership STATIC), COLLISION_GROUPS.prop for dynamic props.
