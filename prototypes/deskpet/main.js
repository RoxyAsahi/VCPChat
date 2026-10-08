// Live2D desk pet feasibility prototype.
// Run from the VCPChat root, after `node prototypes/deskpet/scripts/fetch-assets.mjs`:
//   npx electron prototypes/deskpet/main.js
//
// Env:
//   DESKPET_FPS=30            render cap (0 = uncapped vsync)
//   DESKPET_BENCH=1           run the scripted measurement and quit
//   DESKPET_SOFTWARE_GL=1     allow SwiftShader WebGL (headless CI / no GPU)
//   DESKPET_OUT=<dir>         where bench JSON and screenshots go

const { app, BrowserWindow, ipcMain, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const OUT_DIR = process.env.DESKPET_OUT || path.join(ROOT, 'out');
const BENCH = process.env.DESKPET_BENCH === '1';
// Same window, no Live2D: the cost of an empty transparent topmost window.
const BASELINE = process.env.DESKPET_BASELINE === '1';
const PET_SIZE = { width: 320, height: 480 };
// Windows: 'pop-up-menu' keeps the pet above the taskbar without fighting
// fullscreen apps as hard as 'screen-saver'. macOS needs 'screen-saver' to sit
// above fullscreen spaces.
const TOPMOST_LEVEL = process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu';
const HIT_POLL_MS = 50;
// On X11 the empty input shape behind setIgnoreMouseEvents(true) means
// Chromium stops seeing the pointer, and screen.getCursorScreenPoint() goes
// stale (measured under Xvfb), so the cursor poll never sees the pet again.
// Linux instead clips the window's input shape to the model's bounding box.
const USE_SHAPE = process.platform === 'linux';
const DRAG_TICK_MS = 16;

if (process.env.DESKPET_SOFTWARE_GL === '1') {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// Serve renderer, libraries and model from one privileged scheme so fetch/XHR
// work under a strict CSP and nothing outside these folders is reachable.
protocol.registerSchemesAsPrivileged([
  { scheme: 'deskpet', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const SERVED_ROOTS = {
  app: path.join(ROOT, 'renderer'),
  lib: path.join(ROOT, 'lib'),
  appvendor: path.join(ROOT, '..', '..', 'vendor'),
  vendor: path.join(ROOT, 'vendor'),
};

function registerProtocol() {
  protocol.handle('deskpet', (request) => {
    // deskpet://pet/<root>/<path>: one origin, so model XHR is same-origin.
    const url = new URL(request.url);
    const [, rootName, ...rest] = decodeURIComponent(url.pathname).split('/');
    const base = SERVED_ROOTS[rootName];
    const file = base && path.normalize(path.join(base, ...rest));
    if (!file || !file.startsWith(base + path.sep)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

let petWin = null;
let ignoringMouse = true;
let hitPoll = null;
let drag = null;

function setIgnoreMouse(ignore) {
  if (!petWin || petWin.isDestroyed() || ignore === ignoringMouse) return;
  ignoringMouse = ignore;
  console.log(`[state] ignoreMouse=${ignore}`);
  // forward:true keeps mousemove flowing to the page on Windows/macOS while
  // clicks fall through. Linux ignores it, which is why the cursor poll below
  // exists at all.
  petWin.setIgnoreMouseEvents(ignore, { forward: true });
}

// Cursor poll: while the cursor is over the window bounds, send its
// window-relative position to the renderer, which answers with a per-pixel
// alpha hit test. Works the same on every platform and does not depend on
// forwarded mouse events.
function startHitPoll() {
  hitPoll = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || drag) return;
    const p = screen.getCursorScreenPoint();
    const b = petWin.getBounds();
    if (process.env.DESKPET_DEBUG) console.log('[poll]', p.x, p.y, JSON.stringify(b));
    const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
    if (!inside) {
      setIgnoreMouse(true);
      return;
    }
    petWin.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y });
  }, HIT_POLL_MS);
}

function createPetWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  petWin = new BrowserWindow({
    ...PET_SIZE,
    x: area.x + area.width - PET_SIZE.width - 24,
    y: area.y + area.height - PET_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // Windows: clicking the pet must not steal foreground focus from the app
    // the user is typing in. Linux window managers treat non-focusable
    // windows differently (some drop input), so it stays focusable there.
    focusable: process.platform !== 'linux',
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The pet keeps animating when VCPChat's main window is minimized.
      backgroundThrottling: false,
    },
  });
  petWin.setAlwaysOnTop(true, TOPMOST_LEVEL);
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!USE_SHAPE) petWin.setIgnoreMouseEvents(true, { forward: true });
  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    // Windows can drop WS_EX_TOPMOST from a transparent window across
    // hide/show; re-assert the level after every show.
    petWin.setAlwaysOnTop(true, TOPMOST_LEVEL);
    petWin.moveTop();
  });
  petWin.on('closed', () => { petWin = null; });
  petWin.webContents.on('render-process-gone', (_e, details) => {
    console.log('[deskpet] renderer gone', details.reason);
    if (details.reason !== 'clean-exit') setTimeout(() => petWin && petWin.reload(), 250);
  });
  petWin.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message, e.sourceId || '', e.lineNumber || ''));
  petWin.webContents.on('did-fail-load', (_e, code, desc, url) => console.log('[load-fail]', code, desc, url));
  const fps = Number(process.env.DESKPET_FPS ?? 30);
  const page = BASELINE ? 'blank.html' : 'pet.html';
  petWin.loadURL(`deskpet://pet/app/${page}?fps=${fps}&lod=${process.env.DESKPET_LOD || 'single-auto'}`);
  if (!USE_SHAPE) startHitPoll();
}

