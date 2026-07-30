# Topic、压缩与恢复

`topicId` 是持久身份；`sessionId` 是 daemon 进程内短生命周期 attachment。每个 Topic 由 Rust Store 管理 `history.json`、`agent-state.json` 与 `.vcp-agent.topic-lock.json`。历史为已脱敏有界投影，不能保存 API Key、原始大工具结果或 reasoning。

## 物理数据域

Rust Agent Topic 的当前根目录固定为：

```text
AppData/AgentRuntimeData/<agentId>/topics/<topicId>/
```

它与主聊天 JSON 真源 `AppData/UserData/`、VCP-CDS SQLite 镜像及 Tantivy
索引是不同数据域。`agent-state.json` 是模型恢复 checkpoint；`history.json` 只是有界、
脱敏的 UI 投影。VCP-CDS、DeepMemo 与 MobileSync 均不得将它解释成普通聊天 Topic，
也不得向它写回。

从旧版本升级时，Rust Host 会扫描 `AppData/UserData/`，但只迁移同目录存在
`agent-state.json` 的 Topic。普通 VChat Topic 不会被移动；活跃 lease 或目标路径冲突会
使启动 fail closed，不做目录合并。迁移以 Topic 目录为单位使用同卷 rename，保留
checkpoint、history、continuation 与 lease 文件。

完整扫描成功后，Host 原子写入：

```text
AppData/AgentRuntimeData/.agent-runtime-migration-v1.json
```

标记记录版本、完成时间、旧根路径与迁移数量。后续启动不再遍历数千个普通 VChat
Topic。活跃 lease、目标冲突、损坏目录或写标记失败时，标记保持不存在；下一次启动可继续
安全扫描，不能把部分迁移谎报为完成。

## Agent 只读影子索引

Agent 搜索采用与主聊天 VCP-CDS 相同的数据分层，但不依赖 Electron 的 CDS 进程：

```text
agent-state.json                 恢复/checkpoint 唯一真源
history.json                     有界、脱敏 UI/搜索投影
AgentRuntimeData/.index/         Tantivy 影子索引，可删除、可重建
```

共享 `vcp-shadow-index` leaf crate 提供 Jieba 中文分词、VChat 既有权重/排除查询语法、
Topic 替换、删除、重建与限长搜索。VCP-CDS 和 Agent Host 复用该查询规范，但使用不同数据
根和不同生命周期；`vcp-agentd` 不连接 CDS HTTP/token。Tantivy 只允许一个 writer，第二个
进程以只读方式打开已提交索引并在 `get-index-status` 中报告 `writable: false`，不会因此
阻断聊天、checkpoint 或只读搜索。

新消息由 Rust Core 生成稳定 `messageId + turnId + timestamp`；Topic 投影原样保留。
旧 checkpoint 缺失 ID 时使用 `role + content + ordinal + turnId` 的确定性 SHA-256
兜底，因此重复保存、同毫秒消息和 continuation 不会造成索引主键漂移。索引命中只包含
`agentId/topicId/messageId/turnId/snippet/score` 等定位字段；真正打开仍走 `read-topic`。

CDS 同时保留防御性约束：

- watcher/ingest 发现 `agent-state.json` 或 `.vcp-agent.topic-lock.json` 时忽略对应
  `history.json`；
- MobileSync Push 只允许 Agent/Group `config.json` 明确列出的普通 Topic；
- orphan Topic 与带 Rust Agent checkpoint 标记的 Topic 均拒绝写回；
- Agent 保存、恢复、lease、takeover 与 compact 不依赖 CDS 可用性。

- renderer reload、daemon restart、Workbench reattach 一律调用 `read-topic` 重建消息；localStorage 只可存最后打开的 `topicId` 指针。
- 同一 Topic 只有一个 writer。lease 由 daemon heartbeat 维护；接管先请求旧 owner 取消、checkpoint、释放，只有过期/已死亡 PID 可安全回收。
- 未完成 Turn 恢复为 `interrupted`，绝不重放模型或工具调用。
- 手动 compact 在活跃 Turn 时由 Rust 拒绝。Main 必须等本次请求之后的 `context.compaction.completed|failed`，完成后 Renderer 再读 Topic 刷新。ack 不是压缩完成。

Renderer 可持有当前 attachment 与即时渲染投影，但不是 transcript 真源。

Workbench 点击规则固定为：任何 Topic 先只读 `read-topic` 预览；首次发送时才安全切换 attachment；与当前 Main attachment 相同的 Topic 幂等
复用；外部有效 lease 的 Topic 只读打开并显示 inline banner，只有用户点击“请求接管”才发起
Rust 协作接管。无论哪条路径，Renderer 都不得用旧 JS Session、localStorage transcript 或
Main 内存消息补齐内容。

## 当前验证

2026-07-30 在 `codex/vcpchat-rust-agent-origin-sync`、基线提交 `4209a1ec` 加当前隔离
工作树上执行：

```powershell
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
cargo fmt --manifest-path rust_chat_data_service/Cargo.toml --check
cargo clippy --manifest-path rust_chat_data_service/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust_chat_data_service/Cargo.toml
node scripts/test-rust-protocol-fixture.mjs
node scripts/test-rust-agent-runtime.mjs
node scripts/test-agent-workbench-store.mjs
node scripts/test-agent-workbench.mjs
npm run build:daemon
npm run test:rust-daemon-smoke
npm run test:rust-topic-takeover
npm run test:electron-topic-takeover
npm run test:electron-gui-smoke
git diff --check
```

本次 Rust source revision 为
`3be0430538a760b30b932647529d4527baa1ad07c72bd1376b797f8f32814f33`。Rust
workspace 注册 1163 项测试且所有非 ignored 测试通过，VCP-CDS 19 项通过；两边 fmt 与
clippy `-D warnings` 均通过。共享 v1.5 fixture、Runtime manager、Workbench store/UI、
release daemon framed smoke、daemon 与双窗口 Electron Topic 接管、完整 Electron GUI smoke
均通过。GUI smoke 同时核验运行 daemon 报告的 build revision 与当前 Rust 源码一致。本收据
仍是 hermetic 证据，不外推为真实 ToolBox、DistributedServer capability 或发布证据。
