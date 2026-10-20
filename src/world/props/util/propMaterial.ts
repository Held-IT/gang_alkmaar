// The prop "uber" material: MeshStandardMaterial patched (onBeforeCompile) to read per-vertex
// colour / roughness / metalness / paint mask / emissive weight (see geom.ts MeshBuilder), so a
// whole multi-material prop renders with one draw call. Optional features (defines):
//   wind    - tree/flag sway driven by the aWind attribute (vec2: sway weight m, flutter weight)
//   bob     - boats bobbing on the water (per-instance phase from the instance position)
//   signal  - traffic light cycle (aEmit = slot 1 red, 2 amber, 3 green)
//   uvRect  - per-instance atlas rectangle (instanced attribute aUvRect = offset.xy, scale.zw)
//   signBack- back faces of sign plates render as grey galvanised metal
//   foliage - leaf cards: no normal flip on back faces, mip-aware alpha, fake translucency
//   flag    - cloth wave along local +x (flag fly), normals updated
import * as THREE from 'three';

/** Uniforms shared by every prop/landmark material (update once per frame). */
export const propUniforms = {
  uTime: { value: 0 },
  /** 0 = lamps off (day), 1 = full night. Daytime default shows a faint glow. */
  uLampOn: { value: 0.0 },
  /** direction the wind blows TOWARDS (x, z); prevailing south-westerly => towards the north-east */
  uWindDir: { value: new THREE.Vector2(0.72, -0.69).normalize() },
  uWindStrength: { value: 1.0 },
  /** world direction towards the sun and its colour * intensity (foliage translucency) */
  uSunDir: { value: new THREE.Vector3(-0.5, 0.7, 0.4).normalize() },
  uSunColor: { value: new THREE.Color(3, 2.85, 2.6) },
  /**
   * Camera cut-outs (trees only, colour pass): up to PROP_CUT_MAX view-space points (xyz) with a
   * radius (w, metres at that depth). Foliage and bark in front of a point and within its radius
   * on screen are dithered away, so tree crowns never hide the fighters (Gang Alkmaar camera).
   * Shadows are unaffected. uCutCount = 0 disables it.
   */
  uCut: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
  uCutCount: { value: 0 },
  /** number of uCut points that also cut city surfaces (bridge decks over the rondvaartboot) */
  uCityCutCount: { value: 0 },
  /** view depth range (m) over which trees near the camera fade in (0,0 = off) */
  uCutNear: { value: new THREE.Vector2(0, 0) },
};

export const PROP_CUT_MAX = 8;

/**
 * GLSL (fragment, after clipping_planes_fragment) for the camera cut-outs: dithered discard of
 * fragments in front of the uCut points. countUniform names the int uniform with the number of
 * active points (trees: uCutCount; city surfaces: uCityCutCount); near adds the uCutNear fade.
 */
export function cutFragmentGlsl(countUniform: string, near: boolean): string {
  return /* glsl */ `
{
  vec3 fp = -vViewPosition;
  float fz = max(-fp.z, 0.05);
  float keep = ${near ? 'uCutNear.y > 0.0 ? smoothstep(uCutNear.x, uCutNear.y, fz) : 1.0' : '1.0'};
  for (int i = 0; i < 8; i++) {
    if (i >= ${countUniform}) break;
    vec4 c = uCut[i];
    float tz = -c.z;
    if (fz < tz - 0.9) {
      vec2 s = fp.xy * (tz / fz) - c.xy;
      // a little taller than wide: the beast stands above its chest point
      s.y = s.y > 0.0 ? s.y * 0.75 : s.y * 1.25;
      float r = length(s) / c.w;
      keep = min(keep, smoothstep(0.55, 1.0, r));
    }
  }
  if (keep < 0.999) {
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (keep < n) discard;
  }
}
`;
}

const CUT_FRAGMENT = `
#if defined( PROP_WIND ) || defined( PROP_CUT )
${cutFragmentGlsl('uCutCount', true)}
#endif
`;

export interface PropMaterialOptions {
  name: string;
  map?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  normalScale?: number;
  alphaTest?: number;
  side?: THREE.Side;
  /** use vertex attributes (color/aRM/aPaint/aEmit). Default true. */
  attributes?: boolean;
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  wind?: boolean;
  /** camera cut-outs around the fighters like the trees (molen sails); trees get it via wind */
  cut?: boolean;
  bob?: boolean;
  signal?: boolean;
  uvRect?: boolean;
  signBack?: boolean;
  foliage?: boolean;
  flag?: boolean;
  /** scale for the emissive glow (lamps) */
  emissiveBoost?: number;
  envMapIntensity?: number;
}

