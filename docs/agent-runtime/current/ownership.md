# Codex Agent Ownership

Status: **implemented**

| Area | Owner boundary | Forbidden dependency |
| --- | --- | --- |
| App Server transport and lifecycle | `modules/codex-runtime/` | Renderer state, VCPToolBox source changes |
| Projection schema and reconciliation | `modules/codex-runtime/projection/` | Codex rollout internals, local transcript in Renderer |
| Agent IPC and workspace security | `modules/ipc/agentRuntimeHandlers.js`, `modules/ipc/ipcContracts.js`, `modules/codex-runtime/workspacePolicy.js`, `workspaceService.js` | archived Runtime contracts, undefined channels, arbitrary root/path from Renderer, generic exec/read/write IPC |
| Workbench state | `modules/ui-system/agent-workbench-store.js` | main-chat global refs, global attachment inference |
| Settings Draft state | `agent-settings-state.js`, `agent-settings-view.js` | page-global timer/queue, stale Snapshot overwrite |
| Settings persistence and CAS | `agent-settings-coordinator.js` | Session A completion mutating Session B UI, page-global revision ownership |
| Runtime config apply | `runtimeConfig.js`, Runtime Manager apply coordinator | desired config entering Responses Adapter before confirmation |
| Attachment capabilities | `attachmentRegistry.js` | absolute paths in Renderer, SQLite, transcript or logs |
| Agent presentation facade | `modules/ui-system/agent-presentation/fork/agentMessageRenderer.js`, `agentMessageRendererImplementation.js` | main renderer runtime state and persistence; feature logic above 600 lines |
| Agent presentation content and lifecycle | `agent-renderer-markdown-pipeline.js`, `agent-renderer-message-lifecycle.js`, `agent-renderer-mermaid.js`, `agent-renderer-tool-results.js`, existing stream/session/DOM/action modules | shared mutable renderer singletons, global container cleanup, hidden Session reads |
| Dock and Workspace view state | `agent-session-dock.js`, `agent-session-dock-view.js`, `agent-workspace-model.js`, `agent-workspace-view.js` | arbitrary absolute paths, cross-Session file refs |
| Workspace async coordination | `agent-workspace-requests.js`, `agent-workspace-coordinator.js` | Store mutation, Dock ownership, stale request completion clearing a newer request |
| VCP tools | existing bridge boundary | modifications to VCPToolBox, a second tool catalog |
| Release evidence | `docs/agent-runtime/current/receipts/` | status promotion without same-commit commands |
| Agent Workbench public entrypoints | `modules/ui-system/agent-workbench.js`, `agent-workbench-controller.js` | UI feature logic or Runtime protocol details |
| Agent Workbench private composition | `modules/ui-system/agent-workbench-implementation.js`, `agent-workbench-clients.js` | Main-process persistence or transport ownership |
| Agent Workbench Views | `agent-workbench-*-view.js`, `agent-session-dock-view.js`, `agent-notification-view.js`, `agent-approval-view.js`, `agent-workspace-view.js` | preload/Runtime calls, Projection writes, cross-Session identity inference |
| Agent Session catalog | `agent-session-catalog-coordinator.js` | stale Agent catalog replacing a newer selection, transcript/Dock ownership |
| Agent Topic menu | `agent-topic-context-menu-view.js` | Runtime/preload calls, unowned document listeners, stale focus microtasks |
| Agent Renderer instance lifecycle | `modules/ui-system/agent-presentation/fork/`, `agent-renderer-lifecycle.js` | initialization/disposal of main-chat mutable renderer singletons |
| Agent Renderer LaTeX preprocessing | `agent-renderer-latex.js` | DOM access, global cache, Renderer Session state |
| Legacy Agent Runtime archive | `archive/agent-runtime/` | product imports, default CI, or packaged sources |
| Agent CSS entry and owners | `styles/ui-system/agent-workbench.css`, `agent-{shell,sidebar,composer,timeline,session-dock,workspace,activity,responsive,legacy-shell-adapter}.css` | direct rules in the entry, arbitrary import order, cross-page selectors outside legacy adapter |
| Runtime lifecycle ordering | `runtime-host-service.js`, `runtime-lifecycle-service.js` | Repository close before approval/waiter cleanup, old-generation UI/SQLite/transport writes |

Reviewers should reject new modules that read `currentChatHistoryRef`, `currentSelectedItemRef`, `currentTopicIdRef`, `saveChatHistory`, or the main-chat `streamManager`.

`agent-workbench.js` and `agent-workbench-implementation.js` are composition roots, not destinations for new message, Markdown, tool, approval, Dock, Workspace or action logic. Both are within the final 800-line gate; new behavior must enter the owned modules above rather than grow the composition files.
