# VCPToolBox Bridge

## 定位

`vcp-toolbox-bridge.exe` 是独立 Rust 协议适配进程，不是 Agent Runtime。Codex 负责思考和原生工具，ToolBox 负责 VCP 插件、动态工具 catalog、后端审批和通知；Bridge 只在两者之间保持身份、安全和结构化结果。

禁止加入：Agent loop、Topic Store、本地 Shell、MCP、第二套插件系统、工具名自动重写、ToolBox 配置修改。

实施前必须检查 [reuse-register.md](reuse-register.md)。Bridge 的 endpoint candidate、连接探测、重连和 dispose 不从零设计：先从 vcp-code-2.0 revision `d7ce532451f2ebdf481c16b5cfff9967b63b6cf7` 的 `src/services/novacode/vcp-bridge.ts` 及其测试抽取行为 fixture，再以 Rust 实现满足同一 fixture。不得导入其 VS Code service 或 Webview credential 路径。

## 两条独立链路

### 模型链路

```text
Codex provider
  -> VChat loopback Responses adapter (random capability path)
  -> ToolBox /v1/chat/completions
  -> Nova / upstream provider
```

VChat 拥有这个极窄的协议兼容层，以保持 ToolBox 不变：它转换 Responses/Chat 请求、工具调用、工具结果历史和 SSE，不执行工具、不读取 catalog、不改写 ToolBox 目标工具名。Codex `0.146.0` 会把 base instructions 作为 developer input、把内建 exec/wait 放进 `additional_tools`；adapter 根据 Thread identity 回查 VChat 冻结快照，只上送唯一 system identity，并在最终边界只提供 `vcp_invoke`。自定义 provider 未携带顶层 dynamic tool 时，adapter 使用固定 schema补出这个唯一 wrapper；真实 App Server 已证明返回的 function call 仍能进入原生 `item/tool/call` continuation。它只监听 `127.0.0.1` 的随机端口及随机 capability path；ToolBox API Key 不传给 Codex。0.146 Nova live 尚未重跑，usage 仍不是 ToolBox 的可信来源。

### 动态工具链路

```text
Codex item/tool/call
  {
    JSON-RPC id, threadId, turnId, callId,
    tool: "vcp_invoke",
    arguments: { tool: "FileOperator", arguments: { ... } }
  }
  -> Electron Main
  -> bridge invoke
     requestId = stable(threadId, turnId, callId)
  -> ToolBox /v1/human/tool
  -> structured bridge result
  -> original JSON-RPC response { contentItems, success }
```

动态工具请求不能被显示为 Codex 原生审批。响应必须恰好一次；bridge 超时、退出或未知 call 一律失败。

`tool` 的两层身份必须严格区分：外层 `tool` 是 Codex 已注册的动态工具 wrapper，当前只允许
`vcp_invoke`；内层 `arguments.tool` 才是 ToolBox 的实际目标工具，内层
`arguments.arguments` 才是该工具的参数。Main 只在完整的 `threadId + turnId + callId` 与这个
envelope 都通过验证后才调用 bridge；不能把 wrapper 名 `vcp_invoke` 传给 ToolBox，也不能根据
目标名猜测或改写为另一工具。此解包有 hermetic regression coverage。

### 历史 probe 与当前收据

2026-07-31 的旧 `npm run test:codex-toolbox-live` 曾通过一次无写入的
`FileOperator(ReadFile package.json)`：Codex App Server 发出 `item/tool/call`，Main 正确将
`vcp_invoke.arguments.tool` 解包为 `FileOperator`、将
`vcp_invoke.arguments.arguments` 传给 bridge，bridge 经 `/v1/human/tool` 调用 VChat
DistributedServer，结果和最终回复均进入 SQLite Projection。它仍只是 dirty working-tree 的
live probe，但它依赖 ToolBox 工作树的 Responses 改动，现不再是正式路径的验收收据。

