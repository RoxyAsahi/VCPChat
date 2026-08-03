# Codex Agent Runtime 交付计划

状态：**experimental / active development**。本计划按依赖顺序施工，后续阶段不能掩盖前一阶段未通过的退出门槛。

标记：`[x]` 已实现且有当前证据；`[~]` 部分实现或仅 working-tree pass；`[ ]` 未完成。

## R11：Agent 设置体系与 Composer 融合

- [x] `AgentProfile`/`SessionConfigSnapshot` 已加入指令模式、两类指令字段、personality 与 capability-backed reasoning；旧 `systemPrompt` 保持兼容。
- [x] 左侧设置已拆为 Agent 默认、当前会话和高级；新 Session 继续一键继承 Profile，不恢复重复创建弹窗。
- [x] Composer draft/attachments/steer-follow-up mode 已按 Session 隔离，停止成为独立动作。
- [~] `turn/start.effort` 与 Responses `reasoning_effort` 映射已有 hermetic 测试；真实 ToolBox 参数验收待执行。
- [~] Electron 基础 smoke 已通过；深浅主题、窄栏、双 Agent 并发、Ctrl+R 临时草稿清空以及真实 reasoning 模型仍需交互验收。

详细合同见 [agent-settings-and-composer.md](agent-settings-and-composer.md)。本阶段不包含高级发送、Native Agent、Shell/file、MCP、Plan、Review 或 multi-agent。

## R0：保存基线与建立文档真源

目标：任何开发者都能确认正确工作树、分支、历史边界和当前产品路径。

- [x] 在 `VCPChat-rust-agent` 保存 R3-M checkpoint：`d441675a`。
- [x] 创建 `codex/vcpchat-codex-app-server` 和独立工作树 `VCPChat-codex-agent`。
- [x] 将旧 Rust daemon current 文档归档到 `history/rust/`。
- [x] 保留 `history/pi/`，不恢复 Pi、多 Driver 或旧 Runtime Repository。
- [x] 建立本目录当前真源文档与复用登记表。
- [x] 将 Codex Runtime、Projection、Bridge、Workbench、测试和文档形成首个可审查 checkpoint：`29c2068a`。

退出门槛：工作树无构建产物；文档、代码、测试脚本进入同一提交；`git status` 中不存在误纳入的数据库、API Key、`node_modules` 或 `rust/target*`。

## R0.5：Codex 0.146.0 协议升级

目标：项目使用精确、可复现的最新稳定 Runtime，而不是按本地 `main` 或全局 CLI 猜协议。

- [x] 精确依赖 `@openai/codex@0.146.0`，记录 tag、source revision 与 npm integrity；开发期优先项目内 executable，不升级全局 `0.124.0`。
- [x] 生成 stable/experimental JSON 与 TypeScript schema，canonicalize JSON key，并提交 manifest/tree hash。
- [x] capability fixture、最低版本、支持版本线与 guard 切换到 `0.146`；`test:codex-native` 强制包含 schema capability gate。
- [x] 真实 App Server start/read/restart 通过 `npm run test:codex-app-server-real`。
- [x] 适配 0.146 developer instruction、`additional_tools` 与 custom-provider dynamic tool 差异；真实 App Server tool continuation 通过 `npm run test:codex-app-server-adapter-real`。
- [~] 使用 0.146 + `deepseek-v4-flash` 重跑 live gate：Nova identity/sentinel/reasoning、restart/resume、fork、interrupt、FileOperator、双 Thread cancel isolation 与 VCPLog/VCPInfo connect 已通过；backend approval replay/deny 和富消息 Electron live 尚未完成。
- [ ] live gate 全通过后再决定是否升级全局 Codex 和产品打包版本；此前不得标记迁移完成或 product ready。

## R1：原生 Codex App Server 黑盒证明

目标：不接 GUI、不接 ToolBox 工具时，证明 VChat 能稳定托管未经修改的 App Server。

