// Centered glass sheet used from the main menu for Instellingen / Besturing / Credits.
import type { SheetKind, UiContext } from './context';
import { createCreditsPage, type CreditsPage } from './credits';
import { afterTransition, button, fromHTML, h } from './dom';
import { ICONS } from './icons';
import type { NavLayer } from './nav';
import { createSettingsPanel, type SettingsPanel } from './settings';

export interface Sheet {
  readonly visible: boolean;
  open(kind: SheetKind): void;
  close(): void;
}

export function createSheet(ctx: UiContext): Sheet {
  const title = h('div', 'ad-sheet-title');
  const closeBtn = button('ad-icon-btn', fromHTML(ICONS.close));
  const body = h('div', 'ad-sheet-body');
  const card = h('div', 'ad-sheet-card', h('div', 'ad-sheet-head', title, closeBtn), body);
  const el = h('div', 'ad-sheet is-hidden', card);
  ctx.root.append(el);
  closeBtn.addEventListener('click', () => close());
  el.addEventListener('pointerdown', (e) => {
    if (e.target === el) close();
  });

  let settings: SettingsPanel | null = null;
  let credits: CreditsPage | null = null;
  let layer: NavLayer | null = null;
  let visible = false;

  function open(kind: SheetKind): void {
    if (layer) ctx.nav.remove(layer);
    body.textContent = '';
    if (kind === 'credits') {
      credits ??= createCreditsPage();
      credits.load();
      body.append(credits.el);
      layer = credits.layer;
      title.textContent = 'Credits';
    } else {
      settings ??= createSettingsPanel(ctx, 'beeld');
      settings.setTab(kind === 'controls' ? 'besturing' : 'beeld');
      settings.refresh();
      body.append(settings.el);
      layer = settings.layer;
      title.textContent = kind === 'controls' ? 'Besturing' : 'Instellingen';
    }
    layer.opts.onBack = () => close();
    ctx.nav.push(layer);
    visible = true;
    el.classList.remove('is-hidden');
    requestAnimationFrame(() => el.classList.add('is-visible'));
  }

  function close(): void {
    if (!visible) return;
    visible = false;
    if (layer) ctx.nav.remove(layer);
    layer = null;
    el.classList.remove('is-visible');
    afterTransition(el, 350, () => {
      if (!visible) el.classList.add('is-hidden');
    });
  }

  return {
    get visible() {
      return visible;
    },
    open,
    close,
  };
}
