// UI module entry: createUI(engine) mounts all HTML/CSS overlay UI into #ui-root.
//
// Usage (integration):
//   const ui = createUI(engine);
//   ui.showLoading(0.3, 'Gebouwen laden…'); ... ui.hideLoading();
//   ui.minimap.setData(map2d, footprints, world.roadGraph);  ui.minimap.setLandmarks(osmMeta.landmarks);
//   ui.showMainMenu({ cars: CAR_SPECS, defaultCarId, spawnPoints, onStart: (sel) => { ... ui.hud.setCar(spec); ui.hud.show(); } });
//   at car spawn: vehicle.setGearboxMode(ui.gearbox); vehicle.setAssists(ui.assists); audio.setVolume(ui.volume);
//   every frame: ui.hud.update(vehicle.telemetry, { x, z, heading, lights: { head, handbrake, abs, tcs, esc },
//                gearboxMode });  ui.minimap.update(x, z, heading);
//   Esc / Start: ui.showPause({ onResume, onChangeCar, onRespawn, onQuit, onVolume, onGearbox, onAssists });
//   (or subscribe once with ui.onVolumeChange / ui.onDrivingChange — these also fire from the main-menu sheet)
//   while ui.isBlockingInput() is true, do not feed keyboard/gamepad input to the car.
//
// Keys the UI handles itself: F3 (fps overlay, while the HUD is visible), M (full-screen map, while
// the HUD is visible and no menu is open), and arrows / Enter / Space / Esc / Backspace / Q / E /
// Tab while one of its menus is open (consumed in the capture phase, never reaching the game).

import './ui.css';
import type { Engine, SpawnPoint } from '../contracts';
import type { UiContext } from './context';
import { h, loadPref, savePref, clamp } from './dom';
import { createHud, type Hud, type HudInfo, type HudLights } from './hud';
import { createLoadingScreen } from './loading';
import { createMainMenu, type MainMenuOptions, type MenuSelection } from './menu';
import { createMinimap, type Minimap } from './minimap';
import { loadDriving, saveDriving, type DriverAssists, type DrivingPrefs, type GearboxMode } from './driving';
import { createConfirm, createToaster } from './modal';
import { NavController, type InputDevice } from './nav';
import { createPauseMenu, type PauseHandlers, type PausePage } from './pause';
import { createRoadLookup } from './roadLookup';
import { createSheet } from './sheet';

export type { HudInfo, HudLights, Hud, Minimap, MainMenuOptions, MenuSelection, PauseHandlers, PausePage };
export type { DriverAssists, DrivingPrefs, GearboxMode };

export interface GameUI {
  /** The `.ad-root` element inside #ui-root. */
  readonly root: HTMLElement;

  /**
   * Shows (first call) or updates the loading screen. `fraction` 0..1 never moves backwards.
   * `label` is a short Dutch status text, e.g. 'Gebouwen laden…'.
   */
  showLoading(fraction: number, label?: string): void;
  /** Fades the loading screen out. */
  hideLoading(): void;

  /**
   * Title screen + car selection (live 3D preview, paint swatches, start location).
   * The menu hides itself and then calls `opts.onStart({ carId, color, spawnId })`.
   * Remembers the last car / paint / start location in localStorage. Hides the HUD and pause menu.
   */
  showMainMenu(opts: MainMenuOptions): void;
  hideMainMenu(): void;

  /**
   * Driving HUD (speedometer, gear, rpm, street sign, speed-limit sign, F3 fps overlay, minimap).
   * Call `hud.setCar(spec)` when the player car changes, `hud.update(telemetry, info)` every frame.
   */
  readonly hud: Hud;
  /** Minimap (inside the HUD) and the full-screen city map. */
  readonly minimap: Minimap;

  /**
   * Pause menu. The UI hides the pause menu itself before calling a handler.
   * `page` opens a sub page directly ('spawn' | 'settings' | 'controls' | 'credits').
   * Esc / gamepad B on the main list = Hervatten (onResume).
   */
  showPause(handlers: PauseHandlers, page?: PausePage): void;
  hidePause(): void;

  /** Short notification at the top of the screen (default 2.6 s). */
  toast(message: string, ms?: number): void;
  /** True while any UI screen (loading, menu, pause, map, dialog) wants keyboard / gamepad input. */
  isBlockingInput(): boolean;

  /** Master volume 0..1 (persisted). Changed in Instellingen › Geluid. */
  readonly volume: number;
  /** Listen for volume changes (in addition to PauseHandlers.onVolume). Returns unsubscribe. */
  onVolumeChange(fn: (v: number) => void): () => void;
  /** Gearbox mode chosen in Instellingen › Rijden (persisted; default 'auto'). Apply at car spawn. */
  readonly gearbox: GearboxMode;
  /** Driver assists chosen in Instellingen › Rijden (persisted; default all on). Apply at car spawn. */
  readonly assists: Readonly<DriverAssists>;
  /**
   * Listen for gearbox / assist changes (in addition to PauseHandlers.onGearbox / onAssists; this
   * one also fires for changes made from the main-menu settings sheet). Returns unsubscribe.
   */
  onDrivingChange(fn: (p: Readonly<DrivingPrefs>) => void): () => void;
  /** Changes the driving settings from code (persisted; fires the same handlers / listeners). */
  setDriving(patch: { gearbox?: GearboxMode; assists?: Partial<DriverAssists> }): void;
  /** Spawn points for the pause menu "Startpunt kiezen" (also taken from showMainMenu opts). */
  setSpawnPoints(points: SpawnPoint[]): void;
  /** 'kb' (keyboard / mouse) or 'pad' — the last used input device; hint glyphs follow it. */
  readonly inputDevice: InputDevice;
  dispose(): void;
}