- [x] JSONL stdio transport、4 MiB 单行上限、request waiter 和超时清理。
- [x] `initialize -> initialized` 生命周期。
- [x] Windows `.cmd` 和原生可执行文件解析。
- [x] server request、notification、stderr、exit 分流。
- [x] 环境变量、VChat 配置路径、项目内固定 executable、PATH 的解析顺序；记录 executable/PID/version，并以 `0.146.0` 为最低兼容版本。
- [~] Thread start/read/fork、Turn start/steer/interrupt：manager fake 测试通过；Codex 0.146 + `deepseek-v4-flash + {{Nova}}` 已真实验证身份、reasoning、原 ID restart/resume、fork 与 interrupt。真实 App Server crash 时 waiter 全清理仍缺自动 gate。
- [~] 同一 App Server 的两个空 Thread 可并发 start/read 且身份隔离；两个真实 streaming Thread 与取消 A 不影响 B 仍缺。
- [ ] App Server crash/restart 后 Thread resume 和 waiter 全部清理。
- [x] 不支持的 Codex 版本 fail-closed；缺少 experimental dynamic tools 时 `thread/start` 原样失败，不静默降级。
- [~] 2026-07-31 working tree 已将 VChat Agent `systemPrompt` 写入 `baseInstructions`，并为新
  ToolBox Session 固定请求 `environments=[]`；VChat loopback adapter 在真实 provider 请求上
  强制仅保留 `vcp_invoke`。manager hermetic 与真实 App Server adapter 工具集合断言通过。
  旧 placeholder 身份快照可安全迁移，旧 native-tool Thread 明确标记 legacy。真实 Nova 身份
  问答尚未通过 live gate，因此不得标为完成。

退出门槛：独立 hermetic suite 覆盖并发、乱序 response、server request、超时、crash；本机真实 App Server 覆盖 Thread/Turn/fork/interrupt/resume。

## R2：Agent Projection SQLite

目标：会话打开不等待 Agent Runtime，同时 SQLite 永远只是 Codex Thread 的展示投影。

- [x] 独立 `codex-agent-projection.sqlite`、WAL、schema migration。
- [x] `agent_sessions`、`agent_messages`、`agent_blocks`、`projection_state`。
- [x] Session 冻结 agent/model/workspace/permission/developer instructions 基础快照。
- [x] `item/started -> delta -> item/completed` 原地投影。
- [x] `thread/read` 基础 reconcile 和 orphan 标记。
- [~] 重复 delta、进程中断、事务恢复已有基础测试；临时 `thread/read` 错误现仅记录 sync error，明确 missing Thread 才 orphan；复杂乱序 delta 与 SQLite reconcile generation 仍需扩大覆盖。
- [x] projection-only IPC 已接线，并由真实 Electron preload/IPC smoke 验证。
- [x] `thread/read` 权威 reconcile 在事务内删除已不存在的旧投影 Item。
- [ ] 数据库损坏、migration 失败、磁盘满时只读降级和明确错误。
- [ ] 数据保留、归档、删除和隐私脱敏策略。

退出门槛：打开 Session 先返回 SQLite；后台对账不闪烁、不串 Thread；orphan 只读；数据库故障不伪造恢复。

## R3：Codex Runtime Manager 与窄 IPC

目标：Main 只管理黑盒 Runtime、Projection writer 和 request routing，不保存第二份 transcript 状态机。

- [x] Session 与 Codex Thread 映射；`resume` 不误建新 Session。
- [x] 一个 App Server 管理多个 Thread，status 按 Session 投影运行状态。
- [x] `thread/fork` 和 projection-only read IPC/preload 入口。
- [x] 原生 command/file approval 与 dynamic tool server request 分流。
- [~] Workbench presence=false 时原生审批 fail-closed；仍需真实 Codex approval schema 全覆盖。
- [~] 图片、音频和文件 descriptor 输入已接基础路径；尚未做真实 App Server 和 UI 验收。
- [x] `requestUserInput`、permissions、MCP elicitation 已建立明确能力矩阵、统一 response IPC、
  source-namespaced exactly-once Registry 与 fail-closed hermetic UI；真实上游触发仍是 release gate。
