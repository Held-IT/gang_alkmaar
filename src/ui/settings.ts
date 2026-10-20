// Settings panel with tabs Beeld (quality preset + individual options -> engine.setQuality),
// Geluid (master volume), Rijden (gearbox + driver assists) and Besturing (controls overview). Used inside the pause menu and in the
// main-menu sheet. Every control is reachable with keyboard / gamepad (left/right adjusts).

import type { QualityLevel, QualitySettings } from '../contracts';
import type { UiContext } from './context';
import type { GearboxMode } from './driving';
import { controlsTable } from './controls';
import { button, clamp, fromHTML, h } from './dom';
import { ICONS, TELLTALES } from './icons';
import { NavLayer, type Dir, type NavItem } from './nav';

export type SettingsTab = 'beeld' | 'geluid' | 'rijden' | 'besturing';

export interface SettingsPanel {
  readonly el: HTMLElement;
  readonly layer: NavLayer;
  setTab(t: SettingsTab): void;
  /** Re-read engine.quality / volume into the controls. */
  refresh(): void;
}

type Preset = Omit<QualitySettings, 'level'>;

/** Fallback presets if the engine does not expand `{ level }` itself (see applyPreset). */
const FALLBACK_PRESETS: Record<QualityLevel, Preset> = {
  laag: { renderScale: 0.75, shadowMapSize: 0, shadowDistance: 60, ao: false, bloom: false, waterReflections: 'env', antialias: 'smaa', drawDistance: 600, trafficDensity: 0.4, propDensity: 0.4, anisotropy: 2 },
  midden: { renderScale: 0.85, shadowMapSize: 1024, shadowDistance: 80, ao: false, bloom: true, waterReflections: 'env', antialias: 'smaa', drawDistance: 900, trafficDensity: 0.6, propDensity: 0.7, anisotropy: 4 },
  hoog: { renderScale: 1, shadowMapSize: 2048, shadowDistance: 120, ao: true, bloom: true, waterReflections: 'planar', antialias: 'smaa', drawDistance: 1500, trafficDensity: 0.8, propDensity: 1, anisotropy: 8 },
  ultra: { renderScale: 1, shadowMapSize: 4096, shadowDistance: 180, ao: true, bloom: true, waterReflections: 'planar', antialias: 'msaa', drawDistance: 2500, trafficDensity: 1, propDensity: 1, anisotropy: 16 },
};

// The engine module may export its own preset table (any export shaped Record<QualityLevel, {...}>).
const engineModules = import.meta.glob<Record<string, unknown>>('../core/quality.ts', { eager: true });
function findEnginePresets(): Record<QualityLevel, Partial<QualitySettings>> | null {
  for (const mod of Object.values(engineModules)) {
    for (const v of Object.values(mod)) {
      if (v && typeof v === 'object' && ['laag', 'midden', 'hoog', 'ultra'].every((k) => k in (v as object))) {
        const t = v as Record<string, unknown>;
        if (typeof t.hoog === 'object' && t.hoog && ('renderScale' in t.hoog || 'shadowMapSize' in t.hoog)) {
          return v as Record<QualityLevel, Partial<QualitySettings>>;
        }
      }
    }
  }
  return null;
}
const ENGINE_PRESETS = findEnginePresets();

const LEVELS: { label: string; value: QualityLevel }[] = [
  { label: 'Laag', value: 'laag' },
  { label: 'Midden', value: 'midden' },
  { label: 'Hoog', value: 'hoog' },
  { label: 'Ultra', value: 'ultra' },
];

interface SegCtl<T> {
  kind: 'seg';
  options: { label: string; value: T }[];
  get(): T;
  set(v: T): void;
}
interface SliderCtl {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  fmt(v: number): string;
  get(): number;
  set(v: number): void;
}
interface ToggleCtl {
  kind: 'toggle';
  get(): boolean;
  set(v: boolean): void;
}
type Ctl = SegCtl<unknown> | SliderCtl | ToggleCtl;
interface RowDef {
  label: string;
  help: string;
  ctl: Ctl;
  badge?: () => string;
}

interface BuiltRow {
  item: NavItem;
  sync(): void;
  help: string;
}

function seg<T>(options: { label: string; value: T }[], get: () => T, set: (v: T) => void): SegCtl<unknown> {
  return { kind: 'seg', options, get, set } as unknown as SegCtl<unknown>;
}

