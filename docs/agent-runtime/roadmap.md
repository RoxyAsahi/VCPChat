# Agent Runtime 路线图

阶段定义、进入条件、交付物、非目标、验收需求/测试、回滚策略。**当前分支已完成 Agent Runtime 主链路接入，并收缩为“Pi 编排 + VCPToolBox 唯一执行后端”。** 需求 ID 见 [requirements.md](requirements.md)，测试 ID 见 [test-matrix.md](test-matrix.md)。

## Phase 0 — 文档与契约冻结

- **进入条件**：无（本目录创建即启动）。
- **交付物**：`docs/agent-runtime/` 全目录；ADR 0001-0008 Accepted。
- **非目标**：任何运行时代码。
- **验收需求**：AR-COMPAT-005/006（契约形态确立）。
- **验收测试**：文档交叉引用完整性检查（ART-024 静态项）。
- **回滚策略**：整目录可删；不影响既有功能。

## Phase 1 — Pi Worker + Driver facade 骨架

- **进入条件**：Phase 0 文档合入；Node >= 22.19 可用；`agent-runtime/vcp-pi-core/` 的最小 MIT fork 可由 Worker import，并有上游来源和许可证记录。
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
- **交付物**：`userData/agent-runtime.sqlite`（WAL、schema version、sessions/turns/messages/events/tool_calls/approvals/artifacts/runtime_state/checkpoints）；Repository facade；启动恢复历史 session，并把遗留 in-flight turn 标记为 failed/interrupted；会话 CRUD/fork/history IPC；OpenAI SSE Main→worker→Pi 流桥（含 usage、Abort 与 8KB UTF-8 切片）；可测试 transcript-compaction facade 和持久 checkpoint。
- **非目标**：不声称 Pi AgentHarness opaque state 可完整恢复；不自动续跑或自动 resume；新 driver、scoped token 和 ToolBox 结构化 API 仍待后续对接。
- **验收需求**：AR-FR-009 + Phase 3 persistence/streaming/compaction requirements。
- **验收测试**：`test-agent-persistence.mjs`、`test-agent-sse.mjs`、`test-agent-compaction.mjs`、Pi worker-loop 回归；本环境 Node ABI 与 Electron 预编译 `better-sqlite3` 不匹配时 persistence 脚本明确 skip，需 packaged/Electron ABI 环境执行。
- **回滚策略**：store 为可注入依赖，未注入时保持 Phase 2 内存行为；DB 迁移前应由发行流程备份。

## Phase 4 — Grok Build（ACP）与 Claude Agent SDK Driver

- **进入条件**：driver facade 在 Pi 上稳定；合规套件 ART-022 全绿。
- **交付物**：两个新 driver（映射见 [driver-api.md](driver-api.md#5-三个-driver-的映射草案)）；ACP 传输适配；SDK permission callback 反向接入 ApprovalBroker。
- **非目标**：MCP 直连 worker；runtime 特有私有事件类型（扩展须 ADR）。
- **验收测试**：ART-022 参数化跑满三个 driver。
- **回滚策略**：driver 维度独立开关；问题 driver 下线不影响其余。

## Phase 5 — Workspace Patch workflow 与 VCP 能力复用

- **进入条件**：现有 FileOperator、PowerShellExecutor 与 `/v1/human/tool` 链路可用。
- **已交付**：PatchManager 只保留 proposal/diff/approval/TOCTOU/revert 状态机；读、写、创建、删除全部调用分布式 FileOperator。Pi 本地工具表删除 read/list/search/terminal，终端统一调用 PowerShellExecutor。
- **安全边界**：FileOperator 路径参数在 Main 绑定到 session workspace；包含 VCP marker 的内容使用 FileOperator 的 escaped write/edit 命令；apply/revert 独立审批。
- **已删除**：重复 WorkspaceManager、TerminalService、LocalToolProvider，以及未接入的 WSL/container/local-risk ExecutionPolicy。
- **验收测试**：`test-agent-diff.mjs`、`test-agent-tool-bridge.mjs`、`test-pi-worker-loop.mjs`。
- **回滚策略**：Patch 工具可独立从 Pi schema 移除；`vcp_invoke` 仍可继续使用原 ToolBox 插件能力。

后续 scoped token、并行工具与 Windows restricted token/job object best-effort 加固仍需独立阶段；无内核沙箱承诺。

## Phase 6 — Catalog / Capability / Subagent 领域核心（当前 checkpoint 增量）

- **进入条件**：Phase 0-2 checkpoint `d929e2e9`；领域实现不得依赖主代理集成。
- **交付物**：Local Tool Catalog（manifest/.block、hash/cache/refresh/drift、legacy unknown）；session/tool/action/path/expiry capability policy（deny 优先、默认拒绝）；adapter 驱动的 SubagentCoordinator（depth/concurrency/time/token/cost、取消级联）。
- **非目标**：建立第二套本地执行后端；启动独立 CLI；声称客户端策略是服务端安全边界。
- **验收测试**：`scripts/test-agent-catalog.mjs`、`scripts/test-agent-security.mjs`、`scripts/test-agent-subagents.mjs`（ART-029~031）。
- **回滚策略**：领域目录与 driver capability 描述可独立移除；因未接主流程，不改变 Phase 2 行为。

## Phase 7 — Team orchestration 领域核心

- **进入条件**：Phase 6 领域契约和预算测试通过。
- **交付物**：Run/Member/Wave/Role/Ownership/Handoff/Blackboard；sequential/parallel/adaptive wave；路径 ownership 冲突；结构化 blackboard/artifact refs；持久化和执行/取消 adapter；run 预算与取消。
- **非目标**：RuntimeManager/Pi/Workbench 集成；分布式执行器；将 blackboard 内容当可信指令。
- **验收测试**：`scripts/test-agent-team.mjs`（ART-032）。
- **回滚策略**：TeamCoordinator 没有全局注册或后台进程，可整体下线。

## Phase 8 — 多 Workspace / 分布式 / GA（后续）

- **进入条件**：Phase 7 接入主代理并稳定一个发布周期。
- **交付物**：多 workspace 并发 session、VCP 分布式节点上的 agent 调度、Agent 会话导出为聊天历史、GA 发布标准（测试矩阵全 complete）。
- **回滚策略**：按功能开关逐项灰度。

## 阶段间通用纪律

1. 每阶段合入前，对应测试行 Status 必须从 planned/in-progress 变为 complete 或明确标注 blocked 原因；`partial` 不得作为发布依据（沿用 [ui-system-qa-matrix.md](../ui-system-qa-matrix.md) 纪律）。
2. 契约变更（事件/通道/接口）必须伴随 ADR 或既有 ADR 修订（触发条件见 [contributing.md](contributing.md#adr-触发条件)）。
3. 每阶段开始先更新本文件状态行，结束时更新 [README.md](README.md) 的阶段状态表。
