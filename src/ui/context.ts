// Shared services passed to every UI screen.
import type { Engine, SpawnPoint } from '../contracts';
import { h } from './dom';
import type { DriverAssists, DrivingPrefs, GearboxMode } from './driving';
import { padGlyph } from './icons';
import type { StaticMap } from './mapRender';
import type { NavController } from './nav';

export interface ConfirmOptions {
  title: string;
  text: string;
  ok: string;
  cancel?: string;
  danger?: boolean;
}

export type SheetKind = 'settings' | 'credits' | 'controls';

export interface UiContext {
  root: HTMLElement;
  nav: NavController;
  engine: Engine;
  /** Full-screen sheet (used from the main menu) with settings / credits / controls. */
  openSheet(kind: SheetKind): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** Pre-rendered static map, once minimap.setData() was called. */
  getMap(): StaticMap | null;
  /** Fires when the static map (re)becomes available. Returns unsubscribe. */
  onMapReady(fn: () => void): () => void;
  getSpawnPoints(): SpawnPoint[];
  volume: { get(): number; set(v: number): void };
  /** Gearbox mode + driver assists (persisted; changes go to PauseHandlers + GameUI listeners). */
  driving: { get(): Readonly<DrivingPrefs>; set(patch: { gearbox?: GearboxMode; assists?: Partial<DriverAssists> }): void };
}

/** One entry of a key-hint bar: keyboard caps and gamepad glyphs for an action. */
export interface Hint {
  kb: string[];
  pad: Parameters<typeof padGlyph>[0][];
  label: string;
}

/** Hint bar; shows keyboard or gamepad glyphs depending on `.ad-root[data-input]`. */
export function hintBar(hints: Hint[], cls = ''): HTMLElement {
  const bar = h('div', `ad-hints ${cls}`);
  for (const hint of hints) {
    const kb = h('span', 'ad-hint-kb');
    for (const k of hint.kb) kb.append(h('kbd', 'ad-key', k));
    const pad = h('span', 'ad-hint-pad');
    pad.innerHTML = hint.pad.map((p) => padGlyph(p)).join('');
    bar.append(h('span', 'ad-hint', kb, pad, h('span', 'ad-hint-label', hint.label)));
  }
  return bar;
}
