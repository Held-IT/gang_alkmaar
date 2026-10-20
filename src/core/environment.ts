// Environment: HDRI sky (rendered on a background dome with a haze band and an infinite virtual
// ground), image based lighting from the same HDRI (sun removed, lower hemisphere replaced by
// lit street-level ground), the sun (three's cascaded SunLight, aligned with the visible HDRI sun)
// and aerial-perspective fog whose colour is measured from the HDRI horizon.
//
// Assets (tools/engine/fetch-hdri.mjs): public/assets/hdri/sky.json, sky_1k.hdr (IBL),
// sky_2k.hdr / sky_4k_top.hdr (background, by quality).
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import type { EnvironmentHandle } from '../contracts';
import { ASSETS_URL } from '../config';
import { FOG_AZIMUTH_BINS, type AerialFogUniforms } from './fog';
import type { EngineQualitySettings } from './quality';

// ------------------------------------------------------------------------------------------------
// Look constants (tuned with src/scenes/dev-render.ts)
// ------------------------------------------------------------------------------------------------

/** Multiplier on the measured sun irradiance (sky.json normalises it to 4.0). */
const SUN_BOOST = 1.0;
/** Afternoon warmth applied on top of the measured sun colour. */
const SUN_WARMTH = new THREE.Color(1.0, 0.955, 0.88);
/** scene.environmentIntensity (IBL). */
const ENV_INTENSITY = 1.2;
/** Albedo of the generic street-level ground (brick pavers, asphalt, gardens) used for the IBL
 *  lower hemisphere (bounce light onto facades) and the virtual ground beyond the city. */
const GROUND_ALBEDO = new THREE.Color(0.19, 0.18, 0.155);
/** Albedo of the open polder (grass/ditches/farms) the virtual ground shows beyond the backdrop ground. */
const POLDER_ALBEDO = new THREE.Color(0.105, 0.14, 0.075);
/** Distance from the city centre (m) over which the virtual ground turns from street to polder. */
const POLDER_RANGE = [1800, 3200] as const;
/** Fraction of the ground that is sunlit (streets are partly shadowed). */
const GROUND_SUNLIT = 0.65;
/** Minimum fog density (exp2, 1/m): light Dutch summer haze (50 % at ~1.65 km). */
const FOG_BASE_DENSITY = 0.0005;
/** Fog reaches ~93 % at this multiple of quality.drawDistance (so the world never ends abruptly). */
const FOG_DRAW_FRACTION = 1.05;
/** Height falloff of the fog density (1/m): ~e^-1 at 700 m above street level. */
const FOG_HEIGHT_FALLOFF = 1 / 700;
/**
 * Aerial cameras (menu, overview): the street-level haze (tuned to hide the end of the world at
 * drawDistance) made the city fade to flat grey within ~700 m from 700 m up. Above street level the
 * density drops (x AERIAL_DENSITY_MIN at AERIAL_ALT_FULL m) and the haze colour shifts towards the
 * blue in-scatter colour of a clear day (looking down, the horizon sky is not behind the terrain).
 */
const AERIAL_ALT_START = 40;
const AERIAL_ALT_FULL = 450;
const AERIAL_DENSITY_MIN = 0.5;
const AERIAL_TINT = [0.8, 0.93, 1.22] as const;
/** Elevation (rad) over which the sky texture blends into the horizon haze. */
const HORIZON_BLEND = THREE.MathUtils.degToRad(3.2);

// ------------------------------------------------------------------------------------------------

/** public/assets/hdri/sky.json (written by tools/engine/fetch-hdri.mjs). */
export interface SkyInfo {
  id: string;
  full: { '1k': string; '2k': string };
  top: { file: string; width: number; height: number; elevMinDeg: number; elevMaxDeg: number };
  scale: number;
  worldSunAzimuthDeg: number;
  sun: { direction: number[]; elevationDeg: number; phiRad: number; irradiance: number[]; color: number[] };
  clampLuminance: number;
  skyIrradianceHorizontal: number[];
  sunToSkyRatio: number;
  bands: Record<'horizon' | 'low' | 'mid' | 'zenith' | 'below', number[]>;
  horizonByAzimuth: number[][];
}

