// Tiny DOM helpers for the UI module (no framework).

export type Child = Node | string | number | null | undefined | false;

/** Create an element with an optional class name and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

/** Parse a (trusted, module-authored) SVG/HTML snippet into an element. */
export function fromHTML<T extends Element = Element>(markup: string): T {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as T;
}

/** A <button type="button"> that never submits and has the given class. */
export function button(cls: string, ...children: Child[]): HTMLButtonElement {
  const b = h('button', cls, ...children);
  b.type = 'button';
  b.tabIndex = -1; // focus is managed by the nav controller, not the browser
  return b;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const nf0 = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** Dutch number formatting: 1.290 / 8,7 */
export function fmt(n: number, decimals: 0 | 1 = 0): string {
  return (decimals === 1 ? nf1 : nf0).format(n);
}

/** Escape text for use inside an HTML/SVG string. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// localStorage can throw (privacy mode, file://) — always wrap.
const PREFIX = 'alkmaarDrive.ui.';
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/** Deterministic PRNG (mulberry32) for procedural decoration. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wait for the next CSS transition end (or a timeout, whichever comes first). */
export function afterTransition(el: HTMLElement, ms: number, fn: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', onEnd);
    fn();
  };
  const onEnd = (e: TransitionEvent) => {
    if (e.target === el) finish();
  };
  el.addEventListener('transitionend', onEnd);
  window.setTimeout(finish, ms + 50);
}
