// Electron main process for tools/shot.mjs. Not part of the game build.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
const cfg = JSON.parse(process.env.SHOT_CONFIG || '{}');
const LEVELS = ['verbose', 'info', 'warning', 'error'];
let errors = 0;
let warnings = 0;

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(payload) {
  process.stdout.write(`SHOT_RESULT ${JSON.stringify(payload)}\n`);
  setTimeout(() => app.exit(0), 50);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: cfg.width,
    height: cfg.height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true },
  });
  win.webContents.setFrameRate(60);
  let lastPaint = null;
  win.webContents.on('paint', (_e, _dirty, image) => { lastPaint = image; });

  win.webContents.on('console-message', (...a) => {
    // Electron >= 35 passes a single event object; older versions pass (event, level, message, line, source).
    let level; let message; let source = ''; let line = 0;
    if (a.length === 1 || typeof a[1] !== 'number') {
      const ev = a[0];
      level = typeof ev.level === 'string' ? ev.level : LEVELS[ev.level] ?? 'info';
      message = ev.message; line = ev.lineNumber ?? 0; source = ev.sourceId ?? '';
    } else {
      level = LEVELS[a[1]] ?? 'info'; message = a[2]; line = a[3]; source = a[4];
    }
    if (level === 'error') errors++;
    if (level === 'warning') warnings++;
    if (cfg.printAll || level === 'error' || level === 'warning') {
      const where = source ? ` (${String(source).replace(/^.*\/src\//, 'src/')}:${line})` : '';
      process.stdout.write(`[console.${level}] ${message}${where}\n`);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    process.stdout.write(`[renderer gone] ${JSON.stringify(d)}\n`);
    finish({ ok: false, error: 'renderer process gone', details: d, errors, warnings });
  });

  const t0 = Date.now();
  try {
    await win.loadURL(cfg.url);
  } catch (e) {
    finish({ ok: false, error: `loadURL failed: ${e.message}`, url: cfg.url });
    return;
  }

  let ready = false;
  while (Date.now() - t0 < cfg.timeout) {
    try {
      ready = await win.webContents.executeJavaScript('window.__ready === true');
    } catch { /* page navigating */ }
    if (ready) break;
    await sleep(250);
  }
  const loadMs = Date.now() - t0;
  if (!ready) process.stdout.write(`[shot] WARNING: window.__ready not set within ${cfg.timeout} ms, capturing anyway\n`);
  await sleep(cfg.settle);

  const files = [];
  for (const step of cfg.steps) {
    if (step.eval) {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => { ${step.eval.includes('return') ? step.eval : `return (${step.eval})`} })()`);
        if (r !== undefined) process.stdout.write(`[eval] ${JSON.stringify(r)}\n`);
      } catch (e) {
        errors++;
        process.stdout.write(`[eval error] ${e.message}\n`);
      }
    }
    if (step.wait) await sleep(step.wait);
    if (step.out) {
      let img = await win.webContents.capturePage();
      if (img.isEmpty() && lastPaint) img = lastPaint;
      fs.writeFileSync(step.out, img.toPNG());
      files.push(step.out);
    }
  }

  let stats = null;
  try {
    stats = await win.webContents.executeJavaScript('window.__engine ? JSON.parse(JSON.stringify(window.__engine.stats)) : null');
  } catch { /* ignore */ }
  let gpu = null;
  try {
    gpu = await win.webContents.executeJavaScript(`(() => { const c = document.createElement('canvas').getContext('webgl2'); if (!c) return 'no webgl2'; const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);
  } catch { /* ignore */ }
  finish({ ok: ready && errors === 0, ready, loadMs, files, stats, errors, warnings, gpu });
});
