# ADR-0001: Runtime 进程边界：独立 Worker + ELECTRON_RUN_AS_NODE

- Status: Accepted
- Date: 2026-07-25

## Context

Agent Runtime 要运行第三方 agent loop SDK（首选 Pi，`@earendil-works/pi-agent-core`@0.82.0，要求 Node >= 22.19）。可选的宿主：Electron Renderer（有 Chromium 沙箱但受 browserified 限制、且会阻塞 UI）、Electron Main（Node 能力全但崩溃即拖垮整个应用、且与窗口生命周期耦合）、独立子进程。Pi 的 agent loop 是长驻、高内存、可能崩溃的负载；同时我们不信任模型生成路径上的任何代码靠近窗口系统与凭据存储。

## Decision

Pi 运行在**独立 Worker 子进程**：由 Electron Main `fork()` 启动 `agent-runtime/` 入口，环境变量 `ELECTRON_RUN_AS_NODE=1` 使 Electron 二进制退化为纯 Node 运行时。Main 与 Worker 之间使用 stdio JSON-lines 消息协议。Phase 2 默认单 worker 承载全部 session；worker 崩溃只影响其承载的 agent session，不影响 VCPChat 主体。Worker 内禁用 Pi 全部内置工具与 extension 自动加载，外部能力唯一出口是 VCP 工具桥（ADR-0004）。

## Alternatives

1. **Renderer 内运行**：UI 卡顿、Node API 受限、XSS 面直接叠加 agent 能力——拒绝。
2. **Main 内运行（in-process）**：SDK 崩溃/OOM 拖垮整个应用；无法单独重启；凭据与窗口句柄同进程——拒绝。
3. **独立 Node 可执行文件（非 Electron fork）**：需随应用分发 Node runtime，体积与签名成本上升；`ELECTRON_RUN_AS_NODE` 零额外分发成本——作为备选保留。
4. **utilityProcess + MessagePort**：Electron 原生 API，但默认仍是 Electron 上下文；本决策用 fork+env 获得更纯的 Node 语义。后续如需 MessagePort 吞吐优化可再评估，不改变边界本身。

## Consequences

- 正面：故障隔离（ART-011）、独立内存上限与回收、可单独重启 worker、Node 版本语义清晰。
- 负面：跨进程序列化开销（以事件大小限制 AR-NFR-003 控制）；调试链路变长（需结构化日志 AR-NFR-005）；退出清理复杂度（ART-012）。
- Worker 协议（stdio JSON-lines）成为内部契约，变更需同步 [../event-protocol.md](../event-protocol.md#8-传输映射)。

## Compatibility impact

Windows 10/11 上 fork Electron 二进制为成熟路径；`ELECTRON_RUN_AS_NODE` 与现有主进程无冲突。对既有 VCPChat 功能零影响（新进程按需启动，功能开关可关）。

## Security impact

信任边界 TB2 由此建立：worker 无窗口、不持久化凭据、无本地文件/shell 直执能力。进程隔离**不是**安全沙箱（Windows 无内核级隔离承诺），安全支柱仍是审批与 capability（ADR-0005）。

## Migration-rollback

回滚 = 功能开关关闭 + 不 spawn worker + 删除 `agent-runtime/` 目录。无持久化格式，无数据迁移。

## Related requirements and tests

AR-FR-008, AR-FR-011, AR-SEC-008, AR-NFR-004, AR-COMPAT-003；ART-011, ART-012, ART-022。
