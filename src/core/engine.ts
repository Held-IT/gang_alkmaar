// Engine: WebGL2 renderer (reversed depth when available), frame loop with prioritised update
// callbacks, environment (HDRI sky, IBL, cascaded sun shadows, aerial fog), post-processing and
// quality presets. Implements the Engine contract (src/contracts.ts); extras are on EngineExt.
//
// URL parameters handled here (all optional):
//   ?quality=laag|midden|hoog|ultra   quality preset (not persisted)
//   ?q_ao=0&q_bloom=0&q_scale=0.75... per-field overrides (see quality.ts parseUrlOverrides)
//   ?tm=agx|aces|neutral              tone mapper (default agx)
//   ?exposure=1.0                     exposure override
//   ?rdepth=0                         disable the reversed depth buffer (debugging)
//   ?hdri=0                           skip the HDRI (analytic fallback sky, debugging)
//   ?aa_mode=smaa-low|smaa-medium|smaa-high|smaa-ultra|fxaa   post-AA implementation (debugging)
import * as THREE from 'three';
import type { Engine, EngineStats, QualityLevel, QualitySettings, UpdateFn } from '../contracts';
import { createEnvironment, type EngineEnvironment } from './environment';
import { installAerialFog } from './fog';
import { createPostFX, type PostAAMode, type PostFX, type ToneMapper } from './postfx';
import {
  DynamicResolution,
  DYNRES_FLOOR,
  type EngineQualitySettings,
  getGpuName,
  isQualityLevel,
  presetFor,
  resolveInitialQuality,
  saveQuality,
} from './quality';

export type { EngineQualitySettings } from './quality';
export type { EngineEnvironment } from './environment';

/** Default exposure for the AgX tone mapper with the normalised HDRI (sun = 4.0). */
const DEFAULT_EXPOSURE = 0.85;
/** Drawing-buffer pixel budget per level before renderScale (1080p = 2.07 M). */
const MAX_PIXELS: Record<QualityLevel, number> = { laag: 1.3e6, midden: 1.6e6, hoog: 2.1e6, ultra: 3.7e6 };
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 6000;

/** Engine with the engine-module extras. Use `asEngineExt(engine)` to access them. */
export interface EngineExt extends Engine {
  readonly quality: Readonly<EngineQualitySettings>;
  readonly env: EngineEnvironment;
  readonly postfx: PostFX;
  /** Unmasked GPU name from WebGL, e.g. "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER ...)". */
  readonly gpu: string;
  /** Level the auto-detection picked for this GPU. */
  readonly detectedQuality: QualityLevel;
  /** True when the renderer uses a reversed (float) depth buffer (shaders: USE_REVERSED_DEPTH_BUFFER). */
  readonly reversedDepth: boolean;
  /** renderScale x dynamic-resolution factor currently in use. */
  readonly effectiveRenderScale: number;
  setQuality(q: Partial<EngineQualitySettings>): void;
  /**
   * Non-null while a quality change is being applied: new shader variants compile in parallel
   * (KHR_parallel_shader_compile) and the frame loop keeps showing the last frame until they are
   * ready, instead of freezing the main thread for seconds on the first render.
   */
  readonly applying: Promise<void> | null;
  /** Tone-mapping exposure (default 0.85; the 'laag' direct path compensates internally). */
  exposure: number;
  /** Debug: number of live onUpdate callbacks (leak checks). */
  readonly updateCount: number;
  /** Last point passed to setFocus() (the player). Shadows follow the camera frustum instead. */
  readonly focus: THREE.Vector3;
}

export function asEngineExt(engine: Engine): EngineExt {
  return engine as EngineExt;
}

interface UpdateEntry { fn: UpdateFn; priority: number; order: number; dead: boolean; errors: number }

