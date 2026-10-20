// Electron shell for the Windows build of Gang Alkmaar.
// Serves the Vite build (dist/) through a privileged app:// protocol, because Chromium does not
// allow fetch() on file:// URLs (GLTFLoader, JSON data and WASM all use fetch).
const { app, BrowserWindow, Menu, protocol, net, globalShortcut } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');

// Hidden self-test for QA of the packaged build (renders off-screen, no visible window):
//   "Alkmaar Drive.exe" --selftest=C:pathout.png [--query=scene=game&autostart=1&spawn=waag]
// Prints console errors and a SELFTEST {...} line, then exits (code 1 on errors).
const argValue = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const SELFTEST = argValue('selftest');

// Prefer the discrete GPU on laptops with hybrid graphics, and don't let Chromium's blocklist
// force software rendering on older (but perfectly capable) drivers.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// Car audio must start without a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// No application menu: its accelerators (Ctrl+R reload, Ctrl+W close) would fire when the
// player shifts down with Ctrl and presses R.
Menu.setApplicationMenu(null);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: 'Gang Alkmaar',
    backgroundColor: '#0d1014',
    autoHideMenuBar: true,
    show: false,
    paintWhenInitiallyHidden: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Re-enabled while minimized (see below); the off-screen self-test never throttles.
      backgroundThrottling: false,
      offscreen: !!SELFTEST,
    },
  });
  win.removeMenu();
  if (!SELFTEST) {
    win.once('ready-to-show', () => {
      win.maximize();
      win.show();
    });
    // backgroundThrottling:false keeps the game rendering (and the page 'visible') while the window
    // is merely unfocused or covered, but it would also keep the whole city rendering at full frame
    // rate while minimized. Allow throttling while minimized/hidden: the page then becomes hidden,
    // rAF stops (engine loop, audio and input visibility handlers kick in) and resumes on restore.
    const throttle = (on) => {
      if (!win.isDestroyed()) win.webContents.setBackgroundThrottling(on);
    };
    win.on('minimize', () => throttle(true));
    win.on('hide', () => throttle(true));
    win.on('restore', () => throttle(false));
    win.on('show', () => throttle(false));
    win.on('focus', () => throttle(false));
  }
  // In-game "Afsluiten" calls window.close(); make sure that quits the app.
  win.on('closed', () => app.quit());
  // Keep navigation inside the app.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });
  const scene = argValue('scene');
  let query = scene ? `?scene=${encodeURIComponent(scene)}` : '';
  if (SELFTEST) query = `?${argValue('query') ?? 'scene=brawl&autostart=1&arena=kaasmarkt'}`;
  win.loadURL(`app://game/index.html${query}`);
  if (SELFTEST) runSelftest(win);
  return win;
}

async function runSelftest(win) {
  const fs = require('node:fs');
  let errors = 0;
  win.webContents.on('console-message', (ev) => {
    const level = typeof ev.level === 'string' ? ev.level : ['verbose', 'info', 'warning', 'error'][ev.level];
    if (level === 'error') {
      errors++;
      process.stdout.write(`[console.error] ${ev.message}
`);
    }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  let ready = false;
  while (!ready && Date.now() - t0 < 180000) {
    await sleep(250);
    ready = await win.webContents.executeJavaScript('window.__ready === true').catch(() => false);
  }
  await sleep(5000);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(SELFTEST, img.toPNG());
  const stats = await win.webContents
    .executeJavaScript('window.__engine ? JSON.parse(JSON.stringify(window.__engine.stats)) : null')
    .catch(() => null);
  process.stdout.write(`SELFTEST ${JSON.stringify({ ready, loadMs: Date.now() - t0 - 5000, errors, stats })}
`);
  app.exit(ready && errors === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(DIST, rel || 'index.html'));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
