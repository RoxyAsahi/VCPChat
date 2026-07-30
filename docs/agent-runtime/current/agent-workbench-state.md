# GUI 状态边界

```text
Renderer Workbench (projection)
  → preload allowlist
  → Electron Main (validate, supervise, forward)
  → vcp-agentd (Session/Turn/Topic/approval/tool loop)
  → VCPToolBox (model/plugins/marker/backend approval)
```

Electron Main 的 `RustAgentRuntimeManager` 是 daemon client：只保存 transport、当前 attachment、控制请求 waiter、短暂 UI diagnostic。它不得保存 messages/events/usage/artifacts/pending approvals，也不得实现压缩、工具或 Topic 持久化。

在尚未创建 attachment 时，Main 启动的是 `vcp-agentd --direct --control`。该
control daemon 只处理 Agent catalog、Topic read/list/search、影子索引状态/重建、共享 settings 与其它控制请求；
它**不得创建 Topic 目录、lease 或 Core Session**。用户确认“创建并打开”或“打开并恢复”
后，Main 停止 control daemon，再启动唯一的普通 daemon attachment。于是“读取 checkpoint”
永远不可能把某个 Topic 标记成占用，也不会为一个隐藏的临时 Topic 建立第二个写入者。

这与 Cherry Studio 将 Claude SDK 作为黑盒 Agent Runtime 的接入原则相同：GUI 不理解或重跑 Agent loop，只负责命令、事件转发与 UI 投影。这里的黑盒实现是仓库内 `vcp-agentd --direct`；VCPToolBox 仍在该黑盒之外，继续是模型、插件、marker 执行和后端审批权威。

standalone `vcp-agent.exe` 不经过 Electron：它把 Rust TUI 直接接到同一个 `vcp-agent-host`。这不意味着 GUI 可以绕过 daemon 或复制 Host 逻辑。两种产品形态的固定边界是：

```text
Standalone: Rust TUI → Rust Host/Core → VCPToolBox
GUI:        Renderer → preload → Electron Main transport → vcp-agentd → Rust Host/Core → VCPToolBox
```

TUI 的布局、主题、输入、错误页、状态展示和终端清理属于 standalone 表面，不改变 GUI 架构。若需求涉及 Topic、usage、审批、ToolBox 事件或 Agent loop，应先在共享 Rust Host/Core 中形成稳定语义，再由 TUI 和 daemon 分别投影；禁止为了补 TUI 功能向 Electron Main 增加第二份业务状态。

Renderer 只有一份页面存活期的投影：`attachment`、流式 delta、Block 展开状态、滚动锚点和弹窗。它没有 Session 列表、artifact 缓存或持久 transcript。侧栏的持久对象是 Rust `list-topics` 的 Topic；当前 attachment 只是该 Topic 的临时写入者。

重新挂载、刷新、crash reconnect 和 Topic takeover 都必须采用下列 snapshot-first 事务：

```text
开始 snapshot barrier（缓存匹配 attachment 的 live event）
  → read-topic(snapshot, snapshotSequence)
  → 设置 attachment 并应用 Rust snapshot
  → 丢弃 sequence <= snapshotSequence 的缓存 event
  → 仅投影更晚的缓存 event
  → 解除 barrier；继续订阅 live event
```

`runtime.*`（包括 `runtime.readiness`）是 daemon-global 诊断事件，不属于
Topic transcript。它们在 attachment 尚未建立的 snapshot barrier 中也必须交给
Renderer reducer；不得因为没有当前 session 而丢弃异步 ToolBox 探测结果。此例外
不允许 Main 或 Renderer 自行探测、补造或推断 readiness。

Ctrl+R 时 Electron Main 与 daemon 可以仍在运行。Renderer 先读取 `agentRuntimeGetStatus().attachment`，若存在则按上述事务读取该 Rust Topic；不能因为 Topic lease 显示 `inUse` 就清空页面，也不能从 localStorage、旧 JS Session 或 Main 内存 transcript 恢复。新建 Topic 在首次 safe checkpoint 前允许 `read-topic` 为空/失败；Renderer 保留真实 attachment 和空历史，绝不伪造消息。

localStorage 只允许 `{"topicId":"…"}` 这个首屏指针；不得保存 title、model、agent、workspace、Turn、工具、审批或任何 transcript。`set-workbench-presence(false)` 必须穿过 Main 到 Rust；Rust 会 fail-close 未决本地审批，Main 不得复活旧 ApprovalBroker。Main 公开 attachment daemon PID 仅作进程监督/诊断，不能成为业务状态或第二份 session 目录。

