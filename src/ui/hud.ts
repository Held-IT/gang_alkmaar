// Driving HUD: analog speedometer with rpm arc + big digital km/u + gear, dashboard warning
// lights (dimlicht, handrem, ABS, ESP), Dutch blue street-name sign (cross-fades on change),
// RVV speed-limit sign and an F3 performance overlay.
// update() is called every frame: it only touches the DOM / canvas when values change.

import type { CarSpec, Engine, VehicleTelemetry } from '../contracts';
import { clamp, fmt, fromHTML, h } from './dom';
import type { DrivingPrefs, GearboxMode } from './driving';
import { TELLTALES } from './icons';
import type { RoadLookup } from './roadLookup';

export interface HudInfo {
  /** Street name for the sign; null hides it. Undefined = use the UI's own road lookup. */
  streetName?: string | null;
  x: number;
  z: number;
  /** Vehicle heading (radians, 0 = facing +z / south). */
  heading: number;
  /** Optional speed limit (km/u) for the RVV sign. Undefined = UI's own road lookup; null hides. */
  speedLimitKmh?: number | null;
  /** Dashboard warning lights (e.g. from vehicle.controls). Omitted fields count as off. */
  lights?: HudLights;
  /** Current gearbox mode (vehicle.controls.gearboxMode). Undefined = the UI setting. */
  gearboxMode?: GearboxMode;
}

/**
 * Warning-light inputs. ABS / TCS / ESC are "intervening right now" flags; the HUD holds them
 * ~0.35 s so short pulses read as a flicker. Independently, a disabled assist (Instellingen ›
 * Rijden) shows the steady amber "ABS" or "ESP OFF" light, as in a real car.
 */
export interface HudLights {
  /** Headlights / dimlicht on (green). */
  head?: boolean;
  /** Handbrake pulled (red). */
  handbrake?: boolean;
  /** ABS is limiting brake pressure (vehicle.controls.absActive). */
  abs?: boolean;
  /** Traction control is cutting torque (vehicle.controls.tcsActive) — flashes the ESP light. */
  tcs?: boolean;
  /** Stability control is braking a wheel (vehicle.controls.escActive) — flashes the ESP light. */
  esc?: boolean;
}

export interface HudStatus {
  x: number;
  z: number;
  heading: number;
  street: string | null;
  /** False until update() was called at least once. */
  hasPosition: boolean;
  /** Distance driven (m) and time driven (s) while the HUD was visible. */
  distanceM: number;
  driveSeconds: number;
}

export interface Hud {
  /** HUD container (the minimap is mounted inside it, so it shows / hides with the HUD). */
  readonly el: HTMLElement;
  readonly visible: boolean;
  show(): void;
  hide(): void;
  update(t: VehicleTelemetry, info: HudInfo): void;
  /** Adapts the dial (top speed, redline, electric) to the driven car. */
  setCar(spec: CarSpec | null): void;
  /** The spec passed to setCar (null before). */
  readonly spec: CarSpec | null;
  /** F3 overlay with fps / frame time / draw calls / triangles. Toggles when `on` is omitted. */
  toggleFps(on?: boolean): void;
  readonly fpsVisible: boolean;
  /** Last speed passed to update() (km/u, absolute) — used by the minimap zoom. */
  readonly speedKmh: number;
  setRoadLookup(l: RoadLookup | null): void;
  /** Gearbox / assist settings: gear display prefix (D / M) and the "ESP OFF" / ABS lights. */
  setDriving(p: Readonly<DrivingPrefs>): void;
  /** Last known position / heading / street (for the pause overview). */
  status(): HudStatus;
  dispose(): void;
}

const A0 = Math.PI * 0.75; // dial start angle (canvas, clockwise from +x): bottom-left
const SWEEP = Math.PI * 1.5;

interface Dial {
  maxKmh: number;
  majorStep: number;
  labelStep: number;
  maxRpm: number;
  redline: number;
  electric: boolean;
}

