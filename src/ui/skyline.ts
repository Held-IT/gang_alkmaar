// Procedural SVG silhouette of the Alkmaar skyline at dusk, seen across a canal:
// Molen van Piet on its bastion, rows of canal houses (trapgevels, klokgevels, halsgevels,
// tuitgevels, lijstgevels), De Waag with its carillon tower on the open Waagplein, the huge roof
// and slender crossing turret of the Grote Kerk, and the Accijnstoren at the water's edge.
// Lit windows and quay lanterns reflect in the water. Returns two SVG strings: the static scene
// and the (separately animated) windmill sails, so the big static SVG never needs a repaint.

import { rng } from './dom';

const W = 2400;
const H = 640;
/** Quay top / street level in SVG units. */
const G = 430;

type Gable = 'step' | 'bell' | 'neck' | 'spout' | 'cornice' | 'pitched';

interface Pt { x: number; y: number }
const f = (n: number) => Math.round(n * 10) / 10;
const poly = (pts: Pt[]) => `M${pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}Z`;

function housePath(x: number, w: number, e: number, gh: number, g: Gable, chimney: boolean): string {
  const top = G - e;
  const p: Pt[] = [{ x, y: G }, { x, y: top }];
  switch (g) {
    case 'step': {
      const n = w > 70 ? 4 : 3;
      const sh = gh / (n + 0.7);
      const tw = w * 0.2;
      const sw = (w / 2 - tw / 2) / n;
      let cx = x;
      let cy = top;
      for (let i = 0; i < n; i++) {
        cy -= sh;
        p.push({ x: cx, y: cy });
        cx += sw;
        p.push({ x: cx, y: cy });
      }
      p.push({ x: cx, y: cy - sh * 0.7 }, { x: cx + tw, y: cy - sh * 0.7 });
      cx += tw;
      p.push({ x: cx, y: cy });
      for (let i = 0; i < n; i++) {
        cx += sw;
        p.push({ x: cx, y: cy });
        cy += sh;
        p.push({ x: cx, y: cy });
      }
      break;
    }
    case 'spout':
      p.push({ x: x + w * 0.36, y: top - gh * 0.8 }, { x: x + w * 0.36, y: top - gh }, { x: x + w * 0.64, y: top - gh }, { x: x + w * 0.64, y: top - gh * 0.8 });
      break;
    case 'pitched':
      p.push({ x: x + w / 2, y: top - gh * 0.9 });
      break;
    case 'cornice': {
      const c = top - gh * 0.22;
      p.push({ x, y: c + 4 }, { x: x - 3, y: c + 4 }, { x: x - 3, y: c }, { x: x + w * 0.12, y: c }, { x: x + w * 0.3, y: c - gh * 0.42 }, { x: x + w * 0.7, y: c - gh * 0.42 }, { x: x + w * 0.88, y: c }, { x: x + w + 3, y: c }, { x: x + w + 3, y: c + 4 }, { x: x + w, y: c + 4 });
      break;
    }
    default:
      break; // bell & neck are drawn with curves below
  }
  p.push({ x: x + w, y: top }, { x: x + w, y: G });
  let d: string;
  if (g === 'bell') {
    const t = top - gh;
    d =
      `M${f(x)} ${G}L${f(x)} ${f(top)}L${f(x + w * 0.1)} ${f(top)}` +
      `C${f(x + w * 0.1)} ${f(top - gh * 0.45)} ${f(x + w * 0.3)} ${f(top - gh * 0.5)} ${f(x + w * 0.3)} ${f(t + gh * 0.2)}` +
      `Q${f(x + w / 2)} ${f(t - gh * 0.12)} ${f(x + w * 0.7)} ${f(t + gh * 0.2)}` +
      `C${f(x + w * 0.7)} ${f(top - gh * 0.5)} ${f(x + w * 0.9)} ${f(top - gh * 0.45)} ${f(x + w * 0.9)} ${f(top)}` +
      `L${f(x + w)} ${f(top)}L${f(x + w)} ${G}Z`;
  } else if (g === 'neck') {
    const t = top - gh;
    d =
      `M${f(x)} ${G}L${f(x)} ${f(top)}L${f(x + w * 0.06)} ${f(top)}` +
      `Q${f(x + w * 0.27)} ${f(top - 2)} ${f(x + w * 0.27)} ${f(top - gh * 0.42)}` +
      `L${f(x + w * 0.27)} ${f(t + gh * 0.16)}L${f(x + w * 0.22)} ${f(t + gh * 0.16)}L${f(x + w / 2)} ${f(t - gh * 0.06)}` +
      `L${f(x + w * 0.78)} ${f(t + gh * 0.16)}L${f(x + w * 0.73)} ${f(t + gh * 0.16)}L${f(x + w * 0.73)} ${f(top - gh * 0.42)}` +
      `Q${f(x + w * 0.73)} ${f(top - 2)} ${f(x + w * 0.94)} ${f(top)}L${f(x + w)} ${f(top)}L${f(x + w)} ${G}Z`;
  } else {
    d = poly(p);
  }
  if (chimney) {
    const cx = x + w * 0.62;
    d += `M${f(cx)} ${f(top - gh * 0.55)}h7v-${f(gh * 0.55)}h-7z`;
  }
  return d;
}

