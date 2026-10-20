// Canvas renderer for Dutch traffic signs (RVV 1990) and blue street-name plates.
//
// renderSignAtlas(codes) draws every unique sign code into a 256 px cell of one atlas (transparent
// outside the sign shape, so one alpha-tested quad renders every shape). Generic per series:
//   A1/A2/A4 speed signs, B1..B7 priority signs, C1..C22 prohibitions (red ring + pictogram),
//   C3/C4/C5 one-way, D blue mandatory arrows, E1/E2/E4.., F, G5/G6 woonerf, G7/G11/G12a/G13
//   paths, J warning triangles, L2/L8 information, H town sign, OB sub-signs, fallback plate.
// renderStreetNameAtlas(names) draws blue enamel street-name plates (white text + white border).
import * as THREE from 'three';
import { canvasToTexture, makeCanvas } from './util/textures';

const RED = '#c4122f';
const BLUE = '#0d4f9e';
const YELLOW = '#f3c300';
const WHITE = '#f6f6f2';
const BLACK = '#1a1a1a';
const GREY = '#8a8d90';
const FONT = 'Bahnschrift, "DIN Alternate", "Arial Narrow", Arial, sans-serif';

/** Normalise OSM / pipeline codes: "NL:A01-30-ZB" -> "A1-30-ZB", "c02" -> "C2". */
export function normalizeSignCode(raw: string): string {
  let c = String(raw ?? '').trim().toUpperCase().replace(/^NL:/, '').replace(/\s+/g, '');
  c = c.split(/[;,]/)[0];
  const m = /^([A-Z]+)0*(\d+)([A-Z]?)(.*)$/.exec(c);
  if (m) c = `${m[1]}${m[2]}${m[3]}${m[4]}`;
  return c || '?';
}

export interface SignLayout {
  /** physical size in metres */
  w: number;
  h: number;
  /** atlas UV rect: u0, v0, du, dv */
  uv: [number, number, number, number];
}

type Draw = (g: Pen) => void;
interface SignDef { w: number; h: number; draw: Draw }

/** Drawing helper in sign units: the sign spans [-w/2, w/2] x [-h/2, h/2] metres, y down. */
class Pen {
  constructor(readonly ctx: CanvasRenderingContext2D, readonly cx: number, readonly cy: number, readonly s: number) {}
  X(x: number) { return this.cx + x * this.s; }
  Y(y: number) { return this.cy + y * this.s; }
  path(pts: [number, number][], fill?: string, stroke?: string, lw = 0): void {
    const c = this.ctx;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y))));
    c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw * this.s; c.lineJoin = 'round'; c.stroke(); }
  }
  circle(x: number, y: number, r: number, fill?: string, stroke?: string, lw = 0): void {
    const c = this.ctx;
    c.beginPath();
    c.arc(this.X(x), this.Y(y), r * this.s, 0, Math.PI * 2);
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw * this.s; c.stroke(); }
  }
  ring(x: number, y: number, r: number, w: number, col: string): void {
    this.circle(x, y, r - w / 2, undefined, col, w);
  }
  rect(x: number, y: number, w: number, h: number, fill: string, r = 0): void {
    const c = this.ctx;
    c.beginPath();
    c.roundRect(this.X(x), this.Y(y), w * this.s, h * this.s, r * this.s);
    c.fillStyle = fill;
    c.fill();
  }
  line(pts: [number, number][], col: string, lw: number, cap: CanvasLineCap = 'round'): void {
    const c = this.ctx;
    c.beginPath();
    pts.forEach(([x, y], i) => (i ? c.lineTo(this.X(x), this.Y(y)) : c.moveTo(this.X(x), this.Y(y))));
    c.strokeStyle = col;
    c.lineWidth = lw * this.s;
    c.lineCap = cap;
    c.lineJoin = 'round';
    c.stroke();
  }
  text(t: string, x: number, y: number, size: number, col: string, weight = 700, maxW?: number): void {
    const c = this.ctx;
    c.font = `${weight} ${Math.round(size * this.s)}px ${FONT}`;
    c.fillStyle = col;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(t, this.X(x), this.Y(y), maxW ? maxW * this.s : undefined);
  }
}

