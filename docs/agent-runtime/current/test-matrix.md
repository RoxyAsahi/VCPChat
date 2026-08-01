# 验收矩阵与收据

更新时间：2026-08-01。Codex App Server 功能 checkpoint 为 `29c2068a`。2026-07-31 的 live 项仍是
历史 working-tree 收据；没有在 checkpoint 后重跑的真实 ToolBox 场景不得升级为 `live verified`。

参考版本：Codex CLI `0.124.0`，Codex source `f0c30e528a54bdf0fa9a4d52ff74b34383434811`，ToolBox `324a659f`。正式路径不得依赖 ToolBox 的未提交 `protocolBridge` 改动。

## 当前授权的本机 live 测试档案

- ToolBox URL：`http://localhost:6005`
- 模型：`gpt-5.6-luna`
- Codex base instructions：`{{Nova}}`
- 本机测试 API Key：`123456`（仅用于该本地测试实例，不是生产凭据）
- 显式开关：`VCP_CODEX_LIVE=1`
- `FileOperator` 场景额外要求：VChat 的 `vcpServerUrl`/`vcpApiKey` 与测试环境一致，且 VChat DistributedServer 已启动、已向 ToolBox 注册 `FileOperator`。

运行时 API Key 仍只从本机进程环境 `VCP_TOOLBOX_API_KEY` 注入，不进入 SQLite、Renderer、诊断日志或打包产物。文档中的 `123456` 是用户明确授权公开记录的本地测试值，不得被表述为生产默认配置。

要在不改变日常 VChat 设置的情况下提供真实 `FileOperator`，先在一个独立终端启动本工作树的
DistributedServer；它使用该终端的配置，关闭终端或按 `Ctrl+C` 即停止：

```powershell
cd C:\VCP\vchat-develop\VCPChat-codex-agent
$env:VCP_SERVER_URL = 'http://localhost:6005'
$env:VCP_API_KEY = '<local test key>'
npm run start:codex-toolbox-live-node
```

开始本轮正式 live gate 前，必须先重启 ToolBox，使其进程从未修改的 `324a659f` 工作树代码加载；
不能复用此前加载过临时 `protocolBridge` 改动的进程。

待节点完成连接和工具注册后，在第二个终端运行 live gate：

```powershell
$env:VCP_CODEX_LIVE = '1'
$env:VCP_TOOLBOX_URL = 'http://localhost:6005'
$env:VCP_TOOLBOX_API_KEY = '<local test key>'
$env:VCP_CODEX_LIVE_MODEL = 'gpt-5.6-luna'
$env:VCP_CODEX_LIVE_BASE_INSTRUCTIONS = '{{Nova}}'
npm run test:codex-toolbox-live
```

## 当前门槛

