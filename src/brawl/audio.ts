// Procedural brawl audio (WebAudio, no samples): punches and thuds scaled by strength, silly
// formant-synthesised grunts with a per-beast pitch, splashes, footsteps, a Kaasmarkt crowd
// (murmur, "oooh", cheers), the Waag carillon, a canal-boat diesel + horn, creaking windmill
// sails + wind, and a light Dutch street-organ (draaiorgel) waltz for the lobby. All tunes are
// original compositions.
import type { ArenaId } from './contracts';

export type GruntKind = 'hit' | 'effort' | 'ko' | 'yay' | 'scared';
export type Ambience = ArenaId | 'lobby' | null;

export interface BrawlAudio {
  /** Master (effects + ambience) and music volume, 0..1. */
  setVolume(master: number, music: number): void;
  /** Resume the AudioContext (call from a user gesture). */
  resume(): void;
  punch(strength: number): void;
  thud(strength: number): void;
  grunt(voice: number, kind: GruntKind): void;
  splash(strength: number): void;
  footstep(strength: number): void;
  whoosh(): void;
  beep(final: boolean): void;
  ooh(): void;
  cheer(amount: number): void;
  carillon(): void;
  horn(): void;
  fanfare(): void;
  setAmbience(a: Ambience): void;
  setMusic(on: boolean): void;
  /** Pauses ambience + music (pause menu) without forgetting them. */
  setPaused(p: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

const VOWELS: Record<string, [number, number, number]> = {
  a: [800, 1150, 2900],
  o: [450, 800, 2830],
  u: [325, 700, 2530],
  e: [400, 2000, 2550],
  i: [270, 2140, 2950],
};

const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// --- draaiorgel waltz (F major, 3/4): melody [midi, beats] per bar, chord per bar -------------
const MELODY: [number, number][][] = [
  [[69, 2], [72, 1]], [[77, 2], [76, 1]], [[74, 1], [72, 1], [70, 1]], [[67, 3]],
  [[67, 1], [70, 1], [74, 1]], [[76, 2], [74, 1]], [[72, 1], [70, 1], [69, 1]], [[65, 3]],
  [[69, 2], [72, 1]], [[75, 2], [74, 1]], [[74, 1], [77, 1], [74, 1]], [[70, 3]],
  [[69, 1], [72, 1], [77, 1]], [[76, 2], [67, 1]], [[69, 1], [67, 1], [64, 1]], [[65, 3]],
];
const CHORDS: { bass: number; stab: number[] }[] = [
  { bass: 41, stab: [57, 60, 65] }, { bass: 41, stab: [57, 60, 65] }, { bass: 36, stab: [55, 58, 64] }, { bass: 36, stab: [55, 58, 64] },
  { bass: 36, stab: [55, 58, 64] }, { bass: 36, stab: [55, 58, 64] }, { bass: 41, stab: [57, 60, 65] }, { bass: 41, stab: [57, 60, 65] },
  { bass: 41, stab: [57, 60, 65] }, { bass: 41, stab: [57, 63, 65] }, { bass: 46, stab: [58, 62, 65] }, { bass: 46, stab: [58, 62, 65] },
  { bass: 48, stab: [57, 60, 65] }, { bass: 36, stab: [55, 58, 64] }, { bass: 36, stab: [55, 58, 64] }, { bass: 41, stab: [57, 60, 65] },
];
const BEAT = 0.4; // 150 bpm waltz
// --- the Waag carillon: a short original bell tune (G major) ------------------------------------
const CARILLON: [number, number][] = [
  [79, 0.3], [76, 0.3], [72, 0.3], [74, 0.3], [79, 0.6], [74, 0.3], [76, 0.3], [79, 0.3], [84, 0.9],
];

export function createBrawlAudio(): BrawlAudio {
  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioContext({ latencyHint: 'interactive' });
  } catch (e) {
    console.warn('[audio] geen WebAudio:', e);
  }
  if (!ctx) return silent();
  const ac = ctx;
  const master = ac.createGain();
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(ac.destination);
  const sfx = ac.createGain();
  const amb = ac.createGain();
  const music = ac.createGain();
  sfx.connect(master);
  amb.connect(master);
  music.connect(master);
  let masterVol = 0.8;
  let musicVol = 0.6;
  let paused = false;
  master.gain.value = masterVol;
  music.gain.value = 0;

  // shared noise buffer (2 s)
  const noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  {
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const noise = (t: number, dur: number, dest: AudioNode): AudioBufferSourceNode => {
    const s = ac.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    s.connect(dest);
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.05);
    return s;
  };
  const env = (g: GainNode, t: number, peak: number, attack: number, decay: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  const gainNode = (dest: AudioNode, v = 1) => {
    const g = ac.createGain();
    g.gain.value = v;
    g.connect(dest);
    return g;
  };
  const filter = (type: BiquadFilterType, freq: number, q: number, dest: AudioNode) => {
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  };
  const osc = (type: OscillatorType, freq: number, t: number, dur: number, dest: AudioNode) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  };

  // --- voices -------------------------------------------------------------------------------
  function voice(t: number, f0: number, vowel: keyof typeof VOWELS, dur: number, contour: [number, number, number], peak: number, dest: AudioNode, vowel2?: keyof typeof VOWELS): void {
    const out = gainNode(dest, 0);
    env(out, t, peak, Math.min(0.05, dur * 0.2), dur);
    const src = ac.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * contour[0], t);
    src.frequency.linearRampToValueAtTime(f0 * contour[1], t + dur * 0.35);
    src.frequency.exponentialRampToValueAtTime(f0 * contour[2], t + dur);
    const vib = ac.createOscillator();
    vib.frequency.value = 5.5 + Math.random() * 2;
    const vibG = ac.createGain();
    vibG.gain.value = f0 * 0.03;
    vib.connect(vibG).connect(src.frequency);
    const formants = VOWELS[vowel];
    const to = vowel2 ? VOWELS[vowel2] : null;
    formants.forEach((f, i) => {
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(f, t);
      if (to) bp.frequency.linearRampToValueAtTime(to[i], t + dur * 0.8);
      bp.Q.value = 7 + i * 3;
      const g = gainNode(out, i === 0 ? 1 : i === 1 ? 0.6 : 0.25);
      src.connect(bp).connect(g);
    });
    src.start(t);
    vib.start(t);
    src.stop(t + dur + 0.1);
    vib.stop(t + dur + 0.1);
  }