// ------------------------------------------------------------------ pictograms (unit ~ sign m)

function car(g: Pen, x: number, y: number, k: number, col = BLACK): void {
  g.path([[x - 0.17 * k, y + 0.03 * k], [x - 0.17 * k, y - 0.03 * k], [x - 0.1 * k, y - 0.05 * k], [x - 0.06 * k, y - 0.11 * k], [x + 0.07 * k, y - 0.11 * k], [x + 0.11 * k, y - 0.05 * k], [x + 0.17 * k, y - 0.035 * k], [x + 0.17 * k, y + 0.03 * k]], col);
  g.path([[x - 0.045 * k, y - 0.095 * k], [x + 0.06 * k, y - 0.095 * k], [x + 0.085 * k, y - 0.055 * k], [x - 0.07 * k, y - 0.055 * k]], WHITE);
  g.circle(x - 0.1 * k, y + 0.035 * k, 0.04 * k, col, WHITE, 0.012 * k);
  g.circle(x + 0.1 * k, y + 0.035 * k, 0.04 * k, col, WHITE, 0.012 * k);
}
function truck(g: Pen, x: number, y: number, k: number): void {
  g.rect(x - 0.19 * k, y - 0.13 * k, 0.27 * k, 0.15 * k, BLACK, 0.01 * k);
  g.path([[x + 0.1 * k, y + 0.02 * k], [x + 0.1 * k, y - 0.09 * k], [x + 0.16 * k, y - 0.09 * k], [x + 0.2 * k, y - 0.03 * k], [x + 0.2 * k, y + 0.02 * k]], BLACK);
  for (const wx of [-0.13, -0.05, 0.13]) g.circle(x + wx * k, y + 0.04 * k, 0.035 * k, BLACK, WHITE, 0.01 * k);
}
function bus(g: Pen, x: number, y: number, k: number): void {
  g.rect(x - 0.2 * k, y - 0.13 * k, 0.4 * k, 0.16 * k, BLACK, 0.02 * k);
  for (let i = 0; i < 5; i++) g.rect(x + (-0.17 + i * 0.07) * k, y - 0.1 * k, 0.05 * k, 0.05 * k, WHITE);
  for (const wx of [-0.12, 0.12]) g.circle(x + wx * k, y + 0.04 * k, 0.035 * k, BLACK, WHITE, 0.01 * k);
}
function bicycle(g: Pen, x: number, y: number, k: number, col = BLACK): void {
  const lw = 0.022 * k;
  g.circle(x - 0.11 * k, y + 0.05 * k, 0.07 * k, undefined, col, lw);
  g.circle(x + 0.11 * k, y + 0.05 * k, 0.07 * k, undefined, col, lw);
  g.line([[x - 0.11 * k, y + 0.05 * k], [x - 0.01 * k, y + 0.05 * k], [x - 0.04 * k, y - 0.05 * k], [x - 0.11 * k, y + 0.05 * k]], col, lw);
  g.line([[x - 0.01 * k, y + 0.05 * k], [x + 0.07 * k, y - 0.05 * k], [x - 0.04 * k, y - 0.05 * k]], col, lw);
  g.line([[x + 0.07 * k, y - 0.05 * k], [x + 0.11 * k, y + 0.05 * k]], col, lw);
  g.line([[x + 0.06 * k, y - 0.08 * k], [x + 0.08 * k, y - 0.05 * k]], col, lw);
  g.line([[x - 0.07 * k, y - 0.07 * k], [x - 0.02 * k, y - 0.07 * k]], col, lw * 1.2);
}
function moped(g: Pen, x: number, y: number, k: number, col = BLACK): void {
  bicycle(g, x, y, k, col);
  g.rect(x - 0.05 * k, y - 0.01 * k, 0.06 * k, 0.05 * k, col, 0.01 * k);
}
function motorbike(g: Pen, x: number, y: number, k: number): void {
  g.circle(x - 0.12 * k, y + 0.05 * k, 0.06 * k, undefined, BLACK, 0.03 * k);
  g.circle(x + 0.12 * k, y + 0.05 * k, 0.06 * k, undefined, BLACK, 0.03 * k);
  g.path([[x - 0.12 * k, y + 0.03 * k], [x - 0.05 * k, y - 0.06 * k], [x + 0.06 * k, y - 0.06 * k], [x + 0.12 * k, y + 0.04 * k], [x + 0.02 * k, y + 0.03 * k]], BLACK);
}
function pedestrian(g: Pen, x: number, y: number, k: number, col = BLACK): void {
  const lw = 0.035 * k;
  g.circle(x + 0.01 * k, y - 0.15 * k, 0.035 * k, col);
  g.line([[x, y - 0.1 * k], [x - 0.01 * k, y + 0.02 * k]], col, lw);
  g.line([[x - 0.01 * k, y + 0.02 * k], [x - 0.06 * k, y + 0.15 * k]], col, lw);
  g.line([[x - 0.01 * k, y + 0.02 * k], [x + 0.05 * k, y + 0.14 * k]], col, lw);
  g.line([[x - 0.06 * k, y - 0.01 * k], [x, y - 0.08 * k], [x + 0.06 * k, y - 0.02 * k]], col, lw * 0.8);
}
function arrow(g: Pen, x: number, y: number, len: number, angle: number, col: string, lw: number): void {
  // angle 0 = up, PI/2 = right
  const dx = Math.sin(angle), dy = -Math.cos(angle);
  const tx = x + dx * len / 2, ty = y + dy * len / 2;
  const bx = x - dx * len / 2, by = y - dy * len / 2;
  g.line([[bx, by], [tx - dx * lw, ty - dy * lw]], col, lw, 'butt');
  const hw = lw * 1.6, hl = lw * 2.2;
  g.path([[tx + dx * lw * 0.4, ty + dy * lw * 0.4], [tx - dx * hl - dy * hw, ty - dy * hl + dx * hw], [tx - dx * hl + dy * hw, ty - dy * hl - dx * hw]], col);
}
function house(g: Pen, x: number, y: number, k: number, col: string): void {
  g.path([[x - 0.08 * k, y + 0.1 * k], [x - 0.08 * k, y - 0.02 * k], [x, y - 0.1 * k], [x + 0.08 * k, y - 0.02 * k], [x + 0.08 * k, y + 0.1 * k]], col);
}