function treePath(x: number, r: number): string {
  const c = (cx: number, cy: number, rr: number) =>
    `M${f(cx - rr)} ${f(cy)}a${f(rr)} ${f(rr)} 0 1 0 ${f(rr * 2)} 0a${f(rr)} ${f(rr)} 0 1 0 ${f(-rr * 2)} 0z`;
  return (
    c(x, G - r * 1.35, r) +
    c(x - r * 0.62, G - r * 1.0, r * 0.74) +
    c(x + r * 0.6, G - r * 1.05, r * 0.8) +
    c(x - r * 0.28, G - r * 1.95, r * 0.66) +
    c(x + r * 0.34, G - r * 1.85, r * 0.62) +
    `M${f(x - 3)} ${G}h6v-${f(r * 0.8)}h-6z`
  );
}

interface Light { x: number; y: number; w: number; h: number; o: number }

/** Row of canal houses between x0 and x1; returns path data and lit windows. */
function houseRow(rand: () => number, x0: number, x1: number, scale: number, lights: Light[], lit: number): string {
  const gables: Gable[] = ['step', 'step', 'bell', 'neck', 'spout', 'cornice', 'cornice', 'pitched', 'bell', 'step'];
  let d = '';
  let x = x0;
  while (x < x1 - 30) {
    const w = Math.min(x1 - x, (50 + rand() * 38) * scale);
    if (w < 34) break;
    const e = (78 + rand() * 72) * scale;
    const gh = (44 + rand() * 40) * scale;
    const g = gables[Math.floor(rand() * gables.length)];
    d += housePath(x, w, e, gh, g, rand() < 0.3);
    // lit windows: floors of ~31 units, 2-3 columns
    const cols = w > 62 * scale ? 3 : 2;
    const floors = Math.max(2, Math.floor((e - 18) / (31 * scale)));
    for (let fl = 0; fl < floors; fl++) {
      for (let c = 0; c < cols; c++) {
        if (rand() > lit) continue;
        const ww = 8.5 * scale;
        const wh = 15 * scale;
        const wx = x + (w * (c + 0.5)) / cols - ww / 2;
        const wy = G - 14 * scale - (fl + 1) * 31 * scale + 8 * scale;
        lights.push({ x: wx, y: wy, w: ww, h: wh, o: 0.45 + rand() * 0.5 });
      }
    }
    x += w + (rand() < 0.25 ? 2 + rand() * 4 : 0);
  }
  return d;
}

function waagPath(x0: number): { d: string; clock: Pt } {
  const b = 190;
  const wallTop = G - 105;
  let d = `M${x0} ${G}V${wallTop}`;
  // stepped west gable rising to the ridge
  let cx = x0;
  let cy = wallTop;
  for (let i = 0; i < 4; i++) {
    cy -= 23;
    d += `V${cy}`;
    cx += 7.5;
    d += `H${cx}`;
  }
  d += `V${cy - 10}H${cx + 5}V${cy}`; // small finial block
  const ridge = cy;
  const tx = x0 + b - 52; // tower left
  d += `H${tx}`;
  // tower: square clock stage, balustrade, octagonal stage, lantern, bulb, spire
  d += `V${G - 252}H${tx - 5}V${G - 258}H${tx + 8}V${G - 300}`;
  d += `H${tx + 13}V${G - 336}`;
  d += `Q${tx + 13} ${G - 352} ${tx + 22} ${G - 358}L${tx + 24} ${G - 416}L${tx + 28} ${G - 416}L${tx + 30} ${G - 358}Q${tx + 39} ${G - 352} ${tx + 39} ${G - 336}`;
  d += `V${G - 300}H${tx + 44}V${G - 258}H${tx + 57}V${G - 252}H${tx + 52}V${ridge}`;
  // east end of the hall
  d += `H${x0 + b}V${G}Z`;
  // corner pinnacles of the octagonal stage
  d += `M${tx + 6} ${G - 258}l2 -18l2 18zM${tx + 44} ${G - 258}l2 -18l2 18z`;
  // weather vane
  d += `M${tx + 25.2} ${G - 416}h1.6v-12h-1.6z`;
  return { d, clock: { x: tx + 26, y: G - 222 } };
}

