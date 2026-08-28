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

## 2026-08-28 Resize and provenance checkpoint

The production ModelPicker probe now keeps its card open through a narrow
resize (`width - 240`) and a restore to the original viewport. In both light
and dark Electron runs, at `800x600`, `1280x800`, and `1680x1000`, each narrow
and restored capture proves that the card is open, `position: fixed`, a direct
`body` portal, fully within the viewport, and topmost at its center. Escape
after the restored capture still removes the card and restores focus to
`#openModelSelectBtn` without body inline-style residue.

The shared Showcase probe also now records viewport-visible screenshots for
disabled/selected, loading/error/async-loading, hover/focus, and narrow
Menu/Modal/Tooltip states. A real QA-provenance defect was found during this
work: a broad `[role=tooltip]` fallback could select an unrelated product
tooltip at light `1680x1000` after a resize. Harness Tooltip fixtures now
require `.vcp-harness-tooltip-bubble`; subsequent real Electron scans resolve
the expected fixed `body` portal in both themes and all required viewports.

Pixel/geometry baseline coverage is derived from the fixture matrix so that a
new screenshot fixture cannot exist without non-blank image validation. These
are rendering-evidence improvements only; they do not claim same-engine pixel
equivalence or authorize retirement of the legacy model modal.

## Paired-run provenance checkpoint

Shared `reports/visual-forensics-qa/light` and `dark` locations are convenient
for inspection but are not safe proof of one paired Electron run while other QA
workers are writing them. Commit `486eebbc` adds:

```sh
npm run test:visual-forensics-isolated-themes
```

The command writes a fresh, exclusive `reports/visual-forensics-qa/run-*/`
directory, captures both themes serially, and runs the semantic evidence gate,
computed light/dark token contrast, and pixel/geometry baseline only against
that exact pair. The verifier accepts explicit paired directories and rejects a
pair that does not contain both themes; it no longer falls back to shared
canonical reports for the token assertion.

Commit `40607358` additionally requires production ModelPicker reports to
contain a viewport-visible `role="option"` hover sample with an active
`:hover` state, card-contained hit test, finite in-viewport geometry, and the
matching `*-model-hover.png` capture. Existing real Electron light/dark
manifests passed that strengthened gate. A fresh isolated ModelPicker pair
should be created before treating this as current evidence after any related
surface change.

## Fresh isolated showcase run

`npm run test:visual-forensics-isolated-themes` completed in real Electron on
2026-08-28 and wrote one paired run at:

```text
reports/visual-forensics-qa/run-KCjtuH/light
reports/visual-forensics-qa/run-KCjtuH/dark
```

The light manifest was generated at `2026-08-28T03:41:10.548Z`; the paired
dark manifest was generated by the same serial runner. The exact pair passed
the evidence verifier, the light/dark computed-token contrast assertion, and
the pixel/geometry baseline at `800x600`, `1280x800`, and `1680x1000` for both
themes (six viewport-theme captures). Runtime records prove initial open,
distinct-root reopen and body inline-style cleanup, scroll-owner movement,
narrow/restore without horizontal overflow, visible hover/focus/disabled/
selected/loading/error/async-loading states, Settings cascade/context capture,
and Menu/Modal/Tooltip geometry. The tooltip remains correctly exempt from
topmost ownership because its computed `pointer-events` is `none`.

The Electron stderr includes the pre-existing missing CDS binary, deliberately
unreachable local model endpoint, and unavailable Rust sidecar. The scan still
rendered the target surfaces and every visual gate passed; these environment
messages are not classified as visual failures.

## Required Next Probe

Before any Stable or pixel-equivalent claim:

1. Keep the dedicated three-viewport, two-theme manifests fresh when the
   ModelPicker source/artifact changes.
2. Capture a strict same-engine ROI pair for the production consumer. The
   current static Harness source-reference pair passes at `150/35500`
   (`0.4225%`) under its 1%/2 policy, but cannot establish production
   pixel-equivalence.
3. Retire the legacy model modal only after hot/favorite/explicit-refresh
   parity has production evidence.

## Classification

- Global showcase visual baseline: **passed**.
- Agent Settings production baseline: **passed**.
- Agent ModelPicker production interaction: **passed for both themes and all
  three fixed viewports**.
- Agent ModelPicker pixel equivalence: **pending**.
- Legacy model modal retirement: **pending**.
