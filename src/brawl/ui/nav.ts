// Keyboard + gamepad menu navigation: a stack of contexts (lobby, pause, modals); the top one
// gets the input. Items are arranged in rows: up/down change row, left/right change the value
// (or move inside a row of buttons), Enter / A confirms, Esc / B goes back. Mouse hover focuses.
import { PAD, type PadReader } from '../pad';

export interface NavItem {
  el: HTMLElement;
  row: number;
  left?(): void;
  right?(): void;
  confirm?(): void;
  /** a text field: typing goes to it while focused */
  input?: HTMLInputElement;
}

export interface NavContext {
  items: NavItem[];
  back?(): void;
  /** called on any navigation sound-worthy action */
  onMove?(): void;
}

export interface NavHandle {
  focus(index: number): void;
  readonly focused: number;
  setItems(items: NavItem[]): void;
  close(): void;
}

export interface Nav {
  push(ctx: NavContext, focus?: number): NavHandle;
  /** Per-frame gamepad handling. */
  update(pad: PadReader): void;
  readonly depth: number;
}

interface Entry {
  ctx: NavContext;
  focus: number;
  handle: NavHandle;
  cleanups: (() => void)[];
}

export function createNav(): Nav {
  const stack: Entry[] = [];
  const top = () => stack[stack.length - 1] ?? null;

  function applyFocus(e: Entry): void {
    e.ctx.items.forEach((it, i) => it.el.classList.toggle('ga-focus', i === e.focus));
    const it = e.ctx.items[e.focus];
    if (!it) return;
    if (it.input) {
      if (document.activeElement !== it.input) it.input.focus({ preventScroll: true });
    } else if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    it.el.scrollIntoView?.({ block: 'nearest' });
  }

  function wire(e: Entry): void {
    e.cleanups.forEach((c) => c());
    e.cleanups = [];
    e.ctx.items.forEach((it, i) => {
      const enter = () => {
        if (top() !== e || e.focus === i) return;
        e.focus = i;
        applyFocus(e);
      };
      it.el.addEventListener('mouseenter', enter);
      e.cleanups.push(() => it.el.removeEventListener('mouseenter', enter));
    });
  }

  function move(e: Entry, dir: 'up' | 'down' | 'left' | 'right'): void {
    const items = e.ctx.items;
    const cur = items[e.focus];
    if (!cur) return;
    if (dir === 'left' || dir === 'right') {
      const h = dir === 'left' ? cur.left : cur.right;
      if (h) {
        h();
        e.ctx.onMove?.();
        return;
      }
      const rowItems = items.map((it, i) => ({ it, i })).filter((x) => x.it.row === cur.row);
      const k = rowItems.findIndex((x) => x.i === e.focus);
      const n = rowItems[k + (dir === 'left' ? -1 : 1)];
      if (n) {
        e.focus = n.i;
        e.ctx.onMove?.();
        applyFocus(e);
      }
      return;
    }
    const rows = [...new Set(items.map((it) => it.row))].sort((a, b) => a - b);
    const ri = rows.indexOf(cur.row);
    const nextRow = rows[ri + (dir === 'up' ? -1 : 1)];
    if (nextRow === undefined) return;
    const col = items.filter((it) => it.row === cur.row).indexOf(cur);
    const cand = items.map((it, i) => ({ it, i })).filter((x) => x.it.row === nextRow);
    const pick = cand[Math.min(col, cand.length - 1)];
    e.focus = pick.i;
    e.ctx.onMove?.();
    applyFocus(e);
  }

  function confirm(e: Entry): void {
    const it = e.ctx.items[e.focus];
    if (!it) return;
    if (it.input) {
      it.input.blur();
      move(e, 'down');
      return;
    }
    it.confirm?.();
  }

  window.addEventListener(
    'keydown',
    (ev) => {
      const e = top();
      if (!e) return;
      const it = e.ctx.items[e.focus];
      const typing = !!it?.input && document.activeElement === it.input;
      const code = ev.code;
      let handled = true;
      if (code === 'ArrowUp' || (!typing && code === 'KeyW')) move(e, 'up');
      else if (code === 'ArrowDown' || (!typing && code === 'KeyS')) move(e, 'down');
      else if (!typing && (code === 'ArrowLeft' || code === 'KeyA')) move(e, 'left');
      else if (!typing && (code === 'ArrowRight' || code === 'KeyD')) move(e, 'right');
      else if (code === 'Enter' || code === 'NumpadEnter' || (!typing && code === 'Space')) confirm(e);
      else if (code === 'Escape' || (!typing && code === 'Backspace')) {
        if (typing) it!.input!.blur();
        e.ctx.back?.();
      } else handled = false;
      if (handled) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    },
    true,
  );

  return {
    push(ctx, focus = 0) {
      const entry: Entry = {
        ctx,
        focus: Math.max(0, Math.min(focus, ctx.items.length - 1)),
        cleanups: [],
        handle: null as unknown as NavHandle,
      };
      entry.handle = {
        focus(i) {
          entry.focus = Math.max(0, Math.min(i, entry.ctx.items.length - 1));
          if (top() === entry) applyFocus(entry);
        },
        get focused() {
          return entry.focus;
        },
        setItems(items) {
          entry.ctx.items = items;
          entry.focus = Math.min(entry.focus, items.length - 1);
          wire(entry);
          if (top() === entry) applyFocus(entry);
        },
        close() {
          const i = stack.indexOf(entry);
          if (i < 0) return;
          entry.cleanups.forEach((c) => c());
          entry.ctx.items.forEach((it) => it.el.classList.remove('ga-focus'));
          stack.splice(i, 1);
          const t = top();
          if (t) applyFocus(t);
        },
      };
      stack.push(entry);
      wire(entry);
      applyFocus(entry);
      return entry.handle;
    },
    update(pad) {
      const e = top();
      if (!e || !pad.connected) return;
      const d = pad.navDir();
      if (d) move(e, d);
      if (pad.pressed(PAD.A)) confirm(e);
      else if (pad.pressed(PAD.B)) e.ctx.back?.();
    },
    get depth() {
      return stack.length;
    },
  };
}
