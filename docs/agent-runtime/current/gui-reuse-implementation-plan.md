# Agent GUI 外部复用实施计划

状态：**GUI-R0 至 GUI-R2 implemented in working tree；GUI-R3 的流式内核、GUI-R4 的 interaction 内核、GUI-R5 的 compaction/diff 内核为 working-tree checkpoint；专用 UI、真实验收与 GUI-R6 planned；source snapshots cloned**。本文件把 `reuse-register.md` 的来源登记转成可施工的文件映射。clone 完成不代表能力完成，也不允许 VChat 在运行时读取相邻仓库。

2026-08-01 当前收据：`npm run test:codex-app-server-capabilities`、`npm run test:agent-session-state`、`npm run test:codex-runtime-manager` 与 `npm run test:codex-projection-store` 均通过。本轮实现尚未形成干净提交，因此只能标记为 working-tree checkpoint，不得标记为产品或 live verified。

## 当前能力审计

| 能力 | 当前实现 | 完成度 | 下一步 |
|---|---|---|---|
| SQLite 首帧与后台 `thread/read` 对账 | Projection Repository/Projector 与 Workbench 快路径已存在 | checkpoint pass | 继续补乱序、重复、orphan 与大量 Session 性能 gate。 |
| Agent identity、Thread warm、多 Thread 基础 | Runtime Manager 与窄 IPC 已存在 | checkpoint pass | 状态统一到纯 reducer，清理旧 Rust Topic/attachment 文案和 fixture。 |
| 主聊天同构消息渲染 | Full Fork renderer、Markdown/LaTeX/Mermaid/代码后处理已存在 | checkpoint pass；富消息视觉 pending | 不重做 renderer；补 frozen-tail、stream buffer、Diff/Plan/Usage 专用 Block。 |
| Tool/Approval/Observation/Error Block | registry 与 keyed update 已存在 | checkpoint pass；真实富消息 pending | 增加结构化资源、warning、requestUserInput 与多审批来源中心。 |
| VCP `vcp_invoke` 与 Bridge | Responses adapter、Rust bridge、基础审批/VCPInfo 已存在；Codex 消息 VCP marker 已先净化为 display/history/observation | working-tree checkpoint；部分 live pending | 不改 ToolBox，补动态工具、replay/reconnect、双 Thread live、嵌套 marker 与 Electron 视觉 gate。 |
| Session archive / restore / pin | Runtime、Repository、IPC/preload 与纯 UI state 已接线 | working-tree checkpoint | 补 delete、keyed list/scroll anchor 和 Electron gate。 |
| 统一 Session UI reducer | `reduceAgentSessionUiState` 已实现，以完整 Session/Thread/Turn/Request identity 路由 | working-tree checkpoint | 继续用 CodexMonitor/DeepChat 的 close、reconnect、unread fixture 扩大覆盖。 |
| requestUserInput / permission / MCP elicitation | Main Registry、统一 IPC、三类表单和 fail-closed 已形成 hermetic 闭环 | working-tree pass；live pending | 真实 Codex/MCP 触发和关闭/crash Electron gate。 |
| Plan | Projector 已将 `plan` 投影为 observation | partial | 新增 Plan Block/Inspector，不再只显示通用 observation。 |
| Diff/file change | OpenCode session-diff 的数据边界已 clean-room 端口：仅 Codex `changes`、16 文件 / 128 KiB 上限、路径/状态/patch/增删统计；toolbox-only UI 已隐藏该 Tab | data model working-tree pass；产品入口 hidden | 先建立 VCP FileOperator 结构化 mutation receipt，再恢复只读 Diff Inspector；不得从参数或成功文本猜 patch。 |
| Usage/context | OpenCode 式 header waterline、Context Inspector、来源标记、cache write、Session 元数据与只读 instruction 已接线；budget 已迁回 Settings | working-tree pass | 补真实长 Session 水位、compaction 前后截图和 provider usage 差异 fixture。 |
| Compaction | `compactSession()` 已调用 `thread/compact/start`，ACK 后等待终态 `contextCompaction`，再以 `thread/read` 对账 | working-tree checkpoint | 补专用 Compaction Block/Inspector、live 收据与用户可诊断的失败显示；ACK 永远不算完成。 |
| Activity Center / unread | Inspector/Activity 两组稳定 Tab、100 条 ring、分 Tab 未读、搜索/来源/类型筛选已接线 | working-tree pass；视觉/性能 pending | Session 生命周期通知索引、severity unseen、点击跳转、非交互卡 keyed patch 与真实长流 Electron gate。 |
| Composer submit / follow-up | Main-side submission identity 去重；纯文本 follow-up 已持久排队，steer 保持即时语义 | working-tree checkpoint | 补附件排队协议和 Electron UX gate；不得将附件 path 持久化。 |
| 流式 frozen tail | OpenCode 机制的最小 clean-room 端口已接入 Agent Full Fork：稳定 head keyed 保留、仅开放 code/live tail 更新；Projection 以 Harnss 式 200 字符 overlap 窗口净化累计/重叠 delta | working-tree checkpoint | 补长流 trace、Markdown worker 条件 gate，以及更多复杂表格/HTML fixture。 |
| GUI-R6 真实视觉/性能 | 空 shell 和基础 Electron smoke 已通过 | partial | 富消息截图、2 px scroll gate、10 Agent/50 Session、双 streaming live 尚未完成。 |