同一协议行为现由 VChat-owned adapter 实现并覆盖：Chat `message.tool_calls` 映射为 Responses
`function_call`，后续输入中的 `function_call` / `function_call_output` 映射回 Chat 工具历史。否则
Codex 会看不到调用或调用结果，出现“Turn 已完成但没有 dynamic call”或重复调用。VChat 不在
Renderer、提示词或 bridge 中伪造 tool call。

动态工具 live gate 的硬前置条件如下：

1. VChat 设置（或测试进程的等价环境）指向 ToolBox `http://localhost:6005`，使用当前专用测试密钥；
2. VChat DistributedServer 已启动并用同一地址和密钥连接 ToolBox；
3. ToolBox 已收到该节点注册的 `FileOperator`；
4. 测试进程显式设置 `VCP_CODEX_LIVE=1`、`VCP_TOOLBOX_URL` 和 `VCP_TOOLBOX_API_KEY`。

测试密钥只允许存在于本机 VChat 设置或进程环境；不得写入 Git、SQLite、Renderer 或诊断日志。

## Bridge JSONL v1

Host -> bridge：

- `invoke {requestId, toolName, arguments}`；
- `interrupt {requestId}`；
- `shutdown`。

Bridge -> host：

- `ready {protocolVersion: 1}`；
- `result {requestId, result}`；
- `interruptResult {requestId, interrupted}`；
- `error {requestId?, code, message}`。

边界要求：单行限长、有界 pending map、请求超时、并发 invoke、stderr 脱敏、graceful shutdown、异常退出拒绝全部 waiter。超过 stdin JSONL 限长时，bridge 在写出 `command-too-large` 后以非零退出码 fail-closed，不能继续带着后台观察任务运行。

## 结构化结果

映射目标：

- text -> Codex `inputText`；
- image URL -> `inputImage`；
- audio URL -> `inputAudio`；
- file/URL -> VChat attachment/resource Block + 紧凑文本说明；
- warning -> 独立 warning Block；
- async task accepted/progress/completed -> 同一 callId 的状态更新。

当前只完成 text/image/audio 基础映射。文件资源、warning 和异步 task 尚未达到完整协议。

## 审批身份

| Identity | 来源 | 用途 |
|---|---|---|
| Codex JSON-RPC request id | App Server | 响应原生 approval 或 dynamic call。 |
| Codex `callId` | App Server | dynamic tool Item identity。 |
| Bridge request id | Main | ToolBox invoke/interrupt 的稳定关联。 |
| ToolBox approval id | VCPLog | 后端审批响应。 |
| VChat local approval id | Workbench | 本地产品审批。 |

任何两种 identity 都不得互相替代。`always-approve` 只能影响 VChat/Codex 本地策略，不能跳过 ToolBox backend approval。

## VCPLog backend approval（已实现基础闭环，待 live 验证）

Bridge 需要一条 daemon 级双向连接：

1. 使用稳定、无隐私 `deviceName`。
2. 帧限长、有界缓存、指数退避。
3. 按 ToolBox message/request id 去重。
4. `_vcpReplay` 只用于恢复尚未过 TTL 的请求。
5. 审批请求进入全局审批中心，并保留可用的 Thread/Tool 标签。
6. 响应严格使用 ToolBox approval id，最多一次。
7. 过期、断线、Workbench 关闭和进程退出 fail-closed。

上游缺少可靠 Thread correlation 时，后端审批保持全局，不伪装成某个 Thread 的本地工具事件。

### R4.1 复用与加固顺序

必须先移植的上游行为：

- ToolBox URL normalization；
- `/VCPlog`、`/vcpinfo` 和 query endpoint candidate 顺序；
- connection latency/status probe；
- 有上限的 exponential reconnect；
- config update 后重连；
- disconnect/dispose 清理。

