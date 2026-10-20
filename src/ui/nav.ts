// Focus navigation for menus: keyboard (arrows / Enter / Esc / Q-E), gamepad (D-pad / left stick /
// A / B / LB-RB, polled through the Gamepad API) and mouse hover. Screens push a NavLayer onto
// the controller's stack; only the top layer receives input.
//
// Keys handled while a layer is active are consumed in the capture phase on `window`
// (preventDefault + stopImmediatePropagation) so game input listeners never see them.

export type Dir = -1 | 1;
export type InputDevice = 'kb' | 'pad';

export interface NavItem {
  el: HTMLElement;
  /** Enter / A. Defaults to `el.click()`. */
  activate?: () => void;
  /** Left / right on this item adjusts a value instead of moving focus (sliders, selectors). */
  adjust?: (dir: Dir) => void;
  /** Called when the item gets focus. `byPointer` is true for mouse hover. */
  onFocus?: (byPointer: boolean) => void;
}

export interface NavLayerOptions {
  /** Esc / Backspace / gamepad B. */
  onBack?: () => void;
  /** Q / E, PageUp / PageDown, gamepad LB / RB. */
  onBumper?: (dir: Dir) => void;
  /** Raw key hook, runs before navigation. Return true when the key was consumed. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** Per-frame gamepad hook while this layer is on top (analog panning etc.). */
  onPadFrame?: (pad: Gamepad, dt: number) => void;
  /** Column to focus when entering a row vertically (e.g. the selected car); default: geometric nearest. */
  preferCol?: (row: number) => number | undefined;
  /** Wrap from the last row to the first and back. */
  wrap?: boolean;
}

export class NavLayer {
  rows: NavItem[][] = [];
  row = 0;
  col = 0;
  private index = new Map<HTMLElement, [number, number]>();

  constructor(public opts: NavLayerOptions = {}) {}

  /** Replace the rows. Focus goes to `focus` (row, col) or stays clamped where it was. */
  setRows(rows: NavItem[][], focus?: [number, number]): void {
    this.current()?.el.classList.remove('is-focus');
    this.rows = rows.filter((r) => r.length > 0);
    this.index.clear();
    this.rows.forEach((r, ri) =>
      r.forEach((it, ci) => {
        it.el.dataset.nav = '1';
        this.index.set(it.el, [ri, ci]);
      }),
    );
    const [r, c] = focus ?? [this.row, this.col];
    this.focus(r, c, false, true);
  }

  current(): NavItem | undefined {
    return this.rows[this.row]?.[this.col];
  }

  focus(row: number, col: number, byPointer = false, silent = false): void {
    if (!this.rows.length) return;
    row = Math.max(0, Math.min(this.rows.length - 1, row));
    col = Math.max(0, Math.min(this.rows[row].length - 1, col));
    const prev = this.current();
    this.row = row;
    this.col = col;
    const it = this.current()!;
    if (prev && prev !== it) prev.el.classList.remove('is-focus');
    it.el.classList.add('is-focus');
    if (!byPointer) revealInScroller(it.el);
    if (!silent) it.onFocus?.(byPointer);
  }

  focusEl(el: HTMLElement): void {
    const p = this.index.get(el);
    if (p) this.focus(p[0], p[1]);
  }

  locate(el: Element | null): [number, number] | null {
    while (el && el !== document.body) {
      const p = this.index.get(el as HTMLElement);
      if (p) return p;
      el = el.parentElement;
    }
    return null;
  }

  vertical(d: Dir): void {
    if (!this.rows.length) return;
    let r = this.row + d;
    if (r < 0 || r >= this.rows.length) {
      if (!this.opts.wrap) return;
      r = (r + this.rows.length) % this.rows.length;
    }
    let c = this.opts.preferCol?.(r);
    if (c === undefined) c = this.nearestCol(r);
    this.focus(r, c);
  }

  horizontal(d: Dir): void {
    const it = this.current();
    if (!it) return;
    if (it.adjust) {
      it.adjust(d);
      return;
    }
    const c = this.col + d;
    if (c >= 0 && c < this.rows[this.row].length) this.focus(this.row, c);
  }

  activate(): void {
    const it = this.current();
    if (!it) return;
    if (it.activate) it.activate();
    else it.el.click();
  }

