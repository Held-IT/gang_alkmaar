// Materials of the procedural cars. Shared per spec where possible; per car only the materials
// that must differ (paint colour, light state, licence plate) are created.
//
//  paint   MeshPhysicalMaterial + atlas. Texels that are (near) pure white in the albedo atlas get
//          the paint colour (and instanceColor for traffic instancing); every other texel keeps
//          its own colour, so lamps, grilles and trims are never tinted by the paint.
//  detail  MeshStandardMaterial, vertex colours + per-vertex (roughness, metalness) attribute
//          `pbr`, atlas map for window cut-outs of the interior shell (alphaTest).
//  lights  MeshStandardMaterial, vertex colours + `lightCh` attribute selecting one of 8 light
//          channels; emission = uLightCol[ch] * uLight[ch] (set by CarModel.setLights).
//  glass   tinted physical glass: reflections added on top, background attenuated
//          (premultiplied-style custom blending, no transmission pass).
//  wheel   like detail, plus a tyre tread bump map (uv.y < 0.5 = tread band).
import * as THREE from 'three';

/** light channel indices (attribute `lightCh`) */
export const CH = {
  none: 0,
  drl: 1,
  head: 2,
  tail: 3,
  brake: 4,
  indL: 5,
  indR: 6,
  reverse: 7,
} as const;

const LIGHT_COLORS: THREE.Color[] = [
  new THREE.Color(0, 0, 0),
  new THREE.Color(0.85, 0.92, 1.0), // DRL: cool white LED
  new THREE.Color(0.9, 0.95, 1.0), // dipped / main beam
  new THREE.Color(1.0, 0.02, 0.01), // tail
  new THREE.Color(1.0, 0.0, 0.0), // brake
  new THREE.Color(1.0, 0.36, 0.0), // indicator L
  new THREE.Color(1.0, 0.36, 0.0), // indicator R
  new THREE.Color(1.0, 1.0, 1.0), // reverse
];

// ------------------------------------------------------------------------------------------------
// paint
export interface PaintMaterial extends THREE.MeshPhysicalMaterial {
  userData: { metallic: boolean };
}

/** Heuristic: is a paint colour usually metallic? (pure whites, bright reds/yellows are solid) */
export function isMetallicPaint(c: THREE.Color): boolean {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l > 0.78) return false;
  if (hsl.s > 0.55 && hsl.l > 0.3) return false;
  return true;
}

export function createPaintMaterial(map: THREE.Texture, orm: THREE.Texture, color: THREE.ColorRepresentation, cutout: boolean): PaintMaterial {
  const col = new THREE.Color(color);
  const metallic = isMetallicPaint(col);
  const m = new THREE.MeshPhysicalMaterial({
    color: col,
    map,
    roughnessMap: orm,
    metalnessMap: orm,
    clearcoatMap: orm,
    roughness: 1,
    metalness: metallic ? 0.62 : 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    alphaTest: cutout ? 0.5 : 0,
  }) as PaintMaterial;
  m.userData.metallic = metallic;
  m.name = 'car-paint';
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <map_fragment>',
        `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  // atlas alpha: 0 cut-out, 0.75 trim, 1 paint -> paint coverage of this texel
  float paintMask = clamp( ( sampledDiffuseColor.a - 0.75 ) * 4.0, 0.0, 1.0 );
  vec3 paintCol = diffuseColor.rgb;
  // vertex / instance colour tints the paint only (vColor is a vec4 since three r17x)
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
    paintCol *= vColor.rgb;
  #endif
  // texel = coverage * white + (1 - coverage) * trim colour  ->  swap the white part for the paint
  diffuseColor.rgb = max( sampledDiffuseColor.rgb + paintMask * ( paintCol - 1.0 ), 0.0 );
  diffuseColor.a *= sampledDiffuseColor.a;
#else
  float paintMask = 1.0;
#endif
`,
      )
      .replace('#include <color_fragment>', '')
      .replace(
        '#include <metalnessmap_fragment>',
        `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
  vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );
  metalnessFactor = mix( texelMetalness.b, metalness, paintMask );
#endif
`,
      );
  };
  m.customProgramCacheKey = () => 'car-paint-v3';
  return m;
}

// ------------------------------------------------------------------------------------------------
// detail (vertex colour + per-vertex pbr)
function patchPbr(sh: THREE.WebGLProgramParametersWithUniforms): void {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
    .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
    .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;');
}

