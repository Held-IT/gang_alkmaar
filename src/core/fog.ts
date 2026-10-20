// Aerial-perspective fog for every built-in three.js material (and custom ShaderMaterials that use
// the standard fog chunks).
//
// scene.fog stays a THREE.FogExp2 (so n8ao and other tools recognise it), but the fog shader chunks
// are replaced globally with:
//   * exp2 density along the view ray, attenuated with height (exponential height falloff,
//     integrated analytically between camera and fragment),
//   * a direction-dependent fog colour: a 16-entry azimuth table of LINEAR horizon colours measured
//     from the HDRI, so distant buildings melt into the sky behind them. (three's own `fogColor`
//     uniform is not used for it: three encodes it to sRGB when rendering straight to the screen.)
//   * applied in linear HDR space before tone mapping (see APPLY below).
// The extra uniforms hold Float32Arrays that are shared BY REFERENCE between all materials
// (three's cloneUniforms copies only three.js objects / plain arrays), so updating them once per
// frame updates every material. Missing uniforms (custom shaders that only declare the standard
// fog uniforms) read as zero, which degrades gracefully to classic exp2 fog.
import * as THREE from 'three';

export const FOG_AZIMUTH_BINS = 16;

export interface AerialFogUniforms {
  /** x: height falloff (1/m, 0 = uniform), y: base height (m), z: 1 = horizon table valid, w: unused. */
  readonly params: Float32Array;
  /** 16 x vec3: linear horizon (fog) colour, indexed by world azimuth atan2(z, x). */
  readonly horizon: Float32Array;
}

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldRel;
#endif
`;

const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// camera-relative world position (view rotation inverted: v * M == transpose( M ) * v)
	vFogWorldRel = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
#endif
`;

const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldRel;
	#ifdef FOG_EXP2
		uniform float fogDensity;
		uniform vec4 fogParams;
		uniform vec3 fogHorizon[ ${FOG_AZIMUTH_BINS} ];
		vec3 aerialFogColor( const in vec3 dir ) {
			float a = atan( dir.z, dir.x ) * 0.15915494309 + 0.5;
			float fb = a * ${FOG_AZIMUTH_BINS}.0 - 0.5;
			float fl = floor( fb );
			int i0 = int( mod( fl, ${FOG_AZIMUTH_BINS}.0 ) );
			int i1 = int( mod( fl + 1.0, ${FOG_AZIMUTH_BINS}.0 ) );
			// a custom shader without the extra uniforms reads fogParams = 0: plain fogColor
			if ( fogParams.z < 0.5 ) return fogColor;
			return max( mix( fogHorizon[ i0 ], fogHorizon[ i1 ], fb - fl ), vec3( 0.0 ) );
		}
		float aerialFogFactor( const in vec3 rel ) {
			float dist = length( rel );
			float h = 1.0;
			if ( fogParams.x > 0.0 ) {
				float y0 = max( cameraPosition.y - fogParams.y, 0.0 );
				float k = fogParams.x * rel.y;
				h = exp( - fogParams.x * y0 ) * ( abs( k ) > 1e-3 ? ( 1.0 - exp( - k ) ) / k : 1.0 - 0.5 * k );
			}
			float d = fogDensity * dist;
			return 1.0 - exp( - d * d * h );
		}
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

// The exp2 aerial fog is applied in LINEAR HDR space, before tone mapping. three's built-in shaders
// include <tonemapping_fragment> and <colorspace_fragment> BEFORE <fog_fragment>; that is harmless
// when rendering into the composer's linear buffer (tone mapping is a no-op there) but wrong on the
// direct ('laag') path, where the HDR fog colour would be mixed into the already tone-mapped sRGB
// output (far too bright, with a seam against the sky dome). So the fog is applied by whichever of the
// two chunks comes first; AERIAL_FOG_DONE prevents applying it twice (custom shaders that only
// include <fog_fragment> still get fog). Linear THREE.Fog keeps three's behaviour (after encoding,
// because three encodes fogColor to the output colour space when rendering to the screen).
const APPLY_EXP2 = /* glsl */ `
#if defined( USE_FOG ) && defined( FOG_EXP2 ) && ! defined( AERIAL_FOG_DONE )
	#define AERIAL_FOG_DONE
	{
		float fogFactor = aerialFogFactor( vFogWorldRel );
		vec3 fogTint = aerialFogColor( normalize( vFogWorldRel + vec3( 0.0, 1e-4, 0.0 ) ) );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogTint, fogFactor );
	}
#endif
`;

const FOG_FRAGMENT = APPLY_EXP2 + /* glsl */ `
#if defined( USE_FOG ) && ! defined( FOG_EXP2 )
	{
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	}
#endif
`;

let installed: AerialFogUniforms | null = null;

/**
 * Installs the aerial fog chunks and uniforms (idempotent). Must run before materials compile —
 * the engine calls it from createEngine().
 */
export function installAerialFog(): AerialFogUniforms {
  if (installed) return installed;
  const params = new Float32Array([1 / 700, 0, 1, 0]);
  const horizon = new Float32Array(FOG_AZIMUTH_BINS * 3);
  THREE.ShaderChunk.fog_pars_vertex = PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  THREE.ShaderChunk.tonemapping_fragment = APPLY_EXP2 + THREE.ShaderChunk.tonemapping_fragment;

  const addTo = (u: Record<string, THREE.IUniform>): void => {
    u.fogParams = { value: params };
    u.fogHorizon = { value: horizon };
  };
  addTo(THREE.UniformsLib.fog as unknown as Record<string, THREE.IUniform>);
  for (const shader of Object.values(THREE.ShaderLib)) {
    if (shader.uniforms && 'fogDensity' in shader.uniforms) addTo(shader.uniforms);
  }
  installed = { params, horizon };
  return installed;
}

/** CPU twin of the GLSL fog factor (used by the sky shader and for tests). */
export function fogFactorCpu(density: number, heightFalloff: number, camY: number, relY: number, dist: number): number {
  let h = 1;
  if (heightFalloff > 0) {
    const y0 = Math.max(camY, 0);
    const k = heightFalloff * relY;
    h = Math.exp(-heightFalloff * y0) * (Math.abs(k) > 1e-3 ? (1 - Math.exp(-k)) / k : 1 - 0.5 * k);
  }
  const d = density * dist;
  return 1 - Math.exp(-d * d * h);
}
