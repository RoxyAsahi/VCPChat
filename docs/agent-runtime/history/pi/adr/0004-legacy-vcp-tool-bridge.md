# ADR-0004: Phase 2 使用旧 VCP 接口实连工具桥

- Status: Accepted
- Date: 2026-07-25

## Context

Agent 的工具执行能力由 VCPToolBox 提供。现成可用的只有旧接口：`POST /v1/human/tool`（vcp_invoke，marker 文本编码）、`POST /v1/chatvcp/completions`（vcp_delegate，ToolBox 内部工具循环）、`/v1/interrupt`、VCPLog WebSocket 审批。目标架构需要的结构化 API（Tool Catalog/JSON Schema、JSON invoke、scoped token、correlated 事件流）在 ToolBox 侧尚不存在，且本轮明确**不修改 VCPToolBox**。

## Decision

Phase 2 工具桥基于旧接口实连，同时：

1. 桥的全部语义（编码纪律、argsHash、取消/超时映射、结果归一化、审计字段）固化为客户端契约（[../tool-bridge.md](../tool-bridge.md)），与传输解耦，Phase 3 换结构化 API 时上层不变。
2. 旧接口缺陷（无 scoped token、无稳定 Catalog/JSON Schema、无 correlation ID 等 D1-D6）逐条登记，客户端补偿逐条强制（[../legacy-toolbox-compatibility.md](../legacy-toolbox-compatibility.md)），补偿未落地不得发布。
3. 把结构化 API 写成 Phase 3+ 正式后端契约提案，客户端以 capability 探测选择路径，可回退。
4. 明确立场：**接通 ≠ 达到目标安全架构**；发布说明与 UI 文案不得暗示已具备 scoped token 级隔离。

## Alternatives

1. **等 ToolBox 结构化 API 就绪再实连**：Phase 2 无限期阻塞，且契约没有真实客户端验证会反复返工——拒绝。
2. **本轮顺带改 ToolBox**：超出授权范围，且双端同改使回滚单元变大——拒绝。
3. **绕过 ToolBox 在 worker 本地实现工具**：摧毁"工具唯一出口"安全支柱（TB3），凭据与能力分散——坚决拒绝（AR-SEC-008）。

## Consequences

- 正面：Phase 2 可交付真实可用的 agent 工具链；契约提案有实连经验背书；上层（审批/事件/UI）面向稳定桥语义开发。
- 负面：补偿逻辑（启发式 correlation、marker 硬拒绝、本地超时/限流）是必须维护的过渡代码；delegate 模式本地无逐调用审批，需 UI 显式声明；`lateResult` 等边角语义增加测试面。
- 过渡代码集中在一处（桥 + legacy 文档 §3），Phase 3 后可整段退役。

## Compatibility impact

只消费既有接口，对 ToolBox 零变更要求（AR-COMPAT-001/002）。marker 编码遵循 [VCP.md](../../../VCP.md) 唯一真源，不扩展语法。

## Security impact

旧接口弱化了 D1/D3/D5 三类保证；补偿把这些风险压到可接受但不消除（见威胁 T-02/T-05/T-06/T-08）。这是本 ADR 显式接受的残余风险，消除依赖 Phase 3 契约落地。

## Migration-rollback

回滚=session 级关闭工具桥（退回 Phase 1 无工具模式）。前向迁移=探测到结构化 API 后切换 `transportMode`，legacy 路径保留至少一个 Phase。

## Related requirements and tests

AR-FR-004, AR-FR-005, AR-FR-013, AR-FR-014, AR-COMPAT-001, AR-COMPAT-002；ART-004, ART-005, ART-010, ART-014, ART-016, ART-020, ART-023。
