# VCPAgent 当前开发状态

最后更新：2026-07-26。本文记录 `codex/agent-runtime-phase2` GUI 主线的真实状态；它不是 standalone `vcp-agent` 打包分支的替代说明。

## 产品边界

VCPChat 的 Agent 模式是 VCPToolBox 的专用前端，而不是第二套本地插件、MCP、文件或终端平台。

```text
VCPChat GUI / Agent Workbench
  → Electron Main（session、审批、审计、workspace 限制）
  → Pi Agent loop Worker（推理、tool loop、流式事件）
  → VCPToolBox（模型网关、VCP marker 协议、插件、分布式 capability node）
```

真实副作用只经 VCPToolBox：`vcp_invoke` 用于精确插件调用，`vcp_delegate` 仅保留作兼容回退。Pi 内置文件、Shell、extension 和 MCP 加载均不启用。FileOperator 与 PowerShellExecutor 仍由 VCP 分布式节点提供，不在 VCPChat 重新实现。

## 已落地能力

- Pi Worker、主进程 RuntimeManager、窄 preload IPC 和 GUI Agent Workbench 已接通；Pi Agent loop 已裁剪并受控内嵌为 `agent-runtime/vcp-pi-core/`（MIT 来源与同步记录见该目录 `UPSTREAM.md`）。
- OpenAI SSE 真流式、reasoning、usage、取消、session transcript/checkpoint、工具状态与本地审批已接入。
- GUI Workbench 复用主聊天 composer；运行中的输入会作为同一 turn 的 steering 指令排队，而不是创建冲突 turn。Pi fork 的 steering/follow-up 行为有独立自动回归。
- Patch proposal/apply/revert、workspace 路径范围、marker escaped write/edit、catalog、capability policy、subagent/team 领域核心均有对应自动测试。
- FileOperator 的只读工作区调用可经 `vcp_invoke` 真实执行；Main 负责唯一的工具生命周期事件，避免 Pi Worker 和 Main 双重渲染工具卡。

## 2026-07-26 实机验证

环境：`http://localhost:6005`、模型 `gpt-5.6-terra`、系统提示词 `{{Nova}}`、GUI 分支工作区 `C:\VCP\vchat-develop\VCPChat-agent-runtime`。

测试要求模型调用：

```json
{
  "toolName": "FileOperator",
  "arguments": { "command": "ListAllowedDirectories" }
}
```

结果：一次 `vcp_invoke → FileOperator(ListAllowedDirectories)` 成功，零 `tool.failed`，返回了工作区根目录及 Canvas 目录；模型最终回答引用真实返回的项目目录。SSE 重复工具名导致的 `vcp_invokevcp_invoke` 错误和重复 `tool.completed` 事件已回归修复。

注意：当前 `AppData/Agents` 尚未保存一个名称为 `Nova` 的 GUI Agent 配置；验证使用的是准确的 `{{Nova}}` 系统提示词。后续应把 Nova 作为开箱 Agent 配置写入 GUI 的可选 Agent 列表。

## 双层审批与 YOLO

VCPAgent 的本地审批与 VCPToolBox 审批是两层不同机制：

1. VCPChat 负责本地审批；TUI 的 `--yolo`/always-approve 只影响这一层。
2. ToolBox 的 `toolApprovalConfig.json` 负责后端审批，审批事件经 `/VCPlog/VCP_Key=...` WebSocket 广播给管理面板或兼容客户端。

ToolBox 中 `approveAll: true` 的含义是“所有工具都需要人工审核”，不是 YOLO。全局后端 YOLO 是 `enabled: false`；当前本机验证环境按测试授权临时设为该状态。产品化前，GUI/TUI 应接入 VCPLog 审批事件并把后端审批状态显示为第二层，而不是假定本地批准会替代它。

## 需要继续完成

1. 将 TUI 的主题、block/工具展示、权限模式、steering/follow-up、用量与会话体验以 GUI 原生交互完整接入 Workbench，而非嵌一层终端。
2. 为 GUI 的 Nova 开箱配置、VCPLog 后端审批桥和长程任务（多轮工具、取消、usage/compaction）补自动化与实机验收。
4. `gui-test-screenshots/` 与 `dist-fileoperator-*.log` 是手工/临时验证产物，不进入正式提交。

## 当前验证命令

```powershell
npm run check:agent-runtime
```

该命令已覆盖 Runtime 契约、Pi Worker loop、SSE、持久化、工具桥、Patch、Catalog、Capability、Subagent、Team 与 Workbench。真实模型和 ToolBox 验收另由受控 live 脚本执行，凭据只从环境变量或 VCPChat 设置读取，绝不写入测试源码。

长程实机命令为 `npm run test:agent-runtime:live-long`：它临时启动分布式 FileOperator 节点，并在 `finally` 中恢复 ToolBox 审批配置；真实 `gpt-5.6-terra + {{Nova}}` 必须依次完成 `FileOperator(ListAllowedDirectories)` 与 `SciCalculator(6*7)` 两次调用，再输出验收标记。
