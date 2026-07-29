# VCPAgent Rust TUI

`vcp-agent.exe` 是 standalone 纯 Rust 产品表面。它直接调用共享的
`vcp-agent-host` / `vcp-agent-core`，不依赖 Node、Electron 或 Pi：

```text
vcp-agent.exe → Rust TUI → Rust Host/Core → VCPToolBox
```

VCPToolBox 仍是模型、Agent placeholder、动态工具知识、插件、marker
执行和后端审批权威。TUI 不引入本地 Shell、文件工具、MCP、worktree
或第二套插件系统。Grok Build 的复用仅限受控导入的交互、队列和压缩
组件，来源与许可证见 `THIRD_PARTY_NOTICES.md` 和
`../rust/GROK_SOURCE_PROVENANCE.md`。

## 构建与运行

```powershell
cd C:\VCP\vchat-develop\VCPChat-rust-agent
npm run build:tui

.\rust\target\release\vcp-agent.exe . `
  --model gpt-5.6-terra `
  --agent Nova
```

首次配置可以运行：

```powershell
.\rust\target\release\vcp-agent.exe --settings
```

配置优先级为 CLI → 环境变量 → 共享 `settings.json`。支持
`VCP_SERVER_URL`、`VCP_API_KEY`、`VCP_AGENT_SETTINGS_PATH` 和
`VCP_AGENT_AGENTS_DIR`。API Key 输入不回显，也不写入 Topic 或事件。

PowerShellExecutor 等本地能力来自 VCPChat DistributedServer 节点；需要
这类工具时应保持 VCPChat 通过原 `start.bat` / VBS 正常运行。普通模型、
服务器侧插件和 FileOperator 是否可用由当前 ToolBox 部署决定。

## 当前交互

- `Ctrl+Enter`：提交多行 prompt；Windows ConPTY 不支持 CSI-u 时可用 `Ctrl+S` 可靠提交。
- `Esc` / `Ctrl+C`：活动 Turn 中取消；空闲时退出。
- `/model`、`/agent`、`/topics`：打开可搜索选择器。
- `/new`、`/resume <topicId|latest>`：创建或恢复 Session。
- `/steer`、`/follow-up`：向活动 Turn 插入即时指导或后续输入。
- `/queue`、`/queue remove <id>`、`/queue replace <id> <prompt>`、`/queue clear`：查看和修改 Rust Host 的权威交互队列。
- `/compact`：请求安全上下文压缩。
- `/permissions ask|always-approve`：修改客户端本地审批；不能绕过 ToolBox 后端审批。
- `/theme`、`Ctrl+T`：选择并保存主题。
- `/reasoning`、`Ctrl+R`：展开或折叠 reasoning。
- `/toolbox`：展开或折叠最近一条 ToolBox 结构化事件的完整元数据。
- `/settings`：读取 Rust Host 的非敏感共享配置摘要；`--settings` 提供隐藏 API Key 的启动前向导。
- `/usage`：显示请求轮次、input/output/reasoning/cache/total、上下文占比和估算来源；无可靠价格目录时费用保持 unknown。
- `/budget`、`/budget requests=<n> tokens=<n>`：读取或更新每 Turn 限制；更新在下一 Session 生效。
- `/topics read <id>`、`/topics rename <id> <title>`、`/topics delete <id> --confirm`、`/topics takeover <id>`：只读查看和管理 Topic。
- `Ctrl+O`：打开最近工具调用的可滚动详情，检查长参数/结果。
- `/status`：显示 Rust Host 投影的真实运行状态。

Assistant 与 reasoning 使用受控导入的 Grok 增量 Markdown renderer，支持
代码高亮、表格、链接和 frozen-tail 更新。输入框剪贴板按 native →
tmux → OSC52 路由，并明确区分 confirmed/unverified/failed；不会自动复制
消息或工具结果。

审批默认选择拒绝。TUI 使用完整
`sessionId + turnId + toolCallId + argumentsHash` binding 回传决定；
`always-approve` 只跳过客户端本地确认。

## 当前限制

- 配置加载失败会进入明确阻断状态并禁用普通 prompt；`/settings` 可修复共享配置。
- `/status` 只显示 Host 已投影的 Runtime、ToolBox 和 permission 状态，不主动探测或伪造 Ready。
- Topic 选择器支持 Enter 恢复、Ctrl+O 只读、Ctrl+T 接管、F2 重命名和 Delete 删除确认；lease 与 checkpoint 仍只由 Rust Host/Topic Store 持有。
- 客户端审批与 ToolBox 后端审批分开展示；60 秒本地截止时间由 Rust Host 生成并 fail closed，TUI 只显示倒计时。
- ToolBox log/info/distributed lifecycle 使用 observer Block；它们不会成为工具执行通道。
- 同一查询的多数据库 RAG 事件聚合为一张两行摘要块；连接确认和元思考链不进入 Conversation，原始 JSON 仅在 `/toolbox` 展开后显示。
- 长工具结果可通过 `Ctrl+O` 检查；跨 Block 系统选择仍待补齐。
- 已有 8 个 Windows PTY hermetic 测试覆盖 CJK 长流、resize storm、真实
  prompt 提交、审批默认拒绝、活动 Turn 取消、interrupted checkpoint 恢复投影、
  minimal、强制 debug panic 恢复、长工具结果和重复 Session 投影切换。
- `VCP_AGENT_TUI_LIVE=1 npm run test:rust-tui-live` 已验证真实 ConPTY 键盘
  → `vcp-agent.exe` → Rust Host/Core → ToolBox `FileOperator` 的完整链路。
- `--bridge` 仅为历史开发兼容入口，不是当前正式架构或推荐启动方式。

当前完成度、影响边界和实施顺序以
`../docs/agent-runtime/current/delivery-plan.md` 的 R3 为准。TUI 产品化不得
将 Agent 状态或执行逻辑迁回 Electron Main/Renderer；GUI 仍通过
`vcp-agentd --direct` 将 Rust Runtime 作为黑盒使用。

## TUI 验收

```powershell
cargo test --manifest-path rust/Cargo.toml -p vcp-agent-tui
cargo test --manifest-path rust/Cargo.toml -p vcp-agent-tui --test pty_acceptance -- --test-threads=1
npm run build:tui
```

`build:tui` 同时执行 release size gate。当前验证二进制为 9,542,656 字节，
默认上限为 18,962,944 字节；
只有发布工程明确调整预算时才可用 `VCP_AGENT_TUI_SIZE_LIMIT_BYTES` 覆盖。
