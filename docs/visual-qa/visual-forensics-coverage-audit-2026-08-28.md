# Visual Forensics Coverage Audit — 2026-08-28

## Evidence rule

Every **passed** row below is backed by a real Electron report, not by a source
inspection or a unit test. Source and fixture checks only explain the gate;
they do not upgrade a missing renderer capture to passing evidence.

## Current coverage

| Requirement | Electron evidence and gate | Status |
| --- | --- | --- |
| Fixed `800x600`, `1280x800`, `1680x1000` viewports in light and dark | Fresh isolated Showcase pair `reports/visual-forensics-qa/run-ETzhLD/{light,dark}`, three observations each; `check-visual-forensics-evidence` and `check-visual-forensics-baseline` pass for all six combinations. | Passed |
| First open, close/reopen, root identity, and cleanup | `run-KCjtuH` records `openedInitially`, `removedOnClose`, `reopened`, `newRootIdentity`, and empty body inline style for every observation. | Passed |
| Scroll, narrow viewport, and restored viewport | Every `run-KCjtuH` observation records moved showcase scroll owner, narrow width `width - 240`, no horizontal overflow, and restored dimensions. | Passed |
| Screenshot, geometry, computed style, DOM, and CSS cascade provenance | The isolated manifests include per-state screenshots, client rects, computed colors/tokens, root DOM tree, CDP matched rules with specificity/cascade order, and real Settings context samples. | Passed |
| Light/dark tokens and visible hover/focus/disabled/selected/loading/error states | Explicit paired token contrast, in-viewport interaction state fields, and non-blank/delta screenshot baseline all pass in `run-KCjtuH`. | Passed |
| Menu, Modal, Tooltip and portal placement | Menu/Modal center hit tests are inside their surfaces; Tooltip fixed/body portal and geometry are checked across original, narrow, and restored widths. Tooltip center ownership is intentionally not required when computed `pointer-events:none`. | Passed |
| Settings context deformation and cleanup | The scanner captures showcase-vs-Settings ancestry/geometry, all eight Settings sections, settings cascade, overlay containment, and post-close body style. | Passed |
| Agent Settings DisclosureRow transition semantics | Fresh real Electron production capture `reports/vcp-agent-settings-production.json` records six mounted section owners. Header click opens the canonical section, native toggle click closes it, and Enter on the native toggle reopens it; each state records `.collapsed`, toggle `aria-expanded`, content geometry, and confirms the header carries no invalid nested-button role/tabindex/aria-expanded. `npm run check:agent-settings-production-evidence` passes. | Passed |
| Next sidebar Account menu and App Tray | Fresh real Electron pair `reports/visual-forensics-qa/sidebar-account-tray/run-dirty/{light,dark}` covers `800x600`, `1280x800`, and `1680x1000`: account menu open/hover/focus/Escape/reopen, tray open/hover/focus/Tooltip portal/Escape/reopen, min-height and topmost hit tests, and authored cascade contracts. Both theme manifests report `gate.pass:true`. | Passed |
| Next notification quick-actions menu | Fresh real Electron pair `reports/visual-forensics-qa/notification-menu/run-0912/{light,dark}` covers `800x600`, `1280x800`, and `1680x1000`: all seven role-backed items, generated neutral Button geometry, hover/focus, filter selected state, Escape/reopen, fixed compact-window placement, topmost hit tests, and empty body inline style after close. Both theme manifests report `gate.pass:true`. | Passed |
| Production Agent Settings ModelPicker | Fresh isolated pair `reports/visual-forensics-qa/agent-model-picker/run-safe-top-retry/{light,dark}` passes its independent verifier at all three viewports after the portal safe-area fix. | Passed |
| Production ModelPicker hover / resize / Escape | Each `run-safe-top-retry` capture records an enabled `role=option` with visible `:hover`, finite viewport rect, card-contained hit test, fixed/body portal after narrow and restoration, and Escape focus/body cleanup. | Passed |
| Same-engine static Harness source-reference pixel ROI | `reports/harness-vcp-model-picker-same-engine-pixel-diff.json`: `150/35500` pixels (`0.4225%`), mean delta `0.0326`, within 1%/2 policy. | Passed for static source reference only |
| Production-consumer-to-production pixel equivalence | No paired Harness production consumer capture exists. The static reference is explicitly `productionConsumer:false`. | Open — do not claim Stable or legacy-modal retirement |
| Freshness after dirty worktree UI changes | Current dirty snapshot was captured in isolated pair `reports/visual-forensics-qa/run-ETzhLD/{light,dark}` after the current Showcase, component-manifest, and `main.html` worktree changes. Both manifests have three observations and `gate.pass:true`; exact-pair evidence, token contrast, and all six pixel/geometry baseline checks pass. | Passed for this snapshot; rerun after subsequent UI edits settle |

