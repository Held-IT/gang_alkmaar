// 'wall' material: Dutch brick facades with procedural windows (see docs/ARCHITECTURE.md 4.2).
//
// Vertex attributes (from the BAG pipeline):
//   uv  (TEXCOORD_0) = (u along the wall polygon in metres, starting at 0 at one end; v = height)
//   uv1 (TEXCOORD_1) = (facadeWidth, eaveHeight) of the wall polygon
//   color (COLOR_0)  = (seed, kind 0/0.5/1, age class 0/.33/.66/1, floor height hint)
//
// Everything is computed analytically per pixel with box-filtered coverage (adBox/adBoxP) so the
// window pattern is anti-aliased and fades to its average at distance instead of shimmering.
import * as THREE from 'three';
import { patchSurface } from './shaderLib';
import type { TextureSet } from './textures';

// ------------------------------------------------------------------------------------------------
// Shop signs: fictional Dutch shop names per interior archetype (no real brands), rendered once into
// a single-channel canvas atlas (one row per name). The shader picks the archetype per building and a
// name of that archetype, so the sign matches what is behind the glass.
// ------------------------------------------------------------------------------------------------
/** Archetypes in shader order: 0 shelves, 1 clothing, 2 cafe, 3 bakery, 4 cheese/deli, 5 florist, 6 vacant. */
const SHOP_NAMES: readonly (readonly string[])[] = [
  ['Boekhandel De Zwaan', 'Drogisterij Kok', 'Speelgoed Het Kasteel', 'Tabak & Lectuur', 'Cadeau & Wonen', 'Opticien Bos'],
  ['Modehuis Smit', 'Schoenen Mulder', 'Damesmode Lotte', 'Herenmode Van Dijk'],
  ['Eetcafé De Gracht', 'Lunchroom De Kade', "Café 't Hoekje", 'IJssalon Venezia'],
  ['Bakkerij Van Dam', 'Banketbakkerij Hoek', 'Brood & Banket'],
  ['Kaashandel De Jong', 'Kaas & Noten', 'Delicatessen Meijer'],
  ['Bloemen Bakker', 'Bloemenhuis Flora'],
  ['TE HUUR'],
];
const SIGN_LIST = SHOP_NAMES.flat();
const SIGN_ROWS = SIGN_LIST.length;
/** Atlas row: 1024 x 64 px (text ~44 px high, centred). */
const SIGN_W = 1024;
const SIGN_ROW_H = 64;
const SIGN_FONTS = [
  'bold 44px Georgia, "Times New Roman", serif',
  'italic bold 44px Georgia, "Times New Roman", serif',
  'bold 42px "Trebuchet MS", "Segoe UI", Arial, sans-serif',
  '600 44px "Segoe UI", Arial, sans-serif',
  'bold 44px "Times New Roman", Georgia, serif',
  'bold 40px Verdana, "Segoe UI", sans-serif',
];
const SIGN_GLSL = (() => {
  const start: number[] = [];
  let n = 0;
  for (const g of SHOP_NAMES) { start.push(n); n += g.length; }
  return `#define SIGN_ROWS ${SIGN_ROWS}
#define SIGN_ASPECT ${(SIGN_W / SIGN_ROW_H).toFixed(1)}
const int SIGN_START[${SHOP_NAMES.length}] = int[${SHOP_NAMES.length}](${start.join(', ')});
const int SIGN_NUM[${SHOP_NAMES.length}] = int[${SHOP_NAMES.length}](${SHOP_NAMES.map((g) => g.length).join(', ')});`;
})();

/** Renders the name atlas (R8, mipmapped) and the half text width of every row (fraction of SIGN_W). */
function createSignAtlas(): { texture: THREE.Texture; halfWidths: number[] } {
  const halfWidths: number[] = [];
  const h = SIGN_ROW_H * SIGN_ROWS;
  const data = new Uint8Array(SIGN_W * h);
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null;
  if (canvas && ctx) {
    canvas.width = SIGN_W;
    canvas.height = h;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIGN_W, h);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    SIGN_LIST.forEach((name, i) => {
      const vacant = name === 'TE HUUR';
      ctx.font = vacant ? 'bold 46px Arial, "Segoe UI", sans-serif' : SIGN_FONTS[i % SIGN_FONTS.length];
      const text = !vacant && i % 3 === 1 ? name.toUpperCase() : name;
      const maxW = SIGN_W - 24;
      const w = Math.min(maxW, ctx.measureText(text).width);
      ctx.fillText(text, SIGN_W / 2, i * SIGN_ROW_H + SIGN_ROW_H / 2 + 2, maxW);
      halfWidths.push((w / 2 + 8) / SIGN_W);
    });
    const img = ctx.getImageData(0, 0, SIGN_W, h).data;
    for (let i = 0; i < data.length; i++) data[i] = img[i * 4];
  } else {
    for (let i = 0; i < SIGN_ROWS; i++) halfWidths.push(0.25);
  }
  const tex = new THREE.DataTexture(data, SIGN_W, h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.name = 'shop-signs';
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return { texture: tex, halfWidths };
}

const FACADE_PARS = /* glsl */ `
uniform sampler2D tBrickA;
uniform sampler2D tBrickAN;
uniform sampler2D tBrickAArm;
uniform sampler2D tBrickB;
uniform sampler2D tBrickBN;
uniform sampler2D tBrickBArm;
uniform sampler2D tPlaster;
uniform sampler2D tPlasterN;
${SIGN_GLSL}
uniform sampler2D tSigns;
uniform float uSignHalfW[SIGN_ROWS];
uniform float uBrickAM;
uniform float uBrickBM;
uniform float uPlasterM;
uniform float uLit;          // 0 = day, 1 = night (interior lights)

// per-building random number i
#define BH(i) adHash11(seed * 91.37 + (i) * 17.13)

const vec3 BRICK_TINTS[6] = vec3[6](
  vec3(0.90, 0.86, 0.86),   // red-brown (texture is graded to Dutch red-brown)
  vec3(0.74, 0.66, 0.70),   // darker purple-brown
  vec3(1.00, 0.90, 0.82),   // warmer orange-red
  vec3(0.60, 0.56, 0.55),   // dark brown
  vec3(0.84, 0.80, 0.80),   // muted
  vec3(0.80, 0.68, 0.66)    // deep red
);
const vec3 PLASTER_COLS[5] = vec3[5](
  vec3(0.80, 0.80, 0.78),   // white
  vec3(0.78, 0.74, 0.64),   // cream
  vec3(0.62, 0.64, 0.64),   // light grey
  vec3(0.82, 0.80, 0.74),   // off-white
  vec3(0.70, 0.66, 0.56)    // sand
);
const vec3 DOOR_COLS[6] = vec3[6](
  vec3(0.010, 0.045, 0.025), // dark green
  vec3(0.012, 0.012, 0.014), // black
  vec3(0.090, 0.012, 0.010), // ox-blood red
  vec3(0.010, 0.020, 0.060), // dark blue
  vec3(0.110, 0.050, 0.020), // varnished wood
  vec3(0.030, 0.060, 0.060)  // petrol
);
const vec3 SHOP_COLS[6] = vec3[6](
  vec3(0.012, 0.012, 0.013), // black
  vec3(0.010, 0.040, 0.022), // dark green
  vec3(0.035, 0.037, 0.040), // anthracite
  vec3(0.008, 0.018, 0.055), // navy
  vec3(0.070, 0.010, 0.012), // bordeaux
  vec3(0.300, 0.290, 0.260)  // light grey
);

// Glazing bars: coverage of pane interiors for a cols x rows grid inside [g0,g1].
float adPanes(vec2 p, vec2 g0, vec2 g1, vec2 grid, float bt, vec2 fw) {
  vec2 gs = (g1 - g0) / grid;
  vec2 q = (p - g0) / gs;
  vec2 qf = fract(q) * gs;
  return adBoxP(qf.x, 0.5 * bt, gs.x - 0.5 * bt, fw.x, gs.x) * adBoxP(qf.y, 0.5 * bt, gs.y - 0.5 * bt, fw.y, gs.y);
}

// Interior mapping: a box-shaped room behind a window, ray-traced analytically.
//   p   = point on the glass in facade metres (x along u, y up; floor of the room at y = 0)
//   d   = view direction in facade space (x along +u, y up, z into the wall, d.z > 0)
//   room spans [r0.x, r1.x] x [0, r1.y] x [0, D]
// Returns the albedo of the surface hit; depth01 = hit depth / D; hitKind 0 back, 1 side, 2 floor, 3 ceiling.
vec3 adRoom(vec2 p, vec3 d, float rx0, float rx1, float rh, float D, vec3 wallC, vec3 floorC,
            out float depth01, out int hitKind, out vec2 hitXY) {
  vec3 dd = vec3(abs(d.x) < 1.0e-4 ? 1.0e-4 : d.x, abs(d.y) < 1.0e-4 ? 1.0e-4 : d.y, max(d.z, 0.02));
  float tx = ((dd.x > 0.0 ? rx1 : rx0) - p.x) / dd.x;
  float ty = ((dd.y > 0.0 ? rh : 0.0) - p.y) / dd.y;
  float tz = D / dd.z;
  float t = min(min(tx, ty), tz);
  vec3 h = vec3(p, 0.0) + dd * t;
  depth01 = clamp(h.z / D, 0.0, 1.0);
  hitXY = h.xy;
  vec3 c;
  if (t == tz) { hitKind = 0; c = wallC; }
  else if (t == tx) { hitKind = 1; c = wallC * 0.82; hitXY = h.zy; }
  else if (dd.y < 0.0) { hitKind = 2; c = floorC * (0.85 + 0.15 * step(0.5, fract(h.x * 6.0))); hitXY = h.xz; }
  else { hitKind = 3; c = vec3(0.55, 0.54, 0.52); hitXY = h.xz; }
  return c;
}

// Shop sign text: coverage of atlas row "row" (white-on-black canvas atlas of fictional Dutch shop
// names, see createSignAtlas), centred at (cx, cy) on the wall with a row height of rowH metres.
// Gradients come from the uv derivatives taken in uniform control flow (dx/dy = d(u,v)/dscreen).
float adSignText(float u, float v, float cx, float cy, float rowH, int row, float tSign, vec2 dx, vec2 dy) {
  float rowW = SIGN_ASPECT * rowH;
  vec2 l = vec2((u - cx) / rowW, (v - cy) / rowH);
  if (abs(l.x) > 0.5 || abs(l.y) > 0.5) return 0.0;
  vec2 auv = vec2(0.5 + tSign * l.x, (float(row) + 0.5 - l.y) / float(SIGN_ROWS));
  vec2 sc = vec2(tSign / rowW, -1.0 / (rowH * float(SIGN_ROWS)));
  return textureGrad(tSigns, auv, dx * sc, dy * sc).r;
}
`;

