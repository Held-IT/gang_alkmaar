// Pause menu: left list (Hervatten, Auto wisselen, Startpunt kiezen, Instellingen, Besturing,
// Credits, Afsluiten) and a right pane that shows either the current-ride overview or a page
// (start location picker with map, settings with tabs, credits).

import type { CarSpec, SpawnPoint } from '../contracts';
import { categoryLabel } from './carInfo';
import { hintBar, type UiContext } from './context';
import { createCreditsPage } from './credits';
import { afterTransition, button, fromHTML, h } from './dom';
import type { DriverAssists, GearboxMode } from './driving';
import { ICONS, type IconName } from './icons';
import { brandBlock } from './loading';
import { MAP_COLORS, type MapView } from './mapRender';
import { drawPin } from './menu';
import { NavLayer, type NavItem } from './nav';
import { createSettingsPanel, type SettingsPanel, type SettingsTab } from './settings';

export interface PauseHandlers {
  onResume(): void;
  /** Player wants another car: the integration typically calls ui.showMainMenu(...). */
  onChangeCar(): void;
  onRespawn(spawnId: string): void;
  onQuit(): void;
  /** Master volume 0..1 (also persisted by the UI; see GameUI.volume). */
  onVolume?(v: number): void;
  /** Instellingen › Rijden › Versnellingsbak changed → vehicle.setGearboxMode(mode). */
  onGearbox?(mode: GearboxMode): void;
  /** Instellingen › Rijden › ABS / TCS / ESP changed (full state) → vehicle.setAssists(a). */
  onAssists?(a: DriverAssists): void;
}

export type PausePage = 'spawn' | 'settings' | 'controls' | 'credits';

export interface PauseStatus {
  spec: CarSpec | null;
  street: string | null;
  x: number;
  z: number;
  heading: number;
  hasPosition: boolean;
  distanceM: number;
  driveSeconds: number;
}

export interface PauseMenu {
  readonly visible: boolean;
  readonly handlers: PauseHandlers | null;
  show(handlers: PauseHandlers, page?: PausePage): void;
  hide(): void;
  dispose(): void;
}

interface Page {
  id: PausePage;
  title: string;
  sub: string;
  el: HTMLElement;
  layer: NavLayer;
  onShow?(): void;
  /** Redraw map previews once the static map is available. */
  onMapReady?(): void;
}

