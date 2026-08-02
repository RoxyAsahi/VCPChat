# Session Tool Dock

状态：working-tree implementation，尚未完成多分辨率人工视觉与真实长时性能验收。

## 目标结构

Agent Workbench 右侧使用一个浏览器式 Session Tool Dock：

```text
[上下文] [文件] [README.md ×] [变更 ×] [通知 ×] [审批 ×] [+] [收起]
```

`打开文件`是固定工具入口。`上下文`、文件预览、`通知`、`审批`和权威 `变更`都是可关闭内容 Tab，并可从 header 水位入口或 `+` 菜单重新打开。文件双击或固定动作创建顶层文件 Tab；文件页内部不再维护第二条固定预览 Tab。待审批不会因关闭 Tab 消失或自动允许。

## 身份与恢复

- Dock 是 Renderer 临时投影，不是 Codex Thread、Projection SQLite 或 ToolBox 状态真源。
- 文件 identity 固定为 `sessionId + workspaceRevision + relativePath`；basename 不具备身份意义。
- `sessionStorage` 只保存 Session、Tab kind/order、active ID、workspace revision 和相对路径。
- 文件内容、绝对路径、transcript、审批、工具结果和 Runtime 状态不得进入 Web Storage。
- Session 或 workspace revision 不匹配时文件 Tab fail-closed；不得改读其他 Session 的路径。

## 工具边界

`+` 菜单提供上下文、文件、通知、审批和存在权威数据时的变更入口。终端入口只能调用 VChat 已注册的 `open-powershell-executor-terminal` 应用动作。当前没有可靠的 VChat 浏览器应用 ID，因此不显示浏览器入口，也不创建嵌入式浏览器。

本 Dock 不启用 Codex 原生 Shell/file/MCP，不执行 apply/revert/write/delete/rename，不创建 Side Chat。ToolBox 仍是 VCP 工具、插件和后端审批权威。

## 受控参考

信息架构 clean-room 参考 OpenCode `session-side-panel.tsx`、`layout.tsx`、`file-tree.tsx` 和 command palette，固定审计 revision `a45c2b917e657e50881117e8c3f85f4bff06e47d`，许可证 MIT。VChat 不复制其组件源码，不把参考仓库加入运行时依赖。

## 验收

必须通过 `test:agent-session-dock`、`test:agent-workbench`、Workspace service/model、Electron Codex smoke、UI system 与 Agent Runtime checks。1440x900、1280x720、1920x1080、20 文件 Tab、10k 文件 workspace 和真实键鼠截图完成前不得标记产品完成。
