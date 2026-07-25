# Agent Runtime 需求登记册

稳定需求 ID。任何代码变更必须能回溯到至少一条需求；每条需求关联至少一个测试 ID（ART-xxx，详见 [test-matrix.md](test-matrix.md)）。等级定义见 [README.md](README.md#稳定性等级定义)。非目标见文末。

## 功能需求（AR-FR）

| ID | 等级 | 需求 | 验收方法 | 测试 |
| --- | --- | --- | --- | --- |
| AR-FR-001 | stable | 创建/枚举/关闭 agent session；session 元数据（AgentSession）由 VCPChat 主进程唯一持有；`clientRequestId` 幂等创建 | 集成：`agent-runtime:create-session/list/close` 往返；重复 `clientRequestId` 返回同 ID | ART-001 |
| AR-FR-002 | stable | 每 session 串行 turn：同 session 并发 `turn:send` 进入队列，任意时刻至多一个 `running` | 集成：连发 3 个 turn，断言顺序执行与 `turn.queued` 事件 | ART-002 |
| AR-FR-003 | stable | 流式 assistant 输出经统一事件信封转发到 renderer，顺序与 worker 产出一致 | 契约：事件 sequence 连续、`assistant.delta` 拼接等于最终 message | ART-003 |
| AR-FR-004 | stable | 工具调用经 `vcp_delegate` / `vcp_invoke` 桥接 VCPToolBox；marker 编码符合 [VCP.md](../../VCP.md) | 契约 + 集成：对真实 ToolBox 发 invoke 并回收结果 | ART-004, ART-005 |
| AR-FR-005 | stable | 中断 turn：`turn:cancel` 传播到 worker agent loop 并 best-effort 调 `/v1/interrupt` | 集成：运行中取消，断言 `turn.cancelled` 与 interrupt 调用记录 | ART-010 |
| AR-FR-006 | stable | 双层审批：本地 ApprovalBroker 显式审批 + ToolBox 后端审批（VCPLog WS）串联执行 | E2E：需审批工具走完两层并落审计字段 | ART-006, ART-023 |
| AR-FR-007 | stable | 所有跨进程信息以 `agent-runtime:*` 统一事件信封传递（见 [event-protocol.md](event-protocol.md)） | 契约：事件 schema 校验套件 | ART-003, ART-024 |
| AR-FR-008 | stable | Worker 崩溃可检测（exit/心跳），承载 session 转 `failed` 并广播 `runtime.worker-exit` | Fault：kill worker 进程断言事件与清理 | ART-011 |
| AR-FR-009 | provisional | resume session（经 RuntimeOpaqueState 恢复 driver 状态）— Phase 3 交付 | 集成：重启后 resume 并继续 turn | ART-026（Phase 3 段） |
| AR-FR-010 | stable | Driver 能力协商：`probe` 返回能力位，Manager 据以裁剪 UI 与工具集 | 单元：probe mock；契约：capabilities schema | ART-022 |
| AR-FR-011 | stable | 应用退出清理：关闭全部 session、dispose driver、终止 worker，无孤儿进程 | E2E/Fault：退出后 `tasklist` 无残留 worker | ART-012 |
| AR-FR-012 | provisional | plan / context 事件归一化（`plan.updated`、`context.usage`、`context.compacted`） | 契约：事件 payload schema | ART-003 |
| AR-FR-013 | stable | marker 解析与注入防护：仅解析 worker 结构化上报的工具调用；用户/工具结果文本中的伪造 marker 不触发调用 | Security：注入语料套件 | ART-016 |
| AR-FR-014 | stable | generation 防复活：turn 切换使 generation 递增，旧 generation 回调一律丢弃 | Fault：取消后注入延迟回调，断言无事件 | ART-020, ART-021 |

## 非功能需求（AR-NFR）

| ID | 等级 | 需求 | 验收方法 | 测试 |
| --- | --- | --- | --- | --- |
| AR-NFR-001 | provisional | 流式转发开销不阻塞 UI：单 delta 事件 Main 内处理 < 5ms（P95）；事件风暴下 renderer 不丢帧（合并渲染策略由 Workbench 负责） | 基准：10k delta 压测记录 P95 | ART-003（perf 标注） |
| AR-NFR-002 | stable | 每 session 事件缓冲有界：默认 1000 条 ring buffer，溢出丢最旧并发一次 `runtime.warning` | 单元：溢出计数与 warning 断言 | ART-018 |
| AR-NFR-003 | stable | 单事件序列化 payload ≤ 256KB；`assistant.delta` ≤ 8KB；工具结果归一化 ≤ 64KB 并置 `truncated` | 契约：超限输入断言截断/拒绝 | ART-019 |
| AR-NFR-004 | stable | 运行环境 Node >= 22.19（worker 内）；Electron 主进程侧不依赖 worker 专有 API | CI：版本门禁脚本 | ART-022（环境项） |
| AR-NFR-005 | stable | 结构化日志覆盖全部错误边界；日志/事件不含凭据与敏感参数 | 审计：日志采样 grep 密钥模式 | ART-015 |
| AR-NFR-006 | provisional | 错误按 [driver-api.md](driver-api.md#错误分类) 分类，UI 展示可读文案而非堆栈 | 单元：错误映射表全覆盖 | ART-025 |
| AR-NFR-007 | provisional | 资源上限：单 worker RSS 超 2GB 或 turn 超 1800s 强制回收并产生事件 | Fault：内存膨胀脚本断言回收 | ART-011（扩展项） |

## 安全需求（AR-SEC）

| ID | 等级 | 需求 | 验收方法 | 测试 |
| --- | --- | --- | --- | --- |
| AR-SEC-001 | stable | 审批绑定 `sessionId + turnId + toolCallId + argsHash`；四元组任一不符即不可决议 | 契约：篡改任一字段决议被拒 | ART-006, ART-008 |
| AR-SEC-002 | stable | 默认拒绝、超时拒绝（默认 120s）、无可用审批窗口拒绝 | 集成：三种拒绝路径 | ART-007, ART-009 |
| AR-SEC-003 | stable | 审批决议后参数变化（argsHash 不匹配）使决议失效，需重新审批（TOCTOU 防护） | Security：决议后改参数重放 | ART-008 |
| AR-SEC-004 | stable | 无 always-allow：不实现"记住选择/始终允许"任何粒度的持久豁免 | 代码审计 + UI 审计 | ART-006（审计项） |
| AR-SEC-005 | stable | 凭据脱敏：token/Authorization/密钥字段不进日志、事件、审批 UI 的原文 | Security：脱敏扫描 | ART-015 |
| AR-SEC-006 | stable | workspace 路径规范化与逃逸防护：拒绝 `..`、符号链接逃逸、跨盘符访问 | Security：逃逸语料（含 Windows UNC/长路径/中文） | ART-013, ART-017 |
| AR-SEC-007 | stable | 后端审批不可绕过：本地批准不跳过 ToolBox 审批；桥不伪造后端审批结果 | 集成：mock 后端拒绝断言 `tool.failed` | ART-006, ART-023 |
| AR-SEC-008 | stable | Worker 内 Pi 内置工具（read/write/edit/bash）与 extension 自动加载全部禁用；工具唯一出口是 VCP 桥 | 单元：启动断言工具集为空集+桥工具；Fault：尝试启用被拒 | ART-004（审计项）, ART-027 |
| AR-SEC-009 | stable | preload 窄面：`contextIsolation: true`，仅暴露 `agent-runtime:*` 封装，无通用 `invoke` 转发 | Security：renderer 尝试任意通道被拒 | ART-009（扩展项） |
| AR-SEC-010 | stable | 模型输出不直接执行：工具调用只能来自 worker 结构化 tool call；审批 UI 中的工具描述按不可信文本渲染（不执行 HTML/链接跳转） | Security：恶意工具描述渲染审计 | ART-016, ART-028 |

## 兼容性需求（AR-COMPAT）

| ID | 等级 | 需求 | 验收方法 | 测试 |
| --- | --- | --- | --- | --- |
| AR-COMPAT-001 | legacy-frozen | 兼容旧 `POST /v1/chatvcp/completions` 与 `POST /v1/human/tool` 既有行为；本轮不改 VCPToolBox | 集成：对现有 ToolBox 回归 | ART-004, ART-005 |
| AR-COMPAT-002 | legacy-frozen | 兼容 VCPLog WebSocket 审批往返协议 | 集成：审批请求/决议报文回放 | ART-023 |
| AR-COMPAT-003 | stable | 支持 Windows 10/11：路径（空格/中文/长路径/UNC）、进程树清理 | E2E：Windows 语料套件 | ART-012, ART-013 |
| AR-COMPAT-004 | stable | Pi 精确锁定 `0.82.0`（`@earendil-works/pi-agent-core` 与 `pi-ai`），经 driver facade 隔离 0.x 演进 | 构建：`npm ls` 精确版本断言 | ART-022 |
| AR-COMPAT-005 | stable | 新 IPC 通道一律 `agent-runtime:` 命名空间并注册进 [ipcContracts.js](../../modules/ipc/ipcContracts.js) | 静态：通道注册 lint | ART-024（静态项） |
| AR-COMPAT-006 | stable | 事件 `schemaVersion` 兼容策略：主版本不兼容事件不得崩溃，须告警并丢弃 | 契约：注入未知版本事件 | ART-024 |

## 非目标（Non-goals）

以下事项明确**不在**本需求体系内，实现不得夹带：

1. 不修改 VCPToolBox 后端代码；Phase 3+ 契约（[legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md#phase-3-后端结构化-api-契约提案)）落地前视为提案。
2. 不在客户端实现内核级沙箱；Windows 上依赖审批与路径防护而非隔离（见 [security-threat-model.md](security-threat-model.md)）。
3. Phase 2 不做重启持久恢复（事件与 session 仅存内存），不做并行工具执行，不做多 worker 负载均衡。
4. 不提供 always-allow、全局工具白名单持久豁免、或任何"跳过审批"设置项。
5. 不在 renderer 直接加载 Pi SDK 或直连 VCPToolBox。
6. 不把 MCP 直接接入 worker；MCP 工具一律经 VCPToolBox 暴露（Phase 4 再评估）。
