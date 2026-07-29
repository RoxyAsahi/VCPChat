# GUI / Rust Agent 状态索引

最后更新：2026-07-29。适用分支：`codex/vcpchat-rust-agent`。

这不是第二份架构、测试或发布说明。Rust Agent 的唯一当前文档真源在
[`agent-runtime/current/`](agent-runtime/current/README.md)：

- [daemon 协议](agent-runtime/current/daemon-protocol.md)
- [Topic 与恢复](agent-runtime/current/topic-and-recovery.md)
- [Workbench 状态所有权](agent-runtime/current/agent-workbench-state.md)
- [交付计划与验收门槛](agent-runtime/current/delivery-plan.md)

## 当前产品边界

VCPChat 的 Agent Workbench 将 `vcp-agentd` 当作唯一黑盒 Agent Runtime。
Electron Main 只监督进程与转发窄 IPC；Renderer 只持有临时 UI 投影；Rust
Topic Store 是持久化真源。VCPToolBox 仍是模型、插件、工具执行、动态提示词
与后端审批的唯一权威。

`Pi`、多 Driver、SQLite/submodule、`vcp_delegate`、本地 Shell/MCP/worktree
均不是当前产品路径；它们只可在历史文档中作为迁移背景查阅。

## 阶段状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| R0–R2 | 已提交 | `dc5330b7` 冻结了 Rust daemon v1.2、Topic 真源和 Main/Renderer 状态边界。当前证据及已知回归以 `current/` 文档为准。 |
| R3-A | 完成 | 新建/打开 Topic 的显式 Agent、模型、workspace 选择，以及空闲、只读、占用、接管 checkpoint 状态页已作为独立流程交付；以 `agent-runtime/current/` 中列出的带 revision 验证记录为准。 |
| R3-B | 施工中 | 真实 streaming、工具、审批与 ToolBox WS 卡的 680/960/1440 Electron 视觉、滚动和长内容验收；长流与 WS 仅可通过显式 live gate 计入证据。 |
| R4 | 施工中 | readiness 只能由 Rust daemon 探测/发事件，Workbench 仅展示。`vcp-distributed-server` 不是被动观察通道，不能用作 node 状态查询。 |
| R5 | 未开始 | 先统一 hermetic/live 产品门槛，再归档旧 Pi/Runtime；现在不得删除旧路径。 |

## 当前验证入口

```powershell
npm run build:daemon
cargo fmt --all --check --manifest-path rust/Cargo.toml
cargo clippy --manifest-path rust/Cargo.toml --workspace -- -D warnings
cargo test --manifest-path rust/Cargo.toml --workspace
npm run test:agent-workbench-store
npm run test:agent-workbench
npm run test:electron-gui-smoke
```

真实 ToolBox / DistributedServer 验收保持显式 opt-in；详情、环境变量和当前
revision 证据必须写入 `current/delivery-plan.md`，不能只在本索引中声明通过。