  function bell(t: number, f: number, peak: number, dest: AudioNode, decay = 2.2): void {
    const partials: [number, number, number][] = [
      [0.5, 0.5, 1.6], [1, 1, 1], [1.19, 0.45, 0.7], [1.5, 0.35, 0.55], [2, 0.4, 0.45], [2.52, 0.2, 0.3], [3.01, 0.15, 0.22],
    ];
    for (const [r, a, d] of partials) {
      const g = gainNode(dest, 0);
      env(g, t, peak * a, 0.004, decay * d);
      osc('sine', f * r, t, decay * d + 0.05, g);
    }
  }

  // --- ambience beds --------------------------------------------------------------------------
  interface Bed {
    nodes: AudioScheduledSourceNode[];
    gain: GainNode;
    tick?(dt: number): void;
  }
  let bed: Bed | null = null;
  let ambience: Ambience = null;
  let ambienceTimer = 0;

  function makeBed(a: Ambience): Bed | null {
    if (!a || a === 'lobby') return null;
    const g = gainNode(amb, 0);
    const t = ac.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 1.5);
    const nodes: AudioScheduledSourceNode[] = [];
    const loopNoise = (dest: AudioNode) => {
      const s = ac.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      s.connect(dest);
      s.start();
      nodes.push(s);
      return s;
    };
    const lfo = (freq: number, depth: number, param: AudioParam) => {
      const o = ac.createOscillator();
      o.frequency.value = freq;
      const d = ac.createGain();
      d.gain.value = depth;
      o.connect(d).connect(param);
      o.start();
      nodes.push(o);
    };
    if (a === 'kaasmarkt') {
      // crowd murmur: two noise bands with slow random swells
      const m1 = gainNode(g, 0.05);
      loopNoise(filter('bandpass', 520, 1.4, m1));
      const m2 = gainNode(g, 0.03);
      loopNoise(filter('bandpass', 1350, 2.2, m2));
      lfo(0.31, 0.02, m1.gain);
      lfo(0.47, 0.015, m2.gain);
      return { nodes, gain: g };
    }
    if (a === 'rondvaartboot') {
      // diesel chug: low saws, low-passed, amplitude modulated at ~8 Hz
      const eng = gainNode(g, 0.07);
      const lp = filter('lowpass', 240, 1, eng);
      const o1 = ac.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 41;
      const o2 = ac.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 82.5;
      const o2g = gainNode(lp, 0.3);
      o1.connect(lp);
      o2.connect(o2g);
      o1.start();
      o2.start();
      nodes.push(o1, o2);
      lfo(8.2, 0.045, eng.gain);
      // water along the hull
      const w = gainNode(g, 0.04);
      loopNoise(filter('lowpass', 700, 0.7, w));
      lfo(0.23, 0.025, w.gain);
      return { nodes, gain: g };
    }
    // molen: gusty wind + whistle
    const wind = gainNode(g, 0.07);
    const lp = filter('lowpass', 520, 0.8, wind);
    loopNoise(lp);
    lfo(0.13, 260, lp.frequency);
    lfo(0.21, 0.04, wind.gain);
    const wh = gainNode(g, 0.012);
    loopNoise(filter('bandpass', 1900, 18, wh));
    lfo(0.17, 0.01, wh.gain);
    return { nodes, gain: g };
  }

  function creak(t: number): void {
    const g = gainNode(amb, 0);
    env(g, t, 0.16, 0.08, 0.5);
    const bp = filter('bandpass', 700 + Math.random() * 500, 14, g);
    const o = osc('sawtooth', 70 + Math.random() * 30, t, 0.6, bp);
    o.frequency.linearRampToValueAtTime(95 + Math.random() * 40, t + 0.5);
  }
  function sailWhoosh(t: number): void {
    const g = gainNode(amb, 0);
    env(g, t, 0.12, 0.35, 0.5);
    const bp = filter('bandpass', 300, 1.2, g);
    bp.frequency.setValueAtTime(250, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.35);
    bp.frequency.exponentialRampToValueAtTime(300, t + 0.85);
    noise(t, 0.9, bp);
  }

  // --- music scheduler (draaiorgel) ------------------------------------------------------------
  let musicOn = false;
  let nextBeatTime = 0;
  let beatIndex = 0;
  function organNote(t: number, n: number, dur: number, peak: number): void {
    const g = gainNode(music, 0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.015);
    g.gain.setValueAtTime(peak, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.98);
    const lp = filter('lowpass', 2600, 0.7, g);
    const f = midi(n);
    const a = osc('square', f, t, dur, gainNode(lp, 0.5));
    const b = osc('sawtooth', f * 2, t, dur, gainNode(lp, 0.22));
    osc("triangle", f * 0.5, t, dur, gainNode(lp, 0.35));
    // tremolo of the pipes
    const trem = ac.createOscillator();
    trem.frequency.value = 6.3;
    const tg = ac.createGain();
    tg.gain.value = f * 0.004;
    trem.connect(tg);
    tg.connect(a.frequency);
    tg.connect(b.frequency);
    trem.start(t);
    trem.stop(t + dur + 0.05);
  }
  function scheduleBeat(t: number, index: number): void {
    const bar = Math.floor(index / 3) % 16;
    const beat = index % 3;
    const loop = Math.floor(index / 48);
    const chord = CHORDS[bar];
    if (beat === 0) {
      // "oom": bass + soft drum
      const g = gainNode(music, 0);
      env(g, t, 0.32, 0.01, 0.38);
      osc('sawtooth', midi(chord.bass), t, 0.4, filter('lowpass', 500, 1, g));
      const k = gainNode(music, 0);
      env(k, t, 0.25, 0.005, 0.16);
      const ko = osc('sine', 110, t, 0.2, k);
      ko.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    } else {
      // "pah": chord stab + a little snare tick
      for (const n of chord.stab) {
        const g = gainNode(music, 0);
        env(g, t, 0.06, 0.008, 0.2);
        osc('square', midi(n), t, 0.24, filter('lowpass', 1800, 0.7, g));
      }
      const s = gainNode(music, 0);
      env(s, t, 0.04, 0.002, 0.06);
      noise(t, 0.08, filter('highpass', 4000, 0.7, s));
    }
    // melody notes that start on this beat
    let pos = 0;
    for (const [n, beats] of MELODY[bar]) {
      if (pos === beat) {
        organNote(t, n, beats * BEAT * 0.95, 0.12);
        if (loop % 2 === 1) bell(t, midi(n + 12), 0.035, music, 0.9);
      }
      pos += beats;
    }
  }

  // footstep / misc throttles
  let lastStep = 0;

  const api: BrawlAudio = {
    setVolume(m, mu) {
      masterVol = m;
      musicVol = mu;
      master.gain.setTargetAtTime(paused ? m * 0.35 : m, ac.currentTime, 0.05);
      music.gain.setTargetAtTime(musicOn ? mu * 0.9 : 0, ac.currentTime, 0.1);
    },
    resume() {
      if (ac.state === 'suspended') void ac.resume();
    },
    punch(strength) {
      const s = Math.min(1, Math.max(0.1, strength));
      const t = ac.currentTime;
      const g = gainNode(sfx, 0);
      env(g, t, 0.55 * s + 0.1, 0.003, 0.14 + s * 0.12);
      const o = osc('sine', 150 - s * 40, t, 0.3, g);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
      const n = gainNode(sfx, 0);
      env(n, t, 0.35 * s + 0.08, 0.002, 0.05 + s * 0.04);
      noise(t, 0.12, filter('bandpass', 1500 + Math.random() * 900, 0.9, n));
    },
    thud(strength) {
      const s = Math.min(1, Math.max(0.1, strength));
      const t = ac.currentTime;
      const g = gainNode(sfx, 0);
      env(g, t, 0.5 * s, 0.004, 0.3);
      const o = osc('sine', 90, t, 0.4, g);
      o.frequency.exponentialRampToValueAtTime(35, t + 0.25);
      const n = gainNode(sfx, 0);
      env(n, t, 0.2 * s, 0.003, 0.15);
      noise(t, 0.2, filter('lowpass', 500, 0.8, n));
    },
    grunt(v, kind) {
      const t = ac.currentTime + Math.random() * 0.03;
      const f0 = 150 * v;
      const vowels: (keyof typeof VOWELS)[] = ['a', 'o', 'u', 'e'];
      const vw = vowels[Math.floor(Math.random() * vowels.length)];
      switch (kind) {
        case 'hit':
          voice(t, f0, vw, 0.22 + Math.random() * 0.1, [1.35, 1.1, 0.75], 0.32, sfx);
          break;
        case 'effort':
          voice(t, f0, 'u', 0.3, [0.95, 1.08, 1.0], 0.2, sfx, 'a');
          break;
        case 'ko':
          voice(t, f0, 'o', 0.95, [1.25, 1.0, 0.45], 0.38, sfx, 'u');
          break;
        case 'yay':
          voice(t, f0 * 1.1, 'e', 0.7, [1.0, 1.45, 1.6], 0.35, sfx, 'i');
          break;
        case 'scared':
          voice(t, f0 * 1.5, 'a', 0.9, [1.4, 1.8, 1.2], 0.3, sfx, 'o');
          break;
      }
    },
    splash(strength) {
      const s = Math.min(1, Math.max(0.2, strength));
      const t = ac.currentTime;
      const g = gainNode(sfx, 0);
      env(g, t, 0.6 * s, 0.01, 0.9);
      const lp = filter('lowpass', 3500, 0.6, g);
      lp.frequency.setValueAtTime(4200, t);
      lp.frequency.exponentialRampToValueAtTime(380, t + 0.8);
      noise(t, 1.0, lp);
      for (let i = 0; i < 7; i++) {
        const bt = t + 0.1 + Math.random() * 0.7;
        const bg = gainNode(sfx, 0);
        env(bg, bt, 0.08 * s, 0.004, 0.06);
        const o = osc('sine', 280 + Math.random() * 300, bt, 0.1, bg);
        o.frequency.exponentialRampToValueAtTime(900 + Math.random() * 600, bt + 0.07);
      }
    },
    footstep(strength) {
      const t = ac.currentTime;
      if (t - lastStep < 0.06) return;
      lastStep = t;
      const g = gainNode(sfx, 0);
      env(g, t, 0.05 * Math.min(1, strength) + 0.01, 0.002, 0.05);
      noise(t, 0.07, filter('bandpass', ambience === 'molen' || ambience === 'rondvaartboot' ? 420 : 900, 1.3, g));
    },
    whoosh() {
      const t = ac.currentTime;
      const g = gainNode(sfx, 0);
      env(g, t, 0.12, 0.05, 0.18);
      const bp = filter('bandpass', 600, 1.5, g);
      bp.frequency.exponentialRampToValueAtTime(2200, t + 0.2);
      noise(t, 0.25, bp);
    },
    beep(final) {
      const t = ac.currentTime;
      if (final) {
        bell(t, midi(79), 0.22, sfx, 1.6);
        bell(t, midi(84), 0.16, sfx, 1.6);
      } else bell(t, midi(72), 0.2, sfx, 0.9);
    },
    ooh() {
      const t = ac.currentTime;
      const g = gainNode(amb, 1);
      for (let i = 0; i < 7; i++) {
        voice(t + Math.random() * 0.15, 120 + Math.random() * 140, Math.random() < 0.5 ? 'o' : 'u', 1.1 + Math.random() * 0.4, [1.1, 1.0, 0.8], 0.05, g);
      }
    },
    cheer(amount) {
      const a = Math.min(1, Math.max(0.2, amount));
      const t = ac.currentTime;
      const g = gainNode(amb, 0);
      env(g, t, 0.18 * a, 0.25, 2.4);
      noise(t, 2.8, filter('bandpass', 1300, 0.6, g));
      for (let i = 0; i < 9; i++) {
        voice(t + Math.random() * 0.4, 140 + Math.random() * 200, Math.random() < 0.5 ? 'e' : 'a', 1.2 + Math.random() * 0.8, [1.0, 1.25, 1.15], 0.04 * a, amb, 'a');
      }
      // whistle
      const wg = gainNode(amb, 0);
      env(wg, t + 0.3, 0.03 * a, 0.05, 0.5);
      const w = osc('sine', 1900, t + 0.3, 0.6, wg);
      w.frequency.linearRampToValueAtTime(2500, t + 0.6);
    },
    carillon() {
      let t = ac.currentTime + 0.05;
      for (const [n, d] of CARILLON) {
        bell(t, midi(n), 0.11, amb, 2.6);
        t += d;
      }
    },
    horn() {
      const t = ac.currentTime;
      const g = gainNode(amb, 0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.12);
      g.gain.setValueAtTime(0.16, t + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
      const lp = filter('lowpass', 900, 1.2, g);
      osc('sawtooth', 138, t, 1.5, lp);
      osc('sawtooth', 207.5, t, 1.5, gainNode(lp, 0.6));
    },
    fanfare() {
      let t = ac.currentTime + 0.05;
      const notes: [number, number][] = [[65, 0.16], [69, 0.16], [72, 0.16], [77, 0.5], [76, 0.16], [77, 0.9]];
      for (const [n, d] of notes) {
        organNote(t, n, d * 0.95, 0.1);
        bell(t, midi(n + 12), 0.04, sfx, 0.8);
        t += d;
      }
    },
    setAmbience(a) {
      if (a === ambience) return;
      ambience = a;
      if (bed) {
        const old = bed;
        const t = ac.currentTime;
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setTargetAtTime(0.0001, t, 0.3);
        setTimeout(() => {
          old.nodes.forEach((n) => {
            try {
              n.stop();
            } catch {
              /* already stopped */
            }
          });
          old.gain.disconnect();
        }, 1500);
      }
      bed = makeBed(a);
      ambienceTimer = 2;
    },
    setMusic(on) {
      if (on === musicOn) return;
      musicOn = on;
      music.gain.setTargetAtTime(on ? musicVol * 0.9 : 0, ac.currentTime, on ? 0.3 : 0.5);
      if (on) {
        nextBeatTime = ac.currentTime + 0.1;
        beatIndex = 0;
      }
    },
    setPaused(p) {
      paused = p;
      master.gain.setTargetAtTime(p ? masterVol * 0.35 : masterVol, ac.currentTime, 0.1);
    },
    update(dt) {
      if (ac.state !== 'running') return;
      if (musicOn) {
        // keep scheduling while the fade-out of a stopped loop still sounds
        while (nextBeatTime < ac.currentTime + 0.3) {
          if (nextBeatTime < ac.currentTime - 0.5) nextBeatTime = ac.currentTime + 0.05;
          scheduleBeat(nextBeatTime, beatIndex++);
          nextBeatTime += BEAT;
        }
      }
      if (paused) return;
      ambienceTimer -= dt;
      if (ambienceTimer <= 0) {
        const t = ac.currentTime;
        if (ambience === 'molen') {
          sailWhoosh(t);
          if (Math.random() < 0.6) creak(t + 0.4);
          ambienceTimer = 2.6 + Math.random() * 0.6;
        } else if (ambience === 'rondvaartboot') {
          if (Math.random() < 0.25) api.horn();
          ambienceTimer = 14 + Math.random() * 10;
        } else if (ambience === 'kaasmarkt') {
          if (Math.random() < 0.3) api.carillon();
          ambienceTimer = 25 + Math.random() * 20;
        } else ambienceTimer = 5;
      }
    },
    dispose() {
      void ac.close();
    },
  };
  // browsers start suspended without a gesture
  const wake = () => api.resume();
  window.addEventListener('keydown', wake);
  window.addEventListener('mousedown', wake);
  return api;
}

function silent(): BrawlAudio {
  const n = () => {};
  return {
    setVolume: n, resume: n, punch: n, thud: n, grunt: n, splash: n, footstep: n, whoosh: n, beep: n, ooh: n,
    cheer: n, carillon: n, horn: n, fanfare: n, setAmbience: n, setMusic: n, setPaused: n, update: n, dispose: n,
  };
}