  private nearestCol(r: number): number {
    const cur = this.current();
    const row = this.rows[r];
    if (!cur || row.length === 1) return 0;
    const a = cur.el.getBoundingClientRect();
    const cx = a.left + a.width / 2;
    let best = 0;
    let bestD = Infinity;
    row.forEach((it, i) => {
      const b = it.el.getBoundingClientRect();
      const d = Math.abs(b.left + b.width / 2 - cx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
}

// Standard gamepad mapping indices.
const BTN_A = 0, BTN_B = 1, BTN_LB = 4, BTN_RB = 5, BTN_UP = 12, BTN_DOWN = 13, BTN_LEFT = 14, BTN_RIGHT = 15;
const STICK = 0.55;
const REPEAT_DELAY = 0.36;
const REPEAT_EVERY = 0.11;

export class NavController {
  private stack: NavLayer[] = [];
  private prevButtons: boolean[] = [];
  private dirHeld = [0, 0, 0, 0]; // up, down, left, right: seconds held (0 = not held)
  private dirNext = [0, 0, 0, 0];
  private raf = 0;
  private lastT = 0;
  private lastMouse = { x: -1, y: -1 };
  device: InputDevice = 'kb';
  private deviceListeners = new Set<(d: InputDevice) => void>();

  constructor(private root: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown, true);
    root.addEventListener('pointerover', this.onPointerOver);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    root.dataset.input = this.device;
    this.raf = requestAnimationFrame(this.poll);
  }

  get active(): boolean {
    return this.stack.length > 0;
  }
  get top(): NavLayer | undefined {
    return this.stack[this.stack.length - 1];
  }

  push(layer: NavLayer): void {
    this.remove(layer);
    this.stack.push(layer);
  }
  remove(layer: NavLayer): void {
    const i = this.stack.indexOf(layer);
    if (i >= 0) this.stack.splice(i, 1);
  }
  has(layer: NavLayer): boolean {
    return this.stack.includes(layer);
  }

  onDevice(fn: (d: InputDevice) => void): () => void {
    this.deviceListeners.add(fn);
    return () => this.deviceListeners.delete(fn);
  }

  private setDevice(d: InputDevice): void {
    if (this.device === d) return;
    this.device = d;
    this.root.dataset.input = d;
    this.deviceListeners.forEach((f) => f(d));
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (Math.abs(e.clientX - this.lastMouse.x) + Math.abs(e.clientY - this.lastMouse.y) > 6 && this.lastMouse.x >= 0) {
      this.setDevice('kb');
    }
    this.lastMouse.x = e.clientX;
    this.lastMouse.y = e.clientY;
  };

  private onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const layer = this.top;
    if (!layer) return;
    const p = layer.locate(e.target as Element);
    if (p && (p[0] !== layer.row || p[1] !== layer.col)) layer.focus(p[0], p[1], true);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt') this.setDevice('kb');
    const layer = this.top;
    if (!layer) return;
    if (layer.opts.onKey?.(e)) {
      consume(e);
      return;
    }
    switch (e.key) {
      case 'ArrowUp':
        layer.vertical(-1);
        break;
      case 'ArrowDown':
        layer.vertical(1);
        break;
      case 'ArrowLeft':
        layer.horizontal(-1);
        break;
      case 'ArrowRight':
        layer.horizontal(1);
        break;
      case 'Tab':
        layer.vertical(e.shiftKey ? -1 : 1);
        break;
      case 'Enter':
      case ' ':
        if (!e.repeat) layer.activate();
        break;
      case 'Escape':
      case 'Backspace':
        if (!e.repeat) layer.opts.onBack?.();
        break;
      case 'q':
      case 'Q':
      case 'PageUp':
        if (!layer.opts.onBumper) return;
        layer.opts.onBumper(-1);
        break;
      case 'e':
      case 'E':
      case 'PageDown':
        if (!layer.opts.onBumper) return;
        layer.opts.onBumper(1);
        break;
      default:
        return;
    }
    consume(e);
  };

  private poll = (t: number): void => {
    this.raf = requestAnimationFrame(this.poll);
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0;
    this.lastT = t;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) return;
    const pressed = (i: number) => !!pad!.buttons[i]?.pressed;
    const edge = (i: number) => pressed(i) && !this.prevButtons[i];
    let any = false;
    for (let i = 0; i < pad.buttons.length; i++) if (pad.buttons[i].pressed) any = true;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    if (any || Math.abs(ax) > 0.5 || Math.abs(ay) > 0.5) this.setDevice('pad');

    const layer = this.top;
    if (layer) {
      layer.opts.onPadFrame?.(pad, dt);
      const dirs = [
        pressed(BTN_UP) || ay < -STICK,
        pressed(BTN_DOWN) || ay > STICK,
        pressed(BTN_LEFT) || ax < -STICK,
        pressed(BTN_RIGHT) || ax > STICK,
      ];
      for (let d = 0; d < 4; d++) {
        if (!dirs[d]) {
          this.dirHeld[d] = 0;
          continue;
        }
        let fire = false;
        if (this.dirHeld[d] === 0) {
          fire = true;
          this.dirHeld[d] = 1e-6;
          this.dirNext[d] = REPEAT_DELAY;
        } else {
          this.dirHeld[d] += dt;
          if (this.dirHeld[d] >= this.dirNext[d]) {
            fire = true;
            this.dirNext[d] += REPEAT_EVERY;
          }
        }
        if (!fire) continue;
        if (d === 0) layer.vertical(-1);
        else if (d === 1) layer.vertical(1);
        else if (d === 2) layer.horizontal(-1);
        else layer.horizontal(1);
      }
      // Re-read the top layer: a direction may have closed or opened a screen.
      const l2 = this.top;
      if (l2 === layer) {
        if (edge(BTN_A)) layer.activate();
        else if (edge(BTN_B)) layer.opts.onBack?.();
        else if (edge(BTN_LB)) layer.opts.onBumper?.(-1);
        else if (edge(BTN_RB)) layer.opts.onBumper?.(1);
      }
    } else {
      this.dirHeld.fill(0);
    }
    for (let i = 0; i < pad.buttons.length; i++) this.prevButtons[i] = pad.buttons[i].pressed;
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerover', this.onPointerOver);
    this.stack.length = 0;
  }
}

/**
 * Scrolls the nearest scrollable ancestor (overflow auto/scroll) so `el` is fully visible.
 * Unlike scrollIntoView() this never scrolls overflow:hidden ancestors such as the UI root.
 */
function revealInScroller(el: HTMLElement): void {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const cs = getComputedStyle(p);
    const sx = /(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth;
    const sy = /(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight;
    if (sx || sy) {
      const a = el.getBoundingClientRect();
      const b = p.getBoundingClientRect();
      const pad = 12;
      if (sy) {
        if (a.top < b.top + pad) p.scrollTop -= b.top + pad - a.top;
        else if (a.bottom > b.bottom - pad) p.scrollTop += a.bottom - (b.bottom - pad);
      }
      if (sx) {
        if (a.left < b.left + pad) p.scrollLeft -= b.left + pad - a.left;
        else if (a.right > b.right - pad) p.scrollLeft += a.right - (b.right - pad);
      }
      return;
    }
    p = p.parentElement;
  }
}

function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}