export async function createEngine(canvas: HTMLCanvasElement): Promise<Engine> {
  const params = new URLSearchParams(location.search);
  const fogUniforms = installAerialFog(); // before any material compiles

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // AA is done in post (SMAA / MSAA render targets)
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    // reversed float depth: no z-fighting of decals / curbs at a distance; falls back
    // automatically without EXT_clip_control. ?rdepth=0 disables it (debugging).
    reversedDepthBuffer: params.get('rdepth') !== '0',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = DEFAULT_EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false; // stats count the whole frame incl. shadow + post passes
  renderer.setClearColor(0x000000, 1);

  const gpu = getGpuName(renderer.getContext());
  const initial = resolveInitialQuality(gpu, params);
  const quality: EngineQualitySettings = initial.settings;

  const scene = new THREE.Scene();
  scene.name = 'main';
  let camera = new THREE.PerspectiveCamera(60, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 1.6, 10);

  const env = createEnvironment(renderer, scene, fogUniforms, quality, { loadHdri: params.get('hdri') !== '0' });
  const tmParam = params.get('tm');
  const toneMapper: ToneMapper = tmParam === 'aces' || tmParam === 'neutral' ? tmParam : 'agx';
  // debug grade overrides: ?g_con=0.2&g_sat=1.1&g_vig=0.16
  const gradeOverrides: Record<string, number> = {};
  for (const [k, name] of [['g_con', 'contrast'], ['g_sat', 'saturation'], ['g_vig', 'vignette']] as const) {
    const v = Number(params.get(k));
    if (params.has(k) && Number.isFinite(v)) gradeOverrides[name] = v;
  }
  const aaParam = params.get('aa_mode');
  const aaModes: PostAAMode[] = ['smaa-low', 'smaa-medium', 'smaa-high', 'smaa-ultra', 'fxaa'];
  const aaOverride = aaModes.includes(aaParam as PostAAMode) ? (aaParam as PostAAMode) : null;
  const postfx = createPostFX(renderer, scene, camera, quality, toneMapper, gradeOverrides, aaOverride);
  const exposureParam = Number(params.get('exposure'));
  let exposure = Number.isFinite(exposureParam) && exposureParam > 0 ? exposureParam : DEFAULT_EXPOSURE;

  const focus = new THREE.Vector3();
  const qualityListeners = new Set<(q: Readonly<QualitySettings>) => void>();
  let updates: UpdateEntry[] = [];
  let updatesDirty = false;
  let updateOrder = 0;
  const stats: EngineStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0 };
  const dynRes = new DynamicResolution(55, DYNRES_FLOOR[quality.level]);

  const timer = new THREE.Timer();
  timer.connect(document);
  let running = false;
  let rafId = 0;
  let elapsed = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;

  // --- sizing ------------------------------------------------------------------------------------
  let cssW = 0;
  let cssH = 0;
  let appliedRatio = 0;
  let sizeDirty = true;
  function effectiveScale(): number {
    return quality.renderScale * (quality.dynamicResolution ? dynRes.factor : 1);
  }
  function resize(): void {
    sizeDirty = false;
    const w = Math.max(1, Math.floor(canvas.clientWidth || window.innerWidth));
    const h = Math.max(1, Math.floor(canvas.clientHeight || window.innerHeight));
    // Native resolution up to a pixel budget per level (a 1440p / 4K screen renders ~1080p on
    // 'hoog' and is upscaled), then renderScale / dynamic resolution on top.
    const budgetRatio = Math.sqrt(MAX_PIXELS[quality.level] / (w * h));
    const base = THREE.MathUtils.clamp(Math.min(window.devicePixelRatio || 1, budgetRatio), 0.5, 2);
    const ratio = Math.round(base * effectiveScale() * 1000) / 1000;
    if (w === cssW && h === cssH && ratio === appliedRatio) {
      if (camera.aspect !== w / h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
      return;
    }
    cssW = w;
    cssH = h;
    appliedRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    postfx.setSize(w, h);
  }
  const markDirty = (): void => { sizeDirty = true; };
  window.addEventListener('resize', markDirty);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(markDirty).observe(canvas);

  // --- quality -----------------------------------------------------------------------------------
  function applyQuality(): Promise<void> {
    const sky = env.applyQuality(quality);
    postfx.applyQuality(quality);
    dynRes.minFactor = DYNRES_FLOOR[quality.level];
    if (!quality.dynamicResolution) dynRes.reset();
    sizeDirty = true;
    return sky;
  }

  // Live quality switch: precompile the program variants the new settings need (e.g. the direct
  // laag path renders to the screen with tone mapping in every material = a full new program set,
  // ~2.5-9 s of synchronous compiles on the first frame) and hold rendering until they are ready.
  let applying: Promise<void> | null = null;
  let applyToken = 0;
  let holdRender = false;
  let compileTarget: THREE.WebGLRenderTarget | null = null;
  const applyNotice = createApplyNotice(canvas);
  function precompile(token: number, sky: Promise<void>): Promise<void> {
    holdRender = true;
    const noticeTimer = window.setTimeout(() => { if (token === applyToken) applyNotice.show(); }, 120);
    syncCamera();
    let compiled: Promise<unknown> = Promise.resolve();
    // program parameters depend on the bound target: screen (tone mapping + sRGB in the material)
    // for the direct path, an offscreen HDR buffer (composer, water reflection) otherwise
    compileTarget ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(postfx.active ? compileTarget : null);
      compiled = renderer.compileAsync(scene, camera); // (the water reflection pass uses the offscreen set)
    } catch (e) {
      console.error('[engine] precompile failed:', e);
    } finally {
      renderer.setRenderTarget(prev);
    }
    const limit = new Promise<void>((res) => window.setTimeout(res, 20000)); // never hang the game
    return Promise.race([Promise.all([compiled, sky]).then(() => undefined), limit]).finally(() => {
      window.clearTimeout(noticeTimer);
      if (token !== applyToken) return;
      holdRender = false;
      applying = null;
      applyNotice.hide();
    });
  }

  // --- frame -------------------------------------------------------------------------------------
  function syncCamera(): void {
    if (engine.camera !== camera) {
      // scenes may assign their own camera (use near 0.1 / far 6000 like the default one)
      camera = engine.camera;
      postfx.setCamera(camera);
      sizeDirty = true;
    }
  }

  function renderFrame(dt: number): void {
    syncCamera();
    if (holdRender) return; // quality change: keep the last frame until the new shaders are ready
    if (sizeDirty) resize();
    env.update(camera);
    renderer.info.reset();
    renderer.toneMappingExposure = exposure * postfx.exposureScale;
    postfx.render(dt);
    stats.drawCalls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
  }

  function runUpdates(dt: number): void {
    if (updatesDirty) {
      updates = updates.filter((u) => !u.dead);
      updates.sort((a, b) => a.priority - b.priority || a.order - b.order);
      updatesDirty = false;
    }
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      if (u.dead) continue;
      try {
        u.fn(dt, elapsed);
      } catch (e) {
        // keep the game running; report the first few errors of each callback
        if (u.errors++ < 3) console.error('[engine] update callback failed:', e);
      }
    }
  }

  function frame(time: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(frame);
    const cpuStart = performance.now();
    timer.update(time);
    const realDt = timer.getDelta();
    const dt = Math.min(realDt, 0.1);
    elapsed += dt;
    runUpdates(dt);
    renderFrame(dt);
    fpsAccum += realDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      stats.fps = fpsFrames / fpsAccum;
      stats.frameMs = (fpsAccum / fpsFrames) * 1000;
      fpsAccum = 0;
      fpsFrames = 0;
    }
    if (quality.dynamicResolution && !holdRender && dynRes.update(realDt, (performance.now() - cpuStart) / 1000)) {
      sizeDirty = true;
    }
  }

  const engine: EngineExt = {
    renderer,
    scene,
    camera,
    canvas,
    quality,
    env,
    stats,
    postfx,
    gpu,
    detectedQuality: initial.detected,
    focus,
    get reversedDepth() { return renderer.capabilities.reversedDepthBuffer; },
    get effectiveRenderScale() { return effectiveScale(); },
    get applying() { return applying; },
    get exposure() { return exposure; },
    get updateCount() { return updates.filter((u) => !u.dead).length; },
    set exposure(v: number) { exposure = Math.max(0.01, v); },
    onUpdate(fn, priority = 50) {
      const entry: UpdateEntry = { fn, priority, order: updateOrder++, dead: false, errors: 0 };
      updates.push(entry);
      updatesDirty = true;
      return () => {
        if (!entry.dead) { entry.dead = true; updatesDirty = true; }
      };
    },
    setFocus(p) {
      // SunLight cascades are fitted to the view frustum; the focus is kept for API compatibility.
      focus.copy(p);
    },
    setQuality(q) {
      if (q.level && q.level !== quality.level && isQualityLevel(q.level)) {
        // switching level: start from that preset, then apply the explicit overrides
        Object.assign(quality, presetFor(q.level));
      }
      for (const [k, v] of Object.entries(q)) {
        if (v !== undefined && k in quality) (quality as unknown as Record<string, unknown>)[k] = v;
      }
      quality.renderScale = THREE.MathUtils.clamp(quality.renderScale, 0.3, 1);
      saveQuality(quality);
      const sky = applyQuality();
      qualityListeners.forEach((l) => {
        try { l(quality); } catch (e) { console.error('[engine] quality listener failed:', e); }
      });
      // after the listeners: they may swap materials / add objects (water reflection, props, traffic)
      applying = precompile(++applyToken, sky);
    },
    onQualityChange(fn) {
      qualityListeners.add(fn);
      return () => { qualityListeners.delete(fn); };
    },
    start() {
      if (running) return;
      running = true;
      timer.reset();
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    renderOnce() {
      renderFrame(0);
    },
  };

  void applyQuality();
  resize();
  console.info(
    `[engine] GPU: ${gpu || 'onbekend'} | kwaliteit: ${quality.level} (${initial.source}, auto: ${initial.detected})` +
      ` | reversed depth: ${renderer.capabilities.reversedDepthBuffer}`,
  );
  return engine;
}

/** Small "Instellingen toepassen…" badge over the canvas while a quality change compiles. */
function createApplyNotice(canvas: HTMLCanvasElement): { show(): void; hide(): void } {
  let el: HTMLDivElement | null = null;
  return {
    show() {
      if (!el) {
        el = document.createElement('div');
        el.textContent = 'Instellingen toepassen…';
        el.setAttribute('role', 'status');
        el.style.cssText = 'position:fixed;left:50%;bottom:9%;transform:translateX(-50%);z-index:10000;' +
          'padding:10px 22px;border-radius:999px;background:rgba(12,16,22,0.78);color:#fff;' +
          'font:600 15px/1.2 system-ui,"Segoe UI",sans-serif;letter-spacing:.02em;pointer-events:none;' +
          'box-shadow:0 4px 18px rgba(0,0,0,.35)';
      }
      if (!el.isConnected) (canvas.parentElement ?? document.body).appendChild(el);
    },
    hide() {
      el?.remove();
    },
  };
}
