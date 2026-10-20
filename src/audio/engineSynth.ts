// Offline synthesis of looping engine sound buffers (owned by the Vehicle module).
//
// Each buffer holds several complete 720-degree cycles of an inline-4 four-stroke engine at a
// base rpm: every firing produces an exhaust pressure pulse (a short half-sine "thump") that
// excites a few damped pipe resonances (formants) plus a little combustion rasp. Small
// per-cylinder amplitude/timing differences give the characteristic burble. At runtime the
// buffers loop with playbackRate = rpm / baseRpm and are cross-faded between rpm layers and
// between on-load / off-load variants (the same technique as sample-based engine audio).

export interface EngineCycleOptions {
  rpm: number;
  /** 1 = full load (bright, punchy), 0 = overrun (soft, muffled, burbly). */
  load: number;
  /** Diesel character: injector clatter, lower formants. */
  diesel: boolean;
  /** Number of engine cycles in the loop (more = less audible periodicity). */
  cycles?: number;
  seed?: number;
}

export interface EngineLayerBuffer {
  buffer: AudioBuffer;
  /** Exact rpm the buffer represents (after rounding to whole samples). */
  baseRpm: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthEngineCycle(ctx: BaseAudioContext, o: EngineCycleOptions): EngineLayerBuffer {
  const sr = ctx.sampleRate;
  const cycles = o.cycles ?? 8;
  const cycleSamples = (120 / o.rpm) * sr;
  const total = Math.round(cycles * cycleSamples);
  const baseRpm = (cycles * 120 * sr) / total;
  const data = new Float32Array(total);
  const rnd = mulberry32(o.seed ?? 1234);
  const load = Math.min(1, Math.max(0, o.load));

  const firings = cycles * 4;
  const interval = total / firings;
  // Fixed per-cylinder character (a real engine is never perfectly balanced).
  const cylAmp = [1.0, 0.93, 1.05, 0.96];
  const cylJit = [0, 0.012, -0.008, 0.006];
  // Formants (Hz), decays (s), and weights.
  const f = o.diesel ? [95, 260, 720, 1900] : [120, 340, 980, 2400];
  const tau = [0.022, 0.009, 0.0035, 0.0016];
  const w = [0.55, 0.45 + 0.25 * load, 0.12 + 0.35 * load, 0.03 + 0.12 * load];
  const pulseWidth = interval * (0.42 - 0.12 * load);
  const span = Math.min(total, Math.round(0.07 * sr));
  // Damped resonances w * exp(-t/tau) * sin(2 pi f t + phase) are evaluated with the exact
  // two-term recurrence v[n+1] = 2 d cos(theta) v[n] - d^2 v[n-1] (d = per-sample decay,
  // theta = per-sample phase step) instead of exp() + sin() per sample: ~10x faster.
  const rc1 = new Float64Array(4);
  const rc2 = new Float64Array(4);
  for (let j = 0; j < 4; j++) {
    const d = Math.exp(-1 / (sr * tau[j]));
    rc1[j] = 2 * d * Math.cos((2 * Math.PI * f[j]) / sr);
    rc2[j] = d * d;
  }
  const res = (j: number, t: number, ph: number): number =>
    w[j] * Math.exp(-t / tau[j]) * Math.sin(2 * Math.PI * f[j] * t + ph);

  for (let k = 0; k < firings; k++) {
    const cyl = k % 4;
    const jitter = (cylJit[cyl] + (rnd() - 0.5) * 0.01 * (1.6 - load)) * interval;
    const t0 = k * interval + jitter;
    const variance = 1 + (rnd() - 0.5) * (0.06 + 0.22 * (1 - load));
    const amp = cylAmp[cyl] * variance;
    const p0 = rnd() * 0.6;
    const p1 = rnd() * 1.2;
    const p2 = rnd() * 2;
    const p3 = rnd() * 3;
    const start = Math.floor(t0);
    const frac = t0 - start;
    // First sample with t >= 0, and the resonator states at that sample and the one before it.
    const n0 = frac > 0 ? 1 : 0;
    const ta = (n0 - frac) / sr;
    const tb = (n0 - 1 - frac) / sr;
    let c0 = res(0, ta, p0), q0 = res(0, tb, p0);
    let c1 = res(1, ta, p1), q1 = res(1, tb, p1);
    let c2 = res(2, ta, p2), q2 = res(2, tb, p2);
    let c3 = res(3, ta, p3), q3 = res(3, tb, p3);
    const a0 = rc1[0], b0 = rc2[0], a1 = rc1[1], b1 = rc2[1];
    const a2 = rc1[2], b2 = rc2[2], a3 = rc1[3], b3 = rc2[3];
    for (let n = n0; n < span; n++) {
      const t = (n - frac) / sr;
      let s = 0;
      // Exhaust pressure pulse.
      const ns = n - frac;
      if (ns < pulseWidth) s += 0.9 * Math.sin((Math.PI * ns) / pulseWidth);
      // Pipe / manifold resonances (recurrence, see above).
      s += c0 + c1 + c2 + c3;
      let nx = a0 * c0 - b0 * q0;
      q0 = c0;
      c0 = nx;
      nx = a1 * c1 - b1 * q1;
      q1 = c1;
      c1 = nx;
      nx = a2 * c2 - b2 * q2;
      q2 = c2;
      c2 = nx;
      nx = a3 * c3 - b3 * q3;
      q3 = c3;
      c3 = nx;
      // Combustion rasp: short noise burst.
      if (t < 0.004) s += (rnd() * 2 - 1) * (0.05 + 0.25 * load) * Math.exp(-t / 0.0012);
      // Diesel injector clatter: sharp high click before the main pulse.
      if (o.diesel && t < 0.0025) s += (rnd() * 2 - 1) * 0.35 * Math.exp(-t / 0.0006);
      data[(start + n) % total] += amp * s;
    }
  }
  // Overrun "pops" for the off-load layer (sparse, subtle).
  if (load < 0.5) {
    const pops = Math.round(cycles * 0.6);
    for (let p = 0; p < pops; p++) {
      const at = Math.floor(rnd() * total);
      const a = 0.25 + rnd() * 0.25;
      for (let n = 0; n < Math.round(0.012 * sr); n++) {
        const t = n / sr;
        data[(at + n) % total] += a * (rnd() * 2 - 1) * Math.exp(-t / 0.003) + a * 0.6 * Math.exp(-t / 0.006) * Math.sin(2 * Math.PI * 180 * t);
      }
    }
  }
  // Remove DC, gentle one-pole low-pass for smoothness, normalise.
  let mean = 0;
  for (let i = 0; i < total; i++) mean += data[i];
  mean /= total;
  for (let i = 0; i < total; i++) data[i] -= mean;
  const a = Math.exp((-2 * Math.PI * (o.diesel ? 5000 : 7000)) / sr);
  // Warm-up pass (no output) so the filter state at the loop seam is continuous.
  let y = 0;
  for (let i = 0; i < total; i++) y = (1 - a) * data[i] + a * y;
  for (let i = 0; i < total; i++) {
    y = (1 - a) * data[i] + a * y;
    data[i] = y;
  }
  let peak = 1e-6;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(data[i]));
  const g = 0.9 / peak;
  for (let i = 0; i < total; i++) data[i] *= g;

