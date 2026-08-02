# 验收矩阵与收据

更新时间：2026-08-01。Codex App Server 功能 checkpoint 为 `29c2068a`。2026-07-31 的 live 项仍是
历史 working-tree 收据；没有在 checkpoint 后重跑的真实 ToolBox 场景不得升级为 `live verified`。

当前迁移目标：项目内 Codex CLI `0.146.0`，release tag `rust-v0.146.0`，source
`e363b08c9175ac1cbe5893615dd2cb9ddf95043b`；全局 `0.124.0` 保持不变且不作为测试 executable。
ToolBox 参考 revision 为 `324a659f`，正式路径不得依赖 ToolBox 的未提交 `protocolBridge` 改动。

## 当前授权的本机 live 测试档案

- ToolBox URL：`http://localhost:6005`
- 模型：`deepseek-v4-flash`
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
$env:VCP_CODEX_LIVE_MODEL = 'deepseek-v4-flash'
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
| VChat Responses adapter | hermetic local HTTP + real 0.146 App Server | loopback capability、Thread-bound frozen identity、0.146 developer/`additional_tools` 净化、唯一 `requestId`、断开时同 ID `/v1/interrupt`、模型工具精确为 `[vcp_invoke]`、tool continuation、reasoning 与 SQLite projection | working-tree pass | 2026-08-01：`npm run test:codex-toolbox-responses-adapter`、`npm run test:codex-app-server-adapter-real`。真实 0.146 request 顶层 dynamic tools 为空时由最终 allowlist 边界补出 `vcp_invoke`；Codex 随后仍产生原生 `item/tool/call` 并完成 continuation。Nova/双 Thread live 尚未重跑。 |
| Bridge endpoint/reconnect reuse | Rust + local bridge process fixture | URL normalization、log/info candidate、latency、退避、config reconnect、dispose、限长、jitter、replay 去重、TTL | working-tree pass | 2026-07-31：`cargo test --manifest-path rust/Cargo.toml -p vcp-agent-vcp --features direct-host host::tests`、`cargo test --manifest-path rust/Cargo.toml -p vcp-toolbox-bridge`、`npm run test:codex-toolbox-bridge`、`npm run test:codex-runtime-manager`；真实 ToolBox WebSocket reconnect 仍 pending。 |
| VCP marker projection reuse | Node + Projection SQLite | fold/info 的 display/history/notification 分离、未闭合/CJK/HTML、SQLite roundtrip | working-tree pass | 2026-08-01：`npm run test:vcp-content-projection`、`npm run test:codex-projection-store`。嵌套 marker 与 Electron 卡片视觉 gate 仍待。 |
| TOOL_REQUEST safety | hermetic + Electron | marker 只产生 protocol-warning、正文净化、Bridge invoke 次数为 0、重开/重试也不执行 | partial / working-tree pass | 当前 parser 不具备任何执行出口，`test:vcp-content-projection` 断言工具名不进入普通正文。仍缺 Bridge invoke=0、重开/重试和 Electron gate，产品阻塞未解除。 |
| Codex native aggregate | hermetic | transport + projection + manager + bridge | working-tree pass | `npm run test:codex-native`。 |
| Agent presentation | JSDOM | Full Fork receipt、forbidden dependency=0、稳定 Block identity、主聊天 golden DOM、Tool/Approval/Observation/Error registry、stream/full 后处理、动作路由、animation-frame 合并 | working-tree pass | `npm run test:agent-presentation`，含 `test-agent-presentation-blocks.mjs`，并进入 `test:codex-stack`。原主聊天 renderer 三文件零 diff。 |
| Workbench store/controller | JSDOM | SQLite snapshot、keyed patch、多 Session state、草稿和路由 | working-tree pass | `npm run test:agent-workbench-store`。 |
| Workbench DOM | JSDOM | mount、消息/工具更新、审批、卸载清理 | working-tree pass | `npm run test:agent-workbench`；仍含 Rust 兼容 fixture。 |
| Workspace browser/path actions | Node + JSDOM + Electron | Session-bound root、traversal/absolute/UNC/symlink 防护、lazy tree、搜索、预览、稳定 revision、10k 文件分页/搜索、tree/tool/diff/attachment 统一动作 | committed hermetic pass | 2026-08-02：`npm run test:agent-workspace-service`、`npm run test:agent-workspace-model`、`npm run test:agent-workbench`、`npm run test:electron-codex-smoke`、`npm run check:agent-runtime`、`npm run check:ui-system`。Electron 真实读取当前 workspace `package.json`；人工截图、真实交互性能录制和 ToolBox resource path pending。 |
| Workbench UX segmented diagnostics | manager + JSDOM | Agent click/cache/list、Runtime ready、Thread warm、Turn ACK、first Item/delta；无 prompt/key/path | working-tree pass | Main/Renderer 输出 `[agent-ux]` / `[Agent UX]` 的受限 timing 字段；`test:codex-runtime-manager` 与 `test:agent-workbench` 覆盖关键触发点。 |
| Agent Session catalog fast path | Main + JSDOM + Electron Node timing | legacy/canonical Agent identity 合并；cache hit 一帧；50 Session SQLite list P95 <= 150 ms；列表读取不启动 App Server | working-tree pass | `test:codex-runtime-manager` 覆盖 schema v3 迁移、零 transport start 和 30 次 P95；Workbench 使用 per-Agent cache/skeleton。 |
| Session Thread warm | manager + controller fixture + Electron smoke | 选中后 detached ensure/resume；发送复用同一 promise；重复请求不重复 resume；最多 2 个 idle warm Thread | working-tree pass | `test:codex-runtime-manager`、`test:agent-workbench-store`；新增 `ensure-session-runtime` 窄 IPC，Electron smoke 通过。 |
| Thinking/streaming visual parity | DOM golden + Electron shell smoke | 首帧 Agent 头像、名称、完整主聊天 skeleton、`.streaming` 流光、真实 Item keyed 接管、reduced-motion | working-tree pass; rich screenshot pending | `test:agent-message-presentation-api` 和 `test:agent-workbench`；手写 DOM 已删除。UX-R5 仍需真实富消息截图与 2px 门槛。 |
| Tool Activity visual parity | DOM lifecycle + Electron shell smoke | requested/running/completed/failed/cancelled keyed 更新；主聊天 VCP tool token；长参数折叠；资源/warning | working-tree pass; rich screenshot pending | `test:agent-presentation-blocks`、`test:agent-workbench`；根节点复用 VCP summary，详情复用 use/result class。真实资源截图归 UX-R5。 |
| Codex schema compatibility | generated JSON/TypeScript fixture + transport | 固定 `0.146.0` Method/Notification/Item/Server Request；stable/experimental/unsupported；integrity/tree hash；capability mismatch fail-closed | working-tree pass | `npm run sync:codex-schema`、`npm run check:codex-schema`、`npm run test:codex-app-server-capabilities`、`npm run test:codex-app-server-transport`。stable/experimental JSON tree hash 分别为 `6283c8d6...` / `c1492848...`。 |
| Codex interaction fixture port | hermetic transport/manager | requestUserInput、permission、compact、interrupt、过期/重复 server request | partial / fail-closed | GUI-R0 已将未支持 interaction 固定拒绝；其余正式 interaction 仍待 GUI-R4，继续以 openclaw/CodexMonitor fixture 扩大覆盖。 |
| Session UI state machine | pure reducer fixture | creating/streaming/native approval/VCP approval/user input/completed/interrupted/error/orphaned；A/B/C identity 隔离 | working-tree pass | 2026-08-01：`npm run test:agent-session-state`；unread、reconnect 和 scroll anchor 仍待 GUI-R1 收尾。 |
| Session archive/pin/restore | Projection + JSDOM + Electron | 搜索、重命名、置顶、归档、删除、恢复；Thread 不误删；草稿/附件/scroll 按 Session 隔离 | partial / working-tree pass | archive、restore、pin、IPC/preload 已由 projection/runtime/session-state 测试覆盖；delete、完整列表 UI 与 Electron gate 仍待。 |
| Composer capability | manager + JSDOM + Electron | send/stop/steer/follow-up/queue；模型/reasoning/workspace/权限；冷启动草稿与附件不丢；重复提交去重 | partial / working-tree pass | `test:codex-runtime-manager` 覆盖 submit idempotency、steer 与持久文本 follow-up queue；附件 queue 明确拒绝，完整 UI/cold-start gate 仍待。 |
| Frozen-tail streaming | pure function + JSDOM + projection store | cumulative/incremental delta 不重复；stable head DOM 不替换；长流无 O(N²) 回退 | partial / working-tree pass | 2026-08-01：`npm run test:agent-presentation`（含 `test:agent-markdown-stream`）和 `npm run test:codex-projection-store`；长流 trace/worker gate 仍待。 |
| Server interaction requests | transport + manager + Workbench | requestUserInput、permissions、MCP elicitation 按 source + request ID 路由；exactly-once；关闭/crash/超时 fail-closed | hermetic working-tree pass | 2026-08-01：`test:codex-interaction-registry`、`test:codex-runtime-manager`、`test:agent-workbench` 覆盖多问题/secret、精确权限、MCP typed/URL 显式打开、重复/replay、超时和 namespace 隔离。真实 live gate 待 GUI-R4。 |
| Plan/Diff/Usage/Compaction | Projection + manager + Workbench | 专用 Block/Inspector；usage 来源标识；compact started/completed/failed；不显示原始 JSON | partial / working-tree pass | 2026-08-01：`test:codex-runtime-manager` 断言 compact ACK 不 resolve，等待 terminal `contextCompaction` 后 `thread/read` 对账；Plan/只读 Diff Inspector 与 usage `real/estimated/unknown` 标识已接线，compaction 专用视觉仍待。 |
| File-change diff model | pure Node + Projection SQLite | 仅 Codex `fileChange.changes`；路径/状态/patch/增删统计；16 文件/128 KiB 上限；不执行 patch | data model working-tree pass / toolbox-only UI hidden | `npm run test:codex-diff-model`、`npm run test:codex-projection-store`。真实 FileOperator WriteFile 只产生 dynamicToolCall，mutation receipt 完成前隐藏 Changes。 |
| Diff dependency size gate | package/release build | 记录 `@pierre/diffs` 及传递依赖的安装体积、asar/installer 增量、启动影响 | deferred | 当前 `1.3.1` unpacked 约 6.9 MiB；当前纯数据模型不依赖它；只有需要高级视觉 diff 时才执行 gate。 |
| Observation center | Main + JSDOM | 200 条上限、未读游标、分类、去重、Session 切换保留、无 identity 时全局、原始大 JSON 不落库 | planned | 借鉴 vcp-code bounded ring，并按需抽取 Harnss notifications fixture；不复制 Capsule UI。 |
| Real Codex Thread | project-pinned 0.146 App Server | 同一进程并发 start/read、Session/Thread identity 隔离、空 Thread 不误标 orphaned、空 Thread restart 安全重建 | working-tree pass | `npm run test:codex-app-server-real` 使用 `node_modules/.bin/codex.cmd` 0.146.0；真实 fork/interrupt 仍缺自动测试。 |
| Electron Codex smoke | hermetic Electron | preload/IPC、Session/Thread 创建、projection-only SQLite read、Runtime identity、Workspace list/preview、内部应用注册/挂载、Fork/legacy 模式与主要 DOM | working-tree pass | 2026-08-02：`npm run test:electron-codex-smoke` 通过；真实 Main/preload IPC 列出 Session workspace 并读取 `package.json` 预览。该命令不替代真实 Nova/ToolBox 长任务验收。 |
| ToolBox model via adapter | explicit live Nova | 身份回答包含 Nova 且不含 Codex；随机 sentinel；公开 reasoning 持久投影；restart/resume、fork、interrupt | 0.146 working-tree live pass | 2026-08-01：`VCP_CODEX_LIVE=1 VCP_TOOLBOX_URL=http://localhost:6005 VCP_TOOLBOX_API_KEY=123456 VCP_CODEX_LIVE_MODEL=deepseek-v4-flash VCP_CODEX_LIVE_BASE_INSTRUCTIONS={{Nova}} VCP_CODEX_LIVE_EXPECT_REASONING=1 VCP_CODEX_LIVE_TURN_TIMEOUT_MS=300000 npm run test:codex-nova-live`，耗时 49.3 s；全部断言通过。取消测试先等待同一 Turn 的真实 `turn/started`，不再把 RPC ACK 当 running。VChat HEAD `a3762a97` dirty；Codex `0.146.0` / `e363b08c...`；ToolBox HEAD `024f8780` 有用户既有未提交配置/UI 改动，本次未修改 ToolBox。 |
| VCP dynamic tool via adapter | live Nova + VChat DistributedServer | `item/tool/call -> bridge -> /v1/human/tool -> FileOperator`，结构化结果与 Projection | 0.146 working-tree live pass | 2026-08-01：同一配置下运行 `npm run test:codex-toolbox-live`，耗时 37 s；`deepseek-v4-flash` 的 FileOperator ReadFile、dynamicCall、bridgeCompleted 和 projection 全部通过。 |
| Concurrent Nova Thread + cancel isolation | explicit live Nova | 同一 App Server PID；A/B 均收到 `turn/started`；中断 A；A=`interrupted`、B=`completed`；两个 SQLite projection 不串线 | 0.146 working-tree live pass | 2026-08-01：`VCP_CODEX_LIVE_MODEL=deepseek-v4-flash VCP_CODEX_LIVE_TURN_TIMEOUT_MS=300000 npm run test:codex-concurrent-live`，耗时 25.8 s；PID 恒定，cancel isolation 与 projection isolation 均通过。 |
| Native approval | real Codex | command/file approval 显示、allow/deny、close fail-closed | pending | fake manager 测试不能替代真实 Codex。 |
| ToolBox backend approval | live ToolBox | 独立 approval id、TTL/replay、只响应一次 | implemented, pending live | Rust/manager 基础闭环与 replay 去重单测已通过；真实 VCPLog 未执行。 |
| VCPInfo/VCPLog | live ToolBox | 限长、重连、去重、只读结构化卡片 | partial live | 2026-08-01：Codex 0.146 工作树运行 `VCP_CODEX_LIVE=1 npm run test:codex-toolbox-ws-live`，VCPLog/VCPInfo 双 observer connect+clean shutdown 通过；真实断线重连、replay、approval payload 和通知内容仍未执行。 |
| UI parity/performance | Electron/manual | 主聊天视觉、长流、scroll anchor、10 Session 秒切 | partial working-tree pass | 1440×900/1024×720 深浅主题空 Session shell 截图已检查，无裁切/重叠；富消息截图、scroll trace 和性能收据仍缺。 |
| Rich Electron GUI gate | Electron screenshot + trace + live runtime | 深浅主题富消息、diff、审批、工具、资源；10 Agent/50 Session；scroll anchor <= 2 px；cold/warm latency；双 streaming Thread | planned | GUI-R6；空 Session shell smoke 不能替代。 |

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
- SQLite delta、reasoning ordinal，以及不会因稀疏 `thread/read` 静默删除事件捕获展示 Item 的非破坏性 reconcile；
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