function kerkPath(x0: number, x1: number): string {
  const aisle = G - 112;
  let d = `M${x0} ${G}V${aisle}H${x0 + 30}L${x0 + 92} ${G - 292}H${x1 - 92}L${x1 - 26} ${aisle}H${x1}V${G}Z`;
  // buttresses with pinnacles along the aisle
  for (let x = x0 + 14; x < x1 - 14; x += 56) {
    d += `M${x} ${aisle + 2}V${G - 132}l5 -16l5 16V${aisle + 2}z`;
  }
  // transept gable facing the viewer
  const tc = (x0 + x1) / 2 + 10;
  d += `M${tc - 52} ${G}V${G - 205}L${tc} ${G - 326}L${tc + 52} ${G - 205}V${G}Z`;
  d += `M${tc - 56} ${G - 205}l4 -26l4 26zM${tc + 52} ${G - 205}l4 -26l4 26z`;
  // crossing turret (dakruiter) on the ridge
  const rx = tc + 70;
  d += `M${rx - 11} ${G - 290}V${G - 342}H${rx - 9}V${G - 368}L${rx} ${G - 412}L${rx + 9} ${G - 368}V${G - 342}H${rx + 11}V${G - 290}Z`;
  d += `M${rx - 0.8} ${G - 412}h1.6v-10h-1.6z`;
  return d;
}

function churchWindows(x0: number, x1: number): string {
  const tc = (x0 + x1) / 2 + 10;
  let d = '';
  // tall lancet windows in the transept and the aisle
  const lancet = (x: number, top: number, w: number, hgt: number) =>
    `M${x} ${top + hgt}V${top + w * 0.6}Q${x} ${top} ${x + w / 2} ${top - w * 0.2}Q${x + w} ${top} ${x + w} ${top + w * 0.6}V${top + hgt}Z`;
  d += lancet(tc - 14, G - 190, 28, 120);
  for (let x = x0 + 44; x < x1 - 40; x += 56) {
    if (Math.abs(x + 9 - tc) < 70) continue;
    d += lancet(x, G - 96, 16, 62);
  }
  return d;
}

function accijnsPath(x0: number): string {
  const w = 44;
  let d = `M${x0} ${G + 6}V${G - 148}H${x0 - 4}V${G - 156}H${x0 + w + 4}V${G - 148}H${x0 + w}V${G + 6}Z`;
  d += `M${x0 - 2} ${G - 156}L${x0 + w / 2} ${G - 236}L${x0 + w + 2} ${G - 156}Z`;
  d += `M${x0 + w / 2 - 6} ${G - 200}h12v-14l-6 -6l-6 6z`; // small lantern
  d += `M${x0 + w / 2 - 0.8} ${G - 236}h1.6v-10h-1.6z`;
  return d;
}

function millBody(cx: number): { d: string; hub: Pt } {
  // bastion mound
  let d = `M${cx - 210} ${G}Q${cx - 120} ${G - 46} ${cx} ${G - 44}Q${cx + 120} ${G - 46} ${cx + 230} ${G}Z`;
  const base = G - 40;
  // tapered octagonal body
  d += `M${cx - 46} ${base}L${cx - 24} ${G - 236}H${cx + 24}L${cx + 46} ${base}Z`;
  // stage (stelling) with struts
  const sy = G - 112;
  d += `M${cx - 78} ${sy}h156v6h-156z`;
  d += `M${cx - 74} ${sy + 6}L${cx - 40} ${sy + 40}l3 -3L${cx - 68} ${sy + 6}zM${cx + 74} ${sy + 6}L${cx + 40} ${sy + 40}l-3 -3L${cx + 68} ${sy + 6}z`;
  // cap
  d += `M${cx - 30} ${G - 234}Q${cx - 28} ${G - 266} ${cx} ${G - 270}Q${cx + 30} ${G - 266} ${cx + 32} ${G - 234}Z`;
  // door + gallery railing
  return { d, hub: { x: cx - 4, y: G - 250 } };
}

