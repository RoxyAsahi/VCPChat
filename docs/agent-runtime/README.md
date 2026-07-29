# VCPChat Agent Runtime 文档

当前产品文档的唯一真源是 [current/README.md](current/README.md)。它描述仓库内 Rust daemon、Topic 持久化、Electron thin supervisor 与 Agent Workbench 的现行契约。

下列内容均已归档，不能作为新功能设计或验收依据：

- [history/pi/](history/pi/)：Pi Worker、多 Driver、SQLite、`vcp_delegate`、submodule 和旧测试矩阵。
- [adr/](adr/)：兼容跳转页；原始 Pi-era ADR 在 `history/pi/adr/`。
- [legacy-toolbox-compatibility.md](legacy-toolbox-compatibility.md)：只记录不修改 ToolBox 的兼容限制，不定义 Runtime 产品路径。

当前产品固定边界：

```text
Agent Workbench → preload allowlist → Electron Main supervisor
                → vcp-agentd.exe → Rust Host/Core → VCPToolBox
```

- Rust daemon 是 Session、Turn、Topic、审批、工具循环、压缩与恢复的唯一业务真源。
- VCPToolBox 是模型、`{{Nova}}`、插件、动态工具知识、marker 执行和后端审批的唯一能力真源。
- Electron Main 不保存 Agent transcript 或业务状态；Renderer 只保留页面存活期间的投影。
