#!/usr/bin/env node
// Headless screenshot + console capture tool for Alkmaar Drive.
//
// Starts its own Vite dev server on a free port, opens the page in an off-screen Electron
// window (GPU accelerated WebGL), waits until the scene sets `window.__ready = true`, waits a
// settle time, optionally runs JavaScript, then saves a PNG and prints console output + stats.
// Several instances can run in parallel (each uses its own port and Electron process).
//
// Usage:
//   node tools/shot.mjs --scene hello [--params "cam=10,5,10&look=0,0,0"] [--out shots/x.png]
//                       [--width 1600] [--height 900] [--settle 2000] [--timeout 180000]
//                       [--eval "window.__debug.setCam(0,50,0, 0,0,-1)"]
//                       [--steps steps.json]   // [{ "eval": "...", "wait": 1000, "out": "shots/a.png" }, ...]
//                       [--console]            // print all console messages, not only warnings/errors
//                       [--url http://127.0.0.1:5173/]  // use an already running server instead
//
// Output (stdout): lines prefixed with [console.error]/[console.warn]/..., then a final line
//   SHOT_RESULT {"ok":true,"files":[...],"stats":{fps,frameMs,drawCalls,triangles},"errors":N,...}
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const scene = args.scene ?? 'game';
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 900);
const settle = Number(args.settle ?? 2000);
const timeout = Number(args.timeout ?? 180000);
let steps;
if (args.steps) steps = JSON.parse(readFileSync(resolve(args.steps), 'utf8'));
else steps = [{ eval: typeof args.eval === 'string' ? args.eval : undefined, wait: 0, out: args.out ?? `shots/${scene}.png` }];
for (const s of steps) {
  if (s.out) {
    s.out = resolve(root, s.out);
    mkdirSync(dirname(s.out), { recursive: true });
  }
}

let server = null;
let cacheDir = null;
let baseUrl = typeof args.url === 'string' ? args.url : null;
if (!baseUrl) {
  const { createServer } = await import('vite');
  const port = 5200 + Math.floor(Math.random() * 700);
  // Private dependency cache per run: parallel runs must not race on node_modules/.vite.
  cacheDir = resolve(tmpdir(), `alkmaar-vite-${port}-${process.pid}`);
  server = await createServer({
    root,
    cacheDir,
    configFile: resolve(root, 'vite.config.ts'),
    logLevel: 'error',
    clearScreen: false,
    server: { port, strictPort: false, host: '127.0.0.1', hmr: false, watch: null },
  });
  await server.listen();
  baseUrl = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${port}/`;
}
const extra = typeof args.params === 'string' ? `&${args.params.replace(/^[?&]/, '')}` : '';
const url = `${baseUrl.replace(/\/$/, '')}/index.html?scene=${encodeURIComponent(scene)}${extra}`;

const electronPath = require('electron');
const config = { url, width, height, settle, timeout, steps, printAll: !!args.console };
const child = spawn(electronPath, [resolve(root, 'tools/shot-main.cjs')], {
  env: { ...process.env, SHOT_CONFIG: JSON.stringify(config), ELECTRON_ENABLE_LOGGING: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let result = null;
child.stdout.setEncoding('utf8');
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trimEnd();
    buf = buf.slice(i + 1);
    if (line.startsWith('SHOT_RESULT ')) result = line;
    if (line) console.log(line);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => {
  // Chromium/GPU noise is filtered; real page errors arrive via console-message on stdout.
  const lines = String(d).split('\n').filter((l) => /error/i.test(l) && !/gpu_init|command_buffer|DXGI|Fontconfig|sandbox|ssl_client|cert_verify|dbus/i.test(l));
  for (const l of lines) if (l.trim()) console.log('[electron stderr]', l.trim());
});
const code = await new Promise((res) => child.on('exit', res));
if (buf.trim()) console.log(buf.trim());
if (server) await server.close();
if (cacheDir) { try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ } }
if (!result) {
  console.log(`SHOT_RESULT ${JSON.stringify({ ok: false, error: `electron exited with code ${code} without result`, url })}`);
  process.exit(1);
}
process.exit(0);
