# Agent Runtime 架构（Pi 阶段历史设计）

> 2026-07-29 状态：本文主体描述 Pi Worker 方案，保留它是为了追溯早期契约与安全取舍；它**不是**当前 VCPChat GUI 的执行架构。当前 GUI 通过 Electron thin supervisor 启动仓库内 `rust/` 编译的 `vcp-agentd.exe --direct`，由 Rust Host/Core 承担 Agent loop、Topic、模型流、工具与审批等待。正式职责边界、单一真源和收敛禁令以 [Rust daemon 与 Agent GUI 收敛决策](gui-daemon-integration.md) 为准；再阅读 [GUI 当前开发状态](../gui-current-development-status.md) 和 [Agent GUI 集成当前状态](current-development-status.md)。

本文定义 Agent Runtime 的进程边界、分层依赖、关键序列、并发模型、错误边界与可观测性。决策依据见 [adr/0001-runtime-process-boundary.md](adr/0001-runtime-process-boundary.md) 与 [adr/0006-session-source-of-truth.md](adr/0006-session-source-of-truth.md)。

## 1. 进程边界

```
┌─────────────────────────────────────────────────────────────────────┐
│ VCPChat (Electron)                                                  │
│                                                                     │
│  Renderer (Agent Workbench, internal app, VCPUI)                    │
│    │  窄 preload IPC（contextIsolation，仅 agent-runtime: 通道）      │
│    ▼                                                                │
│  Electron Main                                                      │
│    modules/agent-runtime/                                           │
│      AgentRuntimeManager   — session 注册表、turn 调度、生命周期      │
│      ApprovalBroker        — 本地显式审批（第一层）                   │
│      EventNormalizer       — driver 原始事件 → 统一信封              │
│    modules/ipc/agentRuntimeHandlers.js — agent-runtime:* IPC        │
│    │  fork (ELECTRON_RUN_AS_NODE=1)，stdio JSON-lines 消息           │
│    ▼                                                                │
│  Pi Worker（每个 worker 可承载多 session，Phase 2 默认单 worker）     │
│    agent-runtime/ 入口 + vcp-pi-core（Pi 0.82.1 的最小 MIT fork）     │
│      AgentHarness / agent loop                                       │
│      结构化工具请求 → Electron Main VCP adapter                      │
└─────┼───────────────────────────────────────────────────────────────┘
      ▼
  VCPToolBox（后端，独立进程/主机）
    POST /v1/chatvcp/completions（vcp_delegate，ToolBox 内部工具循环）
    POST /v1/human/tool（vcp_invoke，marker 文本编码工具调用）
    POST /v1/interrupt
    VCPLog WebSocket（后端审批往返，第二层审批）
```