// ------------------------------------------------------------------ sign shapes

function roundSign(fill: string, ring: string | null, inner?: Draw): SignDef {
  return {
    w: 0.6, h: 0.6, draw: (g) => {
      g.circle(0, 0, 0.3, ring ?? fill);
      g.circle(0, 0, ring ? 0.3 - 0.07 : 0.3 - 0.01, fill);
      if (ring === null) g.ring(0, 0, 0.3, 0.012, WHITE);
      inner?.(g);
    },
  };
}
function prohibition(inner?: Draw): SignDef {
  return roundSign(WHITE, RED, inner);
}
function triangle(down: boolean, inner?: Draw): SignDef {
  const side = 0.9, h = side * 0.866;
  return {
    w: side, h, draw: (g) => {
      const y0 = -h / 2, y1 = h / 2;
      const outer: [number, number][] = down ? [[-side / 2, y0], [side / 2, y0], [0, y1]] : [[0, y0], [side / 2, y1], [-side / 2, y1]];
      g.path(outer, RED, RED, 0.03);
      const k = 0.78;
      const cy = down ? y0 + h * 0.333 : y1 - h * 0.333;
      const innerPts = outer.map(([x, y]) => [x * k, cy + (y - cy) * k] as [number, number]);
      g.path(innerPts, WHITE, WHITE, 0.02);
      inner?.(g);
    },
  };
}
function rectSign(w: number, h: number, fill: string, border: string | null, inner?: Draw): SignDef {
  return {
    w, h, draw: (g) => {
      g.rect(-w / 2, -h / 2, w, h, border ?? fill, 0.03);
      if (border) g.rect(-w / 2 + 0.015, -h / 2 + 0.015, w - 0.03, h - 0.03, fill, 0.022);
      inner?.(g);
    },
  };
}

