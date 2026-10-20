// Shader patching helpers shared by all materials of the library.
//
// Every material is a THREE.MeshStandardMaterial (so lights, shadows, IBL, fog, tone mapping and
// the engine's post-processing all keep working) whose fragment "surface" is replaced through
// onBeforeCompile. A surface snippet runs where <map_fragment> used to be and fills these locals:
//
//   vec3  sAlbedo   linear base colour            (default 1)
//   float sRough    roughness 0..1               (default 1)
//   float sMetal    metalness 0..1               (default 0)
//   float sAO       ambient occlusion 0..1       (default 1)
//   vec3  sNormal   tangent-space normal (+z out) (default 0,0,1)
//   vec2  sTbnUv    uv used to build the derivative tangent frame (default vAdUv)
//   vec3  sEmissive linear emissive radiance      (default 0)
//   float sSkyOcc   0..1: how much of the IBL specular is replaced by "street" reflections when the
//                   reflected ray lies below sHorizon (default 0 = off). For window glass and
//                   env-only water: in a street or canal, low reflections see facades, not the sky.
//   float sHorizon  sine of the skyline elevation used by sSkyOcc (default 0.3)
//   float sOppDist  > 0: vertical surface; fake-reflect a facade row this far away (default 0)
//
// Available varyings: vAdUv (TEXCOORD_0), vAdUv1 (TEXCOORD_1), vAdAttr (COLOR_0 rgba),
// vAdWorldPos, vAdWorldNormal. Uniform sampler `adNoise` = tileable RGBA macro noise.
import * as THREE from 'three';
import { cutFragmentGlsl, propUniforms } from '../props/util/propMaterial';

/** camera cut-out GLSL for city surfaces (see propMaterial.ts uCut) */
const CITY_CUT = cutFragmentGlsl('uCityCutCount', false);

export interface SurfacePatch {
  /** Unique key: materials with the same key MUST produce the same shader source. */
  key: string;
  uniforms?: Record<string, THREE.IUniform>;
  defines?: Record<string, string | number | boolean>;
  vertexPars?: string;
  vertexMain?: string;
  fragmentPars?: string;
  /** GLSL statements computing the s* locals (see file header). */
  surface: string;
  /** Optional GLSL run right after <lights_fragment_maps> (e.g. replace IBL radiance). */
  afterLightsMaps?: string;
  /** Read the COLOR_0 attribute (rgba) into vAdAttr. */
  useAttr?: boolean;
  /** Read TEXCOORD_1 into vAdUv1. */
  useUv1?: boolean;
}

/** Common GLSL helpers (fragment + vertex safe). */
export const GLSL_COMMON = /* glsl */ `
float adHash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float adHash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 adHash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float adLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// 1D coverage of the interval [a,b] by a box filter of width w centred at x (analytic AA).
float adBox(float x, float a, float b, float w) {
  float lo = max(x - 0.5 * w, a);
  float hi = min(x + 0.5 * w, b);
  return clamp((hi - lo) / w, 0.0, 1.0);
}
// Same for a pattern repeating with period P: fades to the duty cycle once the filter covers a period.
float adBoxP(float x, float a, float b, float w, float P) {
  return mix(adBox(x, a, b, w), clamp((b - a) / P, 0.0, 1.0), smoothstep(0.3 * P, P, w));
}
// 2D coverage of rect [lo,hi] at p with filter widths fw.
float adRect(vec2 p, vec2 lo, vec2 hi, vec2 fw) {
  return adBox(p.x, lo.x, hi.x, fw.x) * adBox(p.y, lo.y, hi.y, fw.y);
}
`;