function millSails(hub: Pt, fill: string): string {
  const sail = (angle: number) => {
    let s = `<g transform="rotate(${angle} ${hub.x} ${hub.y})">`;
    // stock (spine)
    s += `<rect x="${hub.x - 2.5}" y="${hub.y - 168}" width="5" height="168" fill="${fill}"/>`;
    // lattice on one side of the stock
    s += `<rect x="${hub.x + 2.5}" y="${hub.y - 166}" width="24" height="132" fill="none" stroke="${fill}" stroke-width="2.4"/>`;
    s += `<path d="M${hub.x + 14.5} ${hub.y - 166}v132" stroke="${fill}" stroke-width="1.2"/>`;
    let bars = '';
    for (let y = hub.y - 160; y < hub.y - 36; y += 11) bars += `M${hub.x + 2.5} ${y}h24`;
    s += `<path d="${bars}" stroke="${fill}" stroke-width="1.2"/>`;
    s += '</g>';
    return s;
  };
  return sail(0) + sail(90) + sail(180) + sail(270) + `<circle cx="${hub.x}" cy="${hub.y}" r="6" fill="${fill}"/>`;
}

function lampPath(x: number): string {
  return `M${x - 1.6} ${G}V${G - 48}h3.2V${G}z` + `M${x - 6} ${G - 48}h12l-2 -14h-8z` + `M${x - 3} ${G - 62}h6l-3 -5z`;
}

export interface SkylineSVG {
  /** Full static scene (sky is CSS; this is silhouettes, lights and water). */
  scene: string;
  /** Windmill sails only, same viewBox; rotate with CSS around `hub`. */
  sails: string;
  hub: Pt;
  viewBox: string;
}

