/* global PIXI */
// Globals come from VCPChat's own vendor/pixi.min.js + pixi-unsafe-eval.min.js
// (the CSP has no 'unsafe-eval') and the engine's UMD build (PIXI.live2d).
(async () => {
  const { Application, extensions, UPDATE_PRIORITY } = PIXI;
  const { Live2DModel, Live2DPlugin } = PIXI.live2d;
  const params = new URLSearchParams(location.search);
  const fps = Number(params.get('fps') || 30);
  const MODEL_URL = 'deskpet://pet/vendor/models/Hiyori/Hiyori.model3.json';
  const HIT_ALPHA = 24; // 0-255; below this a pixel counts as empty

  const canvas = document.getElementById('stage');
  const t0 = performance.now();
  // The Live2D render pipe must be registered before the renderer exists.
  extensions.add(Live2DPlugin);
  const app = new Application();
  await app.init({
    canvas,
    resizeTo: window,
    preference: 'webgl',
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    // Keep the drawing buffer cheap; hit testing reads right after render.
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });
  if (fps > 0) app.ticker.maxFPS = fps;

  const model = await Live2DModel.from(MODEL_URL, {
    ticker: app.ticker,
    autoHitTest: false,
    autoFocus: false,
    // The pet is drawn a few hundred px tall from 2048px atlases; let the
    // engine upload a downscaled copy instead of the full mip chain.
    textureOptions: { lod: params.get('lod') || 'single-auto' },
  });
  const loadMs = Math.round(performance.now() - t0);
  app.stage.addChild(model);

  function layout() {
    const scale = Math.min(window.innerWidth / model.internalModel.width, window.innerHeight / model.internalModel.height) * 0.98;
    model.scale.set(scale);
    model.anchor.set(0.5, 1);
    model.position.set(window.innerWidth / 2, window.innerHeight);
  }
  layout();
  window.addEventListener('resize', layout);

  // ---- per-pixel hit test ---------------------------------------------------
  const gl = app.renderer.gl;
  const pixel = new Uint8Array(4);
  let pendingProbe = null;
  let lastHit = false;
  let frames = 0;

  function readAlpha(x, y) {
    const r = app.renderer.resolution;
    gl.readPixels(Math.floor(x * r), Math.floor(gl.drawingBufferHeight - y * r - 1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[3];
  }

  // Runs after the application's render callback (UTILITY < LOW priority), so
  // the back buffer still holds this frame.
  app.ticker.add(() => {
    frames++;
    if (!pendingProbe) return;
    const { x, y } = pendingProbe;
    pendingProbe = null;
    const hit = readAlpha(x, y) >= HIT_ALPHA;
    if (hit !== lastHit) {
      lastHit = hit;
      window.deskpet.setHit(hit);
    }
  }, null, UPDATE_PRIORITY.UTILITY);

  function probe(x, y) {
    if (app.ticker.started) {
      pendingProbe = { x, y };
      return;
    }
    // Paused: render one frame on demand so the buffer is valid.
    app.render();
    const hit = readAlpha(x, y) >= HIT_ALPHA;
    if (hit !== lastHit) { lastHit = hit; window.deskpet.setHit(hit); }
  }
  window.deskpet.onCursor(({ x, y }) => {
    probe(x, y);
    model.focus(x, y);
  });

  // Model bounding box for platforms that clip the input shape instead of
  // toggling click-through (Linux). Motions move the model, so refresh it.
  setInterval(() => {
    const b = model.getBounds();
    window.deskpet.setModelBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }, 250);

  // ---- interaction ------------------------------------------------------------
  let downAt = null;
  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    downAt = { x: e.screenX, y: e.screenY, dragging: false };
  });
  window.addEventListener('pointermove', (e) => {
    if (!downAt || downAt.dragging) return;
    if (Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 4) {
      downAt.dragging = true;
      window.deskpet.dragStart({ x: downAt.x, y: downAt.y });
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    if (downAt.dragging) window.deskpet.dragEnd();
    else tapAt(e.clientX, e.clientY);
    downAt = null;
  });

  function tapAt(x, y) {
    const areas = model.hitTest(x, y);
    model.motion('TapBody');
    return areas;
  }

  // ---- hooks for the bench driver ---------------------------------------------
  let activeTimer = null;
  window.__deskpet = {
    tap: () => tapAt(window.innerWidth / 2, window.innerHeight * 0.6),
    startActive() {
      let i = 0;
      activeTimer = setInterval(() => {
        i++;
        model.focus(Math.random() * window.innerWidth, Math.random() * window.innerHeight);
        if (i % 20 === 0) model.motion('TapBody');
      }, 100);
    },
    stopActive() { clearInterval(activeTimer); },
    pause() { app.ticker.stop(); },
    resume() { app.ticker.start(); },
    probeHits() {
      const pts = { center: [window.innerWidth / 2, window.innerHeight * 0.55], topLeftCorner: [4, 4], bottomRightCorner: [window.innerWidth - 4, window.innerHeight - 4] };
      app.render();
      const out = {};
      for (const [k, [x, y]] of Object.entries(pts)) out[k] = readAlpha(x, y);
      return out;
    },
    stats: () => ({ frames, elapsedMs: Math.round(performance.now() - t0), loadMs, renderer: app.renderer.name, webglVersion: app.renderer.context.webGLVersion, glRenderer: gl.getParameter(gl.RENDERER), coreVersion: window.Live2DCubismCore.Version.csmGetVersion() }),
  };
  window.__deskpetReady = { loadMs, modelSize: [model.internalModel.width, model.internalModel.height], hitAreas: Object.keys(model.internalModel.hitAreas || {}) };
  window.deskpet.ready(window.__deskpetReady);
})().catch((err) => {
  window.deskpet.status({ error: String(err && (err.stack || err)) });
});
