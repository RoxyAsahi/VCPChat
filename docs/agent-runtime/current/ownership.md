# Codex Agent Ownership

Status: **implemented**

| Area | Owner boundary | Forbidden dependency |
| --- | --- | --- |
| App Server transport and lifecycle | `modules/codex-runtime/` | Renderer state, VCPToolBox source changes |
| Projection schema and reconciliation | `modules/codex-runtime/projection/` | Codex rollout internals, local transcript in Renderer |
| Agent IPC and workspace security | `modules/ipc/agentRuntimeHandlers.js`, `modules/ipc/ipcContracts.js`, `modules/codex-runtime/workspacePolicy.js`, `workspaceService.js` | archived Runtime contracts, undefined channels, arbitrary root/path from Renderer, generic exec/read/write IPC |
| Workbench state | `modules/ui-system/agent-workbench-store.js` | main-chat global refs, global attachment inference |
| Settings Draft state | `agent-settings-state.js`, `agent-settings-view.js` | page-global timer/queue, stale Snapshot overwrite |
| Runtime config apply | `runtimeConfig.js`, Runtime Manager apply coordinator | desired config entering Responses Adapter before confirmation |
| Attachment capabilities | `attachmentRegistry.js` | absolute paths in Renderer, SQLite, transcript or logs |
| Agent presentation | `modules/ui-system/agent-presentation/` | main renderer runtime state and persistence |
| Dock and Workspace view state | `agent-session-dock.js`, `agent-workspace-model.js` | arbitrary absolute paths, cross-Session file refs |
| VCP tools | existing bridge boundary | modifications to VCPToolBox, a second tool catalog |
| Release evidence | `docs/agent-runtime/current/receipts/` | status promotion without same-commit commands |
| Agent Workbench public entrypoints | `modules/ui-system/agent-workbench.js`, `agent-workbench-controller.js` | UI feature logic or Runtime protocol details |
| Agent Workbench private composition | `modules/ui-system/agent-workbench-implementation.js`, `agent-workbench-clients.js` | Main-process persistence or transport ownership |
| Agent Renderer instance lifecycle | `modules/ui-system/agent-presentation/fork/`, `agent-renderer-lifecycle.js` | initialization/disposal of main-chat mutable renderer singletons |
| Legacy Agent Runtime archive | `archive/agent-runtime/` | product imports, default CI, or packaged sources |

Reviewers should reject new modules that read `currentChatHistoryRef`, `currentSelectedItemRef`, `currentTopicIdRef`, `saveChatHistory`, or the main-chat `streamManager`.

`agent-workbench.js` is a composition root, not a destination for new message, Markdown, tool, approval, Dock, Workspace or action logic. The governance check enforces current file-size ceilings so growth requires extraction into the owned modules above.
