# Agent Message Renderer Fork 收据

## 来源

- 来源文件：`modules/messageRenderer.js`
- VChat commit：`d441675a2b11702b47e6e9269bf3ce6936258a9f`
- 源文件 SHA-256：`48dc26601e48698626310c5d2230fccc09eaa418a78561e75a67717b6cce06a3`
- 源文件基线：3770 行，164695 字节（Windows working-tree 换行）
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

## 同步策略

主聊天 renderer 后续变更不自动复制。每次同步都必须记录：来源 commit、涉及的纯展示函数、Agent 行为差异、对照测试和截图收据。