ipcMain.on('deskpet:hit', (_e, hit) => setIgnoreMouse(!hit));

let lastShape = '';
ipcMain.on('deskpet:model-bounds', (_e, rect) => {
  if (!USE_SHAPE || !petWin || petWin.isDestroyed()) return;
  const [w, h] = petWin.getContentSize();
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const shape = { x, y, width: Math.min(w - x, Math.ceil(rect.width)), height: Math.min(h - y, Math.ceil(rect.height)) };
  const key = JSON.stringify(shape);
  if (key === lastShape || shape.width <= 0 || shape.height <= 0) return;
  lastShape = key;
  petWin.setShape([shape]);
  console.log(`[state] shape=${key}`);
});

// Dragging is done in main by following the cursor instead of
// -webkit-app-region: drag, which on Windows swallows clicks and does not
// combine with per-pixel click-through on transparent windows.
// `origin` is the screen point of the pointerdown; the drag only starts after a
// few px of movement, so taking the cursor position here would offset the pet.
ipcMain.on('deskpet:drag-start', (_e, origin) => {
  if (!petWin) return;
  const p = origin || screen.getCursorScreenPoint();
  const [wx, wy] = petWin.getPosition();
  drag = { dx: p.x - wx, dy: p.y - wy, timer: null };
  drag.timer = setInterval(() => {
    if (!petWin || petWin.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    petWin.setPosition(c.x - drag.dx, c.y - drag.dy);
  }, DRAG_TICK_MS);
});
ipcMain.on('deskpet:drag-end', () => {
  if (drag) {
    clearInterval(drag.timer);
    const c = screen.getCursorScreenPoint();
    if (petWin) petWin.setPosition(c.x - drag.dx, c.y - drag.dy);
  }
  drag = null;
  if (petWin) console.log(`[state] position=${petWin.getPosition().join(',')}`);
});

ipcMain.handle('deskpet:status', (_e, status) => {
  console.log('[deskpet]', JSON.stringify(status));
  return true;
});

// ---- measurement -----------------------------------------------------------

function sampleMetrics() {
  return app.getAppMetrics().map((m) => ({
    type: m.type,
    serviceName: m.serviceName,
    cpu: m.cpu.percentCPUUsage,
    workingSetKB: m.memory.workingSetSize,
    privateKB: m.memory.privateBytes,
  }));
}

async function measurePhase(name, seconds) {
  const samples = [];
  // getAppMetrics CPU is the usage since the previous call; prime it.
  app.getAppMetrics();
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    samples.push(sampleMetrics());
  }
  const byType = {};
  for (const sample of samples) {
    for (const m of sample) {
      const key = m.type === 'Utility' ? `Utility:${m.serviceName}` : m.type;
      byType[key] ||= { cpu: [], workingSetKB: [] };
      byType[key].cpu.push(m.cpu);
      byType[key].workingSetKB.push(m.workingSetKB);
    }
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const summary = {};
  for (const [k, v] of Object.entries(byType)) {
    summary[k] = { cpuAvg: +avg(v.cpu).toFixed(2), cpuMax: +Math.max(...v.cpu).toFixed(2), workingSetMB: +(avg(v.workingSetKB) / 1024).toFixed(1) };
  }
  const totalCpu = +Object.values(summary).reduce((s, v) => s + v.cpuAvg, 0).toFixed(2);
  const totalMB = +Object.values(summary).reduce((s, v) => s + v.workingSetMB, 0).toFixed(1);
  console.log(`[bench] ${name}: cpu ${totalCpu}% ws ${totalMB} MB`);
  return { name, seconds, totalCpu, totalMB, byType: summary };
}

async function screenshot(name) {
  const image = await petWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), image.toPNG());
}

