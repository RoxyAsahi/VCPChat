# 外部代码与机制复用登记表

## 目的

本文件是 Codex Agent 路线的复用真源。施工前必须先确认目标能力是否已有可复用实现，避免再次自行实现 parser、状态机、WebSocket 重连、通知投影和测试框架。

复用不改变三条权威边界：Codex Thread Store 管执行和上下文；VChat SQLite 管持久展示；VCPToolBox 管 VCP 工具、catalog 和后端审批。

## 来源与许可证

| 来源 | 本地路径 | Revision | 许可证 | 用途 |
|---|---|---|---|---|
| vcp-code-2.0 | `C:\VCP\vchat-develop\vcp-code-2.0` | `d7ce532451f2ebdf481c16b5cfff9967b63b6cf7` | Apache-2.0 | VCP marker parser、Bridge 连接机制、UI 状态机、通知投影和测试结构。 |
| Codex release | npm `@openai/codex@0.146.0` + `C:\VCP\vchat-develop\codex` tag `rust-v0.146.0` | `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` | 以仓库许可证为准 | App Server 运行时与固定 stable/experimental schema；本地 `main` 只审计，不复制 Agent Runtime。 |
| VCPToolBox | `C:\VCP\VCPToolBox-upstream-latest` | `324a659f`（不依赖未提交 protocolBridge 改动） | 以仓库许可证为准 | `/v1/chat/completions`、`/v1/human/tool`、VCPLog/VCPInfo 和审批协议权威。 |
| Cherry Studio | `C:\VCP\vchat-develop\cherry-studio` | `e72bde30eb0e13cb50fccf66e2646e562fc09ec7` | AGPL-3.0 | 仅 clean-room 借鉴 Session 投影、Runtime resume 与通用 Message/Block 展示分离；不复制源码。 |
| OpenCode | `C:\VCP\vchat-develop\opencode` | `a45c2b917e657e50881117e8c3f85f4bff06e47d` | MIT | frozen-tail Markdown、diff 归一化，以及 Workspace lazy tree、preview/search、虚拟化和稳定路径模型。 |
| CodexGui | `C:\VCP\vchat-develop\CodexGui` | `9ee551775a8e72c9543e2bad49fc64c88e34fadb` | MIT | changed-path 驱动的 Host 侧只读 Git diff 与 Workspace shell 机制参考；不移植 Avalonia/.NET。 |
| Agmente | `C:\VCP\vchat-develop\Agmente` | `87f224e7d5884d450f4d54cc1d72724416e6d750` | MIT | FileChange 稳定 identity、完整路径优先去重与增量 row reconciliation；不移植 SwiftUI。 |
| CodexMonitor | `C:\VCP\vchat-develop\codex-monitor` | `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5` | MIT | Codex Thread reducer、后台状态、requestUserInput、审批队列与 Thread 列表行为测试。 |
| DeepChat | `C:\VCP\vchat-develop\deepchat` | `b76fab868959e7e86267128ecee4d9678100bda9` | Apache-2.0 | Main Session ownership、pending input、取消、Projection 与故障恢复测试。 |
| Harnss | `C:\VCP\vchat-develop\harnss` | `dc1dfd8a33caa46a1eefcfe9e14697b27ac4c33d` | MIT | streaming buffer、permission queue、context usage、tool formatting 与 patch utility。 |
| openclaw-codex-app-server | `C:\VCP\vchat-develop\openclaw-codex-app-server` | `4a87dce5d620a8fb30842bb1b726390fe442247e` | MIT | App Server server-request、pending input、permission、compact/interrupt 的小型协议 fixture。 |
| assistant-ui | `C:\VCP\vchat-develop\assistant-ui` | `1df2939a70ff6d2141b3949f5b89994d803fa0a5` | MIT | 未来 React island 的 External Store Runtime、Thread/Message/Tool/Attachment primitives；当前仅研究合同。 |
| acp-ui | `C:\VCP\vchat-develop\acp-ui` | `cd9c3cb464a4b321bff652101953a64c07473e31` | MIT | 未来 ACP/多 Runtime profile 的 stdio transport、permission/model/mode UI 参考；当前主线不导入。 |

直接复制 Apache-2.0 代码时必须保留来源说明、许可证和 NOTICE 要求。机制重写也要在文件头或开发记录中注明参考 revision，方便上游差异审计。

本表中的本地路径是审计快照，不是 VChat 构建依赖。VChat 不通过相邻仓库隐式解析运行时代码；正式采用必须把最小文件放入 VChat 自有模块、保留来源收据并锁定测试 fixture。

## 2026-08-01 采用状态

