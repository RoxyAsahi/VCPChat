# Workbench Presentation 并行施工线

状态：Full Fork 已默认接入正式 Workbench 并进入 `29c2068a`；产品仍为 experimental，尚缺视觉与 live 门槛。

## 目的

本施工线只负责 `AgentTimelinePart -> 主聊天同构 DOM`，不负责 Codex App Server、Projection SQLite、IPC、审批路由或 ToolBox 执行。它可以与 Runtime/Projection/Electron smoke 并行开发。

## 当前文件所有权

Presentation 线可独立修改：

- `modules/ui-system/agent-presentation/**`；
- `scripts/test-agent-presentation.mjs`；
- 后续新增的 presentation fixture、gallery 和专用 CSS。

Runtime/Projection 与 Presentation 已在当前 working tree 完成集中接线。后续同步 Fork 时仍不得绕过各自边界，尤其不得让 Presentation 直接修改：

- `modules/codex-runtime/**`；
- `modules/ipc/**` 与 `preloads/**`；
- `agent-workbench-store.js`；
- `agent-workbench-controller.js`；
- Runtime/Projection 的 SQLite schema、Codex transport 或 ToolBox 执行语义。

## 已建立的接口

- `fork/agentMessageRenderer.js`：从主聊天 `modules/messageRenderer.js` 逐字符建立的 3770 行完整展示基线；来源、哈希和机械差异记录在 `fork/FORK_RECEIPT.md`。
- `fork/agentRenderContext.js`：把 Session、participant、settings 和 Projection messages 显式注入 Fork；历史写入默认拒绝。
- `fork/migration-ledger.json`：记录必须保留的展示能力与必须递减到零的主聊天依赖。
- `contract.js`：严格要求稳定 message/tool/block identity，不生成本地伪 ID；提供 Agent 动作能力描述。
- `content-renderer-fork.js`：Agent 专用的主聊天展示 fork；复用相同 marked 配置与 `contentProcessor`，覆盖 Markdown、KaTeX、代码高亮/复制、Mermaid、推理折叠和安全链接，不引入 history refs 或 streamManager。
- `context-menu.js`：复用主聊天 `.context-menu`/`.context-menu-item` 视觉，动作全部由 Agent adapter 注入。
- `renderer.js`：输出与现有 `reconcileAgentTimeline()` 匹配的 `create/patch` callbacks；通过依赖注入使用主聊天 `createMessageSkeleton` 和 fork 内容管线。
- `stream-batcher.js`：按 animation frame 合并同一稳定 key 的增量，避免每个 token 重绘。
- `index.js`：正式 Workbench 的唯一接入入口，集中装配 DOM builder、marked、Mermaid、post-render 和 context menu disposer。
- `blocks/registry.js`：Tool、Approval、Observation、Error 与未知 Block 的唯一产品注册表；Workbench 只注入动作。
- `blocks/tool.js`：结构化参数、结果、资源、warning、异步 task、状态与取消；终态详情按需渲染且稳定 patch 根节点。
- `blocks/approval.js`：本地审批身份绑定、倒计时投影和恰好一次动作。
- `blocks/observation.js`：VCPInfo/VCPLog/marker 的只读摘要、展开内容和独立 ToolBox backend approval。
- `blocks/error.js`：错误及未来未知 Block 的 fail-safe 展示。

其中 `content-renderer-fork.js`/`renderer.js` 是早期独立 presentation harness，用于验证 canonical Block、keyed DOM 和 action adapter。完整 `agentMessageRenderer.js` Fork 已成为视觉全量对齐的正式迁移基线；在完整 Fork 完成裁剪和对照测试后，薄 harness 只能保留为 adapter/test utility，不能继续成为另一条产品渲染实现。

Renderer fork 不读取 `currentChatHistoryRef`、`currentSelectedItemRef`、`currentTopicIdRef`、`saveChatHistory` 或主聊天 `streamManager`，也不修改原 `renderer.js`、`messageRenderer.js` 和 `messageContextMenu.js`。编辑、重试、分支、转发和取消必须在接线阶段通过 Agent action adapter 注入。

## 已完成的接线门槛

1. `migration-ledger.json` 的 forbidden dependency ceiling 已全部归零。
2. `createAgentMessagePresentation()` 已成为 Workbench Message row 的默认 `create/patch` 路径；结构化 Tool/Approval/Observation Block 继续走现有 keyed renderer。
3. `VCP_AGENT_PRESENTATION_RENDERER=fork|legacy` 由 Main 读取并经窄 IPC 注入；默认 `fork`，不进入 localStorage。
4. 编辑、重试和分支均通过 action adapter 调用 `thread/fork`；取消调用目标 Turn；任何动作均不直接改 SQLite 历史。
5. 主聊天与 Fork 的 golden fixture 已在隔离 JSDOM 中比较规范化 DOM；附件删除按钮因 Agent durable history 不允许直接变更而明确排除。
6. 原 `renderer.js`、`modules/messageRenderer.js`、主聊天 streamManager 和 `messageContextMenu.js` 保持零修改。
7. 原先位于 `agent-workbench.js` 的 Tool/Approval/Observation DOM 实现已删除；Fork 与 legacy Message 灰度模式共享同一 Block registry。

## 当前验证

```text
npm run test:agent-presentation
npm run test:agent-workbench
npm run test:electron-codex-smoke
$env:VCP_AGENT_PRESENTATION_RENDERER='legacy'; npm run test:electron-codex-smoke
```

Checkpoint 收据（VChat `29c2068a`）：JSDOM Full Fork receipt、forbidden dependency、golden DOM、action adapter、keyed patch 与 Workbench mount 均通过；真实 Electron 以 `fork` 和 `legacy` 两种模式从内部应用启动器挂载 Workbench，并断言 Main/preload 模式值、sidebar/feed/composer DOM 和错误窗口。当前主题仍引用缺失的 `themes_snow_realm_light.jpg`，Electron smoke 仅对这一个精确的既有 shell 资源作基线隔离，其他 request/console/page error 继续 fail-closed。

结构化 Block 迁移收据：`scripts/test-agent-presentation-blocks.mjs` 验证 running→completed 不替换 Tool 根节点、清除终态取消按钮、展开详情读取最新 payload、args/result/resources/warnings/task、审批恰好一次、marker 展开和未知 Block fail-safe。该测试已进入 `test:agent-presentation` 与 `test:codex-stack:real`。

空 Session shell 已在 1440×900、1024×720 的深浅主题下通过实际 Electron 截图检查：sidebar/header/feed/composer 无裁切、重叠或空白，正式 `setTheme` 广播后外壳和 Workbench 主题一致。截图保存在系统临时 QA 目录，不纳入仓库。该证据尚不等于富消息视觉完成：Markdown/KaTeX/Mermaid/工具/长流截图、滚动 trace、两个连续提交 revision 的 smoke 以及真实 Nova/ToolBox 工具流仍未完成。legacy 因此继续保留。
