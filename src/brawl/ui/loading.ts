// Loading screen: wobbly Gang Alkmaar logo on cheese yellow with red-white flag stripes, a
// cheese progress bar, rotating (Dutch) tips and the data attribution.
import { h } from '../../ui/dom';
import { logoHtml } from './icons';

const TIPS = [
  'Tip: tik op een handknop om te stoten, houd hem vast om te grijpen.',
  'Tip: grijp met beide handen, houd Optillen vast en laat los om te gooien.',
  'Tip: bukken vlak voor een tegenstander geeft een kopstoot.',
  'Tip: wie in de gracht ligt, is af. De kazen blijven gewoon liggen.',
  'Tip: op de rondvaartboot moet je bukken voor de bruggen!',
  'Tip: de wieken van de Molen van Piet draaien echt. Kijk uit je doppen.',
  'Wist je dat? Op de Alkmaarse kaasmarkt sjouwen de kaasdragers al eeuwen met berries vol kaas.',
  'Wist je dat? De Waag was vroeger een kapel en heeft een beiaard die je over het plein hoort.',
  'Tip: een knock-out vechter kun je makkelijk optillen. Even weg met hem!',
];

export interface LoadingScreen {
  set(fraction: number, label: string): void;
  hide(): Promise<void>;
}

export function createLoadingScreen(root: HTMLElement, attribution: string): LoadingScreen {
  const fill = h('div', 'ga-bar-fill');
  const label = h('span', null, 'Opstarten');
  const pct = h('span', null, '0%');
  const tip = h('div', 'ga-loading-tip', TIPS[Math.floor(Math.random() * TIPS.length)]);
  const logo = document.createElement('div');
  logo.innerHTML = logoHtml();
  const el = h(
    'div',
    'ga-loading',
    logo.firstElementChild,
    h('div', 'ga-loading-box', h('div', 'ga-loading-label', label, pct), h('div', 'ga-bar', fill), tip),
    h('div', 'ga-loading-attr', attribution),
    h('div', 'ga-loading-flag'),
  );
  root.appendChild(el);
  let tipIndex = TIPS.indexOf(tip.textContent ?? '');
  const timer = window.setInterval(() => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    tip.textContent = TIPS[tipIndex];
  }, 4200);
  return {
    set(f, text) {
      const p = Math.round(Math.max(0, Math.min(1, f)) * 100);
      fill.style.width = `${p}%`;
      pct.textContent = `${p}%`;
      label.textContent = text;
    },
    hide() {
      window.clearInterval(timer);
      el.classList.add('ga-out');
      return new Promise((r) =>
        window.setTimeout(() => {
          el.remove();
          r();
        }, 750),
      );
    },
  };
}
