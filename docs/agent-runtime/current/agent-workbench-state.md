# GUI 状态边界

```text
Renderer Workbench (projection)
  → preload allowlist
  → Electron Main (validate, supervise, forward)
  → vcp-agentd (Session/Turn/Topic/approval/tool loop)
  → VCPToolBox (model/plugins/marker/backend approval)
```

Electron Main 的 `RustAgentRuntimeManager` 是 daemon client：只保存 transport、当前 attachment、控制请求 waiter、短暂 UI diagnostic。它不得保存 messages/events/usage/artifacts/pending approvals，也不得实现压缩、工具或 Topic 持久化。

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

## R3-A：新建与打开 Topic 的产品流程

“新建会话”不是直接向 daemon 附着一个隐式 Session。所有 Workbench 入口（助手页、会话页、设置页、Header 与 composer）都先打开一个仅在页面存活期存在的 Topic flow：

```text
新建 → 选择共享 Agent / 模型 / workspace / 标题 → 明确“创建并打开”
打开 Topic → read-topic(snapshot) → 展示 checkpoint 与 lease 状态
  ├─ 空闲 → 明确“打开并恢复” → create-session(resume)
  └─ 被占用 → “只读查看 checkpoint”或“请求安全接管”
```

表单及 checkpoint 摘要属于 Renderer 临时投影，不能写入 localStorage 或成为 Topic/transcript 的副本。Agent 目录和模型目录来自 VCPChat 已共享的 catalog；Workbench 不直接把 ToolBox `/v1/models` 当成第二份 UI 真源。

`read-topic` 失败时流程必须停在错误页，不能猜测或直接附着。占用 Topic 的只读动作不会取得 lease；安全接管只会要求 Rust daemon 协调旧持有者 checkpoint/release，lease 未释放或超时即保持不可写。空闲 Topic 也必须在用户看到 snapshot 后明确确认恢复。这个流程将“Topic 是持久对象、attachment 是临时写入者”的边界呈现在 UI 中，而不把它藏在侧栏点击事件里。

R3-A 已完成：`npm run test:agent-workbench` 覆盖创建参数、空闲恢复与占用接管；Workbench 已移除 `cloneMainButton` 和主聊天 search DOM clone，改为自身拥有的按钮、搜索基元加共享 CSS token。2026-07-29 的 default Electron smoke 已验证创建/打开、680/960/1440 layout、close/reopen、crash/reconnect；`npm run test:electron-topic-takeover` 的隔离双窗口收据验证协作 lease 释放、checkpoint 读取和安全接管。该组证据对应 daemon source revision `8b3fb40aea55d7a711eebca4bccd8441dcd77726610c912506d133a9cc0c6303`；后续 R3-B/R4 改动必须重跑相关 gate，不能把历史结果外推成新的视觉或 ToolBox 证据。真实 ToolBox 长流、审批与 WS 卡属于 R3-B，不得据此标记完成。

## R3-B：真实 Block 的视觉与滚动契约

工具卡、审批卡与 ToolBox WS 卡都是 daemon event 的投影：Renderer 不得补造状态、改变事件名或把后端审批关联为本地工具调用。`tool.requested → approval.requested → tool.running → tool.completed|failed|cancelled` 的时序必须按 daemon event 显示；后端 ToolBox 审批只能显示为“未关联”。

本地审批的绝对 `expiresAtMs` 由 Rust Host 生成。Host 到期后向 Core 发送 fail-closed deny，并以 `approval.resolved` 结束投影；Renderer 只能显示倒计时，不能自行调用 approval API 制造超时拒绝。审批 binding 由事件信封的 `sessionId + turnId + toolCallId` 与 payload 的 `argumentsHash` 组成，Reducer 只能复制这些已声明字段，不能从 active Turn 推断。

Electron 回归固定覆盖 680/960/1440px。默认 hermetic smoke 断言 Workbench/Topic flow/readiness 不卡横向溢出；真实 ToolBox opt-in 单独验证 FileOperator、长工具参数、本地审批、只读 WS 卡、至少 4,000 字符长流和滚动锚点。真实长流或 WS 未跑不等价于产品已完成。

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