const FACADE_SURFACE = /* glsl */ `
  float u = vAdUv.x;
  float v = vAdUv.y;
  float W = vAdUv1.x;
  float eave = vAdUv1.y;
  float seed = vAdAttr.r;
  float kind = vAdAttr.g;
  float age = vAdAttr.b;
  float floorH = clamp(2.5 + vAdAttr.a * 2.0, 2.5, 4.5);
  if (eave < 0.5) eave = 1.0e4;
  // contract: u runs 0..W along the wall polygon. If a pipeline delivers a running u instead,
  // fall back to a periodic layout (windows stay whole, only their phase is arbitrary).
  if (W > 0.5 && (u < -0.05 || u > W + 0.05)) u = mod(u, W);
  vec3 wp = vAdWorldPos;

  // filter width in metres per pixel (for analytic anti-aliasing)
  vec2 fw = vec2(length(vec2(dFdx(u), dFdy(u))), length(vec2(dFdx(v), dFdy(v))));
  fw = clamp(fw, vec2(1.0e-4), vec2(40.0));
  vec2 dUVx = vec2(dFdx(u), dFdx(v));
  vec2 dUVy = vec2(dFdy(u), dFdy(v));

  // view direction in facade space (x along +u, y up, z into the wall) for interior mapping;
  // the sign of the horizontal tangent is recovered from the uv derivatives
  vec3 Nf = normalize(vAdWorldNormal);
  vec3 Th = normalize(cross(vec3(0.0, 1.0, 0.0), Nf) + vec3(1.0e-5, 0.0, 0.0));
  vec3 dpx = dFdx(vAdWorldPos);
  vec3 dpy = dFdy(vAdWorldPos);
  float tSign = dot(Th, dpx) * dFdx(vAdUv.x) + dot(Th, dpy) * dFdy(vAdUv.x) < 0.0 ? -1.0 : 1.0;
  vec3 Vw = normalize(vAdWorldPos - cameraPosition);
  vec3 vdir = vec3(dot(Vw, Th) * tSign, Vw.y, -dot(Vw, Nf));

  bool landmark = kind > 0.75;
  bool party = kind > 0.25 && !landmark;
  bool street = !party && !landmark;
  int era = age < 0.17 ? 0 : (age < 0.5 ? 1 : (age < 0.83 ? 2 : 3));

  // ------------------------------------------------------------------ wall base material
  // wallType: 0 brick A, 1 brick B (darker), 2 plaster, 3 painted brick, 4 smooth sandstone (unused:
  // landmarks are always brick; Gothic churches and the Waag are red-brown brick with stone details)
  float hT = BH(1.0);
  int wallType = BH(3.0) < 0.55 ? 0 : 1;
  if (landmark) wallType = BH(2.5) < 0.35 ? 1 : 0;
  else if (hT < 0.075) wallType = 2;
  else if (hT < 0.15) wallType = 3;
  vec2 wuv = vec2(u + BH(4.0) * 37.0, v);           // random horizontal offset per building
  vec2 dWx = dFdx(wuv);
  vec2 dWy = dFdy(wuv);
  vec3 wc; vec3 wn; vec3 warm;
  if (wallType == 1) {
    vec2 t = wuv / uBrickBM;
    wc = textureGrad(tBrickB, t, dWx / uBrickBM, dWy / uBrickBM).rgb;
    wn = textureGrad(tBrickBN, t, dWx / uBrickBM, dWy / uBrickBM).rgb * 2.0 - 1.0;
    warm = textureGrad(tBrickBArm, t, dWx / uBrickBM, dWy / uBrickBM).rgb;
  } else if (wallType == 2 || wallType == 4) {
    vec2 t = wuv / uPlasterM;
    float l = adLuma(textureGrad(tPlaster, t, dWx / uPlasterM, dWy / uPlasterM).rgb);
    wn = textureGrad(tPlasterN, t, dWx / uPlasterM, dWy / uPlasterM).rgb * 2.0 - 1.0;
    wn.xy *= 0.6;
    warm = vec3(1.0, 0.82 + (l - 0.75) * 0.6, 0.0);
    wc = vec3(max(0.2, 1.0 + (l - 0.66) * 2.2));
  } else {
    vec2 t = wuv / uBrickAM;
    wc = textureGrad(tBrickA, t, dWx / uBrickAM, dWy / uBrickAM).rgb;
    wn = textureGrad(tBrickAN, t, dWx / uBrickAM, dWy / uBrickAM).rgb * 2.0 - 1.0;
    warm = textureGrad(tBrickAArm, t, dWx / uBrickAM, dWy / uBrickAM).rgb;
  }
  vec3 wallA;
  float wallR = clamp(warm.g + 0.3, 0.0, 1.0);
  if (wallType == 2) {
    wallA = wc * PLASTER_COLS[int(BH(5.0) * 4.99)];
    wallR = 0.88;
  } else if (wallType == 4) {
    wallA = wc * vec3(0.62, 0.55, 0.42);
    wallR = 0.85;
  } else if (wallType == 3) {
    float l = adLuma(wc);
    wallA = PLASTER_COLS[int(BH(5.0) * 2.99)] * (0.82 + 0.5 * (l - 0.12));
    wallR = 0.82;
    wn.xy *= 0.8;
  } else {
    float tk = BH(6.0);
    // landmarks: only the red-brown / orange-red / deep red tones (Gothic 'kloostermoppen')
    wallA = wc * (landmark ? (tk < 0.4 ? BRICK_TINTS[0] : (tk < 0.7 ? BRICK_TINTS[2] : BRICK_TINTS[5]))
                           : BRICK_TINTS[int(tk * 5.99)]);
    // per-building brightness jitter + modern bricks a bit more uniform/brown
    wallA *= landmark ? 0.92 + 0.16 * BH(7.0) : 0.85 + 0.3 * BH(7.0);
    if (era >= 2 && !landmark) wallA = mix(wallA, vec3(adLuma(wallA)) * vec3(1.25, 1.0, 0.82), 0.25);
  }
  if (party) wallA *= 0.85;
  if (wallType == 2 || wallType == 3) {
    // painted / plastered walls: soft vertical rain streaks and patchy repainting
    vec4 ms = adMacro(vec2(u * 2.5 + seed * 9.0, v * 0.12), 6.0);
    wallA *= 1.0 - 0.16 * smoothstep(0.55, 0.85, ms.r);
    wallA *= 0.93 + 0.07 * ms.g;
  }

  // large-scale weathering / staining
  vec4 mW = adMacro(vec2(u * 0.8 + seed * 50.0, v), 13.0);
  wallA *= 0.88 + 0.24 * mW.r;
  float wallAO = mix(1.0, warm.r, 0.8);

  vec3 A = wallA;
  float R = wallR;
  vec3 N = normalize(wn);
  float AO = wallAO;
  vec3 E = vec3(0.0);
  float glassM = 0.0;
  float metal = 0.0;

  // ------------------------------------------------------------------ procedural facade layout
  bool windows = street && W >= 1.6 && eave >= 2.4;
  if (windows) {
    float groundH = era <= 1 ? max(3.3, floorH * 1.12) : max(2.8, floorH * 1.04);
    float topLimit = eave - (era <= 1 ? 0.45 : 0.3);
    float bayT = era == 0 ? 1.6 : (era == 1 ? 1.85 : (era == 2 ? 2.6 : 3.1));
    float nb = max(1.0, floor(W / bayT + 0.5));
    float bw = W / nb;
    float ib = clamp(floor(u / bw), 0.0, nb - 1.0);
    float ub = u - ib * bw;
    float ww = era == 0 ? min(1.02, bw * 0.62) : (era == 1 ? min(1.25, bw * 0.6) : (era == 2 ? min(1.9, bw * 0.7) : min(2.6, bw * 0.8)));
    if (nb < 1.5) ww = min(ww, W - 0.8);
    float wx0 = 0.5 * bw - 0.5 * ww;
    float wx1 = 0.5 * bw + 0.5 * ww;

    // building-level choices
    vec3 frameCol = era <= 1 ? (BH(8.0) < 0.82 ? vec3(0.78, 0.78, 0.75) : vec3(0.70, 0.64, 0.50))
                             : (BH(8.0) < 0.45 ? vec3(0.78, 0.78, 0.76) : (BH(8.0) < 0.75 ? vec3(0.03, 0.03, 0.032) : vec3(0.09, 0.045, 0.025)));
    if (era <= 1 && BH(8.5) < 0.08) frameCol = vec3(0.02, 0.07, 0.04);
    float ft = era <= 1 ? 0.075 : 0.055;
    bool shutters = era == 0 && BH(9.0) < 0.35;
    vec3 shutterCol = BH(9.5) < 0.55 ? vec3(0.02, 0.075, 0.04) : (BH(9.5) < 0.8 ? vec3(0.012) : vec3(0.12, 0.012, 0.01));
    bool shutterDiag = BH(9.7) < 0.5;
    bool stoneLintel = BH(10.0) < 0.4;
    bool shop = W >= 3.4 && BH(11.0) < (era <= 1 ? 0.6 : (era == 2 ? 0.35 : 0.25));
    vec3 doorCol = DOOR_COLS[int(BH(12.0) * 5.99)];
    vec3 shopCol = SHOP_COLS[int(BH(13.0) * 5.99)];
    float doorBay = BH(14.0) < 0.5 ? 0.0 : nb - 1.0;
    bool cornice = era <= 1 && BH(15.0) < 0.65 && eave < 1.0e3;
    // 17th-c. Dutch Renaissance details on old brick houses: relieving arches with alternating
    // white stone blocks above the windows, and white stone bands (speklagen) at sill/head level
    bool brickish = wallType < 2;
    bool arches = era == 0 && brickish && BH(22.0) < 0.55;
    bool bands = era == 0 && brickish && BH(24.0) < 0.5;
    bool whiteTymp = BH(23.0) < 0.25;

    // per-floor window rectangle (local metres within the bay / floor)
    bool inGround = v < groundH;
    float fi = floor((v - groundH) / floorH);
    float vf = v - groundH - fi * floorH;
    float nFloors = floor((topLimit - groundH) / floorH + 0.12);
    float floorTop = min(floorH, topLimit - groundH - fi * floorH);
    float sill = era == 0 ? 0.72 : (era == 1 ? 0.82 : (era == 2 ? 0.9 : 0.55));
    float head = floorTop - (era == 0 ? 0.38 + 0.1 * fi : 0.42);
    vec2 p = vec2(ub, vf);
    vec2 lo = vec2(wx0, sill);
    vec2 hi = vec2(wx1, head);
    bool upper = !inGround && fi >= 0.0 && fi < nFloors && head - sill > 0.75;

    int style = era == 0 ? (bw > 1.3 ? 0 : 5) : (era == 1 ? (BH(16.0) < 0.5 ? 1 : 2) : (era == 2 ? 3 : 4));
    bool drawWin = upper;
    float winId = ib + fi * 7.0;

    // ground floor: house (windows + door) or shop front
    if (inGround && v >= 0.0) {
      if (shop) {
        drawWin = false;
        vec2 pg = vec2(u, v);
        float x0 = 0.3, x1 = W - 0.3;
        float plinth = 0.45;
        float signLo = groundH - 0.85, signHi = groundH - 0.22;
        float glassHi = signLo - 0.08;
        // dark frame around the whole front
        float front = adRect(pg, vec2(x0, 0.0), vec2(x1, signHi), fw);
        A = mix(A, shopCol, front); R = mix(R, 0.45, front); N = mix(N, vec3(0.0, 0.0, 1.0), front); AO = mix(AO, 1.0, front);
        // display windows with mullions every ~1.8 m
        float nm = max(1.0, floor((x1 - x0) / 1.8 + 0.5));
        float mw = (x1 - x0) / nm;
        float lx = mod(u - x0, mw);
        bool doorL = BH(17.0) < 0.5;
        float dx0 = doorL ? x0 + 0.12 : x1 - 1.12;
        float dx1 = dx0 + 1.0;
        float gl = adRect(pg, vec2(x0 + 0.08, plinth), vec2(x1 - 0.08, glassHi), fw)
                 * adBoxP(lx, 0.05, mw - 0.05, fw.x, mw);
        float door = adRect(pg, vec2(dx0, 0.02), vec2(dx1, glassHi), fw);
        float doorGlass = adRect(pg, vec2(dx0 + 0.1, 0.2), vec2(dx1 - 0.1, glassHi - 0.1), fw);
        gl = max(gl * (1.0 - door), doorGlass);
        // Shop archetype (interior + matching sign): 0 shelves (books / drugstore / gifts),
        // 1 clothing, 2 cafe / lunchroom, 3 bakery, 4 cheese / deli, 5 florist, 6 vacant ('TE HUUR').
        float ka = BH(35.0);
        int arch = ka < 0.2 ? 0 : (ka < 0.39 ? 1 : (ka < 0.55 ? 2 : (ka < 0.65 ? 3 : (ka < 0.77 ? 4 : (ka < 0.87 ? 5 : 6)))));
        // interior mapping: a room 4.5-7.5 m deep behind the display windows (walls, floor, ceiling
        // with downlights) plus, for most archetypes, a cut-out furniture layer at depth zf
        float sDepth; int sKind; vec2 sXY;
        vec3 shopWall = BH(32.0) < 0.7 ? vec3(0.55, 0.53, 0.5) : vec3(0.2, 0.17, 0.14);
        vec3 shopFloor = BH(33.0) < 0.5 ? vec3(0.32, 0.3, 0.27) : vec3(0.16, 0.09, 0.05);
        if (arch == 2) { shopWall = vec3(0.46, 0.38, 0.28); shopFloor = vec3(0.12, 0.07, 0.035); }
        else if (arch == 3) { shopWall = vec3(0.62, 0.58, 0.5); shopFloor = vec3(0.35, 0.33, 0.3); }
        else if (arch == 5) { shopWall = vec3(0.3, 0.34, 0.29); shopFloor = vec3(0.2, 0.19, 0.17); }
        else if (arch == 6) { shopWall = vec3(0.66, 0.66, 0.64); shopFloor = vec3(0.3, 0.3, 0.29); }
        float sD = 4.5 + 3.0 * BH(31.0);
        vec3 room = adRoom(pg, vdir, x0 - 1.0, x1 + 1.0, signHi, sD, shopWall, shopFloor, sDepth, sKind, sXY);
        float lampE = 0.0;
        if (sKind <= 1 && arch != 6) {
          vec2 q = sXY;
          float sideK = float(sKind) * 7.0 + seed * 31.0;
          if (arch == 1) {
            // clothing rails: garments hanging from a rail at 1.6 m
            float ci = floor(q.x / 0.075);
            float gh = adHash12(vec2(ci, sideK));
            float fx = fract(q.x / 0.075);
            float hang = step(0.62 + 0.4 * gh, q.y) * step(q.y, 1.58) * step(0.1, gh) * step(0.07, fx) * step(fx, 0.93);
            vec3 fab = 0.5 + 0.5 * cos(6.2831 * (gh * 2.3 + vec3(0.0, 0.33, 0.67)));
            fab = mix(vec3(adLuma(fab)), fab, 0.45) * (0.25 + 0.3 * fract(gh * 13.0));
            room = mix(room, fab, hang);
            room = mix(room, vec3(0.04), step(1.58, q.y) * step(q.y, 1.63));
          } else if (arch == 2) {
            // cafe: dark wood wainscot and framed pictures
            float wain = step(q.y, 1.05);
            float pan = step(0.03, fract(q.x / 0.6)) * step(abs(q.y - 0.55), 0.4);
            room = mix(room, vec3(0.11, 0.06, 0.03) * (0.8 + 0.25 * pan), wain);
            vec2 pc = vec2(fract(q.x / 1.3) - 0.5, q.y - 1.65);
            float frame = step(abs(pc.x) * 1.3, 0.24) * step(abs(pc.y), 0.24);
            float pic = step(abs(pc.x) * 1.3, 0.2) * step(abs(pc.y), 0.2);
            float ph = adHash12(vec2(floor(q.x / 1.3), sideK));
            vec3 pcol = mix(vec3(0.25, 0.22, 0.15), vec3(0.12, 0.18, 0.22), ph) * (0.6 + 0.6 * fract(ph * 7.0));
            room = mix(room, mix(vec3(0.03, 0.02, 0.01), pcol, pic), frame);
          } else {
            // shelves (period 0.42 m from 0.3 to 2.1 m): goods / bread / cheese wheels / plants
            float shelfP = arch == 4 ? 0.36 : (arch == 3 ? 0.34 : 0.42);
            float y0s = arch == 3 ? 0.9 : 0.3;
            float sy = mod(q.y - y0s, shelfP);
            float onShelf = step(y0s, q.y) * step(q.y, 2.1) * (arch == 0 ? step(0.5, BH(34.0) + 0.3) : 1.0);
            float row = floor((q.y - y0s) / shelfP);
            if (arch == 0) {
              float gh = adHash12(vec2(floor(q.x / 0.13), row + sideK));
              float goods = onShelf * step(0.03, sy) * step(sy, 0.08 + 0.27 * gh) * step(0.2, gh);
              vec3 gc = 0.5 + 0.5 * cos(6.2831 * (gh * 3.0 + vec3(0.0, 0.33, 0.67)));
              gc = mix(vec3(adLuma(gc)), gc, 0.55);
              room = mix(room, gc * (0.12 + 0.25 * gh), goods);
            } else if (arch == 3) {
              // loaves and buns: rounded golden-brown shapes
              float cw = 0.2;
              float gh = adHash12(vec2(floor(q.x / cw), row + sideK));
              vec2 l = vec2((fract(q.x / cw) - 0.5) * cw, sy - 0.03);
              float hh = 0.06 + 0.06 * gh;
              float loaf = onShelf * step(length(vec2(l.x / (0.42 * cw), (l.y - hh) / hh)), 1.0) * step(0.0, l.y) * step(0.15, gh);
              vec3 bc = mix(vec3(0.42, 0.22, 0.07), vec3(0.62, 0.42, 0.16), fract(gh * 5.0));
              room = mix(room, bc * (0.7 + 0.4 * smoothstep(0.0, 2.0 * hh, l.y)), loaf);
            } else if (arch == 4) {
              // cheese wheels (side view: rounded slabs), mostly yellow, some orange / black wax
              float cw = 0.36;
              float gh = adHash12(vec2(floor(q.x / cw), row + sideK));
              vec2 l = vec2((fract(q.x / cw) - 0.5) * cw, sy - 0.025);
              float nW = 1.0 + floor(gh * 2.99); // stacked wheels
              float wheel = onShelf * step(abs(l.x), 0.16) * step(0.0, l.y) * step(l.y, 0.105 * nW) * step(0.12, gh);
              float seam = step(0.09, fract(l.y / 0.105) * 0.105) * (1.0 - smoothstep(0.13, 0.16, abs(l.x)) * 0.5);
              vec3 cc = gh < 0.72 ? vec3(0.78, 0.55, 0.12) : (gh < 0.88 ? vec3(0.72, 0.28, 0.05) : vec3(0.04, 0.035, 0.03));
              room = mix(room, cc * (0.75 + 0.25 * (1.0 - seam)), wheel);
            } else {
              // florist: potted green plants with some flowers
              float cw = 0.3;
              float gh = adHash12(vec2(floor(q.x / cw), row + sideK));
              vec2 l = vec2((fract(q.x / cw) - 0.5) * cw, sy - 0.02);
              float pot = onShelf * step(abs(l.x), 0.07) * step(0.0, l.y) * step(l.y, 0.1);
              float leaf = onShelf * step(length(vec2(l.x / 0.13, (l.y - 0.2) / 0.12)), 1.0) * step(0.1, l.y) * step(0.2, gh);
              float fl = step(0.55, adHash12(floor(q * 22.0) + sideK)) * step(0.5, gh);
              vec3 petal = 0.55 + 0.45 * cos(6.2831 * (gh * 4.0 + vec3(0.0, 0.33, 0.67)));
              room = mix(room, mix(vec3(0.05, 0.13, 0.04), petal * 0.6, fl), leaf);
              room = mix(room, vec3(0.32, 0.14, 0.07), pot * (1.0 - leaf));
            }
            room *= 1.0 - 0.6 * onShelf * (1.0 - step(0.022, sy));
          }
        }
        // furniture layer (a vertical cut-out plane zf metres behind the glass)
        float zf = arch == 5 ? 0.75 : (arch == 1 ? 0.65 : (arch == 2 ? 1.7 + 0.6 * BH(36.0) : 1.3 + 0.4 * BH(36.0)));
        if (arch >= 1 && arch <= 5 && zf < sDepth * sD) {
          vec3 dz = vec3(vdir.xy, max(vdir.z, 0.02));
          vec2 fp = pg + dz.xy / dz.z * zf;
          float cov = 0.0;
          vec3 fc = vec3(0.0);
          if (arch == 2) {
            // tables with a pedestal, chairs, pendant lamps above the tables
            float tx = mod(fp.x - x0 - 0.8, 1.6) - 0.8;
            float table = step(abs(tx), 0.4) * step(0.72, fp.y) * step(fp.y, 0.78)
                        + step(abs(tx), 0.03) * step(fp.y, 0.72) + step(abs(tx), 0.22) * step(fp.y, 0.03);
            float ax = abs(tx);
            float chair = step(0.5, ax) * step(ax, 0.74) * step(0.44, fp.y) * step(fp.y, 0.48)
                        + step(0.7, ax) * step(ax, 0.74) * step(fp.y, 0.95)
                        + step(0.5, ax) * step(ax, 0.53) * step(fp.y, 0.46);
            float cord = step(abs(tx), 0.006) * step(2.32, fp.y);
            float shade = step(abs(tx), 0.06 + 0.1 * clamp((2.34 - fp.y) / 0.18, 0.0, 1.0)) * step(2.16, fp.y) * step(fp.y, 2.34);
            cov = clamp(table + chair + cord + shade, 0.0, 1.0);
            fc = vec3(0.07, 0.045, 0.025);
            lampE = shade * step(fp.y, 2.2);
            fc = mix(fc, vec3(0.5, 0.35, 0.18), shade);
          } else if (arch == 3 || arch == 4) {
            // shop counter with a display case (door side kept free)
            float cx0 = doorL ? x0 + 1.4 : x0 + 0.3;
            float cx1 = doorL ? x1 - 0.3 : x1 - 1.4;
            float inX = step(cx0, fp.x) * step(fp.x, cx1);
            float body = inX * step(fp.y, 0.95);
            float top = inX * step(0.95, fp.y) * step(fp.y, 1.0);
            float vit = inX * step(1.0, fp.y) * step(fp.y, 1.28);
            float gh = adHash12(vec2(floor(fp.x / 0.16), seed * 5.0));
            float item = vit * step(fp.y, 1.06 + 0.1 * gh) * step(0.08, fract(fp.x / 0.16)) * step(fract(fp.x / 0.16), 0.92);
            vec3 counterC = arch == 3 ? vec3(0.6, 0.57, 0.52) : vec3(0.2, 0.12, 0.06);
            vec3 itemC = arch == 3 ? mix(vec3(0.5, 0.3, 0.1), vec3(0.6, 0.2, 0.15), step(0.7, gh)) : vec3(0.8, 0.6, 0.18);
            cov = clamp(body + top + item, 0.0, 1.0);
            fc = mix(counterC * (0.75 + 0.25 * step(0.9, fp.y)), itemC, item);
            fc = mix(fc, vec3(0.75, 0.74, 0.72), top);
          } else if (arch == 5) {
            // zinc buckets of cut flowers just behind the window
            float bx = mod(fp.x - x0, 0.42) - 0.21;
            float gh = adHash12(vec2(floor((fp.x - x0) / 0.42), seed * 3.0));
            float bucket = step(abs(bx), 0.14 - 0.03 * (1.0 - fp.y / 0.32)) * step(fp.y, 0.32);
            float bunch = step(length(vec2(bx / 0.2, (fp.y - 0.6) / 0.28)), 1.0) * step(0.3, fp.y);
            float head = step(0.45, adHash12(floor(fp * 26.0) + gh * 50.0));
            vec3 petal = 0.55 + 0.45 * cos(6.2831 * (gh * 5.0 + vec3(0.0, 0.33, 0.67)));
            cov = clamp(bucket + bunch, 0.0, 1.0);
            fc = mix(mix(vec3(0.05, 0.14, 0.04), petal * 0.75, head * bunch), vec3(0.38, 0.39, 0.4), bucket);
          } else {
            // clothing: a dressed mannequin near the window (left or right third of the front)
            float mx = mix(x0, x1, doorL ? 0.72 : 0.28);
            float lx = fp.x - mx;
            float headM = step(length(vec2(lx, fp.y - 1.68)), 0.1);
            float torso = step(abs(lx), 0.17 + 0.05 * clamp((fp.y - 1.0) / 0.5, 0.0, 1.0)) * step(0.85, fp.y) * step(fp.y, 1.52);
            float stand = step(abs(lx), 0.018) * step(fp.y, 0.85) + step(abs(lx), 0.18) * step(fp.y, 0.025);
            vec3 dress = 0.5 + 0.5 * cos(6.2831 * (BH(37.0) * 2.0 + vec3(0.0, 0.33, 0.67)));
            cov = clamp(headM + torso + stand, 0.0, 1.0);
            fc = mix(vec3(0.62, 0.6, 0.56), mix(vec3(adLuma(dress)), dress, 0.6) * 0.35, torso);
            fc = mix(fc, vec3(0.03), stand);
          }
          room = mix(room, fc, cov);
          sDepth = mix(sDepth, zf / sD, cov);
          if (sKind == 3) sKind = cov > 0.5 ? 4 : 3; // no downlight discs through the furniture
        }
        float spot = 0.0;
        if (sKind == 3 && arch != 6) {
          vec2 sq = (fract(sXY / vec2(1.4, 1.6)) - 0.5) * vec2(1.4, 1.6);
          spot = 1.0 - smoothstep(0.05, 0.09, length(sq));
        }
        // light level / colour per archetype: cosy cafe, warm bakery, dark vacant shop
        float lv = arch == 2 ? 0.7 : (arch == 6 ? 0.45 : 1.0);
        vec3 tint = arch == 2 ? vec3(1.0, 0.8, 0.58) : (arch == 3 ? vec3(1.0, 0.88, 0.7) : (arch == 6 ? vec3(0.92, 0.96, 1.0) : vec3(1.0, 0.93, 0.82)));
        // 'TE HUUR' board on the glass of a vacant shop
        float poster = 0.0;
        float posterText = 0.0;
        int nameIdx = SIGN_START[arch] + int(BH(36.5) * float(SIGN_NUM[arch]) * 0.999);
        if (arch == 6) {
          float pcx = mix(x0, x1, doorL ? 0.62 : 0.38);
          float hwP = uSignHalfW[nameIdx];
          float rowHP = 0.34;
          float pw = 32.0 * hwP * rowHP * 0.5 + 0.1;
          poster = adRect(pg, vec2(pcx - pw, 1.2), vec2(pcx + pw, 1.62), fw);
          posterText = adSignText(u, v, pcx, 1.41, rowHP, nameIdx, tSign, dUVx, dUVy) * poster;
        }
        vec3 inside = room * mix(1.0, 0.45, sDepth) * 0.075 * lv;
        A = mix(A, inside, gl);
        R = mix(R, 0.03, gl);
        N = mix(N, vec3(0.0, 0.0, 1.0), gl);
        E += gl * (inside * (0.9 + 2.5 * uLit) * tint + spot * vec3(1.0, 0.88, 0.7) * (1.5 + 3.0 * uLit)
                   + lampE * vec3(1.0, 0.72, 0.38) * (1.0 + 3.0 * uLit)) * (1.0 - poster);
        glassM = max(glassM, gl * (1.0 - poster));
        A = mix(A, mix(vec3(0.74, 0.74, 0.71), vec3(0.45, 0.025, 0.02), posterText), poster);
        R = mix(R, 0.6, poster);
        // sign band with the shop name (fictional Dutch names from a canvas atlas, see SHOP_NAMES)
        float band = adRect(pg, vec2(x0, signLo), vec2(x1, signHi), fw);
        float letters = 0.0;
        if (arch != 6) {
          float rowH = min(0.5, (x1 - x0 - 0.5) / (32.0 * uSignHalfW[nameIdx]));
          letters = adSignText(u, v, 0.5 * (x0 + x1), 0.5 * (signLo + signHi), rowH, nameIdx, tSign, dUVx, dUVy) * band;
        }
        vec3 letterCol = shopCol.r > 0.2 ? vec3(0.02) : (BH(19.0) < 0.6 ? vec3(0.75, 0.72, 0.62) : vec3(0.55, 0.42, 0.12));
        A = mix(A, letterCol, letters);
        R = mix(R, 0.35, letters);
        E += letters * letterCol * uLit * 2.0;
        // stone plinth
        float pl = adRect(pg, vec2(x0, -1.0), vec2(x1, plinth), fw) * (1.0 - door);
        A = mix(A, vec3(0.06, 0.065, 0.07), pl); R = mix(R, 0.6, pl);
      } else {
        // house: windows on ground floor, door in one bay
        float gsill = 0.95;
        float ghead = groundH - 0.5;
        p = vec2(ub, v);
        lo = vec2(wx0, gsill);
        hi = vec2(wx1, ghead);
        drawWin = ghead - gsill > 0.8;
        winId = ib + 50.0;
        if (abs(ib - doorBay) < 0.5) {
          drawWin = false;
          float dw = min(1.0, bw - 0.4);
          float dx0 = 0.5 * bw - 0.5 * dw;
          float dx1 = dx0 + dw;
          float dh = min(2.35, groundH - 0.75);
          float door = adRect(p, vec2(dx0, 0.12), vec2(dx1, dh), fw);
          float frameD = adRect(p, vec2(dx0 - 0.07, 0.0), vec2(dx1 + 0.07, dh + 0.62), fw);
          // white door frame + transom light above the door
          A = mix(A, frameCol, frameD); R = mix(R, 0.5, frameD); N = mix(N, vec3(0.0, 0.0, 1.0), frameD);
          float tr = adRect(p, vec2(dx0, dh + 0.08), vec2(dx1, dh + 0.55), fw) * adPanes(p, vec2(dx0, dh + 0.08), vec2(dx1, dh + 0.55), vec2(3.0, 1.0), 0.03, fw);
          A = mix(A, vec3(0.01), tr); R = mix(R, 0.04, tr); glassM = max(glassM, tr);
          // panelled door
          vec2 dp = (p - vec2(dx0, 0.12)) / vec2(dw, dh - 0.12);
          float panel = adRect(dp, vec2(0.12, 0.08), vec2(0.88, 0.45), fw / vec2(dw, dh)) + adRect(dp, vec2(0.12, 0.55), vec2(0.88, 0.92), fw / vec2(dw, dh));
          vec3 dc = doorCol * (1.0 - 0.25 * panel);
          A = mix(A, dc, door); R = mix(R, 0.38, door);
          N = mix(N, vec3(0.0, 0.0, 1.0), door);
          AO = mix(AO, 0.85, door);
          // stone step
          float step0 = adRect(p, vec2(dx0 - 0.15, -1.0), vec2(dx1 + 0.15, 0.12), fw);
          A = mix(A, vec3(0.25, 0.25, 0.24), step0); R = mix(R, 0.7, step0); N = mix(N, vec3(0.0, 0.6, 0.8), step0);
        }
        // horizontal rustication grooves on some plastered 19th-c. ground floors
        if (wallType == 2 && era <= 1 && BH(25.0) < 0.45) {
          float gr = 1.0 - adBoxP(mod(v, 0.42), 0.018, 0.42, fw.y, 0.42);
          A *= 1.0 - 0.3 * gr;
          AO *= 1.0 - 0.3 * gr;
          N = mix(N, normalize(vec3(0.0, -0.6, 0.8)), gr * 0.7);
        }
        // dark stone plinth on old houses
        if (era <= 1 && BH(20.0) < 0.5) {
          float pl = adRect(vec2(u, v), vec2(-1.0, -1.0), vec2(W + 1.0, 0.4), fw);
          A = mix(A, vec3(0.05, 0.055, 0.06), pl); R = mix(R, 0.65, pl);
        }
      }
    }

    // continuous stone bands at sill and head height across the whole facade
    if (bands && upper) {
      float b1 = adBox(vf, sill - 0.1, sill - 0.01, fw.y);
      float b2 = adBox(vf, head + (arches ? 0.42 : 0.16), head + (arches ? 0.54 : 0.28), fw.y);
      float bb = max(b1, b2) * adBox(u, 0.0, W, fw.x);
      A = mix(A, vec3(0.6, 0.58, 0.53) * (0.9 + 0.2 * mW.g), bb);
      R = mix(R, 0.7, bb);
      N = mix(N, vec3(0.0, 0.0, 1.0), bb * 0.7);
    }

    // gable zone above the eave: one small attic window
    if (v > eave + 0.05) {
      drawWin = W >= 3.8;
      p = vec2(u, v - eave);
      lo = vec2(0.5 * W - 0.38, 0.55);
      hi = vec2(0.5 * W + 0.38, 1.5);
      style = 5;
      winId = 99.0;
    }

    if (drawWin) {
      float rv = 0.065;                                   // visible reveal depth
      float open = adRect(p, lo, hi, fw);
      // lintel above the window: Renaissance relieving arch or straight lintel
      if (arches && style != 5) {
        vec2 ac = vec2(0.5 * (lo.x + hi.x), hi.y);
        float aw = 0.5 * (hi.x - lo.x) + 0.08;
        vec2 q = (p - ac) / vec2(aw, 0.4);
        float r = length(q);
        float fr = max(fwidth(r), 1.0e-4);
        float above = adBox(p.y, hi.y, hi.y + 10.0, fw.y);
        float ring = adBox(r, 1.0, 1.32, fr) * above;
        float tymp = adBox(r, 0.0, 1.0, fr) * above;
        // voussoirs: 11 blocks, alternating white stone / dark red brick, thin joints, dark outline
        float ang = atan(max(q.y, 0.0), q.x) / 3.14159265;
        float bi = ang * 11.0;
        float joint = 1.0 - adBoxP(fract(bi), 0.06, 0.94, max(fwidth(bi), 1.0e-4), 1.0);
        bool white = mod(floor(bi), 2.0) < 0.5;
        vec3 vc = white ? vec3(0.5, 0.48, 0.43) : A * vec3(0.66, 0.52, 0.48);
        vc *= 1.0 - 0.35 * joint;
        A = mix(A, vc, ring);
        R = mix(R, 0.72, ring);
        N = mix(N, normalize(vec3(q * 0.25, 1.0)), ring * 0.5);
        vec3 tc = whiteTymp ? vec3(0.5, 0.49, 0.45) : A * vec3(0.8, 0.74, 0.74);
        A = mix(A, tc, tymp);
        R = mix(R, 0.8, tymp);
        AO *= 1.0 - tymp * (0.12 + 0.25 * (1.0 - smoothstep(0.0, 0.12, p.y - hi.y)));
        float outl = adBox(r, 1.32, 1.37, fr) * above;
        A *= 1.0 - 0.35 * outl;
      } else if (era <= 1) {
        float li = adRect(p, vec2(lo.x - 0.09, hi.y), vec2(hi.x + 0.09, hi.y + 0.16), fw);
        vec3 lc = stoneLintel || wallType >= 2 ? vec3(0.62, 0.6, 0.55) : A * vec3(0.78, 0.68, 0.66);
        if (!stoneLintel && wallType < 2) {
          // soldier course: vertical joints every 6.5 cm
          float sj = 1.0 - adBoxP(mod(p.x, 0.065), 0.008, 0.065, fw.x, 0.065);
          lc *= 1.0 - 0.45 * sj;
        }
        A = mix(A, lc, li); R = mix(R, 0.75, li);
        N = mix(N, vec3(0.0, 0.0, 1.0), li * 0.6);
      }
      // sill
      float si = adRect(p, vec2(lo.x - 0.06, lo.y - 0.08), vec2(hi.x + 0.06, lo.y), fw);
      A = mix(A, era <= 1 ? vec3(0.62, 0.62, 0.6) : vec3(0.2, 0.2, 0.21), si);
      R = mix(R, 0.6, si);
      N = mix(N, normalize(vec3(0.0, 0.45, 0.9)), si);
      float siSh = adRect(p, vec2(lo.x - 0.06, lo.y - 0.16), vec2(hi.x + 0.06, lo.y - 0.08), fw);
      AO *= 1.0 - 0.45 * siSh;
      // rain streaks below the sill
      float st = adBox(p.x, lo.x, hi.x, fw.x) * (1.0 - smoothstep(0.0, 1.3, lo.y - 0.08 - p.y)) * step(p.y, lo.y - 0.08);
      st *= 0.5 + 0.5 * adMacro(vec2(p.x * 6.0 + winId, p.y * 0.4), 3.0).r;
      A *= 1.0 - 0.22 * st;

      // shutters (luiken) beside old windows on the lower floors
      if (shutters && (inGround || fi < 0.5)) {
        float sw = min(0.5 * (hi.x - lo.x), 0.5 * (bw - (hi.x - lo.x)) - 0.08);
        if (sw > 0.25) {
          float sL = adRect(p, vec2(lo.x - 0.05 - sw, lo.y), vec2(lo.x - 0.05, hi.y), fw);
          float sR = adRect(p, vec2(hi.x + 0.05, lo.y), vec2(hi.x + 0.05 + sw, hi.y), fw);
          float sh = sL + sR;
          vec3 sc = shutterCol;
          if (shutterDiag) {
            // classic two-tone hourglass pattern
            float sx = sL > 0.0 ? (p.x - (lo.x - 0.05 - sw)) / sw : (p.x - (hi.x + 0.05)) / sw;
            float sy = (p.y - lo.y) / (hi.y - lo.y);
            float hg = step(abs(sx - 0.5) * 2.0, abs(sy - 0.5) * 2.0);
            sc = mix(sc, vec3(0.72, 0.7, 0.66), hg);
          }
          float rim = sh * (1.0 - adRect(p, vec2(lo.x - 0.05 - sw + 0.05, lo.y + 0.05), vec2(lo.x - 0.1, hi.y - 0.05), fw)
                                - adRect(p, vec2(hi.x + 0.1, lo.y + 0.05), vec2(hi.x + sw, hi.y - 0.05), fw));
          A = mix(A, sc * (1.0 - 0.3 * rim), sh); R = mix(R, 0.45, sh);
          N = mix(N, vec3(0.0, 0.0, 1.0), sh);
        }
      }

      // opening: reveals, frame, glazing
      float revL = adRect(p, lo, vec2(lo.x + rv, hi.y), fw);
      float revR = adRect(p, vec2(hi.x - rv, lo.y), hi, fw);
      float revT = adRect(p, vec2(lo.x, hi.y - rv * 1.6), hi, fw);
      vec2 flo = lo + vec2(rv, 0.0);
      vec2 fhi = hi - vec2(rv, rv * 1.6);
      float frame = adRect(p, flo, fhi, fw);
      vec2 g0 = flo + ft;
      vec2 g1 = fhi - ft;
      float glass = adRect(p, g0, g1, fw);
      // glazing bars / meeting rails per style
      float bars = 1.0;
      float bt = 0.03;
      if (style == 0) {          // 18th/19th c. sash: 2 sashes, each 2 x 3 small panes
        float mid = mix(g0.y, g1.y, 0.5);
        bars = adPanes(p, g0, vec2(g1.x, mid - 0.025), vec2(2.0, 3.0), bt, fw) * adBox(p.y, g0.y, mid - 0.025, fw.y)
             + adPanes(p, vec2(g0.x, mid + 0.025), g1, vec2(2.0, 3.0), bt, fw) * adBox(p.y, mid + 0.025, g1.y, fw.y);
      } else if (style == 5) {   // small window: 2 x 2 panes
        bars = adPanes(p, g0, g1, vec2(2.0, 2.0), bt, fw);
      } else if (style == 1) {   // 19th c. two-pane sash with meeting rail
        float mid = mix(g0.y, g1.y, 0.52);
        bars = 1.0 - adBox(p.y, mid - 0.035, mid + 0.035, fw.y);
      } else if (style == 2) {   // T-window: transom + two casements, small panes on top
        float tr = mix(g0.y, g1.y, 0.72);
        float top = adPanes(p, vec2(g0.x, tr + 0.03), g1, vec2(3.0, 1.0), bt, fw) * adBox(p.y, tr + 0.03, g1.y, fw.y);
        float bot = adPanes(p, g0, vec2(g1.x, tr - 0.03), vec2(2.0, 1.0), 0.06, fw) * adBox(p.y, g0.y, tr - 0.03, fw.y);
        bars = top + bot;
      } else if (style == 3) {   // 1950-80s: transom band + three lights
        float tr = g1.y - 0.42;
        float top = adPanes(p, vec2(g0.x, tr + 0.03), g1, vec2(3.0, 1.0), 0.05, fw) * adBox(p.y, tr + 0.03, g1.y, fw.y);
        float bot = adPanes(p, g0, vec2(g1.x, tr - 0.03), vec2(2.0, 1.0), 0.05, fw) * adBox(p.y, g0.y, tr - 0.03, fw.y);
        bars = top + bot;
      } else {                   // modern: single large pane, one vertical split on wide windows
        bars = (g1.x - g0.x) > 1.6 ? adPanes(p, g0, g1, vec2(2.0, 1.0), 0.05, fw) : 1.0;
      }
      glass *= clamp(bars, 0.0, 1.0);

      // interior behind the glass: dark room, net curtains (vitrage), side drapes, blinds or lit
      float wr = adHash12(vec2(winId, seed * 57.0));
      float wr2 = adHash12(vec2(winId * 2.3 + 1.0, seed * 19.0));
      vec2 gp = (p - g0) / max(g1 - g0, vec2(0.01));
      // the room behind the window (interior mapping), dimly lit by daylight through the window
      float roomH = v > eave + 0.05 ? 2.3 : (inGround ? groundH : floorH);
      vec3 roomWall = wr2 < 0.45 ? vec3(0.42, 0.40, 0.36) : (wr2 < 0.75 ? vec3(0.30, 0.32, 0.30) : vec3(0.38, 0.30, 0.24));
      vec3 roomFloor = wr < 0.5 ? vec3(0.13, 0.075, 0.04) : vec3(0.22, 0.2, 0.18);
      float rDepth; int rKind; vec2 rXY;
      vec3 room = adRoom(p, vdir, lo.x - 0.9, hi.x + 0.9, roomH, 3.5 + 2.5 * wr2, roomWall, roomFloor, rDepth, rKind, rXY);
      // a dark piece of furniture / doorway on some back walls
      if (rKind == 0) room *= 1.0 - 0.7 * adRect(rXY, vec2(lo.x + 0.4 * wr, 0.0), vec2(lo.x + 0.4 * wr + 0.9, 0.8 + 1.3 * wr2), fw * 2.0);
      float roomLight = 0.13 * mix(1.0, 0.3, rDepth) * (0.6 + 0.8 * adHash12(vec2(winId * 3.1, seed)));
      vec3 inside = room * roomLight * (1.0 - smoothstep(0.03, 0.12, fw.x)) + vec3(0.022) * smoothstep(0.03, 0.12, fw.x);
      // Dutch windows are famously bare: only some have half-height vitrage (net curtains)
      float curtainH = era <= 1 ? (wr < 0.22 ? 0.5 : (wr < 0.3 ? 1.0 : 0.0)) : (wr < 0.12 ? 1.0 : 0.0);
      float folds = 0.86 + 0.14 * sin(p.x * 38.0 + wr * 20.0) * (1.0 - smoothstep(0.004, 0.012, fw.x));
      float curtain = (1.0 - smoothstep(curtainH - 0.02, curtainH, gp.y)) * step(0.01, curtainH);
      inside = mix(inside, vec3(0.30, 0.29, 0.27) * folds, curtain * 0.6);
      // side drapes (gordijnen) in some windows
      float drape = (wr2 < 0.22) ? (1.0 - adBox(gp.x, 0.17, 0.83, fw.x / max(g1.x - g0.x, 0.01))) : 0.0;
      vec3 drapeCol = wr2 < 0.1 ? vec3(0.09, 0.02, 0.02) : (wr2 < 0.2 ? vec3(0.18, 0.15, 0.11) : vec3(0.05, 0.06, 0.07));
      inside = mix(inside, drapeCol * (0.8 + 0.2 * sin(p.x * 70.0)), drape);
      if (era >= 2 && wr > 0.75) inside = mix(inside, vec3(0.22, 0.21, 0.2), 0.6 * adBoxP(fract(p.y * 18.0), 0.0, 0.5, fw.y * 18.0, 1.0));
      float lit = step(0.94 - 0.3 * uLit, adHash12(vec2(winId * 1.7, seed * 13.0)));
      vec3 glassA = inside;
      // old hand-made glass is slightly wavy -> gently distorted reflections, different per pane
      vec2 wav = (adMacro(p * 0.9 + vec2(winId * 0.37, seed * 3.0), 1.0).rg - 0.5) * (era <= 1 ? 0.025 : 0.006);
      vec3 glassN = normalize(vec3(wav, 1.0));

      // compose: reveal (wall, darker, normals facing inwards) -> frame -> glass
      float reveal = clamp(revL + revR + revT, 0.0, 1.0) * (1.0 - frame);
      vec3 revN = normalize(vec3(revL * 0.8 - revR * 0.8, -revT * 0.8, 0.6));
      A = mix(A, A * 0.8, reveal);
      N = mix(N, revN, reveal);
      AO = mix(AO, AO * 0.72, reveal);
      // frame (painted wood)
      float fr = frame * (1.0 - glass);
      A = mix(A, frameCol, fr);
      R = mix(R, 0.42, fr);
      N = mix(N, vec3(0.0, 0.0, 1.0), fr);
      AO = mix(AO, 0.9, fr);
      // shadow cast by the lintel/reveal onto the top of the frame and glass
      float topSh = (1.0 - smoothstep(0.0, 0.22, fhi.y - p.y)) * open;
      AO *= 1.0 - 0.45 * topSh;
      A *= 1.0 - 0.25 * topSh;
      // glass
      A = mix(A, glassA, glass);
      R = mix(R, 0.03, glass);
      N = mix(N, glassN, glass);
      AO = mix(AO, 1.0, glass);
      E += glass * lit * vec3(1.0, 0.75, 0.45) * (0.06 + 1.4 * uLit) * (0.6 + curtain) * (0.4 + 2.2 * adLuma(room) * mix(1.0, 0.4, rDepth));
      glassM = max(glassM, glass);
    }

    // white wooden cornice (lijst) under the eave of old street facades
    if (cornice) {
      float cb = adRect(vec2(u, v), vec2(-1.0, eave - 0.36), vec2(W + 1.0, eave - 0.02), fw);
      float dent = adBox(v, eave - 0.36, eave - 0.27, fw.y) * (1.0 - adBoxP(mod(u, 0.22), 0.0, 0.11, fw.x, 0.22));
      vec3 cc = vec3(0.74, 0.73, 0.69) * (1.0 - 0.45 * dent);
      A = mix(A, cc, cb); R = mix(R, 0.5, cb);
      float under = adBox(v, eave - 0.36, eave - 0.3, fw.y);
      N = mix(N, normalize(vec3(0.0, -0.7, 0.7)), cb * under);
      N = mix(N, vec3(0.0, 0.0, 1.0), cb * (1.0 - under));
      float csh = adRect(vec2(u, v), vec2(-1.0, eave - 0.75), vec2(W + 1.0, eave - 0.36), fw);
      AO *= 1.0 - 0.4 * csh * smoothstep(eave - 0.75, eave - 0.36, v);
    }
  }

  // ------------------------------------------------------------------ landmarks (no windows)
  // Churches, the Waag, the Stadhuis: Gothic / Renaissance brick with white sandstone details.
  if (landmark) {
    // weathered sandstone / Belgian limestone: restrained accents on red-brown brick
    vec3 stoneC = vec3(0.56, 0.53, 0.46) * (0.88 + 0.24 * mW.g);
    float belowEave = 1.0 - smoothstep(eave - 0.1, eave + 0.3, v);
    // speklagen: thin stone courses at a wide, regular pitch (about half of the landmarks)
    if (BH(26.0) < 0.5) {
      float per = 2.2 + 1.4 * BH(27.0);
      float bh = 0.12 + 0.08 * BH(28.0);
      float band = adBoxP(mod(v - 1.6, per), 0.0, bh, fw.y, per) * step(1.6, v);
      A = mix(A, stoneC, band); R = mix(R, 0.75, band);
      N = mix(N, vec3(0.0, 0.0, 1.0), band * 0.7);
    }
    // stone quoins (alternating long / short blocks) only at real building corners: the wall
    // polygon must be a real facade (fades in from ~2.2 to 3.6 m wide, so footprint offsets and
    // buttress sides get none) and they stop at the eave
    float qOn = smoothstep(2.2, 3.6, W) * belowEave * step(BH(29.0), 0.6);
    if (qOn > 0.0) {
      float qk = mod(floor(v / 0.34), 2.0);
      float qw = qk < 0.5 ? 0.48 : 0.28;
      float q = max(adBox(u, -0.2, qw, fw.x), adBox(u, W - qw, W + 0.2, fw.x)) * qOn;
      float qj = adBoxP(mod(v, 0.34), 0.012, 0.34, fw.y, 0.34);
      A = mix(A, stoneC * (0.75 + 0.25 * qj), q); R = mix(R, 0.75, q);
      N = mix(N, vec3(0.0, 0.0, 1.0), q * 0.7);
    }
    // grey sandstone plinth
    float pl = adBox(v, -1.0, 0.8, fw.y);
    A = mix(A, stoneC * 0.62, pl); R = mix(R, 0.8, pl);
    float plTop = adBox(v, 0.72, 0.8, fw.y);
    N = mix(N, normalize(vec3(0.0, 0.7, 0.7)), plTop);
  }

  // ------------------------------------------------------------------ grime & weathering
  float notGlass = 1.0 - glassM;
  vec4 mG = adMacro(vec2(u * 1.3 + seed * 20.0, v * 0.5), 5.0);
  float splash = 1.0 - smoothstep(0.0, 0.35 + 0.35 * mG.r, v);
  vec3 dirt = vec3(adLuma(A)) * vec3(0.75, 0.72, 0.65);
  A = mix(A, dirt * 0.8, splash * 0.55 * notGlass);
  // greenish algae near the ground on north-facing walls
  float north = clamp(-vAdWorldNormal.z, 0.0, 1.0);
  float moss = north * (1.0 - smoothstep(0.0, 0.9 + mG.g, v)) * smoothstep(0.45, 0.7, mG.b);
  A = mix(A, vec3(0.05, 0.065, 0.03), moss * 0.6 * notGlass);
  // tar-black plinth (plint) under white plastered / painted houses
  if ((wallType == 2 || wallType == 3) && !landmark) {
    float pl = adBox(v, -1.0, 0.42, fw.y);
    A = mix(A, vec3(0.018, 0.018, 0.02), pl * notGlass);
    R = mix(R, 0.55, pl);
  }
  // darkening under the eave
  if (eave < 1.0e3) AO *= 1.0 - 0.25 * smoothstep(eave - 1.2, eave, v) * step(v, eave + 0.02);
  // global ambient occlusion near the street
  AO *= 0.82 + 0.18 * smoothstep(-0.2, 1.2, v);

  sAlbedo = clamp(A, 0.0, 1.0);
  sRough = R;
  sMetal = metal;
  sAO = AO;
  sNormal = normalize(N);
  sEmissive = E;
  // glass reflects the house row across the street (shaderLib SKY_OCCLUSION), not the open sky
  sOppDist = 12.0 + 6.0 * BH(30.0);
  sSkyOcc = glassM;
`;