function speedSign(n: string, end: boolean): SignDef {
  if (end) {
    return roundSign(WHITE, null, (g) => {
      g.ring(0, 0, 0.3, 0.012, BLACK);
      g.text(n, 0, 0.01, 0.27, GREY);
      for (let i = -2; i <= 2; i++) g.line([[-0.19 + i * 0.03, 0.22 + i * 0.03], [0.22 + i * 0.03, -0.19 + i * 0.03]], BLACK, 0.008);
    });
  }
  return prohibition((g) => g.text(n, 0, 0.012, n.length > 2 ? 0.22 : 0.27, BLACK));
}

function signDef(code: string): SignDef {
  const m = /^([A-Z]+)(\d+)([A-Z]?)(?:-(\d+))?(?:-(ZB|ZE))?/.exec(code);
  const series = m?.[1] ?? '';
  const num = Number(m?.[2] ?? 0);
  const suffix = m?.[3] ?? '';
  const val = m?.[4] ?? '';
  const zone = m?.[5] ?? '';
  switch (series) {
    case 'A': {
      if (num === 1 || num === 2) {
        const v = val || '30';
        if (zone) {
          return rectSign(0.6, 0.85, WHITE, BLACK, (g) => {
            g.text('ZONE', 0, -0.3, 0.12, BLACK);
            g.circle(0, 0.08, 0.22, RED);
            g.circle(0, 0.08, 0.17, WHITE);
            g.text(v, 0, 0.09, 0.19, num === 2 ? GREY : BLACK);
            if (num === 2) g.line([[-0.2, 0.32], [0.2, -0.16]], BLACK, 0.025);
          });
        }
        return speedSign(v, num === 2);
      }
      if (num === 4 || num === 5) return rectSign(0.6, 0.6, BLUE, null, (g) => g.text(val || '50', 0, 0.01, 0.3, WHITE));
      return speedSign(val || '50', false);
    }
    case 'B': {
      if (num === 1 || num === 2) {
        const s = 0.42;
        return {
          w: 0.85, h: 0.85, draw: (g) => {
            g.path([[0, -s], [s, 0], [0, s], [-s, 0]], WHITE, BLACK, 0.012);
            g.path([[0, -s * 0.72], [s * 0.72, 0], [0, s * 0.72], [-s * 0.72, 0]], YELLOW);
            if (num === 2) for (let i = -2; i <= 2; i++) g.line([[-0.22 + i * 0.05, 0.22 + i * 0.05], [0.22 + i * 0.05, -0.22 + i * 0.05]], BLACK, 0.018, 'butt');
          },
        };
      }
      if (num === 6) return triangle(true);
      if (num === 7) {
        return {
          w: 0.6, h: 0.6, draw: (g) => {
            const pts: [number, number][] = [];
            for (let i = 0; i < 8; i++) {
              const a = Math.PI / 8 + (i * Math.PI) / 4;
              pts.push([Math.cos(a) * 0.3, Math.sin(a) * 0.3]);
            }
            g.path(pts, WHITE);
            g.path(pts.map(([x, y]) => [x * 0.93, y * 0.93] as [number, number]), RED);
            g.text('STOP', 0, 0.01, 0.16, WHITE);
          },
        };
      }
      // B3/B4/B5: priority crossing
      return triangle(false, (g) => {
        g.line([[0, -0.14], [0, 0.26]], BLACK, 0.07, 'butt');
        if (num !== 5) g.line([[-0.16, 0.06], [0, 0.06]], BLACK, 0.03, 'butt');
        if (num !== 4) g.line([[0, 0.06], [0.16, 0.06]], BLACK, 0.03, 'butt');
      });
    }
    case 'C': {
      if (num === 1) return prohibition();
      if (num === 2) return roundSign(RED, null, (g) => g.rect(-0.2, -0.05, 0.4, 0.1, WHITE));
      if (num === 3) return rectSign(0.8, 0.4, BLUE, WHITE, (g) => arrow(g, 0, 0, 0.6, Math.PI / 2, WHITE, 0.07));
      if (num === 4) return rectSign(0.4, 0.8, BLUE, WHITE, (g) => arrow(g, 0, 0, 0.6, 0, WHITE, 0.07));
      if (num === 5) return rectSign(0.6, 0.6, BLUE, WHITE, (g) => arrow(g, 0, 0, 0.42, 0, WHITE, 0.08));
      if (num === 6) return prohibition((g) => car(g, 0, 0.01, 1.05));
      if (num === 7) {
        if (suffix === 'A') return prohibition((g) => bus(g, 0, 0.02, 1));
        return prohibition((g) => truck(g, 0, 0.02, 1));
      }
      if (num === 11) return prohibition((g) => motorbike(g, 0, 0.0, 1));
      if (num === 12) return prohibition((g) => { car(g, 0, -0.07, 0.8); motorbike(g, 0, 0.11, 0.7); });
      if (num === 13) return prohibition((g) => moped(g, 0, 0.02, 1.2));
      if (num === 14) return prohibition((g) => bicycle(g, 0, 0.02, 1.25));
      if (num === 15) return prohibition((g) => { bicycle(g, 0, -0.07, 0.9); moped(g, 0, 0.11, 0.9); });
      if (num === 16) return prohibition((g) => pedestrian(g, 0, 0.02, 1.1));
      if (num >= 17 && num <= 21) {
        const lbl = val ? (num >= 20 ? `${val}t` : `${(Number(val) / (Number(val) > 50 ? 10 : 1)).toString()}m`) : num >= 20 ? '10t' : '3.5m';
        return prohibition((g) => g.text(lbl, 0, 0.01, 0.15, BLACK));
      }
      if (num === 22) return prohibition((g) => { g.rect(-0.14, -0.08, 0.28, 0.16, '#e86a00'); g.text(suffix === 'E' ? 'Milieu' : 'GS', 0, 0.0, 0.08, BLACK); });
      return prohibition((g) => car(g, 0, 0.01, 1.05));
    }
    case 'D': {
      const ang = [0, Math.PI * 0.75, Math.PI * 0.75, 0, Math.PI / 2, -Math.PI / 2, 0, 0][num] ?? 0;
      return roundSign(BLUE, null, (g) => {
        if (num === 1) {
          for (let i = 0; i < 3; i++) {
            const a = (i * Math.PI * 2) / 3;
            arrow(g, Math.sin(a) * 0.15, -Math.cos(a) * 0.15, 0.14, a + Math.PI / 2, WHITE, 0.045);
          }
        } else if (num === 3) {
          arrow(g, -0.07, 0.02, 0.32, Math.PI * 1.25, WHITE, 0.05);
          arrow(g, 0.07, 0.02, 0.32, Math.PI * 0.75, WHITE, 0.05);
        } else if (num === 6 || num === 7) {
          arrow(g, 0, 0.02, 0.36, 0, WHITE, 0.055);
          arrow(g, 0.06, 0.06, 0.2, num === 6 ? Math.PI / 2 : -Math.PI / 2, WHITE, 0.05);
        } else arrow(g, 0, 0, 0.38, ang, WHITE, 0.07);
      });
    }
    case 'E': {
      if (num === 1 || num === 2 || num === 3) {
        return roundSign(BLUE, RED, (g) => {
          g.line([[-0.17, -0.17], [0.17, 0.17]], RED, 0.06, 'butt');
          if (num === 2) g.line([[-0.17, 0.17], [0.17, -0.17]], RED, 0.06, 'butt');
        });
      }
      const extra: Record<number, string> = { 5: 'TAXI', 7: '', 9: 'vergunning' };
      return rectSign(0.6, 0.6, BLUE, WHITE, (g) => {
        g.text('P', 0, num === 4 ? 0.0 : -0.06, num === 4 ? 0.42 : 0.3, WHITE, 800);
        if (num === 6) g.text('♿', 0, 0.17, 0.14, WHITE);
        else if (num !== 4 && extra[num]) g.text(extra[num], 0, 0.18, 0.08, WHITE, 600, 0.5);
        else if (num === 8 || num === 7) car(g, 0, 0.18, 0.7, WHITE);
      });
    }
    case 'F': {
      if (num === 5 || num === 6) {
        return (num === 5 ? (inner: Draw) => roundSign(WHITE, RED, inner) : (inner: Draw) => rectSign(0.6, 0.6, BLUE, WHITE, inner))((g) => {
          arrow(g, -0.08, 0, 0.32, 0, num === 5 ? BLACK : WHITE, 0.05);
          arrow(g, 0.08, 0, 0.32, Math.PI, RED, 0.05);
        });
      }
      if (num === 7) return prohibition((g) => g.line([[0.08, 0.15], [0.08, -0.05], [-0.08, -0.05], [-0.08, 0.12]], BLACK, 0.045));
      return prohibition((g) => { car(g, -0.08, 0.0, 0.7, RED); car(g, 0.09, 0.0, 0.7, BLACK); });
    }
    case 'G': {
      if (num === 5 || num === 6) {
        return rectSign(0.9, 0.6, BLUE, WHITE, (g) => {
          house(g, -0.25, -0.02, 1.6, WHITE);
          house(g, -0.08, -0.04, 1.9, WHITE);
          pedestrian(g, 0.1, 0.06, 0.8, WHITE);
          g.circle(0.2, 0.12, 0.03, WHITE);
          car(g, 0.28, 0.17, 0.5, WHITE);
          g.rect(-0.43, 0.2, 0.86, 0.02, WHITE);
          if (num === 6) g.line([[-0.4, 0.26], [0.4, -0.26]], RED, 0.04);
        });
      }
      if (num === 7 || num === 8) return roundSign(BLUE, null, (g) => { pedestrian(g, 0, 0.02, 1.15, WHITE); if (num === 8) g.line([[-0.2, 0.2], [0.2, -0.2]], RED, 0.04); });
      if (num === 9 || num === 10) return roundSign(BLUE, null, (g) => g.text('R', 0, 0, 0.3, WHITE));
      if (num === 11 || num === 12) {
        return roundSign(BLUE, null, (g) => {
          if (suffix === 'A' || suffix === 'B') { bicycle(g, 0, -0.08, 0.9, WHITE); moped(g, 0, 0.11, 0.9, WHITE); }
          else bicycle(g, 0, 0.02, 1.3, WHITE);
          if (num === 12 && suffix !== 'A') g.line([[-0.2, 0.2], [0.2, -0.2]], RED, 0.04);
        });
      }
      if (num === 13 || num === 14) return rectSign(0.6, 0.3, BLACK, null, (g) => { g.rect(-0.28, -0.13, 0.56, 0.26, BLUE, 0.02); g.text('fietspad', 0, 0.005, 0.1, WHITE, 600); });
      return rectSign(0.8, 0.5, BLUE, WHITE, (g) => g.text(code, 0, 0, 0.14, WHITE));
    }
    case 'H':
      return rectSign(1.2, 0.5, BLUE, WHITE, (g) => { g.text('Alkmaar', 0, -0.04, 0.2, WHITE, 600); g.text('Gem. Alkmaar', 0, 0.15, 0.07, WHITE, 500); });
    case 'J': {
      return triangle(false, (g) => {
        if (num === 24 || num === 25) pedestrian(g, 0, 0.08, 1.05);
        else if (num === 26) bicycle(g, 0, 0.12, 1.0);
        else if (num === 22 || num === 23) { pedestrian(g, -0.07, 0.1, 0.8); pedestrian(g, 0.07, 0.12, 0.65); }
        else if (num === 3 || num === 4) {
          g.rect(-0.03, -0.12, 0.06, 0.06, RED, 0.01); g.rect(-0.03, -0.04, 0.06, 0.06, '#e7a400', 0.01); g.rect(-0.03, 0.04, 0.06, 0.06, '#1a8a3a', 0.01);
        } else if (num === 1) g.line([[0, 0.24], [0, 0.05], [0.04, -0.02], [0.04, -0.12]], BLACK, 0.035);
        else {
          g.line([[0, -0.1], [0, 0.12]], BLACK, 0.05, 'butt');
          g.circle(0, 0.22, 0.03, BLACK);
        }
      });
    }
    case 'L': {
      if (num === 2) {
        return rectSign(0.6, 0.6, BLUE, WHITE, (g) => {
          g.path([[0, -0.24], [0.22, 0.18], [-0.22, 0.18]], WHITE);
          for (let i = 0; i < 4; i++) g.rect(-0.18 + i * 0.1, 0.12, 0.06, 0.04, BLACK);
          pedestrian(g, 0.01, 0.0, 0.85);
        });
      }
      if (num === 8) {
        return rectSign(0.6, 0.6, BLUE, WHITE, (g) => {
          g.line([[0, 0.24], [0, -0.1]], WHITE, 0.09, 'butt');
          g.rect(-0.16, -0.2, 0.32, 0.09, RED);
        });
      }
      return rectSign(0.6, 0.6, BLUE, WHITE, (g) => g.text('i', 0, 0, 0.36, WHITE, 800));
    }
    case 'OB':
      return rectSign(0.6, 0.25, WHITE, BLACK, (g) => g.text(val ? `${val} m` : 'uitgezonderd', 0, 0.005, 0.08, BLACK, 600, 0.52));
    default:
      return rectSign(0.6, 0.3, WHITE, BLACK, (g) => g.text(code.slice(0, 10), 0, 0.005, 0.1, BLACK, 600, 0.52));
  }
}