### 2026-08-01 GUI-R0 至 GUI-R2 working-tree 收据

```text
npm run test:codex-app-server-capabilities  PASS
npm run test:codex-app-server-transport     PASS
npm run test:agent-session-state             PASS
npm run test:codex-projection-store          PASS
npm run test:codex-runtime-manager           PASS
```

模式：Windows x64，Node/Electron Node test harness，Codex capability fixture `0.124.x`。本次收据覆盖
capability version gate、受限 profile 的 fail-closed 交互、完整 identity 的 Session UI reducer、archive/restore/pin
持久模型、Main-side submit 幂等以及纯文本 follow-up 持久队列。工作树仍有未提交变更，且未运行真实 ToolBox，
因此状态只能是 `working-tree pass`，不是 `verified` 或 `live verified`。

### 2026-08-01 GUI reuse audit working-tree 收据

```text
npm run test:codex-stack  PASS
git diff --check           PASS
```

该次聚合 gate 实际覆盖 App Server transport、interaction registry、file-change diff model、Projection SQLite、
Runtime Manager、ToolBox bridge/Responses adapter、Agent presentation（含 frozen-tail Markdown）以及 Workbench。
它确认 GUI-R3 的 streaming 内核、GUI-R4 的 interaction identity 内核与 GUI-R5 的 compaction/diff 数据内核仍可运行；
并不证明 Interaction Center/Inspector UI、真实 FileOperator、真实审批、VCP marker 投影、富消息视觉或性能门槛完成。
运行树仍为 dirty，不得将本条收据升级为 clean commit 或产品 live verified。

