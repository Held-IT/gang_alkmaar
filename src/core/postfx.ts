// Post-processing pipeline ('postprocessing' + n8ao):
//   RenderPass -> N8AO (screen-space AO, metre-scale) -> [Bloom, ToneMapping, Grade+Vignette] -> SMAA
// HalfFloat buffers keep the scene HDR until tone mapping. Quality toggles rebuild the pass list
// (rare). The 'laag' preset (no AO, no bloom, no AA) bypasses the composer completely.
import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  EdgeDetectionMode,
  Effect,
  FXAAEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { EngineQualitySettings } from './quality';

export type ToneMapper = 'agx' | 'aces' | 'neutral';
/** Post AA implementation used when quality.antialias === 'smaa' (debug override: ?aa_mode=). */
export type PostAAMode = 'smaa-low' | 'smaa-medium' | 'smaa-high' | 'smaa-ultra' | 'fxaa';

/** Tone mapping + exposure factor of the direct ('laag') path, matched to AgX + GradeEffect. */
const FAST_PATH_TONE_MAPPING = THREE.ACESFilmicToneMapping;
const FAST_PATH_EXPOSURE_SCALE = 1.0;

const TONE_MAPPERS: Record<ToneMapper, { pp: ToneMappingMode; three: THREE.ToneMapping }> = {
  agx: { pp: ToneMappingMode.AGX, three: THREE.AgXToneMapping },
  aces: { pp: ToneMappingMode.ACES_FILMIC, three: THREE.ACESFilmicToneMapping },
  neutral: { pp: ToneMappingMode.NEUTRAL, three: THREE.NeutralToneMapping },
};

// ------------------------------------------------------------------------------------------------
// Colour grade + vignette (runs after tone mapping, on display-referred linear values)
// ------------------------------------------------------------------------------------------------

const GRADE_FRAGMENT = /* glsl */ `
uniform float contrast;
uniform float saturation;
uniform vec3 gain;
uniform vec3 lift;
uniform vec2 vignette;

void mainImage( const in vec4 inputColor, const in vec2 uv, out vec4 outputColor ) {
	vec3 c = clamp( inputColor.rgb, 0.0, 1.0 );
	// gentle S-curve around mid grey in (approximately) perceptual space
	vec3 p = pow( c, vec3( 1.0 / 2.2 ) );
	vec3 s = p * p * ( 3.0 - 2.0 * p );
	p = mix( p, s, contrast );
	c = pow( max( p, 0.0 ), vec3( 2.2 ) );
	float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = max( mix( vec3( l ), c, saturation ), 0.0 );
	c = c * gain + lift * ( 1.0 - c );
	vec2 q = ( uv - 0.5 ) * vec2( 1.0, 0.82 );
	float v = 1.0 - vignette.x * smoothstep( vignette.y, 0.75, length( q ) );
	c *= v;
	// triangular dither (~1/255 in display space) against banding in smooth sky gradients
	vec2 fc = gl_FragCoord.xy;
	float n = fract( 52.9829189 * fract( dot( fc, vec2( 0.06711056, 0.00583715 ) ) ) )
		+ fract( 52.9829189 * fract( dot( fc + vec2( 47.0, 17.0 ), vec2( 0.06711056, 0.00583715 ) ) ) ) - 1.0;
	c += n * ( 1.0 / 255.0 ) * 2.2 * pow( max( c, vec3( 1e-4 ) ), vec3( 1.0 - 1.0 / 2.2 ) );
	outputColor = vec4( max( c, 0.0 ), inputColor.a );
}
`;

/** Default grade; tuned with src/scenes/dev-render.ts. */
export const GRADE_DEFAULTS = { contrast: 0.3, saturation: 1.15, vignette: 0.16 };

export class GradeEffect extends Effect {
  constructor(settings: Partial<typeof GRADE_DEFAULTS> = {}) {
    const g = { ...GRADE_DEFAULTS, ...settings };
    super('GradeEffect', GRADE_FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['contrast', new THREE.Uniform(g.contrast)],
        ['saturation', new THREE.Uniform(g.saturation)],
        ['gain', new THREE.Uniform(new THREE.Vector3(1.0, 0.995, 0.985))],
        ['lift', new THREE.Uniform(new THREE.Vector3(0.0, 0.002, 0.006))],
        ['vignette', new THREE.Uniform(new THREE.Vector2(g.vignette, 0.32))],
      ]),
    });
  }
  get contrast(): number { return this.uniforms.get('contrast')!.value as number; }
  set contrast(v: number) { this.uniforms.get('contrast')!.value = v; }
  get saturation(): number { return this.uniforms.get('saturation')!.value as number; }
  set saturation(v: number) { this.uniforms.get('saturation')!.value = v; }
  /** x = strength (0..1), y = inner radius. */
  get vignette(): THREE.Vector2 { return this.uniforms.get('vignette')!.value as THREE.Vector2; }
}

