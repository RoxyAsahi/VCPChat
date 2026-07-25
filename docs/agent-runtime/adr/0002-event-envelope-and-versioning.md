# ADR-0002: 统一事件信封与版本策略

- Status: Accepted
- Date: 2026-07-25

## Context

Worker（Pi 及未来的 Grok/Claude driver）、Main 各组件、Renderer 之间需要交换 session/turn/流式/工具/审批等十余类信息。若每类信息各定格式，则 renderer 需要理解每个 driver 的事件方言，脱敏、限流、回放、缓冲等横切逻辑无法实现单点治理。

## Decision

所有跨进程信息使用统一信封：`schemaVersion / eventId / sequence / timestamp / sessionId / turnId / messageId / toolCallId / approvalId / runtime / type / payload`（完整定义见 [../event-protocol.md](../event-protocol.md)）。要点：

- `sequence` 由 Main 的 EventNormalizer 统一分配（Worker 不分配），保证 session 内全序。
- 版本策略：新增事件类型与可选字段向后兼容不升版；破坏式变更升 `schemaVersion` 并走 ADR；未知版本事件丢弃+告警不崩溃。
- 事件类型与 IPC 通道共用 `agent-runtime:` 命名空间（ADR-0008）。
- 脱敏与大小限制在 Normalizer 单点执行（唯一出口）。

## Alternatives

1. **直接透传 driver 原生事件**：renderer 耦合各 driver 方言，换 driver 即重写 UI；横切治理无处安放——拒绝。
2. **每域独立协议（如审批一条通道、流式一条通道）**：顺序保证（工具调用与其审批的相对顺序）无法表达——拒绝。
3. **复用 VCP marker 文本作为事件**：marker 无类型系统、无版本、解析有注入面（T-02）——拒绝。

## Consequences

- 正面：单点治理（脱敏/限流/缓冲/回补）；renderer 只实现一套消费逻辑；契约测试可参数化（ART-003/024）。
- 负面：Normalizer 成为单点（以其无状态、纯函数式设计控制风险）；信封字段对轻量事件有固定开销（可接受）。
- 事件持久化（Phase 3 SQLite）直接以信封为存储行格式，无需二次映射。

## Compatibility impact

新协议不影响既有 VCP 聊天与插件通道。对 ToolBox 的旧协议报文**不**套用本信封（legacy-frozen），映射规则见 event-protocol.md §8。

## Security impact

单点脱敏降低凭据泄漏概率（T-07）；`sequence`+`eventId` 支持 gap 检测与去重，抑制重放与乱序注入；审批绑定字段（turnId/toolCallId/approvalId）为信封一等公民，支撑 ADR-0005 的四元组绑定。

## Migration-rollback

`schemaVersion=1` 为起点；回滚即停用事件订阅，无数据迁移。未来升版时旧版本事件只读丢弃，不做双向转换器。

## Related requirements and tests

AR-FR-007, AR-FR-012, AR-NFR-002, AR-NFR-003, AR-SEC-005, AR-COMPAT-006；ART-003, ART-018, ART-019, ART-024。
