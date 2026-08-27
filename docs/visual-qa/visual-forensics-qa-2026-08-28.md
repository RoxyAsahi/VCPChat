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

## Finding: Agent Settings interaction stress exits 13

Command:

`npm run test:electron-agent-settings-interaction`

The stress script prints `Electron lifecycle stress passed`, but Node exits
with code 13 and reports an unsettled top-level await at
`scripts/test-electron-lifecycle-stress.mjs:1336`:

```js
await new Promise(resolve => modelServer?.close?.(() => resolve()));
```

The Agent Select interaction mode does not create `modelServer`, so the
optional `close` call does not invoke the callback and the Promise never
settles. This is a QA harness cleanup defect, not a renderer visual failure;
it must be fixed before treating the Agent Settings interaction command as a
clean gate.

## Visual conclusion

No new same-Surface overlap, horizontal overflow, theme-token, portal
positioning, focus-ring, reopen/dispose, or CSS cascade failure was observed in
this pass. Model Picker pixel equivalence remains an independent pending
condition (the paired ROI diff is still approximately 6.19% differing pixels),
so this evidence does not promote the primitive to Stable or pixel-equivalent.
