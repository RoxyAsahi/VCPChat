# ADR-008: Agent Renderer 独立演进

Status: **accepted**

## Decision

Agent Renderer 是独立产品实现，不再与主聊天 renderer 做逐行同步，也不抽取共享运行时组件。来源收据继续保留以说明最初的 clean-room/fork 基线；此后两侧只共享恶意 Markdown、链接、图片、代码复制、XSS 和视觉 golden 测试语料。

Agent 展示边界按职责拆分：

| Boundary | Modules |
| --- | --- |
| Message/Markdown/stream | `agent-presentation/renderer.js`、`markdown-stream*.js`、`stream-batcher.js` |
| Tool/approval/observation | `agent-presentation/blocks/` |
| Dock | `agent-session-dock.js` |
| Workspace | `agent-workspace-model.js`、Main-only `workspaceService.js` |
| Session actions/state | `agent-workbench-controller.js`、`agent-workbench-store.js` |
| Workbench composition | `agent-workbench.js` |

`agent-workbench.js` 只负责组合这些边界。新模块不得读取 `currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory`、主聊天 `streamManager` 或全局 attachment/current-session 推断。

## Consequences

- 主聊天修复不会自动进入 Agent Renderer；安全与视觉一致性由共享语料和 golden contract 检测。
- Agent 可以按 Codex Message/Block、审批和 Session identity 独立演进。
- 文件体量由治理脚本设置增长上限；超过上限必须继续提取职责模块，不能把新功能堆回 Workbench 或 fork 文件。
- 编辑、重试、分支、取消等动作必须通过 Agent action adapter 调用 Codex Thread/Turn API，不能修改 SQLite 投影伪造上下文。

## Rejected

- 修改主 `renderer.js` 以兼容 Agent 全局状态。
- 继续人工逐行同步主聊天 renderer。
- 让 Agent Renderer 读取主聊天当前助手、当前 Topic 或持久化回调。
