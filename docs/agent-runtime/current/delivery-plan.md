# Codex Agent Runtime 交付计划

状态：**experimental / active development**。本计划按依赖顺序施工，后续阶段不能掩盖前一阶段未通过的退出门槛。

标记：`[x]` 已实现且有当前证据；`[~]` 部分实现或仅 working-tree pass；`[ ]` 未完成。

## R0：保存基线与建立文档真源

目标：任何开发者都能确认正确工作树、分支、历史边界和当前产品路径。

- [x] 在 `VCPChat-rust-agent` 保存 R3-M checkpoint：`d441675a`。
- [x] 创建 `codex/vcpchat-codex-app-server` 和独立工作树 `VCPChat-codex-agent`。
- [x] 将旧 Rust daemon current 文档归档到 `history/rust/`。
- [x] 保留 `history/pi/`，不恢复 Pi、多 Driver 或旧 Runtime Repository。
- [x] 建立本目录当前真源文档与复用登记表。
- [ ] 将当前 Codex working tree 形成首个可审查 checkpoint commit。

退出门槛：工作树无构建产物；文档、代码、测试脚本进入同一提交；`git status` 中不存在误纳入的数据库、API Key、`node_modules` 或 `rust/target*`。

## R1：原生 Codex App Server 黑盒证明

目标：不接 GUI、不接 ToolBox 工具时，证明 VChat 能稳定托管未经修改的 App Server。

- [x] JSONL stdio transport、4 MiB 单行上限、request waiter 和超时清理。
- [x] `initialize -> initialized` 生命周期。
- [x] Windows `.cmd` 和原生可执行文件解析。
- [x] server request、notification、stderr、exit 分流。
- [x] 环境变量、VChat 配置路径、PATH 的解析顺序；记录 executable/PID/version，并以 `0.124.0` 为最低兼容版本。
- [~] Thread start/read/fork、Turn start/steer/interrupt：manager fake 测试通过；2026-07-31 working tree 已真实验证两个空 Thread 的身份隔离、空 Thread restart 后安全重建，以及 `gpt-5.6-luna + {{Nova}}` 完成 Turn 后的原 ID restart/resume。fork/interrupt 仍缺真实自动测试。
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
- [ ] `requestUserInput`、permissions、MCP elicitation 等 server request 的明确支持矩阵。
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
- [ ] **UX-R5 视觉/性能门槛**：主题/分辨率截图、10 Agent/50 Session 切换、cold/warm 首发 latency、
  scroll anchor <= 2 px、Electron 重开恢复。

退出门槛：Session 切换只读 SQLite 且即时；后台 Thread 不停止；消息、工具、usage、审批不串线；主聊天体验差异有明确清单且无 P0。R5.1/R5.3 必须附 transition/notification fixture 与复用收据，禁止以 UI snapshot 代替身份隔离和行为断言。

## R6：真实 Nova + ToolBox 验收

目标：证明产品链路，不用“响应非空”代替功能断言。

- [x] 2026-07-31 working-tree live：对 ToolBox `324a659f` 执行 `test:codex-nova-live`，
  Codex custom provider -> **VChat loopback adapter** -> ToolBox `/v1/chat/completions`；身份回答包含
  Nova 且不含 Codex，随机 sentinel、restart/resume、fork、interrupt 全部通过。VChat HEAD
  `d441675a`，Codex source `f0c30e528a`；因接入改动尚未提交，此项是 working-tree live pass，
  不是版本级 verified。
- [ ] 流式 text/reasoning delta 与最终 `thread/read` 一致。
- [ ] 对未修改 ToolBox 执行 `vcp_invoke(FileOperator)`：必须经 Codex dynamic call -> VChat bridge -> ToolBox -> VChat DistributedServer 返回指定 `package.json` name。前置条件是 VChat 已配置 ToolBox 并启动 DistributedServer；不得依赖 ToolBox 的 Responses 改动。之后补流状态卡、并发与取消隔离收据。
- [ ] Codex 原生 Shell/file approval 与 VCP backend approval 身份、UI、响应通道分离。
- [ ] `/v1/interrupt` 使用稳定 request identity，取消产生不可自动重放的中断结果。
- [ ] 两个 Nova Thread 同时执行，取消 A 不影响 B。
- [ ] VCPLog replay/TTL/去重与 VCPInfo 结构化通知。
- [ ] Electron 视觉、滚动、Session 秒切、重开恢复和进程清理。

退出门槛：`test-matrix.md` 所有阻塞行均为 `live verified`，并附完整版本收据。

## 当前最近施工顺序

1. 在不覆盖并行 Renderer 工作的前提下，审查并回退仅为旧试验引入的 ToolBox Responses 改动；VChat adapter、文档和测试保持在 VChat 工作树。之后建立可审查 checkpoint，排除数据库、构建产物与凭据。
2. 扩大真实 App Server fixture：双 Thread 同时 streaming、取消 A 不影响 B、真实 fork、真实 interrupt、crash/restart 后 resume 与 waiter 清理。修复 Electron smoke，使 `ERR_FILE_NOT_FOUND` 记录具体资源 URL 后再判断归属。
3. 执行 R4.1 复用：先移植 vcp-code 的 endpoint/reconnect fixture，再补 Rust bridge 的 jitter、config reconnect、oversized frame、replay/TTL 与 shutdown 安全断言；随后对真实 VCPLog 执行 reconnect/replay/恰好一次审批验收。
4. 执行 R4.2 复用：将 VCP marker 投影为规范 Block，并以 fixture 证明 `TOOL_REQUEST` 只会产生 warning、永不触发 `vcp_invoke`。之后补齐资源、warning、异步 task 和动态 catalog 的受控投影。
5. 对未修改 ToolBox 重跑并扩大 R6 live gate：普通 Nova 流式/usage 对账、`FileOperator`、双 Thread 并发与取消隔离、稳定 `/v1/interrupt`、native/VCP backend approval 分离、VCPInfo 真实通知。旧 `FileOperator` probe 不能替代这些场景。
6. UX-R0–R4 已在当前 working tree 实现；当前只继续执行
   [workbench-experience-roadmap.md](workbench-experience-roadmap.md) 的 UX-R5：补富消息深浅主题截图、
   cold/warm 首发性能录制、非底部滚动锚点与 Electron 重开恢复。状态机和通知中心仍按 R5.1/R5.3
   独立验收，不得用空页面 shell smoke 代替。
7. 所有 hermetic/live 收据与 worktree 状态一致后，形成首个干净 checkpoint；在此之前始终保持 experimental。
