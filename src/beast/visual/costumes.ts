// Alkmaar / Dutch themed costumes (all original designs). Each costume is ONE skinned geometry
// (all items merged, vertex colours + per-vertex surface params) -> one draw call.
//
// Attachment: torso garments use the smooth torso weights of the body bean ('torso' skin) so they
// bend exactly like the jelly underneath; sleeves / trouser legs are rigid per limb part with ball
// ends on the joints (like the body); hats are rigid to the head; shoes to the lower legs;
// accessories (camera, backpack, radio) to the chest.
import * as THREE from 'three';
import type { CostumeInfo } from '../../brawl/contracts';
import { GUILD_COLOURS, type Guild } from './palette';
import { PATTERN } from './materials';
import { deform, ellipsoid, torsoBand, torsoJig, type Skin, type Style } from './geometry';
import {
  CostumeKit,
  cylinderAB,
  framePoint,
  frontW,
  hatFrame,
  orient,
  roundBox,
  stud,
  tubeAlong,
  wrapPi,
  type Frame,
  type SkirtOpts,
} from './costumeKit';
import { getTorsoShape, smooth } from './shape';

export const COSTUMES: CostumeInfo[] = [
  { id: 'geen', name: 'Geen', description: 'Gewoon een kale, glimmende drilpudding.' },
  { id: 'kaasdrager', name: 'Kaasdrager', description: 'Wit pak en een strohoed met een lint in de kleur van het gilde. Sjouwt 160 kilo kaas zonder te klagen.' },
  { id: 'boer', name: 'Boer', description: 'Tuinbroek, boerenzakdoek, pet en klompen. Ruikt een beetje naar de wei.' },
  { id: 'klederdracht', name: 'Klederdracht', description: 'Kanten kap, bloemetjeslijfje, bloedkoralen ketting en een wijde rok met schort.' },
  { id: 'toerist', name: 'Toerist', description: 'Vissershoedje, bloemetjeshemd, camera, rugzak en sokken in sandalen. Licht verbrand.' },
  { id: 'visser', name: 'Visser', description: 'Gele zuidwester, regenjas en groene laarzen. Kan wel tegen een buitje.' },
  { id: 'stadswacht', name: 'Stadswacht', description: 'Pet en fluorescerend hesje. Houdt de Kaasmarkt nauwlettend in de gaten.' },
  { id: 'wielrenner', name: 'Wielrenner', description: 'Helm, bolletjestrui en wielerbroek. Altijd in de aanval, ook bergaf.' },
  { id: 'kok', name: 'Kok', description: 'Koksmuts, wit jasje en geblokte broek. De kaasfondue staat al klaar.' },
  { id: 'koning', name: 'Koningsdag', description: 'Oranje kroon, verenboa en een rood-wit-blauwe sjerp. Elke dag is Koningsdag.' },
  { id: 'schaatser', name: 'Schaatser', description: 'Wollen muts met pompon, lange sjaal en een warme trui. Klaar voor de Elfstedentocht.' },
];

export interface CostumeTraits {
  /** extra cheek blush (sunburn) */
  blush: number;
  /** uses the guild colour of the body colour (rebuild on colour change) */
  guild: boolean;
}

export function costumeTraits(id: string): CostumeTraits {
  if (id === 'toerist') return { blush: 0.55, guild: false };
  if (id === 'kaasdrager') return { blush: 0, guild: true };
  if (id === 'schaatser') return { blush: 0.25, guild: false };
  return { blush: 0, guild: false };
}

// ---------------------------------------------------------------------------------------------
// styles & shared garment helpers
// ---------------------------------------------------------------------------------------------

const st = (color: THREE.ColorRepresentation, o: Partial<Style> = {}): Style => ({
  color,
  rough: 0.85,
  sheen: 0.5,
  metal: 0,
  pattern: PATTERN.none,
  ...o,
});
const metal = (color: THREE.ColorRepresentation, rough = 0.32): Style => st(color, { metal: 1, rough, sheen: 0 });
const plastic = (color: THREE.ColorRepresentation, rough = 0.38): Style => st(color, { rough, sheen: 0 });

const TAU = Math.PI * 2;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function headSkin(k: CostumeKit, f: Frame): Skin {
  return { bone: 'head', jig: torsoJig(k.shape, f.o.y) };
}

/** Closed tube along the torso edge y = yf(theta). */
function ring(k: CostumeKit, yf: (th: number) => number, off: number, rOut: number, s: Style, rSide = rOut, n = 44): void {
  const { pts, outs } = k.edgePath(yf, off + rOut * 0.6, 0, TAU, n);
  pts.pop();
  outs.pop();
  k.add(tubeAlong(pts, { rOut, rSide, closed: true, outs, seg: 6 }), s, 'torso');
}

/** Open tube along the torso edge y = yf(theta), theta in [th0, th1]. */
function edge(k: CostumeKit, yf: (th: number) => number, off: number, th0: number, th1: number, r: number, s: Style): void {
  const n = Math.max(6, Math.round(Math.abs(th1 - th0) * 12));
  const { pts, outs } = k.edgePath(yf, off + r * 0.6, th0, th1, n);
  k.add(tubeAlong(pts, { rOut: r, closed: false, outs, seg: 6 }), s, 'torso');
}

/** Flat strap / cord along the torso surface: [theta, y, off] control points. */
function strap(k: CostumeKit, ctrl: [number, number, number][], s: Style, width: number, thick = 0.0035, n = 28): void {
  const { pts, outs } = k.surfacePath(ctrl, n);
  k.add(tubeAlong(pts, { rOut: thick, rSide: width, outs, seg: 8 }), s, 'torso');
}

interface ShirtOpts {
  yLo: number;
  yHi?: number;
  off: number;
  vDepth?: number;
  vWidth?: number;
  flare?: number;
  hem?: number;
  collar?: number;
  collarStyle?: Style;
}

function yNeck(o: ShirtOpts): (th: number) => number {
  const yTop = o.yHi ?? 1.112;
  const vD = o.vDepth ?? 0;
  const vW = o.vWidth ?? 0.35;
  return (th) => yTop - vD * frontW(th, vW);
}

function shirt(k: CostumeKit, s: Style, o: ShirtOpts): void {
  const yHi = yNeck(o);
  const fl = o.flare ?? 0;
  const off = (_th: number, y: number) => o.off + fl * smooth(o.yLo + 0.12, o.yLo, y);
  k.add(k.torsoPanel({ yLo: o.yLo, yHi, off, nu: 40 }), s, 'torso');
  const hem = o.hem ?? 0.008;
  if (hem > 0) ring(k, () => o.yLo, o.off + fl, hem, s, hem * 1.25);
  const col = o.collar ?? 0.009;
  if (col > 0) ring(k, yHi, o.off, col, o.collarStyle ?? s, col, 48);
}

function sleeves(k: CostumeKit, s: Style, o: { to: number; off: number; cuff?: number; cuffStyle?: Style; bulge?: (f: number) => number; shoulder?: boolean }): void {
  for (const side of [1, -1] as const) {
    const limb = side > 0 ? k.d.armL : k.d.armR;
    const up = side > 0 ? 'upperArmL' : 'upperArmR';
    const lo = side > 0 ? 'lowerArmL' : 'lowerArmR';
    if (o.shoulder !== false) {
      const sb = k.shoulderBlob(side, o.off);
      k.add(sb.geo, s, sb.skin);
    }
    if (o.to <= 1) {
      k.add(k.limbTube(limb, 'upper', { to: o.to, off: o.off, bulge: o.bulge }), s, { bone: up });
      if (o.cuff) k.add(k.limbRing(limb, 'upper', o.to, o.off + (o.bulge ? o.bulge(o.to) : 0), o.cuff), o.cuffStyle ?? s, { bone: up });
    } else {
      k.add(k.limbTube(limb, 'upper', { off: o.off, bulge: o.bulge }), s, { bone: up });
      k.add(k.limbTube(limb, 'lower', { to: o.to - 1, off: o.off }), s, { bone: lo });
      if (o.cuff) k.add(k.limbRing(limb, 'lower', o.to - 1, o.off, o.cuff), o.cuffStyle ?? s, { bone: lo });
    }
  }
}