| Gate | 模式 | 必须断言 | 当前状态 | 当前证据/缺口 |
|---|---|---|---|---|
| App Server transport | hermetic fake | JSONL、initialize、并发 waiter、server request、超时、exit cleanup | working-tree pass | `npm run test:codex-app-server-transport`；尚缺真实 crash/restart fixture。 |
| Projection SQLite | Electron ABI | migration、WAL、delta、generation-gated 权威 reconcile、orphan、事务恢复 | working-tree pass | `npm run test:codex-projection-store` 通过 Electron Node mode 执行；尚缺无 source offset 的重复 delta、复杂乱序和磁盘错误。 |
| Runtime Manager | hermetic fake | resume 不误建、Thread/Turn/fork/interrupt、approval/dynamic tool 分流、persona 迁移、ToolBox-only 工具面 | working-tree pass | 2026-07-31：`npm run test:codex-runtime-manager`；断言 `baseInstructions`、旧 placeholder 安全迁移、`environments=[]`、utility/MCP/web/collab 禁用与 `vcp_invoke` 保留。 |
| ToolBox bridge process | local process | release binary ready、frame、shutdown、无凭据泄漏 | working-tree pass | `npm run test:codex-toolbox-bridge`；不代表真实 ToolBox 调用通过。 |
| VChat Responses adapter | hermetic local HTTP + real App Server | loopback capability、Responses request → Chat request、模型可见工具精确过滤为 `[vcp_invoke]`、Chat tool call → Responses function call、function output 历史、SSE 参数聚合、真实 Codex 工具续接 | working-tree pass | 2026-07-31：`npm run test:codex-toolbox-responses-adapter` 与 `npm run test:codex-app-server-adapter-real`；后者从真实 Codex request 中观察到原生/MCP/utility definitions，并验证 adapter 转发给上游的集合恰好只剩 `vcp_invoke`，随后完成 function call → bridge response → continuation。 |
| Bridge endpoint/reconnect reuse | Rust + local bridge process fixture | URL normalization、log/info candidate、latency、退避、config reconnect、dispose、限长、jitter、replay 去重、TTL | working-tree pass | 2026-07-31：`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-vcp --features direct-host host::tests`、`cargo test --manifest-path rust/Cargo.toml -p vcp-toolbox-bridge`、`npm run test:codex-toolbox-bridge`、`npm run test:codex-runtime-manager`；真实 ToolBox WebSocket reconnect 仍 pending。 |
| VCP marker projection reuse | Node/Rust fixture | fold/info 的 display/history/notification 分离、嵌套/未闭合/CJK/HTML、SQLite roundtrip | planned | 受控移植 vcp-code `vcp-content.spec.ts`；输出必须是稳定 `AgentBlock[]`。 |
| TOOL_REQUEST safety | hermetic + Electron | marker 只产生 protocol-warning、正文净化、Bridge invoke 次数为 0、重开/重试也不执行 | planned | 产品阻塞 gate；任何 marker 执行路径均为失败。 |
| Codex native aggregate | hermetic | transport + projection + manager + bridge | working-tree pass | `npm run test:codex-native`。 |
| Agent presentation | JSDOM | Full Fork receipt、forbidden dependency=0、稳定 Block identity、主聊天 golden DOM、Tool/Approval/Observation/Error registry、stream/full 后处理、动作路由、animation-frame 合并 | working-tree pass | `npm run test:agent-presentation`，含 `test-agent-presentation-blocks.mjs`，并进入 `test:codex-stack`。原主聊天 renderer 三文件零 diff。 |
| Workbench store/controller | JSDOM | SQLite snapshot、keyed patch、多 Session state、草稿和路由 | working-tree pass | `npm run test:agent-workbench-store`。 |
| Workbench DOM | JSDOM | mount、消息/工具更新、审批、卸载清理 | working-tree pass | `npm run test:agent-workbench`；仍含 Rust 兼容 fixture。 |
| Workbench UX segmented diagnostics | manager + JSDOM | Agent click/cache/list、Runtime ready、Thread warm、Turn ACK、first Item/delta；无 prompt/key/path | working-tree pass | Main/Renderer 输出 `[agent-ux]` / `[Agent UX]` 的受限 timing 字段；`test:codex-runtime-manager` 与 `test:agent-workbench` 覆盖关键触发点。 |
| Agent Session catalog fast path | Main + JSDOM + Electron Node timing | legacy/canonical Agent identity 合并；cache hit 一帧；50 Session SQLite list P95 <= 150 ms；列表读取不启动 App Server | working-tree pass | `test:codex-runtime-manager` 覆盖 schema v3 迁移、零 transport start 和 30 次 P95；Workbench 使用 per-Agent cache/skeleton。 |
| Session Thread warm | manager + controller fixture + Electron smoke | 选中后 detached ensure/resume；发送复用同一 promise；重复请求不重复 resume；最多 2 个 idle warm Thread | working-tree pass | `test:codex-runtime-manager`、`test:agent-workbench-store`；新增 `ensure-session-runtime` 窄 IPC，Electron smoke 通过。 |
| Thinking/streaming visual parity | DOM golden + Electron shell smoke | 首帧 Agent 头像、名称、完整主聊天 skeleton、`.streaming` 流光、真实 Item keyed 接管、reduced-motion | working-tree pass; rich screenshot pending | `test:agent-message-presentation-api` 和 `test:agent-workbench`；手写 DOM 已删除。UX-R5 仍需真实富消息截图与 2px 门槛。 |
| Tool Activity visual parity | DOM lifecycle + Electron shell smoke | requested/running/completed/failed/cancelled keyed 更新；主聊天 VCP tool token；长参数折叠；资源/warning | working-tree pass; rich screenshot pending | `test:agent-presentation-blocks`、`test:agent-workbench`；根节点复用 VCP summary，详情复用 use/result class。真实资源截图归 UX-R5。 |
| Session UI state machine | pure reducer fixture | creating/streaming/native approval/VCP approval/user input/completed/interrupted/error/orphaned；A/B/C identity 隔离 | planned | 借鉴 vcp-code transition 机制；selected Session 不得决定事件归属。 |
| Observation center | Main + JSDOM | 200 条上限、未读游标、分类、去重、Session 切换保留、无 identity 时全局、原始大 JSON 不落库 | planned | 借鉴 vcp-code bounded ring；不复制 Capsule UI。 |
| Real Codex Thread | local App Server | 同一进程并发 start/read、Session/Thread identity 隔离、空 Thread 不误标 orphaned、空 Thread restart 安全重建 | working-tree pass | `npm run test:codex-app-server-real`；真实 fork/interrupt 仍缺自动测试。 |
| Electron Codex smoke | hermetic Electron | preload/IPC、Session/Thread 创建、projection-only SQLite read、Runtime identity、内部应用挂载、Fork/legacy 模式与主要 DOM | working-tree pass | 2026-07-31：`npm run test:electron-codex-smoke`；输出 `runtime=codex-app-server`、`presentationMode=fork`，本轮首发 thinking/model 改动未引入回归。该命令不替代真实 Nova/ToolBox 长任务验收。 |
| ToolBox model via adapter | explicit live Nova | 身份回答包含 Nova 且不含 Codex；随机 sentinel 通过 Codex -> VChat adapter -> ToolBox `/v1/chat/completions` -> Nova 回显；完成 Turn 后新 App Server 原 ID resume、fork、interrupt | working-tree live pass | 2026-07-31：`VCP_CODEX_LIVE=1 VCP_TOOLBOX_URL=http://127.0.0.1:6005 VCP_TOOLBOX_API_KEY=123456 VCP_CODEX_LIVE_MODEL=gpt-5.6-luna VCP_CODEX_LIVE_BASE_INSTRUCTIONS={{Nova}} npm run test:codex-nova-live`；VChat `d441675a` + dirty Codex working tree，Codex `f0c30e528a`，ToolBox `324a659f`。 |
| VCP dynamic tool via adapter | live Nova + VChat DistributedServer | `item/tool/call -> bridge -> /v1/human/tool -> FileOperator`，结构化结果 | pending | 旧 2026-07-31 probe 依赖 ToolBox `protocolBridge` 工作树改动；必须以未修改 ToolBox 和 VChat adapter 重跑。 |
| Native approval | real Codex | command/file approval 显示、allow/deny、close fail-closed | pending | fake manager 测试不能替代真实 Codex。 |
| ToolBox backend approval | live ToolBox | 独立 approval id、TTL/replay、只响应一次 | implemented, pending live | Rust/manager 基础闭环与 replay 去重单测已通过；真实 VCPLog 未执行。 |
| VCPInfo/VCPLog | live ToolBox | 限长、重连、去重、只读结构化卡片 | partial live | 2026-07-31：`VCP_CODEX_LIVE=1 npm run test:codex-toolbox-ws-live` 已验证未改 ToolBox 上的 VCPLog/VCPInfo 双 observer connect+shutdown；真实断线重连、replay 和通知 payload 仍未执行。 |
| UI parity/performance | Electron/manual | 主聊天视觉、长流、scroll anchor、10 Session 秒切 | partial working-tree pass | 1440×900/1024×720 深浅主题空 Session shell 截图已检查，无裁切/重叠；富消息截图、scroll trace 和性能收据仍缺。 |

