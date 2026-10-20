// Entry point: creates the engine and starts the scene chosen with ?scene=<name> (default 'game').
// Scenes live in src/scenes/<name>.ts and default-export a SceneEntry (see src/contracts.ts).
import { createEngine } from './core/engine';
import type { SceneEntry } from './contracts';

const sceneModules = import.meta.glob<{ default: SceneEntry }>('./scenes/*.ts');

function showFatal(message: string): void {
  const el = document.createElement('pre');
  el.style.cssText =
    'position:fixed;inset:auto 16px 16px 16px;max-height:40vh;overflow:auto;margin:0;padding:12px;' +
    'background:#2a0d0d;color:#ffb4b4;font:12px/1.4 Consolas,monospace;z-index:99999;white-space:pre-wrap;';
  el.textContent = message;
  document.body.appendChild(el);
}

window.addEventListener('error', (e) => console.error('[uncaught]', e.message, e.error?.stack ?? ''));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandled rejection]', e.reason?.stack ?? e.reason));

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sceneName = params.get('scene') ?? 'brawl';
  const loader = sceneModules[`./scenes/${sceneName}.ts`];
  if (!loader) {
    const available = Object.keys(sceneModules).map((k) => k.replace('./scenes/', '').replace('.ts', ''));
    throw new Error(`Onbekende scene "${sceneName}". Beschikbaar: ${available.join(', ')}`);
  }
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const engine = await createEngine(canvas);
  window.__engine = engine;
  const mod = await loader();
  await mod.default(engine, params);
}

boot().catch((err) => {
  console.error('[boot]', err?.stack ?? err);
  showFatal(String(err?.stack ?? err));
});
