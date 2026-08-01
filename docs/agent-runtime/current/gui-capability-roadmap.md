# Codex Agent GUI 能力路线图

状态：**experimental / planned**。本文是 VChat 接入 Codex App Server 后的 GUI 产品能力真源。它描述用户应看到和能够操作的界面，不改变 Codex、Projection SQLite、VCPToolBox 的权威边界。

## 产品结构

```text
Agent Workbench
├─ Agent / Session 导航
├─ 消息与任务时间线
├─ Composer
├─ Activity Center
│  ├─ 审批
│  ├─ 后台任务
│  ├─ 通知
│  └─ Runtime 状态
└─ Inspector
   ├─ Plan
   ├─ Diff / 文件变化
   ├─ Context / Usage
   └─ Session 设置
```

数据职责固定为：Codex Thread 是执行与上下文权威；Projection SQLite 是完整、持久的展示投影；Electron Main 是数据库唯一 writer 和 App Server transport；Renderer 只保存草稿、展开状态、滚动位置等页面临时状态。GUI 不读取 Codex rollout，不直接连接 ToolBox，也不根据当前选中 Session 猜测事件归属。

## 当前基线

截至 2026-08-01，VChat 已具备 SQLite Session 快路径、canonical Agent identity、Session Thread warm、Full Fork Message renderer、首发 thinking/streaming 骨架、基础 Block registry、fork/interrupt、模型/workspace/附件基础 UI。UX-R0 至 UX-R4 已进入 `29c2068a`，不能再列为未来工作。

当前真实缺口是：requestUserInput、permissions 和 MCP elicitation 的明确处理；Plan、Diff、usage、compaction 专用 UI；完整资源与 warning；富消息 Electron 视觉/性能门槛；旧 Rust Topic/attachment/takeover 术语清理。Session reducer、archive/restore/pin、基本 Composer 闭环、streaming accumulator、interaction registry、compaction terminal waiter 与有界 diff model 已在本 working tree 实现，但尚未提交，仍只能视为 checkpoint。

本轮 Renderer 展示实现由并行开发线负责。本路线图只固定能力合同、数据来源和验收门槛，合并时必须满足本文约束。

### 2026-08-01 能力审计矩阵

| 能力 | 现状 | 判定 |
|---|---|---|
| SQLite 首帧、后台对账、Thread warm、canonical Agent identity | 已进入 `29c2068a`，有 Runtime/Projection/Workbench 测试 | checkpoint pass |
| Full Fork Message renderer、thinking/streaming、基础 Tool/Approval/Observation/Error Block | 已进入 `29c2068a`；富消息截图和真实性能仍缺 | checkpoint pass / GUI-R6 pending |
| `vcp_invoke`、Responses adapter、Bridge 基础审批/VCPInfo | hermetic/checkpoint 证据存在，动态工具和 replay/reconnect live 不完整 | partial live |
| archive / restore / pin | Repository、Runtime、IPC/preload 与纯 UI state 已接线；delete 与 Electron UI gate 尚缺 | working-tree checkpoint |
| Session UI reducer、后台 running 状态统一 | `reduceAgentSessionUiState` 已按 Session/Thread/Turn/Request identity 路由；unread/scroll anchor 尚缺 | working-tree checkpoint |
| requestUserInput、permissions、MCP elicitation | 统一 Interaction Registry/IPC 与三类 hermetic UI 已完成；真实触发待验收 | hermetic working-tree pass |
| Plan、fileChange、contextCompaction | fileChange 已按 Codex 原始 `changes` 归一化为有界只读 diff model；Plan/Compaction 有安全摘要 | partial，缺专用 Block/Inspector UI |
| Usage/context | Responses usage 和旧兼容 panel 存在 | partial，缺 Codex 来源/估算标记与水位语义 |
| Composer send / steer / follow-up | 提交幂等，steer 与持久纯文本 follow-up queue 已区分；附件排队拒绝 | working-tree checkpoint |
| GUI compaction | `thread/compact/start` 已有终态 waiter：ACK 不完成，等待 `contextCompaction` terminal item 后 `thread/read` 对账；超时/crash/失败 reject | working-tree checkpoint |
| Activity Center、未读游标、bounded ring | 稳定 shell、分 Tab 未读、搜索/筛选、100 条 ring、Plan/Diff/Usage/Connection 已接线 | hermetic working-tree pass；视觉/性能 pending |
| frozen-tail Markdown、结构化 Diff Inspector | frozen-tail Markdown 与累计/重叠 delta 净化已在 working tree 接入并有 DOM identity fixture；Diff Inspector 未引入 | partial / working-tree checkpoint |
| 2 px scroll、10 Agent/50 Session、双 streaming live | 未形成完整收据 | GUI-R6 pending |

