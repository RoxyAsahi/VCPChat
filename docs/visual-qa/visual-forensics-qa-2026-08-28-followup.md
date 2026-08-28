# Visual Forensics Follow-up - 2026-08-28

## Scope

This follow-up rechecked the real Electron Agent Settings and Agent Model
Picker surfaces. Chat rendering, streaming, protocol, persistence, Plugin
Loader, chat manifest, Composer internals, and DiffBlock remain excluded.

## Evidence

The checked-in global visual evidence remains valid:

- `npm run check:visual-forensics` passes for light/dark at `800x600`,
  `1280x800`, and `1680x1000`.
- `npm run test:visual-forensics-qa` completes a fresh real Electron scan.
- `npm run check:uiux:artifacts` passes for 78 generated files.
- `npm run check:harness-fixture-matrix` passes (150 visual, 32 interaction,
  DOM 10/10).

## Current ModelPicker Evidence Gap

The first dedicated capture attempt was run as:

```sh
node scripts/visual-qa-agent-model-picker.mjs
```

It did not reach a stable Agent Settings state within 90 seconds. The only
output is an incomplete manifest at:

`reports/visual-forensics-qa/agent-model-picker/light/manifest.json`

with `captures: []` and `gate.pass: false`. This was an instrumentation/startup
failure, not evidence of a renderer defect.

After the parallel ModelPicker test harness update resolved portaled-card lookup
through `aria-controls` (commit `3b812b0e`), the same production capture was
rerun successfully for both themes:

```sh
node scripts/visual-qa-agent-model-picker.mjs
VCPCHAT_VISUAL_QA_THEME=dark node scripts/visual-qa-agent-model-picker.mjs
```

The resulting manifests are:

- `reports/visual-forensics-qa/agent-model-picker/light/manifest.json`
- `reports/visual-forensics-qa/agent-model-picker/dark/manifest.json`

Each manifest contains 3 captures (`800x600`, `1280x800`, `1680x1000`) and
passes the dedicated gate. In every viewport the menu card is `position: fixed`,
`230x50`, `z-index: 100`, and its center hit-tests to a picker cell inside the
card. Escape removes the card, sets `aria-expanded="false"`, restores focus to
`#openModelSelectBtn`, and leaves body inline style empty. Light and dark runs
also report the expected body theme class and color scheme.

The current production stress command was also rerun:

```sh
npm run test:electron-agent-model-picker
```

An earlier run in the changing parallel worktree failed before opening the
picker with:

```text
Agent model picker interaction contract drifted:
{"available":true,"opened":false,"rootPane":false}
```

That failure was a stale test assumption about the card remaining under the
form. After commit `3b812b0e`, the command passes with stable lifecycle counts
(`474` listeners, `312` active resources, zero detached roots/options). The
test now resolves the owned portaled card via the trigger's `aria-controls`
contract.

## Required Next Probe

Before any Stable or pixel-equivalent claim:

1. Keep the dedicated three-viewport, two-theme manifests fresh when the
   ModelPicker source/artifact changes.
2. Add strict same-engine ROI pixel comparison; the existing approximately
   `6.19%` mismatch remains pending.
3. Retire the legacy model modal only after hot/favorite/explicit-refresh
   parity has production evidence.

## Classification

- Global showcase visual baseline: **passed**.
- Agent Settings production baseline: **passed**.
- Agent ModelPicker production interaction: **passed for both themes and all
  three fixed viewports**.
- Agent ModelPicker pixel equivalence: **pending**.
- Legacy model modal retirement: **pending**.
