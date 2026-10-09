# Desktop pet approval reliability — 2026-10-09

Continues PR #68 on the current #34 baseline (6c47c1b14240e8013e17e7e8709dbc3ef4eddd92). This branch preserves both upstream feature commits and the latest size/position migration; the only generated-file conflict was resolved by rebuilding the chat event graph.

## Reproduced problems and fixes

- A finite deadline at or before receipt was normalized to null, turning an expired replay into an indefinitely pending card. Such requests are now rejected; absent/null deadlines retain the existing unlimited behavior.
- Two offers could both pass the duplicate check while agent lookup was awaiting disk reads. The request is now reserved before lookup, so concurrent replay sends one card.
- Settlement during lookup previously found no map entry, after which the completed lookup resurrected the card. Settlement now removes the reservation; the continuation verifies its identity before delivery.
- The deadline is captured on receipt, checked after lookup and before forwarding an answer. Slow lookup cannot renew the TTL, and an expired click clears the stale card without forwarding a response.
- Shutdown clears unresolved reservations. Queue overflow also clears the evicted card rather than deleting only its main-process record.

The main window remains the final approval owner. This does not execute tools or bypass its dedupe/expiry/response flow.

## Evidence

The new controlled-lookup and expired-replay expectations failed against the original code (20 passed, 4 failed out of 24); after repair the focused queue/lifecycle/notification tests passed 30/30. The full deskpet suite passed 192/192; chat contracts passed 66 contracts / 857 events; check:ui-system passed.

Windows Electron QA used separate profiles and AppData with the user's locally supplied Core. It ran the actual notificationRenderer.js, pet page and preload, main IPC handlers, and Electron pointer input. Tool responses were captured in a QA array instead of sent to a backend. For each of the three Nova outfits it verified pointer Allow advances the queue, main-window Reject clears the pet card, and expiry closes the card without a tool response. Existing model/expression/reply checks were retained. Final result: 60 assertions, zero errors, including a composited screenshot pixel check for each approval card. See electron.json and the three screenshots.

The first hidden-window QA fixture correctly paused entrance animations at opacity zero, despite DOM visibility and successful pointer events. The final fixture sends the real visible-state IPC while keeping the OS window hidden. Screenshots were inspected after this correction; no product animation code was changed to make the fixture pass.

These results do not prove native OS hit testing across mixed-DPI monitors or click-through preference modes. The feature's existing watch-only mode limitation remains documented. Full integration validation is recorded below. GitHub CI has no result claimed here.

## Final integration validation

After merging the latest #34 first-run fixes (PR #86, 4e6f6a308368f63e50b924493aeb8f65adcca757) into the repaired approval tree e92f6e15a:

- deskpet: 194/194; side-pane: 672/672; chat-kernel: 279/279; workbench: 264/264; settings: 100/100.
- Chat contracts: 66 contracts / 857 events. Full check:chat-evidence and check:ui-system passed.
- Native release build and built-artifact smoke passed. Packaged-artifact smoke skipped because no unpacked build was supplied; the deliberate-invalid packaged-artifact runner passed.
- Separate Windows Electron run: 63 assertions, zero errors. Each outfit reports actual devicePixelRatio 1.5, renders the approval card in a pixel-checked screenshot, and completes real pointer/main-window/expiry round trips. See electron-150.json and *-approval-card-150.png.

The first scale experiment used only the process switch and reported devicePixelRatio 1, so it was rejected as 150% evidence. The installed Electron 44 offscreen API defaults its deviceScaleFactor to 1. The final fixture explicitly requests offscreen.deviceScaleFactor=1.5 and asserts the observed value. This is renderer-scale coverage, not a claim that native OS multi-monitor hit testing or the complete fresh-user setup flow passed. All profiles and AppData were isolated; normal application data and the user's running app were not changed.

## Latest dock update retained

During validation #34 advanced again to PR #87 (ee749fd8b06c9144eb924ecb85b774e7a00f4fa1), changing only the pet dock markup/renderer/styles and settings preview styles. That update was preserved by a normal merge. On this final tree, deskpet 194/194, settings 100/100, contracts 66/857 and the full UI-system check passed again. The preceding full side-pane/chat-kernel/workbench/chat-evidence checks apply to the #86 integration tree; they were not repeated after the dock-only update.

Final isolated Windows Electron at observed devicePixelRatio=1.5 passed 78 assertions with zero errors. In addition to the 63 model/approval/scale checks, each outfit verified the three dock actions, real pointer Hide remaining tucked while the cursor stays, reappearance after cursor leave/return, pointer Edit opening an in-viewport composer, and Escape closing it. Cursor reporting used the real deskpet:cursor preload path; mouse/keyboard actions used Electron input events. This does not claim native OS hit testing. See electron-final.json and *-three-button-pill.png. Existing approvals and Core licensing behavior are unchanged by the dock update.