export interface FacadeTextures {
  brickA: TextureSet;
  brickB: TextureSet;
  plaster: TextureSet;
}

export function createFacadeMaterial(tex: FacadeTextures, noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'wall';
  const signs = createSignAtlas();
  mat.addEventListener('dispose', () => signs.texture.dispose());
  patchSurface(mat, {
    key: 'wall-v2',
    useAttr: true,
    useUv1: true,
    uniforms: {
      tBrickA: { value: tex.brickA.color },
      tBrickAN: { value: tex.brickA.normal },
      tBrickAArm: { value: tex.brickA.arm },
      tBrickB: { value: tex.brickB.color },
      tBrickBN: { value: tex.brickB.normal },
      tBrickBArm: { value: tex.brickB.arm },
      tPlaster: { value: tex.plaster.color },
      tPlasterN: { value: tex.plaster.normal },
      uBrickAM: { value: tex.brickA.metres },
      uBrickBM: { value: tex.brickB.metres },
      uPlasterM: { value: tex.plaster.metres },
      uLit: { value: 0 },
      tSigns: { value: signs.texture },
      uSignHalfW: { value: signs.halfWidths },
    },
    fragmentPars: FACADE_PARS,
    surface: FACADE_SURFACE,
  }, noise);
  return mat;
}
