# Rust Agent Runtime：当前真源

最后更新：2026-07-29。适用分支：`codex/vcpchat-rust-agent`。

本目录的四份文档是 Agent GUI、Rust daemon 与 standalone Rust TUI 的**唯一当前实现真源**。其它 `docs/agent-runtime/*.md` 中标为历史/Pi/legacy 的材料只用于追溯，不可作为新功能依据，也不得作为实施计划或验收依据。

阅读顺序：

1. [daemon-protocol.md](daemon-protocol.md)：v1.2 framed stdio、控制响应和事件信封。
2. [topic-and-recovery.md](topic-and-recovery.md)：Topic、lease、恢复及压缩。
3. [agent-workbench-state.md](agent-workbench-state.md)：Electron Main 与 Renderer 的状态边界。
4. [delivery-plan.md](delivery-plan.md)：当前验证门槛、影响边界与下一阶段工作。

产品边界固定如下：Rust Core/Host 是 Agent 业务实现，GUI 通过 `vcp-agentd --direct` 将其视为黑盒 Runtime；standalone TUI 直接调用同一 Rust Host，但只能做交互和事件投影。VCPToolBox 是模型、`{{Nova}}`、动态工具知识、插件、marker 执行和后端审批真源。GUI 与 TUI 都不创建本地 Shell、MCP 或第二套工具系统。

TUI 产品化不得改变 GUI 的黑盒接入原则。主题、布局、输入、真实状态显示、终端恢复等 TUI-only 修改不需要扩张 daemon 协议；共享 Host/Core 修改必须同时通过 Rust、daemon adapter 和 Workbench 回归；daemon 协议修改必须先更新共享 fixture。
