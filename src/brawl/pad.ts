// Gamepad polling shared by the fight input and the menu navigation (standard mapping, Xbox
// layout): call poll() once per frame, then read held / pressed edges and stick directions.
export const PAD = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
} as const;

export type NavDir = 'up' | 'down' | 'left' | 'right';

export interface PadReader {
  poll(dt: number): void;
  readonly connected: boolean;
  /** seconds since the pad last delivered any input (Infinity = never) */
  readonly idle: number;
  readonly lx: number;
  readonly ly: number;
  readonly lt: number;
  readonly rt: number;
  held(button: number): boolean;
  pressed(button: number): boolean;
  /** Menu direction edge (d-pad or left stick), with auto-repeat while held. */
  navDir(): NavDir | null;
}

export function createPadReader(): PadReader {
  const held = new Array<boolean>(20).fill(false);
  const prev = new Array<boolean>(20).fill(false);
  let connected = false;
  let idle = Infinity;
  let lx = 0;
  let ly = 0;
  let lt = 0;
  let rt = 0;
  let dir: NavDir | null = null;
  let dirHeld: NavDir | null = null;
  let repeat = 0;
  return {
    poll(dt) {
      for (let i = 0; i < held.length; i++) prev[i] = held[i];
      const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      let pad: Gamepad | null = null;
      for (const p of pads) if (p && p.connected && (!pad || p.timestamp > pad.timestamp)) pad = p;
      connected = !!pad;
      idle += dt;
      dir = null;
      if (!pad) {
        held.fill(false);
        lx = ly = lt = rt = 0;
        dirHeld = null;
        return;
      }
      let any = false;
      for (let i = 0; i < held.length; i++) {
        const b = pad.buttons[i];
        const v = b ? b.pressed || b.value > 0.35 : false;
        held[i] = v;
        if (v) any = true;
      }
      lt = pad.buttons[PAD.LT]?.value ?? 0;
      rt = pad.buttons[PAD.RT]?.value ?? 0;
      let x = pad.axes[0] ?? 0;
      let y = pad.axes[1] ?? 0;
      const m = Math.hypot(x, y);
      if (m < 0.18) x = y = 0;
      else {
        // radial dead zone, rescaled to 0..1
        const k = Math.min(1, (m - 0.18) / 0.77) / m;
        x *= k;
        y *= k;
      }
      lx = x;
      ly = y;
      if (any || x !== 0 || y !== 0) idle = 0;
      // navigation direction (d-pad first, then the stick)
      let d: NavDir | null = null;
      if (held[PAD.UP]) d = 'up';
      else if (held[PAD.DOWN]) d = 'down';
      else if (held[PAD.LEFT]) d = 'left';
      else if (held[PAD.RIGHT]) d = 'right';
      else if (Math.abs(y) > 0.6 && Math.abs(y) > Math.abs(x)) d = y < 0 ? 'up' : 'down';
      else if (Math.abs(x) > 0.6) d = x < 0 ? 'left' : 'right';
      if (d !== dirHeld) {
        dirHeld = d;
        dir = d;
        repeat = 0.42;
      } else if (d) {
        repeat -= dt;
        if (repeat <= 0) {
          dir = d;
          repeat = 0.11;
        }
      }
    },
    get connected() {
      return connected;
    },
    get idle() {
      return idle;
    },
    get lx() {
      return lx;
    },
    get ly() {
      return ly;
    },
    get lt() {
      return lt;
    },
    get rt() {
      return rt;
    },
    held: (b) => held[b] ?? false,
    pressed: (b) => (held[b] ?? false) && !(prev[b] ?? false),
    navDir: () => dir,
  };
}