export function buildSkyline(): SkylineSVG {
  const rand = rng(1254); // Alkmaar received city rights in 1254
  const lights: Light[] = [];
  const front = '#04060a';
  const back = '#0e1522';
  const mid = '#080b12';

  // back layer: taller hazy houses + the Grote Kerk
  let backD = houseRow(rand, 1010, 1190, 1.12, [], 0);
  backD += houseRow(rand, 1720, 1900, 1.1, [], 0);
  backD += houseRow(rand, 420, 980, 1.1, [], 0);
  backD += houseRow(rand, 1960, 2400, 1.08, [], 0);
  const kerkX0 = 1190;
  const kerkX1 = 1730;
  const church = '#0b111c';
  const kerk = kerkPath(kerkX0, kerkX1);

  // mid layer: some trees behind the front houses
  let midD = '';
  for (const [x, r] of [[590, 34], [905, 40], [1175, 30], [1760, 36], [2150, 38]] as const) midD += treePath(x, r);

  // front layer
  const mill = millBody(300);
  let frontD = mill.d;
  frontD += treePath(120, 34) + treePath(500, 30);
  frontD += houseRow(rand, 545, 870, 1, lights, 0.2);
  frontD += treePath(880, 26);
  const waag = waagPath(925);
  frontD += waag.d;
  frontD += houseRow(rand, 1160, 1760, 0.96, lights, 0.22);
  frontD += treePath(1785, 30);
  frontD += accijnsPath(1812);
  frontD += houseRow(rand, 1875, 2400, 1, lights, 0.2);
  // quay with railing posts
  frontD += `M0 ${G - 3}H${W}V${G + 7}H0Z`;
  let rail = `M0 ${G - 17}H${W}`;
  for (let x = 12; x < W; x += 30) rail += `M${x} ${G - 17}V${G - 3}`;
  // lanterns along the quay
  const lampXs = [440, 700, 1090, 1400, 1700, 2010, 2290];
  for (const x of lampXs) frontD += lampPath(x);
  // moored boat
  frontD += `M1500 ${G + 14}H1620L1608 ${G + 30}Q1560 ${G + 36} 1514 ${G + 30}ZM1548 ${G + 14}v-12h40v12z`;

  const lightRects = lights
    .map((l) => `<rect x="${f(l.x)}" y="${f(l.y)}" width="${f(l.w)}" height="${f(l.h)}" opacity="${f(l.o)}"/>`)
    .join('');
  // reflections of lit windows: vertical blurred streaks below the quay
  const lightRefl = lights
    .filter((_, i) => i % 2 === 0)
    .map((l) => {
      const ry = 2 * G - l.y - l.h + 14;
      return `<rect x="${f(l.x + 1)}" y="${f(ry)}" width="${f(l.w - 2)}" height="${f(l.h * 2.2)}" opacity="${f(l.o * 0.45)}"/>`;
    })
    .join('');
  const lampGlows = lampXs
    .map((x) => `<circle cx="${x}" cy="${G - 55}" r="16" fill="url(#adSkyGlow)"/><rect x="${x - 3.5}" y="${G - 60}" width="7" height="10" fill="#ffd48a"/>`)
    .join('');
  const lampRefl = lampXs
    .map((x) => `<rect x="${x - 3}" y="${G + 26}" width="6" height="${70 + (x % 40)}" fill="url(#adSkyStreak)" opacity="0.8"/>`)
    .join('');
  let ripples = '';
  const rr = rng(8);
  for (let i = 0; i < 70; i++) {
    const y = G + 16 + Math.pow(rr(), 1.4) * (H - G - 20);
    const x = rr() * W;
    const w = 30 + rr() * 160;
    ripples += `M${f(x)} ${f(y)}h${f(w)}`;
  }

  const scene = `<svg class="ad-sky-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs>
    <linearGradient id="adSkyWater" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b1220"/><stop offset="0.35" stop-color="#070b14"/><stop offset="1" stop-color="#030508"/>
    </linearGradient>
    <linearGradient id="adSkyReflFade" x1="0" y1="${G}" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.7" stop-color="#fff" stop-opacity="0.08"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="adSkyReflMask"><rect x="0" y="${G}" width="${W}" height="${H - G}" fill="url(#adSkyReflFade)"/></mask>
    <radialGradient id="adSkyGlow"><stop offset="0" stop-color="#ffcf80" stop-opacity="0.75"/><stop offset="0.35" stop-color="#ffb35c" stop-opacity="0.25"/><stop offset="1" stop-color="#ff9a40" stop-opacity="0"/></radialGradient>
    <linearGradient id="adSkyStreak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc878" stop-opacity="0.65"/><stop offset="1" stop-color="#ffc878" stop-opacity="0"/></linearGradient>
    <filter id="adSkyBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
    <filter id="adSkySoft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5"/></filter>
  </defs>
  <path d="${backD}" fill="${back}"/>
  <path d="${kerk}" fill="${church}"/>
  <path d="${churchWindows(kerkX0, kerkX1)}" fill="#c98a4a" opacity="0.32"/>
  <path d="${midD}" fill="${mid}"/>
  <g id="adSkyFront">
    <path d="${frontD}" fill="${front}"/>
    <path d="${rail}" stroke="${front}" stroke-width="2.2" fill="none"/>
  </g>
  <circle cx="${waag.clock.x}" cy="${waag.clock.y}" r="10" fill="#f3d9a4" opacity="0.5"/>
  <circle cx="${waag.clock.x}" cy="${waag.clock.y}" r="22" fill="url(#adSkyGlow)" opacity="0.6"/>
  <g fill="#ffc46e">${lightRects}</g>
  <g fill="#ffc46e" filter="url(#adSkySoft)" opacity="0.7">${lightRects}</g>
  ${lampGlows}
  <rect x="0" y="${G + 7}" width="${W}" height="${H - G - 7}" fill="url(#adSkyWater)"/>
  <g mask="url(#adSkyReflMask)" opacity="0.5">
    <g transform="translate(0 ${2 * G + 10}) scale(1 -1)"><path d="${backD}${kerk}" fill="#1a2436"/><path d="${frontD}" fill="#0b111c"/></g>
  </g>
  <g fill="#ffbe6a" filter="url(#adSkyBlur)">${lightRefl}</g>
  ${lampRefl}
  <path d="${ripples}" stroke="#8fa9c8" stroke-opacity="0.07" stroke-width="1.4"/>
</svg>`;

  const sails = `<svg class="ad-sky-sails" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <g class="ad-sky-rotor" style="transform-origin:${mill.hub.x}px ${mill.hub.y}px">${millSails(mill.hub, front)}</g>
</svg>`;

  return { scene, sails, hub: mill.hub, viewBox: `0 0 ${W} ${H}` };
}