/** Engine-side environment API (superset of the EnvironmentHandle contract). */
export interface EngineEnvironment extends EnvironmentHandle {
  /** The actual sun light: three's cascaded-shadow SunLight (same object as `sun`). */
  readonly sunLight: SunLight;
  readonly fog: THREE.FogExp2;
  /** Background sky dome (opaque, drawn after other opaque objects, depth = far plane). */
  readonly skyDome: THREE.Mesh;
  /** Linear HDR colour of the haze at the horizon, away from the sun (engine units). */
  readonly horizonColor: THREE.Color;
  /** Parsed sky.json (null until loaded / when missing). */
  readonly skyInfo: SkyInfo | null;
  /** Current fog visibility (m) at which distant objects are ~93 % fogged. */
  readonly visibility: number;
  /** Override the fog visibility (m); pass null to follow quality.drawDistance again. */
  setVisibility(meters: number | null): void;
  /** Compass bearing (deg, from north clockwise) of the sun. Rotates sky + IBL + light. */
  readonly sunAzimuthDeg: number;
  /** Applies a preset; resolves once a sky texture it needed is decoded and in place. */
  applyQuality(q: Readonly<EngineQualitySettings>): Promise<void>;
  /** Per-frame update (cheap). */
  update(camera: THREE.Camera): void;
  dispose(): void;
}

const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	// rotation-only view transform: the dome is infinitely far away
	gl_Position = projectionMatrix * vec4( mat3( viewMatrix ) * position, 1.0 );
	#ifdef USE_REVERSED_DEPTH_BUFFER
		gl_Position.z = 0.0;
	#else
		gl_Position.z = gl_Position.w;
	#endif
}
`;

const SKY_FRAGMENT = /* glsl */ `
uniform sampler2D tSky;
uniform float uHasSky;
uniform float uUOffset;
uniform vec2 uElev;
uniform float uSkyScale;
uniform float uFogDensity;
uniform vec4 uFogParams;
uniform vec3 uHorizon[ ${FOG_AZIMUTH_BINS} ];
uniform vec3 uGround;
uniform vec3 uGroundFar;
uniform vec2 uPolderRange;
uniform vec3 uZenith;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uHorizonBlend;
varying vec3 vDir;

vec3 hazeColor( const in vec3 dir ) {
	float a = atan( dir.z, dir.x ) * 0.15915494309 + 0.5;
	float fb = a * ${FOG_AZIMUTH_BINS}.0 - 0.5;
	float fl = floor( fb );
	int i0 = int( mod( fl, ${FOG_AZIMUTH_BINS}.0 ) );
	int i1 = int( mod( fl + 1.0, ${FOG_AZIMUTH_BINS}.0 ) );
	return max( mix( uHorizon[ i0 ], uHorizon[ i1 ], fb - fl ), vec3( 0.0 ) );
}

float fogFactor( const in vec3 rel ) {
	float dist = length( rel );
	float h = 1.0;
	if ( uFogParams.x > 0.0 ) {
		float y0 = max( cameraPosition.y - uFogParams.y, 0.0 );
		float k = uFogParams.x * rel.y;
		h = exp( - uFogParams.x * y0 ) * ( abs( k ) > 1e-3 ? ( 1.0 - exp( - k ) ) / k : 1.0 - 0.5 * k );
	}
	float d = uFogDensity * dist;
	return 1.0 - exp( - d * d * h );
}