  const buffer = ctx.createBuffer(1, total, sr);
  buffer.getChannelData(0).set(data);
  return { buffer, baseRpm };
}

/** White noise buffer (mono) of the given length. */
export function createNoiseBuffer(ctx: BaseAudioContext, seconds: number, seed = 99): AudioBuffer {
  const n = Math.round(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
  return buf;
}

/** Impact sound: low body thump + broadband crunch (+ metallic ring for heavy hits). */
export function synthImpact(ctx: BaseAudioContext, heavy: boolean, seed = 7): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round((heavy ? 0.9 : 0.35) * sr);
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const rnd = mulberry32(seed);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    let s = Math.sin(2 * Math.PI * (heavy ? 55 : 75) * t * (1 - t * 0.6)) * Math.exp(-t / (heavy ? 0.12 : 0.07));
    const noise = rnd() * 2 - 1;
    lp += (noise - lp) * (heavy ? 0.35 : 0.2);
    s += lp * (heavy ? 0.9 : 0.45) * Math.exp(-t / (heavy ? 0.09 : 0.03));
    if (heavy) {
      s += 0.18 * Math.exp(-t / 0.35) * Math.sin(2 * Math.PI * 431 * t);
      s += 0.12 * Math.exp(-t / 0.25) * Math.sin(2 * Math.PI * 1187 * t + 1);
      s += 0.08 * Math.exp(-t / 0.18) * Math.sin(2 * Math.PI * 2310 * t + 2);
      // Glass / plastic debris tinkles.
      if (t > 0.05 && t < 0.6 && rnd() < 0.0015) s += (rnd() - 0.5) * 0.6;
    }
    d[i] = s * Math.min(1, t * sr / 30);
  }
  return buf;
}