- [~] App Server crash 后 native approval、dynamic call routing、ToolBox backend approval 已统一 fail-closed，并以 hermetic manager fixture 覆盖；真实进程 crash + UI 恢复审计仍缺。

退出门槛：Renderer 无法直接访问数据库、API Key 或 Codex stdin；所有 Thread/Turn/Item/request identity 可追踪且跨 Thread 不串线。

## R4：VCPToolBox Bridge

目标：仅适配 VCP 协议，不把 Rust bridge 重新做成第二个 Agent Runtime。

- [x] 独立 Rust crate 和 release 构建脚本。
- [x] bounded JSONL、ready、并发 invoke、shutdown 进程 smoke；超长控制帧明确 fail-closed。
- [x] `/v1/human/tool` 与 `/v1/interrupt` 基础调用复用现有 VCP crate。
- [x] Codex `item/tool/call` 按原始 thread/turn/call identity 转发。
- [~] VChat-owned loopback Responses adapter 已实现 Responses → ToolBox Chat、Chat tool calls → Responses function calls、function-call-output 历史和基础 SSE；独立 fixture和真实本机 App Server 的工具续接均通过，尚未在未修改 ToolBox 重跑 live。
- [~] 结构化 text/image/audio 结果基础映射；warning、task accepted、文件资源未完整。
- [~] **R4.1 Bridge 连接内核复用**：已按 [reuse-register.md](reuse-register.md) 从 vcp-code `vcp-bridge.ts` 和测试抽取 URL normalization、`/VCPlog`/`/vcpinfo` endpoint candidate、latency probe、指数退避、配置变更重连和 dispose fixture，并以 Rust/进程 fixture 验证；2026-07-31 对未改 ToolBox 的双 observer live-connect+shutdown 已通过，真实断线重连/replay 仍未验收，不得标为产品完成。
- [~] R4.1 安全加固：最大帧、有界 channel、jitter、replay 去重、TTL、稳定隐私安全 `deviceName`、凭据脱敏和 shutdown cleanup 已有 hermetic receipt；真实网络与 Electron 恢复仍待验证。
- [ ] **R4.2 VCP 内容净化复用**：受控导入或等价端口 vcp-code `vcp-content.ts` 与 fixture，将 `VCP_DYNAMIC_FOLD`、`VCPINFO` 投影为 `AgentBlock[]`、紧凑历史摘要和通知。
- [ ] R4.2 `TOOL_REQUEST` marker 只能产生 protocol-warning Block 并从正文净化，永远不能执行；唯一动态工具通道仍是 Codex `item/tool/call -> vcp_invoke`。
- [ ] 动态 ToolBox catalog 驱动 `vcp_invoke` 描述，而不是固定空泛说明。
- [~] 一条 bridge 级 VCPLog 连接、帧限长、指数退避+jitter、replay 去重、稳定无隐私 deviceName、Main 配置热重连已实现；真实网络验收未完成。
- [~] ToolBox backend approval 双向响应、TTL、replay 去重、过期/关闭 fail-closed 已实现；真实 ToolBox 恰好一次响应未验证。
- [~] VCPInfo 已分类为 RAG/记忆/日记/梦境/通知等只读 projection，并在 Main 限长脱敏；真实 payload 和完整内容 parser 未验证。
- [~] Workbench 关闭和 bridge stop 会拒绝审批/调用；bridge crash 与网络断线的 Electron 恢复审计仍缺。

退出门槛：真实 `vcp_invoke` 完成；backend approval 只响应一次；VCPInfo 不进入模型历史；不改 ToolBox 配置、不复制 catalog。R4.1/R4.2 必须提交复用收据，包括来源文件/revision、采用方式、行为差异、安全加固、License/NOTICE 和对应测试；缺少收据时 R4 不得标记完成。

