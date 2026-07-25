# Agent Runtime ADR 索引

架构决策记录（Architecture Decision Records）。新增 ADR 编号顺延四位数字；触发条件见 [../contributing.md](../contributing.md#adr-触发条件)。

统一结构：Title / Status / Date / Context / Decision / Alternatives / Consequences / Compatibility impact / Security impact / Migration-rollback / Related requirements and tests。

Status 取值：`Proposed` / `Accepted` / `Deprecated` / `Superseded by ADR-xxxx`。

| ADR | Title | Status | Date |
| --- | --- | --- | --- |
| [0001](0001-runtime-process-boundary.md) | Runtime 进程边界：独立 Worker + ELECTRON_RUN_AS_NODE | Accepted | 2026-07-25 |
| [0002](0002-event-envelope-and-versioning.md) | 统一事件信封与版本策略 | Accepted | 2026-07-25 |
| [0003](0003-runtime-driver-interface.md) | AgentRuntimeDriver 接口抽象 | Accepted | 2026-07-25 |
| [0004](0004-legacy-vcp-tool-bridge.md) | Phase 2 使用旧 VCP 接口实连工具桥 | Accepted | 2026-07-25 |
| [0005](0005-capability-based-approval.md) | Capability 权限模型与双层审批（无 always-allow） | Accepted | 2026-07-25 |
| [0006](0006-session-source-of-truth.md) | VCPChat 为 Session 唯一权威 | Accepted | 2026-07-25 |
| [0007](0007-pi-version-and-worker-isolation.md) | Pi 精确锁定 0.82.0 与 facade 隔离 0.x 演进 | Accepted | 2026-07-25 |
| [0008](0008-ipc-channel-namespace.md) | IPC 通道 `agent-runtime:` 命名空间 | Accepted | 2026-07-25 |
