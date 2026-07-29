# ADR-0006: VCPChat 为 Session 唯一权威

- Status: Accepted
- Date: 2026-07-25

## Context

Agent session 涉及三方状态：VCPChat（用户可见的会话、turn、审批、产物）、driver（Pi 的对话历史、compaction/resume 状态）、ToolBox（工具执行与后端审批记录）。必须明确谁是权威，否则重启恢复、UI 展示、审计会三方打架。

## Decision

**VCPChat（Main 进程）是 Session 及其子实体（AgentSession/AgentTurn/AgentEvent/AgentApproval/AgentArtifact）的唯一权威**（模型见 [../data-model.md](../data-model.md)）。driver 侧状态（Pi 的 resume/compaction 等）以 `RuntimeOpaqueState` 形式托管存储：客户端**不解析、不修改、不展示**其内容，只在 resume 时原样交还 driver，并由 driver 校验 `stateVersion`。ToolBox 记录是执行侧证据，经 audit 字段引用，不回写客户端模型。

## Alternatives

1. **以 driver 为权威（session=Pi 内部会话）**：换 driver 即丢历史；审批/产物等本地概念无处安放；UI 受制于 SDK 存储格式——拒绝。
2. **以 ToolBox 为权威**：后端不含 turn/审批 UI 语义；离线/多后端场景不成立——拒绝。
3. **双向同步**：共识问题无解成本，崩溃窗口必然分叉——拒绝。

## Consequences

- 正面：重启恢复语义简单（非终态一律 failed(reason=restart)，resume 显式触发）；审计单点可查；driver 可替换不丢历史。
- 负面：opaque state 与本地模型可能脱节（如 driver 侧 compaction 后上下文与本地事件流不再逐条对应）——接受，以 `context.compacted` 事件标记水位，不做逐条对账。
- Phase 2 权威=内存；Phase 3 权威=SQLite，迁移计划见 data-model.md §6。

## Compatibility impact

与既有 VCP 聊天存储完全分离，互不影响。RuntimeOpaqueState 入库前需 driver 声明不含凭据（AR-SEC-005 延伸）。

## Security impact

权威在本地使审批记录、capability 声明、workspace 绑定不可被 driver/后端单方面改写；opaque state 不参与安全决策（防 driver 状态被篡改后影响授权）。

## Migration-rollback

Phase 2 无持久化，回滚零成本。Phase 3 SQLite 以 schema 版本+顺序迁移演进，down 脚本必备（roadmap Phase 3 回滚策略）。

## Related requirements and tests

AR-FR-001, AR-FR-009, AR-SEC-005；ART-001, ART-026。