export function createDetailMaterial(map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map,
    alphaTest: map ? 0.5 : 0,
    roughness: 1,
    metalness: 0,
  });
  m.name = 'car-detail';
  m.onBeforeCompile = patchPbr;
  m.customProgramCacheKey = () => 'car-detail-v1';
  return m;
}

// ------------------------------------------------------------------------------------------------
// wheels: detail + tread bump
let treadTex: THREE.CanvasTexture | null = null;
function getTreadTexture(): THREE.CanvasTexture {
  if (treadTex) return treadTex;
  // u: around the tyre (repeats), v: across: 0..0.5 tread band, 0.5..1 flat (sidewall / rim)
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 256);
  // the tread is the bottom half in canvas coordinates (flipY maps canvas bottom -> v 0)
  const y0 = 128;
  // circumferential grooves
  g.fillStyle = '#202020';
  for (const t of [0.22, 0.42, 0.58, 0.78]) g.fillRect(0, y0 + t * 128 - 4, 128, 8);
  // lateral sipes / blocks
  g.strokeStyle = '#3a3a3a';
  g.lineWidth = 5;
  for (let x = 0; x < 128 + 32; x += 32) {
    g.beginPath();
    g.moveTo(x, y0 + 4);
    g.lineTo(x - 10, y0 + 0.2 * 128);
    g.moveTo(x - 16, y0 + 0.24 * 128);
    g.lineTo(x - 16, y0 + 0.4 * 128);
    g.moveTo(x, y0 + 0.6 * 128);
    g.lineTo(x, y0 + 0.76 * 128);
    g.moveTo(x - 10, y0 + 0.8 * 128);
    g.lineTo(x, y0 + 124);
    g.stroke();
  }
  treadTex = new THREE.CanvasTexture(c);
  treadTex.colorSpace = THREE.NoColorSpace;
  treadTex.wrapS = THREE.RepeatWrapping;
  treadTex.wrapT = THREE.ClampToEdgeWrapping;
  treadTex.anisotropy = 4;
  return treadTex;
}

export function createWheelMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    bumpMap: getTreadTexture(),
    bumpScale: 2.5,
  });
  m.name = 'car-wheel';
  m.onBeforeCompile = patchPbr;
  m.customProgramCacheKey = () => 'car-wheel-v1';
  return m;
}

// ------------------------------------------------------------------------------------------------
// lights
export interface LightsMaterial extends THREE.MeshStandardMaterial {
  userData: { levels: Float32Array };
}

export function createLightsMaterial(): LightsMaterial {
  const levels = new Float32Array(8);
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.18,
    metalness: 0.0,
  }) as LightsMaterial;
  m.name = 'car-lights';
  m.userData.levels = levels;
  const uLight = { value: levels };
  const uLightCol = { value: LIGHT_COLORS };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLight = uLight;
    sh.uniforms.uLightCol = uLightCol;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float lightCh;\nvarying float vLightCh;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLightCh = lightCh;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLightCh;\nuniform float uLight[8];\nuniform vec3 uLightCol[8];')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  {
    int ch = int( vLightCh + 0.5 );
    float lv = uLight[ ch ];
    totalEmissiveRadiance += uLightCol[ ch ] * lv;
    // a lit lamp looks bright and saturated, not like painted plastic
    diffuseColor.rgb *= 1.0 / ( 1.0 + lv * 0.5 );
  }`,
      );
  };
  m.customProgramCacheKey = () => 'car-lights-v1';
  return m;
}

// ------------------------------------------------------------------------------------------------
// glass
let glassShared: THREE.MeshPhysicalMaterial | null = null;
export function createGlassMaterial(mask: THREE.Texture): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x0a0d0f,
    map: mask, // only its alpha (glass mask) matters: colour is ~black
    roughness: 0.02,
    metalness: 0,
    transparent: true,
    opacity: 0.74,
    alphaTest: 0.3,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    envMapIntensity: 1.25,
    specularIntensity: 1,
    ior: 1.52,
    side: THREE.FrontSide,
  });
  m.name = 'car-glass';
  return m;
}

/** shared glass without a mask (LOD-less helpers) */
export function sharedGlass(): THREE.MeshPhysicalMaterial {
  if (!glassShared) glassShared = createGlassMaterial(null as unknown as THREE.Texture);
  return glassShared;
}

// ------------------------------------------------------------------------------------------------
// plate / decal
export function createDecalMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.38,
    metalness: 0.2,
    alphaTest: 0.5,
    emissive: new THREE.Color(0xffffff),
    emissiveMap: tex,
    emissiveIntensity: 0,
  });
  m.name = 'car-decal';
  return m;
}