| 阶段 | 已实际采用的机制 | VChat 落点 | 证据 | 仍未采用 |
|---|---|---|---|---|
| GUI-R0 | openclaw/CodexMonitor 的协议边界与 server-request fixture思路 | `protocolCapabilities.js`、App Server transport、capability fixture | `test:codex-app-server-capabilities`、`test:codex-app-server-transport` | 未复制 openclaw client/controller；真实 capability discovery 仍待 live 收据。 |
| GUI-R1 | CodexMonitor reducer 的 identity-first 路由原则；DeepChat 生命周期边界 | `agent-session-state.js`、Projection schema v4/v5、Runtime/IPC/preload | `test:agent-session-state`、`test:codex-projection-store`、`test:agent-workbench` | 不导入 React/Tauri UI；unread、scroll anchor、delete 未完成。 |
| GUI-R2 | DeepChat 的 submission cancellation 与 pending-input 分层原则 | Runtime Manager 的 submission idempotency、`agent_pending_inputs`、follow-up drain | `test:codex-runtime-manager`、`test:codex-projection-store` | 未复制 Tape/Agent loop；附件 queue 因不能持久化 path 而明确拒绝。 |
| GUI-R3 | OpenCode frozen-tail 和 Harnss streaming-buffer 的最小算法合同 | `agent-presentation/markdown-stream*.js`、`streaming-accumulator.js`、Codex Projection Projector | `test:agent-markdown-stream`、`test:agent-presentation`、`test:codex-projection-store` | 不导入 SolidJS/React/SDK；Plan/Compaction/Diff 专用 Block、worker 与 trace 仍待。 |
| GUI-R4 | Harnss permission queue 的 FIFO/exactly-once 状态合同 | `codex-runtime/interactionRegistry.js`、Runtime Manager | `test:codex-interaction-registry`、`test:codex-runtime-manager` | 不导入 React/UI；requestUserInput/permission/MCP 在 toolbox-only 保持 fail-closed；完整 Interaction Center UI 与 live gate 仍待。 |
| GUI-R5 | OpenCode Diff 的只读、有界数据合同、Context/Activity 职责分离与水位入口；Codex compact terminal-event 合同 | `codex-runtime/diffModel.js`、Runtime Manager、Projection Projector、`agent-workbench.js` | `test:codex-diff-model`、`test:codex-runtime-manager`、`test:codex-projection-store`、`test:agent-workbench`、`test:electron-codex-smoke` | Context/Usage 与分组面板 working-tree pass；toolbox-only Changes 因缺 mutation receipt 已隐藏，持久 Session 通知、Plan dock、Diff 导航和 live 收据待完成。 |
| GUI-R6 | 无生产代码端口；仅完成来源审计和目标文件映射 | 本表及 `gui-reuse-implementation-plan.md` | 不适用 | 富消息视觉、性能和真实验收均待实施。 |

以上“采用”表示 clean-room 机制/fixture 对照，不表示把上游仓库加入 VChat 构建、运行时或依赖树。直接复制任何 Apache-2.0 或 MIT 文件前，仍需在目标文件和提交说明补完整来源与许可收据。

## GUI 与 Codex App Server 采用矩阵