export interface SignAtlas {
  texture: THREE.DataTexture;
  layouts: Map<string, SignLayout>;
}

/** Draw all unique (normalised) codes into one atlas. */
export function renderSignAtlas(codes: Iterable<string>, anisotropy = 4): SignAtlas {
  const unique = [...new Set([...codes].map(normalizeSignCode))];
  if (!unique.length) unique.push('C2');
  const CELL = unique.length > 64 ? 128 : 256;
  const cols = Math.min(8, unique.length);
  const rows = Math.ceil(unique.length / cols);
  const W = cols * CELL, H = rows * CELL;
  const { canvas, ctx } = makeCanvas(W, H);
  const layouts = new Map<string, SignLayout>();
  unique.forEach((code, i) => {
    const def = signDef(code);
    const cx = (i % cols) * CELL + CELL / 2;
    const cy = Math.floor(i / cols) * CELL + CELL / 2;
    const big = Math.max(def.w, def.h);
    const s = (CELL * 0.96) / big; // px per metre
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - CELL / 2, cy - CELL / 2, CELL, CELL);
    ctx.clip();
    def.draw(new Pen(ctx, cx, cy, s));
    ctx.restore();
    const pw = def.w * s, ph = def.h * s;
    const u0 = (cx - pw / 2) / W, du = pw / W;
    const v0 = 1 - (cy + ph / 2) / H, dv = ph / H;
    layouts.set(code, { w: def.w, h: def.h, uv: [u0, v0, du, dv] });
  });
  const texture = canvasToTexture(canvas, { bleed: 'auto', srgb: true, anisotropy });
  texture.name = 'verkeersborden';
  return { texture, layouts };
}