## 2026-07-31 working-tree 运行记录

```text
npm run test:codex-native            PASS
npm run test:codex-stack             PASS
npm run test:codex-app-server-real   PASS
npm run test:codex-app-server-adapter-real PASS
npm run check:agent-runtime          PASS
npm run check:ui-system              PASS
npm run check:rust-quality           PASS
npm run test:codex-toolbox-responses-adapter PASS (hermetic local HTTP)
npm run test:codex-toolbox-ws-live    PASS (explicit live VCPLog/VCPInfo connect+shutdown; no reconnect/replay)
npm run test:codex-nova-live          PASS (live Nova identity + sentinel + restart/resume + fork + interrupt)
npm run test:codex-toolbox-live       HISTORICAL ONLY (old ToolBox /v1/responses path)
npm run test:electron-codex-smoke     PASS (runtime=codex-app-server, presentationMode=fork)
```

模式：Windows x64，Electron `41.7.1` / Electron Node mode、Codex CLI `0.124.0`、临时 Projection SQLite、本地 release bridge process。`test:codex-nova-live` 已通过 VChat loopback adapter 连接真实本机 Nova/VCPToolBox；动态 FileOperator live gate 仍需 VChat DistributedServer。

关键断言：

- JSONL request/server-request 分流与 waiter 清理；
- Session resume 不重复建 Thread；同一 App Server 可并发创建并对账两个不同 Thread；
- SQLite delta、reasoning ordinal、权威 reconcile 删除幽灵 Item；
- 原生 Codex approval 与 ToolBox approval ID 分离；
- VCPInfo 进入 Renderer 前分类、限长和敏感键脱敏；
- ToolBox approval replay 在 bridge 内只投影一次；超长 bridge 控制帧返回错误并以非零退出码 fail-closed；
- 真实 Electron preload/IPC 创建 VChat Session 和 Codex Thread，projection-only read 不把空 Thread 误标 orphaned。
- VChat adapter fixture 保留 function-call 与 function-call-output 历史；真实 Nova 身份/文本链已另行通过，仍不能替代 DistributedServer 动态工具验收。

