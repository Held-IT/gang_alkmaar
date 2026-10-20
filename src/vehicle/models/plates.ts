// Dutch licence plates and per-car decals (one small CanvasTexture per car):
//   front plate, rear plate, brand lettering, model lettering, taxi roof sign.
// Plate design: yellow reflective plate, black characters, blue EU strip with the circle of stars
// and "NL"; taxis have light-blue plates. Character sets follow the current Dutch side codes.
import * as THREE from 'three';

export const DECAL_W = 512;
export const DECAL_H = 512;

/** pixel rectangles in the decal canvas [x, y, w, h] */
export const DECAL_RECTS = {
  plateFront: [0, 0, 512, 109],
  plateRear: [0, 116, 512, 109],
  brand: [0, 236, 512, 56],
  model: [0, 300, 512, 48],
  sign: [0, 356, 512, 100],
  signPlain: [8, 470, 48, 30],
  black: [72, 470, 48, 30],
} as const;

export type DecalRectName = keyof typeof DECAL_RECTS;

/** uv rectangle [u0, v0, u1, v1] of a decal region (CanvasTexture with flipY). */
export function decalUv(name: DecalRectName): [number, number, number, number] {
  const [x, y, w, h] = DECAL_RECTS[name];
  return [x / DECAL_W, 1 - (y + h) / DECAL_H, (x + w) / DECAL_W, 1 - y / DECAL_H];
}

const LETTERS = 'BDFGHJKLNPRSTXZ';
const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
const digits = (n: number) => Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');
const letters = (n: number) => Array.from({ length: n }, () => pick(LETTERS)).join('');

/**
 * Random plate in a current Dutch side code. kind 'bestel' gives a commercial-vehicle plate
 * starting with V (e.g. 'VX-123-B').
 */
export function randomDutchPlate(kind: 'auto' | 'bestel' = 'auto'): string {
  if (kind === 'bestel') {
    return Math.random() < 0.5 ? `V${letters(1)}-${digits(3)}-${letters(1)}` : `V-${digits(3)}-${letters(2)}`;
  }
  switch (Math.floor(Math.random() * 6)) {
    case 0:
      return `${letters(2)}-${digits(3)}-${letters(1)}`; // side code 9
    case 1:
      return `${letters(1)}-${digits(3)}-${letters(2)}`; // 10
    case 2:
      return `${letters(3)}-${digits(2)}-${letters(1)}`; // 11
    case 3:
      return `${letters(1)}-${digits(2)}-${letters(3)}`; // 12
    case 4:
      return `${digits(1)}-${letters(2)}-${digits(3)}`; // 13
    default:
      return `${digits(3)}-${letters(2)}-${digits(1)}`; // 14
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawPlate(g: CanvasRenderingContext2D, rect: readonly number[], text: string, taxi: boolean): void {
  const [x, y, w, h] = rect;
  g.save();
  // plate body
  g.fillStyle = '#1a1a1a';
  roundRect(g, x + 1, y + 1, w - 2, h - 2, 9);
  g.fill();
  g.fillStyle = taxi ? '#5aa9de' : '#f7c51e';
  roundRect(g, x + 4, y + 4, w - 8, h - 8, 7);
  g.fill();
  // subtle reflective sheen
  const sh = g.createLinearGradient(x, y, x, y + h);
  sh.addColorStop(0, 'rgba(255,255,255,0.12)');
  sh.addColorStop(0.5, 'rgba(255,255,255,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.06)');
  g.fillStyle = sh;
  g.fillRect(x + 4, y + 4, w - 8, h - 8);
  // EU strip
  const sw = Math.round(w * 0.085);
  g.fillStyle = '#123f9c';
  roundRect(g, x + 4, y + 4, sw, h - 8, 6);
  g.fill();
  g.fillRect(x + 4 + sw - 8, y + 4, 8, h - 8);
  const cx = x + 4 + sw / 2;
  const cy = y + 4 + (h - 8) * 0.33;
  const rr = sw * 0.3;
  g.fillStyle = '#f7d21e';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const sx = cx + Math.cos(a) * rr;
    const sy = cy + Math.sin(a) * rr;
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const ra = k % 2 === 0 ? sw * 0.055 : sw * 0.022;
      const aa = -Math.PI / 2 + (k / 10) * Math.PI * 2;
      if (k === 0) g.moveTo(sx + Math.cos(aa) * ra, sy + Math.sin(aa) * ra);
      else g.lineTo(sx + Math.cos(aa) * ra, sy + Math.sin(aa) * ra);
    }
    g.closePath();
    g.fill();
  }
  g.fillStyle = '#ffffff';
  g.font = `bold ${Math.round(h * 0.3)}px Arial, Helvetica, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('NL', cx, y + 4 + (h - 8) * 0.76);
  // characters: condensed bold, scaled to fit
  g.fillStyle = '#111111';
  const fh = Math.round(h * 0.74);
  g.font = `bold ${fh}px "Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  const avail = w - sw - 30;
  const tw = g.measureText(text).width;
  const sx = Math.min(1, avail / tw);
  g.translate(x + 4 + sw + (w - sw - 8) / 2, y + h / 2 + h * 0.03);
  g.scale(sx * 0.98, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

function drawLettering(g: CanvasRenderingContext2D, rect: readonly number[], text: string, spacing: number): void {
  if (!text) return;
  const [x, y, w, h] = rect;
  g.save();
  g.font = `600 ${Math.round(h * 0.82)}px "Segoe UI", Arial, Helvetica, sans-serif`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  const chars = text.split('');
  const widths = chars.map((c) => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const scale = Math.min(1, (w - 8) / total);
  g.translate(x + w / 2, y + h / 2);
  g.scale(scale, 1);
  let cx = -total / 2;
  // chrome look: vertical gradient
  const grd = g.createLinearGradient(0, -h / 2, 0, h / 2);
  grd.addColorStop(0, '#f2f4f6');
  grd.addColorStop(0.5, '#a9aeb3');
  grd.addColorStop(1, '#e4e7ea');
  g.fillStyle = grd;
  chars.forEach((c, i) => {
    g.fillText(c, cx + widths[i] / 2, 0);
    cx += widths[i] + spacing;
  });
  g.restore();
}

export interface DecalInfo {
  taxi: boolean;
  sign: string | null;
  brand: string;
  model: string;
}

export function createPlateTexture(text: string, info: DecalInfo): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = DECAL_W;
  c.height = DECAL_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, DECAL_W, DECAL_H);
  drawPlate(g, DECAL_RECTS.plateFront, text, info.taxi);
  drawPlate(g, DECAL_RECTS.plateRear, text, info.taxi);
  drawLettering(g, DECAL_RECTS.brand, info.brand, 14);
  drawLettering(g, DECAL_RECTS.model, info.model, 8);
  if (info.sign) {
    const [x, y, w, h] = DECAL_RECTS.sign;
    g.fillStyle = '#f4e9a8';
    g.fillRect(x, y, w, h);
    g.fillStyle = '#141414';
    g.font = `bold ${Math.round(h * 0.7)}px Arial, Helvetica, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(info.sign, x + w / 2, y + h / 2 + 3);
    g.strokeStyle = '#141414';
    g.lineWidth = 4;
    g.strokeRect(x + 6, y + 6, w - 12, h - 12);
  }
  {
    const [x, y, w, h] = DECAL_RECTS.signPlain;
    g.fillStyle = '#f4e9a8';
    g.fillRect(x, y, w, h);
    const [x2, y2, w2, h2] = DECAL_RECTS.black;
    g.fillStyle = '#0c0c0c';
    g.fillRect(x2, y2, w2, h2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
