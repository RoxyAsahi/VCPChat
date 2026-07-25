# Agent Runtime 数据模型

决策依据：[adr/0006-session-source-of-truth.md](adr/0006-session-source-of-truth.md)。**VCPChat（Main 进程）是 Session 及其子实体的唯一权威**；Pi 的 resume/compaction 状态为 opaque adapter state（RuntimeOpaqueState），客户端不解析其内容。

## 1. 实体

### AgentSession

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string (ULID) | 主键 |
| `agentConfigId` | string | 关联的 agent 配置（capability 来源） |
| `driverId` | enum | `pi` / `grok-build` / `claude-sdk` |
| `state` | enum | 见 §2 状态机 |
| `workspaceRoot` | string | 规范化绝对路径（AR-SEC-006 已校验） |
| `capabilities` | object | driver 能力位（[driver-api.md](driver-api.md#能力协商)） |
| `generation` | uint64 | 防复活代计数，turn 开始递增 |
| `transportMode` | enum | `legacy` / `structured`（Phase 3 探测结果，见 legacy 文档 §4.5） |
| `createdAt` / `updatedAt` | ms epoch | |

### AgentTurn

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `turnId` | string | 主键 |
| `sessionId` | string | 外键 |
| `index` | uint | session 内单调序号 |
| `state` | enum | 见 §2 |
| `input` | string | 用户输入（脱敏后入审计） |
| `startedAt` / `endedAt` | ms epoch | |
| `error` | `{code, message}?` | 终态失败时填写，code 取 driver 错误分类 |

### AgentEvent

即 [event-protocol.md](event-protocol.md) 信封的存储形态；Phase 2 仅存内存缓冲，Phase 3 落库。索引：`(sessionId, sequence)` 唯一，`eventId` 唯一。

### AgentApproval

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `approvalId` | string | 主键 |
| `sessionId` / `turnId` / `toolCallId` | string | 绑定四元组之三 |
| `toolName` / `argsHash` | string | 绑定之四；hash 算法见 [tool-bridge.md](tool-bridge.md#3-参数-hash) |
| `riskClass` | enum | capability 风险分级 |
| `state` | enum | `pending` / `approved` / `denied` / `expired` / `cancelled` |
| `decidedBy` | enum | `user` / `timeout` / `policy` / `backend` |
| `requestedAt` / `resolvedAt` / `timeoutMs` | | |

### AgentArtifact

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `artifactId` | string | 主键 |
| `sessionId` / `turnId` | string | |
| `kind` | enum | `file` / `diff` / `log` |
| `path` | string | workspace 内相对路径（越界拒绝，AR-SEC-006） |
| `size` / `createdAt` | | |

### RuntimeOpaqueState

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sessionId` | string | 外键 |
| `driverId` | enum | 与 session 一致；错配即拒绝加载 |
| `blob` | bytes/string | driver 私有 resume/compaction 状态；**客户端不解析、不修改、不展示** |
| `stateVersion` | string | driver 自定义版本；driver probe 版本不符时拒绝 resume |
| `updatedAt` | ms epoch | |

## 2. 状态机

### AgentSession

```
created ──startSession 成功──▶ ready ──turn 开始──▶ active ──turn 终态──▶ ready
ready/active ──close──▶ closing ──清理完成──▶ closed
任意非终态 ──worker 崩溃/致命错误──▶ failed ──(仅允许)──▶ closing → closed
```

### AgentTurn

```
queued ──调度──▶ running ──成功──▶ completed
running ──失败──▶ failed
queued/running ──取消──▶ cancelling ──确认──▶ cancelled
```

### AgentApproval

```
pending ──用户批准──▶ approved        (终态)
pending ──用户拒绝/后端拒绝──▶ denied  (终态)
pending ──超时──▶ expired              (终态，等价 denied/timeout)
pending ──turn 取消/session 关闭──▶ cancelled (终态)
```

## 3. 合法迁移表（非法迁移必须抛错并记日志）

| 实体 | 合法迁移 |
| --- | --- |
| Session | created→ready；ready→active/closing/failed；active→ready/closing/failed；closing→closed；failed→closing |
| Turn | queued→running/cancelling；running→completed/failed/cancelling；cancelling→cancelled/failed |
| Approval | pending→approved/denied/expired/cancelled（无其他出边；终态不可再变） |

非法迁移示例（必须拒绝）：closed→ready（复活）、approved→pending（重审应新建 approval）、completed→running。

## 4. 并发约束

- 单 session 任意时刻 ≤ 1 个 `running` turn（AR-FR-002）；Manager 以 sessionId 为粒度加互斥（内存锁，非文件锁）。
- `sequence` 分配与事件落缓冲在同一临界区，保证 `(sessionId, sequence)` 严格递增无洞（洞只可能由缓冲溢出丢弃产生，且最旧侧丢弃）。
- Approval 决议为单次 CAS：`pending` → 终态仅允许一次，重复决议返回首次结果（幂等，见 [event-protocol.md](event-protocol.md#4-幂等键)）。
- `generation` 递增与 turn 开始原子完成；所有异步回调读取时刻的 generation 决定其生死（AR-FR-014）。

## 5. Phase 2 内存缓冲

- 每 session 事件 ring buffer：默认 1000 条；溢出丢最旧 + 单次 `runtime.warning`（AR-NFR-002，ART-018）。
- AgentSession/AgentTurn/AgentApproval/AgentArtifact 全量存内存 Map；应用退出即失。
- **Phase 2 不做重启持久恢复**：重启后历史 session 不可恢复，Workbench 展示空列表。这不是缺陷而是本阶段声明的行为（ART-026 验证提示语义）；resume（AR-FR-009）是 Phase 3。

## 6. Phase 3 SQLite 计划（provisional）

- 存储：`userdata/agent-runtime/agent-runtime.db`，WAL 模式。
- 表：`agent_session`、`agent_turn`、`agent_event`（body 为信封 JSON，超 256KB 拒写）、`agent_approval`、`agent_artifact`、`runtime_opaque_state`。
- 迁移：schema 版本号 + 顺序迁移脚本（参考仓库 `migration/` 既有约定）。
- 恢复语义：启动时加载 `closed`/`failed` session 为只读历史；`ready/active` 中遗留的非终态一律迁移为 `failed`（reason=`restart`），不自动续跑；resume 必须用户显式触发且 driver 校验 `stateVersion`。
- 凭据**不入库**（AR-SEC-005）；RuntimeOpaqueState 入库前确认 driver 声明其不含凭据，否则仅存内存。

## 7. 与 VCP 既有数据的关系

Agent Runtime 实体不复用聊天消息的存储路径；Agent Workbench 的展示数据完全来自本模型 + 事件流。与 VCP 聊天历史的桥接（如把 agent 会话导出为聊天）是 Phase 6 候选，届时另立文档。