// ------------------------------------------------------------------------------------------------

export interface PostFX {
  /** true when the composer path renders the frame (false: direct render, 'laag'). */
  readonly active: boolean;
  readonly composer: EffectComposer;
  /** n8ao pass (null when AO is off). */
  readonly ao: N8AOPostPass | null;
  readonly bloom: BloomEffect | null;
  readonly grade: GradeEffect | null;
  readonly toneMapper: ToneMapper;
  /** Multiplier the engine applies to its exposure (matches the direct path to the graded look). */
  readonly exposureScale: number;
  render(dt: number): void;
  /** Call after the renderer's pixel ratio / size changed. */
  setSize(cssWidth: number, cssHeight: number): void;
  setCamera(camera: THREE.Camera): void;
  applyQuality(q: Readonly<EngineQualitySettings>): void;
  setToneMapper(t: ToneMapper): void;
  dispose(): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  initialCamera: THREE.Camera,
  initialQuality: Readonly<EngineQualitySettings>,
  toneMapper: ToneMapper = 'agx',
  gradeSettings: Partial<typeof GRADE_DEFAULTS> = {},
  aaOverride: PostAAMode | null = null,
): PostFX {
  let camera = initialCamera;
  let quality = initialQuality;
  let tm: ToneMapper = toneMapper;

  const composer = new EffectComposer(renderer, {
    frameBufferType: THREE.HalfFloatType,
    multisampling: 0,
    stencilBuffer: false,
  });
  renderer.autoClear = true; // EffectComposer switched it off; restored per frame in render()
  const renderPass = new RenderPass(scene, camera);

  let aoPass: N8AOPostPass | null = null;
  let effectPass: EffectPass | null = null;
  let smaaPass: EffectPass | null = null;
  let bloom: BloomEffect | null = null;
  let grade: GradeEffect | null = null;
  let active = false;
  let structureKey = '';

  const size = new THREE.Vector2();

  function configureAO(pass: N8AOPostPass, q: Readonly<EngineQualitySettings>): void {
    const c = pass.configuration;
    // metre-scale city: 2 m hemisphere, contact shadows at wall/ground junctions, no wide halos
    c.aoRadius = 2.0;
    c.distanceFalloff = 1.0;
    c.intensity = 3.5;
    c.aoTones = 0;
    c.screenSpaceRadius = false;
    c.gammaCorrection = false;
    c.colorMultiply = true;
    c.depthAwareUpsampling = true;
    c.halfRes = q.aoHalfRes;
    // 16 samples always: n8ao 2.0.1 patches the sample count into its shader by replacing the first
    // "16" in the source, and other counts measured ~2x SLOWER on the dev iGPU (15 vs 8 ms frame)
    c.aoSamples = 16;
    c.denoiseSamples = q.level === 'midden' ? 4 : 8;
    c.denoiseRadius = 12;
    c.denoiseIterations = 2;
    // n8ao 2.0.1 bug: the half-res depth downsample shader is created without the REVERSEDEPTH
    // define, so with a reversed depth buffer positions/normals become NaN (black frame).
    const dq = (pass as unknown as { depthDownsampleQuad?: { material: THREE.ShaderMaterial } | null }).depthDownsampleQuad;
    if (dq && renderer.capabilities.reversedDepthBuffer && dq.material.defines?.REVERSEDEPTH === undefined) {
      dq.material.defines = { ...dq.material.defines, REVERSEDEPTH: '' };
      dq.material.needsUpdate = true;
    }
  }

  function createAO(): N8AOPostPass {
    renderer.getDrawingBufferSize(size);
    const pass = new N8AOPostPass(scene, camera, size.x, size.y);
    // Transparency-aware mode traverses + re-renders the scene every frame: far too expensive here.
    // n8ao only switches its auto-detection off when the proxied value CHANGES, and writing false
    // over the default false is a no-op: detectTransparency() in render() would then turn it on as
    // soon as any transparent material exists (2 extra scene renders + 2 RGBA16F targets).
    pass.autoDetectTransparency = false;
    if (pass.configuration.transparencyAware) pass.configuration.transparencyAware = false;
    // n8ao copies its result into the composer buffer with a depth-tested full-screen triangle at
    // clip z = 0. With a reversed depth buffer that fails the GEQUAL test against the buffer's depth
    // attachment (black frame), so disable depth testing on its internal quads.
    const internal = pass as unknown as Record<string, { material?: THREE.Material } | undefined>;
    for (const key of ['copyQuad', 'effectCompositerQuad', 'accumulationQuad']) {
      const m = internal[key]?.material;
      if (m) { m.depthTest = false; m.depthWrite = false; }
    }
    return pass;
  }

  function rebuild(): void {
    const q = quality;
    active = q.ao || q.bloom || q.antialias !== 'off';
    // direct path has no grade pass: ACES' built-in contrast/saturation approximates AgX + grade
    renderer.toneMapping = active ? TONE_MAPPERS[tm].three : FAST_PATH_TONE_MAPPING;
    composer.removeAllPasses();
    effectPass?.dispose();
    smaaPass?.dispose();
    effectPass = null;
    smaaPass = null;
    bloom = null;
    grade = null;
    if (!active) return;

    const samples = q.antialias === 'msaa' ? 4 : 0;
    if (composer.multisampling !== samples) composer.multisampling = samples;

    composer.addPass(renderPass);
    if (q.ao) {
      if (!aoPass) aoPass = createAO();
      configureAO(aoPass, q);
      composer.addPass(aoPass);
    }
    const effects: Effect[] = [];
    if (q.bloom) {
      bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: 3.5,
        luminanceSmoothing: 1.5,
        intensity: 0.42,
        radius: 0.72,
        levels: 7,
      });
      effects.push(bloom);
    }
    effects.push(new ToneMappingEffect({ mode: TONE_MAPPERS[tm].pp }));
    grade = new GradeEffect(gradeSettings);
    effects.push(grade);
    effectPass = new EffectPass(camera, ...effects);
    composer.addPass(effectPass);
    if (q.antialias === 'smaa') {
      const mode: PostAAMode = aaOverride ?? (q.level === 'midden' ? 'smaa-medium' : 'smaa-high');
      const aa = mode === 'fxaa'
        ? new FXAAEffect()
        : new SMAAEffect({
          preset: { 'smaa-low': SMAAPreset.LOW, 'smaa-medium': SMAAPreset.MEDIUM, 'smaa-high': SMAAPreset.HIGH, 'smaa-ultra': SMAAPreset.ULTRA }[mode],
          edgeDetectionMode: EdgeDetectionMode.COLOR,
        });
      smaaPass = new EffectPass(camera, aa);
      composer.addPass(smaaPass);
    }
  }

  const fx: PostFX = {
    get active() { return active; },
    composer,
    get ao() { return active && quality.ao ? aoPass : null; },
    get bloom() { return bloom; },
    get grade() { return grade; },
    get toneMapper() { return tm; },
    get exposureScale() { return active ? 1 : FAST_PATH_EXPOSURE_SCALE; },
    render(dt) {
      if (active) {
        // postprocessing passes clear their own targets and expect autoClear off; outside the
        // composer the renderer keeps three's default (autoClear on) for other modules' renders
        renderer.autoClear = false;
        composer.render(dt);
        renderer.autoClear = true;
      } else {
        renderer.autoClear = true;
        renderer.render(scene, camera);
      }
    },
    setSize(cssWidth, cssHeight) {
      composer.setSize(cssWidth, cssHeight, false);
    },
    setCamera(cam) {
      camera = cam;
      composer.setMainCamera(cam);
      if (aoPass) (aoPass as unknown as { camera: THREE.Camera }).camera = cam;
    },
    applyQuality(q) {
      // the engine mutates one settings object in place: compare against a snapshot key
      quality = q;
      const key = `${q.ao}|${q.bloom}|${q.antialias}|${q.level}`;
      if (key !== structureKey) {
        structureKey = key;
        rebuild();
      } else if (aoPass && q.ao) {
        configureAO(aoPass, q);
      }
    },
    setToneMapper(t) {
      tm = t;
      rebuild();
    },
    dispose() {
      composer.removeAllPasses();
      effectPass?.dispose();
      smaaPass?.dispose();
      aoPass?.dispose();
      renderPass.dispose();
      composer.dispose();
    },
  };
  fx.applyQuality(initialQuality);
  return fx;
}
