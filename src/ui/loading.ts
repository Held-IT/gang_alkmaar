// Loading screen: dusk sky, Alkmaar skyline silhouette with a turning windmill, progress bar and
// rotating Dutch tips / Alkmaar facts.

import { afterTransition, clamp, h, fromHTML } from './dom';
import { EMBLEM } from './icons';
import { buildSkyline } from './skyline';
import { TIPS } from './tips';

export interface LoadingScreen {
  readonly visible: boolean;
  show(fraction: number, label?: string): void;
  hide(): void;
  dispose(): void;
}

const TIP_MS = 6500;

export function brandBlock(size: 'xl' | 'md', tagline = 'Historische binnenstad'): HTMLElement {
  return h(
    'div',
    `ad-brand ad-brand-${size}`,
    fromHTML(EMBLEM),
    h('div', 'ad-brand-text', h('div', 'ad-brand-name', 'Alkmaar', h('span', null, 'Drive')), h('div', 'ad-brand-tag', tagline)),
  );
}

export function createLoadingScreen(parent: HTMLElement): LoadingScreen {
  let el: HTMLElement | null = null;
  let fill: HTMLElement;
  let pct: HTMLElement;
  let label: HTMLElement;
  let tipBox: HTMLElement;
  let tipKicker: HTMLElement;
  let tipText: HTMLElement;
  let tipTimer = 0;
  let tipIndex = Math.floor(Math.random() * TIPS.length);
  let visible = false;
  let shown = 0;

  function build(): HTMLElement {
    const sky = buildSkyline();
    fill = h('div', 'ad-load-fill');
    pct = h('span', 'ad-load-pct', '0%');
    label = h('span', 'ad-load-label', 'Laden…');
    tipKicker = h('div', 'ad-tip-kicker');
    tipText = h('div', 'ad-tip-text');
    tipBox = h('div', 'ad-load-tip', tipKicker, tipText);
    const skyline = h('div', 'ad-loading-skyline');
    skyline.append(fromHTML(sky.scene), fromHTML(sky.sails));
    return h(
      'div',
      'ad-loading',
      h('div', 'ad-loading-sky'),
      skyline,
      h(
        'div',
        'ad-loading-center',
        brandBlock('xl'),
        h('div', 'ad-load-bar', fill),
        h('div', 'ad-load-meta', label, pct),
      ),
      tipBox,
      h('div', 'ad-loading-attrib', 'Kaartdata © OpenStreetMap-bijdragers · Gebouwen © 3D BAG (tudelft3d en 3DGI)'),
    );
  }

  function setTip(i: number): void {
    const t = TIPS[i % TIPS.length];
    tipKicker.textContent = t.kicker;
    tipText.textContent = t.text;
  }

  function rotateTip(): void {
    tipBox.classList.add('is-out');
    afterTransition(tipBox, 450, () => {
      tipIndex = (tipIndex + 1) % TIPS.length;
      setTip(tipIndex);
      tipBox.classList.remove('is-out');
    });
  }

  return {
    get visible() {
      return visible;
    },
    show(fraction, text) {
      if (!el) {
        el = build();
        parent.append(el);
        setTip(tipIndex);
      }
      if (!visible) {
        visible = true;
        el.classList.remove('is-hidden', 'is-hiding');
        window.clearInterval(tipTimer);
        tipTimer = window.setInterval(rotateTip, TIP_MS);
      }
      // never let the bar go backwards (several loaders may report)
      shown = Math.max(shown, clamp(fraction, 0, 1));
      fill.style.transform = `scaleX(${shown})`;
      pct.textContent = `${Math.round(shown * 100)}%`;
      if (text) label.textContent = text;
    },
    hide() {
      if (!el || !visible) return;
      visible = false;
      window.clearInterval(tipTimer);
      const node = el;
      node.classList.add('is-hiding');
      afterTransition(node, 800, () => {
        if (!visible) {
          node.classList.add('is-hidden');
          shown = 0;
        }
      });
    },
    dispose() {
      window.clearInterval(tipTimer);
      el?.remove();
      el = null;
    },
  };
}