信任边界与数据流方向详见 [security-threat-model.md](security-threat-model.md#信任边界)。Worker 内 `vcp-pi-core` 只保留 Agent loop、流事件、取消、steering/follow-up 队列和工具钩子；Pi 的**全部**内置工具（read/write/edit/bash）、extension、CLI、TUI、provider/credential registry 与 session JSONL 都不纳入 fork。真实文件、终端及插件调用统一由 Electron Main 转发到 VCPToolBox。Main 不再维护第二套文件或终端执行器（AR-SEC-008）。上游来源与同步规则见 `agent-runtime/vcp-pi-core/UPSTREAM.md`。

## 2. 分层依赖

依赖方向严格单向，禁止反向引用与跨层跳跃：

```
renderer (agent-workbench)
   → preload (agent-runtime:* 窄封装)
   → main: modules/ipc/agentRuntimeHandlers.js
   → main: modules/agent-runtime/ (Manager / ApprovalBroker / VCP adapter)
   → main: modules/agent-runtime/drivers/* (AgentRuntimeDriver facade)
   → worker: agent-runtime/ (Pi adapter + agent loop)
   → VCPToolBox (HTTP / WebSocket)
```

- Renderer **不得**直接 import 任何 `modules/agent-runtime/*` 或 `agent-runtime/*`；只能经 preload。
- Driver facade **不得**感知 Electron `ipcMain`/`BrowserWindow`；Manager 负责把事件投递到窗口。
- Worker **不得**直接弹窗、读写用户文件或执行 shell；这些诉求只能转化为 `vcp_invoke`/patch 工具请求，由 Main 调用既有 VCPToolBox 插件。
- 目录边界与 checklist 见 [contributing.md](contributing.md)。

## 3. 关键序列

### 3.1 建立 session

1. Workbench → `agent-runtime:create-session`（`{agentConfigId, workspaceRoot, clientRequestId}`）。
2. Main `AgentRuntimeManager` 校验 `workspaceRoot`（规范化 + 逃逸防护，AR-SEC-006），创建 `AgentSession`（状态 `created`，见 [data-model.md](data-model.md)）。
3. Manager 调用 `driver.startSession()`；Worker 侧初始化 AgentHarness，禁用内置工具与 extension，只注入 `vcp_invoke`、兼容回退 `vcp_delegate`、Patch workflow 和编排工具。
4. Worker 返回能力协商结果（`capabilities`，见 [driver-api.md](driver-api.md#能力协商)）；Manager 落 `AgentSession.capabilities`，状态转 `ready`。
5. Main 广播 `agent-runtime:session.created` 事件；IPC 返回 `{sessionId, capabilities}`。

幂等：相同 `clientRequestId` 重复提交返回同一 `sessionId`，不重复创建（AR-FR-001）。

### 3.2 流式 turn

1. Workbench → `agent-runtime:start-turn`（`{sessionId, input, clientRequestId}`）。
2. Manager 校验 session 状态为 `ready`/`active` 且当前无 `running` turn（每 session 串行，AR-FR-002）；入队创建 `AgentTurn`（`queued`），发出 `turn.queued`。
3. 轮到执行时状态转 `running`，`turn.started`，generation 递增（见 §4）。
4. Worker 流式产出 → EventNormalizer 包装为统一信封（sequence 递增）→ `agent-runtime:event` 推送到 Workbench：`assistant.delta` / `reasoning.delta` / `tool.*` / `context.*`。
5. 结束：`turn.completed`（或 `failed`/`cancelled`），turn 终态，session 回到 `ready`。

### 3.3 工具调用与双层审批

1. Worker agent loop 决定调用工具 `X`（参数 `args`）→ 计算 `argsHash`（canonical JSON 的 SHA-256，见 [tool-bridge.md](tool-bridge.md#参数-hash)）→ 上报 `tool.requested`。
2. Manager `ApprovalBroker` 按 capability 策略判定（AR-SEC-001/002）：
   - 无需本地审批（策略为 auto 且非高危 capability）→ 直接进入后端层；
   - 否则弹审批 UI（`approval.requested`）。默认拒绝、超时（默认 120s）拒绝、无可用窗口拒绝；无 always-allow（AR-SEC-004）。
3. 本地批准后，Main 的 VCP adapter 发起 `vcp_invoke`/`vcp_delegate`；**ToolBox 后端审批（VCPLog WebSocket 往返）照常执行，不被本地批准跳过**（AR-SEC-007）。文件读写复用分布式 `FileOperator`，终端复用分布式 `PowerShellExecutor`。
4. 后端审批拒绝/超时 → `tool.failed`（reason=`backend-denied`）；通过 → 执行 → 结果归一化为 `tool.result`。
5. 审批决议事件 `approval.resolved` 携带 `decidedBy: "user" | "timeout" | "policy" | "backend"`。

### 3.4 中断 / 超时 / Worker 崩溃

- **用户中断**：`agent-runtime:cancel-turn` → turn 转 `cancelling` → Worker 中止 agent loop → 桥向 ToolBox 发 `POST /v1/interrupt`（best-effort，旧接口无 correlation，见 [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md)）→ `turn.cancelled`。
- **超时**：turn 级超时（默认 300s，上限 1800s）等价于系统侧中断，`turn.failed`（code=`TIMEOUT`）。
- **Worker 崩溃**：Main 监听 `exit`/`error` 与健康心跳（5s 间隔，3 次未应答判死）。崩溃时：该 worker 承载的全部 session 转 `failed`，广播 `agent-runtime:runtime.worker-exit`（含 `exitCode`/`signal`），释放资源；**不做自动复活 turn**（AR-FR-008）。

### 3.5 退出清理

应用退出时 Manager 对所有 session 执行 `driver.closeSession()`（5s 宽限）→ `driver.dispose()` → `worker.kill('SIGTERM')`，2s 后 `SIGKILL`。验收：退出后系统无孤儿 Worker 进程（ART-012，Windows 上核对 `tasklist` 无残留 `VCPChat.exe --agent-runtime-worker` 进程）。

## 4. 并发模型

- **每 session 串行 turn**：同一 `sessionId` 任意时刻至多一个 `running` turn；后续 turn 排队。Phase 2 不做并行 turn（AR-FR-002，ART-002）。
- **事件 sequence**：每个 session 内事件 `sequence` 为从 1 开始的单调递增 uint64，由 Manager 统一分配（Worker 不分配）。Renderer 检测 gap 并按 [event-protocol.md](event-protocol.md#顺序与去重) 处理。
- **generation 防复活**：每个 turn 开始使 session 的 `generation` 递增；所有异步回调（工具结果、审批决议、流式 delta）携带 generation；Manager 丢弃 generation 不等于当前值的一切回调（AR-FR-014，ART-020/021）。这防止已取消 turn 的旧回调在新 turn 中"复活"。
- **并行工具调用**：Pi 一个 turn 内可产生多个 tool call。Phase 2 桥按 `toolCallId` 顺序**串行执行**、按序回填结果（ART-014）；并行执行是 Phase 5 目标，需配套 capability 冲突检测。

## 5. 错误边界

| 边界 | 故障 | 行为 |
| --- | --- | --- |
| Renderer ↔ Main | IPC 参数非法 | 返回结构化错误 `{code, message}`，不产生事件 |
| Main ↔ Worker | 消息反序列化失败 | 记 `runtime.warning`，丢弃该消息；连续 10 次判 worker 异常并重启 worker（session 转 `failed`） |
| Worker ↔ ToolBox | HTTP 失败/超时 | `tool.failed`（code 见 [driver-api.md](driver-api.md#错误分类)），agent loop 收到工具错误而非崩溃 |
| ToolBox 审批 WS | 断连 | 在途后端审批按超时拒绝处理；`runtime.warning`（`ws-disconnected`） |
| Driver | `DriverError` | 按错误分类映射为 `turn.failed` / `session.error`，不向上抛未捕获异常 |

任何边界禁止"静默吞错"：要么产生事件，要么产生结构化日志（AR-NFR-005）。

## 6. 可观测性

- 结构化日志（JSON lines），字段：`ts, level, component, sessionId?, turnId?, toolCallId?, msg`。
- **凭据脱敏**：token、Authorization、cookie、agentConfig 中的密钥字段在日志与事件 payload 中一律替换为 `***`（AR-SEC-005，ART-015）。日志隐私规范见 [contributing.md](contributing.md#日志隐私规范)。
- 计数器（内存，供诊断面板）：sessions active、turns running/queued、approvals pending、events dropped（buffer overflow）、worker restarts。
- 事件缓冲：每 session 有界 ring buffer（默认 1000 条，见 [data-model.md](data-model.md#phase-2-内存缓冲)），溢出丢弃最旧并发出一次 `runtime.warning`（`buffer-overflow`）（AR-NFR-002，ART-018）。

## 7. 收缩后的领域核心

RuntimeManager 已接入 Catalog、CapabilityPolicy、Patch workflow 与 SubagentCoordinator。唯一执行后端是 VCPToolBox；本地对象只保留状态、审批和编排职责。

### 7.1 Local Tool Catalog

`modules/agent-runtime/catalog/localToolCatalog.js` 扫描一个或多个可配置 ToolBox 根目录的 `Plugin/**/plugin-manifest.json` 与 `.block`。同目录两者并存时 enabled manifest 生效并产生诊断；仅 `.block` 时仍收录工具但 `enabled=false`。Catalog 只投影 tool id、来源、显示文本、输入 schema 状态、reliability、risk 与原始 manifest SHA-256，不投影 `configSchema` 默认值、环境变量或其他配置值。缺少声明的 VCP legacy 工具明确标为 `unknown`，不得推断成低风险。

Catalog snapshot 可由注入的 `{load, save}` cache adapter 保存；`refresh()` 比较 tool 指纹并返回 added/removed/changed drift。RuntimeManager 在启动时刷新目录，并把精简后的插件目录注入 Agent system prompt。

### 7.2 Capability 策略

`CapabilityPolicy` 的 rule scope 为 session/tool/action/path/expiry，匹配时 deny 优先；未声明默认拒绝，write/shell/subagent 明确属于默认拒绝动作。snapshot 是稳定可序列化对象并带 SHA-256，可验证篡改。它是客户端约束和审批输入，**不是服务端授权边界**，不能替代 ToolBox scoped token、后端审批或执行端路径校验。

不再维护 VCPChat 自己的 WSL/container/local-risk 执行模式抽象。执行环境属于 VCPToolBox 插件及其部署节点；VCPChat 只记录 `executionBackend: vcp-toolbox`，避免产生第二套未落地的执行体系。

### 7.3 SubagentCoordinator

Coordinator 维护 parent/child session id、depth、concurrency、time/token/cost budget，以及 spawning → running → completed/failed/cancelling/cancelled 状态机。父 session 取消会递归级联到所有后代。外部副作用只通过注入的 `createChild/runChild/cancelChild` adapter；领域层不 spawn CLI、不 import Pi adapter。后续 RuntimeManager 负责将三个 adapter 接到 Pi session/turn 生命周期并把领域事件映射成统一事件信封。

### 7.4 TeamCoordinator

Team 模型包含 Run、Member、Wave、Role、Ownership、Handoff 与 Blackboard。Wave 支持 sequential、parallel、adaptive；parallel/adaptive 受 run concurrency budget 限制。Ownership 对规范化路径做父子重叠检测，不同 member 的重叠 claim 直接失败。Blackboard 只接受结构化 object/array value 和 artifact refs，拒绝裸字符串命令或对话。持久化通过注入的 `saveRun/loadRun` adapter；成员执行/取消同样由 adapter 提供，领域层不启动 runtime。