function trousers(k: CostumeKit, s: Style, o: { top: number; off: number; to: number; hem?: number; hemStyle?: Style; bulge?: number; waist?: number; waistStyle?: Style }): void {
  k.add(torsoBand(k.shape, k.d.yB, o.top, o.off, { rings: 12, radial: 36 }), s, 'torso');
  const bulge = o.bulge ? (f: number) => o.bulge! * clamp01(f) : undefined;
  for (const side of [1, -1] as const) {
    const limb = side > 0 ? k.d.legL : k.d.legR;
    const up = side > 0 ? 'upperLegL' : 'upperLegR';
    const lo = side > 0 ? 'lowerLegL' : 'lowerLegR';
    if (o.to <= 1) {
      k.add(k.limbTube(limb, 'upper', { to: o.to, off: o.off, bulge }), s, { bone: up, jig: 0 });
      if (o.hem) k.add(k.limbRing(limb, 'upper', o.to, o.off + (bulge ? bulge(o.to) : 0), o.hem), o.hemStyle ?? s, { bone: up, jig: 0 });
    } else {
      k.add(k.limbTube(limb, 'upper', { off: o.off }), s, { bone: up, jig: 0 });
      k.add(k.limbTube(limb, 'lower', { to: o.to - 1, off: o.off }), s, { bone: lo, jig: 0 });
      if (o.hem) k.add(k.limbRing(limb, 'lower', o.to - 1, o.off, o.hem), o.hemStyle ?? s, { bone: lo, jig: 0 });
    }
  }
  if (o.waist) ring(k, () => o.top, o.off, o.waist, o.waistStyle ?? s, o.waist * 1.6);
}

/** Lower-leg tube (sock, boot shaft) from fraction `from` down to the ankle ball. */
function shaft(k: CostumeKit, s: Style, from: number, off: number, rim = 0, rimStyle?: Style, bulgeTop = 0): void {
  for (const side of [1, -1] as const) {
    const limb = side > 0 ? k.d.legL : k.d.legR;
    const lo = side > 0 ? 'lowerLegL' : 'lowerLegR';
    const bulge = bulgeTop ? (f: number) => bulgeTop * clamp01((1 - f) / Math.max(1e-3, 1 - from)) : undefined;
    k.add(k.limbTube(limb, 'lower', { from, off, bulge }), s, { bone: lo, jig: 0 });
    if (rim) k.add(k.limbRing(limb, 'lower', from, off + bulgeTop, rim), rimStyle ?? s, { bone: lo, jig: 0 });
  }
}

function klompen(k: CostumeKit, s: Style, paint?: Style): void {
  for (const side of [1, -1] as const) {
    const c = k.footCentre(side);
    c.z += 0.024;
    const soleRel = k.d.soleY - 0.004 - c.y;
    const g = ellipsoid(V(0, 0, 0), 1, 1, 1, 18, 10);
    deform(g, (v) => {
      const fz = v.z;
      let x = v.x * 0.1, y = v.y * 0.074;
      const z = v.z * 0.168;
      if (fz > 0) {
        x *= 1 - 0.38 * fz * fz;
        y *= 1 - 0.3 * fz * fz;
        y += 0.034 * fz * fz * fz; // upturned tip
      } else {
        y += 0.014 * -fz * Math.max(0, v.y); // higher heel cap
      }
      y = Math.max(y, soleRel);
      v.set(c.x + x, c.y + y, c.z + z);
    });
    const bone = side > 0 ? 'lowerLegL' : 'lowerLegR';
    k.add(g, s, { bone, jig: 0 });
    if (paint) {
      // painted band over the instep
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const a = -0.15 + (i / 12) * (Math.PI + 0.3);
        pts.push(V(c.x + Math.cos(a) * 0.083, c.y + 0.004 + Math.sin(a) * 0.062, c.z + 0.075));
      }
      k.add(tubeAlong(pts, { rOut: 0.0045, rSide: 0.009, seg: 6 }), paint, { bone, jig: 0 });
    }
  }
}