## Notification menu compact-viewport regression

The first real Electron capture of the newly adopted notification actions
found a P1 compact-window defect: at light `800x600`, the open menu measured
`x=754.9`, `width=196`, while the viewport width was only `800`; its centre
hit-test therefore fell outside the menu. The defect was caused by the
absolute menu resolving against a right-hand rail containing block after that
rail had moved beyond the compact viewport. The presentation-only correction
in `styles/ui-system/notifications.css` uses a fixed, viewport-safe placement
under `960px`, preserving the production controller and its business actions.

The post-fix pair is `notification-menu/run-0912/{light,dark}`. In both
themes, the `800x600` record has a fixed menu at `x=596`, `width=196`,
`right=8px`, in-viewport and topmost. It also records the filter transition to
`aria-checked=true`, visible hover/focus, Escape focus return to
`#nextUiNotificationMenuBtn`, reopen, and no body inline-style residue.

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

## Current Tooltip lifecycle refresh

The current isolated pair is:

```text
reports/visual-forensics-qa/run-aMd3YS/light
reports/visual-forensics-qa/run-aMd3YS/dark
```

This replaced the earlier intermittent Tooltip capture evidence. The scanner
now records initial Tooltip geometry before the Menu/Modal sequence, then
separately verifies the same body-owned, fixed portal after narrow resize and
after restoring the original width. In both themes and at all three required
viewports, the manifests record `open:true` for initial, narrow, and restored
Tooltip states, along with rendered hover evidence. The exact evidence verifier
and every pixel/geometry baseline pass for this pair; this conclusion is based
on the real Electron screenshots and manifests, not static source inspection.

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

The later pair `run-b6wG3o` supersedes this checkpoint after Agent Settings
DisclosureRow adoption and the production ModelPicker portal safe-area work.

## Current production ModelPicker freshness checkpoint

The current dirty production ModelPicker artifacts were independently scanned
in real Electron at:

```text
reports/visual-forensics-qa/agent-model-picker/run-current/light
reports/visual-forensics-qa/agent-model-picker/run-current/dark
```

Each theme contains three complete observations for `800x600`, `1280x800`,
and `1680x1000`, with `gate.pass:true`. The exact production verifier passed
for this pair. Refresh/favorite directory actions, enabled option hover,
narrow/restored portal geometry, Escape root-pane return, close/focus restore,
and body inline-style cleanup were all recorded from the rendered Settings
surface. The capture process can remain alive briefly after writing a complete
manifest during Electron teardown; that process-level delay does not weaken
the already-written renderer evidence.

## Production ModelPicker chrome-safe portal regression

A fresh production scan found a real compact-height defect: at light
`800x600`, after switching to the model directory pane, `Refresh models` could
be geometrically inside the viewport at `y=27` but be hit by window chrome
rather than the fixed card. The correction keeps the body portal below a
`48px` window-chrome safe area and lets its owner observe card-size changes so
asynchronous directory content repositions the same portal. The exact pair:

```text
reports/visual-forensics-qa/agent-model-picker/run-safe-top-retry/light
reports/visual-forensics-qa/agent-model-picker/run-safe-top-retry/dark
```

passes the independent production verifier for all six theme/viewport
captures. It checks screenshot dimensions, Refresh `directoryBusy=true` with
disabled `Refreshing…`, favorite transition, real option hover, fixed/body
portal geometry after narrow/restored resize, Escape focus return, and body
inline-style cleanup. Legacy parity also passes; the legacy modal remains
intentionally retained.

## Directory-action transient-state checkpoint

The production ModelPicker scanner now exercises the injected directory
capabilities in the renderer instead of only measuring their static geometry.
For every viewport and theme it clicks `Refresh models` and records the
immediate `directoryBusy=true`, disabled button, and `Refreshing...` label;
it then clicks a real favorite action and records the pressed/busy transition.
The regression screenshots are `*-model-directory-busy.png` and
`*-model-directory-favorite.png`.

The isolated pair

```text
reports/visual-forensics-qa/agent-model-picker/run-actions/light
reports/visual-forensics-qa/agent-model-picker/run-actions/dark
```

contains three complete observations per theme and passes the explicit
production verifier. This closes the previously unmeasured directory-action
loading/selected interaction evidence; it does not change the separate,
still-open production-consumer pixel-equivalence claim.
