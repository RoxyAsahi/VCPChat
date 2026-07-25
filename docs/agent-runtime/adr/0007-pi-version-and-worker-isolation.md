# ADR-0007: Pi 精确锁定 0.82.0 与 facade 隔离 0.x 演进

- Status: Accepted
- Date: 2026-07-25

## Context

首选基座 Pi（`@earendil-works/pi-agent-core` 与 `pi-ai`）处于 0.x 阶段，semver 下任何 minor 都可能破坏 API；同时它要求 Node >= 22.19。不锁版本会让 CI 与用户环境不可复现；让 SDK 类型渗入 Main/Renderer 则每次升级都演变成全仓 refactor。

## Decision

1. **精确锁定**：package.json 以无 range 的精确版本 `0.82.0` 固定 `@earendil-works/pi-agent-core` 与 `pi-ai`；`npm ls` 精确版本断言进 CI（ART-022 环境项）；probe 时运行时再校验一次（不一致报 `VERSION_MISMATCH`）。
2. **facade 隔离**：SDK 类型与调用只允许出现在 `agent-runtime/`（worker）与 `modules/agent-runtime/drivers/pi*` 内；Main 其余部分与 Renderer 只见 [../driver-api.md](../driver-api.md) 抽象（ADR-0003）。升级 SDK = 改 facade + 跑合规套件，是局部事件。
3. **运行环境门禁**：worker 启动校验 Node >= 22.19（AR-NFR-004）。
4. **升级纪律**：0.x 升级逐版本评审 changelog；升版本 PR 必须同时更新本 ADR 版本号声明与锁定值。

## Alternatives

1. **caret/tilde range**：0.x 下 minor 即破坏，等于不锁——拒绝。
2. **fork 并 vendoring**：可彻底免疫上游变化，但维护分叉成本远超收益；Pi 演进快，跟进上游更有价值——拒绝（保留为应急手段）。
3. **等 1.0 再采用**：阻塞整个路线图；facade 已把 0.x 风险局部化——拒绝。

## Consequences

- 正面：可复现构建；升级影响面可预测（facade+合规套件）；probe 给用户提供明确的环境错误文案。
- 负面：安全修复需手动升版跟进（接受，纳入版本评审纪律）；lockfile 与声明双重固定增加极少维护量。
- Node 版本要求传导为 worker 的部署前提，文档见 [../README.md](../README.md) 与 [../requirements.md](../requirements.md)。

## Compatibility impact

Electron 主进程不加载 SDK，主进程 Node 版本不受 22.19 约束（仅 worker，经 `ELECTRON_RUN_AS_NODE` 获得其内置 Node）。对用户机器无额外安装要求。

## Security impact

锁定版本使供应链 diff 可审；facade 边界即 AR-SEC-008 的执法点（内置工具/extension 禁用在 facade 内完成并断言）。

## Migration-rollback

回滚=退回上一锁定版本并 revert facade 适配；无数据格式耦合（RuntimeOpaqueState 带 `stateVersion`，错配拒绝 resume 而非崩溃，ADR-0006）。

## Related requirements and tests

AR-NFR-004, AR-SEC-008, AR-COMPAT-004；ART-022。