/** Elliptical rings over the feet (sandal straps); zOff relative to the foot centre. */
function footStraps(k: CostumeKit, s: Style, zOffs: number[], inf = 0.008): void {
  for (const side of [1, -1] as const) {
    const c = k.footCentre(side);
    const bone = side > 0 ? 'lowerLegL' : 'lowerLegR';
    for (const zo of zOffs) {
      const f = Math.sqrt(Math.max(0.05, 1 - (zo / 0.122) ** 2));
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 14; i++) {
        const a = -0.35 + (i / 14) * (Math.PI + 0.7);
        const y = Math.max(k.d.soleY + 0.006, c.y + Math.sin(a) * (0.058 * f + inf));
        pts.push(V(c.x + Math.cos(a) * (0.086 * f * (1 + 0.1 * zo / 0.122) + inf), y, c.z + zo));
      }
      k.add(tubeAlong(pts, { rOut: 0.004, rSide: 0.011, seg: 6 }), s, { bone, jig: 0 });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// hats
// ---------------------------------------------------------------------------------------------

/** Polar description (radius, height in the frame) of a hat rim, interpolated by phi. */
function rimPolar(f: Frame, rim: THREE.Vector3[]): (phi: number) => { r: number; h: number } {
  const arr = rim
    .map((p) => {
      const q = p.clone().sub(f.o);
      const h = q.dot(f.up);
      q.addScaledVector(f.up, -h);
      return { a: Math.atan2(q.dot(f.left), q.dot(f.fwd)), r: q.length(), h };
    })
    .sort((x, y) => x.a - y.a);
  const n = arr.length;
  return (phi) => {
    let a = wrapPi(phi);
    if (a < arr[0].a) a += TAU;
    for (let i = 0; i < n; i++) {
      const p = arr[i];
      const q = arr[(i + 1) % n];
      const qa = i + 1 < n ? q.a : q.a + TAU;
      if (a >= p.a && a <= qa) {
        const t = (a - p.a) / Math.max(1e-6, qa - p.a);
        return { r: p.r + (q.r - p.r) * t, h: p.h + (q.h - p.h) * t };
      }
    }
    return { r: arr[0].r, h: arr[0].h };
  };
}

/**
 * Brim / visor: a thin rounded sheet going outwards from the rim (polar) by width(phi), sloping
 * down by slope(phi) radians (negative = upturned), optional outer lift (curl).
 */
function brim(k: CostumeKit, f: Frame, polar: (phi: number) => { r: number; h: number }, o: {
  width: (phi: number) => number;
  slope: (phi: number) => number;
  thick: number;
  inset?: number;
  lift?: (phi: number) => number;
  th0?: number;
  th1?: number;
  radial?: number;
}): THREE.BufferGeometry {
  const t = o.thick / 2;
  const inset = o.inset ?? 0.006;
  return k.revolve(f, o.radial ?? 56, 7, (phi, idx) => {
    const p = polar(phi);
    const w = o.width(phi);
    const a = o.slope(phi);
    const dr = Math.cos(a), dh = -Math.sin(a); // outward along the brim
    const nr = Math.sin(a), nh = Math.cos(a); // brim normal (up side)
    const lift = o.lift ? o.lift(phi) : 0;
    const r0 = p.r - inset, h0 = p.h;
    const at = (s: number, n: number, l: number): [number, number] => [r0 + dr * s + nr * n, h0 + dh * s + nh * n + l];
    switch (idx) {
      case 0: return at(0, t, 0);
      case 1: return at(w * 0.55, t, lift * 0.25);
      case 2: return at(w, t * 0.75, lift);
      case 3: return at(w + t * 0.7, 0, lift);
      case 4: return at(w, -t * 0.75, lift);
      case 5: return at(w * 0.55, -t, lift * 0.25);
      default: return at(0, -t, 0);
    }
  }, { th0: o.th0, th1: o.th1 });
}

/** D-shaped visor width profile (0 at +-span). */
const visorW = (wMax: number, span: number) => (phi: number) => wMax * Math.sqrt(Math.max(0, Math.cos(clamp01(Math.abs(wrapPi(phi)) / span) * Math.PI / 2)));

/** Ellipsoid blob at p: local z along dir, y towards upHint. */
function blob(p: THREE.Vector3, dir: THREE.Vector3, upHint: THREE.Vector3, sx: number, sy: number, sz: number, w = 8, h = 6): THREE.BufferGeometry {
  const g = ellipsoid(V(0, 0, 0), 1, 1, 1, w, h);
  g.applyMatrix4(orient(p, dir, upHint, V(sx, sy, sz)));
  return g;
}

function boater(k: CostumeKit, straw: Style, ribbon: Style): void {
  const f = hatFrame(1.43, 0.2, 0.06);
  const { R, H } = k.fitHead(f);
  const rc = R + 0.014;
  const hc = Math.max(H + 0.02, 0.075);
  const skin = headSkin(k, f);
  k.add(k.revolveProf(f, [[rc - 0.008, -0.014], [rc, -0.004], [rc + 0.002, hc * 0.5], [rc, hc - 0.008], [rc - 0.01, hc], [rc * 0.55, hc + 0.003], [0, hc + 0.004]], 44, { inside: framePoint(f, 0, 0, hc * 0.5) }), straw, skin);
  k.add(brim(k, f, () => ({ r: rc, h: 0 }), { width: () => 0.074, slope: () => -0.03, thick: 0.009, radial: 56 }), straw, skin);
  k.add(k.revolveProf(f, [[rc - 0.002, 0.004], [rc + 0.0045, 0.005], [rc + 0.005, 0.02], [rc + 0.0045, 0.036], [rc - 0.002, 0.037]], 44), ribbon, skin);
  // bow on the left side
  const phi = Math.PI / 2 + 0.35;
  const bp = framePoint(f, rc + 0.008, phi, 0.02);
  const out = framePoint(f, 1, phi, 0).sub(f.o).normalize();
  const tan = framePoint(f, 1, phi + Math.PI / 2, 0).sub(f.o).normalize();
  k.add(blob(bp, out, f.up, 0.011, 0.013, 0.008), ribbon, skin);
  for (const s of [1, -1]) {
    k.add(blob(bp.clone().addScaledVector(tan, s * 0.021), out, f.up.clone().addScaledVector(tan, s * 0.4), 0.02, 0.012, 0.005), ribbon, skin);
    k.add(blob(bp.clone().addScaledVector(tan, s * 0.009).addScaledVector(f.up, -0.026), out, f.up.clone().addScaledVector(tan, s * 0.25), 0.0075, 0.024, 0.004), ribbon, skin);
  }
}

function flatCap(k: CostumeKit, cloth: Style, band: Style): void {
  const f = hatFrame(1.402, 0.3);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, {
    off: (v) => 0.014 + 0.03 * v,
    fn: (p, v, th) => {
      const h = p.clone().sub(f.o).dot(f.up);
      if (h > 0) p.addScaledVector(f.up, -h * 0.22 * smooth(0.3, 1, v));
      p.addScaledVector(f.fwd, 0.042 * smooth(0.25, 0.85, v) * (0.4 + 0.6 * Math.max(0, Math.cos(th))));
    },
  });
  k.add(cap.geo, cloth, skin);
  const polar = rimPolar(f, cap.rim);
  k.add(brim(k, f, polar, { th0: -1.15, th1: 1.15, width: visorW(0.078, 1.15), slope: () => 0.3, thick: 0.012, radial: 22 }), cloth, skin);
  k.add(tubeAlong(cap.rim, { rOut: 0.006, rSide: 0.008, closed: true, outs: cap.rimN, seg: 6 }), band, skin);
  k.add(stud(cap.top, f.up, 0.016, 0.008), cloth, skin);
}

function peakedCap(k: CostumeKit, cloth: Style, band: Style, visor: Style, badge: Style): void {
  const f = hatFrame(1.44, 0.2);
  const { R, H } = k.fitHead(f);
  const rb = R + 0.013;
  const top = Math.max(H + 0.03, 0.088);
  const rt = rb + 0.05;
  const skin = headSkin(k, f);
  // crown: straight band, flaring into a wide top that is tilted up at the front
  const tilt = (r: number, phi: number) => 0.016 * (r / rt) * Math.cos(phi);
  k.add(k.revolve(f, 40, 8, (phi, i) => {
    switch (i) {
      case 0: return [rb - 0.006, -0.012];
      case 1: return [rb, -0.004];
      case 2: return [rb + 0.002, 0.042];
      case 3: return [rb + 0.03, top * 0.84 + tilt(rb + 0.03, phi) * 0.8];
      case 4: return [rt, top - 0.007 + tilt(rt, phi)];
      case 5: return [rt - 0.004, top + tilt(rt, phi)];
      case 6: return [rt * 0.55, top + 0.003 + tilt(rt * 0.55, phi)];
      default: return [0, top + 0.004];
    }
  }, { inside: framePoint(f, 0, 0, top * 0.5) }), cloth, skin);
  k.add(k.revolveProf(f, [[rb - 0.001, 0.0], [rb + 0.005, 0.002], [rb + 0.006, 0.038], [rb - 0.001, 0.041]], 40), band, skin);
  k.add(brim(k, f, () => ({ r: rb + 0.004, h: 0.002 }), { th0: -1.25, th1: 1.25, width: visorW(0.078, 1.25), slope: () => 0.42, thick: 0.01, radial: 24 }), visor, skin);
  k.add(stud(framePoint(f, rb + 0.007, 0, 0.02), f.fwd, 0.012, 0.005), badge, skin);
}

function bucketHat(k: CostumeKit, cloth: Style, band: Style): void {
  const f = hatFrame(1.418, 0.28);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, {
    off: (v) => 0.016 + 0.014 * v,
    fn: (p, v) => {
      const h = p.clone().sub(f.o).dot(f.up);
      if (h > 0) p.addScaledVector(f.up, -h * 0.12 * smooth(0.5, 1, v));
    },
  });
  k.add(cap.geo, cloth, skin);
  const polar = rimPolar(f, cap.rim);
  const back = (phi: number) => (1 - Math.cos(phi)) / 2;
  k.add(brim(k, f, polar, { width: (p) => 0.05 + 0.022 * back(p), slope: (p) => 0.45 + 0.4 * back(p), thick: 0.008, radial: 48 }), cloth, skin);
  const bandPts = cap.rim.map((p) => p.clone().addScaledVector(f.up, 0.011));
  k.add(tubeAlong(bandPts, { rOut: 0.004, rSide: 0.011, closed: true, outs: cap.rimN, seg: 6 }), band, skin);
}

function souwester(k: CostumeKit, oil: Style): void {
  const f = hatFrame(1.43, 0.15);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, { off: (v) => 0.018 + 0.008 * v });
  k.add(cap.geo, oil, skin);
  const polar = rimPolar(f, cap.rim);
  const back = (phi: number) => Math.pow((1 - Math.cos(phi)) / 2, 1.3);
  k.add(brim(k, f, polar, { width: (p) => 0.036 + 0.085 * back(p), slope: (p) => -0.18 + 0.95 * back(p), thick: 0.009, radial: 48 }), oil, skin);
  k.add(tubeAlong(cap.rim, { rOut: 0.005, closed: true, outs: cap.rimN, seg: 6 }), oil, skin);
  k.add(stud(cap.top, f.up, 0.012, 0.006), oil, skin);
}