## R5：Workbench 数据层与 UI 收敛

目标：达到 Cherry 式“Session 立即切换、Runtime 后台运行、规范 Block 通用展示”。

- [x] SQLite snapshot 转换为现有 Workbench projection。
- [x] live `projectionMessage` keyed 更新，不在每个 token 调用 `thread/read`。
- [x] 多 Thread runtime 状态与 selected Session 分离的基础接线。
- [~] Session 列表、feed、草稿、切换 JSDOM 回归通过；仍含 Rust Topic 术语和兼容动作。
- [x] Full Fork presentation 默认接入 Message row；forbidden dependency 归零，主聊天原 renderer/streamManager/context menu 零修改。
- [x] Tool/Approval/Observation/Error 从 Workbench 迁入统一 Block registry；原页面内结构化卡片实现删除，Fork/legacy 共用同一路径。
- [x] 编辑、重试、分支通过 action adapter 调用 `thread/fork`；取消路由目标 Turn，SQLite 不被菜单动作直接改写。
- [~] 转发当前为安全剪贴板交接；尚缺不依赖主聊天 history identity 的目标选择 adapter。
- [ ] **R5.1 Session UI 状态机复用**：从 vcp-code `sessionStateMachine.ts` 抽取 transition 机制和 fixture，建立 Renderer-only 的纯函数 reducer，覆盖 idle/creating/streaming、两类审批、用户输入、completed/interrupted/error/orphaned；不得把 UI state 当作 Runtime 真源。
- [ ] R5.1 同时端口 CodexMonitor `threadReducer` 的纯 reducer/fixture，并使用 DeepChat `sessionStateResolver`、`sessionStatusPublisher` 测试补 query、close、reconnect 边界；删除所有本地伪 ID 生成。
- [ ] R5.1 并发隔离：取消 A、审批 B、切换 C 的事件必须按完整 Session/Thread/Turn identity 更新，selected Session 不得参与事件归属推断。
- [ ] **R5.3 通知与观察中心复用**：借鉴 vcp-code 的 200 条 bounded ring、未读游标和 typed status，接收 Bridge 输出的已限长、去重、脱敏 observation；无可靠 Thread identity 时保持全局。
- [ ] R5.3 不复制 `VcpCapsule` 布局，不把 API Key、原始大 JSON 或通知自动写回 Codex/SQLite transcript。
- [~] 主聊天/Fork golden fixture 的规范化 DOM 对照已通过，覆盖 Message 骨架、Markdown/LaTeX/Mermaid、代码、表格、链接、图片、reasoning、VCP marker 与附件；仍缺 Electron 深浅主题截图和 2px 布局门槛。
- [~] 原生 Codex tool、`vcp_invoke`、审批、资源、warning 的 Block registry 已建立并覆盖当前 Projection；尚缺完整 Codex native command/file/MCP 类型专用视觉和 live 资源验收。
- [ ] 长流 animation-frame 合并、非底部 scroll anchor、10 Session 秒切性能录制。
- [ ] 清除 Rust lease/takeover/compact/interaction queue 等不适用于 Codex 的 UI。
- [~] Electron 创建/读取/空 Thread orphan smoke 已通过；增强 smoke 真实打开 Workbench 并分别断言默认 Fork 与隐藏 legacy 回退。关闭重开、crash/reconnect、富消息视觉和后台双 Thread 恢复仍缺。
- [x] **UX-R0 分段耗时诊断**：记录 Agent click/cache paint/SQLite list、Runtime ready、Thread warm、
  Turn ACK、首个 assistant Item 与首个可见 delta；只输出 duration、数量和截断 identity。
- [x] **UX-R1 Session 目录快路径**：Projection SQLite list/read 不启动 App Server；Main 负责
  canonical Agent identity 和 legacy `Nova -> folder id` 迁移，Renderer cache hit 一帧显示、cold list
  P95 <= 150 ms。
