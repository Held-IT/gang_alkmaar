// Modals shared by the lobby and the pause menu: Instellingen (quality presets via
// engine.setQuality, volumes, name tags, screen shake), Besturing (key/pad table), Credits; plus
// the pause menu itself (Hervatten, Opnieuw, Naar lobby, Instellingen, Besturing, Credits, Afsluiten).
import type { Engine, QualityLevel } from '../../contracts';
import { QUALITY_LABELS, QUALITY_LEVELS } from '../../core/quality';
import { button, h } from '../../ui/dom';
import { BINDINGS } from '../input';
import type { BrawlSettings } from '../prefs';
import type { Nav, NavItem } from './nav';

export interface PauseHandlers {
  resume(): void;
  restart(): void;
  lobby(): void;
  quit(): void;
}

export interface Menus {
  openSettings(onClose?: () => void): void;
  openControls(onClose?: () => void): void;
  openCredits(onClose?: () => void): void;
  openPause(handlers: PauseHandlers): void;
  closePause(): void;
  readonly pauseOpen: boolean;
  readonly modalOpen: boolean;
}

const CREDITS: [string, string][] = [
  ['Spel', 'Gang Alkmaar: een eigen, originele vechtpartij in de binnenstad van Alkmaar. Gemaakt met Claude Code.'],
  ['Spellogica', 'Spellogica deels gebaseerd op gb-rust door muffinmxn, MIT-licentie (github.com/muffinmxn/gang-beasts-rust).'],
  ['Kaartdata', 'Straten, water en plekken: © OpenStreetMap-bijdragers (ODbL).'],
  ['Gebouwen', '3D BAG door tudelft3d en 3DGI (CC BY 4.0), op basis van BAG en AHN (Kadaster, Rijkswaterstaat).'],
  ['Texturen & lucht', 'ambientCG en Poly Haven (CC0).'],
  ['Techniek', 'three.js (MIT), Rapier physics door Dimforge (Apache-2.0), postprocessing (Zlib), Electron (MIT), Vite (MIT).'],
  ['Geluid & muziek', 'Alles live gesynthetiseerd met WebAudio: geen opnames. Draaiorgelwals en beiaardmelodie zijn eigen composities.'],
  ['Met dank aan', 'Alle kaasdragers, schippers en molenaars van Alkmaar. Er zijn geen echte kazen gewond geraakt.'],
];

