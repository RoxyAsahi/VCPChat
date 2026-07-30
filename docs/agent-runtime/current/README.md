# Rust Agent Runtime：当前真源

最后更新：2026-07-30。适用分支：`codex/vcpchat-rust-agent-origin-sync`。

本目录的七份 Markdown 文档与两份 readiness JSON 是 Agent GUI、Rust daemon 与 standalone Rust 产品面的**唯一当前实现真源**。其它 `docs/agent-runtime/*.md` 中标为历史/Pi/legacy 的材料只用于追溯，不可作为新功能依据，也不得作为实施计划或验收依据。

阅读顺序：

1. [daemon-protocol.md](daemon-protocol.md)：v1.4 framed stdio、附件 descriptor、控制响应和事件信封。
2. [topic-and-recovery.md](topic-and-recovery.md)：Topic、lease、恢复、压缩及 Agent 独立影子索引。
3. [agent-workbench-state.md](agent-workbench-state.md)：Electron Main 与 Renderer 的状态边界。
4. [delivery-plan.md](delivery-plan.md)：当前验证门槛、影响边界与下一阶段工作。
5. [engineering-quality.md](engineering-quality.md)：Grok/Pi Rust 审计结论、CI、性能、可靠性与发布标准。
6. [vcp-toolbox-adaptation.md](vcp-toolbox-adaptation.md)：VCPToolBox 依赖边界、特殊协议适配及 P0/P1/P2 队列。
7. [unix-cli.md](unix-cli.md)：`vcp-agent --print` 的 stdin/stdout、脚本、取消与审批边界。

机器可读发布判断由 `product-readiness-contract.json` 和
`product-readiness-verdict.json` 提供。Markdown 中的完成描述不能覆盖 verdict；正式发布前必须运行
`npm run check:rust-readiness:release`。

产品边界固定如下：Rust Core/Host 是 Agent 业务实现，GUI 通过 `vcp-agentd --direct` 将其视为黑盒 Runtime；standalone `vcp-agent` 的 TUI 与 headless CLI 都直接调用同一 Rust Host。VCPToolBox 是模型、`{{Nova}}`、动态工具知识、插件、marker 执行和后端审批真源。GUI、TUI 与 CLI 都不创建本地 Shell、MCP 或第二套工具系统。

数据边界同样固定：Rust Agent Topic 位于 `AppData/AgentRuntimeData`，是 Agent
checkpoint、恢复与 lease 的唯一持久真源；主聊天 `AppData/UserData` 仍由既有 JSON
管理链路负责，VCP-CDS/SQLite/Tantivy 只是主聊天的可重建查询与同步投影。Agent
Runtime 自己的 `AgentRuntimeData/.index` 同样只是可重建查询投影，并与主聊天数据库物理
隔离；它不依赖 CDS 启动，也不允许 CDS 或 MobileSync 写回 Agent Topic。

TUI 产品化不得改变 GUI 的黑盒接入原则。主题、布局、输入、真实状态显示、终端恢复等 TUI-only 修改不需要扩张 daemon 协议；共享 Host/Core 修改必须同时通过 Rust、daemon adapter 和 Workbench 回归；daemon 协议修改必须先更新共享 fixture。
