// Display helpers for CarSpec: Dutch labels, estimated 0-100 km/h, paint names, silhouettes.
import type { CarCategory, CarSpec } from '../contracts';

export const CATEGORY_LABEL: Record<CarCategory, string> = {
  hatchback: 'Hatchback',
  stationwagen: 'Stationwagen',
  stadsauto: 'Stadsauto',
  bestelbus: 'Bestelbus',
  sedan: 'Sedan',
  taxi: 'Taxi',
  crossover: 'Crossover',
};

export function categoryLabel(c: string): string {
  return (CATEGORY_LABEL as Record<string, string>)[c] ?? c.charAt(0).toUpperCase() + c.slice(1);
}

export function drivetrainLabel(d: CarSpec['drivetrain']): string {
  return d === 'fwd' ? 'Voorwielaandrijving' : d === 'rwd' ? 'Achterwielaandrijving' : 'Vierwielaandrijving';
}

export function kwToPk(kw: number): number {
  return Math.round(kw * 1.35962);
}

/**
 * Rough 0-100 km/h estimate from the power-to-weight ratio, fitted to typical European cars
 * (e.g. 11.8 kg/kW ≈ 8.7 s, 19.8 kg/kW ≈ 13.9 s). Electric cars get their full torque at once.
 */
export function estimate0to100(spec: CarSpec): number {
  const kgPerKw = spec.massKg / Math.max(1, spec.powerKw);
  let t = 0.65 * kgPerKw + 1.0;
  if (spec.electric) t *= 0.84;
  if (spec.drivetrain === 'awd') t *= 0.92;
  return Math.min(25, Math.max(3, t));
}

export function gearboxLabel(spec: CarSpec): string {
  if (spec.electric) return 'Elektrisch, 1 versnelling';
  return `${spec.gearRatios.length} versnellingen`;
}

// Named Dutch paint colours; the nearest one names a CarSpec paint hex.
const PAINT_NAMES: [string, string][] = [
  ['#f4f4f1', 'Gletsjerwit'],
  ['#e9e6dc', 'Crèmewit'],
  ['#c9ccd0', 'Lichtgrijs metallic'],
  ['#9aa0a7', 'Zilver metallic'],
  ['#6b7178', 'Grafietgrijs'],
  ['#3d4247', 'Antraciet metallic'],
  ['#1c1e21', 'Nachtzwart'],
  ['#0b0c0d', 'Diepzwart'],
  ['#b8141c', 'Signaalrood'],
  ['#d4202c', 'Alkmaars rood'],
  ['#7a1a22', 'Bordeauxrood'],
  ['#e0601e', 'Oranje'],
  ['#e3b52f', 'Zonnegeel'],
  ['#f0d24a', 'Citroengeel'],
  ['#1f3a73', 'Donkerblauw'],
  ['#2c62b0', 'Koningsblauw'],
  ['#5c8fc4', 'Hemelsblauw'],
  ['#a8c0d0', 'IJsblauw'],
  ['#23493a', 'Donkergroen'],
  ['#4f7a52', 'Bosgroen'],
  ['#7d8c5a', 'Olijfgroen'],
  ['#8fb8a8', 'Mintgroen'],
  ['#d9c9a5', 'Zandbeige'],
  ['#8a6a4a', 'Hazelnootbruin'],
  ['#4a3426', 'Chocoladebruin'],
  ['#5a3a6e', 'Paars metallic'],
];

function hexRgb(hex: string): [number, number, number] {
  let s = hex.replace('#', '').trim();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function paintName(hex: string): string {
  const [r, g, b] = hexRgb(hex);
  let best = PAINT_NAMES[0][1];
  let bestD = Infinity;
  for (const [h2, name] of PAINT_NAMES) {
    const [r2, g2, b2] = hexRgb(h2);
    // "redmean" weighted distance: cheap and perceptually reasonable
    const rm = (r + r2) / 2;
    const d = (2 + rm / 256) * (r - r2) ** 2 + 4 * (g - g2) ** 2 + (2 + (255 - rm) / 256) * (b - b2) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Relative luminance 0..1 (for choosing a swatch ring colour). */
export function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Side-view silhouettes per category (viewBox 0 0 120 40, facing right).
const SIL: Record<string, string> = {
  hatchback:
    'M6 30c0-4 1-7 3-8l12-3 14-9c3-2 6-3 10-3h26c4 0 7 1 9 4l7 9 14 2c4 1 6 3 6 6v2H6z',
  stationwagen:
    'M4 30c0-4 1-7 3-8l2-11c0-2 2-4 5-4h46c4 0 7 1 10 4l9 8 15 3c4 1 6 3 6 6v2H4z',
  stadsauto:
    'M14 30c0-5 1-8 3-9l6-11c2-3 5-4 8-4h30c4 0 6 1 8 4l8 10 11 2c4 1 5 3 5 6v2H14z',
  bestelbus:
    'M3 30V8c0-2 2-4 4-4h70c3 0 5 1 7 4l10 12 15 3c4 1 6 3 6 6v1H3z',
  sedan:
    'M3 30c0-4 2-6 4-7l18-3 14-9c3-2 6-3 10-3h20c4 0 7 1 10 4l8 8 21 2c4 1 6 3 6 6v2H3z',
  taxi:
    'M3 30c0-4 2-6 4-7l18-3 14-9c3-2 6-3 10-3h20c4 0 7 1 10 4l8 8 21 2c4 1 6 3 6 6v2H3zM50 6V2h14v4z',
};
const WHEELS: Record<string, [number, number]> = {
  hatchback: [26, 94],
  stationwagen: [24, 94],
  stadsauto: [30, 92],
  bestelbus: [24, 98],
  sedan: [24, 96],
  taxi: [24, 96],
};

export function silhouetteSVG(category: string): string {
  const path = SIL[category] ?? SIL.hatchback;
  const [a, b] = WHEELS[category] ?? WHEELS.hatchback;
  return (
    `<svg class="ad-sil" viewBox="0 0 120 40" aria-hidden="true"><path d="${path}" fill="currentColor"/>` +
    `<circle cx="${a}" cy="31" r="6.5" fill="#0b0e13" stroke="currentColor" stroke-width="2"/>` +
    `<circle cx="${b}" cy="31" r="6.5" fill="#0b0e13" stroke="currentColor" stroke-width="2"/></svg>`
  );
}