export function createSettingsPanel(ctx: UiContext, initial: SettingsTab = 'beeld'): SettingsPanel {
  const eng = ctx.engine;
  const q = () => eng.quality;
  const setQ = (patch: Partial<QualitySettings>) => {
    eng.setQuality(patch);
    syncAll();
  };

  function presetOf(level: QualityLevel): Partial<QualitySettings> {
    return ENGINE_PRESETS?.[level] ?? FALLBACK_PRESETS[level];
  }

  function applyPreset(level: QualityLevel): void {
    if (ENGINE_PRESETS) {
      eng.setQuality({ ...ENGINE_PRESETS[level], level });
    } else {
      const strip = (s: Readonly<QualitySettings>) => JSON.stringify({ ...s, level: '' });
      const before = strip(q());
      eng.setQuality({ level });
      // If the engine did not expand the preset itself, apply our table.
      if (strip(q()) === before) eng.setQuality({ ...FALLBACK_PRESETS[level], level });
    }
    syncAll();
  }

  function isCustom(): boolean {
    const p = presetOf(q().level);
    const cur = q() as unknown as Record<string, unknown>;
    return Object.entries(p).some(([k, v]) => k !== 'level' && cur[k] !== v);
  }

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const beeld: RowDef[] = [
    {
      label: 'Grafische kwaliteit',
      help: 'Voorinstelling voor alle opties hieronder. Aanbevolen voor een GTX 1660 Super: Hoog.',
      ctl: seg(LEVELS, () => q().level, (v) => applyPreset(v)),
      badge: () => (isCustom() ? 'Aangepast' : ''),
    },
    {
      label: 'Resolutieschaal',
      help: 'Interne renderresolutie. Lager geeft flink meer beelden per seconde, maar een zachter beeld.',
      ctl: { kind: 'slider', min: 0.5, max: 1, step: 0.05, fmt: pct, get: () => q().renderScale, set: (v) => setQ({ renderScale: v }) },
    },
    {
      label: 'Anti-aliasing',
      help: 'Gladde randen. SMAA is snel; MSAA is scherper maar zwaarder voor de videokaart.',
      ctl: seg([{ label: 'Uit', value: 'off' }, { label: 'SMAA', value: 'smaa' }, { label: 'MSAA', value: 'msaa' }], () => q().antialias, (v) => setQ({ antialias: v as QualitySettings['antialias'] })),
    },
    {
      label: 'Schaduwen',
      help: 'Zonneschaduwen van gebouwen, bomen en auto’s. Hogere kwaliteit geeft scherpere randen.',
      ctl: seg(
        [{ label: 'Uit', value: 0 }, { label: 'Laag', value: 1024 }, { label: 'Hoog', value: 2048 }, { label: 'Ultra', value: 4096 }],
        () => q().shadowMapSize,
        (v) => setQ({ shadowMapSize: v as QualitySettings['shadowMapSize'] }),
      ),
    },
    {
      label: 'Schaduwbereik',
      help: 'Tot welke afstand rond de auto schaduwen worden getekend.',
      ctl: { kind: 'slider', min: 40, max: 250, step: 10, fmt: (v) => `${Math.round(v)} m`, get: () => q().shadowDistance, set: (v) => setQ({ shadowDistance: v }) },
    },
    {
      label: 'Ambient occlusion',
      help: 'Zachte contactschaduwen in hoeken, onder auto’s en tussen gevels. Kost rekenkracht.',
      ctl: { kind: 'toggle', get: () => q().ao, set: (v) => setQ({ ao: v }) },
    },
    {
      label: 'Bloom',
      help: 'Zachte gloed rond felle lichten zoals lantaarns, koplampen en zonreflecties.',
      ctl: { kind: 'toggle', get: () => q().bloom, set: (v) => setQ({ bloom: v }) },
    },
    {
      label: 'Waterreflecties',
      help: 'Spiegelend: de grachtenpanden weerspiegelen echt in het water. Eenvoudig: alleen de lucht.',
      ctl: seg([{ label: 'Eenvoudig', value: 'env' }, { label: 'Spiegelend', value: 'planar' }], () => q().waterReflections, (v) => setQ({ waterReflections: v as QualitySettings['waterReflections'] })),
    },
    {
      label: 'Zichtafstand',
      help: 'Hoe ver gebouwen en details zichtbaar zijn.',
      ctl: { kind: 'slider', min: 400, max: 3000, step: 100, fmt: (v) => `${(v / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} km`, get: () => q().drawDistance, set: (v) => setQ({ drawDistance: v }) },
    },
    {
      label: 'Textuurfilter',
      help: 'Anisotrope filtering: scherpe klinkers en wegdek onder een schuine hoek.',
      ctl: seg([{ label: '2×', value: 2 }, { label: '4×', value: 4 }, { label: '8×', value: 8 }, { label: '16×', value: 16 }], () => q().anisotropy, (v) => setQ({ anisotropy: v as number })),
    },
    {
      label: 'Verkeersdrukte',
      help: 'Hoeveel auto’s, fietsers en voetgangers er in de stad rondrijden en -lopen.',
      ctl: { kind: 'slider', min: 0, max: 1, step: 0.1, fmt: pct, get: () => q().trafficDensity, set: (v) => setQ({ trafficDensity: v }) },
    },
    {
      label: 'Straatdetails',
      help: 'Dichtheid van geparkeerde fietsen, paaltjes en ander straatmeubilair.',
      ctl: { kind: 'slider', min: 0, max: 1, step: 0.1, fmt: pct, get: () => q().propDensity, set: (v) => setQ({ propDensity: v }) },
    },
  ];
  const geluid: RowDef[] = [
    {
      label: 'Hoofdvolume',
      help: 'Volume van motor, banden, claxon en omgevingsgeluid.',
      ctl: { kind: 'slider', min: 0, max: 1, step: 0.05, fmt: pct, get: () => ctx.volume.get(), set: (v) => ctx.volume.set(v) },
    },
  ];
  const drv = () => ctx.driving.get();
  const rijden: RowDef[] = [
    {
      label: 'Versnellingsbak',
      help: 'Automaat schakelt zelf (met kickdown). Handgeschakeld: schakel zelf op met Shift en terug met Ctrl (controller: RB / LB).',
      ctl: seg(
        [{ label: 'Automaat', value: 'auto' }, { label: 'Handgeschakeld', value: 'manual' }],
        () => drv().gearbox,
        (v) => ctx.driving.set({ gearbox: v as GearboxMode }),
      ),
    },
    {
      label: 'ABS',
      help: 'Antiblokkeersysteem: de wielen blokkeren niet bij hard remmen, zodat je kunt blijven sturen.',
      ctl: { kind: 'toggle', get: () => drv().assists.abs, set: (v) => ctx.driving.set({ assists: { abs: v } }) },
    },
    {
      label: 'Tractiecontrole (TCS)',
      help: 'Voorkomt doorslippende aandrijfwielen bij het optrekken, bijvoorbeeld op gladde klinkers.',
      ctl: { kind: 'toggle', get: () => drv().assists.tcs, set: (v) => ctx.driving.set({ assists: { tcs: v } }) },
    },
    {
      label: 'Stabiliteitscontrole (ESP)',
      help: 'Vangt slingeren en overstuur op. Uit = driften mogelijk; alleen voor ervaren bestuurders.',
      ctl: { kind: 'toggle', get: () => drv().assists.esc, set: (v) => ctx.driving.set({ assists: { esc: v } }) },
    },
  ];

  // ---------------------------------------------------------------- DOM
  const tabs: { id: SettingsTab; label: string; icon: string }[] = [
    { id: 'beeld', label: 'Beeld', icon: ICONS.monitor },
    { id: 'geluid', label: 'Geluid', icon: ICONS.volume },
    { id: 'rijden', label: 'Rijden', icon: ICONS.steering },
    { id: 'besturing', label: 'Besturing', icon: ICONS.gamepad },
  ];
  const tabBtns = tabs.map((t) => {
    const b = button('ad-tab', fromHTML(t.icon), h('span', null, t.label));
    b.addEventListener('click', () => setTab(t.id, true));
    return b;
  });
  const body = h('div', 'ad-set-body');
  const helpEl = h('div', 'ad-set-help');
  const el = h('div', 'ad-settings', h('div', 'ad-tabs', ...tabBtns), body, helpEl);
  let tab: SettingsTab = initial;
  let built: BuiltRow[] = [];

  const layer = new NavLayer({
    onBumper: (d) => {
      const i = tabs.findIndex((t) => t.id === tab);
      setTab(tabs[(i + d + tabs.length) % tabs.length].id, false);
    },
  });

  function buildRow(def: RowDef): BuiltRow {
    const labelEl = h('div', 'ad-set-label', def.label);
    const badge = h('span', 'ad-badge');
    if (def.badge) labelEl.append(badge);
    const ctlEl = h('div', 'ad-set-ctl');
    const row = h('div', 'ad-set-row', labelEl, ctlEl);
    let sync: () => void;
    let adjust: (d: Dir) => void;
    let activate: (() => void) | undefined;
    const c = def.ctl;
    if (c.kind === 'seg') {
      const segEl = h('div', 'ad-seg');
      const btns = c.options.map((o) => {
        const b = button('ad-seg-btn', o.label);
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          layer.focusEl(row);
          c.set(o.value);
        });
        segEl.append(b);
        return b;
      });
      ctlEl.append(segEl);
      sync = () => {
        const cur = c.get();
        btns.forEach((b, i) => b.classList.toggle('is-on', c.options[i].value === cur));
        if (def.badge) badge.textContent = def.badge();
      };
      adjust = (d) => {
        const i = c.options.findIndex((o) => o.value === c.get());
        const n = clamp((i < 0 ? 0 : i) + d, 0, c.options.length - 1);
        if (n !== i) c.set(c.options[n].value);
      };
      activate = () => {
        const i = c.options.findIndex((o) => o.value === c.get());
        c.set(c.options[(i + 1) % c.options.length].value);
      };
    } else if (c.kind === 'slider') {
      const input = h('input', 'ad-range');
      input.type = 'range';
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.tabIndex = -1;
      const val = h('span', 'ad-range-val ad-num');
      input.addEventListener('input', () => c.set(parseFloat(input.value)));
      input.addEventListener('pointerdown', () => layer.focusEl(row));
      ctlEl.append(h('div', 'ad-slider', input), val);
      sync = () => {
        const v = c.get();
        input.value = String(v);
        input.style.setProperty('--p', `${((v - c.min) / (c.max - c.min)) * 100}%`);
        val.textContent = c.fmt(v);
      };
      adjust = (d) => {
        const v = clamp(Math.round((c.get() + d * c.step) / c.step) * c.step, c.min, c.max);
        c.set(Number(v.toFixed(4)));
      };
    } else {
      const sw = button('ad-switch', h('i'));
      const txt = h('span', 'ad-switch-txt');
      sw.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.focusEl(row);
        c.set(!c.get());
      });
      ctlEl.append(txt, sw);
      sync = () => {
        const on = c.get();
        sw.classList.toggle('is-on', on);
        txt.textContent = on ? 'Aan' : 'Uit';
      };
      adjust = (d) => c.set(d > 0);
      activate = () => c.set(!c.get());
    }
    sync();
    const item: NavItem = {
      el: row,
      adjust,
      activate,
      onFocus: () => {
        helpEl.textContent = def.help;
      },
    };
    return { item, sync, help: def.help };
  }

  /** Legend of the dashboard warning lights shown in the HUD (Rijden tab). */
  function telltaleLegend(): HTMLElement {
    const items: [string, string, string, string][] = [
      ['tt-green', TELLTALES.lowBeam, 'Dimlicht', 'Koplampen aan'],
      ['tt-red', TELLTALES.handbrake, 'Handrem', 'Handrem aangetrokken'],
      ['tt-amber', TELLTALES.abs, 'ABS', 'Knippert: ABS grijpt in. Brandt: ABS uit'],
      ['tt-amber', TELLTALES.esp, 'ESP', 'Knippert: TCS of ESP grijpt in'],
      ['tt-amber', TELLTALES.espOff, 'ESP uit', 'TCS of ESP uitgeschakeld'],
    ];
    const grid = h('div', 'ad-ttl-grid');
    for (const [cls, svg, name, text] of items) {
      grid.append(h('div', 'ad-ttl-item', h('div', `ad-ttl-ico ${cls}`, fromHTML(svg)), h('div', null, h('b', null, name), h('span', null, text))));
    }
    return h('div', 'ad-ttl', h('div', 'ad-ttl-title', 'Waarschuwingslampjes op het dashboard'), grid);
  }

  function syncAll(): void {
    built.forEach((b) => b.sync());
  }

  function setTab(t: SettingsTab, focusTabs: boolean): void {
    tab = t;
    tabBtns.forEach((b, i) => b.classList.toggle('is-on', tabs[i].id === t));
    body.textContent = '';
    body.scrollTop = 0;
    const tabItems: NavItem[] = tabBtns.map((b, i) => ({
      el: b,
      onFocus: (byPointer) => {
        if (!byPointer && tabs[i].id !== tab) setTab(tabs[i].id, true);
        helpEl.textContent = 'Wissel van tabblad met ← → of Q / E (controller: LB / RB).';
      },
    }));
    if (t === 'besturing') {
      built = [];
      body.append(controlsTable());
      helpEl.textContent = 'Een Xbox- of andere XInput-controller wordt automatisch herkend.';
    } else {
      const defs = t === 'beeld' ? beeld : t === 'geluid' ? geluid : rijden;
      built = defs.map(buildRow);
      for (const b of built) body.append(b.item.el);
      if (t === 'rijden') body.append(telltaleLegend());
      helpEl.textContent = built[0]?.help ?? '';
    }
    const tabIdx = tabs.findIndex((x) => x.id === t);
    layer.setRows([tabItems, ...built.map((b) => [b.item])], focusTabs || !built.length ? [0, tabIdx] : [1, 0]);
  }

  setTab(initial, true);
  return {
    el,
    layer,
    setTab: (t) => setTab(t, true),
    refresh: syncAll,
  };
}