### 2026-08-01 reasoning 持久恢复 working-tree 收据

```text
npm run test:codex-projection-store  PASS
npm run test:agent-workbench-store   PASS
npm run test:agent-presentation      PASS
npm run test:agent-workbench         PASS
npm run test:codex-runtime-manager   PASS
npm run test:codex-stack             PASS
npm run test:electron-codex-smoke    PASS
git diff --check                     PASS
```

模式：Windows x64，Projection SQLite close/reopen、JSDOM Full Fork Workbench、Electron Codex hermetic smoke。
断言覆盖空 completed reasoning 不覆盖流式内容、稀疏 `thread/read` 不删除 reasoning/tool 展示 Item、SQLite-first
冷挂载恢复折叠思维链和结构化工具卡、鼠标/Enter 展开折叠、当前 `projection.updated` 实时路径，以及全局
VCPLog/VCPInfo “仅本次运行”提示。Electron smoke 确认 `presentationMode=fork`。

本收据仍是 dirty working-tree hermetic pass；尚未完成真实 Nova reasoning + ToolBox 工具任务的关闭重开截图，
不得据此标记 live verified 或产品完成。

### 2026-08-01 reasoning adapter working-tree 收据

```text
npm run test:codex-toolbox-responses-adapter  PASS
npm run test:codex-app-server-adapter-real    PASS
npm run test:codex-runtime-manager            PASS
npm run test:codex-projection-store           PASS
npm run test:agent-workbench                  PASS
```

