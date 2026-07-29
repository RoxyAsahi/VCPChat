# VCPAgent GUI 集成当前状态

> **2026-07-29 R0–R2 收敛记录**：当前可执行规格已迁移到 [current/](current/README.md)。daemon 协议为 v1.2，控制响应按 framed `requestId` 关联，嵌套业务事件具有稳定 `eventId/sequence/topicId`。Electron Main 不再保存 Pi-era session、messages、events、artifacts、usage 或 approval 真状态；Workbench 的持久历史只由 Rust `read-topic` snapshot 恢复。本文其余较早的 Pi/submodule 叙述仅作历史证据，不应被当作当前契约。

> 2026-07-29：本文件的历史 live 记录不代表当前二进制。2026-07-29 起，Rust Core 源码已作为 `rust/` 直接目录并入本 repo，`vendor/vcp-agent` submodule 已删除；使用 `npm run build:daemon` 从 `rust/Cargo.toml` 编译，`ready.buildRevision` 锚定最后一个触碰 `rust/` 的 git commit。使用 `npm run test:e2e` 验证 hermetic 链路（需先 `build:daemon`），在 PowerShell 使用 `$env:VCP_AGENT_LIVE='1'; npm run test:e2e:live` 验证 Nova、工具、审批、取消、压缩、恢复和 Electron 卡片。没有这两项当前 revision 证据时，不得宣称 Agent GUI 可发布。

最后更新：2026-07-28。本文只记录 `codex/vcpchat-rust-agent` 的 Agent GUI 集成；完整 GUI 审计、主聊天/Next UI/启动/设置/打包状态见 [GUI 当前开发状态](../gui-current-development-status.md)。它不是 standalone `vcp-agent` 打包分支的替代说明。

> **2026-07-29 架构纠偏**：本分支以仓库内 `rust/` 为唯一正式 Rust Runtime 源码；GUI 不再将 daemon 作为需要在 JS/Renderer 侧重新实现的 Agent 后端。Rust daemon 是 Session、Turn、Topic、工具、审批、压缩和恢复真源；`RustAgentRuntimeManager` 仅是 transport client，Workbench 仅维护渲染投影。收敛要求见 [gui-daemon-integration.md](gui-daemon-integration.md)。此前的 Core/Host/Topic/ToolBox 工作可复用；真正需要停止的是多层重复状态和 Pi-era 接口扩张。

## 产品边界

VCPChat 的 Agent 模式是 VCPToolBox 的专用前端，而不是第二套本地插件、MCP、文件或终端平台。

```text
VCPChat GUI / Agent Workbench
  → Electron Main（薄 supervisor、窄 IPC、退出清理）
  → vcp-agentd.exe（Rust Host/Core：session、审批、Topic、tool loop、流式事件）
  → VCPToolBox（模型网关、VCP marker 协议、插件、分布式 capability node）
```

真实副作用只经 VCPToolBox：`vcp_invoke` 用于精确插件调用，`vcp_delegate` 仅保留作兼容回退。Pi 内置文件、Shell、extension 和 MCP 加载均不启用。FileOperator 与 PowerShellExecutor 仍由 VCP 分布式节点提供，不在 VCPChat 重新实现。

## 已验证的最小闭环

