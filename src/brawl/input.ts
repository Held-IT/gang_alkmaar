// Human fighter input: keyboard + mouse + Xbox gamepad → BeastInput, movement relative to the
// camera (stick up = into the screen). Default binds follow the reference engine
// (reference/gang-beasts-rust/crates/gb_game/src/binds.rs + play.rs kbm_raw/pad_raw):
//   keyboard: WASD / arrows move, Space jump, C or Ctrl duck, F kick, Left Shift lift,
//             left / right mouse button = left / right hand (tap = punch, hold = grab);
//   extras:   Q / E = left / right hand (touchpads), middle mouse = lift, Esc = pause;
//   gamepad:  left stick move, A jump, B duck, X kick, Y lift, LB/LT left hand, RB/RT right hand,
//             Start pause.
import * as THREE from 'three';
import type { BeastInput } from './contracts';
import { PAD, type PadReader } from './pad';

export interface BindingRow {
  action: string;
  keys: string;
  pad: string;
}

/** Shown in the lobby ("Besturing") and in the pause menu. */
export const BINDINGS: BindingRow[] = [
  { action: 'Lopen (blijf even dezelfde kant op lopen: rennen)', keys: 'W A S D / pijltjes', pad: 'Linkerstick' },
  { action: 'Springen', keys: 'Spatie', pad: 'A' },
  { action: 'Bukken (tik bij tegenstander: kopstoot)', keys: 'C / Ctrl', pad: 'B' },
  { action: 'Schoppen', keys: 'F', pad: 'X' },
  { action: 'Optillen (loslaten = gooien)', keys: 'Shift / middelste muisknop', pad: 'Y' },
  { action: 'Linkerhand (tik = stoot, vasthouden = grijpen)', keys: 'Linkermuisknop / Q', pad: 'LB / LT' },
  { action: 'Rechterhand (tik = stoot, vasthouden = grijpen)', keys: 'Rechtermuisknop / E', pad: 'RB / RT' },
  { action: 'Pauze', keys: 'Esc', pad: 'Start' },
];

/** seconds of steady full movement before the beast starts to run */
const RUN_DELAY = 0.65;

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
  'KeyC', 'ControlLeft', 'ControlRight', 'KeyF', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE',
]);

export interface HumanInput {
  /** This frame's input; `camera` defines "forward" for the movement keys / stick. */
  read(camera: THREE.Camera): BeastInput;
  /** When disabled (menus, countdown) read() returns a neutral input. */
  setEnabled(enabled: boolean): void;
  readonly usingGamepad: boolean;
  dispose(): void;
}

export function createHumanInput(canvas: HTMLElement, pad: PadReader): HumanInput {
  const keys = new Set<string>();
  const mouse = [false, false, false];
  let enabled = true;
  let lastKeyboard = 0;
  const out: BeastInput = { moveX: 0, moveZ: 0, jump: false, duck: false, lift: false, kick: false, grabLeft: false, grabRight: false, run: false };
  const dir = new THREE.Vector3();
  // auto-run: a full move held in (roughly) one direction for RUN_DELAY s runs (bots run too)
  let runT = 0;
  let runX = 0;
  let runZ = 0;
  let lastRead = performance.now();

  const isTyping = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    keys.add(e.code);
    lastKeyboard = performance.now();
    if (enabled && GAME_KEYS.has(e.code)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onMouseDown = (e: MouseEvent) => {
    if (e.button <= 2) mouse[e.button] = true;
    lastKeyboard = performance.now();
    if (enabled && e.button === 1) e.preventDefault();
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button <= 2) mouse[e.button] = false;
  };
  const onBlur = () => {
    keys.clear();
    mouse.fill(false);
  };
  const onContext = (e: Event) => e.preventDefault();
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('contextmenu', onContext);

  const k = (...codes: string[]) => codes.some((c) => keys.has(c));

  return {
    read(camera) {
      if (!enabled) {
        runT = 0;
        out.run = false;
        out.moveX = out.moveZ = 0;
        out.jump = out.duck = out.lift = out.kick = out.grabLeft = out.grabRight = false;
        return out;
      }
      let h = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
      let v = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
      if (h !== 0 && v !== 0) {
        h *= Math.SQRT1_2;
        v *= Math.SQRT1_2;
      }
      if (pad.lx !== 0 || pad.ly !== 0) {
        h = pad.lx;
        v = -pad.ly;
      }
      camera.getWorldDirection(dir);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      // forward f = (dir.x, dir.z); screen right r = (-f.z, f.x)
      out.moveX = dir.x * v - dir.z * h;
      out.moveZ = dir.z * v + dir.x * h;
      out.jump = k('Space') || pad.held(PAD.A);
      out.duck = k('KeyC', 'ControlLeft', 'ControlRight') || pad.held(PAD.B);
      out.kick = k('KeyF') || pad.held(PAD.X);
      out.lift = k('ShiftLeft', 'ShiftRight') || mouse[1] || pad.held(PAD.Y);
      out.grabLeft = mouse[0] || k('KeyQ') || pad.held(PAD.LB) || pad.lt > 0.3;
      out.grabRight = mouse[2] || k('KeyE') || pad.held(PAD.RB) || pad.rt > 0.3;
      const now = performance.now();
      const rdt = Math.min(0.1, (now - lastRead) / 1000);
      lastRead = now;
      const mag = Math.hypot(out.moveX, out.moveZ);
      if (mag > 0.85) {
        // a sharp turn drops back to walking; gentle curves keep running
        if (runT > 0 && (out.moveX * runX + out.moveZ * runZ) / mag < 0.7) runT = 0;
        runX = out.moveX / mag;
        runZ = out.moveZ / mag;
        runT += rdt;
      } else runT = 0;
      out.run = runT > RUN_DELAY && !out.duck && !out.lift;
      return out;
    },
    setEnabled(e) {
      enabled = e;
    },
    get usingGamepad() {
      return pad.connected && pad.idle < (performance.now() - lastKeyboard) / 1000;
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('contextmenu', onContext);
    },
  };
}
