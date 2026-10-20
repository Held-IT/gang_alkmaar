// Ground / generic surface materials (roads, pavements, quays, bridges, roofs_flat, ...).
// One MeshStandardMaterial per MaterialClass, sampling a CC0 texture set with metric UVs plus
// anti-tiling: low-frequency macro variation (brightness / hue / roughness) for everything and,
// for unstructured textures (asphalt, grass, mud...), a second rotated sample blended by noise.
import * as THREE from 'three';
import { WATER_LEVEL } from '../../config';
import { patchSurface } from './shaderLib';
import type { TextureSet } from './textures';

export interface SurfaceOptions {
  key: string;
  set: TextureSet;
  /** multiplier on the physical tile size (1 = real size) */
  scale?: number;
  /** linear multiplier on the albedo */
  tint?: THREE.ColorRepresentation;
  /** replace hue: albedo = luminance(tex) / avgLuma * recolor (linear), then mixed by amount */
  recolor?: { color: THREE.ColorRepresentation; amount: number; avgLuma: number };
  normalStrength?: number;
  roughnessMul?: number;
  roughnessAdd?: number;
  /** strength of the macro brightness variation (0..1) */
  macro?: number;
  /** blend a second rotated sample (only for unstructured textures) */
  stochastic?: boolean;
  /**
   * structured patterns (pavers, setts, tiles): [start, end] pixel footprint in metres over which
   * a mip bias + normal fade kicks in against grazing-angle moire
   */
  antiMoire?: [number, number];
  /** GLSL appended after the base sampling; may modify s* and use `wp` (world pos) */
  extra?: string;
  extraPars?: string;
  extraUniforms?: Record<string, THREE.IUniform>;
  polygonOffset?: number;
  useAttr?: boolean;
  /** AO strength from the arm map (0..1) */
  aoStrength?: number;
}

function colorVec(c: THREE.ColorRepresentation | undefined, fallback = '1.0, 1.0, 1.0'): string {
  if (c === undefined) return `vec3(${fallback})`;
  const col = new THREE.Color(c);
  return `vec3(${col.r.toFixed(4)}, ${col.g.toFixed(4)}, ${col.b.toFixed(4)})`;
}

/** Linear colour from an sRGB hex (THREE.Color does the conversion). */
export function lin(hex: number): THREE.Color {
  return new THREE.Color(hex);
}

