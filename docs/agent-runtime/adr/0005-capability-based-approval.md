# ADR-0005: Capability 权限模型与双层审批（无 always-allow）

- Status: Accepted
- Date: 2026-07-25

## Context

Agent 经 ToolBox 可获得文件写、网络、命令执行等真实副作用能力。Windows 无内核沙箱（ADR-0001），模型输出不可信（TB4），因此审批与授权是主防线。需要回答：谁批、批什么、批多久、能否豁免。

## Decision

1. **Capability 模型**：权限按 agentConfig 声明为 capability 集（工具枚举 + 路径 scope + 风险分级），session 创建时固化，worker 工具集按此裁剪——未声明即禁止。运行中不可热提升。
2. **双层审批**：第一层 VCPChat ApprovalBroker（本地显式审批 UI），第二层 ToolBox 后端审批（VCPLog WS 往返）。本地批准**不跳过**后端审批；桥不伪造、不预答后端结果。
3. **审批绑定**：决议绑定 `sessionId + turnId + toolCallId + argsHash`；执行前 Main 复核 argsHash，不匹配则决议作废重审（TOCTOU 防护）。
4. **失败默认**：默认拒绝、超时拒绝（120s）、无可用审批窗口拒绝。
5. **无 always-allow**：不实现任何粒度的"记住选择/始终允许"持久豁免。低危（fs.read 级）可走策略 `auto`，但那是 capability 声明的一部分，不是用户绕过审批的快捷方式。

## Alternatives

1. **always-allow / 会话内记住**：长期使用中必然演变成事实上的全放行（审批疲劳），且被 prompt injection 一次诱导即永久失守——拒绝。便利性用"低危 capability = auto"解决。
2. **仅后端审批**：本地无法做到逐参数预览与 capability 裁剪；delegate 之外的模式下浪费本地上下文——拒绝。
3. **仅本地审批**：后端是副作用实际发生点，绕过它等于把 ToolBox 当哑管道，与其既有审批体系冲突——拒绝。
4. **基于角色的全局白名单**：同 always-allow 问题，且跨 session 泄漏授权——拒绝。

## Consequences

- 正面：审批内容=执行内容（四元组+hash）；两层独立失效域；权限边界可读可审计（capability 声明即文档）。
- 负面：高危工具每次调用都需用户介入（刻意成本）；审批 UI 质量直接决定安全性（描述按不可信文本渲染，T-10）；无窗口场景的拒绝语义需用户教育。
- `AgentApproval` 实体与状态机见 [../data-model.md](../data-model.md)。

## Compatibility impact

ToolBox 后端审批协议不变（legacy-frozen，AR-COMPAT-002）。capability 配置是新格式，与既有 agent 配置并存，不迁移旧数据。

## Security impact

本 ADR 是 T-01/T-06/T-09/T-10 的主缓解。已知残余：后端审批与调用的 correlation 在旧接口下是启发式（D3，UI 如实标注）；delegate 模式本地无逐调用审批（上限中危+显式标注）。

## Migration-rollback

回滚：审批层故障的兜底方向是"默认拒绝"，不存在"降级为放行"的开关。前向：Phase 3+ scoped token 落地后，capability 声明映射为 token 的 `allowedTools/allowedPaths`，模型不变、执行点增强。

## Related requirements and tests

AR-SEC-001, AR-SEC-002, AR-SEC-003, AR-SEC-004, AR-SEC-007, AR-SEC-010, AR-FR-006；ART-006, ART-007, ART-008, ART-009, ART-023, ART-028。
