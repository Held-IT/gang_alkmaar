// Roof materials: 'roof_slanted' (Dutch clay pantiles, oriented down the slope per face) and
// 'backdrop' (cheap distant buildings: tinted brick + simple window grid, flat-coloured roofs).
import * as THREE from 'three';
import { patchSurface } from './shaderLib';
import type { TextureSet } from './textures';

const ROOF_PARS = /* glsl */ `
uniform sampler2D tTile;
uniform sampler2D tTileN;
uniform sampler2D tTileArm;
uniform sampler2D tDark;
uniform sampler2D tDarkN;
uniform sampler2D tDarkArm;
uniform float uTileM;
uniform float uDarkM;
const vec2 TILE_ASPECT = vec2(1.12, 0.92);
// High-pass de-tiling: removes the low-frequency blotches baked into a texture (which repeat
// visibly every tile) by dividing by a ~0.5 m blur and multiplying by the texture average; the
// shader adds its own non-repeating macro variation instead.
vec3 adDetile(sampler2D tex, vec2 t) {
  vec3 blur = textureGrad(tex, t, vec2(1.0 / 6.0, 0.0), vec2(0.0, 1.0 / 6.0)).rgb;
  vec3 avg = textureGrad(tex, t, vec2(64.0, 0.0), vec2(0.0, 64.0)).rgb;
  return clamp(avg / max(blur, vec3(0.01)), vec3(0.5), vec3(2.0));
}
`;

const ROOF_SURFACE = /* glsl */ `
  vec3 wp = vAdWorldPos;
  vec3 Nw = normalize(vAdWorldNormal);
  float seed = vAdAttr.r;
  // slope frame: v runs uphill along the roof face, u along the ridge
  vec2 d = Nw.xz;
  float dl = length(d);
  vec2 down = dl > 1.0e-3 ? d / dl : vec2(0.0, 1.0);
  vec2 across = vec2(down.y, -down.x);
  float cosT = max(Nw.y, 0.3);
  // BAG roofs carry TEXCOORD_1 = (metres along the eave, metres up the slope): tile rows then start
  // exactly at the eave. Geometry without it (uv1 constant) falls back to a world-space slope frame.
  vec2 du1 = fwidth(vAdUv1);
  bool hasUv1 = du1.x + du1.y > 1.0e-5;
  vec2 ruv = hasUv1 ? vAdUv1 + vec2(adHash11(seed * 13.1) * 11.0, 0.0)
                    : vec2(dot(wp.xz, across), -dot(wp.xz, down) / cosT)
                      + vec2(adHash11(seed * 13.1) * 11.0, adHash11(seed * 7.9 + 2.0) * 7.0);
  sTbnUv = ruv;
  vec2 gx = dFdx(ruv);
  vec2 gy = dFdy(ruv);
  float h = adHash11(seed * 71.3 + 4.0);
  // landmarks (churches, the Waag: COLOR_0.g = 1) have dark blue-grey slate roofs
  bool landmark = vAdAttr.g > 0.75;
  // ambientCG roof sets are authored with image-up = downhill (tile lips at the top of each tile):
  // flip v so the lips face down the slope; the normal map's y flips with it
  vec2 rt = vec2(ruv.x, -ruv.y);
  vec2 rgx = vec2(gx.x, -gx.y);
  vec2 rgy = vec2(gy.x, -gy.y);
  vec3 c; vec3 n; vec3 arm;
  bool darkTiles = h < 0.28 || (landmark && h < 0.92);
  if (darkTiles) {
    // anthracite glazed tiles (very common on 1900-1930 and restored houses)
    vec2 t = rt / uDarkM;
    c = textureGrad(tDark, t, rgx / uDarkM, rgy / uDarkM).rgb * adDetile(tDark, t);
    n = textureGrad(tDarkN, t, rgx / uDarkM, rgy / uDarkM).rgb * 2.0 - 1.0;
    arm = textureGrad(tDarkArm, t, rgx / uDarkM, rgy / uDarkM).rgb;
    c *= 0.5 + 0.15 * adHash11(seed * 5.7);
    if (landmark) c = vec3(adLuma(c)) * vec3(0.80, 0.88, 1.0) * 1.1;   // blue-grey slate
  } else {
    // RoofingTiles014A: clean S-pantiles, 19 columns x 11 rows per texture tile; stretched to the
    // Dutch 'oude Hollandse pan' cover size (~0.22 m wide, ~0.31 m per row)
    vec2 tm = uTileM * TILE_ASPECT;
    vec2 t = rt / tm;
    c = textureGrad(tTile, t, rgx / tm, rgy / tm).rgb * adDetile(tTile, t);
    n = textureGrad(tTileN, t, rgx / tm, rgy / tm).rgb * 2.0 - 1.0;
    arm = textureGrad(tTileArm, t, rgx / tm, rgy / tm).rgb;
    // weathered red-brown (old) .. classic red-orange .. fresh orange, per building
    vec3 tint = h < 0.55 ? vec3(0.66, 0.50, 0.44)
              : (h < 0.86 ? vec3(0.90, 0.66, 0.56) : vec3(1.02, 0.76, 0.60));
    c *= tint;
    // per-tile tone variation (real roofs mix tile batches; breaks the texture repeat), faded out
    // once a tile gets smaller than ~2 px
    vec2 cell = vec2(floor(t.x * 19.0), floor(t.y * 11.0 + 0.354));
    float tv = adHash11(dot(cell, vec2(1.0, 57.0)) + seed * 113.0);
    float tw = 1.0 - smoothstep(0.25, 0.6, max(length(rgx), length(rgy)) / tm.x * 19.0);
    c *= 1.0 + tw * ((tv - 0.5) * 0.22 + (tv > 0.96 ? -0.25 : 0.0));
    // old clay is duller: partly desaturate
    float dull = 0.12 + 0.25 * adHash11(seed * 3.3 + 1.0);
    c = mix(c, vec3(adLuma(c)) * vec3(1.15, 0.95, 0.85), dull);
  }
  n.y = -n.y;
  float gut = 0.0;
  if (hasUv1) {
    // zinc gutter (goot) along the eave
    float fwy = max(fwidth(vAdUv1.y), 1.0e-4);
    gut = adBox(vAdUv1.y, -1.0, 0.12, fwy);
    c = mix(c, vec3(0.045, 0.047, 0.05), gut);
    n = mix(n, vec3(0.0, 0.6, 0.8), gut);
    arm = mix(arm, vec3(1.0, 0.45, 0.6), gut);
  }
  // weathering: soot / moss patches, more on north-facing slopes
  vec4 m = adMacro(wp.xz + seed * 40.0, 9.0);
  vec4 m2 = adMacro(wp.xz, 61.0);
  float north = clamp(-down.y, 0.0, 1.0);
  float moss = smoothstep(0.55 - 0.15 * north, 0.85, m.g) * (0.35 + 0.65 * north);
  c = mix(c, vec3(0.045, 0.05, 0.025), moss * 0.55);
  c *= 0.85 + 0.3 * m2.r;
  sAlbedo = c;
  sNormal = normalize(n);
  sRough = clamp(arm.g + (darkTiles ? 0.25 : 0.22) + moss * 0.1, 0.3, 1.0);
  sMetal = 0.6 * gut;
  sAO = mix(1.0, arm.r, 0.9);
`;

