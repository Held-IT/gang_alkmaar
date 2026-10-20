// Quality presets (laag / midden / hoog / ultra), GPU auto-detection, persistence and URL overrides.
//
// Priority of the initial settings:
//   1. URL  ?quality=<laag|midden|hoog|ultra>  (+ optional field overrides, see parseUrlOverrides)
//   2. localStorage 'alkmaar-drive-quality'   (written by engine.setQuality)
//   3. auto-detection from the WebGL renderer string
// The URL override is NOT persisted, so test/screenshot runs never change the user's choice.
import type { QualityLevel, QualitySettings } from '../contracts';

export const QUALITY_STORAGE_KEY = 'alkmaar-drive-quality';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['laag', 'midden', 'hoog', 'ultra'];

/** Dutch labels for menus. */
export const QUALITY_LABELS: Readonly<Record<QualityLevel, string>> = {
  laag: 'Laag',
  midden: 'Midden',
  hoog: 'Hoog',
  ultra: 'Ultra',
};

/**
 * Engine-specific extras on top of the shared QualitySettings contract.
 * Other modules only rely on the contract fields; these are optional for them.
 */
export interface EngineQualitySettings extends QualitySettings {
  /** Lower the internal resolution automatically when the frame rate drops below ~55 fps. */
  dynamicResolution: boolean;
  /** Screen-space AO at half resolution (cheaper). */
  aoHalfRes: boolean;
  /** Use the 4k sky texture (otherwise 2k). */
  skyHiRes: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, Readonly<EngineQualitySettings>>> = {
  laag: {
    level: 'laag',
    renderScale: 0.75,
    shadowMapSize: 1024,
    shadowDistance: 70,
    ao: false,
    aoHalfRes: true,
    bloom: false,
    waterReflections: 'env',
    antialias: 'off',
    drawDistance: 1200,
    trafficDensity: 0.4,
    propDensity: 0.4,
    anisotropy: 2,
    dynamicResolution: false,
    skyHiRes: false,
  },
  midden: {
    level: 'midden',
    renderScale: 1,
    shadowMapSize: 1024,
    shadowDistance: 140,
    ao: true,
    aoHalfRes: true,
    bloom: true,
    waterReflections: 'env',
    antialias: 'smaa',
    drawDistance: 1800,
    trafficDensity: 0.6,
    propDensity: 0.7,
    anisotropy: 4,
    dynamicResolution: false,
    skyHiRes: true,
  },
  hoog: {
    level: 'hoog',
    renderScale: 1,
    shadowMapSize: 2048,
    shadowDistance: 250,
    ao: true,
    aoHalfRes: true,
    bloom: true,
    waterReflections: 'planar',
    antialias: 'smaa',
    drawDistance: 2600,
    trafficDensity: 0.8,
    propDensity: 1,
    anisotropy: 8,
    // headroom for heavy views (Waag square + canal reflection) on a GTX 1660 Super: only lowers
    // the resolution when GPU-bound below ~50 fps, never below DYNRES_FLOOR.hoog
    dynamicResolution: true,
    skyHiRes: true,
  },
  ultra: {
    level: 'ultra',
    renderScale: 1,
    shadowMapSize: 4096,
    shadowDistance: 400,
    ao: true,
    aoHalfRes: false,
    bloom: true,
    waterReflections: 'planar',
    antialias: 'smaa',
    drawDistance: 3200,
    trafficDensity: 1,
    propDensity: 1,
    anisotropy: 16,
    dynamicResolution: false,
    skyHiRes: true,
  },
};

/** Lowest dynamic-resolution factor per level (on top of renderScale). */
export const DYNRES_FLOOR: Readonly<Record<QualityLevel, number>> = { laag: 0.6, midden: 0.7, hoog: 0.8, ultra: 0.85 };

export function isQualityLevel(v: unknown): v is QualityLevel {
  return typeof v === 'string' && (QUALITY_LEVELS as readonly string[]).includes(v);
}

export function presetFor(level: QualityLevel): EngineQualitySettings {
  return { ...QUALITY_PRESETS[level] };
}

/** Reads the unmasked GPU name (e.g. "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER ...)"). */
export function getGpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '');
    return String(gl.getParameter(gl.RENDERER) ?? '');
  } catch {
    return '';
  }
}