void main() {
	vec3 d = normalize( vDir );
	vec3 haze = hazeColor( d );
	vec3 col;
	if ( d.y >= 0.0 ) {
		float el = asin( clamp( d.y, 0.0, 1.0 ) );
		vec3 sky;
		if ( uHasSky > 0.5 ) {
			vec2 uv = vec2( atan( d.z, d.x ) * 0.15915494309 + 0.5 - uUOffset, ( el - uElev.x ) / ( uElev.y - uElev.x ) );
			sky = texture2D( tSky, uv ).rgb * uSkyScale;
		} else {
			// analytic fallback while the HDRI loads
			sky = mix( haze, uZenith, pow( d.y, 0.45 ) );
			float s = max( dot( d, uSunDir ), 0.0 );
			sky += uSunColor * ( pow( s, 2000.0 ) * 400.0 + pow( s, 12.0 ) * 0.35 );
		}
		float w = 1.0 - smoothstep( 0.0, uHorizonBlend, el );
		col = mix( sky, haze, w * w * ( 3.0 - 2.0 * w ) );
	} else {
		// infinite virtual ground plane at street level, fogged exactly like the geometry
		float camH = max( cameraPosition.y - uFogParams.y, 0.25 );
		float dist = min( camH / max( - d.y, 1e-5 ), 1e5 );
		vec2 hit = cameraPosition.xz + d.xz * dist;
		vec3 ground = mix( uGround, uGroundFar, smoothstep( uPolderRange.x, uPolderRange.y, length( hit ) ) );
		col = mix( ground, haze, fogFactor( d * dist ) );
	}
	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** Compass bearing + elevation -> world direction towards the sun (x east, z south). */
function sunWorldDirection(azimuthDeg: number, elevationDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const a = THREE.MathUtils.degToRad(azimuthDeg);
  const e = THREE.MathUtils.degToRad(elevationDeg);
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/** Builds the IBL source equirect (half float RGBA) from the raw 1k HDRI. */
function buildIblEquirect(
  src: { width: number; height: number; data: Float32Array },
  info: SkyInfo,
  uOffset: number,
  horizonAt: (phi: number, out: THREE.Color) => THREE.Color,
  ground: THREE.Color,
): THREE.DataTexture {
  const { width: w, height: h, data } = src;
  const out = new Uint16Array(w * h * 4);
  const scale = info.scale;
  const clampL = info.clampLuminance * scale;
  const toHalf = THREE.DataUtils.toHalfFloat;
  const haze = new THREE.Color();
  const blendEl = HORIZON_BLEND;
  for (let y = 0; y < h; y++) {
    const el = (0.5 - (y + 0.5) / h) * Math.PI;
    for (let x = 0; x < w; x++) {
      const uw = (x + 0.5) / w;
      const phi = (uw - 0.5) * Math.PI * 2;
      let r: number; let g: number; let b: number;
      horizonAt(phi, haze);
      if (el > 0) {
        // horizontally resample (rotation about +y == shift in u)
        let fx = (uw - uOffset) * w - 0.5;
        fx -= Math.floor(fx / w) * w;
        const x0 = Math.floor(fx);
        const x1 = (x0 + 1) % w;
        const t = fx - x0;
        const o0 = (y * w + x0) * 4;
        const o1 = (y * w + x1) * 4;
        r = (data[o0] * (1 - t) + data[o1] * t) * scale;
        g = (data[o0 + 1] * (1 - t) + data[o1 + 1] * t) * scale;
        b = (data[o0 + 2] * (1 - t) + data[o1 + 2] * t) * scale;
        const l = lum(r, g, b);
        if (l > clampL) {
          const k = clampL / l; // remove the sun: the SunLight provides it (with shadows)
          r *= k; g *= k; b *= k;
        }
        const wv = 1 - THREE.MathUtils.smoothstep(el, 0, blendEl);
        const m = wv * wv * (3 - 2 * wv);
        r += (haze.r - r) * m; g += (haze.g - g) * m; b += (haze.b - b) * m;
      } else {
        // lower hemisphere: lit ground seen through haze near the horizon
        const t = THREE.MathUtils.smoothstep(-el, 0, THREE.MathUtils.degToRad(8));
        r = haze.r + (ground.r - haze.r) * t;
        g = haze.g + (ground.g - haze.g) * t;
        b = haze.b + (ground.b - haze.b) * t;
      }
      const o = (y * w + x) * 4;
      out[o] = toHalf(r);
      out[o + 1] = toHalf(g);
      out[o + 2] = toHalf(b);
      out[o + 3] = 0x3c00; // 1.0
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = true; // row 0 = top, like the HDR file
  tex.needsUpdate = true;
  return tex;
}

/** Small analytic equirect used as IBL until (or if) the HDRI is unavailable. */
function buildFallbackEquirect(horizon: THREE.Color, zenith: THREE.Color, ground: THREE.Color): THREE.DataTexture {
  const w = 64; const h = 32;
  const out = new Uint16Array(w * h * 4);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const el = (0.5 - (y + 0.5) / h) * Math.PI;
    if (el >= 0) c.copy(horizon).lerp(zenith, Math.pow(Math.sin(el), 0.45));
    else c.copy(horizon).lerp(ground, THREE.MathUtils.smoothstep(-el, 0, 0.14));
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = THREE.DataUtils.toHalfFloat(c.r);
      out[o + 1] = THREE.DataUtils.toHalfFloat(c.g);
      out[o + 2] = THREE.DataUtils.toHalfFloat(c.b);
      out[o + 3] = 0x3c00;
    }
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

async function loadArrayBuffer(url: string): Promise<ArrayBuffer> {
  const loader = new THREE.FileLoader();
  loader.setResponseType('arraybuffer');
  return (await loader.loadAsync(url)) as ArrayBuffer;
}

interface ParsedHdr { width: number; height: number; data: Float32Array | Uint16Array }

export function createEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  fogUniforms: AerialFogUniforms,
  initialQuality: Readonly<EngineQualitySettings>,
  options: { loadHdri?: boolean } = {},
): EngineEnvironment {
  const hdriUrl = `${ASSETS_URL}hdri/`;

  // --- defaults (used until sky.json is loaded, and as fallback) ---------------------------------
  let sunAzimuthDeg = 235;
  let sunElevationDeg = 42;
  const sunDirection = sunWorldDirection(sunAzimuthDeg, sunElevationDeg, new THREE.Vector3());
  const horizonColor = new THREE.Color(0.3, 0.32, 0.4);
  const zenithColor = new THREE.Color(0.2, 0.3, 0.55);
  const groundColor = new THREE.Color();
  const polderColor = new THREE.Color();
  const sunColor = new THREE.Color(1, 0.96, 0.88);

  // --- sun ---------------------------------------------------------------------------------------
  const sunLight = new SunLight(sunColor, 4 * SUN_BOOST);
  sunLight.name = 'sun';
  sunLight.position.copy(sunDirection);
  // DirectionalLight-like `target` for code written against the contract type (no effect).
  (sunLight as unknown as { target: THREE.Object3D }).target = new THREE.Object3D();
  scene.add(sunLight);

  // --- fog ---------------------------------------------------------------------------------------
  const fog = new THREE.FogExp2(horizonColor.getHex(), FOG_BASE_DENSITY);
  fog.color.copy(horizonColor);
  scene.fog = fog;
  fogUniforms.params[0] = FOG_HEIGHT_FALLOFF;
  fogUniforms.params[1] = 0;
  fogUniforms.params[2] = 1; // horizon table valid
  let visibilityOverride: number | null = null;
  let visibility = 2000;
  /** street-level density (fog.density is this scaled by the camera altitude every frame) */
  let baseDensity = FOG_BASE_DENSITY;
  /** HDRI horizon table (fogUniforms.horizon = this, tinted by the camera altitude) */
  const baseHorizon = new Float32Array(FOG_AZIMUTH_BINS * 3);
  let aerial = -1;
  const camWorld = new THREE.Vector3();
  function applyAerial(a: number): void {
    aerial = a;
    for (let i = 0; i < FOG_AZIMUTH_BINS * 3; i++) {
      fogUniforms.horizon[i] = baseHorizon[i] * (1 + (AERIAL_TINT[i % 3] - 1) * a);
    }
  }

  // --- sky dome ----------------------------------------------------------------------------------
  const skyUniforms = {
    tSky: { value: null as THREE.Texture | null },
    uHasSky: { value: 0 },
    uUOffset: { value: 0 },
    uElev: { value: new THREE.Vector2(-Math.PI / 2, Math.PI / 2) },
    uSkyScale: { value: 1 },
    uFogDensity: { value: fog.density },
    uFogParams: { value: fogUniforms.params },
    uHorizon: { value: fogUniforms.horizon },
    uGround: { value: groundColor },
    uGroundFar: { value: polderColor },
    uPolderRange: { value: new THREE.Vector2(POLDER_RANGE[0], POLDER_RANGE[1]) },
    uZenith: { value: zenithColor },
    uSunDir: { value: sunDirection },
    uSunColor: { value: sunColor },
    uHorizonBlend: { value: HORIZON_BLEND },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    name: 'SkyDome',
    uniforms: skyUniforms,
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const skyDome = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skyMaterial);
  skyDome.name = 'SkyDome';
  skyDome.frustumCulled = false;
  skyDome.matrixAutoUpdate = false;
  skyDome.renderOrder = 1e9; // after other opaque objects: only visible pixels are shaded
  skyDome.raycast = () => {};
  scene.add(skyDome);
  scene.background = null;

  // --- horizon table ---------------------------------------------------------------------------------
  // sky.json horizon bins are over the image azimuth; the table is over world azimuth.
  let info: SkyInfo | null = null;
  let uOffset = 0;
  const tmpC = new THREE.Color();
  function horizonAt(phiWorld: number, out: THREE.Color): THREE.Color {
    if (!info) return out.copy(horizonColor);
    const bins = info.horizonByAzimuth;
    const n = bins.length;
    const phiImg = phiWorld - uOffset * Math.PI * 2;
    let f = ((phiImg + Math.PI) / (Math.PI * 2)) * n - 0.5;
    f -= Math.floor(f / n) * n;
    const i0 = Math.floor(f) % n;
    const i1 = (i0 + 1) % n;
    const t = f - Math.floor(f);
    const s = info.scale;
    return out.setRGB(
      (bins[i0][0] * (1 - t) + bins[i1][0] * t) * s,
      (bins[i0][1] * (1 - t) + bins[i1][1] * t) * s,
      (bins[i0][2] * (1 - t) + bins[i1][2] * t) * s,
    );
  }
  function updateHorizonTable(): void {
    // fog.color (used by tools that read scene.fog) = darkest bin (away from the sun); the shader
    // table stores absolute linear colours
    if (info) {
      let minL = Infinity;
      for (let i = 0; i < FOG_AZIMUTH_BINS; i++) {
        horizonAt(((i + 0.5) / FOG_AZIMUTH_BINS - 0.5) * Math.PI * 2, tmpC);
        const l = lum(tmpC.r, tmpC.g, tmpC.b);
        if (l < minL) { minL = l; horizonColor.copy(tmpC); }
      }
    }
    for (let i = 0; i < FOG_AZIMUTH_BINS; i++) {
      horizonAt(((i + 0.5) / FOG_AZIMUTH_BINS - 0.5) * Math.PI * 2, tmpC);
      baseHorizon[i * 3] = tmpC.r;
      baseHorizon[i * 3 + 1] = tmpC.g;
      baseHorizon[i * 3 + 2] = tmpC.b;
    }
    applyAerial(Math.max(0, aerial));
    fog.color.copy(horizonColor);
  }

  function updateSunAndGround(): void {
    sunWorldDirection(sunAzimuthDeg, sunElevationDeg, sunDirection);
    sunLight.position.copy(sunDirection);
    sunLight.updateMatrixWorld();
    // street-level ground radiance (Lambert, partly shadowed)
    const eSun = sunLight.intensity * Math.max(sunDirection.y, 0) * GROUND_SUNLIT;
    const skyE = info ? lum(...(info.skyIrradianceHorizontal as [number, number, number])) * info.scale * ENV_INTENSITY : 1.2;
    groundColor.setRGB(
      (GROUND_ALBEDO.r * (eSun * sunLight.color.r + skyE)) / Math.PI,
      (GROUND_ALBEDO.g * (eSun * sunLight.color.g + skyE)) / Math.PI,
      (GROUND_ALBEDO.b * (eSun * sunLight.color.b + skyE)) / Math.PI,
    );
    const eOpen = eSun / GROUND_SUNLIT; // open fields: no street shadows
    polderColor.setRGB(
      (POLDER_ALBEDO.r * (eOpen * sunLight.color.r + skyE)) / Math.PI,
      (POLDER_ALBEDO.g * (eOpen * sunLight.color.g + skyE)) / Math.PI,
      (POLDER_ALBEDO.b * (eOpen * sunLight.color.b + skyE)) / Math.PI,
    );
  }

  // --- IBL -----------------------------------------------------------------------------------------
  let envTarget: THREE.WebGLRenderTarget | null = null;
  let handleRef: EngineEnvironment | null = null;
  const pmrem = new THREE.PMREMGenerator(renderer);
  function setEnvironmentFrom(equirect: THREE.DataTexture): void {
    const target = pmrem.fromEquirectangular(equirect);
    equirect.dispose();
    envTarget?.dispose();
    envTarget = target;
    scene.environment = target.texture;
    scene.environmentIntensity = ENV_INTENSITY;
    if (handleRef) handleRef.envMap = target.texture;
  }

  // --- background sky texture (by quality) --------------------------------------------------------
  let skyTex: THREE.DataTexture | null = null;
  let skyTexHiRes: boolean | null = null;
  let skyLoadToken = 0;
  async function loadSkyTexture(hiRes: boolean): Promise<void> {
    if (!info || skyTexHiRes === hiRes) return;
    const token = ++skyLoadToken;
    const loader = new HDRLoader().setDataType(THREE.HalfFloatType);
    const file = hiRes ? info.top.file : info.full['2k'];
    const parsed = loader.parse(await loadArrayBuffer(hdriUrl + file)) as unknown as ParsedHdr;
    if (token !== skyLoadToken) return; // superseded
    const w = parsed.width;
    let rows = parsed.height;
    let elevMinDeg = hiRes ? info.top.elevMinDeg : -90;
    if (!hiRes) {
      // crop the full equirect to the upper hemisphere + 10 degrees (row 0 = top)
      rows = Math.min(parsed.height, Math.ceil(parsed.height * (0.5 + 10 / 180)));
      elevMinDeg = 90 - (180 * rows) / parsed.height;
    }
    const data = (parsed.data as Uint16Array).slice(0, rows * w * 4);
    const tex = new THREE.DataTexture(data, w, rows, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.flipY = true;
    tex.needsUpdate = true;
    skyTex?.dispose();
    skyTex = tex;
    skyTexHiRes = hiRes;
    skyUniforms.tSky.value = tex;
    skyUniforms.uElev.value.set(THREE.MathUtils.degToRad(elevMinDeg), Math.PI / 2);
    skyUniforms.uSkyScale.value = info.scale;
    skyUniforms.uHasSky.value = 1;
  }

  // --- quality -----------------------------------------------------------------------------------
  let quality: Readonly<EngineQualitySettings> = initialQuality;
  function updateFogDensity(): void {
    visibility = visibilityOverride ?? quality.drawDistance * FOG_DRAW_FRACTION;
    // exp2: 1 - exp(-(d*V)^2) = 0.93  ->  d = 1.63 / V
    baseDensity = Math.max(FOG_BASE_DENSITY, 1.63 / Math.max(200, visibility));
    fog.density = baseDensity * (1 - (1 - AERIAL_DENSITY_MIN) * Math.max(0, aerial));
    skyUniforms.uFogDensity.value = fog.density;
  }
  function applyQuality(q: Readonly<EngineQualitySettings>): Promise<void> {
    quality = q;
    const size = q.shadowMapSize;
    sunLight.castShadow = size > 0;
    if (size > 0) {
      const sh = sunLight.shadow;
      sh.mapSize.set(size, size); // WebGLShadowMap resizes the atlas when this changes
      sh.camera.far = q.shadowDistance;
      sh.camera.updateProjectionMatrix();
      // Bias in world metres along the normal, scaled with the far-cascade texel size.
      const farTexel = (q.shadowDistance * 1.1) / size;
      sh.normalBias = THREE.MathUtils.clamp(farTexel * 0.3, 0.015, 0.06);
      // depth bias sign flips with a reversed depth buffer (three's PCF path adds it to z)
      const reversed = renderer.capabilities.reversedDepthBuffer;
      sh.bias = reversed ? 0.00002 : -0.00002;
      sh.radius = size >= 4096 ? 2.5 : size >= 2048 ? 2 : 1.5;
    }
    updateFogDensity();
    // Live switch to a lower level keeps an already decoded 4k sky (decoding the 2k file again
    // would only cost a main-thread hitch); the 4k sky is decoded when a level needs it.
    if (!info || (skyTexHiRes === true && !q.skyHiRes)) return Promise.resolve();
    return loadSkyTexture(q.skyHiRes).catch((e) => console.error('[environment] sky texture', e));
  }

  // --- loading -----------------------------------------------------------------------------------
  async function load(): Promise<void> {
    const t0 = performance.now();
    const json = (await new THREE.FileLoader().loadAsync(hdriUrl + 'sky.json')) as string;
    const parsedInfo = JSON.parse(json) as SkyInfo;
    info = parsedInfo;
    sunAzimuthDeg = parsedInfo.worldSunAzimuthDeg;
    sunElevationDeg = parsedInfo.sun.elevationDeg;
    sunWorldDirection(sunAzimuthDeg, sunElevationDeg, sunDirection);
    const phiWorld = Math.atan2(sunDirection.z, sunDirection.x);
    uOffset = (phiWorld - parsedInfo.sun.phiRad) / (Math.PI * 2);
    skyUniforms.uUOffset.value = uOffset;

    const c = parsedInfo.sun.color;
    sunColor.setRGB(c[0], c[1], c[2]).multiply(SUN_WARMTH);
    sunLight.color.copy(sunColor);
    sunLight.intensity = lum(...(parsedInfo.sun.irradiance as [number, number, number])) * parsedInfo.scale * SUN_BOOST;
    const z = parsedInfo.bands.zenith;
    zenithColor.setRGB(z[0], z[1], z[2]).multiplyScalar(parsedInfo.scale);
    updateHorizonTable();
    updateSunAndGround();

    // background first (visible), then the IBL
    const skyPromise = loadSkyTexture(quality.skyHiRes);
    const iblLoader = new HDRLoader().setDataType(THREE.FloatType);
    const raw = iblLoader.parse(await loadArrayBuffer(hdriUrl + parsedInfo.full['1k'])) as unknown as ParsedHdr;
    const equirect = buildIblEquirect(
      { width: raw.width, height: raw.height, data: raw.data as Float32Array },
      parsedInfo,
      uOffset,
      horizonAt,
      groundColor,
    );
    setEnvironmentFrom(equirect);
    await skyPromise;
    console.info(`[environment] HDRI ${parsedInfo.id} geladen in ${Math.round(performance.now() - t0)} ms`);
  }

  // initial state: analytic fallback sky + IBL
  updateHorizonTable();
  updateSunAndGround();
  setEnvironmentFrom(buildFallbackEquirect(horizonColor, zenithColor, groundColor));

  const handle: EngineEnvironment = {
    sun: sunLight as unknown as THREE.DirectionalLight,
    sunLight,
    fill: null,
    envMap: null,
    sunDirection,
    ready: Promise.resolve(),
    fog,
    skyDome,
    horizonColor,
    get skyInfo() { return info; },
    get visibility() { return visibility; },
    get sunAzimuthDeg() { return sunAzimuthDeg; },
    setVisibility(m) {
      visibilityOverride = m;
      updateFogDensity();
    },
    applyQuality,
    update(camera) {
      camWorld.setFromMatrixPosition(camera.matrixWorld);
      const t = THREE.MathUtils.clamp((camWorld.y - fogUniforms.params[1] - AERIAL_ALT_START) / (AERIAL_ALT_FULL - AERIAL_ALT_START), 0, 1);
      const a = t * t * (3 - 2 * t);
      if (Math.abs(a - aerial) > 1e-3 || (a === 0 && aerial !== 0) || (a === 1 && aerial !== 1)) applyAerial(a);
      fog.density = baseDensity * (1 - (1 - AERIAL_DENSITY_MIN) * a);
      skyUniforms.uFogDensity.value = fog.density;
    },
    dispose() {
      scene.remove(skyDome, sunLight);
      skyMaterial.dispose();
      skyDome.geometry.dispose();
      skyTex?.dispose();
      envTarget?.dispose();
      pmrem.dispose();
      sunLight.dispose();
    },
  };
  handleRef = handle;
  handle.envMap = envTarget ? (envTarget as THREE.WebGLRenderTarget).texture : null;
  void applyQuality(initialQuality);
  handle.ready = options.loadHdri === false
    ? Promise.resolve()
    : load().catch((e) => {
      console.error('[environment] HDRI kon niet geladen worden, analytische lucht wordt gebruikt:', e);
    });
  return handle;
}