| 来源与候选 | 采用方式 | 目标阶段 | VChat 目标 | 改造与边界 |
|---|---|---|---|---|
| OpenCode `packages/session-ui/src/components/markdown-stream.ts` 及测试 | **直接受控端口算法与 fixture** | GUI-R3 | `modules/ui-system/agent-presentation/` 的流式 Markdown stable head/frozen tail | 删除 SolidJS/OpenCode SDK 类型；输入只接规范 Message Block；不能持有 Session、Thread、Tool 或审批状态。 |
| OpenCode `session-diff.ts`、`apply-patch-file.ts` 及测试 | **直接受控端口纯函数** | GUI-R5 | 新建 Agent Diff model/Inspector adapter | Codex `fileChange` 是唯一来源；不得从 Markdown 猜 patch，不得执行 patch。保留 16 项有界 LRU 或更严格上限。 |
| OpenCode `context/file/tree-store.ts`、`file-tree-v2-model.ts` 及测试 | **直接受控端口纯算法与 fixture** | WB-R1/R2 | Main lazy directory store 与 Renderer tree model | 端口 inflight 去重、scope generation、路径归一化、目录优先排序和迭代 flatten；不导入 SolidJS、OpenCode SDK、Session store。 |
| OpenCode `file-tree-v2.tsx`、`session-file-browser-tab.tsx`、`session-file-list-v2.tsx` | **clean-room 机制参考** | WB-R2 | 树/搜索键盘、临时/固定 preview、长列表虚拟化 | 不复制组件或样式；使用 VChat DOM、token、图标和 Renderer 临时状态。 |
| OpenCode `session-review-file-preview-v2.tsx`、`session-review-file-preview-v2-virtualize.ts` | **最小抽取虚拟化阈值与 fixture** | WB-R2/R4 | 长文件和 Diff preview | 预览输入只能来自 Main 已校验 descriptor；不得访问 OpenCode Session 或文件 API。 |
| CodexGui `GitDiffService.cs`、`ShellWorkspaceSidebarView.axaml`、`ShellConversationWorkspaceView.axaml` | **机制参考** | WB-R4 | 对 Codex 权威 changed paths 执行有界只读 Git diff | 不复制 .NET/Avalonia；不扫描或猜测 ToolBox 文件变化，不提供 apply/revert。 |
| Agmente `FileChangesSummaryView.swift`、`ChatRenderDiff.swift`、`FileChangesRows.swift` 及测试 | **行为 fixture 重写** | WB-R3/R4 | 统一路径引用、FileChange 去重和 keyed 增量更新 | 不复制 SwiftUI；identity 必须保留 Session/workspace/path，basename 不得作为唯一 key。 |
| OpenCode `markdown-worker-*` | **条件式抽取** | GUI-R3/R6 | 长消息后台 parse queue | 只有主线程 trace 证明 Markdown parse 阻塞后才引入；worker 只处理文本，不访问 SQLite、Codex transport 或 ToolBox。 |
| CodexMonitor `threadReducer/common.ts`、`threadLifecycleSlice.ts`、`threadItemsSlice.ts`、`useThreadsReducer.test.ts` | **移植纯 reducer 和 fixture** | GUI-R1/R3 | 新建 `reduceAgentSessionUiState` 与 Codex Item upsert/finalize 测试 | 禁止移植 `${Date.now()}-assistant` 等本地伪 ID；全部 identity 必须来自 Codex/Projection。React/Tauri 组件不直接导入。 |
| CodexMonitor `useThreadUserInput*`、`useThreadApprovalEvents*`、`RequestUserInputMessage.tsx`、`ApprovalToasts*.tsx` | **协议归一化与行为 fixture 抽取** | GUI-R4 | Main server-request coordinator + Workbench Interaction Center | UI 仅作视觉参考；每个 JSON-RPC request ID 恰好响应一次，超时/关闭/crash fail-closed。 |
| CodexMonitor `ThreadList*.tsx` | **机制与测试借鉴** | GUI-R1/R6 | keyed Session list、running/unread/pinned 状态和 scroll anchor | 不导入 React；SQLite 查询不启动 Runtime；selected Session 不决定后台状态。 |
| DeepChat `submissionCancellationRegistry.ts`、`pendingInputs.ts`、`pendingInputAdmissionCoordinator.ts`、`pendingInputPump.ts` | **最小端口纯状态与测试** | GUI-R2/R4 | Main Session binding、pending input claim、queue/steer 分离 | 不导入 DeepChat Tape/Agent loop/MCP/工具系统；查询和切换不得启动或取消 Thread。 |
| DeepChat `sessionStateResolver.ts`、`sessionStatusPublisher.ts`、`messageProjectionService.ts`、`toolOutputGuard.ts` | **测试场景与边界抽取** | GUI-R1/R3 | Projection reconcile、状态发布、输出限长 | Codex Thread 仍是上下文权威；Projection Service 仍是 SQLite 唯一 writer。 |
| Harnss `streaming-buffer.ts` 及测试 | **直接受控端口纯函数** | GUI-R3 | Agent stream delta accumulator | 覆盖 cumulative/incremental delta 防重；不得生成消息 ID，不得把 buffer 当持久 transcript。 |
| Harnss `permission-queue.ts` 及测试 | **直接受控端口纯函数** | GUI-R4 | Interaction Center pending/responding/completed 队列 | Codex、VCP local、ToolBox backend 三类 ID/response channel 分离；禁止 blanket auto-approve。 |
| Harnss `context-usage.ts`、`tool-formatting.ts`、`patch-utils.ts`、`session-notifications.ts` | **按需抽取纯函数/fixture** | GUI-R3/R5 | Usage、Tool Card、Diff、Activity Center | ToolBox usage 必须标明估算；通知有界；格式化不能改变工具语义或参数。 |
| openclaw `client.test.ts`、`pending-input.test.ts`、`controller*.test.ts`、`scripts/app-server-*-smoke.mjs` | **优先移植协议 fixture** | GUI-R0/R4/R5 | 固定 Codex server-request、permission、requestUserInput、compact/interrupt gate | 不整体复制大型 client/controller；继续使用现有 AppServerTransport/RuntimeManager。 |
| assistant-ui External Store/Thread primitives | **条件式采用** | GUI-R7（未排期） | 仅当 Workbench 决定隔离为 React island 时评估 | 当前 vanilla JS + Full Fork renderer 不引入 React runtime；只记录合同和测试思路。 |
| acp-ui `transport/stdio.ts`、Session/Permission/Model UI | **机制参考** | 未来 ACP profile | 多 Runtime adapter 与 capability-driven controls | 当前 `toolbox-only + Codex App Server` 不导入 ACP transport、Tauri 或 Vue store。 |

