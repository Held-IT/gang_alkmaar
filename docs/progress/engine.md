# Engine/render module — progress

Status: DONE (session 2 finished final verification). tsc clean, no console errors at any level.

## Files
- src/core/engine.ts — createEngine(canvas): Promise<Engine> (+ EngineExt via asEngineExt)
- src/core/environment.ts — HDRI sky dome, IBL (PMREM), SunLight (2 cascades), fog density
- src/core/fog.ts — global aerial fog chunks (exp2 + height falloff + azimuth horizon table)
- src/core/postfx.ts — postprocessing composer: N8AO -> bloom -> AgX -> grade/vignette/dither -> SMAA
- src/core/quality.ts — presets, GPU detection, persistence, URL overrides, DynamicResolution
- src/core/n8ao.d.ts — types for n8ao
- src/scenes/dev-render.ts — ?scene=dev-render test scene (synthetic, ?stress=1, ?city=1)
- tools/engine/fetch-hdri.mjs, hdr.mjs — HDRI download + analysis
- public/assets/hdri/ — sky_1k.hdr (IBL), sky_2k.hdr, sky_4k_top.hdr, sky.json, credits.json
  (Poly Haven "Kloofendal 48d Partly Cloudy (Pure Sky)", CC0, Greg Zaal & Jarod Guest)

## API summary (see report / file headers)
- URL: ?quality=laag|midden|hoog|ultra (not persisted), q_scale q_shadow q_shadowdist q_ao q_aohalf q_bloom
  q_aa q_draw q_dyn q_water, ?tm=agx|aces|neutral, ?exposure=, ?hdri=0, ?rdepth=0, ?aa_mode=, ?g_con/g_sat/g_vig
- engine.setQuality({level}) switches preset (+ overrides), persists to localStorage 'alkmaar-drive-quality',
  notifies onQualityChange listeners.
- engine.env: sun (SunLight, typed as DirectionalLight), sunDirection, envMap, ready; EngineEnvironment extras:
  fog, skyDome, horizonColor, visibility, setVisibility(m|null), sunAzimuthDeg, skyInfo.
- Fog: scene.fog is THREE.FogExp2; density follows quality.drawDistance (93 % at 1.05 x drawDistance).
- Shaders using standard fog chunks get aerial fog automatically (applied before tone mapping).

## Log
- (session 1) all modules implemented and tuned (ENV_INTENSITY 1.2, AgX exposure 0.85, grade).
- (session 2) verified ?quality=laag|midden|hoog|ultra all apply (console "[engine] ... kwaliteit: X (url ...)").
- (session 2) FIXED fog on the direct 'laag' path: three applies <fog_fragment> after tone mapping and
  encodes fogColor to sRGB for screen renders -> distant city was far too bright with a seam against the
  sky dome. Now exp2 fog is applied before tone mapping (prepended to tonemapping_fragment, guarded by
  AERIAL_FOG_DONE) and uses an absolute linear horizon table (fogHorizon, fogParams.z = 1 valid flag).
- (session 2) GPU time per frame (EXT_disjoint_timer_query), dev-render ?city=1 (ALL city files loaded,
  no culling), 1538x817, iGPU Ryzen 7530U: laag 10.1/12.3 ms, midden 14.9/16.4, hoog 16.3/20.8,
  ultra 26.5/24.6 (verdronkenoord / waag). Wall-clock bench is CPU-bound and noisy (other agents running).

## Fix round (render fixer, reviewer findings)
- Live quality switch: engine.setQuality() now precompiles the program variants the new settings need
  with renderer.compileAsync (KHR_parallel_shader_compile; render target bound like the active path:
  screen for the direct 'laag' path, an offscreen HalfFloat target otherwise) and holds rendering (last
  frame stays on screen) until they are ready; `EngineExt.applying` is the promise. A small
  "Instellingen toepassen…" badge (role=status) appears after 120 ms. midden->laag first switch:
  longest frame 2778 ms -> ~320-520 ms (compile itself runs off the main thread; 0.5-4.7 s wall time on
  the loaded iGPU); other switches 130-350 ms (was 400-1300). Shot/steps: scratchpad render/qswitch.json.
- Also removed from the switch: anisotropy change re-uploaded every texture (materials now sets the
  sampler parameter directly) and a 2k sky re-decode on a switch to 'laag' (env keeps an already decoded
  4k sky; env.applyQuality returns a promise for the sky texture, awaited by the precompile phase).
- N8AO: transparencyAware was silently ON (n8ao only disables auto-detect when the proxied value
  changes) -> 2 extra scene renders + 2 RGBA16F targets per frame. postfx sets pass.autoDetectTransparency
  = false first. Verified at runtime: transparencyAware=false, autoDetectTransparency=false.
- 'hoog' preset: dynamicResolution ON with a per-level floor (DYNRES_FLOOR: laag .6, midden .7, hoog .8,
  ultra .85). DynamicResolution.update(dt, cpu) never lowers the scale when the main thread is busy for
  >80 % of the frame (CPU-bound: lower resolution would only cost sharpness). Stored settings take
  dynamicResolution from the preset (no menu control). SMAA medium on hoog not done (~0.15 ms on a 1660S).
- Aerial perspective: above street level (40 -> 450 m camera height) the fog density drops to 50 % and
  the horizon table is tinted towards blue in-scatter (AERIAL_TINT); the virtual ground beyond the
  backdrop turns into polder green-brown from 1.8-3.2 km. aerialHigh/aerial now read as a clear day
  (shots/engine/fx_aerialHigh_after2.png, fx_aerial_after2.png); street level unchanged (fx_molenLow_after2).
