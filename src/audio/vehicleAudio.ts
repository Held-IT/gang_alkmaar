// Procedural WebAudio sound for the player car (owned by the Vehicle module).
//
// Engine: looping synthesized cycle buffers (engineSynth.ts) at three rpm layers x two load
// variants, cross-faded by rpm and throttle, plus a sub-harmonic body, intake noise and a turbo
// whistle / blow-off for turbo engines. Electric cars get a motor whine instead.
// Also: tyre squeal (band-passed noise by slip), rolling road noise (with a brick-paver rumble
// on klinkers), wind, impact thuds, suspension knocks on curbs, and a two-tone horn.
// The AudioContext resumes on the first user gesture and is suspended when the window is hidden.
//
// Start-up cost: creating the first real-time AudioContext blocks the main thread for ~0.45 s
// (audio device init) and the engine buffers take ~20-40 ms per car. Both are shared: one
// AudioContext for the whole app (never closed) and a buffer cache keyed by sample rate + synth
// parameters. Call prepareVehicleAudio() during loading so the first drive starts without a hitch;
// createVehicleAudio() then only builds the (cheap) node graph.
import type { CarSpec, PlayerVehicle } from '../contracts';
import { createNoiseBuffer, synthEngineCycle, synthImpact, type EngineLayerBuffer } from './engineSynth';

// ---------------------------------------------------------------------------------------------
// Shared context + buffer cache
// ---------------------------------------------------------------------------------------------
let sharedCtx: AudioContext | null = null;

function sharedContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedCtx = new AC({ latencyHint: 'interactive' });
  }
  return sharedCtx;
}

const bufferCache = new Map<string, AudioBuffer | EngineLayerBuffer>();

function cachedBuffer<T extends AudioBuffer | EngineLayerBuffer>(key: string, make: () => T): T {
  let b = bufferCache.get(key) as T | undefined;
  if (!b) {
    b = make();
    bufferCache.set(key, b);
  }
  return b;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  return cachedBuffer(`noise|${ctx.sampleRate}`, () => createNoiseBuffer(ctx, 2.5));
}

function impactBuffer(ctx: BaseAudioContext, heavy: boolean): AudioBuffer {
  return cachedBuffer(`impact|${ctx.sampleRate}|${heavy ? 1 : 0}`, () => synthImpact(ctx, heavy, heavy ? 5 : 3));
}

interface EngineProfile {
  electric: boolean;
  diesel: boolean;
  turbo: boolean;
  idle: number;
  /** One entry per engine layer (rpm centre x on/off load), in creation order. */
  layers: { center: number; onLoad: boolean; seed: number }[];
}

function engineProfile(spec: CarSpec): EngineProfile {
  const electric = !!spec.electric;
  const diesel = !electric && spec.redlineRpm < 5000;
  const turbo = !electric && spec.torqueNm / Math.max(1, spec.powerKw) > 1.7;
  const idle = Math.max(600, spec.idleRpm);
  const layers: EngineProfile['layers'] = [];
  if (!electric) {
    const centers = diesel ? [idle * 1.1, 2100, 3700] : [idle * 1.25, 2900, 5200];
    let seed = 11;
    for (const center of centers) for (const onLoad of [true, false]) layers.push({ center, onLoad, seed: seed++ });
  }
  return { electric, diesel, turbo, idle, layers };
}