模式：Windows x64，真实 Codex App Server `0.124.x` + VChat mock Chat provider，不连接或修改 ToolBox。
断言覆盖流式 `reasoning_content`/字符串 `reasoning`、非流式 reasoning、稳定 output index、reasoning token usage、
无 reasoning 不生成空 Item、App Server `item/reasoning/textDelta`、Projection SQLite 和 Workbench 展开恢复。

### 2026-08-01 `deepseek-v4-flash` live reasoning working-tree 收据

```text
$env:VCP_CODEX_LIVE='1'
$env:VCP_TOOLBOX_URL='http://127.0.0.1:6005'
$env:VCP_TOOLBOX_API_KEY='123456'
$env:VCP_CODEX_LIVE_MODEL='deepseek-v4-flash'
$env:VCP_CODEX_LIVE_BASE_INSTRUCTIONS='{{Nova}}'
$env:VCP_CODEX_LIVE_EXPECT_REASONING='1'
$env:VCP_CODEX_LIVE_TURN_TIMEOUT_MS='240000'
npm run test:codex-nova-live              PASS
```

模式：Windows x64，真实 Codex App Server + 本机 ToolBox Chat provider。真实 rollout 中存在两个
`type: "reasoning"` 的 response Item，公开 `reasoning_text` 已进入 Codex history 和 VChat durable
Projection；live gate 同时断言 SQLite 投影中存在非空 reasoning Block。上游 usage 没有将其单独归类，
因此 `reasoning_output_tokens` 诚实保持 `0`，VChat 不从普通 output tokens 推断或伪造 reasoning usage。

