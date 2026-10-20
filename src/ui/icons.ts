// Inline SVG icons (own drawings, 24x24 line style) and the Alkmaar emblem.

const S = (body: string, extra = ''): string =>
  `<svg class="ad-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const ICONS = {
  play: S('<path d="M8 5.6v12.8L18.2 12z" fill="currentColor" stroke="none"/>'),
  car: S(
    '<path d="M4 15.6v-2.4l1.9-4.6A2 2 0 0 1 7.8 7.3h8.4a2 2 0 0 1 1.9 1.3l1.9 4.6v2.4a.9.9 0 0 1-.9.9H18M6 16.5h-1.1a.9.9 0 0 1-.9-.9"/>' +
      '<path d="M4.3 13h15.4M9.6 16.5h4.8"/><circle cx="7.8" cy="16.5" r="1.8"/><circle cx="16.2" cy="16.5" r="1.8"/>',
  ),
  pin: S('<path d="M12 21s-6.4-6-6.4-10.8a6.4 6.4 0 0 1 12.8 0C18.4 15 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.3"/>'),
  sliders: S('<path d="M4 7h9.5M17.5 7H20M4 17h3.5M11.5 17H20"/><circle cx="15.5" cy="7" r="2"/><circle cx="9.5" cy="17" r="2"/>'),
  gamepad: S(
    '<path d="M7.6 7.5h8.8a4.4 4.4 0 0 1 4.3 5.4l-.8 3.7a2 2 0 0 1-3.3 1.1l-2.1-2.1h-5l-2.1 2.1a2 2 0 0 1-3.3-1.1l-.8-3.7a4.4 4.4 0 0 1 4.3-5.4z"/>' +
      '<path d="M8.2 10.6v3.2M6.6 12.2h3.2"/><circle cx="15.4" cy="11.2" r=".5" fill="currentColor"/><circle cx="17.2" cy="13" r=".5" fill="currentColor"/>',
  ),
  info: S('<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.7v.2"/>'),
  power: S('<path d="M12 3.6v7.6"/><path d="M7.2 6.6a7.4 7.4 0 1 0 9.6 0"/>'),
  map: S('<path d="M9 4.6 3.8 6.5v13L9 17.6l6 1.9 5.2-1.9v-13L15 6.5z"/><path d="M9 4.6v13M15 6.5v13"/>'),
  monitor: S('<rect x="3.5" y="4.5" width="17" height="11.5" rx="1.6"/><path d="M9 20h6M12 16v4"/>'),
  volume: S('<path d="M4.5 9.5h3l4.5-3.8v12.6l-4.5-3.8h-3z"/><path d="M15.4 9a4.2 4.2 0 0 1 0 6M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
  keyboard: S('<rect x="2.8" y="6.2" width="18.4" height="11.6" rx="1.8"/><path d="M6.5 10h.1M9.5 10h.1M12.5 10h.1M15.5 10h.1M17.5 10h.1M7.5 14h9"/>'),
  chevL: S('<path d="m14.5 6-6 6 6 6"/>'),
  chevR: S('<path d="m9.5 6 6 6-6 6"/>'),
  arrowR: S('<path d="M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5"/>'),
  close: S('<path d="m6 6 12 12M18 6 6 18"/>'),
  back: S('<path d="M9.5 6.5 4 12l5.5 5.5M4.5 12H20"/>'),
  bolt: S('<path d="M13 3 5.5 13.2h5.6L10.6 21l7.9-10.4h-5.7z" fill="currentColor" stroke="none"/>'),
  steering: S('<circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="2.2"/><path d="M3.6 10.6c2.6-.9 5.4-1.1 6.3-.3M20.4 10.6c-2.6-.9-5.4-1.1-6.3-.3M12 14.2v6.4"/>'),
  compass: S('<circle cx="12" cy="12" r="8.6"/><path d="m12 6.5 2.2 5.5L12 17.5 9.8 12z" fill="currentColor" stroke="none"/>'),
} as const;

export type IconName = keyof typeof ICONS;

const T = (body: string): string =>
  `<svg class="ad-tt-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// circle with "( )" brackets, shared by the handbrake and ABS lights (ISO 2575 style)
