# Codex Agent Ownership

Status: **implemented**

| Area | Owner boundary | Forbidden dependency |
| --- | --- | --- |
| App Server transport and lifecycle | `modules/codex-runtime/` | Renderer state, VCPToolBox source changes |
| Projection schema and reconciliation | `modules/codex-runtime/projection/` | Codex rollout internals, local transcript in Renderer |
| Agent IPC and workspace security | `modules/ipc/agentRuntimeHandlers.js`, `workspaceService.js` | arbitrary root/path from Renderer, generic exec/read/write IPC |
| Workbench state | `modules/ui-system/agent-workbench-store.js` | main-chat global refs, global attachment inference |
| Agent presentation | `modules/ui-system/agent-presentation/` | main renderer runtime state and persistence |
| VCP tools | existing bridge boundary | modifications to VCPToolBox, a second tool catalog |
| Release evidence | `docs/agent-runtime/current/receipts/` | status promotion without same-commit commands |

Reviewers should reject new modules that read `currentChatHistoryRef`, `currentSelectedItemRef`, `currentTopicIdRef`, `saveChatHistory`, or the main-chat `streamManager`.

