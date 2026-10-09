# Desk pet integration handoff (#34), 2026-10-09 03:35Z
## Current state
- PR #34 (draft): branch `claude/project-thread-njw5ge`, base #31 (`claude/project-thread-jgqxch`). Head **4f6e5bd8**, pushed; new work branches from here.
- Last head with CI green: 8d98d89b (#54). Everything after it was merged on local checks only.
- GitHub Actions has not run on RoxyAsahi/VCPChat since about 02:18Z (disabled or out of quota).
  Once it's back, run CI on the latest head and fix anything red first.
## Merged since 8d98d89b (local checks only)
- #55 one-click Core install (official download after the user accepts the EULA; nothing bundled)
- #57 pet comes back on top; #58 expression mapping; #56 / #61 review rounds 2 and 3
- #59 reply-driven gestures; #60 fullscreen yield; #62 click-through mode
- #64 header toggle removed, pet opened only from settings; #65 edge snapping
- #66 head pats from the model's HitAreas; #67 wings no longer count toward head width; #63 chibi Nova v2
- #60 (`yieldToFullscreen`) now **defaults to off**. Its PowerShell detection can only be tested on Windows CI.
  Switch it back on after that passes: petPrefs.js default plus deskpet-panel.js.
## Waiting
- Nothing waiting. #63 (chibi Nova v2) was merged at 4f6e5bd8 after the Nova thread fixed the expression mouths (lip sync, blink, grey band) and screenshot QA passed.
## How to merge (each PR, one at a time)
1. Fetch `origin claude/project-thread-njw5ge` and fast-forward, then `git merge --no-ff --no-commit <pr head>`.
2. Event graph conflict: `git checkout --ours docs/contracts/generated/chat-event-graph.json`,
   then `node scripts/build-chat-event-graph.mjs`. Regenerate after every merge, even with no conflict.
3. Conflicts elsewhere: keep both sides. Merge the `test:deskpet` lists in package.json.
4. Run all of these:
   - test:deskpet
   - test:deskpet again with win32 emulated: `node --require win32.cjs --test tests/deskpet-*.test.mjs`.
     Its only expected failure is the test that needs real powershell.exe.
   - test:side-pane, plus `node --test tests/settings-*.test.mjs`
   - check:chat-contracts, check:chat-evidence, check:ui-system
5. Lifecycle tests: `loadHandlers()` loads as win32, so **every test that opens a pet must end with `handlers.closeAll()`**.
   Otherwise the hit-poll interval keeps the process alive and the file hangs. This happened twice after merges.
6. Real-Electron smoke (Xvfb plus a mock model): open Nova's pet, send one message, check the bubble shows the reply and there are no page errors.
7. While Actions is down, every merge commit says CI was unavailable. Push with a normal merge; never force.
## Rules
- Never push to pr/side-pane-workbench. No "ZCode"/"DSH" in code, tests or commits. Never commit Live2D official samples or Cubism Core.