export function createMenus(
  root: HTMLElement,
  nav: Nav,
  engine: Engine,
  settings: BrawlSettings,
  onSettings: (s: BrawlSettings) => void,
  onClick: () => void,
): Menus {
  let modalCount = 0;
  let pause: { wrap: HTMLElement; close(): void } | null = null;

  function modal(title: string, body: HTMLElement, items: NavItem[], onClose?: () => void): () => void {
    const closeBtn = button('ga-btn', 'Sluiten');
    const card = h('div', 'ga-modal ga-card', h('div', 'ga-modal-title', title), body, h('div', null, closeBtn));
    (card.lastElementChild as HTMLElement).style.cssText = 'display:flex;justify-content:center;margin-top:0.6em';
    const wrap = h('div', 'ga-modal-wrap', card);
    root.appendChild(wrap);
    modalCount++;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      modalCount--;
      handle.close();
      wrap.remove();
      onClick();
      onClose?.();
    };
    const maxRow = items.reduce((m, it) => Math.max(m, it.row), -1);
    const all = [...items, { el: closeBtn, row: maxRow + 1, confirm: close }];
    closeBtn.addEventListener('click', close);
    wrap.addEventListener('mousedown', (e) => {
      if (e.target === wrap) close();
    });
    const handle = nav.push({ items: all, back: close, onMove: onClick }, items.length ? 0 : all.length - 1);
    return close;
  }

  function segmented<T extends string>(opts: { id: T; label: string }[], get: () => T, set: (v: T) => void) {
    const el = h('div', 'ga-seg');
    const btns = opts.map((o) => {
      const b = button('', o.label);
      b.addEventListener('click', () => {
        set(o.id);
        sync();
        onClick();
      });
      el.appendChild(b);
      return b;
    });
    const sync = () => btns.forEach((b, i) => b.classList.toggle('ga-sel', opts[i].id === get()));
    sync();
    const step = (d: number) => {
      const i = opts.findIndex((o) => o.id === get());
      const n = opts[Math.max(0, Math.min(opts.length - 1, i + d))];
      set(n.id);
      sync();
    };
    return { el, left: () => step(-1), right: () => step(1) };
  }

  function slider(get: () => number, set: (v: number) => void) {
    const fill = h('div', 'ga-slider-fill');
    const track = h('div', 'ga-slider-track', fill);
    const val = h('span', 'ga-slider-val');
    const sync = () => {
      fill.style.width = `${Math.round(get() * 100)}%`;
      val.textContent = String(Math.round(get() * 100));
    };
    const fromMouse = (e: MouseEvent) => {
      const r = track.getBoundingClientRect();
      set(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      sync();
    };
    track.addEventListener('mousedown', (e) => {
      fromMouse(e);
      const mv = (ev: MouseEvent) => fromMouse(ev);
      const up = () => {
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });
    sync();
    const step = (d: number) => {
      set(Math.max(0, Math.min(1, Math.round((get() + d) * 10) / 10)));
      sync();
    };
    return { el: h('div', 'ga-slider', track, val), left: () => step(-0.1), right: () => step(0.1) };
  }

  function row(label: string, control: HTMLElement): HTMLElement {
    return h('div', 'ga-row', h('div', 'ga-row-label', label), control);
  }

  const menus: Menus = {
    openSettings(onClose) {
      const update = (patch: Partial<BrawlSettings>) => {
        Object.assign(settings, patch);
        onSettings(settings);
      };
      const quality = segmented(
        QUALITY_LEVELS.map((l) => ({ id: l, label: QUALITY_LABELS[l] })),
        () => engine.quality.level,
        (l: QualityLevel) => {
          if (l !== engine.quality.level) engine.setQuality({ level: l });
        },
      );
      const vol = slider(() => settings.volume, (v) => update({ volume: v }));
      const mus = slider(() => settings.music, (v) => update({ music: v }));
      const tags = segmented(
        [
          { id: 'altijd', label: 'Altijd' },
          { id: 'vervagen', label: 'Vervagen' },
          { id: 'uit', label: 'Uit' },
        ],
        () => settings.tags,
        (v) => update({ tags: v }),
      );
      const shake = segmented(
        [
          { id: 'aan', label: 'Aan' },
          { id: 'uit', label: 'Uit' },
        ],
        () => (settings.shake ? 'aan' : 'uit'),
        (v) => update({ shake: v === 'aan' }),
      );
      const rows = [
        row('Beeldkwaliteit', quality.el),
        row('Effecten', vol.el),
        row('Muziek', mus.el),
        row('Naamkaartjes', tags.el),
        row('Schudden', shake.el),
      ];
      const body = h('div', 'ga-menu', ...rows);
      body.style.minWidth = '30em';
      const ctl = [quality, vol, mus, tags, shake];
      modal(
        'Instellingen',
        body,
        rows.map((el, i) => ({ el, row: i, left: ctl[i].left, right: ctl[i].right })),
        onClose,
      );
    },
    openControls(onClose) {
      const table = h('table', 'ga-table');
      table.innerHTML =
        '<tr><th>Actie</th><th>Toetsenbord &amp; muis</th><th>Controller</th></tr>' +
        BINDINGS.map((b) => `<tr><td>${b.action}</td><td>${b.keys}</td><td>${b.pad}</td></tr>`).join('');
      const note = h(
        'div',
        'ga-step-sub',
        'Je loopt ten opzichte van de camera. Een knock-out vechter kun je oppakken en de gracht in gooien.',
      );
      modal('Besturing', h('div', null, table, note), [], onClose);
    },
    openCredits(onClose) {
      const body = h('div', 'ga-credits');
      for (const [title, text] of CREDITS) body.append(h('h4', null, title), h('p', null, text));
      modal('Credits', body, [], onClose);
    },
    openPause(handlers) {
      if (pause) return;
      const entries: [string, () => void][] = [
        ['Hervatten', () => handlers.resume()],
        ['Opnieuw', () => handlers.restart()],
        ['Naar lobby', () => handlers.lobby()],
        ['Instellingen', () => menus.openSettings()],
        ['Besturing', () => menus.openControls()],
        ['Credits', () => menus.openCredits()],
        ['Afsluiten', () => handlers.quit()],
      ];
      const btns = entries.map(([label, fn]) => {
        const b = button('ga-btn', label);
        b.addEventListener('click', () => {
          onClick();
          fn();
        });
        return b;
      });
      const card = h('div', 'ga-modal ga-card', h('div', 'ga-modal-title', 'Pauze'), h('div', 'ga-menu', ...btns));
      const wrap = h('div', 'ga-modal-wrap', card);
      root.appendChild(wrap);
      const handle = nav.push(
        {
          items: btns.map((el, i) => ({ el, row: i, confirm: () => (onClick(), entries[i][1]()) })),
          back: () => handlers.resume(),
          onMove: onClick,
        },
        0,
      );
      pause = {
        wrap,
        close() {
          handle.close();
          wrap.remove();
        },
      };
    },
    closePause() {
      pause?.close();
      pause = null;
    },
    get pauseOpen() {
      return pause !== null;
    },
    get modalOpen() {
      return modalCount > 0;
    },
  };
  return menus;
}
