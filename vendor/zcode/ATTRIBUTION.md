# ZCode reference and adaptation record

Reference: https://github.com/zai-org/ZCode

Snapshot: `662c30bea4e833acaacbfb745a65eb09c23d55f8`. License: Apache-2.0; unmodified upstream LICENSE, NOTICE.md and THIRD-PARTY-NOTICES.md are included here. These notices describe upstream ZCode, not additional VCPChat runtime capabilities.

VCPChat adaptation: React/Tailwind presentation is rewritten as native DOM/CSS; Git, ProjectForge, notes, terminal and model data use VCPChat services. Source headers identify the referenced components when available. Root VCPChat licensing is not replaced by this directory.

The following files explicitly mention ZCode in the reviewed source. This is a source-derived inventory, not a completed line-by-line provenance or third-party dependency audit. Preserve applicable original copyrights and notices, and verify them before distribution.

- modules/ui-system/command-center.js
- modules/ui-system/conversation-find.js
- modules/ui-system/conversation-scope.js
- modules/ui-system/conversation-status-panel.js
- modules/ui-system/conversation-turn-navigator.js
- modules/ui-system/draft-suggested-prompts.js
- modules/ui-system/git-file-diff.js
- modules/ui-system/git-graph-layout.js
- modules/ui-system/message-export.js
- modules/ui-system/message-file-changes.js
- modules/ui-system/message-meta-enhancer.js
- modules/ui-system/selection-quote-action.js
- modules/ui-system/send-queue.js
- modules/ui-system/side-pane/gitSideProvider.js
- modules/ui-system/side-pane/modelTrajectoryModel.js
- modules/ui-system/side-pane/modelTrajectorySideProvider.js
- modules/ui-system/side-pane/planDetailSideProvider.js
- modules/ui-system/side-pane/side-pane-controller.js
- modules/ui-system/side-pane/side-pane-state.js
- modules/ui-system/side-pane/side-pane-tab-dnd.js
- modules/ui-system/side-pane/side-pane-tab-utils.js
- modules/ui-system/side-pane/terminalLinks.js
- modules/ui-system/side-pane/terminalSideProvider.js
- modules/ui-system/side-pane/terminalTheme.js
- modules/ui-system/side-pane/toolOutputSideProvider.js
- modules/ui-system/slash-commands.js
- styles/ui-system/chat-input.css
- styles/ui-system/command-center.css
- styles/ui-system/conversation-find.css
- styles/ui-system/send-queue.css
- styles/ui-system/shell.css
- styles/ui-system/side-pane-git-extras.css
- styles/ui-system/side-pane-model-trajectory.css
- styles/ui-system/side-pane-plan.css
- styles/ui-system/side-pane-tabs.css
- styles/ui-system/side-pane-tool-output.css
- styles/ui-system/side-pane.css
- styles/ui-system/sidebar.css
- styles/ui-system/status-panel.css
- styles/ui-system/tokens.css
- styles/ui-system/turn-navigator.css

## Quality repair adaptation (2026-10-01)

Re-read the fixed snapshot above for repair design:

| ZCode source | VCPChat adaptation / modification |
|---|---|
| packages/ui/src/lib/toolDiffPreview.ts | modules/ui-system/line-diff.js: unique-line anchors/LIS and bounded LCS adapted; added strict input/work/matrix budgets, approximation state and DOM pagination in the viewer. New source header identifies Apache-2.0 adaptation. |
| packages/services/src/zcode-agent/modelTrajectory.ts; modelTrajectoryFileTail.ts | modules/modelTrajectory.js and modelTrajectoryStorage.js: bounded recording/tail concepts; asynchronous serialized atomic storage, recursive metadata sanitization, opt-in/retention policy and generation isolation added. |
| packages/ui/src/GitPane.tsx; v4/ConversationStatusPanel.tsx | Git/status native DOM controllers: capture workspace identity, commit latest-generation results, close stale dialogs. |
| packages/ui/src/plugin-ui/adapters/pluginUiInteractions.ts | widgetBridge + contentProcessor: trusted host confirmation per request and recheck mounted session/context after await; iframe focus does not authorize. |

Notes save serialization and tool-state persistence were also compared against the local settings/task-state implementations. These are design comparisons; only the diff helper above introduces a new explicitly attributed code adaptation during this repair. The rest remain native VCPChat implementations with source references described in their headers. Preserve upstream notices provided in this directory.
