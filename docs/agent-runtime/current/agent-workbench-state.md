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

Ctrl+R 时 Electron Main 与 daemon 可以仍在运行。Renderer 先读取 `agentRuntimeGetStatus().attachment`，若存在则按上述事务读取该 Rust Topic；不能因为 Topic lease 显示 `inUse` 就清空页面，也不能从 localStorage、旧 JS Session 或 Main 内存 transcript 恢复。新建 Topic 在首次 safe checkpoint 前允许 `read-topic` 为空/失败；Renderer 保留真实 attachment 和空历史，绝不伪造消息。

localStorage 只允许 `{"topicId":"…"}` 这个首屏指针；不得保存 title、model、agent、workspace、Turn、工具、审批或任何 transcript。`set-workbench-presence(false)` 必须穿过 Main 到 Rust；Rust 会 fail-close 未决本地审批，Main 不得复活旧 ApprovalBroker。Main 公开 attachment daemon PID 仅作进程监督/诊断，不能成为业务状态或第二份 session 目录。

Workbench 状态机为 `disconnected → starting → idle → running → awaitingApproval → reconnecting | error`。持久侧栏来自 `list-topics`；当前会话显示是 attachment；历史来自 `read-topic`；流式内容来自稳定 daemon event。任何新增前端状态必须先说明它为何不是新的业务真源。
