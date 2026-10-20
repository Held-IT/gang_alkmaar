// Keyboard + Xbox gamepad input for the player car (owned by the Vehicle module).
//
// Keyboard (physical key positions via KeyboardEvent.code, so it works on any layout):
//   W / ArrowUp = gas, S / ArrowDown = rem (achteruit bij stilstand), A D / arrows = sturen,
//   Space = handrem, Shift = opschakelen, Ctrl = terugschakelen, R = reset, L = lichten,
//   H = claxon, C = camera, M = kaart, Esc = pauze.
// Gamepad (standard mapping): RT gas, LT rem, left stick sturen, A handrem, B reset, X lichten,
//   Y camera, LB/RB schakelen, Start pauze, View kaart, left stick click = claxon.
//   A button still held when input is (re)enabled (e.g. B that closed the pause menu) is ignored
//   until released.
import type { Engine, VehicleInput } from '../contracts';

export type InputAction = 'camera' | 'pause' | 'reset' | 'lights' | 'horn' | 'map';

export interface InputController {
  /** Current smoothed vehicle input. One-shot fields are true only once per press. */
  read(): VehicleInput;
  /** Subscribe to discrete actions (fired on key / button press). Returns an unsubscribe fn. */
  onAction(name: InputAction, fn: () => void): () => void;
  /** Disable while menus are open: read() returns a neutral input and actions stay silent
   *  (except 'pause', which always fires so menus can be closed with Esc / Start). */
  setEnabled(enabled: boolean): void;
  /** True when a gamepad delivered input recently (for UI hints). */
  readonly usingGamepad: boolean;
  dispose(): void;
}

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'KeyR', 'KeyL', 'KeyH', 'KeyC', 'KeyM', 'Escape',
]);

const ACTION_KEYS: Record<string, InputAction> = {
  KeyC: 'camera',
  Escape: 'pause',
  KeyR: 'reset',
  KeyL: 'lights',
  KeyH: 'horn',
  KeyM: 'map',
};

// Standard gamepad button indices.
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, START: 9, LS: 10 } as const;

const STICK_DEADZONE = 0.12;
const TRIGGER_DEADZONE = 0.04;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function deadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return (Math.sign(v) * (a - dz)) / (1 - dz);
}