function dialFor(spec: CarSpec | null): Dial {
  const top = spec?.topSpeedKmh ?? 200;
  const maxKmh = clamp(Math.ceil((top + 15) / 20) * 20, 160, 280);
  const redline = spec?.redlineRpm ?? 6500;
  return {
    maxKmh,
    majorStep: 20,
    labelStep: maxKmh > 200 ? 40 : 20,
    maxRpm: Math.ceil((redline + 600) / 1000) * 1000,
    redline,
    electric: !!spec?.electric,
  };
}

export function createHud(parent: HTMLElement, engine: Engine): Hud {
  const signText = h('span', 'ad-street-text');
  const sign = h('div', 'ad-street is-empty', h('div', 'ad-street-plate', signText));
  const fps = h('div', 'ad-fps');
  const canvas = h('canvas', 'ad-speedo-canvas');
  const speedEl = h('div', 'ad-speed ad-num', '0');
  const unitEl = h('div', 'ad-speed-unit', 'km/u');
  const gearMode = h('span', 'ad-gear-mode');
  const gearNum = h('span', null, 'N');
  const gearEl = h('div', 'ad-gear ad-num', gearMode, gearNum);
  // warning lights (telltales), invisible while off
  const tt = (cls: string, svg: string, title: string) => {
    const e = h('div', `ad-tt ${cls}`, fromHTML(svg));
    e.title = title;
    return e;
  };
  const ttHead = tt('tt-green', TELLTALES.lowBeam, 'Dimlicht');
  const ttPark = tt('tt-red', TELLTALES.handbrake, 'Handrem');
  const ttAbs = tt('tt-amber', TELLTALES.abs, 'ABS');
  const ttEsp = tt('tt-amber is-blink', TELLTALES.esp, 'ESP'); // only lit while intervening
  const ttEspOff = tt('tt-amber', TELLTALES.espOff, 'ESP uit');
  const telltales = h('div', 'ad-tts', h('div', 'ad-tts-l', ttPark, ttHead), h('div', 'ad-tts-r', ttAbs, ttEsp, ttEspOff));
  const rpmLabel = h('div', 'ad-rpm-label', 'tpm ×1000');
  const limitNum = h('span', 'ad-num');
  const limit = h('div', 'ad-limit is-hidden', limitNum);
  const speedo = h(
    'div',
    'ad-speedo',
    canvas,
    h('div', 'ad-speedo-center', speedEl, unitEl),
    h('div', 'ad-gear-box', gearEl),
    telltales,
    rpmLabel,
    limit,
  );
  const el = h('div', 'ad-hud is-hidden', sign, fps, speedo);
  parent.append(el);

  let visible = false;
  let fpsOn = false;
  let fpsTimer = 0;
  let dial = dialFor(null);
  let carSpec: CarSpec | null = null;
  let staticLayer: HTMLCanvasElement | null = null;
  let size = 0;
  let lookup: RoadLookup | null = null;

  // display state
  let dispSpeed = 0;
  let dispRpm = 0;
  let drawnSpeed = -1;
  let drawnRpm = -1;
  let shownSpeedInt = -1;
  let shownGear = '';
  let shiftOn = false;
  let lastT = 0;
  let speedAbs = 0;
  let curStreet: string | null = null;
  let pendingStreet: string | null = null;
  let streetTimer = 0;
  let lookupT = 0;
  let lookupName: string | null = null;
  let lookupLimit: number | null = null;
  let shownLimit = -1;
  let overLimit = false;
  let drivingPrefs: Readonly<DrivingPrefs> | null = null;
  let absUntil = 0;
  let espUntil = 0;
  // telltale bit mask currently shown (head 1, park 2, abs 4, abs-blink 8, esp 16, esp-off 32)
  let ttMask = -1;
  const last: HudStatus = { x: 0, z: 0, heading: 0, street: null, hasPosition: false, distanceM: 0, driveSeconds: 0 };

  function buildStatic(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = canvas.clientWidth;
    if (!css) return;
    size = Math.round(css * dpr);
    canvas.width = canvas.height = size;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const cx = size / 2;
    const R = size / 2 - 1 * dpr;
    // glass disc
    const grad = g.createRadialGradient(cx, cx * 0.85, R * 0.1, cx, cx, R);
    grad.addColorStop(0, 'rgba(24,29,38,0.84)');
    grad.addColorStop(0.7, 'rgba(12,15,21,0.78)');
    grad.addColorStop(1, 'rgba(8,10,14,0.66)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cx, R, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 1.2 * dpr;
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.stroke();
    // inner hairline ring
    g.beginPath();
    g.arc(cx, cx, R * 0.795, A0, A0 + SWEEP);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.stroke();
    // speed ticks + numerals
    const { maxKmh, labelStep } = dial;
    g.lineCap = 'butt';
    for (let v = 0; v <= maxKmh + 0.01; v += 10) {
      const a = A0 + (v / maxKmh) * SWEEP;
      const major = v % 20 === 0;
      const r0 = R * (major ? 0.83 : 0.875);
      const r1 = R * 0.93;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cx + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1);
      g.lineWidth = (major ? 2.4 : 1.3) * dpr;
      g.strokeStyle = major ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.38)';
      g.stroke();
      if (v % labelStep === 0) {
        const rl = R * 0.7;
        g.font = `600 ${Math.round(R * 0.105)}px Bahnschrift, "Segoe UI", sans-serif`;
        g.fillStyle = 'rgba(255,255,255,0.78)';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(String(v), cx + Math.cos(a) * rl, cx + Math.sin(a) * rl);
      }
    }
    // rpm track
    const rr = R * 0.56;
    g.lineWidth = R * 0.034;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(cx, cx, rr, A0 + 0.06, A0 + SWEEP - 0.06);
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.stroke();
    if (!dial.electric) {
      const ra = A0 + 0.06 + (dial.redline / dial.maxRpm) * (SWEEP - 0.12);
      g.beginPath();
      g.arc(cx, cx, rr, ra, A0 + SWEEP - 0.06);
      g.strokeStyle = 'rgba(212,32,44,0.6)';
      g.stroke();
      // 1000 rpm ticks
      g.lineCap = 'butt';
      for (let k = 0; k <= dial.maxRpm; k += 1000) {
        const a = A0 + 0.06 + (k / dial.maxRpm) * (SWEEP - 0.12);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * (rr - R * 0.05), cx + Math.sin(a) * (rr - R * 0.05));
        g.lineTo(cx + Math.cos(a) * (rr - R * 0.028), cx + Math.sin(a) * (rr - R * 0.028));
        g.lineWidth = 1.2 * dpr;
        g.strokeStyle = 'rgba(255,255,255,0.32)';
        g.stroke();
      }
    }
    staticLayer = c;
    drawnSpeed = -1;
  }

  function drawDial(): void {
    if (!staticLayer || !size) return;
    const g = canvas.getContext('2d')!;
    const dpr = size / canvas.clientWidth || 1;
    const cx = size / 2;
    const R = size / 2 - 1 * dpr;
    g.clearRect(0, 0, size, size);
    g.drawImage(staticLayer, 0, 0);
    const f = clamp(dispSpeed / dial.maxKmh, 0, 1);
    const a = A0 + f * SWEEP;
    // progress arc along the rim
    if (f > 0.002) {
      const cg = g.createConicGradient(A0, cx, cx);
      const end = (f * SWEEP) / (Math.PI * 2);
      cg.addColorStop(0, 'rgba(255,255,255,0.04)');
      cg.addColorStop(Math.max(0.0001, end * 0.8), 'rgba(255,255,255,0.55)');
      cg.addColorStop(end, 'rgba(255,70,80,1)');
      cg.addColorStop(Math.min(1, end + 0.0001), 'rgba(255,70,80,0)');
      g.beginPath();
      g.arc(cx, cx, R * 0.965, A0, a);
      g.lineWidth = R * 0.032;
      g.lineCap = 'butt';
      g.strokeStyle = cg;
      g.stroke();
    }
    // needle (outer blade)
    g.save();
    g.shadowColor = 'rgba(255,40,52,0.9)';
    g.shadowBlur = 10 * dpr;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * R * 0.785, cx + Math.sin(a) * R * 0.785);
    g.lineTo(cx + Math.cos(a) * R * 0.975, cx + Math.sin(a) * R * 0.975);
    g.lineWidth = R * 0.03;
    g.lineCap = 'round';
    g.strokeStyle = '#ff3542';
    g.stroke();
    g.restore();
    // rpm fill (or power for EVs)
    const rf = clamp(dispRpm / dial.maxRpm, 0, 1);
    if (rf > 0.004) {
      const rr = R * 0.56;
      g.beginPath();
      g.arc(cx, cx, rr, A0 + 0.06, A0 + 0.06 + rf * (SWEEP - 0.12));
      g.lineWidth = R * 0.034;
      g.lineCap = 'round';
      const red = !dial.electric && dispRpm >= dial.redline;
      g.strokeStyle = red ? '#ff3542' : dial.electric ? 'rgba(70,211,180,0.9)' : 'rgba(255,255,255,0.86)';
      g.stroke();
    }
    drawnSpeed = dispSpeed;
    drawnRpm = dispRpm;
  }

  const ro = new ResizeObserver(() => {
    buildStatic();
    drawDial();
  });
  ro.observe(canvas);

  function setStreet(name: string | null): void {
    if (name === curStreet || name === pendingStreet) return;
    pendingStreet = name;
    window.clearTimeout(streetTimer);
    if (curStreet === null) {
      apply();
      return;
    }
    sign.classList.add('is-out');
    streetTimer = window.setTimeout(apply, 230);
    function apply(): void {
      curStreet = pendingStreet;
      pendingStreet = null;
      if (curStreet) {
        signText.textContent = curStreet;
        sign.classList.remove('is-empty', 'is-out');
      } else {
        sign.classList.add('is-empty');
        sign.classList.remove('is-out');
      }
    }
  }

  function setLimit(v: number | null): void {
    const k = v ?? -1;
    if (k === shownLimit) return;
    shownLimit = k;
    if (v === null) {
      limit.classList.add('is-hidden');
      return;
    }
    limitNum.textContent = String(v);
    limit.classList.remove('is-hidden');
  }

  function updateTelltales(l: HudLights | undefined, now: number): void {
    const a = drivingPrefs?.assists;
    if (l?.abs) absUntil = now + 350;
    if (l?.tcs || l?.esc) espUntil = now + 350;
    const absOff = a ? !a.abs : false;
    const espOff = a ? !a.esc || !a.tcs : false;
    let m = 0;
    if (l?.head) m |= 1;
    if (l?.handbrake) m |= 2;
    if (absOff) m |= 4;
    else if (now < absUntil) m |= 4 | 8;
    if (espOff) m |= 32;
    else if (now < espUntil) m |= 16;
    if (m === ttMask) return;
    ttMask = m;
    ttHead.classList.toggle('is-on', !!(m & 1));
    ttPark.classList.toggle('is-on', !!(m & 2));
    ttAbs.classList.toggle('is-on', !!(m & 4));
    ttAbs.classList.toggle('is-blink', !!(m & 8));
    ttEsp.classList.toggle('is-on', !!(m & 16));
    ttEspOff.classList.toggle('is-on', !!(m & 32));
  }

  function updateFps(): void {
    const s = engine.stats;
    const tri = s.triangles >= 1e6 ? `${fmt(s.triangles / 1e6, 1)} M` : `${fmt(s.triangles / 1e3)} k`;
    fps.innerHTML =
      `<b>${Math.round(s.fps)}</b> fps<i>·</i>${fmt(s.frameMs, 1)} ms<i>·</i>${fmt(s.drawCalls)} draw calls<i>·</i>${tri} driehoeken` +
      `<i>·</i>${engine.quality.level}`;
  }

  return {
    el,
    get visible() {
      return visible;
    },
    get fpsVisible() {
      return fpsOn;
    },
    get speedKmh() {
      return speedAbs;
    },
    show() {
      if (visible) return;
      visible = true;
      el.classList.remove('is-hidden');
      if (!staticLayer) buildStatic();
      drawDial();
    },
    hide() {
      if (!visible) return;
      visible = false;
      el.classList.add('is-hidden');
    },
    update(t, info) {
      const now = performance.now();
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
      lastT = now;
      if (last.hasPosition && visible) {
        const step = Math.hypot(info.x - last.x, info.z - last.z);
        if (step < 30) last.distanceM += step; // larger jumps are teleports / respawns
        last.driveSeconds += dt;
      }
      last.x = info.x;
      last.z = info.z;
      last.heading = info.heading;
      last.hasPosition = true;
      speedAbs = Math.abs(t.speedKmh);
      const k = 1 - Math.exp(-dt * 16);
      dispSpeed += (speedAbs - dispSpeed) * k;
      const rpmTarget = dial.electric ? clamp(t.throttle, 0, 1) * dial.maxRpm * 0.95 : t.rpm;
      dispRpm += (rpmTarget - dispRpm) * (1 - Math.exp(-dt * 20));
      if (!visible) return;

      const si = Math.round(speedAbs);
      if (si !== shownSpeedInt) {
        shownSpeedInt = si;
        speedEl.textContent = String(si);
      }
      // gear: R / N, electric 'D', otherwise number with a small D (automaat) or M (handgeschakeld)
      const mode = info.gearboxMode ?? drivingPrefs?.gearbox ?? 'auto';
      const fwd = t.gear > 0 && !dial.electric;
      const gearKey = t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : dial.electric ? 'D' : mode === 'manual' ? `M${t.gear}` : `D${t.gear}`;
      if (gearKey !== shownGear) {
        shownGear = gearKey;
        gearMode.textContent = fwd ? gearKey[0] : '';
        gearNum.textContent = fwd ? gearKey.slice(1) : gearKey;
        gearEl.classList.toggle('is-r', gearKey === 'R');
      }
      updateTelltales(info.lights, now);
      const shift = !dial.electric && t.gear > 0 && t.rpm > dial.redline * 0.95;
      if (shift !== shiftOn) {
        shiftOn = shift;
        speedo.classList.toggle('is-shift', shift);
      }
      if (Math.abs(dispSpeed - drawnSpeed) > 0.04 || Math.abs(dispRpm - drawnRpm) > 8) drawDial();

      // own road lookup at ~5 Hz
      if (lookup && now - lookupT > 200) {
        lookupT = now;
        const e = lookup.nearest(info.x, info.z, 14);
        lookupName = e?.name ?? null;
        lookupLimit = e && e.speed > 0 ? Math.round((e.speed * 3.6) / 5) * 5 : null;
        if (lookupLimit !== null && (lookupLimit < 20 || lookupLimit > 130)) lookupLimit = null;
      }
      setStreet(info.streetName !== undefined ? info.streetName || null : lookupName);
      const lim = info.speedLimitKmh !== undefined ? info.speedLimitKmh : lookupLimit;
      setLimit(lim ?? null);
      const over = lim != null && speedAbs > lim + 4;
      if (over !== overLimit) {
        overLimit = over;
        limit.classList.toggle('is-over', over);
      }

      if (fpsOn && now - fpsTimer > 250) {
        fpsTimer = now;
        updateFps();
      }
    },
    get spec() {
      return carSpec;
    },
    setCar(spec) {
      carSpec = spec;
      dial = dialFor(spec);
      rpmLabel.textContent = dial.electric ? 'vermogen' : 'tpm ×1000';
      shownGear = '';
      buildStatic();
      drawDial();
    },
    toggleFps(on) {
      fpsOn = on ?? !fpsOn;
      fps.classList.toggle('is-on', fpsOn);
      if (fpsOn) updateFps();
    },
    setRoadLookup(l) {
      lookup = l;
    },
    setDriving(p) {
      drivingPrefs = p;
      shownGear = '';
      ttMask = -1;
    },
    status() {
      last.street = pendingStreet ?? curStreet;
      return last;
    },
    dispose() {
      ro.disconnect();
      window.clearTimeout(streetTimer);
      el.remove();
    },
  };
}