export function createUI(engine: Engine): GameUI {
  const host = document.getElementById('ui-root') ?? document.body;
  const root = h('div', 'ad-root');
  host.append(root);
  // Buttons must never take DOM focus (a focused hidden button would react to Space/Enter later).
  root.addEventListener('mousedown', (e) => {
    if ((e.target as Element).closest('button')) e.preventDefault();
  });

  const nav = new NavController(root);
  let spawnPoints: SpawnPoint[] = [];
  let volume = clamp(loadPref<number>('volume', 0.8), 0, 1);
  const volumeListeners = new Set<(v: number) => void>();
  let driving = loadDriving();
  const drivingListeners = new Set<(p: Readonly<DrivingPrefs>) => void>();
  const mapReadyListeners = new Set<() => void>();

  const ctx: UiContext = {
    root,
    nav,
    engine,
    openSheet: (kind) => sheet.open(kind),
    confirm: createConfirm(root, nav),
    getMap: () => minimap.getMap(),
    onMapReady(fn) {
      mapReadyListeners.add(fn);
      return () => mapReadyListeners.delete(fn);
    },
    getSpawnPoints: () => spawnPoints,
    volume: {
      get: () => volume,
      set(v) {
        volume = clamp(v, 0, 1);
        savePref('volume', volume);
        pause.handlers?.onVolume?.(volume);
        volumeListeners.forEach((f) => f(volume));
      },
    },
    driving: {
      get: () => driving,
      set(patch) {
        const prev = driving;
        driving = {
          gearbox: patch.gearbox ?? prev.gearbox,
          assists: { ...prev.assists, ...patch.assists },
        };
        saveDriving(driving);
        const ph = pause.handlers;
        if (driving.gearbox !== prev.gearbox) ph?.onGearbox?.(driving.gearbox);
        const a = driving.assists;
        if (a.abs !== prev.assists.abs || a.tcs !== prev.assists.tcs || a.esc !== prev.assists.esc) ph?.onAssists?.({ ...a });
        hud.setDriving(driving);
        drivingListeners.forEach((f) => f(driving));
      },
    },
  };

  const loading = createLoadingScreen(root);
  const hud = createHud(root, engine);
  hud.setDriving(driving);
  const minimap = createMinimap(hud.el, ctx, {
    getSpeed: () => hud.speedKmh,
    hudVisible: () => hud.visible,
    onGraph: (graph) => hud.setRoadLookup(createRoadLookup(graph)),
    onReady: () => mapReadyListeners.forEach((f) => f()),
  });
  const menu = createMainMenu(ctx);
  const pause = createPauseMenu(ctx, () => ({ spec: hud.spec, ...hud.status() }));
  const sheet = createSheet(ctx);
  const toaster = createToaster(root);

  const blurInside = () => {
    const a = document.activeElement as HTMLElement | null;
    if (a && root.contains(a)) a.blur();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === 'F3') {
      if (hud.visible) {
        e.preventDefault();
        hud.toggleFps();
      }
      return;
    }
    if ((e.key === 'm' || e.key === 'M') && hud.visible && !nav.active && !loading.visible && !e.ctrlKey && !e.altKey) {
      minimap.toggleBigMap(true);
    }
  };
  window.addEventListener('keydown', onKey);

  return {
    root,
    showLoading: (f, label) => loading.show(f, label),
    hideLoading: () => loading.hide(),
    showMainMenu(opts) {
      spawnPoints = opts.spawnPoints?.length ? opts.spawnPoints : spawnPoints;
      minimap.toggleBigMap(false);
      pause.hide();
      hud.hide(); // the integration shows it again in onStart
      menu.show(opts);
    },
    hideMainMenu() {
      menu.hide();
      blurInside();
    },
    hud,
    minimap,
    showPause(handlers, page) {
      minimap.toggleBigMap(false);
      pause.show(handlers, page);
    },
    hidePause() {
      pause.hide();
      blurInside();
    },
    toast: (m, ms) => toaster.toast(m, ms),
    isBlockingInput: () => loading.visible || menu.visible || pause.visible || minimap.bigMapOpen || sheet.visible || nav.active,
    get volume() {
      return volume;
    },
    onVolumeChange(fn) {
      volumeListeners.add(fn);
      return () => volumeListeners.delete(fn);
    },
    get gearbox() {
      return driving.gearbox;
    },
    get assists() {
      return driving.assists;
    },
    onDrivingChange(fn) {
      drivingListeners.add(fn);
      return () => drivingListeners.delete(fn);
    },
    setDriving: (patch) => ctx.driving.set(patch),
    setSpawnPoints(points) {
      spawnPoints = points ?? [];
    },
    get inputDevice() {
      return nav.device;
    },
    dispose() {
      window.removeEventListener('keydown', onKey);
      nav.dispose();
      loading.dispose();
      menu.dispose();
      pause.dispose();
      minimap.dispose();
      hud.dispose();
      toaster.dispose();
      root.remove();
    },
  };
}