- [x] **UX-R2 Runtime/Thread 预热**：进程 warm 不阻塞目录；选中 Session 后 detached ensure/resume，
  `sessionId -> warmPromise` 去重，首轮最多保留 2 个 idle warm Thread。
- [x] **UX-R3 主聊天同构首发状态**：删除手写 thinking DOM，使用 Full Fork 的完整头像/名称/气泡骨架
  和 `.streaming` 流光，真实 Item 接管无重复、无明显布局跳变。
- [x] **UX-R4 Tool Activity 视觉统一**：结构化 lifecycle 保持 Codex identity，展示 clean-room 复用主聊天
  `vcp-tool-use/result` 视觉和 token，紧凑、可折叠、keyed 原地更新。
- [~] **UX-R4 连续工具聚合**：2026-08-01 working tree 已按 Cherry 的机制将同一 Turn 内相邻的多个
  Tool Part 投影为 Renderer-only 折叠组；正文/推理/不同 Turn/无 identity 均为硬边界，组内仍按真实
  `toolCallId` 原地更新。`test:agent-workbench-timeline`、`test:agent-presentation`、
  `test:agent-workbench` 已通过；Electron 长任务视觉、滚动和真实审批密度仍待 GUI-R6 验收。
- [ ] **UX-R5 视觉/性能门槛**：主题/分辨率截图、10 Agent/50 Session 切换、cold/warm 首发 latency、
  scroll anchor <= 2 px、Electron 重开恢复。

退出门槛：Session 切换只读 SQLite 且即时；后台 Thread 不停止；消息、工具、usage、审批不串线；主聊天体验差异有明确清单且无 P0。R5.1/R5.3 必须附 transition/notification fixture 与复用收据，禁止以 UI snapshot 代替身份隔离和行为断言。

### GUI-R0–R6：Workbench 产品能力收口

详细能力合同和退出门槛以 [gui-capability-roadmap.md](gui-capability-roadmap.md) 为真源。本交付轨不重复已经完成的 UX-R0–R4；Renderer 展示实现可由并行开发线推进，但合并时必须通过同一协议、Projection 和 identity 门槛。

- [~] **GUI-R0 协议与能力矩阵**：固定 `0.146.0` stable/experimental schema fixture、`toolbox-only` capability gate、未知交互 fail-closed 已实现并通过 `check:codex-schema` / `test:codex-app-server-capabilities` / `test:codex-app-server-transport`；真实 App Server start/read 与 adapter continuation 已通过，仍待干净提交和 0.146 live receipt。
- [~] **GUI-R1 Session 导航与状态机**：archive/restore/pin、Session 临时状态和完整 identity reducer 已实现并通过 `test:agent-session-state` / `test:agent-workbench`；keyed list、unread、scroll anchor 与 Electron gate 仍未完成。
- [~] **GUI-R2 Composer**：Main-side submit idempotency、steer 与持久文本 follow-up queue 已实现并通过 `test:codex-runtime-manager`；附件排队、完整设置 UX 和 Electron cold-start gate 仍未完成。
- [~] **GUI-R3 规范时间线 Block**：OpenCode frozen-tail Markdown 与 Harnss 式累计/重叠 delta accumulator 已以 clean-room 最小模块接入，`test:agent-markdown-stream` / projection store 测试通过；Plan/resource/warning/compaction/Diff 专用 Block 与 Electron 长流 trace 仍待。
- [~] **GUI-R3 持久恢复**：2026-08-01 working tree 已将 ToolBox Chat 的公开 `reasoning_content`/字符串 `reasoning` 转为 Codex Responses reasoning Item，并将实时 `projection.updated` 与 SQLite-first snapshot 统一投影为 Full Fork `message.reasoning`；真实 App Server mock provider 已产生 `item/reasoning/textDelta` 并写入 SQLite。Projection 与 Workbench 测试覆盖空 completed payload、数据库关闭重开、点击/键盘折叠及工具卡冷恢复。真实 `deepseek-v4-flash` + ToolBox live gate 已断言 durable projection 存在非空 reasoning，后续请求历史也包含 reasoning Item；Electron 关闭重开截图仍待，因此不得标记产品完成。
- [~] **GUI-R4 审批与交互中心**：source-namespaced Registry、统一 response IPC、requestUserInput、
  exact permission、MCP typed/opaque/URL 表单和超时/关闭/crash fail-closed 已通过 hermetic 测试；真实
  Codex native/MCP 请求与 ToolBox backend approval live gate 待完成。
