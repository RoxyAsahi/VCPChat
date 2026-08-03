# Codex Agent Runtime 当前真源

本目录描述 `codex/vcpchat-codex-app-server` 分支的唯一正式目标路径。当前产品状态为 **experimental**。在 Nova、VCPToolBox、并发 Thread、审批、取消和 Electron Workbench 的 live gate 全部通过前，不标记产品可用。

## 当前结论

路线没有偏离“GUI 接入黑盒 Agent Runtime”：

```text
VChat Workbench
  -> Electron Main
     -> codex app-server                 执行、上下文、Turn、恢复权威
     -> codex-agent-projection.sqlite    完整、持久的 UI 展示投影
     -> loopback Responses adapter       VChat-owned Responses <-> Chat 兼容层
     -> vcp-toolbox-bridge.exe           VCPToolBox 协议适配
        -> /v1/human/tool
        -> /v1/interrupt
        -> VCPLog / VCPInfo / backend approval
```

VChat 不 fork、不 vendor Codex，也不读取或修改 Codex rollout。旧 Rust daemon、Rust Topic、Pi、`vcp_delegate`、SQLite Runtime Repository 和多 Driver 仅保留在 `../history/rust/` 与 `../history/pi/`，不在本分支恢复或迁移。

## Codex 0.146.0 升级基线

当前项目内 Runtime 精确固定为 `@openai/codex@0.146.0`，对应 release tag
`rust-v0.146.0`、source revision `e363b08c9175ac1cbe5893615dd2cb9ddf95043b`。开发环境优先解析
`node_modules/.bin/codex.cmd`，因此本机全局仍安装的 `0.124.0` 不参与本分支测试，也暂不升级。

`npm run sync:codex-schema` 生成 stable/experimental JSON 与 TypeScript schema；
`npm run check:codex-schema` 校验 npm integrity、release revision 和 canonical tree hash。固定 manifest 位于
`fixtures/codex-app-server/0.146.0/manifest.json`。当前 0.146.0 的本机 App Server start/read/restart 与
真实 adapter dynamic-tool continuation 已通过。2026-08-01 已使用 `deepseek-v4-flash` 重跑 Nova identity、
sentinel、reasoning projection、restart/resume、fork、interrupt、FileOperator 与双 Thread cancel isolation；
ToolBox backend approval 和富消息 Electron live gate 仍待，因此产品状态仍为 experimental。

## 截止 2026-08-01 的完成度

| 区域 | 当前状态 | 说明 |
|---|---|---|
| R0 分支与基线 | 已完成 | Rust R3-M 位于 `d441675a`；Codex App Server 首个功能 checkpoint 为 `29c2068a`；旧文档已归档。 |
| App Server transport | 0.146 working-tree pass | JSONL、initialize、waiter、server request、退出清理已有测试；项目内 `codex-cli 0.146.0` 已真实完成 Thread start/read/restart。 |
| Projection SQLite | checkpoint pass | WAL、迁移、Session/Message/Block、delta、权威 reconcile 清理、orphan 基础路径已有测试；SQLite 测试与产品统一使用 Electron ABI。 |
| Runtime Manager | 0.146 deepseek live pass | Agent `systemPrompt -> baseInstructions`、旧 placeholder 快照安全迁移、Thread start/read/fork、Turn start/steer/interrupt 与 resume 已接线；`deepseek-v4-flash` 的 Nova identity、reasoning、恢复、fork 和 interrupt 已真实通过。 |
| ToolBox bridge 进程 | checkpoint pass | Rust bridge 可构建、ready、bounded JSONL、shutdown；`/v1/human/tool`、interrupt、VCPLog/VCPInfo 观察代码路径存在。 |
| Workbench 兼容接线 | checkpoint pass，仍在迁移 | SQLite snapshot、keyed delta、Full Fork Message 与结构化 Block 已进入 `29c2068a`；仍有 Rust Topic 兼容文案和完整 Electron 富消息流程需要清理。 |
| ToolBox backend approval | implemented，未 live 验证 | Bridge 已有独立 approval ID、TTL、replay 去重、双向响应和关闭 fail-closed；尚未连接真实 ToolBox 验证补发与恰好一次响应。 |
| VCPInfo/VCPLog 展示 | implemented，未 live 验证 | 单连接观察、类型分类、限长脱敏和 Workbench 全局卡片已接线；尚缺真实通知、重连和完整内容净化验收。 |
| VChat Responses adapter | 0.146 real hermetic pass | 兼容 0.146 的 developer instruction 与 `additional_tools` wire shape；只从 VChat Session 冻结快照注入唯一 system identity，并在最终 provider 边界只暴露 `[vcp_invoke]`。真实 App Server 的 tool call、bridge continuation、reasoning 与 SQLite 投影已通过；0.146 Nova live 仍待。 |
| Nova / VCP dynamic tool | 0.146 deepseek live pass | 未修改 ToolBox；Nova identity/sentinel/reasoning、DistributedServer `FileOperator`、双 Thread 并发与取消隔离均通过。backend approval replay/deny 仍待。 |
| Electron Codex smoke | checkpoint pass | preload/IPC、Session/Thread、projection-only read、Runtime identity 与默认 Fork renderer 已通过。 |
| 产品可用 | 否 | live gate 未通过。 |