- Electron 的 `RustAgentRuntimeManager`、窄 preload IPC 和 GUI Agent Workbench 已接通；Main 只监督 `vcp-agentd.exe --direct`。
- daemon `create-session` 同时返回短生命周期 `sessionId` 和稳定 `topicId`；Topic 是 Rust Store 真源，renderer 只保存最后打开 Topic 的非敏感指针。
- 2026-07-28 已在真实 GUI 验证：新建会话后 composer 解锁；选择已有 Topic 后，`history.json` 中的 user/assistant 消息重新显示。此前 Rust 的裸数组返回与旧 JS `{ messages }` 包装不兼容，导致“文件里有历史但 GUI 空白”；控制器已兼容两种形状。
- Agent/模型选择复用主聊天的 `getAgents()`/`getCachedModels()`；Workbench 不直接请求 ToolBox `/v1/models`。
- Agent Workbench 可以展示流式消息、reasoning、工具状态和本地审批卡；真实操作仍只经 Rust Host → VCPToolBox。
- 2026-07-28 已将 `assistant.delta`/`reasoning.delta` 改为稳定 message 节点的原地更新，并用 animation frame 合并非流式控制面刷新；连续 delta 不会替换 composer、丢失输入焦点或清空草稿。真实 Electron 长流和 ToolBox 工具/审批压力仍待验收。
- 2026-07-28 已用共享 VCP 配置完成 Rust direct daemon 的真实 Nova + `gpt-5.6-terra` 流式对话，并完成 `FileOperator(ReadFile package.json)` 的低风险调用；随后请求 `PowerShellExecutor(Get-Location)`，本地审批拒绝后未出现 `tool.running`。这证明 Rust Host → ToolBox marker → 本地审批边界有效，但不等同于 ToolBox 后端最终审批已验收。
- 2026-07-29 的 Rust 长任务回归在同一 Turn 内真实完成 `FileOperator(ListAllowedDirectories)` → `SciCalculator(6*7)`，并要求模型仅在两个结果都返回后输出 `LONG_TASK_FILE_AND_42`。测试仅自动允许客户端 preflight，不写入或修改 VCPToolBox 审批配置；ToolBox 后端审批仍保持独立。
- 2026-07-29 明确验证了 VCPChat 本地 capability 的运行前提：`enableDistributedServer=true` 只有在 Electron 主进程实际运行时才会创建 `VCPDistributedServer`，向 ToolBox 注册 `PowerShellExecutor` 等本地插件。仅启动 ToolBox 时服务器端清单中的 `ServerPowerShellExecutor` 不能替代该节点，调用会返回 `Plugin "PowerShellExecutor" not found`。通过原 `start.bat` 启动 VCPChat、确认 5974 监听后，真实 Rust Agent 已完成“本地审批允许 → `PowerShellExecutor(Get-Location)` → `tool.completed`”的后端 YOLO 回归；该命令只读取当前目录，不写工作区或 ToolBox 配置。
- 同日的 opt-in Electron smoke 也走 Workbench 的实际“允许一次”按钮，确认高风险事件按 `approval.requested → tool.started → tool.completed` 发生；isolated smoke 显式禁用自身 distributed listener 以避免与原 VCPChat 5974 capability node 竞争。该覆盖证明 GUI 不是绕过 Rust Host 直接调用插件。
- 2026-07-28 修复 direct daemon 的 event envelope：Host 原先仅把 `sessionId`、`turnId`、`toolCallId` 放在 framed 外层，GUI/TUI 实际消费嵌套 event，真实工具卡因此缺少稳定 ID。daemon 现只将这三个非敏感关联字段投影至嵌套 event，并以 Rust 单测覆盖。Core 也在安全 snapshot ACK 前发送 `turn.completed`；GUI 起始的 `turnId` 现贯通 daemon/Host/Core，避免工具回合完成后 GUI 错把下一条消息当 follow-up。启用 `VCPCHAT_E2E_LIVE_TOOLBOX=1` 与仅测试用的 `VCP_AGENT_TEST_TOOL_CHOICE=required` 的隔离 Electron 已完成低风险 `FileOperator(ReadFile package.json)` 回合、高风险 `PowerShellExecutor(Get-Location)` 本地拒绝，以及用户取消活动 Turn，验证完成态工具卡、空闲 composer、审批卡、“拒绝后无 `tool.started`”与 `turn.cancelled`；再配合 `VCPCHAT_E2E_LIVE_TOOLBOX_RELOAD=1`，真实工具回合后的 renderer reload 已从 Rust Topic 恢复 user/assistant 历史、ready runtime 与 composer，不依赖 renderer 的本地 transcript。

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