外部复用的具体文件和边界见 [gui-reuse-implementation-plan.md](gui-reuse-implementation-plan.md)。clone 目录只是审计快照，不是运行时依赖。

## 执行 Profile

当前正式产品只有 `toolbox-only`：

- 模型可见工具集合必须精确为 `[vcp_invoke]`；
- VCPToolBox 是插件、动态工具 catalog、工具执行和后端审批权威；
- GUI 不显示无法执行的 Shell、MCP、Plugin、Collaboration 或 Subagent 开关；
- App Server 支持某项能力，不代表 VChat 已启用该能力。

未来如需 Codex 原生 Shell、文件修改、MCP 或协作能力，必须新增独立 `codex-native` profile，并分别定义权限、审批、工具可见面和验收。不得在 `toolbox-only` 中逐项偷开。

## GUI-R0：协议与能力矩阵

目标：GUI 只消费当前固定 Codex 版本真实提供且 VChat 明确启用的能力。

- 对 Codex CLI `0.146.0` / source `e363b08c9175ac1cbe5893615dd2cb9ddf95043b` 生成并固定 stable/experimental TypeScript/JSON schema fixture。
- 将 Method、Notification、Item 和 Server Request 标为 `stable`、`experimental` 或 `unsupported`。
- 初始化后依据版本和 capability discovery 建立会话能力，不按最新 Codex 源码猜字段。
- schema 或 capability 不兼容时 fail-closed，并在 Runtime 状态中显示具体缺口。
- 分离 `toolbox-only` 与未来 `codex-native` 的能力矩阵。
- 优先移植 openclaw-codex-app-server 的 permission/pending-input/compact/interrupt fixture，并用 CodexMonitor server-request 测试补边缘情况；不替换现有 transport。

