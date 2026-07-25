# Agent Runtime 事件协议

统一事件信封与事件类型清单。所有 Agent Runtime 跨进程信息（Worker→Main→Renderer）必须使用本协议。决策依据：[adr/0002-event-envelope-and-versioning.md](adr/0002-event-envelope-and-versioning.md)。关联需求 AR-FR-007、AR-COMPAT-006。

## 1. 事件信封（stable）

```jsonc
{
  "schemaVersion": 1,            // uint，协议主版本；不兼容变更 +1
  "eventId": "01J...",           // string，ULID/UUIDv7，全局唯一，去重键
  "sequence": 42,                // uint64，session 内单调递增，从 1 开始，由 Main 分配
  "timestamp": 1784956800123,    // ms epoch，Main 盖章（Worker 时间不可信）
  "sessionId": "sess_...",       // string，必填
  "turnId": "turn_... | null",   // string|null，session 级事件为 null
  "messageId": "msg_... | null", // string|null，assistant/reasoning 事件填写
  "toolCallId": "tc_... | null", // string|null，tool.*/approval.* 事件填写
  "approvalId": "ap_... | null", // string|null，approval.* 事件填写
  "runtime": "pi",               // enum: "pi" | "grok-build" | "claude-sdk" | "vcpchat"
  "type": "agent-runtime:assistant.delta",
  "payload": { /* 按 type 定义 */ }
}
```

规则：

