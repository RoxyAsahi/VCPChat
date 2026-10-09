# Live2D desk pet prototype

Feasibility prototype only. Not wired into VCPChat and not meant for upstream.

```bash
# from the VCPChat root
node prototypes/deskpet/scripts/fetch-assets.mjs   # Cubism Core + Hiyori sample (not committed)
npx electron prototypes/deskpet/main.js
```

- Rendering: VCPChat's own `vendor/pixi.min.js` (Pixi 8.20.1) and
  `vendor/pixi-unsafe-eval.min.js`, plus `lib/untitled-pixi-live2d-engine`
  (MIT, v1.4.0 UMD build).
- Cubism Core must be 5.x. Core 6 (SDK 5-r.5, 2026-01) removed
  `drawables.renderOrders`, which every community Pixi engine still reads.
  Pass `--core <path to a 5.x live2dcubismcore.min.js>` to the fetch script.
- `DESKPET_BENCH=1` measures CPU/memory and writes JSON to `out/`;
  `scripts/xvfb-e2e.sh <dir>` drives click-through, tap and drag under Xvfb.