function helmet(k: CostumeKit, shell: Style, trim: Style): void {
  const f = hatFrame(1.405, 0.22);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, {
    off: (v) => 0.034 + 0.006 * Math.sin(v * Math.PI),
    radial: 40,
    rings: 14,
    fn: (p, v, th) => {
      const back = Math.max(0, -Math.cos(th));
      p.addScaledVector(f.fwd, -0.055 * back * back * (1 - v) * (0.35 + 0.65 * smooth(0, 0.4, v)));
      p.addScaledVector(f.up, -0.012 * back * (1 - v));
    },
  });
  k.add(cap.geo, shell, skin);
  k.add(tubeAlong(cap.rim, { rOut: 0.006, rSide: 0.008, closed: true, outs: cap.rimN, seg: 6 }), trim, skin);
  const polar = rimPolar(f, cap.rim);
  k.add(brim(k, f, polar, { th0: -0.9, th1: 0.9, width: visorW(0.034, 0.9), slope: () => 0.2, thick: 0.008, radial: 16, inset: 0.004 }), trim, skin);
  // vents: dark slots running front to back
  const ventPath = (th: number, v0: number, v1: number) => {
    const pts: THREE.Vector3[] = [];
    const outs: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const v = v0 + ((v1 - v0) * i) / 8;
      const p = cap.at(th, v);
      const q = cap.at(th, v + 0.02);
      const r = cap.at(th + 0.03, v);
      const n = q.clone().sub(p).cross(r.clone().sub(p)).normalize();
      if (n.dot(p.clone().sub(k.d.headC)) < 0) n.negate();
      pts.push(p.addScaledVector(n, 0.001));
      outs.push(n);
    }
    k.add(tubeAlong(pts, { rOut: 0.0045, rSide: 0.011, outs, seg: 6, taper: (t) => 0.55 + 0.45 * Math.sin(Math.PI * t) }), trim, skin);
  };
  for (const th of [0.32, -0.32, 0.9, -0.9]) ventPath(th, 0.3, 0.86);
  for (const th of [Math.PI - 0.38, Math.PI + 0.38, Math.PI - 1.0, Math.PI + 1.0]) ventPath(th, 0.28, 0.78);
}

function knitHat(k: CostumeKit, knit: Style, cuff: Style, pom: Style): void {
  const f = hatFrame(1.4, 0.32);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, { off: (v) => 0.02 + 0.01 * v, fn: (p, v) => { p.addScaledVector(f.up, 0.04 * v * v * v); } });
  k.add(cap.geo, knit, skin);
  const cuffPts = cap.rim.map((p) => p.clone().addScaledVector(f.up, 0.017));
  k.add(tubeAlong(cuffPts, { rOut: 0.014, rSide: 0.024, closed: true, outs: cap.rimN, seg: 10 }), cuff, skin);
  const c = cap.top.clone().addScaledVector(f.up, 0.038);
  const g = ellipsoid(V(0, 0, 0), 0.052, 0.048, 0.052, 18, 12);
  deform(g, (v) => {
    const n = v.clone().normalize();
    const bump = 1 + 0.1 * Math.sin(n.x * 17 + n.y * 5) * Math.sin(n.z * 13 - n.y * 9) + 0.05 * Math.sin(n.y * 23);
    v.multiplyScalar(bump).add(c);
  });
  k.add(g, pom, skin);
}

function laceCap(k: CostumeKit, lace: Style, gold: Style): void {
  const f = hatFrame(1.305, 0.62, 0, -0.03);
  const skin = headSkin(k, f);
  const cap = k.headCap(f, { off: (v) => 0.011 + 0.007 * v, fn: (p, v) => { p.addScaledVector(f.up, 0.026 * smooth(0.55, 1, v)); } });
  k.add(cap.geo, lace, skin);
  k.add(tubeAlong(cap.rim, { rOut: 0.006, rSide: 0.009, closed: true, outs: cap.rimN, seg: 6 }), lace, skin);
  // upturned pointed wings at the sides
  for (const s of [1, -1]) {
    // wings start at the rim beside the ears and flare up and outwards (not on top: no cat ears)
    const base = cap.at(s * (Math.PI / 2 + 0.12), 0.04);
    const n = base.clone().setY(0).normalize();
    const c = base.clone().addScaledVector(n, 0.034).add(V(0, 0.035, 0));
    const dir = V(s * 0.38, 0.05, 0.92).normalize();
    const upHint = V(s * 0.85, 1, 0).normalize();
    const g = ellipsoid(V(0, 0, 0), 1, 1, 1, 14, 10);
    deform(g, (v) => {
      // pointed top, rounded bottom
      const t = clamp01((v.y + 1) / 2);
      v.x *= 1 - 0.8 * t * t;
      v.y += 0.3 * t * t;
    });
    g.applyMatrix4(orient(c, dir, upHint, V(0.058, 0.08, 0.008)));
    k.add(g, lace, skin);
  }
  // gold temple ornaments (spiral plates)
  for (const s of [1, -1]) {
    const p = cap.at(s * 1.18, 0.04);
    const n = p.clone().sub(k.d.headC).normalize();
    k.add(stud(p.clone().addScaledVector(n, 0.006), n, 0.023, 0.008, 14, 8), gold, skin);
    k.add(stud(p.clone().addScaledVector(n, 0.009).add(V(0, -0.03, 0.006)), n, 0.011, 0.006), gold, skin);
  }
}

function toque(k: CostumeKit, white: Style, seam: Style): void {
  const f = hatFrame(1.435, 0.14);
  const { R } = k.fitHead(f);
  const rb = R + 0.012;
  const skin = headSkin(k, f);
  const prof: [number, number][] = [
    [rb - 0.006, -0.014], [rb, -0.004], [rb + 0.001, 0.05], [rb + 0.014, 0.076], [rb + 0.04, 0.12],
    [rb + 0.056, 0.18], [rb + 0.05, 0.235], [rb + 0.026, 0.272], [rb * 0.5, 0.287], [0, 0.29],
  ];
  k.add(k.revolve(f, 84, prof.length, (phi, i) => {
    const [r, h] = prof[i];
    if (i < 3 || r === 0) return [r, h];
    const pleat = Math.pow(Math.abs(Math.sin(phi * 7)), 0.7);
    return [r * (1 + 0.05 * pleat * (i >= 8 ? 0.5 : 1)), h];
  }, { inside: framePoint(f, 0, 0, 0.12) }), white, skin);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < 48; i++) pts.push(framePoint(f, rb + 0.004, (i / 48) * TAU, 0.05));
  k.add(tubeAlong(pts, { rOut: 0.004, closed: true, seg: 5 }), seam, skin);
}