const WIND_VERTEX = /* glsl */ `
#ifdef PROP_WIND
{
  #ifdef USE_INSTANCING
    vec3 iPos = instanceMatrix[3].xyz;
    mat3 iRot = mat3(instanceMatrix);
  #else
    vec3 iPos = vec3(modelMatrix[3].xyz);
    mat3 iRot = mat3(1.0);
  #endif
  float s2 = max(dot(iRot[0], iRot[0]), 1e-4);
  float ph = dot(iPos.xz, vec2(0.071, 0.113));
  float gust = 0.55 + 0.45 * sin(uTime * 0.31 + iPos.x * 0.011 + iPos.z * 0.007);
  float sway = (sin(uTime * 0.9 + ph) * 0.65 + sin(uTime * 1.73 + ph * 1.7) * 0.3) * gust;
  vec3 off = vec3(uWindDir.x, 0.0, uWindDir.y) * (sway + 0.35 * gust) * aWind.x * sqrt(s2);
  float fl = sin(uTime * 5.3 + dot(position, vec3(3.1, 2.3, 1.7)) + ph * 3.0);
  off += vec3(0.45, 0.7, 0.35) * fl * aWind.y * gust * sqrt(s2);
  transformed += (transpose(iRot) * (off * uWindStrength)) / s2;
}
#endif
`;

const BOB_VERTEX = /* glsl */ `
#ifdef PROP_BOB
{
  #ifdef USE_INSTANCING
    vec3 bPos = instanceMatrix[3].xyz;
  #else
    vec3 bPos = modelMatrix[3].xyz;
  #endif
  float ph = dot(bPos.xz, vec2(0.37, 0.53));
  float heave = sin(uTime * 0.83 + ph) * 0.025 + sin(uTime * 1.31 + ph * 2.1) * 0.012;
  float roll = sin(uTime * 0.67 + ph * 1.3) * 0.012;
  float pitch = sin(uTime * 0.53 + ph * 0.7) * 0.004;
  transformed.y += heave + transformed.x * roll + transformed.z * pitch;
}
#endif
`;

// Flag: cloth in the local XY plane, hoist at x = 0, fly towards +x (length uFlagLen).
const FLAG_COMMON = /* glsl */ `
#ifdef PROP_FLAG
float flagWave(vec3 p, float ph, out float dzdx) {
  float k = 2.2;
  float w = 4.1;
  float amp = 0.06 + 0.11 * (p.x / 1.5);
  float a = p.x * k - uTime * w + ph + p.y * 0.6;
  dzdx = cos(a) * k * amp + sin(a) * 0.11 / 1.5;
  return sin(a) * amp;
}
#endif
`;

const FLAG_NORMAL = /* glsl */ `
#ifdef PROP_FLAG
{
  #ifdef USE_INSTANCING
  float fph = dot(instanceMatrix[3].xz, vec2(0.7, 1.3));
  #else
  float fph = 0.0;
  #endif
  float dzdx;
  flagWave(position, fph, dzdx);
  objectNormal = normalize(vec3(-dzdx, 0.0, 1.0));
}
#endif
`;

const FLAG_VERTEX = /* glsl */ `
#ifdef PROP_FLAG
{
  #ifdef USE_INSTANCING
  float fph2 = dot(instanceMatrix[3].xz, vec2(0.7, 1.3));
  #else
  float fph2 = 0.0;
  #endif
  float dzdx2;
  transformed.z += flagWave(position, fph2, dzdx2);
  transformed.y -= 0.03 * (position.x / 1.5) * (position.x / 1.5);
}
#endif
`;

const SIGNAL_VERTEX = /* glsl */ `
#ifdef PROP_SIGNAL
{
  #ifdef USE_INSTANCING
    vec3 sPos = instanceMatrix[3].xyz;
    vec3 sFwd = instanceMatrix[2].xyz;
  #else
    vec3 sPos = modelMatrix[3].xyz;
    vec3 sFwd = modelMatrix[2].xyz;
  #endif
  // lights facing north/south share a phase, east/west are offset by half a cycle;
  // intersections (40 m grid cells) get a pseudo random offset.
  vec2 cell = floor(sPos.xz / 40.0);
  float off = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453) * 40.0;
  float axis = abs(sFwd.x) > abs(sFwd.z) ? 20.0 : 0.0;
  float t = mod(uTime + off + axis, 40.0);
  // 0-16 green, 16-20 amber, 20-40 red
  float slot = aEmit;
  float on = 0.0;
  if (slot > 0.5 && slot < 1.5) on = t >= 20.0 ? 1.0 : 0.0;
  else if (slot > 1.5 && slot < 2.5) on = (t >= 16.0 && t < 20.0) ? 1.0 : 0.0;
  else if (slot > 2.5 && slot < 3.5) on = t < 16.0 ? 1.0 : 0.0;
  vEmit = on * 6.0;
}
#endif
`;