`@pierre/diffs` 只允许在 GUI-R5 release-size probe 后决定是否依赖。当前 npm `1.3.1` unpacked size 约 6.9 MiB，并会带入 Shiki/diff/theme 相关依赖；没有二进制体积、启动时间和重复高亮依赖的 gate 时，不得加入生产依赖。

## 本地参考快照收据

以下仓库已 clone 至 `C:\VCP\vchat-develop`，仅供代码审计、fixture 对照与受控端口；它们均不在 `package.json`、打包输入或运行时路径中：`cherry-studio`、`opencode`、`CodexGui`、`Agmente`、`codex-monitor`、`deepchat`、`harnss`、`openclaw-codex-app-server`、`assistant-ui`、`acp-ui`。每个具体 revision 与许可证见本文件开头的来源表。

若后续需要新的开源来源，必须先补入来源表（路径、commit、许可证、最小目标文件与禁用能力），再 clone；不得以“本机已有目录”作为可直接复制的授权或依赖依据。

## vcp-code-2.0 采用矩阵

| 候选 | 采用方式 | 目标阶段 | 复用价值 | 必须改造 | 明确禁止 |
|---|---|---|---|---|---|
| `src/core/task/vcp/vcp-content.ts` | **直接受控导入或等价端口** | R4.2 | 解析 `VCP_DYNAMIC_FOLD`、`VCPINFO`，分离 display/history/notification，并带完整 fixture。 | 输出改为 `AgentBlock[]`；增加大小上限、嵌套/未闭合 marker、CJK 和恶意 HTML 测试；只净化 VChat projection。 | 删除 `TOOL_REQUEST` 执行路径；marker 不能成为第二条工具通道。 |
| `src/core/task/vcp/__tests__/vcp-content.spec.ts` | **直接移植 fixture** | R4.2 | 已覆盖 fold、info、history pollution 和 marker 变体。 | 转成 VChat Node/Rust fixture，增加 Codex Item identity 和 SQLite snapshot 断言。 | 不只断言字符串非空。 |
| `src/services/novacode/vcp-bridge.ts` 的 endpoint candidate、connect probe、指数退避 | **最小算法抽取并移植到 Rust** | R4.1 | 兼容 `/VCPlog`、`/vcpinfo`、query endpoint，提供 latency/status/reconnect。 | 使用 Rust URL/WebSocket API；加入帧限长、jitter、有界队列、稳定 deviceName、去重、TTL、凭据脱敏。 | 不导入 VS Code service；不复制无上限 WebSocket 读取。 |
| `src/services/novacode/__tests__/vcp-bridge.spec.ts` | **测试场景抽取** | R4.1 | 本地 WebSocketServer 可验证 log/info 多通道、fallback、status 和 reconnect。 | 改成 Rust bridge process fixture；增加 oversized frame、乱序、replay、审批、断线和 shutdown。 | 不把“能连接”当作完整验收。 |
| `webview-ui/.../sessionStateMachine.ts` | **机制与 transition fixture 抽取** | R5.1 | 明确区分 creating/streaming/waiting approval/waiting input/completed/error/stopped。 | 输入改为 Codex Thread/Turn/Item/approval 事件；状态只属于 Renderer projection。 | UI state 不能成为执行真源，不能用选中 Session 推断事件归属。 |
| `VcpInfoNotifications.tsx` + ExtensionState 200 条 ring | **UI 机制抽取** | R4.2、R5.3 | 全局通知、有界日志、未读水位和 Session 切换不丢通知。 | 使用 VChat design token 和 keyed Block；按 VCPInfo 类型分类；无 Thread identity 时保持全局。 | 不保存 API Key，不把原始大 JSON 放入 Renderer/SQLite，不自动写回模型。 |
| `VcpCapsule.tsx` 的 typed status 字段 | **仅复用状态模型** | R4.1、R5.3 | connected、endpoint、latency、reconnect、error、plugins、servers 的结构清晰。 | 改成安静的 Workbench 状态入口；状态由 Rust bridge 报告。 | 不复制悬浮胶囊布局；不从日志字符串推断节点状态。 |
| `packages/agent-runtime/src/communication/ipc.ts` | **概念与测试借鉴** | R1、R3 | request/response/event 分流、timeout、dispose 拒绝 waiter。 | 继续使用现有 AppServerTransport/BridgeTransport，仅补等价缺口。 | 不再引入第二套 IPC 框架。 |
| `packages/agent-runtime` 的启动时冻结配置 | **机制借鉴** | R2、R3 | read-shared/write-isolated，避免运行中全局设置改变旧 Session。 | 冻结到 `agent_sessions.config_snapshot_json`，凭据仍仅由 Main 注入。 | 不复制 VS Code mock、ExtensionHost 或每 Thread 一个 Node 进程。 |
| Storybook、Vitest、Playwright 分层 | **测试结构借鉴** | R5、R6 | Block gallery、状态机单测、Webview/E2E 分层清晰。 | 建立 VChat Message/Block fixture gallery、Electron smoke 和 live gate。 | Snapshot 不能替代行为、身份和真实 ToolBox 断言。 |