Workbench 状态机为 `disconnected → starting → idle → running → awaitingApproval → reconnecting | error`。持久侧栏来自 `list-topics`；当前会话显示是 attachment；历史来自 `read-topic`；流式内容来自稳定 daemon event。任何新增前端状态必须先说明它为何不是新的业务真源。

侧栏搜索来自 `search-topics`，不是对已加载 DOM 的最终过滤。Renderer 只暂存当前 query、
loading/error 与命中列表；命中携带 durable `topicId/messageId`，点击后仍以 Rust snapshot
重建投影。Electron Main 不缓存搜索结果，Renderer 也不能用 snippet 代替 snapshot。

## R3-A：新建与打开 Topic 的产品流程

“新建会话”不是直接向 daemon 附着一个隐式 Session。所有新建入口（助手页、会话页、设置页、Header 与 composer）都先打开一个仅在页面存活期存在的 Topic flow；已有 Topic 的普通点击不再增加一层恢复确认框：

```text
新建 → 选择共享 Agent / 模型 / workspace / 标题 → 明确“创建并打开”
点击已有 Topic
  ├─ 空闲 → create-session(resume) → daemon snapshot-first 恢复 → 可写 attachment
  ├─ 已由本 Main attachment 持有 → 幂等复用 attachment，不重启 daemon/lease
  └─ 被外部进程占用 → 小型冲突确认 → 返回或“接管并继续”
```

正常打开必须和 VCPChat 主聊天一样无感：空闲 lease 不显示、不预读/展示 checkpoint，也不要求用户理解 attachment。只有 TUI、另一窗口或另一进程持有同一 Topic 时才展示冲突确认；该确认绝不读取或替换当前 transcript。表单和冲突确认只存在 Renderer 内存，不能写入 localStorage 或成为 Topic/transcript 的副本。Agent 目录和模型目录来自 VCPChat 已共享的 catalog；Workbench 不直接把 ToolBox `/v1/models` 当成第二份 UI 真源。

`read-topic` 失败时不能用旧 JS transcript、localStorage 或 Main 内存猜测内容。占用 Topic 的普通点击不能读取 checkpoint、不能替换当前 attachment；只有“接管并继续”会要求 Rust daemon 协调旧持有者 checkpoint/release。lease 未释放或超时即保持冲突状态。空闲 Topic 的普通点击直接恢复，避免用户每次打开历史都重复确认；真正会改变所有权的接管仍必须显式确认。

R3-A 进行中。2026-07-30 当前工作树已删除旧的只读 preview、占用 banner 与 checkpoint 打开弹窗，改为“空闲一键恢复、冲突才确认接管”。`npm run test:agent-workbench` 已覆盖并通过空闲恢复、外部冲突确认和接管；当前 revision 尚未取得新的 Electron 双窗口收据，不能沿用旧 preview 流程的历史收据。验收仍必须覆盖：空闲 Topic 直接恢复、外部占用不读/不替换当前 transcript、接管成功和超时、活动 Turn/审批时拒绝切换、关闭冲突确认后当前 attachment 不变。

## R3-B：真实 Block 的视觉与滚动契约

工具卡、审批卡与 ToolBox WS 卡都是 daemon event 的投影：Renderer 不得补造状态、改变事件名或把后端审批关联为本地工具调用。`tool.requested → approval.requested → tool.running → tool.completed|failed|cancelled` 的时序必须按 daemon event 显示；后端 ToolBox 审批只能显示为“未关联”。

本地审批的绝对 `expiresAtMs` 由 Rust Host 生成。Host 到期后向 Core 发送 fail-closed deny，并以 `approval.resolved` 结束投影；Renderer 只能显示倒计时，不能自行调用 approval API 制造超时拒绝。审批 binding 由事件信封的 `sessionId + turnId + toolCallId` 与 payload 的 `argumentsHash` 组成，Reducer 只能复制这些已声明字段，不能从 active Turn 推断。

Electron 回归固定覆盖 680/960/1440px。默认 hermetic smoke 断言 Workbench/Topic flow/readiness 不卡横向溢出；真实 ToolBox opt-in 单独验证 FileOperator、长工具参数、本地审批、只读 WS 卡、至少 4,000 字符长流和滚动锚点。真实长流或 WS 未跑不等价于产品已完成。

