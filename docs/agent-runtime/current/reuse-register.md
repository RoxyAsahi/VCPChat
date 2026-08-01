# 外部代码与机制复用登记表

## 目的

本文件是 Codex Agent 路线的复用真源。施工前必须先确认目标能力是否已有可复用实现，避免再次自行实现 parser、状态机、WebSocket 重连、通知投影和测试框架。

复用不改变三条权威边界：Codex Thread Store 管执行和上下文；VChat SQLite 管持久展示；VCPToolBox 管 VCP 工具、catalog 和后端审批。

## 来源与许可证

| 来源 | 本地路径 | Revision | 许可证 | 用途 |
|---|---|---|---|---|
| vcp-code-2.0 | `C:\VCP\vchat-develop\vcp-code-2.0` | `d7ce532451f2ebdf481c16b5cfff9967b63b6cf7` | Apache-2.0 | VCP marker parser、Bridge 连接机制、UI 状态机、通知投影和测试结构。 |
| Codex | `C:\VCP\vchat-develop\codex` | `f0c30e528a54bdf0fa9a4d52ff74b34383434811` | 以仓库许可证为准 | App Server 协议和真实 schema；不复制 Agent Runtime。 |
| VCPToolBox | `C:\VCP\VCPToolBox-upstream-latest` | `324a659f`（不依赖未提交 protocolBridge 改动） | 以仓库许可证为准 | `/v1/chat/completions`、`/v1/human/tool`、VCPLog/VCPInfo 和审批协议权威。 |

直接复制 Apache-2.0 代码时必须保留来源说明、许可证和 NOTICE 要求。机制重写也要在文件头或开发记录中注明参考 revision，方便上游差异审计。

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
