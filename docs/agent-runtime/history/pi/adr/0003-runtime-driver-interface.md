# ADR-0003: AgentRuntimeDriver 接口抽象

- Status: Accepted
- Date: 2026-07-25

## Context

路线图要求支持三类 agent 基座：Pi（Phase 1-2 首选）、Grok Build（Phase 4，ACP 外部进程）、Claude Agent SDK（Phase 4，Claude 专属）。三者生命周期、事件方言、能力集差异大。若 Main 直接编码 Pi 语义，后续接入即重写 Manager 与 Workbench。

## Decision

定义 `AgentRuntimeDriver` 接口作为 Main 对一切 agent loop 的唯一抽象（完整定义见 [../driver-api.md](../driver-api.md)）：

- stable 方法：`probe / startSession / resumeSession / sendTurn / cancelTurn / respondToApproval / closeSession / dispose`。
- 可选方法（provisional）：`fork / compact / rewind`，未实现保持 `undefined`，以能力位暴露。
- 能力协商：`probe()` 返回能力位，session 创建时固化，UI 与 Manager 按位裁剪。
- 错误统一为 `DriverError` 分类表；事件经 sink 回调以无信封原始形态流出，由 EventNormalizer 包装（ADR-0002）。
- driver 禁止 import Electron（静态 lint），保持可单测、可换宿主。

## Alternatives

1. **直接集成 Pi，抽象后补**：第二个 driver 接入时的抽象必然带 Pi 偏见，且 Phase 2 的 UI/审批代码已固化 Pi 假设——拒绝。
2. **采用 ACP 作为唯一内部接口**：ACP 语义（原生 diff/终端等）超出我们信封范围，且 Pi 不说 ACP，仍需适配层；把外部协议当内部骨架会引入不必要的 impedance——拒绝（ACP 只在 Grok driver 内部使用）。
3. **每个 driver 一套 Manager 分支**：分支组合爆炸，横切治理（审批、脱敏）重复实现——拒绝。

## Consequences

- 正面：新 driver 接入成本=实现接口+过合规套件（ART-022）；Manager/Workbench 无 driver 分支；可选能力以能力位优雅降级。
- 负面：接口是三者最小公倍数，driver 特有能力只能进 `payload.vendor` 扩展区（provisional），表达力受限——刻意为之，防止 UI 依赖私有语义。
- 合规测试套件成为接口的 executable specification。

## Compatibility impact

对既有代码零影响（新模块）。接口 stable 方法变更属破坏式，须 ADR（触发条件见 [../contributing.md](../contributing.md#adr-触发条件)）。

## Security impact

接口强制把"工具出口"收敛到桥（driver 无本地能力 API）；`respondToApproval` 的存在使未来原生审批 runtime 也必须把决议路由回 ApprovalBroker，不允许 driver 侧自动放行（AR-SEC-007 延伸）。

## Migration-rollback

回滚=下线对应 driver（driver 维度独立开关）。接口本身回滚意味着删除 `modules/agent-runtime/drivers/`，Phase 1 前无成本，之后按 roadmap 阶段门禁控制。

## Related requirements and tests

AR-FR-009, AR-FR-010, AR-NFR-006, AR-COMPAT-004；ART-022, ART-025。
