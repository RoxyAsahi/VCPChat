# Visual Forensics Initial Findings — 2026-08-28

## Evidence standard

This ledger records only observations captured from the Electron renderer. A
source inspection, CSS selector review, or unit test is not a finding or a
resolution on its own. The checked reports are the light/dark general scan
manifests generated at `2026-08-28T03:08:41.321Z` and
`2026-08-28T03:09:10.548Z`, plus the production Agent Settings ModelPicker
manifests generated at `2026-08-28T03:30:26.917Z` (light) and
`2026-08-28T03:26:36.461Z` (dark).

## Triage

| Priority | Finding | Electron evidence | Minimal correction / gate | Current state |
| --- | --- | --- | --- | --- |
| P1 | Production ModelPicker card could resolve at `x=-4` and its center could hit the Settings header at `800x600`; this was a real clipping/stacking failure. | Earlier production probe recorded the off-screen card and foreign center hit. The current reports at every required viewport record a `230x50` fixed card at `x=11`, `z-index:100`, `topmostInsideCard:true`; after narrow and restored resize it remains a direct `body` child, in viewport, and topmost. | Portal the card with fixed geometry; preserve the existing native trigger. Dedicated production gate checks fixed/body/geometry/hit-test, Escape, focus restoration, and body inline-style cleanup. | Resolved; requires a fresh isolated pair after ModelPicker surface changes. |
| P2 | A generic `[role=tooltip]` probe could select an unrelated product tooltip after resize, so a green capture did not prove the Harness tooltip. | At light `1680x1000` the broad probe identified an off-surface unrelated node. Later Electron runs with `.vcp-harness-tooltip-bubble` record the intended fixed tooltip, its anchor, parent/scroll context, and pointer-events behavior. | Use the Harness-specific selector; retain noninteractive-tooltip hit-test exception while checking its fixed/body portal and viewport containment. | Resolved as QA provenance; no product visual defect is asserted. |
| P2 | Shared `reports/.../light` and `dark` folders permit screenshot/manifest mixing when parallel scans write concurrently. | The working tree had concurrent Electron processes while canonical reports were being refreshed; folder identity alone could not prove the two reports came from one paired run. | `486eebbc` adds `npm run test:visual-forensics-isolated-themes`, which creates one `run-*` directory and verifies only its exact light/dark pair, including pixel/geometry and computed-token contrast. | Resolved as evidence isolation; fresh isolated execution is queued until current scan contention clears. |
| P3 | Production model-row hover could be present in code without a visible, hittable state in the actual Settings surface. | Current light reports show `role:option`, `hovered:true`, `220x28` in-viewport geometry and `rgba(0,0,0,.04)`; dark reports show the same geometry with `rgba(255,255,255,.08)`. Both point hit-tests remain inside the card. | `40607358` requires hover geometry, hit testing, and `*-model-hover.png` for all three viewport captures. | Resolved by runtime evidence gate; rerun after related surface changes. |
| P2 (open) | A same-engine static Harness source-reference ROI now passes, but there is no equivalent paired capture of a Harness production consumer and VCP production surface. | `reports/harness-vcp-model-picker-same-engine-pixel-diff.json` records `150/35500` (`0.4225%`) differing pixels and mean delta `0.0326`, within the 1%/2 policy. Its reference report explicitly says `productionConsumer:false`. Production interaction reports prove portal/lifecycle correctness, not cross-consumer pixel equivalence. | Do not mark the primitive Stable or retire the legacy modal. Capture a matched production-consumer pair after product parity scope is agreed. | Open; static source-reference pixel gate passes, production pixel-equivalence remains unproven. |

## Observed passing behavior

The current general Electron manifests prove, at `800x600`, `1280x800`, and
`1680x1000` in both themes: initial open, distinct-root reopen, scroll,
narrow-and-restored resize, Settings context/cascade capture, visible
hover/focus/disabled/selected/loading/error/async-loading states, and
Menu/Modal/Tooltip geometry. At `800x600`, for example, the recorded Menu is
fixed/body-owned and topmost at `16,240,218x348`; the Settings overlay is fixed
at `0,0,800x600` and topmost; the keyboard focus capture has
`focusVisible:true`. The tooltip is deliberately excluded from center hit-test
ownership because its computed `pointer-events` is `none`.

The following commands passed against the checked real Electron reports:

```sh
node scripts/check-visual-forensics-evidence.mjs reports/visual-forensics-qa/light reports/visual-forensics-qa/dark
node scripts/check-visual-forensics-baseline.mjs reports/visual-forensics-qa/light reports/visual-forensics-qa/dark
node scripts/check-visual-qa-agent-model-picker.mjs reports/visual-forensics-qa/agent-model-picker/light reports/visual-forensics-qa/agent-model-picker/dark
```

These records are a current-host evidence baseline, not packaged-runtime,
cross-platform, or pixel-equivalence proof.