## 尚未完成，不能提前宣称

1. Workbench 已接入 Rust Topic 的搜索、重命名和删除；活跃 Topic 在 GUI 与 Rust Store 两层均禁止删除。仍缺分页、标题自动治理、批量管理和 `topic_*`/同名会话的迁移或隐藏规则。
2. 活动 Turn 的 GUI composer 已将普通输入接为 follow-up，并支持 `/steer <内容>` 即时指导；Header 可查看、清空、编辑和移除 Core-validated Rust queue 项，消费事件会刷新列表；用量面板显示请求轮次与 daemon 投影的 input/output/reasoning/cache/total token，费用未知，并可读取/保存每 Turn 的请求数与 token 上限。预算 IPC 只返回非敏感设置，保存后的限制从新建 Agent Session 起生效，避免静默改变正在运行的 Turn；Header 也可请求 Rust Core 的安全压缩。
3. `VCPlog`、`vcpinfo` 与 distributed-server 已作为有界、脱敏、只读的 Agent Workbench 状态卡呈现；结构化 `tool_approval_request` 会明确标作“后端审核请求（未关联）”。ToolBox 不公开其 requestId 到 Rust `toolCallId` 的关联，也不广播最终结果；它们不是工具执行通道，本地允许绝不能被误解为后端已允许。
4. daemon 异常会清除失效 transport、未处理本地审批与控制等待，Session 标记为 interrupted；GUI 显示诊断和显式重新连接入口，恢复只创建新 Session 并恢复最近 checkpoint，绝不重放中断 Turn。当前 daemon 从以下路径按优先级解析：`VCP_AGENT_RUST_DAEMON_PATH` 环境变量覆盖 → 打包资源（`process.resourcesPath/vcp-agent/vcp-agentd.exe`）→ repo 内 `rust/target/release/vcp-agentd.exe`（`npm run build:daemon` 产物）；`ready.buildRevision` 必须与 `git log -1 --format=%H -- rust/` 一致。当前明确保留原 `start.bat` / VBS 打开方式，不将 NSIS 安装/升级迁移作为本阶段验收。
5. `npm run check:ui-system` 已在 2026-07-28 恢复通过；它只覆盖静态规则和组件契约，Workbench 仍缺真实 Electron 的视觉、交互与长流压力验收，不能提前称为 UI 完成。
6. `gui-test-screenshots/`、`dist/` 与实时日志是本地验证产物，不进入正式提交。

## 当前验证命令

```powershell
# 静态检查（无需 daemon 二进制）
npm run check:agent-runtime

# Hermetic E2E（需先编译 daemon）
npm run build:daemon
npm run test:e2e

# Live 验收（需 ToolBox 可达）
$env:VCP_AGENT_LIVE='1'; npm run test:e2e:live
```

`check:agent-runtime` 已覆盖 Runtime 契约、Pi Worker loop、SSE、持久化、工具桥、Patch、Catalog、Capability、Subagent、Team 与 Workbench 静态/JSDOM 层。`test:e2e` 补充 daemon 二进制的 framed-stdio、Topic 协作接管与 Electron GUI 集成。真实模型和 ToolBox 验收另由受控 live 脚本执行，凭据只从环境变量或 VCPChat 设置读取，绝不写入测试源码。

长程实机命令为 `npm run test:agent-runtime:live-long`：它临时启动分布式 FileOperator 节点，并在 `finally` 中恢复 ToolBox 审批配置；真实 `gpt-5.6-terra + {{Nova}}` 必须依次完成 `FileOperator(ListAllowedDirectories)` 与 `SciCalculator(6*7)` 两次调用，再输出验收标记。

Rust live 脚本不再内嵌地址或 API Key；它们只从调用者环境变量或指定共享 `settings.json` 取得配置。运行前必须由操作者确认目标 ToolBox 与允许的低风险测试范围，且测试输出不得回显凭据。
