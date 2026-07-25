# Agent Runtime 贡献指南

## 1. 目录边界（不得逾越）

| 目录 | 允许放 | 禁止放 |
| --- | --- | --- |
| `modules/agent-runtime/` | Manager、ApprovalBroker、EventNormalizer、session 注册表、drivers/ | Electron `ipcMain` 直接调用（放 agentRuntimeHandlers）、UI 代码 |
| `modules/agent-runtime/drivers/` | `AgentRuntimeDriver` 实现与类型 | `import 'electron'`（静态 lint 拦截）、ToolBox HTTP 细节（放桥） |
| `agent-runtime/`（sidecar） | worker 入口、Pi 适配、VCP 工具桥 worker 侧 | 窗口/对话框、凭据持久化、直接文件/shell 能力 |
| `modules/ipc/agentRuntimeHandlers.js` | IPC 薄层：参数校验 → 调 Manager → 结构化返回 | 业务逻辑、session 状态持有 |
| `modules/ui-system/agent-workbench.js` | Workbench UI（遵守 [ui-engineering-standard.md](../ui-engineering-standard.md)） | 直连 ToolBox、import Pi SDK、绕过 preload |
| `preloads/`（agent 段） | `agent-runtime:*` 窄封装 | 通用 `invoke(channel, ...)` 转发（AR-SEC-009） |

依赖方向：`renderer → preload → ipc handlers → agent-runtime → drivers → worker → VCPToolBox`，禁止反向与跨层（见 [architecture.md](architecture.md#2-分层依赖)）。

## 2. Checklist

### 新增 Driver

1. 实现 [driver-api.md](driver-api.md) 全部 stable 方法；可选方法不实现则保持 `undefined`。
2. probe 声明真实能力位；运行形态与隔离方式按 [adr/0007-pi-version-and-worker-isolation.md](adr/0007-pi-version-and-worker-isolation.md) 模式另立 ADR（版本锁定策略）。
3. 通过 ART-022 合规套件（参数化全 10 项）。
4. 在 [driver-api.md](driver-api.md#5-三个-driver-的映射草案) 增加映射小节；[event-protocol.md](event-protocol.md) `runtime` 枚举加值。
5. 确认工具唯一出口仍是 VCP 桥（AR-SEC-008/010）。

### 新增事件类型

1. 命名 `agent-runtime:<domain>.<verb>`；在 [event-protocol.md](event-protocol.md) 清单登记（类型/等级/payload/说明）。
2. payload 只加可选字段保持兼容；破坏式变更升 `schemaVersion` + ADR。
3. Normalizer 加 schema 校验与脱敏规则；补契约测试（ART-003/024）。

### 新增 IPC 通道

1. 命名 `agent-runtime:<action>`；注册进 [ipcContracts.js](../../modules/ipc/ipcContracts.js)（类型/owner/request/response schema，AR-COMPAT-005）。
2. preload 增加对应窄封装；handler 做参数 schema 校验。
3. 更新 [event-protocol.md](event-protocol.md#8-传输映射) 或 [architecture.md](architecture.md#3-关键序列) 中的序列说明。

### 新增工具（桥侧）

1. 确认 ToolBox 侧已存在且经审批策略覆盖；客户端 capability 配置加条目（[security-threat-model.md](security-threat-model.md#capability-权限模型)）。
2. 评估 riskClass 与审批层级；高危（写/执行/外发）默认 `user` 或 `user+backend`。
3. 补 marker 编码与注入测试（ART-004/016）。

## 3. ADR 触发条件

出现以下任一情况必须新增 ADR（编号顺延，结构见 [adr/README.md](adr/README.md)）：

- 进程边界/线程模型变化（如改多 worker、改 in-process）。
- 事件信封、IPC 命名空间、错误分类的破坏式变更。
- Driver 接口 stable 方法变更；新增 runtime 基座或更换锁定版本策略。
- 审批模型、capability 模型、凭据流转路径变化。
- Session 权威归属、持久化格式变化。
- 废弃或替换既有 ADR（在原 ADR 标注 `Superseded by ADR-xxxx`）。

## 4. 测试与文档同步

- 改行为必改测试矩阵行（[test-matrix.md](test-matrix.md)），Status 变更附 Evidence。
- 改契约必改对应文档小节并在 PR 描述列出受影响的需求 ID（AR-xxx）。
- 文档中标注 *(planned)* 的路径在代码落位后，同 PR 内移除标注。

## 5. 日志隐私规范

- 一律结构化 JSON；字段白名单：`ts, level, component, sessionId?, turnId?, toolCallId?, approvalId?, code?, msg`。
- 禁止记录：凭据/token/cookie、工具参数原文（记 `argsHash`）、用户输入全文（记长度与 hash）、绝对路径中的用户目录段（规范化为 `<workspace>` 相对表示）。
- 脱敏唯一出口是 EventNormalizer 与日志 wrapper；新增日志点必须过 wrapper（ART-015 扫描兜底）。

## 6. 完成定义（Definition of Done）

一个 agent-runtime 变更可合入，当且仅当：

1. 关联需求 ID 在 PR 描述中列出，且每条需求的验收方法已执行。
2. 测试矩阵对应行 Status 更新且 Evidence 附齐；安全门禁行未回退。
3. 契约变更已同步文档；需要 ADR 的已附 ADR。
4. `npm run check:ui-system` 与 `git diff --check` 通过（仓库惯例，见 [ui-system-qa-matrix.md](../ui-system-qa-matrix.md)）。
5. 分层 lint 通过（无反向依赖、driver 不 import electron、renderer 不 import agent-runtime 内部）。