const BRACKETS = '<circle cx="12" cy="12" r="6.6"/><path d="M4.1 6.4a8.8 8.8 0 0 0 0 11.2M19.9 6.4a8.8 8.8 0 0 1 0 11.2"/>';
const TT_TEXT = 'fill="currentColor" stroke="none" text-anchor="middle" font-family="Bahnschrift, Segoe UI, sans-serif" font-weight="700"';
// car from behind with skid marks (stability control)
const ESP_CAR =
  '<path d="M6.6 10.4 8 6.9a1.5 1.5 0 0 1 1.4-1h5.2a1.5 1.5 0 0 1 1.4 1l1.4 3.5v2.7H6.6z" fill="currentColor" stroke="none"/>' +
  '<path d="M7.6 13.1v1.3M16.4 13.1v1.3"/>';

/** Dashboard warning lights (own drawings after the ISO 2575 symbols). Colour = currentColor. */
export const TELLTALES = {
  lowBeam: T(
    '<path d="M12.4 6.3c4.4 0 7.6 2.6 7.6 5.7s-3.2 5.7-7.6 5.7z" fill="currentColor"/>' +
      '<path d="M3.6 10.4 9.6 8.6M3.6 14 9.6 12.2M3.6 17.6 9.6 15.8"/>',
  ),
  handbrake: T(BRACKETS + `<text x="12" y="15.3" font-size="9.4" ${TT_TEXT}>P</text>`),
  abs: T(BRACKETS + `<text x="12" y="14.2" font-size="5.6" ${TT_TEXT}>ABS</text>`),
  esp: T(ESP_CAR + '<path d="M8.2 21.4c-1.6-1.4 1.6-2.3 0-3.9M15.8 21.4c-1.6-1.4 1.6-2.3 0-3.9"/>'),
  // same car, lifted to make room for "OFF"
  espOff: T(
    `<g transform="translate(0 -2.4)">${ESP_CAR}` +
      '<path d="M8.2 19.4c-1.3-1 1.3-1.7 0-2.9M15.8 19.4c-1.3-1 1.3-1.7 0-2.9" stroke-width="1.5"/></g>' +
      `<text x="12" y="23.4" font-size="5.6" ${TT_TEXT}>OFF</text>`,
  ),
} as const;

/**
 * Stylised arms of Alkmaar: a white (silver) castle with two towers on a red shield.
 * Own simplified drawing, used as the game emblem.
 */
export const EMBLEM = `<svg class="ad-emblem" viewBox="0 0 40 48" aria-hidden="true">
  <defs>
    <linearGradient id="adEmbRed" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#e5323c"/><stop offset="1" stop-color="#a8141e"/>
    </linearGradient>
  </defs>
  <path d="M4 3.5h32v18.5c0 12.8-8.2 19.6-16 23.6C12.2 41.6 4 34.8 4 22z" fill="url(#adEmbRed)"
        stroke="rgba(255,255,255,0.85)" stroke-width="1.6"/>
  <g fill="#f6f4f0">
    <rect x="8.6" y="15" width="6.4" height="21.5"/>
    <rect x="25" y="15" width="6.4" height="21.5"/>
    <rect x="15" y="21" width="10" height="15.5"/>
    <rect x="8.6" y="12.4" width="1.6" height="3"/><rect x="11" y="12.4" width="1.6" height="3"/><rect x="13.4" y="12.4" width="1.6" height="3"/>
    <rect x="25" y="12.4" width="1.6" height="3"/><rect x="27.4" y="12.4" width="1.6" height="3"/><rect x="29.8" y="12.4" width="1.6" height="3"/>
    <rect x="15.7" y="18.8" width="1.5" height="2.6"/><rect x="18.1" y="18.8" width="1.5" height="2.6"/><rect x="20.5" y="18.8" width="1.5" height="2.6"/><rect x="22.9" y="18.8" width="1.5" height="2.6"/>
  </g>
  <g fill="#b3161f">
    <path d="M17.6 36.5v-5.6a2.4 2.4 0 0 1 4.8 0v5.6z"/>
    <rect x="11.2" y="19.5" width="1.2" height="3.2" rx=".6"/><rect x="27.6" y="19.5" width="1.2" height="3.2" rx=".6"/>
  </g>
</svg>`;

/** Generic gamepad face-button glyph (coloured letter in a circle, no trademarks). */
export function padGlyph(btn: 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'LS' | 'RS' | 'View' | 'Menu' | 'D-pad'): string {
  const cls = btn.length === 1 ? `ad-pad ad-pad-${btn.toLowerCase()}` : 'ad-pad ad-pad-wide';
  return `<span class="${cls}">${btn === 'D-pad' ? '✛' : btn}</span>`;
}
