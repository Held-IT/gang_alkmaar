// Title screen + car selection: brand header, live 3D preview of the selected car, details and
// spec bars, paint swatches, start location selector and a carousel of car cards.

import type { CarSpec, SpawnPoint } from '../contracts';
import {
  categoryLabel,
  drivetrainLabel,
  estimate0to100,
  gearboxLabel,
  kwToPk,
  luminance,
  paintName,
  silhouetteSVG,
} from './carInfo';
import { createCarPreview, type CarPreview } from './carPreview';
import { hintBar, type UiContext } from './context';
import { afterTransition, button, fmt, fromHTML, h, loadPref, savePref } from './dom';
import { ICONS } from './icons';
import { brandBlock } from './loading';
import { MAP_COLORS } from './mapRender';
import { NavLayer, type Dir, type NavItem } from './nav';

export interface MenuSelection {
  carId: string;
  color: string;
  spawnId: string;
}

export interface MainMenuOptions {
  cars: CarSpec[];
  defaultCarId: string;
  spawnPoints: SpawnPoint[];
  /** Called when the player starts driving. The menu hides itself before calling this. */
  onStart(sel: MenuSelection): void;
  /** Optional: preselected paint (hex) — default: remembered choice or the car's first paint. */
  defaultColor?: string;
  /** Optional: spawn id used when no (valid) choice is remembered — else the first spawn point.
   *  The remembered choice always wins, like the car (defaultCarId). */
  defaultSpawnId?: string;
  /** Optional: shows an "Afsluiten" button (Electron: close the window). */
  onQuit?: () => void;
  /** Optional: label of the start button (default 'Start rit'; e.g. 'Verder rijden'). */
  startLabel?: string;
}

export interface MainMenu {
  readonly visible: boolean;
  show(opts: MainMenuOptions): void;
  hide(): void;
  dispose(): void;
}

interface MenuPrefs {
  carId?: string;
  spawnId?: string;
  colors?: Record<string, string>;
}

const SPEC_ROWS = ['Vermogen', '0–100 km/u', 'Topsnelheid', 'Gewicht'] as const;