`npm run test:codex-nova-live` 与 `npm run test:codex-toolbox-live` 均是显式 live gate；它们必须设置 `VCP_CODEX_LIVE=1`、`VCP_TOOLBOX_URL` 和 `VCP_TOOLBOX_API_KEY`，默认 CI 不执行。后者还要求 VChat 的 DistributedServer 已连接 ToolBox 并注册 `FileOperator`；仅 ToolBox 本机插件不能替代这条分布式能力链路。

## 文档导航

- [architecture.md](architecture.md)：进程、数据权威、并发与安全边界。
- [identity-and-tool-surface.md](identity-and-tool-surface.md)：Nova 身份替换、旧 Session 迁移、ToolBox-only 工具 allowlist 与真实收据。
- [app-server-protocol.md](app-server-protocol.md)：JSONL 生命周期、Thread/Turn/Item、审批和动态工具。
- [projection-store.md](projection-store.md)：SQLite schema、事务、delta、对账和 orphan 恢复。
- [toolbox-bridge.md](toolbox-bridge.md)：Nova、`vcp_invoke`、interrupt、VCPLog/VCPInfo。
- [agent-workbench.md](agent-workbench.md)：Session 切换、Message/Block、动作与主聊天复用边界。
- [agent-settings-and-composer.md](agent-settings-and-composer.md)：R11 的 Profile/Session/Advanced 设置、指令来源、reasoning capability 与 Session Composer 状态机。
- [data-governance.md](data-governance.md)：R12 的 Profile/Session schema、desired/applied 配置、附件 capability 与事件去重边界。
- [gui-capability-roadmap.md](gui-capability-roadmap.md)：Codex GUI-R0–R6 的导航、Composer、时间线、审批、Inspector 与真实验收路线。
- [workspace-browser-plan.md](workspace-browser-plan.md)：P0 只读 Workspace 文件树/预览与工具、Diff、附件统一路径动作的 WB-R0–R5 计划。
- [workbench-experience-roadmap.md](workbench-experience-roadmap.md)：Session 目录、Runtime/Thread 预热、主聊天同构 loading/streaming 与工具卡收口路线图。
- [reuse-register.md](reuse-register.md)：外部项目可复用模块、采用方式、许可证和禁止边界。
- [gui-reuse-implementation-plan.md](gui-reuse-implementation-plan.md)：OpenCode、CodexMonitor、DeepChat、Harnss 等候选的具体文件映射、当前完成度和施工顺序。
- [delivery-plan.md](delivery-plan.md)：按依赖顺序拆分的长期施工计划。
- [test-matrix.md](test-matrix.md)：门槛、当前证据、缺口与验证收据。
- [reliability-roadmap.md](reliability-roadmap.md)：R7-R10 配置、Runtime、Projection、隐私与治理合同。
- [ADR-007](adr/ADR-007-codex-sqlite-saga.md)：Codex/SQLite Saga 与 uncertain 边界。
- [ADR-008](adr/ADR-008-agent-renderer-independence.md)：Agent Renderer 独立演进与模块拆分边界。
- [ADR-009](adr/ADR-009-agent-config-desired-applied.md)：Session desired/applied 配置分离与发送 barrier。

Workbench 当前已完成 SQLite 快路径、canonical Agent identity、Thread warm、Full Fork Message renderer、首发 thinking/streaming 骨架与基础 Block registry。下一阶段不重复 UX-R0–R4，而按 GUI-R0–R6 补齐协议能力矩阵、Session 状态机、完整 Composer、规范 Block、审批/交互中心、Inspector 和真实视觉性能门槛。当前正式执行 profile 仍只有 `toolbox-only`；App Server 支持但 VChat 未启用的能力不得直接暴露为 GUI 开关。

## 状态词规则

- `implemented`：代码路径存在，但不代表测试或真实环境可用。
- `hermetic pass`：本地 fake/mock/临时数据库测试通过，不连接真实 ToolBox。
- `working-tree pass`：测试在未提交工作树通过，只能作为施工证据，不能作为版本收据。
- `checkpoint pass`：测试对应一个已提交 revision，但仍可能只是 hermetic/local gate，不等于 live verified。
- `verified`：完整收据齐全且对应已提交 VChat revision。
- `live verified`：连接真实 Codex、Nova 和 ToolBox 后通过不可替代断言。
- `product ready`：所有阻塞 gate 均为 `live verified`，且无 P0/P1 未关闭。

## 验证收据规则

每条 `verified` 或 `live verified` 必须记录：

1. 精确命令；
2. 运行模式和依赖；
3. 日期与平台；
4. VChat commit；
5. Codex 版本和源码 revision；
6. ToolBox revision；
7. 关键断言与产物位置；
8. 是否包含未提交改动。

缺少任意字段时，只能记录为 probe、working-tree pass 或 experimental。

## 复用优先规则

开始实现 parser、WebSocket 重连、Session UI 状态机、通知中心或测试 harness 前，必须先检查 `reuse-register.md`。登记为“直接受控导入”或“最小抽取”的能力不得无理由重新实现；若决定不复用，必须在变更说明中记录不兼容证据。
