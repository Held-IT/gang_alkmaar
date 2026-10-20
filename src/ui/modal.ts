// Confirmation dialog and toast notifications.
import type { ConfirmOptions } from './context';
import { afterTransition, button, h } from './dom';
import { NavLayer, type NavController } from './nav';

export function createConfirm(root: HTMLElement, nav: NavController): (o: ConfirmOptions) => Promise<boolean> {
  return (o) =>
    new Promise<boolean>((resolve) => {
      const cancel = button('ad-btn-ghost ad-btn-lg', o.cancel ?? 'Annuleren');
      const ok = button(o.danger ? 'ad-btn-primary ad-btn-lg' : 'ad-btn-light ad-btn-lg', o.ok);
      const card = h('div', 'ad-modal-card', h('div', 'ad-modal-title', o.title), h('p', 'ad-modal-text', o.text), h('div', 'ad-modal-actions', cancel, ok));
      const el = h('div', 'ad-modal', card);
      root.append(el);
      requestAnimationFrame(() => el.classList.add('is-visible'));
      let done = false;
      const close = (v: boolean) => {
        if (done) return;
        done = true;
        nav.remove(layer);
        el.classList.remove('is-visible');
        afterTransition(el, 300, () => el.remove());
        resolve(v);
      };
      cancel.addEventListener('click', () => close(false));
      ok.addEventListener('click', () => close(true));
      el.addEventListener('pointerdown', (e) => {
        if (e.target === el) close(false);
      });
      const layer = new NavLayer({ onBack: () => close(false) });
      layer.setRows([[{ el: cancel }, { el: ok }]], [0, 0]);
      nav.push(layer);
    });
}

export interface Toaster {
  toast(message: string, ms?: number): void;
  dispose(): void;
}

export function createToaster(root: HTMLElement): Toaster {
  const stack = h('div', 'ad-toasts');
  root.append(stack);
  return {
    toast(message, ms = 2600) {
      const t = h('div', 'ad-toast', h('i'), h('span', null, message));
      stack.append(t);
      while (stack.children.length > 3) stack.firstElementChild?.remove();
      requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-in')));
      window.setTimeout(() => {
        t.classList.remove('is-in');
        t.classList.add('is-out');
        afterTransition(t, 400, () => t.remove());
      }, Math.max(800, ms));
    },
    dispose() {
      stack.remove();
    },
  };
}