## 施工顺序

### 1. GUI-R0：协议 fixture 先行（已实现，仍待提交）

目标文件：CodexMonitor 的交互测试与 openclaw 的 `client.test.ts`、`pending-input.test.ts`、permission smoke。

1. 从固定 Codex CLI/source revision 生成 Method、Notification、Item、Server Request fixture。
2. 把 requestUserInput、command/file approval、permission、compact、interrupt 标为 stable/experimental/unsupported。
3. 扩展现有 AppServerTransport 测试，不替换 transport。
4. 未知交互请求必须错误关闭，不返回伪成功。

### 2. GUI-R1：Session reducer 与导航（基础闭环已实现，仍待提交）

目标文件：CodexMonitor `threadReducer/*`、`ThreadList*.test.tsx`；DeepChat `sessionStateResolver*`、`sessionStatusPublisher*`。

1. 新建 Renderer-only `reduceAgentSessionUiState(state, event)`。
2. 只使用 `sessionId + threadId + turnId + itemId/requestId` 路由。
3. 为 running、approval、input、error、reconnecting、orphaned 建立后台徽标。
4. 补 pin/unpin、archive/restore 与 keyed list/scroll anchor；列表查询不得启动 App Server。

### 3. GUI-R2：Composer 与 pending input（基础闭环已实现，仍待提交）

目标文件：DeepChat pending input/pump/cancellation registry；CodexMonitor user-input hook fixture。

1. 把 send、steer、follow-up、queued input 分成明确命令，不由 UI 猜当前 Runtime 状态。
2. 草稿、附件 descriptor、滚动和展开状态按 Session 保留在页面生命周期内。
3. 重复 Enter/点击采用 submission identity 去重。
4. 窗口关闭默认 fail-closed 未决交互，但不无条件取消所有后台 Thread。

### 4. GUI-R3：流式与规范 Block（frozen-tail / delta accumulator 已实现，专用 Block 仍待）

目标文件：OpenCode `markdown-stream*`；Harnss `streaming-buffer*`、`tool-formatting*`。

1. [x] 把 cumulative/incremental delta 归一化为单一 accumulator。
2. [x] Markdown 只重绘不稳定 tail，稳定 head 不替换 DOM。
3. Plan、resource、warning、compaction 和 Unknown 建立专用、限长 Block。
4. 只有 trace 证明主线程 parse 成为瓶颈时才引入 markdown worker。

### 5. GUI-R4：Interaction Center（identity / exactly-once 内核与统一队列投影已实现；live gate 待完成）

目标文件：CodexMonitor approval/user-input fixture；Harnss permission queue；openclaw permissions smoke。

1. [x] Main 保存 server request waiter；Renderer 只显示规范交互投影。
2. [x] Codex native、VCP local、ToolBox backend 使用不同 ID namespace 和 response channel。
3. [x] pending -> responding -> completed/expired 状态不可逆，重复点击不重放。
4. [x] crash、timeout、Workbench close、身份不匹配均 fail-closed。

