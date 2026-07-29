# Topic、压缩与恢复

`topicId` 是持久身份；`sessionId` 是 daemon 进程内短生命周期 attachment。每个 Topic 由 Rust Store 管理 `history.json`、`agent-state.json` 与 `.vcp-agent.topic-lock.json`。历史为已脱敏有界投影，不能保存 API Key、原始大工具结果或 reasoning。

- renderer reload、daemon restart、Workbench reattach 一律调用 `read-topic` 重建消息；localStorage 只可存最后打开的 `topicId` 指针。
- 同一 Topic 只有一个 writer。lease 由 daemon heartbeat 维护；接管先请求旧 owner 取消、checkpoint、释放，只有过期/已死亡 PID 可安全回收。
- 未完成 Turn 恢复为 `interrupted`，绝不重放模型或工具调用。
- 手动 compact 在活跃 Turn 时由 Rust 拒绝。Main 必须等本次请求之后的 `context.compaction.completed|failed`，完成后 Renderer 再读 Topic 刷新。ack 不是压缩完成。

Renderer 可持有当前 attachment 与即时渲染投影，但不是 transcript 真源。