const GLSL_FRAG_COMMON = /* glsl */ `
uniform sampler2D adNoise;
varying vec2 vAdUv;
varying vec2 vAdUv1;
varying vec4 vAdAttr;
varying vec3 vAdWorldPos;
varying vec3 vAdWorldNormal;
${GLSL_COMMON}
// Derivative based tangent frame (same maths as three's getTangentFrame, own name to avoid clashes).
mat3 adTangentFrame(vec3 eye_pos, vec3 surf_norm, vec2 uv) {
  vec3 q0 = dFdx(eye_pos.xyz);
  vec3 q1 = dFdy(eye_pos.xyz);
  vec2 st0 = dFdx(uv.st);
  vec2 st1 = dFdy(uv.st);
  vec3 N = surf_norm;
  vec3 q1perp = cross(q1, N);
  vec3 q0perp = cross(N, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(B, B));
  float scale = (det == 0.0) ? 0.0 : inversesqrt(det);
  return mat3(T * scale, B * scale, N);
}
// Unpack a tangent-space normal map texel and scale its xy.
vec3 adUnpackNormal(vec3 t, float strength) {
  vec3 n = t * 2.0 - 1.0;
  n.xy *= strength;
  return normalize(n);
}
// Whiteout blend of two tangent-space normals.
vec3 adBlendNormals(vec3 a, vec3 b) { return normalize(vec3(a.xy + b.xy, a.z * b.z)); }
// Macro noise (4 independent octaves in rgba), p in metres, scale = metres per noise tile.
vec4 adMacro(vec2 p, float scale) { return texture2D(adNoise, p / scale); }
`;

/**
 * Skyline occlusion of the IBL specular (see sSkyOcc in the file header). The environment map is
 * the open sky, but a reflected ray that leaves a window or the canal surface at a low elevation
 * would hit the houses across the street / canal. Such rays get a cheap fake reflection of a row of
 * brick houses (dark windows, varying eave heights with the sky above them) lit by the same IBL
 * (radiance = E * albedo / PI), which needs no extra render pass:
 *  - vertical surfaces (window glass): the ray is intersected with a parallel facade row sOppDist
 *    metres away; below street level it sees the street;
 *  - horizontal surfaces (env-only canal water): houses stand all around at sOppDist metres
 *    (horizontal distance); between the water and the street the ray sees the wet quay wall.
 * sOppDist <= 0: rays below the elevation sHorizon simply get a uniform brick colour.
 */
const SKY_OCCLUSION = /* glsl */ `
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( RE_IndirectDiffuse )
if (sSkyOcc > 0.0) {
  vec3 adRw = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  vec3 adE = (iblIrradiance + irradiance) * RECIPROCAL_PI;
  vec3 adStreet;
  float adSky;
  if (sOppDist > 0.0) {
    vec3 adN = normalize(vAdWorldNormal);
    float adHu;     // metres along the reflected facade row
    float adHy;     // height of the hit point above street level
    bool adWater = adN.y > 0.7;
    if (adWater) {
      float adHl = max(length(adRw.xz), 1.0e-3);
      adHy = vAdWorldPos.y + adRw.y * (sOppDist / adHl);
      adHu = atan(adRw.z, adRw.x) * sOppDist;
      adE *= 0.6;   // the facades are vertical: they get about half the sky light of the water
    } else {
      vec3 adHp = vAdWorldPos + adRw * (sOppDist / max(dot(adRw, adN), 0.03));
      adHu = dot(adHp, normalize(vec3(-adN.z, 0.0, adN.x) + 1.0e-5));
      adHy = adHp.y;
    }
    float adB = adHash11(floor(adHu / 6.3) * 1.37 + 3.7);           // house index along the row
    float adEaveH = 7.5 + 9.0 * adB;
    adSky = smoothstep(adEaveH - 0.4, adEaveH + 0.4, adHy);
    float adFade = 1.0 - smoothstep(20.0, 60.0, length(vViewPosition));
    float adWu = fract(adHu / (1.5 + 0.9 * adB));
    float adWv = fract((adHy - 0.6) / 3.0);
    float adWin = smoothstep(0.22, 0.26, adWu) * smoothstep(0.78, 0.74, adWu)
                * smoothstep(0.12, 0.16, adWv) * smoothstep(0.74, 0.7, adWv) * step(1.0, adHy);
    vec3 adWall = adB > 0.82 ? vec3(0.42, 0.40, 0.36) : vec3(0.19, 0.095, 0.07) * (0.75 + 0.5 * fract(adB * 7.0));
    vec3 adRefl = mix(adWall, vec3(0.025), adWin * adFade * 0.85 + 0.12 * (1.0 - adFade));
    if (adHy < 0.0) adRefl = adWater ? vec3(0.07, 0.045, 0.035) : vec3(0.1, 0.095, 0.09);  // quay / street
    adStreet = adE * adRefl;
  } else {
    adSky = smoothstep(sHorizon - 0.12, sHorizon + 0.1, adRw.y);
    adStreet = adE * vec3(0.17, 0.14, 0.12);
  }
  radiance = mix(radiance, mix(adStreet, radiance, adSky), sSkyOcc);
}
#endif
`;

