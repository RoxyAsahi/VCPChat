# Visual Forensics / CSS Cascade QA - 2026-08-28

## Scope

This pass inspected the shipped Electron renderer for the component showcase,
Agent Settings, and Agent Model Picker related surfaces. Chat rendering,
composer internals, streaming, protocol, persistence, Plugin Loader, and chat
manifest were out of scope.

## Evidence

The following checks passed in the current worktree:

- `npm run check:uiux:artifacts` (78 generated files)
- `npm run test:uiux` (61/61)
- `npm run check:harness-fixture-matrix` (150 visual, 32 interaction, DOM 10/10)
- `npm run check:visual-forensics` (light/dark, 800x600, 1280x800, 1680x1000)
- `npm run test:visual-forensics-qa` (fresh real Electron capture)
- `npm run test:electron-agent-model-picker` (lifecycle stress exit 0)

Fresh Electron evidence was written to:

`reports/visual-forensics-qa/2026-08-27T23-42-35.654Z/`

The capture includes fixed-viewport screenshots and runtime records for:

- Agent Settings sections and visible control geometry;
- Model Picker trigger, menu portal, selected state, and focus restoration;
- menu/modal/tooltip position and stacking;
- hover/focus/disabled/selected/error/loading states;
- close/reopen root identity and body cleanup;
- narrow resize followed by exact viewport restoration;
- live CDP matched-selector/cascade records, including Settings field rules.

## Finding (resolved): Agent Settings interaction stress cleanup

Initial command:

`npm run test:electron-agent-settings-interaction`

The stress script initially printed `Electron lifecycle stress passed`, but
Node exited with code 13 and reported an unsettled top-level await at
`scripts/test-electron-lifecycle-stress.mjs:1336`:

```js
await new Promise(resolve => modelServer?.close?.(() => resolve()));
```

The Agent Select interaction mode does not create `modelServer`, so the
optional `close` call does not invoke the callback and the Promise never
settles. This was a QA harness cleanup defect, not a renderer visual failure.

Parallel commit `431cbc6a` guarded the optional server cleanup. A rerun after
that fix exits 0 with stable lifecycle counts (`listeners=472`,
`lifecycleResources=327`, `detachedRoots=0`, `detachedOptions=0`).

## Visual conclusion

No new same-Surface overlap, horizontal overflow, theme-token, portal
positioning, focus-ring, reopen/dispose, or CSS cascade failure was observed in
this pass. The latest same-engine *static Harness source-reference* ROI reports
`150/35500` differing pixels (`0.4225%`) and passes its 1%/2 policy, but it is
explicitly not a Harness production consumer. Production ModelPicker pixel
equivalence therefore remains pending; this evidence does not promote the
primitive to Stable or pixel-equivalent.

## Finding (resolved): production Model Picker overlay anchor

The dedicated production probe initially found the canonical Agent Settings
trigger mounted beside a zero-width picker root. The shared absolute popup then
resolved to `x=-4` at all required viewports; at 800x600 its center was hit by
the underlying Settings header instead of the menu. This was a real Electron
geometry and stacking defect, not a static CSS finding.

The minimal repair keeps the native trigger as the business node, moves the
opened picker card to the body portal for the external-trigger composition, and
positions it from the trigger's live viewport rect with resize/scroll updates.
The probe now records `position: fixed`, `x=11`, body ownership, and
`topmostInsideCard=true` at 800x600, 1280x800, and 1680x1000 in both themes.
Escape closes the portal, restores focus to `openModelSelectBtn`, removes the
card, and leaves body inline style empty. Evidence is in
`reports/visual-forensics-qa/agent-model-picker/{light,dark}/manifest.json`;
the implementation was committed as `deefb364`.