const rendererCall = (code) => petWin.webContents.executeJavaScript(code);

async function runBench() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ready = await rendererCall('window.__deskpetReady');
  const result = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    fps: Number(process.env.DESKPET_FPS ?? 30),
    ready,
    gpu: await app.getGPUInfo('basic').then((i) => i.gpuDevice).catch(() => null),
    gpuFeatures: app.getGPUFeatureStatus(),
    phases: [],
  };
  await new Promise((r) => setTimeout(r, 3000));
  if (BASELINE) {
    result.phases.push(await measurePhase('baseline-empty-window', 10));
    fs.writeFileSync(path.join(OUT_DIR, 'bench-baseline.json'), JSON.stringify(result, null, 2));
    app.quit();
    return;
  }
  await screenshot('pet-idle');
  result.phases.push(await measurePhase('idle-animating', 10));
  await rendererCall('window.__deskpet.tap()');
  await new Promise((r) => setTimeout(r, 400));
  await screenshot('pet-tap');
  await rendererCall('window.__deskpet.startActive()');
  result.phases.push(await measurePhase('active-tap-and-look', 10));
  await rendererCall('window.__deskpet.stopActive()');
  await rendererCall('window.__deskpet.pause()');
  result.phases.push(await measurePhase('paused', 8));
  await rendererCall('window.__deskpet.resume()');
  // Hit test round trip: renderer reports whether a point is on the model.
  result.hitTest = await rendererCall('window.__deskpet.probeHits()');
  result.rendererStats = await rendererCall('window.__deskpet.stats()');
  result.lod = process.env.DESKPET_LOD || 'single-auto';
  fs.writeFileSync(path.join(OUT_DIR, `bench-fps${result.fps}-${result.lod}.json`), JSON.stringify(result, null, 2));
  console.log('[bench] done');
  app.quit();
}

app.whenReady().then(() => {
  registerProtocol();
  createPetWindow();
  if (BENCH) {
    ipcMain.once('deskpet:ready', () => runBench().catch((err) => {
      console.error('[bench] failed', err);
      app.exit(1);
    }));
  }
});

ipcMain.on('deskpet:ready', (_e, info) => console.log('[deskpet] ready', JSON.stringify(info)));

app.on('window-all-closed', () => app.quit());
