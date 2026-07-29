# 参考背景（非当前真源）：Rust daemon 与 Agent GUI 收敛决策

> 本文保留重构背景和问题复盘，不能定义当前协议、状态或交付结论。请以 [current/README.md](current/README.md) 及其中四份当前文档为准。

最后更新：2026-07-29。适用分支：`codex/vcpchat-rust-agent`。

## 结论

当前 VCPChat 选择把 Rust Agent 源码放在本仓库的 `rust/` 与 `rust-tui/` 中。它不是一次临时复制，也不是另一个可并行修改的 Agent 实现；它是 VCPChat Agent 产品的**唯一正式 Runtime 源码**。

独立的 `VCPAgent` worktree/repository 可以保留作历史、实验或未来独立发行的来源，但在本分支未建立可验证的双向同步机制前，不能与 `rust/` 并行承载同一项产品功能。任何修复必须先明确其唯一落点，避免再出现同一 daemon 在两个目录分别修正的漂移。

## 正式运行时边界

```text
Agent Workbench（Renderer）
  → preload 的 agent-runtime 窄接口
  → Electron Main：RustAgentRuntimeManager / RustDaemonTransport
  → rust/target/release/vcp-agentd.exe --direct
  → Rust Host / Rust Core
  → VCPToolBox
  → VCPChat DistributedServer（可选本地 capability node）
```

- **Rust daemon 是 Agent 的唯一业务 Runtime**：Session、Turn、流、`vcp_invoke`、客户端审批等待、Topic、压缩、预算、队列、取消与恢复都属于它。
- **Electron Main 是薄 supervisor**：校验 renderer IPC、spawn/supervise daemon、转发 framed 事件、应用退出时停止 daemon。它不得再实现 Agent loop、工具执行、Topic 持久化、压缩或风险决策。
- **Renderer 是纯投影层**：显示 daemon 事件，向 daemon 发送用户意图。它不得拥有独立 transcript 真本。
- **VCPToolBox 是能力权威**：模型、`{{Nova}}` 等 Agent 动态提示词、插件、marker 工具执行和后端审批都不迁入 Rust 或 GUI。
- **VCPDistributedServer 是 capability provider**：本地 `FileOperator`、`PowerShellExecutor` 等仍经 ToolBox 调用；它不是 Rust 的内置 Shell/文件工具。

## 单一真源规则

| 数据/行为 | 真源 | GUI 可保留什么 |
| --- | --- | --- |
| Agent transcript、checkpoint、Topic lease | Rust Topic Store | 当前 `topicId` 指针和有界渲染投影 |
| Turn、队列、压缩、usage、预算 | Rust daemon | 只读状态和用户操作中的短暂 pending UI |
| 本地审批请求及四元组 binding | Rust Host | 待显示审批卡；决议必须原样回传 |
| Agent 与模型目录 | VCPChat 现有 settings/Agent catalog | 选择值；不得另建 ToolBox model catalog |
| 插件、工具知识、后端审批 | VCPToolBox | 只读状态与结果展示 |
| UI 模式与主题 | VCPChat settings.json | localStorage 仅允许无害首屏缓存 |

`sessionId` 只是 daemon 进程内短生命周期标识；`topicId` 才是可恢复身份。renderer reload、daemon restart 或 Workbench 重新挂载后，必须从 Rust `read-topic` 重建显示；不得从旧聊天话题、内存数组或 localStorage transcript 恢复消息。

## 为什么此前会反复返工

这不是 Rust Core 的无效工作。SSE、工具 marker、Topic、取消、审批 binding、压缩和真实 ToolBox/DistributedServer 调用均是可复用的基础成果。

返工发生在接入层：Rust daemon、`RustAgentRuntimeManager`、Workbench store/DOM 和 localStorage 曾同时保存或推断 Session、消息、工具状态及恢复语义；再叠加 Pi/mock legacy 路径、经典 UI 和 Next UI 内部应用的多重生命周期，导致一次事件可能被多处重新解释。由此出现刷新后空白、composer 锁死、工具卡丢失及“修一处、另一处回退”等问题。

收敛原则是把 `vcp-agentd` 当作 Cherry Studio 所使用的 Claude Agent SDK：它是 GUI 的黑盒 Agent Runtime。GUI 只负责协议适配、事件到 Block 的渲染投影与用户交互，绝不复制 Runtime 业务状态。

## 必须完成的接入收敛

1. `RustAgentRuntimeManager` 退化为 daemon client：移除或明确标注无产品用途的 Pi-era artifact、patch、catalog 等接口；不得以 JS 内存数组作为恢复依据。
2. Workbench 定义且只使用一个状态机：`disconnected → starting → idle → running → awaitingApproval → reconnecting | error`。状态转换仅由 daemon ACK/event 驱动。
3. 建立纯函数 event-to-block reducer。所有 Block 以 `sessionId + turnId + toolCallId`（消息用 daemon message key）稳定关联；不得靠数组下标、DOM 重建或推测的当前 turn 关联。
4. 仅将最后打开的 `topicId` 作为 renderer 缓存；所有消息、队列、usage、审批和 Topic 元数据均经 daemon 读取或事件刷新。
5. Pi/mock sidecar 改为 `legacy` 测试资产，不能在默认启动、默认文档或发布门槛中出现。
6. 每次触及 daemon protocol、Topic 持久化或 Workbench reducer，必须同时跑 hermetic Electron E2E；真实 ToolBox 场景只作为显式 live gate。

## 不借用 Claude Code SDK 的边界

Cherry Studio 值得借鉴其“一个 Runtime Service + stream transformer + UI projection”的机制；不引入其 Claude SDK、本地 Bash/Read/Write/Edit、MCP、`.claude` 配置或 JSONL session。那些会与 VCPToolBox 的能力权威冲突并重新产生第二套工具系统。