- [~] **GUI-R5 Inspector 与 Activity Center**：Plan/Context/Usage/Compaction Inspector、100 条有界
  observation ring、分 Tab 未读、搜索/来源/类型筛选和 Codex 三层连接文案已接线；schema v6 持久恢复
  usage/compaction。2026-08-01 working tree 已将产品入口收口为一行 Context/Notifications/Approvals，
  隐藏无可靠数据来源的 Plan/Changes 与内部 Diagnostics，同时保留 header context 水位环、usage
  provenance、cache write、Session 元数据、只读 instruction 和响应式 420/380px 面板；Safety budget
  已迁回 Settings。
  toolbox-only 已隐藏无真实数据来源的 Changes；VCP mutation receipt、Session 生命周期通知持久索引、
  非交互卡完整 keyed patch、Plan dock、Diff 文件导航、专用 timeline Block 与视觉/性能验收仍待。
- [~] **WB-R0–R5 Workspace Browser 与统一路径动作**：Main-only 安全服务、窄 IPC、Workspace Tab、
  搜索/预览、固定 Tab、CSS content-visibility 长列表优化，以及 tree/tool/diff/attachment 统一路径入口
  已实现并通过 hermetic + Electron smoke。详细合同见
  [workspace-browser-plan.md](workspace-browser-plan.md)。先复用 `workspacePolicy.js` 建立 Main-only
  只读服务和 `agent-workspace:*` 窄 IPC；工具卡、Diff、附件与文件树统一产生 `WorkspacePathRef`。
  10k 文件分页/搜索 fixture 已通过；真实交互性能录制、人工视觉和结构化 ToolBox 资源验收仍待。不得开启 Codex native
  Shell/file tools，不得从 ToolBox 文本猜路径或加入写/delete/apply/revert 能力。
- [ ] **GUI-R6 视觉、性能与 live gate**：富消息截图、scroll anchor、10 Agent/50 Session、cold/warm latency、crash/restart、双 Thread 和真实 ToolBox。
- [~] **R5-D Session Tool Dock**：浏览器式 keyed Tab strip、Session 隔离模型、顶层文件 Tab、最小 `sessionStorage` 恢复和 VChat 终端 launcher 已进入 working tree；`test:agent-session-dock` 与 Workbench JSDOM gate 已覆盖。Changes 仍只认 Codex `fileChange`，浏览器 launcher 因无可靠应用注册而隐藏。Electron 真实交互、多分辨率截图、20 文件 Tab 与 10k workspace 性能录制完成前不得标记 hermetic verified。详见 [session-tool-dock.md](session-tool-dock.md)。
- [ ] assistant-ui 仅登记为未来 React island 的条件式评估；acp-ui 仅登记为未来 ACP profile 参考，本轮不得增加 React/Vue/Tauri/ACP 依赖。

退出门槛：GUI 不按最新 Codex 源码猜能力，不显示无法执行的开关，不显示原始协议 JSON；所有交互按完整 identity 路由，并有 `test-matrix.md` 收据。

## R6：真实 Nova + ToolBox 验收

目标：证明产品链路，不用“响应非空”代替功能断言。

- [x] 2026-07-31 working-tree live：对 ToolBox `324a659f` 执行 `test:codex-nova-live`，
  Codex custom provider -> **VChat loopback adapter** -> ToolBox `/v1/chat/completions`；身份回答包含
  Nova 且不含 Codex，随机 sentinel、restart/resume、fork、interrupt 全部通过。VChat HEAD
  `d441675a`，Codex source `f0c30e528a`；因接入改动尚未提交，此项是 working-tree live pass，
  不是版本级 verified。
