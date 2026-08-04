# Agent Message Renderer Fork 收据

## 来源

- 来源文件：`modules/messageRenderer.js`
- 最近审计的 VChat commit：`19fdff5f5c0d301126e8888c226c507929215c6e`
- 最近审计的源文件 SHA-256：`21f261a86138ca4e0c918b275ec3235d65c1e54cfa3a314095dc71c5bcd6e6a1`
- 最近审计的源文件：4044 行，178244 字节（Windows working-tree 换行）
- Fork 文件：`agentMessageRenderer.js`

首次建立副本时，源文件与 Fork 在统一为 LF 并移除结尾换行后逐字符相等。随后只执行以下机械变更：

1. 相对 import 从 `./renderer/` 调整为 `../../../renderer/`；
2. 全局导出由 `window.messageRenderer` 改为 `window.agentMessageRendererFork`；
3. 文件头增加来源收据链接。

首批行为不变的命名裁剪：

4. `mainRendererReferences` 机械改名为 `agentRenderContext`；
5. `initializeMessageRenderer` 机械改名为 `initializeAgentMessageRenderer`。
6. 增加显式 ES module exports。
7. 删除 history/selected/topic refs、历史保存、主聊天流管理器、主聊天菜单和迁移期全局导出。
8. 流式更新改为 Agent keyed animation-frame batcher；Session/participant/messages/settings 全部由显式 context provider 提供。

## 不可破坏的边界

- 原 `renderer.js`、`modules/messageRenderer.js`、`modules/renderer/messageContextMenu.js` 不因 Agent fork 修改。
- Fork 只能由 Agent Workbench 装配，不能回流主聊天初始化链。
- 删除展示能力前必须先有主聊天/Fork 对照 fixture。
- `currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory`、主聊天 `streamManager`、主聊天 context menu 和隐式助手身份必须逐步替换为显式 Agent adapter；在替换完成前不得接入正式 Workbench。
- 编辑、重试、分支和取消最终必须调用 Codex action adapter，不能直接修改 Projection SQLite 来伪造上下文。

## 独立演进策略

该 Fork 已成为 Agent 专用产品实现，不再要求跟随主聊天 renderer 逐行同步。来源 commit 和初始机械裁剪继续保留用于许可证、来源和安全审计；后续两侧只共享恶意 Markdown、链接、图片、代码复制、XSS 与视觉 golden 测试语料，不共享运行时代码，也不因主聊天新增功能而自动复制实现。

Agent 模块不得读取 `currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory` 或主聊天 `streamManager`。新增能力必须通过显式 Session context 和 Agent action adapter 接入。

2026-08-02 同步审查：上游加入主聊天音频播放器和 Python 附件的安全文本打开路径。两项不进入 Agent fork：当前 Codex/ToolBox 投影没有可信音频资源描述，而 Agent 文件动作必须经 `WorkspacePathRef` 与 Main-only workspace service，不能回退到主聊天的任意 `file:` 路径入口。来源哈希已更新；Agent 的现有 Markdown、代码、表格、链接、图片、reasoning 与工具投影能力不变。

2026-08-04 同步审查：主聊天增加异步历史加载的 render-session guard，并在追加消息后同步主界面 empty state。Agent 不复制这两处实现：Agent Timeline 已按 `sessionId + projectionRevision` 做 generation/revision 隔离，非当前 Session Patch 只进入 normalized store；Agent Workbench 也不使用主聊天的 `chatManager` empty-state owner。安全语料与 Session 切换测试继续作为两侧共享合同。