function engineLayerBuffer(ctx: BaseAudioContext, diesel: boolean, l: EngineProfile['layers'][number]): EngineLayerBuffer {
  return cachedBuffer(`engine|${ctx.sampleRate}|${diesel ? 1 : 0}|${l.center.toFixed(3)}|${l.onLoad ? 1 : 0}|${l.seed}`, () =>
    synthEngineCycle(ctx, { rpm: l.center, load: l.onLoad ? 1 : 0.15, diesel, seed: l.seed }),
  );
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Warm everything createVehicleAudio needs for these cars: creates the shared real-time
 * AudioContext (the expensive part on the first call) and synthesizes + caches the engine,
 * noise and impact buffers. Yields to the browser between buffers so a loading screen stays
 * responsive. Safe to call repeatedly (cached work is skipped); errors are swallowed (no audio
 * device) so it never blocks loading.
 */
export async function prepareVehicleAudio(specs: CarSpec | readonly CarSpec[]): Promise<void> {
  try {
    const ctx = sharedContext();
    await yieldToBrowser();
    noiseBuffer(ctx);
    impactBuffer(ctx, false);
    impactBuffer(ctx, true);
    const list: readonly CarSpec[] = Array.isArray(specs) ? specs : [specs as CarSpec];
    for (const spec of list) {
      const prof = engineProfile(spec);
      for (const l of prof.layers) {
        const key = `engine|${ctx.sampleRate}|${prof.diesel ? 1 : 0}|${l.center.toFixed(3)}|${l.onLoad ? 1 : 0}|${l.seed}`;
        if (bufferCache.has(key)) continue;
        engineLayerBuffer(ctx, prof.diesel, l);
        await yieldToBrowser();
      }
    }
  } catch (e) {
    console.warn('[audio] prepareVehicleAudio failed', e);
  }
}

export interface VehicleAudio {
  update(dt: number): void;
  /** Master volume 0..1. */
  setVolume(v: number): void;
  /** 'interior' muffles the engine slightly (hood / bumper cameras). */
  setPerspective(p: 'exterior' | 'interior'): void;
  readonly context: BaseAudioContext;
  dispose(): void;
}

interface VehicleLike extends PlayerVehicle {
  readonly engineLoad?: number;
  readonly controls?: { horn: boolean };
  readonly isShifting?: boolean;
  readonly wheelStates?: readonly { load: number; grounded: boolean; surfaceTag?: string }[];
  onImpact?(fn: (impulse: number, deltaV: number) => void): () => void;
}

interface Layer {
  src: AudioBufferSourceNode;
  gain: GainNode;
  baseRpm: number;
  centerRpm: number;
  onLoad: boolean;
}

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

export interface VehicleAudioOptions {
  /** Render into this context (e.g. an OfflineAudioContext for demos / tests) instead of a new
   *  real-time AudioContext. Gesture / visibility handling is skipped then. */
  context?: BaseAudioContext;
}

export function createVehicleAudio(vehicle: PlayerVehicle, opts: VehicleAudioOptions = {}): VehicleAudio {
  const car = vehicle as VehicleLike;
  const spec = car.spec;
  const prof = engineProfile(spec);
  const { electric, diesel, turbo } = prof;

  const offline = !!opts.context;
  const ctx: BaseAudioContext = opts.context ?? sharedContext();
  const live = (): boolean => offline || ctx.state === 'running';
  const T = () => ctx.currentTime;
  // Every scheduled source / oscillator of this graph, stopped on dispose (the shared context
  // itself stays alive for the next car).
  const sources: AudioScheduledSourceNode[] = [];

  // ---- master chain ----
  const master = ctx.createGain();
  master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 10;
  comp.ratio.value = 3;
  comp.attack.value = 0.005;
  comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);
  const perspectiveFilter = ctx.createBiquadFilter();
  perspectiveFilter.type = 'lowpass';
  perspectiveFilter.frequency.value = 18000;
  perspectiveFilter.connect(master);

  const noiseBuf = noiseBuffer(ctx);
  function noiseSource(rate = 1, offset = 0): AudioBufferSourceNode {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(0, offset);
    sources.push(s);
    return s;
  }

  // ---- engine ----
  const engineBus = ctx.createGain();
  engineBus.gain.value = 0;
  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.Q.value = 0.7;
  engineFilter.frequency.value = 2000;
  const engineShelf = ctx.createBiquadFilter();
  engineShelf.type = 'lowshelf';
  engineShelf.frequency.value = 180;
  engineShelf.gain.value = 4;
  engineBus.connect(engineFilter).connect(engineShelf).connect(perspectiveFilter);

  const layers: Layer[] = [];
  const redline = spec.redlineRpm;
  const idle = prof.idle;
  let subOsc: OscillatorNode | null = null;
  let subGain: GainNode | null = null;
  let intakeGain: GainNode | null = null;
  let intakeFilter: BiquadFilterNode | null = null;
  let whistleOsc: OscillatorNode | null = null;
  let whistleGain: GainNode | null = null;
  let whineOsc1: OscillatorNode | null = null;
  let whineOsc2: OscillatorNode | null = null;
  let whineGain: GainNode | null = null;

  if (!electric) {
    for (const l of prof.layers) {
      const lb = engineLayerBuffer(ctx, diesel, l);
      const src = ctx.createBufferSource();
      src.buffer = lb.buffer;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(engineBus);
      src.start(0, Math.random() * lb.buffer.duration);
      sources.push(src);
      layers.push({ src, gain: g, baseRpm: lb.baseRpm, centerRpm: l.center, onLoad: l.onLoad });
    }
    subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subGain = ctx.createGain();
    subGain.gain.value = 0;
    subOsc.connect(subGain).connect(engineBus);
    subOsc.start();
    sources.push(subOsc);

    intakeFilter = ctx.createBiquadFilter();
    intakeFilter.type = 'bandpass';
    intakeFilter.Q.value = 1.4;
    intakeGain = ctx.createGain();
    intakeGain.gain.value = 0;
    noiseSource(1, 0.3).connect(intakeFilter).connect(intakeGain).connect(perspectiveFilter);

    if (turbo) {
      whistleOsc = ctx.createOscillator();
      whistleOsc.type = 'sine';
      whistleGain = ctx.createGain();
      whistleGain.gain.value = 0;
      whistleOsc.connect(whistleGain).connect(perspectiveFilter);
      whistleOsc.start();
      sources.push(whistleOsc);
    }
  } else {
    // Electric motor: two harmonically related tones + a faint inverter tone.
    whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 120;
    whineGain.connect(hp).connect(perspectiveFilter);
    whineOsc1 = ctx.createOscillator();
    whineOsc1.type = 'sine';
    whineOsc2 = ctx.createOscillator();
    whineOsc2.type = 'triangle';
    const g2 = ctx.createGain();
    g2.gain.value = 0.18;
    whineOsc1.connect(whineGain);
    whineOsc2.connect(g2).connect(whineGain);
    whineOsc1.start();
    whineOsc2.start();
    sources.push(whineOsc1, whineOsc2);
  }

  // ---- tyres / road / wind ----
  const squealGain = ctx.createGain();
  squealGain.gain.value = 0;
  const squeal1 = ctx.createBiquadFilter();
  squeal1.type = 'bandpass';
  squeal1.frequency.value = 900;
  squeal1.Q.value = 9;
  const squeal2 = ctx.createBiquadFilter();
  squeal2.type = 'bandpass';
  squeal2.frequency.value = 1650;
  squeal2.Q.value = 12;
  const squealSrc = noiseSource(1, 1.1);
  squealSrc.connect(squeal1).connect(squealGain);
  squealSrc.connect(squeal2).connect(squealGain);
  squealGain.connect(master);

  const roadFilter = ctx.createBiquadFilter();
  roadFilter.type = 'lowpass';
  roadFilter.frequency.value = 300;
  roadFilter.Q.value = 0.5;
  const roadGain = ctx.createGain();
  roadGain.gain.value = 0;
  // Brick-paver rumble: amplitude modulation at speed / brick length.
  const rumbleMod = ctx.createGain();
  rumbleMod.gain.value = 1;
  const rumbleOsc = ctx.createOscillator();
  rumbleOsc.type = 'triangle';
  rumbleOsc.frequency.value = 30;
  const rumbleDepth = ctx.createGain();
  rumbleDepth.gain.value = 0;
  rumbleOsc.connect(rumbleDepth).connect(rumbleMod.gain);
  rumbleOsc.start();
  sources.push(rumbleOsc);
  noiseSource(0.8, 0.7).connect(roadFilter).connect(rumbleMod).connect(roadGain).connect(master);

  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass';
  windFilter.frequency.value = 700;
  windFilter.Q.value = 0.6;
  const windGain = ctx.createGain();
  windGain.gain.value = 0;
  noiseSource(0.6, 1.9).connect(windFilter).connect(windGain).connect(master);

  // ---- horn: two-tone (~420 / 510 Hz), slightly overdriven and band-limited ----
  const hornGain = ctx.createGain();
  hornGain.gain.value = 0;
  const hornShaper = ctx.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.2);
  }
  hornShaper.curve = curve;
  const hornBand = ctx.createBiquadFilter();
  hornBand.type = 'bandpass';
  hornBand.frequency.value = 1300;
  hornBand.Q.value = 0.55;
  const hornMix = ctx.createGain();
  hornMix.gain.value = 0.5;
  for (const fq of spec.category === 'bestelbus' ? [370, 450] : [420, 510]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = fq;
    o.connect(hornMix);
    o.start();
    sources.push(o);
  }
  hornMix.connect(hornShaper).connect(hornBand).connect(hornGain).connect(master);

  // ---- impacts ----
  const impactLight = impactBuffer(ctx, false);
  const impactHeavy = impactBuffer(ctx, true);
  let lastImpactAt = -1;
  function playImpact(strength: number): void {
    const now = T();
    if (now - lastImpactAt < 0.12 || !live()) return;
    lastImpactAt = now;
    const heavy = strength > 0.45;
    const s = ctx.createBufferSource();
    s.buffer = heavy ? impactHeavy : impactLight;
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const g = ctx.createGain();
    g.gain.value = clamp(strength, 0.05, 1) * (heavy ? 0.9 : 0.6);
    s.connect(g).connect(master);
    s.start();
    s.onended = () => {
      s.disconnect();
      g.disconnect();
    };
  }
  const offImpact = car.onImpact?.((impulse) => playImpact(impulse / (spec.massKg * 4)));

  // ---- context lifecycle ----
  let volume = 0.8;
  let hidden = document.hidden;
  const rt = offline ? null : (ctx as AudioContext);
  function resume(): void {
    if (rt && rt.state === 'suspended' && !hidden) void rt.resume();
  }
  const gestureEvents = ['pointerdown', 'keydown', 'touchstart'] as const;
  function onVisibility(): void {
    hidden = document.hidden;
    if (hidden) void rt?.suspend();
    else resume();
  }
  if (rt) {
    for (const ev of gestureEvents) window.addEventListener(ev, resume, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    resume();
  }

  // ---- per-frame update ----
  const layerCenters = [...new Set(layers.map((l) => l.centerRpm))];
  const logCenters = layerCenters.map((c) => Math.log(c));
  const weights = layerCenters.map(() => 0);
  let rpmSmooth = idle;
  let loadSmooth = 0;
  let boost = 0;
  let lastThrottle = 0;
  let lastLoads: number[] = [0, 0, 0, 0];
  let squealWobble = 0;
  let time = 0;

  function set(p: AudioParam, v: number, tc = 0.03): void {
    p.setTargetAtTime(v, T(), tc);
  }

  function update(dt: number): void {
    time += dt;
    if (!live()) return;
    const tel = car.telemetry;
    const speed = tel.speedKmh / 3.6;
    const rpmRaw = Math.max(electric ? 0 : idle * 0.9, tel.rpm);
    rpmSmooth += (rpmRaw - rpmSmooth) * (1 - Math.exp(-dt * 25));
    const loadRaw = clamp(car.engineLoad ?? tel.throttle, 0, 1);
    loadSmooth += (loadRaw - loadSmooth) * (1 - Math.exp(-dt * (loadRaw > loadSmooth ? 12 : 6)));
    const rpmN = clamp(rpmSmooth / redline, 0, 1.1);

    if (!electric) {
      // Layer weights: triangular in log-rpm between neighbouring layer centres.
      const lr = Math.log(rpmSmooth);
      const centers = layerCenters;
      const lc = logCenters;
      weights.fill(0);
      if (lr <= lc[0]) weights[0] = 1;
      else if (lr >= lc[lc.length - 1]) weights[lc.length - 1] = 1;
      else {
        for (let i = 0; i < lc.length - 1; i++) {
          if (lr >= lc[i] && lr <= lc[i + 1]) {
            const t = (lr - lc[i]) / (lc[i + 1] - lc[i]);
            weights[i] = Math.cos((t * Math.PI) / 2);
            weights[i + 1] = Math.sin((t * Math.PI) / 2);
          }
        }
      }
      const loadMix = clamp(loadSmooth * 1.3, 0, 1);
      for (const l of layers) {
        const w = weights[centers.indexOf(l.centerRpm)];
        const lw = l.onLoad ? Math.sin((loadMix * Math.PI) / 2) : Math.cos((loadMix * Math.PI) / 2);
        set(l.gain.gain, w * lw * (l.onLoad ? 1 : 0.75));
        set(l.src.playbackRate, clamp(rpmSmooth / l.baseRpm, 0.25, 4), 0.015);
      }
      const level = (0.32 + 0.68 * rpmN) * (0.45 + 0.55 * loadSmooth);
      set(engineBus.gain, 0.55 * level);
      set(engineFilter.frequency, 700 + 5200 * Math.pow(rpmN, 0.8) * (0.35 + 0.65 * loadSmooth));
      const fire = rpmSmooth / 30; // firing frequency of an inline-4
      if (subOsc && subGain) {
        set(subOsc.frequency, fire, 0.015);
        set(subGain.gain, 0.12 * (0.4 + 0.6 * loadSmooth));
      }
      if (intakeFilter && intakeGain) {
        set(intakeFilter.frequency, 350 + rpmSmooth * 0.32);
        set(intakeGain.gain, 0.05 * loadSmooth * Math.pow(rpmN, 1.4));
      }
      if (whistleOsc && whistleGain) {
        const target = loadSmooth * clamp((rpmSmooth - 1500) / 2200, 0, 1);
        boost += (target - boost) * (1 - Math.exp(-dt / (target > boost ? 0.45 : 0.15)));
        set(whistleOsc.frequency, 2600 + boost * 4200 + rpmN * 600, 0.05);
        set(whistleGain.gain, 0.012 * boost * boost);
        // Blow-off valve on a sharp lift with boost.
        const thr = tel.throttle;
        if (lastThrottle > 0.75 && thr < 0.2 && boost > 0.45) playBlowOff(boost);
        lastThrottle = thr;
      }
    } else if (whineOsc1 && whineOsc2 && whineGain) {
      const f = 40 + (rpmSmooth / 60) * 3.2;
      set(whineOsc1.frequency, f, 0.02);
      set(whineOsc2.frequency, f * 2.76, 0.02);
      set(whineGain.gain, (0.015 + 0.05 * loadSmooth) * clamp(rpmSmooth / 1500, 0, 1));
    }

    // Tyre squeal.
    const slip = clamp(tel.slip, 0, 1);
    squealWobble += dt * (3 + Math.random() * 4);
    const sq = slip > 0.03 ? Math.pow(slip, 1.4) : 0;
    set(squealGain.gain, 0.35 * sq, 0.05);
    set(squeal1.frequency, 820 + 260 * slip + Math.sin(squealWobble) * 40, 0.05);
    set(squeal2.frequency, 1500 + 380 * slip + Math.sin(squealWobble * 1.7) * 60, 0.05);

    // Road + wind.
    const wheels = car.wheelStates;
    let grounded = 0;
    let bricks = false;
    if (wheels) {
      for (const w of wheels) {
        if (!w.grounded) continue;
        grounded++;
        const tag = w.surfaceTag ?? '';
        if (tag.includes('klinker') || tag.includes('square') || tag.includes('cobble')) bricks = true;
      }
    } else grounded = tel.grounded.filter(Boolean).length;
    const roll = clamp(speed / 30, 0, 1.4) * (grounded / 4);
    set(roadGain.gain, 0.09 * Math.pow(roll, 1.2) * (bricks ? 1.5 : 1));
    set(roadFilter.frequency, 180 + speed * 14 + (bricks ? 250 : 0));
    set(rumbleOsc.frequency, Math.max(5, speed / 0.21));
    set(rumbleDepth.gain, bricks ? 0.6 : 0.08);
    set(windGain.gain, 0.07 * clamp(Math.pow(speed / 45, 2), 0, 1.5));
    set(windFilter.frequency, 500 + speed * 18);

    // Suspension knocks (curbs, speed bumps): sudden wheel load changes.
    if (wheels) {
      for (let i = 0; i < wheels.length && i < 4; i++) {
        const l = wheels[i].load;
        const d = l - lastLoads[i];
        const ref = (spec.massKg * 9.81) / 4;
        if (d > ref * 0.9 && speed > 1) playImpact(clamp(d / (ref * 6), 0.06, 0.3));
        lastLoads[i] = l;
      }
    }

    // Horn.
    const horn = !!car.controls?.horn;
    set(hornGain.gain, horn ? 0.22 : 0, horn ? 0.008 : 0.03);
    void time;
  }

  function playBlowOff(strength: number): void {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    const now = T();
    bp.frequency.setValueAtTime(3200, now);
    bp.frequency.exponentialRampToValueAtTime(900, now + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.05 * strength, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, now + 0.4);
    s.connect(bp).connect(g).connect(perspectiveFilter);
    s.start(now, Math.random());
    s.stop(now + 0.45);
    s.onended = () => {
      s.disconnect();
      bp.disconnect();
      g.disconnect();
    };
  }

  return {
    context: ctx,
    update,
    setVolume(v: number) {
      volume = clamp(v, 0, 1);
      master.gain.setTargetAtTime(volume, T(), 0.05);
    },
    setPerspective(p) {
      perspectiveFilter.frequency.setTargetAtTime(p === 'interior' ? 2600 : 18000, T(), 0.1);
    },
    dispose() {
      offImpact?.();
      for (const ev of gestureEvents) window.removeEventListener(ev, resume);
      document.removeEventListener('visibilitychange', onVisibility);
      lastLoads = [];
      // The (shared) context stays alive for the next car: silence and release this graph only.
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      }
      sources.length = 0;
      comp.disconnect();
      master.disconnect();
    },
  };
}