该收据仍是 dirty working-tree live pass。尚缺 Electron 中关闭并重开 Workbench 后的展开、头像、顺序和
视觉截图证据，因此真实 reasoning 数据链已通过，但仍不能标记整个 Workbench 为产品级完成。

### 2026-08-01 R4.2 Activity / Interaction hermetic 收据

```text
npm run test:codex-app-server-capabilities  PASS
npm run test:codex-interaction-registry     PASS
npm run test:codex-projection-store         PASS
npm run test:codex-runtime-manager          PASS
npm run test:agent-workbench-store          PASS
npm run test:agent-workbench                PASS
npm run test:codex-stack                    PASS
npm run test:electron-codex-smoke           PASS
npm run check:ui-system                     PASS
git diff --check                            PASS
```

模式：Windows x64，Codex `0.124.x` capability fixture、Main Runtime fake、Projection SQLite schema
5 -> 6 migration、JSDOM Workbench 和 hermetic Electron。断言覆盖 source-namespaced exactly-once、
requestUserInput 多问题/其他/secret password、精确 permission profile、MCP typed/URL 显式打开、分 Tab
未读、搜索/筛选基础、Plan/usage/compaction 冷恢复，以及 Codex App Server / Projection SQLite /
VCPToolBox Bridge 三层连接投影。

该收据来自 dirty working tree，只能标记 hermetic working-tree pass。真实 Codex permission/MCP 请求、
ToolBox backend approval、关闭/crash 可视交互、富内容截图与 Activity 长流性能仍为 experimental。

### 2026-08-01 R4.3 OpenCode 式 Inspector hermetic 收据

```text
npm run test:agent-workbench-store  PASS
npm run test:agent-workbench        PASS
npm run check:ui-system             PASS
npm run test:electron-codex-smoke   PASS
```

模式：Windows x64，JSDOM Workbench 与 hermetic Electron，Agent Full Fork presentation。断言覆盖 header
Context 水位环、Inspector/Activity 两组 Tab、cache write token、usage provenance、budget 仅位于 Settings、
Context tab panel DOM identity、独立滚动位置，以及从 header ring 打开右侧面板。视觉产物覆盖 1440x900 与
1024x720 深浅主题；紧凑桌面面板上限随后收敛为 380px。

该收据仍来自 dirty working tree。Session 生命周期通知持久索引、severity unseen、点击跳转、Plan dock、
Diff 文件导航、非交互卡 keyed patch 和真实长流性能未完成，因此只能标记 working-tree hermetic pass。

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
