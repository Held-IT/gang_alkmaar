// Inline SVG artwork for the UI (original drawings): cheese wheel points, the logo cheese and
// illustrated arena cards (used when no rendered thumbnail exists in public/assets/brawl/).
import type { ArenaId } from '../contracts';

export function cheeseSvg(cls = 'ga-cheese'): string {
  return `<svg class="${cls}" viewBox="0 0 40 40" aria-hidden="true">
  <circle cx="20" cy="20" r="18" fill="#2b1a10"/>
  <circle cx="20" cy="20" r="15.6" fill="#e2a92a"/>
  <circle cx="20" cy="20" r="12.6" fill="#f6c343"/>
  <path d="M20 20 L33.5 13.5 A15 15 0 0 1 34.6 23 Z" fill="#fff1b8" stroke="#2b1a10" stroke-width="1.6" stroke-linejoin="round"/>
  <ellipse cx="14.5" cy="23.5" rx="4.2" ry="2.8" fill="#c2261b"/>
  <circle cx="22" cy="12.5" r="1.4" fill="#d99a17"/><circle cx="12.5" cy="15" r="1.1" fill="#d99a17"/>
  <circle cx="24" cy="27" r="1.6" fill="#d99a17"/>
  <circle cx="20" cy="20" r="18" fill="none" stroke="#2b1a10" stroke-width="2.4"/>
</svg>`;
}

/** A Gouda-style cheese wheel seen from the side: one round won (scoreboard / score strip). */
export function cheeseWheelSvg(cls = 'ga-cheese'): string {
  return `<svg class="${cls}" viewBox="0 0 48 36" aria-hidden="true">
  <path d="M3 14 V22 A21 9 0 0 0 45 22 V14 Z" fill="#e09a1c" stroke="#2b1a10" stroke-width="2.2" stroke-linejoin="round"/>
  <path d="M5 20 A19 7.5 0 0 0 43 20" fill="none" stroke="#f4bb38" stroke-width="2" stroke-linecap="round"/>
  <ellipse cx="24" cy="14" rx="21" ry="9" fill="#f8cc48" stroke="#2b1a10" stroke-width="2.2"/>
  <ellipse cx="24" cy="13.4" rx="15" ry="5.6" fill="#fbdb6e"/>
  <ellipse cx="17" cy="12.2" rx="4.6" ry="1.6" fill="#fff3c4" opacity="0.85"/>
  <ellipse cx="33" cy="24.2" rx="4" ry="2.4" fill="#c8281c" stroke="#2b1a10" stroke-width="1.2"/>
  <path d="M31.4 24.2 h3.2" stroke="#fff1b8" stroke-width="1" stroke-linecap="round"/>
</svg>`;
}

const sky = (id: string) => `<defs><linearGradient id="sky-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fc3e8"/><stop offset="1" stop-color="#e6f1f5"/></linearGradient></defs><rect width="160" height="100" fill="url(#sky-${id})"/>`;

export function arenaArt(id: ArenaId): string {
  if (id === 'rondvaartboot') {
    return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice">${sky(id)}
  <path d="M0 30h18v-8l6-6 6 6v8h14v-12l7-7 7 7v12h12v-6l5-5 5 5v6h16v-14l7-6 7 6v14h14v-9l6-6 6 6v9h12v40H0z" fill="#8c3b2a"/>
  <path d="M0 52h160v48H0z" fill="#2e5b6e"/>
  <path d="M0 58c20-3 40 3 60 0s40-3 60 0 30 2 40 0" stroke="#7fb3c4" stroke-width="2" fill="none" opacity=".6"/>
  <path d="M18 62h124l-8 12H30z" fill="#f4efe2" stroke="#2b1a10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M30 62l6-10h86l8 10z" fill="#9dd0e6" stroke="#2b1a10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M50 52v10M70 52v10M90 52v10M110 52v10" stroke="#2b1a10" stroke-width="2"/>
  <path d="M30 70h104" stroke="#d52b1e" stroke-width="3"/>
  <path d="M0 20h160" stroke="#5a4a3a" stroke-width="0"/>
</svg>`;
  }
  if (id === 'molen') {
    return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice">${sky(id)}
  <path d="M0 82h160v18H0z" fill="#6aa04a"/>
  <path d="M66 86l4-46h20l4 46z" fill="#5a3b2a" stroke="#2b1a10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M68 40l12-12 12 12z" fill="#7d6a55" stroke="#2b1a10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M46 62h68" stroke="#2b1a10" stroke-width="5" stroke-linecap="round"/>
  <path d="M46 62h68" stroke="#c9a46a" stroke-width="2.5" stroke-linecap="round"/>
  <g transform="translate(80 36) rotate(18)" stroke="#2b1a10" stroke-width="2" fill="#f4efe2">
    <rect x="-3" y="-44" width="6" height="40"/><rect x="-3" y="4" width="6" height="40"/>
    <rect x="-44" y="-3" width="40" height="6"/><rect x="4" y="-3" width="40" height="6"/>
    <circle r="4" fill="#2b1a10"/>
  </g>
  <path d="M74 86v-12h12v12" fill="#2b1a10"/>
</svg>`;
  }
  return `<svg viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice">${sky(id)}
  <path d="M0 78h160v22H0z" fill="#b9a68a"/>
  <path d="M0 84h160M0 92h160" stroke="#9c8a70" stroke-width="1"/>
  <path d="M52 78V44l8-8v-6l6-6 6 6v-10l8-12 8 12v10l6-6 6 6v6l8 8v34z" fill="#a8432c" stroke="#2b1a10" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M72 78V60a8 8 0 0 1 16 0v18z" fill="#2b1a10"/>
  <path d="M62 52h8v8h-8zM90 52h8v8h-8z" fill="#f4efe2" stroke="#2b1a10" stroke-width="1.5"/>
  <circle cx="80" cy="34" r="4" fill="#f4efe2" stroke="#2b1a10" stroke-width="1.5"/>
  <g fill="#f6c343" stroke="#2b1a10" stroke-width="1.5">
    <ellipse cx="22" cy="82" rx="9" ry="4"/><ellipse cx="22" cy="78" rx="9" ry="4"/><ellipse cx="40" cy="83" rx="9" ry="4"/>
    <ellipse cx="122" cy="83" rx="9" ry="4"/><ellipse cx="140" cy="82" rx="9" ry="4"/><ellipse cx="140" cy="78" rx="9" ry="4"/>
  </g>
</svg>`;
}

/** The wobbly logo: per-letter spans with staggered animation delays. */
export function logoHtml(): string {
  const letters = (word: string, offset: number) =>
    [...word].map((c, i) => `<span class="ga-l" style="animation-delay:${-((i + offset) * 0.17).toFixed(2)}s">${c}</span>`).join('');
  return `<div class="ga-logo" aria-label="Gang Alkmaar">
  <div class="ga-logo-row ga-logo-gang">${letters('GANG', 0)}${cheeseSvg('ga-logo-cheese')}</div>
  <div class="ga-logo-row ga-logo-alk">${letters('ALKMAAR', 4)}</div>
</div>`;
}