const _matCache = new Map<string, THREE.MeshStandardMaterial>();

/** Create (or reuse) a patched prop material. */
export function createPropMaterial(o: PropMaterialOptions): THREE.MeshStandardMaterial {
  const attributes = o.attributes !== false;
  const mat = new THREE.MeshStandardMaterial({
    name: o.name,
    color: o.color ?? 0xffffff,
    roughness: o.roughness ?? 1,
    metalness: o.metalness ?? 0,
    map: o.map ?? null,
    normalMap: o.normalMap ?? null,
    alphaTest: o.alphaTest ?? 0,
    side: o.side ?? THREE.FrontSide,
    vertexColors: attributes,
  });
  if (o.normalMap) mat.normalScale.setScalar(o.normalScale ?? 1);
  if (o.envMapIntensity !== undefined) mat.envMapIntensity = o.envMapIntensity;
  const defines: Record<string, string> = {};
  if (attributes) defines.PROP_ATTRS = '';
  if (o.wind) defines.PROP_WIND = '';
  if (o.cut) defines.PROP_CUT = '';
  if (o.bob) defines.PROP_BOB = '';
  if (o.signal) defines.PROP_SIGNAL = '';
  if (o.uvRect) defines.PROP_UVRECT = '';
  if (o.signBack) defines.PROP_SIGNBACK = '';
  if (o.foliage) defines.PROP_FOLIAGE = '';
  if (o.flag) defines.PROP_FLAG = '';
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  const boost = (o.emissiveBoost ?? 4).toFixed(3);
  const key = 'prop:' + Object.keys(defines).sort().join(',') + ':' + boost;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = propUniforms.uTime;
    shader.uniforms.uLampOn = propUniforms.uLampOn;
    shader.uniforms.uWindDir = propUniforms.uWindDir;
    shader.uniforms.uWindStrength = propUniforms.uWindStrength;
    shader.uniforms.uSunDir = propUniforms.uSunDir;
    shader.uniforms.uSunColor = propUniforms.uSunColor;
    shader.uniforms.uCut = propUniforms.uCut;
    shader.uniforms.uCutCount = propUniforms.uCutCount;
    shader.uniforms.uCutNear = propUniforms.uCutNear;
    shader.vertexShader = patchVertexCommon(shader.vertexShader, true)
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
#ifdef PROP_FOLIAGE
  {
    #ifdef USE_INSTANCING
      vec3 cn = normalMatrix * (mat3(instanceMatrix) * aCardN);
    #else
      vec3 cn = normalMatrix * aCardN;
    #endif
    vFace = abs(dot(normalize(cn), normalize(-mvPosition.xyz)));
  }
#endif
`,
      )
      .replace(
        '#include <color_vertex>',
        /* glsl */ `
#include <color_vertex>
#ifdef PROP_ATTRS
  vColor = vec4(color, 1.0);
  #ifdef USE_INSTANCING_COLOR
    vColor.rgb = mix(color, color * instanceColor.rgb, aPaint);
  #endif
  vRM = aRM;
  vEmit = aEmit * uLampOn * ${boost};
#else
  vEmit = 0.0;
#endif
${SIGNAL_VERTEX}
`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${FLAG_NORMAL}`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec2 vRM;
varying float vEmit;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
#if defined( PROP_WIND ) || defined( PROP_CUT )
uniform vec4 uCut[8];
uniform int uCutCount;
uniform vec2 uCutNear;
#endif
#ifdef PROP_FOLIAGE
varying float vFace;
#endif
`,
      )
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${CUT_FRAGMENT}`)
      .replace(
        '#include <lights_physical_fragment>',
        /* glsl */ `#include <lights_physical_fragment>
#ifdef PROP_FOLIAGE
  // leaves: weak, rough specular (no white Fresnel sheen at grazing angles)
  material.specularF90 = 0.3;
  material.specularColor *= 0.5;
  material.specularColorBlended *= 0.5;
#endif
`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
#ifdef PROP_ATTRS
  roughnessFactor = vRM.x;
#endif
`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
#ifdef PROP_ATTRS
  metalnessFactor = vRM.y;
#endif
`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
#ifdef PROP_SIGNBACK
  if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.4, 0.41, 0.42);
