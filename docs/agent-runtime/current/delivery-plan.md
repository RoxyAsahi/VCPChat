# R0–R2 交付与证据矩阵

状态规则：只有该行的代码、文档和指定验证都通过，才能改为 `complete`。过去某次通过、真实 ToolBox 曾可用或旧分支证据均不计入当前 revision。

| 阶段 | 门槛 | 状态 | 当前证据 |
| --- | --- | --- | --- |
| R0 | 仅 `current/` 定义产品；Pi/Driver/SQLite/submodule/`vcp_delegate` 均归档 | complete | 2026-07-29，hermetic 文档拓扑审计：`rg` 当前/根入口审计、`npm run check:rust-agent-runtime`、`git diff --check`；Rust source revision `73effc24b6ddb3453c8a21adc6d9b363f79558b960f8e647a0a9c1cdba7da982`。这些旧术语只在明确的 history 指针或“非当前”说明中出现。 |
| R1 | v1.2 command/ack/event schema、Rust/JS fixture、ready runtime 校验 | complete | 2026-07-29，hermetic：`node scripts/test-rust-protocol-fixture.mjs`、`npm run check:rust-agent-runtime`、`npm run test:rust-daemon-smoke` 与 `cargo test --manifest-path rust/Cargo.toml -p vcp-agent-protocol -p vcp-agentd`。direct command 仅保留本文件列出的集合；旧 `start-session`、`list-agents`、`list-models`、`tool-result` fixture 均 fail closed；Renderer 不再用 ACK/active Turn/旧工具状态推断关联。Rust source revision `73effc24b6ddb3453c8a21adc6d9b363f79558b960f8e647a0a9c1cdba7da982`。 |
| R2 | Topic 真源、单 attachment、snapshot-first、presence close、无 Main replay | complete | 2026-07-29，hermetic：`npm run test:agent-workbench-store` 验证初始化先订阅、read-topic 期间 delta 进入 Renderer barrier，且 Main status 不会清空审批投影；`npm run test:rust-agent-runtime` 验证 Main 不暴露审批集合并在显式 close 后清除 attachment；`npm run test:agent-workbench`、`npm run test:electron-gui-smoke`、`npm run test:electron-topic-takeover` 验证当前活动侧栏、close/reopen、crash/reconnect 与 takeover；`npm run check:rust-agent-runtime`、`cargo fmt --all --check --manifest-path rust/Cargo.toml`、`cargo clippy --manifest-path rust/Cargo.toml --workspace -- -D warnings`、`git diff --check` 通过。Rust source revision `73effc24b6ddb3453c8a21adc6d9b363f79558b960f8e647a0a9c1cdba7da982`。 |

## 当前可重复验证

R0–R2 已在 2026-07-29 以 hermetic 模式完成本 revision 的验收。下列是每次 Runtime 修改后都必须重新运行的门槛；不得将本次结果外推到未来 revision。

```powershell
npm run build:daemon
node scripts/test-rust-protocol-fixture.mjs
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:rust-agent-runtime
npm run test:rust-daemon-smoke
npm run test:agent-workbench-store
npm run test:agent-workbench
npm run test:electron-gui-smoke
npm run test:electron-topic-takeover
```

还必须执行 `cargo fmt --all --check --manifest-path rust/Cargo.toml`、`cargo clippy --manifest-path rust/Cargo.toml --workspace -- -D warnings`、`cargo test --manifest-path rust/Cargo.toml --workspace`、`git diff --check` 与 R0 文档拓扑审计。Electron smoke 只有在明确显示通过后，才能作为 Topic attachment、Workbench projection、daemon crash/reconnect、close/reopen、takeover 和退出清理的证据。

真实 ToolBox 验收仍是单独的 opt-in gate，必须设置 `VCP_AGENT_LIVE=1`，且不得回显密钥。它不属于 R0–R2 的完成证据，也不能被本次 hermetic 通过替代；普通聊天、真实工具、高风险拒绝、取消和长会话压缩须在有 ToolBox 环境时重新记录。