## R3-C：Renderer 临时投递与 sequence 时间线

Renderer 可以有一个**非持久**的 user message delivery projection，但它不是第二份 transcript：

1. `start-turn` ACK 接受后，创建 `pending-user:<turnId>`，状态为“发送中”。这解决了用户点击发送后必须等待首次模型事件才能看见自己消息的问题。
2. `turn.started` 或 `user.message` 使用 daemon 明确给出的 `messageId`、`turnId` 和 `sequence` 替换该临时 Part；`eventId` 只负责事件去重，不能冒充消息 ID。该 `messageId` 必须与 checkpoint/history/search 投影一致。
3. `runtime.crashed` 在确认前发生时，临时 Part 变为“发送状态未确认”。重新连接只执行 snapshot-first 的 `read-topic`；结果由 Rust Topic 决定，Renderer 永不重放。
4. 消息与工具卡以各自首个 daemon `sequence` 形成稳定 timeline。`lastSequence` 只记录更新进度，不能把工具卡移动到其最终完成事件的位置。
5. 用户正在阅读旧内容时，新 Part 只增加 Renderer 本地的未读提示并显示“回到最新”；它不改变 Topic、attachment 或 daemon 滚动语义，点击后才滚到实时底部。
6. 已完成工具卡在折叠时只投影 daemon 摘要；参数/完整结果的 DOM 在用户展开时才挂载。该延迟仅减少 Renderer 工作量，不改写、截断或缓存 Rust Topic 中的结果。

这借鉴 OpenCode 的 optimistic-confirmation 与 part timeline 体验，但不复制其运行时或存储边界。所有 sequence、identity、tool state 和 durable history 仍由 Rust daemon 给出；Electron Main 仍只是 transport，Renderer 仍只是页面存活期投影。

### OpenCode 对照边界

本地参考为 `C:\VCP\vchat-develop\opencode` 的 `message-timeline.tsx`、
`timeline/model.ts`、`basic-tool.tsx` 与 `dock-prompt.tsx`。本轮只采用四项交互
模式：乐观用户 Part 后由运行时确认身份、按 Part 的稳定 sequence 时间线、长工具详情
按需展开、以及阅读历史时显式回到最新。它们解决的是发送消息、流式结果和工具结果的
可读性，不改变数据归属。

明确不采用 OpenCode 的 SQLite/session server、SDK runtime、本地 shell/tool schema、
工具执行或持久化模型。VCPChat 的相应真源仍是 Rust Topic、`vcp-agentd` 事件和
VCPToolBox marker/后端审批；因此 Renderer 的 optimistic Part、展开状态和滚动锚点
只能停留在页面内存，绝不写入 localStorage 或 Electron Main。

## R4：Rust daemon readiness 的投影契约

连接面板固定展示四项无敏感信息的 daemon event：`server`、`profile`、`toolbox`、`capability`。Renderer Store 仅合并 `runtime.readiness`，不得读取设置、调用 HTTP、打开 WebSocket 或依据其他界面状态猜测可用性。

Rust Host 用受认证 `/v1/models` 更新 ToolBox 可达性；DistributedServer capability 只能从只读 VCPlog 生命周期记录推导。`/vcp-distributed-server` 会注册 node，不可连接来“检查”节点。未知必须保持未知，不能为了绿灯伪造 ready。

## 变更影响门槛

| 变更位置 | 对 VCPChat GUI 的影响 | 必须验证 |
| --- | --- | --- |
| `rust-tui/crates/vcp-agent-tui` 的布局、输入、主题、错误页、终端 guard | 无直接影响 | TUI 单元测试、release build、终端恢复 smoke |
| `vcp-agent-host` / `vcp-agent-core` | GUI 与 TUI 共用，存在行为回归风险 | `cargo test --workspace`、daemon smoke、Workbench store/adapter、相关 live gate |
| `vcp-agent-protocol` / `vcp-agentd` | 直接影响 GUI 黑盒边界 | fixture-first、Rust/JS 双向协议测试、Electron smoke |
| Electron Main / Renderer | 只允许 transport 与 UI 投影变化 | 不得新增 transcript、审批、usage 或工具真状态；snapshot-first 回归必须通过 |
| VCPToolBox | 当前计划不修改 | 保持现有模型、marker、插件与后端审批契约 |
