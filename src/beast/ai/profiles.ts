// Difficulty profiles of the bots (bots module). All times in seconds, distances in metres.
// makkelijk = slow, clumsy, forgiving; normaal = lively brawler; moeilijk = quick, accurate, mean.
import type { BotDifficulty } from '../../brawl/contracts';

export interface BotProfile {
  /** think interval (= reaction delay to new situations), randomised +-30 % */
  think: number;
  /** extra delay before reacting to a hazard / being grabbed */
  react: number;
  /** lateral aim error while approaching (fraction of the distance, capped at 1 m) */
  aimError: number;
  /** chance per think to really commit to an attack when in range (else hesitate / reposition) */
  aggression: number;
  /** time between punches of a combo, and the pause after a combo */
  punchInterval: number;
  comboMin: number;
  comboMax: number;
  comboPause: number;
  /** punch range jitter: the bot starts punching at 0.95..(0.95 + this) m chest distance */
  rangeSloppiness: number;
  /** punch range start (m, chest to chest; a longer reach = a bigger lunge = harder punch) */
  rangeBase: number;
  /** keep at least this distance while punching (step back when closer) */
  minRange: number;
  /** own balance (strength 0..1) needed to throw a punch; below it the bot backs off to recover */
  strengthGate: number;
  /** relative weights of the attack patterns when in range */
  wJab: number;
  wGrabPunch: number;
  wKick: number;
  wHeadbutt: number;
  wDropKick: number;
  /** chance to go for grab + carry + throw when the target is knocked out */
  grabUse: number;
  /** max seconds of carrying before throwing anyway */
  maxCarry: number;
  /** keep one hand free to punch the victim while dragging (keeps it knocked out) */
  dragPunch: boolean;
  /** lift duration before the throw */
  liftHold: number;
  /** base safety distance to drops (scaled by the arena size) */
  edgeMargin: number;
  /** chance to back away from a drop when attacked near it */
  edgeCaution: number;
  /** chance to notice a hazard (rolled per hazard event) and how far ahead it looks (s) */
  hazardSkill: number;
  hazardLook: number;
  /** chance to grab the ledge when falling off, and to pull up when hanging */
  climbSkill: number;
  /** KO button mashing (presses per second) */
  mash: number;
  /** chance to struggle (punch / pull away) while being held */
  struggle: number;
  /** runs to far targets */
  run: boolean;
  /** target choice: bonus (m) for the human, pile-up penalty per extra bot on the same target */
  humanBias: number;
  pilePenalty: number;
  /** max bots on the human at the same time before a big penalty (Infinity = no limit) */
  humanCap: number;
  /** bonus (m) for targets close to a drop / knocked out / weak */
  edgeOpportunism: number;
  koBonus: number;
  /** silly behaviour (taunts, cheese throwing) chance per idle think */
  silly: number;
  /** chance to hang back (lurk) when the target is in a pile-up of 2+ other awake beasts */
  pileAvoid: number;
  /** bonus (m) per missing 100 % health of a target (finish off the weak) */
  weakBonus: number;
  /** chance to approach from the inward side (the target ends up between me and the drop) */
  edgeControl: number;
  /** chance to side-step an incoming punch / kick */
  evade: number;
}

export const BOT_PROFILES: Record<BotDifficulty, BotProfile> = {
  makkelijk: {
    think: 0.5,
    react: 0.45,
    aimError: 0.35,
    aggression: 0.55,
    punchInterval: 0.48,
    comboMin: 1,
    comboMax: 3,
    comboPause: 1.0,
    rangeSloppiness: 0.6,
    rangeBase: 0.9,
    minRange: 0,
    strengthGate: 0,
    wJab: 1,
    wGrabPunch: 0.25,
    wKick: 0.35,
    wHeadbutt: 0.15,
    wDropKick: 0.1,
    grabUse: 0.7,
    maxCarry: 6,
    dragPunch: false,
    liftHold: 0.7,
    edgeMargin: 1.1,
    edgeCaution: 0.55,
    hazardSkill: 0.45,
    hazardLook: 1.0,
    climbSkill: 0.45,
    mash: 2,
    struggle: 0.35,
    run: false,
    humanBias: 0,
    pilePenalty: 2.5,
    humanCap: 1,
    edgeOpportunism: 0.5,
    koBonus: 2,
    silly: 0.3,
    pileAvoid: 0,
    weakBonus: 0.5,
    edgeControl: 0,
    evade: 0,
  },
  normaal: {
    think: 0.3,
    react: 0.25,
    aimError: 0.18,
    aggression: 0.75,
    punchInterval: 0.34,
    comboMin: 2,
    comboMax: 3,
    comboPause: 0.8,
    rangeSloppiness: 0.35,
    rangeBase: 1.0,
    minRange: 0.6,
    strengthGate: 0.3,
    wJab: 1,
    wGrabPunch: 0.6,
    wKick: 0.45,
    wHeadbutt: 0.3,
    wDropKick: 0.2,
    grabUse: 0.85,
    maxCarry: 6,
    dragPunch: false,
    liftHold: 0.55,
    edgeMargin: 0.9,
    edgeCaution: 0.8,
    hazardSkill: 0.8,
    hazardLook: 1.4,
    climbSkill: 0.75,
    mash: 4.5,
    struggle: 0.7,
    run: true,
    humanBias: 1.5,
    pilePenalty: 1.5,
    humanCap: 2,
    edgeOpportunism: 1.5,
    koBonus: 3,
    silly: 0.15,
    pileAvoid: 0.3,
    weakBonus: 2,
    edgeControl: 0.3,
    evade: 0.15,
  },
  moeilijk: {
    think: 0.17,
    react: 0.1,
    aimError: 0.06,
    aggression: 0.95,
    punchInterval: 0.23,
    comboMin: 3,
    comboMax: 6,
    comboPause: 0.35,
    rangeSloppiness: 0.15,
    rangeBase: 1.12,
    minRange: 0.85,
    strengthGate: 0.62,
    wJab: 1,
    wGrabPunch: 1,
    wKick: 0.5,
    wHeadbutt: 0.45,
    wDropKick: 0.35,
    grabUse: 1,
    maxCarry: 8,
    dragPunch: true,
    liftHold: 0.5,
    edgeMargin: 0.75,
    edgeCaution: 0.95,
    hazardSkill: 0.95,
    hazardLook: 1.8,
    climbSkill: 0.95,
    mash: 7.5,
    struggle: 0.95,
    run: true,
    humanBias: 3,
    pilePenalty: 0.8,
    humanCap: 3,
    edgeOpportunism: 2.5,
    koBonus: 4,
    silly: 0.07,
    pileAvoid: 0.75,
    weakBonus: 4,
    edgeControl: 0.9,
    evade: 0.45,
  },
};