export function createMainMenu(ctx: UiContext): MainMenu {
  let el: HTMLElement | null = null;
  let preview: CarPreview | null = null;
  let opts: MainMenuOptions | null = null;
  let visible = false;
  let carIdx = 0;
  let spawnIdx = 0;
  let color = '#ffffff';
  const prefs = loadPref<MenuPrefs>('menu', {});
  prefs.colors ??= {};

  // DOM refs (created once)
  const r = {} as {
    stage: HTMLElement;
    watermark: HTMLElement;
    side: HTMLElement;
    counter: HTMLElement;
    brand: HTMLElement;
    model: HTMLElement;
    chips: HTMLElement;
    desc: HTMLElement;
    specVals: HTMLElement[];
    specBars: HTMLElement[];
    spawnSel: HTMLElement;
    spawnName: HTMLElement;
    spawnSub: HTMLElement;
    spawnMap: HTMLCanvasElement;
    paintName: HTMLElement;
    swatches: HTMLElement;
    start: HTMLButtonElement;
    startLabel: HTMLElement;
    cards: HTMLElement;
    links: HTMLElement;
    quit: HTMLButtonElement;
  };
  let cardEls: HTMLElement[] = [];
  let swatchEls: HTMLElement[] = [];
  const linkBtns: HTMLButtonElement[] = [];

  const layer = new NavLayer({
    onBumper: (d) => selectCar(carIdx + d, true),
    onBack: () => {
      if (opts?.onQuit) void quit();
    },
    preferCol: (row) => {
      const rows = layer.rows;
      if (rows[row]?.[0]?.el.classList.contains('ad-card')) return carIdx;
      if (rows[row]?.[0]?.el.classList.contains('ad-swatch')) {
        const i = opts ? Math.max(0, cars()[carIdx].paints.indexOf(color)) : 0;
        return i;
      }
      return undefined;
    },
  });

  const cars = () => opts?.cars ?? [];
  ctx.onMapReady(() => {
    const s = spawns()[spawnIdx];
    if (visible && s) drawSpawnMap(s);
  });
  const spawns = () => opts?.spawnPoints ?? [];

  function build(): HTMLElement {
    r.stage = h('div', 'ad-menu-stage');
    r.watermark = h('div', 'ad-menu-watermark');
    r.counter = h('span', 'ad-menu-counter');
    r.brand = h('div', 'ad-car-brand');
    r.model = h('div', 'ad-car-model');
    r.chips = h('div', 'ad-car-chips');
    r.desc = h('p', 'ad-car-desc');
    r.specVals = [];
    r.specBars = [];
    const specs = h('div', 'ad-specs');
    for (const label of SPEC_ROWS) {
      const val = h('div', 'ad-spec-val');
      const bar = h('i');
      r.specVals.push(val);
      r.specBars.push(bar);
      specs.append(h('div', 'ad-spec', h('div', 'ad-spec-label', label), val, h('div', 'ad-spec-bar', bar)));
    }
    // start location selector
    r.spawnName = h('div', 'ad-select-value');
    r.spawnSub = h('div', 'ad-select-sub');
    r.spawnMap = h('canvas', 'ad-spawn-thumb');
    const prev = button('ad-select-arrow', fromHTML(ICONS.chevL));
    const next = button('ad-select-arrow', fromHTML(ICONS.chevR));
    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSpawn(spawnIdx - 1);
    });
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      selectSpawn(spawnIdx + 1);
    });
    r.spawnSel = h('div', 'ad-select', prev, h('div', 'ad-select-mid', r.spawnName, r.spawnSub), next);
    r.spawnSel.addEventListener('click', () => layer.focusEl(r.spawnSel));

    r.side = h(
      'div',
      'ad-menu-side',
      h('div', 'ad-kicker', h('span', null, 'Kies je auto'), r.counter),
      h('div', 'ad-car-title', r.brand, r.model),
      r.chips,
      r.desc,
      specs,
      h(
        'div',
        'ad-field',
        h('div', 'ad-field-label', fromHTML(ICONS.pin), 'Startlocatie'),
        h('div', 'ad-field-row', r.spawnSel, r.spawnMap),
      ),
    );

    r.paintName = h('span', 'ad-paint-name');
    r.swatches = h('div', 'ad-swatches');
    const paint = h('div', 'ad-menu-paint', h('div', 'ad-paint-label', h('span', null, 'Lakkleur'), r.paintName), r.swatches);

    r.startLabel = h('span', null, 'Start rit');
    r.start = button('ad-btn-primary ad-menu-start', r.startLabel, fromHTML(ICONS.arrowR));
    r.start.addEventListener('click', start);

    r.cards = h('div', 'ad-cards');
    const carsWrap = h('div', 'ad-menu-cars', r.cards);

    const mk = (icon: string, label: string, fn: () => void) => {
      const b = button('ad-btn-ghost', fromHTML(icon), h('span', null, label));
      b.addEventListener('click', fn);
      linkBtns.push(b);
      return b;
    };
    r.links = h(
      'div',
      'ad-menu-links',
      mk(ICONS.sliders, 'Instellingen', () => ctx.openSheet('settings')),
      mk(ICONS.gamepad, 'Besturing', () => ctx.openSheet('controls')),
      mk(ICONS.info, 'Credits', () => ctx.openSheet('credits')),
    );
    r.quit = mk(ICONS.power, 'Afsluiten', () => void quit());
    r.links.append(r.quit);

    const hints = hintBar([
      { kb: ['←', '→'], pad: ['LB', 'RB'], label: 'Auto kiezen' },
      { kb: ['↑', '↓'], pad: ['D-pad'], label: 'Navigeren' },
      { kb: ['Enter'], pad: ['A'], label: 'Selecteren' },
    ], 'ad-menu-hints');

    const root = h(
      'div',
      'ad-menu',
      h('div', 'ad-menu-bg'),
      r.watermark,
      r.stage,
      h('div', 'ad-menu-top', brandBlock('md'), r.links),
      r.side,
      paint,
      r.start,
      carsWrap,
      hints,
    );
    preview = createCarPreview(r.stage);
    return root;
  }

  function buildCards(): void {
    r.cards.textContent = '';
    cardEls = cars().map((spec, i) => {
      const card = button(
        'ad-card',
        h('span', 'ad-card-cat', categoryLabel(spec.category)),
        h('span', 'ad-card-name', spec.name),
        h('span', 'ad-card-meta ad-num', `${fmt(spec.powerKw)} kW · ${fmt(kwToPk(spec.powerKw))} pk`),
        fromHTML(silhouetteSVG(spec.category)),
        spec.electric ? h('span', 'ad-card-ev', fromHTML(ICONS.bolt)) : null,
      );
      card.addEventListener('click', () => {
        if (i === carIdx) start();
        else selectCar(i, false);
      });
      r.cards.append(card);
      return card;
    });
  }

  function buildSwatches(spec: CarSpec): void {
    r.swatches.textContent = '';
    swatchEls = spec.paints.map((hex) => {
      const s = button('ad-swatch');
      s.style.setProperty('--c', hex);
      if (luminance(hex) > 0.75) s.classList.add('is-light');
      s.title = paintName(hex);
      s.addEventListener('click', () => selectColor(hex));
      r.swatches.append(s);
      return s;
    });
  }

  function navRows(): NavItem[][] {
    const items = (els: HTMLElement[], extra?: Partial<NavItem>) => els.map((el) => ({ el, ...extra }));
    const linkItems = items(linkBtns.filter((b) => b.style.display !== 'none'));
    const spawnItem: NavItem = {
      el: r.spawnSel,
      adjust: (d: Dir) => selectSpawn(spawnIdx + d),
      activate: () => selectSpawn(spawnIdx + 1),
    };
    const paintItems: NavItem[] = swatchEls.map((el, i) => ({
      el,
      onFocus: (byPointer) => {
        if (!byPointer) selectColor(cars()[carIdx].paints[i]);
      },
    }));
    paintItems.push({ el: r.start });
    const cardItems: NavItem[] = cardEls.map((el, i) => ({
      el,
      onFocus: (byPointer) => {
        if (!byPointer) selectCar(i, false);
      },
      activate: () => start(),
    }));
    return [linkItems, spawns().length ? [spawnItem] : [], paintItems, cardItems];
  }

  function refreshNav(focusCars: boolean): void {
    const rows = navRows();
    const carRow = rows.filter((x) => x.length).length - 1;
    if (focusCars) layer.setRows(rows, [carRow, carIdx]);
    else layer.setRows(rows);
  }

  function selectCar(i: number, fromBumper: boolean): void {
    const list = cars();
    if (!list.length) return;
    i = (i + list.length) % list.length;
    const changed = i !== carIdx || !r.model.textContent;
    carIdx = i;
    const spec = list[i];
    cardEls.forEach((c, j) => c.classList.toggle('is-selected', j === i));
    if (!changed) return;
    color = prefs.colors![spec.id] && spec.paints.includes(prefs.colors![spec.id]) ? prefs.colors![spec.id] : spec.paints[0] ?? '#cccccc';
    if (opts?.defaultColor && spec.id === opts.defaultCarId && !prefs.colors![spec.id] && spec.paints.includes(opts.defaultColor)) {
      color = opts.defaultColor;
    }
    // cross-fade the detail block
    r.side.classList.add('is-swap');
    window.setTimeout(() => {
      fillDetails(spec);
      r.side.classList.remove('is-swap');
    }, 120);
    buildSwatches(spec);
    markSwatch();
    preview?.setCar(spec, color);
    // keep focus position, but rows changed (swatches)
    const onCards = layer.rows[layer.row]?.[0]?.el.classList.contains('ad-card');
    if (fromBumper || !onCards) {
      const keepRow = layer.row;
      const keepCol = layer.col;
      layer.setRows(navRows(), [keepRow, onCards ? i : keepCol]);
    } else {
      layer.setRows(navRows(), [layer.row, i]);
    }
    prefs.carId = spec.id;
    savePref('menu', prefs);
  }

  function fillDetails(spec: CarSpec): void {
    const list = cars();
    const words = spec.name.trim().split(/\s+/);
    if (words.length > 1) {
      r.brand.textContent = words[0];
      r.model.textContent = words.slice(1).join(' ');
    } else {
      r.brand.textContent = categoryLabel(spec.category);
      r.model.textContent = spec.name;
    }
    r.counter.textContent = `${carIdx + 1} / ${list.length}`;
    r.watermark.textContent = categoryLabel(spec.category);
    r.chips.textContent = '';
    r.chips.append(h('span', 'ad-chip', categoryLabel(spec.category)), h('span', 'ad-chip', drivetrainLabel(spec.drivetrain)));
    r.chips.append(h('span', 'ad-chip', gearboxLabel(spec)));
    if (spec.electric) r.chips.append(h('span', 'ad-chip ad-chip-ev', fromHTML(ICONS.bolt), 'Elektrisch'));
    r.desc.textContent = spec.description;

    const t = estimate0to100(spec);
    const maxKw = Math.max(...list.map((c) => c.powerKw));
    const times = list.map(estimate0to100);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    const maxTop = Math.max(...list.map((c) => c.topSpeedKmh));
    const maxKg = Math.max(...list.map((c) => c.massKg));
    const vals: [string, string, number][] = [
      [`${fmt(spec.powerKw)}`, ` kW · ${fmt(kwToPk(spec.powerKw))} pk`, spec.powerKw / maxKw],
      [`${fmt(t, 1)}`, ' s', tMax > tMin ? 0.18 + (0.82 * (tMax - t)) / (tMax - tMin) : 0.7],
      [`${fmt(spec.topSpeedKmh)}`, ' km/u', spec.topSpeedKmh / maxTop],
      [`${fmt(spec.massKg)}`, ' kg', spec.massKg / maxKg],
    ];
    vals.forEach(([v, unit, frac], i) => {
      r.specVals[i].innerHTML = '';
      r.specVals[i].append(h('b', 'ad-num', v), h('span', null, unit));
      r.specBars[i].style.transform = `scaleX(${Math.max(0.06, Math.min(1, frac))})`;
    });
  }

  function selectColor(hex: string): void {
    color = hex;
    markSwatch();
    preview?.setPaint(hex);
    const spec = cars()[carIdx];
    if (spec) {
      prefs.colors![spec.id] = hex;
      savePref('menu', prefs);
    }
  }

  function markSwatch(): void {
    const spec = cars()[carIdx];
    swatchEls.forEach((s, i) => s.classList.toggle('is-selected', spec?.paints[i] === color));
    r.paintName.textContent = paintName(color);
  }

  function selectSpawn(i: number): void {
    const list = spawns();
    if (!list.length) return;
    spawnIdx = (i + list.length) % list.length;
    const sp = list[spawnIdx];
    r.spawnName.textContent = sp.name;
    r.spawnSub.textContent = `Startpunt ${spawnIdx + 1} van ${list.length}`;
    drawSpawnMap(sp);
    prefs.spawnId = sp.id;
    savePref('menu', prefs);
  }

  function drawSpawnMap(sp: SpawnPoint): void {
    const map = ctx.getMap();
    const c = r.spawnMap;
    c.style.display = map ? '' : 'none';
    if (!map) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const g = c.getContext('2d')!;
    g.fillStyle = MAP_COLORS.land;
    g.fillRect(0, 0, w, hgt);
    const v = { cx: sp.x, cz: sp.z, pxPerM: w / 420, rotation: 0, ox: w / 2, oy: hgt / 2, w, h: hgt };
    map.draw(g, v);
    drawPin(g, w / 2, hgt / 2, dpr);
  }

  function start(): void {
    if (!opts || !visible) return;
    const spec = cars()[carIdx];
    const sp = spawns()[spawnIdx];
    const sel: MenuSelection = { carId: spec?.id ?? opts.defaultCarId, color, spawnId: sp?.id ?? '' };
    const cb = opts.onStart;
    hide();
    cb(sel);
  }

  async function quit(): Promise<void> {
    if (!opts?.onQuit) return;
    const ok = await ctx.confirm({
      title: 'Spel afsluiten?',
      text: 'Weet je zeker dat je Alkmaar Drive wilt afsluiten?',
      ok: 'Afsluiten',
      cancel: 'Annuleren',
      danger: true,
    });
    if (ok) opts.onQuit();
  }

  function hide(): void {
    if (!el || !visible) return;
    visible = false;
    ctx.nav.remove(layer);
    const node = el;
    node.classList.remove('is-visible');
    afterTransition(node, 600, () => {
      if (!visible) {
        node.classList.add('is-hidden');
        preview?.stop();
      }
    });
  }

  return {
    get visible() {
      return visible;
    },
    show(o) {
      opts = o;
      if (!el) {
        el = build();
        ctx.root.append(el);
      }
      r.quit.style.display = o.onQuit ? '' : 'none';
      r.startLabel.textContent = o.startLabel ?? 'Start rit';
      buildCards();
      const list = o.cars;
      const want = prefs.carId && list.some((c) => c.id === prefs.carId) ? prefs.carId : o.defaultCarId;
      carIdx = Math.max(0, list.findIndex((c) => c.id === want));
      r.model.textContent = ''; // force a full refresh in selectCar
      const sp = o.spawnPoints;
      // remembered choice first (like the car); defaultSpawnId only when nothing valid is remembered
      const wantSpawn = prefs.spawnId && sp.some((s) => s.id === prefs.spawnId) ? prefs.spawnId : o.defaultSpawnId;
      spawnIdx = Math.max(0, sp.findIndex((s) => s.id === wantSpawn));
      el.classList.remove('is-hidden');
      visible = true;
      // first frame hidden, then fade in
      requestAnimationFrame(() => el?.classList.add('is-visible'));
      preview?.start();
      ctx.nav.push(layer);
      selectCar(carIdx, false);
      selectSpawn(spawnIdx);
      refreshNav(true);
      // map thumbnail needs layout to know its size
      requestAnimationFrame(() => {
        const s = spawns()[spawnIdx];
        if (s) drawSpawnMap(s);
      });
    },
    hide,
    dispose() {
      ctx.nav.remove(layer);
      preview?.dispose();
      preview = null;
      el?.remove();
      el = null;
    },
  };
}

/** Red map pin with a white dot, centred at (x, y) (tip at y). */
export function drawPin(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 6;
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-3, -6, -9, -10, -9, -17);
  g.arc(0, -17, 9, Math.PI, 0);
  g.bezierCurveTo(9, -10, 3, -6, 0, 0);
  g.fillStyle = '#d4202c';
  g.fill();
  g.shadowBlur = 0;
  g.lineWidth = 1.5;
  g.strokeStyle = '#ffffff';
  g.stroke();
  g.beginPath();
  g.arc(0, -17, 3.4, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.restore();
}
