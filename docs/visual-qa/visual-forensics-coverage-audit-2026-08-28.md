# Visual Forensics Coverage Audit — 2026-08-28

## Evidence rule

Every **passed** row below is backed by a real Electron report, not by a source
inspection or a unit test. Source and fixture checks only explain the gate;
they do not upgrade a missing renderer capture to passing evidence.

## Current coverage

| Requirement | Electron evidence and gate | Status |
| --- | --- | --- |
| Fixed `800x600`, `1280x800`, `1680x1000` viewports in light and dark | Isolated Showcase pair `reports/visual-forensics-qa/run-KCjtuH/{light,dark}`, three observations each; `check-visual-forensics-evidence` and `check-visual-forensics-baseline` pass for all six combinations. | Passed |
| First open, close/reopen, root identity, and cleanup | `run-KCjtuH` records `openedInitially`, `removedOnClose`, `reopened`, `newRootIdentity`, and empty body inline style for every observation. | Passed |
| Scroll, narrow viewport, and restored viewport | Every `run-KCjtuH` observation records moved showcase scroll owner, narrow width `width - 240`, no horizontal overflow, and restored dimensions. | Passed |
| Screenshot, geometry, computed style, DOM, and CSS cascade provenance | The isolated manifests include per-state screenshots, client rects, computed colors/tokens, root DOM tree, CDP matched rules with specificity/cascade order, and real Settings context samples. | Passed |
| Light/dark tokens and visible hover/focus/disabled/selected/loading/error states | Explicit paired token contrast, in-viewport interaction state fields, and non-blank/delta screenshot baseline all pass in `run-KCjtuH`. | Passed |
| Menu, Modal, Tooltip and portal placement | Menu/Modal center hit tests are inside their surfaces; Tooltip fixed/body portal and geometry are checked across original, narrow, and restored widths. Tooltip center ownership is intentionally not required when computed `pointer-events:none`. | Passed |
| Settings context deformation and cleanup | The scanner captures showcase-vs-Settings ancestry/geometry, all eight Settings sections, settings cascade, overlay containment, and post-close body style. | Passed |
| Production Agent Settings ModelPicker | Isolated pair `reports/visual-forensics-qa/agent-model-picker/run-PVaBFj/{light,dark}` passes its independent verifier at all three viewports. | Passed |
| Production ModelPicker hover / resize / Escape | Each `run-PVaBFj` capture records an enabled `role=option` with visible `:hover`, finite viewport rect, card-contained hit test, fixed/body portal after narrow and restoration, and Escape focus/body cleanup. | Passed |
| Same-engine static Harness source-reference pixel ROI | `reports/harness-vcp-model-picker-same-engine-pixel-diff.json`: `150/35500` pixels (`0.4225%`), mean delta `0.0326`, within 1%/2 policy. | Passed for static source reference only |
| Production-consumer-to-production pixel equivalence | No paired Harness production consumer capture exists. The static reference is explicitly `productionConsumer:false`. | Open — do not claim Stable or legacy-modal retirement |
| Freshness after dirty worktree UI changes | Current dirty snapshot was captured in isolated pair `reports/visual-forensics-qa/run-X0eTSy/{light,dark}` at `2026-08-28T04:02:28.108Z` / `04:02:57.346Z`. Both manifests have three observations and `gate.pass:true`; exact-pair evidence, token contrast, and all six pixel/geometry baseline checks pass. | Passed for this snapshot; rerun after subsequent UI edits settle |

## Commands for exact evidence pairs

```sh
node scripts/check-visual-forensics-evidence.mjs \
  reports/visual-forensics-qa/run-KCjtuH/light \
  reports/visual-forensics-qa/run-KCjtuH/dark
node scripts/check-visual-forensics-baseline.mjs \
  reports/visual-forensics-qa/run-KCjtuH/light \
  reports/visual-forensics-qa/run-KCjtuH/dark
node scripts/check-visual-qa-agent-model-picker.mjs \
  reports/visual-forensics-qa/agent-model-picker/run-PVaBFj/light \
  reports/visual-forensics-qa/agent-model-picker/run-PVaBFj/dark
```

The capture scripts only isolate renderer evidence. They do not authorize
changes to StreamCoordinator, StreamProjection, message rendering, chat
protocol/IPC/persistence, Plugin Loader, chat plugin manifest, or Composer
internals. No such files are changed by the Visual Forensics commits listed in
this audit.

## Startup-race regression evidence

The first current-worktree dark leg (`run-sr6Dp2/dark`) reached DevTools but
enumerated pages before `main.html` was available and wrote a zero-observation
failure manifest. `92d34613` changed the scanner to wait, within its existing
90-second budget, for the actual renderer page rather than treating that
startup race as a visual defect. The replacement isolated pair `run-X0eTSy`
then passed both themes and all gates above. This is a QA harness correction;
it does not alter product rendering.

## Current dirty-worktree freshness checkpoint

After the subsequent uncommitted theme, Showcase, Settings, and generated
artifact changes present on 2026-08-28, the isolated real-Electron scanner was
run again. The exact paired output is:

```text
reports/visual-forensics-qa/run-y3bh9m/light
reports/visual-forensics-qa/run-y3bh9m/dark
```

Both manifests contain the three required fixed viewports and `gate.pass:true`.
The exact-pair evidence check, light/dark computed-token contrast, and all six
pixel/geometry baselines passed. This refresh covers first-open/reopen,
scroll, narrow/restored dimensions, visible interaction/transient states,
Settings cascade/context, portal geometry, and cleanup on the current dirty
renderer—not just the earlier committed snapshot.

The Electron stderr still records the expected unavailable CDS binary, local
model endpoint, and Rust sidecar. The rendered target surfaces and every
visual gate completed successfully, so these environment messages remain
outside the visual-defect ledger.
