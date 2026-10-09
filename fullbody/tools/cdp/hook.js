(async () => {
  if (!window.__m) {
    const P = PIXI.live2d.Live2DModel.prototype;
    await Promise.race([new Promise((res) => {
      for (const k of ['update', '_render', 'render']) {
        const orig = P[k]; if (typeof orig !== 'function') continue;
        P[k] = function (...a) { window.__m = this; P[k] = orig; res(); return orig.apply(this, a); };
      }
    }), new Promise((r) => setTimeout(r, 3000))]);
  }
  const m = window.__m; if (!m) return 'no model';
  const im = m.internalModel;
  return JSON.stringify({ url: im.settings.url, exps: (im.motionManager.expressionManager?.definitions || []).map((d) => d.Name),
    groups: Object.keys(im.motionManager.definitions), w: innerWidth, h: innerHeight, b: window.__deskPetBounds(), fig: window.__deskPetFigure });
})()