- `sequence` 只由 Electron Main 的 EventNormalizer 分配；Worker 上报的消息不带 sequence，Main 按到达顺序盖章（见 [architecture.md](architecture.md#4-并发模型)）。
- `runtime` 对 Manager 自身产生的事件（如 `session.created`、`runtime.worker-exit`）填 `"vcpchat"`。
- 关联字段（turnId/toolCallId/approvalId）缺失时必须是 `null`，不得省略键，便于 schema 校验。

## 2. 事件类型清单

命名空间 `agent-runtime:*`（IPC 通道同名前缀，见 [adr/0008-ipc-channel-namespace.md](adr/0008-ipc-channel-namespace.md)）。

### session.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:session.created` | stable | `{session, capabilities}` | session 就绪；`session` 为 AgentSession 摘要 |
| `agent-runtime:session.updated` | provisional | `{session}` | 元数据变更（如 workspaceRoot） |
| `agent-runtime:session.closed` | stable | `{reason: "user"|"dispose"|"error"}` | 终态 |
| `agent-runtime:session.error` | stable | `{code, message, fatal: bool}` | session 级错误；`fatal=true` 时随后必有 closed |

### turn.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:turn.queued` | stable | `{turnId, index, position}` | 入队；`position` 为队列位次 |
| `agent-runtime:turn.started` | stable | `{turnId, index, generation}` | 开始执行 |
| `agent-runtime:turn.completed` | stable | `{turnId, usage?, stopReason}` | 正常结束 |
| `agent-runtime:turn.failed` | stable | `{turnId, code, message}` | `code` 取 [driver-api.md](driver-api.md#错误分类) 错误码 |
| `agent-runtime:turn.cancelled` | stable | `{turnId, reason: "user"|"timeout"|"system"}` | 中断结束 |

### assistant.* / reasoning.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:assistant.delta` | stable | `{messageId, text}` | 增量文本；单条 ≤ 8KB（AR-NFR-003） |
| `agent-runtime:assistant.message` | stable | `{messageId, text, complete: true}` | 聚合终稿；`text` 为全部 delta 拼接 |
| `agent-runtime:reasoning.delta` | provisional | `{messageId, text}` | 思考链增量；Workbench 可折叠展示 |
| `agent-runtime:reasoning.summary` | provisional | `{messageId, text}` | 思考链摘要（若 driver 提供） |

### tool.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:tool.requested` | stable | `{toolCallId, toolName, argsPreview, argsHash, riskClass}` | agent 决定调用；`argsPreview` 为脱敏截断预览（≤ 2KB） |
| `agent-runtime:tool.started` | stable | `{toolCallId, transport: "vcp_invoke"|"vcp_delegate"}` | 已通过本地审批，发往后端 |
| `agent-runtime:tool.result` | stable | `{toolCallId, ok: true, result, truncated, durationMs, audit}` | 结果归一化（≤ 64KB）；`audit` 见 [tool-bridge.md](tool-bridge.md#审计字段) |
| `agent-runtime:tool.failed` | stable | `{toolCallId, ok: false, code, message, durationMs, audit}` | 含后端拒绝（`code="backend-denied"`） |

### approval.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:approval.requested` | stable | `{approvalId, toolCallId, toolName, argsPreview, argsHash, riskClass, timeoutMs}` | 本地审批请求（第一层） |
| `agent-runtime:approval.resolved` | stable | `{approvalId, decision: "approved"|"denied", decidedBy: "user"|"timeout"|"policy"|"backend"}` | 任一层决议；后端决议也经此广播 |
| `agent-runtime:approval.expired` | stable | `{approvalId}` | 超时自动拒绝（等价 resolved/denied/timeout，冗余事件便于 UI） |

### plan.* / context.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:plan.updated` | provisional | `{steps: [{id, title, status}]}` | driver 计划视图全量替换 |
| `agent-runtime:context.usage` | provisional | `{usedTokens, maxTokens, ratio}` | 上下文水位 |
| `agent-runtime:context.compacted` | provisional | `{beforeTokens, afterTokens, strategy}` | 压缩发生；细节存 RuntimeOpaqueState |

### runtime.*

| type | 等级 | payload | 说明 |
| --- | --- | --- | --- |
| `agent-runtime:runtime.warning` | stable | `{code, message}` | 非致命告警：`buffer-overflow`、`ws-disconnected`、`unknown-event`、`sequence-gap` |
| `agent-runtime:runtime.worker-exit` | stable | `{workerId, exitCode, signal, affectedSessionIds}` | Worker 崩溃/退出（AR-FR-008） |
| `agent-runtime:runtime.disposed` | stable | `{workerId}` | driver/worker 正常释放 |

## 3. 顺序与去重

- **顺序**：同一 session 内事件按 `sequence` 全序；跨 session 无顺序保证。Renderer 必须按 `sequence` 而非到达顺序渲染。
- **gap 检测**：收到 `sequence` 跳跃（n → n+k, k>1）时，Renderer 记录 `sequence-gap`，等待最多 500ms 补洞；超时按缺失继续渲染并向 Main 查询（`agent-runtime:get-events`（候选，Phase 3） 从缓冲回补，缓冲见 [data-model.md](data-model.md#phase-2-内存缓冲)）。回补仍缺则渲染缺口占位。
- **去重**：以 `eventId` 为去重键；同 `eventId` 重复到达直接丢弃。缓冲回补与实时推送可能重复，消费方必须幂等。

## 4. 幂等键

- `session:create`、`turn:send`、`approval:respond` 三个 IPC 接受 `clientRequestId`（ULID）。相同 `(通道, clientRequestId)` 重复提交：create 返回原 session；send 返回原 turnId 不重复入队；respond 返回首次决议结果，不二次生效。

## 5. 大小限制（stable，AR-NFR-003）

| 项 | 上限 | 超限行为 |
| --- | --- | --- |
| 单事件序列化整体 | 256 KB | 拒绝产生，`runtime.warning`（`payload-oversize`） |
| `assistant.delta.payload.text` | 8 KB | Worker/Normalizer 切分为多条 |
| `tool.requested.payload.argsPreview` | 2 KB | 截断 + `truncated: true` |
| `tool.result.payload.result` | 64 KB | 截断 + `truncated: true`，完整结果可经工具审计另行导出 |

## 6. 脱敏（stable，AR-SEC-005）

事件 payload 中以下模式一律替换为 `***`：HTTP `Authorization`/`Cookie` 头值、形如 `sk-*`/Bearer token 的字符串、agentConfig 中标记为 secret 的字段值、工具参数中被 manifest 标记 `sensitive: true` 的字段。脱敏发生在 EventNormalizer（唯一出口），Worker 侧也应避免上送（纵深防御）。验证：ART-015。

## 7. 版本与弃用

- `schemaVersion` 主版本升级 = 破坏式变更（删字段、改类型、改语义），必须走 ADR 并在 [roadmap.md](roadmap.md) 排期。
- 新增事件类型、payload 新增可选字段：向后兼容，不升版本，但需在本文件登记。
- 收到未知 `schemaVersion`：丢弃 + `runtime.warning`（`unknown-event-version`），不得崩溃（AR-COMPAT-006，ART-024）。
- 弃用事件类型：标记 `deprecated` 至少一个 Phase，期间双发新旧事件，再删除。

## 8. 传输映射

| 段 | 传输 | 映射 |
| --- | --- | --- |
| Worker → Main | stdio JSON-lines（`ELECTRON_RUN_AS_NODE=1` 子进程） | 一行一条**无信封**的原始事件 `{kind, ...}`；Main 的 EventNormalizer 包装为信封 |
| Main → Renderer | Electron IPC `agent-runtime:event`（stream 型通道） | 完整信封，`webContents.send` |
| Main → ToolBox | HTTP + VCPLog WebSocket | 仅工具桥与审批报文，**不**使用本信封（旧协议，legacy-frozen） |
| Phase 3+ 外部订阅 | SSE / WS（提案，见 [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md#phase-3-后端结构化-api-契约提案)） | 完整信封，`text/event-stream` 每 event 一条 |

Renderer 订阅以窗口为单位：Workbench 创建时调用 `onAgentRuntimeEvent` 订阅（Phase 2 为主窗口级广播，session 级订阅见 roadmap Phase 3），窗口销毁自动退订；无订阅窗口的 session 事件只入缓冲不推送（这也是"无窗口拒绝审批"的前提，AR-SEC-002）。
