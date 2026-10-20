// Offline rendering of the car sound (owned by the Vehicle module). Renders the real
// createVehicleAudio graph into an OfflineAudioContext while a scripted fake vehicle drives a
// fixed scenario (idle, full-throttle run through the gears, lift-off, tyre squeal, impact,
// horn). Used to check levels / spectra in tests and to produce a listenable WAV demo.
import * as THREE from 'three';
import type { CarSpec, PlayerVehicle, VehicleTelemetry } from '../contracts';
import { createVehicleAudio } from './vehicleAudio';

export interface AudioDemoResult {
  sampleRate: number;
  samples: Float32Array;
  /** 16-bit PCM mono WAV, base64 encoded. */
  wavBase64: string;
  /** Peak / RMS per scenario segment. */
  segments: { name: string; t0: number; t1: number; rms: number; peak: number }[];
}

const SEGMENTS: { name: string; t0: number; t1: number }[] = [
  { name: 'idle', t0: 0, t1: 1.5 },
  { name: 'full throttle', t0: 1.5, t1: 7 },
  { name: 'lift-off', t0: 7, t1: 8.5 },
  { name: 'tyre squeal', t0: 8.5, t1: 9.6 },
  { name: 'impact', t0: 9.6, t1: 10.2 },
  { name: 'horn', t0: 10.2, t1: 11.2 },
  { name: 'idle end', t0: 11.2, t1: 12 },
];

function encodeWav(samples: Float32Array, sampleRate: number): string {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function renderVehicleAudioDemo(spec: CarSpec, sampleRate = 44100): Promise<AudioDemoResult> {
  const duration = 12;
  const ctx = new OfflineAudioContext(1, Math.round(duration * sampleRate), sampleRate);
  const telemetry: VehicleTelemetry = {
    speedKmh: 0,
    rpm: spec.idleRpm,
    gear: 1,
    throttle: 0,
    brake: 0,
    slip: 0,
    grounded: [true, true, true, true],
    impact: 0,
  };
  const controls = { horn: false };
  let impactFn: ((impulse: number, dv: number) => void) | null = null;
  let engineLoad = 0;
  const fake = {
    spec,
    telemetry,
    controls,
    get engineLoad() {
      return engineLoad;
    },
    wheelStates: [0, 1, 2, 3].map(() => ({ load: (spec.massKg * 9.81) / 4, grounded: true, surfaceTag: 'asphalt' })),
    onImpact(fn: (impulse: number, dv: number) => void) {
      impactFn = fn;
      return () => (impactFn = null);
    },
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    heading: 0,
  } as unknown as PlayerVehicle;
  const audio = createVehicleAudio(fake, { context: ctx });

  const idle = spec.electric ? 0 : spec.idleRpm;
  const redline = spec.redlineRpm;
  let speed = 0; // km/h
  let gear = 1;
  let rpm = idle;
  let impactDone = false;
  const dt = 1 / 60;
  const step = (t: number): void => {
    let thr = 0;
    let slip = 0;
    controls.horn = false;
    if (t < 1.5) {
      rpm = idle;
    } else if (t < 7) {
      thr = 1;
      // Simple run through the gears: rpm climbs, shifts at 92% of the redline.
      const rate = (redline * 0.55) / (0.9 + gear * 0.55);
      rpm += rate * dt;
      if (!spec.electric && rpm > redline * 0.92 && gear < 5) {
        gear++;
        rpm *= 0.66;
      }
      if (spec.electric) rpm = Math.min(redline * 0.8, rpm);
      speed += (14 / gear) * dt * 3.6;
    } else if (t < 8.5) {
      rpm += (Math.max(idle, redline * 0.3) - rpm) * (1 - Math.exp(-dt * 1.5));
      speed -= 4 * dt * 3.6;
    } else if (t < 9.6) {
      thr = 0.4;
      slip = 0.85;
      rpm = redline * 0.45;
    } else if (t < 10.2) {
      rpm = Math.max(idle, rpm * 0.995);
      if (!impactDone && t > 9.65) {
        impactDone = true;
        impactFn?.(spec.massKg * 3, 3);
      }
    } else if (t < 11.2) {
      controls.horn = true;
      rpm = idle;
    } else rpm = idle;
    telemetry.rpm = rpm;
    telemetry.throttle = thr;
    telemetry.slip = slip;
    telemetry.speedKmh = Math.max(0, speed);
    telemetry.gear = gear;
    engineLoad = thr;
    audio.update(dt);
  };
  for (let i = 0; i * dt < duration - dt; i++) {
    const t = i * dt;
    void ctx.suspend(t).then(() => {
      step(t);
      void ctx.resume();
    });
  }
  const rendered = await ctx.startRendering();
  audio.dispose();
  const samples = rendered.getChannelData(0).slice();
  const segments = SEGMENTS.map((s) => {
    let sum = 0;
    let peak = 0;
    const a = Math.floor(s.t0 * sampleRate);
    const b = Math.min(samples.length, Math.floor(s.t1 * sampleRate));
    for (let i = a; i < b; i++) {
      sum += samples[i] * samples[i];
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    return { ...s, rms: +Math.sqrt(sum / Math.max(1, b - a)).toFixed(4), peak: +peak.toFixed(4) };
  });
  return { sampleRate, samples, wavBase64: encodeWav(samples, sampleRate), segments };
}
