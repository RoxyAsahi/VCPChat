# Rust Agent daemon 接入（历史整合记录）

> 当前协议与进程职责以 [../../current/daemon-protocol.md](../../current/daemon-protocol.md) 和 [../../current/agent-workbench-state.md](../../current/agent-workbench-state.md) 为准。本文中 submodule、v1.1、Pi fallback 等表述不构成现行实现要求。

VCPChat 的 Agent Workbench 现在通过 Electron Main 中的薄 supervisor 启动 `vcp-agentd.exe --direct`。Renderer 和 preload 不接触 API Key、文件系统或子进程；模型、ToolBox marker、审批绑定、Topic 和压缩均由 Rust Host/Core 负责。

Workbench 在创建首个 Session 前就会向 daemon 获取 Agent/Model catalog，因此新会话配置可直接选择 `Nova` 和服务端模型。2026-07-28 的聊天壳迁移保留了普通聊天的侧栏、消息区、工具卡和输入区视觉语言，但删除了旧页面的 sample message 与“本地待发送草稿”：发送会直接调用 `agent-runtime:start-turn`，流式文本、reasoning、工具状态和审批全部来自 daemon 事件。

Agent 对话的真源是 Rust Topic Store（而不是 renderer memory 或 localStorage）。GUI 只在 renderer 偏好中记录最后打开的 `topicId`；重载或重启时会重新连接该 Topic 并加载其有界、安全脱敏的 `history.json`。`create-session` 同时返回短生命周期的 `sessionId` 与持久的 `topicId`，会话侧栏也直接列出可恢复 Topics。

Workbench 的 Agent、模型、Topic 与交互队列目录会并行刷新，但 Main 使用单飞 daemon 启动锁，四个请求共享同一条 direct-daemon 连接；不得为每个目录请求启动一条新的 daemon。

GUI Agent Workbench 的 Agent 列表与新建会话模型遵循普通 VCPChat 聊天：Agent 从 Main 的 `getAgents` 共享目录读取，模型仅使用 Main 已维护的 `getCachedModels` 缓存。Workbench 不直接请求 ToolBox 的 `/v1/models`；Rust daemon 只负责 Agent Topic、Turn 和工具执行。

右侧控制面提供独立 Agent Topic 的恢复、已占用 Topic 的协作接管请求，以及 steering/follow-up 队列查看/清空。普通 VCPChat 聊天 Topic 不会被这些操作读取或改写；Renderer 不读取 Agent 文件、settings 或 API Key。

开发时先构建固定 submodule：

```powershell
npm run build:daemon
npm run start:rust-dev
```

`VCP_AGENT_RUST_DAEMON_PATH` 仅用于显式覆盖 release/debug 二进制的诊断；常规开发不会从相邻 worktree 自动寻找 daemon。

正式包通过 `extraResources` 将 daemon 放在 `resources/vcp-agent/vcp-agentd.exe`。协议为长度前缀 JSON，`protocolVersion=1`、`protocolRevision=1.1`；未知命令、超大帧、重复 requestId 和断管均 fail closed。

Electron 的共享配置和 Agent catalog 路径都从 `settings.json` 的父目录派生：开发时是仓库的 `AppData/`，安装包时是 Electron `userData/`。因此 packaged mode 不会尝试向只读的 `app.asar/AppData` 写入或从那里读取 Agent。

验证：

```powershell
npm run test:rust-agent-runtime
npm run test:rust-daemon-smoke
npm run test:rust-stack
$env:VCP_AGENT_LIVE = '1'
npm run test:rust-stack:live
```

2026-07-28 已重新执行 `electron-builder --dir --config.win.signAndEditExecutable=false`：目录包可以启动，`resources/vcp-agent/vcp-agentd.exe` 的 SHA-256 与 Rust release 构建一致。当前机器的正式签名包仍需要具备 winCodeSign 所需符号链接/签名权限的构建机。

旧 `AgentRuntimeManager`、Pi worker 和本地 patch/subagent 路径目前仅作为归档回退，不能在真实 ToolBox、Workbench 与原 VCPChat 启动入口验收完成前删除。

目录包已验证 `resources/vcp-agent/vcp-agentd.exe` 与配置的 Rust release daemon 字节一致，Rust supervisor 模块也实际进入包；隔离的打包 VCPChat smoke 确认其子进程来自包内资源目录。当前产品仍采用原有 `start.bat` / VBS 打开方式，不把 NSIS 安装器或安装升级作为本阶段工作。

Topic 控制面包含 `list-topics`、`read-topic`、`rename-topic`、`delete-topic` 和 `takeover-topic`。`read-topic` 只返回已经脱敏的 bounded snapshot/history；`takeover-topic` 只发起协作请求，旧 owner 必须先取消 Turn、保存 checkpoint 并释放 lease，任何前端都不能强抢仍活跃的写锁。