/**
 * Maps a GPU name to a default level:
 *   software renderers -> laag; integrated GPUs / APUs / unknown -> midden;
 *   dedicated GTX 10xx / 16xx, RTX, Radeon RX, Arc A-series -> hoog. Ultra is never chosen automatically.
 */
export function detectQualityLevel(gpuName: string): QualityLevel {
  const s = gpuName.toLowerCase();
  if (!s) return 'midden';
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(s)) return 'laag';
  // Integrated GPUs first (their names also contain "radeon"/"arc").
  const integrated =
    /intel\(r\) (hd|uhd|iris)|intel (hd|uhd|iris)|iris\(r\)|intel\(r\) graphics|intel graphics|intel\(r\) arc\(tm\) graphics|intel arc graphics/.test(s) ||
    /radeon\(tm\) graphics|radeon graphics|radeon vega \d+ graphics|radeon\(tm\) vega|radeon \d{3}m|radeon\(tm\) \d{3}m|radeon r[2-7] graphics/.test(s) ||
    /mali|adreno|powervr|apple m\d|apple gpu/.test(s);
  if (integrated) return 'midden';
  if (/geforce (rtx|gtx 1[0-9]{3}|gtx 9[6-8]0|gtx titan)|quadro (rtx|p[2-6]\d{3})|rtx a\d{4}|rtx \d{4}|titan (x|v|rtx)/.test(s)) return 'hoog';
  if (/radeon (rx|pro w|pro vega|vii)|rx ?[4-9]\d{2,3}|rx vega/.test(s)) return 'hoog';
  if (/arc\(tm\) a\d{3}|arc a\d{3}|arc\(tm\) b\d{3}|arc b\d{3}/.test(s)) return 'hoog';
  return 'midden';
}

const BOOL = (v: string): boolean => v === '1' || v === 'true' || v === 'on';

/**
 * Optional per-field URL overrides for testing, e.g. `?quality=hoog&q_ao=0&q_scale=0.75`:
 *   q_scale (renderScale), q_shadow (0|1024|2048|4096), q_shadowdist, q_ao, q_aohalf, q_bloom,
 *   q_aa (off|smaa|msaa), q_draw (drawDistance), q_dyn (dynamic resolution), q_water (env|planar).
 */
