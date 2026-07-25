# Agent Runtime 路线图

阶段定义、进入条件、交付物、非目标、验收需求/测试、回滚策略。**当前分支 `codex/agent-runtime-phase2` 交付 Phase 0-2。** 需求 ID 见 [requirements.md](requirements.md)，测试 ID 见 [test-matrix.md](test-matrix.md)。

## Phase 0 — 文档与契约冻结

- **进入条件**：无（本目录创建即启动）。
- **交付物**：`docs/agent-runtime/` 全目录；ADR 0001-0008 Accepted。
- **非目标**：任何运行时代码。
- **验收需求**：AR-COMPAT-005/006（契约形态确立）。
- **验收测试**：文档交叉引用完整性检查（ART-024 静态项）。
- **回滚策略**：整目录可删；不影响既有功能。

## Phase 1 — Pi Worker + Driver facade 骨架

- **进入条件**：Phase 0 文档合入；Node >= 22.19 可用；`@earendil-works/pi-agent-core`/`pi-ai`@0.82.0 锁定进 package.json。
- **交付物**：`agent-runtime/` worker 入口（`ELECTRON_RUN_AS_NODE=1`）；`modules/agent-runtime/drivers/` facade + Pi driver；无工具 hello turn 端到端（建 session → 流式回复 → 关闭）；内置工具/extension 禁用断言。
- **非目标**：任何工具调用；审批 UI；持久化。
- **验收需求**：AR-FR-001/002/003/008/010/011/014、AR-SEC-008、AR-NFR-004、AR-COMPAT-003/004。
- **验收测试**：ART-001/002/003/011/012/020/022。
- **回滚策略**：功能开关 `agentRuntime.enabled=false` 时完全不 spawn worker；删除两个新目录即还原。

## Phase 2 — 旧接口实连 + 双层审批 + Workbench MVP（本分支终点）

- **进入条件**：Phase 1 测试 complete；ToolBox 旧接口回归环境可用。
- **交付物**：VCP 工具桥（vcp_invoke/vcp_delegate、marker 编码、argsHash）；ApprovalBroker + 审批 UI；`modules/ui-system/agent-workbench.js`（VCPUI internal app）；`modules/ipc/agentRuntimeHandlers.js` + 通道注册；VCPLog WS 后端审批接线；[legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md) §3 补偿全部落地。
- **非目标**：重启恢复；并行工具；scoped token；后端改动；沙箱。
- **验收需求**：AR-FR-004/005/006/012/013、AR-SEC-001~007/009/010、AR-NFR-001/002/003/005/006/007、AR-COMPAT-001/002。
- **验收测试**：ART-004~010、ART-013~021、ART-023、ART-025~028；安全门禁 ART-006/007/008/015/016/017 必须 complete。
- **回滚策略**：工具桥按 session 级开关可关（退回 Phase 1 无工具模式）；审批层故障的兜底是"默认拒绝"而非"默认放行"；IPC 通道可整体下线（注册表注释 + preload 不暴露）。
- **已知立场**：本阶段结束时系统是"接通的"，不是"达到目标安全架构的"（D1/D2/D3 未治愈，见 legacy 文档 §2）；发布说明必须如实声明。

## Phase 3 — 持久化 / 重启恢复 / ToolBox 结构化 API

- **进入条件**：Phase 2 安全门禁通过；与 ToolBox 维护者确认结构化契约排期。
- **交付物**：SQLite 存储与迁移（[data-model.md](data-model.md#6-phase-3-sqlite-计划)）；`resumeSession` + RuntimeOpaqueState；Tool Catalog/JSON Invoke/事件流/scoped token 客户端侧对接（契约见 legacy 文档 §4）；capability 探测与 legacy 回退。
- **非目标**：新 driver。
- **验收需求**：AR-FR-009 + Phase 3 新增需求（届时扩充）。
- **验收测试**：ART-026（扩展）+ 契约测试新增。
- **回滚策略**：探测失败自动回 legacy；DB 迁移可逆（备份 + down 脚本）。

## Phase 4 — Grok Build（ACP）与 Claude Agent SDK Driver

- **进入条件**：driver facade 在 Pi 上稳定；合规套件 ART-022 全绿。
- **交付物**：两个新 driver（映射见 [driver-api.md](driver-api.md#5-三个-driver-的映射草案)）；ACP 传输适配；SDK permission callback 反向接入 ApprovalBroker。
- **非目标**：MCP 直连 worker；runtime 特有私有事件类型（扩展须 ADR）。
- **验收测试**：ART-022 参数化跑满三个 driver。
- **回滚策略**：driver 维度独立开关；问题 driver 下线不影响其余。

## Phase 5 — 沙箱与 scoped token 强制 / 并行工具

- **进入条件**：后端 scoped token 上线；capability 冲突矩阵评审通过。
- **交付物**：scoped token 取代长期凭据（worker 只持 scoped token）；并行工具执行；平台沙箱调研落地（Windows 受限 token/job object 的 best-effort 加固，不承诺内核级隔离）。
- **验收测试**：ART-014（并行语义更新）、ART-017（加固后复跑）。
- **回滚策略**：并行度可配置为 1（退回串行）。

## Phase 6 — 多 Workspace / 分布式 / GA

- **进入条件**：Phase 5 稳定一个发布周期。
- **交付物**：多 workspace 并发 session、VCP 分布式节点上的 agent 调度、Agent 会话导出为聊天历史、GA 发布标准（测试矩阵全 complete）。
- **回滚策略**：按功能开关逐项灰度。

## 阶段间通用纪律

1. 每阶段合入前，对应测试行 Status 必须从 planned/in-progress 变为 complete 或明确标注 blocked 原因；`partial` 不得作为发布依据（沿用 [ui-system-qa-matrix.md](../ui-system-qa-matrix.md) 纪律）。
2. 契约变更（事件/通道/接口）必须伴随 ADR 或既有 ADR 修订（触发条件见 [contributing.md](contributing.md#adr-触发条件)）。
3. 每阶段开始先更新本文件状态行，结束时更新 [README.md](README.md) 的阶段状态表。
