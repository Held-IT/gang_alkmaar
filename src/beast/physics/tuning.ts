// Tuning numbers of the beast controller (beast-physics module). Mutable on purpose so dev scenes
// can tweak them live (window.__debug.tuning). All accelerations are mass-normalised (m/s^2 or
// rad/s^2 per rad), so they hold for every beast scale.
//
// Spellogica deels gebaseerd op gb-rust door muffinmxn, MIT-licentie (state machine, punch/grab
// timings, KO model and "align" torque idea ported from crates/gb_logic/src/actor.rs).

export const BEAST_TUNING = {
  // ------------------------------------------------------------------ body
  gravity: 9.81,
  linearDamping: 0.35,
  angularDamping: 1.2,
  /** extra inertia (heavier, slower rotating parts = jelly feel + stable joints) */
  inertiaTorso: 1.6,
  inertiaLimb: 2.6,
  friction: 0.7,
  footFriction: 0.9,
  koFriction: 0.45,

  // ------------------------------------------------------------------ balance
  /** pelvis height spring (rad/s^2 per m) and damping while grounded */
  hoverK: 140,
  hoverC: 16,
  /** max support acceleration as multiple of g */
  hoverMaxG: 2.2,
  /** share of the support force on the chest (rest on the pelvis) */
  hoverChestShare: 0.42,
  /** extra ground distance beyond the stand height that still counts as grounded */
  groundSlack: 0.3,
  duckHeight: 0.4,
  /** torso tilt / yaw gains */
  torsoTilt: 260,
  pelvisTilt: 220,
  torsoYaw: 75,
  torsoDamp: 13,
  headTilt: 55,
  headYaw: 45,
  headDamp: 5,
  limbDamp: 7,
  /** lean of the torso into the acceleration (rad per m/s^2) */
  lean: 0.035,
  /** sideways roll of the torso toward the stance leg while walking (rad) */
  waddle: 0.16,
  /** pelvis bob while walking (m) */
  bob: 0.035,
  /** idle sway of the torso target (rad) */
  idleSway: 0.035,
  /** arm swing relative to the leg swing */
  armSwing: 1.25,
  /** strength recovery per second (Gang Beasts "applyed force") */
  strengthRecover: 0.5,
  airStrengthCap: 0.6,

  // ------------------------------------------------------------------ locomotion
  walkSpeed: 2.5,
  runSpeed: 4.1,
  duckSpeed: 1.2,
  holdSpeedFactor: 0.75,
  moveGain: 7,
  moveAccel: 11,
  airAccel: 3.5,
  stepBase: 0.9,
  stepPerSpeed: 0.75,
  stepAmpPerSpeed: 0.26,
  stepAmpMax: 0.72,
  legGain: 260,
  armIdleGain: 45,
  armSwingGain: 95,

  // ------------------------------------------------------------------ jump
  jumpV: 4.3,
  jumpFwd: 1.0,
  jumpCooldown: 0.55,

  // ------------------------------------------------------------------ arms / grab / punch
  tapTime: 0.2,
  reachGain: 380,
  reachRange: 1.7,
  handPull: 26,
  guardGain: 300,
  punchWind: 0.07,
  punchStrike: 0.22,
  punchEnd: 0.4,
  punchSpeed: 7.5,
  punchGain: 950,
  punchCooldown: 0.38,
  punchDamage: 8,
  punchDamageExtra: 12,
  grabBreakDist: 0.45,
  /** a held (not lifted) beast whose chest drops this far below the holder's feet slips loose (edge drags) */
  dropRelease: 0.55,
  staminaMax: 100,
  staminaRegen: 40,
  drainBeast: 9,
  drainStatic: 7,
  drainProp: 3,
  hangAssist: 0.55,
  pullUpAccel: 16,

  // ------------------------------------------------------------------ lift / throw
  liftGComp: 0.97,
  liftK: 40,
  liftC: 9,
  liftMaxAccel: 32,
  liftArmGain: 520,
  throwFwd: 5.2,
  throwUp: 3.3,

  // ------------------------------------------------------------------ kick / headbutt
  kickChamber: 0.1,
  kickExtend: 0.28,
  kickEnd: 0.45,
  kickGain: 800,
  kickSpeed: 6.5,
  kickDamage: 10,
  kickDamageExtra: 14,
  kickCooldown: 0.55,
  headbuttWind: 0.1,
  headbuttStrike: 0.28,
  headbuttEnd: 0.45,
  headbuttSpeed: 4.6,
  headbuttDamage: 10,
  headbuttDamageExtra: 14,
  headbuttCooldown: 0.9,

  // ------------------------------------------------------------------ damage / KO
  healthMax: 100,
  healthRegen: 5,
  regenDelay: 1.5,
  koThreshold: 38,
  koBase: 3.2,
  koExtra: 1.5,
  koMax: 9,
  koHitExtend: 0.25,
  koMashReduce: 0.09,
  knockback: 4.2,
  hitStagger: 0.55,
  impactDv: 6.5,
  impactDamage: 7,
  getupRate: 0.45,

  // ------------------------------------------------------------------ water
  /** buoyancy per part (multiple of its weight when fully submerged): the chest floats at the surface */
  buoyancyChest: 2.7,
  buoyancyPelvis: 1.4,
  buoyancyHead: 1.2,
  buoyancyLimb: 0.95,
  buoyancyOut: 0.86,
  waterDrag: 2.6,
  swimSpeed: 1.3,
  swimAccel: 3,
};

export type BeastTuning = typeof BEAST_TUNING;

/** Part multipliers for damage taken (head hits count most). */
export const DAMAGE_MULT: readonly number[] = [0.8, 1.0, 1.7, 0.45, 0.45, 0.45, 0.45, 0.55, 0.55, 0.55, 0.55];