export function createPauseMenu(ctx: UiContext, status: () => PauseStatus): PauseMenu {
  let el: HTMLElement | null = null;
  let visible = false;
  let handlers: PauseHandlers | null = null;
  let page: Page | null = null;
  const pages = new Map<PausePage, Page>();
  const items: { id: string; btn: HTMLButtonElement }[] = [];

  // right pane parts
  const paneTitle = h('div', 'ad-pane-title');
  const paneSub = h('div', 'ad-pane-sub');
  const paneBody = h('div', 'ad-pane-body');
  const pane = h('div', 'ad-pause-pane', h('div', 'ad-pane-head', paneTitle, paneSub), paneBody);

  // overview (root state)
  const ovMap = h('canvas', 'ad-ov-map');
  const ovCar = h('div', 'ad-ov-car');
  const ovCat = h('div', 'ad-ov-cat');
  const ovStreet = h('div', 'ad-ov-street');
  const ovTime = h('div', 'ad-ov-stat ad-num');
  const ovDist = h('div', 'ad-ov-stat ad-num');
  const ovDrive = h('div', 'ad-ov-chips');
  const overview = h(
    'div',
    'ad-overview',
    h('div', 'ad-ov-mapwrap', ovMap),
    h(
      'div',
      'ad-ov-info',
      h('div', 'ad-ov-block', h('div', 'ad-ov-label', 'Auto'), ovCar, ovCat),
      h('div', 'ad-ov-block', h('div', 'ad-ov-label', 'Locatie'), ovStreet),
      h(
        'div',
        'ad-ov-stats',
        h('div', 'ad-ov-block', h('div', 'ad-ov-label', 'Rijtijd'), ovTime),
        h('div', 'ad-ov-block', h('div', 'ad-ov-label', 'Afstand'), ovDist),
      ),
      h('div', 'ad-ov-block', h('div', 'ad-ov-label', 'Rijden'), ovDrive),
      h('div', 'ad-ov-tip', fromHTML(ICONS.map), h('span', null, 'Druk tijdens het rijden op M voor de kaart van de hele binnenstad.')),
    ),
  );

  const rootLayer = new NavLayer({ wrap: true, onBack: () => resume() });

  function item(id: string, icon: IconName, label: string, fn: () => void, sub = false): NavItem {
    const btn = button(`ad-pause-item${id === 'quit' ? ' is-quit' : ''}`, fromHTML(ICONS[icon]), h('span', null, label));
    if (sub) btn.append(h('span', 'ad-pause-chev', fromHTML(ICONS.chevR)));
    btn.addEventListener('click', fn);
    items.push({ id, btn });
    return { el: btn };
  }

  function build(): HTMLElement {
    const list = [
      item('resume', 'play', 'Hervatten', () => resume()),
      item('car', 'car', 'Auto wisselen', () => {
        const hd = handlers;
        hide();
        hd?.onChangeCar();
      }),
      item('spawn', 'pin', 'Startpunt kiezen', () => openPage('spawn'), true),
      item('settings', 'sliders', 'Instellingen', () => openPage('settings'), true),
      item('controls', 'gamepad', 'Besturing', () => openPage('controls'), true),
      item('credits', 'info', 'Credits', () => openPage('credits'), true),
      item('quit', 'power', 'Afsluiten', () => void quit()),
    ];
    rootLayer.setRows(list.map((i) => [i]), [0, 0]);
    const nav = h(
      'div',
      'ad-pause-nav',
      h('div', 'ad-pause-kicker', h('i'), 'Gepauzeerd'),
      brandBlock('md'),
      h('div', 'ad-pause-list', ...list.map((i) => i.el)),
    );
    const hints = hintBar([
      { kb: ['↑', '↓'], pad: ['D-pad'], label: 'Navigeren' },
      { kb: ['Enter'], pad: ['A'], label: 'Selecteren' },
      { kb: ['Esc'], pad: ['B'], label: 'Terug' },
    ], 'ad-pause-hints');
    return h('div', 'ad-pause', h('div', 'ad-pause-bg', snap), nav, pane, hints);
  }

  /**
   * Freeze a blurred copy of the current game frame as the pause background. Reading the WebGL
   * canvas right after renderOnce() in the same task works without preserveDrawingBuffer.
   * Much cheaper than a live full-screen backdrop-filter while the engine keeps rendering.
   */
  const snap = h('canvas', 'ad-pause-snap');
  function takeSnapshot(): void {
    try {
      const src = ctx.engine.canvas;
      if (!src.width || !src.height) return;
      ctx.engine.renderOnce();
      const w = Math.max(2, Math.round(src.width / 4));
      const hh = Math.max(2, Math.round(src.height / 4));
      snap.width = w;
      snap.height = hh;
      const g = snap.getContext('2d')!;
      g.filter = 'blur(3px)';
      g.drawImage(src, -6, -6, w + 12, hh + 12);
      g.filter = 'none';
    } catch (e) {
      console.warn('[ui] pause snapshot failed', e);
    }
  }

  // ---------------------------------------------------------------- pages
  function spawnPage(): Page {
    const listEl = h('div', 'ad-spawn-list');
    const map = h('canvas', 'ad-spawn-map');
    const el = h('div', 'ad-spawn', listEl, h('div', 'ad-spawn-mapwrap', map));
    const layer = new NavLayer({ onBack: () => closePage() });
    let points: SpawnPoint[] = [];
    const draw = (sp: SpawnPoint) => drawMapAt(map, sp.x, sp.z, 520, sp.heading, true);
    return {
      id: 'spawn',
      title: 'Startpunt kiezen',
      sub: 'Kies waar je verder wilt rijden. Je auto wordt daarheen verplaatst.',
      el,
      layer,
      onShow() {
        points = ctx.getSpawnPoints();
        listEl.textContent = '';
        const its: NavItem[] = points.map((sp, i) => {
          const b = button('ad-spawn-item', h('span', 'ad-spawn-idx ad-num', String(i + 1).padStart(2, '0')), h('span', null, sp.name), fromHTML(ICONS.arrowR));
          b.addEventListener('click', () => {
            const hd = handlers;
            hide();
            hd?.onRespawn(sp.id);
          });
          listEl.append(b);
          return { el: b, onFocus: () => draw(sp) };
        });
        if (!its.length) listEl.append(h('div', 'ad-empty', 'Geen startpunten beschikbaar.'));
        layer.setRows(its.map((x) => [x]), [0, 0]);
        if (points[0]) requestAnimationFrame(() => draw(points[layer.row] ?? points[0]));
      },
      onMapReady() {
        const sp = points[layer.row] ?? points[0];
        if (sp) draw(sp);
      },
    };
  }

  let settingsPanel: SettingsPanel | null = null;
  function settingsPage(id: 'settings' | 'controls'): Page {
    settingsPanel ??= createSettingsPanel(ctx, 'beeld');
    const panel = settingsPanel;
    const tab: SettingsTab = id === 'controls' ? 'besturing' : 'beeld';
    return {
      id,
      title: id === 'controls' ? 'Besturing' : 'Instellingen',
      sub: id === 'controls' ? 'Toetsenbord en controller.' : 'Beeld, geluid, rijhulpen en besturing.',
      el: panel.el,
      layer: panel.layer,
      onShow() {
        panel.layer.opts.onBack = () => closePage();
        panel.setTab(tab);
        panel.refresh();
        // focus the first option instead of the tab row when opening settings
        if (id === 'settings' && panel.layer.rows.length > 1) panel.layer.focus(1, 0);
      },
    };
  }

  function creditsPage(): Page {
    const c = createCreditsPage();
    c.layer.opts.onBack = () => closePage();
    return { id: 'credits', title: 'Credits', sub: 'Met dank aan open data en open source.', el: c.el, layer: c.layer, onShow: () => c.load() };
  }

  function getPage(id: PausePage): Page {
    let p = pages.get(id);
    if (!p) {
      p = id === 'spawn' ? spawnPage() : id === 'credits' ? creditsPage() : settingsPage(id);
      pages.set(id, p);
    }
    return p;
  }

  function openPage(id: PausePage): void {
    if (page) ctx.nav.remove(page.layer);
    const p = getPage(id);
    page = p;
    paneTitle.textContent = p.title;
    paneSub.textContent = p.sub;
    paneBody.textContent = '';
    paneBody.append(p.el);
    pane.classList.add('has-page');
    pane.classList.remove('is-enter');
    void pane.offsetWidth; // restart the enter animation
    pane.classList.add('is-enter');
    items.forEach((i) => i.btn.classList.toggle('is-active', i.id === id));
    p.onShow?.();
    ctx.nav.push(p.layer);
  }

  function closePage(): void {
    if (page) ctx.nav.remove(page.layer);
    page = null;
    items.forEach((i) => i.btn.classList.remove('is-active'));
    showOverview();
  }

  function showOverview(): void {
    pane.classList.remove('has-page');
    paneTitle.textContent = 'Huidige rit';
    paneSub.textContent = 'Het spel staat stil zolang dit menu open is.';
    paneBody.textContent = '';
    paneBody.append(overview);
    const st = status();
    ovCar.textContent = st.spec?.name ?? '—';
    ovCat.textContent = st.spec ? `${categoryLabel(st.spec.category)} · ${st.spec.powerKw} kW` : '';
    ovStreet.textContent = st.street ?? 'Binnenstad van Alkmaar';
    const d = ctx.driving.get();
    const chip = (label: string, on: boolean) => h('span', on ? 'ad-chip' : 'ad-chip is-off', on ? label : `${label} uit`);
    ovDrive.textContent = '';
    ovDrive.append(
      chip(d.gearbox === 'manual' ? 'Handgeschakeld' : 'Automaat', true),
      chip('ABS', d.assists.abs),
      chip('TCS', d.assists.tcs),
      chip('ESP', d.assists.esc),
    );
    const s = Math.floor(st.driveSeconds);
    ovTime.innerHTML = `${Math.floor(s / 60)}<small>:</small>${String(s % 60).padStart(2, '0')} <span>min</span>`;
    ovDist.innerHTML =
      st.distanceM >= 1000
        ? `${(st.distanceM / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} <span>km</span>`
        : `${Math.round(st.distanceM)} <span>m</span>`;
    requestAnimationFrame(() => drawOverviewMap(st));
  }

  function drawOverviewMap(st: PauseStatus): void {
    if (st.hasPosition) drawMapAt(ovMap, st.x, st.z, 380, st.heading, false);
    else drawMapAt(ovMap, 0, 0, 900, 0, false, false);
  }

  ctx.onMapReady(() => {
    if (!visible) return;
    if (page) page.onMapReady?.();
    else drawOverviewMap(status());
  });

  /** Draw a north-up map crop around (x, z) spanning `metres` horizontally. */
  function drawMapAt(c: HTMLCanvasElement, x: number, z: number, metres: number, heading: number, pin: boolean, arrow = true): void {
    const map = ctx.getMap();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const hh = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    const g = c.getContext('2d')!;
    g.fillStyle = MAP_COLORS.land;
    g.fillRect(0, 0, w, hh);
    if (!map) {
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.font = `${13 * dpr}px "Segoe UI", sans-serif`;
      g.textAlign = 'center';
      g.fillText('Kaart niet beschikbaar', w / 2, hh / 2);
      return;
    }
    const v: MapView = { cx: x, cz: z, pxPerM: w / metres, rotation: 0, ox: w / 2, oy: hh / 2, w, h: hh };
    map.draw(g, v);
    if (pin) drawPin(g, w / 2, hh / 2, dpr * 1.2);
    else if (arrow) {
      g.save();
      g.translate(w / 2, hh / 2);
      g.rotate(Math.PI - heading);
      const a = 10 * dpr;
      g.shadowColor = 'rgba(0,0,0,0.6)';
      g.shadowBlur = 8 * dpr;
      g.beginPath();
      g.moveTo(0, -a * 1.15);
      g.lineTo(a * 0.82, a * 0.85);
      g.lineTo(0, a * 0.42);
      g.lineTo(-a * 0.82, a * 0.85);
      g.closePath();
      g.fillStyle = '#fff';
      g.fill();
      g.shadowBlur = 0;
      g.lineWidth = 2 * dpr;
      g.strokeStyle = '#d4202c';
      g.stroke();
      g.restore();
    }
  }

  function resume(): void {
    const hd = handlers;
    hide();
    hd?.onResume();
  }

  async function quit(): Promise<void> {
    const ok = await ctx.confirm({
      title: 'Spel afsluiten?',
      text: 'Je rit door Alkmaar wordt beëindigd.',
      ok: 'Afsluiten',
      cancel: 'Annuleren',
      danger: true,
    });
    if (ok) {
      const hd = handlers;
      hide();
      hd?.onQuit();
    }
  }

  function hide(): void {
    if (!el || !visible) return;
    visible = false;
    if (page) ctx.nav.remove(page.layer);
    page = null;
    ctx.nav.remove(rootLayer);
    const node = el;
    node.classList.remove('is-visible');
    afterTransition(node, 400, () => {
      if (!visible) node.classList.add('is-hidden');
    });
  }

  return {
    get visible() {
      return visible;
    },
    get handlers() {
      return handlers;
    },
    show(hd, pg) {
      handlers = hd;
      if (!el) {
        el = build();
        ctx.root.append(el);
      }
      if (!visible) takeSnapshot();
      el.classList.remove('is-hidden');
      requestAnimationFrame(() => el?.classList.add('is-visible'));
      if (!visible) {
        visible = true;
        rootLayer.focus(0, 0, false, true);
        ctx.nav.push(rootLayer);
      }
      if (pg) {
        const idx = items.findIndex((i) => i.id === pg);
        if (idx >= 0) rootLayer.focus(idx, 0, false, true);
        openPage(pg);
      } else {
        closePage();
      }
    },
    hide,
    dispose() {
      hide();
      el?.remove();
      el = null;
    },
  };
}