- [~] 流式 text/reasoning delta 与 durable projection、后续 Codex history 一致已由 2026-08-01 live gate 证明；仍待 Electron 关闭重开后的展开、顺序和视觉截图收据。
- [ ] 对未修改 ToolBox 执行 `vcp_invoke(FileOperator)`：必须经 Codex dynamic call -> VChat bridge -> ToolBox -> VChat DistributedServer 返回指定 `package.json` name。前置条件是 VChat 已配置 ToolBox 并启动 DistributedServer；不得依赖 ToolBox 的 Responses 改动。之后补流状态卡、并发与取消隔离收据。
- [ ] Codex 原生 Shell/file approval 与 VCP backend approval 身份、UI、响应通道分离。
- [~] `/v1/interrupt` 使用稳定 request identity：2026-08-01 working tree 已在 VChat Responses adapter 为每次 ToolBox Chat body 写入唯一 `vcp_codex_*` `requestId`，loopback client 断开时以同一 ID 发送一次 `/v1/interrupt`；`test:codex-toolbox-responses-adapter` 通过。真实 App Server cancel 到该断开传播的全链路仍随并发 gate 阻塞。
- [~] 两个 Nova Thread 同时执行，取消 A 不影响 B：2026-08-01 working-tree 使用 `test:codex-concurrent-live`（300 s 上限）通过，实际耗时 199 s：A/B 均 started，A interrupted，B completed；同一 App Server PID 不变，B sentinel 只在 B projection。Codex 0.124.x HTTP header 的 `session_id` 与公开 threadId 相等、provider 子 `turn_id` 不等于公开 Turn ID；adapter 使用 session_id 路由、以取消 tombstone 防止 A 的迟到 provider request 复活。此前 60/180 s 失败是超时阈值不足。该 receipt 仍位于 dirty working tree，真实 backend approval/VCPLog/Electron gate 未完成，故不得标记 R6 或产品完成。
- [ ] VCPLog replay/TTL/去重与 VCPInfo 结构化通知。
- [ ] Electron 视觉、滚动、Session 秒切、重开恢复和进程清理。

退出门槛：`test-matrix.md` 所有阻塞行均为 `live verified`，并附完整版本收据。

## 当前最近施工顺序

1. 固化 GUI-R0 至 GUI-R2 working-tree checkpoint：运行 capability、transport、projection、runtime manager、session state 和 Workbench 测试；形成干净提交前不得把它们标为 release verified。
2. GUI-R3：补 Plan/resource/warning/compaction Block、复杂 Markdown fixture 和长流 trace；frozen-tail/accumulator 基线已存在，不得退回整段 `textContent` 重绘。
5. GUI-R4：端口 Harnss permission queue 与 CodexMonitor/openclaw interaction fixture，完成 requestUserInput 和多审批来源的恰好一次响应。
6. WB-R0/R1：先冻结 WorkspaceRef、安全上限和 Windows 路径 fixture，再建立 Main-only 只读 Workspace Service；不得先写树 UI 后补安全层。
7. WB-R2/R3：clean-room 端口 OpenCode 的 tree model/preview 机制，并让 tree/tool/diff/attachment 共用 `WorkspacePathRef` 和动作 adapter。
8. WB-R4：仅对 Codex 权威 `fileChange` 路径提供有界只读 Git diff；ToolBox mutation receipt 未落地前继续隐藏 toolbox-only Changes。
9. GUI-R5：当前 Context/Usage Inspector 与分组 Activity Center 已接线；补 Session 生命周期通知索引、Plan dock和非交互卡 keyed patch。引入 `@pierre/diffs` 前执行 release-size gate。
10. R4/R6 live：始终使用未修改 ToolBox，重跑动态 `FileOperator`、双 Thread、取消隔离、backend approval、VCPInfo reconnect/replay 和 Electron 富消息/性能门槛。
11. 所有端口附来源 revision、许可证、行为差异和测试收据；所有 hermetic/live 收据与 worktree 状态一致后再形成 checkpoint。在此之前始终保持 experimental。
## R7-R10 Reliability and Governance