export function createRoofMaterial(tile: TextureSet, dark: TextureSet, noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'roof_slanted';
  patchSurface(mat, {
    key: 'roof_slanted-v3',
    useUv1: true,
    useAttr: true,
    uniforms: {
      tTile: { value: tile.color },
      tTileN: { value: tile.normal },
      tTileArm: { value: tile.arm },
      tDark: { value: dark.color },
      tDarkN: { value: dark.normal },
      tDarkArm: { value: dark.arm },
      uTileM: { value: tile.metres },
      uDarkM: { value: dark.metres },
    },
    fragmentPars: ROOF_PARS,
    surface: ROOF_SURFACE,
  }, noise);
  return mat;
}

const BACKDROP_PARS = /* glsl */ `
uniform sampler2D tBrick;
uniform float uBrickM;
`;

const BACKDROP_SURFACE = /* glsl */ `
  vec3 wp = vAdWorldPos;
  vec3 Nw = normalize(vAdWorldNormal);
  float seed = vAdAttr.r;
  float k = adHash11(seed * 17.7);
  if (Nw.y > 0.55) {
    // roofs: flat colours (red tiles / anthracite / bitumen)
    vec3 rc = k < 0.45 ? vec3(0.16, 0.05, 0.03) : (k < 0.75 ? vec3(0.035, 0.035, 0.04) : vec3(0.07, 0.065, 0.06));
    rc *= 0.8 + 0.4 * adMacro(wp.xz, 37.0).r;
    sAlbedo = rc;
    sRough = 0.85;
  } else {
    float u = vAdUv.x;
    float v = vAdUv.y;
    vec2 fw = vec2(length(vec2(dFdx(u), dFdy(u))), length(vec2(dFdx(v), dFdy(v))));
    fw = clamp(fw, vec2(1.0e-4), vec2(50.0));
    vec3 bc = texture2D(tBrick, vec2(u + seed * 30.0, v) / uBrickM).rgb;
    vec3 tint = k < 0.12 ? vec3(2.2, 2.1, 1.9) : (k < 0.5 ? vec3(1.0) : (k < 0.8 ? vec3(0.75, 0.7, 0.7) : vec3(1.1, 0.95, 0.75)));
    vec3 A = bc * tint;
    // simple window grid: 3 m floors, 2.4 m bays
    float wx = adBoxP(mod(u, 2.4), 0.6, 1.8, fw.x, 2.4);
    float wy = adBoxP(mod(v, 3.0), 0.9, 2.4, fw.y, 3.0) * step(0.6, v);
    float win = wx * wy;
    A = mix(A, vec3(0.02, 0.022, 0.025), win);
    sAlbedo = A;
    sRough = mix(0.85, 0.1, win);
    sAO = 0.85 + 0.15 * smoothstep(0.0, 2.0, v);
  }
`;

export function createBackdropMaterial(brick: TextureSet, noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = 'backdrop';
  patchSurface(mat, {
    key: 'backdrop-v1',
    useAttr: true,
    uniforms: { tBrick: { value: brick.color }, uBrickM: { value: brick.metres } },
    fragmentPars: BACKDROP_PARS,
    surface: BACKDROP_SURFACE,
  }, noise);
  return mat;
}