// ---------------------------------------------------------------------------------------------
// Street-name plates
// ---------------------------------------------------------------------------------------------

export interface PlateLayout {
  page: number;
  /** plate width in metres (height is PLATE_H) */
  w: number;
  uv: [number, number, number, number];
}

export const PLATE_H = 0.22;

export interface StreetNameAtlas {
  pages: THREE.DataTexture[];
  layouts: Map<string, PlateLayout>;
}

export function renderStreetNameAtlas(names: Iterable<string>, anisotropy = 4): StreetNameAtlas {
  const unique = [...new Set([...names].map((n) => String(n ?? '').trim()).filter(Boolean))];
  const PH = 80; // plate height in px
  const PAGE_W = 2048;
  const fontPx = 44;
  const font = `600 ${fontPx}px ${FONT}`;
  const measure = makeCanvas(8, 8).ctx;
  measure.font = font;
  try { (measure as unknown as { fontStretch: string }).fontStretch = 'semi-condensed'; } catch { /* optional */ }
  const items = unique.map((name) => {
    const tw = measure.measureText(name).width;
    return { name, pw: Math.max(200, Math.ceil(tw + 64)) };
  });
  // shelf packing into pages
  const placed: { name: string; page: number; x: number; y: number; pw: number }[] = [];
  let page = 0, x = 0, y = 0, maxY = 0;
  const pageHeights: number[] = [];
  const PAGE_H = 2048;
  for (const it of items) {
    if (x + it.pw > PAGE_W) { x = 0; y += PH + 4; }
    if (y + PH > PAGE_H) { pageHeights[page] = maxY; page++; x = 0; y = 0; maxY = 0; }
    placed.push({ name: it.name, page, x, y, pw: it.pw });
    x += it.pw + 4;
    maxY = Math.max(maxY, y + PH);
  }
  pageHeights[page] = maxY;
  const pages: THREE.DataTexture[] = [];
  const layouts = new Map<string, PlateLayout>();
  for (let p = 0; p <= page && items.length; p++) {
    const H = Math.max(PH, Math.pow(2, Math.ceil(Math.log2(pageHeights[p] || PH))));
    const { canvas, ctx } = makeCanvas(PAGE_W, H);
    for (const it of placed.filter((q) => q.page === p)) {
      // plate: blue enamel, white inset border, white text
      ctx.fillStyle = '#123f8a';
      ctx.beginPath();
      ctx.roundRect(it.x, it.y, it.pw, PH, 6);
      ctx.fill();
      ctx.strokeStyle = '#f4f4f0';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(it.x + 7, it.y + 7, it.pw - 14, PH - 14, 5);
      ctx.stroke();
      ctx.font = font;
      try { (ctx as unknown as { fontStretch: string }).fontStretch = 'semi-condensed'; } catch { /* optional */ }
      ctx.fillStyle = '#f7f7f3';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(it.name, it.x + it.pw / 2, it.y + PH / 2 + 2, it.pw - 40);
      layouts.set(it.name, {
        page: p,
        w: (it.pw / PH) * PLATE_H,
        uv: [it.x / PAGE_W, 1 - (it.y + PH) / H, it.pw / PAGE_W, PH / H],
      });
    }
    const tex = canvasToTexture(canvas, { srgb: true, anisotropy, bleed: [18, 63, 138] });
    tex.name = `straatnamen_${p}`;
    pages.push(tex);
  }
  return { pages, layouts };
}