该记录中的 hermetic/local 实现已进入 `29c2068a`；Nova 身份/文本链仍只保留为 2026-07-31
working-tree live pass。整个产品不能标记 live verified，因为动态工具、并发、取消与审批门槛未全部完成。

## 2026-08-01 checkpoint 收据

功能 revision：`29c2068a`（`feat(agent): integrate Codex App Server workbench`）。提交前对完全相同的
暂存内容执行并通过：

```text
npm run test:codex-stack
npm run test:codex-app-server-real
npm run test:codex-app-server-adapter-real
npm run test:electron-codex-smoke
npm run check:agent-runtime
npm run check:ui-system
git diff --cached --check
```

该收据将 transport、Projection、Runtime Manager、Responses adapter、Bridge process、Presentation、
Workbench 与 Electron shell 提升为 checkpoint pass。它不覆盖真实 `FileOperator`、双 streaming Thread、
真实审批、富消息视觉或 ToolBox replay/reconnect。

## 正式收据模板

```text
Gate:
Status: verified | live verified
Command:
Mode/platform:
Date:
VChat commit:
Codex CLI/source revision:
ToolBox revision:
Dirty worktree: no
Assertions:
Artifacts/logs:
Known residual risk:
```

任何测试若只断言“响应非空”“进程未崩溃”或“页面能打开”，不得作为产品 gate。

## 外部复用收据

R4.1、R4.2、R5.1、R5.3 的 gate 除测试通过外，还必须记录：来源文件和 revision、采用方式、与上游差异、被删除的危险能力、License/NOTICE 处理和未复用部分的理由。缺少任一项时只能标记 `implemented`，不能标记 `verified`。