当前 Codex `0.146.0` experimental schema 的 Item inventory 包括 `userMessage`、`hookPrompt`、`agentMessage`、`plan`、`reasoning`、`commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`subAgentActivity`、`webSearch`、`imageView`、`sleep`、`imageGeneration`、`enteredReviewMode`、`exitedReviewMode` 和 `contextCompaction`。这份 inventory 来自固定 release fixture，只用于 capability gate 与 Unknown fallback，不等于 `toolbox-only` 已启用全部类型。

| 能力组 | `toolbox-only` 策略 |
|---|---|
| user/agent message、reasoning、plan、compaction | 投影并提供规范 UI。 |
| dynamicToolCall | 只允许 `vcp_invoke`，转发 VCPToolBox。 |
| imageView、imageGeneration、附件资源 | 只读结构化展示；不得把 Base64 写入投影。 |
| commandExecution、fileChange、MCP、collaboration、subagent、webSearch | 默认禁用；历史或异常 Item 只读展示并标记来源，不提供执行开关。 |
| hookPrompt、sleep、review mode | 先纳入 schema/Unknown fixture；完成产品语义评审前不暴露控制项。 |

退出门槛：协议 fixture、运行版本和 GUI capability gate 一致；未知 Item 可安全显示为受限 fallback，但未知交互请求不能返回伪成功。

## GUI-R1：Session 导航与状态机

目标：Session 切换即时，后台 Thread 独立运行，所有状态按完整身份路由。

- 提供搜索、重命名、置顶、归档、删除和恢复。
- 每个 Session 独立保留页面生命周期内的草稿、附件 descriptor、展开状态和滚动位置。
- 侧栏显示后台 Thread 的 running、approval、input、error 和 reconnect 徽标。
- 建立 Renderer-only 纯 reducer：

```text
idle
warming
starting
streaming
waiting-native-approval
waiting-vcp-approval
waiting-user-input
interrupting
completed
interrupted
reconnecting
orphaned
error
```

- 状态转换必须按 `sessionId + threadId + turnId` 路由；selected Session 只控制展示，不能参与事件归属推断。
- 纯 reducer 优先端口 CodexMonitor `threadReducer` fixture，并用 DeepChat lifecycle/session status fixture 补 close、reconnect、query 不启动 Runtime 等边界；禁止移植本地伪 ID。

退出门槛：取消 A、审批 B、切换 C 不串状态；SQLite 快照立即显示，后台 `thread/read` 对账不阻塞选择。

## GUI-R2：Composer

目标：达到主聊天同构的输入体验，同时保留 Agent 的执行语义。

- 支持 send、stop、steer 和 follow-up，并明确区分排队与当前 Turn steering。
- 提供 Session-scoped 模型、reasoning effort、workspace 和权限设置。
- 使用 descriptor 处理图片、音频和文件；路径/Base64 不进入 localStorage 或 transcript。
- 冷启动和 Thread warm 期间立即保留草稿并显示可解释的恢复状态。
- 模型、权限或 workspace 保存失败时不得静默使用旧值。
- 当前 Nova 模型继续来自 VChat `/v1/models`；仅未来 `codex-native` profile 使用 App Server `model/list`。
- pending input、submission cancellation、queue/steer 分离优先抽取 DeepChat 纯模块和 CodexMonitor user-input fixture；不引入其 Agent loop、Tape 或 UI framework。

退出门槛：新 Session 首发无需盲等；重复 Enter/点击不会重复发送；切换 Session 不丢草稿或附件。

## GUI-R3：规范时间线 Block

目标：所有 App Server Item 和 VCP 结果进入同一规范时间线，不显示原始协议 JSON。

必须有专用展示：message、reasoning、plan、VCP dynamic tool、command execution、file change/diff、attachment/resource、approval、context compaction、error/interrupted、VCPInfo/notification。

每个 Block 使用 Codex `threadId/turnId/itemId/callId` 与 ordinal 构成稳定 identity。流式 delta 原地更新；完成后执行 Markdown、LaTeX、Mermaid、代码高亮、链接、表格、图片和 VCP marker 后处理。Unknown fallback 必须限长、脱敏、可诊断，不能成为第二条工具执行通道。

流式稳定性优先端口 OpenCode `markdown-stream` 的 frozen-tail 算法和 Harnss `streaming-buffer` fixture。只移植纯算法，不导入 SolidJS/React、OpenCode SDK 或 Session 状态。

退出门槛：`assistant -> tool -> assistant` 顺序稳定；重复/乱序通知幂等；工具、资源、warning、diff 和 compaction 不退化为大段 JSON。

## GUI-R4：审批与交互中心

目标：所有需要用户决策的请求集中可见，但身份和响应通道严格分离。

必须区分 Codex command approval、Codex file approval、Codex permission request、Codex requestUserInput、MCP elicitation、VCP local approval、ToolBox backend approval。

卡片必须显示 Agent、Session、来源、路径/目标、风险和过期状态；动作至少包括 allow once、允许当前 Session、deny。仅在协议真实支持时显示持久允许。Workbench 关闭、Runtime crash、请求超时或身份不匹配时统一 fail-closed。

队列状态优先端口 Harnss `permission-queue`；requestUserInput/approval 行为 fixture 来自 CodexMonitor 与 openclaw。三类审批 ID 和 response channel 仍由 VChat 合同重新定义。

退出门槛：每个 JSON-RPC request ID 只响应一次；切换 Session 不隐藏未决请求；本地、Codex 和 ToolBox approval ID 不互换。

## GUI-R5：Inspector 与 Activity Center

目标：把长任务的计划、变化、上下文和运行状态从聊天正文中分离出来。

- Plan 面板展示最新计划、步骤状态和来源 Turn。
- Diff/review 面板展示 file change、patch、路径和审批状态，不从 Markdown 猜 diff。
- Context/usage 显示 Codex token usage、上下文水位和数据来源；ToolBox 不返回真实 usage 时必须标记估算值。
- Compaction 通过 `thread/compact/start` 发起并展示 started/completed/failed，不以 ACK 代替完成。
- Runtime 状态展示 App Server、Projection、Bridge、ToolBox 和 DistributedServer，凭据必须脱敏。
- Activity Center 使用有界通知环、未读游标和类型过滤；无可靠 Thread identity 的 VCPInfo 保持全局。
- orphaned Session 保留完整只读 SQLite 历史和明确恢复说明，不伪造新 Thread。
- Diff 纯函数优先端口 OpenCode `session-diff`/`apply-patch-file`；usage、tool formatting、notification fixture 可按需抽取 Harnss。`@pierre/diffs` 必须先过约 6.9 MiB unpacked size gate。

2026-08-01 working-tree 状态：右侧面板已按 OpenCode 的职责分离机制实现两组稳定 Tab。Inspector 当前包含
Context、Plan；Activity Center 包含 Notifications、Approvals、Diagnostics。Header context ring、
Session/provider/model/message/time 元数据、input/output/reasoning/cache token、usage 来源、可见 Projection
估算构成和只读 Agent instruction 已接线。费用在没有可靠价格表时显示不可用。安全预算不再混入 Context，
而位于 Agent Settings。Tab panel DOM identity 与独立滚动位置已有 JSDOM/Electron gate；1100px 以下面板
以最大 380px overlay 展示。

仍缺的 OpenCode 对齐项必须保持边界清晰：

- 持久通知只接 Session completed/error/approval-needed 等具有可靠 identity 的生命周期事件；全局
  VCPLog/VCPInfo 仍是临时 observation；
- Plan 应进一步投影为 composer 邻近的结构化步骤 dock，但 SQLite/Codex Item 仍是唯一数据来源；
- Changes 需要文件计数、选择和导航，不得提供 apply patch，也不得从 Markdown 猜 diff；
- `toolbox-only` 暂时隐藏 Changes：本机真实 Projection 已证明 FileOperator WriteFile 仅产生
  `dynamicToolCall` 且没有 `fileChange`/可靠最终路径；重新开放前必须有 Bridge mutation receipt；
- 非交互卡仍需 keyed patch 和长流性能门槛；当前仅保证 tab panel shell 稳定。

退出门槛：Inspector 不持有第二份 transcript；刷新后由 SQLite + `thread/read` 重建；通知不会写回模型历史。

## GUI-R6：视觉、性能与真实验收

目标：以真实 Electron 和真实 ToolBox 链路证明产品体验，而不是只验证页面能打开。

- 深浅主题、1440x900、1024x720 及窄窗口截图。
- 富消息、reasoning、plan、diff、审批、工具、图片、文件、warning 和通知视觉验收。
- 非底部 scroll anchor 漂移不超过 2 px；底部 follow mode 在长流中稳定。
- 10 个 Agent、50 个 Session 的搜索、切换、置顶、归档和恢复。
- 记录冷/warm Thread 的点击到首帧、发送到 ACK、发送到首个可见 delta 延迟。
- App Server/Bridge crash 与 restart；两个 streaming Thread 并发，取消 A 不影响 B。
- 真实 Nova、FileOperator、ToolBox backend approval、VCPInfo 和 interrupted checkpoint。

退出门槛：`test-matrix.md` 对应阻塞项全部有干净 commit 的 hermetic 或 live 收据；在此之前保持 experimental，不宣称 Cherry 等价体验或产品完成。

## 禁止边界

- 不 fork 或 vendor Codex，不读取/修改 rollout。
- 不在 Renderer 访问 Codex stdin、SQLite、API Key、VCPLog 或 VCPInfo WebSocket。
- 不把 Projection SQLite 当作 Codex 上下文权威。
- 不因 App Server 的源码类型存在就暴露无实现的 GUI 控件。
- 不复制 Cherry Studio 的 AGPL 源码；仅 clean-room 借鉴“持久展示投影与 Runtime 分离”的机制。
- 不修改 ToolBox 来迁就 VChat；协议兼容层属于 VChat/Bridge。

## 参考

- OpenAI Codex App Server 文档：https://developers.openai.com/codex/app-server/
- API overview：https://developers.openai.com/codex/app-server/#api-overview
- Models：https://developers.openai.com/codex/app-server/#models
- Skills：https://developers.openai.com/codex/app-server/#skills