/**
 * Patches a MeshStandardMaterial with a custom surface. Returns the same material.
 * The material's `map`/`normalMap`/... must stay null; textures are bound as custom uniforms.
 */
export function patchSurface<T extends THREE.MeshStandardMaterial>(mat: T, patch: SurfacePatch, noise: THREE.Texture): T {
  const uniforms: Record<string, THREE.IUniform> = { adNoise: { value: noise }, ...(patch.uniforms ?? {}) };
  mat.userData.adUniforms = uniforms;
  if (patch.defines) mat.defines = { ...(mat.defines ?? {}), ...patch.defines };
  mat.customProgramCacheKey = () => `alkmaar-mat:${patch.key}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    // camera cut-outs (Gang Alkmaar: bridges passing over the fighters), only on the bridge materials:
    // a `discard` in a shader costs early-z, so the facades / ground keep their plain shaders
    const cut = patch.key.startsWith('bridge');
    shader.uniforms.uCut = propUniforms.uCut;
    shader.uniforms.uCityCutCount = propUniforms.uCityCutCount;
    const attrDecl = patch.useAttr ? /* glsl */ `
#if !defined( USE_COLOR_ALPHA ) && !defined( USE_COLOR )
attribute vec4 color;
#endif` : '';
    const uv1Decl = patch.useUv1 ? /* glsl */ `
#ifndef USE_UV1
attribute vec2 uv1;
#endif` : '';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
${attrDecl}
${uv1Decl}
varying vec2 vAdUv;
varying vec2 vAdUv1;
varying vec4 vAdAttr;
varying vec3 vAdWorldPos;
varying vec3 vAdWorldNormal;
${GLSL_COMMON}
${patch.vertexPars ?? ''}`)
      .replace('#include <fog_vertex>', /* glsl */ `#include <fog_vertex>
{
  vec4 adWp = vec4(transformed, 1.0);
  vec3 adWn = objectNormal;
  #ifdef USE_INSTANCING
    adWp = instanceMatrix * adWp;
    adWn = mat3(instanceMatrix) * adWn;
  #endif
  adWp = modelMatrix * adWp;
  vAdWorldPos = adWp.xyz;
  vAdWorldNormal = normalize(mat3(modelMatrix) * adWn);
  vAdUv = uv;
  ${patch.useUv1 ? 'vAdUv1 = uv1;' : 'vAdUv1 = vec2(0.0);'}
  ${patch.useAttr ? (`
  #if defined( USE_COLOR_ALPHA ) || !defined( USE_COLOR )
    vAdAttr = vec4(color);
  #else
    vAdAttr = vec4(color, 1.0);
  #endif`) : 'vAdAttr = vec4(0.0);'}
  ${patch.vertexMain ?? ''}
}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${cut ? 'uniform vec4 uCut[8];\nuniform int uCityCutCount;' : ''}\n${GLSL_FRAG_COMMON}\n${patch.fragmentPars ?? ''}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${cut ? CITY_CUT : ''}`)
      .replace('#include <map_fragment>', /* glsl */ `
vec3 sAlbedo = vec3(1.0);
float sRough = 1.0;
float sMetal = 0.0;
float sAO = 1.0;
vec3 sNormal = vec3(0.0, 0.0, 1.0);
vec2 sTbnUv = vAdUv;
vec3 sEmissive = vec3(0.0);
float sSkyOcc = 0.0;
float sHorizon = 0.3;
float sOppDist = 0.0;
{
${patch.surface}
}
diffuseColor.rgb *= sAlbedo;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(sRough, 0.02, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(sMetal, 0.0, 1.0);')
      .replace('#include <normal_fragment_maps>', /* glsl */ `
{
  mat3 adTbn = adTangentFrame(-vViewPosition, normal, sTbnUv);
  #ifdef DOUBLE_SIDED
    adTbn[0] *= faceDirection;
    adTbn[1] *= faceDirection;
  #endif
  normal = normalize(adTbn * sNormal);
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += sEmissive;')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>\n${SKY_OCCLUSION}\n${patch.afterLightsMaps ?? ''}`)
      .replace('#include <aomap_fragment>', /* glsl */ `
{
  float ambientOcclusion = clamp(sAO, 0.0, 1.0);
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNVao = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNVao, ambientOcclusion, material.roughness );
  #endif
}`);
  };
  mat.needsUpdate = true;
  return mat;
}
