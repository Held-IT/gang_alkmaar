// Player colours for the jelly beasts (sRGB hex). Bright and clearly distinct from each other, but
// with albedos that still sit well in the photoreal (PBR, tone mapped) city.
export interface BeastColour {
  id: string;
  /** Dutch display name */
  name: string;
  hex: string;
}

export const BEAST_COLOURS: readonly BeastColour[] = [
  { id: 'rood', name: 'Rood', hex: '#e0443b' },
  { id: 'oranje', name: 'Oranje', hex: '#f5871f' },
  { id: 'geel', name: 'Geel', hex: '#f3c62a' },
  { id: 'limoen', name: 'Limoen', hex: '#9bcb3b' },
  { id: 'groen', name: 'Groen', hex: '#2fa65a' },
  { id: 'turkoois', name: 'Turkoois', hex: '#22b1a5' },
  { id: 'hemelsblauw', name: 'Hemelsblauw', hex: '#4ba7ea' },
  { id: 'blauw', name: 'Blauw', hex: '#3c5bd8' },
  { id: 'paars', name: 'Paars', hex: '#8d56d6' },
  { id: 'roze', name: 'Roze', hex: '#f27bb0' },
  { id: 'wit', name: 'Wit', hex: '#ede7dd' },
  { id: 'antraciet', name: 'Antraciet', hex: '#4c515b' },
];

/** Just the hex strings, in the same order as BEAST_COLOURS. */
export const BEAST_COLOUR_HEX: readonly string[] = BEAST_COLOURS.map((c) => c.hex);

/** Kaasdragers' guild colours (veem colours) for the hat ribbon and harness. */
export const GUILD_COLOURS = {
  rood: '#c62a2f',
  groen: '#2d8a3e',
  blauw: '#2c5cb3',
  geel: '#efbd1d',
} as const;
export type Guild = keyof typeof GUILD_COLOURS;

/** Guild whose colour is closest in hue to `hex` (greys/whites fall back to 'rood'). */
export function guildForColour(hex: string): Guild {
  const c = hexToRgb(hex);
  const max = Math.max(c[0], c[1], c[2]);
  const min = Math.min(c[0], c[1], c[2]);
  if (max - min < 0.18) return 'rood';
  const h = hue(c);
  const guilds: [Guild, number][] = [['rood', 0], ['geel', 48], ['groen', 130], ['blauw', 220]];
  let best: Guild = 'rood';
  let bestD = 1e9;
  for (const [g, gh] of guilds) {
    let d = Math.abs(h - gh);
    d = Math.min(d, 360 - d);
    if (d < bestD) { bestD = d; best = g; }
  }
  // magenta/pink/purple read better with red ribbons, orange with yellow
  if (h > 265 && h < 345) return 'rood';
  return best;
}

export function hexToRgb(hex: string): [number, number, number] {
  let s = hex.trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function hue([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-6) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
