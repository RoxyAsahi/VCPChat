# Agent Runtime 测试矩阵（Pi-era 历史资料）

> 已归档：Rust daemon/GUI 当前验收门槛见 [current/delivery-plan.md](current/delivery-plan.md)。

格式沿用 [docs/ui-system-qa-matrix.md](../ui-system-qa-matrix.md) 的纪律：`partial` 不得作为发布完成依据；每行升级状态必须附 Evidence（测试日志/截图/CI 链接）。Level 列：Unit / Contract / Integration / E2E / Fault / Security，以 ● 标记该测试覆盖的层级。

Status 取值：`planned` / `in-progress` / `partial` / `complete` / `blocked`。

| Test ID | Area | 场景 | Unit | Contract | Integration | E2E | Fault | Security | Evidence | Status |
| --- | --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | --- | --- |
| ART-001 | session 生命周期 | 创建/枚举/关闭；`clientRequestId` 幂等；非法参数结构化错误 | ● | ● | ● | | | | | in-progress |
| ART-002 | turn 调度 | 同 session 连发 3 turn：排队、顺序执行、`turn.queued` 位次正确；跨 session 不互斥 | ● | | ● | | | | | in-progress |
| ART-003 | 事件流 | sequence 连续；delta 拼接=终稿；gap 检测与回补；10k delta 压测 P95（AR-NFR-001） | ● | ● | ● | | | | | in-progress |
| ART-004 | 工具桥 invoke | marker 编码合规（对照 [VCP.md](../../VCP.md)）；非法 toolName 拒发；真实 ToolBox 往返 | ● | ● | ● | | | | `test-agent-tool-bridge.mjs`、`test-legacy-toolbox-client.mjs`、`test-live-agent-tool.mjs`（gpt-5.6-terra → SciCalculator=42） | complete |
| ART-005 | 工具桥 delegate | `delegate: true` session 走 chatvcp/completions；UI 标注"审批在后端"；capability 上限生效 | | ● | ● | | | | `test-legacy-toolbox-client.mjs`、`test-live-agent-delegate.mjs`（gpt-5.6-terra） | complete |
| ART-006 | 双层审批 | 中危工具走通两层；四元组篡改任一字段决议失败；audit 字段完整 | | ● | ● | ● | | ● | `test-agent-tool-bridge.mjs`、`test-live-agent-tool.mjs`、`test-live-agent-deny.mjs`；ToolBox 后端无需审批的 SciCalculator 路径已验证，需审批工具的 VCPLog 双层关联仍待测 | partial |
| ART-007 | 审批超时 | 120s 无操作自动拒绝；`approval.expired` 事件；工具未执行 | ● | | ● | | | ● | | planned |
| ART-008 | 审批 TOCTOU | 决议后改参数重放：argsHash 复核作废重审 | ● | ● | | | | ● | | planned |
| ART-009 | 无窗口拒绝 | 关闭 Workbench 后触发需审批调用：直接拒绝+事件；renderer 任意通道调用被拒（AR-SEC-009 合并验证） | | | ● | | | ● | | planned |
| ART-010 | 中断 | 运行中取消：worker abort + `/v1/interrupt` 记录；`turn.cancelled`；UI 提示"尽力而为" | | | ● | ● | | | `test-live-agent-cancel.mjs` 真实 Pi 模型请求取消通过；delegate `/v1/interrupt` 实机时序仍待测 | partial |
| ART-011 | Worker 崩溃 | kill -9 worker：`runtime.worker-exit` 广播、session→failed、无事件泄漏；内存膨胀触发 QUOTA 回收（AR-NFR-007） | | | ● | | ● | | | planned |
| ART-012 | 退出清理 | 应用退出后 `tasklist` 无残留 worker 进程（含多 session 场景） | | | | ● | ● | | | planned |
| ART-013 | Windows 路径 | 空格/中文/长路径(>260)/UNC 的 workspaceRoot 规范化；大小写盘符归一 | ● | | ● | | | | | planned |
| ART-014 | 并行工具顺序 | 单 turn 3 个并行 tool call：串行执行、按 toolCallId 序回填、各自独立审批 | ● | | ● | | | | | planned |
| ART-015 | 凭据脱敏 | 日志/事件/审批 UI 扫描：`sk-*`、Bearer、Authorization、secret 字段均为 `***`；worker 落盘文件无凭据 | ● | | ● | | | ● | | planned |
| ART-016 | Marker 注入 | 参数含 `<<<[TOOL_REQUEST]>>>`/「始」「末」字面量：编码硬拒绝；工具结果含伪造 marker 不二次执行 | ● | ● | | | | ● | | planned |
| ART-017 | 路径逃逸 | `../`、符号链接、junction、跨盘符、`\\?\` 前缀逃逸语料全部拒绝 | ● | | ● | | | ● | | planned |
| ART-018 | 事件缓冲 | 灌入 1001+ 事件：丢最旧 + 单次 `buffer-overflow` warning；回补接口正确 | ● | | ● | | ● | | | planned |
| ART-019 | 大小限制 | 256KB 事件拒绝；8KB delta 切分；64KB 工具结果截断 + `truncated` | ● | ● | | | | | `scripts/test-agent-sse.mjs` 覆盖 OpenAI SSE 分帧与 8KB UTF-8 切片；其余限制待补 | partial |
| ART-020 | generation 防复活 | 取消后注入迟到工具结果/审批决议：全部丢弃；audit 记 `lateResult` | ● | | ● | | ● | ● | | planned |
| ART-021 | 旧回调复活 | turn A 取消→turn B 开始，A 的流式 delta 延迟到达：不进 B 的事件流 | ● | | ● | | ● | | | planned |
| ART-022 | Driver 合规 | [driver-api.md](driver-api.md#4-driver-合规测试清单) 10 项参数化跑 Pi；版本门禁（精确 0.82.0、Node≥22.19） | ● | ● | ● | | | | `test-agent-runtime-manager.mjs`、`test-pi-worker-loop.mjs`、`probe-agent-runtime.mjs` | partial |
| ART-023 | 后端审批兼容 | VCPLog WS 审批请求/决议回放；匹配置信度入 audit；关联未证实时 UI 语义正确；WS 断连按超时拒绝 | | ● | ● | | ● | | | planned |
| ART-024 | 协议兼容 | 未知 schemaVersion 事件丢弃+warning 不崩溃；通道注册 lint（`agent-runtime:` 全注册）；文档交叉引用完整 | ● | ● | | | | | | in-progress |
| ART-025 | 错误分类 | driver 错误码全表映射到 UI 文案；原始堆栈不外泄 | ● | ● | | | | | | planned |
| ART-026 | 重启语义 | Phase 3：SQLite 迁移/WAL、event 唯一约束、redaction、in-flight turn/tool/approval fail closed、历史查询；恢复 Pi transcript 不自动重放未完成工具 | ● | ● | ● | | ● | ● | `scripts/test-agent-persistence.mjs`；`scripts/test-agent-persistence-electron.cjs` 已在 Electron 41.7.1 ABI 验证通过 | partial |
| ART-027 | Shell 注入 | 桥侧无 shell 拼接（静态审计）；含 `& | ; $()` 的参数原样传递不被解释 | ● | ● | | | | ● | | planned |
| ART-028 | 恶意工具描述 | 描述含 HTML/链接/伪按钮：审批 UI 纯文本渲染、不可点击、无脚本执行 | | | ● | ● | | ● | | planned |
| ART-029 | Local Tool Catalog | 扫描 manifest/.block；array/object command；hash/cache/drift；不泄露 config；legacy unknown | ● | ● | | | ● | ● | `scripts/test-agent-catalog.mjs` | complete |
| ART-030 | Capability policy | deny 优先；expiry/path；默认拒绝 write/shell/subagent；snapshot hash；默认工具仅含 VCP/patch/orchestration | ● | ● | | | ● | ● | `scripts/test-agent-security.mjs` | complete |
| ART-031 | Subagent orchestration | depth/concurrency/token/cost/time budget；状态机；父取消级联；adapter/event 契约 | ● | ● | | | ● | ● | `scripts/test-agent-subagents.mjs` | complete |
| ART-032 | Team orchestration | sequential/parallel/adaptive；并发上限；ownership 父子路径冲突；budget/cancel；结构化 blackboard/artifact refs；持久化 | ● | ● | | | ● | ● | `scripts/test-agent-team.mjs` | complete |
| ART-033 | FileOperator workspace scope | FileOperator 相对路径绑定 workspace；绝对/跨根/`..` 拒绝；Pi 不暴露重复 read/list/search 工具 | ● | ● | ● | | | ● | `scripts/test-agent-tool-bridge.mjs`、`scripts/test-pi-worker-loop.mjs` | complete |
| ART-034 | VCP-backed Patch proposal | propose 不写；before/after hash+content；unified diff；独立审批 apply/revert；marker escaped write/edit | ● | ● | ● | | ● | ● | `scripts/test-agent-diff.mjs` | complete |
| ART-035 | Patch content TOCTOU | proposal 后内容替换、apply/revert hash 不匹配均 fail closed；读写均经 FileOperator | ● | | ● | | ● | ● | `scripts/test-agent-diff.mjs` | complete |
| ART-036 | PowerShellExecutor reuse | Pi 不暴露 terminal_execute；vcp_invoke 识别 PowerShellExecutor 为高风险；真实 PTY/并发行为由既有插件集成验证 | ● | ● | ● | | ● | ● | `scripts/test-agent-tool-bridge.mjs`、`scripts/test-pi-worker-loop.mjs`；live integration 待补 | partial |
| ART-037 | Single execution backend | sidecar 只标记 patch/orchestration 为 local-main；文件、终端和通用插件统一走 VCP adapter | ● | ● | ● | | | ● | `test-agent-runtime-manager.mjs`、`test-pi-worker-loop.mjs` | complete |

## Phase 3 persistence / streaming / compaction 测试状态（2026-07-25）

`test-agent-sse.mjs` 覆盖 OpenAI SSE 的跨 chunk 解析、reasoning/tool-call 参数片段和 8KB UTF-8 切片；`test-pi-worker-loop.mjs` 验证 Main→worker 的 model-delta/model-done 实流桥；`test-agent-compaction.mjs` 覆盖 transcript facade、usage 和 checkpoint 写入。`test-agent-persistence.mjs` 在普通 Node ABI 不匹配时会明确 skip；`test-agent-persistence-electron.cjs` 使用 `ELECTRON_RUN_AS_NODE=1` 在 Electron 41.7.1 原生 ABI 下已验证 migration/WAL/唯一约束/redaction、in-flight tool/approval fail-closed、artifact/runtime-state 查询。

## Phase 5 收缩后测试状态（2026-07-25）

ART-033~035、037 已覆盖单一 VCP 执行后端、FileOperator workspace scope、VCP-backed Patch workflow 和 Pi 工具表收缩。ART-036 仍需针对既有 PowerShellExecutor 做真实 ToolBox/PTY 并发集成测试。

## Phase 6–7 领域测试状态（2026-07-25）

ART-029~032 均由无网络、无 Electron、无 CLI 的 Node 领域脚本验证完成；这些结果不代表 RuntimeManager/Pi/IPC/Workbench 集成已完成。

## 状态汇总（2026-07-25）

| Status | 数量 | Test ID |
| --- | --- | --- |
| complete | 2 | ART-004, ART-005（真实 upstream ToolBox + gpt-5.6-terra） |
| in-progress | 4 | ART-001, ART-002, ART-003, ART-024（静态部分先行） |
| partial | 4 | ART-006（本地审批/拒绝已实测，需审批工具的后端 VCPLog 关联待测）, ART-010（真实模型取消已测，delegate interrupt 待测）, ART-022（Pi Worker Loop 已实跑，完整 Driver 合规矩阵未完成）, Electron GUI（独立窗口视觉截图待人工） |
| planned | 18 | 其余全部，Phase 2 稳定化时逐项推进 |

## 执行纪律

1. 每行 Status 变更必须附 Evidence（CI 链接 / 测试日志路径 / Electron 实测截图）。
2. 安全门禁行（ART-006/007/008/015/016/017）未 complete 不得发布 Phase 2（见 [security-threat-model.md](security-threat-model.md#6-验证与审计)）。
3. Windows 相关行（ART-012/013/017）必须在真实 Windows 10/11 环境执行，不接受 WSL 替代。
4. 本地验证前后沿用仓库惯例命令：`npm run check:ui-system` 与 `git diff --check`（见 [ui-system-qa-matrix.md](../ui-system-qa-matrix.md)）。
