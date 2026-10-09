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

These results do not prove native OS hit testing across mixed-DPI monitors or click-through preference modes. The feature's existing watch-only mode limitation remains documented. Full side-pane/chat-evidence integration gates have not been rerun for this approval branch; it is not yet merged into #34. GitHub CI has no result claimed here.