vcp-code 的实现不能原样视为生产安全边界。Rust Bridge 必须额外实现：最大 WebSocket 帧、bounded channel、带 jitter 的退避、replay id 去重、审批 TTL、稳定且不泄露用户名/路径的 `deviceName`、日志凭据脱敏，以及异常退出时拒绝全部 waiter。测试必须包含 oversized frame、乱序/重复 replay、过期审批、断线重连和 shutdown，不得只断言 WebSocket 已连接。

## VCPInfo/VCPLog 只读观察（已实现基础投影，待 live 验证）

至少识别：`RAG_RETRIEVAL_DETAILS`、`META_THINKING_CHAIN`、`AI_MEMO_RETRIEVAL`、`AGENT_PRIVATE_CHAT_PREVIEW`、DailyNote、`AGENT_DREAM_*`。

这些信息：

- 投影为 RAG/记忆/日记/梦境/通知 Block；
- 默认不进入 Codex Thread 历史；
- 不触发工具；
- 不保存原始大 JSON；
- 没有可靠 Thread identity 时作为全局通知。

### R4.2 内容投影复用

`VCP_DYNAMIC_FOLD` 和 `VCPINFO` 的解析、展示/历史分离及基础 fixture 优先受控导入或等价端口 vcp-code 的 `src/core/task/vcp/vcp-content.ts` 与 `vcp-content.spec.ts`。适配结果必须输出规范 `AgentBlock[]`，并增加 marker 大小、嵌套、未闭合、CJK、恶意 HTML、Codex Item identity 和 SQLite snapshot 测试。

vcp-code 的 `TOOL_REQUEST` 执行路径明确禁止复用。任何 `TOOL_REQUEST` marker 只生成 protocol-warning Block，并从可展示正文净化；它不能调用 Bridge、不能转成 `vcp_invoke`、不能进入重试或恢复队列。动态工具只接受 Codex App Server 的原生 `item/tool/call`。

## 当前状态

已实现：Rust crate、release build、2 MiB bounded JSONL、ready/shutdown process smoke、invoke/interrupt 基础路径、Codex dynamic tool response 基础映射、单 VCPLog writer、VCPInfo observer、backend approval TTL/replay 去重/响应、关闭 fail-closed，以及进入 Renderer 前的深度/数量/字符串限长和敏感键脱敏。

R4.1 hermetic receipt（2026-07-31，`codex/vcpchat-codex-app-server` working tree，尚无 commit revision）：

```text
cargo test --manifest-path rust/toolbox-bridge/Cargo.toml -p vcp-agent-vcp --features direct-host host::tests
cargo test --manifest-path rust/toolbox-bridge/Cargo.toml -p vcp-toolbox-bridge
cargo build --manifest-path rust/toolbox-bridge/Cargo.toml --release -p vcp-toolbox-bridge
npm run test:codex-toolbox-bridge
npm run test:codex-runtime-manager
```

这些命令覆盖 candidate fallback、redacted endpoint/错误、connection latency、帧限长、bounded+jitter backoff、replay 去重、TTL、进程 shutdown、观察 socket 重连，以及 Main 在 ToolBox URL/key 改变时先停止旧 bridge、fail-close approval/dynamic call、再启动新 bridge。另有显式 live probe：PowerShell 中执行 `$env:VCP_CODEX_LIVE='1'; npm run test:codex-toolbox-ws-live`（另需已有 `VCP_TOOLBOX_URL`、`VCP_TOOLBOX_API_KEY`）。2026-07-31 该命令已对未修改 ToolBox 验证 VCPLog/VCPInfo 双 observer connect+shutdown；它不调用工具、不响应审批，也尚不能替代真实断线重连、replay 或 Electron crash/recovery 验收。

未完成：动态 catalog、VCP marker 内容净化、完整资源/warning/task 结果、bridge crash 的 Electron 端到端恢复，以及 R4.1 的真实网络收据。R4.2 尚未完成复用与许可证收据，因此当前内容 parser 不能视为最终实现。