export function createSurfaceMaterial(opts: SurfaceOptions, noise: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = opts.key;
  const tile = (opts.set.metres * (opts.scale ?? 1)).toFixed(4);
  const ns = (opts.normalStrength ?? 1).toFixed(3);
  const macro = (opts.macro ?? 0.2).toFixed(3);
  const rm = (opts.roughnessMul ?? 1).toFixed(3);
  const ra = (opts.roughnessAdd ?? 0).toFixed(3);
  const aoS = (opts.aoStrength ?? 1).toFixed(3);
  const recolor = opts.recolor
    ? `{ float l = adLuma(c) / ${opts.recolor.avgLuma.toFixed(4)}; c = mix(c, l * ${colorVec(opts.recolor.color)}, ${opts.recolor.amount.toFixed(3)}); }`
    : '';
  const sampling = opts.stochastic
    ? /* glsl */ `
  vec2 suv = vAdUv / ${tile};
  vec4 mS = adMacro(vAdUv, 19.0);
  float bl = smoothstep(0.40, 0.60, mS.g);
  const mat2 R = mat2(0.6216, 0.7833, -0.7833, 0.6216);
  vec2 suv2 = R * suv + vec2(0.371, 0.613);
  vec3 c = mix(texture2D(tColor, suv).rgb, texture2D(tColor, suv2).rgb, bl);
  vec3 arm = mix(texture2D(tArm, suv).rgb, texture2D(tArm, suv2).rgb, bl);
  vec3 nA = texture2D(tNormal, suv).rgb * 2.0 - 1.0;
  vec3 nB = texture2D(tNormal, suv2).rgb * 2.0 - 1.0;
  nB.xy = nB.xy * R;
  vec3 n = normalize(mix(nA, nB, bl));`
    : opts.antiMoire
      ? /* glsl */ `
  vec2 suv = vAdUv / ${tile};
  // anti-moire: paver / sett joint grids (45 deg herringbone!) beat against the pixel grid at
  // grazing angles 40-100 m away. The area-equivalent pixel footprint in metres drives a
  // positive mip bias (scaled gradients, up to +1 mip) and fades the normal map (no specular
  // sparkle), so far pavement resolves to its average colour + the macro variation below.
  vec2 gx = dFdx(suv);
  vec2 gy = dFdy(suv);
  float fpM = sqrt(length(gx) * length(gy)) * ${tile};
  float amF = smoothstep(${opts.antiMoire[0].toFixed(3)}, ${opts.antiMoire[1].toFixed(3)}, fpM);
  gx *= 1.0 + amF;
  gy *= 1.0 + amF;
  vec3 c = textureGrad(tColor, suv, gx, gy).rgb;
  vec3 arm = textureGrad(tArm, suv, gx, gy).rgb;
  vec3 n = textureGrad(tNormal, suv, gx, gy).rgb * 2.0 - 1.0;
  n.xy *= 1.0 - 0.6 * amF;`
      : /* glsl */ `
  vec2 suv = vAdUv / ${tile};
  vec3 c = texture2D(tColor, suv).rgb;
  vec3 arm = texture2D(tArm, suv).rgb;
  vec3 n = texture2D(tNormal, suv).rgb * 2.0 - 1.0;`;

  patchSurface(mat, {
    key: opts.key,
    useAttr: opts.useAttr,
    uniforms: {
      tColor: { value: opts.set.color },
      tNormal: { value: opts.set.normal },
      tArm: { value: opts.set.arm },
      ...(opts.extraUniforms ?? {}),
    },
    fragmentPars: `uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tArm;
${opts.extraPars ?? ''}`,
    surface: /* glsl */ `
  vec3 wp = vAdWorldPos;
  ${sampling}
  ${recolor}
  c *= ${colorVec(opts.tint)};
  // macro variation: two scales of low-frequency noise -> brightness, slight warm/cool shift
  vec4 m1 = adMacro(wp.xz, 41.0);
  vec4 m2 = adMacro(wp.xz + 17.0, 173.0);
  float v = (m1.r - 0.5) * 0.9 + (m2.g - 0.5) * 0.9;
  c *= 1.0 + ${macro} * v;
  c *= mix(vec3(0.97, 1.0, 1.04), vec3(1.04, 1.0, 0.95), m1.b);
  n.xy *= ${ns};
  sNormal = normalize(n);
  sAlbedo = max(c, vec3(0.0));
  sRough = arm.g * ${rm} + ${ra} + (m2.a - 0.5) * 0.08;
  sMetal = arm.b;
  sAO = mix(1.0, arm.r, ${aoS});
  ${opts.extra ?? ''}`,
  }, noise);

  if (opts.polygonOffset) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -opts.polygonOffset;
    mat.polygonOffsetUnits = -opts.polygonOffset * 2;
  }
  return mat;
}

/** GLSL: wet / algae gradient towards the canal water line (quays, bridge bodies). */
export const QUAY_EXTRA = /* glsl */ `
  {
    float wl = ${WATER_LEVEL.toFixed(3)};
    float h = wp.y - wl;                       // height above the water line
    vec4 mq = adMacro(vec2(vAdUv.x * 0.7, wp.y * 2.0), 9.0);
    // damp zone: darker and smoother lower down
    float damp = 1.0 - smoothstep(0.1, 1.35 + mq.r * 0.4, h);
    sAlbedo *= mix(1.0, 0.55, damp);
    sRough = mix(sRough, 0.55, damp * 0.7);
    // green algae band just above the water line
    float algae = (1.0 - smoothstep(0.0, 0.32 + mq.g * 0.35, h)) * step(-0.05, h);
    sAlbedo = mix(sAlbedo, vec3(0.035, 0.05, 0.018) * (0.7 + mq.b * 0.6), algae * 0.85);
    sRough = mix(sRough, 0.35, algae);
    // permanently wet, very dark below the water line
    float under = 1.0 - smoothstep(-0.3, 0.0, h);
    sAlbedo *= mix(1.0, 0.35, under);
    // light efflorescence / dirt streaks on the dry upper part
    float streak = smoothstep(0.62, 0.9, adMacro(vec2(vAdUv.x * 3.0, wp.y * 0.15), 7.0).a) * smoothstep(0.6, 1.2, h);
    sAlbedo = mix(sAlbedo, sAlbedo * 1.25 + 0.015, streak * 0.35);
  }`;

/** GLSL: concrete/granite curb blocks with joints every metre along u. */
export const CURB_EXTRA = /* glsl */ `
  {
    float fu = fract(vAdUv.x / 1.0);
    float w = max(fwidth(vAdUv.x), 1e-4);
    float joint = 1.0 - adBoxP(fu, 0.006, 0.994, w, 1.0);
    sAlbedo *= mix(1.0, 0.45, joint);
    sAO *= mix(1.0, 0.6, joint);
    float hb = adHash11(floor(vAdUv.x));
    sAlbedo *= 0.92 + hb * 0.16;
  }`;