#endif
#ifdef PROP_FOLIAGE
  {
    // keep foliage dense in the distance: boost alpha with the mip level
    vec2 tsz = vec2(textureSize(map, 0));
    vec2 dx = dFdx(vMapUv * tsz), dy = dFdy(vMapUv * tsz);
    float mip = max(0.0, 0.5 * log2(max(dot(dx, dx), dot(dy, dy))));
    diffuseColor.a *= 1.0 + mip * 0.28;
    // fade cards seen edge-on (hides the flat-card look on the crown silhouette)
    diffuseColor.a *= smoothstep(0.07, 0.38, vFace);
  }
#endif
`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vEmit;
#ifdef PROP_FOLIAGE
  {
    // light transmitted through the leaves (looking towards the sun) + soft wrap lighting
    vec3 sunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    vec3 Vd = normalize(vViewPosition);
    float back = pow(clamp(dot(-Vd, sunV), 0.0, 1.0), 2.0);
    float wrap = clamp(dot(normal, sunV) * 0.5 + 0.5, 0.0, 1.0);
    totalEmissiveRadiance += diffuseColor.rgb * uSunColor * (back * 0.22 + wrap * 0.05);
  }
#endif
`,
      );
    if (o.foliage) {
      // leaf cards use crown-shaped normals: do not flip them on back faces
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''),
      );
    }
  };
  return mat;
}

/** Shared vertex patch (attributes, uniforms, wind/bob/flag/uvRect) for colour and depth shaders. */
function patchVertexCommon(vs: string, colorPass: boolean): string {
  return vs
    .replace(
      '#include <common>',
      /* glsl */ `#include <common>
uniform float uTime;
uniform float uLampOn;
uniform vec2 uWindDir;
uniform float uWindStrength;
#ifdef PROP_ATTRS
attribute vec2 aRM;
attribute float aPaint;
attribute float aEmit;
#endif
${colorPass ? 'varying vec2 vRM;\nvarying float vEmit;' : ''}
#ifdef PROP_WIND
attribute vec2 aWind;
#endif
#ifdef PROP_UVRECT
attribute vec4 aUvRect;
#endif
${colorPass ? '#ifdef PROP_FOLIAGE\nattribute vec3 aCardN;\nvarying float vFace;\n#endif' : ''}
${FLAG_COMMON}
`,
    )
    .replace(
      '#include <uv_vertex>',
      /* glsl */ `#include <uv_vertex>
#if defined(PROP_UVRECT) && defined(USE_MAP)
  vMapUv = uv * aUvRect.zw + aUvRect.xy;
#endif
`,
    )
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERTEX}\n${BOB_VERTEX}\n${FLAG_VERTEX}`);
}

/**
 * Depth material for shadow casting of animated / alpha-tested prop materials (same vertex
 * displacement as the colour pass). Assign to mesh.customDepthMaterial.
 */
export function createPropDepthMaterial(o: PropMaterialOptions): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: o.map ?? null,
    alphaTest: o.alphaTest ?? 0,
  });
  const defines: Record<string, string> = {};
  if (o.attributes !== false) defines.PROP_ATTRS = '';
  if (o.wind) defines.PROP_WIND = '';
  if (o.bob) defines.PROP_BOB = '';
  if (o.uvRect) defines.PROP_UVRECT = '';
  if (o.flag) defines.PROP_FLAG = '';
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  const key = 'propdepth:' + Object.keys(defines).sort().join(',');
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = propUniforms.uTime;
    shader.uniforms.uLampOn = propUniforms.uLampOn;
    shader.uniforms.uWindDir = propUniforms.uWindDir;
    shader.uniforms.uWindStrength = propUniforms.uWindStrength;
    // the depth shader has no beginnormal in all paths; objectNormal is unused there
    shader.vertexShader = patchVertexCommon(shader.vertexShader, false);
  };
  return mat;
}

/** Convenience: material + matching depth material when needed. */
export function propMaterialPair(o: PropMaterialOptions): { material: THREE.MeshStandardMaterial; depth?: THREE.MeshDepthMaterial } {
  const material = createPropMaterial(o);
  const needsDepth = !!(o.wind || o.bob || o.flag || o.uvRect || (o.alphaTest && o.alphaTest > 0));
  return { material, depth: needsDepth ? createPropDepthMaterial(o) : undefined };
}

export function cachedPropMaterial(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = _matCache.get(key);
  if (!m) {
    m = make();
    _matCache.set(key, m);
  }
  return m;
}
