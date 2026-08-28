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

The dedicated capture command was run as:

```sh
node scripts/visual-qa-agent-model-picker.mjs
```

It did not reach a stable Agent Settings state within 90 seconds. The only
output is an incomplete manifest at:

`reports/visual-forensics-qa/agent-model-picker/light/manifest.json`

with `captures: []` and `gate.pass: false`. This is an instrumentation/startup
failure, not evidence of a renderer defect.

The current production stress command was also rerun:

```sh
npm run test:electron-agent-model-picker
```

In the current parallel worktree it fails before opening the picker with:

```text
Agent model picker interaction contract drifted:
{"available":true,"opened":false,"rootPane":false}
```

Because this run does not reach the interaction sequence, it cannot establish
whether the failure is caused by the current ModelPicker changes, startup
timing, or test-state setup. The previous passing evidence must therefore be
treated as historical until this exact worktree state is rerun successfully.

## Required Next Probe

Before any Stable or pixel-equivalent claim:

1. Run the production stress probe after the parallel ModelPicker artifact and
   source changes settle; capture the first failing selector/state and the
   renderer stderr tail.
2. Make the dedicated capture launcher reliably select `VisualQA`, open the
   model section, and record all three viewports in both themes.
3. Record menu-center `elementFromPoint`, portal ancestor chain, computed
   z-index/position/overflow, Escape/focus restoration, and close cleanup.
4. Keep the existing approximately `6.19%` same-engine pixel mismatch pending.

## Classification

- Global showcase visual baseline: **passed**.
- Agent Settings production baseline: **previously passed; rerun required for
  current worktree**.
- Agent ModelPicker production interaction: **evidence gap / currently
  failing probe**.
- Agent ModelPicker pixel equivalence: **pending**.
- Legacy model modal retirement: **pending**.

