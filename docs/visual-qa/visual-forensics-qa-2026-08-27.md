# Visual Forensics / CSS Cascade QA

This is an independent, evidence-first QA track for the shipped Electron UI. A static CSS review or a green unit test is not accepted as visual proof. The scanner is `scripts/visual-forensics-qa.mjs` and is run with:

```sh
npm run test:visual-forensics-qa
```

It launches the real Electron entry with an isolated app-data directory, attaches Puppeteer through the Electron remote-debugging endpoint, opens the component showcase when available, and writes PNG plus JSON evidence under `reports/visual-forensics-qa/<timestamp>/`. Every viewport records initial, scrolled, and resized states, visible control geometry, computed color/surface/position/z-index/radius, portal candidates, body DOM size/classes/inline style, and overflow/overlap gate results.

Use `npm run test:visual-forensics-themes` for the light/dark matrix. It runs the same real Electron scanner once per theme and stores evidence under `reports/visual-forensics-qa/light/` and `reports/visual-forensics-qa/dark/`.

## First-round findings

| Priority | Finding | Runtime evidence | Status |
| --- | --- | --- | --- |
| P0 | Required Electron matrix is not covered by the existing gates. | Existing smoke uses the default window and a 480x720 narrow pass; settings uses 700x500. | Addressed by the new scanner; real run captured all three viewports. |
| P1 | Resize/scroll behavior is not a cross-surface regression gate. | Existing scripts capture selected journeys but do not sweep resize back to wide or assert horizontal overflow. | Addressed by the new scanner. |
| P1 | Portal/menu/modal/tooltip placement and z-index are not systematically captured. | Existing showcase smoke checks presence and teardown; no generalized geometry snapshot exists. | Scanner records portal candidates; interaction fixtures remain follow-up. |
| P1 | Harness source capture is currently blocked by two missing aliases. | `npm run check:harness-capture-prerequisites` reports `capture-prerequisites-missing` for deepseek-harness Cordis and Playwright aliases. | External prerequisite; no dependency changes made. |
| P2 | Candidate primitive pixel parity and production-consumer evidence remain incomplete. | Reference pack checks pass (47 files, 22 contracts; 63 visual and 20 interaction cases), but candidate statuses still contain pending pixel/consumer work. | Track per fixture before promotion. |

## Verified baseline commands

On 2026-08-27 in the current dirty worktree:

- `npm run check:harness-reference` passed (47 files, 22 primitive contracts).
- `npm run check:harness-fixture-matrix` passed (63 visual cases, 20 interaction cases, DOM 10/10).
- `npm run check:harness-capture-prerequisites` reported missing prerequisites (expected until the external Harness checkout supplies the aliases).
- `npm run test:visual-forensics-qa` launched the real Electron renderer and wrote evidence to `reports/visual-forensics-qa/2026-08-27T21-47-38.601Z/` and `/tmp/vqa-third/`. The initial run exposed a false positive caused by comparing controls from the underlying chat surface with showcase controls. The scanner now groups overlap checks by owning Surface; the corrected three-viewport run passed with no same-Surface overlap or horizontal overflow. Electron stderr still records the missing local CDS binary and intentionally unreachable model endpoint as environment prerequisites.
- Lifecycle follow-up runs passed independently for both themes: `/tmp/vqa-light-final/manifest.json` and `/tmp/vqa-dark-final/manifest.json`. Each covered all three viewports, recorded `disabled=27`, `selected=9`, `error=6`, `loading=2`, and ended with a passing overlap/overflow gate. Dark evidence has `bodyClass=dark-theme`; light evidence has `bodyClass=light-theme`. The scanner now tears down the Electron process group with bounded browser-close/child-close waits so the theme matrix does not leak processes.
- Overlay and lifecycle evidence from `/tmp/vqa-overlays/manifest.json` and `/tmp/vqa-overlays-dark/manifest.json` passed in both themes. Menu opened with `position:fixed; z-index:1100` under `body` (218x348, 8 items); Modal opened with a mask and a 380x220 dialog; Tooltip opened with fixed positioning and `data-side=top`. Close/reopen removed the showcase root, restored body classes/inline style, and recreated a distinct root identity.
- Settings context evidence from `/tmp/vqa-settings-context2/manifest.json` passed in Electron. The real `globalSettingsModal` opened from the running renderer; the active settings section measured 516x302 at the captured viewport and 19 visible controls were recorded with parent classes, colors, backgrounds, and geometry. The modal then closed before the viewport sweep, preserving showcase ownership.
- CSS cascade evidence from `/tmp/vqa-cdp/manifest.json` now includes CDP `CSS.getMatchedStylesForNode` output for every viewport. The scanner records matched selectors, origin, stylesheet id, and key declarations; the captured sidebar target showed both the specific `html #toggleSidebarModeBtn.next-ui-sidebar-mode-button` rule and the broader `html .vcp-ui-scope .next-ui-icon-button` rule, providing concrete specificity/cascade provenance instead of static-source inference.
- State pixel evidence from `/tmp/vqa-states/` passed in dark theme for all three viewports. Each viewport now has `*-hover.png` and `*-focus.png`; the real Candidate Lab primary button reported a hover background of `rgb(18, 103, 214)` and a focus outline of `2px` with the accent token. This is paired with the DOM counts for disabled, selected, error, and loading states rather than inferred CSS classes alone.

## Scope and frozen boundaries

The QA task may inspect and minimally repair presentation code, CSS ownership, overlay positioning, and lifecycle cleanup. It must not modify StreamCoordinator, StreamProjection, MessageRenderer, ChatDomRenderer, chat rendering/protocol/IPC/persistence, Plugin Loader, `chatPluginManifest`, or Composer internal layout. React/Vue/Cordis/Shadow DOM are not introduced as implementation defaults. Each future visual defect gets a minimal fixture, a regression PNG/JSON, and a gate result before a fix is accepted.

## Next scan expansion

The next iteration should drive the showcase and Settings controls through light/dark plus hover, focus, disabled, selected, error, and loading states, then assert menu/modal/tooltip portal geometry and post-dispose class/inline-style cleanup. Those interactions are intentionally separate from this first scanner so a failed state-specific fixture identifies one defect rather than hiding it in a broad smoke test.