export function createInput(engine: Engine): InputController {
  const down = new Set<string>();
  const listeners = new Map<InputAction, Set<() => void>>();
  let enabled = true;
  let usingGamepad = false;

  // Smoothed keyboard axes.
  let kbSteer = 0;
  let kbThrottle = 0;
  let kbBrake = 0;
  // One-shot requests (consumed by read()).
  const oneShot = { shiftUp: false, shiftDown: false, reset: false, toggleLights: false };
  const prevButtons: boolean[] = [];
  /** Buttons that were already held when input was (re)enabled: ignored until released, so the
   *  B / A / Start press that closed a menu does not also reset the car, pull the handbrake or
   *  pause again on the first driving frame. */
  const latched: boolean[] = [];
  let resync = true;
  let lastRead = performance.now();

  function emit(name: InputAction): void {
    if (!enabled && name !== 'pause') return;
    const set = listeners.get(name);
    if (set) for (const fn of [...set]) fn();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target)) return;
    if (!GAME_KEYS.has(e.code)) return;
    e.preventDefault();
    if (e.repeat) return;
    down.add(e.code);
    usingGamepad = false;
    if (!enabled) {
      if (e.code === 'Escape') emit('pause');
      return;
    }
    switch (e.code) {
      case 'ShiftLeft':
      case 'ShiftRight':
        oneShot.shiftUp = true;
        break;
      case 'ControlLeft':
      case 'ControlRight':
        oneShot.shiftDown = true;
        break;
      case 'KeyR':
        oneShot.reset = true;
        break;
      case 'KeyL':
        oneShot.toggleLights = true;
        break;
    }
    const action = ACTION_KEYS[e.code];
    if (action) emit(action);
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (GAME_KEYS.has(e.code)) down.delete(e.code);
  }

  function clearKeys(): void {
    down.clear();
  }

  function onVisibility(): void {
    if (document.hidden) clearKeys();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', onVisibility);
  // Make sure the canvas can take keyboard focus (Electron / browser).
  if (engine.canvas.tabIndex < 0) engine.canvas.tabIndex = 0;

  const neutral: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  const out: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };

  function approach(cur: number, target: number, rate: number, dt: number): number {
    const d = target - cur;
    const step = rate * dt;
    return Math.abs(d) <= step ? target : cur + Math.sign(d) * step;
  }

  function readGamepad(): Gamepad | null {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  function pressed(p: Gamepad, i: number): boolean {
    const b = p.buttons[i];
    return !!b && (b.pressed || b.value > 0.5);
  }

  const controller: InputController = {
    get usingGamepad() {
      return usingGamepad;
    },

    read(): VehicleInput {
      const now = performance.now();
      // read() not called for a while (paused / menu): button history is stale.
      if (now - lastRead > 1000) resync = true;
      const dt = Math.min(0.1, Math.max(0, (now - lastRead) / 1000));
      lastRead = now;

      // --- gamepad (edge-detected buttons) ---
      const pad = readGamepad();
      let padSteer = 0;
      let padThrottle = 0;
      let padBrake = 0;
      let padHandbrake = false;
      let padHorn = false;
      if (pad) {
        const nb = pad.buttons.length;
        if (resync) {
          // Adopt the current button states without firing edges; held buttons stay latched.
          for (let i = 0; i < nb; i++) prevButtons[i] = latched[i] = pressed(pad, i);
        } else {
          for (let i = 0; i < nb; i++) if (latched[i] && !pressed(pad, i)) latched[i] = false;
        }
        const btn = (i: number) => pressed(pad, i) && !latched[i];
        const edge = (i: number) => {
          const p = btn(i);
          const was = prevButtons[i] ?? false;
          prevButtons[i] = p;
          return p && !was;
        };
        if (edge(BTN.START)) emit('pause');
        if (enabled) {
          if (edge(BTN.Y)) emit('camera');
          if (edge(BTN.B)) {
            oneShot.reset = true;
            emit('reset');
          }
          if (edge(BTN.X)) {
            oneShot.toggleLights = true;
            emit('lights');
          }
          if (edge(BTN.RB)) oneShot.shiftUp = true;
          if (edge(BTN.LB)) oneShot.shiftDown = true;
          if (edge(BTN.VIEW)) emit('map');
          if (edge(BTN.LS)) emit('horn');
        } else {
          for (const i of [BTN.Y, BTN.B, BTN.X, BTN.RB, BTN.LB, BTN.VIEW, BTN.LS]) prevButtons[i] = btn(i);
        }
        const sx = deadzone(pad.axes[0] ?? 0, STICK_DEADZONE);
        // Slight expo for fine control around the centre.
        padSteer = Math.sign(sx) * Math.pow(Math.abs(sx), 1.35);
        padThrottle = deadzone(pad.buttons[BTN.RT]?.value ?? 0, TRIGGER_DEADZONE);
        padBrake = deadzone(pad.buttons[BTN.LT]?.value ?? 0, TRIGGER_DEADZONE);
        padHandbrake = btn(BTN.A);
        padHorn = btn(BTN.LS);
        if (Math.abs(padSteer) > 0.05 || padThrottle > 0.05 || padBrake > 0.05 || padHandbrake) usingGamepad = true;
      }

      resync = false;

      if (!enabled) {
        kbSteer = kbThrottle = kbBrake = 0;
        oneShot.shiftUp = oneShot.shiftDown = oneShot.reset = oneShot.toggleLights = false;
        return neutral;
      }

      // --- keyboard (rate limited for smooth, natural steering) ---
      const left = down.has('KeyA') || down.has('ArrowLeft');
      const right = down.has('KeyD') || down.has('ArrowRight');
      const gas = down.has('KeyW') || down.has('ArrowUp');
      const brake = down.has('KeyS') || down.has('ArrowDown');
      const steerTarget = (right ? 1 : 0) - (left ? 1 : 0);
      // Faster when returning to centre or reversing direction than when turning in.
      const returning = steerTarget === 0 || Math.sign(steerTarget) !== Math.sign(kbSteer);
      kbSteer = approach(kbSteer, steerTarget, returning ? 5.5 : 2.6, dt);
      kbThrottle = approach(kbThrottle, gas ? 1 : 0, gas ? 5 : 9, dt);
      kbBrake = approach(kbBrake, brake ? 1 : 0, brake ? 6 : 10, dt);

      const padActive = Math.abs(padSteer) > 0.02 || padThrottle > 0.02 || padBrake > 0.02;
      out.steer = Math.abs(padSteer) > Math.abs(kbSteer) ? padSteer : kbSteer;
      out.throttle = Math.max(kbThrottle, padThrottle);
      out.brake = Math.max(kbBrake, padBrake);
      out.handbrake = down.has('Space') || padHandbrake;
      out.horn = down.has('KeyH') || padHorn;
      out.shiftUp = oneShot.shiftUp;
      out.shiftDown = oneShot.shiftDown;
      out.reset = oneShot.reset;
      out.toggleLights = oneShot.toggleLights;
      oneShot.shiftUp = oneShot.shiftDown = oneShot.reset = oneShot.toggleLights = false;
      if (padActive) usingGamepad = true;
      return out;
    },

    onAction(name, fn) {
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(fn);
      return () => {
        listeners.get(name)?.delete(fn);
      };
    },

    setEnabled(e: boolean) {
      if (e && !enabled) resync = true;
      enabled = e;
      if (!e) clearKeys();
    },

    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', onVisibility);
      listeners.clear();
    },
  };
  return controller;
}
