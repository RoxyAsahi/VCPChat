# Handoff: Live2D desk pet review rounds (2026-10-09 03:35Z)

Thread: "Live2D 桌宠对抗审查". Base PR #34 (branch claude/project-thread-njw5ge, head now 418fc36b).
Working branch: claude/live2d-review-rounds-ooldch (last commit 63993b17). Nothing uncommitted. No WIP left.
Running log with details and screenshots: /mnt/project-files/deskpet/review-rounds/README.md

## Done (all merged into #34)
- Round 1, PR #54: no missing-Core error on built-in Nova; input bar close restores click-through; stop recording on hide/blur; overlapping replies; outfit-click race.
- Round 2, PR #56: skip sentences the TTS regex drops; same-name agent labels; card badge z-index; Live2D sway/emotion params applied before physics (hair now moves when dragged).
- Round 3, PR #61 (merged 03:13Z): atomic state.json + .bad backup; restore clamped to the saved display; snapshot job ids; blank snapshot retry and no-cache; honest settings choose/import; pet send deadline (no double send).

## Not fixed (decided low impact)
- Pet send switches the main window's agent and leaves the main input draft there. Same as switching agents by hand.
- Clicking the pet button again while the pet is still appearing re-opens it instead of closing it. The main button state is briefly wrong.
- A TypeError between WebGL context loss and the auto reload. Not visible to the user.
- The main window button shows the raw error code "agent-not-found".

## Sent to the "Nova 图片转 Live2D" thread (model art, never edit assets)
- Chibi closed eyes are nearly invisible when asleep.
- Chibi happy/sad/angry/shy expressions look almost identical.

## Next round ideas (not started)
- First run on a fresh AppData at 150% scale; voice cancel/retry with real TTS; long sleep then reply.

## Gotchas
- GitHub Actions is DISABLED on RoxyAsahi/VCPChat since ~02:18Z (workflow_dispatch refused). Run CI locally:
  `npm run test:chat-kernel`, `test:side-pane`, `test:workbench`, `check:ui-system`, `check:chat-contracts`, and each tests/deskpet-*.test.mjs on its own (`timeout 40 node --test --test-timeout=20000 tests/<file>`; the whole `test:deskpet` sometimes hangs).
- 2 failures in tests/side-plan-revert-record-failure.test.cjs are expected when running as root (chmod is ignored). They pass on a normal user account.
- After any IPC or line-shift change in deskPetHandlers.js etc., run `node scripts/build-chat-event-graph.mjs` and commit docs/contracts/generated/chat-event-graph.json.
- Cubism Core in /mnt/project-files/deskpet/vendor/ is for private testing only. Never commit it anywhere.
- No "ZCode"/"DSH" in code comments, test names or commits. Never push to pr/side-pane-workbench.
- Real-Electron testing: Xvfb + CDP harness; add `--force-device-scale-factor=1.5` to test DPI. Without a compositor, transparent windows show black in root screenshots.