## 直接复用任务说明

### R4.1：Bridge 连接内核

实现 Rust `ToolboxObservationClient` 前，先从 `vcp-bridge.ts` 提取以下 fixture：

- URL normalization；
- log/info endpoint candidate 顺序；
- connection latency probe；
- exponential backoff 上限；
- config update 后重连；
- disconnect/dispose 清理。

移植后必须补齐上游没有的安全能力：最大帧、bounded channel、jitter、replay 去重、TTL、稳定 deviceName、approval response 和日志脱敏。

### R4.2：VCP 内容净化

建立 `VcpContentProjection`：

```text
Codex/VCP text
  -> marker parser
     -> display blocks
     -> compact projection summary
     -> global/session notifications
     -> protocol warnings
```

`TOOL_REQUEST` 只产生 `protocol-warning` Block，并从可展示正文净化；绝不执行。正常工具只接受 Codex `item/tool/call -> vcp_invoke`。

2026-08-01 working-tree 实现：`modules/codex-runtime/vcpContentProjection.js` 已以 clean-room 方式端口该显示/历史分离合同；`CodexProjectionProjector` 将其写为主 message Block + 有稳定 ordinal 的 observation Block，Workbench 只把后者投影到活动中心。`test:vcp-content-projection` 和 `test:codex-projection-store` 覆盖 CJK、HTML 文字、未闭合 marker 与 `TOOL_REQUEST` 的零执行正文净化。嵌套 marker、真实 ToolBox 消息与 Electron 视觉 gate 仍待，故不可标记 verified。

### R5.1：Session UI 状态机

建立纯函数 `reduceAgentSessionUiState(state, event)`，至少覆盖：

- idle/creating/streaming；
- waiting-native-approval；
- waiting-vcp-approval；
- waiting-user-input；
- completed/interrupted/error/orphaned。

每个状态必须有 transition fixture，取消 A、审批 B、切换 Session C 不得互相污染。

### R5.3：通知与观察中心

借鉴 200 条 ring 和未读水位，但采用两级边界：

- Main/Rust bridge：有界、去重、脱敏的结构化 observation；
- Renderer：最近 N 条临时 projection 和未读游标。

只有明确属于 Thread 的 observation 才显示 Session 标签；默认不进入 `agent_messages`，需要持久展示时写独立 observation Block，并设置大小上限。

## 不能复用的路径

以下内容即使已有实现也不得导入：

- `TOOL_REQUEST` marker 转真实 Cline tool use；
- 模糊工具名候选和自动重写；
- `/vcp-distributed-server` 注册 VChat/Codex 为 capability node；
- 把 `uiMessages + apiConversationHistory` 注入 Codex 伪造 resume；
- blanket auto-approve；
- Webview 持有 ToolBox key；
- Cline `Task.ts` Agent loop、VS Code mock、MCP、Shell 和 checkpoint 系统；
- `VcpCapsule` 原视觉布局和运行时 CPU/内存装饰信息。

## 复用验收要求

每个复用项完成时在 PR/提交说明中记录：

1. 来源文件和 revision；
2. 采用方式：直接导入、端口、算法抽取或 fixture 抽取；
3. 与上游的行为差异；
4. 删除或禁用的危险能力；
5. 新增测试命令；
6. License/NOTICE 处理；
7. 未复用时的技术理由。

没有这份记录，不得把对应 R 项标为完成。