function crown(k: CostumeKit, body: Style, gold: Style, gems: Style[]): void {
  const f = hatFrame(1.44, 0.18, -0.12);
  const { R } = k.fitHead(f);
  const rc = R + 0.012;
  const skin = headSkin(k, f);
  const N = 8;
  const top = (phi: number) => {
    const x = ((phi / TAU) * N) % 1;
    const tri = 1 - 2 * Math.abs((x < 0 ? x + 1 : x) - 0.5);
    return 0.042 + 0.052 * Math.pow(tri, 1.5);
  };
  k.add(k.revolve(f, 128, 6, (phi, i) => {
    switch (i) {
      case 0: return [rc - 0.004, -0.012];
      case 1: return [rc + 0.004, -0.006];
      case 2: return [rc + 0.006, 0.03];
      case 3: return [rc + 0.005, top(phi)];
      case 4: return [rc - 0.003, top(phi) - 0.003];
      default: return [rc - 0.005, -0.008];
    }
  }), body, skin);
  const rimPts: THREE.Vector3[] = [];
  for (let i = 0; i < 64; i++) rimPts.push(framePoint(f, rc + 0.006, (i / 64) * TAU, -0.004));
  k.add(tubeAlong(rimPts, { rOut: 0.006, rSide: 0.007, closed: true, seg: 6 }), gold, skin);
  for (let i = 0; i < N; i++) {
    const phi = ((i + 0.5) / N) * TAU;
    k.add(ellipsoid(framePoint(f, rc + 0.005, phi, 0.094 + 0.009), 0.012, 0.012, 0.012, 10, 8), gold, skin);
  }
  for (let i = 0; i < 4; i++) {
    const phi = (i / 4) * TAU;
    const p = framePoint(f, rc + 0.007, phi, 0.018);
    const n = framePoint(f, 1, phi, 0).sub(f.o).normalize();
    k.add(stud(p, n, i === 0 ? 0.014 : 0.01, 0.006, 10, 6), gems[i % gems.length], skin);
  }
}

// ---------------------------------------------------------------------------------------------
// the costumes
// ---------------------------------------------------------------------------------------------

type Builder = (k: CostumeKit, guild: Guild) => void;

