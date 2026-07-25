# Agent Runtime 开发文档

本目录是 VCPChat Agent Runtime（代号 `agent-runtime`）的唯一开发文档真源。它定义进程架构、事件协议、Driver 接口、工具桥、安全威胁模型、数据模型、路线图与测试矩阵，供主进程、Worker、Renderer（Agent Workbench）与后端 VCPToolBox 两侧的实现共同遵守。

## 范围声明（Scope）

- **范围内**：VCPChat 仓库内的 Agent Runtime 全部客户端实现（Electron Main、Pi Worker sidecar、窄 preload IPC、Agent Workbench internal app），以及 VCPChat 与 VCPToolBox 之间的**客户端侧**桥接行为。
- **范围外（本轮不修改）**：VCPToolBox 后端实现。旧接口（`POST /v1/chatvcp/completions`、`POST /v1/human/tool`、`/v1/interrupt`、VCPLog WebSocket 审批）的行为只在 [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md) 中描述与补偿，Phase 3+ 的后端结构化契约以提案形式给出，落地另立项目。
- **关键立场**：Phase 2 用旧接口实连意味着"接通"，**不等于达到目标安全架构**。任何代码不得以"旧接口已能工作"为由削弱 [security-threat-model.md](security-threat-model.md) 中的缓解要求。

## 不重复的既有真源

本文档体系引用但不复制以下文档，冲突时以它们为准（VCP 协议与插件层）：

| 真源 | 内容 |
| --- | --- |
| [VCP.md](../../VCP.md) | VCP 文本工具协议（`<<<[TOOL_REQUEST]>>>` marker 语法唯一真源） |
| [同步异步插件开发手册.md](../../同步异步插件开发手册.md) | 插件 manifest / stdin / stdout 协议 |
| [Flowlockmodules/README.md](../../Flowlockmodules/README.md) | Flowlock 模块 |
| [docs/ui-engineering-standard.md](../ui-engineering-standard.md) | UI 工程规范（Agent Workbench 必须遵守） |
| [docs/ui-system-qa-matrix.md](../ui-system-qa-matrix.md) | QA 矩阵格式（[test-matrix.md](test-matrix.md) 沿用） |
| [modules/ipc/ipcContracts.js](../../modules/ipc/ipcContracts.js) | IPC 通道注册表（`agent-runtime:` 通道必须注册于此） |
| Desktopmodules 文档 | VDesktop / internal app 平台约定 |

## 阅读顺序

1. [architecture.md](architecture.md) — 进程边界、分层、关键序列、并发与错误边界。
2. [requirements.md](requirements.md) — 稳定需求 ID（AR-FR/AR-NFR/AR-SEC/AR-COMPAT）与验收方法。
3. [event-protocol.md](event-protocol.md) — 统一事件信封与事件类型清单。
4. [driver-api.md](driver-api.md) — `AgentRuntimeDriver` 接口与 Pi/Grok/Claude 映射。
5. [tool-bridge.md](tool-bridge.md) — `vcp_delegate` / `vcp_invoke` 语义与 marker 编码。
6. [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md) — 旧接口缺陷、客户端补偿、Phase 3+ 契约提案。
7. [security-threat-model.md](security-threat-model.md) — 威胁模型、capability 权限、双层审批规则。
8. [data-model.md](data-model.md) — 实体、状态机、并发约束、持久化计划。
9. [roadmap.md](roadmap.md) — Phase 0-6 进入条件与回滚策略。
10. [test-matrix.md](test-matrix.md) — ART-xxx 测试矩阵。
11. [contributing.md](contributing.md) — 目录边界、checklist、ADR 触发条件、完成定义。
12. [adr/](adr/README.md) — 架构决策记录（0001-0008）。

## 阶段状态（截至 2026-07-25，分支 `codex/agent-runtime-phase2`）

| Phase | 内容 | 状态 |
| --- | --- | --- |
| 0 | 文档与契约冻结（本目录） | in-progress |
| 1 | Pi Worker + Driver facade 骨架 | in-progress |
| 2 | 旧接口实连（vcp_delegate / vcp_invoke）+ 双层审批 + Workbench MVP | in-progress |
| 3 | 持久化 / 重启恢复 / ToolBox 结构化 API | planned |
| 4 | Grok Build（ACP）与 Claude Agent SDK Driver | planned |
| 5 | 沙箱与 scoped token 强制 | planned |
| 6 | 多 Workspace / 分布式 / GA | planned |

详见 [roadmap.md](roadmap.md)。当前分支交付 Phase 0-2。

## 源码目录索引

> 标注 *(planned)* 的路径在本目录文档冻结时可能尚不存在；实现必须按此路径落位，不得另起目录（见 [contributing.md](contributing.md)）。

| 路径 | 进程 | 职责 |
| --- | --- | --- |
| `modules/agent-runtime/` *(planned)* | Main | AgentRuntimeManager、ApprovalBroker、事件归一化、session 注册表 |
| `modules/agent-runtime/drivers/` *(planned)* | Main | `AgentRuntimeDriver` facade 及 Pi/Grok/Claude driver 适配 |
| `agent-runtime/` *(planned)* | Pi Worker sidecar | 以 `ELECTRON_RUN_AS_NODE=1` 启动的独立 Node 进程入口、Worker↔Main 消息通道 |
| `modules/ipc/agentRuntimeHandlers.js` *(planned)* | Main | `agent-runtime:` 命名空间 IPC handler；通道须注册进 [ipcContracts.js](../../modules/ipc/ipcContracts.js) |
| `modules/ui-system/agent-workbench.js` *(planned)* | Renderer | Agent Workbench internal app（VCPUI），唯一面向用户的 agent 界面 |
| `preloads/` | Preload | 角色化 preload 中的 agent 段，只暴露窄 IPC 封装 |

## 稳定性等级定义

本文档中每个契约（接口、事件、通道、需求）标注以下等级之一：

| 等级 | 含义 | 变更规则 |
| --- | --- | --- |
| `stable` | 可对外依赖；破坏式变更必须升 `schemaVersion` 并走 ADR | 仅经 ADR |
| `provisional` | Phase 0-2 内可调整，但同分支内需文档与代码同步 | PR 内同步改文档 |
| `experimental` | 随时可变，不得被本目录之外的代码依赖 | 自由 |
| `legacy-frozen` | 旧接口既有行为，只描述不修改；新增能力不得建于其上 | 禁止变更 |

各事件、通道、需求的等级在其所属文档中逐一标注。

## 相关 ADR

全部架构决策见 [adr/README.md](adr/README.md)：0001 进程边界、0002 事件信封、0003 Driver 接口、0004 旧 VCP 工具桥、0005 capability 审批、0006 Session 权威、0007 Pi 版本锁定、0008 IPC 命名空间。