2026-08-01 working-tree：Activity Center 从 Main 的 `pendingInteractions` 读取 source-namespaced 权威
identity，并与 Codex/ToolBox approval 卡按 `source:requestId` 去重。requestUserInput、permission、MCP
typed/opaque/URL 已有可操作表单；secret 使用 password 且不落盘；URL 打开与 accept 分离。Manager 只授予
原请求 permission profile，并限制 MCP typed output。真实 Codex native/MCP、ToolBox backend approval 和
关闭/crash Electron gate 仍待。

### 6. GUI-R5：Inspector 与 Activity Center（Context 与分组面板已实现；通知/Plan/Diff 深化待完成）

目标文件：OpenCode `session-diff*`、`apply-patch-file*`；Harnss context usage/patch/notification；DeepChat Projection tests。

1. Plan/Diff/Context/Usage 从 Projection Block 派生只读视图，不持有第二份 transcript。
2. Diff 只消费 Codex `fileChange`，不执行 patch；`@pierre/diffs` 先过 size gate。
3. [x] Compaction 等待最终事件后再对账 Thread/Projection；补 started/completed/failed 专用 Block 和 Inspector 入口。
4. [x] Activity Center 使用有界 ring、分 Tab 未读、搜索/来源/类型筛选和脱敏。
5. [x] 以 OpenCode 信息架构为机制参考，将 Context/Plan/Changes 与 Notifications/Approvals/Diagnostics 分组；增加 header context ring、usage provenance、cache write、Session 元数据与只读 instruction。
6. [ ] 为有 Session identity 的 completed/error/approval-needed 建立持久通知索引；全局 VCPLog/VCPInfo 仍保持 ephemeral。
7. [ ] 将 Plan 投影为 composer 邻近的结构化步骤 dock，并为 Diff 增加文件选择与导航。

2026-08-01 working-tree：Activity Center 已增加只读“计划”和“变更”Inspector。计划只从 Codex `plan` Item 的 projection 派生；变更只读取已有 `fileChange.changes.files` 的 16 文件/128 KiB 有界模型，不从 Markdown 推导、不提供 apply 操作。Usage 现在明确标记 `real`、`estimated` 或 `unknown`；没有显式来源的 token-shaped 字段不会显示成真实 usage。VCPInfo/marker/ToolBox observation 有 100 条有界 Renderer ring 与未读计数，打开活动中心即归零，不进入 Topic/SQLite。Compaction 已修正为消费 Codex 真实 `compaction.started/completed/failed` 事件（同时兼容旧 `context.compaction.*`），面板仅在终态后报告完成。`test:codex-projection-store` 覆盖 plan/fileChange 持久化，`test:agent-workbench-store` 覆盖 usage provenance、unread ring 和 compaction event，`test:agent-workbench` 覆盖 Workbench 挂载。Inspector 视觉/性能及真实验收仍待。

### 7. GUI-R6：真实验收

合并上述最小端口后，执行 JSDOM、Projection、Runtime、Electron 与 live ToolBox gate。验收必须包括双 Thread 并发、取消隔离、富消息截图、scroll anchor <= 2 px、10 Agent/50 Session、真实动态工具和审批；不能用仓库 clone、fixture 移植或空页面截图代替。

2026-08-01 R6 working-tree 收据：`test:electron-codex-smoke`、`test:codex-app-server-real`、`test:codex-app-server-adapter-real` 与 explicit `test:codex-toolbox-live` 均通过；后者实际验证 Nova 到 `FileOperator(ReadFile)` 的 dynamic `vcp_invoke` 与结构化 projection。富消息截图/scroll、10 Agent/50 Session、双 streaming cancel 隔离与真实审批仍是阻塞 gate。

## 明确不采用

- Cherry Studio AGPL 源码、SQLite schema 或 Claude SDK adapter；只 clean-room 借鉴结构。
- CodexMonitor/assistant-ui 的 React UI、DeepChat/acp-ui 的 Vue/Tauri shell。
- DeepChat Agent loop、Tape、MCP、工具系统；OpenCode Agent SDK 和完整 Session UI。
- Harnss 的本地 ID 生成、任何 blanket auto-approve、任何工具名重写。
- 相邻 clone 目录作为 VChat runtime dependency。

## 每个端口的完成收据

每个端口提交必须记录来源路径/revision/license、目标文件、保留行为、删除行为、测试命令、体积变化。纯算法移植至少包含上游 fixture 和 VChat identity/fail-closed 增量 fixture；未满足时只能标记 implemented。