const BUILDERS: Record<string, Builder> = {
  kaasdrager(k, guild) {
    const white = st(0xf2efe7, { sheen: 0.55, rough: 0.82 });
    const straw = st(0xe2c98a, { color2: 0xa88a4e, pattern: PATTERN.straw, rough: 0.9, sheen: 0.15 });
    const g = GUILD_COLOURS[guild];
    const ribbon = st(g, { rough: 0.45, sheen: 0.8 });
    const leather = st(g, { rough: 0.55, sheen: 0.25 });
    shirt(k, white, { yLo: 0.7, off: 0.009, vDepth: 0.035, vWidth: 0.3, collar: 0.01 });
    sleeves(k, white, { to: 0.74, off: 0.011, cuff: 0.017 });
    trousers(k, white, { top: 0.78, off: 0.017, to: 1.74, hem: 0.013, waist: 0.006, waistStyle: st(0xe4e0d6, { rough: 0.85, sheen: 0.5 }) });
    for (const s of [1, -1]) {
      strap(k, [[s * 0.42, 0.785, 0.027], [s * 0.5, 0.93, 0.019], [s * 0.72, 1.07, 0.019], [s * Math.PI / 2, 1.16, 0.021], [s * (Math.PI - 0.72), 1.07, 0.019], [s * (Math.PI - 0.5), 0.93, 0.019], [s * (Math.PI - 0.42), 0.785, 0.027]], leather, 0.025, 0.004, 32);
      const p = k.shape.pointAtY(0.8, s * 0.43, 0.031, V(0, 0, 0));
      const n = k.shape.normalAtY(0.8, s * 0.43, V(0, 0, 0));
      k.add(roundBox(p, 0.013, 0.016, 0.004, 0.3, 10, 8, orient(V(0, 0, 0), n)), metal(0xb9b2a2, 0.35), 'torso');
    }
    boater(k, straw, ribbon);
  },

  boer(k) {
    const shirtS = st(0x4f78b0, { color2: 0xe6edf4, pattern: PATTERN.stripesV, rough: 0.85, sheen: 0.5 });
    const denim = st(0x3e5c8c, { color2: 0x253c63, pattern: PATTERN.denim, rough: 0.92, sheen: 0.3 });
    const denimLight = st(0x6884b0, { color2: 0x3e5c8c, pattern: PATTERN.denim, rough: 0.92, sheen: 0.3 });
    const brass = metal(0xc9a35a, 0.35);
    const kerchief = st(0xc0262d, { color2: 0xf2ece0, pattern: PATTERN.dots, rough: 0.8, sheen: 0.5 });
    const tweed = st(0x6e6450, { color2: 0x4f4838, pattern: PATTERN.denim, rough: 0.95, sheen: 0.35 });
    const wood = st(0xe8c35c, { rough: 0.5, sheen: 0 });
    shirt(k, shirtS, { yLo: 0.74, off: 0.009, collar: 0.009 });
    sleeves(k, shirtS, { to: 0.7, off: 0.011, cuff: 0.016 });
    trousers(k, denim, { top: 0.8, off: 0.018, to: 1.88, hem: 0.017, hemStyle: denimLight, waist: 0.007 });
    // bib + pocket + straps + buttons
    const bibTh = 0.62, bibLo = 0.79, bibHi = 1.03, bibOff = 0.022;
    k.add(k.torsoPanel({ yLo: bibLo, yHi: bibHi, off: bibOff, th0: -bibTh, th1: bibTh }), denim, 'torso');
    edge(k, () => bibHi, bibOff, -bibTh, bibTh, 0.0055, denim);
    for (const s of [1, -1]) {
      const { pts, outs } = k.surfacePath([[s * bibTh, bibLo + 0.01, bibOff], [s * bibTh, (bibLo + bibHi) / 2, bibOff], [s * bibTh, bibHi, bibOff]], 8);
      k.add(tubeAlong(pts, { rOut: 0.0055, outs, seg: 6 }), denim, 'torso');
      strap(k, [[s * 0.5, bibHi - 0.005, 0.024], [s * 0.66, 1.09, 0.019], [s * Math.PI / 2, 1.158, 0.021], [s * (Math.PI - 0.7), 1.06, 0.019], [s * (Math.PI - 0.45), 0.85, 0.022], [s * (Math.PI - 0.4), 0.79, 0.024]], denim, 0.021, 0.004, 36);
      const p = k.shape.pointAtY(bibHi - 0.012, s * 0.5, 0.03, V(0, 0, 0));
      const n = k.shape.normalAtY(bibHi - 0.012, s * 0.5, V(0, 0, 0));
      k.add(stud(p, n, 0.014, 0.006), brass, 'torso');
    }
    k.add(k.torsoPanel({ yLo: 0.87, yHi: 0.96, off: 0.026, th0: -0.22, th1: 0.22, nu: 8, nv: 4 }), denimLight, 'torso');
    edge(k, () => 0.96, 0.026, -0.22, 0.22, 0.004, denim);
    // neckerchief with a knot at the front
    ring(k, () => 1.104, 0.016, 0.011, kerchief, 0.02, 56);
    const kp = k.shape.pointAtY(1.085, 0, 0.032, V(0, 0, 0));
    k.add(ellipsoid(kp, 0.025, 0.02, 0.016, 12, 8), kerchief, 'torso');
    for (const s of [1, -1]) {
      const tp = k.shape.pointAtY(1.04, s * 0.13, 0.03, V(0, 0, 0));
      k.add(blob(tp, V(0, 0.15, 1).normalize(), V(s * 0.35, 1, 0), 0.02, 0.038, 0.005), kerchief, 'torso');
    }
    flatCap(k, tweed, st(0x4d4536, { rough: 0.9 }));
    klompen(k, wood, st(0xc4392e, { rough: 0.5, sheen: 0 }));
  },

  klederdracht(k) {
    const lace = st(0xf7f5ef, { color2: 0xd9d4c8, pattern: PATTERN.lace, rough: 0.8, sheen: 0.6 });
    const gold = metal(0xd9ab4a, 0.28);
    const black = st(0x24222a, { rough: 0.8, sheen: 0.7 });
    const chintz = st(0xb3283a, { color2: 0xf2cd6a, pattern: PATTERN.dots, rough: 0.8, sheen: 0.55 });
    const coral = st(0xc8282c, { rough: 0.28, sheen: 0 });
    const skirtS = st(0x2a2730, { color2: 0x8e2a2e, pattern: PATTERN.stripesV, rough: 0.88, sheen: 0.55 });
    const apron = st(0x2f4f98, { color2: 0xdfe5ef, pattern: PATTERN.gingham, rough: 0.85, sheen: 0.5 });
    const wood = st(0xefe8da, { rough: 0.5, sheen: 0 });
    laceCap(k, lace, gold);
    // bodice with a square neckline, puff sleeves
    const neck = (th: number) => 1.104 - 0.065 * frontW(th, 0.6);
    k.add(k.torsoPanel({ yLo: 0.76, yHi: neck, off: 0.01, nu: 52 }), black, 'torso');
    ring(k, neck, 0.01, 0.006, black, 0.006, 64);
    sleeves(k, black, { to: 0.55, off: 0.011, bulge: (f) => 0.016 * Math.sin(Math.PI * clamp01(f / 0.55)), cuff: 0.009, cuffStyle: lace });
    // flowered chest piece (kraplap)
    k.add(k.torsoPanel({ yLo: 0.84, yHi: 1.046, off: 0.014, th0: -0.5, th1: 0.5, nu: 12 }), chintz, 'torso');
    edge(k, () => 1.046, 0.014, -0.5, 0.5, 0.004, gold);
    // coral necklace (2 strands) + gold clasp
    for (const [y, span, nb, off] of [[1.112, 1.25, 15, 0.012], [1.088, 1.12, 13, 0.016]] as const) {
      for (let i = 0; i < nb; i++) {
        const th = -span + (2 * span * i) / (nb - 1);
        const yy = y - 0.012 * Math.cos((th / span) * (Math.PI / 2));
        const p = k.shape.pointAtY(yy, th, off + 0.006, V(0, 0, 0));
        k.add(ellipsoid(p, 0.0105, 0.0105, 0.0105, 6, 5), coral, 'torso');
      }
    }
    const cp = k.shape.pointAtY(1.07, 0, 0.022, V(0, 0, 0));
    k.add(roundBox(cp, 0.016, 0.012, 0.006, 0.4, 10, 8), gold, 'torso');
    // wide skirt + checked apron + waistband with a bow at the back
    const flare = (t: number) => 0.055 * t + 0.03 * t * t;
    const sk: SkirtOpts = { anchor: 0.7, bottom: 0.25, off: 0.016, flare };
    k.add(k.skirt({ ...sk, top: 0.8, nv: 16 }), skirtS, 'torso');
    const hem = k.skirtEdge(0.25, sk);
    k.add(tubeAlong(hem.pts, { rOut: 0.009, closed: true, outs: hem.outs, seg: 6 }), black, 'torso');
    const ap: SkirtOpts = { anchor: 0.7, bottom: 0.3, off: 0.029, flare: (t) => flare(t * (0.45 / 0.5)) + 0.004 * t };
    k.add(k.skirt({ ...ap, top: 0.79, th0: -0.85, th1: 0.85, nv: 14 }), apron, 'torso');
    const ah = k.skirtEdge(0.3, ap, -0.85, 0.85, 20);
    k.add(tubeAlong(ah.pts, { rOut: 0.006, outs: ah.outs, seg: 6 }), apron, 'torso');
    ring(k, () => 0.795, 0.033, 0.008, apron, 0.014);
    const bb = k.shape.pointAtY(0.795, Math.PI, 0.045, V(0, 0, 0));
    for (const s of [1, -1]) k.add(blob(bb.clone().add(V(s * 0.03, 0.006, 0)), V(0, 0, -1), V(s * 0.6, 1, 0), 0.03, 0.018, 0.007), apron, 'torso');
    for (const s of [1, -1]) k.add(blob(bb.clone().add(V(s * 0.016, -0.05, -0.004)), V(0, 0, -1), V(s * 0.2, 1, 0), 0.012, 0.045, 0.004), apron, 'torso');
    klompen(k, wood, st(0x2f63b8, { rough: 0.5, sheen: 0 }));
  },

  toerist(k) {
    const hawaii = st(0x1f9e95, { color2: 0xffd75a, pattern: PATTERN.dots, rough: 0.82, sheen: 0.5 });
    const khaki = st(0xb9a57c, { rough: 0.9, sheen: 0.4 });
    const hatS = st(0xe8dfc4, { rough: 0.9, sheen: 0.5 });
    const sock = st(0xf3f2ee, { color2: 0xd8d6cf, pattern: PATTERN.knit, rough: 0.95, sheen: 0.6 });
    const brown = st(0x6b4428, { rough: 0.7, sheen: 0.1 });
    const camBody = plastic(0x2a2a2e, 0.42);
    const glass = st(0x101820, { rough: 0.08, metal: 0.2, sheen: 0 });
    const silver = metal(0xc8c8c4, 0.3);
    const pack = st(0xdc5a34, { rough: 0.75, sheen: 0.4 });
    const packDark = st(0x9b3a22, { rough: 0.75, sheen: 0.4 });
    const webbing = st(0x2e3236, { rough: 0.7, sheen: 0.2 });
    bucketHat(k, hatS, st(0x8f7f5b, { rough: 0.9 }));
    shirt(k, hawaii, { yLo: 0.66, off: 0.012, vDepth: 0.075, vWidth: 0.34, flare: 0.012, collar: 0.009 });
    sleeves(k, hawaii, { to: 0.5, off: 0.012, bulge: (f) => 0.012 * clamp01(f / 0.5), cuff: 0.007 });
    for (const y of [0.74, 0.82]) {
      const p = k.shape.pointAtY(y, 0, 0.022, V(0, 0, 0));
      k.add(stud(p, k.shape.normalAtY(y, 0, V(0, 0, 0)), 0.008, 0.004, 8, 5), st(0xf4f1e6, { rough: 0.4, sheen: 0 }), 'torso');
    }
    trousers(k, khaki, { top: 0.69, off: 0.014, to: 0.82, hem: 0.009, bulge: 0.014 });
    shaft(k, sock, 0.45, 0.006, 0.007);
    for (const side of [1, -1] as const) {
      const c = k.footCentre(side);
      const bone = side > 0 ? 'lowerLegL' : 'lowerLegR';
      k.add(ellipsoid(V(c.x, k.d.soleY + 0.004, c.z + 0.008), 0.097, 0.012, 0.137, 14, 5), brown, { bone, jig: 0 });
    }
    footStraps(k, brown, [0.05, -0.035]);
    // camera on the chest + strap around the neck
    const cy = 0.935;
    const cn = k.shape.normalAtY(cy, 0, V(0, 0, 0));
    const cpos = k.shape.pointAtY(cy, 0, 0.05, V(0, 0, 0));
    const cm = orient(V(0, 0, 0), cn);
    k.add(roundBox(cpos, 0.062, 0.04, 0.026, 0.22, 12, 8, cm), camBody, { bone: 'chest' });
    const lensA = cpos.clone().addScaledVector(cn, 0.02);
    const lensB = cpos.clone().addScaledVector(cn, 0.058);
    k.add(cylinderAB(lensA, lensB, 0.026, 0.024, 12), camBody, { bone: 'chest' });
    k.add(stud(lensB, cn, 0.019, 0.004, 14, 6), glass, { bone: 'chest' });
    k.add(cylinderAB(lensB.clone().addScaledVector(cn, -0.004), lensB.clone().addScaledVector(cn, 0.002), 0.025, 0.025, 16), silver, { bone: 'chest' });
    k.add(stud(cpos.clone().add(V(0.035, 0.041, 0)), V(0, 1, 0), 0.008, 0.006, 8, 5), silver, { bone: 'chest' });
    k.add(roundBox(cpos.clone().add(V(-0.03, 0.042, 0)), 0.014, 0.008, 0.012, 0.3, 8, 6), camBody, { bone: 'chest' });
    strap(k, [[0.42, 0.965, 0.04], [0.62, 1.06, 0.02], [Math.PI / 2, 1.13, 0.018], [Math.PI, 1.135, 0.016], [1.5 * Math.PI, 1.13, 0.018], [TAU - 0.62, 1.06, 0.02], [TAU - 0.42, 0.965, 0.04]], webbing, 0.009, 0.003, 48);
    // backpack + shoulder straps
    const bpos = k.shape.pointAtY(0.92, Math.PI, 0.072, V(0, 0, 0));
    k.add(roundBox(bpos, 0.15, 0.175, 0.065, 0.3, 16, 10), pack, { bone: 'chest' });
    k.add(roundBox(bpos.clone().add(V(0, -0.07, -0.066)), 0.1, 0.075, 0.028, 0.3, 10, 8), packDark, { bone: 'chest' });
    const hp: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      hp.push(bpos.clone().add(V(Math.cos(a) * 0.045, 0.172 + Math.sin(a) * 0.03, 0.0)));
    }
    k.add(tubeAlong(hp, { rOut: 0.006, seg: 6 }), webbing, { bone: 'chest' });
    for (const s of [1, -1]) {
      strap(k, [[s * (Math.PI - 0.32), 1.07, 0.022], [s * (Math.PI / 2 + 0.35), 1.15, 0.021], [s * Math.PI / 2, 1.165, 0.023], [s * 0.95, 1.1, 0.02], [s * 0.66, 0.96, 0.018], [s * 0.7, 0.84, 0.018], [s * 1.25, 0.8, 0.018], [s * (Math.PI - 0.55), 0.79, 0.034]], webbing, 0.019, 0.004, 30);
    }
  },

  visser(k) {
    const oil = st(0xf1c22e, { rough: 0.38, sheen: 0.05 });
    const toggle = plastic(0x3b3226, 0.5);
    const rubber = st(0x2f4a33, { rough: 0.42, sheen: 0 });
    const soleS = st(0x1c1e1b, { rough: 0.7, sheen: 0 });
    souwester(k, oil);
    // coat: hugs the torso, hangs free below the waist
    const coat: SkirtOpts = { anchor: 0.7, bottom: 0.4, off: 0.014, flare: (t) => 0.022 * t + 0.02 * t * t };
    k.add(k.skirt({ ...coat, top: 1.105, nv: 24 }), oil, 'torso');
    const hem = k.skirtEdge(0.4, coat);
    k.add(tubeAlong(hem.pts, { rOut: 0.008, closed: true, outs: hem.outs, seg: 6 }), oil, 'torso');
    // front placket line + toggles
    const placket: THREE.Vector3[] = [];
    for (let i = 0; i <= 18; i++) placket.push(k.skirtPoint(0, 0.4 + (i / 18) * (1.08 - 0.4), { ...coat, off: coat.off + 0.002 }, V(0, 0, 0)));
    k.add(tubeAlong(placket, { rOut: 0.004, rSide: 0.007, seg: 6 }), st(0xd9a91f, { rough: 0.4, sheen: 0 }), 'torso');
    for (const y of [0.56, 0.7, 0.84, 0.98]) {
      const p = k.skirtPoint(0.06, y, { ...coat, off: coat.off + 0.008 }, V(0, 0, 0));
      k.add(roundBox(p, 0.018, 0.006, 0.006, 0.4, 8, 6), toggle, 'torso');
    }
    // turned-up collar, open at the front
    k.add(k.torsoPanel({ yLo: 1.07, yHi: 1.155, off: (_t, y) => 0.016 + 0.03 * smooth(1.07, 1.155, y), th0: 0.55, th1: TAU - 0.55, nu: 40, nv: 4 }), oil, 'torso');
    edge(k, () => 1.155, 0.046, 0.55, TAU - 0.55, 0.005, oil);
    sleeves(k, oil, { to: 1.86, off: 0.014, cuff: 0.012 });
    // rubber boots
    shaft(k, rubber, 0.28, 0.016, 0.011, rubber, 0.01);
    for (const side of [1, -1] as const) k.shoe(side, rubber, soleS, { inflate: 0.016, len: 1.05, soleT: 0.013 });
  },

  stadswacht(k) {
    const navy = st(0x27345a, { rough: 0.85, sheen: 0.55 });
    const navyDark = st(0x1c2540, { rough: 0.85, sheen: 0.55 });
    const hivis = st(0xd6ee36, { rough: 0.62, sheen: 0.4 });
    const reflect = st(0xc7cbd0, { rough: 0.25, metal: 0.55, sheen: 0 });
    const black = st(0x15161a, { rough: 0.5, sheen: 0.1 });
    const visor = st(0x0e0f12, { rough: 0.18, sheen: 0 });
    const silver = metal(0xcfd2d6, 0.28);
    peakedCap(k, navyDark, black, visor, silver);
    shirt(k, navy, { yLo: 0.72, off: 0.009, collar: 0.01 });
    sleeves(k, navy, { to: 1.82, off: 0.01, cuff: 0.009 });
    trousers(k, navy, { top: 0.75, off: 0.012, to: 1.9, hem: 0.01 });
    const vNeck = (th: number) => 1.1 - 0.1 * frontW(th, 0.45);
    k.add(k.torsoPanel({ yLo: 0.7, yHi: vNeck, off: 0.017, nu: 52 }), hivis, 'torso');
    ring(k, vNeck, 0.017, 0.006, hivis, 0.006, 64);
    ring(k, () => 0.7, 0.017, 0.006, hivis, 0.007);
    for (const y of [0.8, 0.92]) k.add(k.torsoPanel({ yLo: y, yHi: y + 0.034, off: 0.0205, nu: 52, nv: 2 }), reflect, 'torso');
    // radio on the left chest
    const rp = k.shape.pointAtY(0.99, 0.62, 0.035, V(0, 0, 0));
    const rn = k.shape.normalAtY(0.99, 0.62, V(0, 0, 0));
    k.add(roundBox(rp, 0.024, 0.04, 0.014, 0.3, 10, 8, orient(V(0, 0, 0), rn)), black, { bone: 'chest' });
    k.add(cylinderAB(rp.clone().add(V(0.01, 0.035, 0)), rp.clone().add(V(0.012, 0.095, -0.004)), 0.005, 0.004, 6), black, { bone: 'chest' });
    for (const side of [1, -1] as const) k.shoe(side, black, st(0x0b0b0d, { rough: 0.7, sheen: 0 }));
  },

  wielrenner(k) {
    const jersey = st(0xf6f4ee, { color2: 0xd42a2a, pattern: PATTERN.dots, rough: 0.6, sheen: 0.45 });
    const red = st(0xd42a2a, { rough: 0.55, sheen: 0.4 });
    const lycra = st(0x1e1f24, { rough: 0.42, sheen: 0.4 });
    const shell = st(0xd8392d, { rough: 0.28, sheen: 0 });
    const trim = plastic(0x18181b, 0.4);
    const sock = st(0xf3f2ee, { rough: 0.9, sheen: 0.5 });
    helmet(k, shell, trim);
    shirt(k, jersey, { yLo: 0.7, off: 0.014, vDepth: 0.02, vWidth: 0.2, collar: 0.009, collarStyle: red });
    const zip: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) zip.push(k.shape.pointAtY(0.93 + (i / 8) * (1.09 - 0.93), 0, 0.017, V(0, 0, 0)));
    k.add(tubeAlong(zip, { rOut: 0.003, rSide: 0.005, seg: 5 }), st(0xb8b8b8, { rough: 0.4, metal: 0.6, sheen: 0 }), 'torso');
    sleeves(k, jersey, { to: 0.5, off: 0.012, cuff: 0.008, cuffStyle: red });
    trousers(k, lycra, { top: 0.75, off: 0.01, to: 0.8, hem: 0.008 });
    shaft(k, sock, 0.62, 0.006, 0.006);
    for (const side of [1, -1] as const) k.shoe(side, st(0xf2f2f0, { rough: 0.4, sheen: 0 }), st(0x15161a, { rough: 0.6, sheen: 0 }), { inflate: 0.011 });
    footStraps(k, st(0x15161a, { rough: 0.5, sheen: 0 }), [0.035], 0.019);
  },

  kok(k) {
    const white = st(0xf7f6f2, { rough: 0.78, sheen: 0.5 });
    const seam = st(0xe6e3dc, { rough: 0.8 });
    const check = st(0x3a3b42, { color2: 0xc9c9c6, pattern: PATTERN.check, rough: 0.85, sheen: 0.45 });
    const buttons = plastic(0x1d1d22, 0.35);
    const red = st(0xc92a2f, { rough: 0.75, sheen: 0.6 });
    toque(k, white, seam);
    shirt(k, white, { yLo: 0.62, yHi: 1.1, off: 0.013, flare: 0.006, collar: 0 });
    // double-breasted front flap + buttons
    k.add(k.torsoPanel({ yLo: 0.62, yHi: 1.09, off: 0.017, th0: -0.38, th1: 0.2, nu: 10 }), white, 'torso');
    const flapEdge = k.surfacePath([[0.2, 0.625, 0.017], [0.2, 0.86, 0.017], [0.2, 1.09, 0.017]], 12);
    k.add(tubeAlong(flapEdge.pts, { rOut: 0.004, outs: flapEdge.outs, seg: 6 }), white, 'torso');
    for (const th of [-0.22, 0.32]) {
      for (const y of [0.73, 0.85, 0.97]) {
        const p = k.shape.pointAtY(y, th, 0.023, V(0, 0, 0));
        k.add(stud(p, k.shape.normalAtY(y, th, V(0, 0, 0)), 0.011, 0.005, 10, 6), buttons, 'torso');
      }
    }
    // stand collar + red neckerchief knot
    k.add(k.torsoPanel({ yLo: 1.085, yHi: 1.13, off: (_t, y) => 0.016 + 0.004 * smooth(1.085, 1.13, y), nu: 52, nv: 2 }), white, 'torso');
    ring(k, () => 1.13, 0.02, 0.0045, red, 0.0045, 48);
    ring(k, () => 1.088, 0.016, 0.004, red, 0.004, 48);
    sleeves(k, white, { to: 1.86, off: 0.013, cuff: 0.012 });
    trousers(k, check, { top: 0.68, off: 0.009, to: 1.92, hem: 0.009 });
    for (const side of [1, -1] as const) k.shoe(side, st(0x1b1b1f, { rough: 0.35, sheen: 0 }), st(0x0d0d0f, { rough: 0.7, sheen: 0 }));
  },

  koning(k) {
    const orange = st(0xf47b20, { rough: 0.34, sheen: 0.05 });
    const gold = metal(0xe2b14c, 0.3);
    const gems = [st(0xc81f3a, { rough: 0.1, sheen: 0 }), st(0x2f63d6, { rough: 0.1, sheen: 0 }), st(0x2fae5a, { rough: 0.1, sheen: 0 }), st(0xf2f2f2, { rough: 0.1, sheen: 0 })];
    const boa = st(0xff8a1c, { color2: 0xd95f0b, pattern: PATTERN.knit, rough: 1, sheen: 1 });
    crown(k, orange, gold, gems);
    // feather boa: a fat lumpy ring round the neck
    const { pts, outs } = k.edgePath(() => 1.083, 0.036, 0, TAU, 72);
    pts.pop();
    outs.pop();
    k.add(tubeAlong(pts, { rOut: 0.038, rSide: 0.036, closed: true, outs, seg: 12, taper: (f) => 1 + 0.16 * Math.sin(f * 97) * Math.sin(f * 41 + 1) }), boa, 'torso');
    // sash (red / white / blue) from the left shoulder to the right hip
    const yc = (th: number) => 0.92 + 0.25 * Math.sin(th);
    const bands: [number, number, number][] = [[0.0125, 0.0375, 0xc8202e], [-0.0125, 0.0125, 0xf4f2ee], [-0.0375, -0.0125, 0x23439a]];
    for (const [a, b, col] of bands) {
      k.add(k.torsoPanel({ yLo: (th) => yc(th) + a, yHi: (th) => yc(th) + b, off: 0.013, nu: 64, nv: 1 }), st(col, { rough: 0.6, sheen: 0.8 }), 'torso');
    }
    const kn = k.shape.pointAtY(yc(-1.35), -1.35, 0.024, V(0, 0, 0));
    k.add(ellipsoid(kn, 0.024, 0.026, 0.016, 12, 8), gold, 'torso');
  },

  schaatser(k) {
    const red = st(0xc62f2b, { color2: 0x9c2420, pattern: PATTERN.knit, rough: 0.95, sheen: 0.8 });
    const wool = st(0xf1ebe0, { color2: 0xd8d0c2, pattern: PATTERN.knit, rough: 0.95, sheen: 0.8 });
    const sweater = st(0x2b3f73, { color2: 0x3c548f, pattern: PATTERN.knit, rough: 0.95, sheen: 0.7 });
    const scarf = st(0xc62f2b, { color2: 0xf1ebe0, pattern: PATTERN.stripesH, rough: 0.95, sheen: 0.8 });
    knitHat(k, red, wool, wool);
    shirt(k, sweater, { yLo: 0.66, off: 0.012, hem: 0.011, collar: 0.012 });
    for (const y of [0.92, 0.975]) k.add(k.torsoPanel({ yLo: y, yHi: y + 0.026, off: 0.0145, nu: 52, nv: 2 }), wool, 'torso');
    sleeves(k, sweater, { to: 1.85, off: 0.012, cuff: 0.012 });
    // scarf: wrap + two hanging ends with fringes
    ring(k, () => 1.098, 0.03, 0.026, scarf, 0.03, 60);
    const ends: [number, number, number, number, number][] = [[0.22, 0.52, 0.72, 1.07, 0.044], [0.46, 0.76, 0.8, 1.05, 0.052]];
    for (const [t0, t1, yLo, yHi, off] of ends) {
      k.add(k.torsoPanel({ yLo, yHi, off, th0: t0, th1: t1, nu: 6, nv: 10 }), scarf, 'torso');
      edge(k, () => yLo, off, t0, t1, 0.005, scarf);
      for (let i = 0; i < 5; i++) {
        const th = t0 + ((i + 0.5) / 5) * (t1 - t0);
        const a = k.shape.pointAtY(yLo, th, off, V(0, 0, 0));
        const b = k.shape.pointAtY(yLo - 0.035, th, off + 0.003, V(0, 0, 0));
        k.add(cylinderAB(a, b, 0.0035, 0.003, 5), wool, 'torso');
      }
    }
  },
};

// ---------------------------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------------------------

const cache = new Map<string, THREE.BufferGeometry | null>();

/** Shared costume geometry (null for 'geen' / unknown ids). Cached per id / scale / guild. */
export function getCostumeGeometry(id: string, scale: number, guild: Guild): THREE.BufferGeometry | null {
  const b = BUILDERS[id];
  if (!b) return null;
  const key = `${id}|${Math.round(scale * 1000)}|${costumeTraits(id).guild ? guild : '-'}`;
  if (cache.has(key)) return cache.get(key)!;
  const k = new CostumeKit(getTorsoShape());
  b(k, guild);
  const g = k.m.build(true);
  if (Math.round(scale * 1000) !== 1000) {
    g.scale(scale, scale, scale);
    g.computeBoundingSphere();
    g.computeBoundingBox();
  }
  cache.set(key, g);
  return g;
}