export function parseUrlOverrides(params: URLSearchParams): Partial<EngineQualitySettings> {
  const o: Partial<EngineQualitySettings> = {};
  const num = (k: string): number | undefined => {
    const v = params.get(k);
    if (v === null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const scale = num('q_scale');
  if (scale !== undefined) o.renderScale = Math.min(1, Math.max(0.3, scale));
  const sm = num('q_shadow');
  if (sm === 0 || sm === 1024 || sm === 2048 || sm === 4096) o.shadowMapSize = sm;
  const sd = num('q_shadowdist');
  if (sd !== undefined && sd > 5) o.shadowDistance = sd;
  const dd = num('q_draw');
  if (dd !== undefined && dd > 100) o.drawDistance = dd;
  if (params.has('q_ao')) o.ao = BOOL(params.get('q_ao')!);
  if (params.has('q_aohalf')) o.aoHalfRes = BOOL(params.get('q_aohalf')!);
  if (params.has('q_bloom')) o.bloom = BOOL(params.get('q_bloom')!);
  if (params.has('q_dyn')) o.dynamicResolution = BOOL(params.get('q_dyn')!);
  const aa = params.get('q_aa');
  if (aa === 'off' || aa === 'smaa' || aa === 'msaa') o.antialias = aa;
  const water = params.get('q_water');
  if (water === 'env' || water === 'planar') o.waterReflections = water;
  return o;
}

function readStored(): Partial<EngineQualitySettings> | null {
  try {
    const raw = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EngineQualitySettings>;
    if (!parsed || typeof parsed !== 'object' || !isQualityLevel(parsed.level)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveQuality(q: Readonly<EngineQualitySettings>): void {
  try {
    localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(q));
  } catch {
    /* storage unavailable (private mode) */
  }
}

/** Keeps only known keys with values of the right type (stored data may be stale or edited). */
function sanitize(base: EngineQualitySettings, o: Partial<EngineQualitySettings>): EngineQualitySettings {
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof EngineQualitySettings)[]) {
    const v = o[key];
    if (v !== undefined && typeof v === typeof base[key]) (out as Record<string, unknown>)[key] = v;
  }
  if (!isQualityLevel(out.level)) out.level = base.level;
  if (![0, 1024, 2048, 4096].includes(out.shadowMapSize)) out.shadowMapSize = base.shadowMapSize;
  if (!['off', 'smaa', 'msaa'].includes(out.antialias)) out.antialias = base.antialias;
  if (!['env', 'planar'].includes(out.waterReflections)) out.waterReflections = base.waterReflections;
  out.renderScale = Math.min(1, Math.max(0.3, out.renderScale));
  return out;
}

export interface InitialQuality {
  settings: EngineQualitySettings;
  detected: QualityLevel;
  source: 'url' | 'storage' | 'detected';
}

export function resolveInitialQuality(gpuName: string, params: URLSearchParams): InitialQuality {
  const detected = detectQualityLevel(gpuName);
  const urlLevel = params.get('quality');
  const overrides = parseUrlOverrides(params);
  if (isQualityLevel(urlLevel)) {
    return { settings: sanitize(presetFor(urlLevel), overrides), detected, source: 'url' };
  }
  const stored = readStored();
  if (stored) {
    const preset = presetFor(stored.level!);
    // dynamic resolution has no menu control: it always follows the preset (settings saved before
    // 'hoog' enabled it would otherwise keep it off and show the preset as 'Aangepast')
    const fromStore = sanitize(preset, stored);
    fromStore.dynamicResolution = preset.dynamicResolution;
    return { settings: sanitize(fromStore, overrides), detected, source: 'storage' };
  }
  return { settings: sanitize(presetFor(detected), overrides), detected, source: 'detected' };
}

/**
 * Dynamic resolution controller: lowers the render scale when the frame rate stays below the
 * target for a full second, and carefully raises it again. Hitches (loading, shader compiles) are
 * ignored, there is a warm-up period, and an increase that immediately causes a drop again makes
 * the next increase wait longer (no oscillation).
 */
export class DynamicResolution {
  /** Current multiplier applied on top of the preset render scale (minFactor .. 1). */
  factor = 1;
  private accum = 0;
  private frames = 0;
  private goodWindows = 0;
  private cooldown = 3;
  private time = 0;
  private lastIncreaseAt = -1e9;
  private cpuAccum = 0;

  /** minFactor: lowest factor (set per level from DYNRES_FLOOR). */
  constructor(private readonly targetFps = 55, public minFactor = 0.6, private readonly warmup = 3) {}

  reset(): void {
    this.factor = 1;
    this.accum = 0;
    this.frames = 0;
    this.goodWindows = 0;
    this.cooldown = 3;
    this.time = 0;
    this.lastIncreaseAt = -1e9;
    this.cpuAccum = 0;
  }

  /**
   * Feed the real frame delta (s) and the main-thread time of that frame (s: updates + render
   * submission). Returns true when `factor` changed. A CPU-bound frame rate (main thread busy for
   * most of the frame) never lowers the resolution: that would only cost sharpness.
   */
  update(dt: number, cpu = 0): boolean {
    this.time += dt;
    if (this.time < this.warmup) return false;
    if (dt > 0.25) {
      // hitch (loading / compile / tab switch): discard the current window
      this.accum = 0;
      this.frames = 0;
      this.cpuAccum = 0;
      return false;
    }
    this.accum += dt;
    this.cpuAccum += cpu;
    this.frames++;
    if (this.accum < 1) return false;
    const fps = this.frames / this.accum;
    const cpuBound = this.cpuAccum > this.accum * 0.8;
    this.accum = 0;
    this.frames = 0;
    this.cpuAccum = 0;
    if (this.factor < this.minFactor) { this.factor = this.minFactor; return true; }
    if (fps < this.targetFps * 0.92 && this.factor > this.minFactor && !cpuBound) {
      if (this.time - this.lastIncreaseAt < 5) this.cooldown = Math.min(40, this.cooldown * 2);
      this.factor = Math.max(this.minFactor, this.factor - (fps < this.targetFps * 0.7 ? 0.12 : 0.06));
      this.goodWindows = 0;
      return true;
    }
    if (fps >= this.targetFps && this.factor < 1) {
      if (++this.goodWindows >= this.cooldown) {
        this.factor = Math.min(1, this.factor + 0.05);
        this.goodWindows = 0;
        this.lastIncreaseAt = this.time;
        return true;
      }
    } else {
      this.goodWindows = 0;
    }
    return false;
  }
}
