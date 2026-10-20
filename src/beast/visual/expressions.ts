// Facial expressions: target parameter sets + an animator that blends towards the target, blinks,
// lets the pupils wander and wobbles the mouth. Writes into the body material's face uniforms.
import type { BeastExpression } from '../../brawl/contracts';
import type { BeastUniforms, FaceUniforms } from './materials';

export interface FaceParams {
  openTop: number;   // 0 = eye fully open at the top, 1 = lid down to the bottom
  openBot: number;   // bottom lid raised (0 = none)
  lidTilt: number;   // + = inner corner lower (angry), - = outer corner lower (sad)
  pupil: number;     // pupil size factor
  eyeScale: number;  // sclera size factor
  browY: number;     // brow offset (head radii)
  browAng: number;   // + = inner end down (angry), - = inner end up (worried)
  browAlpha: number;
  mouthCurve: number; // + smile, - frown
  mouthOpen: number;
  mouthW: number;
  wobble: number;
  xEyes: number;
  spiral: number;
  arcs: number;
  blush: number;
  teeth: number;
  tongue: number;
  mouthUpper: number; // 0 = D-shaped open mouth, ~1 = round O
}

const BASE: FaceParams = {
  openTop: 0.1, openBot: 0, lidTilt: 0, pupil: 1, eyeScale: 1, browY: 0, browAng: 0.05, browAlpha: 1,
  mouthCurve: 0.45, mouthOpen: 0, mouthW: 0.62, wobble: 0, xEyes: 0, spiral: 0, arcs: 0, blush: 0,
  teeth: 0, tongue: 0, mouthUpper: 0,
};

export const EXPRESSIONS: Readonly<Record<BeastExpression | 'koSpiral', FaceParams>> = {
  neutral: { ...BASE },
  angry: {
    ...BASE, openTop: 0.3, openBot: 0.1, lidTilt: 0.85, pupil: 0.9, browY: -0.07, browAng: 0.62,
    mouthCurve: -0.55, mouthOpen: 0.42, mouthW: 0.9, teeth: 1, mouthUpper: 0.25,
  },
  hurt: {
    ...BASE, openTop: 0.42, openBot: 0.22, lidTilt: -0.55, pupil: 0.85, browY: 0.04, browAng: -0.6,
    mouthCurve: -0.75, mouthOpen: 0.22, mouthW: 0.75, wobble: 1, mouthUpper: 0.2,
  },
  ko: {
    ...BASE, xEyes: 1, browAlpha: 0, mouthCurve: -0.25, mouthOpen: 0.42, mouthW: 0.7, wobble: 0.5, tongue: 1, mouthUpper: 0.35,
  },
  koSpiral: {
    ...BASE, spiral: 1, browAlpha: 0, mouthCurve: -0.15, mouthOpen: 0.3, mouthW: 0.6, wobble: 0.9, tongue: 0.8, mouthUpper: 0.5,
  },
  happy: {
    ...BASE, arcs: 1, browY: 0.07, browAng: -0.12, mouthCurve: 1, mouthOpen: 0.75, mouthW: 0.95, blush: 0.75, tongue: 0.9,
  },
  scared: {
    ...BASE, openTop: 0, eyeScale: 1.2, pupil: 0.5, browY: 0.12, browAng: -0.45, mouthCurve: 0.05, mouthOpen: 0.85,
    mouthW: 0.42, mouthUpper: 1, wobble: 0.35,
  },
};

const KEYS = Object.keys(BASE) as (keyof FaceParams)[];
/** Discrete parameters switch quickly, continuous ones blend. */
const FAST = new Set<keyof FaceParams>(['xEyes', 'spiral', 'arcs']);

export class FaceAnimator {
  readonly cur: FaceParams = { ...BASE };
  private target: FaceParams = EXPRESSIONS.neutral;
  expression: BeastExpression = 'neutral';
  /** Extra blush added by the costume (sunburnt tourist). */
  blushBias = 0;
  koStyle: 'x' | 'spiraal' = 'x';
  private blinkT = 0;
  private nextBlink = 1.5;
  private blinking = 0; // 0..1 phase
  private lookT = 0;
  private lookX = 0;
  private lookY = 0;
  private lx = 0;
  private ly = 0;
  private time = 0;
  private rnd: () => number;

  constructor(seed: number) {
    let s = (seed * 2654435761) >>> 0 || 1;
    this.rnd = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return (s >>> 0) / 4294967296;
    };
    this.nextBlink = 0.8 + this.rnd() * 3;
  }

  set(e: BeastExpression): void {
    this.expression = e;
    this.target = e === 'ko' && this.koStyle === 'spiraal' ? EXPRESSIONS.koSpiral : EXPRESSIONS[e] ?? EXPRESSIONS.neutral;
  }

  /** Jump to the target immediately (e.g. for screenshots / first frame). */
  snap(): void {
    for (const k of KEYS) this.cur[k] = this.target[k];
  }

  update(dt: number, fu: FaceUniforms, bu: BeastUniforms): void {
    const d = Math.min(dt, 0.1);
    this.time += d;
    const kSlow = 1 - Math.exp(-d * 14);
    const kFast = 1 - Math.exp(-d * 30);
    for (const k of KEYS) this.cur[k] += (this.target[k] - this.cur[k]) * (FAST.has(k) ? kFast : kSlow);

    // blinking (not with special eyes or squeezed-shut happy eyes)
    const canBlink = this.cur.xEyes + this.cur.spiral + this.cur.arcs < 0.1;
    this.blinkT += d;
    if (this.blinking > 0) {
      this.blinking += d / 0.16;
      if (this.blinking >= 1) this.blinking = 0;
    } else if (this.blinkT > this.nextBlink && canBlink) {
      this.blinking = 1e-3;
      this.blinkT = 0;
      // sometimes a double blink
      this.nextBlink = this.rnd() < 0.15 ? 0.25 : 1.6 + this.rnd() * 3.4;
    }
    const b = this.blinking > 0 ? Math.sin(Math.PI * this.blinking) : 0;

    // pupils: small saccades, scared eyes dart around faster
    this.lookT -= d;
    if (this.lookT <= 0) {
      const scared = this.expression === 'scared';
      this.lookT = scared ? 0.25 + this.rnd() * 0.4 : 0.8 + this.rnd() * 2.2;
      const amp = scared ? 0.9 : 0.45;
      this.lookX = (this.rnd() * 2 - 1) * amp;
      this.lookY = (this.rnd() * 2 - 1) * amp * 0.5;
      if (this.rnd() < 0.4 && !scared) { this.lookX = 0; this.lookY = 0; }
    }
    const kl = 1 - Math.exp(-d * 25);
    this.lx += (this.lookX - this.lx) * kl;
    this.ly += (this.lookY - this.ly) * kl;

    const c = this.cur;
    const top = Math.max(c.openTop, 0.62 * b);
    const bot = Math.max(c.openBot, 0.4 * b);
    fu.uFaceA.value.set(top, bot, c.lidTilt, c.pupil);
    fu.uFaceB.value.set(c.eyeScale, c.browY, c.browAng, c.browAlpha);
    fu.uFaceC.value.set(c.mouthCurve, c.mouthOpen, c.mouthW, c.wobble);
    fu.uFaceD.value.set(c.xEyes, c.spiral, c.arcs, Math.min(1, c.blush + this.blushBias));
    fu.uFaceE.value.set(c.teeth, c.tongue, c.mouthUpper, fu.uFaceE.value.w);
    fu.uLook.value.set(this.lx, this.ly);
    bu.uTime.value = this.time;
  }
}