## R12 Settings and Data Governance

- [~] ProfileV2/SessionConfigV2、schema 8 migration、Profile/Session CAS 和 desired/applied revision 已实现。
- [~] 字段级 Draft/queue、Codex 0.146 settings apply、发送 barrier、空闲指令 reload、附件 capability 与有界 event dedupe 已实现并有专项测试。
- [~] 内部 Runtime/Workbench 已移除隐式 `sessionId || topicId` 路由，并对冲突 identity fail-closed；旧 `topicId` 仅保留在 IPC/展示兼容边界。Runtime/Workbench 大文件继续拆分。
- [x] 2026-08-03 真实 Electron 设置交互已验证 YOLO/cwd 不回跳并写入 SQLite；独立两阶段测试彻底关闭并重启 Electron Main 后，Session、YOLO、模型和 workspace 均从同一 Projection SQLite 恢复。
- [x] 2026-08-03 对固定 Codex 0.146 + ToolBox `324a659f` 的下一 Turn live gate 通过：真实 `thread/settings/update` 确认 cwd、model、`approvalPolicy=never`、`effort=high`，随后 ToolBox Chat body 使用 `deepseek-v4-flash` 与 `reasoning_effort=high`，desired/applied revision 对齐。
- [ ] 指令模式切换与 ToolBox backend approval 恰好一次仍需 live 验收；通过前不得升级为 `product`。

R12 当前状态只能是 `implemented/working-tree`，不得复用 R7-R10 live revision 宣称完成。

- [x] R7: Agent Profile/Session snapshot、CAS、projection-only IPC、ToolBox latest-wins 与 Session-keyed Renderer state。
- [x] R8: Runtime generation、InteractionRegistry 有界清理、按需重启、持久输入状态机与 pre-RPC/ACK crash fault injection。
- [x] R9: 权威 reconcile、mutation generation barrier、Saga 日志、known-Thread lifecycle recovery、SQLite integrity/backup/read-only degraded。
- [x] R9 follow-up (`a13a3410`): local authority 不被 Codex snapshot 删除；只读降级在 transport 前拒绝全部 mutation；start/fork ACK 后故障保留 Thread ID 并只允许显式恢复，不自动重放。
- [x] R10: 归档/永久删除/导出、Workspace Abort/cancel、Renderer 独立 ADR、Windows CI 与机器治理检查。
- [x] R10 follow-up (`d14f9a58`): Workspace policy 归属 Codex Runtime；Agent IPC 完全转入中央合同并静态校验缺失 channel；删除全局 attachment/list 推断；旧 Pi/Rust npm 入口显式归档、产品打包排除旧 Runtime、Rust workflow 改为手动；Electron recovery/smoke 使用独立 `userData` 且不启动无关 CDS。
- [x] Renderer race follow-up (`c0143f64`): pre-Turn thinking row 不再执行延迟 Markdown 后处理；`test:agent-workbench` 连续 5 次和完整 `test:codex-ci` 通过。
- [x] Hermetic revision `cc6496f4` 的 Windows 聚合与独立 reliability gate 已通过；功能 revision 保持 `c0143f64`。
- [x] Live revision `46e2ce41` 的双 Thread 长任务 gate 已通过：A 中断，B 完成 8,558 字符响应；真实 Nova、FileOperator 单次调用与 VCPLog/VCPInfo observer connect 同样通过，R7-R10 状态为 `live`。
- [ ] 整体产品 release gate 仍需 Codex native approval、ToolBox backend approval replay/恰好一次、VCPInfo/VCPLog reconnect/replay，以及 Electron 富消息与性能验收；这些待办不回退 R7-R10 的完成状态。
